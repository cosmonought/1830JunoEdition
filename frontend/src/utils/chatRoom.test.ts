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

import { readStripped } from "./sourceScan";

describe("a room's transcript rides the room-doc socket (design note #1361a)", () => {
  const CHAT = readStripped("components/ChatBox.tsx");
  const LINK = readStripped("utils/roomDocLink.ts");
  const APP = readStripped("App.tsx");

  it("subscribes and sends through roomDocLink, keyed by the room alone", () => {
    expect(CHAT).toContain('import { roomDocOnServer, sendChat, subscribeChat, type RoomChatEntry } from "../utils/roomDocLink";');
    expect(CHAT).toContain("subscribeChat(");
    expect(CHAT).toContain("sendChat(roomId, sender, trimmed, name);");
    expect(CHAT).not.toContain("firebase");
  });

  it("the link filters frames to the room it was asked about", () => {
    // Two rooms cannot see each other's messages: a `chat` frame for another room is dropped at the link.
    expect(LINK).toContain('return subscribeFrame<ChatFrame>(room, claim, "chat", (frame) => {');
    expect(LINK).toContain("if (frame.room === room) onChat(");
  });

  it("the sandbox's transcript hangs off the sandbox room code", () => {
    // #644's fix, restated: the shell passes the sandbox room, not a lobby room, and no collection name.
    expect(APP).toContain("} = useRoomChat(");
    expect(APP).toContain("sandbox ? sandboxRoomCode : roomId,");
    expect(APP).not.toContain("SANDBOX_ROOMS_COLLECTION");
  });
});
