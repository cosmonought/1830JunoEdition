import type { GameStateResponse, PublicCompanyState } from "./gameState";
/* Design note #1631 (Slice 8.4, S8-10): the capitalisation debit, for `applyFloatThreshold` below. The
   edge is one-way -- `cashLedger.ts` reads only `gameState.ts` and `endgame.ts` -- so the float settlement
   can live beside the measure it settles without the reducer having to own it. */
import { debitBank } from "./cashLedger";

/* ==================================================================
 *  DESIGN NOTE 749: FLOATING IS ABOUT THE IPO, NOT ABOUT PLAYERS' HANDS
 * ==================================================================
 *
 * REPORTED: "when fewer than 60% of a corporation's shares are in player hands, there's a text string that
 * appears on the corporation card: 'Floated flag set at 40% sold, 60% expected.' I don't know what this
 * means, but floating is only contingent on 60% of shares being out of the IPO; if there are 20% in IPO, 20%
 * in player, and 60% in market, that corporation is floated and operational the same as a corporation with
 * 40% in IPO and 60% in player."
 *
 * THE LABEL WAS THE VISIBLE END OF A RULE ERROR IN BOTH AUTHORITIES. Three places computed the float
 * condition and all three asked how much sat in PLAYERS' HANDS:
 *
 *   sandboxSession.applyFloatThreshold   sum of `player_holdings` >= 60
 *   trading.rs execute_buy_stock         `total_player_owned` >= 60
 *   StockRoundPanel.metFloatThreshold    100 - ipo - bank >= 60
 *
 * The third is what printed the message. The first two decide whether a corporation floats at all.
 *
 * WHY THE TWO MEASURES USUALLY AGREE, and why that hid it: shares leave the IPO by being bought, so early on
 * "out of the IPO" and "in players' hands" are the same number. They part company the first time anybody
 * SELLS, because sold shares go to the Bank Pool -- out of the IPO forever, and out of players' hands.
 *
 * SO THE BUG IS REACHABLE AND NOT ONLY COSMETIC. Buy 50% from the IPO (no float), sell 20% into the pool, buy
 * 10% more: 60% has now left the IPO and the corporation must float, while `player_holdings` totals 40% and
 * the old rule refused. A corporation that should be operating sits unfloated with no way to fix itself
 * except somebody buying the rest of a pool they may not want.
 *
 * THE MEASURE IS ALSO THE RIGHT SHAPE FOR A LATCH. `is_floated` never goes back off, and 1830 has no path
 * that returns a share to the IPO -- sales go to the Bank Pool -- so `100 - ipo` only ever rises. The
 * players-hands figure falls on every sale, which means the old rule was a latch computed from a quantity
 * that moves both ways. That mismatch is the same defect stated structurally.
 */

/** 1830's float condition: sixty percent out of the IPO. */
export const FLOAT_THRESHOLD_PERCENT = 60;

/** Design note #376: full capitalisation pays ten times par. */
export const FULL_CAPITALISATION_MULTIPLE = 10;

/** How much of this corporation has left the IPO -- bought by players, and still theirs or since sold on
 *  into the Bank Pool. THE FLOAT MEASURE.
 *
 *  Named for what it measures rather than for what it decides, because the previous pair of functions were
 *  both called `soldToPlayersPercent` in two files, computed the same wrong thing two different ways, and
 *  read as obviously correct in both. */
export function soldFromIpoPercent(company: Pick<PublicCompanyState, "ipo_pool_percentage">): number {
  const ipo = Number(company.ipo_pool_percentage);
  if (!Number.isFinite(ipo)) return 0;
  return Math.max(0, Math.min(100, 100 - ipo));
}

/* ==================================================================
 *  DESIGN NOTE 1148: THE FLOAT LINE, IN MONEY
 * ==================================================================
 *
 * ASKED: "when a player is parring a company, it would be highly useful to know the dollar amount required to
 * float."
 *
 * AND THE USEFUL MOMENT IS WHILE THEY ARE CHOOSING, which is what decided where this goes rather than what it
 * computes. The par ladder is a row of prices and every rung implies a different float cost -- $67 asks $402
 * of the table, $100 asks $600 -- so the figure is not a readout that happens to sit near the control, it is
 * the consequence the control is choosing between. 1830's actual tension, stated: a high par capitalises the
 * corporation richly and makes it harder to get off the ground.
 *
 * PRICED IN 10% BLOCKS, WHICH IS WHY THIS IS ARITHMETIC AND NOT A TABLE. Every share costs par per 10%,
 * including the president's 20% certificate at twice par -- so the money that must cross the table to move
 * `soldFromIpoPercent` to sixty is just the gap in blocks times the price, and the certificate sizes never
 * enter into it. `FLOAT_THRESHOLD_PERCENT` is read rather than repeated, so a variant that floats at a
 * different mark moves this with it.
 *
 * WHOSE MONEY IT IS, STATED HERE BECAUSE THE CALLERS KEEP ASKING: not the parring player's alone. They buy
 * the president's 20% and the remaining 40% must be bought by ANYBODY, themselves included, over following
 * turns. `remaining` is therefore a figure about the CORPORATION, not a bill presented to one player, and a
 * caller that words it as "you need" would be lying about it.
 */
export function floatCostIn(par: number, soldFromIpo: number): {
  /** What sixty percent of this corporation costs at this par -- the whole float, from an empty IPO. */
  total: number;
  /** What is still to be bought. Zero once the threshold is met, never negative. */
  remaining: number;
} {
  if (!Number.isFinite(par) || par <= 0) return { total: 0, remaining: 0 };
  const blocks = FLOAT_THRESHOLD_PERCENT / 10;
  const soldBlocks = Math.max(0, Math.min(blocks, soldFromIpo / 10));
  return { total: blocks * par, remaining: Math.round((blocks - soldBlocks) * par) };
}

/** How much sits in players' hands right now. NOT the float measure -- kept because the roster pill and the
 *  ledger legitimately want it, and separated so the next reader has to choose between two named quantities
 *  rather than assume one. */
export function heldByPlayersPercent(company: Pick<PublicCompanyState, "player_holdings">): number {
  return company.player_holdings.reduce((sum, entry) => sum + entry.percentage, 0);
}

/** Whether this corporation has met the 60% condition.
 *
 *  `false` alongside `is_floated === true` is a CONTRADICTION rather than a second way of floating -- design
 *  note #445, unchanged. What #749 changes is which arithmetic gets to call it one. */
export function metFloatThreshold(
  company: Pick<PublicCompanyState, "ipo_pool_percentage">,
): boolean {
  return soldFromIpoPercent(company) >= FLOAT_THRESHOLD_PERCENT;
}

/* ==================================================================
    DESIGN NOTE 1631 (Slice 8.4, S8-10): THE FLOAT SETTLEMENT LEAVES THE `BuyStock` ARM
   ==================================================================
   MOVED HERE VERBATIM FROM `sandboxSession.ts` (#363/#376/#416/#749/#1560), not rewritten: every line below
   is the function the reducer has been running, and `sandboxSession.ts` re-exports it so no importer changes.

   WHY IT MOVED. #363's comment said "buying is the only action that can cross the float threshold, so the
   check rides on it", and Slice 8.4 makes that false: the M&H exchange takes a 10% certificate out of the
   NYC's IPO, which is exactly the quantity `soldFromIpoPercent` measures (#749). An exchange that floated
   nothing would leave a corporation 60% out of the IPO and unfloated -- the defect S8-10 records on JUNO-3XD
   288, where the stored exchange takes the IPO from 50% to 40% and NYC floats one entry later on a purchase.

   FACTORED RATHER THAN COPIED, on this project's oldest rule: a second float rule in `mohawkExchange.ts` is
   #1184's drift with a new name, and this one carries the capitalisation debit, the latch and the
   `debitBank` refusal with it. `buildOperatingOrder` (#1530) and `syncSeatToActingCorporation` (#1600) left
   the reducer the same way and for the same reason -- a module the reducer imports cannot import the reducer.
   ORDINARY `BuyStock` IS UNCHANGED BY CONSTRUCTION: the arm still calls the same function with the same
   argument, and `floatThreshold.test.ts` / `boFloatRule.test.ts` still import it from `sandboxSession`. */
/** Floats every corporation over the threshold. Returns the SAME state when nothing changed so callers can skip on identity. homeHexToAxial is injected (utils/ must not import components/).
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #416 */
export function applyFloatThreshold(
  state: GameStateResponse,
  homeHexToAxial: (label: string) => readonly [number, number] | null,
): GameStateResponse {
  let changed = false;
  // Design note #376: what the bank pays out this pass, in one debit.
  let capitalised = 0;

  const companies = state.public_companies.map((company) => {
    if (company.is_floated) return company;
    /* Design note #749: OUT OF THE IPO, not in players' hands. This read the sum of `player_holdings`, which
       is the same number until somebody sells and permanently smaller afterwards -- so a corporation whose
       shares had reached 60% out of the IPO by way of the Bank Pool never floated, and had no way to. */
    if (!metFloatThreshold(company)) return company;

    changed = true;

    /* Design note #376: ten times par, into a treasury that was empty. Added
       to whatever is there rather than assigned, so a company that somehow
       already holds money is not silently reset by floating. */
    const par = Number(company.par_value);
    const capital =
      Number.isFinite(par) && par > 0 ? par * FULL_CAPITALISATION_MULTIPLE : 0;
    capitalised += capital;
    const treasury = String((Number(company.treasury) || 0) + capital);

    /* The token is PROMPTED, not placed: the prompt is not asking which hex, it is making the player witness the placement. homeHexToAxial still decides whether a home hex RESOLVES.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #416 */
    return { ...company, is_floated: true, treasury };
  });

  if (!changed) return state;
  /* Design note #376: one debit for the whole pass, for the same reason design note #329's payout banks once.
     #1560: the reason has changed from "several calls would floor differently" to "several calls would latch
     at different moments"; the shape is the same and so is the arithmetic. The treasuries above were credited
     in the map, so this debit is the matching half and the pass conserves. A refused debit floats nobody --
     a corporation capitalised out of a bank that never paid would be the mint this batch exists to end. */
  const capitalisation = debitBank({ ...state, public_companies: companies }, capitalised);
  return capitalisation.ok ? capitalisation.state : state;
}
