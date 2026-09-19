/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1652 (harness): HOST GAME'S OWN HALF OF THE NATIVE CONTRACT
// ==================================================================
//
// WHAT THIS FILE COVERS, AND WHAT IT DOES NOT. The shared boundary -- the portal, the `showModal()` lifecycle,
// the UA reset, the transparent `::backdrop`, the `closedby` policy, the cancel/close coordination, the
// reference-counted scroll lock, the opener capture -- is asserted once, in `nativeModalBoundary.test.tsx`.
// This file asserts the part that is Host Game's alone: that its busy rule reaches the engine as a policy,
// that its manual Tab trap survived the conversion, and that the correction to its semantics is the shape the
// accessibility tree was measured on.
//
// THE CORRECTION, MEASURED. Under #1650 this dialog was `<dialog role="presentation">` wrapping
// `<div role="dialog" aria-modal="true">`, and `Accessibility.getFullAXTree` on the real Lobby returned TWO
// dialog nodes: the element (unnamed -- Chromium ignores `role="presentation"` on a `<dialog>`, whose implicit
// role is `dialog` and which permits only `alertdialog` instead) and the card, "Host a game". After the
// correction the same trace returns one node: `role=dialog name="Host a game" modal=true`.
//
// THE POLICY, MEASURED. `closedby="none"` refused Escape outright in Chromium 141 -- no `cancel`, no `close`,
// and it survived six rapid presses and a backdrop click. That replaced #1650's "refuse the cancel, and put
// the dialog back when the engine overrules the refusal", which was needed because a refused close request
// CAN be overruled: the second `cancel` of an insistent sequence arrives with `cancelable: false`.
//
// jsdom 16.7 has `HTMLDialogElement` and none of `show`, `showModal`, `close` or `closedby`, so the policy is
// read from the attribute the boundary writes and the close request is delivered by hand, exactly as measured.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import HostSetupCard from "./HostSetupCard";
import { ModalLayerHost } from "./ModalPortal";
import { NATIVE_MODAL_ATTRIBUTE } from "./NativeModal";
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
let closes = 0;
let showModalCalls = 0;
let closeCalls = 0;

function installDialogStub() {
  const proto = window.HTMLDialogElement.prototype as unknown as DialogStubProto;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    showModalCalls += 1;
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

function Harness({ busy = false }: { busy?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        Host game
      </button>
      {open && (
        <HostSetupCard
          busy={busy}
          error={null}
          onClose={() => {
            closes += 1;
            setOpen(false);
          }}
          onCreate={() => {}}
        />
      )}
    </>
  );
}

function mount(busy = false, { withNative = true } = {}) {
  closes = 0;
  showModalCalls = 0;
  closeCalls = 0;
  resetScrollLockForTests();
  if (withNative) installDialogStub();
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
    root!.render(<Harness busy={busy} />);
  });
}

function tearDown() {
  host?.remove();
  root = null;
  host = null;
  act(() => layerRoot?.unmount());
  layerHost?.remove();
  layerRoot = null;
  layerHost = null;
  removeDialogStub();
  resetScrollLockForTests();
  document.documentElement.style.removeProperty("overflow");
  document.body.style.removeProperty("padding-right");
}

function unmount() {
  act(() => root?.unmount());
  tearDown();
}

afterEach(() => {
  if (root || layerRoot) unmount();
});

const at = (testId: string) => {
  const node = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!node) throw new Error(`no such control: ${testId}`);
  return node;
};
const dialogEl = () => document.querySelector<HTMLDialogElement>(`dialog[${NATIVE_MODAL_ATTRIBUTE}]`);
const openDialog = () => {
  const node = dialogEl();
  if (!node) throw new Error("the dialog is not open");
  return node;
};
const cardEl = () => openDialog().querySelector<HTMLElement>(".host-card")!;
const closeX = () => openDialog().querySelector<HTMLElement>('button[aria-label="Close"]')!;
const dialogs = () => document.querySelectorAll(`dialog[${NATIVE_MODAL_ATTRIBUTE}]`).length;

function openWithPointer() {
  at("opener").focus();
  act(() => {
    at("opener").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** The platform's close request, as measured: `cancel`, then `close` unless something refused it, and neither
 *  at all while the declared policy is `none`. */
function pressEscape() {
  const node = dialogEl();
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

const clickOn = (node: Element) =>
  act(() => void node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));

function pressTab(from: Element, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  act(() => void from.dispatchEvent(event));
  return event;
}

/* ------------------------------------------------------------------ */
/* The corrected semantics                                             */
/* ------------------------------------------------------------------ */
describe("#1652 one dialog, and the element is it", () => {
  it("is a <dialog> named 'Host a game', with no role of its own", () => {
    mount();
    openWithPointer();
    expect(openDialog().tagName).toBe("DIALOG");
    expect(openDialog().getAttribute("aria-label")).toBe("Host a game");
    expect(openDialog().getAttribute("role")).toBeNull();
  });

  it("leaves nothing inside it claiming to be a dialog", () => {
    mount();
    openWithPointer();
    expect(dialogs()).toBe(1);
    expect(openDialog().querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal]')).toHaveLength(0);
    expect(cardEl().getAttribute("role")).toBeNull();
    expect(cardEl().getAttribute("aria-modal")).toBeNull();
  });

  it("keeps the card exactly where it was, inside the element and still the focus fallback", () => {
    mount();
    openWithPointer();
    expect(openDialog().contains(cardEl())).toBe(true);
    expect(cardEl().tabIndex).toBe(-1);
    expect(cardEl().className).toContain("host-card");
  });

  it("keeps the name constant across the step change, which is what #1630 settled", () => {
    mount();
    openWithPointer();
    clickOn(at("host-continue"));
    expect(at("host-create-room")).not.toBeNull();
    expect(openDialog().getAttribute("aria-label")).toBe("Host a game");
  });
});

/* ------------------------------------------------------------------ */
/* The busy rule, as a policy                                          */
/* ------------------------------------------------------------------ */
describe("#1652 busy is a closedby state, not a fight with the engine", () => {
  it("declares closerequest while the dialog is dismissible", () => {
    mount();
    openWithPointer();
    expect(openDialog().getAttribute("closedby")).toBe("closerequest");
  });

  it("declares none while the room is being opened", () => {
    mount(true);
    openWithPointer();
    expect(openDialog().getAttribute("closedby")).toBe("none");
  });

  it("agrees with the visible controls: the x is disabled and the scrim is dead in the same state", () => {
    mount(true);
    openWithPointer();
    expect(closeX().hasAttribute("disabled")).toBe(true);
    clickOn(openDialog());
    expect(closes).toBe(0);
    expect(dialogs()).toBe(1);
  });

  it("refuses Escape while busy, and the engine is what refuses it", () => {
    mount(true);
    openWithPointer();
    pressEscape();
    expect(closes).toBe(0);
    expect(dialogs()).toBe(1);
  });

  it("closes once on Escape when it is not busy", () => {
    mount();
    openWithPointer();
    pressEscape();
    expect(closes).toBe(1);
    expect(dialogs()).toBe(0);
  });

  it("adds no window keydown listener of its own", () => {
    const added: string[] = [];
    const spy = jest.spyOn(window, "addEventListener").mockImplementation(function (this: Window, ...args: never[]) {
      added.push(args[0] as unknown as string);
      return (Window.prototype.addEventListener as never as (...a: never[]) => void).apply(this, args);
    } as never);
    mount();
    openWithPointer();
    spy.mockRestore();
    expect(added.filter((type) => type === "keydown")).toHaveLength(0);
  });

  it("holds no second Escape route in the source, and no reopen workaround either", () => {
    const source = readStripped("components/HostSetupCard.tsx");
    expect(source.includes("useDialogDismissal")).toBe(false);
    expect(source.includes('addEventListener("keydown"')).toBe(false);
    expect(source.includes("showModal")).toBe(false);
    expect(source.includes("onCancel")).toBe(false);
    expect(source.includes("dismissible={!busy}")).toBe(true);
    expect(source.includes("onDismiss={onClose}")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Everything else about Host Game, unchanged                          */
/* ------------------------------------------------------------------ */
describe("#1652 the rest of Host Game's contract survives the conversion", () => {
  it("opens the element once, and closes it once -- but only when it is still open", () => {
    /* The two close routes end differently on purpose, and the difference is the platform's. After a close
       REQUEST the engine has already closed the element, so the teardown finds `open === false` and calls
       nothing: one close, performed by the engine. After the x, React unmounts a dialog that is still open,
       and the teardown closes it. Either way it is closed exactly once, which is what this asserts. */
    mount();
    openWithPointer();
    expect(showModalCalls).toBe(1);
    expect(closeCalls).toBe(0);
    pressEscape();
    expect(closeCalls).toBe(0);
    expect(dialogs()).toBe(0);

    openWithPointer();
    expect(showModalCalls).toBe(2);
    clickOn(closeX());
    expect(closeCalls).toBe(1);
    expect(dialogs()).toBe(0);
  });

  it("still renders where there is no showModal at all", () => {
    mount(false, { withNative: false });
    openWithPointer();
    expect(showModalCalls).toBe(0);
    expect(dialogs()).toBe(1);
    expect(at("host-type-standard")).not.toBeNull();
  });

  it("puts initial focus on the selected Game radio", () => {
    mount();
    openWithPointer();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("host-type-standard");
  });

  it("returns focus to the opener from Escape, from the x and from the scrim", () => {
    for (const close of [() => pressEscape(), () => clickOn(closeX()), () => clickOn(openDialog())]) {
      mount();
      openWithPointer();
      close();
      expect(dialogs()).toBe(0);
      expect(document.activeElement).toBe(at("opener"));
      unmount();
    }
  });

  it("does not close on a click inside the card", () => {
    mount();
    openWithPointer();
    clickOn(cardEl());
    expect(closes).toBe(0);
    expect(dialogs()).toBe(1);
  });

  it("keeps the manual Tab trap, which wraps without the browser's empty stop", () => {
    /* MEASURED, and the reason it stays. With the trap disabled in a harness build, Chromium's own dialog
       cycle still refused to leave the dialog -- but it inserted an extra stop on which
       `document.activeElement` is `<body>`, in both directions and in the dynamically-disabled state as well.
       Native containment is REAL and is not EQUIVALENT: it costs a keypress on which the focus ring is
       nowhere. It is also the only containment in this environment, which has no `showModal` to contain
       anything. */
    mount();
    openWithPointer();
    const last = at("host-continue");
    last.focus();
    expect(pressTab(last).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeX());
    const first = closeX();
    first.focus();
    expect(pressTab(first, true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(at("host-continue"));
  });

  it("pulls focus back in from the card itself, which is not a stop", () => {
    mount();
    openWithPointer();
    cardEl().focus();
    expect(pressTab(cardEl()).defaultPrevented).toBe(true);
    expect(cardEl().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(cardEl());
  });

  it("reopens on step one with the standard game selected", () => {
    mount();
    openWithPointer();
    clickOn(at("host-type-plus"));
    clickOn(at("host-continue"));
    pressEscape();
    openWithPointer();
    expect(document.querySelector('[data-testid="host-create-room"]')).toBeNull();
    expect(at("host-type-standard").getAttribute("aria-checked")).toBe("true");
    expect(at("host-type-plus").getAttribute("aria-checked")).toBe("false");
    expect(showModalCalls).toBe(2);
  });

  it("holds the shared scroll lock while it is up, and gives it back", () => {
    mount();
    expect(scrollLockHolders()).toBe(0);
    openWithPointer();
    expect(scrollLockHolders()).toBe(1);
    expect(document.documentElement.style.overflow).toBe("hidden");
    pressEscape();
    expect(scrollLockHolders()).toBe(0);
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("releases the lock even when the whole tree is unmounted with it open", () => {
    mount();
    openWithPointer();
    expect(scrollLockHolders()).toBe(1);
    act(() => root!.unmount());
    expect(scrollLockHolders()).toBe(0);
    expect(document.documentElement.style.overflow).toBe("");
    tearDown();
  });
});
