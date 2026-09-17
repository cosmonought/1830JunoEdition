// frontend/src/gameEngine/rulesVersion.ts
//
// The authoritative rules-engine version a game is dealt under, and whether this engine may replay it.
//
// ==================================================================
//  DESIGN NOTE 1520: THREE IDENTITIES, NOT ONE STRING
// ==================================================================
//
// THE PROBLEM BATCH 3 FOUND AND BATCH 4 CONFIRMED. A room is rebuilt from its log on every server restart,
// on every `RevertTo` (#1233) and on every rejoin after a restart, through `RoomSession.restore` ->
// `rebuild()` -> `RoomEngine.apply`. The reducer that rebuilds it is whichever reducer the running server
// carries. So a correction to the rules -- Batch 3 refusing a lay the log holds, Batch 4 sending a discard
// to the pool -- silently rewrote every stored game's board the next time it was loaded. Nothing pinned a
// game to the rules it was played under.
//
// THE THREE THINGS THAT WERE CONFLATED, kept apart from here on:
//
//   CLIENT BUILD (`CLIENT_BUILD_ID` / the server's `--build`, #1206, #1252). Which deployment a browser and a
//   server are. Answers "may these two talk" (build-skew: the state digest covers every field, so two builds
//   disagree about non-divergences) and "may this server continue this room" (the deal-build pin). It
//   changes on every deployment, CSS-only ones included, and in practice it is `"dev"` on both sides -- so
//   the pin has never held anything.
//
//   RULES REVISION (`variants.rules`, #1443). A per-table switch the reducer BRANCHES ON (`sellBuySellInForce`)
//   so that one reducer plays both the old and the new Stock Round. It is a house-rules field the client
//   stamps at the deal; the reducer supports every value of it at once. It is not a compatibility boundary.
//
//   RULES-ENGINE VERSION (this file). Which authoritative reducer a game's log is a program for. It changes
//   ONLY when a deployment makes stored gameplay logs mean something different -- a refusal an old log
//   would now meet, a state field an old log would now produce differently -- and never for a UI change.
//   The server stamps it into the deal; a game keeps it for life; and nothing replays a log this engine does
//   not explicitly support.
//
// A HAND-BUMPED INTEGER, ON PURPOSE. A git hash would bump on every commit and re-create the client-build
// problem under a new name; a package version would need a release process this project does not have. The
// number moves when somebody decides the semantics moved, and the changelog below is where they say why.
//
// WHERE IT LIVES: in the `SetupGame` entry of the log, as `rules_engine_version`, written BY THE SERVER over
// whatever the client sent (`RoomSession.submit`). The log is the one artifact every rebuild path reads
// first -- the file store, the CLI, the golden corpus, an export -- so the pin travels with the history and
// cannot be separated from it. It is read from the EFFECTIVE log (#1252's rule for the build): a deal that
// was reverted pins nothing, and the next deal pins afresh.
//
// LEGACY LOGS: every log written before this note carries no version. "Unversioned" is NOT read as "the
// current version" -- that would be the original fault with a new name. It is its own compatibility answer,
// `legacy`, and what to do with it is a POLICY the caller states: the server refuses (a production-style
// room is not reinterpreted because the field is missing); the development replay corpus opts in, by name,
// in the test files and the CLI that carry it (`DEVELOPMENT_CORPUS_POLICY`), which is a statement that those
// logs are replayed under today's reducer as fixtures, not a claim that they were ever pinned. A local
// server may take the same opt-in explicitly (`start.ts --legacy-logs development-corpus`), and says so at
// startup and on every room it admits. A deal pinned to a version this engine does not carry is refused
// under EVERY policy: the opt-in admits the unpinned, never the differently pinned.
//
// WHEN IT IS ASKED: once per rebuild, before the first `RoomEngine.apply` -- in `RoomSession.rebuild` (a
// restore, a `RevertTo`, a `discardAfter`) and in `replayLog` (the CLI, the golden corpus). A live reconnect
// to a room already in memory is a `catchUp` and rebuilds nothing, so it is not asked there; a held room
// answers `catchUp` with the same `incompatible` frame it answers `submit` with, so a client is never handed
// a history the server will not interpret.

import type { ReplayEntry } from "./replayLog";
import { effectiveActions } from "./logRevert";

/** The rules engine this build carries. Bump it, and add a line below, when a deployment changes what a
 *  stored log replays to. Do NOT bump it for UI, protocol or narration changes. */
export const RULES_ENGINE_VERSION = 5;

/** Every version this engine can replay faithfully. One entry until somebody builds a versioned reducer;
 *  the point of the list is that "supported" is an explicit statement rather than "whatever is running". */
export const SUPPORTED_RULES_ENGINE_VERSIONS: readonly number[] = [RULES_ENGINE_VERSION];

/** Why each version exists. The number is meaningless without this. */
export const RULES_ENGINE_CHANGELOG: ReadonlyArray<{ version: number; note: string }> = [
  {
    version: 1,
    note:
      "Batch 4.5 (2026-09-14): the first pinned engine. Includes Batch 3 (operating-corporation identity, " +
      "station legality in the authority) and Batch 4 (train availability with the Bank Pool, the mandatory " +
      "purchase gate, discards to the pool). Logs dealt before this are legacy: unversioned, and never " +
      "reinterpreted by a server.",
  },
  {
    version: 2,
    note:
      "Batch 4.6 (2026-09-14, #1530): automatic cheapest-first excess-train trimming at a phase change is " +
      "replaced by the president's explicit `DiscardTrain` actions (rulebook 6.6.1: the president chooses; " +
      "highest share value decides first; the train goes to the Bank Pool). A version-1 log carries no such " +
      "choices -- its excess trains were removed by the reducer, not by an entry -- so it is not replay-" +
      "compatible with this semantics and is refused, never reinterpreted.",
  },
  {
    version: 3,
    note:
      "Batch 5 (2026-09-14, #1540): the forced train purchase is an interactive, derived obligation " +
      "(rulebook 6.6.2/6.6.3/6.7). The president's contribution is authoritative (the corporation spends " +
      "all its money, the president covers the difference); forced stock sales are the ordinary SellStock " +
      "under 6.6.3's rules (the rescued corporation's presidency may not change; only enough is sold; no " +
      "sale once treasury and cash cover the price); bankruptcy is derived when no legal forced sale " +
      "remains and ends the game at once (`GameEnd`, `bankrupt_president`); the bankrupt player is scored " +
      "by the shares he could not sell and may win; ordinary play is held while the obligation stands and " +
      "after the end. No new message type. A version-2 log has no forced sales, no president-only " +
      "authority on the emergency purchase and no reducer-recorded ending, so it is refused, never " +
      "reinterpreted.",
  },
  {
    version: 4,
    note:
      "Batch 6 (2026-09-15, #1550-#1553): routes and revenue are authoritative. `RunMultipleRoutes` is " +
      "judged by the engine's route evaluator (`routeAuthority.ts`, rulebook 6.4/6.4.1/6.4.2/6.3.3/6.5): " +
      "every train named must be the corporation's, named once, no more routes than trains; each route is " +
      "re-walked on the board's rail model (continuous, no reversal at a junction, no crossover change, no " +
      "track reused within or between the corporation's routes, full cities not run through, red areas " +
      "terminal only, a station of the corporation on the route, no city counted twice, at least two " +
      "cities, no more than the train's number; a route begins and ends at any city -- large, small (a town) " +
      "or a red area, per 6.4 / 6.4.2, S6-10); a run worth less than the combination the route search " +
      "demonstrates for the same fleet is refused (6.4, S6-3 -- a lower bound, never a ceiling); revenue is " +
      "the evaluator's, never the message's; one run per turn. `DeclareDividends.revenue_amount` must equal `last_route_revenue` (audit C1). At Run " +
      "Trains, a skip or end of turn is refused while a paying route exists. `RunManualRoute` is refused on " +
      "a pinned board (legacy replay only). `SetupGame` copies the pin onto the state " +
      "(`rules_engine_version`). A version-3 log carries runs the reducer priced without judging and " +
      "dividends it paid from the message, so it is refused, never reinterpreted.",
  },
  {
    version: 5,
    note:
      "Batch 7 (7.1-7.5, 2026-09-15/16, #1560-#1598): transactions, cash and the auction are authoritative. " +
      "7.1: one money ledger (`cashLedger.ts`) -- no floored adjuster mints or destroys money; auction " +
      "proceeds and terrain fees are credited to the Bank; the Bank is signed and `bank_broken` is latched by " +
      "the debit that empties it and never cleared by a receipt; a purchase the payer cannot cover is refused. " +
      "7.2: `BuyStock` / `SellStock` are Stock Round actions (the 6.6.3 forced sale excepted); the IPO price " +
      "is the corporation's par and the pool price the chart's; the President's Certificate needs a ladder " +
      "par; an undeliverable source is refused; first-Stock-Round and unparred sales are refused; the Brown " +
      "continuation names `bought_this_turn_company`. 7.3: no bid on the lowest private; escrow-aware bids " +
      "and a $5 minimum raise; the main rotation is frozen during a contest; a contest pass keeps the bidder " +
      "(`passes_since_raise`); the all-pass markdown is the Schuylkill Valley's alone and private income is " +
      "paid only once the SV has sold; a refused auction message is refused whole. 7.4: one ordinary offer " +
      "at a time under a global hold; corporate private purchases, intercorporate train sales and the " +
      "player-to-player private trade are judged at proposal, answer and settlement, with consent and " +
      "counterparties re-derived from the board; direct unconsented settlements are refused; every ordinary " +
      "offer carries a log-derived `instance` (`offer_serial`) that keys its derived settlement; " +
      "`BidOnPrivate` and the `AcceptTrainOffer` family are refused on pinned boards. A version-4 log carries " +
      "purchases, auction steps and settlements the reducer let through without these rules, so it is " +
      "refused, never reinterpreted.",
  },
];

/** The log's SetupGame field. Named apart from `build` (client identity) and `variants.rules` (a house-rules
 *  revision the reducer branches on) because it is neither. */
export const RULES_ENGINE_VERSION_FIELD = "rules_engine_version";

export type ReplayCompatibility =
  /** The deal names a version this engine supports. */
  | { kind: "compatible"; version: number }
  /** The deal names a version this engine does not support. */
  | { kind: "incompatible"; version: number; supported: readonly number[] }
  /** The deal carries no version: written before #1520. */
  | { kind: "legacy" }
  /** No deal stands in the effective log -- nothing to be compatible with yet. */
  | { kind: "undealt" };

/** How a caller treats a log that predates the pin. Stated, never defaulted to "allow". */
export interface ReplayPolicy {
  legacyLogs: "refuse" | "development-corpus";
  /** #1530: what a LEGACY log's excess trains mean -- BEST-EFFORT DEVELOPMENT-CORPUS COMPATIBILITY, NOT
   *  HISTORICAL-FIDELITY REPLAY, AND DEVELOPMENT-ONLY. Every log before version 2 was played on an engine that
   *  removed excess trains itself, cheapest-first, and wrote no entry for it, so the log is silent exactly
   *  where version 2 expects a `DiscardTrain`. `"engine-chose-cheapest"` has `replayLog` supply that one
   *  choice, as `DiscardTrain` entries applied through today's arm and appended nowhere, so the golden and
   *  replay fixtures can still be read end to end. It does NOT make the replay faithful to the engine that
   *  played the log: every other version-2 rule (the limit judged in force at the purchase, the pool counting
   *  toward the phase) still applies, and a legacy log can diverge from its own play for those reasons
   *  (JUNO-FCJ, index 474). `"refuse"` -- the default, and the only value the server ever carries -- leaves
   *  the obligation standing, where it blocks the rest of the log; that is what "not replay-compatible"
   *  means. Only consulted for a `legacy` log; a log pinned to version 1 is refused outright, whatever this
   *  says. Never a production restore policy: `start.ts --legacy-logs` does not reach it (a legacy room
   *  admitted on a local server holds at its first past-trim discard until a president resolves it). */
  legacyExcessTrains?: "refuse" | "engine-chose-cheapest";
  /** #1614 (Slice 8.2, owner ruling R3 / D-31): what a LEGACY log's Stock-Round home placements mean --
   *  DEVELOPMENT-CORPUS ONLY, NEVER A PRODUCTION RESTORE POLICY. Every log before Slice 8.2 was played on the
   *  engine that demanded the home token at the float; the current reducer places it at the start of the
   *  corporation's first operating turn and refuses the old entries as untimely. `"defer-to-first-turn"` has
   *  `replayLog` REMEMBER the last such entry's candidate home choice (hex / circle) for each corporation and
   *  attempt it once, as a synthetic `PlaceHomeStation` through today's arm, when that corporation first
   *  owes its home -- judged by the CURRENT authority on the board of that moment, never forced, never
   *  substituted, appended nowhere. `"refuse"` -- the default, and the only value the server carries --
   *  replays the old entries as the refusals they now are, so the corporation's hold stands at its first turn.
   *  Only consulted for a `legacy` log. */
  legacyHomeTokens?: "refuse" | "defer-to-first-turn";
}

/** The server's policy: a room the field does not pin is not interpreted. */
export const SERVER_REPLAY_POLICY: ReplayPolicy = {
  legacyLogs: "refuse",
  legacyExcessTrains: "refuse",
  // #1614: no legacy home-choice adapter on a server, ever.
  legacyHomeTokens: "refuse",
};

/** The development corpus's policy: the stored and golden logs under `frontend/` predate the pin and are
 *  replayed under the current engine AS FIXTURES. Passing this is the visible statement that a test or the
 *  CLI knows the log it holds was never pinned. */
export const DEVELOPMENT_CORPUS_POLICY: ReplayPolicy = {
  legacyLogs: "development-corpus",
  // #1530: best-effort corpus compatibility (the corpus was played under the automatic trim); not fidelity.
  legacyExcessTrains: "engine-chose-cheapest",
  /* #1614 (R3): the corpus's float-time home placements are the players' recorded choices, tried at the first
     operating turn under the current rules -- data, not grandfathered legality. */
  legacyHomeTokens: "defer-to-first-turn",
};

/** The version the effective deal names: a number, `null` for a deal without one, `undefined` for no deal. */
export function rulesEngineVersionOf(entries: readonly ReplayEntry[]): number | null | undefined {
  for (const entry of effectiveActions(entries)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.payload);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && "SetupGame" in parsed) {
      const setup = (parsed as { SetupGame: Record<string, unknown> }).SetupGame;
      const version = setup[RULES_ENGINE_VERSION_FIELD];
      return typeof version === "number" && Number.isInteger(version) ? version : null;
    }
  }
  return undefined;
}

export function replayCompatibility(entries: readonly ReplayEntry[]): ReplayCompatibility {
  const version = rulesEngineVersionOf(entries);
  if (version === undefined) return { kind: "undealt" };
  if (version === null) return { kind: "legacy" };
  if (SUPPORTED_RULES_ENGINE_VERSIONS.includes(version)) return { kind: "compatible", version };
  return { kind: "incompatible", version, supported: SUPPORTED_RULES_ENGINE_VERSIONS };
}

/** Why this log must not be replayed by this engine under this policy, or `null` if it may be. */
export function replayRefusal(
  compatibility: ReplayCompatibility,
  policy: ReplayPolicy,
): string | null {
  switch (compatibility.kind) {
    case "compatible":
    case "undealt":
      return null;
    case "incompatible":
      return (
        `This game was dealt under rules engine version ${compatibility.version}; this server supports ` +
        `version${compatibility.supported.length === 1 ? "" : "s"} ${compatibility.supported.join(", ")}. ` +
        "It cannot be continued here without reinterpreting its history, so it is left untouched."
      );
    case "legacy":
      return policy.legacyLogs === "development-corpus"
        ? null
        : "This game was dealt before rules-engine versioning and carries no version. It is not reinterpreted " +
            "under the current rules. A local server may admit it explicitly (--legacy-logs development-corpus); " +
            "otherwise start a new game.";
  }
}

/** The deal as the server records it: whatever the client sent, with the version this engine carries. */
export function stampRulesEngineVersion<T extends { SetupGame: Record<string, unknown> }>(msg: T): T {
  return {
    ...msg,
    SetupGame: { ...msg.SetupGame, [RULES_ENGINE_VERSION_FIELD]: RULES_ENGINE_VERSION },
  };
}

/** A typed error for the headless paths (`replayLog`, the CLI), which have no frame to answer with. */
export class ReplayIncompatibleError extends Error {
  readonly compatibility: ReplayCompatibility;
  constructor(compatibility: ReplayCompatibility, reason: string) {
    super(reason);
    this.name = "ReplayIncompatibleError";
    this.compatibility = compatibility;
  }
}
