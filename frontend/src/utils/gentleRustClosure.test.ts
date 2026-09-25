/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1705: GENTLE RUST CERTIFICATION CLOSURE -- THE ONE DELIBERATE BUMP, 8 -> 9 (GR-5)
// ==================================================================
//
// THE SAME SHAPE AS 7.5, 8.5, STAGE 9 AND STAGE 10. GR-1, GR-2 and DT-1 each changed what a stored log replays to,
// and each left the pin at 8 -- an implementation slice stays on the version it was written against, so the corpus
// and the constructed certification game could be measured slice by slice against one baseline -- and standalone
// Gentle Rust certification takes ONE bump at closure, where the whole semantic set is named in one changelog row.
//
// EXACTLY FOUR REPLAY SEMANTICS, and nothing else:
//   (A) GR-1 (#1699): a self-triggered Gentle Rust doom survives into the corporation's NEXT FUTURE Operating Turn
//       instead of expiring at the end of the Buy Trains turn that caused it;
//   (B) GR-2 (#1700, OD-GR-1): a reprieved / Final Run train may not be sold or transferred;
//   (C) GR-2 (#1700, OD-GR-2): a reprieved / Final Run train may not be a Diesel trade-in ($800, LPF $750);
//   (D) DT-1 (#1701, base game): the train limit no longer auto-ends Buy Trains while a legal one-for-one Diesel
//       exchange remains.
// NOT RULES, and named in the row only behind an explicit marker: GR-3's UI / copy / Rules Reference / narration
// (#1702), GR-4's certification tests, documents and constructed game (#1703), and the owner-ruled U-9 post-game
// statistics correction (#1704, derived history -- no board, message or digest moves). NOT IN THIS VERSION AT ALL:
// OD-GR-3 (the Yellow Sign against a reprieved train), which belongs to Unpredictable Revenue certification, and the
// backlog's Part C U-41 (a standard-game statistics gap, open and unimplemented).
//
// WHY THE BUMP IS OWED EVEN THOUGH THE CORPUS IS QUIET. The canonical 18-file corpus is unpinned development history,
// and its one Gentle Rust log (JUNO-3XD) never leaves phase 2, so none of the four is reached by a stored entry. But a
// pin states what a log MEANS: a version-8 log can carry self-doomed trains destroyed at the end of the turn that
// doomed them, reprieved trains sold or traded in for a Diesel, and Buy Trains steps auto-ended at the limit with a
// legal exchange still open. It is refused, never reinterpreted.
//
// WHAT THIS FILE DOES NOT DO: re-prove Gentle Rust. GR-1 (`gentleRustGraceTurn`), GR-2 (`gentleRustTransactionLocks`),
// DT-1 (`dieselExchangeAutoSkip`), GR-3 (`gentleRustPresentation`) and GR-4 (`gentleRustCertification*`) own the rules.
// This file proves the version boundary (the supported-version matrix with 8 as the prior pinned version), that the
// four semantics are the current engine's unconditionally (no authority asks the pin's value), and that the
// development corpus stays unreinterpreted. It OWNS the current version literal until the next closure narrows it,
// as this pass narrowed `stage10Closure.test.ts` (#1698's precedent for `stage9Closure`).
// *(UR-8, 2026-09-25: narrowed exactly so -- the 9 -> 10 boundary moved the current literal to
// `unpredictableRevenueClosure.test.ts`; row 9 and the v8 matrix are unchanged here, version literals only.)*

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

import { RoomSession } from "./roomSession";
import type { ServerLogEntry } from "./roomSession";
import { RoomEngine, replayLog, entriesFromExport } from "../gameEngine/replayLog";
import type { ExportedEntry, ReplayProviders } from "../gameEngine/replayLog";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { stateDigest } from "../gameEngine/stateDigest";
import {
  DEVELOPMENT_CORPUS_POLICY,
  RULES_ENGINE_CHANGELOG,
  RULES_ENGINE_VERSION,
  RULES_ENGINE_VERSION_FIELD,
  ReplayIncompatibleError,
  SERVER_REPLAY_POLICY,
  SUPPORTED_RULES_ENGINE_VERSIONS,
  replayCompatibility,
  replayRefusal,
  rulesEngineVersionOf,
} from "../gameEngine/rulesVersion";
import { readStripped } from "./sourceScan";
import { certificationStart } from "./gentleRustCertificationGame";

const BUILD = "b";
const P1 = "p-alice";
const P2 = "p-bob";
/** The version this closure replaced: the prior pinned version of the matrix below. */
const PRIOR = 8;

const seed = () => ({
  state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});

/** The real providers, counting the one injection `RoomEngine.apply` asks on EVERY entry it interprets. */
function countingProviders(): { providers: ReplayProviders; count: () => number } {
  const real = sandboxReplayProviders();
  let fed = 0;
  return {
    providers: { ...real, chartInjections: (state) => ((fed += 1), real.chartInjections(state)) },
    count: () => fed,
  };
}

function session(entries?: readonly ServerLogEntry[], opts: { build?: string; providers?: ReplayProviders; dev?: boolean } = {}) {
  let n = 0;
  const room = new RoomSession({
    providers: opts.providers ?? sandboxReplayProviders(),
    seed: seed(),
    build: opts.build ?? BUILD,
    mintId: () => `id${(n += 1)}`,
    now: () => 1_000 + n,
    ...(opts.dev ? { replayPolicy: DEVELOPMENT_CORPUS_POLICY } : {}),
  });
  if (entries) room.restore(entries);
  return room;
}

const SETUP = (claimed?: number, variants: Record<string, unknown> = {}) =>
  ({
    SetupGame: {
      players: [{ id: P1, nickname: "A" }, { id: P2, nickname: "B" }],
      variants,
      build: BUILD,
      ...(claimed === undefined ? {} : { [RULES_ENGINE_VERSION_FIELD]: claimed }),
    },
  }) as never;
const BUY_LOWEST = { WaterfallBuyLowest: { game_id: 0 } } as never;

/** A room dealt by this server and played one move. */
function playedRoom(claimed?: number, variants: Record<string, unknown> = {}) {
  const room = session();
  expect(room.submit({ actor: P1, build: BUILD, msg: SETUP(claimed, variants), baseIndex: -1 }).kind).toBe("applied");
  const first = room.state.player_addresses[0];
  expect(room.submit({ actor: first, build: BUILD, msg: BUY_LOWEST, baseIndex: room.nextIndex - 1 }).kind).toBe("applied");
  return room;
}

const setupPayloadOf = (entries: readonly ServerLogEntry[]) =>
  JSON.parse(entries.find((row) => "SetupGame" in JSON.parse(row.payload))!.payload).SetupGame as Record<string, unknown>;

/** A stored log whose deal names `version` (or none) -- what a store written by another engine looks like. */
const repinned = (entries: readonly ServerLogEntry[], version: number | undefined): ServerLogEntry[] =>
  entries.map((row) => {
    const parsed = JSON.parse(row.payload) as { SetupGame?: Record<string, unknown> };
    if (!parsed.SetupGame) return { ...row };
    const setup = { ...parsed.SetupGame };
    if (version === undefined) delete setup[RULES_ENGINE_VERSION_FIELD];
    else setup[RULES_ENGINE_VERSION_FIELD] = version;
    return { ...row, payload: JSON.stringify({ ...parsed, SetupGame: setup }) };
  });

/* ================================================================================================= */
/* 1. THE BUMP                                                                                        */
/* ================================================================================================= */

describe("RULES_ENGINE_VERSION 9 (Gentle Rust certification closure, GR-5)", () => {
  it("is at least 9, and the supported list is still the one derived version", () => {
    /* UR-8: THIS CASE NO LONGER OWNS THE CURRENT VERSION -- #1705's own precedent for `stage10Closure`. It asserted
       `=== 9` and `[9]`, the right claim for the pass that MADE 9 and the wrong one for every closure after it; the 9 -> 10
       bump would fail a Gentle Rust case that has nothing to say about Unpredictable Revenue. Row 9 is still asserted in
       full below; the current version belongs to `unpredictableRevenueClosure.test.ts`. Version-literal only. */
    expect(RULES_ENGINE_VERSION).toBeGreaterThanOrEqual(9);
    // Derived, as every bump since version 1 has left it -- the bump REPLACES the supported version.
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([RULES_ENGINE_VERSION]);
  });

  it("the changelog has a ninth row, and it names exactly the four semantic changes", () => {
    // UR-8: a PREFIX pin, as `stage10Closure` / `stage9Closure` / `stage85Closure` / `batch75Closure` hold their own rows -- row 10 is UR-8's.
    expect(RULES_ENGINE_CHANGELOG.map((row) => row.version).slice(0, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const note = RULES_ENGINE_CHANGELOG[8].note;
    for (const phrase of [
      /Gentle Rust certification closure/,
      /GR-5/,
      /REPLAY SEMANTICS, exactly\s+four/,
      // (A) GR-1
      /\(A\) GR-1 \(#1699\)/,
      /SELF-TRIGGER/,
      /NEXT FUTURE Operating Turn/,
      /pending_rust_doomed_this_turn/,
      // (B) GR-2, OD-GR-1
      /\(B\) GR-2 \(#1700, OD-GR-1\)/,
      /may no longer be sold or\s+transferred/,
      /proposal, answer and settlement/,
      // (C) GR-2, OD-GR-2
      /\(C\) GR-2 \(#1700, OD-GR-2\)/,
      /may no longer be\s+used as a Diesel trade-in/,
      /\$800/,
      /\$750/,
      // (D) DT-1
      /\(D\) DT-1\s+\(#1701/,
      /base-game correction on every table/,
      /no longer auto-ends Buy Trains/,
      /legal one-for-one Diesel exchange/,
      // the boundary itself
      /refused, never reinterpreted/,
    ]) {
      expect(`row9 matches ${String(phrase)}: ${phrase.test(note)}`).toBe(`row9 matches ${String(phrase)}: true`);
    }
    // Exactly four lettered entries: no (E).
    expect(note.match(/\([A-Z]\) (?:GR|DT)-\d/g)).toEqual(["(A) GR-1", "(B) GR-2", "(C) GR-2", "(D) DT-1"]);
  });

  it("the row keeps GR-3, GR-4 and U-9 behind an explicit NOT RULES marker, after all four semantics", () => {
    const note = RULES_ENGINE_CHANGELOG[8].note;
    const semantics = note.indexOf("REPLAY SEMANTICS");
    const lastSemantic = note.indexOf("(D) DT-1");
    const notRules = note.indexOf("NOT RULES");
    expect(semantics).toBeGreaterThanOrEqual(0);
    expect(lastSemantic).toBeGreaterThan(semantics);
    expect(notRules).toBeGreaterThan(lastSemantic);
    for (const nonRule of ["#1702", "Rules Reference", "narration", "#1703", "constructed legal certification game", "U-9", "#1704", "post-game"]) {
      const at = note.indexOf(nonRule);
      expect([nonRule, at > notRules]).toEqual([nonRule, true]);
    }
  });

  it("the row certifies standalone Gentle Rust only: OD-GR-3 is named as NOT decided, and U-41 is not in it", () => {
    const note = RULES_ENGINE_CHANGELOG[8].note;
    const notDecided = note.indexOf("NOT DECIDED HERE");
    expect(notDecided).toBeGreaterThan(note.indexOf("NOT RULES"));
    expect(note.indexOf("OD-GR-3")).toBeGreaterThan(notDecided);
    expect(note).toMatch(/combined Gentle Rust \+ Unpredictable Revenue is not certified by this row/);
    expect(note).not.toMatch(/U-41/);
  });
});

/* ================================================================================================= */
/* 2. THE SUPPORTED-VERSION MATRIX                                                                    */
/* ================================================================================================= */

/* UR-8: the matrix was written for a v9-only server. Its literal 9s now read the CURRENT version -- the supported-version
   rule is GR-5's claim, the number is not -- and a stored 8 is still the prior-version case it was; the v10 matrix, with 9
   as the prior pinned version, is `unpredictableRevenueClosure.test.ts`'s. Version-literal only. */
describe("the supported-version matrix under a single-version server", () => {
  it("1. a newly dealt game records the current rules_engine_version -- on the log and on the board, whatever the client claimed", () => {
    // UR-8: 10 was "another version" at 9; at 10 the one-ahead version plays that part.
    for (const claimed of [undefined, 1, 7, PRIOR, RULES_ENGINE_VERSION + 1, 999]) {
      const room = playedRoom(claimed);
      expect(setupPayloadOf(room.entries)[RULES_ENGINE_VERSION_FIELD]).toBe(RULES_ENGINE_VERSION);
      expect(room.rulesEngineVersion()).toBe(RULES_ENGINE_VERSION);
      expect(room.state.rules_engine_version).toBe(RULES_ENGINE_VERSION);
    }
  });

  it("2. a room pinned to the current engine is supported under SERVER_REPLAY_POLICY: restored, rebuilt to the live board, playable", () => {
    const live = playedRoom();
    expect(replayCompatibility(live.entries)).toEqual({ kind: "compatible", version: RULES_ENGINE_VERSION });
    expect(replayRefusal(replayCompatibility(live.entries), SERVER_REPLAY_POLICY)).toBeNull();
    const restored = session(live.entries);
    expect(restored.incompatible).toBeNull();
    expect(stateDigest(restored.state)).toBe(stateDigest(live.state));
    expect(restored.catchUp(-1).kind).toBe("catch-up");
    const headless = replayLog(entriesFromExport(live.entries), sandboxReplayProviders(), seed(), undefined, SERVER_REPLAY_POLICY);
    expect(stateDigest(headless.state)).toBe(stateDigest(live.state));
    expect(headless.state.rules_engine_version).toBe(RULES_ENGINE_VERSION);
  });

  it("3. a v8-pinned room is INCOMPATIBLE: held before the reducer sees an entry, under every policy", () => {
    const eight = repinned(playedRoom().entries, PRIOR);
    expect(replayCompatibility(eight)).toEqual({ kind: "incompatible", version: 8, supported: [RULES_ENGINE_VERSION] });
    const apply = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      for (const dev of [false, true]) {
        const counting = countingProviders();
        const held = session(eight, { providers: counting.providers, dev });
        expect(held.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 8, supported: [RULES_ENGINE_VERSION] });
        expect(held.incompatible?.reason).toMatch(new RegExp(`rules engine version 8; this server supports version ${RULES_ENGINE_VERSION}\\b`));
        expect(counting.count()).toBe(0);
      }
      expect(apply).not.toHaveBeenCalled();
    } finally {
      apply.mockRestore();
    }
    for (const policy of [SERVER_REPLAY_POLICY, DEVELOPMENT_CORPUS_POLICY]) {
      expect(() => replayLog(entriesFromExport(eight), sandboxReplayProviders(), seed(), undefined, policy)).toThrow(
        ReplayIncompatibleError,
      );
    }
  });

  it("3b. a v8-pinned GENTLE RUST room is held the same way -- the variant's v8 history is not reinterpreted", () => {
    /* The boundary this closure exists for: a Gentle Rust game dealt under 8 was played under the pre-GR-1 grace clock
       and the pre-GR-2 transaction rules, so a v9 server must not continue it. Nothing about the variant changes the
       admission question -- the pin decides, before any Gentle Rust rule could be asked. */
    const live = playedRoom(undefined, { gentleRust: true });
    expect((setupPayloadOf(live.entries).variants as Record<string, unknown>).gentleRust).toBe(true);
    expect(live.state.variants?.gentleRust).toBe(true);
    const eight = repinned(live.entries, PRIOR);
    for (const dev of [false, true]) {
      const held = session(eight, { dev });
      expect(held.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 8, supported: [RULES_ENGINE_VERSION] });
      expect(stateDigest(held.state)).toBe(stateDigest(session().state));
    }
    // The same Gentle Rust deal, pinned by this server to the current engine, is admitted and rebuilds to the live board.
    const restored = session(live.entries);
    expect(restored.incompatible).toBeNull();
    expect(stateDigest(restored.state)).toBe(stateDigest(live.state));
  });

  it("4. any other unsupported numeric version is incompatible too", () => {
    const base = playedRoom().entries;
    // UR-8: 10 is the current version now; the one-ahead version plays its part.
    for (const version of [0, 1, 6, 7, RULES_ENGINE_VERSION + 1, 999]) {
      const pinned = repinned(base, version);
      expect(replayCompatibility(pinned)).toEqual({ kind: "incompatible", version, supported: [RULES_ENGINE_VERSION] });
      for (const dev of [false, true]) expect(session(pinned, { dev }).incompatible?.compatibility.kind).toBe("incompatible");
    }
  });

  it("5. a missing version is incompatible under the server / deployment policy -- never read as the current version", () => {
    const legacy = repinned(playedRoom().entries, undefined);
    expect(rulesEngineVersionOf(legacy)).toBeNull();
    expect(replayCompatibility(legacy)).toEqual({ kind: "legacy" });
    const held = session(legacy);
    expect(held.incompatible?.compatibility).toEqual({ kind: "legacy" });
    expect(held.incompatible?.reason).toMatch(/before rules-engine versioning/);
    expect(() => replayLog(entriesFromExport(legacy), sandboxReplayProviders(), seed())).toThrow(ReplayIncompatibleError);
  });

  it("6. a missing version is admitted ONLY by the explicit DEVELOPMENT_CORPUS_POLICY, and stays unpinned there", () => {
    const legacy = repinned(playedRoom().entries, undefined);
    const admitted = session(legacy, { dev: true });
    expect(admitted.incompatible).toBeNull();
    expect(admitted.replayCompatibility()).toEqual({ kind: "legacy" });
    expect(admitted.state.rules_engine_version ?? null).toBeNull();
    const headless = replayLog(entriesFromExport(legacy), sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(headless.state.rules_engine_version ?? null).toBeNull();
    // And the server's own policy object never carries the opt-in.
    expect(SERVER_REPLAY_POLICY.legacyLogs).toBe("refuse");
  });

  it("7. no compatibility path rewrites a stored 8 (or a missing pin) to the current version", () => {
    const base = playedRoom().entries;
    for (const stored of [repinned(base, PRIOR), repinned(base, undefined)]) {
      const before = JSON.stringify(stored);
      for (const dev of [false, true]) {
        const room = session(stored, { dev });
        expect(JSON.stringify(room.entries)).toBe(before);
        expect(setupPayloadOf(room.entries)[RULES_ENGINE_VERSION_FIELD]).toBe(setupPayloadOf(stored)[RULES_ENGINE_VERSION_FIELD]);
        expect(room.rulesEngineVersion()).toBe(rulesEngineVersionOf(stored));
      }
      try {
        replayLog(entriesFromExport(stored), sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
      } catch (error) {
        expect(error).toBeInstanceOf(ReplayIncompatibleError);
      }
      expect(JSON.stringify(stored)).toBe(before);
    }
  });

  it("8. a refused v8 room appends nothing -- a move, a new deal, a RevertTo", () => {
    const eight = repinned(playedRoom().entries, PRIOR);
    const held = session(eight);
    const before = JSON.stringify(held.entries);
    const first = setupPayloadOf(eight).players as Array<{ id: string }>;
    const attempts = [
      held.submit({ actor: first[0].id, build: BUILD, msg: BUY_LOWEST, baseIndex: held.nextIndex - 1 }),
      held.submit({ actor: P1, build: BUILD, msg: SETUP(), baseIndex: held.nextIndex - 1 }),
      held.submit({ actor: P1, build: BUILD, msg: { RevertTo: { index: 0, player: P1, summary: "x" } } as never, baseIndex: held.nextIndex - 1 }),
    ];
    for (const attempt of attempts) expect(attempt.kind).toBe("incompatible");
    expect(JSON.stringify(held.entries)).toBe(before);
    expect(held.nextIndex).toBe(eight.length);
    expect(held.rulesEngineVersion()).toBe(8);
  });

  it("9. catch-up for an incompatible room exposes no history for the server to interpret", () => {
    for (const stored of [repinned(playedRoom().entries, PRIOR), repinned(playedRoom().entries, undefined)]) {
      const held = session(stored);
      const hello = held.catchUp(-1);
      expect(hello.kind).toBe("incompatible");
      expect(Object.keys(hello).sort()).toEqual(["build", "kind", "pinnedRulesEngineVersion", "reason", "supportedRulesEngineVersions"]);
      if (hello.kind !== "incompatible") return;
      expect(hello.pinnedRulesEngineVersion).toBe(rulesEngineVersionOf(stored) ?? null);
      expect(hello.supportedRulesEngineVersions).toEqual([RULES_ENGINE_VERSION]);
      // The engine is at its seed: nothing was interpreted.
      expect(stateDigest(held.state)).toBe(stateDigest(session().state));
    }
  });

  it("10. build compatibility stays a separate concept from rules-engine-version compatibility", () => {
    const live = playedRoom();
    // A different BUILD with the same (current) pin: rebuilt; the deal-build pin (#1252) then answers moves -- never `incompatible`.
    const otherBuild = session(live.entries, { build: "another-deploy" });
    expect(otherBuild.incompatible).toBeNull();
    expect(stateDigest(otherBuild.state)).toBe(stateDigest(live.state));
    const first = live.state.player_addresses[1] ?? live.state.player_addresses[0];
    const move = otherBuild.submit({ actor: first, build: "another-deploy", msg: BUY_LOWEST, baseIndex: otherBuild.nextIndex - 1 });
    expect(move.kind).not.toBe("incompatible");
    // The SAME build with a v8 pin: held regardless of the build.
    const sameBuild = session(repinned(live.entries, PRIOR), { build: BUILD });
    expect(sameBuild.incompatible?.compatibility.kind).toBe("incompatible");
    expect(setupPayloadOf(sameBuild.entries).build).toBe(BUILD);
  });
});

/* ================================================================================================= */
/* 3. THE FOUR SEMANTICS ARE THE CURRENT ENGINE'S, UNCONDITIONALLY                                    */
/* ================================================================================================= */

describe("v9's semantics are carried by the one reducer, not by a version branch", () => {
  it("no authority behind (A)-(D) asks the pin's value, and none names the current version", () => {
    /* One supported version, one reducer (#1520): the four corrections are simply what this engine does. A board
       pinned 9 and an unpinned corpus board are judged by the same code; the corpus stays neutral because no stored
       entry reaches the changed rules (JUNO-3XD, the one Gentle Rust log, never leaves phase 2), not because a gate
       spares it. Were a future edit to fence a rule behind `rules_engine_version >= 9`, it would fail here. */
    const COMPARED = /rules_engine_version\s*(?:>=|<=|>|<|[!=]==?\s*\d)/;
    for (const file of [
      "gameEngine/gentleRustGrace.ts", // (A) the grace clock; (B)/(C) the multiset
      "gameEngine/trainSaleAuthority.ts", // (B)
      "gameEngine/dieselExchange.ts", // (C)
      "gameEngine/derivedActions.ts", // (D)
      "gameEngine/sandboxSession.ts", // the arms and the fallbacks
    ]) {
      const source = readStripped(file);
      expect([file, COMPARED.test(source)]).toEqual([file, false]);
      expect([file, /RULES_ENGINE_VERSION/.test(source)]).toEqual([file, false]);
    }
  });

  it("the constructed legal certification game (GR-4) is dealt at the certified engine", () => {
    // GR-4's game (`gentleRustCertificationGame.test.ts`) owns the behaviour; this pins only the version it now runs at.
    const start = certificationStart();
    expect(start.rules_engine_version).toBe(RULES_ENGINE_VERSION);
    // UR-8: was `toBe(9)`; standalone Gentle Rust is certified at 9, so the game deals at 9 or later. Version-literal only.
    expect(start.rules_engine_version).toBeGreaterThanOrEqual(9);
    expect(start.variants?.gentleRust).toBe(true);
  });
});

/* ================================================================================================= */
/* 4. THE DEVELOPMENT CORPUS IS NOT REINTERPRETED BY THE CONSTANT                                     */
/* ================================================================================================= */

const FROZEN_DIR = join(__dirname, "__fixtures__", "replayGolden", "logs");
const SERVER_DIR = join(__dirname, "..", "..", "..", "server", "data");
const EXPORT_DIR = join(__dirname, "..", "..");
const jsonl = (file: string): ExportedEntry[] =>
  readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as ExportedEntry);
const exportedRows = (file: string): ExportedEntry[] => {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { actions?: ExportedEntry[]; entries?: ExportedEntry[] };
  return raw.actions ?? raw.entries ?? [];
};
function corpus(): Array<{ name: string; entries: ExportedEntry[] }> {
  const out: Array<{ name: string; entries: ExportedEntry[] }> = [];
  const listed = (dir: string, test: (f: string) => boolean) => (existsSync(dir) ? readdirSync(dir).filter(test).sort() : []);
  for (const f of listed(FROZEN_DIR, (f) => f.endsWith(".log.jsonl"))) out.push({ name: `golden/${f}`, entries: jsonl(join(FROZEN_DIR, f)) });
  for (const f of listed(SERVER_DIR, (f) => f.endsWith(".log.jsonl"))) out.push({ name: `server/${f}`, entries: jsonl(join(SERVER_DIR, f)) });
  for (const f of listed(EXPORT_DIR, (f) => /^sandbox-log-JUNO-.*\.json$/.test(f))) out.push({ name: `export/${f}`, entries: exportedRows(join(EXPORT_DIR, f)) });
  const prefix = join(__dirname, "__fixtures__", "JUNO-FCJ-prefix96.log.jsonl");
  if (existsSync(prefix)) out.push({ name: "prefix/JUNO-FCJ-96", entries: jsonl(prefix) });
  const z6c = join(__dirname, "__fixtures__z6cLog.json");
  if (existsSync(z6c)) out.push({ name: "fixture/JUNO-Z6C-494", entries: exportedRows(z6c) });
  return out;
}

describe("the canonical development corpus under the current engine (v9 at GR-5)", () => {
  const files = corpus();
  if (files.length === 0) {
    it("skipped: the development corpus is not present in this checkout", () => expect(files).toEqual([]));
    return;
  }

  it("every file is UNPINNED history: refused by the server's policy, admitted only by the corpus's", () => {
    expect(files).toHaveLength(18);
    for (const { name, entries } of files) {
      const list = entriesFromExport(entries);
      expect([name, replayCompatibility(list).kind]).toEqual([name, "legacy"]);
      expect([name, replayRefusal(replayCompatibility(list), SERVER_REPLAY_POLICY) !== null]).toEqual([name, true]);
      expect([name, replayRefusal(replayCompatibility(list), DEVELOPMENT_CORPUS_POLICY)]).toEqual([name, null]);
    }
  });

  it("replayed under the corpus policy, no board acquires a pin, and the accepted totals stand", () => {
    let stored = 0;
    let applied = 0;
    let dropped = 0;
    for (const { name, entries } of files) {
      const list = entriesFromExport(entries);
      const result = replayLog(list, sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
      expect([name, result.state.rules_engine_version ?? null]).toEqual([name, null]);
      stored += list.length;
      applied += result.applied;
      dropped += result.dropped;
    }
    // The Stage-10 / GR-4 accepted totals, unchanged by the bump (measured old-vs-new entry by entry in the closure record).
    expect({ stored, applied, dropped }).toEqual({ stored: 4105, applied: 3731, dropped: 374 });
  });
});
