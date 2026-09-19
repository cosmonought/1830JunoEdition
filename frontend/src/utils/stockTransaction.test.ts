/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1451 (harness): WHAT THE CARD IS TOLD, AND WHERE IT CAME FROM
// ==================================================================
//
// THE ARCHITECTURAL CLAIM THIS SUITE DEFENDS is that the presentation layer never re-decides anything the
// rules already decided. Three sources, three questions, no overlap:
//
//   THE KIND AND THE CORPORATION come off the message the reducer applied. A buy is a buy because the action
//   said `BuyStock`, not because the Bank Pool went down.
//
//   THE OWNERSHIP comes off the percentage diff -- and percentages, not card counts, because a presidency
//   swap moves two cards and no stake (`presidencyTransfer.ts` #596a).
//
//   THE CROWN comes off `president` before and after. `settlePresidencies` has already applied #596's rule;
//   reading its answer is not re-deriving it, and the two cases below prove the module is not looking at
//   holdings: a takeover with identical percentages is reported, and a holdings change with the same
//   president is not.
//
// AND THE CASE THAT MATTERS MOST IS THE ONE WITH BOTH. A takeover produces exactly ONE transfer -- the
// purchase or sale that caused it -- because the exchange is invisible to a percentage diff. If that ever
// stopped being true the card would animate the same certificate twice.

import type { GameStateResponse } from "../gameEngine/gameState";

export {};

const { companyShareTransfer, describeStockTransaction, presidencyHandoff, stagedOwnership } =
  require("./stockTransaction") as typeof import("./stockTransaction");
const { anchorIndex, readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const PRR = 1;
const BO = 4;
const ALICE = "juno1alice";
const BOB = "juno1bob";

interface Row {
  ipo: number;
  bank: number;
  players: Record<string, number>;
  president?: string | null;
}

const company = (companyId: number, ticker: string, row: Row) => ({
  company_id: companyId,
  ticker,
  ipo_pool_percentage: row.ipo,
  bank_pool_percentage: row.bank,
  president: row.president ?? null,
  /* Built the way the contract builds it: a holder at 0% is OMITTED, never a row with a zero in it. */
  player_holdings: Object.keys(row.players)
    .filter((player) => row.players[player] > 0)
    .map((player) => ({ player, percentage: row.players[player] })),
});

const board = (rows: Record<number, Row>): GameStateResponse =>
  ({
    public_companies: Object.keys(rows).map((id) =>
      company(Number(id), Number(id) === PRR ? "PRR" : "B&O", rows[Number(id)]),
    ),
  }) as unknown as GameStateResponse;

const buy = { BuyStock: { game_id: 1, protocol_id: PRR, source: "Bank", par_value: null } };
const sell = { SellStock: { game_id: 1, protocol_id: PRR, percentage: 20 } };

const describe1 = (msg: unknown, before: Row, after: Row) =>
  describeStockTransaction(msg, board({ [PRR]: before }), board({ [PRR]: after }));

const transfer1 = (before: Row, after: Row) =>
  companyShareTransfer(company(PRR, "PRR", before), company(PRR, "PRR", after));

describe("what ownership moved", () => {
  it("reads a purchase from the IPO", () => {
    expect(transfer1({ ipo: 100, bank: 0, players: {} }, { ipo: 90, bank: 0, players: { [ALICE]: 10 } })).toEqual({
      from: "Ipo",
      to: ALICE,
      percentage: 10,
    });
  });

  it("reads a pool multi-buy as one grouped percentage", () => {
    /* A Brown-zone multi-buy is ONE dispatch (#712), so three shares are one movement of 30%. That is also
       why the chip carries a percentage and not a certificate count. */
    expect(
      transfer1({ ipo: 0, bank: 50, players: { [ALICE]: 20 } }, { ipo: 0, bank: 20, players: { [ALICE]: 50 } }),
    ).toEqual({ from: "Bank", to: ALICE, percentage: 30 });
  });

  it("reads a sale into the Bank Pool, including one that empties the seller's row", () => {
    expect(
      transfer1({ ipo: 0, bank: 10, players: { [ALICE]: 40 } }, { ipo: 0, bank: 30, players: { [ALICE]: 20 } }),
    ).toEqual({ from: ALICE, to: "Bank", percentage: 20 });
    expect(
      transfer1({ ipo: 0, bank: 0, players: { [ALICE]: 10, [BOB]: 30 } }, { ipo: 0, bank: 10, players: { [BOB]: 30 } }),
    ).toEqual({ from: ALICE, to: "Bank", percentage: 10 });
  });

  it("nets the double certificate's half-sale to the ten per cent that actually moved", () => {
    /* #1324: the 20% card leaves for the pool and a 10% card comes back. */
    expect(
      transfer1({ ipo: 0, bank: 10, players: { [ALICE]: 20 } }, { ipo: 0, bank: 20, players: { [ALICE]: 10 } }),
    ).toEqual({ from: ALICE, to: "Bank", percentage: 10 });
  });

  it("CANNOT SEE the president's exchange, which is the property the sequencing rests on", () => {
    /* The 20% card swaps for two 10% cards and nobody's stake moves. A card-counting diff would report a
       transfer between two players who traded nothing -- and, worse here, would report it ALONGSIDE the
       purchase that caused it, so the card would animate one certificate twice. */
    const level = { ipo: 10, bank: 0, players: { [ALICE]: 40, [BOB]: 50 } };
    expect(transfer1({ ...level, president: ALICE }, { ...level, president: BOB })).toBeNull();
  });

  it("refuses shapes it cannot name rather than guessing at one", () => {
    expect(
      transfer1({ ipo: 40, bank: 0, players: {} }, { ipo: 20, bank: 0, players: { [ALICE]: 10, [BOB]: 10 } }),
    ).toBeNull();
    expect(transfer1({ ipo: 100, bank: 0, players: {} }, { ipo: 90, bank: 0, players: { [ALICE]: 20 } })).toBeNull();
  });
});

describe("who now presides", () => {
  const level = { ipo: 10, bank: 0, players: { [ALICE]: 40, [BOB]: 50 } };

  it("reports a crown moving between two sitting players", () => {
    expect(
      presidencyHandoff(company(PRR, "PRR", { ...level, president: ALICE }), company(PRR, "PRR", { ...level, president: BOB })),
    ).toEqual({ from: ALICE, to: BOB });
  });

  it("is not derived from holdings -- it reads the field the engine already settled", () => {
    /* BOB outholds ALICE in both states here and the crown does not move (1830: a challenger must EXCEED,
       and `presidentFor` #596b owns that rule). A module inferring the president from the table would
       report a handoff; this one reports none, because the engine did not. */
    expect(
      presidencyHandoff(company(PRR, "PRR", { ...level, president: ALICE }), company(PRR, "PRR", { ...level, president: ALICE })),
    ).toBeNull();
  });

  it("does not call a corporation's FIRST president a handoff", () => {
    /* `null -> ALICE` is the par purchase that starts the company. There is no old crown to erase, no
       certificate to exchange and no row to displace; the crown simply arrives with the row. */
    const before = company(PRR, "PRR", { ipo: 100, bank: 0, players: {}, president: null });
    const after = company(PRR, "PRR", { ipo: 80, bank: 0, players: { [ALICE]: 20 }, president: ALICE });
    expect(presidencyHandoff(before, after)).toBeNull();
  });
});

describe("the completed action, described", () => {
  it("takes the kind and the corporation from the message, not from the board", () => {
    const event = describe1(buy, { ipo: 100, bank: 0, players: {} }, { ipo: 90, bank: 0, players: { [ALICE]: 10 } });
    expect(event).toMatchObject({
      companyId: PRR,
      ticker: "PRR",
      kind: "buy",
      transfer: { from: "Ipo", to: ALICE, percentage: 10 },
      presidency: null,
    });
  });

  it("calls a sale a sale even though the board movement is the mirror of a buy", () => {
    /* THE CASE THAT RULES OUT INFERENCE FROM STATE. `Bank -> player` and `player -> Bank` are
       distinguishable, but the ORDER the card plays a takeover in depends on which message ran, and the
       board cannot be asked. Here the message is the only witness. */
    const event = describe1(sell, { ipo: 0, bank: 0, players: { [ALICE]: 40 } }, { ipo: 0, bank: 20, players: { [ALICE]: 20 } });
    expect(event?.kind).toBe("sell");
    expect(event?.transfer).toEqual({ from: ALICE, to: "Bank", percentage: 20 });
  });

  it("carries the purchase AND the crown for a takeover, as two separate facts", () => {
    const before = { ipo: 10, bank: 20, players: { [ALICE]: 40, [BOB]: 30 }, president: ALICE };
    const after = { ipo: 10, bank: 0, players: { [ALICE]: 40, [BOB]: 50 }, president: BOB };
    expect(describe1(buy, before, after)).toMatchObject({
      companyId: PRR,
      ticker: "PRR",
      kind: "buy",
      transfer: { from: "Bank", to: BOB, percentage: 20 },
      presidency: { from: ALICE, to: BOB },
    });
  });

  it("says nothing for a message that is not a stock trade, or a board that did not move", () => {
    const still = { ipo: 60, bank: 0, players: { [ALICE]: 40 } };
    expect(describe1({ PassTurn: { game_id: 1 } }, still, { ipo: 50, bank: 0, players: { [ALICE]: 50 } })).toBeNull();
    /* A refused action leaves the board untouched. The holdings on screen are already correct, which is the
       whole fallback -- the card simply does not light up. */
    expect(describe1(buy, still, still)).toBeNull();
    expect(describeStockTransaction(buy, null, board({ [PRR]: still }))).toBeNull();
  });

  it("ignores a corporation the action did not name", () => {
    const before = board({ [PRR]: { ipo: 100, bank: 0, players: {} }, [BO]: { ipo: 100, bank: 0, players: {} } });
    const after = board({
      [PRR]: { ipo: 100, bank: 0, players: {} },
      [BO]: { ipo: 90, bank: 0, players: { [ALICE]: 10 } },
    });
    /* The message names the PRR; the B&O moved. Nothing to show, and no sweep of the board to find it --
       #1450 swept because it had no action to ask; this does not. */
    expect(describeStockTransaction(buy, before, after)).toBeNull();
  });
});

describe("the staged board (design note #1452)", () => {
  const before = { ipo: 10, bank: 20, players: { [ALICE]: 40, [BOB]: 30 }, president: ALICE };
  const after = { ipo: 10, bank: 0, players: { [ALICE]: 40, [BOB]: 50 }, president: BOB };
  const takeover = describe1(buy, before, after)!;

  it("carries the four ownership fields from each side, and copies the holdings array", () => {
    expect(takeover.before).toEqual({
      ipo_pool_percentage: 10,
      bank_pool_percentage: 20,
      player_holdings: [
        { player: ALICE, percentage: 40 },
        { player: BOB, percentage: 30 },
      ],
      president: ALICE,
      double_certificate: undefined,
    });
    expect(takeover.after.president).toBe(BOB);
    /* A snapshot that shares an array with the state it came from is not a snapshot. */
    expect(takeover.before.player_holdings).not.toBe(takeover.after.player_holdings);
  });

  it("starts at `before`, whole", () => {
    const staged = stagedOwnership(takeover, { transfer: false, presidency: false });
    expect(staged).toEqual(takeover.before);
  });

  it("passes through the buy takeover's real intermediate: shares moved, crown not yet", () => {
    const staged = stagedOwnership(takeover, { transfer: true, presidency: false })!;
    expect(staged.player_holdings).toEqual(takeover.after.player_holdings);
    expect(staged.bank_pool_percentage).toBe(0);
    expect(staged.president).toBe(ALICE);
  });

  it("passes through the sell takeover's real intermediate: crown moved, shares not yet", () => {
    const staged = stagedOwnership(takeover, { transfer: false, presidency: true })!;
    expect(staged.player_holdings).toEqual(takeover.before.player_holdings);
    expect(staged.bank_pool_percentage).toBe(20);
    expect(staged.president).toBe(BOB);
  });

  it("arrives at `after`, exactly, so the release is not a jump", () => {
    expect(stagedOwnership(takeover, { transfer: true, presidency: true })).toEqual(takeover.after);
  });

  it("selects rather than computes -- every staged figure is one the reducer produced", () => {
    /* The only defence against the presentation layer inventing a number is that it never does arithmetic.
       Each field below is identical to one side or the other, never a blend. */
    ([
      { transfer: false, presidency: false },
      { transfer: true, presidency: false },
      { transfer: false, presidency: true },
      { transfer: true, presidency: true },
    ] as const).forEach((applied) => {
      const staged = stagedOwnership(takeover, applied)!;
      expect([takeover.before.bank_pool_percentage, takeover.after.bank_pool_percentage]).toContain(
        staged.bank_pool_percentage,
      );
      expect([takeover.before.president, takeover.after.president]).toContain(staged.president);
    });
  });

  it("is nothing at all without a transaction, which is the failure fallback", () => {
    expect(stagedOwnership(null, { transfer: false, presidency: false })).toBeNull();
  });
});

describe("the shell describes and does not decide", () => {
  const APP = readStripped("App.tsx");
  const MODULE = readStripped("utils/stockTransaction.ts");

  it("asks the authoritative message, and asks it after the commit", () => {
    expect(APP).toContain("describeStockTransaction(gameplay, before, after)");
    const commit = anchorIndex(APP, "setSandboxState(after);", "the commit");
    expect(anchorIndex(APP, "describeStockTransaction(gameplay", "the description")).toBeGreaterThan(commit);
  });

  it("re-implements no stock rule", () => {
    /* THE CONSTRAINT, AS AN ABSENCE. This module may read `president`; it may not work out who it should be,
       what anything costs, or whether anything was allowed. */
    ["presidentFor", "settlePresidencies", "sharePurchaseBlock", "marketZoneForPrice", "par_value"].forEach(
      (rule) => expect(MODULE).not.toContain(rule),
    );
  });

  it("is replay-silent and introduces no timing dependency", () => {
    const raiser = APP.slice(anchorIndex(APP, "const showStockTransaction = useCallback("));
    expect(raiser.slice(0, 260)).toContain("if (replayingHistory) return;");
    expect(APP).not.toContain("await showStockTransaction");
  });

  it("left none of #1450's screen-space machinery behind", () => {
    ["FlightGhostLayer", "flightAnchor", "data-flight-anchor", "shareMovement"].forEach((gone) =>
      expect(APP).not.toContain(gone),
    );
  });
});
