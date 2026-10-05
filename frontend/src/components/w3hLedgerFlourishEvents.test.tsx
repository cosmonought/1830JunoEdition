/** @jest-environment jsdom */
// W3-H, VF I-8 / J-5: "Three of the five `TrainChips` call sites do not receive the event" -- the Ledger was
// the real (narrow) gap for both the rust event and the train-limit discard: a player sitting on the Ledger
// tab saw a fleet change with no flourish. The Corporation Assets table now takes its own share of the one
// global event, exactly as the Round Detail corporations table does.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { FinancialLedger } from "./FinancialLedger";
import type { RustFlourishEvent } from "./trainRustFlourish";
import type { TrainDiscardEvent } from "./trainDiscardFlourish";
import { sandboxGameState } from "../gameEngine/sandboxState";
import type { GameStateResponse } from "../gameEngine/gameState";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  jest.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  jest.useRealTimers();
});

/* The sandbox's own Operating Round board (the W1-I ledger suite's fixture): its first two corporations,
   whatever they are, give one row that the event names and one that it does not. */
const BASE: GameStateResponse = sandboxGameState("OperatingRound", 1);
const [FIRST, SECOND] = BASE.public_companies;
const STATE: GameStateResponse = {
  ...BASE,
  public_companies: BASE.public_companies.map((company) =>
    company.company_id === FIRST.company_id
      ? { ...company, owned_trains: ["3", "4"] }
      : company.company_id === SECOND.company_id
        ? { ...company, owned_trains: ["3", "3", "4"] }
        : company,
  ),
};
const FIRST_ID = FIRST.company_id;
const SECOND_ID = SECOND.company_id;

function show(rust: RustFlourishEvent | null, discard: TrainDiscardEvent | null) {
  act(() => {
    root.render(
      <FinancialLedger gameState={STATE} loading={false} error={null} rust={rust} discard={discard} />,
    );
  });
}

/** The Corporation Assets table -- the only Ledger table whose rows are corporations. */
function corporationRows(): HTMLTableRowElement[] {
  const section = Array.from(host.querySelectorAll("details")).find((node) =>
    (node.querySelector("summary")?.textContent ?? "").includes("Corporation Assets"),
  );
  if (!section) throw new Error("Corporation Assets section not rendered");
  return Array.from(section.querySelectorAll("tbody tr"));
}
const rowFor = (ticker: string) => {
  const row = corporationRows().find((node) => (node.textContent ?? "").includes(ticker));
  if (!row) throw new Error(`no ${ticker} row`);
  return row;
};

const RUST: RustFlourishEvent = {
  token: 1,
  corporations: [{ companyId: FIRST_ID, ticker: FIRST.ticker, before: ["2", "3", "4"], rusted: ["2"] }],
};
const DISCARD: TrainDiscardEvent = {
  token: 1,
  discard: { companyId: SECOND_ID, ticker: SECOND.ticker, before: ["3", "3", "3", "4"], model: "3", at: 0 },
};

describe("VF I-8: the Ledger's corporation rows receive the rust event", () => {
  it("the rusted corporation's chips stage the rust; the untouched corporation's do not", () => {
    show(RUST, null);
    expect(rowFor(FIRST.ticker).querySelectorAll(".app-train-rusting").length).toBeGreaterThan(0);
    expect(rowFor(SECOND.ticker).querySelectorAll(".app-train-rusting").length).toBe(0);
  });

  it("with no event every row is its authoritative roster (A-3)", () => {
    show(null, null);
    expect(host.querySelectorAll(".app-train-rusting").length).toBe(0);
  });
});

describe("VF J-5: the Ledger's corporation rows receive the discard event", () => {
  it("the discarding corporation's chips stage the cut; the other corporation's do not", () => {
    show(null, DISCARD);
    const staged = (row: HTMLElement) =>
      row.querySelectorAll('[class*="app-train-discard"], .app-train-cut-slot').length;
    expect(staged(rowFor(SECOND.ticker))).toBeGreaterThan(0);
    expect(staged(rowFor(FIRST.ticker))).toBe(0);
  });
});
