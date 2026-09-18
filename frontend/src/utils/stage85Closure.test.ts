/** @jest-environment node */
//
// ==================================================================
//  STAGE 8.5: VERSION 6, AND THE CLOSURE CHECKS THE BUMP OWES
// ==================================================================
//
// Stage 8 (8.1-8.4) changed what stored logs replay to and deferred the one bump to here. This file pins the
// bump the way every earlier bump pinned its own (Batch 4.6's trainDiscard 14, Batch 5's emergencyFunding 22,
// Batch 6's routeAuthority 23, Batch 7.5's `batch75Closure`), adds the S8-8 residual's closure, and measures
// the Stage-8 corpus reconciliation from HEAD rather than trusting the design pass's prospective tables.
//
// WHAT COUNTS AS A MEASURED BASELINE HERE, said plainly because the two halves are not the same evidence:
//
//   THE GOLDEN MASTERS ARE THE BATCH-7 BOARDS. `__fixtures__/replayGolden/*.json` were last written at
//   47d1b7a (Batch 7.5); the only commit between that and Stage 8's baseline 7c5f29c is a test-support
//   change. `replayGolden.test.ts` compares HEAD's replay of each frozen log against them byte for byte, so
//   those three logs carry a TRUE before/after comparison and it is green -- Stage 8 costs them nothing.
//
//   THE OTHER LOGS CARRY TARGETED COMPARISONS, one per slice, each against the pre-slice rule written out
//   verbatim beside the repaired one: `presidencyCorpus.test.ts` (8.3's selector), `mohawkExchangeCorpus.test.ts`
//   (8.4's arm, forked and replayed to convergence), `legacyHomeAdapter.test.ts` (8.2's adapter on the frozen
//   CV4 and Z6C logs). This file adds the whole-corpus facts those three do not measure: which stored entries
//   the v6 authority REFUSES, whether any log's board moves on an entry it should not, and that every log
//   replays deterministically to a stable final board.
//
// IT READS THE LOCAL DEVELOPMENT CORPUS, which is not committed; like `moneyConservation.test.ts` it says
// nothing when the files are absent. The numbers are printed once, because the numbers are the deliverable.
//
// NOTHING HERE WRITES. No golden is repinned, no log is rewritten, no expectation is re-derived from the new
// engine.

export {};

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type ExportedEntry = import("../gameEngine/replayLog").ExportedEntry;
type ReplayEntry = import("../gameEngine/replayLog").ReplayEntry;
type ServerLogEntry = import("./roomSession").ServerLogEntry;

const { replayLog, entriesFromExport, RoomEngine } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { stateDigest, canonicalJson } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { sharePriceFor, legalForcedSales, forcedSaleRefusal } =
  require("../gameEngine/emergencyFunding") as typeof import("../gameEngine/emergencyFunding");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
const { revertTargetOf } = require("../gameEngine/logRevert") as typeof import("../gameEngine/logRevert");
const { stockRoundBoard, P1: F1, P2: F2, NYC, MH } = require("./offerFixtures74") as typeof import("./offerFixtures74");
const { withCorp } = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");
const {
  DEVELOPMENT_CORPUS_POLICY,
  RULES_ENGINE_CHANGELOG,
  RULES_ENGINE_VERSION,
  RULES_ENGINE_VERSION_FIELD,
  SUPPORTED_RULES_ENGINE_VERSIONS,
  ReplayIncompatibleError,
} = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");

const P1 = "p1";
const P2 = "p2";

const seed = () => ({
  state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});

const dealtRoom = () => {
  const room = new RoomSession({ providers: sandboxReplayProviders(), seed: seed(), build: "b", mintId: () => "d" });
  const dealt = room.submit({
    actor: P1,
    build: "b",
    msg: { SetupGame: { players: [{ id: P1, nickname: "A" }, { id: P2, nickname: "B" }], variants: {}, build: "b" } } as never,
    baseIndex: -1,
  });
  expect(dealt.kind).toBe("applied");
  return room;
};

const repinned = (entries: readonly ServerLogEntry[], version: number): ServerLogEntry[] =>
  entries.map((row) => {
    const parsed = JSON.parse(row.payload) as { SetupGame?: Record<string, unknown> };
    return parsed.SetupGame
      ? { ...row, payload: JSON.stringify({ ...parsed, SetupGame: { ...parsed.SetupGame, [RULES_ENGINE_VERSION_FIELD]: version } }) }
      : { ...row };
  });

/* ================================================================================================= */
/* 1. THE BUMP                                                                                        */
/* ================================================================================================= */

describe("RULES_ENGINE_VERSION 6 (Stage 8.5)", () => {
  it("is 6, the changelog's sixth row says why, and a new deal is stamped 6 on the log and on the board", () => {
    expect(RULES_ENGINE_VERSION).toBe(6);
    expect(RULES_ENGINE_CHANGELOG.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6]);
    const note = RULES_ENGINE_CHANGELOG[5].note;
    /* Every semantic half of Stage 8 is named in the row, because the number is meaningless without it. */
    for (const phrase of [
      /Stage 8/,
      /operating order/i,
      /sold-out rise/i,
      /FIRST OPERATING TURN/i,
      /Erie/,
      /Cleveland or\s+Richmond/i,
      /CLOCKWISE/,
      /Scenario-D/,
      /Mohawk & Hudson/,
      /pending_mh_exchange/,
      /unparred/i,
    ]) {
      expect(`row6 matches ${String(phrase)}: ${phrase.test(note)}`).toBe(`row6 matches ${String(phrase)}: true`);
    }
    const room = dealtRoom();
    expect(room.rulesEngineVersion()).toBe(6);
    expect(room.state.rules_engine_version).toBe(6);
  });

  it("supports exactly this version -- the list is derived, as every bump since version 1 has left it", () => {
    /* PRECEDENT, NOT A NEW POLICY. `SUPPORTED_RULES_ENGINE_VERSIONS = [RULES_ENGINE_VERSION]` has been a
       one-element derived list since #1520, and every changelog row ends "a version-N log ... is refused,
       never reinterpreted". The bump therefore replaces the supported version rather than accumulating one;
       nothing had to be edited for that to happen, which is the point of deriving it. */
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([RULES_ENGINE_VERSION]);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([6]);
  });

  it("refuses a version-5 room before the reducer sees a single entry, on restore and headless, under EVERY policy", () => {
    const versionFive = repinned(dealtRoom().entries, 5);
    const applySpy = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      const held = new RoomSession({ providers: sandboxReplayProviders(), seed: seed(), build: "b", mintId: () => "x" });
      held.restore(versionFive);
      expect(held.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 5, supported: [6] });
      /* #1520: the development-corpus opt-in admits the UNPINNED, never the differently pinned. */
      const underCorpusPolicy = new RoomSession({
        providers: sandboxReplayProviders(),
        seed: seed(),
        build: "b",
        mintId: () => "y",
        replayPolicy: DEVELOPMENT_CORPUS_POLICY,
      });
      underCorpusPolicy.restore(versionFive);
      expect(underCorpusPolicy.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 5, supported: [6] });
      expect(() => replayLog(versionFive as ReplayEntry[], sandboxReplayProviders(), seed())).toThrow(ReplayIncompatibleError);
      expect(() =>
        replayLog(versionFive as ReplayEntry[], sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY),
      ).toThrow(ReplayIncompatibleError);
      expect(applySpy).not.toHaveBeenCalled();
    } finally {
      applySpy.mockRestore();
    }
  });

  it("leaves the legacy boundary exactly where #1520 put it: the server refuses an unpinned log, the corpus policy admits it", () => {
    const golden = join(__dirname, "__fixtures__", "replayGolden", "logs", "JUNO-CV4.log.jsonl");
    const entries = entriesFromExport(
      readFileSync(golden, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as ExportedEntry),
    );
    expect(() => replayLog(entries, sandboxReplayProviders(), seed())).toThrow(/before rules-engine versioning/);
    const admitted = replayLog(entries, sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(admitted.applied).toBe(141);
    // An unpinned log stays unpinned: nothing in the replay writes the new number onto its board.
    expect(admitted.state.rules_engine_version).toBeUndefined();
  });
});

/* ================================================================================================= */
/* 2. `pending_mh_exchange` IS AUTHORITATIVE v6 STATE                                                 */
/* ================================================================================================= */

describe("§10 the M&H pending request is authoritative state, and the digest says so (#1630)", () => {
  const board = (over: Partial<GameStateResponse> = {}): GameStateResponse =>
    ({ game_id: 1, player_addresses: [P1, P2], public_companies: [], private_companies: [], ...over }) as unknown as GameStateResponse;
  const queued = { player: P1, private_id: 4, company_id: 2, source: "Ipo" as const };

  it("a board with a queued request never digests as one without: absent, null and standing are three states", () => {
    const absent = stateDigest(board());
    const cleared = stateDigest(board({ pending_mh_exchange: null }));
    const standing = stateDigest(board({ pending_mh_exchange: queued }));
    expect(new Set([absent, cleared, standing]).size).toBe(3);
    /* #232's rule, and why the first two differ at all: `undefined` is omitted from the canonical form and
       `null` is kept, so "this log carries no request" and "a settlement cleared one" stay distinguishable. */
    expect(canonicalJson(board())).not.toContain("pending_mh_exchange");
    expect(canonicalJson(board({ pending_mh_exchange: null }))).toContain('"pending_mh_exchange":null');
  });

  it("the digest is the WHOLE state, so the field needed no registration -- and every field of it counts", () => {
    const base = board({ pending_mh_exchange: queued });
    for (const [field, changed] of [
      ["player", { ...queued, player: P2 }],
      ["private_id", { ...queued, private_id: 5 }],
      ["company_id", { ...queued, company_id: 3 }],
      ["source", { ...queued, source: "Bank" as const }],
    ] as const) {
      expect(`${field}: ${stateDigest(board({ pending_mh_exchange: changed })) === stateDigest(base)}`).toBe(`${field}: false`);
    }
  });

  it("an old log with no such field deserialises to no pending request, and the reducer treats absence as none", () => {
    const legacy = board();
    expect("pending_mh_exchange" in legacy).toBe(false);
    expect(legacy.pending_mh_exchange ?? null).toBeNull();
  });

  /* ==================================================================
      THE DIGEST CHAIN, END TO END: REQUEST -> SETTLEMENT -> REVERT
     ==================================================================
     The three cases above prove the SHAPE of the property on hand-built boards. This one proves it on the
     path that matters -- the reducer, entry by entry, from a real Stock Round board -- because a field that
     digests distinctly in isolation is worth nothing if the replay that rebuilds a room cannot reproduce it.
     `stateDigest` needed NO production change for any of this: it canonicalises the whole state (#232), so a
     new authoritative field is covered the moment the reducer writes it, and `pending_mh_exchange` was never
     registered anywhere. What is asserted here is DIGEST EQUALITY, not field equality: `mohawkExchangeAuthority`
     §12 already pins the fields, and a digest comparison is the strictly stronger statement. */
  describe("the digest chain: request, settlement, and revert to either side of it", () => {
    const ORIGIN = withCorp(stockRoundBoard({ seat: 1 }), NYC, { ipo_pool_percentage: 50, bank_pool_percentage: 10 });
    const EXCHANGE = { ExchangePrivate: { game_id: 1, private_id: MH, company_id: NYC, player: F1, source: "Ipo" } };
    const PASS = { PassTurn: { game_id: 1 } };
    const at = (index: number, msg: unknown, actor: string): ReplayEntry => ({
      index,
      id: `mh${index}`,
      actor,
      derived: false,
      payload: JSON.stringify(msg),
    });
    /** The log, in order: P1 interjects off-turn (so the request QUEUES), then P2's turn ends. */
    const LOG = [at(1, EXCHANGE, F1), at(2, PASS, F2), at(3, PASS, F2)];

    /** The reducer's own path, entry by entry -- and a REVERT is exactly a replay of the surviving prefix. */
    const prefix = (count: number): GameStateResponse => {
      const engine = new RoomEngine(sandboxReplayProviders(), { state: ORIGIN, waterfall: null });
      for (const one of LOG.slice(0, count)) engine.apply(one);
      return engine.snapshot.state;
    };

    /* `A` is the board the ENGINE starts from, not the literal fixture: `RoomEngine` normalises its seed
       (the grid the deal prints, #1301), and a revert that kills every entry rebuilds to that normalised
       board. Comparing against the raw fixture would be comparing a replay to something no replay produces. */
    const A = prefix(0); // no pending request
    const B = prefix(1); // the request standing
    const settledAt = [2, 3].find((n) => (prefix(n).pending_mh_exchange ?? null) === null) ?? -1;

    it("premises: the request queues rather than executing, and the boundary settles it", () => {
      expect(A.pending_mh_exchange ?? null).toBeNull();
      expect(ORIGIN.pending_mh_exchange ?? null).toBeNull();
      expect(B.pending_mh_exchange).toEqual({ player: F1, private_id: MH, company_id: NYC, source: "Ipo" });
      // Queuing vests nothing: no share has moved and the M&H is still open.
      expect(canonicalJson(B.public_companies)).toBe(canonicalJson(A.public_companies));
      expect(canonicalJson(B.private_companies)).toBe(canonicalJson(A.private_companies));
      expect(settledAt).toBeGreaterThan(0);
      const S = prefix(settledAt);
      expect(S.pending_mh_exchange).toBeNull();
      expect(canonicalJson(S.public_companies)).not.toBe(canonicalJson(A.public_companies));
    });

    it("A and B digest differently, and the settled board differs from both", () => {
      const S = prefix(settledAt);
      expect(stateDigest(A)).not.toBe(stateDigest(B));
      expect(stateDigest(S)).not.toBe(stateDigest(A));
      expect(stateDigest(S)).not.toBe(stateDigest(B));
      expect(new Set([stateDigest(A), stateDigest(B), stateDigest(S)]).size).toBe(3);
    });

    it("REVERT to before the request restores A's digest; to after it, B's; to after the boundary, the settled one", () => {
      /* A revert is resolved by `effectiveActions` BEFORE the reducer sees the log (#1026), so the board it
         rebuilds is the replay of the surviving prefix. Asserted through `replayLog` with a real `RevertTo`
         appended, and compared by DIGEST against the prefix replays above. */
      const revertTo = (index: number): GameStateResponse =>
        replayLog(
          [...LOG, at(9, { RevertTo: { index, player: F1, summary: "undo" } }, F1)],
          sandboxReplayProviders(),
          { state: ORIGIN, waterfall: null },
          undefined,
          DEVELOPMENT_CORPUS_POLICY,
        ).state;
      expect(stateDigest(revertTo(1))).toBe(stateDigest(A)); // everything from the request onward undone
      expect(stateDigest(revertTo(2))).toBe(stateDigest(B)); // the request stands, unsettled
      expect(stateDigest(revertTo(settledAt + 1))).toBe(stateDigest(prefix(settledAt))); // the settled board
      // And the whole log with no revert lands on the settled board too.
      expect(stateDigest(replayLog(LOG, sandboxReplayProviders(), { state: ORIGIN, waterfall: null }, undefined, DEVELOPMENT_CORPUS_POLICY).state))
        .toBe(stateDigest(prefix(LOG.length)));
    });
  });
});

/* ================================================================================================= */
/* 3. S8-8 RESIDUAL: AN UNPARRED CORPORATION HAS NO PRICE                                             */
/* ================================================================================================= */

describe("§4 S8-8: the last share-price nominal leaves the forced-sale projection (#1640)", () => {
  const PRR = 1;
  const NYC = 2;
  const priced = (over: { par?: string | null; mark?: number | null; pinned?: boolean } = {}): GameStateResponse =>
    ({
      game_id: 1,
      player_addresses: [P1, P2],
      player_cash: [{ player: P1, cash_vgp: "0" }, { player: P2, cash_vgp: "0" }],
      current_round_type: "OperatingRound",
      private_companies: [],
      ...(over.pinned === false ? {} : { rules_engine_version: RULES_ENGINE_VERSION }),
      ...(over.mark === null ? {} : { market_positions: { [NYC]: { x: 5, y: 6, price: over.mark ?? 90, enteredAt: 1 } } }),
      public_companies: [
        {
          company_id: NYC,
          ticker: "NYC",
          is_floated: true,
          president: P1,
          par_value: over.par === undefined ? "90" : over.par,
          ipo_pool_percentage: 0,
          bank_pool_percentage: 0,
          treasury: "0",
          owned_trains: [],
          player_holdings: [{ player: P1, percentage: 40 }],
        },
      ],
    }) as unknown as GameStateResponse;

  it("1. a parred corporation on the chart keeps exactly the price it had", () => {
    expect(sharePriceFor(priced(), NYC)).toBe(90);
  });

  it("2. an UNPARRED corporation has no price -- on a pinned board and on a legacy one alike (S8-8)", () => {
    expect(sharePriceFor(priced({ par: null, mark: null }), NYC)).toBeNull();
    expect(sharePriceFor(priced({ par: null, mark: null, pinned: false }), NYC)).toBeNull();
    /* Even with a token somehow on the chart, the rule the sale gate states is about the PAR; a corporation
       with a mark is priced by it, which is the one case where the chart is the better answer. */
    expect(sharePriceFor(priced({ par: null }), NYC)).toBe(90);
  });

  it("3. the 6.6.3 projection SKIPS a priceless corporation rather than valuing it at the old nominal", () => {
    const unstarted = priced({ par: null, mark: null });
    const funding = { companyId: PRR, ticker: "PRR", president: P1, shortfall: 100 };
    expect(forcedSaleRefusal(unstarted, funding, P1, NYC, 10)).toMatch(/has not been started yet/);
    expect(legalForcedSales(unstarted, funding).map((sale) => sale.ticker)).toEqual([]);
    // And the charted, parred board still projects the sale it always did.
    const started = priced();
    expect(forcedSaleRefusal(started, funding, P1, NYC, 10)).toBeNull();
    expect(legalForcedSales(started, funding).map((sale) => sale.pricePerShare)).toEqual([90]);
  });

  it("4. §7.2's pinned/legacy split is preserved, not widened: a parred corporation with no mark", () => {
    /* On a board this engine dealt there is no nominal (rule 4's own wording); on a legacy or chartless one
       the reducer's nominal stands, which is D-9 and is what the Batch-5 fixtures are built on. */
    expect(sharePriceFor(priced({ mark: null }), NYC)).toBeNull();
    expect(sharePriceFor(priced({ mark: null, pinned: false }), NYC)).toBe(67);
  });

  it("5. no `?? 67` survives in the price helpers, and the two surviving nominals say what they are for", () => {
    const emergency = readStripped("gameEngine/emergencyFunding.ts");
    expect(emergency).not.toMatch(/\?\?\s*NOMINAL_SHARE_PRICE/);
    expect(emergency).toMatch(/rules_engine_version === "number" \? null : NOMINAL_SHARE_PRICE/);
    // The display ladder has answered market -> par -> nothing since #711 and is untouched by this slice.
    expect(readStripped("gameEngine/gameState.ts")).not.toMatch(/\?\?\s*67/);
  });
});

/* ================================================================================================= */
/* 4. THE STAGE-8 CORPUS RECONCILIATION, MEASURED FROM HEAD                                           */
/* ================================================================================================= */

const FROZEN_DIR = join(__dirname, "__fixtures__", "replayGolden", "logs");
const SERVER_DIR = join(__dirname, "..", "..", "..", "server", "data");
const EXPORT_DIR = join(__dirname, "..", "..");
const PREFIX_DIR = join(__dirname, "__fixtures__");

const jsonl = (file: string): ExportedEntry[] =>
  readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as ExportedEntry);
const exportedRows = (file: string): ExportedEntry[] => {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { actions?: ExportedEntry[]; entries?: ExportedEntry[] };
  return raw.actions ?? raw.entries ?? [];
};

function corpus(): Array<{ name: string; entries: ExportedEntry[] }> {
  const out: Array<{ name: string; entries: ExportedEntry[] }> = [];
  const add = (name: string, entries: ExportedEntry[]) => out.push({ name, entries });
  if (existsSync(FROZEN_DIR)) {
    for (const file of readdirSync(FROZEN_DIR).filter((f) => f.endsWith(".log.jsonl")).sort()) {
      add(`golden/${file.replace(".log.jsonl", "")}`, jsonl(join(FROZEN_DIR, file)));
    }
  }
  if (existsSync(SERVER_DIR)) {
    for (const file of readdirSync(SERVER_DIR).filter((f) => f.endsWith(".log.jsonl")).sort()) {
      add(`server/${file.replace(".log.jsonl", "")}`, jsonl(join(SERVER_DIR, file)));
    }
  }
  if (existsSync(EXPORT_DIR)) {
    for (const file of readdirSync(EXPORT_DIR).filter((f) => /^sandbox-log-JUNO-.*\.json$/.test(f)).sort()) {
      add(`export/${file.replace("sandbox-log-", "").replace(".json", "")}`, exportedRows(join(EXPORT_DIR, file)));
    }
  }
  const prefix = join(PREFIX_DIR, "JUNO-FCJ-prefix96.log.jsonl");
  if (existsSync(prefix)) add("prefix/JUNO-FCJ-96", jsonl(prefix));
  const z6c = join(__dirname, "__fixtures__z6cLog.json");
  if (existsSync(z6c)) add("fixture/JUNO-Z6C-494", exportedRows(z6c));
  return out;
}

interface LogRow {
  name: string;
  stored: number;
  applied: number;
  dropped: number;
  /** Stored rows carrying a DISTINCT `id`. `effectiveActions` kills by id (#1026), so a log whose rows carry
   *  none has one identity for all of them -- which is the whole of finding S10-23 below. */
  distinctIds: number;
  /** Stored `RevertTo` rows. Harmless on a log with ids; total on a log without them. */
  reverts: number;
  /** Applied entries the REDUCER turned into no-ops -- it refused them, or they changed nothing. */
  noops: number;
  /** Those no-ops by message kind, which is what says WHICH authority declined them. */
  noopKinds: Record<string, number>;
  deterministic: boolean;
  digest: string;
  pendingAtEnd: boolean;
}

const keyOf = (msg: unknown): string => Object.keys(msg as Record<string, unknown>)[0] ?? "(none)";

/* ==================================================================
    WHAT IS MEASURED, AND WHAT IS DELIBERATELY NOT
   ==================================================================
   THE REDUCER, NOT INGRESS. `replayLog` never consults `turnRefusal`: the socket gate is the server's, and
   every corpus log predates it. Asking it of stored entries produces a cascade of "It is not your turn" the
   moment a replayed cursor differs from the one the live game had -- true of this corpus since Batch 3, and
   nothing to do with Stage 8. What a replay actually does with an entry it declines is return the board BY
   IDENTITY (#712), so a no-op is the observable refusal, and it is counted here per message kind.

   THESE COUNTS ARE NOT A STAGE-8 DELTA ON THEIR OWN -- they include every refusal Batches 3 through 7 added.
   They are the whole-corpus health facts the three slice comparisons do not cover: nothing stalls, nothing
   drifts between two replays of one log, and no board ends holding a request it should have settled. The
   before/after evidence is the goldens (a true Batch-7 baseline, byte for byte) and the per-slice legacy
   comparisons named in this file's header. */
function sweep(): LogRow[] {
  return corpus().map(({ name, entries }) => {
    const list = entriesFromExport(entries);
    const seen: Array<{ index: number; key: string; digest: string }> = [];
    const run = (observe?: Parameters<typeof replayLog>[3]) =>
      replayLog(list, sandboxReplayProviders(), seed(), observe, DEVELOPMENT_CORPUS_POLICY);
    const result = run(({ entry, msg, stateBefore }) => {
      seen.push({ index: entry.index, key: keyOf(msg), digest: stateDigest(stateBefore) });
    });
    const finalDigest = stateDigest(result.state);
    const noopKinds: Record<string, number> = {};
    let noops = 0;
    for (let at = 0; at < seen.length; at += 1) {
      const after = at + 1 < seen.length ? seen[at + 1].digest : finalDigest;
      if (seen[at].digest !== after) continue;
      noops += 1;
      noopKinds[seen[at].key] = (noopKinds[seen[at].key] ?? 0) + 1;
    }
    const again = run();
    return {
      name,
      stored: list.length,
      applied: result.applied,
      // `ReplayResult.dropped` is a COUNT, not a list (`replayLog.ts`): reading `.length` off it printed 0
      // for every log and hid the one difference this sweep exists to find.
      dropped: result.dropped,
      distinctIds: new Set(list.map((entry) => entry.id)).size,
      reverts: list.filter((entry) => revertTargetOf(entry) !== null).length,
      noops,
      noopKinds,
      deterministic: stateDigest(again.state) === finalDigest,
      digest: finalDigest,
      pendingAtEnd: (result.state.pending_mh_exchange ?? null) !== null,
    };
  });
}

const rows = corpus().length === 0 ? null : sweep();

describe("§5-§7 Stage-8 corpus reconciliation, measured from HEAD under engine v6", () => {
  if (rows === null) {
    it("skipped: the development corpus is not present in this checkout", () => {
      expect(corpus()).toEqual([]);
    });
    return;
  }

  it("prints the reconciliation -- files, entries, reducer no-ops by kind, determinism, final digests", () => {
    // eslint-disable-next-line no-console
    console.log(
      [
        `engine v${RULES_ENGINE_VERSION}; files ${rows.length}; stored entries ${rows.reduce((n, r) => n + r.stored, 0)}; ` +
          `applied ${rows.reduce((n, r) => n + r.applied, 0)}; dropped by RevertTo ${rows.reduce((n, r) => n + r.dropped, 0)}; ` +
          `reducer no-ops ${rows.reduce((n, r) => n + r.noops, 0)}`,
        `deterministic ${rows.filter((r) => r.deterministic).length}/${rows.length}; ` +
          `ending with a pending M&H request ${rows.filter((r) => r.pendingAtEnd).length}`,
        ...rows.map(
          (row) =>
            `  ${row.name}: stored ${row.stored}, applied ${row.applied}, dropped ${row.dropped}, ` +
            `no-ops ${row.noops}${row.noops === 0 ? "" : ` (${Object.entries(row.noopKinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}x${n}`).join(" ")})`}, ` +
            `deterministic ${row.deterministic}, digest ${row.digest}`,
        ),
        ...rows
          .filter((row) => row.stored > 0 && row.applied === 0)
          .map(
            (row) =>
              `  S10-23 ${row.name}: applies NOTHING -- ${row.stored} stored rows carry ${row.distinctIds} distinct id(s) ` +
              `and ${row.reverts} RevertTo row(s). See the S10-23 case below.`,
          ),
      ].join("\n"),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("every log replays deterministically to a stable final board", () => {
    expect(rows.filter((row) => !row.deterministic).map((row) => row.name)).toEqual([]);
  });

  it("no replay ends with a queued M&H request standing", () => {
    expect(rows.filter((row) => row.pendingAtEnd).map((row) => row.name)).toEqual([]);
  });

  /* ==================================================================
      FINDING S10-23: A LOG THAT APPLIES NOTHING IS A LOG WITHOUT IDS
     ==================================================================
     FILED, NOT FIXED (brief §1: a defect closure auditing discovers is recorded, not opportunistically
     repaired). The reconciliation found exactly one log in the corpus that replays to its seed: a hand
     exported `sandbox-log-JUNO-*.json` whose rows carry no `id` field at all.

     WHY THAT EMPTIES IT. `entriesFromExport` passes `id: entry.id` straight through (`replayLog.ts`), so a
     missing id stays missing and every row of such a log shares the identity `undefined`. `effectiveActions`
     resolves a `RevertTo` BY IDENTITY and not by position -- design note #1026, which is deliberate and
     correct: it is what stops an entry being destroyed merely for sharing a number with a reverted one. Given
     one identity for the whole log, the first `RevertTo` it scans adds `undefined` to the kill list and the
     closing filter then drops every row.

     WHY IT IS NOT STAGE 8's. `git log 7c5f29c..HEAD -- frontend/src/gameEngine/logRevert.ts` is empty: no
     Stage-8 slice touched the revert resolver, and the only Stage-8 change to `replayLog.ts` is 8.2's legacy
     home adapter, which does not touch id plumbing. A log with ids is unaffected, which is why the frozen
     goldens, the server logs and the prefix fixture all replay normally.

     WHAT WOULD FIX IT, when someone owns it: stamp an id at export time, or fall back to the index as the
     identity when a log carries none. Both are export/replay-harness changes and neither is a rule. */
  it("S10-23 (filed, not fixed): a log that applies nothing carries no entry ids, and no log with ids is affected", () => {
    const empty = rows.filter((row) => row.stored > 0 && row.applied === 0);
    for (const row of empty) {
      // One identity for the whole file, and at least one revert to weaponise it.
      expect({ name: row.name, distinctIds: row.distinctIds, hasRevert: row.reverts > 0 }).toEqual({
        name: row.name,
        distinctIds: 1,
        hasRevert: true,
      });
    }
    // And the converse: every log whose rows ARE distinctly identified applied something.
    const identified = rows.filter((row) => row.stored > 1 && row.distinctIds > 1);
    expect(identified.filter((row) => row.applied === 0).map((row) => row.name)).toEqual([]);
    expect(identified.length).toBeGreaterThan(0);
  });

  it("the frozen golden masters are the Batch-7 boards, and Stage 8 costs them nothing", () => {
    /* The assertion itself is `replayGolden.test.ts`'s and is not duplicated here; what this pins is the
       PROVENANCE the reconciliation rests on -- that the fixtures exist and that the three frozen logs are in
       the corpus this sweep walked, so "the goldens are green" is a statement about these same boards. */
    const goldens = readdirSync(join(__dirname, "__fixtures__", "replayGolden")).filter((f) => f.endsWith(".json")).sort();
    expect(goldens).toEqual(["JUNO-7NZ.json", "JUNO-CV4.json", "JUNO-G6J.json"]);
    for (const name of ["golden/JUNO-7NZ", "golden/JUNO-CV4", "golden/JUNO-G6J"]) {
      expect(rows.some((row) => row.name === name)).toBe(true);
    }
  });
});
