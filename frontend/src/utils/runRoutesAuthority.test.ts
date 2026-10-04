/** @jest-environment node */
//
// Phase 3 W1-G (AUD-04.02 A-17, AUD-07.01 K-11, AUD-07.02 K-26, AUD-07.04 S6-13, P3-N013): the Run button prices
// and counts exactly what is sent; a dropped draft is named; the pre-dispatch check is the route authority's whole
// question (`routeSetRefusal`), so a set below the demonstrated maximum is explained instead of offered then
// refused; and a run that sends nothing marks nothing.

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";
import type { RunnableDraftShape } from "./runTrainsRules";

const {
  NOTHING_SENT_REASON,
  UNREADABLE_ROUTE_REASON,
  droppedDraftsNote,
  runRoutesTitle,
  runTrainsRefusal,
  runnableDrafts,
  runnableRouteTotal,
} = require("./runTrainsRules") as typeof import("./runTrainsRules");
const { runnableRouteSummary } = require("../components/RoutePlannerPanel") as typeof import("../components/RoutePlannerPanel");
const { evaluateRouteSet, routeSetRefusal } = require("../gameEngine/routeAuthority") as typeof import("../gameEngine/routeAuthority");
const { RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const { readShell, readSource, sliceBetween, stripComments } = require("./sourceScan") as typeof import("./sourceScan");

/* ---------------------------------------------------------------------------------------------------- */
/*  Drafts                                                                                               */
/* ---------------------------------------------------------------------------------------------------- */

type Draft = RunnableDraftShape & { trainIndex: number; model: string };

const draft = (overrides: Partial<Draft> = {}): Draft => ({
  trainIndex: 0,
  model: "3",
  value: 60,
  exceedsMaxDistance: false,
  endsOffTerminus: false,
  tokenBlockReason: null,
  hexLabels: ["I5", "I7", "I9"],
  ...overrides,
});

const TOKENLESS = "This route never passes through one of C&O's stations.";

describe("W1-G (S6-13): the button counts and prices exactly the drafts that are sent", () => {
  it("a tokenless draft is neither counted nor priced -- the old summary did both", () => {
    const drafts = [draft({ trainIndex: 0, value: 60 }), draft({ trainIndex: 1, model: "2", value: 40, tokenBlockReason: TOKENLESS })];
    const sent = runnableDrafts(drafts);
    expect(sent.map((entry) => entry.trainIndex)).toEqual([0]);
    expect(runnableRouteTotal(drafts)).toEqual({ runnable: 1, drafted: 2, totalRevenue: 60 });
    // The bar's button reads the panel's export; it is the same answer.
    expect(runnableRouteSummary(drafts as never)).toEqual(runnableRouteTotal(drafts));
  });

  it("over a matrix of drafts, the projected total is the sum of what `runnableDrafts` sends", () => {
    const flags = [false, true];
    const all: Draft[] = [];
    let index = 0;
    for (const exceeds of flags)
      for (const offEnd of flags)
        for (const tokenless of flags)
          for (const value of [null, 0, 30]) {
            all.push(
              draft({
                trainIndex: index++,
                value,
                exceedsMaxDistance: exceeds,
                endsOffTerminus: offEnd,
                tokenBlockReason: tokenless ? TOKENLESS : null,
              }),
            );
          }
    const sent = runnableDrafts(all);
    expect(runnableRouteTotal(all).totalRevenue).toBe(sent.reduce((sum, entry) => sum + (entry.value ?? 0), 0));
    expect(runnableRouteTotal(all).runnable).toBe(sent.length);
  });
});

describe("W1-G: no draft disappears silently", () => {
  it("names how many were left out, and why, in #883's order (the token before the ending)", () => {
    const drafts = [
      draft({ trainIndex: 0 }),
      draft({ trainIndex: 1, model: "2", value: 40, tokenBlockReason: TOKENLESS, endsOffTerminus: true }),
    ];
    const note = droppedDraftsNote(drafts);
    expect(note).toContain("1 of 2 drafted routes cannot run and is not in this run");
    expect(note).toContain("(2-train): ");
    expect(note).toContain(TOKENLESS);
    expect(note).toContain(runTrainsRefusal([drafts[1]]) as string);
  });

  it("is silent when everything drafted is sent, and counts only drafted routes", () => {
    expect(droppedDraftsNote([draft({ trainIndex: 0 }), draft({ trainIndex: 1, hexLabels: [], value: null })])).toBeNull();
  });

  it("names a runnable draft the handler could not read as a path", () => {
    const drafts = [draft({ trainIndex: 0 }), draft({ trainIndex: 1, model: "4" })];
    const note = droppedDraftsNote(drafts, [drafts[0]]);
    expect(note).toContain("(4-train): ");
    expect(note).toContain(UNREADABLE_ROUTE_REASON);
  });
});

describe("W1-G (K-26): the tooltip does not say revenue is withheld before the dividend choice", () => {
  it("says the choice comes next and nothing is decided yet", () => {
    const title = runRoutesTitle(2, 90);
    expect(title).toContain("Declares all 2 routes for $90.");
    expect(title).toContain("Dividends step that follows");
    expect(title).toContain("nothing is paid or withheld yet");
    expect(title).not.toContain("withheld into the treasury;");
    expect(runRoutesTitle(1, 40, "1 of 2 …")).toContain("Declares this route for $40.");
    expect(runRoutesTitle(1, 40, "1 of 2 …")).toContain("1 of 2 …");
  });

  it("neither copy of the button carries the old sentence; both use the one title", () => {
    const PANEL = stripComments(readSource("components/RoutePlannerPanel.tsx"));
    expect(PANEL).not.toContain("Revenue is withheld into the treasury");
    expect(PANEL.split("runRoutesTitle(").length - 1).toBe(2);
  });
});

describe("W1-G (P3-N013): the unmounted panel no longer carries a second refusal order or runnable filter", () => {
  const PANEL = stripComments(readSource("components/RoutePlannerPanel.tsx"));

  it("asks `runTrainsRefusal` and `runnableDrafts`, and defines neither rule itself", () => {
    expect(PANEL).not.toContain("function firstProblem");
    expect(PANEL).not.toContain("function isRunnableDraft");
    expect(PANEL).not.toContain("draft.value > 0");
    expect(PANEL).toContain("? runTrainsRefusal(drafts)");
    expect(PANEL).toContain("return runnableRouteTotal(drafts);");
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  K-11: the pre-dispatch question is `routeSetRefusal`                                                 */
/* ---------------------------------------------------------------------------------------------------- */

const CO = 5;
function at(label: string): { q: number; r: number } {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no hex ${label}`);
  return { q: hex.q, r: hex.r };
}
/** I5 - I7 - I9, three yellow $20 cities (the `routeAuthority.test.ts` LINE board). A 3-train's best is $60. */
const LINE: MapGridResponse = {
  game_id: 1,
  tiles: (["I5", "I7", "I9"] as const).map((label) => ({ ...at(label), tile_id: 57, orientation: 0 }) as MapTileEntry),
};
const state = {
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
  active_operating_order: [CO],
  active_corporation_index: 0,
  operating_sub_phase: "Routes",
  rules_engine_version: RULES_ENGINE_VERSION,
  market_positions: { [CO]: { price: 100, x: 5, y: 6, enteredAt: 1 } },
  public_companies: [
    {
      company_id: CO,
      ticker: "C&O",
      is_floated: true,
      president: "p1",
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: "300",
      owned_trains: ["3"],
      player_holdings: [{ player: "p1", percentage: 60 }],
      station_token_hexes: [[at("I5").q, at("I5").r]],
      station_tokens: [[at("I5").q, at("I5").r, 0]],
      station_token_limit: 3,
      home_hex_label: "I5",
    },
  ],
} as unknown as GameStateResponse;
const SHORT = [[{ hex: "I5" }, { hex: "I7" }]];

describe("W1-G (K-11): a hand-drawn set below the demonstrated maximum is explained before dispatch", () => {
  it("the old preview (`evaluateRouteSet`) passed it; the authority's whole question refuses it with the figure", () => {
    expect(evaluateRouteSet({ state, mapGrid: LINE, era: "Yellow", companyId: CO, routes: SHORT, trainIndices: [0], trains: ["3"] }).kind).toBe("legal");
    expect(routeSetRefusal(state, { protocol_id: CO, routes: SHORT, trains: ["3"], train_indices: [0] }, LINE, "Yellow")).toMatch(
      /Route set earns \$40; a legal combination worth \$60 is available\./,
    );
  });

  it("the shell asks `routeSetRefusal` on the message it is about to send, and no longer `evaluateRouteSet`", () => {
    const APP = readShell();
    const handler = sliceBetween(APP, "const handleRunTrains = useCallback(", "setLiveOrSubPhase(\"Dividends\");");
    expect(handler).toContain("const refusal = routeSetRefusal(");
    expect(handler).toContain("protocol_id: actingProtocolId,");
    expect(handler).toContain("routes: turnRoutes.map((entry) => entry.path),");
    expect(handler).toContain("train_indices: turnRoutes.map((entry) => entry.trainIndex),");
    expect(handler).toContain("tileEraFor(previewState),");
    expect(handler).toContain("setRouteFeedback(refusal);");
    expect(APP).not.toContain("evaluateRouteSet(");
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  A-17: nothing sent, nothing marked                                                                   */
/* ---------------------------------------------------------------------------------------------------- */

describe("W1-G (A-17): when nothing legal is sent, the step is not marked run and does not advance", () => {
  const APP = readShell();
  const handler = sliceBetween(APP, "const handleRunTrains = useCallback(", "}, [runGameplayAction, gameId, trainDrafts");

  it("every path that marks `ran: true` and steps to Dividends has dispatched first", () => {
    const empty = handler.indexOf("if (turnRoutes.length === 0) {\n      setRouteFeedback(NOTHING_SENT_REASON);\n      return;\n    }");
    const authority = handler.indexOf("const refusal = routeSetRefusal(");
    const dispatch = handler.indexOf('await runGameplayAction("RunMultipleRoutes"');
    const marked = handler.indexOf("setRoutesRunThisTurn({ protocolId: actingProtocolId, ran: true });");
    const advanced = handler.indexOf('setLiveOrSubPhase("Dividends");');
    expect(empty).toBeGreaterThan(-1);
    expect(authority).toBeGreaterThan(empty);
    expect(dispatch).toBeGreaterThan(authority);
    expect(marked).toBeGreaterThan(dispatch);
    expect(advanced).toBeGreaterThan(marked);
    // The dispatch is no longer conditional, so nothing can fall past it unsent.
    expect(handler).not.toContain("if (turnRoutes.length > 0)");
    expect(handler.match(/await runGameplayAction\(/g)?.length).toBe(1);
  });

  it("the empty-run sentence says nothing was run", () => {
    expect(NOTHING_SENT_REASON).toContain("nothing was run");
  });

  it("a dropped draft is announced after the dispatch, through the general toast", () => {
    expect(handler).toContain("const droppedNote = droppedDraftsNote(");
    expect(handler).toContain("if (droppedNote !== null) showActionToast(droppedNote);");
  });
});
