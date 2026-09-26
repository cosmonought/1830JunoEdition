/** @jest-environment node */
// frontend/src/utils/settlementVariants.test.ts
//
// ==================================================================
//  SET-0B: VARIANTS, COMPOSITIONS AND THE RULE EDGES, ON THE APPRAISER
// ==================================================================
//
// SET-0A §10: no variant adds a valuation rule. Gentle Rust and Unpredictable Revenue change trains and revenue, which
// are never inputs; Delayed Auction changes who owns privates and when, which the ownership rules already cover;
// Level Playing Field adds catalog entries and a seventh seat, which a catalog-free appraiser reads from state;
// Dynamic Stock Market adds a $450 row, which is just a price on a token. These tests pin that, and pin the rule edges
// (unparred vs parred-unfloated, private ownership, bankruptcy, over-limit holdings) with one-field mutations of the
// golden boards.

import { baseNetWorthVector, appraiseSeats, type SettlementSeat } from "../gameEngine/settlementAppraisal";
import { terminalStateHashV1 } from "../gameEngine/settlementDigest";
import type { GameStateResponse } from "../gameEngine/gameState";
import { goldenBoards } from "./settlementGoldenBoards";

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const { boards } = goldenBoards();
const seatsOf = (ids: readonly string[]): SettlementSeat[] => ids.map((player_id, seat_index) => ({ seat_index, player_id }));
const copyOf = (name: string): Loose => JSON.parse(JSON.stringify(boards[name])) as Loose;
const vec = (board: Loose, seats: SettlementSeat[]) => baseNetWorthVector(board as GameStateResponse, seats).map(String);
const company = (b: Loose, ticker: string) => (b.public_companies as Loose[]).find((c) => c.ticker === ticker)!;
const priv = (b: Loose, id: number) => (b.private_companies as Loose[]).find((p) => p.private_id === id)!;

const CLASSIC_SEATS = seatsOf(["p2", "p1", "p3"]);
const Z6C_SEATS = seatsOf(["p-lzjh2r6u", "p-6a1qgd0g", "p-je0gw2v0"]);

describe("variant flags and the golden boards they describe", () => {
  const flags = (name: string) => boards[name].variants as unknown as Loose;
  it("Classic (SYN-01): every variant off", () => {
    const v = flags("SYN-01-CLASSIC-BANKBREAK");
    expect([v.gentleRust, v.unpredictableRevenue, v.delayedAuction, v.dynamicStockMarket, v.levelPlayingField]).toEqual([false, false, false, false, false]);
  });
  it("Gentle Rust (SYN-02), GR + Unpredictable Revenue (SYN-03), Delayed Auction (SYN-08/09), LPF + 18XX+ + UR (SYN-05), + Dynamic Market (SYN-07), LPF 7 seats (SYN-12)", () => {
    expect(flags("SYN-02-GENTLE-RUST-BANKBREAK").gentleRust).toBe(true);
    expect([flags("SYN-03-UNPREDICTABLE-REVENUE-END").gentleRust, flags("SYN-03-UNPREDICTABLE-REVENUE-END").unpredictableRevenue]).toEqual([true, true]);
    expect(flags("SYN-08-DELAYED-AUCTION-UNSOLD").delayedAuction).toBe(true);
    expect(flags("SYN-09-DELAYED-AUCTION-PHASE5-UNSOLD-CLOSED").delayedAuction).toBe(true);
    const z = flags("SYN-05-Z6C-COMPOSED-END");
    expect([z.levelPlayingField, z.expandedMap, z.plusTiles, z.unpredictableRevenue]).toEqual([true, true, true, true]);
    expect(flags("SYN-07-DOUBLE-CERT-AND-DYNAMIC-450").dynamicStockMarket).toBe(true);
    expect(flags("SYN-12-SEVEN-PLAYERS-LPF").levelPlayingField).toBe(true);
    expect(boards["SYN-12-SEVEN-PLAYERS-LPF"].player_addresses).toHaveLength(7);
  });
});

describe("what is NOT an input: trains, treasuries, tokens, revenue, the bank, flags -- the hash moves, the vector does not", () => {
  const noise: Array<[string, (b: Loose) => void]> = [
    ["every train field (owned, pending rust, ghost, Carcosan, removed, returned)", (b) => {
      for (const c of b.public_companies) {
        c.owned_trains = ["D", "D", "D"];
        c.pending_rust_trains = ["4"];
        c.ghost_trains = ["2"];
        c.carcosan_trains = ["6"];
      }
      b.removed_trains = ["4", "5"];
      b.returned_trains = ["3"];
    }],
    ["treasuries", (b) => { for (const c of b.public_companies) c.treasury = "99999"; }],
    ["station tokens and licences", (b) => { for (const c of b.public_companies) { c.station_tokens = []; c.station_token_hexes = []; c.kanawha_licenses = 3; } }],
    ["revenue and run fields", (b) => { for (const c of b.public_companies) { c.last_route_revenue = "500"; c.printed_route_revenue = "700"; c.last_run_breakdown = [{ model: "D", printed_revenue: "700", train_index: 0 }]; c.has_yellow_sign = true; } }],
    ["the bank, the latch and the JUNO pool mirror", (b) => { b.virtual_bank_vgp = "-5000"; b.bank_broken = false; b.total_juno_pool = "999"; }],
    ["is_floated (parred corporations are valued at their token either way)", (b) => { for (const c of b.public_companies) c.is_floated = !c.is_floated; }],
    ["settled_price on privates", (b) => { for (const p of b.private_companies) p.settled_price = 1; }],
    ["every variant flag", (b) => { b.variants = { ...b.variants, gentleRust: true, unpredictableRevenue: true, delayedAuction: true, dynamicStockMarket: true, levelPlayingField: true, expandedMap: true, plusTiles: true }; }],
    ["the mark's chart coordinates and entry order", (b) => { for (const key of Object.keys(b.market_positions)) if (b.market_positions[key]) Object.assign(b.market_positions[key], { x: 0, y: 0, enteredAt: 0 }); }],
    ["a standing M&H exchange request and pending offers", (b) => { b.pending_mh_exchange = { player: "p2" }; b.pending_private_offer = { price: "100" }; }],
    ["the turn pointer and priority", (b) => { b.active_player_index = 2; b.priority_deal_index = 2; }],
  ];

  for (const name of ["SYN-01-CLASSIC-BANKBREAK", "SYN-02-GENTLE-RUST-BANKBREAK", "SYN-03-UNPREDICTABLE-REVENUE-END"]) {
    for (const [what, mutate] of noise) {
      it(`${name}: ${what}`, () => {
        const b = copyOf(name);
        const before = vec(b, CLASSIC_SEATS);
        const hash = terminalStateHashV1(b as GameStateResponse);
        mutate(b);
        expect(vec(b, CLASSIC_SEATS)).toEqual(before);
        expect(terminalStateHashV1(b as GameStateResponse)).not.toBe(hash);
      });
    }
  }
});

describe("share value: unparred $0, parred-but-unfloated at its token, the token wherever it sits", () => {
  it("SYN-06: the C&A's PRR grant is worth $0 while PRR is unparred, and the token's price once PRR pars", () => {
    const seats = seatsOf(["p-fdsq3jbg", "p-lzjh2r6u"]);
    const b = copyOf("SYN-06-G6J-UNPARRED-GRANT-END");
    expect(vec(b, seats)).toEqual(["1205", "1230"]);
    company(b, "PRR").par_value = "100";
    b.market_positions["1"] = { price: 100, x: 6, y: 10, enteredAt: 1 };
    expect(vec(b, seats)).toEqual(["1305", "1230"]);
  });

  it("SYN-05: N&W is parred and unfloated, and its shares are worth $100 each (not $0, not par-by-rule)", () => {
    const b = copyOf("SYN-05-Z6C-COMPOSED-END");
    expect(company(b, "N&W").is_floated).toBe(false);
    const nw = appraiseSeats(b as GameStateResponse, Z6C_SEATS)[0].holdings.find((line) => line.ticker === "N&W")!;
    expect([nw.percent, String(nw.share_value), String(nw.value)]).toEqual([40, "100", "400"]);
    // The PRICE is the token, not par: moving N&W's token moves the value while par stays $100.
    b.market_positions["10"].price = 90;
    expect(vec(b, Z6C_SEATS)).toEqual(["2066", "2862", "1923"]);
  });

  it("Dynamic Stock Market: the $450 cell is read like any other (SYN-07), and so is a $1 cell", () => {
    expect(vec(copyOf("SYN-07-DOUBLE-CERT-AND-DYNAMIC-450"), Z6C_SEATS)).toEqual(["2396", "4312", "2713"]);
    const low = copyOf("SYN-07-DOUBLE-CERT-AND-DYNAMIC-450");
    low.market_positions["1"].price = 1;
    expect(vec(low, Z6C_SEATS)).toEqual(["2396", "4312", "2713"].map((v, i) => String(Number(v) - [449, 2245, 898][i])));
  });

  it("the president's certificate and the LPF double certificate are two units each; certificate cards never matter", () => {
    const b = copyOf("SYN-07-DOUBLE-CERT-AND-DYNAMIC-450");
    const seat = appraiseSeats(b as GameStateResponse, Z6C_SEATS)[2];
    expect(String(seat.holdings.find((line) => line.ticker === "N&W")!.value)).toBe("300"); // 10% + the 20% double
    b.public_companies.find((c: Loose) => c.ticker === "N&W").double_certificate = { at: "Ipo" }; // where the card sits is not value
    expect(vec(b, Z6C_SEATS)).toEqual(["2396", "4312", "2713"]);
  });

  it("over-limit holdings still count (#759 ii): p1 at 80% of PRR is eight shares", () => {
    const b = copyOf("SYN-01-CLASSIC-BANKBREAK");
    const prr = company(b, "PRR");
    prr.player_holdings = [{ player: "p1", percentage: 80 }, { player: "p3", percentage: 20 }];
    expect(vec(b, CLASSIC_SEATS)).toEqual(["1818", "2648", "2409"]);
  });
});

describe("privates: face value only while open and player-owned", () => {
  it("a private sold to a corporation stops counting for the player (D&H to PRR)", () => {
    const b = copyOf("SYN-01-CLASSIC-BANKBREAK");
    Object.assign(priv(b, 3), { owner: null, owner_protocol_id: 1 });
    expect(vec(b, CLASSIC_SEATS)).toEqual(["2018", "2378", "2409"]);
  });

  it("a closed private counts for nobody even when its owner is still recorded (Phase 5 keeps owner, F-8)", () => {
    const b = copyOf("SYN-01-CLASSIC-BANKBREAK");
    priv(b, 5).closed = true;
    expect(priv(b, 5).owner).toBe("p1");
    expect(vec(b, CLASSIC_SEATS)).toEqual(["2018", "2288", "2409"]);
  });

  it("the printed face, never settled_price (Z6C paid $165 for the C&A; it counts $160)", () => {
    const b = copyOf("SYN-05-Z6C-COMPOSED-END");
    expect(priv(b, 5).settled_price).toBe(165);
    const seat = appraiseSeats(b as GameStateResponse, Z6C_SEATS)[1];
    expect(seat.private_lines.map((line) => [line.private_id, String(line.face)])).toEqual([[4, "110"], [5, "160"]]);
  });

  it("unsold privates (Delayed Auction before its auction) and unsold-then-closed privates count for nobody", () => {
    expect(vec(copyOf("SYN-08-DELAYED-AUCTION-UNSOLD"), CLASSIC_SEATS)).toEqual(["1868", "2218", "2389"]);
    expect(vec(copyOf("SYN-09-DELAYED-AUCTION-PHASE5-UNSOLD-CLOSED"), CLASSIC_SEATS)).toEqual(["1868", "2218", "2389"]);
  });
});

describe("Delayed Auction: the DA-F6 mint is refused; the corrected (D-52) grant appraises normally", () => {
  /* This clone predates DA-5 (a6ef5e7, local-only), so both boards are synthetic grafts on the SYN-08 board and no
     gameplay code is touched. DA-F6: when PRR's IPO holds < 10% the C&A grant falls back to the Bank Pool without
     checking it holds 10% and floors both piles at 0 -- a certificate is created. With every PRR share in players'
     hands that is 110% held, and the conservation checks refuse it (`HOLDINGS_EXCEED_100` precedes
     `PERCENT_NOT_CONSERVED`; SET-0A §18 orders them the same way). */
  const daBoard = () => {
    const b = copyOf("SYN-08-DELAYED-AUCTION-UNSOLD");
    b.private_auction_complete = true;
    Object.assign(priv(b, 5), { owner: "p3", owner_protocol_id: null, closed: false }); // p3 wins the C&A
    return b;
  };

  it("DA-F6 corrupt board (grant minted from empty piles): refused", () => {
    const b = daBoard();
    const prr = company(b, "PRR");
    expect([prr.ipo_pool_percentage, prr.bank_pool_percentage]).toEqual([0, 0]);
    prr.player_holdings.find((row: Loose) => row.player === "p3").percentage += 10; // the minted 10%
    expect(() => baseNetWorthVector(b as GameStateResponse, CLASSIC_SEATS)).toThrow("HOLDINGS_EXCEED_100: PRR=110");
  });

  it("DA-F6 corrupt board where the piles were floored instead of the holders growing: refused as not conserved", () => {
    const b = daBoard();
    const prr = company(b, "PRR");
    prr.player_holdings.find((row: Loose) => row.player === "p1").percentage = 50; // p1 had sold 10% to the pool...
    prr.bank_pool_percentage = 0; // ...and the floored pile forgot it
    expect(() => baseNetWorthVector(b as GameStateResponse, CLASSIC_SEATS)).toThrow("PERCENT_NOT_CONSERVED: PRR: holders 90 + ipo 0 + pool 0");
  });

  it("corrected grant (D-52 reserved certificate, from the IPO): conserved, and the grantee's share is valued at the token", () => {
    const b = daBoard();
    const prr = company(b, "PRR");
    // Before the auction the reserved 10% stayed in the IPO (holders 90 + IPO 10); the grant moves it to p3.
    prr.player_holdings = [{ player: "p1", percentage: 60 }, { player: "p2", percentage: 20 }, { player: "p3", percentage: 10 }];
    prr.ipo_pool_percentage = 10;
    prr.reserved_certificate = { private_id: 5, percentage: 10 };
    expect(vec(b, CLASSIC_SEATS)).toEqual(["1868", "2218", "2449"]); // p3: 705 cash + shares 1584 + C&A 160
    prr.player_holdings[2].percentage = 20;
    prr.ipo_pool_percentage = 0;
    delete prr.reserved_certificate;
    expect(vec(b, CLASSIC_SEATS)).toEqual(["1868", "2218", "2549"]); // +10% of PRR at $100
  });
});

describe("bankruptcy (OD-SET-1 (a)): shares only, never forced to zero", () => {
  it("SYN-04: the bankrupt's cash and privates drop out; his remaining shares count at market", () => {
    const seat = appraiseSeats(boards["SYN-04-BANKRUPTCY"], CLASSIC_SEATS)[1];
    expect([seat.bankrupt, String(seat.cash_state), String(seat.cash_counted), String(seat.privates), String(seat.total)]).toEqual([true, "640", "0", "0", "1578"]);
  });

  it("a bankrupt whose every remaining share is unparred appraises to 0 -- a legal entry, not a refusal", () => {
    const b = copyOf("SYN-04-BANKRUPTCY");
    for (const c of b.public_companies) c.player_holdings = c.player_holdings.filter((row: Loose) => row.player !== "p1");
    company(b, "PRR").player_holdings.push({ player: "p1", percentage: 60 });
    // Make PRR unparred with p1's 60% still held (a synthetic edge; the rulebook cannot reach it, the arithmetic can).
    company(b, "PRR").par_value = null;
    delete b.market_positions["1"];
    for (const ticker of ["NYC", "CPR", "B&O", "C&O"]) {
      const c = company(b, ticker);
      c.ipo_pool_percentage = 100 - c.player_holdings.reduce((s: number, row: Loose) => s + row.percentage, 0);
    }
    const seats = appraiseSeats(b as GameStateResponse, CLASSIC_SEATS);
    expect(String(seats[1].total)).toBe("0");
    expect(seats[1].bankrupt).toBe(true);
  });

  it("only the recorded bankrupt is scored that way; everyone else keeps cash and privates", () => {
    const seats = appraiseSeats(boards["SYN-04-BANKRUPTCY"], CLASSIC_SEATS);
    expect(seats.filter((seat) => seat.bankrupt).map((seat) => seat.player_id)).toEqual(["p1"]);
    expect(String(seats[0].cash_counted)).toBe("530");
  });
});
