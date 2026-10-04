// frontend/src/utils/privateExchange.test.ts
//
// ==================================================================
//  DESIGN NOTE 573 (harness): A BUTTON THAT CLAIMS TO HAVE ACTED
// ==================================================================
//
// REPORTED: clicking "Exchange for PRR" greyed the button to "Used" and no
// share arrived. Same for the Mohawk & Hudson.
//
// The old implementation was `usedAbilities.add(key)` and a log line, so
// there was nothing to test and nothing that could have failed. These tests
// exist mostly to make the two halves the report separates -- what a
// SUCCESSFUL exchange must do, and what a REFUSED one must NOT do -- into
// things that can fail.
//
// The refusal half matters more. A wrong grant is visible immediately; a
// power silently burned on a refused click is a real asset destroyed, and
// the player has no way to know it should still be there.

import {
  applyPrivateExchange,
  type ExchangeGrant,
} from "../gameEngine/privateExchange";
import type { GameStateResponse } from "../gameEngine/gameState";

const ADA = "p-ada";
const BEN = "p-ben";
const MH = 4; // Mohawk & Hudson -> NYC, a genuine EXCHANGE
const CA = 5; // Camden & Amboy -> PRR, a purchase BONUS (design note #576)

/* The knobs configure the corporation the tested private TARGETS, not a
   fixed one. An earlier version hard-wired them to the PRR, so every
   Mohawk & Hudson case silently exercised an untouched NYC and passed or
   failed for reasons unrelated to what it claimed to test -- the fixture
   equivalent of the two-descriptions bug these tests exist to catch. */
function board(options: {
  owner?: string | null;
  closed?: boolean;
  held?: number;
  ipo?: number;
  pool?: number;
  privateId?: number;
} = {}): GameStateResponse {
  const {
    owner = ADA,
    closed = false,
    held = 0,
    ipo = 100,
    pool = 0,
    privateId = MH,
  } = options;
  const targetId = privateId === CA ? 1 : 2; // C&A -> PRR, M&H -> NYC
  const company = (id: number, ticker: string) => ({
    company_id: id,
    ticker,
    president: null,
    ipo_pool_percentage: id === targetId ? ipo : 100,
    bank_pool_percentage: id === targetId ? pool : 0,
    player_holdings: id === targetId && held > 0 ? [{ player: ADA, percentage: held }] : [],
  });
  return {
    player_addresses: [ADA, BEN],
    public_companies: [company(1, "PRR"), company(2, "NYC")],
    private_companies: [
      {
        private_id: privateId,
        name: privateId === CA ? "Camden & Amboy" : "Mohawk & Hudson",
        cost: "160",
        revenue_per_or: "25",
        owner,
        owner_protocol_id: null,
        closed,
      },
    ],
  } as unknown as GameStateResponse;
}

/** The C&A's target -- the apply-side tests all grant PRR shares. */
const prrOf = (state: GameStateResponse) =>
  state.public_companies.find((c) => c.company_id === 1)!;
const privOf = (state: GameStateResponse) => state.private_companies[0];

/* Phase 3 W1-C (AUD-10.02): the `resolvePrivateExchange` block that stood here tested the shell's retired
   client-side copy of the M&H rule (flat 60% cap, no zone waiver, no certificate check, IPO first). The rule it
   approximated is `mhExchangeRequestRefusal`, exhaustively covered by `mohawkExchangeAuthority.test.ts`; the
   shell's per-pile use of it is covered by `activePrivatePower.test.ts` and `privatePowerFlow.test.ts`. */

describe("applyPrivateExchange", () => {
  const grant = (over: Partial<ExchangeGrant> = {}): ExchangeGrant => ({
    ok: true,
    privateId: CA,
    companyId: 1,
    ticker: "PRR",
    player: ADA,
    source: "Ipo",
    ...over,
  });

  it("grants the 10% share", () => {
    const next = applyPrivateExchange(board({ privateId: CA }), grant());
    expect(prrOf(next).player_holdings).toEqual([{ player: ADA, percentage: 10 }]);
  });

  it("adds to an existing holding rather than duplicating the row", () => {
    /* Two rows for one player is the kind of thing every reader sums
       correctly and every reader DISPLAYS wrongly. */
    const next = applyPrivateExchange(board({ held: 20, privateId: CA }), grant());
    expect(prrOf(next).player_holdings).toEqual([{ player: ADA, percentage: 30 }]);
  });

  it("closes the private and releases its owner", () => {
    /* Design note #573a: `closed` is what removes it from the powers panel,
       the ledger and the certificate count in one write -- the reported
       "should be removed... not simply Used". */
    const next = applyPrivateExchange(board({ privateId: CA }), grant());
    expect(privOf(next).closed).toBe(true);
    expect(privOf(next).owner).toBeNull();
  });

  it("takes the certificate out of the pile it came from", () => {
    // A share that arrives in a hand without leaving a pile is a share this
    // game now has one too many of.
    const fromIpo = applyPrivateExchange(board({ ipo: 100, pool: 40, privateId: CA }), grant());
    expect(prrOf(fromIpo).ipo_pool_percentage).toBe(90);
    expect(prrOf(fromIpo).bank_pool_percentage).toBe(40);

    const fromPool = applyPrivateExchange(board({ ipo: 0, pool: 40, privateId: CA }), grant({ source: "Bank" }));
    expect(prrOf(fromPool).ipo_pool_percentage).toBe(0);
    expect(prrOf(fromPool).bank_pool_percentage).toBe(30);
  });

  it("is a no-op on a replay of an exchange already applied", () => {
    /* Design note #549: every client replays every action, and a client that
       had already applied this one must not hand out a second certificate. */
    const once = applyPrivateExchange(board({ privateId: CA }), grant());
    const twice = applyPrivateExchange(once, grant());
    expect(twice).toBe(once);
  });

  it("keeps the Camden & Amboy open when its bonus is granted", () => {
    /* Design note #576: the C&A's share is a purchase bonus, not a trade.
       Closing it would cost its owner $25 an Operating Round for the rest of
       the game -- a loss with no visible cause. */
    const next = applyPrivateExchange(board({ privateId: CA }), grant({ keepOpen: true }));
    expect(privOf(next).closed).toBe(false);
    expect(privOf(next).owner).toBe(ADA);
    // ...and the share still arrives.
    expect(prrOf(next).player_holdings).toEqual([{ player: ADA, percentage: 10 }]);
  });

  it("does not mutate the state it was given", () => {
    const before = board({ privateId: CA });
    applyPrivateExchange(before, grant());
    expect(privOf(before).closed).toBe(false);
    expect(prrOf(before).player_holdings).toEqual([]);
  });
});
