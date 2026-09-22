/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 896 (harness): THE NOTICE, THE KEY, AND THE OFF SWITCH
// ==================================================================
//
// REQUESTED: an unavoidable blocking modal at the start of a corporation's Operating Round turn when it lost
// trains to rust or to a train limit drop, with a per-corporation silence toggle for each notification type.
//
// THREE PROPERTIES CARRIED THE FEATURE, and two of them are what this file is still about:
//   1. ONE LOSS IS UP TO TWO NOTICES. Rust and limit are separate events and must never travel together.
//   2. A DISMISSED NOTICE STAYS DISMISSED ACROSS A REPLAY. Undo rebuilds state by replaying the log, which
//      re-queues every notice; the dismissal key is derived from game state so a rebuild reproduces it.
//   3. SILENCED AND DISMISSED ARE DIFFERENT QUESTIONS. Collapsing them would make silencing a notice
//      retroactively mark it seen, which surfaces the moment a player switches it back on.
//
// ==================================================================
//  AMENDED BY VF-8: (3) HAS NO SUBJECT LEFT, AND (1) IS NO LONGER ABOUT A TOGGLE
// ==================================================================
// The per-corporation silence store is retired. VF-7 gated the RUST notice on tutorial mode and narrowed
// the store to the train-limit cause because that dialog still had a real reader; VF-8's audit found it
// unreachable under v2 rules besides -- #1530 splices a `DiscardTrain` out of the fleet diff and the phase
// change takes nothing, so `describeFleetLosses` has reported no discard since -- and re-homed the
// explanation onto the president's action, where the chosen train is actually known. With no reader on
// either half, `isNoticeSilenced`, `setNoticeSilenced`, `silenceLabel` and `SilenceableCause` are gone,
// `nextDueNotice` takes the queue and the dismissed set, and ONE system decides whether either dialog
// appears: the tutorial setting. `components/trainDiscardFlourish.test.ts` asserts the absence.
//
// (1) SURVIVES AS A FACT ABOUT THE EVENTS rather than about the toggle: a rust and a limit drop are two
// things that happened, they are explained separately, and each waits on its own flourish.
//
// NODE, NOT JSDOM, AND NOTHING HERE NEEDS A BROWSER ANY MORE -- which is now true by construction rather
// than by the store's care over a missing `window`: no function under test touches storage at all.

import {
  fleetLossNotices,
  nextDueNotice,
  noticeBody,
  noticeDismissKey,
  noticeHeadline,
  type FleetLossNotice,
} from "./fleetLossNotice";
import type { FleetLoss } from "../gameEngine/sandboxSession";
import { readStripped, sliceBetween } from "./sourceScan";

const PRR = 1;
const loss = (over: Partial<FleetLoss> = {}): FleetLoss => ({
  companyId: PRR,
  ticker: "PRR",
  rusted: [],
  discarded: [],
  ...over,
});

/* Design note #1032: THE TURN IS NO LONGER PART OF A NOTICE'S IDENTITY, so this fixture is gone with the
   parameter it fed. It described the showing; the key now describes the event, which is what made a dismissal
   survive into the next operating round. */

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
    /* Design note #1100: numerals name the TIER, words count the trains -- ruled, "write out the number
       of trains and reserve numerals for the train tiers", because every train in 1830 is named by a numeral
       and a sentence that also counts in numerals puts two unrelated numbers side by side. */
    expect(noticeHeadline(rust)).toContain("two trains");
    // Design note #1100: the singular takes the same rule -- "one train", not "1 train".
    expect(noticeHeadline(limit)).toContain("one train");
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
    /* Design note #1100: numerals name the TIER, words count the trains -- ruled, "write out the number
       of trains and reserve numerals for the train tiers", because every train in 1830 is named by a numeral
       and a sentence that also counts in numerals puts two unrelated numbers side by side.
       THE TIER KEEPS ITS NUMERAL, which is why this line is the clearest example of the rule: "Two of your
       2-trains" has exactly one digit in it and it names the train. */
    expect(noticeBody(rust)).toBe("Two of your 2-trains have rusted.");
    expect(noticeBody(rust).length).toBeLessThan(70);
  });

  it("agrees in number when only one train went", () => {
    /* THE ONE DEVIATION FROM THE RULED STRING, and it is grammar rather than judgement: the template was
       written for the plural and "1 ... have rusted" is simply wrong. */
    const [one] = fleetLossNotices(loss({ rusted: ["4"], discarded: [] }), "6", 2);
    expect(noticeBody(one)).toBe("One of your 4-trains has rusted.");
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

  it("says the same thing on every table now (design note #1003)", () => {
    /* ==================================================================
        THE VARIANT'S EXTRA LINE IS GONE, WITH THE TIMING THAT NEEDED IT
       ==================================================================
       THIS ASSERTED `noticeGentleRustLine` -- "Gentle rust: You can run these trains one more time before
       they retire." -- present under the variant and absent otherwise.
       RULED SINCE: "Since the modal now fires upon actual destruction, remove the special 'Gentle rust...'
       explanatory text. Use the standard rust notification copy."
       AND THE SENTENCE WAS A PROMISE ABOUT THE FUTURE, true at the moment the trains were MARKED and false at
       the moment they die. #1002 moves the modal to the second of those, so keeping the line would tell a
       president they may run trains that left the fleet in the dispatch that raised the modal.
       WHAT IS ASSERTED NOW IS THE COLLAPSE: one body, one cause, no variant branch anywhere in the copy. A
       `gentleRust` field surviving on the notice would be the branch waiting to come back. */
    const [gentle] = fleetLossNotices(loss({ rusted: ["2"], discarded: [] }), "4", 3);
    expect(noticeBody(gentle)).toBe("One of your 2-trains have rusted.".replace("have", "has"));
    const NOTICE = readStripped("utils/fleetLossNotice.ts");
    expect(NOTICE).not.toContain("noticeGentleRustLine");
    expect(NOTICE).not.toContain("Gentle rust:");
    expect(NOTICE).not.toContain("gentleRust");
    expect(readStripped("components/FleetLossModal.tsx")).not.toContain("noticeGentleRustLine");
  });

  /* ==================================================================
      RETIRED BY VF-8: "labels the toggle for the cause AND the corporation"
     ==================================================================
     There is no toggle to label. Both fleet-loss causes are gated on tutorial mode, so `silenceLabel`
     and the store it named are gone (`fleetLossNotice.ts`'s retirement note carries the reasoning).
     The copy this case guarded -- that a label must not promise a scope the keys do not implement -- has
     no subject left; the modal's remaining copy is `noticeHeadline`/`noticeBody`, checked above. */
});

describe("the dismissal key names the event, not the showing (design notes #896, #1032)", () => {
  const [rust, limit] = fleetLossNotices(loss({ rusted: ["2"], discarded: ["3"] }), "4", 3);

  it("is the same key on a replay, which is the whole point", () => {
    /* THE REPLAY PROPERTY, UNCHANGED BY #1032. Undo rebuilds state by replaying the log, so the phase change
       runs again and the notice is re-derived. The key is built from the notice's own content -- which the
       log reproduces exactly -- so the rebuild lands on the same string and a dismissed notice stays
       dismissed. #896 wanted this and reached for `turnGuardKey` to get it; the content was always the part
       doing the work. */
    expect(noticeDismissKey(rust)).toBe(noticeDismissKey({ ...rust, trains: ["2"] }));
  });

  it("does not change when the turn does", () => {
    /* THE BUG, AS AN ASSERTION. The key was `turnGuardKey(turn, company, cause)`, so the SAME event acquired
       a new key every operating round -- a notice dismissed in OR 6.2 was unrecognised in OR 7.1, re-queued
       by the replay, and shown again. Reported as "modals kept firing at the start of basically every
       operating round". There is no turn in this key to vary, and this case is what would fail if one were
       reintroduced. */
    expect(noticeDismissKey.length).toBe(1);
  });

  it("tells the two causes apart", () => {
    /* Otherwise dismissing the rust notice would swallow the limit notice that arrived in the same phase
       change -- the player would be told about half of what happened to them. */
    expect(noticeDismissKey(rust)).not.toBe(noticeDismissKey(limit));
  });

  it("tells two corporations apart", () => {
    const other: FleetLossNotice = { ...rust, companyId: 8, ticker: "B&M" };
    expect(noticeDismissKey(other)).not.toBe(noticeDismissKey(rust));
  });

  it("tells two phase changes apart", () => {
    /* WHAT REPLACES THE TURN AS THE DISTINGUISHING FIELD. Two different rust events must not collapse onto
       one key, or dismissing the first would suppress the second. The arriving tier is monotonic, so it is
       the honest discriminator: the same tier cannot arrive twice. */
    expect(noticeDismissKey({ ...rust, arrivingTier: "6" })).not.toBe(noticeDismissKey(rust));
    expect(noticeDismissKey({ ...rust, trains: ["2", "2"] })).not.toBe(noticeDismissKey(rust));
  });
});

describe("choosing which notice to raise", () => {
  const [rust, limit] = fleetLossNotices(loss({ rusted: ["2"], discarded: ["3"] }), "4", 3);
  const queue = [rust, limit];

  it("raises the first unanswered one", () => {
    expect(nextDueNotice(queue, new Set())).toBe(rust);
  });

  it("skips a silenced cause and still raises the other", () => {
    /* ==================================================================
        AMENDED BY VF-8: THE PER-CAUSE TOGGLE IS GONE; THE PER-CAUSE KEY IS NOT
       ==================================================================
       This case checked that silencing one cause left the other standing -- "a store keyed per
       corporation and not per cause would fail exactly here." There is no store. The property that
       survives is the one the DISMISSAL key still carries, and it fails in the same way for the same
       reason if the key ever stops naming the cause: answering the rust notice must leave the limit
       notice of the same phase change standing. */
    expect(nextDueNotice(queue, new Set([noticeDismissKey(rust)]))).toBe(limit);
    expect(nextDueNotice(queue, new Set([noticeDismissKey(limit)]))).toBe(rust);
  });

  it("moves to the next once the first is dismissed", () => {
    const dismissed = new Set([noticeDismissKey(rust)]);
    expect(nextDueNotice(queue, dismissed)).toBe(limit);
  });

  it("raises nothing when everything is answered", () => {
    const dismissed = new Set([noticeDismissKey(rust), noticeDismissKey(limit)]);
    expect(nextDueNotice(queue, dismissed)).toBeNull();
    expect(nextDueNotice([], new Set())).toBeNull();
  });

  /* ==================================================================
      RETIRED BY VF-8: "does not let silencing stand in for having been seen"
     ==================================================================
     #896's distinction between a standing preference and "you have already seen this" needed two
     states to keep apart. VF-8 retires the preference, so `nextDueNotice` asks one question and there
     is nothing to confuse it with. The dismissal half is checked by the three cases above. */
});

/* ==================================================================
    RETIRED BY VF-8: THE SILENCE TOGGLES, AND EVERY CASE THAT CHECKED THEM
   ==================================================================
   THIS DESCRIBE PINNED #896a's SCOPING -- room-scoped `sessionStorage` rather than `localStorage` so a
   toggle set for PRR in one game could not silence PRR in a game the player had not started; the
   in-memory Map as the truth and storage as the mirror, so a toggle still worked in private browsing;
   one key per corporation per cause. Every one of those arguments was right, and all of them are now
   about a mechanism that no longer exists: both fleet-loss causes are gated on tutorial mode, so the
   answer to "stop telling me this" is one application-wide setting rather than a box per corporation.
   DELETED RATHER THAN LEFT SKIPPED. A suite that checks a retired store is a suite that will be
   "repaired" by the next reader who finds it red. The reasoning is preserved in `fleetLossNotice.ts`'s
   own retirement note, which is where somebody rebuilding a per-corporation preference would look. */

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
       makes files look like their neighbours.
       THE ANCHOR MOVED WITH #1651 AND THE ASSERTION GOT STRONGER, NOT WEAKER. There is no backdrop `<div>`
       left to slice: the scrim IS the `<dialog>`, and the style reaches it as a prop, `scrimStyle=`. So "no
       `onClick` after `style={styles.backdrop}`" no longer has a subject -- and because the anchor is gone
       rather than merely unmatched, `sliceBetween` throws instead of handing back an empty string that would
       satisfy the `not.toContain` beside it (#886). That is the vacuous pass this rewrite exists to avoid.
       THE DISMISSAL IS A POLICY NOW, so the policy is what is asserted, on the opening tag, which carries the
       whole of it: `onScrimClick` is the boundary's only backdrop route and this surface must not name it,
       and `dismissible={false}` compiles to `closedby="none"`, which is also what refuses Escape -- the
       second exit this file has never had and, before the migration, had nothing enforcing. */
    const tag = sliceBetween(SOURCE, "<NativeModal", ">");
    expect(tag).toContain("scrimStyle={styles.backdrop}");
    expect(tag).not.toContain("onScrimClick");
    expect(tag).toContain("dismissible={false}");
  });

  it("offers exactly one control that leaves it", () => {
    /* A COUNT, and a count is normally a weak assertion -- here it is the point. Two buttons would mean a
       second way out, and the second way out is always the one that skips the reading. */
    expect(SOURCE.match(/<button/g) ?? []).toHaveLength(1);
    expect(SOURCE).toContain("onClick={onAcknowledge}");
  });
});
