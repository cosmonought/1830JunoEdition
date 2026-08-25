/** @jest-environment node */

// No runtime imports: this file reads source text. `export {}` makes it a module for `--isolatedModules`.
export {};
//
// A previewed tile carries the tokens already standing on its hex. No canvas.
//
// ==================================================================
//  DESIGN NOTE 822 (harness): THE RULE WAS WRITTEN ABOVE THE PASS THE PREVIEW OVERTOOK
// ==================================================================
//
// REPORTED in three parts that turned out to be one:
//   7)  "when laying green tile on ERIE's home tile when a station marker is already on it, the preview tile
//       does not display which city has the station marker."
//   7a) "I suspect it may be worth checking whether all the double city tiles (OO and NY) continue previewing
//       preexisting stations on the track upgrades."
//   7c) "the tileselector radial menu renders the stations, but when players click the tile to preview it on
//       the hex, no station marker appears. It's only after they confirm placement that the station marker
//       appears."
//
// (7c) IS THE GENERAL FORM AND THE SUSPICION IN (7a) WAS RIGHT: it is every tile on every hex. ERIE's home is
// simply where a two-city upgrade makes the omission unmissable, because there the question is not "is my
// token still here" but "which of the two cities did it land in".
//
// THE PREVIEW IS OPAQUE ON PURPOSE. #167: "at 0.65 the board bled through and a yellow tile over a green hex
// became a muddy third colour." So a ghost tile painted after the token pass covers every token on its hex --
// and it was painted immediately after it, four lines later in the same function.
//
// AND #222 HAD ALREADY STATED THE RULE, directly above the pass the preview was overtaking: "tokens are drawn
// LAST, not merely late. A badge covering a token is worse than a badge covering track: a token says whose
// network this is, and a route's legality turns on it." One block was the exception and nothing checked.
//
// WHICH IS WHY THE FIX MOVES THE PREVIEW UP rather than moving the tokens down: #222 stays as written, and a
// ghost tile obeys the same ordering as a real one.
//
// WHAT THIS FILE CANNOT DO: look at the canvas. It pins the ORDER and the TILE the geometry is resolved
// against, which are the two things that were wrong. Whether the marker lands in the right circle is a
// playtest question, and on a two-city hex it is the whole question.

const RENDERER = (() => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(
    path.join(__dirname, "..", "components", "HexGridRenderer.tsx"),
    "utf8",
  );
})();

/** #490a: the note quotes the old ordering while explaining it. */
const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("the tokens are drawn after the ghost, not under it", () => {
  it("paints the preview before the token pass", () => {
    /* THE WHOLE BUG, as an ordering. Asserted by index rather than by adjacency, because the two blocks are
       separated by nothing today and could reasonably grow apart. */
    const preview = CODE.indexOf("if (previewTile) {");
    const tokens = CODE.indexOf("drawStationTokenPass();");
    expect(preview).toBeGreaterThan(-1);
    expect(tokens).toBeGreaterThan(-1);
    expect(preview).toBeLessThan(tokens);
  });

  it("keeps the preview opaque", () => {
    /* #167's decision, which is the REASON this was a bug rather than a cosmetic quirk -- a translucent ghost
       would have shown the token through it and nobody would have reported anything. Pinned so a future pass
       cannot "fix" the ordering by making the tile see-through instead. */
    expect(RENDERER).toContain("The preview is FULLY OPAQUE");
    const previewBlock = CODE.slice(CODE.indexOf("if (previewTile) {"), CODE.indexOf("drawStationTokenPass();"));
    expect(previewBlock).not.toContain("globalAlpha");
  });

  it("still draws tokens last overall", () => {
    // #222's rule, unchanged: nothing between the token pass and the end of the draw may cover a marker.
    expect(RENDERER).toContain("Tokens are drawn LAST, not merely late");
  });
});

describe("the marker is placed against the tile being previewed", () => {
  it("prefers the preview's tile over the laid one", () => {
    /* THE HALF THAT ANSWERS (7). Ordering alone would draw the token at the OLD tile's city geometry -- which
       on a two-city upgrade is the wrong circle, and is precisely the question the report is asking. */
    expect(CODE).toContain("previewTile && previewTile.q === q && previewTile.r === r");
    expect(CODE).toContain("tile_id: previewTile.tileId");
    expect(CODE).toContain("orientation: previewTile.orientation");
  });

  it("works on a hex with no laid tile at all", () => {
    /* ERIE'S CASE, and the reason the lookup could not simply be patched. Its home is an unlaid preprinted OO
       hex, so the real entry is `undefined` until the green upgrade lands -- there is no tile to fall back
       to, which is exactly where the report starts. */
    expect(CODE).toContain("const laid = mapGrid.tiles.find((entry) => entry.q === q && entry.r === r);");
    expect(CODE).toContain("landmark: laid?.landmark ?? null,");
  });

  it("spells the shape out rather than casting it", () => {
    /* A cast would let a field added to `MapTileEntry` later arrive as `undefined` inside a renderer, which
       is the class of bug that gets reported as "it looks wrong sometimes". */
    expect(CODE).toContain("const laidTile: MapTileEntry | undefined =");
    expect(CODE).not.toContain("as MapTileEntry");
  });

  it("leaves every other hex reading the real board", () => {
    // THE CONTROL: the override is scoped to the previewed hex, so nothing else on the board changes.
    const lookup = CODE.slice(
      CODE.indexOf("const laid = mapGrid.tiles.find"),
      CODE.indexOf("const chainCity = tokenCityIndex(company, q, r);"),
    );
    expect(lookup).toContain(": laid;");
  });
});
