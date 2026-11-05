import { useEffect, useRef, useState } from 'react'

import type { LobbySnapshot } from '../../../shared/protocol'

/**
 * What is happening on the server, before you have joined anything.
 *
 * Plain HTTP on an interval rather than a socket, for one reason: at the
 * entrance there is no room to connect to. Opening a websocket purely to
 * watch a lobby would mean a second connection lifecycle, a second
 * reconnect policy and a second thing to get wrong, to move a payload the
 * size of a sentence every few seconds.
 *
 * The request is made by the MAIN process, not from here. This window's CSP
 * keeps `connect-src` shut to http and https on purpose — it is the only
 * thing stopping MediaPipe from reporting usage to Google every time
 * someone turns on a camera background — and widening it for one GET would
 * give that telemetry its channel back.
 *
 * It stops the moment you are inside. The entrance is the only place this
 * is worth a single byte.
 */

/**
 * Slow enough to be free, fast enough that a friend appearing feels live.
 *
 * Someone standing at this screen is deciding where to go, and that decision
 * takes seconds — a list that settles a beat after they look at it is doing
 * its job.
 */
const POLL_MS = 4000

export interface Lobby {
  snapshot: LobbySnapshot | null
  /** True until the first answer, so the list can say "looking" once only. */
  loading: boolean
  /** The server could not be reached. Distinct from a quiet night. */
  unreachable: boolean
}

/**
 * Turn a signalling address into its lobby address.
 *
 * The configured value is a websocket base — `wss://host` — and rooms hang
 * off it at `/room/<name>`. The lobby is the same host over HTTP, which
 * keeps one setting instead of two and means a custom server automatically
 * brings its own entrance.
 */
export function lobbyUrl(server: string): string | null {
  if (!server.trim()) return null
  try {
    const url = new URL(server.trim())
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    url.pathname = '/lobby'
    url.search = ''
    return url.toString()
  } catch {
    return null
  }
}

export function useLobby(server: string, active: boolean): Lobby {
  const [snapshot, setSnapshot] = useState<LobbySnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [unreachable, setUnreachable] = useState(false)
  // Held so the interval never closes over a stale address.
  const target = useRef<string | null>(lobbyUrl(server))
  target.current = lobbyUrl(server)

  useEffect(() => {
    if (!active) return
    let stopped = false
    let timer = 0

    const read = async (): Promise<void> => {
      const url = target.current
      if (!url) {
        setUnreachable(true)
        setLoading(false)
        return
      }
      try {
        const next = (await window.mirante.lobby.read(url)) as LobbySnapshot | null
        if (stopped) return
        if (!next) {
          // Keep the last snapshot on screen. A list that empties on one
          // failed poll flickers between "your friends are here" and
          // "nobody is here", which is worse than slightly old news.
          setUnreachable(true)
          return
        }
        setSnapshot(next)
        setUnreachable(false)
      } catch {
        // The IPC itself failed — an older main process with no handler, or
        // a window being torn down. Without this the rejection escapes and
        // the screen settles on "nobody here", which is a different and
        // much more convincing lie than "no contact".
        if (!stopped) setUnreachable(true)
      } finally {
        if (!stopped) setLoading(false)
      }
    }

    void read()
    timer = window.setInterval(() => void read(), POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [active, server])

  return { snapshot, loading, unreachable }
}
