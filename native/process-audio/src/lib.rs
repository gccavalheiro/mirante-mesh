//! Per-process audio loopback capture for Windows.
//!
//! # Why this exists
//!
//! System-wide loopback (`WASAPI` on the default render endpoint, which is what
//! Electron's `audio: 'loopback'` gives you) captures *everything* coming out of
//! the speakers. If you are in a voice call while sharing your screen, your
//! friends hear themselves back with a delay. That is the echo.
//!
//! Windows 10 build 20348+ / Windows 11 exposes `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`,
//! which captures audio from a *single process tree* instead of the whole endpoint.
//! Point it at the game you are sharing and the voice chat is simply never in the
//! buffer — not filtered out, never captured.
//!
//! The TeamSpeak and Discord teardowns in `docs/teamspeak-rtc-teardown.md` both
//! show this component:
//!   - TeamSpeak: `com::teamspeak::video::ProcessAudioCapturer`
//!   - Discord:   `audio_effects_helper.exe`, and a Rust `gpu_encoder_helper.exe`
//!     alongside it.
//!
//! # Modes
//!
//! * [`LoopbackMode::IncludeTree`] — capture ONLY this process tree. Used when you
//!   share a specific window: you get the game, nothing else. This is the setting
//!   that makes echo structurally impossible.
//! * [`LoopbackMode::ExcludeTree`] — capture everything EXCEPT this process tree.
//!   Used when you share a whole monitor: pass Mirante's own pid so our own
//!   voice output is excluded.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

// Public so the measurement bench in `src/bin` can drive a capture without
// going through Node. The echo work is decided by numbers measured offline,
// and a bench that has to boot Electron to record sixty seconds is a bench
// nobody runs.
/// Echo suppression against the loopback reference. Lives in its own crate
/// because the same DSP has to compile to WebAssembly for the worklet, and
/// napi does not.
pub use mirante_echo as echo;

#[cfg(windows)]
pub mod keys;

#[cfg(windows)]
pub mod win;

#[cfg(windows)]
use win as backend;

/// Which side of the process tree to keep.
// `napi(string_enum)` emits Clone and Copy itself; deriving them again is a
// conflicting implementation.
#[napi(string_enum)]
pub enum LoopbackMode {
    /// Capture only audio produced by the target process and its children.
    IncludeTree,
    /// Capture all audio except that of the target process and its children.
    ExcludeTree,
}

/// A process currently holding an audio session, for the source picker.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct AudioApp {
    pub pid: u32,
    /// Executable name, e.g. `"eldenring.exe"`.
    pub executable: String,
    /// Friendly name from the audio session, falling back to the executable.
    pub display_name: String,
    /// True while the session is actively rendering, not merely open.
    pub active: bool,
}

/// Format the capture always produces. Fixed rather than negotiated, because the
/// process-loopback virtual device does not implement `GetMixFormat`, and WebRTC
/// wants 48 kHz stereo float anyway.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct CaptureFormat {
    pub sample_rate: u32,
    pub channels: u32,
    /// Always `"f32"` — 32-bit float, interleaved.
    pub sample_format: String,
}

/// Whether this Windows build supports per-process loopback at all.
///
/// Returns `false` on Windows 10 before build 20348, and on every non-Windows
/// platform. Callers must degrade gracefully: offer "no audio" or warn about
/// echo before falling back to system-wide loopback.
/// Watch the keyboard globally, reporting press AND release.
///
/// For push-to-talk, which `globalShortcut` cannot do: it fires on press
/// and never on release, so it can toggle but not hold. And holding has to
/// work while the GAME has focus, which is the whole point — a
/// push-to-talk that needs the app in front is a mute button with extra
/// steps.
///
/// The key is never swallowed: this listens, it does not intercept, or the
/// same key would stop reaching the game it was pressed in.
#[napi(ts_args_type = "onKey: (vk: number, down: boolean) => void")]
pub fn start_key_watch(on_key: ThreadsafeFunction<Vec<u32>, ErrorStrategy::Fatal>) -> Result<()> {
    #[cfg(windows)]
    {
        let Some((rx, _thread)) = keys::start() else {
            return Ok(());
        };
        std::thread::Builder::new()
            .name("mirante-keys-bridge".to_owned())
            .spawn(move || {
                // The hook thread must never block, so the bridge to JS
                // lives here instead: one more hop, and the OS input thread
                // stays free.
                while let Ok((vk, down)) = rx.recv() {
                    on_key.call(
                        vec![vk, u32::from(down)],
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
            })
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = on_key;
        Ok(())
    }
}

#[napi]
pub fn stop_key_watch() {
    #[cfg(windows)]
    keys::stop();
}

/// Que programa esta em primeiro plano agora, por nome do executavel.
///
/// Para a sala mostrar "jogando goals.exe" ao lado de quem esta jogando,
/// que e o que faz uma lista de pessoas parecer viva em vez de um
/// cadastro. Devolve nulo quando a janela em foco e do proprio Mirante:
/// "esta usando o Mirante" nao e atividade.
#[napi]
pub fn foreground_app() -> Option<String> {
    #[cfg(windows)]
    {
        backend::foreground_executable(std::process::id())
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[napi]
pub fn is_supported() -> bool {
    #[cfg(windows)]
    {
        backend::is_supported()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Enumerate processes that currently own an audio session.
///
/// Used to populate the "which app's audio do you want to send?" picker when the
/// user shares a whole monitor and there is no single obvious process.
#[napi]
pub fn list_audio_apps() -> Result<Vec<AudioApp>> {
    #[cfg(windows)]
    {
        backend::list_audio_apps().map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// The pid that owns a window, from its HWND.
///
/// Sharing a window should send that window's audio automatically. Electron
/// hands us `window:<hwnd>:<n>` as the source id, so the handle is already
/// available and the user never has to pick an app from a list.
#[napi]
pub fn pid_for_window(hwnd: i64) -> Option<u32> {
    #[cfg(windows)]
    {
        backend::pid_for_window(hwnd as isize)
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        None
    }
}

/// The executable that owns a pid, e.g. `"chrome.exe"`.
///
/// Needed because a window and the audio it produces are often different
/// processes: Chrome puts each window in a renderer and its sound in a
/// separate audio service, which are siblings rather than parent and child.
/// Capturing the window's process tree therefore records silence. Resolving
/// the executable lets the caller find the sessions that belong to the same
/// application instead.
#[napi]
pub fn executable_for_pid(pid: u32) -> Option<String> {
    #[cfg(windows)]
    {
        backend::executable_for_pid(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

/// The process that spawned `pid`, when it is still discoverable.
///
/// Every capture is opened with `IncludeTree` and the mixer sums them, so
/// capturing both a parent and its child adds the same audio to itself.
/// This is what lets the caller drop the redundant one.
#[napi]
pub fn parent_pid(pid: u32) -> Option<u32> {
    #[cfg(windows)]
    {
        backend::parent_pid(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

/// A running capture. Dropping or calling [`ProcessAudioCapture::stop`] releases
/// the device and joins the capture thread.
#[napi]
pub struct ProcessAudioCapture {
    #[cfg(windows)]
    inner: Option<backend::Capture>,
    #[cfg(not(windows))]
    inner: Option<()>,
    format: CaptureFormat,
}

#[napi]
impl ProcessAudioCapture {
    /// Open a capture against `target_pid`.
    ///
    /// The capture does not start producing audio until [`start`] is called with
    /// a callback.
    ///
    /// [`start`]: ProcessAudioCapture::start
    #[napi(constructor)]
    pub fn new(target_pid: u32, mode: LoopbackMode) -> Result<Self> {
        #[cfg(windows)]
        {
            let inner = backend::Capture::open(target_pid, mode)
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
            Ok(Self {
                format: CaptureFormat {
                    sample_rate: backend::SAMPLE_RATE,
                    channels: backend::CHANNELS,
                    sample_format: "f32".to_owned(),
                },
                inner: Some(inner),
            })
        }
        #[cfg(not(windows))]
        {
            let _ = (target_pid, mode);
            Err(Error::new(
                Status::GenericFailure,
                "per-process loopback is Windows-only",
            ))
        }
    }

    #[napi(getter)]
    pub fn format(&self) -> CaptureFormat {
        self.format.clone()
    }

    /// Begin delivering interleaved f32 PCM to `on_data`.
    ///
    /// The callback runs on the libuv thread pool, not the capture thread, so it
    /// is safe to touch JS state from it. Buffers are not reused — each call owns
    /// its bytes.
    #[napi(ts_args_type = "onData: (chunk: Buffer) => void")]
    pub fn start(&mut self, on_data: ThreadsafeFunction<Buffer, ErrorStrategy::Fatal>) -> Result<()> {
        #[cfg(windows)]
        {
            let capture = self
                .inner
                .as_mut()
                .ok_or_else(|| Error::new(Status::InvalidArg, "capture already stopped"))?;

            capture
                .start(move |pcm: &[u8]| {
                    on_data.call(
                        Buffer::from(pcm.to_vec()),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                })
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
        }
        #[cfg(not(windows))]
        {
            let _ = on_data;
            Err(Error::new(
                Status::GenericFailure,
                "per-process loopback is Windows-only",
            ))
        }
    }

    /// Stop capturing and release the device. Idempotent.
    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        #[cfg(windows)]
        if let Some(mut capture) = self.inner.take() {
            capture
                .stop()
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        }
        #[cfg(not(windows))]
        {
            self.inner.take();
        }
        Ok(())
    }
}
