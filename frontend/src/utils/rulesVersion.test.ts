/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1520 (harness): THE PIN, THE BOUNDARY, AND THE PROOF THAT NOTHING RAN
// ==================================================================
//
// Three identities are easy to confuse and this file keeps them apart on purpose:
//
//   the CLIENT BUILD      `CLIENT_BUILD_ID` / `--build`: a deploy of the UI. Answered by `build-skew` (#1206),
//                         which stops two different builds from talking.
//   the DEAL BUILD        `SetupGame.build`: the build a room was dealt on (#1252). Checked in `submit`, after
//                         the room was already rebuilt -- it stops further moves, not reinterpretation.
//   the RULES VERSION     `SetupGame.rules_engine_version`: what the log MEANS. Stamped by the server, read
//                         before the first entry is applied, and the one that decides whether a rebuild may
//                         happen at all.
//
// The cases below prove, in order: a new deal is pinned by the server and not the client; a same-version
// restore and a same-version revert work and keep the pin; an incompatible room is held before a single
// entry reaches `RoomEngine.apply` (spied at the prototype, and counted again at the provider so the two
// proofs are independent), appends nothing, reinterprets nothing and answers every later frame the same
// way; a legacy log is refused by the server's policy and admitted only by the development corpus's; and a
// build difference on its own changes neither the pin nor the board.

export {};

const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { RoomEngine, replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } =
  require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} = require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } =
  require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { validateGameplayMessage } =
  require("../gameEngine/messageSchema") as typeof import("../gameEngine/messageSchema");
const {
  DEVELOPMENT_CORPUS_POLICY,
  RULES_ENGINE_VERSION,
  RULES_ENGINE_VERSION_FIELD,
  ReplayIncompatibleError,
  SERVER_REPLAY_POLICY,
  SUPPORTED_RULES_ENGINE_VERSIONS,
  replayCompatibility,
  replayRefusal,
  rulesEngineVersionOf,
} = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");

type ServerLogEntry = import("./roomSession").ServerLogEntry;
type ReplayProviders = import("../gameEngine/replayLog").ReplayProviders;

const BUILD = "build-under-test";
const ALICE = "p-alice";
const BOB = "p-bob";
/** A version no engine has ever carried. */
const FOREIGN_VERSION = 999;

function seed() {
  return {
    state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
    waterfall: waterfallForRoster(
      sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
      [],
    ),
  };
}

/** The real providers, with a counter on the one injection `RoomEngine.apply` asks for on EVERY entry it
 *  interprets (`chartInjections`, #1197). Independent of the prototype spy below: the spy proves the method
 *  was not entered, the counter proves the reducer was not fed. */
function countingProviders(): { providers: ReplayProviders; count: () => number } {
  const real = sandboxReplayProviders();
  let applied = 0;
  return {
    providers: {
      ...real,
      chartInjections: (state) => {
        applied += 1;
        return real.chartInjections(state);
      },
    },
    count: () => applied,
  };
}

function session(build = BUILD, entries?: readonly ServerLogEntry[], providers = sandboxReplayProviders()) {
  let n = 0;
  const room = new RoomSession({
    providers,
    seed: seed(),
    build,
    mintId: () => `id${(n += 1)}`,
    now: () => 1_000 + n,
  });
  if (entries) room.restore(entries);
  return room;
}

const SETUP = {
  SetupGame: {
    players: [
      { id: ALICE, nickname: "Alice" },
      { id: BOB, nickname: "Bob" },
    ],
    variants: {},
    build: BUILD,
  },
} as never;

const BUY_LOWEST = { WaterfallBuyLowest: { game_id: 0 } } as never;

const submit = (room: ReturnType<typeof session>, over: Partial<Parameters<typeof room.submit>[0]> = {}) =>
  room.submit({ actor: ALICE, build: BUILD, msg: SETUP, baseIndex: room.nextIndex - 1, ...over });

function setupPayloadOf(entries: readonly ServerLogEntry[]): Record<string, unknown> {
  const deal = entries.find((entry) => JSON.parse(entry.payload).SetupGame !== undefined);
  if (!deal) throw new Error("no deal in the log");
  return JSON.parse(deal.payload).SetupGame as Record<string, unknown>;
}

/** A copy of a dealt log with its pin rewritten -- what a store written by a different engine looks like. */
function repinned(entries: readonly ServerLogEntry[], version: number | undefined): ServerLogEntry[] {
  return entries.map((entry) => {
    const parsed = JSON.parse(entry.payload) as { SetupGame?: Record<string, unknown> };
    if (!parsed.SetupGame) return { ...entry };
    const setup = { ...parsed.SetupGame };
    if (version === undefined) delete setup[RULES_ENGINE_VERSION_FIELD];
    else setup[RULES_ENGINE_VERSION_FIELD] = version;
    return { ...entry, payload: JSON.stringify({ ...parsed, SetupGame: setup }) };
  });
}

/** A played room: the deal and the first seat's opening purchase, plus whatever the burst derived. */
function playedRoom() {
  const room = session();
  expect(submit(room).kind).toBe("applied");
  const first = room.state.player_addresses[0];
  expect(submit(room, { actor: first, msg: BUY_LOWEST }).kind).toBe("applied");
  return room;
}

describe("a new deal is pinned by the server (#1520, tests 1-2)", () => {
  it("1. stamps the current rules-engine version into the recorded deal", () => {
    const room = session();
    const result = submit(room);
    expect(result.kind).toBe("applied");
    expect(room.rulesEngineVersion()).toBe(RULES_ENGINE_VERSION);
    expect(room.incompatible).toBeNull();
    const setup = setupPayloadOf(room.entries);
    expect(setup[RULES_ENGINE_VERSION_FIELD]).toBe(RULES_ENGINE_VERSION);
    // Everything the client sent is still there; the pin is added, nothing is replaced.
    expect(setup.players).toEqual((SETUP as { SetupGame: { players: unknown } }).SetupGame.players);
    expect(setup.build).toBe(BUILD);
    // And the pin is an integer constant, not a build string.
    expect(Number.isInteger(RULES_ENGINE_VERSION)).toBe(true);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toContain(RULES_ENGINE_VERSION);
  });

  it("2. a client cannot choose the pin: a claimed version is overwritten with the server's", () => {
    /* TWO DOORS, AND THE CLIENT'S NUMBER SURVIVES NEITHER. The server's schema check (#1300, run in
       `gameServer.ts` before `submit`) admits an integer or nothing (`int?`) and refuses anything else; the
       session then stamps its own version over whatever arrived. So an integer claim is applied and
       OVERWRITTEN, a non-integer claim never reaches the session -- and a session handed one anyway (the
       schema bypassed) still overwrites it. */
    const claims: Array<[unknown, boolean]> = [
      [FOREIGN_VERSION, true],
      [0, true],
      [-1, true],
      ["1", false],
      [null, false],
      [{ v: 1 }, false],
    ];
    for (const [claimed, passesSchema] of claims) {
      const spoofed = {
        SetupGame: { ...(SETUP as { SetupGame: Record<string, unknown> }).SetupGame, [RULES_ENGINE_VERSION_FIELD]: claimed },
      } as never;
      expect(validateGameplayMessage(spoofed).ok).toBe(passesSchema);
      const room = session();
      const result = submit(room, { msg: spoofed });
      expect(result.kind).toBe("applied");
      expect(setupPayloadOf(room.entries)[RULES_ENGINE_VERSION_FIELD]).toBe(RULES_ENGINE_VERSION);
      expect(room.rulesEngineVersion()).toBe(RULES_ENGINE_VERSION);
      expect(replayCompatibility(room.entries).kind).toBe("compatible");
    }
    // And a deal that says nothing at all is stamped too: a new room never leaves the server unpinned.
    const silent = session();
    submit(silent, { msg: SETUP });
    expect(setupPayloadOf(silent.entries)[RULES_ENGINE_VERSION_FIELD]).toBe(RULES_ENGINE_VERSION);
  });
});

describe("a same-version room continues (#1520, tests 3-4)", () => {
  it("3. a restart on the same rules version rebuilds the same board and keeps the pin", () => {
    const played = playedRoom();
    const counting = countingProviders();
    const restarted = session(BUILD, played.entries, counting.providers);
    expect(restarted.incompatible).toBeNull();
    expect(restarted.rulesEngineVersion()).toBe(RULES_ENGINE_VERSION);
    expect(stateDigest(restarted.state)).toBe(stateDigest(played.state));
    expect(counting.count()).toBe(played.entries.length);
    const catchUp = restarted.catchUp(-1);
    expect(catchUp.kind).toBe("catch-up");
    if (catchUp.kind !== "catch-up") return;
    expect(catchUp.entries).toHaveLength(played.entries.length);
  });

  it("4. RevertTo rebuilds under the same engine, keeps the pin, and never upgrades it", () => {
    const room = session();
    submit(room);
    const afterDeal = stateDigest(room.state);
    const first = room.state.player_addresses[0];
    submit(room, { actor: first, msg: BUY_LOWEST });
    expect(stateDigest(room.state)).not.toBe(afterDeal);
    // Rewind to just after the deal (index 1 onward did not happen); the deal -- and its pin -- stand.
    const reverted = submit(room, {
      actor: ALICE,
      msg: { RevertTo: { index: 1, player: ALICE, summary: "undo the purchase" } } as never,
    });
    expect(reverted.kind).toBe("applied");
    expect(room.incompatible).toBeNull();
    expect(room.rulesEngineVersion()).toBe(RULES_ENGINE_VERSION);
    expect(stateDigest(room.state)).toBe(afterDeal);
    // The pin lives in the deal's payload and the revert did not touch that entry.
    expect(setupPayloadOf(room.entries)[RULES_ENGINE_VERSION_FIELD]).toBe(RULES_ENGINE_VERSION);
    // A revert that kills the deal itself leaves an undealt log: no pin, and no opinion -- not "current".
    submit(room, { actor: ALICE, msg: { RevertTo: { index: 0, player: ALICE, summary: "undo the deal" } } as never });
    expect(room.rulesEngineVersion()).toBeUndefined();
    expect(replayCompatibility(room.entries).kind).toBe("undealt");
  });
});

describe("an incompatible room is held, not rebuilt (#1520, tests 5-7)", () => {
  let played: ReturnType<typeof playedRoom>;
  let stored: ServerLogEntry[];
  beforeAll(() => {
    played = playedRoom();
    stored = repinned(played.entries, FOREIGN_VERSION);
  });

  it("5. is refused before replay: RoomEngine.apply is never entered and the reducer is never fed", () => {
    const apply = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      const counting = countingProviders();
      const restored = session(BUILD, stored, counting.providers);
      expect(apply).not.toHaveBeenCalled();
      expect(counting.count()).toBe(0);
      expect(restored.incompatible).not.toBeNull();
      expect(restored.incompatible?.compatibility).toEqual({
        kind: "incompatible",
        version: FOREIGN_VERSION,
        supported: SUPPORTED_RULES_ENGINE_VERSIONS,
      });
      expect(restored.rulesEngineVersion()).toBe(FOREIGN_VERSION);
      // The engine is at its seed: the board "nothing has been interpreted".
      expect(stateDigest(restored.state)).toBe(stateDigest(session().state));
      // A joining client is told, and handed no history.
      const hello = restored.catchUp(-1);
      expect(hello.kind).toBe("incompatible");
      if (hello.kind !== "incompatible") return;
      expect(hello.pinnedRulesEngineVersion).toBe(FOREIGN_VERSION);
      expect(hello.supportedRulesEngineVersions).toEqual(SUPPORTED_RULES_ENGINE_VERSIONS);
      expect(hello.reason).toContain(`version ${FOREIGN_VERSION}`);
      expect(hello.build).toBe(BUILD);
    } finally {
      apply.mockRestore();
    }
  });

  it("6. appends nothing and rewrites nothing: the log is exactly what was loaded", () => {
    const before = JSON.stringify(stored);
    const restored = session(BUILD, stored);
    expect(JSON.stringify(restored.entries)).toBe(before);
    expect(restored.entries).toHaveLength(stored.length);
    expect(restored.nextIndex).toBe(stored.length);
    // No mutation in place either: the caller's array is untouched.
    expect(JSON.stringify(stored)).toBe(before);
  });

  it("7. answers every submission `incompatible` -- a move, a deal, a RevertTo -- and applies none", () => {
    const apply = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      const counting = countingProviders();
      const restored = session(BUILD, stored, counting.providers);
      const before = JSON.stringify(restored.entries);
      const first = played.state.player_addresses[0];
      const attempts = [
        submit(restored, { actor: first, msg: BUY_LOWEST }),
        submit(restored, { actor: ALICE, msg: SETUP }),
        submit(restored, {
          actor: ALICE,
          msg: { RevertTo: { index: 0, player: ALICE, summary: "start over" } } as never,
        }),
        submit(restored, { actor: first, msg: BUY_LOWEST, submissionId: "retry-1" }),
        submit(restored, { actor: first, msg: BUY_LOWEST, submissionId: "retry-1" }),
      ];
      for (const attempt of attempts) expect(attempt.kind).toBe("incompatible");
      expect(JSON.stringify(restored.entries)).toBe(before);
      expect(restored.incompatible?.compatibility.kind).toBe("incompatible");
      expect(apply).not.toHaveBeenCalled();
      expect(counting.count()).toBe(0);
      // Still held, still telling the same story, after every attempt.
      expect(restored.catchUp(-1).kind).toBe("incompatible");
    } finally {
      apply.mockRestore();
    }
  });

  it("the headless replay refuses it the same way, before its first entry, under every policy", () => {
    for (const policy of [SERVER_REPLAY_POLICY, DEVELOPMENT_CORPUS_POLICY]) {
      const counting = countingProviders();
      expect(() => replayLog(stored, counting.providers, seed(), undefined, policy)).toThrow(ReplayIncompatibleError);
      expect(counting.count()).toBe(0);
    }
  });
});

describe("a legacy log carries no pin and is not read as current (#1520, test 8)", () => {
  let legacy: ServerLogEntry[];
  beforeAll(() => {
    legacy = repinned(playedRoom().entries, undefined);
  });

  it("reads as `legacy`, never as the current version", () => {
    expect(rulesEngineVersionOf(legacy)).toBeNull();
    expect(replayCompatibility(legacy)).toEqual({ kind: "legacy" });
    expect(replayRefusal({ kind: "legacy" }, SERVER_REPLAY_POLICY)).toEqual(expect.stringContaining("before rules-engine versioning"));
    expect(replayRefusal({ kind: "legacy" }, DEVELOPMENT_CORPUS_POLICY)).toBeNull();
    // The stored corpus's `build: "dev"` is a build string, not a version, and buys nothing here.
    expect(setupPayloadOf(legacy).build).toBe(BUILD);
    expect(setupPayloadOf(legacy)[RULES_ENGINE_VERSION_FIELD]).toBeUndefined();
  });

  it("the server holds it: no apply, no append, `incompatible` with a null pin", () => {
    const apply = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      const counting = countingProviders();
      const restored = session(BUILD, legacy, counting.providers);
      expect(apply).not.toHaveBeenCalled();
      expect(counting.count()).toBe(0);
      expect(restored.incompatible?.compatibility).toEqual({ kind: "legacy" });
      expect(restored.rulesEngineVersion()).toBeNull();
      const hello = restored.catchUp(-1);
      expect(hello.kind).toBe("incompatible");
      if (hello.kind === "incompatible") expect(hello.pinnedRulesEngineVersion).toBeNull();
      const first = played(legacy);
      expect(submit(restored, { actor: first, msg: BUY_LOWEST }).kind).toBe("incompatible");
      expect(restored.entries).toHaveLength(legacy.length);
    } finally {
      apply.mockRestore();
    }
  });

  it("the development corpus's policy is the one explicit way in, and the default is not it", () => {
    const refusing = countingProviders();
    expect(() => replayLog(legacy, refusing.providers, seed())).toThrow(ReplayIncompatibleError);
    expect(refusing.count()).toBe(0);
    const admitting = countingProviders();
    const result = replayLog(legacy, admitting.providers, seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(admitting.count()).toBe(legacy.length);
    expect(result.applied).toBe(legacy.length);
  });

  it("the server's opt-in is explicit, per room, and admits legacy only -- never a foreign version", () => {
    /* `start.ts --legacy-logs development-corpus` reaches the session as `replayPolicy`. Under it a legacy
       room rebuilds (and is warned about, server-side); a room pinned to a foreign version is still held. */
    const admitted = new RoomSession({
      providers: sandboxReplayProviders(),
      seed: seed(),
      build: BUILD,
      mintId: () => "x",
      replayPolicy: DEVELOPMENT_CORPUS_POLICY,
    });
    admitted.restore(legacy);
    expect(admitted.incompatible).toBeNull();
    expect(admitted.replayCompatibility()).toEqual({ kind: "legacy" });
    expect(admitted.catchUp(-1).kind).toBe("catch-up");
    const foreign = new RoomSession({
      providers: sandboxReplayProviders(),
      seed: seed(),
      build: BUILD,
      mintId: () => "x",
      replayPolicy: DEVELOPMENT_CORPUS_POLICY,
    });
    foreign.restore(repinned(legacy, FOREIGN_VERSION));
    expect(foreign.incompatible?.compatibility.kind).toBe("incompatible");
  });

  it("a newly dealt room is never legacy", () => {
    const room = session();
    submit(room);
    expect(replayCompatibility(room.entries).kind).toBe("compatible");
  });

  function played(entries: readonly ServerLogEntry[]): string {
    return ((JSON.parse(entries[0].payload) as { SetupGame: { players: { id: string }[] } }).SetupGame.players[0].id);
  }
});

describe("the build is not the rules version (#1520, tests 9-10)", () => {
  it("9. build skew and the deal-build pin still answer their own cases, and neither is `incompatible`", () => {
    const played = playedRoom();
    const first = played.state.player_addresses[0];
    // Client on a different build: build-skew, before anything -- including this boundary.
    expect(submit(played, { actor: first, build: "some-other-ui-build", msg: BUY_LOWEST }).kind).toBe("build-skew");
    // Server restarted on a different build, same rules version: the room IS rebuilt (the log means the
    // same thing), and it is the deal-build pin (#1252) that then refuses further moves -- a refusal, not a hold.
    const counting = countingProviders();
    const upgraded = session("build-two", played.entries, counting.providers);
    expect(upgraded.incompatible).toBeNull();
    expect(counting.count()).toBe(played.entries.length);
    const refused = upgraded.submit({ actor: first, build: "build-two", msg: BUY_LOWEST, baseIndex: upgraded.nextIndex - 1 });
    expect(refused.kind).toBe("refused");
    expect((refused as { reason: string }).reason).toContain(`dealt on build "${BUILD}"`);
    expect(upgraded.entries).toHaveLength(played.entries.length);
  });

  it("10. a UI build difference alone changes neither the pin nor the board it rebuilds", () => {
    const played = playedRoom();
    const elsewhere = session("a-different-ui-deploy", played.entries);
    expect(elsewhere.rulesEngineVersion()).toBe(played.rulesEngineVersion());
    expect(elsewhere.rulesEngineVersion()).toBe(RULES_ENGINE_VERSION);
    expect(stateDigest(elsewhere.state)).toBe(stateDigest(played.state));
    expect(elsewhere.catchUp(-1).kind).toBe("catch-up");
    // And the converse: the SAME build with a different pinned version is held regardless of the build.
    const sameBuild = session(BUILD, repinned(played.entries, FOREIGN_VERSION));
    expect(sameBuild.incompatible?.compatibility.kind).toBe("incompatible");
    expect(setupPayloadOf(sameBuild.entries).build).toBe(BUILD);
  });
});
