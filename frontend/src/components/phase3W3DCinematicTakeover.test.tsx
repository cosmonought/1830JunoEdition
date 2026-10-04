/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W3-D (OD-15(a), AUD-13.05): THE TWO CINEMATICS ARE VIEWPORT TAKEOVERS, NOT DIALOGS
// ==================================================================
//
// THE RULING. The intro (`GameIntroOverlay`) and the end-game film (`GameOutroOverlay`) fill the visual viewport
// independently of the UI scale; the inverse-scale counter-zoom (`zoom: 1 / uiScale`) is gone and is NOT
// replaced by "scale like the modals"; neither is a `NativeModal`, a `<dialog>`, or carries dialog semantics or
// modal-panel chrome; and the game underneath cannot be interacted with while one is up.
//
// THE HARNESS REPRODUCES `GameRouter`'s TOPOLOGY, because the property under test is WHERE the layer lands
// relative to the scaled root: a screen root carrying `zoom: uiScale` (as `chromeZoomFor` does) and the same
// `inert` spread `App.tsx` puts on it, the overlay mounted INSIDE that root exactly as the shell mounts it, and
// `ModalLayerHost` as the root's sibling. The shell's own wiring is pinned against its source at the bottom.
//
// WHAT jsdom CANNOT SHOW, stated so nothing below pretends otherwise: it lays nothing out (no rects), applies
// no `zoom`, and does not enforce `inert`. So "fills the viewport" is asserted as the geometry contract and the
// absence of every scaled ancestor; "cannot be interacted with" as the `inert` attribute on the covered root
// with the takeover outside it. A real-browser pass at several scales is a Phase-4 observation.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import GameIntroOverlay from "./GameIntroOverlay";
import GameOutroOverlay from "./GameOutroOverlay";
import {
  CINEMATIC_TAKEOVER_ATTRIBUTE,
  CINEMATIC_TAKEOVER_GEOMETRY,
  cinematicTakeoverActive,
  inertWhileCovered,
} from "./CinematicTakeover";
import { ModalLayerHost, MODAL_LAYER_ATTRIBUTE } from "./ModalPortal";
import { NATIVE_MODAL_ATTRIBUTE } from "./NativeModal";
import { useUiScale } from "../utils/useUiScale";
import { UI_SCALE_STEPS, setUiScale, resetUiScaleForTests } from "../utils/uiScale";
import { readStripped, readShell, sliceBetween } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

type Outro = "playing" | "cued" | null;

/* The shell, reduced to the three things that matter here: the scaled root with the covered-root `inert`, a
   control on the board, and the overlay mounted inside the root. The modal layer is the root's sibling. */
let api: {
  setIntro: (on: boolean) => void;
  setOutro: (state: Outro) => void;
} | null = null;
let introDone = 0;
let outroCues = 0;

function Shell({ initialIntro, initialOutro }: { initialIntro: boolean; initialOutro: Outro }) {
  const uiScale = useUiScale();
  const [intro, setIntro] = useState(initialIntro);
  const [outro, setOutro] = useState<Outro>(initialOutro);
  api = { setIntro, setOutro };
  return (
    <>
      <div data-testid="shell-root" style={{ zoom: uiScale }} {...inertWhileCovered(cinematicTakeoverActive(intro, outro))}>
        <button type="button" data-testid="board-control">
          Lay track
        </button>
        {intro && (
          <GameIntroOverlay
            onDone={() => {
              introDone += 1;
              setIntro(false);
            }}
            sfxEnabled={false}
          />
        )}
        {outro !== null && (
          <GameOutroOverlay
            onCue={() => {
              outroCues += 1;
              setOutro("cued");
            }}
            cued={outro === "cued"}
            sfxEnabled={false}
          />
        )}
      </div>
      <ModalLayerHost />
    </>
  );
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(opts: { intro?: boolean; outro?: Outro } = {}) {
  introDone = 0;
  outroCues = 0;
  host = document.createElement("div");
  host.id = "root";
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<Shell initialIntro={opts.intro ?? false} initialOutro={opts.outro ?? null} />);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  api = null;
  act(() => resetUiScaleForTests());
  jest.useRealTimers();
});

const shellRoot = () => document.querySelector<HTMLElement>('[data-testid="shell-root"]')!;
const takeover = (testId: string) =>
  document.querySelector<HTMLElement>(`[${CINEMATIC_TAKEOVER_ATTRIBUTE}][data-testid="${testId}"]`);

const SURFACES = [
  { name: "intro", testId: "game-intro", file: "components/GameIntroOverlay.tsx", open: { intro: true } },
  { name: "end-game film", testId: "game-outro", file: "components/GameOutroOverlay.tsx", open: { outro: "playing" as Outro } },
] as const;

/** `zoom` is not in TypeScript 4.9's `CSSStyleDeclaration`, and jsdom keeps it only as the property React wrote. */
const zoomOf = (el: HTMLElement): string | undefined => (el.style as unknown as { zoom?: string }).zoom;

/** Every ancestor of `node` that carries a `zoom` of its own, up to the document. */
function zoomedAncestors(node: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let at = node.parentElement; at; at = at.parentElement) if (zoomOf(at)) out.push(at);
  return out;
}

describe.each(SURFACES)("the $name is a full-viewport takeover (OD-15(a))", ({ testId, file, open }) => {
  it("1. fills the viewport: a fixed box with every edge at zero, laid out against nothing scaled", () => {
    mount(open);
    const layer = takeover(testId)!;
    expect(layer).not.toBeNull();
    expect(layer.style.position).toBe("fixed");
    for (const edge of ["top", "right", "bottom", "left"] as const) expect([edge, layer.style[edge]]).toEqual([edge, "0px"]);
    /* Rendered OUTSIDE the shell's scaled root -- it is a child of <body>, not of the screen it covers. */
    expect(layer.parentElement).toBe(document.body);
    expect(shellRoot().contains(layer)).toBe(false);
    expect(zoomedAncestors(layer)).toEqual([]);
  });

  it("2. keeps the same viewport coverage at every UI scale, while the shell it covers rescales", () => {
    mount(open);
    const seen = new Set<string>();
    for (const step of UI_SCALE_STEPS) {
      act(() => setUiScale(step));
      const layer = takeover(testId)!;
      expect(zoomOf(shellRoot())).toBe(String(step)); // the chrome DID rescale...
      expect([step, Boolean(zoomOf(layer))]).toEqual([step, false]); // ...and the takeover did not follow it
      expect([step, zoomedAncestors(layer)]).toEqual([step, []]);
      expect([step, layer.parentElement === document.body]).toEqual([step, true]);
      seen.add(layer.style.cssText);
    }
    /* One geometry, byte for byte, across all six scales. */
    expect(seen.size).toBe(1);
  });

  it("3. carries no inverse-scale counter-zoom, and does not read the scale at all", () => {
    const source = readStripped(file);
    expect(source.includes("zoom")).toBe(false);
    expect(source.includes("useUiScale")).toBe(false);
    expect(source.includes("1 / uiScale")).toBe(false);
    expect(source.includes("<CinematicTakeover")).toBe(true);
  });

  it("4. is not a native dialog and claims no dialog semantics", () => {
    const showModal = jest.fn();
    const original = (HTMLElement.prototype as unknown as { showModal?: unknown }).showModal;
    (HTMLElement.prototype as unknown as { showModal?: unknown }).showModal = showModal;
    try {
      mount(open);
      const layer = takeover(testId)!;
      expect(layer.tagName).toBe("DIV");
      expect(layer.getAttribute("role")).not.toBe("dialog");
      expect(layer.getAttribute("role")).not.toBe("alertdialog");
      expect(layer.hasAttribute("aria-modal")).toBe(false);
      expect(layer.querySelector("dialog, [role='dialog'], [role='alertdialog'], [aria-modal]")).toBeNull();
      expect(document.querySelector(`[${NATIVE_MODAL_ATTRIBUTE}]`)).toBeNull();
      /* Not in the modal layer either -- that host is scaled chrome, and this is not chrome. */
      expect(layer.closest(`[${MODAL_LAYER_ATTRIBUTE}]`)).toBeNull();
      expect(showModal).not.toHaveBeenCalled();
    } finally {
      (HTMLElement.prototype as unknown as { showModal?: unknown }).showModal = original;
    }
    const source = readStripped(file);
    expect(source.includes("NativeModal")).toBe(false);
    expect(source.includes('role="dialog"')).toBe(false);
    expect(source.includes("aria-modal")).toBe(false);
  });

  it("5. has no modal-panel chrome or constrained sizing: the layer is the picture's ground, edge to edge", () => {
    mount(open);
    const layer = takeover(testId)!;
    for (const prop of ["width", "height", "maxWidth", "maxHeight", "margin", "padding", "border", "borderRadius", "boxShadow"] as const) {
      expect([prop, layer.style[prop]]).toEqual([prop, ""]);
    }
    /* The video fills that layer -- or, for the intro, the stage reproducing `contain` inside it. */
    const video = layer.querySelector("video")!;
    expect(video.style.width).toBe("100%");
    expect(video.style.height).toBe("100%");
  });

  it("6. takes the game underneath out of reach while up, and only while up", () => {
    mount(open);
    expect(shellRoot().hasAttribute("inert")).toBe(true);
    const layer = takeover(testId)!;
    /* The takeover itself, and the modal layer beside the root, are not covered by the attribute. */
    expect(layer.closest("[inert]")).toBeNull();
    expect(document.querySelector(`[${MODAL_LAYER_ATTRIBUTE}]`)!.closest("[inert]")).toBeNull();
    expect(document.querySelector('[data-testid="board-control"]')!.closest("[inert]")).toBe(shellRoot());
  });
});

describe("the takeover's covered-root rule (cinematicTakeoverActive / inertWhileCovered)", () => {
  it("covers the game for the intro, and for the outro only until the cue", () => {
    expect(cinematicTakeoverActive(true, null)).toBe(true);
    expect(cinematicTakeoverActive(false, "playing")).toBe(true);
    /* From the cue the Game Over dialog is up; `showModal()` blocks everything outside it, and the dialog must not
       be inside an inert root -- which it is not, being in the modal layer. */
    expect(cinematicTakeoverActive(false, "cued")).toBe(false);
    expect(cinematicTakeoverActive(false, null)).toBe(false);
    expect(inertWhileCovered(true)).toEqual({ inert: "" });
    expect(inertWhileCovered(false)).toEqual({});
  });

  it("the geometry cannot be overridden by an overlay's own surface style", () => {
    expect(CINEMATIC_TAKEOVER_GEOMETRY).toEqual({ position: "fixed", top: 0, right: 0, bottom: 0, left: 0 });
    expect(Object.isFrozen(CINEMATIC_TAKEOVER_GEOMETRY)).toBe(true);
    /* Merged AFTER the surface style, so a surface writing `position` would lose. */
    expect(readStripped("components/CinematicTakeover.tsx")).toContain("style={{ ...style, ...CINEMATIC_TAKEOVER_GEOMETRY }}");
  });
});

describe("7. the intro's playback and dismissal are unchanged", () => {
  it("Escape finishes it exactly once and lifts the cover", () => {
    mount({ intro: true });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(introDone).toBe(1);
    expect(takeover("game-intro")).toBeNull();
    expect(shellRoot().hasAttribute("inert")).toBe(false);
  });

  it("offers Skip after its delay, and Skip finishes it", () => {
    jest.useFakeTimers();
    mount({ intro: true });
    expect(document.querySelector(".app-intro-skip")).toBeNull();
    act(() => {
      jest.advanceTimersByTime(1800);
    });
    const skip = document.querySelector<HTMLButtonElement>(".app-intro-skip")!;
    expect(skip.textContent).toBe("Skip intro");
    /* The skip lives in the takeover, which is outside the inert root. */
    expect(skip.closest("[inert]")).toBeNull();
    act(() => skip.click());
    expect(introDone).toBe(1);
    expect(shellRoot().hasAttribute("inert")).toBe(false);
  });

  it("holds the last frame after the clip ends, shows the credit, then finishes", () => {
    jest.useFakeTimers();
    mount({ intro: true });
    const video = takeover("game-intro")!.querySelector("video")!;
    act(() => {
      video.dispatchEvent(new Event("ended"));
    });
    expect(takeover("game-intro")!.textContent).toContain("Powered by Neta DAO");
    expect(introDone).toBe(0);
    act(() => {
      jest.advanceTimersByTime(1280);
    });
    expect(introDone).toBe(1);
  });

  it("a clip that will not decode finishes at once, and the backstop finishes a clip that never ends", () => {
    mount({ intro: true });
    act(() => {
      takeover("game-intro")!.querySelector("video")!.dispatchEvent(new Event("error"));
    });
    expect(introDone).toBe(1);
    act(() => root?.unmount());
    host?.remove();
    jest.useFakeTimers();
    mount({ intro: true });
    act(() => {
      jest.advanceTimersByTime(18000);
    });
    expect(introDone).toBe(1);
  });
});

describe("7. the end-game film's cue and hand-off are unchanged", () => {
  it("Escape cues once; from the cue the skip goes, the film is hidden and muted, and the cover lifts", () => {
    jest.useFakeTimers();
    mount({ outro: "playing" });
    act(() => {
      jest.advanceTimersByTime(1200);
    });
    expect(document.querySelector(".app-outro-skip")).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(outroCues).toBe(1);
    const layer = takeover("game-outro")!;
    /* The film stays up under the modal -- it is not taken down at the cue (#1418). */
    expect(layer).not.toBeNull();
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.querySelector(".app-outro-skip")).toBeNull();
    expect(layer.querySelector("video")!.muted).toBe(true);
    expect(shellRoot().hasAttribute("inert")).toBe(false);
  });

  it("cues on the picture's clock, on Skip, and on the backstop", () => {
    jest.useFakeTimers();
    mount({ outro: "playing" });
    const video = takeover("game-outro")!.querySelector("video")!;
    Object.defineProperty(video, "currentTime", { configurable: true, value: 7.9 });
    act(() => {
      video.dispatchEvent(new Event("timeupdate"));
    });
    expect(outroCues).toBe(0);
    Object.defineProperty(video, "currentTime", { configurable: true, value: 8.0 });
    act(() => {
      video.dispatchEvent(new Event("timeupdate"));
    });
    expect(outroCues).toBe(1);

    act(() => root?.unmount());
    host?.remove();
    mount({ outro: "playing" });
    act(() => {
      jest.advanceTimersByTime(1200);
    });
    act(() => document.querySelector<HTMLButtonElement>(".app-outro-skip")!.click());
    expect(outroCues).toBe(1);

    act(() => root?.unmount());
    host?.remove();
    mount({ outro: "playing" });
    act(() => {
      jest.advanceTimersByTime(11000);
    });
    expect(outroCues).toBe(1);
  });

  it("an undecodable film falls back to its still and cues", () => {
    mount({ outro: "playing" });
    act(() => {
      takeover("game-outro")!.querySelector("video")!.dispatchEvent(new Event("error"));
    });
    expect(outroCues).toBe(1);
    expect(takeover("game-outro")!.querySelector("img")).not.toBeNull();
  });
});

describe("the shell wires the cover to its own root, and nowhere else", () => {
  const shell = readShell();
  it("spreads the covered-root inert on the scaled root, keyed on the intro and the outro", () => {
    const rootTag = sliceBetween(shell, "...chromeZoomFor(uiScale),", "<style>{TURN_PULSE_KEYFRAMES_CSS}</style>");
    expect(rootTag).toContain("{...inertWhileCovered(cinematicTakeoverActive(introPlaying, outro))}");
    expect(shell.split("inertWhileCovered(").length - 1).toBe(1);
    /* No other manual inert anywhere in the shell: OD-15(b) rules out a global inert system. */
    expect(shell.split("inert").length - 1).toBe(shell.split("inertWhileCovered").length - 1);
  });

  it("still mounts both films where it did, inside the shell's tree", () => {
    expect(shell).toContain("{introPlaying && (");
    expect(shell).toContain("<GameIntroOverlay");
    expect(shell).toContain('<GameOutroOverlay onCue={() => setOutro("cued")} cued={outro === "cued"} sfxEnabled={sfxEnabled} />');
  });
});
