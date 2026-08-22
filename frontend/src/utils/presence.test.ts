/** @jest-environment node */
//
// The presence rules and the boundary they must not cross. No React, no Firestore.
//
// ==================================================================
//  DESIGN NOTE 740 (harness): A HINT THAT NEVER BECOMES A FACT
// ==================================================================
//
// REQUESTED: "it sounds like we're going to need the Presence channel for the full game anyway, so let's knock
// it out now."
//
// THE TESTS THAT MATTER MOST HERE ARE THE BOUNDARY ONES, and they are structural rather than behavioural.
// This codebase's guarantees -- Undo, reconnect, replay equivalence -- all rest on there being exactly ONE
// source of truth: the append-only log (#591, #668). Presence is a second stream of data about the same game,
// arriving out of order from clients that may have crashed. Every behavioural test below could pass while the
// architecture quietly rotted, if some module that computes game state started importing from here.
//
// So the last describe block asserts the separation itself: the reducer does not import presence, presence
// does not reach the action log, and the transport writes to its own subcollection. Those are the assertions
// that would fail on the change that actually hurts.
//
// AND THE FRESHNESS RULE IS TESTED IN BOTH DIRECTIONS. A stale route is worse than no route -- it shows a
// rival apparently mid-decision when they have closed the tab -- but a clock-skew record from the "future"
// must NOT be discarded, or every player whose machine runs fast becomes invisible, which looks like a network
// fault and is not.

import {
  PRESENCE_PUBLISH_MS,
  PRESENCE_STALE_MS,
  isPresenceFresh,
  shouldPublishNow,
  shouldPublishRoutes,
  visiblePresence,
  type PresenceState,
} from "./presence";

const NOW = 1_000_000;

function entry(over: Partial<PresenceState> = {}): PresenceState {
  return {
    playerId: "rival",
    at: NOW,
    routeDrafts: { 0: [[1, 1], [2, 1]] },
    actingCompanyId: 3,
    ...over,
  };
}

describe("stale presence is absent presence", () => {
  it("keeps a record inside the window", () => {
    expect(isPresenceFresh(entry({ at: NOW - PRESENCE_STALE_MS + 1 }), NOW)).toBe(true);
  });

  it("drops one past it", () => {
    /* The tab-closed case. Nothing deletes a presence document when a client vanishes, so age is the only
       thing standing between a watcher and a route drafted an hour ago. */
    expect(isPresenceFresh(entry({ at: NOW - PRESENCE_STALE_MS - 1 }), NOW)).toBe(false);
  });

  it("keeps a record from the FUTURE", () => {
    /* CLOCK SKEW, and the direction a naive `Math.abs` would get wrong. Client clocks differ by seconds;
       treating a small negative age as staleness would blank every player whose machine runs fast. */
    expect(isPresenceFresh(entry({ at: NOW + 2_000 }), NOW)).toBe(true);
  });

  it("drops a record with no usable timestamp", () => {
    expect(isPresenceFresh(entry({ at: Number.NaN }), NOW)).toBe(false);
  });

  it("stays short enough to be a few missed publishes", () => {
    // A long window would trade one failure mode for a worse one: confidently stale.
    expect(PRESENCE_STALE_MS).toBeLessThanOrEqual(10_000);
    expect(PRESENCE_STALE_MS).toBeGreaterThan(PRESENCE_PUBLISH_MS * 3);
  });
});

describe("a viewer never reads their own drafts back off the wire", () => {
  it("excludes the viewer", () => {
    /* Their own drafts are in local state and authoritative there. Reading them back would make a player's
       own routes lag their own clicks by a publish interval -- which reads as the app being slow. */
    const entries = [entry({ playerId: "me" }), entry({ playerId: "rival" })];
    expect(visiblePresence(entries, "me", NOW).map((e) => e.playerId)).toEqual(["rival"]);
  });

  it("excludes anybody with nothing drafted", () => {
    // An empty presence record is a heartbeat, not a route, and must not produce an empty chip row.
    expect(visiblePresence([entry({ routeDrafts: {} })], "me", NOW)).toHaveLength(0);
  });

  it("filters the whole snapshot against ONE instant", () => {
    /* `now` is a parameter rather than a `Date.now()` per entry, so a long list cannot disagree with itself
       about what "now" is -- which would show two rivals' routes from moments that never coexisted. */
    const old = entry({ playerId: "gone", at: NOW - PRESENCE_STALE_MS - 1 });
    const live = entry({ playerId: "here" });
    expect(visiblePresence([old, live], "me", NOW).map((e) => e.playerId)).toEqual(["here"]);
  });
});

describe("only the acting player publishes routes", () => {
  const base = { isMyTurn: true, orSubPhase: "Routes", inRoom: true };

  it("publishes on your own Routes turn in a room", () => {
    expect(shouldPublishRoutes(base)).toBe(true);
  });

  it("says nothing on somebody else's turn", () => {
    /* RULE 2. Four players idling on the Routes step would otherwise broadcast four sets of drafts, and the
       one that matters would be indistinguishable from three that do not. */
    expect(shouldPublishRoutes({ ...base, isMyTurn: false })).toBe(false);
  });

  it("says nothing outside the Routes step", () => {
    expect(shouldPublishRoutes({ ...base, orSubPhase: "Track" })).toBe(false);
    expect(shouldPublishRoutes({ ...base, orSubPhase: null })).toBe(false);
  });

  it("says nothing in a solo game", () => {
    // No room, no rivals, nobody to tell.
    expect(shouldPublishRoutes({ ...base, inRoom: false })).toBe(false);
  });
});

describe("publishing is coalesced, but never delayed at the start", () => {
  it("publishes immediately the first time", () => {
    /* The opening state of a turn is the one a watcher most wants, and holding it for an interval would make
       the feature feel broken before it feels slow. */
    expect(shouldPublishNow(null, NOW)).toBe(true);
  });

  it("refuses a second publish inside the window", () => {
    expect(shouldPublishNow(NOW, NOW + PRESENCE_PUBLISH_MS - 1)).toBe(false);
  });

  it("allows one at the boundary", () => {
    expect(shouldPublishNow(NOW, NOW + PRESENCE_PUBLISH_MS)).toBe(true);
  });
});

describe("the label is looked up, not carried", () => {
  const app = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
  })();

  it("names the actual train rather than its index", () => {
    /* Design note #740, corrected on report: "Nobody knows what 'Train 1' is. Have it display the actual
       train that's running."
       The first version reasoned that presence carries no roster, so the model was unknowable. It is knowable:
       the roster is GAME STATE, replayed from the same log on every client. Presence supplies the corporation
       and the index; the board supplies the fleet. */
    const code = app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    /* The needle drops the leading `${`, for `appNaming.test.ts`'s reason: written in full it is a literal
       `${...}` inside a plain string and `no-template-curly-in-string` reads it as a template the author
       forgot to write. */
    expect(code).not.toContain("`Train ");
    expect(code).toContain("const model = roster[Number(index)];");
  });

  it("joins the hint to state by the corporation presence names", () => {
    /* The join key. Attributing a rival's routes to the wrong fleet would put a 6-Train's revenue on a
       2-Train's chip, which is worse than a vague label. */
    expect(app).toContain("entry.company_id === presenceCompany");
  });

  it("falls back to an unnumbered label rather than a stale model", () => {
    /* A train rusted or discarded mid-turn leaves the index pointing at nothing. "Train" is vague; a confident
       wrong model is the failure this whole session has been about. */
    expect(app).toContain('model ? `');
    expect(app).toContain(': "Train"');
  });
});

describe("presence stays outside the one source of truth", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, rel), "utf8");
  };
  /* #490a, walked into for the third time this session: these notes DISCUSS the log by name -- explaining why
     presence swallows errors where `appendSandboxAction` reports them -- and a scan over raw source cannot
     tell an import from an argument about one. The structural checks read code; the note-survives check below
     reads the raw file. */
  const code = (rel: string) =>
    read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("is never imported by the reducer", () => {
    /* THE ASSERTION THAT PROTECTS THE ARCHITECTURE. Every behavioural test above could pass while
       `sandboxSession` started reading a hint as a fact, and the resulting corruption would be intermittent --
       the worst kind to debug and the worst kind to ship. */
    expect(code("sandboxSession.ts")).not.toContain("./presence");
    expect(code("sandboxSession.ts")).not.toContain("sandboxPresence");
  });

  it("is never written to the action log", () => {
    /* The log is what Undo replays. Ephemeral, retracted, half-finished intent in that sequence would make
       `effectiveActions` learn to skip things -- a rule the log exists in order not to need. */
    const transport = code("sandboxPresence.ts");
    expect(transport).not.toContain("SANDBOX_ACTIONS_SUBCOLLECTION");
    expect(transport).not.toContain("appendSandboxAction");
    // And the note explaining WHY it does neither survives its own test.
    expect(read("sandboxPresence.ts")).toContain("appendSandboxAction");
  });

  it("writes to its own subcollection rather than the room document", () => {
    /* The room doc is mutated inside a TRANSACTION by `upsertSandboxPlayer`. Publishing twice a second into
       the same document would contend with joins and colour changes, and re-render every waiting-room
       subscriber on a game they are not in. */
    const transport = code("sandboxPresence.ts");
    expect(transport).toContain('SANDBOX_PRESENCE_SUBCOLLECTION = "presence"');
    expect(transport).toContain("SANDBOX_PRESENCE_SUBCOLLECTION,");
  });

  it("overwrites per seat rather than accumulating", () => {
    /* Presence is a CURRENT VALUE, not an event. `addDoc` would build an unbounded history of intentions that
       nothing ever deletes. */
    const transport = code("sandboxPresence.ts");
    expect(transport).toContain("setDoc(");
    expect(transport).not.toContain("addDoc(");
  });

  it("clears a seat when its turn ends rather than waiting for staleness", () => {
    // Staleness is the safety net for a client that vanished, not the mechanism for a turn that ended cleanly.
    expect(read("sandboxPresence.ts")).toContain("export async function clearPresence");
    expect(read("../App.tsx")).toContain("void clearPresence(room, me)");
  });
});
