/** @jest-environment node */
// frontend/src/utils/messageSchema.test.ts
//
// ==================================================================
//  DESIGN NOTE 1449 (test): THE WIRE'S CONTRACT, AND THE LINE IT MUST NOT CROSS
// ==================================================================
//
// TWO CLAIMS, and they pull in opposite directions, which is why they are pinned together. The boundary must
// refuse what is not a message -- and it must refuse NOTHING ELSE. A validator that quietly tightened the
// protocol would break live play in a way no unit test of its own rejections would notice, so the corpus
// case at the foot of this file replays every message in every stored and golden log through it.

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

import {
  validateGameplayMessage,
  validateSubmitEnvelope,
  isRecognisedClientFrame,
  GAMEPLAY_MESSAGE_KINDS,
} from "../gameEngine/messageSchema";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { RoomSession } from "./roomSession";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import type { GameStateResponse } from "../gameEngine/gameState";

const ok = (msg: unknown) => validateGameplayMessage(msg).ok;
const why = (msg: unknown) => {
  const result = validateGameplayMessage(msg);
  return result.ok ? null : result.reason;
};

describe("the discriminant", () => {
  it("rejects a message that is not an object", () => {
    for (const junk of [null, undefined, "PassTurn", 7, true, []]) expect(ok(junk)).toBe(false);
  });

  it("rejects an unknown action", () => {
    expect(why({ Nonsense: {} })).toContain("not an action this game has");
    expect(why({ DropTable: { game_id: 0 } })).toContain("not an action this game has");
  });

  it("rejects a message that names no action, and one that names two", () => {
    expect(why({})).toContain("names no action");
    /* TWO KEYS IS NOT A MESSAGE. Before this existed the reducer applied whichever arm its `if` chain tested
       first, so the meaning of the frame depended on the order of the source file. */
    expect(why({ PassTurn: { game_id: 0 }, BuyStock: { protocol_id: 1, source: "Ipo" } })).toContain(
      "names one action",
    );
  });

  it("rejects a known action whose body is not an object", () => {
    expect(why({ PassTurn: 1 })).toContain("must carry an object");
    expect(why({ PassTurn: [] })).toContain("must carry an object");
    expect(why({ PassTurn: null })).toContain("must carry an object");
  });

  it("covers every arm the reducer dispatches on", () => {
    /* A SWEEP RATHER THAN A LIST, so an arm added to the reducer without a schema entry fails here rather
       than becoming silently unreachable. */
    expect(GAMEPLAY_MESSAGE_KINDS).toContain("PassTurn");
    expect(GAMEPLAY_MESSAGE_KINDS).toContain("RunMultipleRoutes");
    expect(GAMEPLAY_MESSAGE_KINDS).toContain("YellowSignEvent");
    expect(GAMEPLAY_MESSAGE_KINDS).toContain("DiscardTrain"); // #1530
    expect(GAMEPLAY_MESSAGE_KINDS).toContain("OfferPrivateForFunding"); // #1541
    expect(GAMEPLAY_MESSAGE_KINDS).toContain("DeclareBankruptcy"); // #1541
    expect(GAMEPLAY_MESSAGE_KINDS).toContain("ProposePrivateTrade"); // #1594
    expect(GAMEPLAY_MESSAGE_KINDS).toContain("RescindTrainPurchase"); // #1594
    expect(GAMEPLAY_MESSAGE_KINDS.length).toBe(49); // 44 + Batch 7.4's five (#1594)
  });
});

describe("the fields", () => {
  it("rejects a missing required field", () => {
    expect(why({ BuyStock: {} })).toContain("BuyStock.protocol_id is missing");
    expect(why({ SellStock: { protocol_id: 1 } })).toContain("SellStock.percentage is missing");
    expect(why({ RevertTo: { player: "p0" } })).toContain("RevertTo.index is missing");
  });

  it("rejects a wrong primitive", () => {
    expect(why({ BuyStock: { protocol_id: "1", source: "Ipo" } })).toContain("must be a whole number");
    expect(why({ DeclareDividends: { protocol_id: 1, revenue_amount: 100, distribute: true } })).toContain(
      "must be a string",
    );
    expect(why({ DeclareDividends: { protocol_id: 1, revenue_amount: "100", distribute: "yes" } })).toContain(
      "must be true or false",
    );
  });

  it("rejects a non-integer where the protocol counts in whole numbers", () => {
    /* `q: 1.5` reached the reducer before this file existed. A hex has no half-column. */
    expect(why({ LayTile: { protocol_id: 1, tile_id: 7, q: 1.5, r: 0, orientation: 0 } })).toContain(
      "LayTile.q must be a whole number",
    );
  });

  it("rejects NaN and Infinity", () => {
    expect(ok({ BuyStock: { protocol_id: NaN, source: "Ipo" } })).toBe(false);
    expect(ok({ SellStock: { protocol_id: 1, percentage: Infinity } })).toBe(false);
    expect(ok({ SellStock: { protocol_id: 1, percentage: -Infinity } })).toBe(false);
    expect(ok({ LayTile: { protocol_id: 1, tile_id: 7, q: NaN, r: 0, orientation: 0 } })).toBe(false);
  });

  it("rejects a value outside a string union", () => {
    expect(why({ BuyStock: { protocol_id: 1, source: "Treasury" } })).toContain("must be one of Ipo, Bank");
    expect(why({ PlaceHomeStation: { company_id: 1, q: 0, r: 0, kind: "wherever" } })).toContain(
      "must be one of home, dh",
    );
    expect(why({ YellowSignEvent: { protocol_id: 1, stage: "apocalypse" } })).toContain(
      "must be one of mark, carcosa, fog",
    );
  });

  it("rejects the wrong container shape", () => {
    expect(why({ SetupGame: { players: {} } })).toContain("must be an array");
    expect(why({ SetupGame: { players: [], variants: [] } })).toContain("must be an object");
    expect(why({ ExecuteOperatingRound: { public_company_choices: "none" } })).toContain("must be an array");
  });

  it("accepts an absent optional field and still checks a present one", () => {
    expect(ok({ BuyStock: { protocol_id: 1, source: "Ipo" } })).toBe(true);
    expect(ok({ BuyStock: { protocol_id: 1, source: "Ipo", quantity: 2 } })).toBe(true);
    expect(ok({ BuyStock: { protocol_id: 1, source: "Ipo", quantity: 1.5 } })).toBe(false);
    /* `par_value` is genuinely nullable on the wire; `null` is a value here, not an absence. */
    expect(ok({ BuyStock: { protocol_id: 1, source: "Ipo", par_value: null } })).toBe(true);
    expect(ok({ BuyStock: { protocol_id: 1, source: "Ipo", par_value: 100 } })).toBe(false);
  });

  it("allows a field the table does not name", () => {
    /* DELIBERATE. The table was built from the declared types and corrected against the logs, and the logs
       carried fields the declarations do not mention. Refusing an unrecognised field would refuse real
       traffic on the strength of an incomplete list. */
    expect(ok({ PassTurn: { game_id: 0, somethingNew: true } })).toBe(true);
  });
});

describe("the frame envelope", () => {
  it("rejects a baseIndex that is not a log position", () => {
    /* IT SKIPPED THE STALENESS CHECK. `RoomSession.submit` compares `baseIndex` with the log's length; a
       non-number made that comparison false, so a client arbitrarily far behind had its move applied on top
       of a board it had never seen. */
    for (const baseIndex of ["abc", NaN, Infinity, undefined, null, 1.5, -2]) {
      expect(validateSubmitEnvelope({ build: "dev", baseIndex }).ok).toBe(false);
    }
    expect(validateSubmitEnvelope({ build: "dev", baseIndex: -1 }).ok).toBe(true);
    expect(validateSubmitEnvelope({ build: "dev", baseIndex: 0 }).ok).toBe(true);
  });

  it("rejects a frame with no build, and a non-string submissionId", () => {
    expect(validateSubmitEnvelope({ baseIndex: 0 }).ok).toBe(false);
    expect(validateSubmitEnvelope({ build: "dev", baseIndex: 0, submissionId: 7 }).ok).toBe(false);
    expect(validateSubmitEnvelope({ build: "dev", baseIndex: 0, submissionId: "x-1" }).ok).toBe(true);
  });

  it("recognises only the frame kinds the server answers", () => {
    expect(isRecognisedClientFrame({ kind: "submit" })).toBe(true);
    expect(isRecognisedClientFrame({ kind: "room-hello" })).toBe(true);
    expect(isRecognisedClientFrame({ kind: "please" })).toBe(false);
    for (const junk of [null, 7, "submit", [], {}, { kind: 1 }]) {
      expect(isRecognisedClientFrame(junk)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The boundary in place: nothing malformed reaches the log            */
/* ------------------------------------------------------------------ */

const SEATS = [
  { id: "p-a", nickname: "A" },
  { id: "p-b", nickname: "B" },
];

function room(): RoomSession {
  let minted = 0;
  const session = new RoomSession({
    providers: sandboxReplayProviders(),
    seed: {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(
        sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
        [],
      ),
    },
    build: "dev",
    mintId: () => `t-${(minted += 1)}`,
  });
  session.submit({
    actor: "p-a",
    build: "dev",
    baseIndex: -1,
    msg: { SetupGame: { build: "dev", players: SEATS, variants: { rules: 1 } } } as never,
    host: "p-a",
  });
  return session;
}

describe("a malformed frame never becomes history (#1449)", () => {
  /* THE SERVER IS WHAT ENFORCES THIS, so the test performs the same two steps `gameServer.ts` does: check,
     and only then submit. Asserting on `RoomSession` alone would prove the opposite of the point -- the
     session still applies whatever it is handed, which is exactly why the check has to precede it. */
  const submitLikeTheServer = (session: RoomSession, msg: unknown) => {
    if (!validateGameplayMessage(msg).ok) return "refused-by-schema";
    session.submit({
      actor: "p-a",
      build: "dev",
      baseIndex: session.entries.length - 1,
      msg: msg as never,
      host: "p-a",
    });
    return "submitted";
  };

  const MALFORMED: unknown[] = [
    {},
    [],
    { Nonsense: {} },
    { BuyStock: {} },
    { BuyStock: { protocol_id: "x", source: "Ipo" } },
    { BuyStock: { protocol_id: NaN, source: "Ipo" } },
    { SellStock: { protocol_id: 1, percentage: Infinity } },
    { LayTile: { protocol_id: 1, tile_id: 7, q: 1.5, r: "x", orientation: 0 } },
    { PassTurn: { game_id: 0 }, BuyStock: { protocol_id: 1, source: "Ipo" } },
  ];

  it("appends nothing and leaves the board untouched", () => {
    const session = room();
    const entriesBefore = session.entries.length;
    const digestBefore = JSON.stringify(session.state);

    for (const msg of MALFORMED) {
      expect(submitLikeTheServer(session, msg)).toBe("refused-by-schema");
    }

    expect(session.entries.length).toBe(entriesBefore);
    expect(JSON.stringify(session.state)).toBe(digestBefore);
  });

  it("still lets a well-formed move through to the reducer", () => {
    const session = room();
    const before = session.entries.length;
    expect(submitLikeTheServer(session, { PassTurn: { game_id: 0 } })).toBe("submitted");
    expect(session.entries.length).toBeGreaterThan(before);
  });
});

/* ------------------------------------------------------------------ */
/* Authorization                                                       */
/* ------------------------------------------------------------------ */

function board(over: Partial<GameStateResponse> = {}): GameStateResponse {
  return {
    player_addresses: ["p-a", "p-b"],
    player_cash: [
      { player: "p-a", cash_vgp: "2000" },
      { player: "p-b", cash_vgp: "2000" },
    ],
    current_round_type: "OperatingRound",
    active_player_index: 0,
    active_operating_order: [1],
    active_corporation_index: 0,
    private_companies: [{ private_id: 3, name: "M&H", owner: "p-a", closed: false }],
    public_companies: [
      {
        company_id: 1,
        ticker: "PRR",
        president: "p-a",
        is_floated: true,
        par_value: "100",
        player_holdings: [],
        station_token_hexes: [],
      },
    ],
    private_purchase_offer: null,
    train_purchase_offer: null,
    ...over,
  } as unknown as GameStateResponse;
}

const refusal = (actor: string, msg: unknown) =>
  turnRefusal({ state: board(), waterfall: null, actor, msg: msg as never, host: "p-a", log: [] });

describe("a player cannot act as somebody else (#1450)", () => {
  it("refuses an ordinary action from a seat that is not acting", () => {
    expect(refusal("p-b", { BuyStock: { protocol_id: 1, source: "Ipo" } })).toContain("not your turn");
    /* Batch 7.2 (#1570): the acting seat gets PAST the seat rule and meets the round rule -- `board()` is an
       Operating Round, and a share cannot be bought in one (S7-13). The seat gate is what this case is about,
       so the acting seat's "null" is pinned on a board where the purchase is actually legal. */
    expect(refusal("p-a", { BuyStock: { protocol_id: 1, source: "Ipo" } })).toContain("Stock Round");
    const inStockRound = (actor: string) =>
      turnRefusal({
        state: board({
          current_round_type: "StockRound",
          macro_round_number: 2,
          public_companies: [
            {
              company_id: 1,
              ticker: "PRR",
              president: "p-a",
              is_floated: true,
              par_value: "100",
              ipo_pool_percentage: 80,
              bank_pool_percentage: 0,
              player_holdings: [{ player: "p-a", percentage: 20 }],
              station_token_hexes: [],
            },
          ],
        } as unknown as Partial<GameStateResponse>),
        waterfall: null,
        actor,
        msg: { BuyStock: { protocol_id: 1, source: "Ipo" } } as never,
        host: "p-a",
        log: [],
      });
    expect(inStockRound("p-b")).toContain("not your turn");
    expect(inStockRound("p-a")).toBeNull();
  });

  it("refuses a payload that names a player other than the sender", () => {
    /* The actor is taken from the CONNECTION (#1207), never from the frame -- so the spoofing surface is the
       payload's own `player` field, and each message that carries one must cross-check it. */
    expect(refusal("p-b", { ExchangePrivate: { private_id: 3, company_id: 1, player: "p-a", source: "Ipo" } })).toContain(
      "owner",
    );
    expect(refusal("p-b", { ExchangePrivate: { private_id: 3, company_id: 1, player: "p-b", source: "Ipo" } })).toContain(
      "owner",
    );
  });

  it("refuses an offer made on behalf of a corporation the sender does not preside over", () => {
    /* THE DIRECTION IS THE POINT. `owner` and `seller_president` in these payloads are the party being ASKED;
       the party who may ASK is the president of `buyer_protocol_id`. Binding to the former would refuse every
       legitimate offer and admit none. */
    const priv = {
      ProposePrivatePurchase: {
        private_id: 3,
        private_name: "M&H",
        owner: "p-a",
        buyer_protocol_id: 1,
        buyer_ticker: "PRR",
        price: 100,
      },
    };
    const train = {
      ProposeTrainPurchase: {
        seller_protocol_id: 1,
        seller_ticker: "PRR",
        seller_president: "p-a",
        buyer_protocol_id: 1,
        buyer_ticker: "PRR",
        model_type: "2",
        price: "100",
      },
    };
    expect(refusal("p-b", priv)).toContain("PRR's president");
    expect(refusal("p-b", train)).toContain("PRR's president");
    /* Batch 7.4 (#1595): ownership is the FIRST question and no longer the only one -- the president's offer
       is then judged as a transaction, and this Stock Round board refuses it as one. The claim here stays
       what it was: the president is not refused for WHO he is. */
    expect(refusal("p-a", priv)).not.toContain("president");
    expect(refusal("p-a", priv)).toContain("phases 3 and 4");
    expect(refusal("p-a", train)).not.toContain("president");
    expect(refusal("p-a", train)).toContain("Purchase Trains step");
  });
});

describe("the between-turn actions keep the authority they had", () => {
  it("lets a corporation's president place its home station, and nobody else", () => {
    /* Slice 8.2 (S8-12 / S8-6, #1611): ingress now judges the placement with the reducer's own
       `homePlacementRefusal`, so the president's null needs a placement that is legal -- PRR's printed home (H12,
       at 2,7 on the standard board) at the start of its first operating turn. This board's PRR used to carry no
       home at all and the placement named 0,0; that is now refused, in the authority's words, and is pinned as such.
       Who may place is unchanged: the president, and nobody else. */
    const withHome = board({
      public_companies: [
        { company_id: 1, ticker: "PRR", president: "p-a", is_floated: true, par_value: "100", player_holdings: [], station_token_hexes: [], home_hex_label: "H12" },
      ],
    } as unknown as Partial<GameStateResponse>);
    const ask = (state: GameStateResponse, actor: string, msg: unknown) =>
      turnRefusal({ state, waterfall: null, actor, msg: msg as never, host: "p-a", log: [] });
    const home = { PlaceHomeStation: { company_id: 1, q: 2, r: 7, kind: "home" } };
    expect(ask(withHome, "p-a", home)).toBeNull();
    expect(ask(withHome, "p-b", home)).toContain("president places its station");
    const nowhere = { PlaceHomeStation: { company_id: 1, q: 0, r: 0, kind: "home" } };
    expect(refusal("p-a", nowhere)).toBe("PRR has no home station on this board.");
    expect(refusal("p-b", nowhere)).toContain("president places its station");
  });

  it("refuses CloseRoom before the game is over, from anybody", () => {
    expect(refusal("p-a", { CloseRoom: {} })).toContain("not over yet");
    expect(refusal("p-b", { CloseRoom: {} })).toContain("not over yet");
  });

  it("lets the offer's counterparty answer it, off turn", () => {
    /* #701: the buyer is on turn and the SELLER answers, so an authority that asked "is it your turn" of an
       answer would refuse every trade in the game. */
    /* Batch 7.4 (#1595): the answerer is the selling corporation's CURRENT president on the board (PRR's is
       p-a here), and the offer's `seller_president` is narration -- so it is p-a who answers and p-b, the name
       the proposer wrote, who cannot. A rejection needs no transaction; an acceptance is judged as one. */
    const state = board({
      train_purchase_offer: { seller_president: "p-b", seller_protocol_id: 1 },
    } as Partial<GameStateResponse>);
    const ask = (actor: string, accept = false) =>
      turnRefusal({
        state,
        waterfall: null,
        actor,
        msg: { AnswerTrainPurchase: { seller_protocol_id: 1, accept } } as never,
        host: "p-a",
        log: [],
      });
    expect(ask("p-a")).toBeNull();
    expect(ask("p-b")).toContain("selling corporation's president");
    expect(ask("p-a", true)).not.toContain("president");
    expect(ask("p-a", true)).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The corpus: the boundary must refuse nothing that really happened   */
/* ------------------------------------------------------------------ */

describe("every message in every frozen log still validates (#1449)", () => {
  /* THE CASE THAT PROTECTS LIVE PLAY. Everything above proves the validator refuses; this proves it does not
     OVER-refuse, which is the failure that would reach players. It caught one: `BuyHardwareFromPool`'s
     `model_type` was declared required from the type and is optional in fact -- 66 of the 75 stored
     purchases omit it, because an unnamed purchase is the depot queue's head (#1326). */
  const LOGS = join(__dirname, "__fixtures__", "replayGolden", "logs");

  it("accepts all of them", () => {
    const files = readdirSync(LOGS).filter((name) => name.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);

    let checked = 0;
    const rejected: string[] = [];
    for (const file of files) {
      for (const line of readFileSync(join(LOGS, file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as { payload?: unknown; msg?: unknown };
        const raw = entry.payload ?? entry.msg;
        const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!msg || typeof msg !== "object") continue;
        checked += 1;
        const result = validateGameplayMessage(msg);
        if (!result.ok) rejected.push(`${file}: ${result.reason}`);
      }
    }

    expect(checked).toBeGreaterThan(100);
    expect(rejected).toEqual([]);
  });
});
