// The named game constants from `App.tsx`, moved unchanged.
//
// Each is a value with a REASON -- a cross-table join, a rules threshold, a
// fixed piece of copy -- and each keeps the note that records it. They were
// scattered through `App.tsx`'s preamble, some several declarations away from
// the comment explaining them.
//
// `MOCK_*` fixtures deliberately did NOT come here. Mixing "this is the rule"
// with "this is a placeholder until the query lands" is exactly the confusion
// that lets a placeholder become permanent; they live in `mockFixtures.ts`,
// where the filename is the warning.

import type { PhaseTint } from "./gamePhase";
import type { TileColorTier } from "../components/hexTileCatalog";

/* Design note #354: the two identifiers tying the B&O private to the B&O
   corporation. Named constants rather than inline literals because they are a
   CROSS-TABLE join -- private #6 in `auction.rs`'s roster is the same company as
   ticker "B&O" in `public_company.rs`'s -- and a bare `6` at the join site reads
   as an arbitrary index. */
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
 *  `TIER_PRESENTATION` assigns (Phase 2 yellow; Phases 3-4 green; Phases 5/6/D
 *  brown), so this is a case change rather than a second opinion. A table rather
 *  than a string cast, so a fourth `PhaseTint` fails to compile here instead of
 *  silently producing a `TileColorTier` that does not exist. */
export const ERA_FOR_PHASE_TINT: Readonly<Record<PhaseTint, TileColorTier>> = {
  yellow: "Yellow",
  green: "Green",
  brown: "Brown",
};

/** The corporation a `BuyStock` message is about, or `null` for any other
 *  message.
 *
 *  Design note #398: the sandbox reducer needs a par price, and the only honest
 *  source is the company named in the message it is reducing. A helper rather
 *  than an inline cast so the shape assumption -- `BuyStock.protocol_id` -- is
 *  written down once and can be tested directly. */
export function buyStockProtocolId(msg: unknown): number {
  const buy = (msg as { BuyStock?: { protocol_id?: unknown } } | null)?.BuyStock;
  const id = buy?.protocol_id;
  return typeof id === "number" ? id : -1;
}
