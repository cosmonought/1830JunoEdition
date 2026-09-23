// frontend/src/gameEngine/trainAvailability.ts
//
// Which trains can actually be bought right now, and which one a forced purchase must take.
//
// ==================================================================
//  DESIGN NOTE 1512: ONE ANSWER TO "WHAT IS FOR SALE"
// ==================================================================
//
// THREE SURFACES ANSWERED IT THREE WAYS. The ordinary purchase asked `openDepotTiers` (the printed queue, or
// the open shelf). The forced purchase asked `depotInventory(state).find(remaining > 0)` -- the depot only,
// never the Bank Pool, so a returned $300 4-train would be passed over for a $630 6 (audit M9). The shell's
// emergency plan asked `depotInventory` again with its own filter. Three readings of one shelf, and the
// rulebook has one rule for all of them (6.6, 6.6.2): trains are bought from the Bank, from the Bank Pool at
// face value, or from another corporation; a forced purchase takes "the cheapest available train -- if
// 5-trains, 6-trains and diesels are all on offer, that is a 5-train".
//
// THE BANK POOL IS `returned_trains`. #1314 introduced the list for Diesel trade-ins and called it the depot;
// the rulebook calls the place a traded-in or discarded train goes the Bank Pool, and that is what the list
// is: trains the bank holds that are not printed stock, each purchasable at its printed face value. The name
// stays (every log and fixture carries it); the reading is corrected here.
//
// AND THE DEPOT COUNTS THE POOL, WHICH IT DID NOT. `depotInventory` derives printed stock as `TOTAL - owned`
// (#4), so a train that left a fleet without rusting -- traded in, or discarded to the limit -- came back as
// printed stock as well as sitting in the pool: one physical train, purchasable twice. On the open shelf
// that is a phantom 6. `gamePhase.ts` now subtracts the pooled trains of a tier from its printed remainder,
// so a train is in exactly one place.
//
// WHY THE FORCED PURCHASE IS "CHEAPEST", NOT "THE CURRENT TIER". The reported live case (JUNO-FCJ 716) was a
// forced purchase that bought a 6-train. On that board a 6 was genuinely the cheapest train for sale -- one
// of the two printed 6s was still in the depot, and 6 < 7 < D by price -- so the selection was right, but
// the code that made it was right by coincidence: it took the first depot row with stock, which is the
// cheapest only because the queue is priced in ascending order and only while the pool is empty. This module
// states the rule instead: every purchasable train, priced, and the minimum taken.
//
// ORDERING, EXACTLY: ascending printed face value across the depot's open rows and every pool train. A tie
// between a pool train and a depot train of the same model takes the POOL copy -- the price and the train are
// identical, and buying printed stock for a train the bank already holds loose would shorten the depot's
// countdown for no reason. The rulebook does not distinguish the two, so this is a tie-break, not a rule.
// Nothing here ranks another corporation's trains: 6.6.2 says a cash-strapped corporation "is not required
// to buy another corporation's train merely because it is cheaper", so those are offers, never obligations.

import type { GameStateResponse } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { SandboxLogMsg } from "./gameSetup";
import { depotCostFor, openDepotTiers, pooledTrainsByTier, type TrainTier } from "./gamePhase";
import { operatingCorporationId } from "./dividendGate";
import { hasLegalRouteFor } from "./derivedActions";
import { TRAIN_PURCHASE_SUB_PHASE } from "./trainPurchaseGate";

export interface PurchasableTrain {
  /** Printed stock in the Bank Depot, or a loose train in the Bank Pool. */
  source: "depot" | "pool";
  tier: TrainTier;
  /** Face value -- the only price the bank ever charges. */
  cost: number;
  /** For the depot: printed trains left of this tier (`null` for the unlimited Diesel). For the pool: how
   *  many loose trains of this model the bank holds. */
  remaining: number | null;
}

/** The Bank Pool, one row per model held. */
export function bankPoolTrains(state: GameStateResponse): PurchasableTrain[] {
  return Array.from(pooledTrainsByTier(state).entries()).map(([tier, remaining]) => ({
    source: "pool",
    tier,
    cost: depotCostFor(state, tier),
    remaining,
  }));
}

/** Every train the bank will sell right now: the depot's open rows with stock, then the pool. */
export function purchasableTrains(state: GameStateResponse): PurchasableTrain[] {
  const depot: PurchasableTrain[] = openDepotTiers(state)
    .filter((row) => row.remaining === null || row.remaining > 0)
    .map((row) => ({ source: "depot", tier: row.tier, cost: row.cost, remaining: row.remaining }));
  return [...depot, ...bankPoolTrains(state)];
}

/** The train a forced purchase must take: the cheapest for sale, pool before depot on a tie. `null` only
 *  when the bank has nothing at all -- which a printed game never reaches, since Diesels are unlimited. */
export function cheapestPurchasableTrain(state: GameStateResponse): PurchasableTrain | null {
  const all = purchasableTrains(state);
  if (all.length === 0) return null;
  return [...all].sort(
    (a, b) => a.cost - b.cost || (a.source === "pool" ? 0 : 1) - (b.source === "pool" ? 0 : 1),
  )[0];
}

/* ==================================================================
    DESIGN NOTE 1513: THE OBLIGATION IS A FACT ABOUT THE BOARD, AND THE BOARD REFUSES ON IT
   ==================================================================
   RULEBOOK 6.6.2: a corporation with a legal train route and no train at the end of its Operating Turn must
   immediately purchase one; without a legal route it need not. The shell has enforced this since #751 by
   disabling End Turn (`utils/trainObligation.ts`), and the audit (C4) records the consequence: `PassTurn`
   in the reducer always advanced, so the rule lived in a button.

   ASKED HERE OF THE STATE. The four facts, each from the authority's own readers: the corporation is the one
   operating and stands at the Buy Trains step; it holds no train (`owned_trains` reported and empty -- a
   reprieved or ghost train is still a train the corporation can run); it has a legal route
   (`hasLegalRouteFor`, the same walk the auto-skip and the route search use); and the bank has a train to
   sell (`cheapestPurchasableTrain`, which a printed game always has). Absent facts are "not said" (#232):
   a fleet the state has not reported, or a board with no grid to walk, gives no opinion rather than a
   refusal, which is the fixture case and never the server's.

   WHAT IT BLOCKS: the two messages that leave the step -- `PassTurn`, and `AdvanceOperatingSubPhase`, which
   at the last step is a no-op that the guard key still records. Everything that could DISCHARGE the
   obligation passes: the depot purchase, the emergency purchase, a corporation-to-corporation trade and
   its offer/answer pair, the Diesel exchange, and the room's `RevertTo`. So the state this leaves behind is
   exactly "this corporation is required to buy a train and cannot complete its turn until it has" -- the
   boundary Batch 5's funding and bankruptcy work starts from. */

export interface TrainObligation {
  /** `true`: a purchase is owed and the turn may not end. `false`: no obligation. `null`: could not tell. */
  owed: boolean | null;
  reason: string | null;
}

export function trainObligationFor(
  state: GameStateResponse,
  companyId: number,
  mapGrid: MapGridResponse | undefined,
): TrainObligation {
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company) return { owed: null, reason: null };
  const owned = company.owned_trains;
  if (owned == null) return { owed: null, reason: null };
  if (owned.length > 0) return { owed: false, reason: null };
  if (mapGrid === undefined) return { owed: null, reason: null };
  const route = hasLegalRouteFor(state, companyId, mapGrid);
  if (route === null) return { owed: null, reason: null };
  if (!route) return { owed: false, reason: null };
  const cheapest = cheapestPurchasableTrain(state);
  if (cheapest === null) return { owed: false, reason: null };
  return {
    owed: true,
    reason:
      `${company.ticker} owns no train and has a route to run, so it must acquire one before its turn ends — ` +
      `the cheapest for sale is a ${cheapest.tier}-train at $${cheapest.cost}` +
      `${cheapest.source === "pool" ? " from the Bank Pool" : ""}.`,
  };
}

/** Why this message may not end the operating corporation's turn, or `null` if it may. */
export function trainObligationRefusal(
  state: GameStateResponse,
  msg: SandboxLogMsg,
  mapGrid: MapGridResponse | undefined,
): string | null {
  if (!("PassTurn" in msg) && !("AdvanceOperatingSubPhase" in msg)) return null;
  if (state.current_round_type !== "OperatingRound") return null;
  if (state.operating_sub_phase !== TRAIN_PURCHASE_SUB_PHASE) return null;
  const companyId = operatingCorporationId(state);
  if (companyId === null) return null;
  const obligation = trainObligationFor(state, companyId, mapGrid);
  return obligation.owed === true ? obligation.reason : null;
}
