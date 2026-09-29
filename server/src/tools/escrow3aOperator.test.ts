// server/src/tools/escrow3aOperator.test.ts
//
// ==================================================================
//  ESCROW-3A (brief §11): OPERATOR RECOVERY BEFORE FUNDED GAMES EXIST -- LOCK HELD, AUDITED, NO HISTORY EDITED
// ==================================================================
//
//   duplicate join-code twins (LIVE-2F/3D C4-02)   verify both histories, clear the code from one record, release both
//   replay-failed from a prior build's bug          released only when THIS build replays the log
//   a held money game                               inspected read-only; released only after the game verifies, this
//                                                   deployment may continue it, and a sealed game's evidence re-derives
// Every mutating command refuses beside a live server (the data lock), writes an audit line, and never rewrites a log.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { serializeBatch } from "../persistence/logFormat";
import { createMemoryOpsRecorder } from "../persistence/opsRecorder";
import { acquireDataLock } from "../persistence/processLock";
import { mintGameId, type GameRecord } from "../rooms/gameRecord";
import { createFileHoldStore, makeHold } from "../rooms/holdStore";
import { ALICE, BOB, BUILD, quietConsole, seededRecord, storedLog } from "../rooms/testSupport";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { createFileFinancialGameStore } from "../escrow/financialGameStore";
import { currentMoneyContinuation } from "../escrow/moneyContinuation";
import { missingRecordPlaceholder, newFinancialRecord, transitionFinancial, type FinancialGameRecord } from "../escrow/moneyLifecycle";
import { inspectMoney, reconcileDuplicateCode, releaseHold, releaseMoneyHold, verifyGame, withLock } from "./gamesDoctor";
import { createMoneyServing } from "../escrow/moneyServing";
import { thisDeploymentCapability } from "../deploymentCapability";
import { PIN } from "../escrow/escrow3bSupport";

quietConsole();

const quiet = { warn: () => undefined };
const T0 = 1_760_000_000_000;

function withDir<T>(tag: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `escrow3a-op-${tag}-`));
  return body(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
const recordPath = (dir: string, gameId: string) => path.join(dir, "games", `${gameId}.json`);
const logPath = (dir: string, gameId: string) => path.join(dir, `${gameId}.log.jsonl`);
function writeRecord(dir: string, record: GameRecord): void {
  fs.mkdirSync(path.join(dir, "games"), { recursive: true });
  fs.writeFileSync(recordPath(dir, record.game_id), `${JSON.stringify(record)}\n`);
}
function writeLog(dir: string, gameId: string, entries: readonly ServerLogEntry[]): void {
  fs.writeFileSync(logPath(dir, gameId), entries.map((entry) => serializeBatch([entry])).join(""));
}
const readRecord = (dir: string, gameId: string) => JSON.parse(fs.readFileSync(recordPath(dir, gameId), "utf8")) as GameRecord;
function dealtOnDisk(dir: string, buys = 1, log?: (entries: ServerLogEntry[]) => ServerLogEntry[]): string {
  const gameId = mintGameId();
  const entries = storedLog(buys);
  const record: GameRecord = { ...seededRecord([ALICE, BOB], { dealt: true, gameId }), rules_engine_version: RULES_ENGINE_VERSION, started_at: entries[0].at ?? T0 };
  writeRecord(dir, record);
  writeLog(dir, gameId, log ? log(entries) : entries);
  return gameId;
}
function waitingOnDisk(dir: string, code: string | null): string {
  const record = { ...seededRecord([ALICE, BOB], { dealt: false }), join_code: code };
  writeRecord(dir, record);
  return record.game_id;
}
const hold = (dir: string, gameId: string, code: "duplicate-join-code" | "replay-failed") =>
  createFileHoldStore(dir, quiet).create(makeHold({ gameId, code, detail: `test ${code}`, at: T0, source: "discovery", build: BUILD, rulesEngineVersion: RULES_ENGINE_VERSION }));
const IDENTITY_SHAPED = /pr_|pf_|se_|sf_|rk_/;
/** LIVE-4 (L4-4): the operator judges against the escrow deployment the server is configured for (`--escrow-config`). */
const serving = () => createMoneyServing({ capability: thisDeploymentCapability([PIN]) });

describe("ESCROW-3A §11: duplicate join-code twins", () => {
  test("two waiting twins are AMBIGUOUS (nothing changes) until --keep says which; then one record loses the code, both verify and both holds are released", () =>
    withDir("twins", async (dir) => {
      const code = "JUNO-BCDE-FGHJ";
      const a = waitingOnDisk(dir, code);
      const b = waitingOnDisk(dir, code);
      await hold(dir, a, "duplicate-join-code");
      await hold(dir, b, "duplicate-join-code");
      assert.equal((await verifyGame(dir, a)).ok, false, "release alone can never lift it: each finds the other");
      const ops = createMemoryOpsRecorder();
      const bytesBefore = fs.readFileSync(recordPath(dir, a), "utf8");
      const ambiguous = await withLock(dir, (lock) => reconcileDuplicateCode(dir, a, b, "twins found after an index repair", { lock, ops }));
      assert.deepEqual(ambiguous, { ok: false, reason: "ambiguous: say which game keeps the code with --keep <game_id> (nothing was changed)" });
      assert.equal(fs.readFileSync(recordPath(dir, a), "utf8"), bytesBefore);
      const done = await withLock(dir, (lock) => reconcileDuplicateCode(dir, a, b, "twins found after an index repair", { lock, ops, keep: b }));
      assert.deepEqual(done, { ok: true, code, kept: b, cleared: a, released: [a, b] });
      assert.deepEqual([readRecord(dir, a).join_code, readRecord(dir, b).join_code], [null, code]);
      assert.equal(readRecord(dir, a).record_version, 2);
      assert.ok((await verifyGame(dir, a)).ok && (await verifyGame(dir, b)).ok);
      assert.equal(await createFileHoldStore(dir, quiet).load(a), null);
      const events = ops.lines.map((line) => line.event);
      assert.deepEqual(events.filter((e) => e !== "hold.released"), ["record.duplicate-code-reconciled"]);
      assert.equal(events.filter((e) => e === "hold.released").length, 2);
      assert.ok(!JSON.stringify(ops.lines).match(IDENTITY_SHAPED), "no identity id in the audit");
    }));

  test("a waiting twin and a dealt twin: unambiguous -- the waiting one keeps the code; the dealt log is not written", () =>
    withDir("twins2", async (dir) => {
      const code = "JUNO-BCDE-FGHK";
      const dealt = dealtOnDisk(dir, 1);
      writeRecord(dir, { ...readRecord(dir, dealt), join_code: code });
      const waiting = waitingOnDisk(dir, code);
      const logBytes = fs.readFileSync(logPath(dir, dealt));
      const done = await withLock(dir, (lock) => reconcileDuplicateCode(dir, dealt, waiting, "twins", { lock, ops: createMemoryOpsRecorder() }));
      assert.equal("ok" in done && done.ok, true, "the waiting twin keeps the code; the dealt game's seats reach it through their game list, as every dealt private game");
      assert.deepEqual([readRecord(dir, dealt).join_code, readRecord(dir, waiting).join_code], [null, code]);
      assert.ok(fs.readFileSync(logPath(dir, dealt)).equals(logBytes), "no gameplay log is rewritten");
    }));

  test("review #9: only the duplicate-code hold is lifted -- another hold on a twin stays for its own release", () =>
    withDir("twins4", async (dir) => {
      const code = "JUNO-BCDE-FGHP";
      const a = waitingOnDisk(dir, code);
      const b = waitingOnDisk(dir, code);
      await hold(dir, a, "duplicate-join-code");
      await hold(dir, b, "replay-failed"); // an unrelated hold an operator placed on purpose
      const done = await withLock(dir, (lock) => reconcileDuplicateCode(dir, a, b, "twins", { lock, ops: createMemoryOpsRecorder(), keep: b }));
      assert.deepEqual(done, { ok: true, code, kept: b, cleared: a, released: [a] });
      assert.equal((await createFileHoldStore(dir, quiet).load(b))?.code, "replay-failed");
    }));

  test("a twin whose history does not verify: refused, nothing changed; and every mutating command refuses beside a live server's lock", () =>
    withDir("twins3", async (dir) => {
      const code = "JUNO-BCDE-FGHM";
      const broken = dealtOnDisk(dir, 1, (entries) => [...entries, { ...entries[1], index: entries.length, id: "junk", payload: '{"SetupGame":null}' }]);
      writeRecord(dir, { ...readRecord(dir, broken), join_code: code });
      const waiting = waitingOnDisk(dir, code);
      const refused = await withLock(dir, (lock) => reconcileDuplicateCode(dir, broken, waiting, "twins", { lock, ops: createMemoryOpsRecorder(), keep: waiting }));
      assert.equal((refused as { ok: boolean }).ok, false);
      assert.match((refused as { reason: string }).reason, /does not verify, so nothing is changed/);
      assert.equal(readRecord(dir, broken).join_code, code);
      const live = await acquireDataLock(dir, { log: () => undefined, onLost: () => undefined });
      assert.equal(live.ok, true);
      try {
        const beside = await withLock(dir, async () => "ran");
        assert.ok(typeof beside === "object" && "refused" in beside, "a server holds the directory: the tool does not run");
      } finally {
        if (live.ok) await live.lock.release();
      }
    }));
});

describe("ESCROW-3A §11: replay-failed from a prior build's bug", () => {
  test("released only when THIS build replays the log; a log that still does not replay stays held", () =>
    withDir("replay", async (dir) => {
      const fixed = dealtOnDisk(dir, 2);
      await hold(dir, fixed, "replay-failed"); // held by a buggy build; this build replays it
      const broken = dealtOnDisk(dir, 1, (entries) => [...entries, { ...entries[1], index: entries.length, id: "junk", payload: '{"SetupGame":null}' }]);
      await hold(dir, broken, "replay-failed");
      const ops = createMemoryOpsRecorder();
      const brokenBytes = fs.readFileSync(logPath(dir, broken));
      const stays = await withLock(dir, (lock) => releaseHold(dir, broken, "the build was fixed", { lock, ops }));
      assert.equal((stays as { ok: boolean }).ok, false);
      assert.match((stays as { reason: string }).reason, /does not verify, so it stays held/);
      assert.ok(fs.readFileSync(logPath(dir, broken)).equals(brokenBytes));
      const lifted = await withLock(dir, (lock) => releaseHold(dir, fixed, "the reducer bug was fixed in this build; replay verified", { lock, ops }));
      assert.equal((lifted as { ok: boolean }).ok, true);
      assert.equal(await createFileHoldStore(dir, quiet).load(fixed), null);
      assert.ok(ops.lines.some((line) => line.event === "hold.released" && line.game_id === fixed && line.code === "replay-failed"));
    }));
});

describe("ESCROW-3A §11: held money games", () => {
  async function heldMoney(dir: string, gameId: string, at: FinancialGameRecord["phase"], code: "continuation-incompatible" | "replay-failed", continuation = currentMoneyContinuation()): Promise<void> {
    const store = createFileFinancialGameStore(dir, quiet);
    let record = newFinancialRecord(gameId, continuation, T0, PIN);
    assert.equal((await store.create(record)).outcome.kind, "committed");
    if (at !== "funding") {
      const dealt = transitionFinancial(record, { kind: "dealt", at: T0 + 1 }) as { next: FinancialGameRecord };
      assert.equal((await store.put(dealt.next, record.record_version)).kind, "committed");
      record = dealt.next;
    }
    if (at === "terminal-eligible") {
      const sealed = transitionFinancial(record, { kind: "sealed", at: T0 + 2, log_len: 2, sealed_at: T0 + 2 }) as { next: FinancialGameRecord };
      assert.equal((await store.put(sealed.next, record.record_version)).kind, "committed");
      record = sealed.next;
    }
    const held = transitionFinancial(record, { kind: "hold", at: T0 + 3, code, detail: "test" }) as { next: FinancialGameRecord };
    assert.equal((await store.put(held.next, record.record_version)).kind, "committed");
  }

  test("inspection is read-only; a verified, compatible, unsealed money game is released back to the phase it was held from", () =>
    withDir("money1", async (dir) => {
      const gameId = dealtOnDisk(dir, 1);
      await heldMoney(dir, gameId, "in-progress", "continuation-incompatible");
      const before = fs.readFileSync(path.join(dir, "games", "money", `${gameId}.json`), "utf8");
      const seen = await inspectMoney(dir, undefined, { serving: serving() });
      assert.deepEqual(seen.games.map((g) => [g.gameId, g.phase, g.hold?.code, g.hold?.from, g.continues]), [[gameId, "held", "continuation-incompatible", "in-progress", true]]);
      assert.equal(fs.readFileSync(path.join(dir, "games", "money", `${gameId}.json`), "utf8"), before, "inspect writes nothing");
      const ops = createMemoryOpsRecorder();
      const done = await withLock(dir, (lock) => releaseMoneyHold(dir, gameId, "ran on a compatible build", { lock, ops, serving: serving() }));
      assert.deepEqual(done, { ok: true, to: "in-progress" });
      assert.equal((await createFileFinancialGameStore(dir, quiet).load(gameId))!.phase, "in-progress");
      assert.ok(ops.lines.some((line) => line.event === "money.released" && line.game_id === gameId));
      assert.ok(!JSON.stringify(ops.lines).match(IDENTITY_SHAPED));
    }));

  test("fail closed: an incompatible continuation, a game that does not verify, and a sealed game whose evidence does not re-derive all stay held", () =>
    withDir("money2", async (dir) => {
      const incompatible = dealtOnDisk(dir, 1);
      await heldMoney(dir, incompatible, "in-progress", "continuation-incompatible", { ...currentMoneyContinuation(), hosted_protocol: 7 });
      const broken = dealtOnDisk(dir, 1, (entries) => [...entries, { ...entries[1], index: entries.length, id: "junk", payload: '{"SetupGame":null}' }]);
      await heldMoney(dir, broken, "in-progress", "replay-failed");
      const sealed = dealtOnDisk(dir, 1); // sealed at 2 by the record, but its board is not at GameEnd: nothing settles from it
      await heldMoney(dir, sealed, "terminal-eligible", "replay-failed");
      const ops = createMemoryOpsRecorder();
      const reasons: string[] = [];
      for (const gameId of [incompatible, broken, sealed]) {
        const result = await withLock(dir, (lock) => releaseMoneyHold(dir, gameId, "trying", { lock, ops, serving: serving() }));
        assert.equal((result as { ok: boolean }).ok, false, gameId);
        reasons.push((result as { reason: string }).reason);
        assert.equal((await createFileFinancialGameStore(dir, quiet).load(gameId))!.phase, "held");
      }
      assert.match(reasons[0], /may not continue .*hosted-protocol/);
      assert.match(reasons[1], /does not verify/);
      assert.match(reasons[2], /evidence does not re-derive \(board-not-terminal/);
      assert.equal(ops.lines.filter((line) => line.event === "money.released").length, 0);
    }));

  test("review #1/#2: a missing record's placeholder is never released; a funding hold on a DEALT game resumes in-progress", () =>
    withDir("money3", async (dir) => {
      const missing = dealtOnDisk(dir, 1);
      const store = createFileFinancialGameStore(dir, quiet);
      assert.equal((await store.create(missingRecordPlaceholder(missing, T0, "test"))).outcome.kind, "committed");
      const refused = await withLock(dir, (lock) => releaseMoneyHold(dir, missing, "it verifies", { lock, ops: createMemoryOpsRecorder(), serving: serving() }));
      assert.match((refused as { reason: string }).reason, /placeholder .* never released -- stop the server and restore the original/);
      assert.equal((await inspectMoney(dir, missing, { serving: serving() })).games[0].continues, false);
      const dealt = dealtOnDisk(dir, 1);
      await heldMoney(dir, dealt, "funding", "replay-failed");
      const done = await withLock(dir, (lock) => releaseMoneyHold(dir, dealt, "replay verified on this build", { lock, ops: createMemoryOpsRecorder(), serving: serving() }));
      assert.deepEqual(done, { ok: true, to: "in-progress" }, "the GameRecord says it was dealt: never back to funding");
    }));
});
