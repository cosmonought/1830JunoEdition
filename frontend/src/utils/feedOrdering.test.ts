// frontend/src/utils/feedOrdering.test.ts
//
// ==================================================================
//  DESIGN NOTE 668 (harness): A WALL CLOCK IS NOT AN ORDER
// ==================================================================
//
// REPORTED: "The Activity Log is printing wildly out of order. During OR 2.2
// the log suddenly prints a massive backlog of events from setup -- 'Game dealt
// for 2 players', 'Host won Mohawk & Hudson', 'B&O floated'."
//
// Nothing was buffering them. They were replayed, correctly and in order, by a
// rebuild after an undo -- and then SORTED into the wrong place, because
// `mergeFeedItems` sorted on `timestampMs` alone.
//
// Two stamps feed that field and they disagreed. #643 gave a replayed ACTION
// the log entry's own `createdAt`, so those landed at their true instant. Every
// line DERIVED from an action -- the float, the round transition, the auto-skip
// -- goes through `logInfo`, which had no way to know a replay was running and
// stamped `Date.now()`. So an action and its own consequences landed hours
// apart, and the consequences piled up at the bottom of the feed in a heap.
//
// The fix is in two halves and this file holds both ends of it:
//
//   `seq`, here -- a monotonic sequence assigned at construction, so the merge
//   has a real order to fall back on when the clocks disagree.
//
//   The replay clock, in App.tsx -- so the clocks agree in the first place.
//   That half cannot be reached from a test without a React tree, but its
//   OUTPUT can: entries stamped the way a replay stamps them.
//
// The property under test is the one the bug report is about: THE FEED READS
// IN THE ORDER THINGS HAPPENED, whatever the clock says.

import { mergeFeedItems, type ActionLogEntry, type ChatMessage } from "./feed";

let nextSeq = 1;

/** A log entry as App.tsx builds one. `seq` defaults to the next in sequence,
 *  which is what every real caller does. */
function entry(over: Partial<ActionLogEntry> = {}): ActionLogEntry {
  const seq = over.seq ?? nextSeq++;
  return {
    id: seq,
    seq,
    label: `entry ${seq}`,
    status: "success",
    detail: "",
    timestamp: "12:00:00",
    timestampMs: 1_000 * seq,
    ...over,
  };
}

function chat(id: string, timestampMs: number): ChatMessage {
  return { id, author: "Ada", text: "hello", timestamp: "12:00:00", timestampMs };
}

const labels = (items: readonly { logLabel?: string; chatText?: string }[]) =>
  items.map((item) => item.logLabel ?? item.chatText ?? "");

beforeEach(() => {
  nextSeq = 1;
});

describe("the merged feed", () => {
  it("reads oldest-first", () => {
    // The convention the ticker auto-scrolls on. Unchanged by #668.
    const log = [entry({ label: "first" }), entry({ label: "second" })];
    expect(labels(mergeFeedItems([], log))).toEqual(["first", "second"]);
  });

  it("interleaves chat against the log by time", () => {
    /* The one thing the two streams share. `seq` orders the log; it says
       nothing about where a chat message belongs, and the clock still has to
       answer that. */
    const log = [
      entry({ label: "before", timestampMs: 1_000 }),
      entry({ label: "after", timestampMs: 3_000 }),
    ];
    expect(labels(mergeFeedItems([chat("c1", 2_000)], log))).toEqual([
      "before",
      "hello",
      "after",
    ]);
  });

  it("does not depend on the order the log array is held in", () => {
    /* App.tsx PREPENDS to `actionLog` and chat is appended -- the two arrays
       use opposite conventions, which is why the merge sorts at all rather
       than concatenating. */
    const log = [entry({ label: "first" }), entry({ label: "second" })];
    expect(labels(mergeFeedItems([], [...log].reverse()))).toEqual(["first", "second"]);
  });

  it("keeps a derived line beside the action that produced it", () => {
    /* THE BUG. A replayed action carries its true `createdAt`; before the
       replay clock, the float line it produced carried `Date.now()`. Here
       they are as they arrived at the sort -- and the float must still read
       directly after its own tile lay rather than at the end of the feed. */
    const now = 9_999_999;
    const log = [
      entry({ label: "PRR laid Tile #57", timestampMs: 1_000 }),
      entry({ label: "B&O floated", timestampMs: now }),
      entry({ label: "PRR ran a $90 route", timestampMs: 2_000 }),
    ];
    expect(labels(mergeFeedItems([], log))).toEqual([
      "PRR laid Tile #57",
      "B&O floated",
      "PRR ran a $90 route",
    ]);
  });

  it("does not dump a replayed history at the bottom of the feed", () => {
    /* The report, in miniature: setup replayed during OR 2.2. Even with every
       replayed entry stamped at the instant of the rebuild -- the worst case,
       a log with no `createdAt` resolved at all -- setup must read first. */
    const rebuiltAt = 9_999_999;
    const log = [
      entry({ label: "Game dealt for 2 players", timestampMs: rebuiltAt }),
      entry({ label: "Host won Mohawk & Hudson", timestampMs: rebuiltAt }),
      entry({ label: "B&O floated", timestampMs: rebuiltAt }),
      entry({ label: "PRR laid Tile #57", timestampMs: rebuiltAt }),
    ];
    expect(labels(mergeFeedItems([], [...log].reverse()))).toEqual([
      "Game dealt for 2 players",
      "Host won Mohawk & Hudson",
      "B&O floated",
      "PRR laid Tile #57",
    ]);
  });

  it("orders by sequence when a stamp runs backwards", () => {
    /* Firestore's `createdAt` is null in the optimistic local snapshot, so
       `at` is legitimately absent on a just-written entry and the caller
       falls back to the wall clock. Two clocks in one log means a stamp can
       go backwards; the sequence cannot. */
    const log = [
      entry({ label: "acted", seq: 1, timestampMs: 5_000 }),
      entry({ label: "and then", seq: 2, timestampMs: 4_000 }),
    ];
    const read = labels(mergeFeedItems([], log));
    expect(read.indexOf("acted")).toBeLessThan(read.indexOf("and then"));
  });

  it("is total, so two clients render one history one way", () => {
    /* A comparator that returns 0 for distinct items leaves their order to
       `Array.sort`, and two browsers reading the same room would disagree
       about it. Every field tied here except the id. */
    const log = [
      entry({ id: 7, seq: 5, label: "alpha", timestampMs: 1_000 }),
      entry({ id: 3, seq: 5, label: "beta", timestampMs: 1_000 }),
    ];
    const forwards = labels(mergeFeedItems([], log));
    const backwards = labels(mergeFeedItems([], [...log].reverse()));
    expect(forwards).toEqual(backwards);
  });

  it("does not mutate the arrays it was handed", () => {
    // Both are React state; App.tsx re-renders off their identity.
    const log = [entry({ label: "second", timestampMs: 2_000 }), entry({ label: "first", timestampMs: 1_000 })];
    const messages = [chat("c2", 2_000), chat("c1", 1_000)];
    mergeFeedItems(messages, log);
    expect(labels(log.map((e) => ({ logLabel: e.label })))).toEqual(["second", "first"]);
    expect(messages.map((m) => m.id)).toEqual(["c2", "c1"]);
  });
});
