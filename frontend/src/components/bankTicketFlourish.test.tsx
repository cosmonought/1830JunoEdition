/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE (VF-6 harness): WHAT THE TICKET ACTUALLY HOLDS, FRAME BY FRAME
// ==================================================================
//
// `utils/bankBreakTicket.test.ts` owns the trigger, the latch and the count. This owns the five things
// only a rendered ticket can answer:
//
//   1. ONE SILHOUETTE, THREE TONES. The ticket class is on the badge in every state -- the brief's "the
//      silhouette should remain fundamentally the SAME object before and after break" -- and there is
//      never a second persistent ticket anywhere.
//   2. THE STAGED ORDER IS THE ORDER THE EVENT WENT IN (brief section 9): critical ticket, stamp, THEN
//      rainbow. Never rainbow-then-red-then-rainbow.
//   3. THE RAINBOW IS THE APPLICATION'S OWN, asserted against `PRIVATE_POWER_GLOW_STOPS` rather than
//      against a colour list written out here -- a hand-copied palette in the test is the same drift the
//      shared constant exists to prevent.
//   4. NOTHING ANIMATES FOR EVER. The resting post-break ticket carries no motion class and no
//      animation, which is brief section 12 in as many words.
//   5. REDUCED MOTION keeps the state change and loses the slam.
//
// AND NOTHING LEAVES THE TICKET: `document.body` gains no child beyond this suite's own mount host.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { BankTicket, BANK_BROKEN_STAMP_TEXT } from "./BankTicket";
import {
  BANK_BREAK_RESOLVE_AT_MS,
  BANK_BREAK_STAMP_AT_MS,
  BANK_BREAK_TOTAL_MS,
  BANK_BREAK_REDUCED_RESOLVE_AT_MS,
  BANK_BREAK_REDUCED_STAMP_AT_MS,
  BANK_BREAK_REDUCED_TOTAL_MS,
  BANK_TICKET_CSS,
  bankBreakMilestoneMs,
  bankBreakTimeline,
  buildBankBreakSequence,
  type BankBreakFlipEvent,
} from "./bankBreakFlourish";
import { bankTicketReading } from "../utils/bankBreak";
import { PRIVATE_POWER_GLOW_STOPS } from "../utils/privatePowerGlow";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let reducedMotion = false;

const CRITICAL = bankTicketReading(null, 40)!;
const WARN = bankTicketReading(null, 1800)!;
const BROKEN_2 = bankTicketReading({ orsRemaining: 2 }, 80)!;
const BROKEN_1 = bankTicketReading({ orsRemaining: 1 }, null)!;

const stamp = (fromLabel: string | null, token = 1): BankBreakFlipEvent => ({ fromLabel, token });

describe("the Bank's railroad ticket", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = (reading: ReturnType<typeof bankTicketReading>, event: BankBreakFlipEvent | null) => {
    act(() => {
      root.render(<BankTicket reading={reading} stamp={event} />);
    });
  };
  const tick = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });

  const ticket = () => host.querySelector<HTMLElement>('[data-testid="bank-ticket"]');
  const tone = () => ticket()?.getAttribute("data-tone") ?? null;
  const classes = () => ticket()?.className ?? "";
  const stampNode = () => host.querySelector(".app-bank-ticket-stamp");
  /** The ticket's own text, without the stamp overlay's copy of BANK BROKEN. */
  const label = () => {
    const node = ticket()?.cloneNode(true) as HTMLElement | undefined;
    node?.querySelector(".app-bank-ticket-stamp")?.remove();
    return (node?.textContent ?? "").trim();
  };

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

  describe("the three resting states", () => {
    it("renders nothing while the Bank is comfortable", () => {
      render(null, null);
      expect(ticket()).toBeNull();
      expect(document.body.children).toHaveLength(1);
    });

    it("is an amber ticket at the warning distance, unpulsing", () => {
      render(WARN, null);
      expect(tone()).toBe("warn");
      expect(classes()).toContain("app-bank-ticket");
      expect(classes()).not.toContain("app-phase-shift-critical");
      expect(classes()).not.toContain("app-bank-ticket-broken");
      expect(label()).toContain("Bank Break: $1800 remaining");
    });

    it("is a red, pulsing ticket at the critical distance", () => {
      render(CRITICAL, null);
      expect(tone()).toBe("critical");
      /* THE EXISTING PULSE, through the existing class and the existing keyframe (#1410/#7): a second
         hand-tuned pulse would read as a rendering fault beside the train chips' (#755). */
      expect(classes()).toContain("app-phase-shift-critical");
      expect(ticket()?.style.animation).toContain("app-phase-shift-pulse");
    });

    it("is the same silhouette once broken, with the rounds in its own words", () => {
      render(BROKEN_2, null);
      expect(tone()).toBe("broken");
      // ONE OBJECT, NOT TWO: the ticket class is on the badge in every state.
      expect(classes()).toContain("app-bank-ticket");
      expect(classes()).toContain("app-bank-ticket-broken");
      expect(label()).toBe("BANK BROKEN · 2 ORs remaining");
      expect(label()).not.toContain("$");
      expect(BROKEN_1.label).toBe("BANK BROKEN · 1 OR remaining");
    });

    it("stops the pulse and drops the warning glyph after the break", () => {
      render(BROKEN_2, null);
      expect(classes()).not.toContain("app-phase-shift-critical");
      expect(ticket()?.style.animation ?? "").not.toContain("app-phase-shift-pulse");
      // The glyph means "danger approaching". It has arrived, and the ticket says so in words.
      expect(label()).not.toContain("⚠");
      expect(label()).toContain("BANK BROKEN");
    });

    it("never animates indefinitely once broken", () => {
      render(BROKEN_2, null);
      const style = ticket()?.style.animation ?? "";
      expect(style).not.toContain("infinite");
      expect(classes()).not.toContain("app-bank-ticket-charging");
      expect(classes()).not.toContain("app-bank-ticket-pressed");
      expect(classes()).not.toContain("app-bank-ticket-resolving");
      // And the resting broken rule in the sheet carries no animation of its own.
      const rule = BANK_TICKET_CSS.slice(BANK_TICKET_CSS.indexOf(".app-bank-ticket-broken {"));
      expect(rule.slice(0, rule.indexOf("}"))).not.toContain("animation");
    });

    it("keeps a dark interior so the text stays legible over the ring", () => {
      /* Brief section 12: contrast over the reused rainbow. #320's two-layer technique is what buys it --
         the gradient is clipped to the BORDER box and an opaque fill to the padding box, so the rainbow
         is a ring and never sits behind the words. */
      const rule = BANK_TICKET_CSS.slice(BANK_TICKET_CSS.indexOf(".app-bank-ticket-broken {"));
      const body = rule.slice(0, rule.indexOf("}"));
      expect(body).toContain("padding-box");
      expect(body).toContain("border-box");
    });
  });

  describe("the rainbow is the application's existing special-event language", () => {
    it("is built from PRIVATE_POWER_GLOW_STOPS rather than a palette written here", () => {
      /* #727 created that list precisely because "two hard-coded palettes drifting apart is how the
         association quietly stops being one", and it is the palette a player has already met on the
         contested mini-auction card and on a private-power hex. */
      for (const stop of PRIVATE_POWER_GLOW_STOPS) {
        expect(BANK_TICKET_CSS).toContain(stop);
      }
      expect(BANK_TICKET_CSS).toContain(PRIVATE_POWER_GLOW_STOPS.join(", "));
    });
  });

  describe("the one-time BANK BROKEN stamp (full motion)", () => {
    const play = () => render(BROKEN_2, stamp("Bank Break: $10 remaining"));

    it("opens on the staged CRITICAL ticket, not on the rainbow", () => {
      play();
      expect(tone()).toBe("critical");
      expect(classes()).not.toContain("app-bank-ticket-broken");
      expect(label()).toBe("⚠ Bank Break: $10 remaining");
      expect(classes()).toContain("app-bank-ticket-charging");
      // No stamp yet -- the press has not landed.
      expect(stampNode()).toBeNull();
      expect(document.body.children).toHaveLength(1);
    });

    it("lands the stamp while the ticket is still critical", () => {
      play();
      tick(BANK_BREAK_STAMP_AT_MS);
      expect(tone()).toBe("critical");
      expect(stampNode()?.textContent).toBe(BANK_BROKEN_STAMP_TEXT);
      expect(classes()).toContain("app-bank-ticket-pressed");
      expect(classes()).not.toContain("app-bank-ticket-broken");
    });

    it("commits to the rainbow exactly once, as the stamp lifts", () => {
      play();
      tick(BANK_BREAK_RESOLVE_AT_MS - 1);
      expect(tone()).toBe("critical");
      tick(1);
      expect(tone()).toBe("broken");
      expect(classes()).toContain("app-bank-ticket-broken");
      expect(label()).toBe("BANK BROKEN · 2 ORs remaining");
      // The stamp goes with the commit -- one BANK BROKEN on screen, never two.
      expect(stampNode()).toBeNull();
    });

    it("settles into a ticket indistinguishable from the ordinary broken one", () => {
      play();
      tick(BANK_BREAK_TOTAL_MS);
      const settled = ticket()?.outerHTML;
      act(() => {
        root.render(<BankTicket reading={BROKEN_2} stamp={null} />);
      });
      expect(settled).toBe(ticket()?.outerHTML);
      expect(classes()).not.toContain("app-bank-ticket-resolving");
    });

    it("lands inside the brief's 800-1200ms band", () => {
      expect(BANK_BREAK_TOTAL_MS).toBeGreaterThanOrEqual(800);
      expect(BANK_BREAK_TOTAL_MS).toBeLessThanOrEqual(1200);
    });

    it("stages the post-break sentence when there was no ticket to stage", () => {
      /* A single large payout can take the Bank from comfortably solvent -- no ticket on screen at all --
         straight to broken. There is no earlier text, so the TONE stages and the text does not;
         inventing a dollar figure would be presentation asserting a balance that never existed. */
      render(BROKEN_2, stamp(null));
      expect(tone()).toBe("critical");
      expect(label()).toContain("BANK BROKEN");
      expect(label()).not.toContain("$");
      tick(BANK_BREAK_RESOLVE_AT_MS);
      expect(tone()).toBe("broken");
    });

    it("does not pulse while it is being stamped", () => {
      play();
      expect(classes()).not.toContain("app-phase-shift-critical");
      tick(BANK_BREAK_STAMP_AT_MS);
      expect(classes()).not.toContain("app-phase-shift-critical");
    });
  });

  describe("the DIRECT crossing: no warning badge existed to stage", () => {
    /* ==================================================================
        A `null` STAGED LABEL IS A FACT, NOT A MISSING EVENT
       ==================================================================
       `bankBreakWarning` returns `null` above the $2000 line by design, so a Bank at $2400 emptied by one
       payout hands the ticket `fromLabel: null`. The shell-side half of this -- that the TRIGGER is
       unaffected -- is `utils/bankBreakTicket.test.ts`'s; this is the rendered half: that the ceremony
       plays in full, never shows an empty ticket, and stamps exactly once.
       THE CASE IS NOT EXOTIC. One large dividend is the most dramatic way an 1830 bank breaks, and it is
       precisely the way that skips the warning band entirely. */
    const direct = () => render(BROKEN_2, stamp(null));

    it("renders a real ticket from the first frame, never an empty one", () => {
      direct();
      expect(ticket()).not.toBeNull();
      expect(label().length).toBeGreaterThan(0);
      expect(label()).toBe("\u26a0 BANK BROKEN \u00b7 2 ORs remaining");
      /* THE TONE STAGES AND THE TEXT FALLS THROUGH: critical ink on the authoritative sentence, because
         there is no earlier sentence and inventing a dollar figure would assert a balance that never
         existed. */
      expect(tone()).toBe("critical");
      expect(classes()).toContain("app-bank-ticket");
      expect(classes()).toContain("app-bank-ticket-charging");
      expect(classes()).not.toContain("app-bank-ticket-broken");
    });

    it("is never blank at any point in the sequence", () => {
      direct();
      for (let elapsed = 0; elapsed <= BANK_BREAK_TOTAL_MS + 200; elapsed += 20) {
        expect(ticket()).not.toBeNull();
        expect(label().length).toBeGreaterThan(0);
        tick(20);
      }
    });

    it("stamps exactly once, and the stamp resolves rather than lingering", () => {
      direct();
      const seen: number[] = [];
      for (let elapsed = 0; elapsed <= BANK_BREAK_TOTAL_MS + 400; elapsed += 20) {
        seen.push(stampNode() === null ? 0 : 1);
        tick(20);
      }
      // One contiguous run of stamp frames: it appears once, and never comes back.
      const runs = seen.join("").split("0").filter((run) => run.length > 0);
      expect(runs).toHaveLength(1);
      expect(stampNode()).toBeNull();
    });

    it("leads cleanly into the rainbow, with the round count intact", () => {
      direct();
      tick(BANK_BREAK_RESOLVE_AT_MS - 1);
      expect(tone()).toBe("critical");
      tick(1);
      expect(tone()).toBe("broken");
      expect(classes()).toContain("app-bank-ticket-broken");
      expect(label()).toBe("BANK BROKEN \u00b7 2 ORs remaining");
      tick(BANK_BREAK_TOTAL_MS);
      // And it settles into the ordinary broken ticket, exactly as the staged-label case does.
      const settled = ticket()?.outerHTML;
      act(() => {
        root.render(<BankTicket reading={BROKEN_2} stamp={null} />);
      });
      expect(settled).toBe(ticket()?.outerHTML);
    });

    it("does the same under reduced motion", () => {
      reducedMotion = true;
      direct();
      expect(ticket()).not.toBeNull();
      expect(tone()).toBe("critical");
      tick(BANK_BREAK_REDUCED_RESOLVE_AT_MS);
      expect(tone()).toBe("broken");
      expect(label()).toBe("BANK BROKEN \u00b7 2 ORs remaining");
    });
  });

  describe("supersession", () => {
    it("restarts on a new token and leaves nothing of the first sequence behind", () => {
      render(BROKEN_2, stamp("Bank Break: $10 remaining", 1));
      tick(BANK_BREAK_STAMP_AT_MS);
      // An Undo back past the break, then the same payout again.
      render(BROKEN_1, stamp("Bank Break: $10 remaining", 2));
      expect(tone()).toBe("critical");
      expect(classes()).toContain("app-bank-ticket-charging");
      tick(BANK_BREAK_RESOLVE_AT_MS);
      expect(tone()).toBe("broken");
      expect(label()).toBe("BANK BROKEN · 1 OR remaining");
      tick(BANK_BREAK_TOTAL_MS);
      expect(classes()).not.toContain("app-bank-ticket-resolving");
    });
  });

  describe("reduced motion", () => {
    beforeEach(() => {
      reducedMotion = true;
    });

    it("keeps the state change and loses the slam", () => {
      render(BROKEN_2, stamp("Bank Break: $10 remaining"));
      expect(tone()).toBe("critical");
      // No press, no charge, no resolve class -- the transform channel is never used.
      expect(classes()).not.toContain("app-bank-ticket-charging");
      expect(classes()).not.toContain("app-bank-ticket-pressed");
      expect(classes()).not.toContain("app-bank-ticket-resolving");
      expect(ticket()?.style.transform ?? "").toBe("");
      // The stamp still ARRIVES -- a cue that disappears under reduced motion is an information
      // problem (#26); it arrives by opacity alone.
      tick(BANK_BREAK_REDUCED_STAMP_AT_MS);
      expect(stampNode()?.textContent).toBe(BANK_BROKEN_STAMP_TEXT);
      tick(BANK_BREAK_REDUCED_RESOLVE_AT_MS - BANK_BREAK_REDUCED_STAMP_AT_MS);
      expect(tone()).toBe("broken");
    });

    it("reaches the same resting ticket, sooner", () => {
      render(BROKEN_2, stamp(null));
      tick(BANK_BREAK_REDUCED_TOTAL_MS);
      expect(tone()).toBe("broken");
      expect(classes()).not.toContain("app-bank-ticket-resolving");
      expect(BANK_BREAK_REDUCED_TOTAL_MS).toBeLessThan(BANK_BREAK_TOTAL_MS);
      expect(document.body.children).toHaveLength(1);
    });

    it("never attaches a motion class at any point in the sequence", () => {
      render(BROKEN_2, stamp("Bank Break: $10 remaining"));
      for (let elapsed = 0; elapsed <= BANK_BREAK_REDUCED_TOTAL_MS; elapsed += 10) {
        expect(classes()).not.toContain("app-bank-ticket-charging");
        expect(classes()).not.toContain("app-bank-ticket-pressed");
        expect(classes()).not.toContain("app-bank-ticket-resolving");
        tick(10);
      }
    });
  });

  describe("the schedule's milestones come from the ACTIVE timeline", () => {
    it("names its beats rather than hardcoding the full-motion numbers", () => {
      /* VF-4's correction, applied from the start: a full-motion constant used under reduced motion is
         dead air charged to the reader who asked for less presentation. */
      expect(bankBreakMilestoneMs("stamped", false)).toBe(BANK_BREAK_STAMP_AT_MS);
      expect(bankBreakMilestoneMs("committed", false)).toBe(BANK_BREAK_RESOLVE_AT_MS);
      expect(bankBreakMilestoneMs("settled", false)).toBe(BANK_BREAK_TOTAL_MS);
      expect(bankBreakMilestoneMs("stamped", true)).toBe(BANK_BREAK_REDUCED_STAMP_AT_MS);
      expect(bankBreakMilestoneMs("committed", true)).toBe(BANK_BREAK_REDUCED_RESOLVE_AT_MS);
      expect(bankBreakMilestoneMs("settled", true)).toBe(BANK_BREAK_REDUCED_TOTAL_MS);
    });

    it("is the same timeline the sequence itself is built from", () => {
      for (const motion of [false, true]) {
        const sequence = buildBankBreakSequence({ fromLabel: null }, motion)!;
        expect(bankBreakTimeline(motion)).toEqual({
          stampedAt: sequence.stampedAt,
          commitAt: sequence.commitAt,
          totalMs: sequence.totalMs,
        });
        expect(sequence.applications[0].at).toBe(bankBreakMilestoneMs("committed", motion));
        expect(sequence.stages.map((stage) => stage.kind)).toEqual([
          "charge",
          "stamp",
          "resolve",
          "settle",
        ]);
      }
      expect(buildBankBreakSequence(null, false)).toBeNull();
    });
  });
});
