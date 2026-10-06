// server/src/tools/l4_6Tooling.test.ts
//
// ==================================================================
//  LIVE-4 (L4-6): THE OPERATOR'S TOOLING -- THE COMPATIBILITY DESCRIPTOR AND THE STORED GAMES' CANONICAL VERDICT
// ==================================================================
//
// What this pass added, and what it must never do:
//   1. the compatibility descriptor is deterministic and canonical (canonical JSON, byte-identical for equal facts);
//   2. its key IS production's key: `compatibilityKey` over the capability a server judges with (the running server's
//      `ops/status.json`, the escrow service's `servingCapability`, the pinned L4-3 keys);
//   3. a BUILD_ID change moves nothing but the diagnostic block -- not the key, not the capability, not a protocol-1
//      client's answer;
//   4. the stored-game inspection asks the canonical `continuationVerdict` through production's own wiring (source pins:
//      `createContinuationWiring`, `createSettlementCoordinator`, `wiring.verdictOf`; no verdict reimplemented);
//   5. no inspection command can write: the read-only file system refuses every write, and every command is run as the
//      operator runs it (the compiled CLI) over a data directory whose bytes are hashed before and after -- including a
//      torn tail the server's load WOULD truncate;
//   6. a newer build's log stays byte-identical and is reported `not-continued/newer-format`;
//   7. the continues / not-continued / conflict distinctions are production's: a no-money game's class is what a running
//      server answers the same game's hello; a money game's is the L4-4/integration matrix's, and the money seam's own
//      verdict agrees (owner, deployment and format information kept);
//   8. the version constants stay pinned (no protocol or version bump in L4-6).

import { strict as assert } from "assert";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, test } from "node:test";

import { compatibilityDescriptor, compatibilityDescriptorText, COMPATIBILITY_DESCRIPTOR_FORMAT, bannerLines } from "../compatibilityDescriptor";
import { thisDeploymentCapability } from "../deploymentCapability";
import { createContinuationWiring } from "../continuationWiring";
import { createFileLogStore, nodeStoreFs } from "../fileLogStore";
import { serializeBatch } from "../persistence/logFormat";
import { createMemoryOpsRecorder } from "../persistence/opsRecorder";
import { createFileRecordStore } from "../rooms/recordStore";
import { createFileHoldStore } from "../rooms/holdStore";
import { MONEY_TABLE_FORMAT, mintGameId, type GameRecord } from "../rooms/gameRecord";
import { ALICE, BOB, BUILD, Client, quietConsole, seededRecord, startServer, stopServer, storedLog, until, type Frame } from "../rooms/testSupport";
import { financialDirectory, createMemoryFinancialGameStore } from "../escrow/financialGameStore";
import { currentMoneyContinuation } from "../escrow/moneyContinuation";
import { FINANCIAL_VERSION, newFinancialRecord, transitionFinancial, type FinancialDeploymentPin, type FinancialGameRecord } from "../escrow/moneyLifecycle";
import { createMoneyServing, servingCapability, type MoneyServing } from "../escrow/moneyServing";
import { createSettlementCoordinator } from "../escrow/settlementCoordinator";
import { serverPrefixReplay } from "../escrow/settlementEvidence";
import { CANONICAL_CHECKSUM, PIN, T0, WALLETS } from "../escrow/escrow3bSupport";
import { inspectContinuation, inspectData, inspectMoney } from "./gamesDoctor";
import { ReadOnlyInspectionError, readOnlyStoreFs } from "./readOnlyFs";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { canonicalJson } from "../../../frontend/src/gameEngine/stateDigest";
import { RULES_ENGINE_VERSION, SUPPORTED_RULES_ENGINE_VERSIONS } from "../../../frontend/src/gameEngine/rulesVersion";
import { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } from "../../../frontend/src/gameEngine/settlementAppraisal";
import { ACCEPTED_CLIENT_PROTOCOLS, CLIENT_PROTOCOL_VERSION, FINANCIAL_PROTOCOL_VERSION, HOSTED_PROTOCOL_VERSION } from "../../../frontend/src/gameEngine/protocolVersions";
import { GAME_CONTINUATION_FORMAT, type GameIdentityFacts } from "../../../frontend/src/gameEngine/compat/continuationIdentity";
import type { ContinuationVerdict } from "../../../frontend/src/gameEngine/compat/continuationVerdict";
import { capabilityCanonicalText, compatibilityKey, deploymentCapability, deploymentKey } from "../../../frontend/src/gameEngine/compat/deploymentCapability";
import { clientVerdict, parseClientAnnouncement } from "../../../frontend/src/gameEngine/compat/clientCompatibility";

quietConsole();

const quiet = { warn: () => undefined };
const REPO = path.resolve(__dirname, "..", "..", "..", "..", "..");
const source = (relative: string) => fs.readFileSync(path.join(REPO, relative), "utf8");
/** Code only: comments may describe the retired model; code may not use it. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const why = (verdict: ContinuationVerdict): string => (verdict.kind === "continues" ? "continues" : `${verdict.kind}/${verdict.why}`);
const GAMES_DOCTOR = path.join(__dirname, "gamesDoctor.js");

/** The keys L4-3 pinned and the integration kept (`live4Integration`, §5 of its report) -- as Route v12 R12-2 moved
 *  them, on the rules axis alone (rules 12; LIVE-4's were dc1-68c4b829… and dc1-43086498… on rules 11), as R12-3 moved
 *  them again by certifying 12 for settlement (R12-2's were dc1-ade748b9… and dc1-eb48b18e…), and as Phase 3 W3-K moved
 *  them on the rules axis alone (rules 13 reading [13], settlement still [10, 11, 12]; R12-3's were dc1-41eb96a7… and
 *  dc1-63af8114…), and as Phase 3's dedicated v13 certification moved them by certifying 13 alone (settlement
 *  [10, 11, 12, 13]; W3-K's were dc1-390107d5… and dc1-d01c50c4…), and as Phase 3's escrow 2.1 timed remedies moved the
 *  fixture key by `financial_protocols` alone (financial protocol 4; the v13 certification's was dc1-32fcc496…). */
const KEY_NO_ESCROW = "dc1-e8d0b4792a7ba07e67199ad2";
const KEY_FIXTURE_PIN = "dc1-30d893675c773e9b609699e7";

const PIN_B: FinancialDeploymentPin = Object.freeze({ ...PIN, contract_address: WALLETS[2] });
const PIN_TYPO: FinancialDeploymentPin = Object.freeze({ ...PIN, denom: "ujunoy" });
const KEY_A = deploymentKey(PIN);
const OTHER_CHECKSUM = "ab".repeat(32);
const DEALT: GameIdentityFacts = { kind: "dealt", gci: { format: GAME_CONTINUATION_FORMAT, rules_engine_version: RULES_ENGINE_VERSION, hosted_protocol: HOSTED_PROTOCOL_VERSION } };
const chainRead = (checksum: string, denom: string) => ({ kind: "read" as const, key: KEY_A, facts: { code_checksum: checksum, denom }, read_at: T0 });

function withDir<T>(tag: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `l4-6-${tag}-`));
  return body(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** Every file (its SHA-256, size and mtime) and every directory under `dir`: the data directory's bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(at, entry.name);
      const relative = path.relative(dir, full);
      if (entry.isDirectory()) {
        out[`${relative}/`] = "directory";
        walk(full);
      } else {
        const stat = fs.statSync(full);
        out[relative] = `${createHash("sha256").update(fs.readFileSync(full)).digest("hex")} ${stat.size} ${stat.mtimeMs}`;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const recordPath = (dir: string, gameId: string) => path.join(dir, "games", `${gameId}.json`);
const logPath = (dir: string, gameId: string) => path.join(dir, `${gameId}.log.jsonl`);

function writeRecord(dir: string, record: GameRecord | Record<string, unknown>, gameId: string = (record as GameRecord).game_id): void {
  fs.mkdirSync(path.join(dir, "games"), { recursive: true });
  fs.writeFileSync(recordPath(dir, gameId), `${JSON.stringify(record)}\n`);
}

const logBytes = (entries: readonly ServerLogEntry[]) => entries.map((entry) => serializeBatch([entry])).join("");

function writeLog(dir: string, gameId: string, entries: readonly ServerLogEntry[], tail = ""): void {
  fs.writeFileSync(logPath(dir, gameId), logBytes(entries) + tail);
}

function withDeal(entries: readonly ServerLogEntry[], change: (setup: Record<string, unknown>) => void): ServerLogEntry[] {
  const payload = JSON.parse(entries[0].payload) as { SetupGame: Record<string, unknown> };
  change(payload.SetupGame);
  return [{ ...entries[0], payload: JSON.stringify(payload) }, ...entries.slice(1)];
}

/** A dealt no-money game on disk, as a restarted server finds it (ALICE host, BOB). */
function dealtOnDisk(dir: string, over: { log?: (entries: ServerLogEntry[]) => ServerLogEntry[]; tail?: string; buys?: number } = {}): string {
  const gameId = mintGameId();
  const log = over.log ? over.log(storedLog(over.buys ?? 1)) : storedLog(over.buys ?? 1);
  /* The record caches the deal's own pin (as the load leaves it), so the game on disk is consistent: only its
     continuation is in question, never a record-against-deal disagreement (that is `inspect`'s reconciliation). */
  const pin = (JSON.parse(log[0].payload) as { SetupGame: { rules_engine_version?: unknown } }).SetupGame.rules_engine_version;
  writeRecord(dir, { ...seededRecord([ALICE, BOB], { dealt: true, gameId }), rules_engine_version: typeof pin === "number" ? pin : null, started_at: log[0].at ?? Date.now() });
  writeLog(dir, gameId, log, over.tail ?? "");
  return gameId;
}

/** A complete line of a format this build does not write (N-3). */
const NEWER_LINE = `${JSON.stringify({ format: "gs-log", schema: 2, index: 2, entry: { id: "n1", payload: "{}" } })}\n`;

function termsOf(pin: FinancialDeploymentPin) {
  return { format: MONEY_TABLE_FORMAT, backend: pin.backend, chain_id: pin.chain_id, network_class: pin.network_class, contract_address: pin.contract_address, code_checksum: pin.code_checksum, denom: pin.denom, symbol: "JUNOX", exponent: 6, ante_gross: "1010000", mode: "live" };
}

/** A dealt money GameRecord (record_schema 2) whose terms name `pin`. */
function moneyRecord(gameId: string, pin: FinancialDeploymentPin): GameRecord {
  const seeded = seededRecord([ALICE, BOB], { dealt: true, gameId, now: T0 });
  return { ...seeded, record_schema: 2, money: termsOf(pin), policy: { ...(seeded as unknown as { policy: object }).policy, host_undo: "none" }, exact_players: 2, rules_engine_version: RULES_ENGINE_VERSION } as unknown as GameRecord;
}

function dealtFin(gameId: string, pin: FinancialDeploymentPin): FinancialGameRecord {
  const moved = transitionFinancial(newFinancialRecord(gameId, currentMoneyContinuation(), T0, pin), { kind: "dealt", at: T0 + 1 });
  assert.equal(moved.kind, "moved");
  return (moved as { next: FinancialGameRecord }).next;
}

function writeFin(dir: string, gameId: string, text: string): void {
  fs.mkdirSync(financialDirectory(dir), { recursive: true });
  fs.writeFileSync(path.join(financialDirectory(dir), `${gameId}.json`), text);
}

/** Run the compiled CLI as an operator does. */
function cli(dir: string, args: readonly string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [GAMES_DOCTOR, ...args, "--data", dir], { encoding: "utf8", env: { ...process.env, ESCROW_JUNO_CONFIG: "", BUILD_ID: "", ...env } });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/* ================================================================================================= */
/* 1-3. The descriptor                                                                                */
/* ================================================================================================= */

describe("LIVE-4 L4-6: the compatibility descriptor", () => {
  test("1. deterministic and canonical: equal facts give byte-identical canonical JSON, keys sorted recursively, whatever order the facts were built in", () => {
    const a = compatibilityDescriptorText(compatibilityDescriptor(thisDeploymentCapability([PIN, PIN_B]), { build_id: "b1" }));
    const b = compatibilityDescriptorText(compatibilityDescriptor(thisDeploymentCapability([PIN_B, PIN]), { build_id: "b1" }));
    assert.equal(a, b, "deployment order does not matter");
    assert.equal(a, canonicalJson(JSON.parse(a)), "the text is its own canonical form");
    const parsed = JSON.parse(a) as { format: string; capability: unknown; compatibility_key: string };
    assert.equal(parsed.format, COMPATIBILITY_DESCRIPTOR_FORMAT);
    assert.equal(canonicalJson(parsed.capability), capabilityCanonicalText(thisDeploymentCapability([PIN, PIN_B])), "the capability printed is exactly the text the key hashes");
    assert.deepEqual(Object.keys(JSON.parse(a)), ["axes", "capability", "compatibility_key", "diagnostics", "format"]);
    /* The CLI prints the same canonical text (no escrow configured). */
    return withDir("compat-cli", async (dir) => {
      const run = cli(dir, ["compat", "--build", "b1"]);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout.trim(), compatibilityDescriptorText(compatibilityDescriptor(thisDeploymentCapability([]), { build_id: "b1" })));
      assert.equal(cli(dir, ["compat", "--build", "b1"]).stdout, run.stdout, "and again, byte for byte");
      assert.deepEqual(fs.readdirSync(dir), [], "compat touched nothing in the data directory");
    });
  });

  test("the axes are the capability's facts, named: rules 13 reading [13] and settling [10, 11, 12, 13] (12 by Route v12 R12-3; 13 by Phase 3's v13 certification); hosted [1]; financial [] without escrow and [4] with it (3 until Phase 3's escrow 2.1); client 1 accepting [0, 1]; codec 18JUNO/v1", () => {
    const none = compatibilityDescriptor(thisDeploymentCapability([]));
    assert.deepEqual(
      { ...none.axes },
      {
        rules_engine_version: 13,
        readable_rules: [13],
        settlement_certified_rules: [10, 11, 12, 13],
        hosted_protocols: [1],
        financial_protocols: [],
        client_protocol_of_this_source: 1,
        accepted_client_protocols: [0, 1],
        settlement_codecs: ["18JUNO/v1"],
        escrow_deployments: [],
      },
    );
    const served = compatibilityDescriptor(thisDeploymentCapability([PIN]));
    assert.deepEqual([served.axes.financial_protocols, served.axes.escrow_deployments], [[4], [KEY_A]]);
  });

  test("2. the key is production's key: the pinned L4-3 keys; the escrow service's own `servingCapability`; a running server's status snapshot and banner", async () => {
    assert.equal(compatibilityDescriptor(thisDeploymentCapability([])).compatibility_key, KEY_NO_ESCROW);
    assert.equal(compatibilityDescriptor(thisDeploymentCapability([PIN])).compatibility_key, KEY_FIXTURE_PIN);
    assert.equal(compatibilityDescriptor(servingCapability([PIN])).compatibility_key, compatibilityKey(servingCapability([PIN])), "the escrow service's constructor, keyed by production's function");
    assert.equal(compatibilityKey(servingCapability([PIN])), KEY_FIXTURE_PIN);
    /* The tool builds its serving with the escrow service's constructor, and the server prints the key it judges with. */
    assert.match(code(source("server/src/tools/gamesDoctor.ts")), /createMoneyServing\(\{ capability: servingCapability\(\[pin\]\) \}\)/);
    assert.match(code(source("server/src/start.ts")), /printBanner\(held\.instanceId, server\.lifecycle\.capability\)/);
    assert.match(code(source("server/src/gameServer.ts")), /const compatibility = compatibilityDescriptor\(continuation\.capability, \{ build_id: options\.build \}\);/);
    const ops = createMemoryOpsRecorder();
    const { server } = await startServer({ ops });
    try {
      await server.lifecycle.ready;
      /* The snapshot is published one turn after discovery (coalesced). */
      await until(() => ops.snapshots.some((snapshot) => snapshot.compatibility !== undefined), "the status snapshot");
      const snapshots = ops.snapshots.filter((snapshot) => snapshot.compatibility !== undefined);
      assert.ok(snapshots.length > 0, "the status snapshot carries the compatibility block");
      const last = snapshots[snapshots.length - 1] as { compatibility: { compatibility_key: string; diagnostics: { build_id: string } }; client_answers: Record<string, number> };
      assert.equal(last.compatibility.compatibility_key, compatibilityKey(server.lifecycle.capability), "the key of the capability the server judges with");
      assert.equal(last.compatibility.compatibility_key, KEY_NO_ESCROW);
      assert.equal(last.compatibility.diagnostics.build_id, BUILD, "the build rides along, as a diagnostic");
      /* LIVE-6 L6-1 (9f3fb59) added `routed`: a game another pool owns is answered with the route frame to the owner's trusted
         path (counted by gameServer's answerRouted; l6_1Routing pins the count). The snapshot's key set follows it. */
      assert.deepEqual(Object.keys(last.client_answers).sort(), ["connectionReload", "gameReload", "legacyRefused", "routeFailClosed", "routed"]);
    } finally {
      await stopServer(server);
    }
    const banner = bannerLines(compatibilityDescriptor(thisDeploymentCapability([]), { build_id: "abc" })).join("\n");
    assert.match(banner, new RegExp(`compatibility key ${KEY_NO_ESCROW}`));
    assert.match(banner, /build "abc" is diagnostic only/);
  });

  test("3. a BUILD_ID change moves only the diagnostic block: not the key, not the capability, not a protocol-1 client's answer (the legacy wire keeps its compare)", () => {
    const capability = thisDeploymentCapability([PIN]);
    const one = compatibilityDescriptor(capability, { build_id: "build-one" });
    const two = compatibilityDescriptor(capability, { build_id: "build-two" });
    assert.equal(one.compatibility_key, two.compatibility_key);
    assert.equal(canonicalJson(one.capability), canonicalJson(two.capability));
    const strip = (text: string) => { const parsed = JSON.parse(text) as Record<string, unknown>; delete parsed.diagnostics; return canonicalJson(parsed); };
    assert.equal(strip(compatibilityDescriptorText(one)), strip(compatibilityDescriptorText(two)), "everything but diagnostics is byte-identical");
    assert.notEqual(compatibilityDescriptorText(one), compatibilityDescriptorText(two), "and the diagnostic is still shown");
    assert.equal(JSON.stringify(one.capability).includes("build-one"), false, "no build id inside the keyed descriptor");
    /* A protocol-1 client's verdict never reads a build: two different `cb`s, one answer. */
    const announce = (build: string) => parseClientAnnouncement({ cp: String(CLIENT_PROTOCOL_VERSION), cr: String(RULES_ENGINE_VERSION), cb: build });
    assert.deepEqual(clientVerdict(announce("build-one"), capability, RULES_ENGINE_VERSION), clientVerdict(announce("build-two"), capability, RULES_ENGINE_VERSION));
    /* The tool's key comes from the facts, never from BUILD_ID. */
    return withDir("compat-build", async (dir) => {
      const a = JSON.parse(cli(dir, ["compat"], { BUILD_ID: "a" }).stdout) as { compatibility_key: string; diagnostics: { build_id: string } };
      const b = JSON.parse(cli(dir, ["compat"], { BUILD_ID: "b" }).stdout) as { compatibility_key: string; diagnostics: { build_id: string } };
      assert.deepEqual([a.compatibility_key, b.compatibility_key, a.diagnostics.build_id, b.diagnostics.build_id], [KEY_NO_ESCROW, KEY_NO_ESCROW, "a", "b"]);
      assert.match(code(source("server/src/compatibilityDescriptor.ts")), /compatibility_key: compatibilityKey\(canonical\),/, "the key is production's function over the canonical capability alone");
    });
  });
});

/* ================================================================================================= */
/* 4, 7. The stored games' verdict is production's                                                    */
/* ================================================================================================= */

describe("LIVE-4 L4-6: stored-game inspection asks the canonical verdict through production's wiring", () => {
  test("4. by source: the tool assembles the pool from `createSettlementCoordinator` and `createContinuationWiring`, asks `wiring.verdictOf`, and calls no verdict function of its own", () => {
    const tool = code(source("server/src/tools/gamesDoctor.ts"));
    assert.match(tool, /createSettlementCoordinator\(\{/);
    assert.match(tool, /createContinuationWiring\(\{ capability: serving\.capability, runtime: serving\.runtime\(\), policy: \{ legacyLogs: "refuse" \}/);
    assert.match(tool, /const verdict = wiring\.verdictOf\(gameId, identity, logFormat\);/);
    assert.match(tool, /gameplayVerdict: wiring\.gameplayVerdictOf,/, "inspect's discovery gets the pool's gameplay verdict, as the room host gives it");
    assert.equal(/continuationVerdict\(/.test(tool), false, "no direct verdict call: the wiring asks it");
    assert.equal(/localContinuationVerdict|localGameplayCapability/.test(tool), false, "no local approximation");
    assert.equal(/thisDeploymentCapability\(/.test(tool), false, "no capability of its own: the escrow service's constructor");
    assert.equal(/BUILD_ID|build_id|diagnosticFlag/i.test(tool.split("const { wiring, coordinator, records } = await toolPool(dataDir, serving, now);")[1].split("return { compatibility")[0]), false, "no build read in the verdict loop");
  });

  test("7a. no-money games: each class is what a running production server answers the same game's hello -- continues, and every derived reason", () =>
    withDir("parity", async (dir) => {
      const continues = dealtOnDisk(dir);
      const hostedTwo = dealtOnDisk(dir, { log: (entries) => withDeal(entries, (setup) => (setup.hosted_protocol = 2)) });
      const malformed = dealtOnDisk(dir, { log: (entries) => withDeal(entries, (setup) => (setup.hosted_protocol = "two")) });
      const newerRules = dealtOnDisk(dir, { log: (entries) => withDeal(entries, (setup) => (setup.rules_engine_version = RULES_ENGINE_VERSION + 1)) });
      const legacy = dealtOnDisk(dir, { log: (entries) => withDeal(entries, (setup) => { delete setup.rules_engine_version; delete setup.hosted_protocol; }) });
      const unknownKind = dealtOnDisk(dir, { log: (entries) => [...entries, { index: entries.length, id: "from-a-newer-build", actor: ALICE, payload: JSON.stringify({ FutureMove: { game_id: 0 } }), at: Date.now() }] });
      const newerLine = dealtOnDisk(dir, { tail: NEWER_LINE });
      const otherBuild = dealtOnDisk(dir, { log: (entries) => withDeal(entries, (setup) => (setup.build = "another-build")) });
      const before = snapshot(dir);
      const report = await inspectContinuation(dir);
      assert.deepEqual(snapshot(dir), before, "the inspection wrote nothing");
      const toolClass = new Map(report.games.map((game) => [game.gameId, game.class]));
      const expected: ReadonlyArray<readonly [string, string]> = [
        [continues, "continues"],
        [otherBuild, "continues"],
        [hostedTwo, "not-continued/hosted-protocol"],
        [malformed, "not-continued/malformed"],
        [newerRules, "not-continued/rules-not-supported"],
        [legacy, "not-continued/legacy-unpinned"], // and discovery HOLDS it first (below)
        [unknownKind, "not-continued/newer-format"],
        [newerLine, "not-continued/newer-format"],
      ];
      for (const [gameId, klass] of expected) assert.equal(toolClass.get(gameId), klass, `${gameId}: the tool's class`);
      /* Production's discovery, reported beside the verdict: an unpinned SERVER deal is held (#1520, integrity) before
         the continuation question is asked; the derived ones are incompatible from the deal line, never held. */
      const discovery = new Map(report.games.map((game) => [game.gameId, game.discovery]));
      assert.deepEqual(discovery.get(legacy), { cls: "held", code: "rules-pin-mismatch" });
      assert.deepEqual(discovery.get(hostedTwo), { cls: "incompatible", code: "hosted-protocol" });
      assert.deepEqual(discovery.get(newerRules), { cls: "incompatible", code: "rules-version-newer" });
      /* The same games, served by a real server over the same directory (a copy: the server repairs torn tails). */
      const copy = fs.mkdtempSync(path.join(os.tmpdir(), "l4-6-parity-server-"));
      fs.cpSync(dir, copy, { recursive: true });
      const ops = createMemoryOpsRecorder();
      const { server, port } = await startServer({ store: createFileLogStore(copy, quiet), records: createFileRecordStore(copy, quiet), holds: createFileHoldStore(copy, quiet), ops });
      try {
        await server.lifecycle.ready;
        for (const [gameId, klass] of expected) {
          const client = await Client.open(port, BOB);
          try {
            client.hello(gameId);
            const answer: Frame = await client.next((f) => f.kind === "catch-up" || f.kind === "incompatible" || f.kind === "error", `hello ${gameId}`);
            const served = answer.kind === "catch-up" ? "continues" : answer.kind === "incompatible" ? `not-continued/${String(answer.why)}` : `error/${String(answer.code)}`;
            /* The server answers #1520's direction code for a rules pin it does not play (the derived reason is the
               same one: a pin outside `rules.supported`). */
            const normalized = served === "not-continued/rules-version-newer" ? "not-continued/rules-not-supported" : served;
            /* A game discovery held is refused as held; every other one is answered with the verdict the tool printed. */
            assert.equal(normalized, discovery.get(gameId)?.cls === "held" ? "error/held" : klass, `${gameId}: the production hello`);
          } finally {
            await client.close();
          }
        }
      } finally {
        await stopServer(server);
        fs.rmSync(copy, { recursive: true, force: true });
      }
    }));

  test("7b. money games: continues, another deployment, a configuration typo, a verified contradiction (conflict, owned here), newer / damaged financial records, newer intents -- the integration matrix's answers; the money seam agrees; nothing is written", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly serves: FinancialDeploymentPin;
      readonly fin: "dealt" | "newer" | "damaged" | "missing";
      readonly read: ReturnType<typeof chainRead> | null;
      readonly intents?: "newer";
      readonly expected: string;
      readonly owner: boolean;
      readonly finClass: string;
    }> = [
      { name: "served, the chain agrees", serves: PIN, fin: "dealt", read: chainRead(CANONICAL_CHECKSUM, PIN.denom), expected: "continues", owner: true, finClass: "current" },
      { name: "C: another deployment", serves: PIN_B, fin: "dealt", read: null, expected: "not-continued/deployment-unavailable", owner: false, finClass: "current" },
      { name: "D: a configuration typo, chain unread", serves: PIN_TYPO, fin: "dealt", read: null, expected: "not-continued/deployment-unverified", owner: true, finClass: "current" },
      { name: "E: a verified contradiction", serves: PIN, fin: "dealt", read: chainRead(OTHER_CHECKSUM, PIN.denom), expected: "conflict/deployment-conflict", owner: true, finClass: "current" },
      { name: "a newer build's financial record", serves: PIN, fin: "newer", read: null, expected: "not-continued/newer-format", owner: true, finClass: "newer" },
      { name: "a damaged financial record", serves: PIN, fin: "damaged", read: null, expected: "not-continued/malformed", owner: true, finClass: "corrupt" },
      { name: "a money table with no financial record", serves: PIN, fin: "missing", read: null, expected: "conflict/financial-record-missing", owner: true, finClass: "missing" },
      { name: "a damaged financial record served ELSEWHERE (owner: the GameRecord's terms name another deployment)", serves: PIN_B, fin: "damaged", read: null, expected: "not-continued/malformed", owner: false, finClass: "corrupt" },
      { name: "newer chain intents", serves: PIN, fin: "dealt", read: null, intents: "newer", expected: "not-continued/newer-format", owner: true, finClass: "current" },
    ];
    for (const c of cases) {
      await withDir("money", async (dir) => {
        const gameId = mintGameId();
        writeRecord(dir, moneyRecord(gameId, PIN));
        writeLog(dir, gameId, storedLog(2));
        const record = dealtFin(gameId, PIN);
        if (c.fin === "dealt") writeFin(dir, gameId, `${JSON.stringify(record)}\n`);
        if (c.fin === "newer") writeFin(dir, gameId, `${JSON.stringify({ ...record, version: FINANCIAL_VERSION + 1 })}\n`);
        if (c.fin === "damaged") writeFin(dir, gameId, `${JSON.stringify(record).slice(0, 80)}`);
        if (c.intents === "newer") {
          const intents = path.join(dir, "games", "chain-intents", gameId);
          fs.mkdirSync(intents, { recursive: true });
          fs.writeFileSync(path.join(intents, `${"f".repeat(64)}.json`), `${JSON.stringify({ format: "gs-chain-intent", schema: 3 /* FP4 writes schema 2 */, game_id: gameId, intent_id: "f".repeat(64) })}\n`);
        }
        const serving = createMoneyServing({ capability: thisDeploymentCapability([c.serves]) });
        if (c.read !== null) serving.recordChainFacts(c.read);
        const before = snapshot(dir);
        const report = await inspectContinuation(dir, { serving });
        const money = await inspectMoney(dir, gameId, { serving });
        assert.deepEqual(snapshot(dir), before, `${c.name}: not one byte (no hold, no placeholder, no repair)`);
        const game = report.games.find((entry) => entry.gameId === gameId);
        assert.ok(game !== undefined, c.name);
        assert.equal(game.money, true, c.name);
        assert.equal(game.class, c.expected, `${c.name}: the session verdict`);
        assert.ok(game.money_seam !== null, c.name);
        assert.equal(game.money_seam.agrees, true, `${c.name}: the money seam agrees`);
        assert.equal(game.money_seam.same_reason, true, `${c.name}: and for the same reason`);
        assert.equal(game.money_seam.owner, c.owner, `${c.name}: owner (L4-4)`);
        assert.equal(game.artifacts.fin, c.finClass, `${c.name}: the financial record's class`);
        if (c.intents === "newer") assert.equal(game.artifacts.intents, "newer", c.name);
        /* L4-4's money view, unchanged, says the same. */
        const seen = money.games.find((entry) => entry.gameId === gameId);
        const moneyClass = c.expected === "continues" ? "continued" : c.expected.startsWith("conflict/") ? "conflict" : c.expected.slice("not-continued/".length);
        assert.equal(seen?.class, moneyClass, `${c.name}: gamesDoctor money`);
        /* And production's pool over the same facts (memory store, as `start.ts` assembles it) gives the same verdict. */
        if (c.fin === "dealt" && c.intents === undefined) {
          const store = createMemoryFinancialGameStore();
          store.records.set(gameId, record);
          const coordinator = createSettlementCoordinator({ store, replay: serverPrefixReplay(BUILD), now: () => T0, warn: () => undefined, serving, readDeal: async () => DEALT, readLogFormat: async () => "current", artifactFormats: async () => ({}), schedule: () => ({ cancel: () => undefined }) });
          await coordinator.load();
          const wiring = createContinuationWiring({ capability: serving.capability, runtime: serving.runtime(), policy: { legacyLogs: "refuse" }, moneyFacts: coordinator, recordOf: () => moneyRecord(gameId, PIN), now: () => T0 });
          assert.equal(why(wiring.verdictOf(gameId, DEALT)), c.expected, `${c.name}: production's pool`);
          coordinator.stop();
        }
      });
    }
  });
});

describe("LIVE-4 L4-6 review fixes: owner from the terms (F2), the same answer with another first reason (F1), every stored game listed (F3)", () => {
  test("F1/F2: an unreadable financial record AND a newer build's log -- both seams 'not continued' (the session names the log, the money seam the record); owner from the GameRecord's terms, as the coordinator's step -1 decides it", () =>
    withDir("f1f2", async (dir) => {
      const gameId = mintGameId();
      writeRecord(dir, moneyRecord(gameId, PIN));
      writeLog(dir, gameId, storedLog(1), NEWER_LINE);
      writeFin(dir, gameId, `${JSON.stringify({ ...dealtFin(gameId, PIN), version: FINANCIAL_VERSION + 1 })}\n`);
      const serving = createMoneyServing({ capability: servingCapability([PIN]) });
      const before = snapshot(dir);
      const report = await inspectContinuation(dir, { serving });
      assert.deepEqual(snapshot(dir), before);
      const game = report.games.find((entry) => entry.gameId === gameId);
      assert.equal(game?.class, "not-continued/newer-format", "the session verdict: formats are checked in artifact order");
      assert.deepEqual(
        [game?.money_seam?.class, game?.money_seam?.agrees, game?.money_seam?.same_reason, game?.money_seam?.owner, game?.money_seam?.deployment],
        ["newer-format", true, true, true, KEY_A],
        "a newer financial record: the same answer and reason; owned by the terms' deployment",
      );
      /* A damaged record beside the newer log: the money seam stops at the record (malformed); the session names the
         log first. The same kind of answer -- and the tool says so rather than calling it a defect. */
      writeFin(dir, gameId, JSON.stringify(dealtFin(gameId, PIN)).slice(0, 60));
      const damaged = (await inspectContinuation(dir, { serving })).games.find((entry) => entry.gameId === gameId);
      assert.deepEqual([damaged?.class, damaged?.money_seam?.class, damaged?.money_seam?.agrees, damaged?.money_seam?.same_reason], ["not-continued/newer-format", "malformed", true, false]);
      const cliOut = cli(dir, ["continuation", gameId]);
      assert.equal(/DISAGREES/.test(cliOut.stdout), false, cliOut.stdout);
      assert.match(cliOut.stdout, /the same answer; the money seam names another unreadable artifact first/);
      /* Production's own step -1 over the same files decides the same owner (`ownerKey: termsKey`). */
      assert.match(code(source("server/src/escrow/settlementCoordinator.ts")), /ownerKey: termsKey/);
      assert.match(code(source("server/src/tools/gamesDoctor.ts")), /const terms = await moneyTermsOnDisk\(dataDir, gameId\);/);
    }));

  test("F3: a log (or a hold) with no GameRecord is listed as no-record, with discovery's class -- never dropped, never judged as a game", () =>
    withDir("f3", async (dir) => {
      const listed = dealtOnDisk(dir);
      const orphan = mintGameId();
      writeLog(dir, orphan, storedLog(1));
      const report = await inspectContinuation(dir);
      const of = (gameId: string) => report.games.find((game) => game.gameId === gameId);
      assert.equal(of(listed)?.class, "continues");
      assert.deepEqual([of(orphan)?.class, of(orphan)?.verdict, of(orphan)?.discovery], ["no-record", null, { cls: "attention", code: "orphan-log" }]);
    }));
});

/* ================================================================================================= */
/* 5, 6. Inspection cannot write; a newer build's log stays byte-identical                            */
/* ================================================================================================= */

describe("LIVE-4 L4-6: no inspection command writes", () => {
  test("5a. the read-only file system refuses every write before the operating system is asked, and makes no directory", async () =>
    withDir("ro-fs", async (dir) => {
      const ro = readOnlyStoreFs(nodeStoreFs);
      const file = path.join(dir, "x");
      fs.writeFileSync(file, "x");
      await assert.rejects(() => ro.open(file, "r+"), ReadOnlyInspectionError);
      await assert.rejects(() => ro.open(path.join(dir, "new"), "wx"), ReadOnlyInspectionError);
      await assert.rejects(() => ro.rename(file, `${file}.moved`), ReadOnlyInspectionError);
      await assert.rejects(() => ro.unlink(file), ReadOnlyInspectionError);
      await assert.rejects(() => ro.appendFile(file, "y"), ReadOnlyInspectionError);
      await ro.mkdir(path.join(dir, "made"));
      assert.deepEqual(fs.readdirSync(dir), ["x"]);
      assert.equal(fs.readFileSync(file, "utf8"), "x");
      assert.equal((await (await ro.open(file, "r")).close(), true), true, "reads still open");
    }));

  test("5b/6. every inspection command, run as the operator runs it, leaves the data directory byte-identical -- a newer build's log, a torn tail the server WOULD truncate, a damaged log, a held game, a newer record, money of every class", () =>
    withDir("cli-bytes", async (dir) => {
      const clean = dealtOnDisk(dir);
      const newer = dealtOnDisk(dir, { tail: NEWER_LINE });
      const torn = dealtOnDisk(dir, { tail: serializeBatch([storedLog(2)[2]]).slice(0, 30) });
      /* Damage: a line that is not a record, with this build's complete entries after it (the store holds it). */
      const damaged = dealtOnDisk(dir, { buys: 2 });
      const [first, , third] = logBytes(storedLog(2)).split("\n");
      fs.writeFileSync(logPath(dir, damaged), `${first}\n{"index":1,"id":\u0000garbage\n${third}\n`);
      const newerRecord = mintGameId();
      writeRecord(dir, { ...seededRecord([ALICE, BOB], { dealt: true, gameId: newerRecord }), record_schema: 3 } as unknown as Record<string, unknown>, newerRecord);
      const money = mintGameId();
      writeRecord(dir, moneyRecord(money, PIN));
      writeLog(dir, money, storedLog(1));
      writeFin(dir, money, `${JSON.stringify({ ...dealtFin(money, PIN), version: FINANCIAL_VERSION + 1 })}\n`);
      const newerBytes = fs.readFileSync(logPath(dir, newer));
      const tornBytes = fs.readFileSync(logPath(dir, torn));
      const before = snapshot(dir);
      const runs = [
        ["inspect"],
        ["inspect", "--deep"],
        ["inspect", "--json"],
        ["continuation"],
        ["continuation", "--json"],
        ["continuation", newer],
        ["money"],
        ["money", "--json"],
        ["compat"],
        ["status"],
        ["scan-v10"],
        ["gc"],
      ];
      for (const args of runs) {
        const run = cli(dir, args);
        assert.ok(run.status === 0 || run.status === 1, `${args.join(" ")}: ran (${run.status}) ${run.stderr}`);
        assert.deepEqual(snapshot(dir), before, `${args.join(" ")}: not one byte, no file or directory created`);
      }
      assert.ok(fs.readFileSync(logPath(dir, newer)).equals(newerBytes), "the newer build's log is byte-identical");
      assert.ok(fs.readFileSync(logPath(dir, torn)).equals(tornBytes), "the torn tail is still there (only the server's load repairs it)");
      /* What the continuation command said about each. */
      const report = JSON.parse(cli(dir, ["continuation", "--json"]).stdout) as { games: Array<{ gameId: string; class: string; artifacts: { log: string; record: string }; damaged_log: boolean }> };
      const of = (gameId: string) => report.games.find((game) => game.gameId === gameId);
      assert.deepEqual([of(clean)?.class, of(clean)?.artifacts.log], ["continues", "clean"]);
      assert.deepEqual([of(newer)?.class, of(newer)?.artifacts.log], ["not-continued/newer-format", "newer-format"]);
      assert.deepEqual([of(torn)?.class, of(torn)?.artifacts.log], ["continues", "torn-tail"]);
      assert.deepEqual([of(damaged)?.artifacts.log, of(damaged)?.damaged_log], ["corrupt", true]);
      assert.deepEqual([of(newerRecord)?.class, of(newerRecord)?.artifacts.record], ["record-newer-format", "newer"]);
      assert.equal(of(money)?.class, "not-continued/newer-format");
      /* An empty data directory stays empty: no store makes its directory. */
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "l4-6-empty-"));
      try {
        for (const args of [["inspect"], ["continuation"], ["money"], ["compat"]]) cli(empty, args);
        assert.deepEqual(fs.readdirSync(empty), [], "nothing created in an empty data directory");
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    }));

  test("5c. the library entry points too (inspectData over the pool's gameplay verdict), and discovery's classes are unchanged by the wiring", () =>
    withDir("lib-bytes", async (dir) => {
      const continues = dealtOnDisk(dir);
      const hostedTwo = dealtOnDisk(dir, { log: (entries) => withDeal(entries, (setup) => (setup.hosted_protocol = 2)) });
      const newer = dealtOnDisk(dir, { tail: NEWER_LINE });
      const before = snapshot(dir);
      const inspection = await inspectData(dir, { deep: true });
      assert.deepEqual(snapshot(dir), before);
      const cls = (gameId: string) => inspection.games.find((game) => game.gameId === gameId);
      assert.equal(cls(continues)?.deep?.ok, true);
      assert.deepEqual([cls(hostedTwo)?.cls, cls(hostedTwo)?.code], ["incompatible", "hosted-protocol"]);
      assert.equal(cls(newer)?.deep?.logClassification, "newer-format");
    }));
});

/* ================================================================================================= */
/* 8. The pins                                                                                        */
/* ================================================================================================= */

describe("LIVE-4 L4-6: no protocol or version moved", () => {
  test("8. rules 13 (reads [13]; 11 / [11] through LIVE-4, 12 / [12] from Route v12 R12-2 until W3-K); settlement [10, 11, 12, 13] (12 certified by R12-3; 13 by Phase 3's v13 certification); hosted 1; financial 4 (3 until Phase 3's escrow 2.1 timed remedies); client 1 accepting [0, 1]; money GameRecords schema 2; the keys as the v13 certification and financial protocol 4 moved them", () => {
    assert.equal(RULES_ENGINE_VERSION, 13);
    assert.deepEqual([...SUPPORTED_RULES_ENGINE_VERSIONS], [13]);
    assert.deepEqual([...SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS], [10, 11, 12, 13]);
    assert.equal(HOSTED_PROTOCOL_VERSION, 1);
    assert.equal(FINANCIAL_PROTOCOL_VERSION, 4);
    assert.equal(CLIENT_PROTOCOL_VERSION, 1);
    assert.deepEqual([...ACCEPTED_CLIENT_PROTOCOLS], [0, 1]);
    assert.equal((moneyRecord(mintGameId(), PIN) as unknown as { record_schema: number }).record_schema, 2);
    assert.match(source("server/src/rooms/gameRecord.ts"), /record_schema: 1 \| 2;/);
    assert.equal(compatibilityKey(thisDeploymentCapability([])), KEY_NO_ESCROW);
    assert.equal(compatibilityKey(deploymentCapability(thisDeploymentCapability([PIN]))), KEY_FIXTURE_PIN);
  });
});
