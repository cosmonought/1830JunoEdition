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
  return resolveVariants(state?.variants).expandedMap;
}

/** The models `company` could trade in, in roster order, one entry per train. A train on its Gentle Rust
 *  final run is in `pending_rust_trains`, not `owned_trains`, and is not here -- it is already leaving. */
export function exchangeableTrains(company: { owned_trains?: readonly string[] | null } | null | undefined): string[] {
  return (company?.owned_trains ?? []).filter((model) => DIESEL_EXCHANGE_TIERS.includes(model));
}

/** Why `companyId` may not trade `modelType` in for a Diesel right now, or `null` when it may.
 *  `modelType` may be omitted to ask whether ANY exchange is open (the panel's question). */
export function dieselExchangeRefusal(
  state: GameStateResponse,
  companyId: number,
  modelType?: string,
): string | null {
  if (!dieselExchangeEnabled(state)) {
    return "This table is not playing Project 18XX+ — trains are not traded in.";
  }
  if (!dieselAvailable(state)) {
    return resolveVariants(state.variants).levelPlayingField
      ? "D-trains are not for sale yet — the first 6-train must be bought first."
      : "D-trains are not for sale yet — every 6-train must be bought first.";
  }
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company) return "That corporation is not on this board.";

  const candidates = exchangeableTrains(company);
  if (candidates.length === 0) {
    return `${company.ticker ?? "This corporation"} holds no 4-, 5- or 6-train to trade in.`;
  }
  if (modelType !== undefined && !candidates.includes(modelType)) {
    return `${company.ticker ?? "This corporation"} holds no ${modelType}-train to trade in.`;
  }

  // Round, step, actor and funds -- the same sentences the ordinary purchase gives. No train limit: one
  // train leaves as one arrives.
  return trainPurchaseRefusal(state, companyId, {
    cost: dieselExchangeCostFor(state),
    trainLimit: null,
    requireFunds: true,
  });
}
