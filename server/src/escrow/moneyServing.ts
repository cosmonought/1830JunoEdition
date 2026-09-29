// server/src/escrow/moneyServing.ts
//
// ==================================================================
//  LIVE-4 (L4-4): MAY THIS POOL ACT ON THIS MONEY GAME? -- THE CANONICAL VERDICT, ASKED BEFORE EVERY MONEY WRITE
// ==================================================================
//
// Every money seam that reads a game and might write -- the escrow service's load, its jobs and its relayer admission,
// the relayer's intent selection, the checkpoint path behind `onGameplayCommitted`, the settlement coordinator's
// step -1, money creation, and the operator's inspect and release -- asks ONE question first, through this module:
// the canonical continuation verdict (L4-1, `frontend/src/gameEngine/compat/continuationVerdict.ts`) over the facts the
// seam holds, against THIS pool's capability and what the chain itself reported this run. Three answers:
//
//   continues       this pool may act on the game (its identity is one it plays and settles, its financial artifacts
//                   are in formats it reads, and the escrow the money is in is one it serves, with the game's facts).
//   not-continued   DERIVED. Write nothing: no transition, no hold, no `defer`, no placeholder. The game belongs to
//                   another pool (or a fixed configuration); the operator is told once (`notice`), and the verdict is
//                   recomputed at every load. Availability -- a deployment this pool does not serve, one it cannot
//                   verify yet, another build's format -- is never translated into a contradiction.
//   conflict        DURABLE, and only for a VERIFIED contradiction: the contract at the game's address reporting other
//                   facts ON CHAIN (verification-grade only, `juno/chainFacts.ts`), a money identity that contradicts its
//                   own deal or deployment, or a money table whose financial record is missing. Only the game's OWNER --
//                   the pool that serves the deployment the game's money is in -- writes the hold, under
//                   `CONFLICT_HOLD_CODES`; every other pool writes nothing.
//
// WHAT A MONEY SEAM CLASSIFIES. The financial artifacts it reads: the financial record (its class from the store: current,
// newer, older-unread, corrupt), and -- where the load walks them -- the ticket ledger and the chain intents. The
// gameplay artifacts (the GameRecord and the log) are classified where they are read, by the room host (L4-2); a money
// seam passes them as current, and takes from the log only the deal's identity.

import { CONFLICT_HOLD_CODES, continuationVerdict, type ArtifactFormats, type ChainAttestedFacts, type ContinuationRuntime, type ContinuationVerdict, type FormatFact, type MoneyFacts } from "../../../frontend/src/gameEngine/compat/continuationVerdict";
import { DEPLOYMENT_CAPABILITY_FORMAT, deploymentCapability, deploymentKey, servedDeployment, type DeploymentCapability, type DeploymentPin } from "../../../frontend/src/gameEngine/compat/deploymentCapability";
import type { GameIdentityFacts } from "../../../frontend/src/gameEngine/compat/continuationIdentity";
import { ACCEPTED_CLIENT_PROTOCOLS } from "../../../frontend/src/gameEngine/protocolVersions";
import { thisDeploymentCapability } from "../deploymentCapability";
import type { OpsRecorder } from "../persistence/opsRecorder";
import { CANONICAL_JUNO_ESCROW_CHECKSUMS } from "./juno/junoConfig";
import type { ChainFactsRead } from "./juno/chainFacts";
import type { DeploymentContinuation, MoneyContinuationIdentity } from "./moneyContinuation";
import type { FinancialGameRecord, FinancialHoldCode } from "./moneyLifecycle";

/** What one money seam knows about a game when it asks. */
export interface MoneyGameFacts {
  /** The financial record's class: `current` when it was read (`record` is then that record), the store's class when
   *  it could not be (`record` null); `undefined` when the game has NO financial record at all. */
  readonly fin: FormatFact | undefined;
  readonly record: FinancialGameRecord | null;
  /** The deal's identity (`gameIdentityOfEntries`); `undealt` when no deal stands or none was read. */
  readonly identity: GameIdentityFacts;
  /** The ticket ledger's and the chain intents' classes, where the seam classified them. */
  readonly tickets?: FormatFact;
  readonly intents?: FormatFact;
  /** The gameplay artifacts' classes, where the seam read them (default current: see the header). */
  readonly gameRecord?: FormatFact;
  readonly log?: FormatFact;
  /** The deployment key naming the game's escrow when its financial record cannot (a missing record): the money
   *  GameRecord's terms, or a chain intent's own instance. Ownership of a missing record is decided on it alone. */
  readonly ownerKey?: string | null;
}

export interface MoneyServingDecision {
  readonly verdict: ContinuationVerdict;
  /** The deployment key of the game's escrow, when anything names it. */
  readonly key: string | null;
  /** This pool serves that deployment: it OWNS the game (and is the only pool that writes the game's conflict hold). */
  readonly owner: boolean;
  /** A conflict found by the owner: the existing hold code it is recorded under. Null for anything else. */
  readonly holdCode: FinancialHoldCode | null;
}

/** One operator line: a money game this pool will not act on, and why (for the status file and the audit). */
export interface MoneyServingNotice {
  readonly game_id: string;
  readonly kind: "not-continued" | "conflict-elsewhere";
  readonly why: string;
  readonly detail: string;
  readonly where: string;
  readonly at: number;
}

export interface MoneyServing {
  /** This pool's capability (immutable per release: the build's own versions and the escrow deployments it serves). */
  readonly capability: DeploymentCapability;
  /** What the chain reported this run, at verification grade only (`juno/chainFacts.ts`). */
  runtime(): ContinuationRuntime;
  /** Record a verification-grade read. A read that failed proves nothing and changes nothing; a later successful read
   *  replaces the facts it names (the escrow service reads one at a time -- `refreshChainFacts` is single-flight -- so
   *  "later" is never a slow older read landing last, and no wall clock orders them). Nothing else ever writes here --
   *  never configuration, never a browser. */
  recordChainFacts(read: ChainFactsRead): void;
  /** When the facts for `key` were last read at verification grade (null: not this run). */
  chainFactsReadAt(key: string): number | null;
  /** Whether this pool serves the escrow deployment `key` (and so owns the games whose money is there). */
  serves(key: string | null): boolean;
  /** The canonical verdict over `facts`, with the ownership the write rules need. Pure; never throws on stored bytes. */
  decide(facts: MoneyGameFacts): MoneyServingDecision;
  /** The operational signal for a game this pool will not act on: one audit line and one warning per (game, reason)
   *  per process; a conflict the owner holds is recorded by its hold instead. */
  notice(gameId: string, decision: MoneyServingDecision, where: string): void;
  /** The games this pool currently will not act on (newest reason per game). */
  notices(): readonly MoneyServingNotice[];
}

const PLACEHOLDER = (record: FinancialGameRecord): boolean => record.continuation === null && record.hold?.code === "financial-record-missing";

/** The classes of a game's ticket ledger and chain intents, where a seam classified them. */
export interface ArtifactClasses {
  readonly tickets?: FormatFact;
  readonly intents?: FormatFact;
}

/** Whether a seam classifies a game's ticket ledger and chain intents at all: only beside a financial record of a
 *  financial protocol this pool speaks. Another protocol's artifacts are never parsed here -- the record's own verdict
 *  (`financial-protocol`, or its `newer-format` / `older-format` class) stops first. */
export function classifiesArtifacts(capability: DeploymentCapability, record: FinancialGameRecord | null): boolean {
  const protocol = record?.continuation?.financial_protocol;
  return protocol !== undefined && capability.financial_protocols.includes(protocol);
}

/** The deployment key a money GameRecord's terms name (`GameRecord.money`: backend, chain, contract), or null for a
 *  no-money record or terms that name none. Who owns a money table whose financial record is missing. */
export function moneyTermsKey(terms: unknown): string | null {
  const named = terms as { backend?: unknown; chain_id?: unknown; contract_address?: unknown } | null | undefined;
  if (named === null || named === undefined || typeof named !== "object") return null;
  if (typeof named.backend !== "string" || typeof named.chain_id !== "string" || typeof named.contract_address !== "string") return null;
  return deploymentKey({ backend: named.backend as DeploymentPin["backend"], chain_id: named.chain_id, contract_address: named.contract_address });
}

/** The deployment key a stored record's binding names, or null when it names none (a placeholder, a malformed pin). */
function bindingKeyOf(record: FinancialGameRecord | null): string | null {
  const pin = record?.binding?.deployment as Partial<DeploymentPin> | undefined;
  if (pin === undefined || pin === null) return null;
  if (typeof pin.backend !== "string" || typeof pin.chain_id !== "string" || typeof pin.contract_address !== "string") return null;
  return deploymentKey({ backend: pin.backend, chain_id: pin.chain_id, contract_address: pin.contract_address });
}

/** The money facts the canonical verdict reads, from a seam's facts. */
export function moneyFactsOf(facts: Pick<MoneyGameFacts, "fin" | "record">): MoneyFacts {
  if (facts.fin === undefined || (facts.fin === "current" && facts.record === null)) return { kind: "missing" };
  const record = facts.record;
  /* Unreadable here: the format class decides first (step 1), before any money fact is looked at. */
  if (record === null) return { kind: "record", mci: null, deployment: null };
  if (PLACEHOLDER(record)) return { kind: "placeholder" };
  return { kind: "record", mci: record.continuation, deployment: record.binding?.deployment ?? null };
}

export function createMoneyServing(input: {
  readonly capability: DeploymentCapability;
  readonly ops?: OpsRecorder;
  readonly warn?: (line: string) => void;
  readonly now?: () => number;
}): MoneyServing {
  const capability = deploymentCapability(input.capability);
  const now = input.now ?? Date.now;
  const facts = new Map<string, ChainAttestedFacts>();
  const readAt = new Map<string, number>();
  const runtime: ContinuationRuntime = { chainFacts: facts };
  const noticed = new Set<string>();
  const current = new Map<string, MoneyServingNotice>();
  const served = new Set(capability.escrow_deployments.map((deployment) => deployment.key));

  const serves = (key: string | null): boolean => key !== null && served.has(key);

  return {
    capability,
    runtime: () => runtime,
    recordChainFacts(read) {
      if (read.kind !== "read") return;
      facts.set(read.key, Object.freeze({ code_checksum: read.facts.code_checksum, denom: read.facts.denom }));
      readAt.set(read.key, read.read_at);
    },
    chainFactsReadAt: (key) => readAt.get(key) ?? null,
    serves,
    decide(game) {
      const record = game.fin === "current" ? game.record : null;
      const formats: ArtifactFormats = {
        record: game.gameRecord ?? "current",
        log: game.log ?? "current",
        ...(game.fin !== undefined ? { fin: game.fin } : {}),
        ...(game.tickets !== undefined ? { tickets: game.tickets } : {}),
        ...(game.intents !== undefined ? { intents: game.intents } : {}),
      };
      const verdict = continuationVerdict({ formats, identity: game.identity, money: moneyFactsOf({ fin: game.fin, record }) }, capability, runtime);
      const key = bindingKeyOf(record) ?? game.ownerKey ?? null;
      const owner = serves(key);
      const holdCode = verdict.kind === "conflict" && owner ? CONFLICT_HOLD_CODES[verdict.why] : null;
      return Object.freeze({ verdict, key, owner, holdCode });
    },
    notice(gameId, decision, where) {
      const verdict = decision.verdict;
      if (verdict.kind === "continues") {
        current.delete(gameId);
        return;
      }
      if (verdict.kind === "conflict" && decision.owner) return; // the owner's hold is the record of it
      const kind = verdict.kind === "conflict" ? "conflict-elsewhere" : "not-continued";
      const line: MoneyServingNotice = { game_id: gameId, kind, why: verdict.why, detail: verdict.detail.slice(0, 300), where, at: now() };
      current.set(gameId, line);
      const once = `${gameId}|${kind}|${verdict.why}`;
      if (noticed.has(once)) return;
      noticed.add(once);
      input.ops?.audit(kind === "not-continued" ? "money.not-continued" : "money.conflict-elsewhere", { game_id: gameId, why: verdict.why, where, deployment: decision.key, detail: line.detail });
      input.warn?.(
        kind === "not-continued"
          ? `  money: ${gameId} is NOT CONTINUED by this server (${verdict.why}) -- ${line.detail}; nothing is written for it here (${where})`
          : decision.key === null
            ? `  money: ${gameId} is in CONFLICT (${verdict.why}) and nothing this server holds names its escrow, so it writes nothing -- ${line.detail} (${where})`
            : `  money: ${gameId} is in CONFLICT (${verdict.why}) but its escrow is not served here, so this server writes nothing -- ${line.detail} (${where})`,
      );
    },
    notices: () => [...current.values()],
  };
}

/**
 * The capability a money seam serves with: this build's own (`thisDeploymentCapability`) over the escrow deployments
 * `pins` -- or, where a test injects ESCROW-3A's scalar continuation seam (an uncertified rules bump), that seam's
 * versions over the same deployments, so the same canonical verdict answers it.
 */
export function servingCapability(pins: readonly DeploymentPin[], injected?: { readonly current: MoneyContinuationIdentity; readonly deployment: DeploymentContinuation }): DeploymentCapability {
  if (injected === undefined) return thisDeploymentCapability(pins);
  return deploymentCapability({
    format: DEPLOYMENT_CAPABILITY_FORMAT,
    rules: { current: injected.current.rules_engine_version, supported: injected.deployment.supportedRules, certified: injected.deployment.certifiedRules },
    hosted_protocols: [injected.deployment.hostedProtocol],
    financial_protocols: pins.length === 0 ? [] : [injected.deployment.financialProtocol],
    settlement_codecs: injected.deployment.settlementCodecs as DeploymentCapability["settlement_codecs"],
    escrow_abi_checksums: CANONICAL_JUNO_ESCROW_CHECKSUMS,
    escrow_deployments: pins.map(servedDeployment),
    client_protocols: ACCEPTED_CLIENT_PROTOCOLS,
  });
}

/** A pool that serves no escrow deployment (and so speaks no financial protocol): every money game is `not-continued`
 *  on it (`financial-protocol`), and nothing is ever written for one. The default wherever no serving is wired -- fail
 *  closed, never "continue everything". */
export function noMoneyServing(input: { readonly ops?: OpsRecorder; readonly warn?: (line: string) => void; readonly now?: () => number } = {}): MoneyServing {
  return createMoneyServing({ ...input, capability: thisDeploymentCapability([]) });
}
