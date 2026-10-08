// frontend/src/tutorial/lessons.test.ts -- PHASE 3 FINAL PLAY TUTORIAL: the canonical lesson registry (CONTENT).

import { readFileSync } from "fs";
import { join } from "path";
import { LESSONS, LIBRARY_TOPICS, isLessonId, lessonById, lessonText, type Lesson } from "./lessons";
import { TRIGGERED_LESSONS } from "./triggers";
import { presentationFor } from "./presentation";
import { OPERATING_SUB_PHASE_ORDER, OPERATING_SUB_PHASE_LABELS } from "../gameEngine/operatingSubPhase";
import { APP_NAME } from "../config";

const allText = (lesson: Lesson, delayedAuction = false): string => {
  const text = lessonText(lesson, { delayedAuction });
  return [text.title, text.summary, ...(text.detail ?? [])].join("\n");
};
const EVERY_TEXT = LESSONS.flatMap((lesson) => [allText(lesson), allText(lesson, true)]);

describe("lesson ids", () => {
  it("are unique, namespaced by topic, and every one resolves", () => {
    const ids = LESSONS.map((lesson) => lesson.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const lesson of LESSONS) {
      expect([lesson.id, lesson.id.startsWith(`${lesson.topic}.`)]).toEqual([lesson.id, true]);
      expect(lessonById(lesson.id)).toBe(lesson);
    }
    expect(lessonById("no.such.lesson")).toBeNull();
    expect(isLessonId("no.such.lesson")).toBe(false);
  });

  it("every trigger raises a real lesson, and every presentation names one", () => {
    for (const id of TRIGGERED_LESSONS) {
      expect([id, isLessonId(id)]).toEqual([id, true]);
      expect(() => presentationFor(id, 3)).not.toThrow();
    }
  });

  it("the library lists every lesson exactly once, under the brief's topics", () => {
    const listed = LIBRARY_TOPICS.flatMap((topic) => topic.lessons);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(LESSONS.map((lesson) => lesson.id).sort());
    for (const topic of LIBRARY_TOPICS) {
      for (const id of topic.lessons) expect([id, lessonById(id)?.topic]).toEqual([id, topic.id]);
    }
    expect(LIBRARY_TOPICS.map((topic) => topic.heading)).toEqual([
      "Getting Oriented",
      "Waterfall Auction",
      "Stock Round",
      "Operating Round",
      "Stock Market",
      "Trains and Phases",
      "Money and Wallets",
      "Pace and Clocks",
      "Project 18XX on Juno",
    ]);
  });

  it("every Rules Reference link names a real page", () => {
    const pages = ["overview", "stock", "operating", "auction", "tables"];
    for (const lesson of LESSONS) if (lesson.rules) expect([lesson.id, pages.includes(lesson.rules.page)]).toEqual([lesson.id, true]);
  });
});

describe("one copy of the words", () => {
  it("the coach and the library both read the registry and carry no lesson prose of their own", () => {
    const coach = readFileSync(join(__dirname, "TutorialCoach.tsx"), "utf8");
    const library = readFileSync(join(__dirname, "TutorialLibrary.tsx"), "utf8");
    expect(coach).toContain("lessonText(lesson, scope)");
    expect(library).toContain("lessonText(lesson, scope)");
    for (const lesson of LESSONS) {
      expect([lesson.id, coach.includes(lesson.summary), library.includes(lesson.summary)]).toEqual([lesson.id, false, false]);
    }
  });

  it("the old per-topic decks are gone", () => {
    expect(() => readFileSync(join(__dirname, "..", "components", "TutorialModal.tsx"), "utf8")).toThrow();
  });

  it("the content module is portable: it imports nothing", () => {
    const source = readFileSync(join(__dirname, "lessons.ts"), "utf8");
    expect(source).not.toMatch(/^import /m);
  });
});

describe("rules the content must state exactly (verified against the engine)", () => {
  it("an Operating turn is the engine's five steps, in order; buying a private is a side action, not a sixth", () => {
    const labels = OPERATING_SUB_PHASE_ORDER.map((step) => OPERATING_SUB_PHASE_LABELS[step].stepLabel);
    expect(labels).toEqual(["Lay Track", "Station Tokens", "Run Routes", "Dividends", "Buy Trains"]);
    const primer = allText(lessonById("operating.primer")!);
    expect(primer).toContain("five steps in order: Lay Track, Station Tokens, Run Routes, Dividends, Buy Trains.");
    expect(primer).toContain("That is a side action, not a sixth step.");
    for (const text of EVERY_TEXT) {
      expect(text).not.toContain("1. Buy Private Companies");
      expect(text).not.toMatch(/\b6\. Buy Trains/);
      expect(text).not.toMatch(/Steps 5 and 6/);
    }
    const steps = ["operating.track", "operating.tokens", "operating.routes", "operating.dividends", "operating.trains"];
    expect(steps.map((id) => lessonById(id)!.title)).toEqual([
      "Step 1: Lay Track",
      "Step 2: Station Tokens",
      "Step 3: Run Routes",
      "Step 4: Dividends",
      "Step 5: Buy Trains",
    ]);
  });

  it("every must-buy-a-train statement carries the canonical qualifier", () => {
    for (const text of EVERY_TEXT) {
      for (const sentence of text.split(/(?<=\.)\s+/)) {
        if (/must buy (one|a train)/i.test(sentence)) expect(sentence).toContain("with a legal route");
      }
    }
    expect(allText(lessonById("operating.trains")!)).toContain("A corporation with a legal route but no train must buy one.");
  });

  it("names Project 18XX and never presents the product as 1830", () => {
    expect(APP_NAME).toBe("Project 18XX");
    expect(allText(lessonById("orientation.goal")!)).toContain("Project 18XX is a railway game");
    expect(allText(lessonById("juno.edition")!)).toContain("Project 18XX");
    for (const text of EVERY_TEXT) expect(text).not.toContain("1830");
  });

  it("states no fee percentage, no challenge-window length and no internal settlement term", () => {
    for (const lesson of LESSONS.filter((entry) => entry.topic === "money" || entry.topic === "pace" || entry.topic === "juno")) {
      expect([lesson.id, /\d+(\.\d+)?\s*%/.test(allText(lesson))]).toEqual([lesson.id, false]);
    }
    for (const text of EVERY_TEXT) {
      expect(text).not.toMatch(/\bVGP\b/);
      expect(text).not.toMatch(/developer treasury|fee grant/i);
      expect(text).not.toMatch(/48.hour|same day/i);
    }
    const ante = allText(lessonById("money.ante")!);
    expect(ante).toContain("keeps a fee, set by the escrow, from every deposit; it is not refunded");
    expect(ante).toContain("Deposits on Juno are public");
  });

  it("the wallet lesson states the owner's same-wallet ruling", () => {
    const wallets = allText(lessonById("money.wallets")!);
    expect(wallets).toContain("never chosen as a game wallet for you");
    expect(wallets).toContain("The same wallet may serve both roles");
    expect(wallets).toContain("where that table's winnings are paid");
  });
});

describe("teaching style", () => {
  it("no cheerleading, no baby talk, sparing exclamation", () => {
    for (const text of EVERY_TEXT) {
      expect(text).not.toMatch(/great job|congratulations|well done|awesome/i);
      expect(text).not.toContain("!");
    }
  });

  it("the coach's summary stays short", () => {
    for (const lesson of LESSONS) {
      for (const delayed of [false, true]) {
        const { summary } = lessonText(lesson, { delayedAuction: delayed });
        expect([lesson.id, summary.length <= 330]).toEqual([lesson.id, true]);
      }
    }
  });
});
