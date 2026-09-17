/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1620 (corpus): WHAT THE CLOCKWISE TIE-BREAK COSTS THE STORED LOGS
// ==================================================================
//
// Slice 8.3 is REPLAY-SEMANTIC: `presidentFor` can now name a different successor than it did, so a stored
// log could in principle rebuild to a different board. The Stage-8 design pass predicted it costs nothing --
// "no stored log contains a tie between two challengers" -- and a prediction about the corpus is worth
// exactly as much as the sweep that checks it.
//
// HOW IT IS CHECKED, AND WHY THIS WAY. The pre-8.3 selector is 20 lines, so it is written out here verbatim
// and asked of the SAME board, at every entry of every log, beside the repaired one. Two engines would have
// to be built and diffed; one engine and one legacy function answer the same question -- "is there any
// stored board on which the two rules disagree" -- exactly, cheaply and read-only. Where they agree
// everywhere, every digest and every golden is untouched by construction, which is the claim the version
// policy rests on (the 5 -> 6 bump stays owed at Slice 8.5).
//
// IT READS THE LOCAL DEVELOPMENT CORPUS (`server/data`, `frontend/sandbox-log-*`), which is not committed;
// like `moneyConservation.test.ts` it says nothing when the files are absent rather than failing. The counts
// it finds are printed once, because the numbers are the deliverable.
//
// NOTHING HERE WRITES. No golden is repinned, no log is rewritten, no expectation is re-derived from the new
// engine: a disagreement is a FAILURE with the file, the index and both answers named, for a human to read.

export {};

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const { entriesFromExport, replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { DEVELOPMENT_CORPUS_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { presidentFor, PRESIDENT_CERTIFICATE_PERCENT } =
  require("../gameEngine/presidencyTransfer") as typeof import("../gameEngine/presidencyTransfer");
const { doubleCertificateAt, needsDoubleForPresidencyExchange } =
  require("../gameEngine/doubleCertificate") as typeof import("../gameEngine/doubleCertificate");
const { shareSaleBlock } = require("../gameEngine/shareSale") as typeof import("../gameEngine/shareSale");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type PublicCompanyState = import("../gameEngine/gameState").PublicCompanyState;
type ExportedEntry = import("../gameEngine/replayLog").ExportedEntry;

/* ---- the corpus, enumerated exactly as `moneyConservation.test.ts` enumerates it ------------------- */

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

/* ---- the PRE-8.3 selector, copied from `presidencyTransfer.ts` at efe4098 -------------------------- */

/** `presidentFor(company)` as it stood before Slice 8.3: the tie among top challengers went to the first
 *  matching entry in `player_holdings`, i.e. first-acquisition order. Verbatim, including the unreachable
 *  `eligible.reduce` arm, so the comparison is against what the corpus was actually replayed with. */
function legacyPresidentFor(company: PublicCompanyState): string | null {
  const holdings = company.player_holdings.filter((entry) => entry.percentage > 0);
  if (holdings.length === 0) return null;
  const eligible = holdings.filter((entry) => entry.percentage >= PRESIDENT_CERTIFICATE_PERCENT);
  if (eligible.length === 0) return null;
  const incumbent = company.president;
  const incumbentHolding =
    incumbent === null ? 0 : (holdings.find((entry) => entry.player === incumbent)?.percentage ?? 0);
  const challengers = eligible.filter((entry) => entry.percentage > incumbentHolding);
  if (challengers.length === 0) {
    return incumbent !== null && incumbentHolding >= PRESIDENT_CERTIFICATE_PERCENT
      ? incumbent
      : (eligible.reduce((best, entry) => (entry.percentage > best.percentage ? entry : best)).player ?? null);
  }
  const top = challengers.reduce((best, entry) => (entry.percentage > best.percentage ? entry : best));
  return challengers.find((entry) => entry.percentage === top.percentage)?.player ?? top.player;
}

/** Whether this board is one the tie-break actually decides: two or more challengers, all above the
 *  incumbent, level at the top. The case the design pass predicted the corpus does not contain. */
function tiedChallengers(company: PublicCompanyState): string[] {
  const holdings = company.player_holdings.filter((entry) => entry.percentage > 0);
  const eligible = holdings.filter((entry) => entry.percentage >= PRESIDENT_CERTIFICATE_PERCENT);
  if (eligible.length === 0) return [];
  const incumbent = company.president;
  const incumbentHolding =
    incumbent === null ? 0 : (holdings.find((entry) => entry.player === incumbent)?.percentage ?? 0);
  const challengers = eligible.filter((entry) => entry.percentage > incumbentHolding);
  if (challengers.length < 2) return [];
  const top = Math.max(...challengers.map((entry) => entry.percentage));
  const tied = challengers.filter((entry) => entry.percentage === top);
  return tied.length >= 2 ? tied.map((entry) => entry.player) : [];
}

const parred = (company: PublicCompanyState) =>
  company.par_value !== null && company.par_value !== undefined;

interface Disagreement {
  log: string;
  index: number;
  ticker: string;
  legacy: string | null;
  repaired: string | null;
  incumbent: string | null;
  holdings: string;
  seating: string;
}

interface Tally {
  logs: number;
  entries: number;
  boards: number;
  changes: number;
  ties: number;
  scenarioDChanges: number;
  /** Boards on which #1622's special 20%-for-20% exchange would fire -- S8-15's whole surface. */
  specialExchanges: number;
  specialList: string[];
  /** Company-boards carrying a Scenario-D other-20 certificate at all. */
  doubleBoards: number;
  /** Stored `SellStock` entries put back through the gate -- the vacuity control for `newlyRefused`. */
  salesChecked: number;
  /** Stored `SellStock` entries the S9-14 gate (#1624) would now refuse -- each one a replay change. */
  newlyRefused: string[];
  disagreements: Disagreement[];
  tieBoards: string[];
  changeList: string[];
}

function sweep(): Tally {
  const tally: Tally = {
    logs: 0,
    entries: 0,
    boards: 0,
    changes: 0,
    ties: 0,
    scenarioDChanges: 0,
    specialExchanges: 0,
    specialList: [],
    doubleBoards: 0,
    salesChecked: 0,
    newlyRefused: [],
    disagreements: [],
    tieBoards: [],
    changeList: [],
  };

  for (const { name, entries } of corpus()) {
    tally.logs += 1;
    const seedState = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
    const seedWaterfall = waterfallForRoster(
      sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
      [],
    );
    /** The last president seen per company, for counting transitions across the replay. */
    const crown = new Map<number, string | null>();

    const inspect = (state: GameStateResponse, index: number) => {
      const seating = state.player_addresses ?? [];
      for (const company of state.public_companies) {
        if (!parred(company)) continue;
        tally.boards += 1;

        const legacy = legacyPresidentFor(company);
        const repaired = presidentFor(company, seating);
        if (legacy !== repaired) {
          tally.disagreements.push({
            log: name,
            index,
            ticker: company.ticker,
            legacy,
            repaired,
            incumbent: company.president,
            holdings: company.player_holdings.map((e) => `${e.player}:${e.percentage}`).join(" "),
            seating: seating.join(" "),
          });
        }

        /* S8-15 (#1622): would a presidency change on this board also move the printed other-20 card? Only a
           Scenario-D corporation can answer yes, and only when the successor holds that card and has no two
           ordinary 10%s besides. Counted so the card half of the slice has the same corpus evidence the
           selection half has. */
        if (repaired !== null && repaired !== company.president && needsDoubleForPresidencyExchange(company, repaired)) {
          tally.specialExchanges += 1;
          tally.specialList.push(`${name} @${index} ${company.ticker}: ${company.president ?? "(none)"} -> ${repaired}`);
        }

        if (doubleCertificateAt(company) !== null) tally.doubleBoards += 1;

        const tied = tiedChallengers(company);
        if (tied.length >= 2) {
          tally.ties += 1;
          tally.tieBoards.push(`${name} @${index} ${company.ticker}: ${tied.join(" = ")}`);
        }

        if (crown.has(company.company_id)) {
          const was = crown.get(company.company_id) ?? null;
          if (was !== company.president) {
            tally.changes += 1;
            tally.changeList.push(
              `${name} @${index} ${company.ticker}: ${was ?? "(none)"} -> ${company.president ?? "(none)"}`,
            );
            if (doubleCertificateAt(company) !== null) tally.scenarioDChanges += 1;
          }
        }
        crown.set(company.company_id, company.president);
      }
    };

    const result = replayLog(
      entriesFromExport(entries),
      sandboxReplayProviders(),
      { state: seedState, waterfall: seedWaterfall },
      ({ entry, msg, stateBefore }) => {
        tally.entries += 1;
        inspect(stateBefore, entry.index);
        /* S9-14 (#1624) IS A NEW REFUSAL, and a new refusal is replay-semantic in a way a changed tie-break
           is not: a stored sale the engine now declines rebuilds a different board from that entry on. So
           every stored `SellStock` is put back through the canonical gate on the board it was sent against,
           and the ones carrying the new sentence are named. Asked of `shareSaleBlock` itself rather than of a
           copy of the predicate. */
        const sell = (msg as { SellStock?: { protocol_id: number; percentage: number } }).SellStock;
        if (sell && entry.actor) {
          tally.salesChecked += 1;
          const refusal = shareSaleBlock({
            state: stateBefore,
            seller: entry.actor,
            companyId: sell.protocol_id,
            percentage: sell.percentage,
          });
          if (refusal !== null && /already in the Bank Pool/.test(refusal)) {
            tally.newlyRefused.push(`${name} @${entry.index} ${entry.actor} sells ${sell.percentage}% of ${sell.protocol_id}`);
          }
        }
      },
      DEVELOPMENT_CORPUS_POLICY,
    );
    inspect(result.state, -1);
  }
  return tally;
}

const tally = sweep();

describe("the stored corpus under the clockwise tie-break (S8-2)", () => {
  if (tally.logs === 0) {
    it("has no local corpus to sweep, and says so rather than passing quietly", () => {
      expect(tally.logs).toBe(0);
    });
  } else {
    it("reports what it swept", () => {
      /* The numbers, printed once. `boards` is company-boards inspected, not files: every parred
         corporation on every entry's board plus the final one. */
      // eslint-disable-next-line no-console
      console.log(
        [
          `S8-2 corpus sweep: ${tally.logs} logs / ${tally.entries} applied entries / ${tally.boards} parred company-boards`,
          `presidency changes: ${tally.changes}`,
          `tied-challenger boards: ${tally.ties}`,
          `Scenario-D (other-20%) corporations among the changes: ${tally.scenarioDChanges}`,
          `boards where the special 20%-for-20% exchange would fire (S8-15): ${tally.specialExchanges}`,
          `company-boards carrying a Scenario-D other-20 certificate: ${tally.doubleBoards}`,
          `stored SellStock entries re-judged by the S9-14 gate: ${tally.salesChecked}, newly refused: ${tally.newlyRefused.length}`,
          `legacy-vs-repaired disagreements: ${tally.disagreements.length}`,
          ...tally.changeList.map((row) => `  change ${row}`),
          ...tally.tieBoards.map((row) => `  tie ${row}`),
          ...tally.specialList.map((row) => `  special-exchange ${row}`),
          ...tally.newlyRefused.map((row) => `  newly-refused ${row}`),
        ].join("\n"),
      );
      expect(tally.entries).toBeGreaterThan(0);
      expect(tally.boards).toBeGreaterThan(0);
    });

    it("contains no board on which the pre-8.3 rule and the clockwise rule disagree", () => {
      /* THE ASSERTION THE VERSION POLICY RESTS ON. Every stored log rebuilds to the same president at every
         entry, so every state digest and every golden is unchanged by this slice -- which is why Slice 8.3
         bumps nothing and Slice 8.5 still owes the one Stage-8 bump.
         A FAILURE HERE IS NOT A REPIN. It names the file, the entry, both answers, the holdings and the
         seating, because the only correct response is to read that board and decide which rule it proves. */
      expect(tally.disagreements).toEqual([]);
    });

    it("contains no tied-challenger board at all, which is why the above is free", () => {
      /* The design pass's prediction, measured: every historical presidency change has exactly one
         challenger. If a future log contains a tie this case is the one that tells you -- and it is then the
         disagreement case above, not this one, that decides whether anything moved. */
      expect(tally.tieBoards).toEqual([]);
    });

    it("contains no board on which the Scenario-D card exchange fires (S8-15)", () => {
      /* The card half's corpus evidence, measured the same way as the selection half's: no stored log has a
         presidency change on the ERIE or the N&W at all, let alone one where the successor holds the printed
         other-20 without two ordinary 10%s. So #1622 rewrites no stored `double_certificate` and the slice
         stays digest-neutral on both halves. */
      expect(tally.specialList).toEqual([]);
    });

    it("has no stored sale that the S9-14 gate would newly refuse (#1624)", () => {
      /* THE ONE WAY THIS SLICE COULD MOVE A STORED BOARD. A changed tie-break only matters on a tie, and
         there are none; a new REFUSAL matters wherever the sale exists. Zero here is what lets Slice 8.3
         leave every digest and every golden alone -- and a failure names the file, the entry, the seller and
         the bundle, which is the board to read before anything is repinned. */
      expect(tally.newlyRefused).toEqual([]);
      /* The control: a sweep that re-judged no sales would satisfy the line above vacuously. */
      expect(tally.salesChecked).toBeGreaterThan(0);
    });

    it("has at least one presidency change to have proven anything about", () => {
      /* The control. A sweep of logs in which no crown ever moves would satisfy every case above vacuously. */
      expect(tally.changes).toBeGreaterThan(0);
    });
  }
});
