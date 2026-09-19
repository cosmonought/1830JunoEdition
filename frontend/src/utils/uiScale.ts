// frontend/src/utils/uiScale.ts
//
// How large THIS browser draws the chrome.
//
/* ==================================================================
 *  DESIGN NOTE 1273: THE THIRD READING, AND THE PICKER #1149 SAID IT WOULD EARN
 * ==================================================================
 *
 * REPORTED: "Everything is way too small." One player needed 250% browser zoom. And the reporter's own screen
 * reads correctly -- which is exactly what makes this easy to dismiss, and exactly what #1149 predicted:
 * "this is a per-reader preference being fitted by successive approximation from here. TWICE IS THE SIGNAL
 * FOR THE PICKER. If a third reading moves it again, the follow-up ruled out above has earned its place."
 * This is the third reading.
 *
 * THE CONSTANT WAS FITTED TO ONE MONITOR. 0.63 (#1149) reproduces one playtester's browser zoom on one
 * screen; on a smaller or denser display it draws 13px body text at eight pixels, and 250% is what it takes
 * to read eight-pixel type. No single number is right for two screens, because the thing being fitted is
 * the READER, not the app.
 *
 * SO THE SCALE IS A PREFERENCE WITH A SENSIBLE DEFAULT. Three parts:
 *   - `defaultUiScaleFor(width)` guesses from the window: #1149's 0.63 on the wide monitors it was read
 *     from, the full 1.0 on a laptop, a straight line between. A guess, and only the first one.
 *     -- WITHDRAWN BY #1450 BELOW. The guess is gone; the default is 1.0 at every width.
 *   - `readUiScale()` prefers what this browser has chosen, in `localStorage` for #1239's reason -- a viewing
 *     choice belongs to the viewer and to their next game too.
 *   - the picker in `TopBar` writes the choice and RELOADS. The scale is baked into style tables at module
 *     load (`CHROME_ZOOM`, `boardPane`, the lobby's scene), and re-evaluating every one of them live would
 *     touch every surface #1144 argued about; a reload is one line, the log makes it survivable (#1250,
 *     #1253), and a text-size control is pressed once per browser, not once per turn.
 *     -- SUPERSEDED BY #1294: the scale is a store and nothing reloads.
 *
 * ==================================================================
 *  DESIGN NOTE 1450: THE GUESS IS WITHDRAWN -- A FIRST RUN IS 100%
 * ==================================================================
 *
 * #1273 kept the fitted constant alive as a DEFAULT, interpolated by window width: 1.0 at 1200px and below,
 * 0.63 at 1800 and above. An audit measured what that produces on a clean first run, and the numbers are the
 * argument. A real 13px label renders at 13.0px up to 1280, 11.7px at 1366-1440, 9.75px at 1536, and
 * 8.19px at 1920 and 2560 -- and 20 / 8.19 is almost exactly the 250% one player reported needing.
 *
 * THE SIGNAL WAS NEVER CAPABLE OF MEANING WHAT IT WAS ASKED TO MEAN. `window.innerWidth` counts CSS pixels,
 * and CSS pixels are precisely the quantity that OS display scaling and browser zoom have ALREADY normalised.
 * A 2560-wide viewport is a large monitor at 100% OS scaling, or a small one the reader has zoomed out of, and
 * the guess shrank both. Worse, the two compose as a product (#1149's own derivation), and zooming OUT raises
 * `innerWidth`, which lowered the scale again: the compensation a reader reached for made the problem worse
 * than proportionally.
 *
 * AND IT CONTRADICTED A RULE THIS CODEBASE HAD ALREADY WRITTEN DOWN. `public/index.html`, on why the root
 * font-size is not a `vw` multiplier: "a bigger screen should show MORE at the same size, not the same amount
 * larger." The width guess did the opposite -- more screen, everything smaller.
 *
 * SO THE DEFAULT IS 1.0 AND NOTHING READS THE WIDTH. Responsive layout decides what to do with the extra
 * space; the scale decides how big a pixel is, and only the reader decides that. 0.63 KEEPS ITS PLACE as the
 * bottom step of the ladder -- it was a real reading from a real screen and someone will want it -- but it is
 * a destination now, not a starting point.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: infer anything from `devicePixelRatio`, `screen.width` or a physical-DPI
 * calibration. The audit measured DPR 1, 1.25, 1.5 and 2 at three widths and the app ignored all of them,
 * correctly. A first run that guesses is the thing being removed, not the thing being improved.
 *
 * WHY NOT `rem`. `typography.ts` #3 records it: every style here is an inline object with explicit pixels
 * and form controls do not inherit, so a root font-size reaches nothing. And a player at 250% BROWSER zoom
 * is scaling pixels and rems alike -- what they were reaching for was a bigger chrome, which is this. */

/** #1149's reading, from one real screen. #1450: it is the ladder's BOTTOM STEP, not a default -- a density
 *  a reader can choose, and the app never chooses for them. */
export const UI_SCALE_DESIGN = 0.63;

/** #1450: what a browser with no stored choice draws at, at every width. */
export const UI_SCALE_DEFAULT = 1;

/** The steps the picker offers, unchanged: [0.63, 0.75, 0.9, 1, 1.1, 1.25]. #1149's figure, then Chrome's own
 *  zoom stops upward, so a player who has been compensating with the browser can find the same feel here.
 *  SPELLED THROUGH THE TWO CONSTANTS at the ends that mean something, so neither can drift away from the
 *  ladder it belongs to: the fitted reading is a step, and the default is a step. */
export const UI_SCALE_STEPS: readonly number[] = [UI_SCALE_DESIGN, 0.75, 0.9, UI_SCALE_DEFAULT, 1.1, 1.25];

/** Persisted per browser. Namespaced like every other key (`appNaming` #1). */
export const UI_SCALE_STORAGE_KEY = "1830juno.ui_scale.v1";

/** The nearest offered step, so a stored or computed value always lands on something the picker shows. */
export function snapUiScale(value: number): number {
  return UI_SCALE_STEPS.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best,
  );
}

export function storedUiScale(): number | null {
  try {
    const raw = window.localStorage.getItem(UI_SCALE_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? snapUiScale(parsed) : null;
  } catch {
    return null;
  }
}

export function storeUiScale(scale: number): void {
  try {
    window.localStorage.setItem(UI_SCALE_STORAGE_KEY, String(snapUiScale(scale)));
  } catch {
    /* A browser that refuses storage refuses the preference; the default stands. */
  }
}

/** What this browser draws at: its choice, else 1.0. Nothing here reads the window (#1450) -- the guard is
 *  only so a non-browser caller gets the same answer as a browser with nothing stored. */
export function resolveUiScale(): number {
  if (typeof window === "undefined") return UI_SCALE_DEFAULT;
  return storedUiScale() ?? UI_SCALE_DEFAULT;
}

/* ==================================================================
    DESIGN NOTE 1294: LIVE, NOT RELOADED
   ==================================================================
   REPORTED (2): "Clicking the zoom - or + causes the whole screen to flash black before loading the page. It
   seems to be reloading the page because it cuts off the radio." #1273 chose the reload because the scale was
   baked into style tables at module load; the report is the cost of that choice, and it was rejected. So the
   scale is a tiny store now: one number, a subscriber list, and a hook. Every surface that draws with it
   reads it at render (`useUiScale`) or at the moment it measures (`getUiScale`), and the picker writes it.
   Nothing reloads, the radio plays on, and the whole app re-lays out under the new zoom in one frame.
   `UI_SCALE` in `appStyles` is still exported -- as the value at load, for the tests that pin the design
   figure and for any reader that genuinely wants the initial value -- but nothing that draws should read it
   any more; `uiScale.test.ts` says which readers may. */
let current = resolveUiScale();
const listeners = new Set<() => void>();

export function getUiScale(): number {
  return current;
}

export function setUiScale(scale: number): void {
  const next = snapUiScale(scale);
  if (next === current) return;
  current = next;
  storeUiScale(next);
  listeners.forEach((listener) => listener());
}

export function subscribeUiScale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: put the store back to the resolved value. */
export function resetUiScaleForTests(): void {
  current = resolveUiScale();
  listeners.forEach((listener) => listener());
}
