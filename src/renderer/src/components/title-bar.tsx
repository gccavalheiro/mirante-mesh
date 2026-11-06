import { useEffect, useState, type JSX } from 'react'

import type { SignalingStatus } from '../rtc/signaling'
import { IconClose, IconMaximize, IconMinimize, IconRestore } from './icons'
import { Logo } from './logo'

/**
 * Custom title bar.
 *
 * Frameless window, so this is both the drag handle and the room's status
 * line. The connection state lives here permanently rather than appearing as a
 * toast — in a live app, "am I still connected" is a standing question, not an
 * event.
 */

interface TitleBarProps {
  room: string | null
  status: SignalingStatus
  peerCount: number
  relayed: boolean
  /**
   * A pior latência da sala, em milissegundos, ou zero sem ninguém.
   *
   * Pior e não média: numa malha, a chamada é tão boa quanto o pior
   * caminho, e a média esconde exatamente a pessoa que está sofrendo.
   */
  rttMs: number
  /** Quanto da voz dos outros o receptor teve que inventar, 0..1. */
  voiceConcealed: number
}

const STATUS_TEXT: Record<SignalingStatus, string> = {
  idle: 'desconectado',
  connecting: 'conectando',
  open: 'conectado',
  reconnecting: 'reconectando',
  closed: 'desconectado'
}

export function TitleBar({
  room,
  status,
  peerCount,
  relayed,
  rttMs,
  voiceConcealed
}: TitleBarProps): JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.mirante.window.isMaximized().then(setMaximized)
    return window.mirante.window.onState((state) => setMaximized(state.maximized))
  }, [])

  return (
    <header className="tm-titlebar">
      <div className="tm-titlebar__drag">
        <span className="tm-brand">
          <Logo size={16} />
          <span className="tm-brand__type">Mirante</span>
        </span>

        {room && (
          <>
            <span className="tm-titlebar__sep" aria-hidden="true" />
            <span className="tm-titlebar__room">{room}</span>
            <span className="tm-titlebar__count num">
              {peerCount + 1} {peerCount === 0 ? 'pessoa' : 'pessoas'}
            </span>
          </>
        )}

        <span className={`tm-conn tm-conn--${status}`}>
          <span className="tm-conn__dot" />
          {STATUS_TEXT[status]}
        </span>

        {/* Leitura de instrumento na própria moldura, como etiqueta de
            equipamento. "A chamada está boa?" é pergunta permanente numa
            conversa, e permanente é o que fica na moldura — não o que
            aparece quando alguém vai procurar. */}
        {room && status === 'open' && peerCount > 0 && (
          <span className="tm-titlebar__meters">
            {rttMs > 0 && (
              <span
                className={`tm-meter num${rttMs > 150 ? ' is-warn' : ''}`}
                title="Pior latência da sala"
              >
                {rttMs} ms
              </span>
            )}
            {voiceConcealed > 0.01 && (
              <span
                className="tm-meter num is-warn"
                title="Parte da voz que o seu computador teve que reconstruir — é isso que soa como travando"
              >
                voz {(voiceConcealed * 100).toFixed(0)}%
              </span>
            )}
          </span>
        )}

        {relayed && (
          <span className="tm-chip tm-chip--warn" title="Pelo menos um caminho usa TURN">
            retransmitido
          </span>
        )}
      </div>

      <div className="tm-titlebar__controls">
        <button
          type="button"
          className="tm-wbtn"
          onClick={() => window.mirante.window.minimize()}
          title="Minimizar"
        >
          <IconMinimize size={15} />
        </button>
        <button
          type="button"
          className="tm-wbtn"
          onClick={() => window.mirante.window.toggleMaximize()}
          title={maximized ? 'Restaurar' : 'Maximizar'}
        >
          {maximized ? <IconRestore size={15} /> : <IconMaximize size={15} />}
        </button>
        <button
          type="button"
          className="tm-wbtn tm-wbtn--close"
          onClick={() => window.mirante.window.close()}
          title="Fechar"
        >
          <IconClose size={15} />
        </button>
      </div>
    </header>
  )
}
