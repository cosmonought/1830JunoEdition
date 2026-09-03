/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1124 (harness): TWO BOARDROOMS, TWO JOBS, AND A MARK BIG ENOUGH TO MOVE
// ==================================================================
//
// THE QUESTION WAS "which screen gets the boardroom", and the answer was that there are two boardrooms and
// they are not interchangeable:
//
//   the EMPTY room    -> waiting room. The room is empty because nobody has sat down. Picture agrees with label.
//   the OCCUPIED room -> lobby header. A front door sells the thing you are about to do.
//
// Putting the occupied room in the waiting room would have the picture say "the meeting is underway" while
// the UI says "waiting for players" -- which is the failure this file guards against, since it is invisible
// to anything that only checks that a background exists.

export {};

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const LOBBY = readStripped("components/Lobby.tsx");
const WAITING = readStripped("components/SandboxWaitingRoom.tsx");
const FOOTER = readStripped("components/AppFooter.tsx");

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

describe("the two boardrooms stay on their own screens", () => {
  it("ships both images", () => {
    for (const file of ["images/lobby-boardroom.jpg", "images/waiting-room.jpg"]) {
      expect(fs.existsSync(path.join(PUBLIC_DIR, file))).toBe(true);
    }
  });

  it("gives the lobby the occupied room and the waiting room the empty one", () => {
    /* THE CROSS-CHECK IS THE POINT. Each surface naming its own asset would pass while both pointed at the
       same file; asserting that neither names the OTHER's is what actually holds them apart. */
    expect(LOBBY).toContain("/images/lobby-boardroom.jpg");
    expect(LOBBY).not.toContain("/images/waiting-room.jpg");
    expect(WAITING).toContain("/images/waiting-room.jpg");
    expect(WAITING).not.toContain("/images/lobby-boardroom.jpg");
  });

  it("keeps the hero small enough to sit on a first paint", () => {
    /* THE LOBBY IS THE FIRST SCREEN AND NOTHING IS CACHED YET, which was the main argument against putting a
       photo on it at all. 98KB is the price that made the band worth it; a full-page version of the same
       picture would not have been. */
    const bytes = fs.statSync(path.join(PUBLIC_DIR, "images/lobby-boardroom.jpg")).size;
    expect(bytes).toBeLessThan(180 * 1024);
  });
});

describe("the header band earns its scrim", () => {
  it("layers a gradient over the photo rather than trusting the photo", () => {
    /* MEASURED AGAINST THE BRIGHTEST PIXEL under the title, not against an average: paper 8.00:1, the dim
       subtitle 5.33:1. The band deepens downward so it settles into the page instead of ending on a line. */
    expect(LOBBY).toContain("linear-gradient(rgba(8, 8, 8, 0.70), rgba(8, 8, 8, 0.82))");
  });

  it("keeps a flat fallback under the image", () => {
    // What shows before 98KB decodes, and on any load where it never does.
    expect(LOBBY).toContain('backgroundColor: "#1c1c1c"');
  });

  it("leaves the body of the lobby on flat tokens", () => {
    /* #1123 MEASURED TWO COLUMNS OF CARDS AGAINST FLAT GROUNDS and a full-bleed photo would have put every
       one of those figures against a varying one. The picture is allowed exactly one element -- the header,
       which carries no body text. Asserted by count: one background image on this screen, not two. */
    expect(LOBBY.split("backgroundImage:").length - 1).toBe(1);
  });
});

describe("the animated mark is big enough to read as motion", () => {
  it("sizes by surface, the way `animated` already does", () => {
    expect(FOOTER).toContain("const GAME_MARK_HEIGHT = 18;");
    expect(FOOTER).toContain("const META_MARK_HEIGHT = 36;");
    expect(FOOTER).toContain('surface === "meta" ? META_MARK_HEIGHT : GAME_MARK_HEIGHT');
  });

  it("leaves the board's footer exactly where #1099 put it", () => {
    /* ==================================================================
        DESIGN NOTE 1124: WHY #1116's REFUSAL DOES NOT APPLY HERE
       ==================================================================
       #1116 turned down a bigger element because "a 36px box in an 18px line is a taller footer on every
       screen" -- and ON EVERY SCREEN was the part that was too broad. The game footer draws the STILL image,
       so growing the moving one cannot reach it, and the real objection was a tall footer full of movement
       under a hex map where an eye is counting revenue.
       THIS CASE IS THAT DISTINCTION, kept executable: the board's height is still 18. */
    expect(FOOTER).toContain("const GAME_MARK_HEIGHT = 18;");
    expect(META_OVER_GAME()).toBe(2);
  });

  it("still gives the board the still mark, so the two changes stay independent", () => {
    expect(FOOTER).toContain('animated={surface === "meta"}');
  });
});

/** The doubling that was asked for, derived rather than restated -- so changing either constant changes the
 *  number this case reports instead of leaving a stale "2x" written down in a comment. */
function META_OVER_GAME(): number {
  const meta = Number(/META_MARK_HEIGHT = (\d+)/.exec(FOOTER)?.[1]);
  const game = Number(/GAME_MARK_HEIGHT = (\d+)/.exec(FOOTER)?.[1]);
  return meta / game;
}
