/** @jest-environment node */
//
// ==================================================================
//  6.5-B (K-01) HARNESS: THE STOCK ROUND'S PLAYER <-> PLAYER PRIVATE TRADE, THROUGH A REAL ROOM
// ==================================================================
//
// The owner's K-01 ruling (2026-09-28 04:04) gave the D-24 transaction a surface: the Private Companies section of the
// Stock Round panel. This suite drives a `RoomSession` -- ingress, reducer, derived settle, exactly the server path --
// with the SAME view (`privateTradeSectionModel`) and the SAME message builders the shell sends, so what it proves
// is what a player at the table gets:
//
//   §1  who is offered which control (the seat holder's Sell / Buy; nothing for anybody else; SR1; watchers);
//   §2  a sell offer, accepted: the direction the section builds, cash and ownership, activity without the Buy;
//   §3  a buy offer, rejected;  §4  a rescission;
//   §5  the wrong seat: no control in the view, and the authority refuses the answer anyway;
//   §6  the hold: every seat's view is greyed with the hold's sentence, and the room refuses what it holds;
//   §7  an Accept that cash no longer covers: disabled in the view with the authority's sentence, refused by it;
//   §8  the standing offer survives a normal server restore (reload);
//   §9  the Activity Log's sentences for all three messages.
//
// No authority semantics are asserted here beyond what the section relies on; `offerMatrix74PrivateTrade.test.ts`
// owns the rule itself.

export {};

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;

const T = require("./stockRoundPrivateTrade") as typeof import("./stockRoundPrivateTrade");
const { describeGameplayAction } = require("./actionLog") as typeof import("./actionLog");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { moneyTotal } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const F = require("./offerFixtures74") as typeof import("./offerFixtures74");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

const { P1, P2, P3, PRR, NYC, DH, MH, stockRoundBoard } = F;
const { withCash, priv, cash, corp, M } = S;

const LABELS: Record<string, string> = { [P1]: "Alice", [P2]: "Bob", [P3]: "Carol" };
const label = (address: string) => LABELS[address] ?? address;
const GAME = 1;

/** SR 2, Alice (P1) seated; the D&H ($70) is Bob's, the M&H ($110) Alice's; $300 each; PRR and NYC have IPO shares so
 *  the seat's one purchase can be exercised after a trade. */
const seedBoard = (over: Record<string, unknown> = {}): GameStateResponse =>
  stockRoundBoard({
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["3"], treasury: "500", holdings: [[P1, 30], [P2, 20]], ipo: 50 },
      { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "400", price: 90, holdings: [[P2, 30], [P3, 10]], ipo: 60 },
    ],
    over: { consecutive_passes: 0, ...over } as never,
  });

const model = (state: GameStateResponse, viewer: string | null) => {
  const built = T.privateTradeSectionModel(state, viewer, label);
  if (!built) throw new Error("no section outside a Stock Round");
  return built;
};
const card = (state: GameStateResponse, viewer: string | null, privateId: number) =>
  model(state, viewer).cards.find((entry) => entry.privateId === privateId)!;

function room(seed: GameStateResponse) {
  let minted = 0;
  const session = new RoomSession({
    providers: { ...sandboxReplayProviders(), initialGrid: S.GRID },
    seed: { state: seed, waterfall: null },
    build: "b-65b",
    mintId: () => `k${(minted += 1)}`,
  });
  const submit = (actor: string, msg: unknown) =>
    session.submit({ actor, build: "b-65b", host: P1, msg: msg as never, baseIndex: session.nextIndex - 1 });
  return { session, submit };
}

/* ================================================================== */
/* §1 controls                                                          */
/* ================================================================== */

describe("§1 who gets which control", () => {
  it("the seat holder: Sell on her own private, Buy on another player's; nothing else anywhere", () => {
    const board = seedBoard();
    expect(card(board, P1, MH)).toMatchObject({ control: "sell", controlRefusal: null, owner: { kind: "player", address: P1, label: "Alice" } });
    expect(card(board, P1, DH)).toMatchObject({ control: "buy", controlRefusal: null, owner: { kind: "player", address: P2, label: "Bob" } });
    expect(model(board, P1).recipients).toEqual([
      { address: P2, label: "Bob" },
      { address: P3, label: "Carol" },
    ]);
  });

  it("an off-turn seat (the D&H's own owner included) and a third player get no control at all", () => {
    const board = seedBoard();
    for (const viewer of [P2, P3]) {
      for (const entry of model(board, viewer).cards) expect(entry.control).toBeNull();
    }
  });

  it("a seatless watcher reads every card and acts on nothing", () => {
    const board = seedBoard();
    for (const viewer of [null, "p-watcher"]) {
      const view = model(board, viewer);
      expect(view.viewerSeated).toBe(false);
      expect(view.recipients).toEqual([]);
      expect(view.cards.map((entry) => entry.control)).toEqual([null, null]);
      expect(view.cards.map((entry) => entry.owner)).toEqual([
        { kind: "player", address: P2, label: "Bob" },
        { kind: "player", address: P1, label: "Alice" },
      ]);
    }
  });

  it("each card carries identity, face value, revenue and the one-line power from the app's own catalog", () => {
    const board = seedBoard();
    const dh = card(board, P3, DH);
    expect(dh).toMatchObject({ name: "Delaware & Hudson", acronym: "DH", faceValue: 70, revenue: 10 });
    expect(dh.powerSummary).toContain("F-16");
    // Face-value order, as the auction and the ledger list them.
    expect(model(board, P3).cards.map((entry) => entry.privateId)).toEqual([DH, MH]);
  });

  it("the first Stock Round: the section says trading opens later, and the seat holder's openers are greyed with rule 1's sentence", () => {
    const board = seedBoard({ macro_round_number: 1 });
    const view = model(board, P1);
    expect(view.firstRoundNote).toContain("may not be traded between players in the first Stock Round");
    expect(view.firstRoundNote).toContain("opens in the next Stock Round");
    for (const entry of view.cards) {
      expect(entry.control).not.toBeNull();
      expect(entry.controlRefusal).toBe("Private companies may not be traded between players in the first Stock Round (rulebook 3.1).");
    }
    // And the authority agrees: the same offer is refused at the door.
    const { submit } = room(board);
    expect(submit(P1, T.proposePrivateTradeMsg(GAME, { privateId: DH, seller: P2, buyer: P1, price: 50 }))).toMatchObject({
      kind: "refused",
      reason: "Private companies may not be traded between players in the first Stock Round (rulebook 3.1).",
    });
    // Any later round: no note.
    expect(model(seedBoard(), P1).firstRoundNote).toBeNull();
  });

  it("a corporation's private and a closed private are read-only on every seat", () => {
    const board = seedBoard();
    const withCorporate = { ...board, private_companies: board.private_companies.map((entry) => (entry.private_id === DH ? { ...entry, owner: null, owner_protocol_id: NYC } : entry)) } as GameStateResponse;
    expect(card(withCorporate, P1, DH)).toMatchObject({ control: null, owner: { kind: "corporation", ticker: "NYC" } });
    const withClosed = { ...board, private_companies: board.private_companies.map((entry) => (entry.private_id === MH ? { ...entry, closed: true } : entry)) } as GameStateResponse;
    expect(card(withClosed, P1, MH)).toMatchObject({ control: null, owner: { kind: "closed" } });
  });

  it("outside a Stock Round there is no section", () => {
    expect(T.privateTradeSectionModel(F.operatingBoard(), P1, label)).toBeNull();
    expect(T.privateTradeSectionModel(null, P1, label)).toBeNull();
  });
});

/* ================================================================== */
/* §2 a sell offer, accepted                                            */
/* ================================================================== */

describe("§2 a sell offer, accepted", () => {
  it("Alice sells the M&H to Bob: seller = viewer, buyer = recipient; Bob accepts off-turn; cash and card move; the Buy is still hers", () => {
    const seed = seedBoard();
    const { session, submit } = room(seed);
    // What the section sends for `Sell → Bob → $150 → Send Offer`.
    const intent = { privateId: MH, seller: P1, buyer: P2, price: 150 };
    expect(T.privateTradeProposalRefusal(session.state, P1, intent, label)).toBeNull();
    expect(submit(P1, T.proposePrivateTradeMsg(GAME, intent)).kind).toBe("applied");
    expect(session.state.private_trade_offer).toMatchObject({ private_id: MH, seller: P1, buyer: P2, price: 150, proposer: P1 });

    // Every seat sees it on the M&H card; only Bob is the counterparty.
    for (const viewer of [P1, P2, P3, null]) {
      const offer = card(session.state, viewer, MH).offer!;
      expect(offer.summary).toBe("Alice offers to sell Mohawk & Hudson to Bob for $150 — waiting for Bob.");
      expect(offer.direction).toBe("sell");
      expect(card(session.state, viewer, DH).offer).toBeNull();
    }
    expect(card(session.state, P1, MH).offer!.viewerRole).toBe("proposer");
    expect(card(session.state, P2, MH).offer!.viewerRole).toBe("counterparty");
    expect(card(session.state, P3, MH).offer!.viewerRole).toBe("other");
    expect(card(session.state, null, MH).offer!.viewerRole).toBe("other");
    expect(card(session.state, P2, MH).offer!.acceptRefusal).toBeNull();

    // Bob accepts, OFF-TURN, with the section's own message.
    expect(submit(P2, T.answerPrivateTradeMsg(GAME, MH, true)).kind).toBe("applied");
    expect(session.state.private_trade_offer ?? null).toBeNull();
    expect(priv(session.state, MH)).toMatchObject({ owner: P2, owner_protocol_id: null });
    expect([cash(session.state, P1), cash(session.state, P2), cash(session.state, P3)]).toEqual([450, 150, 300]);
    expect(moneyTotal(session.state)).toBe(moneyTotal(seed));
    // Activity (D-27), and the Buy action untouched.
    expect(session.state.turn_action_taken).toBe(true);
    expect(session.state.bought_this_turn ?? 0).toBe(0);
    expect(session.state.active_player_index).toBe(0);
    expect(submit(P1, M.buyStock(PRR)).kind).toBe("applied");
    expect(corp(session.state, PRR).player_holdings).toContainEqual({ player: P1, percentage: 40 });
    // The card now reads the new owner for everyone.
    expect(card(session.state, P3, MH).owner).toEqual({ kind: "player", address: P2, label: "Bob" });
  });
});

/* ================================================================== */
/* §3 a buy offer, rejected                                             */
/* ================================================================== */

describe("§3 a buy offer, rejected", () => {
  it("Alice offers Bob $60 for the D&H: seller = displayed owner, buyer = viewer; Bob rejects; nothing moves", () => {
    const seed = seedBoard();
    const { session, submit } = room(seed);
    const intent = { privateId: DH, seller: P2, buyer: P1, price: 60 };
    expect(card(seed, P1, DH).control).toBe("buy");
    expect(submit(P1, T.proposePrivateTradeMsg(GAME, intent)).kind).toBe("applied");
    const offer = card(session.state, P3, DH).offer!;
    expect(offer).toMatchObject({ direction: "buy", proposer: P1, counterparty: P2, price: 60 });
    expect(offer.summary).toBe("Alice offers Bob $60 for Delaware & Hudson — waiting for Bob.");
    expect(submit(P2, T.answerPrivateTradeMsg(GAME, DH, false)).kind).toBe("applied");
    expect(session.state.private_trade_offer ?? null).toBeNull();
    expect(priv(session.state, DH).owner).toBe(P2);
    expect([cash(session.state, P1), cash(session.state, P2)]).toEqual([300, 300]);
    expect(session.state.turn_action_taken ?? false).toBe(false);
    // Nothing stands any more: the openers are back for the seat holder.
    expect(card(session.state, P1, DH).control).toBe("buy");
  });
});

/* ================================================================== */
/* §4 rescission                                                        */
/* ================================================================== */

describe("§4 the proposer rescinds", () => {
  it("only the proposer's view offers it, and the room applies it from her and refuses it from anyone else", () => {
    const { session, submit } = room(seedBoard());
    expect(submit(P1, T.proposePrivateTradeMsg(GAME, { privateId: MH, seller: P1, buyer: P3, price: 0 })).kind).toBe("applied");
    expect(card(session.state, P1, MH).offer!.viewerRole).toBe("proposer");
    expect(submit(P3, T.rescindPrivateTradeMsg(GAME, MH))).toMatchObject({ kind: "refused", reason: "Only the player who made this offer can withdraw it." });
    expect(submit(P2, T.rescindPrivateTradeMsg(GAME, MH))).toMatchObject({ kind: "refused" });
    expect(submit(P1, T.rescindPrivateTradeMsg(GAME, MH)).kind).toBe("applied");
    expect(session.state.private_trade_offer ?? null).toBeNull();
    expect(priv(session.state, MH).owner).toBe(P1);
  });
});

/* ================================================================== */
/* §5 the wrong seat                                                    */
/* ================================================================== */

describe("§5 an answer from the wrong seat", () => {
  it("the proposer and a third player are never the counterparty, and the room refuses their answer", () => {
    const { session, submit } = room(seedBoard());
    expect(submit(P1, T.proposePrivateTradeMsg(GAME, { privateId: DH, seller: P2, buyer: P1, price: 50 })).kind).toBe("applied");
    expect(card(session.state, P1, DH).offer!.viewerRole).toBe("proposer");
    expect(card(session.state, P3, DH).offer!.viewerRole).toBe("other");
    const handed = stateDigest(session.state);
    expect(submit(P1, T.answerPrivateTradeMsg(GAME, DH, true))).toMatchObject({ kind: "refused", reason: "You made this offer; only the other party can answer it." });
    expect(submit(P3, T.answerPrivateTradeMsg(GAME, DH, true))).toMatchObject({ kind: "refused", reason: "Only the other party to this trade can answer it." });
    expect(submit(P3, T.answerPrivateTradeMsg(GAME, DH, false))).toMatchObject({ kind: "refused" });
    expect(stateDigest(session.state)).toBe(handed);
  });
});

/* ================================================================== */
/* §6 the hold                                                          */
/* ================================================================== */

describe("§6 the standing offer holds the table, and every seat is told so", () => {
  it("the hold's own sentence, labelled, for every seat; the room refuses what it holds; openers vanish", () => {
    const { session, submit } = room(seedBoard());
    expect(T.privateTradeHoldReason(session.state, label)).toBeNull();
    expect(submit(P1, T.proposePrivateTradeMsg(GAME, { privateId: DH, seller: P2, buyer: P1, price: 50 })).kind).toBe("applied");
    const hold = T.privateTradeHoldReason(session.state, label)!;
    expect(hold).toBe("Delaware & Hudson is on offer between Bob and Alice for $50 and is waiting for an answer; nothing else can happen until it is answered or withdrawn.");
    // What the room says to the seat holder's Pass and Buy is the same sentence (with ids).
    const pass = submit(P1, M.pass);
    const buy = submit(P1, M.buyStock(PRR));
    expect(pass.kind).toBe("refused");
    expect(buy.kind).toBe("refused");
    expect(T.labelSentence((pass as { reason: string }).reason, session.state.player_addresses, label)).toBe(hold);
    expect(T.labelSentence((buy as { reason: string }).reason, session.state.player_addresses, label)).toBe(hold);
    // The M&H's exchange (Alice owns it; not turn-gated) is held too -- the shell greys its chip with this sentence.
    const exchange = submit(P1, { ExchangePrivate: { game_id: GAME, private_id: MH, company_id: NYC, player: P1, source: "Ipo" } });
    expect(exchange.kind).toBe("refused");
    expect(T.labelSentence((exchange as { reason: string }).reason, session.state.player_addresses, label)).toBe(hold);
    // A second offer is not offered to anyone while this one stands.
    for (const viewer of [P1, P2, P3]) for (const entry of model(session.state, viewer).cards) expect(entry.control).toBeNull();
    // Answered: the hold lifts.
    expect(submit(P2, T.answerPrivateTradeMsg(GAME, DH, false)).kind).toBe("applied");
    expect(T.privateTradeHoldReason(session.state, label)).toBeNull();
  });
});

/* ================================================================== */
/* §7 an acceptance cash no longer covers                               */
/* ================================================================== */

describe("§7 Accept after the buyer's cash has changed", () => {
  it("the counterparty's Accept carries the authority's sentence, and the authority refuses it with that sentence", () => {
    const { session, submit } = room(seedBoard());
    expect(submit(P2, T.proposePrivateTradeMsg(GAME, { privateId: DH, seller: P2, buyer: P1, price: 250 })).kind).toBe("refused"); // not Bob's turn
    expect(submit(P1, T.proposePrivateTradeMsg(GAME, { privateId: MH, seller: P1, buyer: P2, price: 250 })).kind).toBe("applied");
    // The board changes under the offer (a fixture edit: nothing legal can move cash while the hold stands).
    const drained = withCash(session.state, P2, 100);
    const offer = card(drained, P2, MH).offer!;
    expect(offer.viewerRole).toBe("counterparty");
    expect(offer.acceptRefusal).toBe("Bob holds $100 and cannot pay $250.");
    // Every other seat's card says the same thing about Bob's answer.
    expect(card(drained, P3, MH).offer!.acceptRefusal).toBe("Bob holds $100 and cannot pay $250.");
    // And the server says it (with the id), leaving the offer standing for a Reject or a rescission.
    const drainedRoom = room(drained);
    expect(drainedRoom.submit(P2, T.answerPrivateTradeMsg(GAME, MH, true))).toMatchObject({ kind: "refused", reason: `${P2} holds $100 and cannot pay $250.` });
    expect(drainedRoom.session.state.private_trade_offer).not.toBeNull();
    expect(drainedRoom.submit(P2, T.answerPrivateTradeMsg(GAME, MH, false)).kind).toBe("applied");
  });

  it("the Send Offer refusal is the proposal predicate's, per recipient, at the price typed", () => {
    const board = withCash(seedBoard(), P3, 40);
    expect(T.privateTradeProposalRefusal(board, P1, { privateId: MH, seller: P1, buyer: P3, price: 50 }, label)).toBe("Carol holds $40 and cannot pay $50.");
    expect(T.privateTradeProposalRefusal(board, P1, { privateId: MH, seller: P1, buyer: P3, price: 40 }, label)).toBeNull();
    expect(T.privateTradeProposalRefusal(board, P1, { privateId: MH, seller: P1, buyer: P2, price: 0 }, label)).toBeNull(); // a gift
    // Not the seat holder: the authority's own sentence.
    expect(T.privateTradeProposalRefusal(board, P2, { privateId: DH, seller: P2, buyer: P3, price: 10 }, label)).toBe(
      "A private-company trade is proposed on your own Stock Round turn.",
    );
    expect(T.privateTradeProposalRefusal(board, null, { privateId: DH, seller: P2, buyer: P1, price: 10 }, label)).toBe("Only a seated player can propose a trade.");
  });
});

/* ================================================================== */
/* §8 restore                                                           */
/* ================================================================== */

describe("§8 the standing offer survives a normal server restore (reload)", () => {
  it("a room rebuilt from the stored entries holds the same offer, shows it on the same card, and still settles", () => {
    const seed = seedBoard();
    const live = room(seed);
    expect(live.submit(P1, T.proposePrivateTradeMsg(GAME, { privateId: MH, seller: P1, buyer: P2, price: 120 })).kind).toBe("applied");
    let minted = 0;
    const restored = new RoomSession({
      providers: { ...sandboxReplayProviders(), initialGrid: S.GRID },
      seed: { state: seed, waterfall: null },
      build: "b-65b",
      mintId: () => `r${(minted += 1)}`,
    });
    restored.restore(live.session.entries);
    expect(stateDigest(restored.state)).toBe(stateDigest(live.session.state));
    expect(restored.state.private_trade_offer).toMatchObject({ private_id: MH, proposer: P1, price: 120 });
    expect(card(restored.state, P2, MH).offer!.viewerRole).toBe("counterparty");
    expect(T.privateTradeHoldReason(restored.state, label)).not.toBeNull();
    const answer = restored.submit({ actor: P2, build: "b-65b", host: P1, msg: T.answerPrivateTradeMsg(GAME, MH, true) as never, baseIndex: restored.nextIndex - 1 });
    expect(answer.kind).toBe("applied");
    expect(priv(restored.state, MH).owner).toBe(P2);
  });
});

/* ================================================================== */
/* §9 narration                                                         */
/* ================================================================== */

describe("§9 the Activity Log names every step", () => {
  const context = (gameState: GameStateResponse) => ({
    gameState,
    mapGrid: S.GRID,
    era: "Yellow" as const,
    labelForAddress: label,
  });

  it("sell offer, buy offer, accepted, rejected, withdrawn", () => {
    const board = seedBoard();
    expect(describeGameplayAction(T.proposePrivateTradeMsg(GAME, { privateId: MH, seller: P1, buyer: P2, price: 150 }), context(board))).toBe(
      "Alice offers to sell Mohawk & Hudson to Bob for $150. Bob must answer.",
    );
    expect(describeGameplayAction(T.proposePrivateTradeMsg(GAME, { privateId: DH, seller: P2, buyer: P1, price: 60 }), context(board))).toBe(
      "Alice offers Bob $60 for Delaware & Hudson. Bob must answer.",
    );
    const { session, submit } = room(board);
    submit(P1, T.proposePrivateTradeMsg(GAME, { privateId: DH, seller: P2, buyer: P1, price: 60 }));
    const offered = session.state;
    expect(describeGameplayAction(T.answerPrivateTradeMsg(GAME, DH, true), context(offered))).toBe(
      "Bob accepted: Alice bought Delaware & Hudson from Bob for $60.",
    );
    expect(describeGameplayAction(T.answerPrivateTradeMsg(GAME, DH, false), context(offered))).toBe(
      "Bob rejected Alice's offer of $60 for Delaware & Hudson.",
    );
    expect(describeGameplayAction(T.rescindPrivateTradeMsg(GAME, DH), context(offered))).toBe(
      "Alice withdrew the offer of $60 for Delaware & Hudson.",
    );
    // Nothing standing: the answer and the withdrawal have nothing to say (a harmless duplicate).
    expect(describeGameplayAction(T.answerPrivateTradeMsg(GAME, DH, true), context(board))).toBeNull();
    expect(describeGameplayAction(T.rescindPrivateTradeMsg(GAME, DH), context(board))).toBeNull();
  });
});

/* ================================================================== */
/* helpers                                                              */
/* ================================================================== */

describe("the section's two presentation helpers", () => {
  it("parses whole dollars only, $0 included", () => {
    expect(T.parseWholeDollars("0")).toBe(0);
    expect(T.parseWholeDollars(" 150 ")).toBe(150);
    expect(T.parseWholeDollars("$75")).toBe(75);
    for (const bad of ["", "-1", "1.5", "1e2", "abc", "10 0"]) expect(T.parseWholeDollars(bad)).toBeNull();
  });

  it("labels a seated player's id inside an authority sentence and leaves everything else alone", () => {
    expect(T.labelSentence("p1 holds $10 and cannot pay $20.", [P1, P2], label)).toBe("Alice holds $10 and cannot pay $20.");
    expect(T.labelSentence("nothing to label", [P1], label)).toBe("nothing to label");
  });
});
