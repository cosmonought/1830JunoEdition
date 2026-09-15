/** @jest-environment node */
// frontend/src/utils/bankBreakLatch.test.ts -- design note #1561 (Batch 7.1, ledger item S7-20).
//
// ==================================================================
//  THE BANK BREAKS ONCE. IT DOES NOT UN-BREAK.
// ==================================================================
//
// `bankIsBroken` was `virtual_bank_vgp <= 0` and was asked in exactly one place -- `settleRoundTransitions`,
// in the `operating_round_just_ended` branch (#898). So the ending was RE-DERIVED at the set boundary from a
// balance that had moved on in the meantime: a bank a payout emptied in the middle of an Operating Round set
// and the same set's share, train and token purchases refilled was solvent when the question was finally
// put, and the game played on for ever. The owner's own example is the first case below.
//
// `bankBreakEnding.test.ts` pins the #898 TIMING -- which set ends the game -- and is untouched. This file
// pins the FACT: that the break is recorded where it happens, that nothing in ordinary play clears it, and
// that a `RevertTo` past the payout removes it for the only acceptable reason, which is that the rebuilt
// game never reached it.
//
// EVERY CASE GOES THROUGH `applySandboxAction`. The latch is written by a ledger call inside a reducer arm,
// so a test that wrote `bank_broken` by hand would pin the field and not the mechanism.

import { entriesFromExport, replayLog, type ExportedEntry } from "../gameEngine/replayLog";
import { DEVELOPMENT_CORPUS_POLICY } from "../gameEngine/rulesVersion";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { applySandboxAction, operatingRoundSequenceLength } from "../gameEngine/sandboxSession";
import { bankIsBroken } from "../gameEngine/endgame";
import { moneyTotal } from "../gameEngine/cashLedger";
import { readStripped } from "./sourceScan";
import type { GameStateResponse } from "../gameEngine/gameState";

/** The same derivation `bankBreakEnding.test.ts` uses: a Phase-4 set is two Operating Rounds long, so the
 *  boundary is a function of the fixture's own fleet rather than a typed-in `1`. */
const LAST_OR_OF_SET = operatingRoundSequenceLength({
  public_companies: [{ company_id: 1, owned_trains: ["4"] }],
} as unknown as GameStateResponse);

/** One corporation on the last Operating Round of its set, wholly owned by p1, with a $30 run filed.
 *
 *  `operating_sub_phase` IS DELIBERATELY ABSENT: `dividendGate` lets an unknown cursor through (a seeded or
 *  legacy state can arrive without one), which is what lets this fixture declare its dividend without first
 *  walking the whole Operating Round. The rule under test is the bank's, not the cursor's. */
const operating = (over: Partial<GameStateResponse> = {}): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    active_operating_order: [1],
    active_corporation_index: 0,
    sub_round_index: LAST_OR_OF_SET,
    macro_round_number: 3,
    virtual_bank_vgp: "10",
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "0" },
      { player: "p2", cash_vgp: "100" },
    ],
    priority_deal_index: 0,
    active_player_index: 0,
    consecutive_passes: 0,
    private_companies: [],
    public_companies: [
      {
        company_id: 1,
        ticker: "PRR",
        is_floated: true,
        president: "p1",
        treasury: "500",
        owned_trains: ["4"],
        last_route_revenue: "30",
        player_holdings: [{ player: "p1", percentage: 100 }],
        bank_pool_percentage: 0,
        ipo_pool_percentage: 100,
        par_value: "100",
        station_token_hexes: [],
        station_tokens: [],
      },
    ],
    ...over,
  }) as unknown as GameStateResponse;

/** The $30 payout: a real dividend declaration, through the arm that funds it from the bank. */
const payDividend = (state: GameStateResponse) =>
  applySandboxAction(state, {
    DeclareDividends: { game_id: 0, protocol_id: 1, distribute: true, revenue_amount: "30" },
  } as never);

/** The $100 receipt: p2 buys PRR's $100 IPO share, which pays the bank.
 *
 *  ==================================================================
 *   BATCH 7.2 (#1570): THE RECEIPT HAPPENS WHERE A SHARE MAY BE BOUGHT
 *  ==================================================================
 *  A share purchase is a Stock Round action (rulebook §5.0, S7-13), and until Batch 7.2 this engine accepted
 *  one in an Operating Round -- which is what this helper was quietly relying on. THE RULE UNDER TEST IS THE
 *  BANK'S, not the calendar's: what the latch needs is a $100 credit reaching the bank between the payout
 *  that broke it and the set boundary that ends the game. So the purchase is applied with the round set to
 *  the one it belongs in and the calendar restored afterwards, and every assertion in this file -- the
 *  balance, the latch, the conservation, the ending -- is unchanged.
 *
 *  The design's own regression (a) (§7.1a) spells this receipt as "a $100 train purchase", which needs a
 *  depot, a tier, a limit and a step to be true of the fixture; the share keeps the arithmetic identical and
 *  the fixture one board long. */
const buyShare = (state: GameStateResponse) => {
  const bought = applySandboxAction(
    { ...state, current_round_type: "StockRound" } as GameStateResponse,
    { BuyStock: { game_id: 0, protocol_id: 1, source: "Ipo", par_value: "100", certificate: "single" } } as never,
    { actor: "p2" },
  );
  return {
    ...bought,
    current_round_type: state.current_round_type,
    sub_round_index: state.sub_round_index,
    macro_round_number: state.macro_round_number,
  } as GameStateResponse;
};

const endTurn = (state: GameStateResponse) =>
  applySandboxAction(state, { PassTurn: { game_id: 0 } } as never);

describe("the required regression: a bank that empties and refills still ends the game", () => {
  it("bank $10 -> pays $30 -> -$20 and latched -> receives $100 -> $80 and still latched -> GameEnd", () => {
    const start = operating({ virtual_bank_vgp: "10" });
    expect(bankIsBroken(start)).toBe(false);

    const broke = payDividend(start);
    expect(broke.virtual_bank_vgp).toBe("-20");
    expect(broke.bank_broken).toBe(true);
    expect(bankIsBroken(broke)).toBe(true);

    const recovered = buyShare(broke);
    expect(recovered.virtual_bank_vgp).toBe("80");
    /* THE WHOLE POINT. A solvent balance and a broken bank, at the same time, on the same board -- which is
       the state the old predicate could not represent and therefore could not end a game from. */
    expect(recovered.bank_broken).toBe(true);
    expect(bankIsBroken(recovered)).toBe(true);

    const after = endTurn(recovered);
    expect(after.current_round_type).toBe("GameEnd");
  });

  it("would have played on without the latch (the defect, stated as a control)", () => {
    /* The same board WITHOUT the field: the old rule reads a bank at $80 and sees nothing wrong, which is
       exactly the game that never ended. Stated here so the regression above cannot be read as pinning a
       coincidence. */
    const recovered = buyShare(payDividend(operating({ virtual_bank_vgp: "10" })));
    const { bank_broken: _latched, ...unlatched } = recovered;
    expect(bankIsBroken(unlatched as GameStateResponse)).toBe(false);
    expect(endTurn(unlatched as GameStateResponse).current_round_type).toBe("StockRound");
  });

  it("conserves money across the break and the recovery", () => {
    /* The signed bank is what makes this arithmetic checkable at all: under the old floor the $30 payout from
       a $10 bank paid $30 and debited $10, and the table was $20 richer for it. */
    const start = operating({ virtual_bank_vgp: "10" });
    const broke = payDividend(start);
    const recovered = buyShare(broke);
    expect(moneyTotal(start)).toBe(moneyTotal(broke));
    expect(moneyTotal(broke)).toBe(moneyTotal(recovered));
  });
});

describe("what latches, and what does not", () => {
  it("latches on a payout that leaves the bank at exactly zero", () => {
    const after = payDividend(operating({ virtual_bank_vgp: "30" }));
    expect(after.virtual_bank_vgp).toBe("0");
    expect(after.bank_broken).toBe(true);
    expect(endTurn(after).current_round_type).toBe("GameEnd");
  });

  it("does not latch on a payout the bank can afford", () => {
    const after = payDividend(operating({ virtual_bank_vgp: "31" }));
    expect(after.virtual_bank_vgp).toBe("1");
    expect(after.bank_broken).toBeUndefined();
    expect(endTurn(after).current_round_type).toBe("StockRound");
  });

  it("stays latched through a further payout that drives it deeper", () => {
    const broke = payDividend(operating({ virtual_bank_vgp: "10" }));
    const deeper = payDividend({ ...broke, operating_sub_phase: undefined } as GameStateResponse);
    expect(deeper.virtual_bank_vgp).toBe("-50");
    expect(deeper.bank_broken).toBe(true);
  });

  it("stays latched through a receipt, and through several", () => {
    /* NO CREDIT ANYWHERE CLEARS IT. "Leaves <= 0" is a claim about a debit's result, never about a balance
       moving upward out of the negative range. */
    const broke = payDividend(operating({ virtual_bank_vgp: "10" }));
    const once = buyShare(broke);
    const twice = buyShare(once); // #1570: p2 is out of cash by now, so this receipt is refused and the bank stands
    expect(Number(twice.virtual_bank_vgp)).toBeGreaterThan(0);
    expect(twice.bank_broken).toBe(true);
    expect(bankIsBroken(twice)).toBe(true);
  });
});

describe("a legacy board that carries no field is judged the way it always was", () => {
  it("is broken on a non-positive balance and solvent above it", () => {
    /* #232: absent means "the log does not say". Every fixture, every stored log and every board written
       before this batch carries no `bank_broken`, and the balance test is exactly the rule they were played
       under -- so nothing about them changes. */
    const empty = operating({ virtual_bank_vgp: "0" });
    expect("bank_broken" in empty).toBe(false);
    expect(bankIsBroken(empty)).toBe(true);
    expect(endTurn(empty).current_round_type).toBe("GameEnd");

    const solvent = operating({ virtual_bank_vgp: "4000" });
    expect(bankIsBroken(solvent)).toBe(false);
    expect(endTurn(solvent).current_round_type).toBe("StockRound");
  });

  it("does not acquire the field merely by being played on", () => {
    const after = buyShare(operating({ virtual_bank_vgp: "4000" }));
    expect("bank_broken" in after).toBe(false);
  });
});

describe("a legacy board that is already broken is not un-broken by a receipt (review point 2)", () => {
  /* ==================================================================
      THE PROMISE HAS TO HOLD FOR THE BOARDS THAT PREDATE THE FIELD
     ==================================================================
     D-15 says bank credits never un-latch a break. On a board dealt after Batch 7.1 that is trivially true --
     the latch is set and a credit does not touch it. On a LEGACY board the only record of the break is the
     BALANCE, and a credit overwrites exactly that: bank -$20 with no field is broken by the fallback test,
     and a $100 receipt used to leave a board at $80 that answered `bankIsBroken` false. The break had been
     erased by the receipt that ended it.

     `cashLedger.withBankBalance` now materialises the field whenever the board was already broken before the
     write. That is not a reinterpretation: `bankIsBroken` answered `true` before the receipt and answers
     `true` after it. What changed is that the answer survives. No stored log is affected -- no bank in the
     corpus ever reaches zero -- so this is S7-20's own invariant made true for the legacy population, not a
     new replay rule. */
  it("bank -$20 with no latch -> receives $100 -> bank $80, latched, and the set still ends the game", () => {
    const legacy = operating({ virtual_bank_vgp: "-20" });
    expect("bank_broken" in legacy).toBe(false);
    expect(bankIsBroken(legacy)).toBe(true);

    const after = buyShare(legacy);
    expect(after.virtual_bank_vgp).toBe("80");
    expect(after.bank_broken).toBe(true);
    expect(bankIsBroken(after)).toBe(true);
    expect(endTurn(after).current_round_type).toBe("GameEnd");
  });

  it("does the same from exactly zero", () => {
    const legacy = operating({ virtual_bank_vgp: "0" });
    expect(bankIsBroken(legacy)).toBe(true);
    const after = buyShare(legacy);
    expect(after.virtual_bank_vgp).toBe("100");
    expect(after.bank_broken).toBe(true);
    expect(endTurn(after).current_round_type).toBe("GameEnd");
  });

  it("is what the old behaviour got wrong (the control)", () => {
    /* The same receipt with the materialisation stripped: a solvent balance, no field, and a game that plays
       on for ever. Stated so the two cases above cannot be read as pinning something that was already true. */
    const after = buyShare(operating({ virtual_bank_vgp: "-20" }));
    const { bank_broken: _materialised, ...erased } = after;
    expect(bankIsBroken(erased as GameStateResponse)).toBe(false);
    expect(endTurn(erased as GameStateResponse).current_round_type).toBe("StockRound");
  });

  it("does not invent a break on a solvent legacy board", () => {
    const after = buyShare(operating({ virtual_bank_vgp: "4000" }));
    expect("bank_broken" in after).toBe(false);
    expect(endTurn(after).current_round_type).toBe("StockRound");
  });
});

describe("RevertTo past the breaking payout rebuilds a board without the latch", () => {
  /* ==================================================================
      NOTHING SPECIAL HAPPENS FOR REVERT, AND THAT IS THE DESIGN
     ==================================================================
     `RevertTo { index }` is an instruction about the LOG, resolved by `effectiveActions` before the reducer
     sees any history (#1026). The latch is a state field written by an arm, so a log that stops before the
     payout rebuilds a board that never reached the arm that writes it. There is no un-latching code, no
     `bank_broke_at` to compare, and no revert-specific branch anywhere -- replay is the source of truth. */
  const seedFor = (bank: string) => ({ state: operating({ virtual_bank_vgp: bank }), waterfall: null });
  const entry = (index: number, payload: object): ExportedEntry =>
    ({ index, id: `e${index}`, actor: "p1", derived: false, msg: payload }) as unknown as ExportedEntry;

  const DIVIDEND = { DeclareDividends: { game_id: 0, protocol_id: 1, distribute: true, revenue_amount: "30" } };
  const PASS = { PassTurn: { game_id: 0 } };

  const rebuild = (entries: ExportedEntry[]) =>
    replayLog(
      entriesFromExport(entries),
      sandboxReplayProviders(),
      seedFor("10"),
      undefined,
      DEVELOPMENT_CORPUS_POLICY,
    );

  it("latches when the payout is in the effective log", () => {
    const result = rebuild([entry(0, DIVIDEND)]);
    expect(result.state.bank_broken).toBe(true);
    expect(result.state.virtual_bank_vgp).toBe("-20");
  });

  it("rebuilds without the field when a RevertTo drops the payout", () => {
    const result = rebuild([
      entry(0, DIVIDEND),
      entry(1, { RevertTo: { index: 0, player: "p1", summary: "undo the dividend" } }),
    ]);
    expect("bank_broken" in result.state).toBe(false);
    expect(bankIsBroken(result.state)).toBe(false);
    expect(result.state.virtual_bank_vgp).toBe("10");
  });

  it("un-ends the game the reverted payout would have ended", () => {
    const ended = rebuild([entry(0, DIVIDEND), entry(1, PASS)]);
    expect(ended.state.current_round_type).toBe("GameEnd");

    const reverted = rebuild([
      entry(0, DIVIDEND),
      entry(1, PASS),
      entry(2, { RevertTo: { index: 0, player: "p1", summary: "undo both" } }),
      entry(3, PASS),
    ]);
    expect("bank_broken" in reverted.state).toBe(false);
    expect(reverted.state.current_round_type).toBe("StockRound");
  });
});

describe("the badge and the ending read the same predicate (U-27)", () => {
  it("App.tsx draws the badge from the shared bankIsBroken and defines no second notion", () => {
    /* U-27 records that the badge needs NO implementation of its own: it has drawn from
       `bankIsBroken(gameState)` -- the same function `settleRoundTransitions` asks -- since #898, so teaching
       that one function about the latch made the badge correct at the same instant. This assertion is what
       stops a later batch from "fixing" the badge with a second, divergent rule. */
    const app = readStripped("App.tsx");
    expect(app).toContain('from "./gameEngine/endgame"');
    expect(app).toContain("bankIsBroken(gameState)");
    expect(app).not.toContain("bank_broken");

    const reducer = readStripped("gameEngine/sandboxSession.ts");
    expect(reducer).toContain("bankIsBroken(state)");
    // The field is written in ONE place, and it is not the reducer.
    expect(reducer).not.toContain("bank_broken");
    const ledger = readStripped("gameEngine/cashLedger.ts");
    expect(ledger.match(/bank_broken: true/g)?.length).toBe(1);
  });

  it("agrees with the reducer on a latched board with a solvent balance", () => {
    // The behavioural half of the same claim: the one board where a second predicate would disagree.
    const recovered = buyShare(payDividend(operating({ virtual_bank_vgp: "10" })));
    expect(Number(recovered.virtual_bank_vgp)).toBeGreaterThan(0);
    expect(bankIsBroken(recovered)).toBe(true);
    expect(endTurn(recovered).current_round_type).toBe("GameEnd");
  });
});
