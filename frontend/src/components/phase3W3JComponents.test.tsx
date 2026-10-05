/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W3-J -- THE COMPONENT ROWS (AUD-25.10 (a)-(e), AUD-25.13 item 3)
// ==================================================================
//
// Behavioural: each case renders the component exactly as its mount passes it props (react-dom/client + act) and reads
// the DOM -- enabled / disabled controls, their titles, the visible text. Boards are the GR-3 harness's legal pinned
// Operating Rounds (`utils/gentleRustPresentationSupport`), and every refusal a case expects is the authority's own
// answer on that board, asked here the way the reducer asks it.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import TrainPurchasePanel, { type TrainPurchaseCompany } from "./TrainPurchasePanel";
import type { GameStateResponse } from "../gameEngine/gameState";
import { depotInventory, openDepotTiers } from "../gameEngine/gamePhase";
import { trainPurchaseRefusal } from "../gameEngine/trainPurchaseGate";
import { limitInForce } from "../gameEngine/sandboxSession";
import * as S from "../utils/gentleRustPresentationSupport";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const { PRR, NYC, board, company } = S;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (node: React.ReactElement) => act(() => root.render(node));
const click = (node: Element | null | undefined) => {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"));
const buttonByText = (pattern: RegExp) => buttons().find((node) => pattern.test(node.textContent ?? ""));

/* ================================================================================================= */
/* AUD-25.10 (a) -- THE DEPOT BUY ASKS `trainPurchaseRefusal`                                       */
/* ================================================================================================= */

/** The Buy Trains panel for the operating corporation, with the shell's props (App.tsx's `trainPurchase`). */
function renderDepot(state: GameStateResponse, opts: { withBoard?: boolean; bankBlockedReason?: string | null } = {}) {
  const buyerId = S.acting(state)!;
  const onBuyFromBank = jest.fn();
  render(
    <TrainPurchasePanel
      depot={depotInventory(state)}
      buyer={company(state, buyerId) as unknown as TrainPurchaseCompany}
      companies={state.public_companies as unknown as TrainPurchaseCompany[]}
      sessionReady
      canAct
      blockedReason={null}
      bankBlockedReason={opts.bankBlockedReason ?? null}
      board={opts.withBoard === false ? undefined : state}
      onBuyFromBank={onBuyFromBank}
      openTiers={openDepotTiers(state)}
      onProposeTrade={() => undefined}
      labelForAddress={(address) => address}
    />,
  );
  return onBuyFromBank;
}
const depotBuy = () => buttonByText(/^(Pay \$|Train Limit Reached)/)!;

/** The gate's own answer for the depot head on `state`, asked with the reducer's arguments. */
function authorityFor(state: GameStateResponse): string | null {
  const head = openDepotTiers(state)[0];
  return trainPurchaseRefusal(state, S.acting(state)!, {
    cost: head.cost,
    trainLimit: limitInForce(state) ?? head.trainLimit,
    requireFunds: true,
  });
}

describe("W3-J AUD-25.10 (a): the depot Buy is greyed with the purchase authority's sentence", () => {
  it("at the train limit: disabled, titled with exactly the gate's limit sentence", () => {
    const state = board({ corps: [{ id: PRR, trains: ["3", "3", "3", "3"] }, { id: NYC, trains: ["3"] }], operating: PRR });
    const refusal = authorityFor(state);
    expect(refusal).toBe("Train limit reached — PRR already holds 4 of a maximum 4.");
    const onBuy = renderDepot(state);
    expect(depotBuy().disabled).toBe(true);
    expect(depotBuy().title).toBe(refusal);
    expect(host.textContent).toContain(refusal!);
    // The panel's retired wording ("... for this phase.") is not said anywhere.
    expect(host.textContent).not.toContain("for this phase.");
    click(depotBuy());
    expect(onBuy).not.toHaveBeenCalled();
  });

  it("with a poor treasury: disabled, titled with exactly the gate's funds sentence", () => {
    const state = board({ corps: [{ id: PRR, trains: ["3"], treasury: "40" }, { id: NYC, trains: ["3"] }], operating: PRR });
    const refusal = authorityFor(state);
    expect(refusal).toMatch(/^PRR's treasury holds \$40 — it cannot pay \$\d+\.$/);
    renderDepot(state);
    expect(depotBuy().disabled).toBe(true);
    expect(depotBuy().title).toBe(refusal);
  });

  it("a purchase the gate allows stays live; the hold still outranks the gate; no board states no rule", () => {
    const rich = board({ corps: [{ id: PRR, trains: ["3"] }, { id: NYC, trains: ["3"] }], operating: PRR });
    expect(authorityFor(rich)).toBeNull();
    const onBuy = renderDepot(rich);
    expect(depotBuy().disabled).toBe(false);
    click(depotBuy());
    expect(onBuy).toHaveBeenCalledTimes(1);

    const poor = board({ corps: [{ id: PRR, trains: ["3"], treasury: "40" }, { id: NYC, trains: ["3"] }], operating: PRR });
    renderDepot(poor, { bankBlockedReason: "A hold stands." });
    expect(depotBuy().title).toBe("A hold stands.");

    renderDepot(poor, { withBoard: false });
    expect(depotBuy().disabled).toBe(false);
  });
});
