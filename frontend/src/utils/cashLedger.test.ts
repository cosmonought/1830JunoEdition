/** @jest-environment node */
// frontend/src/utils/cashLedger.test.ts -- design note #1560 (Batch 7.1).
//
// ==================================================================
//  WHAT THIS FILE IS PINNING
// ==================================================================
//
// The three helpers this ledger replaced all ended `Math.max(0, current + delta)`, and every case below is a
// thing that clamp did silently: it minted the difference on an unaffordable debit, it absorbed a credit that
// had no payee, it ran a negative "debit" backwards, and it made the bank's balance a fiction the moment the
// bank ran out. The assertions are one per failure mode, plus the arithmetic that makes the conservation
// harness meaningful.
//
// REFUSAL IS A VALUE. Not one function here throws; `RoomSession.submit` appends before it applies, so a
// throw inside a money movement would leave a durable log entry that crashes every rebuild after it. The one
// function that does throw is `assertMoneyConserved`, which is a test instrument and is never called by the
// reducer.

import {
  BANK,
  assertMoneyConserved,
  bankFundsOf,
  creditBank,
  creditPlayer,
  creditTreasury,
  debitBank,
  debitPlayer,
  debitTreasury,
  moneyConservationBreach,
  moneyTotal,
  playerCashOf,
  transfer,
  treasuryOf,
} from "../gameEngine/cashLedger";
import { bankIsBroken } from "../gameEngine/endgame";
import type { GameStateResponse } from "../gameEngine/gameState";

const board = (over: Partial<GameStateResponse> = {}): GameStateResponse =>
  ({
    virtual_bank_vgp: "1000",
    player_cash: [
      { player: "p1", cash_vgp: "100" },
      { player: "p2", cash_vgp: "0" },
    ],
    public_companies: [
      { company_id: 1, ticker: "PRR", treasury: "200" },
      { company_id: 2, ticker: "NYC", treasury: "0" },
    ],
    private_companies: [],
    ...over,
  }) as unknown as GameStateResponse;

/** The state a result carries, or a thrown failure naming the refusal -- so a test that expected success
 *  fails with the reducer's own sentence rather than with `undefined is not an object`. */
const applied = (result: ReturnType<typeof transfer>): GameStateResponse => {
  if (!result.ok) throw new Error(`expected the movement to be made: ${result.reason}`);
  return result.state;
};

describe("reading the three kinds of balance", () => {
  it("answers cash, treasury and bank", () => {
    const state = board();
    expect(playerCashOf(state, "p1")).toBe(100);
    expect(treasuryOf(state, 1)).toBe(200);
    expect(bankFundsOf(state)).toBe(1000);
  });

  it("answers null for an account this board has never heard of", () => {
    /* NULL IS NOT ZERO, and `gameState.ts` 943 takes the same line. The distinction is the whole of the
       missing-payee bug: a player with no record is not a player with nothing, so paying him is not paying
       zero -- it is paying nobody, which is how money left the game (S7-12). */
    const state = board();
    expect(playerCashOf(state, "nobody")).toBeNull();
    expect(treasuryOf(state, 99)).toBeNull();
  });
});

describe("an amount is a whole, non-negative number of VGP", () => {
  it("refuses a fraction", () => {
    const refusal = debitPlayer(board(), "p1", 10.5);
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toContain("whole number");
  });

  it("refuses a negative amount rather than running the movement backwards", () => {
    /* S7-12, exactly: `BuyPrivateCompany` with `price: "-500"` paid the BUYER $500 and floored the seller to
       zero, because a negative delta through `adjustTreasury` is a credit. Direction belongs to the function
       that is called, never to the sign of the amount. */
    const refusal = debitPlayer(board(), "p1", -500);
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toContain("may not be negative");
    const credit = creditTreasury(board(), 1, -500);
    expect(credit.ok).toBe(false);
  });

  it("refuses NaN and Infinity", () => {
    expect(debitBank(board(), Number.NaN).ok).toBe(false);
    expect(creditBank(board(), Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it("reads an unreadable bank balance as zero, and does not latch a break it cannot know about", () => {
    /* THE ONE LENIENT CASE. A player or a treasury with no readable balance refuses -- it cannot answer "can
       you cover this". The bank is never asked that (it pays past zero), so an unreadable balance is read as
       $0, exactly as the retired `adjustBank` read it: every hand-built fixture that omits the field keeps
       behaving as it did, and the arithmetic still conserves, because `moneyTotal` skips a non-finite bank
       and "skipped" and "zero" are the same number on both sides. The LATCH is withheld, on #232's rule: a
       board that never said what the bank held cannot be said to have run out of it. */
    const bankless = board({ virtual_bank_vgp: undefined } as unknown as Partial<GameStateResponse>);
    expect(bankFundsOf(bankless)).toBeNull();
    const paid = applied(debitBank(bankless, 30));
    expect(paid.virtual_bank_vgp).toBe("-30");
    expect("bank_broken" in paid).toBe(false);
    const received = applied(creditBank(bankless, 30));
    expect(received.virtual_bank_vgp).toBe("30");
    // The movement still conserves: a skipped bank and a zero bank are the same total.
    assertMoneyConserved(bankless, applied(transfer(bankless, { player: "p1" }, BANK, 60)));
  });

  it("allows exactly zero, which moves nothing", () => {
    // The $0 Schuylkill Valley acquisition is a real, legal movement of no money (#271).
    const state = board();
    const after = applied(transfer(state, { player: "p1" }, BANK, 0));
    expect(playerCashOf(after, "p1")).toBe(100);
    expect(bankFundsOf(after)).toBe(1000);
  });
});

describe("a debit the account cannot cover refuses; it does not floor", () => {
  it("refuses a player debit and leaves the board alone", () => {
    const state = board();
    const refusal = debitPlayer(state, "p1", 180);
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toBe("p1 holds $100 and cannot pay $180.");
    // The old clamp took the $100 and credited the payee $180: $80 out of nothing.
    expect(playerCashOf(state, "p1")).toBe(100);
  });

  it("refuses a treasury debit", () => {
    const refusal = debitTreasury(board(), 2, 1);
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toContain("NYC's treasury holds $0");
  });

  it("allows a debit that empties the account exactly", () => {
    const after = applied(debitPlayer(board(), "p1", 100));
    expect(playerCashOf(after, "p1")).toBe(0);
  });

  it("refuses a debit from, or a credit to, an account that is not on the board", () => {
    expect(debitPlayer(board(), "ghost", 5).ok).toBe(false);
    expect(creditPlayer(board(), "ghost", 5).ok).toBe(false);
    expect(creditTreasury(board(), 99, 5).ok).toBe(false);
  });
});

describe("the bank is signed, and the break is latched (S7-20, D-15)", () => {
  it("pays past zero rather than flooring, and latches", () => {
    const after = applied(debitBank(board({ virtual_bank_vgp: "10" }), 30));
    expect(after.virtual_bank_vgp).toBe("-20");
    expect(after.bank_broken).toBe(true);
    expect(bankIsBroken(after)).toBe(true);
  });

  it("latches at exactly zero", () => {
    // `bankIsBroken` has always been `<= 0`; the latch uses the same threshold, so the two cannot disagree.
    const after = applied(debitBank(board({ virtual_bank_vgp: "30" }), 30));
    expect(after.virtual_bank_vgp).toBe("0");
    expect(after.bank_broken).toBe(true);
  });

  it("does not latch on a debit that leaves the bank solvent", () => {
    const after = applied(debitBank(board({ virtual_bank_vgp: "31" }), 30));
    expect(after.virtual_bank_vgp).toBe("1");
    expect(after.bank_broken).toBeUndefined();
    expect(bankIsBroken(after)).toBe(false);
  });

  it("does not latch on a zero debit against a solvent bank", () => {
    /* The bank is exhausted BY A PAYOUT. A message that pays nobody is not the moment it ran out, and
       latching on it would make the field a restatement of the balance rather than a record of an event. */
    const after = applied(debitBank(board({ virtual_bank_vgp: "500" }), 0));
    expect(after.bank_broken).toBeUndefined();
  });

  it("stays latched through a further payout and through a receipt that makes it solvent again", () => {
    /* "LEAVES <= 0" IS ABOUT THE DEBIT'S RESULT, not about crossing zero in either direction: a credit that
       lifts the bank out of the negative range latches nothing and un-latches nothing. */
    const broken = applied(debitBank(board({ virtual_bank_vgp: "10" }), 30));
    const deeper = applied(debitBank(broken, 30));
    expect(deeper.virtual_bank_vgp).toBe("-50");
    expect(deeper.bank_broken).toBe(true);
    const recovered = applied(creditBank(deeper, 200));
    expect(recovered.virtual_bank_vgp).toBe("150");
    expect(recovered.bank_broken).toBe(true);
    expect(bankIsBroken(recovered)).toBe(true);
  });

  it("never writes the field on a board that has not broken", () => {
    // Absent means "the log does not say" (#232). `false` is never written, so the field joins the digest
    // only where the fact exists and every pre-Batch-7.1 fixture keeps the digest it had.
    const solvent = applied(creditBank(board(), 500));
    expect("bank_broken" in solvent).toBe(false);
  });

  it("keeps the legacy balance test for a board that carries no field", () => {
    expect(bankIsBroken(board({ virtual_bank_vgp: "0" }))).toBe(true);
    expect(bankIsBroken(board({ virtual_bank_vgp: "-5" }))).toBe(true);
    expect(bankIsBroken(board({ virtual_bank_vgp: "1" }))).toBe(false);
    expect(bankIsBroken(null)).toBe(false);
  });

  /* ==================================================================
      A CREDIT MAY NOT UN-BREAK A LEGACY BOARD (review point 2)
     ==================================================================
     On a board dealt after Batch 7.1 the latch is already set, so "credits never un-latch" is trivially
     true. On a LEGACY board the ONLY record of the break is the balance -- and a credit overwrites exactly
     that. Without `withBankBalance`'s carry-forward, `bankIsBroken` answered `true` before the receipt and
     `false` after it, which is D-15's promise holding for new boards and quietly failing for every stored
     one. The field is materialised on the way past: not a new break, the same answer made durable. */
  it("materialises the latch when a credit lands on a legacy board that is already broken", () => {
    const legacy = board({ virtual_bank_vgp: "-20" });
    expect("bank_broken" in legacy).toBe(false);
    expect(bankIsBroken(legacy)).toBe(true);

    const after = applied(creditBank(legacy, 100));
    expect(after.virtual_bank_vgp).toBe("80");
    expect(after.bank_broken).toBe(true);
    expect(bankIsBroken(after)).toBe(true);
  });

  it("does the same for a legacy board sitting at exactly zero", () => {
    const legacy = board({ virtual_bank_vgp: "0" });
    expect(bankIsBroken(legacy)).toBe(true);
    const after = applied(creditBank(legacy, 100));
    expect(after.virtual_bank_vgp).toBe("100");
    expect(after.bank_broken).toBe(true);
    expect(bankIsBroken(after)).toBe(true);
  });

  it("carries the break through a transfer into the bank, not only a bare credit", () => {
    // Every ordinary receipt -- a share bought, a train bought, a token placed -- arrives as a `transfer`.
    const legacy = board({ virtual_bank_vgp: "-20" });
    const after = applied(transfer(legacy, { player: "p1" }, BANK, 100));
    expect(after.virtual_bank_vgp).toBe("80");
    expect(after.bank_broken).toBe(true);
    expect(bankIsBroken(after)).toBe(true);
  });

  it("still writes nothing on a solvent legacy board", () => {
    // The carry-forward must not turn "no field" into "broken" for a bank that never ran out.
    const after = applied(creditBank(board({ virtual_bank_vgp: "1" }), 100));
    expect("bank_broken" in after).toBe(false);
    expect(bankIsBroken(after)).toBe(false);
  });

  it("still writes nothing when the bank's balance is unreadable", () => {
    /* `bankIsBroken` requires a finite number, so an absent balance is not "broken" and the carry-forward
       does not fire -- the lenient case above is unchanged. */
    const bankless = board({ virtual_bank_vgp: undefined } as unknown as Partial<GameStateResponse>);
    const after = applied(creditBank(bankless, 100));
    expect(after.virtual_bank_vgp).toBe("100");
    expect("bank_broken" in after).toBe(false);
  });
});

describe("a transfer is one debit and its matching credit, or nothing at all", () => {
  it("moves money between two accounts and conserves the total", () => {
    const before = board();
    const after = applied(transfer(before, { player: "p1" }, BANK, 60));
    expect(playerCashOf(after, "p1")).toBe(40);
    expect(bankFundsOf(after)).toBe(1060);
    assertMoneyConserved(before, after);
  });

  it("moves money between a treasury and a player", () => {
    const before = board();
    const after = applied(transfer(before, { corporation: 1 }, { player: "p2" }, 150));
    expect(treasuryOf(after, 1)).toBe(50);
    expect(playerCashOf(after, "p2")).toBe(150);
    assertMoneyConserved(before, after);
  });

  it("takes nothing from the payer when the payee does not exist", () => {
    /* ATOMICITY, asserted rather than asserted-in-a-comment: the debited board is a local value inside
       `transfer`, so a refused credit hands the caller back nothing at all. There is no half-moved money
       anywhere in this engine, which is the property that makes the conservation sweep meaningful. */
    const before = board();
    const refusal = transfer(before, { corporation: 1 }, { player: "ghost" }, 150);
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toContain("nothing was taken from corporation 1");
    expect(treasuryOf(before, 1)).toBe(200);
  });

  it("refuses the whole movement when the payer is short", () => {
    const refusal = transfer(board(), { player: "p2" }, BANK, 1);
    expect(refusal.ok).toBe(false);
  });

  it("treats a movement between an account and itself as a no-op", () => {
    // It netted to zero under the old adjusters too; whether the two ends MAY be the same is a rule
    // (Batch 7.4/7.5's predicates), not arithmetic.
    const before = board();
    const after = applied(transfer(before, { corporation: 1 }, { corporation: 1 }, 5000));
    expect(treasuryOf(after, 1)).toBe(200);
    assertMoneyConserved(before, after);
  });

  it("latches the break when the bank is the payer", () => {
    const after = applied(transfer(board({ virtual_bank_vgp: "10" }), BANK, { player: "p1" }, 30));
    expect(after.virtual_bank_vgp).toBe("-20");
    expect(after.bank_broken).toBe(true);
    expect(playerCashOf(after, "p1")).toBe(130);
  });
});

describe("the conservation harness", () => {
  it("totals the bank, every player and every treasury, and nothing else", () => {
    // Auction bids are ESCROWED rather than spent (the bid list is the escrow, #334a), so no money is held
    // anywhere this sum cannot see.
    expect(moneyTotal(board())).toBe(1000 + 100 + 0 + 200 + 0);
  });

  it("counts a negative bank as the debt it is", () => {
    expect(moneyTotal(board({ virtual_bank_vgp: "-20" }))).toBe(280);
  });

  it("says nothing when the total is unchanged and names the delta when it is not", () => {
    const before = board();
    expect(moneyConservationBreach(before, applied(transfer(before, { player: "p1" }, BANK, 60)))).toBeNull();
    const minted = board({ virtual_bank_vgp: "1090" });
    expect(moneyConservationBreach(before, minted)).toBe(
      "Money on the table changed by +$90: $1300 before, $1390 after.",
    );
  });

  it("throws from the assertion, and only from the assertion", () => {
    const before = board();
    expect(() => assertMoneyConserved(before, board({ virtual_bank_vgp: "900" }), "idx 12")).toThrow(
      /idx 12: Money on the table changed by -\$100/,
    );
    expect(() => assertMoneyConserved(before, board())).not.toThrow();
  });
});
