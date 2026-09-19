/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1646 (harness): BATCH 6A, AND THE FOUR IT COULD NOT TAKE
// ==================================================================
//
// The audit's batch 6 named five components. Measured, only TWO of them carry a hand-written `window` Escape
// listener at all -- three listeners between them -- and only ONE is eligible for a mechanical migration:
//
//   ConnectWalletButton          1 listener   Escape -> `cancel`, the same callback Cancel and the backdrop
//                                             use. MIGRATED.
//   TutorialModal (library)      1 listener   Escape is PAGE NAVIGATION: from a topic it returns to the list
//                                             and does NOT close; from the list it closes. Excluded.
//   TutorialModal (notice)       1 listener   Escape writes the per-topic "seen" flag -- COMPLETION STATE.
//                                             Excluded.
//   EmergencyTrainPurchaseModal  0 listeners  and no `onClose` prop at all: "the modal is unskippable".
//   PrivateTradePanel            0 listeners  and in production it is a PANEL: the bar passes `embedded`
//                                             unconditionally, so `if (embedded) return body` returns before
//                                             the modal branch, which its own note calls vestigial.
//   PrivatePowerFlowModal        0 listeners  Escape does not dismiss it today, so there is nothing to keep.
//
// MEASURED ON `ConnectWalletButton` BEFORE THE CHANGE, behind a real `WalletProvider`:
//
//     Escape             closed it            | focus afterwards: <body>
//     Cancel / backdrop  closed it            | focus afterwards: wherever it happened to be
//     defaultPrevented   IGNORED (closed anyway)
//     focus on open      "Proceed to Connect" (native autoFocus)
//
// So this batch keeps the dismissal exactly, and adds the two things the private listener never had.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/* #1651 (harness): EVERY DIALOG IN THIS FILE IS NOW A NATIVE `<dialog>` IN THE SHARED MODAL LAYER.
   `NativeModal` portals into `[data-modal-layer]` and throws if it is absent, so the harness renders
   `<ModalLayerHost />` beside its opener exactly as `GameRouter` does in the application. The dialog is the
   ELEMENT now, not a nested `role="dialog"` inside it, so every selector below reads
   `dialog[data-native-modal]`. */

import ConnectWalletButton from "./ConnectWalletButton";
import { WalletProvider } from "../context/WalletContext";
import { ModalLayerHost } from "./ModalPortal";
import { readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
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

let setDoomed: (present: boolean) => void = () => {};

function Harness({ extraOpener = false }: { extraOpener?: boolean }) {
  const [doomedPresent, setDoomedState] = useState(extraOpener);
  setDoomed = setDoomedState;
  return (
    <WalletProvider>
      <button type="button" data-testid="bystander">
        Bystander
      </button>
      {doomedPresent && (
        <button type="button" data-testid="doomed">
          Doomed opener
        </button>
      )}
      <ConnectWalletButton />
    </WalletProvider>
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

function mount(extraOpener = false) {
  spyListeners();
  mountLayer();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness extraOpener={extraOpener} />));
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
const opener = () =>
  Array.from(document.querySelectorAll("button")).find((b) => /Connect Keplr/.test(b.textContent || "")) as HTMLButtonElement;
const dialog = () => document.querySelector<HTMLElement>('dialog[data-native-modal]');
const openDialog = () => {
  const node = dialog();
  if (!node) throw new Error("no dialog");
  return node;
};
const btn = (text: string) =>
  Array.from(openDialog().querySelectorAll("button")).find((b) => (b.textContent || "").trim() === text) as
    | HTMLButtonElement
    | undefined;

const click = (node: Element | null | undefined) =>
  act(() => void node?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
const open = () => click(opener());
const clickBackdrop = () => click(openDialog());

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

function press(key: string, opts: { prevented?: boolean } = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  if (opts.prevented) event.preventDefault();
  act(() => void (document.activeElement ?? window).dispatchEvent(event));
  if (key === "Escape") deliverCloseRequest(event);
  return event;
}
const escape = (opts: { prevented?: boolean } = {}) => press("Escape", opts);

/* ================================================================== */
/*  The migrated one                                                   */
/* ================================================================== */

describe("ConnectWalletButton's security recommendation goes through the shared boundary", () => {
  beforeEach(() => mount());
  afterEach(() => unmount());

  it("is still the same modal, named the same way", () => {
    open();
    /* #1652: the element IS the dialog; its role is implicit and must not be re-declared. */
    expect(openDialog().tagName).toBe("DIALOG");
    expect(openDialog().getAttribute("role")).toBeNull();
    /* #1652 SUPERSEDES the `aria-modal="true"` read that stood here. The surface IS a `<dialog>` now: its
       role is implicit, `showModal()` is what makes it modal, and a nested `role="dialog"` inside it was the
       defect the correction removed (measured: two dialog nodes in the accessibility tree). */
    expect(openDialog().tagName).toBe("DIALOG");
    expect(openDialog().getAttribute("aria-modal")).toBeNull();
    expect(openDialog().getAttribute("role")).toBeNull();
    expect(openDialog().querySelectorAll('[role="dialog"], [aria-modal]')).toHaveLength(0);
    expect(openDialog().getAttribute("aria-labelledby")).toBe("wallet-security-title");
    expect(openDialog().textContent).toContain("Security Recommendation");
    expect(Array.from(openDialog().querySelectorAll("button")).map((b) => (b.textContent || "").trim())).toEqual([
      "Cancel",
      "Proceed to Connect",
    ]);
  });

  it("still opens with Proceed focused, by the same native autoFocus", () => {
    /* INITIAL FOCUS IS UNCHANGED -- target and mechanism. The next case is why leaving it alone was safe. */
    opener().focus();
    open();
    expect(document.activeElement).toBe(btn("Proceed to Connect"));
  });

  it("captures the opener rather than its own Proceed button", () => {
    /* The lifecycle child is rendered above the card, so its layout capture completes before `commitMount`
       focuses Proceed. If that order were reversed the restore would aim at a node that leaves with the
       dialog, and focus would fall to `<body>` instead. */
    opener().focus();
    open();
    expect(document.activeElement).toBe(btn("Proceed to Connect"));
    escape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener());
  });

  it("still dismisses on Escape, and still never connects", () => {
    open();
    escape();
    expect(dialog()).toBeNull();
    /* #2's rule: Escape routes to Cancel. Reopening shows the recommendation again rather than a connected
       wallet, which is what proves no connection was attempted. */
    open();
    expect(openDialog().textContent).toContain("Security Recommendation");
  });

  it("does NOT dismiss on an Escape a nested surface has already consumed", () => {
    /* THE CORRECTION. The private listener closed regardless -- measured `IGNORED (closed anyway)`. */
    open();
    escape({ prevented: true });
    expect(dialog()).not.toBeNull();
  });

  it("does nothing on keys that are not Escape", () => {
    open();
    ["Enter", " ", "Tab", "ArrowDown", "Esc", "escape"].forEach((key) => press(key));
    expect(dialog()).not.toBeNull();
  });

  it("restores the opener from Escape, from Cancel and from the backdrop alike", () => {
    ([() => escape(), () => click(btn("Cancel")), () => clickBackdrop()] as const).forEach((run) => {
      opener().focus();
      open();
      btn("Cancel")!.focus();
      run();
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(opener());
    });
  });

  it("holds no listener while the dialog is closed, and nets to zero over ten cycles", () => {
    /* The component itself is always mounted -- it is the button -- so this is the property the lifecycle
       child exists for. */
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

  it("reopens at the same state every time, because closing unmounts the dialog", () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      opener().focus();
      open();
      expect(openDialog().textContent).toContain("dedicated burner wallet");
      expect(document.activeElement).toBe(btn("Proceed to Connect"));
      escape();
      expect(document.activeElement).toBe(opener());
    }
  });

  it("does not focus an opener that has left the document", () => {
    unmount();
    mount(true);
    at("doomed").focus();
    open();
    const attempt = jest.spyOn(at("doomed"), "focus");
    act(() => setDoomed(false));
    at("bystander").focus();
    escape();
    expect(attempt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(at("bystander"));
  });

  it("makes no focus attempt on the body when nothing opened it", () => {
    unmount();
    mount();
    expect(document.activeElement).toBe(document.body);
    const attempt = jest.spyOn(document.body, "focus");
    open();
    escape();
    expect(dialog()).toBeNull();
    expect(attempt).not.toHaveBeenCalled();
  });

  it("dismisses unconditionally from every route, which is why no dismissible gate was wired", () => {
    /* The only wallet-dependent control in the file is the OPENER (`disabled={connecting}`), and it is not a
       close route. Neither Cancel nor the backdrop carries a condition. */
    open();
    expect(btn("Cancel")!.disabled).toBe(false);
    click(btn("Cancel"));
    expect(dialog()).toBeNull();
    open();
    clickBackdrop();
    expect(dialog()).toBeNull();
  });
});

/* ================================================================== */
/*  Boundaries: what batch 6A did not touch, and why                   */
/* ================================================================== */

describe("the four excluded candidates are untouched", () => {
  /* NO PRODUCTION CODE WAS ADDED TO PROVE THIS. These are source assertions over the components as they
     stand, each pinning the reason the candidate was excluded rather than merely its inaction. */

  /* SUPERSEDED IN PART BY #1647 (batch 6B-i), AND REWRITTEN RATHER THAN LOOSENED. This case used to assert
     that `TutorialModal.tsx` contained no `useDialogDismissal` at all, which was 6A's boundary: that batch
     deliberately did not reach the file. 6B-i then migrated ONE of its two Escapes -- the first-time notice,
     whose Escape, backdrop and Done all share `dismiss` -- and left the other alone. What is still this
     file's business is the half 6A excluded and 6B-i also declined: the LIBRARY's listener, whose Escape is
     navigation rather than dismissal. The notice's own contract is asserted in depth in
     `components/tutorialDismissal.test.tsx`. */
  it("leaves the tutorial LIBRARY's Escape hand-rolled, because it navigates rather than dismisses", () => {
    const source = readStripped("components/TutorialModal.tsx");
    /* Exactly one hand-written listener survives in the file, and it is the library's: it reads the current
       topic to decide between going back to the list and closing. */
    expect((source.match(/addEventListener\("keydown"/g) || []).length).toBe(1);
    expect(source.includes("setTopicKey((current) => {")).toBe(true);
    /* And the notice still records completion on whichever route dismisses it -- unchanged by 6B-i, which
       reused `dismiss` rather than adding a flag-free exit. */
    expect(source.includes("writeFlag(seenKey, true)")).toBe(true);
  });

  it("leaves EmergencyTrainPurchaseModal alone, which has no dismissal route to keep", () => {
    const source = readStripped("components/EmergencyTrainPurchaseModal.tsx");
    expect(source.includes("useDialogDismissal")).toBe(false);
    expect(source.includes('addEventListener("keydown"')).toBe(false);
    expect(source.includes("onClose")).toBe(false);
  });

  it("leaves PrivateTradePanel alone, which is a panel in production and not a modal", () => {
    const source = readStripped("components/PrivateTradePanel.tsx");
    expect(source.includes("useDialogDismissal")).toBe(false);
    expect(source.includes('addEventListener("keydown"')).toBe(false);
    /* `embedded` returns the body before the modal branch is reached, and the bar passes it unconditionally. */
    expect(source.includes("if (embedded) return body;")).toBe(true);
  });

  it("leaves PrivatePowerFlowModal alone, which has no Escape today", () => {
    const source = readStripped("components/PrivatePowerFlowModal.tsx");
    expect(source.includes("useDialogDismissal")).toBe(false);
    expect(source.includes('addEventListener("keydown"')).toBe(false);
  });
});

/* ================================================================== */
/*  Structure                                                          */
/* ================================================================== */

describe("no private dismissal code survives in the migrated file", () => {
  const PATH = "components/ConnectWalletButton.tsx";

  it("has no hand-written keydown listener, no capture of its own, and no hook either", () => {
    /* #1651 SUPERSEDES the third assertion here, which required `useDialogDismissal` to be present. The hook
       is gone from this file: the boundary carries the Escape policy (as `closedby`) and the guarded opener
       restore together, because `showModal()` moves focus and the capture has to precede it. The first two
       assertions are unchanged and still say what they always said. */
    const source = readStripped(PATH);
    expect(source.includes('addEventListener("keydown"')).toBe(false);
    expect(source.includes("document.activeElement")).toBe(false);
    expect(source.includes("useDialogDismissal")).toBe(false);
    expect(source.includes("<NativeModal")).toBe(true);
  });

  it("keeps the lifecycle out of the component body, since the button is always mounted", () => {
    /* #1651 SUPERSEDES "keeps the hook out of the body" and the `DismissalLifecycle` child it checked for.
       The property is the same: this button is mounted for the whole session, so nothing that holds a
       listener or a captured opener may sit above the `{confirmOpen && ...}` switch. `NativeModal` is only
       RENDERED past that switch, which is the same guarantee with one fewer moving part. */
    const source = readStripped(PATH);
    const componentAt = source.indexOf("export function ConnectWalletButton");
    expect(componentAt).toBeGreaterThanOrEqual(0);
    const body = source.slice(componentAt);
    expect(body.includes("DismissalLifecycle")).toBe(false);
    const switchAt = body.indexOf("{confirmOpen && (");
    const boundaryAt = body.indexOf("<NativeModal");
    expect(switchAt).toBeGreaterThanOrEqual(0);
    expect(boundaryAt).toBeGreaterThan(switchAt);
  });

  it("gives the boundary the dismissal, never the action, and keeps its own initial focus", () => {
    /* Design note #2 stands and is the reason this case exists: Escape CANCELS, it never connects. */
    const source = readStripped(PATH);
    expect(source.includes("onDismiss={cancel}")).toBe(true);
    expect(source.includes("onDismiss={proceed}")).toBe(false);
    expect(source.includes('labelledBy="wallet-security-title"')).toBe(true);
    expect(source.includes("autoFocus")).toBe(true);
  });
});
