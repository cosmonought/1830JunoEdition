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
//                             the persisted intent (else HOLD); the terminal checkpoint (seq 2L) then the Settle (2L+1)
//   after Settle              the chain's SETTLEABLE is observed; Finalize after the window; SETTLED/ANNULLED/CANCELLED
//                             closes the financial record (whatever route the chain took)
//
// Every job is a pure function of durable state, so a crash anywhere re-runs it to the same slot with the same subject.
//
// HISTORY BEFORE SIGNATURE (GNOLAND-1 F1, review #1). Before the first payload of a game is signed by this process, the
// durable log must REPRODUCE the highest checkpoint the external signing journal ever reserved for it (the same digest,
// rebuilt from the log's prefix), and the chain's trusted sequence must not be ahead of it: a store restored to an older
// (or different) history is held, never signed over.

import { buildSettlementCoreV1, type BuiltSettlementCoreV1 } from "../../../frontend/src/gameEngine/escrow/settlementCoreV1";
import { JUNO_CODEC_V1, junoDomainInputsOf } from "../../../frontend/src/gameEngine/escrow/junoCodecV1";
import {
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
import { logHash } from "../../../frontend/src/gameEngine/logHash";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import type { GameVariants } from "../../../frontend/src/gameEngine/gameVariants";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { selectSettlementKey, type SettlementKeyConfig, type SettlementSigner } from "./escrowPorts";
import { isLiveAttempt, newChainIntent, sameChainIntent, startEpochOf, startInstanceOf, supersededIntent, type ChainIntentOp, type ChainIntentRecord, type ChainIntentStore } from "./chainIntents";
import { roundKeyOf, isCheckpointPosition, issuedAtOf, type CheckpointSnapshot } from "./checkpointPolicy";
import { FinancialRecordUnreadableError, type FinancialGameStore } from "./financialGameStore";
import { currentMoneyContinuation } from "./moneyContinuation";
import { DEALT_PHASES, newFinancialRecord, transitionFinancial, type FinancialDeploymentPin, type FinancialEvent, type FinancialGameRecord, type FinancialHoldCode } from "./moneyLifecycle";
import type { InspectableSigningJournal } from "./signingJournal";
import type { PrefixReplay, TerminalSettlementEvidence } from "./settlementEvidence";
import type { WalletTicketLedger } from "./walletTickets";
import { SignerError } from "./juno/signer";
import { junoGameView, parseConfigResponse, parseGameResponse, parseSignerKeysResponse, QUERY, RELAYER_EXECUTE, type JunoGameResponse } from "./juno/junoContract";
import type { JunoRest } from "./juno/junoRest";
import type { Admission, Relayer } from "./juno/relayer";
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
  readonly replay: PrefixReplay;
  readonly now: () => number;
  readonly warn: (line: string) => void;
  readonly ops?: OpsRecorder;
  /** Financial mode is verified against the chain (`juno/junoBackend.ts`): until it is, nothing is signed or written
   *  for the chain (default: ready). */
  readonly ready?: () => boolean;
}

export type ServiceRefusal = { readonly ok: false; readonly code: string; readonly detail: string };

/** What `reconcileStart` found: the chain started this freeze (permanent), its Start may still happen (the freeze
 *  stands), the chain proved it never will (released), there is no freeze to decide, or the game is held. */
export type StartReconciliation = "started" | "pending" | "released" | "none" | "held";

export interface EscrowService {
  /** ESCROW-4's money-room creation: the financial record, deployment pinned and continuation frozen. */
  createMoneyGame(gameId: string): Promise<{ readonly ok: true; readonly record: FinancialGameRecord } | ServiceRefusal>;
  /** The creator's CreateGame landed: bind the chain game (write-once, from a chain read). */
  bindChainGame(gameId: string, chainGameId: string, variants: GameVariants): Promise<{ readonly ok: true; readonly binding: EscrowBindingV2 } | ServiceRefusal>;
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
  /** Startup: pin checks, the relayer's open intents, and every money game's pending chain work. */
  load(): Promise<{ readonly games: number; readonly held: number; readonly resumed: number }>;
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
        }
        remember(decided.next);
        return decided.next;
      }
      if (put.kind !== "conflict") throw new Error(put.detail);
    }
    throw new Error("the financial record kept changing");
  }

  const hold = (gameId: string, code: FinancialHoldCode, detail: string) => apply(gameId, () => ({ kind: "hold", at: deps.now(), code, detail }));

  /** A table's seats are frozen while a roster is frozen (provisionally or, once started, permanently), and while its
   *  money is HELD (operator attention: nothing moves); a cancelled or closed escrow has nothing left to freeze. */
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

  /** The binding is this deployment's (the pin agrees with what this server is configured for), or a refusal. */
  function pinMismatch(record: FinancialGameRecord): string | null {
    if (record.binding === null) return "the money game has no pinned deployment";
    const pin = record.binding.deployment;
    const mine = backend.pin;
    for (const key of Object.keys(mine) as (keyof FinancialDeploymentPin)[]) {
      if (pin[key] !== mine[key]) return `the game is pinned to ${key}=${String(pin[key])}; this server is configured for ${String(mine[key])}`;
    }
    return null;
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
    const reservations = deps.journal.reservations(instance);
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
    let record = await deps.financial.load(snapshot.game_id);
    if (record !== null && record.phase === "funding" && record.chain.started !== null) {
      /* The escrow started and the game is being played: the deal, derived (the coordinator derives it too). */
      record = await apply(snapshot.game_id, (current) => (current.phase === "funding" ? { kind: "dealt", at: deps.now() } : null));
    }
    const bound = boundOf(record);
    if (bound === null || record === null) return;
    if (!["in-progress", "liveness", "terminal-eligible", "intent-prepared"].includes(record.phase) || record.chain.started === null) return;
    if (pinMismatch(record) !== null) return;
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
    const record = await deps.financial.load(gameId);
    const bound = boundOf(record);
    if (record === null || bound === null || record.phase !== "intent-prepared" || record.intent === null || record.terminal === null) return;
    if (pinMismatch(record) !== null) return;
    const evidence = record.intent;
    const entries = await deps.readLog(gameId);
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
    return false;
  }

  /** What the chain says now, as lifecycle events (the chain wins). A HELD game is observed (its chain outcome is
   *  recorded) but nothing new is submitted for it (review #6); a game pinned elsewhere is not read here at all (#5). */
  async function observeChain(gameId: string): Promise<void> {
    const record = await deps.financial.load(gameId);
    if (record === null || record.binding?.escrow == null || record.phase === "closed" || record.phase === "cancelled") return;
    if (pinMismatch(record) !== null) return;
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
      await apply(gameId, (current) => (current.phase === "settleable" ? { kind: "chain-disputed", at: deps.now() } : null));
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
    if (later !== null || deps.journal.attemptsOf(next.intent_id).length > 0) {
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
    return exclusive(gameId, async (): Promise<StartReconciliation> => {
      const record = await deps.financial.load(gameId);
      if (record === null || record.binding?.escrow == null || pinMismatch(record) !== null) return "none";
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
      for (const entry of deps.journal.attemptsOf(existing.intent_id)) {
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
      if ((await deps.tickets.unfreeze(gameId, roster.frozen_at)) !== "committed") {
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
      const financial = await deps.financial.load(record.game_id).catch(() => null);
      const bound = boundOf(financial);
      if (financial === null || bound === null) return refuse("This money table's escrow is not ready.");
      if (financial.phase !== "funding" || financial.chain.started === null) return refuse("The escrow has not started this game yet.");
      if (pinMismatch(financial) !== null) return refuse("This server cannot deal this money table.");
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

  /* ------------------------------------------------------------------ */
  /* The service                                                         */
  /* ------------------------------------------------------------------ */

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

  return {
    stats,
    rosterSource,
    isRosterFrozen: (gameId) => frozen.has(gameId),
    reconcileStart,

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
      const record = await deps.financial.load(intent.game_id);
      if (record === null) return { kind: "hold", code: "binding-mismatch", why: "the intent's game has no financial record" };
      const mismatch = pinMismatch(record);
      if (mismatch !== null) return { kind: "hold", code: "binding-mismatch", why: mismatch };
      if (record.phase === "held") return { kind: "wait", why: `the money game is held (${record.hold?.code ?? "?"}); nothing new is submitted until an operator releases it` };
      if (record.phase === "closed" || record.phase === "cancelled") return { kind: "wait", why: `the money game is ${record.phase}` };
      if (intent.op.kind === "start") return admitStart(intent, record);
      const binding = record.binding?.escrow;
      if (binding == null || intent.instance !== escrowInstanceKey(binding)) return { kind: "hold", code: "binding-mismatch", why: "the intent is not this game's chain game" };
      return { kind: "ok" };
    },

    async createMoneyGame(gameId) {
      if (!ready()) return { ok: false, code: "not-verified", detail: "financial mode is not verified against the chain" };
      const record = newFinancialRecord(gameId, currentMoneyContinuation(backend.pin.codec), deps.now(), backend.pin);
      const created = await deps.financial.create(record);
      if (created.outcome.kind !== "committed") return { ok: false, code: "store", detail: created.outcome.detail };
      const stored = created.existing ?? record;
      const mismatch = pinMismatch(stored);
      if (mismatch !== null) return { ok: false, code: "binding-mismatch", detail: mismatch };
      audit("money.created", { game_id: gameId, chain_id: backend.pin.chain_id, contract: backend.pin.contract_address, denom: backend.pin.denom, financial_protocol: stored.continuation?.financial_protocol ?? null });
      return { ok: true, record: stored };
    },

    async bindChainGame(gameId, chainGameId, variants) {
      if (!ready()) return { ok: false, code: "not-verified", detail: "financial mode is not verified against the chain" };
      const record = await deps.financial.load(gameId);
      if (record === null) return { ok: false, code: "not-found", detail: "no money record" };
      const mismatch = pinMismatch(record);
      if (mismatch !== null) return { ok: false, code: "binding-mismatch", detail: mismatch };
      if (record.continuation === null) return { ok: false, code: "held", detail: "the money record has no continuation identity" };
      const [contract, response, configRaw] = await Promise.all([
        backend.rest.contract(backend.pin.contract_address),
        readGame(chainGameId),
        backend.rest.smart(backend.pin.contract_address, QUERY.config()),
      ]);
      const checksum = await backend.rest.codeChecksum(contract.code_id);
      const config = parseConfigResponse(configRaw);
      const g = response.game;
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
      audit("money.bound", { game_id: gameId, chain_game_id: g.chain_game_id, code_checksum: checksum, deployment: deploymentId(binding.deployment) });
      return { ok: true, binding: next.binding.escrow };
    },

    async requestStart(gameId, liveSeats) {
      if (!ready()) return { ok: false, code: "not-verified", detail: "financial mode is not verified against the chain" };
      return exclusive(gameId, async () => {
        const record = await deps.financial.load(gameId);
        if (record === null || record.binding?.escrow == null) return { ok: false as const, code: "not-bound", detail: "the chain game is not bound" };
        const mismatch = pinMismatch(record);
        if (mismatch !== null) return { ok: false as const, code: "binding-mismatch", detail: mismatch };
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
           it carries (`freezeEscrowRoster` recomputes that through `ticketOf`, read once in this task). A seat no grant
           claims (a wallet that joined with a ticket this server never issued -- the contract cannot refuse one, see the
           ESCROW-3B junk-Join blocker) is `unbound-seat`: this roster is never frozen and never started. */
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
        const record = await deps.financial.load(intent.game_id);
        if (record === null || record.binding?.escrow == null) return;
        /* Review #5: an intent of another deployment never moves this game's record. */
        if (pinMismatch(record) !== null) return;
        if (intent.op.kind === "start") {
          /* Confirmed, superseded or held: the chain decides whether the freeze is permanent or released. */
          await reconcileStart(intent.game_id);
          await observeChain(intent.game_id);
          return;
        }
        const bound = boundOf(record);
        if (bound === null || intent.instance !== escrowInstanceKey(bound.binding)) return;
        if (intent.status === "held") {
          const code = intent.hold?.code === "chain-inconsistent" ? "chain-inconsistent" : intent.hold?.code === "binding-mismatch" ? "binding-mismatch" : "chain-intent-held";
          /* A held checkpoint is not a held game (a newer one may land); a contradiction always is. */
          if (intent.op.kind !== "checkpoint" || code !== "chain-intent-held") await hold(intent.game_id, code, `${intent.op.kind}: ${intent.hold?.detail ?? ""}`);
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
      for (const gameId of await deps.financial.list()) {
        let record: FinancialGameRecord | null;
        try {
          record = await deps.financial.load(gameId);
        } catch (error) {
          if (error instanceof FinancialRecordUnreadableError) {
            frozen.add(gameId);
            continue;
          }
          throw error;
        }
        if (record === null) continue;
        games += 1;
        remember(record);
        const mismatch = record.binding === null ? null : pinMismatch(record);
        if (mismatch !== null && record.phase !== "held" && record.phase !== "closed" && record.phase !== "cancelled") {
          /* Brief §5: a restart or deployment never points a money game at another chain, contract, denom or code. */
          await hold(gameId, "binding-mismatch", mismatch);
          held += 1;
          continue;
        }
        if (mismatch !== null || record.binding?.escrow == null) continue;
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
      return { games, held, resumed };
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
      for (const gameId of await deps.financial.list()) {
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
