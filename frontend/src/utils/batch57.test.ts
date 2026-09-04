/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1083-1085 (harness): FIVE THINGS IN THE PAGE, IN ORDER
// ==================================================================
//
// RULED: "completely restructure the main layout hierarchy to remove redundant buttons, clear out
// developer-clutter, and improve the logical flow of the viewport", with the order stated exactly:
//
//   1. Title Header (Project 18xx, Room Name, <- Lobby)
//   2. Action Bar (global turn controls)
//   3. Tabs -- directly on top of the viewport
//   4. Current Tab Viewport
//   5. Global Footer (Powered by Neta DAO)
//
// MOST OF THIS FILE IS ABOUT ORDER, and order is the one property a source scan can actually check well: the
// render tree is written top to bottom, so "A is above B" is `indexOf(A) < indexOf(B)` and cannot be
// satisfied by accident. `anchorIndex` is used for both sides of every comparison, because `indexOf`
// returning -1 is what makes an ordering assertion vacuous (`sourceScan.ts` #886) and every one of these is
// an ordering assertion.
//
// THE DELETIONS ARE ASSERTED AS ABSENCES PAIRED WITH PRESENCES. "The Leave Room button is gone" is satisfied
// by deleting the whole room bar, by deleting the whole file, and by a typo -- so each removal is checked
// beside the thing that was supposed to survive it.

export {};

const { readStripped, readSource, sliceBetween, anchorIndex } =
  require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const TOPBAR = readStripped("components/TopBar.tsx");
const FOOTER = readStripped("components/AppFooter.tsx");
const ROOMBAR = readStripped("components/SandboxRoomBar.tsx");
const SHEET = readStripped("styles/appStyles.ts");

/** Both sides through `anchorIndex`, so a missing anchor throws rather than passing as -1. */
const above = (haystack: string, first: string, second: string) => {
  expect(anchorIndex(haystack, first, `first: ${first}`)).toBeLessThan(
    anchorIndex(haystack, second, `second: ${second}`),
  );
};

/* ------------------------------------------------------------------ */
/* The ruled order                                                    */
/* ------------------------------------------------------------------ */

describe("the page reads in the order it was ruled to", () => {
  it("puts the title above the action bar", () => {
    above(APP, "<TopBar", "<ContextualActionBar");
  });

  it("puts the action bar above the tabs", () => {
    /* THE ITEM THIS BATCH IS NAMED FOR: "global controls sit above local navigation." */
    above(APP, "<ContextualActionBar", "<MainTabBar");
  });

  it("puts the tabs directly on top of the viewport", () => {
    /* NOTHING BETWEEN THEM. The tab strip and the workspace are items 3 and 4, and the ruling says
       "directly" -- so this asserts the ABSENCE of anything between rather than just the order. */
    above(APP, "<MainTabBar", "{isWorkspaceTab && (");
    const between = sliceBetween(APP, "<MainTabBar", "{isWorkspaceTab && (");
    expect(between).not.toContain("<ContextualActionBar");
    expect(between).not.toContain("<TopBar");
    expect(between).not.toContain("<AppFooter");
  });

  it("ends with the footer", () => {
    /* Design note #1113: the footer takes a `surface` now -- the lobby gets the moving mark, the board the
       still one -- so the anchor carries the prop. The claim is unchanged: last of the five, and one of it. */
    above(APP, "{isWorkspaceTab && (", '<AppFooter surface="game" />');
    expect(APP.split('<AppFooter surface="game" />').length - 1).toBe(1);
  });

  it("keeps the spectator notice in the bar's slot rather than the viewport's", () => {
    /* THE NOTICE REPLACES THE BAR (#23), so it has to travel with it -- left behind in `<main>` it would
       have appeared below the tabs while the slot above them stood empty. */
    above(APP, "{spectator ? (", "<MainTabBar");
  });
});

/* ------------------------------------------------------------------ */
/* #1084 -- the bar is global now                                     */
/* ------------------------------------------------------------------ */

describe("the action bar is global rather than workspace-only", () => {
  it("renders outside the workspace branch", () => {
    /* THE STRUCTURAL CLAIM, and the one that makes the bar appear on `ledger`, `rules` and `tiles` for the
       first time. Asserted as "not inside the branch" rather than as its position, because a bar rendered
       above the tabs but still wrapped in `isWorkspaceTab` would satisfy every ordering case above and still
       leave the reference tabs bare. */
    const workspace = APP.slice(anchorIndex(APP, "{isWorkspaceTab && ("));
    expect(workspace).not.toContain("<ContextualActionBar");
    expect(workspace).not.toContain("{spectator ? (");
  });

  it("still hands the bar the tab cursor, which is what makes the redirect possible", () => {
    /* `misplacedSurfaceTab` NEEDS BOTH `activeTab` AND `onSelectTab` -- #390 made the handler part of the
       condition because "a redirect button with nothing to dispatch is a dead end, not a fix." Global
       rendering without these two would put a live action bar on the Rules tab. */
    const bar = sliceBetween(APP, "<ContextualActionBar", "turnGlowActive={turnGlowActive}");
    expect(bar).toContain("activeTab={activeMainTab}");
    expect(bar).toContain("onSelectTab={setActiveMainTab}");
  });

  it("keeps the redirect that replaces the whole bar on a reference tab", () => {
    /* RULED: "when you're on a non-actionable tab like Rules Reference ... the Action Button still clicks to
       take you back to the working tab. That's the behavior we currently have."
       THE MECHANISM IS UNTOUCHED BY THE MOVE, which is the point of asserting it here: it is driven by
       `activeTab`, not by where in the tree the bar sits. */
    const panel = readStripped("panels/ContextualActionBar.tsx");
    expect(panel).toContain("if (misplacedTab !== null) {");
    expect(panel).toContain("onClick={() => onSelectTab?.(misplacedTab)}");
    expect(panel).toContain("Return to {misplacedTabLabel}");
    // And `misplacedSurfaceTab` answers for EVERY tab that is not the round's surface, reference ones too.
    const lookup = readStripped("components/MainTabBar.tsx");
    expect(lookup).toContain("return activeTab === correct ? null : correct;");
  });
});

describe("the bar keeps its pin and gains its own inset", () => {
  it("stays sticky, so it travels over the tabs", () => {
    /* RULED, with the trade named: "I don't think I want the tabs to become sticky ... So I say let it scroll
       over the Tabs." The tab strip therefore has no `position`, and the bar keeps its own. */
    const bar = sliceBetween(SHEET, "actionBar: {", "},");
    expect(bar).toContain('position: "sticky"');
    expect(bar).toContain("top: 0");
    const tabs = sliceBetween(SHEET, "mainTabBar: {", "},");
    expect(tabs).not.toContain("position:");
  });

  it("paints over the tabs rather than under them", () => {
    /* A PINNED BAR THAT PASSED BEHIND AN OPAQUE STRIP would vanish for the height of the tabs. The tab bar's
       background is opaque `#0F172A`, so the bar's stacking order is what decides this. */
    expect(sliceBetween(SHEET, "actionBar: {", "},")).toContain("zIndex: 50");
    expect(sliceBetween(SHEET, "mainTabBar: {", "},")).not.toContain("zIndex");
  });

  it("carries the inset it used to get from the pane it left", () => {
    /* `canvasPane` HAS `padding: 20px` and the bar was inside it. At the root it would have gone full-bleed,
       which reads as a banner rather than a card and puts its rounded corners against the window edge. */
    const bar = sliceBetween(SHEET, "actionBar: {", "},");
    expect(bar).toContain('marginLeft: "20px"');
    expect(bar).toContain('marginRight: "20px"');
    /* AND NO VERTICAL MARGIN, which is #426's rule and would break the pin: a sticky element's own top or
       bottom margin travels with it and offsets it from `top: 0`. */
    expect(bar).not.toContain("marginTop");
    expect(bar).not.toContain("marginBottom");
  });

  it("separates from the tabs with air rather than a second rule", () => {
    /* ASKED: "should we add a subtle drop-shadow or a bottom border to it so it visually separates from the
       navigation tabs directly beneath it?" NEITHER: the bar is already a bordered, rounded card on a
       different ground from both the strip and the page, so another edge would be a second statement of a
       thing said three ways. The gap goes on the TABS because #426 forbids it on the bar. */
    expect(sliceBetween(SHEET, "mainTabBar: {", "},")).toContain('marginTop: "10px"');
    const bar = sliceBetween(SHEET, "actionBar: {", "},");
    expect(bar).toContain('borderRadius: "10px"');
    expect(bar).not.toContain("boxShadow");
    /* THE SHADOW EXISTS WHERE IT IS TRUE: the pinned form, which is the one moment the bar really is floating
       over something. Already there since #298 -- this case is what stops it being added twice. */
    expect(sliceBetween(SHEET, "actionBarCondensed: {", "},")).toContain("boxShadow");
  });
});

/* ------------------------------------------------------------------ */
/* #1085 -- one way back, not two                                     */
/* ------------------------------------------------------------------ */

describe("the second return bar is gone", () => {
  it("has no component, no import and no render site", () => {
    /* #427 EXISTED BECAUSE THE BAR VANISHED ON REFERENCE TABS. It does not vanish any more, so its redirect
       and #427's bar would have stacked two "Return to X" controls on the same three tabs -- #891's shape.
       ASSERTED AT ALL THREE LEVELS, because deleting only the render site leaves a component waiting for a
       caller and deleting only the import does not compile. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    expect(fs.existsSync(path.join(__dirname, "..", "panels", "ReturnToTurnBar.tsx"))).toBe(false);
    expect(APP).not.toContain("ReturnToTurnBar");
    expect(SHEET).not.toContain("returnBarNotice: {");
  });

  it("leaves the reference tabs a way back all the same", () => {
    /* THE CONTROL ON THE DELETION, and the thing the user actually asked to preserve. The bar renders on
       every tab and #390 turns it into one button there -- so the way back survives its component. */
    above(APP, "<ContextualActionBar", "{activeMainTab === \"ledger\" && (");
    const panel = readStripped("panels/ContextualActionBar.tsx");
    expect(panel).toContain("misplacedSurfaceTab(activeTab, roundType)");
  });
});

/* ------------------------------------------------------------------ */
/* #1083 -- the clutter, and where each piece went                    */
/* ------------------------------------------------------------------ */

describe("the room bar's in-room strip is gone, piece by piece", () => {
  it("prints no action count anywhere", () => {
    /* RULED: "Completely delete the '68 actions' ... text from the UI." The counter itself survives as
       replay bookkeeping -- it is a dependency of the sandbox replay effect -- so this asserts the absence of
       the SENTENCE rather than of the variable, which is the actual instruction. */
    expect(ROOMBAR).not.toContain("action{appliedCount");
    expect(ROOMBAR).not.toContain("appliedCount");
    expect(APP).not.toContain("appliedCount={");
    // The bookkeeping is untouched, which is what makes this a UI deletion rather than a feature removal.
    expect(APP).toContain("const [sandboxAppliedCount, setSandboxAppliedCount] = useState(0);");
  });

  it("offers one exit, not two", () => {
    /* RULED: "Completely delete the 'Leave Room' button. Players will use the existing '<- Lobby' button in
       the title area." So the button goes AND the arrow stays -- either alone is the wrong change. */
    expect(ROOMBAR).not.toContain("Leave room");
    expect(ROOMBAR).not.toContain("onLeave");
    expect(TOPBAR).toContain("&larr; Lobby");
  });

  it("returns nothing at all once the room exists", () => {
    // What is left of the component is the host/join form, which is how a solo sandbox BECOMES a room.
    expect(ROOMBAR).toContain("if (roomCode) return null;");
    expect(ROOMBAR).toContain("Host game");
    expect(ROOMBAR).toContain("Join game");
  });

  it("drops the mounted-but-dead instance in the shell", () => {
    /* IT COULD NOT RENDER SINCE #533: `if (sandbox && !sandboxRoomCode)` returns the gate above the shell, so
       by the time the shell paints, `sandbox` implies a room code -- and the component now returns `null` for
       exactly that. Two live instances remain, both on surfaces where there is genuinely no room yet. */
    expect(APP.split("<SandboxRoomBar").length - 1).toBe(1);
    above(APP, "<SandboxRoomBar", "<TopBar");
    expect(readStripped("components/Lobby.tsx")).toContain("<SandboxRoomBar");
  });

  it("keeps the room's error reachable", () => {
    /* THE ONE THING IN THAT STRIP THAT WAS NOT CLUTTER. It moved beside `chatError`, which reports the same
       kind of fact about the same room -- and it is gated on being IN a room, so the join form still shows
       its own failures where a refused code is being typed. */
    expect(APP).toContain("{sandboxRoomCode && sandboxRoomError && (");
    expect(ROOMBAR).toContain("{error && <span style={styles.error}>{error}</span>}");
  });
});

describe("the credit and the room name swapped places", () => {
  it("takes the credit out of the header", () => {
    expect(TOPBAR).not.toContain("Powered by Neta DAO");
    expect(TOPBAR).not.toContain("netaCredit");
    expect(TOPBAR).not.toContain("neta-credit");
  });

  it("anchors it in a footer that renders it once", () => {
    expect(FOOTER).toContain("Powered by Neta DAO");
    expect(FOOTER).toContain("styles.netaCredit");
    /* #47's SAFETY RULE TRAVELLED WITH THE LINK. `target="_blank"` without `rel` hands the new tab a
       `window.opener` handle back into this app. */
    expect(FOOTER).toContain('rel="noopener noreferrer"');
    // And the hover rule came with it, rather than being left behind styling nothing.
    expect(FOOTER).toContain(".neta-credit:hover");
    expect(readStripped("components/TopBar.tsx")).not.toContain(".neta-credit:hover");
  });

  it("puts the room's code in the slot it vacated", () => {
    expect(TOPBAR).toContain("{roomName && (");
    expect(TOPBAR).toContain("styles.topBarRoomCode");
    /* THE TREATMENT CAME WITH IT: the code is the string a player reads aloud or pastes, so it stays
       monospaced and wholly selectable rather than becoming a chip to retype from a screenshot. */
    const code = sliceBetween(SHEET, "topBarRoomCode: {", "},");
    expect(code).toContain('userSelect: "all"');
    expect(code).toContain("ui-monospace");
    // And the style it was cut from is deleted rather than orphaned in the file it left.
    expect(ROOMBAR).not.toContain("userSelect");
  });

  it("names the room in one place, not two", () => {
    /* THE FAULT THIS BATCH IS REMOVING, so re-introducing it one line up would be the bad joke. `roomName` is
       the sandbox code only; an on-chain game's identity is already in the strip beside it. */
    expect(APP).toContain("roomName={sandboxRoomCode}");
    expect(APP).not.toContain("roomName={roomId}");
  });

  it("puts the footer at the bottom without pinning it there", () => {
    /* `marginTop: auto` IN THE ROOT'S COLUMN pushes it down on a short page and lets it follow content on a
       long one. NOT `position: fixed` -- that is what `statusLineDock` is, and it is fixed because a player
       consults it mid-scroll. A credit is read once; pinning it would spend permanent viewport height. */
    /* ==================================================================
        DESIGN NOTE 1140: "NOT PINNED" WAS ASSERTED AS "NO `position` AT ALL"
       ==================================================================
       THE CLAIM IN THIS CASE'S OWN NOTE IS ABOUT PINNING -- `fixed` spends permanent viewport height on a
       credit that is read once -- and it was written as the absence of the whole property. `position:
       relative` pins nothing; it is a stacking anchor, and #1140 needs one here because the lobby paints a
       photograph in a positioned layer that would otherwise cover the footer.
       NARROWED TO THE TWO VALUES THE CLAIM IS ACTUALLY ABOUT. A future `fixed` or `sticky` still fails; a
       `relative` that exists to keep the credit visible no longer does. */
    const footer = sliceBetween(SHEET, "appFooter: {", "},");
    expect(footer).toContain('marginTop: "auto"');
    expect(footer).not.toContain('position: "fixed"');
    expect(footer).not.toContain('position: "sticky"');
    expect(sliceBetween(SHEET, "appRoot: {", "},")).toContain('flexDirection: "column"');
  });
});
