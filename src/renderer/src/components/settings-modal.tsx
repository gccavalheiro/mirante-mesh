import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'

import {
  activeBackground,
  deviceLabel,
  listDevices,
  updateSettings,
  useCustomBackground,
  useSettings,
  type DeviceList
} from '../lib/settings'
import { formatVolume } from '../lib/format'
import type { PeerView } from '../rtc/mesh-session'
import { echoAttenuationDb, micLevel, setMonitor } from '../rtc/mic-chain'
import { SCREEN_PROFILES, type ScreenProfileName } from '../rtc/sdp'
import { IconClose } from './icons'
import { ShortcutField } from './shortcut-field'

/**
 * Settings.
 *
 * Grouped by the question each answers rather than by the subsystem that
 * implements it: "what does everyone see and hear of me", "what goes out
 * when I share", "what reaches my ears", "where does this connect".
 *
 * Every control writes through immediately. There is no Save button, because
 * a Save button on a preferences panel is a chance to lose work and nothing
 * else.
 */

interface SettingsModalProps {
  /** Overlay shortcuts another application already owns. */
  takenShortcuts: Array<'toggle' | 'interact'>
  /** Quem está na sala, para o diagnóstico ler a saúde da voz deles. */
  peers: PeerView[]
  version: string
  onClose: () => void
  /** Open the camera picker, where the background is chosen with a live preview. */
  onAdjustCamera: () => void
}

const PROFILE_LABELS: Record<ScreenProfileName, string> = {
  crisp: 'Nítido',
  smooth: 'Fluido',
  thrifty: 'Econômico'
}

const PROFILE_HINTS: Record<ScreenProfileName, string> = {
  crisp: 'Prioriza resolução. Bom pra texto e código.',
  smooth: 'Prioriza movimento. Bom pra jogo e vídeo.',
  thrifty: 'Pra internet apertada ou sala cheia.'
}

/**
 * Sections, in the order someone actually reaches for them.
 *
 * One long scroll was fine with four settings and stopped being fine
 * somewhere around twelve — and the overlay adds a shortcut, a position and
 * an opacity on top of that. Tabs here match the source picker, which
 * already solved the same problem on the same kind of sheet.
 */
const TABS = [
  { id: 'devices', label: 'Dispositivos' },
  // Áudio vem logo depois, e não depois de Transmissão: escolher o
  // microfone e ajustar o microfone são a mesma conversa, e havia uma aba
  // inteira sobre outro assunto separando as duas metades dela.
  { id: 'audio', label: 'Áudio' },
  { id: 'broadcast', label: 'Transmissão' },
  { id: 'interface', label: 'Interface' },
  { id: 'advanced', label: 'Avançado' }
] as const

type TabId = (typeof TABS)[number]['id']

export function SettingsModal({
  takenShortcuts,
  peers,
  version,
  onClose,
  onAdjustCamera
}: SettingsModalProps): JSX.Element {
  const settings = useSettings()
  const [tab, setTab] = useState<TabId>('devices')
  /**
   * Monitoring is not a saved preference. Leaving the modal with your own
   * voice still in your ears, and no visible control to stop it, would be
   * a trap — so it dies with the dialog.
   */
  const [monitoring, setMonitoringState] = useState(false)
  const setMonitoring = (on: boolean): void => {
    setMonitoringState(on)
    setMonitor(on, settings.speakerId)
  }
  useEffect(() => () => setMonitor(false), [])
  const background = activeBackground(settings, useCustomBackground())
  const [devices, setDevices] = useState<DeviceList>({
    cameras: [],
    microphones: [],
    speakers: []
  })

  useEffect(() => {
    void listDevices().then(setDevices)
    // Plugging in a headset while this is open should update the lists.
    const onChange = (): void => void listDevices().then(setDevices)
    navigator.mediaDevices.addEventListener('devicechange', onChange)
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="tm-scrim" onMouseDown={onClose}>
      <div
        className="tm-sheet tm-sheet--settings"
        role="dialog"
        aria-modal="true"
        aria-label="Configurações"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="tm-sheet__head">
          <h2 className="label">Configurações</h2>
          <button type="button" className="tm-iconbtn" onClick={onClose} title="Fechar · Esc">
            <IconClose size={16} />
          </button>
        </header>

        <nav className="tm-tabs" role="tablist" aria-label="Seções das configurações">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`tm-tab${tab === t.id ? ' is-on' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <span className="tm-tabs__fill" />
        </nav>

        <div className="tm-sheet__scroll" role="tabpanel">
          {tab === 'devices' && (
            <>
              <Group title="Dispositivos">
            <Row label="Câmera" hint="Usada quando você liga a câmera.">
              <Picker
                value={settings.cameraId}
                onChange={(cameraId) => updateSettings({ cameraId })}
                options={devices.cameras.map((d, i) => ({
                  value: d.deviceId,
                  label: deviceLabel(d, i, 'Câmera')
                }))}
              />
            </Row>

            <Row label="Microfone" hint="Sua voz. Não tem a ver com o som da transmissão.">
              <Picker
                value={settings.microphoneId}
                onChange={(microphoneId) => updateSettings({ microphoneId })}
                options={devices.microphones.map((d, i) => ({
                  value: d.deviceId,
                  label: deviceLabel(d, i, 'Microfone')
                }))}
              />
            </Row>

            <Row label="Saída de som" hint="Onde você escuta todo mundo.">
              <Picker
                value={settings.speakerId}
                onChange={(speakerId) => updateSettings({ speakerId })}
                options={devices.speakers.map((d, i) => ({
                  value: d.deviceId,
                  label: deviceLabel(d, i, 'Saída')
                }))}
              />
            </Row>

            <Row label="Espelhar sua câmera" hint="Só na sua prévia. Os outros veem normal.">
              <Toggle
                checked={settings.mirrorSelf}
                onChange={(mirrorSelf) => updateSettings({ mirrorSelf })}
              />
            </Row>

            {/* A button, not a toggle: choosing a picture without seeing
                yourself in front of it is choosing blind. */}
            <Row
              label="Fundo da câmera"
              hint={background ? 'Sua imagem atrás de você.' : 'Nenhum. Aparece o que a câmera vê.'}
            >
              <button type="button" className="tm-btn" onClick={onAdjustCamera}>
                Ajustar
              </button>
            </Row>
          </Group>
            </>
          )}

          {tab === 'broadcast' && (
            <>
              <Group title="Transmissão">
            <Row label="Qualidade padrão" hint={PROFILE_HINTS[settings.defaultProfile]}>
              <div className="tm-segrow">
                {(Object.keys(PROFILE_LABELS) as ScreenProfileName[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`tm-seg${settings.defaultProfile === key ? ' is-on' : ''}`}
                    onClick={() => updateSettings({ defaultProfile: key })}
                  >
                    {PROFILE_LABELS[key]}
                  </button>
                ))}
              </div>
            </Row>

            <Row
              label="Teto de banda"
              hint="Por espectador. Numa sala cheia isso é dividido automaticamente."
            >
              <span className="tm-setting__readout num">
                {(SCREEN_PROFILES[settings.defaultProfile].maxBitrate / 1_000_000).toFixed(1)} Mb/s
                {' · '}
                {SCREEN_PROFILES[settings.defaultProfile].maxFramerate} fps
              </span>
            </Row>

            <Row label="Começar com som" hint="O que vem marcado ao abrir o seletor de fonte.">
              <Toggle
                checked={settings.shareWithSound}
                onChange={(shareWithSound) => updateSettings({ shareWithSound })}
              />
            </Row>
          </Group>
            </>
          )}

          {tab === 'audio' && (
            <>
              <Group title="Sua voz">
                {/* O mesmo seletor que existe em Dispositivos, aqui também.
                    Não é duplicação à toa: tudo nesta aba descreve o que
                    acontece com o microfone, e mandar alguém a outra aba
                    para trocar QUAL microfone é mandar embora no meio do
                    ajuste. Os dois leem e escrevem a mesma configuração. */}
                <Row label="Microfone" hint="De onde a sua voz sai.">
                  <Picker
                    value={settings.microphoneId}
                    onChange={(microphoneId) => updateSettings({ microphoneId })}
                    options={devices.microphones.map((d, i) => ({
                      value: d.deviceId,
                      label: deviceLabel(d, i, 'Microfone')
                    }))}
                  />
                </Row>

                <Row
                  label="Volume do seu microfone"
                  hint="Como você chega nos outros. A barra mostra o que está sendo enviado."
                >
                  <div className="tm-setting__slider">
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.01}
                      value={settings.micGain}
                      onChange={(e) => updateSettings({ micGain: Number(e.target.value) })}
                    />
                    <span className="num">{formatVolume(settings.micGain)}</span>
                  </div>
                </Row>

                <MicMeter />

                {/* One switch, not three levels.
                    Three was wrong twice over: nobody could tell two of them
                    apart, and asking someone to choose between methods they
                    cannot hear is asking them to guess. The question people
                    actually have is whether the room should be audible. */}
                <Row
                  label="Falar só segurando a tecla"
                  hint="O microfone fica fechado e abre enquanto você segura. Funciona com o jogo em foco."
                >
                  <Toggle
                    checked={settings.pushToTalk}
                    onChange={(pushToTalk) => updateSettings({ pushToTalk })}
                  />
                </Row>

                {settings.pushToTalk && (
                  <Row label="Tecla" hint="Clique e aperte a tecla que você quer usar.">
                    <TeclaDeFalar
                      codigo={settings.pushToTalkKey}
                      onCodigo={(pushToTalkKey) => updateSettings({ pushToTalkKey })}
                    />
                  </Row>
                )}

                <Row
                  label="Reduzir ruído do ambiente"
                  hint="Corta teclado, ventilador, TV e gente falando atrás, sem cortar você."
                >
                  <Toggle
                    checked={settings.noiseSuppression === 'strong'}
                    onChange={(on) =>
                      updateSettings({ noiseSuppression: on ? 'strong' : 'standard' })
                    }
                  />
                </Row>

                <Row
                  label="Cancelar o retorno da caixa de som"
                  hint="Se você ouve seus amigos em caixa, eles param de se ouvir de volta pelo seu microfone."
                >
                  <Toggle
                    checked={settings.echoCancel}
                    onChange={(echoCancel) => updateSettings({ echoCancel })}
                  />
                </Row>

                {/* And the way to judge it. A switch whose effect you cannot
                    hear is a switch you have no reason to trust. */}
                <Row
                  label="Ouvir meu microfone"
                  hint="Você se escuta exatamente como os outros escutam. Use fone."
                >
                  <Toggle checked={monitoring} onChange={setMonitoring} />
                </Row>
              </Group>

              <Diagnostico peers={peers} />

              <Group title="O que você escuta">
            <Row label="Volume geral" hint="Afeta todo mundo de uma vez.">
              <div className="tm-setting__slider">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.masterVolume}
                  onChange={(e) => updateSettings({ masterVolume: Number(e.target.value) })}
                />
                <span className="num">{formatVolume(settings.masterVolume)}</span>
              </div>
            </Row>

            <Row
              label="Sons da sala"
              hint="Entrada, saída e início de transmissão."
            >
              <Toggle
                checked={settings.roomSounds}
                onChange={(roomSounds) => updateSettings({ roomSounds })}
              />
            </Row>
          </Group>
            </>
          )}

          {tab === 'interface' && (
            <>
              <Group title="Overlay">
                <Row
                  label="Mostrar sobre o jogo"
                  hint="Uma folha transparente por cima de tudo, com as câmeras e as transmissões."
                >
                  <Toggle
                    checked={settings.overlayEnabled}
                    onChange={(overlayEnabled) => updateSettings({ overlayEnabled })}
                  />
                </Row>

                <Row
                  label="Ligar e desligar"
                  hint="Funciona com o jogo em primeiro plano."
                >
                  <ShortcutField
                    value={settings.overlayToggleKey}
                    taken={takenShortcuts.includes('toggle')}
                    onChange={(overlayToggleKey) => updateSettings({ overlayToggleKey })}
                  />
                </Row>

                <Row
                  label="Mexer no overlay"
                  hint="Enquanto estiver ligado, o mouse atravessa. Isto segura o mouse pra você arrastar."
                >
                  <ShortcutField
                    value={settings.overlayInteractKey}
                    taken={takenShortcuts.includes('interact')}
                    onChange={(overlayInteractKey) => updateSettings({ overlayInteractKey })}
                  />
                </Row>

                <Row label="Transparência" hint="Quanto o overlay aparece enquanto você joga.">
                  <div className="tm-setting__slider">
                    <input
                      type="range"
                      min={0.2}
                      max={1}
                      step={0.05}
                      value={settings.overlayOpacity}
                      onChange={(e) =>
                        updateSettings({ overlayOpacity: Number(e.target.value) })
                      }
                    />
                    <span className="num">{Math.round(settings.overlayOpacity * 100)}%</span>
                  </div>
                </Row>
              </Group>

              <Group title="Layout">
            <Row
              label="Lista de pessoas"
              hint={
                settings.railPosition === 'right'
                  ? 'Coluna fixa à direita. Nada fica por cima do vídeo.'
                  : 'Faixa sobre o vídeo, some junto com os controles.'
              }
            >
              <div className="tm-segrow">
                <button
                  type="button"
                  className={`tm-seg${settings.railPosition === 'right' ? ' is-on' : ''}`}
                  onClick={() => updateSettings({ railPosition: 'right' })}
                >
                  Direita
                </button>
                <button
                  type="button"
                  className={`tm-seg${settings.railPosition === 'bottom' ? ' is-on' : ''}`}
                  onClick={() => updateSettings({ railPosition: 'bottom' })}
                >
                  Embaixo
                </button>
              </div>
            </Row>
          </Group>
            </>
          )}

          {tab === 'advanced' && (
            <>
              <Group title="Conexão">
            <Row
              label="Servidor"
              hint="Só coordena a conexão. A imagem vai direto de um pro outro."
            >
              <input
                className="tm-input tm-input--inline num selectable"
                value={settings.server}
                placeholder="padrão do aplicativo"
                onChange={(e) => updateSettings({ server: e.target.value })}
              />
            </Row>
          </Group>

              <Group title="Sobre">
            <Row label="Versão">
              <span className="tm-setting__readout num">v{version}</span>
            </Row>
            <Row label="Registro" hint="Mande este arquivo quando algo der errado.">
              <span className="tm-setting__readout num selectable">
                %APPDATA%\tvmirante\logs\mirante.log
              </span>
            </Row>
          </Group>
            </>
          )}
        </div>

        <footer className="tm-sheet__foot">
          <span className="tm-sheet__hint label">
            tudo é salvo na hora · dispositivos valem a partir da próxima vez que ligar
          </span>
          <button type="button" className="tm-btn tm-btn--primary" onClick={onClose}>
            Fechar
          </button>
        </footer>
      </div>
    </div>
  )
}

/**
 * Your own level, live.
 *
 * Next to the slider because a level control without a meter is a guess —
 * the one thing you cannot do is hear yourself, which is exactly why this
 * setting did not exist before and exactly why it needs this.
 */
function MicMeter(): JSX.Element {
  const barRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let frame = 0
    const paint = (): void => {
      const node = barRef.current
      if (node) node.style.transform = `scaleX(${micLevel()})`
      frame = requestAnimationFrame(paint)
    }
    frame = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div className="tm-micmeter">
      <span ref={barRef} className="tm-micmeter__fill" />
    </div>
  )
}

/**
 * O que está acontecendo com o áudio, em números, ao vivo.
 *
 * Uma régua, não uma lista. A primeira versão eram quatro linhas de
 * largura cheia, iguais às dos controles — o que acrescentava scroll a uma
 * aba já longa e fazia leitura de instrumento parecer mais configuração.
 * Instrumento se lê de relance: quatro valores lado a lado, densos, com o
 * rótulo pequeno em cima e o número embaixo, no mesmo registro monoespaçado
 * que o resto do app usa para tudo que ele mede sobre si.
 *
 * Atualiza devagar de propósito. Número que pisca a sessenta quadros por
 * segundo é decoração.
 */
function Diagnostico({ peers }: { peers: PeerView[] }): JSX.Element {
  const [, redesenhar] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => redesenhar((n) => n + 1), 700)
    return () => window.clearInterval(id)
  }, [])

  const atenuacao = echoAttenuationDb()
  // Pior caso, não média: média esconde exatamente a pessoa de quem se
  // reclama.
  const pior = peers
    .filter((p) => p.stats.voiceConcealed > 0)
    .sort((a, b) => b.stats.voiceConcealed - a.stats.voiceConcealed)[0]

  return (
    <div className="tm-diag" title={pior ? `Pior caso: ${pior.info.name}` : undefined}>
      <Leitura
        rotulo="eco removido"
        valor={atenuacao > 0.1 ? atenuacao.toFixed(1) : '—'}
        unidade="dB"
      />
      <Leitura
        rotulo="voz refeita"
        valor={pior ? (pior.stats.voiceConcealed * 100).toFixed(1) : '—'}
        unidade="%"
        alerta={(pior?.stats.voiceConcealed ?? 0) > 0.03}
      />
      <Leitura
        rotulo="buffer"
        valor={pior && pior.stats.voiceBufferMs > 0 ? String(pior.stats.voiceBufferMs) : '—'}
        unidade="ms"
      />
      <Leitura
        rotulo="perda"
        valor={pior ? (pior.stats.voiceLoss * 100).toFixed(1) : '—'}
        unidade="%"
        alerta={(pior?.stats.voiceLoss ?? 0) > 0.02}
      />
    </div>
  )
}

function Leitura({
  rotulo,
  valor,
  unidade,
  alerta = false
}: {
  rotulo: string
  valor: string
  unidade: string
  alerta?: boolean
}): JSX.Element {
  return (
    <div className={`tm-diag__item${alerta ? ' is-warn' : ''}`}>
      <span className="label">{rotulo}</span>
      <b className="num">
        {valor}
        <i>{unidade}</i>
      </b>
    </div>
  )
}

/**
 * Captura uma tecla física para o push-to-talk.
 *
 * Guarda o código do Windows, não o caractere: é o que o gancho nativo
 * reporta e é o que sobrevive a layout, porque a mesma tecla física tem o
 * mesmo número em ABNT e em US — e é a tecla física que a pessoa decorou.
 *
 * `event.code` seria o certo pela especificação, mas o gancho fala em
 * virtual-key do sistema, e `keyCode` é o que ainda carrega esse número no
 * navegador. Depreciado, e sem substituto para esta ponte.
 */
function TeclaDeFalar({
  codigo,
  onCodigo
}: {
  codigo: number
  onCodigo: (codigo: number) => void
}): JSX.Element {
  const [ouvindo, setOuvindo] = useState(false)

  useEffect(() => {
    if (!ouvindo) return
    const pegar = (event: KeyboardEvent): void => {
      event.preventDefault()
      if (event.key === 'Escape') {
        setOuvindo(false)
        return
      }
      onCodigo(event.keyCode)
      setOuvindo(false)
    }
    window.addEventListener('keydown', pegar, true)
    return () => window.removeEventListener('keydown', pegar, true)
  }, [ouvindo, onCodigo])

  return (
    <button
      type="button"
      className={`tm-tecla${ouvindo ? ' is-listening' : ''}`}
      onClick={() => setOuvindo(true)}
    >
      {ouvindo ? 'aperte uma tecla' : nomeDaTecla(codigo)}
    </button>
  )
}

/**
 * O nome que a pessoa reconhece, a partir do código do Windows.
 *
 * Só os casos que não se adivinham. Letras e números são o próprio
 * caractere, que é o que a tabela de virtual-keys já faz coincidir com
 * ASCII maiúsculo.
 */
function nomeDaTecla(codigo: number): string {
  const nomes: Record<number, string> = {
    9: 'Tab',
    16: 'Shift',
    17: 'Ctrl',
    18: 'Alt',
    20: 'Caps Lock',
    32: 'Espaço',
    45: 'Insert',
    46: 'Delete',
    91: 'Windows',
    96: 'Num 0',
    97: 'Num 1',
    98: 'Num 2',
    99: 'Num 3',
    100: 'Num 4',
    101: 'Num 5',
    162: 'Ctrl esq.',
    163: 'Ctrl dir.',
    164: 'Alt esq.',
    165: 'Alt dir.'
  }
  if (nomes[codigo]) return nomes[codigo]
  if (codigo >= 112 && codigo <= 123) return `F${codigo - 111}`
  if (codigo >= 48 && codigo <= 90) return String.fromCharCode(codigo)
  return `tecla ${codigo}`
}

function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="tm-setgroup">
      <div className="tm-group__head">
        <span className="label">{title}</span>
        <span className="tm-group__rule" />
      </div>
      {children}
    </section>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="tm-setrow">
      <div className="tm-setrow__text">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </div>
      <div className="tm-setrow__control">{children}</div>
    </div>
  )
}

function Picker({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}): JSX.Element {
  return (
    <select
      className="tm-select"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Padrão do sistema</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

function Toggle({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (value: boolean) => void
}): JSX.Element {
  return (
    <label className="tm-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="tm-toggle__box" aria-hidden="true" />
    </label>
  )
}
