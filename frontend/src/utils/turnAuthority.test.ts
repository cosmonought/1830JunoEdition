/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1205 (harness): THE CHECK THAT DEFEATED THE REDUCER TWICE
// ==================================================================
//
// #1174 broke ten tests across four suites, `replayAttribution` among them. #1182 passed every test it had
// and reached real players. So this file is written on the assumption that the next mistake here will also
// look correct: each case names the flow it protects and what a player would lose if it were refused.
//
// THE FOUR BRANCHES ARE PINNED THROUGH `actingAddress`, NOT REIMPLEMENTED. A test that restated the rule
// would pass while the rule drifted -- #1184's shape in a test file. These cases build boards and assert who
// may act, so they fail if `actingAddress` changes its mind.

export {};

const { turnRefusal } = require("./turnAuthority") as typeof import("./turnAuthority");
const { sandboxScenarioState } = require("./sandboxState") as typeof import("./sandboxState");

type State = import("./gameState").GameStateResponse;
type Waterfall = import("./gameState").WaterfallStateResponse;

const ALICE = "p-alice";
const BOB = "p-bob";
const CAROL = "p-carol";

function board(over: Partial<State> = {}): State {
  const seed = sandboxScenarioState("start", 0, "default");
  return {
    ...seed,
    player_addresses: [ALICE, BOB, CAROL],
    active_player_index: 0,
    current_round_type: "StockRound",
    ...over,
  };
}

const refusal = (
  state: State,
  actor: string | null,
  msg: unknown,
  extra: { waterfall?: Waterfall | null; derived?: boolean } = {},
) =>
  turnRefusal({
    state,
    waterfall: extra.waterfall ?? null,
    actor,
    msg: msg as never,
    derived: extra.derived,
  });

const PASS = { PassTurn: { game_id: 0 } };

describe("the seat-driven rounds", () => {
  it("lets the seated player act and refuses the others", () => {
    const state = board();
    expect(refusal(state, ALICE, PASS)).toBeNull();
    expect(refusal(state, BOB, PASS)).toBe("It is not your turn.");
  });

  it("follows the cursor rather than the roster order", () => {
    const state = board({ active_player_index: 2 });
    expect(refusal(state, CAROL, PASS)).toBeNull();
    expect(refusal(state, ALICE, PASS)).not.toBeNull();
  });
});

describe("the Operating Round answers with a president, not a seat", () => {
  it("lets the operating corporation's president act", () => {
    /* #411: Operating Rounds are CORPORATION-driven and the seat pointer is not meaningful there -- it can
       easily point at a player with nothing to do. `active_player_index` below is ALICE's; the turn belongs
       to BOB because BOB is president of the corporation that is operating. */
    const seed = board();
    const state: State = {
      ...seed,
      current_round_type: "OperatingRound",
      active_player_index: 0,
      active_operating_order: [1],
      active_corporation_index: 0,
      public_companies: seed.public_companies.map((company) =>
        company.company_id === 1 ? { ...company, president: BOB } : company,
      ),
    };
    expect(refusal(state, BOB, PASS)).toBeNull();
    expect(refusal(state, ALICE, PASS)).toBe("It is not your turn.");
  });
});

describe("the mini-auction suspends the rotation, #544", () => {
  it("hands the turn to the contest's cursor and takes it from the waterfall's", () => {
    /* #544: while a contest is live the main rotation does not advance and nobody may take a waterfall
       action. `waterfall.current_turn` is preserved across the contest so it can be resumed untouched --
       which makes it a STALE pointer for the duration, and reading it here would hand the turn to a player
       who is not in the contest. */
    const state = board({ current_round_type: "WaterfallAuction", active_player_index: 0 });
    const contested = { mini_auction: { current_turn: CAROL } } as unknown as Waterfall;
    expect(refusal(state, CAROL, PASS, { waterfall: contested })).toBeNull();
    expect(refusal(state, ALICE, PASS, { waterfall: contested })).toBe("It is not your turn.");
  });

  it("falls back to the seat when no contest is running", () => {
    const state = board({ current_round_type: "WaterfallAuction", active_player_index: 0 });
    const quiet = { mini_auction: null } as unknown as Waterfall;
    expect(refusal(state, ALICE, PASS, { waterfall: quiet })).toBeNull();
  });
});

describe("the exemptions, each one a move a player would otherwise lose", () => {
  it("never audits the game's own actions", () => {
    /* #1203: the server generated these itself after a player's move. A `PassTurn` that ends a turn is by
       definition not on anybody's turn -- the corporation it belongs to has just finished. */
    const state = board({ active_player_index: 0 });
    expect(refusal(state, BOB, PASS, { derived: true })).toBeNull();
  });

  it("allows a null actor, because solo play has one", () => {
    /* #549b: a null actor is a POSITIVE STATE and `applyOneAction` resolves it to the cursor deliberately.
       Refusing would make a single-player game unplayable, and there is nobody to take a turn from. */
    expect(refusal(board(), null, PASS)).toBeNull();
  });

  it("lets the private's owner answer an offer while somebody else is on turn", () => {
    /* #701: a corporation on its turn OFFERS; the owner ANSWERS, and the owner is by definition not the one
       operating. Refusing this would make every private-company negotiation in the game unanswerable. */
    const state = board({
      active_player_index: 0,
      private_purchase_offer: {
        private_id: 3,
        private_name: "Delaware & Hudson",
        owner: BOB,
        buyer_protocol_id: 7,
        buyer_ticker: "NNH",
        price: 70,
      },
    } as Partial<State>);
    const answer = { AnswerPrivatePurchase: { private_id: 3, accept: true } };
    expect(refusal(state, BOB, answer)).toBeNull();
    expect(refusal(state, CAROL, answer)).toBe(
      "Only the private company's owner can answer that offer.",
    );
  });

  it("lets the selling president answer a train offer, and it is the buyer who is on turn", () => {
    /* #701 states the direction explicitly. Getting it backwards would refuse every train trade in the
       game, which is why the case asserts the seller passes AND the buyer does not. */
    const state = board({
      active_player_index: 0,
      train_purchase_offer: {
        seller_protocol_id: 4,
        seller_ticker: "B&O",
        seller_president: CAROL,
        buyer_protocol_id: 1,
        buyer_ticker: "PRR",
        model_type: "3",
        // NOTE: `train_purchase_offer.price` is a STRING while `private_purchase_offer.price` is a NUMBER.
        // Not this file's to reconcile; recorded in the migration plan as an audit item.
        price: "150",
      },
    } as Partial<State>);
    const answer = { AnswerTrainPurchase: { seller_protocol_id: 4, accept: true } };
    expect(refusal(state, CAROL, answer)).toBeNull();
    expect(refusal(state, ALICE, answer)).toBe(
      "Only the selling corporation's president can answer that offer.",
    );
  });

  it("does not turn a duplicate answer into an error", () => {
    /* #662: "the first answer settles it, the second finds nothing". The reducer's arm returns the state
       unchanged; a gate that refused here would put an error on the screen of somebody who did nothing
       wrong -- and in a room, a second client's replayed answer arrives exactly like this. */
    const answer = { AnswerPrivatePurchase: { private_id: 3, accept: true } };
    expect(refusal(board(), CAROL, answer)).toBeNull();
  });
});

describe("the shell-owned messages, #1220", () => {
  /* ==================================================================
      THE FAMILY IS ENUMERATED HERE ON PURPOSE
     ==================================================================
     Four playtests were spent fixing these ONE BUTTON AT A TIME, because each refusal looked like its own
     bug and the class was never named. This list is the class. An eleventh member of `isSandboxOnlyMsg` that
     is not classified below fails the last case in this block, which is the point: the next person to add a
     shell message has to say which kind it is rather than discover it from a playtest. */
  const NOT_A_SEAT_S_MOVE: Array<[string, unknown]> = [
    ["OpenStockRound", { OpenStockRound: {} }],
    ["SetBoPar", { SetBoPar: { player: BOB, par_value: 100 } }],
    ["PlaceHomeStation", { PlaceHomeStation: { company_id: 1, q: 0, r: 0, kind: "home", city_index: 0 } }],
    ["ExchangePrivate", { ExchangePrivate: { private_id: 5 } }],
    ["RevertTo", { RevertTo: { index: 3 } }],
    ["CloseRoom", { CloseRoom: {} }],
    ["BuyKanawhaLicense", { BuyKanawhaLicense: { protocol_id: 1 } }], // #1323
  ];

  it.each(NOT_A_SEAT_S_MOVE)("does not ask the seat about %s", (_label, msg) => {
    /* THE SEAT CURSOR POINTS AT ALICE throughout, and none of these is refused with "It is not your turn":
       they close a phase, place a token the rules place for you, exercise a private's own off-turn right, or
       belong to the room rather than to a seat. #1249 gives each its OWNER instead (the block below), so the
       assertion here is only that the seat is not the judge. */
    expect(refusal(board({ active_player_index: 0 }), BOB, msg)).not.toBe("It is not your turn.");
  });

  it("still refuses an ordinary move from the same player", () => {
    // The guard against over-reading the exemption: it must not have opened the gate generally.
    expect(refusal(board({ active_player_index: 0 }), BOB, PASS)).toBe("It is not your turn.");
  });

  it("refuses a second deal rather than erasing the game in progress", () => {
    /* The one member of the family that is cheap to guard. #538: a roster is "nothing, until the log says
       otherwise", so a non-empty one IS the record that the deal has happened. */
    const setup = { SetupGame: { players: [], variants: {} } };
    expect(refusal(board(), BOB, setup)).toBe("This game has already been dealt.");
    expect(refusal(board({ player_addresses: [] }), BOB, setup)).toBeNull();
  });

  it("does not swallow the consent answers, which have real owners", () => {
    /* ORDER IS LOAD-BEARING. The negotiation messages are in `isSandboxOnlyMsg` too, and exemption 3 runs
       first so their owner checks stand. If this block were moved above it, every trade answer in the game
       would be answerable by anybody -- which no test would catch, because each one would simply pass. */
    const state = board({
      active_player_index: 0,
      private_purchase_offer: {
        private_id: 3,
        private_name: "Delaware & Hudson",
        owner: BOB,
        buyer_protocol_id: 7,
        buyer_ticker: "NNH",
        price: 70,
      },
    } as Partial<State>);
    const answer = { AnswerPrivatePurchase: { private_id: 3, accept: true } };
    expect(refusal(state, CAROL, answer)).toBe(
      "Only the private company's owner can answer that offer.",
    );
  });

  it("classifies every member of the family", () => {
    /* THE LIST ABOVE PLUS THE FOUR NEGOTIATION MESSAGES PLUS `SetupGame` IS THE WHOLE PREDICATE. Counted
       rather than described, so adding an eleventh message to `isSandboxOnlyMsg` without deciding what it is
       fails here instead of in somebody's playtest. */
    const classified = [
      ...NOT_A_SEAT_S_MOVE.map(([label]) => label),
      "SetupGame",
      "ProposePrivatePurchase",
      "AnswerPrivatePurchase",
      "ProposeTrainPurchase",
      "AnswerTrainPurchase",
    ];
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "gameSetup.ts"),
      "utf8",
    ) as string;
    const predicate = source.slice(source.indexOf("export function isSandboxOnlyMsg"));
    const body = predicate.slice(0, predicate.indexOf("\n}"));
    const named = (body.match(/is([A-Z][A-Za-z]*)Msg\(msg\)/g) ?? []).map((call) =>
      call.replace(/^is/, "").replace(/Msg\(msg\)$/, ""),
    );
    expect(named.slice().sort()).toEqual(classified.slice().sort());
  });
});

describe("each room message has an owner, #1249", () => {
  /* #1220 left these to "any player in the room ... at any time" and called it a gap. Each case here is the
     question the shell asks before it shows the button, asked again on the server against the same board --
     and each refusal is about OWNERSHIP, never legality, which stays the reducer's. */
  const withOwner = (state: State, privateId: number, owner: string | null): State => ({
    ...state,
    private_companies: state.private_companies.map((entry) =>
      entry.private_id === privateId ? { ...entry, owner } : entry,
    ),
  });
  const withPresident = (state: State, companyId: number, president: string | null): State => ({
    ...state,
    public_companies: state.public_companies.map((entry) =>
      entry.company_id === companyId ? { ...entry, president } : entry,
    ),
  });
  const withHost = (state: State, actor: string | null, msg: unknown, host: string | null | undefined, log?: unknown) =>
    turnRefusal({ state, waterfall: null, actor, msg: msg as never, host, log: log as never });

  it("SetupGame: the host, on an undealt board; nobody when no host is known", () => {
    const setup = { SetupGame: { players: [], variants: {} } };
    const undealt = board({ player_addresses: [] });
    expect(withHost(undealt, ALICE, setup, ALICE)).toBeNull();
    expect(withHost(undealt, BOB, setup, ALICE)).toBe("Only the host can start the game.");
    // No room document (a test, the CLI): the host check is skipped, not failed.
    expect(withHost(undealt, BOB, setup, undefined)).toBeNull();
    expect(withHost(undealt, BOB, setup, null)).toBeNull();
  });

  it("OpenStockRound: only when the auction is over, by anybody", () => {
    const auction = board({ current_round_type: "WaterfallAuction" });
    const sold = { privates: [] } as unknown as Waterfall;
    const unsold = { privates: [{ private_id: 1 }, { private_id: 2 }] } as unknown as Waterfall;
    expect(refusal(auction, BOB, { OpenStockRound: {} }, { waterfall: sold })).toBeNull();
    expect(refusal(auction, BOB, { OpenStockRound: {} }, { waterfall: unsold })).toBe(
      "The auction is not over yet — 2 private companies are still for sale.",
    );
    expect(refusal(board(), BOB, { OpenStockRound: {} }, { waterfall: sold })).toBe("The Stock Round is already open.");
  });

  it("SetBoPar: the B&O private's owner, named in the message", () => {
    const won = withOwner(board(), 6, BOB);
    expect(refusal(won, BOB, { SetBoPar: { player: BOB, par_value: "100" } })).toBeNull();
    expect(refusal(won, ALICE, { SetBoPar: { player: BOB, par_value: "100" } })).toBe("Only the B&O private's owner pars the B&O.");
    expect(refusal(won, ALICE, { SetBoPar: { player: ALICE, par_value: "100" } })).toBe("Only the B&O private's owner pars the B&O.");
    // Whether the B&O CAN be parred is `boPresidencyRefusal`'s question, not this gate's.
    expect(refusal(board(), BOB, { SetBoPar: { player: BOB, par_value: "100" } })).toBeNull();
  });

  it("PlaceHomeStation: the corporation's president; the D&H's owner for a D&H token", () => {
    const presided = withPresident(board(), 1, BOB);
    const home = { PlaceHomeStation: { company_id: 1, q: 0, r: 0, kind: "home", city_index: null, hex_label: "H12" } };
    expect(refusal(presided, BOB, home)).toBeNull();
    expect(refusal(presided, ALICE, home)).toBe("Only PRR's president places its station.");
    const dh = { PlaceHomeStation: { company_id: 1, q: 0, r: 0, kind: "dh", city_index: null, hex_label: "F16" } };
    expect(refusal(withOwner(presided, 3, ALICE), BOB, dh)).toBe("Only the Delaware & Hudson's owner can use its free station.");
    expect(refusal(withOwner(presided, 3, BOB), BOB, dh)).toBeNull();
  });

  it("ExchangePrivate: the private's owner, named in the message", () => {
    const held = withOwner(board(), 4, BOB);
    const exchange = { ExchangePrivate: { private_id: 4, company_id: 2, player: BOB, source: "Ipo" } };
    expect(refusal(held, BOB, exchange)).toBeNull();
    expect(refusal(held, ALICE, exchange)).toMatch(/^Only the .*'s owner can exchange it\.$/);
    expect(refusal(held, ALICE, { ExchangePrivate: { ...exchange.ExchangePrivate, player: ALICE } })).toMatch(/owner can exchange it/);
  });

  it("RevertTo: undoReachFor's rule on the server's own log", () => {
    const entry = (index: number, actor: string, derived = false) => ({
      index,
      id: `e${index}`,
      actor,
      payload: JSON.stringify({ PassTurn: { game_id: 0 } }),
      ...(derived ? { derived: true } : {}),
    });
    const log = [entry(0, ALICE), entry(1, BOB), entry(2, BOB, true)];
    const revert = (index: number, player: string) => ({ RevertTo: { index, player, summary: "" } });
    // Bob's own last action, with only the game's bookkeeping on top of it: Bob's to undo.
    expect(withHost(board(), BOB, revert(1, BOB), ALICE, log)).toBeNull();
    // Alice's action has Bob's on top of it: only the host reaches it -- and Alice IS the host here.
    expect(withHost(board(), ALICE, revert(0, ALICE), ALICE, log)).toBeNull();
    expect(withHost(board(), ALICE, revert(0, ALICE), CAROL, log)).toBe(
      "Other players have acted since your last move. Only the host can undo past somebody else's turn.",
    );
    // Carol never acted; Bob's entry is not hers.
    expect(withHost(board(), CAROL, revert(1, CAROL), ALICE, log)).toMatch(/Only the host can undo/);
    expect(withHost(board(), BOB, revert(7, BOB), ALICE, log)).toBe("There is nothing at that point in the log to undo.");
    // No log handed over: nothing to judge against, so nothing refused (the CLI, a test).
    expect(withHost(board(), CAROL, revert(1, CAROL), ALICE, undefined)).toBeNull();
  });

  it("CloseRoom: at GameEnd, and the race's losers are still let through for #899's silence", () => {
    expect(refusal(board(), BOB, { CloseRoom: {} })).toBe("The game is not over yet.");
    const ended = board({ current_round_type: "GameEnd" });
    expect(refusal(ended, BOB, { CloseRoom: {} })).toBeNull();
    expect(refusal({ ...ended, room_closed: true }, BOB, { CloseRoom: {} })).toBeNull();
  });

  it("is wired on the server: the host from the room document, the log from the session", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const session = fs.readFileSync(path.join(__dirname, "roomSession.ts"), "utf8");
    expect(session).toContain("host: input.host,");
    expect(session).toContain("log: this.log,");
    const server = fs.readFileSync(path.join(__dirname, "..", "..", "..", "server", "src", "gameServer.ts"), "utf8");
    expect(server).toContain("host: roomDocs.get(attached.room)?.hostId ?? null,");
  });
});

describe("an unresolvable cursor allows the action through", () => {
  it("does not refuse when the roster is empty", () => {
    /* THE SAME LINE `dividendGate` AND `trainPurchaseGate` BOTH TAKE: "an unknown cursor is allowed through,
       deliberately ... refusing there would brick a board on the strength of a missing field rather than a
       broken rule." A board that cannot say whose turn it is has said nothing about THIS player. */
    expect(refusal(board({ player_addresses: [] }), ALICE, PASS)).toBeNull();
  });

  it("does not refuse when the operating corporation has no seated president", () => {
    const seed = board();
    const state: State = {
      ...seed,
      current_round_type: "OperatingRound",
      active_operating_order: [1],
      active_corporation_index: 0,
      public_companies: seed.public_companies.map((company) =>
        company.company_id === 1 ? { ...company, president: null } : company,
      ),
    };
    expect(refusal(state, ALICE, PASS)).toBeNull();
  });
});
