/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W3-E (K-06 / U-17, OD-11): THE MANUAL STOP / BYPASS CHOICE (harness)
// ==================================================================
//
// OD-11: build the voluntary city-bypass control for MANUAL routing; leave the auto-router choosing its
// certified best set. The engine has accepted `bypass: true` since #737 and forced bypass has worked since #808;
// what was missing is a hand-drawn route choosing the bow at a city it COULD enter -- the PRR passing its own
// Altoona home to save a stop.
//
// THE FIXTURE is `altoonaWall.test.ts`'s: tile 57 ($20 yellow city) on H10 and H14, Altoona's grey H12 between
// them. H10 > H12 > H14 through the station is $50 over three stops; the same hexes on the bow are $40 over two.
// Every number below is read off that board through the same pricer, authority and wire helper the shell uses.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { sandboxRouteBreakdown } from "../gameEngine/sandboxSession";
import { routeSetRefusal } from "../gameEngine/routeAuthority";
import { withForcedBypass } from "../gameEngine/cityBypass";
import { assignRouteSet } from "../gameEngine/routeAutoTrace";
import { validateGameplayMessage } from "../gameEngine/messageSchema";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { routePointsToWaypoints, type RoutePoint } from "./routeWaypoints";
import { editRouteDraft } from "./routeDraftEdit";
import {
  bowAvailableAt,
  bypassChoiceAt,
  bypassedStationReason,
  bypassChoicesFor,
  clearEndpointBypass,
  setDraftBypass,
} from "./manualBypass";
import { RouteChipDetail, bypassChoiceTitle, forcedBypassNote, tooManyStopsNote } from "../components/RouteChipDetail";
import type { TrainRouteDraft } from "../components/RoutePlannerPanel";
import { readShell, readSource, readStripped, sliceBetween } from "./sourceScan";

/* ---------------------------------------------------------------------------------------------------- */
/*  The board                                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

const hex = (label: string) => {
  const found = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!found) throw new Error(`no hex ${label}`);
  return found;
};
const point = (label: string): RoutePoint => ({ q: hex(label).q, r: hex(label).r, hexLabel: label });
const pts = (...labels: string[]): RoutePoint[] => labels.map(point);
const yellowCity = (label: string) => ({ q: hex(label).q, r: hex(label).r, tile_id: 57, orientation: 0 }) as MapTileEntry;

/** H10 - H12 (Altoona, with its bow) - H14. */
const ALTOONA: MapGridResponse = { game_id: 1, tiles: [yellowCity("H10"), yellowCity("H14")] };
/** I5 - I7 - I9: three ordinary yellow cities, no bow anywhere. */
const LINE: MapGridResponse = { game_id: 1, tiles: [yellowCity("I5"), yellowCity("I7"), yellowCity("I9")] };

const PRR = 1;
const NYC = 2;
const CO = 5;
const H12 = hex("H12");
/** Not the PRR: PRR's home token fills Altoona's one slot. */
const BLOCKS_H12 = (q: number, r: number, city: number) => q === H12.q && r === H12.r && city === 0;

type Corp = { id: number; ticker: string; trains: string[]; tokens: Array<[string, number]>; home: string };
function board(operating: number, corps: Corp[]): GameStateResponse {
  return {
    game_id: 1,
    player_addresses: ["p1"],
    player_cash: [{ player: "p1", cash_vgp: "500" }],
    virtual_bank_vgp: "10000",
    private_companies: [],
    variants: {},
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    active_operating_order: corps.map((corp) => corp.id),
    active_corporation_index: corps.findIndex((corp) => corp.id === operating),
    operating_sub_phase: "Routes",
    rules_engine_version: RULES_ENGINE_VERSION,
    market_positions: Object.fromEntries(corps.map((corp, i) => [corp.id, { price: 100 - i, x: 5 + i, y: 6, enteredAt: i + 1 }])),
    public_companies: corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: true,
      president: "p1",
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: "300",
      owned_trains: corp.trains,
      player_holdings: [{ player: "p1", percentage: 60 }],
      station_token_hexes: corp.tokens.map(([label]) => [hex(label).q, hex(label).r]),
      station_tokens: corp.tokens.map(([label, city]) => [hex(label).q, hex(label).r, city]),
      station_token_limit: 3,
      home_hex_label: corp.home,
    })),
  } as unknown as GameStateResponse;
}
const prr = (trains: string[], tokens: Array<[string, number]> = [["H12", 0], ["H10", 0]]): Corp => ({ id: PRR, ticker: "PRR", trains, tokens, home: "H12" });
const nyc = (trains: string[]): Corp => ({ id: NYC, ticker: "NYC", trains, tokens: [["H10", 0]], home: "H10" });

/** The routes exactly as the shell sends them: forced marks applied, then the one wire conversion. */
const wire = (points: RoutePoint[], blocks?: typeof BLOCKS_H12) => routePointsToWaypoints(withForcedBypass(points, ALTOONA, blocks));
const why = (state: GameStateResponse, companyId: number, routes: RoutePoint[][], grid = ALTOONA, blocks?: typeof BLOCKS_H12) =>
  routeSetRefusal(
    state,
    { protocol_id: companyId, routes: routes.map((r) => wire(r, blocks)), train_indices: routes.map((_, i) => i) },
    grid,
    "Yellow",
  );
const price = (points: RoutePoint[], companyId: number, grid = ALTOONA) =>
  sandboxRouteBreakdown(grid, routePointsToWaypoints(points), "Yellow", companyId);

const THROUGH = pts("H10", "H12", "H14");
function bypassed(points = THROUGH): RoutePoint[] {
  const edit = setDraftBypass(ALTOONA, points, 1, true, undefined);
  if (!edit.ok) throw new Error(edit.reason);
  return edit.points;
}

/* ---------------------------------------------------------------------------------------------------- */
/*  1. PRR at its own Altoona                                                                            */
/* ---------------------------------------------------------------------------------------------------- */

describe("W3-E: the PRR may choose to pass its own Altoona home", () => {
  it("offers Stop / Bypass on H12 as a real choice, starting at Stop", () => {
    expect(bypassChoicesFor(ALTOONA, THROUGH, undefined)).toEqual([{ index: 1, hexLabel: "H12", kind: "choice", bypassed: false }]);
  });

  it("Bypass marks the existing flag and the bow's arm; Stop removes the flag again", () => {
    const round = bypassed();
    expect(round[1]).toEqual({ ...point("H12"), bypass: true, variant: 1 });
    expect(bypassChoiceAt(ALTOONA, round, 1, undefined)).toMatchObject({ kind: "choice", bypassed: true });
    const back = setDraftBypass(ALTOONA, round, 1, false, undefined);
    expect(back.ok && back.points[1]).toEqual({ ...point("H12"), variant: 0 });
    expect(back.ok && "bypass" in back.points[1]).toBe(false);
    // The other points are untouched objects.
    expect(round[0]).toBe(THROUGH[0]);
    expect(round[2]).toBe(THROUGH[2]);
  });

  it("choosing the state it already has is a no-op by reference", () => {
    const same = setDraftBypass(ALTOONA, THROUGH, 1, false, undefined);
    expect(same.ok && same.points).toBe(THROUGH);
  });

  it("the authority accepts the PRR's bypass on a 2-train, where it is the best run ($40 over two stops)", () => {
    const state = board(PRR, [prr(["2"])]);
    expect(why(state, PRR, [bypassed()])).toBeNull();
  });

  it("but a bypass of the PRR's ONLY station leaves no station on the route -- the authority still says so", () => {
    const homeOnly = board(PRR, [prr(["2"], [["H12", 0]])]);
    expect(why(homeOnly, PRR, [bypassed()])).toMatch(/must pass through a city this corporation has a station token in/);
  });

  it("and the draft says so before Run, so the route is dropped by name rather than blocking the set", () => {
    const home: Array<[number, number, number]> = [[H12.q, H12.r, 0]];
    const both: Array<[number, number, number]> = [[H12.q, H12.r, 0], [hex("H10").q, hex("H10").r, 0]];
    expect(bypassedStationReason(bypassed(), home, ALTOONA)).toBe(
      "Bypassing H12 leaves this route without one of this corporation's stations — stop there, or run through another of its stations.",
    );
    expect(bypassedStationReason(bypassed(), both, ALTOONA)).toBeNull();
    expect(bypassedStationReason(THROUGH, home, ALTOONA)).toBeNull();
  });

  it("a choice aimed at a waypoint that has since changed is refused, not re-aimed", () => {
    const stale = setDraftBypass(ALTOONA, pts("H10", "H12", "H14"), 1, true, undefined, "H14");
    expect(!stale.ok && stale.reason).toBe("That stop is no longer on this route.");
    expect(setDraftBypass(ALTOONA, THROUGH, 1, true, undefined, "H12").ok).toBe(true);
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  2. Revenue / stop difference, and the serialized message                                             */
/* ---------------------------------------------------------------------------------------------------- */

describe("W3-E: pricing and the wire", () => {
  it("excludes the bypassed revenue centre and does not spend its stop", () => {
    const through = price(THROUGH, PRR);
    const round = price(bypassed(), PRR);
    expect([through.revenue, through.centres, through.stops.map((s) => s.hex)]).toEqual([50, 3, ["H10", "H12", "H14"]]);
    expect([round.revenue, round.centres, round.stops.map((s) => s.hex)]).toEqual([40, 2, ["H10", "H14"]]);
  });

  it("serializes as the existing `bypass: true` waypoint flag, and Stop sends no flag at all", () => {
    expect(routePointsToWaypoints(bypassed())).toEqual([{ hex: "H10" }, { hex: "H12", bypass: true }, { hex: "H14" }]);
    expect(routePointsToWaypoints(THROUGH)).toEqual([{ hex: "H10" }, { hex: "H12" }, { hex: "H14" }]);
    // `variant` is a drawing hint and never reaches the wire.
    expect(JSON.stringify(routePointsToWaypoints(bypassed()))).not.toContain("variant");
  });

  it("the RunMultipleRoutes message carrying it passes the schema at the door", () => {
    const msg = { RunMultipleRoutes: { protocol_id: PRR, routes: [routePointsToWaypoints(bypassed())], trains: ["2"], train_indices: [0] } };
    expect(validateGameplayMessage(msg).ok).toBe(true);
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  3. routeSetRefusal still decides the whole set                                                       */
/* ---------------------------------------------------------------------------------------------------- */

describe("W3-E: the route authority still judges the whole set, shortfall included", () => {
  it("a 3-train choosing Bypass ($40) is refused: the through-run ($50) is a demonstrated legal combination", () => {
    const state = board(PRR, [prr(["3"])]);
    expect(why(state, PRR, [THROUGH])).toBeNull();
    expect(why(state, PRR, [bypassed()])).toBe("Route set earns $40; a legal combination worth $50 is available.");
  });

  it("a 2-train choosing Stop is refused for its stops, and the shorter $30 run for the demonstrated $40 bypass", () => {
    const state = board(PRR, [prr(["2"])]);
    expect(why(state, PRR, [THROUGH])).toBe("Route 1 counts 3 cities, more than a 2-train's 2.");
    expect(why(state, PRR, [pts("H10", "H12")])).toBe("Route set earns $30; a legal combination worth $40 is available.");
  });

  it("a set is judged as a set: a bypassing train and a stopping train may not share track", () => {
    const state = board(PRR, [prr(["2", "2"])]);
    const verdict = why(state, PRR, [bypassed(), pts("H14", "H12")]);
    expect(verdict).toMatch(/both use the track at H14; two of a corporation's trains may share a city but never a section of track/);
  });

  it("a hand-forged bypass where the rails offer none is refused by the authority, whatever the client did", () => {
    const state = board(CO, [{ id: CO, ticker: "C&O", trains: ["3"], tokens: [["I5", 0]], home: "I5" }]);
    const forged = [[{ hex: "I5" }, { hex: "I7", bypass: true }, { hex: "I9" }]];
    expect(routeSetRefusal(state, { protocol_id: CO, routes: forged, train_indices: [0] }, LINE, "Yellow")).toMatch(/cannot be bypassed/);
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  4. Forced bypass, exactly as before                                                                  */
/* ---------------------------------------------------------------------------------------------------- */

describe("W3-E: forced bypass is reported, never offered, and works as before", () => {
  it("names H12 as forced for a corporation the city is closed to", () => {
    expect(bypassChoicesFor(ALTOONA, THROUGH, BLOCKS_H12)).toEqual([{ index: 1, hexLabel: "H12", kind: "forced" }]);
  });

  it("refuses Stop there, and treats Bypass as already true without editing the draft", () => {
    const stop = setDraftBypass(ALTOONA, THROUGH, 1, false, BLOCKS_H12);
    expect(stop.ok).toBe(false);
    expect(!stop.ok && stop.reason).toMatch(/closed to this corporation/);
    const go = setDraftBypass(ALTOONA, THROUGH, 1, true, BLOCKS_H12);
    expect(go.ok && go.points).toBe(THROUGH);
  });

  it("`withForcedBypass` still marks the crossing at the pricing boundary, and the authority accepts it", () => {
    expect(withForcedBypass(THROUGH, ALTOONA, BLOCKS_H12)[1]).toEqual({ ...point("H12"), bypass: true });
    const state = board(NYC, [prr(["2"]), nyc(["2"])]);
    expect(why(state, NYC, [THROUGH], ALTOONA, BLOCKS_H12)).toBeNull();
    // Unmarked, the through-arm is the city NYC may not enter.
    expect(routeSetRefusal(state, { protocol_id: NYC, routes: [routePointsToWaypoints(THROUGH)], train_indices: [0] }, ALTOONA, "Yellow")).toMatch(/tokened out/);
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  5. No bow, and endpoints                                                                             */
/* ---------------------------------------------------------------------------------------------------- */

describe("W3-E: no choice where the track has no bypass, and none at an endpoint", () => {
  it("an ordinary city offers nothing and refuses a Bypass", () => {
    const line = pts("I5", "I7", "I9");
    expect(bypassChoicesFor(LINE, line, undefined)).toEqual([]);
    expect(bowAvailableAt(LINE, line, 1)).toBe(false);
    const edit = setDraftBypass(LINE, line, 1, true, undefined);
    expect(edit.ok).toBe(false);
    expect(!edit.ok && edit.reason).toMatch(/No track goes around the revenue centre at I7/);
  });

  it("Altoona as a route's start or end offers nothing and refuses a Bypass", () => {
    const ends = pts("H12", "H14");
    expect(bypassChoicesFor(ALTOONA, ends, undefined)).toEqual([]);
    expect(bypassChoiceAt(ALTOONA, THROUGH, 0, undefined)).toBeNull();
    expect(bypassChoiceAt(ALTOONA, THROUGH, 2, undefined)).toBeNull();
    for (const [route, index] of [[ends, 0], [pts("H10", "H12"), 1]] as const) {
      const edit = setDraftBypass(ALTOONA, route, index, true, undefined);
      expect(!edit.ok && edit.reason).toMatch(/cannot be bypassed/);
    }
  });

  it("an edit that leaves a bypassed waypoint at an end clears its flag", () => {
    const round = bypassed();
    const steppedBack = clearEndpointBypass(round.slice(0, 2));
    expect(steppedBack[1]).toEqual(point("H12"));
    expect(routePointsToWaypoints(steppedBack)).toEqual([{ hex: "H10" }, { hex: "H12" }]);
    // Unchanged drafts are returned by reference.
    expect(clearEndpointBypass(round)).toBe(round);
  });

  it("the authority still refuses an endpoint flag a client might send", () => {
    const state = board(PRR, [prr(["2"])]);
    const forged = [[{ hex: "H10" }, { hex: "H12", bypass: true }]];
    expect(routeSetRefusal(state, { protocol_id: PRR, routes: forged, train_indices: [0] }, ALTOONA, "Yellow")).toMatch(/where the route ends, so it cannot be bypassed/);
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  6. Drawing: the cap does not refuse the click that makes the choice possible                         */
/* ---------------------------------------------------------------------------------------------------- */

describe("W3-E: drawing past Altoona on a short train", () => {
  const draw = (grid: MapGridResponse, labels: string[], maxDistance: number, forCompanyId?: number, blocks?: typeof BLOCKS_H12) => {
    let points: RoutePoint[] = [];
    for (const label of labels) {
      const edit = editRouteDraft({ mapGrid: grid, points, click: point(label), displayLabel: label, maxDistance, forCompanyId, blocksThrough: blocks });
      if (!edit.ok) return edit;
      points = edit.points;
    }
    return { ok: true as const, points };
  };

  it("a PRR 2-train may draw H10 > H12 > H14; the priced draft shows three stops until Bypass is chosen", () => {
    const drawn = draw(ALTOONA, ["H10", "H12", "H14"], 2, PRR);
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    expect(price(drawn.points, PRR).centres).toBe(3);
    expect(price(bypassed(drawn.points), PRR).centres).toBe(2);
  });

  it("but a crossing that already names its arm is counted as drawn: an auto draft's or the player's Stop", () => {
    const decided = (variant: number, bypass?: true): RoutePoint[] => [point("H10"), { ...point("H12"), variant, ...(bypass ? { bypass } : {}) }];
    const click = (points: RoutePoint[]) =>
      editRouteDraft({ mapGrid: ALTOONA, points, click: point("H14"), displayLabel: "H14", maxDistance: 2, forCompanyId: PRR });
    const stop = click(decided(0));
    expect(!stop.ok && stop.reason).toMatch(/3 stops and it can only run 2/);
    expect(click(decided(1, true)).ok).toBe(true); // already bypassed: no stop spent
    expect(click(pts("H10", "H12")).ok).toBe(true); // undecided: the choice is still to be made
  });

  it("the same holds where the bypass is forced", () => {
    expect(draw(ALTOONA, ["H10", "H12", "H14"], 2, NYC, BLOCKS_H12).ok).toBe(true);
  });

  it("an ordinary three-city line is still refused on a 2-train", () => {
    const drawn = draw(LINE, ["I5", "I7", "I9"], 2, CO);
    expect(drawn.ok).toBe(false);
    expect(!drawn.ok && drawn.reason).toMatch(/3 stops and it can only run 2/);
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  7. The control                                                                                       */
/* ---------------------------------------------------------------------------------------------------- */

describe("W3-E: the Stop / Bypass control in the route strip", () => {
  const draft = (choices: TrainRouteDraft["bypassChoices"], extra: Partial<TrainRouteDraft> = {}): TrainRouteDraft => ({
    trainIndex: 0,
    model: "2",
    maxDistance: 2,
    hexLabels: ["H10", "H12", "H14"],
    stops: [{ hex: "H10", value: 20 }, { hex: "H14", value: 20 }],
    value: 40,
    revenueCentres: 2,
    exceedsMaxDistance: false,
    endsOffTerminus: false,
    tokenBlockReason: null,
    bypassChoices: choices,
    ...extra,
  });
  const render = (d: TrainRouteDraft, canClear = true, onSetBypass: ((t: number, i: number, b: boolean) => void) | undefined = () => undefined) =>
    renderToStaticMarkup(
      React.createElement(RouteChipDetail, { draft: d, canClear, onClearRoute: () => undefined, onSetBypass, onClose: () => undefined }),
    );

  it("renders a named pair on the eligible waypoint, the current state pressed", () => {
    const html = render(draft([{ index: 1, hexLabel: "H12", kind: "choice", bypassed: true }]));
    expect(html).toContain('aria-label="H12: stop or bypass"');
    expect(html).toContain(`aria-pressed="false" style=`);
    const attr = (text: string) => text.replace(/'/g, "&#x27;");
    expect(html).toContain(`aria-label="${attr(bypassChoiceTitle("H12", true))}"`);
    expect(html).toContain(`aria-label="${attr(bypassChoiceTitle("H12", false))}"`);
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(html.indexOf('aria-pressed="true"')).toBeGreaterThan(html.indexOf(">Stop<"));
  });

  it("states a forced bypass instead of offering it", () => {
    const html = render(draft([{ index: 1, hexLabel: "H12", kind: "forced" }]));
    expect(html).toContain(forcedBypassNote("H12"));
    expect(html).not.toContain(">Bypass<");
    expect(html).not.toContain(">Stop<");
  });

  it("shows a watcher the state without buttons", () => {
    for (const bypassed of [false, true]) {
      const html = render(draft([{ index: 1, hexLabel: "H12", kind: "choice", bypassed }]), false);
      expect(html).toContain(`>${bypassed ? "bypassed" : "stops"}</span>`);
      expect(html).not.toContain(">Stop<");
      expect(html).not.toContain(">Bypass<");
      expect(html).not.toContain("aria-pressed");
    }
  });

  it("renders nothing new on a route with no bow", () => {
    expect(render(draft([]))).not.toContain("stop or bypass");
    expect(render(draft(undefined))).not.toContain("stop or bypass");
  });

  it("the over-reach line names the stop a Bypass would save", () => {
    expect(tooManyStopsNote("2", [{ index: 1, hexLabel: "H12", kind: "choice", bypassed: false }])).toBe(
      "Too many stops for a 2. Bypass H12 to save a stop, or shorten the route.",
    );
    expect(tooManyStopsNote("2", [{ index: 1, hexLabel: "H12", kind: "forced" }])).toBe("Too many stops for a 2.");
    // Not when one saved stop would not be enough.
    expect(tooManyStopsNote("2", [{ index: 1, hexLabel: "H12", kind: "choice", bypassed: false }], 2)).toBe("Too many stops for a 2.");
    const over = { exceedsMaxDistance: true, revenueCentres: 3 };
    expect(render(draft([{ index: 1, hexLabel: "H12", kind: "choice", bypassed: false }], over))).toContain("Bypass H12 to save a stop");
    expect(render(draft([{ index: 1, hexLabel: "H12", kind: "choice", bypassed: false }], { ...over, revenueCentres: 4 }))).not.toContain("Bypass H12 to save");
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  8. Wiring, and the auto-router left alone                                                            */
/* ---------------------------------------------------------------------------------------------------- */

describe("W3-E: wired from the shell, and the auto-router untouched", () => {
  const APP = readShell();

  it("the shell writes the choice through `setDraftBypass`, and the bar hands it to the strip", () => {
    const handler = sliceBetween(APP, "const handleSetRouteBypass = useCallback(", "const handleSelectRouteTrain = useCallback(");
    expect(handler).toContain("setDraftBypass(mapGrid, points, pointIndex, bypass, blocksThroughCityRef.current, hexLabel)");
    expect(handler).toContain("if (!isMyTurnRef.current) return;");
    expect(handler).toContain("setRouteFeedback(edit.reason);");
    expect(APP).toContain("onSetRouteBypass={handleSetRouteBypass}");
    expect(readStripped("panels/ContextualActionBar.tsx")).toContain("onSetBypass={onSetRouteBypass}");
  });

  it("the priced draft carries the choices off the same points it prices", () => {
    const memo = sliceBetween(APP, "const trainDrafts = useMemo<TrainRouteDraft[]>(() => {", "endsOffTerminus:");
    expect(memo).toContain("const bypassChoices = bypassChoicesFor(mapGrid, points, blocksThroughCityRef.current);");
    expect(memo).toContain("bypassChoices,");
    expect(APP).toContain("bypassedStationReason(points, routeTokenHexes, mapGrid) ??");
  });

  it("hand edits clear an endpoint's flag", () => {
    expect(APP).toContain("return { ...all, [trainIndex]: clearEndpointBypass(edit.points) };");
    expect(APP).toContain("else updated[trainIndex] = clearEndpointBypass(next as RoutePoint[]);");
  });

  it("no engine module and not the auto-route handler consults the manual choice", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const engine = path.join(__dirname, "..", "gameEngine");
    for (const file of fs.readdirSync(engine)) {
      if (!/\.tsx?$/.test(file)) continue;
      expect([file, readSource(`gameEngine/${file}`).includes("manualBypass")]).toEqual([file, false]);
    }
    const auto = sliceBetween(APP, "const handleAutoRoute = useCallback(() => {", "const autoDraftedForRef = useRef");
    for (const name of ["setDraftBypass", "bypassChoicesFor", "clearEndpointBypass"]) expect(auto).not.toContain(name);
  });

  it("the auto-router still drafts its own best set on this board (PRR 2-train: the bow, $40; 3-train: the station, $50)", () => {
    const start = [[hex("H12").q, hex("H12").r, 0], [hex("H10").q, hex("H10").r, 0]] as Array<[number, number, number]>;
    const best = (cap: number) =>
      assignRouteSet({ mapGrid: ALTOONA, era: "Yellow", startHexes: start, companyId: PRR, trains: [{ trainIndex: 0, maxRevenueCentres: cap }] });
    expect(best(2).totalRevenue).toBe(40);
    expect(best(2).assignments[0].path.find((p) => p.hexLabel === "H12")?.bypass).toBe(true);
    expect(best(3).totalRevenue).toBe(50);
    expect(best(3).assignments[0].path.find((p) => p.hexLabel === "H12")?.bypass).not.toBe(true);
  });
});
