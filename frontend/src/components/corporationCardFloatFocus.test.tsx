/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE (VF-3 harness): APPROACH C, VERIFIED BY WHAT THE DOM ACTUALLY HOLDS
// ==================================================================
//
// Mirrors `stockCardFocus.test.tsx`'s own framing (its header comment states the same rule this suite
// exists to check, one flourish over):
//   1. NOTHING LEAVES THE CARD. `document.body` gains no child beyond this suite's own mount host, in every
//      case below -- the A-1 rule this batch's amendment restates rather than relaxes.
//   2. THE FIGURES ARE NOT FINAL BEFORE THE GESTURE THAT CAUSES THEM: the float-progress badge (not "Last
//      run") is what the pre-midpoint card shows, even though the authoritative company handed to this
//      panel is ALREADY `is_floated: true` -- that is the whole point of staging `before`.
//   3. THE MIDPOINT SWAP IS ONE INSTANT: float-progress badge + muted livery + stamp before it, "Last run" +
//      full livery + no stamp after it, never a frame with both or neither.
//   4. SUPERSESSION leaves nothing behind, and a second, unrelated corporation never gets a stamp from a
//      float that is not its own (brief section 8, "one corporation only").
//   5. A-3's OWN FALLBACK: `getBoundingClientRect` reports every rect as `{0,0,0,0}` in jsdom (the same
//      limitation `stockCardFocus.test.tsx` records for the row glide, C-10), so a full-motion sequence's
//      geometry measurement fails here BY CONSTRUCTION -- which is exactly the case this suite uses to prove
//      the fallback renders the plain, already-floated, authoritative card with no transform, no stamp and
//      no flip attempted, rather than a broken or partial ceremony. The measured translate/scale/flip is
//      therefore felt but not asserted here; see VISUAL_FLOURISH_BACKLOG.md E-1.
//   6. REDUCED MOTION keeps the same swap and the same stamp, minus any rotation.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { StockRoundPanel, type CorporationFloatEvent } from "./StockRoundPanel";
import type { PublicCompanyState, RoundType } from "../gameEngine/gameState";
import {
  FLOAT_REDUCED_CUE_AT_MS,
  FLOAT_REDUCED_STAMP_AT_MS,
  FLOAT_REDUCED_SWAP_MIDPOINT_AT_MS,
  FLOAT_STAMP_AT_MS,
  FLOAT_TOTAL_MS,
} from "./corporationFloatFocus";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const PRR = 1;
const BO = 4;

const corporation = (companyId: number, ticker: string): PublicCompanyState =>
  ({
    company_id: companyId,
    ticker,
    // Authoritative state commits the float immediately (A-3) -- the card is handed an ALREADY-floated
    // company and stages `is_floated: false` itself from the float event alone, never from a `before`
    // snapshot the shell would otherwise have to carry.
    is_floated: true,
    treasury: "500",
    total_shares_issued: 10,
    par_value: "90",
    president: "juno1alice",
    ipo_pool_percentage: 40,
    bank_pool_percentage: 20,
    player_holdings: [{ player: "juno1alice", percentage: 40 }],
    home_hex_label: "H12",
    station_token_hexes: [],
    trains: [],
  }) as unknown as PublicCompanyState;

/* `window.matchMedia` is undefined by default in jsdom -- `prefersReducedMotion()` treats that as `false`
   via optional chaining, matching every other reader of it in `StockRoundPanel.tsx`. This mock lets a test
   flip the OS preference the same way a real browser would, the same direct-assignment shape
   `stockCardFocus.test.tsx`'s own reduced-motion test already uses (a `jest.fn()` wrapper here was, in
   practice, never actually invoked by the optional-chained call site -- a plain function is what the
   established pattern uses, so this follows it rather than chasing why). */
let reducedMotion = false;

describe("the corporation card's own float ceremony", () => {
  let host: HTMLDivElement;
  let root: Root;
  let cues: string[];

  const render = (
    companies: readonly PublicCompanyState[],
    floatEvent: CorporationFloatEvent | null,
  ) => {
    act(() => {
      root.render(
        <StockRoundPanel
          onPresidencyCue={() => undefined}
          floatEvent={floatEvent}
          onFloatCue={() => cues.push("float")}
          publicCompanies={companies}
          parValueFor={() => "90"}
          onSelectParValue={() => undefined}
          onBuyShare={() => undefined}
          onSellShares={() => undefined}
          sessionReady
          isMyTurn={false}
          connectedAddress={null}
          roundType={"StockRound" as RoundType}
          transaction={null}
        />,
      );
    });
  };
  const tick = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });

  const table = (ticker: string) =>
    host.querySelector<HTMLElement>(`[aria-label="${ticker} ownership"]`) as HTMLElement;
  const card = (ticker: string) => table(ticker).closest(".app-stock-card") as HTMLElement;
  const stamp = (ticker: string) => card(ticker).querySelector(".app-float-stamp");
  const flipWrapper = (ticker: string) => card(ticker).querySelector(".app-float-flip");
  const mutedLivery = (ticker: string) => card(ticker).querySelector('[style*="saturate"]');
  /** The unfloated-reading badge is the only element carrying this class; its absence, plus "Last run" in
   *  the card's text, is the floated reading. */
  const preFloatBadge = (ticker: string) => card(ticker).querySelector(".float-badge");
  const showsLastRun = (ticker: string) => (card(ticker).textContent ?? "").includes("Last run");

  beforeEach(() => {
    jest.useFakeTimers();
    reducedMotion = false;
    (window as unknown as { matchMedia: (query: string) => { matches: boolean } }).matchMedia = (
      query: string,
    ) => ({ matches: reducedMotion, media: query } as unknown as { matches: boolean });
    cues = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    jest.useRealTimers();
  });

  describe("no float event", () => {
    it("renders the plain authoritative card, floated, with none of the ceremony's DOM", () => {
      render([corporation(PRR, "PRR")], null);
      expect(showsLastRun("PRR")).toBe(true);
      expect(preFloatBadge("PRR")).toBeNull();
      expect(stamp("PRR")).toBeNull();
      expect(flipWrapper("PRR")).toBeNull();
      expect(mutedLivery("PRR")).toBeNull();
      expect(document.body.children).toHaveLength(1);
    });
  });

  describe("full motion (geometry unmeasurable in jsdom -- the A-3 fallback)", () => {
    it("degrades to the plain authoritative card rather than a broken ceremony", () => {
      render([corporation(PRR, "PRR")], { companyId: PRR, ticker: "PRR", token: 1 });
      tick(FLOAT_STAMP_AT_MS + 50);
      // `getBoundingClientRect` is a zero rect for every element in jsdom, so `useFloatCardTarget` never
      // produces a target and this card can never enter the staged/transformed path -- exactly A-3's rule
      // ("every measurement failure degrades to plain authoritative rendering").
      expect(stamp("PRR")).toBeNull();
      expect(flipWrapper("PRR")).toBeNull();
      expect(mutedLivery("PRR")).toBeNull();
      expect(showsLastRun("PRR")).toBe(true);
      expect(card("PRR").style.transform).toBeFalsy();
      expect(document.body.children).toHaveLength(1);
      // And, because the geometry cannot resolve, the stamp cue is never fired either -- no sound for a
      // ceremony that never visibly played.
      tick(FLOAT_TOTAL_MS);
      expect(cues).toHaveLength(0);
    });

    it("never marks an unrelated corporation, even while another one is floating", () => {
      render([corporation(PRR, "PRR"), corporation(BO, "B&O")], { companyId: PRR, ticker: "PRR", token: 1 });
      tick(FLOAT_STAMP_AT_MS + 50);
      expect(stamp("B&O")).toBeNull();
      expect(mutedLivery("B&O")).toBeNull();
      expect(showsLastRun("B&O")).toBe(true);
    });
  });

  describe("reduced motion", () => {
    beforeEach(() => {
      reducedMotion = true;
    });

    it("starts from the staged pre-float reading -- float progress, muted livery, no rotation wrapper", () => {
      render([corporation(PRR, "PRR")], { companyId: PRR, ticker: "PRR", token: 1 });
      expect(preFloatBadge("PRR")).not.toBeNull();
      expect(showsLastRun("PRR")).toBe(false);
      expect(mutedLivery("PRR")).not.toBeNull();
      expect(flipWrapper("PRR")).toBeNull();
      expect(document.body.children).toHaveLength(1);
    });

    it("fires the cue at its own (early) offset, not at the visual stamp beat, and only once", () => {
      // Design note (VF-3, audio realignment): reduced motion cannot reuse the full-motion cue offset
      // (its 160ms stamp beat is itself earlier than the clip's own ~458ms measured impact -- see
      // `FLOAT_REDUCED_CUE_AT_MS`'s own note), so the cue fires at the sequence's own start instead, well
      // before the stamp is even visible.
      expect(FLOAT_REDUCED_CUE_AT_MS).toBe(0);
      render([corporation(PRR, "PRR")], { companyId: PRR, ticker: "PRR", token: 1 });
      tick(FLOAT_REDUCED_CUE_AT_MS + 1);
      expect(stamp("PRR")).toBeNull();
      expect(cues).toEqual(["float"]);
      // A re-render at the same beat (a poll, a resize) must not fire it twice.
      render([corporation(PRR, "PRR")], { companyId: PRR, ticker: "PRR", token: 1 });
      expect(cues).toEqual(["float"]);
    });

    it("shows the stamp once its own (unmoved) visual beat arrives -- the audio realignment never moved it", () => {
      render([corporation(PRR, "PRR")], { companyId: PRR, ticker: "PRR", token: 1 });
      expect(stamp("PRR")).toBeNull();
      tick(FLOAT_REDUCED_STAMP_AT_MS + 1);
      expect(stamp("PRR")).not.toBeNull();
    });

    it("swaps everything at once, at its own hidden midpoint -- never a frame with both or neither", () => {
      render([corporation(PRR, "PRR")], { companyId: PRR, ticker: "PRR", token: 1 });
      tick(FLOAT_REDUCED_SWAP_MIDPOINT_AT_MS - 1);
      expect(preFloatBadge("PRR")).not.toBeNull();
      expect(stamp("PRR")).not.toBeNull();
      expect(mutedLivery("PRR")).not.toBeNull();
      tick(2);
      expect(preFloatBadge("PRR")).toBeNull();
      expect(showsLastRun("PRR")).toBe(true);
      expect(stamp("PRR")).toBeNull();
      expect(mutedLivery("PRR")).toBeNull();
    });

    it("settles and hands back to plain authoritative rendering once the sequence finishes", () => {
      render([corporation(PRR, "PRR")], { companyId: PRR, ticker: "PRR", token: 1 });
      tick(FLOAT_TOTAL_MS + 100);
      expect(showsLastRun("PRR")).toBe(true);
      expect(stamp("PRR")).toBeNull();
      expect(mutedLivery("PRR")).toBeNull();
      expect(document.body.children).toHaveLength(1);
    });

    it("supersedes cleanly: a second float owns the ceremony and the first leaves nothing behind", () => {
      render([corporation(PRR, "PRR"), corporation(BO, "B&O")], {
        companyId: PRR,
        ticker: "PRR",
        token: 1,
      });
      // Past both the (early) cue offset and the (unmoved) visual stamp beat (160ms) -- see the pure-timeline
      // suite for the exact reduced-motion cue/stamp split this now exercises.
      tick(161);
      expect(stamp("PRR")).not.toBeNull();
      expect(cues).toEqual(["float"]);
      render([corporation(PRR, "PRR"), corporation(BO, "B&O")], {
        companyId: BO,
        ticker: "B&O",
        token: 2,
      });
      // The superseded PRR sequence's timers are cleared; it must not still be mid-ceremony.
      expect(stamp("PRR")).toBeNull();
      expect(preFloatBadge("PRR")).toBeNull();
      expect(showsLastRun("PRR")).toBe(true);
      // B&O starts its own sequence from the top.
      expect(preFloatBadge("B&O")).not.toBeNull();
      tick(161);
      expect(stamp("B&O")).not.toBeNull();
      // Two ceremonies, two cues -- PRR's superseded sequence did not fire twice, and B&O's fired exactly
      // once for itself.
      expect(cues).toEqual(["float", "float"]);
    });
  });
});
