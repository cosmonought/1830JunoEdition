// server/src/escrow/escrowService.ts
//
// ==================================================================
//  ESCROW-3B: THE ESCROW SERVICE -- FROM COMMITTED GAMEPLAY TO DURABLE, SIGNED, RECONCILED CHAIN INTENTS
// ==================================================================
//
// The financial backend between the authoritative sealed gameplay and the chain (brief §1). It never decides gameplay:
// it reads COMMITTED history and the frozen financial facts, builds payloads only through `buildSettlementCoreV1`
// (O-1), selects the settlement key only through `selectSettlementKey` (O-2), signs only through the journalled signer
// (O-3), and submits only through durable intents (O-4) that the relayer (`juno/relayer.ts`) owns from there.
//
//   money game created        the financial record, with the deployment PINNED and the continuation identity FROZEN
//   chain game bound          `bindChainGame`: the creator's CreateGame read back from the chain (EscrowBindingV2,
//                             validated against the pinned policy; the variants digest recomputed) -- write-once
//   roster frozen + Start     `requestStart`, IN THE GAME'S ACTOR TASK: one chain read, `freezeEscrowRoster` over the
//                             ticket ledger's `lookupOf`, the ledger frozen, the financial roster written, then the
//                             Start intent (this freeze's own slot). From that commit no seat of the game can change --
//                             PROVISIONALLY: `reconcileStart` makes it permanent when the chain shows the Start, and
//                             RELEASES it (the pre-Start funded state) only when the chain PROVES this freeze's Start can
//                             never happen. An unknown outcome (an RPC failure, a lost answer, a crash) never releases.
//   the deal                  `EscrowRosterSource.plan`: a fresh read must show IN_PROGRESS with exactly the frozen
//                             roster hash and domain (O-7 at the deal)
//   checkpoints               `onGameplayCommitted` (synchronous, inside the committing task: a text snapshot only) ->
//                             a job off the actor builds, signs and writes one intent per checkpoint position
//                             (`checkpointPolicy.ts`); repeated observation is the same slot and the same subject
//   terminal                  after the coordinator's `intent-prepared`: the sealed prefix is re-derived and MUST equal
//                             the persisted intent (else HOLD); the terminal checkpoint (seq 2L) then the Settle (2L+1);
//                             a transient failure before the Settle intent is written is retried by the next chain
//                             sweep (JX-5B) as well as by a restart's load
//   after Settle              the chain's SETTLEABLE is observed; Finalize after the window; SETTLED/ANNULLED/CANCELLED
//                             closes the financial record (whatever route the chain took)
//
// Every job is a pure function of durable state, so a crash anywhere re-runs it to the same slot with the same subject.
//
// HISTORY BEFORE SIGNATURE (GNOLAND-1 F1, review #1). Before the first payload of a game is signed by this process, the
// durable log must REPRODUCE the highest checkpoint the external signing journal ever reserved for it (the same digest,
// rebuilt from the log's prefix), and the chain's trusted sequence must not be ahead of it: a store restored to an older
// (or different) history is held, never signed over.
//
// LIVE-4 (L4-4): THE VERDICT BEFORE EVERY WRITE. Every path here that reads a money game and might write -- the load, the
// checkpoint job behind `onGameplayCommitted`, the settle, observation and Start jobs, the relayer's admission and its
// intent selection (`classifyIntent`), money creation -- first asks the canonical continuation verdict (`servingOf`,
// `moneyServing.ts`) over the game's facts, this pool's capability and the chain's verification-grade facts this run
// (`refreshChainFacts`). `not-continued` (another deployment's game, one not yet verifiable, another build's format or
// protocol) writes NOTHING and is noticed once; a `conflict` is held under its canonical code by the owning pool only;
// only `continues` proceeds. The single-deployment `pinMismatch` it replaces treated every pin difference as a
// contradiction and held the game (F-L4-2); the request paths (bind, join admission, Start, the relays, the deal) refuse
// with the verdict's reason and write nothing, whatever it is.

import { createHash } from "crypto";

import { buildSettlementCoreV1, type BuiltSettlementCoreV1 } from "../../../frontend/src/gameEngine/escrow/settlementCoreV1";
import { JUNO_CODEC_V1, junoDomainInputsOf } from "../../../frontend/src/gameEngine/escrow/junoCodecV1";
import {
  codecDigest,
  deploymentId,
  escrowInstanceKey,
  JUNO_CAPABILITIES_V1,
  validateEscrowBindingV2,
  type EscrowBindingV2,
  type EscrowDeploymentPolicy,
  type EscrowIntentKey,
  type SignerKeyStatus,
} from "../../../frontend/src/gameEngine/escrow/escrowModel";
import { freezeEscrowRoster, type EscrowTrustPolicy } from "../../../frontend/src/gameEngine/escrow/escrowRoster";
import { variantsDigestV1 } from "../../../frontend/src/gameEngine/escrow/variantsDigest";
import { canonicalStateText } from "../../../frontend/src/gameEngine/settlementDigest";
import { annulDigestV1, consentDigestV1 } from "../../../frontend/src/gameEngine/settlementPayload";
import { logHash } from "../../../frontend/src/gameEngine/logHash";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import type { GameVariants } from "../../../frontend/src/gameEngine/gameVariants";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { NO_WALLET_CONTROL_PROOFS, selectSettlementKey, walletProofProblem, type SettlementKeyConfig, type SettlementSigner, type WalletControlProofs } from "./escrowPorts";
import { annulInstanceOf, consentInstanceOf, intentBelongsTo, isLiveAttempt, newChainIntent, sameChainIntent, startEpochOf, startInstanceOf, supersededIntent, type ChainIntentOp, type ChainIntentRecord, type ChainIntentStore } from "./chainIntents";
import { roundKeyOf, isCheckpointPosition, issuedAtOf, type CheckpointSnapshot } from "./checkpointPolicy";
import { FinancialRecordUnreadableError, type FinancialGameStore } from "./financialGameStore";
import type { EscrowCodecId } from "../../../frontend/src/gameEngine/escrow/escrowCodec";
import { currentMoneyContinuation, THIS_DEPLOYMENT, type DeploymentContinuation, type MoneyContinuationIdentity } from "./moneyContinuation";
import type { ContinuationVerdict as CanonicalVerdict, FormatFact } from "../../../frontend/src/gameEngine/compat/continuationVerdict";
import { gameIdentityOfEntries, type GameIdentityFacts } from "../../../frontend/src/gameEngine/compat/continuationIdentity";
import { deploymentKey } from "../../../frontend/src/gameEngine/compat/deploymentCapability";
import { classifiesArtifacts, createMoneyServing, servingCapability, type ArtifactClasses, type MoneyServing, type MoneyServingDecision } from "./moneyServing";
import { readVerifiedChainFacts, type ChainFactsRead } from "./juno/chainFacts";
import { DEALT_PHASES, newFinancialRecord, transitionFinancial, type FinancialDeploymentPin, type FinancialEvent, type FinancialGameRecord, type FinancialHoldCode } from "./moneyLifecycle";
import type { InspectableSigningJournal } from "./signingJournal";
import type { PrefixReplay, TerminalSettlementEvidence } from "./settlementEvidence";
import type { WalletTicketLedger } from "./walletTickets";
import { SignerError } from "./juno/signer";
import { verifyDigest } from "./juno/secp256k1";
import { junoGameView, parseConfigResponse, parseGameResponse, parseSignerKeysResponse, QUERY, RELAYER_EXECUTE, type JunoGameResponse } from "./juno/junoContract";
import type { JoinAdmissionSigner } from "./juno/joinAdmission";
import type { JunoRest } from "./juno/junoRest";
import type { Admission, IntentServing, Relayer } from "./juno/relayer";
import type { OpsRecorder } from "../persistence/opsRecorder";
import type { GameRecord, Seat } from "../rooms/gameRecord";
import type { RosterSource, StartPlan, StartRefusal } from "../rooms/roomService";

/** The payload's `state_schema_version`: the canonical state text format (`18JUNO/STATE/v1`) every certified vector
 *  uses. SET-0C §18 left it a policy value; ESCROW-3B pins it to 1 (the only format the appraiser reads). */
export const SETTLEMENT_STATE_SCHEMA_VERSION = 1;

/** This deployment's Juno facts (validated at startup, `juno/junoConfig.ts`). */
export interface JunoBackendRuntime {
  readonly pin: FinancialDeploymentPin;
  readonly symbol: string;
  readonly policy: EscrowDeploymentPolicy;
  readonly trust: EscrowTrustPolicy;
  readonly rest: JunoRest;
  readonly settlementKeys: readonly SettlementKeyConfig[];
  readonly settlementSigner: SettlementSigner;
}

export interface EscrowServiceDeps {
  readonly backend: JunoBackendRuntime;
  readonly financial: FinancialGameStore;
  readonly intents: ChainIntentStore;
  readonly journal: InspectableSigningJournal;
  /** Set once the relayer is built (it is told about the service's resolution hook). */
  readonly relayer: () => Relayer | null;
  readonly tickets: WalletTicketLedger;
  /** The durable committed log of a game (the settlement re-derivation reads it; never a live session). */
  readonly readLog: (gameId: string) => Promise<readonly ServerLogEntry[]>;
  /** LIVE-4 (L4-4): the deal's identity of a game, read READ-ONLY from its durable log (`dealIdentity.ts`: no repair, no
   *  sync, no store state) -- the continuation verdict asks it far more often than a room loads its log. Throws only
   *  when the log cannot be read at all (then nothing is decided, and nothing written). Default: from `readLog`. */
  readonly readDeal?: (gameId: string) => Promise<GameIdentityFacts>;
  /** LIVE-4 (integration): the log's format class, read-only from its durable bytes (`dealIdentity.ts`
   *  `logFormatOnDisk`), wherever the entries are not in hand -- so every money seam judges the same log facts the game's
   *  session does (N-3, T-25). Absent: `current`. */
  readonly readLogFormat?: (gameId: string) => Promise<FormatFact>;
  readonly replay: PrefixReplay;
  readonly now: () => number;
  readonly warn: (line: string) => void;
  readonly ops?: OpsRecorder;
  /** Financial mode is verified against the chain (`juno/junoBackend.ts`): until it is, nothing is signed or written
   *  for the chain (default: ready). */
  readonly ready?: () => boolean;
  /** ESCROW-JOIN: the join-admission signer (its key IS the contract's `admission_pubkey`, checked at verification) and
   *  how long an admission lives. Absent (e.g. a KMS key before LIVE-5 wires KMS): every `authorizeJoin` refuses. */
  readonly admission?: { readonly signer: JoinAdmissionSigner; readonly ttlSecs: number };
  /** ESCROW-JOIN: ESCROW-4's proofs of wallet control. Absent: none exist, and every `authorizeJoin` refuses. */
  readonly walletProofs?: WalletControlProofs;
  /** LIVE-4 preflight §9.3 / ESCROW-4 amendment §4: the identity a money game created NOW would freeze, and what this
   *  deployment continues (defaults: `currentMoneyContinuation`, `THIS_DEPLOYMENT`). Tests inject an uncertified rules
   *  bump here; production never sets it. */
  readonly continuation?: { readonly current: (codec: EscrowCodecId) => MoneyContinuationIdentity; readonly deployment: DeploymentContinuation };
  /** LIVE-4 (L4-4): this pool's serving -- its capability and the chain's verification-grade facts -- shared with the
   *  settlement coordinator (`start.ts`). Default: this build's capability over `backend.pin` (or the injected
   *  `continuation` seam's versions over it), with no chain fact read until `refreshChainFacts`. */
  readonly serving?: MoneyServing;
  /** LIVE-6 L6-2: POST-RESTORE SAFE MODE (preflight §13 step 8, §17.2 step 4; L6-4 §12.2). True on a game table restored
   *  from a backup (its SYSTEM/GENERATION says origin `restore`): every money game is read-only and takes no money request
   *  until `restoreCheck` verified it IN THIS PROCESS (see `restoreCheck`). Absent / false: as before. */
  readonly restoreSafeMode?: boolean;
  /** LIVE-6 L6-7: the money games `load()` and `sweepChain()` visit. Their work is only ever for an OPEN money game (a
   *  closed or cancelled record resumes nothing, reconciles nothing and is never held), so AWS passes the open-money-game
   *  index (FINKEYS -> FINIDX#, strict) instead of every financial record ever made. Absent (PROCESS mode): every
   *  financial record (`financial.list()`), as before. The roster preload (PROCESS only) and `refreshRoster` (a claim)
   *  are not discovery and are unchanged. */
  readonly openGames?: () => Promise<string[]>;
  /** FP4 (escrow 2.1.0): the remedy lane's word, asked before a `submit-remedy` intent is relayed -- where the server
   *  clock lane's SYSTEM PAUSE holds a remedy that is not yet financially final (a pre-outage attestation waits; it
   *  expires within the hour and is attested again only under the system-pause rules). ABSENT (this build: the lane is
   *  not built): no remedy intent is ever relayed -- fail closed. */
  readonly remedyGate?: (gameId: string, intent: ChainIntentRecord) => Promise<{ readonly kind: "ok" } | { readonly kind: "wait"; readonly why: string }>;
}

export type ServiceRefusal = { readonly ok: false; readonly code: string; readonly detail: string };

/** LIVE-6 L6-2: a restored money game's verification (post-restore safe mode). */
export type RestoreCheck =
  /** Serve it: its history reproduces the ledger's reservations (F1) and the chain is not ahead of it -- or it has nothing
   *  to verify (no financial record, closed, never bound to a chain game). */
  | { readonly kind: "verified"; readonly detail: string }
  /** Not yet: the chain cannot be read now, or financial mode is not verified; it is tried again at the next ask. */
  | { readonly kind: "pending"; readonly detail: string }
  /** It never will be here: the F1 check HELD it (`journal-ahead`, a durable hold -- the operator's). */
  | { readonly kind: "held"; readonly detail: string };

/** LIVE-6 L6-5B: `restoreStatus()` -- the games whose restore check has answered, by that last answer. */
export interface RestoreStatus {
  readonly safe_mode: boolean;
  readonly verified: number;
  readonly pending: number;
  readonly held: number;
}

export const RESTORE_READ_ONLY_SENTENCE = "This table was restored from a backup: it stays read-only until its money history is checked against the ledger and the chain.";

/** ESCROW-JOIN: what ESCROW-4's (future) route asks for, after authenticating the principal and proving the wallet. */
export interface JoinAuthorizationRequest {
  readonly gameId: string;
  readonly playerId: string;
  /** The authenticated principal making the request (server-private; never on the wire or on chain). */
  readonly principalId: string;
  /** The wallet that will SEND the Join (canonical lower-case bech32). */
  readonly wallet: string;
  /** The seat's current join ticket (lowercase hex), which the same Join carries. */
  readonly joinTicket: string;
}

/** The admission, exactly as the Join carries it (`WALLET_EXECUTE.join(chain_game_id, consent key, ticket, {expiresAt,
 *  signature})`), plus what the client needs to check it names its own game and wallet. */
export interface JoinAdmissionGrant {
  readonly chain_id: string;
  readonly contract: string;
  readonly chain_game_id: string;
  readonly wallet: string;
  readonly join_ticket: string;
  /** Unix seconds, decimal (chain block time must be before it). */
  readonly expires_at: string;
  readonly signature: string;
  readonly admission_pubkey: string;
}

/** What `reconcileStart` found: the chain started this freeze (permanent), its Start may still happen (the freeze
 *  stands), the chain proved it never will (released), there is no freeze to decide, or the game is held. */
export type StartReconciliation = "started" | "pending" | "released" | "none" | "held";

/** ESCROW-4 (W-13): what a host's CreateGame must show on chain before the table binds it. Every field is the SERVER's:
 *  the host seat's currently standing, PROVEN linked wallet and its ticket, and the table's own terms. */
export interface HostBindExpectation {
  readonly creator: string;
  readonly ticket: string;
  readonly anteGross: string;
  readonly maxPlayers: number;
  readonly mode: 0 | 1;
}

/** ESCROW-4: a relayed CONSENT's outcome (`on-chain`: the seat's bit is already set). */
export type ConsentRelayStatus = "queued" | "relayed" | "on-chain";

/** ESCROW-4: what `escrowDetails` reads back of the server's own signed payloads (for a player's own verification and
 *  for a liveness exit that carries a checkpoint the chain never saw). Public: a signed payload is what the chain gets. */
export interface SignedPayloadDetail {
  readonly seq: string;
  readonly log_len: number;
  readonly round_key: string | null;
  readonly payload: unknown;
  readonly signature: string;
  readonly settle_digest: string;
  readonly status: ChainIntentRecord["status"];
}

export interface EscrowService {
  /** ESCROW-4's money-room creation: the financial record, deployment pinned and continuation frozen. */
  createMoneyGame(gameId: string): Promise<{ readonly ok: true; readonly record: FinancialGameRecord } | ServiceRefusal>;
  /** The creator's CreateGame landed: bind the chain game (write-once, from a chain read). ESCROW-3B's seam, kept for its
   *  suites; ESCROW-4's money layer binds ONLY through `bindHostChainGame` (a source scan pins it). */
  bindChainGame(gameId: string, chainGameId: string, variants: GameVariants): Promise<{ readonly ok: true; readonly binding: EscrowBindingV2 } | ServiceRefusal>;
  /** ESCROW-4 (W-13): bind a HOST's CreateGame only when a quorum chain read proves it is exactly the table's: FUNDING,
   *  the creator the host's standing proven wallet, one seat (the creator's) carrying the host seat's standing ticket,
   *  and the table's ante, player count, pace, denomination, rules and variants on the pinned deployment. A copied
   *  CreateGame (another creator) or a stale one (another ticket) is refused and never bound. */
  bindHostChainGame(gameId: string, chainGameId: string, variants: GameVariants, expect: HostBindExpectation): Promise<{ readonly ok: true; readonly binding: EscrowBindingV2 } | ServiceRefusal>;
  /** ESCROW-4: relay one seat's CONSENT signature to the stored settlement -- verified here against the chain's CURRENT
   *  consent key of that chain seat (which must be one the seat registered). No re-authentication: the signature is the
   *  authority (owner ruling). Idempotent per (seq, seat, key). */
  relayConsent(input: { readonly gameId: string; readonly chainSeatIndex: number; readonly signature: string; readonly registeredKeys: readonly string[] }): Promise<{ readonly ok: true; readonly status: ConsentRelayStatus; readonly consent_pubkey: string } | ServiceRefusal>;
  /** ESCROW-4: one seat's ANNUL signature over (domain, trusted_seq), verified like a consent; collected (in memory) until
   *  every chain seat has signed under its current key, then ONE annul intent. */
  submitAnnul(input: { readonly gameId: string; readonly chainSeatIndex: number; readonly signature: string; readonly registeredKeys: readonly string[] }): Promise<{ readonly ok: true; readonly trusted_seq: string; readonly collected: readonly number[]; readonly needed: number; readonly submitted: boolean } | ServiceRefusal>;
  /** ESCROW-4: the ANNUL signatures collected for a game (chain seat indices) and the trusted sequence they bind. */
  annulCollected(gameId: string): { readonly trusted_seq: string; readonly collected: readonly number[] } | null;
  /** ESCROW-4: the newest signed checkpoint and the terminal settlement this server prepared for a game. */
  escrowDetails(gameId: string): Promise<{ readonly checkpoint: SignedPayloadDetail | null; readonly settlement: SignedPayloadDetail | null }>;
  /** ESCROW-4: a game's durable chain intents (the money layer's view of Start / Settle progress). */
  intentsOf(gameId: string): Promise<readonly ChainIntentRecord[]>;
  /** ESCROW-4: a game's financial record, bound chain game, or chain facts changed (the money layer re-projects). */
  onChange(listener: (gameId: string) => void): void;
  /** ESCROW-4: whether the backend is verified and serving (money actions refuse otherwise). */
  isReady(): boolean;
  /** LIVE-4 amendment §4 / L4-4: whether this deployment may create a money game now -- the CANONICAL verdict over the
   *  identity it would freeze (the CURRENT rules engine, hosted and financial protocols, the pinned codec) and the pinned
   *  deployment: the rules played and settlement-certified, the financial protocol and codec served, the deployment
   *  served AND verified (a verification-grade chain read this run agrees with the pin). `createMoneyGame` refuses
   *  exactly when this does not continue. */
  creationVerdict(): CanonicalVerdict;
  /** LIVE-4 (L4-4): this pool's serving (capability + verification-grade chain facts), for the coordinator and tools. */
  readonly serving: MoneyServing;
  /** LIVE-6 L6-2: post-restore safe mode (the deps' `restoreSafeMode`) -- null: the game may be served (not a restored
   *  table, not a money game, or verified in this process); else the sentence a move or money request is refused with.
   *  Synchronous; it starts the game's verification if none is running. */
  restoreGate(gameId: string): string | null;
  /** LIVE-6 L6-2: the verification itself (for the gate, the claim hook and tests). */
  restoreCheck(gameId: string): Promise<RestoreCheck>;
  /** LIVE-6 L6-5B: what post-restore safe mode looks like NOW -- read-only counts of the games whose check has run, by
   *  their last outcome (`pending`: still read-only). A view for metrics; it decides nothing and starts nothing. */
  restoreStatus(): RestoreStatus;
  /** LIVE-4 (L4-4): read the pinned deployment's chain-attested facts at verification grade and record them (the only
   *  source of `runtime.chainFacts`). `junoBackend` calls it at every verification; creation calls it when none was read. */
  refreshChainFacts(): Promise<ChainFactsRead>;
  /** LIVE-4 (L4-4): the relayer's first question about an intent, before anything is written for it: continue, skip
   *  it in memory (another deployment's, or a game this pool does not continue), or hold it (the owner's conflict). */
  classifyIntent(intent: ChainIntentRecord): Promise<IntentServing>;
  /** LIVE-4 (L4-4): the money-game serving decision -- the canonical verdict for `gameId` on this pool, deployment
   *  included -- READ-ONLY: nothing is written (a pool that does not continue the game is noticed once, as `where`).
   *  The money routes, the money observer and the security-event revocation ask it before they write. `ownerKey`: the
   *  deployment the table's GameRecord terms name (`moneyTermsKey`), so a missing financial record is judged with its
   *  owner known. Throws when the facts cannot be read now (nothing decided; the caller writes nothing). */
  servingDecision(gameId: string, options?: { readonly where?: string; readonly ownerKey?: string | null }): Promise<MoneyServingDecision>;
  /** LIVE-4 (L4-4): the classes of a game's ticket ledger and chain intents (current / newer / older-unread / corrupt),
   *  beside `record` -- classified once per process, and only when `record` is of a financial protocol this pool speaks
   *  (`{}` otherwise: another protocol's artifacts are never parsed). Read-only. The settlement coordinator's step -1
   *  asks it, so both seams decide on the same facts. */
  artifactFormatsOf(gameId: string, record: FinancialGameRecord | null): Promise<ArtifactClasses>;
  /** ESCROW-4: read what the chain says about a bound game now (a funding escrow cancelled on chain closes its record). */
  observe(gameId: string): Promise<void>;
  /** ESCROW-4: a money table that ended before any chain game was bound (cancelled or expired) closes its financial
   *  record (`cancel-before-deal`). A bound table closes only from the chain (its CANCELLED). */
  closeUnboundTable(gameId: string): Promise<void>;
  /** ESCROW-JOIN: the server's admission for one standing seat's PROVEN wallet to Join the table's bound chain game. The
   *  seam ESCROW-4 calls; no route reaches it yet (money games are disabled). */
  authorizeJoin(input: JoinAuthorizationRequest): Promise<{ readonly ok: true; readonly admission: JoinAdmissionGrant } | ServiceRefusal>;
  /** IN THE GAME'S ACTOR TASK: freeze the financial roster and prepare the Start intent. */
  requestStart(gameId: string, liveSeats: readonly Pick<Seat, "player_id">[]): Promise<{ readonly ok: true; readonly roster_hash: string; readonly intent_id: string } | ServiceRefusal>;
  /** The money deal's roster source (O-7 at the deal). */
  readonly rosterSource: RosterSource;
  /** Synchronous, inside the committing task: a committed batch (or a load) of a money game. Never throws. */
  onGameplayCommitted(input: { readonly gameId: string; readonly entries: readonly ServerLogEntry[]; readonly board: GameStateResponse }): void;
  /** The settlement coordinator prepared (or found) the terminal intent. */
  onIntentPrepared(gameId: string): void;
  /** The relayer resolved an intent. */
  onIntentResolved(intent: ChainIntentRecord): Promise<void>;
  /** Startup, BEFORE any chain read (review #8): which tables have a frozen financial roster, from the durable store. */
  preload(): Promise<number>;
  /** LIVE-5 L5-3 (POOL ownership, preflight §13 step 6): the frozen-roster fact of ONE game, from a fresh read of its
   *  financial record -- run when this task CLAIMS the game, before its load resolves, so `isRosterFrozen(g)` is the
   *  claim read's answer and never a startup preload another task has since overtaken. An unreadable record counts as
   *  frozen (a seat never moves on a guess); a read that fails rejects (the claim, and so the load, fails). */
  refreshRoster(gameId: string): Promise<void>;
  /** Startup: the continuation verdict of every money game (L4-4), the relayer's open intents, and every continued
   *  game's pending chain work. `skipped`: games this pool does not continue (nothing written for them). */
  load(): Promise<{ readonly games: number; readonly held: number; readonly resumed: number; readonly skipped: number }>;
  /** The relayer's admission of a new attempt (review #5/#6). */
  admit(intent: ChainIntentRecord): Promise<Admission>;
  /** The Start of the current roster freeze, decided from chain truth: permanent, pending, or released (tests, sweep). */
  reconcileStart(gameId: string): Promise<StartReconciliation>;
  /** Periodic: what the chain says about every bound money game (disputes, consents, liveness exits, finality). */
  sweepChain(): Promise<void>;
  /** Wait for every queued job (tests, shutdown). */
  idle(): Promise<void>;
  isRosterFrozen(gameId: string): boolean;
  readonly stats: { checkpoints: number; settles: number; finalizes: number; holds: number; skipped: number; failures: number };
}

export function createEscrowService(deps: EscrowServiceDeps): EscrowService {
  const backend = deps.backend;
  const continuationNow = (): MoneyContinuationIdentity => (deps.continuation?.current ?? currentMoneyContinuation)(backend.pin.codec);
  const continuationDeployment: DeploymentContinuation = deps.continuation?.deployment ?? THIS_DEPLOYMENT;
  /* LIVE-4 (L4-4): this pool's capability serves exactly the configured deployment; the chain's facts come only from
     `refreshChainFacts`. */
  const serving: MoneyServing =
    deps.serving ??
    createMoneyServing({
      capability: servingCapability([backend.pin], deps.continuation === undefined ? undefined : { current: continuationNow(), deployment: continuationDeployment }),
      ops: deps.ops,
      warn: deps.warn,
      now: deps.now,
    });
  const pinKey = deploymentKey(backend.pin);
  const stats = { checkpoints: 0, settles: 0, finalizes: 0, holds: 0, skipped: 0, failures: 0 };
  /** Per game: the newest checkpoint round key and log_len the service has prepared (durable in the record). */
  const lastRound = new Map<string, { round_key: string; log_len: number }>();
  const frozen = new Set<string>();
  const started = new Set<string>();
  /** Review #1: games whose durable log was verified, in this process, to reproduce the journal's signed history. */
  const historyVerified = new Set<string>();
  const jobs = new Map<string, Promise<void>>();
  const locks = new Map<string, Promise<unknown>>();
  const audit = (event: string, fields: Record<string, unknown>) => deps.ops?.audit(event, fields);
  /** ESCROW-4: who is told that a game's money changed (the money layer re-projects and pushes room views). */
  const listeners: Array<(gameId: string) => void> = [];
  const notify = (gameId: string) => {
    for (const listener of listeners) {
      try {
        listener(gameId);
      } catch (error) {
        deps.warn(`  escrow: a change listener threw for ${gameId} -- ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  /** ESCROW-4: ANNUL signatures being collected, per game (memory only: a restart asks the seats to sign again). */
  const annulBook = new Map<string, { trusted_seq: string; domain: string; seats: number; sigs: Map<number, { signature: string; pubkey: string }> }>();

  /** Serialized per game, off the actor; a failure is logged and left for the next observation or the sweep. */
  const ready = () => deps.ready?.() !== false;

  /** One writer per game for the roster freeze and its release (`requestStart` in the actor task, `reconcileStart` from
   *  jobs, the load's repairs): a release and a new freeze never interleave. */
  function exclusive<T>(gameId: string, task: () => Promise<T>): Promise<T> {
    const run = (locks.get(gameId) ?? Promise.resolve()).then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(gameId, tail);
    void tail.then(() => {
      if (locks.get(gameId) === tail) locks.delete(gameId);
    });
    return run;
  }

  function enqueue(gameId: string, label: string, task: () => Promise<void>): Promise<void> {
    const guarded = async () => {
      if (!ready()) throw new Error("financial mode is not verified against the chain; nothing is signed (it resumes at verification)");
      await task();
    };
    const run = (jobs.get(gameId) ?? Promise.resolve()).then(guarded).catch((error) => {
      stats.failures += 1;
      deps.warn(`  escrow: ${label} for ${gameId} failed -- ${error instanceof Error ? error.message : String(error)}; the next observation or sweep retries it`);
    });
    jobs.set(gameId, run);
    void run.then(() => {
      if (jobs.get(gameId) === run) jobs.delete(gameId);
    });
    return run;
  }

  /** One lifecycle transition by CAS (3 tries), exactly as the settlement coordinator writes. */
  async function apply(gameId: string, event: (record: FinancialGameRecord) => FinancialEvent | null): Promise<FinancialGameRecord | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record = await deps.financial.load(gameId);
      if (record === null) return null;
      const chosen = event(record);
      if (chosen === null) return record;
      const decided = transitionFinancial(record, chosen);
      if (decided.kind !== "moved") return record;
      const put = await deps.financial.put(decided.next, record.record_version);
      if (put.kind === "committed") {
        if (decided.next.phase === "held" && record.phase !== "held") {
          stats.holds += 1;
          audit("settlement.held", { game_id: gameId, code: decided.next.hold?.code ?? null, from: record.phase });
          deps.warn(`  escrow: ${gameId} HELD (${decided.next.hold?.code}) -- ${decided.next.hold?.detail}`);
        } else if (decided.next.phase === "held" && decided.next.hold?.code !== record.hold?.code) {
          /* L4-7: a verified deployment conflict superseded a weaker hold. */
          audit("settlement.held", { game_id: gameId, code: decided.next.hold?.code ?? null, from: record.phase, supersedes: record.hold?.code ?? null });
          deps.warn(`  escrow: ${gameId} HELD (${decided.next.hold?.code}, superseding ${record.hold?.code}) -- ${decided.next.hold?.detail}`);
        }
        remember(decided.next);
        notify(gameId);
        return decided.next;
      }
      if (put.kind !== "conflict") throw new Error(put.detail);
    }
    throw new Error("the financial record kept changing");
  }

  const hold = (gameId: string, code: FinancialHoldCode, detail: string) => apply(gameId, () => ({ kind: "hold", at: deps.now(), code, detail }));

  /** A table's seats are frozen while a roster is frozen (provisionally or, once started, permanently), and while its
   *  money is HELD (operator attention: nothing moves); a cancelled or closed escrow has nothing left to freeze. */
  /** LIVE-6 L6-7: the money games the load and the chain sweep visit (the open ones where an index says which). */
  const discover = (): Promise<string[]> => (deps.openGames !== undefined ? deps.openGames() : deps.financial.list());

  function remember(record: FinancialGameRecord): void {
    if ((record.roster !== null || record.chain.started !== null || record.phase === "held") && record.phase !== "cancelled" && record.phase !== "closed") frozen.add(record.game_id);
    else frozen.delete(record.game_id);
    if (record.chain.started !== null) started.add(record.game_id);
    const prepared = record.chain.checkpoint_prepared;
    if (prepared !== null) {
      const known = lastRound.get(record.game_id);
      if (known === undefined || known.log_len <= prepared.log_len) lastRound.set(record.game_id, { round_key: prepared.round_key, log_len: prepared.log_len });
    }
  }

  /* ------------------------------------------------------------------ */
  /* LIVE-4 (L4-4): the continuation verdict, before every write           */
  /* ------------------------------------------------------------------ */

  /** The deal's identity of each game once it is dealt (a deal is immutable: the log is append-only and nothing undoes
   *  it), so a game's log is read for it at most until its deal is found. */
  const identities = new Map<string, GameIdentityFacts>();
  /** The ticket ledger's and the chain intents' classes, per game, as first classified in this process. This process is
   *  the data directory's only writer and writes only current formats, so what it found stays exact. */
  const artifactFormats = new Map<string, ArtifactClasses>();

  /** A game's ledger and intents classes beside `record` (`classifiesArtifacts`: only for a financial protocol this pool
   *  speaks; `{}` otherwise). Classified on first use, never parsing another build's format, never writing. */
  async function artifactFormatsOf(gameId: string, record: FinancialGameRecord | null): Promise<ArtifactClasses> {
    if (!classifiesArtifacts(serving.capability, record)) return {};
    const known = artifactFormats.get(gameId);
    if (known !== undefined) return known;
    const classes: ArtifactClasses = Object.freeze({ tickets: await deps.tickets.formatOf(gameId), intents: (await deps.intents.formatOf?.(gameId)) ?? "current" });
    artifactFormats.set(gameId, classes);
    return classes;
  }
  /** The newest decision per game (the synchronous `onGameplayCommitted` reads it; every job decides again). */
  const decisions = new Map<string, MoneyServingDecision>();

  function identityFrom(gameId: string, entries: readonly ServerLogEntry[]): GameIdentityFacts {
    const known = identities.get(gameId);
    if (known !== undefined) return known;
    const identity = gameIdentityOfEntries(entries);
    if (identity.kind !== "undealt") identities.set(gameId, identity);
    return identity;
  }

  /** The deal's identity: from `entries` when the caller holds them, else from the durable log, read-only (read until
   *  dealt). A log that cannot be read at all throws: nothing is decided now. */
  /** LIVE-4 (integration): the log's format class. Entries in hand come from a session that interpreted them (this
   *  build's format); otherwise the durable bytes are classified once, read-only (a log changes only through this
   *  process's own appends while it holds the data directory). */
  const logFormats = new Map<string, FormatFact>();
  async function logFormatOfGame(gameId: string, entries?: readonly ServerLogEntry[]): Promise<FormatFact> {
    const known = logFormats.get(gameId);
    if (known !== undefined) return known;
    if (entries !== undefined || deps.readLogFormat === undefined) return "current";
    const read = await deps.readLogFormat(gameId);
    logFormats.set(gameId, read);
    return read;
  }

  async function identityOf(gameId: string, entries?: readonly ServerLogEntry[]): Promise<GameIdentityFacts> {
    if (entries !== undefined) return identityFrom(gameId, entries);
    const known = identities.get(gameId);
    if (known !== undefined) return known;
    if (deps.readDeal === undefined) return identityFrom(gameId, await deps.readLog(gameId));
    const identity = await deps.readDeal(gameId);
    if (identity.kind !== "undealt") identities.set(gameId, identity);
    return identity;
  }

  type Found = { readonly decision: MoneyServingDecision; readonly record: FinancialGameRecord | null };

  /** THE question, before anything is written for `gameId`: the canonical verdict over its financial record (read here
   *  unless the caller already holds it; an unreadable one keeps the store's class), the deal's identity, the classes
   *  the load found for its ledger and intents, this pool's capability and the chain's verification-grade facts. */
  async function servingOf(
    gameId: string,
    options: { readonly record?: FinancialGameRecord | null; readonly fin?: FormatFact; readonly entries?: readonly ServerLogEntry[]; readonly ownerKey?: string | null } = {},
  ): Promise<Found> {
    let record: FinancialGameRecord | null = null;
    let fin: FormatFact | undefined = options.fin ?? "current";
    if (options.record !== undefined) {
      record = options.record;
    } else {
      try {
        record = await deps.financial.load(gameId);
      } catch (error) {
        if (!(error instanceof FinancialRecordUnreadableError)) throw error;
        fin = error.format;
      }
    }
    if (fin === "current" && record === null) fin = undefined; // no financial record at all
    /* An unreadable record's class decides first (the verdict's step 1): its deal is not read at all (L4-4 review R-1:
       another build's game never costs this pool a log read, let alone a failure). */
    const identity: GameIdentityFacts = fin !== undefined && fin !== "current" ? { kind: "undealt" } : await identityOf(gameId, options.entries);
    const log: FormatFact = fin !== undefined && fin !== "current" ? "current" : await logFormatOfGame(gameId, options.entries);
    const classes = await artifactFormatsOf(gameId, fin === "current" ? record : null);
    const decision = serving.decide({ fin, record, identity, log, ...classes, ownerKey: options.ownerKey ?? null });
    decisions.set(gameId, decision);
    return { decision, record };
  }

  /** What a JOB does with a decision: `true` only when this pool continues the game. Not continued: nothing is written
   *  (noticed once). A conflict: the owning pool holds the game under its canonical code (never a closed or cancelled
   *  one, never a record it cannot read); any other pool writes nothing. */
  async function mayAct(gameId: string, found: Found, where: string): Promise<boolean> {
    const { decision, record } = found;
    if (decision.verdict.kind === "continues") return true;
    serving.notice(gameId, decision, where);
    if (decision.verdict.kind === "conflict" && decision.holdCode !== null && record !== null && record.phase !== "closed" && record.phase !== "cancelled") {
      const verdict = decision.verdict;
      const code = decision.holdCode;
      /* L4-7: a verified DEPLOYMENT conflict supersedes a weaker hold (`moneyLifecycle.ts`), so it is always written down. */
      const verifiedConflict = verdict.why === "deployment-conflict" ? { verifiedConflict: true as const } : {};
      await apply(gameId, () => ({ kind: "hold", at: deps.now(), code, detail: `${verdict.why}: ${verdict.detail}`, ...verifiedConflict }));
    }
    return false;
  }

  /** What a REQUEST does with a decision: a refusal carrying the verdict's reason (nothing written), or null. */
  function refusalOf(found: Found): { readonly code: string; readonly detail: string } | null {
    const verdict = found.decision.verdict;
    return verdict.kind === "continues" ? null : { code: verdict.why, detail: verdict.detail };
  }

  async function readGame(chainGameId: string): Promise<JunoGameResponse> {
    return parseGameResponse(await backend.rest.smart(backend.pin.contract_address, QUERY.game(chainGameId)));
  }

  async function readGameAt(chainGameId: string): Promise<{ readonly game: JunoGameResponse; readonly height: string | null }> {
    const answer = await backend.rest.smartAt(backend.pin.contract_address, QUERY.game(chainGameId));
    return { game: parseGameResponse(answer.data), height: answer.height };
  }

  /** The chain's COMPLETE signer registry (paged to its end). */
  async function readRegistry(): Promise<SignerKeyStatus[]> {
    const out: SignerKeyStatus[] = [];
    let after: number | null = null;
    for (let page = 0; page < 8; page += 1) {
      const keys = parseSignerKeysResponse(await backend.rest.smart(backend.pin.contract_address, QUERY.signerKeys(after, 30)));
      for (const key of keys) {
        out.push({ signer_key_id: key.key_id, scheme: "secp256k1-ecdsa-prehashed/rs64-low-s", public_key_hex: key.pubkey, status: key.compromised ? "compromised" : key.retired ? "retired" : "active", retired_at: null });
      }
      if (keys.length < 30) return out;
      after = keys[keys.length - 1].key_id;
    }
    throw new Error("the signer registry did not end within 8 pages");
  }

  /* ------------------------------------------------------------------ */
  /* Signing a payload into an intent (checkpoint or settle)              */
  /* ------------------------------------------------------------------ */

  type Bound = { readonly record: FinancialGameRecord; readonly binding: EscrowBindingV2; readonly roster: NonNullable<FinancialGameRecord["roster"]> };

  function boundOf(record: FinancialGameRecord | null): Bound | null {
    if (record === null || record.binding?.escrow == null || record.roster === null) return null;
    return { record, binding: record.binding.escrow, roster: record.roster };
  }

  function build(bound: Bound, input: { readonly text: string; readonly logLen: number; readonly logHashHex: string; readonly issuedAt: bigint; readonly signerKeyId: number; readonly terminal: TerminalSettlementEvidence["terminal_reason"] | null }): BuiltSettlementCoreV1 {
    const n = BigInt(bound.roster.roster.length);
    const anteNet = BigInt(bound.binding.terms.ante_net);
    return buildSettlementCoreV1(JUNO_CODEC_V1, {
      board: { canonical_text: input.text },
      bindings: bound.roster.roster.map((seat) => ({ chain_seat_index: seat.chain_seat_index, player_id: seat.player_id, payout_address: seat.payout_address })),
      domain: bound.roster.expected_domain,
      domain_inputs: junoDomainInputsOf(bound.binding, bound.roster.roster_hash),
      intent: input.terminal === null ? { kind: "Checkpoint" } : { kind: "Terminal", outcome: { reason: input.terminal }, terms: { pool_net: anteNet * n, ante_net: anteNet } },
      log_len: BigInt(input.logLen),
      log_hash: input.logHashHex,
      appraisal_log_len: BigInt(input.logLen),
      state_schema_version: SETTLEMENT_STATE_SCHEMA_VERSION,
      signer_key_id: input.signerKeyId,
      issued_at: input.issuedAt,
    });
  }

  /** F1: the journal and the chain must not be AHEAD of the durable log (a restored store would sign another history).
   *  Review #12: the chain side is its TRUSTED sequence -- a compromised key's forged high seq never holds a game. */
  async function aheadOfLog(bound: Bound, durableLogLen: number, game: JunoGameResponse): Promise<string | null> {
    const instance = escrowInstanceKey(bound.binding);
    const reserved = await deps.journal.highestReserved(instance);
    if (reserved !== null && BigInt(reserved.seq) >> BigInt(1) > BigInt(durableLogLen)) return `the signing journal has seq ${reserved.seq} reserved; the durable log has ${durableLogLen} entries`;
    if (BigInt(game.trusted_seq) >> BigInt(1) > BigInt(durableLogLen)) return `the chain's trusted sequence is ${game.trusted_seq}; the durable log has ${durableLogLen} entries`;
    if (BigInt(game.game.last_seq) > BigInt(game.trusted_seq)) deps.warn(`  escrow: ${bound.record.game_id}: the chain's last seq ${game.game.last_seq} is above its trusted seq ${game.trusted_seq} (compromised-key evidence on chain; not signed around)`);
    return null;
  }

  /** Review #1: the durable log reproduces the highest checkpoint the journal reserved for this game (rebuilt from the
   *  log's own prefix: the same digest), or the game is held. Once per game per process, before its first signature. */
  async function verifyHistory(bound: Bound): Promise<boolean> {
    const gameId = bound.record.game_id;
    if (historyVerified.has(gameId)) return true;
    const instance = escrowInstanceKey(bound.binding);
    const reservations = await deps.journal.reservations(instance);
    const checkpoints = reservations.filter((entry) => BigInt(entry.seq) % BigInt(2) === BigInt(0)).sort((a, b) => (BigInt(b.seq) > BigInt(a.seq) ? 1 : BigInt(b.seq) < BigInt(a.seq) ? -1 : 0));
    const highest = reservations.reduce((best, entry) => (BigInt(entry.seq) > best ? BigInt(entry.seq) : best), BigInt(0));
    const entries = await deps.readLog(gameId);
    if (highest >> BigInt(1) > BigInt(entries.length)) {
      await hold(gameId, "journal-ahead", `the signing journal has seq ${highest.toString()} reserved; the durable log has ${entries.length} entries`);
      return false;
    }
    const newest = checkpoints[0];
    if (newest !== undefined) {
      const L = Number(BigInt(newest.seq) >> BigInt(1));
      const prefix = entries.slice(0, L);
      const replayed = deps.replay(prefix);
      let digest: string | null = null;
      if (replayed.ok) {
        try {
          digest = build(bound, { text: canonicalStateText(replayed.board), logLen: L, logHashHex: logHash(prefix, L), issuedAt: issuedAtOf(prefix, L), signerKeyId: newest.signer_key_id, terminal: null }).settle.hex;
        } catch {
          digest = null;
        }
      }
      if (digest !== newest.digest_hex) {
        await hold(gameId, "journal-ahead", `the durable log does not reproduce the checkpoint the signing journal reserved at seq ${newest.seq} (a restored or rewritten history is never signed over)`);
        return false;
      }
    }
    historyVerified.add(gameId);
    return true;
  }

  /** Builds the intent for a signed payload at its slot; an existing intent with the same subject is the same work. */
  async function signIntoIntent(
    bound: Bound,
    kind: "checkpoint" | "settle",
    built: BuiltSettlementCoreV1,
    extra: { readonly round_key?: string },
  ): Promise<{ readonly kind: "created" | "exists"; readonly record: ChainIntentRecord } | { readonly kind: "conflict"; readonly detail: string }> {
    const instance = escrowInstanceKey(bound.binding);
    const seq = built.payload.seq.toString();
    const key: EscrowIntentKey = { op: kind, seq };
    const subject = { kind: "digest" as const, digests: [built.settle] };
    const op: ChainIntentOp =
      kind === "checkpoint"
        ? { kind: "checkpoint", chain_game_id: bound.binding.chain_game_id, seq, log_len: Number(built.payload.log_len), round_key: extra.round_key ?? "", settle_digest: built.settle.hex, signer_key_id: built.payload.signer_key_id }
        : { kind: "settle", chain_game_id: bound.binding.chain_game_id, seq, log_len: Number(built.payload.log_len), settle_digest: built.settle.hex, signer_key_id: built.payload.signer_key_id };
    /* Already prepared? The same subject is the same work (no second signature); another subject is a conflict. */
    const probe = newChainIntent({ game_id: bound.record.game_id, instance, key, subject, op, msg_json: "{}", now: deps.now() });
    const existing = await deps.intents.load(bound.record.game_id, probe.intent_id);
    if (existing !== null) {
      const same = existing.subject.kind === "digest" && existing.subject.digests.length === 1 && existing.subject.digests[0].hex === built.settle.hex && JSON.stringify(existing.op) === JSON.stringify(op);
      return same ? { kind: "exists", record: existing } : { kind: "conflict", detail: `slot ${kind} seq ${seq} already carries another payload` };
    }
    const signature = await backend.settlementSigner.signPayload({ instance, built, frozen_domain: bound.roster.expected_domain });
    const msg = kind === "checkpoint" ? RELAYER_EXECUTE.checkpoint(bound.binding.chain_game_id, built.wire, signature.signature_hex) : RELAYER_EXECUTE.settle(bound.binding.chain_game_id, built.wire, signature.signature_hex);
    const record = newChainIntent({ game_id: bound.record.game_id, instance, key, subject, op, msg_json: msg, now: deps.now() });
    const created = await deps.intents.create(record);
    if (created.kind === "failed") throw new Error(`the ${kind} intent was not written: ${created.detail}`);
    if (created.kind === "exists" && !created.same) return { kind: "conflict", detail: `slot ${kind} seq ${seq} already carries another payload` };
    deps.relayer()?.poke(record.game_id, record.intent_id);
    return { kind: created.kind === "created" ? "created" : "exists", record: created.record };
  }

  async function settlementKeyFor(bound: Bound): Promise<SettlementKeyConfig> {
    return selectSettlementKey(bound.binding, JUNO_CAPABILITIES_V1, await readRegistry(), backend.settlementKeys);
  }

  /* ------------------------------------------------------------------ */
  /* Checkpoints                                                         */
  /* ------------------------------------------------------------------ */

  /** The newest un-prepared checkpoint position of each game: one queued job per game, always building the newest
   *  (several boundaries while the chain is unreachable become ONE checkpoint, at the newest position). */
  const pendingSnapshot = new Map<string, CheckpointSnapshot>();

  async function checkpointJob(gameId: string): Promise<void> {
    const snapshot = pendingSnapshot.get(gameId);
    if (snapshot === undefined) return;
    pendingSnapshot.delete(gameId);
    try {
      await checkpointAt(snapshot);
    } catch (error) {
      /* Not prepared (the chain unreachable, a signer outage): the position is kept for the sweep, and forgotten
         in memory so the next committed batch also tries again -- whichever comes first builds the NEWEST one. */
      if (!pendingSnapshot.has(gameId)) retrySnapshot.set(gameId, snapshot);
      const record = await deps.financial.load(gameId).catch(() => null);
      const prepared = record?.chain.checkpoint_prepared ?? null;
      if (prepared === null) lastRound.delete(gameId);
      else lastRound.set(gameId, { round_key: prepared.round_key, log_len: prepared.log_len });
      throw error;
    }
  }

  /** Checkpoint positions whose job failed, retried by the sweep (a stalled game makes no new commit to retry them). */
  const retrySnapshot = new Map<string, CheckpointSnapshot>();

  async function checkpointAt(snapshot: CheckpointSnapshot): Promise<void> {
    /* LIVE-4 (L4-4): the verdict FIRST -- from the committed entries this position was taken from -- and only a game this
       pool continues is moved at all (F-L4-3: the deal was written before the pin was asked). */
    const found = await servingOf(snapshot.game_id, { entries: snapshot.entries });
    if (!(await mayAct(snapshot.game_id, found, "checkpoint"))) return;
    let record = found.record;
    if (record !== null && record.phase === "funding" && record.chain.started !== null) {
      /* The escrow started and the game is being played: the deal, derived (the coordinator derives it too). */
      record = await apply(snapshot.game_id, (current) => (current.phase === "funding" ? { kind: "dealt", at: deps.now() } : null));
    }
    const bound = boundOf(record);
    if (bound === null || record === null) return;
    if (!["in-progress", "liveness", "terminal-eligible", "intent-prepared"].includes(record.phase) || record.chain.started === null) return;
    const prepared = record.chain.checkpoint_prepared;
    if (prepared !== null && prepared.log_len >= snapshot.log_len) return; // this position (or a newer one) is prepared
    if (!(await verifyHistory(bound))) return;
    const game = await readGame(bound.binding.chain_game_id);
    if (game.game.state !== "IN_PROGRESS") return; // the chain has moved on (a checkpoint would be refused)
    const ahead = await aheadOfLog(bound, snapshot.entries.length, game);
    if (ahead !== null) {
      await hold(snapshot.game_id, "journal-ahead", ahead);
      return;
    }
    const key = await settlementKeyFor(bound);
    let built: BuiltSettlementCoreV1;
    try {
      built = build(bound, { text: snapshot.canonical_text, logLen: snapshot.log_len, logHashHex: logHash(snapshot.entries, snapshot.log_len), issuedAt: snapshot.issued_at, signerKeyId: key.signer_key_id, terminal: null });
    } catch (error) {
      /* The appraiser refuses this board (a position it cannot value): no checkpoint here; the next boundary tries. */
      stats.skipped += 1;
      audit("checkpoint.skipped", { game_id: snapshot.game_id, log_len: snapshot.log_len, round_key: snapshot.round_key, why: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      return;
    }
    let outcome: Awaited<ReturnType<typeof signIntoIntent>>;
    try {
      outcome = await signIntoIntent(bound, "checkpoint", built, { round_key: snapshot.round_key });
    } catch (error) {
      if (error instanceof SignerError && error.code === "journal-conflict") {
        await hold(snapshot.game_id, "journal-ahead", error.message);
        return;
      }
      throw error;
    }
    if (outcome.kind === "conflict") {
      await hold(snapshot.game_id, "evidence-conflict", outcome.detail);
      return;
    }
    stats.checkpoints += outcome.kind === "created" ? 1 : 0;
    if (outcome.kind === "created") audit("checkpoint.intent", { game_id: snapshot.game_id, seq: built.payload.seq.toString(), log_len: snapshot.log_len, round_key: snapshot.round_key, intent_id: outcome.record.intent_id, signer_key_id: key.signer_key_id });
    await apply(snapshot.game_id, () => ({ kind: "checkpoint-prepared", at: deps.now(), seq: built.payload.seq.toString(), log_len: snapshot.log_len, round_key: snapshot.round_key, intent_id: outcome.kind === "conflict" ? "" : outcome.record.intent_id }));
  }

  /* ------------------------------------------------------------------ */
  /* Terminal: the checkpoint at the seal, then the Settle                */
  /* ------------------------------------------------------------------ */

  async function settleJob(gameId: string): Promise<void> {
    /* The verdict first (the deal read-only); the sealed prefix is read only for a game this pool continues. */
    const found = await servingOf(gameId);
    if (!(await mayAct(gameId, found, "settle"))) return;
    const entries = await deps.readLog(gameId);
    const record = found.record;
    const bound = boundOf(record);
    if (record === null || bound === null || record.phase !== "intent-prepared" || record.intent === null || record.terminal === null) return;
    const evidence = record.intent;
    const L = evidence.log_len;
    if (entries.length < L) {
      await hold(gameId, "journal-ahead", `the durable log has ${entries.length} entries; the sealed settlement names ${L}`);
      return;
    }
    const prefix = entries.slice(0, L);
    const replayed = deps.replay(prefix);
    if (!replayed.ok) {
      await hold(gameId, "evidence-mismatch", `the sealed prefix no longer replays: ${replayed.reason.slice(0, 200)}`);
      return;
    }
    const text = canonicalStateText(replayed.board);
    if (!(await verifyHistory(bound))) return;
    const game = await readGame(bound.binding.chain_game_id);
    const ahead = await aheadOfLog(bound, entries.length, game);
    if (ahead !== null) {
      await hold(gameId, "journal-ahead", ahead);
      return;
    }
    const key = await settlementKeyFor(bound);
    const issuedAt = issuedAtOf(prefix, L);
    const logHashHex = logHash(prefix, L);
    let terminal: BuiltSettlementCoreV1;
    let checkpoint: BuiltSettlementCoreV1;
    try {
      terminal = build(bound, { text, logLen: L, logHashHex, issuedAt, signerKeyId: key.signer_key_id, terminal: evidence.terminal_reason });
      checkpoint = build(bound, { text, logLen: L, logHashHex, issuedAt, signerKeyId: key.signer_key_id, terminal: null });
    } catch (error) {
      await hold(gameId, "evidence-mismatch", `the sealed board does not build a settlement: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
      return;
    }
    /* Brief §13: the payload corresponds EXACTLY to the persisted intent, or the game is held (never "repaired"). */
    const mismatch = compareWithEvidence(terminal, evidence, bound);
    if (mismatch !== null) {
      await hold(gameId, "evidence-mismatch", mismatch);
      return;
    }
    try {
      if (game.game.state === "IN_PROGRESS") {
        /* The terminal checkpoint first (seq 2L): a liveness exit while Settle cannot land still pays this appraisal. */
        const cp = await signIntoIntent(bound, "checkpoint", checkpoint, { round_key: roundKeyOf(replayed.board) });
        if (cp.kind === "conflict") {
          /* The GameEnd boundary checkpoint was built from the live board at the same position: it must be identical. */
          await hold(gameId, "evidence-conflict", cp.detail);
          return;
        }
        if (cp.kind === "created") stats.checkpoints += 1;
        await apply(gameId, () => ({ kind: "checkpoint-prepared", at: deps.now(), seq: checkpoint.payload.seq.toString(), log_len: L, round_key: roundKeyOf(replayed.board), intent_id: cp.record.intent_id }));
      }
      const settled = await signIntoIntent(bound, "settle", terminal, {});
      if (settled.kind === "conflict") {
        await hold(gameId, "evidence-conflict", settled.detail);
        return;
      }
      if (settled.kind === "created") {
        stats.settles += 1;
        audit("settlement.intent-submitted", { game_id: gameId, seq: terminal.payload.seq.toString(), log_len: L, settle_digest: terminal.settle.hex, intent_id: settled.record.intent_id, signer_key_id: key.signer_key_id });
      }
    } catch (error) {
      if (error instanceof SignerError && error.code === "journal-conflict") {
        await hold(gameId, "journal-ahead", error.message);
        return;
      }
      throw error;
    }
  }

  function compareWithEvidence(built: BuiltSettlementCoreV1, evidence: TerminalSettlementEvidence, bound: Bound): string | null {
    if (built.payload.log_hash !== evidence.log_hash) return "the log hash differs from the persisted intent";
    if (built.payload.appraisal_state_hash !== evidence.appraisal_state_hash) return "the appraisal state hash differs from the persisted intent";
    if (built.payload.log_len !== BigInt(evidence.log_len) || built.payload.appraisal_log_len !== BigInt(evidence.appraisal_log_len)) return "the sealed length differs from the persisted intent";
    const weights = built.payload.settlement_weights;
    for (let i = 0; i < bound.roster.roster.length; i += 1) {
      const total = evidence.totals[bound.roster.roster[i].player_id];
      if (total === undefined || BigInt(total) !== weights[i]) return `chain seat ${i}'s weight differs from the persisted appraisal`;
    }
    if (Object.keys(evidence.totals).length !== bound.roster.roster.length) return "the persisted appraisal names another roster";
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* After the chain moves                                               */
  /* ------------------------------------------------------------------ */

  async function ensureFinalize(bound: Bound, seq: string, digestHex: string): Promise<void> {
    const instance = escrowInstanceKey(bound.binding);
    const record = newChainIntent({
      game_id: bound.record.game_id,
      instance,
      key: { op: "finalize", seq },
      subject: { kind: "digest", digests: [{ codec: "18JUNO/v1", purpose: "settle", hex: digestHex }] },
      op: { kind: "finalize", chain_game_id: bound.binding.chain_game_id, seq },
      msg_json: RELAYER_EXECUTE.finalize(bound.binding.chain_game_id),
      now: deps.now(),
    });
    const created = await deps.intents.create(record);
    if (created.kind === "failed") throw new Error(`the finalize intent was not written: ${created.detail}`);
    if (created.kind === "exists" && !created.same) {
      await hold(bound.record.game_id, "chain-inconsistent", `the finalize slot at seq ${seq} carries another settlement`);
      return;
    }
    if (created.kind === "created") {
      stats.finalizes += 1;
      audit("settlement.finalize-intent", { game_id: bound.record.game_id, seq, intent_id: record.intent_id });
    }
    deps.relayer()?.poke(record.game_id, record.intent_id);
  }

  /** Review #6: a stored settlement is finalized automatically only when THIS server signed it -- the game's own settle
   *  intent (a terminal payload) or one of its own checkpoint intents (a promoted liveness checkpoint), same seq, same
   *  digest. Anything else stored for the game is a contradiction the operator (or a seat's challenge) decides. */
  async function ownSettlement(bound: Bound, seq: string, digestHex: string): Promise<boolean> {
    const instance = escrowInstanceKey(bound.binding);
    for (const op of ["settle", "checkpoint"] as const) {
      const probe = newChainIntent({ game_id: bound.record.game_id, instance, key: { op, seq }, subject: { kind: "digest", digests: [] }, op: { kind: "finalize", chain_game_id: bound.binding.chain_game_id, seq }, msg_json: "{}", now: 0 });
      const mine = await deps.intents.load(bound.record.game_id, probe.intent_id);
      if (mine !== null && (mine.op.kind === "settle" || mine.op.kind === "checkpoint") && mine.op.settle_digest === digestHex && mine.op.seq === seq) return true;
    }
    /* FP4 (escrow 2.1.0): a third-strike foreclosure is stored as a settlement whose digest is the REMEDY digest and
       whose seq is 2*log_len + 1 -- this server's when its own remedy intent relayed exactly that attestation. */
    const remedies = (await deps.intents.listGame(bound.record.game_id)).filter((intent) => intent.op.kind === "remedy" && intentBelongsTo(intent, instance));
    return remedies.some((intent) => intent.op.kind === "remedy" && intent.op.remedy === 3 && intent.op.remedy_digest === digestHex && (BigInt(intent.op.log_len) * BigInt(2) + BigInt(1)).toString() === seq);
  }

  /** What the chain says now, as lifecycle events (the chain wins). A HELD game is observed (its chain outcome is
   *  recorded) but nothing new is submitted for it (review #6); a game pinned elsewhere is not read here at all (#5). */
  async function observeChain(gameId: string): Promise<void> {
    const found = await servingOf(gameId);
    const record = found.record;
    /* No record (or an unreadable one): nothing to observe here. A MISSING record is the settlement coordinator's to
       judge -- it holds the GameRecord's terms, so it knows the owner (review R-5). */
    if (record === null || record.binding?.escrow == null || record.phase === "closed" || record.phase === "cancelled") return;
    if (!(await mayAct(gameId, found, "observe"))) return;
    const binding = record.binding.escrow;
    const response = await readGame(binding.chain_game_id);
    const g = response.game;
    if (g.state === "SETTLED" || g.state === "ANNULLED" || g.state === "CANCELLED") {
      await apply(gameId, () => ({ kind: "chain-closed", at: deps.now(), state: g.state as "SETTLED" | "ANNULLED" | "CANCELLED", route: g.outcome?.route ?? "unknown" }));
      return;
    }
    const bound = boundOf(record);
    if (bound === null) return;
    if (g.roster_hash !== null && record.chain.started === null) {
      if (g.roster_hash !== bound.roster.roster_hash) {
        await hold(gameId, "chain-inconsistent", "the escrow started with another roster");
        return;
      }
      await apply(gameId, () => ({ kind: "chain-started", at: deps.now(), height: "0", domain: g.domain ?? "" }));
    }
    if (record.phase === "held") return;
    if (g.state === "DISPUTED") {
      /* JX-6B: also from `intent-prepared` -- the Challenge may land before this server ever observed SETTLEABLE. */
      await apply(gameId, (current) => ((current.phase === "settleable" || current.phase === "intent-prepared") && g.settlement !== null ? { kind: "chain-disputed", at: deps.now() } : null));
      return;
    }
    if (g.state === "SETTLEABLE" && g.settlement !== null) {
      const stored = g.settlement;
      const ours = await ownSettlement(bound, stored.payload.seq, stored.payload.payload_digest);
      if (!ours) {
        await hold(gameId, "chain-inconsistent", `a ${stored.source} settlement (seq ${stored.payload.seq}) this server did not sign is stored on chain; nothing is finalized automatically`);
        return;
      }
      if (stored.source === "terminal_payload" && record.intent !== null && stored.payload.seq === (BigInt(record.intent.log_len) * BigInt(2) + BigInt(1)).toString()) {
        await apply(gameId, () => ({ kind: "chain-settleable", at: deps.now(), seq: stored.payload.seq, window_end_secs: stored.window_end_secs }));
      }
      /* Ours (our Settle, or our checkpoint a liveness exit promoted): finalized after its window. */
      await ensureFinalize(bound, stored.payload.seq, stored.payload.payload_digest);
    }
  }

  /* ------------------------------------------------------------------ */
  /* The Start of a roster freeze: permanent, pending, or released        */
  /* ------------------------------------------------------------------ */

  function startIntentOf(gameId: string, binding: EscrowBindingV2, rosterHash: string, epoch: number): ChainIntentRecord {
    return newChainIntent({
      game_id: gameId,
      instance: startInstanceOf(escrowInstanceKey(binding), epoch),
      key: { op: "start" },
      subject: { kind: "roster", roster_hash: rosterHash },
      op: { kind: "start", chain_game_id: binding.chain_game_id, roster_hash: rosterHash },
      msg_json: RELAYER_EXECUTE.start(binding.chain_game_id, rosterHash),
      now: deps.now(),
    });
  }

  /** Review 2 #4: a record that looks roster-less may be a RESTORED one (behind the intents, the journal or the chain).
   *  Evidence of a later freeze -- the next epoch's Start intent, a journalled attempt of it, or an escrow that
   *  started -- means the ledger freeze is the record's missing future, never a leftover to release. */
  async function recordBehind(gameId: string, binding: EscrowBindingV2, epoch: number): Promise<{ readonly code: FinancialHoldCode; readonly detail: string } | null> {
    const next = startIntentOf(gameId, binding, "00".repeat(32), epoch + 1);
    const later = await deps.intents.load(gameId, next.intent_id);
    if (later !== null || (await deps.journal.attemptsOf(next.intent_id)).length > 0) {
      return { code: "journal-ahead", detail: `a Start of roster epoch ${epoch + 1} exists, but the financial record has no frozen roster (a restored record is never re-frozen over it)` };
    }
    const g = (await readGame(binding.chain_game_id)).game;
    if (g.roster_hash !== null) return { code: "chain-inconsistent", detail: "the escrow started, but the financial record has no frozen roster" };
    return null;
  }

  /**
   * THE REVERSIBLE FREEZE, decided from chain truth (the user's 3B ruling). For the current freeze of a funding game:
   *   - the escrow shows THIS roster started            -> chain-started: the freeze is permanent (also "confirmed but the
   *                                                        answer was lost": the chain says so, whatever the relayer saw);
   *   - its Start intent is pending, in flight, or has a live attempt -> the freeze stands (an RPC failure, a lost answer,
   *                                                        an unknown outcome never releases anything);
   *   - its Start intent is TERMINAL without effect (superseded: the seats changed, the escrow was cancelled; or held: a
   *     refusal an operator would have to lift) with no live attempt, every journalled attempt of it known and resolved,
   *     and the escrow -- read AT OR ABOVE the height that resolved each attempt -- shows no Start
   *                                                     -> RELEASED: the ledger's freeze (by its token), then the roster.
   *                                                        The table is back to its pre-Start funded state: players may
   *                                                        withdraw on chain, or freeze again (a new epoch, a new slot).
   * A restart reaches the same answer: every input is durable (the record, the intent, the journal) or the chain's.
   */
  function reconcileStart(gameId: string): Promise<StartReconciliation> {
    /* L6-2 (review M1): a restored money game is read-only until verified -- its freeze is neither made permanent,
       released nor its Start rewritten; the load's and the sweeps' next pass decide it once verified. */
    if (restoreGate(gameId) !== null) return Promise.resolve("pending");
    return exclusive(gameId, async (): Promise<StartReconciliation> => {
      const found = await servingOf(gameId);
      const record = found.record;
      if (record === null || record.binding?.escrow == null) return "none";
      if (!(await mayAct(gameId, found, "start reconciliation"))) return found.decision.holdCode !== null ? "held" : "none";
      if (record.phase === "held") return "held";
      const binding = record.binding.escrow;
      if (record.roster === null) {
        /* A ledger freeze with no financial roster: a crash between the two writes of a freeze, or of a release. The
           record is the authority: the ledger follows it -- unless something says the record is BEHIND (review 2 #4). */
        if (record.phase === "funding" && record.chain.started === null) {
          const token = await deps.tickets.frozenAt(gameId);
          if (token !== null) {
            const behind = await recordBehind(gameId, binding, record.roster_epoch);
            if (behind !== null) {
              await hold(gameId, behind.code, behind.detail);
              return "held";
            }
            if ((await deps.tickets.unfreeze(gameId, token)) === "committed") audit("money.ticket-freeze-released", { game_id: gameId, why: "no financial roster is frozen" });
          }
        }
        return "none";
      }
      if (record.chain.started !== null || record.phase !== "funding") return "started";
      const roster = record.roster;
      const epoch = record.roster_epoch;
      const wanted = startIntentOf(gameId, binding, roster.roster_hash, epoch);
      const existing = await deps.intents.load(gameId, wanted.intent_id);
      if (existing === null) {
        /* The roster froze and the process stopped before the Start intent was written: write it (same slot, same subject). */
        const created = await deps.intents.create(wanted);
        if (created.kind === "failed") throw new Error(`the start intent was not written: ${created.detail}`);
        if (created.kind === "exists" && !created.same) {
          await hold(gameId, "binding-conflict", "the start slot carries another roster");
          return "held";
        }
        deps.relayer()?.poke(gameId, wanted.intent_id);
        return "pending";
      }
      if (!sameChainIntent(existing, wanted)) {
        await hold(gameId, "binding-conflict", "the start slot carries another roster");
        return "held";
      }
      const read = await readGameAt(binding.chain_game_id);
      const g = read.game.game;
      if (g.roster_hash !== null) {
        if (g.roster_hash !== roster.roster_hash) {
          await hold(gameId, "chain-inconsistent", "the escrow started with another roster");
          return "held";
        }
        const next = await apply(gameId, () => ({ kind: "chain-started", at: deps.now(), height: existing.confirmation?.height ?? read.height ?? "0", domain: g.domain ?? "" }));
        if (next !== null && next.chain.started !== null) audit("money.chain-started", { game_id: gameId, epoch, roster_hash: roster.roster_hash });
        return next?.phase === "held" ? "held" : "started";
      }
      if (g.state === "CANCELLED") {
        /* The table's own lifecycle speaks (chain-closed below): a cancelled escrow is not a Start to release. */
        await apply(gameId, () => ({ kind: "chain-closed", at: deps.now(), state: "CANCELLED", route: g.outcome?.route ?? "unknown" }));
        return "none";
      }
      if (existing.status === "pending" || existing.status === "in-flight" || existing.status === "confirmed" || existing.attempts.some(isLiveAttempt)) {
        if (existing.status !== "confirmed") deps.relayer()?.poke(gameId, existing.intent_id);
        return "pending";
      }
      /* Terminal without effect (superseded or held), nothing live. Every journalled attempt must be one the intent
         knows (a restored or failed store may not): an unknown one counts only once the chain has SPENT its sequence. */
      let needed = BigInt(0);
      const known = new Set(existing.attempts.map((attempt) => attempt.tx_hash));
      /* Each attempt can never land after a height: its resolution's (inclusion, death proof, the read that found its
         sequence spent). One resolved by a node that did not say its height (review 2 #2), and a journalled attempt the
         intent never held (a failed or restored store, review 2 #1), are proven from a fresh account read AT a stated
         height: its sequence spent, or that height above the attempt's journalled expiry. */
      const unproven: Array<{ readonly account: string; readonly sequence: string; readonly expires: string | null; readonly what: string }> = [];
      for (const attempt of existing.attempts) {
        if (attempt.resolved_height !== null) {
          if (BigInt(attempt.resolved_height) > needed) needed = BigInt(attempt.resolved_height);
        } else unproven.push({ account: attempt.account, sequence: attempt.sequence, expires: attempt.timeout_height, what: `attempt ${attempt.n} (resolved without a height)` });
      }
      for (const entry of await deps.journal.attemptsOf(existing.intent_id)) {
        if (!known.has(entry.tx_id)) unproven.push({ account: entry.account, sequence: entry.sequence, expires: entry.expires_after_height ?? null, what: `a journalled attempt the intent does not hold (sequence ${entry.sequence})` });
      }
      for (const item of unproven) {
        const account = await backend.rest.account(item.account);
        const spent = account !== null && account.height !== null && BigInt(account.sequence) > BigInt(item.sequence);
        const expired = account !== null && account.height !== null && item.expires !== null && BigInt(account.height) > BigInt(item.expires);
        if (account === null || account.height === null || !(spent || expired)) return waitProof(gameId, `${item.what} may still land`);
        if (BigInt(account.height) > needed) needed = BigInt(account.height);
      }
      if (read.height === null || BigInt(read.height) < needed) return waitProof(gameId, `the escrow was read at height ${read.height ?? "?"}, below the proof height ${needed.toString()}`);
      if (existing.status === "held") {
        const next = supersededIntent(existing, `released: the escrow shows no Start at height ${read.height} (${existing.hold?.code ?? "held"})`, deps.now());
        const put = await deps.intents.put(next, existing.record_version);
        if (put.kind !== "committed") return "pending";
      }
      const why = existing.status === "superseded" ? existing.superseded?.why ?? "superseded" : existing.hold?.detail ?? "held";
      const unfrozen = await deps.tickets.unfreeze(gameId, roster.frozen_at);
      /* LIVE-5 L5-2 (F-L5-6): an UNCERTAIN release of the ledger freeze is not "another freeze": nothing is released on
         an unknown outcome, and the next reconciliation repeats it (an unfreeze by this token is idempotent). */
      if (unfrozen === "uncertain") return waitProof(gameId, "the ticket ledger's release is unresolved");
      if (unfrozen !== "committed") {
        await hold(gameId, "binding-conflict", "the ticket ledger is frozen by another freeze than the financial roster's");
        return "held";
      }
      const next = await apply(gameId, () => ({ kind: "roster-released", at: deps.now(), epoch, roster_hash: roster.roster_hash, why: `the escrow shows no Start at height ${read.height} (${g.state}); ${why}` }));
      if (next === null || next.roster !== null) return next?.phase === "held" ? "held" : "pending";
      audit("money.roster-released", { game_id: gameId, epoch, roster_hash: roster.roster_hash, chain_state: g.state, height: read.height, why: why.slice(0, 200) });
      deps.warn(`  escrow: ${gameId}: the Start of roster epoch ${epoch} is proven not to have happened (${g.state} at height ${read.height}); the table is back to its pre-Start funded state`);
      return "released";
    });
  }

  function waitProof(gameId: string, why: string): StartReconciliation {
    deps.warn(`  escrow: ${gameId}: the Start is not yet PROVEN not to have happened (${why}); the roster stays frozen`);
    return "pending";
  }

  /* ------------------------------------------------------------------ */
  /* The roster freeze and the deal                                      */
  /* ------------------------------------------------------------------ */

  async function liveView(bound: { binding: EscrowBindingV2 }) {
    const [response, configRaw, block] = await Promise.all([
      readGame(bound.binding.chain_game_id),
      backend.rest.smart(backend.pin.contract_address, QUERY.config()),
      backend.rest.latestBlock(),
    ]);
    const config = parseConfigResponse(configRaw);
    return { response, view: junoGameView(escrowInstanceKey(bound.binding), response, config, { height: block.height, block_time: block.time }) };
  }

  const rosterSource: RosterSource = {
    async plan(record: GameRecord, ctx: { shuffle: <T>(items: readonly T[]) => T[]; now: number }): Promise<StartPlan | StartRefusal> {
      const refuse = (reason: string): StartRefusal => ({ refusal: "wrong-state", code: "wrong-state", reason });
      const found = await servingOf(record.game_id).catch(() => null);
      const financial = found?.record ?? null;
      const bound = boundOf(financial);
      if (found === null || financial === null || bound === null) return refuse("This money table's escrow is not ready.");
      if (financial.phase !== "funding" || financial.chain.started === null) return refuse("The escrow has not started this game yet.");
      if (refusalOf(found) !== null) return refuse("This server cannot deal this money table.");
      const { response, view } = await liveView(bound);
      if (view.state !== "IN_PROGRESS" || view.roster_hash !== bound.roster.roster_hash || view.domain !== bound.roster.expected_domain) return refuse("The escrow does not show this table started with its frozen roster.");
      /* The chain's commitment is each chain seat's WALLET (the roster hash is over wallets, in order); the freeze proved
         each wallet is its player's. A seat's own wallet re-joining with another ticket (the contract accepts any) does
         not change who is paid, so it never blocks the deal (review 2 #3) -- it is recorded for the operator. */
      for (const seat of bound.roster.roster) {
        const chainSeat = view.seats[seat.chain_seat_index];
        if (chainSeat === undefined || chainSeat.payout_address !== seat.payout_address) return refuse("The escrow's roster changed after it was frozen.");
        if (chainSeat.join_ticket_hex !== seat.join_ticket_hex) audit("money.seat-ticket-changed", { game_id: record.game_id, chain_seat_index: seat.chain_seat_index });
      }
      if (response.game.resolver === null || !backend.trust.resolvers.includes(response.game.resolver)) return refuse("The escrow's resolver for this game is not an accepted resolver.");
      if (bound.roster.roster.length !== record.seats.length || !record.seats.every((seat) => bound.roster.roster.some((entry) => entry.player_id === seat.player_id))) {
        return refuse("The table's seats are not the frozen financial roster.");
      }
      /* Review #10: the variants dealt are the ones the escrow committed to (recomputed from the table's own record). */
      if (variantsDigestV1(record.variants) !== bound.binding.commitments.variants_digest) return refuse("The table's variants are not the ones the escrow committed to.");
      return { turnOrder: ctx.shuffle(record.seats), variants: record.variants };
    },
  };

  /** A quorum read (every configured endpoint agreeing) of one game: the money layer's write-once decisions use it. */
  async function readGameQuorum(chainGameId: string): Promise<JunoGameResponse> {
    const rest = backend.rest;
    const data = rest.smartQuorum !== undefined ? await rest.smartQuorum(backend.pin.contract_address, QUERY.game(chainGameId)) : await rest.smart(backend.pin.contract_address, QUERY.game(chainGameId));
    return parseGameResponse(data);
  }

  /** The binding, from a chain read, write-once (3B's `bindChainGame`); with `expect` (ESCROW-4 W-13), the host's
   *  CreateGame must also be exactly the one the table expects -- read by quorum. */
  async function bindChecked(gameId: string, chainGameId: string, variants: GameVariants, expect: HostBindExpectation | null): Promise<{ readonly ok: true; readonly binding: EscrowBindingV2 } | ServiceRefusal> {
    if (!ready()) return { ok: false, code: "not-verified", detail: "financial mode is not verified against the chain" };
    const found = await servingOf(gameId);
    const record = found.record;
    if (record === null) return { ok: false, code: "not-found", detail: "no money record" };
    const refused = refusalOf(found);
    if (refused !== null) return { ok: false, ...refused };
    if (record.continuation === null) return { ok: false, code: "held", detail: "the money record has no continuation identity" };
    const [contract, response, configRaw] = await Promise.all([
      backend.rest.contract(backend.pin.contract_address),
      expect === null ? readGame(chainGameId) : readGameQuorum(chainGameId),
      backend.rest.smart(backend.pin.contract_address, QUERY.config()),
    ]);
    const checksum = await backend.rest.codeChecksum(contract.code_id);
    const config = parseConfigResponse(configRaw);
    const g = response.game;
    /* FP4 (escrow 2.1.0): this build binds only a chain game funded under an exit policy it serves -- a Live game on
       the 20-minute action clock. A game stored by escrow 2.0.0 code (no policy: an older game of a migrated
       deployment) is financial protocol 3's; an async game's deadline class (its pace, or none) is the table's choice,
       which no table records yet (the server clock lane), so it is not bound under terms nobody at the table chose. */
    const policyProblem =
      (g.policy ?? null) === null
        ? "the chain game was stored by escrow 2.0.0 code (no exit policy): financial protocol 3's, not this build's"
        : g.mode !== 0
          ? "an async money table's deadline class (its pace, or no deadline) is not recorded by any table yet"
          : g.policy !== "timed_remedy_v1"
            ? `the chain game's exit policy is ${String(g.policy)}, not the Live action clock`
            : null;
    if (policyProblem !== null) return { ok: false, code: expect !== null ? "not-the-hosts-escrow" : "terms-mismatch", detail: policyProblem };
    if (expect !== null) {
      const refusal = (detail: string) => ({ ok: false as const, code: "not-the-hosts-escrow", detail });
      if (g.chain_game_id !== chainGameId) return refusal("the chain answered for another game");
      if (g.state !== "FUNDING") return refusal(`the chain game is ${g.state}, not FUNDING`);
      if (g.creator !== expect.creator) return refusal("the chain game's creator is not the host's linked wallet");
      if (g.seats.length !== 1) return refusal(`the chain game has ${g.seats.length} seats; a host's own CreateGame has exactly one`);
      if (g.seats[0].wallet !== expect.creator) return refusal("chain seat 0 is not the creator's");
      if (g.seats[0].join_ticket !== expect.ticket) return refusal("chain seat 0 does not carry the host seat's current ticket");
      if (g.ante_gross !== expect.anteGross) return refusal(`the chain game's ante is ${g.ante_gross}; the table's is ${expect.anteGross}`);
      if (g.max_players !== expect.maxPlayers) return refusal(`the chain game is for ${g.max_players} players; the table is for ${expect.maxPlayers}`);
      if (g.mode !== expect.mode) return refusal("the chain game's pace is not the table's");
      if (g.denom !== backend.pin.denom) return refusal("the chain game's denomination is not the pinned one");
    }
    if (g.rules_engine_version !== record.continuation.rules_engine_version) return { ok: false, code: "terms-mismatch", detail: `the chain game pins rules ${g.rules_engine_version}; the table pins ${record.continuation.rules_engine_version}` };
    const digest = variantsDigestV1(variants);
    if (g.variants_digest !== digest) return { ok: false, code: "terms-mismatch", detail: "the chain game's variants digest is not this table's" };
    const binding: EscrowBindingV2 = {
      binding_schema: 2,
      backend: "juno-cosmwasm",
      codec: "18JUNO/v1",
      network: { chain_id: backend.pin.chain_id, network_class: backend.pin.network_class },
      deployment: { kind: "juno-cosmwasm", contract_address: backend.pin.contract_address, code_id: contract.code_id, code_checksum: checksum, contract_name: config.contract_name, contract_version: config.contract_version, admin: contract.admin },
      chain_game_id: g.chain_game_id,
      custody: { kind: "contract-ledger" },
      asset: { denom: g.denom, exponent: 6, symbol: backend.symbol },
      terms: { ante_gross: g.ante_gross, ante_net: g.ante_net, max_players: g.max_players, mode: g.mode },
      commitments: { rules_engine_version: g.rules_engine_version, variants_digest: g.variants_digest },
      bound_at: deps.now(),
    };
    try {
      validateEscrowBindingV2(binding, backend.policy);
    } catch (error) {
      return { ok: false, code: "binding-invalid", detail: error instanceof Error ? error.message : String(error) };
    }
    if (chainGameId !== g.chain_game_id) return { ok: false, code: "terms-mismatch", detail: "the chain answered for another game" };
    /* Review #9: a repeated bind of the SAME chain game (every chain-read fact equal; only the bind time differs) is the
       existing binding -- never a second, "different" one that holds the game. */
    const withoutTime = (value: EscrowBindingV2) => JSON.stringify({ ...value, bound_at: 0 });
    if (record.binding?.escrow != null) {
      return withoutTime(record.binding.escrow) === withoutTime(binding) ? { ok: true, binding: record.binding.escrow } : { ok: false, code: "binding-conflict", detail: "this money game is bound to another chain game" };
    }
    const next = await apply(gameId, () => ({ kind: "bound", at: deps.now(), escrow: binding }));
    if (next === null || next.binding?.escrow == null || withoutTime(next.binding.escrow) !== withoutTime(binding)) {
      return { ok: false, code: next?.phase === "held" ? "held" : "binding-conflict", detail: next?.hold?.detail ?? "the chain game was not bound" };
    }
    audit("money.bound", { game_id: gameId, chain_game_id: g.chain_game_id, code_checksum: checksum, deployment: deploymentId(binding.deployment), ...(expect !== null ? { w13: true } : {}) });
    return { ok: true, binding: next.binding.escrow };
  }

  /* ------------------------------------------------------------------ */
  /* ESCROW-4: relaying the players' own CONSENT and ANNUL signatures    */
  /* ------------------------------------------------------------------ */

  const SIGNATURE_HEX = /^[0-9a-f]{128}$/;
  const refuse = (code: string, detail: string): ServiceRefusal => ({ ok: false, code, detail });

  /** The bound game, readable for a relay (not held; this deployment's), or a refusal. */
  async function relayable(gameId: string): Promise<{ readonly bound: Bound } | ServiceRefusal> {
    if (!ready()) return refuse("not-verified", "financial mode is not verified against the chain");
    const found = await servingOf(gameId);
    const record = found.record;
    const bound = boundOf(record);
    if (record === null || bound === null) return refuse("not-bound", "the table's escrow has no frozen roster");
    const refused = refusalOf(found);
    if (refused !== null) return refuse(refused.code, refused.detail);
    if (record.phase === "held") return refuse("held", "this table's money is held for an operator; nothing is relayed");
    return { bound };
  }

  /** A signature by the chain's CURRENT key of `seat`, registered by the seat's owner, over `digest`. */
  function seatSignatureProblem(seat: { readonly consent_pubkey: string } | undefined, registeredKeys: readonly string[], digestHex: string, signature: string): ServiceRefusal | null {
    if (seat === undefined) return refuse("no-seat", "the escrow has no such chain seat");
    if (!registeredKeys.includes(seat.consent_pubkey)) return refuse("key-not-registered", "this seat's current consent key on Juno was not registered with \"Confirm it's you\"");
    if (typeof signature !== "string" || !SIGNATURE_HEX.test(signature)) return refuse("request-invalid", "the signature is not 64 bytes of lowercase hex");
    if (!verifyDigest(Buffer.from(seat.consent_pubkey, "hex"), Buffer.from(digestHex, "hex"), Buffer.from(signature, "hex"))) {
      return refuse("wrong-key", "the signature is not by this seat's current consent key over this settlement (it may have moved; sign again)");
    }
    return null;
  }

  async function relayConsent(input: { readonly gameId: string; readonly chainSeatIndex: number; readonly signature: string; readonly registeredKeys: readonly string[] }) {
    /* LIVE-6 L6-2: post-restore safe mode -- nothing is relayed for a restored money game before its verification. */
    const restoring = restoreRefusal(input.gameId);
    if (restoring !== null) return restoring;
    const found = await relayable(input.gameId);
    if (!("bound" in found)) return found;
    const { bound } = found;
    const binding = bound.binding;
    const response = await readGame(binding.chain_game_id);
    const g = response.game;
    if (g.state !== "SETTLEABLE" || g.settlement === null) return refuse("not-settleable", `the escrow is ${g.state}; a consent is for a stored settlement`);
    const stored = g.settlement;
    /* Only a settlement this server signed is ever consented to through it (anything else holds the game, 3B #6). */
    if (!(await ownSettlement(bound, stored.payload.seq, stored.payload.payload_digest))) return refuse("not-ours", "the stored settlement was not signed by this server");
    if (g.domain === null) return refuse("not-settleable", "the escrow has no domain");
    const index = input.chainSeatIndex;
    const seat = Number.isInteger(index) && index >= 0 ? g.seats[index] : undefined;
    const digest = consentDigestV1(g.domain, BigInt(stored.payload.seq), stored.payload.payload_digest);
    const problem = seatSignatureProblem(seat, input.registeredKeys, digest, input.signature);
    if (problem !== null) return problem;
    const key = (seat as { consent_pubkey: string }).consent_pubkey;
    if ((g.consent_bitmap & (1 << index)) !== 0) return { ok: true as const, status: "on-chain" as const, consent_pubkey: key };
    const intent = newChainIntent({
      game_id: input.gameId,
      instance: consentInstanceOf(escrowInstanceKey(binding), key),
      key: { op: "relay-consent", seq: stored.payload.seq, seat_index: index },
      subject: { kind: "digest", digests: [codecDigest("18JUNO/v1", "consent", digest)] },
      op: { kind: "consent", chain_game_id: binding.chain_game_id, seq: stored.payload.seq, seat_index: index, settle_digest: stored.payload.payload_digest, consent_pubkey: key },
      msg_json: RELAYER_EXECUTE.consent(binding.chain_game_id, index, input.signature),
      now: deps.now(),
    });
    /* The same (seq, seat, key) already relayed: the same work (any valid signature by that key over that digest is
       equally good), whatever bytes this one has. */
    const existing = await deps.intents.load(input.gameId, intent.intent_id);
    if (existing !== null) {
      if (existing.status === "pending" || existing.status === "in-flight") deps.relayer()?.poke(input.gameId, existing.intent_id);
      return { ok: true as const, status: existing.status === "confirmed" ? ("on-chain" as const) : ("relayed" as const), consent_pubkey: key };
    }
    const created = await deps.intents.create(intent);
    if (created.kind === "failed") return refuse("store", created.detail);
    deps.relayer()?.poke(input.gameId, intent.intent_id);
    audit("money.consent-relayed", { game_id: input.gameId, chain_game_id: binding.chain_game_id, seq: stored.payload.seq, chain_seat_index: index, intent_id: intent.intent_id });
    return { ok: true as const, status: created.kind === "created" ? ("queued" as const) : ("relayed" as const), consent_pubkey: key };
  }

  async function submitAnnul(input: { readonly gameId: string; readonly chainSeatIndex: number; readonly signature: string; readonly registeredKeys: readonly string[] }) {
    /* LIVE-6 L6-2: post-restore safe mode -- nothing is relayed for a restored money game before its verification. */
    const restoring = restoreRefusal(input.gameId);
    if (restoring !== null) return restoring;
    const found = await relayable(input.gameId);
    if (!("bound" in found)) return found;
    const { bound } = found;
    const binding = bound.binding;
    const response = await readGame(binding.chain_game_id);
    const g = response.game;
    /* FP4 (escrow 2.1.0): the universal unanimous neutral annulment also reaches a DISPUTED game (bond returned). */
    const annullable = g.state === "IN_PROGRESS" || g.state === "SETTLEABLE" || (g.state === "DISPUTED" && (g.policy ?? null) !== null);
    if (!annullable) return refuse("wrong-state", `the escrow is ${g.state}; an annul is for a game in progress, settleable${(g.policy ?? null) !== null ? " or disputed" : ""}`);
    if (g.domain === null) return refuse("wrong-state", "the escrow has no domain");
    const trusted = response.trusted_seq;
    const digest = annulDigestV1(g.domain, BigInt(trusted));
    const index = input.chainSeatIndex;
    const seat = Number.isInteger(index) && index >= 0 ? g.seats[index] : undefined;
    const problem = seatSignatureProblem(seat, input.registeredKeys, digest, input.signature);
    if (problem !== null) return problem;
    let entry = annulBook.get(input.gameId);
    if (entry === undefined || entry.trusted_seq !== trusted || entry.domain !== g.domain || entry.seats !== g.seats.length) {
      entry = { trusted_seq: trusted, domain: g.domain, seats: g.seats.length, sigs: new Map() };
      annulBook.set(input.gameId, entry);
    }
    entry.sigs.set(index, { signature: input.signature, pubkey: (seat as { consent_pubkey: string }).consent_pubkey });
    /* A signature whose key is no longer the seat's current one is useless on chain: dropped (that seat signs again). */
    for (const [at, sig] of [...entry.sigs]) if (g.seats[at]?.consent_pubkey !== sig.pubkey) entry.sigs.delete(at);
    const collected = [...entry.sigs.keys()].sort((a, b) => a - b);
    let submitted = false;
    if (collected.length === g.seats.length) {
      const keys = collected.map((at) => (entry as { sigs: Map<number, { pubkey: string }> }).sigs.get(at)!.pubkey);
      const keysDigest = createHash("sha256").update(keys.join(",")).digest("hex");
      const consents = collected.map((at) => ({ seat_index: at, signature: (entry as { sigs: Map<number, { signature: string }> }).sigs.get(at)!.signature }));
      const intent = newChainIntent({
        game_id: input.gameId,
        instance: annulInstanceOf(escrowInstanceKey(binding), keysDigest),
        key: { op: "annul-by-consent", trusted_seq: trusted },
        subject: { kind: "digest", digests: [codecDigest("18JUNO/v1", "annul", digest)] },
        op: { kind: "annul", chain_game_id: binding.chain_game_id, trusted_seq: trusted, seats: g.seats.length, keys_digest: keysDigest },
        msg_json: RELAYER_EXECUTE.annulByConsent(binding.chain_game_id, consents),
        now: deps.now(),
      });
      const created = await deps.intents.create(intent);
      if (created.kind === "failed") return refuse("store", created.detail);
      deps.relayer()?.poke(input.gameId, intent.intent_id);
      submitted = true;
      if (created.kind === "created") audit("money.annul-relayed", { game_id: input.gameId, chain_game_id: binding.chain_game_id, trusted_seq: trusted, intent_id: intent.intent_id });
    }
    notify(input.gameId);
    return { ok: true as const, trusted_seq: trusted, collected, needed: g.seats.length, submitted };
  }

  /** The server's own newest signed checkpoint and its terminal settlement for a game, from its durable intents. */
  async function escrowDetails(gameId: string): Promise<{ readonly checkpoint: SignedPayloadDetail | null; readonly settlement: SignedPayloadDetail | null }> {
    const intents = await deps.intents.listGame(gameId);
    const detail = (intent: ChainIntentRecord): SignedPayloadDetail | null => {
      const op = intent.op;
      if (op.kind !== "checkpoint" && op.kind !== "settle") return null;
      try {
        const parsed = JSON.parse(intent.msg_json) as Record<string, { payload?: unknown; signature?: unknown }>;
        const body = parsed[op.kind];
        if (body === undefined || typeof body.signature !== "string") return null;
        return { seq: op.seq, log_len: op.log_len, round_key: op.kind === "checkpoint" ? op.round_key : null, payload: body.payload, signature: body.signature, settle_digest: op.settle_digest, status: intent.status };
      } catch {
        return null;
      }
    };
    const usable = (intent: ChainIntentRecord) => intent.status !== "held";
    const newest = (kind: "checkpoint" | "settle") =>
      intents
        .filter((intent) => intent.op.kind === kind && usable(intent))
        .sort((a, b) => (BigInt((b.op as { seq: string }).seq) > BigInt((a.op as { seq: string }).seq) ? 1 : -1))[0];
    const checkpoint = newest("checkpoint");
    const settlement = newest("settle");
    return { checkpoint: checkpoint === undefined ? null : detail(checkpoint), settlement: settlement === undefined ? null : detail(settlement) };
  }

  /* ------------------------------------------------------------------ */
  /* The service                                                         */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* LIVE-4 (L4-4): creation, chain facts, the relayer's first question    */
  /* ------------------------------------------------------------------ */

  /** The canonical creation verdict: a table not yet dealt, with the identity it would freeze now and the pinned
   *  deployment -- and that deployment VERIFIED: the chain's verification-grade facts for it were read this run (a
   *  contradicting read is the verdict's own conflict). */
  function creationVerdict(): CanonicalVerdict {
    const decision = serving.decide({
      fin: "current",
      record: newFinancialRecord("g_creation", continuationNow(), 0, backend.pin),
      identity: { kind: "undealt" },
    });
    if (decision.verdict.kind !== "continues") return decision.verdict;
    if (serving.chainFactsReadAt(pinKey) === null) {
      return { kind: "not-continued", why: "deployment-unverified", detail: `the escrow ${pinKey} has not been read from the chain at verification grade this run (every endpoint, on the configured chain, not syncing, agreeing)` };
    }
    return decision.verdict;
  }

  /** The pinned deployment's chain-attested facts, read at verification grade and recorded (`juno/chainFacts.ts`); an
   *  audit line whenever what the chain reports changes (the first read of the run included). */
  let lastFacts: string | null = null;
  let factsInFlight: Promise<ChainFactsRead> | null = null;
  function refreshChainFacts(): Promise<ChainFactsRead> {
    /* One read at a time (review R-6): a caller while one runs shares it, so a slow read never lands over a newer one. */
    if (factsInFlight !== null) return factsInFlight;
    const run = (async () => {
      const read = await readVerifiedChainFacts(backend.pin, backend.rest, deps.now);
      serving.recordChainFacts(read);
      if (read.kind === "read") {
        const text = `${read.facts.code_checksum}|${read.facts.denom}`;
        if (text !== lastFacts) audit("escrow.chain-facts", { deployment: read.key, code_checksum: read.facts.code_checksum, denom: read.facts.denom });
        lastFacts = text;
      }
      return read;
    })();
    factsInFlight = run;
    void run.then(
      () => (factsInFlight = null),
      () => (factsInFlight = null),
    );
    return run;
  }

  /** The relayer's first question about an intent, BEFORE it writes anything for it: an intent whose own deployment
   *  this pool does not serve, or whose game this pool does not continue, is skipped in memory; a conflict is held
   *  under its canonical code only when this pool owns the game (serves the deployment the intent is for). */
  async function classifyIntent(intent: ChainIntentRecord): Promise<IntentServing> {
    const intentKey = serving.capability.escrow_deployments.find((deployment) => intent.instance.startsWith(`${deployment.key}|`))?.key ?? null;
    if (intentKey === null) return { kind: "skip", why: "deployment-unavailable", detail: `the intent is for ${intent.instance.slice(0, 160)}, an escrow this server does not serve` };
    const found = await servingOf(intent.game_id, { ownerKey: intentKey });
    const verdict = found.decision.verdict;
    if (verdict.kind === "continues") return { kind: "continues" };
    serving.notice(intent.game_id, found.decision, "relayer");
    if (verdict.kind === "conflict" && found.decision.holdCode !== null) return { kind: "hold", code: found.decision.holdCode, why: `${verdict.why}: ${verdict.detail}` };
    return { kind: "skip", why: verdict.why, detail: verdict.detail };
  }

  /** A frozen roster's Start, written for the current epoch if it is not yet (the load, and a repeated requestStart). */
  async function admitStart(intent: ChainIntentRecord, record: FinancialGameRecord): Promise<Admission> {
    const binding = record.binding?.escrow;
    if (binding == null) return { kind: "hold", code: "binding-mismatch", why: "the money game has no bound chain game" };
    const epoch = startEpochOf(intent.instance, escrowInstanceKey(binding));
    if (epoch === null) return { kind: "hold", code: "binding-mismatch", why: "the Start is not this game's" };
    if (record.chain.started !== null) return { kind: "ok" }; // the effect read confirms it
    if (record.roster === null || epoch !== record.roster_epoch || intent.op.kind !== "start" || intent.op.roster_hash !== record.roster.roster_hash) {
      return { kind: "hold", code: "chain-intent-held", why: `the Start of roster epoch ${epoch} is not the current freeze (epoch ${record.roster_epoch}${record.roster === null ? ", released" : ""})` };
    }
    return record.phase === "funding" ? { kind: "ok" } : { kind: "wait", why: `the money game is ${record.phase}` };
  }

  /* ==================================================================
      LIVE-6 L6-2: POST-RESTORE SAFE MODE
     ==================================================================
     After a game-table restore (L6-4), a money game's durable history may be BEHIND what escaped it: the ledger (never
     restored) may hold reservations beyond the restored log, and the chain's trusted sequence may be ahead of it. Play on
     such a history could never be settled (preflight §13 step 8: "a money game is served read-only until its F1 check
     has passed, which needs the chain"). So, on a restored table, every money game is READ-ONLY -- no move, no seat or
     ticket op, no bind, admission, Start, consent or annul, and no server-driven change either: no start reconciliation,
     no relayer admission, no unbound close, no deal after Start, no expiry / archive / chain-mirror room change (review
     M1) -- until THIS PROCESS has verified it:
       - no financial record, or one closed / cancelled, or one never bound to a chain game: nothing to verify;
       - financial mode verified against the chain (the deployment), then F1 (`verifyHistory`: the durable log reproduces
         the ledger's highest reserved checkpoint -- else the existing durable `journal-ahead` HOLD), then a QUORUM chain
         read: the chain's trusted sequence is not ahead of the durable log (`aheadOfLog` -- else the same hold).
     The exit is DETERMINISTICALLY REPRODUCIBLE, not a stored flag: the verified set lives in this process only, so every
     restart re-runs the same pure checks against the same durable ledger / chain / log -- a restart can never bypass it,
     and a failure is the existing durable hold. The signing jobs (checkpoint, settle) already run F1 and the chain check
     before any signature; this adds the read-only serving in front of them. */
  const restoreVerified = new Set<string>();
  const restoreRunning = new Map<string, Promise<RestoreCheck>>();
  /** L6-5B: each checked game's LAST answer (a view for `restoreStatus`; never read by the gate or the check). */
  const restoreLast = new Map<string, RestoreCheck["kind"]>();
  async function restoreCheck(gameId: string): Promise<RestoreCheck> {
    if (deps.restoreSafeMode !== true) return { kind: "verified", detail: "not a restored table" };
    if (restoreVerified.has(gameId)) return { kind: "verified", detail: "verified in this process" };
    let record: FinancialGameRecord | null;
    try {
      record = await deps.financial.load(gameId);
    } catch (error) {
      return { kind: "pending", detail: `the financial record could not be read (${error instanceof Error ? error.name : "error"})` };
    }
    const done = (detail: string): RestoreCheck => {
      restoreVerified.add(gameId);
      audit("money.restore-verified", { game_id: gameId, detail });
      notify(gameId);
      return { kind: "verified", detail };
    };
    if (record === null) return done("no financial record");
    if (record.phase === "closed" || record.phase === "cancelled") return done(`${record.phase}: nothing to verify`);
    if (record.phase === "held") return { kind: "held", detail: "the financial record is held" };
    if (!ready()) return { kind: "pending", detail: "financial mode is not verified against the chain yet" };
    const bound = boundOf(record);
    if (bound === null) return done("never bound to a chain game: nothing signed, nothing relayed for it");
    if (!(await verifyHistory(bound))) return { kind: "held", detail: "F1: the durable log does not reproduce the ledger's reservations (held journal-ahead)" };
    let game: JunoGameResponse;
    try {
      game = await readGameQuorum(bound.binding.chain_game_id);
    } catch (error) {
      return { kind: "pending", detail: `the chain cannot be read now (${error instanceof Error ? error.name : "error"})` };
    }
    const entries = await deps.readLog(gameId);
    const ahead = await aheadOfLog(bound, entries.length, game);
    if (ahead !== null) {
      await hold(gameId, "journal-ahead", ahead);
      return { kind: "held", detail: ahead };
    }
    return done(`F1 passed; the chain's trusted sequence ${game.trusted_seq} is not ahead of the durable log (${entries.length} entries)`);
  }
  function startRestoreCheck(gameId: string): Promise<RestoreCheck> {
    let running = restoreRunning.get(gameId);
    if (running === undefined) {
      running = restoreCheck(gameId)
        .catch((error): RestoreCheck => ({ kind: "pending", detail: `the check failed (${error instanceof Error ? error.name : "error"})` }))
        .then((answer) => {
          if (deps.restoreSafeMode === true) restoreLast.set(gameId, answer.kind);
          return answer;
        })
        .finally(() => restoreRunning.delete(gameId));
      restoreRunning.set(gameId, running);
    }
    return running;
  }
  function restoreGate(gameId: string): string | null {
    if (deps.restoreSafeMode !== true || restoreVerified.has(gameId)) return null;
    void startRestoreCheck(gameId);
    return RESTORE_READ_ONLY_SENTENCE;
  }
  const restoreRefusal = (gameId: string): ServiceRefusal | null => (restoreGate(gameId) === null ? null : { ok: false, code: "restore-unverified", detail: RESTORE_READ_ONLY_SENTENCE });

  return {
    stats,
    rosterSource,
    restoreGate,
    restoreCheck: startRestoreCheck,
    restoreStatus() {
      const counts = { verified: 0, pending: 0, held: 0 };
      for (const kind of restoreLast.values()) counts[kind] += 1;
      return { safe_mode: deps.restoreSafeMode === true, ...counts };
    },
    isRosterFrozen: (gameId) => frozen.has(gameId),
    reconcileStart,
    relayConsent,
    submitAnnul,
    annulCollected(gameId) {
      const entry = annulBook.get(gameId);
      return entry === undefined ? null : { trusted_seq: entry.trusted_seq, collected: [...entry.sigs.keys()].sort((a, b) => a - b) };
    },
    escrowDetails,
    intentsOf: (gameId) => deps.intents.listGame(gameId),
    onChange(listener) {
      listeners.push(listener);
    },
    isReady: ready,
    serving,
    creationVerdict,
    refreshChainFacts,
    classifyIntent,
    async servingDecision(gameId, options = {}) {
      const found = await servingOf(gameId, { ownerKey: options.ownerKey ?? null });
      serving.notice(gameId, found.decision, options.where ?? "money route");
      return found.decision;
    },
    artifactFormatsOf,
    observe: (gameId) => enqueue(gameId, "the chain observation", () => observeChain(gameId)),
    async closeUnboundTable(gameId) {
      /* L6-2 (review M1): not on a restored money game before it is verified (the next observation closes it). */
      if (restoreGate(gameId) !== null) return;
      await exclusive(gameId, async () => {
        /* L4-4: only a game this pool continues is closed here (a table another pool serves is closed by that pool). */
        const found = await servingOf(gameId);
        const record = found.record;
        if (record === null || record.phase !== "funding" || record.binding?.escrow != null || record.roster !== null) return;
        if (!(await mayAct(gameId, found, "close unbound"))) return;
        const next = await apply(gameId, (current) => (current.phase === "funding" && current.binding?.escrow == null ? { kind: "cancel-before-deal", at: deps.now() } : null));
        if (next?.phase === "cancelled") audit("money.cancelled-unbound", { game_id: gameId });
      });
    },

    async refreshRoster(gameId) {
      /* L6-2: every claim of a game (the claim hook) starts its post-restore verification at once. */
      if (deps.restoreSafeMode === true) void startRestoreCheck(gameId);
      let record: FinancialGameRecord | null;
      try {
        record = await deps.financial.load(gameId);
      } catch (error) {
        if (!(error instanceof FinancialRecordUnreadableError)) throw error;
        frozen.add(gameId);
        return;
      }
      if (record === null) frozen.delete(gameId);
      else remember(record);
    },

    async preload() {
      let count = 0;
      for (const gameId of await deps.financial.list()) {
        let record: FinancialGameRecord | null;
        try {
          record = await deps.financial.load(gameId);
        } catch (error) {
          if (error instanceof FinancialRecordUnreadableError) {
            /* Unreadable: nothing about it is known -- its table is treated as frozen (a seat never moves on a guess). */
            frozen.add(gameId);
            continue;
          }
          throw error;
        }
        if (record === null) continue;
        remember(record);
        count += 1;
      }
      return count;
    },

    async admit(intent) {
      /* L6-2 (review M1): an intent of a restored money game is not admitted before its game is verified in this process
         (undecided: nothing written, no failure counted; the relayer asks again at its next pass). */
      if (restoreGate(intent.game_id) !== null) return { kind: "undecided", why: RESTORE_READ_ONLY_SENTENCE };
      /* LIVE-4 (L4-4): the verdict first, as `classifyIntent` (the relayer asks that before it writes anything): a game
         this pool does not continue is skipped IN MEMORY, never held; only the owner's conflict holds. */
      let serving_: IntentServing;
      try {
        serving_ = await classifyIntent(intent);
      } catch (error) {
        /* The facts could not be read now (review R-2): no verdict, so nothing is written for it -- no failure counted,
           no retry budget spent, never a hold; the relayer asks again at its next pass. */
        return { kind: "undecided", why: `the continuation verdict could not be computed now (${error instanceof Error ? error.message.slice(0, 200) : String(error)})` };
      }
      if (serving_.kind === "skip") return { kind: "skip", why: serving_.why };
      if (serving_.kind === "hold") return { kind: "hold", code: serving_.code, why: serving_.why };
      const record = await deps.financial.load(intent.game_id);
      /* Gone since the verdict was asked (it continued a record that was there): decided again at the next pass. */
      if (record === null) return { kind: "undecided", why: "the intent's financial record vanished since its verdict" };
      if (record.phase === "held") return { kind: "wait", why: `the money game is held (${record.hold?.code ?? "?"}); nothing new is submitted until an operator releases it` };
      if (record.phase === "closed" || record.phase === "cancelled") return { kind: "wait", why: `the money game is ${record.phase}` };
      if (intent.op.kind === "start") return admitStart(intent, record);
      const binding = record.binding?.escrow;
      /* ESCROW-4: a consent or annul lives in its key-suffixed slot family of the same instance. */
      if (binding == null || !intentBelongsTo(intent, escrowInstanceKey(binding))) return { kind: "hold", code: "binding-mismatch", why: "the intent is not this game's chain game" };
      if (intent.op.kind === "remedy") {
        /* FP4: a remedy is relayed only on the remedy lane's word (its system pause freezes what is not yet final). */
        if (deps.remedyGate === undefined) return { kind: "wait", why: "no remedy lane is configured in this build: a remedy intent is not relayed" };
        const gate = await deps.remedyGate(intent.game_id, intent);
        if (gate.kind !== "ok") return { kind: "wait", why: gate.why };
      }
      return { kind: "ok" };
    },

    async createMoneyGame(gameId) {
      if (!ready()) return { ok: false, code: "not-verified", detail: "financial mode is not verified against the chain" };
      /* LIVE-4 (§9.3, D4-14; L4-4): never freeze an identity, or pin a deployment, this pool cannot continue -- a rules
         engine not yet settlement-certified, a protocol or codec it does not serve, a deployment it does not serve or has
         not verified at verification grade this run. The CANONICAL verdict, asked here as well as at the route, so no
         internal caller can bypass it; on a refusal nothing is written (no financial record, no money identity). */
      let verdict = creationVerdict();
      if (verdict.kind !== "continues" && verdict.why === "deployment-unverified" && serving.chainFactsReadAt(pinKey) === null) {
        await refreshChainFacts(); // nothing was read at verification grade yet this run: read once, then decide
        verdict = creationVerdict();
      }
      if (verdict.kind !== "continues") return { ok: false, code: verdict.why, detail: verdict.detail };
      const continuation = continuationNow();
      const record = newFinancialRecord(gameId, continuation, deps.now(), backend.pin);
      const created = await deps.financial.create(record);
      if (created.outcome.kind !== "committed") return { ok: false, code: "store", detail: created.outcome.detail };
      /* A record already there (a repeated creation) is the game's: this pool continues it, or refuses it unchanged. */
      const stored = created.existing ?? record;
      if (created.existing !== null) {
        const refused = refusalOf(await servingOf(gameId, { record: created.existing }));
        if (refused !== null) return { ok: false, ...refused };
      }
      audit("money.created", { game_id: gameId, chain_id: backend.pin.chain_id, contract: backend.pin.contract_address, denom: backend.pin.denom, financial_protocol: stored.continuation?.financial_protocol ?? null });
      return { ok: true, record: stored };
    },

    async bindChainGame(gameId, chainGameId, variants) {
      return bindChecked(gameId, chainGameId, variants, null);
    },

    async bindHostChainGame(gameId, chainGameId, variants, expect) {
      const restoring = restoreRefusal(gameId);
      if (restoring !== null) return restoring;
      /* W-13: every chain fact is read by QUORUM (every configured endpoint agreeing) and compared with the server's own
         expectation before the write-once binding exists. The shared checks then pin the deployment, rules, variants and
         policy exactly as 3B's bind does. */
      if (typeof chainGameId !== "string" || !/^[1-9][0-9]{0,19}$/.test(chainGameId)) return { ok: false, code: "request-invalid", detail: "the chain game id is not a u64" };
      return bindChecked(gameId, chainGameId, variants, expect);
    },

    /* ESCROW-JOIN. Every precondition is the existing authority's, re-read now; the admission is recorded on the seat's
       ticket grant BEFORE it is signed (so the ledger never forgets an admission that may be on its way to the chain),
       and it is signed only through the configured admission key, over a digest re-derived here. */
    async authorizeJoin(input) {
      const no = (code: string, detail: string) => ({ ok: false as const, code, detail });
      if (!ready()) return no("not-verified", "financial mode is not verified against the chain");
      const restoring = restoreRefusal(input.gameId);
      if (restoring !== null) return restoring;
      const admission = deps.admission;
      if (admission === undefined) return no("admission-unavailable", "this server has no join-admission signer (production waits for the KMS client, LIVE-5)");
      return exclusive(input.gameId, async () => {
        const found = await servingOf(input.gameId);
        const record = found.record;
        if (record === null) return no("not-found", "no money record");
        const refused = refusalOf(found);
        if (refused !== null) return no(refused.code, refused.detail);
        const binding = record.binding?.escrow ?? null;
        if (binding === null) return no("not-bound", "the chain game is not bound");
        if (record.phase !== "funding" || record.chain.started !== null) return no("wrong-state", `the money game is ${record.phase}${record.chain.started !== null ? " (started)" : ""}`);
        /* A frozen roster (provisional or permanent) moves no seat: no new wallet is admitted to it. */
        if (record.roster !== null || frozen.has(input.gameId) || (await deps.tickets.frozenAt(input.gameId)) !== null) return no("frozen", "the table's roster is frozen; no seat changes");
        let wallet: string;
        try {
          wallet = JUNO_CODEC_V1.canonicalAddress(input.wallet, "wallet");
        } catch {
          return no("request-invalid", "the wallet is not a canonical (lower-case) address");
        }
        if (typeof input.joinTicket !== "string" || !/^[0-9a-f]{64}$/.test(input.joinTicket)) return no("request-invalid", "the join ticket is not 32 bytes of lowercase hex");
        /* The seat's CURRENT, STANDING ticket (standing = its issuing session and recovery key still stand, the
           principal still holds the seat), issued to THIS principal for THIS wallet, and it is this ticket. */
        const grant = await deps.tickets.standingGrantOf(input.gameId, input.playerId);
        if (grant === null) return no("no-standing-ticket", "the seat has no standing join ticket");
        if (grant.principal_id !== input.principalId) return no("not-seat-owner", "the seat's ticket was not issued to this principal");
        if (grant.wallet !== wallet || grant.ticket !== input.joinTicket) return no("ticket-mismatch", "the seat's standing ticket is for another wallet, or is another ticket");
        /* The wallet's control PROVED for this seat (ESCROW-4's ADR-036 record, every binding and its age checked);
           until that exists, nothing is. Never the ledger's DECLARED wallet: that is not a proof. */
        const proof = await (deps.walletProofs ?? NO_WALLET_CONTROL_PROOFS).proofOf({ gameId: input.gameId, playerId: input.playerId, principalId: input.principalId });
        const unproven = walletProofProblem(proof, { gameId: input.gameId, playerId: input.playerId, principalId: input.principalId, wallet, now: deps.now() });
        if (unproven !== null) return no("wallet-unproven", unproven);
        /* No conflicting grant: another seat's standing ticket must not name the same wallet. */
        const conflicting = (await deps.tickets.standingGrants(input.gameId)).some((other) => other.player_id !== input.playerId && other.wallet === wallet);
        if (conflicting) return no("wallet-conflict", "another seat's standing ticket names this wallet");
        /* The chain, now: open for funding, not paused, before the deadline, and this wallet not already seated. */
        const { view } = await liveView({ binding });
        if (view.state !== "FUNDING") return no("wrong-state", `the escrow is ${view.state}`);
        if (view.paused) return no("paused", "the escrow deployment is paused");
        const nowSecs = Math.floor(deps.now() / 1000);
        const deadline = view.deadlines.funding_deadline;
        if (deadline !== null && /^[0-9]+$/.test(deadline) && BigInt(nowSecs) >= BigInt(deadline)) return no("funding-closed", "the escrow's funding deadline has passed");
        if (view.seats.some((seat) => seat.payout_address === wallet)) return no("already-seated", "this wallet already holds a seat of this chain game");
        /* Escrow 2.1.0: a resolver never holds a seat in a game it would judge (the contract refuses to START such a game,
           which would leave the table waiting on withdrawals): a trusted resolver's wallet is never admitted. */
        if (backend.trust.resolvers.includes(wallet)) return no("resolver-wallet", "an escrow resolver's wallet cannot hold a seat at a money table (it would judge its own stake)");
        const expiresAt = nowSecs + admission.ttlSecs;
        const recorded = await deps.tickets.recordAdmission({ gameId: input.gameId, playerId: input.playerId, epoch: grant.epoch, wallet, ticket: grant.ticket, expiresAt });
        /* LIVE-5 L5-2 (F-L5-6): an UNCERTAIN record is not committed -- nothing is signed on it (the admission's record
           must be durable BEFORE the signature leaves); the retry re-reads the ledger. */
        if (recorded !== "committed") return no(recorded === "refused" ? "no-standing-ticket" : "conflict", "the seat's ticket changed while the admission was prepared; ask again");
        let signed: Awaited<ReturnType<JoinAdmissionSigner["sign"]>>;
        try {
          signed = await admission.signer.sign({ chain_id: backend.pin.chain_id, deployment: backend.pin.contract_address, chain_game_id: BigInt(binding.chain_game_id), wallet, join_ticket_hex: grant.ticket, expires_at: BigInt(expiresAt) });
        } catch (error) {
          return no("admission-unavailable", `the admission could not be signed (${error instanceof SignerError ? error.code : "error"})`);
        }
        audit("money.join-admitted", { game_id: input.gameId, chain_game_id: binding.chain_game_id, epoch: grant.epoch, expires_at: expiresAt, admission_key: admission.signer.kind });
        return {
          ok: true as const,
          admission: {
            chain_id: backend.pin.chain_id,
            contract: backend.pin.contract_address,
            chain_game_id: binding.chain_game_id,
            wallet,
            join_ticket: grant.ticket,
            expires_at: String(expiresAt),
            signature: signed.signature_hex,
            admission_pubkey: admission.signer.publicKeyHex,
          },
        };
      });
    },

    async requestStart(gameId, liveSeats) {
      if (!ready()) return { ok: false, code: "not-verified", detail: "financial mode is not verified against the chain" };
      const restoring = restoreRefusal(gameId);
      if (restoring !== null) return restoring;
      return exclusive(gameId, async () => {
        const found = await servingOf(gameId);
        const record = found.record;
        if (record === null || record.binding?.escrow == null) return { ok: false as const, code: "not-bound", detail: "the chain game is not bound" };
        const refused = refusalOf(found);
        if (refused !== null) return { ok: false as const, ...refused };
        if (record.phase !== "funding" || record.chain.started !== null) return { ok: false as const, code: "wrong-state", detail: `the money game is ${record.phase}${record.chain.started !== null ? " (started)" : ""}` };
        const binding = record.binding.escrow;
        if (record.roster !== null) {
          /* A freeze already stands: its Start is the one in flight (or about to be written). */
          const intent = startIntentOf(gameId, binding, record.roster.roster_hash, record.roster_epoch);
          const created = await deps.intents.create(intent);
          if (created.kind === "failed") return { ok: false as const, code: "store", detail: created.detail };
          if (created.kind === "exists" && !created.same) {
            await hold(gameId, "binding-conflict", "the start slot carries another roster");
            return { ok: false as const, code: "held", detail: "the start slot carries another roster" };
          }
          if (created.record.status === "superseded" || created.record.status === "held") {
            /* Decide it now (after this task), not at the next sweep. */
            void enqueue(gameId, "the start reconciliation", async () => {
              await reconcileStart(gameId);
            });
            return { ok: false as const, code: "retry", detail: "the previous Start of this roster did not happen; it is being released -- start again once it is" };
          }
          frozen.add(gameId);
          deps.relayer()?.poke(gameId, intent.intent_id);
          return { ok: true as const, roster_hash: record.roster.roster_hash, intent_id: intent.intent_id };
        }
        const { view } = await liveView({ binding });
        /* Claims come from the ticket ledger: a chain seat is claimed only by the standing grant whose ticket AND wallet
           it carries (`freezeEscrowRoster` recomputes that through `ticketOf`, read once in this task). Since ESCROW-JOIN
           the contract itself refuses a Join this server did not admit; a seat no standing grant claims can still exist
           (a wallet admitted under a ticket that has since ended, re-joining before its admission expired) and is
           `unbound-seat`: this roster is never frozen and never started (defence in depth). */
        const standing = await deps.tickets.standingGrants(gameId);
        const claims = view.seats.flatMap((seat) => {
          const grant = standing.find((entry) => entry.wallet === seat.payout_address && entry.ticket === seat.join_ticket_hex);
          return grant === undefined ? [] : [{ player_id: grant.player_id, payout_address: seat.payout_address, evidence: { kind: "join-ticket" as const, ticket_hex: grant.ticket }, claimed_at: deps.now() }];
        });
        const ticketOf = await deps.tickets.lookupOf(gameId);
        const result = freezeEscrowRoster({
          binding,
          game_id: gameId,
          codec: JUNO_CODEC_V1,
          liveSeats,
          claims,
          view,
          ticketOf,
          trust: backend.trust,
          domainInputs: (rosterHash) => junoDomainInputsOf(binding, rosterHash),
          now: deps.now(),
        });
        if (!result.ok) return { ok: false as const, code: result.refusal.code, detail: result.refusal.detail };
        /* THE FREEZE: the ledger (by this freeze's token: issuing stops, security events no longer un-bind these
           claims), then the financial roster (a new epoch), then this epoch's Start intent. A ledger freeze a crash left
           without its roster is released first (the record is the authority). */
        const token = result.freeze.frozen_at;
        let ledger = await deps.tickets.freeze(gameId, token);
        if (ledger === "conflict") {
          const leftover = await deps.tickets.frozenAt(gameId);
          const behind = leftover === null ? null : await recordBehind(gameId, binding, record.roster_epoch);
          if (behind !== null) {
            await hold(gameId, behind.code, behind.detail);
            return { ok: false as const, code: "held", detail: behind.detail };
          }
          if (leftover !== null && (await deps.tickets.unfreeze(gameId, leftover)) === "committed") ledger = await deps.tickets.freeze(gameId, token);
        }
        if (ledger !== "committed") return { ok: false as const, code: "conflict", detail: "the ticket ledger changed; try again" };
        const next = await apply(gameId, () => ({ kind: "roster-frozen", at: deps.now(), freeze: result.freeze }));
        if (next === null || next.roster === null || next.roster.roster_hash !== result.freeze.roster_hash || next.roster.frozen_at !== token) {
          if (next !== null && next.roster === null) await deps.tickets.unfreeze(gameId, token);
          return { ok: false as const, code: next?.phase === "held" ? "held" : "conflict", detail: next?.hold?.detail ?? "the roster was not frozen" };
        }
        audit("money.roster-frozen", { game_id: gameId, roster_hash: next.roster.roster_hash, seats: next.roster.roster.length, epoch: next.roster_epoch });
        const intent = startIntentOf(gameId, binding, next.roster.roster_hash, next.roster_epoch);
        const created = await deps.intents.create(intent);
        /* Not written: the freeze stands and the load (or the sweep) writes the Start -- the same slot, the same subject. */
        if (created.kind === "failed") return { ok: false as const, code: "store", detail: created.detail };
        if (created.kind === "exists" && !created.same) {
          await hold(gameId, "binding-conflict", "the start slot carries another roster");
          return { ok: false as const, code: "held", detail: "the start slot carries another roster" };
        }
        deps.relayer()?.poke(gameId, intent.intent_id);
        return { ok: true as const, roster_hash: next.roster.roster_hash, intent_id: intent.intent_id };
      });
    },

    onGameplayCommitted(input) {
      try {
        if (!frozen.has(input.gameId) || !started.has(input.gameId)) return;
        /* LIVE-4 (L4-4): a game this pool was last found NOT to continue queues nothing (the synchronous check, from the
           newest decision); the checkpoint job asks the verdict again, from these very entries, before it writes. */
        const decided = decisions.get(input.gameId);
        if (decided !== undefined && decided.verdict.kind !== "continues") return;
        const board = input.board;
        const known = lastRound.get(input.gameId) ?? null;
        const logLen = input.entries.length;
        if (known !== null && known.log_len >= logLen) return;
        if (!isCheckpointPosition(known?.round_key ?? null, board)) return;
        /* Synchronously, inside the committing task: the committed board as TEXT (never a live object later). */
        const snapshot: CheckpointSnapshot = {
          game_id: input.gameId,
          log_len: logLen,
          round_key: roundKeyOf(board),
          canonical_text: canonicalStateText(board),
          entries: input.entries,
          issued_at: issuedAtOf(input.entries, logLen),
        };
        lastRound.set(input.gameId, { round_key: snapshot.round_key, log_len: logLen });
        if (!ready()) {
          /* Review #8: not verified yet -- kept for the sweep (a stalled game makes no new commit to retry it). */
          retrySnapshot.set(input.gameId, snapshot);
          return;
        }
        const queued = pendingSnapshot.has(input.gameId);
        retrySnapshot.delete(input.gameId);
        pendingSnapshot.set(input.gameId, snapshot);
        if (!queued) void enqueue(input.gameId, "a checkpoint", () => checkpointJob(input.gameId));
      } catch (error) {
        deps.warn(`  escrow: a checkpoint snapshot of ${input.gameId} failed -- ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    onIntentPrepared(gameId) {
      void enqueue(gameId, "the settlement", () => settleJob(gameId));
    },

    async onIntentResolved(intent) {
      void enqueue(intent.game_id, `the ${intent.op.kind} resolution`, async () => {
        const found = await servingOf(intent.game_id);
        const record = found.record;
        if (record === null || record.binding?.escrow == null) return;
        /* Review #5 / L4-4: a game this pool does not continue is never moved by an intent's resolution. */
        if (!(await mayAct(intent.game_id, found, "intent resolution"))) return;
        if (intent.op.kind === "start") {
          /* Confirmed, superseded or held: the chain decides whether the freeze is permanent or released. */
          await reconcileStart(intent.game_id);
          await observeChain(intent.game_id);
          return;
        }
        const bound = boundOf(record);
        if (bound === null || !intentBelongsTo(intent, escrowInstanceKey(bound.binding))) return;
        if (intent.op.kind === "consent" || intent.op.kind === "annul") {
          /* ESCROW-4: a player's relayed signature. Held or superseded is that signature's end (the player signs again),
             never the game's: the chain decides what happened. */
          if (intent.op.kind === "annul" && intent.status !== "confirmed") annulBook.delete(intent.game_id);
          await observeChain(intent.game_id);
          notify(intent.game_id);
          return;
        }
        if (intent.status === "held") {
          /* A contradiction the relayer found keeps its code (the canonical conflict codes included, L4-4). */
          const passes: readonly FinancialHoldCode[] = ["chain-inconsistent", "binding-mismatch", "continuation-incompatible"];
          const code: FinancialHoldCode = passes.includes(intent.hold?.code as FinancialHoldCode) ? (intent.hold?.code as FinancialHoldCode) : "chain-intent-held";
          /* A held checkpoint is not a held game (a newer one may land); FP4: nor is a held remedy refused for good (an
             approver rotated its key, the attempts failed) -- a later remedy (the neutral TimeoutAnnul) may still land.
             A contradiction always is. */
          if ((intent.op.kind !== "checkpoint" && intent.op.kind !== "remedy") || code !== "chain-intent-held") await hold(intent.game_id, code, `${intent.op.kind}: ${intent.hold?.detail ?? ""}`);
          return;
        }
        if (intent.status === "confirmed" && intent.op.kind === "checkpoint") {
          const op = intent.op;
          await apply(intent.game_id, () => ({ kind: "checkpoint-confirmed", at: deps.now(), seq: op.seq, log_len: op.log_len }));
          return;
        }
        /* Settle / finalize (confirmed or superseded): read what the chain did. */
        await observeChain(intent.game_id);
      });
    },

    async load() {
      let games = 0;
      let held = 0;
      let resumed = 0;
      let skipped = 0;
      for (const gameId of await discover()) {
        /* LIVE-4 (L4-4): every money game's verdict, before anything of it is written. The financial record's class
           (an unreadable one keeps its seats frozen: nothing moves on a guess); the ledger's and the intents' classes --
           read only for a record of a financial protocol this pool speaks, so another protocol's artifacts are never
           parsed as this one's; the deal's identity from the log. */
        let record: FinancialGameRecord | null = null;
        let fin: FormatFact = "current";
        try {
          record = await deps.financial.load(gameId);
        } catch (error) {
          if (!(error instanceof FinancialRecordUnreadableError)) throw error;
          fin = error.format;
          frozen.add(gameId);
        }
        if (fin === "current" && record === null) continue;
        if (record !== null) {
          games += 1;
          remember(record);
        }
        let found: Found;
        try {
          /* An unreadable record keeps its class (the formats decide first, so its deal is not read). */
          found = await servingOf(gameId, fin === "current" ? { record } : { record: null, fin, entries: [] });
        } catch (error) {
          /* The deal could not be read: nothing is decided, so nothing is written; the next load decides again. */
          deps.warn(`  escrow: ${gameId}'s continuation could not be decided (${error instanceof Error ? error.message : String(error)}); nothing is done for it now`);
          skipped += 1;
          continue;
        }
        if (fin !== "current") {
          /* Unreadable here: never overwritten, never held by this pool; noticed with its class. */
          serving.notice(gameId, found.decision, "load");
          skipped += 1;
          continue;
        }
        if (record === null) continue;
        if (found.decision.verdict.kind !== "continues") {
          const holds = found.decision.holdCode !== null && record.phase !== "held" && record.phase !== "closed" && record.phase !== "cancelled";
          await mayAct(gameId, found, "load");
          if (holds) held += 1;
          else skipped += 1;
          continue;
        }
        if (record.binding?.escrow == null) continue;
        const bound = boundOf(record);
        if (bound !== null && record.phase !== "closed" && record.phase !== "cancelled") {
          /* Review #1: before anything of this game is signed again, its durable log must reproduce the journal. */
          const target = bound;
          void enqueue(gameId, "the history check", async () => {
            await verifyHistory(target);
          });
        }
        if (record.phase === "intent-prepared") {
          resumed += 1;
          void enqueue(gameId, "the settlement", () => settleJob(gameId));
        }
        if (record.phase === "funding" && record.chain.started === null) {
          /* A freeze's Start (written if a crash lost it, released if the chain proved it dead), or a leftover ledger
             freeze with no roster: decided from durable state and the chain. */
          void enqueue(gameId, "the start reconciliation", async () => {
            await reconcileStart(gameId);
          });
        }
      }
      const relayer = deps.relayer();
      if (relayer !== null) await relayer.load();
      return { games, held, resumed, skipped };
    },

    async sweepChain() {
      for (const [gameId, snapshot] of [...retrySnapshot]) {
        if (!ready()) break;
        retrySnapshot.delete(gameId);
        if (pendingSnapshot.has(gameId)) continue;
        pendingSnapshot.set(gameId, snapshot);
        lastRound.set(gameId, { round_key: snapshot.round_key, log_len: snapshot.log_len });
        void enqueue(gameId, "a checkpoint (retry)", () => checkpointJob(gameId));
      }
      for (const gameId of await discover()) {
        const record = await deps.financial.load(gameId).catch(() => null);
        if (record === null || record.binding?.escrow == null) continue;
        if (record.phase === "closed" || record.phase === "cancelled") continue;
        if (record.phase === "funding" && record.chain.started === null) {
          await enqueue(gameId, "the start reconciliation", async () => {
            await reconcileStart(gameId);
          });
          continue;
        }
        if (record.roster === null) continue;
        await enqueue(gameId, "the chain sweep", () => observeChain(gameId));
        /* JX-5B: a terminal Settle job that failed transiently before its intent was durably written (the settlement
           key unavailable, a chain read, the intent store) left the record at `intent-prepared` with nothing to run it
           again but a restart's `load()`. The sweep re-offers it through the same per-game queue, AFTER the observation
           above (a chain that already ended the game closes the record first, and the job then does nothing).
           `settleJob` re-reads the record and asks the verdict itself, and every slot it signs is idempotent: an
           existing intent is found before any signature, and the journal keeps one digest per slot. */
        if (record.phase === "intent-prepared") await enqueue(gameId, "the settlement (sweep retry)", () => settleJob(gameId));
      }
    },

    async idle() {
      for (;;) {
        const pending = [...jobs.values(), ...locks.values()];
        if (pending.length === 0) return;
        await Promise.all(pending);
      }
    },
  };
}
