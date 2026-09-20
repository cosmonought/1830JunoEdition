/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1680: STAGE 9's ONE DELIBERATE BUMP, 6 -> 7
// ==================================================================
//
// THE SAME SHAPE AS 7.5 AND 8.5, AND FOR THE SAME REASON. Stage 9's five slices each left the pin alone --
// an implementation slice stays on the version it was written against, so the corpus can be measured slice by
// slice against one baseline -- and the stage takes ONE bump at closure, where the whole set of semantic
// changes can be named in a single changelog row.
//
// WHY THE BUMP IS OWED EVEN WHERE THE CORPUS IS QUIET. The canonical 18-file reconciliation found the board
// changed from index 0 on eleven Level Playing Field logs (the printed M-11 straight) and one permanent
// gameplay divergence (JUNO-3XD 115, where the old engine consumed the D&H's power while refusing the
// action). But most of Stage 9's rules are not exercised by any stored log at all -- no corpus file contains
// a Carcosa gift, a fog, a Blood Price transfer or a sale of the Scenario-D other-20 into a pool. A version
// pin is a statement about what a log MEANS, not a count of which logs happen to notice, and a version-6 log
// carries tile lays judged without the board's printed topology, station placements judged only in the
// shell, Yellow Sign outcomes chosen by a client and market steps walked per ten percent. It is refused,
// never reinterpreted -- which is exactly what the pin exists to say.
//
// WHAT THIS FILE DOES NOT DO: re-prove Stage 9's rules. Each slice owns its own suite. This is the version
// boundary and nothing else.

export {};

type ServerLogEntry = import("./roomSession").ServerLogEntry;

const { replayLog, entriesFromExport } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const {
  DEVELOPMENT_CORPUS_POLICY,
  SERVER_REPLAY_POLICY,
  RULES_ENGINE_CHANGELOG,
  RULES_ENGINE_VERSION,
  RULES_ENGINE_VERSION_FIELD,
  SUPPORTED_RULES_ENGINE_VERSIONS,
  ReplayIncompatibleError,
  replayCompatibility,
  replayRefusal,
} = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");

const P1 = "p1";
const P2 = "p2";

const seed = () => ({
  state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});

const dealtRoom = () => {
  const room = new RoomSession({ providers: sandboxReplayProviders(), seed: seed(), build: "b", mintId: () => "d" });
  const dealt = room.submit({
    actor: P1,
    build: "b",
    msg: { SetupGame: { players: [{ id: P1, nickname: "A" }, { id: P2, nickname: "B" }], variants: {}, build: "b" } } as never,
    baseIndex: -1,
  });
  expect(dealt.kind).toBe("applied");
  return room;
};

const setupPayloadOf = (entries: readonly ServerLogEntry[]) =>
  JSON.parse(entries.find((row) => "SetupGame" in JSON.parse(row.payload))!.payload).SetupGame as Record<string, unknown>;

/** The same deal, re-stamped to a version this engine no longer carries. */
const pinnedTo = (entries: readonly ServerLogEntry[], version: number | undefined): ServerLogEntry[] =>
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

describe("RULES_ENGINE_VERSION 7 (Stage 9 closure)", () => {
  it("is 7, and 7 is the one supported version", () => {
    expect(RULES_ENGINE_VERSION).toBe(7);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([7]);
    expect(Number.isInteger(RULES_ENGINE_VERSION)).toBe(true);
  });

  it("the changelog has a seventh row and it names every semantic half of Stage 9", () => {
    /* THE NUMBER IS MEANINGLESS WITHOUT THE ROW -- `rulesVersion.ts` says so at the constant. Each phrase is
       one Stage-9 slice's rule, so a future edit that drops one from the row fails here rather than leaving
       a version nobody can account for. */
    expect(RULES_ENGINE_CHANGELOG.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const note = RULES_ENGINE_CHANGELOG[6].note;
    for (const phrase of [
      /Stage 9/,
      /immutableHexRefusal/,          // 9.2, S9-10 F-1
      /priorTopologyAt/,              // 9.2, S9-10 F-2
      /stationAnchorAuthority/,       // 9.2, S9-17
      /M-11/,                         // 9.2, S9-18
      /separationPreserved/,          // 9.3, S9-19
      /#63/,                          // 9.3, S9-15
      /canonical rules identity/i,    // 9.3, S9-21
      /ARRIVAL/,                      // 9.4a, S9-11
      /D&H/,                          // 9.4b, S9-12
      /PHYSICAL CERTIFICATE/,         // 9.4c, S9-13
      /DERIVED/,                      // 9.4d, S9-1 outcome
      /ingress/,                      // 9.4d, S9-1 seed authority
      /FIVE PHYSICAL CERTIFICATES/,   // 9.5, S9-8
      /C&SL/,                         // 9.5, S9-6
      /Mark nullifies/,               // 9.5, S9-3
      /Carcosa lifecycle/,            // 9.5, S9-2
      /REAL Diesel/,                  // 9.5, S9-2 trigger
      /SYNTHETIC provenance/,         // 9.5, S9-2 / #1673
      /refused, never reinterpreted/, // the boundary itself
    ]) {
      expect(`row7 matches ${String(phrase)}: ${phrase.test(note)}`).toBe(`row7 matches ${String(phrase)}: true`);
    }
  });
});

/* ================================================================================================= */
/* 2. ADMISSION                                                                                       */
/* ================================================================================================= */

describe("what the bump does to admission", () => {
  it("1. a new game is pinned 7 by the SERVER, on the log and on the board", () => {
    /* #1520's rule, unchanged by the bump: whatever the client wrote is replaced by the engine this process
       carries, so the pin is a fact about the server that dealt and never a claim the client made. */
    const room = dealtRoom();
    expect(setupPayloadOf(room.entries)[RULES_ENGINE_VERSION_FIELD]).toBe(7);
    expect(room.rulesEngineVersion()).toBe(7);
    expect(room.state.rules_engine_version).toBe(7);
  });

  it("2. a client that claims another version is overwritten, not believed", () => {
    for (const claimed of [1, 6, 8, 99]) {
      const room = new RoomSession({ providers: sandboxReplayProviders(), seed: seed(), build: "b", mintId: () => "d" });
      room.submit({
        actor: P1,
        build: "b",
        msg: {
          SetupGame: {
            players: [{ id: P1, nickname: "A" }, { id: P2, nickname: "B" }],
            variants: {},
            build: "b",
            [RULES_ENGINE_VERSION_FIELD]: claimed,
          },
        } as never,
        baseIndex: -1,
      });
      expect(setupPayloadOf(room.entries)[RULES_ENGINE_VERSION_FIELD]).toBe(7);
    }
  });

  it("3. a version-6 log is now INCOMPATIBLE under every policy — the existing rule, not a new one", () => {
    /* THE POLICY IS NOT REDESIGNED BY THE BUMP. `replayCompatibility` answers `incompatible` for any pinned
       version this engine does not carry, and `replayRefusal` refuses it under BOTH policies -- the
       development corpus's opt-in admits the UNPINNED, never the differently pinned (`rulesVersion.ts`'s
       header says so in as many words). Version 6 simply moved from "compatible" to "incompatible" by the
       list changing; nothing about how that is treated moved with it. */
    const six = entriesFromExport(pinnedTo(dealtRoom().entries, 6));
    const verdict = replayCompatibility(six);
    expect(verdict).toEqual({ kind: "incompatible", version: 6, supported: [7] });
    for (const policy of [SERVER_REPLAY_POLICY, DEVELOPMENT_CORPUS_POLICY]) {
      const refusal = replayRefusal(verdict, policy);
      expect(refusal).not.toBeNull();
      expect(refusal).toMatch(/version 6/);
      expect(refusal).toMatch(/supports version 7/);
    }
    expect(() => replayLog(six, sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY)).toThrow(
      ReplayIncompatibleError,
    );
  });

  it("4. an UNPINNED development-corpus log is unaffected by the bump", () => {
    /* The #1520 boundary is about the FIELD's absence, not about which number is current, so the corpus's
       opt-in behaves exactly as it did at 6: refused by the server's policy, admitted by the corpus's. */
    const legacy = entriesFromExport(pinnedTo(dealtRoom().entries, undefined));
    expect(replayCompatibility(legacy)).toEqual({ kind: "legacy" });
    expect(replayRefusal({ kind: "legacy" }, SERVER_REPLAY_POLICY)).not.toBeNull();
    expect(replayRefusal({ kind: "legacy" }, DEVELOPMENT_CORPUS_POLICY)).toBeNull();
    expect(() => replayLog(legacy, sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY)).not.toThrow();
  });

  it("5. a version-7 board replays deterministically, and twice to the same digest", () => {
    const entries = entriesFromExport(dealtRoom().entries);
    const once = replayLog(entries, sandboxReplayProviders(), seed(), undefined, SERVER_REPLAY_POLICY);
    const twice = replayLog(entries, sandboxReplayProviders(), seed(), undefined, SERVER_REPLAY_POLICY);
    expect(stateDigest(once.state)).toBe(stateDigest(twice.state));
    expect(once.state.rules_engine_version).toBe(7);
  });

  it("6. replay never re-runs live ingress: a stored seed is consumed, never redrawn", () => {
    /* S9-1's second half (#1662) put the turn's draw in `RoomSession.submit`, BEFORE the append. A rebuild
       reads the committed payload, so no replay path reaches the normalizer -- proved here by the module
       boundary (the normalizer is the session's, and `replayLog` does not import it) and by the arm reading
       the stored number onto the board. */
    const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
    const REPLAY = readStripped("gameEngine/replayLog.ts");
    expect(REPLAY).not.toContain("normalizeForCommit");
    expect(REPLAY).not.toContain("randomTurnSeed");
    const SESSION = readStripped("utils/roomSession.ts");
    expect(SESSION).toContain("const recorded = normalizeForCommit(input.msg, {");
    const REDUCER = readStripped("gameEngine/sandboxSession.ts");
    expect(REDUCER).toContain("last_run_revenue_seed: msg.RunMultipleRoutes.revenue_seed");
  });
});
