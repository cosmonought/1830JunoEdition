/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1662 (harness): S9-1's SECOND HALF -- THE INPUT, NOT JUST THE OUTCOME
// ==================================================================
//
// #1661 MADE THE YELLOW SIGN'S OUTCOME AUTHORITATIVE AND LEFT ITS INPUT ALONE, and the gap is the whole of
// this file. The stage is derived from the turn's draw; the turn's draw was a number the CLIENT chose and
// then committed. Committing a chosen number does not make it a draw -- a crafted client could roll locally
// until the seed produced the stage it wanted, submit that one, and every derivation downstream would
// faithfully reproduce the outcome the player had picked.
//
// So the cases below are about the SEAM #1520 opened: what the server replaces on the way into the log.

export {};

const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
const { normalizeForCommit } =
  require("./serverIngress") as typeof import("./serverIngress");
const { sandboxReplayProviders } =
  require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { applySandboxAction } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { turnSeedKey } = require("./turnSeed") as typeof import("./turnSeed");
const { STANDARD_VARIANTS } = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const { RULES_ENGINE_VERSION } =
  require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
import type { GameStateResponse } from "../gameEngine/gameState";

const BO = 6;
const P1 = "p1";
const SHORT = [{ hex: "F2" }, { hex: "A9" }];
/** What a crafted client would send: a seed it ground for locally, on a turn key of its choosing. */
const CHOSEN_SEED = 123456789;
const SERVER_SEED = 987654321;

const board = (over: Partial<GameStateResponse> = {}, company: Record<string, unknown> = {}): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    operating_sub_phase: "Routes",
    active_operating_order: [BO],
    active_corporation_index: 0,
    player_addresses: [P1],
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
        president: P1,
        treasury: "340",
        last_route_revenue: "0",
        owned_trains: ["3", "4"],
        ...company,
      },
    ],
    ...over,
  }) as unknown as GameStateResponse;

const run = (seed: number, turn?: string) => ({
  RunMultipleRoutes: {
    game_id: 0,
    protocol_id: BO,
    routes: [SHORT],
    trains: ["3"],
    train_indices: [0],
    revenue_seed: seed,
    ...(turn === undefined ? {} : { revenue_turn: turn }),
    payout_strategy: "Withhold",
  },
});

const ctx = (rawLog: Array<{ payload: string }> = []) => ({
  board: { macro_round_number: 3, sub_round_index: 1 },
  rawLog,
  mintSeed: () => SERVER_SEED,
});

const body = (msg: unknown) => (msg as { RunMultipleRoutes: Record<string, unknown> }).RunMultipleRoutes;

describe("S9-1 / #1662: the turn's draw is the server's, at ingress", () => {
  it("1. a client-supplied revenue_seed cannot select the committed seed", () => {
    expect(body(run(CHOSEN_SEED)).revenue_seed).toBe(CHOSEN_SEED);
    expect(body(normalizeForCommit(run(CHOSEN_SEED), ctx())).revenue_seed).toBe(SERVER_SEED);
    /* AND NOT BY WAY OF THE KEY EITHER. The key is what the earlier-draw lookup searches on, so a client that
       could name it could point the search at a turn whose roll it liked -- the same defect one field over. */
    expect(body(normalizeForCommit(run(CHOSEN_SEED, "99.99.99"), ctx())).revenue_turn).toBe(turnSeedKey(3, 1, BO));
  });

  it("2. the normalizer IS the commit point, and the committed payload is what it returned", () => {
    /* THE SEAM IS ONE LINE IN `RoomSession.submit` (#1520's, generalised by #1662): `recorded` is built from
       the client's message and is what the entry carries, and the append is the commit point. Pinned at the
       source, because that placement is the claim -- after the authority gate, before the push, reading the
       SERVER's board and the SERVER's raw log. */
    const SOURCE = readStripped("utils/roomSession.ts");
    expect(SOURCE).toContain("const recorded = normalizeForCommit(input.msg, {");
    expect(SOURCE).toContain("board: this.state,");
    expect(SOURCE).toContain("rawLog: this.log,");
    expect(SOURCE).toContain("mintSeed: this.options.mintSeed,");
    expect(SOURCE).toContain("msg: recorded,");
    /* AND IT RUNS. A `YellowSignEvent` needs no route to be admitted, so it is the cheap end-to-end proof
       that the rewrite happens between the gate and the append rather than only in a unit test: what the
       client sent carried the waiver, and what the room committed does not. */
    let minted = 0;
    const room = new RoomSession({
      providers: sandboxReplayProviders(),
      seed: { state: board(), waterfall: null },
      build: "b",
      mintId: () => `m${(minted += 1)}`,
      now: () => 1000,
      mintSeed: () => SERVER_SEED,
    });
    const answer = room.submit({
      actor: P1,
      build: "b",
      host: P1,
      msg: { YellowSignEvent: { game_id: 0, protocol_id: BO, debug_force: true } } as never,
      baseIndex: room.nextIndex - 1,
    });
    if (answer.kind !== "applied") throw new Error(`refused: ${(answer as { reason?: string }).reason}`);
    const logged = room.entries.filter((e) => "YellowSignEvent" in JSON.parse(e.payload));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0].payload).YellowSignEvent).toEqual({ game_id: 0, protocol_id: BO });
  });

  it("3. replay consumes the stored seed unchanged, and an undo does not re-roll it", () => {
    /* REPLAY NEVER REACHES THE NORMALIZER: a rebuild reads the committed payload. Proved by applying the
       committed entry through the shared reducer with a normalizer that would answer differently. */
    const committed = normalizeForCommit(run(CHOSEN_SEED), ctx());
    const replayed = applySandboxAction(board(), committed as never);
    expect(replayed.public_companies.find((c) => c.company_id === BO)!.last_run_revenue_seed).toBe(SERVER_SEED);
    /* #1051's UNDO RULE SURVIVES THE MOVE TO THE SERVER. A second run for the same turn, with the first
       still in the RAW log (which is what a revert leaves behind), is handed the face already seen -- not a
       fresh draw, which would be the slot machine that rule exists to stop. */
    const rawLog = [{ payload: JSON.stringify(committed) }];
    const again = normalizeForCommit(run(CHOSEN_SEED), {
      ...ctx(rawLog),
      mintSeed: () => 555, // a different draw, deliberately: it must not be reached.
    });
    expect(body(again).revenue_seed).toBe(SERVER_SEED);
  });
});

describe("S9-1 / #1662: debug_force is not a hosted authority", () => {
  const forced = { YellowSignEvent: { game_id: 0, protocol_id: BO, debug_force: true } };

  it("4a. hosted ingress drops it, so it never becomes part of the accepted entry", () => {
    const normalized = normalizeForCommit(forced, ctx()) as { YellowSignEvent: Record<string, unknown> };
    expect("debug_force" in normalized.YellowSignEvent).toBe(false);
    expect(normalized.YellowSignEvent).toEqual({ game_id: 0, protocol_id: BO });
    // An ordinary request is passed through by identity rather than rebuilt.
    const plain = { YellowSignEvent: { game_id: 0, protocol_id: BO } };
    expect(normalizeForCommit(plain, ctx())).toBe(plain);
  });

  it("4b. and the reducer refuses it on a pinned board even if one reached it", () => {
    /* TWO GATES, NOT ONE. The ingress filter is a claim about a transport; this is a claim about the rules,
       and the rule is the one that has to hold on every client that replays the entry. */
    const quiet = quietSeedOn(board());
    const after = applySandboxAction(board(), run(quiet) as never);
    const honest = applySandboxAction(after, { YellowSignEvent: { game_id: 0, protocol_id: BO } } as never);
    const forcedOut = applySandboxAction(after, forced as never);
    expect(corpOf(forcedOut)).toEqual(corpOf(honest));
    expect(corpOf(forcedOut).has_yellow_sign).toBeUndefined();
  });

  it("5. the local sandbox affordance survives, on the unpinned board it was asked for", () => {
    /* #1128's TOOL, WHERE IT WAS MEANT TO WORK. A Firestore sandbox room deals with no server and therefore
       no pin; the waiver is honoured there and the stage is still the board's to choose. */
    const local = board({ rules_engine_version: undefined });
    const quiet = quietSeedOn(local);
    const after = applySandboxAction(local, run(quiet) as never);
    expect(corpOf(applySandboxAction(after, { YellowSignEvent: { game_id: 0, protocol_id: BO } } as never)).has_yellow_sign)
      .toBeUndefined();
    const out = corpOf(applySandboxAction(after, forced as never));
    expect(out.has_yellow_sign).toBe(true);
    expect(out.owned_trains).toEqual(["4"]); // derived, not named
    /* AND A LIVE UNPINNED REQUEST IS STILL DERIVED rather than read as a stored outcome -- the half of the
       branch #1661's pin-only split got wrong. A stored entry (one that NAMES a stage) still replays as
       written, which is the corpus's branch and is pinned by `yellowSignAuthority` case 7. */
    expect(out.treasury).not.toBe("340");
  });
});

/** A seed whose natural draw fires no stage, so a forced case proves the waiver did the work. */
function quietSeedOn(seed: GameStateResponse): number {
  for (let s = 1; s < 400000; s += 1) {
    const after = applySandboxAction(seed, run(s) as never);
    const plain = applySandboxAction(after, { YellowSignEvent: { game_id: 0, protocol_id: BO } } as never);
    if (plain === after) return s;
  }
  throw new Error("no quiet seed");
}

const corpOf = (state: GameStateResponse) => state.public_companies.find((c) => c.company_id === BO)!;
