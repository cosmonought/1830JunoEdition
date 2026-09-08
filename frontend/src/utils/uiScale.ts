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
 *   - `readUiScale()` prefers what this browser has chosen, in `localStorage` for #1239's reason -- a viewing
 *     choice belongs to the viewer and to their next game too.
 *   - the picker in `TopBar` writes the choice and RELOADS. The scale is baked into style tables at module
 *     load (`CHROME_ZOOM`, `boardPane`, the lobby's scene), and re-evaluating every one of them live would
 *     touch every surface #1144 argued about; a reload is one line, the log makes it survivable (#1250,
 *     #1253), and a text-size control is pressed once per browser, not once per turn.
 *
 * WHY NOT `rem`. `typography.ts` #3 records it: every style here is an inline object with explicit pixels
 * and form controls do not inherit, so a root font-size reaches nothing. And a player at 250% BROWSER zoom
 * is scaling pixels and rems alike -- what they were reaching for was a bigger chrome, which is this. */

/** The design scale -- #1149's reading, kept as the figure the wide-monitor default is. */
export const UI_SCALE_DESIGN = 0.63;

/** The steps the picker offers. #1149's figure, then Chrome's own zoom stops upward, so a player who has
 *  been compensating with the browser can find the same feel here. */
export const UI_SCALE_STEPS: readonly number[] = [0.63, 0.75, 0.9, 1, 1.1, 1.25];

/** Persisted per browser. Namespaced like every other key (`appNaming` #1). */
export const UI_SCALE_STORAGE_KEY = "1830juno.ui_scale.v1";

/** The nearest offered step, so a stored or computed value always lands on something the picker shows. */
export function snapUiScale(value: number): number {
  return UI_SCALE_STEPS.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best,
  );
}

/** The first guess, from the window's CSS width: 0.63 at 1800px and above, 1.0 at 1200px and below. */
export function defaultUiScaleFor(viewportWidthPx: number): number {
  const wide = 1800;
  const narrow = 1200;
  if (!Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0) return UI_SCALE_DESIGN;
  const t = Math.min(1, Math.max(0, (viewportWidthPx - narrow) / (wide - narrow)));
  return snapUiScale(1 - t * (1 - UI_SCALE_DESIGN));
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

/** What this browser draws at: its choice, else the guess. Outside a browser, the design figure. */
export function resolveUiScale(): number {
  if (typeof window === "undefined") return UI_SCALE_DESIGN;
  return storedUiScale() ?? defaultUiScaleFor(window.innerWidth);
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
