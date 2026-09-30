// server/src/tools/scanV10.test.ts
//
// DA-8: `gamesDoctor scan-v10` -- the v10 -> v11 boundary scan over a data directory, READ-ONLY. It reads every stored
// log (the server's own `<id>.log.jsonl`, the archived `archive/<id>/<id>.log.jsonl`, the legacy JUNO-XXX files), sorts
// them by rules-engine pin, replays each v10 game for inspection only and reports the entries rules engine 11 reads
// differently (`frontend/src/utils/rulesBoundaryScan.ts`). It takes no lock and writes nothing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { serializeBatch } from "../persistence/logFormat";
import { LOCK_DIRECTORY } from "../persistence/processLock";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import { mintGameId } from "../rooms/gameRecord";
import { storedLog } from "../rooms/testSupport";
import { scanRulesBoundary } from "./gamesDoctor";

function withDeal(entries: readonly ServerLogEntry[], change: (setup: Record<string, unknown>) => void): ServerLogEntry[] {
  const payload = JSON.parse(entries[0].payload) as { SetupGame: Record<string, unknown> };
  change(payload.SetupGame);
  return [{ ...entries[0], payload: JSON.stringify(payload) }, ...entries.slice(1)];
}
const stamped = (entries: readonly ServerLogEntry[]) => entries.map((entry) => serializeBatch([entry])).join("");
const legacyLines = (entries: readonly ServerLogEntry[]) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");

/** Every file under `dir`, with its bytes -- the proof that nothing was written. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string) => {
    for (const name of fs.readdirSync(at)) {
      const full = path.join(at, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.set(path.relative(dir, full), fs.readFileSync(full).toString("base64"));
    }
  };
  walk(dir);
  return out;
}

describe("DA-8 gamesDoctor scan-v10", () => {
  test("sorts every stored log by its pin, flags a v10 game's BeginOperatingRound by round, passes a clean one, and writes nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-v10-"));
    try {
      assert.ok(RULES_ENGINE_VERSION >= 11, "the scan reads v10 history with a later engine (11 at DA-8; 12 since Route v12 R12-2)");
      const ten = withDeal(storedLog(1), (setup) => (setup.rules_engine_version = 10));
      const clean = mintGameId();
      const flagged = mintGameId();
      const archived = mintGameId();
      fs.writeFileSync(path.join(dir, `${clean}.log.jsonl`), stamped(ten));
      const crafted: ServerLogEntry = { index: ten.length, id: "crafted-begin-or", actor: ten[1].actor, payload: JSON.stringify({ BeginOperatingRound: { game_id: 0 } }), at: 5 };
      fs.writeFileSync(path.join(dir, `${flagged}.log.jsonl`), stamped([...ten, crafted]));
      fs.mkdirSync(path.join(dir, "archive", archived), { recursive: true });
      fs.writeFileSync(path.join(dir, "archive", archived, `${archived}.log.jsonl`), stamped(storedLog(1)));
      fs.writeFileSync(path.join(dir, "JUNO-ABC.log.jsonl"), legacyLines(withDeal(storedLog(0), (setup) => delete setup.rules_engine_version)));
      fs.writeFileSync(path.join(dir, "JUNO-ABC.room.json"), "{}\n");
      const before = snapshot(dir);

      const report = await scanRulesBoundary(dir);

      assert.deepEqual(snapshot(dir), before, "not a byte written, moved or added");
      assert.equal(fs.existsSync(path.join(dir, LOCK_DIRECTORY)), false, "no lock taken");
      assert.equal(report.serverRunning, false);
      assert.deepEqual(report.unreadable, []);
      // The archived game is dealt by the current engine (v11 at DA-8, v12 since Route v12 R12-2): not the boundary's.
      assert.deepEqual(report.summary.byPin, { v10: 2, [`v${RULES_ENGINE_VERSION}`]: 1, unpinned: 1 });
      assert.equal(report.summary.scanned, 2);
      assert.deepEqual(report.summary.counts, { A: 1, B: 0, C: 0, F12: 0, X: 0, D: 0 });
      assert.equal(report.summary.clean, false);
      const hit = report.games.find((game) => game.name === `${flagged}.log.jsonl`)!;
      assert.deepEqual(
        hit.hits.map((h) => [h.pattern, h.index, h.kind, h.roundBefore]),
        [["A", ten.length, "BeginOperatingRound", "WaterfallAuction"]],
      );
      assert.deepEqual(report.games.find((game) => game.name === `${clean}.log.jsonl`)!.hits, []);
      const archivedScan = report.games.find((game) => game.name === `archive/${archived}/${archived}.log.jsonl`)!;
      assert.deepEqual([archivedScan.pin, archivedScan.scanned], [RULES_ENGINE_VERSION, false], "a current-engine game is not the boundary's");
      // No principal id is reported: a hit is an index and a message kind.
      assert.equal(JSON.stringify(report).includes(ten[1].actor), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty or missing data directory is a clean, empty report", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-v10-empty-"));
    try {
      const report = await scanRulesBoundary(path.join(dir, "absent"));
      assert.deepEqual([report.summary.logs, report.summary.clean, report.unreadable.length], [0, true, 0]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
