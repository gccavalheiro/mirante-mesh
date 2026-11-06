//! Roda o supressor de eco sobre um par de WAVs e diz se ele funcionou.
//!
//!     cargo run --release --bin bancada-eco -- referencia.wav microfone.wav saida.wav
//!
//! Nada aqui toca no Mirante nem abre dispositivo de audio. E offline de
//! proposito: a unica forma de ajustar DSP sem queimar a paciencia de quem
//! vai usar e medir sozinho, em arquivo, quantas vezes for preciso.
//!
//! Imprime a atenuacao por trecho. Numero alto com fala intacta e o alvo;
//! numero alto com a voz comida e fracasso disfarcado de sucesso, que e por
//! que a saida tambem e escrita em WAV — para ser ouvida.

use std::env;
use std::fs::File;
use std::io::{BufWriter, Read, Write};

use mirante_process_audio::echo::{estimate_delay, EchoSuppressor, HOP};

const SR: u32 = 48_000;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("uso: bancada-eco <referencia.wav> <microfone.wav> [saida.wav]");
        std::process::exit(2);
    }
    let referencia = ler_wav(&args[1])?;
    let microfone = ler_wav(&args[2])?;
    let saida = args.get(3).cloned().unwrap_or_else(|| "limpo.wav".into());

    println!(
        "referencia {:.1}s {:.1} dBFS    microfone {:.1}s {:.1} dBFS",
        referencia.len() as f32 / SR as f32,
        db(rms(&referencia)),
        microfone.len() as f32 / SR as f32,
        db(rms(&microfone))
    );

    // Atraso estimado sobre uma fatia, nao sobre o arquivo inteiro: a FFT
    // de quarenta segundos custa centenas de megabytes e nao responde nada
    // que quatro segundos ja nao respondam.
    //
    // A fatia e escolhida por ENERGIA, nao por posicao. A primeira versao
    // pegava um quarto do arquivo e caiu bem nos dez segundos iniciais em
    // que o WO Mic ainda nao entregava nada — estimar atraso contra silencio
    // devolve um numero com cara de resposta.
    let fatia = (4 * SR as usize).min(referencia.len()).min(microfone.len());
    let inicio = melhor_janela(&referencia, &microfone, fatia);
    let (lag, nitidez) = estimate_delay(
        &referencia[inicio..inicio + fatia],
        &microfone[inicio..inicio + fatia],
        (SR as usize) / 2,
    );
    let atraso_ms = lag as f32 / SR as f32 * 1000.0;
    println!("atraso {atraso_ms:+.1} ms   nitidez {nitidez:.1}x acima do fundo");
    if nitidez < 8.0 {
        println!("  pico fraco: a referencia pode nao ter chegado ao microfone");
    }

    let mut sup = EchoSuppressor::new();
    sup.set_delay_ms(atraso_ms.max(0.0), SR);

    let hops = (referencia.len().min(microfone.len())) / HOP;
    let mut limpo: Vec<f32> = Vec::with_capacity(hops * HOP);
    let por_trecho = (5 * SR as usize) / HOP;
    let mut marca = 0usize;

    for h in 0..hops {
        let a = h * HOP;
        sup.push_reference(&referencia[a..a + HOP]);
        let saida_hop = sup.process(&microfone[a..a + HOP]);
        limpo.extend_from_slice(&saida_hop);

        if (h + 1) % por_trecho == 0 {
            let fim = limpo.len();
            let ini = marca;
            let antes = &microfone[ini..fim.min(microfone.len())];
            let depois = &limpo[ini..fim];
            println!(
                "  {:3}s  entrada {:6.1} dBFS   saida {:6.1} dBFS   atenuacao {:5.1} dB",
                (h + 1) * HOP / SR as usize,
                db(rms(antes)),
                db(rms(depois)),
                db(rms(antes)) - db(rms(depois))
            );
            marca = fim;
        }
    }

    println!("\natenuacao total {:.1} dB", sup.attenuation_db());
    escrever_wav(&saida, &limpo)?;
    println!("{saida} escrito — ouca antes de acreditar no numero");
    Ok(())
}

/// Onde os dois sinais tem energia ao mesmo tempo.
///
/// Maximiza o MENOR dos dois RMS: uma janela onde so um lado toca nao serve
/// para estimar atraso entre eles, por mais alto que esse lado esteja.
fn melhor_janela(a: &[f32], b: &[f32], largura: usize) -> usize {
    let limite = a.len().min(b.len()).saturating_sub(largura);
    if limite == 0 {
        return 0;
    }
    let passo = (SR as usize).max(1);
    let mut melhor = 0usize;
    let mut melhor_v = -1.0f32;
    let mut i = 0usize;
    while i <= limite {
        let v = rms(&a[i..i + largura]).min(rms(&b[i..i + largura]));
        if v > melhor_v {
            melhor_v = v;
            melhor = i;
        }
        i += passo;
    }
    melhor
}

fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
}

fn db(v: f32) -> f32 {
    20.0 * v.max(1e-12).log10()
}

/// Le WAV PCM 16 bits ou float 32, qualquer numero de canais, e devolve
/// mono em f32. Deliberadamente minimo: o que esta bancada consome sai do
/// ffmpeg e do gravador deste mesmo crate.
fn ler_wav(caminho: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    File::open(caminho)?.read_to_end(&mut bytes)?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!("{caminho}: nao parece WAV").into());
    }

    let mut pos = 12usize;
    let mut formato = 1u16;
    let mut canais = 1u16;
    let mut bits = 16u16;
    let mut dados: Option<(usize, usize)> = None;

    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let tam = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into()?) as usize;
        let corpo = pos + 8;
        match id {
            b"fmt " => {
                formato = u16::from_le_bytes(bytes[corpo..corpo + 2].try_into()?);
                canais = u16::from_le_bytes(bytes[corpo + 2..corpo + 4].try_into()?);
                bits = u16::from_le_bytes(bytes[corpo + 14..corpo + 16].try_into()?);
            }
            b"data" => dados = Some((corpo, tam.min(bytes.len().saturating_sub(corpo)))),
            _ => {}
        }
        pos = corpo + tam + (tam & 1);
    }

    let (ini, tam) = dados.ok_or("WAV sem bloco data")?;
    let bruto = &bytes[ini..ini + tam];
    let canais = canais.max(1) as usize;

    let amostras: Vec<f32> = match (formato, bits) {
        (1, 16) => bruto
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect(),
        (3, 32) => bruto
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
        _ => return Err(format!("{caminho}: formato {formato} com {bits} bits nao suportado").into()),
    };

    if canais == 1 {
        return Ok(amostras);
    }
    Ok(amostras
        .chunks_exact(canais)
        .map(|q| q.iter().sum::<f32>() / canais as f32)
        .collect())
}

fn escrever_wav(caminho: &str, x: &[f32]) -> Result<(), Box<dyn std::error::Error>> {
    let mut w = BufWriter::new(File::create(caminho)?);
    let bytes = x.len() * 2;
    w.write_all(b"RIFF")?;
    w.write_all(&(36 + bytes as u32).to_le_bytes())?;
    w.write_all(b"WAVEfmt ")?;
    w.write_all(&16u32.to_le_bytes())?;
    w.write_all(&1u16.to_le_bytes())?;
    w.write_all(&1u16.to_le_bytes())?;
    w.write_all(&SR.to_le_bytes())?;
    w.write_all(&(SR * 2).to_le_bytes())?;
    w.write_all(&2u16.to_le_bytes())?;
    w.write_all(&16u16.to_le_bytes())?;
    w.write_all(b"data")?;
    w.write_all(&(bytes as u32).to_le_bytes())?;
    for v in x {
        w.write_all(&((v.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?;
    }
    w.flush()?;
    Ok(())
}
