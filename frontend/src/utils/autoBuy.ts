// frontend/src/utils/autoBuy.ts
//
// A standing instruction to buy, for playtesting a Stock Round without clicking through it.
//
// ==================================================================
//  DESIGN NOTE 1240: AUTO-BUY IS A DEBUG TOOL SHAPED LIKE AUTO-PASS
// ==================================================================
//
// ASKED: "an auto-buy button in the stock round ... click 'Auto-Buy' button, a modal or something appears
// where you can tick corporation boxes and tell it to buy up to x% in those corporations ... for now, just an
// auto-buy would be amazing."
//
// THE SAME CATEGORY AS AUTO-PASS (#717) AND EVERY RULE THERE CARRIES OVER. It is one viewer's instruction to
// their own client, never in the log; what reaches the log is an ordinary `BuyStock` or `PassTurn`, authored
// by this player, undoable, indistinguishable afterwards from a click. It is armed per Stock Round and expires
// with it. It dispatches at most once per turn, measured against the log index (#816). None of that is
// re-derived here -- the caller uses the same guards it already uses for Auto-Pass.
//
// WHAT IT DECIDES: on this player's turn, the FIRST ticked corporation, in the order ticked, whose holding is
// below its cap and which has a share on offer -- from the preferred source, then the other (#1333) -- and which
// the board's own purchase rules (`sharePurchaseBlock`, handed in as `blockFor`) do not refuse. If none
// qualifies it stops and hands the turn back (#1274).
// The legality question is DELEGATED, not copied: the certificate limit, the sixty-percent rule, the zone
// rules and the one-purchase-per-turn rule already live in one place, and #1184 is what happens when a second
// copy is written.
//
// AN UNPARRED CORPORATION IS SKIPPED, NOT PARRED. Buying a president's certificate sets the par price, and a
// par price is a decision with consequences for the whole game -- this tool takes no decision it was not
// given. "Not yet parred" is shown in the modal beside the ticker so the tester knows to par it by hand first;
// once a par exists the tool will buy into it.
//
// NO HALT CONDITIONS YET, AND SAID SO. Auto-Pass guarantees a presidency cannot be lost while it stands. This
// does not guarantee anything: it is asked for as a way to get through a Stock Round quickly during debugging,
// and a safety stop that fires every other turn would defeat that. The modal says "debug tool" in as many
// words. When it graduates to a player-facing feature, the presidency guard and the sale wakes belong here,
// in the same shape `autoPassDecision` gives them.

// ==================================================================
//  DESIGN NOTE 1333: THE GRADUATION (10a / 10b / 10c)
// ==================================================================
//
// ASKED, once the tool had been used in anger: a cap PER corporation rather than one for the list (10a); the
// unparred hidden rather than listed as "skipped" (10a); an OFF-SWITCH when somebody pars a corporation or
// sells shares of one on the list (10b); and a choice of source -- IPO, the bank pool, or whichever is
// cheaper (10c).
//
// EACH TARGET CARRIES ITS OWN CAP. `companyIds` + `maxPercent` become `targets: {companyId, maxPercent}[]`,
// still in the order ticked; "one corporation" is a list of one. The modal seeds every cap from one shared
// figure so the old one-cap habit costs no extra clicks.
//
// THE WAKES ARE #717's, IN AUTO-PASS'S OWN SHAPE. A par is a new corporation on offer that was not there
// when the instruction was given; a sale of a listed corporation moves its price and says something about
// what the seller knows. Either is a moment the player would have wanted to look, so the plan carries a
// `watch` -- the set of parred corporations and the pool holdings of the listed ones at the time it was
// last examined -- and `autoBuyWake` compares the board against it. The caller refreshes the watch after
// every buy of its own, so the tool's OWN purchases (which drain the pool, never fill it) cannot wake it.
// Both switches default ON and are unticked in the modal; the debug habit of "just run the round" is a
// two-click opt-out rather than the default a real player is handed.
//
// CHEAPEST asks the caller for the price of a share from each source -- par for the IPO, the market for the
// pool -- and takes the lower, IPO on a tie (it is the one that helps the corporation float). "IPO" and
// "Bank" name one source and fall to the other only when the named one is empty or refused, which is what
// #1240 already did with IPO first.

import type { GameStateResponse } from "./gameState";

export type AutoBuySource = "Ipo" | "Bank";
/** 10c: which source to buy from. `Cheapest` compares the two prices each turn. */
export type AutoBuySourcePreference = "Ipo" | "Bank" | "Cheapest";

/** The cap is a whole-percent holding, in 10% steps, matching the certificate size. */
export const AUTO_BUY_CAPS: readonly number[] = [10, 20, 30, 40, 50, 60];

export interface AutoBuyTarget {
  companyId: number;
  /** Buy while the holding is strictly below this. */
  maxPercent: number;
}

/** What the plan last saw, for the 10b wakes. */
export interface AutoBuyWatch {
  /** Corporations with a par price. A new one is a par. */
  parred: readonly number[];
  /** Bank-pool percentage per LISTED corporation. A rise is a sale. */
  pool: Readonly<Record<number, number>>;
}

export interface AutoBuyPlan {
  player: string;
  /** The round it was set in; any other round is a stop (#717's expiry, verbatim). */
  macroRoundNumber: number;
  /** In the order ticked; the first eligible one is bought. */
  targets: readonly AutoBuyTarget[];
  source: AutoBuySourcePreference;
  stopOnPar: boolean;
  stopOnSale: boolean;
  watch: AutoBuyWatch;
}

export interface AutoBuySettings {
  targets: readonly AutoBuyTarget[];
  source: AutoBuySourcePreference;
  stopOnPar: boolean;
  stopOnSale: boolean;
}

export function autoBuyWatchOf(state: GameStateResponse, targets: readonly AutoBuyTarget[]): AutoBuyWatch {
  const listed = new Set(targets.map((target) => target.companyId));
  return {
    parred: state.public_companies.filter((c) => c.par_value !== null).map((c) => c.company_id),
    pool: Object.fromEntries(
      state.public_companies
        .filter((c) => listed.has(c.company_id))
        .map((c) => [c.company_id, c.bank_pool_percentage]),
    ),
  };
}

export function armAutoBuy(state: GameStateResponse, player: string, settings: AutoBuySettings): AutoBuyPlan {
  return {
    player,
    macroRoundNumber: state.macro_round_number,
    targets: settings.targets,
    source: settings.source,
    stopOnPar: settings.stopOnPar,
    stopOnSale: settings.stopOnSale,
    watch: autoBuyWatchOf(state, settings.targets),
  };
}

/** The plan with its watch brought up to `state` -- called after the tool's own buy lands. */
export function refreshAutoBuyWatch(plan: AutoBuyPlan, state: GameStateResponse): AutoBuyPlan {
  return { ...plan, watch: autoBuyWatchOf(state, plan.targets) };
}

export function holdingPercent(state: GameStateResponse, companyId: number, player: string): number {
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company) return 0;
  return company.player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
}

/** 10b: the reason the plan should switch itself off, or `null` when nothing it watches has moved. */
export function autoBuyWake(state: GameStateResponse, plan: AutoBuyPlan): string | null {
  if (plan.stopOnPar) {
    const seen = new Set(plan.watch.parred);
    const parred = state.public_companies.find((c) => c.par_value !== null && !seen.has(c.company_id));
    if (parred) return `${parred.ticker} has been parred at $${parred.par_value}.`;
  }
  if (plan.stopOnSale) {
    for (const target of plan.targets) {
      const company = state.public_companies.find((c) => c.company_id === target.companyId);
      if (!company) continue;
      const before = plan.watch.pool[target.companyId] ?? 0;
      if (company.bank_pool_percentage > before) {
        return `${company.ticker} shares have been sold to the pool (${before}% → ${company.bank_pool_percentage}%).`;
      }
    }
  }
  return null;
}

export type AutoBuyDecision =
  | { action: "buy"; companyId: number; source: AutoBuySource }
  /* ==================================================================
      DESIGN NOTE 1274: WHEN THE LIST IS EXHAUSTED, THE TURN IS THE PLAYER'S
     ==================================================================
     REPORTED (JUNO-CV4, indices 18-26): "as soon as their auto-buys completed, the game auto-passed them.
     This is incorrect: when an Auto-Buy completes, players are not auto-passed: they must then choose what
     they're doing." #1240 wrote "or passes when none qualifies" and the log shows exactly that -- a
     `PassTurn` by the auto-buyer after every turn its list had nothing for. A standing instruction to BUY
     is not a standing instruction to PASS; a player whose list is done may still want to sell, or buy
     something they had not ticked. So `pass` is gone from this type: nothing qualifying is a STOP, with
     the reason printed, and the turn is left where it is. */
  | { action: "done"; reason: string }
  | { action: "stop"; reason: string };

/** The order the sources are tried in, for one corporation, under the plan's preference. */
export function autoBuySourceOrder(
  preference: AutoBuySourcePreference,
  available: { ipo: boolean; bank: boolean },
  priceFor: (source: AutoBuySource) => number | null,
): AutoBuySource[] {
  const both: AutoBuySource[] = [];
  if (preference === "Cheapest") {
    const ipo = available.ipo ? priceFor("Ipo") : null;
    const bank = available.bank ? priceFor("Bank") : null;
    // IPO on a tie, and IPO when a price is unknown -- the default #1240 shipped with.
    if (ipo !== null && bank !== null && bank < ipo) both.push("Bank", "Ipo");
    else both.push("Ipo", "Bank");
  } else if (preference === "Bank") both.push("Bank", "Ipo");
  else both.push("Ipo", "Bank");
  return both.filter((source) => (source === "Ipo" ? available.ipo : available.bank));
}

/** What to do on this player's turn.
 *
 *  `blockFor` is the board's own purchase rule, asked one certificate at a time. `priceFor` is the price of
 *  one share from a source, for `Cheapest`; absent, IPO is preferred. Every "stop" and "done" disarms. */
export function autoBuyDecision(
  state: GameStateResponse,
  plan: AutoBuyPlan,
  blockFor: (companyId: number, source: AutoBuySource) => string | null,
  priceFor: (companyId: number, source: AutoBuySource) => number | null = () => null,
): AutoBuyDecision {
  if (state.macro_round_number !== plan.macroRoundNumber) {
    return { action: "stop", reason: "Auto-Buy expired with the Stock Round — set it again to keep buying." };
  }
  if (plan.targets.length === 0) {
    return { action: "stop", reason: "Auto-Buy has no corporations ticked." };
  }
  const woken = autoBuyWake(state, plan);
  if (woken) return { action: "stop", reason: woken };

  for (const target of plan.targets) {
    const company = state.public_companies.find((entry) => entry.company_id === target.companyId);
    if (!company) continue;
    if (company.par_value === null) continue;
    if (holdingPercent(state, target.companyId, plan.player) >= target.maxPercent) continue;

    const sources = autoBuySourceOrder(
      plan.source,
      { ipo: company.ipo_pool_percentage > 0, bank: company.bank_pool_percentage > 0 },
      (source) => priceFor(target.companyId, source),
    );
    for (const source of sources) {
      if (blockFor(target.companyId, source) === null) return { action: "buy", companyId: target.companyId, source };
    }
  }
  return { action: "done", reason: "Auto-Buy has nothing left to buy — the turn is yours." };
}
