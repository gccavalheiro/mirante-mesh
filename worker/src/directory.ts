import { DurableObject } from 'cloudflare:workers'

import type { LobbyRoom, LobbySnapshot } from '../../src/shared/protocol'

/**
 * The census of open rooms.
 *
 * A room here is a Durable Object addressed by its own name, which is what
 * makes the signalling server as simple as it is — and also why nothing
 * could ever answer "what rooms are open". Durable Objects cannot be
 * enumerated. There is no list unless something keeps one.
 *
 * This keeps it. Every Room reports itself whenever its roster changes and
 * again on a timer while it is occupied; this object holds the last report
 * from each and serves them together.
 *
 * ## Why not a database
 *
 * D1 and KV are both free and both wrong for this. KV is eventually
 * consistent on the order of a minute, and a live count that is a minute
 * stale is worse than no count. D1 would work, at the price of a schema, a
 * binding and a disk write for data whose entire value expires in thirty
 * seconds — presence is not durable data. A Durable Object is strongly
 * consistent, already enabled here, and is the thing Cloudflare built for
 * coordinating live state.
 */

/**
 * How long a report stands before it is treated as a ghost.
 *
 * A Room that is evicted, crashes, or loses its last socket without
 * finishing its own cleanup leaves its last report behind. Nothing can
 * distinguish that from a quiet room, so every entry has to expire on its
 * own. Comfortably longer than the heartbeat, so an ordinary slow beat
 * never makes a live room flicker out of the list.
 */
const STALE_MS = 70_000

interface Report {
  room: string
  people: LobbyRoom['people']
  live: boolean
  showing?: string
  since: number
  /** When this report landed, for expiry. */
  at: number
}

export class Directory extends DurableObject<Env> {
  /**
   * Held in memory, not in storage, and that is the right trade.
   *
   * Presence is worthless the moment it is old, so durability buys nothing
   * — if this object is evicted the list rebuilds itself within one
   * heartbeat from the rooms that are still alive. Writing every report to
   * disk would be paying for persistence of data we deliberately expire.
   */
  private readonly rooms = new Map<string, Report>()

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/report') {
      const report = (await request.json()) as Omit<Report, 'at'>
      if (report.people.length === 0) this.rooms.delete(report.room)
      else this.rooms.set(report.room, { ...report, at: Date.now() })
      return new Response(null, { status: 204 })
    }

    return Response.json(this.snapshot(), {
      headers: {
        'access-control-allow-origin': '*',
        // Always fresh. A cached census is a census of the past, and the
        // whole value of this is that it is now.
        'cache-control': 'no-store'
      }
    })
  }

  private snapshot(): LobbySnapshot {
    const now = Date.now()
    const open: LobbyRoom[] = []
    let people = 0

    for (const [name, report] of this.rooms) {
      if (now - report.at > STALE_MS) {
        this.rooms.delete(name)
        continue
      }
      people += report.people.length
      open.push({
        id: report.room,
        people: report.people,
        live: report.live,
        showing: report.showing,
        since: report.since
      })
    }

    // Rooms with something on screen first, then the busiest, then the
    // oldest. Someone scanning this list is looking for something to watch
    // before they are looking for a crowd.
    open.sort(
      (a, b) =>
        Number(b.live) - Number(a.live) ||
        b.people.length - a.people.length ||
        a.since - b.since
    )

    return { rooms: open, people, at: now }
  }
}
