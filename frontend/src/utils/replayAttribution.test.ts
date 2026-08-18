// frontend/src/utils/replayAttribution.test.ts
//
// THE REDUCER MUST BE A FUNCTION OF THE LOG, AND ONLY OF THE LOG.
//
// ==================================================================
//  DESIGN NOTE 549 (harness): THE SAME LOG MUST GIVE THE SAME GAME
// ==================================================================
//
// REPORTED: Player 2 bought a president's certificate and it never appeared
// on Player 1's screen.
//
// `applySandboxAction` resolved the acting player as
// `state.player_addresses[state.active_player_index]` -- the turn cursor on
// whichever machine was doing the applying. One client, that is correct by
// definition. Several clients replaying one log, it means the reducer is not
// a function of the log: feed the same message to two clients whose cursors
// differ and they credit two different players, silently, forever after.
//
// These tests are deliberately written as DIVERGENCE tests rather than as
// "does the actor argument work" tests. The bug was never that the parameter
// was wrong; it was that state the log does not control was allowed to
// decide the outcome. So each case below hands the same message to two
// states that disagree about the cursor and asserts they still agree about
// the result -- which is the actual property, and the only one that would
// have caught this.

import {
  applySandboxAction,
  type SandboxActionContext,
} from "./sandboxSession";
import type { GameStateResponse } from "./gameState";
import {
  isOpenStockRoundMsg,
  isPlaceHomeStationMsg,
  isSandboxOnlyMsg,
  isSetBoParMsg,
  isSetupGameMsg,
} from "./gameSetup";

const ADA = "p-ada";
const BEN = "p-ben";

function state(activeIndex: number): GameStateResponse {
  return {
    game_id: 1,
    player_addresses: [ADA, BEN],
    active_player_index: activeIndex,
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
        ticker: "C&O",
        president: null,
        par_value: null,
        is_floated: false,
        player_holdings: [],
        ipo_shares_remaining: 10,
        bank_pool_shares: 0,
        treasury_vgp: "0",
        trains: [],
        station_tokens: [],
      },
    ],
    private_companies: [],
  } as unknown as GameStateResponse;
}

const buyPresidency = {
  BuyStock: { game_id: 1, protocol_id: 7, source: "Ipo", par_value: "100" },
} as never;

const ctx = (actor?: string | null): SandboxActionContext =>
  ({ actor, parValue: 100 }) as SandboxActionContext;

function presidentOf(next: GameStateResponse): string | null {
  return next.public_companies.find((c) => c.company_id === 7)?.president ?? null;
}

describe("replay attribution", () => {
  it("credits the log's author, not the local cursor", () => {
    /* THE REPORTED BUG. Ben's purchase, replayed on a client whose cursor
       still points at Ada. Before the fix this made Ada president. */
    const next = applySandboxAction(state(0), buyPresidency, ctx(BEN));
    expect(presidentOf(next)).toBe(BEN);
  });

  it("reaches the same result from two disagreeing cursors", () => {
    /* THE PROPERTY, stated directly: the cursor is not an input. If this
       ever fails, two browsers are running two different games off one log
       and the first symptom will surface somewhere unrelated. */
    const fromAdasClient = applySandboxAction(state(0), buyPresidency, ctx(BEN));
    const fromBensClient = applySandboxAction(state(1), buyPresidency, ctx(BEN));
    expect(presidentOf(fromAdasClient)).toBe(presidentOf(fromBensClient));
    expect(fromAdasClient.player_cash).toEqual(fromBensClient.player_cash);
  });

  it("charges the author's wallet, not the seat on turn's", () => {
    // The half that would have quietly bankrupted the wrong player.
    const next = applySandboxAction(state(0), buyPresidency, ctx(BEN));
    const cashOf = (who: string) =>
      Number(next.player_cash.find((entry) => entry.player === who)?.cash_vgp ?? 0);
    expect(cashOf(ADA)).toBe(600);
    expect(cashOf(BEN)).toBeLessThan(600);
  });

  it("falls back to the turn cursor when no author is supplied", () => {
    /* Solo sandbox has no log and no author, and the cursor is the right
       answer there. `undefined` must not mean "nobody". */
    expect(presidentOf(applySandboxAction(state(0), buyPresidency, ctx()))).toBe(ADA);
    expect(presidentOf(applySandboxAction(state(1), buyPresidency, ctx()))).toBe(BEN);
  });

  it("treats an explicit null author as nobody, not as the cursor", () => {
    /* Design note #549b. A caller that has deliberately said "no actor"
       must not be silently upgraded to the seat on turn -- that is the same
       inference this whole note exists to remove, reappearing as a
       fallback. */
    const next = applySandboxAction(state(0), buyPresidency, ctx(null));
    expect(presidentOf(next)).toBeNull();
  });

  it("ignores an author who is not at the table", () => {
    /* NOT HYPOTHETICAL. Entries written before design note #549a recorded
       the player's NICKNAME, so every room already in Firestore replays
       with authors that match no seat. Resolving those against the local
       cursor would reproduce the original bug from stored data. */
    const next = applySandboxAction(state(0), buyPresidency, ctx("Ada"));
    expect(presidentOf(next)).toBeNull();
  });

  it("resolves a stale author identically on disagreeing clients", () => {
    // The property again, this time for the data that cannot be fixed.
    const a = applySandboxAction(state(0), buyPresidency, ctx("Ada"));
    const b = applySandboxAction(state(1), buyPresidency, ctx("Ada"));
    expect(presidentOf(a)).toBe(presidentOf(b));
    expect(a.player_cash).toEqual(b.player_cash);
  });
});

/* ------------------------------------------------------------------ */
/* Design note #550: which events must never reach the chain           */
/* ------------------------------------------------------------------ */

describe("sandbox-only log events", () => {
  const setup = { SetupGame: { players: [] } };
  const open = { OpenStockRound: {} };
  const par = { SetBoPar: { player: ADA, par_value: "100" } };
  const token = {
    PlaceHomeStation: { company_id: 7, q: 0, r: 0, kind: "home", hex_label: "B12" },
  };

  it("recognises each of the four", () => {
    expect(isSetupGameMsg(setup)).toBe(true);
    expect(isOpenStockRoundMsg(open)).toBe(true);
    expect(isSetBoParMsg(par)).toBe(true);
    expect(isPlaceHomeStationMsg(token)).toBe(true);
  });

  it("refuses all of them at the chain boundary", () => {
    /* Design note #539: the ONE predicate the `execGameplay` call site
       consults. A fifth event added to the union and forgotten here would
       be sent to a contract that has never heard of it -- which is the
       exact failure that note records, and the reason this is one function
       rather than a chain of `||` at the call site. */
    for (const msg of [setup, open, par, token]) {
      expect(isSandboxOnlyMsg(msg)).toBe(true);
    }
  });

  it("lets real contract messages through", () => {
    expect(isSandboxOnlyMsg(buyPresidency)).toBe(false);
    expect(isSandboxOnlyMsg({ PassTurn: { game_id: 1 } })).toBe(false);
  });

  it("does not mistake a lookalike for one", () => {
    // Membership is by key, so a message merely CONTAINING the word must
    // not qualify.
    expect(isSandboxOnlyMsg({ SetupGameLater: {} })).toBe(false);
    expect(isSandboxOnlyMsg(null)).toBe(false);
    expect(isSandboxOnlyMsg("SetupGame")).toBe(false);
  });
});
