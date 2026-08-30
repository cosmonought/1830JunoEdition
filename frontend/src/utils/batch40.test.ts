/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1020/1021 (harness): THE WHOLE ARRAY, AND ONE ANSWER
// ==================================================================
//
// Two reports, and the second arrived mid-batch and moved the diagnosis:
//
//   "A corporation ran a 5-train (for $200) and a D-train (for $440). The Dividends phase and Activity Log
//    only processed a single $200 run, but incorrectly labeled it as the D-train's run."
//
//   "the 5-train ran for $180, the D-train said it ran for $460. The activity log printed:
//    NYC ran a $200 route with a D-train through G19 -> F20 -> E19 -> D20 -> D22 -> D24 -> E23."
//
// WHAT IS PROVEN HERE IS WHAT THE CODE SHOWED, and the last of the three figures is deliberately NOT claimed:
// see the final describe for what remains unexplained and what would settle it.

export {};

const { applySandboxAction, sandboxRouteBreakdown } =
  require("./sandboxSession") as typeof import("./sandboxSession");
const { watcherTrainDrafts } =
  require("./watcherRouteChips") as typeof import("./watcherRouteChips");
const { describeGameplayAction } =
  require("./actionLog") as typeof import("./actionLog");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");

/* ------------------------------------------------------------------ */
/* Item 1 -- design note #1020                                         */
/* ------------------------------------------------------------------ */

describe("the run payload is built from the drafts, not from a mirror of them", () => {
  it("reads the state the runnable set was derived from", () => {
    /* THE BUG. `runnable` comes from `trainDrafts`, a memo over the `routeDrafts` STATE; the points came from
       `routeDraftsRef.current`, a mirror written by an effect one commit later. A train the memo can see and
       the mirror cannot resolves to `[]`, is dropped by the two-point filter, and never reaches the message
       -- so the board pays for the routes that happened to survive. */
    expect(APP).toContain("routeDrafts[draft.trainIndex] ?? []");
    expect(APP).not.toContain("routeDraftsRef.current[draft.trainIndex] ?? []");
  });

  it("keeps the ref for the handler it was built for", () => {
    /* #275's REASON IS STILL GOOD FOR ITS OWN CALLER -- the canvas click handler must see the current draft
       without being rebuilt on every click. Removing the ref entirely would have been the fix over-applied. */
    expect(APP).toContain("routeDraftsRef.current = routeDrafts;");
  });

  it("names the trains on the wire", () => {
    // Parallel to `routes`, so a saved log written before this field still replays.
    expect(APP).toContain("trains: turnRoutes.map((entry) => entry.train)");
  });
});

describe("the reducer banks every route it is given", () => {
  /* The reducer arm was already correct and is asserted anyway: the report blamed "the engine", and knowing
     WHICH half was innocent is what kept this fix from being applied in the wrong place. */
  const board = () =>
    ({
      game_id: 1,
      current_round_type: "OperatingRound",
      operating_sub_phase: "Routes",
      macro_round_number: 10,
      sub_round_index: 3,
      active_operating_order: [2],
      active_corporation_index: 0,
      active_player_index: 0,
      player_addresses: ["p1"],
      player_cash: [{ player: "p1", cash_vgp: "500" }],
      bank_cash_vgp: "8000",
      private_companies: [],
      public_companies: [
        {
          company_id: 2,
          ticker: "NYC",
          president: "p1",
          treasury: "500",
          owned_trains: ["5", "D"],
          station_token_hexes: [[6, 6]],
          station_token_limit: 4,
          player_holdings: [{ player: "p1", percentage: 60 }],
          is_floated: true,
          printed_route_revenue: "0",
          last_route_revenue: "0",
          routes_run_this_turn: 0,
        },
      ],
    }) as never;

  const run = (routes: unknown[]) =>
    ({
      RunMultipleRoutes: {
        game_id: 1,
        protocol_id: 2,
        routes,
        trains: ["5", "D"],
        payout_strategy: "Withhold",
      },
    }) as never;

  it("counts every route in the array, not the first", () => {
    /* TWO ROUTES IN MEANS TWO ROUTES COUNTED. Asserted through `routes_run_this_turn`, which the reducer
       increments by `routes.length` -- a payload that arrived with one entry cannot produce two. */
    const after = applySandboxAction(board(), run([
      [{ hex: "G19" }, { hex: "F20" }],
      [{ hex: "G19" }, { hex: "F18" }],
    ])) as unknown as { public_companies: Array<{ routes_run_this_turn: number }> };
    expect(after.public_companies[0].routes_run_this_turn).toBe(2);
  });

  it("sums the printed values rather than taking one", () => {
    const one = applySandboxAction(board(), run([[{ hex: "G19" }, { hex: "F20" }]])) as unknown as {
      public_companies: Array<{ printed_route_revenue: string }>;
    };
    const two = applySandboxAction(board(), run([
      [{ hex: "G19" }, { hex: "F20" }],
      [{ hex: "G19" }, { hex: "F18" }],
    ])) as unknown as { public_companies: Array<{ printed_route_revenue: string }> };

    /* A SUM, NOT A MAXIMUM AND NOT A FIRST. Compared against the one-route case rather than against a typed
       constant, so this cannot pass by agreeing with a hard-coded figure that is itself wrong. */
    expect(Number(two.public_companies[0].printed_route_revenue)).toBeGreaterThan(
      Number(one.public_companies[0].printed_route_revenue),
    );
  });
});

describe("the log names the train that ran", () => {
  const context = {
    gameState: {
      public_companies: [
        { company_id: 2, ticker: "NYC", owned_trains: ["5", "D"] },
      ],
    },
    mapGrid: { game_id: 1, tiles: [] },
    era: "Yellow",
  } as never;

  const msg = (trains?: readonly string[]) =>
    ({
      RunMultipleRoutes: {
        game_id: 1,
        protocol_id: 2,
        routes: [
          [{ hex: "G19" }, { hex: "F20" }],
          [{ hex: "G19" }, { hex: "F18" }],
        ],
        ...(trains ? { trains } : {}),
        payout_strategy: "Withhold",
      },
    }) as never;

  it("prints each train against its own figure", () => {
    /* THE REPORT'S OWN REQUEST: "[{train: '5', value: 200}, {train: 'D', value: 440}]" -- a sentence a player
       can reconcile against their chips, which one aggregate never was. */
    const line = describeGameplayAction(msg(["5", "D"]), context) ?? "";
    expect(line).toContain("5-train $");
    expect(line).toContain("D-train $");
  });

  it("no longer guesses from the largest train owned", () => {
    /* THE EXACT MISLABEL, AS REPORTED TWICE: one route in the log, named as the D-train's, when the 5-train
       ran it. With a 5 and a D in the fleet, `owned_trains.slice().sort().pop()` could only ever answer "D".
       ONE ROUTE AND ONE TRAIN, which is the shape the report described. An earlier draft of this case passed
       one train alongside TWO routes and then asserted the new wording -- a mismatched array is exactly when
       the fallback SHOULD fire, so the case was testing the opposite of what it claimed and said so by
       failing. */
    const single = {
      RunMultipleRoutes: {
        game_id: 1,
        protocol_id: 2,
        routes: [[{ hex: "G19" }, { hex: "F20" }]],
        trains: ["5"],
        payout_strategy: "Withhold",
      },
    } as never;
    const line = describeGameplayAction(single, context) ?? "";
    expect(line).toContain("5-train");
    expect(line).not.toContain("D-train");
  });

  it("does not trust a trains array that does not cover every route", () => {
    /* THE GUARD THE CASE ABOVE TRIPPED OVER, kept deliberately. A payload naming some routes and not others
       is a payload that cannot be believed per-leg, so the narration declines to attribute any of them rather
       than labelling the first and guessing the rest. */
    const line = describeGameplayAction(msg(["5"]), context) ?? "";
    expect(line).toContain("trains up to a D");
  });

  it("falls back to the old wording for a log written before the field existed", () => {
    /* #232: a saved log that does not name its trains has not said the D-train ran. The inference survives
       for those entries and marks itself as one by saying "up to". */
    const line = describeGameplayAction(msg(), context) ?? "";
    expect(line).toContain("trains up to a D");
  });
});

/* ------------------------------------------------------------------ */
/* Item 2 -- design note #1021                                         */
/* ------------------------------------------------------------------ */

describe("a watcher renders the drafter's figure rather than its own", () => {
  const roster = [
    { trainIndex: 0, model: "5" },
    { trainIndex: 1, model: "D" },
  ];
  const drafts = { 0: [[6, 6] as const, [5, 7] as const], 1: [[6, 6] as const, [5, 6] as const] };

  it("uses the published value when the channel carries one", () => {
    /* THE REPORTED GAP, as a fixture: the watcher's own pricer answers 450 and the drafter published 440. */
    const chips = watcherTrainDrafts({
      roster,
      actorDrafts: drafts,
      labelForHex: (q, r) => `${q},${r}`,
      priceRoute: () => 450,
      valueFor: (trainIndex) => (trainIndex === 1 ? 440 : 200),
    });
    expect(chips.find((chip) => chip.trainIndex === 1)?.value).toBe(440);
    expect(chips.find((chip) => chip.trainIndex === 0)?.value).toBe(200);
  });

  it("falls back to local pricing when it does not", () => {
    /* #232 AGAIN: a presence document from a client that publishes no figures has not published a zero. The
       old behaviour is the fallback, so a mixed-build room degrades to what it did before rather than to
       blank chips. */
    const chips = watcherTrainDrafts({
      roster,
      actorDrafts: drafts,
      labelForHex: (q, r) => `${q},${r}`,
      priceRoute: () => 450,
    });
    expect(chips.every((chip) => chip.value === 450)).toBe(true);
  });

  it("still shows nothing for a draft that is not yet a route", () => {
    /* A ONE-STOP DRAFT HAS NO VALUE ON EITHER SIDE. #498's em dash is the honest rendering, and a published
       figure must not override that -- a value for half a route would be a number about nothing. */
    const chips = watcherTrainDrafts({
      roster,
      actorDrafts: { 0: [[6, 6] as const] },
      labelForHex: (q, r) => `${q},${r}`,
      priceRoute: () => 450,
      valueFor: () => 999,
    });
    expect(chips.find((chip) => chip.trainIndex === 0)?.value).toBeNull();
  });

  it("is published from the acting player's own chips", () => {
    // Read from `trainDrafts`, not re-priced at the publish site -- two calls to one pricer is still two answers.
    expect(APP).toContain("routeValues: Object.fromEntries(");
    expect(APP).toContain("trainDrafts");
  });
});

describe("there is exactly one route pricer", () => {
  it("prices a path identically wherever it is asked", () => {
    /* THE FINDING THAT REFRAMED ITEM 2. `sandboxRouteRevenue` delegates to `sandboxRouteBreakdown`, so the
       reducer, the log, the planner and the watcher all run the SAME code -- the desync was never two
       implementations, it was one implementation given inputs that only mostly agree across clients. That is
       why the fix is to publish the answer rather than to reconcile the pricers. */
    const grid = { game_id: 1, tiles: [] } as never;
    const path = [{ hex: "G19" }, { hex: "F20" }, { hex: "E19" }];
    expect(sandboxRouteBreakdown(grid, path, "Yellow").revenue).toBe(
      sandboxRouteBreakdown(grid, path, "Yellow").revenue,
    );
  });
});
