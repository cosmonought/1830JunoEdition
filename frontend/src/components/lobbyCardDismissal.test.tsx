/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1642 (harness): THE TWO LOBBY CARDS JOIN THE BOUNDARY
// ==================================================================
//
// Batch 1 of the modal audit's migration order. `JoinGameCard` and `RejoinByPinCard` adopt the batch-0 hook
// (`useDialogDismissal`, #1641) and nothing else changes -- with one exception, recorded below and asserted
// here, because the audit's rule is that Escape must agree with the visible controls rather than be stricter
// or laxer than them.
//
// MEASURED ON THE REAL CARDS BEFORE THE CHANGE, with focus on the control being pressed (which is what makes
// "where does focus land" a real question -- that control is unmounted with the card):
//
//                       | Escape        | x / Cancel / backdrop | focus afterwards
//     JoinGameCard      | did nothing   | all closed            | <body> every time
//     RejoinByPinCard   | did nothing   | all closed            | <body> every time
//
// AND THE BUSY READING THAT DECIDED THE TWO `dismissible` ARGUMENTS, also measured:
//
//     JoinGameCard, busy=true      x DISABLED, backdrop DEAD, Cancel LIVE   -> the routes disagreed
//     RejoinByPinCard, lookup in flight   submit DISABLED, x/Cancel/backdrop ALL LIVE -> they agree
//
// So the two cards get different arguments for the same reason: the rule is read off the controls each time.
// Join Game's Cancel is normalised to `disabled={busy}` -- the smallest change that makes its three visible
// routes agree with each other -- and then `dismissible={!busy}`. Rejoin passes no `dismissible` at all.
//
// WHAT THIS FILE DOES NOT ASSERT: tab containment, scroll lock, portals, `inert`, backdrop mechanics. None of
// those is in this batch; the background-Tab defect (audit H1) is deferred to its own.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/* #1651 (harness): EVERY DIALOG IN THIS FILE IS NOW A NATIVE `<dialog>` IN THE SHARED MODAL LAYER.
   `NativeModal` portals into `[data-modal-layer]` and throws if it is absent, so the harness renders
   `<ModalLayerHost />` beside its opener exactly as `GameRouter` does in the application. The dialog is the
   ELEMENT now, not a `<div role="dialog">` inside it (#1652 measured two dialog nodes in the accessibility
   tree before the correction), so every selector below reads `dialog[data-native-modal]`. */

import { ModalLayerHost } from "./ModalPortal";

import JoinGameCard from "./JoinGameCard";
import RejoinByPinCard from "./RejoinByPinCard";
import { readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/** The PIN card's two network calls, held open so `busy` can be observed rather than raced. */
let mockLookupCalls: unknown[][] = [];
let mockSettleLookup: (answer: unknown) => void = () => {};
jest.mock("../utils/roomDocLink", () => ({
  findSeatsByPin: (...args: unknown[]) => {
    mockLookupCalls.push(args);
    return new Promise((resolve) => {
      mockSettleLookup = resolve;
    });
  },
  claimSeat: () => new Promise(() => {}),
}));

let host: HTMLDivElement;
let root: Root;
let closes = 0;
let keydownListeners = 0;
let joinCalls: string[] = [];
let rejoinCalls: string[] = [];
let clearErrorCalls = 0;
let byCodeCalls = 0;

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

type Which = "join" | "rejoin";
let setOpen: (open: boolean) => void = () => {};
let setDoomed: (present: boolean) => void = () => {};

function Harness({ which, busy, extraOpener }: { which: Which; busy: boolean; extraOpener: boolean }) {
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
      {/* Stands in for the opener that the Lobby replaces on a successful join: it can be removed while the
          dialog is up, which is the only way to reach the `isConnected` guard from a real flow. */}
      {doomedPresent && (
        <button type="button" data-testid="doomed">
          Doomed opener
        </button>
      )}
      {open && which === "join" && (
        <JoinGameCard
          error={null}
          busy={busy}
          onClose={close}
          onJoin={(code) => joinCalls.push(code)}
          onRejoin={(code) => rejoinCalls.push(code)}
          onClearError={() => {
            clearErrorCalls += 1;
          }}
        />
      )}
      {open && which === "rejoin" && (
        <RejoinByPinCard
          onClose={close}
          onRejoinByCode={() => {
            byCodeCalls += 1;
            setOpenState(false);
          }}
        />
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

function mount(which: Which, busy = false, extraOpener = false) {
  closes = 0;
  joinCalls = [];
  rejoinCalls = [];
  mockLookupCalls = [];
  clearErrorCalls = 0;
  byCodeCalls = 0;
  spyListeners();
  mountLayer();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness which={which} busy={busy} extraOpener={extraOpener} />));
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
const card = () => document.querySelector<HTMLElement>('dialog[data-native-modal]');
const openCard = () => {
  const node = card();
  if (!node) throw new Error("no dialog");
  return node;
};
/* #1651: the scrim and the dialog are the same element now, so a "backdrop click" is a click on the
   `<dialog>` itself -- which is what `onScrimClick` answers, and what a click on the real `::backdrop`
   reports as its target in a browser. */
const backdrop = openCard;
const field = () => openCard().querySelector<HTMLInputElement>("input")!;
const buttonLabelled = (text: string) =>
  Array.from(openCard().querySelectorAll("button")).find((b) => (b.textContent || "").trim() === text) as
    | HTMLButtonElement
    | undefined;
const closeButton = () => openCard().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;

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

const press = (key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => void (document.activeElement ?? window).dispatchEvent(event));
  if (key === "Escape") deliverCloseRequest(event);
};
const escape = () => press("Escape");
const type = (value: string) => {
  const input = field();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = () =>
  act(() => void openCard().querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

/* ================================================================== */
/*  Join Game                                                          */
/* ================================================================== */

describe("Join by room code", () => {
  beforeEach(() => mount("join"));
  afterEach(() => unmount());

  it("still opens with the room-code field focused, and it is still the first field", () => {
    /* THE TARGET IS UNCHANGED. It was native `autoFocus`; it is now a local layout effect on the same input,
       because autofocus fires in React's mutation phase -- before any effect -- and would be captured as the
       opener by the hook. */
    at("opener").focus();
    open();
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute("aria-label")).toBe("Room code");
    expect(openCard().querySelectorAll("input")).toHaveLength(1);
  });

  it("closes on Escape through the same callback the visible controls use", () => {
    at("opener").focus();
    open();
    escape();
    expect(card()).toBeNull();
    expect(closes).toBe(1);
  });

  it("returns focus to the opener on Escape", () => {
    at("opener").focus();
    open();
    field().focus();
    escape();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("returns focus to the same opener from the x, from Cancel and from the backdrop", () => {
    const routes: Array<[string, () => void]> = [
      ["x", () => click(closeButton())],
      ["Cancel", () => click(buttonLabelled("Cancel"))],
      ["backdrop", () => click(backdrop())],
    ];
    routes.forEach(([, run]) => {
      at("opener").focus();
      open();
      /* Focus the control being pressed, which is what a keyboard player does and what a pointer click does in
         a browser -- and what makes this a real question, since that control leaves with the card. */
      field().focus();
      run();
      expect(card()).toBeNull();
      expect(document.activeElement).toBe(at("opener"));
    });
    expect(closes).toBe(3);
  });

  it("resets the typed code by unmounting, not by reset code", () => {
    /* The reset is the unmount, exactly as before: there is no reset branch in the component, so there is no
       second path for Escape to have to keep in step with. */
    at("opener").focus();
    open();
    type("JUNO-9X");
    expect(field().value).toBe("JUNO-9X");
    escape();
    open();
    expect(field().value).toBe("");
  });

  it("reopens at the default state after every close route", () => {
    (["escape", "x", "cancel", "backdrop"] as const).forEach((route) => {
      open();
      type("ZZZ-1");
      if (route === "escape") escape();
      if (route === "x") click(closeButton());
      if (route === "cancel") click(buttonLabelled("Cancel"));
      if (route === "backdrop") click(backdrop());
      open();
      expect(field().value).toBe("");
      escape();
    });
  });

  it("adds no window keydown listener at all across ten open/close cycles", () => {
    /* #1651 SUPERSEDES "nets to zero". The ledger used to swing 0 -> 1 -> 0 per cycle, because the card held
       a `window` Escape listener while it was up. There is none now: Escape is the `closedby` attribute and
       the engine enforces it. Flat-at-zero is the stricter assertion -- a leak still fails it, and so does a
       second Escape path being reintroduced. */
    expect(keydownListeners).toBe(0);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      open();
      expect(keydownListeners).toBe(0);
      escape();
      expect(keydownListeners).toBe(0);
    }
    expect(closes).toBe(10);
  });

  it("does not restore focus to an opener the join has removed from the document", () => {
    /* THE REAL SHAPE OF THIS: a successful join calls `onEnterSandbox`, which replaces the whole lobby. The
       guard matters because focusing a detached node silently lands focus on `<body>`. */
    unmount();
    mount("join", false, true);
    at("doomed").focus();
    open();
    const attempt = jest.spyOn(at("doomed"), "focus");
    /* Removed BY REACT, the way the Lobby removes it -- `onEnterSandbox` replaces the whole scene. */
    act(() => setDoomed(false));
    at("bystander").focus();
    escape();
    expect(attempt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(at("bystander"));
  });

  it("still submits the typed code, and still offers the by-code rejoin", () => {
    open();
    type("JUNO-4T2");
    submit();
    expect(joinCalls).toEqual(["JUNO-4T2"]);
    click(buttonLabelled("Rejoin seat"));
    expect(rejoinCalls).toEqual(["JUNO-4T2"]);
  });

  it("still clears the parent's verdict when the code changes, and not when it does not", () => {
    open();
    type("A");
    expect(clearErrorCalls).toBe(1);
    type("A");
    expect(clearErrorCalls).toBe(1);
    type("AB");
    expect(clearErrorCalls).toBe(2);
  });
});

describe("Join by room code, while a join is in flight", () => {
  beforeEach(() => mount("join", true));
  afterEach(() => unmount());

  it("refuses all four dismissal routes, which is the normalisation this batch made", () => {
    /* MEASURED BEFORE: the x was disabled and the backdrop was dead, but CANCEL WAS LIVE -- so a player could
       close the card while the round trip carried on and still be taken into the room when it landed. Cancel
       now carries the same rule as the two routes that already had it, and Escape is the fourth. */
    open();
    expect(closeButton().disabled).toBe(true);
    expect(buttonLabelled("Cancel")!.disabled).toBe(true);
    click(closeButton());
    click(buttonLabelled("Cancel"));
    click(backdrop());
    escape();
    expect(card()).not.toBeNull();
    expect(closes).toBe(0);
  });

  it("still disables the two submit controls, unchanged", () => {
    open();
    expect(buttonLabelled("Join by code")!.disabled).toBe(true);
    expect(buttonLabelled("Rejoin seat")!.disabled).toBe(true);
  });

  it("still opens with the room-code field focused while busy", () => {
    at("opener").focus();
    open();
    expect(document.activeElement).toBe(field());
  });
});

/* ================================================================== */
/*  Rejoin by PIN                                                      */
/* ================================================================== */

describe("Rejoin a game", () => {
  beforeEach(() => mount("rejoin"));
  afterEach(() => unmount());

  it("still opens with the PIN field focused", () => {
    at("opener").focus();
    open();
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute("aria-label")).toBe("Seat PIN");
  });

  it("closes on Escape through the same callback the visible controls use", () => {
    at("opener").focus();
    open();
    escape();
    expect(card()).toBeNull();
    expect(closes).toBe(1);
  });

  it("returns focus to the opener from Escape, the x, Cancel and the backdrop", () => {
    const routes: Array<() => void> = [
      () => escape(),
      () => click(closeButton()),
      () => click(buttonLabelled("Cancel")),
      () => click(backdrop()),
    ];
    routes.forEach((run) => {
      at("opener").focus();
      open();
      field().focus();
      run();
      expect(card()).toBeNull();
      expect(document.activeElement).toBe(at("opener"));
    });
    expect(closes).toBe(4);
  });

  it("returns focus to the opener on the by-code route as well, which is a navigation rather than a close", () => {
    /* `onRejoinByCode` is not `onClose`, but it unmounts this card -- and the restore lives in the unmount,
       which is why it covers a route nobody wired it to. */
    at("opener").focus();
    open();
    field().focus();
    click(buttonLabelled("No PIN yet? Rejoin by room code"));
    expect(card()).toBeNull();
    expect(byCodeCalls).toBe(1);
    expect(document.activeElement).toBe(at("opener"));
  });

  it("resets the typed PIN by unmounting", () => {
    at("opener").focus();
    open();
    type("1234");
    expect(field().value).toBe("1234");
    escape();
    open();
    expect(field().value).toBe("");
  });

  it("adds no window keydown listener at all across ten open/close cycles", () => {
    /* #1651 SUPERSEDES "nets to zero". The ledger used to swing 0 -> 1 -> 0 per cycle, because the card held
       a `window` Escape listener while it was up. There is none now: Escape is the `closedby` attribute and
       the engine enforces it. Flat-at-zero is the stricter assertion -- a leak still fails it, and so does a
       second Escape path being reintroduced. */
    expect(keydownListeners).toBe(0);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      open();
      expect(keydownListeners).toBe(0);
      escape();
      expect(keydownListeners).toBe(0);
    }
  });

  it("does not restore focus to an opener that has left the document", () => {
    unmount();
    mount("rejoin", false, true);
    at("doomed").focus();
    open();
    const attempt = jest.spyOn(at("doomed"), "focus");
    act(() => setDoomed(false));
    at("bystander").focus();
    escape();
    expect(attempt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(at("bystander"));
  });

  it("still validates the PIN before asking the server", () => {
    open();
    type("12");
    submit();
    expect(mockLookupCalls).toHaveLength(0);
    expect(openCard().textContent).toContain("A PIN is exactly four digits.");
    type("1234");
    submit();
    expect(mockLookupCalls).toHaveLength(1);
    expect((mockLookupCalls[0] as unknown[])[1]).toBe("1234");
  });

  it("still strips non-digits and still caps the PIN at four", () => {
    open();
    type("9a8b7c6d5");
    expect(field().value).toBe("9876");
  });

  it("stays dismissible while a lookup is in flight, because every visible route is", () => {
    /* THE READING THAT DECIDED `dismissible` IS NOT PASSED HERE. `busy` on this card gates the submit
       controls only; the x, Cancel and the backdrop never carried it, so Escape must not either. */
    at("opener").focus();
    open();
    type("1234");
    submit();
    expect(buttonLabelled("Find my games")!.disabled).toBe(true);
    expect(closeButton().disabled).toBe(false);
    expect(buttonLabelled("Cancel")!.disabled).toBe(false);
    field().focus();
    escape();
    expect(card()).toBeNull();
    expect(closes).toBe(1);
    expect(document.activeElement).toBe(at("opener"));
    mockSettleLookup({ seats: [] });
  });
});

/* ================================================================== */
/*  Structure: the two things that are ordering, not behaviour         */
/* ================================================================== */

describe("the migrated sources keep the ordering the hook depends on", () => {
  const sources = [
    ["JoinGameCard", "components/JoinGameCard.tsx"],
    ["RejoinByPinCard", "components/RejoinByPinCard.tsx"],
  ] as const;

  it("carries no native autoFocus in either migrated dialog", () => {
    /* NOT A STYLE RULE. React applies `autoFocus` during the commit's mutation phase, before every effect, so
       a surviving one would move focus INSIDE the card before `useDialogDismissal` captures the opener -- and
       the card would then try to restore focus to its own input, a node that leaves with it. Comments are
       stripped first, because both files explain this in prose. */
    sources.forEach(([label, path]) => {
      expect([label, readStripped(path).includes("autoFocus")]).toEqual([label, false]);
    });
  });

  it("leaves the opener capture where it must run: inside the boundary, before showModal", () => {
    /* #1651 SUPERSEDES the declaration-order check that stood here. It compared `useDialogDismissal` against
       the card's own initial-focus layout effect, because both were layout effects in the SAME component and
       nothing but their order kept the opener from being the card's own input.
       That ordering is no longer expressible at this level and no longer needs to be. `showModal()` moves
       focus into the dialog, and layout effects run CHILD-FIRST -- so a capture in the card's body would run
       AFTER the boundary had already moved focus. The capture therefore lives inside `NativeModal`, in the
       same effect as `showModal()` and on the line above it, where the two cannot be separated. What this
       asserts is that pairing, plus the absence of any competing capture in the cards. */
    const boundary = readStripped("components/NativeModal.tsx");
    const captureAt = boundary.indexOf("openerRef.current = typeof document");
    const openAt = boundary.indexOf("node.showModal();");
    expect([captureAt >= 0, openAt >= 0]).toEqual([true, true]);
    expect(captureAt).toBeLessThan(openAt);
    sources.forEach(([label, path]) => {
      const body = readStripped(path);
      expect([label, "no hook", body.includes("useDialogDismissal(")]).toEqual([label, "no hook", false]);
      expect([label, "uses the boundary", body.includes("restoreOpener")]).toEqual([
        label,
        "uses the boundary",
        true,
      ]);
      expect([label, "no capture of its own", body.includes("openerRef")]).toEqual([
        label,
        "no capture of its own",
        false,
      ]);
    });
  });
});
