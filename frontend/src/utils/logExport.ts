// frontend/src/utils/logExport.ts
//
// ==================================================================
//  DESIGN NOTE 1160: THE LOG IS THE GAME, SO A BUG REPORT SHOULD BE THE LOG
// ==================================================================
//
// REPORTED: "PRR ran for $30 ($3/share). In the Buy Trains phase, they hit Undo. The game returned to the
// Dividends phase, but the button showed 'Pay Dividends ($1/share)'."
//
// AND IT COULD NOT BE FOUND BY READING. Five candidate mechanisms were ruled out by running the reducer --
// the accumulator preserves the figure through `DeclareDividends`, `AdvanceOperatingSubPhase` and a fresh
// replay; the revenue die spans 80-120% and cannot reach a third; `appendSandboxAction` is a transaction on a
// shared counter so new appends cannot collide; #934 removed the shell's revenue cache; and the reporter
// later established there was ONE train and no route worth $10 at all. `perShare` is `floor(revenue / 10)`,
// so the panel was reading $10-$19: a figure that never existed on that turn.
//
// WHICH MEANS THE STATE WAS RIGHT AND ONE RENDER WAS WRONG, or the replayed history was not the history that
// was played. Both are questions about a specific log, and #522's "the log is the game" cuts the other way
// too: given the entries, the failing turn is exactly reproducible in a test. Without them it is a guess.
//
// SO THIS IS A REPORTING TOOL, NOT A DIAGNOSTIC ONE. It takes no view about what went wrong; it hands over
// the one artefact that can settle it.
//
// IT FLAGS DUPLICATE INDICES BECAUSE THAT IS THE ONE FAULT THE EXPORT CAN SEE BY ITSELF, and it is a live
// suspect: `effectiveActions` kills a revert's range by INDEX (`other.index >= target`), while #1026 made
// only the revert's own identity an id. So two entries sharing an index are still undone together -- and
// #1026's own report was a room that "rolled back to a much earlier state" for exactly that reason. A log
// with no duplicates rules the whole family out in one glance.

import type { SandboxAction } from "./sandboxRoom";

export interface SandboxLogExport {
  capturedAt: string;
  roomCode: string | null;
  /** Entries sharing an index -- empty on a healthy log. See the note above for why this is worth naming. */
  duplicateIndices: number[];
  actionCount: number;
  actions: ReadonlyArray<{
    index: number;
    id: string;
    actor: string;
    derived: boolean;
    at?: number;
    /* ==================================================================
        DESIGN NOTE 1188: THE EXACT BYTES, BECAUSE SETTLEMENT WILL HASH THEM
       ==================================================================
       ADDED, and `msg` is deliberately left exactly as it was beside it.
       THIS EXPORT USED TO CARRY ONLY THE PARSED FORM, and the headless replay harness found what that costs:
       every consumer that reads an entry the way the app reads one -- `revertTargetOf`, `seedAlreadyRolled`,
       the replay itself -- looks for `payload` and got `undefined`. They do not throw on that; they quietly
       do nothing. The `RevertTo` at index 20 of `JUNO-3XD` replayed as a no-op until the harness noticed.
       AND IT MATTERS FAR BEYOND A HARNESS. `SandboxAction.payload` is JSON TEXT rather than a nested map
       (`sandboxRoom.ts` #1: Firestore rejects nested arrays and `RunManualRoute.path` is one), which means
       the bytes are stringified ONCE by the dispatching client and distributed verbatim to everyone. That
       accident is what makes an append-only log hashable without a canonicalisation scheme -- there is no
       re-serialisation anywhere in the system, so there is no key-ordering or number-formatting drift to
       guard against.
       THE SETTLEMENT COMMITMENT IS TAKEN OVER THESE STRINGS. So an export that dropped them left a player
       unable to recompute the hash from the artefact they were handed, which is the entire purpose of
       letting them export one. `JSON.stringify` of a reparsed object is USUALLY identical and is not
       guaranteed to be, and "usually" is the failure that surfaces on one browser months later.
       AUTHORITATIVE, WITH `msg` AS THE COURTESY. When the two disagree, `payload` is the game. */
    payload: string;
    /** Parsed where it parses, so the export is readable; the raw string is kept when it does not.
     *  DERIVED FROM `payload` AND NEVER ALONGSIDE IT -- see #1188 above. A convenience for human eyes. */
    msg: unknown;
  }>;
}

/** Indices carried by more than one entry, ascending. */
export function duplicateIndicesIn(actions: readonly SandboxAction[]): number[] {
  /* A plain object rather than a Map: this file builds to es5, where spreading `Map.entries()` needs
     `downlevelIteration` -- the same target constraint `logRevert.ts` records against `findLast`. */
  const counts: Record<number, number> = {};
  for (const action of actions) counts[action.index] = (counts[action.index] ?? 0) + 1;
  return Object.keys(counts)
    .map((key) => Number(key))
    .filter((index) => (counts[index] ?? 0) > 1)
    .sort((left, right) => left - right);
}

export function buildSandboxLogExport(
  actions: readonly SandboxAction[],
  roomCode: string | null,
  now: () => Date = () => new Date(),
): SandboxLogExport {
  return {
    capturedAt: now().toISOString(),
    roomCode,
    duplicateIndices: duplicateIndicesIn(actions),
    actionCount: actions.length,
    /* SORTED BY INDEX, THEN BY ID, which is `sortActions`' own order -- an export that presented the entries
       in a different sequence from the one the app replays would be describing a different game. */
    actions: [...actions]
      .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
      .map((action) => {
        let msg: unknown = action.payload;
        try {
          msg = JSON.parse(action.payload);
        } catch {
          /* Kept as the raw string. An entry this app cannot parse is exactly the kind worth seeing. */
        }
        return {
          index: action.index,
          id: action.id,
          actor: action.actor,
          derived: action.derived,
          ...(action.at === undefined ? {} : { at: action.at }),
          /* #1188: VERBATIM, and never rebuilt from `msg`. The whole value of this field is that nothing
             between the dispatching client and the reader has re-encoded it. */
          payload: action.payload,
          msg,
        };
      }),
  };
}
