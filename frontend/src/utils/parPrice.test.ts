// frontend/src/utils/parPrice.test.ts
//
// ==================================================================
//  DESIGN NOTE 553 (harness): THE PRICE IS THE CORPORATION'S
// ==================================================================
//
// REPORTED: the president founds a corporation at $67 and their own Buy
// button keeps saying $67. Every other player is shown $100, pays $100, and
// their stock market chart puts the corporation's token in a different box.
//
// One cause, three symptoms, and the cause is the same mistake as design
// note #549 one layer up: a fact that belongs to the shared game was being
// derived from a per-browser value. There it was WHO acted; here it is HOW
// MUCH a share costs.
//
// The tests are written against the divergence rather than against the
// lookup, for the same reason: the parameter was never wrong. What was wrong
// is that two clients holding the same game state could produce two
// different prices, and only an assertion that compares two clients can
// catch that coming back.

import { parPriceFor, type GameStateResponse } from "./gameState";

const ERIE = 4;

function board(parValue: string | null): GameStateResponse {
  return {
    public_companies: [
      { company_id: ERIE, ticker: "ERIE", par_value: parValue },
      { company_id: 9, ticker: "NYC", par_value: null },
    ],
  } as unknown as GameStateResponse;
}

describe("parPriceFor", () => {
  it("quotes the corporation's own par once it is founded", () => {
    expect(parPriceFor(board("67"), ERIE, undefined, "100")).toBe("67");
  });

  it("ignores this browser's ladder once the par is set", () => {
    /* THE REPORTED BUG, from the founder's side: their ladder still holds
       the rung they picked, and it must not be what the button reads --
       right answer, wrong source, and it would go on being right until it
       silently was not. */
    expect(parPriceFor(board("67"), ERIE, "100", "100")).toBe("67");
  });

  it("gives every client the same price regardless of their ladder", () => {
    /* THE PROPERTY. The founder's browser, a player who never opened the
       ladder, and one who idly clicked a different rung. */
    const founder = parPriceFor(board("67"), ERIE, "67", "100");
    const bystander = parPriceFor(board("67"), ERIE, undefined, "100");
    const fiddler = parPriceFor(board("67"), ERIE, "90", "100");
    expect(new Set([founder, bystander, fiddler]).size).toBe(1);
  });

  it("uses the ladder while the corporation has no price yet", () => {
    // The founding purchase, which is the one moment the ladder decides.
    expect(parPriceFor(board(null), ERIE, "76", "100")).toBe("76");
  });

  it("falls back only when the ladder is untouched and the par unset", () => {
    expect(parPriceFor(board(null), ERIE, undefined, "100")).toBe("100");
  });

  it("treats a zero par as unset rather than as a free share", () => {
    /* An uninitialised numeric column arrives as "0" on the way through, and
       a corporation priced at $0 would let a player buy a presidency for
       nothing. Unset is the safe reading and the true one. */
    expect(parPriceFor(board("0"), ERIE, "82", "100")).toBe("82");
  });

  it("does not read one corporation's par for another", () => {
    expect(parPriceFor(board("67"), 9, undefined, "100")).toBe("100");
  });

  it("survives having no board at all", () => {
    // Online, before the first `GetGameState` resolves.
    expect(parPriceFor(null, ERIE, "71", "100")).toBe("71");
    expect(parPriceFor(null, ERIE, undefined, "100")).toBe("100");
  });

  it("does not invent a price for a corporation that is not there", () => {
    expect(parPriceFor(board("67"), 999, undefined, "100")).toBe("100");
  });
});
