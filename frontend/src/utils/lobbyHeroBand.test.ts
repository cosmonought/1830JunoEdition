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
const APP_STYLES = readStripped("styles/appStyles.ts");

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
    /* THE LOBBY IS THE FIRST SCREEN AND NOTHING IS CACHED YET. #1124 held this to 180KB on the reasoning that
       "a full-page version of the same picture would not have been" worth it -- and the full page is what got
       built, so the number moves and the REASON does not. 189KB at 1920x1072/q80 is what the whole room costs;
       the ceiling stays close enough that a careless re-export still fails here. */
    const bytes = fs.statSync(path.join(PUBLIC_DIR, "images/lobby-boardroom.jpg")).size;
    expect(bytes).toBeLessThan(260 * 1024);
  });
});

describe("the room is the page, and the text carries its own ground", () => {
  it("puts the picture on the page rather than in a band", () => {
    /* ==================================================================
        DESIGN NOTE 1129 SUPERSEDES #1124 ON PLACEMENT
       ==================================================================
       THE THREE CASES HERE USED TO ASSERT A BAND -- a 0.70/0.82 scrim, a `#1c1c1c` fallback, and "exactly one
       background image, because the body stays on flat tokens". All three were right about a header strip and
       all three describe a design that could not work: a header is ~15:1 on a wide window against a 5.3:1
       band, so `cover` kept the middle third and the middle third is foreheads.
       THE BODY-ON-FLAT-TOKENS RULE IS THE ONE WORTH RE-EXAMINING, since it was my argument against exactly
       this change. It was about CONTRAST, and the cards answer it a different way now: they are 0.92-opaque
       over the scrimmed photo, and the ink was re-measured against that blend rather than against the token
       (title 8.87:1, note 6.15:1). The rule held; the way of satisfying it moved. */
    expect(LOBBY).toContain("linear-gradient(rgba(8, 8, 8, 0.48), rgba(8, 8, 8, 0.48))");
    expect(LOBBY).toContain('backgroundAttachment: "fixed"');
  });

  it("needs no plate, because the title sits where the room is darkest", () => {
    /* ==================================================================
        DESIGN NOTE 1130 SUPERSEDES #1129's PLATE
       ==================================================================
       THIS ASSERTED THE PLATE ONE TURN AGO, and the plate was the right answer to the question then being
       asked: a light page scrim plus text on an unknown ground. What changed is that the ground stopped being
       unknown. The wordmark sits at the TOP of the picture, which is coffered ceiling and dark panelling --
       worst pixel L 0.026, gilt 6.08:1 unaided -- so the plate was protecting text that did not need it and
       printing a grey rectangle onto a photograph to do it.
       THE PAGE SCRIM IS UNCHANGED AT 0.48, which is the part of #1129 that still holds and is asserted above:
       the reason it could drop from 0.70 was local contrast, and the top of the frame supplies that for free
       where the plate used to supply it deliberately. */
    expect(LOBBY).not.toContain("styles.brandHeaderInner");
    expect(LOBBY).not.toContain('backgroundColor: "rgba(8, 8, 8, 0.55)"');
    // What replaced it: a shadow on the one line of text that is not the artwork.
    expect(LOBBY).toContain('textShadow: "0 1px 3px rgba(8, 8, 8, 0.9)"');
  });

  it("keeps the gilt readable even where the clip is unsupported", () => {
    /* THE ONE WAY THIS TECHNIQUE FAILS SILENTLY. An engine without `background-clip: text` also lacks
       `-webkit-text-fill-color`, so the transparent fill never lands and `color` shows -- but only if `color`
       was set. A gradient alone renders an invisible title.
       Design note #1130: the CSS gilt is the FALLBACK now rather than the title, and both guards still
       matter -- it is what renders when the artwork 404s. */
    expect(LOBBY).toContain('color: "#e8c877"');
    expect(LOBBY).toContain('WebkitBackgroundClip: "text"');
    expect(LOBBY).toContain('backgroundClip: "text"');
  });

  it("draws the wordmark by keying it, and keeps a title when it fails", () => {
    /* ==================================================================
        DESIGN NOTE 1130: TWO FAILURE MODES, BOTH SILENT WITHOUT THIS
       ==================================================================
       An `<img>` that 404s renders nothing, and the heading beside it is clipped for screen readers -- so a
       missing asset would have produced a lobby with no visible title at all. `onError` is what turns that
       into the CSS gilt instead.
       AND THE BLEND IS LOAD-BEARING: without `screen` the artwork is a black rectangle pasted on the room,
       because the file is a JPEG and has no alpha to cut it out with. */
    expect(LOBBY).toContain('mixBlendMode: "screen"');
    expect(LOBBY).toContain("onError={() => setTitleArtFailed(true)}");
    expect(LOBBY).toContain("titleArtFailed ? styles.brandTitle : styles.srOnlyTitle");
    // The name stays in the document either way -- an image cannot be selected, searched, or spoken.
    expect(LOBBY).toContain("<h1 style={titleArtFailed");
  });

  it("ships the wordmark, keyed to true black and small enough to sit beside the room", () => {
    const p = path.join(PUBLIC_DIR, "images/title-project18xx.jpg");
    expect(fs.existsSync(p)).toBe(true);
    // 94KB against the 189KB room. The "it will make the site slow" objection, measured.
    expect(fs.statSync(p).size).toBeLessThan(130 * 1024);
  });

  it("has no card left in the middle of the screen", () => {
    /* Design note #1130 SUPERSEDES #1123's GRID: one centred stage, no panel around it, and the two-column
       breakpoint gone with the second card. The `sandboxStrip` style survives because `StagingRoom` still
       uses it -- so this asserts the LAYOUT is gone, not the token. */
    expect(LOBBY).not.toContain("lobby-dashboard");
    expect(LOBBY).not.toContain("styles.dashboardColumn");
    expect(LOBBY).toContain("styles.stage}");
  });

  it("moves the account furniture to its own corner", () => {
    expect(LOBBY).toContain("styles.utilityRow");
    // The paused card's sentence survives where a developer will look and a player will not.
    expect(LOBBY).not.toContain("On-chain rooms — paused");
    expect(LOBBY).toContain("WEB3_LOBBY_ENABLED in Lobby.tsx to bring them back");
  });
});

describe("the animated mark is big enough to read as motion", () => {
  it("sizes by surface, the way `animated` already does", () => {
    expect(FOOTER).toContain("const GAME_MARK_HEIGHT = 18;");
    // #1124 guessed 2x and overshot; #1129 settles at 1.7x. Asserted as the ratio, below.
    expect(FOOTER).toContain("const META_MARK_HEIGHT = 31;");
    expect(FOOTER).toContain('surface === "meta" ? META_MARK_HEIGHT : GAME_MARK_HEIGHT');
  });

  it("scales the words with the mark, so the pair stays one object", () => {
    /* REPORTED WITH THE SIZE: "make sure the 'Powered by Neta DAO' is centred to the animated logo so that it
       reads as a single unit". The alignment was already right -- the orbit's ink sits within half a pixel of
       its frame's centre -- so what made them read as two things was the scale gap. */
    expect(FOOTER).toContain("styles.netaCreditMeta");
    expect(APP_STYLES).toContain("netaCreditMeta:");
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
    // The doubling asked for in #1124, dialled to the 1.7 asked for in #1129. Derived, not restated.
    expect(META_OVER_GAME()).toBeCloseTo(1.7, 1);
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
