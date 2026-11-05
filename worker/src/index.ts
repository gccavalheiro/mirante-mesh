import { Directory } from './directory'
import { Room } from './room'

export { Directory, Room }

/**
 * Mirante signalling, on Cloudflare Workers.
 *
 * The Worker does almost nothing: it normalises the room name, turns it into
 * a stable Durable Object id, and hands the WebSocket upgrade over. All the
 * state lives in the Room object, because a Durable Object addressed by name
 * IS the room.
 *
 * Media never touches this. The Worker coordinates who should call whom; the
 * video goes straight from one friend's machine to another's, which is why
 * running the coordinator in some distant datacentre costs nothing in latency.
 */

/** "Sala do Mirante" and "sala-do-mirante" must land on the same object. */
function normaliseRoom(raw: string): string {
  return (
    raw
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'mirante'
  )
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return Response.json({ ok: true })
    }

    // What is open right now. Read by the entrance before anyone has joined
    // anything, which is exactly why it is plain HTTP and not part of a
    // room socket: at that moment there is no room.
    if (url.pathname === '/lobby') {
      const id = env.DIRECTORY.idFromName('global')
      return env.DIRECTORY.get(id).fetch('https://directory/lobby')
    }

    // ws(s)://host/room/<name>, with the name also accepted as ?room= so a
    // client can keep using a single endpoint.
    const fromPath = url.pathname.startsWith('/room/') ? url.pathname.slice(6) : ''
    const room = normaliseRoom(decodeURIComponent(fromPath || url.searchParams.get('room') || ''))

    const wantsPeers = url.searchParams.has('peers')
    if (request.headers.get('Upgrade') !== 'websocket' && !wantsPeers) {
      return new Response(
        'Mirante signalling. Connect a websocket to /room/<nome>.',
        { status: 426, headers: { 'content-type': 'text/plain; charset=utf-8' } }
      )
    }

    // A Durable Object cannot read the name it was addressed by, and the
    // directory lists rooms by the name people type. So it travels.
    const id = env.ROOM.idFromName(room)
    const forward = new URL(request.url)
    forward.searchParams.set('name', room)
    return env.ROOM.get(id).fetch(new Request(forward, request))
  }
} satisfies ExportedHandler<Env>
