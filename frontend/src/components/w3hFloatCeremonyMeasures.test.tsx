/** @jest-environment jsdom */
// W3-H, found while producing VF E-5's real-browser evidence: THE FULL-MOTION FLOAT CEREMONY NEVER PLAYED.
//
// The card's ref was attached only once `floatFocusedHere` was true; in full motion that needs a measured
// `floatTarget`, and the target is measured through that very ref -- so it never started, and every float
// rendered the plain card (traced in Chromium: 115 frames, no transform, no stamp, no cue). jsdom's zero rects
// made the existing suite read the same outcome as A-3's "unmeasurable" fallback. Here the geometry is real
// (non-zero rects, on screen), so the only thing between the float event and the lift is the ref.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { StockRoundPanel } from "./StockRoundPanel";
import type { PublicCompanyState, RoundType } from "../gameEngine/gameState";
import { FLOAT_STAMP_AT_MS, FLOAT_TOTAL_MS } from "./corporationFloatFocus";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const corporation = (companyId: number, ticker: string): PublicCompanyState =>
  ({
    company_id: companyId,
    ticker,
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

let host: HTMLDivElement;
let root: Root;
let cues: number;
const original = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  jest.useFakeTimers();
  cues = 0;
  // A real layout: every card 220x160 near the top-left, every other box 900x600 -- on screen, non-zero.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const isCard = (this as HTMLElement).classList?.contains("app-stock-card");
    const w = isCard ? 220 : 900;
    const h = isCard ? 160 : 600;
    return { x: 20, y: 20, left: 20, top: 20, right: 20 + w, bottom: 20 + h, width: w, height: h, toJSON() {} } as DOMRect;
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Element.prototype.getBoundingClientRect = original;
  jest.useRealTimers();
});

function render() {
  act(() => {
    root.render(
      <StockRoundPanel
        onPresidencyCue={() => undefined}
        floatEvent={{ companyId: 1, ticker: "PRR", token: 1 }}
        onFloatCue={() => {
          cues += 1;
        }}
        publicCompanies={[corporation(1, "PRR"), corporation(4, "B&O")]}
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
}
const card = (ticker: string) =>
  (host.querySelector(`[aria-label="${ticker} ownership"]`) as HTMLElement).closest(".app-stock-card") as HTMLElement;
const tick = (ms: number) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });

describe("the full-motion float ceremony measures its card and plays", () => {
  it("the named card lifts toward the roster's centre and the stamp lands", () => {
    render();
    tick(FLOAT_STAMP_AT_MS + 50);
    expect(card("PRR").style.transform).toMatch(/translate/);
    expect(card("PRR").querySelector(".app-float-stamp")).not.toBeNull();
    expect(card("B&O").style.transform).toBeFalsy();
  });

  it("and the stamp's cue fires once, on its beat", () => {
    render();
    tick(FLOAT_TOTAL_MS + 100);
    expect(cues).toBe(1);
  });
});
