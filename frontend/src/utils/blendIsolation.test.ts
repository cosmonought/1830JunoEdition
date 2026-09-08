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
  YellowSignOverlay: readStripped("components/YellowSignOverlay.tsx"),
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
    /* Design note #1266: the photograph moved to `sceneLayer`, a fixed child at `z-index: -1`, so a growing
       roster cannot re-fit it (that re-fit was reported as the screen "zooming" on Ready). The root is now
       the stacking context that holds both the layer and the footer -- the PAINTER's group, #1170a -- so
       the mark still keys against the picture. Pinned: the layer paints the room, the root isolates, and
       the layer renders in both the room and its hold. */
    const scene = styleBlock("SandboxWaitingRoom", "sceneLayer");
    expect(scene).toContain("waiting-room.jpg");
    expect(scene).toContain('position: "fixed"');
    expect(scene).toContain("zIndex: -1");
    expect(root).toContain('isolation: "isolate"');
    expect(SOURCES.SandboxWaitingRoom.split("styles.sceneLayer").length - 1).toBe(2);
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
    // Design note #1294: the scene's cover arithmetic is spread per render from the live scale.
    expect(SOURCES.Lobby).toContain("<div style={{ ...styles.scene, ...sceneSizeFor(uiScale) }}>");
  });
});

describe("the haunting keys against the board, not against its own box", () => {
  /* ==================================================================
      DESIGN NOTE 1260 (harness): THE RULE, BROKEN A THIRD TIME -- AND IT PREDATES THE RULE
     ==================================================================
     REPORTED: "Yellow Sign video has a black box", "Carcosa Awaits video has a black box", and from the seat
     that did not act: "the black box but no video". #1043 put `mix-blend-mode: screen` on the `<video>` and
     wrapped it in a `position: fixed` container with a `z-index` -- which is #1140's pair exactly, an
     intermediary that isolates. The clip screened against the empty container and stayed black.
     THE CHAIN: shell root (`appRoot` + chrome zoom) -> <div container, fixed, z-index> -> <video>. The
     container is the group, so the blend goes ON it (#1170a's distinction), and only the root above it has
     to stay clear. */
  it("puts the blend on the group, not on the clip inside it", () => {
    expect(styleBlock("YellowSignOverlay", "containerScreened")).toContain('mixBlendMode: "screen"');
    expect(styleBlock("YellowSignOverlay", "videoScreened")).not.toContain("mixBlendMode");
    expect(SOURCES.YellowSignOverlay).toContain("feathered ? null : styles.containerScreened");
  });

  it("keeps the shell root out of the blend's way", () => {
    /* `zoom` is not on the isolator list and does not create a stacking context. */
    expectTransparentToBlending("appStyles", "appRoot");
  });

  it("does not paint a frame it has not decoded", () => {
    /* The other half of "black box but no video": a rejected unmuted `play()` retries muted, and nothing
       is visible until the element reports `playing`. */
    expect(SOURCES.YellowSignOverlay).toContain("video.muted = true;");
    expect(SOURCES.YellowSignOverlay).toContain("onPlaying={() => setPlaying(true)}");
    expect(SOURCES.YellowSignOverlay).toContain('visibility: playing ? "visible" : "hidden"');
  });
});
