// frontend/src/utils/gameConstants.ts
//
// THE NAMED GAME CONSTANTS from `App.tsx`, moved unchanged.
//
// Each of these is a value with a REASON -- a cross-table join, a rules
// threshold, a fixed piece of copy -- and each keeps the design note that
// records the reason. They were scattered through `App.tsx`'s preamble, some
// with their explanatory comment sitting several declarations away from the
// value it explains; the move puts each note back against its own constant
// without editing a word of either.
//
// `MOCK_*` fixtures deliberately did NOT come here. Those are stand-ins for
// data the chain will eventually supply, and mixing "this is the rule" with
// "this is a placeholder until the query lands" is exactly the confusion that
// lets a placeholder become permanent. They live in `mockFixtures.ts`, where
// the filename is the warning.

import type { PhaseTint } from "./gamePhase";
import type { TileColorTier } from "../components/hexTileCatalog";

/* Design note #354: the two identifiers that tie the B&O private to the
   B&O corporation. Named constants rather than inline literals because
   they are a CROSS-TABLE join -- private #6 in `auction.rs`'s roster is the
   same company as ticker "B&O" in `public_company.rs`'s -- and a bare `6`
   at the join site reads as an arbitrary index. */
export const BO_PRIVATE_ID = 6;
export const BO_TICKER = "B&O";

/** Design note #250: one sentence, three refusal sites. Stated once so the
 *  builder, the auto-drafter and the dispatch cannot describe the same
 *  situation three slightly different ways. */
export const NO_TRAIN_ROUTE_REASON =
  "This corporation owns no trains, so it has no route to run. Buy a train in the Buy Trains step first.";

/** Design note #285: the cap for a train this build's catalog does not
 *  know. The smallest real train in 1830, so an unknown model is refused
 *  where a 2-train would be rather than being uncapped. */
export const SMALLEST_TRAIN_CAPACITY = 2;


/** `GamePhase.tint` -> the tile tier that phase has unlocked.
 *
 *  `tint` is already the exact three-value era `gamePhase.ts`'s
 *  `TIER_PRESENTATION` assigns (Phase 2 yellow; Phases 3-4 green; Phases
 *  5/6/D brown), so this is a case change rather than a second opinion about
 *  which era it is. Written as a table anyway rather than a string cast, so
 *  a fourth `PhaseTint` would fail to compile here instead of silently
 *  producing a `TileColorTier` that does not exist. */
export const ERA_FOR_PHASE_TINT: Readonly<Record<PhaseTint, TileColorTier>> = {
  yellow: "Yellow",
  green: "Green",
  brown: "Brown",
};
