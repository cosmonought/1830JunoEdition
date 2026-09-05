/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1170 (harness): THE SAME RULE, BROKEN A SECOND TIME
// ==================================================================
//
// REPORTED: "the animated Neta DAO logo on the Lobby and Waiting Room is back to rendering with a black box
// around it."
//
// #1132 DIAGNOSED THIS EXACT BOX ON A DIFFERENT ELEMENT and wrote the rule down in full: nothing between a
// blended element and its backdrop may create a stacking context. #1140 then put `position: relative` AND
// `z-index: 1` on the footer to stop the credit's words sliding under the lobby photograph -- the fourth item
// on that list -- and the mark lost its backdrop.
//
// A PROSE RULE BROKEN TWICE IS A RULE THAT NEEDS A TEST. So this file stops asserting a fix and starts
// asserting the RULE: for every element in this app that carries `mix-blend-mode`, no box BETWEEN it and the
// box that paints the ground it keys against may isolate it.
//
// "BETWEEN" IS THE WORD #1132 DID NOT HAVE, and writing this file is what produced it -- the first draft said
// "no ancestor", failed on `scene`, and the code was right: a stacking context on the PAINTER is the group
// the blend happens in, not a barrier to it. See #1170a below.
//
// WHY THE CHAINS ARE LISTED BY HAND. A source scan cannot walk a DOM, so the ancestry is written down here
// and the isolating properties are what get detected. That makes this list a thing to maintain -- but the
// alternative is rendering three screens in jsdom, which does not implement blending or stacking at all and
// would pass whatever it was given. The chains are short and they have not changed in forty notes.

export {};

const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const SOURCES: Record<string, string> = {
  appStyles: readStripped("styles/appStyles.ts"),
  Lobby: readStripped("components/Lobby.tsx"),
  NetaMark: readStripped("components/NetaMark.tsx"),
  AppFooter: readStripped("components/AppFooter.tsx"),
  SandboxWaitingRoom: readStripped("components/SandboxWaitingRoom.tsx"),
};

/** The style object literal named `name` in `file`, comments already stripped. */
function styleBlock(file: keyof typeof SOURCES, name: string): string {
  const source = SOURCES[file];
  const at = source.indexOf(`\n  ${name}: {`);
  expect([file, name, at]).not.toEqual([file, name, -1]);
  const end = source.indexOf("\n  },", at);
  expect([file, name, end]).not.toEqual([file, name, -1]);
  return source.slice(at, end);
}

/* EVERY WAY A BOX BECOMES A STACKING CONTEXT that this codebase could plausibly reach for. `z-index` is
   handled separately because it only isolates on a positioned box, which is the precise distinction #1140
   fell through. `mixBlendMode` is here because a blend on an ANCESTOR groups its children too -- the mark
   would then key against its own parent rather than against the room. */
const ISOLATORS = [
  "transform:",
  "filter:",
  "backdropFilter:",
  "perspective:",
  "willChange:",
  'isolation: "isolate"',
  "mixBlendMode:",
  "contain:",
  "opacity:",
];

function expectTransparentToBlending(file: keyof typeof SOURCES, name: string) {
  const block = styleBlock(file, name);
  for (const property of ISOLATORS) {
    expect([name, property, block.includes(property)]).toEqual([name, property, false]);
  }
  /* THE ONE #1140 TRIPPED OVER. A `z-index` other than `auto` isolates only when the box is positioned, so
     neither half is a fault alone and the pair is never obviously wrong at the point somebody types it. */
  const positioned = /position: "(relative|absolute|fixed|sticky)"/.test(block);
  expect([name, "positioned + z-index", positioned && block.includes("zIndex:")]).toEqual([
    name,
    "positioned + z-index",
    false,
  ]);
}

describe("the footer mark can still see the room it keys against", () => {
  /* THE CHAIN: lobby/waiting-room root -> <footer appFooter> -> <a netaCredit> -> <video mix-blend-mode>.
     The backdrop is OUTSIDE the footer in both rooms -- the lobby's photograph is in `sceneClip`, a sibling;
     the waiting room's is a background on the root -- so every link in that chain has to stay transparent. */
  it("keeps the footer out of the blend's way", () => {
    expectTransparentToBlending("appStyles", "appFooter");
  });

  it("keeps the credit's own lockup out of it too", () => {
    expectTransparentToBlending("appStyles", "netaCredit");
  });

  it("still positions the footer, which is the half that was actually needed", () => {
    /* #1140's bug was a stacking LAYER, not a stacking ORDER: `sceneClip` is positioned, and a positioned
       element paints above an unpositioned in-flow sibling however late that sibling appears. Being
       positioned at all is what lifts the words out from under the photograph. */
    expect(styleBlock("appStyles", "appFooter")).toContain('position: "relative"');
  });

  it("relies on tree order rather than on a number", () => {
    /* Appendix E step 8 paints `z-index: auto` and `z-index: 0` positioned boxes together, in tree order, and
       the footer is the lobby root's LAST child while the scene is near its first. If the footer ever stops
       being last, the words go back under the picture -- so the order is asserted, not assumed. */
    const lobby = SOURCES.Lobby;
    expect(lobby.indexOf("styles.sceneClip")).toBeGreaterThan(-1);
    expect(lobby.lastIndexOf('<AppFooter surface="meta" />')).toBeGreaterThan(
      lobby.indexOf("styles.sceneClip"),
    );
  });

  it("gives the waiting room's copy the same ground", () => {
    /* No `sceneClip` here -- the photograph is a background on the ROOT, so the footer has only to avoid
       isolating itself from it. Asserted because a flat `#0f0f0f` would key just as well and somebody
       simplifying this away would not see the mark break until they looked at it. */
    const root = styleBlock("SandboxWaitingRoom", "root");
    expect(root).toContain('backgroundColor: "#0f0f0f"');
    expect(root).toContain("waiting-room.jpg");
    expect(SOURCES.SandboxWaitingRoom).toContain('<AppFooter surface="meta" />');
  });

  it("still needs the blend at all, which is why all of this matters", () => {
    /* h264 has no alpha. Drop `screen` and the fix above becomes pointless rather than wrong. */
    expect(SOURCES.NetaMark).toContain('mixBlendMode: "screen"');
    expect(SOURCES.NetaMark).toContain("NETA_LOGO_LOOP");
  });
});

describe("the lobby wordmark keeps the clearance #1132 won for it", () => {
  /* THE CHAIN IS SHORTER because the backdrop is INSIDE the group: `sceneClip` is a stacking context and the
     photograph is its child, so the title keys against the room within it. Only what sits between the scene
     and the wordmark has to stay clean. */
  it("centres the title by arithmetic rather than by transform", () => {
    expectTransparentToBlending("Lobby", "titleAnchor");
    expect(styleBlock("Lobby", "titleAnchor")).toContain('left: "40%"');
  });

  it("lets the box that PAINTS the picture isolate, because it is the group", () => {
    /* ==================================================================
        DESIGN NOTE 1170a: THE RULE IS ABOUT INTERMEDIARIES, NOT ABOUT ANCESTORS
       ==================================================================
       MY FIRST VERSION OF THIS FILE FAILED HERE, and the code was right. `scene` carries
       `transform: translate(-50%, -50%)` -- item one on the isolator list -- and the wordmark inside it
       blends perfectly, because `scene` is also the element that PAINTS the photograph, as its own
       `backgroundImage`. An ancestor's background is painted below its descendants IN THE SAME GROUP, so a
       stacking context on the painter is not a barrier: it is the group the blend happens in.
       SO #1132's RULE SHARPENS. Not "no ancestor may create a stacking context" but "nothing BETWEEN the
       blended element and the box that paints its backdrop may". `scene` and `sceneClip` are on the far side
       of that line; `titleAnchor` is on the near side, and is the one this pair actually constrains.
       AND IT IS EXACTLY WHY THE FOOTER IS DIFFERENT. The footer paints nothing at all -- #1135 removed its
       strip deliberately -- so it can only ever be an intermediary, and isolating it strands the mark over
       transparency. A background on the footer would ALSO have fixed the report, by making it a painter; that
       is the plate this project has now rejected twice, and naming the alternative is how this note stays
       honest about there having been one. */
    const scene = styleBlock("Lobby", "scene");
    expect(scene).toContain("transform:");
    expect(scene).toContain("lobby-boardroom.jpg");
  });

  it("constrains the one box that is genuinely in between", () => {
    /* `titleAnchor` sits between `scene`'s background and the wordmark. It is the whole of the near side. */
    const anchor = styleBlock("Lobby", "titleAnchor");
    expect(anchor).not.toContain("transform:");
    expect(SOURCES.Lobby).toContain("<div style={styles.titleAnchor}>");
  });

  it("keeps the photograph inside the group the title blends in", () => {
    /* If the wordmark ever moves out of `scene`, it is in the footer's position and needs the footer's
       treatment -- a chain of clean intermediaries all the way to whatever paints behind it. */
    const clip = styleBlock("Lobby", "sceneClip");
    expect(clip).toContain('position: "absolute"');
    expect(clip).toContain("zIndex: 0");
    expect(SOURCES.Lobby).toContain("<div style={styles.scene}>");
  });
});
