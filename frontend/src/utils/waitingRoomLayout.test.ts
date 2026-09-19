/** @jest-environment node */
// frontend/src/utils/waitingRoomLayout.test.ts -- design note #1443.
//
// ==================================================================
//  THE ANTEROOM STOPS BEING A STACK OF RECTANGLES
// ==================================================================
//
// REPORTED: "almost every level is expressed as another rectangle ... on desktop this creates a long, narrow
// form floating in a large room." SIX NESTED SURFACES answered four questions -- the panel, the code box, the
// filled roster rows, the house-rules card, the ante confirmation, the variant rows -- each a correct
// grouping on its own and, together, a page with no hierarchy at all.
//
// WHAT REPLACES THEM IS STRUCTURE: one surface, two unequal columns, one hairline. The tests below are about
// the two things a re-layout is most likely to break by accident -- the painting chain the photograph hangs
// off, and the controls a viewer is or is not entitled to -- plus the absences that would let the rectangles
// back in one at a time.

import { readStripped } from "./sourceScan";

const WAITING = readStripped("components/SandboxWaitingRoom.tsx");

describe("one surface, two columns, one hairline (design note #1443)", () => {
  it("draws the grouping with structure rather than with borders", () => {
    /* The claim is asserted as an ABSENCE as much as a presence: every one of these boxes was a reasonable
       grouping when it was added, and the way they came back last time was one at a time. */
    expect(WAITING).toContain("const WAITING_ROOM_CSS = ");
    expect(WAITING).toContain("grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);");
    expect(WAITING).toContain("border-left: 1px solid #2a2a2a;");
    for (const gone of ["panel: {", "panelWrap", "codeBlock", "variantPanel", "rosterRow", "headerRow"]) {
      expect([gone, WAITING.includes(gone)]).toEqual([gone, false]);
    }
    /* One bordered object survives, and it is a STATE rather than a grouping: the ante confirmation
       interrupts the page, which is the one thing a bounded surface is for. */
    expect(WAITING).toContain("readyConfirm: {");
  });

  it("caps the surface where the Lobby caps its column", () => {
    /* A third width for the screen between the Lobby and the board would be a number with no argument behind
       it. #1112's 0.90 fill is kept and was re-measured for the new width: the lamp that sets the floor is
       already inside the old 520px footprint, so the worst case is the same pixel. */
    expect(WAITING).toContain('maxWidth: "1040px"');
    expect(readStripped("components/Lobby.tsx")).toContain('maxWidth: "1040px"');
    expect(WAITING).toContain('backgroundColor: "rgba(15, 15, 15, 0.90)"');
  });

  it("keeps the stacking context the photograph is painted inside", () => {
    /* #1266 made the scene a FIXED child at `z-index: -1` so a growing roster could not re-fit it. These two
       lines are what make that legal -- they make the root the stacking context the layer sits in, so it
       paints above the root's own opaque fill. #1443 dropped them for one build while rewriting these styles
       and the photograph vanished entirely; this is the tripwire for the next time. */
    expect(WAITING).toContain('position: "relative"');
    expect(WAITING).toContain('isolation: "isolate"');
    expect(WAITING).toContain('backgroundColor: "#0f0f0f"');
    /* And the root no longer centres by SHRINKING its children, which is what left `AppFooter` as wide as the
       credit inside it -- see the overflow case below. */
    const root = WAITING.slice(WAITING.indexOf("  root: {"));
    expect(root.slice(0, root.indexOf("\n  },"))).not.toContain('alignItems: "center"');
  });

  it("gives the screen the headings it never had", () => {
    /* The title was a `<span>`, and so was every section label -- so this screen had no document outline at
       all. The hierarchy the redesign is built on is the one the markup now states. */
    expect(WAITING).toContain("<h1 style={styles.title}>Waiting room</h1>");
    expect(WAITING).toContain('<h2 id="wr-you" style={styles.sectionHeading}>');
    expect(WAITING).toContain('<h2 id="wr-players" style={styles.sectionHeading}>');
    /* Design note #1444: the secondary column carries TWO headings now -- a setting is not a house rule. */
    /* Design note #1445: the settings heading moved into the LEFT column and took an id with it; the right
       region is drawn only when there are rules to put in it. */
    expect(WAITING).toContain('<h2 id="wr-settings" style={styles.sectionHeading}>Game settings</h2>');
    expect(WAITING).toContain("<h2 style={styles.sectionHeading}>House rules</h2>");
    expect(WAITING).toContain("<dl style={styles.terms}>");
    expect(WAITING).toContain("<dt style={styles.termLabel}>{label}</dt>");
    /* Design note #1444: the value cell can carry a classification beside the figure -- "Non-standard" on a
       bank that is not the printed one -- rather than the amount being printed a second time under another
       heading in order to say the same thing. */
    expect(WAITING).toContain("<dd style={styles.termValue}>");
    expect(WAITING).toContain("{tag && <span style={styles.termTag}>{tag}</span>}");
  });

  it("puts the seat count in the heading it counts, which is what unran the two sentences", () => {
    /* MEASURED IN THE CAPTURE, not reasoned about: "certificate limit 18." and "4 of 4 seats (exactly)." were
       two spans in one row with no separator, and read as "certificate limit 18.4 of 4 seats". */
    expect(WAITING).toContain("<span style={styles.seatCount}>");
    expect(WAITING).not.toContain("dealRow");
    const deal = WAITING.slice(WAITING.indexOf("certificate limit"));
    expect(deal.slice(0, 200)).toContain("</strong>.");
  });
});

describe("what a viewer is entitled to (design note #1443)", () => {
  it("gives the ready control to a SEAT, so neither a watcher nor a removed player is promised one", () => {
    /* REPORTED: "Do not present a prominent green Ready to play control that merely happens to be disabled.
       That visually promises an action the visitor cannot take." The same fault #1441 removed from the
       Lobby's full tables one screen earlier, and the condition is `me` so the two cases cannot drift. */
    expect(WAITING).toContain("{me ? (");
    expect(WAITING).toContain(") : isWatching ? (");
    expect(WAITING).toContain('data-testid="waiting-room-watching"');
    expect(WAITING).toContain("<span style={styles.watchTag}>Watching</span>");
    expect(WAITING).toContain("You are watching this table.");
    // The identity controls go with it: there is no seat to name or colour.
    expect(WAITING).toContain("{!isWatching && (");
  });

  it("leaves the seat-PIN rejoin in reach, because it is proof of a seat rather than a way round one", () => {
    /* That path needs the seat's PIN, and `adoptSeat` retires the watch intent on its way through (#1442) --
       so it is the device-switch case #1341 built, not a second door past #1441's Join. */
    expect(WAITING).toContain('setSeatPin({ mode: "rejoin", seatId: player.id })');
    expect(WAITING).toContain("<SeatPinModal");
    // And no new seat-claim path was invented on this screen.
    expect(WAITING).not.toContain("upsertSandboxPlayer");
    expect(WAITING).not.toContain("joinSandboxRoom");
  });

  it("keeps every start-gate and readiness reader it had", () => {
    expect(WAITING).toContain("const needed = seatsNeeded(room, MIN_PLAYERS);");
    expect(WAITING).toContain('block === "need-players"');
    expect(WAITING).toContain('block === "need-ready"');
    expect(WAITING).toContain("notice && <span style={styles.notice}>{notice}</span>");
    expect(WAITING).toContain("The host removed you from this table.");
    expect(WAITING).toContain("onToggleReady(readyConfirm === \"deposit\")");
    expect(WAITING).toContain("canKick && player.id !== room?.hostId");
  });

  it("reads every displayed value from the authority it already had", () => {
    /* Nothing about the terms is re-derived for presentation: the bank through `bankSizeLabel`, the blurbs
       through `VARIANT_COPY`, the seats through `roomSeatCap`/`seatsNeeded`, the deal through `gameSetup`. */
    expect(WAITING).toContain("value={bankSizeLabel(variants.length)}");
    expect(WAITING).toContain("VARIANT_TOGGLES.filter((toggle) => variants[toggle.key])");
    expect(WAITING).toContain("const cash = startingCashForPlayers(players.length, variants);");
    expect(WAITING).toContain("const certs = certLimitForPlayers(players.length, variants);");
    expect(WAITING).toContain("const resolvedColors = resolveSeatColors(players);");
    expect(WAITING).not.toContain("toLocaleString()");
  });
});

describe("the narrow layout (design note #1443)", () => {
  it("collapses to one column with the rules under the room, not beside it", () => {
    expect(WAITING).toContain("@media (max-width: 899px)");
    expect(WAITING).toContain("grid-template-columns: minmax(0, 1fr); }");
    expect(WAITING).toContain("border-top: 1px solid #2a2a2a;");
    // The seat's three cells are re-hung rather than re-rendered -- one markup, two shapes.
    expect(WAITING).toContain(".wr-seat > :nth-child(3) { grid-column: 2; grid-row: 1 / span 2; }");
  });

  it("gives every actionable control a 44px target there, and nothing a fixed overlay", () => {
    expect(WAITING).toContain(".wr-touch { min-height: 44px; min-width: 44px; }");
    /* An input is `content-box` by default, so the floor would otherwise have been 44 PLUS its padding --
       a 60px field beside a 44px button, which is what the capture showed. */
    expect(WAITING).toContain('boxSizing: "border-box"');
    expect(WAITING).not.toContain('position: "fixed"\n    // action');
    // The one fixed thing on this screen is the photograph, and it is behind everything (#1266).
    expect(WAITING.split('position: "fixed"').length - 1).toBe(1);
  });

  it("lets long names and values wrap instead of widening the page", () => {
    expect(WAITING).toContain('overflowWrap: "anywhere"');
    expect(WAITING).toContain("minmax(0, 1fr)");
  });
});

describe("the footer fits the window it is in (design note #1443)", () => {
  it("caps the mark that has a 300px default when it cannot decode", () => {
    /* FOUND WHILE MEASURING THIS SCREEN, which is the one whose root does not clip its own overflow -- so it
       is where a footer that cannot fit shows up as a page-wide scrollbar. A `<video>` whose metadata never
       arrives keeps the UA's intrinsic 300x150, and `width: auto` resolves to 300px however small the window
       is. #1137 pinned the mark's HEIGHT so three footers agree, and nothing said what it may never exceed. */
    const mark = readStripped("components/NetaMark.tsx");
    expect(mark).toContain('maxWidth: "100%"');
    expect(mark).toContain("minWidth: 0");
    /* A cap the item is not allowed to shrink to is not a cap: `flex: none` held the 300px flex base, and the
       overflow reached the document even with the box capped. */
    expect(mark).toContain('flex: "0 1 auto"');
    const credit = readStripped("styles/appStyles.ts");
    expect(credit.slice(credit.indexOf("netaCredit: {"), credit.indexOf("netaCredit: {") + 400)).toContain('maxWidth: "100%"');
    // #1137's one-footer rule is untouched: no second height, no per-surface override.
    expect(readStripped("components/AppFooter.tsx")).toContain("const MARK_HEIGHT = 28;");
  });
});

describe("a setting is not a house rule (design note #1444)", () => {
  /* ==================================================================
      REPORTED: "House Rules currently contains things that are not house rules"
     ==================================================================
     Game, Pace, Players, Visibility, Bank and Ante are what EVERY table has to decide; a house rule is what a
     table decides to do DIFFERENTLY. #1415 put all eleven rows under one heading because they arrive on one
     document and freeze at the same moment -- a fact about where they are stored, not about what they mean.
     THE CLASSIFICATION IS THE MODEL'S. `VARIANT_TOGGLES` is the list of optional rules the configuration
     already keeps, and the filter over it is unchanged: nothing moved between "on" and "off", only between
     one heading and two. */
  const VARIANTS = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");

  it("names the two groups and separates them with space and a rule, never a box", () => {
    /* #1445: the settings are the last thing in the LEFT column now -- #1444 was right that a setting is not
       a house rule and wrong about where the distinction goes, having given a rail to the group that is true
       of every table and left the lower-left empty under a finished roster. */
    expect(WAITING).toContain('<h2 id="wr-settings" style={styles.sectionHeading}>Game settings</h2>');
    expect(WAITING).toContain("<h2 style={styles.sectionHeading}>House rules</h2>");
    const block = WAITING.slice(WAITING.indexOf("  flowSection: {"));
    const body = block.slice(0, block.indexOf("},"));
    expect(body).toContain("borderTop");
    expect(body).not.toContain("backgroundColor");
    expect(body).not.toContain("borderRadius");
    // The settings follow the action they qualify, and precede nothing but the rules.
    expect(WAITING.indexOf('<section style={styles.flowSection} aria-labelledby="wr-settings">')).toBeGreaterThan(WAITING.indexOf("styles.actionArea"));
    expect(WAITING.indexOf('className="wr-secondary"')).toBeGreaterThan(WAITING.indexOf('<section style={styles.flowSection} aria-labelledby="wr-settings">'));
  });

  it("lists the four ordinary settings, and neither of the two the screen already states", () => {
    /* #1445: Game and Players are GONE from the list. The game is the page's title and the roster's heading
       already carries "3 of 6 seats" / "4 of 4 seats (exactly)" -- a second copy of either is the duplication
       #1444 was removing, one level up. */
    const settings = WAITING.slice(
      WAITING.indexOf('<h2 id="wr-settings"'),
      WAITING.indexOf('className="wr-secondary"'),
    );
    for (const label of ["Pace", "Visibility", "Bank", "Ante"]) {
      expect([label, settings.includes(`label="${label}"`)]).toEqual([label, true]);
    }
    for (const gone of ["Game", "Players", "Game type"]) {
      expect([gone, WAITING.includes(`label="${gone}"`)]).toEqual([gone, false]);
    }
    // And no optional rule is drawn in the settings list.
    expect(settings).not.toContain("houseRules.map");
  });

  it("draws the optional rules only under House rules, from the model's own list", () => {
    /* One filter, read three times -- the right region's existence, the left column's "None" line and the
       rows themselves are three readings of one answer. */
    expect(WAITING).toContain("const houseRules = VARIANT_TOGGLES.filter((toggle) => variants[toggle.key]);");
    /* Design note #1446: one element, rendered into one of two parents -- so the flow copy and the rail copy
       cannot drift into two designs. The map lives with the element, not with either parent. */
    expect(WAITING).toContain("const houseRulesSection = (");
    expect(WAITING).toContain("houseRules.map((toggle)");
    expect(WAITING.split("houseRules.map((toggle)").length - 1).toBe(1);
    const rail = WAITING.slice(WAITING.indexOf('className="wr-secondary"'));
    expect(rail.slice(0, 260)).toContain("{houseRulesSection}");
    expect(rail.slice(0, 260)).not.toContain("<TermRow");
  });

  it("says None in the left column rather than reserving a rail for an absence", () => {
    /* #1445: no optional rules, no second region -- and therefore no divider and no half-surface reserved
       for the word "None". The fact is still stated, quietly, beside the settings it belongs with. */
    expect(WAITING).toContain('data-testid="waiting-room-no-house-rules"');
    expect(WAITING).toContain("House rules \u00b7 <span style={styles.noneTag}>None</span>");
    expect(WAITING).toContain("{!houseRules.length && (");
    expect(WAITING).toContain("{railed && (");
    // The surface and the grid both collapse with it.
    expect(WAITING).toContain('railed ? "wr-columns" : "wr-columns wr-columns-solo"');
    expect(WAITING).toContain(".wr-columns-solo { grid-template-columns: minmax(0, 1fr); }");
    expect(WAITING).toContain("surfaceSolo: {");
  });

  it("marks a non-standard bank where the value is, instead of repeating it as a rule", () => {
    expect(WAITING).toContain('tag={variants.length === "standard" ? undefined : "Non-standard"}');
    // The amount is printed exactly once on this screen.
    expect(WAITING.split("bankSizeLabel(").length - 1).toBe(1);
  });
});

describe("the game leads and the code identifies (design note #1444)", () => {
  it("ranks the page, the game and the room in that order", () => {
    const at = (s: string) => WAITING.indexOf(s);
    expect(at("<h1 style={styles.title}>Waiting room</h1>")).toBeGreaterThan(-1);
    expect(at("<p style={styles.gameName}>")).toBeGreaterThan(at("<h1 style={styles.title}>"));
    expect(at("<p style={styles.roomLine}>")).toBeGreaterThan(at("<p style={styles.gameName}>"));
    expect(WAITING).toContain("<span style={styles.roomLabel}>Room</span>");
  });

  it("gives the game the size the code used to take", () => {
    /* #1443 unboxed the code and left it at 28px -- the size the box had been sized for -- so the largest
       thing on a screen about a game stayed the string you only need in order to reach it. */
    const game = WAITING.slice(WAITING.indexOf("gameName: {"));
    expect(game.slice(0, game.indexOf("},"))).toContain('fontSize: "26px"');
    const code = WAITING.slice(WAITING.indexOf("  code: {"));
    const codeBody = code.slice(0, code.indexOf("},"));
    expect(codeBody).toContain("fontSize: FONT_SIZE.strong");
    expect(codeBody).not.toContain('"28px"');
    /* Everything that makes the code USABLE survives -- it was only ever the size that made the claim. */
    expect(codeBody).toContain("ui-monospace");
    expect(codeBody).toContain('letterSpacing: "0.12em"');
    expect(codeBody).toContain('userSelect: "all"');
  });

  it("does not fork the hierarchy by visibility, and says the visibility once", () => {
    /* The code is equally load-bearing in a private room and equally not the subject, so one ladder serves
       both -- one fewer thing that can disagree between two rooms. */
    const header = WAITING.slice(WAITING.indexOf("<h1 style={styles.title}>"), WAITING.indexOf('aria-labelledby="wr-you"'));
    expect(header).not.toContain("visibility ===");
    expect(header).not.toContain("Private room");
    expect(header).not.toContain("Public room");
    // Its one home is the Visibility row, value and explanation together.
    expect(WAITING).toContain("value={VISIBILITY_COPY[visibility].label}");
    expect(WAITING).toContain("note={VISIBILITY_COPY[visibility].blurb}");
  });
});

describe("a description adds meaning rather than repeating the value (design note #1444)", () => {
  const VARIANTS = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");

  it("keeps the bank's amount out of the bank's description", () => {
    /* REPORTED: a row reading "Bank $20,000" followed by "$20,000 bank. Runs well past the Diesels...".
       TWO CALLERS, TWO NEEDS, ONE SOURCE: the host's `<select>` option says only "$20,000", so its helper has
       to name the bank; a definition list that has just printed the amount must not. */
    const lengths = ["short", "standard", "long"] as const;
    for (const length of lengths) {
      const amount = VARIANTS.bankSizeLabel(length);
      expect([length, VARIANTS.GAME_LENGTH_NOTE[length].includes(amount)]).toEqual([length, false]);
      // And the composed blurb the host's card still uses is that note with the amount in front of it.
      expect(VARIANTS.GAME_LENGTH_BLURB[length]).toBe(`${amount} bank. ${VARIANTS.GAME_LENGTH_NOTE[length]}`);
    }
    expect(WAITING).toContain("note={GAME_LENGTH_NOTE[variants.length]}");
    expect(WAITING).not.toContain("GAME_LENGTH_BLURB");
    expect(readStripped("components/HostSetupCard.tsx")).toContain("GAME_LENGTH_BLURB");
  });

  it("keeps every other setting's value out of its own prose", () => {
    /* Asked of the DATA rather than of the markup, because a note that restates its value is wrong wherever
       it is rendered. Each pair is (the value a row prints, the prose beneath it). */
    const V = VARIANTS;
    const pairs: Array<[string, string]> = [];
    for (const mode of ["live", "async"] as const) {
      pairs.push([V.GAME_MODE_COPY[mode].label, V.GAME_MODE_COPY[mode].blurb]);
    }
    const { VISIBILITY_COPY } = require("../components/HostSetupCard") as typeof import("../components/HostSetupCard");
    for (const visibility of ["public", "private"] as const) {
      pairs.push([VISIBILITY_COPY[visibility].label, VISIBILITY_COPY[visibility].blurb]);
    }
    for (const [value, note] of pairs) {
      expect([value, note.toLowerCase().includes(value.toLowerCase())]).toEqual([value, false]);
    }
  });

  it("derives the ante's figures rather than writing a second copy of them", () => {
    /* The treasury's share and the pool's are allowed to appear -- they add meaning the total does not carry
       -- but they come from `anteBreakdown`, never from a hand-written sentence. */
    expect(WAITING).toContain("formatJuno(ante.subsidyUjuno)");
    expect(WAITING).toContain("formatJuno(ante.netUjuno)");
    expect(WAITING).toContain("const ante = anteBreakdown(room?.anteUjuno);");
    // The total is printed once, as the row's value.
    const anteRow = WAITING.slice(WAITING.indexOf('label="Ante"'));
    expect(anteRow.slice(0, 500).split("formatJuno(ante.anteUjuno)").length - 1).toBe(1);
  });
});

describe("the room and its people own the left region (design note #1445)", () => {
  /* ==================================================================
      REPORTED from the captures: "Game Settings should not occupy the right column"
     ==================================================================
     #1444 was right that a setting is not a house rule and wrong about where the distinction goes: it gave a
     rail to the group that is true of EVERY table, and left the lower-left empty under a roster that had
     finished. The settings fall into the left column's flow now, after the action they qualify, and the right
     region is what it is named for. */
  const order = (...marks: string[]) => {
    const at = marks.map((m) => WAITING.indexOf(m));
    at.forEach((n, i) => expect([marks[i], n > -1]).toEqual([marks[i], true]));
    for (let i = 1; i < at.length; i += 1) {
      expect([marks[i - 1], marks[i], at[i - 1] < at[i]]).toEqual([marks[i - 1], marks[i], true]);
    }
  };

  it("keeps one source order, and it is the reading order at both widths", () => {
    order(
      "<h1 style={styles.title}>Waiting room</h1>",
      "<p style={styles.gameName}>",
      "<p style={styles.roomLine}>",
      'aria-labelledby="wr-you"',
      'aria-labelledby="wr-players"',
      "styles.actionArea",
      "styles.skipIntro",
      '<section style={styles.flowSection} aria-labelledby="wr-settings">',
      'className="wr-secondary"',
    );
  });

  it("does not put the settings between the identity controls and the roster", () => {
    expect(WAITING.indexOf('<section style={styles.flowSection} aria-labelledby="wr-settings">')).toBeGreaterThan(
      WAITING.indexOf('aria-labelledby="wr-players"'),
    );
  });

  it("gives the left region more of the surface than the rules, and one hairline between", () => {
    expect(WAITING).toContain("grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);");
    expect(WAITING).toContain("border-left: 1px solid #2a2a2a;");
    /* The RULE runs the surface's height; the rules themselves still end where they end, because nothing in
       the right column grows. A divider that stops two thirds of the way down reads as unfinished. */
    expect(WAITING).toContain("align-items: stretch;");
    const secondary = WAITING.slice(WAITING.indexOf(".wr-secondary {"));
    expect(secondary.slice(0, secondary.indexOf("}"))).not.toContain("height:");
  });
});

describe("the game's name and its own sentence (design note #1445)", () => {
  const VARIANTS = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");

  it("calls the Level Playing Field what it is called", () => {
    /* The article is part of the name. The internal id, the `lpf` abbreviation and the VARIANT copy's own
       label are untouched -- this is the player-facing TITLE only. */
    expect(VARIANTS.GAME_TYPE_COPY.levelPlayingField.label).toBe("18XX+: A Level Playing Field");
    expect(VARIANTS.VARIANT_COPY.levelPlayingField.label).toBe("Level Playing Field");
    expect(Object.keys(VARIANTS.GAME_TYPE_COPY)).toContain("levelPlayingField");
  });

  it("keeps the game's description when its row left the list", () => {
    /* The TITLE is not duplicated by it -- that is why the row went -- but the description is the only
       statement on this screen of what the table is playing, and under the Level Playing Field it is the only
       place the map's differences are listed at all. */
    expect(WAITING).toContain("<p style={styles.gameNote}>{GAME_TYPE_COPY[gameTypeOf(variants)].blurb}</p>");
    expect(WAITING.indexOf("styles.gameNote")).toBeGreaterThan(WAITING.indexOf("styles.roomLine"));
  });
});

describe("a rail is for a column's worth of rules (design note #1446)", () => {
  /* ==================================================================
      REPORTED of the single-rule capture: "a full-height divided column is reserved for one short item"
     ==================================================================
     Which is #1445's own no-rules argument arriving one case later: an empty rail and a rail holding two
     lines are the same fault at different sizes.
     THE COUNT DECIDES, and nothing else. A layout chosen by measuring rendered text is a layout that changes
     when a word is edited, and it cannot be asserted without a browser -- which is why these cases can be
     written at all. */
  it("switches on the number of active rules, not on anything rendered", () => {
    expect(WAITING).toContain("const RULES_FOR_RAIL = 3;");
    expect(WAITING).toContain("const railed = houseRules.length >= RULES_FOR_RAIL;");
    /* No height, no width, no viewport: nothing in this component measures itself to choose a layout. */
    expect(WAITING).not.toContain("getBoundingClientRect");
    expect(WAITING).not.toContain("innerWidth");
    expect(WAITING).not.toContain("matchMedia");
    expect(WAITING).not.toContain("ResizeObserver");
  });

  it("gives one or two rules a section in the flow, and three or more the rail", () => {
    expect(WAITING).toContain("{houseRules.length > 0 && !railed && (");
    expect(WAITING).toContain('data-testid="waiting-room-rules-inline"');
    expect(WAITING).toContain("{railed && (");
    expect(WAITING).toContain('data-testid="waiting-room-rules-rail"');
    /* The inline section follows the settings and wears the same separation -- a section, not a rail. */
    expect(WAITING.indexOf('data-testid="waiting-room-rules-inline"')).toBeGreaterThan(
      WAITING.indexOf('<h2 id="wr-settings" style={styles.sectionHeading}>Game settings</h2>'),
    );
    expect(WAITING).toContain('<section style={styles.flowSection} data-testid="waiting-room-rules-inline">');
  });

  it("takes the divider and the wide surface away with the rail", () => {
    /* 0, 1 and 2 are one layout: the compact surface, one column, no vertical rule. Only the rail brings the
       1040px grid, and the divider belongs to the rail rather than to the presence of any rules at all. */
    expect(WAITING).toContain('railed ? "wr-columns" : "wr-columns wr-columns-solo"');
    expect(WAITING).toContain("...(railed ? null : styles.surfaceSolo)");
    expect(WAITING).toContain(".wr-columns-solo { grid-template-columns: minmax(0, 1fr); }");
    // The hairline is the second region's own left border, so no second region means no hairline.
    expect(WAITING).toContain("border-left: 1px solid #2a2a2a;");
    const before = WAITING.slice(0, WAITING.indexOf('className="wr-secondary"'));
    expect(before.slice(-120)).toContain("{railed && (");
  });

  it("changes nothing about which rules there are, in what order, or what they say", () => {
    /* Presentation only: the same array, the same filter, the same shared copy (#961a). */
    expect(WAITING).toContain("const houseRules = VARIANT_TOGGLES.filter((toggle) => variants[toggle.key]);");
    expect(WAITING.split("VARIANT_TOGGLES.filter").length - 1).toBe(1);
    expect(WAITING).toContain("{toggle.label}");
    expect(WAITING).toContain("{toggle.blurb}");
    // One element and one map, so a rule cannot be rendered twice or in two orders.
    expect(WAITING.split("houseRulesSection").length - 1).toBe(3);
  });

  it("says the settings are settled, without telling a watcher to press Ready", () => {
    expect(WAITING).toContain("<p style={styles.faintNote}>Fixed when the room opened.</p>");
    expect(WAITING).not.toContain("when you press Ready");
    expect(WAITING).not.toContain("Set by the host before this room opened");
    /* One sentence for every reader -- no role-specific variant to keep in step. */
    expect(WAITING.split("Fixed when the room opened.").length - 1).toBe(1);
  });
});
