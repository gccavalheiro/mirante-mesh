//! Grava o que o computador ESTA TOCANDO, para servir de referencia de eco.
//!
//! O cancelamento de eco precisa de duas coisas alinhadas no tempo: o que
//! saiu pelo alto falante, e o que voltou pelo microfone. A segunda qualquer
//! gravador pega. A primeira, nao — e foi por isso que tres tentativas de
//! medir isto por fora falharam, com ffplay escolhendo o dispositivo dele e
//! a referencia nunca chegando ao microfone.
//!
//! Aqui ela vem de onde sempre esteve: o loopback por processo do WASAPI,
//! que este addon ja implementa para manter a voz dos amigos fora da
//! transmissao. O mesmo mecanismo, apontado para o outro lado.
//!
//!     cargo run --bin gravar-referencia -- <segundos> <saida.wav>
//!
//! Captura tudo que esta tocando. Rode junto com uma gravacao do microfone
//! e os dois arquivos formam o par que a bancada mede.

use std::env;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::mpsc;
use std::time::Duration;

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use mirante_process_audio::win::Capture;
    use mirante_process_audio::LoopbackMode;

    let args: Vec<String> = env::args().collect();
    let segundos: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(30);
    let saida = args
        .get(2)
        .cloned()
        .unwrap_or_else(|| "referencia-loopback.wav".to_string());

    // Excluir o PROPRIO processo captura tudo o mais que esta tocando, que
    // e o que queremos: a referencia e o que chegou ao alto falante, venha
    // do Mirante, do Discord ou de um navegador.
    //
    // A primeira versao passava u32::MAX como pid, raciocinando que excluir
    // um processo inexistente excluiria nada. O WASAPI nao trata isso como
    // "nada": a referencia saiu cheia de buracos de silencio digital, -240
    // dBFS por segundos inteiros, enquanto o microfone seguia com conteudo.
    // Este e o caso documentado.
    let eu = std::process::id();
    let mut captura = Capture::open(eu, LoopbackMode::ExcludeTree)?;

    // O formato e fixo no backend; `Capture` nao o carrega.
    let taxa = mirante_process_audio::win::SAMPLE_RATE;
    let canais = mirante_process_audio::win::CHANNELS as u16;
    eprintln!("capturando {taxa} Hz, {canais} canais, por {segundos}s");

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    captura.start(move |bloco: &[u8]| {
        let _ = tx.send(bloco.to_vec());
    })?;

    let fim = std::time::Instant::now() + Duration::from_secs(segundos);
    let mut pcm: Vec<u8> = Vec::new();
    while std::time::Instant::now() < fim {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(bloco) => pcm.extend_from_slice(&bloco),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    captura.stop()?;

    escrever_wav(&saida, &pcm, taxa, canais)?;
    eprintln!(
        "{} — {} bytes, {:.1}s de audio",
        saida,
        pcm.len(),
        pcm.len() as f64 / (taxa as f64 * canais as f64 * 4.0)
    );
    Ok(())
}

/// WAV float de 32 bits, que e o formato que o WASAPI entrega aqui.
#[cfg(windows)]
fn escrever_wav(
    caminho: &str,
    pcm: &[u8],
    taxa: u32,
    canais: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut w = BufWriter::new(File::create(caminho)?);
    let bits: u16 = 32;
    let bloco = canais * bits / 8;
    let bytes_por_segundo = taxa * bloco as u32;

    w.write_all(b"RIFF")?;
    w.write_all(&(36u32 + pcm.len() as u32).to_le_bytes())?;
    w.write_all(b"WAVEfmt ")?;
    w.write_all(&16u32.to_le_bytes())?;
    w.write_all(&3u16.to_le_bytes())?; // IEEE float
    w.write_all(&canais.to_le_bytes())?;
    w.write_all(&taxa.to_le_bytes())?;
    w.write_all(&bytes_por_segundo.to_le_bytes())?;
    w.write_all(&bloco.to_le_bytes())?;
    w.write_all(&bits.to_le_bytes())?;
    w.write_all(b"data")?;
    w.write_all(&(pcm.len() as u32).to_le_bytes())?;
    w.write_all(pcm)?;
    w.flush()?;
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    eprintln!("loopback por processo so existe no Windows");
}
