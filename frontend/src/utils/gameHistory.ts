// frontend/src/utils/gameHistory.ts
//
// The game as a series of round-by-round samples, plus the tallies behind the epilogue's accolades and
// corporation autopsy.
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
// #1340 put on the state), its revenue this round, treasury and fleet; every player's cash, privates, equity
// by corporation and net worth (the Ledger's own arithmetic); and every corporation's ownership split.
//
// ==================================================================
//  DESIGN NOTE 1414: THE TALLIES ARE DIFFS, NOT RECORDS
// ==================================================================
//
// AGREED, the second pass: operating revenue per round, a portfolio stack behind the net-worth chart, a
// corporation autopsy, and accolades -- Robber Baron, Master of the Line, Track Boss, Market Manipulator,
// Gravedigger, Train Robber, The Wall. Every one is derived here by comparing the board BEFORE and AFTER
// each entry as the engine applies it, in the spirit of `treasuryProvenance` #750: an arm that reports its
// own arithmetic will happily report a bug, and a tally kept during play would be one browser's fact
// (#1044). Reading the diff means a dividend counts what the reducer actually moved, a rusted train is one
// that actually left the roster, and a wall is a city the reducer actually filled.
//
// COMPUTED ONCE, AT THE END. A 600-action log replays in well under a second.

import { LegacyLogAdapters, RoomEngine, entriesFromExport, type ReplayEntry } from "../gameEngine/replayLog";
import { SERVER_REPLAY_POLICY, replayCompatibility, type ReplayPolicy } from "../gameEngine/rulesVersion";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { effectiveActions } from "../gameEngine/logRevert";
import { depotCostFor, depotInventory, derivePhase, trainTier } from "../gameEngine/gamePhase";
import { citySlotCount } from "../gameEngine/stationTokens";
import { boardFor, withRules } from "../gameEngine/boardSelection";
import { flavorBucketFor, resolveVariants, revenueFlavourClause, rollTurnRevenue } from "../gameEngine/gameVariants";
import { describeFogAtSetEnd, runBeforeSign, runYellowSignWritten, yellowSignStageApplied } from "../gameEngine/yellowSign";
import { variantCueFor } from "./variantSfx";
import { tileStock } from "./tileSupply";
import { describeFleetLosses, describeReprieveExpiries } from "../gameEngine/sandboxSession";
import { ACCOLADE_SPEC_BY_KEY, selectCeremony, unearned, type Accolade, type AccoladeKey } from "./accolades";
import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";
import type { SandboxAction } from "./sandboxRoom";

const SHARE_BLOCK = 10;

/** #1429: the Farmhand's animals -- the SFX `variantSfx` routes an animal line to. */
const ANIMAL_SOUNDS: ReadonlySet<string> = new Set([
  "cow-happy.mp3", "cow-sad.mp3", "horse-happy.mp3", "horse-sad.mp3", "sheep.mp3", "chicken.mp3", "dog.mp3",
  "elephant.mp3", "quacks.mp3", "bees.mp3", "cat-meow.mp3", "parrot.mp3",
]);

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
  /** #1414/#1420: the printed revenue of its run IN this round (written as the run happens); 0 in a round
   *  it did not run. */
  revenue: number;
  treasury: number;
  trains: readonly string[];
}

export interface PlayerSample {
  address: string;
  cash: number | null;
  stockValue: number | null;
  privateValue: number;
  netWorth: number | null;
  /** #1414: shares at market, by corporation, for the portfolio stack. */
  equity: ReadonlyArray<readonly [number, number]>;
  /** #1434: dividends received IN this round (written as each declaration pays, like `revenue`); 0 otherwise. */
  dividends: number;
}

export interface RoundSample {
  /** "SR 1", "OR 3.2", "Final". */
  label: string;
  /** The log index at which this round opened (or the last index, for "Final"). */
  atIndex: number;
  /** #1414: the train phase in force ("2" .. "D"), for the chart's phase markers. */
  phase: string | null;
  corporations: readonly CorporationSample[];
  players: readonly PlayerSample[];
}

/* #1414/#1416: one accolade. The shape (and the catalogue of titles, blurbs and floors) lives in
   `accolades.ts`; this file produces the figures. Re-exported so the charts keep one import. */
export type { Accolade } from "./accolades";

/* ==================================================================
    DESIGN NOTE 1431: THE FLEET LEDGER -- EVERY TRAIN A CORPORATION EVER OWNED, BY MODEL
   ==================================================================
   ASKED: the autopsy's Fleet column should show the whole fleet and what each train returned, behind a click.
   BY MODEL, NOT BY TRAIN, on instruction: the run breakdown names models (`last_run_breakdown`), so two
   4-trains in one fleet cannot be told apart -- and "printing the same information twice" is worse than one
   row reading "4-trains (2)". What the row keeps: what the group cost, what it earned, the net, how many
   train-rounds it ran, and how each train left (rusted, discarded to the limit, sold, traded in, taken by the
   sign) or that it is still in the shed -- so the difference between a train that rusted and one that was
   sold on is not lost, even without a per-train line. */
export interface FleetLedgerRow {
  model: string;
  /** How many of this model the corporation acquired over the game. */
  count: number;
  paid: number;
  earned: number;
  /** Runs this model took part in, counting each train separately. */
  trainRounds: number;
  fates: { rusted: number; discarded: number; sold: number; traded: number; taken: number; kept: number };
}

export interface CorporationAutopsy {
  companyId: number;
  ticker: string;
  floatRound: string | null;
  finalPresident: string | null;
  lifetimeRevenue: number;
  dividendsPaid: number;
  withheld: number;
  fleet: readonly string[];
  treasury: number;
  /** #1431 */
  fleetLedger: readonly FleetLedgerRow[];
  /** #1431: lifetime revenue minus train spend -- the White Elephant's figure. */
  payback: number;
}

export interface GameHistory {
  rounds: readonly RoundSample[];
  players: readonly string[];
  corporations: ReadonlyArray<{ companyId: number; ticker: string }>;
  /** Every accolade in the catalogue, earned or not. */
  accolades: readonly Accolade[];
  /** #1416: the ones the ceremony shows, in show order -- `selectCeremony` over `accolades`. */
  ceremony: readonly Accolade[];
  autopsy: readonly CorporationAutopsy[];
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

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function cashOf(state: GameStateResponse, address: string): number | null {
  const raw = Number(state.player_cash.find((row) => row.player === address)?.cash_vgp ?? NaN);
  return Number.isFinite(raw) ? raw : null;
}

function priceOf(state: GameStateResponse, companyId: number): number | null {
  return state.market_positions?.[companyId]?.price ?? null;
}

function sample(state: GameStateResponse, label: string, atIndex: number): RoundSample {
  return {
    label,
    atIndex,
    phase: derivePhase(state)?.tier ?? null,
    corporations: state.public_companies.map((company) => ({
      companyId: company.company_id,
      ticker: company.ticker,
      price: priceOf(state, company.company_id),
      floated: company.is_floated === true,
      president: company.president ?? null,
      holdings: company.player_holdings.map((h) => [h.player, h.percentage] as const),
      ipoPercentage: company.ipo_pool_percentage,
      poolPercentage: company.bank_pool_percentage,
      revenue: num(company.printed_route_revenue ?? company.last_route_revenue),
      treasury: num(company.treasury),
      trains: [...(company.owned_trains ?? [])],
    })),
    players: state.player_addresses.map((address) => {
      const cash = cashOf(state, address);
      const equity = state.public_companies
        .map((company) => {
          const held = company.player_holdings.find((h) => h.player === address)?.percentage ?? 0;
          const price = priceOf(state, company.company_id);
          return [company.company_id, held > 0 && price !== null ? Math.round((held / SHARE_BLOCK) * price) : 0] as const;
        })
        .filter(([, value]) => value > 0);
      const stockValue = equity.reduce((sum, [, value]) => sum + value, 0);
      const privateValue = state.private_companies.reduce(
        (sum, priv) => (!priv.closed && priv.owner === address ? sum + num(priv.cost) : sum),
        0,
      );
      return {
        address,
        cash,
        stockValue,
        privateValue,
        netWorth: cash === null ? null : cash + stockValue + privateValue,
        equity,
        dividends: 0,
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

/* ---- #1414: the tallies ------------------------------------------------ */

type Tally = Map<string, number>;
const bump = (tally: Tally, key: string, by: number) => tally.set(key, (tally.get(key) ?? 0) + by);
/** #1416: the tally in order, best first, so an accolade can carry its runner-up and know whether it was
 *  tied. `lowest` ranks the other way; zeros are left out either way -- nobody wins for doing nothing. */
const ranked = (tally: Tally, direction: "highest" | "lowest" = "highest"): Array<[string, number]> =>
  Array.from(tally.entries())
    .filter(([, value]) => value > 0)
    .sort((a, b) => (direction === "highest" ? b[1] - a[1] : a[1] - b[1]));
const dollars = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function companyById(state: GameStateResponse, id: number): PublicCompanyState | undefined {
  return state.public_companies.find((company) => company.company_id === id);
}

/** `after` minus `before` as a multiset of train models -- what left the roster. */
function trainsRemoved(before: readonly string[], after: readonly string[]): string[] {
  const left = [...after];
  const removed: string[] = [];
  for (const model of before) {
    const at = left.indexOf(model);
    if (at >= 0) left.splice(at, 1);
    else removed.push(model);
  }
  return removed;
}

function parsePayload(entry: ReplayEntry): Record<string, Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(entry.payload) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Record<string, unknown>>) : null;
  } catch {
    return null;
  }
}

/** Replay `log` and sample it at every round boundary, tallying the accolades as it goes. Reverts are
 *  honoured (`effectiveActions`).
 *
 *  Design note #1614a (Slice 8.2): `policy` chooses which development-corpus adapters walk the log, and nothing
 *  else. The shell passes none: under the server's policy no adapter runs and every entry goes through
 *  `engine.apply` exactly as it always has -- a legacy log is read the way the current engine reads it. A test
 *  that reads a legacy corpus log (the frozen JUNO-CV4) passes `DEVELOPMENT_CORPUS_POLICY` by name, as
 *  `replayLog`'s callers do. The epilogue never refused a log and does not start to here. */
export function gameHistoryFrom(log: readonly SandboxAction[], policy: ReplayPolicy = SERVER_REPLAY_POLICY): GameHistory {
  const entries: ReplayEntry[] = effectiveActions(entriesFromExport(log));
  const providers = sandboxReplayProviders();
  const engine = new RoomEngine(providers, roomSeed());
  const adapters = new LegacyLogAdapters(providers, replayCompatibility(entries), policy);
  const rounds: RoundSample[] = [];
  let lastKey: string | null = null;
  let lastIndex = -1;

  // #1414 tallies, keyed by player address unless stated.
  const dividendsReceived: Tally = new Map();
  const dividendsToPlayers: Tally = new Map(); // #1438: by company id, the shareholders' part only
  const payoutTimes: Tally = new Map(); // #1438: by company id
  // #1438: Salt / Sugar Daddy -- corporation-to-corporation train sales priced against the depot.
  const saltCount: Tally = new Map();
  const saltSaved: Tally = new Map();
  const sugarCount: Tally = new Map();
  const sugarSpent: Tally = new Map();
  const everPresidentOf = new Map<string, Set<number>>(); // #1438: Railroad Baron
  const tilesAndTokens: Tally = new Map();
  const sharesTraded: Tally = new Map();
  // #1422: obsolescence in dollars -- what each president LOST to rust and the limit, and what each
  // player's purchases CAUSED. Counts kept beside them for the sentence.
  const trainsLostValue: Tally = new Map();
  const trainsLostCount: Tally = new Map();
  const trainsSentValue: Tally = new Map();
  const trainsSentCount: Tally = new Map();
  /* #1704 (owner ruling U-9): who brought each train tier into play -- the actor of the entry under which the phase
     first reached it. The cause of every rust that tier wrought, remembered because under Gentle Rust the loss is
     booked at a later destruction whose own entry names somebody else (or nobody). Keyed by the ARRIVING tier. */
  const rustCauseByTier = new Map<string, string | null>();
  const dumps: Tally = new Map();
  const walls: Tally = new Map();
  let bestRun: { holder: string | null; ticker: string; model: string; revenue: number; round: string } | null = null;
  // Keyed by company id.
  const lifetimeRevenue: Tally = new Map();
  const dividendsPaid: Tally = new Map();
  const withheld: Tally = new Map();
  const floatRound = new Map<number, string>();
  const floatOrder = new Map<number, number>(); // #1436: the order they floated in, for the Corporations table
  /** The hexes each corporation's most recent run stood in, for The Wall's "somebody runs through here". */
  const lastRoutes = new Map<number, Set<string>>();
  let hexLabel: (q: number, r: number) => string | null = () => null;
  // #1416 tallies. By player address:
  const phaseMoves: Tally = new Map();
  const phaseTiers = new Map<string, string[]>();
  const outOfPocket: Tally = new Map();
  const raids: Tally = new Map();
  const terrainSpent: Tally = new Map();
  const lastCopies: Tally = new Map();
  // By company id:
  const withheldTimes: Tally = new Map();
  const trainsBought: Tally = new Map();
  const tradeIns: Tally = new Map();
  let firstDiesel: { companyId: number; ticker: string; president: string | null; round: string } | null = null;
  // #1429: the anti-awards and the corporate five.
  const startingCash = new Map<string, number>();
  const passengerDividends: Tally = new Map();
  const animalRuns: Tally = new Map();
  const trainSpend: Tally = new Map(); // by company id
  // #1431: the fleet ledger, keyed `companyId:model`.
  const ledgerPaid: Tally = new Map();
  const ledgerEarned: Tally = new Map();
  const ledgerRounds: Tally = new Map();
  const ledgerCount: Tally = new Map();
  const ledgerFate = new Map<string, Tally>(); // `companyId:model` -> fate -> n
  const fate = (companyId: number, model: string, what: string) => {
    const key = `${companyId}:${model}`;
    const tally = ledgerFate.get(key) ?? new Map<string, number>();
    bump(tally, what, 1);
    ledgerFate.set(key, tally);
  };
  const runsOperated: Tally = new Map(); // by company id
  const peakRun: Tally = new Map(); // by company id
  const peakRunRound = new Map<string, string>();
  /** Every stock trade, for the Greater Fool and the Human Stop-Loss: judged against the next SR's price. */
  const trades: Array<{ actor: string; companyId: number; blocks: number; perShare: number; atIndex: number; side: "buy" | "sell" }> = [];
  // #1421: the Yellow Sign. Stages each president lived through, and who paid the Blood Price.
  const signStages: Tally = new Map();
  const signStageNames = new Map<string, string[]>();
  const bloodPrices: Tally = new Map();

  for (const entry of entries) {
    const before = engine.snapshot.state;
    adapters.apply(engine, entry); // #1614a: exactly `engine.apply(entry)` unless the caller named an adapter policy
    lastIndex = entry.index;
    const after = engine.snapshot.state;
    const msg = parsePayload(entry);
    const kind = msg ? Object.keys(msg)[0] : "";
    const body = (msg?.[kind] ?? {}) as Record<string, unknown>;
    const actor = entry.actor || null;

    if (kind === "SetupGame") {
      const hexes = boardFor(resolveVariants(after.variants)).hexes;
      hexLabel = (q, r) => hexes.find((hex) => hex.q === q && hex.r === r)?.label ?? null;
      // #1429: what everybody started with, for the Bagman.
      for (const address of after.player_addresses) startingCash.set(address, cashOf(after, address) ?? 0);
    }

    /* #1438: RAILROAD BARON -- every corporation a player has presided over, at any point. */
    for (const company of after.public_companies) {
      if (company.president && company.is_floated) {
        const set = everPresidentOf.get(company.president) ?? new Set<number>();
        set.add(company.company_id);
        everPresidentOf.set(company.president, set);
      }
    }

    /* Float round: the first time a corporation is floated, the round it happened in. */
    for (const company of after.public_companies) {
      if (company.is_floated && !floatRound.has(company.company_id)) {
        floatRound.set(company.company_id, roundLabelOf(after));
        floatOrder.set(company.company_id, floatOrder.size);
      }
    }

    /* ROBBER BARON and the autopsy's dividend columns: what the reducer moved on a declaration. */
    if (kind === "DeclareDividends") {
      const companyId = Number(body.protocol_id);
      let paid = 0;
      const payer = companyById(before, companyId);
      for (const address of after.player_addresses) {
        const delta = (cashOf(after, address) ?? 0) - (cashOf(before, address) ?? 0);
        if (delta > 0) {
          bump(dividendsReceived, address, delta);
          // #1434: onto the round's sample, the way #1420 writes a run's revenue -- the Dividends chart reads it.
          const onSample = rounds[rounds.length - 1]?.players.find((p) => p.address === address);
          if (onSample) onSample.dividends += delta;
          // #1429: THE PASSENGER -- income from a corporation somebody else was running.
          if (payer && payer.president !== address) bump(passengerDividends, address, delta);
          paid += delta;
        }
      }
      const treasuryDelta = num(companyById(after, companyId)?.treasury) - num(companyById(before, companyId)?.treasury);
      if (body.distribute === true) {
        bump(dividendsPaid, String(companyId), paid + Math.max(0, treasuryDelta)); // the pool slice pays the company
        bump(dividendsToPlayers, String(companyId), paid); // #1438
        bump(payoutTimes, String(companyId), 1); // #1438
      } else {
        bump(withheld, String(companyId), Math.max(0, treasuryDelta));
      }
    }

    /* MASTER OF THE LINE and lifetime revenue: the run the reducer priced. */
    if (kind === "RunMultipleRoutes") {
      const companyId = Number(body.protocol_id);
      const company = companyById(after, companyId);
      if (company) {
        /* UR-3: ON A PINNED TABLE THE MARK LANDS IN THIS ENTRY, so `after` holds the KEPT run. These tallies keep the
           basis they have always had -- the run as it was priced, in full, at its own entry -- because what a Mark
           should do to the statistics is OD-UR-6, which is open (`runBeforeSign` puts the nullified route back). */
        const runBasis = runBeforeSign(
          company,
          runYellowSignWritten(before, after, companyId),
          Array.isArray(body.train_indices) ? (body.train_indices as number[]) : null,
        );
        const printed = runBasis.printed;
        bump(lifetimeRevenue, String(companyId), printed);
        /* #1429: JUGGERNAUT (the biggest single run), the rounds a corporation operated (the divisor for the
           Dividend Machine, the Little Engine and the White Elephant), and THE FARMHAND -- the Unpredictable
           Revenue flavour read back off the run's own recorded seed, the way the shell composed it, and
           classed by the sound it would have played: an animal's, or not. */
        bump(runsOperated, String(companyId), 1);
        if (printed > (peakRun.get(String(companyId)) ?? 0)) {
          peakRun.set(String(companyId), printed);
          peakRunRound.set(String(companyId), roundLabelOf(before));
        }
        for (const run of runBasis.breakdown) {
          bump(ledgerEarned, `${companyId}:${run.model}`, num(run.printed_revenue));
          bump(ledgerRounds, `${companyId}:${run.model}`, 1);
        }
        const turnSeed = typeof body.revenue_seed === "number" ? body.revenue_seed : null;
        if (turnSeed !== null && resolveVariants(after.variants).unpredictableRevenue && company.president) {
          const parts = { macroRound: before.macro_round_number ?? 0, subRound: before.sub_round_index ?? 0, companyId, turnSeed };
          const roll = rollTurnRevenue(printed, parts);
          const bucket = flavorBucketFor(roll);
          const cue = variantCueFor({ line: revenueFlavourClause(roll, parts), bucket });
          if (cue.audio && ANIMAL_SOUNDS.has(cue.audio)) bump(animalRuns, company.president, 1);
        }
        /* ==================================================================
            DESIGN NOTE 1420: THE OR'S REVENUE IS WRITTEN ONTO THE OR'S SAMPLE
           ==================================================================
           REPORTED: "The Revenue Operating Round chart was empty." A sample is taken when a round OPENS, and
           `printed_route_revenue` is turn-scoped -- #777 clears it on every turn change -- so at the moment
           the OR's sample was taken nobody had run yet and every figure was zero. The fix is not a different
           field but a different moment: each run is written onto the sample of the round it happened in, as
           it happens. The figure is the one the reducer priced, and the Final sample (which repeats the last
           OR) is left alone -- the chart does not draw it. */
        const current = rounds[rounds.length - 1];
        const entry = current?.corporations.find((c) => c.companyId === companyId);
        if (entry) entry.revenue = printed;
        for (const run of runBasis.breakdown) {
          const revenue = num(run.printed_revenue);
          if (bestRun === null || revenue > bestRun.revenue) {
            bestRun = { holder: company.president ?? null, ticker: company.ticker, model: run.model, revenue, round: roundLabelOf(before) };
          }
        }
        const routes = Array.isArray(body.routes) ? (body.routes as Array<Array<{ hex?: string }>>) : [];
        lastRoutes.set(companyId, new Set(routes.flat().map((stop) => stop?.hex ?? "").filter(Boolean)));
      }
    }

    /* TRACK BOSS: tiles and tokens, by whoever dispatched them. */
    if ((kind === "LayTile" || kind === "PlaceStationToken") && actor) bump(tilesAndTokens, actor, 1);

    /* MARKET MANIPULATOR: certificates that changed hands, read off the holdings diff. */
    if ((kind === "BuyStock" || kind === "SellStock") && actor) {
      let blocks = 0;
      for (const company of after.public_companies) {
        const now = company.player_holdings.find((h) => h.player === actor)?.percentage ?? 0;
        const was = companyById(before, company.company_id)?.player_holdings.find((h) => h.player === actor)?.percentage ?? 0;
        blocks += Math.abs(now - was) / SHARE_BLOCK;
      }
      bump(sharesTraded, actor, blocks);
      /* #1429: THE GREATER FOOL and THE HUMAN STOP-LOSS -- the trade, priced by what the actor's cash actually
         moved, to be judged later against the next Stock Round's sample. */
      const companyId = Number(body.protocol_id);
      const moved = Math.abs((cashOf(after, actor) ?? 0) - (cashOf(before, actor) ?? 0));
      if (blocks > 0 && moved > 0) {
        trades.push({ actor, companyId, blocks, perShare: moved / blocks, atIndex: entry.index, side: kind === "BuyStock" ? "buy" : "sell" });
      }
    }

    /* TRAIN ROBBER: a president sells out of a trainless corporation and the presidency passes. */
    if (kind === "SellStock" && actor) {
      const companyId = Number(body.protocol_id);
      const was = companyById(before, companyId);
      const now = companyById(after, companyId);
      if (
        was && now && was.president === actor && (was.owned_trains?.length ?? 0) === 0 && was.is_floated &&
        now.president !== null && now.president !== actor
      ) {
        bump(dumps, actor, 1);
      }
    }

    /* GRAVEDIGGER and THE RUST BELT (#1422): trains rusted or discarded to the limit, read by the same diff
       the fleet-loss notices use -- which already leaves out a sold train (#1245) and one the Yellow Sign took
       (#1264), and under Gentle Rust reports the reprieve as the rust event (#979) -- which, since #1704, these
       tallies do NOT book: see the note below. A trade-in's returned
       model is taken out here: it left the roster, but nobody scrapped it. The loser is the corporation's
       president; the cause is whoever dispatched the purchase that turned the phase.
       #1702 (GR-3, U-6): THE DIESEL TRADE-IN NO LONGER REACHES THIS DIFF -- the narrator splices it out, as it
       does a sale and the Sign's Mark, because it was being told as a rust (standard, first Diesel) or a limit
       discard (Gentle Rust). So it is not "returned" here any more (taking it out a second time would take out a
       4 that really rusted beside it), and its ledger fate is read off the message below. The scrap tallies are
       unchanged; the one fate that moves is a first-Diesel trade-in on a standard table, which the old diff
       filed as "rusted" and is "traded". */
    /* ==================================================================
        DESIGN NOTE 1704: UNDER GENTLE RUST A TRAIN IS LOST WHEN IT IS DESTROYED (owner ruling U-9, 2026-09-24)
       ==================================================================
       RULED: "U-9 uses DESTRUCTION-TIME accounting. A Gentle Rust train counts as RUSTED / LOST for the fleet
       ledger, Rust Belt and Gravedigger only when the train is actually permanently removed at the end of its
       qualifying Final Run. Merely entering `pending_rust_trains` / Final Run does NOT yet count as the train
       having been lost from the corporation. If the game ends while the Final Run train still exists in
       `owned_trains`, that train is KEPT, not both RUSTED and KEPT."
       THE RULING RESTORES #1414 AND #1422, which this block had drifted from under Gentle Rust: a rusted train
       is "one that actually left the roster" (#1414), the Gravedigger SENDS trains to the scrapheap and the Rust
       Belt LOST them (#1422). #979's "the reprieve is the rust event" is a NARRATION rule -- the Activity Log still
       says "rusted" at the phase change (GR-S27) -- and it was never a ruling about these tallies.
       SO, ON A GENTLE RUST TABLE: the fleet-loss diff's `rusted` (the newly MARKED models) books nothing here; the
       destruction does, read off `describeReprieveExpiries` -- the same shared answer the Rust modal fires on
       (#1099), which reports only marked copies that left the roster, by multiset, at the Run Routes expiry or
       either turn-end fallback. At that entry: the fate is "rusted"; the LOSS is charged to the corporation's
       president AT DESTRUCTION (the one who actually loses it); the CAUSE is the player whose purchase brought in
       the tier that rusts this model (`rustCauseByTier`) -- never the destruction entry's own actor, who may be
       the victim, a derived step, or nobody.
       WHY THE TIER IDENTIFIES THE CAUSE WITHOUT TRAIN IDENTITY: each model rusts at exactly one event -- the first
       4 (2s), the first 6 (3s), the first D (4s) -- and every copy held then is marked by it (GR-S5); no copy of a
       doomed model can be acquired afterwards (queue rule, pool scrap, OD-GR-1). So "the purchase that turned the
       phase to the rusting tier" is the one purchase that doomed every destroyed copy of that model, whichever
       corporation and however many copies. Reconstructed from the log as it replays: no reducer state, no train
       identity, multiplicity preserved by counting each destroyed copy.
       STANDARD TABLES ARE UNTOUCHED: marking and destruction coincide there, and the branch below is the old code.
       A trade-in, a sale, the president's excess discard and the Yellow Sign's takings keep their own fates and
       never reach either list. Derived statistics only: no board, message or digest changes. */
    const gentleTable = resolveVariants(after.variants).gentleRust;
    {
      const tierBefore = derivePhase(before)?.tier ?? null;
      const tierAfter = derivePhase(after)?.tier ?? null;
      if (tierBefore !== null && tierAfter !== null && tierAfter !== tierBefore) rustCauseByTier.set(tierAfter, actor);
    }
    if (kind !== "YellowSignEvent") {
      const returned =
        kind === "BuyHardwareFromPool" && typeof body.returned_model_type === "string" ? body.returned_model_type
        : null;
      for (const loss of describeFleetLosses(before, after, msg ?? undefined)) {
        // #1704: under Gentle Rust these are the MARKS -- rusted, still owned; booked at their destruction below.
        const rusted = gentleTable ? [] : loss.rusted;
        // #1431: the ledger's fates, before the trade-in is taken out of the scrap count below.
        for (const model of rusted) fate(loss.companyId, model, "rusted");
        for (const model of loss.discarded) {
          if (returned && Number(body.protocol_id) === loss.companyId && model === returned) fate(loss.companyId, model, "traded");
          else fate(loss.companyId, model, "discarded");
        }
        const scrapped = [...rusted, ...loss.discarded];
        if (returned && Number(body.protocol_id) === loss.companyId) {
          const at = scrapped.indexOf(returned);
          if (at >= 0) scrapped.splice(at, 1);
        }
        const president = companyById(before, loss.companyId)?.president ?? null;
        for (const model of scrapped) {
          const tier = trainTier(model);
          const value = tier ? depotCostFor(before, tier) : 0;
          if (president) {
            bump(trainsLostCount, president, 1);
            bump(trainsLostValue, president, value);
          }
          if (actor) {
            bump(trainsSentCount, actor, 1);
            bump(trainsSentValue, actor, value);
          }
        }
      }
      // #1704: the Gentle Rust destruction -- the train actually leaves the roster here.
      if (gentleTable) {
        for (const expiry of describeReprieveExpiries(before, after)) {
          const president = companyById(before, expiry.companyId)?.president ?? null;
          for (const model of expiry.rusted) {
            fate(expiry.companyId, model, "rusted");
            const tier = trainTier(model);
            const value = tier ? depotCostFor(before, tier) : 0;
            const rustedBy = tier ? (depotInventory(before).find((row) => row.tier === tier)?.rustedBy ?? null) : null;
            const cause = rustedBy === null ? null : (rustCauseByTier.get(rustedBy) ?? null);
            if (president) {
              bump(trainsLostCount, president, 1);
              bump(trainsLostValue, president, value);
            }
            if (cause) {
              bump(trainsSentCount, cause, 1);
              bump(trainsSentValue, cause, value);
            }
          }
        }
      }
    }

    /* THE WALL: a token that fills a city's last slot on a hex some other corporation's run stood in. */
    if (kind === "PlaceStationToken" && actor) {
      const q = Number(body.q);
      const r = Number(body.r);
      const city = Number(body.city_index ?? 0);
      const slots = citySlotCount(engine.snapshot.grid, q, r, city);
      const occupied = after.public_companies.reduce(
        (count, company) => count + (company.station_tokens ?? []).filter((t) => t[0] === q && t[1] === r && (t[2] ?? 0) === city).length,
        0,
      );
      const label = hexLabel(q, r);
      const placedBy = Number(body.protocol_id);
      const somebodyRunsHere =
        label !== null &&
        Array.from(lastRoutes.entries()).some(([companyId, hexes]) => companyId !== placedBy && hexes.has(label));
      if (slots > 0 && occupied >= slots && somebodyRunsHere) bump(walls, actor, 1);
    }

    /* ---- #1416 ---- */

    /* CAPITALIST PIG: the times, not the dollars (the autopsy has the dollars). */
    if (kind === "DeclareDividends" && body.distribute !== true) bump(withheldTimes, String(body.protocol_id), 1);

    /* PHASE RUSHER: whoever dispatched the action under which the phase moved. Only a train purchase can. */
    if (actor) {
      const tierBefore = derivePhase(before)?.tier ?? null;
      const tierAfter = derivePhase(after)?.tier ?? null;
      // The deal sets the first phase; that is nobody's purchase.
      if (tierBefore !== null && tierAfter !== null && tierAfter !== tierBefore) {
        bump(phaseMoves, actor, 1);
        phaseTiers.set(actor, [...(phaseTiers.get(actor) ?? []), tierAfter]);
      }
    }

    /* FLEET ADMIRAL, SALVAGER, EARLY ADOPTER: trains that joined a roster, and how. */
    for (const company of after.public_companies) {
      const was = companyById(before, company.company_id);
      const gained = trainsRemoved(company.owned_trains ?? [], was?.owned_trains ?? []); // after minus before
      if (gained.length === 0) continue;
      bump(trainsBought, String(company.company_id), gained.length);
      /* #1431: what this gain cost, split across the models gained (one, in every case but a multi-train
         buy summarised as one message). The treasury drop plus, on a forced buy, the president's own cash. */
      const drop = Math.max(0, num(was?.treasury) - num(company.treasury));
      const personal =
        kind === "EmergencyBuyHardware" && actor && Number(body.protocol_id) === company.company_id
          ? Math.max(0, (cashOf(before, actor) ?? 0) - (cashOf(after, actor) ?? 0))
          : 0;
      for (const model of gained) {
        bump(ledgerCount, `${company.company_id}:${model}`, 1);
        bump(ledgerPaid, `${company.company_id}:${model}`, (drop + personal) / gained.length);
      }
      if (firstDiesel === null && gained.some((model) => trainTier(model) === "D")) {
        firstDiesel = { companyId: company.company_id, ticker: company.ticker, president: company.president ?? null, round: roundLabelOf(before) };
      }
    }
    if (kind === "ExchangeTrainForDiesel" || (kind === "BuyHardwareFromPool" && typeof body.returned_model_type === "string" && body.returned_model_type)) {
      bump(tradeIns, String(body.protocol_id), 1);
    }
    /* #1431 / #1702 (GR-3, U-6): the traded-in train's fate, from the message -- the fleet-loss diff above no
       longer carries it. Only when the exchange actually took that model off the roster. */
    if (kind === "ExchangeTrainForDiesel") {
      const companyId = Number(body.protocol_id);
      const model = String(body.model_type ?? "");
      const removed = trainsRemoved(companyById(before, companyId)?.owned_trains ?? [], companyById(after, companyId)?.owned_trains ?? []);
      if (model && removed.includes(model)) fate(companyId, model, "traded");
    }

    /* #1429: TRAIN SPEND, for the White Elephant and the Little Engine -- what the buying corporation's treasury
       gave up, plus what its president put in on a forced buy. */
    if (kind === "BuyHardwareFromPool" || kind === "EmergencyBuyHardware" || kind === "ExchangeTrainForDiesel" || kind === "BuyTrainFromCorporation") {
      const buyerId = Number(kind === "BuyTrainFromCorporation" ? body.buyer_protocol_id : body.protocol_id);
      const drop = num(companyById(before, buyerId)?.treasury) - num(companyById(after, buyerId)?.treasury);
      if (drop > 0) bump(trainSpend, String(buyerId), drop);
      if (kind === "EmergencyBuyHardware" && actor) {
        const personal = (cashOf(before, actor) ?? 0) - (cashOf(after, actor) ?? 0);
        if (personal > 0) bump(trainSpend, String(buyerId), personal);
      }
    }

    /* FUNDRAISER: the president's own cash that went into a forced purchase. */
    if (kind === "EmergencyBuyHardware" && actor) {
      const paid = (cashOf(before, actor) ?? 0) - (cashOf(after, actor) ?? 0);
      if (paid > 0) bump(outOfPocket, actor, paid);
    }

    /* CORPORATE RAIDER: a purchase that took the presidency off somebody else. */
    if (kind === "BuyStock" && actor) {
      const companyId = Number(body.protocol_id);
      const was = companyById(before, companyId)?.president ?? null;
      const now = companyById(after, companyId)?.president ?? null;
      if (was !== null && was !== actor && now === actor) bump(raids, actor, 1);
    }

    /* MOUNTAIN MOVER and LAST CALL: what a lay cost the treasury, and whether it emptied the tray of that tile. */
    if (kind === "LayTile" && actor) {
      const companyId = Number(body.protocol_id);
      const spent = num(companyById(before, companyId)?.treasury) - num(companyById(after, companyId)?.treasury);
      if (spent > 0) bump(terrainSpent, actor, spent);
      const tileId = Number(body.tile_id);
      const grid = engine.snapshot.grid;
      const stock = Number.isFinite(tileId) ? withRules(resolveVariants(after.variants), () => tileStock(grid, tileId)) : null;
      if (stock && stock.remaining === 0 && stock.printed > 0) bump(lastCopies, actor, 1);
    }

    /* CARCOSAN RAILWAYS and THE REDEEMER (#1421): a stage of the sign lands on the president of the corporation
       it happened to; the Blood Price is a corporation buying a train the seller's `carcosan_trains` names. */
    if (kind === "YellowSignEvent") {
      const company = companyById(before, Number(body.protocol_id));
      const companyAfter = companyById(after, Number(body.protocol_id));
      /* Design note #1661 (S9-1): THE MESSAGE NO LONGER CARRIES THE OUTCOME on a pinned board -- the reducer
         derives it -- so this reads the board it moved and falls back to the stored fields for the corpus's
         unpinned entries, which still carry them. One reader, both eras. */
      const applied = yellowSignStageApplied(company, companyAfter);
      const stage = applied?.stage ?? String(body.stage);
      const takenModel =
        applied?.model ?? (typeof body.model === "string" && body.model ? body.model : null);
      if (takenModel && (stage === "mark" || stage === "fog")) {
        fate(Number(body.protocol_id), takenModel, "taken"); // #1431
      }
      const bearer = company?.president ?? null;
      const tookEffect = companyAfter !== undefined && company !== undefined && companyAfter !== company;
      if (bearer && tookEffect && ["mark", "carcosa", "fog"].includes(stage)) {
        bump(signStages, bearer, 1);
        signStageNames.set(bearer, [...(signStageNames.get(bearer) ?? []), stage]);
      }
    }
    /* UR-3 (OD-UR-1, OD-UR-2): ON A PINNED TABLE NO `YellowSignEvent` REACHES THE LOG. The Mark and the gift ride the
       run's entry (read off the record it wrote, never off a fleet diff a Final Run expiry shares), and the fog falls
       at the end of an Operating-Round set (`describeFogAtSetEnd`). Booked exactly as the request's entry above books
       them -- the same fate, the same stage on the same bearer -- so what the accolades count is unchanged (OD-UR-6 is
       open); only where the event is found has moved. */
    if (kind === "RunMultipleRoutes") {
      const companyId = Number(body.protocol_id);
      const record = runYellowSignWritten(before, after, companyId);
      if (record) {
        if (record.stage === "mark") fate(companyId, record.model, "taken");
        const bearer = companyById(before, companyId)?.president ?? null;
        if (bearer) {
          bump(signStages, bearer, 1);
          signStageNames.set(bearer, [...(signStageNames.get(bearer) ?? []), record.stage]);
        }
      }
    }
    for (const fog of describeFogAtSetEnd(before, after)) {
      for (const model of fog.models) fate(fog.companyId, model, "taken");
      const bearer = companyById(before, fog.companyId)?.president ?? null;
      if (bearer) {
        bump(signStages, bearer, 1);
        signStageNames.set(bearer, [...(signStageNames.get(bearer) ?? []), "fog"]);
      }
    }
    if (kind === "BuyTrainFromCorporation") {
      fate(Number(body.seller_protocol_id), String(body.model_type), "sold"); // #1431
      const seller = companyById(before, Number(body.seller_protocol_id));
      const buyer = companyById(before, Number(body.buyer_protocol_id));
      const model = String(body.model_type);
      const moved = trainsRemoved(seller?.owned_trains ?? [], companyById(after, Number(body.seller_protocol_id))?.owned_trains ?? []);
      if (seller && buyer?.president && (seller.carcosan_trains ?? []).includes(model) && moved.includes(model)) {
        bump(bloodPrices, buyer.president, 1);
      }
      /* #1438: SALT and SUGAR -- the price against the depot's, credited to the buying president. The price is
         what the buyer's treasury actually gave up (the message's figure, failing that). */
      if (buyer?.president && moved.includes(model)) {
        const tier = trainTier(model);
        const depot = tier ? depotCostFor(before, tier) : 0;
        const drop = num(buyer.treasury) - num(companyById(after, buyer.company_id)?.treasury);
        const price = drop > 0 ? drop : num(body.price);
        if (depot > 0 && price > 0 && price < depot) {
          bump(saltCount, buyer.president, 1);
          bump(saltSaved, buyer.president, depot - price);
        } else if (depot > 0 && price > depot) {
          bump(sugarCount, buyer.president, 1);
          bump(sugarSpent, buyer.president, price - depot);
        }
      }
    }

    /* The samples themselves. */
    const key = roundKey(after);
    if (key !== lastKey) {
      lastKey = key;
      /* The AUCTION is skipped as a sample: nobody has a price yet and the cash there is the starting cash. */
      if (after.current_round_type === "OperatingRound" || after.current_round_type === "StockRound") {
        rounds.push(sample(after, roundLabelOf(after), entry.index));
      }
    }
  }

  const final = engine.snapshot.state;
  if (entries.length > 0) rounds.push(sample(final, "Final", lastIndex));

  /* ---- #1416: every accolade in the catalogue, from its tally ---- */

  const companyTicker = (id: string | number) => companyById(final, Number(id))?.ticker ?? null;
  const companyPresident = (id: string | number) => companyById(final, Number(id))?.president ?? null;

  /** A player accolade off a tally: the leader, the runner-up, and whether the top was shared. */
  const playerAccolade = (key: AccoladeKey, tally: Tally, detail: (n: number, holder: string) => string): Accolade => {
    const order = ranked(tally);
    if (order.length === 0) return unearned(key);
    const [holder, value] = order[0];
    const runnerUp = order[1]?.[1] ?? null;
    return { ...unearned(key), holder, value, runnerUp, tied: runnerUp === value, detail: detail(value, holder) };
  };
  /** A corporate accolade off a tally keyed by company id; the holder is the corporation's final president. */
  const corporateAccolade = (
    key: AccoladeKey,
    tally: Tally,
    detail: (n: number, ticker: string) => string,
  ): Accolade => {
    const spec = ACCOLADE_SPEC_BY_KEY.get(key)!;
    const order = ranked(tally, spec.direction);
    if (order.length === 0) return unearned(key);
    const [id, value] = order[0];
    const runnerUp = order[1]?.[1] ?? null;
    const ticker = companyTicker(id) ?? `#${id}`;
    const holder = companyPresident(id);
    // A corporation with nobody to hand it to (closed, or never floated) earns nothing.
    if (holder === null) return unearned(key);
    return {
      ...unearned(key),
      holder,
      companyId: Number(id),
      ticker,
      value,
      runnerUp,
      tied: runnerUp === value,
      detail: detail(value, ticker),
    };
  };
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

  // The final state's own tallies.
  const presidencies: Tally = new Map();
  const cashShare: Tally = new Map();
  const stockShare: Tally = new Map();
  const finalPrice: Tally = new Map();
  for (const company of final.public_companies) {
    if (!company.is_floated) continue;
    if (company.president) bump(presidencies, company.president, 1);
    const price = priceOf(final, company.company_id);
    if (price !== null && price > 0) finalPrice.set(String(company.company_id), price);
  }
  /** The company id a corporate tally's leader belongs to, for a detail that needs a second lookup. */
  const accoladeCompanyId = (tally: Tally, direction: "highest" | "lowest" = "highest") => ranked(tally, direction)[0]?.[0] ?? "";
  const finalSample = rounds[rounds.length - 1];
  for (const player of finalSample?.players ?? []) {
    if (player.netWorth === null || player.netWorth <= 0 || player.cash === null || player.stockValue === null) continue;
    cashShare.set(player.address, Math.round((player.cash / player.netWorth) * 100));
    stockShare.set(player.address, Math.round((player.stockValue / player.netWorth) * 100));
  }
  /* ---- #1429 ---- */
  const finalPlayers = finalSample?.players ?? [];
  const bagholder: Tally = new Map();
  const wrongWay: Tally = new Map();
  const orphans: Tally = new Map();
  /* #1438: THE BAGHOLDER -- for every certificate held at the end, what its price lost over the last two
     Operating Round SETS, summed where it fell. CLARIFIED: "if game ends on OR 9.3, this award checks from
     OR 8.1 to 9.3 (including the stock round)" -- so the reference is the opening of the set BEFORE the
     final one, and the window takes in the Stock Round between them. A game too short to have two sets
     measures from its first OR. */
  const lastOr = [...rounds].reverse().find((r) => r.label.startsWith("OR "));
  const lastSet = lastOr ? Number(lastOr.label.slice(3).split(".")[0]) : NaN;
  const twoBack =
    (Number.isFinite(lastSet) ? rounds.find((r) => r.label === `OR ${lastSet - 1}.1`) : undefined) ??
    rounds.find((r) => r.label.startsWith("OR ")) ??
    null;
  for (const player of finalPlayers) {
    if (twoBack) {
      let lost = 0;
      for (const corp of finalSample?.corporations ?? []) {
        const held = corp.holdings.find(([address]) => address === player.address)?.[1] ?? 0;
        const then = twoBack.corporations.find((c) => c.companyId === corp.companyId)?.price ?? null;
        if (held > 0 && then !== null && corp.price !== null && corp.price < then) lost += (then - corp.price) * (held / SHARE_BLOCK);
      }
      // The minimum is 5% of the player's own final net worth -- a $40 dip on a $5,000 finish is not a bag.
      if (lost > 0 && player.netWorth !== null && lost >= player.netWorth * 0.05) bagholder.set(player.address, Math.round(lost));
    }
    let peak = 0;
    for (const round of rounds) {
      const then = round.players.find((p) => p.address === player.address)?.netWorth ?? 0;
      peak = Math.max(peak, then);
    }
    if (player.netWorth !== null && peak > 0 && player.netWorth < peak) {
      wrongWay.set(player.address, Math.round(((peak - player.netWorth) / peak) * 100));
    }
    let certificates = 0;
    for (const corp of finalSample?.corporations ?? []) {
      if (corp.president === player.address) continue;
      const held = corp.holdings.find(([address]) => address === player.address)?.[1] ?? 0;
      certificates += Math.floor(held / SHARE_BLOCK);
    }
    if (certificates > 0) orphans.set(player.address, certificates);
  }
  /* #1438: THE CAPITALIST PIG -- what share prices made the player: every sale's proceeds plus the final
     value of what they still hold, less every purchase's cost. Dividends are the Railroad Baron's, not this. */
  const appreciation: Tally = new Map();
  for (const trade of trades) bump(appreciation, trade.actor, (trade.side === "sell" ? 1 : -1) * trade.perShare * trade.blocks);
  for (const player of finalPlayers) if (player.stockValue !== null) bump(appreciation, player.address, player.stockValue);
  appreciation.forEach((value, address) => appreciation.set(address, Math.round(value)));
  // The trades, judged against the next Stock Round's price.
  const fools: Tally = new Map();
  const stopLosses: Tally = new Map();
  for (const trade of trades) {
    const nextSr = rounds.find((r) => r.label.startsWith("SR ") && r.atIndex > trade.atIndex);
    const later = nextSr?.corporations.find((c) => c.companyId === trade.companyId)?.price ?? null;
    if (later === null) continue;
    if (trade.side === "buy" && later < trade.perShare) bump(fools, trade.actor, Math.round((trade.perShare - later) * trade.blocks));
    if (trade.side === "sell" && later > trade.perShare) bump(stopLosses, trade.actor, Math.round((later - trade.perShare) * trade.blocks));
  }
  /* The corporate five. #1431: PAYBACK, NOT A RATE. A per-round rate had no baseline -- "what is 0.67 a unit
     of?" -- and rewarded a Diesel bought for $900 and run once for $600 as efficient. What the White Elephant
     is about is whether the fleet earned its own price: `revenue - train spend`. The most negative wins; a
     game where every fleet paid for itself has no White Elephant. The Little Engine is the smallest float
     that earned back both its float and its trains. */
  const shortfall: Tally = new Map(); // train spend - revenue, where positive
  const littleEngine: Tally = new Map();
  const comeback: Tally = new Map();
  const comebackLow = new Map<string, number>();
  for (const company of final.public_companies) {
    if (!company.is_floated) continue;
    const id = String(company.company_id);
    const spend = trainSpend.get(id) ?? 0;
    const revenue = lifetimeRevenue.get(id) ?? 0;
    if (spend > revenue) shortfall.set(id, spend - revenue);
    const par = num(company.par_value);
    if (par > 0 && spend > 0 && revenue > par * SHARE_BLOCK && revenue > spend) {
      // Lowest par wins; the fraction breaks a tie toward the better payback without ever crossing a par step.
      littleEngine.set(id, par - Math.min(0.99, (revenue - spend) / 10_000));
    }
    let low: number | null = null;
    for (const round of rounds) {
      const then = round.corporations.find((c) => c.companyId === company.company_id);
      if (!then?.floated || then.price === null) continue;
      if (low === null || then.price < low) low = then.price;
    }
    const finalPrice = priceOf(final, company.company_id);
    if (low !== null && finalPrice !== null && finalPrice > low) {
      comeback.set(id, finalPrice - low);
      comebackLow.set(id, low);
    }
  }

  // Fleet Admiral breaks a tie on the value of the final fleet.
  const fleetValue = (id: string) =>
    (companyById(final, Number(id))?.owned_trains ?? []).reduce((sum, model) => {
      const tier = trainTier(model);
      return sum + (tier ? depotCostFor(final, tier) : 0);
    }, 0);
  const fleetTally: Tally = new Map();
  trainsBought.forEach((count, id) => fleetTally.set(id, count + fleetValue(id) / 1_000_000));

  // #1422: both obsolescence awards rank by dollars, in the ruled words.
  /* #1438: the daddies. Count first, the dollars break the tie (the fraction trick Fleet Admiral uses); the
     two never share a holder. */
  const daddyTally = (count: Tally, dollarsTally: Tally, except: string | null): Tally => {
    const out: Tally = new Map();
    count.forEach((n, holder) => {
      if (holder !== except) out.set(holder, n + Math.min(0.999, (dollarsTally.get(holder) ?? 0) / 1_000_000));
    });
    return out;
  };
  const daddyDetail = (dollarsTally: Tally, word: string) => (n: number, holder: string) =>
    `${plural(Math.floor(n), "one train", "trains")} bought off other corporations, ${dollars(dollarsTally.get(holder) ?? 0)} ${word} against the depot`;
  let salt = playerAccolade("salt-daddy", daddyTally(saltCount, saltSaved, null), daddyDetail(saltSaved, "saved"));
  let sugar = playerAccolade("sugar-daddy", daddyTally(sugarCount, sugarSpent, null), daddyDetail(sugarSpent, "over"));
  if (salt.holder !== null && salt.holder === sugar.holder) {
    const keepSalt = (saltSaved.get(salt.holder) ?? 0) >= (sugarSpent.get(salt.holder) ?? 0);
    if (keepSalt) sugar = playerAccolade("sugar-daddy", daddyTally(sugarCount, sugarSpent, salt.holder), daddyDetail(sugarSpent, "over"));
    else salt = playerAccolade("salt-daddy", daddyTally(saltCount, saltSaved, sugar.holder), daddyDetail(saltSaved, "saved"));
  }
  for (const daddy of [salt, sugar]) {
    daddy.value = Math.floor(daddy.value);
    daddy.runnerUp = daddy.runnerUp === null ? null : Math.floor(daddy.runnerUp);
    daddy.tied = false; // the dollars broke it; a true dead heat on both is vanishingly rare and the higher seat keeps it
  }

  const gravedigger = playerAccolade("gravedigger", trainsSentValue, (n) => `Laid waste to ${dollars(n)} of trains through rust and limits.`);
  const rustBelt = playerAccolade("rust-belt", trainsLostValue, (n) => `Lost ${dollars(n)} worth of trains to obsolescence.`);
  const accolades: Accolade[] = [
    playerAccolade("robber-baron", dividendsReceived, (n) => `${dollars(n)} in dividends`),
    bestRun && bestRun.holder
      ? {
          ...unearned("master-of-the-line"),
          holder: bestRun.holder,
          value: bestRun.revenue,
          detail: `${dollars(bestRun.revenue)} on ${bestRun.ticker}'s ${bestRun.model}-train (${bestRun.round})`,
        }
      : unearned("master-of-the-line"),
    playerAccolade("track-boss", tilesAndTokens, (n) => `${n} tiles and tokens`),
    playerAccolade("market-manipulator", sharesTraded, (n) => `${n} certificates bought and sold`),
    corporateAccolade("workhorse", lifetimeRevenue, (n, ticker) => `${ticker} ran ${dollars(n)} over the game`),

    gravedigger,
    rustBelt,
    playerAccolade("train-robber", dumps, (n) => plural(n, "one trainless presidency dumped", "trainless presidencies dumped")),
    playerAccolade("the-wall", walls, (n) => plural(n, "one city walled off", "cities walled off")),
    playerAccolade("phase-rusher", phaseMoves, (n, holder) => `brought in the ${(phaseTiers.get(holder) ?? []).map((t) => `${t}s`).join(", ")}`),
    playerAccolade("fundraiser", outOfPocket, (n) => `${dollars(n)} from their own pocket`),
    playerAccolade("corporate-raider", raids, (n) => plural(n, "one presidency taken", "presidencies taken")),
    playerAccolade("mr-monopoly", presidencies, (n) => `${n} presidencies at the end`),
    playerAccolade("mountain-mover", terrainSpent, (n) => `${dollars(n)} on terrain`),
    playerAccolade("last-call", lastCopies, (n) => plural(n, "one tray emptied", "trays emptied")),
    playerAccolade("scrooge", cashShare, (n) => `${n}% of their worth in cash`),
    playerAccolade("paper-millionaire", stockShare, (n) => `${n}% of their worth in stock`),
    // A president who paid the Blood Price is the Redeemer, not a Carcosan.
    playerAccolade(
      "carcosan-railways",
      new Map(Array.from(signStages.entries()).filter(([holder]) => !bloodPrices.has(holder))),
      /* RULED: player-facing, not devspeak -- "Marked by an Outer God" for the Mark alone, "Rode off into the
         Fog" once the Gift (or the Fog) came. */
      (_, holder) => ((signStageNames.get(holder) ?? []).some((stage) => stage !== "mark") ? "Rode off into the Fog" : "Marked by an Outer God"),
    ),
    playerAccolade("redeemer", bloodPrices, (n) => plural(n, "one Blood Price paid", "Blood Prices paid")),
    playerAccolade("bagholder", bagholder, (n) => `Finished holding stocks that lost ${dollars(n)} in value over the last two rounds.`),
    playerAccolade("wrong-way-down", wrongWay, (n) => `${n}% down from their peak`),
    playerAccolade("orphanage", orphans, (n) => `${n} certificates in other people's corporations`),
    playerAccolade("passenger", passengerDividends, (n) => `${dollars(n)} in dividends from corporations they never ran`),
    playerAccolade("greater-fool", fools, (n) => `${dollars(n)} of paper lost by the next Stock Round`),
    playerAccolade("human-stop-loss", stopLosses, (n) => `${dollars(n)} of gains sold away before the next Stock Round`),
    playerAccolade("farmhand", animalRuns, (n) => plural(n, "one run-in with the wildlife", "run-ins with the wildlife")),
    // #1438
    playerAccolade("capitalist-pig", appreciation, (n) => `${dollars(n)} made on share prices`),
    salt,
    sugar,
    playerAccolade("railroad-baron", new Map(Array.from(everPresidentOf.entries()).map(([a, set]) => [a, set.size])), (n) => `${n} corporations run over the game`),

    firstDiesel && firstDiesel.president
      ? {
          ...unearned("early-adopter"),
          holder: firstDiesel.president,
          companyId: firstDiesel.companyId,
          ticker: firstDiesel.ticker,
          value: 1,
          detail: `${firstDiesel.ticker} bought the first Diesel (${firstDiesel.round})`,
        }
      : unearned("early-adopter"),
    corporateAccolade("juggernaut", peakRun, (n, ticker) => `${ticker} ran ${dollars(n)} in one round (${peakRunRound.get(String(accoladeCompanyId(peakRun))) ?? ""})`),
    corporateAccolade("golden-goose", payoutTimes, (n, ticker) => `${ticker} paid out ${plural(n, "once", "times")}`),
    corporateAccolade("dividend-machine", dividendsToPlayers, (n, ticker) => `${ticker} paid its shareholders ${dollars(n)}`),
    corporateAccolade("little-engine", littleEngine, (n, ticker) => `${ticker} floated at $${Math.round(n)} and earned it back`),
    corporateAccolade("white-elephant", shortfall, (n, ticker) => `${ticker} fell ${dollars(n)} short of paying for its trains`),
    corporateAccolade("comeback-kid", comeback, (n, ticker) => `${ticker} climbed ${dollars(n)} from a low of ${dollars(comebackLow.get(String(accoladeCompanyId(comeback))) ?? 0)}`),
    corporateAccolade("scrooge-company", withheldTimes, (n, ticker) => `${ticker} withheld ${plural(n, "once", "times")}`),
    corporateAccolade("fleet-admiral", fleetTally, (n, ticker) => `${ticker} bought ${Math.floor(n)} trains`),
    corporateAccolade("shell-corporation", finalPrice, (n, ticker) => `${ticker} closed at ${dollars(n)}`),
    corporateAccolade("salvager", tradeIns, (n, ticker) => `${ticker} traded in ${plural(n, "one train", "trains")}`),
  ];
  // Fleet Admiral's figure is the count; the fraction was the tie-break.
  const admiral = accolades.find((a) => a.key === "fleet-admiral")!;
  admiral.value = Math.floor(admiral.value);
  admiral.runnerUp = admiral.runnerUp === null ? null : Math.floor(admiral.runnerUp);

  /** #1431: one row per model the corporation ever owned, in tier order. */
  const fleetLedgerFor = (company: PublicCompanyState): FleetLedgerRow[] => {
    const models = new Set<string>();
    ledgerCount.forEach((_, key) => {
      if (key.startsWith(`${company.company_id}:`)) models.add(key.slice(key.indexOf(":") + 1));
    });
    for (const model of company.owned_trains ?? []) models.add(model);
    const order = ["2", "3", "4", "5", "6", "7", "D"];
    return Array.from(models)
      .sort((a, b) => order.indexOf(trainTier(a) ?? a) - order.indexOf(trainTier(b) ?? b))
      .map((model) => {
        const key = `${company.company_id}:${model}`;
        const fates = ledgerFate.get(key) ?? new Map<string, number>();
        const kept = (company.owned_trains ?? []).filter((owned) => owned === model).length;
        const acquired = ledgerCount.get(key) ?? 0;
        return {
          model,
          count: Math.max(acquired, kept),
          paid: Math.round(ledgerPaid.get(key) ?? 0),
          earned: ledgerEarned.get(key) ?? 0,
          trainRounds: ledgerRounds.get(key) ?? 0,
          fates: {
            rusted: fates.get("rusted") ?? 0,
            discarded: fates.get("discarded") ?? 0,
            sold: fates.get("sold") ?? 0,
            traded: fates.get("traded") ?? 0,
            taken: fates.get("taken") ?? 0,
            kept,
          },
        };
      });
  };

  /* #1436: "what is the ordering principle for the list of Corporations? I don't see it." It was the
     state's own numbering. Now it is the order they floated -- the Floated column reads downwards. */
  const autopsy: CorporationAutopsy[] = final.public_companies
    .filter((company) => company.is_floated)
    .sort((a, b) => (floatOrder.get(a.company_id) ?? 99) - (floatOrder.get(b.company_id) ?? 99) || a.company_id - b.company_id)
    .map((company) => ({
      companyId: company.company_id,
      ticker: company.ticker,
      floatRound: floatRound.get(company.company_id) ?? null,
      finalPresident: company.president ?? null,
      lifetimeRevenue: lifetimeRevenue.get(String(company.company_id)) ?? 0,
      dividendsPaid: dividendsPaid.get(String(company.company_id)) ?? 0,
      withheld: withheld.get(String(company.company_id)) ?? 0,
      fleet: [...(company.owned_trains ?? [])],
      treasury: num(company.treasury),
      payback: (lifetimeRevenue.get(String(company.company_id)) ?? 0) - (trainSpend.get(String(company.company_id)) ?? 0),
      fleetLedger: fleetLedgerFor(company),
    }));

  return {
    rounds,
    players: final.player_addresses.slice(),
    corporations: final.public_companies.map((company) => ({ companyId: company.company_id, ticker: company.ticker })),
    accolades,
    ceremony: selectCeremony(accolades, final.player_addresses),
    autopsy,
  };
}
