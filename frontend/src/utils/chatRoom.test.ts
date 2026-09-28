// frontend/src/utils/chatRoom.test.ts
//
// ==================================================================
//  DESIGN NOTE 644 (harness): WHERE A ROOM'S TRANSCRIPT LIVES
// ==================================================================
//
// REPORTED: "the Send button on the chatbox does not actually send a message.
// The chat log records 'No activity yet'."
//
// #1361a MOVED THE TRANSCRIPT TO THE GAME SERVER. It was a Firestore subcollection under whichever collection
// the room lived in (`games` or `sandbox_rooms`), and the path arithmetic was what this file pinned. There is
// no path now: a transcript hangs off a ROOM CODE on the socket that already carries the room's document, and
// the property that survives -- two rooms cannot see each other's messages, and the sandbox is not pointed at
// the lobby -- is stated against the transport below.

import { readStripped, readShell } from "./sourceScan";

describe("a game's transcript rides the game's room socket (design note #1361a; LIVE-2D: keyed by gameId)", () => {
  const CHAT = readStripped("components/ChatBox.tsx");
  const LINK = readStripped("utils/roomLink.ts");
  const APP = readShell();

  it("subscribes and sends through roomLink, keyed by the game alone", () => {
    expect(CHAT).toContain('import { roomLinkAvailable, sendChat, subscribeChat } from "../utils/roomLink";');
    expect(CHAT).toContain("subscribeChat(");
    /* LIVE-2D: the frame carries the game and the text -- never an author or a display name. The server signs
       the line with the seat it derives from the socket's principal. */
    expect(CHAT).toContain("sendChat(roomId, trimmed);");
    expect(CHAT).not.toMatch(/sendChat\([^)]*(sender|name)/);
    expect(CHAT).not.toContain("roomDocLink");
    expect(CHAT).not.toContain("firebase");
  });

  it("the link filters frames to the game it was asked about", () => {
    // Two games cannot see each other's messages: a `chat` frame for another game is dropped at the link.
    const chatCase = LINK.slice(LINK.indexOf('case "chat": {'), LINK.indexOf('case "presence": {'));
    expect(chatCase).toContain("if (chat.gameId !== channel.key) return;");
    expect(LINK).toContain('send(channel, { kind: "chat-send", gameId, text });');
  });

  it("a spectator is not offered Send, and a refusal is said in words", () => {
    /* OD-L2-4: spectators may not chat. The seat (`you.playerId`) decides only whether Send is worth offering. */
    expect(APP).toContain("sandbox ? (localId || null) : wallet.address,");
    expect(CHAT).toContain('if (code === "forbidden" || code === "not-seated") setError("Only seated players can chat at this table.");');
  });

  it("the sandbox's transcript hangs off the table's game id", () => {
    // #644's fix, restated: the shell passes the table, not a lobby room, and no collection name.
    expect(APP).toContain("} = useRoomChat(");
    expect(APP).toContain("sandbox ? sandboxRoomCode : roomId,");
    expect(APP).not.toContain("SANDBOX_ROOMS_COLLECTION");
  });
});
