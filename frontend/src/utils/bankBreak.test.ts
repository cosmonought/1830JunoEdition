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

  it("sits beside the phase badge on both rails, pulsing only when critical", () => {
    const BAR = readStripped("panels/ContextualActionBar.tsx");
    expect(BAR.split("&#9888; {bankBreak.label}").length - 1).toBe(2);
    expect(BAR).toContain('className={bankBreak.critical ? "app-phase-shift-critical" : undefined}');
    expect(BAR).toContain("...(bankBreak.critical ? styles.phaseShiftBadgeCritical : styles.phaseShiftBadgeWarn),");
    const APP = readStripped("App.tsx");
    expect(APP).toContain("bankRemaining={gameState ? Number(gameState.virtual_bank_vgp) : null}");
  });
});
