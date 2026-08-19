// frontend/src/utils/parFromMessage.test.ts
//
// ==================================================================
//  DESIGN NOTE 579 (harness): THE THIRD TIME, SO THE LAST TIME
// ==================================================================
//
// REPORTED: a corporation parred at $67 charged its founder $67 and everybody
// else $100, in the log and in the wallet — and the two players saw different
// cash totals for each other.
//
// `applySandboxAction` took the par from `ctx.parValue`, which `App.tsx`
// built from that browser's own par ladder. The acting client had the rung
// the player picked; every replaying client had an empty ladder and fell
// through to the string "100".
//
// THE REPORTER FOUND THE PROOF WITHOUT LOOKING FOR IT: the NNH "tracks
// correctly for both players". The NNH was parred at $100 — the fallback. It
// was not working, it was agreeing with the wrong answer.
//
// This is the third instance of one mistake (design note #549 the actor,
// #553 the ladder, #579 the price), so these tests are written as the RULE
// rather than as three cases: whatever the reducer needs in order to decide,
// it reads from the message, and two clients with different local state reach
// the same result.

import { applySandboxAction, type SandboxActionContext } from "./sandboxSession";
import type { GameStateResponse } from "./gameState";

const ADA = "p-ada";
const BEN = "p-ben";

function board(): GameStateResponse {
  return {
    game_id: 1,
    player_addresses: [ADA, BEN],
    active_player_index: 0,
    priority_deal_index: 0,
    current_round_type: "StockRound",
    consecutive_passes: 0,
    active_operating_order: [],
    active_corporation_index: 0,
    virtual_bank_vgp: "12000",
    player_cash: [
      { player: ADA, cash_vgp: "600" },
      { player: BEN, cash_vgp: "600" },
    ],
    public_companies: [
      {
        company_id: 7,
        ticker: "ERIE",
        president: null,
        par_value: null,
        is_floated: false,
        player_holdings: [],
        ipo_pool_percentage: 100,
        bank_pool_percentage: 0,
        treasury_vgp: "0",
        trains: [],
        station_tokens: [],
        station_token_hexes: [],
      },
    ],
    private_companies: [],
  } as unknown as GameStateResponse;
}

const found = (par: string) =>
  ({ BuyStock: { game_id: 1, protocol_id: 7, source: "Ipo", par_value: par } }) as never;

const erie = (state: GameStateResponse) =>
  state.public_companies.find((c) => c.company_id === 7)!;
const cashOf = (state: GameStateResponse, who: string) =>
  Number(state.player_cash.find((entry) => entry.player === who)?.cash_vgp ?? 0);

/** The acting client: its ladder holds the rung the player chose. */
const actingCtx = (par: number): SandboxActionContext =>
  ({ actor: ADA, parValue: par, sharePrice: par }) as SandboxActionContext;

/** A replaying client: no ladder, so the OLD code fell through to 100. */
const replayCtx = (): SandboxActionContext =>
  ({ actor: ADA, parValue: 100, sharePrice: 100 }) as SandboxActionContext;

describe("the par comes from the message", () => {
  it("records the par the buyer actually chose", () => {
    expect(erie(applySandboxAction(board(), found("67"), actingCtx(67))).par_value).toBe("67");
  });

  it("records it identically on a client whose ladder says otherwise", () => {
    /* THE REPORTED BUG, in one assertion. The replaying client's context
       carries 100 -- exactly what the empty-ladder fallback produced -- and
       the result must still be 67, because 67 is what the log says. */
    expect(erie(applySandboxAction(board(), found("67"), replayCtx())).par_value).toBe("67");
  });

  it("charges the same price on both clients", () => {
    /* The cash half of the report: "the Action bar showed P1 with $0 and P2
       with $205 on P2's screen, but P1 with $12 and P2 with $232 on P1's". */
    const acting = applySandboxAction(board(), found("67"), actingCtx(67));
    const replayed = applySandboxAction(board(), found("67"), replayCtx());
    expect(cashOf(replayed, ADA)).toBe(cashOf(acting, ADA));
    expect(replayed.player_cash).toEqual(acting.player_cash);
  });

  it("reaches the same state from any local context at all", () => {
    /* THE RULE, stated as a property. The context may differ per browser for
       legitimate reasons; the result may not. */
    const contexts = [actingCtx(67), replayCtx(), {} as SandboxActionContext];
    const results = contexts.map((ctx) => applySandboxAction(board(), found("67"), ctx));
    for (const result of results.slice(1)) {
      expect(erie(result).par_value).toBe(erie(results[0]).par_value);
      expect(result.player_cash).toEqual(results[0].player_cash);
    }
  });

  it("does not look like it works when the par happens to be 100", () => {
    /* The NNH case. A test that only ever parred at 100 would have passed
       against the broken code, which is why this one is here: it asserts the
       agreement AND that 100 is not special. */
    const atFallback = applySandboxAction(board(), found("100"), replayCtx());
    const atSomethingElse = applySandboxAction(board(), found("82"), replayCtx());
    expect(erie(atFallback).par_value).toBe("100");
    expect(erie(atSomethingElse).par_value).toBe("82");
    expect(cashOf(atSomethingElse, ADA)).toBeGreaterThan(cashOf(atFallback, ADA));
  });

  it("leaves a par already set alone", () => {
    // Only the FOUNDING purchase names a price. A later buy must not repar.
    const started = applySandboxAction(board(), found("67"), actingCtx(67));
    const later = applySandboxAction(started, found("100"), replayCtx());
    expect(erie(later).par_value).toBe("67");
  });
});
