/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1661 (harness): S9-1 -- THE SIGN'S OUTCOME IS THE BOARD'S, NOT THE CLIENT'S
// ==================================================================
//
// THE DEFECT THESE CASES CLOSE: `YellowSignEvent` carried `stage`, `model`, `cash` and `revenue_seed`, and
// the authoritative reducer applied them after a shape check. So an ordinary hosted client chose the outcome
// of a random event -- which train left, how much the treasury gained, whether a corporation became
// Carcosan, and when the doom clock started.
//
// WHAT IS PROVED HERE IS A PAIR OF PROPERTIES, not a matrix of stages. Every case sends the SAME request
// against the SAME pinned board and varies only what the client claimed: a forged field must make no
// difference at all. The last two cases are the other half -- that the legitimate event still moves the
// board, and that the corpus's unpinned entries still replay from what they stored.

import { applySandboxAction } from "../gameEngine/sandboxSession";
import { resolveYellowSign, markPayout, lowestValueTrain } from "../gameEngine/yellowSign";
import { STANDARD_VARIANTS, legacyTurnSeed } from "../gameEngine/gameVariants";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import type { GameStateResponse } from "../gameEngine/gameState";

const BO = 6;
const CO = 5;
const SHORT = [{ hex: "F2" }, { hex: "A9" }];

/** A pinned Operating Round board -- `rules_engine_version` is what makes it authoritative (#1661). */
const board = (over: Partial<GameStateResponse> = {}, company: Record<string, unknown> = {}): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    operating_sub_phase: "Routes",
    active_operating_order: [BO],
    active_corporation_index: 0,
    player_addresses: ["p1"],
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    private_companies: [],
    rules_engine_version: RULES_ENGINE_VERSION,
    variants: { ...STANDARD_VARIANTS, unpredictableRevenue: true },
    public_companies: [
      {
        company_id: BO,
        ticker: "B&O",
        president: "p1",
        treasury: "340",
        last_route_revenue: "0",
        owned_trains: ["3", "4"],
        ...company,
      },
      { company_id: CO, ticker: "C&O", president: "p2", treasury: "100", last_route_revenue: "0", owned_trains: ["4"] },
    ],
    ...over,
  }) as unknown as GameStateResponse;

const corp = (state: GameStateResponse, id = BO) => state.public_companies.find((entry) => entry.company_id === id)!;

/** A run, which is what commits the turn's draw to the board (`last_run_revenue_seed`, #1661). */
const ran = (state: GameStateResponse, seed: number) =>
  applySandboxAction(state, {
    RunMultipleRoutes: { protocol_id: BO, routes: [SHORT, SHORT], trains: ["3", "4"], train_indices: [0, 1], revenue_seed: seed },
  } as never);

/** The bare request a live client sends after #1661: who is resolving, and nothing else. */
const request = (extra: Record<string, unknown> = {}) =>
  ({ YellowSignEvent: { game_id: 0, protocol_id: BO, ...extra } }) as never;

/** A seed whose natural draw is the Mark, found once against the real selector rather than asserted. */
function seedForStage(stage: "mark" | "carcosa", base: GameStateResponse): number {
  for (let seed = 1; seed < 400000; seed += 1) {
    const after = ran(base, seed);
    if (resolveYellowSign(after, BO, stage === "mark" ? "4" : "6").outcome?.stage === stage) return seed;
  }
  throw new Error(`no seed reaches ${stage}`);
}

const MARK_SEED = seedForStage("mark", board());

describe("S9-1: the Yellow Sign outcome is derived from the committed board", () => {
  it("1. the same pre-state and the same committed draw produce the same outcome, every time", () => {
    const after = ran(board(), MARK_SEED);
    const once = applySandboxAction(after, request());
    const twice = applySandboxAction(ran(board(), MARK_SEED), request());
    expect(corp(once).owned_trains).toEqual(corp(twice).owned_trains);
    expect(corp(once).treasury).toBe(corp(twice).treasury);
    expect(corp(once).last_route_revenue).toBe(corp(twice).last_route_revenue);
    expect(corp(once).has_yellow_sign).toBe(true);
    /* AND THE SHELL'S READER AGREES WITH THE BOARD'S, which is the property that lets the Activity Log stop
       carrying the answer: one function, two callers (#1375's rule, applied to the whole event). */
    const narrated = resolveYellowSign(after, BO, "4").outcome!;
    expect(narrated.model).toBe(lowestValueTrain(["3", "4"]));
    expect(Number(corp(once).treasury)).toBe(340 + narrated.cash);
  });

  it("2. a forged stage changes nothing -- the board decides which stage fires", () => {
    const after = ran(board(), MARK_SEED);
    const honest = applySandboxAction(after, request());
    for (const stage of ["carcosa", "fog"] as const) {
      const forged = applySandboxAction(after, request({ stage, model: "D", cash: "9999" }));
      expect(corp(forged)).toEqual(corp(honest));
    }
    // And the stage that did fire is the Mark, not either forgery.
    expect(corp(honest).is_carcosan).toBeUndefined();
    expect(corp(honest).ghost_trains).toBeUndefined();
  });

  it("3. a forged corporation and a forged train change nothing", () => {
    const after = ran(board(), MARK_SEED);
    const honest = applySandboxAction(after, request());
    /* THE EXPENSIVE TRAIN, NAMED. Before #1661 the arm spliced whatever `model` said, so a president could
       have kept the 3 and lost the 4 -- or the reverse, whichever suited. */
    const forged = applySandboxAction(after, request({ stage: "mark", model: "4", cash: "90" }));
    expect(corp(forged).owned_trains).toEqual(corp(honest).owned_trains);
    expect(corp(honest).owned_trains).toEqual(["4"]);
    // The corporation is the one that ran; naming another does not move it.
    expect(corp(after, CO)).toEqual(corp(honest, CO));
  });

  it("4. a forged cash award cannot inflate the treasury", () => {
    const after = ran(board(), MARK_SEED);
    const honest = applySandboxAction(after, request());
    const forged = applySandboxAction(after, request({ stage: "mark", model: "3", cash: "999999" }));
    expect(corp(forged).treasury).toBe(corp(honest).treasury);
    expect(Number(corp(honest).treasury)).toBe(340 + markPayout("3"));
  });

  it("5. the gift/Carcosa branch cannot be forged onto a board the sign has not reached", () => {
    /* NOBODY IS MARKED HERE, so no escalation is legal however the message is written. Before #1661 this
       message gifted a D-train, armed the doom clock and made the corporation permanently Carcosan. */
    const after = ran(board(), MARK_SEED);
    const forged = applySandboxAction(after, request({ stage: "carcosa", model: "D" }));
    expect(corp(forged).is_carcosan).toBeUndefined();
    expect(corp(forged).ghost_trains).toBeUndefined();
    expect(corp(forged).carcosan_trains).toBeUndefined();
    expect(corp(forged).carcosan_doom_after_macro_round).toBeUndefined();
    /* AND THE FOG CANNOT BE FORGED EITHER. There is no gold-trimmed train here, so the board's own answer --
       the Mark this turn's draw reached -- is what applies; the forged stage names a train ("4") that the
       Mark does not take, and it stays. Before #1661 this message deleted it. */
    const fogged = applySandboxAction(after, request({ stage: "fog", model: "4" }));
    expect(corp(fogged)).toEqual(corp(applySandboxAction(after, request())));
    expect(corp(fogged).owned_trains).toEqual(["4"]);
    expect(corp(fogged).carcosan_trains).toBeUndefined();
  });

  it("6. the legitimate authoritative event still applies the intended mutation", () => {
    const after = ran(board(), MARK_SEED);
    const before = corp(after);
    const takenPrinted = Number(before.last_run_breakdown!.find((entry) => entry.model === "3")!.printed_revenue);
    const printedBefore = Number(before.printed_route_revenue);
    const marked = applySandboxAction(after, request());
    const c = corp(marked);
    expect(c.owned_trains).toEqual(["4"]);
    expect(c.has_yellow_sign).toBe(true);
    expect(Number(c.treasury)).toBe(340 + markPayout("3"));
    // #1375's kept run: the taken train's route comes off, the remainder is re-rolled under the same draw.
    expect(Number(c.printed_route_revenue)).toBe(printedBefore - takenPrinted);
    expect(c.routes_run_this_turn).toBe(1);
    expect(c.last_run_breakdown!.map((entry) => entry.model)).toEqual(["4"]);
  });

  it("6b. the escalation and the fog, derived, on the boards that permit them", () => {
    /* THE ESCALATION. Phase 6, B&O already marked, and a draw whose bucket is the critical bonus -- the
       gates #1046 set. The gift's TIER is derived from the phase, so a client cannot ask for a D in phase 6. */
    const marked = board({}, { has_yellow_sign: true, owned_trains: ["6"] });
    let seed: number | null = null;
    for (let s = 1; s < 400000 && seed === null; s += 1) {
      if (resolveYellowSign(ran(marked, s), BO, "6").outcome?.stage === "carcosa") seed = s;
    }
    expect(seed).not.toBeNull();
    const escalated = applySandboxAction(
      ran(marked, seed!),
      // The forged D is ignored; phase 6 gifts a 6.
      request({ stage: "carcosa", model: "D" }),
    );
    expect(corp(escalated).is_carcosan).toBe(true);
    expect(corp(escalated).carcosan_trains).toEqual(["6"]);
    expect(corp(escalated).ghost_trains).toEqual(["6"]);
    expect(corp(escalated).has_yellow_sign).toBe(false);
    // A gifted 6 starts no clock -- only a Diesel does (#1089).
    expect(corp(escalated).carcosan_doom_after_macro_round).toBeUndefined();

    /* THE FOG, whose debt is the doom clock rather than a draw: the marked train is derived, not named. */
    const doomed = board(
      { macro_round_number: 5 },
      { is_carcosan: true, owned_trains: ["4", "D"], carcosan_trains: ["D"], carcosan_doom_after_macro_round: 4 },
    );
    const fogged = applySandboxAction(ran(doomed, MARK_SEED), request({ stage: "mark", model: "4", cash: "9999" }));
    expect(corp(fogged).owned_trains).toEqual(["4"]);
    expect(corp(fogged).carcosan_trains).toEqual([]);
    expect(corp(fogged).is_carcosan).toBe(true); // the curse outlives the train (#1092)
    expect(corp(fogged).treasury).toBe("340"); // and the forged award bought nothing
  });

  it("7. an unpinned board still replays its stored outcome, so the corpus is untouched", () => {
    /* JUNO-Z6C's SHAPE. Index 203 is `{stage:"mark", model:"3", cash:"90"}` with NO `revenue_seed`, played
       under #1046's zeroing; re-deriving it would silently give it #1375's kept run instead. An unpinned
       board is a fixture, not a game (`SERVER_REPLAY_POLICY.legacyLogs: "refuse"`), and takes the branch it
       always took -- which is why this slice bumps no version. */
    const legacy = board({ rules_engine_version: undefined });
    const after = ran(legacy, legacyTurnSeed(3, 1, BO));
    const stored = applySandboxAction(after, {
      YellowSignEvent: { game_id: 0, protocol_id: BO, stage: "mark", model: "3", cash: "90" },
    } as never);
    expect(corp(stored).owned_trains).toEqual(["4"]);
    expect(Number(corp(stored).treasury)).toBe(340 + 90); // the STORED award, not `markPayout`
    expect(corp(stored).last_route_revenue).toBe("0"); // #1046's zeroing, kept
    expect(corp(stored).printed_route_revenue).toBe("0");
  });

  it("8. the debug force is inert on an authoritative board", () => {
    /* A QUIET TURN -- a seed whose natural draw fires no stage -- so a pass means the waiver was refused
       rather than the turn happening to be quiet anyway.
       #1662 (S9-1, second half): #1128's waiver is a PLAYTEST affordance and an authoritative room has no
       playtests. It is dropped at hosted ingress (`serverIngress.ts`) and refused here on a pinned board, so
       an ordinary hosted client cannot force the event at all. Where it still works -- a Firestore sandbox
       room, which deals unpinned -- is pinned by `yellowSignIngress` case 5. */
    let quiet: number | null = null;
    for (let s = 1; s < 400000 && quiet === null; s += 1) {
      if (resolveYellowSign(ran(board(), s), BO, "4").outcome === null) quiet = s;
    }
    expect(quiet).not.toBeNull();
    const after = ran(board(), quiet!);
    const honest = applySandboxAction(after, request());
    expect(corp(honest).has_yellow_sign).toBeUndefined();
    const forced = applySandboxAction(after, request({ debug_force: true }));
    expect(corp(forced)).toEqual(corp(honest));
    expect(corp(forced).has_yellow_sign).toBeUndefined();
    expect(corp(forced).owned_trains).toEqual(["3", "4"]);
  });

  it("9. the turn's committed draw is recorded on the board and cleared with the turn", () => {
    const after = ran(board(), MARK_SEED);
    expect(corp(after).last_run_revenue_seed).toBe(MARK_SEED);
    /* AND IT IS TURN-SCOPED (#777): a seed outliving its turn would price the next turn's sign against the
       last turn's roll -- the one staleness that would change WHICH STAGE fires. */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "gameEngine", "sandboxSession.ts"),
      "utf8",
    ) as string;
    expect(src).toContain("last_run_revenue_seed: undefined,");
    expect(src).toContain("company.last_run_revenue_seed !== undefined ||");
  });
});
