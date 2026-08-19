// frontend/src/utils/presidencyTransfer.test.ts
//
// ==================================================================
//  DESIGN NOTE 596 (harness): THE CROWN IS A CARD, NOT A LABEL
// ==================================================================
//
// REPORTED, with the expected outcome spelled out in full: "P1 was President
// with 1 share (President's 20%). P2 owned two shares and purchased a third.
// The card showed P2, 3 certificates, 30%, and P1 (crown), 1 certificate,
// 20%... the resulting card should read: P2 (crown), 2 certificates, 30%, and
// P1, 2 certificates, 20%."
//
// That last sentence is the whole test suite. The percentages do NOT move —
// P2 holds 30% before and after, P1 holds 20% before and after — and the
// CERTIFICATE counts do, because the president's 20% is one physical card and
// the takeover swaps it for two ordinary ones.
//
// So most of these assert card counts rather than the `president` field. A
// implementation that set the flag and stopped would pass a test that only
// checked the flag, and would leave both players' certificate totals wrong
// against a limit they plan around for the rest of the game.

import { certificateCount, type GameStateResponse } from "./gameState";
import { presidentFor, settlePresidencies } from "./presidencyTransfer";

const P1 = "p-one";
const P2 = "p-two";
const P3 = "p-three";

function board(
  holdings: Array<[string, number]>,
  president: string | null,
  par: string | null = "100",
): GameStateResponse {
  return {
    player_addresses: [P1, P2, P3],
    private_companies: [],
    public_companies: [
      {
        company_id: 1,
        ticker: "PRR",
        president,
        par_value: par,
        player_holdings: holdings.map(([player, percentage]) => ({ player, percentage })),
      },
    ],
  } as unknown as GameStateResponse;
}

const prr = (state: GameStateResponse) => state.public_companies[0];

describe("the reported takeover", () => {
  const before = board(
    [
      [P1, 20],
      [P2, 30],
    ],
    P1,
  );

  it("moves the crown to the larger holder", () => {
    expect(settlePresidencies(before).state.public_companies[0].president).toBe(P2);
  });

  it("leaves both percentages exactly where they were", () => {
    /* Design note #596a: a takeover is a SWAP of cards, not a transfer of
       stock. Anyone whose percentage moved here has been given or robbed of
       shares nobody traded. */
    const after = settlePresidencies(before).state;
    expect(prr(after).player_holdings).toEqual(prr(before).player_holdings);
  });

  it("produces the certificate counts the report asks for", () => {
    /* THE ASSERTION THAT MATTERS. P2: 30% as a 20% president's card plus one
       10% = 2 certificates. P1: 20% as two ordinary 10% cards = 2. Before the
       fix they read 3 and 1. */
    const after = settlePresidencies(before).state;
    expect(certificateCount(P2, after)).toBe(2);
    expect(certificateCount(P1, after)).toBe(2);
    // ...and the counts before, so the change is visible in the test itself.
    expect(certificateCount(P2, before)).toBe(3);
    expect(certificateCount(P1, before)).toBe(1);
  });

  it("reports the change, naming both ends", () => {
    const { changes } = settlePresidencies(before);
    expect(changes).toEqual([{ companyId: 1, ticker: "PRR", from: P1, to: P2 }]);
  });
});

describe("when the crown does not move", () => {
  it("leaves a tie with the incumbent", () => {
    /* Design note #596b: STRICTLY more. Two players buying alternately to
       30% each must not hand the crown back and forth every purchase. */
    const state = board(
      [
        [P1, 30],
        [P2, 30],
      ],
      P1,
    );
    expect(settlePresidencies(state).state).toBe(state);
  });

  it("returns the same object when nothing changed", () => {
    /* Identity is the caller's cheap test for "did anything happen", and it
       runs after EVERY holding change -- so a new object each time would
       re-render the board on every pass and every tile lay. */
    const state = board(
      [
        [P1, 40],
        [P2, 20],
      ],
      P1,
    );
    expect(settlePresidencies(state).state).toBe(state);
    expect(settlePresidencies(state).changes).toEqual([]);
  });

  it("leaves an unstarted corporation alone", () => {
    /* No par means the president's certificate is still in the IPO (design
       note #587). Crowning somebody here would hand out a card the game has
       not yet sold. */
    const state = board([[P2, 30]], null, null);
    expect(settlePresidencies(state).state).toBe(state);
  });

  it("does not crown a holder under 20%", () => {
    // Nobody can hold a 20% certificate on 10% of the company.
    const state = board([[P2, 10]], null);
    expect(presidentFor(state.public_companies[0])).toBeNull();
  });
});

describe("selling out of a presidency", () => {
  it("hands the crown to whoever now leads", () => {
    /* The direction players forget: selling down below another holder gives
       them the presidency whether or not that was the intention. */
    const state = board(
      [
        [P1, 20],
        [P2, 40],
      ],
      P1,
    );
    expect(settlePresidencies(state).state.public_companies[0].president).toBe(P2);
  });

  it("picks the largest of several challengers", () => {
    const state = board(
      [
        [P1, 20],
        [P2, 30],
        [P3, 50],
      ],
      P1,
    );
    expect(settlePresidencies(state).state.public_companies[0].president).toBe(P3);
  });

  it("breaks a tie among challengers by seating order", () => {
    /* Design note #596b is explicit that this is a STAND-IN for 1830's real
       rule ("whoever reached that level most recently"), which needs history
       this function cannot see. Pinned so the substitution is visible rather
       than discovered. */
    const state = board(
      [
        [P1, 10],
        [P2, 30],
        [P3, 30],
      ],
      P1,
    );
    expect(settlePresidencies(state).state.public_companies[0].president).toBe(P2);
  });
});
