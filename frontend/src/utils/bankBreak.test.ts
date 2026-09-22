// frontend/src/utils/bankBreak.test.ts -- design note #1410.
import { BANK_BREAK_CRITICAL_AT, BANK_BREAK_WARN_AT, bankBreakWarning } from "./bankBreak";
import { readStripped } from "./sourceScan";

describe("the Bank Break countdown (design note #1410)", () => {
  it("is silent above $2000 and amber from $2000 down", () => {
    expect(bankBreakWarning(2001)).toBeNull();
    expect(bankBreakWarning(BANK_BREAK_WARN_AT)).toEqual(expect.objectContaining({ label: "Bank Break: $2000 remaining", critical: false }));
    expect(bankBreakWarning(1500)?.critical).toBe(false);
  });

  it("turns red and pulses at $1000 or below", () => {
    expect(bankBreakWarning(BANK_BREAK_CRITICAL_AT)).toEqual(expect.objectContaining({ label: "Bank Break: $1000 remaining", critical: true }));
    expect(bankBreakWarning(0)?.critical).toBe(true);
    expect(bankBreakWarning(-40)?.label).toBe("Bank Break: $0 remaining");
  });

  it("shows nothing for an unknown balance", () => {
    expect(bankBreakWarning(null)).toBeNull();
    expect(bankBreakWarning(Number.NaN)).toBeNull();
  });

  it("sits beside the phase badge on both rails", () => {
    /* ==================================================================
        AMENDED BY VF-6: THE CAPSULE BECAME A TICKET, AND THE MARKUP MOVED
       ==================================================================
       IT PINNED THE INLINE SPAN -- `&#9888; {bankBreak.label}` twice, the `app-phase-shift-critical`
       ternary and the `phaseShiftBadgeCritical`/`Warn` spread -- which was the right assertion while the
       Bank countdown was one more alert capsule written out at both call sites. VF-6 makes it one
       continuous object across three states (amber, critical, and the post-break railroad ticket), so
       that markup now lives in `BankTicket.tsx` and the bar passes a reading to it.
       WHAT THIS CASE IS ACTUALLY ABOUT SURVIVES UNCHANGED and is what it still checks: the Bank indicator
       is on BOTH rails, beside the phase, and there is exactly one of it per rail. The pulse, the tones
       and the silhouette are `components/bankTicketFlourish.test.tsx`'s, where they can be asserted
       against a rendered badge rather than against a string.
       THE THRESHOLD CASES ABOVE ARE UNTOUCHED -- #1410's arithmetic is this file's real subject and this
       batch did not go near it. */
    const BAR = readStripped("panels/ContextualActionBar.tsx");
    expect((BAR.match(/<BankTicket reading=\{bankBreak\}/g) ?? []).length).toBe(2);
    expect(BAR).toContain("const bankBreak = bankTicketReading(bankBroken ?? null, bankRemaining);");
    const APP = readStripped("App.tsx");
    expect(APP).toContain("bankRemaining={gameState ? Number(gameState.virtual_bank_vgp) : null}");
  });
});
