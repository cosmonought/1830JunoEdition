/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1651 (harness): THE SHARED NATIVE BOUNDARY
// ==================================================================
//
// WHAT THIS FILE IS FOR. `NativeModal` is the one piece every migrated surface now shares: the portal into the
// modal layer, the connected `showModal()` lifecycle, the UA style reset, the transparent `::backdrop`, the
// `closedby` policy, the cancel/close coordination, the reference-counted scroll lock and the accessible name.
// Each surface's own contract -- its card, its focus target, its backdrop policy, what its Escape MEANS -- is
// asserted at that surface's own suite. This one asserts the boundary, and then checks three representative
// members really sit on it.
//
// WHAT IT CANNOT SEE, AND DOES NOT PRETEND TO. jsdom 16.7 ships `HTMLDialogElement` with no `show`,
// `showModal` or `close`, no top layer, no close requests and no `closedby`. So the top layer, native
// inertness and the engine's Escape handling are measured in Chromium and recorded in
// `claude/modal-native-dialog-step3-2026-09-18.md`; what is asserted here is the LIFECYCLE the component
// owns. The stub below sets and clears the `open` attribute (which jsdom reflects into `.open`) and throws
// `InvalidStateError` on an already-open dialog exactly as the platform does, because a stub that quietly
// re-opened would let a missing guard pass every case in this file.
//
// THE `closedby` BRANCH IS EXERCISED BOTH WAYS. `closedByIsSupported()` reads the prototype at call time
// precisely so this file can install the property, run the supported branch, remove it and run the fallback.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { NativeModal, NATIVE_MODAL_ATTRIBUTE, closedByIsSupported, tabbableWithin } from "./NativeModal";
import { ModalLayerHost, MODAL_LAYER_ATTRIBUTE } from "./ModalPortal";
import BuyLicenseModal from "./BuyLicenseModal";
import PrivateRevenueModal from "./PrivateRevenueModal";
import PhaseThreeNoticeModal from "./PhaseThreeNoticeModal";
import MarketPeekModal from "./MarketPeekModal";
import { resetScrollLockForTests, scrollLockHolders } from "../utils/useScrollLock";
import { readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

type DialogStubProto = { showModal?: () => void; close?: () => void };

let layerHost: HTMLDivElement | null = null;
let layerRoot: Root | null = null;
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let showModalCalls: Array<{ connected: boolean; openBefore: boolean }> = [];
let closeCalls = 0;
let dismissals = 0;
let scrimClicks = 0;

function installDialogStub() {
  const proto = window.HTMLDialogElement.prototype as unknown as DialogStubProto;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    showModalCalls.push({ connected: this.isConnected, openBefore: this.hasAttribute("open") });
    if (this.hasAttribute("open")) throw new DOMException("dialog already open", "InvalidStateError");
    this.setAttribute("open", "");
  };
  proto.close = function close(this: HTMLDialogElement) {
    closeCalls += 1;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

function removeDialogStub() {
  const proto = window.HTMLDialogElement.prototype as unknown as DialogStubProto;
  delete proto.showModal;
  delete proto.close;
}

/** Install or remove the platform feature, so both branches of the policy can be run in one file. */
function withClosedBySupport(supported: boolean) {
  const proto = window.HTMLDialogElement.prototype as unknown as { closedBy?: string };
  if (supported) proto.closedBy = "closerequest";
  else delete proto.closedBy;
}

let setOpen: (open: boolean) => void = () => {};
let setBusy: (busy: boolean) => void = () => {};

type Options = {
  alert?: boolean;
  labelledBy?: string;
  describedBy?: string;
  restoreOpener?: boolean;
  withScrim?: boolean;
  second?: boolean;
};

function Harness({ alert, labelledBy, describedBy, restoreOpener = true, withScrim = true, second = false }: Options) {
  const [open, setOpenState] = useState(false);
  const [busy, setBusyState] = useState(false);
  setOpen = setOpenState;
  setBusy = setBusyState;
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpenState(true)}>
        Open
      </button>
      <button type="button" data-testid="bystander">
        Bystander
      </button>
      {open && (
        <NativeModal
          name={labelledBy ? undefined : "A named surface"}
          labelledBy={labelledBy}
          describedBy={describedBy}
          alert={alert}
          dismissible={!busy}
          onDismiss={() => {
            dismissals += 1;
            setOpenState(false);
          }}
          onScrimClick={withScrim ? () => (scrimClicks += 1) : undefined}
          restoreOpener={restoreOpener}
          scrimStyle={{ display: "flex", padding: "24px", backgroundColor: "rgba(6, 9, 15, 0.72)" }}
          testId="surface"
        >
          <div className="surface-card" data-testid="surface-card">
            {/* Four stops, because the cases below need a first, a last and a middle. */}
            <button type="button" data-testid="inside">
              Inside
            </button>
            <button type="button" data-testid="second-stop">
              Second
            </button>
            <button type="button" data-testid="third-stop">
              Third
            </button>
            <button type="button" data-testid="last-stop">
              Last
            </button>
            <span id="surface-title">A named surface</span>
            <span id="surface-desc">what it is for</span>
          </div>
        </NativeModal>
      )}
      {open && second && (
        <NativeModal
          name="A second surface"
          dismissible
          onDismiss={() => {}}
          restoreOpener={false}
          scrimStyle={{ display: "flex" }}
          testId="second"
        >
          <div data-testid="second-card">second</div>
        </NativeModal>
      )}
    </>
  );
}

function mount(options: Options = {}, { withLayer = true, withNative = true, closedBy = false } = {}) {
  showModalCalls = [];
  closeCalls = 0;
  dismissals = 0;
  scrimClicks = 0;
  resetScrollLockForTests();
  withClosedBySupport(closedBy);
  if (withNative) installDialogStub();
  if (withLayer) {
    layerHost = document.createElement("div");
    document.body.appendChild(layerHost);
    layerRoot = createRoot(layerHost);
    act(() => {
      layerRoot!.render(<ModalLayerHost />);
    });
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<Harness {...options} />);
  });
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => layerRoot?.unmount());
  layerHost?.remove();
  layerRoot = null;
  layerHost = null;
  removeDialogStub();
  withClosedBySupport(false);
  resetScrollLockForTests();
  document.documentElement.style.removeProperty("overflow");
  document.body.style.removeProperty("padding-right");
}

afterEach(() => {
  if (root || layerRoot) unmount();
});

const dialogEl = () => document.querySelector<HTMLDialogElement>(`dialog[${NATIVE_MODAL_ATTRIBUTE}]`);
const layer = () => document.querySelector<HTMLElement>(`[${MODAL_LAYER_ATTRIBUTE}]`);
const at = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const open = () => act(() => setOpen(true));
const busy = (on: boolean) => act(() => setBusy(on));

/** The platform's close request, as measured in Chromium: `cancel`, then `close` if nothing refused it, and
 *  neither at all when the declared policy is `none`. */
function requestClose(node: HTMLDialogElement | null = dialogEl()) {
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

/* ------------------------------------------------------------------ */
/* Placement                                                           */
/* ------------------------------------------------------------------ */
describe("#1651 the boundary renders one native dialog, in the shared layer", () => {
  it("renders a real <dialog> carrying the boundary's attribute", () => {
    mount();
    open();
    expect(dialogEl()).not.toBeNull();
    expect(dialogEl()!.tagName).toBe("DIALOG");
  });

  it("puts it inside the modal layer and outside the screen root", () => {
    mount();
    open();
    expect(layer()!.contains(dialogEl()!)).toBe(true);
    expect(host!.contains(dialogEl()!)).toBe(false);
  });

  it("keeps the children inside the dialog, where a top-layer element needs them", () => {
    mount();
    open();
    expect(dialogEl()!.contains(at("surface-card")!)).toBe(true);
  });

  it("refuses to render without a layer, loudly", () => {
    const errors: string[] = [];
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => {
      try {
        mount({}, { withLayer: false });
        open();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        throw error;
      }
    }).toThrow(/no modal layer found/);
    spy.mockRestore();
    expect(errors[0]).toMatch(/Render <ModalLayerHost \/> beside the screen root/);
  });
});

/* ------------------------------------------------------------------ */
/* Semantics                                                           */
/* ------------------------------------------------------------------ */
describe("#1652 exactly one dialog, and the element is it", () => {
  it("names the element and gives it no role, because its implicit role is dialog", () => {
    mount();
    open();
    expect(dialogEl()!.getAttribute("aria-label")).toBe("A named surface");
    expect(dialogEl()!.getAttribute("role")).toBeNull();
  });

  it("uses alertdialog when, and only when, the surface asks for it", () => {
    mount({ alert: true });
    open();
    expect(dialogEl()!.getAttribute("role")).toBe("alertdialog");
  });

  it("names by reference when the surface has a heading on screen", () => {
    mount({ labelledBy: "surface-title", describedBy: "surface-desc" });
    open();
    expect(dialogEl()!.getAttribute("aria-labelledby")).toBe("surface-title");
    expect(dialogEl()!.getAttribute("aria-describedby")).toBe("surface-desc");
    expect(dialogEl()!.getAttribute("aria-label")).toBeNull();
  });

  it("puts no second dialog and no aria-modal anywhere inside", () => {
    mount();
    open();
    expect(document.querySelectorAll(`dialog[${NATIVE_MODAL_ATTRIBUTE}]`)).toHaveLength(1);
    expect(dialogEl()!.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal]')).toHaveLength(0);
  });

  it("imposes no z-index: the top layer decides, not a number", () => {
    mount();
    open();
    expect(dialogEl()!.style.zIndex).toBe("");
    const source = readStripped("components/NativeModal.tsx");
    expect(source).not.toContain("zIndex");
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */
describe("#1651 the connected showModal lifecycle", () => {
  it("opens exactly once, on a connected node that is not already open", () => {
    mount();
    open();
    expect(showModalCalls).toEqual([{ connected: true, openBefore: false }]);
    expect(dialogEl()!.open).toBe(true);
  });

  it("closes exactly once when the surface goes", () => {
    mount();
    open();
    expect(closeCalls).toBe(0);
    act(() => setOpen(false));
    expect(closeCalls).toBe(1);
    expect(dialogEl()).toBeNull();
  });

  it("does not throw where the platform has no showModal at all", () => {
    mount({}, { withNative: false });
    expect(() => open()).not.toThrow();
    expect(dialogEl()).not.toBeNull();
    expect(showModalCalls).toHaveLength(0);
  });

  it("does not throw when the whole tree is unmounted with the dialog open", () => {
    mount();
    open();
    expect(() => unmount()).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* The policy                                                          */
/* ------------------------------------------------------------------ */
describe("#1651 closedby is the Escape policy, and it is written down", () => {
  it("declares closerequest for a dismissible surface", () => {
    mount();
    open();
    expect(dialogEl()!.getAttribute("closedby")).toBe("closerequest");
  });

  it("declares none for one that must refuse", () => {
    mount();
    open();
    busy(true);
    expect(dialogEl()!.getAttribute("closedby")).toBe("none");
  });

  it("switches live, so a surface that becomes busy stops answering at that moment", () => {
    mount();
    open();
    busy(true);
    expect(dialogEl()!.getAttribute("closedby")).toBe("none");
    busy(false);
    expect(dialogEl()!.getAttribute("closedby")).toBe("closerequest");
  });

  it("writes the attribute even where the engine does not understand it", () => {
    /* A policy that is invisible in the DOM is a policy nobody can check -- including the fallback below. */
    mount({}, { closedBy: false });
    open();
    expect(closedByIsSupported()).toBe(false);
    expect(dialogEl()!.getAttribute("closedby")).toBe("closerequest");
  });

  it("calls the surface's own dismissal when the platform closes it", () => {
    mount();
    open();
    requestClose();
    expect(dismissals).toBe(1);
    expect(dialogEl()).toBeNull();
  });

  it("never sees a close request at all while the policy is none", () => {
    mount();
    open();
    busy(true);
    requestClose();
    expect(dismissals).toBe(0);
    expect(dialogEl()).not.toBeNull();
  });

  it("adds no window keydown listener: there is one Escape path and it is the engine's", () => {
    const added: string[] = [];
    const spy = jest.spyOn(window, "addEventListener").mockImplementation(function (this: Window, ...args: never[]) {
      added.push(args[0] as unknown as string);
      return (Window.prototype.addEventListener as never as (...a: never[]) => void).apply(this, args);
    } as never);
    mount();
    open();
    spy.mockRestore();
    expect(added.filter((type) => type === "keydown")).toHaveLength(0);
  });
});

describe("#1651 the fallback, for an engine without closedby", () => {
  it("refuses the cancel itself when the surface is not dismissible", () => {
    mount({}, { closedBy: false });
    open();
    busy(true);
    const cancelEvent = new Event("cancel", { bubbles: false, cancelable: true });
    act(() => void dialogEl()!.dispatchEvent(cancelEvent));
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(dismissals).toBe(0);
  });

  it("leaves the cancel alone when it is dismissible, so one Escape closes once", () => {
    mount({}, { closedBy: false });
    open();
    const cancelEvent = new Event("cancel", { bubbles: false, cancelable: true });
    act(() => void dialogEl()!.dispatchEvent(cancelEvent));
    expect(cancelEvent.defaultPrevented).toBe(false);
  });

  it("does not touch the cancel at all where the engine has already refused", () => {
    mount({}, { closedBy: true });
    open();
    busy(true);
    const cancelEvent = new Event("cancel", { bubbles: false, cancelable: true });
    act(() => void dialogEl()!.dispatchEvent(cancelEvent));
    expect(cancelEvent.defaultPrevented).toBe(false);
  });

  it("puts the dialog back if an engine overrules a refusal", () => {
    /* Measured under #1650: an insistent Escape produces a `cancel` with `cancelable: false` and the dialog
       closes anyway. `closedby` removes that case entirely; this is what happens where `closedby` is absent. */
    mount({}, { closedBy: false });
    open();
    busy(true);
    expect(showModalCalls).toHaveLength(1);
    act(() => {
      dialogEl()!.removeAttribute("open");
      dialogEl()!.dispatchEvent(new Event("close"));
    });
    expect(showModalCalls).toHaveLength(2);
    expect(dialogEl()!.open).toBe(true);
    expect(dismissals).toBe(0);
  });

  it("does not put it back when the surface is dismissible -- that close is the dismissal", () => {
    mount({}, { closedBy: false });
    open();
    requestClose();
    expect(dismissals).toBe(1);
    expect(showModalCalls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* The scrim                                                           */
/* ------------------------------------------------------------------ */
describe("#1651 the scrim is the surface's, laid over the UA reset", () => {
  it("cancels every UA declaration that would change the box", () => {
    mount();
    open();
    const style = dialogEl()!.style;
    expect(style.position).toBe("fixed");
    expect(style.inset).toBe("0");
    expect(style.margin).toBe("0px");
    /* `border: none` is DROPPED by jsdom's CSS parser -- it is neither serialised back through `style.border`
       nor expanded into longhands nor kept in the declaration text, so there is nothing to read here. It is
       asserted at the source instead, and its effect was measured in Chromium: the rendered page is
       byte-identical to the `<div>` scrim's, which a UA border would not have been. */
    expect(readStripped("components/NativeModal.tsx")).toContain('border: "none"');
    expect(style.maxWidth).toBe("none");
    expect(style.maxHeight).toBe("none");
  });

  it("lets the surface's own object win over it", () => {
    mount();
    open();
    expect(dialogEl()!.style.display).toBe("flex");
    expect(dialogEl()!.style.padding).toBe("24px");
    expect(dialogEl()!.style.backgroundColor).toBe("rgba(6, 9, 15, 0.72)");
  });

  it("leaves the real ::backdrop transparent, so nothing is darkened twice", () => {
    mount();
    open();
    const sheet = dialogEl()!.querySelector("style");
    expect(sheet?.textContent).toContain(`dialog[${NATIVE_MODAL_ATTRIBUTE}]::backdrop`);
    expect(sheet?.textContent).toContain("background: transparent");
  });

  it("hands a scrim click to the surface, and only when the surface asked for one", () => {
    mount();
    open();
    act(() => void dialogEl()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(scrimClicks).toBe(1);
  });

  it("has no click policy of its own where the surface gave none", () => {
    mount({ withScrim: false });
    open();
    act(() => void dialogEl()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(scrimClicks).toBe(0);
    expect(dismissals).toBe(0);
    expect(dialogEl()).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Focus and the scroll lock                                           */
/* ------------------------------------------------------------------ */
describe("#1651 the opener capture, and the restore the surface asked for", () => {
  it("returns focus to the opener when the surface wants it", () => {
    mount();
    at("opener")!.focus();
    open();
    act(() => setOpen(false));
    expect(document.activeElement).toBe(at("opener"));
  });

  it("leaves focus where the engine put it when the surface does not", () => {
    mount({ restoreOpener: false });
    at("opener")!.focus();
    open();
    at("bystander")!.focus();
    act(() => setOpen(false));
    expect(document.activeElement).toBe(at("bystander"));
  });
});

describe("#1649/#1651 the scroll lock is held by the boundary and reference counted", () => {
  it("holds it while a surface is up and gives it back", () => {
    mount();
    expect(scrollLockHolders()).toBe(0);
    open();
    expect(scrollLockHolders()).toBe(1);
    expect(document.documentElement.style.overflow).toBe("hidden");
    act(() => setOpen(false));
    expect(scrollLockHolders()).toBe(0);
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("counts two surfaces, so the first to close does not unlock under the second", () => {
    mount({ second: true });
    open();
    expect(document.querySelectorAll(`dialog[${NATIVE_MODAL_ATTRIBUTE}]`)).toHaveLength(2);
    expect(scrollLockHolders()).toBe(2);
    act(() => setOpen(false));
    expect(scrollLockHolders()).toBe(0);
    expect(document.documentElement.style.overflow).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* Representative members                                              */
/* ------------------------------------------------------------------ */
describe("#1651 three families, on the same boundary", () => {
  function mountOne(node: React.ReactNode) {
    resetScrollLockForTests();
    installDialogStub();
    layerHost = document.createElement("div");
    document.body.appendChild(layerHost);
    layerRoot = createRoot(layerHost);
    act(() => {
      layerRoot!.render(<ModalLayerHost />);
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(node);
    });
  }

  it("a dismissible game modal declares closerequest and names the element", () => {
    mountOne(
      <BuyLicenseModal open onClose={() => {}} actingTicker="B&O" remaining={3} alreadyHeld={false} refusal={null} onBuy={() => {}} />,
    );
    expect(dialogEl()!.getAttribute("closedby")).toBe("closerequest");
    expect(dialogEl()!.getAttribute("aria-label")).toBe("The Coalfields and the Kanawha Licence");
    expect(dialogEl()!.querySelectorAll('[role="dialog"], [aria-modal]')).toHaveLength(0);
  });

  it("a forced notice declares none, and is still exactly one dialog", () => {
    mountOne(
      <PrivateRevenueModal
        round={{
          viewerName: "You",
          viewerSeatColor: "#888",
          lines: [{ privateId: 1, label: "Schuylkill Valley", value: "$5" }],
          total: 5,
          cashBefore: 100,
          cashAfter: 105,
          others: [],
        }}
        roundLabel="OR 1"
        onAcknowledge={() => {}}
      />,
    );
    expect(dialogEl()!.getAttribute("closedby")).toBe("none");
    expect(dialogEl()!.getAttribute("aria-label")).toBe("Private company payouts");
    expect(document.querySelectorAll(`dialog[${NATIVE_MODAL_ATTRIBUTE}]`)).toHaveLength(1);
  });

  it("every migrated surface renders through the boundary rather than its own scrim", () => {
    const migrated = [
      "HostSetupCard",
      "JoinGameCard",
      "RejoinByPinCard",
      "MarketPeekModal",
      "BuyLicenseModal",
      "HeraldHomeFloatModal",
      "AutoBuyModal",
      "AutoPassModal",
      "PhaseThreeNoticeModal",
      "GameOverModal",
      "ConnectWalletButton",
      "PrivateRevenueModal",
      "FleetLossModal",
      "PrivatePowerFlowModal",
      "EmergencyTrainPurchaseModal",
    ];
    for (const name of migrated) {
      const source = readStripped(`components/${name}.tsx`);
      expect([name, "uses NativeModal", source.includes("<NativeModal")]).toEqual([name, "uses NativeModal", true]);
      expect([name, 'role="dialog"', source.includes('role="dialog"')]).toEqual([name, 'role="dialog"', false]);
      expect([name, "aria-modal", source.includes("aria-modal")]).toEqual([name, "aria-modal", false]);
      expect([name, "zIndex", source.includes("zIndex:")]).toEqual([name, "zIndex", false]);
      expect([name, "useDialogDismissal", source.includes("useDialogDismissal")]).toEqual([
        name,
        "useDialogDismissal",
        false,
      ]);
    }
  });

  it("leaves the excluded surfaces exactly as they were", () => {
    /* PIN and Tutorial are named exclusions; `PrivateTradePanel` is an embedded panel, not a modal; the two
       forced prompts and the intro overlay are excluded for reasons recorded in the note. None of them may
       have acquired the boundary by accident. */
    for (const name of ["SeatPinModal", "TutorialModal", "PrivateTradePanel", "HomeStationPrompt", "AuctionPromptModal", "GameIntroOverlay"]) {
      const source = readStripped(`components/${name}.tsx`);
      expect([name, "untouched by the boundary", source.includes("NativeModal")]).toEqual([
        name,
        "untouched by the boundary",
        false,
      ]);
    }
    for (const name of ["SeatPinModal", "TutorialModal"]) {
      const source = readStripped(`components/${name}.tsx`);
      expect([name, "still on useDialogDismissal", source.includes("useDialogDismissal(")]).toEqual([
        name,
        "still on useDialogDismissal",
        true,
      ]);
    }
  });
});


/* ------------------------------------------------------------------ */
/* #1653 -- the two ends, so the cycle has no invisible stop            */
/* ------------------------------------------------------------------ */
describe("#1653 end containment: the cycle is continuous and visible", () => {
  /* MEASURED, and the reason this exists. `showModal()` DOES contain focus -- a background control cannot be
     Tabbed to from any of the fifteen surfaces. But Chromium's own dialog cycle passes through the browser's
     UI, and from the page that is one press on which `document.activeElement` is `<body>` and no focus ring is
     anywhere. Host Game never showed it, because it had a manual trap; the other fourteen showed it in both
     directions and in the dynamically-disabled state as well. The trap is the boundary's now. */
  const stops = () => tabbableWithin(dialogEl()!);
  const tab = (from: Element, shiftKey = false) => {
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
    act(() => void from.dispatchEvent(event));
    return event;
  };

  it("wraps forward from the last enabled control to the first", () => {
    mount();
    open();
    const all = stops();
    const last = all[all.length - 1];
    last.focus();
    expect(tab(last).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(all[0]);
  });

  it("wraps backward from the first to the last", () => {
    mount();
    open();
    const all = stops();
    all[0].focus();
    expect(tab(all[0], true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(all[all.length - 1]);
  });

  it("leaves a Tab in the middle of the order to the browser", () => {
    mount();
    open();
    const all = stops();
    expect(all.length).toBeGreaterThan(2);
    all[0].focus();
    expect(tab(all[0]).defaultPrevented).toBe(false);
  });

  it("pulls focus in from anything inside that is not a stop", () => {
    mount();
    open();
    at("surface-card")!.setAttribute("tabindex", "-1");
    at("surface-card")!.focus();
    const all = stops();
    expect(tab(at("surface-card")!).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(all[0]);
  });

  it("yields no <body> stop anywhere in the cycle, in either direction", () => {
    /* THE POINT OF THE WHOLE CHANGE, said as a walk rather than as one press. Measured in Chromium before it:
       from the last control, Tab put `document.activeElement` on `<body>` -- the browser's own UI stop -- and
       the focus ring vanished for one press. The interception at the two ends removes it, so every stop in a
       full loop is a real control inside the dialog.

       THE STRANDED CASE IS THE BROWSER'S, and was measured separately: with focus already on `<body>` (a
       dead-space click does this), Chromium's next Tab moves INTO the dialog on its own -- `BODY -> b -> BODY
       -> a` over three presses, never out to the page. A keydown on `<body>` is not on this element's
       propagation path, so the boundary neither sees it nor needs to. */
    mount();
    open();
    const all = stops();
    const seen: Array<Element | null> = [];
    all[0].focus();
    for (let i = 0; i < all.length + 2; i += 1) {
      tab(document.activeElement ?? document.body);
      seen.push(document.activeElement);
    }
    all[0].focus();
    for (let i = 0; i < all.length + 2; i += 1) {
      tab(document.activeElement ?? document.body, true);
      seen.push(document.activeElement);
    }
    expect(seen).not.toContain(document.body);
    expect(seen.every((node) => node instanceof HTMLElement && dialogEl()!.contains(node))).toBe(true);
    expect(seen.every((node) => all.indexOf(node as HTMLElement) >= 0)).toBe(true);
  });

  it("recomputes the set at every press, so a control disabled since the last one is skipped", () => {
    mount();
    open();
    const before = stops();
    expect(before.length).toBeGreaterThan(1);
    const lastBefore = before[before.length - 1];
    act(() => lastBefore.setAttribute("disabled", ""));
    const after = stops();
    expect(after).not.toContain(lastBefore);
    const newLast = after[after.length - 1];
    newLast.focus();
    expect(tab(newLast).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(after[0]);
  });

  it("recomputes it for a control that was removed outright", () => {
    mount();
    open();
    const before = stops();
    const first = before[0];
    act(() => first.remove());
    const after = stops();
    expect(after).not.toContain(first);
    expect(after.length).toBeGreaterThan(0);
    const last = after[after.length - 1];
    last.focus();
    tab(last);
    expect(document.activeElement).toBe(after[0]);
  });

  it("stands down when something else has already handled the key", () => {
    mount();
    open();
    const all = stops();
    const last = all[all.length - 1];
    last.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => {
      event.preventDefault();
      last.dispatchEvent(event);
    });
    expect(document.activeElement).toBe(last);
  });

  it("puts no tabIndex on the <dialog>, which the HTML Standard forbids", () => {
    mount();
    open();
    expect(dialogEl()!.hasAttribute("tabindex")).toBe(false);
    /* The boundary READS `tabIndex` when it computes the stop set, which is fine; what it must never do is
       SET one on the element. */
    expect(readStripped("components/NativeModal.tsx")).not.toContain("tabIndex={");
    expect(readStripped("components/NativeModal.tsx")).not.toContain('tabindex"');
  });

  it("leaves keys that are not Tab alone", () => {
    mount();
    open();
    const all = stops();
    all[0].focus();
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    act(() => void all[0].dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(all[0]);
  });
});

/* ------------------------------------------------------------------ */
/* #1653 -- every control-layout family, forward and reverse           */
/* ------------------------------------------------------------------ */
describe("#1653 the wrap holds for every control layout, not just one", () => {
  function mountOne(node: React.ReactNode) {
    resetScrollLockForTests();
    installDialogStub();
    layerHost = document.createElement("div");
    document.body.appendChild(layerHost);
    layerRoot = createRoot(layerHost);
    act(() => {
      layerRoot!.render(<ModalLayerHost />);
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(node);
    });
  }
  const tab = (from: Element, shiftKey = false) => {
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
    act(() => void from.dispatchEvent(event));
    return event;
  };

  const FAMILIES: Array<[string, () => React.ReactNode]> = [
    [
      "header x + two footer actions",
      () => (
        <BuyLicenseModal
          open
          onClose={() => {}}
          actingTicker="B&O"
          remaining={3}
          alreadyHeld={false}
          refusal={null}
          onBuy={() => {}}
        />
      ),
    ],
    ["one acknowledgment, no x", () => <PhaseThreeNoticeModal open onAcknowledge={() => {}} />],
    [
      "one forced acknowledgment",
      () => (
        <PrivateRevenueModal
          round={{
            viewerName: "You",
            viewerSeatColor: "#888",
            lines: [{ privateId: 1, label: "Schuylkill Valley", value: "$5" }],
            total: 5,
            cashBefore: 100,
            cashAfter: 105,
            others: [],
          }}
          roundLabel="OR 1"
          onAcknowledge={() => {}}
        />
      ),
    ],
    [
      "a panel whose only control is the x",
      () => (
        <MarketPeekModal
          peek={{
            action: "pay",
            company: { company_id: 1, ticker: "B&O" },
            startNode: { x: 3, y: 4 },
            projectedNode: { x: 4, y: 4 },
          }}
          positions={[]}
          onClose={() => {}}
        />
      ),
    ],
  ];

  for (const [label, render] of FAMILIES) {
    it(`${label}: has at least one stop, and wraps both ways`, () => {
      mountOne(render());
      const all = tabbableWithin(dialogEl()!);
      /* AN ELIGIBILITY CHECK, NOT A CONTAINMENT ONE. A native modal with nothing to focus would hold a player
         in a dialog they cannot act in; none of the fifteen is that, and this is what says so per family. */
      expect([label, "has a focus target", all.length > 0]).toEqual([label, "has a focus target", true]);
      const last = all[all.length - 1];
      last.focus();
      expect([label, "forward wraps", tab(last).defaultPrevented]).toEqual([label, "forward wraps", true]);
      expect(document.activeElement).toBe(all[0]);
      all[0].focus();
      expect([label, "reverse wraps", tab(all[0], true).defaultPrevented]).toEqual([label, "reverse wraps", true]);
      expect(document.activeElement).toBe(all[all.length - 1]);
      expect(document.activeElement).not.toBe(document.body);
    });
  }
});

/* ------------------------------------------------------------------ */
/* #1653 -- the fallback refuses the key, not the consequence          */
/* ------------------------------------------------------------------ */
describe("#1653 without closedby, Escape is refused before the engine acts on it", () => {
  /* #1651's fallback refused `cancel` and put the dialog back when the engine overruled the refusal. Measured
     under #1650, an insistent Escape DOES overrule it -- the second `cancel` of a rapid sequence arrives with
     `cancelable: false` -- so that fallback was one close-and-reopen away from a visible flicker on an engine
     without `closedby`. `preventDefault()` on the keydown suppresses the close request entirely (measured), so
     there is nothing to overrule and nothing to put back. */
  const escapeKey = () => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void document.dispatchEvent(event));
    return event;
  };

  it("cancels the Escape keydown while the surface is nondismissible", () => {
    mount({}, { closedBy: false });
    open();
    busy(true);
    expect(escapeKey().defaultPrevented).toBe(true);
    expect(dismissals).toBe(0);
    expect(dialogEl()).not.toBeNull();
  });

  it("does not cancel it while the surface is dismissible", () => {
    mount({}, { closedBy: false });
    open();
    expect(escapeKey().defaultPrevented).toBe(false);
  });

  it("does not cancel it at all where the engine understands closedby", () => {
    mount({}, { closedBy: true });
    open();
    busy(true);
    expect(escapeKey().defaultPrevented).toBe(false);
  });

  it("survives a rapid repeated Escape with no close and no reopen", () => {
    mount({}, { closedBy: false });
    open();
    busy(true);
    const opened = showModalCalls.length;
    for (let i = 0; i < 6; i += 1) expect(escapeKey().defaultPrevented).toBe(true);
    expect(dismissals).toBe(0);
    expect(dialogEl()).not.toBeNull();
    expect(dialogEl()!.open).toBe(true);
    /* NO REOPEN LOOP: the element never closed, so it was never put back. */
    expect(showModalCalls).toHaveLength(opened);
    expect(closeCalls).toBe(0);
  });

  it("claims Escape with preventDefault and never with stopPropagation", () => {
    /* #1651's contract, kept: a listener that stopped propagation here would deny the key to everything else
       on the page. */
    mount({}, { closedBy: false });
    open();
    busy(true);
    let reachedWindow = 0;
    const count = () => {
      reachedWindow += 1;
    };
    window.addEventListener("keydown", count);
    escapeKey();
    window.removeEventListener("keydown", count);
    expect(reachedWindow).toBe(1);
    expect(readStripped("components/NativeModal.tsx")).not.toContain("stopPropagation");
  });

  it("stops refusing the moment the surface becomes dismissible again", () => {
    mount({}, { closedBy: false });
    open();
    busy(true);
    expect(escapeKey().defaultPrevented).toBe(true);
    busy(false);
    expect(escapeKey().defaultPrevented).toBe(false);
  });

  it("removes the listener when the surface goes", () => {
    mount({}, { closedBy: false });
    open();
    busy(true);
    expect(escapeKey().defaultPrevented).toBe(true);
    act(() => setOpen(false));
    expect(dialogEl()).toBeNull();
    expect(escapeKey().defaultPrevented).toBe(false);
  });

  it("leaves the application's own action controls closing normally", () => {
    /* A nondismissible surface is not an inescapable one: its visible control still calls what it always
       called. Here that is the harness's `setOpen(false)`, standing for "Begin operations" or "Got it". */
    mount({}, { closedBy: false });
    open();
    busy(true);
    expect(dialogEl()).not.toBeNull();
    act(() => setOpen(false));
    expect(dialogEl()).toBeNull();
  });

  it("keeps the cancel refusal as a second boundary", () => {
    mount({}, { closedBy: false });
    open();
    busy(true);
    const cancelEvent = new Event("cancel", { bubbles: false, cancelable: true });
    act(() => void dialogEl()!.dispatchEvent(cancelEvent));
    expect(cancelEvent.defaultPrevented).toBe(true);
  });
});
