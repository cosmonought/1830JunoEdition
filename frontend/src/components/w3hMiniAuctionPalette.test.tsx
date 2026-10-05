/** @jest-environment jsdom */
// W3-H, VF H-6: "The mini-auction card writes the palette out by hand."
//
// `WaterfallAuctionDashboard.tsx` spelled the eight ring stops inline instead of reading
// `PRIVATE_POWER_GLOW_STOPS`. The proof that it now reads the shared array is behavioural: the shared array is
// replaced with sentinel colours for this file, and the card's stylesheet must carry the sentinels and none of
// the old hand-written stops. A hand-written copy cannot follow a change to the array; this is that change.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

jest.mock("../utils/privatePowerGlow", () => {
  const actual = jest.requireActual("../utils/privatePowerGlow");
  return { ...actual, PRIVATE_POWER_GLOW_STOPS: ["#010203", "#040506", "#070809", "#010203"] };
});

// eslint-disable-next-line import/first
import { WaterfallAuctionDashboard } from "./WaterfallAuctionDashboard";

type State = import("../gameEngine/gameState").GameStateResponse;

declare global {
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

const SEATS = ["p-a", "p-b"];
const ROSTER: Array<[number, string, number, number]> = [
  [1, "Schuylkill Valley", 20, 5],
  [2, "Champlain & St.Lawrence", 40, 10],
];

function state(): State {
  return {
    current_round_type: "WaterfallAuction",
    macro_round_number: 1,
    sub_round_index: 0,
    operating_round_sequence_length: 1,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    active_operating_order: [],
    active_corporation_index: 0,
    rules_engine_version: 4,
    variants: { rules: 1 },
    player_addresses: [...SEATS],
    player_cash: SEATS.map((player) => ({ player, cash_vgp: "600" })),
    virtual_bank_vgp: "9000",
    public_companies: [],
    private_companies: ROSTER.map(([id, name, cost, revenue]) => ({
      private_id: id,
      name,
      cost: String(cost),
      revenue_per_or: String(revenue),
      owner: null,
      owner_protocol_id: null,
      closed: false,
    })),
    waterfall: {
      game_id: 1,
      waterfall_auction_active: true,
      privates: ROSTER.map(([id, name, cost], index) => ({
        private_id: id,
        name,
        face_value: String(cost),
        is_lowest_offered: index === 0,
        bids: [],
      })),
      current_turn: SEATS[0],
      mini_auction: null,
      consecutive_waterfall_passes: 0,
    },
  } as unknown as State;
}

function stylesheet(): string {
  const s = state();
  act(() => {
    root.render(
      <WaterfallAuctionDashboard
        waterfallState={s.waterfall ?? null}
        loading={false}
        error={null}
        gameState={s}
        connectedWalletAddress={SEATS[0]}
        sessionReady
        playerLabel={() => null}
        onBuyLowest={jest.fn()}
        onBidHigher={jest.fn()}
        onMiniAuctionRaise={jest.fn()}
        onMiniAuctionPass={jest.fn()}
      />,
    );
  });
  return Array.from(container.querySelectorAll("style"))
    .map((node) => node.textContent ?? "")
    .join("\n");
}

describe("VF H-6: the mini-auction ring reads PRIVATE_POWER_GLOW_STOPS", () => {
  it("the card's ring gradient is the shared array, in order", () => {
    const css = stylesheet();
    const ring = css.slice(css.indexOf(".waterfall-miniauction-card {"));
    expect(ring).toMatch(/linear-gradient\(\s*90deg,\s*#010203, #040506, #070809, #010203\s*\)\s*border-box/);
  });

  it("and no hand-written copy of the old stops is left in it", () => {
    const css = stylesheet();
    for (const stop of ["#ff9f1c", "#ffd400", "#4ade80", "#22d3ee", "#4f7cff", "#a855f7", "#ff4dc4"]) {
      expect([stop, css.includes(stop)]).toEqual([stop, false]);
    }
  });
});
