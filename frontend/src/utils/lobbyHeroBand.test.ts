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
const CONTROLS_BAR = readStripped("components/SandboxRoomBar.tsx");

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
    /* Design note #1131: `backgroundAttachment: fixed` is GONE with the background itself -- the picture is
       an element now, sized as `cover` would compute it, so that children can be anchored to it.
       ==================================================================
        DESIGN NOTE 1144 SUPERSEDES THE SPELLING OF THIS ASSERTION, NOT ITS CLAIM
       ==================================================================
       IT READ `'width: "max(100%, calc(100vh * 1920 / 1072))"'` -- the whole declaration, quotes and all --
       and #1144 broke it by putting the viewport terms in the chrome's zoom space, where `100vh` had stopped
       meaning the viewport. The ratio is untouched; the units moved. That is the third time this harness has
       gone red over an expression rather than a property (see `stepJumpButton.test.ts` #859 for the same
       lesson learned on a `<div>`), so this now asserts the two things #1131 actually argues for:
         the box is `cover`'s OWN arithmetic, ratio and all -- not `background-size: cover` on a parent;
         and it is the max of a proportional term and a viewport term, which is what makes it an ELEMENT
         children can be anchored inside.
       THE `1920 / 1072` IS THE LOAD-BEARING PART and is asserted exactly, because it is the photograph's real
       aspect: a wrong ratio here is a stretched room, and no other test in this file would notice. */
    expect(LOBBY).toContain("* 1920 / 1072");
    expect(LOBBY).toContain("* 1072 / 1920");
    expect(LOBBY).toMatch(/width: `max\(100%, calc\(\$\{[^}]+\}vh \* 1920 \/ 1072\)\)`/);
    /* Design note #1144: and the units are in ONE space. A bare `100vh` surviving here is the specific bug
       that would leave the photograph letterboxed on a tall window -- see `uiScale.test.ts`, which owns the
       reasoning; this line is the tripwire on the file that would show it. */
    expect(LOBBY).not.toContain("calc(100vh *");
    /* The other half of the same box, re-anchored for the same reason. Both axes are asserted rather than
       one, because `cover` is the MAX of the two fits and a box with one correct axis is not cover -- it is a
       picture that happens to be right on wide windows. */
    expect(LOBBY).toMatch(/height: `max\(\$\{[^}]+\}vh, calc\(\$\{[^}]+\}vw \* 1072 \/ 1920\)\)`/);
    expect(LOBBY).not.toContain("max(100vh,");
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

  it("anchors the title and the controls to the picture, not to the flow", () => {
    /* ==================================================================
        DESIGN NOTE 1131: WHY ANCHORING IS POSSIBLE NOW AND WAS NOT BEFORE
       ==================================================================
       I TURNED THIS DOWN LAST TURN and the objection was right about `cover` rather than about anchoring: a
       background image is cropped differently at every viewport aspect, so 70% would have been the table on
       one window and a lapel on the next. `.scene` reproduces `cover`'s arithmetic as an ELEMENT, so a child
       at 70% is on the table on every screen -- checked at 1600x900, 1280x1024 and 430x900.
       THE POSITIONS ARE THE ONES GIVEN: the title's BOTTOM at 40% ("at the lowest"), the controls centred at
       70% in a 24% box, which puts them either side of x 0.40 and 0.60. */
    expect(LOBBY).toContain('bottom: "60%"');
    expect(LOBBY).toContain('top: "70%"');
    expect(LOBBY).toContain('width: "24%"');
    /* ==================================================================
        DESIGN NOTE 1132: CENTRED BY ARITHMETIC, NOT BY TRANSFORM
       ==================================================================
       `left: 50%` + `translateX(-50%)` is the usual idiom and it put a BLACK BOX ROUND THE TITLE: `transform`
       creates a stacking context, and `mix-blend-mode` only blends with the backdrop inside its nearest one,
       so the wordmark was cut off from the photograph it needed to key against.
       `left: 40%` WITH `width: 20%` IS THE SAME POSITION and creates nothing. Asserted as the absence of the
       horizontal transform, because that is the property that broke it. */
    expect(LOBBY).toContain('left: "40%"');
    expect(LOBBY).toContain('left: "38%"');
    expect(LOBBY).not.toContain('transform: "translateX(-50%)"');
    expect(LOBBY).not.toContain('transform: "translate(-50%, -50%)",\n    pointerEvents');
  });

  it("pushes the two buttons to the anchor's edges rather than its middle", () => {
    /* THE ANCHOR WAS RIGHT AND THE CONTENT ALIGNMENT IGNORED IT. A 24% box centred on the scene with
       `justify-content: center` packs both buttons at 0.5; `space-between` puts them on 0.38 and 0.62, which
       is what the width was chosen for. */
    expect(CONTROLS_BAR).toContain('justifyContent: "space-between"');
    expect(CONTROLS_BAR).not.toContain('justifyContent: "center"');
  });

  it("gives every bare control the same size, so none is smaller than another", () => {
    /* ==================================================================
        DESIGN NOTE 1136 SUPERSEDES #1132's SIZE
       ==================================================================
       #1132 SIZED THE PAIR UP AND OVERSHOT -- `control` type at 10px/22px. That produced three of the four
       faults reported next: padding "far too much", two buttons "still quite close together" because wide
       buttons nearly meet inside a fixed box, and a "Join" that looked like a different control because it
       was one, still at the original size beside two that had grown.
       FOUR BUTTONS, ONE STYLE. Asserted as the absence of a second size as much as the presence of the
       shared one -- a leftover `buttonBig` on any single control is exactly the bug that was reported. */
    expect(CONTROLS_BAR).toContain("bareButton: {");
    expect(CONTROLS_BAR).not.toContain("buttonBig");
    expect(CONTROLS_BAR.split("styles.bareButton").length - 1).toBeGreaterThanOrEqual(4);
  });

  it("stops the join form reflowing under the button that opened it", () => {
    /* `flexWrap: wrap` IN A FIXED-WIDTH BAR did what it was told: the form does not fit at the old padding,
       so it went to a second line beneath Host. `nowrap` plus the smaller buttons keeps it on the row it
       opened from. */
    expect(CONTROLS_BAR).toContain('flexWrap: "nowrap"');
  });

  it("keeps green for the press, not for the resting state", () => {
    /* "Leaving Host Game green makes it seem like the other option is disabled or lesser value" -- and this
       screen offers two equal doors. The teal moves to `:active`, which is the one moment it states a fact
       rather than a ranking. Cancel is the single exception that keeps a lesser weight, because it undoes. */
    expect(CONTROLS_BAR).toContain("sandbox-bare-btn:active");
    expect(CONTROLS_BAR).toContain("BARE_BUTTON_CSS");
    const bare = CONTROLS_BAR.slice(CONTROLS_BAR.indexOf("bareButton: {"));
    expect(bare.slice(0, bare.indexOf("},"))).not.toContain("#14312f");
    expect(CONTROLS_BAR).toContain("bareButtonQuiet");
  });

  it("gives all three screens the same footer", () => {
    /* ==================================================================
        DESIGN NOTE 1137 SUPERSEDES EVERY PER-SURFACE FOOTER OVERRIDE
       ==================================================================
       REPORTED by walking the three screens in order: fine in the lobby, overlapping the panel in the waiting
       room, "much smaller and centred" in the game. THE MARK'S HEIGHT HAD MOVED FOUR TIMES -- 18, 36, 31, 28
       -- and every move was judged on ONE screen with a second value sitting beside it.
       ONE SIZE, ONE ALIGNMENT, ONE PADDING. Asserted as the ABSENCE of the surface split as much as the
       presence of the shared values: a per-surface override is precisely what produced the drift, so the
       guard has to fail if one comes back. */
    expect(FOOTER).toContain("const MARK_HEIGHT = 28;");
    expect(FOOTER).not.toContain("GAME_MARK_HEIGHT");
    expect(FOOTER).not.toContain("META_MARK_HEIGHT");
    expect(FOOTER).not.toContain("appFooterMeta");
    expect(APP_STYLES).not.toContain("appFooterMeta:");
    expect(APP_STYLES).not.toContain("netaCreditMeta:");
    /* Design note #1140: CENTRED, not flush right. #1137 moved it to the right edge to answer a footer that
       "looked odd compared to the other elements on screen" -- and the oddness was the lobby drawing the mark
       without its words, not the alignment. Centred is where it started. */
    expect(APP_STYLES).toContain('padding: "18px 20px 12px"');
  });

  it("keeps the footer above whatever the screen paints behind it", () => {
    /* ==================================================================
        DESIGN NOTE 1140: THE REGRESSION #1137 CARRIED OUT WITH THE OVERRIDE
       ==================================================================
       REPORTED as "'Powered by Neta DAO' doesn't render on the Lobby page, just the animation." The lobby's
       `sceneClip` is a POSITIONED element at z-index 0, and a positioned element paints above unpositioned
       in-flow siblings however late they appear -- so a footer with no z-index of its own goes under the
       photograph. #1132 had fixed that inside `appFooterMeta`, where it read as part of an ink strip rather
       than as a stacking fix, and #1137 deleted the override wholesale.
       THE MARK SURVIVED AND THE WORDS DID NOT, which is the detail that identifies the cause: `mix-blend-mode`
       promotes the mark to its own compositing layer and plain text has no such trick.
       ON THE BASE STYLE NOW, so the next "one footer, no overrides" sweep cannot take it again. */
    const footer = APP_STYLES.slice(APP_STYLES.indexOf("appFooter: {"));
    const body = footer.slice(0, footer.indexOf("},"));
    expect(body).toContain('position: "relative"');
    expect(body).toContain("zIndex: 1");
  });

  it("does not answer a size complaint by un-sharing the size", () => {
    /* ASKED FOR as "shrink the meta ones 10% OR grow the game one 10%", and there is no gap left to close:
       #1137 gave all three ONE height and ONE type size. Either move would push them apart and re-create the
       drift the standardisation removed. Asserted as the absence of a second constant, which is the shape the
       "fix" would have taken. */
    expect(FOOTER).toContain("const MARK_HEIGHT = 28;");
    expect(FOOTER).not.toContain("META_MARK_HEIGHT");
    expect(FOOTER).not.toContain("GAME_MARK_HEIGHT");
    expect(APP_STYLES).not.toContain("netaCreditMeta");
  });

  it("keeps the ink and the shadow the lobby was given, on both surfaces", () => {
    /* ==================================================================
        DESIGN NOTE 1137 SUPERSEDES #1132/#1133/#1135's META-ONLY TREATMENT
       ==================================================================
       FIVE CASES USED TO LIVE HERE, one per attempt: the footer's opaque strip, the lockup's plate, the
       no-plate reversal, the by-surface height and the by-surface type. Every one of them was RIGHT about the
       lobby and silent about the other two screens, which is how the credit ended up looking like three
       different components.
       WHAT SURVIVES IS THE SETTLED ANSWER: white, tight, shadowed, no plate -- ruled for the lobby and now
       applied everywhere, because the shadow costs nothing on a flat ground and there was never a reason the
       board should disagree. */
    expect(APP_STYLES).toContain('color: "#f2f0eb"');
    expect(APP_STYLES).toContain("netaCredit: {");
    const credit = APP_STYLES.slice(APP_STYLES.indexOf("netaCredit: {"));
    const body = credit.slice(0, credit.indexOf("},"));
    expect(body).toContain("textShadow");
    expect(body).not.toContain("backgroundColor");
    expect(body).toContain('gap: "5px"');
  });

  it("still varies the one thing that was ever about the surface", () => {
    /* #1113 GAVE THE ANIMATION TO THE ANTEROOM SCREENS because a thing that moves under a hex map pulls an
       eye that is counting revenue. That argument is about MOTION and says nothing about height -- which is
       why the size could be standardised and this could not. */
    expect(FOOTER).toContain('animated={surface === "meta"}');
  });

  it("lets the picture reach the foot of the page", () => {
    /* ==================================================================
        DESIGN NOTE 1133: THE BAND THAT LOOKED LIKE A FOOTER
       ==================================================================
       REPORTED as "the footer now scrims the entire lower fourth of the screen", and it was not the footer:
       `sceneClip` was pinned to `height: 100vh` while the root is `min-height: 100vh` PLUS padding plus its
       flow children, so the last stretch of the page had no photograph on it and the footer's strip ran into
       that bare ink as one slab.
       TWO EDGES, BOTH ASSERTED: the layer reaches the root's bottom, and the root no longer holds the credit
       40px clear of it. */
    expect(LOBBY).toContain("bottom: 0,");
    expect(LOBBY).not.toContain('padding: "0 0 40px"');
  });

  it("keeps the layer over the page from eating the page", () => {
    /* `sceneClip` covers the window, so without this it swallows every click beneath it -- and being a
       POSITIONED element at z-index 0 it also paints over unpositioned flow siblings, which would have hidden
       the utility row and the content while leaving both clickable. */
    expect(LOBBY).toContain('pointerEvents: "none"');
    expect(LOBBY).toContain('pointerEvents: "auto"');
    expect(LOBBY.split("zIndex: 1").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("has no card left in the middle of the screen", () => {
    /* Design note #1130 SUPERSEDES #1123's GRID: one centred stage, no panel around it, and the two-column
       breakpoint gone with the second card. The `sandboxStrip` style survives because `StagingRoom` still
       uses it -- so this asserts the LAYOUT is gone, not the token. */
    expect(LOBBY).not.toContain("lobby-dashboard");
    expect(LOBBY).not.toContain("styles.dashboardColumn");
    // Design note #1131: `styles.stage` went too -- the controls are anchored to the scene now, not stacked
    // in a flow column, so there is no container left between the picture and the buttons.
    expect(LOBBY).not.toContain("styles.stage}");
    expect(LOBBY).toContain("styles.tableAnchor");
  });

  it("keeps the display name behind the flag it actually serves", () => {
    /* ==================================================================
        DESIGN NOTE 1133: A FIELD WITH NO CONFIRM, BECAUSE IT HAD NOTHING TO CONFIRM TO
       ==================================================================
       `handleHostSandboxRoom` passes the literal "Host" -- it never reads this input. The name a sandbox
       player uses is set in the waiting room, which has its own field AND its own Save. What DOES read it is
       `hostDisplayName`, `claimSeat` and `ChatBox`, every one of them inside the Web3 branch -- so it is
       gated with that branch rather than deleted, which is #525's standing rule for it. */
    expect(LOBBY).toContain("{WEB3_LOBBY_ENABLED && (");
    expect(LOBBY).toContain('placeholder="Display name"');
    expect(LOBBY).toContain('hostSandboxRoom(localPlayerId(), "Host")');
  });

  it("shrinks the connect button to the row it lives in", () => {
    // `primaryButton` is the lobby's loudest control and was sized as a call to action; this is furniture.
    expect(LOBBY).toContain('label="Connect"');
    expect(LOBBY).toContain("styles.connectButton");
  });

  it("splits the utility row: the world on the left, the account on the right", () => {
    /* Design note #1131: the pill is not account furniture -- the name, wallet and balance answer "who am
       I", it answers "what is this build talking to". Opposite ends of the row. */
    expect(LOBBY).toContain("styles.utilityRow");
    expect(LOBBY).toContain("styles.utilityAccount");
    expect(LOBBY).toContain('justifyContent: "space-between"');
    expect(LOBBY.indexOf("Offline · sandbox active")).toBeLessThan(LOBBY.indexOf("styles.utilityAccount"));
    // The paused card's sentence survives where a developer will look and a player will not.
    expect(LOBBY).not.toContain("On-chain rooms — paused");
    expect(LOBBY).toContain("WEB3_LOBBY_ENABLED in Lobby.tsx to bring them back");
  });

  it("drops the three lines of copy that captioned labelled controls", () => {
    /* RULED: none of the three were necessary. Each was captioning a control that had a label already --
       "SANDBOX MULTIPLAYER" named the tray, "Host a room, or join with a room code" restated two buttons,
       and the off-chain reassurance described a cost the only live path never incurs. */
    expect(LOBBY).not.toContain("<p style={styles.brandSubtitle}>");
    expect(LOBBY).not.toContain("styles.stageNote");
    expect(CONTROLS_BAR).toContain("{!bare && <span style={styles.label}>");
  });
});

describe("the anteroom and the table share their chrome", () => {
  it("mounts the shell's own bar rather than a header that looks like it", () => {
    /* ==================================================================
        DESIGN NOTE 1138: THE CONTROL STOPPED DIFFERING; ITS POSITION KEPT MOVING
       ==================================================================
       #1102 made half of this argument: the waiting room stopped hand-rolling an audio toggle and mounted the
       bar's own `AudioControls` -- "one object, one component, both screens". What it left was the audio pair
       sitting INSIDE the waiting-room panel and then jumping to the header at the table.
       `TopBar` ITSELF, not a second header. Everything wallet- or session-shaped in it is conditional and
       renders nothing in an offline sandbox, so what arrives is the brand, the room code, the audio pair and
       the offline dot. Asserted as the import, because a lookalike header would satisfy any test written
       about what appears on the screen. */
    expect(WAITING).toContain('import TopBar from "./TopBar"');
    expect(WAITING).toContain("<TopBar roomName={roomCode} onLeaveGame={onLeave} audio={audio} />");
    // The panel no longer carries its own copy of either control.
    expect(WAITING).not.toContain("<AudioControls audio={audio} />");
    expect(WAITING).not.toContain("styles.headerActions");
  });

  it("lets the bar reach the window edges", () => {
    /* The root's inset moved to `panelWrap`. Left where it was, it would have drawn a stripe of photograph
       above a bar that is meant to sit on the edge -- which is the same class of fault as the footer band. */
    expect(WAITING).toContain("styles.panelWrap");
    expect(WAITING).toContain('padding: "24px 20px 0"');
  });
});

describe("the animated mark is big enough to read as motion", () => {

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
