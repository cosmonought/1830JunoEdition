/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1088 (harness): THE SIGN ON THE CHIP, EVERYWHERE THERE IS A CHIP
// ==================================================================
//
// RULED: "replace the standard train icon with this image specifically for the Stage 2 ghost train ... Make
// sure this applies everywhere train chips are displayed (Action Bar, Game Ledger, Corporation subpanel,
// etc) ... constrained to the exact dimensions of the standard train icon ... add an aria-label or alt."
//
// "EVERYWHERE" IS THE HALF WITH TEETH, and it is why most of this file counts call sites rather than reading
// the component. `TrainChips` renders on five surfaces and each is wired by hand; a prop added to the
// component and passed at four of the five is a feature that works until a player opens the fifth. #1004's
// batch had the same shape and needed a task of its own ("Pass reprieved to all four TrainChips call sites").
//
// AND THE WIRING FOUND A BUG THAT WAS ALREADY THERE. `CapacityPill` has taken a `ghosts` prop since #1046 --
// the gift occupies no limit slot -- and NEITHER of its two call sites passed it, so the pill counted the
// ghost while the purchase gate did not. The pill read "3/2" beside a Buy button that considered the purchase
// legal. That is #891's shape, and it is fixed here because it is the same two files and the same omission.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const { YELLOW_SIGN_IMAGE } =
  require("../components/TrainBadges") as typeof import("../components/TrainBadges");

const BADGES = readStripped("components/TrainBadges.tsx");

/** Every `<TrainChips …/>` or `<CapacityPill …/>` in a file, as its own text. */
function callSites(relative: string, tag: "TrainChips" | "CapacityPill"): string[] {
  const source = readStripped(relative);
  const out: string[] = [];
  let at = source.indexOf(`<${tag}`);
  while (at !== -1) {
    const end = source.indexOf("/>", at);
    if (end === -1) break;
    out.push(source.slice(at, end));
    at = source.indexOf(`<${tag}`, end);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The swap                                                           */
/* ------------------------------------------------------------------ */

describe("a ghost train wears the sign instead of a locomotive", () => {
  it("branches on the mark rather than on the model", () => {
    /* THE FLAG IS `ghost_trains`, a list of MODELS, so the chip cannot tell from `"5-train"` alone that it is
       looking at a gift -- the mark has to arrive as a prop. Asserted as the branch, because a version that
       matched on the tier would work in every game where the corporation owns exactly one 5. */
    expect(BADGES).toContain("const ghostAt = ghostPool.indexOf(model);");
    expect(BADGES).toContain("const isGhost = ghostAt >= 0;");
    expect(BADGES).toContain("{isGhost ? (");
  });

  it("consumes the pool as it matches, like the reprieve beside it", () => {
    /* A CORPORATION THAT ALREADY OWNED A 5 AND IS THEN GIFTED ONE holds two identical models and must show
       one sign and one locomotive. `.includes` would mark both -- the off-by-one #1004 wrote its own pool to
       avoid, and the one `trimToTrainLimit` records. */
    expect(BADGES).toContain("const ghostPool = [...(ghosts ?? [])];");
    expect(BADGES).toContain("ghostPool.splice(ghostAt, 1);");
    expect(BADGES).not.toContain("ghosts?.includes(model)");
    // And the two pools are separate objects: one list draining into the other would mark the wrong chips.
    expect(BADGES).toContain("const reprievedPool = [...(reprieved ?? [])];");
  });

  it("keeps the locomotive for every other train", () => {
    /* THE CONTROL. A swap that replaced the glyph unconditionally would satisfy every assertion above and
       turn the whole fleet into yellow signs. */
    const chip = sliceBetween(BADGES, "{isGhost ? (", "{model}");
    expect(chip).toContain("<TrainGlyph");
    expect(chip).toContain("tier={tier ?? model}");
    expect(chip.length).toBeLessThan(1200);
  });

  it("names a file that is actually on disk", () => {
    /* #1040's LESSON, applied to a picture: an `<img>` whose `src` 404s renders as nothing or as a broken
       glyph depending on the browser, and neither throws. A typo here would cost the icon in one game state
       nobody reaches often, and nothing would say so. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    expect(YELLOW_SIGN_IMAGE).toBe("/images/yellow-sign.png");
    expect(
      fs.existsSync(path.join(__dirname, "..", "..", "public", YELLOW_SIGN_IMAGE.slice(1))),
    ).toBe(true);
  });

  it("references it by public path rather than importing it", () => {
    /* `audio.ts` #1009's RULE: a bundled asset gets a content hash in its filename, so the path is the
       contract. An `import` here would also make this module un-loadable by the node-environment suites. */
    expect(BADGES).toContain('export const YELLOW_SIGN_IMAGE = "/images/yellow-sign.png";');
    expect(BADGES).not.toContain('from "../../public/images/yellow-sign.png"');
    expect(BADGES).not.toContain('require("../../public/images');
  });
});

describe("the image cannot break the chip it sits in", () => {
  const image = () => sliceBetween(BADGES, "src={YELLOW_SIGN_IMAGE}", "/>");

  it("takes the glyph's height, from the same expression", () => {
    /* RULED: "constrained to the exact dimensions of the standard train icon". THE SAME EXPRESSION, not the
       same number typed twice -- `compact ? 9 : 10` is what `TrainGlyph` is given four lines below, so the
       two cannot drift the way #1042's two alphas did. */
    expect(image()).toContain("height: compact ? 9 : 10");
    expect(BADGES).toContain("height={compact ? 9 : 10}");
    expect(BADGES.split("compact ? 9 : 10").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("lets the width follow the aspect rather than stretching", () => {
    /* THE SIGN IS 456x547 -- TALLER THAN WIDE -- against a locomotive that is 13x12. Forcing a width would
       squash it; `auto` plus `contain` lets it sit at about 8px against the glyph's 11, which is narrower and
       therefore cannot overflow the chip. */
    expect(image()).toContain('width: "auto"');
    expect(image()).toContain('objectFit: "contain"');
    expect(image()).toContain('maxHeight: "100%"');
  });

  it("sits in the flex row exactly as the glyph does", () => {
    /* `TrainGlyph`'s OWN ROOT carries `flex: "none"` and `display: "block"`. Without them the image is an
       inline element with a baseline gap, which would shift the number beside it by a pixel on ghost chips
       only -- the sort of difference that reads as a rendering bug rather than as a missing style. */
    expect(image()).toContain('flex: "none"');
    expect(image()).toContain('display: "block"');
  });

  it("says what it is to a screen reader", () => {
    /* `alt` RATHER THAN `aria-hidden`, which is the opposite of what `TrainGlyph` does -- and the difference
       is the point. The locomotive is decoration, because the model number beside it says everything; the
       sign is the ONLY thing on the chip that says this train is a ghost, so a reader that skipped it would
       hear an ordinary 5-train. */
    expect(image()).toContain('alt="Carcosa ghost train"');
    expect(image()).toContain('aria-label="Yellow Sign"');
    expect(image()).not.toContain('aria-hidden="true"');
    // The locomotive stays decorative, which is what makes the asymmetry deliberate rather than an oversight.
    expect(readStripped("components/TrainGlyph.tsx")).toContain('aria-hidden="true"');
  });

  it("tells a hovering player what the unfamiliar icon means", () => {
    /* AN ICON NOBODY HAS SEEN BEFORE needs a sentence more than a rust countdown does -- and a ghost is never
       in a rust window, so replacing the tooltip costs nothing. */
    expect(BADGES).toContain("Yellow Sign ghost train");
    expect(BADGES).toContain("Occupies no train-limit slot");
  });
});

/* ------------------------------------------------------------------ */
/* Everywhere                                                         */
/* ------------------------------------------------------------------ */

describe("every surface that shows a fleet passes the mark", () => {
  /* Design note #1089 REPOINTED THE CHIPS at `carcosan_trains`. The prop is still called `ghosts` -- what it
     means to `TrainChips` is unchanged, "these models are the Carcosa train" -- but the FIELD moved, because
     `ghost_trains` is the train-limit exemption and expires a whole OR set earlier than the gold trim. A chip
     reading the old field would have lost its sign one round after the gift. */
  const FLEET_SITES: [string, "TrainChips" | "CapacityPill", string][] = [
    ["panels/ContextualActionBar.tsx", "TrainChips", "activeCorporation.carcosanTrains"],
    ["components/FinancialLedger.tsx", "TrainChips", "company.carcosan_trains"],
    ["components/StockRoundPanel.tsx", "TrainChips", "company.carcosan_trains"],
    ["components/ContextualSubPanel.tsx", "TrainChips", "company.carcosan_trains"],
  ];

  it("wires the chips on all four", () => {
    /* THE HALF THAT ACTUALLY FAILS. The component is one file; the wiring is four, and a feature passed at
       three of them works everywhere the author happened to look. */
    for (const [file, tag, expression] of FLEET_SITES) {
      const withFleet = callSites(file, tag).filter((site) => !site.includes("trains={[row.tier]}"));
      expect(withFleet.length).toBeGreaterThan(0);
      for (const site of withFleet) expect(site).toContain(`ghosts={${expression}}`);
    }
  });

  it("leaves the depot's tier row alone", () => {
    /* THE ONE `TrainChips` THAT MUST NOT TAKE IT. `FinancialLedger`'s depot table renders one chip per TIER
       with `trains={[row.tier]}` -- there is no corporation, so there is no fleet and no ghost. Asserted so
       that "wire every call site" is not read next time as "wire every call site". */
    const depot = callSites("components/FinancialLedger.tsx", "TrainChips").filter((site) =>
      site.includes("trains={[row.tier]}"),
    );
    expect(depot.length).toBe(1);
    expect(depot[0]).not.toContain("ghosts=");
  });

  it("finds no fleet chip anywhere that was missed", () => {
    /* THE SWEEP, rather than a list I remembered. Any `TrainChips` in the tree that takes a `reprieved` must
       also take a `ghosts` -- the two marks travel together, and a site with one but not the other is
       exactly the omission this batch found on `CapacityPill`. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const root = path.join(__dirname, "..");
    const found: string[] = [];
    (function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name)) {
          const relative = path.relative(root, full).split(path.sep).join("/");
          for (const tag of ["TrainChips", "CapacityPill"] as const) {
            for (const site of callSites(relative, tag)) {
              if (site.includes("reprieved=") && !site.includes("ghosts=")) {
                found.push(`${relative} <${tag}>`);
              }
            }
          }
        }
      }
    })(root);
    expect(found).toEqual([]);
  });
});

describe("the capacity pill stops counting the gift", () => {
  it("passes ghosts at both of its call sites", () => {
    /* #1046 GAVE IT THE PROP AND NOTHING GAVE IT THE VALUE, so `countableTrainCount` counted the ghost and
       the pill read one over -- against a purchase gate that exempts it correctly. A pill saying "3/2" beside
       a Buy button that permits the buy is the disagreement #891 names. */
    for (const file of ["components/ContextualSubPanel.tsx", "components/FinancialLedger.tsx"]) {
      const pills = callSites(file, "CapacityPill");
      expect(pills.length).toBeGreaterThan(0);
      /* AND THE PILL KEEPS `ghost_trains`, which is the half of the split easiest to undo: the pill counts
         LIMIT SLOTS and the exemption is what it wants, while the chip draws the SIGN and wants the
         identity. One word apart, in the same file, meaning opposite things. */
      for (const pill of pills) expect(pill).toContain("ghosts={company.ghost_trains}");
    }
  });

  it("was already asking the right question, and only the answer was missing", () => {
    /* WORTH PINNING SEPARATELY, because it says where the bug was NOT: the prop, the helper and the note were
       all correct since #1046. Two call sites were the whole of it. */
    expect(BADGES).toContain("countableTrainCount(trains, reprieved, ghosts)");
    expect(BADGES).toContain("ghosts?: readonly string[] | null;");
  });

  it("agrees with the gate that already exempts it", () => {
    /* THE TWO SURFACES, READ TOGETHER. Both call the same helper with the same three arguments, which is what
       makes them one answer rather than two that happen to match today. */
    expect(readStripped("utils/trainPurchaseGate.ts"))
      .toContain("countableTrainCount(owned, company.pending_rust_trains, company.ghost_trains)");
    expect(readStripped("components/TrainPurchasePanel.tsx"))
      .toContain("countableTrainCount(buyer?.owned_trains, buyer?.pending_rust_trains, buyer?.ghost_trains)");
  });
});
