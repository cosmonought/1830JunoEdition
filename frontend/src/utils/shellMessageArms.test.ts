/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1198 (harness): THE FIVE THE REPLAY CANNOT REACH
// ==================================================================
//
// `replayJuno3XD.test.ts` is the guard for the reducer's lifecycle arms, and it earns that by executing a
// real recorded game. It cannot cover these five: neither negotiation pair nor `CloseRoom` appears anywhere
// in `JUNO-3XD`, so a replay that is green says nothing whatever about them.
//
// SO THEY ARE COVERED CASE BY CASE HERE, and the distinction is deliberate rather than apologetic. "Faithful
// on one log" and "correct" are different claims, and the second needs cases the first never produced.
//
// ==================================================================
//  DESIGN NOTE 1247 REDRAWS THE BOUNDARY THIS FILE WAS PINNING
// ==================================================================
//
// #1198 held that an accepted offer's purchase "belongs to the shell, because #576 is explicit that a
// consequence is derived by every client and never appended by each of them." The shell's dispatch ran in the
// DRAIN -- on every client, for every entry -- so every seated browser appended it. That was #576's fault, in
// the branch that cited #576. The purchase is now a DERIVED action (#1203): the answer arm records the yes,
// `nextDerivedAction` owes the purchase, one writer appends it, every client applies it. The old "boundary"
// case asserted the reducer must not buy on an accept; it must still not -- the arm records, the derived
// entry buys -- and the assertion below is the same one with the mechanism named.

export {};

const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { nextDerivedAction } = require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
const { operatingBoard, P2, PRR, NYC, DH } = require("./offerFixtures74") as typeof import("./offerFixtures74");
import type { MapGridResponse } from "../components/hexContractTypes";

type State = import("../gameEngine/gameState").GameStateResponse;

/* Batch 7.4 (#1591/#1592): the offers now have an authority in front of them -- an Operating Round, the buyer
   operating (at Hardware for a train), phase 3, a player-owned open private inside its band, a seller that owns
   the train -- so the board these arms are exercised on is a LEGAL one, and the counterparty they record is
   the BOARD's (the D&H's owner P2; NYC's president P2), never the payload's. Without a chart, so the identity
   assertions below (`toBe`) still hold as they did on the opening scenario. */
const base = (): State => operatingBoard({ over: { market_positions: undefined } });
const GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

const PRIVATE_OFFER = {
  private_id: DH,
  private_name: "Delaware & Hudson",
  owner: P2,
  buyer_protocol_id: PRR,
  buyer_ticker: "PRR",
  price: 100,
};

const TRAIN_OFFER = {
  seller_protocol_id: NYC,
  seller_ticker: "NYC",
  seller_president: P2,
  buyer_protocol_id: PRR,
  buyer_ticker: "PRR",
  model_type: "3",
  // See turnAuthority.test.ts: the two offer types disagree about this field's type.
  price: "150",
};

/* #1597 (Batch 7.4, R74-B): the proposal arm numbers every ordinary offer -- `instance` on the offer, `offer_serial`
   on the board -- so the recorded offer is the payload's narration plus its lifecycle identity. */
const RECORDED_PRIVATE_OFFER = { ...PRIVATE_OFFER, instance: 1 };
const RECORDED_TRAIN_OFFER = { ...TRAIN_OFFER, instance: 1 };

describe("the private negotiation, #662 / #1247", () => {
  it("records the offer on the board so every client sees the same one", () => {
    const after = applySandboxAction(base(), {
      ProposePrivatePurchase: PRIVATE_OFFER,
    } as never);
    expect(after.private_purchase_offer).toEqual(RECORDED_PRIVATE_OFFER);
    expect(after.offer_serial).toBe(1);
  });

  it("a no clears the offer; a yes records it as accepted", () => {
    const offered = applySandboxAction(base(), {
      ProposePrivatePurchase: PRIVATE_OFFER,
    } as never);
    const declined = applySandboxAction(offered, {
      AnswerPrivatePurchase: { private_id: DH, accept: false },
    } as never);
    expect(declined.private_purchase_offer).toBeNull();
    const accepted = applySandboxAction(offered, {
      AnswerPrivatePurchase: { private_id: DH, accept: true },
    } as never);
    expect(accepted.private_purchase_offer).toEqual({ ...RECORDED_PRIVATE_OFFER, accepted: true });
  });

  it("treats a second answer as nothing to do rather than as an error", () => {
    /* #662: "the first answer settles it, the second finds nothing". A replayed duplicate must take this arm
       and change nothing -- a refusal that threw would kill a rebuild. And an answer to an ACCEPTED offer is
       a second answer too. */
    const settled = applySandboxAction(base(), {
      AnswerPrivatePurchase: { private_id: DH, accept: true },
    } as never);
    expect(settled.private_purchase_offer ?? null).toBeNull();
    const offered = applySandboxAction(base(), { ProposePrivatePurchase: PRIVATE_OFFER } as never);
    const accepted = applySandboxAction(offered, { AnswerPrivatePurchase: { private_id: DH, accept: true } } as never);
    expect(applySandboxAction(accepted, { AnswerPrivatePurchase: { private_id: DH, accept: false } } as never)).toBe(accepted);
  });

  it("ignores an answer aimed at a different private", () => {
    const offered = applySandboxAction(base(), {
      ProposePrivatePurchase: PRIVATE_OFFER,
    } as never);
    const answered = applySandboxAction(offered, {
      AnswerPrivatePurchase: { private_id: 99, accept: true },
    } as never);
    expect(answered.private_purchase_offer).toEqual(RECORDED_PRIVATE_OFFER);
  });
});

describe("the train negotiation, #701 / #1247", () => {
  it("records the offer, and a yes marks it accepted", () => {
    const offered = applySandboxAction(base(), {
      ProposeTrainPurchase: TRAIN_OFFER,
    } as never);
    expect(offered.train_purchase_offer).toEqual(RECORDED_TRAIN_OFFER);
    expect(offered.offer_serial).toBe(1);

    const answered = applySandboxAction(offered, {
      AnswerTrainPurchase: { seller_protocol_id: NYC, accept: true },
    } as never);
    expect(answered.train_purchase_offer).toEqual({ ...RECORDED_TRAIN_OFFER, accepted: true });
  });

  it("ignores an answer aimed at a different seller", () => {
    const offered = applySandboxAction(base(), {
      ProposeTrainPurchase: TRAIN_OFFER,
    } as never);
    const answered = applySandboxAction(offered, {
      AnswerTrainPurchase: { seller_protocol_id: 99, accept: false },
    } as never);
    expect(answered.train_purchase_offer).toEqual(RECORDED_TRAIN_OFFER);
  });
});

describe("the room closure, #899", () => {
  it("refuses outside GameEnd, silently", () => {
    /* The guards refuse without complaint on purpose: every client runs its own countdown and any player may
       press the button, so this arm is reached several times for one closure BY DESIGN. */
    const early = base();
    expect(early.current_round_type).not.toBe("GameEnd");
    expect(applySandboxAction(early, { CloseRoom: {} } as never).room_closed ?? false).toBe(false);
  });

  it("closes once at GameEnd and is idempotent afterwards", () => {
    const ended: State = { ...base(), current_round_type: "GameEnd" };
    const closed = applySandboxAction(ended, { CloseRoom: {} } as never);
    expect(closed.room_closed).toBe(true);

    /* THE FIRST CLOSE WINS. A second is a duplicate or a replay, and either way the settlement has already
       been dealt with -- so the arm must return the state it was handed rather than re-closing. */
    const again = applySandboxAction(closed, { CloseRoom: {} } as never);
    expect(again).toBe(closed);
  });

  it("#1248: the close that lost the race prints nothing, and the shell has no branch left", () => {
    const { silentWhenUnchanged, actionWasRefused } =
      require("./refusedAction") as typeof import("./refusedAction");
    const ended: State = { ...base(), current_round_type: "GameEnd" };
    const closed = applySandboxAction(ended, { CloseRoom: {} } as never);
    // The winner speaks; the duplicate is neither a success nor a refusal.
    expect(silentWhenUnchanged({ CloseRoom: {} }, ended, closed)).toBe(false);
    expect(silentWhenUnchanged({ CloseRoom: {} }, closed, closed)).toBe(true);
    expect(actionWasRefused(closed, closed, { CloseRoom: {} })).toBe(false);
    // Any other unchanged message keeps its line (or its REFUSED line) -- the quiet is CloseRoom's alone.
    expect(silentWhenUnchanged({ PassTurn: {} }, closed, closed)).toBe(false);

    const APP = readStripped("App.tsx");
    expect(APP).not.toContain("isCloseRoomMsg(msg)");
    // The payout fires on the transition the reducer made, and never from a rebuild.
    const hook = APP.indexOf("if (before.room_closed !== true && after.room_closed === true && !replayingHistory) {");
    expect(hook).toBeGreaterThan(-1);
    expect(APP.slice(hook, hook + 400)).toContain("settleRoomPayout({");
    expect((APP.match(/settleRoomPayout\(\{/g) ?? []).length).toBe(1);
    // And the general path asks the rule before it writes the entry.
    // #1685 (Stage 10.2): asked of the board the reducer was HANDED and the grid pair, by content.
    expect(APP).toContain("const quietDuplicate = silentWhenUnchanged(gameplay, handedToReducer ?? before, after, receiptAtoms);");
    expect(APP).toContain("if (!quietDuplicate)");
  });
});

describe("the boundary itself, #1247", () => {
  const offeredPrivate = () =>
    applySandboxAction(base(), { ProposePrivatePurchase: PRIVATE_OFFER } as never);
  const acceptedPrivate = () =>
    applySandboxAction(offeredPrivate(), { AnswerPrivatePurchase: { private_id: DH, accept: true } } as never);

  it("the answer arm never buys; it records", () => {
    /* #576: "a consequence is DERIVED by every client, not appended by each of them". The arm leaves the
       board holding NO new ownership and NO money moved; what it leaves is the DEBT. */
    const before = base();
    const accepted = acceptedPrivate();
    expect(accepted.private_companies).toEqual(before.private_companies);
    expect(accepted.public_companies).toEqual(before.public_companies);
    expect(accepted.player_cash).toEqual(before.player_cash);
    expect(accepted.private_purchase_offer?.accepted).toBe(true);
  });

  it("the board owes the purchase, as a derived action, before anything else", () => {
    const owed = nextDerivedAction({ state: acceptedPrivate(), mapGrid: GRID, emitted: new Set() });
    expect(owed?.kind).toBe("accepted-offer");
    expect(owed?.msg).toEqual({
      BuyPrivateCompany: { game_id: 0, protocol_id: PRR, private_id: DH, price: "100" },
    });
    // A pending, unanswered offer owes nothing; a declined one owes nothing.
    expect(nextDerivedAction({ state: offeredPrivate(), mapGrid: GRID, emitted: new Set() })).toBeNull();
    const declined = applySandboxAction(offeredPrivate(), { AnswerPrivatePurchase: { private_id: DH, accept: false } } as never);
    expect(nextDerivedAction({ state: declined, mapGrid: GRID, emitted: new Set() })).toBeNull();
  });

  it("the purchase settles the offer, so a rebuilt board owes nothing", () => {
    const accepted = acceptedPrivate();
    const owed = nextDerivedAction({ state: accepted, mapGrid: GRID, emitted: new Set() })!;
    const bought = applySandboxAction(accepted, owed.msg as never, { actor: P2 });
    expect(bought.private_purchase_offer).toBeNull();
    expect(bought.private_companies.find((entry) => entry.private_id === DH)?.owner_protocol_id).toBe(PRR);
    expect(nextDerivedAction({ state: bought, mapGrid: GRID, emitted: new Set() })).toBeNull();
    // And applying the purchase a second time -- a straggler's copy -- changes nothing: the card is already
    // PRR's, there is no offer, and the actor has no consent to give (#1591).
    expect(applySandboxAction(bought, owed.msg as never, { actor: P2 })).toBe(bought);
  });

  it("the train trade owes and settles the same way, keyed per settlement", () => {
    const offered = applySandboxAction(base(), { ProposeTrainPurchase: TRAIN_OFFER } as never);
    const accepted = applySandboxAction(offered, { AnswerTrainPurchase: { seller_protocol_id: NYC, accept: true } } as never);
    const owed = nextDerivedAction({ state: accepted, mapGrid: GRID, emitted: new Set() });
    expect(owed?.kind).toBe("accepted-offer");
    expect(owed?.msg).toEqual({
      BuyTrainFromCorporation: {
        game_id: 0,
        buyer_protocol_id: PRR,
        seller_protocol_id: NYC,
        model_type: "3",
        price: "150",
      },
    });
    /* THE OFFER COMES OFF THE BOARD EVEN WHEN THE SALE CANNOT BE MADE. NYC's 3-train is gone by the time the
       settlement lands (the board is made stale by hand), so the sale is refused -- and the offer must still
       be retired (#1596), or the board would owe the same purchase on every look until the burst cap. */
    const stale = { ...accepted, public_companies: accepted.public_companies.map((entry) => (entry.company_id === NYC ? { ...entry, owned_trains: ["2"] } : entry)) };
    const settled = applySandboxAction(stale, owed!.msg as never, { actor: P2 });
    expect(settled.train_purchase_offer).toBeNull();
    expect(settled.public_companies.find((entry) => entry.company_id === PRR)?.owned_trains).toEqual(["2"]);
    expect(nextDerivedAction({ state: settled, mapGrid: GRID, emitted: new Set() })).toBeNull();
    // A key already emitted is not owed again.
    expect(nextDerivedAction({ state: accepted, mapGrid: GRID, emitted: new Set([owed!.key]) })).toBeNull();
  });

  it("the shell has no negotiation branch left, and only sends the purchase where no server can", () => {
    const APP = readStripped("App.tsx");
    for (const guard of [
      "isProposePrivatePurchaseMsg(msg)",
      "isAnswerPrivatePurchaseMsg(msg)",
      "isProposeTrainPurchaseMsg(msg)",
      "isAnswerTrainPurchaseMsg(msg)",
    ]) {
      expect(APP).not.toContain(guard);
    }
    // The Firestore-path effect: derived, so #1213 refuses to send it while a link exists.
    const start = APP.indexOf("const acceptedOfferSentRef");
    expect(start).toBeGreaterThan(-1);
    const effect = APP.slice(start, start + 900);
    expect(effect).toContain('owed.kind !== "accepted-offer"');
    expect(effect).toContain("derived: true,");
    expect(effect).toContain("if (!gameState || !isMyTurn) return;");
  });
});
