/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1066-1073 (harness): THE LOG SAYS WHY
// ==================================================================
//
// A PLAYTEST READ OF ONE OPERATING ROUND, and most of it is one complaint wearing several hats: the log
// reports WHAT happened accurately and leaves the reader to infer WHY. A treasury drops on a tile lay with no
// reason given. A corporation "passed" when it had no trains. A turn ending is filed under the step it
// declined to take. Each line was true and each left a question the reader had to answer themselves.
//
// AND ONE OF THEM IS A CONSEQUENCE OF A FIX. #1053 turned "Treasury now $920" into "Treasury $1000 → $920",
// which is strictly more information -- and a transition invites the question a balance does not. Making a
// line better is what made its silence audible.

export {};

const { describeGameplayAction } = require("./actionLog") as typeof import("./actionLog");
const { roundStampFor } = require("./roundLabel") as typeof import("./roundLabel");
const { DEPOT_TOAST_MS, STANDARD_TOAST_MS } =
  require("../components/ActionToast") as typeof import("../components/ActionToast");
const { DUCK_FOR_CUE, DUCK_FOR_VIDEO, RADIO_VOLUME } =
  require("./audio") as typeof import("./audio");
const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
import type { GameStateResponse } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

const APP = readStripped("App.tsx");
const LOG = readStripped("utils/actionLog.ts");

const CO = 3;
const board = (treasury: string, over: Partial<GameStateResponse> = {}): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    operating_sub_phase: "Hardware",
    macro_round_number: 1,
    sub_round_index: 1,
    player_addresses: ["p1"],
    active_player_index: 0,
    active_operating_order: [CO],
    active_corporation_index: 0,
    consecutive_passes: 0,
    private_companies: [],
    public_companies: [
      {
        company_id: CO,
        ticker: "B&O",
        is_floated: true,
        treasury,
        last_route_revenue: "0",
        station_token_hexes: [[0, 0]],
        owned_trains: [],
      },
    ],
    ...over,
  }) as unknown as GameStateResponse;

const context = (before: GameStateResponse, after?: GameStateResponse, over = {}) => ({
  gameState: before,
  afterState: after,
  mapGrid: { game_id: 1, tiles: [] } as unknown as MapGridResponse,
  era: "Yellow" as const,
  labelForAddress: (address: string) => address,
  ...over,
});
const lay = { LayTile: { protocol_id: CO, tile_id: 57, q: 0, r: 0 } } as never;

/* ------------------------------------------------------------------ */
/* Why the money moved                                                 */
/* ------------------------------------------------------------------ */

describe("a tile lay says what it was charged for", () => {
  it("names the terrain cost when something was actually charged", () => {
    /* REPORTED: "It should say WHY the treasury was affected: B&O laid Tile #57 on J14 and paid the terrain
       cost." */
    /* ASSERTED IN PARTS, NOT AS THE WHOLE SENTENCE. The first draft pinned it end to end and failed on the
       HEX NAME -- `boardHexLabel(0, 0)` is not J14, so my own fixture was wrong about a detail this case has
       no opinion about. Pinning a complete sentence makes every clause in it a claim, which is the mistake
       this project keeps re-learning. */
    const paid = describeGameplayAction(lay, context(board("1000"), board("920")) as never);
    expect(paid).toContain("B&O laid Tile #57 on ");
    expect(paid).toContain(" and paid the terrain cost.");
    expect(paid).toContain("Treasury $1000 → $920.");
  });

  it("says nothing about terrain on a free hex", () => {
    /* MOST HEXES ARE FREE, so a sentence that mentioned a cost on every lay would be wrong far more often
       than right -- and #750's whole argument is that a line claiming an expense nobody was charged is worse
       than a line that says less. */
    const line = describeGameplayAction(lay, context(board("1000"), board("1000")) as never);
    expect(line).not.toContain("terrain");
    expect(line).toContain("B&O laid Tile #57 on ");
    expect(line).toContain("Treasury now $1000.");
  });

  it("asks the diff rather than the fee table", () => {
    /* `terrainFeeDue` WOULD BE A SECOND OPINION about what was charged, which is exactly what #750 refuses to
       trust: "an arm that reports its own arithmetic will happily report a bug." Nothing else moves a
       treasury on a `LayTile`, so a movement IS the fee. */
    expect(LOG).toContain("function chargedSomething(");
    expect(LOG).not.toContain("terrainFeeDue");
  });
});

/* ------------------------------------------------------------------ */
/* Why nothing happened                                                */
/* ------------------------------------------------------------------ */

describe("a skipped step says why it was skipped", () => {
  const skip = { AdvanceOperatingSubPhase: { protocol_id: CO } } as never;

  it("puts the corporation in the subject position", () => {
    /* REPORTED: "'[OR 1.1--Run Routes] PRR passed.' ... it would be useful to state why they (auto-passed),
       so either: '[Corp] has no trains to run' or '[Corp] has no routes to run.'"
       THE REASONS ARE `earnableRevenue.ts`'s OWN, not a second copy -- they are what decides the step gets
       skipped at all, and duplicating them phrased differently is #891's shape in prose. */
    expect(
      describeGameplayAction(
        skip,
        context(board("800"), board("800"), {
          skipReason: "it owns no trains, so there is no route to run",
        }) as never,
      ),
    ).toBe("B&O owns no trains, so there is no route to run.");
  });

  it("attaches the possessive without a space before it", () => {
    /* THE JOIN A FRAGMENT-RETURNING HELPER GETS WRONG. `${ticker} ${fragment}` gives "B&O 's trains" for the
       possessive verdict, because the apostrophe has to touch the ticker and a template literal cannot know
       that -- so the helper builds the whole sentence rather than half of one. */
    expect(
      describeGameplayAction(
        skip,
        context(board("800"), board("800"), {
          skipReason: "its trains cannot reach a route that earns anything",
        }) as never,
      ),
    ).toBe("B&O's trains cannot reach a route that earns anything.");
  });

  it("stays short when a player pressed Skip themselves", () => {
    // There is no reason to offer beyond the press, and #1057's rule stands: one line, not two.
    expect(
      describeGameplayAction(skip, context(board("800"), board("800"), { orSubPhase: "Routes" }) as never),
    ).toBe("B&O passed.");
  });
});

describe("ending a turn is not passing a step", () => {
  const pass = { PassTurn: { game_id: 1 } } as never;

  it("says so", () => {
    /* REPORTED: "it clicks End Turn but the Activity Log prints '[OR 1.1--Buy Trains] B&O passed.' Let's
       instead have this say '[OR 1.1] B&O ended its turn.'"
       #958 SPLIT THIS ON THE CURSOR and the split stopped meaning anything: with a step known it said
       "passed", which reads as declining that step -- and `AdvanceOperatingSubPhase` is the message that
       actually means that. */
    expect(
      describeGameplayAction(pass, context(board("800"), board("800"), { orSubPhase: "Hardware" }) as never),
    ).toBe("B&O ended its turn.");
  });

  it("drops the sub-phase from its stamp", () => {
    /* THE TAG WAS TELLING A SMALL LIE: `roundStampFor` reads the cursor, so ending a turn from Buy Trains
       filed the event under Buy Trains. `roundLabelFor` is the same function without the suffix, which is the
       distinction `roundLabel.ts` drew when it split the two. */
    expect(APP).toContain('"PassTurn" in msg ? roundLabelFor(before) : roundStampFor(before)');
  });
});

/* ------------------------------------------------------------------ */
/* Tags                                                                */
/* ------------------------------------------------------------------ */

describe("the stamp reads as a separator", () => {
  it("joins the round and the step with an em dash", () => {
    /* REPORTED: "we currently have, e.g., OR 1.1--Dividends. Please replace '--' with an em dash."
       #958's TYPOGRAPHIC ARGUMENT WAS ABOUT AN EN DASH -- "an en dash and a hyphen are one pixel apart" --
       and an em dash is twice a hyphen's width, so it is not the character that argument was about. */
    const stamp = roundStampFor(board("800", { operating_sub_phase: "Dividends" }));
    expect(stamp).toContain("—");
    expect(stamp).not.toContain("--");
  });

  it("leaves a round with no step alone", () => {
    // Nothing to separate: the em dash is a join, not a decoration.
    expect(roundStampFor(board("800", { current_round_type: "StockRound" } as never))).toBe("SR1");
  });
});

describe("a private closing is tagged as a private company event", () => {
  it("takes the stamp rather than a category prefix", () => {
    /* REPORTED: "The tag for Private company 6. BO needs to be '[OR 1.1--Private Companies] 6. Baltimore &
       Ohio closes.'"
       #1058 PUT THE WORDS IN THE WRONG SLOT -- it set the LABEL, which renders as a `Category — sentence`
       prefix, so the line came out with the classification twice and the stamp still naming whichever step
       the cursor was on. The payout lines got this right one batch earlier (#1059). */
    expect(APP).toContain("const closureStamp =");
    expect(APP).toContain("--Private Companies");
  });

  it("keeps the phase sentence for the phase event", () => {
    // At Phase 5 every private closes together and every one stops paying; #736's sentence is right there.
    expect(APP).toContain("if (phaseTurned) {");
    expect(APP).toContain("pay no further revenue and no longer count toward the certificate limit");
  });
});

describe("a cursor mode is not a game event", () => {
  it("no longer announces targeting", () => {
    /* REPORTED: "The 'targeting mode' is not important and should not print on player-facing information,
       it's just clutter." It was a fact about one player's cursor in a record every client replays. */
    expect(APP).not.toContain("Targeting mode");
    expect(APP).not.toContain('logInfo(\n        "Place Station Token"');
  });

  it("still toggles the mode", () => {
    // THE CONTROL. Deleting a log line must not delete the behaviour it described.
    expect(APP).toContain("setTokenTargetMode((current) => !current);");
  });
});

/* ------------------------------------------------------------------ */
/* The depot toast, and the bed                                        */
/* ------------------------------------------------------------------ */

describe("the depot toast is about the depot", () => {
  it("drops the corporation from the sentence", () => {
    /* REPORTED: "it doesn't need to say which corporation bought a train (players will already know whose
       turn it is)." The name belongs to the TURN, which is on screen in the action bar; the count belongs to
       the table. The Activity Log still names the buyer, which is the division. */
    expect(LOG).toContain("`${tier.tier}-train bought. Depot: ${remaining} remaining.`");
  });

  it("has its own shorter window", () => {
    /* #928 SET 3,700ms FOR A LONGER LINE -- "too short for players to read the financial details" when the
       receipt carried a route total, a percentage and an amount. Six words and a number is a different read. */
    expect(DEPOT_TOAST_MS).toBe(3000);
    expect(DEPOT_TOAST_MS).toBeLessThan(STANDARD_TOAST_MS);
  });

  it("gives the window only to this toast", () => {
    // Every other receipt still takes the default rather than having to name one (#984's optional-last rule).
    const raise = sliceBetween(APP, "showActionToast(\n", ");");
    expect(raise).toContain("globallyBroadcast !== null ? DEPOT_TOAST_MS : undefined");
  });
});

describe("the bed ducks by how much the clip needs", () => {
  it("barely moves for a short cue and drops hard for a video", () => {
    /* REPORTED after the effects were normalised: "they are considerably louder than the radio now ... I'd
       only duck 80% ... EXCEPT ... on the yellow sign and carcosa videos, where indeed the 20% duck for the
       extended play makes sense." */
    /* Design note #1074: read as fractions of whatever the bed is currently at, not as absolute levels --
       a player who drags the radio to 0.1 must not have it ducked UP to 0.36. The 80/20 the report asked for
       is the same; what it is 80% OF is now the slider rather than a constant. */
    expect(DUCK_FOR_CUE).toBeCloseTo(0.8);
    expect(DUCK_FOR_VIDEO).toBeCloseTo(0.2);
    expect(DUCK_FOR_VIDEO).toBeLessThan(DUCK_FOR_CUE);
    // Still a duck and not a boost, whatever the bed is set to.
    expect(DUCK_FOR_CUE).toBeLessThan(1);
    expect(RADIO_VOLUME).toBeGreaterThan(0);
  });

  it("makes the shallow one the default and the deep one explicit", () => {
    /* THE DEFAULT IS THE COMMON CASE. Every flavour cue takes it without saying anything; the one clip that
       competes with the bed asks for the other by name, which is where a reader looking for "why is the radio
       so quiet" will find the answer. */
    const audio = readStripped("utils/audio.ts");
    expect(audio).toContain("export function duckRadio(depth: number = DUCK_FOR_CUE)");
    expect(APP).toContain("duckRadio(DUCK_FOR_VIDEO)");
  });
});
