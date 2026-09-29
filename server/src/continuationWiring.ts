// server/src/continuationWiring.ts
//
// ==================================================================
//  LIVE-4 (L4-2): THIS POOL'S CONTINUATION ANSWERS, WIRED INTO EVERY GAME'S SESSION
// ==================================================================
//
// L4-1 made the model pure (`frontend/src/gameEngine/compat/`): `continuationVerdict`, `dealingIdentity`,
// `serveDecision`. This module is where a running server feeds it. It is built ONCE, at startup, around this build's
// `DeploymentCapability` (`thisDeploymentCapability(pins)`, the configured Juno deployment when there is one), and every
// game's session gets its `SessionContinuation` from here -- so the descriptor is never rebuilt ad hoc, and the
// verdict every session asks is the same function over the same capability.
//
// PER GAME IT SUPPLIES WHAT THE SESSION CANNOT KNOW:
//   the formats     the record and the log are read by the actor before any session is restored: `current` (a record
//                   or log this build cannot read never reaches a session -- the actor holds or refuses it first) --
//                   except that the session, the log's reader, classifies a pinned log this build cannot have written as
//                   `newer` (T-25, `logFormatOf`) and says so with each ask. The financial record's class comes from
//                   the settlement index: readable, or unreadable (`corrupt`).
//   the money facts from the settlement index (`MoneyContinuationFacts`, the coordinator): the stored continuation
//                   identity and the write-once deployment pin, the held placeholder, or nothing. Whether the game is a
//                   money table at all is its GameRecord's (`money !== null`) or the index's (a financial record
//                   exists): a money table the index knows nothing about is MISSING -- a conflict, never continued --
//                   so no money game is ever judged as a no-money one.
//   the chain facts none yet: `runtime.chainFacts` stays empty until L4-4 fills it from verification-grade reads, so no
//                   deployment fact difference is a conflict here (it is `deployment-unverified`, derived).
//   the pool        its role: `primary` until LIVE-6 supplies draining pools, their flip time and the primary's own
//                   verdict. `serveDecision` is asked anyway, so the session is structured around it today.
//
// WHAT IT NEVER READS: a build id. The capability's key does not contain one (L4-1), no fact here comes from one, and
// equal facts on two builds give equal answers. NOTHING HERE WRITES: every answer is derived; a conflict's durable hold
// is L4-4's, written by the owning pool.

import { isMoneyContinuationIdentity, type GameIdentityFacts } from "../../frontend/src/gameEngine/compat/continuationIdentity";
import {
  continuationVerdict,
  dealingIdentity,
  serveDecision,
  type ArtifactFormats,
  type ContinuationPolicy,
  type ContinuationRuntime,
  type ContinuationVerdict,
  type FormatFact,
  type MoneyFacts,
  type PoolServingState,
  type ServeDecision,
} from "../../frontend/src/gameEngine/compat/continuationVerdict";
import { deploymentCapability, type DeploymentCapability } from "../../frontend/src/gameEngine/compat/deploymentCapability";
import type { DealingAnswer, SessionContinuation } from "../../frontend/src/gameEngine/compat/sessionContinuation";
import type { MoneyContinuationFacts } from "./escrow/moneyContinuation";
import type { GameRecord } from "./rooms/gameRecord";

/** The primary pool: serves every game it continues, with no deadline. Every pool is this until LIVE-6. */
export const PRIMARY_POOL: PoolServingState = Object.freeze({ role: "primary", flipped_at: null });

/** Nothing read from the chain this run (L4-4 fills this from verification-grade reads only). */
export const NO_CHAIN_FACTS: ContinuationRuntime = Object.freeze({ chainFacts: new Map() });

export interface ContinuationWiringDeps {
  /** This pool's capability, built once at startup (`thisDeploymentCapability`). Validated here, once. */
  readonly capability: DeploymentCapability;
  /** What this run read from the chain. Empty until L4-4. */
  readonly runtime?: ContinuationRuntime;
  /** The legacy-log policy (`--legacy-logs`): `refuse` on every production server. */
  readonly policy: ContinuationPolicy;
  /** The settlement index's money facts. */
  readonly moneyFacts: MoneyContinuationFacts;
  /** `gameId`'s GameRecord as this server last committed it (the room host's index), or null. */
  readonly recordOf: (gameId: string) => Readonly<GameRecord> | null;
  /** This pool's serving state. Primary until LIVE-6. */
  readonly pool?: () => PoolServingState;
  /** For a DRAINING pool only (LIVE-6): the current primary's OWN verdict for the game, or null when none is known. */
  readonly primaryVerdict?: (gameId: string) => ContinuationVerdict | null;
  /** The clock `serveDecision` is asked with (ms since the epoch). */
  readonly now: () => number;
}

export interface ContinuationWiring {
  /** This pool's capability (canonical, validated once). */
  readonly capability: DeploymentCapability;
  /** The hook one game's session is given. */
  sessionFor(gameId: string): SessionContinuation;
  /** The full verdict for `gameId` with the deal `identity` and the log's format fact (the session's question, asked
   *  from outside; `log` defaults to `current`). */
  verdictOf(gameId: string, identity: GameIdentityFacts, log?: FormatFact): ContinuationVerdict;
  /** The GAMEPLAY half only -- the deal against the pool's rules and hosted protocols, no money facts. Discovery asks
   *  this from a log's first line, with the deal line's own format fact (`dealFormatOf`); the load asks the full
   *  verdict. */
  gameplayVerdictOf(identity: GameIdentityFacts, log?: FormatFact): ContinuationVerdict;
  /** Whether `gameId` is a money table (its GameRecord's money terms, or a financial record the index knows). */
  isMoney(gameId: string): boolean;
  /** Whether this pool's role can ever decline a game it continues (a draining or retired pool). */
  hasServingPolicy(): boolean;
}

const CURRENT: ArtifactFormats = Object.freeze({ record: "current", log: "current" });

export function createContinuationWiring(deps: ContinuationWiringDeps): ContinuationWiring {
  /* Validated ONCE: a capability this build could not canonicalize names no pool, and must stop the start rather than
     throw inside a game's rebuild (where a throw would read as a replay failure). */
  const capability = deploymentCapability(deps.capability);
  const runtime = deps.runtime ?? NO_CHAIN_FACTS;
  const pool = deps.pool ?? (() => PRIMARY_POOL);

  function moneyOf(gameId: string): { readonly formats: ArtifactFormats; readonly money: MoneyFacts } {
    const entry = deps.moneyFacts.factsOf(gameId);
    const record = deps.recordOf(gameId);
    const moneyTable = (record !== null && record.money !== null) || entry !== undefined;
    if (!moneyTable) return { formats: CURRENT, money: null };
    if (entry === undefined) return { formats: CURRENT, money: { kind: "missing" } };
    if (entry.kind === "unreadable") return { formats: { ...CURRENT, fin: "corrupt" }, money: { kind: "record", mci: null, deployment: null } };
    if (entry.kind === "placeholder") return { formats: { ...CURRENT, fin: "current" }, money: { kind: "placeholder" } };
    return { formats: { ...CURRENT, fin: "current" }, money: { kind: "record", mci: entry.mci, deployment: entry.deployment } };
  }

  /* `log` is the log's format fact as its reader (the session) classified it: `newer` for a pinned log this build
     cannot have written (T-25, `logFormatOf`). The record's is `current` -- a record this build cannot read never
     reaches a session -- and the financial record's is the index's. */
  function verdictOf(gameId: string, identity: GameIdentityFacts, log: FormatFact = "current"): ContinuationVerdict {
    const { formats, money } = moneyOf(gameId);
    return continuationVerdict({ formats: log === "current" ? formats : { ...formats, log }, identity, money }, capability, runtime, deps.policy);
  }

  function dealingOf(gameId: string): DealingAnswer {
    const { money } = moneyOf(gameId);
    if (money === null) return { ok: true, identity: dealingIdentity(capability, null) };
    if (money.kind === "record" && isMoneyContinuationIdentity(money.mci)) return { ok: true, identity: dealingIdentity(capability, money.mci) };
    return { ok: false, reason: "This table's escrow identity could not be read on this server, so the game was not dealt. Nothing changed." };
  }

  function servingOf(gameId: string, verdict: ContinuationVerdict, ended: boolean): ServeDecision {
    const state = pool();
    return serveDecision(
      {
        verdict,
        money: isMoney(gameId),
        terminal: ended,
        /* Only a draining pool's retirement reads it (LIVE-6): nothing here can tell, so an open money game is assumed
           open -- which keeps it served and a draining pool from retiring over it. */
        money_closed: false,
        primary_verdict: state.role === "primary" ? null : (deps.primaryVerdict?.(gameId) ?? null),
      },
      state,
      deps.now(),
    );
  }

  function isMoney(gameId: string): boolean {
    return moneyOf(gameId).money !== null;
  }

  return {
    capability,
    sessionFor: (gameId) => ({
      verdict: (identity, log) => verdictOf(gameId, identity, log),
      dealing: () => dealingOf(gameId),
      serving: ({ verdict, ended }) => servingOf(gameId, verdict, ended),
    }),
    verdictOf,
    gameplayVerdictOf: (identity, log = "current") =>
      continuationVerdict({ formats: log === "current" ? CURRENT : { ...CURRENT, log }, identity, money: null }, capability, runtime, deps.policy),
    isMoney,
    hasServingPolicy: () => pool().role !== "primary",
  };
}
