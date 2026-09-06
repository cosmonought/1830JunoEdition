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
// WHAT THESE CASES ARE REALLY PINNING is the boundary #1198 draws. An accepted offer causes a NEW LOG ACTION
// to be sent -- an ordinary `BuyPrivateCompany` or `BuyTrainFromCorporation` -- and that dispatch belongs to
// the shell, because #576 is explicit that a consequence is derived by every client and never appended by
// each of them: "appending inside a replay is how one win issued two certificates." A reducer that sent it
// would send it once per client and again on every rebuild.
//
// The reducer settles what the offer DID to the board. The shell decides what to SEND next. Every case below
// asserts one side of that line.

export {};

const { applySandboxAction } = require("./sandboxSession") as typeof import("./sandboxSession");
const { sandboxScenarioState } = require("./sandboxState") as typeof import("./sandboxState");

type State = import("./gameState").GameStateResponse;

const base = (): State => sandboxScenarioState("start", 0, "default");

const PRIVATE_OFFER = {
  private_id: 3,
  private_name: "Delaware & Hudson",
  owner: "p-alice",
  buyer_protocol_id: 7,
  buyer_ticker: "NNH",
  price: 70,
};

const TRAIN_OFFER = {
  seller_protocol_id: 4,
  seller_ticker: "B&O",
  seller_president: "p-bob",
  buyer_protocol_id: 1,
  buyer_ticker: "PRR",
  model_type: "3",
  // See turnAuthority.test.ts: the two offer types disagree about this field's type.
  price: "150",
};

describe("the private negotiation, #662", () => {
  it("records the offer on the board so every client sees the same one", () => {
    const after = applySandboxAction(base(), {
      ProposePrivatePurchase: PRIVATE_OFFER,
    } as never);
    expect(after.private_purchase_offer).toEqual(PRIVATE_OFFER);
  });

  it("clears the offer on an answer, whichever way it went", () => {
    /* DECLINE AND ACCEPT CLEAR IDENTICALLY, and that is the point of the boundary: what the board records is
       that the question is settled. WHETHER a purchase follows is the shell's dispatch, not this arm's. */
    const offered = applySandboxAction(base(), {
      ProposePrivatePurchase: PRIVATE_OFFER,
    } as never);
    for (const accept of [true, false]) {
      const answered = applySandboxAction(offered, {
        AnswerPrivatePurchase: { private_id: 3, accept },
      } as never);
      expect(answered.private_purchase_offer).toBeNull();
    }
  });

  it("treats a second answer as nothing to do rather than as an error", () => {
    /* #662: "the first answer settles it, the second finds nothing". A replayed duplicate must take this arm
       and change nothing -- a refusal that threw would kill a rebuild. */
    const settled = applySandboxAction(base(), {
      AnswerPrivatePurchase: { private_id: 3, accept: true },
    } as never);
    expect(settled.private_purchase_offer ?? null).toBeNull();
  });

  it("ignores an answer aimed at a different private", () => {
    const offered = applySandboxAction(base(), {
      ProposePrivatePurchase: PRIVATE_OFFER,
    } as never);
    const answered = applySandboxAction(offered, {
      AnswerPrivatePurchase: { private_id: 99, accept: true },
    } as never);
    expect(answered.private_purchase_offer).toEqual(PRIVATE_OFFER);
  });
});

describe("the train negotiation, #701", () => {
  it("records and clears the offer, the same shape as the private's", () => {
    const offered = applySandboxAction(base(), {
      ProposeTrainPurchase: TRAIN_OFFER,
    } as never);
    expect(offered.train_purchase_offer).toEqual(TRAIN_OFFER);

    const answered = applySandboxAction(offered, {
      AnswerTrainPurchase: { seller_protocol_id: 4, accept: true },
    } as never);
    expect(answered.train_purchase_offer).toBeNull();
  });

  it("ignores an answer aimed at a different seller", () => {
    const offered = applySandboxAction(base(), {
      ProposeTrainPurchase: TRAIN_OFFER,
    } as never);
    const answered = applySandboxAction(offered, {
      AnswerTrainPurchase: { seller_protocol_id: 99, accept: false },
    } as never);
    expect(answered.train_purchase_offer).toEqual(TRAIN_OFFER);
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
});

describe("the boundary itself", () => {
  it("never appends a purchase of its own when an offer is accepted", () => {
    /* THE ASSERTION THIS FILE EXISTS FOR. #576: "a consequence is DERIVED by every client, not appended by
       each of them -- appending inside a replay is how one win issued two certificates."
       An accepted private offer must leave the board holding NO new private ownership and NO new share: the
       purchase arrives later, once, as its own logged `BuyPrivateCompany`. If this arm ever starts doing the
       buying itself, these two comparisons are what notices. */
    const before = base();
    const offered = applySandboxAction(before, {
      ProposePrivatePurchase: PRIVATE_OFFER,
    } as never);
    const accepted = applySandboxAction(offered, {
      AnswerPrivatePurchase: { private_id: 3, accept: true },
    } as never);

    expect(accepted.private_companies).toEqual(before.private_companies);
    expect(accepted.public_companies).toEqual(before.public_companies);
    expect(accepted.player_cash).toEqual(before.player_cash);
  });
});
