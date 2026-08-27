/** @jest-environment node */
//
// The screen shown between pressing Join and hearing from the room. Source-level; no React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 764 (harness): A DEFAULT IS AN ANSWER
// ==================================================================
//
// REPORTED: "When players enter the room key and hit 'Join Game' it briefly takes them to the Auction round
// screen before flashing back to the waiting lobby."
//
// ONE VALUE WAS CARRYING TWO MEANINGS. `sandboxRoom` is `SandboxRoomDoc | null`, and `null` meant both "there
// is no such room" and "the first snapshot has not arrived". Those want opposite screens -- an error and a
// wait -- and the waiting-room gate read `sandboxRoom?.status === "waiting"`, which is false for both. So for
// one round trip the app fell through to the board and rendered its seeded state, which is a Waterfall
// Auction: a screen from the middle of a game the player has not started.
//
// THE FLASH IS THE APP ANSWERING A QUESTION IT DID NOT HAVE THE DATA FOR, and the fix is a third state rather
// than a longer condition. This is the same shape as #134's `tokenCityIndex`, which keeps `undefined`
// distinct from `0` because "I do not know" and "city zero" send the caller to different places -- and as
// #741's hex value, where two surfaces answered one question differently. A boolean that cannot say "not
// yet" will be read as "no".
//
// A SOURCE SCAN, and it says so. The thing being asserted is the ORDER and CONDITION of three early returns
// inside a six-thousand-line component; there is no exported predicate to call and no DOM in a node
// environment. Same instrument as `stationVeil.test.ts`, for the same reason.

import fs from "fs";
import path from "path";

const APP = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
/** #490a: the note quotes the old gate verbatim and must keep doing so. */
const CODE = APP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("joining holds until the room answers", () => {
  it("tracks whether the first snapshot has arrived", () => {
    /* THE THIRD STATE. Without it there is nothing to distinguish "no such room" from "have not heard yet",
       and every gate downstream has to guess. */
    expect(CODE).toContain("const [sandboxRoomResolved, setSandboxRoomResolved] = useState(false)");
    expect(CODE).toContain("setSandboxRoomResolved(true)");
  });

  it("resets when the room code changes", () => {
    /* Joining a second room must go back to not-knowing. Keyed on the CODE rather than on the doc, because
       the doc for the new room is exactly the thing that has not arrived yet -- waiting for it to change
       would be waiting for the answer to decide whether to wait for the answer. */
    expect(CODE).toMatch(/setSandboxRoomResolved\(false\);\s*\}, \[sandboxRoomCode\]\)/);
  });

  it("shows a joining screen while unresolved", () => {
    expect(CODE).toContain("if (sandbox && sandboxRoomCode && !sandboxRoomResolved) {");
    expect(CODE).toContain("Joining {sandboxRoomCode}");
  });

  it("puts that gate BEFORE the waiting-room gate", () => {
    /* ORDER IS THE FIX. Both conditions can be false at once -- that is the whole bug -- so the unresolved
       check has to come first or the fall-through still reaches the board. */
    const unresolved = CODE.indexOf("!sandboxRoomResolved");
    const waiting = CODE.indexOf('sandboxRoom?.status === "waiting"');
    expect(unresolved).toBeGreaterThan(-1);
    expect(waiting).toBeGreaterThan(-1);
    expect(unresolved).toBeLessThan(waiting);
  });

  it("offers a way out of the wait", () => {
    /* A screen with no exit is how a wrong room code becomes a stuck tab. Cancel leaves the room, which is
       the same handler the room bar uses. */
    const gate = CODE.slice(CODE.indexOf("!sandboxRoomResolved"), CODE.indexOf('sandboxRoom?.status === "waiting"'));
    expect(gate).toContain("handleLeaveSandboxRoom");
  });
});

describe("the waiting room still works the way it did", () => {
  it("keeps its own condition", () => {
    // #764 adds a gate ahead of this one; it must not have changed what this one asks.
    expect(CODE).toContain('if (sandbox && sandboxRoomCode && sandboxRoom?.status === "waiting") {');
  });

  it("still starts the room doc at null", () => {
    /* The resolved flag is ADDITIONAL, not a replacement. `null` remains the right value for "no such room",
       which is a real state a bad code produces and which the waiting-room gate correctly declines. */
    expect(CODE).toContain("useState<SandboxRoomDoc | null>(null)");
  });
});

// ==================================================================
//  DESIGN NOTE 856 (harness): JOINING A ROOM DID NOT PUT YOU IN IT
// ==================================================================
//
// REPORTED: "When I Host Game and a player joins, it does not update on my screen until/unless I refresh the
// page" -- and then, decisively: "the joiner sees the host, but the host doesn't see joiners."
//
// THE ASYMMETRY WAS THE DIAGNOSIS. `hostSandboxRoom` writes the host into the room document, so a joiner's
// FIRST snapshot already contains them; that is why the joiner's screen looked right and the listeners looked
// healthy. The join path wrote nothing. `upsertSandboxPlayer` had three callers, every one of them a
// waiting-room control -- nickname, colour, Ready -- so an untouched joiner was not in the document and the
// host's listener had nothing to fire on.
//
// IT LOOKED LIKE LAG because the delay is however long the joiner takes to type a name. It is not, and it was
// not a regression either: `git log -S` finds three commits, all ADDING call sites, none in the join path.
//
// THIS FILE, because #764 is the other half of the same screen: that note made joining WAIT for the room to
// answer, and this one makes the room have something to say.

describe("joining a room seats you in it (design note #856)", () => {
  it("writes the local player when the roster does not have them", () => {
    expect(CODE).toContain("void upsertSandboxPlayer(sandboxRoomCode, {");
    expect(CODE).toContain("sandboxRoom.players.some((player) => player.id === localId)");
  });

  it("waits for the first snapshot before deciding they are absent", () => {
    /* #764's third state, reused: `null` means both "no such room" and "have not heard yet", and writing a
       seat into the second one would be answering a question nobody has asked yet. */
    expect(CODE).toContain("if (!sandboxRoomResolved || !sandboxRoom) return;");
  });

  it("claims the room through a ref so the write cannot loop", () => {
    /* `upsertSandboxPlayer` is a read-modify-write transaction and this effect depends on the roster it
       writes. Without the guard, every snapshot triggers another write, which triggers another snapshot. */
    expect(CODE).toContain("const seatedRoomRef = useRef<string | null>(null);");
    expect(CODE).toContain("if (seatedRoomRef.current === sandboxRoomCode) return;");
  });

  it("claims the room for someone already seated, rather than rewriting them", () => {
    /* THE HOST'S CASE, and a rejoin. Writing over an existing entry would reset a nickname and a colour the
       player had already chosen -- #569's rule that the upsert REPLACES, so a field left out is erased. */
    const effect = CODE.slice(
      CODE.indexOf("const seatedRoomRef"),
      CODE.indexOf("const replayingRef"),
    );
    expect(effect.length).toBeGreaterThan(0);
    const guard = effect.indexOf("players.some((player) => player.id === localId)");
    const write = effect.indexOf("void upsertSandboxPlayer");
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(guard);
  });

  it("re-arms when the room code changes", () => {
    // Leaving and joining a second room must seat you there too.
    expect(CODE).toContain("seatedRoomRef.current = null;");
  });
});
