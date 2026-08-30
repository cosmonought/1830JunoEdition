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
//
// ==================================================================
//  DESIGN NOTE 477 (harness): AND THE CLOCK LEADS IT
// ==================================================================
//
// The exact-string expectations below CHANGED with design note #477 rather
// than being added to, because the format changed: every line now opens
// `[hh:mm] `. That is worth flagging rather than quietly editing -- a test
// whose expected value is edited to match new output is usually a test that
// stopped guarding anything. These were edited deliberately, and the
// `describe("clock prefix")` block below is what now holds the new contract
// in place.

import { clockPrefix, feedItemText } from "./TopTicker";
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
      "[12:00] [OR 1] Private Revenue — Schuylkill Valley pays $5 to Alice",
    );
  });

  it("leads with the clock, then the round, then the sentence", () => {
    // The universal format: `[hh:mm] [Phase/Round] [Actor] [Action]`.
    expect(feedItemText(logItem())).toMatch(/^\[12:00\] \[OR 1\] /);
  });

  it("omits the round prefix entirely when there is no round", () => {
    // Not "[] ", and not "[undefined] ". The clock still leads.
    expect(feedItemText(logItem({ logRound: undefined }))).toBe(
      "[12:00] Private Revenue — Schuylkill Valley pays $5 to Alice",
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
      "[12:00] [OR 1] Failed: Private Revenue — Schuylkill Valley pays $5 to Alice",
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
    /* Design note #477: a chat line takes the same gutter, so the log rows
       and the chat rows it interleaves with line up on one left edge.
       Design note #1011: AND NO QUOTATION MARKS. This pinned them, so it failed when they were removed --
       correctly, which is what a harness is for. The gutter is the claim this case was written to make and it
       is unchanged; the delimiter was never carrying information the colon does not. */
    expect(feedItemText(chat)).toBe("[12:00] Alice: taking the D&H");
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

describe("clock prefix", () => {
  it("drops the seconds a locale time string carries", () => {
    // `toLocaleTimeString()` gives hh:mm:ss. Three characters of precision
    // nobody wants about a board game, and enough width to unbalance a
    // gutter that is only useful because it is a fixed width.
    expect(clockPrefix(logItem({ timestampLabel: "09:07:42" }))).toBe("[09:07] ");
  });

  it("keeps a 12-hour suffix", () => {
    // Trimming seconds must not trim the am/pm that follows them.
    expect(clockPrefix(logItem({ timestampLabel: "2:32:07 PM" }))).toBe("[2:32 PM] ");
  });

  it("leaves a label that already lacks seconds alone", () => {
    expect(clockPrefix(logItem({ timestampLabel: "14:32" }))).toBe("[14:32] ");
  });

  it("passes an unrecognised label through whole rather than dropping it", () => {
    // A locale this regex does not anticipate costs a slightly wider gutter.
    // Emitting nothing, or "[Invalid Date]", would cost more.
    expect(clockPrefix(logItem({ timestampLabel: "午後2:32:07" }))).toBe("[午後2:32:07] ");
  });

  it("emits nothing at all for an item with no timestamp label", () => {
    // Not "[] ", and not "[undefined] ".
    expect(clockPrefix(logItem({ timestampLabel: "" }))).toBe("");
  });

  it("is what every surface leads with, not something the ticker adds", () => {
    // The three surfaces share `feedItemText` (design note #425), so the
    // prefix has to live inside it rather than in one caller.
    const item = logItem({ timestampLabel: "08:05:00" });
    expect(feedItemText(item).startsWith(clockPrefix(item))).toBe(true);
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
