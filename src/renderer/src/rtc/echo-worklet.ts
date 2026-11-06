/// <reference lib="webworker" />

/**
 * Supressão de eco, no fio entre o microfone e a transmissão.
 *
 * Duas entradas: o microfone, e o que o Mirante está tocando. Com a
 * referência em mãos o problema deixa de ser adivinhação — e isso importa
 * aqui porque, medido na montagem que motivou tudo isto, a voz do usuário
 * fica apenas 5,2 dB acima do eco, e 3,1 dB nos picos. Nenhum limiar
 * separa isso. Saber *o que* foi tocado separa.
 *
 * O DSP é o mesmo que roda nativo no addon, compilado para WebAssembly —
 * ver `native/echo`. O binário chega em base64 porque um AudioWorklet não
 * tem fetch e a página empacotada roda em `file://`, onde buscar o próprio
 * asset também falha. Mesma razão pela qual o RNNoise usa o build `-sync`
 * do Jitsi.
 */

interface EchoExports {
  memory: WebAssembly.Memory
  tamanho_do_bloco: () => number
  iniciar: () => void
  buffer_microfone: () => number
  buffer_referencia: () => number
  buffer_saida: () => number
  definir_atraso_ms: (ms: number, taxa: number) => void
  processar: () => void
  atenuacao_db: () => number
}

class EchoProcessor extends AudioWorkletProcessor {
  private wasm: EchoExports | null = null
  private bloco = 0
  private mic!: Float32Array
  private referencia!: Float32Array
  private saida!: Float32Array

  /** Amostras aguardando um bloco inteiro. */
  private pendMic: number[] = []
  private pendRef: number[] = []
  /** Amostras processadas esperando sair, 128 por quantum. */
  private prontas: number[] = []

  private ligado = true
  /** Quantos quanta desde o ultimo relato. A tela nao precisa de mais. */
  private desdeRelato = 0

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent): void => {
      const data = event.data as
        | { tipo: 'wasm'; bytes: ArrayBuffer; taxa: number }
        | { tipo: 'ligado'; valor: boolean }
        | { tipo: 'atraso'; ms: number; taxa: number }
        | null
      if (!data) return

      if (data.tipo === 'ligado') {
        this.ligado = data.valor
        return
      }
      if (data.tipo === 'atraso') {
        this.wasm?.definir_atraso_ms(data.ms, data.taxa)
        return
      }
      if (data.tipo === 'wasm') {
        // Instanciação síncrona: estamos na thread de áudio e não há
        // await que não custe quadros. O módulo tem 287 KB e nenhuma
        // importação, então isto é rápido e acontece uma vez.
        const modulo = new WebAssembly.Module(data.bytes)
        const inst = new WebAssembly.Instance(modulo, {})
        const ex = inst.exports as unknown as EchoExports
        ex.iniciar()
        this.bloco = ex.tamanho_do_bloco()
        const mem = ex.memory.buffer
        this.mic = new Float32Array(mem, ex.buffer_microfone(), this.bloco)
        this.referencia = new Float32Array(mem, ex.buffer_referencia(), this.bloco)
        this.saida = new Float32Array(mem, ex.buffer_saida(), this.bloco)
        this.wasm = ex
        // Enquanto houver supressão rodando, a tela de áudio tem um número
        // para mostrar em vez de afirmar que está ligada.
        this.port.postMessage({ tipo: 'pronto' })
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const mic = inputs[0]?.[0]
    const ref = inputs[1]?.[0]
    const out = outputs[0]?.[0]
    if (!out) return true

    if (!mic) {
      out.fill(0)
      return true
    }
    if (!this.wasm || !this.ligado) {
      out.set(mic)
      return true
    }

    for (let i = 0; i < mic.length; i++) {
      this.pendMic.push(mic[i])
      // Sem referência o bloco entra zerado, e não como um buraco: o
      // histórico é indexado por posição, e pular blocos desloca todo
      // atraso estimado depois disso.
      this.pendRef.push(ref ? ref[i] : 0)
    }

    while (this.pendMic.length >= this.bloco) {
      for (let i = 0; i < this.bloco; i++) {
        this.mic[i] = this.pendMic[i]
        this.referencia[i] = this.pendRef[i]
      }
      this.pendMic.splice(0, this.bloco)
      this.pendRef.splice(0, this.bloco)
      this.wasm.processar()
      for (let i = 0; i < this.bloco; i++) this.prontas.push(this.saida[i])
    }

    // Meio segundo entre relatos. A thread de audio nao deve gastar o
    // orcamento dela alimentando um medidor.
    if (++this.desdeRelato >= 180) {
      this.desdeRelato = 0
      this.port.postMessage({ tipo: 'atenuacao', db: this.wasm.atenuacao_db() })
    }

    if (this.prontas.length < out.length) {
      // Aquecimento: um bloco de latência, pago uma vez.
      out.fill(0)
      return true
    }
    for (let i = 0; i < out.length; i++) out[i] = this.prontas[i]
    this.prontas.splice(0, out.length)
    return true
  }
}

registerProcessor('echo', EchoProcessor)
