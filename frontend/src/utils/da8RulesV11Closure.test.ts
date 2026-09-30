/** @jest-environment node */
//
// ==================================================================
//  DA-8: DELAYED AUCTION CERTIFICATION CLOSURE -- THE ONE DELIBERATE BUMP, 10 -> 11 (Phase 2's rules-engine closure)
// ==================================================================
//
// THE SAME SHAPE AS 7.5, 8.5, STAGE 9, STAGE 10, GR-5 AND UR-8. DA-3, DA-4, DA-5 and Phase 2A's RR2A-F1 each changed what
// a stored log replays to and each left the pin at 10, so DA-7 could certify the variant slice by slice against one
// baseline; the Delayed Auction takes ONE bump at closure, where the whole semantic set is named in one changelog row --
// together with DA-F12 (the revenue all-pass resumes on the Priority Deal holder), which DA-8 fixes and pins here.
//
// WHAT THIS FILE PROVES:
//   1. the bump: 11, the one supported version; row 11 names exactly ten replay semantics, the non-rules behind a marker;
//   2. the supported-version matrix under a v11-only server, with 10 as the prior pinned version -- a v10 room (the
//      Delayed Auction's too) is HELD, never reinterpreted, never rewritten, and holds the same way on every rebuild;
//   3. DA-F12: after the revenue all-pass the sequence resumes with the Priority Deal holder, in the standard game and
//      the Delayed Auction, through ingress and the reducer; the purchase-led lap (the corpus's shape) is unchanged, and
//      the stored corpus's every revenue all-pass already resumed on the holder -- so the correction moves none of it;
//   4. the Delayed Auction on v11: the deal, the dormant auction, the reserved C&A share, the round authority, the arming
//      on the Priority Deal holder -- and DA-T10's one composition question that touches the trigger: a synthetic
//      (Carcosa-gifted) 3-train does not arm the delayed auction, a real one does;
//   5. settlement is a SEPARATE AXIS (the owner's DA-8 ruling): certified for v10, byte-for-byte; a v11 board was
//      refused until ESCROW-3A recertified v11 on its own evidence (`settlementV11Certification.test.ts`); the v11
//      reducer rebuilds the certified v10 golden board exactly, the pin aside; the frozen vectors still name 10;
//   6. the v10 -> v11 boundary scan (`rulesBoundaryScan.ts`, `gamesDoctor scan-v10`): each routed pattern is found where
//      it is, nothing is found where it is not, and the scan writes nothing.
// It OWNS the current version literal until the next closure narrows it, as this pass narrowed
// `unpredictableRevenueClosure.test.ts` (UR-8's precedent for `gentleRustClosure`).

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

import { RoomSession } from "./roomSession";
import type { ServerLogEntry } from "./roomSession";
import { RoomEngine, replayLog, entriesFromExport } from "../gameEngine/replayLog";
import type { ExportedEntry, ReplayProviders } from "../gameEngine/replayLog";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { stateDigest } from "../gameEngine/stateDigest";
import { actingAddress, type GameStateResponse } from "../gameEngine/gameState";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { operatingRoundSequenceLength } from "../gameEngine/sandboxSession";
import { auctionPriorityHolder } from "../gameEngine/auctionAuthority";
import { derivePhase } from "../gameEngine/gamePhase";
import { SV_PRIVATE_ID } from "../gameEngine/gameConstants";
import {
  DEVELOPMENT_CORPUS_POLICY,
  RULES_ENGINE_CHANGELOG,
  RULES_ENGINE_VERSION,
  RULES_ENGINE_VERSION_FIELD,
  ReplayIncompatibleError,
  SERVER_REPLAY_POLICY,
  SUPPORTED_RULES_ENGINE_VERSIONS,
  replayCompatibility,
  replayRefusal,
  rulesEngineVersionOf,
} from "../gameEngine/rulesVersion";
import { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS, appraiseSeats } from "../gameEngine/settlementAppraisal";
import { terminalStateHashV1 } from "../gameEngine/settlementDigest";
import {
  SET0A_CERTIFIED_RULES_ENGINE_VERSION,
  atCertifiedSettlementPin,
  goldenBoards,
  syn01ClassicBankBreak,
} from "./settlementGoldenBoards";
import { scanPinnedHistory, summarizeBoundaryScan } from "./rulesBoundaryScan";
import { readStripped } from "./sourceScan";

type State = GameStateResponse;

const BUILD = "b-da8";
const A = "p-da8-a01";
const B = "p-da8-b02";
const C = "p-da8-c03";
/** The version this closure replaced: the prior pinned version of the matrix below. */
const PRIOR = 10;
const DH = 3;
const CS = 2;

const seed = () => ({
  state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});

function countingProviders(): { providers: ReplayProviders; count: () => number } {
  const real = sandboxReplayProviders();
  let fed = 0;
  return {
    providers: { ...real, chartInjections: (state) => ((fed += 1), real.chartInjections(state)) },
    count: () => fed,
  };
}

function session(entries?: readonly ServerLogEntry[], opts: { providers?: ReplayProviders; dev?: boolean; start?: object } = {}) {
  let n = 0;
  const room = new RoomSession({
    providers: opts.providers ?? sandboxReplayProviders(),
    seed: (opts.start ?? seed()) as never,
    build: BUILD,
    mintId: () => `da8-${(n += 1)}`,
    now: () => 1_000 + n,
    ...(opts.dev ? { replayPolicy: DEVELOPMENT_CORPUS_POLICY } : {}),
  });
  if (entries) room.restore(entries);
  return room;
}

const SETUP = (delayed: boolean, claimed?: number) =>
  ({
    SetupGame: {
      players: [
        { id: A, nickname: "A" },
        { id: B, nickname: "B" },
        { id: C, nickname: "C" },
      ],
      variants: { delayedAuction: delayed, length: "standard", rules: 1 },
      build: BUILD,
      ...(claimed === undefined ? {} : { [RULES_ENGINE_VERSION_FIELD]: claimed }),
    },
  }) as never;
const BUY = { WaterfallBuyLowest: { game_id: 0 } };
const PASS = { WaterfallPass: { game_id: 0 } };
const BID = (privateId: number, amount: number) => ({ WaterfallBidHigher: { game_id: 0, private_id: privateId, bid_amount: String(amount) } });
const PASS_TURN = { PassTurn: { game_id: 0 } };
const BEGIN_OR = { BeginOperatingRound: { game_id: 0 } };

const actorOf = (board: State) => actingAddress(board, board.waterfall ?? null) as string;
const seatOf = (board: State) => board.player_addresses[board.active_player_index];
const leftOf = (board: State, player: string) =>
  board.player_addresses[(board.player_addresses.indexOf(player) + 1) % board.player_addresses.length];
const cashOf = (board: State, player: string) => Number(board.player_cash.find((row) => row.player === player)?.cash_vgp ?? NaN);
const ownerOf = (board: State, id: number) => board.private_companies.find((row) => row.private_id === id)?.owner ?? null;

const submit = (room: RoomSession, actor: string, msg: unknown) =>
  room.submit({ actor, build: BUILD, msg: msg as never, baseIndex: room.nextIndex - 1, host: A } as never);
function applied(room: RoomSession, actor: string, msg: unknown) {
  const answer = submit(room, actor, msg) as { kind: string; reason?: string };
  if (answer.kind !== "applied") throw new Error(`${Object.keys(msg as object)[0]} by ${actor} was ${answer.kind}: ${answer.reason ?? ""}`);
}

/** A standard room dealt by this server: the opening auction, on its opener. */
function standardRoom(claimed?: number): RoomSession {
  const room = session();
  applied(room, A, SETUP(false, claimed));
  return room;
}

const setupPayloadOf = (entries: readonly ServerLogEntry[]) =>
  JSON.parse(entries.find((row) => "SetupGame" in JSON.parse(row.payload))!.payload).SetupGame as Record<string, unknown>;

/** A stored log whose deal names `version` (or none) -- what a store written by another engine looks like. */
const repinned = (entries: readonly ServerLogEntry[], version: number | undefined): ServerLogEntry[] =>
  entries.map((row) => {
    const parsed = JSON.parse(row.payload) as { SetupGame?: Record<string, unknown> };
    if (!parsed.SetupGame) return { ...row };
    const setup = { ...parsed.SetupGame };
    if (version === undefined) delete setup[RULES_ENGINE_VERSION_FIELD];
    else setup[RULES_ENGINE_VERSION_FIELD] = version;
    return { ...row, payload: JSON.stringify({ ...parsed, SetupGame: setup }) };
  });

/** The DA-F12 script, relative to the auction's opener O (L on his left, R on L's): O buys the SV at face (the card goes
 *  to L), L bids on the D&H, then R, O and L pass -- the revenue all-pass. Returns the three seats. */
function da12Script(room: RoomSession): { O: string; L: string; R: string } {
  const O = actorOf(room.state);
  const L = leftOf(room.state, O);
  const R = leftOf(room.state, L);
  applied(room, O, BUY);
  applied(room, L, BID(DH, 75));
  applied(room, R, PASS);
  applied(room, O, PASS);
  applied(room, L, PASS);
  return { O, L, R };
}

const row11 = () => RULES_ENGINE_CHANGELOG[10].note;

/* ================================================================================================= */
/* 1. THE BUMP                                                                                        */
/* ================================================================================================= */

/* Route v12 R12-2 moved the engine to 12. As every closure test before it (UR-8's, GR-5's), this one now pins its
   own row and the invariants that outlive it -- "at least 11", "the one supported version is the current one" --
   rather than a number a later bump must move. */
describe("RULES_ENGINE_VERSION 11 (Delayed Auction certification closure, DA-8)", () => {
  it("is at least 11, and the current version is the one supported version", () => {
    expect(RULES_ENGINE_VERSION).toBeGreaterThanOrEqual(11);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([RULES_ENGINE_VERSION]);
    // Derived, as every bump since version 1 has left it -- the bump REPLACES the supported version.
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([RULES_ENGINE_VERSION]);
  });

  it("the changelog has an eleventh row, rows 1 - 10 are untouched in order, and row 11 certifies the Delayed Auction", () => {
    expect(RULES_ENGINE_CHANGELOG.map((row) => row.version).slice(0, 11)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(RULES_ENGINE_CHANGELOG[9].note).toMatch(/^Unpredictable Revenue certification closure \(UR-8/);
    expect(row11()).toMatch(/^Delayed Auction certification closure \(DA-8, 2026-09-27\)/);
    expect(row11()).toMatch(/Phase 2's rules-engine closure/);
  });

  it("row 11 names exactly ten replay semantics, each with its slice", () => {
    const note = row11();
    for (const phrase of [
      /REPLAY SEMANTICS, exactly ten/,
      /\(1\) DA-3 \(DA-F1\)/,
      /a forged\s+`WaterfallPass` after an auction no longer pays private income/,
      /\(2\) DA-3 \(DA-F2\)/,
      /\(3\) DA-3 \(DA-F7\)/,
      /\(4\) DA-4 \(DA-F3\)/,
      /\(5\) DA-4 \(DA-F4, DA-F5\)/,
      /\$0 Schuylkill Valley taking/,
      /\(6\) DA-5 \(D-52, DA-F6\)/,
      /reserved_certificate/,
      /\(7\) DA-5 \(D-53, D-57,\s+D-58, D-59\)/,
      /CURABLE part only/,
      /\(8\) DA-5 \(D-55, DA-F9\)/,
      /\(9\) RR2A-F1 \(Phase 2A\)/,
      /roundTransitionRefusal/,
      /\(10\) DA-8 \(DA-F12\)/,
      /auctionPriorityHolder/,
      /none of the\s+ten asks the pin's value/,
      /A version-10 log/,
      /refused, never reinterpreted/,
    ]) {
      expect(`row11 matches ${String(phrase)}: ${phrase.test(note)}`).toBe(`row11 matches ${String(phrase)}: true`);
    }
    expect(note.match(/\(\d+\) (?:DA|RR2A)-[\w-]+/g)).toEqual([
      "(1) DA-3",
      "(2) DA-3",
      "(3) DA-3",
      "(4) DA-4",
      "(5) DA-4",
      "(6) DA-5",
      "(7) DA-5",
      "(8) DA-5",
      "(9) RR2A-F1",
      "(10) DA-8",
    ]);
  });

  it("the row keeps UI / copy, C2-02, LIVE-2's ingress, the tests and DA7-L1 behind an explicit NOT RULES marker, and names the settlement axis", () => {
    const note = row11();
    const notRules = note.indexOf("NOT RULES");
    expect(notRules).toBeGreaterThan(note.indexOf("(10) DA-8"));
    for (const nonRule of ["DA-6's UI", "C2-02", "LIVE-2's ingress", "RR2A-F2", "DA7-L1"]) {
      const at = note.indexOf(nonRule);
      expect([nonRule, at > notRules]).toEqual([nonRule, true]);
    }
    expect(note).toMatch(/None of them moves a board, a message or a digest/);
    expect(note).toMatch(/SETTLEMENT IS A SEPARATE AXIS/);
    expect(note).toMatch(/stays \[10\]/);
    // Nothing of Phase 3 is swept into the version.
    for (const unrelated of ["ESCROW-3", "GNOLAND", "Forfeit"]) expect([unrelated, note.includes(unrelated)]).toEqual([unrelated, false]);
  });
});

/* ================================================================================================= */
/* 2. THE SUPPORTED-VERSION MATRIX                                                                    */
/* ================================================================================================= */

describe("the supported-version matrix under a single-version server (v11 at DA-8; the current engine since)", () => {
  it("1. a newly dealt game records the current rules_engine_version -- on the log and on the board, whatever the client claimed", () => {
    for (const claimed of [undefined, 1, 9, PRIOR, 11, RULES_ENGINE_VERSION + 1, 999]) {
      for (const delayed of [false, true]) {
        const room = session();
        applied(room, A, SETUP(delayed, claimed));
        expect(setupPayloadOf(room.entries)[RULES_ENGINE_VERSION_FIELD]).toBe(RULES_ENGINE_VERSION);
        expect(room.rulesEngineVersion()).toBe(RULES_ENGINE_VERSION);
        expect(room.state.rules_engine_version).toBe(RULES_ENGINE_VERSION);
      }
    }
  });

  it("2. a current-version room restores and replays deterministically: twice, to the live board", () => {
    const live = standardRoom();
    da12Script(live);
    expect(replayCompatibility(live.entries)).toEqual({ kind: "compatible", version: RULES_ENGINE_VERSION });
    const first = session(live.entries);
    const second = session(live.entries);
    expect(stateDigest(first.state)).toBe(stateDigest(live.state));
    expect(stateDigest(second.state)).toBe(stateDigest(live.state));
    const headless = replayLog(entriesFromExport(live.entries), sandboxReplayProviders(), seed(), undefined, SERVER_REPLAY_POLICY);
    expect(stateDigest(headless.state)).toBe(stateDigest(live.state));
  });

  it("3. a v10-pinned room -- standard or Delayed Auction -- is INCOMPATIBLE: held before the reducer sees an entry, under every policy, on every rebuild", () => {
    for (const delayed of [false, true]) {
      const live = session();
      applied(live, A, SETUP(delayed));
      if (!delayed) applied(live, actorOf(live.state), BUY);
      const ten = repinned(live.entries, PRIOR);
      expect(replayCompatibility(ten)).toEqual({ kind: "incompatible", version: 10, supported: [RULES_ENGINE_VERSION] });
      const apply = jest.spyOn(RoomEngine.prototype, "apply");
      try {
        for (const dev of [false, true]) {
          for (let restart = 0; restart < 2; restart += 1) {
            const counting = countingProviders();
            const held = session(ten, { providers: counting.providers, dev });
            expect(held.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 10, supported: [RULES_ENGINE_VERSION] });
            expect(held.incompatible?.reason).toMatch(new RegExp(`rules engine version 10; this server supports version ${RULES_ENGINE_VERSION}\\b`));
            expect(stateDigest(held.state)).toBe(stateDigest(session().state));
            expect(counting.count()).toBe(0);
          }
        }
        expect(apply).not.toHaveBeenCalled();
      } finally {
        apply.mockRestore();
      }
      for (const policy of [SERVER_REPLAY_POLICY, DEVELOPMENT_CORPUS_POLICY]) {
        expect(() => replayLog(entriesFromExport(ten), sandboxReplayProviders(), seed(), undefined, policy)).toThrow(ReplayIncompatibleError);
      }
    }
  });

  it("4. every other unsupported numeric version is incompatible too -- the future included; a missing pin is legacy and refused", () => {
    const base = standardRoom().entries;
    for (const version of [0, 1, 9, 10, 11, RULES_ENGINE_VERSION + 1, 999].filter((v) => v !== RULES_ENGINE_VERSION)) {
      const pinned = repinned(base, version);
      expect(replayCompatibility(pinned)).toEqual({ kind: "incompatible", version, supported: [RULES_ENGINE_VERSION] });
      for (const dev of [false, true]) expect(session(pinned, { dev }).incompatible?.compatibility.kind).toBe("incompatible");
    }
    const legacy = repinned(base, undefined);
    expect(replayCompatibility(legacy)).toEqual({ kind: "legacy" });
    expect(replayRefusal(replayCompatibility(legacy), SERVER_REPLAY_POLICY)).toMatch(/before rules-engine versioning/);
  });

  it("5. no path rewrites a stored 10 to the current version -- the held room keeps its log, its pin and its answer; a move, a new deal and a RevertTo append nothing", () => {
    const ten = repinned(standardRoom().entries, PRIOR);
    const before = JSON.stringify(ten);
    const held = session(ten);
    expect(JSON.stringify(held.entries)).toBe(before);
    expect(held.rulesEngineVersion()).toBe(10);
    const attempts = [
      submit(held, A, BUY),
      submit(held, A, SETUP(false)),
      submit(held, A, { RevertTo: { index: 0, player: A, summary: "x" } }),
    ] as Array<{ kind: string }>;
    for (const attempt of attempts) expect(attempt.kind).toBe("incompatible");
    expect(JSON.stringify(held.entries)).toBe(before);
    const hello = held.catchUp(-1) as { kind: string; pinnedRulesEngineVersion?: number | null; supportedRulesEngineVersions?: number[] };
    expect(hello.kind).toBe("incompatible");
    expect(hello.pinnedRulesEngineVersion).toBe(10);
    expect(hello.supportedRulesEngineVersions).toEqual([RULES_ENGINE_VERSION]);
    expect(JSON.stringify(ten)).toBe(before);
  });
});

/* ================================================================================================= */
/* 3. DA-F12: THE REVENUE ALL-PASS RESUMES WITH THE PRIORITY DEAL HOLDER                              */
/* ================================================================================================= */

describe("DA-F12: after the revenue all-pass, the buy-bid-turn sequence resumes with the Priority Deal holder (§1.2.3)", () => {
  it("standard game, through the room: O buys the SV, L bids, R / O / L pass -- income is paid once, and L (the holder) acts next, not R", () => {
    const room = standardRoom();
    const cashBefore = { O: 0, L: 0 };
    const O = actorOf(room.state);
    const L = leftOf(room.state, O);
    cashBefore.O = cashOf(room.state, O);
    const { R } = da12Script(room);
    const board = room.state;
    expect(board.current_round_type).toBe("WaterfallAuction");
    expect(ownerOf(board, SV_PRIVATE_ID)).toBe(O);
    // The revenue all-pass: the SV pays its owner once ($5), the streak is spent, nothing else moved.
    expect(cashOf(board, O)).toBe(cashBefore.O - 20 + 5);
    expect(board.waterfall?.consecutive_waterfall_passes).toBe(0);
    // DA-F12: the holder, on both atoms -- not the seat after the last passer (R).
    expect(auctionPriorityHolder(board)).toBe(L);
    expect(actorOf(board)).toBe(L);
    expect(seatOf(board)).toBe(L);
    expect(actorOf(board)).not.toBe(R);
    // Ingress agrees: the holder may act, the seat the old rule named may not.
    expect(turnRefusal({ state: board, waterfall: board.waterfall ?? null, actor: L, msg: BUY as never })).toBeNull();
    expect(turnRefusal({ state: board, waterfall: board.waterfall ?? null, actor: R, msg: BUY as never })).toBe("It is not your turn.");
    applied(room, L, BUY);
    expect(ownerOf(room.state, CS)).toBe(L);
    // Rebuilds agree with the live room.
    expect(stateDigest(session(room.entries).state)).toBe(stateDigest(room.state));
  });

  it("the purchase-led lap -- the corpus's shape -- is unchanged: the holder already was the seat after the last passer", () => {
    const room = standardRoom();
    const O = actorOf(room.state);
    const L = leftOf(room.state, O);
    const R = leftOf(room.state, L);
    applied(room, O, BUY);
    applied(room, L, PASS);
    applied(room, R, PASS);
    applied(room, O, PASS);
    expect(actorOf(room.state)).toBe(L);
    expect(auctionPriorityHolder(room.state)).toBe(L);
  });

  it("a bid award does not move the card: after a lone-bid award the holder is still left of the last DIRECT purchaser", () => {
    const room = standardRoom();
    const O = actorOf(room.state);
    const L = leftOf(room.state, O);
    const R = leftOf(room.state, L);
    applied(room, O, BID(CS, 45)); // O bids on the C&SL (not the lowest)
    applied(room, L, BUY); // L buys the SV at face; the cascade awards the C&SL to O at $45 -- an award, not a purchase
    expect(ownerOf(room.state, CS)).toBe(O);
    applied(room, R, BID(DH + 1, 115)); // R bids on the M&H
    applied(room, O, PASS);
    applied(room, L, PASS);
    applied(room, R, PASS);
    // The card is left of L (the SV's direct buyer), i.e. R -- not left of O (the award) and not after the last passer.
    expect(auctionPriorityHolder(room.state)).toBe(R);
    expect(actorOf(room.state)).toBe(R);
  });
});

/* ================================================================================================= */
/* 4. THE DELAYED AUCTION ON v11                                                                     */
/* ================================================================================================= */

let serial = 0;
const entry = (actor: string, msg: unknown) =>
  entriesFromExport([{ index: serial, id: `da8-e${serial}`, actor, at: (serial += 1), msg: msg as never }])[0];
const boardOf = (engine: RoomEngine): State => ({ ...engine.snapshot.state, waterfall: engine.snapshot.waterfall }) as State;
function send(engine: RoomEngine, actor: string, msg: unknown) {
  const board = boardOf(engine);
  expect([Object.keys(msg as object)[0], turnRefusal({ state: board, waterfall: board.waterfall ?? null, actor, msg: msg as never })]).toEqual([
    Object.keys(msg as object)[0],
    null,
  ]);
  engine.apply(entry(actor, msg));
}

/** A Delayed Auction dealt at the current engine, Stock Round 1 played for real (the PRR parred), then the NYC's closing
 *  turn of the Operating Round set that holds the first 3-train (rr2aF1's and DA-4's construction). `ghostThree` makes
 *  the NYC's 3-train a Carcosa gift (`ghost_trains`) instead of a Depot purchase. */
function delayedSetEnd(options: { ghostThree?: boolean } = {}): RoomEngine {
  const engine = new RoomEngine(sandboxReplayProviders(), seed() as never);
  engine.apply(entry(A, SETUP(true, RULES_ENGINE_VERSION)));
  const prr = boardOf(engine).public_companies.find((company) => company.ticker === "PRR")!;
  send(engine, A, PASS_TURN);
  send(engine, A, { BuyStock: { game_id: 0, protocol_id: prr.company_id, source: "Ipo", par_value: "100" } });
  send(engine, A, PASS_TURN);
  for (let guard = 0; boardOf(engine).macro_round_number === 1; guard += 1) {
    if (guard > 8) throw new Error("Stock Round 1 did not end");
    send(engine, seatOf(boardOf(engine)), PASS_TURN);
  }
  const real = boardOf(engine);
  const nyc = real.public_companies.find((company) => company.ticker === "NYC")!;
  const withTrains = {
    ...real,
    public_companies: real.public_companies.map((company) =>
      company.company_id === nyc.company_id
        ? {
            ...company,
            is_floated: true,
            president: C,
            par_value: "100",
            owned_trains: ["2", "3"],
            ...(options.ghostThree ? { ghost_trains: ["3"] } : {}),
            player_holdings: [{ player: C, percentage: 60 }],
            ipo_pool_percentage: 40,
            station_token_hexes: ["G19"],
          }
        : company,
    ),
  } as State;
  const orEnd = {
    ...withTrains,
    current_round_type: "OperatingRound",
    sub_round_index: operatingRoundSequenceLength(withTrains),
    active_operating_order: [nyc.company_id],
    active_corporation_index: 0,
    active_player_index: real.player_addresses.indexOf(C),
  } as State;
  return new RoomEngine(sandboxReplayProviders(), { state: orEnd, waterfall: orEnd.waterfall ?? null } as never);
}

describe("the Delayed Auction on v11: the certified semantics, carried by the bump (and by every later one)", () => {
  it("the deal: pinned to the current engine, the auction dormant and owed, the C&A's PRR share reserved, the B&O locked, no round forced", () => {
    const room = session();
    applied(room, A, SETUP(true));
    const board = room.state;
    expect(board.rules_engine_version).toBe(RULES_ENGINE_VERSION);
    expect(board.current_round_type).toBe("StockRound");
    expect(board.waterfall?.waterfall_auction_active).toBe(false);
    expect(board.private_auction_complete).toBe(false);
    expect(board.private_companies.every((row) => row.owner === null)).toBe(true);
    const prr = board.public_companies.find((company) => company.ticker === "PRR") as { reserved_certificate?: unknown };
    expect(prr.reserved_certificate).toEqual({ private_id: 5, percentage: 10 });
    // Round authority (RR2A-F1, (9)) and the auction gate (DA-F1, (1)) -- refused, nothing appended.
    const length = room.entries.length;
    for (const msg of [BEGIN_OR, BUY, PASS]) {
      expect((submit(room, seatOf(room.state), msg) as { kind: string }).kind).toBe("refused");
    }
    expect(room.entries).toHaveLength(length);
  });

  it("the trigger: the set that bought the first REAL 3-train ends in the auction, armed on the Priority Deal holder; the round escapes stay refused", () => {
    const engine = delayedSetEnd();
    const before = boardOf(engine);
    const holder = before.player_addresses[before.priority_deal_index];
    send(engine, C, PASS_TURN);
    const board = boardOf(engine);
    expect(board.rules_engine_version).toBe(RULES_ENGINE_VERSION);
    expect(board.current_round_type).toBe("WaterfallAuction");
    expect(board.waterfall?.waterfall_auction_active).toBe(true);
    expect(actorOf(board)).toBe(holder);
    for (const [msg, pattern] of [
      [BEGIN_OR, /cannot start from the private company auction/],
      [PASS_TURN, /pass with the auction's own Pass/],
    ] as const) {
      expect(turnRefusal({ state: board, waterfall: board.waterfall ?? null, actor: holder, msg: msg as never })).toMatch(pattern);
    }
  });

  it("DA-F12 at a Delayed Auction table: the revenue all-pass resumes with the holder (left of the SV's buyer)", () => {
    const engine = delayedSetEnd();
    send(engine, C, PASS_TURN);
    const O = actorOf(boardOf(engine));
    const L = leftOf(boardOf(engine), O);
    const R = leftOf(boardOf(engine), L);
    send(engine, O, BUY);
    send(engine, L, BID(DH, 75));
    send(engine, R, PASS);
    send(engine, O, PASS);
    send(engine, L, PASS);
    const board = boardOf(engine);
    expect(board.waterfall?.consecutive_waterfall_passes).toBe(0);
    expect(actorOf(board)).toBe(L);
    expect(seatOf(board)).toBe(L);
  });

  it("DA-T10 (UR x DA, the trigger): a Carcosa-gifted 3-train is not the phase, so it does not arm the delayed auction", () => {
    /* The trigger is `derivePhase(state).tier >= 3` with the auction owed (design note 905): no flag, no train count.
       UR-3's OD-UR-3 makes a synthetic train never the phase, so the ONE rules-version question DA x UR raises at the
       auction's boundary -- could a gift start it? -- is answered by the same predicate UR certifies: no. */
    const engine = delayedSetEnd({ ghostThree: true });
    expect(derivePhase(boardOf(engine))?.tier).toBe("2");
    send(engine, C, PASS_TURN);
    const board = boardOf(engine);
    expect(board.current_round_type).toBe("StockRound");
    expect(board.private_auction_complete).toBe(false);
    expect(board.waterfall?.waterfall_auction_active).toBe(false);
    // The control above (`the trigger`) is the same board with a real 3-train: it arms.
    expect(derivePhase(boardOf(delayedSetEnd()))?.tier).toBe("3");
  });

  it("no authority behind row 11 compares the pin's value, and none names the current version", () => {
    const COMPARED = /rules_engine_version\s*(?:>=|<=|>|<|[!=]==?\s*\d)/;
    for (const file of [
      "gameEngine/auctionAuthority.ts", // (1) (2) (5) (7) (10)
      "gameEngine/sandboxSession.ts", // (3) (4) (5) (6) (8) (10)
      "gameEngine/turnAuthority.ts", // ingress for all of them
      "gameEngine/roundTransitionAuthority.ts", // (9)
      "gameEngine/forcedDivestment.ts", // (7)
      "gameEngine/privateExchange.ts", // (6)
      "gameEngine/sharePurchase.ts", // (3) (6)
    ]) {
      const source = readStripped(file);
      expect([file, COMPARED.test(source)]).toEqual([file, false]);
      expect([file, /RULES_ENGINE_VERSION/.test(source)]).toEqual([file, false]);
    }
  });
});

/* ================================================================================================= */
/* 5. THE DEVELOPMENT CORPUS: UNPINNED, AND UNMOVED BY DA-F12                                        */
/* ================================================================================================= */

const FROZEN_DIR = join(__dirname, "__fixtures__", "replayGolden", "logs");
const SERVER_DIR = join(__dirname, "..", "..", "..", "server", "data");
const EXPORT_DIR = join(__dirname, "..", "..");
const jsonl = (file: string): ExportedEntry[] =>
  readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as ExportedEntry);
const exportedRows = (file: string): ExportedEntry[] => {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { actions?: ExportedEntry[]; entries?: ExportedEntry[] };
  return raw.actions ?? raw.entries ?? [];
};
function corpus(): Array<{ name: string; entries: ExportedEntry[] }> {
  const out: Array<{ name: string; entries: ExportedEntry[] }> = [];
  const listed = (dir: string, test: (f: string) => boolean) => (existsSync(dir) ? readdirSync(dir).filter(test).sort() : []);
  for (const f of listed(FROZEN_DIR, (f) => f.endsWith(".log.jsonl"))) out.push({ name: `golden/${f}`, entries: jsonl(join(FROZEN_DIR, f)) });
  for (const f of listed(SERVER_DIR, (f) => f.endsWith(".log.jsonl"))) out.push({ name: `server/${f}`, entries: jsonl(join(SERVER_DIR, f)) });
  for (const f of listed(EXPORT_DIR, (f) => /^sandbox-log-JUNO-.*\.json$/.test(f))) out.push({ name: `export/${f}`, entries: exportedRows(join(EXPORT_DIR, f)) });
  const prefix = join(__dirname, "__fixtures__", "JUNO-FCJ-prefix96.log.jsonl");
  if (existsSync(prefix)) out.push({ name: "prefix/JUNO-FCJ-96", entries: jsonl(prefix) });
  const z6c = join(__dirname, "__fixtures__z6cLog.json");
  if (existsSync(z6c)) out.push({ name: "fixture/JUNO-Z6C-494", entries: exportedRows(z6c) });
  return out;
}

describe("the canonical development corpus under v11", () => {
  const files = corpus();
  if (files.length === 0) {
    it("skipped: the development corpus is not present in this checkout", () => expect(files).toEqual([]));
    return;
  }

  it("every stored log is UNPINNED history -- none is v10, so the boundary scan has nothing to hold in it", () => {
    const scans = files.map(({ name, entries }) => scanPinnedHistory(name, entriesFromExport(entries)));
    const summary = summarizeBoundaryScan(scans);
    expect(summary.byPin).toEqual({ unpinned: files.length });
    expect(summary.scanned).toBe(0);
    expect(summary.clean).toBe(true);
  });

  it("DA-F12 moves none of it: at every revenue all-pass the holder IS the seat after the last passer", () => {
    const seen: string[] = [];
    for (const { name, entries } of files) {
      replayLog(entriesFromExport(entries), sandboxReplayProviders(), seed(), ({ entry, stateBefore }) => {
        const msg = JSON.parse(entry.payload) as Record<string, unknown>;
        const atom = stateBefore.waterfall;
        const players = stateBefore.player_addresses ?? [];
        if (!("WaterfallPass" in msg) || !atom || atom.mini_auction || stateBefore.current_round_type !== "WaterfallAuction") return;
        if (atom.privates.some((row) => row.private_id === SV_PRIVATE_ID) || atom.consecutive_waterfall_passes + 1 < players.length) return;
        const legacy = players[(players.indexOf(atom.current_turn) + 1) % players.length];
        expect([name, entry.index, auctionPriorityHolder(stateBefore)]).toEqual([name, entry.index, legacy]);
        seen.push(`${name}#${entry.index}`);
      }, DEVELOPMENT_CORPUS_POLICY);
    }
    // JUNO-G6J's one and JUNO-Z6C's two, in every copy the corpus carries (the audit's three).
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.some((at) => at.includes("G6J"))).toBe(true);
    expect(seen.some((at) => at.includes("Z6C"))).toBe(true);
  });
});

/* ================================================================================================= */
/* 6. SETTLEMENT: A SEPARATE AXIS (owner ruling, DA-8)                                               */
/* ================================================================================================= */

describe("settlement: a separate axis -- v10 certified byte-for-byte, v11 added only by its own recertification (ESCROW-3A)", () => {
  const golden = JSON.parse(
    readFileSync(join(__dirname, "__fixtures__", "settlement", "SET0A_golden_vectors_rev2.derived.json"), "utf8"),
  ) as { cases: Array<{ name: string; terminal_state_hash_v1: string; seat_mapping: string[]; vector: string[] }> };
  const syn01 = golden.cases.find((row) => row.name === "SYN-01-CLASSIC-BANKBREAK")!;
  const seatsOf = (ids: readonly string[]) => ids.map((player_id, seat_index) => ({ seat_index, player_id }));

  it("the two axes: the game plays the current engine (11 at DA-8, 12 since R12-2); settlement is certified for [10, 11, 12] -- 11 by ESCROW-3A's recertification, 12 by R12-3's, never by a bump", () => {
    expect(RULES_ENGINE_VERSION).toBeGreaterThanOrEqual(11);
    /* DA-8 left this [10]. ESCROW-3A added 11 in its own reviewed change, on its own evidence
       (`settlementV11Certification.test.ts`), and Route v12 R12-3 added 12 on its own (`settlementV12Certification.test.ts`);
       the list is still a literal that no gameplay constant moves. */
    expect(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS).toEqual([10, 11, 12]);
    expect(SET0A_CERTIFIED_RULES_ENGINE_VERSION).toBe(10);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).not.toContain(10);
    expect(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS).not.toContain(RULES_ENGINE_VERSION + 1);
  });

  it("the v11 reducer rebuilds the certified SYN-01 board byte for byte, the pin aside -- no appraisal input moved across the bump", () => {
    const { board } = syn01ClassicBankBreak();
    expect(board.rules_engine_version).toBe(RULES_ENGINE_VERSION);
    expect(terminalStateHashV1(board)).not.toBe(syn01.terminal_state_hash_v1);
    expect(terminalStateHashV1(atCertifiedSettlementPin(board))).toBe(syn01.terminal_state_hash_v1);
    expect(goldenBoards().boards["SYN-01-CLASSIC-BANKBREAK"].rules_engine_version).toBe(10);
  });

  it("a certified v10 board appraises exactly as certified, and so does the same board at 11; 9 and 13 are refused before any value is read (12 was, until R12-3)", () => {
    const certified = goldenBoards().boards["SYN-01-CLASSIC-BANKBREAK"];
    const seats = seatsOf(syn01.seat_mapping);
    expect(appraiseSeats(certified, seats).map((seat) => seat.total.toString())).toEqual(syn01.vector);
    expect(appraiseSeats({ ...certified, rules_engine_version: 11 } as State, seats).map((seat) => seat.total.toString())).toEqual(syn01.vector);
    for (const pin of [9, 13]) {
      expect(() => appraiseSeats({ ...certified, rules_engine_version: pin } as State, seats)).toThrow(
        `UNSUPPORTED_RULES_ENGINE_VERSION: rules_engine_version=${pin} (supported: 10, 11, 12)`,
      );
    }
  });

  it("the frozen payload vectors still name rules engine 10 -- nothing was regenerated", () => {
    const pins = (file: string) =>
      Array.from(readFileSync(file, "utf8").matchAll(/"rules_engine_version":\s*(\d+)/g)).map((match) => Number(match[1]));
    for (const file of [
      join(__dirname, "__fixtures__", "settlement", "settlementPayloadVectorsV1.json"),
      join(__dirname, "..", "..", "..", "contracts", "escrow", "testdata", "payload_vectors_v1.json"),
    ]) {
      if (!existsSync(file)) continue;
      const found = pins(file);
      expect(found.length).toBeGreaterThan(0);
      expect(new Set(found)).toEqual(new Set([10]));
    }
  });
});

/* ================================================================================================= */
/* 7. THE BOUNDARY SCAN (`rulesBoundaryScan.ts`, `gamesDoctor scan-v10`)                             */
/* ================================================================================================= */

describe("the v10 -> v11 boundary scan: finds each routed pattern, flags nothing else, writes nothing", () => {
  /** A live v11 log, stored as a v10 server would have stored it. */
  const asTen = (room: RoomSession) => repinned(room.entries, PRIOR);
  /** A committed entry appended by hand -- what a v10 server could have committed. */
  const withEntry = (entries: readonly ServerLogEntry[], actor: string, msg: unknown): ServerLogEntry[] => [
    ...entries,
    { index: entries.length, id: `da8-crafted-${entries.length}`, actor, payload: JSON.stringify(msg), at: 99 } as ServerLogEntry,
  ];
  const patterns = (entries: readonly ServerLogEntry[]) => scanPinnedHistory("t", entries).hits.map((hit) => [hit.pattern, hit.kind, hit.roundBefore]);

  it("a legal v10 history is clean; a v11 or unpinned log is not replayed at all", () => {
    const room = standardRoom();
    applied(room, actorOf(room.state), BUY);
    const clean = scanPinnedHistory("clean", asTen(room));
    expect([clean.scanned, clean.pin, clean.hits]).toEqual([true, 10, []]);
    expect(scanPinnedHistory("v11", room.entries).scanned).toBe(false);
    expect(scanPinnedHistory("legacy", repinned(room.entries, undefined)).pin).toBeNull();
  });

  it("A and B: a committed BeginOperatingRound and a Stock Round PassTurn inside the auction, each classified by the round before it", () => {
    const room = standardRoom();
    const actor = actorOf(room.state);
    expect(patterns(withEntry(asTen(room), actor, BEGIN_OR))).toEqual([["A", "BeginOperatingRound", "WaterfallAuction"]]);
    expect(patterns(withEntry(asTen(room), actor, PASS_TURN))).toEqual([["B", "PassTurn", "WaterfallAuction"]]);
  });

  it("C: the SV marked down to $0 and taken -- DA-F5's shape -- and nothing else in a twelve-pass lap", () => {
    const room = standardRoom();
    for (let pass = 0; pass < 12; pass += 1) applied(room, actorOf(room.state), PASS);
    expect(room.state.private_companies.find((row) => row.private_id === SV_PRIVATE_ID)?.settled_price).toBe(0);
    expect(patterns(asTen(room))).toEqual([["C", "WaterfallPass", "WaterfallAuction"]]);
  });

  it("F12: DA-F12's shape is found; the purchase-led lap is not", () => {
    const flagged = standardRoom();
    da12Script(flagged);
    const scan = scanPinnedHistory("f12", asTen(flagged));
    expect(scan.revenueAllPasses).toBe(1);
    expect(scan.hits.map((hit) => hit.pattern)).toEqual(["F12"]);
    const quiet = standardRoom();
    const O = actorOf(quiet.state);
    applied(quiet, O, BUY);
    for (let pass = 0; pass < 3; pass += 1) applied(quiet, actorOf(quiet.state), PASS);
    const control = scanPinnedHistory("control", asTen(quiet));
    expect([control.revenueAllPasses, control.hits]).toEqual([1, []]);
  });

  it("X and D: an entry the current engine refuses is X; a harmless duplicate consent answer is D (informational), not X", () => {
    const room = standardRoom();
    const actor = actorOf(room.state);
    const refused = withEntry(asTen(room), actor, { SetBoPar: { player: actor, par_value: "100" } });
    expect(patterns(refused)).toEqual([["X", "SetBoPar", "WaterfallAuction"]]);
    const duplicate = withEntry(asTen(room), actor, { AnswerPrivatePurchase: { game_id: 0, private_id: 2, accept: true } });
    expect(patterns(duplicate)).toEqual([["D", "AnswerPrivatePurchase", "WaterfallAuction"]]);
    expect(summarizeBoundaryScan([scanPinnedHistory("d", duplicate)]).clean).toBe(true);
    expect(summarizeBoundaryScan([scanPinnedHistory("x", refused)]).clean).toBe(false);
  });

  it("the scan never writes: the log it read is byte-identical afterwards, and a second scan says the same", () => {
    const room = standardRoom();
    da12Script(room);
    const stored = withEntry(asTen(room), A, BEGIN_OR);
    const before = JSON.stringify(stored);
    const first = scanPinnedHistory("t", stored);
    const second = scanPinnedHistory("t", stored);
    expect(JSON.stringify(stored)).toBe(before);
    expect(second).toEqual(first);
    expect(rulesEngineVersionOf(stored)).toBe(10);
  });
});
