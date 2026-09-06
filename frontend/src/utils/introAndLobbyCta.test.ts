/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1165-1166 (harness): NUMBERS PLACED OVER ART
// ==================================================================
//
// Both items in this batch put something on top of a picture, which makes them unusually easy to get wrong in
// a way no type checker can see: a title card over the wrong second covers the shot it was meant to
// introduce, and a button sized by feel drifts off the type scale the last batch spent its length rebuilding.
//
// SO THE TIMINGS WERE MEASURED RATHER THAN GUESSED. The clip is 10.006s and was sampled at nine points:
// blueprint linework to ~1s, the locomotive to ~4s, the map to ~6.5s, the Neta mark drawing to ~9s, then the
// finished mark. The opening is the only dark bed in it, which is what decides where the title goes.
//
// AND THE BUTTON'S 60% IS TAKEN ON THE CONTROL, NOT THE FONT: 12px x 1.6 is 19.2, there is no 19 on the
// scale, and #1151 has just finished deleting twelve values that were invented exactly that way.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const { FONT_SIZE } = require("../styles/typography") as typeof import("../styles/typography");
const { BRAND_PINK } = require("../styles/palette") as typeof import("../styles/palette");
const { CREDIT_WORDS } = require("../components/GameIntroOverlay") as typeof import("../components/GameIntroOverlay");

const BAR = readStripped("components/SandboxRoomBar.tsx");
const INTRO = readStripped("components/GameIntroOverlay.tsx");
const RAW_INTRO = require("fs").readFileSync(
  require("path").join(__dirname, "..", "components", "GameIntroOverlay.tsx"),
  "utf8",
) as string;

describe("the lobby's two doors read as doors", () => {
  it("grows the control rather than inventing a font size", () => {
    /* 12 x 1.6 = 19.2 and the scale has no 19. The presence comes from the padding, which is not a scale and
       was never meant to be -- the type steps to the next real rung. */
    const button = sliceBetween(BAR, "bareButton: {", "\n  },");
    expect(button).toContain("fontSize: FONT_SIZE.heading");
    expect(button).toContain('padding: "13px 30px"');
    expect(FONT_SIZE.heading).toBe("16px");
  });

  it("keeps #1136's rule that all four are one button", () => {
    /* Host, Join game, Join and Cancel share `bareButton` so none can read as lesser. They grow together;
       Cancel keeps only its quiet FILL. */
    expect(BAR).toContain("bareButtonQuiet: {");
    expect(sliceBetween(BAR, "bareButtonQuiet: {", "\n  },")).not.toContain("fontSize");
    expect(sliceBetween(BAR, "bareButtonQuiet: {", "\n  },")).not.toContain("padding");
  });

  it("hovers in the brand's own colour, from the token", () => {
    /* "Strictly within the Neta DAO design tokens." #1092 took the pink from Neta's own stylesheet rather
       than from the logo, so this is quotable rather than approximate -- and it is read from the export, not
       retyped. */
    expect(BRAND_PINK).toBe("#C9338A");
    expect(RAW_INTRO.length).toBeGreaterThan(0);
    expect(BAR).toContain("border-color: ${BRAND_PINK}");
  });

  it("asks the browser whether it can hover", () => {
    /* A `:hover` on a touch screen fires on tap and STICKS until something else is touched, so the pressed
       button stays lit. #1148 hit this on the float badge; the media query is the fix there and here. */
    expect(BAR).toContain("@media (hover: hover) and (pointer: fine)");
  });
});

describe("the intro sequence gains a beginning and an end", () => {
  it("holds the finished mark instead of cutting on the last frame", () => {
    /* `onEnded` went straight to `finish`, so the completed mark was on screen for a frame. A video element
       holds its last frame when it stops, which is what makes this a delay rather than a second render. */
    expect(INTRO).toContain("onEnded={holdEnded}");
    expect(INTRO).toContain("window.setTimeout(finish, LOGO_HOLD_MS)");
  });

  it("holds it for the one-to-two seconds that were asked for", () => {
    const hold = Number((RAW_INTRO.match(/const LOGO_HOLD_MS = (\d+);/) ?? [])[1]);
    expect(hold).toBeGreaterThanOrEqual(1000);
    expect(hold).toBeLessThanOrEqual(2000);
  });

  it("leaves the backstop clear of the clip plus the hold", () => {
    /* The backstop exists for an engine that never fires `onEnded`. If it were shorter than the clip and the
       new hold together it would cut the credit off mid-fade on a machine where the event is merely LATE. */
    const backstop = Number((RAW_INTRO.match(/const INTRO_BACKSTOP_MS = (\d+);/) ?? [])[1]);
    const hold = Number((RAW_INTRO.match(/const LOGO_HOLD_MS = (\d+);/) ?? [])[1]);
    /* Design note #1186: 13042, not 10006 -- the film is the wordmark (4.011s) cross-faded over 1.000s into
       the original (10.006s). Same claim, longer film. */
    expect(backstop).toBeGreaterThan(13042 + hold);
  });

  it("no longer draws a title card, because the film carries the title", () => {
    /* ==================================================================
        DESIGN NOTE 1186: SEVEN CASES RETIRED WITH THE ELEMENT THEY GUARDED
       ==================================================================
       #1166 through #1166d spent seven cases and a great deal of frame-by-frame measurement deciding where a
       Project 18XX card could sit over footage that had no title of its own: which half second was darkest,
       how long it could hold before competing with the locomotive, whether a transparent card was the old
       arrangement wearing the new note.
       THE SUPPLIED CLIP ANSWERS ALL OF IT BY OPENING ON THE TITLE. So the card, its constants, its keyframes,
       its `screen` blend and its reduced-motion arm are gone -- and the cases that pinned them go too, rather
       than being loosened into assertions that no longer mean anything.
       ONE TRIPWIRE REPLACES THEM, and it is #1166's own warning read from the other direction: "a second
       rendering of the title would be a second thing to keep in step." */
    expect(INTRO).not.toContain("styles.titleCard");
    expect(INTRO).not.toContain("styles.titleArt");
    expect(INTRO).not.toContain("app-intro-title");
    /* AGAINST THE STRIPPED SOURCE, NOT THE RAW FILE: the note above the deleted constants NAMES them, which
       is that note's whole job. Asserting on `RAW_INTRO` would forbid the prose from describing its own
       removal -- the `readStripped` / `readSource` distinction pointing the other way for once. */
    expect(INTRO).not.toContain("TITLE_FADE_MS");
    /* The ASSET stays. The Lobby still draws it (#1131), and deleting a file two surfaces share to tidy one
       of them is how the other breaks. */
    expect(readStripped("components/Lobby.tsx")).toContain("title-project18xx.jpg");
  });

  it("does not gamble on a delayed play()", () => {
    /* THE OBVIOUS READING IS TO HOLD PLAYBACK, and that puts a programmatic `play()` inside a timer -- fine on
       a muted element, a gamble on an unmuted one, and this clip runs unmuted whenever effects are on. Covering
       a clip that is already playing has neither problem. */
    expect(INTRO).toContain("autoPlay");
    expect(INTRO).not.toContain(".play()");
  });

  it("positions the overlays against the picture, not the window", () => {
    /* THE VIDEO IS `object-fit: contain`, so on any viewport that is not 16:9 it is letterboxed and a
       percentage of the overlay is not a percentage of the artwork. The stage reproduces the contain box, so
       the numbers below mean what they say. */
    const stage = sliceBetween(INTRO, "stage: {", "\n  },");
    expect(stage).toContain('aspectRatio: "16 / 9"');
    expect(stage).toContain('maxHeight: "100%"');
    expect(INTRO).toContain("<div style={styles.stage}>");
  });

  it("clears the mark it sits under, measured from the frame", () => {
    /* SAMPLED FROM THE FINAL FRAME: the completed mark occupies 28% to 72% of the height. 68% -- the first
       value -- was inside it before letterboxing was even considered. */
    const credit = sliceBetween(INTRO, "credit: {", "\n  },");
    const top = Number((credit.match(/top: "(\d+)%"/) ?? [])[1]);
    expect(top).toBeGreaterThan(72);
  });

  it("reveals the credit a word at a time, left to right", () => {
    /* "Fading in from left to right, with each letter/word appearing in sequence." Words rather than letters:
       twenty-odd letters inside the cue is a stutter, four words is writing appearing. */
    expect(INTRO).toContain("animationDelay: `${index * CREDIT_WORD_STAGGER_MS}ms`");
  });

  it("says what the rest of the app says", () => {
    /* ASKED: "do you think 'brought to you' is right here when we've used 'powered by' everywhere else?" It
       is not -- `AppFooter` carries "Powered by Neta DAO" on all three screens, and this clip plays BETWEEN
       two of them. #961a already ruled on one fact carrying two names across screens a player reads in
       sequence. Asserted against the FOOTER rather than against a literal, so the two cannot drift apart. */
    expect(INTRO).toContain('CREDIT_WORDS = ["Powered", "by", "Neta", "DAO"]');
    expect(readStripped("components/AppFooter.tsx")).toContain(CREDIT_WORDS.join(" "));
  });

  it("cues the credit off the picture's own clock, not a timer", () => {
    /* A `setTimeout` from play start drifts the moment the clip stutters or begins late, and would then put
       the words against a frame they were not written for. `currentTime` cannot drift from the picture. */
    expect(INTRO).toContain("event.currentTarget.currentTime >= CREDIT_CUE_SECONDS");
    expect(INTRO).toContain("onTimeUpdate={onTimeUpdate}");
  });

  it("lands the credit on the mark being drawn rather than after it", () => {
    /* MEASURED: the mark draws from ~7.5s and resolves by ~9.5s. The cue plus four staggered words plus the
       fade must finish inside that window, or the line is arriving at a still frame again -- which is the
       thing this replaced. */
    const cue = Number((RAW_INTRO.match(/const CREDIT_CUE_SECONDS = ([\d.]+);/) ?? [])[1]) * 1000;
    const stagger = Number((RAW_INTRO.match(/const CREDIT_WORD_STAGGER_MS = (\d+);/) ?? [])[1]);
    const finishes = cue + stagger * (CREDIT_WORDS.length - 1) + 320;
    /* Design note #1186: the window moved three seconds later with the footage it describes -- the prepend is
       4.011s cross-faded over 1.000s, so the original's timeline starts at output t=3.011. The mark still
       draws from ~10.5s and resolves by ~12.5s; only its arrival time changed. */
    expect(cue).toBeGreaterThan(10500);
    expect(finishes).toBeLessThan(12600);
  });

  it("still shows the credit if the engine never fires timeupdate", () => {
    /* A cue that can only fail CLOSED: the end of the clip raises it too, which is one beat late and exactly
       the behaviour before the sync. */
    expect(INTRO).toContain("{creditVisible && (");
    const hold = sliceBetween(INTRO, "const holdEnded = React.useCallback(() => {", "}, [finish]);");
    expect(hold).toContain("setCreditVisible(true)");
  });

  it("can still be skipped through the hold", () => {
    /* `finish` is unchanged and every path still runs through it. A hold that could not be skipped would make
       the last two seconds the one unskippable part of a skippable sequence. */
    expect(INTRO).toContain("if (finished.current) return;");
    expect(INTRO).toContain("onClick={finish}");
  });
});
