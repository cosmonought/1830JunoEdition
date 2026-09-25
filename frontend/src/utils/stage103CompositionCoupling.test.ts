/** @jest-environment node */
//
// ==================================================================
//  STAGE 10.3 (S10-4) -- COMPOSITION COUPLING (design note #1690)
// ==================================================================
//
// `App.tsx` and `RoomEngine` each assembled the reducer's `SandboxActionContext` on their own: the engine from
// `sandboxReplayProviders()`, the shell from inline closures that mirrored it. This file pins the slice that
// ended that:
//
//   A. THE ALL-PASS THROUGH THE REAL ENGINE (the regression #1281 was, owed since S10-4 was filed). A pinned
//      log -- dealt, one private bought, then the table passes -- is replayed through `replayLog` / `RoomEngine`
//      under the SERVER's policy, and the private income is asserted on the players AND on the Bank.
//   B. THE SHARED COMPOSITION IS THE OLD SHELL'S, BEHAVIOURALLY. The pre-10.3 shell context is transcribed
//      here as an oracle (verbatim from `App.tsx` at f8ff424, market refs read as the handed board's chart,
//      which is what the shell's refs held), and every stored entry of the corpus is reduced under it and under
//      `sandboxActionContext` from the same inputs. Plus field-level characterisations for the sale, the
//      dividend, the par, the home lookup and the lay geometry.
//   C. THE NARRATION ASKS THE REDUCER'S AUTHORITY. `sandboxChartStepReport` against the old shell report for
//      the cases where they differed: a sale the reducer refuses, a dividend it refuses, and the Blood Price.
//   D. SOURCE: the shell calls the shared builders and no longer carries the transcription.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { GameplayExecuteMsg } from "./sessionKey";
// Stage 10.5 (S10-9): the corpus observer hands the log-wide message type.
import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { SandboxActionContext, SandboxMarketContext } from "../gameEngine/sandboxSession";
import {
  applySandboxAction,
  applySandboxMarketAction,
  isCarcosanTransfer,
  sandboxChartStepReport,
} from "../gameEngine/sandboxSession";
import {
  layAuthorityContext,
  layGeometryFor,
  parValueFromMessage,
  sandboxActionContext,
} from "../gameEngine/actionContext";
import { boardLayRefused, sandboxReplayProviders } from "../gameEngine/replayProviders";
import { entriesFromExport, replayLog, type ExportedEntry, type ReplayEntry } from "../gameEngine/replayLog";
import {
  DEVELOPMENT_CORPUS_POLICY,
  RULES_ENGINE_VERSION,
  SERVER_REPLAY_POLICY,
  replayCompatibility,
} from "../gameEngine/rulesVersion";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxMarketPositions,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { canonicalJson, stateDigest } from "../gameEngine/stateDigest";
import { moneyTotal } from "../gameEngine/cashLedger";
import {
  marketZoneForPrice,
  parBoxCellFor,
  projectBloodPriceMove,
  projectDividendCellMove,
  projectRiseMove,
  projectShareSaleMove,
} from "../gameEngine/marketGeometry";
import { dividendStepsFor, resolveVariants } from "../gameEngine/gameVariants";
import { eraForPhase, tileEraFor } from "../gameEngine/gameConstants";
import { derivePhase } from "../gameEngine/gamePhase";
import { withRules } from "../gameEngine/boardSelection";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { shareSaleBlock } from "../gameEngine/shareSale";
import { dividendRefused } from "../gameEngine/dividendGate";
import { describeAuctionTransition } from "./auctionTransition";
import { RoomSession } from "./roomSession";
import { readStripped, sliceBetween } from "./sourceScan";
import { operatingBoard, stockRoundBoard, P1, P2, PRR, NYC } from "./offerFixtures74";
import { withCorp, withState, M } from "./offerMatrix74Support";

const seed = () => ({
  state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});
const cashOf = (state: GameStateResponse, player: string) =>
  Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp ?? NaN);
const bankOf = (state: GameStateResponse) => Number(state.virtual_bank_vgp);
const EMPTY_GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

/* ================================================================================================= */
/* A. THE ALL-PASS, THROUGH THE ENGINE                                                                */
/* ================================================================================================= */

describe("A. an all-pass private auction pays private income through the real engine (#1281, S10-4)", () => {
  const ALICE = "p-alice";
  const BOB = "p-bob";

  /** Played LIVE through `RoomSession.submit` (the server's path, which stamps the rules version), so the log
   *  is exactly what a server would store; then replayed from that log alone. */
  function playedRoom() {
    let n = 0;
    const room = new RoomSession({
      providers: sandboxReplayProviders(),
      seed: seed(),
      build: "b-103",
      mintId: () => `id${(n += 1)}`,
    });
    const submit = (actor: string, msg: unknown) => {
      const frame = room.submit({ actor, build: "b-103", msg: msg as never, baseIndex: room.nextIndex - 1 });
      expect(frame.kind).toBe("applied");
    };
    submit(ALICE, {
      SetupGame: { players: [{ id: ALICE, nickname: "Alice" }, { id: BOB, nickname: "Bob" }], variants: { delayedAuction: false } },
    });
    const buyer = room.state.waterfall?.current_turn as string;
    submit(buyer, { WaterfallBuyLowest: { game_id: 0 } });
    submit(room.state.waterfall?.current_turn as string, { WaterfallPass: { game_id: 0 } });
    submit(room.state.waterfall?.current_turn as string, { WaterfallPass: { game_id: 0 } });
    return { room, buyer };
  }

  it("replays the stored log under the SERVER policy and pays the owner from the Bank on the all-pass", () => {
    const { room, buyer } = playedRoom();
    const entries: ReplayEntry[] = room.entries.map((entry) => ({ ...entry }));
    expect(entries.map((entry) => Object.keys(JSON.parse(entry.payload))[0])).toEqual([
      "SetupGame",
      "WaterfallBuyLowest",
      "WaterfallPass",
      "WaterfallPass",
    ]);

    // Pinned by the room at the deal, so the server policy admits it and no legacy adapter runs.
    expect(replayCompatibility(entries)).toEqual({ kind: "compatible", version: RULES_ENGINE_VERSION });
    // Every engine application, observed where the reducer is handed the board.
    const seen: Array<{ key: string; before: GameStateResponse }> = [];
    const result = replayLog(
      entries,
      sandboxReplayProviders(),
      seed(),
      ({ msg, stateBefore }) => seen.push({ key: Object.keys(msg)[0], before: stateBefore }),
      SERVER_REPLAY_POLICY, // a pinned log: no development adapters, exactly the server's rebuild
    );
    expect(result.applied).toBe(4);
    expect(seen.map((row) => row.key)).toEqual(["SetupGame", "WaterfallBuyLowest", "WaterfallPass", "WaterfallPass"]);

    const beforeAllPass = seen[3].before;
    const after = result.state;
    const owned = beforeAllPass.private_companies.filter((entry) => entry.owner === buyer && entry.closed !== true);
    expect(owned.length).toBe(1);
    const income = owned.reduce((sum, entry) => sum + Number(entry.revenue_per_or ?? 0), 0);
    expect(income).toBeGreaterThan(0);

    // The all-pass is recognised as one, with the owner's payout named.
    const pass = { WaterfallPass: { game_id: 0 } } as GameplayExecuteMsg;
    const transition = describeAuctionTransition(beforeAllPass, after, pass);
    expect(transition.allPassed).toBe(true);
    expect(transition.payouts.some((payout) => payout.toPlayer === buyer && payout.amount === income)).toBe(true);

    // Private income paid: the owner up by exactly the income, the Bank down by exactly the same.
    expect(cashOf(after, buyer)).toBe(cashOf(beforeAllPass, buyer) + income);
    expect(bankOf(after)).toBe(bankOf(beforeAllPass) - income);
    const other = after.player_addresses.find((player) => player !== buyer) as string;
    expect(cashOf(after, other)).toBe(cashOf(beforeAllPass, other));
    expect(moneyTotal(after)).toBe(moneyTotal(beforeAllPass));

    // The replay and the live room are the same composition: one state, byte for byte.
    expect(canonicalJson(after)).toBe(canonicalJson(room.state));
  });

  it("the engine reaches the reducer only through the shared composition", () => {
    const ENGINE = readStripped("gameEngine/replayLog.ts");
    const apply = sliceBetween(ENGINE, "private applyOnBoard(", "private readonly emitted");
    expect(apply).toContain("this.state = applySandboxAction(\n    this.state,\n    msg,\n    sandboxActionContext(this.providers, {");
    expect(apply.split("applySandboxAction(").length - 1).toBe(1);
    // #1340: and no auction composition survives beside it (the #1281 class, closed by construction).
    expect(ENGINE).not.toContain("applyPrivateRevenue(");
    expect(ENGINE).not.toContain("applySandboxWaterfallAction(");
  });
});

/* ================================================================================================= */
/* B. THE SHARED COMPOSITION IS THE OLD SHELL'S, BEHAVIOURALLY                                        */
/* ================================================================================================= */

/** THE ORACLE: `App.tsx`'s reducer context at f8ff424, transcribed. The shell's market refs are read as the
 *  handed board's `market_positions` -- the shell set `after.market_positions = sandboxMarketRef.current` on
 *  the line before this call, so that IS what they held. `before` is the handed board without its mirrors; the
 *  closures below read only its companies and variants, which the mirrors do not touch. */
function legacyShellContext(
  handed: GameStateResponse,
  msg: SandboxLogMsg,
  actor: string | null | undefined,
  grid: MapGridResponse,
  gridBefore: MapGridResponse,
): SandboxActionContext {
  const before = handed;
  const ref = handed.market_positions ?? {};
  const marketPriceForCompany = (companyId: number): number | null => ref[companyId]?.price ?? null;
  const rulesBeforeAction = resolveVariants(handed.variants);
  const phaseBeforeAction = derivePhase(handed);
  return {
    actor: actor ?? undefined,
    marketContext: {
      projectSale: (from, blocks) => projectShareSaleMove(from, blocks),
      projectBloodPrice: (from) => projectBloodPriceMove(from),
      projectDividend: (from, choice) => {
        const declaring =
          "DeclareDividends" in msg
            ? before?.public_companies.find((entry) => entry.company_id === msg.DeclareDividends.protocol_id)
            : undefined;
        const payout = Number(declaring?.last_route_revenue ?? 0) || 0;
        const steps = dividendStepsFor(
          payout,
          marketPriceForCompany(declaring?.company_id ?? -1),
          resolveVariants(before?.variants),
          choice,
        );
        return projectDividendCellMove(from, choice, steps);
      },
      // Accepted by the pre-10.3 type; the reducer now asks its own (#1690) and ignores any caller's.
      isCarcosanSale: (sellerId: number, modelType: string) => isCarcosanTransfer(before, sellerId, modelType),
    } as NonNullable<SandboxActionContext["marketContext"]>,
    parCellFor: parBoxCellFor,
    mapGrid: grid,
    era: tileEraFor(handed),
    marketPriceFor: marketPriceForCompany,
    marketZoneFor: (companyId: number) => marketZoneForPrice(marketPriceForCompany(companyId)),
    marketPricesByCompany: Object.fromEntries(
      sandboxMarketPositions(ref).map((entry) => [entry.company_id, Number(entry.price)]),
    ),
    zoneForPrice: marketZoneForPrice,
    marketMarkFor: (companyId: number) => ref[companyId] ?? null,
    projectRise: (from) => projectRiseMove(from),
    parValue: (() => {
      if (!("BuyStock" in msg)) return undefined;
      const fromMsg = Number(msg.BuyStock.par_value ?? NaN);
      return Number.isFinite(fromMsg) && fromMsg > 0 ? fromMsg : undefined;
    })(),
    homeHexToAxial: (label: string) => {
      const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
      return hex ? ([hex.q, hex.r] as const) : null;
    },
    layRefused: (q: number, r: number, tileId: number, orientation: number) =>
      withRules(rulesBeforeAction, () =>
        boardLayRefused(gridBefore, q, r, tileId, orientation, eraForPhase(phaseBeforeAction, rulesBeforeAction)),
      ),
  };
}

/** The shell's pre-10.3 market SENTENCE: its own context, with `shareSaleBlock` and no holds (f8ff424). */
function legacyShellReport(handed: GameStateResponse, msg: SandboxLogMsg, actor: string | null | undefined) {
  const legacy = legacyShellContext(handed, msg, actor, EMPTY_GRID, EMPTY_GRID).marketContext as SandboxMarketContext;
  return applySandboxMarketAction(handed.market_positions ?? {}, msg, {
    ...legacy,
    dividendRefused: (companyId) => dividendRefused(handed, companyId),
    saleRefused: (companyId, percentage) => {
      const seller = actor ?? null;
      if (!seller) return false;
      return shareSaleBlock({ state: handed, seller, companyId, percentage }) !== null;
    },
  }).moved;
}

const UTILS = __dirname;
const jsonl = (file: string): ExportedEntry[] =>
  readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as ExportedEntry);
const exportedRows = (file: string): ExportedEntry[] => {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { actions?: ExportedEntry[]; entries?: ExportedEntry[] };
  return raw.actions ?? raw.entries ?? [];
};
/** The Stage-8 corpus convention (`stage85Closure.test.ts`): what the repository carries, plus the server and
 *  export logs where the checkout has them. */
function corpus(): Array<{ name: string; entries: ExportedEntry[] }> {
  const out: Array<{ name: string; entries: ExportedEntry[] }> = [];
  const frozen = join(UTILS, "__fixtures__", "replayGolden", "logs");
  const server = join(UTILS, "..", "..", "..", "server", "data");
  const exports = join(UTILS, "..", "..");
  for (const file of readdirSync(frozen).filter((f) => f.endsWith(".log.jsonl")).sort()) out.push({ name: `golden/${file}`, entries: jsonl(join(frozen, file)) });
  if (existsSync(server)) {
    for (const file of readdirSync(server).filter((f) => f.endsWith(".log.jsonl")).sort()) out.push({ name: `server/${file}`, entries: jsonl(join(server, file)) });
  }
  for (const file of readdirSync(exports).filter((f) => /^sandbox-log-JUNO-.*\.json$/.test(f)).sort()) {
    out.push({ name: `export/${file}`, entries: exportedRows(join(exports, file)) });
  }
  out.push({ name: "prefix/JUNO-FCJ-96", entries: jsonl(join(UTILS, "__fixtures__", "JUNO-FCJ-prefix96.log.jsonl")) });
  out.push({ name: "fixture/JUNO-Z6C-494", entries: exportedRows(join(UTILS, "__fixtures__z6cLog.json")) });
  return out;
}

describe("B. the shared composition and the pre-10.3 shell composition reduce every stored entry alike", () => {
  const providers = sandboxReplayProviders();
  const rows = corpus().map(({ name, entries }) => {
    let reduced = 0;
    let differing = 0;
    let engineDisagrees = 0;
    let reportsChecked = 0;
    let reportDisagrees = 0;
    let legacyNarratedUnmade = 0;
    let lastGrid: MapGridResponse | null = null;
    let pending: { shared: string } | null = null;
    replayLog(
      entriesFromExport(entries),
      providers,
      seed(),
      ({ entry, msg, stateBefore, grid }) => {
        // The engine's own next board must be what the shared composition produced for the previous entry.
        if (pending !== null && canonicalJson(stateBefore) !== pending.shared) engineDisagrees += 1;
        /* The grid before this entry's lay step is the grid the previous application was handed (the reducer
           never writes the grid); on the deal the grid is re-opened and there is no lay to judge. */
        const gridBefore = lastGrid ?? grid;
        lastGrid = grid;
        const shared = sandboxActionContext(providers, { state: stateBefore, msg, actor: entry.actor, grid, gridBefore });
        const legacy = legacyShellContext(stateBefore, msg, entry.actor, grid, gridBefore);
        const viaShared = applySandboxAction(stateBefore, msg, shared);
        const viaLegacy = applySandboxAction(stateBefore, msg, legacy);
        reduced += 1;
        if (canonicalJson(viaShared) !== canonicalJson(viaLegacy)) differing += 1;
        pending = { shared: canonicalJson(viaShared) };

        // C, over the whole corpus: the shell's sentence may only name a move the reducer made.
        const report = sandboxChartStepReport(stateBefore, msg, shared);
        if (report !== null) {
          reportsChecked += 1;
          const landed = viaShared.market_positions?.[report.companyId]?.price ?? null;
          const was = stateBefore.market_positions?.[report.companyId]?.price ?? null;
          if (landed !== report.to || was !== report.from) reportDisagrees += 1;
        }
        const old = legacyShellReport(stateBefore, msg, entry.actor);
        if (old !== null && canonicalJson(viaShared.market_positions) === canonicalJson(stateBefore.market_positions)) {
          legacyNarratedUnmade += 1;
        }
      },
      DEVELOPMENT_CORPUS_POLICY,
    );
    return { name, reduced, differing, engineDisagrees, reportsChecked, reportDisagrees, legacyNarratedUnmade };
  });

  it("covers the in-repository corpus at least (goldens, FCJ-96, Z6C-494)", () => {
    const names = rows.map((row) => row.name);
    for (const required of ["golden/JUNO-7NZ.log.jsonl", "golden/JUNO-CV4.log.jsonl", "golden/JUNO-G6J.log.jsonl", "prefix/JUNO-FCJ-96", "fixture/JUNO-Z6C-494"]) {
      expect(names).toContain(required);
    }
    expect(rows.reduce((sum, row) => sum + row.reduced, 0)).toBeGreaterThan(700);
  });

  it("no entry reduces differently under the shared composition than under the old shell's", () => {
    expect(rows.filter((row) => row.differing > 0).map((row) => [row.name, row.differing])).toEqual([]);
  });

  it("and the engine's own next board is the shared composition's result, entry after entry", () => {
    expect(rows.filter((row) => row.engineDisagrees > 0).map((row) => [row.name, row.engineDisagrees])).toEqual([]);
  });

  it("C. the shell's market sentence never names a move the reducer did not make, in any stored game", () => {
    expect(rows.reduce((sum, row) => sum + row.reportsChecked, 0)).toBeGreaterThan(0);
    expect(rows.filter((row) => row.reportDisagrees > 0).map((row) => [row.name, row.reportDisagrees])).toEqual([]);
  });

  it("(the old sentence did, wherever the corpus has a held or round-refused sale -- reported, not required)", () => {
    // Informational: the in-repository files carry none; server/JUNO-FCJ carries the #1613 held sales.
    const total = rows.reduce((sum, row) => sum + row.legacyNarratedUnmade, 0);
    expect(total).toBeGreaterThanOrEqual(0);
    // eslint-disable-next-line no-console
    console.log(
      "[stage103] legacy narration of unmade moves:",
      rows.filter((row) => row.legacyNarratedUnmade > 0).map((row) => `${row.name}=${row.legacyNarratedUnmade}`).join(", ") || "none",
    );
  });
});

describe("B. field by field: the injections authoritative outcomes depend on", () => {
  const providers = sandboxReplayProviders();
  const cv4 = jsonl(join(UTILS, "__fixtures__", "replayGolden", "logs", "JUNO-CV4.log.jsonl"));
  /** A mid-game CV4 board with a chart: the state handed to the reducer at the first `DeclareDividends`. */
  const probe = (() => {
    let found: { state: GameStateResponse; msg: GameplayExecuteMsg; grid: MapGridResponse; actor: string } | null = null;
    replayLog(
      entriesFromExport(cv4),
      providers,
      seed(),
      ({ entry, msg, stateBefore, grid }) => {
        if (found === null && "DeclareDividends" in msg) found = { state: stateBefore, msg, grid, actor: entry.actor };
      },
      DEVELOPMENT_CORPUS_POLICY,
    );
    return found as unknown as { state: GameStateResponse; msg: GameplayExecuteMsg; grid: MapGridResponse; actor: string };
  })();
  const shared = sandboxActionContext(providers, { state: probe.state, msg: probe.msg, actor: probe.actor, grid: probe.grid, gridBefore: probe.grid });
  const legacy = legacyShellContext(probe.state, probe.msg, probe.actor, probe.grid, probe.grid);
  const marks = Object.entries(probe.state.market_positions ?? {}).filter(([, mark]) => mark);

  it("the dividend: the same projection for a pay and for a withhold", () => {
    const declaring = (probe.msg as { DeclareDividends: { protocol_id: number } }).DeclareDividends.protocol_id;
    const from = probe.state.market_positions?.[declaring];
    expect(from).toBeTruthy();
    for (const choice of ["pay", "withhold"] as const) {
      expect(shared.marketContext?.projectDividend?.(from!, choice)).toEqual(legacy.marketContext?.projectDividend?.(from!, choice));
    }
  });

  it("the sale and the Blood Price: the same geometry from every chart mark", () => {
    expect(marks.length).toBeGreaterThan(0);
    for (const [, mark] of marks) {
      for (const blocks of [1, 2, 3]) {
        expect(shared.marketContext?.projectSale?.(mark!, blocks)).toEqual(legacy.marketContext?.projectSale?.(mark!, blocks));
      }
      expect(shared.marketContext?.projectBloodPrice?.(mark!)).toEqual(legacy.marketContext?.projectBloodPrice?.(mark!));
      expect(shared.projectRise?.(mark!)).toEqual(legacy.projectRise?.(mark!));
    }
  });

  it("the chart resolvers: the same price, zone, mark and certificate-zone table", () => {
    for (const [id] of marks) {
      const companyId = Number(id);
      expect(shared.marketPriceFor?.(companyId)).toBe(legacy.marketPriceFor?.(companyId));
      expect(shared.marketZoneFor?.(companyId)).toBe(legacy.marketZoneFor?.(companyId));
      expect(shared.marketMarkFor?.(companyId)).toEqual(legacy.marketMarkFor?.(companyId));
      // The two tables differ only in spelling an absent mark (`null` vs omitted); every reader treats both alike.
      expect(marketZoneForPrice(shared.marketPricesByCompany?.[companyId])).toBe(marketZoneForPrice(legacy.marketPricesByCompany?.[companyId]));
    }
    expect(shared.era).toBe(legacy.era);
  });

  it("the par: the same box for every ladder price, and the message's own par", () => {
    for (const par of [67, 71, 76, 82, 90, 100]) expect(shared.parCellFor?.(par)).toEqual(legacy.parCellFor?.(par));
    const buy = { BuyStock: { game_id: 1, protocol_id: 3, source: "Ipo", par_value: "82" } } as unknown as GameplayExecuteMsg;
    expect(parValueFromMessage(buy)).toBe(82);
    expect(sandboxActionContext(providers, { state: probe.state, msg: buy, actor: "x", grid: probe.grid, gridBefore: probe.grid }).parValue).toBe(
      legacyShellContext(probe.state, buy, "x", probe.grid, probe.grid).parValue,
    );
    for (const bad of [null, "0", "-5", "abc"]) {
      const msg = { BuyStock: { game_id: 1, protocol_id: 3, source: "Ipo", par_value: bad } } as unknown as GameplayExecuteMsg;
      expect(parValueFromMessage(msg)).toBeUndefined();
    }
    expect(parValueFromMessage(probe.msg)).toBeUndefined();
  });

  it("the home station: the same label table for every hex the board prints", () => {
    for (const hex of STATIC_BOARD_HEXES) {
      expect(shared.homeHexToAxial?.(hex.label)).toEqual(legacy.homeHexToAxial?.(hex.label));
    }
    expect(shared.homeHexToAxial?.("no-such-hex")).toBeNull();
    expect(layAuthorityContext(providers, probe.state, probe.grid).homeHexToAxial?.("H14")).toEqual(legacy.homeHexToAxial?.("H14"));
  });

  it("the lay geometry: the same verdict for every catalogue lay on a sample of hexes, both builders", () => {
    const geometry = layGeometryFor(providers, probe.grid, probe.state);
    const viaAuthority = layAuthorityContext(providers, probe.state, probe.grid).layRefused!;
    let asked = 0;
    let refused = 0;
    for (const hex of STATIC_BOARD_HEXES.filter((_, index) => index % 7 === 0)) {
      for (const tileId of [7, 8, 9, 57, 58, 14, 15, 16, 19, 23, 24, 25]) {
        for (const orientation of [0, 1, 2, 3, 4, 5]) {
          const expected = legacy.layRefused!(hex.q, hex.r, tileId, orientation);
          expect(shared.layRefused!(hex.q, hex.r, tileId, orientation)).toBe(expected);
          expect(geometry(hex.q, hex.r, tileId, orientation)).toBe(expected);
          expect(viaAuthority(hex.q, hex.r, tileId, orientation)).toBe(expected);
          asked += 1;
          if (expected) refused += 1;
        }
      }
    }
    // Both answers occur, so the equality is not vacuous.
    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThan(asked);
  });
});

/* ================================================================================================= */
/* C. THE NARRATION ASKS THE REDUCER'S REFUSAL AUTHORITIES                                            */
/* ================================================================================================= */

describe("C. the shell's market sentence asks the reducer's own chart step", () => {
  const providers = sandboxReplayProviders();
  const ctxFor = (state: GameStateResponse, msg: unknown, actor: string | null) =>
    sandboxActionContext(providers, { state, msg: msg as GameplayExecuteMsg, actor, grid: EMPTY_GRID, gridBefore: EMPTY_GRID });
  const reduce = (state: GameStateResponse, msg: unknown, actor: string | null) =>
    applySandboxAction(state, msg as GameplayExecuteMsg, ctxFor(state, msg, actor));
  const report = (state: GameStateResponse, msg: unknown, actor: string | null) =>
    sandboxChartStepReport(state, msg as GameplayExecuteMsg, ctxFor(state, msg, actor));

  it("stock sale: a sale outside a Stock Round -- the old `shareSaleBlock` passed it and the old sentence moved the token", () => {
    const board = operatingBoard();
    const sale = M.sellStock(NYC, 10);
    expect(shareSaleBlock({ state: board, seller: P2, companyId: NYC, percentage: 10 })).toBeNull();
    expect(legacyShellReport(board, sale as GameplayExecuteMsg, P2)).not.toBeNull(); // the pre-10.3 defect
    expect(stateDigest(reduce(board, sale, P2))).toBe(stateDigest(board)); // the reducer refuses it
    expect(report(board, sale, P2)).toBeNull(); // and the sentence now says nothing
  });

  it("stock sale: a legal sale -- the sentence names exactly the move the reducer made", () => {
    const board = stockRoundBoard();
    const sale = M.sellStock(PRR, 10);
    const after = reduce(board, sale, P1);
    const moved = report(board, sale, P1);
    expect(moved).not.toBeNull();
    expect(moved!.reason).toBe("sale");
    expect(after.market_positions?.[PRR]?.price).toBe(moved!.to);
    expect(board.market_positions?.[PRR]?.price).toBe(moved!.from);
  });

  it("dividend: a declaration the reducer refuses moves nothing and is narrated as nothing", () => {
    const board = withCorp(operatingBoard({ step: "Hardware" }), PRR, { last_route_revenue: "80" });
    const withhold = { DeclareDividends: { game_id: 1, protocol_id: PRR, distribute: false } };
    expect(dividendRefused(board, PRR)).toBe(true);
    expect(stateDigest(reduce(board, withhold, P1))).toBe(stateDigest(board));
    expect(report(board, withhold, P1)).toBeNull();
    // Parity with the old sentence here: both asked `dividendRefused` of the same board.
    expect(legacyShellReport(board, withhold as GameplayExecuteMsg, P1)).toBeNull();
  });

  it("dividend: whatever the reducer does with a declaration, the sentence agrees with it", () => {
    for (const step of ["Dividends", "Hardware", "Routes"]) {
      for (const distribute of [true, false]) {
        const board = withCorp(operatingBoard({ step }), PRR, { last_route_revenue: "80" });
        const msg = { DeclareDividends: { game_id: 1, protocol_id: PRR, distribute } };
        const after = reduce(board, msg, P1);
        const moved = report(board, msg, P1);
        if (moved === null) {
          expect(after.market_positions?.[PRR]).toEqual(board.market_positions?.[PRR]);
        } else {
          expect(after.market_positions?.[PRR]?.price).toBe(moved.to);
        }
      }
    }
  });

  describe("the Blood Price (#1090): the composition drift 10.3 found", () => {
    /** PRR (P1) buying NYC's gilded 3-train at its Purchase Trains step; P1 presides over both, so the sale needs
     *  no offer (#1592's same-president direct buy). */
    const gilded = (patch: Record<string, unknown> = {}) =>
      withState(withCorp(withCorp(operatingBoard({ step: "Hardware" }), NYC, { president: P1, carcosan_trains: ["3"] }), PRR, {}), patch);
    const sale = M.buyTrain(PRR, NYC, "3", "150");

    it("the server's composition now charges it: the BUYER's token moves Left 1, Down 1 on a legal transfer", () => {
      /* UR-4 (OD-UR-5(b), backlog D-50): the mover is the BUYER (PRR); the seller (NYC) does not move (UR-F22). Until
         UR-4 this case pinned #1090's seller move. */
      const board = gilded();
      expect(isCarcosanTransfer(board, NYC, "3")).toBe(true);
      const mark = board.market_positions![PRR]!;
      const landed = projectBloodPriceMove(mark);
      expect(landed).not.toBeNull();
      const after = reduce(board, sale, P1);
      expect(after.public_companies.find((entry) => entry.company_id === PRR)?.owned_trains).toContain("3"); // it settled
      expect(after.market_positions?.[PRR]?.price).toBe(landed!.price);
      expect([after.market_positions?.[PRR]?.x, after.market_positions?.[PRR]?.y]).toEqual([landed!.x, landed!.y]);
      expect(after.market_positions?.[NYC]).toEqual(board.market_positions?.[NYC]); // the seller never moves
      // ...and the sentence names it.
      expect(report(board, sale, P1)).toEqual({ companyId: PRR, from: mark.price, to: landed!.price, reason: "bloodPrice" });
    });

    it("before 10.3 the providers' market context could not: it carried no `isCarcosanSale`", () => {
      const board = gilded();
      const providersOnly = providers.marketContext(board, sale as GameplayExecuteMsg, P1) as SandboxMarketContext;
      expect("isCarcosanSale" in providersOnly).toBe(false);
      expect(applySandboxMarketAction(board.market_positions!, sale as GameplayExecuteMsg, providersOnly).moved).toBeNull();
    });

    it("a Carcosan sale the core refuses moves nothing -- the old shell's mark-only predicate moved the token anyway", () => {
      for (const refused of [
        { board: gilded({ operating_sub_phase: "Tokens" }), actor: P1 }, // not the Purchase Trains step
        { board: withCorp(gilded(), NYC, { president: P2 }), actor: P1 }, // no consent: a different president, no offer
        { board: withCorp(gilded(), PRR, { treasury: "10" }), actor: P1 }, // the treasury cannot pay
      ]) {
        expect(stateDigest(reduce(refused.board, sale, refused.actor))).toBe(stateDigest(refused.board));
        expect(report(refused.board, sale, refused.actor)).toBeNull();
        expect(legacyShellReport(refused.board, sale as GameplayExecuteMsg, refused.actor)?.reason).toBe("bloodPrice");
      }
    });

    it("an ordinary train sale is untouched", () => {
      const board = withCorp(gilded(), NYC, { carcosan_trains: [] });
      const after = reduce(board, sale, P1);
      expect(after.public_companies.find((entry) => entry.company_id === PRR)?.owned_trains).toContain("3");
      expect(after.market_positions?.[NYC]).toEqual(board.market_positions?.[NYC]);
      expect(report(board, sale, P1)).toBeNull();
    });

    it("no caller can hand the chart its own Blood Price predicate any more", () => {
      const board = gilded({ operating_sub_phase: "Tokens" });
      const ctx = {
        ...ctxFor(board, sale, P1),
        marketContext: { ...providers.marketContext(board, sale as GameplayExecuteMsg, P1), isCarcosanSale: () => true },
      } as unknown as SandboxActionContext;
      expect(stateDigest(applySandboxAction(board, sale as GameplayExecuteMsg, ctx))).toBe(stateDigest(board));
    });
  });
});

/* ================================================================================================= */
/* D. SOURCE: THE SHELL USES THE SHARED COMPOSITION                                                   */
/* ================================================================================================= */

describe("D. App.tsx builds its reducer context from the shared composition, not inline", () => {
  const APP = readStripped("App.tsx");

  it("uses the engine's provider set and both shared builders", () => {
    expect(APP).toContain("const SHELL_PROVIDERS = sandboxReplayProviders();");
    expect(APP).toContain("sandboxActionContext(SHELL_PROVIDERS, {");
    expect(APP).toContain("layAuthorityContext(SHELL_PROVIDERS, stateBeforeAction, gridBeforeAction)");
    expect(APP).toContain("after = applySandboxAction(after, gameplay, reducerContext);");
    expect(APP).toContain("sandboxChartStepReport(handedBoard, gameplay, reducerContext)");
    // One reducer call in the shell, handed the shared context.
    expect(APP.split("applySandboxAction(").length - 1).toBe(1);
  });

  it("carries no transcription of the authority injections", () => {
    for (const transcribed of [
      "projectDividend: (from, choice) =>",
      "projectSale: (from, blocks) =>",
      "projectBloodPrice: (from) =>",
      "isCarcosanSale:",
      "saleRefused:",
      "dividendRefused:",
      "parCellFor: parBoxCellFor",
      "marketMarkFor: marketMarkForCompany",
      "applySandboxMarketAction(",
      "const layRefused = (q: number, r: number, tileId: number, orientation: number)",
      "boardLayRefused(",
    ]) {
      expect([transcribed, APP.includes(transcribed)]).toEqual([transcribed, false]);
    }
    const block = sliceBetween(APP, "const reducerContext =", "const marketResult = {");
    expect(block).not.toContain("parValue:");
    expect(block).not.toContain("projectRise"); // the sold-out rise's SENTENCE (narration) keeps its own call, below the reducer
    expect(block).not.toContain("homeHexToAxial");
  });

  it("the engine and the shell call the same two builders", () => {
    const ENGINE = readStripped("gameEngine/replayLog.ts");
    expect(ENGINE).toContain("layAuthorityContext(this.providers, stateBefore, gridBefore)");
    expect(ENGINE).toContain("sandboxActionContext(this.providers, {");
    expect(ENGINE).not.toContain("parValue: (() =>");
  });
});
