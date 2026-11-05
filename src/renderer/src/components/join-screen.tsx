import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'

import type { LobbyRoom } from '../../../shared/protocol'
import { useLobby } from '../lib/use-lobby'
import { resolveServer } from '../lib/server'
import { Avatar } from './avatar'
import { Logo } from './logo'

/**
 * The entrance.
 *
 * Two states, and each one owns the whole window.
 *
 * It used to be a two-column form — a pitch on the left, name and room on
 * the right — which is a SaaS sign-in, and it asked the one question the
 * product cannot answer ("which room?") before showing anything that would
 * help you answer it. The first attempt at replacing it was no better: a
 * 720px column of stacked sections down the middle of a 1280px window, with
 * the bottom half empty. A narrow column of form fields is still a form.
 *
 * So: the threshold is a full-screen moment with one question on it, and
 * the home is a faceplate beside a rack that runs the full height. Nothing
 * is centred in a box; the window is the layout.
 *
 * ## The threshold
 *
 * You cannot read the rack until you have said who you are — the product's
 * own rule, and also what makes this one screen instead of two. A saved
 * name skips it entirely: typing your own name every time you open a
 * program you use daily is a toll, not a greeting.
 */

interface JoinScreenProps {
  defaultName: string
  defaultRoom: string
  defaultServer: string
  error: string | null
  connecting: boolean
  onJoin: (details: { name: string; room: string; server: string }) => void
}

export function JoinScreen({
  defaultName,
  defaultRoom,
  defaultServer,
  error,
  connecting,
  onJoin
}: JoinScreenProps): JSX.Element {
  const [name, setName] = useState(defaultName)
  const [room, setRoom] = useState(defaultRoom)
  const [identified, setIdentified] = useState(defaultName.trim().length > 0)

  const trimmedName = name.trim()
  // The resolved address, never the raw setting: blank means the built-in
  // server, and the entrance has to look where the session will connect.
  const lobby = useLobby(resolveServer(defaultServer), identified)

  const nameRef = useRef<HTMLInputElement>(null)
  const roomRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (identified) roomRef.current?.focus()
    else nameRef.current?.focus()
  }, [identified])

  const enter = (target: string): void => {
    const trimmedRoom = target.trim()
    if (!trimmedName || !trimmedRoom || connecting) return
    onJoin({ name: trimmedName, room: trimmedRoom, server: defaultServer })
  }

  if (!identified) {
    return (
      <Threshold
        name={name}
        inputRef={nameRef}
        onName={setName}
        onCross={() => trimmedName.length > 0 && setIdentified(true)}
      />
    )
  }

  const rooms = lobby.snapshot?.rooms ?? []

  return (
    <div className="tm-home">
      {/* The faceplate: who you are, what the server is carrying, and the
          one action that does not depend on anybody else being here. */}
      <aside className="tm-face">
        <div className="tm-face__mark">
          <Logo size={20} />
          <span className="tm-face__wordmark">MIRANTE</span>
        </div>

        <div className="tm-face__you">
          <Avatar name={trimmedName} hue={hueFor(trimmedName)} />
          <div className="tm-face__ident">
            <b className="tm-face__name">{trimmedName}</b>
            <button
              type="button"
              className="tm-link"
              onClick={() => {
                setIdentified(false)
                setName('')
              }}
            >
              trocar
            </button>
          </div>
        </div>

        <Census lobby={lobby} rooms={rooms.length} />

        <div className="tm-face__grow" />

        <form
          className="tm-start"
          onSubmit={(event) => {
            event.preventDefault()
            enter(room)
          }}
        >
          <span className="label">Abrir uma sala</span>
          <input
            ref={roomRef}
            className="tm-start__input selectable"
            value={room}
            onChange={(event) => setRoom(event.target.value)}
            maxLength={64}
            placeholder="nome combinado"
            aria-label="Nome da sala"
          />
          <button
            type="submit"
            className="tm-start__go"
            disabled={connecting || room.trim().length === 0}
          >
            {connecting ? 'Entrando' : 'Abrir'}
          </button>
          <p className="tm-start__hint">
            Quem digitar o mesmo nome cai na mesma sala.
          </p>
        </form>

        {error && <p className="tm-face__error">{error}</p>}
      </aside>

      <main className="tm-rack">
        <header className="tm-rack__head">
          <span className="label">Salas abertas</span>
          <span className="tm-rack__rule" />
          <span className="label num tm-rack__tally">
            {rooms.length > 0 ? String(rooms.length).padStart(2, '0') : '—'}
          </span>
        </header>

        {rooms.length > 0 ? (
          <div className="tm-rack__list">
            {rooms.map((entry, index) => (
              <Channel
                key={entry.id}
                index={index}
                room={entry}
                disabled={connecting}
                onEnter={() => enter(entry.id)}
              />
            ))}
          </div>
        ) : (
          <Nobody lobby={lobby} />
        )}
      </main>
    </div>
  )
}

/**
 * The one question, with the window to itself.
 *
 * No card, no panel, no second column. An underline rather than a box: a
 * boxed field in the middle of an empty screen reads as a form, and this is
 * meant to read as being asked something.
 */
function Threshold({
  name,
  inputRef,
  onName,
  onCross
}: {
  name: string
  inputRef: React.RefObject<HTMLInputElement>
  onName: (value: string) => void
  onCross: () => void
}): JSX.Element {
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    onCross()
  }

  return (
    <div className="tm-thr">
      <form className="tm-thr__inner" onSubmit={submit}>
        <Logo size={40} className="tm-thr__mark" />
        <h1 className="tm-thr__ask">Quem é você?</h1>
        <p className="tm-thr__why">
          Seus amigos precisam te reconhecer lá dentro. Fica salvo — você só
          responde isso uma vez.
        </p>

        <div className="tm-thr__field">
          <input
            ref={inputRef}
            className="tm-thr__input selectable"
            value={name}
            onChange={(event) => onName(event.target.value)}
            maxLength={32}
            placeholder="como te chamam"
            aria-label="Seu nome"
          />
          <button
            type="submit"
            className="tm-thr__go"
            disabled={name.trim().length === 0}
            aria-label="Continuar"
          >
            →
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * What the server is carrying, as instrument readings.
 *
 * Two numbers in the register this app uses for every figure it reports
 * about itself. A big friendly "7 ONLINE" tile would be a growth metric on
 * a product with no growth to report and no reason to want one.
 */
function Census({
  lobby,
  rooms
}: {
  lobby: ReturnType<typeof useLobby>
  rooms: number
}): JSX.Element {
  if (lobby.unreachable) {
    return (
      <div className="tm-census is-dead">
        <span className="label">Servidor fora de alcance</span>
      </div>
    )
  }

  const people = lobby.snapshot?.people ?? 0
  return (
    <div className="tm-census">
      <Reading
        value={people}
        label={people === 1 ? 'pessoa' : 'pessoas'}
        lit={people > 0}
      />
      <Reading value={rooms} label={rooms === 1 ? 'sala' : 'salas'} lit={rooms > 0} />
    </div>
  )
}

function Reading({
  value,
  label,
  lit
}: {
  value: number
  label: string
  lit: boolean
}): JSX.Element {
  return (
    <div className="tm-reading">
      <span className="tm-reading__lamp" data-on={lit} aria-hidden="true" />
      <b className="tm-reading__value num">{String(value).padStart(2, '0')}</b>
      <span className="label">{label}</span>
    </div>
  )
}

/** The rack with nothing on it, which still has to fill the space. */
function Nobody({ lobby }: { lobby: ReturnType<typeof useLobby> }): JSX.Element {
  const [title, body] = lobby.loading
    ? ['Procurando', 'Perguntando ao servidor quem está acordado.']
    : lobby.unreachable
      ? [
          'Sem contato',
          'Não consegui falar com o servidor. Dá para abrir uma sala assim mesmo — ela só não vai aparecer para os outros até ele voltar.'
        ]
      : [
          'Ninguém por aqui',
          'Nenhuma sala aberta agora. Abra a primeira e mande o nome dela para os seus amigos.'
        ]

  return (
    <div className="tm-nobody">
      <span className="tm-nobody__glyph" aria-hidden="true" />
      <h2 className="tm-nobody__title">{title}</h2>
      <p className="tm-nobody__body">{body}</p>
    </div>
  )
}

/**
 * One open room, as a strip on a rack.
 *
 * The call sign is the biggest thing in the row because it is what you are
 * choosing. The faces are the second: recognising who is in there is the
 * actual reason this list exists, and they are drawn with the same hue the
 * room will give them, so a face is the same face on both sides of the door.
 */
function Channel({
  index,
  room,
  disabled,
  onEnter
}: {
  index: number
  room: LobbyRoom
  disabled: boolean
  onEnter: () => void
}): JSX.Element {
  const shown = room.people.slice(0, 5)
  const extra = room.people.length - shown.length

  return (
    <button
      type="button"
      className="tm-chan"
      disabled={disabled}
      onClick={onEnter}
      style={{ '--delay': `${Math.min(index, 8) * 40}ms` } as React.CSSProperties}
    >
      <span className="tm-chan__no num">{String(index + 1).padStart(2, '0')}</span>

      <span className="tm-chan__main">
        <span className="tm-chan__title">
          <span className="tm-chan__name">{room.id}</span>
          {room.live && (
            <span className="tm-chan__tally label">
              <span className="tm-chan__lamp" aria-hidden="true" />
              ao vivo
            </span>
          )}
          {room.showing && <span className="tm-chan__showing">{room.showing}</span>}
        </span>

        <span className="tm-chan__faces">
          {shown.map((person, at) => (
            <span className="tm-chan__face" key={`${person.name}-${at}`}>
              <Avatar name={person.name} hue={person.hue} />
            </span>
          ))}
          {extra > 0 && <span className="tm-chan__more num">+{extra}</span>}
          <span className="tm-chan__who">{describe(room.people.map((p) => p.name))}</span>
          <span className="tm-chan__dot" aria-hidden="true">·</span>
          <span className="tm-chan__age num">{age(room.since)}</span>
        </span>
      </span>

      <span className="tm-chan__go" aria-hidden="true">
        →
      </span>
    </button>
  )
}

/**
 * Who is in there, in words.
 *
 * Everyone, up to three — at that size the names ARE the list and a count
 * would be hiding information that fits. The first version said "Joacy,
 * dellannu e mais 1" beside three visible faces, which is both wrong and
 * oddly coy about a name it already had.
 *
 * Past three the line stops being recognition and becomes a wall of text,
 * and the question it answers — do I know anyone in there — was settled by
 * the first two.
 */
function describe(names: string[]): string {
  if (names.length === 0) return 'vazia'
  if (names.length === 1) return names[0]
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`
  return `${names[0]}, ${names[1]} e mais ${names.length - 2}`
}

/**
 * How long this room has been going.
 *
 * A room that started two minutes ago and one that has been running all
 * evening are different invitations, and the list said nothing about which
 * was which. Coarse on purpose: nobody needs the seconds.
 */
function age(since: number): string {
  const minutes = Math.floor((Date.now() - since) / 60000)
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/**
 * A colour for your own face, before the server has given you an id.
 *
 * The room derives everyone's hue from their peer id, which does not exist
 * yet at the entrance. This keeps your plate from being grey for the one
 * person whose name is already known — and it being a different colour once
 * inside is invisible, because nobody sees both screens at once.
 */
function hueFor(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360
  return hash
}
