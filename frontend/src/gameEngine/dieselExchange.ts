// frontend/src/utils/dieselExchange.ts
//
// The Project 18XX+ D-train exchange -- design note #1303.
//
// RULED: "In this variant, a 4-, 5- or 6-train may be traded in to purchase a D-train for $800."
//
// ONE GATE, ASKED FROM THREE PLACES. The reducer arm asks it before it moves anything; the REFUSED log line
// asks it again on the same `before` state to say why (#784's rule); and the panel asks it to explain a dead
// button. Three callers, one function, so they cannot disagree about which rule fired -- which is #1006's
// bug shape and the reason `trainPurchaseRefusal` is built the same way.
//
// IT IS AN ORDINARY PURCHASE, NOT AN EMERGENCY. A corporation exchanging a train already owns one, so the
// emergency flow (no train, president covers the shortfall) can never apply: the treasury pays or the
// exchange is refused. `trainPurchaseRefusal` supplies the round, step, actor and funds checks; the train
// limit is NOT among them because the exchange is one train out and one in.
//
// WHEN THE DIESEL IS "AVAILABLE": the depot sells cheapest-first, and the tier for sale is the first row with
// stock (`buyDepotTrain`'s own `find`). The Diesel is for sale once every 6-train has gone. The exchange
// opens at that moment and never closes -- Diesels have no ceiling.

import type { GameStateResponse } from "./gameState";
import { openDepotTiers } from "./gamePhase";
import { resolveVariants } from "./gameVariants";
import { trainPurchaseRefusal } from "./trainPurchaseGate";
import { ownsOnlyReprievedCopiesOf, unreprievedTrains } from "./gentleRustGrace";

export const DIESEL_EXCHANGE_COST = 800;
/** Design note #1326: the Level Playing Field's trade-in price. Its Diesel is $900 outright (`LPF_DIESEL_COST`). */
export const LPF_DIESEL_EXCHANGE_COST = 750;

/** What a trade-in costs at this table. */
export function dieselExchangeCostFor(state: Pick<GameStateResponse, "variants"> | null | undefined): number {
  return resolveVariants(state?.variants).levelPlayingField ? LPF_DIESEL_EXCHANGE_COST : DIESEL_EXCHANGE_COST;
}
export const DIESEL_TIER = "D";
/** The tiers that may be traded in. */
export const DIESEL_EXCHANGE_TIERS: readonly string[] = ["4", "5", "6"];

/** Whether the depot is selling Diesels -- every lower tier sold out. */
export function dieselAvailable(state: GameStateResponse | null): boolean {
  // #1326: "for sale now" is `openDepotTiers` -- one row in the printed queue, the 6/7/D shelf under the LPF.
  return openDepotTiers(state).some((row) => row.tier === DIESEL_TIER);
}

/** Whether this table plays the exchange at all. */
export function dieselExchangeEnabled(state: GameStateResponse | null): boolean {
  /* #1439: CORRECTED -- "players can trade-in trains to acquire their D-trains, so this also needs to be
     adopted from LPF variant. Diesel: $1,100, Diesel with a 4-, 5-, or 6-train trade-in: $800." On every
     table, then; the prices were already the standard ones outside the Level Playing Field. `state` is kept
     so a later variant can switch it off without touching the callers. */
  void state;
  return true;
}

/** The models `company` could trade in, in roster order, one entry per train: its 4-, 5- and 6-trains that no
 *  Gentle Rust mark covers.
 *
 *  Design note #1700 (GR-2, OD-GR-2): CORRECTED. This said a train on its Gentle Rust final run "is in
 *  `pending_rust_trains`, not `owned_trains`, and is not here -- it is already leaving". That was #906's
 *  mechanism, superseded by #979 / #1034: a reprieved train STAYS in `owned_trains` (it still runs and still
 *  shows its chip), so this list offered it -- the trade-in hole (probe P9). A reprieved train may not be traded
 *  in, so it is taken out here, by multiset (`unreprievedTrains`): owned `["4","4","5"]` with one marked 4 is
 *  `["4","5"]` -- one ordinary 4, never both and never none. `pending_rust_doomed_this_turn` is already among
 *  the marks and is not subtracted again. */
export function exchangeableTrains(
  company: { owned_trains?: readonly string[] | null; pending_rust_trains?: readonly string[] | null } | null | undefined,
): string[] {
  if (!company) return [];
  return unreprievedTrains(company).filter((model) => DIESEL_EXCHANGE_TIERS.includes(model));
}

/** Why `companyId` may not trade `modelType` in for a Diesel right now, or `null` when it may.
 *  `modelType` may be omitted to ask whether ANY exchange is open (the panel's question). */
export function dieselExchangeRefusal(
  state: GameStateResponse,
  companyId: number,
  modelType?: string,
): string | null {
  if (!dieselExchangeEnabled(state)) {
    return "This table does not trade trains in.";
  }
  if (!dieselAvailable(state)) {
    return "D-trains are not for sale yet — the first 6-train must be bought first."; // #1439: every table
  }
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company) return "That corporation is not on this board.";

  /* Design note #1700 (GR-2, OD-GR-2): the candidates are the ordinary copies only, so "holds the model" and
     "holds a copy it may trade" are two different answers, and the refusal says which. A reprieved copy gives
     no credit, never reaches the Bank Pool, and stays until Gentle Rust retires it; an ordinary 5 beside a
     reprieved 4 is still a trade-in. Judged on the board before the exchange -- a 4 traded in for the very first
     Diesel carries no mark yet, so it is ordinary and legal. */
  const ticker = company.ticker ?? "This corporation";
  const candidates = exchangeableTrains(company);
  if (modelType !== undefined && DIESEL_EXCHANGE_TIERS.includes(modelType) && ownsOnlyReprievedCopiesOf(company, modelType)) {
    return (company.owned_trains ?? []).filter((model) => model === modelType).length > 1
      ? `Every ${modelType}-train ${ticker} holds is on its Gentle Rust final run — none can be traded in for a Diesel.`
      : `${ticker}'s ${modelType}-train is on its Gentle Rust final run — it cannot be traded in for a Diesel.`;
  }
  if (candidates.length === 0) {
    const reprieved = (company.owned_trains ?? []).filter((model) => DIESEL_EXCHANGE_TIERS.includes(model));
    if (reprieved.length === 1) {
      return `${ticker}'s only 4-, 5- or 6-train is on its Gentle Rust final run — it cannot be traded in for a Diesel.`;
    }
    if (reprieved.length > 1) {
      return `Every 4-, 5- or 6-train ${ticker} holds is on its Gentle Rust final run — none can be traded in for a Diesel.`;
    }
    return `${ticker} holds no 4-, 5- or 6-train to trade in.`;
  }
  if (modelType !== undefined && !candidates.includes(modelType)) {
    return `${ticker} holds no ${modelType}-train to trade in.`;
  }

  // Round, step, actor and funds -- the same sentences the ordinary purchase gives. No train limit: one
  // train leaves as one arrives.
  return trainPurchaseRefusal(state, companyId, {
    cost: dieselExchangeCostFor(state),
    trainLimit: null,
    requireFunds: true,
  });
}
