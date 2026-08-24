/** @jest-environment node */
//
// Which of the two names the chat shows. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 765 (harness): TWO NAMES, AND IT ASKED THE EMPTY ONE
// ==================================================================
//
// REPORTED: "in the chat box, rather than our display names, the log reads: '[8:41 AM]p-y1p43wnz hello'".
//
// `p-y1p43wnz` IS A LOCAL PLAYER ID, which tells you where to look: something asked for a name, got "", and
// fell back to the identifier. There are two names in this app and only one of them is ever set in a sandbox
// room -- `displayName` is the LOBBY name in local storage, and the roster NICKNAME is what the waiting room
// writes to the room document. A player who joins by code never touches the lobby field.
//
// THE ROSTER WAS ALREADY THE AUTHORITY EVERYWHERE ELSE. `SetupGame` maps `player.id` to `player.nickname`
// when it seeds the game, so the seat labels on the board have been correct all along; only the chat read a
// different field. That is the shape #734 and #741 both name -- two surfaces answering one question, and the
// one a player reads is the wrong one.
//
// SO THE TESTS ARE ABOUT `seatLabel`'S CONTRACT AND ABOUT WHO FEEDS IT. The function was never broken; it
// did exactly what it promises with the input it was given.

import { seatLabel, truncateAddress } from "./lobby";

describe("seatLabel prefers the name and falls back to the id", () => {
  it("uses the display name when there is one", () => {
    expect(seatLabel({ address: "p-y1p43wnz", displayName: "Bradshaw" })).toBe("Bradshaw");
  });

  it("falls back to the address when there is not", () => {
    /* THE REPORTED OUTPUT, reproduced. The function is behaving correctly -- a fallback is what it is for,
       and the bug was upstream, in what was handed to it. */
    expect(seatLabel({ address: "p-y1p43wnz", displayName: "" })).toBe(
      truncateAddress("p-y1p43wnz"),
    );
  });

  it("treats whitespace as no name at all", () => {
    // Otherwise a player who typed a space would be labelled with an invisible string.
    expect(seatLabel({ address: "p-y1p43wnz", displayName: "   " })).toBe(
      truncateAddress("p-y1p43wnz"),
    );
  });

  it("leaves a short local id intact", () => {
    /* `truncateAddress` only shortens past fourteen characters, which is why the report shows the id in FULL
       rather than as `p-y1p43...wnz`. Worth pinning: it is the detail that identifies the value as a local
       player id rather than a wallet. */
    expect(truncateAddress("p-y1p43wnz")).toBe("p-y1p43wnz");
    expect(truncateAddress("juno1abcdefghijklmnop")).toContain("...");
  });
});

describe("the chat is handed the roster nickname in a sandbox room", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    // #490a: the notes quote the old expression and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("resolves the name from the room roster", () => {
    const app = read("App.tsx");
    expect(app).toContain("const sandboxChatName =");
    expect(app).toContain("sandboxRoom?.players?.find((player) => player.id === localId)?.nickname");
  });

  it("still uses the lobby name outside a sandbox room", () => {
    /* A chain room has no roster nickname and the lobby name is right there -- so the fallback is not a
       degraded answer, it is the correct one for that mode. */
    expect(read("App.tsx")).toContain("?? displayName");
  });

  it("passes it to the chat hook rather than the lobby field", () => {
    expect(read("App.tsx")).toContain("sandboxChatName,");
  });

  it("declares the room state above the chat hook", () => {
    /* #762, one report ago: the chat hook's arguments are evaluated during render, so reading `sandboxRoom`
       from six hundred lines below would be a temporal dead zone -- the fault that white-screened the game.
       `tsc` catches the direct form, which is the only reason this one was cheap; the memo form is what
       `memoDeadZone.test.ts` exists for. */
    const app = read("App.tsx");
    const declared = app.indexOf("const [sandboxRoom, setSandboxRoom]");
    const used = app.indexOf("const sandboxChatName =");
    expect(declared).toBeGreaterThan(-1);
    expect(used).toBeGreaterThan(declared);
  });
});

describe("the offline echo agrees with the delivered message", () => {
  const chat = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs
      .readFileSync(path.join(__dirname, "..", "components", "ChatBox.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  })();

  it("labels the optimistic line through seatLabel", () => {
    /* THE SECOND HALF OF THE SAME BUG, and one nobody had reported yet. The offline echo read
       `sender || name`, which prefers the ADDRESS -- so a message sent with no Firestore was labelled with an
       id even when a good name was in hand, and would have relabelled itself if it ever round-tripped. */
    expect(chat).toContain('seatLabel({ address: sender ?? "", displayName: name })');
  });

  it("no longer prefers the address", () => {
    expect(chat).not.toContain('author: sender || name || "You"');
  });

  it("still has a last resort", () => {
    // Offline with no wallet and no name is exactly the case this branch exists for.
    expect(chat).toContain('|| "You"');
  });

  it("is the same function the delivered message uses", () => {
    /* The point of the change: `decodeMessage` calls `seatLabel` too, so the two lines cannot disagree by
       construction rather than by both being maintained correctly. */
    expect(chat).toContain("author: seatLabel({ address, displayName })");
  });
});
