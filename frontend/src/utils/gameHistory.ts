// frontend/src/utils/gameHistory.ts
//
// The game as a series of round-by-round samples, for the epilogue's charts.
//
// ==================================================================
//  DESIGN NOTE 1411: THE LOG REPLAYED AS A TIMELINE
// ==================================================================
//
// REQUESTED: "have it start with the final network and everything like it is, and then have a 'Next' button
// that shows a chart of corporations stock price movements over the rounds (clickable to show who owned how
// much at each round), then a final chart showing player net worth movement across the game ... after a long
// economic game a visual display is a relief versus more tables."
//
// THE LOG IS THE GAME (#522), SO THE LOG IS ALSO THE HISTORY. Nothing here is recorded as it happens: the
// epilogue replays the room's log through the same engine every client replays it through (`RoomEngine`,
// `sandboxReplayProviders`, the same seed the harness uses) and takes a snapshot at every round boundary --
// each Stock Round and each Operating Round, as the state's own `current_round_type` / `macro_round_number`
// / `sub_round_index` change under it -- plus one at the end. A figure on these charts is therefore a figure
// the reducer produced, on the board the table saw, and two clients cannot draw two different charts.
//
// WHAT A SAMPLE HOLDS is deliberately flat: every corporation's share price (off `market_positions`, which
// #1340 put on the state), every player's cash, stock value and net worth (`playerFinances`, the Ledger's own
// arithmetic), and every corporation's ownership split (`player_holdings`, plus the IPO and Bank Pool
// percentages) -- the three things the request names, read once, so the charts are pure drawing.
//
// COMPUTED ONCE, AT THE END. A 600-action log replays in well under a second; the modal asks for the history
// when the game ends and holds it. Nothing runs during play.

import { RoomEngine, entriesFromExport, type ReplayEntry } from "./replayLog";
import { sandboxReplayProviders } from "./replayProviders";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "./sandboxState";
import { waterfallForRoster, withEmptyRoster } from "./gameSetup";
import { effectiveActions } from "./logRevert";
import { playerFinances } from "./playerFinance";
import type { GameStateResponse } from "./gameState";
import type { SandboxAction } from "./sandboxRoom";

export interface CorporationSample {
  companyId: number;
  ticker: string;
  /** `null` while the corporation has no token on the chart. */
  price: number | null;
  floated: boolean;
  president: string | null;
  /** `[player address, percentage]`, plus the two pools. */
  holdings: ReadonlyArray<readonly [string, number]>;
  ipoPercentage: number;
  poolPercentage: number;
}

export interface PlayerSample {
  address: string;
  cash: number | null;
  stockValue: number | null;
  netWorth: number | null;
}

export interface RoundSample {
  /** "SR 1", "OR 3.2", "Final". */
  label: string;
  /** The log index at which this round opened (or the last index, for "Final"). */
  atIndex: number;
  corporations: readonly CorporationSample[];
  players: readonly PlayerSample[];
}

export interface GameHistory {
  rounds: readonly RoundSample[];
  players: readonly string[];
  corporations: ReadonlyArray<{ companyId: number; ticker: string }>;
}

function roundKey(state: GameStateResponse): string {
  return `${state.current_round_type}:${state.macro_round_number ?? 0}:${state.sub_round_index ?? 0}`;
}

export function roundLabelOf(state: GameStateResponse): string {
  const macro = state.macro_round_number ?? 0;
  if (state.current_round_type === "OperatingRound") return `OR ${macro}.${state.sub_round_index ?? 0}`;
  if (state.current_round_type === "StockRound") return `SR ${macro}`;
  return "Auction";
}

function sample(state: GameStateResponse, label: string, atIndex: number): RoundSample {
  const prices: Record<number, number | null> = {};
  for (const company of state.public_companies) {
    prices[company.company_id] = state.market_positions?.[company.company_id]?.price ?? null;
  }
  return {
    label,
    atIndex,
    corporations: state.public_companies.map((company) => ({
      companyId: company.company_id,
      ticker: company.ticker,
      price: prices[company.company_id] ?? null,
      floated: company.is_floated === true,
      president: company.president ?? null,
      holdings: company.player_holdings.map((h) => [h.player, h.percentage] as const),
      ipoPercentage: company.ipo_pool_percentage,
      poolPercentage: company.bank_pool_percentage,
    })),
    players: state.player_addresses.map((address) => {
      const finances = playerFinances(address, state, prices);
      return {
        address,
        cash: finances?.cash ?? null,
        stockValue: finances?.stockValue ?? null,
        netWorth: finances?.netWorth ?? null,
      };
    }),
  };
}

/** The seed every headless replay of a room uses -- the harness's and the server's. */
function roomSeed() {
  const scenario = sandboxScenario(DEFAULT_SANDBOX_SCENARIO);
  return {
    state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
    waterfall: waterfallForRoster(sandboxWaterfallState(scenario.phase, 0, scenario.zeroState === true), []),
  };
}

/** Replay `log` and sample it at every round boundary. Reverts are honoured (`effectiveActions`). */
export function gameHistoryFrom(log: readonly SandboxAction[]): GameHistory {
  const entries: ReplayEntry[] = effectiveActions(entriesFromExport(log));
  const engine = new RoomEngine(sandboxReplayProviders(), roomSeed());
  const rounds: RoundSample[] = [];
  let lastKey: string | null = null;
  let lastIndex = -1;
  for (const entry of entries) {
    engine.apply(entry);
    lastIndex = entry.index;
    const state = engine.snapshot.state;
    const key = roundKey(state);
    if (key === lastKey) continue;
    lastKey = key;
    /* The AUCTION is skipped as a sample: nobody has a price yet and the cash there is the starting cash.
       The first sample is the first Stock Round's opening board. */
    if (state.current_round_type !== "OperatingRound" && state.current_round_type !== "StockRound") continue;
    rounds.push(sample(state, roundLabelOf(state), entry.index));
  }
  const final = engine.snapshot.state;
  if (entries.length > 0) rounds.push(sample(final, "Final", lastIndex));
  return {
    rounds,
    players: final.player_addresses.slice(),
    corporations: final.public_companies.map((company) => ({ companyId: company.company_id, ticker: company.ticker })),
  };
}
