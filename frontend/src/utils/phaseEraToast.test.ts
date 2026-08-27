/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 868 (harness): GOOD NEWS ARRIVES, IT IS NOT COUNTED DOWN TO
// ==================================================================
//
// SPECIFIED: "the meaningful era change information (Green Tiles are now available, Brown Tiles are now
// available) could be a toast notification to every player when the threshold is crossed. The Rust and Limit
// warnings restrict what players can do, the Era change expands their repertoires."
//
// THE ERA TABLE IS THE PRECONDITION, so it is checked first: a toast fires on a CHANGE, and the set of
// changes is a property of `TIER_PRESENTATION`. Two toasts in an 1830 game, not five.

import { tierEra } from "./gamePhase";
import type { TrainTier } from "./gamePhase";

const TIERS: readonly TrainTier[] = ["2", "3", "4", "5", "6", "D"];

const read = (rel: string) => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
};

describe("the era changes exactly twice", () => {
  it("turns at 2 to 3 and at 4 to 5, and nowhere else", () => {
    /* THE WHOLE REASON A TOAST IS THE RIGHT SURFACE: it fires twice in a game, which is rare enough to be an
       event and frequent enough to matter. A badge counting down to it would be on screen for a large share
       of the game saying something a player can do nothing about. */
    const turns = TIERS.slice(1)
      .map((tier, index) => [TIERS[index], tier] as const)
      .filter(([from, to]) => tierEra(from) !== tierEra(to))
      .map(([from, to]) => `${from}->${to}`);
    expect(turns).toEqual(["2->3", "4->5"]);
  });

  it("keeps Diesel inside Brown", () => {
    // #612: the era names a TILE COLOUR and there is no diesel-coloured tile.
    expect(tierEra("D")).toBe("Brown");
    expect(tierEra("6")).toBe("Brown");
  });
});

describe("the shell announces it once, when it lands", () => {
  const APP = read("App.tsx");
  const CODE = APP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("says what became possible, in the present tense", () => {
    /* THE SENTENCE THE REPORT ASKED FOR, near enough to quote: "Green Tiles are now available, Brown Tiles
       are now available". Present tense because the toast fires at the moment it is true -- which is the
       difference between this and the badge it replaced. */
    const dollar = String.fromCharCode(36);
    expect(CODE).toContain(
      "`" + dollar + "{eraNow} Tiles are now available.`",
    );
  });

  it("fires on a CHANGE, never on the first thing it sees", () => {
    /* THE SUBTLETY THAT MATTERS MOST. On a page load, a refresh, or a client joining mid-game the ref starts
       empty and the era is simply whatever it already is. Without this guard the app would announce "Green
       Tiles are now available" to somebody who has been laying green tiles for an hour -- and it would do it
       on every refresh. */
    expect(CODE).toContain("const previous = lastEraRef.current;");
    expect(CODE).toContain("if (previous === null || previous === eraNow) return;");
    /* AND THE REF IS WRITTEN BEFORE THE GUARD, so an early return still records what was seen. Writing it
       after would leave the ref empty forever and the toast would never fire at all. */
    const at = CODE.indexOf("lastEraRef.current = eraNow;");
    const guard = CODE.indexOf("if (previous === null || previous === eraNow) return;");
    expect(at).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(at);
  });

  it("reaches every player rather than only the buyer", () => {
    /* `showDividendToast` on #738's own distinction: `showActionToast` is a receipt for YOUR dispatch, this
       is a notification about a change in the world. Every client derives the era from the same state, so
       every client fires its own. */
    const at = CODE.indexOf("if (previous === null || previous === eraNow) return;");
    expect(at).toBeGreaterThan(-1);
    const body = CODE.slice(at, at + 400);
    expect(body).toContain("showDividendToast(");
    expect(body).not.toContain("showActionToast(");
  });

  it("derives the era rather than waiting for a message", () => {
    /* NO WIRE FORMAT FOR THIS, deliberately: the era is a function of the highest train in play (#1), so a
       message would be a second source for a fact already in `gameState` -- and the two could disagree. */
    expect(CODE).toContain("const eraNow = currentPhase ? tierEra(currentPhase.tier) : null;");
  });

  it("keeps the replay guard #825 installed upstream", () => {
    /* Nothing has just happened during a rebuild. The guard lives inside `showDividendToast`, so this
       asserts the toast goes through that door rather than around it. */
    const at = CODE.indexOf("const showDividendToast");
    expect(at).toBeGreaterThan(-1);
    expect(CODE.slice(at, at + 300)).toContain("if (replayingHistory) return;");
  });
});
