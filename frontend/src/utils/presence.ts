// frontend/src/utils/presence.ts
//
// What one player is doing RIGHT NOW, as opposed to what they have done.
//
// ==================================================================
//  DESIGN NOTE 740: EPHEMERAL, AND NEVER AUTHORITATIVE
// ==================================================================
//
// REQUESTED: rivals should watch a president draft their routes live, and "it sounds like we're going to need
// the Presence channel for the full game anyway".
//
// THE ONE INVARIANT THAT MATTERS. Everything in this module is a HINT. It is never read by the reducer, never
// written to the action log, never consulted by Undo, and never allowed to decide anything. A route draft
// broadcast here and the same route dispatched as `RunManualRoute` are different objects with different
// lifetimes, and the second is the only one that is true.
//
// WHY THAT IS WORTH A PARAGRAPH RATHER THAN A SENTENCE: this codebase's architecture is an append-only log
// replayed into state (#591, #668), and the reason it survives Undo, reconnects and races is that there is
// exactly one source of truth. A presence channel is a SECOND stream of data about the same game, arriving
// out of order, from clients that may have crashed. The moment anything downstream treats it as fact, every
// guarantee the log gives up is gone -- and the failure would be intermittent, which is the worst kind. So the
// discipline is not "be careful"; it is that presence lives in its own module, its own subcollection, and its
// own React state, and nothing that computes game state may import from here.
//
// THREE RULES THE TRANSPORT CANNOT ENFORCE, so they live here as pure functions:
//
//   1. STALE IS ABSENT. A client that closes its tab leaves its last presence document behind forever. A
//      reader that trusts it shows a route being drafted by somebody who left the game an hour ago. Every read
//      is filtered by age, and the timeout is deliberately short -- a few missed heartbeats, not minutes.
//   2. ONLY THE ACTOR PUBLISHES ROUTES. Otherwise four players idling on the Routes step broadcast four sets
//      of stale drafts, and the map fills with lines nobody is drawing.
//   3. COALESCED, NOT STREAMED. A hex click is a keystroke, and a document write per keystroke is both
//      expensive and pointless -- nobody can read four updates a second. `PRESENCE_PUBLISH_MS` is the floor.
//
// See docs/ai_architecture/firebase_middleware.md, presence.ts #740.

/** One player's live, unsaved intent. Extensible: presence is where cursor position, "thinking" indicators and
 *  connection health will go, which is why this is a record rather than a route-shaped type. */
export interface PresenceState {
  /** The seat this belongs to. */
  playerId: string;
  /** Client clock, milliseconds. Compared only against OTHER presence from the same client's perspective --
   *  see `isPresenceFresh` for why that is sound and a server timestamp is not what is wanted here. */
  at: number;
  /** Design note #740: routes being drafted, by train index. Absent when the player is not drafting. */
  routeDrafts?: Readonly<Record<number, ReadonlyArray<readonly [number, number]>>>;
  /** The corporation those drafts belong to, so a reader never attributes them to the wrong livery. */
  actingCompanyId?: number | null;
}

/** How long a presence document stays believable without a refresh.
 *
 *  SHORT ON PURPOSE. A stale route is worse than no route: it shows a rival apparently mid-decision when they
 *  have gone. Six seconds is a few missed publishes, not a network hiccup. */
export const PRESENCE_STALE_MS = 6_000;

/** The floor between two publishes from one client. A hex click is a keystroke; nobody reads four a second. */
export const PRESENCE_PUBLISH_MS = 400;

/** Whether a presence record is recent enough to show.
 *
 *  `now` is passed rather than read so this is testable and so a caller can filter a whole snapshot against
 *  one instant -- filtering each entry against its own `Date.now()` would let a long list disagree with
 *  itself about what "now" is. */
export function isPresenceFresh(entry: PresenceState, now: number): boolean {
  if (!Number.isFinite(entry.at)) return false;
  const age = now - entry.at;
  /* A record from the FUTURE is kept. Clocks differ between clients by seconds, and treating a small negative
     age as staleness would blank the presence of anybody whose machine runs fast -- a failure that looks like
     a network problem and is not. */
  return age <= PRESENCE_STALE_MS;
}

/** The presence worth rendering: fresh, from somebody else, and actually carrying something.
 *
 *  EXCLUDES THE VIEWER, because their own drafts are already in local state and are authoritative there. A
 *  viewer reading their own routes back off the wire would see them lag their own clicks by a publish
 *  interval, which reads as the app being slow. */
export function visiblePresence(
  entries: readonly PresenceState[],
  viewerId: string | null,
  now: number,
): PresenceState[] {
  return entries.filter(
    (entry) =>
      entry.playerId !== viewerId &&
      isPresenceFresh(entry, now) &&
      Object.keys(entry.routeDrafts ?? {}).length > 0,
  );
}

/** Whether this client should publish route drafts at all.
 *
 *  Design note #740, rule 2. Four players idling on the Routes step would otherwise broadcast four sets of
 *  drafts, and the one that matters would be indistinguishable from three that do not. */
export function shouldPublishRoutes(input: {
  isMyTurn: boolean;
  orSubPhase: string | null;
  inRoom: boolean;
}): boolean {
  return input.inRoom && input.isMyTurn && input.orSubPhase === "Routes";
}

/** Whether enough time has passed to publish again.
 *
 *  Returns `true` on the FIRST publish (`lastAt === null`), because the opening state of a turn is the one a
 *  watcher most wants and delaying it by the interval would make the feature feel broken before it feels
 *  slow. */
export function shouldPublishNow(lastAt: number | null, now: number): boolean {
  if (lastAt === null) return true;
  return now - lastAt >= PRESENCE_PUBLISH_MS;
}
