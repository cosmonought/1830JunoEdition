/** @jest-environment node */
//
// Every ref that mirrors a state atom is reset with it. Source-level; no React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 767 (harness): A REF RESET IS HALF A RESET
// ==================================================================
//
// REPORTED: "in OR2.1, when a corporation laid its second track, all of the laid tiles on the board
// disappeared."
//
// `rebuildSandbox` RESETS EVERY ATOM AS A PAIR and the tile grid was the exception. #757 gave the grid a ref
// -- correctly, because React state is stale inside a replay burst -- and did not add it to the reset. So a
// rebuild reset the STATE and left the REF pointing at the board from before it, and the two writers then
// fought: the replay lays onto the stale full board through the ref, React commits the reset render, the
// mirroring effect writes the EMPTY grid back into the ref, and the next lay builds from empty. Every tile
// laid before it disappears. It takes a SECOND lay because the first is what leaves the two disagreeing.
//
// THIS IS THE THIRD BUG FROM ONE CHANGE. #762 (a memo reading a ref from its dead zone), #766 (a predicate
// reading a ref between two writes) and this one all come from #757 adding a ref to the hottest path in the
// app. A ref is a second copy of a value, and every second copy needs the same three things: one writer that
// wins, a reset that covers it, and a reader that knows which it is getting.
//
// SO THE CHECK IS A SWEEP RATHER THAN A CASE. Pinning "the map grid is reset" would fix today and say nothing
// about the next ref somebody adds. What is asserted is the PAIRING: any ref reset in the rebuild has its
// setter beside it, and any mirrored state reset there has its ref beside it.

import {
  expectOrder,
  readShell,
  readStripped,
  shellSourcePaths,
  sliceBetween,
  SHELL_ROOT_FILE,
  SHELL_ROOT_WITNESS,
} from "./sourceScan";

/** #490a: the notes name these refs in prose and must keep doing so -- so every read here is comment-stripped.
 *
 *  APP-TEST-0A: THE PAIRING IS A FACT ABOUT ONE COMPONENT, so the sweep reads each shell file (`App.tsx` and
 *  every extracted `shell/**` module) ON ITS OWN, never the concatenation: a ref and a setter are "a pair" when
 *  they are declared and set in the same file, and the rebuild's body is bounded inside the file that holds it. */
const SHELL_FILES = shellSourcePaths().map((rel) => ({ rel, code: readStripped(rel) }));

/** Whole-shell reads, for the presence assertions that do not depend on which file the code lives in. */
const SHELL = readShell();

/** The file whose component declares `rebuildSandbox` -- exactly one. */
const REBUILD_HOME = (() => {
  const homes = SHELL_FILES.filter((file) => file.code.includes("const rebuildSandbox = useCallback("));
  if (homes.length !== 1) {
    throw new Error(`rebuildSandbox must be declared in exactly one shell file, found: ${homes.map((f) => f.rel).join(", ") || "none"}`);
  }
  return homes[0];
})();

/** The body of `rebuildSandbox`, bounded by the next top-level callback of its own file. */
const REBUILD = sliceBetween(REBUILD_HOME.code, "const rebuildSandbox = useCallback(", "\n  const ");

/** Refs that exist purely to mirror a piece of state for synchronous reads. */
const MIRRORED: ReadonlyArray<{ ref: string; setter: string }> = [
  { ref: "mapGridRef", setter: "setMapGrid" },
  { ref: "sandboxMarketRef", setter: "setSandboxMarket" },
  // #1340: `settledPrivatePricesRef` / `setSettledPrivatePrices` are gone -- the price is on the board.
  /* #887: the sweep below found this one before any player did, and it is named here as well so the pair is
     asserted by name rather than only by discovery. #850's ref made a rebuild leave a discarded token
     placement in the ref while the state said none -- and `handleHexClick` refuses to open the tile picker
     on a hex with one, so every click was swallowed until React caught up. */
  { ref: "pendingTokenRef", setter: "setPendingToken" },
];

describe("the rebuild resets refs and state together", () => {
  it.each(MIRRORED)("resets $ref beside $setter", ({ ref, setter }) => {
    /* THE PAIRING, per atom. A rebuild that touches one and not the other leaves two sources of truth
       disagreeing, and the replay that immediately follows reads whichever one it happens to reach first. */
    expect(REBUILD).toContain(`${ref}.current =`);
    expect(REBUILD).toContain(`${setter}(`);
  });

  it("resets the map grid ref, which is the one that was missing", () => {
    expect(REBUILD).toContain("mapGridRef.current = MOCK_MAP_GRID;");
    expect(REBUILD).toContain("setMapGrid(MOCK_MAP_GRID);");
  });

  it("writes the ref BEFORE the setter", () => {
    /* Order matters here and nowhere else: `setMapGrid` is asynchronous, so the synchronous ref write is what
       the replay actually reads. Putting the setter first would leave a window with the old board still in
       the ref -- which is the window this bug lived in. */
    expect(REBUILD).toContain("mapGridRef.current = MOCK_MAP_GRID;");
    expectOrder(REBUILD, "mapGridRef.current = MOCK_MAP_GRID;", "setMapGrid(MOCK_MAP_GRID);");
  });

  it("writes the pending-token ref before its setter too (#887)", () => {
    /* SAME ORDER, SAME REASON. The reader here is a click handler rather than a replay, but the shape is
       identical: the ref is what the synchronous reader sees, so a setter-first reset leaves a window in
       which the board still believes a token is staged. Asserted separately from the sweep because the
       sweep can only see THAT both halves are present, not in which order. */
    expect(REBUILD).toContain("pendingTokenRef.current = null;");
    expectOrder(REBUILD, "pendingTokenRef.current = null;", "setPendingToken(null);");
  });
});

describe("no mirrored ref is left out of the rebuild", () => {
  it("finds every `Ref` that has a matching state setter", () => {
    /* THE SWEEP, and the reason this file is not three hardcoded assertions. It discovers refs whose names
       pair with a `setX` in the same component, then insists the rebuild resets both halves. A ref added next
       year is covered without anybody remembering this note. */
    const refs = SHELL_FILES.flatMap((file) =>
      Array.from(file.code.matchAll(/const (\w+Ref) = useRef/g)).map((m) => ({ ref: m[1], code: file.code })),
    );
    const missing: string[] = [];

    for (const { ref, code } of refs) {
      const base = ref.replace(/Ref$/, "");
      const setter = `set${base.charAt(0).toUpperCase()}${base.slice(1)}`;
      // Only refs that MIRROR a state atom (of their own file's component) are in scope; the rest are scratch
      // and need no reset.
      if (!code.includes(`${setter}(`)) continue;
      // And only those the rebuild already touches -- an atom the rebuild deliberately leaves alone is a
      // decision, not an omission, and `handleLeaveSandboxRoom` records one of those about the board.
      if (!REBUILD.includes(`${setter}(`)) continue;
      if (!REBUILD.includes(`${ref}.current`)) missing.push(`${ref} (state reset via ${setter})`);
    }

    expect(missing).toEqual([]);
  });

  it("actually found some refs, so the sweep is not vacuous", () => {
    /* And it read the real shell: the composition root is among the analysed files, and it is the root. */
    expect(SHELL_FILES.map((file) => file.rel)).toContain(SHELL_ROOT_FILE);
    expect(SHELL_FILES.find((file) => file.rel === SHELL_ROOT_FILE)?.code).toContain(SHELL_ROOT_WITNESS);
    const refNames = SHELL_FILES.flatMap((file) => Array.from(file.code.matchAll(/const (\w+Ref) = useRef/g)).map((m) => m[1]));
    expect(refNames.length).toBeGreaterThan(5);
    expect(refNames).toContain("mapGridRef");
  });
});

describe("the grid still has exactly one synchronous writer per dispatch", () => {
  it("writes the ref and the state together on a lay", () => {
    /* #757's arrangement, unchanged and now consistent with the rebuild: the dispatch writes the ref first so
       the next action in a replay burst sees the tile, then the setter so React repaints. */
    expect(SHELL).toContain("mapGridRef.current = nextGrid;");
    expect(SHELL).toContain("setMapGrid(nextGrid);");
  });

  it("still guards on identity", () => {
    // A refused lay returns the same grid; repainting for it would be a canvas flash for nothing.
    expect(SHELL).toContain("if (nextGrid !== mapGridRef.current) {");
  });
});
