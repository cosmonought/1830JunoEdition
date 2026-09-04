// frontend/src/utils/marketStack.ts
//
// ==================================================================
//  DESIGN NOTE 1159: THE PILE, IN THE ORDER THE GAME ALREADY PLAYS IT
// ==================================================================
//
// REPORTED: "in the physical game, corporation tokens stack when they occupy the same cell, with new entrants
// taking the bottom of the stack -- play then happens top-to-bottom. There is no such stack happening on our
// cells, the corporation markers are simply scattered around it. I think we need to stack them in a line with
// overlapping edges: mousing over one (or clicking on touch devices) should lift it out of the stack to see
// which it is."
//
// THE ORDER WAS NEVER MISSING, ONLY UNDRAWN. #646 stamps an arrival ordinal on every landing, derived from
// the marks already on the chart rather than from a clock so that a replay reaches the same numbers; #647
// sorts the operating order by price, then rightmost column, then arrival ascending. That is the rule the
// report states, and the engine has been using it. The board scattered because `sandboxMarketPositions` was
// dropping the field before the renderer could see it (#1159's other half).
//
// SO THIS FILE IS A SORT, NOT A RULE. It must not become a second opinion about turn order -- #891 -- so it
// orders by exactly the key the cursor does and nothing else. Two functions computing one order is how the
// picture comes to disagree with whose turn it actually is.
//
// EARLIEST ON TOP, which is what "first in, first out" means once it is drawn: the token that has been in the
// cell longest operates first, so it is the one a reader's eye should reach first, and a new entrant slides
// underneath. The physical board does this with cardboard and gravity.
//
// A CHAIN THAT SENDS NO ORDINAL still gets a stable pile: `Infinity` sorts an unrecorded arrival after every
// recorded one -- #647's own choice, restated here rather than invented -- and `company_id` breaks the
// remaining tie so every client draws the same stack from the same data.

/** The minimum a caller must have; both the chart's and the preview's entries satisfy it structurally. */
export interface StackableToken {
  company_id: number;
  enteredAt?: number;
}

/** Same-cell tokens, earliest arrival first. Index 0 draws on TOP. */
export function stackOrder<T extends StackableToken>(tokens: readonly T[]): T[] {
  return [...tokens].sort((a, b) => {
    const left = Number.isFinite(a.enteredAt as number) ? (a.enteredAt as number) : Infinity;
    const right = Number.isFinite(b.enteredAt as number) ? (b.enteredAt as number) : Infinity;
    if (left !== right) return left - right;
    return a.company_id - b.company_id;
  });
}

/** How far each token in a pile of `count` is offset from the cell's centre, so the group stays centred as it
 *  grows. A fraction of the diameter, so the overlap reads as a stack at any token size. */
export const STACK_OVERLAP = 0.42;

export function stackOffset(index: number, count: number, diameterPx: number): number {
  const step = diameterPx * STACK_OVERLAP;
  const span = step * (count - 1);
  return index * step - span / 2;
}
