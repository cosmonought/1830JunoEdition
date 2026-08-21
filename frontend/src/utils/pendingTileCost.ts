// frontend/src/utils/pendingTileCost.ts
//
// What a previewed tile lay will cost, and what it leaves behind.
//
// Design note #673: SHOW THE CONSEQUENCE, NOT THE PRICE.
//
// REQUESTED: "when Lay Track, it might be helpful if the corporation's treasury
// reflected the end-result of the track lay."
//
// The price was already on screen -- `HexGridRenderer` #136 prints the terrain
// fee as a badge on every unbuilt river and mountain hex, from this same
// lookup. And the lay was already confirmed: the radial selector's previewing
// stage puts a tick and a cross above the hex (`RadialTileSelector` #2). What
// neither of them answered is the question a president actually has, which is
// not "what does this hex cost" but "what am I left with" -- because the next
// step in the same turn may be a $450 train.
//
// So this computes the RESULT. The fee comes from `terrainBuildFeeAt`, the
// coordinate-keyed mirror of `hexmap::terrain_build_fee` -- the same lookup the
// board badge reads and the same one the reducer charges (`sandboxSession.ts`
// #432), so the projection, the badge and the debit cannot disagree.
//
// THE ONE RULE WORTH STATING: THE GROUND IS CHARGED ONCE. `execute_lay_tile`
// bills terrain on the FIRST build only, which is why the board badge
// disappears once a hex carries a tile. An upgrade onto an already-built
// mountain is free, and a projection that charged $120 for it would be
// confidently wrong about the one number it exists to report.
//
// PURE, and separate from both surfaces that render it: two components showing
// one figure is how the two come to show different figures.
//
// See docs/ai_architecture/hex_tile_math.md, pendingTileCost.ts #673.

import { terrainBuildFeeAt } from "../components/hexBoardData";
import { hexHasLaidTile } from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";

export interface PendingTileCost {
  /** What the lay will cost. `0` for clear ground and for an upgrade, which
   *  are different reasons for the same figure and both genuinely free. */
  fee: number;
  /** The treasury as it stands. `null` when it is not known -- offline, or
   *  before the first poll. */
  before: number | null;
  /** What it will be afterwards. `null` whenever `before` is: an unknown
   *  balance minus a known fee is still unknown, and rendering `-$80` there
   *  would be a figure no corporation has. */
  after: number | null;
  /** Whether the treasury cannot cover this. Reported, NOT enforced --
   *  1830's rules about an unaffordable lay belong to the contract, and this
   *  module's job is to say what the player is looking at. */
  short: boolean;
}

/** The cost of laying on `(q, r)`, given the board and the acting treasury.
 *
 *  `treasury` is `number | null` rather than defaulted to zero for the reason
 *  `playerFinance.ts` #562 gives about an em dash: a balance nobody has read
 *  and a balance of nothing are different facts, and only one of them means
 *  the corporation is broke. */
export function pendingTileCost(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  treasury: number | null,
): PendingTileCost {
  // Design note #673: charged once, on the first build. An upgrade is free.
  const fee = hexHasLaidTile(mapGrid, q, r) ? 0 : terrainBuildFeeAt(q, r);
  const before = treasury === null || !Number.isFinite(treasury) ? null : treasury;
  const after = before === null ? null : before - fee;
  return { fee, before, after, short: after !== null && after < 0 };
}

/** "$1000 → $920", or `null` when there is nothing pending to say.
 *
 *  `null` for a free lay as much as for an unknown treasury: "$1000 → $1000" is
 *  an arrow pointing at itself, and a reader who sees one on a clear hex learns
 *  that the arrow means nothing.
 *
 *  A REAL ARROW, not `->`. The two are a glyph apart and only one of them reads
 *  as a transition rather than as a typo -- the same reasoning `cashDelta.ts`
 *  applies to its minus sign. */
export function formatPendingTreasury(cost: PendingTileCost): string | null {
  if (cost.fee <= 0 || cost.before === null || cost.after === null) return null;
  return `$${cost.before} → $${cost.after}`;
}

/** The sentence the confirm step says, or `null` for a free lay.
 *
 *  Names the FEE and the remainder together, because the two answer different
 *  questions and the player is about to press a button that settles both. */
export function describePendingTileCost(cost: PendingTileCost): string | null {
  if (cost.fee <= 0) return null;
  if (cost.after === null) return `Costs $${cost.fee}`;
  return `Costs $${cost.fee} — treasury $${cost.after} after`;
}
