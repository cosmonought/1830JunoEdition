/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1169 (harness): THE ONE WRITE FIRESTORE CANNOT COMPENSATE
// ==================================================================
//
// REPORTED first as "I can no longer set my name nor select a player color", then corrected to "I was able to
// set them, but there was considerable lag". The first report is what the second one FEELS like, which is why
// this is a fix and not an explanation.
//
// THE CAUSE IS A ONE-WORD DIFFERENCE between four writers on the same document. Three use `updateDoc`, which
// Firestore applies to the local cache and reports through `onSnapshot` BEFORE the server answers. One --
// `upsertSandboxPlayer`, behind nickname, colour AND ready -- uses `runTransaction`, which by definition
// reads from the server and so has nothing to apply locally. The host's variant toggles an inch away were
// instant the whole time. That contrast is the evidence, and this file asserts it stays true.
//
// THE TRANSACTION IS CORRECT (#541: a read-modify-write on a shared array) and is not touched, per the
// standing instruction that the backend waits for the audit. The echo is drawn in front of it instead.

export {};

const { readStripped, sliceBetween, readShell } = require("./sourceScan") as typeof import("./sourceScan");
const {
  applyPendingSeat,
  settledSeatKeys,
  dropSeatKeys,
  hasPendingSeat,
  PENDING_SEAT_BACKSTOP_MS,
} = require("./pendingSeat") as typeof import("./pendingSeat");

const APP = readShell();
const ROOM = readStripped("utils/sandboxRoom.ts");
const WAITING = readStripped("components/SandboxWaitingRoom.tsx");

/* LIVE-2D: the echo is drawn over the server's RoomView -- the only room the client holds. */
type Room = import("./roomProtocol").RoomView;

const room = (players: Room["players"]): Room =>
  ({
    gameId: "g_pendingseat01",
    code: "JUNO-7K4M-Q2ZP",
    hostId: "a",
    status: "waiting",
    lifecycle: "waiting",
    players,
  }) as Room;

const BASE = room([
  { id: "a", nickname: "B", isReady: false, color: "#d94f4f", online: true },
  { id: "b", nickname: "Rival", isReady: true, color: "#4f8fd9", online: true },
]);

describe("the difference that made three controls lag", () => {
  it("has no room writer left in the client at all (LIVE-2D)", () => {
    /* THE BUG THIS FILE WAS WRITTEN AGAINST WAS FIRESTORE'S: a `runTransaction` write is not echoed by the
       listener, so a control that read its own field back lagged a round trip. #1361b moved the room document to
       the game server; LIVE-2D deleted it. The client holds a RoomView and ASKS -- a named `room-op` the server
       authorizes -- so there is no writer, transactional or otherwise, to inherit the bug from. */
    expect(ROOM).not.toContain("runTransaction(");
    for (const gone of ["upsertSandboxPlayer", "writeRoomDoc", "markSandboxRoomPlaying", "hostSandboxRoom"]) {
      expect([gone, ROOM.includes(gone)]).toEqual([gone, false]);
      expect([gone, APP.includes(gone)]).toEqual([gone, false]);
    }
    expect(ROOM).toContain('import { roomOp } from "./roomLink";');
  });

  it("sends each seat control as the one op that changes only this principal's own seat", () => {
    /* The frame names no seat: the server derives it from the socket's principal. */
    expect(APP).toContain('runRoomOp({ type: "set-profile", nickname: named }, { busy: false })');
    expect(APP).toContain('runRoomOp({ type: "set-profile", color }, { busy: false })');
    expect(APP).toContain('runRoomOp({ type: "set-ready", ready: isReady }, { busy: false })');
  });

  it("takes the server's view as it comes, with nothing filtered out of it", () => {
    /* The view is pushed on every committed change; the echo covers the round trip, the view ends it. */
    const watch = sliceBetween(APP, "return watchRoom(sandboxRoomCode, {", "\n    });");
    expect(watch).toContain("setSandboxRoom(view);");
  });
});

describe("the echo says what is in flight", () => {
  it("applies a pending colour over the snapshot", () => {
    const shown = applyPendingSeat(BASE, "a", { color: "#3fae72" });
    expect(shown?.players[0].color).toBe("#3fae72");
  });

  it("treats a cleared colour as a choice, not an absence", () => {
    /* #569's clear: clicking your own swatch returns the seat to an assigned colour. A truthiness test would
       drop this and the ring would stay lit for a whole round trip after the player turned it off. */
    const shown = applyPendingSeat(BASE, "a", { color: null });
    expect(shown?.players[0].color).toBeUndefined();
    expect("color" in (shown as Room).players[0]).toBe(false);
  });

  it("touches only the local seat", () => {
    const shown = applyPendingSeat(BASE, "a", { nickname: "Bradshaw", isReady: true });
    expect(shown?.players[1]).toEqual(BASE.players[1]);
    expect(shown?.players[0].nickname).toBe("Bradshaw");
    expect(shown?.players[0].isReady).toBe(true);
  });

  it("keeps the roster's order, because #541 made that order mean something", () => {
    const shown = applyPendingSeat(BASE, "b", { isReady: false });
    expect(shown?.players.map((player) => player.id)).toEqual(["a", "b"]);
  });

  it("invents no seat for a player the room has not seated yet", () => {
    /* Before the auto-join write lands the local player really is absent, and drawing them in would show a
       roster the host cannot see -- a worse lie than the lag. */
    const shown = applyPendingSeat(BASE, "stranger", { nickname: "Ghost" });
    expect(shown).toBe(BASE);
  });

  it("returns the same object when there is nothing to say", () => {
    /* Identity, so a memo over this does not hand every downstream reader a new room each render. */
    expect(applyPendingSeat(BASE, "a", null)).toBe(BASE);
    expect(applyPendingSeat(BASE, "a", {})).toBe(BASE);
    expect(hasPendingSeat({})).toBe(false);
    expect(applyPendingSeat(null, "a", { nickname: "B" })).toBeNull();
  });
});

describe("the echo stops when the commit lands", () => {
  it("releases a field the snapshot has caught up with", () => {
    const landed = room([{ id: "a", nickname: "B", isReady: false, color: "#3fae72", online: true }]);
    expect(settledSeatKeys(landed, "a", { color: "#3fae72", isReady: true })).toEqual(["color"]);
  });

  it("holds a field the snapshot still disagrees with", () => {
    expect(settledSeatKeys(BASE, "a", { color: "#3fae72" })).toEqual([]);
  });

  it("counts a cleared colour as settled once the key is gone", () => {
    /* The write spreads `...(color ? { color } : {})`, so a cleared colour comes back ABSENT rather than
       null. Comparing the two shapes directly would hold this echo until the backstop killed it. */
    const landed = room([{ id: "a", nickname: "B", isReady: false, online: true }]);
    expect(settledSeatKeys(landed, "a", { color: null })).toEqual(["color"]);
  });

  it("collapses to one shape for 'nothing in flight'", () => {
    expect(dropSeatKeys({ color: "#3fae72" }, ["color"])).toBeNull();
    expect(dropSeatKeys({ color: "#3fae72", isReady: true }, ["color"])).toEqual({ isReady: true });
  });

  it("cannot outlive a plausible round trip", () => {
    /* LIVE-2D: an op the server refuses (or never answers) withdraws its echo at once; a dropped socket is the same
       silence from the seat's point of view, so the backstop stays. */
    /* Phase 3 W3-J (OD-19, AUD-25.16): a Watch tab sends no room op, so the callback also reads `watchOnly` -- the
       dependency list that closes it grew; the round trip it pins did not change. */
    const runRoomOp = sliceBetween(APP, "const runRoomOp = useCallback(", "[sayRoomRefusal, watchOnly, setSandboxRoomError],");
    expect(runRoomOp).toContain("if (!answer.ok) {");
    expect(runRoomOp).toContain("return false;");
    expect(PENDING_SEAT_BACKSTOP_MS).toBe(6000);
    expect(APP).toContain("setTimeout(() => setPendingSeat(null), PENDING_SEAT_BACKSTOP_MS)");
  });
});

describe("the shell draws one room, not a room and three opinions", () => {
  it("overlays once, where every reader is looking", () => {
    /* #891 is this codebase's most-repeated fault. A swatch holding a private idea of its own colour while
       the roster underneath shows another is that fault with a 400ms lifetime. */
    /* Phase 3 W3-J (OD-19, AUD-25.16): the server's view is the raw state, and `sandboxRoomDoc` is that view as this
       tab may present it -- a watcher's `you` in a Watch tab, the server's own otherwise. Still ONE room: the overlay
       is applied once, to that one document. */
    expect(APP).toContain("const [sandboxRoomServerView, setSandboxRoom] = useState<RoomView | null>(null);");
    expect(APP).toContain("watchOnly ? watcherRoomView(sandboxRoomServerView) : sandboxRoomServerView");
    expect(APP).toContain("applyPendingSeat(sandboxRoomDoc, localId, pendingSeat)");
  });

  it("settles against the raw snapshot rather than the overlay", () => {
    /* Comparing the echo against itself settles every field on the first pass and echoes nothing -- the bug
       that turns this whole file into decoration. */
    expect(APP).toContain("settledSeatKeys(sandboxRoomDoc, localId, pendingSeat)");
    expect(APP).not.toContain("settledSeatKeys(sandboxRoom,");
  });

  it("keeps no second copy of the room for a forced-sign tool that is gone (LIVE-2D)", () => {
    /* The ref existed for the forced-sign debug flag, which lived on the deleted room document. */
    expect(APP).not.toContain("sandboxRoomDocRef");
  });

  it("marks all three seat writes pending, and unmarks them if the write fails", () => {
    /* All three had the same silence -- including Ready, which gates Start. LIVE-2D: an op resolves `false` on a
       refusal (never rejects), so the echo is withdrawn on that answer rather than on a thrown write. */
    for (const field of ["nickname: named", "color", "isReady"]) {
      expect([field, APP.includes(`setPendingSeat((current) => ({ ...current, ${field} }))`)]).toEqual([
        field,
        true,
      ]);
    }
    for (const key of ["nickname", "color", "isReady"]) {
      expect([key, APP.includes(`if (!ok) setPendingSeat((current) => dropSeatKeys(current, ["${key}"]));`)]).toEqual([key, true]);
    }
  });
});

describe("the nickname field is gone (PLAY WAITING ROOM, handoff §6, §16)", () => {
  it("names the seat by the account's profile name, with no field to seed or type over", () => {
    /* The design has no name field: a seat's name is the profile name (`create` and `take-seat` seed it on the
       server), so #764's seeding problem has no field left to happen in. */
    for (const gone of ["nicknameText", "setNicknameTouched", "knownNickname", "onSetNickname("]) {
      expect([gone, WAITING.includes(gone)]).toEqual([gone, false]);
    }
    expect(WAITING).toContain("const nameOf = (player: { nickname: string }) => player.nickname || \"A player\";");
  });
});
