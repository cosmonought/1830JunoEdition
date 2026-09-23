/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1698: STAGE 10's ONE DELIBERATE BUMP, 7 -> 8
// ==================================================================
//
// THE SAME SHAPE AS 7.5, 8.5 AND STAGE 9. Stage 10's six slices each left the pin at 7 -- an implementation slice
// stays on the version it was written against, so the corpus can be measured slice by slice against one baseline --
// and the stage takes ONE bump at closure, where the whole set of semantic changes is named in a single changelog row.
//
// WHY THE BUMP IS OWED EVEN THOUGH THE CORPUS IS QUIET. Every Stage-10 slice measured the canonical 18-file corpus
// neutral, and the corpus is unpinned development history in any case. But a pin states what a log MEANS, and a
// version-7 log can carry lays judged after they had moved the board, lays neither connected nor claim-checked,
// player-owned private hexes built on, and a server that never charged the Blood Price. It is refused, never
// reinterpreted.
//
// WHAT THIS FILE DOES NOT DO: re-prove Stage 10's rules -- each slice owns its suite. It proves the version boundary
// (the supported-version matrix), that version 8 carries all of Stage 10.6's pinned authority, that the 10.6 seam is
// the PRESENCE of a pin and not a comparison with 8, and that the development corpus stays unreinterpreted.

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

import { RoomSession } from "./roomSession";
import type { ServerLogEntry } from "./roomSession";
import { RoomEngine, replayLog, entriesFromExport } from "../gameEngine/replayLog";
import type { ExportedEntry, ReplayProviders } from "../gameEngine/replayLog";
import { boardLayRefused, sandboxReplayProviders } from "../gameEngine/replayProviders";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxGameState,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
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
  stage106LayAuthorityInForce,
} from "../gameEngine/rulesVersion";
import { STATIC_BOARD_HEXES, terrainBuildFeeAt } from "../components/hexBoardData";
import { applySandboxAction, applySandboxLayTile } from "../gameEngine/sandboxSession";
import { layTileRefusal } from "../gameEngine/layTileAuthority";
import { layAuthorityContext, sandboxActionContext } from "../gameEngine/actionContext";
import { layNetworkFor } from "../gameEngine/layConnectivity";
import { privateHexRefusal, privateLocationLabels } from "../gameEngine/privateReservations";
import { withLevelPlayingFieldEntities, JK_PRIVATE_ID } from "../gameEngine/levelPlayingField";
import { CSL_ABILITY_KEY } from "../gameEngine/bonusLay";
import { CSL_PRIVATE_ID, DH_PRIVATE_ID } from "../gameEngine/dhPower";
import { withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { boardHomeHexToAxial } from "../gameEngine/homeStationAuthority";
import { readStripped } from "./sourceScan";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";

const BUILD = "b";
const P1 = "p-alice";
const P2 = "p-bob";

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

const SETUP = (claimed?: number) =>
  ({
    SetupGame: {
      players: [{ id: P1, nickname: "A" }, { id: P2, nickname: "B" }],
      variants: {},
      build: BUILD,
      ...(claimed === undefined ? {} : { [RULES_ENGINE_VERSION_FIELD]: claimed }),
    },
  }) as never;
const BUY_LOWEST = { WaterfallBuyLowest: { game_id: 0 } } as never;

/** A room dealt by this server and played one move. */
function playedRoom(claimed?: number) {
  const room = session();
  expect(room.submit({ actor: P1, build: BUILD, msg: SETUP(claimed), baseIndex: -1 }).kind).toBe("applied");
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

describe("RULES_ENGINE_VERSION 8 (Stage 10 closure)", () => {
  it("is 8, and 8 is the one supported version", () => {
    expect(RULES_ENGINE_VERSION).toBe(8);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([8]);
    // Derived, as every bump since version 1 has left it -- the bump REPLACES the supported version.
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([RULES_ENGINE_VERSION]);
  });

  it("the changelog has an eighth row and it names every semantic half of Stage 10", () => {
    expect(RULES_ENGINE_CHANGELOG.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const note = RULES_ENGINE_CHANGELOG[7].note;
    for (const phrase of [
      /Stage 10/,
      /layTileLegalityRefusal/,           // 10.1, S10-26: composed before mutation
      /BEFORE any\s+mutation/,
      /Lay Track timing/,                 // 10.1b
      /station anchoring/,
      /terrain fee/,
      /advances the operating cursor/,
      /author-less duplicate corporation-train settlement/, // 10.2, S10-20
      /sandboxActionContext/,             // 10.3
      /SERVER charges the Blood Price/,   // 10.3, the server correction
      /transaction with the core/,        // 10.3b
      /canonical whole-VGP string price/, // 10.5
      /"1e2"/,                            // 10.5, the malformed spelling
      /ON PINNED BOARDS/,                 // 10.6's scope
      /stage106LayAuthorityInForce/,
      /connect to the corporation's network/, // S6-5
      /forged bonus/,                     // S6-6
      /either order/,                     // #1697
      /player-owned private's hex is barred/, // S6-7
      /K9 \/ K11/,                        // LPF JK
      /D&H's F16/,                        // #1694a
      /forfeits the D&H's special effect/,
      /refused, never reinterpreted/,     // the boundary itself
    ]) {
      expect(`row8 matches ${String(phrase)}: ${phrase.test(note)}`).toBe(`row8 matches ${String(phrase)}: true`);
    }
  });

  it("the row keeps transport and tooling apart from rules semantics", () => {
    /* The row's semantic clauses come first; transport (10.2's outcome criterion) and tooling (10.4, 10.5's type)
       are named AFTER an explicit marker, so the export-id and smoke-harness work cannot be read as a rules change. */
    const note = RULES_ENGINE_CHANGELOG[7].note;
    const semantics = note.indexOf("REPLAY SEMANTICS");
    const tooling = note.indexOf("TRANSPORT AND TOOLING, NOT RULES");
    expect(semantics).toBeGreaterThanOrEqual(0);
    expect(tooling).toBeGreaterThan(semantics);
    for (const toolingOnly of ["S10-23", "collision-safe", "smoke harness", "SandboxLogMsg", "nonce may be retried"]) {
      const at = note.indexOf(toolingOnly);
      expect([toolingOnly, at > tooling]).toEqual([toolingOnly, true]);
    }
  });
});

/* ================================================================================================= */
/* 2. THE SUPPORTED-VERSION MATRIX                                                                    */
/* ================================================================================================= */

describe("the supported-version matrix under a v8-only server", () => {
  it("1. a newly dealt game records rules_engine_version 8 -- on the log and on the board, whatever the client claimed", () => {
    for (const claimed of [undefined, 1, 7, 9, 999]) {
      const room = playedRoom(claimed);
      expect(setupPayloadOf(room.entries)[RULES_ENGINE_VERSION_FIELD]).toBe(8);
      expect(room.rulesEngineVersion()).toBe(8);
      expect(room.state.rules_engine_version).toBe(8);
    }
  });

  it("2. a v8-pinned room is supported under SERVER_REPLAY_POLICY: restored, rebuilt to the live board, playable", () => {
    const live = playedRoom();
    expect(replayCompatibility(live.entries)).toEqual({ kind: "compatible", version: 8 });
    expect(replayRefusal(replayCompatibility(live.entries), SERVER_REPLAY_POLICY)).toBeNull();
    const restored = session(live.entries);
    expect(restored.incompatible).toBeNull();
    expect(stateDigest(restored.state)).toBe(stateDigest(live.state));
    expect(restored.catchUp(-1).kind).toBe("catch-up");
    const headless = replayLog(entriesFromExport(live.entries), sandboxReplayProviders(), seed(), undefined, SERVER_REPLAY_POLICY);
    expect(stateDigest(headless.state)).toBe(stateDigest(live.state));
    expect(headless.state.rules_engine_version).toBe(8);
  });

  it("3. a v7-pinned room is INCOMPATIBLE: held before the reducer sees an entry, under every policy", () => {
    const seven = repinned(playedRoom().entries, 7);
    expect(replayCompatibility(seven)).toEqual({ kind: "incompatible", version: 7, supported: [8] });
    const apply = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      for (const dev of [false, true]) {
        const counting = countingProviders();
        const held = session(seven, { providers: counting.providers, dev });
        expect(held.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 7, supported: [8] });
        expect(held.incompatible?.reason).toMatch(/rules engine version 7; this server supports version 8\b/);
        expect(counting.count()).toBe(0);
      }
      expect(apply).not.toHaveBeenCalled();
    } finally {
      apply.mockRestore();
    }
    for (const policy of [SERVER_REPLAY_POLICY, DEVELOPMENT_CORPUS_POLICY]) {
      expect(() => replayLog(entriesFromExport(seven), sandboxReplayProviders(), seed(), undefined, policy)).toThrow(
        ReplayIncompatibleError,
      );
    }
  });

  it("4. any other unsupported numeric version is incompatible too", () => {
    const base = playedRoom().entries;
    for (const version of [0, 1, 6, 9, 999]) {
      const pinned = repinned(base, version);
      expect(replayCompatibility(pinned)).toEqual({ kind: "incompatible", version, supported: [8] });
      for (const dev of [false, true]) expect(session(pinned, { dev }).incompatible?.compatibility.kind).toBe("incompatible");
    }
  });

  it("5. a missing version is incompatible under the server / deployment policy -- never read as 8", () => {
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
    // Admitted AS LEGACY: the board carries no pin, so the pinned-only authority (#1684, #1696) is not asked of it.
    expect(admitted.state.rules_engine_version ?? null).toBeNull();
    expect(stage106LayAuthorityInForce(admitted.state)).toBe(false);
    const headless = replayLog(entriesFromExport(legacy), sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(headless.state.rules_engine_version ?? null).toBeNull();
    // And the server's own policy object never carries the opt-in.
    expect(SERVER_REPLAY_POLICY.legacyLogs).toBe("refuse");
  });

  it("7. no compatibility path rewrites a stored 7 (or a missing pin) to 8", () => {
    const base = playedRoom().entries;
    for (const stored of [repinned(base, 7), repinned(base, undefined)]) {
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

  it("8. a refused incompatible room appends nothing -- a move, a new deal, a RevertTo", () => {
    const seven = repinned(playedRoom().entries, 7);
    const held = session(seven);
    const before = JSON.stringify(held.entries);
    const first = setupPayloadOf(seven).players as Array<{ id: string }>;
    const attempts = [
      held.submit({ actor: first[0].id, build: BUILD, msg: BUY_LOWEST, baseIndex: held.nextIndex - 1 }),
      held.submit({ actor: P1, build: BUILD, msg: SETUP(), baseIndex: held.nextIndex - 1 }),
      held.submit({ actor: P1, build: BUILD, msg: { RevertTo: { index: 0, player: P1, summary: "x" } } as never, baseIndex: held.nextIndex - 1 }),
    ];
    for (const attempt of attempts) expect(attempt.kind).toBe("incompatible");
    expect(JSON.stringify(held.entries)).toBe(before);
    expect(held.nextIndex).toBe(seven.length);
    expect(held.rulesEngineVersion()).toBe(7);
  });

  it("9. catch-up for an incompatible room exposes no history for the server to interpret", () => {
    for (const stored of [repinned(playedRoom().entries, 7), repinned(playedRoom().entries, undefined)]) {
      const held = session(stored);
      const hello = held.catchUp(-1);
      expect(hello.kind).toBe("incompatible");
      expect(Object.keys(hello).sort()).toEqual(["build", "kind", "pinnedRulesEngineVersion", "reason", "supportedRulesEngineVersions"]);
      if (hello.kind !== "incompatible") return;
      expect(hello.pinnedRulesEngineVersion).toBe(rulesEngineVersionOf(stored) ?? null);
      expect(hello.supportedRulesEngineVersions).toEqual([8]);
      // The engine is at its seed: nothing was interpreted.
      expect(stateDigest(held.state)).toBe(stateDigest(session().state));
    }
  });

  it("10. build compatibility stays a separate concept from rules-engine-version compatibility", () => {
    const live = playedRoom();
    // A different BUILD with the same v8 pin: rebuilt (the log means the same thing); the deal-build pin (#1252)
    // then answers moves -- a refusal, never `incompatible`.
    const otherBuild = session(live.entries, { build: "another-deploy" });
    expect(otherBuild.incompatible).toBeNull();
    expect(stateDigest(otherBuild.state)).toBe(stateDigest(live.state));
    const first = live.state.player_addresses[1] ?? live.state.player_addresses[0];
    const move = otherBuild.submit({ actor: first, build: "another-deploy", msg: BUY_LOWEST, baseIndex: otherBuild.nextIndex - 1 });
    expect(move.kind).not.toBe("incompatible");
    // The SAME build with a v7 pin: held regardless of the build.
    const sameBuild = session(repinned(live.entries, 7), { build: BUILD });
    expect(sameBuild.incompatible?.compatibility.kind).toBe("incompatible");
    expect(setupPayloadOf(sameBuild.entries).build).toBe(BUILD);
  });
});

/* ================================================================================================= */
/* 3. VERSION 8 CARRIES ALL OF STAGE 10.6's PINNED AUTHORITY -- AND THE SEAM IS A PIN'S PRESENCE       */
/* ================================================================================================= */

const PRR = 1;
const NYC = 3;
const LPF = resolveVariants({ levelPlayingField: true });
const STANDARD = resolveVariants({});
const providers = sandboxReplayProviders();
const GRID: MapGridResponse = providers.initialGrid;

function homeOf(companyId: number, rules: typeof LPF): [number, number] {
  const label = sandboxGameState("OperatingRound", 1).public_companies.find((c) => c.company_id === companyId)?.home_hex_label;
  const axial = withRules(rules, () => (label ? boardHomeHexToAxial(label) : null));
  if (!axial) throw new Error(`company ${companyId} has no home hex`);
  return [axial[0], axial[1]];
}

/** An Operating-Round board with PRR at Lay Track, pinned to `pin` (undefined = legacy). Stage 10.6's fixture. */
function board(pin: number | undefined, opts: { rules?: typeof LPF; tokens?: Array<[number, number]> } = {}): GameStateResponse {
  const rules = opts.rules ?? LPF;
  const raw = { ...sandboxGameState("OperatingRound", 1), variants: rules };
  const base = rules.levelPlayingField ? withLevelPlayingFieldEntities(raw) : raw;
  const tokens = opts.tokens ?? [homeOf(PRR, rules)];
  return {
    ...base,
    rules_engine_version: pin,
    current_round_type: "OperatingRound",
    current_global_era: "Yellow",
    player_addresses: [P1, P2],
    active_operating_order: [PRR],
    active_corporation_index: 0,
    macro_round_number: 2,
    sub_round_index: 1,
    operating_sub_phase: "Track",
    public_companies: base.public_companies.map((company) => ({
      ...company,
      president: company.company_id === PRR ? P1 : null,
      is_floated: company.company_id === PRR,
      treasury: company.company_id === PRR ? "1000" : "0",
      par_value: company.company_id === PRR ? "100" : null,
      player_holdings: company.company_id === PRR ? [{ player: P1, percentage: 60 }] : [],
      ipo_pool_percentage: company.company_id === PRR ? 40 : 100,
      bank_pool_percentage: 0,
      owned_trains: company.company_id === PRR ? ["2"] : [],
      station_token_hexes: company.company_id === PRR ? tokens : [],
      station_tokens: company.company_id === PRR ? tokens.map(([q, r]) => [q, r, 0] as [number, number, number]) : [],
      kanawha_licenses: undefined,
    })),
    private_companies: base.private_companies.map((entry) => ({ ...entry, owner: null, owner_protocol_id: null, closed: false })),
    used_private_abilities: [],
    terrain_fees_paid: [],
  } as GameStateResponse;
}

type Owner = { player: string } | { corp: number };
const withPrivate = (state: GameStateResponse, privateId: number, who: Owner): GameStateResponse => ({
  ...state,
  private_companies: state.private_companies.map((entry) =>
    entry.private_id !== privateId
      ? entry
      : "player" in who
        ? { ...entry, owner: who.player, owner_protocol_id: null, closed: false }
        : { ...entry, owner: null, owner_protocol_id: who.corp, closed: false },
  ),
});

const hexByLabel = (label: string, rules = LPF) => {
  const hex = withRules(rules, () => STATIC_BOARD_HEXES.find((entry) => entry.label === label));
  if (!hex) throw new Error(`no ${label}`);
  return { q: hex.q, r: hex.r };
};
const lay = (at: { q: number; r: number }, tile: number, orientation: number, extra: Record<string, unknown> = {}) =>
  ({ LayTile: { game_id: 1, protocol_id: PRR, q: at.q, r: at.r, tile_id: tile, orientation, ...extra } }) as unknown as GameplayExecuteMsg;
const body = (msg: GameplayExecuteMsg) => (msg as unknown as { LayTile: { q: number; r: number; tile_id: number; orientation: number } }).LayTile;

/** Every atom, asked the way its caller asks (verdict, grid step, reducer). */
function atoms(state: GameStateResponse, msg: GameplayExecuteMsg, grid: MapGridResponse = GRID) {
  return withRules(resolveVariants(state.variants), () => {
    const verdict = layTileRefusal(state, msg, layAuthorityContext(providers, state, grid));
    const l = body(msg);
    const nextGrid = applySandboxLayTile(grid, l.q, l.r, l.tile_id, l.orientation, () => verdict !== null);
    const after = applySandboxAction(state, msg, sandboxActionContext(providers, { state, msg, actor: P1, grid: nextGrid, gridBefore: grid }));
    return { verdict, after, grid: nextGrid };
  });
}
function expectNothingMoved(state: GameStateResponse, result: ReturnType<typeof atoms>, grid: MapGridResponse = GRID) {
  expect(result.verdict).not.toBeNull();
  expect(result.grid).toBe(grid);
  expect(stateDigest(result.after)).toBe(stateDigest(state));
  expect(result.after.operating_sub_phase).toBe(state.operating_sub_phase);
}

const YELLOW = [7, 8, 9, 57, 58, 55, 56, 69, 1, 2, 3, 4];
const PRIVATE_LABELS = new Set(["G15", "B20", "F16", "D18", "H18", "I13", "I15", "K9", "K11"]);
function findLay(state: GameStateResponse, connected: boolean): GameplayExecuteMsg {
  return withRules(resolveVariants(state.variants), () => {
    const network = layNetworkFor(state, GRID, PRR);
    if (!network) throw new Error("PRR has no network");
    for (const hex of STATIC_BOARD_HEXES) {
      if (PRIVATE_LABELS.has(hex.label) || terrainBuildFeeAt(hex.q, hex.r) > 0) continue;
      for (const tile of YELLOW) {
        for (let o = 0; o < 6; o += 1) {
          if (boardLayRefused(GRID, hex.q, hex.r, tile, o, "Yellow")) continue;
          const joins = !boardLayRefused(GRID, hex.q, hex.r, tile, o, "Yellow", network);
          if (joins === connected) return lay({ q: hex.q, r: hex.r }, tile, o);
        }
      }
    }
    throw new Error(`no ${connected ? "connected" : "disconnected"} lay found`);
  });
}
function geometricTile(state: GameStateResponse, at: { q: number; r: number }): { tile: number; o: number } {
  return withRules(resolveVariants(state.variants), () => {
    for (const tile of YELLOW) for (let o = 0; o < 6; o += 1) if (!boardLayRefused(GRID, at.q, at.r, tile, o, "Yellow")) return { tile, o };
    throw new Error("no geometric tile");
  });
}

describe("a board pinned to version 8 receives every Stage-10.6 rule", () => {
  const V8 = 8;
  it("the fixture really is a v8 board", () => {
    expect(board(V8).rules_engine_version).toBe(RULES_ENGINE_VERSION);
    expect(stage106LayAuthorityInForce(board(V8))).toBe(true);
  });

  it("S6-5: a disconnected crafted LayTile is refused, and nothing moves", () => {
    const state = board(V8);
    const result = atoms(state, findLay(state, false));
    expect(result.verdict).toMatch(/does not connect to PRR's network/);
    expectNothingMoved(state, result);
  });

  it("S6-5 at the live ingress of a v8 room: refused, and `RoomSession.submit` appends nothing", () => {
    const state = board(V8);
    let n = 0;
    const room = new RoomSession({ providers, seed: { state, waterfall: null }, build: BUILD, mintId: () => `id${(n += 1)}` });
    const digest = stateDigest(room.state);
    expect(room.submit({ actor: P1, build: BUILD, msg: findLay(state, false), baseIndex: -1, host: null }).kind).toBe("refused");
    expect(room.entries).toHaveLength(0);
    expect(stateDigest(room.state)).toBe(digest);
    expect(room.submit({ actor: P1, build: BUILD, msg: findLay(state, true), baseIndex: -1, host: null }).kind).toBe("applied");
  });

  it("S6-6: a forged C&SL bonus is refused (PRR does not own the C&SL)", () => {
    const state = board(V8);
    const b20 = hexByLabel("B20");
    const { tile, o } = geometricTile(state, b20);
    const result = atoms(state, lay(b20, tile, o, { bonus_lay: true, ability_key: CSL_ABILITY_KEY }));
    expect(result.verdict).toMatch(/does not own the Champlain & St. Lawrence/);
    expectNothingMoved(state, result);
  });

  it("S6-6 / #1697: the valid C&SL two-lay entitlement still works (ordinary, then the bonus)", () => {
    const state = withPrivate(board(V8), CSL_PRIVATE_ID, { corp: PRR });
    const ordinary = atoms(state, findLay(state, true));
    expect(ordinary.verdict).toBeNull();
    expect(ordinary.after.operating_sub_phase).toBe("Track");
    expect(ordinary.after.ordinary_lay_taken).toBe(PRR);
    const b20 = hexByLabel("B20");
    const { tile, o } = geometricTile(state, b20);
    const bonus = atoms(ordinary.after, lay(b20, tile, o, { bonus_lay: true, ability_key: CSL_ABILITY_KEY }), ordinary.grid);
    expect(bonus.verdict).toBeNull();
    expect(bonus.after.operating_sub_phase).toBe("Tokens");
    expect(bonus.after.used_private_abilities).toContain(CSL_ABILITY_KEY);
  });

  it("S6-7: a player-owned private's restricted hex is refused (the C&A's H18)", () => {
    const state = withPrivate(board(V8), 5, { player: P2 });
    const h18 = hexByLabel("H18");
    const result = atoms(state, lay(h18, 7, 0));
    expect(result.verdict).toContain("a player owns it");
    expectNothingMoved(state, result);
  });

  it("#1694a: a valid ordinary CONNECTED foreign lay on the D&H's F16 is accepted, the D&H being player-owned", () => {
    const f16 = hexByLabel("F16");
    const state = withPrivate(board(V8, { tokens: [homeOf(PRR, LPF), [f16.q, f16.r]] }), DH_PRIVATE_ID, { player: P2 });
    const { tile, o } = geometricTile(state, f16);
    const result = atoms(state, lay(f16, tile, o));
    expect(result.verdict).toBeNull();
    expect(result.grid).not.toBe(GRID);
    expect(result.after.used_private_abilities).not.toContain("dh-tile");
  });

  it("#1694: the JK's K9 / K11 are restricted under the Level Playing Field, and only there", () => {
    const lpf = withPrivate(board(V8), JK_PRIVATE_ID, { player: P2 });
    for (const label of ["K9", "K11"]) {
      const at = hexByLabel(label, LPF);
      expect(withRules(LPF, () => privateHexRefusal(lpf, at.q, at.r))).toContain(label);
      expectNothingMoved(lpf, atoms(lpf, lay(at, 7, 0)));
    }
    // Outside the Level Playing Field the JK has no location rows at all.
    expect(privateLocationLabels(JK_PRIVATE_ID, STANDARD)).toEqual([]);
    expect(privateLocationLabels(JK_PRIVATE_ID, LPF)).toEqual(["K9", "K11"]);
  });

  it("the other private rows are corporation-ownership aware on v8 too (NYC-owned C&A restricts nothing)", () => {
    const state = withPrivate(board(V8), 5, { corp: NYC });
    const h18 = hexByLabel("H18");
    expect(withRules(LPF, () => privateHexRefusal(state, h18.q, h18.r))).toBeNull();
  });
});

describe("#1696's seam is the PRESENCE of a numeric pin, not a comparison with 8", () => {
  it("any numeric pin is in force; only an absent pin is legacy", () => {
    for (const pin of [0, 1, 6, 7, 8, 9, 999]) expect([pin, stage106LayAuthorityInForce({ rules_engine_version: pin })]).toEqual([pin, true]);
    for (const absent of [undefined, null]) expect(stage106LayAuthorityInForce({ rules_engine_version: absent })).toBe(false);
    expect(stage106LayAuthorityInForce(null)).toBe(false);
  });

  it("behaviourally: the same disconnected lay is refused at pins 1, 7 and 8, and applied on the unpinned board", () => {
    const far = findLay(board(8), false);
    for (const pin of [1, 7, 8]) expect([pin, atoms(board(pin), far).verdict !== null]).toEqual([pin, true]);
    expect(atoms(board(undefined), far).verdict).toBeNull();
  });

  it("the seam's source asks `typeof ... === \"number\"` and no version comparison, and no authority compares the pin's value", () => {
    const source = readStripped("gameEngine/rulesVersion.ts");
    const fn = source.slice(source.indexOf("export function stage106LayAuthorityInForce"), source.indexOf("export type ReplayCompatibility"));
    expect(fn).toContain('typeof state?.rules_engine_version === "number"');
    expect(fn).not.toMatch(/RULES_ENGINE_VERSION|>=|<=|[^=!]==?\s*\d|[<>]\s*\d/);
    const COMPARED = /rules_engine_version\s*(?:>=|<=|>|<|[!=]==?\s*\d)/;
    for (const file of [
      "gameEngine/layTileAuthority.ts",
      "gameEngine/privateReservations.ts",
      "gameEngine/privateLayClaim.ts",
      "gameEngine/layConnectivity.ts",
      "gameEngine/sandboxSession.ts",
      "gameEngine/turnAuthority.ts",
      "gameEngine/stockTransactionAuthority.ts",
      "gameEngine/auctionAuthority.ts",
      "gameEngine/pendingOfferHold.ts",
      "gameEngine/emergencyFunding.ts",
    ]) {
      expect([file, COMPARED.test(readStripped(file))]).toEqual([file, false]);
    }
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

describe("the canonical development corpus under v8", () => {
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

  it("replayed under the corpus policy, no board acquires a pin -- the constant cannot reach an unpinned entry", () => {
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
    // The Stage-10.6 accepted totals, unchanged by the bump (measured old-vs-new entry by entry in the closure record).
    expect({ stored, applied, dropped }).toEqual({ stored: 4105, applied: 3731, dropped: 374 });
  });
});
