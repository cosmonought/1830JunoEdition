/** @jest-environment node */
//
// The shorthand rule, and a scan for the pattern that caused it. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 732 (harness): THE BUG THAT NEEDS THREE RENDERS
// ==================================================================
//
// REPORTED of the Tiles tab: "when I click it to close the expansion it leaves the tile with a white
// background. Clicking it again drops the white background but opens the panel, and closing the panel restores
// the white background."
//
// THIS CANNOT BE CAUGHT BY RENDERING, which is why the test is a scan. The mixed style is valid CSS, valid
// React, and correct on the first render AND on the second. It only misbehaves on the third -- the one where a
// toggled longhand is CLEARED and takes its shorthand's contribution to the same property with it, dropping
// the element onto the User Agent default. A component test that mounts, clicks, and asserts would pass.
//
// SO THE ASSERTION IS ABOUT THE SOURCE, and specifically about the PAIRING: a base style carrying a shorthand
// while a conditional overlay carries one of its longhands. Either alone is fine, which is why a scan for
// `background:` on its own would be all noise -- there are twenty of them in this codebase and nineteen are
// harmless.

import { RISKY_SHORTHANDS, shorthandClashes } from "./styleShorthand";

describe("the rule catches the pairing and nothing else", () => {
  it("flags a base shorthand against an overlay longhand", () => {
    /* THE TILES TAB, exactly: `trayTile` held `background: none`, `trayTileSelected` held `backgroundColor`. */
    expect(
      shorthandClashes({ background: "none" }, { backgroundColor: "rgba(255,255,255,0.05)" }),
    ).toEqual([{ shorthand: "background", longhand: "backgroundColor" }]);
  });

  it("does NOT flag a shorthand on its own", () => {
    /* The common, harmless case. A style that sets `background` and never toggles a longhand against it is
       fine forever, and flagging it would make this rule noise -- which is how a rule gets switched off. */
    expect(shorthandClashes({ background: "none" }, { color: "#fff" })).toEqual([]);
  });

  it("does NOT flag a longhand on its own", () => {
    // Two longhands is the FIX, not the bug.
    expect(
      shorthandClashes({ backgroundColor: "transparent" }, { backgroundColor: "#fff" }),
    ).toEqual([]);
  });

  it("catches the border family too", () => {
    /* Same mechanism, different property, and the one this codebase is next likeliest to hit: selected states
       here routinely toggle `borderColor` over a base that could easily say `border`. */
    expect(shorthandClashes({ border: "1px solid #333" }, { borderColor: "#7ee0a1" })).toHaveLength(
      1,
    );
  });

  it("keeps the risky list short and actionable", () => {
    /* `font`, `grid` and `flex` are shorthands too and are never toggled against their longhands here. A list
       that flagged them would produce findings nobody can act on. */
    expect(Object.keys(RISKY_SHORTHANDS).length).toBeLessThanOrEqual(8);
    expect(RISKY_SHORTHANDS).not.toHaveProperty("font");
  });
});

describe("the sweep this fix prompted found a second one", () => {
  it("gives the train quantity option an explicit backgroundColor", () => {
    /* Design note #732. `quantityOption` held `background: "transparent"` while `quantityOptionActive` toggles
       `backgroundColor` on the SAME element -- structurally identical to the Tiles tab and never reported,
       because a segmented row is usually left on a selection rather than clicked back to nothing.
       THE VALUE OF THE SWEEP, in one test: the report found one instance and the mechanism found the other. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const panel = fs.readFileSync(
      path.join(__dirname, "..", "components", "TrainPurchasePanel.tsx"),
      "utf8",
    );
    const start = panel.indexOf("  quantityOption: {");
    const block = panel.slice(start, panel.indexOf("  },", start));
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('backgroundColor: "transparent"');
    expect(block).not.toContain('background: "');
  });
});

describe("the Tiles tab no longer mixes them", () => {
  const source = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(
      path.join(__dirname, "..", "components", "TileReference.tsx"),
      "utf8",
    );
  })();

  it("gives the tray tile an explicit backgroundColor", () => {
    /* THE FIX, asserted where it lives. Both renders now write the same property, so React's diff always has
       a value to set and never leaves the button on `buttonface`. */
    expect(source).toContain('backgroundColor: "transparent"');
  });

  it("keeps the selected state on the same property", () => {
    expect(source).toContain('trayTileSelected: { backgroundColor: "rgba(255, 255, 255, 0.05)" }');
  });

  it("no longer has a background shorthand on the tray tile", () => {
    /* Scoped to the tray-tile style block rather than the file: `detailClose` further down still uses
       `background: "none"` and is CORRECT to -- nothing ever toggles a background longhand on it, which is the
       distinction this whole note is about. A file-wide ban would be the noisy rule that gets ignored. */
    const start = source.indexOf("  trayTile: {");
    const block = source.slice(start, source.indexOf("  },", start));
    expect(start).toBeGreaterThan(-1);
    expect(block).not.toContain('background: "');
  });
});
