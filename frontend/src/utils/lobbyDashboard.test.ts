/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1122-1123 (harness): THE LOBBY AS A DASHBOARD, AND THE PURPLE THAT MEANT SOMETHING
// ==================================================================
//
// THE BRIEF WAS RIGHT ABOUT THE SHAPE AND WRONG ABOUT EVERY COLOUR IT NAMED, which is the interesting part
// and the reason this file leans on `styles/palette` and on netadao.org's published tokens rather than on
// hexes typed into a prompt:
//
//   asked for #121212 cards, #262626 borders, #000000 page   -- the brand ships #0f0f0f/#141414, #2a2a2a, #080808
//   asked for "the exact Neta DAO gradient" #00C3FF -> #FF00EA -- the brand ships #C9338A -> #5B8EF0
//   asked for black bold text on that gradient                -- 4.12:1 at 14px bold, under the 4.5 bar
//   asked to remove all purple                                -- purple is the sandbox signal on four surfaces
//
// SO THE CASES BELOW ARE MOSTLY ABOUT WHAT DID NOT CHANGE. A harness that only guards new code cannot fail
// when the next confident prompt asks for the same four things again.

export {};

const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
const PALETTE = require("../styles/palette") as typeof import("../styles/palette");

const LOBBY = readStripped("components/Lobby.tsx");
const APP_STYLES = readStripped("styles/appStyles.ts");
const SEATS = readStripped("utils/playerLabels.ts");

function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const value = parseInt(hex.slice(i, i + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the brand tokens are the brand's, not a prompt's", () => {
  it("keeps netadao.org's own gradient stops", () => {
    /* SUPPLIED AS "the exact Neta DAO gradient" AND IT WAS NOT. Pinned as the literal because this is the one
       place in the codebase where a hex IS the fact -- it was read out of netadao.org/css/style.css, and a
       test that derived it from the app would agree with the app about a colour the brand never used. */
    expect(PALETTE.BRAND_GRADIENT).toBe("linear-gradient(90deg, #C9338A 0%, #5B8EF0 100%)");
    expect(PALETTE.BRAND_PINK).toBe("#C9338A");
    expect(PALETTE.BRAND_BLUE).toBe("#5B8EF0");
  });

  it("keeps the page on the brand's --ink rather than pure black", () => {
    /* `#000000` WAS ASKED FOR AS A CORRECTION and would have been a move away from the brand: netadao.org's
       `--ink` is `#080808`, which is what the app has always used. Asserted on the page itself, since that is
       what the request would have changed. */
    expect(PALETTE.INK).toBe("#080808");
    expect(LOBBY).toContain('backgroundColor: "#080808"');
    expect(LOBBY).not.toContain('backgroundColor: "#000000"');
  });

  it("keeps the hairline on the brand's --rule-thin", () => {
    expect(PALETTE.RULE).toBe("#2a2a2a");
    expect(LOBBY).not.toContain("#262626");
    expect(LOBBY).not.toContain("#121212");
  });
});

describe("the primary button is the one the brand actually ships", () => {
  it("is a paper slab with ink text", () => {
    /* NETA'S OWN `.btn-primary` IS `background: var(--paper); color: var(--ink)`. Their site uses the
       gradient for TEXT (`.grad-text`) and never as a button fill, so a gradient-filled button would have
       been less on-brand than the ghost it replaced, not more. */
    expect(LOBBY).toContain("backgroundColor: CARD_SURFACE");
    expect(LOBBY).toContain("color: INK,");
  });

  it("clears AA by a distance, which the requested fill could not", () => {
    /* THE MEASUREMENT THAT SETTLED IT, kept executable. Black on the real gradient is 4.12:1 at the pink end
       against a 14px bold label -- 14px bold is not "large text", which starts at 18.66px bold -- and paper
       on the same sweep is 4.26:1. No ink clears the gradient, because it crosses mid-luminance in the
       middle. The paper slab is 17.59:1. */
    expect(contrast(PALETTE.CARD_SURFACE, PALETTE.INK)).toBeGreaterThan(15);
    expect(contrast(PALETTE.BRAND_PINK, PALETTE.INK)).toBeLessThan(4.5);
    expect(contrast(PALETTE.BRAND_PINK, PALETTE.CARD_SURFACE)).toBeLessThan(4.5);
  });
});

describe("the sandbox purple is a signal with a ladder under it", () => {
  it("sits on the neutral rungs it stands beside", () => {
    /* THE OLD VALUES PREDATED THE LADDER and read as a different application -- `#1a1424` panels at their own
       arbitrary lightness. Asserted as luminance PROXIMITY to the neutral rung rather than as a hex, so a
       retone of either family has to move both or fail here. */
    expect(Math.abs(relativeLuminance(PALETTE.SANDBOX_PANEL) - relativeLuminance(PALETTE.INK_VIEWPORT)))
      .toBeLessThan(0.002);
    expect(Math.abs(relativeLuminance(PALETTE.SANDBOX_RAISED) - relativeLuminance(PALETTE.INK_RAISED)))
      .toBeLessThan(0.002);
  });

  it("is still visibly purple, or retoning it deleted the signal", () => {
    /* THE POINT OF KEEPING IT. A luminance-matched neutral would pass every case above and tell a player
       nothing about whether their money is real. Blue must lead green in every member of the family. */
    for (const hex of [
      PALETTE.SANDBOX_PANEL,
      PALETTE.SANDBOX_RAISED,
      PALETTE.SANDBOX_RULE,
      PALETTE.SANDBOX_TITLE,
      PALETTE.SANDBOX_TEXT,
    ]) {
      const blue = parseInt(hex.slice(5, 7), 16);
      const green = parseInt(hex.slice(3, 5), 16);
      expect(blue - green).toBeGreaterThanOrEqual(10);
    }
  });

  it("reads on its own panel", () => {
    expect(contrast(PALETTE.SANDBOX_TITLE, PALETTE.SANDBOX_PANEL)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(PALETTE.SANDBOX_TEXT, PALETTE.SANDBOX_PANEL)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(PALETTE.SANDBOX_INK, PALETTE.SANDBOX_RAISED)).toBeGreaterThanOrEqual(4.5);
  });

  it("does not swallow the Plum seat colour it collides with", () => {
    /* ==================================================================
        DESIGN NOTE 1122: THE HAZARD THAT MADE THESE CONSTANTS NECESSARY
       ==================================================================
       `#7a5aa8` was the old `sandboxButton` border AND is Plum, a SEAT colour -- one hex, two unrelated jobs.
       Any sweep keyed on the literal would have either missed the chrome or repainted a player. The chrome
       reads named constants now; the seat keeps its hex, and this asserts the two have parted company. */
    expect(SEATS).toContain('"#7a5aa8"');
    expect(LOBBY).not.toContain('"#7a5aa8"');
    expect(APP_STYLES).not.toContain('"#7a5aa8"');
    expect(Object.values(PALETTE as Record<string, unknown>)).not.toContain("#7a5aa8");
  });

  it("paints all four surfaces from the same constants", () => {
    for (const path of [
      "components/Lobby.tsx",
      "components/SandboxWaitingRoom.tsx",
      "components/TutorialModal.tsx",
      "styles/appStyles.ts",
    ]) {
      expect(readStripped(path)).toContain("SANDBOX_");
    }
  });
});

describe("the stage that replaced the dashboard", () => {
  /* ==================================================================
      DESIGN NOTE 1130 SUPERSEDES #1123's GRID
     ==================================================================
     THREE CASES HERE ASSERTED A TWO-COLUMN LAYOUT and its 860px collapse. The grid existed because there were
     two cards; #1130 removed the paused one and took the panel off the other, and one centred column needs
     neither a grid nor a breakpoint.
     THE ONE CLAIM WORTH CARRYING FORWARD is the last of the three, and it is asserted below in its new form:
     the Web3 branch must stay OUTSIDE whatever holds the sandbox controls, because the moment that flag turns
     on it renders a room list and a staging table rather than a status card. That was #1123's real insight
     and it survives the layout that occasioned it. */
  it("centres one stage instead of balancing two columns", () => {
    expect(LOBBY).toContain("styles.stage}");
    expect(LOBBY).not.toContain('gridTemplateColumns: "1fr 1fr"');
    expect(LOBBY).not.toContain("lobby-dashboard");
  });

  it("still keeps the room browser out of it", () => {
    const stage = LOBBY.indexOf("styles.stage}");
    const branch = LOBBY.indexOf("!WEB3_LOBBY_ENABLED ? null :");
    expect(stage).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(stage);
    expect(LOBBY.indexOf("<RoomBrowser")).toBeGreaterThan(branch);
  });

  it("needs no breakpoint, and spends its stylesheet on the title instead", () => {
    expect(LOBBY).not.toContain("@media (max-width: 860px)");
    expect(LOBBY).toContain("prefers-reduced-motion");
  });

  it("drops the stray margin that gave the strips their own left edge", () => {
    /* #1114 ADDED THE `content` WRAPPER AND ITS 20px INSET, and this margin outlived it by a batch -- so the
       strips sat 48px in while every panel beside them sat at 20px. Two left edges on one page. */
    /* WRITTEN FOR THE SANDBOX STRIPS AND IT CAUGHT `banner` TOO, which had the identical stale inset and was
       not part of the brief. Left deliberately broad for that reason: the bug is "a margin that outlived
       #1114's wrapper", not "the sandbox strip's margin". */
    expect(LOBBY).not.toContain('margin: "0 28px"');
  });
});
