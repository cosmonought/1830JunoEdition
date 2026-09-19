/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1644 (harness): THE THREE PRIVATE ESCAPE LISTENERS ARE GONE
// ==================================================================
//
// Batch 3 of the modal audit's migration order. Unlike batches 1 and 2, these three surfaces ALREADY had
// Escape -- each with its own copy of `window.addEventListener("keydown")`. What they did not have was the
// rest of it. Measured on the real components beforehand, with focus on the control being pressed:
//
//                        | Escape  | focus after Escape | focus after x / secondary / backdrop | defaultPrevented
//   BuyLicenseModal      | closed  | <body>             | <body> / <body> / <body>             | IGNORED
//   MarketPeekModal      | closed  | the opener         | the opener / --  / the opener        | IGNORED
//   HeraldHomeFloatModal | closed  | <body>             | --      / <body> / <body>            | IGNORED
//
// So this batch corrects three things and adds none: the two surfaces that carried the listener without the
// opener capture stop dropping focus (audit H4); `MarketPeekModal`'s restoration gains the guards its own
// copy lacked (M1); and all three stop closing over an Escape a nested surface has already consumed (M2).
//
// `MarketPeekModal` IS THE ONE THAT COULD REGRESS, because it is the only audited surface that already
// restored focus. Its old code restored on `opener instanceof HTMLElement` alone. Measured on the real
// component before the change, that meant it ATTEMPTED `document.body.focus()` when nothing had been focused,
// and attempted `.focus()` on a node that had left the document -- neither of which had bitten, because its
// opener is a persistent chart control. The cases below prove the hook still restores that normal opener, and
// declines exactly the two attempts that were never wanted.
//
// NO NESTED UI WAS ADDED to demonstrate the first-refusal contract: the event is marked `defaultPrevented` in
// the harness, which is the contract itself.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/* #1651 (harness): EVERY DIALOG IN THIS FILE IS NOW A NATIVE `<dialog>` IN THE SHARED MODAL LAYER.
   `NativeModal` portals into `[data-modal-layer]` and throws if it is absent, so the harness renders
   `<ModalLayerHost />` beside its opener exactly as `GameRouter` does in the application. The dialog is the
   ELEMENT now, not a `<div role="dialog">` inside it (#1652 measured two dialog nodes in the accessibility
   tree before the correction), so every selector below reads `dialog[data-native-modal]`. */

import { ModalLayerHost } from "./ModalPortal";

import BuyLicenseModal from "./BuyLicenseModal";
import MarketPeekModal from "./MarketPeekModal";
import HeraldHomeFloatModal from "./HeraldHomeFloatModal";
import { readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const PEEK = {
  company: { company_id: 1, ticker: "PRR" },
  startNode: { x: 3, y: 3 },
  projectedNode: { x: 4, y: 3 },
  action: "pay" as const,
};
const NOTICE = { ticker: "PRR", hexLabel: "H12", place: "Altoona (H12)", revenue: 10, firstTokenCost: 40 };

let host: HTMLDivElement;
let root: Root;
let closes = 0;
let buys = 0;
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

type Which = "license" | "peek" | "herald";
let setOpen: (open: boolean) => void = () => {};
let setDoomed: (present: boolean) => void = () => {};

/** Each parent's real wiring: `BuyLicenseModal` and `HeraldHomeFloatModal` are mounted by `App.tsx` for the
 *  whole session and switched by a prop; `MarketPeekModal` is mounted on open. */
function Harness({ which, canBuy, extraOpener }: { which: Which; canBuy: boolean; extraOpener: boolean }) {
  const [open, setOpenState] = useState(false);
  const [doomedPresent, setDoomedState] = useState(extraOpener);
  setOpen = setOpenState;
  setDoomed = setDoomedState;
  const close = () => {
    closes += 1;
    setOpenState(false);
  };
  return (
    <>
      <button type="button" data-testid="opener">
        Open
      </button>
      <button type="button" data-testid="bystander">
        Bystander
      </button>
      {doomedPresent && (
        <button type="button" data-testid="doomed">
          Doomed opener
        </button>
      )}
      {which === "license" && (
        <BuyLicenseModal
          open={open}
          onClose={close}
          actingTicker={canBuy ? "PRR" : null}
          remaining={2}
          alreadyHeld={false}
          refusal={canBuy ? null : "It is not PRR's Lay Track step."}
          treasuryBefore={canBuy ? 500 : null}
          onBuy={() => {
            buys += 1;
          }}
        />
      )}
      {which === "peek" && open && <MarketPeekModal peek={PEEK} positions={[]} onClose={close} />}
      {which === "herald" && (
        <HeraldHomeFloatModal notice={open ? NOTICE : null} liveryColor="#123456" liveryInk="#ffffff" onDismiss={close} />
      )}
    </>
  );
}

/* #1651 (harness): THE LAYER IS COMMITTED BEFORE THE DIALOG, on a root of its own, because `ModalPortal`
   resolves its container during render and a sibling rendered in the SAME commit is not in the DOM yet. This
   is what the application does too -- `GameRouter` mounts the layer with the screen, and a modal opens later. */
let layerHost: HTMLDivElement | null = null;
let layerRoot: Root | null = null;

function mountLayer() {
  layerHost = document.createElement("div");
  document.body.appendChild(layerHost);
  layerRoot = createRoot(layerHost);
  act(() => {
    layerRoot!.render(<ModalLayerHost />);
  });
}

function unmountLayer() {
  act(() => layerRoot?.unmount());
  layerHost?.remove();
  layerRoot = null;
  layerHost = null;
}

function mount(which: Which, opts: { canBuy?: boolean; extraOpener?: boolean } = {}) {
  closes = 0;
  buys = 0;
  spyListeners();
  mountLayer();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(<Harness which={which} canBuy={opts.canBuy ?? true} extraOpener={opts.extraOpener ?? false} />),
  );
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  unmountLayer();
  jest.restoreAllMocks();
  document.body.innerHTML = "";
}

const at = (testid: string) => {
  const node = document.querySelector<HTMLElement>('[data-testid="' + testid + '"]');
  if (!node) throw new Error("no " + testid);
  return node;
};
const dialog = () => document.querySelector<HTMLElement>('dialog[data-native-modal]');
const openDialog = () => {
  const node = dialog();
  if (!node) throw new Error("no dialog");
  return node;
};
/* #1651: the scrim and the dialog are one element now, so a backdrop click is a click on it. */
const backdrop = openDialog;
const btn = (text: string) =>
  Array.from(openDialog().querySelectorAll("button")).find((b) => (b.textContent || "").trim() === text) as
    | HTMLButtonElement
    | undefined;
const closeX = () => openDialog().querySelector<HTMLButtonElement>('button[aria-label="Close"]');
const firstButton = () => openDialog().querySelector<HTMLElement>("button")!;

const open = () => act(() => setOpen(true));
const click = (node: Element | null | undefined) =>
  act(() => void node?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));

/* ==================================================================
    #1651 (harness): ESCAPE IS THE PLATFORM'S NOW, AND jsdom HAS NO PLATFORM
   ==================================================================
   These dialogs are native `<dialog>` elements and their Escape policy is the `closedby` attribute, which the
   engine enforces. Measured in Chromium 141: Escape on a modal dialog fires `cancel` then `close` on the
   ELEMENT; `closedby="none"` produces neither, even after six rapid presses; and a handler that calls
   `preventDefault()` on the keydown suppresses the request entirely. jsdom 16.7 implements none of
   `showModal`, `closedby` or close requests, so a bare `keydown` here reaches nothing at all.

   This helper is that measured sequence, and nothing more. The keydown still goes out -- so a nested surface
   can still refuse it, and any stray `window` listener would still be caught by the ledger cases -- and the
   close request is delivered only when nothing refused it AND the dialog's own declared policy accepts it.
   The policy is read from the DOM rather than from the harness's idea of it, which is why `NativeModal`
   writes `closedby` whether or not the engine understands it. */
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

function press(key: string, opts: { prevented?: boolean; target?: EventTarget } = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  if (opts.prevented) event.preventDefault();
  act(() => void (opts.target ?? document.activeElement ?? window).dispatchEvent(event));
  if (key === "Escape") deliverCloseRequest(event);
  return event;
}
const escape = (opts: { prevented?: boolean; target?: EventTarget } = {}) => press("Escape", opts);

/* ================================================================== */
/*  The contract all three now share                                   */
/* ================================================================== */

const SURFACES: Array<{ label: string; which: Which; name: string }> = [
  { label: "BuyLicenseModal", which: "license", name: "The Coalfields and the Kanawha Licence" },
  { label: "MarketPeekModal", which: "peek", name: "If you pay dividends: PRR on the market chart" },
  { label: "HeraldHomeFloatModal", which: "herald", name: "PRR has floated" },
];

describe.each(SURFACES)("$label goes through the shared boundary", ({ label, which, name }) => {
  beforeEach(() => mount(which));
  afterEach(() => unmount());

  it("still opens without moving focus, exactly as it did", () => {
    /* NONE OF THESE THREE HAS INITIAL FOCUS, and this batch does not give them any -- that is audit H2 and it
       belongs to its own pass. The case exists so that adding it later is deliberate. */
    at("opener").focus();
    open();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("keeps its accessible name and modality", () => {
    open();
    expect(openDialog().getAttribute("aria-label")).toBe(name);
    /* #1652 SUPERSEDES the `aria-modal="true"` read that stood here. The surface IS a `<dialog>` now: its
       role is implicit, `showModal()` is what makes it modal, and a nested `role="dialog"` inside it was the
       defect the correction removed (measured: two dialog nodes in the accessibility tree). */
    expect(openDialog().tagName).toBe("DIALOG");
    expect(openDialog().getAttribute("aria-modal")).toBeNull();
    expect(openDialog().getAttribute("role")).toBeNull();
    expect(openDialog().querySelectorAll('[role="dialog"], [aria-modal]')).toHaveLength(0);
  });

  it("dismisses on an ordinary Escape, through the authoritative close callback", () => {
    open();
    escape();
    expect(dialog()).toBeNull();
    expect(closes).toBe(1);
  });

  it("does NOT dismiss on an Escape a nested surface has already consumed", () => {
    /* THE CORRECTION. All three private listeners closed regardless -- measured `IGNORED (closed anyway)` --
       so two stacked layers would have gone on one keypress. The event is marked in the harness rather than
       by adding a nested UI that does not exist. */
    open();
    escape({ prevented: true });
    expect(dialog()).not.toBeNull();
    expect(closes).toBe(0);
  });

  it("does nothing on keys that are not Escape", () => {
    open();
    ["Enter", " ", "Tab", "ArrowDown", "Esc", "escape"].forEach((key) => press(key));
    expect(dialog()).not.toBeNull();
    expect(closes).toBe(0);
  });

  it("returns focus to the opener from Escape and from every close route it has", () => {
    const routes: Array<[string, () => void]> = [["Escape", () => escape()]];
    open();
    if (closeX()) routes.push(["x", () => click(closeX())]);
    const secondary = btn("Not now") ?? btn("Close") ?? btn("Understood ›");
    const secondaryLabel = secondary ? (secondary.textContent || "").trim() : null;
    if (secondaryLabel) routes.push([secondaryLabel, () => click(btn(secondaryLabel)!)]);
    routes.push(["backdrop", () => click(backdrop())]);
    act(() => setOpen(false));

    routes.forEach(([, run]) => {
      at("opener").focus();
      open();
      firstButton().focus();
      run();
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(at("opener"));
    });
    expect(closes).toBe(routes.length);
  });

  it("holds exactly one keydown listener while open and nets to zero over ten cycles", () => {
    expect(keydownListeners).toBe(0);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      open();
    /* #1651 SUPERSEDES the `toBe(1)` that stood here. A migrated surface installs NO `window` keydown
       listener at all -- Escape is the `closedby` attribute the engine enforces -- so the ledger is flat at
       zero across the whole cycle. That is stricter than the swing it replaces: a leak still fails it, and so
       does a second Escape path being reintroduced. */
      expect(keydownListeners).toBe(0);
      escape();
      expect(keydownListeners).toBe(0);
    }
  });

  it("does not focus an opener that has left the document", () => {
    unmount();
    mount(which, { extraOpener: true });
    at("doomed").focus();
    open();
    const attempt = jest.spyOn(at("doomed"), "focus");
    act(() => setDoomed(false));
    at("bystander").focus();
    escape();
    expect(attempt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(at("bystander"));
  });
});

/* ================================================================== */
/*  Buy License: the reported focus loss, route by route                */
/* ================================================================== */

describe("BuyLicenseModal no longer lands focus on the body", () => {
  afterEach(() => unmount());

  it.each([
    ["Escape", () => escape()],
    ["the x", () => click(closeX())],
    ["Not now", () => click(btn("Not now"))],
    ["the backdrop", () => click(backdrop())],
  ])("restores the opener after %s", (_label, run) => {
    mount("license");
    at("opener").focus();
    open();
    firstButton().focus();
    run();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(at("opener"));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("restores the opener from the refused state too, where the secondary button reads Close", () => {
    mount("license", { canBuy: false });
    at("opener").focus();
    open();
    expect(btn("Close")).toBeDefined();
    expect(btn("Buy License for PRR ($120)")).toBeUndefined();
    firstButton().focus();
    click(btn("Close"));
    expect(document.activeElement).toBe(at("opener"));
  });

  it("still buys, still closes after buying, and still shows the two prop-driven states unchanged", () => {
    mount("license");
    at("opener").focus();
    open();
    expect(btn("Buy License for PRR ($120)")).toBeDefined();
    expect(openDialog().textContent).toContain("Treasury $500");
    firstButton().focus();
    click(btn("Buy License for PRR ($120)"));
    expect(buys).toBe(1);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("holds no listener at all while it is mounted but closed", () => {
    /* `App.tsx` keeps this component mounted for the whole session; `open` only decides whether it renders.
       The old effect was gated on `open`; the child that replaced it is simply not mounted. */
    mount("license");
    expect(dialog()).toBeNull();
    expect(keydownListeners).toBe(0);
    escape();
    expect(closes).toBe(0);
    open();
  /* #1651 SUPERSEDES the `toBe(1)` that stood here. A migrated surface installs NO `window` keydown
     listener at all -- Escape is the `closedby` attribute the engine enforces -- so the ledger is flat at
     zero across the whole cycle. That is stricter than the swing it replaces: a leak still fails it, and so
     does a second Escape path being reintroduced. */
    expect(keydownListeners).toBe(0);
  });

  it("reopens in the state its props dictate, because it holds none of its own", () => {
    mount("license");
    open();
    expect(btn("Buy License for PRR ($120)")).toBeDefined();
    escape();
    open();
    expect(btn("Buy License for PRR ($120)")).toBeDefined();
    expect(openDialog().textContent).toContain("Treasury $500");
  });
});

/* ================================================================== */
/*  Market Peek: the one that could have regressed                      */
/* ================================================================== */

describe("MarketPeekModal's restoration is not weaker than the code it replaced", () => {
  afterEach(() => unmount());

  it("captures and restores its normal persistent opener, which survives every close", () => {
    mount("peek");
    at("opener").focus();
    const attempt = jest.spyOn(at("opener"), "focus");
    open();
    firstButton().focus();
    escape();
    expect(at("opener").isConnected).toBe(true);
    expect(attempt).toHaveBeenCalled();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("restores that opener from the x and from the backdrop as well", () => {
    mount("peek");
    ([() => click(closeX()), () => click(backdrop())] as const).forEach((run) => {
      at("opener").focus();
      open();
      firstButton().focus();
      run();
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(at("opener"));
    });
  });

  it("no longer attempts to focus the body, which the old single guard did", () => {
    /* MEASURED BEFORE THE CHANGE: `document.body instanceof HTMLElement` is true, so the old restoration
       called `document.body.focus()` whenever nothing had been focused when the dialog opened. jsdom makes
       that a no-op; a browser resolves it as focus landing on `<body>`, which is the defect. */
    mount("peek");
    const attempt = jest.spyOn(document.body, "focus");
    open();
    at("bystander").focus();
    escape();
    expect(attempt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(at("bystander"));
  });

  it("no longer attempts to focus an opener that has left the document", () => {
    mount("peek", { extraOpener: true });
    at("doomed").focus();
    open();
    const attempt = jest.spyOn(at("doomed"), "focus");
    act(() => setDoomed(false));
    at("bystander").focus();
    escape();
    expect(attempt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(at("bystander"));
  });

  it("still declines an opener that is an Element but not an HTMLElement, as it always did", () => {
    /* The one guard the old code DID have. jsdom 16.7 focuses an `<svg tabindex="0">` and reports it as
       `document.activeElement`, so this is a real focus rather than a stand-in. */
    mount("peek");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("tabindex", "0");
    document.body.appendChild(svg);
    (svg as unknown as HTMLElement).focus();
    const attempt = jest.spyOn(svg as unknown as HTMLElement, "focus");
    open();
    at("bystander").focus();
    escape();
    expect(attempt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(at("bystander"));
    svg.remove();
  });

  it("reopens the same way every time, with one listener and the same single close control", () => {
    mount("peek");
    for (let cycle = 0; cycle < 3; cycle += 1) {
      at("opener").focus();
      open();
      expect(openDialog().querySelectorAll("button")).toHaveLength(1);
      expect(closeX()).not.toBeNull();
    /* #1651 SUPERSEDES the `toBe(1)` that stood here. A migrated surface installs NO `window` keydown
       listener at all -- Escape is the `closedby` attribute the engine enforces -- so the ledger is flat at
       zero across the whole cycle. That is stricter than the swing it replaces: a leak still fails it, and so
       does a second Escape path being reintroduced. */
      expect(keydownListeners).toBe(0);
      escape();
      expect(document.activeElement).toBe(at("opener"));
    }
  });
});

/* ================================================================== */
/*  Structure: no private path survives                                 */
/* ================================================================== */

describe("nothing of the three private implementations is left", () => {
  const FILES = [
    "components/BuyLicenseModal.tsx",
    "components/MarketPeekModal.tsx",
    "components/HeraldHomeFloatModal.tsx",
  ] as const;

  it("carries no hand-written keydown listener and no private opener capture", () => {
    FILES.forEach((path) => {
      const source = readStripped(path);
      expect([path, "keydown listener", source.includes('addEventListener("keydown"')]).toEqual([
        path,
        "keydown listener",
        false,
      ]);
      expect([path, "private capture", source.includes("openerRef")]).toEqual([path, "private capture", false]);
      expect([path, "reads activeElement", source.includes("document.activeElement")]).toEqual([
        path,
        "reads activeElement",
        false,
      ]);
      /* #1651: the hook is gone from every migrated file -- the boundary carries both halves now. */
      expect([path, "no hook", source.includes("useDialogDismissal")]).toEqual([path, "no hook", false]);
      expect([path, "uses the boundary", source.includes("<NativeModal")]).toEqual([path, "uses the boundary", true]);
    });
  });

  it("keeps the two render-switch components' lifecycle below their own render switch", () => {
    /* #1651 SUPERSEDES the shape, not the property. `BuyLicenseModal` and `HeraldHomeFloatModal` are mounted
       by `App.tsx` for the whole session and switched by a prop, so nothing holding a listener or a captured
       opener may sit above that switch. That used to be enforced by keeping `useDialogDismissal` in a small
       child rendered inside the dialog. There is no hook to place now: the lifecycle is `NativeModal`, and
       `NativeModal` is only RENDERED past the switch. `MarketPeekModal` is mounted on open by its parent, so
       its boundary is simply the root of what it returns. */
    ([
      ["components/BuyLicenseModal.tsx", "BuyLicenseModal", "if (!open) return null;"],
      ["components/HeraldHomeFloatModal.tsx", "HeraldHomeFloatModal", "if (!notice) return null;"],
    ] as const).forEach(([path, name, earlyReturn]) => {
      const source = readStripped(path);
      const componentAt = source.indexOf("export function " + name);
      expect([path, componentAt >= 0]).toEqual([path, true]);
      const body = source.slice(componentAt);
      expect([path, body.includes(earlyReturn)]).toEqual([path, true]);
      expect([path, "no DismissalLifecycle", body.includes("DismissalLifecycle")]).toEqual([
        path,
        "no DismissalLifecycle",
        false,
      ]);
      expect([path, "boundary below the switch", body.indexOf("<NativeModal") > body.indexOf(earlyReturn)]).toEqual([
        path,
        "boundary below the switch",
        true,
      ]);
    });
    const peek = readStripped("components/MarketPeekModal.tsx");
    expect(peek.includes("<NativeModal")).toBe(true);
    expect(peek.includes("DismissalLifecycle")).toBe(false);
  });
});
