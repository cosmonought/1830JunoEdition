/** @jest-environment node */
//
// ==================================================================
//  UR-8: UNPREDICTABLE REVENUE CERTIFICATION CLOSURE -- THE ONE DELIBERATE BUMP, 9 -> 10
// ==================================================================
//
// THE SAME SHAPE AS 7.5, 8.5, STAGE 9, STAGE 10 AND GR-5. UR-3, UR-4 and UR-7 each changed what a stored log replays to,
// and each left the pin at 9 -- an implementation slice stays on the version it was written against, so the corpus and
// the constructed certification game could be measured slice by slice against one baseline -- and Unpredictable Revenue
// certification takes ONE bump at closure, where the whole semantic set is named in one changelog row.
//
// EXACTLY EIGHT REPLAY SEMANTICS (the UR audit's §15 "version boundary" list, item for item):
//   (1) UR-3 (OD-UR-1): the Yellow Sign is an automatic consequence of the run on a pinned table; no client request is
//       authoritative there;
//   (2) UR-3 (OD-GR-3): the Mark judges the post-settlement fleet -- a Final Run train is never a candidate -- and
//       nullifies only the taken train's route;
//   (3) UR-3 (OD-UR-2): the gold-trimmed train leaves at the END of OR set N+1, at the boundary, never on a run;
//   (4) UR-3 (OD-UR-3): a synthetic train never advances the phase;
//   (5) UR-3 (OD-UR-7): a gilded train is never a Diesel trade-in;
//   (6) UR-4 (OD-UR-5): the Blood Price names the copy, moves the buyer only, and cures into an ordinary additional
//       train whose synthetic origin is supply provenance only (through the Bank Pool too);
//   (7) UR-7 (OD-UR-10 = 10-C): an exact $5 tie rounds toward the printed total;
//   (8) UR-3 (OD-UR-13): the Mark's train is permanently removed from the game; the phase is monotonic.
// NOT RULES, and named in the row only behind an explicit marker: the minted award (OD-UR-4, unchanged), UR-5's
// statistics basis (OD-UR-6, derived history), UR-6's UI / copy / Rules Reference / naming (OD-UR-8, OD-UR-12), UR-7's
// tie sentence, debug-chip visibility (UR-N62) and certification evidence, the undo rule (OD-UR-11, unchanged) and the
// seed source (OD-UR-9, deferred to AWS / live multiplayer).
//
// WHY THE BUMP IS OWED EVEN THOUGH THE CORPUS IS QUIET. The canonical 18-file corpus is unpinned development history: its
// stored Yellow Sign entries take the legacy request path they always took, it carries no gilding, ghost, removal
// record or Carcosan transfer, and its 247 Unpredictable Revenue runs meet no exact $5 tie -- so none of the eight is
// reached by a stored entry. But a pin states what a log MEANS: a version-9 log can carry client-chosen Sign requests,
// a Mark that took a Final Run train, a gift that turned the phase, a model-level Blood Price that moved the seller or a
// +10% tie paid half up. It is refused, never reinterpreted.
//
// WHAT THIS FILE DOES NOT DO: re-prove Unpredictable Revenue. UR-3 (`yellowSignRunBound*`, `yellowSignMarkRemoval`,
// `carcosaFogBoundary`, `carcosaSyntheticPhase`, `carcosaGildedExchange`), UR-4 (`carcosaBloodPrice*`), UR-5
// (`unpredictableRevenueStats`), UR-6 (`unpredictableRevenueDisclosure`, `unpredictableRevenueRulesReference`) and UR-7
// (`revenueTieRounding`, `yellowSignDebugChip`, `unpredictableRevenueCertificationGame`) own the rules. This file proves
// the version boundary (the supported-version matrix with 9 as the prior pinned version), that the eight semantics are
// the current engine's unconditionally (no authority asks the pin's value), that the constructed certification game is
// dealt at the certified engine, and that the development corpus stays unreinterpreted. It OWNS the current version
// literal until the next closure narrows it, as this pass narrowed `gentleRustClosure.test.ts` (#1705's precedent for
// `stage10Closure`).

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
import { certificationStart } from "./unpredictableRevenueCertificationGame";

const BUILD = "b";
const P1 = "p-alice";
const P2 = "p-bob";
/** The version this closure replaced: the prior pinned version of the matrix below. */
const PRIOR = 9;
/** Unpredictable Revenue with Gentle Rust -- the combination UR-7's G1 certifies (OD-GR-3). */
const UR_WITH_GR = { unpredictableRevenue: true, gentleRust: true };

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

const row10 = () => RULES_ENGINE_CHANGELOG[9].note;

/* ================================================================================================= */
/* 1. THE BUMP                                                                                        */
/* ================================================================================================= */

describe("RULES_ENGINE_VERSION 10 (Unpredictable Revenue certification closure, UR-8)", () => {
  it("is 10, and 10 is the one supported version", () => {
    expect(RULES_ENGINE_VERSION).toBe(10);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([10]);
    // Derived, as every bump since version 1 has left it -- the bump REPLACES the supported version.
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([RULES_ENGINE_VERSION]);
  });

  it("the changelog has a tenth row, rows 1 - 9 are untouched in order, and row 10 certifies Unpredictable Revenue", () => {
    expect(RULES_ENGINE_CHANGELOG.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(RULES_ENGINE_CHANGELOG[8].note).toMatch(/^Gentle Rust certification closure \(GR-5/);
    const note = row10();
    expect(note).toMatch(/^Unpredictable Revenue certification closure \(UR-8, 2026-09-25\)/);
    expect(note).toMatch(/the Unpredictable Revenue variant -- standalone and\s+with Gentle Rust \(OD-GR-3\) -- is certified/);
    expect(note).toMatch(/UR-3, UR-4 and UR-7/);
  });

  it("row 10 names exactly the eight replay semantics, each with its slice and owner decision", () => {
    const note = row10();
    for (const phrase of [
      /REPLAY SEMANTICS, exactly eight/,
      // (1) automatic authoritative Yellow Sign settlement
      /\(1\) UR-3 \(OD-UR-1\)/,
      /AUTOMATIC consequence of the accepted run/,
      /settleRunYellowSign/,
      /client `YellowSignEvent` is refused at\s+ingress and in the reducer/,
      // (2) the Mark on the post-settlement fleet
      /\(2\) UR-3 \(OD-GR-3\)/,
      /POST-SETTLEMENT fleet/,
      /Final Run train is retired first and is never a candidate/,
      /only the taken train's own route/,
      // (3) the fog at the end of N+1
      /\(3\) UR-3 \(OD-UR-2\)/,
      /END of Operating Round set N\+1/,
      /fogAtSetEnd/,
      // (4) synthetic trains never the phase
      /\(4\) UR-3 \(OD-UR-3\)/,
      /synthetic Carcosa train never advances the phase/,
      // (5) no gilded trade-in
      /\(5\) UR-3 \(OD-UR-7\)/,
      /gilded train is never a Diesel trade-in/,
      /\$800/,
      /\$750/,
      // (6) the Blood Price: the copy, the buyer's move, the cure
      /\(6\) UR-4 \(OD-UR-5\)/,
      /the Blood Price names the COPY/,
      /BUYER's marker moves Left 1 \/ Down 1 and the seller's never/,
      /ordinary additional train whose synthetic origin is supply provenance only/,
      /returned_ghost_trains/,
      // (7) 10-C
      /\(7\) UR-7 \(OD-UR-10 = 10-C\)/,
      /exact \$5 tie of the modified revenue rounds toward the printed total/,
      /roundRevenueTowardPrinted/,
      // (8) the Mark's train removed from the game
      /\(8\) UR-3 \(OD-UR-13\)/,
      /permanently removed from the game \(`removed_trains`, never the Bank Pool\)/,
      /phase progression is monotonic/,
      // the boundary itself
      /None of the eight asks the pin's\s+value/,
      /A version-9 log/,
      /refused, never reinterpreted/,
    ]) {
      expect(`row10 matches ${String(phrase)}: ${phrase.test(note)}`).toBe(`row10 matches ${String(phrase)}: true`);
    }
    // Exactly eight numbered entries, in order: no (9).
    expect(note.match(/\(\d+\) UR-\d/g)).toEqual(["(1) UR-3", "(2) UR-3", "(3) UR-3", "(4) UR-3", "(5) UR-3", "(6) UR-4", "(7) UR-7", "(8) UR-3"]);
  });

  it("the row keeps the award, statistics, UI / copy, evidence, undo and seed source behind an explicit NOT RULES marker, after all eight", () => {
    const note = row10();
    const semantics = note.indexOf("REPLAY SEMANTICS");
    const lastSemantic = note.indexOf("(8) UR-3");
    const notRules = note.indexOf("NOT RULES");
    expect(semantics).toBeGreaterThanOrEqual(0);
    expect(lastSemantic).toBeGreaterThan(semantics);
    expect(notRules).toBeGreaterThan(lastSemantic);
    for (const nonRule of [
      "OD-UR-4",
      "UR-5's",
      "statistics basis",
      "OD-UR-6",
      "derived history only",
      "UR-6's UI, copy, Rules",
      "OD-UR-8",
      "OD-UR-12",
      "tie sentence",
      "UR-N62",
      "constructed certification game",
      "OD-UR-11",
      "OD-UR-9",
    ]) {
      const at = note.indexOf(nonRule);
      expect([nonRule, at > notRules]).toEqual([nonRule, true]);
    }
    expect(note).toMatch(/None of them moves a board, a message or a digest/);
    // The Firestore-era residual is named as the one place the legacy request path survives -- not decided here.
    expect(note).toMatch(/Unpinned \(Firestore-era\) boards keep the legacy Yellow Sign\s+request path \(S10-11\)/);
    // Unrelated deferred items are not swept into the version: no U-41, U-43, S10-21 or S10-27 in the row.
    for (const unrelated of ["U-41", "U-43", "S10-21", "S10-27", "Delayed Auction"]) {
      expect([unrelated, note.includes(unrelated)]).toEqual([unrelated, false]);
    }
  });
});

/* ================================================================================================= */
/* 2. THE SUPPORTED-VERSION MATRIX                                                                    */
/* ================================================================================================= */

describe("the supported-version matrix under a v10-only server", () => {
  it("1. a newly dealt game records rules_engine_version 10 -- on the log and on the board, whatever the client claimed", () => {
    for (const claimed of [undefined, 1, 8, PRIOR, 11, 999]) {
      for (const variants of [{}, UR_WITH_GR]) {
        const room = playedRoom(claimed, variants);
        expect(setupPayloadOf(room.entries)[RULES_ENGINE_VERSION_FIELD]).toBe(10);
        expect(room.rulesEngineVersion()).toBe(10);
        expect(room.state.rules_engine_version).toBe(10);
      }
    }
  });

  it("2. a v10-pinned room is supported under SERVER_REPLAY_POLICY: restored, rebuilt to the live board, playable", () => {
    for (const variants of [{}, UR_WITH_GR]) {
      const live = playedRoom(undefined, variants);
      expect(replayCompatibility(live.entries)).toEqual({ kind: "compatible", version: 10 });
      expect(replayRefusal(replayCompatibility(live.entries), SERVER_REPLAY_POLICY)).toBeNull();
      const restored = session(live.entries);
      expect(restored.incompatible).toBeNull();
      expect(stateDigest(restored.state)).toBe(stateDigest(live.state));
      expect(restored.catchUp(-1).kind).toBe("catch-up");
      const headless = replayLog(entriesFromExport(live.entries), sandboxReplayProviders(), seed(), undefined, SERVER_REPLAY_POLICY);
      expect(stateDigest(headless.state)).toBe(stateDigest(live.state));
      expect(headless.state.rules_engine_version).toBe(10);
    }
  });

  it("3. a v9-pinned room is INCOMPATIBLE: held before the reducer sees an entry, under every policy", () => {
    const nine = repinned(playedRoom().entries, PRIOR);
    expect(replayCompatibility(nine)).toEqual({ kind: "incompatible", version: 9, supported: [10] });
    const apply = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      for (const dev of [false, true]) {
        const counting = countingProviders();
        const held = session(nine, { providers: counting.providers, dev });
        expect(held.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 9, supported: [10] });
        expect(held.incompatible?.reason).toMatch(/rules engine version 9; this server supports version 10\b/);
        expect(counting.count()).toBe(0);
      }
      expect(apply).not.toHaveBeenCalled();
    } finally {
      apply.mockRestore();
    }
    for (const policy of [SERVER_REPLAY_POLICY, DEVELOPMENT_CORPUS_POLICY]) {
      expect(() => replayLog(entriesFromExport(nine), sandboxReplayProviders(), seed(), undefined, policy)).toThrow(
        ReplayIncompatibleError,
      );
    }
  });

  it("3b. a v9-pinned UNPREDICTABLE REVENUE room (with Gentle Rust) is held the same way -- its v9 history is not reinterpreted", () => {
    /* The boundary this closure exists for: an Unpredictable Revenue game dealt under 9 may have been played before
       UR-3 (a client-sent Sign, a Mark on a Final Run train, a gift that turned the phase), before UR-4 (a model-level
       Blood Price that moved the seller) or before UR-7 (a +10% tie paid half up), so a v10 server must not continue it.
       Nothing about the variant changes the admission question -- the pin decides, before any Yellow Sign, Carcosa,
       Blood Price or rounding rule could be asked. */
    const live = playedRoom(undefined, UR_WITH_GR);
    expect(setupPayloadOf(live.entries).variants).toEqual(UR_WITH_GR);
    expect(live.state.variants?.unpredictableRevenue).toBe(true);
    expect(live.state.variants?.gentleRust).toBe(true);
    const nine = repinned(live.entries, PRIOR);
    const apply = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      for (const dev of [false, true]) {
        const counting = countingProviders();
        const held = session(nine, { providers: counting.providers, dev });
        expect(held.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 9, supported: [10] });
        expect(stateDigest(held.state)).toBe(stateDigest(session().state));
        expect(counting.count()).toBe(0);
      }
      expect(apply).not.toHaveBeenCalled();
    } finally {
      apply.mockRestore();
    }
    // The same deal, pinned 10 by this server, is admitted and rebuilds to the live board.
    const restored = session(live.entries);
    expect(restored.incompatible).toBeNull();
    expect(stateDigest(restored.state)).toBe(stateDigest(live.state));
  });

  it("4. any other unsupported numeric version is incompatible too -- 8 (GR-5's prior) and the one-ahead 11 included", () => {
    const base = playedRoom().entries;
    for (const version of [0, 1, 6, 7, 8, 11, 999]) {
      const pinned = repinned(base, version);
      expect(replayCompatibility(pinned)).toEqual({ kind: "incompatible", version, supported: [10] });
      for (const dev of [false, true]) expect(session(pinned, { dev }).incompatible?.compatibility.kind).toBe("incompatible");
    }
  });

  it("5. a missing version is incompatible under the server / deployment policy -- never read as 10", () => {
    const legacy = repinned(playedRoom(undefined, UR_WITH_GR).entries, undefined);
    expect(rulesEngineVersionOf(legacy)).toBeNull();
    expect(replayCompatibility(legacy)).toEqual({ kind: "legacy" });
    const held = session(legacy);
    expect(held.incompatible?.compatibility).toEqual({ kind: "legacy" });
    expect(held.incompatible?.reason).toMatch(/before rules-engine versioning/);
    expect(() => replayLog(entriesFromExport(legacy), sandboxReplayProviders(), seed())).toThrow(ReplayIncompatibleError);
  });

  it("6. a missing version is admitted ONLY by the explicit DEVELOPMENT_CORPUS_POLICY, and stays unpinned there", () => {
    const legacy = repinned(playedRoom(undefined, UR_WITH_GR).entries, undefined);
    const admitted = session(legacy, { dev: true });
    expect(admitted.incompatible).toBeNull();
    expect(admitted.replayCompatibility()).toEqual({ kind: "legacy" });
    expect(admitted.state.rules_engine_version ?? null).toBeNull();
    const headless = replayLog(entriesFromExport(legacy), sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(headless.state.rules_engine_version ?? null).toBeNull();
    // And the server's own policy object never carries the opt-in.
    expect(SERVER_REPLAY_POLICY.legacyLogs).toBe("refuse");
  });

  it("7. no compatibility path rewrites a stored 9 (or a missing pin) to 10", () => {
    const base = playedRoom(undefined, UR_WITH_GR).entries;
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

  it("8. a refused v9 room appends nothing -- a move, a new deal, a RevertTo", () => {
    const nine = repinned(playedRoom(undefined, UR_WITH_GR).entries, PRIOR);
    const held = session(nine);
    const before = JSON.stringify(held.entries);
    const first = setupPayloadOf(nine).players as Array<{ id: string }>;
    const attempts = [
      held.submit({ actor: first[0].id, build: BUILD, msg: BUY_LOWEST, baseIndex: held.nextIndex - 1 }),
      held.submit({ actor: P1, build: BUILD, msg: SETUP(undefined, UR_WITH_GR), baseIndex: held.nextIndex - 1 }),
      held.submit({ actor: P1, build: BUILD, msg: { RevertTo: { index: 0, player: P1, summary: "x" } } as never, baseIndex: held.nextIndex - 1 }),
    ];
    for (const attempt of attempts) expect(attempt.kind).toBe("incompatible");
    expect(JSON.stringify(held.entries)).toBe(before);
    expect(held.nextIndex).toBe(nine.length);
    expect(held.rulesEngineVersion()).toBe(9);
  });

  it("9. catch-up for an incompatible room exposes no history for the server to interpret", () => {
    for (const stored of [repinned(playedRoom().entries, PRIOR), repinned(playedRoom().entries, undefined)]) {
      const held = session(stored);
      const hello = held.catchUp(-1);
      expect(hello.kind).toBe("incompatible");
      expect(Object.keys(hello).sort()).toEqual(["build", "kind", "pinnedRulesEngineVersion", "reason", "supportedRulesEngineVersions"]);
      if (hello.kind !== "incompatible") return;
      expect(hello.pinnedRulesEngineVersion).toBe(rulesEngineVersionOf(stored) ?? null);
      expect(hello.supportedRulesEngineVersions).toEqual([10]);
      // The engine is at its seed: nothing was interpreted.
      expect(stateDigest(held.state)).toBe(stateDigest(session().state));
    }
  });

  it("10. build compatibility stays a separate concept from rules-engine-version compatibility", () => {
    const live = playedRoom();
    // A different BUILD with the same v10 pin: rebuilt; the deal-build pin (#1252) then answers moves -- never `incompatible`.
    const otherBuild = session(live.entries, { build: "another-deploy" });
    expect(otherBuild.incompatible).toBeNull();
    expect(stateDigest(otherBuild.state)).toBe(stateDigest(live.state));
    const first = live.state.player_addresses[1] ?? live.state.player_addresses[0];
    const move = otherBuild.submit({ actor: first, build: "another-deploy", msg: BUY_LOWEST, baseIndex: otherBuild.nextIndex - 1 });
    expect(move.kind).not.toBe("incompatible");
    // The SAME build with a v9 pin: held regardless of the build.
    const sameBuild = session(repinned(live.entries, PRIOR), { build: BUILD });
    expect(sameBuild.incompatible?.compatibility.kind).toBe("incompatible");
    expect(setupPayloadOf(sameBuild.entries).build).toBe(BUILD);
  });
});

/* ================================================================================================= */
/* 3. THE EIGHT SEMANTICS ARE THE CURRENT ENGINE'S, UNCONDITIONALLY                                   */
/* ================================================================================================= */

describe("v10's semantics are carried by the one reducer, not by a version branch", () => {
  it("no authority behind (1)-(8) compares the pin's value, and none names the current version", () => {
    /* One supported version, one reducer (#1520): the eight corrections are simply what this engine does. The pinned /
       unpinned seam UR-3 uses for the Sign's request path (`automaticYellowSignInForce`, `yellowSignRequestRefusal`) asks
       whether a pin EXISTS -- #1698's "presence, not a version number" rule for the 10.6 lay seam -- so a v10 board is
       judged because it is pinned, and a v9 board never reaches it on a v10 server because `replayRefusal` holds the
       room first. Were a future edit to fence a rule behind `rules_engine_version >= 10`, it would fail here. */
    const COMPARED = /rules_engine_version\s*(?:>=|<=|>|<|[!=]==?\s*\d)/;
    for (const file of [
      "gameEngine/yellowSign.ts", // (1) the run-bound Sign; (2) the Mark's candidates; (3) `fogAtSetEnd`
      "gameEngine/sandboxSession.ts", // the run arm, the settlement, the boundary, the Blood Price, `removed_trains`
      "gameEngine/turnAuthority.ts", // (1) the request refused at ingress
      "utils/serverIngress.ts", // (1) the server's draw; the playtest waiver dropped at ingress
      "gameEngine/gamePhase.ts", // (4) `derivePhase`; (6) the pool provenance; (8) the removed train
      "gameEngine/dieselExchange.ts", // (5) the gilded trade-in
      "gameEngine/trainSaleAuthority.ts", // (6) the copy named
      "gameEngine/gameVariants.ts", // (7) `roundRevenueTowardPrinted`
    ]) {
      const source = readStripped(file);
      expect([file, COMPARED.test(source)]).toEqual([file, false]);
      expect([file, /RULES_ENGINE_VERSION/.test(source)]).toEqual([file, false]);
    }
  });

  it("the constructed certification game (UR-7) is dealt at the certified engine, Unpredictable Revenue with Gentle Rust", () => {
    // UR-7's game (`unpredictableRevenueCertificationGame.test.ts`) owns the behaviour; this pins only the version it now runs at.
    const start = certificationStart();
    expect(start.rules_engine_version).toBe(RULES_ENGINE_VERSION);
    expect(start.rules_engine_version).toBe(10);
    expect(start.variants?.unpredictableRevenue).toBe(true);
    expect(start.variants?.gentleRust).toBe(true);
    // G0, the standard control, is the same deal with the variant off -- and the same engine.
    const control = certificationStart({ unpredictableRevenue: false });
    expect(control.rules_engine_version).toBe(10);
    expect(control.variants?.unpredictableRevenue).toBe(false);
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

describe("the canonical development corpus under v10", () => {
  const files = corpus();
  if (files.length === 0) {
    it("skipped: the development corpus is not present in this checkout", () => expect(files).toEqual([]));
    return;
  }

  it("every file is UNPINNED history: refused by the server's policy, admitted only by the corpus's", () => {
    expect(files).toHaveLength(18);
    for (const { name, entries } of files) {
      const list = entriesFromExport(entries);
      expect([name, rulesEngineVersionOf(list)]).toEqual([name, null]);
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
    // The Stage-10 / GR-4 / UR-7 accepted totals, unchanged by the bump (measured old-vs-new entry by entry in the closure record).
    expect({ stored, applied, dropped }).toEqual({ stored: 4105, applied: 3731, dropped: 374 });
  });
});
