/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1645 (harness): ESCAPE MAY MIRROR A DISMISSAL, NEVER AN ACTION
// ==================================================================
//
// The modal audit listed four acknowledge-style notices with no Escape (H3). Batch 4A migrates TWO of them,
// and the split is a product decision measured on the real components rather than a mechanical one:
//
//                          | backdrop           | its callback   | that callback in App.tsx        | eligible
//   PhaseThreeNoticeModal  | dismisses          | onAcknowledge  | setPhaseThreeNotice(false)      | YES
//   GameOverModal          | dismisses          | onDismiss      | hide + take the outro frame down | YES
//   PrivateRevenueModal    | **no-op**          | --             | --                              | no
//   FleetLossModal         | **no-op**          | --             | --                              | no
//
// The two eligible ones already give the player a pointer route that closes the overlay and changes no game
// state, and the backdrop uses the IDENTICAL callback the visible control uses -- so Escape mirrors a route
// that exists. The other two have no dismissal route at all: their only exit is an acknowledgment that
// advances play, and "close the overlay" is not the same act as "perform its sole action". They are untouched
// here and guarded at the bottom of this file.
//
// MEASURED BEFORE THE CHANGE, on the real components, for both an appearance from an opener and an automatic
// one (these notices are usually raised by the shell, not by a control):
//
//                          | Escape      | focus after the visible control / backdrop
//   PhaseThreeNoticeModal  | did nothing | <body> / <body>      (opens on its "Got it" button, native autoFocus)
//   GameOverModal          | did nothing | <body> / <body>      (opens without moving focus at all)

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/* #1651 (harness): EVERY DIALOG IN THIS FILE IS NOW A NATIVE `<dialog>` IN THE SHARED MODAL LAYER.
   `NativeModal` portals into `[data-modal-layer]` and throws if it is absent, so the harness renders
   `<ModalLayerHost />` beside its opener exactly as `GameRouter` does in the application. The dialog is the
   ELEMENT now, not a `<div role="dialog">` inside it (#1652 measured two dialog nodes in the accessibility
   tree before the correction), so every selector below reads `dialog[data-native-modal]`. */

import { ModalLayerHost } from "./ModalPortal";

import PhaseThreeNoticeModal from "./PhaseThreeNoticeModal";
import GameOverModal from "./GameOverModal";
import PrivateRevenueModal from "./PrivateRevenueModal";
import FleetLossModal from "./FleetLossModal";
import { readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const STANDINGS = [
  { address: "0xa", label: "Ann", cash: 100, stockValue: 400, privateValue: 0, netWorth: 500, rank: 1, isWinner: true, isBankrupt: false, expectedPayout: 60 },
  { address: "0xb", label: "Bo", cash: 50, stockValue: 200, privateValue: 0, netWorth: 250, rank: 2, isWinner: false, isBankrupt: false, expectedPayout: 40 },
] as never;
const ROUND = {
  viewerName: "Ann",
  viewerSeatColor: null,
  lines: [{ privateId: 1, label: "Schuylkill Valley", value: "$5" }],
  total: 5,
  cashBefore: 100,
  cashAfter: 105,
  others: [],
} as never;
const FLEET = { companyId: 1, ticker: "PRR", cause: "rust", trains: ["2"], arrivingTier: "4" } as never;

let host: HTMLDivElement;
let root: Root;
let dismisses = 0;
let acknowledges = 0;
let closeRooms = 0;
let leaves = 0;
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

type Which = "phase3" | "gameover" | "revenue" | "fleet";
let setOpen: (open: boolean) => void = () => {};
let setDoomed: (present: boolean) => void = () => {};

function Harness({ which, withOpener, extraOpener }: { which: Which; withOpener: boolean; extraOpener: boolean }) {
  const [open, setOpenState] = useState(false);
  const [doomedPresent, setDoomedState] = useState(extraOpener);
  setOpen = setOpenState;
  setDoomed = setDoomedState;
  const dismiss = () => {
    dismisses += 1;
    setOpenState(false);
  };
  const acknowledge = () => {
    acknowledges += 1;
    setOpenState(false);
  };
  return (
    <>
      {withOpener && (
        <button type="button" data-testid="opener">
          Open
        </button>
      )}
      <button type="button" data-testid="bystander">
        Bystander
      </button>
      {doomedPresent && (
        <button type="button" data-testid="doomed">
          Doomed opener
        </button>
      )}
      {which === "phase3" && <PhaseThreeNoticeModal open={open} onAcknowledge={acknowledge} />}
      {which === "gameover" && (
        <GameOverModal
          reason={open ? "bank-broken" : null}
          standings={STANDINGS}
          viewerAddress="0xa"
          totalAnte={100}
          bankruptLabel={null}
          onDismiss={dismiss}
          onCloseRoom={() => {
            closeRooms += 1;
          }}
          onLeaveGame={() => {
            leaves += 1;
          }}
          autoCloseIn={null}
          roomClosed={false}
        />
      )}
      {which === "revenue" && open && <PrivateRevenueModal round={ROUND} roundLabel="OR 1" onAcknowledge={acknowledge} />}
      {which === "fleet" && open && (
        /* Design note (VF-8): `silenced`/`onToggleSilence` are gone with the per-corporation opt-out;
           this modal has one control again. The dismissal property under test is untouched. */
        <FleetLossModal notice={FLEET} onAcknowledge={acknowledge} />
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

function mount(which: Which, opts: { withOpener?: boolean; extraOpener?: boolean } = {}) {
  dismisses = 0;
  acknowledges = 0;
  closeRooms = 0;
  leaves = 0;
  spyListeners();
  mountLayer();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <Harness which={which} withOpener={opts.withOpener ?? true} extraOpener={opts.extraOpener ?? false} />,
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
const dialog = () => document.querySelector<HTMLElement>('dialog[data-native-modal],dialog[data-native-modal]');
const openDialog = () => {
  const node = dialog();
  if (!node) throw new Error("no dialog");
  return node;
};
const btn = (text: string) =>
  Array.from(openDialog().querySelectorAll("button")).find((b) => (b.textContent || "").trim() === text) as
    | HTMLButtonElement
    | undefined;
const firstButton = () => openDialog().querySelector<HTMLElement>("button")!;

const open = () => act(() => setOpen(true));
const click = (node: Element | null | undefined) =>
  act(() => void node?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
/** Both eligible notices put `role="dialog"` on the backdrop itself, so the click lands on that element and
 *  the component's own `event.target === event.currentTarget` test decides. Neither backdrop is changed. */
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

function press(key: string, opts: { prevented?: boolean; target?: EventTarget } = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  if (opts.prevented) event.preventDefault();
  act(() => void (opts.target ?? document.activeElement ?? window).dispatchEvent(event));
  if (key === "Escape") deliverCloseRequest(event);
  return event;
}
const escape = (opts: { prevented?: boolean; target?: EventTarget } = {}) => press("Escape", opts);

/* ================================================================== */
/*  The two eligible notices                                           */
/* ================================================================== */

const ELIGIBLE: Array<{ label: string; which: Which; name: string; control: string; counter: () => number }> = [
  {
    label: "PhaseThreeNoticeModal",
    which: "phase3",
    name: "Phase 3: private companies are for sale",
    control: "Got it",
    counter: () => acknowledges,
  },
  {
    label: "GameOverModal",
    which: "gameover",
    name: "Game Over",
    control: "View final board",
    counter: () => dismisses,
  },
];

describe.each(ELIGIBLE)("$label: Escape mirrors the backdrop", ({ which, name, control, counter }) => {
  beforeEach(() => mount(which));
  afterEach(() => unmount());

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

  it("dismisses on Escape through the very callback the backdrop uses", () => {
    open();
    escape();
    expect(dialog()).toBeNull();
    expect(counter()).toBe(1);
    /* And nothing else fired: `onCloseRoom` and `onLeaveGame` are the ACTIONS on Game Over, and Escape must
       not be a second route to either. */
    expect(closeRooms).toBe(0);
    expect(leaves).toBe(0);
  });

  it("the backdrop and the visible control drive the same callback, with the same effect", () => {
    open();
    clickBackdrop();
    expect(dialog()).toBeNull();
    const afterBackdrop = counter();
    open();
    click(btn(control));
    expect(dialog()).toBeNull();
    expect(counter()).toBe(afterBackdrop + 1);
    expect(closeRooms).toBe(0);
    expect(leaves).toBe(0);
  });

  it("does not dismiss on an Escape a nested surface has already consumed", () => {
    open();
    escape({ prevented: true });
    expect(dialog()).not.toBeNull();
    expect(counter()).toBe(0);
  });

  it("does nothing on keys that are not Escape", () => {
    open();
    ["Enter", " ", "Tab", "ArrowDown", "Esc", "escape"].forEach((key) => press(key));
    expect(dialog()).not.toBeNull();
    expect(counter()).toBe(0);
  });

  it("restores a real connected opener, from Escape and from both pointer routes", () => {
    ([() => escape(), () => clickBackdrop(), () => click(btn(control))] as const).forEach((run) => {
      at("opener").focus();
      open();
      firstButton().focus();
      run();
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(at("opener"));
    });
    expect(counter()).toBe(3);
  });

  it("holds no listener while it is mounted but hidden, and nets to zero over ten cycles", () => {
    /* Both are kept mounted by `App.tsx` and switched by a prop; the lifecycle child is simply not rendered
       while the notice is hidden. */
    expect(keydownListeners).toBe(0);
    escape();
    expect(counter()).toBe(0);
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

  it("manufactures no opener when it appears automatically", () => {
    /* THE HONEST CASE. These notices are normally raised by the shell on a state edge, with nothing focused.
       The hook must decline rather than invent a target -- and must not grab some stale gameplay control to
       make a restoration assertion pass. */
    unmount();
    mount(which, { withOpener: false });
    expect(document.activeElement).toBe(document.body);
    const attempt = jest.spyOn(document.body, "focus");
    open();
    escape();
    expect(dialog()).toBeNull();
    expect(attempt).not.toHaveBeenCalled();
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
/*  Per-surface: the behaviour each one must not have lost             */
/* ================================================================== */

describe("PhaseThreeNoticeModal keeps the rest of its contract", () => {
  beforeEach(() => mount("phase3"));
  afterEach(() => unmount());

  it("still opens with its Got it button focused, by the same native autoFocus it always used", () => {
    /* NOTHING ABOUT INITIAL FOCUS CHANGED -- not the target and not the mechanism. The next case is why that
       was safe to leave alone. */
    at("opener").focus();
    open();
    expect(document.activeElement).toBe(at("phase-three-notice-ok"));
  });

  it("captures the opener rather than its own button, which is what makes the restore land", () => {
    at("opener").focus();
    open();
    expect(document.activeElement).toBe(at("phase-three-notice-ok"));
    escape();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("still says the two things it is for, and reopens identically", () => {
    open();
    expect(openDialog().textContent).toContain("at any time during its turn");
    expect(openDialog().textContent).toContain("close at the start of Phase 5");
    expect(openDialog().querySelectorAll("button")).toHaveLength(1);
    escape();
    open();
    expect(openDialog().textContent).toContain("at any time during its turn");
    expect(openDialog().querySelectorAll("button")).toHaveLength(1);
    expect(document.activeElement).toBe(at("phase-three-notice-ok"));
  });
});

describe("GameOverModal keeps the rest of its contract", () => {
  beforeEach(() => mount("gameover"));
  afterEach(() => unmount());

  it("still opens without moving focus anywhere", () => {
    at("opener").focus();
    open();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("keeps Close Room and Leave game as their own controls, reachable only by clicking them", () => {
    open();
    expect(btn("Close Room")).toBeDefined();
    click(btn("Close Room"));
    expect(closeRooms).toBe(1);
    expect(dismisses).toBe(0);
    click(btn("↩ Leave game"));
    expect(leaves).toBe(1);
    expect(dismisses).toBe(0);
  });

  it("still shows the standings and the viewer's verdict, and shows them again on reopen", () => {
    open();
    expect(openDialog().textContent).toContain("You Won!");
    expect(openDialog().textContent).toContain("Ann");
    expect(openDialog().textContent).toContain("Bo");
    escape();
    open();
    expect(openDialog().textContent).toContain("You Won!");
    expect(openDialog().textContent).toContain("Ann");
  });
});

/* ================================================================== */
/*  The action boundary: the two this batch does NOT migrate           */
/* ================================================================== */

describe("the two action notices are untouched, and Escape does not act for the player", () => {
  /* WHY THIS GUARD EXISTS, and what it is not. `PrivateRevenueModal` and `FleetLossModal` have exactly one
     exit each and it ADVANCES THE GAME -- "Begin operations" starts the operating round, and the fleet notice
     hands the turn on. Measured: neither has a backdrop dismissal at all (`no-op`), so there is no existing
     pointer route for Escape to mirror; wiring `useDialogDismissal` to their `onAcknowledge` would make a
     keypress perform an action rather than close an overlay.
     THIS IS NOT A PERMANENT BAN ON THE HOOK FOR THESE TWO. A later pass may well give them guarded
     RESTORATION without Escape, or settle an explicit post-action focus target. What this case defends is
     batch 4A's product boundary: that the migration did not quietly reach them along the way. */

  afterEach(() => unmount());

  it.each([
    ["PrivateRevenueModal", "revenue" as Which],
    ["FleetLossModal", "fleet" as Which],
  ])("%s: Escape neither closes it nor fires its acknowledgment", (_label, which) => {
    mount(which);
    at("opener").focus();
    open();
    expect(dialog()).not.toBeNull();
    expect(keydownListeners).toBe(0);
    escape();
    press("Enter");
    expect(dialog()).not.toBeNull();
    expect(acknowledges).toBe(0);
  });

  it.each([
    ["PrivateRevenueModal", "revenue" as Which],
    ["FleetLossModal", "fleet" as Which],
  ])("%s: its backdrop is still inert, and its one control still acknowledges", (_label, which) => {
    mount(which);
    open();
    clickBackdrop();
    expect(dialog()).not.toBeNull();
    expect(acknowledges).toBe(0);
    click(firstButton());
    expect(acknowledges).toBe(1);
  });

  it("neither file is wired to the shared dismissal hook in this batch", () => {
    (["components/PrivateRevenueModal.tsx", "components/FleetLossModal.tsx"] as const).forEach((path) => {
      const source = readStripped(path);
      expect([path, "hook", source.includes("useDialogDismissal")]).toEqual([path, "hook", false]);
      expect([path, "child", source.includes("DismissalLifecycle")]).toEqual([path, "child", false]);
      expect([path, "listener", source.includes('addEventListener("keydown"')]).toEqual([path, "listener", false]);
    });
  });
});

/* ================================================================== */
/*  Structure                                                          */
/* ================================================================== */

describe("the migrated notices carry no private dismissal code", () => {
  const FILES = ["components/PhaseThreeNoticeModal.tsx", "components/GameOverModal.tsx"] as const;

  it("has no hand-written keydown listener and no private opener capture", () => {
    FILES.forEach((path) => {
      const source = readStripped(path);
      expect([path, "listener", source.includes('addEventListener("keydown"')]).toEqual([path, "listener", false]);
      expect([path, "capture", source.includes("document.activeElement")]).toEqual([path, "capture", false]);
    });
  });

  it("keeps the lifecycle below each notice's own render switch", () => {
    /* #1651 SUPERSEDES the `DismissalLifecycle` child this checked for. The property is the same -- both
       notices stay mounted while hidden, so nothing holding a listener or a captured opener may sit above the
       switch -- and `NativeModal` is only RENDERED past it. */
    ([
      ["components/PhaseThreeNoticeModal.tsx", "PhaseThreeNoticeModal", "if (!open) return null;"],
      ["components/GameOverModal.tsx", "GameOverModal", "if (!reason) return null;"],
    ] as const).forEach(([path, name, earlyReturn]) => {
      const source = readStripped(path);
      const componentAt = source.indexOf("export function " + name);
      expect([path, componentAt >= 0]).toEqual([path, true]);
      const body = source.slice(componentAt);
      expect([path, body.includes(earlyReturn)]).toEqual([path, true]);
      expect([path, "no child", body.includes("DismissalLifecycle")]).toEqual([path, "no child", false]);
      expect([path, "boundary below the switch", body.indexOf("<NativeModal") > body.indexOf(earlyReturn)]).toEqual([
        path,
        "boundary below the switch",
        true,
      ]);
    });
  });

  it("captures the opener before a native autoFocus can take it", () => {
    /* MEASURED TWICE, AND THE SECOND MEASUREMENT OVERTURNED THE FIRST. Batch 4A found that React 18 applies
       `autoFocus` in the commit's LAYOUT phase, ordered by fiber position, so a lifecycle child rendered
       above the card captured the opener first. That held for a child INSIDE the dialog; it does not hold for
       `NativeModal`, which is the outermost element -- a capture in its layout effect recorded the "Got it"
       button instead, a node that leaves with the dialog, so the restore's `isConnected` guard refused and
       focus landed on `<body>`. The capture is therefore taken during RENDER, the only phase before the
       mutation in which `autoFocus` fires. The behavioural half is "captures the opener rather than its own
       button" above, which fails if this moves back into an effect. */
    const boundary = readStripped("components/NativeModal.tsx");
    const captureAt = boundary.indexOf("openerRef.current = typeof document");
    expect(captureAt).toBeGreaterThanOrEqual(0);
    expect(boundary.indexOf("node.showModal();")).toBeGreaterThan(captureAt);
    expect(readStripped("components/PhaseThreeNoticeModal.tsx").includes("autoFocus")).toBe(true);
  });

  it("wires Escape to the dismissal callback, never to the action callback", () => {
    /* The single most important line of this batch, asserted as source because it is a WIRING decision: Game
       Over's action is `onCloseRoom` and the Phase 3 notice has none. #1651 moved the wiring onto the
       boundary's `onDismiss`, and it is still the same function the backdrop and the visible control call. */
    const gameOver = readStripped("components/GameOverModal.tsx");
    expect(gameOver.includes("onDismiss={onDismiss}")).toBe(true);
    expect(gameOver.includes("onDismiss={onCloseRoom")).toBe(false);
    const phase3 = readStripped("components/PhaseThreeNoticeModal.tsx");
    expect(phase3.includes("onDismiss={onAcknowledge}")).toBe(true);
  });
});
