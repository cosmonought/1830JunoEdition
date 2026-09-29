/** @jest-environment node */
//
// ==================================================================
//  LIVE-4 (L4-2): NO-MONEY CONTINUATION, WIRED INTO THE SESSION -- T-2 .. T-6, T-25, THE SESSION HALF OF T-24
// ==================================================================
//
// WHAT THIS FILE PROVES, against `RoomSession` itself and the pure modules it now asks (the process-level half --
// restarts over real stores, discovery, the room view, caps, "Your tables", the serving timer, the money table end to
// end -- is `server/src/rooms/live4NoMoneyContinuation.test.ts`):
//   1. THE DEALING IDENTITY. A session no pool configured stamps exactly what it stamped before LIVE-4 (the rules pin,
//      and no hosted field -- which every reader takes as protocol 1). A pool's session stamps the pool's dealing
//      identity (its current rules, its highest hosted protocol); a money deal takes its money identity's, never the
//      pool's current. A client's `hosted_protocol` never survives. The reducer reads neither field.
//   2. THE VERDICT IS ASKED AT EVERY INTERPRETATION, whatever build dealt the game or runs the session -- and a money
//      table's facts are judged on EQUAL builds too (LIVE-4 F-L4-1: #1252 reached the money check only across builds).
//      A build change alone moves no byte, no hash and no board (T-2), and refuses nothing but a stale tab (protocol 0).
//   3. T-3 .. T-6: a hosted protocol this pool does not read; absent and malformed stamps; a rules bump that keeps v11;
//      removed v11 support. Every "no" is derived: the engine never sees an entry, nothing is appended.
//   4. T-25, ADOPTED: a pinned log carrying a message kind or a rules revision this build cannot have written is
//      `newer-format` -- never replayed, never advanced past; the same bytes unpinned replay exactly as before; and the
//      closed schema that decides "unknown" has lost no kind since v11 existed.
//   5. THE SESSION HALF OF T-24: a draining pool's no-money game is served until flip + 7 days; at the deadline its next
//      submit is refused (with the clock, no rebuild) and the serving review stops serving it (one way, no rebuild);
//      money is never timed out; a terminal game is not cut short; a retired pool serves nothing; a game the primary
//      continues is released.

import { RoomSession, type ServerLogEntry, type SubmitInput } from "./roomSession";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import type { ReplayProviders } from "../gameEngine/replayLog";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { stateDigest } from "../gameEngine/stateDigest";
import { logHash } from "../gameEngine/logHash";
import { CURRENT_RULES_REVISION } from "../gameEngine/gameVariants";
import { GAMEPLAY_MESSAGE_KINDS } from "../gameEngine/messageSchema";
import {
  DEVELOPMENT_CORPUS_POLICY,
  RULES_ENGINE_VERSION,
  RULES_ENGINE_VERSION_FIELD,
  SERVER_REPLAY_POLICY,
  stampRulesEngineVersion,
  type ReplayPolicy,
} from "../gameEngine/rulesVersion";
import { FINANCIAL_PROTOCOL_VERSION, HOSTED_PROTOCOL_VERSION } from "../gameEngine/protocolVersions";
import {
  HOSTED_PROTOCOL_FIELD,
  MONEY_CONTINUATION_FORMAT,
  gameIdentityOfEntries,
  isMoneyContinuationIdentity,
  type MoneyContinuationIdentity,
} from "../gameEngine/compat/continuationIdentity";
import {
  NO_MONEY_DRAIN_MS,
  continuationVerdict,
  dealingIdentity,
  serveDecision,
  type ArtifactFormats,
  type ContinuationVerdict,
  type MoneyFacts,
  type PoolServingState,
} from "../gameEngine/compat/continuationVerdict";
import { deploymentCapability, servedDeployment, type DeploymentCapability, type DeploymentPin } from "../gameEngine/compat/deploymentCapability";
import {
  dealFormatOf,
  localContinuationVerdict,
  localGameplayCapability,
  logFormatOf,
  stampDealingIdentity,
  type SessionContinuation,
} from "../gameEngine/compat/sessionContinuation";
import { operatingBoard } from "./offerFixtures74";
import { M, P1, withState } from "./offerMatrix74Support";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const BUILD = "build-under-test";
const ALICE = "p-alice";
const BOB = "p-bob";

const seed = () => ({
  state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});

interface SessionOptions {
  build?: string;
  entries?: readonly ServerLogEntry[];
  continuation?: SessionContinuation;
  providers?: ReplayProviders;
  replayPolicy?: ReplayPolicy;
}

function session(options: SessionOptions = {}): RoomSession {
  let n = 0;
  const room = new RoomSession({
    providers: options.providers ?? sandboxReplayProviders(),
    seed: seed(),
    build: options.build ?? BUILD,
    mintId: () => `id${(n += 1)}`,
    now: () => 1_000 + n,
    ...(options.continuation !== undefined ? { continuation: options.continuation } : {}),
    ...(options.replayPolicy !== undefined ? { replayPolicy: options.replayPolicy } : {}),
  });
  if (options.entries !== undefined) room.restore(options.entries);
  return room;
}

/** The real providers, counting every entry `RoomEngine.apply` interprets (`chartInjections` is asked on each). */
function countingProviders(): { providers: ReplayProviders; count: () => number } {
  const real = sandboxReplayProviders();
  let applied = 0;
  return {
    providers: {
      ...real,
      chartInjections: (state) => {
        applied += 1;
        return real.chartInjections(state);
      },
    },
    count: () => applied,
  };
}

const deal = (over: Record<string, unknown> = {}) =>
  ({
    SetupGame: {
      players: [
        { id: ALICE, nickname: "Alice" },
        { id: BOB, nickname: "Bob" },
      ],
      variants: {},
      build: BUILD,
      ...over,
    },
  }) as never;

const BUY = { WaterfallBuyLowest: { game_id: 0 } } as never;

const submit = (room: RoomSession, over: Partial<SubmitInput> = {}) =>
  room.submit({ actor: ALICE, build: BUILD, msg: deal(), baseIndex: room.nextIndex - 1, ...over });

/** A dealt room and the first seat's opening purchase. */
function played(options: SessionOptions = {}): RoomSession {
  const room = session(options);
  expect(submit(room).kind).toBe("applied");
  expect(submit(room, { actor: room.state.player_addresses[0], msg: BUY }).kind).toBe("applied");
  return room;
}

function setupOf(entries: readonly ServerLogEntry[]): Record<string, unknown> {
  const found = entries.find((entry) => "SetupGame" in (JSON.parse(entry.payload) as object));
  if (found === undefined) throw new Error("no deal in the log");
  return (JSON.parse(found.payload) as { SetupGame: Record<string, unknown> }).SetupGame;
}

/** A copy of a log with its deal rewritten -- what a store written by another pool (or damaged) looks like. */
function rewriteDeal(entries: readonly ServerLogEntry[], change: (setup: Record<string, unknown>) => void): ServerLogEntry[] {
  return entries.map((entry) => {
    const parsed = JSON.parse(entry.payload) as { SetupGame?: Record<string, unknown> };
    if (parsed.SetupGame === undefined) return { ...entry };
    const setup = { ...parsed.SetupGame };
    change(setup);
    return { ...entry, payload: JSON.stringify({ SetupGame: setup }) };
  });
}

/** `entries` plus one entry of `msg`, as a store would hold it. */
const appended = (entries: readonly ServerLogEntry[], msg: unknown, id = "appended"): ServerLogEntry[] => [
  ...entries.map((entry) => ({ ...entry })),
  { index: entries.length, id, actor: ALICE, payload: JSON.stringify(msg), at: 9_999 },
];

const frameWhy = (frame: unknown): string | undefined => (frame as { why?: string }).why;

/* ---- capabilities and a pool's hook ----------------------------------------------------------------------- */

/** This code's gameplay capability, with some fields replaced (a hypothetical release). */
const capabilityOf = (over: Partial<DeploymentCapability>): DeploymentCapability => deploymentCapability({ ...localGameplayCapability(), ...over });

/** A v12 release that still carries v11 (certified dual support) and reads hosted protocols 1 and 2. */
const DUAL = capabilityOf({ rules: { current: 12, supported: [11, 12], certified: [] }, hosted_protocols: [1, 2] });
/** A v12 release that dropped v11. */
const TWELVE_ONLY = capabilityOf({ rules: { current: 12, supported: [12], certified: [] }, hosted_protocols: [1, 2] });
/** This build's rules, reading hosted protocols 1 and 2. */
const HOSTED_TWO = capabilityOf({ hosted_protocols: [1, 2] });

/** Escrow 2.0.0 (canonical context §D.3) and a pin on it. */
const CODE_A = "5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8";
const PIN: DeploymentPin = {
  backend: "juno-cosmwasm",
  codec: "18JUNO/v1",
  chain_id: "uni-7",
  network_class: "testnet",
  contract_address: "juno14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9skjuwg8",
  code_checksum: CODE_A,
  denom: "ujunox",
};
const money = (rules: { current: number; supported: number[] }, hosted: number[]): DeploymentCapability =>
  capabilityOf({
    rules: { ...rules, certified: [11] },
    hosted_protocols: hosted,
    financial_protocols: [FINANCIAL_PROTOCOL_VERSION],
    settlement_codecs: ["18JUNO/v1"],
    escrow_abi_checksums: [CODE_A],
    escrow_deployments: [servedDeployment(PIN)],
  });
/** The money identity every money table of this build freezes at creation. */
const MCI: MoneyContinuationIdentity = {
  format: MONEY_CONTINUATION_FORMAT,
  rules_engine_version: RULES_ENGINE_VERSION,
  hosted_protocol: HOSTED_PROTOCOL_VERSION,
  financial_protocol: FINANCIAL_PROTOCOL_VERSION,
  settlement_codec: "18JUNO/v1",
};

const PRIMARY: PoolServingState = { role: "primary", flipped_at: null };

interface PoolHookOptions {
  capability?: DeploymentCapability;
  money?: MoneyFacts;
  pool?: () => PoolServingState;
  now?: () => number;
  primaryVerdict?: ContinuationVerdict | null;
  legacyLogs?: ReplayPolicy["legacyLogs"];
}

/** A pool's answers for one game, built from the pure model exactly as `server/src/continuationWiring.ts` builds them
 *  -- with every question counted, so a test can say when the session asked. */
function poolHook(options: PoolHookOptions = {}): SessionContinuation & { readonly calls: { verdict: number; dealing: number; serving: number }; readonly logs: string[] } {
  const capability = deploymentCapability(options.capability ?? localGameplayCapability());
  const facts = options.money ?? null;
  const calls = { verdict: 0, dealing: 0, serving: 0 };
  const logs: string[] = [];
  return {
    calls,
    logs,
    verdict(identity, log) {
      calls.verdict += 1;
      logs.push(log);
      const formats: ArtifactFormats = facts === null ? { record: "current", log } : { record: "current", log, fin: "current" };
      return continuationVerdict({ formats, identity, money: facts }, capability, undefined, { legacyLogs: options.legacyLogs ?? "refuse" });
    },
    dealing() {
      calls.dealing += 1;
      if (facts === null) return { ok: true, identity: dealingIdentity(capability, null) };
      if (facts.kind === "record" && isMoneyContinuationIdentity(facts.mci)) return { ok: true, identity: dealingIdentity(capability, facts.mci) };
      return { ok: false, reason: "This table's escrow identity could not be read on this server, so the game was not dealt. Nothing changed." };
    },
    serving({ verdict, ended }) {
      calls.serving += 1;
      const pool = options.pool?.() ?? PRIMARY;
      return serveDecision(
        { verdict, money: facts !== null, terminal: ended, money_closed: false, primary_verdict: pool.role === "primary" ? null : (options.primaryVerdict ?? null) },
        pool,
        (options.now ?? (() => Date.now()))(),
      );
    },
  };
}

/* ================================================================================================= */
/* 1. THE DEALING IDENTITY                                                                            */
/* ================================================================================================= */

describe("the deal is stamped with its dealing identity, by the server, never by a client (§3)", () => {
  it("a session no pool configured stamps exactly what it stamped before LIVE-4: the rules pin and no hosted field, read as protocol 1", () => {
    const room = session();
    expect(submit(room, { msg: deal({ [HOSTED_PROTOCOL_FIELD]: 7 }) }).kind).toBe("applied");
    const setup = setupOf(room.entries);
    expect(setup[RULES_ENGINE_VERSION_FIELD]).toBe(RULES_ENGINE_VERSION);
    expect(Object.prototype.hasOwnProperty.call(setup, HOSTED_PROTOCOL_FIELD)).toBe(false); // a client's claim never survives
    expect(gameIdentityOfEntries(room.entries)).toEqual({ kind: "dealt", gci: expect.objectContaining({ rules_engine_version: RULES_ENGINE_VERSION, hosted_protocol: 1 }) });
    /* The stamp with no dealing identity IS #1520's, byte for byte (so every certification and golden game dealt by a
       session with no pool is unchanged). */
    const plain = { SetupGame: { players: [{ id: ALICE }], variants: {}, build: BUILD } };
    expect(JSON.stringify(stampDealingIdentity(plain, undefined))).toBe(JSON.stringify(stampRulesEngineVersion(plain)));
  });

  it("a pool's session stamps the pool's dealing identity -- its current rules and highest hosted protocol -- over any client claim; the board does not read it", () => {
    const here = session({ continuation: poolHook() });
    expect(submit(here, { msg: deal({ [RULES_ENGINE_VERSION_FIELD]: 999, [HOSTED_PROTOCOL_FIELD]: 9 }) }).kind).toBe("applied");
    expect([setupOf(here.entries)[RULES_ENGINE_VERSION_FIELD], setupOf(here.entries)[HOSTED_PROTOCOL_FIELD]]).toEqual([RULES_ENGINE_VERSION, HOSTED_PROTOCOL_VERSION]);
    /* T-5 (no money): a v12 release that keeps v11 deals NEW games as {12, 2}. */
    const dual = session({ continuation: poolHook({ capability: DUAL }) });
    expect(submit(dual).kind).toBe("applied");
    expect([setupOf(dual.entries)[RULES_ENGINE_VERSION_FIELD], setupOf(dual.entries)[HOSTED_PROTOCOL_FIELD]]).toEqual([12, 2]);
    /* The hosted field moves no board: the same deal with and without it deals the same state. */
    const without = session();
    expect(submit(without).kind).toBe("applied");
    expect(stateDigest(here.state)).toBe(stateDigest(without.state));
  });

  it("T-5 (money): a money deal is stamped with its MONEY identity's rules and hosted protocol, never the pool's current -- and is then continued, not held identity-conflict", () => {
    const pool = money({ current: 12, supported: [11, 12] }, [1, 2]);
    const facts: MoneyFacts = { kind: "record", mci: MCI, deployment: PIN };
    const room = session({ continuation: poolHook({ capability: pool, money: facts }) });
    expect(submit(room).kind).toBe("applied");
    expect([setupOf(room.entries)[RULES_ENGINE_VERSION_FIELD], setupOf(room.entries)[HOSTED_PROTOCOL_FIELD]]).toEqual([MCI.rules_engine_version, MCI.hosted_protocol]);
    expect(submit(room, { actor: room.state.player_addresses[0], msg: BUY }).kind).toBe("applied");
    /* A restart asks the full verdict again: the deal agrees with its money identity. */
    const restarted = session({ entries: room.entries, continuation: poolHook({ capability: pool, money: facts }) });
    expect(restarted.incompatible).toBeNull();
    expect(restarted.continuationVerdict).toEqual({ kind: "continues" });
    /* The counterfactual the stamp prevents: the pool's own new-deal identity {12, 2} against the money identity. */
    const stampedByPool = continuationVerdict(
      { formats: { record: "current", log: "current", fin: "current" }, identity: { kind: "dealt", gci: dealingIdentity(pool, null) }, money: facts },
      pool,
    );
    expect(stampedByPool).toMatchObject({ kind: "conflict", why: "identity-conflict" });
  });

  it("a pool that may not deal the table refuses the deal: nothing is appended, and the refusal says so", () => {
    const refusing: SessionContinuation = { ...poolHook(), dealing: () => ({ ok: false, reason: "not this table" }) };
    const room = session({ continuation: refusing });
    const answer = submit(room);
    expect([answer.kind, (answer as { reason?: string }).reason]).toEqual(["refused", "not this table"]);
    expect(room.entries).toHaveLength(0);
  });
});

/* ================================================================================================= */
/* 2. THE VERDICT IS ASKED UNCONDITIONALLY                                                            */
/* ================================================================================================= */

describe("the verdict is asked at every interpretation, on every build (§5, F-L4-1)", () => {
  it("construction, a restore, a rollback, a discard and a live revert each ask the pool -- whether or not the dealing build is this one", () => {
    const dealtHere = played();
    const dealtElsewhere = rewriteDeal(dealtHere.entries, (setup) => (setup.build = "an-older-build"));
    for (const [runningBuild, log] of [
      [BUILD, dealtHere.entries],
      [BUILD, dealtElsewhere],
      ["build-two", dealtHere.entries],
      ["build-two", dealtElsewhere],
    ] as const) {
      const hook = poolHook();
      const room = session({ build: runningBuild, continuation: hook });
      expect(hook.calls.verdict).toBe(1); // the empty log is asked too
      room.restore(log);
      expect(hook.calls.verdict).toBe(2);
      expect(room.incompatible).toBeNull();
      room.rollbackTo(log.length);
      expect(hook.calls.verdict).toBe(3);
      const second = room.state.player_addresses[1];
      expect(room.submit({ actor: second, build: runningBuild, msg: BUY, baseIndex: room.nextIndex - 1 }).kind).toBe("applied");
      room.discardAfter(log.length);
      expect(hook.calls.verdict).toBe(4);
      const revert = room.submit({ actor: ALICE, build: runningBuild, msg: { RevertTo: { index: 1, player: ALICE, summary: "undo" } } as never, baseIndex: room.nextIndex - 1 });
      expect(revert.kind).toBe("applied");
      expect(hook.calls.verdict).toBe(5);
    }
  });

  it("a money table's facts are judged on EQUAL builds (the case #1252 skipped): another financial protocol is not continued, nothing appended", () => {
    const dealt = played();
    const facts: MoneyFacts = { kind: "record", mci: { ...MCI, financial_protocol: FINANCIAL_PROTOCOL_VERSION + 4 }, deployment: PIN };
    const room = session({ build: BUILD, entries: dealt.entries, continuation: poolHook({ capability: money({ current: 11, supported: [11] }, [1]), money: facts }) });
    expect(room.incompatible?.why).toBe("financial-protocol");
    const answer = submit(room, { actor: dealt.state.player_addresses[1], msg: BUY });
    expect([answer.kind, frameWhy(answer)]).toEqual(["incompatible", "financial-protocol"]);
    expect(room.entries).toHaveLength(dealt.entries.length);
    /* And a money table the index knows nothing about is never judged as a no-money one: a conflict, not a game. */
    const missing = session({ entries: dealt.entries, continuation: poolHook({ capability: money({ current: 11, supported: [11] }, [1]), money: { kind: "missing" } }) });
    expect(missing.incompatible?.why).toBe("conflict/financial-record-missing");
  });

  it("T-2: a compatible build change moves no byte -- the restored log, its hash and its board are identical, and the next move appends", () => {
    const dealt = played();
    const bytes = JSON.stringify(dealt.entries);
    const counting = countingProviders();
    const upgraded = session({ build: "build-two", entries: dealt.entries, providers: counting.providers });
    expect(counting.count()).toBe(dealt.entries.length);
    expect(JSON.stringify(upgraded.entries)).toBe(bytes);
    expect(logHash(upgraded.entries)).toBe(logHash(dealt.entries));
    expect(stateDigest(upgraded.state)).toBe(stateDigest(dealt.state));
    const next = upgraded.submit({ actor: dealt.state.player_addresses[1], build: "build-two", msg: BUY, baseIndex: upgraded.nextIndex - 1 });
    expect(next.kind).toBe("applied");
    expect(upgraded.entries[dealt.entries.length].index).toBe(dealt.entries.length);
    expect(JSON.stringify(upgraded.entries.slice(0, dealt.entries.length))).toBe(bytes);
  });

  it("BUILD_ID regression: the only build check left is the legacy wire's stale-tab answer (protocol 0, until L4-3) -- the game itself is never refused on a build", () => {
    const dealt = played();
    const upgraded = session({ build: "build-two", entries: dealt.entries, continuation: poolHook() });
    const second = dealt.state.player_addresses[1];
    expect(upgraded.submit({ actor: second, build: BUILD, msg: BUY, baseIndex: upgraded.nextIndex - 1 }).kind).toBe("build-skew");
    expect(upgraded.submit({ actor: second, build: "build-two", msg: BUY, baseIndex: upgraded.nextIndex - 1 }).kind).toBe("applied");
    expect(upgraded.dealtBuild()).toBe(BUILD); // the dealing build: history, never a veto
  });
});

/* ================================================================================================= */
/* 3. T-3 .. T-6                                                                                      */
/* ================================================================================================= */

describe("T-3 .. T-6: what a pool continues is its rules and hosted protocol, and every 'no' is derived", () => {
  const heldBeforeReplay = (log: readonly ServerLogEntry[], options: SessionOptions, why: string) => {
    const counting = countingProviders();
    const room = session({ ...options, entries: log, providers: counting.providers });
    expect(room.incompatible?.why).toBe(why);
    expect(counting.count()).toBe(0); // the engine never saw an entry
    const hello = room.catchUp(-1);
    expect([hello.kind, frameWhy(hello)]).toEqual(["incompatible", why]);
    const answer = submit(room, { actor: ALICE, msg: BUY });
    expect([answer.kind, frameWhy(answer)]).toEqual(["incompatible", why]);
    expect(JSON.stringify(room.entries)).toBe(JSON.stringify(log)); // nothing appended, nothing rewritten
    expect(stateDigest(room.state)).toBe(stateDigest(session().state)); // at its seed
    return room;
  };

  it("T-3: a deal stamped hosted protocol 2 is not continued where only 1 is read -- and is continued where 2 is", () => {
    const log = rewriteDeal(played().entries, (setup) => (setup[HOSTED_PROTOCOL_FIELD] = 2));
    heldBeforeReplay(log, {}, "hosted-protocol");
    heldBeforeReplay(log, { continuation: poolHook() }, "hosted-protocol");
    const wider = session({ entries: log, continuation: poolHook({ capability: HOSTED_TWO }) });
    expect(wider.incompatible).toBeNull();
    expect(submit(wider, { actor: wider.state.player_addresses[1], msg: BUY }).kind).toBe("applied");
  });

  it("T-4: an absent hosted protocol is 1; a present one that is not a version is malformed; a non-integer rules pin stays legacy; an impossible integer pin is malformed", () => {
    const dealt = played();
    expect(Object.prototype.hasOwnProperty.call(setupOf(dealt.entries), HOSTED_PROTOCOL_FIELD)).toBe(false);
    expect(session({ entries: dealt.entries, continuation: poolHook() }).incompatible).toBeNull();
    for (const bad of [0, -1, 1.5, "2", null, true, {}]) {
      heldBeforeReplay(
        rewriteDeal(dealt.entries, (setup) => (setup[HOSTED_PROTOCOL_FIELD] = bad)),
        { continuation: poolHook() },
        "malformed",
      );
    }
    /* A non-integer rules pin with no hosted field is today's `legacy` (refused by a server, admitted by the corpus). */
    const fractional = rewriteDeal(dealt.entries, (setup) => (setup[RULES_ENGINE_VERSION_FIELD] = 11.5));
    heldBeforeReplay(fractional, {}, "legacy-unpinned");
    expect(session({ entries: fractional, replayPolicy: DEVELOPMENT_CORPUS_POLICY }).incompatible).toBeNull();
    /* An integer no server could have stamped is malformed -- the same answer discovery gives (derived). */
    for (const pin of [0, -3]) {
      const room = heldBeforeReplay(rewriteDeal(dealt.entries, (setup) => (setup[RULES_ENGINE_VERSION_FIELD] = pin)), {}, "malformed");
      expect((room.catchUp(-1) as { pinnedRulesEngineVersion?: number | null }).pinnedRulesEngineVersion).toBe(pin);
    }
  });

  it("T-5: a v11 game on a release that keeps v11 continues, and its moves apply", () => {
    const dealt = played();
    const room = session({ build: "build-twelve", entries: dealt.entries, continuation: poolHook({ capability: DUAL }) });
    expect(room.incompatible).toBeNull();
    expect(room.submit({ actor: dealt.state.player_addresses[1], build: "build-twelve", msg: BUY, baseIndex: room.nextIndex - 1 }).kind).toBe("applied");
  });

  it("T-6: a v11 game on a release that dropped v11 is rules-not-supported -- its reducer never sees a v11 entry", () => {
    heldBeforeReplay(played().entries, { continuation: poolHook({ capability: TWELVE_ONLY }) }, "rules-not-supported");
  });
});

/* ================================================================================================= */
/* 4. T-25: THE FORWARD DIRECTION                                                                     */
/* ================================================================================================= */

describe("T-25 (adopted): a pinned log this build cannot have written is newer-format, never misread", () => {
  /** Every gameplay kind the closed schema declared when rules engine v11 was introduced (DA-8, `81fd037`), unchanged
   *  through L4-1. A kind REMOVED from the schema would make a stored v11 log that uses it read as a newer build's --
   *  so the table may only grow. */
  const V11_KINDS = [
    "AcceptTrainOffer", "AdvanceOperatingSubPhase", "AnswerFundingPrivateOffer", "AnswerPrivatePurchase", "AnswerPrivateTrade",
    "AnswerTrainPurchase", "BeginOperatingRound", "BidOnPrivate", "BuyHardwareFromPool", "BuyKanawhaLicense", "BuyPrivateCompany",
    "BuyStock", "BuyTrainFromCorporation", "CloseRoom", "DeclareBankruptcy", "DeclareDividends", "DiscardTrain",
    "EmergencyBuyHardware", "ExchangePrivate", "ExchangeTrainForDiesel", "ExecuteOperatingRound", "LayTile",
    "OfferPrivateForFunding", "OpenStockRound", "PassTurn", "PlaceHomeStation", "PlaceStationToken", "ProposePrivatePurchase",
    "ProposePrivateTrade", "ProposeTrainPurchase", "RejectTrainOffer", "RescindFundingPrivateOffer", "RescindPrivatePurchase",
    "RescindPrivateTrade", "RescindTrainOffer", "RescindTrainPurchase", "RevertTo", "RunManualRoute", "RunMultipleRoutes",
    "SellStock", "SetBoPar", "SetupGame", "UndoLastAction", "WaterfallBidHigher", "WaterfallBuyLowest",
    "WaterfallMiniAuctionPass", "WaterfallMiniAuctionRaise", "WaterfallPass", "YellowSignEvent",
  ];
  const FUTURE = { FutureMove: { game_id: 0 } };

  it("the closed schema still declares every kind v11 ever accepted (so no stored v11 log can read as newer)", () => {
    expect(V11_KINDS).toHaveLength(49);
    for (const kind of V11_KINDS) expect(GAMEPLAY_MESSAGE_KINDS).toContain(kind);
  });

  it("an entry of a kind this build does not know: not replayed, not advanced past, not appended to -- `newer-format`, derived", () => {
    const dealt = played();
    const log = appended(dealt.entries, FUTURE);
    expect(logFormatOf(log, gameIdentityOfEntries(log))).toBe("newer");
    const counting = countingProviders();
    const room = session({ entries: log, providers: counting.providers });
    expect(room.incompatible?.why).toBe("newer-format");
    expect(counting.count()).toBe(0);
    expect(frameWhy(room.catchUp(-1))).toBe("newer-format");
    expect(frameWhy(submit(room, { actor: dealt.state.player_addresses[1], msg: BUY }))).toBe("newer-format");
    expect(JSON.stringify(room.entries)).toBe(JSON.stringify(log));
    /* A pool's hook is told the log's class, and answers the same. */
    const hook = poolHook();
    expect(session({ entries: log, continuation: hook }).incompatible?.why).toBe("newer-format");
    expect(hook.logs).toContain("newer");
  });

  it("the same bytes UNPINNED replay exactly as before (the development corpus's default arm is its recorded game)", () => {
    const unpinned = rewriteDeal(played().entries, (setup) => delete setup[RULES_ENGINE_VERSION_FIELD]);
    const withFuture = appended(unpinned, FUTURE);
    expect(logFormatOf(withFuture, gameIdentityOfEntries(withFuture))).toBe("current");
    const before = session({ entries: unpinned, replayPolicy: DEVELOPMENT_CORPUS_POLICY });
    const after = session({ entries: withFuture, replayPolicy: DEVELOPMENT_CORPUS_POLICY });
    expect(after.incompatible).toBeNull();
    /* The default arm ran: the unknown entry advanced the seat, as it always has on an unpinned board. */
    expect(stateDigest(after.state)).not.toBe(stateDigest(before.state));
  });

  it("a deal naming a rules revision above this build's is newer-format; at or below it, or absent, the game continues", () => {
    const dealt = played();
    const withRevision = (rules: unknown) => rewriteDeal(dealt.entries, (setup) => (setup.variants = { ...(setup.variants as object), rules }));
    const above = withRevision(CURRENT_RULES_REVISION + 1);
    expect(dealFormatOf(setupOf(above))).toBe("newer");
    expect(session({ entries: above }).incompatible?.why).toBe("newer-format");
    for (const fine of [CURRENT_RULES_REVISION, 0, "9", Number.NaN]) {
      expect(session({ entries: withRevision(fine) }).incompatible).toBeNull();
    }
    expect(session({ entries: dealt.entries }).incompatible).toBeNull(); // absent (`variants: {}`)
  });

  it("an unknown entry a revert struck out is never interpreted, so it does not stop the game; an unreadable payload is left to the replay", () => {
    const dealt = played();
    const struck = appended(appended(dealt.entries, FUTURE, "future"), { RevertTo: { index: dealt.entries.length, player: ALICE, summary: "x" } }, "undo");
    expect(logFormatOf(struck, gameIdentityOfEntries(struck))).toBe("current");
    expect(session({ entries: struck }).incompatible).toBeNull();
    const identity = gameIdentityOfEntries(dealt.entries);
    expect(logFormatOf([...dealt.entries, { index: 99, id: "x", actor: ALICE, payload: "{not json" }], identity)).toBe("current");
    expect(logFormatOf([...dealt.entries, { index: 99, id: "y", actor: ALICE, payload: "[1,2]" }], identity)).toBe("current");
    expect(logFormatOf(appended(dealt.entries, FUTURE), { kind: "legacy" })).toBe("current");
    expect(logFormatOf(appended(dealt.entries, FUTURE), { kind: "undealt" })).toBe("current");
  });

  it("every v11 log this build can deal passes: a played room reads `current`, and the local verdict is today's", () => {
    const dealt = played();
    const identity = gameIdentityOfEntries(dealt.entries);
    expect(logFormatOf(dealt.entries, identity)).toBe("current");
    expect(localContinuationVerdict(identity, SERVER_REPLAY_POLICY)).toEqual({ kind: "continues" });
    expect(localContinuationVerdict(identity, SERVER_REPLAY_POLICY, "newer")).toMatchObject({ kind: "not-continued", why: "newer-format" });
  });
});

/* ================================================================================================= */
/* 5. THE SESSION HALF OF T-24                                                                        */
/* ================================================================================================= */

describe("T-24 (the session half): a draining pool's no-money game stops being served at flip + 7 days -- at the next submit and on review, without a rebuild", () => {
  const FLIP = 1_800_000_000_000;
  const DEADLINE = FLIP + NO_MONEY_DRAIN_MS;
  const DRAINING = (): PoolServingState => ({ role: "draining", flipped_at: FLIP });

  it("served before the deadline; refused at the deadline by its next submit; stopped by the review; never served again without a rebuild", () => {
    let clock = DEADLINE - 60_000;
    const hook = poolHook({ pool: DRAINING, now: () => clock });
    const counting = countingProviders();
    const room = session({ continuation: hook, providers: counting.providers });
    expect(submit(room).kind).toBe("applied");
    expect(submit(room, { actor: room.state.player_addresses[0], msg: BUY }).kind).toBe("applied");
    const second = room.state.player_addresses[1];
    const length = room.entries.length;
    const board = stateDigest(room.state);
    const asked = hook.calls.verdict;
    const applied = counting.count();

    clock = DEADLINE; // exactly the deadline: expired
    const refused = submit(room, { actor: second, msg: BUY });
    expect([refused.kind, frameWhy(refused)]).toEqual(["incompatible", "drain-expired"]);
    expect((refused as { reason: string }).reason).toMatch(/seven days/);
    expect(room.entries).toHaveLength(length);
    expect(stateDigest(room.state)).toBe(board); // the refusal changed nothing; the review is what stops serving
    expect(room.incompatible).toBeNull();

    expect(room.reviewServing()).toBe(true);
    expect(room.incompatible?.why).toBe("drain-expired");
    expect(room.incompatible?.decision).toMatchObject({ kind: "decline", why: "drain-expired" });
    expect(frameWhy(room.catchUp(-1))).toBe("drain-expired");
    expect(frameWhy(room.heldAnswer())).toBe("drain-expired");
    expect(stateDigest(room.state)).toBe(stateDigest(session().state)); // nothing is served from what was replayed
    expect(room.reviewServing()).toBe(false); // one way

    clock = FLIP; // even a clock that goes back does not revive it: only a rebuild concludes afresh
    expect(frameWhy(submit(room, { actor: second, msg: BUY }))).toBe("drain-expired");
    /* None of it rebuilt anything: the verdict was not asked again and the engine interpreted nothing more. */
    expect(hook.calls.verdict).toBe(asked);
    expect(counting.count()).toBe(applied);
    expect(room.entries).toHaveLength(length);

    /* A rebuild after the deadline concludes the same, from the pool: served nothing, derived. */
    clock = DEADLINE + 1;
    expect(session({ entries: room.entries, continuation: poolHook({ pool: DRAINING, now: () => clock }) }).incompatible?.why).toBe("drain-expired");
  });

  it("money is never timed out: a draining pool keeps serving a money game long after the no-money deadline", () => {
    const clock = DEADLINE + 30 * NO_MONEY_DRAIN_MS;
    const hook = poolHook({ capability: money({ current: 11, supported: [11] }, [1]), money: { kind: "record", mci: MCI, deployment: PIN }, pool: DRAINING, now: () => clock });
    const room = session({ continuation: hook });
    expect(submit(room).kind).toBe("applied");
    expect(submit(room, { actor: room.state.player_addresses[0], msg: BUY }).kind).toBe("applied");
    expect(room.reviewServing()).toBe(false);
    expect(room.incompatible).toBeNull();
  });

  it("a terminal game is not cut short by the drain: it is still shown, and its last messages still land", () => {
    const hook = poolHook({ pool: DRAINING, now: () => DEADLINE + 1 });
    let n = 0;
    const ended = new RoomSession({
      providers: sandboxReplayProviders(),
      seed: { state: withState(operatingBoard(), { current_round_type: "GameEnd" }), waterfall: null },
      build: BUILD,
      mintId: () => `end${(n += 1)}`,
      continuation: hook,
    });
    expect(ended.incompatible).toBeNull();
    expect(ended.reviewServing()).toBe(false);
    expect(ended.submit({ actor: P1, build: BUILD, host: P1, msg: M.closeRoom as never, baseIndex: -1 }).kind).toBe("applied");
  });

  it("a primary serves every game it continues; a retired pool serves nothing; a draining pool releases a game the primary continues", () => {
    const dealt = played();
    const primary = session({ entries: dealt.entries, continuation: poolHook({ pool: () => PRIMARY, now: () => DEADLINE * 2 }) });
    expect(primary.incompatible).toBeNull();
    expect(primary.reviewServing()).toBe(false);
    const retired = session({ entries: dealt.entries, continuation: poolHook({ pool: () => ({ role: "retired", flipped_at: FLIP }), now: () => FLIP }) });
    expect([retired.incompatible?.why, retired.incompatible?.reason]).toEqual(["pool-retired", "This game server has been retired. The game is kept exactly as it was."]);
    const released = session({ entries: dealt.entries, continuation: poolHook({ pool: DRAINING, now: () => FLIP, primaryVerdict: { kind: "continues" } }) });
    expect(released.incompatible?.why).toBe("release");
    expect(released.incompatible?.reason).toMatch(/continues on the newer game server/);
  });
});

/* ================================================================================================= */
/* 6. THE INDEPENDENT REVIEW'S CASES                                                                  */
/* ================================================================================================= */

describe("the review's cases: a revert whose rebuild is refused, a release, a deal no server wrote, a pool that cannot answer", () => {
  const FLIP = 1_800_000_000_000;
  const DEADLINE = FLIP + NO_MONEY_DRAIN_MS;

  it("a live revert whose own rebuild is no longer served takes back everything it appended and answers held -- nothing is written", () => {
    let clock = DEADLINE - 60_000;
    let expireOnNextAsk = false;
    const inner = poolHook({ pool: () => ({ role: "draining", flipped_at: FLIP }), now: () => clock });
    /* The clock crosses the deadline between the submit's own serving check and the revert's rebuild. */
    const hook: SessionContinuation = {
      ...inner,
      verdict: (identity, log) => {
        if (expireOnNextAsk) clock = DEADLINE;
        return inner.verdict(identity, log);
      },
    };
    const room = played({ continuation: hook });
    const before = JSON.stringify(room.entries);
    expireOnNextAsk = true;
    const answer = room.submit({ actor: ALICE, build: BUILD, msg: { RevertTo: { index: 1, player: ALICE, summary: "undo" } } as never, baseIndex: room.nextIndex - 1, submissionId: "late-undo" });
    expect([answer.kind, frameWhy(answer)]).toEqual(["incompatible", "drain-expired"]);
    expect(JSON.stringify(room.entries)).toBe(before);
    expect(room.incompatible?.why).toBe("drain-expired");
    /* Its nonce went with it: once a rebuild serves the game again, the same submission is judged afresh -- applied,
       never answered as a move already made. */
    expireOnNextAsk = false;
    clock = DEADLINE - 60_000;
    room.rollbackTo(room.entries.length);
    expect(room.incompatible).toBeNull();
    const retried = room.submit({ actor: ALICE, build: BUILD, msg: { RevertTo: { index: 1, player: ALICE, summary: "undo" } } as never, baseIndex: room.nextIndex - 1, submissionId: "late-undo" });
    expect(retried.kind).toBe("applied");
    expect(room.entries).toHaveLength(JSON.parse(before).length + 1);
  });

  it("a draining pool releases a game the primary continues even when it cannot read it itself; a primary names its own reason", () => {
    const log = rewriteDeal(played().entries, (setup) => (setup[HOSTED_PROTOCOL_FIELD] = 2));
    const draining = session({ entries: log, continuation: poolHook({ pool: () => ({ role: "draining", flipped_at: FLIP }), now: () => FLIP, primaryVerdict: { kind: "continues" } }) });
    expect(draining.incompatible?.why).toBe("release");
    const primary = session({ entries: log, continuation: poolHook() });
    expect(primary.incompatible?.why).toBe("hosted-protocol");
  });

  it("a deal whose body is not an object is malformed -- derived, never a throw (so never a replay failure)", () => {
    const log: ServerLogEntry[] = [{ index: 0, id: "null-deal", actor: ALICE, payload: JSON.stringify({ SetupGame: null }), at: 1 }];
    const room = session({ entries: log });
    expect(room.incompatible?.why).toBe("malformed");
    expect(room.dealtBuild()).toBeNull();
    expect(frameWhy(room.catchUp(-1))).toBe("malformed");
  });

  it("a pool that cannot answer does not continue or serve the game -- derived, and nothing is served", () => {
    const dealt = played();
    const throwing: SessionContinuation = { ...poolHook(), verdict: () => { throw new Error("index unavailable"); } };
    const unasked = session({ entries: dealt.entries, continuation: throwing });
    expect(unasked.incompatible?.why).toBe("malformed");
    expect(unasked.incompatible?.verdict).toMatchObject({ kind: "not-continued", detail: expect.stringMatching(/index unavailable/) });
    const unserving: SessionContinuation = { ...poolHook(), serving: () => { throw new Error("pool state unreadable"); } };
    const unserved = session({ entries: dealt.entries, continuation: unserving });
    expect(unserved.incompatible?.decision).toMatchObject({ kind: "decline", detail: expect.stringMatching(/pool state unreadable/) });
    expect(unserved.incompatible?.reason).toBe("This game cannot be continued on this server. It is left untouched.");
    expect(stateDigest(unserved.state)).toBe(stateDigest(session().state)); // nothing served from what was replayed
    const undealtByThrow = session({ continuation: { ...poolHook(), dealing: () => { throw new Error("no identity"); } } });
    const refused = submit(undealtByThrow);
    expect([refused.kind, (refused as { reason?: string }).reason]).toEqual(["refused", "This table could not be dealt on this server right now. Nothing changed."]);
    expect(undealtByThrow.entries).toHaveLength(0);
  });
});

