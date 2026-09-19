/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1618 (harness): A PINCH IS THE READER'S, AND NOTHING HERE MAY TAKE IT BACK
// ==================================================================
//
// WHAT #1014 DID AND WHY IT IS BEING UNDONE. "Ensure the viewport is locked and strictly prevents user
// scaling" produced two page-level directives (`maximum-scale=1.0`, `user-scalable=no`) and one canvas-level
// one (`touch-action: pan-x pan-y`). Together they removed browser pinch-zoom and double-tap-zoom from the
// whole application on every touch device. The rationale is preserved in `public/index.html` and
// `utils/mapGesture.ts` and is not being erased -- but it protected a board that owns no gesture a pinch
// competes with, so what it actually cost was a mobile reader's only magnification.
//
// THIS IS NOT THE UI SCALE PICKER, and the two cases at the bottom are here to keep the distinction visible.
// The picker chooses the app's interface DENSITY, resolves from storage, and defaults to 100% on a first run
// (#1450). Browser page zoom is the user agent's own accessibility capability. They are independent
// mechanisms that compose, and this pass changed only the second.
//
// WHY SO MUCH OF THIS IS A STRUCTURAL AUDIT, said plainly because it is the weakness of this file. jsdom has
// no compositor: it cannot pinch, cannot scale a page, and will report any `touch-action` you give it. So
// there is no behavioural assertion available for "the reader can zoom" -- the only honest test of that is a
// real phone, and the measurements taken for this pass are recorded in the design note. What CAN be pinned
// exactly is that nothing in the tree re-imposes the lock, and that is what the cases below do: the viewport
// is parsed as a DOM node rather than grepped, and every global gesture blocker is enumerated by file so a
// new one cannot arrive unnamed.

export {};

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const { readSource, stripComments } = require("./sourceScan") as typeof import("./sourceScan");
const { MAP_TOUCH_ACTION } = require("./mapGesture") as typeof import("./mapGesture");
const {
  resolveUiScale,
  storedUiScale,
  UI_SCALE_STEPS,
  UI_SCALE_DEFAULT,
  UI_SCALE_STORAGE_KEY,
} = require("./uiScale") as typeof import("./uiScale");

/* ------------------------------------------------------------------ */
/* The tree, read once                                                 */
/* ------------------------------------------------------------------ */

const SRC = path.join(__dirname, "..");

/** Every production source file, comments stripped (#490a: a design note quoting `user-scalable=no` in the
 *  course of explaining its removal must not read as `user-scalable=no`). Tests are excluded because a test
 *  naming the forbidden string is how the forbidden string is forbidden. */
const SOURCES: ReadonlyArray<{ rel: string; code: string }> = (function collect() {
  const found: Array<{ rel: string; code: string }> = [];
  const walk = (dir: string): void => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        return;
      }
      if (!/\.tsx?$/.test(entry.name)) return;
      if (/\.test\.tsx?$/.test(entry.name)) return;
      if (entry.name === "sourceScan.ts") return;
      found.push({
        rel: path.relative(SRC, full).split(path.sep).join("/"),
        code: stripComments(fs.readFileSync(full, "utf8")),
      });
    });
  };
  walk(SRC);
  return found;
})();

/** A sanity floor on the walk itself. An empty or tiny file list would make every absence case below pass
 *  while proving nothing, which is the failure mode of every audit written as a negative. */
const MINIMUM_FILES_EXPECTED = 100;

/* ------------------------------------------------------------------ */
/* Regressions 1 and 2 -- the viewport itself                          */
/* ------------------------------------------------------------------ */

/** The shipped document, parsed rather than searched. `index.html` now carries a design note that quotes both
 *  withdrawn directives while explaining them, so a substring assertion over the file would find them in
 *  prose and report the opposite of the truth. The DOM does not have that problem. */
function viewportMeta(): HTMLMetaElement {
  const html = readSource("../public/index.html");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const metas = Array.from(doc.querySelectorAll('meta[name="viewport"]'));
  expect(metas.length).toBe(1);
  return metas[0] as HTMLMetaElement;
}

/** `content` split into its directives, lowercased. A directive present with no value maps to "". */
function viewportDirectives(): Record<string, string> {
  const out: Record<string, string> = {};
  viewportMeta()
    .getAttribute("content")!
    .split(",")
    .forEach((part) => {
      const eq = part.indexOf("=");
      const key = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
      if (!key) return;
      out[key] = (eq === -1 ? "" : part.slice(eq + 1)).trim().toLowerCase();
    });
  return out;
}

describe("the page declares a viewport and no ceiling", () => {
  it("still lays out at the device width and starts at 1", () => {
    /* NEITHER OF THESE IS PART OF THE LOCK, which is the distinction #1618 turns on. `width=device-width`
       stops mobile Safari laying the page out at 980 CSS px and shrinking it to fit, and `initial-scale=1` is
       the STARTING scale. A ceiling is what forbids zoom; a starting point is not. */
    const directives = viewportDirectives();
    expect(directives["width"]).toBe("device-width");
    expect(directives["initial-scale"]).toBe("1");
  });

  it("sets no maximum scale, and no minimum either", () => {
    /* `maximum-scale=1.0` is the directive iOS Safari actually honours -- #1014 shipped it alongside
       `user-scalable=no` precisely because Safari has ignored the latter since iOS 10. Asserted as an absence
       of the KEY, not of a value: `maximum-scale=1.5` would be a quieter version of the same defect.
       `minimum-scale` has never been set here and is refused for the same reason in the other direction. */
    const directives = viewportDirectives();
    expect(Object.keys(directives)).not.toContain("maximum-scale");
    expect(Object.keys(directives)).not.toContain("minimum-scale");
  });

  it("does not refuse user scaling", () => {
    /* The blunt half of #1014. Chrome and Firefox on Android both honour this one, so its return would
       restore the lock on those engines even with `maximum-scale` gone. */
    const directives = viewportDirectives();
    expect(Object.keys(directives)).not.toContain("user-scalable");
  });

  it("keeps #1014's reasoning on the record even though its conclusion is withdrawn", () => {
    /* THE ONE PLACE THIS FILE READS THE RAW TEXT, and deliberately. A future reader who finds no directives
       and no history would reasonably conclude the lock was an accident, re-derive #1014's argument from
       scratch and put it back. The note is load-bearing; it is asserted so it cannot be tidied away with the
       code it explains. */
    const html = readSource("../public/index.html");
    expect(html).toContain("Design note #1014");
    expect(html).toContain("DESIGN NOTE 1618");
  });
});

/* ------------------------------------------------------------------ */
/* Regression 3 -- nothing puts it back at runtime                     */
/* ------------------------------------------------------------------ */

describe("no code restores the lock after the document is parsed", () => {
  it("scanned a real tree", () => {
    expect(SOURCES.length).toBeGreaterThan(MINIMUM_FILES_EXPECTED);
  });

  it("never rewrites the viewport meta tag", () => {
    /* THE OBVIOUS BYPASS: one `querySelector('meta[name=viewport]').setAttribute("content", ...)` in a mount
       effect and the DOM cases above are decoration. Nothing in the tree touches the tag today -- the lock
       was always static markup -- so this is a fence around an empty field, which is the cheapest kind. */
    const offenders = SOURCES.filter((f) => /meta\[\s*name\s*=\s*["']?viewport/i.test(f.code)).map(
      (f) => f.rel,
    );
    expect(offenders).toEqual([]);
  });

  it("never writes either withdrawn directive", () => {
    const offenders = SOURCES.filter((f) => /maximum-scale|user-scalable|minimum-scale/i.test(f.code)).map(
      (f) => f.rel,
    );
    expect(offenders).toEqual([]);
  });

  it("never builds a meta element at all", () => {
    const offenders = SOURCES.filter((f) => /createElement\(\s*["']meta["']/i.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Regressions 4 and 6 -- who is allowed to claim a gesture            */
/* ------------------------------------------------------------------ */

/** The values `touch-action` can take that still permit a browser pinch. Anything outside this set refuses
 *  it -- `none` outright, and any `pan-*` list by enumerating the axes it will allow and thereby excluding
 *  the pinch. See `mapTouchScroll.test.ts` #1618 for the full table. */
const PERMITS_PINCH = ["auto", "manipulation", "pinch-zoom"];

/** The only two places allowed to name `touch-action` at all, each with the interactive region it owns. A
 *  third entry is not a merge conflict to resolve -- it is a decision about whether some new region may take
 *  a gesture away from the reader, and it belongs in a design note. */
const GESTURE_OWNERS: Readonly<Record<string, string>> = {
  "components/HexGridRenderer.tsx": "the rail map canvas",
  "components/TileSelectionPopup.tsx": "the tile picker's header drag handle",
};

describe("no surface refuses the pinch except the one that drags", () => {
  it("has exactly two files naming touch-action, both named here", () => {
    const declaring = SOURCES.filter((f) => /touchAction\s*:|touch-action\s*:/.test(f.code))
      .map((f) => f.rel)
      .sort();
    expect(declaring).toEqual(Object.keys(GESTURE_OWNERS).sort());
  });

  it("puts no touch-action on the shell, the zoom roots or any global style", () => {
    /* THE ACTUAL REGRESSION THIS FILE EXISTS FOR. A single `touchAction: "none"` on `#root`, on one of the
       four chrome roots that carry the CSS zoom (#1450), or inside an injected stylesheet would re-lock the
       whole application while leaving the viewport tag innocent -- and it would look like a scroll fix. The
       case above proves the file list; this one names the files that must never join it, because those are
       the ones a scroll fix would reach for. */
    const shell = ["App.tsx", "index.tsx", "styles/appStyles.ts", "styles/palette.ts"];
    const declaring = SOURCES.filter((f) => /touchAction\s*:|touch-action\s*:/.test(f.code)).map((f) => f.rel);
    shell.forEach((file) => expect(declaring).not.toContain(file));
  });

  it("lets the rail map canvas take scroll and taps without taking the pinch", () => {
    /* #773 won the scroll, #1014 took the pinch to serve the page lock, #1618 gives it back. The canvas is
       most of a phone screen, so this declaration decides whether a reader can zoom the app AT ALL on a
       tablet -- which is why it is asserted here as well as in `mapTouchScroll.test.ts`. */
    expect(PERMITS_PINCH).toContain(MAP_TOUCH_ACTION);
  });

  it("keeps the canvas declaration on the canvas", () => {
    const renderer = readSource("components/HexGridRenderer.tsx");
    expect(renderer.match(/touchAction:/g)!.length).toBe(1);
    const canvas = renderer.slice(
      renderer.indexOf("ref={canvasRef}"),
      renderer.indexOf("onPointerDown={handlePointerDown}"),
    );
    expect(canvas).toContain("touchAction: MAP_TOUCH_ACTION");
  });

  it("confines the drag handle's claim to the drag handle", () => {
    /* THE RULE IS NOT "NEVER SAY NONE". `TileSelectionPopup`'s header drags in every mode, so the promise it
       makes to the browser is one it keeps -- #773's rule satisfied rather than broken. What matters is that
       it stays on that one element: the assertion walks from the spread that identifies the handle to the
       declaration and fails if any element boundary lies between them, so moving it up to the popup shell
       (which covers much of a phone screen) cannot pass as the same line. */
    const popup = readSource("components/TileSelectionPopup.tsx");
    expect(popup.match(/touchAction:/g)!.length).toBe(1);
    const handleAt = popup.indexOf("{...drag.handleProps}");
    const declarationAt = popup.indexOf('touchAction: "none"');
    expect(handleAt).toBeGreaterThan(-1);
    expect(declarationAt).toBeGreaterThan(handleAt);
    const between = popup.slice(handleAt, declarationAt);
    expect(between).not.toContain("<div");
    expect(between).not.toContain("<span");
    expect(between).not.toContain("</");
  });
});

/* ------------------------------------------------------------------ */
/* Regression 5 -- no listener cancels a zoom gesture                   */
/* ------------------------------------------------------------------ */

/** Events a listener could use to take a browser-zoom or page-scroll gesture away from a reader. `wheel` is
 *  the desktop one, the touch pair is the mobile one, the `gesture*` trio is WebKit's proprietary pinch, and
 *  `dblclick` is double-tap-to-zoom on the engines that route it there. */
const ZOOM_CAPABLE_EVENTS = [
  "wheel",
  "mousewheel",
  "touchstart",
  "touchmove",
  "gesturestart",
  "gesturechange",
  "gestureend",
  "dblclick",
];

/** Targets that reach every element on the page. A listener here is not a component interaction, whatever it
 *  is attached from -- which is the distinction this whole section turns on. */
const GLOBAL_TARGETS = "window|document|document\\.body|document\\.documentElement";

/** The game-room shell and the application root. A wheel prop here would cover the whole room, so it is the
 *  element-level equivalent of a document listener. */
const SHELL_FILES = ["App.tsx", "index.tsx"];

type WheelSource = { rel: string; code: string };

/** Whether a handler body's ONLY effect is to suppress the default action: cancel calls, bare `return`s and
 *  guards that lead to one. A handler that computes, draws, sets state or reports anything is not this. */
function isCancelOnly(body: string): boolean {
  const statements = body
    .split(";")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(event|e|ev)\.(preventDefault|stopPropagation|stopImmediatePropagation)\(\)$/.test(line))
    .filter((line) => !/^return$/.test(line))
    .filter((line) => !/^if\s*\([^)]*\)\s*return$/.test(line))
    .filter((line) => !/^\}?$/.test(line));
  return statements.length === 0;
}

/** Every prohibited wheel installation in `sources`, named by location AND by what makes it prohibited.
 *
 *  ==================================================================
 *   DESIGN NOTE 1619 (harness, revised): THE BOUNDARY IS CANCELLATION, NOT THE WHEEL
 *  ==================================================================
 *  THE FIRST VERSION OF THIS GUARD ASSERTED THAT NO FILE ANYWHERE NAMED `wheel`, and that was wrong in a way
 *  worth writing down: it would have failed a future chart with a wheel-scrub, a scroller with a horizontal
 *  wheel, or any other legitimate local interaction -- and it would have failed them with a message claiming
 *  wheel handlers are invalid, which is not a rule this project holds or should hold.
 *
 *  THE ACTUAL BOUNDARY IS NARROWER AND IS ABOUT CANCELLATION:
 *    (1) the Rail Map may not install a wheel handler whose only effect is to cancel browser or page
 *        behaviour -- that was #67's "scroll containment", it never contained anything (React's delegated
 *        `wheel` listener is passive), and it is what #1619 removed;
 *    (2) nothing attached to `window`, `document`, the application root or the game-room shell may cancel a
 *        zoom-capable gesture for the whole page. A non-passive `touchmove` listener on `document` that
 *        calls `preventDefault` when `touches.length > 1` is the canonical hand-rolled pinch lock, and no
 *        `touch-action` assertion can see it.
 *  EVERYTHING ELSE IS PERMITTED. A wheel handler scoped to a component that actually uses the wheel is a
 *  normal thing to write, and a case below proves this rule lets one through rather than merely saying so. */
function wheelOffences(sources: ReadonlyArray<WheelSource>): string[] {
  const offences: string[] = [];

  // (1) The Rail Map: wired to the wheel is fine; wired to the wheel to cancel is not.
  const railMap = sources.find((f) => f.rel === "components/HexGridRenderer.tsx");
  if (railMap) {
    const wired =
      /onWheel\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(railMap.code) ??
      /addEventListener\(\s*["']wheel["']\s*,\s*([A-Za-z_$][\w$]*)/.exec(railMap.code);
    if (wired) {
      const name = wired[1];
      const defAt = railMap.code.indexOf(`const ${name} =`);
      const body =
        defAt === -1
          ? ""
          : railMap.code.slice(defAt, defAt + 800).replace(/[\s\S]*?=>\s*\{/, "").split("}")[0];
      if (defAt === -1) {
        offences.push(
          `components/HexGridRenderer.tsx: the canvas is wired to a wheel handler \`${name}\` whose ` +
            `definition this guard could not find, so it cannot be checked for cancel-only behaviour. ` +
            `Give it a definition this scan can read, or update the guard deliberately (#1619).`,
        );
      } else if (isCancelOnly(body)) {
        offences.push(
          `components/HexGridRenderer.tsx: \`${name}\` is installed on the canvas's wheel and its body only ` +
            `cancels (preventDefault / stopPropagation). PROHIBITED BEHAVIOUR: suppressing browser or page ` +
            `behaviour over the Rail Map. The Rail Map may use the wheel for a real interaction -- a map ` +
            `zoom, a scrub -- but not to take the gesture away from the reader. See #1619; #67's "scroll ` +
            `containment" never contained anything, because React registers the delegated wheel listener ` +
            `as passive.`,
        );
      }
    }
  }

  // (2) Global listeners that CAN cancel. A listener registered `{ passive: true }` provably cannot.
  sources.forEach((file) => {
    const pattern = new RegExp(`(${GLOBAL_TARGETS})\\s*\\.addEventListener\\(\\s*["']([a-zA-Z]+)["']`, "g");
    let match = pattern.exec(file.code);
    while (match !== null) {
      const event = match[2].toLowerCase();
      if (ZOOM_CAPABLE_EVENTS.indexOf(event) !== -1) {
        const call = file.code.slice(match.index, match.index + 320);
        const passive = /\{[^}]*passive\s*:\s*true/.test(call);
        if (!passive) {
          offences.push(
            `${file.rel}: ${match[1]}.addEventListener("${event}", ...) is registered NON-PASSIVELY. ` +
              `PROHIBITED BEHAVIOUR: a listener on a global target can cancel this gesture for the whole ` +
              `page, which is how a pinch lock or a zoom block gets written by accident. Scope it to the ` +
              `component that needs it, or pass { passive: true } so it provably cannot cancel.`,
          );
        }
      }
      match = pattern.exec(file.code);
    }
  });

  // (2b) The shell, element-side. A wheel prop on the room's own container is a document listener by another route.
  sources.forEach((file) => {
    if (SHELL_FILES.indexOf(file.rel) === -1) return;
    if (!/onWheel\s*=/.test(file.code)) return;
    offences.push(
      `${file.rel}: an onWheel prop in the game-room shell. PROHIBITED BEHAVIOUR: a wheel handler on the ` +
        `room's own container covers every surface inside it, so it is a global canceller wearing an ` +
        `element's clothes. Put it on the component that uses the wheel.`,
    );
  });

  return offences;
}

describe("nothing cancels a zoom gesture out from under the reader", () => {
  it("has no prohibited wheel installation anywhere in the tree", () => {
    /* Joined into one string so a failure PRINTS the offending location and the behaviour that is
       prohibited, rather than a bare array diff that reads as "wheel handlers are banned". */
    expect(wheelOffences(SOURCES).join("\n")).toBe("");
  });

  it("permits a scoped wheel interaction in any other component", () => {
    /* THE CASE THAT KEEPS THIS RULE HONEST, and the reason the previous version of it was wrong. A chart
       with a wheel-scrub, a horizontal scroller, a slider -- all normal, all local, none of this rule's
       business. Proven by running the rule against them rather than by promising it in a comment. */
    const legitimate: WheelSource[] = [
      { rel: "components/SomeChart.tsx", code: "<svg onWheel={handleScrub} />" },
      {
        rel: "components/SomeScroller.tsx",
        code: 'track.current.addEventListener("wheel", onWheel, { passive: false });',
      },
    ];
    expect(wheelOffences(SOURCES.concat(legitimate)).join("\n")).toBe("");
  });

  it("catches each shape it exists to catch, and names it", () => {
    /* AN ABSENCE ASSERTION THAT CANNOT FAIL IS WORTH NOTHING. Each probe is the real shape of the defect:
       #1619's removed handler, a hand-rolled pinch lock, and a wheel prop on the room's own container. */
    const probes: WheelSource[] = [
      {
        rel: "components/HexGridRenderer.tsx",
        code: "const handleWheel = useCallback((event) => {\n  event.preventDefault();\n}, []);\n<canvas onWheel={handleWheel} />",
      },
      { rel: "utils/somewhere.ts", code: 'document.addEventListener("touchmove", block, { passive: false });' },
      { rel: "App.tsx", code: "<div onWheel={swallow} />" },
    ];
    for (const probe of probes) {
      const found = wheelOffences([probe]);
      expect(found.length).toBe(1);
      expect(found[0]).toContain(probe.rel);
      expect(found[0]).toContain("PROHIBITED BEHAVIOUR");
    }
  });

  it("does not flag a Rail Map wheel handler that does real work", () => {
    /* #1619 removed a handler because it ONLY cancelled, not because the canvas may never read a wheel. If a
       map zoom ever comes back, this rule must let it -- so that is asserted rather than assumed. */
    const realInteraction: WheelSource[] = [
      {
        rel: "components/HexGridRenderer.tsx",
        code: "const handleWheel = useCallback((event) => {\n  event.preventDefault();\n  setView(zoomBy(event.deltaY));\n}, []);\n<canvas onWheel={handleWheel} />",
      },
    ];
    expect(wheelOffences(realInteraction)).toEqual([]);
  });

  it("does not flag a global listener that provably cannot cancel", () => {
    /* `{ passive: true }` is the browser's own guarantee, not a promise in a comment: such a listener may
       observe a wheel and can never cancel it. The rule is about cancellation, so it lets this through. */
    const passiveObserver: WheelSource[] = [
      { rel: "utils/telemetry.ts", code: 'window.addEventListener("wheel", note, { passive: true });' },
    ];
    expect(wheelOffences(passiveObserver)).toEqual([]);
  });

  it("binds no keyboard shortcut a browser uses for zoom", () => {
    /* AN APP PROPERTY, STATED AS ONE: every modifier shortcut this app binds also requires Shift. That is
       checkable here and true today, and it is what keeps a bare `Ctrl+-` or `Cmd+0` handler from arriving --
       those are the combinations desktop browsers conventionally reserve for page zoom, and a shortcut that
       carries Shift cannot collide with one. What any particular browser actually does with a bare modifier
       is its own policy and is not asserted. A shortcut that genuinely needs a bare modifier gets a design
       note and an exception here, not a silent edit. */
    const offenders: string[] = [];
    SOURCES.forEach((f) => {
      const pattern = /(ctrlKey|metaKey)/g;
      let match = pattern.exec(f.code);
      while (match !== null) {
        const window_ = f.code.slice(Math.max(0, match.index - 200), match.index + 200);
        if (window_.indexOf("shiftKey") === -1) offenders.push(`${f.rel}: ${match[1]}`);
        match = pattern.exec(f.code);
      }
    });
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Regression 9 -- the precondition of the whole decision               */
/* ------------------------------------------------------------------ */

describe("the rail map still owns no gesture a pinch competes with", () => {
  /* THIS IS THE ARGUMENT, NOT A SIDE CHECK. Giving the pinch back is only safe because the canvas has
     nothing to lose to it: no pan, no pointer capture, no internal zoom, and a `pointercancel` handler
     already written for the browser taking a gesture over. If any one of those changes, the decision in
     #1618 has to be re-made rather than inherited -- so each is pinned here, by the property rather than by
     the line. The map's own behaviour (coordinate conversion, counter-zoom, backing store) is covered by its
     existing suites and is untouched by this pass. */
  const RENDERER = (() => stripComments(readSource("components/HexGridRenderer.tsx")))();

  it("never captures a pointer", () => {
    expect(RENDERER).not.toContain("setPointerCapture");
  });

  it("moves the view only on the fit pass", () => {
    expect(RENDERER.match(/setView\(/g)!.length).toBe(1);
    expect(RENDERER).toContain("setView(fitView);");
  });

  it("still cleans up after a gesture the browser takes over", () => {
    /* The handler a two-finger pinch now reaches: the first finger's press is cancelled rather than
       completed, and this is what stops that press being read as a tile selection. */
    expect(RENDERER).toContain("onPointerCancel={handlePointerCancel}");
  });

  it("still sizes its backing store from the device pixel ratio", () => {
    /* NOT A ZOOM READ, and named here so it is not mistaken for one in a later sweep. `devicePixelRatio` is
       the canvas's own resolution, nothing in this pass changed it, and no code anywhere derives a UI scale
       from it (#1450). */
    expect(RENDERER).toContain("window.devicePixelRatio || 1");
  });
});

/* ------------------------------------------------------------------ */
/* Regressions 7 and 8 -- the picker is a different mechanism           */
/* ------------------------------------------------------------------ */

describe("the app's scale picker is untouched by the pinch decision", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("still resolves a first run to 100%", () => {
    /* #1450, asserted behaviourally rather than by reading the expression. Browser zoom returning does not
       make the app's default a guess again -- these are separate mechanisms and this is the case that says
       so out loud. `uiScaleDefault.test.ts` is the exhaustive version, across eleven widths. */
    expect(storedUiScale()).toBeNull();
    expect(resolveUiScale()).toBe(1);
    expect(UI_SCALE_DEFAULT).toBe(1);
  });

  it("still lets an explicit preference win", () => {
    window.localStorage.setItem(UI_SCALE_STORAGE_KEY, "1.25");
    expect(resolveUiScale()).toBe(1.25);
  });

  it("still offers the same six steps in the same order", () => {
    /* `snapUiScale` coerces every stored value onto this ladder, so editing it silently re-maps every saved
       preference in the world. Pinned as the whole array because that is the unit of damage. */
    expect(UI_SCALE_STEPS.slice()).toEqual([0.63, 0.75, 0.9, 1, 1.1, 1.25]);
  });
});
