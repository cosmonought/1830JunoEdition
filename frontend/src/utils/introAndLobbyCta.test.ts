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
    expect(backstop).toBeGreaterThan(10006 + hold);
  });

  it("opens on a black screen the clip has to come out from behind", () => {
    /* ==================================================================
        DESIGN NOTE 1166d: THE CARD STOPPED COMPETING WITH THE ARTWORK
       ==================================================================
       Every earlier version placed the title ON the drawing and looked for the least-bad moment to do it. An
       opaque half second covers nothing -- and the cost is measurable and tiny: 4.6% of the frame is lit at
       0.6s, so what the cover hides is black.
       ASSERTED AS OPACITY AND EXTENT. A transparent card over the same seconds is the old arrangement wearing
       the new note. */
    const card = sliceBetween(INTRO, "titleCard: {", "\n  },");
    expect(card).toContain('backgroundColor: "#000000"');
    expect(card).toContain("inset: 0");
    expect(INTRO).toContain('<div className="app-intro-title" style={styles.titleCard}>');
  });

  it("does not gamble on a delayed play()", () => {
    /* THE OBVIOUS READING IS TO HOLD PLAYBACK, and that puts a programmatic `play()` inside a timer -- fine on
       a muted element, a gamble on an unmuted one, and this clip runs unmuted whenever effects are on. Covering
       a clip that is already playing has neither problem. */
    expect(INTRO).toContain("autoPlay");
    expect(INTRO).not.toContain(".play()");
  });

  it("fades the title and its ground as one element", () => {
    /* Two layers on two clocks produce a title floating over a half-faded backdrop the first time either is
       retuned. The card is the black screen, so there is only one clock. */
    expect(INTRO).toContain("styles.titleArt");
    const art = sliceBetween(INTRO, "titleArt: {", "\n  },");
    expect(art).not.toContain("position:");
    expect(art).toContain('mixBlendMode: "screen"');
  });

  it("clears the title as the drawing gets going, not a second after", () => {
    /* ==================================================================
        DESIGN NOTE 1166c TIGHTENS THIS FROM 3000ms TO THE MEASURED FIGURE
       ==================================================================
       IT ALLOWED ANYTHING UNDER 3s, on #1166's reading that the locomotive "draws and holds, ~1.0 to ~4.0" --
       so it passed comfortably on a card that sat over a FINISHED drawing for about a second, which is what
       was then reported. A still at 3s cannot distinguish drawing from holding; measuring the lit area can,
       and puts completion at about 1.3s (4.6% of the frame at 0.6s, 15.0% at 1.0s, 20.7% at 1.5s, 22.7% at
       2.2s -- the curve is flat well before 2s).
       BOUNDED ON THE REAL EVENT NOW. A bound that cannot fail on the thing it is named for is not a bound. */
    const holdUntil = Number((RAW_INTRO.match(/const TITLE_HOLD_UNTIL_MS = (\d+);/) ?? [])[1]);
    const fade = Number((RAW_INTRO.match(/const TITLE_FADE_MS = (\d+);/) ?? [])[1]);
    const fadeIn = Number((RAW_INTRO.match(/const TITLE_FADE_IN_MS = (\d+);/) ?? [])[1]);
    /* Design note #1166d: the bound is tighter again now that the card owns its own beat -- it must be gone
       while the drawing is still early, which is the whole point of giving it a half second of its own. */
    expect(holdUntil + fade).toBeLessThanOrEqual(900);
    /* And still long enough to READ. Two words on a black screen need less than two words competing with
       artwork did, but not nothing. */
    expect(holdUntil - fadeIn).toBeGreaterThanOrEqual(350);
  });

  it("scales the card to the proportion that was asked for", () => {
    /* "Scaled down a little, like to 70% its current size." Recorded as the arithmetic on #1166b's 62% rather
       than as a fresh number, so the lineage survives the next adjustment. */
    const art = sliceBetween(INTRO, "titleArt: {", "\n  },");
    const width = Number((art.match(/width: "(\d+)%"/) ?? [])[1]);
    expect(width).toBe(Math.round(62 * 0.7));
  });

  it("uses the lobby's own title asset rather than a second copy", () => {
    expect(INTRO).toContain("/images/title-project18xx.jpg");
    expect(sliceBetween(INTRO, "titleArt: {", "\n  },")).toContain('mixBlendMode: "screen"');
  });

  it("centres the title without a transform, because the keyframes own that", () => {
    /* ==================================================================
        DESIGN NOTE 1166b: ONE PROPERTY, TWO OWNERS
       ==================================================================
       REPORTED: "I only see like the top left quarter-ish of the Project 18XX title."
       THE CARD WAS CENTRED WITH `translate(-50%, -50%)` AND ANIMATED ON `transform`, with fill mode `both` --
       so the keyframe's value replaced the centring permanently. The element's top-left corner sat at the
       middle of the screen and the picture ran off to the right and down, which shows exactly the top-left
       quarter of it.
       ASSERTED AS THE ABSENCE OF A TRANSFORM ON THE ELEMENT and the absence of one in its keyframes, because
       either alone reintroduces the bug -- and a transform here would also isolate the element and break the
       `screen` blend the asset depends on (#1131's trap, one level in). */
    /* Design note #1166d moved the CENTRING to the card's flex box -- the image is a flex child now rather
       than an absolutely-positioned one, so `inset`/`margin: auto` are the parent's business. The CLAIM is
       unchanged and is the only thing worth pinning: neither the element nor its keyframes may own a
       transform, because the animation would clobber it and because a transform isolates the element and
       kills the `screen` blend. */
    const art = sliceBetween(INTRO, "titleArt: {", "\n  },");
    expect(art).not.toContain("transform");
    const card = sliceBetween(INTRO, "titleCard: {", "\n  },");
    expect(card).not.toContain("transform");
    expect(card).toContain('alignItems: "center"');
    expect(card).toContain('justifyContent: "center"');
    const fade = sliceBetween(RAW_INTRO, "@keyframes app-intro-title-fade {", "}");
    expect(fade).not.toContain("transform");
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

  it("unmounts the card rather than leaving it at zero opacity", () => {
    /* An element over the video is an element the pointer can meet, and the skip is the only thing on this
       layer meant to be clickable. */
    expect(INTRO).toContain("{!holding && (");
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
    expect(cue).toBeGreaterThan(7500);
    expect(finishes).toBeLessThan(9600);
  });

  it("still shows the credit if the engine never fires timeupdate", () => {
    /* A cue that can only fail CLOSED: the end of the clip raises it too, which is one beat late and exactly
       the behaviour before the sync. */
    expect(INTRO).toContain("{creditVisible && (");
    const hold = sliceBetween(INTRO, "const holdEnded = React.useCallback(() => {", "}, [finish]);");
    expect(hold).toContain("setCreditVisible(true)");
  });

  it("still lets a reduced-motion reader out of the title card", () => {
    /* #606's rule is that the INFORMATION survives, not the movement -- and here the information is that the
       card is temporary. Switching its animation off entirely would park the title over the locomotive for
       the rest of the clip. */
    const reduced = RAW_INTRO.slice(RAW_INTRO.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("app-intro-title { animation: app-intro-title-out");
    expect(reduced).toContain(".app-intro-word { animation: none !important;");
  });

  it("can still be skipped through the hold", () => {
    /* `finish` is unchanged and every path still runs through it. A hold that could not be skipped would make
       the last two seconds the one unskippable part of a skippable sequence. */
    expect(INTRO).toContain("if (finished.current) return;");
    expect(INTRO).toContain("onClick={finish}");
  });
});
