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
  require("./replayProviders") as typeof import("./replayProviders");
const {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} = require("./sandboxState") as typeof import("./sandboxState");
const { waterfallForRoster, withEmptyRoster } =
  require("./gameSetup") as typeof import("./gameSetup");

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

describe("a room is pinned to the reducer that dealt it (#1252)", () => {
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

  it("refuses every move on a server whose build is not the one that dealt", () => {
    /* The stored log says one build; the process that restored it is another. Client and server agree with
       each other (no skew), so without this both would apply new rules to an old game. */
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
    const refused = upgraded.submit({ actor: first, build: "build-two", msg: BUY_LOWEST, baseIndex: upgraded.nextIndex - 1 });
    expect(refused.kind).toBe("refused");
    expect((refused as { reason: string }).reason).toContain(`dealt on build "${BUILD}"`);
    expect((refused as { reason: string }).reason).toContain('this server is build "build-two"');
    expect(upgraded.entries).toHaveLength(dealtOn.entries.length);
  });

  it("refuses a deal that names a build other than the server's own", () => {
    const room = session();
    const refused = submit(room, { msg: dealNaming("somebody-elses-build") });
    expect(refused.kind).toBe("refused");
    expect(room.entries).toHaveLength(0);
  });

  it("a reverted deal pins nothing", () => {
    const room = session();
    submit(room, { msg: dealNaming(BUILD) });
    submit(room, { actor: ALICE, msg: { RevertTo: { index: 0, player: ALICE, summary: "x" } } as never });
    expect(room.dealtBuild()).toBeNull();
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
