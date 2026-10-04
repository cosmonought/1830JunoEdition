/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W1-I (AUD-12.01 / K-23, U-27): THE LEDGER NEVER SHOWS A NEGATIVE BANK OR >100% PAID OUT
// ==================================================================
//
// The view (`bankTreasuryView.ts`) as a table of cases, then the real `FinancialLedger` rendered over a sandbox
// board at each bank state that went wrong: before the break, broken past zero, broken at exactly zero, and
// broken then credited back above zero (D-15: a credit never un-breaks the bank).

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { FinancialLedger } from "../components/FinancialLedger";
import { sandboxGameState } from "../gameEngine/sandboxState";
import type { GameStateResponse } from "../gameEngine/gameState";
import { bankTreasuryView } from "./bankTreasuryView";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

type Bank = Pick<GameStateResponse, "virtual_bank_start" | "virtual_bank_vgp" | "bank_broken">;
const bank = (start: string, current: string, broken?: true): Bank => ({
  virtual_bank_start: start,
  virtual_bank_vgp: current,
  ...(broken ? { bank_broken: broken } : {}),
});

describe("bankTreasuryView", () => {
  it("reads an intact bank as before, with the paid share floored", () => {
    expect(bankTreasuryView(bank("12000", "8420"))).toEqual({ remaining: "$8420", paidOut: "29%", broken: false });
    /* 99.9% paid is not "100%": the bank still holds $10. */
    expect(bankTreasuryView(bank("12000", "10")).paidOut).toBe("99%");
  });

  it("says the bank is broken and what it owes once the balance is negative (the $-20 report)", () => {
    expect(bankTreasuryView(bank("12000", "-20", true))).toEqual({
      remaining: "Bank broken — owes $20",
      paidOut: "100%",
      broken: true,
    });
  });

  it("judges a legacy board with no latch by its balance", () => {
    expect(bankTreasuryView(bank("12000", "-20"))).toEqual({
      remaining: "Bank broken — owes $20",
      paidOut: "100%",
      broken: true,
    });
  });

  it("does not show a broken bank at $0 as ordinary cash remaining (the \"$0 remaining\" report)", () => {
    expect(bankTreasuryView(bank("12000", "0", true))).toEqual({
      remaining: "Bank broken — $0 left",
      paidOut: "100%",
      broken: true,
    });
  });

  it("keeps saying broken after a credit lifts the balance (D-15 latch)", () => {
    const view = bankTreasuryView(bank("12000", "80", true));
    expect(view.remaining).toBe("Bank broken — $80 left");
    expect(view.broken).toBe(true);
    expect(view.paidOut).toBe("99%");
  });

  it("never shows a negative share when the bank has taken in more than it paid", () => {
    expect(bankTreasuryView(bank("12000", "12300")).paidOut).toBe("0%");
  });

  it("never goes past 100% however far past zero the bank has paid", () => {
    for (const current of ["-1", "-20", "-5000", "-999999"]) {
      const share = Number(bankTreasuryView(bank("12000", current, true)).paidOut.replace("%", ""));
      expect(share).toBe(100);
    }
  });

  it("shows an unreadable or unknown figure as the board gave it, never a guess", () => {
    expect(bankTreasuryView(bank("12000", "n/a"))).toEqual({ remaining: "$n/a", paidOut: "--", broken: false });
    expect(bankTreasuryView(bank("0", "100")).paidOut).toBe("--");
    expect(bankTreasuryView(bank("", "100")).paidOut).toBe("--");
  });
});

describe("the ledger renders the bank truthfully", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (overrides: Partial<GameStateResponse>) => {
    const gameState: GameStateResponse = { ...sandboxGameState("OperatingRound", 1), ...overrides };
    act(() => root.render(<FinancialLedger gameState={gameState} loading={false} error={null} />));
    const cell = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
    return { remaining: cell("ledger-bank-remaining"), paidOut: cell("ledger-bank-paid-out") };
  };

  it("before the break", () => {
    expect(render({ virtual_bank_start: "12000", virtual_bank_vgp: "8420" })).toEqual({ remaining: "$8420", paidOut: "29%" });
  });

  it("broken past zero: no \"$-20\", no >100%", () => {
    const shown = render({ virtual_bank_start: "12000", virtual_bank_vgp: "-20", bank_broken: true });
    expect(shown).toEqual({ remaining: "Bank broken — owes $20", paidOut: "100%" });
    expect(container.textContent).not.toContain("$-");
    /* No percentage anywhere on the ledger past 100 (101%..999%). */
    expect(container.textContent).not.toMatch(/\b(10[1-9]|1[1-9]\d|[2-9]\d\d)%/);
  });

  it("broken at exactly zero", () => {
    expect(render({ virtual_bank_start: "12000", virtual_bank_vgp: "0", bank_broken: true })).toEqual({
      remaining: "Bank broken — $0 left",
      paidOut: "100%",
    });
  });

  it("broken, then credited back above zero", () => {
    expect(render({ virtual_bank_start: "12000", virtual_bank_vgp: "80", bank_broken: true })).toEqual({
      remaining: "Bank broken — $80 left",
      paidOut: "99%",
    });
  });
});
