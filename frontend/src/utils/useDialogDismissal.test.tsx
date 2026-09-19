/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1641 (harness): THE BOUNDARY, BEFORE ANYTHING IS MOVED ONTO IT
// ==================================================================
//
// `useDialogDismissal` is an extraction: every line of it ran inside `HostSetupCard` under #1629 and #1630,
// and that dialog's fifty cases in `components/hostDialogEscape.test.tsx` are unchanged and still pass. Those
// cases prove the behaviour THROUGH Host Game. This file proves it AT the hook, which is a different and now
// necessary thing -- the audit's migration order has twenty other surfaces arriving here, and a contract that
// is only ever exercised through its first consumer is a contract nobody can move onto safely.
//
// SO THESE CASES DELIBERATELY DO NOT MOUNT HOST GAME. They mount the smallest dialog that can hold the hook:
// an opener, a bystander, and a card with one button in it. What is asserted is the hook's own promises --
// which callback runs, when it refuses, what the listener ledger does, and where focus goes when the card
// leaves -- with nothing of Host Game's around them to make a passing case ambiguous.
//
// TWO MEASURED FACTS THIS FILE LEANS ON:
//   - jsdom 16.7 DOES focus an `<svg tabindex="0">` and reports it as `document.activeElement`, giving a real
//     `Element` that is not an `HTMLElement` -- so the first restore guard is exercised by an actual focus
//     rather than by standing a fake in for `document.activeElement`.
//   - jsdom does not traverse Tab, so nothing here claims anything about tab ORDER. The hook does not contain
//     focus and must not; containment stayed in Host Game (see the hook's note).

import { act, useEffect, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useDialogDismissal } from "./useDialogDismissal";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/** Which render's callback ran, once per dismissal. A stale closure shows up here as a stale number rather
 *  than as a count that happens to be right. */
let calls: number[] = [];
/** Every `keydown` listener added to `window`, minus every one removed. */
let keydownListeners = 0;
/** Adds only -- the ledger above nets out a reinstall, and a reinstall is exactly what one case is about. */
let keydownAdds = 0;
let addSpy: jest.SpyInstance;
let removeSpy: jest.SpyInstance;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

type Control = {
  setOpen: (open: boolean) => void;
  setGeneration: (generation: number) => void;
  setDismissible: (dismissible: boolean | undefined) => void;
};
let ctl: Control = { setOpen: () => {}, setGeneration: () => {}, setDismissible: () => {} };

/** The smallest surface that can carry the hook. `onDismiss` is a NEW arrow on every render, the way a real
 *  consumer's is (`Lobby` passes `() => setHostSetup(false)`), and it records the generation it was created
 *  in so a stale one is identifiable rather than merely miscounted. */
function Dialog({
  generation,
  dismissible,
  focusInsideOnMount = "none",
}: {
  generation: number;
  dismissible: boolean | undefined;
  focusInsideOnMount?: FocusMode;
}) {
  useDialogDismissal({
    onDismiss: () => {
      calls.push(generation);
    },
    dismissible,
  });

  /* Declared AFTER the hook call, which is where a consumer's initial focus belongs. BOTH PHASES ARE
     OFFERED because the hook's guarantee has to hold for both: Host Game focuses in a passive effect, the two
     lobby cards migrated in batch 1 focus in a layout effect, and a layout effect runs FIRST. */
  const focusInside = () => document.querySelector<HTMLElement>('[data-testid="inside"]')?.focus();
  useLayoutEffect(() => {
    if (focusInsideOnMount === "layout") focusInside();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (focusInsideOnMount === "passive") focusInside();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div role="dialog" aria-modal="true" aria-label="Probe">
      <button type="button" data-testid="inside">
        Inside
      </button>
    </div>
  );
}

type FocusMode = "none" | "layout" | "passive";

function Harness({ focusInsideOnMount = "none" }: { focusInsideOnMount?: FocusMode }) {
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [dismissible, setDismissible] = useState<boolean | undefined>(undefined);
  ctl = { setOpen, setGeneration, setDismissible };
  return (
    <>
      <button type="button" data-testid="opener">
        Open
      </button>
      <button type="button" data-testid="bystander">
        Bystander
      </button>
      {open && (
        <Dialog generation={generation} dismissible={dismissible} focusInsideOnMount={focusInsideOnMount} />
      )}
    </>
  );
}

function mount(focusInsideOnMount: FocusMode = "none") {
  calls = [];
  keydownListeners = 0;
  keydownAdds = 0;
  addSpy = jest.spyOn(window, "addEventListener").mockImplementation(function (this: Window, ...args: never[]) {
    if (args[0] === ("keydown" as never)) {
      keydownListeners += 1;
      keydownAdds += 1;
    }
    return (Window.prototype.addEventListener as never as (...a: never[]) => void).apply(this, args);
  } as never);
  removeSpy = jest
    .spyOn(window, "removeEventListener")
    .mockImplementation(function (this: Window, ...args: never[]) {
      if (args[0] === ("keydown" as never)) keydownListeners -= 1;
      return (Window.prototype.removeEventListener as never as (...a: never[]) => void).apply(this, args);
    } as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<Harness focusInsideOnMount={focusInsideOnMount} />);
  });
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  addSpy?.mockRestore();
  removeSpy?.mockRestore();
  document.body.innerHTML = "";
}

const at = (testid: string) => {
  const node = document.querySelector<HTMLElement>('[data-testid="' + testid + '"]');
  if (!node) throw new Error("no " + testid);
  return node;
};
const maybe = (selector: string) => document.querySelector<HTMLElement>(selector);
const dialogs = () => document.querySelectorAll('[role="dialog"]').length;

const open = () => act(() => ctl.setOpen(true));
const close = () => act(() => ctl.setOpen(false));

/** Dispatched from wherever focus actually is, so the event travels the real propagation path up to `window`
 *  rather than being handed straight to the listener under test. */
function press(key: string, target: EventTarget = document.activeElement ?? window) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}
const escape = (target?: EventTarget) => press("Escape", target);

beforeEach(() => mount());
afterEach(() => unmount());

/* ------------------------------------------------------------------ */
/* Escape reaches the callback                                         */
/* ------------------------------------------------------------------ */

describe("Escape dismisses through the callback it was given", () => {
  it("calls the dismissal", () => {
    open();
    expect(dialogs()).toBe(1);
    escape();
    expect(calls).toEqual([0]);
  });

  it("calls it once per keypress, and not at all before the dialog is up", () => {
    escape();
    expect(calls).toEqual([]);
    open();
    escape();
    escape();
    expect(calls).toEqual([0, 0]);
  });

  it("hears the key from anywhere, including from inside the dialog and from the body", () => {
    open();
    at("inside").focus();
    escape();
    at("bystander").focus();
    escape();
    document.body.focus();
    escape(document.body);
    expect(calls).toEqual([0, 0, 0]);
  });

  it("cancels nothing -- not even the key it acts on", () => {
    /* The hook never calls `preventDefault`. A dialog closing must not also swallow the keypress from
       whatever else is listening, and a future nested surface's own first-refusal check depends on this
       staying true. */
    open();
    expect(escape().defaultPrevented).toBe(false);
    expect(press("Enter").defaultPrevented).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Keys it must ignore                                                 */
/* ------------------------------------------------------------------ */

describe("every other key is none of its business", () => {
  it("ignores keys that are not Escape, including the spellings that are not the standard one", () => {
    open();
    ["Enter", " ", "Tab", "ArrowDown", "a", "Esc", "escape", "ESCAPE"].forEach((key) => press(key));
    expect(calls).toEqual([]);
    escape();
    expect(calls).toEqual([0]);
  });
});

/* ------------------------------------------------------------------ */
/* First refusal to the innermost surface                              */
/* ------------------------------------------------------------------ */

describe("an inner surface that owns the key gets first refusal", () => {
  it("stands down when the event arrives already handled", () => {
    open();
    const inner = at("inside");
    inner.addEventListener("keydown", (event) => event.preventDefault());
    escape(inner);
    expect(calls).toEqual([]);
  });

  it("never sees the key at all when an inner surface stops propagation", () => {
    /* `window` is on the propagation path, so this is the other half of the same guarantee and needs no code
       in the hook. Asserted because it is the thing #1629 relied on. */
    open();
    const inner = at("inside");
    inner.addEventListener("keydown", (event) => event.stopPropagation());
    escape(inner);
    expect(calls).toEqual([]);
  });

  it("is still live on the next keypress, so the layer below is reachable once the inner one is gone", () => {
    open();
    const inner = at("inside");
    const swallow = (event: KeyboardEvent) => event.preventDefault();
    inner.addEventListener("keydown", swallow);
    escape(inner);
    expect(calls).toEqual([]);
    inner.removeEventListener("keydown", swallow);
    escape(inner);
    expect(calls).toEqual([0]);
  });
});

/* ------------------------------------------------------------------ */
/* The dismissible gate                                                */
/* ------------------------------------------------------------------ */

describe("the gate agrees with whatever rule the visible controls enforce", () => {
  it("refuses while it is not dismissible", () => {
    act(() => ctl.setDismissible(false));
    open();
    escape();
    expect(calls).toEqual([]);
    expect(dialogs()).toBe(1);
  });

  it("is dismissible when the flag is left out", () => {
    open();
    escape();
    expect(calls).toEqual([0]);
  });

  it("starts refusing the moment the flag goes false, and resumes when it comes back", () => {
    /* READ AT KEYPRESS TIME, not captured when the listener was installed -- so a dialog that becomes busy
       while it is up refuses immediately, with no remount and no reinstall. The ledger proves the listener is
       the same one throughout. */
    open();
    escape();
    expect(calls).toEqual([0]);
    act(() => ctl.setDismissible(false));
    escape();
    escape();
    expect(calls).toEqual([0]);
    act(() => ctl.setDismissible(true));
    escape();
    expect(calls).toEqual([0, 0]);
    expect(keydownListeners).toBe(1);
    expect(keydownAdds).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* The current callback, never a stale one                             */
/* ------------------------------------------------------------------ */

describe("it calls the callback from the current render", () => {
  it("does not call the one the listener was installed with", () => {
    open();
    escape();
    expect(calls).toEqual([0]);
    [1, 2, 3].forEach((generation) => act(() => ctl.setGeneration(generation)));
    escape();
    expect(calls).toEqual([0, 3]);
  });

  it("does not reinstall the listener when the callback identity changes every render", () => {
    /* `onDismiss` is a new arrow on every render here, as it is in `Lobby`. Before the extraction the effect
       carried `[busy, onClose]` and tore the listener down and put it back on every one of those renders;
       this asserts the churn is gone, which is the only internal thing the extraction changed. */
    open();
    expect(keydownAdds).toBe(1);
    for (let generation = 1; generation <= 8; generation += 1) act(() => ctl.setGeneration(generation));
    expect(keydownAdds).toBe(1);
    expect(keydownListeners).toBe(1);
    escape();
    expect(calls).toEqual([8]);
  });
});

/* ------------------------------------------------------------------ */
/* The listener ledger                                                 */
/* ------------------------------------------------------------------ */

describe("the listener is balanced", () => {
  it("nets to zero across repeated mount/unmount cycles", () => {
    expect(keydownListeners).toBe(0);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      open();
      expect(keydownListeners).toBe(1);
      close();
      expect(keydownListeners).toBe(0);
    }
  });

  it("leaves nothing behind when the whole tree unmounts with the dialog open", () => {
    open();
    expect(keydownListeners).toBe(1);
    act(() => root!.unmount());
    expect(keydownListeners).toBe(0);
  });

  it("is deaf after the dialog is gone", () => {
    open();
    close();
    escape();
    expect(calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Opener restoration                                                  */
/* ------------------------------------------------------------------ */

describe("focus goes back where it came from", () => {
  it("restores the element that was focused when the dialog mounted", () => {
    at("opener").focus();
    open();
    at("inside").focus();
    close();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("restores on unmount, so it covers every close route rather than one of them", () => {
    /* The restore lives in the effect cleanup, not in the Escape path. Whatever removed the dialog -- a key,
       a button, a backdrop, a parent that re-rendered without it -- reaches the same line. */
    at("opener").focus();
    open();
    at("inside").focus();
    escape();
    expect(calls).toEqual([0]);
    expect(document.activeElement).toBe(at("inside"));
    close();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("captures the opener before a consumer's PASSIVE initial-focus effect", () => {
    /* THE ORDERING HOST GAME DEPENDS ON. Its initial focus is a separate effect declared after the hook call;
       if the hook captured second it would record the control it had just focused INSIDE the dialog, and the
       restore would then aim at a node that no longer exists. */
    unmount();
    mount("passive");
    at("opener").focus();
    open();
    expect(document.activeElement).toBe(at("inside"));
    close();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("captures the opener before a consumer's LAYOUT initial-focus effect", () => {
    /* THE ORDERING BATCH 1 DEPENDS ON, and the stronger of the two: a layout effect runs before every passive
       effect in the tree, so a passive capture would lose to it. The capture is a layout effect for exactly
       this, and being declared first is what keeps it ahead of the consumer's. */
    unmount();
    mount("layout");
    at("opener").focus();
    open();
    expect(document.activeElement).toBe(at("inside"));
    close();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("restores after React has finished restoring its own saved selection", () => {
    /* MEASURED, and it is why the restore is a passive cleanup rather than a layout one. A layout cleanup runs
       during the mutation phase; React's `restoreSelection` runs after it and puts focus back on whatever held
       it before the commit. Instrumented with the restore in the layout cleanup, it fired, activeElement
       became the opener, and focus was back on the bystander by the end of the commit. This case is that
       sequence: focus sits on a control OUTSIDE the dialog when the dialog goes, so React has a saved
       selection to restore, and the hook must still win. */
    at("opener").focus();
    open();
    at("bystander").focus();
    close();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("does not remember an opener from a previous cycle", () => {
    at("opener").focus();
    open();
    close();
    expect(document.activeElement).toBe(at("opener"));
    at("bystander").focus();
    open();
    at("inside").focus();
    close();
    expect(document.activeElement).toBe(at("bystander"));
  });
});

/* ------------------------------------------------------------------ */
/* The three guards on the restore                                     */
/* ------------------------------------------------------------------ */

describe("it refuses to restore to something that is not worth restoring to", () => {
  /* TWO ASSERTIONS PER CASE, AND THE SECOND IS THE ONE THAT DISCRIMINATES HERE.
     Focus is moved to a real, connected control while the dialog is up, so that a guard failing would take
     focus AWAY from something -- without the bystander, "focus ends on the body" is indistinguishable from
     the dialog simply unmounting. In a browser that is the whole story: `document.body.focus()` and
     `detached.focus()` both land focus on `<body>`, which is the defect.
     BUT JSDOM MAKES `focus()` A NO-OP on a node that is not focusable or not in the document, so the bystander
     would keep focus even from a hook with no guards at all -- measured: removing the `<body>`/root and
     `isConnected` guards failed only the document-element case. So each case ALSO spies on the refused
     opener's own `focus` and asserts the restore never called it. That is the guard's actual promise: it does
     not attempt the focus that a browser would then resolve to `<body>`. */

  it("refuses the body", () => {
    expect(document.activeElement).toBe(document.body);
    const attempt = jest.spyOn(document.body, "focus");
    open();
    at("bystander").focus();
    close();
    expect(attempt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(at("bystander"));
    attempt.mockRestore();
  });

  it("refuses the document element", () => {
    document.documentElement.tabIndex = -1;
    document.documentElement.focus();
    expect(document.activeElement).toBe(document.documentElement);
    const attempt = jest.spyOn(document.documentElement, "focus");
    open();
    at("bystander").focus();
    close();
    expect(attempt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(at("bystander"));
    attempt.mockRestore();
    document.documentElement.removeAttribute("tabindex");
  });

  it("refuses an opener that has left the document", () => {
    /* The real shape of this: a close that replaces the screen. Focusing a detached node silently sends focus
       to `<body>` in every engine, which is the defect the guard exists to avoid reproducing. */
    const transient = document.createElement("button");
    transient.setAttribute("data-testid", "transient");
    document.body.appendChild(transient);
    transient.focus();
    expect(document.activeElement).toBe(transient);
    const attempt = jest.spyOn(transient, "focus");
    open();
    transient.remove();
    at("bystander").focus();
    close();
    expect(attempt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(at("bystander"));
  });

  it("refuses an opener that is an Element but not an HTMLElement", () => {
    /* Measured: jsdom 16.7 focuses an `<svg tabindex="0">` and reports it as `document.activeElement`, so
       this is a real focus rather than a stand-in. `document.activeElement` is typed `Element | null`, and
       `.focus()` is an `HTMLElement` method. */
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("tabindex", "0");
    document.body.appendChild(svg);
    (svg as unknown as HTMLElement).focus();
    expect(document.activeElement).toBe(svg);
    const attempt = jest.spyOn(svg as unknown as HTMLElement, "focus");
    open();
    at("bystander").focus();
    close();
    expect(attempt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(at("bystander"));
    attempt.mockRestore();
    svg.remove();
  });

  it("restores a connected opener that the same cases would otherwise have refused", () => {
    /* The control for the four above: the same shape, with a guard that should NOT fire, so a hook that
       simply never restored would fail here. */
    const attempt = jest.spyOn(at("opener"), "focus");
    at("opener").focus();
    open();
    at("bystander").focus();
    close();
    expect(attempt).toHaveBeenCalled();
    expect(document.activeElement).toBe(at("opener"));
    attempt.mockRestore();
  });
});

/* ------------------------------------------------------------------ */
/* What the hook is not                                                */
/* ------------------------------------------------------------------ */

describe("it owns the lifecycle and nothing else", () => {
  it("adds no attributes, no markup and no focus of its own to the surface", () => {
    /* Initial focus, containment, semantics and naming stayed with the consumer. A hook that quietly focused
       something on mount would be taking a decision the audit says belongs to the dialog. */
    at("opener").focus();
    open();
    expect(document.activeElement).toBe(at("opener"));
    expect(maybe('[role="dialog"]')!.getAttribute("tabindex")).toBeNull();
    expect(dialogs()).toBe(1);
  });
});
