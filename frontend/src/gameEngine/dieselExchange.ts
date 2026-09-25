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
import { onOpenShelf, openDepotTiers, type TrainTier } from "./gamePhase";
import { resolveVariants } from "./gameVariants";
import { trainPurchaseRefusal } from "./trainPurchaseGate";
import { finalRunPositions, ownsOnlyReprievedCopiesOf, unreprievedTrains } from "./gentleRustGrace";

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
  company:
    | {
        owned_trains?: readonly string[] | null;
        pending_rust_trains?: readonly string[] | null;
        /** UR-3 (OD-UR-7): the Carcosa gilding, subtracted like the Gentle Rust marks. */
        carcosan_trains?: readonly string[] | null;
      }
    | null
    | undefined,
): string[] {
  if (!company) return [];
  /* ==================================================================
      UR-3 (OD-UR-7 = 7-A, backlog D-41, UR-F17): NOR IS A GILDED COPY A TRADE-IN
     ==================================================================
     OWNER RULING (2026-09-24): a gilded / Carcosan train may not be used as a Diesel trade-in; buying a Diesel
     normally stays legal, and so does trading in an ordinary, non-gilded eligible train. Probe P-I: the arm took the
     gilded 6, moved it into the Bank Pool as ordinary physical stock and left the gilding, the provenance marker and
     the doom clock behind at the seller -- the fog escaped, and a synthetic train became one the Bank could sell.
     THE SAME MULTISET QUESTION AS #1700's, ABOUT A DIFFERENT MARK: `carcosan_trains` names how many copies of a model
     are gilded, never which slot, so one copy per gilding comes off -- owned `["6","6"]` with one gilded 6 still trades
     exactly one 6, and the copy that stays carries the gilding. Gilded models outside the eligible tiers (a gilded D
     or 7) subtract nothing a trade-in could have used. */
  const gilded = [...(company.carcosan_trains ?? [])];
  return unreprievedTrains(company).filter((model) => {
    const at = gilded.indexOf(model);
    if (at >= 0) {
      gilded.splice(at, 1);
      return false;
    }
    return DIESEL_EXCHANGE_TIERS.includes(model);
  });
}

/** UR-3 (OD-UR-7, UR-F17): why no copy of `model` that `company` holds may be traded in because the ones no Gentle Rust
 *  mark covers are gold-trimmed by Carcosa -- or `null` when an ordinary copy remains, the model is not an eligible
 *  tier, or no copy is gilded. Counted by multiset, like `reprievedExchangeReason`. */
export function gildedExchangeReason(
  company: {
    ticker?: string | null;
    owned_trains?: readonly string[] | null;
    pending_rust_trains?: readonly string[] | null;
    carcosan_trains?: readonly string[] | null;
  },
  model: string,
): string | null {
  const count = (list: readonly string[] | null | undefined) => (list ?? []).filter((entry) => entry === model).length;
  const owned = count(company.owned_trains);
  const gilded = Math.min(owned, count(company.carcosan_trains));
  if (owned === 0 || gilded === 0 || !DIESEL_EXCHANGE_TIERS.includes(model)) return null;
  const reprieved = Math.min(owned, count(company.pending_rust_trains));
  if (owned - Math.min(owned, gilded + reprieved) > 0) return null;
  const ticker = company.ticker ?? "This corporation";
  if (reprieved > 0) {
    return `None of ${ticker}'s ${model}-trains can be traded in for a Diesel — each is on its Gentle Rust final run or gold-trimmed by Carcosa.`;
  }
  return owned > 1
    ? `Every ${model}-train ${ticker} holds is gold-trimmed by Carcosa — a gilded train cannot be traded in for a Diesel.`
    : `${ticker}'s ${model}-train is gold-trimmed by Carcosa — a gilded train cannot be traded in for a Diesel.`;
}

/** Why `companyId` may not trade `modelType` in for a Diesel right now, or `null` when it may.
 *  `modelType` may be omitted to ask whether ANY exchange is open -- the panel's question, and (#1701, DT-1) the
 *  Buy Trains auto-skip's: `buyTrainsAutoSkipReason` keeps a corporation at its train limit on the step while this
 *  answers `null`, so whatever this refuses also lets the train-limit end of turn fire. */
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
    // #1702 (GR-3): the sentence lives in `reprievedExchangeReason` below, so the panel greys with these words.
    return reprievedExchangeReason(company, modelType) as string;
  }
  // UR-3 (OD-UR-7): every copy of the named model that no Gentle Rust mark covers is gold-trimmed.
  if (modelType !== undefined && !candidates.includes(modelType)) {
    const gilded = gildedExchangeReason(company, modelType);
    if (gilded !== null) return gilded;
  }
  if (candidates.length === 0) {
    /* UR-3 (OD-UR-7): with a gilding on the board, the eligible copies left are Final Run or gold-trimmed ones; say
       which. With none -- every table before UR-3 and every table without Carcosa -- the sentences below are #1700's
       and #1702's, byte for byte. */
    const gildedLeft = [...(company.carcosan_trains ?? [])];
    const eligible = (company.owned_trains ?? []).filter((model) => DIESEL_EXCHANGE_TIERS.includes(model));
    const gildedEligible = eligible.filter((model) => {
      const at = gildedLeft.indexOf(model);
      if (at < 0) return false;
      gildedLeft.splice(at, 1);
      return true;
    });
    if (gildedEligible.length > 0) {
      if (gildedEligible.length < eligible.length) {
        return `None of ${ticker}'s 4-, 5- or 6-trains can be traded in for a Diesel — each is on its Gentle Rust final run or gold-trimmed by Carcosa.`;
      }
      return eligible.length === 1
        ? `${ticker}'s only 4-, 5- or 6-train is gold-trimmed by Carcosa — a gilded train cannot be traded in for a Diesel.`
        : `Every 4-, 5- or 6-train ${ticker} holds is gold-trimmed by Carcosa — none can be traded in for a Diesel.`;
    }
    const reprieved = eligible;
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

/* ==================================================================
    DESIGN NOTE 1702 (GR-3, U-11): THE PANEL SHOWS THE FINAL RUN TRAIN IT MAY NOT TAKE
   ==================================================================
   GR-2 (#1700) took reprieved copies out of `exchangeableTrains`, and the panel -- which drew one chip per
   candidate and nothing when there were none -- simply lost them: a corporation visibly holding a 4 on its Final
   Run saw no trade-in row at all, and no reason. The panel now draws those copies too, greyed, with the
   refusal's own sentence. Both helpers below ask this module's multiset (`finalRunPositions`, the chips'
   order); neither decides legality -- `dieselExchangeRefusal` still does, unchanged. */

/** The 4-, 5- and 6-trains `company` holds that a Gentle Rust mark covers, roster order, one entry per train:
 *  owned `["4","4","5"]`, marks `["4"]` -> `["4"]`. The complement of `exchangeableTrains` among the eligible
 *  tiers. `pending_rust_doomed_this_turn` is inside the marks already and is not counted again (#1700). */
export function reprievedExchangeCopies(
  company: { owned_trains?: readonly string[] | null; pending_rust_trains?: readonly string[] | null } | null | undefined,
): string[] {
  if (!company) return [];
  const covered = finalRunPositions(company);
  return (company.owned_trains ?? []).filter((model, at) => covered[at] && DIESEL_EXCHANGE_TIERS.includes(model));
}

/** Why a reprieved copy of `model` may not be traded in, or `null` when no copy of it is reprieved. When every
 *  copy is, this is `dieselExchangeRefusal`'s own sentence for that model, byte for byte (it returns it from
 *  here); beside an ordinary copy it says the ordinary one still trades. */
export function reprievedExchangeReason(
  company: { ticker?: string | null; owned_trains?: readonly string[] | null; pending_rust_trains?: readonly string[] | null },
  model: string,
): string | null {
  const count = (list: readonly string[] | null | undefined) => (list ?? []).filter((entry) => entry === model).length;
  const owned = count(company.owned_trains);
  const marked = count(company.pending_rust_trains);
  if (owned === 0 || marked === 0 || !DIESEL_EXCHANGE_TIERS.includes(model)) return null;
  const ticker = company.ticker ?? "This corporation";
  if (ownsOnlyReprievedCopiesOf(company, model)) {
    return owned > 1
      ? `Every ${model}-train ${ticker} holds is on its Gentle Rust final run — none can be traded in for a Diesel.`
      : `${ticker}'s ${model}-train is on its Gentle Rust final run — it cannot be traded in for a Diesel.`;
  }
  const free = owned - marked;
  return marked === 1
    ? `One of ${ticker}'s ${model}-trains is on its Gentle Rust final run and cannot be traded in for a Diesel; ${free === 1 ? "the other" : "the others"} can.`
    : `${marked} of ${ticker}'s ${model}-trains are on their Gentle Rust final run and cannot be traded in for a Diesel; ${free === 1 ? "one" : free} can.`;
}

/** ==================================================================
 *   DESIGN NOTE 1702 (GR-3): MAY A TRADE-IN STILL BE OPEN AFTER THIS DEPOT PURCHASE?
 *  ==================================================================
 *  #1101's "Pay $X and End Turn" promises that filling the train limit ends the turn. Since DT-1 (#1701) it does
 *  not while a legal trade-in remains (`buyTrainsAutoSkipReason`), and the button went on promising it -- probed
 *  in DT-1: phase 6, PRR holding a 4 buys the last 6 for $630, lands at its limit with a legal exchange, and the
 *  turn stays open under a button that said it would end.
 *  NOT A LEGALITY VERDICT AND NOT A PROJECTION. No reducer runs here and nothing here says a trade-in WILL be
 *  legal. It answers the one question a button needs in order to stay honest -- COULD one be open afterwards? --
 *  from three necessary conditions, each of which a depot purchase can only spend, never create beyond the train
 *  it delivers:
 *    a candidate      an ordinary 4, 5 or 6 already held (`exchangeableTrains`), or the train being bought is one;
 *    a Diesel on sale already (`dieselAvailable`), or the tier being bought is the one that opens the shelf;
 *    the money        what the treasury keeps after paying `price` still covers `dieselExchangeCostFor`.
 *  `true` whenever all three might hold, so `false` proves no trade-in can follow the purchase -- and only then
 *  may a button promise that filling the limit ends the turn. Where it answers `true` the button promises
 *  nothing: silence where the engine may keep the turn open, never a claim it can contradict. */
export function dieselExchangeMayFollowPurchase(
  state: GameStateResponse,
  companyId: number,
  tier: string,
  price: number,
): boolean {
  if (!dieselExchangeEnabled(state)) return false;
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company) return true;
  const candidate = exchangeableTrains(company).length > 0 || DIESEL_EXCHANGE_TIERS.includes(tier);
  if (!candidate) return false;
  const onSale = dieselAvailable(state) || onOpenShelf(state, tier as TrainTier);
  if (!onSale) return false;
  const treasury = Number(company.treasury);
  const left = (Number.isFinite(treasury) ? treasury : 0) - price;
  return left >= dieselExchangeCostFor(state);
}

/** ==================================================================
 *   DESIGN NOTE 1702 (GR-3): WHAT THE BUY TRAINS PANEL IS TOLD ABOUT THE TRADE-IN
 *  ==================================================================
 *  #1303's row, as the shell resolves it -- moved here from `App.tsx`'s memo so the shell and the tests build it
 *  the same way, from nothing but this module's authorities. `null` (no row) unless the table plays the exchange
 *  and a Diesel is for sale. `cost` is the table's price (`dieselExchangeCostFor`); the row showed and projected
 *  the $800 constant under the Level Playing Field, which charges $750. `finalRun` lists the eligible copies a
 *  Gentle Rust mark covers, with the refusal's sentence, so the row greys them rather than vanishing. */
export interface DieselExchangeOffer {
  /** The buyer's tradeable trains, one entry per train, roster order (`exchangeableTrains`). */
  models: readonly string[];
  /** The gate's sentence for a dead button (`dieselExchangeRefusal`), or `null`. */
  problem: string | null;
  /** What the trade-in costs at this table (`dieselExchangeCostFor`). */
  cost: number;
  /** Final Run copies of eligible tiers (`reprievedExchangeCopies`), each with `reprievedExchangeReason`. */
  finalRun?: readonly { model: string; reason: string }[];
}

export function dieselExchangeOfferFor(state: GameStateResponse | null, companyId: number): DieselExchangeOffer | null {
  if (!state || !dieselExchangeEnabled(state) || !dieselAvailable(state)) return null;
  const buyer = state.public_companies.find((entry) => entry.company_id === companyId);
  return {
    models: exchangeableTrains(buyer),
    problem: dieselExchangeRefusal(state, companyId),
    cost: dieselExchangeCostFor(state),
    finalRun: reprievedExchangeCopies(buyer).map((model) => ({
      model,
      reason: buyer ? (reprievedExchangeReason(buyer, model) ?? "") : "",
    })),
  };
}
