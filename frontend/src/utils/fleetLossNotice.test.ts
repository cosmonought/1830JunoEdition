/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 896 (harness): THE NOTICE, THE KEY, AND THE OFF SWITCH
// ==================================================================
//
// REQUESTED: an unavoidable blocking modal at the start of a corporation's Operating Round turn when it lost
// trains to rust or to a train limit drop, with a per-corporation silence toggle for each notification type.
//
// THREE PROPERTIES CARRY THE FEATURE, and they are what this file is about:
//   1. ONE LOSS IS UP TO TWO NOTICES. The toggle is per cause, so rust and limit must never travel together.
//   2. A DISMISSED NOTICE STAYS DISMISSED ACROSS A REPLAY. Undo rebuilds state by replaying the log, which
//      re-queues every notice; the dismissal key is derived from game state so a rebuild reproduces it.
//   3. SILENCED AND DISMISSED ARE DIFFERENT QUESTIONS. Collapsing them would make silencing a notice
//      retroactively mark it seen, which surfaces the moment a player switches it back on.
//
// NODE, NOT JSDOM, AND THE STORE STILL WORKS. `isNoticeSilenced` answers from its in-memory Map first and
// treats `window` being absent exactly as it treats private browsing -- so the toggle is fully exercised here
// without a browser, which is also the guarantee a player in a locked-down browser is relying on.

import {
  fleetLossNotices,
  isNoticeSilenced,
  nextDueNotice,
  noticeBody,
  noticeGentleRustLine,
  noticeDismissKey,
  noticeHeadline,
  resetNoticeSilenceCache,
  setNoticeSilenced,
  silenceLabel,
  type FleetLossNotice,
} from "./fleetLossNotice";
import type { FleetLoss } from "./sandboxSession";
import { readStripped, sliceBetween } from "./sourceScan";

const PRR = 1;
const loss = (over: Partial<FleetLoss> = {}): FleetLoss => ({
  companyId: PRR,
  ticker: "PRR",
  rusted: [],
  discarded: [],
  ...over,
});

const TURN = { macro_round_number: 2, sub_round_index: 1, active_corporation_index: 3 };

beforeEach(() => resetNoticeSilenceCache());

describe("one loss becomes one notice per cause (design note #896)", () => {
  it("splits a phase change that both rusted and trimmed", () => {
    /* THE PROPERTY THE TOGGLE DEPENDS ON. `describeFleetLoss` joins these two with "and" for the Activity Log,
       which is right for a log line and impossible for a modal: "don't notify me about rust events" must not
       also silence a train limit drop, because they are different rules with different remedies. */
    const notices = fleetLossNotices(loss({ rusted: ["2"], discarded: ["3"] }), "4", 3);
    expect(notices.map((entry) => entry.cause)).toEqual(["rust", "limit"]);
    expect(notices[0].trains).toEqual(["2"]);
    expect(notices[1].trains).toEqual(["3"]);
  });

  it("rusts before it trims, which is the order the rules fired", () => {
    // Not cosmetic: the modal shows one at a time, and a player told about the trim first would be reading the
    // consequence before the cause.
    const notices = fleetLossNotices(loss({ rusted: ["2", "2"], discarded: ["3"] }), "4", 3);
    expect(notices[0].cause).toBe("rust");
  });

  it("makes no notice out of a loss that took nothing", () => {
    /* The same guard `describeFleetLoss` applies before building a sentence, so a caller can hand it every
       entry from `describeFleetLosses` without filtering. An empty array here is what keeps a corporation
       that lost nothing from being stopped at all. */
    expect(fleetLossNotices(loss(), "4", 3)).toEqual([]);
  });

  it("carries the limit and the tier onto every notice it makes", () => {
    /* THE FIGURES THE COPY NEEDS, pinned because a `null` on either would silently degrade both sentences to
       their vaguer fallback and nothing would look broken. */
    const [rust, limit] = fleetLossNotices(loss({ rusted: ["2"], discarded: ["3"] }), "4", 3);
    expect([rust.arrivingTier, rust.trainLimit]).toEqual(["4", 3]);
    expect([limit.arrivingTier, limit.trainLimit]).toEqual(["4", 3]);
  });
});

describe("the copy tells a president what happened and what it costs", () => {
  const [rust, limit] = fleetLossNotices(loss({ rusted: ["2", "2"], discarded: ["3"] }), "4", 3);

  it("names the corporation and the count in the headline", () => {
    // A player may be running several corporations; a headline that says "your trains rusted" names none.
    expect(noticeHeadline(rust)).toContain("PRR");
    expect(noticeHeadline(rust)).toContain("2 trains");
    expect(noticeHeadline(limit)).toContain("1 train");
  });

  it("says what rusted and how many, and nothing else", () => {
    /* ==================================================================
        SUPERSEDED BY #980: THE BODY WAS A PARAGRAPH AND IS NOW A SENTENCE
       ==================================================================
       THIS ASSERTED `"first 4-train"` and `"2-train and 2-train"` -- the trigger clause and the spelled-out
       fleet. RULED SINCE: "The current Rust modal contains a wall of text. Simplify it drastically", with the
       replacement given verbatim.
       THE TRIGGER IS NOT LOST, WHICH IS WHY IT COULD GO: the purchase that caused this is the Activity Log
       line immediately above, stamped with its round and step. A blocking modal is the worst surface in the
       app for a fact the player did not ask for.
       ASSERTED AS A CEILING TOO. "Drastically" is the instruction, and a case that only checks the new
       sentence is present would pass against a build that appended the old paragraph after it. */
    expect(noticeBody(rust)).toBe("2 of your 2-trains have rusted.");
    expect(noticeBody(rust).length).toBeLessThan(70);
  });

  it("agrees in number when only one train went", () => {
    /* THE ONE DEVIATION FROM THE RULED STRING, and it is grammar rather than judgement: the template was
       written for the plural and "1 ... have rusted" is simply wrong. */
    const [one] = fleetLossNotices(loss({ rusted: ["4"], discarded: [] }), "6", 2);
    expect(noticeBody(one)).toBe("1 of your 4-trains has rusted.");
  });

  it("names the limit AND the cheapest-first rule in the limit body", () => {
    /* #704'S REASON, CARRIED FORWARD: "discarded its 2-train" without the limit reads as a choice the
       president made. It is not a choice, and the copy has to say both halves -- what the ceiling is, and that
       the corporation got no say in which train met it. */
    expect(noticeBody(limit)).toContain("new limit of 3");
    expect(noticeBody(limit)).toContain("cheapest");
  });

  it("has stopped promising the discarded train comes back (design note #990)", () => {
    /* ==================================================================
        SUPERSEDED TWICE, AND THE SECOND TIME IT WAS A LORE ERROR
       ==================================================================
       #896 ASSERTED "could not be refused" ON BOTH CAUSES, on the argument that a blocking modal owes the
       player a reason it was worth stopping them for. #980 narrowed it to the limit notice and kept that one
       because its sentence was "a fact with a rival's decision attached -- a rival can take it this round".
       THAT DECISION DOES NOT EXIST. RULED: "The modal incorrectly states the discarded train returns to the
       depot. Discarded trains are permanently removed from the game."
       SO THE SENTENCE WAS NOT SURPLUS, IT WAS WRONG -- and my reason for keeping it was built entirely on the
       thing that was false. Worth recording as such: the case did its job for #896's version and then held a
       falsehood in place for one batch because nobody re-checked the rule the copy was asserting.
       THE FUNCTION IS GONE, not left returning `null`. A predicate with one reachable answer is #788's
       unreachable arm wearing a return type. Asserted as an absence over the module and the modal both,
       because an orphaned export is how the sentence comes back. */
    const NOTICE = readStripped("utils/fleetLossNotice.ts");
    const MODAL = readStripped("components/FleetLossModal.tsx");
    expect(NOTICE).not.toContain("back in the depot");
    expect(NOTICE).not.toContain("could not be refused");
    expect(NOTICE).not.toContain("export function noticeConsequence");
    expect(MODAL).not.toContain("noticeConsequence");
  });

  it("adds the gentle-rust line only under the variant, and only to rust", () => {
    /* RULED VERBATIM, so asserted verbatim: a paraphrase here would be this file agreeing with itself.
       ITS OWN FUNCTION rather than a clause inside the body, because the ruling asks for it to be COLOURED --
       "keep the colored text" -- and a modal cannot tint half a string it was handed whole.
       AND IT IS SCOPED TWICE. A limit notice under a gentle-rust table is still a limit notice: nothing about
       a train the depot has taken back gets one more run, and offering that line there would promise a grace
       period the rules do not give. */
    const [gentle] = fleetLossNotices(loss({ rusted: ["2"], discarded: [] }), "4", 3, true);
    expect(noticeGentleRustLine(gentle)).toBe(
      "Gentle rust: You can run these trains one more time before they retire.",
    );
    expect(noticeGentleRustLine(rust)).toBeNull();
    const [, gentleLimit] = fleetLossNotices(
      loss({ rusted: ["2"], discarded: ["3"] }),
      "4",
      3,
      true,
    );
    expect(noticeGentleRustLine(gentleLimit)).toBeNull();
  });

  it("labels the toggle for the cause AND the corporation, never for both causes at once", () => {
    expect(silenceLabel(rust)).toContain("rust");
    expect(silenceLabel(rust)).toContain("PRR");
    expect(silenceLabel(limit)).toContain("train limit");
    /* THE CONTROL ON THE COPY. A label that mentioned the other cause would be promising a scope the store
       does not implement -- the keys are per cause, and a player reading "rust and limit" would be misled. */
    expect(silenceLabel(rust)).not.toContain("limit");
    expect(silenceLabel(limit)).not.toContain("rust");
  });
});

describe("the dismissal key survives a replay (design note #896)", () => {
  const [rust, limit] = fleetLossNotices(loss({ rusted: ["2"], discarded: ["3"] }), "4", 3);

  it("is the same key for the same turn, which is the whole point", () => {
    /* THE REPLAY PROPERTY. Undo rebuilds state by replaying the log, so the phase change runs again and the
       notice is re-queued. The key is built from game state rather than counted locally (#653's rule), so the
       rebuild lands on the same string and a dismissed notice stays dismissed. */
    expect(noticeDismissKey(TURN, rust)).toBe(noticeDismissKey({ ...TURN }, rust));
  });

  it("tells the two causes apart", () => {
    /* Otherwise dismissing the rust notice would swallow the limit notice that arrived in the same phase
       change -- the player would be told about half of what happened to them. */
    expect(noticeDismissKey(TURN, rust)).not.toBe(noticeDismissKey(TURN, limit));
  });

  it("tells two corporations and two turns apart", () => {
    const other: FleetLossNotice = { ...rust, companyId: 8, ticker: "B&M" };
    expect(noticeDismissKey(TURN, other)).not.toBe(noticeDismissKey(TURN, rust));
    expect(noticeDismissKey({ ...TURN, macro_round_number: 3 }, rust)).not.toBe(
      noticeDismissKey(TURN, rust),
    );
  });
});

describe("choosing which notice to raise", () => {
  const [rust, limit] = fleetLossNotices(loss({ rusted: ["2"], discarded: ["3"] }), "4", 3);
  const queue = [rust, limit];
  const noneSilenced = () => false;

  it("raises the first unanswered one", () => {
    expect(nextDueNotice(queue, TURN, noneSilenced, new Set())).toBe(rust);
  });

  it("skips a silenced cause and still raises the other", () => {
    /* THE CONTROL THAT MATTERS MOST for a per-cause toggle: silencing rust must leave the limit notice
       standing. A store keyed per corporation and not per cause would fail exactly here. */
    const rustSilenced = (notice: FleetLossNotice) => notice.cause === "rust";
    expect(nextDueNotice(queue, TURN, rustSilenced, new Set())).toBe(limit);
  });

  it("moves to the next once the first is dismissed", () => {
    const dismissed = new Set([noticeDismissKey(TURN, rust)]);
    expect(nextDueNotice(queue, TURN, noneSilenced, dismissed)).toBe(limit);
  });

  it("raises nothing when everything is answered", () => {
    const dismissed = new Set([noticeDismissKey(TURN, rust), noticeDismissKey(TURN, limit)]);
    expect(nextDueNotice(queue, TURN, noneSilenced, dismissed)).toBeNull();
    expect(nextDueNotice([], TURN, noneSilenced, new Set())).toBeNull();
  });

  it("does not let silencing stand in for having been seen", () => {
    /* SILENCED AND DISMISSED ARE ASKED SEPARATELY, and this is the case that shows why. A notice skipped
       because it was silenced was never DISMISSED, so switching the toggle back off raises it again. If the
       two were collapsed, a player who silenced a notice and changed their mind would silently never see it. */
    const silencedNow = (notice: FleetLossNotice) => notice.cause === "rust";
    expect(nextDueNotice([rust], TURN, silencedNow, new Set())).toBeNull();
    expect(nextDueNotice([rust], TURN, noneSilenced, new Set())).toBe(rust);
  });
});

describe("the silence toggles are scoped so they cannot leak (design note #896a)", () => {
  it("is off until somebody turns it on", () => {
    /* THE SAFE DIRECTION, and the one a storage failure also lands on: the player is told something true
       rather than quietly not told it. */
    expect(isNoticeSilenced("JUNO-Y8V", PRR, "rust")).toBe(false);
  });

  it("remembers a toggle without a browser to remember it in", () => {
    /* THE FALLBACK, ASSERTED RATHER THAN ASSUMED. There is no `window` in this environment, so every storage
       call throws and the Map is the only thing answering. `TutorialModal`'s wrapper drops the value in that
       case, which is right there and wrong here: a toggle the player just set doing nothing is worse than one
       that does not persist past the tab. */
    setNoticeSilenced("JUNO-Y8V", PRR, "rust", true);
    expect(isNoticeSilenced("JUNO-Y8V", PRR, "rust")).toBe(true);
    setNoticeSilenced("JUNO-Y8V", PRR, "rust", false);
    expect(isNoticeSilenced("JUNO-Y8V", PRR, "rust")).toBe(false);
  });

  it("keeps the two causes apart", () => {
    setNoticeSilenced("JUNO-Y8V", PRR, "rust", true);
    expect(isNoticeSilenced("JUNO-Y8V", PRR, "limit")).toBe(false);
  });

  it("keeps two corporations apart", () => {
    setNoticeSilenced("JUNO-Y8V", PRR, "rust", true);
    expect(isNoticeSilenced("JUNO-Y8V", 8, "rust")).toBe(false);
  });

  it("keeps two rooms apart, which is why this is not localStorage", () => {
    /* THE LEAK THE ROOM SCOPE EXISTS TO CLOSE. 1830's corporations are the same eight every game, so a toggle
       keyed only by corporation would silence PRR in a game the player has not started yet -- with nothing on
       screen to explain why they were never told their trains had rusted. */
    setNoticeSilenced("JUNO-Y8V", PRR, "rust", true);
    expect(isNoticeSilenced("JUNO-ABC", PRR, "rust")).toBe(false);
  });

  it("gives a room-less local game a working switch of its own", () => {
    // Not every game has a code; the toggle still has to work, and must not collide with a coded room.
    setNoticeSilenced(null, PRR, "rust", true);
    expect(isNoticeSilenced(null, PRR, "rust")).toBe(true);
    expect(isNoticeSilenced("JUNO-Y8V", PRR, "rust")).toBe(false);
  });
});

describe("the modal is genuinely unavoidable (design note #896)", () => {
  /* ==================================================================
      THE ONE PROPERTY A RENDER TEST WOULD BE WORTH LESS AT
     ==================================================================
     "Unavoidable" is not a behaviour with an input and an output; it is the ABSENCE of three exits that every
     other modal in this app has. A render test can only assert that the exits it thought to click do nothing,
     and would keep passing the day somebody adds a fourth. Asked of the source instead, where "there is no
     close button" is a statement the file can actually answer.
     THE COMMENT-STRIPPED COPY IS THE SUBJECT (#490a): this file's own header explains WHY there is no backdrop
     click, so a scan of the raw text would find the words it is looking for inside the note forbidding them. */
  const SOURCE = readStripped("components/FleetLossModal.tsx");

  it("is really the modal, and really was stripped", () => {
    /* THE PREMISE, PINNED FIRST. #490a's rule: an absence proves nothing about a file that failed to load, and
       `readStripped` returning a comment-free copy is what makes the absences below mean anything. */
    expect(SOURCE).toContain("FleetLossModal");
    expect(SOURCE).toContain("onAcknowledge");
    expect(SOURCE).not.toContain("Design note #896");
  });

  it("has no close button and no onClose at all", () => {
    /* `AutoPassModal` has both, correctly -- arming Auto-Pass is optional. This is not: a corporation that
       cannot run a route has to be told before its president spends the treasury. */
    expect(SOURCE).not.toContain("onClose");
    expect(SOURCE).not.toContain("aria-label=\"Close\"");
  });

  it("does not close on a backdrop click", () => {
    /* THE EXIT MOST LIKELY TO BE RESTORED BY ACCIDENT, because every sibling modal has it and a tidy-up pass
       makes files look like their neighbours. The backdrop div must carry no click handler whatever. */
    const backdrop = sliceBetween(SOURCE, "style={styles.backdrop}", ">");
    expect(backdrop).not.toContain("onClick");
  });

  it("offers exactly one control that leaves it", () => {
    /* A COUNT, and a count is normally a weak assertion -- here it is the point. Two buttons would mean a
       second way out, and the second way out is always the one that skips the reading. */
    expect(SOURCE.match(/<button/g) ?? []).toHaveLength(1);
    expect(SOURCE).toContain("onClick={onAcknowledge}");
  });
});
