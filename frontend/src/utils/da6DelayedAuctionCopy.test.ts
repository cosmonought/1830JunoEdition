/** @jest-environment node */
//
// ==================================================================
//  DA-6: THE DELAYED AUCTION'S PLAYER-VISIBLE CONSEQUENCES (DA-F8, and what DA-6 found beside it)
// ==================================================================
//
// `VARIANT_CERT_DELAYED_AUCTION_AUDIT_2026-09-25.md` §14 (DA-F8a-n) and the DA-5 record's must-sell note, asserted as
// claims about the engine's sentences and the copy tables -- the rendered surfaces are `components/da6DelayedAuctionUi.test.tsx`.
// Every Delayed Auction reading is asserted beside the standard game's, which must read exactly as before (variant
// isolation, the brief's §14).

export {};

type State = import("../gameEngine/gameState").GameStateResponse;
type Room = InstanceType<typeof import("./roomSession").RoomSession>;

const FD = require("../gameEngine/forcedDivestment") as typeof import("../gameEngine/forcedDivestment");
const { autoPassDecision } = require("./autoPass") as typeof import("./autoPass");
const { privatesBuyableNow, hasBuyablePrivate } =
  require("../gameEngine/operatingSubPhase") as typeof import("../gameEngine/operatingSubPhase");
const { sharePurchaseBlock, reservedIpoRefusal } =
  require("../gameEngine/sharePurchase") as typeof import("../gameEngine/sharePurchase");
const GV = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const { PRIVATE_COMPANY_CATALOG } = require("./privateCatalog") as typeof import("./privateCatalog");
const { describeGameplayAction } = require("./actionLog") as typeof import("./actionLog");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { withEmptyRoster, waterfallForRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const SS = require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { readStripped, readShell } = require("./sourceScan") as typeof import("./sourceScan");

/* ================================================================================================== */
describe("the must-sell sentence (DA-F8 / DA-5's note; D-53, D-57, D-58)", () => {
  const ME = "me";
  const PRR = 1;
  const zoneForPrice = (price: number | null | undefined) => (price == null ? "Normal" : price <= 60 ? "Yellow" : "Normal");
  const board = (over: Record<string, unknown> = {}, pool = 20) =>
    ({
      player_addresses: [ME, "rival"],
      player_cash: [{ player: ME, cash_vgp: "500" }, { player: "rival", cash_vgp: "500" }],
      private_companies: [],
      current_round_type: "StockRound",
      macro_round_number: 4,
      active_player_index: 0,
      consecutive_passes: 0,
      public_companies: [
        {
          company_id: PRR, ticker: "PRR", is_floated: true, president: ME, par_value: "100",
          ipo_pool_percentage: 0, bank_pool_percentage: pool, treasury: "0",
          player_holdings: [{ player: ME, percentage: 80 }], station_token_hexes: [],
        },
      ],
      ...over,
    }) as unknown as State;
  const debt = (state: State) => FD.divestmentDebt({ state, player: ME, marketPrices: { [PRR]: 100 }, zoneForPrice });
  const DELAYED = { variants: { delayedAuction: true } };

  it("keeps the standard game's sentence, byte for byte, for a debt a sale can fully cure", () => {
    expect(FD.divestmentRefusal(debt(board()))).toBe(
      "Those shares left the Yellow/Orange/Brown zones, so they now count: you are 20% over the 60% cap in PRR (80% held). Sell down before buying or passing.",
    );
  });

  it("does not blame a zone exit at a Delayed Auction table -- it names the auction too, and the curable-only rule", () => {
    const d = debt(board(DELAYED));
    expect(d.delayedAuction).toBe(true);
    const sentence = FD.divestmentRefusal(d) as string;
    expect(sentence).not.toContain("Those shares left");
    expect(sentence).toContain("20% over the 60% cap in PRR (80% held)");
    expect(sentence).toContain("delayed auction");
    expect(sentence).toContain("sell what a legal sale can fix before buying or passing");
    expect(sentence).toBe(FD.delayedAuctionDivestmentSentence("20% over the 60% cap in PRR (80% held)"));
  });

  it("prints the excess as it stands, and the owed part beside it when some of it no sale can fix", () => {
    /* 80% held, 40% already in the Bank Pool: the pool takes one more card, so 10 of the 20 points can be sold. */
    const partial = FD.divestmentRefusal(debt(board(DELAYED, 40))) as string;
    expect(partial).toContain("20% over the 60% cap in PRR (80% held; 10% of it can be sold now)");
    // And a debt nothing can cure is not owed at all (D-58): no sentence, so nothing is held.
    expect(FD.divestmentRefusal(debt(board(DELAYED, 50)))).toBeNull();
  });

  it("the same sentence refuses a purchase of another corporation (the panel's gate) -- one string for every surface", () => {
    /* Of ANOTHER corporation: a purchase of PRR itself meets the 60% cap first, which is the gate's order and not
       this pass's to change. */
    const base = board(DELAYED);
    const state = {
      ...base,
      public_companies: [
        ...base.public_companies,
        { company_id: 2, ticker: "B&O", is_floated: true, president: "rival", par_value: "100", ipo_pool_percentage: 40,
          bank_pool_percentage: 10, treasury: "0", player_holdings: [{ player: "rival", percentage: 50 }], station_token_hexes: [] },
      ],
    } as unknown as State;
    const refusal = sharePurchaseBlock({
      state, buyer: ME, companyId: 2, source: "Bank", quantity: 1, zone: "Normal",
      marketPrices: { [PRR]: 100, 2: 100 }, zoneForPrice,
    });
    expect(refusal).toBe(FD.divestmentRefusal(debt(state)));
    expect(refusal).toContain("delayed auction");
  });

  it("wakes auto-pass with the table's own causes", () => {
    const arm = { player: ME, macroRoundNumber: 4, snapshot: {}, divestmentOwed: true } as never;
    const classic = autoPassDecision(board(), arm);
    const delayed = autoPassDecision(board(DELAYED), arm);
    expect(classic.wakeReason).toBe(FD.divestmentWakeReason(false));
    expect(classic.wakeReason).toContain("left the Yellow/Orange/Brown zones");
    expect(delayed.wakeReason).toBe(FD.divestmentWakeReason(true));
    expect(delayed.wakeReason).toContain("delayed auction");
    for (const reason of [classic.wakeReason, delayed.wakeReason]) expect(reason).toMatch(/must sell down before passing/);
  });
});

/* ================================================================================================== */
describe("DA-F8k: Buy Private Company is not offered over privates nobody owns", () => {
  const unsold = [1, 2, 3].map(() => ({ closed: false, owner_protocol_id: null, owner: null }));
  it("is hidden in the first 3-train's set of a Delayed Auction game, while every private is unsold", () => {
    expect(hasBuyablePrivate(unsold)).toBe(false);
    expect(privatesBuyableNow("Green", unsold, "3")).toBe(false);
  });
  it("is offered once a player holds one -- and a caller that does not carry `owner` reads as before", () => {
    expect(privatesBuyableNow("Green", [...unsold, { closed: false, owner_protocol_id: null, owner: "p1" }], "3")).toBe(true);
    expect(privatesBuyableNow("Green", [{ closed: false, owner_protocol_id: null }], "3")).toBe(true);
  });
});

/* ================================================================================================== */
describe("D-52: the PRR share held for the C&A is refused with its reason, at the button and at both locks", () => {
  const A = "p-da6-a01";
  const B = "p-da6-b02";
  const C = "p-da6-c03";
  const BUILD = "b-da6";
  const seed = () => ({
    state: withEmptyRoster(SS.sandboxScenarioState(SS.DEFAULT_SANDBOX_SCENARIO, 0, "default")),
    waterfall: waterfallForRoster(SS.sandboxWaterfallState(SS.sandboxScenario(SS.DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
  });
  const PASS = { PassTurn: { game_id: 0 } };
  function roomDealt(delayed: boolean): Room {
    let n = 0;
    const room = new RoomSession({ providers: sandboxReplayProviders(), seed: seed() as never, build: BUILD, mintId: () => `d${(n += 1)}` });
    const setup = { SetupGame: { players: [{ id: A, nickname: "A" }, { id: B, nickname: "B" }, { id: C, nickname: "C" }], variants: { delayedAuction: delayed, length: "standard", rules: 1 } } };
    expect(room.submit({ actor: A, build: BUILD, msg: setup as never, baseIndex: -1, host: A }).kind).toBe("applied");
    return room;
  }
  const submit = (room: Room, actor: string, msg: unknown) =>
    room.submit({ actor, build: BUILD, msg: msg as never, baseIndex: room.nextIndex - 1, host: A });
  const seat = (room: Room) => room.state.player_addresses[room.state.active_player_index];
  const prrOf = (room: Room) => room.state.public_companies.find((c) => c.ticker === "PRR")!;
  const heldBy = (room: Room, player: string) => prrOf(room).player_holdings.find((h) => h.player === player)?.percentage ?? 0;

  it("a Delayed Auction Stock Round 1 sells the PRR down to the reserved 10%; the next buyer is told why", () => {
    const room = roomDealt(true);
    expect(prrOf(room).reserved_certificate).toEqual({ private_id: 5, percentage: 10 });
    for (let guard = 0; ; guard += 1) {
      if (guard > 40) throw new Error("the PRR's ordinary IPO did not sell out");
      const prr = prrOf(room);
      if (prr.president !== null && prr.ipo_pool_percentage <= 10) break;
      const who = seat(room);
      const wants = (who === A && heldBy(room, A) < 60) || (who === B && heldBy(room, B) < 30);
      expect(submit(room, who, PASS).kind).toBe("applied"); // Sell -> Buy (#1443)
      if (wants) {
        const buy = { BuyStock: { game_id: 0, protocol_id: prr.company_id, source: "Ipo", ...(prr.president === null ? { par_value: "100" } : {}) } };
        expect(submit(room, who, buy).kind).toBe("applied");
      }
      expect(submit(room, who, PASS).kind).toBe("applied");
    }
    const prr = prrOf(room);
    expect(prr.ipo_pool_percentage).toBe(10); // the bank still owns it (DA-5): holdings + IPO + pool = 100%
    const buyer = seat(room);
    expect(submit(room, buyer, PASS).kind).toBe("applied"); // to the Buy stage
    const sentence = reservedIpoRefusal(prr, "Ipo", 10) as string;
    expect(sentence).toBe(
      "The 10% of PRR left in the IPO is held for whoever buys the C&A in the delayed private company auction — no one else can buy it.",
    );
    const buy = { BuyStock: { game_id: 0, protocol_id: prr.company_id, source: "Ipo" } };
    // Ingress (the reducer's rule 5 answers first, with the same sentence) ...
    expect(turnRefusal({ state: room.state, waterfall: room.state.waterfall ?? null, actor: buyer, msg: buy as never })).toBe(sentence);
    // ... the panel's own gate ...
    expect(
      sharePurchaseBlock({ state: room.state, buyer, companyId: prr.company_id, source: "Ipo", quantity: 1, zone: "Normal", marketPrices: {}, zoneForPrice: () => "Normal" }),
    ).toBe(sentence);
    // ... and the room: refused, nothing appended.
    const before = room.entries.length;
    const answer = submit(room, buyer, buy);
    expect(answer).toMatchObject({ kind: "refused", reason: sentence });
    expect(room.entries).toHaveLength(before);
  });

  it("reserves nothing in the standard game, so its IPO purchases never meet the sentence", () => {
    const room = roomDealt(false);
    for (const company of room.state.public_companies) {
      expect(company.reserved_certificate ?? null).toBeNull();
      expect(reservedIpoRefusal({ ...company, president: "x" }, "Ipo", 10)).toBeNull();
    }
  });
});

/* ================================================================================================== */
describe("DA-F8m: the Activity Log says the delayed auction has begun", () => {
  const nyc = { company_id: 3, ticker: "NYC", president: "C", player_holdings: [], is_floated: true } as never;
  const before = {
    current_round_type: "OperatingRound", active_operating_order: [3], active_corporation_index: 0,
    player_addresses: ["A", "B", "C"], active_player_index: 2, priority_deal_index: 1, public_companies: [nyc],
  } as unknown as State;
  const context = (after: State) =>
    ({ gameState: before, afterState: after, mapGrid: { tiles: [] } as never, era: "Green" as never, labelForAddress: (a: string) => `Player ${a}` }) as never;
  const PASS = { PassTurn: { game_id: 0 } } as never;

  it("on the turn that ends the first 3-train's set, naming who opens the auction", () => {
    const armed = { ...before, current_round_type: "WaterfallAuction", waterfall: { current_turn: "B" } } as unknown as State;
    expect(describeGameplayAction(PASS, context(armed))).toBe(
      "NYC ended its turn. The Operating Round set with the first 3-train is over — the delayed private company auction begins, and Player B holds the Priority Deal and acts first.",
    );
  });

  it("and says nothing extra on any other turn's end", () => {
    const next = { ...before, current_round_type: "StockRound" } as unknown as State;
    expect(describeGameplayAction(PASS, context(next))).toBe("NYC ended its turn.");
    expect(describeGameplayAction(PASS, context(before))).toBe("NYC ended its turn.");
  });
});

/* ================================================================================================== */
describe("the copy tables (DA-F8a, DA-F8i, DA-F8j, DA-F8c/d)", () => {
  it("D-56: the lobby blurb says when the auction runs, and keeps its warning", () => {
    const blurb = GV.VARIANT_COPY.delayedAuction.blurb;
    expect(blurb).not.toContain("start of Phase 3");
    expect(blurb).toContain("after the Operating Round set in which the first 3-train is purchased, immediately before the next Stock Round");
    expect(blurb).toContain("Watch your cash carefully or your rivals might get the advantage!");
  });

  it("DA-F8j: the B&O card says the lock lifts when the auction is over", () => {
    expect(GV.BO_LOCKED_CARD_NOTE).toBe("Inactive until the delayed private company auction is over.");
    expect(GV.BO_LOCKED_CARD_NOTE).not.toContain("purchased");
  });

  it("DA-F8i: the C&A's long text no longer says the PRR is not operating", () => {
    const ca = PRIVATE_COMPANY_CATALOG[5].ability;
    expect(ca).not.toContain("will not be operating yet");
    expect(ca).not.toContain("held or sold like any other");
    expect(ca).toContain("whether or not the PRR has started yet");
  });

  it("DA-F8c/d: one title and one status line for the delayed auction, naming the Stock Round that follows", () => {
    expect(GV.DELAYED_AUCTION_TITLE).toBe("Delayed Private Company Auction");
    const line = GV.delayedAuctionUnderway(4);
    expect(line).toContain("Stock Round 4 opens once every private company is sold");
    expect(line).toContain("no Stock Round or Operating Round turns");
    expect(line).not.toContain("Stock Round 1");
  });
});

/* ================================================================================================== */
describe("source pins: the shell hands the surfaces the table's own facts", () => {
  const app = readShell();
  it("the auction's handoff modal gets the real next Stock Round (DA-F8b)", () => {
    expect(app).toContain("nextStockRound={gameState?.macro_round_number ?? 1}");
    expect(app).toContain("delayedAuction={tableVariants.delayedAuction === true}");
    expect(app).not.toContain('"The Waterfall Auction is complete \\u2014 Stock Round 1 begins."');
  });
  it("the tutorials read the Delayed Auction's lessons on its tables (DA-F8h)", () => {
    /* PHASE 3 FINAL PLAY TUTORIAL: one scope, handed to the coach and the library alike (`tutorial/lessons.ts`
       `lessonText`); the rendered wording is asserted in `da6DelayedAuctionUi.test.tsx`. */
    expect(app).toContain("const tutorialScope = useMemo(() => ({ delayedAuction: tableVariants.delayedAuction === true }), [tableVariants]);");
    expect((app.match(/scope=\{tutorialScope\}/g) ?? []).length).toBe(2);
  });
  it("the dashboard and the sub-panel read the shared title and status line (DA-F8c, DA-F8d)", () => {
    const dashboard = readStripped("components/WaterfallAuctionDashboard.tsx");
    const panel = readStripped("components/ContextualSubPanel.tsx");
    expect(dashboard).toContain("delayedAuctionUnderway(nextStockRound)");
    expect(panel).toContain("delayedAuctionUnderway(nextStockRound)");
    expect(dashboard).toContain("DELAYED_AUCTION_TITLE");
    expect(panel).toContain("DELAYED_AUCTION_TITLE");
  });
});
