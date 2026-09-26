/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1643 (harness): THE THREE SETTINGS DIALOGS JOIN THE BOUNDARY
// ==================================================================
//
// Batch 2 of the modal audit's migration order: `SeatPinModal`, `AutoBuyModal`, `AutoPassModal` adopt
// `useDialogDismissal` (#1641). Measured on the real surfaces beforehand, with focus on the control being
// pressed -- which is what makes "where does focus land" a real question, since that control is unmounted
// with the dialog:
//
//                     | focus on open   | Escape      | x / Cancel / backdrop | focus afterwards
//   SeatPinModal      | the PIN input   | did nothing | all closed            | <body> every time
//   AutoBuyModal      | THE OPENER      | did nothing | all closed            | <body> every time
//   AutoPassModal     | THE OPENER      | did nothing | all closed            | <body> every time
//
// THE TWO AUTO MODALS HAVE NO INITIAL FOCUS AND STILL DO NOT. That is audit finding H2 and it belongs to its
// own batch; introducing it here would be a change nobody asked this batch for, so the cases below assert it
// is UNCHANGED rather than fixed.
//
// LIVE-2D: `SeatPinModal` is DELETED with the seat PINs -- a seat is the principal's in the server's GameRecord and
// comes back with the session, so there is no PIN to set or to rejoin with. Its rows above are the record of what
// was measured; its cases are gone, and one case below pins that no PIN surface comes back.
//
// AND THE DISMISSIBLE READING, taken from the controls rather than from a variable's name. All three pass no
// `dismissible` at all, and each for its own measured reason:
//
//   SeatPinModal    `busy` gates "Save PIN" only -- with a save held in flight the x, Cancel and the backdrop
//                   were all still live, and Cancel closed the card mid-save.
//   AutoBuyModal    the only disabled control is Arm (no ticked corporations); no route is gated.
//   AutoPassModal   the only disabled control is Start (an exposed presidency); no route is gated.
//
// WHY THE TWO AUTO MODALS CONSUME THE HOOK THROUGH A CHILD. Their `open` prop is a RENDER switch: they return
// `null` when it is false, and `App.tsx` keeps `AutoPassModal` mounted the whole session. A hook in the body
// would capture an opener when the shell mounted and never restore on a close. Converting the call site to a
// mount switch would re-seed `conditions` from `initial` on every opening -- measured: today a condition
// toggled off stays off across a close and reopen -- so this batch does not, and the cases below pin BOTH the
// retention and the child's inertness while closed.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/* #1651 (harness): EVERY DIALOG IN THIS FILE IS NOW A NATIVE `<dialog>` IN THE SHARED MODAL LAYER.
   `NativeModal` portals into `[data-modal-layer]` and throws if it is absent, so the harness renders
   `<ModalLayerHost />` beside its opener exactly as `GameRouter` does in the application. The dialog is the
   ELEMENT now, not a `<div role="dialog">` inside it (#1652 measured two dialog nodes in the accessibility
   tree before the correction), so every selector below reads `dialog[data-native-modal]`. */

import { ModalLayerHost } from "./ModalPortal";

import AutoBuyModal from "./AutoBuyModal";
import AutoPassModal from "./AutoPassModal";
import { readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const CORPS = [
  { companyId: 1, ticker: "PRR", holdingPercent: 10, parValue: "67", ipoPercent: 50, bankPoolPercent: 10, marketPrice: 70 },
  { companyId: 2, ticker: "B&O", holdingPercent: 0, parValue: "71", ipoPercent: 100, bankPoolPercent: 0, marketPrice: null },
] as never;

let host: HTMLDivElement;
let root: Root;
let closes = 0;
let arms: unknown[] = [];
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

type Which = "autobuy" | "autopass";
let setOpen: (open: boolean) => void = () => {};
let setDoomed: (present: boolean) => void = () => {};

/** `mountAlways` reproduces `App.tsx`'s wiring for `AutoPassModal`: the component is in the tree whether or
 *  not it is open, and `open` only decides whether it renders anything. */
function Harness({
  which,
  mountAlways,
  exposed,
  extraOpener,
}: {
  which: Which;
  mountAlways: boolean;
  exposed: readonly string[];
  extraOpener: boolean;
}) {
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
      {which === "autobuy" && (mountAlways || open) && (
        <AutoBuyModal open={open} corporations={CORPS} onArm={(s) => arms.push(s)} onClose={close} />
      )}
      {which === "autopass" && (mountAlways || open) && (
        <AutoPassModal open={open} exposedPresidencies={exposed} onArm={(c) => arms.push(c)} onClose={close} />
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

function mount(which: Which, opts: { mountAlways?: boolean; exposed?: readonly string[]; extraOpener?: boolean } = {}) {
  closes = 0;
  arms = [];
  spyListeners();
  mountLayer();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <Harness
        which={which}
        mountAlways={opts.mountAlways ?? false}
        exposed={opts.exposed ?? []}
        extraOpener={opts.extraOpener ?? false}
      />,
    ),
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
/* #1651: `AutoBuyModal` and `AutoPassModal` are native `<dialog>` elements. The custom `role="dialog"` dialect
   this accessor also finds was `SeatPinModal`'s, deleted in LIVE-2D; the case below asserts nothing of that
   dialect is left up. */
const dialog = () =>
  document.querySelector<HTMLElement>('dialog[data-native-modal]') ??
  document.querySelector<HTMLElement>('[role="dialog"]');
const isNative = () => !!document.querySelector("dialog[data-native-modal]");
const openDialog = () => {
  const node = dialog();
  if (!node) throw new Error("no dialog");
  return node;
};
const closeButton = () => openDialog().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
const btn = (text: string) =>
  Array.from(openDialog().querySelectorAll("button")).find((b) => (b.textContent || "").trim() === text) as
    | HTMLButtonElement
    | undefined;
const boxes = () => Array.from(openDialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));

const open = () => act(() => setOpen(true));
const click = (node: Element | null | undefined) =>
  act(() => void node?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
/** A backdrop click lands on the dialog element itself (#1651). */
const clickBackdrop = () => {
  const node = openDialog();
  const target = node.getAttribute("aria-modal") === "true" && node.tagName === "FORM" ? node.parentElement! : node;
  click(target);
};

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

const press = (key: string, target: EventTarget = document.activeElement ?? window) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => void target.dispatchEvent(event));
  if (key === "Escape") deliverCloseRequest(event);
  return event;
};
const escape = (target?: EventTarget) => press("Escape", target);
const typeInto = (input: HTMLInputElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

/* ================================================================== */
/*  What all three now share                                           */
/* ================================================================== */

const SURFACES: Array<{ label: string; which: Which; mountAlways?: boolean }> = [
  { label: "AutoBuyModal", which: "autobuy" },
  { label: "AutoPassModal", which: "autopass", mountAlways: true },
];

describe.each(SURFACES)("$label dismisses and sends focus home", ({ label, which, mountAlways }) => {
  beforeEach(() => mount(which, { mountAlways }));
  afterEach(() => unmount());

  it("closes on Escape through the same callback the visible controls use", () => {
    open();
    expect(dialog()).not.toBeNull();
    escape();
    expect(dialog()).toBeNull();
    expect(closes).toBe(1);
  });

  it("returns focus to the opener from Escape and from every pre-existing close route", () => {
    const routes: Array<[string, () => void]> = [
      ["Escape", () => escape()],
      ["x", () => click(closeButton())],
      ["Cancel", () => click(btn("Cancel"))],
      ["backdrop", () => clickBackdrop()],
    ];
    routes.forEach(([, run]) => {
      at("opener").focus();
      open();
      closeButton().focus();
      run();
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(at("opener"));
    });
    expect(closes).toBe(4);
  });

  it("stands down when an inner surface has already handled the key", () => {
    /* `defaultPrevented` first refusal, inherited from the shared hook rather than re-implemented here. */
    open();
    const inner = closeButton();
    inner.addEventListener("keydown", (event) => event.preventDefault());
    escape(inner);
    expect(dialog()).not.toBeNull();
    expect(closes).toBe(0);
  });

  it("ignores keys that are not Escape", () => {
    open();
    ["Enter", " ", "Tab", "Esc", "escape"].forEach((key) => press(key));
    expect(dialog()).not.toBeNull();
    expect(closes).toBe(0);
  });

  it("nets to zero keydown listeners across ten open/close cycles", () => {
    /* #1651 SUPERSEDES the flat `toBe(1)` here. A migrated surface installs NO `window` listener at all --
       Escape is the `closedby` attribute and the engine enforces it -- so its ledger never moves. The
       excluded PIN surface still owns its listener and still swings 0 -> 1 -> 0. Asserting the difference is
       what keeps a silent regression on either side visible. */
    expect(keydownListeners).toBe(0);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      open();
      expect(keydownListeners).toBe(0);
      escape();
      expect(keydownListeners).toBe(0);
    }
  });

  it("does not focus an opener that has left the document", () => {
    unmount();
    mount(which, { mountAlways, extraOpener: true });
    at("doomed").focus();
    open();
    const attempt = jest.spyOn(at("doomed"), "focus");
    act(() => setDoomed(false));
    at("bystander").focus();
    escape();
    expect(attempt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(at("bystander"));
  });

  it(`keeps ${label}'s accessible name and modality exactly as they were`, () => {
    open();
    const names: Record<string, string> = {
      AutoBuyModal: "Auto-Buy settings",
      AutoPassModal: "Auto-Pass conditions",
    };
    expect(openDialog().getAttribute("aria-label")).toBe(names[label]);
    /* #1652 SUPERSEDES the flat `aria-modal="true"` here. A migrated surface IS a `<dialog>`, whose modality
       comes from `showModal()` and whose role is implicit -- an `aria-modal` attribute on it would be
       redundant, and a nested `role="dialog"` inside it was the defect the correction removed. The excluded
       PIN surface still declares both, because nothing about it changed. */
    expect(isNative()).toBe(true);
    expect(openDialog().tagName).toBe("DIALOG");
    expect(openDialog().getAttribute("aria-modal")).toBeNull();
    expect(openDialog().getAttribute("role")).toBeNull();
    expect(openDialog().querySelectorAll('[role="dialog"], [aria-modal]')).toHaveLength(0);
  });
});

/* ================================================================== */
/*  Initial focus: unchanged on both                                   */
/* ================================================================== */

describe("initial focus is exactly what it was", () => {
  afterEach(() => unmount());

  it("AutoBuyModal still leaves focus on the opener, because it never moved it", () => {
    /* AUDIT H2, LEFT ALONE ON PURPOSE. Introducing initial focus here is a change this batch was told not to
       make; the case exists so that doing it later is deliberate rather than accidental. */
    mount("autobuy");
    at("opener").focus();
    open();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("AutoPassModal still leaves focus on the opener", () => {
    mount("autopass", { mountAlways: true });
    at("opener").focus();
    open();
    expect(document.activeElement).toBe(at("opener"));
  });
});

/* ================================================================== */
/*  Auto-Buy and Auto-Pass: arming, and the state they keep            */
/* ================================================================== */

describe("AutoBuyModal keeps the rest of its contract", () => {
  beforeEach(() => mount("autobuy"));
  afterEach(() => unmount());

  it("still refuses to arm with nothing ticked, and still arms with the ticked rows", () => {
    open();
    expect(btn("Start Auto-Buy")!.disabled).toBe(true);
    click(boxes()[0]);
    expect(btn("Start Auto-Buy")!.disabled).toBe(false);
    click(btn("Start Auto-Buy"));
    expect(arms).toHaveLength(1);
    expect((arms[0] as { targets: Array<{ companyId: number }> }).targets.map((t) => t.companyId)).toEqual([1]);
    expect((arms[0] as { source: string }).source).toBe("Ipo");
  });

  it("re-seeds from its props each time, because its parent mounts it on open", () => {
    /* UNCHANGED. `App.tsx` renders this one inside `{autoBuyOpen && ...}`, so a close really does unmount it
       and the next opening re-reads the roster and last choices -- which is what #1240's note says it is for. */
    open();
    click(boxes()[0]);
    expect(btn("Start Auto-Buy")!.disabled).toBe(false);
    click(btn("Cancel"));
    open();
    expect(btn("Start Auto-Buy")!.disabled).toBe(true);
  });
});

describe("AutoPassModal keeps the rest of its contract", () => {
  afterEach(() => unmount());

  it("still arms with the conditions on screen", () => {
    mount("autopass", { mountAlways: true });
    open();
    click(btn("Start Auto-Pass"));
    expect(arms).toHaveLength(1);
    expect(arms[0]).toMatchObject({ presidencyThreatened: true });
  });

  it("still refuses to start while a presidency is exposed, and is still dismissible then", () => {
    /* The disabled control is Start, not a close route -- so Escape must still work, which is the whole
       reason `dismissible` is not wired to it. */
    mount("autopass", { mountAlways: true, exposed: ["PRR"] });
    at("opener").focus();
    open();
    expect(btn("Start Auto-Pass")!.disabled).toBe(true);
    escape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("still keeps the conditions the player set across a close and a reopen", () => {
    /* MEASURED BEFORE THE MIGRATION AND UNCHANGED BY IT. `App.tsx` keeps this component mounted, so its state
       survives a close. That is exactly why the dismissal lifecycle went into a child instead of the body. */
    mount("autopass", { mountAlways: true });
    open();
    expect(boxes().map((b) => b.checked)).toEqual([true, true, true]);
    click(boxes()[1]);
    expect(boxes().map((b) => b.checked)).toEqual([true, false, true]);
    click(btn("Cancel"));
    open();
    expect(boxes().map((b) => b.checked)).toEqual([true, false, true]);
  });

  it("holds no listener and captures no opener while it is mounted but closed", () => {
    /* THE PROPERTY THE CHILD EXISTS FOR. In `App.tsx` this component is in the tree for the whole session; a
       hook in its body would have been listening the whole time and would have captured its opener when the
       shell mounted. */
    mount("autopass", { mountAlways: true });
    expect(dialog()).toBeNull();
    expect(keydownListeners).toBe(0);
    escape();
    expect(closes).toBe(0);
    open();
    /* #1651 SUPERSEDES the `toBe(1)` that stood here. What the case was protecting is the same and is
       asserted harder: a surface that is MOUNTED BUT CLOSED must hold nothing. It used to hold one listener
       while open; it now holds none at any time, because the Escape policy is an attribute the engine
       enforces. The ledger must therefore be flat across the whole cycle. */
    expect(keydownListeners).toBe(0);
    escape();
    expect(keydownListeners).toBe(0);
  });
});

/* ================================================================== */
/*  Structure                                                          */
/* ================================================================== */

describe("the migrated sources keep the ordering the hook depends on", () => {
  it("LIVE-2D: no seat-PIN surface survives -- the modal, its call sites and its store are gone", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    for (const gone of ["components/SeatPinModal.tsx", "utils/seatPin.ts"]) {
      expect([gone, fs.existsSync(path.join(__dirname, "..", gone))]).toEqual([gone, false]);
    }
    for (const file of ["App.tsx", "components/Lobby.tsx", "components/SandboxWaitingRoom.tsx", "components/JoinGameCard.tsx"]) {
      const source = readStripped(file);
      for (const name of ["SeatPinModal", "seatPin", "setSeatPin", "claimSeat", "readSeatPin", "readSeatToken"]) {
        expect([file, name, source.includes(name)]).toEqual([file, name, false]);
      }
    }
  });

  it("keeps the two auto modals' lifecycle out of the component body entirely", () => {
    /* #1651 SUPERSEDES THE SHAPE, NOT THE PROPERTY. The property is unchanged and is still the point: their
       `open` prop is a RENDER switch, so anything holding a listener or a captured opener must not sit in the
       exported component's body, which necessarily runs above `if (!open) return null`. That used to be
       enforced by keeping `useDialogDismissal` in a small child. There is no hook to place now -- the
       lifecycle is `NativeModal`, and `NativeModal` is only RENDERED past the switch, which is the same
       guarantee said in one fewer moving part. What this asserts is that shape. */
    ([
      ["components/AutoBuyModal.tsx", "AutoBuyModal"],
      ["components/AutoPassModal.tsx", "AutoPassModal"],
    ] as const).forEach(([path, name]) => {
      const source = readStripped(path);
      const componentAt = source.indexOf("export function " + name);
      expect([path, componentAt >= 0]).toEqual([path, true]);
      const componentBody = source.slice(componentAt);
      expect([path, componentBody.includes("if (!open) return null;")]).toEqual([path, true]);
      expect([path, "no hook anywhere", source.includes("useDialogDismissal(")]).toEqual([
        path,
        "no hook anywhere",
        false,
      ]);
      /* The boundary is rendered BELOW the render switch, so it mounts and unmounts with the dialog. */
      const switchAt = componentBody.indexOf("if (!open) return null;");
      const boundaryAt = componentBody.indexOf("<NativeModal");
      expect([path, "boundary below the switch", boundaryAt > switchAt && switchAt >= 0]).toEqual([
        path,
        "boundary below the switch",
        true,
      ]);
    });

  });
});
