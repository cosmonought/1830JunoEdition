/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1206 (harness): THE FAILURES THIS DIGEST MUST NOT HAVE
// ==================================================================
//
// A digest that reports divergence when there is none is worse than no digest: it costs a debugging session
// every time, and after the second false alarm nobody reads it. So these cases are mostly about AGREEMENT --
// boards that differ in ways that are not differences, and must hash the same.
//
// THE ONE THAT WOULD HAVE BITTEN is key order. Two clients build the same board constantly by different
// routes -- one replaying a log, one draining a live action -- and `JSON.stringify` emits keys in insertion
// order, so a naive digest disagrees on identical content.

export {};

const { canonicalJson, digestOf, stateDigest } =
  require("./stateDigest") as typeof import("./stateDigest");
const { sandboxScenarioState } = require("./sandboxState") as typeof import("./sandboxState");

describe("things that are not differences", () => {
  it("ignores the order keys were written in", () => {
    /* THE CASE THE WHOLE FILE EXISTS FOR. One client builds a company from a replay and another from a live
       drain; the spread order differs and the contents do not. A digest over `JSON.stringify` reports a
       desync here on every second message. */
    const a = { alpha: 1, beta: { x: 1, y: 2 }, gamma: [1, 2] };
    const b = { gamma: [1, 2], beta: { y: 2, x: 1 }, alpha: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(digestOf(canonicalJson(a))).toBe(digestOf(canonicalJson(b)));
  });

  it("treats an explicitly undefined field as one that was never written", () => {
    /* #232: `undefined` means "this build does not say", which is exactly what a missing key means. Two
       clients on the same build reach the same board by paths that spread an optional field or omit it. */
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("normalises negative zero, the one integer JavaScript prints two ways", () => {
    expect(canonicalJson({ n: -0 })).toBe(canonicalJson({ n: 0 }));
  });
});

describe("things that ARE differences", () => {
  it("keeps null apart from absent", () => {
    /* #232 again, from the other side: `null` is a positive answer somebody recorded, and collapsing it into
       "not said" would hide the field a divergence hunt most wants to see. */
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });

  it("keeps array order, because in this game order is content", () => {
    /* `active_operating_order` IS §5a. Sorting arrays for a "nicer" canonical form would make the digest
       blind to the exact disagreement it was built to catch. */
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("keeps a numeric key apart from its string", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
  });

  it("does not let a hole in an array shift the elements after it", () => {
    /* `undefined` inside an array becomes `null`, matching `JSON.stringify`. Dropping it would renumber
       every later index and make two different boards agree. */
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
    expect(canonicalJson([1, undefined, 2])).not.toBe(canonicalJson([1, 2]));
  });
});

describe("corruption is named rather than smoothed over", () => {
  it("does not let NaN digest as a clean board", () => {
    /* `JSON.stringify` writes `null` for `NaN` and the infinities, so a corrupted figure would hash as an
       honest absence -- a board that is wrong agreeing with one that is right. */
    expect(canonicalJson({ n: NaN })).toContain("__nonfinite");
    expect(canonicalJson({ n: NaN })).not.toBe(canonicalJson({ n: null }));
    expect(canonicalJson({ n: Infinity })).not.toBe(canonicalJson({ n: NaN }));
  });
});

describe("the digest itself", () => {
  it("is sixteen hex characters", () => {
    expect(stateDigest(sandboxScenarioState("start", 0, "default"))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable across calls and changes when the board does", () => {
    const board = sandboxScenarioState("start", 0, "default");
    expect(stateDigest(board)).toBe(stateDigest(board));
    expect(stateDigest({ ...board, macro_round_number: 9 })).not.toBe(stateDigest(board));
  });

  it("notices a change buried deep in a company, not just at the top level", () => {
    /* The differences worth catching are never at the top. §5a's was a market token's column; #1183's was a
       revenue figure on one corporation. */
    const board = sandboxScenarioState("start", 0, "default");
    const moved = {
      ...board,
      public_companies: board.public_companies.map((company, at) =>
        at === 0 ? { ...company, treasury: "999" } : company,
      ),
    };
    expect(stateDigest(moved)).not.toBe(stateDigest(board));
  });

  it("uses the whole hash rather than a remainder of it", () => {
    /* #1051's lesson, observed rather than repeated. That note found the revenue die firing 29% at one face
       because `carcosaRollHits` read `spun % 10` -- FNV's low bits are dominated by the characters processed
       last, and two nearly identical short keys share them. The fault was the modulus.
       SO THE CASE IS: inputs differing ONLY at the end still separate, across both lanes. */
    const seen = new Set<string>();
    for (let n = 0; n < 200; n += 1) seen.add(digestOf(`board-state-prefix-identical-${n}`));
    expect(seen.size).toBe(200);
  });
});
