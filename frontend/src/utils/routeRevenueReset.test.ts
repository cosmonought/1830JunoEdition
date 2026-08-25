/** @jest-environment node */
//
// A corporation's route revenue describes THIS turn. No React.
//
// ==================================================================
//  DESIGN NOTE 777 (harness): AN OPTION THE AUTHORITY COULD NOT RECEIVE
// ==================================================================
//
// REPORTED, across three playtests:
//   "$190 ... the toast said it paid out at $22 per share"   -> $220 = $190 + the $30 before it
//   "$200 ... the toast said $39 per share"                  -> $390 = $200 + the $190 before it
//   "C&O ran for $70 ... correctly said $7"  then later      -> "$70 ... incorrectly said $14"
//
// THE ARITHMETIC NAMED IT. Every wrong figure is this turn's run plus an earlier one, so nothing was
// doubling a number -- a number was never being cleared.
//
// THE RESET EXISTED AND WAS UNREACHABLE. `ctx.resetRouteRevenue` was a dispatch-time option, and
// `appendSandboxAction` writes the message and `derived` into the log and nothing else. Every client applies
// actions by REPLAYING them from that log, including the browser that pressed the button -- so the flag was
// absent every single time the arm read it. It had never worked on any code path in the app.
//
// WHICH IS THE MOST DANGEROUS SHAPE A RULE CAN HAVE: at the call site it reads as enforced. #642 already
// stated the standing rule this violates -- "the round machine belongs to the reducer" -- and the fix is to
// make the reset a fact the log can produce rather than a flag travelling beside it.
//
// THESE TESTS REPLAY, THEY DO NOT ASK A PREDICATE. #757 shipped a predicate nothing called and #766's test
// pinned the bug it was written to catch, so the cases below run real messages through the real reducer and
// read the stored figure afterwards.

import { applySandboxAction } from "./sandboxSession";
import { dividendRevenue } from "./dividendSplit";
import type { GameStateResponse } from "./gameState";

const A = 1;
const B = 2;

function board(over: Partial<GameStateResponse> = {}): GameStateResponse {
  return {
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "500" },
      { player: "p2", cash_vgp: "500" },
    ],
    virtual_bank_vgp: "12000",
    private_companies: [],
    current_round_type: "OperatingRound",
    operating_sub_phase: "Routes",
    macro_round_number: 2,
    sub_round_index: 0,
    active_player_index: 0,
    active_operating_order: [A, B],
    active_corporation_index: 0,
    consecutive_passes: 0,
    public_companies: [A, B].map((id) => ({
      company_id: id,
      ticker: id === A ? "PRR" : "B&O",
      is_floated: true,
      president: id === A ? "p1" : "p2",
      par_value: "100",
      home_hex_label: id === A ? "H12" : "I15",
      ipo_pool_percentage: 40,
      bank_pool_percentage: 0,
      treasury: "300",
      last_route_revenue: "0",
      player_holdings: [{ player: id === A ? "p1" : "p2", percentage: 60 }],
      station_token_hexes: [[0, 0]],
      owned_trains: ["2"],
    })),
    ...over,
  } as unknown as GameStateResponse;
}

/** A board mid-turn with a run already banked. */
const withRun = (companyId: number, revenue: string) =>
  board({
    public_companies: board().public_companies.map((company) =>
      company.company_id === companyId ? { ...company, last_route_revenue: revenue } : company,
    ),
  } as Partial<GameStateResponse>);

const revenueOf = (state: GameStateResponse, companyId: number) =>
  state.public_companies.find((entry) => entry.company_id === companyId)?.last_route_revenue;

/** The message that ends one corporation's turn and starts the next one's. */
const nextCorporation = (state: GameStateResponse): GameStateResponse => ({
  ...state,
  active_corporation_index: state.active_corporation_index + 1,
});

describe("the turn change clears the run", () => {
  it("zeroes a stale figure when the cursor moves to the next corporation", () => {
    /* THE REPORT, as a unit. $190 banked, the turn ends, and the next time anything settles the figure must
       not still be $190 waiting to be added to. */
    const stale = nextCorporation(withRun(A, "190"));
    const settled = applySandboxAction(stale, { PassTurn: {} } as never);
    expect(revenueOf(settled, A)).toBe("0");
  });

  it("zeroes every corporation, not just the outgoing one", () => {
    /* The field is only read for the corporation currently operating, so clearing the rest costs nothing and
       removes the question of which one to clear -- which a round transition makes genuinely ambiguous. */
    const both = nextCorporation(
      board({
        public_companies: board().public_companies.map((company) => ({
          ...company,
          last_route_revenue: "150",
        })),
      } as Partial<GameStateResponse>),
    );
    const settled = applySandboxAction(both, { PassTurn: {} } as never);
    expect(revenueOf(settled, A)).toBe("0");
    expect(revenueOf(settled, B)).toBe("0");
  });

  it("zeroes on a new Operating Round", () => {
    const nextRound = { ...withRun(A, "300"), macro_round_number: 3 };
    expect(revenueOf(applySandboxAction(nextRound, { PassTurn: {} } as never), A)).toBe("0");
  });

  it("leaves the figure alone within a turn", () => {
    /* THE CONTROL, and the one that matters most: a turn's routes ADD, one message per train. A clear that
       fired on every action would report a four-train run as its last train.
       A LAY, because it is the message that provably stays inside the turn -- it steps the SUB-phase and
       leaves `active_corporation_index` where it is, so the turn-change branch is not reached. The first
       draft guarded this with an `if` on the cursor, which `jest/no-conditional-expect` was right to reject:
       a test that might assert nothing is a test that might pass for the wrong reason. */
    const midTurn = { ...withRun(A, "120"), operating_sub_phase: "Track" } as GameStateResponse;
    const lay = {
      LayTile: { game_id: 1, protocol_id: A, q: 1, r: 1, tile_id: 7, orientation: 0 },
    } as never;
    const settled = applySandboxAction(midTurn, lay);
    expect(settled.active_corporation_index).toBe(midTurn.active_corporation_index);
    expect(revenueOf(settled, A)).toBe("120");
  });
});

describe("the unreachable option is gone", () => {
  const SRC = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const strip = (raw: string) =>
      raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    return {
      reducer: strip(fs.readFileSync(path.join(__dirname, "sandboxSession.ts"), "utf8")),
      app: strip(fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8")),
      room: strip(fs.readFileSync(path.join(__dirname, "sandboxRoom.ts"), "utf8")),
    };
  })();

  it("no longer exists in the reducer or the shell", () => {
    /* #490a: three files explain the removal in prose, so the scan runs on comment-stripped copies. */
    expect(SRC.reducer).not.toContain("resetRouteRevenue");
    expect(SRC.app).not.toContain("resetRouteRevenue");
  });

  it("keeps the note explaining why", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "sandboxSession.ts"), "utf8");
    expect(raw).toContain("DESIGN NOTE 777");
    expect(raw).toContain("resetRouteRevenue");
  });

  it("still carries nothing but the message and derived into the log", () => {
    /* THE FACT THE WHOLE NOTE RESTS ON, pinned so a future option cannot quietly repeat the mistake: if the
       log grows a field, this test fails and whoever added it has to decide deliberately. */
    expect(SRC.room).toContain("msg: SandboxLogMsg");
    expect(SRC.room).toContain("derived = false");
  });
});

describe("the declared figure reads the corrected field", () => {
  it("uses a cleared figure rather than a carried one", () => {
    const company = { last_route_revenue: "0", owned_trains: ["2"] };
    expect(dividendRevenue(company as never, undefined)).toBe(0);
  });

  it("still prefers an explicit amount over the field", () => {
    // #752: the message's figure wins whenever it is present, including an explicit zero.
    const company = { last_route_revenue: "190", owned_trains: ["2"] };
    expect(dividendRevenue(company as never, "70")).toBe(70);
    expect(dividendRevenue(company as never, "0")).toBe(0);
  });
});
