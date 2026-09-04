/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1154-1158 (harness): THE CAMERA, AND A LINE THAT GUESSED
// ==================================================================
//
// Six reported items, and three of them turned out not to be what they looked like -- which is why this file
// asserts mechanisms rather than appearances.
//
//   THE LINE  said "(already at the ceiling of the chart)" about a token held still by a VARIANT'S PAYOUT
//             RULE. `projection.moves` says only that the token stayed; the reason was guessed from
//             `direction`. The app did not know why, and asserted the one reason it had words for.
//   THE SLIDE was described by two design notes and could never have run: the token was rendered inside
//             whichever cell held it, so a phase change unmounted one element and mounted another. A
//             transition needs one element whose property changes. "Add a CSS transition" was the wrong
//             prescription -- the transition was already there, on a token that never survived its own move.
//   THE TOKEN was a bare herald at 15px on a chart whose sibling had MEASURED that heralds fail below 26px
//             (#430). Not a missing feature: one object drawn two ways, the smaller one ignoring the rule.
//
// The other three are what they look like -- highlight the end cell, widen the hit area, draw the whole board
// -- and are asserted plainly.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const { PRICE_GRID } = require("../components/StockMarketRenderer") as typeof import("../components/StockMarketRenderer");
const { MIN_LOGO_TOKEN_DIAMETER_PX } = require("../components/MarketToken") as typeof import("../components/MarketToken");

const PREVIEW = readStripped("components/StockMarketPreview.tsx");
const TOKEN = readStripped("components/MarketToken.tsx");
const CHART = readStripped("components/StockMarketRenderer.tsx");
const MODAL = readStripped("components/MarketPeekModal.tsx");
const BAR = readStripped("panels/ContextualActionBar.tsx");

describe("the market move line says only what it knows", () => {
  it("reports an unchanged price without inventing a cause", () => {
    /* THE OLD SENTENCE WAS FALSE UNDER THE VOLATILE VARIANT, which is the report: a token held still by the
       size of a payout was described as being at the edge of the board. `(unchanged)` is the whole of what
       this function can observe, and it stays true under every variant and at every position. */
    expect(BAR).toContain("(unchanged)");
    expect(BAR).not.toContain("already at the ceiling of the chart");
    expect(BAR).not.toContain("already at the floor of the chart");
  });

  it("prints one price rather than an arrow between two equal ones", () => {
    /* "$90 -> $90" reads as a broken arrow rather than as a fact about a price -- the report's own diagnosis
       of why the old line needed a parenthetical to look deliberate. */
    const branch = sliceBetween(BAR, "if (!projection.moves) {", "\n  }\n");
    expect(branch).toContain("<ZonedPrice price={currentPrice} />");
    expect(branch).not.toContain("projection.price");
  });

  it("keeps the marker that describes a move that happened", () => {
    /* `(double move)` is a fact about DISTANCE, not a guess at a cause, and #998's reasoning for the wording
       is untouched. Deleting every parenthetical would have taken it too. */
    expect(BAR).toContain("(double move)");
  });

  it("drops the prop whose last reader was the deleted branch", () => {
    /* #489 took `direction` off the arrow and left it reading the chart's edge, noting "this is the one place
       `direction` is still the right thing to read". That place is gone, so the prop is: a value every caller
       computes and nothing consumes is the half of a deletion that gets left behind. */
    expect(BAR).not.toContain('direction="pay"');
    expect(BAR).not.toContain('direction="withhold"');
  });

  it("makes the whole line the target and keeps the glass as the affordance", () => {
    /* ASKED: "the magnifying glass ... is placed at the end, which is okay, but I think it might be useful to
       just have the whole 'Market Move' line hoverable or clickable." A restatement of this asked for the icon
       to be REMOVED, which the report's first clause contradicts -- and a line of text that silently responds
       to a click is a feature nobody finds. */
    expect(BAR).toContain("dividendMoveLabelOpens");
    expect(BAR).toContain("<span style={styles.dividendMove} onClick={onOpenChart}>");
    expect(BAR).toContain("styles.marketPeekButton");
  });
});

describe("one token, drawn by the rule that measured it", () => {
  it("keeps #430's threshold in one exported place", () => {
    /* The threshold is the whole content of the fix: a herald legible at 46px is a smudge at 15px, and the
       preview was drawing at 15. Exported so neither surface can hold its own copy. */
    expect(MIN_LOGO_TOKEN_DIAMETER_PX).toBe(26);
    expect(TOKEN).toContain("diameterPx >= MIN_LOGO_TOKEN_DIAMETER_PX");
    expect(TOKEN).toContain("corporationLiveryColor(companyId)");
    expect(TOKEN).toContain("bestContrastTextColor(fill)");
  });

  it("is used by both surfaces, so there is no second drawing to disagree", () => {
    expect(CHART).toContain("<MarketToken");
    expect(PREVIEW).toContain("<MarketToken");
    /* AND THE PREVIEW NO LONGER REACHES FOR THE HERALD DIRECTLY, which is what let it bypass the threshold. */
    expect(PREVIEW).not.toContain("CorporateLogo");
  });

  it("leaves placement at the call site", () => {
    /* THE CLAIM IS THE SEAM, NOT THE EXAMPLE. This first cited the chart's scatter vector as the placement
       living outside the shared token -- and #1159 then retired the scatter for a stack, so the assertion
       named a thing that no longer exists while the property it was standing for was untouched. Re-anchored
       on what placement IS now: both surfaces position absolutely, from their own arithmetic, and neither
       puts a coordinate inside `MarketToken`. */
    expect(TOKEN).not.toContain("position: \"absolute\"");
    expect(TOKEN).not.toContain("zIndex");
    expect(CHART).toContain("stackOffset(index, occupantCount, tokenDiameterPx)");
    expect(PREVIEW).toContain("stackOffset(index, others.length, TOKEN)");
  });
});

describe("the camera shows the whole board", () => {
  it("draws every cell the chart has", () => {
    /* THE PROPERTY THAT REPLACED `previewCentre`'s FIVE CASES. Those asked whether the right five columns were
       chosen; there is no choice to make now, so the claim is simply that the extent comes from the grid. */
    expect(PREVIEW).toContain("BOARD_X = {");
    expect(PREVIEW).toContain("BOARD_Y = {");
    expect(PREVIEW).toContain("Math.min(...PRICE_GRID.map((cell) => cell.x))");
    expect(PREVIEW).not.toContain("const WINDOW");
    expect(PREVIEW).not.toContain("previewCentre");
  });

  it("is wide enough for the board it now draws", () => {
    /* 19 columns at 420px is 22px each -- narrower than a token. The dialog grew so the cells did not have to
       vanish; the arithmetic is the reason and is asserted rather than the number alone. */
    const columns = Math.max(...PRICE_GRID.map((c) => c.x)) - Math.min(...PRICE_GRID.map((c) => c.x)) + 1;
    expect(columns).toBe(19);
    expect(MODAL).toContain('maxWidth: "min(96vw, 900px)"');
    expect(MODAL).toContain("overflow:");
  });

  it("reads the board top row first, so it is not upside down", () => {
    /* `y` counts UP from the bottom in `REAL_MARKET_ROWS`; a chart drawn in ascending y would put the ceiling
       at the floor. */
    expect(PREVIEW).toContain("for (let y = BOARD_Y.max; y >= BOARD_Y.min; y -= 1)");
  });
});

describe("same-cell tokens stack in the order the game plays them", () => {
  it("orders by the cursor's own key rather than a second opinion", () => {
    /* #646 STAMPS THE ARRIVAL and #647 sorts the operating order by price, then rightmost column, then
       arrival ascending. The pile must read from the same key or the picture and the turn order diverge --
       #891, in the one place a player would trust the picture. */
    const STACK = readStripped("utils/marketStack.ts");
    expect(STACK).toContain("a.enteredAt");
    expect(STACK).toContain("left - right");
    /* A chain that sends no ordinal still gets a stable pile: unrecorded sorts last (#647's own choice) and
       `company_id` breaks the remaining tie, so every client draws the same stack. */
    expect(STACK).toContain("Infinity");
    expect(STACK).toContain("a.company_id - b.company_id");
  });

  it("carries the ordinal through to the view", () => {
    /* THE FIELD EXISTED AND STOPPED AT THE VIEW BOUNDARY, which is why the board could only scatter. */
    expect(readStripped("utils/sandboxState.ts")).toContain("enteredAt: mark.enteredAt");
    expect(CHART).toContain("enteredAt?: number;");
  });

  it("puts the earliest arrival on top of the pile", () => {
    /* "New entrants take the bottom of the stack -- play then happens top-to-bottom." So the z-order runs
       opposite to the paint order: the token that operates first is the one the eye reaches first. */
    expect(CHART).toContain("zIndex: 10 + (occupantCount - index)");
    expect(PREVIEW).toContain("zIndex: 10 + (others.length - index)");
  });

  it("lifts one token rather than scattering the cluster", () => {
    /* #452 SHRANK AND SCATTERED THE WHOLE PILE so the price underneath could be read -- the right answer for
       tokens that were already spread. A stack asks a different question: which disc is which. The hover is
       per token now, and it lifts. */
    expect(CHART).toContain(".market-token-cluster .market-token:hover");
    expect(CHART).toContain("scale(1.18)");
    expect(CHART).not.toContain("--scatter-x");
    /* Keyboard readers get the same lift, which a cluster-level hover could never give them. */
    expect(CHART).toContain(":focus-visible");
  });
});

describe("the token slides, and the end cell is always marked", () => {
  it("lives outside the cells, which is what makes a transition possible at all", () => {
    /* THE FAULT, STATED AS THE FIX. Rendered per cell, the token was unmounted and remounted on every phase
       change -- two elements, so nothing to transition. One element, moved by transform. */
    expect(PREVIEW).toContain("transform: `translate(");
    expect(PREVIEW).toContain('transition: "transform 420ms');
    /* The old shape: a `holdsToken` test inside the cell loop, deciding whether THIS cell draws the token. */
    expect(PREVIEW).not.toContain("holdsToken");
  });

  it("computes the offset instead of measuring it", () => {
    /* Arithmetic on the cell size cannot disagree with the grid that placed the cells, and needs no layout
       read -- #1144's lesson about measured pixels, applied before it could bite. */
    expect(PREVIEW).toContain("(CELL + GAP)");
    expect(PREVIEW).not.toContain("getBoundingClientRect");
  });

  it("marks where the token ends even when it does not move", () => {
    /* REPORTED: "it should always highlight wherever it ends." The highlight was gated on a projection
       existing, so the case with no words -- "(unchanged)" -- was also the case with no mark. */
    expect(PREVIEW).toContain("const endNode = projectedNode ?? startNode;");
    expect(PREVIEW).toContain("const isLanding = x === endNode.x && y === endNode.y;");
  });

  it("still cuts rather than animates the return", () => {
    /* #1142's claim, which was written for a token that could not animate in either direction and is only now
       load-bearing: a withhold preview must never show the price rising on the way back. */
    expect(PREVIEW).toContain("phase.animate ? {} : styles.movingTokenInstant");
    expect(PREVIEW).toContain('movingTokenInstant: { transition: "none" }');
  });
});
