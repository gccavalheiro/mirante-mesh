//! O supressor de eco como modulo WebAssembly, para o AudioWorklet.
//!
//! ABI deliberadamente cru: ponteiros e inteiros, sem wasm-bindgen. Um
//! AudioWorklet instancia o modulo com `WebAssembly.instantiate` sobre
//! bytes, sem empacotador e sem glue de JS, e tudo que ele precisa e
//! escrever amostras num buffer e chamar uma funcao.
//!
//! O mesmo DSP roda nativo no addon. Uma implementacao, dois alvos — que e
//! o motivo de `mirante-echo` ser um crate proprio.

use mirante_echo::{EchoSuppressor, HOP};

/// Estado unico. O worklet cria um processador por cadeia de microfone, e
/// cada um instancia o seu proprio modulo, entao nao ha concorrencia aqui.
static mut SUP: Option<EchoSuppressor> = None;
static mut MIC: [f32; HOP] = [0.0; HOP];
static mut REF: [f32; HOP] = [0.0; HOP];
static mut OUT: [f32; HOP] = [0.0; HOP];

#[no_mangle]
pub extern "C" fn tamanho_do_bloco() -> usize {
    HOP
}

#[no_mangle]
pub extern "C" fn iniciar() {
    // SAFETY: instancia unica por modulo, sem threads no AudioWorklet.
    unsafe {
        SUP = Some(EchoSuppressor::new());
    }
}

/// Onde o worklet escreve o microfone.
#[no_mangle]
pub extern "C" fn buffer_microfone() -> *mut f32 {
    // SAFETY: endereco estavel; o worklet so escreve HOP amostras nele.
    unsafe { std::ptr::addr_of_mut!(MIC) as *mut f32 }
}

/// Onde o worklet escreve a referencia — o que o Mirante tocou.
#[no_mangle]
pub extern "C" fn buffer_referencia() -> *mut f32 {
    unsafe { std::ptr::addr_of_mut!(REF) as *mut f32 }
}

/// De onde o worklet le o resultado.
#[no_mangle]
pub extern "C" fn buffer_saida() -> *mut f32 {
    unsafe { std::ptr::addr_of_mut!(OUT) as *mut f32 }
}

/// Define onde a referencia esta em relacao ao microfone, em milissegundos.
#[no_mangle]
pub extern "C" fn definir_atraso_ms(ms: f32, taxa: u32) {
    unsafe {
        if let Some(s) = (*std::ptr::addr_of_mut!(SUP)).as_mut() {
            s.set_delay_ms(ms, taxa);
        }
    }
}

/// Processa um bloco. Le microfone e referencia dos buffers, escreve a
/// saida no terceiro.
#[no_mangle]
pub extern "C" fn processar() {
    unsafe {
        let Some(s) = (*std::ptr::addr_of_mut!(SUP)).as_mut() else {
            return;
        };
        let mic = &*std::ptr::addr_of!(MIC);
        let referencia = &*std::ptr::addr_of!(REF);
        s.push_reference(referencia);
        let limpo = s.process(mic);
        let saida = &mut *std::ptr::addr_of_mut!(OUT);
        saida[..limpo.len()].copy_from_slice(&limpo);
    }
}

/// Quanto foi tirado ate agora, em dB. Para a tela de audio mostrar que o
/// supressor esta fazendo algo em vez de so afirmar que esta ligado.
#[no_mangle]
pub extern "C" fn atenuacao_db() -> f32 {
    unsafe {
        (*std::ptr::addr_of!(SUP))
            .as_ref()
            .map(|s| s.attenuation_db())
            .unwrap_or(0.0)
    }
}
