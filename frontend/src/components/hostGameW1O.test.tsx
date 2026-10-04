/** @jest-environment jsdom */
//
// ==================================================================
//  W1-O (harness): HOST GAME ACCESSIBILITY, THE SCALE'S PROVENANCE, ZOOM-AWARE BREAKPOINTS
// ==================================================================
//
// AUD-17.01 every Host Game option is NAMED by its label and DESCRIBED by its sentence (aria-describedby) ·
// AUD-17.02 Home/End in all three radio groups · AUD-17.03 the focus ring on the selected option leaves its green
// accent visible · AUD-16.02 the footer is outside the scrolling body, and the card's cap is asked in real viewport
// units under the layer's zoom · AUD-16.03 the picker says "chosen" or "automatic" · AUD-16.04 a refused write says
// the choice will not be remembered in this window · AUD-16.05 the Lobby / waiting-room / room-bar breakpoints switch
// at the same effective width at every scale.
//
// NOT HERE: `RulesReference.tsx`'s breakpoint block. That hunk lands at integration after Lanes 5 and 6 (W1-L, W1-I),
// through the same `zoomAwareMediaCss` these surfaces use. `:focus-visible` and real layout are not implemented by
// jsdom; the at-360x640 footer and the rings are asserted structurally here and observed in a browser at the gate.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ModalLayerHost } from "./ModalPortal";
import HostSetupCard from "./HostSetupCard";
import { UiScalePicker } from "./UiScalePicker";
import { LobbyRoomList } from "./LobbyRoomList";
import {
  UI_SCALE_NOT_REMEMBERED,
  getUiScaleStatus,
  resetUiScaleForTests,
  setUiScale,
  zoomAwareMediaCss,
  zoomAwareVh,
  zoomAwareWidthPx,
} from "../utils/uiScale";
import { readStripped, readSource } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "1830juno.ui_scale.v1";

let layerHost: HTMLDivElement;
let layerRoot: Root;
let host: HTMLDivElement;
let root: Root;

function mountLayer() {
  layerHost = document.createElement("div");
  document.body.appendChild(layerHost);
  layerRoot = createRoot(layerHost);
  act(() => layerRoot.render(<ModalLayerHost />));
}

function render(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(node));
}

beforeEach(() => {
  window.localStorage.clear();
  resetUiScaleForTests();
  mountLayer();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  act(() => layerRoot.unmount());
  layerHost.remove();
  jest.restoreAllMocks();
  window.localStorage.clear();
  resetUiScaleForTests();
});

const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!node) throw new Error(`no ${id}`);
  return node;
};
const textOfIds = (ids: string | null) =>
  (ids ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? `<missing ${id}>`)
    .join(" ");

const mountHost = () => render(<HostSetupCard busy={false} error={null} onClose={() => {}} onCreate={() => {}} />);

const GROUPS: Readonly<Record<string, ReadonlyArray<string>>> = {
  Game: ["host-type-standard", "host-type-plus", "host-type-levelPlayingField"],
  Pace: ["host-pace-live", "host-pace-async"],
  Visibility: ["host-visibility-public", "host-visibility-private"],
};

describe("AUD-17.01: each option is named by its label and described by its sentence", () => {
  it("every radio's description is its blurb, and its name is not the blurb run together with the label", () => {
    mountHost();
    for (const ids of Object.values(GROUPS)) {
      for (const id of ids) {
        const radio = byTestId(id);
        const name = textOfIds(radio.getAttribute("aria-labelledby"));
        const description = textOfIds(radio.getAttribute("aria-describedby"));
        expect([id, name.length > 0, description.length > 0]).toEqual([id, true, true]);
        expect([id, name.includes(description)]).toEqual([id, false]);
        expect([id, (radio.textContent ?? "").includes(description)]).toEqual([id, true]);
      }
    }
    expect(textOfIds(byTestId("host-visibility-private").getAttribute("aria-describedby"))).toBe(
      "Unlisted. Players join by room code only, and nobody can watch.",
    );
  });

  it("step two: the selects, the ante and every house rule are described by the sentence under them", () => {
    mountHost();
    act(() => byTestId<HTMLButtonElement>("host-continue").click());
    const players = byTestId("host-player-count");
    expect(textOfIds(players.getAttribute("aria-describedby"))).toMatch(/seats are ready/);
    const bank = byTestId("host-bank-size");
    expect(textOfIds(bank.getAttribute("aria-describedby")).length).toBeGreaterThan(0);
    for (const key of ["gentleRust", "dynamicStockMarket", "delayedAuction", "unpredictableRevenue"]) {
      const box = byTestId(`host-rule-${key}`);
      expect([key, textOfIds(box.getAttribute("aria-labelledby")).length > 0]).toEqual([key, true]);
      expect([key, textOfIds(box.getAttribute("aria-describedby")).length > 10]).toEqual([key, true]);
    }
    const ante = document.querySelector<HTMLInputElement>('input[aria-label="Ante"]');
    if (ante) expect(textOfIds(ante.getAttribute("aria-describedby"))).toMatch(/Antes are off/);
  });
});

describe("AUD-17.02: Home and End move focus and selection together, in all three groups", () => {
  const press = (target: HTMLElement, key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };

  for (const [group, ids] of Object.entries(GROUPS)) {
    it(`${group}: End selects the last, Home the first; the page is not scrolled`, () => {
      mountHost();
      const first = byTestId(ids[0]);
      const last = byTestId(ids[ids.length - 1]);
      first.focus();
      const end = press(first, "End");
      expect(end.defaultPrevented).toBe(true);
      expect(last.getAttribute("aria-checked")).toBe("true");
      expect(last.tabIndex).toBe(0);
      expect(document.activeElement).toBe(last);
      const home = press(last, "Home");
      expect(home.defaultPrevented).toBe(true);
      expect(first.getAttribute("aria-checked")).toBe("true");
      expect(document.activeElement).toBe(first);
      expect(ids.filter((id) => byTestId(id).getAttribute("aria-checked") === "true")).toEqual([ids[0]]);
    });
  }

  it("other keys are not swallowed", () => {
    mountHost();
    const first = byTestId(GROUPS.Pace[0]);
    expect(press(first, "a").defaultPrevented).toBe(false);
  });
});

describe("AUD-17.03: the selected option keeps its accent inside the ring", () => {
  it("keeps the house ring for an unselected option and stands the ring off, in the accent's green, on the selected one", () => {
    const raw = readSource("components/HostSetupCard.tsx");
    expect(raw).toContain(".host-segment:focus-visible { outline: 2px solid #8a8a86; outline-offset: 2px; }");
    expect(raw).toMatch(
      /\.host-type-card\[aria-checked="true"\]:focus-visible,\s*\.host-segment\[aria-checked="true"\]:focus-visible \{ outline-color: #9fe0b8; outline-offset: 3px; \}/,
    );
    // The accent itself is untouched: border shorthand plus the inset line (#1448a).
    expect(raw).toContain('segmentSelected: { border: "1px solid #6fae86"');
  });
});

describe("AUD-16.02: the footer is reachable without scrolling the card", () => {
  it("keeps the footer outside the scrolling body, on both steps", () => {
    mountHost();
    for (const step of ["type", "rules"]) {
      const body = byTestId("host-body");
      const footer = byTestId("host-footer");
      expect([step, body.contains(footer)]).toEqual([step, false]);
      expect([step, body.parentElement === footer.parentElement]).toEqual([step, true]);
      expect([step, body.style.overflowY, body.style.minHeight]).toEqual([step, "auto", "0"]);
      // `flex: none` (jsdom normalises it to its longhand form): the footer never shrinks into the body.
      expect([step, ["none", "0 0 auto"].includes(footer.style.flex)]).toEqual([step, true]);
      const card = footer.parentElement as HTMLElement;
      expect([step, card.style.overflow]).toEqual([step, "hidden"]);
      // The primary control is the footer's.
      expect(footer.querySelector(step === "type" ? '[data-testid="host-continue"]' : '[data-testid="host-create-room"]')).not.toBeNull();
      if (step === "type") act(() => byTestId<HTMLButtonElement>("host-continue").click());
    }
  });

  it("caps the card at the window, in real viewport units, at two scales", () => {
    mountHost();
    const card = () => byTestId("host-footer").parentElement as HTMLElement;
    expect(card().style.maxHeight).toBe("calc(100vh - 48px)");
    act(() => setUiScale(1.25));
    // 80vh inside a 1.25 zoom is 100 real vh: the card ends where the window does.
    expect(card().style.maxHeight).toBe("calc(80vh - 48px)");
    expect(zoomAwareVh(100, 0.75)).toBe("133.333vh");
  });
});

describe("AUD-16.03 / AUD-16.04: the readout says where the number came from, and whether it will stick", () => {
  it("reads automatic on a first run, chosen after a press", () => {
    render(<UiScalePicker />);
    expect(byTestId("ui-scale-provenance").textContent).toBe("automatic");
    expect(getUiScaleStatus()).toEqual({ scale: 1, provenance: "automatic", remembered: true });
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Larger text"]')!.click());
    expect(byTestId("ui-scale-readout").textContent).toBe("110%");
    expect(byTestId("ui-scale-provenance").textContent).toBe("chosen");
    expect(window.localStorage.getItem(KEY)).toBe("1.1");
    expect(byTestId("ui-scale-status").textContent).toBe("");
  });

  it("reads chosen when this browser already holds a choice", () => {
    window.localStorage.setItem(KEY, "0.9");
    act(() => resetUiScaleForTests());
    render(<UiScalePicker />);
    expect(byTestId("ui-scale-readout").textContent).toBe("90%");
    expect(byTestId("ui-scale-provenance").textContent).toBe("chosen");
  });

  it("says the choice will not be remembered in this window when storage refuses the write", () => {
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    render(<UiScalePicker />);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Smaller text"]')!.click());
    // The choice still applies, live, in this window...
    expect(byTestId("ui-scale-readout").textContent).toBe("90%");
    // ...and the player is told it will not survive a reload.
    expect(getUiScaleStatus()).toEqual({ scale: 0.9, provenance: "chosen", remembered: false });
    expect(byTestId("ui-scale-provenance").textContent).toBe("not saved");
    expect(byTestId("ui-scale-status").textContent).toBe(UI_SCALE_NOT_REMEMBERED);
    expect(UI_SCALE_NOT_REMEMBERED).toContain("will not be remembered in this window");
    const group = document.querySelector('[role="group"][aria-label="Text size"]')!;
    expect(group.getAttribute("title")).toContain(UI_SCALE_NOT_REMEMBERED);
  });
});

describe("AUD-16.05: breakpoints switch at the same effective width at every scale", () => {
  const SHEET = `
.a { max-width: 899px; }
@media (max-width: 899px) { .a { display: none; } }
@media (min-width: 761px) { .b { display: block; } }
@media (max-width: 760px) { .b { display: none; } }
@media (hover: hover) and (pointer: fine) { .c:hover { color: red; } }
@media (prefers-reduced-motion: reduce) { .d { animation: none; } }
`;

  it("is the authored sheet, byte for byte, at 100%", () => {
    expect(zoomAwareMediaCss(SHEET, 1)).toBe(SHEET);
  });

  it("scales only the width features of @media preludes, at two scales", () => {
    const big = zoomAwareMediaCss(SHEET, 1.25);
    expect(big).toContain("@media (max-width: 1124.99px)");
    expect(big).toContain("@media (min-width: 951.25px)");
    expect(big).toContain("@media (max-width: 951.24px)");
    // A declaration is a length, not a breakpoint; and non-width queries are left alone.
    expect(big).toContain(".a { max-width: 899px; }");
    expect(big).toContain("@media (hover: hover) and (pointer: fine)");
    expect(big).toContain("@media (prefers-reduced-motion: reduce)");
    const small = zoomAwareMediaCss(SHEET, 0.75);
    expect(small).toContain("@media (max-width: 674.99px)");
    expect(small).toContain("@media (min-width: 570.75px)");
  });

  it("keeps an authored max/min pair contiguous at every step of the ladder", () => {
    for (const scale of [0.63, 0.75, 0.9, 1.1, 1.25]) {
      const max = zoomAwareWidthPx("max-width", 760, scale);
      const min = zoomAwareWidthPx("min-width", 761, scale);
      // No window width falls in neither layout (beyond the 0.01px the max feature leaves for rounding).
      expect([scale, Math.round((min - max) * 100) / 100]).toEqual([scale, 0.01]);
    }
  });

  it("the Lobby's public-games list renders its breakpoint in zoomed pixels", () => {
    const props = { rooms: [], loading: false, error: null, available: true, busy: false, refusal: null, onJoin: () => {}, onWatch: () => {} };
    render(<LobbyRoomList {...props} />);
    const css = () => Array.from(host.querySelectorAll("style")).map((el) => el.textContent ?? "").join("\n");
    expect(css()).toContain("@media (max-width: 899px)");
    act(() => setUiScale(1.25));
    expect(css()).toContain("@media (max-width: 1124.99px)");
    expect(css()).not.toContain("@media (max-width: 899px)");
  });

  it("every other changed surface hands its sheet through the helper with the live scale", () => {
    for (const [file, sheet] of [
      ["components/Lobby.tsx", "LOBBY_CSS"],
      ["components/LobbyRoomList.tsx", "LOBBY_ROOMS_CSS"],
      ["components/SandboxRoomBar.tsx", "BARE_BUTTON_CSS"],
      ["components/SandboxWaitingRoom.tsx", "WAITING_ROOM_CSS"],
    ] as const) {
      const src = readStripped(file);
      expect([file, src.includes(`<style>{zoomAwareMediaCss(${sheet}, uiScale)}</style>`)]).toEqual([file, true]);
      expect([file, src.includes(`<style>{${sheet}}</style>`)]).toEqual([file, false]);
    }
  });
});
