"""
Bancada de medicao do caminho de eco.

Entra o par (referencia conhecida, captura do microfone) e sai o numero que
decide tudo: existe eco, de quanto e o atraso, e ele e estavel o bastante
para ser rastreado.

Nada aqui depende do Mirante. Roda sozinho, offline, e e contra isto que
qualquer supressor sera medido antes de encostar no app.

    python medir.py referencia.wav mic-silencio.wav
"""

import sys
import wave

import numpy as np

SR = 48000
# Janela de busca: o caminho celular -> Wi-Fi -> WO Mic nunca passa disto, e
# procurar alem so convida correlacao espuria.
MAX_ATRASO_MS = 800
BLOCO_S = 1.0


def ler(caminho: str) -> np.ndarray:
    with wave.open(caminho, "rb") as w:
        if w.getframerate() != SR:
            raise SystemExit(f"{caminho}: esperava {SR} Hz, veio {w.getframerate()}")
        if w.getsampwidth() != 2:
            raise SystemExit(f"{caminho}: esperava PCM 16 bits")
        bruto = w.readframes(w.getnframes())
    x = np.frombuffer(bruto, dtype="<i2").astype(np.float64) / 32768.0
    if w.getnchannels() > 1:
        x = x.reshape(-1, w.getnchannels()).mean(axis=1)
    return x


def gcc_phat(a: np.ndarray, b: np.ndarray, max_lag: int):
    """
    Atraso de `b` em relacao a `a`, em amostras, com o pico de correlacao.

    PHAT branqueia a magnitude e deixa so a fase. Isso importa aqui: a Edifier
    e o FxSound mudam a COR do sinal (equalizacao, compressao), e correlacao
    comum persegue a cor. A fase sobrevive a isso.
    """
    n = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    A = np.fft.rfft(a, n)
    B = np.fft.rfft(b, n)
    R = A * np.conj(B)
    mag = np.abs(R)
    mag[mag < 1e-12] = 1e-12
    cc = np.fft.irfft(R / mag, n)
    cc = np.concatenate((cc[-max_lag:], cc[: max_lag + 1]))
    pico = int(np.argmax(np.abs(cc)))
    # Quao destacado o pico esta do resto: um pico que mal se separa do fundo
    # e ruido com sorte, nao um atraso.
    fundo = np.median(np.abs(cc))
    nitidez = float(np.abs(cc[pico]) / fundo) if fundo > 0 else 0.0
    return pico - max_lag, nitidez


def db(x: float) -> float:
    return 20 * np.log10(max(x, 1e-12))


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x * x))) if len(x) else 0.0


def main() -> None:
    ref = ler(sys.argv[1])
    mic = ler(sys.argv[2])
    print(f"referencia  {len(ref)/SR:7.2f}s   rms {db(rms(ref)):7.1f} dBFS")
    print(f"microfone   {len(mic)/SR:7.2f}s   rms {db(rms(mic)):7.1f} dBFS")

    max_lag = int(MAX_ATRASO_MS * SR / 1000)
    n = min(len(ref), len(mic))
    atraso, nitidez = gcc_phat(ref[:n], mic[:n], max_lag)
    print()
    print(f"atraso global   {atraso:+6d} amostras  ({atraso/SR*1000:+7.1f} ms)")
    print(f"nitidez do pico {nitidez:6.1f}x acima do fundo")
    if nitidez < 8:
        print("  ATENCAO: pico fraco. A referencia pode nao ter tocado durante a gravacao.")

    # Quanto da energia do microfone e explicada pela referencia alinhada.
    # Projecao escalar: o melhor ganho unico que casa um no outro.
    desloc = int(atraso)
    if desloc >= 0:
        r = ref[: n - desloc]
        m = mic[desloc:n]
    else:
        r = ref[-desloc:n]
        m = mic[: n + desloc]
    k = min(len(r), len(m))
    r, m = r[:k], m[:k]
    g = float(np.dot(r, m) / max(np.dot(r, r), 1e-12))
    residuo = m - g * r
    # O veredito vem do GANHO do caminho, nao da nitidez do pico.
    #
    # Com o microfone perto do piso de ruido, o branqueamento do PHAT
    # amplifica numero pequeno e a correlacao crava em lag zero com pico
    # altissimo — 300x acima do fundo, sobre silencio. A nitidez sozinha
    # afirmaria que encontrou um atraso perfeito. Nao encontrou nada.
    print()
    if db(abs(g)) < -40:
        print("  VEREDITO: NAO HA ECO nesta gravacao.")
        print("  A referencia nao chegou ao microfone. Ou ela nao tocou durante")
        print("  a captura, ou o volume estava baixo demais para a distancia.")
        # ATENCAO ao proximo passo, que ja custou caro uma vez.
    #
    # Este ganho e um ESCALAR, e caminho de eco e um filtro: reverberacao,
    # equalizacao, resposta do alto falante. Um escalar sempre reporta ERLE
    # perto de zero, mesmo quando ha eco forte e cancelavel. O numero abaixo
    # serve para dizer SE a referencia chegou ao microfone, nao se ela pode
    # ser cancelada.
    #
    # Para medir cancelabilidade de verdade e preciso ajustar um FIR. NAO
    # faca isso montando a matriz de atrasos e chamando lstsq: com 4 s de
    # bloco e 120 ms de cauda a matriz tem 192.000 x 1.440 em float64, ou
    # 2,2 GB, e o SVD em cima disso trava a maquina. Resolva no dominio da
    # frequencia, por Wiener, que e O(n log n) e roda em milissegundos.
    print()
    print(f"ganho do caminho   {db(abs(g)):7.1f} dB")
    print(f"energia do mic     {db(rms(m)):7.1f} dBFS")
    print(f"residuo linear     {db(rms(residuo)):7.1f} dBFS")
    print(f"ERLE linear        {db(rms(m)) - db(rms(residuo)):7.1f} dB"
          "   <- quanto um cancelador LINEAR perfeito conseguiria")

    print()
    print("por segundo:  atraso(ms)  nitidez   eco(dB)   residuo(dB)")
    passo = int(BLOCO_S * SR)
    atrasos = []
    for i in range(0, k - passo, passo):
        bloco_r = ref[i : i + passo]
        bloco_m = mic[i : i + passo]
        a, nit = gcc_phat(bloco_r, bloco_m, max_lag)
        seg_m = m[i : i + passo]
        seg_res = residuo[i : i + passo]
        if nit >= 6:
            atrasos.append(a)
        marca = "" if nit >= 6 else "  (fraco)"
        print(f"  {i//passo:3d}s      {a/SR*1000:+8.1f}   {nit:6.1f}  "
              f"{db(rms(seg_m)):8.1f}   {db(rms(seg_res)):8.1f}{marca}")

    if atrasos:
        arr = np.array(atrasos)
        print()
        print(f"atraso: mediana {np.median(arr)/SR*1000:+.1f} ms, "
              f"desvio {arr.std()/SR*1000:.1f} ms, "
              f"faixa {arr.min()/SR*1000:+.1f} a {arr.max()/SR*1000:+.1f} ms "
              f"({len(atrasos)}/{(k-passo)//passo} blocos confiaveis)")


if __name__ == "__main__":
    main()
