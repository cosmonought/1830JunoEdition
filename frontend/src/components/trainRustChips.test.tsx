/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE (VF-7 harness): WHAT THE CHIP ROW ACTUALLY HOLDS, FRAME BY FRAME
// ==================================================================
//
// `trainRustFlourish.test.ts` owns the trigger, the schedule and the crack. This owns the four things
// only a rendered row can answer:
//
//   1. A-2: the row shows the fleet AS IT WAS while the doomed chips die, even though the authoritative
//      roster it was handed has already lost them. The hard case is a corporation whose WHOLE fleet
//      rusts -- without staging the row would print "none" before anything was shown to fail.
//   2. THE SLOT IS HELD UNTIL THE CHIP IS GONE, and the survivors settle only afterwards.
//   3. THE SURVIVORS ARE UNTOUCHED THROUGHOUT -- same models, same order, no rust class, no crack.
//   4. REDUCED MOTION loses the shudder and the propagation and keeps the information.
//
// AND NOTHING LEAVES THE ROW: `document.body` gains no child beyond this suite's own mount host, which
// is A-1 (no portal, no fixed-position escape, no second fleet renderer).

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { TrainChips } from "./TrainBadges";
import {
  RUST_FRACTURE_AT_MS,
  RUST_REDUCED_FRACTURE_AT_MS,
  RUST_REDUCED_TOTAL_MS,
  RUST_REDUCED_VACATE_AT_MS,
  RUST_TOTAL_MS,
  RUST_VACATE_AT_MS,
  type RustFlourishEvent,
} from "./trainRustFlourish";
import { derivePhase } from "../gameEngine/gamePhase";
import { resolveVariants } from "../gameEngine/gameVariants";
import type { GameStateResponse } from "../gameEngine/gameState";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const PRR = 1;
const BO = 4;
let reducedMotion = false;

/** Phase 4 -- the first phase with a rust in it. */
const PHASE = derivePhase({
  variants: resolveVariants({}),
  returned_trains: [],
  public_companies: [{ company_id: PRR, owned_trains: ["4"] }],
} as unknown as GameStateResponse);

const event = (
  corporations: RustFlourishEvent["corporations"],
  token = 1,
): RustFlourishEvent => ({ corporations, token });

describe("a rusting corporation's chip row", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = (
    trains: readonly string[],
    rust: RustFlourishEvent | null,
    companyId: number | null = PRR,
  ) => {
    act(() => {
      root.render(
        <TrainChips
          trains={trains}
          phase={PHASE}
          surface="dark"
          companyId={companyId}
          rust={rust}
        />,
      );
    });
  };
  const tick = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });

  /* ==================================================================
      THE ROW'S OWN CHILDREN, NOT `host.textContent`
     ==================================================================
     The chip row injects its stylesheet as a `<style>` child, and `textContent` happily returns the CSS
     -- so `expect(row()).not.toContain("2")` passed against `rgba(107, 63, 42, 0.85)` rather than
     against any chip. Found by running it, and it is the same vacuity #886 records for backwards
     slices: an assertion reading a region it is not about. The chips are the row's direct `<span>`
     children, which is true of the placeholder too. */
  const rowEl = () => host.firstElementChild as HTMLElement | null;
  const chips = () =>
    Array.from(rowEl()?.children ?? []).filter((node) => node.tagName === "SPAN") as HTMLElement[];
  /* ==================================================================
      AMENDED BY THE AUDIO WIRING PASS: A CHIP IS NOT AN ELEMENT ANY MORE
     ==================================================================
     THE VISUAL CHANGE THESE HELPERS ABSORB. `rust.mp3` is a brittle break plus a clatter of secondary
     fragments, and the audit that came with it found VF-7's failure phase moving the chip as ONE intact
     object -- the sound described a thing the picture did not do. So at the `fail` beat a chip now gives
     way along the crack it was just drawn, into two or three clipped pieces.
     EVERY COUNT BELOW HAD TO SAY WHICH IT MEANT. "Two chips are rusting" and "six elements carry the rust
     class" were the same sentence while a chip was one element and are now different claims, and it is
     the first one every case in this file was ever making. So the helpers count CHIPS -- a shattered chip
     is one chip drawn three times -- and the element-level query stays available under its own name for
     the cases that really are about classes.
     AND `row()` READS WHAT A PLAYER IS TOLD, dropping what is hidden from the accessibility tree, which
     is VF-8's own correction arriving here for the same reason: `textContent` over a chip in three pieces
     returns "222". The pieces after the first are `aria-hidden` precisely so one chip is not read out as
     three trains, and measuring through that makes this file check it on every frame. */
  const readable = (chip: HTMLElement) => {
    const copy = chip.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
    return copy.textContent ?? "";
  };
  const row = () => chips().map(readable).join("|");
  const rusting = () => Array.from(host.querySelectorAll(".app-train-rusting"));
  const cracks = () => Array.from(host.querySelectorAll(".app-train-rust-crack"));
  const failing = () => Array.from(host.querySelectorAll(".app-train-rust-failing"));
  /** One entry per rusting CHIP, whether it is whole or in pieces. */
  const rustingChips = () => [
    ...Array.from(host.querySelectorAll(".app-train-rust-shatter")),
    ...rusting().filter((node) => !node.classList.contains("app-train-rust-shard")),
  ];
  const failingChips = () => [
    ...Array.from(host.querySelectorAll(".app-train-rust-shatter")),
    ...failing().filter((node) => !node.classList.contains("app-train-rust-shard")),
  ];
  /** One entry per chip showing a fracture, however many pieces are carrying a copy of it. */
  const crackedChips = () =>
    chips().filter((chip) => chip.querySelector(".app-train-rust-crack") !== null);

  beforeEach(() => {
    jest.useFakeTimers();
    reducedMotion = false;
    (window as unknown as { matchMedia: (query: string) => { matches: boolean } }).matchMedia = (
      query: string,
    ) => ({ matches: reducedMotion, media: query } as unknown as { matches: boolean });
    host = document.createElement("div");
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    jest.useRealTimers();
  });

  describe("no event", () => {
    it("is the ordinary row", () => {
      render(["3", "4"], null);
      expect(row()).toContain("3");
      expect(row()).toContain("4");
      expect(rusting()).toHaveLength(0);
      expect(cracks()).toHaveLength(0);
      expect(host.querySelector("style")).toBeNull();
      expect(document.body.children).toHaveLength(1);
    });

    it("ignores an event that names a different corporation", () => {
      render(["3"], event([{ companyId: BO, ticker: "B&O", before: ["2", "3"], rusted: ["2"] }]));
      expect(rusting()).toHaveLength(0);
      expect(row()).not.toContain("2");
    });
  });

  describe("a standard rust (full motion)", () => {
    /* The authoritative roster has ALREADY lost the 2-trains: PRR held ["2","2","3"] and holds ["3"]. */
    const play = () =>
      render(
        ["3"],
        event([{ companyId: PRR, ticker: "PRR", before: ["2", "2", "3"], rusted: ["2", "2"] }]),
      );

    it("stages the fleet as it was, and rusts exactly the chips that are leaving", () => {
      play();
      expect(chips()).toHaveLength(3);
      // MULTIPLICITY: two 2-trains rusting, the 3 untouched.
      expect(rusting()).toHaveLength(2);
      expect(row()).toContain("3");
      expect(document.body.children).toHaveLength(1);
    });

    it("keeps the survivor out of it, all the way through", () => {
      play();
      for (let elapsed = 0; elapsed < RUST_VACATE_AT_MS; elapsed += 20) {
        // Three chips, two of them rusting, for every frame the staged roster is up.
        expect(chips()).toHaveLength(3);
        // AMENDED: by chip, not by element -- after the fail beat each of these is in pieces.
        expect(rustingChips()).toHaveLength(2);
        tick(20);
      }
    });

    it("cracks at the fracture beat, not before", () => {
      play();
      expect(cracks()).toHaveLength(0);
      tick(RUST_FRACTURE_AT_MS);
      expect(cracks()).toHaveLength(2);
      expect(host.querySelectorAll(".app-train-rust-crack-drawing")).toHaveLength(2);
      // The model is still readable through the fracture -- the crack draws over it, it does not replace it.
      expect(row()).toContain("2");
    });

    it("holds the slot while the chip fails, and closes the row only afterwards", () => {
      play();
      tick(RUST_VACATE_AT_MS - 1);
      // Failing, invisible by the keyframe's end -- and STILL THREE CHIPS. The survivors have not moved.
      // AMENDED: two failing CHIPS, now several elements each. The slot rule is what this case is about
      // and it is untouched -- the wrapper is in the row's flow exactly where the whole chip was.
      expect(failingChips()).toHaveLength(2);
      expect(chips()).toHaveLength(3);
      tick(1);
      // The staged roster is dropped in one instant; the row is now the authoritative one.
      expect(chips()).toHaveLength(1);
      expect(row()).toContain("3");
      expect(row()).not.toContain("2");
    });

    it("settles into a row indistinguishable from the ordinary one", () => {
      play();
      tick(RUST_TOTAL_MS);
      /* THE SHELL WITHDRAWS THE EVENT ON ITS OWN CLOCK (`RUST_TOTAL_MS`), and the row must not twitch
         when it does -- so the comparison is against the same component with no event at all, which is
         what it renders for the rest of the game. */
      render(["3"], null);
      const settled = host.innerHTML;
      render(["3"], null);
      expect(settled).toBe(host.innerHTML);
      expect(rusting()).toHaveLength(0);
      expect(host.querySelector("style")).toBeNull();
    });
  });

  describe("a corporation that loses its whole fleet", () => {
    it("does not print 'none' before anything has been shown to fail", () => {
      /* THE CASE THE EARLY RETURN WOULD HAVE LOST. `trains` is `[]` the instant the reducer settles, and
         the row's own placeholder would have taken over on the first frame -- the chips gone with no
         destruction shown at all, which is the staging A-2 forbids. */
      render(["2"], null); // sanity: what the row shows before the rust
      render([], event([{ companyId: PRR, ticker: "PRR", before: ["2", "2"], rusted: ["2", "2"] }]));
      expect(row()).not.toContain("none");
      expect(rusting()).toHaveLength(2);
      tick(RUST_VACATE_AT_MS);
      // ONLY NOW does the row admit there is nothing left.
      expect(row()).toContain("none");
    });
  });

  describe("duplicate models: one occurrence dies, the other does not flinch", () => {
    /* ==================================================================
        THE CASE WHERE THE CHIPS ARE INDISTINGUISHABLE
       ==================================================================
       before ["3", "3", "5"], rust ["3"], after ["3", "5"]. Nothing on screen tells the two 3-trains
       apart, so every guarantee here is about CONTINUITY rather than about which one was chosen -- the
       choice is semantically arbitrary and the presentation must not be.
       NODE IDENTITY IS THE SUBJECT, not the rendered text: two chips both printing "3" look identical
       whether React kept the survivor's element or quietly swapped in the dying one, so a text
       assertion cannot tell a correct handover from the bug this suite exists to pin. Each chip is
       tagged with an own-property on its DOM node -- something React cannot recreate -- and the tags
       are read back across the boundary. */
    const DUPLICATES: RustFlourishEvent = event([
      { companyId: PRR, ticker: "PRR", before: ["3", "3", "5"], rusted: ["3"] },
    ]);
    type Tagged = HTMLElement & { __chipTag?: string };
    const tag = () => chips().forEach((chip, i) => ((chip as Tagged).__chipTag = `staged${i}`));
    const tags = () => chips().map((chip) => (chip as Tagged).__chipTag);

    const play = () => render(["3", "5"], DUPLICATES);

    it("rusts exactly one of the two, and the same one on every stage render", () => {
      play();
      expect(chips()).toHaveLength(3);
      expect(rusting()).toHaveLength(1);
      tag();
      /* THE CHOICE DOES NOT DRIFT. `rustingPositions` is recomputed on every render -- it is not
         memoised -- so a non-deterministic match would show up as the rust class moving between chips
         as the stages advance. Sampled every 20ms for the whole staged period. */
      for (let elapsed = 0; elapsed < RUST_VACATE_AT_MS; elapsed += 20) {
        /* AMENDED: a chip in pieces wears the shatter wrapper rather than the rust class itself, so the
           test asks "is this chip in the event" rather than "does this element carry that string". The
           claim is unchanged and is the one that matters: the marked chip is always `staged0`. */
        const marked = chips().filter(
          (chip) =>
            chip.className.includes("app-train-rusting") ||
            chip.className.includes("app-train-rust-shatter"),
        );
        expect(marked).toHaveLength(1);
        expect((marked[0] as Tagged).__chipTag).toBe("staged0");
        tick(20);
      }
    });

    it("leaves the other 3 and the 5 untouched throughout", () => {
      play();
      tag();
      for (let elapsed = 0; elapsed < RUST_VACATE_AT_MS; elapsed += 20) {
        expect(tags()).toEqual(["staged0", "staged1", "staged2"]);
        expect(row()).toBe("3|3|5");
        // Neither survivor ever takes a rust class or a crack.
        expect(chips()[1].className).not.toContain("app-train-rust");
        expect(chips()[2].className).not.toContain("app-train-rust");
        /* THE CRACK SPECIFICALLY -- every chip carries the locomotive glyph, which is also an `svg`.
           The first draft asserted `querySelector("svg")` and failed on `TrainGlyph`; the property was
           always about the fracture overlay. */
        expect(chips()[1].querySelector(".app-train-rust-crack")).toBeNull();
        expect(chips()[2].querySelector(".app-train-rust-crack")).toBeNull();
        tick(20);
      }
    });

    it("cracks exactly one chip, with a seed that does not move between stages", () => {
      play();
      tick(RUST_FRACTURE_AT_MS);
      expect(cracks()).toHaveLength(1);
      const drawn = () => host.querySelector(".app-train-rust-crack path")?.getAttribute("d") ?? null;
      const first = drawn();
      expect(first).not.toBeNull();
      /* Into the failure stage: same chip, same fracture. A re-seeded crack would redraw itself here.
         AMENDED: one cracked CHIP. Once it is in pieces each piece carries its own clipped copy of the
         overlay -- which is what keeps the fracture visible ON the pieces as they drift rather than
         vanishing the instant the chip gives way -- so the element count is the piece count and the
         claim this case makes is about the chip. The `d` check is the real subject and is untouched:
         every copy is the same path, from the same seed. */
      tick(RUST_VACATE_AT_MS - RUST_FRACTURE_AT_MS - 1);
      expect(crackedChips()).toHaveLength(1);
      expect(drawn()).toBe(first);
      const everyCopy = Array.from(host.querySelectorAll(".app-train-rust-crack path")).map((node) =>
        node.getAttribute("d"),
      );
      expect(new Set(everyCopy).size).toBe(1);
    });

    it("reserves exactly one slot, and gives up exactly that one", () => {
      play();
      tag();
      tick(RUST_VACATE_AT_MS - 1);
      // Three slots still held; the dying chip is invisible but has not vacated.
      // AMENDED: one failing CHIP, in pieces by now, still occupying exactly the one slot it had.
      expect(chips()).toHaveLength(3);
      expect(failingChips()).toHaveLength(1);
      tick(1);
      expect(chips()).toHaveLength(2);
      expect(row()).toBe("3|5");
    });

    it("keeps the survivors' own DOM nodes across the handover", () => {
      /* ==================================================================
          THE DEFECT THIS CASE WAS WRITTEN FROM
         ==================================================================
         `key={model-index}` named a position in whichever array was being rendered, and the staged and
         authoritative arrays are different lengths -- so at the handover React matched the staged `3-0`
         (the DYING chip) to the authoritative `3-0` (the SURVIVOR), unmounted the survivor's own node,
         and remounted the untouched 5 because its key moved from `5-2` to `5-1`. Measured with exactly
         this probe before the fix: the post-vacate tags read `["staged0", undefined]`.
         Keying a staged survivor by the index it will OCCUPY makes the handover unmount only what died. */
      play();
      tag();
      expect(tags()).toEqual(["staged0", "staged1", "staged2"]);
      tick(RUST_VACATE_AT_MS);
      // The survivor 3 is its own node, and the untouched 5 was never rebuilt.
      expect(tags()).toEqual(["staged1", "staged2"]);
      expect(row()).toBe("3|5");
    });

    it("settles to the authoritative roster and nothing else", () => {
      play();
      tick(RUST_TOTAL_MS);
      expect(row()).toBe("3|5");
      expect(rusting()).toHaveLength(0);
      expect(cracks()).toHaveLength(0);
      render(["3", "5"], null);
      expect(row()).toBe("3|5");
      expect(host.querySelector("style")).toBeNull();
    });

    it("keys the ordinary row exactly as it always did", () => {
      /* THE CONTROL ON THE FIX. With nothing rusting, the survivor counter and the position advance
         together, so the key is byte-identical to the pre-VF-7 one -- which is what keeps this change
         invisible to every row that is not in a rust event. Asserted as node identity across an
         ordinary re-render: a changed key would remount. */
      render(["3", "3", "5"], null);
      tag();
      render(["3", "3", "5"], null);
      expect(tags()).toEqual(["staged0", "staged1", "staged2"]);
    });
  });

  describe("several corporations, one event", () => {
    it("runs both rows off the same clock", () => {
      const shared = event([
        { companyId: PRR, ticker: "PRR", before: ["2", "3"], rusted: ["2"] },
        { companyId: BO, ticker: "B&O", before: ["2"], rusted: ["2"] },
      ]);
      const second = document.createElement("div");
      document.body.appendChild(second);
      let secondRoot: Root;
      act(() => {
        secondRoot = createRoot(second);
      });
      render(["3"], shared, PRR);
      act(() => {
        secondRoot.render(
          <TrainChips trains={[]} phase={PHASE} surface="dark" companyId={BO} rust={shared} />,
        );
      });
      // Both rows are staging at the same instant -- no per-corporation offset anywhere.
      expect(host.querySelectorAll(".app-train-rusting")).toHaveLength(1);
      expect(second.querySelectorAll(".app-train-rusting")).toHaveLength(1);
      tick(RUST_FRACTURE_AT_MS);
      expect(host.querySelectorAll(".app-train-rust-crack")).toHaveLength(1);
      expect(second.querySelectorAll(".app-train-rust-crack")).toHaveLength(1);
      tick(RUST_VACATE_AT_MS - RUST_FRACTURE_AT_MS);
      // And both give up their slots together.
      expect(host.querySelectorAll(".app-train-rusting")).toHaveLength(0);
      expect(second.querySelectorAll(".app-train-rusting")).toHaveLength(0);
      act(() => {
        secondRoot.unmount();
      });
      second.remove();
    });
  });

  describe("supersession", () => {
    it("restarts on a new token and leaves nothing of the first sequence behind", () => {
      render(["3"], event([{ companyId: PRR, ticker: "PRR", before: ["2", "3"], rusted: ["2"] }], 1));
      tick(RUST_FRACTURE_AT_MS);
      // An Undo back past the phase change, then the same purchase again.
      render(["4"], event([{ companyId: PRR, ticker: "PRR", before: ["3", "4"], rusted: ["3"] }], 2));
      expect(rusting()).toHaveLength(1);
      expect(cracks()).toHaveLength(0); // back at the start of the new sequence
      expect(row()).toContain("4");
      tick(RUST_TOTAL_MS);
      expect(rusting()).toHaveLength(0);
      expect(row()).toContain("4");
      expect(row()).not.toContain("3");
    });
  });

  describe("reduced motion", () => {
    beforeEach(() => {
      reducedMotion = true;
    });

    it("keeps the oxide and the crack, and loses the propagation", () => {
      render(["3"], event([{ companyId: PRR, ticker: "PRR", before: ["2", "3"], rusted: ["2"] }]));
      expect(rusting()).toHaveLength(1);
      tick(RUST_REDUCED_FRACTURE_AT_MS);
      expect(cracks()).toHaveLength(1);
      // The mark arrives whole -- #26: a cue that disappears under reduced motion is an information problem.
      expect(host.querySelectorAll(".app-train-rust-crack-drawing")).toHaveLength(0);
    });

    it("reaches the same settled row, sooner", () => {
      render(["3"], event([{ companyId: PRR, ticker: "PRR", before: ["2", "3"], rusted: ["2"] }]));
      tick(RUST_REDUCED_VACATE_AT_MS);
      expect(chips()).toHaveLength(1);
      expect(row()).toContain("3");
      tick(RUST_REDUCED_TOTAL_MS);
      expect(rusting()).toHaveLength(0);
      expect(RUST_REDUCED_TOTAL_MS).toBeLessThan(RUST_TOTAL_MS);
      expect(document.body.children).toHaveLength(1);
    });
  });
});
