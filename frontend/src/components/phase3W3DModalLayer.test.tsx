/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W3-D (OD-15(b), AUD-13.06): ONE MODAL ARCHITECTURE, AND SEMANTICS THAT MATCH BEHAVIOUR
// ==================================================================
//
// THE RULING. Actual modal UI converges on native `<dialog>` + `showModal()` through `NativeModal`; the top layer
// supplies the isolation; no global manual-inert system; `ModalPortal` retired once its last legitimate consumer
// has migrated. And the semantic rule: a surface that is not genuinely modal loses its false modal semantics
// rather than being wrapped in `NativeModal`.
//
// WHAT THIS SUITE PINS:
//   1. PrivateTradePanel, classified by BEHAVIOUR: it is a step of the action bar, rendered in place beside the
//      board, and so carries no dialog role, no `aria-modal`, no scrim and no close -- whatever a caller passes.
//   2. `ModalPortal` has one consumer left, `NativeModal`, and no other source renders or imports it.
//   3. No source builds manual inert machinery; the one `inert` in the app is the cinematic cover (OD-15(a)).
//   4. Every `aria-modal="true"` left in source is on the explicit list below, with its owner and reason.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ProposePrivatePurchase } from "./PrivateTradePanel";
import { NATIVE_MODAL_ATTRIBUTE } from "./NativeModal";
import { MODAL_LAYER_ATTRIBUTE } from "./ModalPortal";
import { operatingBoard, P1, P2, DH, MH } from "../utils/offerFixtures74";
import { discoverSources, readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => undefined;
const labelFor = (address: string) => ({ [P1]: "Ann", [P2]: "Ben" } as Record<string, string>)[address] ?? address;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const PRIVATES = operatingBoard({
  privates: [
    { id: DH, owner: P2, cost: "70" },
    { id: MH, owner: P1, cost: "110" },
  ],
}).private_companies;

/** The bar's step, as the bar mounts it -- beside a board control, inside the same container. */
function Step({ embedded }: { embedded?: boolean }) {
  return (
    <div data-testid="bar">
      <button type="button" data-testid="board-control">
        Lay track
      </button>
      <ProposePrivatePurchase
        {...(embedded === undefined ? {} : { embedded })}
        open
        buyerTicker="PRR"
        privates={PRIVATES}
        treasury={500}
        labelForAddress={labelFor}
        onPropose={noop}
        onClose={noop}
      />
    </div>
  );
}

describe("1. PrivateTradePanel is a panel, not a modal (classified by what it does)", () => {
  it.each([
    ["as the bar mounts it (embedded)", true],
    ["even for a caller that omits `embedded`", undefined],
    ["even for a caller that passes `embedded={false}`", false],
  ] as const)("renders in place, beside the board, with no modal claim -- %s", (_label, embedded) => {
    const showModal = jest.fn();
    const original = (HTMLElement.prototype as unknown as { showModal?: unknown }).showModal;
    (HTMLElement.prototype as unknown as { showModal?: unknown }).showModal = showModal;
    try {
      act(() => root.render(<Step embedded={embedded} />));
      const bar = host.querySelector<HTMLElement>('[data-testid="bar"]')!;
      /* It renders: the cards are there, in the bar's own subtree, after the board control. */
      expect(bar.textContent).toContain("Delaware & Hudson");
      const panel = bar.lastElementChild as HTMLElement;
      expect(panel).not.toBe(bar.querySelector('[data-testid="board-control"]'));
      expect(panel.parentElement).toBe(bar);
      /* Open a card -- the form, with its submit, is inside the step too. */
      const title = Array.from(bar.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Delaware & Hudson"))!;
      act(() => title.click());
      expect(bar.textContent).toContain("Propose Purchase to Ben");
      /* No modal claim anywhere in it, open or closed. */
      expect(bar.querySelector("[aria-modal], [role='dialog'], [role='alertdialog'], dialog")).toBeNull();
      expect(document.querySelector(`[${NATIVE_MODAL_ATTRIBUTE}]`)).toBeNull();
      expect(showModal).not.toHaveBeenCalled();
      /* No scrim: nothing in it is fixed to the viewport. */
      const fixed = Array.from(bar.querySelectorAll<HTMLElement>("*")).filter((n) => n.style.position === "fixed");
      expect(fixed).toEqual([]);
      /* No close: a step has nothing to close (#715). */
      expect(bar.querySelector('button[aria-label="Close"]')).toBeNull();
      /* And nothing beside it was taken out of reach. */
      expect(bar.querySelector('[data-testid="board-control"]')!.closest("[inert]")).toBeNull();
    } finally {
      (HTMLElement.prototype as unknown as { showModal?: unknown }).showModal = original;
    }
  });

  it("its source holds no modal shape to fall back into", () => {
    const source = readStripped("components/PrivateTradePanel.tsx");
    const propose = source.slice(source.indexOf("export function ProposePrivatePurchase("), source.indexOf("export interface PrivateTradePromptProps"));
    expect(propose.length).toBeGreaterThan(0);
    for (const banned of ['role="dialog"', "aria-modal", "styles.backdrop", "styles.card}", "!embedded", "NativeModal"]) {
      expect([banned, propose.includes(banned)]).toEqual([banned, false]);
    }
    expect(propose).toContain("return body;");
  });
});

/* Every non-test source file, comment-stripped. */
const SOURCES = discoverSources("").map((rel) => [rel, readStripped(rel)] as const);

describe("2. ModalPortal has one consumer left: NativeModal", () => {
  it("is rendered and imported by NativeModal and by no other source", () => {
    expect(SOURCES.length).toBeGreaterThan(100);
    const renders = SOURCES.filter(([, code]) => code.includes("<ModalPortal")).map(([rel]) => rel);
    expect(renders).toEqual(["components/NativeModal.tsx"]);
    const imports = SOURCES.filter(([, code]) => /import\s*\{[^}]*\bModalPortal\b[^}]*\}\s*from/.test(code)).map(([rel]) => rel);
    expect(imports).toEqual(["components/NativeModal.tsx"]);
  });

  it("the Lobby's pilot wrapper is gone, and Host Game still reaches the layer through NativeModal", () => {
    expect(readStripped("components/Lobby.tsx").includes("ModalPortal")).toBe(false);
    expect(readStripped("components/HostSetupCard.tsx").includes("<NativeModal")).toBe(true);
  });

  it("the layer stays a scaled destination with no dialog or inert concerns of its own", () => {
    const portal = readStripped("components/ModalPortal.tsx");
    expect(portal).toContain("zoom: uiScale");
    for (const banned of ["inert", "aria-hidden", "showModal", "Escape"]) {
      expect([banned, portal.includes(banned)]).toEqual([banned, false]);
    }
  });

  it("neither cinematic is a consumer: both are takeovers outside the layer", () => {
    for (const file of ["components/GameIntroOverlay.tsx", "components/GameOutroOverlay.tsx"]) {
      const code = readStripped(file);
      expect([file, code.includes("ModalPortal"), code.includes(MODAL_LAYER_ATTRIBUTE)]).toEqual([file, false, false]);
    }
  });
});

describe("3. no manual inert machinery (OD-15(b))", () => {
  it("the only inert the app writes is the cinematic cover on the shell root", () => {
    /* Every way to write it: the property, `setAttribute`, a JSX attribute (with or without a value), and an
       object key headed for a spread. */
    const writers = SOURCES.filter(([, code]) =>
      /\.inert\s*=|setAttribute\(\s*["']inert["']|\sinert(?:=|[ \t]*\/?>|[ \t]+[\w-]+=)|\{\s*inert\s*:|["']inert["']\s*:/.test(code),
    ).map(([rel]) => rel);
    expect(writers).toEqual(["components/CinematicTakeover.tsx"]);
  });
});

describe("4. every aria-modal left in source is classified", () => {
  /* The only surfaces still claiming `aria-modal` on a hand-written element, each with its owner and reason. A
     new one fails here until it is classified; a migrated one fails here until it is struck from the list. */
  const CLASSIFIED: Record<string, string> = {
    /* AUD-13.04: GENUINELY MODAL (a library the player opens and closes; the notice blocks the board while up), so
       its target is NativeModal. Owner ruling OD-5 (restated at the Phase-3 consolidated integration, 2026-10-05):
       the tutorial work -- this conversion included -- is the FINAL tutorial pass's (contextual whitebox / spotlight,
       built last), not W3-D's now. Not touched by this pass. */
    "components/TutorialModal.tsx": "AUD-13.04 -- deferred to the final tutorial pass (OD-5)",
    /* CLASSIFIED BY BEHAVIOUR (W3-D review L4): GENUINELY MODAL -- a fixed scrim that blocks the board by pointer,
       with no keyboard isolation -- so under OD-15(b) its target is NativeModal, not the removal of the claim. Its
       migration is deferred, not refused: the President's card hands off to the MAP, and a top-layer dialog would
       make the board it needs inert (nativeModalBoundary's note). The plan keeps it out of W3-D; W2-H settled it. */
    "components/HomeStationPrompt.tsx": "genuinely modal; NativeModal migration deferred (map hand-off); W2-H's, excluded from W3-D",
  };
  it("lists exactly the surfaces that still carry it", () => {
    const carriers = SOURCES.filter(([, code]) => /aria-modal=["{]/.test(code)).map(([rel]) => rel);
    expect(carriers).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it("the two W3-D surfaces no longer carry it", () => {
    for (const file of ["components/GameIntroOverlay.tsx", "components/PrivateTradePanel.tsx"]) {
      expect([file, readStripped(file).includes("aria-modal")]).toEqual([file, false]);
    }
  });
});
