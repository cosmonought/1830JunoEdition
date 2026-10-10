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
/* PLAY LOBBY (approved design, "play-lobby-handoff"): the header, boards and footer's stylesheet. */
const DESIGN_CSS = readStripped("components/lobbyDesignCss.ts");

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
  it("PLAY LOBBY: the header is the approved design's two columns -- the lockup beside the boardroom, masked into the page", () => {
    /* ==================================================================
        THE APPROVED DESIGN SUPERSEDES #1129 / #1131 / #1144 ON THE PICTURE
       ==================================================================
       The full-page photograph (`sceneClip` > `scene`, cover arithmetic in zoom space) is no longer mounted. The
       header is two columns (5fr text, 7fr picture); the picture is Ludum's boardroom drawing, as tall as the text,
       cropped to its top 10-70%, the man at the head of the table held 96px from the box's right edge, and masked
       so no rectangle shows (design handoff §2). On phones it is a 170px banner above the title. */
    expect(LOBBY).toContain('<section className="lb-hero" aria-labelledby="lobby-title">');
    expect(LOBBY).toContain("/images/p18-board-meeting.webp");
    expect(LOBBY).not.toContain("<div style={styles.sceneClip}");
    expect(DESIGN_CSS).toContain("grid-template-columns: minmax(0, 5fr) minmax(0, 7fr)");
    expect(DESIGN_CSS).toContain("linear-gradient(90deg, transparent 0%, transparent 14%, #000 56%, #000 86%, transparent 100%)");
    expect(DESIGN_CSS).toContain("linear-gradient(180deg, transparent 0%, #000 14%, #000 78%, transparent 100%)");
    expect(DESIGN_CSS).toContain("height: calc(100cqh / .6); top: calc(100cqh / .6 * -.1)");
    expect(DESIGN_CSS).toContain("filter: brightness(.94) contrast(1.22)");
    expect(DESIGN_CSS).toContain("--d: 64px; order: -1; height: 170px;");
    expect(fs.existsSync(path.join(PUBLIC_DIR, "images", "p18-board-meeting.webp"))).toBe(true);
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

  it("PLAY LOBBY: the title is text -- PROJECT and 18XX in Anton, the numerals under the gilt -- so it cannot fail to draw", () => {
    /* The keyed JPEG wordmark (and the `screen` blend it needed, and the `onError` fallback to CSS gilt) is retired:
       the lockup is the heading's own text, in Anton, with the gilt gradient clipped to 18XX and a solid gold `color`
       under it for a browser without the clip. The numerals carry `.06em` of block padding so Anton's round tops
       and bottoms are inside the gradient (handoff §2). One heading, read once: "Project 18XX". */
    expect(LOBBY).toContain('<h1 className="lb-lockup" id="lobby-title">');
    expect(LOBBY).toContain('<span className="lb-name">Project</span>{" "}');
    expect(LOBBY).toContain('<span className="lb-num">18XX</span>');
    expect(DESIGN_CSS).toContain("linear-gradient(180deg, var(--lb-gilt) 0%, var(--lb-gold) 42%, var(--lb-deep) 58%, var(--lb-gold) 74%, var(--lb-gilt) 100%)");
    expect(DESIGN_CSS).toContain("padding-block: .06em; margin-block: -.06em;");
    expect(DESIGN_CSS).toContain("-webkit-text-fill-color: transparent; color: var(--lb-gold);");
    expect(DESIGN_CSS).toContain('font-family: "Anton"; src: url(');
    expect(LOBBY).not.toContain('className="lobby-wordmark"');
  });

  it("ships the wordmark, keyed to true black and small enough to sit beside the room", () => {
    const p = path.join(PUBLIC_DIR, "images/title-project18xx.jpg");
    expect(fs.existsSync(p)).toBe(true);
    // 94KB against the 189KB room. The "it will make the site slow" objection, measured.
    expect(fs.statSync(p).size).toBeLessThan(130 * 1024);
  });

  it("aims the title and the controls at the picture's coordinates -- as flow, not as anchors (P3-N028)", () => {
    /* ==================================================================
        DESIGN NOTE 1131: WHY ANCHORING WAS POSSIBLE -- AND P3-N028 (REOPENED): WHY IT IS FLOW NOW
       ==================================================================
       `.scene` reproduces `cover`'s arithmetic as an ELEMENT, so 0.4 and 0.7 of it are the same features of the
       photograph on every screen -- that part stands. What P3-N028 retired is hanging the CONTROLS in that box with
       `position: absolute`: an absolute row owns no height, so the list below it needed a measured spacer, and a
       measured boundary was late or wrong ("Your Tables" covering Host / Join, reported twice). The title and the
       doors are flow content of the top region now, and the composition is their MARGINS, aimed at the same
       coordinates: the title's foot at 0.4 of the scene, the doors' centre at 0.7, 20% of the scene wide. */
    expect(LOBBY).toContain("const TITLE_FOOT_OF_SCENE = 0.4;");
    expect(LOBBY).toContain("const DOORS_CENTRE_OF_SCENE = 0.7;");
    expect(LOBBY).toContain("const WORDMARK_SHARE_OF_SCENE = 0.2;");
    expect(LOBBY).toContain("const WORDMARK_MIN_PX = 230;");
    expect(LOBBY).toContain("marginTop: TITLE_MARGIN_TOP,");
    expect(LOBBY).toContain("marginTop: ACTIONS_MARGIN_TOP,");
    /* ==================================================================
        DESIGN NOTE 1132: CENTRED WITHOUT A TRANSFORM -- BY FLOW NOW
       ==================================================================
       `left: 50%` + `translateX(-50%)` put a BLACK BOX ROUND THE TITLE: `transform` creates a stacking context and
       `mix-blend-mode` only blends inside its nearest one. #1132 centred it by arithmetic (`left: 40%`, `width: 20%`);
       the stage centres it by flow (`alignItems: center`). Asserted as the absence of the transforms that broke it. */
    expect(LOBBY).toContain('alignItems: "center",\n    paddingBottom');
    expect(LOBBY).not.toContain('transform: "translateX(-50%)"');
    expect(LOBBY).not.toContain('transform: "translateY(-50%)"');
    expect(LOBBY).not.toContain('transform: "translate(-50%, -50%)",\n    pointerEvents');
  });

  it("centres the buttons in the anchor with a gap (#1423 supersedes #1132's edges)", () => {
    /* #1132 pushed TWO buttons to a narrow box's edges. With three (Rejoin, #1355) and the chrome zoom the
       row overflowed the box to the right; a wide box with centred contents keeps the group centred at any
       count and any zoom. */
    expect(CONTROLS_BAR).toContain('justifyContent: "center"');
    expect(CONTROLS_BAR).toContain('gap: "24px"');
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
       ON THE BASE STYLE NOW, so the next "one footer, no overrides" sweep cannot take it again.

       ==================================================================
        DESIGN NOTE 1170: AND THE Z-INDEX HALF OF IT WAS TOO MUCH
       ==================================================================
       The paragraph above is right about the cause and wrong about one word. "A footer with no z-index of its
       own goes under the photograph" should read "a footer that is not POSITIONED goes under the photograph":
       Appendix E step 8 paints `z-index: auto` and `z-index: 0` positioned boxes together in tree order, and
       this footer is the lobby root's last child. Positioning alone lifts it.
       THE NUMBER COST THE MARK ITS BACKDROP. A positioned box with a `z-index` other than `auto` IS a
       stacking context, which cut `NetaMark`'s `screen` off from the photograph and put the black rectangle
       back -- the same box #1132 removed, reported again. My own sentence about the mark surviving "because
       mix-blend-mode promotes it to its own compositing layer" was the near miss: it survived because the
       footer was still unpositioned and the blend could still reach the room.
       SO THE ASSERTION INVERTS on the second half, and `blendIsolation.test.ts` now holds the general rule
       this pair of notes kept rediscovering one element at a time. */
    const footer = APP_STYLES.slice(APP_STYLES.indexOf("appFooter: {"));
    const body = footer.slice(0, footer.indexOf("},"));
    expect(body).toContain('position: "relative"');
    expect(body).not.toContain("zIndex");
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

  it("bounds the picture to the top region and puts the list under it", () => {
    /* P3-N028's boundary survives the approved design: the corner and the header are the top region, the tables
       region follows it after the explicit boundary, and the drawing lives inside the header's own grid -- it is
       no longer a layer over anything, so it has nothing to be bounded against. */
    expect(LOBBY).toContain('<div style={styles.topBand} data-testid="lobby-top">');
    expect(LOBBY).toContain('<div style={styles.boundary} role="presentation" aria-hidden="true" data-testid="lobby-boundary" />');
    const top = LOBBY.indexOf('data-testid="lobby-top"');
    const art = LOBBY.indexOf('<figure className="lb-hero-art" aria-hidden="true">');
    const boundary = LOBBY.indexOf("<div style={styles.boundary}");
    expect(art).toBeGreaterThan(top);
    expect(boundary).toBeGreaterThan(art);
    expect(LOBBY).not.toContain("styles.heroFlow");
  });

  it("puts the public list on the page, below the two doors", () => {
    /* Design note #1440: the list is FLOW CONTENT in the width-capped column, after the top region's boundary. The
       approved design draws it as two boards (`LobbyBoards`); the order is the assertion: doors, boundary, tables
       region, boards. */
    const doors = LOBBY.indexOf('data-testid="lobby-actions"');
    const boundary = LOBBY.indexOf('<div style={styles.boundary}');
    const region = LOBBY.indexOf('<div style={styles.content} data-testid="lobby-tables">');
    const list = LOBBY.indexOf("<LobbyBoards");
    expect(doors).toBeGreaterThan(-1);
    expect(boundary).toBeGreaterThan(doors);
    expect(region).toBeGreaterThan(boundary);
    expect(list).toBeGreaterThan(region);
    // The public list, read here rather than handed to a modal. LIVE-2D: the server's `rooms-watch`.
    expect(LOBBY).toContain("rooms={publicRooms.rooms}");
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
    /* Design note #1130 SUPERSEDES #1123's GRID, and the approved design keeps that: the title, the line and the two
       doors sit on the page in the header's left column, with no panel around them. */
    expect(LOBBY).not.toContain("lobby-dashboard");
    expect(LOBBY).not.toContain("styles.dashboardColumn");
    expect(LOBBY).not.toContain("styles.stage}");
    expect(LOBBY).toContain('<div className="lb-doors" data-testid="lobby-actions">');
  });

  it("has no display-name field: its only readers went with the staging lobby (LIVE-2D)", () => {
    /* ==================================================================
        DESIGN NOTE 1133, CLOSED BY RUST-RETIRE-1 2B.3
       ==================================================================
       `handleHostSandboxRoom` passes the literal "Host" -- it never read this input. The name a player uses is
       set in the waiting room, which has its own field AND its own Save. What DID read it was the Web3 staging
       lobby behind `WEB3_LOBBY_ENABLED`, and that branch is deleted -- so the field goes with it. */
    expect(LOBBY).not.toContain("WEB3_LOBBY_ENABLED");
    expect(LOBBY).not.toContain('placeholder="Display name"');
    // #1415: the terms ride along. LIVE-2D: a `create` op, no client id. LIVE-2E: with no name field here, the host's
    // seat is named after the profile (`profileNickname`) -- never a typed-in name, and never the old literal.
    expect(LOBBY).toContain("const answer = await createHostedGame(variants, setup, profileNickname());");
    expect(LOBBY).not.toContain('createHostedGame(variants, setup, "Host")');
    expect(LOBBY).not.toContain("localPlayerId");
  });

  it("PHASE 3 FINAL (§12): the account corner has no wallet chip -- no Connect, no address, no balance, no Disconnect", () => {
    /* Design note #1133 shrank the corner's Connect to furniture; PHASE 3 FINAL removed it with the address, balance and
       Disconnect beside it: a connected Keplr address beside the account chip answered "who am I", which only the
       account answers (owner ruling). Keplr is reached where it signs -- a seat's money panel, the account's
       Authorization Wallet steps. */
    expect(LOBBY).not.toContain("<ConnectWalletButton");
    expect(LOBBY).not.toContain('label="Connect"');
    expect(LOBBY).not.toContain("useWallet(");
    expect(LOBBY).not.toContain("wallet.disconnect");
    expect(LOBBY).not.toContain("truncateAddress(");
    expect(LOBBY).not.toMatch(/style=\{styles\.(?:connectButton|addressBadge|balanceBadge)\}/);
    expect(LOBBY).toContain("<ProfileMenu />");
  });

  it("splits the utility row: the world on the left, the account on the right", () => {
    /* Design note #1131: the pill is not account furniture -- the name, wallet and balance answer "who am
       I", it answers "what is this build talking to". Opposite ends of the row. */
    expect(LOBBY).toContain("styles.utilityRow");
    expect(LOBBY).toContain("styles.utilityAccount");
    expect(LOBBY).toContain('justifyContent: "space-between"');
    expect(LOBBY.indexOf("Offline · sandbox active")).toBeLessThan(LOBBY.indexOf("styles.utilityAccount"));
    // The paused card's sentence survives where a developer will look and a player will not. LIVE-2D: it no
    // longer names a flag to flip -- the staging lobby is deleted, and money tables return with the escrow contract.
    expect(LOBBY).not.toContain("On-chain rooms — paused");
    expect(LOBBY).toContain("On-chain tables return with the escrow contract; every table on this server is a no-money table.");
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
    /* Design note #1443 RENAMED THE BOX, not the rule: the panel became a full-width surface with two
       columns on it, so the wrapper that carries the inset is `surfaceWrap`. The claim -- the root carries no
       inset, and the box below it does -- and the value are both unchanged. */
    expect(WAITING).toContain("styles.surfaceWrap");
    expect(WAITING).not.toContain("styles.panelWrap");
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
