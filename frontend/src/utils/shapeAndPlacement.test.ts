/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1150-1152 (harness): THREE THINGS IN THE WRONG PLACE
// ==================================================================
//
// The batch reads as three unrelated layout complaints and each turned out to be a thing sitting where nobody
// had ever compared it against its neighbour.
//
//   THE TABS    inset their buttons 16px beside a panel inset 20px. Neither number was wrong on its own and
//               nobody had ever put them side by side.
//   THE RADII   were TWELVE values doing the work of one -- 3,4,5,6,7,8,9,10,12,14px, scattered INSIDE single
//               components. Reported as "every element uses rounded edges", which is what too many
//               indistinguishable values look like from the outside.
//   THE PANEL   opened after a whole tray grid, so a tile in the top row got its answer four rows away.
//
// AND ONE OF THEM WAS ASKED FOR AS SOMETHING ELSE. The shape request was "square the player elements"; the
// count is what turned that into a scale, because the distinction it asked for is already carried loudly by
// seat colour and livery, while the actual complaint -- nothing is distinguishable from anything -- had a
// cause nobody had counted. RULED after that was put: "everything looking the same is probably the main
// issue."

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const { RADIUS } = require("../styles/typography") as typeof import("../styles/typography");

const STYLES = readStripped("styles/appStyles.ts");
const TILES = readStripped("components/TileReference.tsx");

describe("the tab strip and its panel agree about their left edge", () => {
  it("takes the panel's inset rather than keeping its own", () => {
    /* FOUR PIXELS, FOUND BY READING THE TWO NUMBERS TOGETHER rather than by eye -- which is the only way this
       one was ever going to be found, because four pixels gets attributed to anything but itself. 20 is the
       number with a reason (#1118: it "keeps the panel's border and radius visible"); 16 was habit. */
    expect(sliceBetween(STYLES, "mainTabBar: {", "\n  },")).toContain('padding: "6px 20px"');
    expect(sliceBetween(STYLES, "canvasPane: {", "\n  },")).toContain('padding: "0 20px 20px"');
  });
});

describe("the radius scale", () => {
  it("has three steps far enough apart to be told apart", () => {
    /* THE FAILURE BEING FIXED IS NEIGHBOURS THAT DIFFER BY A PIXEL. A scale whose steps are 8 and 9 would
       reproduce it exactly, so the separation is the property, not the specific values -- asserted as a
       minimum gap rather than as three literals. */
    const steps = [RADIUS.control, RADIUS.card, RADIUS.layer].map((v) => parseInt(v, 10));
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i] - steps[i - 1]).toBeGreaterThanOrEqual(5);
    }
  });

  it("keeps the pill and the circle off the scale", () => {
    /* NOT STEPS. A pill is a pill at any size, and folding shapes into a graduated scale would be the same
       category error this note is fixing, one level up. */
    expect(RADIUS.pill).toBe("999px");
    expect(RADIUS.circle).toBe("50%");
  });

  it("leaves no hand-written radius behind", () => {
    /* THE WHOLE VALUE IS IN THERE BEING NO EXCEPTIONS. One surviving literal is one surface that drifts again,
       and the twelve values got there one exception at a time. Checked across every source file rather than a
       sample, since a sample is how the first eleven were missed.
       COMPOUND VALUES ARE INCLUDED -- the four-corner forms are built from the tokens too, so a `"0 10px 10px
       10px"` cannot quietly reintroduce a step. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const root = path.join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
          for (const line of fs.readFileSync(full, "utf8").split("\n")) {
            if (/borderRadius: *"/.test(line)) offenders.push(`${entry.name}: ${line.trim()}`);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("puts the floating surfaces on the layer step", () => {
    /* THE HAND PASS AFTER THE SWEEP. The conversion mapped each site from the value it already had, which
       preserves the original sense of scale and gets the role wrong wherever the two disagreed -- a toast at
       zIndex 4000 and a modal sheet with a drop shadow had both been authored at the card step. */
    for (const file of [
      "components/ActionToast.tsx",
      "components/AudioControlPopover.tsx",
      "components/EmergencyTrainPurchaseModal.tsx",
      "components/GameOverModal.tsx",
      "components/AutoPassModal.tsx",
    ]) {
      expect([file, readStripped(file).includes("borderRadius: RADIUS.layer")]).toEqual([file, true]);
    }
  });
});

describe("the tile upgrade panel opens on the row that was clicked", () => {
  it("places itself after the last tile of the selected row", () => {
    /* #693 PUT IT AFTER THE WHOLE GRID and called that "the answer appears under the question", which was true
       of the TRAY and false of the TILE -- eighteen tiles over four rows means the top row's answer is four
       rows down. The claim is now true at the granularity the question is asked at. */
    expect(TILES).toContain("{index === panelAfterIndex && selectedTileId !== null && (");
    expect(TILES).toContain("const panelAfterIndex = rowEndFor(selectedIndex, columns, ids.length);");
    expect(TILES).toContain('detailRow: { gridColumn: "1 / -1" }');
  });

  it("reads the column count from the browser rather than assuming one", () => {
    /* THE GRID IS `auto-fill`, so only the browser knows how many columns it resolved to. A hard-coded count
       would open the panel mid-row at every width but one. */
    const hook = sliceBetween(TILES, "function useGridColumnCount(", "\n}\n");
    expect(hook).toContain("gridTemplateColumns");
    expect(hook).toContain("new ResizeObserver(measure)");
    expect(hook).toContain("observer.disconnect()");
  });

  it("counts tracks and never reads a pixel off them", () => {
    /* #1144's LESSON, ONE FILE OVER: a measured pixel means something different inside the chrome's zoom.
       Counting entries in the resolved track list is the one thing about it that does not care what the sizes
       are, so this stays correct at any scale -- and `1 / -1` spans the row without the count at all. */
    const hook = sliceBetween(TILES, "function useGridColumnCount(", "\n}\n");
    expect(hook).toContain('tracks.split(" ").length');
    expect(hook).not.toContain("getBoundingClientRect");
    expect(hook).not.toContain("offsetWidth");
  });

  it("still renders a panel in one tray only", () => {
    /* #693's own property, preserved through the restructure: the selection is a single value, and a tray that
       does not hold it gets `indexOf` -1, which `rowEndFor` answers with `null`. */
    const helper = sliceBetween(TILES, "function rowEndFor(", "\n}\n");
    expect(helper).toContain("if (selectedIndex < 0) return null;");
    expect(TILES).toContain("const selectedIndex = selectedTileId === null ? -1 : ids.indexOf(selectedTileId);");
  });

  it("did not become the board's ring", () => {
    /* ASKED FOR AS ONE and deliberately not built as one: on the map that ring is a CHOOSER -- pick, rotate,
       confirm a lay -- and there is nothing to lay on a reference tab. A control that borrows the chooser's
       appearance but cannot choose teaches a player to expect a placement. */
    expect(TILES).not.toContain("RadialTileSelector");
    expect(TILES).not.toContain("position: \"fixed\"");
  });
});
