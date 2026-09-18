/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1630 (corpus): WHAT THE M&H AUTHORITY COSTS THE STORED LOGS (Slice 8.4, S8-10)
// ==================================================================
//
// Slice 8.4 is REPLAY-SEMANTIC in one direction: the `ExchangePrivate` arm now REFUSES what it used to apply,
// and SETTLES what it used to leave alone -- the float threshold (#1631) and the presidency (#1620). So a
// stored log carrying an exchange can rebuild to a different board from that entry on, and the Stage-8 design
// pass predicted exactly where: "3XD 288 takes NYC's IPO 50 -> 40 without floating it ... floats one entry
// later on 289's purchase", transient, "expected to converge after 289".
//
// A PREDICTION ABOUT THE CORPUS IS WORTH THE SWEEP THAT CHECKS IT, so this measures rather than assumes, and
// it measures by FORKING: at the entry the arm changed, the board the PRE-8.4 arm would have produced is
// built with `applyPrivateExchange` -- verbatim the old arm, one call, not a model of it -- and the REST OF
// THE LOG is replayed through both boards with the same providers, the same grid and the same adapters. Every
// artifact of replaying a suffix lands on both trajectories identically, so the digests that differ differ
// because of the arm and nothing else.
//
// IT READS THE LOCAL DEVELOPMENT CORPUS (`server/data`, `frontend/sandbox-log-*`, the frozen goldens), which
// is not committed; like `moneyConservation.test.ts` and `presidencyCorpus.test.ts` it says nothing when the
// files are absent rather than failing. The numbers it finds are printed once, because the numbers are the
// deliverable.
//
// NOTHING HERE WRITES. No golden is repinned, no log is rewritten, no expectation is re-derived from the new
// engine, and `RULES_ENGINE_VERSION` is not touched -- the Stage-8 bump is Slice 8.5's (§32 of the brief).

export {};

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const { entriesFromExport, replayLog, RoomEngine } =
  require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { DEVELOPMENT_CORPUS_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { applyPrivateExchange, MH_PRIVATE_ID } = require("../gameEngine/privateExchange") as typeof import("../gameEngine/privateExchange");
const { mhExchangeDisposition, mhExchangeRequestRefusal } =
  require("../gameEngine/mohawkExchange") as typeof import("../gameEngine/mohawkExchange");
const { stateDigest, fieldDigests } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { effectiveActions } = require("../gameEngine/logRevert") as typeof import("../gameEngine/logRevert");
const { RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type ExportedEntry = import("../gameEngine/replayLog").ExportedEntry;
type ReplayEntry = import("../gameEngine/replayLog").ReplayEntry;
type MapGridResponse = import("../components/hexContractTypes").MapGridResponse;

/* ---- the corpus, enumerated exactly as `presidencyCorpus.test.ts` enumerates it -------------------- */

const FROZEN_DIR = join(__dirname, "__fixtures__", "replayGolden", "logs");
const SERVER_DIR = join(__dirname, "..", "..", "..", "server", "data");
const EXPORT_DIR = join(__dirname, "..", "..");
const PREFIX_DIR = join(__dirname, "__fixtures__");

const jsonl = (file: string): ExportedEntry[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ExportedEntry);

const exported = (file: string): ExportedEntry[] => {
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
      add(`export/${file.replace("sandbox-log-", "").replace(".json", "")}`, exported(join(EXPORT_DIR, file)));
    }
  }
  const prefix = join(PREFIX_DIR, "JUNO-FCJ-prefix96.log.jsonl");
  if (existsSync(prefix)) add("prefix/JUNO-FCJ-96", jsonl(prefix));
  const z6c = join(__dirname, "__fixtures__z6cLog.json");
  if (existsSync(z6c)) add("fixture/JUNO-Z6C-494", exported(z6c));
  return out;
}

const seed = () => ({
  state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});

/* ---- what the sweep records ----------------------------------------------------------------------- */

/** One `ExchangePrivate` row as the FILE holds it, before `effectiveActions` decides whether it survives. */
interface StoredRow {
  log: string;
  index: number;
  source: string;
  /** A row a `RevertTo` removed: present in the file, never replayed, and therefore no board's business. */
  reverted: boolean;
}

interface ExchangeRecord {
  log: string;
  index: number;
  actor: string | null;
  player: string;
  source: string;
  companyId: number;
  privateId: number;
  /** `null` when the repaired authority accepts it -- the acceptance half of the comparison. */
  refusal: string | null;
  disposition: "execute" | "queue" | "(refused)";
  seated: string | null;
  round: string;
  /** Fields whose value differs between the pre-8.4 board and the repaired one, at this entry. */
  fieldsDiffering: string[];
  /** Human-readable before/after of each differing corporation fact. */
  detail: string[];
  /** Index at which the two forked trajectories agree again, or `null`. */
  convergedAt: number | null;
  /** Whether the two final boards are identical. */
  finalIdentical: boolean;
  /** Entries replayed through each fork. */
  suffixEntries: number;
}

function forkProviders(grid: MapGridResponse, board: GameStateResponse) {
  /* The constructor re-seeds the chart and the grid from the providers, so the fork is handed BOTH halves of
     the board it is forking from -- otherwise the suffix would replay on a fresh chart and an empty map and
     diverge for reasons that have nothing to do with this slice. */
  return { ...sandboxReplayProviders(), initialGrid: grid, initialMarket: board.market_positions ?? {} };
}

/** Replay `suffix` from `board`, returning the digest after each entry plus the final board. */
function forkFrom(board: GameStateResponse, grid: MapGridResponse, suffix: ReplayEntry[]) {
  const engine = new RoomEngine(forkProviders(grid, board), {
    state: board,
    waterfall: board.waterfall ?? null,
  });
  const digests: Array<{ index: number; digest: string }> = [];
  for (const entry of suffix) {
    engine.apply(entry);
    digests.push({ index: entry.index, digest: stateDigest(engine.snapshot.state) });
  }
  return { digests, final: engine.snapshot.state };
}

function sweep() {
  const records: ExchangeRecord[] = [];
  const stored: StoredRow[] = [];
  const logs: Array<{ name: string; entries: number; exchanges: number }> = [];
  let storedPendingFields = 0;
  let pendingAtEnd = 0;

  for (const { name, entries } of corpus()) {
    /* "any pending-request field ever present in stored corpus" -- asked of the RAW rows, message bodies
       included. `pending_mh_exchange` is state and no message carries it, so a hit would mean somebody had
       put a board fragment on the wire. */
    if (JSON.stringify(entries).includes("pending_mh_exchange")) storedPendingFields += 1;

    const replayEntries = entriesFromExport(entries);
    /* EVERY STORED ROW FIRST, so "the replay saw one" can be checked against "the file holds two". A row a
       `RevertTo` removed is in the file and not in the game -- `effectiveActions` drops it before the reducer
       sees it, which is also the corpus's own instance of "revert to before the request leaves no pending". */
    for (const entry of replayEntries) {
      let body: { source?: string } | undefined;
      try {
        body = (JSON.parse(entry.payload) as { ExchangePrivate?: { source?: string } }).ExchangePrivate;
      } catch {
        body = undefined;
      }
      if (body) {
        stored.push({
          log: name,
          index: entry.index,
          source: String(body.source),
          reverted: !effectiveActions(replayEntries).some((live) => live.index === entry.index),
        });
      }
    }
    const seen: Array<{ entry: ReplayEntry; stateBefore: GameStateResponse; grid: MapGridResponse; at: number }> = [];
    const exchangesHere: number[] = [];

    const result = replayLog(
      replayEntries,
      sandboxReplayProviders(),
      seed(),
      ({ entry, msg, stateBefore, grid }) => {
        seen.push({ entry, stateBefore, grid, at: seen.length });
        if ((msg as { ExchangePrivate?: unknown }).ExchangePrivate) exchangesHere.push(seen.length - 1);
      },
      DEVELOPMENT_CORPUS_POLICY,
    );
    logs.push({ name, entries: replayEntries.length, exchanges: exchangesHere.length });
    if ((result.state.pending_mh_exchange ?? null) !== null) pendingAtEnd += 1;

    for (const at of exchangesHere) {
      const { entry, stateBefore, grid } = seen[at];
      const body = (JSON.parse(entry.payload) as {
        ExchangePrivate: { private_id: number; company_id: number; player: string; source: "Ipo" | "Bank"; keep_open?: boolean };
      }).ExchangePrivate;

      /* THE REPAIRED AUTHORITY'S VERDICT, asked of the board the arm was handed. */
      const refusal = mhExchangeRequestRefusal(stateBefore, body, entry.actor ?? null);
      const disposition = refusal === null ? mhExchangeDisposition(stateBefore, body) : ("(refused)" as const);

      /* THE PRE-8.4 ARM, verbatim: `applyPrivateExchange` with the message's own fields, and nothing else --
         no float, no presidency, no refusal. */
      const legacy = applyPrivateExchange(stateBefore, {
        ok: true,
        privateId: body.private_id,
        companyId: body.company_id,
        ticker: stateBefore.public_companies.find((c) => c.company_id === body.company_id)?.ticker ?? "",
        player: body.player,
        source: body.source,
        keepOpen: body.keep_open === true,
      });
      /* THE REPAIRED BOARD after the same entry: the next entry's `stateBefore`, or the replay's final board
         when the exchange is the last entry. */
      const repaired = seen[at + 1]?.stateBefore ?? result.state;

      const before = fieldDigests(legacy);
      const after = fieldDigests(repaired);
      const fieldsDiffering = Object.keys({ ...before, ...after }).filter((key) => before[key] !== after[key]).sort();

      const detail: string[] = [];
      for (const company of repaired.public_companies) {
        const was = legacy.public_companies.find((c) => c.company_id === company.company_id);
        if (!was) continue;
        if (was.is_floated !== company.is_floated) {
          detail.push(`${company.ticker}.is_floated ${was.is_floated} -> ${company.is_floated}`);
        }
        if (was.president !== company.president) {
          detail.push(`${company.ticker}.president ${was.president ?? "(none)"} -> ${company.president ?? "(none)"}`);
        }
        if (was.treasury !== company.treasury) detail.push(`${company.ticker}.treasury ${was.treasury} -> ${company.treasury}`);
        if (was.ipo_pool_percentage !== company.ipo_pool_percentage) {
          detail.push(`${company.ticker}.ipo ${was.ipo_pool_percentage} -> ${company.ipo_pool_percentage}`);
        }
        if (was.bank_pool_percentage !== company.bank_pool_percentage) {
          detail.push(`${company.ticker}.pool ${was.bank_pool_percentage} -> ${company.bank_pool_percentage}`);
        }
      }
      if (legacy.virtual_bank_vgp !== repaired.virtual_bank_vgp) {
        detail.push(`bank ${legacy.virtual_bank_vgp} -> ${repaired.virtual_bank_vgp}`);
      }

      /* THE FORK. Both boards replay the SAME remaining entries with the SAME providers, grid and adapters. */
      const suffix = seen.slice(at + 1).map((one) => one.entry);
      const oldRun = forkFrom(legacy, grid, suffix);
      const newRun = forkFrom(repaired, grid, suffix);
      let convergedAt: number | null = null;
      for (let step = 0; step < suffix.length; step += 1) {
        if (oldRun.digests[step].digest === newRun.digests[step].digest) {
          /* Converged means STAYS converged -- a single coincidental match is not convergence. */
          if (oldRun.digests.slice(step).every((row, n) => row.digest === newRun.digests[step + n].digest)) {
            convergedAt = oldRun.digests[step].index;
            break;
          }
        }
      }

      records.push({
        log: name,
        index: entry.index,
        actor: entry.actor ?? null,
        player: body.player,
        source: body.source,
        companyId: body.company_id,
        privateId: body.private_id,
        refusal,
        disposition,
        seated: stateBefore.player_addresses[stateBefore.active_player_index] ?? null,
        round: stateBefore.current_round_type,
        fieldsDiffering,
        detail,
        convergedAt,
        finalIdentical: stateDigest(oldRun.final) === stateDigest(newRun.final),
        suffixEntries: suffix.length,
      });
    }
  }

  return { records, stored, logs, storedPendingFields, pendingAtEnd };
}

const findings = corpus().length === 0 ? null : sweep();

describe("S8-10 corpus: the M&H exchange under the repaired authority (#1630)", () => {
  if (findings === null) {
    it("skipped: the development corpus is not present in this checkout", () => {
      expect(corpus()).toEqual([]);
    });
    return;
  }

  it("prints the sweep -- the files, the entries, and every stored exchange", () => {
    const { records, stored, logs, storedPendingFields, pendingAtEnd } = findings;
    // eslint-disable-next-line no-console
    console.log(
      [
        `logs inspected: ${logs.length}, entries: ${logs.reduce((sum, row) => sum + row.entries, 0)}`,
        ...logs.map((row) => `  ${row.name}: ${row.entries} entries, ExchangePrivate x${row.exchanges}`),
        `stored \`ExchangePrivate\` rows: ${stored.length} (${stored.filter((row) => row.reverted).length} reverted, ` +
          `${stored.length - stored.filter((row) => row.reverted).length} replayed)`,
        ...stored.map(
          (row) => `  ${row.log} @${row.index}: source ${row.source}${row.reverted ? " -- REVERTED, never replayed" : ""}`,
        ),
        `stored logs carrying a \`pending_mh_exchange\` field anywhere: ${storedPendingFields}`,
        `replays ending with a pending request still standing: ${pendingAtEnd}`,
        `RULES_ENGINE_VERSION (unchanged by this slice): ${RULES_ENGINE_VERSION}`,
        ...records.flatMap((row) => [
          `  ${row.log} @${row.index}: private ${row.privateId} -> company ${row.companyId}, source ${row.source}, ` +
            `player ${row.player}, actor ${row.actor ?? "(none)"}, round ${row.round}, seated ${row.seated ?? "(none)"}`,
          `      repaired authority: ${row.refusal === null ? "ACCEPTED" : `REFUSED (${row.refusal})`}, disposition ${row.disposition}`,
          `      first field difference: ${row.fieldsDiffering.length === 0 ? "(none)" : row.fieldsDiffering.join(", ")}`,
          `      detail: ${row.detail.length === 0 ? "(none)" : row.detail.join("; ")}`,
          `      forked through ${row.suffixEntries} further entries; converged at ${row.convergedAt ?? "(never)"}; ` +
            `final boards identical: ${row.finalIdentical}`,
        ]),
      ].join("\n"),
    );
    expect(logs.length).toBeGreaterThan(0);
  });

  it("the replayed exchanges are exactly the stored rows a RevertTo did not remove", () => {
    const live = findings.stored.filter((row) => !row.reverted).map((row) => `${row.log}@${row.index}`);
    expect(findings.records.map((row) => `${row.log}@${row.index}`)).toEqual(live);
    /* And a reverted request is not a request: the board a replay rebuilds has never heard of it. */
    for (const row of findings.stored.filter((one) => one.reverted)) {
      expect(findings.records.some((one) => one.log === row.log && one.index === row.index)).toBe(false);
    }
  });

  it("no stored log carries a pending-request field, and no replay ends with one standing", () => {
    expect(findings.storedPendingFields).toBe(0);
    expect(findings.pendingAtEnd).toBe(0);
  });

  it("every stored exchange is the M&H, for the NYC, and none carries `keep_open`", () => {
    for (const row of findings.records) {
      expect(`${row.log}@${row.index}: private ${row.privateId}`).toBe(`${row.log}@${row.index}: private ${MH_PRIVATE_ID}`);
    }
  });

  it("ACCEPTANCE: the repaired authority refuses no stored exchange -- no log stops meaning what it meant", () => {
    const refused = findings.records.filter((row) => row.refusal !== null);
    expect(refused.map((row) => `${row.log}@${row.index}: ${row.refusal}`)).toEqual([]);
  });

  it("every stored exchange was made on its owner's own Stock Round turn, so none of them queues", () => {
    /* Not a rule -- a measurement. The off-turn half of the power has never been exercised in the corpus,
       which is exactly why S8-10's queued path has no stored evidence and is pinned by the unit suite
       instead. If a future log queues one, this line is where it shows up. */
    expect(findings.records.map((row) => `${row.log}@${row.index}: ${row.disposition}`)).toEqual(
      findings.records.map((row) => `${row.log}@${row.index}: execute`),
    );
  });

  it("DIVERGENCE: the only stored consequence is the float (and what the float implies), and it converges", () => {
    for (const row of findings.records) {
      /* The predicted difference and nothing else: a corporation that should have floated on the exchange
         now does, which moves its `is_floated`, its capitalised treasury and the bank that paid for it. A
         difference in any OTHER field would be an unpredicted consequence and is what this case is for. */
      const allowed = new Set(["public_companies", "virtual_bank_vgp", "private_companies"]);
      expect(`${row.log}@${row.index}: ${row.fieldsDiffering.filter((f) => !allowed.has(f)).join(",")}`).toBe(
        `${row.log}@${row.index}: `,
      );
      for (const line of row.detail) {
        expect(`${row.log}@${row.index}: ${line}`).toMatch(/is_floated false -> true|treasury|bank/);
      }
    }
  });

  it("CONVERGENCE: each forked trajectory rejoins the repaired one, and the final boards agree", () => {
    for (const row of findings.records) {
      expect(`${row.log}@${row.index} converged`).toBe(
        `${row.log}@${row.index} ${row.convergedAt === null ? "never converged" : "converged"}`,
      );
      expect(`${row.log}@${row.index} final identical: ${row.finalIdentical}`).toBe(
        `${row.log}@${row.index} final identical: true`,
      );
    }
  });
});
