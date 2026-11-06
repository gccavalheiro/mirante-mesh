//! Echo suppression against a known reference.
//!
//! # The case this exists for
//!
//! A phone as the microphone (WO Mic, over Wi-Fi), friends coming out of
//! desk speakers across the room. Measured on that exact setup, with the
//! numbers in `docs/krisp-teardown.md`:
//!
//! ```text
//! room noise floor      -49.3 dBFS
//! friends via the mic   -26.4 dBFS median, -11.5 peak
//! user's own voice      -21.2 dBFS median,  -8.4 peak
//! ```
//!
//! **The user's voice sits 5.2 dB above the echo, and 3.1 dB at the peaks.**
//! That single measurement kills every level-based approach — a gate, an
//! expander, any adaptive threshold needs a separation that is not there.
//! The threshold that silences the friends silences the user with them.
//!
//! What survives is suppression that knows *what* was played. We do: the
//! per-process WASAPI loopback this addon already runs, pointed at our own
//! output, is the reference. Five decibels of separation stops mattering
//! when you are not guessing.
//!
//! # Why magnitude-domain, per bin, rather than cancellation
//!
//! Classic cancellation subtracts a filtered copy of the reference, and
//! needs sample-accurate alignment of a linear path. Neither holds here:
//!
//! - The capture path is a phone over Wi-Fi. Measured delay was +31.4 ms
//!   with a sharp correlation peak, which is trackable — but it drifts, and
//!   a canceller that loses alignment does not degrade, it stops working.
//! - The playback path runs through FxSound, a virtual device applying EQ
//!   and compression before anything reaches the speaker. Compression is
//!   non-linear. No linear filter models it.
//!
//! So each frequency bin gets a short adaptive filter over the *magnitude*
//! history of the reference. Magnitudes survive phase error, the taps
//! absorb the delay jitter the tracker leaves behind, and per-bin gains
//! learn whatever fixed EQ sits in the path — FxSound included.
//!
//! The price is that this suppresses rather than cancels: during
//! double-talk the residual is attenuated, not removed. That is the right
//! trade for a voice call, and it is measurable.

use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use rustfft::num_complex::Complex32;
use std::sync::Arc;

/// Analysis window. 1024 at 48 kHz is 21.3 ms — long enough that a speech
/// formant is resolved, short enough that the echo path does not change
/// within one frame.
pub const WINDOW: usize = 1024;
/// 50% overlap. Hann at this hop sums to unity, so reconstruction is exact
/// when every gain is 1.
pub const HOP: usize = WINDOW / 2;
const BINS: usize = WINDOW / 2 + 1;

/// How far back the reference is kept, in frames.
///
/// Covers 500 ms of delay. The measured path was 31 ms; this is headroom
/// for a phone that decides to buffer, not an expectation.
const REF_FRAMES: usize = 48;

/// Taps per bin, over reference frames.
///
/// Eight frames is ~85 ms of reference history. The tracker centres the
/// window; these absorb what it gets wrong and the smearing a real room
/// adds on top.
const TAPS: usize = 8;

/// How much of the estimate to subtract.
///
/// Above one on purpose. The estimate is a magnitude prediction from a
/// path that includes a compressor, so it runs low exactly when the echo
/// is loudest. Overshooting costs a little of the near-end voice; not
/// overshooting costs the whole point.
const OVERSHOOT: f32 = 1.4;

/// The quietest a bin may be made, relative to itself.
///
/// Never zero. Bins driven to silence between words is what makes
/// suppression audible as pumping — the ear reads the gap, not the
/// attenuation. -18 dB is inaudible as echo and keeps the floor alive.
const FLOOR: f32 = 0.125;

/// NLMS step. Small: this filter has all call to converge and nothing to
/// gain from chasing a single loud frame.
const MU: f32 = 0.05;

/// Below this, the reference is silent and there is nothing to learn or
/// suppress. Keeps the filter from adapting to numerical dust.
const REF_SILENT: f32 = 1e-5;

pub struct EchoSuppressor {
    fft: Arc<dyn RealToComplex<f32>>,
    ifft: Arc<dyn ComplexToReal<f32>>,
    window: Vec<f32>,

    /// Magnitude spectra of the reference, newest last.
    ref_mag: Vec<[f32; BINS]>,
    ref_write: usize,
    ref_filled: usize,

    /// Per-bin filter weights over reference history. `w[bin][tap]`.
    w: Vec<[f32; TAPS]>,

    /// Where the reference history starts, in frames. Set by the tracker.
    delay_frames: usize,

    mic_in: Vec<f32>,
    /// What the previous frame left for this one. One hop long.
    out_overlap: Vec<f32>,

    scratch_time: Vec<f32>,
    scratch_spec: Vec<Complex32>,

    /// Running totals for the one number that says whether this works.
    energy_in: f64,
    energy_out: f64,
}

impl EchoSuppressor {
    pub fn new() -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(WINDOW);
        let ifft = planner.plan_fft_inverse(WINDOW);

        // ROOT of a periodic Hann, applied on analysis AND on synthesis.
        //
        // Plain Hann on both sides squares it, and Hann squared does NOT sum
        // to a constant at 50% overlap: it runs between 0.5 and 1.0 with a
        // mean of 0.75. The bench caught exactly that — a flat 2.3 dB of
        // "suppression" on every segment regardless of content, which is
        // 20·log10(0.75), plus amplitude modulation at the frame rate that
        // would have been audible as buzzing. The root squares back to Hann,
        // which does sum to one.
        let window: Vec<f32> = (0..WINDOW)
            .map(|i| {
                let hann =
                    0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / WINDOW as f32).cos();
                hann.sqrt()
            })
            .collect();

        Self {
            fft,
            ifft,
            window,
            ref_mag: vec![[0.0; BINS]; REF_FRAMES],
            ref_write: 0,
            ref_filled: 0,
            w: vec![[0.0; TAPS]; BINS],
            delay_frames: 0,
            mic_in: Vec::with_capacity(WINDOW),
            out_overlap: vec![0.0; HOP],
            scratch_time: vec![0.0; WINDOW],
            scratch_spec: vec![Complex32::new(0.0, 0.0); BINS],
            energy_in: 0.0,
            energy_out: 0.0,
        }
    }

    /// Where the reference sits relative to the microphone, in milliseconds.
    ///
    /// Set by whoever runs the tracker; this type does not estimate it,
    /// because estimation wants seconds of audio and suppression wants ten
    /// milliseconds, and mixing the two clocks into one object is how the
    /// tracker ends up running in the hot path.
    pub fn set_delay_ms(&mut self, ms: f32, sample_rate: u32) {
        let frames = (ms * sample_rate as f32 / 1000.0 / HOP as f32).round();
        self.delay_frames = frames.clamp(0.0, (REF_FRAMES - TAPS - 1) as f32) as usize;
    }

    /// Feed one hop of the reference — what we played.
    ///
    /// Must be called at the same rate as `process`, whether or not anything
    /// is playing: the history is indexed by position, and a gap in the feed
    /// shifts every delay estimate that follows it.
    pub fn push_reference(&mut self, hop: &[f32]) {
        debug_assert_eq!(hop.len(), HOP);
        self.scratch_time.copy_within(HOP.., 0);
        self.scratch_time[HOP..].copy_from_slice(hop);

        let mut framed: Vec<f32> = self
            .scratch_time
            .iter()
            .zip(&self.window)
            .map(|(x, w)| x * w)
            .collect();
        let mut spec = vec![Complex32::new(0.0, 0.0); BINS];
        let _ = self.fft.process(&mut framed, &mut spec);

        let slot = &mut self.ref_mag[self.ref_write];
        for (k, c) in spec.iter().enumerate() {
            slot[k] = c.norm();
        }
        self.ref_write = (self.ref_write + 1) % REF_FRAMES;
        self.ref_filled = (self.ref_filled + 1).min(REF_FRAMES);
    }

    /// Reference magnitude `age` frames back from the newest.
    fn ref_at(&self, age: usize) -> Option<&[f32; BINS]> {
        if age >= self.ref_filled {
            return None;
        }
        let idx = (self.ref_write + REF_FRAMES - 1 - age) % REF_FRAMES;
        Some(&self.ref_mag[idx])
    }

    /// Suppress one hop of microphone audio. Returns the cleaned hop.
    pub fn process(&mut self, hop: &[f32]) -> Vec<f32> {
        debug_assert_eq!(hop.len(), HOP);

        self.mic_in.extend_from_slice(hop);
        if self.mic_in.len() < WINDOW {
            // Priming. One frame of latency, paid once.
            let mut pad = vec![0.0; WINDOW - self.mic_in.len()];
            pad.extend_from_slice(&self.mic_in);
            self.mic_in = pad;
        }
        let start = self.mic_in.len() - WINDOW;
        let frame: Vec<f32> = self.mic_in[start..]
            .iter()
            .zip(&self.window)
            .map(|(x, w)| x * w)
            .collect();
        if self.mic_in.len() > WINDOW * 2 {
            self.mic_in.drain(..self.mic_in.len() - WINDOW);
        }

        let mut framed = frame;
        let mut spec = std::mem::take(&mut self.scratch_spec);
        let _ = self.fft.process(&mut framed, &mut spec);

        for k in 0..BINS {
            let mic_mag = spec[k].norm();

            // Predict this bin's echo from the reference history.
            let mut predicted = 0.0f32;
            let mut ref_energy = 0.0f32;
            let mut taps = [0.0f32; TAPS];
            for j in 0..TAPS {
                let v = self
                    .ref_at(self.delay_frames + j)
                    .map(|f| f[k])
                    .unwrap_or(0.0);
                taps[j] = v;
                predicted += self.w[k][j] * v;
                ref_energy += v * v;
            }

            if ref_energy > REF_SILENT {
                // Adapt only while the prediction already explains most of
                // what is here. The alternative — adapting whenever the
                // reference is active — teaches the filter to predict the
                // NEAR-END voice during double-talk, and a filter that has
                // learned to predict you will suppress you. This is the
                // single rule that decides whether the user can talk over
                // their friends.
                // O portao olha a REFERENCIA, nao a predicao.
                //
                // A primeira versao adaptava so quando a predicao ja
                // explicava metade do sinal — e os pesos comecam em zero,
                // entao a predicao era zero, o portao nunca abria e o filtro
                // nunca aprendia. Impasse de partida a frio: exigia estar
                // bom para poder melhorar.
                //
                // Um alto falante nao amplifica alem do ganho do caminho,
                // entao eco plausivel e limitado pelo nivel da referencia.
                // Microfone muito acima disso e voz de perto, nao eco, e e
                // ai que adaptar ensinaria o filtro a prever o usuario.
                let nivel_ref = (ref_energy / TAPS as f32).sqrt();
                if mic_mag <= 4.0 * nivel_ref {
                    let err = mic_mag - predicted;
                    let norm = ref_energy + 1e-6;
                    for j in 0..TAPS {
                        self.w[k][j] = (self.w[k][j] + MU * err * taps[j] / norm).max(0.0);
                    }
                }

                let gain = ((mic_mag - OVERSHOOT * predicted) / mic_mag.max(1e-9))
                    .clamp(FLOOR, 1.0);
                spec[k] *= gain;
            }
        }

        let mut time = std::mem::take(&mut self.scratch_time);
        time.resize(WINDOW, 0.0);
        let _ = self.ifft.process(&mut spec, &mut time);

        // realfft leaves the inverse unnormalised.
        let norm = 1.0 / WINDOW as f32;

        // Overlap-add, written the boring way. The first version kept the
        // tail in the upper half and then shuffled it down, which is two
        // chances to be off by a hop for no benefit: `overlap` simply holds
        // what the previous frame left for this one.
        let mut out = vec![0.0f32; HOP];
        for i in 0..HOP {
            out[i] = self.out_overlap[i] + time[i] * self.window[i] * norm;
        }
        for i in 0..HOP {
            self.out_overlap[i] = time[i + HOP] * self.window[i + HOP] * norm;
        }

        self.scratch_spec = spec;
        self.scratch_time = time;

        for (a, b) in hop.iter().zip(&out) {
            self.energy_in += (*a as f64) * (*a as f64);
            self.energy_out += (*b as f64) * (*b as f64);
        }
        out
    }

    /// How much was taken out, in dB, over everything processed so far.
    ///
    /// Not echo return loss in the textbook sense — that needs a silent
    /// near end. It is the honest aggregate: how much quieter the stream
    /// got. Read it alongside whether speech still sounds like speech.
    pub fn attenuation_db(&self) -> f32 {
        if self.energy_in <= 0.0 || self.energy_out <= 0.0 {
            return 0.0;
        }
        10.0 * (self.energy_in / self.energy_out).log10() as f32
    }
}

impl Default for EchoSuppressor {
    fn default() -> Self {
        Self::new()
    }
}

/// Where the reference sits relative to the microphone, in samples.
///
/// GCC-PHAT: whiten the magnitude and keep only phase. That matters here
/// because the speaker and FxSound change the *colour* of the signal, and
/// plain cross-correlation chases colour. Phase survives it.
///
/// Returns the lag and how far the peak stands above the background. A peak
/// that barely separates is noise that got lucky, not a delay — measured on
/// silence the whitening will happily report a perfect lock at zero.
pub fn estimate_delay(reference: &[f32], mic: &[f32], max_lag: usize) -> (isize, f32) {
    let n = (reference.len().max(mic.len()) * 2).next_power_of_two();
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let ifft = planner.plan_fft_inverse(n);

    let mut a = vec![0.0f32; n];
    let mut b = vec![0.0f32; n];
    a[..reference.len()].copy_from_slice(reference);
    b[..mic.len()].copy_from_slice(mic);

    let bins = n / 2 + 1;
    let mut fa = vec![Complex32::new(0.0, 0.0); bins];
    let mut fb = vec![Complex32::new(0.0, 0.0); bins];
    let _ = fft.process(&mut a, &mut fa);
    let _ = fft.process(&mut b, &mut fb);

    // Limiar RELATIVO a media do espectro, nao um absoluto minusculo.
    //
    // Branquear divide pela magnitude, entao um bin quase vazio sai com
    // magnitude um — ruido numerico promovido a sinal. Com 1e-12 de guarda
    // e metade do microfone em silencio, o que sobrava era ruido
    // amplificado, e ruido branqueado correlaciona consigo mesmo no atraso
    // zero: o estimador cravava 0,0 ms com nitidez de 70x sobre nada.
    let cross_raw: Vec<Complex32> = fa.iter().zip(&fb).map(|(x, y)| x * y.conj()).collect();
    let media: f32 =
        cross_raw.iter().map(|c| c.norm()).sum::<f32>() / cross_raw.len().max(1) as f32;
    let piso = media * 0.01;

    let mut cross: Vec<Complex32> = cross_raw
        .iter()
        .map(|r| {
            let m = r.norm();
            if m <= piso {
                Complex32::new(0.0, 0.0)
            } else {
                r / m
            }
        })
        .collect();

    let mut corr = vec![0.0f32; n];
    let _ = ifft.process(&mut cross, &mut corr);

    let lag = max_lag.min(n / 2);
    let mut best = 0usize;
    let mut best_v = 0.0f32;
    let mut sum = 0.0f64;
    let mut count = 0usize;
    for i in 0..=lag {
        // `n - i` and not `n - 1 - i`: the negative lag of magnitude i lives
        // at index n - i. The off-by-one put every negative lag one sample
        // early and let index n - 1 pose as lag zero.
        for idx in [i, if i == 0 { 0 } else { n - i }] {
            let v = corr[idx].abs();
            sum += v as f64;
            count += 1;
            if v > best_v {
                best_v = v;
                best = idx;
            }
        }
    }

    let mean = if count > 0 { (sum / count as f64) as f32 } else { 0.0 };
    let sharpness = if mean > 0.0 { best_v / mean } else { 0.0 };
    let signed = if best <= n / 2 {
        best as isize
    } else {
        best as isize - n as isize
    };
    (signed, sharpness)
}
