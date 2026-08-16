// frontend/src/components/feedItemText.test.ts
//
// ==================================================================
//  DESIGN NOTE 425 (harness): ONE STRING, AND NO PICTURES IN IT
// ==================================================================
//
// Two requirements are being pinned here, and they are easy to regress
// independently.
//
// THE TICKER AND THE HISTORY MUST AGREE. They previously did not, because
// each built its own sentence out of the same fields. Now both call
// `feedItemText`, so agreement is structural -- and the test that keeps it
// that way is the one asserting the exact string for the requirement's own
// worked example.
//
// NO EMOJI, EVER. This is asserted with a Unicode property escape rather
// than by listing the glyphs that used to be here, because the failure mode
// is somebody adding a NEW one. A test that checked for "🟢" specifically
// would pass the moment a different emoji was introduced, which is exactly
// when it should fail.

import { feedItemText } from "./TopTicker";
import type { FeedItem } from "../utils/feed";

function logItem(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "1",
    kind: "log",
    timestampMs: 0,
    timestampLabel: "12:00:00",
    logLabel: "Private Revenue — Schuylkill Valley pays $5 to Alice",
    logStatus: "success",
    logRound: "OR 1",
    ...over,
  } as FeedItem;
}

/** Any pictographic character, however new. See the note above on why this
 *  is a property escape and not a list of the glyphs we removed. */
const EMOJI = /\p{Extended_Pictographic}/u;

describe("feedItemText", () => {
  it("renders the requirement's worked example verbatim", () => {
    expect(feedItemText(logItem())).toBe(
      "[OR 1] Private Revenue — Schuylkill Valley pays $5 to Alice",
    );
  });

  it("leads with the round prefix and nothing else", () => {
    expect(feedItemText(logItem())).toMatch(/^\[OR 1\] /);
  });

  it("omits the prefix entirely when there is no round", () => {
    // Not "[] ", and not "[undefined] ".
    expect(feedItemText(logItem({ logRound: undefined }))).toBe(
      "Private Revenue — Schuylkill Valley pays $5 to Alice",
    );
  });

  it("appends the full detail rather than a truncated preview", () => {
    // The old ticker dropped `logDetail` entirely past 40 characters, so the
    // expanded view showed a sentence the ticker never had.
    const long = "a".repeat(120);
    expect(feedItemText(logItem({ logDetail: long }))).toContain(` — ${long}`);
  });

  it("marks a failure in words", () => {
    expect(feedItemText(logItem({ logStatus: "error" }))).toBe(
      "[OR 1] Failed: Private Revenue — Schuylkill Valley pays $5 to Alice",
    );
  });

  it("does not mark the ordinary statuses at all", () => {
    // Success is the overwhelming majority of a log; tagging it would put a
    // near-constant word on every line, which is what the green circle was.
    for (const status of ["success", "pending", "info"] as const) {
      expect(feedItemText(logItem({ logStatus: status }))).not.toContain("Failed");
    }
  });

  it("renders a chat line without the speech-bubble glyph", () => {
    const chat = {
      id: "2",
      kind: "chat",
      timestampMs: 0,
      timestampLabel: "12:00:00",
      chatAuthor: "Alice",
      chatText: "taking the D&H",
    } as FeedItem;
    expect(feedItemText(chat)).toBe('Alice: "taking the D&H"');
  });

  it("emits no emoji for any status, round or detail combination", () => {
    for (const status of ["success", "error", "pending", "info"] as const) {
      for (const round of ["OR 1", "SR 2", undefined]) {
        const text = feedItemText(logItem({ logStatus: status, logRound: round, logDetail: "x" }));
        expect(text).not.toMatch(EMOJI);
      }
    }
  });
});

describe("the removed badge helpers", () => {
  it("no longer exist on the feed module", async () => {
    // Design note #425 deleted them rather than leaving them uncalled. If
    // they come back, the badges are one import away from returning with
    // them.
    const feed = await import("../utils/feed");
    expect("iconForLogEntry" in feed).toBe(false);
    expect("iconForLogStatus" in feed).toBe(false);
  });
});
