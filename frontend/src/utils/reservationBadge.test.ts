/** @jest-environment node */

// No runtime imports beyond the livery table: this file reads source text.
//
// A ring means a slot, and ERIE's reservation is not in one.
//
// ==================================================================
//  DESIGN NOTE 826 (harness): #43 KNEW THIS AND DREW THE RING ANYWAY
// ==================================================================
//
// REPORTED: "the home station reservation marker has a yellow border which kind of looks like the glowing
// border of legal station placements for other corporations (even though the ERIE hex is not illuminated for
// them). Since that ERIE home station reservation marker isn't actually on a city/station, I wonder if we
// could remove the border from it? That's how it is on my physical 1830 board: 'ERIE' is just printed on that
// hex away from the two cities/stations."
//
// THE COLLISION IS REAL AND IS NOT THE REASON. #48 draws the reserved ring in the corporation's own livery,
// and ERIE's is `#f5cd3a` -- yellow, against a placement glow that is also yellow. Recolouring it would have
// answered the complaint and left the actual mistake in place.
//
// THE ACTUAL MISTAKE is that a RING is this app's shape for "a token is in this slot, or could be". #43 had
// already worked out that ERIE's badge must NOT commit to a circle -- "anchoring the still-undecided reserved
// badge onto one specific circle would misleadingly imply that slot is already committed" -- moved it into
// neutral hex-margin space for exactly that reason, and then drew a slot's ring around it. The position said
// "undecided" and the outline said "here".
//
// SCOPED TO THE MARGIN BADGE, which is the distinction the report makes and the one that keeps this from
// being a second wrong shape: on Baltimore or Boston the reservation sits ON the city it will occupy, and
// there the ring is telling the truth.

import { stationTickerColor } from "../components/hexContractTypes";

const read = (relative: string) => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
};
const strip = (raw: string) =>
  raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PRIMITIVES = strip(read("components/hexCanvasPrimitives.ts"));
const RENDERER = strip(read("components/HexGridRenderer.tsx"));

describe("the collision the report noticed is real", () => {
  it("draws the reserved ring in the corporation's own colour", () => {
    // #48, unchanged: the ring previews the brand. Which is why ERIE's was yellow.
    expect(PRIMITIVES).toContain("ctx.strokeStyle = muted ? color : STATION_TOKEN_RING;");
  });

  it("and ERIE's colour is the yellow that made it read as a glow", () => {
    /* Read off the livery table rather than asserted from the report, so this stays true of whatever ERIE is
       painted next. ERIE is company 6. */
    expect(stationTickerColor(6).toLowerCase()).toBe("#f5cd3a");
  });
});

describe("a badge in the margin wears no ring", () => {
  it("takes the flag from where the badge is placed", () => {
    /* THE PROPERTY, and the reason this is not "reservations lose their ring". `YELLOW_OO_HEXES` is the same
       set #43 used to decide the POSITION, so the outline and the position now answer one question instead of
       contradicting each other. */
    expect(RENDERER).toContain("const inMargin = YELLOW_OO_HEXES.has(home.label);");
    expect(RENDERER).toContain("!inMargin,");
  });

  it("keeps the ring on a reservation that IS in a city", () => {
    /* Baltimore, Boston, Albany, Montreal: the badge marks the circle the token will occupy, and the ring
       says something true there. Asserted through the default rather than a second call site -- `ringed`
       defaults to `true`, so every other caller is untouched by construction. */
    expect(PRIMITIVES).toContain("ringed = true,");
  });

  it("leaves the real tokens alone", () => {
    // Two callers draw an actual token and neither passes the flag; the default covers them.
    expect(RENDERER).toContain("drawStationTokenMarker(ctx, point, hexSize, ticker, marker.color, false, radius)");
  });

  it("still identifies the corporation without it", () => {
    /* THE GUARD ON THE DELETION. The fill and the ticker are what say whose reservation this is; the ring was
       never carrying that. #733's contrast rule picks the text colour against the fill, so removing an
       outline cannot make the letters unreadable. */
    /* Design note #1092 neutralised the muted fill, `#9CA3AF` -> `#a8a6a0`. THE CLAIM IS UNAFFECTED: what
       this line guards is that a muted badge still takes a FILL and the corporation's own colour still
       reaches it through `color`, so the fill and the ticker keep saying whose reservation it is. Only the
       grey standing in for an unfloated corporation changed, and it stayed a grey. */
    expect(PRIMITIVES).toContain('const badgeFill = muted ? "#a8a6a0" : color;');
    expect(PRIMITIVES).toContain("bestContrastTextColor(badgeFill)");
  });

  it("does not shrink the ticker for a collar that is not there", () => {
    /* `fitTokenFontSize` measures against `ctx.lineWidth` to keep the text clear of the ring. Left at
       whatever the previous draw set, an un-ringed badge would size its letters for a stroke it never
       painted -- a stale-canvas-state bug, and the kind that only shows up after some other token drew
       first. */
    expect(PRIMITIVES).toContain("ctx.lineWidth = 0;");
    expect(PRIMITIVES).toContain("fitTokenFontSize(ctx, ticker, radius, ctx.lineWidth)");
  });
});

describe("the position and the outline now agree", () => {
  it("keeps #43's margin placement", () => {
    /* THE HALF THAT WAS ALREADY RIGHT, and the half this fix is derived from: the badge sits away from both
       circles because the President has not chosen one. */
    /* A FRAGMENT THAT SURVIVES THE WRAP. #43's sentence breaks across two `//` lines between "would" and
       "misleadingly", so the phrase a reader sees is not a string the file contains. Fifth time this pass
       that source text has read as contiguous and was not -- a JSX `$`, a `+`-joined tutorial line, a
       wrapped block comment, a template literal's doubled `$`, and now a wrapped line comment. */
    expect(read("components/HexGridRenderer.tsx")).toContain(
      "misleadingly imply that slot is already committed",
    );
  });

  it("still puts ERIE's badge on its own vertex", () => {
    // #106: straight down overlapped the bottom city marker, so E11 takes vertex 2 at the same magnitude.
    expect(RENDERER).toContain("const erieVertex2 = hexSlotDirection(9);");
  });
});
