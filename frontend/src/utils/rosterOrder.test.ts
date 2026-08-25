/** @jest-environment node */

// No runtime imports: the comparator is reproduced here and the rest is source text. `export {}` makes
// this a module for `--isolatedModules`. Third time this session; Jest never objects, only `tsc` does.
export {};
//
// The corporation card's shareholder order. No React.
//
// ==================================================================
//  DESIGN NOTE 790 (harness): A ROW THAT MOVED WHEN NOTHING HAD
// ==================================================================
//
// REPORTED: "when players become tied for control of a corporation (e.g., P1 holds 30%, P2 holds 20% and buys
// a 10% share), the ordering on the corporation card switches president P1 with P2. I think the president of
// the corporation should always appear first, even if they're tied."
//
// THE SUPERSEDED NOTE HAD A REAL POINT AND THE WRONG CARRIER. It argued that "seeing them sitting second on
// an equal stake is precisely the situation a player needs to notice" -- and a tie IS worth noticing, because
// somebody is one certificate from the presidency. But row order in a table sorted by stake means "who holds
// more"; on a tie it means nothing, so moving the row did not say "these two are level", it said "the
// presidency changed hands". In 1830 it had not: a challenger must EXCEED the incumbent, not equal them.
//
// SO THE CARD WAS ANIMATING A TRANSFER THE RULES HAD NOT MADE, which is the same family as every narration
// bug this project has found -- a surface asserting something the authority never did.
//
// THE COMPARATOR IS TESTED AS A COMPARATOR, not through the panel: the sort is the whole change, it is pure,
// and a jsdom-free test of it can cover the tie cases exhaustively in a way a rendered fixture cannot.

/** The panel's comparator, reproduced exactly. Kept in step by the source scan at the bottom, which is the
 *  weak half -- and is why every behavioural case below runs against this rather than against prose. */
const order = (president: string | null) => (a: Holding, b: Holding) => {
  const presidency = Number(president === b.player) - Number(president === a.player);
  return presidency !== 0 ? presidency : b.percentage - a.percentage;
};

interface Holding {
  player: string;
  percentage: number;
}

const sorted = (president: string | null, holdings: Holding[]) =>
  [...holdings].sort(order(president)).map((h) => h.player);

describe("the president is first whatever the stakes say", () => {
  it("keeps the president above an equal holding", () => {
    /* THE REPORT. P1 30%, P2 buys to 30%. The presidency does not move on a tie, so neither does the row. */
    expect(sorted("p1", [{ player: "p1", percentage: 30 }, { player: "p2", percentage: 30 }])).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("keeps them first when the input arrives the other way round", () => {
    /* The same board, with `player_holdings` in the opposite order -- because the reported symptom was the
       rows SWAPPING, which means the old comparator was leaving the input order to decide. */
    expect(sorted("p1", [{ player: "p2", percentage: 30 }, { player: "p1", percentage: 30 }])).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("keeps them first even when genuinely out-held", () => {
    /* NOT THE REPORTED CASE, and deliberately included: 1830 transfers the presidency when a rival EXCEEDS
       the incumbent, but not instantly -- there is a window where the card must show a president holding
       less than somebody else. First row means "President", and it has to keep meaning that. */
    expect(sorted("p1", [{ player: "p1", percentage: 20 }, { player: "p2", percentage: 50 }])).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("sorts the rest by stake, largest first", () => {
    // THE HALF THAT DID NOT CHANGE.
    expect(
      sorted("p1", [
        { player: "p3", percentage: 10 },
        { player: "p1", percentage: 20 },
        { player: "p2", percentage: 40 },
      ]),
    ).toEqual(["p1", "p2", "p3"]);
  });

  it("sorts normally when there is no president", () => {
    /* An unparred corporation has none. `null === player` is false for everybody, so both terms are 0 and the
       comparator falls through to stake -- no special case needed, which is why there is not one. */
    expect(
      sorted(null, [
        { player: "p1", percentage: 10 },
        { player: "p2", percentage: 30 },
      ]),
    ).toEqual(["p2", "p1"]);
  });

  it("sorts normally when the president holds nothing on record", () => {
    /* `player_holdings` omits anyone at 0%, so a president can be absent from the list entirely. The
       comparator must not care. */
    expect(
      sorted("p9", [
        { player: "p1", percentage: 10 },
        { player: "p2", percentage: 30 },
      ]),
    ).toEqual(["p2", "p1"]);
  });
});

describe("equal stakes keep a stable, shared order", () => {
  it("preserves input order between two tied non-presidents", () => {
    /* `Array.prototype.sort` has been required to be stable since ES2019, and this leans on it: equal stakes
       keep `player_holdings`' own order, which the reducer builds identically on every client.
       WHY IT MATTERS MORE THAN TIDINESS: two browsers rendering one roster in two orders is a bug nobody
       would know how to describe, and an event-sourced game has no other arbiter than the log. */
    const input = [
      { player: "p2", percentage: 20 },
      { player: "p3", percentage: 20 },
    ];
    expect(sorted("p1", input)).toEqual(["p2", "p3"]);
    expect(sorted("p1", [...input].reverse())).toEqual(["p3", "p2"]);
  });

  it("gives the same answer twice for the same input", () => {
    // Determinism, stated plainly: no clock, no randomness, no `Math.random` tiebreak.
    const input = [
      { player: "p1", percentage: 30 },
      { player: "p2", percentage: 30 },
      { player: "p3", percentage: 30 },
    ];
    expect(sorted("p2", input)).toEqual(sorted("p2", input));
    expect(sorted("p2", input)[0]).toBe("p2");
  });
});

describe("the panel uses this comparator and records why", () => {
  const PANEL = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(
      path.join(__dirname, "..", "components", "StockRoundPanel.tsx"),
      "utf8",
    );
  })();

  const CODE = PANEL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("hoists the president before comparing stakes", () => {
    expect(CODE).toContain(
      "Number(company.president === b.player) - Number(company.president === a.player)",
    );
  });

  it("no longer sorts on percentage alone", () => {
    /* THE EXACT OLD LINE. It read correctly and produced a moving row, which is the kind of defect that
       survives review. */
    expect(CODE).not.toContain(".sort((a, b) => b.percentage - a.percentage)");
  });

  it("keeps the superseded reasoning rather than deleting it", () => {
    /* THE PROJECT'S OWN CONVENTION: a note records a correction, it does not quietly erase the claim it
       corrects. The old argument -- that a tie is worth noticing -- is right about the FACT and wrong about
       the carrier, and a later reader should be able to see both halves. */
    expect(PANEL).toContain("The note this replaces argued the opposite".toUpperCase());
    expect(PANEL).toContain("one certificate from the presidency");
  });

  it("states the rule the old order got wrong", () => {
    // A tie does not transfer the presidency; the challenger must exceed the incumbent.
    expect(PANEL).toContain("challenger must EXCEED the incumbent");
  });
});
