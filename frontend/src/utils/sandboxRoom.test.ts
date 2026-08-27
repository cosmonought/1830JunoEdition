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
import {
  waitingRoomBlock,
  waitingRoomNotice,
  canStartSandboxGame,
  type SandboxRoomDoc,
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

// ==================================================================
//  DESIGN NOTE 857 (harness): THE ANSWER THE HOST WAS ONLY HOVERING
// ==================================================================
//
// ASKED: "in the game lobby, when a non-host player clicks 'Ready,' there should be a notification like
// 'Waiting for Host to start the game...' so that players know they don't need to do anything else."
//
// IT EXISTED AND ONLY THE HOST COULD SEE IT. `SandboxWaitingRoom`'s Start button carried a three-way `title`
// naming whatever was blocking -- hovered by the one person who did not need it, since the host is the one
// who can act. Third tooltip this session found holding something a player needs (#806, #839).
//
// AND "WAITING FOR THE HOST" IS NOT ALWAYS TRUE, which is why this is a reason rather than a sentence: a
// player alone in a room is not waiting for the host, because the host cannot start either.

const room = (
  players: ReadonlyArray<{ id: string; isReady: boolean }>,
  status: SandboxRoomDoc["status"] = "waiting",
): SandboxRoomDoc =>
  ({
    code: "JUNO-1A1",
    hostId: "h",
    status,
    players: players.map((entry) => ({ id: entry.id, nickname: entry.id, isReady: entry.isReady })),
  }) as SandboxRoomDoc;

const GUEST = { isHost: false, isReady: true };

describe("waitingRoomBlock", () => {
  it("reports the player count before readiness, as the start rule does", () => {
    /* THE ORDER IS THE POINT. `canStartSandboxGame` refuses on count first; a reader that checked readiness
       first would tell a lone player they were waiting for OTHERS TO READY when what the room lacks is
       people.
       THE FIXTURE HAS TO DISAGREE UNDER THE TWO ORDERS, and the first draft did not: one READY player
       satisfies `every(isReady)` either way, so both orders returned "need-players" and a negative control
       that swapped the two lines left this green. A lone NOT-ready player is the case that separates them.
       Fifth vacuous assertion caught by a mutation this session. */
    expect(waitingRoomBlock(room([{ id: "h", isReady: false }]), 2)).toBe("need-players");
    expect(waitingRoomBlock(room([{ id: "h", isReady: true }]), 2)).toBe("need-players");
  });

  it("reports readiness once there are enough players", () => {
    expect(waitingRoomBlock(room([{ id: "h", isReady: true }, { id: "b", isReady: false }]), 2)).toBe(
      "need-ready",
    );
  });

  it("reports the host once nothing else is missing", () => {
    expect(waitingRoomBlock(room([{ id: "h", isReady: true }, { id: "b", isReady: true }]), 2)).toBe(
      "host-to-start",
    );
  });

  it("agrees with canStartSandboxGame on every case", () => {
    /* ONE RULE, TWO READERS, PINNED TOGETHER. Two functions answering "is this room startable" is the shape
       this codebase keeps finding wrong; they are not merged because they answer different questions (a
       boolean and a reason), so instead they are checked against each other. */
    const cases: SandboxRoomDoc[] = [
      room([]),
      room([{ id: "h", isReady: true }]),
      room([{ id: "h", isReady: true }, { id: "b", isReady: false }]),
      room([{ id: "h", isReady: true }, { id: "b", isReady: true }]),
      room([{ id: "h", isReady: true }, { id: "b", isReady: true }], "playing"),
    ];
    cases.forEach((entry) => {
      expect(waitingRoomBlock(entry, 2) === "host-to-start").toBe(canStartSandboxGame(entry, 2));
    });
  });
});

describe("waitingRoomNotice", () => {
  const full = room([{ id: "h", isReady: true }, { id: "b", isReady: true }]);

  it("says what was asked for once everything else is settled", () => {
    expect(waitingRoomNotice(full, 2, GUEST)).toContain("Waiting for the Host to start the game");
  });

  it("says nothing to the host, who is the one who can act", () => {
    expect(waitingRoomNotice(full, 2, { isHost: true, isReady: true })).toBeNull();
  });

  it("says nothing until the player has readied", () => {
    /* THE LINE ANSWERS "have I finished?", and somebody who has not pressed Ready has not. Telling them what
       the room lacks first would read as a refusal of a button they have not tried. */
    expect(waitingRoomNotice(full, 2, { isHost: false, isReady: false })).toBeNull();
  });

  it("does not blame the host for a room that is short of players", () => {
    /* THE ONE THAT WOULD HAVE BEEN WRONG. A ready player alone in a room is waiting for PEOPLE. Naming the
       host there is a surface asserting something the start rule does not. */
    const alone = room([{ id: "b", isReady: true }]);
    const line = waitingRoomNotice(alone, 2, GUEST);
    expect(line).toContain("more players");
    expect(line).not.toContain("Host");
    /* And the same for a room short of people whose members are not all ready -- the count still wins, which
       is the ordering the test above pins and this one reads through the sentence a player actually sees. */
    const aloneNotReady = room([{ id: "b", isReady: false }]);
    expect(waitingRoomNotice(aloneNotReady, 2, GUEST)).toContain("more players");
  });

  it("names the other players when they are the ones missing", () => {
    const half = room([{ id: "h", isReady: false }, { id: "b", isReady: true }]);
    expect(waitingRoomNotice(half, 2, GUEST)).toContain("other players");
  });

  it("says nothing once the room is no longer waiting", () => {
    expect(waitingRoomNotice(room([{ id: "b", isReady: true }], "playing"), 1, GUEST)).toBeNull();
  });
});

describe("the waiting room actually renders it", () => {
  it("mounts the notice and reads the shared block for the host's tooltip", () => {
    /* THE HALF A RULES MODULE CANNOT PROVE. `waitingRoomNotice` returning the right sentence is worth
       nothing if nothing renders it -- and the tooltip is asserted to read `block` rather than re-deriving
       `enough`/`allReady`, which is what made the host's copy the only one for so long. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const room = fs.readFileSync(
      path.join(__dirname, "..", "components", "SandboxWaitingRoom.tsx"),
      "utf8",
    );
    expect(room).toContain("{notice && <span style={styles.notice}>{notice}</span>}");
    expect(room).toContain('block === "need-players"');
    expect(room).toContain('block === "need-ready"');
  });
});
