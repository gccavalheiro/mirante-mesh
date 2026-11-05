/**
 * Which signalling server this copy talks to.
 *
 * Two places need the answer and they must not disagree: the entrance, to
 * ask what rooms are open, and the session, to join one. They did disagree —
 * the entrance was handed the SAVED address, which is empty until someone
 * deliberately overrides it, while the session fell back to the built-in one
 * at the moment of connecting. So on a fresh install the room list had
 * nowhere to look and reported the server down, on the one screen where a
 * first-time user has nothing else to go on.
 *
 * Blank means the built-in address, everywhere, resolved in one function.
 */

declare const __SIGNAL_URL__: string

/** Baked at build time. See `__SIGNAL_URL__` in electron.vite.config.ts. */
export const BUILT_IN_SERVER = __SIGNAL_URL__

export function resolveServer(chosen: string): string {
  return chosen.trim() || BUILT_IN_SERVER
}
