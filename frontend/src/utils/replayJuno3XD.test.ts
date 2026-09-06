// frontend/src/utils/replayJuno3XD.test.ts
//
// Item 24, asked of the log rather than of memory.
//
// ==================================================================
//  DESIGN NOTE 1187: THE FIRST QUESTION THE HARNESS WAS BUILT FOR
// ==================================================================
//
// REPORTED, from the playtest: "our Last Runs are printing wildly different numbers from what anyone
// actually ran", with the honest caveat that the game may be too corrupted to tell.
//
// THERE IS A MECHANISM THAT PRODUCES EXACTLY THAT SYMPTOM WITH NOTHING BROKEN, and this room has it.
// `last_route_revenue` is the VARIANT-ADJUSTED figure -- #903 applies the die there, and `gameState.ts`
// #1028 is explicit that "Last Run" is a claim about money rather than about printed route value. This room
// ran with `unpredictableRevenue: true`. On top of that the roll is applied to `printedTotal`, which
// ACCUMULATES within a turn (#968, deliberately, so a corporation that runs twice does not lose the money).
// Indices 318/319 are the proof: the same run twice under one `revenue_turn`, so the second roll landed on
// 540 rather than on 270.
//
// SO THE TEST IS A COMPARISON, NOT AN ASSERTION ABOUT A NUMBER. Replay the log and set each corporation's
// filed run beside the figure its own `DeclareDividends` carried. Those two are produced by different paths
// -- one by the reducer, one by the dispatching client at the time -- and they should agree except where a
// known mechanism explains the gap.
//
// IT BEGAN AS AN INSTRUMENT AND IS NOW A GUARD, and the transition is worth recording because the reasoning
// inverted. While the replay was unfaithful, failing on a mismatch would have meant a red suite asserting
// "the past is wrong" on every run, so this file printed and did not assert.
//
// THE REPLAY IS NOW FAITHFUL (#1194): 29 of 29 runs reproduce the cursor the live game stamped on them, and
// all five corporations' filed runs reproduce their own final declarations exactly. Everything that was a
// printout describing a discrepancy is therefore now an assertion describing a fact.
//
// PINNED BEFORE PHASE 1, DELIBERATELY (#1195). Phase 1 folds the market chart into authoritative state and
// rewrites the path this replay takes; a golden master captured now proves that refactor changed the
// architecture and not the game. Captured afterwards it would certify whatever the refactor produced.

import { readFileSync } from "fs";
import { join } from "path";

import {
  entriesFromExport,
  replayLog,
  type ExportedEntry,
  type ReplayProviders,
} from "./replayLog";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxInitialMarketPrices,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "./sandboxState";
import { sandboxReplayProviders } from "./replayProviders";
import { waterfallForRoster, withEmptyRoster } from "./gameSetup";
import { MOCK_MAP_GRID } from "./mockFixtures";
import { resolveVariants, dividendStepsFor } from "./gameVariants";
import { turnSeedKey } from "./turnSeed";
import { derivePhase } from "./gamePhase";
import { operatingCorporationId } from "./dividendGate";
import {
  marketCellForPrice,
  marketZoneForPrice,
  parBoxCellFor,
  projectBloodPriceMove,
  projectDividendCellMove,
  projectRiseMove,
  projectShareSaleMove,
} from "../components/StockMarketRenderer";
import { filterSandboxPlacements } from "../components/sandboxTileLegality";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";

const GAME_ID = 0;

interface RawLog {
  roomCode: string;
  actionCount: number;
  duplicateIndices: number[];
  actions: ExportedEntry[];
}

function loadLog(): RawLog {
  /* The committed export, not a fixture. The point of the harness is that a REAL recorded game can be
     re-executed; a hand-authored log would only prove the harness agrees with whoever wrote it. */
  const path = join(__dirname, "..", "..", "sandbox-log-JUNO-3XD.json");
  return JSON.parse(readFileSync(path, "utf8")) as RawLog;
}

/* #1199: the providers moved to `replayProviders.ts` so the Node server imports the SAME ones rather
   than assembling its own. A second set would be a second implementation of the chart geometry and the
   legality engine -- #1184, #1193 and #1194 are three separate occasions this project paid for exactly
   that. This file now tests the reducer through the providers the server will use. */
const buildProviders = sandboxReplayProviders;

describe("JUNO-3XD replays headless", () => {
  const log = loadLog();
  /* #1188: the export carries `msg`, the log carries `payload`. Normalised once, here, so every read below
     agrees about which field exists. */
  const entries = entriesFromExport(log.actions);

  const seedState = withEmptyRoster(
    sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, GAME_ID, "default"),
  );
  const seedWaterfall = waterfallForRoster(
    sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, GAME_ID, true),
    [],
  );

  /* #1191: every `RunMultipleRoutes` records the cursor the LIVE game held when it was sent. Collected on
     the way past so a divergence can be located at an index instead of inferred from a final figure. */
  const buyAttempts: Array<{
    index: number;
    company: string;
    treasury: string;
    floated: boolean;
    trainsHeld: number;
    /* #1192b: the three cursor conditions `trainPurchaseRefusal` tests BEFORE it looks at money. With
       treasuries at 920-1000 the funds arm is plainly not the one firing, so these are the suspects. */
    round: string;
    subPhase: string;
    actingCorp: number | null;
  }> = [];

  const turnKeyChecks: Array<{
    index: number;
    logged: string;
    replayed: string;
    /* #511: the set length is stamped ONCE when a cycle opens, from `operatingRoundsForPhase`. If the replay
       locks a shorter sequence than the live game did, its sets end early -- which is exactly the macro +1 /
       sub -1 signature. Captured beside the key so the two can be read together. */
    phase: string;
    setLength: number | undefined;
    trains: number;
    /* #1194: the queue itself. `buildOperatingOrder` filters on floated-with-a-president and sorts on three
       chart-derived keys; printing the resulting array says at once whether a corporation was excluded or
       merely mis-ordered. */
    order: string;
    corpIdx: number;
  }> = [];

  const result = replayLog(
    entries,
    buildProviders(),
    { state: seedState, waterfall: seedWaterfall },
    ({ entry, msg, stateBefore }) => {
      /* #1192b: the refusal reason, asked directly. `trainPurchaseRefusal` guards the arm on cost, train
         limit and funds -- so the treasury at the moment of each attempted purchase says which. */
      if ("BuyHardwareFromPool" in msg && buyAttempts.length < 10) {
        const id = (msg.BuyHardwareFromPool as { protocol_id: number }).protocol_id;
        const company = stateBefore.public_companies.find((c) => c.company_id === id);
        buyAttempts.push({
          index: entry.index,
          company: company?.ticker ?? `#${id}`,
          treasury: company?.treasury ?? "(undefined)",
          floated: company?.is_floated === true,
          trainsHeld: company?.owned_trains?.length ?? 0,
          round: stateBefore.current_round_type,
          subPhase: String(stateBefore.operating_sub_phase),
          actingCorp: operatingCorporationId(stateBefore),
        });
      }
      if (!("RunMultipleRoutes" in msg)) return;
      const run = msg.RunMultipleRoutes as { protocol_id: number; revenue_turn?: string };
      if (typeof run.revenue_turn !== "string" || run.revenue_turn === "") return;
      turnKeyChecks.push({
        index: entry.index,
        logged: run.revenue_turn,
        replayed: turnSeedKey(
          stateBefore.macro_round_number ?? 0,
          stateBefore.sub_round_index ?? 0,
          run.protocol_id,
        ),
        phase: derivePhase(stateBefore)?.tier ?? "?",
        setLength: stateBefore.operating_round_sequence_length,
        trains: stateBefore.public_companies.reduce(
          (sum, company) => sum + (company.owned_trains?.length ?? 0),
          0,
        ),
        order: JSON.stringify(stateBefore.active_operating_order ?? []),
        corpIdx: stateBefore.active_corporation_index,
      });
    },
  );

  it("reads the committed export intact", () => {
    expect(log.roomCode).toBe("JUNO-3XD");
    expect(log.actions).toHaveLength(log.actionCount);
    expect(log.duplicateIndices).toEqual([]);
    expect(log.actions.map((entry) => entry.index)).toEqual(
      log.actions.map((_entry, at) => at),
    );
  });

  it("parses every payload", () => {
    /* An unparseable entry is not allowed to be silent here even though the reducer tolerates one. The
       reducer's tolerance exists so a corrupt row cannot kill a live game (`turnSeed.ts`, `logRevert.ts`);
       a HARNESS that shrugged at one would be reporting on a game it had not fully read. */
    expect(result.unparseable).toEqual([]);
  });

  it("resolves the revert at index 20 rather than replaying it", () => {
    /* Index 20 is `RevertTo { index: 19 }`. #1026: a revert is an instruction about the log, never a game
       action -- so it is consumed by `effectiveActions` and the entry it kills goes with it. */
    expect(result.dropped).toBe(2);
    expect(result.applied).toBe(log.actionCount - 2);
  });

  it("agrees with the live game about which turn each run belonged to", () => {
    /* ==================================================================
        DESIGN NOTE 1191: THE FAITHFULNESS CHECK THE LOG PAYS FOR ITSELF
       ==================================================================
       `revenue_turn` is `macro.sub.company`, minted by the dispatching client from ITS cursor at the moment
       the run went out (#1051). It is therefore a recorded claim about the live game's state, and the replay
       either reproduces it or does not.
       THIS IS THE ONE ASSERTION THAT CATCHES A SILENT DIVERGENCE. A cursor one sub-round off does not throw;
       it changes `rollTurnRevenue`'s inputs and quietly produces different money, hundreds of entries later,
       with nothing pointing back at where it started. Here it fails at the first run that disagrees.
       NOT YET GREEN IS AN ACCEPTABLE STATE FOR THIS TEST TO REPORT, but never a silent one -- so the failure
       names every mismatching index rather than only the first. Six `isSandboxOnlyMsg` arms are still
       outstanding (#1189) and any of them could be the cause. */
    const mismatches = turnKeyChecks.filter((check) => check.logged !== check.replayed);
    if (mismatches.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `\nTURN-KEY DIVERGENCE — ${mismatches.length} of ${turnKeyChecks.length} runs\n` +
          turnKeyChecks
            .map(
              (c) =>
                `${c.logged === c.replayed ? "  ok " : "  XX "}idx ${String(c.index).padStart(3)}  ` +
                `logged ${c.logged.padEnd(8)} replayed ${c.replayed.padEnd(8)} ` +
                `phase ${c.phase} setLen ${c.setLength} trains ${c.trains} order ${c.order}@${c.corpIdx}`,
            )
            .join("\n"),
      );
    }
    // eslint-disable-next-line no-console
    console.log("\nTRAIN PURCHASE ATTEMPTS\n", JSON.stringify(buyAttempts, null, 2));
    expect(turnKeyChecks.length).toBeGreaterThan(20);
    expect(mismatches).toEqual([]);
  });

  it("prints filed run against declared amount for every corporation that ran", () => {
    /* THE COMPARISON ITEM 24 ASKS FOR. `last_completed_run_revenue` is written by the reducer as the die
       lands; `revenue_amount` is what the dispatching client sent with the declaration. Two paths, one
       figure -- and where they disagree, the accumulation (#968) or the die (#903) should be why. */
    const declaredByCompany = new Map<number, string[]>();
    for (const entry of entries) {
      const msg = JSON.parse(entry.payload) as Record<string, { protocol_id?: number; revenue_amount?: string }>;
      const declare = msg.DeclareDividends;
      if (!declare?.protocol_id) continue;
      const list = declaredByCompany.get(declare.protocol_id) ?? [];
      list.push(String(declare.revenue_amount ?? "?"));
      declaredByCompany.set(declare.protocol_id, list);
    }

    const rows = result.state.public_companies
      .filter((company) => declaredByCompany.has(company.company_id))
      .map((company) => ({
        ticker: company.ticker,
        id: company.company_id,
        filed: company.last_completed_run_revenue ?? "(undefined)",
        live: company.last_route_revenue ?? "(undefined)",
        printed: company.printed_route_revenue ?? "(undefined)",
        declarations: (declaredByCompany.get(company.company_id) ?? []).join(", "),
      }));

    // eslint-disable-next-line no-console
    console.log("\nITEM 24 — filed run vs declared amounts (JUNO-3XD)\n", JSON.stringify(rows, null, 2));

    /* ==================================================================
        DESIGN NOTE 1195: THE GOLDEN MASTER, PINNED BEFORE PHASE 1 AND NOT AFTER
       ==================================================================
       EVERY CORPORATION'S FILED RUN REPRODUCES ITS OWN FINAL DECLARATION, exactly. Two independent paths --
       the reducer as the die lands, and whatever the dispatching client sent at the time -- agreeing on all
       five figures, in a room that ran the unpredictable-revenue die on every turn. That is what "faithful"
       means and it is worth an assertion rather than a printout.
       THE TIMING IS THE POINT. Phase 1 folds the market chart into authoritative state, which rewrites the
       path this replay takes to get here. Pinned NOW, this table proves Phase 1 changed the ARCHITECTURE and
       not the GAME. Pinned afterwards it would only certify whatever Phase 1 happened to produce -- which is
       the difference between a regression test and a rubber stamp, and the whole reason the harness was
       built before the refactor rather than during it.
       NNH's 540 IS DELIBERATELY PINNED AS 540. It is the #1183 duplicate -- 270 twice -- and it is what the
       live game recorded. A golden master that quietly "corrected" it would be asserting a game nobody
       played. When #1183's refusal is applied to a rebuild the figure will change, and this line is exactly
       where that change should announce itself. */
    expect(
      rows.map((row) => [row.ticker, row.filed] as const),
    ).toEqual([
      ["PRR", "210"],
      ["NYC", "140"],
      ["B&O", "240"],
      ["C&O", "290"],
      ["NNH", "540"],
    ]);

    /* THE LAST DECLARATION IS THE ONE THE FILED FIGURE MUST MATCH, asserted as a relationship rather than as
       five more literals -- so a re-export of the log with different numbers still checks the property that
       matters instead of failing on arithmetic nobody changed. */
    for (const row of rows) {
      const declarations = row.declarations.split(", ");
      expect(row.filed).toBe(declarations[declarations.length - 1]);
    }

    /* #777's clear is guarded by `turnChanged`, which compares the round type and the three cursor fields
       across one action. If those never move, the clear never fires -- so before concluding anything about
       the reducer, look at whether this replay ever put the game into an Operating Round at all. */
    // eslint-disable-next-line no-console
    console.log(
      "\nCURSOR AT END\n",
      JSON.stringify(
        {
          round: result.state.current_round_type,
          macro: result.state.macro_round_number,
          sub: result.state.sub_round_index,
          corpIndex: result.state.active_corporation_index,
          order: result.state.active_operating_order,
          subPhase: result.state.operating_sub_phase,
          seats: result.state.player_addresses,
          floated: result.state.public_companies
            .filter((company) => company.is_floated)
            .map((company) => company.ticker),
        },
        null,
        2,
      ),
    );

    /* The instrument asserts only that it HAS an answer for every corporation that declared. What the
       numbers say is for a human to read; see the file header for why this does not fail on a mismatch. */
    expect(rows.length).toBe(declaredByCompany.size);
  });
});
