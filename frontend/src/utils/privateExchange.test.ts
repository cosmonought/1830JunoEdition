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
  PLAYER_HOLDING_CAP_PERCENT,
  resolvePrivateExchange,
  type ExchangeGrant,
} from "./privateExchange";
import type { GameStateResponse } from "./gameState";

const ADA = "p-ada";
const BEN = "p-ben";
const CA = 5; // Camden & Amboy -> PRR
const MH = 4; // Mohawk & Hudson -> NYC

function board(options: {
  owner?: string | null;
  closed?: boolean;
  adaPrr?: number;
  ipo?: number;
  pool?: number;
  privateId?: number;
} = {}): GameStateResponse {
  const {
    owner = ADA,
    closed = false,
    adaPrr = 0,
    ipo = 100,
    pool = 0,
    privateId = CA,
  } = options;
  return {
    player_addresses: [ADA, BEN],
    public_companies: [
      {
        company_id: 1,
        ticker: "PRR",
        president: null,
        ipo_pool_percentage: ipo,
        bank_pool_percentage: pool,
        player_holdings: adaPrr > 0 ? [{ player: ADA, percentage: adaPrr }] : [],
      },
      {
        company_id: 2,
        ticker: "NYC",
        president: null,
        ipo_pool_percentage: 100,
        bank_pool_percentage: 0,
        player_holdings: [],
      },
    ],
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

const prrOf = (state: GameStateResponse) =>
  state.public_companies.find((c) => c.company_id === 1)!;
const privOf = (state: GameStateResponse) => state.private_companies[0];

describe("resolvePrivateExchange", () => {
  it("names the right corporation for each private", () => {
    const ca = resolvePrivateExchange(board({ privateId: CA }), CA, ADA);
    const mh = resolvePrivateExchange(board({ privateId: MH }), MH, ADA);
    expect(ca.ok && ca.ticker).toBe("PRR");
    expect(mh.ok && mh.ticker).toBe("NYC");
  });

  it("takes from the IPO while it has shares", () => {
    const outcome = resolvePrivateExchange(board({ ipo: 100, pool: 50 }), CA, ADA);
    expect(outcome.ok && outcome.source).toBe("Ipo");
  });

  it("falls back to the pool when the IPO is empty", () => {
    const outcome = resolvePrivateExchange(board({ ipo: 0, pool: 20 }), CA, ADA);
    expect(outcome.ok && outcome.source).toBe("Bank");
  });

  it("refuses at the 60% holding cap, and says so", () => {
    /* THE REPORT'S OWN HYPOTHESIS. A refusal here must be legible AND must
       leave the power intact -- that second half is enforced at the call
       site, but it is only reachable because this returns `ok: false`
       rather than throwing or silently succeeding. */
    const outcome = resolvePrivateExchange(board({ adaPrr: 60 }), CA, ADA);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toContain("60%");
    expect(!outcome.ok && outcome.reason).toMatch(/stays available/i);
  });

  it("allows the exchange that lands exactly on the cap", () => {
    // 50 + 10 = 60 is legal; 60 + 10 is not. An off-by-one here either
    // blocks a legal move or permits an illegal holding.
    expect(resolvePrivateExchange(board({ adaPrr: 50 }), CA, ADA).ok).toBe(true);
    expect(resolvePrivateExchange(board({ adaPrr: 60 }), CA, ADA).ok).toBe(false);
    expect(PLAYER_HOLDING_CAP_PERCENT).toBe(60);
  });

  it("refuses when no certificate exists anywhere", () => {
    const outcome = resolvePrivateExchange(board({ ipo: 0, pool: 0 }), CA, ADA);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toMatch(/stays available/i);
  });

  it("refuses somebody else's private", () => {
    expect(resolvePrivateExchange(board({ owner: BEN }), CA, ADA).ok).toBe(false);
    expect(resolvePrivateExchange(board({ owner: null }), CA, ADA).ok).toBe(false);
  });

  it("refuses one already exchanged", () => {
    const outcome = resolvePrivateExchange(board({ closed: true }), CA, ADA);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toMatch(/already been exchanged/i);
  });

  it("refuses a private with no exchange at all", () => {
    // The Schuylkill Valley has no power; asking must not invent one.
    expect(resolvePrivateExchange(board(), 1, ADA).ok).toBe(false);
  });
});

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
    const next = applyPrivateExchange(board(), grant());
    expect(prrOf(next).player_holdings).toEqual([{ player: ADA, percentage: 10 }]);
  });

  it("adds to an existing holding rather than duplicating the row", () => {
    /* Two rows for one player is the kind of thing every reader sums
       correctly and every reader DISPLAYS wrongly. */
    const next = applyPrivateExchange(board({ adaPrr: 20 }), grant());
    expect(prrOf(next).player_holdings).toEqual([{ player: ADA, percentage: 30 }]);
  });

  it("closes the private and releases its owner", () => {
    /* Design note #573a: `closed` is what removes it from the powers panel,
       the ledger and the certificate count in one write -- the reported
       "should be removed... not simply Used". */
    const next = applyPrivateExchange(board(), grant());
    expect(privOf(next).closed).toBe(true);
    expect(privOf(next).owner).toBeNull();
  });

  it("takes the certificate out of the pile it came from", () => {
    // A share that arrives in a hand without leaving a pile is a share this
    // game now has one too many of.
    const fromIpo = applyPrivateExchange(board({ ipo: 100, pool: 40 }), grant());
    expect(prrOf(fromIpo).ipo_pool_percentage).toBe(90);
    expect(prrOf(fromIpo).bank_pool_percentage).toBe(40);

    const fromPool = applyPrivateExchange(board({ ipo: 0, pool: 40 }), grant({ source: "Bank" }));
    expect(prrOf(fromPool).ipo_pool_percentage).toBe(0);
    expect(prrOf(fromPool).bank_pool_percentage).toBe(30);
  });

  it("is a no-op on a replay of an exchange already applied", () => {
    /* Design note #549: every client replays every action, and a client that
       had already applied this one must not hand out a second certificate. */
    const once = applyPrivateExchange(board(), grant());
    const twice = applyPrivateExchange(once, grant());
    expect(twice).toBe(once);
  });

  it("does not mutate the state it was given", () => {
    const before = board();
    applyPrivateExchange(before, grant());
    expect(privOf(before).closed).toBe(false);
    expect(prrOf(before).player_holdings).toEqual([]);
  });
});
