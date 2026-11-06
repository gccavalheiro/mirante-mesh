# Krisp — teardown de redução de ruído e cancelamento de vozes

Engenharia reversa do módulo que o Discord carrega para tratar voz, feita a
partir da cópia instalada nesta máquina. Objetivo: entender **por que o Krisp
resolve um caso que nenhuma outra coisa resolve**, e decidir o que dá para
construir no Mirante.

**Data:** 2026-11-06
**Alvo:** `discord_krisp.node`, 15 069 112 bytes, PE x86-64
`sha256 0ed1eb586bd1df37302261cfd52bb0aeaa5d7bec94bdb8f8478b0ad854e868d5`
**Caminho:** `%LOCALAPPDATA%\Discord\app-1.0.9267\modules\discord_krisp-1\discord_krisp\`
**Ferramenta:** servidor MCP `rea` (`open_binary`), mais extração direta de literais.

## Limite deste documento

Isto estuda **arquitetura e técnica**, a partir de literais e símbolos do
binário. Os modelos do Krisp são cifrados, licenciados comercialmente, e **não
serão extraídos nem redistribuídos**. O que se tira daqui é o desenho; a
implementação do Mirante tem que ser nossa, com modelos que possamos usar.

---

## O caso que motivou a investigação

Relato do usuário, que é o teste mais duro que o app tem:

> Celular como microfone (WO Mic), amigos tocando na caixa de som Edifier do
> outro lado do quarto. No Discord, os amigos quase não se ouvem de volta. Em
> qualquer outro programa de voz, eles se escutam porque dá retorno.

Isso **não é ruído**, e é por isso que mexer em redução de ruído não resolveria:

- Um AEC clássico cancela por alinhamento temporal entre o que foi tocado e o
  que foi captado. Com um celular mandando áudio por rede, o atraso de captura
  varia na casa das centenas de milissegundos — fora da janela em que qualquer
  AEC consegue estimar e alinhar.
- RNNoise, que é o que o Mirante usa hoje no modo "Forte", **preserva fala**. A
  voz dos amigos saindo da caixa *é* fala. Ele passa adiante, com carinho.

O Discord resolve porque carrega um modelo separado só para isto.

## O que vem no pacote

```
discord_krisp.node          15 069 112   addon nativo
krisp-bvc-o-pro-v3.kef      15 122 004   Background Voice Cancellation
krisp-nc-o-med-v7.kef        5 880 640   Noise Cancellation, médio
krisp-nc-o-lite-v1.kef       2 895 574   Noise Cancellation, leve
krisp-nc-o-nb-v2.kef         2 822 586   Noise Cancellation, banda estreita
krisp-vad-o-v2.kef             592 233   detector de atividade de voz
```

Todos os `.kef` começam com 32 caracteres hexadecimais ASCII — contêiner
cifrado, com o que parece ser um digest na frente.

A proporção é a informação: **o modelo que apaga vozes é cinco vezes maior que
o que apaga ruído.** Separar fala de ruído é fácil perto de separar *uma* fala
de *outra* fala.

`index.js` expõe pouco: `_initialize`, `_getNcModels`, `_getVadModels`,
`_getNcModelFilename`. A escolha de modelo é do Discord, em tempo de execução.

## Motor de inferência

**ONNX Runtime, estaticamente ligado.** Confirmado por símbolos RTTI:

```
onnxruntime::functors::{Exp, Floor, LeakyRelu, Log, Reciprocal, Relu, Sigmoid, Sqrt, Tanh}
onnxruntime::CPUExecutionProvider::GetKernelRegistry
```

Os provedores de execução compilados incluem `CPUExecutionProvider`,
`CUDAExecutionProvider`, `DmlExecutionProvider`, `CoreMLExecutionProvider`,
`NnapiExecutionProvider`, `TensorrtExecutionProvider`. Só o de CPU aparece com
`default_delete` instanciado, o que sugere que é o único efetivamente usado no
caminho padrão — mas **DirectML está no binário**, e DirectML é o caminho de
GPU no Windows.

Krisp também carrega BLAS e camadas próprias, sobre **Intel MKL**:

```
KRISP::BLAS::KrispBlas          matMul, affectVectorBySigmoid, affectV1ByReluAddV2
KRISP::nn::KrispMlLinearExtLayer
MKL_VERBOSE Intel(R) MKL %d.%d
```

Ou seja: híbrido. O grafo principal roda em ONNX; algumas camadas são escritas
à mão sobre MKL, presumivelmente as que ficam no laço quente por quadro.

## A arquitetura do supressor

É aqui que o teardown entrega o que importa. Os símbolos descrevem um pipeline
em três estágios:

```
DfPreprocessor::calcFeatures      input.size() == frameLength
DfProcessor::infer()              ONNX
DfPostprocessor::applyDfOperation _params.dfOrder * _params.numFreqs
```

E as checagens internas dizem o resto:

```
DfPreprocessor: ndDf should be <= than frameLength / 2 + 1
DfPostprocessor::applyDfOperation: fftCoeffs.size() != mask.size()
DfPostprocessor::applyDfOperation: fftCoeffs.size() != _specSize
```

Lendo isso junto:

1. **Features por quadro** a partir do espectro. `ndDf <= frameLength/2 + 1` é
   a contagem de bins de uma rFFT, então são features espectrais.
2. **Uma máscara** aplicada sobre os coeficientes da FFT — ganho real por bin.
3. **Uma operação "DF" de ordem N**, `dfOrder * numFreqs`, aplicada apenas aos
   primeiros `ndDf` bins.

Esse terceiro estágio é a assinatura do **deep filtering**: em vez de um ganho
real por bin, a rede prediz **coeficientes complexos** aplicados sobre uma
janela curta de quadros, por bin, nas bandas baixas. É o que permite
reconstruir fase e recuperar fala enterrada no ruído, em vez de só atenuar.

### O que isto prova, e o que não prova

Prova: máscara real por bin, mais filtragem complexa de ordem N restrita às
bandas baixas. Esses são os estágios do deep filtering, técnica publicada por
Mack e Habets em 2019 — anterior ao DeepFilterNet, que a cita.

**Não prova que seja DeepFilterNet.** Não há literal de escala perceptual no
binário; procurei por `erb`, `mel` e `bark` e os únicos resultados foram
casamentos de substring dentro de `verbose` e `Gather`. O DeepFilterNet real
roda sobre `tract`, não ONNX Runtime, e não tem BLAS próprio sobre MKL.

A afirmação defensável é: **mesma família arquitetural, mesmos estágios de
processamento.** Isso basta para justificar o caminho de engenharia, e
sobrevive a escrutínio. O fosso do Krisp são os dados de treino e o modelo
BVC, não o desenho.

## Sessões e configuração

```
Krisp::AudioSdk::NcSession<float>    NcSession<short>
Krisp::AudioSdk::VadSession<float>   VadSession<short>
NcSession::initRtSession             sessão de tempo real
NcSession::getStats                  atrás de enableSessionStats no config
KrispNCSetup:  sampleRate = {}, duration = {}
KrispVADSetup: sampleRate = {}, duration = {}
Nc::create: Unsupported sampling rates or frame duration!
Unable to find model for requested sampleRate: {}
The input frame duration {} is not supported; using default: {}
```

Três coisas a tirar daqui:

- Sessões são **templadas no tipo de amostra**, float e int16. Suporte a int16
  direto evita uma conversão por quadro.
- Modelo é escolhido **por taxa de amostragem**, e falha explicitamente quando
  não há modelo para a taxa pedida. É por isso que existe um `nc-o-nb` (banda
  estreita) separado.
- Existe telemetria por sessão (`getStats`), opcional via config. O Krisp mede
  a si mesmo.

## O que isso significa para o Mirante

### O que é alcançável

**Redução de ruído de nível comparável.** DeepFilterNet 3 é aberto, tem
implementação em Rust, e está na mesma família arquitetural do que o Discord
embarca. O addon nativo do Mirante já é Rust via napi-rs, já roda áudio, e já
entrega quadros ao renderer por `MediaStreamTrackGenerator` sem prazo de
thread de áudio — o caminho já existe.

**Cancelamento de eco com referência própria.** O Mirante já captura áudio por
processo via WASAPI loopback, então podemos obter **o sinal exato do que foi
tocado**, sem depender de o sistema operacional cooperar.

Mas isso resolve **uma** das duas incógnitas, e a outra é a difícil. A
referência de reprodução fica limpa; o lado da **captura** continua sendo um
celular, por Wi-Fi, num dispositivo virtual, com atraso variável na casa de
100 a 300 ms. É esse atraso que o filtro adaptativo precisa rastrear, não o da
reprodução. Na prática significa cauda longa no filtro e reestimativa contínua
de atraso — e o teste honesto é exatamente esta montagem, com o WO Mic e a
Edifier, não um microfone USB numa mesa.

### O que é caro e precisa ser dito

**BVC não sai de graça.** Remover *a voz de outra pessoa* preservando a sua é
extração de locutor-alvo: exige uma impressão vocal sua (enrolamento) e um
modelo condicionado nela. A literatura aberta existe — VoiceFilter-Lite, pVAD,
variantes personalizadas de DeepFilterNet — mas é a parte de pesquisa, não a
de integração. Prometer paridade com um modelo de 15 MB treinado com os dados
do Krisp seria desonesto.

## Medido na montagem real

Três gravações do WO Mic, 48 kHz, na montagem exata do relato: celular como
microfone, amigos saindo na Edifier através do FxSound.

```
                              piso      fala (mediana)   fala (pico)
nada tocando, calado        -49,3 dBFS        —               —
amigos na Edifier, calado   -46,4 dBFS     -26,4 dBFS      -11,5 dBFS
amigos + voce falando       -48,9 dBFS     -21,2 dBFS       -8,4 dBFS
```

Quadros classificados como fala por concentração de energia entre 200 e
3400 Hz acima de 55%.

**A sua voz está 5,2 dB acima do eco na mediana, e 3,1 dB no pico.**

Isso elimina uma familia inteira de solucoes. Qualquer supressao por NIVEL —
portao, expansor, limiar adaptativo — precisa de uma separacao que aqui nao
existe. Com 5 dB, o limiar que cala os amigos cala voce junto.

O eco esta 22,9 dB acima do piso do quarto, entao nao e sutil: a Edifier
chega ao celular com forca de fala normal. O ganho automatico do WO Mic
provavelmente ajuda a piorar, comprimindo a diferenca que havia.

### O que sobrevive a essa medicao

**Supressao guiada por referencia** — porque ela nao e baseada em nivel. Com o
loopback sabemos *o que* foi tocado; nao estamos adivinhando o que e eco, e 5
dB de separacao deixa de importar. Exige rastrear o atraso, que continua sendo
a peca central.

**BVC / modelo** — unica saida quando a referencia nao existe, por exemplo se a
voz dos amigos sai pelo Discord e nao pelo Mirante.

E uma consequencia que precisa ser dita ao usuario: a supressao guiada por
referencia so funciona para o audio que o MIRANTE tocou. Amigos no Discord
saindo na mesma caixa continuam sem solucao por esse caminho.

## Restrição de plataforma, descoberta ao escolher as peças

O Mirante compila para `x86_64-pc-windows-msvc`. Isso elimina a opção óbvia.

**`webrtc-audio-processing` (AEC3) não serve.** É o wrapper Rust do APM do
WebRTC — o mesmo cancelador que o Chrome usa. A CI do projeto roda apenas
`ubuntu-latest` e `macos-latest`, e há duas issues **abertas**: "Windows
build" e "Support MSVC targets, and fix Apple cross-compilation, in bundled
builds". Não dá para depender disso.

O que sobra, e que compila em MSVC sem drama, é Rust puro:

```
deep_filter   0.2.5   1 257 061 downloads   DeepFilterNet dos proprios autores
rustfft       6.4.1  35 510 810 downloads
realfft       3.5.1  20 123 625 downloads
nnnoiseless   0.5.2   1 103 119 downloads   RNNoise em Rust
```

`speexdsp` existe mas são bindings para a biblioteca C, com 4 882 downloads —
trazer uma dependência C para o Windows em troca de um AEC mais fraco que o
AEC3 é o pior dos dois mundos.

### A consequência: supressão em vez de cancelamento

Sem AEC3, cancelar por subtração exige escrever o filtro adaptativo do zero.
E aqui vale olhar de novo para o caso real antes de escolher: o problema **não
é a referência**, que temos limpa pelo loopback. É o **atraso de captura**, que
num celular por Wi-Fi varia de 100 a 300 ms. Um cancelador precisa alinhar isso
com precisão de amostras. Um supressor não.

Então a peça certa para este caso é **supressão de eco guiada pela referência**:
usar o espectro do que tocamos, sobre uma janela larga o bastante para cobrir
todo o atraso plausível, para atenuar os bins do microfone que casam com
energia da referência. Tolera erro de atraso por construção, que é exatamente
onde o cancelador quebra. Custa artefato durante fala simultânea, e isso é
mensurável.

Com estimativa grosseira de atraso por GCC-PHAT para centrar a janela, e ERLE
medido em dB para saber se funcionou.

### Ordem defensável

1. **AEC nativo com referência por loopback.** Ataca a causa real do caso
   relatado, usa peça que já temos, e não depende de modelo nenhum. Com a
   ressalva acima: o atraso de captura do WO Mic é o risco, e só o teste na
   montagem real decide se foi longe o bastante.
2. **DeepFilterNet no addon**, substituindo RNNoise. Melhora mensurável de
   redução de ruído, arquitetura comprovadamente na mesma classe do Krisp.
3. **BVC / locutor-alvo**, como pesquisa declarada, depois de 1 e 2 estarem no
   ar e medidos.

E em todos os três: a tela de configuração de áudio precisa mostrar o que está
acontecendo — nível de entrada, quanto está sendo suprimido, se o AEC
convergiu, qual o atraso estimado. Hoje ela é um interruptor e um slider, e
não passa confiança nenhuma porque não mostra nada.

## Reprodutibilidade

```bash
# módulo
ls "$LOCALAPPDATA/Discord/app-1.0.9267/modules/discord_krisp-1/discord_krisp"

# literais (sem binutils nesta máquina; extração direta)
python -c "
import re
data = open(r'...\discord_krisp.node','rb').read()
s = sorted({t.decode('ascii','ignore') for t in re.findall(rb'[\x20-\x7e]{5,}', data)})
print('\n'.join(x for x in s if re.search(r'Df[A-Z]|Krisp|onnxruntime', x)))
"
```
