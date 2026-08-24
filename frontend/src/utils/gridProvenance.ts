import type { MapGridResponse } from "../components/hexContractTypes";

/* ==================================================================
 *  DESIGN NOTE 768: THE BOARD CANNOT LOSE TILES
 * ==================================================================
 *
 * REPORTED: "in OR2.1, when a corporation laid its second track, all of the laid tiles on the board
 * disappeared." Clarified: "I meant its first (and only) tile lay in OR2.1, which was its second tile lay
 * action overall."
 *
 * THE CLARIFICATION KILLED MY DIAGNOSIS. I had read "second track" as two lays in one turn and pinned it on
 * `rebuildSandbox` failing to reset the grid's ref (#767) -- which is a real bug and is fixed, but it needs an
 * Undo to fire, and there was no Undo here. Two lays, two different Operating Rounds, nothing between them
 * that touches the grid. I do not know what emptied it.
 *
 * SO THIS IS AN INSTRUMENT, NOT A FIX, and it says so. Three times this session a theory that fit the symptom
 * was wrong (#746c, #748b, #767-as-diagnosis); the one thing that has reliably worked is measuring rather
 * than reasoning. #750 did this for the phantom $1500 and the answer arrived on the next playthrough.
 *
 * WHAT MAKES IT A GOOD INSTRUMENT is that the invariant is exact rather than heuristic. `applySandboxLayTile`
 * either ADDS a tile to a bare hex or REPLACES the one already there. So across any single message the tile
 * count may rise by one or stay the same, and it may never fall. A fall is unconditionally a bug, whatever
 * the message and whatever the cause -- there is no legitimate path that removes a laid tile from this board.
 *
 * THE RESET IS THE ONE EXCEPTION and it is deliberately not routed through here: `rebuildSandbox` empties the
 * grid on purpose, and it logs that separately. A reset that fires when nobody asked for one is exactly the
 * kind of thing worth being able to see in the log, so it gets its own line rather than an exemption.
 */

export interface GridChange {
  from: number;
  to: number;
  cause: string;
  /** `true` when no rule accounts for the change -- see the invariant above. */
  unexplained: boolean;
}

const tileCount = (grid: MapGridResponse | null | undefined): number => grid?.tiles?.length ?? 0;

/** What this message did to the tile count, or `null` when it did nothing.
 *
 *  SILENT ON A NO-OP, because most messages do not touch the board and a line per message would bury the one
 *  line worth reading. */
export function describeGridChange(
  msg: unknown,
  before: MapGridResponse | null | undefined,
  after: MapGridResponse | null | undefined,
  cause: string,
): GridChange | null {
  const from = tileCount(before);
  const to = tileCount(after);
  if (from === to) return null;

  const isLay = typeof msg === "object" && msg !== null && "LayTile" in (msg as object);
  /* A lay may add exactly one. Everything else -- a fall, a jump, a change on any other message -- is
     unaccounted for. Stated as "what is allowed" rather than "what is suspicious", so a new path has to
     justify itself rather than slip through a gap in a blacklist. */
  const explained = isLay && to === from + 1;

  return { from, to, cause, unexplained: !explained };
}

export function gridChangeLine(change: GridChange): string {
  const delta = change.to - change.from;
  const body =
    delta > 0
      ? `Board now holds ${change.to} tiles (was ${change.from}).`
      : `Board LOST ${Math.abs(delta)} tile${Math.abs(delta) === 1 ? "" : "s"} — ${change.from} → ${change.to}.`;
  return change.unexplained ? `${body} UNEXPLAINED — ${change.cause} should not do this.` : body;
}
