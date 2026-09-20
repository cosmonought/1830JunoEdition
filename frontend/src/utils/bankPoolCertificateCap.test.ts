/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1670 (harness): S9-8 -- FIVE PIECES OF CARD, NOT FIFTY POINTS
// ==================================================================
//
// OWNER RULING (2026-09-19): "The Bank Pool limit is FIVE PHYSICAL CERTIFICATES of one corporation, not 50
// percentage points. A non-president 20% certificate is ONE physical certificate."
//
// THE TWO MEASURES AGREE IN CLASSIC, which is the whole reason the percentage survived: five 10% cards are
// fifty percent, so nothing in the printed game could tell them apart. They part under the Level Playing
// Field, where the ERIE and the N&W print an "other" 20% certificate -- one card carrying two shares. Every
// case below is one of the owner's five required behaviours, and the Classic pair at the end is the control
// proving the rule did not move where it was already right.

import { shareSaleBlock } from "../gameEngine/shareSale";
import { certificateCardsInPool, certificateCardsEnteringPool, bankPoolCertificateRoom } from "../gameEngine/doubleCertificate";
import { BANK_POOL_CAP_CERTIFICATES } from "../gameEngine/endgame";
import type { GameStateResponse } from "../gameEngine/gameState";

const ME = "me";
const RIVAL = "rival";
const ERIE = 6;

/** A Scenario-D corporation: the president's 20%, an "other" 20% card, and six 10%s. */
const board = (over: {
  pool?: number;
  poolHasDouble?: boolean;
  held?: number;
  meHoldsDouble?: boolean;
  president?: string | null;
  others?: Array<{ player: string; percentage: number }>;
} = {}): GameStateResponse =>
  ({
    public_companies: [
      {
        company_id: ERIE,
        ticker: "ERIE",
        president: over.president === undefined ? null : over.president,
        par_value: "100",
        bank_pool_percentage: over.pool ?? 0,
        ipo_pool_percentage: 0,
        double_certificate: over.poolHasDouble
          ? { at: "Bank" }
          : over.meHoldsDouble
            ? { at: ME }
            : { at: "Ipo" },
        player_holdings: [
          ...(over.held ? [{ player: ME, percentage: over.held }] : []),
          ...(over.others ?? []),
        ],
      },
    ],
  }) as unknown as GameStateResponse;

const company = (state: GameStateResponse) => state.public_companies[0];
const sell = (state: GameStateResponse, percentage: number, seller = ME) =>
  shareSaleBlock({ state, seller, companyId: ERIE, percentage });

describe("S9-8: the Bank Pool holds five physical certificates", () => {
  it("1. five ordinary 10% certificates fill it", () => {
    const full = board({ pool: 50 });
    expect(certificateCardsInPool(company(full), "Bank")).toBe(5);
    expect(bankPoolCertificateRoom(company(full))).toBe(0);
    expect(sell(board({ pool: 50, held: 10 }), 10)).toContain("caps at 5");
  });

  it("2. one non-president 20% plus three ordinary 10%s is FOUR certificates, not full", () => {
    /* 50% of stock and four pieces of card. The percentage test called this full and refused a legal sale;
       the rule leaves room for a fifth. */
    const state = board({ pool: 50, poolHasDouble: true, held: 10 });
    expect(certificateCardsInPool(company(state), "Bank")).toBe(4);
    expect(bankPoolCertificateRoom(company(state))).toBe(1);
    expect(sell(state, 10)).toBeNull();
  });

  it("3. one non-president 20% plus four ordinary 10%s is FIVE certificates and full", () => {
    const state = board({ pool: 60, poolHasDouble: true, held: 10 });
    expect(certificateCardsInPool(company(state), "Bank")).toBe(5);
    expect(bankPoolCertificateRoom(company(state))).toBe(0);
    expect(sell(state, 10)).toContain("caps at 5");
    /* AND THE SIXTH CARD THE OLD TEST WOULD HAVE LET IN. 60% is already past the printed 50%, which the
       percentage ceiling reached only because the 20% card entered as one certificate. */
  });

  it("4. selling the non-president 20% adds ONE certificate while moving 20% of stock", () => {
    const state = board({ pool: 20, meHoldsDouble: true, held: 20 });
    expect(certificateCardsEnteringPool(company(state), ME, 20)).toBe(1);
    // Two cards in the pool, one arriving: three of five. Allowed.
    expect(sell(state, 20)).toBeNull();
  });

  it("5. ownership percentage and proceeds stay percentage-based", () => {
    /* THE CAP IS THE ONLY THING COUNTED IN CARDS. The pool still gains 20% of the corporation and the seller
       is still paid for two shares -- `certificatesIn` / `saleProceeds` are untouched by this slice. */
    const { certificatesIn, saleProceeds } = require("../gameEngine/shareSale") as typeof import("../gameEngine/shareSale");
    expect(certificatesIn(20)).toBe(2);
    expect(saleProceeds(100, 20)).toBe(200);
  });

  it("6. presidency rules are unchanged, and a president's block counts as the cards it becomes", () => {
    /* §5.4 hands the pool two 10%s for the 20% card, so a president's 30% is THREE certificates -- not the
       two the chart's own helper would answer, which reads any residue as the double. The seller here holds
       no double at all. */
    const state = board({ pool: 0, held: 30, president: ME, others: [{ player: RIVAL, percentage: 20 }] });
    expect(certificateCardsEnteringPool(company(state), ME, 30)).toBe(3);
    expect(sell(state, 30)).toBeNull();
    // The successor rule still speaks for itself when nobody can take the crown.
    const alone = board({ pool: 0, held: 30, president: ME });
    expect(sell(alone, 30)).toContain("no other player holds 20%");
  });

  it("7. Classic is unchanged by construction: no double, cards are tens", () => {
    for (const pool of [0, 10, 20, 30, 40, 50]) {
      const state = board({ pool, held: 60 });
      expect(certificateCardsInPool(company(state), "Bank")).toBe(pool / 10);
      expect(bankPoolCertificateRoom(company(state))).toBe(BANK_POOL_CAP_CERTIFICATES - pool / 10);
      // The old percentage ceiling and the new certificate ceiling refuse exactly the same sales.
      for (const percentage of [10, 20, 30]) {
        const refusedByCards = sell(state, percentage) !== null;
        const refusedByPercent = percentage > Math.max(0, 50 - pool);
        expect(refusedByCards).toBe(refusedByPercent);
      }
    }
  });
});
