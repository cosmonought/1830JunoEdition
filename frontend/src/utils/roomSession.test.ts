/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1209 (harness): THE LOOP, AND THE SOCKET THAT DIES MID-BURST
// ==================================================================
//
// The ordinary path is three lines and would be dull to test at length. What earns cases here is everything
// that happens when the transport misbehaves, because those paths run rarely, are hard to reproduce by hand,
// and each one corrupts a game if it is wrong.
//
// A NOTE ON WHAT "THE SERVER CRASHED" MEANS BELOW: a new `RoomSession` restored from the log the old one had
// written. That is exactly what a restart is, and it is why the crash cases can be written at all.

export {};

const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
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

type ServerLogEntry = import("./roomSession").ServerLogEntry;

const BUILD = "build-under-test";
const ALICE = "p-alice";
const BOB = "p-bob";

function session(entries?: readonly ServerLogEntry[]) {
  let n = 0;
  const room = new RoomSession({
    providers: sandboxReplayProviders(),
    seed: {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(
        sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
        [],
      ),
    },
    build: BUILD,
    mintId: () => `id${(n += 1)}`,
    now: () => 1_000 + n,
  });
  if (entries) room.restore(entries);
  return room;
}

/** Deals a real roster, which is what makes any later turn question meaningful. */
const SETUP = {
  SetupGame: {
    players: [
      { id: ALICE, nickname: "Alice" },
      { id: BOB, nickname: "Bob" },
    ],
    variants: {},
  },
} as never;

/** The first seat's opening purchase -- a move the auction allows, for the cases that need any second move. */
const BUY_LOWEST = { WaterfallBuyLowest: { game_id: 0 } } as never;

const submit = (
  room: ReturnType<typeof session>,
  over: Partial<Parameters<typeof room.submit>[0]> = {},
) =>
  room.submit({
    actor: ALICE,
    build: BUILD,
    msg: SETUP,
    baseIndex: room.nextIndex - 1,
    ...over,
  });

describe("the ordinary path", () => {
  it("applies, appends, and answers with what it appended", () => {
    const room = session();
    const result = submit(room);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].index).toBe(0);
    expect(result.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(room.entries).toHaveLength(1);
  });

  it("numbers entries from the log rather than from a counter", () => {
    const room = session();
    submit(room);
    /* #1249: `OpenStockRound` used to stand in for "any second move" here; it is refused mid-auction now, as
       it should be. The first seat's purchase is a move the board allows. */
    const second = submit(room, { actor: room.state.player_addresses[0], msg: BUY_LOWEST });
    expect(second.kind).toBe("applied");
    if (second.kind !== "applied") return;
    expect(second.entries[0].index).toBe(1);
  });
});

describe("build skew is answered before anything else", () => {
  it("does not judge a move against a board the two halves describe differently", () => {
    /* #1206: the digest covers the whole state, so an older client disagrees about fields that are not
       divergences. Answering this first means no refusal and no catch-up is ever measured against a board
       the client cannot reconstruct. */
    const room = session();
    const result = submit(room, { build: "some-older-build" });
    expect(result.kind).toBe("build-skew");
    expect(room.entries).toHaveLength(0);
  });
});

describe("the socket that dies before the answer lands", () => {
  it("treats a retry as news rather than as a second move", () => {
    /* #1209 mechanism 1. THE APPEND IS THE COMMIT POINT AND THE RESPONSE IS NEWS -- so a move whose answer
       was lost has still happened, and the retry must not make it happen twice. */
    const room = session();
    const first = submit(room, { submissionId: "nonce-1" });
    expect(first.kind).toBe("applied");
    expect(room.entries).toHaveLength(1);

    const retry = submit(room, { submissionId: "nonce-1", baseIndex: -1 });
    expect(retry.kind).toBe("catch-up");
    expect(room.entries).toHaveLength(1);
  });

  it("tells the retrying client what it missed, including its own action", () => {
    /* Answered before staleness on purpose: a client retrying after a dropped socket is BOTH duplicated and
       behind, and "you are behind" alone would invite a third attempt. */
    const room = session();
    submit(room, { submissionId: "nonce-1" });
    const retry = submit(room, { submissionId: "nonce-1", baseIndex: -1 });
    if (retry.kind !== "catch-up") throw new Error("expected catch-up");
    expect(retry.entries.map((entry) => entry.index)).toEqual([0]);
  });

  it("survives a restart, because the nonce is on the log rather than in memory", () => {
    /* THE REASON THE NONCE LIVES ON THE ENTRY. A table would be empty after a crash and the retry would be
       applied twice -- which is the exact failure the mechanism exists to prevent, arriving through the
       mechanism itself. */
    const first = session();
    submit(first, { submissionId: "nonce-1" });

    const restarted = session(first.entries);
    const retry = restarted.submit({
      actor: ALICE,
      build: BUILD,
      msg: SETUP,
      baseIndex: -1,
      submissionId: "nonce-1",
    });
    expect(retry.kind).toBe("catch-up");
    expect(restarted.entries).toHaveLength(1);
  });
});

describe("a client that fell behind", () => {
  it("is caught up rather than applied on top of a board it does not have", () => {
    /* #1207: applying a burst onto a board that never saw the previous one derives a board nobody has -- a
       divergence MANUFACTURED by the transport rather than found by it, and indistinguishable from a real
       one once it has happened. */
    const room = session();
    submit(room);
    submit(room, { actor: room.state.player_addresses[0], msg: BUY_LOWEST });

    const stale = submit(room, { baseIndex: -1, msg: { PassTurn: { game_id: 0 } } as never });
    expect(stale.kind).toBe("catch-up");
    if (stale.kind !== "catch-up") return;
    expect(stale.entries.map((entry) => entry.index)).toEqual([0, 1]);
  });
});

describe("turn authority, asked with the auction atom", () => {
  it("refuses a player who is not on turn and appends nothing", () => {
    /* The refusal `applyOneAction` could never make (#1174/#1182), made here because there is one judge.
       AND IT MUST NOT APPEND: a refused action that reached the log would be applied by every client on the
       next rebuild, which is the refusal doing the damage it was written to prevent. */
    const room = session();
    submit(room);
    const [first] = room.state.player_addresses;
    submit(room, { actor: first, msg: BUY_LOWEST }); // the turn passes to the second seat
    const before = room.entries.length;

    const refused = room.submit({
      actor: first,
      build: BUILD,
      msg: { PassTurn: { game_id: 0 } } as never,
      baseIndex: room.nextIndex - 1,
    });
    expect(refused.kind).toBe("refused");
    expect(room.entries).toHaveLength(before);
  });
});

describe("restoring a room", () => {
  it("rebuilds the same board the original had", () => {
    const original = session();
    submit(original);
    submit(original, { actor: original.state.player_addresses[0], msg: BUY_LOWEST });

    const restored = session(original.entries);
    expect(restored.state.current_round_type).toBe(original.state.current_round_type);
    expect(restored.state.player_addresses).toEqual(original.state.player_addresses);
    expect(restored.nextIndex).toBe(original.nextIndex);
  });

  it("applies a restored log rather than re-deriving it", () => {
    /* #1203: a stored log ALREADY CONTAINS its derived entries. A restore that called `submit` would
       generate them again and double every automatic action in the game. */
    const original = session();
    submit(original);
    const restored = session(original.entries);
    expect(restored.entries).toHaveLength(original.entries.length);
  });
});

/* LIVE-4 (L4-2): #1252 pinned a room to the BUILD that dealt it. That pin is retired -- a room continues by its deal's
   semantic identity (rules pin, hosted protocol), judged by the continuation verdict at every rebuild -- and the deal's
   build is kept as history only. The cases below are #1252's, restated for what now holds. */
describe("a room continues by its deal's semantic identity, never by the build that dealt it (#1252 retired)", () => {
  const dealNaming = (build: string | undefined) =>
    ({
      SetupGame: {
        players: [
          { id: ALICE, nickname: "Alice" },
          { id: BOB, nickname: "Bob" },
        ],
        variants: {},
        ...(build === undefined ? {} : { build }),
      },
    }) as never;

  it("reads the dealing build off the log, and none off an unpinned or undealt one", () => {
    const room = session();
    expect(room.dealtBuild()).toBeNull();
    submit(room, { msg: dealNaming(undefined) });
    expect(room.dealtBuild()).toBeNull(); // #232: a log written before the field is unpinned
    const pinned = session();
    submit(pinned, { msg: dealNaming(BUILD) });
    expect(pinned.dealtBuild()).toBe(BUILD);
  });

  it("continues on a server whose build is not the one that dealt: the rules pin is the same, so the move is applied", () => {
    /* The stored log says one build; the process that restored it is another. Its rules pin and (absent) hosted protocol
       are this engine's, so the verdict continues it and the move lands -- #1252 refused it. */
    const dealtOn = session();
    submit(dealtOn, { msg: dealNaming(BUILD) });
    const first = dealtOn.state.player_addresses[0];

    const upgraded = new RoomSession({
      providers: sandboxReplayProviders(),
      seed: {
        state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
        waterfall: waterfallForRoster(
          sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
          [],
        ),
      },
      build: "build-two",
      mintId: () => "x",
    });
    upgraded.restore(dealtOn.entries);
    expect(upgraded.incompatible).toBeNull();
    expect(upgraded.continuationVerdict).toEqual({ kind: "continues" });
    const applied = upgraded.submit({ actor: first, build: "build-two", msg: BUY_LOWEST, baseIndex: upgraded.nextIndex - 1 });
    expect(applied.kind).toBe("applied");
    expect(upgraded.entries).toHaveLength(dealtOn.entries.length + 1);
    expect(upgraded.dealtBuild()).toBe(BUILD); // history, kept
  });

  it("a deal naming another build is dealt, and its build kept as history -- it decides nothing", () => {
    const room = session();
    const applied = submit(room, { msg: dealNaming("somebody-elses-build") });
    expect(applied.kind).toBe("applied");
    expect(room.entries).toHaveLength(1);
    expect(room.dealtBuild()).toBe("somebody-elses-build");
  });

  it("a reverted deal pins nothing", () => {
    /* LIVE-2A (LIVE-2 §9.2, RV-5): a live submit can no longer revert the deal -- the deal is the floor. The fact
       this case pins is about STORED history, which is replayed without the authority: a log that already holds
       a revert of its deal (every room before LIVE-2A could write one) restores to no pin. */
    const room = session();
    submit(room, { msg: dealNaming(BUILD) });
    const refused = submit(room, { actor: ALICE, msg: { RevertTo: { index: 0, player: ALICE, summary: "x" } } as never });
    expect((refused as { kind: string }).kind).toBe("refused");
    expect(room.dealtBuild()).toBe(BUILD);
    const stored = [
      room.entries[0],
      { index: 1, id: "stored-revert", actor: ALICE, payload: JSON.stringify({ RevertTo: { index: 0, player: ALICE, summary: "x" } }), at: 0 },
    ];
    const restored = session();
    restored.restore(stored as never);
    expect(restored.dealtBuild()).toBeNull();
  });
});

describe("a move the store could not take did not happen (#1250)", () => {
  it("discardAfter drops the entries, rebuilds the board, and forgets the nonce", () => {
    /* The server appends to disk between `submit` and the answer; a store that rejects rolls the session
       back to the length the disk last acknowledged. Three things must then be true: the log is shorter, the
       board is the shorter log's, and a retry with the same nonce is applied afresh rather than answered as
       already made -- because from the client's side the first attempt was refused. */
    const room = session();
    submit(room);
    const first = room.state.player_addresses[0];
    const before = room.entries.length;
    submit(room, { actor: first, msg: BUY_LOWEST, submissionId: "buy-1" });
    expect(room.entries.length).toBeGreaterThan(before);
    expect(room.state.private_companies.find((entry) => entry.private_id === 1)?.owner).toBe(first);

    room.discardAfter(before);
    expect(room.entries).toHaveLength(before);
    expect(room.state.private_companies.find((entry) => entry.private_id === 1)?.owner ?? null).toBeNull();

    const retry = submit(room, { actor: first, msg: BUY_LOWEST, submissionId: "buy-1" });
    expect(retry.kind).toBe("applied");
    expect(room.state.private_companies.find((entry) => entry.private_id === 1)?.owner).toBe(first);
  });

  it("is a no-op at or above the current length", () => {
    const room = session();
    submit(room);
    const entries = room.entries.length;
    room.discardAfter(entries);
    room.discardAfter(entries + 5);
    expect(room.entries).toHaveLength(entries);
  });
});

describe("a live revert is a rebuild, not a step (#1233)", () => {
  /* REPORTED: "I used Undo from PRR back to B&O, which then tried buying two 2-trains: the screen flashed, the
     Activity Log printed the action happened, but no trains appeared in its assets, and the game locked."
     `replayLog` resolves reverts over the whole log; `RoomEngine.apply` cannot, and said so. Nothing made a
     room IN PLAY rebuild, so a live `RevertTo` was appended and handed to a reducer with no arm for it --
     the client rewound, the server did not, and every move after it was judged against the wrong board. */
  const owner = (room: ReturnType<typeof session>, privateId: number) =>
    room.state.private_companies.find((entry) => entry.private_id === privateId)?.owner ?? null;
  const cash = (room: ReturnType<typeof session>, who: string) =>
    Number(room.state.player_cash.find((entry) => entry.player === who)?.cash_vgp);

  it("rewinds the board to what the effective log says", () => {
    const room = session();
    submit(room);                                            // 0: deal
    const first = room.state.player_addresses[0];
    submit(room, { actor: first, msg: BUY_LOWEST });         // 1: the first seat buys Schuylkill Valley
    expect(owner(room, 1)).toBe(first);
    const before = cash(room, first);

    const revert = submit(room, {
      actor: first,
      msg: { RevertTo: { index: 1, player: first, summary: "the purchase" } } as never,
    });
    expect(revert.kind).toBe("applied");
    /* THE PURCHASE IS UNDONE ON THE SERVER, not merely recorded as undone. Before the fix both of these held
       their post-purchase values while the log claimed otherwise. */
    expect(owner(room, 1)).toBeNull();
    expect(cash(room, first)).toBe(before + 20);
  });

  it("puts the turn back where the rewound board says it is, so the next move lands", () => {
    const room = session();
    submit(room);
    const [first, second] = room.state.player_addresses;
    submit(room, { actor: first, msg: BUY_LOWEST });         // first buys; turn passes to second
    submit(room, { actor: first, msg: { RevertTo: { index: 1, player: first, summary: "x" } } as never });
    /* THE LOCK, INVERTED. After the revert it is `first`'s turn again. Before the fix the server still had
       `second` on turn, refused `first`, and the room was stuck between two boards. */
    expect(submit(room, { actor: second, msg: BUY_LOWEST }).kind).toBe("refused");
    const again = submit(room, { actor: first, msg: BUY_LOWEST });
    expect(again.kind).toBe("applied");
    expect(owner(room, 1)).toBe(first);
  });

  it("keeps the revert in the log, so a client's own drain can honour it", () => {
    const room = session();
    submit(room);
    const first = room.state.player_addresses[0];
    submit(room, { actor: first, msg: BUY_LOWEST });
    const revert = submit(room, {
      actor: first,
      msg: { RevertTo: { index: 1, player: first, summary: "x" } } as never,
    });
    const last = room.entries[room.entries.length - 1];
    expect(JSON.parse(last.payload)).toHaveProperty("RevertTo");
    expect((revert as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it("restores a stored log with reverts in it through the same path", () => {
    /* A restart must not replay reverted actions as if they had stood. `restore` now rebuilds through
       `effectiveActions` like everything else. */
    const room = session();
    submit(room);
    const first = room.state.player_addresses[0];
    submit(room, { actor: first, msg: BUY_LOWEST });
    submit(room, { actor: first, msg: { RevertTo: { index: 1, player: first, summary: "x" } } as never });
    const restarted = session(room.entries);
    expect(owner(restarted, 1)).toBeNull();
    expect(restarted.nextIndex).toBe(room.nextIndex);
  });
});

/* ==================================================================
    LIVE-3A (L3-3): `baseIndex` IS TWO-SIDED, AND ANCHORED BY `baseId`
   ==================================================================
   Below the watermark is stale, equal is eligible, above is `ahead` -- impossible under durable-before-visible,
   so it means lost history or a broken client, and nothing is run. `baseId` catches the history that diverged
   while BEHIND. Both come before the nonce: a diverged client's duplicate answer would be computed from a history
   it does not share. */
describe("LIVE-3A: baseIndex is two-sided and anchored", () => {
  it("refuses a baseIndex above the watermark as `ahead`, with the watermark, appending nothing", () => {
    const room = session();
    submit(room);
    const ahead = submit(room, { actor: room.state.player_addresses[0], msg: BUY_LOWEST, baseIndex: 5 });
    expect(ahead).toMatchObject({ kind: "refused", code: "ahead", watermark: 0 });
    expect(room.entries).toHaveLength(1);
  });

  it("answers `ahead` before the nonce: a known submission id sent from ahead is not a duplicate", () => {
    const room = session();
    submit(room, { submissionId: "nonce-1" });
    const retry = submit(room, { submissionId: "nonce-1", baseIndex: 7 });
    expect(retry).toMatchObject({ kind: "refused", code: "ahead" });
  });

  it("an empty room's watermark is -1: baseIndex 0 is ahead of it", () => {
    const room = session();
    expect(submit(room, { baseIndex: 0 })).toMatchObject({ kind: "refused", code: "ahead", watermark: -1 });
    expect(room.entries).toHaveLength(0);
  });

  it("equal is eligible and below is stale, exactly as before", () => {
    const room = session();
    submit(room);
    const first = room.state.player_addresses[0];
    expect(submit(room, { actor: first, msg: BUY_LOWEST, baseIndex: 0 }).kind).toBe("applied");
    expect(submit(room, { actor: first, msg: BUY_LOWEST, baseIndex: 0 }).kind).toBe("catch-up");
  });

  it("a baseId that is not the room's entry at baseIndex is `resync` -- even for a client that is BEHIND", () => {
    const room = session();
    submit(room);
    const first = room.state.player_addresses[0];
    submit(room, { actor: first, msg: BUY_LOWEST });
    // Behind (baseIndex 0 < 1), but anchored to an entry this room never held there: diverged, not merely stale.
    const diverged = submit(room, { baseIndex: 0, baseId: "not-this-rooms", msg: { PassTurn: { game_id: 0 } } as never });
    expect(diverged).toMatchObject({ kind: "refused", code: "resync", watermark: 1 });
    // The right anchor is the ordinary stale answer.
    const stale = submit(room, { baseIndex: 0, baseId: room.entries[0].id, msg: { PassTurn: { game_id: 0 } } as never });
    expect(stale.kind).toBe("catch-up");
    expect(room.entries).toHaveLength(2);
  });

  it("the right anchor at the watermark is eligible; an older client that sends none gets the index-only rules", () => {
    const room = session();
    submit(room);
    const first = room.state.player_addresses[0];
    expect(submit(room, { actor: first, msg: BUY_LOWEST, baseIndex: 0, baseId: room.entries[0].id }).kind).toBe("applied");
    const second = room.state.player_addresses[1];
    expect(submit(room, { actor: second, msg: BUY_LOWEST, baseIndex: 1 }).kind).toBe("applied");
  });

  it("an anchor is ignored at baseIndex -1, where there is no entry to name", () => {
    const room = session();
    expect(submit(room, { baseIndex: -1, baseId: "anything" }).kind).toBe("applied");
  });
});

describe("LIVE-3A: rollbackTo returns the session to exactly the committed prefix (E-4, E-9)", () => {
  it("drops the entries, forgets their nonces and rebuilds the board", () => {
    const room = session();
    submit(room);
    const committed = room.entries.length;
    const digestAtCommit = JSON.stringify(room.state);
    const first = room.state.player_addresses[0];
    expect(submit(room, { actor: first, msg: BUY_LOWEST, submissionId: "buy-1" }).kind).toBe("applied");
    room.rollbackTo(committed);
    expect(room.entries).toHaveLength(committed);
    expect(JSON.stringify(room.state)).toBe(digestAtCommit);
    // The nonce went with its entry, so the same submission is judged afresh rather than answered as made.
    expect(submit(room, { actor: first, msg: BUY_LOWEST, submissionId: "buy-1" }).kind).toBe("applied");
  });

  it("rebuilds even when the log did not grow -- a throw can move the engine without touching the log", () => {
    const room = session();
    submit(room);
    const before = JSON.stringify(room.state);
    // A private engine touched by nothing the log records: exactly what `discardAfter` would leave in place.
    (room as unknown as { engine: { state: unknown } }).engine.state = { corrupted: true };
    room.rollbackTo(room.entries.length);
    expect(JSON.stringify(room.state)).toBe(before);
  });
});

describe("LIVE-3A: the committed view reads a held room's answer without asking it to catch up", () => {
  it("heldAnswer is null while the room is played and the incompatible frame while it is held", () => {
    const played = session();
    submit(played);
    expect(played.heldAnswer()).toBeNull();
    const foreign = played.entries.map((entry) => {
      const parsed = JSON.parse(entry.payload) as { SetupGame?: Record<string, unknown> };
      if (!parsed.SetupGame) return { ...entry };
      return { ...entry, payload: JSON.stringify({ SetupGame: { ...parsed.SetupGame, rules_engine_version: 999 } }) };
    });
    const held = session(foreign);
    expect(held.heldAnswer()).toMatchObject({ kind: "incompatible", pinnedRulesEngineVersion: 999 });
    expect(held.entryIdAt(0)).toBe(foreign[0].id);
    expect(held.entryIdAt(5)).toBeUndefined();
  });
});
