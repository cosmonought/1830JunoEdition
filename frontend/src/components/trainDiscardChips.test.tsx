/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE (VF-8 harness): TWO HALVES OF ONE CHIP, AND THE SLOT THAT HOLDS THEM
// ==================================================================
//
// `trainDiscardFlourish.test.ts` owns the trigger, the schedule and the blade. This owns the four things
// only a rendered row can answer, and three of them are VF-7's questions asked of a different event:
//
//   1. A-2: the row shows the fleet AS IT WAS while the chosen chip is cut and carried off, even though
//      the authoritative roster it was handed has already lost it.
//   2. THE SPLIT IS TWO SIBLING ELEMENTS. A `clip-path` clips its descendants, so a chip clipped to its
//      own left half cannot contain its own right half -- the obvious arrangement is the one that cannot
//      work, and only a rendered row can prove the one that does.
//   3. NODE IDENTITY ACROSS THE HANDOVER. VF-7 shipped a defect here that only a DOM probe found: keys
//      naming a position in the STAGED array matched the dying chip to the surviving one. VF-8 adds a
//      second staging source to the same row, so the probe runs again against a discard.
//   4. REDUCED MOTION keeps the cut and loses the split.
//
// AND NOTHING LEAVES THE ROW (A-1): `document.body` gains no child beyond this suite's own mount host.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { TrainChips } from "./TrainBadges";
import {
  DISCARD_CUT_AT_MS,
  DISCARD_PART_AT_MS,
  DISCARD_REDUCED_CUT_AT_MS,
  DISCARD_REDUCED_TOTAL_MS,
  DISCARD_REDUCED_VACATE_AT_MS,
  DISCARD_TOTAL_MS,
  DISCARD_TRANSFER_AT_MS,
  DISCARD_VACATE_AT_MS,
  type TrainDiscardEvent,
} from "./trainDiscardFlourish";
import { derivePhase } from "../gameEngine/gamePhase";
import { resolveVariants } from "../gameEngine/gameVariants";
import type { GameStateResponse } from "../gameEngine/gameState";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const CO = 5;
const BO = 4;
let reducedMotion = false;

/** Phase 5 -- the limit is 2, which is the phase a discard is owed in. */
const PHASE = derivePhase({
  variants: resolveVariants({}),
  returned_trains: [],
  public_companies: [{ company_id: CO, owned_trains: ["5"] }],
} as unknown as GameStateResponse);

const event = (discard: TrainDiscardEvent["discard"], token = 1): TrainDiscardEvent => ({
  discard,
  token,
});

describe("a discarding corporation's chip row", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = (
    trains: readonly string[],
    discard: TrainDiscardEvent | null,
    companyId: number | null = CO,
  ) => {
    act(() => {
      root.render(
        <TrainChips
          trains={trains}
          phase={PHASE}
          surface="dark"
          companyId={companyId}
          discard={discard}
        />,
      );
    });
  };
  const tick = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });

  /* THE ROW'S OWN CHILDREN, NOT `host.textContent` -- VF-7's lesson, and it applies harder here: the row
     injects its stylesheet as a `<style>` child, and `textContent` returns the CSS happily enough that an
     assertion about a chip can pass against a keyframe. The chips are the row's direct `<span>` children,
     and during a split the chip's place is taken by a `.app-train-cut-slot` wrapper, which is one too. */
  const rowEl = () => host.firstElementChild as HTMLElement | null;
  const slots = () =>
    Array.from(rowEl()?.children ?? []).filter((node) => node.tagName === "SPAN") as HTMLElement[];
  /* ==================================================================
      THE ROW AS IT IS READ, NOT AS `textContent` RETURNS IT
     ==================================================================
     Found by running it. While the chosen chip is split, its slot holds BOTH halves, so a plain
     `textContent` reads a discarding 3 as "33" -- the duplicate half counted as a second train. That is
     the rendering working correctly and the measurement being wrong, and it is exactly the mistake the
     right half's `aria-hidden` exists to prevent for a screen reader. So the helper drops what is hidden
     from the accessibility tree before reading, which makes every row assertion below an assertion about
     what a PLAYER is told the fleet is -- and makes "the duplicate is not read out twice" something this
     file measures on every frame rather than states once. */
  const readable = (slot: HTMLElement) => {
    const copy = slot.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
    return copy.textContent ?? "";
  };
  const row = () => slots().map(readable).join("|");
  const blades = () => Array.from(host.querySelectorAll(".app-train-cut-line"));
  const falling = () => Array.from(host.querySelectorAll(".app-train-cut-line-falling"));
  const cutSlots = () => Array.from(host.querySelectorAll(".app-train-cut-slot"));
  const leaving = () => Array.from(host.querySelectorAll(".app-train-discard-leaving"));
  const tensing = () => Array.from(host.querySelectorAll(".app-train-discard-tensing"));

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
      expect(row()).toBe("3|4");
      expect(blades()).toHaveLength(0);
      expect(cutSlots()).toHaveLength(0);
      expect(host.querySelector("style")).toBeNull();
      expect(document.body.children).toHaveLength(1);
    });

    it("ignores a discard that names a different corporation", () => {
      render(["3"], event({ companyId: BO, ticker: "B&O", before: ["3", "4"], model: "4", at: 1 }));
      expect(row()).toBe("3");
      expect(blades()).toHaveLength(0);
    });

    it("shows nothing for an occurrence the staged roster cannot hold", () => {
      /* A-3: a blade over the wrong chip is worse than no blade. The sequence refuses to build, so the
         row falls straight through to the authoritative fleet. */
      render(["3", "4"], event({ companyId: CO, ticker: "C&O", before: ["3", "4"], model: "6", at: -1 }));
      expect(row()).toBe("3|4");
      expect(blades()).toHaveLength(0);
    });
  });

  describe("a discard (full motion)", () => {
    /* The authoritative roster has ALREADY lost the 4: C&O held ["3","3","4"] and holds ["3","3"]. */
    const play = () =>
      render(
        ["3", "3"],
        event({ companyId: CO, ticker: "C&O", before: ["3", "3", "4"], model: "4", at: 2 }),
      );

    it("stages the fleet as it was, and cuts exactly the chip the president chose", () => {
      play();
      expect(slots()).toHaveLength(3);
      expect(row()).toBe("3|3|4");
      expect(tensing()).toHaveLength(1);
      expect(document.body.children).toHaveLength(1);
    });

    it("holds the tension before the blade falls", () => {
      play();
      expect(blades()).toHaveLength(0);
      tick(DISCARD_CUT_AT_MS);
      expect(blades()).toHaveLength(1);
      expect(falling()).toHaveLength(1);
      // The model is still readable through the cut -- the blade draws over the chip, it does not replace it.
      expect(row()).toContain("4");
    });

    it("renders the two halves as SIBLINGS once it parts", () => {
      /* THE DEFECT THE ARRANGEMENT AVOIDS. `clip-path` clips an element AND its descendants, so a chip
         clipped to its own left half cannot contain its own right half. The slot is the chip's place in
         the row; the left half is in normal flow and keeps the slot the chip's size, and the right half
         is absolutely positioned over it. */
      play();
      tick(DISCARD_PART_AT_MS);
      expect(cutSlots()).toHaveLength(1);
      const slot = cutSlots()[0];
      const halves = Array.from(slot.children) as HTMLElement[];
      expect(halves).toHaveLength(2);
      expect(halves[0].className).toContain("app-train-cut-left");
      expect(halves[1].className).toContain("app-train-cut-right");
      // Siblings, not nested: neither contains the other.
      expect(halves[0].contains(halves[1])).toBe(false);
      expect(halves[1].contains(halves[0])).toBe(false);
      // And the duplicate is not read out twice -- one chip read twice is a chip that owns two trains.
      expect(halves[1].getAttribute("aria-hidden")).toBe("true");
      expect(halves[0].getAttribute("aria-hidden")).toBeNull();
    });

    it("keeps the survivors out of it, all the way through", () => {
      play();
      for (let elapsed = 0; elapsed < DISCARD_VACATE_AT_MS; elapsed += 20) {
        // Three slots, one of them the departing chip, for every frame the staged roster is up.
        expect(slots()).toHaveLength(3);
        expect(slots()[0].textContent).toContain("3");
        expect(slots()[1].textContent).toContain("3");
        expect(slots()[0].querySelector(".app-train-cut-line")).toBeNull();
        expect(slots()[1].querySelector(".app-train-cut-line")).toBeNull();
        tick(20);
      }
    });

    it("leaves as one movement, both halves together", () => {
      play();
      tick(DISCARD_TRANSFER_AT_MS);
      expect(leaving()).toHaveLength(2);
    });

    it("gives up the slot only after the chip has arrived", () => {
      play();
      tick(DISCARD_VACATE_AT_MS - 1);
      // Three slots still held; the departing chip is on its way but its place is reserved.
      expect(slots()).toHaveLength(3);
      tick(1);
      expect(slots()).toHaveLength(2);
      expect(row()).toBe("3|3");
    });

    it("settles to the authoritative roster and nothing else", () => {
      play();
      tick(DISCARD_TOTAL_MS);
      expect(row()).toBe("3|3");
      expect(blades()).toHaveLength(0);
      expect(cutSlots()).toHaveLength(0);
      render(["3", "3"], null);
      expect(host.querySelector("style")).toBeNull();
    });
  });

  describe("duplicate models: one copy leaves and the others never flicker", () => {
    /* VF-7's case, asked of a discard, and the reason it is asked again: the occurrence comes from the
       REDUCER here (`owned.indexOf`) rather than from a multiset match, so the thing to prove is that the
       row honours the position it was given and does not re-derive one. */
    const DUPLICATES = event({ companyId: CO, ticker: "C&O", before: ["3", "3", "5"], model: "3", at: 0 });
    type Tagged = HTMLElement & { __chipTag?: string };
    const tag = () => slots().forEach((slot, i) => ((slot as Tagged).__chipTag = `staged${i}`));
    const tags = () => slots().map((slot) => (slot as Tagged).__chipTag);

    const play = () => render(["3", "5"], DUPLICATES);

    it("cuts exactly one of the two, and the same one on every stage render", () => {
      play();
      expect(slots()).toHaveLength(3);
      tag();
      /* THE CHOICE DOES NOT DRIFT. Sampled every 20ms for the whole staged period: a blade that moved
         between chips as the stages advanced would be a second occurrence rule running here. */
      for (let elapsed = 0; elapsed < DISCARD_VACATE_AT_MS; elapsed += 20) {
        expect(slots()).toHaveLength(3);
        const marked = slots().filter((slot) => slot.querySelector(".app-train-cut-line") !== null);
        expect(marked.length).toBeLessThanOrEqual(1);
        if (marked.length === 1) expect((marked[0] as Tagged).__chipTag).toBe("staged0");
        tick(20);
      }
    });

    it("leaves the other 3 and the 5 continuously present and untouched", () => {
      play();
      tag();
      for (let elapsed = 0; elapsed < DISCARD_VACATE_AT_MS; elapsed += 20) {
        expect(tags()).toEqual(["staged0", "staged1", "staged2"]);
        expect(row()).toBe("3|3|5");
        for (const index of [1, 2]) {
          expect(slots()[index].className).not.toContain("app-train-discard");
          expect(slots()[index].className).not.toContain("app-train-cut-slot");
          expect(slots()[index].querySelector(".app-train-cut-line")).toBeNull();
        }
        tick(20);
      }
    });

    it("cuts one chip with a blade that does not move between stages", () => {
      play();
      tick(DISCARD_CUT_AT_MS);
      expect(blades()).toHaveLength(1);
      const drawn = () => {
        const line = host.querySelector(".app-train-cut-line line");
        return line ? `${line.getAttribute("x1")}|${line.getAttribute("x2")}` : null;
      };
      const first = drawn();
      expect(first).not.toBeNull();
      // Into the parting and the transfer: same chip, same blade. A re-seeded cut would be two cuts.
      tick(DISCARD_PART_AT_MS - DISCARD_CUT_AT_MS);
      expect(drawn()).toBe(first);
      tick(DISCARD_TRANSFER_AT_MS - DISCARD_PART_AT_MS);
      expect(drawn()).toBe(first);
    });

    it("keeps the survivors' own DOM nodes across the handover", () => {
      /* VF-7'S DEFECT, PROBED AGAIN. Keys naming a position in the STAGED array matched the dying chip to
         the surviving one at the handover, unmounting a node that never changed. The fix keys a staged
         survivor by the index it will OCCUPY; this asserts it holds for the discard's keys too, including
         the `app-train-cut-slot` wrapper, which carries the departing chip's key rather than its own. */
      play();
      tag();
      expect(tags()).toEqual(["staged0", "staged1", "staged2"]);
      tick(DISCARD_VACATE_AT_MS);
      // The surviving 3 is its own node, and the untouched 5 was never rebuilt.
      expect(tags()).toEqual(["staged1", "staged2"]);
      expect(row()).toBe("3|5");
    });

    it("keys the ordinary row exactly as it always did", () => {
      // The control on the fix: with nothing leaving, the key is byte-identical to the pre-VF-7 one.
      render(["3", "3", "5"], null);
      tag();
      render(["3", "3", "5"], null);
      expect(tags()).toEqual(["staged0", "staged1", "staged2"]);
    });
  });

  describe("reduced motion", () => {
    const play = () =>
      render(
        ["3", "3"],
        event({ companyId: CO, ticker: "C&O", before: ["3", "3", "4"], model: "4", at: 2 }),
      );

    beforeEach(() => {
      reducedMotion = true;
    });

    it("keeps the cut, which is the whole semantic difference from a rust", () => {
      /* #26: a cue that disappears under reduced motion is an information problem. Drop the blade and a
         reader who has switched motion off cannot tell a transfer from a destruction. */
      play();
      tick(DISCARD_REDUCED_CUT_AT_MS);
      expect(blades()).toHaveLength(1);
      // Present rather than falling: a static mark instead of a movement.
      expect(falling()).toHaveLength(0);
    });

    it("never splits the chip", () => {
      play();
      for (let elapsed = 0; elapsed < DISCARD_REDUCED_VACATE_AT_MS; elapsed += 20) {
        expect(cutSlots()).toHaveLength(0);
        expect(slots()).toHaveLength(3);
        tick(20);
      }
      expect(cutSlots()).toHaveLength(0);
    });

    it("still reserves the slot, and still settles to the authoritative roster", () => {
      play();
      expect(row()).toBe("3|3|4");
      tick(DISCARD_REDUCED_VACATE_AT_MS - 1);
      expect(slots()).toHaveLength(3);
      tick(1);
      expect(row()).toBe("3|3");
      tick(DISCARD_REDUCED_TOTAL_MS);
      expect(row()).toBe("3|3");
      expect(blades()).toHaveLength(0);
    });

    it("finishes sooner than the full-motion sequence would have", () => {
      play();
      tick(DISCARD_REDUCED_TOTAL_MS);
      expect(row()).toBe("3|3");
      expect(DISCARD_REDUCED_TOTAL_MS).toBeLessThan(DISCARD_VACATE_AT_MS);
    });
  });

  describe("a second discard supersedes the first", () => {
    it("replays rather than sitting finished", () => {
      /* Reachable: a corporation two over the limit answers twice in a row. The sequence is keyed on the
         token (#1060), so the second event restarts the row rather than finding the first still up. */
      render(
        ["3", "3", "4"],
        event({ companyId: CO, ticker: "C&O", before: ["3", "3", "4", "5"], model: "5", at: 3 }, 1),
      );
      expect(row()).toBe("3|3|4|5");
      tick(DISCARD_VACATE_AT_MS);
      expect(row()).toBe("3|3|4");
      render(
        ["3", "3"],
        event({ companyId: CO, ticker: "C&O", before: ["3", "3", "4"], model: "4", at: 2 }, 2),
      );
      // Staged again, from the top: the new sequence is at its tension beat, not at the old one's end.
      expect(row()).toBe("3|3|4");
      expect(blades()).toHaveLength(0);
      tick(DISCARD_CUT_AT_MS);
      expect(blades()).toHaveLength(1);
      tick(DISCARD_TOTAL_MS);
      expect(row()).toBe("3|3");
    });
  });

  describe("interaction safety", () => {
    it("hands out no roster index at all while a discard is staged", () => {
      /* `onSelectTrain(index)` means a position in the roster the CALLER knows about, and while staging
         `index` is a position in the pre-discard one. Guarded rather than argued -- the same boolean
         VF-7 added, which VF-8 is the second staging source behind. */
      const picked: number[] = [];
      const draw = (discard: TrainDiscardEvent | null) => {
        act(() => {
          root.render(
            <TrainChips
              trains={["3", "3"]}
              phase={PHASE}
              surface="dark"
              companyId={CO}
              discard={discard}
              interactive
              onSelectTrain={(index) => picked.push(index)}
            />,
          );
        });
      };
      draw(event({ companyId: CO, ticker: "C&O", before: ["3", "3", "4"], model: "4", at: 2 }));
      for (const slot of slots()) {
        expect(slot.getAttribute("role")).toBeNull();
        expect(slot.getAttribute("tabindex")).toBeNull();
        slot.click();
      }
      expect(picked).toEqual([]);
      // Once the roster is authoritative again, interaction returns.
      tick(DISCARD_TOTAL_MS);
      expect(slots()[0].getAttribute("role")).toBe("button");
      slots()[0].click();
      expect(picked).toEqual([0]);
    });
  });
});
