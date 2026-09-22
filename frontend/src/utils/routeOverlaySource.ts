// frontend/src/utils/routeOverlaySource.ts
//
// [PRESENTATION CORRECTION]: who may draft, and whose draft the board shows.
//
// ==================================================================
//  WHY THIS EXISTS
// ==================================================================
//
// REPORTED (by audit, not by a player): an Operating Round's Run Routes step has exactly one operating
// corporation, but the map's route-drafting machinery did not enforce that. `routeSelectMode` armed the
// canvas's click handler on every connected client the instant the round reached the Routes sub-phase, with
// no `isMyTurn` gate -- so a watcher's stray click (or the "draft once on arrival" auto-route effect, which
// had the same gap) could write a LOCAL route draft on that watcher's own client. Because the map overlay
// then drew local state unconditionally, a watcher's own idle click could paint a phantom line in the
// operating corporation's own colour, indistinguishable from the real thing, on the clicker's own screen.
//
// Separately, and independently, the map overlay appended every fresh presence entry it could see rather
// than the one entry that actually matters -- the operating corporation's own -- which is exactly the
// disagreement `watcherRouteChips.ts` (the chip row) had already been corrected for (#1386's note there: "the
// map draws every visible entry's drafts, the chips only the entry whose `actingCompanyId` matches").
//
// THE FIX IS TWO SMALL, PURE PREDICATES, so App.tsx's several arming effects and its map overlay read the
// SAME answer rather than three independent guesses at it:
//
//   `isRouteBuilderArmed` -- may THIS client edit a route draft right now?
//   `selectActingPresenceEntry` -- if not, whose presence, if anyone's, should THIS client display?
//
// Extracted rather than inlined for the same reason `routeDraftEdit.ts` (#882) and `watcherRouteChips.ts`
// (#875) were: a decision buried in a React effect or a `useMemo` body can only be tested by mounting the
// whole shell, and a decision this load-bearing -- who gets to move a piece on the board -- deserves to be
// arithmetic instead.

/** The shape `selectActingPresenceEntry` needs from a presence document. Structurally typed rather than
 *  importing `PresenceState` so this module has no dependency on the transport, only on the two fields the
 *  decision actually reads. */
export interface ActingPresenceCandidate {
  readonly actingCompanyId?: number | null;
  readonly routeDrafts?: Readonly<Record<number, unknown>> | null;
}

/** Whether the canvas's route-drafting click handler -- and the "draft once on arrival" auto-route effect
 *  that seeds it -- should be armed for THIS client.
 *
 *  ONLY THE CLIENT WHOSE TURN IT ACTUALLY IS may create or edit a local route draft. Every other client --
 *  a watching player, or a spectator -- must have a read-only map for route purposes, even while the round
 *  sits in its Routes sub-phase; there is no gameplay reason for a second, non-operating client to be able to
 *  produce a competing draft at all, phantom or otherwise. */
export function isRouteBuilderArmed(input: {
  readonly inRunTrainsSubPhase: boolean;
  readonly isMyTurn: boolean;
}): boolean {
  return input.inRunTrainsSubPhase && input.isMyTurn;
}

/** The one presence entry worth showing anybody during Run Routes: whoever is publishing drafts for the
 *  corporation actually operating right now. Returns `null` when nobody is -- the ordinary case at the start
 *  of the step, and the correct answer when several unrelated entries exist but none of them is the acting
 *  corporation's.
 *
 *  `actingCompanyId` IS THE PRIMARY KEY. The fallback below predates this correction (#1386): an older or
 *  malformed presence document can omit `actingCompanyId` entirely. An Operating Round has exactly one
 *  drafter, so if nothing names the corporation but exactly one entry is drafting anything at all, that
 *  entry IS the drafter. With zero or more than one such ambiguous candidate, the honest answer is `null` --
 *  guessing among several would be exactly the "malformed/stale presence entry ... should not produce a
 *  route line" failure this module exists to rule out.
 *
 *  SHARED, NOT RECOMPUTED, by every reader of presence during Run Routes (the chip row in
 *  `watcherRouteChips.ts`'s caller, and the map overlay in `App.tsx`'s `manualRouteOverlay`), so the board
 *  and the chips can never end up naming two different drafts for the same train index. */
export function selectActingPresenceEntry<T extends ActingPresenceCandidate>(
  entries: readonly T[],
  actingProtocolId: number | null,
): T | null {
  const named = entries.find((entry) => entry.actingCompanyId === actingProtocolId);
  if (named) return named;
  // The fallback is for an entry that names NO corporation at all (a legacy client, or a write that raced
  // the `actingCompanyId` field being set). An entry that explicitly names a DIFFERENT corporation is not
  // ambiguous -- it has already answered the question, just not with the answer this reader wants -- so it
  // must never be picked up here even when it is the only thing drafting. Without this guard a single
  // stray/rival entry for corporation B would render as corporation A's route on corporation A's turn,
  // which is precisely the "malformed/stale presence entry ... should not produce a route line" failure
  // this module exists to rule out.
  const unlabelledDrafting = entries.filter(
    (entry) =>
      (entry.actingCompanyId === null || entry.actingCompanyId === undefined) &&
      Object.keys(entry.routeDrafts ?? {}).length > 0,
  );
  return unlabelledDrafting.length === 1 ? unlabelledDrafting[0] : null;
}
