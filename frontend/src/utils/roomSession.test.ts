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
    const second = submit(room, { msg: { OpenStockRound: {} } as never });
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
    submit(room, { msg: { OpenStockRound: {} } as never });

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
    submit(room, { msg: { OpenStockRound: {} } as never });
    const before = room.entries.length;

    const refused = room.submit({
      actor: BOB,
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
    submit(original, { msg: { OpenStockRound: {} } as never });

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
