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
import { derivePhase } from "./gamePhase";
import type { TileColorTier } from "../components/hexTileCatalog";
import type { GameStateResponse } from "./gameState";
import { resolveVariants, type GameVariants } from "./gameVariants";

/* Design note #354: the two identifiers tying the B&O private to the B&O
   corporation. Named constants rather than inline literals because they are a
   CROSS-TABLE join -- private #6 in `auction.rs`'s roster is the same company as
   ticker "B&O" in `public_company.rs`'s -- and a bare `6` at the join site reads
   as an arbitrary index. */
export const BO_PRIVATE_ID = 6;
export const BO_TICKER = "B&O";

/** The Schuylkill Valley -- the cheapest private, and the ONLY one the all-pass markdown touches.
 *
 *  ==================================================================
 *   DESIGN NOTE 1580: THE MARKDOWN IS THE SV's, NOT THE CHEAPEST'S (Batch 7.3, audit C5)
 *  ==================================================================
 *  Rulebook §1.2.3 names it: "if all players pass and the Schuylkill Valley is unsold, reduce its price by
 *  $5"; and, separately, "if all players pass and the Schuylkill Valley HAS been sold, each of the private
 *  companies already bought pays revenue". The engine read both halves as "whichever private is currently
 *  lowest", which marked the B&O down 220 -> 215 in JUNO-Z6C and the James River & Kanawha down 120 -> 115
 *  under the Level Playing Field, and paid private income on every all-pass whether the SV was sold or not.
 *  NAMED HERE beside `BO_PRIVATE_ID` for its reason: this is the same kind of CROSS-TABLE join -- private #1
 *  in the auction's roster is the Schuylkill Valley in the catalog -- and a bare `1` at the rule site reads
 *  as an arbitrary index. Owner ruling D-21 (Q8): the LPF's extra private does not inherit the markdown. */
export const SV_PRIVATE_ID = 1;

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

/* ==================================================================
    DESIGN NOTE 1312: THE ERA IS A FUNCTION OF THE PHASE AND THE TABLE'S RULES
   ==================================================================
   `ERA_FOR_PHASE_TINT[phase.tint]` was the whole answer while every game had three eras. The Project 18XX+
   tile set adds a fourth: "Phase D (Gray)", opened by the first D-train, in which brown tiles upgrade to
   gray. So the era is asked of the phase AND the variants, in one place, and the twelve call sites that
   used to index the table by tint ask this instead -- a call site that still indexed the table would put a
   tile-set game in Brown for its whole Diesel era, and nothing would look wrong until a gray tile was
   refused. The tint itself stays three-valued: it colours the phase badge, and a gray-tinted badge for the
   Diesel era is a separate decision nobody has asked for. */
export function eraForPhase(
  phase: { tier: string; tint: PhaseTint } | null | undefined,
  variants: Pick<GameVariants, "plusTiles">,
): TileColorTier {
  if (phase?.tier === "D" && variants.plusTiles) return "Gray";
  return ERA_FOR_PHASE_TINT[phase?.tint ?? "yellow"];
}

/** The tile era this state is in -- `eraForPhase` over the state's own phase and variants. */
export function tileEraFor(state: GameStateResponse | null | undefined): TileColorTier {
  return eraForPhase(derivePhase(state ?? null), resolveVariants(state?.variants));
}

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
