/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 887 (harness): THE SAME RULES, ASKED INSTEAD OF SEARCHED FOR
// ==================================================================
//
// THIS FILE IS THE POINT OF THE EXTRACTION. Every assertion below was previously a source scan of `App.tsx`
// -- `expect(APP).toContain('const key: PowerAbilityKey | null = dhOwed ? "dh-tile" : privatePowerRequest;')`
// and its neighbours. Those assertions were true of the FILE and silent about the BEHAVIOUR: they would pass
// for a memo whose dependency array never fired, for a branch guarded by an inverted condition, and for the
// six months in which #871's note claimed the panel's button raised a confirmation that it did not.
//
// AND THEY COULD BE VACUOUS IN WAYS THESE CANNOT. Every entry on this project's vacuity list is a property of
// scanning text: `indexOf` returning -1 and comparing less than everything, a backwards slice yielding `""`
// that satisfies every `not.toContain` beside it, a bare count that survives a swap, an anchor placed
// downstream of the gate it is looking for. A call with an argument and a return value has none of them
// available to it -- if the fixture is wrong the test fails, and if the rule is wrong the test fails.
//
// WHAT IS STILL A SOURCE SCAN, AND SHOULD BE: nothing here. The scans that remain in
// `powerRefusalAndChips.test.ts` are the ones only a scan can do -- whether a design note claims something
// the code does not do, which is this codebase's signature bug and is invisible to a function call.
//
// FIXTURES ARE BUILT TO DISTINGUISH, per the standing rule that a fixture unable to tell two outcomes apart
// proves nothing. `priv()` defaults to "nobody holds it, it is open" and each test contradicts exactly one
// field, so a passing test names the field that decided it. Where a test is about WHICH ownership field the
// code consults, `owner` and `owner_protocol_id` are set to different holders -- a fixture with both pointing
// at the same party cannot tell a player-scope check from a corporate one.

import {
  deriveActivePowerFlow,
  ownsPrivateByCorporation,
  stockRoundExchangeOffers,
} from "./activePrivatePower";
import type {
  GameStateResponse,
  PrivateCompanyState,
  PublicCompanyState,
} from "../gameEngine/gameState";

const MH = 4;
const DH = 3;
const CSL = 2;

const ALICE = "alice";
const BOB = "bob";
const PRR = 1;
const NYC = 2;

/** One private, with every field a test might vary made explicit at the call site.
 *
 *  THE SPREAD COMES LAST so an override wins; the defaults above it are the "nobody holds it, it is open"
 *  baseline every test starts from and then contradicts in exactly one field. That is what makes a fixture
 *  able to distinguish -- a helper that merged the other way would silently ignore every override. */
const priv = (over: Partial<PrivateCompanyState> & { private_id: number }): PrivateCompanyState =>
  ({
    name: `Private ${over.private_id}`,
    cost: "100",
    revenue_per_or: "20",
    owner: null,
    owner_protocol_id: null,
    closed: false,
    ...over,
  }) as PrivateCompanyState;

/** One public corporation. Only `company_id` and `ticker` are read by anything under test -- the holder line
 *  looks up one and prints the other -- so the rest is filled by the cast rather than by inventing a treasury
 *  and a par value this module has no opinion about. */
const pub = (companyId: number, ticker: string): PublicCompanyState =>
  ({ company_id: companyId, ticker }) as unknown as PublicCompanyState;

const state = (over: Partial<GameStateResponse> = {}): GameStateResponse =>
  ({
    current_round_type: "StockRound",
    private_companies: [],
    public_companies: [],
    player_addresses: [ALICE, BOB],
    ...over,
  }) as unknown as GameStateResponse;

const SANDBOX = {
  viewerAddress: ALICE,
  sandbox: true,
  mhPrivateId: MH,
};

describe("stockRoundExchangeOffers (design notes #871/#881/#883)", () => {
  const mhHeldByAlice = state({
    private_companies: [priv({ private_id: MH, owner: ALICE, revenue_per_or: "20" })],
  });

  it("offers the exchange to the player who holds it", () => {
    const offers = stockRoundExchangeOffers({ state: mhHeldByAlice, ...SANDBOX });
    expect(offers).toHaveLength(1);
    /* IDENTITY, NOT LENGTH. A count alone would pass for the wrong power entirely, which is the swap a bare
       `toHaveLength(1)` cannot see. */
    expect(offers[0].abilityKey).toBe("mh-exchange");
  });

  it("names it with the acronym, not the ampersand form (#364/#881)", () => {
    /* THE ASSERTION THAT USED TO BE A SCAN for `chipLabel: \`Exchange ${acronym} for NYC\``. That proved the
       source called a lookup; this proves the lookup RESOLVES -- a scan cannot tell a working lookup from
       one falling through to its fallback, which is exactly how a correct-today literal survives. */
    const offers = stockRoundExchangeOffers({ state: mhHeldByAlice, ...SANDBOX });
    expect(offers[0].chipLabel).toBe("Exchange MH for NYC");
    expect(offers[0].chipLabel).not.toContain("M&H");
  });

  it("carries the hover sentence with the label (#884)", () => {
    const offers = stockRoundExchangeOffers({ state: mhHeldByAlice, ...SANDBOX });
    expect(offers[0].chipTitle).toContain("nothing is spent until you answer it");
  });

  it("offers nothing outside sandbox (#883)", () => {
    /* `ExchangePrivate` IS NOT ON THE SESSION KEY'S ALLOW-LIST. The panel's `if (!sandbox) return null` was
       the only thing enforcing that until this gate; the premise itself is pinned in
       `powerRefusalAndChips.test.ts` against `GAMEPLAY_MESSAGE_KEYS`. */
    expect(
      stockRoundExchangeOffers({ state: mhHeldByAlice, ...SANDBOX, sandbox: false }),
    ).toEqual([]);
  });

  /* Phase 3 W2-D (AUD-10.05 / K-04): INVERTED. This asserted "offers nothing outside a Stock Round"; the authority's
     window is the Stock Round AND the Operating Round (D-29: everything but the owner's own Stock Round turn queues),
     so the request is offered in both -- and marked `offTurn`, because in the OR it is always somebody else's turn
     or a corporation's. The two rounds it can never be raised in are still empty. */
  it("offers the request in an Operating Round too, marked off-turn", () => {
    const operating = state({
      current_round_type: "OperatingRound",
      private_companies: [priv({ private_id: MH, owner: ALICE })],
    });
    const offers = stockRoundExchangeOffers({ state: operating, ...SANDBOX });
    expect(offers).toHaveLength(1);
    expect(offers[0].abilityKey).toBe("mh-exchange");
    expect(offers[0].offTurn).toBe(true);
  });

  it("offers nothing in the auction or a finished game", () => {
    for (const round of ["WaterfallAuction", "GameEnd"] as const) {
      const board = state({
        current_round_type: round,
        private_companies: [priv({ private_id: MH, owner: ALICE })],
      });
      expect(stockRoundExchangeOffers({ state: board, ...SANDBOX })).toEqual([]);
    }
  });

  it("offers nothing to a player who does not hold it", () => {
    expect(
      stockRoundExchangeOffers({ state: mhHeldByAlice, ...SANDBOX, viewerAddress: BOB }),
    ).toEqual([]);
  });

  it("offers nothing when a CORPORATION holds it (#441)", () => {
    /* THE TWO OWNERSHIP FIELDS, SET TO DIFFERENT THINGS. `owner_protocol_id` is the corporate field and
       `owner` the player one; a corporation holding the M&H offers nobody a chip, because a corporation
       cannot take this exchange. A fixture that left `owner` set as well could not tell which field the
       code consulted -- the distinction this test exists for. */
    const heldByCorp = state({
      private_companies: [priv({ private_id: MH, owner: null, owner_protocol_id: PRR })],
    });
    expect(stockRoundExchangeOffers({ state: heldByCorp, ...SANDBOX })).toEqual([]);
  });

  it("offers nothing once the private has closed", () => {
    const closed = state({
      private_companies: [priv({ private_id: MH, owner: ALICE, closed: true })],
    });
    expect(stockRoundExchangeOffers({ state: closed, ...SANDBOX })).toEqual([]);
  });

  it("offers nothing before the first poll", () => {
    // `null` state is a real frame, not a defensive branch: the room renders before it has answered.
    expect(stockRoundExchangeOffers({ state: null, ...SANDBOX })).toEqual([]);
  });
});

describe("deriveActivePowerFlow (design notes #818/#849/#871)", () => {
  const base = {
    request: null,
    usedAbilities: new Set<string>(),
    dhStationForfeited: false,
    dhForfeited: false,
    actingProtocolId: null as number | null,
    viewerAddress: ALICE,
    dhPrivateId: DH,
    cslPrivateId: CSL,
    mhPrivateId: MH,
  };

  /* Phase 3 W1-C: the flow now asks the authority for each pile, so the board carries the NYC it would be
     exchanged for -- 50% in the IPO, nothing in the pool, nobody holding any -- making the IPO the one legal
     pile. `phase3W1CMhExchangeSource.test.ts` covers the full source matrix. */
  const nycPub = {
    company_id: NYC,
    ticker: "NYC",
    president: null,
    is_floated: false,
    par_value: null,
    ipo_pool_percentage: 50,
    bank_pool_percentage: 0,
    player_holdings: [],
  } as unknown as PublicCompanyState;
  const mhState = state({
    private_companies: [priv({ private_id: MH, owner: ALICE, revenue_per_or: "20" })],
    public_companies: [nycPub],
  });

  const dhState = state({
    current_round_type: "OperatingRound",
    private_companies: [priv({ private_id: DH, owner_protocol_id: PRR })],
    public_companies: [pub(PRR, "PRR")],
  });

  it("is null with nothing requested and nothing owed", () => {
    expect(deriveActivePowerFlow({ ...base, state: mhState })).toBeNull();
  });

  it("raises the exchange question when the chip asks for it", () => {
    const flow = deriveActivePowerFlow({ ...base, state: mhState, request: "mh-exchange" });
    expect(flow).not.toBeNull();
    expect(flow!.abilityKey).toBe("mh-exchange");
    /* THE FIGURE THE DECISION TURNS ON (#443/#871), read out of the rendered sentence rather than out of the
       source that formats it. */
    expect(flow!.prompt).toContain("$20/OR revenue");
    /* W1-C: the one legal pile, as its own step. */
    expect(flow!.steps.map((step) => step.key)).toEqual(["exchange-ipo"]);
  });

  it("re-checks ownership rather than trusting the click (#871)", () => {
    /* THE RULE, AS A BEHAVIOUR: "If the private closes -- or is sold -- between the click and the next
       frame, this is what stops the modal describing a power the viewer no longer has." A scan could only
       assert that an `if` existed; this asks what happens when the condition is true.
       THREE WAYS TO LOSE IT, because one would not distinguish an ownership check from a `closed` check. */
    const sold = state({ private_companies: [priv({ private_id: MH, owner: BOB })] });
    const closed = state({
      private_companies: [priv({ private_id: MH, owner: ALICE, closed: true })],
    });
    const gone = state({ private_companies: [] });
    for (const s of [sold, closed, gone]) {
      expect(deriveActivePowerFlow({ ...base, state: s, request: "mh-exchange" })).toBeNull();
    }
  });

  it("names the loss without a number when the revenue is unreadable", () => {
    /* `undefined` RATHER THAN A GUESS -- "`|| 0` would tell a player they are giving up nothing". The
       fixture is a non-numeric string, which is what a malformed response actually looks like. */
    const odd = state({
      private_companies: [priv({ private_id: MH, owner: ALICE, revenue_per_or: "n/a" })],
      public_companies: [nycPub],
    });
    const flow = deriveActivePowerFlow({ ...base, state: odd, request: "mh-exchange" });
    expect(flow!.prompt).toContain("its Operating Round revenue");
    expect(flow!.prompt).not.toContain("$0");
  });

  it("raises the D&H's station question with nobody asking (#818)", () => {
    /* THE STANDING OBLIGATION, and the reason it cannot be a flag somebody sets: the D&H's second step
       happens after a lay that ENDS the Track step, so the reopening spans a dispatch, a sub-phase change
       and a re-render. `request` is null here and the modal opens anyway. */
    const flow = deriveActivePowerFlow({
      ...base,
      state: dhState,
      actingProtocolId: PRR,
      usedAbilities: new Set(["dh-tile"]),
    });
    expect(flow).not.toBeNull();
    expect(flow!.abilityKey).toBe("dh-tile");
    /* AND THE STATION STEP IS THE LIVE ONE, which is the whole content of the obligation. */
    const station = flow!.steps.find((step) => step.key === "station");
    expect(station).toBeDefined();
    expect(station!.enabled).toBe(true);
  });

  it("stops owing it once the placement is taken or forfeited", () => {
    /* BOTH OUTCOMES, because #818's argument is that a forfeit is a DECISION rather than a turn that moved
       on -- so the two have to be distinguishable and both have to close the obligation. */
    const placed = deriveActivePowerFlow({
      ...base,
      state: dhState,
      actingProtocolId: PRR,
      usedAbilities: new Set(["dh-tile", "dh-token"]),
    });
    expect(placed).toBeNull();
    const forfeited = deriveActivePowerFlow({
      ...base,
      state: dhState,
      actingProtocolId: PRR,
      usedAbilities: new Set(["dh-tile"]),
      dhStationForfeited: true,
    });
    expect(forfeited).toBeNull();
  });

  it("owes nothing to a corporation that does not hold the D&H (#441/#727)", () => {
    /* THE CORPORATE SCOPE, asked by behaviour. `owner_protocol_id` is PRR and NYC is operating, so the
       obligation belongs to somebody else's turn. */
    expect(
      deriveActivePowerFlow({
        ...base,
        state: dhState,
        actingProtocolId: NYC,
        usedAbilities: new Set(["dh-tile"]),
      }),
    ).toBeNull();
  });

  it("owes nothing once the power itself is forfeited to another builder (#725)", () => {
    expect(
      deriveActivePowerFlow({
        ...base,
        state: dhState,
        actingProtocolId: PRR,
        usedAbilities: new Set(["dh-tile"]),
        dhForfeited: true,
      }),
    ).toBeNull();
  });

  /* Phase 3 W1-M (AUD-06.05): the board's `dh_station_pending` raises the obligation after a reload, when the
     local set is empty. `phase3W1MDhStationReload.test.ts` plays the same thing through a room. */
  describe("the board's window survives a reload (W1-M)", () => {
    const pending = (over: Partial<GameStateResponse> = {}) =>
      state({
        current_round_type: "OperatingRound",
        private_companies: [priv({ private_id: DH, owner_protocol_id: PRR })],
        public_companies: [{ ...pub(PRR, "PRR"), president: ALICE } as PublicCompanyState],
        dh_station_pending: PRR,
        ...over,
      });

    it("offers the station to the president with an empty local set, the lay shown done", () => {
      const flow = deriveActivePowerFlow({ ...base, state: pending(), actingProtocolId: PRR });
      expect(flow!.abilityKey).toBe("dh-tile");
      expect(flow!.steps.map((step) => [step.key, step.done, step.enabled])).toEqual([
        ["lay", true, false],
        ["station", false, true],
      ]);
    });

    it("not to anybody else", () => {
      expect(deriveActivePowerFlow({ ...base, state: pending(), actingProtocolId: PRR, viewerAddress: BOB })).toBeNull();
      expect(deriveActivePowerFlow({ ...base, state: pending(), actingProtocolId: PRR, viewerAddress: null })).toBeNull();
    });

    it("keeps the forfeit, the placement and the lapse exactly as they were", () => {
      expect(
        deriveActivePowerFlow({ ...base, state: pending(), actingProtocolId: PRR, dhStationForfeited: true }),
      ).toBeNull();
      expect(
        deriveActivePowerFlow({ ...base, state: pending(), actingProtocolId: PRR, usedAbilities: new Set(["dh-token"]) }),
      ).toBeNull();
      expect(deriveActivePowerFlow({ ...base, state: pending(), actingProtocolId: PRR, dhForfeited: true })).toBeNull();
    });

    it("changes nothing when the window is absent or names another corporation", () => {
      expect(
        deriveActivePowerFlow({ ...base, state: pending({ dh_station_pending: undefined }), actingProtocolId: PRR }),
      ).toBeNull();
      expect(
        deriveActivePowerFlow({ ...base, state: pending({ dh_station_pending: NYC }), actingProtocolId: PRR }),
      ).toBeNull();
    });
  });

  it("lets the standing obligation win over a different request", () => {
    /* THE ORDERING, which the extracted function states in one line and which no scan could execute: an
       unresolved D&H station outranks whatever chip was last pressed, because the game is WAITING. */
    const both = state({
      current_round_type: "OperatingRound",
      private_companies: [
        priv({ private_id: DH, owner_protocol_id: PRR }),
        priv({ private_id: MH, owner: ALICE }),
      ],
      public_companies: [pub(PRR, "PRR")],
    });
    const flow = deriveActivePowerFlow({
      ...base,
      state: both,
      actingProtocolId: PRR,
      usedAbilities: new Set(["dh-tile"]),
      request: "mh-exchange",
    });
    expect(flow!.abilityKey).toBe("dh-tile");
  });

  it("names the operating corporation in the holder line, and degrades honestly", () => {
    const known = deriveActivePowerFlow({
      ...base,
      state: dhState,
      actingProtocolId: PRR,
      request: "dh-tile",
    });
    expect(known!.holderLine).toContain("PRR");
    /* THE FALLBACK IS A PHRASE, NOT A BLANK. An unknown ticker produces "This corporation" rather than an
       empty name in the one sentence that says whose power this is. */
    const unknown = deriveActivePowerFlow({
      ...base,
      state: state({
        current_round_type: "OperatingRound",
        private_companies: [priv({ private_id: DH, owner_protocol_id: 99 })],
        public_companies: [],
      }),
      actingProtocolId: 99,
      request: "dh-tile",
    });
    expect(unknown!.holderLine).toContain("This corporation");
  });

  it("gives the C&SL a one-step flow and the D&H a two-step one", () => {
    /* THE TWO POWERS ARE THE SAME SHAPE AT DIFFERENT LENGTHS (#847), which is a fact about the flows rather
       than about this function -- asserted here because this is what routes a key to a flow, and routing
       both keys to the same one is the mistake that would look right in a scan. */
    const csl = deriveActivePowerFlow({
      ...base,
      state: state({
        current_round_type: "OperatingRound",
        private_companies: [priv({ private_id: CSL, owner_protocol_id: PRR })],
        public_companies: [pub(PRR, "PRR")],
      }),
      actingProtocolId: PRR,
      request: "csl-tile",
    });
    expect(csl!.steps.map((step) => step.key)).toEqual(["lay"]);
    const dh = deriveActivePowerFlow({
      ...base,
      state: dhState,
      actingProtocolId: PRR,
      request: "dh-tile",
    });
    expect(dh!.steps.map((step) => step.key)).toEqual(["lay", "station"]);
  });
});

describe("ownsPrivateByCorporation (design note #727)", () => {
  it("consults the corporate field, never the player's", () => {
    /* THE TWO FIELDS SET TO DIFFERENT HOLDERS, which is the only fixture that can tell them apart: Alice
       holds the certificate personally and no corporation does. "A power belongs to the railroad, not to the
       president personally." */
    const inAPocket = state({
      private_companies: [priv({ private_id: DH, owner: ALICE, owner_protocol_id: null })],
    });
    expect(ownsPrivateByCorporation(inAPocket, DH, PRR)).toBe(false);
  });

  it("is true only for the corporation that holds it", () => {
    const heldByPrr = state({
      private_companies: [priv({ private_id: DH, owner_protocol_id: PRR })],
    });
    expect(ownsPrivateByCorporation(heldByPrr, DH, PRR)).toBe(true);
    expect(ownsPrivateByCorporation(heldByPrr, DH, NYC)).toBe(false);
  });

  it("is false with no corporation operating", () => {
    /* `null` PROTOCOL ID IS EVERY STOCK ROUND FRAME, not an edge case -- and without this guard a private
       with a null `owner_protocol_id` would match a null acting id and report itself owned. */
    const heldByNobody = state({
      private_companies: [priv({ private_id: DH, owner_protocol_id: null })],
    });
    expect(ownsPrivateByCorporation(heldByNobody, DH, null)).toBe(false);
  });
});
