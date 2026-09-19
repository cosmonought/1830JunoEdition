/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1629 (harness): ESCAPE, AND WHERE FOCUS GOES WHEN THE CARD LEAVES
// ==================================================================
//
// REPORTED: Escape does not dismiss the Host Game dialog.
//
// MEASURED BEFORE THE FIX, in Chromium 141 at 430 and 1440, both identical:
//     Escape from step 1  -> dialog still open
//     Escape from step 2  -> dialog still open
//     close with the x    -> `document.activeElement` is <body>
//     close with Cancel   -> `document.activeElement` is <body>
// So the report was one of two defects on the same surface, and the second one is the more damaging of the
// two for a keyboard player: the control they pressed is unmounted with the card, and focus lands at the top
// of the document rather than back on "Host game".
//
// THE FIX IS THE HOUSE PATTERN, NOT A NEW ONE. `MarketPeekModal` already carries both halves -- #1141's
// opener capture restored on unmount, and a `keydown` listener mounted only while the dialog is up -- and
// `BuyLicenseModal` carries the listener. This dialog never got either. There is no shared modal primitive in
// this tree to reach for; ten components hand-roll the same listener, which is reported rather than fixed
// here, because extracting one would mean re-verifying ten consumers.
//
// WHAT THIS FILE MOUNTS, and why it is not `Lobby`. The contract under test is a RELATIONSHIP between an
// opener and the card: whatever is focused when the card mounts is what is focused again when it unmounts.
// The harness therefore renders a real button and `{open && <HostSetupCard/>}` beside it -- the same shape
// `Lobby` uses -- so the opener in these cases is a real element that really holds focus, and the card is the
// real card. Mounting `Lobby` would drag in the server link to assert nothing extra.
//
// ==================================================================
//  DESIGN NOTE 1630 (harness): THE REST OF WHAT `aria-modal` WAS CLAIMING
// ==================================================================
//
// #1629 fixed Escape and sent focus home on close. Three things it left, each measured in Chromium at 430 and
// 1440 before this pass: focus stayed on the "Host game" button BEHIND the dialog when it opened; Tab walked
// out of the card into the lobby; and Continue unmounted the button holding focus and dropped it on `<body>`.
//
// WHAT THE CASES BELOW ASSERT IS MOVEMENT, not markup: which element holds focus after each event, and where
// focus goes when Tab reaches an end. The tab ORDER in the middle is the browser's and is not re-implemented,
// so it is not re-asserted -- what is asserted is that the set Tab can reach lies entirely inside the card.
//
// `:focus-visible` IS NOT ASSERTED HERE, and no proxy is invented for it: jsdom does not implement it, so a
// case claiming "no ring appeared" would be claiming something this environment cannot see. What IS asserted
// here is the focus TARGET, which is what decides the ring: the pointer-open round trip must leave focus on
// the element that already had it, so there is no focus change for a ring to attach to. The ring itself is
// measured in Chromium, both ways round -- pointer-open/Escape-close and keyboard-open/Escape-close -- and
// recorded in `claude/host-dialog-escape-2026-09-18.md`.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/* #1651 (harness): EVERY DIALOG IN THIS FILE IS NOW A NATIVE `<dialog>` IN THE SHARED MODAL LAYER.
   `NativeModal` portals into `[data-modal-layer]` and throws if it is absent, so the harness renders
   `<ModalLayerHost />` beside its opener exactly as `GameRouter` does in the application. The dialog is the
   ELEMENT now, not a `<div role="dialog">` inside it (#1652 measured two dialog nodes in the accessibility
   tree before the correction), so every selector below reads `dialog[data-native-modal]`. */

import { ModalLayerHost } from "./ModalPortal";

import HostSetupCard from "./HostSetupCard";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let closes = 0;
/** Every `keydown` listener added to `window`, minus every one removed -- the cleanup ledger for case 8. */
let keydownListeners = 0;
let addSpy: jest.SpyInstance;
let removeSpy: jest.SpyInstance;

/** The opener and the card, wired the way `Lobby` wires them: the card mounts beside the button that opened
 *  it, and closing unmounts the card outright. */
function Harness({ busy = false }: { busy?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        Host game
      </button>
      <button type="button" data-testid="bystander">
        Join game
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

function mount(busy = false) {
  closes = 0;
  keydownListeners = 0;
  addSpy = jest.spyOn(window, "addEventListener").mockImplementation(function (this: Window, ...args: never[]) {
    if (args[0] === ("keydown" as never)) keydownListeners += 1;
    return (Window.prototype.addEventListener as never as (...a: never[]) => void).apply(this, args);
  } as never);
  removeSpy = jest.spyOn(window, "removeEventListener").mockImplementation(function (this: Window, ...args: never[]) {
    if (args[0] === ("keydown" as never)) keydownListeners -= 1;
    return (Window.prototype.removeEventListener as never as (...a: never[]) => void).apply(this, args);
  } as never);
  mountLayer();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<Harness busy={busy} />);
  });
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  unmountLayer();
  root = null;
  host = null;
  addSpy?.mockRestore();
  removeSpy?.mockRestore();
}

const at = (testId: string): HTMLButtonElement => {
  const node = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!node) throw new Error(`no such control: ${testId}`);
  return node;
};
const maybe = (selector: string) => document.querySelector<HTMLElement>(selector);
const dialogs = () => document.querySelectorAll('dialog[data-native-modal]').length;
const onStep = (): "type" | "rules" | "closed" => {
  if (dialogs() === 0) return "closed";
  return maybe('[data-testid="host-create-room"]') ? "rules" : "type";
};

/** Open the card the way a POINTER does: the browser focuses a clicked button, so the harness focuses it
 *  first and then clicks -- jsdom does not do that itself (`hostRadioGroups.test.tsx` #1448 explains why
 *  that makes jsdom an exact stand-in for WebKit). */
function openWithPointer() {
  at("opener").focus();
  act(() => {
    at("opener").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Open the card the way a KEYBOARD does: focus arrives by Tab, then Enter activates. Focus is on the opener
 *  either way; the difference is what the engine will later decide about a ring. */
function openWithKeyboard() {
  at("opener").focus();
  act(() => {
    at("opener").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    at("opener").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** One Escape, from wherever focus currently is. */

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

function pressEscape(from: Element = document.activeElement ?? document.body) {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => {
    from.dispatchEvent(event);
  });
  deliverCloseRequest(event);
}

const toRules = () => {
  act(() => {
    at("host-continue").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

/** The rendered state of the card, as a value two close paths can be compared on. */
const snapshot = () => ({
  step: onStep(),
  checked: Array.from(document.querySelectorAll('[role="radio"]'))
    .filter((node) => node.getAttribute("aria-checked") === "true")
    .map((node) => node.getAttribute("data-radio-key")),
  heading: maybe('dialog[data-native-modal]')?.getAttribute("aria-label") ?? null,
});

/** The card element itself. */
/** THE DIALOG IS THE ELEMENT NOW (#1652). The scrim and the accessible dialog are one and the same
 *  `<dialog>`; the visual card inside it is an ordinary `<div>` that still carries `tabIndex={-1}` and the
 *  Tab trap, which is why both accessors exist and why they are not interchangeable. */
const dialogEl = () => {
  const node = document.querySelector<HTMLDialogElement>("dialog[data-native-modal]");
  if (!node) throw new Error("the dialog is not open");
  return node;
};
const card = () => {
  const node = dialogEl().querySelector<HTMLElement>(".host-card");
  if (!node) throw new Error("the card is not rendered");
  return node;
};

/** A readable name for one element -- used so a failure says WHICH control, not just "not equal". A radio
 *  answers with its key, because that is the vocabulary the group is written in; everything else answers with
 *  its test id, its label, or its text. */
const nameOf = (node: HTMLElement): string =>
  node.getAttribute("data-radio-key") ??
  node.getAttribute("data-testid") ??
  (node.getAttribute("role") === "heading" ? `heading:${node.textContent?.trim()}` : null) ??
  node.getAttribute("aria-label") ??
  `${node.tagName}:${node.textContent?.trim().slice(0, 18)}`;

const focusName = () => {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return "null";
  if (a === document.body) return "<body>";
  if (a === document.querySelector<HTMLElement>(".host-card")) return "<card>";
  if (a === document.querySelector("dialog[data-native-modal]")) return "<dialog>";
  return nameOf(a);
};

/** Everything Tab can reach inside the card, computed here rather than imported, so the component and the
 *  harness are not reading the same function and agreeing with themselves. */
const tabStops = (): HTMLElement[] =>
  Array.from(card().querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")).filter(
    (node) => !node.hasAttribute("disabled") && node.tabIndex >= 0 && node.getAttribute("aria-hidden") !== "true",
  );

/** One Tab (or Shift+Tab) from whatever holds focus, delivered the way a browser delivers it. */
const tab = (shiftKey = false) => {
  const from = (document.activeElement as HTMLElement | null) ?? document.body;
  act(() => {
    from.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
  });
};

const backToType = () => {
  act(() => {
    Array.from(document.querySelectorAll<HTMLElement>('dialog[data-native-modal] button'))
      .find((node) => node.textContent?.trim() === "Back")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

beforeEach(() => mount());
afterEach(unmount);

/* ------------------------------------------------------------------ */
/* 1, 2 -- Escape closes, from either step                             */
/* ------------------------------------------------------------------ */

describe("Escape dismisses the Host Game dialog", () => {
  it("opens at step one, as it did before", () => {
    /* THE FLOOR UNDER EVERY CASE BELOW. A harness that failed to open the card would satisfy "Escape closed
       it" perfectly. */
    expect(dialogs()).toBe(0);
    openWithPointer();
    expect(dialogs()).toBe(1);
    expect(onStep()).toBe("type");
  });

  it("closes from step one", () => {
    openWithPointer();
    pressEscape();
    expect(dialogs()).toBe(0);
    expect(closes).toBe(1);
  });

  it("closes from step two", () => {
    /* THE STEP WITH NO CANCEL BUTTON. Step one offers Cancel; step two offers Back and Create Room, so before
       this change the only ways out of the house-rules step were the x and the backdrop. */
    openWithPointer();
    toRules();
    expect(onStep()).toBe("rules");
    pressEscape();
    expect(dialogs()).toBe(0);
    expect(closes).toBe(1);
  });

  it("closes from wherever focus happens to be inside the card", () => {
    /* The listener is on `window`, so the key does not depend on which control holds focus -- which matters
       because this dialog has no focus trap and never claimed one. */
    openWithPointer();
    for (const testId of ["host-type-plus", "host-pace-async", "host-visibility-private", "host-continue"]) {
      const node = at(testId);
      node.focus();
      pressEscape(node);
      expect(dialogs()).toBe(0);
      openWithPointer();
    }
    pressEscape();
    expect(dialogs()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 5 -- once, and only once                                            */
/* ------------------------------------------------------------------ */

describe("one keypress is one close", () => {
  it("calls the close operation exactly once", () => {
    openWithPointer();
    pressEscape();
    expect(closes).toBe(1);
  });

  it("does not stack closes when the key repeats after the card has gone", () => {
    openWithPointer();
    pressEscape();
    pressEscape();
    pressEscape();
    expect(closes).toBe(1);
    expect(dialogs()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 3, 10, 11 -- focus returns to the opener                            */
/* ------------------------------------------------------------------ */

describe("focus goes back to the control that opened the card", () => {
  it("returns focus to the opener when Escape is pressed from inside the card", () => {
    /* THE CASE THE MEASUREMENT DEMANDED. Before this change, closing through the x or Cancel left
       `document.activeElement` on `<body>`, because the button pressed was unmounted with the card. */
    openWithPointer();
    at("host-type-plus").focus();
    expect(document.activeElement).toBe(at("host-type-plus"));
    pressEscape();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("returns focus to the opener through the x and through Cancel as well", () => {
    /* ONE MECHANISM FOR EVERY CLOSE PATH, which is the reason this lives in an unmount cleanup rather than in
       the Escape handler: a fix that only covered Escape would have left the reported defect on the two
       controls a player can actually see. */
    for (const selector of ['dialog[data-native-modal] button[aria-label="Close"]', 'dialog[data-native-modal] button']) {
      openWithPointer();
      const control = selector.endsWith("button[aria-label=\"Close\"]")
        ? maybe(selector)
        : Array.from(document.querySelectorAll<HTMLElement>('dialog[data-native-modal] button')).find(
            (node) => node.textContent?.trim() === "Cancel",
          ) ?? null;
      expect(control).not.toBeNull();
      control!.focus();
      act(() => {
        control!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(dialogs()).toBe(0);
      expect(document.activeElement).toBe(at("opener"));
    }
  });

  it("never falls back to the body", () => {
    openWithPointer();
    at("host-continue").focus();
    pressEscape();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(document.documentElement);
  });

  it("leaves a pointer round trip with focus exactly where it started", () => {
    /* CASE 10, in the terms jsdom can actually see. A ring appears because focus MOVES somewhere new; if the
       opener held focus before the card and holds it after, there is no new focus for `:focus-visible` to
       attach to and nothing for the engine to decide. The ring itself is measured in Chromium. */
    at("opener").focus();
    const before = document.activeElement;
    openWithPointer();
    pressEscape();
    expect(document.activeElement).toBe(before);
  });

  it("leaves a keyboard round trip with focus on the opener too", () => {
    /* CASE 11's target half. The engine keeps the ring because the element it was on is the element it is
       returned to; this asserts the second half of that sentence. */
    openWithKeyboard();
    at("host-visibility-private").focus();
    pressEscape();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("does not remember an opener from a previous cycle", () => {
    /* Open from one control, close, then open from another: the second close must return to the SECOND
       opener. A captured ref that outlived its card would fail here. */
    at("bystander").focus();
    act(() => {
      at("opener").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    pressEscape();
    expect(document.activeElement).toBe(at("bystander"));

    openWithPointer();
    pressEscape();
    expect(document.activeElement).toBe(at("opener"));
  });
});

/* ------------------------------------------------------------------ */
/* 4 -- the reopened card is the same card                             */
/* ------------------------------------------------------------------ */

describe("closing with Escape resets exactly what the visible controls reset", () => {
  it("reopens in the same state after Escape as after Cancel", () => {
    const reopenAfter = (close: () => void) => {
      openWithPointer();
      act(() => {
        at("host-type-plus").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        at("host-pace-async").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      toRules();
      close();
      openWithPointer();
      return snapshot();
    };
    const afterCancel = reopenAfter(() => {
      const cancel = Array.from(document.querySelectorAll<HTMLElement>('dialog[data-native-modal] button')).find(
        (node) => node.textContent?.trim() === "Back",
      );
      // step two has no Cancel; the x is its close, and Cancel is reached by stepping back first
      act(() => cancel!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
      const realCancel = Array.from(document.querySelectorAll<HTMLElement>('dialog[data-native-modal] button')).find(
        (node) => node.textContent?.trim() === "Cancel",
      );
      act(() => realCancel!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    });
    act(() => root!.render(<Harness />));
    const afterEscape = reopenAfter(() => pressEscape());
    expect(afterEscape).toEqual(afterCancel);
    expect(afterEscape.step).toBe("type");
  });

  it("reopens at step one with the defaults, whichever way it was closed", () => {
    /* THE RESET IS THE UNMOUNT, which is why there is no reset code to keep in step: `Lobby` renders
       `{hostSetup && <HostSetupCard/>}`, so every close destroys the component and its state with it. */
    for (const close of [() => pressEscape(), () => act(() => maybe('dialog[data-native-modal] button[aria-label="Close"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))]) {
      openWithPointer();
      act(() => at("host-type-levelPlayingField").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
      toRules();
      close();
      openWithPointer();
      expect(snapshot()).toEqual({
        step: "type",
        checked: ["standard", "live", "public"],
        heading: "Host a game",
      });
      pressEscape();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 7, 8 -- nothing listens while the card is closed                    */
/* ------------------------------------------------------------------ */

describe("the listener exists only while the card does", () => {
  it("does nothing when Escape is pressed with the card closed", () => {
    expect(dialogs()).toBe(0);
    pressEscape(at("opener"));
    expect(closes).toBe(0);
    expect(dialogs()).toBe(0);
  });

  it("adds no window keydown listener at all, through ten open/close cycles", () => {
    /* #1651 SUPERSEDES "nets to zero". The ledger used to swing 0 -> 1 -> 0 per cycle, because the card
       installed a `window` Escape listener while it was up. There is no such listener now: Escape is the
       `closedby` attribute and the engine enforces it, so the only honest assertion is that the ledger never
       moves at all. This is STRICTER than what it replaces -- a leaked listener still fails it, and so now
       does a second Escape path being reintroduced. */
    expect(keydownListeners).toBe(0);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      openWithPointer();
      expect(keydownListeners).toBe(0);
      pressEscape();
      expect(keydownListeners).toBe(0);
    }
    expect(closes).toBe(10);
  });

  it("keeps the ledger at zero when the card is closed by the x, repeatedly", () => {
    for (let cycle = 0; cycle < 5; cycle += 1) {
      openWithPointer();
      act(() => maybe('dialog[data-native-modal] button[aria-label="Close"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
      expect(keydownListeners).toBe(0);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 9 -- the innermost surface gets first refusal                       */
/* ------------------------------------------------------------------ */

describe("a nested transient surface takes Escape before the card does", () => {
  /* THERE IS NO SUCH SURFACE IN THIS DIALOG TODAY -- step one is three game cards, Pace and Visibility; step
     two is the ante, the player count and the house rules. These cases test the MECHANISM, by standing a
     surface inside the card that behaves the way a nested confirmation or menu would. */

  it("stands down when an inner surface has already handled the key", () => {
    openWithPointer();
    const inner = at("host-type-plus");
    const innerHandler = (event: Event) => event.preventDefault();
    inner.addEventListener("keydown", innerHandler);
    pressEscape(inner);
    inner.removeEventListener("keydown", innerHandler);
    expect(dialogs()).toBe(1);
    expect(closes).toBe(0);
  });

  it("is refused by preventDefault and NOT by stopPropagation, which is the platform's contract", () => {
    /* #1651 SUPERSEDES "stands down when an inner surface stops the key travelling". While Escape was a
       `window` listener, `stopPropagation()` refused it too -- `window` was on the propagation path. The
       close request is not a listener, so it is not on anyone's path. Measured in Chromium 141 on a modal
       dialog with `closedby="closerequest"`:

         preventDefault()            -> dialog stays open, no `cancel`, no `close`
         stopPropagation()           -> dialog CLOSES
         stopImmediatePropagation()  -> dialog CLOSES

       The narrower contract is the right one and nothing in this app relies on the wider one: the audit found
       no nested transient surface inside any dialog. The case now asserts the boundary rather than pretending
       the old one survived. */
    openWithPointer();
    const inner = at("host-pace-async");
    const stopper = (event: Event) => event.stopPropagation();
    inner.addEventListener("keydown", stopper);
    pressEscape(inner);
    inner.removeEventListener("keydown", stopper);
    expect(dialogs()).toBe(0);
    expect(closes).toBe(1);
  });

  it("closes on the NEXT Escape, once the inner surface has gone", () => {
    /* ONE KEYPRESS, ONE LAYER -- and the layer below is still reachable afterwards, which is the other half
       of the rule and the half a `stopImmediatePropagation` everywhere would have broken. */
    openWithPointer();
    const inner = at("host-type-plus");
    const innerHandler = (event: Event) => event.preventDefault();
    inner.addEventListener("keydown", innerHandler);
    pressEscape(inner);
    expect(dialogs()).toBe(1);
    inner.removeEventListener("keydown", innerHandler);
    pressEscape(inner);
    expect(dialogs()).toBe(0);
    expect(closes).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 6 -- the controls inside are untouched                              */
/* ------------------------------------------------------------------ */

describe("the card's own keyboard behaviour is unchanged", () => {
  const ARROW_GROUPS: ReadonlyArray<[string, string, string]> = [
    ["host-type-standard", "host-type-plus", "standard"],
    ["host-pace-live", "host-pace-async", "live"],
    ["host-visibility-public", "host-visibility-private", "public"],
  ];

  it("still moves selection and focus together on an arrow key, in all three groups", () => {
    /* THE RISK THIS CASE EXISTS FOR: a `window` keydown listener that swallowed or pre-empted keys would take
       the arrows out of the radio groups, and #1448's whole point is that focus and selection move together. */
    openWithPointer();
    for (const [first, second] of ARROW_GROUPS) {
      at(first).focus();
      act(() => {
        at(first).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      });
      expect(at(second).getAttribute("aria-checked")).toBe("true");
      expect(document.activeElement).toBe(at(second));
      expect(dialogs()).toBe(1);
    }
  });

  it("leaves the roving Tab stop on the selected option", () => {
    openWithPointer();
    for (const [first, second] of ARROW_GROUPS) {
      at(first).focus();
      act(() => {
        at(first).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      });
      expect(at(second).tabIndex).toBe(0);
      expect(at(first).tabIndex).toBe(-1);
    }
  });

  it("does not cancel the keys it does not handle", () => {
    /* The listener reads Escape and returns for everything else -- so typing, arrows and Tab reach the
       controls with their default behaviour intact. Asserted on the event rather than on the outcome. */
    openWithPointer();
    for (const key of ["ArrowRight", "Tab", "Enter", " ", "a", "1"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      act(() => {
        at("host-type-standard").dispatchEvent(event);
      });
      if (key !== "ArrowRight") expect(event.defaultPrevented).toBe(false);
      expect(dialogs()).toBe(1);
    }
  });

  it("does not cancel the Escape event itself, so nothing downstream is starved", () => {
    /* #1651: the card touches the key even less than it did -- no listener of its own sees it at all. What is
       asserted is unchanged: whatever else is listening for Escape on this page still receives an event that
       nothing has cancelled. The CLOSE that follows is the engine's, and `pressEscape` delivers it
       everywhere else in this file. */
    openWithPointer();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      at("host-type-standard").dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(dialogs()).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* The busy rule, taken from the controls rather than invented         */
/* ------------------------------------------------------------------ */

describe("Escape follows the same availability rule as the visible controls", () => {
  it("does not close while the room is being opened", () => {
    /* The x is `disabled={busy}` and the backdrop click is `busy ? undefined : onClose`, so while a room is
       being created the authoritative close is not offered. Escape must not be a way around that. */
    unmount();
    mount(true);
    openWithPointer();
    expect(dialogs()).toBe(1);
    expect(maybe('dialog[data-native-modal] button[aria-label="Close"]')?.hasAttribute("disabled")).toBe(true);
    pressEscape();
    expect(dialogs()).toBe(1);
    expect(closes).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 1, 2, 3 -- where focus goes when the card opens (#1630)             */
/* ------------------------------------------------------------------ */

describe("opening the card moves focus into it", () => {
  it("focuses the selected Game radio on a keyboard open", () => {
    /* THE FIRST MEANINGFUL DECISION on the step, and already the group's single Tab stop (#1448), so this
       creates no new stop -- it puts the keyboard where the roving group already says it belongs. */
    openWithKeyboard();
    expect(focusName()).toBe("standard");
    expect(document.activeElement).toBe(at("host-type-standard"));
  });

  it("focuses the same control on a pointer open", () => {
    /* CASE 2's target half. Whether a RING appears is the engine's judgement about modality and cannot be
       seen from jsdom; it is measured in Chromium, both ways round, and recorded in the design note. What is
       asserted here is that a pointer open lands focus in the same place a keyboard open does -- inside the
       card -- because a modal that leaves focus outside itself is the defect being fixed. */
    openWithPointer();
    expect(document.activeElement).toBe(at("host-type-standard"));
    expect(card().contains(document.activeElement)).toBe(true);
  });

  it("focuses the selected option rather than the first one", () => {
    /* "Selected", not "first": the two coincide at the defaults, so a case that only opened fresh would pass
       for the wrong reason. This one changes the answer first. */
    openWithPointer();
    act(() => at("host-type-levelPlayingField").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    pressEscape();
    openWithPointer();
    // A reopened card is a fresh one, so the default is back -- and that is what gets focus.
    expect(focusName()).toBe("standard");
  });

  it("leaves exactly one Tab stop in the Game group, and it is the focused one", () => {
    openWithPointer();
    const stops = Array.from(card().querySelectorAll<HTMLElement>('[role="radio"][data-radio-key]'))
      .filter((node) => node.tabIndex === 0 && node.closest('[aria-label="Game"]'));
    expect(stops.map((node) => node.getAttribute("data-radio-key"))).toEqual(["standard"]);
    expect(document.activeElement).toBe(stops[0]);
  });

  it("does not focus the card, the heading or the close button to get started", () => {
    openWithPointer();
    const active = document.activeElement;
    expect(active).not.toBe(card());
    expect((active as HTMLElement).getAttribute("role")).toBe("radio");
  });
});

/* ------------------------------------------------------------------ */
/* 4, 7, 15 -- Tab stays inside, and wraps                             */
/* ------------------------------------------------------------------ */

describe("Tab is contained by the card", () => {
  const ENDS = (): { first: string; last: string } => {
    const stops = tabStops();
    return { first: nameOf(stops[0]), last: nameOf(stops[stops.length - 1]) };
  };

  it("reaches nothing outside the card", () => {
    /* CASE 15. The lobby controls are still in the document and still enabled -- nothing out there was
       altered -- they are simply not in the set Tab can reach from inside. */
    openWithPointer();
    for (const node of tabStops()) expect(card().contains(node)).toBe(true);
    expect(tabStops()).not.toContain(at("opener"));
    expect(tabStops()).not.toContain(at("bystander"));
  });

  it("wraps from the last control to the first, on step one", () => {
    openWithPointer();
    const { first, last } = ENDS();
    const stops = tabStops();
    stops[stops.length - 1].focus();
    expect(focusName()).toBe(last);
    tab();
    expect(focusName()).toBe(first);
    expect(card().contains(document.activeElement)).toBe(true);
  });

  it("wraps from the first control back to the last, on step one", () => {
    openWithPointer();
    const { first, last } = ENDS();
    const stops = tabStops();
    stops[0].focus();
    expect(focusName()).toBe(first);
    tab(true);
    expect(focusName()).toBe(last);
  });

  it("wraps at both ends on step two as well", () => {
    openWithPointer();
    toRules();
    const stops = tabStops();
    const first = stops[0];
    const last = stops[stops.length - 1];
    last.focus();
    tab();
    expect(document.activeElement).toBe(first);
    first.focus();
    tab(true);
    expect(document.activeElement).toBe(last);
    expect(card().contains(document.activeElement)).toBe(true);
  });

  it("recomputes the ends when the step changes", () => {
    /* The set is computed at the keypress, not cached -- so stepping forward changes what "last" means with
       no subscription to the step. Asserted as a DIFFERENCE, because two identical lists would make the
       wrap cases above pass without proving anything about the recomputation. */
    openWithPointer();
    const step1 = tabStops().map(nameOf);
    toRules();
    const step2 = tabStops().map(nameOf);
    expect(step1).not.toEqual(step2);
    expect(step1).toContain("host-continue");
    expect(step2).toContain("host-create-room");
    expect(step2).not.toContain("host-continue");
  });

  it("recomputes the ends when busy changes", () => {
    /* `busy` disables the close button, which removes it from the set -- and it is the FIRST stop, so the
       wrap target changes with it. */
    unmount();
    mount(true);
    openWithPointer();
    const names = tabStops().map(nameOf);
    expect(names).not.toContain("Close");
    expect(maybe('dialog[data-native-modal] button[aria-label="Close"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("pulls focus back in if it is somehow outside when Tab arrives", () => {
    /* The safety net, and the reason a dead-space click cannot strand the keyboard: the card is focusable at
       `tabIndex={-1}`, so such a click lands there rather than on `<body>`, and the next Tab goes inward. */
    openWithPointer();
    card().focus();
    expect(focusName()).toBe("<card>");
    tab();
    expect(card().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(tabStops()[0]);
  });

  it("leaves keys that are not Tab alone", () => {
    openWithPointer();
    for (const key of ["ArrowRight", "Enter", " ", "a"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      act(() => at("host-type-standard").dispatchEvent(event));
      if (key !== "ArrowRight") expect(event.defaultPrevented).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5, 6, 8, 9 -- the step change is a navigation                       */
/* ------------------------------------------------------------------ */

describe("changing step takes focus with it", () => {
  it("moves focus to the step-two heading on Continue", () => {
    openWithPointer();
    at("host-continue").focus();
    toRules();
    expect(onStep()).toBe("rules");
    expect(focusName()).toBe("heading:House rules");
    expect(card().contains(document.activeElement)).toBe(true);
  });

  it("never leaves focus on the body across the forward transition", () => {
    /* THE MEASURED DEFECT: Continue unmounted the button holding focus, and `document.activeElement` became
       `<body>`. A layout effect places the new target before the browser paints, so there is no frame with
       the dialog up and focus outside it. */
    openWithPointer();
    at("host-continue").focus();
    toRules();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(document.documentElement);
  });

  it("returns focus to the selected Game radio on Back", () => {
    openWithPointer();
    toRules();
    backToType();
    expect(onStep()).toBe("type");
    expect(document.activeElement).toBe(at("host-type-standard"));
  });

  it("returns focus to the option actually selected, not to the first one", () => {
    openWithPointer();
    act(() => at("host-type-plus").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    toRules();
    backToType();
    expect(focusName()).toBe("plus");
    expect(at("host-type-plus").getAttribute("aria-checked")).toBe("true");
  });

  it("never leaves focus on the body across the reverse transition", () => {
    openWithPointer();
    toRules();
    at("host-create-room").focus();
    backToType();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("keeps every selection across a forward and back round trip", () => {
    /* CASE 9. Moving focus must not be moving state: the three answers chosen on step one are still the
       answers after stepping forward and back. */
    openWithPointer();
    act(() => {
      at("host-type-plus").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      at("host-pace-async").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      at("host-visibility-private").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const chosen = snapshot().checked;
    toRules();
    backToType();
    expect(snapshot().checked).toEqual(chosen);
    expect(chosen).toEqual(["plus", "async", "private"]);
  });

  it("survives repeated forward/back cycles with focus still inside and the listener ledger at zero", () => {
    openWithPointer();
    for (let cycle = 0; cycle < 6; cycle += 1) {
      toRules();
      expect(card().contains(document.activeElement)).toBe(true);
      backToType();
      expect(document.activeElement).toBe(at("host-type-standard"));
    }
    /* #1651: zero throughout -- see the ledger case above. */
    expect(keydownListeners).toBe(0);
    pressEscape();
    expect(keydownListeners).toBe(0);
    expect(document.activeElement).toBe(at("opener"));
  });
});

/* ------------------------------------------------------------------ */
/* 11, 12 -- the remaining close routes, and the busy rule             */
/* ------------------------------------------------------------------ */

describe("every close route behaves the same", () => {
  /* #1651: the backdrop and the dialog are the same element now -- the scrim IS the `<dialog>`, and a click
     on it is what `onScrimClick` answers. */
  const backdrop = dialogEl;

  it("closes on a backdrop click and restores the opener", () => {
    openWithPointer();
    at("host-pace-async").focus();
    act(() => backdrop().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(dialogs()).toBe(0);
    expect(document.activeElement).toBe(at("opener"));
  });

  it("blocks Escape, the close button and the backdrop alike while busy", () => {
    /* CASE 12. The x is `disabled={busy}` and the backdrop handler is `busy ? undefined : onClose`; Escape is
       gated on the same flag, so the three agree instead of two agreeing and one not. */
    unmount();
    mount(true);
    openWithPointer();
    pressEscape();
    expect(dialogs()).toBe(1);
    act(() => maybe('dialog[data-native-modal] button[aria-label="Close"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(dialogs()).toBe(1);
    act(() => backdrop().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(dialogs()).toBe(1);
    expect(closes).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* The dialog's own semantics                                          */
/* ------------------------------------------------------------------ */

describe("the dialog says what it is", () => {
  it("is exactly ONE dialog, and it is the element, named for the thing the player opened", () => {
    /* #1652 SUPERSEDES the three assertions that stood here (`role`, `aria-modal` and the name, all read off
       the CARD). Measured with `Accessibility.getFullAXTree` on the real Lobby under #1650, the wrapper and
       the card were BOTH dialog nodes -- Chromium ignores `role="presentation"` on a `<dialog>`, whose
       implicit role is `dialog` and which permits only `alertdialog` instead. The element is the dialog now:
       it carries the name, it needs no `aria-modal` because `showModal()` makes it modal, and the card is an
       ordinary `<div>`. Re-measured after the correction: one node, `role=dialog name="Host a game"
       modal=true`. What this asserts is the shape that produced it. */
    openWithPointer();
    expect(dialogEl().tagName).toBe("DIALOG");
    expect(dialogEl().getAttribute("aria-label")).toBe("Host a game");
    expect(dialogEl().getAttribute("role")).toBeNull();
    expect(document.querySelectorAll("dialog[data-native-modal]")).toHaveLength(1);
    expect(dialogEl().querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal]')).toHaveLength(0);
    expect(card().getAttribute("role")).toBeNull();
    expect(card().getAttribute("aria-modal")).toBeNull();
  });

  it("keeps that name on step two, where it used to change", () => {
    /* #1630: the name followed the step, so on the house-rules step the dialog announced itself as a
       different dialog from the one the player opened. The STEP is the heading's job. */
    openWithPointer();
    toRules();
    expect(dialogEl().getAttribute("aria-label")).toBe("Host a game");
    expect(maybe('[role="heading"]')?.textContent?.trim()).toBe("House rules");
  });

  it("carries one heading per step, at one level, and no description it does not have", () => {
    openWithPointer();
    expect(Array.from(card().querySelectorAll('[role="heading"]')).length).toBe(1);
    expect(maybe('[role="heading"]')?.getAttribute("aria-level")).toBe("2");
    expect(card().hasAttribute("aria-describedby")).toBe(false);
    expect(card().hasAttribute("aria-live")).toBe(false);
  });
});
