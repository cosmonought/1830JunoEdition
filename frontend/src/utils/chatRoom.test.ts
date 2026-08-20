// frontend/src/utils/chatRoom.test.ts
//
// ==================================================================
//  DESIGN NOTE 644 (harness): WHERE A ROOM'S TRANSCRIPT LIVES
// ==================================================================
//
// REPORTED: "the Send button on the chatbox does not actually send a message.
// The chat log records 'No activity yet'."
//
// The behavioural half of that fix is inside a React hook and needs a
// renderer to exercise; what is testable without one -- and what would
// silently break the fix -- is the path arithmetic. Sandbox rooms and lobby
// rooms are different Firestore collections, and pointing sandbox chat at the
// lobby's would write a transcript nobody reads into a collection the lobby
// lists.

import { chatCollectionPath } from "./lobby";
import { SANDBOX_ROOMS_COLLECTION } from "./sandboxRoom";

describe("chatCollectionPath", () => {
  it("defaults to the lobby's rooms, so existing callers are unchanged", () => {
    const [collection, room, sub] = chatCollectionPath("ABCD");
    expect(collection).toBe("games");
    expect(room).toBe("ABCD");
    expect(sub).toBe("chat");
  });

  it("puts a sandbox room's transcript in the sandbox collection", () => {
    /* Design note #644: the same shape, a different collection. A sandbox
       room is not a lobby room, and its chat hangs off the document that
       already holds its action log. */
    const [collection, room, sub] = chatCollectionPath("WXYZ", SANDBOX_ROOMS_COLLECTION);
    expect(collection).toBe("sandbox_rooms");
    expect(room).toBe("WXYZ");
    expect(sub).toBe("chat");
  });

  it("keeps the transcript beside the room rather than under a shared root", () => {
    /* The property the function exists to guarantee: chat is a SUBCOLLECTION
       of one room. Two rooms cannot see each other's messages, which is what
       makes the staging-room transcript continue into the live game without
       leaking into anybody else's. */
    const lobby = chatCollectionPath("ROOM1");
    const other = chatCollectionPath("ROOM2");
    expect(lobby[1]).not.toBe(other[1]);
    expect(lobby[0]).toBe(other[0]);
    expect(lobby[2]).toBe(other[2]);
  });
});
