/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1204 (harness): THE SENDER, WHICH NO REPLAY CAN SEE
// ==================================================================
//
// The reducer's half is covered by `shellMessageArms` and the golden master. This half is not coverable that
// way at all: whether `App.tsx` PUTS `ability_key` on the message is a fact about a 12,000-line React file
// that no headless replay executes.
//
// SO IT IS PINNED BY SOURCE SCAN, which this project already uses for exactly this shape of rule -- #887's
// note records three of its own guards failing for reasons unrelated to the code, and the lesson it drew:
// "prefer a contiguous multi-line assertion with no number in it."
//
// WHAT IS WORTH PINNING IS THE ORDER, not the presence. `errandClaimsLay` has always been asked; #817 is the
// report from asking it the wrong way, and the fix that mattered was asking it BEFORE the dispatch so the
// answer could travel. A version that resolved it afterwards would still compile, still set the local Set,
// and still lose the fact on reload -- which is the bug this note exists to end.

export {};

const { readSource, readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const APP = "App.tsx";

describe("the lay carries the power it spends", () => {
  it("resolves the ability BEFORE dispatching, so the answer can travel", () => {
    /* THE ORDERING IS THE RULE. `spentAbility` must be computed above the `if (sandbox)` branch that sends
       the message; resolved afterwards it could only ever reach a local `Set`. */
    const source = readStripped(APP);
    const resolvedAt = source.indexOf("const spentAbility = errandClaimsLay(");
    const dispatchedAt = source.indexOf("handleSandboxLayTile(");
    expect(resolvedAt).toBeGreaterThan(-1);
    expect(dispatchedAt).toBeGreaterThan(-1);
    expect(resolvedAt).toBeLessThan(dispatchedAt);
  });

  it("sends it on both lay paths, because a room and a chain game are one rule", () => {
    /* TWO DISPATCH SITES, and #436's note says why they exist -- "three separate writes in three places".
       A field added to one of them is a rule that holds in the sandbox and not on chain, which is the shape
       of every mirror bug in this codebase. */
    const source = readStripped(APP);
    const occurrences = source.split("ability_key").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("omits the field rather than sending a null", () => {
    /* #232 AND #776 TOGETHER: absent means "this build did not say", and an ordinary lay's entry must look
       exactly like the ones written before the field existed. A `null` would be a build asserting "no power
       was used", which is a different and unearned claim. */
    const source = readStripped(APP);
    expect(source).toContain("...(abilityKey ? { ability_key: abilityKey } : {})");
    expect(source).toContain("...(spentAbility ? { ability_key: spentAbility } : {})");
    expect(source).not.toContain("ability_key: null");
  });

  it("reads spent-ness from the board, with the local Set only as a fallback", () => {
    /* THE HALF THAT CLOSES #1044's HOLE. Reading only the local `Set` is what made a reload lose a power;
       reading only the board would resurrect powers in a room whose log predates `ability_key`. The union is
       the honest reading during the changeover, and this pins that BOTH sides are consulted. */
    const source = readStripped(APP);
    const spent = source.slice(
      source.indexOf("const abilitySpent ="),
      source.indexOf("const dhPower ="),
    );
    expect(spent).toContain("used_private_abilities");
    expect(spent).toContain("usedPrivateAbilities.has(key)");
  });

  it("keeps the reason in the source rather than only in a commit message", () => {
    /* This project's own convention, and the thing that made every rule in it recoverable this week. */
    expect(readSource(APP)).toContain("DESIGN NOTE 1204");
  });
});
