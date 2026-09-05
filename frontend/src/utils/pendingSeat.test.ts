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

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const {
  applyPendingSeat,
  settledSeatKeys,
  dropSeatKeys,
  hasPendingSeat,
  PENDING_SEAT_BACKSTOP_MS,
} = require("./pendingSeat") as typeof import("./pendingSeat");

const APP = readStripped("App.tsx");
const ROOM = readStripped("utils/sandboxRoom.ts");
const WAITING = readStripped("components/SandboxWaitingRoom.tsx");

type Room = import("./sandboxRoom").SandboxRoomDoc;

const room = (players: Room["players"]): Room =>
  ({
    code: "JUNO-4T2",
    hostId: "a",
    status: "waiting",
    players,
  }) as Room;

const BASE = room([
  { id: "a", nickname: "B", isReady: false, color: "#d94f4f" },
  { id: "b", nickname: "Rival", isReady: true, color: "#4f8fd9" },
]);

describe("the difference that made three controls lag", () => {
  it("still has exactly one transactional writer on the room document", () => {
    /* IF A FUTURE WRITER REACHES FOR `runTransaction` for a field a control reads back, it inherits this bug
       silently -- no error, just a control that stops answering. This is the tripwire for that. */
    const transactional = ROOM.split("runTransaction(db").length - 1;
    expect(transactional).toBe(2); // the seat upsert, and #522's log append
    expect(sliceBetween(ROOM, "export async function upsertSandboxPlayer(", "\n}")).toContain(
      "runTransaction(db",
    );
  });

  it("leaves the compensated writers compensated", () => {
    /* The proof that this was never "rooms are slow": three writers to the SAME document through the SAME
       listener were always instant. */
    for (const fn of [
      "setSandboxRoomVariants",
      "setSandboxForcedSign",
      "markSandboxRoomPlaying",
    ]) {
      const body = sliceBetween(ROOM, `export async function ${fn}(`, "\n}");
      expect([fn, body.includes("updateDoc(")]).toEqual([fn, true]);
      expect([fn, body.includes("runTransaction")]).toEqual([fn, false]);
    }
  });

  it("does not opt the room listener out of latency compensation", () => {
    /* `includeMetadataChanges` / a `hasPendingWrites` filter here would break the echo for the three writers
       that still have one, and would make this diagnosis wrong in a way nothing else would catch. */
    const sub = sliceBetween(ROOM, "export function subscribeSandboxRoom(", "\n}");
    expect(sub).not.toContain("hasPendingWrites");
    expect(sub).not.toContain("includeMetadataChanges");
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
    const landed = room([{ id: "a", nickname: "B", isReady: false, color: "#3fae72" }]);
    expect(settledSeatKeys(landed, "a", { color: "#3fae72", isReady: true })).toEqual(["color"]);
  });

  it("holds a field the snapshot still disagrees with", () => {
    expect(settledSeatKeys(BASE, "a", { color: "#3fae72" })).toEqual([]);
  });

  it("counts a cleared colour as settled once the key is gone", () => {
    /* The write spreads `...(color ? { color } : {})`, so a cleared colour comes back ABSENT rather than
       null. Comparing the two shapes directly would hold this echo until the backstop killed it. */
    const landed = room([{ id: "a", nickname: "B", isReady: false }]);
    expect(settledSeatKeys(landed, "a", { color: null })).toEqual(["color"]);
  });

  it("collapses to one shape for 'nothing in flight'", () => {
    expect(dropSeatKeys({ color: "#3fae72" }, ["color"])).toBeNull();
    expect(dropSeatKeys({ color: "#3fae72", isReady: true }, ["color"])).toEqual({ isReady: true });
  });

  it("cannot outlive a plausible round trip", () => {
    /* `upsertSandboxPlayer` returns `true` when the room is MISSING -- it opens a transaction, finds nothing
       and returns without writing -- so a "successful" write can leave a field no snapshot will ever settle. */
    expect(sliceBetween(ROOM, "export async function upsertSandboxPlayer(", "\n}")).toContain(
      "if (!snapshot.exists()) return;",
    );
    expect(PENDING_SEAT_BACKSTOP_MS).toBe(6000);
    expect(APP).toContain("setTimeout(() => setPendingSeat(null), PENDING_SEAT_BACKSTOP_MS)");
  });
});

describe("the shell draws one room, not a room and three opinions", () => {
  it("overlays once, where every reader is looking", () => {
    /* #891 is this codebase's most-repeated fault. A swatch holding a private idea of its own colour while
       the roster underneath shows another is that fault with a 400ms lifetime. */
    expect(APP).toContain("const [sandboxRoomDoc, setSandboxRoom] = useState<SandboxRoomDoc | null>(null);");
    expect(APP).toContain("applyPendingSeat(sandboxRoomDoc, localId, pendingSeat)");
  });

  it("settles against the raw snapshot rather than the overlay", () => {
    /* Comparing the echo against itself settles every field on the first pass and echoes nothing -- the bug
       that turns this whole file into decoration. */
    expect(APP).toContain("settledSeatKeys(sandboxRoomDoc, localId, pendingSeat)");
    expect(APP).not.toContain("settledSeatKeys(sandboxRoom,");
  });

  it("keeps the forced-sign ref on the server's copy", () => {
    /* Its readers want a flag OTHER clients write; the seat overlay is noise to them. */
    expect(APP).toContain("sandboxRoomDocRef.current = sandboxRoomDoc;");
  });

  it("marks all three seat writes pending, and unmarks them if the write fails", () => {
    /* All three go through the one transactional writer, so all three had the same silence -- including
       Ready, which gates Start. */
    for (const field of ["nickname: named", "color", "isReady"]) {
      expect([field, APP.includes(`setPendingSeat((current) => ({ ...current, ${field} }))`)]).toEqual([
        field,
        true,
      ]);
    }
    for (const key of ["nickname", "color", "isReady"]) {
      expect([key, APP.includes(`.catch(() => setPendingSeat((current) => dropSeatKeys(current, ["${key}"])))`)]).toEqual([key, true]);
    }
  });
});

describe("the nickname field fills in from a snapshot it cannot have on mount", () => {
  it("seeds from the seat rather than only from the initialiser", () => {
    /* `useState(x)` reads `x` once, and on the mount there is no seat yet (#764). The box opened empty for a
       player who already had a name. */
    expect(WAITING).toContain("if (nicknameTouched || knownNickname === \"\") return;");
    expect(WAITING).toContain("setNicknameText(knownNickname);");
  });

  it("never seeds over typing", () => {
    /* Including a deliberate clear, which is why this is a `touched` flag and not an emptiness test. */
    expect(WAITING).toContain("setNicknameTouched(true);");
  });
});
