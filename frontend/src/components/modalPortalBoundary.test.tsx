/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1648 (harness): THE LAYER, AND HOST GAME AS ITS PILOT
// ==================================================================
//
// The audit's H1 -- `aria-modal="true"` on twenty-one surfaces with the background still reachable by
// keyboard -- is fixed by making the background `inert` while a modal is up. That was impossible while every
// modal rendered INSIDE the screen it covers: `inert` on the screen would disable the modal with it.
//
// This suite pins the structural fix and nothing else. `inert` is NOT applied here.
//
// WHAT THE HARNESS REPRODUCES is `GameRouter`'s exact topology, which is the thing under test:
//
//     <screen root div>      <- carries the chrome zoom; the FUTURE `inert` target
//       opener, background controls, and {open && <ModalPortal><HostSetupCard/></ModalPortal>}
//     <div data-modal-layer> <- carries the same zoom, once; the card's DOM lands here
//
// It does not mount the real `Lobby`, which needs a server link; the real wiring is exercised in Chromium and
// recorded in the note. What these cases assert is the RELATIONSHIP -- that the card is a React child of the
// screen and a DOM child of the layer at the same time, and that everything Host Game does still works across
// that split.
//
// THE FIFTY HOST GAME CASES ARE UNTOUCHED. They mount the card directly, which is still a supported way to
// use it, and they remain the behavioural record; these are the boundary cases the migration adds.

import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import HostSetupCard from "./HostSetupCard";
import { ModalLayerHost, ModalPortal, MODAL_LAYER_ATTRIBUTE } from "./ModalPortal";
import { readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let closes = 0;
let backgroundClicks = 0;
let screenRootClicks = 0;
let keydownListeners = 0;

function spyListeners() {
  keydownListeners = 0;
  jest.spyOn(window, "addEventListener").mockImplementation(function (this: Window, ...a: never[]) {
    if (a[0] === ("keydown" as never)) keydownListeners += 1;
    return (Window.prototype.addEventListener as never as (...x: never[]) => void).apply(this, a);
  } as never);
  jest.spyOn(window, "removeEventListener").mockImplementation(function (this: Window, ...a: never[]) {
    if (a[0] === ("keydown" as never)) keydownListeners -= 1;
    return (Window.prototype.removeEventListener as never as (...x: never[]) => void).apply(this, a);
  } as never);
}

let setOpen: (open: boolean) => void = () => {};

/** `GameRouter`'s shape: one screen root, the layer beside it, the card portalled from inside the screen. */
function Harness({
  busy = false,
  withLayer = true,
  initiallyOpen = false,
}: {
  busy?: boolean;
  withLayer?: boolean;
  initiallyOpen?: boolean;
}) {
  const [open, setOpenState] = useState(initiallyOpen);
  setOpen = setOpenState;
  return (
    <>
      <div
        data-testid="screen-root"
        onClick={() => {
          screenRootClicks += 1;
        }}
      >
        <button type="button" data-testid="opener" onClick={() => setOpenState(true)}>
          Host game
        </button>
        <button
          type="button"
          data-testid="background-control"
          onClick={() => {
            backgroundClicks += 1;
          }}
        >
          Join game
        </button>
        {/* #1651: the card portals ITSELF now -- `NativeModal` owns the placement, so wrapping it here
            would portal it twice. What this harness still reproduces is `GameRouter`'s shape: a screen root
            with the opener and a background control inside it, and the layer beside it. */}
        {open && (
          <HostSetupCard
            busy={busy}
            error={null}
            onClose={() => {
              closes += 1;
              setOpenState(false);
            }}
            onCreate={() => {}}
          />
        )}
      </div>
      {withLayer && <ModalLayerHost />}
    </>
  );
}

function mount(opts: { busy?: boolean; withLayer?: boolean; initiallyOpen?: boolean } = {}) {
  closes = 0;
  backgroundClicks = 0;
  screenRootClicks = 0;
  spyListeners();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <Harness
        busy={opts.busy ?? false}
        withLayer={opts.withLayer ?? true}
        initiallyOpen={opts.initiallyOpen ?? false}
      />,
    ),
  );
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  jest.restoreAllMocks();
  document.body.innerHTML = "";
}

const at = (testid: string) => {
  const node = document.querySelector<HTMLElement>('[data-testid="' + testid + '"]');
  if (!node) throw new Error("no " + testid);
  return node;
};
const layer = () => {
  const node = document.querySelector<HTMLElement>(`[${MODAL_LAYER_ATTRIBUTE}]`);
  if (!node) throw new Error("no modal layer");
  return node;
};
/* #1652: the dialog is the ELEMENT. The visual card inside it is an ordinary div, and both are needed --
   one for placement and semantics, one for the Tab trap and the click that must not dismiss. */
const card = () => document.querySelector<HTMLElement>("dialog[data-native-modal]");
const visualCard = () => document.querySelector<HTMLElement>(".host-card");
const openCard = () => {
  const node = card();
  if (!node) throw new Error("no dialog");
  return node;
};
/* #1651: the scrim and the dialog are the same element now. */
const backdrop = () => openCard();
const closeButton = () => openCard().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
const labelled = (text: string) =>
  Array.from(openCard().querySelectorAll("button")).find((b) => (b.textContent || "").trim() === text) as
    | HTMLButtonElement
    | undefined;

const open = () => act(() => setOpen(true));
const click = (node: Element | null | undefined) =>
  act(() => void node?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
function press(key: string, opts: { shift?: boolean; target?: EventTarget } = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, shiftKey: opts.shift });
  act(() => void (opts.target ?? document.activeElement ?? window).dispatchEvent(event));
  if (key === "Escape") deliverCloseRequest(event);
  return event;
}

/* #1651: Escape is the platform's now, and jsdom has no platform. Measured in Chromium 141: a close request
   fires `cancel` then `close` on the element, and `closedby="none"` produces neither. This is that sequence,
   delivered only when nothing refused the key and the dialog's declared policy accepts it. */
function deliverCloseRequest(keydown: KeyboardEvent) {
  if (keydown.defaultPrevented) return;
  const node = document.querySelector<HTMLDialogElement>("dialog[data-native-modal]");
  if (!node) return;
  if (node.getAttribute("closedby") === "none") return;
  const cancelEvent = new Event("cancel", { bubbles: false, cancelable: true });
  act(() => void node.dispatchEvent(cancelEvent));
  if (cancelEvent.defaultPrevented) return;
  act(() => {
    node.removeAttribute("open");
    node.dispatchEvent(new Event("close"));
  });
}
const escape = () => press("Escape");

/* ================================================================== */
/*  The boundary itself                                                */
/* ================================================================== */

describe("Host Game renders in the modal layer, beside the screen rather than inside it", () => {
  beforeEach(() => mount());
  afterEach(() => unmount());

  it("puts the dialog's DOM inside the layer and outside the future inert subtree", () => {
    open();
    expect(layer().contains(openCard())).toBe(true);
    expect(at("screen-root").contains(openCard())).toBe(false);
    /* And the two are siblings, which is what makes `inert` on the screen safe later. */
    expect(layer().parentElement).toBe(at("screen-root").parentElement);
  });

  it("keeps the card a React child of the screen, so its close still runs the screen's handler", () => {
    /* The portal moves DOM, not the React tree. `onClose` is defined in the screen and must still fire. */
    open();
    escape();
    expect(card()).toBeNull();
    expect(closes).toBe(1);
  });

  it("leaves the layer empty and weightless when no modal is open", () => {
    expect(layer().childNodes).toHaveLength(0);
    expect(layer().getBoundingClientRect().height).toBe(0);
    open();
    expect(layer().childNodes.length).toBeGreaterThan(0);
    escape();
    expect(layer().childNodes).toHaveLength(0);
  });

  it("uses one host for the whole session rather than one per modal", () => {
    const first = layer();
    open();
    escape();
    open();
    expect(document.querySelectorAll(`[${MODAL_LAYER_ATTRIBUTE}]`)).toHaveLength(1);
    expect(layer()).toBe(first);
  });

  it("does not activate a background control when the backdrop is clicked", () => {
    open();
    click(backdrop());
    expect(card()).toBeNull();
    expect(backgroundClicks).toBe(0);
  });

  it("refuses to render without a layer rather than falling back to the body", () => {
    /* A silent `document.body` fallback would land outside every zoomed root -- wrong size now, and not
       excluded from the background `inert` later. Both are failures a reader would have to measure, so the
       portal throws instead. Caught through an error boundary rather than `expect().toThrow`, because React
       reports a render throw to the root and re-raises it asynchronously; the boundary is where a real
       application would see it too. */
    unmount();
    const quiet = jest.spyOn(console, "error").mockImplementation(() => {});
    let caught: string | null = null;

    class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error: Error) {
        caught = error.message;
      }
      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    const scratch = document.createElement("div");
    document.body.appendChild(scratch);
    const scratchRoot = createRoot(scratch);
    act(() =>
      scratchRoot.render(
        <Boundary>
          <ModalPortal>
            <div data-testid="orphan" />
          </ModalPortal>
        </Boundary>,
      ),
    );
    expect(caught).toMatch(/no modal layer found/);
    expect(document.querySelector('[data-testid="orphan"]')).toBeNull();
    act(() => scratchRoot.unmount());
    scratch.remove();
    quiet.mockRestore();
    document.body.innerHTML = "";
  });
});

/* ================================================================== */
/*  Host Game's behaviour, across the split                            */
/* ================================================================== */

describe("nothing Host Game does changed by moving its DOM", () => {
  beforeEach(() => mount());
  afterEach(() => unmount());

  it("keeps its accessible name and modality", () => {
    open();
    /* #1652 SUPERSEDES the `role`/`aria-modal` reads. The element IS the dialog: implicit role, modal by
       `showModal()`, named here -- and nothing inside it claims to be a dialog any more. */
    expect(openCard().tagName).toBe("DIALOG");
    expect(openCard().getAttribute("role")).toBeNull();
    expect(openCard().getAttribute("aria-modal")).toBeNull();
    expect(openCard().getAttribute("aria-label")).toBe("Host a game");
    expect(openCard().querySelectorAll('[role="dialog"], [aria-modal]')).toHaveLength(0);
  });

  it("still opens with the selected Game radio focused", () => {
    at("opener").focus();
    open();
    expect(document.activeElement).toBe(at("host-type-standard"));
  });

  it("still contains Tab and Shift+Tab inside the card, now from another subtree", () => {
    open();
    const stops = Array.from(openCard().querySelectorAll<HTMLElement>("button,input,[tabindex]")).filter(
      (n) => n.tabIndex >= 0 && !(n as HTMLButtonElement).disabled,
    );
    expect(stops.length).toBeGreaterThan(1);
    /* Forward from the last stop wraps to the first, and back from the first wraps to the last -- and neither
       lands on a background control. */
    stops[stops.length - 1].focus();
    press("Tab");
    expect(openCard().contains(document.activeElement)).toBe(true);
    expect(at("screen-root").contains(document.activeElement)).toBe(false);
    stops[0].focus();
    press("Tab", { shift: true });
    expect(openCard().contains(document.activeElement)).toBe(true);
    expect(at("screen-root").contains(document.activeElement)).toBe(false);
  });

  it("restores the opener from Escape, the x, Cancel and the backdrop alike", () => {
    ([
      () => escape(),
      () => click(closeButton()),
      () => click(labelled("Cancel")),
      () => click(backdrop()),
    ] as const).forEach((run) => {
      at("opener").focus();
      open();
      closeButton().focus();
      run();
      expect(card()).toBeNull();
      expect(document.activeElement).toBe(at("opener"));
    });
    expect(closes).toBe(4);
  });

  it("still moves focus to the step-two heading on Continue and back to the radio on Back", () => {
    open();
    click(labelled("Continue"));
    expect(openCard().contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).getAttribute("role")).toBe("heading");
    click(labelled("Back"));
    expect(document.activeElement).toBe(at("host-type-standard"));
  });

  it("still moves the radio selection and focus together with the arrow keys", () => {
    open();
    at("host-type-standard").focus();
    press("ArrowRight");
    expect(document.activeElement).toBe(at("host-type-plus"));
    expect(at("host-type-plus").getAttribute("aria-checked")).toBe("true");
  });

  it("still resets by unmounting, so a reopen starts from the defaults", () => {
    open();
    click(labelled("Continue"));
    expect(labelled("Create Room")).toBeDefined();
    escape();
    open();
    expect(labelled("Continue")).toBeDefined();
    expect(at("host-type-standard").getAttribute("aria-checked")).toBe("true");
  });

  it("holds no keydown listener at all, open or closed", () => {
    /* #1651 SUPERSEDES "exactly one while open". Escape is the `closedby` attribute and the engine enforces
       it, so there is no `window` listener to count -- and a flat zero is the stricter assertion. */
    expect(keydownListeners).toBe(0);
    open();
    expect(keydownListeners).toBe(0);
    escape();
    expect(keydownListeners).toBe(0);
  });

  it("still blocks every dismissal route while busy", () => {
    unmount();
    mount({ busy: true });
    open();
    /* #1651: Escape is refused by the engine now, which is what `closedby="none"` says out loud. */
    expect(openCard().getAttribute("closedby")).toBe("none");
    escape();
    click(closeButton());
    click(backdrop());
    expect(card()).not.toBeNull();
    expect(closes).toBe(0);
  });
});

/* ================================================================== */
/*  Structure                                                          */
/* ================================================================== */

describe("the layer is wired where the topology requires", () => {
  it("is rendered by GameRouter beside the screen, in both branches", () => {
    const app = readStripped("App.tsx");
    expect(app.includes("<ModalLayerHost />")).toBe(true);
    /* Both branches: the Lobby and the game shell each get one. */
    expect((app.match(/<ModalLayerHost \/>/g) || []).length).toBe(2);
  });

  it("carries the chrome scale once, and not chromeZoomFor's screen ground", () => {
    const portal = readStripped("components/ModalPortal.tsx");
    expect(portal.includes("useUiScale()")).toBe(true);
    expect(portal.includes("zoom: uiScale")).toBe(true);
    /* `chromeZoomFor` pairs the zoom with `minHeight: 100/scale vh`, which a layer that must occupy no space
       cannot have. */
    expect(portal.includes("chromeZoomFor")).toBe(false);
  });

  it("owns none of the dialog concerns", () => {
    const portal = readStripped("components/ModalPortal.tsx");
    ["useDialogDismissal", "Escape", "inert", "aria-hidden", "overflow", "z-index", "zIndex"].forEach((banned) => {
      expect([banned, portal.includes(banned)]).toEqual([banned, false]);
    });
  });

  it("is what the Lobby renders Host Game through", () => {
    const lobby = readStripped("components/Lobby.tsx");
    expect(lobby.includes("<ModalPortal>")).toBe(true);
    /* The mount lifecycle is unchanged: `hostSetup` still decides existence, so closing still unmounts. */
    expect(lobby.includes("{hostSetup && (")).toBe(true);
  });
});
