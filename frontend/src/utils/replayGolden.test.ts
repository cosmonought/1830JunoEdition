/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1340 (harness): EVERY LOG ON DISK REPLAYS TO THE SAME BOARD IT DID YESTERDAY
// ==================================================================
//
// The reducer is being made atomic (#1340): the auction's charges, wins, all-pass income, re-seat and close
// move from two composition layers (`App.tsx`, `RoomEngine`) into `applySandboxAction`. The one property that
// refactor must hold is that no log replays differently -- and "the numbers look right" is not a check.
//
// SO THE FINAL BOARD OF EVERY FROZEN LOG IS FROZEN HERE, byte for byte, as a fixture written by this file the
// first time it ran (before the refactor) and compared on every run after. The logs themselves are copies
// under `__fixtures__/replayGolden/logs/` -- a live room's log keeps growing, and a golden master must not. `state.waterfall` is compared
// separately from the rest of the state, because the refactor moves the auction ONTO the state and the
// fixture predates that: the auction half is checked against `result.waterfall`, which both shapes expose.
//
// TO RE-BASELINE (only after a deliberate rules change): delete the fixture and run once.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

import { entriesFromExport, replayLog, type ExportedEntry } from "./replayLog";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "./sandboxState";
import { sandboxReplayProviders } from "./replayProviders";
import { waterfallForRoster, withEmptyRoster } from "./gameSetup";

/* THE LOGS ARE FROZEN WITH THEIR BOARDS. The first draft read `server/data/*.log.jsonl` -- the live store --
   and one of those games was still being played: eighteen entries later the fixture was "wrong". A golden
   master is a pair, and both halves have to stand still. To add a game: copy its `.log.jsonl` into `logs/`,
   delete nothing, run once. */
const FIXTURE_DIR = join(__dirname, "__fixtures__", "replayGolden");
const DATA_DIR = join(FIXTURE_DIR, "logs");

function loadStoredLog(file: string): ExportedEntry[] {
  return readFileSync(join(DATA_DIR, file), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ExportedEntry);
}

function replayStored(file: string) {
  const entries = entriesFromExport(loadStoredLog(file));
  const seedState = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
  const seedWaterfall = waterfallForRoster(
    sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
    [],
  );
  const result = replayLog(entries, sandboxReplayProviders(), { state: seedState, waterfall: seedWaterfall });
  const { waterfall: _onState, ...stateWithoutAuction } = result.state as typeof result.state & {
    waterfall?: unknown;
  };
  /* `settled_price` (#1340) is a record the reducer now keeps that the shell used to keep privately; it is
     not a figure the fixture ever held, so it is not one the fixture can judge. Everything else is. */
  const comparable = {
    ...stateWithoutAuction,
    private_companies: stateWithoutAuction.private_companies.map(({ settled_price: _settled, ...rest }) => rest),
  };
  return {
    applied: result.applied,
    dropped: result.dropped,
    unparseable: result.unparseable,
    state: comparable,
    waterfall: result.waterfall,
    grid: result.grid,
  };
}

const logs = readdirSync(DATA_DIR).filter((file) => file.endsWith(".log.jsonl"));

describe("golden master: every stored log replays to its frozen board", () => {
  it("has logs to check", () => {
    expect(logs.length).toBeGreaterThan(0);
  });

  for (const file of logs) {
    it(`${file} replays to the same final state`, () => {
      const actual = JSON.parse(JSON.stringify(replayStored(file)));
      const fixture = join(FIXTURE_DIR, `${file.replace(".log.jsonl", "")}.json`);
      if (!existsSync(fixture)) {
        mkdirSync(FIXTURE_DIR, { recursive: true });
        writeFileSync(fixture, JSON.stringify(actual, null, 2));
      }
      const expected = JSON.parse(readFileSync(fixture, "utf8"));
      expect(actual).toEqual(expected);
    });
  }
});
