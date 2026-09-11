/** @jest-environment node */
//
// Design note #1341 (harness): the seat PIN -- what it is, where it never goes, and what it gates.

import { readFileSync } from "fs";
import { join } from "path";

import { isValidSeatPin, SEAT_SUPERSEDED_CODE } from "./seatPin";
import { readStripped } from "./sourceScan";

const SERVER = readFileSync(join(__dirname, "..", "..", "..", "server", "src", "gameServer.ts"), "utf8");

describe("a seat PIN is four digits", () => {
  it("accepts exactly four digits and nothing else", () => {
    expect(isValidSeatPin("0000")).toBe(true);
    expect(isValidSeatPin("1234")).toBe(true);
    for (const bad of ["123", "12345", "12a4", " 1234", "", null, undefined, 1234]) {
      expect(isValidSeatPin(bad)).toBe(false);
    }
  });

  it("is checked by the same rule on the server", () => {
    expect(SERVER).toContain('typeof pin === "string" && /^[0-9]{4}$/.test(pin)');
  });
});

describe("the PIN never leaves the server; the seat knows only that it has one", () => {
  it("strips seatPins from every document on the wire and stamps hasPin", () => {
    expect(SERVER).toContain("const { seatPins, ...rest } = doc;");
    expect(SERVER).toContain("hasPin: Boolean(seatPins?.[player.id])");
    // Both places a document reaches a socket go through publicDoc.
    expect(SERVER).toContain("const doc = publicDoc(roomDocs.get(code) ?? null);");
    expect(SERVER).toContain("doc: publicDoc(await roomDocFor(frame.room)),");
  });

  it("gates both hellos on the PIN and the session token", () => {
    expect((SERVER.match(/await seatRefusal\(frame\.room, actor, frame\.pin, frame\.token\)/g) ?? []).length).toBe(2);
    expect(SERVER).toContain(`const SEAT_SUPERSEDED_CODE = "${SEAT_SUPERSEDED_CODE}";`);
  });

  /* #1341a REPLACED THE REFUSAL THIS USED TO PIN. "A seat without a PIN cannot be claimed" is right for
     every room made after #1341 and wrong for every room made before it -- including the one it shipped
     into, whose seats were all unPINned and whose players were therefore locked out of their own seats the
     moment they changed device. The rule now migrates a seat at the moment somebody needs it migrated. */
  it("lets an unPINned seat adopt the PIN it is offered (#1341a)", () => {
    expect(SERVER).not.toContain("so it cannot be rejoined from another device yet.");
    expect(SERVER).toContain("seatPins: { ...pins, [seatFrame.playerId]: frame.pin },");
  });

  it("and demands that PIN of every device after it", () => {
    expect(SERVER).toContain("} else if (required !== frame.pin) {");
    expect(SERVER).toContain('answer(false, "Wrong PIN for that seat.");');
  });

  it("still lets only a seat's own player set its own PIN", () => {
    expect(SERVER).toContain('answer(false, "Only the seat\'s own player may set its PIN.");');
  });

  it("supersedes the old device's log sockets on a successful claim", () => {
    expect(SERVER).toContain("attached.room === seatFrame.room && attached.actor === seatFrame.playerId && other !== socket");
    expect(SERVER).toContain("code: SEAT_SUPERSEDED_CODE,");
  });
});

describe("the clients answer the superseded code by forgetting the seat", () => {
  it("in both links, and both hellos carry the PIN and token", () => {
    const ROOM = readStripped("utils/roomDocLink.ts");
    const LINK = readStripped("utils/serverLink.ts");
    expect(ROOM).toContain("forgetSeat(room);");
    expect(LINK).toContain("forgetSeat(options.room);");
    expect(ROOM).toContain("pin: readSeatPin(room) ?? undefined,");
    expect(ROOM).toContain("token: readSeatToken(room) ?? undefined,");
    /* #1364: read at every hello through `seat`, with the static pair as the fallback -- a PIN set after
       the link opened must be what the next hello carries, or the reconnect is refused. */
    expect(LINK).toContain("const seat = options.seat?.() ?? {};");
    expect(LINK).toContain("pin: seat.pin ?? options.pin,");
    expect(LINK).toContain("token: seat.token ?? options.token,");
    const APP = readStripped("App.tsx");
    expect(APP).toContain("pin: readSeatPin(sandboxRoomCode) ?? undefined,");
    expect(APP).toContain("token: readSeatToken(sandboxRoomCode) ?? undefined,");
    expect(APP).toContain("seat: () => ({"); // #1364: and again on every reconnect
  });

  it("keeps the shell's share to one state, two buttons and one mount", () => {
    const APP = readStripped("App.tsx");
    expect((APP.match(/<SeatPinModal/g) ?? []).length).toBe(1); // one mount
    /* #1341a: A MODE, NOT A FLAG, because the shell opens this card two ways now. Setting a PIN used to be
       reachable only from the waiting-room roster -- a screen nobody can get back to once the game has
       started -- so a player who wanted to lock their seat mid-game was offered the rejoin card and nothing
       else, and rejoining is the one thing that cannot set your own PIN: the card lists every seat but
       yours. The button was missing rather than hidden. */
    expect(APP).toContain('const [seatPinMode, setSeatPinMode] = useState<"set" | "rejoin" | null>(null);');
    expect(APP).toContain("Set my PIN");
    expect(APP).toContain("Rejoin a seat");
    expect(APP).not.toContain("claimSeat(");
    expect(APP).not.toContain("setSeatPin(");
  });

  it("says, on the card, that the PIN is for this room only", () => {
    const MODAL = readStripped("components/SeatPinModal.tsx");
    expect(MODAL).toContain("The PIN is only for room {roomCode}.");
    expect(MODAL).toContain("It is not an account and unlocks nothing else.");
  });
});

describe("a superseded tab lands on the lobby (design note #1358)", () => {
  it("forgets the resume keys along with the seat, by the same literals activeGame.ts exports", () => {
    const PIN = readStripped("utils/seatPin.ts");
    const ACTIVE = readStripped("utils/activeGame.ts");
    for (const key of ["18cosmos.active_game.v1", "juno.activeSandboxRoom"]) {
      expect(PIN).toContain(`window.sessionStorage.removeItem("${key}");`);
      expect(ACTIVE).toContain(`"${key}"`);
    }
  });
});

describe("the lobby's cards can be clicked (design note #1360)", () => {
  it("mounts both cards outside the scene layer, after it closes and before the content column", () => {
    const LOBBY = readStripped("components/Lobby.tsx");
    const sceneOpens = LOBBY.indexOf("<div style={styles.sceneClip}");
    const content = LOBBY.indexOf("<div style={styles.content}>");
    for (const mount of ["<RejoinByPinCard", "<SeatPinModal"]) {
      const at = LOBBY.indexOf(mount);
      expect(at).toBeGreaterThan(sceneOpens);
      expect(at).toBeLessThan(content);
      // Inside the scene it would inherit `pointerEvents: "none"` from `sceneClip`.
      const between = LOBBY.slice(sceneOpens, at);
      expect(between.lastIndexOf("</div>")).toBeGreaterThan(-1);
    }
    expect(readStripped("components/RejoinByPinCard.tsx")).toContain('pointerEvents: "auto"');
    expect(readStripped("components/SeatPinModal.tsx")).toContain('pointerEvents: "auto"');
  });
});

describe("a refresh finds the room the shell is in (design note #1373)", () => {
  it("both copies of the room code are written to the session under the one key", () => {
    const APP = readStripped("App.tsx");
    const writes = APP.match(/useEffect\(\(\) => \{\s*writeActiveSandboxRoom\(sandboxRoomCode\);\s*\}, \[sandboxRoomCode\]\);/g) ?? [];
    expect(writes.length).toBe(2); // the root's (#551) and the shell's (#1373)
  });
});
