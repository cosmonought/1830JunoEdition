/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1647 (harness): TWO ESCAPES, ONE FILE, ONE MIGRATION
// ==================================================================
//
// `TutorialModal.tsx` carried two hand-written `window` Escape listeners. Measured on the real components,
// they mean different things, and only one of them is a dismissal:
//
//   THE FIRST-TIME NOTICE   Escape closed it and wrote `1830juno.tutorial_seen.v1.<topic>` -- the same
//                           callback and the same storage write as a backdrop click. MIGRATED.
//   THE LIBRARY             Escape from an open topic returned to the list and did NOT call `onClose`
//                           (name went "Waterfall Auction" -> "Tutorials", library still open); only from the
//                           list did it close. NAVIGATION -- kept local, by design.
//
// MEASURED BEFORE THE CHANGE, on both:
//
//   notice, focus on appearance   the opener, or <body> -- focus never enters the notice
//   notice, focus after any route unchanged (so there was no `<body>` defect to fix here)
//   notice, defaultPrevented      IGNORED: it closed AND wrote the seen flag
//   library, defaultPrevented     IGNORED: it navigated anyway
//   library, focus on a topic     <body>, because the topic button is unmounted -- audit M5, a separate pass
//   library, state on reopen      always back to the list; the topic does not survive
//
// So this batch keeps both behaviours exactly and adds first refusal to each -- to the notice through the
// shared hook, to the library through one line that changes nothing else.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { TutorialLibrary, TutorialModal } from "./TutorialModal";
import { readStripped } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const SEEN_KEY = "1830juno.tutorial_seen.v1.probe";
const OFF_KEY = "1830juno.tutorials_off.v1";
const PAGES = [
  { title: "One", body: "first page" },
  { title: "Two", body: "second page" },
] as never;

let host: HTMLDivElement;
let root: Root;
let closes = 0;
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

const flag = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

let setActive: (active: boolean) => void = () => {};
let setLibraryOpen: (open: boolean) => void = () => {};
let setDoomed: (present: boolean) => void = () => {};

function NoticeHarness({ withOpener = true, extraOpener = false }: { withOpener?: boolean; extraOpener?: boolean }) {
  const [active, setActiveState] = useState(false);
  const [doomedPresent, setDoomedState] = useState(extraOpener);
  setActive = setActiveState;
  setDoomed = setDoomedState;
  return (
    <>
      {withOpener && (
        <button type="button" data-testid="opener">
          Opener
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
      <TutorialModal topicKey="probe" heading="Probe" pages={PAGES} active={active} />
    </>
  );
}

function LibraryHarness() {
  const [open, setOpenState] = useState(false);
  setLibraryOpen = setOpenState;
  return (
    <>
      <button type="button" data-testid="opener">
        Opener
      </button>
      <TutorialLibrary
        open={open}
        onClose={() => {
          closes += 1;
          setOpenState(false);
        }}
      />
    </>
  );
}

function mount(node: React.ReactNode) {
  closes = 0;
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  spyListeners();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(node));
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  jest.restoreAllMocks();
  document.body.innerHTML = "";
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
}

const at = (testid: string) => {
  const node = document.querySelector<HTMLElement>('[data-testid="' + testid + '"]');
  if (!node) throw new Error("no " + testid);
  return node;
};
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const openDialog = () => {
  const node = dialog();
  if (!node) throw new Error("no dialog");
  return node;
};
const buttons = () => Array.from(openDialog().querySelectorAll("button"));
const labelled = (text: string) => buttons().find((b) => (b.textContent || "").trim() === text);
const click = (node: Element | null | undefined) =>
  act(() => void node?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
const clickBackdrop = () => click(openDialog());
function press(key: string, opts: { prevented?: boolean } = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  if (opts.prevented) event.preventDefault();
  act(() => void (document.activeElement ?? window).dispatchEvent(event));
  return event;
}
const escape = (opts: { prevented?: boolean } = {}) => press("Escape", opts);
const show = () => act(() => setActive(true));
/** The pager opens on page one; "Got it" is the last page's Done label. */
const pageToTheEnd = () => {
  for (let guard = 0; guard < 10 && labelled("Next"); guard += 1) click(labelled("Next"));
};

/* ================================================================== */
/*  The first-time notice — migrated                                   */
/* ================================================================== */

describe("the first-time tutorial notice dismisses through the shared boundary", () => {
  beforeEach(() => mount(<NoticeHarness />));
  afterEach(() => unmount());

  it("is still the same modal, named for its topic", () => {
    show();
    expect(openDialog().getAttribute("role")).toBe("dialog");
    expect(openDialog().getAttribute("aria-modal")).toBe("true");
    expect(openDialog().getAttribute("aria-label")).toBe("Probe");
    expect(openDialog().textContent).toContain("first page");
  });

  it("dismisses on Escape and writes the seen flag exactly once", () => {
    expect(flag(SEEN_KEY)).toBeNull();
    show();
    escape();
    expect(dialog()).toBeNull();
    expect(flag(SEEN_KEY)).toBe("1");
    /* Once: a second Escape has nothing left to close, and the value does not change. */
    escape();
    expect(flag(SEEN_KEY)).toBe("1");
  });

  it("writes the same flag and reaches the same state from the backdrop", () => {
    show();
    clickBackdrop();
    expect(dialog()).toBeNull();
    expect(flag(SEEN_KEY)).toBe("1");
  });

  it("writes the same flag from the visible Got it control on the last page", () => {
    show();
    pageToTheEnd();
    expect(labelled("Got it")).toBeDefined();
    click(labelled("Got it"));
    expect(dialog()).toBeNull();
    expect(flag(SEEN_KEY)).toBe("1");
  });

  it("still honours the Turn tutorials off box on the Escape route", () => {
    /* `dismiss` is unchanged and is what all three routes call, so the checkbox keeps working through Escape
       exactly as it does through the backdrop. */
    show();
    click(openDialog().querySelector('input[type="checkbox"]'));
    escape();
    expect(flag(SEEN_KEY)).toBe("1");
    expect(flag(OFF_KEY)).toBe("1");
  });

  it("neither closes nor writes the flag when an inner surface has consumed the Escape", () => {
    /* THE CORRECTION. Measured before: it closed AND wrote the flag regardless. */
    show();
    escape({ prevented: true });
    expect(dialog()).not.toBeNull();
    expect(flag(SEEN_KEY)).toBeNull();
  });

  it("does nothing on keys that are not Escape", () => {
    show();
    ["Enter", " ", "Tab", "ArrowDown", "Esc", "escape"].forEach((key) => press(key));
    expect(dialog()).not.toBeNull();
    expect(flag(SEEN_KEY)).toBeNull();
  });

  it("still appears without moving focus, exactly as before", () => {
    /* NO INITIAL FOCUS, and none was added -- that is audit H2 and not this batch. */
    at("opener").focus();
    show();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("restores a valid connected opener when focus did move inside", () => {
    at("opener").focus();
    show();
    buttons()[0].focus();
    escape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(at("opener"));
  });

  it("manufactures no target when it appears automatically with nothing focused", () => {
    unmount();
    mount(<NoticeHarness withOpener={false} />);
    expect(document.activeElement).toBe(document.body);
    const attempt = jest.spyOn(document.body, "focus");
    show();
    escape();
    expect(dialog()).toBeNull();
    expect(attempt).not.toHaveBeenCalled();
  });

  it("does not focus an opener that has left the document", () => {
    unmount();
    mount(<NoticeHarness extraOpener />);
    at("doomed").focus();
    show();
    const attempt = jest.spyOn(at("doomed"), "focus");
    act(() => setDoomed(false));
    at("bystander").focus();
    escape();
    expect(attempt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(at("bystander"));
  });

  it("stays dismissed once seen, and holds no listener while hidden", () => {
    /* `App.tsx` mounts four of these for the whole session; the lifecycle child is why none of them listens
       until its own notice is up. */
    expect(keydownListeners).toBe(0);
    show();
    expect(keydownListeners).toBe(1);
    escape();
    expect(keydownListeners).toBe(0);
    /* The seen flag is what stops it coming back, and that condition is untouched. */
    act(() => setActive(false));
    show();
    expect(dialog()).toBeNull();
    expect(keydownListeners).toBe(0);
  });
});

/* ================================================================== */
/*  The library — kept local, on purpose                               */
/* ================================================================== */

describe("the tutorial library keeps its own two-level Escape", () => {
  beforeEach(() => mount(<LibraryHarness />));
  afterEach(() => unmount());

  const openLibrary = () => act(() => setLibraryOpen(true));
  const openFirstTopic = () => {
    const topic = buttons().find((b) => (b.textContent || "").trim().length > 4);
    click(topic);
  };

  it("returns from a topic to the list without closing the library", () => {
    openLibrary();
    expect(openDialog().getAttribute("aria-label")).toBe("Tutorials");
    openFirstTopic();
    expect(openDialog().getAttribute("aria-label")).not.toBe("Tutorials");
    escape();
    expect(dialog()).not.toBeNull();
    expect(openDialog().getAttribute("aria-label")).toBe("Tutorials");
    expect(closes).toBe(0);
  });

  it("closes the library from the list, as it always did", () => {
    openLibrary();
    escape();
    expect(dialog()).toBeNull();
    expect(closes).toBe(1);
  });

  it("blocks both the navigation and the close when an inner surface consumed the Escape", () => {
    /* THE ONE THING ADDED HERE. Measured before: it navigated anyway. */
    openLibrary();
    openFirstTopic();
    const topicName = openDialog().getAttribute("aria-label");
    escape({ prevented: true });
    expect(openDialog().getAttribute("aria-label")).toBe(topicName);
    escape({ prevented: true });
    expect(dialog()).not.toBeNull();
    expect(closes).toBe(0);
  });

  it("still reopens on the list rather than on the topic it was left at", () => {
    openLibrary();
    openFirstTopic();
    const topicName = openDialog().getAttribute("aria-label");
    expect(topicName).not.toBe("Tutorials");
    escape();
    escape();
    expect(dialog()).toBeNull();
    openLibrary();
    expect(openDialog().getAttribute("aria-label")).toBe("Tutorials");
  });

  it("writes no seen flag and no off flag, because it is not a first-time notice", () => {
    openLibrary();
    openFirstTopic();
    escape();
    escape();
    expect(flag(SEEN_KEY)).toBeNull();
    expect(flag(OFF_KEY)).toBeNull();
  });
});

/* ================================================================== */
/*  Structure: the split is deliberate and is written down             */
/* ================================================================== */

describe("the file records why only one of its two Escapes moved", () => {
  const SOURCE = () => readStripped("components/TutorialModal.tsx");

  it("leaves exactly one hand-written keydown listener, and it is the library's", () => {
    const source = SOURCE();
    expect((source.match(/addEventListener\("keydown"/g) || []).length).toBe(1);
    /* The surviving one is the navigation state machine: it reads the current topic to decide. */
    expect(source.includes("setTopicKey((current) => {")).toBe(true);
  });

  it("gives the notice the shared hook, through a child and through the same dismiss", () => {
    const source = SOURCE();
    expect(source.includes("<DismissalLifecycle onDismiss={dismiss} />")).toBe(true);
    /* Not in the body: `App.tsx` keeps four of these mounted for the whole session. */
    const noticeAt = source.indexOf("export function TutorialModal");
    expect(source.slice(noticeAt).includes("useDialogDismissal({")).toBe(false);
  });

  it("gives the surviving listener first refusal", () => {
    expect(SOURCE().includes("if (event.defaultPrevented) return;")).toBe(true);
  });

  it("documents the exemption, so the omission cannot be read as an oversight", () => {
    /* The brief's requirement, and the point of the note: a future reader must find the reason at the site
       rather than conclude the migration simply missed one. */
    const raw = readStripped("components/TutorialModal.tsx");
    expect(raw.length).toBeGreaterThan(0);
    const withComments = require("fs").readFileSync(
      require("path").join(process.cwd(), "src/components/TutorialModal.tsx"),
      "utf8",
    ) as string;
    expect(withComments.includes("DELIBERATELY NOT `useDialogDismissal`")).toBe(true);
    expect(withComments.includes("DESIGN NOTE 1647")).toBe(true);
  });
});
