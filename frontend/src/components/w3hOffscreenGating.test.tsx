/** @jest-environment jsdom */
//
// ==================================================================
//  W3-H (harness): OFF-SCREEN WORK IS NOT STARTED -- VF C-7, E-6, F-5
// ==================================================================
//
// `utils/surfaceVisibility.ts` gates three flourishes on whether anyone can see their surface. This suite
// mounts each one and checks the work itself, not a source shape:
//   C-7  VF-1's transfer: card on screen -> proxy drawn, timers armed, presidency cue sounds. Card scrolled
//        away, or page in the background -> no proxy, no staging timers, the committed board shown -- and the
//        presidency cue still sounds once, on its beat (one timer; W3-H review: the gate declines the picture,
//        not the sound). Not launched late when the card comes back (#1453/#1454).
//   E-6  VF-3's float: card on screen -> the ceremony's timers are armed. Card scrolled away, page hidden,
//        or the pane mounted but `display: none` (a zero-size box) -> none are.
//   F-5  VF-2's route signal: board visible -> frames are requested. Document hidden or board off screen ->
//        none, and the clock re-arms when the board comes back.
//
// jsdom has no layout: every rect is zero, the document root included, and the gate reads that as "cannot
// tell" and stands aside (which is why the existing suites are unchanged). So each case here gives the
// document root a viewport-sized box and gives the surface under test the box the case is about.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { StockRoundPanel, type CorporationFloatEvent, type StockTransactionEvent } from "./StockRoundPanel";
import { HexGridRenderer } from "./HexGridRenderer";
import type { RouteOverlay } from "./hexCanvasPrimitives";
import { TRANSFER_MS } from "./stockTransferFocus";
import { FLOAT_TOTAL_MS } from "./corporationFloatFocus";
import type { OwnershipSnapshot } from "../utils/stockTransaction";
import type { PublicCompanyState, RoundType } from "../gameEngine/gameState";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/* ---- layout and visibility, faked ------------------------------------------------- */

type Box = { left: number; top: number; width: number; height: number };
const VIEWPORT: Box = { left: 0, top: 0, width: 1024, height: 768 };
const ON_SCREEN: Box = { left: 40, top: 100, width: 300, height: 260 };
/** Below the fold: a real box, entirely past the viewport's bottom edge. */
const BELOW_FOLD: Box = { left: 40, top: 2400, width: 300, height: 260 };
/** A `display: none` ancestor -- the inactive-but-mounted tab. */
const NO_BOX: Box = { left: 0, top: 0, width: 0, height: 0 };

const rect = ({ left, top, width, height }: Box): DOMRect =>
  ({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  }) as DOMRect;

/** The box the surface under test reports; everything else but the document root is zero, as in jsdom. */
let surfaceBox: Box = ON_SCREEN;
let surfaceSelector = "[data-stock-card]";
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  surfaceBox = ON_SCREEN;
  visibility = "visible";
  jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === document.documentElement) return rect(VIEWPORT);
    if (this.matches(surfaceSelector)) return rect(surfaceBox);
    return rect(NO_BOX);
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  jest.restoreAllMocks();
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
});

const setVisibility = (next: DocumentVisibilityState) => {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

/* ---- the corporation roster (C-7, E-6) --------------------------------------------- */

const PRR = 1;
const ALICE = "juno1alice";
const BOB = "juno1bob";

const holdingRows = (holdings: Record<string, number>) =>
  Object.keys(holdings)
    .filter((player) => holdings[player] > 0)
    .map((player) => ({ player, percentage: holdings[player] }));

const snap = (
  president: string | null,
  holdings: Record<string, number>,
  pools: { ipo: number; bank: number },
): OwnershipSnapshot => ({
  ipo_pool_percentage: pools.ipo,
  bank_pool_percentage: pools.bank,
  player_holdings: holdingRows(holdings),
  president,
});

const corporation = (
  holdings: Record<string, number>,
  president: string | null,
  pools: { ipo: number; bank: number },
): PublicCompanyState =>
  ({
    company_id: PRR,
    ticker: "PRR",
    is_floated: true,
    treasury: "500",
    total_shares_issued: 10,
    par_value: "90",
    president,
    ipo_pool_percentage: pools.ipo,
    bank_pool_percentage: pools.bank,
    player_holdings: holdingRows(holdings),
    home_hex_label: "H12",
    station_token_hexes: [],
    trains: [],
  }) as unknown as PublicCompanyState;

/* BOB buys 20% from the pool, reaching 50% against ALICE's 40%, and takes the crown. The committed board is
   already `after`. */
const COMMITTED = [corporation({ [ALICE]: 40, [BOB]: 50 }, BOB, { ipo: 10, bank: 0 })];
const takeover = (token: number): StockTransactionEvent => ({
  token,
  companyId: PRR,
  ticker: "PRR",
  kind: "buy",
  transfer: { from: "Bank", to: BOB, percentage: 20 },
  presidency: { from: ALICE, to: BOB },
  before: snap(ALICE, { [ALICE]: 40, [BOB]: 30 }, { ipo: 10, bank: 20 }),
  after: snap(BOB, { [ALICE]: 40, [BOB]: 50 }, { ipo: 10, bank: 0 }),
});

describe("the corporation roster's ceremonies", () => {
  let host: HTMLDivElement;
  let root: Root;
  let cues: string[];

  const render = (transaction: StockTransactionEvent | null, floatEvent: CorporationFloatEvent | null = null) => {
    act(() => {
      root.render(
        <StockRoundPanel
          onPresidencyCue={() => cues.push("presidency")}
          floatEvent={floatEvent}
          onFloatCue={() => cues.push("float")}
          publicCompanies={COMMITTED}
          parValueFor={() => "90"}
          onSelectParValue={() => undefined}
          onBuyShare={() => undefined}
          onSellShares={() => undefined}
          sessionReady
          isMyTurn={false}
          connectedAddress={null}
          roundType={"StockRound" as RoundType}
          transaction={transaction}
        />,
      );
    });
  };
  const tick = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });
  const table = () => host.querySelector<HTMLElement>('[aria-label="PRR ownership"]') as HTMLElement;
  const proxies = () => table().querySelectorAll(".app-stock-proxy-travel");
  const shares = (holder: string) => {
    const cells = table().querySelectorAll<HTMLElement>("[data-stock-cell]");
    for (let index = 0; index < cells.length; index += 1) {
      if (cells[index].getAttribute("data-stock-cell") === holder) return (cells[index].textContent ?? "").trim();
    }
    throw new Error(`no row for ${holder}`);
  };
  /** Timers armed beyond what the plain roster arms on its own. */
  let baseline = 0;
  const armedTimers = () => jest.getTimerCount() - baseline;

  beforeEach(() => {
    surfaceSelector = "[data-stock-card]";
    jest.useFakeTimers();
    cues = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    render(null);
    baseline = jest.getTimerCount();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    jest.useRealTimers();
  });

  describe("C-7: VF-1's transfer proxy", () => {
    it("on screen: draws the proxy from `before`, arms its timers and sounds the presidency cue", () => {
      render(takeover(1));
      expect(proxies()).toHaveLength(1);
      expect(shares(BOB)).toContain("30%");
      expect(armedTimers()).toBeGreaterThan(0);
      tick(TRANSFER_MS * 4);
      expect(cues).toEqual(["presidency"]);
    });

    it("scrolled away: no proxy, no staging timers -- the committed board -- but the presidency cue still sounds", () => {
      surfaceBox = BELOW_FOLD;
      render(takeover(2));
      expect(proxies()).toHaveLength(0);
      expect(shares(BOB)).toContain("50%");
      expect(armedTimers()).toBe(1); // the cue's single timer; none of the sequence's stage/apply timers
      tick(TRANSFER_MS * 4);
      expect(cues).toEqual(["presidency"]);
    });

    it("page in the background: the same, though the card itself is on screen", () => {
      visibility = "hidden";
      render(takeover(3));
      expect(proxies()).toHaveLength(0);
      expect(shares(BOB)).toContain("50%");
      expect(armedTimers()).toBe(1); // the cue's single timer
      tick(TRANSFER_MS * 4);
      expect(cues).toEqual(["presidency"]);
    });

    it("is not launched late when the card scrolls back into view (#1453/#1454)", () => {
      surfaceBox = BELOW_FOLD;
      const declined = takeover(4);
      render(declined);
      surfaceBox = ON_SCREEN;
      render(declined);
      expect(proxies()).toHaveLength(0);
      expect(armedTimers()).toBe(1); // still only the declined takeover's cue timer
      tick(TRANSFER_MS * 4);
      expect(cues).toEqual(["presidency"]); // once -- the scroll back neither launches nor re-sounds it
      // The NEXT transaction is a new launch and is judged afresh.
      render(takeover(5));
      expect(proxies()).toHaveLength(1);
    });
  });

  describe("E-6: VF-3's float ceremony", () => {
    const float = (token: number): CorporationFloatEvent => ({ companyId: PRR, ticker: "PRR", token });

    it("on screen: the ceremony's timers are armed", () => {
      render(null, float(1));
      expect(armedTimers()).toBeGreaterThan(0);
    });

    it("scrolled away: no timers are armed and no cue sounds", () => {
      surfaceBox = BELOW_FOLD;
      render(null, float(2));
      expect(armedTimers()).toBe(0);
      tick(FLOAT_TOTAL_MS);
      expect(cues).toEqual([]);
    });

    it("pane mounted but hidden (a zero-size box): no timers", () => {
      surfaceBox = NO_BOX;
      render(null, float(3));
      expect(armedTimers()).toBe(0);
    });

    it("page in the background: no timers", () => {
      visibility = "hidden";
      render(null, float(4));
      expect(armedTimers()).toBe(0);
    });

    it("reduced motion is outside the gate, unchanged: the reduced ceremony still plays off screen", () => {
      (window as unknown as { matchMedia: (query: string) => { matches: boolean } }).matchMedia = () => ({
        matches: true,
      });
      try {
        surfaceBox = BELOW_FOLD;
        render(null, float(5));
        expect(armedTimers()).toBeGreaterThan(0);
        expect(table().closest(".app-stock-card")?.querySelector(".float-badge")).not.toBeNull();
      } finally {
        delete (window as unknown as { matchMedia?: unknown }).matchMedia;
      }
    });
  });
});

/* ---- the board's route signal (F-5) ------------------------------------------------- */

describe("F-5: VF-2's traveling route signal clock", () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: Array<{ id: number; run: FrameRequestCallback }> = [];
  let originalFrame: typeof window.requestAnimationFrame;
  let originalCancel: typeof window.cancelAnimationFrame;
  let observers: Array<{ callback: IntersectionObserverCallback; observed: Element[]; disconnected: boolean }>;

  /* G5 -> F6 -> G7, `routeSignalGeometry.test.ts`'s own real-board route. One identity for the whole case, as
     the shell memoises it. */
  const OVERLAYS: readonly RouteOverlay[] = [
    { trainLabel: "2-Train", color: "#38bdf8", hexes: [[-1, 6], [0, 5], [0, 6]], trainIndex: 0 },
  ];
  const GRID = { game_id: 1, tiles: [] };

  const board = (routeOverlays: readonly RouteOverlay[] = OVERLAYS) => {
    act(() => {
      root.render(createElement(HexGridRenderer, { mapGrid: GRID, width: 900, height: 700, routeOverlays }));
    });
  };
  const runFrame = () => {
    const waiting = frames;
    frames = [];
    act(() => {
      waiting.forEach((frame) => frame.run(performance.now()));
    });
  };

  beforeEach(() => {
    /* The board's wrapper is the surface: the one `div` whose inline height is the board's. */
    surfaceSelector = 'div[style*="height: 700px"]';
    frames = [];
    observers = [];
    originalFrame = window.requestAnimationFrame;
    originalCancel = window.cancelAnimationFrame;
    let nextFrame = 1;
    window.requestAnimationFrame = (run: FrameRequestCallback) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.push({ id, run });
      return id;
    };
    window.cancelAnimationFrame = (id: number) => {
      frames = frames.filter((frame) => frame.id !== id);
    };
    jest.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.requestAnimationFrame = originalFrame;
    window.cancelAnimationFrame = originalCancel;
    delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  });

  const installObserver = () => {
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      private record: { callback: IntersectionObserverCallback; observed: Element[]; disconnected: boolean };
      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, observed: [], disconnected: false };
        observers.push(this.record);
      }
      observe(node: Element) {
        this.record.observed.push(node);
      }
      disconnect() {
        this.record.disconnected = true;
      }
      unobserve() {}
      takeRecords() {
        return [];
      }
    };
  };
  const report = (isIntersecting: boolean) => {
    const live = observers.filter((entry) => !entry.disconnected);
    act(() => {
      live.forEach((entry) =>
        entry.callback(
          [{ isIntersecting, target: entry.observed[0] } as unknown as IntersectionObserverEntry],
          {} as IntersectionObserver,
        ),
      );
    });
  };

  it("with nothing to animate, requests no frames at all", () => {
    board([]);
    expect(frames).toHaveLength(0);
  });

  it("visible: requests a frame, and each frame requests the next", () => {
    board();
    expect(frames).toHaveLength(1);
    runFrame();
    expect(frames).toHaveLength(1);
  });

  it("document hidden: stops requesting frames, and resumes when the page comes back", () => {
    board();
    expect(frames).toHaveLength(1);
    setVisibility("hidden");
    expect(frames).toHaveLength(0);
    // A re-render while hidden does not restart it.
    board();
    expect(frames).toHaveLength(0);
    setVisibility("visible");
    expect(frames).toHaveLength(1);
    runFrame();
    expect(frames).toHaveLength(1);
  });

  it("mounted while the page is hidden: requests nothing until it is shown", () => {
    visibility = "hidden";
    board();
    expect(frames).toHaveLength(0);
    setVisibility("visible");
    expect(frames).toHaveLength(1);
  });

  it("board off screen (IntersectionObserver): no frames, re-armed when it scrolls back", () => {
    installObserver();
    surfaceBox = BELOW_FOLD;
    board();
    expect(frames).toHaveLength(0);
    report(true);
    expect(frames).toHaveLength(1);
    report(false);
    expect(frames).toHaveLength(0);
    report(true);
    expect(frames).toHaveLength(1);
  });

  it("board on screen (IntersectionObserver): frames from the first commit, before any report", () => {
    installObserver();
    surfaceBox = ON_SCREEN;
    board();
    expect(frames).toHaveLength(1);
  });
});
