// server/src/replayCli.ts
//
// The reducer, in a bare Node process.
//
// ==================================================================
//  DESIGN NOTE 1200: THE FIRST THING PHASE 2 HAD TO PROVE
// ==================================================================
//
// PHASE 2 IS "PUT THE REDUCER ON A SERVER", and the tempting first move is to write a server. That would
// have been the wrong order: everything after it depends on an unasked question, which is whether the
// reducer can be LOADED into a Node process at all.
//
// IT WAS NOT AN IDLE WORRY. `applySandboxAction` imports `utils/gameState.ts`, and that module holds the
// state types alongside a React hook -- so the reducer's own import graph reaches `react`. The chart
// geometry the providers need lives in `StockMarketRenderer.tsx`, a component file. Neither is fatal in
// Node, but neither was known until something outside a browser and outside jest tried to run.
//
// SO THIS IS THAT SOMETHING, and it is deliberately the smallest thing that answers the question: read a log
// file, replay it, print what the game came to. No network, no framework, no persistence. If this runs, the
// server is an ordinary matter of wiring; if it had not, no amount of Express would have helped.
//
// IT IS ALSO USEFUL ON ITS OWN. `#1160` built the log exporter because a reported Undo fault could not be
// found by reading, and the reply was "the log is the game, so a bug report should be the log". This is the
// other half of that sentence: a log that can be replayed by anyone holding it, without a browser, without
// the room, and without the reporter present.
//
// THE PROVIDERS ARE IMPORTED, NEVER REBUILT (#1199). A server that assembled its own copy of the chart
// geometry would be one rule implemented twice, which is #1184, #1193 and #1194 -- three separate occasions
// this project has paid for that exact shape.
//
// Usage:  node server/dist/server/src/replayCli.js <path-to-exported-log.json>

import { readFileSync } from "fs";

/* #1500: the game machine, through its front door -- the same one `gameServer.ts` uses. */
import {
  DEFAULT_SANDBOX_SCENARIO,
  DEVELOPMENT_CORPUS_POLICY,
  ReplayIncompatibleError,
  SUPPORTED_RULES_ENGINE_VERSIONS,
  derivePhase,
  replayCompatibility,
  entriesFromExport,
  logHash,
  replayLog,
  sandboxReplayProviders,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
  waterfallForRoster,
  withEmptyRoster,
  type ExportedEntry,
} from "../../frontend/src/gameEngine";

interface RawLog {
  roomCode?: string;
  actionCount?: number;
  actions: ExportedEntry[];
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: replayCli <path-to-exported-log.json>");
    process.exit(2);
  }

  const raw = JSON.parse(readFileSync(path, "utf8")) as RawLog;
  /* #1188: an export carries `msg`; the stored log carries `payload`. Normalised once so a file from either
     source replays identically -- and so a future exporter carrying `payload` verbatim needs no change
     here. */
  const entries = entriesFromExport(raw.actions ?? []);

  const seedState = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
  const seedWaterfall = waterfallForRoster(
    sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
    [],
  );

  /* ==================================================================
      DESIGN NOTE 1520 (CLI): THE ONE PLACE A LEGACY LOG IS READ, AND IT SAYS SO
     ==================================================================
     The live server refuses a log whose deal carries no `rules_engine_version` (#1520): a missing pin is
     never read as "the current version". This tool is the development corpus's reader -- the exports and
     stored logs that predate the pin -- so it runs under `DEVELOPMENT_CORPUS_POLICY`, which admits a legacy
     log and nothing else: a log pinned to a version this engine does not carry is refused here exactly as
     the server would refuse it, before a single entry is applied. Legacy is announced on stderr so a number
     printed from an unpinned log is never mistaken for one the server would produce. */
  const compatibility = replayCompatibility(entries);
  if (compatibility.kind === "legacy") {
    console.error(
      `  LEGACY LOG: the deal carries no rules_engine_version; replaying under the development-corpus ` +
        `policy with engine version(s) [${SUPPORTED_RULES_ENGINE_VERSIONS.join(", ")}]. A live server would ` +
        `refuse this log (#1520).`,
    );
  }
  let result: ReturnType<typeof replayLog>;
  try {
    result = replayLog(
      entries,
      sandboxReplayProviders(),
      { state: seedState, waterfall: seedWaterfall },
      undefined,
      DEVELOPMENT_CORPUS_POLICY,
    );
  } catch (error) {
    if (error instanceof ReplayIncompatibleError) {
      console.error(`  INCOMPATIBLE: ${error.message}`);
      process.exit(3);
    }
    throw error;
  }

  const { state } = result;
  /* Design note #1278: `--json` prints the board's `public_companies` in full, in the exact shape the client's
     divergence line prints its own (#1226), so the two can be put side by side. The summary below is for a
     human; this is for the diff. Written to stdout after the summary, so a redirect captures both. */
  const fullDump = process.argv.includes("--json");
  console.log(
    JSON.stringify(
      {
        room: raw.roomCode ?? null,
        entries: entries.length,
        /* #1251: the commitment over this log, so a file and a checkpoint can be compared by eye. `null` for
           a log the hash refuses (a duplicate index), which the export also flags. */
        logHash: (() => {
          try {
            return logHash(entries);
          } catch {
            return null;
          }
        })(),
        applied: result.applied,
        droppedByRevert: result.dropped,
        /* #1530: the discards this replay supplied on a legacy log's behalf (none for a pinned log). */
        legacyDiscardsSupplied: result.legacyDiscards,
        unparseable: result.unparseable,
        round: state.current_round_type,
        macroRound: state.macro_round_number,
        subRound: state.sub_round_index,
        phase: derivePhase(state)?.tier ?? null,
        operatingOrder: state.active_operating_order,
        bank: state.virtual_bank_vgp,
        players: state.player_cash.map((entry) => ({
          player: entry.player,
          cash: entry.cash_vgp,
        })),
        corporations: state.public_companies
          .filter((company) => company.is_floated)
          .map((company) => ({
            ticker: company.ticker,
            treasury: company.treasury,
            price: state.market_positions?.[company.company_id]?.price ?? null,
            trains: company.owned_trains?.length ?? 0,
            lastRun: company.last_completed_run_revenue ?? null,
          })),
      },
      null,
      2,
    ),
  );
  if (fullDump) {
    console.log(JSON.stringify({ public_companies: state.public_companies }, null, 2));
  }
}

main();
