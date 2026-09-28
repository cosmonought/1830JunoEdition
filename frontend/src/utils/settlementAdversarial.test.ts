/** @jest-environment node */
// frontend/src/utils/settlementAdversarial.test.ts
//
// ==================================================================
//  SET-0B: THE SET-0A §18 ADVERSARIAL MATRIX -- EVERY IMPOSSIBLE BOARD FAILS CLOSED, BY NAME
// ==================================================================
//
// Each Q case mutates ONE thing on a fresh copy of the SYN-01 terminal board and must be refused with exactly the
// message the SET-0A rev 2 golden file records (`adversarial[]` in the derived fixture). Nothing is rounded, zeroed or
// ignored. After the frozen matrix: the SET-0B additions (shape errors, unsupported pins, number leakage) and the
// zero-sum / tamper / wide-arithmetic boundaries (Q13, Q14, Q16).

import { readFileSync } from "fs";
import { join } from "path";

import {
  appraiseSeats,
  baseNetWorthVector,
  SettlementAppraisalError,
  type SettlementSeat,
} from "../gameEngine/settlementAppraisal";
import { terminalStateHashV1 } from "../gameEngine/settlementDigest";
import { payoutPreview, U128_MAX } from "../gameEngine/settlementPreview";
import type { GameStateResponse } from "../gameEngine/gameState";
import { goldenBoards } from "./settlementGoldenBoards";

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const golden = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "settlement", "SET0A_golden_vectors_rev2.derived.json"), "utf8"),
) as { adversarial: Array<{ id: string; result: string }> };
const expected = (id: string) => golden.adversarial.find((entry) => entry.id === id)!.result;

const SYN01 = goldenBoards().boards["SYN-01-CLASSIC-BANKBREAK"];
const SEATS: SettlementSeat[] = [
  { seat_index: 0, player_id: "p2" },
  { seat_index: 1, player_id: "p1" },
  { seat_index: 2, player_id: "p3" },
];
const seatsOf = (ids: string[]): SettlementSeat[] => ids.map((player_id, seat_index) => ({ seat_index, player_id }));

/** A fresh deep copy of SYN-01 with one mutation applied. */
function board(mutate: (b: Loose) => void = () => undefined): GameStateResponse {
  const copy = JSON.parse(JSON.stringify(SYN01)) as Loose;
  mutate(copy);
  return copy as GameStateResponse;
}
const company = (b: Loose, ticker: string) => (b.public_companies as Loose[]).find((c) => c.ticker === ticker)!;
const holding = (b: Loose, ticker: string, player: string) =>
  (company(b, ticker).player_holdings as Loose[]).find((row) => row.player === player)!;
const cashRow = (b: Loose, player: string) => (b.player_cash as Loose[]).find((row) => row.player === player)!;
const priv = (b: Loose, id: number) => (b.private_companies as Loose[]).find((p) => p.private_id === id)!;

/** The refusal's full `CODE: detail` message, or "ACCEPTED". */
function outcome(state: GameStateResponse, seats: unknown = SEATS): string {
  try {
    appraiseSeats(state, seats as SettlementSeat[]);
    return "ACCEPTED";
  } catch (error) {
    if (!(error instanceof SettlementAppraisalError)) throw error;
    expect(error.message).toBe(`${error.code}: ${error.detail}`);
    return error.message;
  }
}

describe("the SET-0A §18 matrix, exact messages", () => {
  const cases: Array<[string, () => string]> = [
    ["Q1", () => outcome(board(), seatsOf(["p2", "p1", "p1"]))],
    ["Q2", () => outcome(board(), seatsOf(["p2", "p1"]))],
    ["Q3", () => outcome(board(), seatsOf(["p-fake", "p1", "p3"]))],
    ["Q3b", () => outcome(board(), [{ seat_index: 0, player_id: "p2" }, { seat_index: 1, player_id: "p1" }, { seat_index: 3, player_id: "p3" }])],
    ["Q3c", () => outcome(board(), [{ seat_index: 2, player_id: "p3" }, { seat_index: 0, player_id: "p2" }, { seat_index: 1, player_id: "p1" }])],
    ["Q4", () => outcome(board((b) => { cashRow(b, "p1").cash_vgp = "-5"; }))],
    ["Q4b", () => outcome(board((b) => { cashRow(b, "p1").cash_vgp = 500; }))],
    ["Q4c", () => outcome(board((b) => { cashRow(b, "p1").cash_vgp = "1e3"; }))],
    ["Q4d", () => outcome(board((b) => { cashRow(b, "p1").cash_vgp = "500.5"; }))],
    ["Q4e", () => outcome(board((b) => { cashRow(b, "p1").cash_vgp = "0500"; }))],
    ["Q5", () => outcome(board((b) => { cashRow(b, "p1").cash_vgp = "9007199254740993"; }))],
    ["Q5b", () => outcome(board((b) => { cashRow(b, "p1").cash_vgp = U128_MAX.toString(); }))],
    ["Q5c", () => outcome(board((b) => { b.player_cash.push({ player: "p1", cash_vgp: "640" }); }))],
    ["Q5d", () => outcome(board((b) => { b.player_cash = b.player_cash.filter((row: Loose) => row.player !== "p3"); }))],
    ["Q6", () => outcome(board((b) => { holding(b, "PRR", "p1").percentage = 15; }))],
    ["Q6b", () => outcome(board((b) => { holding(b, "PRR", "p1").percentage = 20.5; }))],
    ["Q6c", () => outcome(board((b) => { holding(b, "PRR", "p3").percentage = 0; }))],
    ["Q6d", () => outcome(board((b) => { holding(b, "PRR", "p1").percentage = "20"; }))],
    ["Q7", () => outcome(board((b) => { Object.assign(priv(b, 1), { owner: null, owner_protocol_id: 99 }); }))],
    ["Q7b", () => outcome(board((b) => { priv(b, 1).owner_protocol_id = 1; }))],
    ["Q7c", () => outcome(board((b) => { priv(b, 1).owner = "p-ghost"; }))],
    ["Q7d", () => outcome(board((b) => { priv(b, 1).cost = "20.0"; }))],
    ["Q7e", () => outcome(board((b) => { priv(b, 2).private_id = 1; }))],
    ["Q8", () => outcome(board((b) => { holding(b, "PRR", "p2").percentage = 30; }))],
    ["Q8f", () => outcome(board((b) => { company(b, "ERIE").ipo_pool_percentage = 90; }))],
    ["Q8g", () => outcome(board((b) => { holding(b, "PRR", "p2").percentage = 10; }))],
    ["Q17", () => outcome(board((b) => { company(b, "PRR").par_value = "100.0"; }))],
    ["Q8b", () => outcome(board((b) => { holding(b, "PRR", "p1").percentage = 80; }))],
    ["Q8c", () => outcome(board((b) => { company(b, "PRR").player_holdings.push({ player: "p1", percentage: 10 }); }))],
    ["Q8d", () => outcome(board((b) => { company(b, "PRR").player_holdings.push({ player: "p-ghost", percentage: 10 }); }))],
    ["Q8e", () => outcome(board((b) => { company(b, "NYC").company_id = 1; }))],
    ["Q9", () => outcome(board((b) => { delete b.market_positions["1"]; }))],
    ["Q9b", () => outcome(board((b) => { b.market_positions["1"].price = 0; }))],
    ["Q9c", () => outcome(board((b) => { b.market_positions["1"].price = 82.5; }))],
    ["Q9d", () => outcome(board((b) => { b.market_positions["6"] = { price: 100, x: 6, y: 10, enteredAt: 9 }; }))],
    ["Q10", () => outcome(board((b) => { b.bankrupt_president = "p-ghost"; }))],
    ["Q10b", () => outcome(board((b) => { b.bankrupt_president = "p1"; b.current_round_type = "OperatingRound"; }))],
    ["Q11", () => outcome(board((b) => { delete b.rules_engine_version; }))],
    ["Q12", () => outcome(board(), seatsOf(["p2"]))],
  ];
  for (const [id, run] of cases) {
    it(`${id}: ${expected(id)}`, () => {
      expect(run()).toBe(expected(id));
    });
  }

  it("covers every refusal the golden file lists (Q13-Q16 are acceptance/boundary cases, below)", () => {
    const refusals = golden.adversarial.filter((entry) => !/^Q1[3-6]$/.test(entry.id)).map((entry) => entry.id).sort();
    expect(cases.map(([id]) => id).sort()).toEqual(refusals);
  });
});

describe("the boundaries: zero sum, tamper, wide arithmetic, turn order", () => {
  it("Q13: an all-zero board is ACCEPTED by the appraiser; the preview (payload layer) refuses the zero sum", () => {
    const zero = board((b) => {
      for (const row of b.player_cash) row.cash_vgp = "0";
      for (const c of b.public_companies) {
        c.player_holdings = [];
        c.ipo_pool_percentage = 100;
        c.bank_pool_percentage = 0;
        c.par_value = null;
      }
      b.market_positions = {};
      for (const p of b.private_companies) p.closed = true;
    });
    const vector = baseNetWorthVector(zero, SEATS);
    expect(vector.map(String)).toEqual((golden.adversarial.find((e) => e.id === "Q13") as unknown as { vector: string[] }).vector);
    expect(() => payoutPreview(BigInt(5850000), vector)).toThrow("SETTLEMENT_ZERO_SUM: sum of weights is zero");
  });

  it("Q14: one share price changed after hashing changes the hash (8b5b24d5... -> cb728a28...)", () => {
    expect(terminalStateHashV1(SYN01).slice(0, 16)).toBe("8b5b24d510eb021b");
    const tampered = board((b) => { b.market_positions["1"].price = 101; });
    expect(terminalStateHashV1(tampered).slice(0, 16)).toBe("cb728a28eb6f30b8");
    // ...and the tampered board appraises differently, so "vector = appraisal(hashed board)" exposes it.
    expect(baseNetWorthVector(tampered, SEATS).map(String)).not.toEqual(baseNetWorthVector(SYN01, SEATS).map(String));
  });

  it("Q16: no product-level cap -- a u128-max weight with a 1e15 ujuno pool settles exactly", () => {
    const preview = payoutPreview(BigInt("1000000000000000"), [U128_MAX, BigInt(1)]);
    expect(preview.payouts.map(String)).toEqual(["999999999999999", "0"]);
    expect(preview.dust.toString()).toBe("1");
    expect(preview.payouts.every((payout) => payout <= preview.pool)).toBe(true);
  });

  it("n = 8 is refused by the same bound as n = 1 (contract bound 2..7, A3)", () => {
    const eight = board((b) => {
      for (let i = 4; i <= 8; i += 1) {
        b.player_addresses.push(`p${i}`);
        b.player_cash.push({ player: `p${i}`, cash_vgp: "0" });
      }
    });
    expect(outcome(eight, seatsOf(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]))).toBe("BAD_SEAT_COUNT: n=8");
    expect(outcome(board(), [])).toBe("BAD_SEAT_COUNT: n=0");
    expect(outcome(board(), null)).toBe("BAD_SEAT_COUNT: n=null");
  });
});

describe("SET-0B additions: shapes SET-0A names no code for, still refused by name", () => {
  const additions: Array<[string, () => string, string]> = [
    ["a pin this appraiser is not certified for", () => outcome(board((b) => { b.rules_engine_version = 9; })), "UNSUPPORTED_RULES_ENGINE_VERSION: rules_engine_version=9 (supported: 10, 11)"],
    ["a pin spelled as a string", () => outcome(board((b) => { b.rules_engine_version = "10"; })), "UNSUPPORTED_RULES_ENGINE_VERSION: rules_engine_version=\"10\" (supported: 10, 11)"],
    ["a null pin", () => outcome(board((b) => { b.rules_engine_version = null; })), "UNPINNED_BOARD: rules_engine_version=null"],
    ["a duplicate roster entry", () => outcome(board((b) => { b.player_addresses = ["p1", "p1", "p3"]; })), "DUPLICATE_ROSTER_ENTRY: p1"],
    ["a cash row for an unseated player", () => outcome(board((b) => { b.player_cash.push({ player: "p-ghost", cash_vgp: "1" }); })), "CASH_FOR_UNSEATED_PLAYER: p-ghost"],
    ["cash as a bigint (not JSON data: refused before any field is read)", () => outcome(board((b) => { cashRow(b, "p1").cash_vgp = BigInt(640); })), "STATE_NOT_HASHABLE: $.player_cash[0].cash_vgp is a bigint"],
    ["cash with whitespace", () => outcome(board((b) => { cashRow(b, "p1").cash_vgp = " 640"; })), "MALFORMED_AMOUNT: cash_vgp[p1]=\" 640\""],
    ["cash in hex", () => outcome(board((b) => { cashRow(b, "p1").cash_vgp = "0x280"; })), "MALFORMED_AMOUNT: cash_vgp[p1]=\"0x280\""],
    ["an empty cash string", () => outcome(board((b) => { cashRow(b, "p1").cash_vgp = ""; })), "MALFORMED_AMOUNT: cash_vgp[p1]=\"\""],
    ["a -0 percentage (read as the 0 the hash commits to)", () => outcome(board((b) => { holding(b, "PRR", "p1").percentage = -0; })), "MALFORMED_PERCENT: PRR.holding[p1]=0"],
    ["a percentage above 100 in one row", () => outcome(board((b) => { holding(b, "PRR", "p1").percentage = 110; })), "MALFORMED_PERCENT: PRR.holding[p1]=110"],
    ["an unsafe percentage", () => outcome(board((b) => { holding(b, "PRR", "p1").percentage = 2 ** 60; })), `MALFORMED_INTEGER: PRR.holding[p1]=${2 ** 60}`],
    ["an IPO pile that is not whole certificates", () => outcome(board((b) => { company(b, "ERIE").ipo_pool_percentage = 95; })), "MALFORMED_PERCENT: ERIE.ipo_pool_percentage=95"],
    ["a negative Bank Pool", () => outcome(board((b) => { company(b, "ERIE").bank_pool_percentage = -10; })), "MALFORMED_PERCENT: ERIE.bank_pool_percentage=-10"],
    ["holdings that are not a list", () => outcome(board((b) => { company(b, "PRR").player_holdings = {}; })), "MALFORMED_STATE: PRR.player_holdings is not an array"],
    ["a mark naming no corporation", () => outcome(board((b) => { b.market_positions["99"] = { price: 100, x: 6, y: 10, enteredAt: 1 }; })), "MALFORMED_STATE: market_positions[99] names no corporation"],
    ["a mark keyed with a leading zero", () => outcome(board((b) => { b.market_positions["01"] = b.market_positions["1"]; })), "MALFORMED_STATE: market_positions[01] names no corporation"],
    ["a mark that is not an object", () => outcome(board((b) => { b.market_positions["1"] = 100; })), "MALFORMED_STATE: market_positions[1] is not a mark"],
    ["market_positions that is an array", () => outcome(board((b) => { b.market_positions = [null, { price: 100 }]; })), "MALFORMED_STATE: market_positions is not an object"],
    ["a price spelled as a string", () => outcome(board((b) => { b.market_positions["1"].price = "100"; })), "MALFORMED_INTEGER: PRR.mark.price=100"],
    ["a negative price", () => outcome(board((b) => { b.market_positions["1"].price = -100; })), "NON_POSITIVE_PRICE: PRR=-100"],
    ["an unsafe price", () => outcome(board((b) => { b.market_positions["1"].price = 2 ** 53; })), `MALFORMED_INTEGER: PRR.mark.price=${2 ** 53}`],
    ["`closed` that is not a boolean", () => outcome(board((b) => { priv(b, 1).closed = "false"; })), "MALFORMED_STATE: private 1.closed=\"false\""],
    ["a private face of $0", () => outcome(board((b) => { priv(b, 1).cost = "0"; })), "MALFORMED_AMOUNT: private 1.cost=\"0\" (a face value is positive)"],
    ["an owner that is not a string", () => outcome(board((b) => { priv(b, 1).owner = 3; })), "MALFORMED_STATE: private 1.owner=3"],
    ["a corporation owner that is not an integer", () => outcome(board((b) => { Object.assign(priv(b, 1), { owner: null, owner_protocol_id: "1" }); })), "MALFORMED_INTEGER: private 1.owner_protocol_id=1"],
    ["a closed private owned by an unseated player", () => outcome(board((b) => { priv(b, 6).owner = "p-ghost"; })), "PRIVATE_OWNED_BY_UNSEATED_PLAYER: 6:p-ghost"],
    ["a bankrupt president that is not a string", () => outcome(board((b) => { b.bankrupt_president = 1; })), "BANKRUPT_NOT_SEATED: 1"],
    ["an empty bankrupt president", () => outcome(board((b) => { b.bankrupt_president = ""; })), "BANKRUPT_NOT_SEATED: "],
    ["a seat that is not an object", () => outcome(board(), [{ seat_index: 0, player_id: "p2" }, "p1", { seat_index: 2, player_id: "p3" }]), "MALFORMED_STATE: seats[1] is not a seat"],
    ["a seat_index spelled as a string", () => outcome(board(), [{ seat_index: "0", player_id: "p2" }, { seat_index: 1, player_id: "p1" }, { seat_index: 2, player_id: "p3" }]), "SEAT_INDEX_NOT_CONTIGUOUS: position 0 carries seat_index \"0\""],
    ["an empty player id", () => outcome(board(), seatsOf(["", "p1", "p3"])), "MALFORMED_STATE: seats[0].player_id=\"\""],
    ["a board that is not an object", () => outcome(null as unknown as GameStateResponse), "MALFORMED_STATE: the board is not an object"],
  ];
  for (const [name, run, want] of additions) {
    it(`${name}: ${want}`, () => {
      expect(run()).toBe(want);
    });
  }

  it("a player id that collides with an Object.prototype key is an ordinary id (Map-keyed, no prototype lookups)", () => {
    const proto = board((b) => {
      b.player_addresses = ["p1", "constructor", "p3"];
      cashRow(b, "p2").player = "constructor";
      for (const c of b.public_companies) for (const row of c.player_holdings) if (row.player === "p2") row.player = "constructor";
      for (const p of b.private_companies) if (p.owner === "p2") p.owner = "constructor";
    });
    expect(baseNetWorthVector(proto, seatsOf(["constructor", "p1", "p3"])).map(String)).toEqual(["2018", "2448", "2409"]);
    expect(outcome(board(), seatsOf(["__proto__", "p1", "p3"]))).toBe("STATE_PLAYER_NOT_SEATED: p2");
  });

  it("independent review L2: a seat whose player_id answers differently on a second read cannot pay one player twice", () => {
    let reads = 0;
    const flipping = { seat_index: 0, get player_id() { return (reads += 1) === 1 ? "p2" : "p1"; } };
    const seats = [flipping, { seat_index: 1, player_id: "p1" }, { seat_index: 2, player_id: "p3" }] as unknown as SettlementSeat[];
    expect(appraiseSeats(SYN01, seats).map((seat) => seat.player_id)).toEqual(["p2", "p1", "p3"]);
    expect(reads).toBe(1);
  });

  it("independent review M2: a non-enumerable field is neither hashed nor appraised -- the board is refused", () => {
    const hidden = board();
    Object.defineProperty(hidden, "bankrupt_president", { value: "p1", enumerable: false });
    expect(outcome(hidden)).toBe("STATE_NOT_HASHABLE: $.bankrupt_president is not enumerable");
    const hiddenCash = board();
    Object.defineProperty((hiddenCash as Loose).player_cash[1], "cash_vgp", { value: "999999", enumerable: false });
    expect(outcome(hiddenCash)).toBe("STATE_NOT_HASHABLE: $.player_cash[1].cash_vgp is not enumerable");
  });

  it("an inherited field is never read: a prototype carrying bankrupt_president changes nothing (and a non-plain board is refused)", () => {
    const inherited = Object.create({ bankrupt_president: "p1" }) as Loose;
    Object.assign(inherited, JSON.parse(JSON.stringify(SYN01)));
    expect(outcome(inherited as GameStateResponse)).toBe("STATE_NOT_HASHABLE: $ is not a plain object");
  });

  it("the result is frozen: a caller cannot rewrite a total after the fact", () => {
    const seats = appraiseSeats(SYN01, SEATS);
    expect(Object.isFrozen(seats)).toBe(true);
    expect(Object.isFrozen(seats[0])).toBe(true);
    expect(Object.isFrozen(seats[0].holdings)).toBe(true);
    expect(Object.isFrozen(baseNetWorthVector(SYN01, SEATS))).toBe(true);
  });

  it("the appraiser never writes to the board it is given", () => {
    const before = JSON.stringify(SYN01);
    appraiseSeats(SYN01, SEATS);
    expect(JSON.stringify(SYN01)).toBe(before);
  });
});
