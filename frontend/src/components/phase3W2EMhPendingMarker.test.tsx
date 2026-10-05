/** @jest-environment jsdom */
//
// PHASE 3 W2-E (OD-3): the table marker, RENDERED. While `pending_mh_exchange` stands, the M&H's row on the
// owner's player card says the exchange is requested and pending -- for every seat, because the cards are the
// table -- and the row is plain again once the request is cleared. (The RR-6 copy has its own suite,
// `phase3W2ERr6Copy.test.tsx`, so that hunk can travel separately.)

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import PlayerCards from "./PlayerCards";
import { playerFinances } from "../utils/playerFinance";
import { pendingMhExchangeView } from "../utils/mhQueuedExchange";
import { MH_PRIVATE_ID } from "../gameEngine/privateExchange";
import type { GameStateResponse } from "../gameEngine/gameState";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const P1 = "p1";
const P2 = "p2";
const NYC = 2;
const NAMES: Record<string, string> = { [P1]: "Alice", [P2]: "Bob" };
const nameFor = (address: string) => NAMES[address] ?? address;

function board(pending: GameStateResponse["pending_mh_exchange"]): GameStateResponse {
  return {
    game_id: 1,
    player_addresses: [P1, P2],
    player_cash: [
      { player: P1, cash_vgp: "500" },
      { player: P2, cash_vgp: "500" },
    ],
    virtual_bank_vgp: "10000",
    private_companies: [
      { private_id: MH_PRIVATE_ID, name: "Mohawk & Hudson", cost: "110", revenue_per_or: "20", owner: P1, owner_protocol_id: null, closed: false },
    ],
    current_round_type: "StockRound",
    active_player_index: 1,
    priority_deal_index: 0,
    active_operating_order: [],
    active_corporation_index: 0,
    public_companies: [
      {
        company_id: NYC,
        ticker: "NYC",
        is_floated: true,
        president: P2,
        par_value: "100",
        ipo_pool_percentage: 30,
        bank_pool_percentage: 20,
        treasury: "300",
        owned_trains: [],
        player_holdings: [{ player: P2, percentage: 50 }],
        station_token_hexes: [],
        last_route_revenue: "0",
      },
    ],
    ...(pending === undefined ? {} : { pending_mh_exchange: pending }),
  } as unknown as GameStateResponse;
}

const PENDING = { player: P1, private_id: MH_PRIVATE_ID, company_id: NYC, source: "Bank" as const };

/** The cards exactly as the shell mounts them: the note callback built from the one pending view. */
function renderCards(state: GameStateResponse, viewer: string) {
  const view = pendingMhExchangeView(state, nameFor);
  const note = (privateId: number) =>
    view !== null && view.privateId === privateId ? { label: view.marker, title: view.sentence } : null;
  act(() => {
    root.render(
      <PlayerCards
        players={financesOf(state)}
        label={nameFor}
        activeAddress={state.player_addresses[state.active_player_index] ?? null}
        priorityAddress={null}
        viewerAddress={viewer}
        colorForSeat={() => "#888888"}
        privateDescription={() => null}
        privatePendingNote={note}
      />,
    );
  });
}

const financesOf = (state: GameStateResponse) =>
  state.player_addresses
    .map((address) => playerFinances(address, state, {}))
    .filter((row): row is NonNullable<typeof row> => row !== null);

const marker = () => container.querySelector<HTMLElement>(`[data-testid="private-pending-${MH_PRIVATE_ID}"]`);

describe("1. the table marker reads `pending_mh_exchange`", () => {
  it.each([P1, P2])("while the request stands, every seat sees it on the M&H's row (viewer %s)", (viewer) => {
    renderCards(board(PENDING), viewer);
    const found = marker();
    expect(found).not.toBeNull();
    expect(found!.textContent).toBe("Exchange requested — pending");
    expect(found!.title).toBe(
      "Alice has requested to exchange the Mohawk & Hudson for a 10% share of NYC from the Bank Pool. " +
        // Phase 3 W3-J (AUD-25.10 (d)): OD-3's "requested", not "queued".
        "Requested, not executed yet — it executes at the next turn boundary only if it is still legal then.",
    );
    // The M&H itself is still on the card: queued is not executed.
    expect(container.textContent).toContain("Mohawk & Hudson");
  });

  it.each([
    ["absent", undefined],
    ["cleared", null],
  ] as const)("no marker when the request is %s", (_name, pending) => {
    renderCards(board(pending), P1);
    expect(marker()).toBeNull();
    expect(container.textContent).not.toContain("Exchange requested");
  });

  it("a caller that passes no note draws the row as it always was", () => {
    const state = board(PENDING);
    act(() => {
      root.render(
        <PlayerCards
          players={financesOf(state)}
          label={nameFor}
          activeAddress={null}
          priorityAddress={null}
          viewerAddress={P1}
          colorForSeat={() => "#888888"}
        />,
      );
    });
    expect(marker()).toBeNull();
  });
});
