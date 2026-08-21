// frontend/src/utils/sandboxRoom.test.ts
//
// ==================================================================
//  DESIGN NOTE 519 (harness): ORDER IS THE CORRECTNESS PROPERTY
// ==================================================================
//
// The Firestore calls are not tested here -- they are thin wrappers over the
// SDK, and a test that mocks `addDoc` to assert `addDoc` was called asserts
// the mock. What IS tested is everything that decides whether two browsers
// end up in the same game:
//
//   THE ORDERING. 1830 is not commutative. Applying "buy share" and "pay
//   dividend" in the wrong order produces a different board, and because
//   every later action is computed against that board, the divergence never
//   reconciles. `sortActions` is the whole guarantee and it has to be
//   deterministic across clients that received the same entries in
//   different arrival orders.
//
//   THE ROOM CODE. Its job is to survive being spoken aloud and typed by
//   somebody else. A code that round-trips through a voice call wrong sends
//   a player to an empty room, which looks like the feature is broken.
//
//   THE DECODE. One corrupt entry must not take a room down.

import {
  appliedPrefixHolds,
  decodeAction,
  generateRoomCode,
  parseRoomCode,
  sortActions,
  type SandboxAction,
} from "./sandboxRoom";

function action(index: number, id: string, payload = '{"PassTurn":{"game_id":1}}'): SandboxAction {
  return { index, id, actor: "alice", payload, derived: false };
}

describe("the room code", () => {
  it("is prefixed and the right shape", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateRoomCode()).toMatch(/^JUNO-[A-Z0-9]{3}$/);
    }
  });

  it("avoids the characters that get misheard", () => {
    /* Design note #520: `0/O`, `1/I/L` and `5/S` are the pairs that fail
       when a code is read over a call. A generator that emitted them would
       pass the shape test above and still send players to the wrong room. */
    const forbidden = /[01OIL5S]/;
    for (let i = 0; i < 200; i += 1) {
      expect(generateRoomCode().slice(5)).not.toMatch(forbidden);
    }
  });

  it("round-trips its own output", () => {
    // The property that matters most: a hosted code must be joinable.
    for (let i = 0; i < 50; i += 1) {
      const code = generateRoomCode();
      expect(parseRoomCode(code)).toBe(code);
    }
  });

  it("forgives how a player types it", () => {
    // Lower case, no prefix, stray spaces, and a pasted whole code.
    expect(parseRoomCode("juno-4t2")).toBe("JUNO-4T2");
    expect(parseRoomCode("4T2")).toBe("JUNO-4T2");
    expect(parseRoomCode("  JUNO-4T2  ")).toBe("JUNO-4T2");
    expect(parseRoomCode("JUNO- 4T2")).toBe("JUNO-4T2");
  });

  it("rejects a code rather than inventing a room", () => {
    /* A mistyped code must FAIL, not resolve to a plausible room the player
       then sits alone in wondering why nobody joined. */
    for (const bad of ["", "JUNO-", "JUNO-12", "JUNO-4T2X", "JUNO-4O2", "!!!"]) {
      expect(parseRoomCode(bad)).toBeNull();
    }
  });
});

describe("sortActions", () => {
  it("orders by index", () => {
    const sorted = sortActions([action(2, "c"), action(0, "a"), action(1, "b")]);
    expect(sorted.map((a) => a.index)).toEqual([0, 1, 2]);
  });

  it("is deterministic across clients that received entries differently", () => {
    /* THE GUARANTEE. Two browsers get the same set in different arrival
       orders; both must compute the same sequence, or they replay the same
       log into different games. */
    const entries = [action(1, "zz"), action(0, "mm"), action(1, "aa"), action(2, "qq")];
    const forwards = sortActions(entries).map((a) => a.id);
    const backwards = sortActions([...entries].reverse()).map((a) => a.id);
    expect(forwards).toEqual(backwards);
  });

  it("breaks an index tie by document id, not by arrival", () => {
    /* Design note #2: two clients CAN race onto one index. The entries both
       survive, and the tie-break has to be a property of the data rather
       than of who heard about it first. */
    const sorted = sortActions([action(1, "zz"), action(1, "aa")]);
    expect(sorted.map((a) => a.id)).toEqual(["aa", "zz"]);
  });

  it("does not mutate its input", () => {
    // The caller holds this array as its applied-cursor baseline.
    const entries = [action(2, "c"), action(0, "a")];
    sortActions(entries);
    expect(entries.map((a) => a.index)).toEqual([2, 0]);
  });
});

describe("appliedPrefixHolds", () => {
  /* ==================================================================
      DESIGN NOTE 668 (harness): A LENGTH IS NOT A HISTORY
     ==================================================================

     REPORTED: Player 1 stranded in OR 2.2 while Player 2 advanced to SR3.

     The drain decided it had to rebuild by comparing LENGTHS -- a shorter
     effective history meant an undo had landed. That catches an undo and
     nothing else. `sortActions` above guarantees two clients agree on an
     order EVENTUALLY, and the cases below are the window before that: a
     client applies its own optimistic entry, the tie-break then puts
     somebody else's first, and the corrected history is exactly as long as
     the one already applied. Nothing shrank, so nothing rebuilt, and that
     client kept playing a game only it could see.

     Every case here is a way a history can change without changing size. */

  it("holds when the applied entries are still the front of the history", () => {
    const history = [action(0, "a"), action(1, "b"), action(2, "c")];
    expect(appliedPrefixHolds(["a", "b"], history)).toBe(true);
  });

  it("holds for a client that has applied the whole history", () => {
    const history = [action(0, "a"), action(1, "b")];
    expect(appliedPrefixHolds(["a", "b"], history)).toBe(true);
  });

  it("holds trivially for a client that has applied nothing", () => {
    expect(appliedPrefixHolds([], [action(0, "a")])).toBe(true);
    expect(appliedPrefixHolds([], [])).toBe(true);
  });

  it("BREAKS when a race is resolved against the client, at the same length", () => {
    /* THE STRANDING. Both clients wrote at index 1. This one saw its own
       entry `zz` first and applied it; the document-id tie-break then puts
       `aa` ahead of it. Same three entries, same length, different game --
       and the length check would have said nothing was wrong. */
    const applied = ["a", "zz"];
    const corrected = [action(0, "a"), action(1, "aa"), action(1, "zz")];
    expect(corrected.length).toBeGreaterThanOrEqual(applied.length);
    expect(appliedPrefixHolds(applied, corrected)).toBe(false);
  });

  it("breaks when an undo has shortened the history", () => {
    // The case the length check DID catch. Still caught.
    expect(appliedPrefixHolds(["a", "b", "c"], [action(0, "a")])).toBe(false);
  });

  it("breaks when an undo removed an entry from the middle", () => {
    /* `RevertTo` kills a range, so an entry can vanish from under an applied
       cursor while later ones survive at the same total length. */
    expect(appliedPrefixHolds(["a", "b"], [action(0, "a"), action(2, "c")])).toBe(false);
  });

  it("compares document ids, not payloads", () => {
    /* Two entries can carry identical JSON -- two passes in a row are the
       ordinary case -- and still be different events. The id is the only
       thing about an entry that is both unique and agreed on by everybody. */
    const twin = '{"PassTurn":{"game_id":1}}';
    expect(appliedPrefixHolds(["a"], [action(0, "b", twin)])).toBe(false);
  });
});

describe("decodeAction", () => {
  it("returns the message a client can dispatch", () => {
    expect(decodeAction(action(0, "a"))).toEqual({ PassTurn: { game_id: 1 } });
  });

  it("survives a nested array, which Firestore cannot store natively", () => {
    /* `RunManualRoute.path` is an array of objects, and Firestore rejects
       nested arrays -- which is why the payload is JSON text rather than a
       map. If that ever changed to a nested write, this is what would
       break. */
    const path = { RunManualRoute: { game_id: 1, path: [{ hex: "H12" }, { hex: "H10" }] } };
    expect(decodeAction(action(0, "a", JSON.stringify(path)))).toEqual(path);
  });

  it("returns null for a corrupt entry rather than throwing", () => {
    /* One bad document must not take down a whole room's replay: the caller
       skips it and applies the rest. */
    expect(decodeAction(action(0, "a", "{not json"))).toBeNull();
    expect(decodeAction(action(0, "a", ""))).toBeNull();
  });
});
