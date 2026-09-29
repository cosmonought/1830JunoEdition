// server/src/escrow/juno/relayer.ts
//
// ==================================================================
//  ESCROW-3B: THE JUNO RELAYER -- ONE ACCOUNT, ONE LIVE TRANSACTION, THE SEQUENCE ALWAYS READ FROM THE CHAIN
// ==================================================================
//
// Every chain intent of every money game is submitted here, by one relayer account (the contract's operator), through
// one serialized worker. Gameplay never waits for it: an actor task only records what its committed history implies
// (`escrowService.ts` turns that into durable intents off the actor); the worker picks the intents up on its own clock.
//
// THE SEQUENCE RULE (brief §9). A Cosmos account's transactions are ordered by its `sequence`, and a node accepts
// exactly the next one. Two games signing "at the same time" against one remembered counter would race it, and a
// counter that drifted after an ambiguous RPC answer would sign transactions that can never land. So:
//
//   - AT MOST ONE ATTEMPT IS LIVE (signed or broadcast, outcome unknown) for the account, across all games and across
//     restarts -- the durable intents say which one it is, and nothing new is signed while it is unresolved;
//   - every new attempt signs at the sequence the chain reports NOW (`account`), after the previous one is resolved;
//   - an attempt stops being live only when the CHAIN resolves it: found by hash (included, success or failure); its
//     sequence consumed (the account moved past it -- by it or by anything else, identified through the `tx.acc_seq`
//     index when a node has one); or proven dead (a height above its `timeout_height` at which the account's sequence
//     is still the attempt's). Never by a timer, never by "not found".
//
// So two games submitting concurrently are two intents taken in order: N lands, then N+1 is signed at the chain's N+1.
// An RPC ambiguity cannot drift anything, because nothing is remembered: a restart re-reads the chain and re-observes
// the live attempt before it signs again. The sequence being serialized never serializes gameplay.
//
// IDEMPOTENCY BY EFFECT. Before any attempt, and after any attempt resolves, the CONTRACT'S STATE is read: an intent
// whose effect is already there (by this attempt, an earlier one, or anyone else's transaction) is confirmed; one the
// escrow no longer needs (a newer checkpoint, a game that left the state) is superseded; one the chain CONTRADICTS
// (another payload at our signed slot, another roster, another domain) is HELD. The contract itself refuses a second
// application of every relayer route (StaleSeq / WrongState), so a duplicate can only ever waste gas -- it can never
// move money twice.
//
// LIVE-4 (L4-4): THE VERDICT BEFORE ANY WRITE. Every open intent is first classified (`classify`, the escrow service's
// canonical continuation verdict for its game, and the relayer's own check that the intent is for the deployment it
// relays): an intent this relayer does not continue -- another deployment's, a game another pool continues, another
// build's intent format -- is SKIPPED IN MEMORY: no `defer` (a CAS write), no hold, no confirmation, no observation
// write; it is simply not in this relayer's work, and one alarm says so. Only a verified conflict found by the pool
// that owns the game holds it, under its canonical code. An intent whose verdict cannot be computed now (a read of
// its game's facts failed) is UNDECIDED: nothing is written for it either, and it is asked again at every pass -- one
// game's unreadable facts never fail a pass or the load for everyone else. A skipped or undecided intent's attempt
// that may still be live on THIS relayer's account keeps the account's sequence: nothing new is signed until the chain
// has spent its sequence or passed its expiry height (the same guard as the attempts a restored store forgot).

import { JUNO_CODEC_V1 } from "../../../../frontend/src/gameEngine/escrow/junoCodecV1";
import { classifyContractFailure, parseCheckpointsResponse, parseGameResponse, QUERY, type JunoGameResponse } from "./junoContract";
import { assembleTx, prepareExecuteTx, simulationTx, type Coin } from "./cosmosTx";
import { decideGas, type GasPolicy } from "./gasPolicy";
import { JunoRpcError, type AccountView, type JunoRest, type TxResultView } from "./junoRest";
import type { DigestSigner } from "./signer";
import { SignerError } from "./signer";
import {
  confirmedIntent,
  deferredIntent,
  heldIntent,
  intentBelongsTo,
  isLiveAttempt,
  junoInstanceOf,
  supersededIntent,
  withAttemptPatch,
  withNewAttempt,
  type ChainAttempt,
  type ChainIntentRecord,
  type ChainIntentStore,
} from "../chainIntents";
import type { SigningJournal } from "../escrowPorts";
import type { OpsRecorder } from "../../persistence/opsRecorder";
import type { EscrowError } from "../../../../frontend/src/gameEngine/escrow/escrowModel";

export interface RelayerAccount {
  /** The bech32 address the key controls (proven at startup, `junoConfig.ts`). */
  readonly address: string;
  readonly signer: DigestSigner;
}

/** The service's word on signing a NEW attempt for an intent (never consulted to observe a live one). `skip` (L4-4):
 *  not this pool's to act on -- left untouched, in memory only. `undecided` (L4-4): the verdict could not be computed
 *  now (a read failed) -- nothing is written, no failure is counted, and the next pass asks again. */
export type Admission =
  | { readonly kind: "ok" }
  | { readonly kind: "wait"; readonly why: string }
  | { readonly kind: "hold"; readonly code: string; readonly why: string }
  | { readonly kind: "skip"; readonly why: string }
  | { readonly kind: "undecided"; readonly why: string };

/** LIVE-4 (L4-4): the service's FIRST word on an open intent, before the relayer writes anything for it: continue it;
 *  skip it in memory (not continued here: another deployment's, another pool's game, another build's format); or hold
 *  it under a canonical conflict code (the owning pool only). */
export type IntentServing =
  | { readonly kind: "continues" }
  | { readonly kind: "skip"; readonly why: string; readonly detail: string }
  | { readonly kind: "hold"; readonly code: string; readonly why: string };

export interface RelayerDeps {
  readonly rest: JunoRest;
  readonly store: ChainIntentStore;
  /** Every attempt is journalled BEFORE it is written to the store (and so before any broadcast). `allAttempts`: the
   *  startup guard against attempts a restored store forgot. */
  readonly journal: SigningJournal & { allAttempts?(account?: string): Promise<ReadonlyArray<{ readonly intent_id: string; readonly tx_id: string; readonly account: string; readonly sequence: string; readonly expires_after_height?: string }>> };
  readonly account: RelayerAccount;
  readonly chainId: string;
  readonly contract: string;
  readonly gas: GasPolicy;
  /** Blocks after the latest height at which an attempt expires (default 60 ≈ 5-6 minutes on Juno). */
  readonly timeoutBlocks: number;
  readonly memo?: string;
  readonly now: () => number;
  readonly warn: (line: string) => void;
  readonly ops?: OpsRecorder;
  /** Told when an intent reaches confirmed / superseded / held (the service moves the financial record). */
  readonly onResolved?: (intent: ChainIntentRecord) => void | Promise<void>;
  /** Pass cadence while an attempt is live (default 5 s), rebroadcast spacing (30 s), idle pass (60 s). */
  readonly pollMs?: number;
  readonly rebroadcastMs?: number;
  readonly idleMs?: number;
  /** Consecutive failed attempts before an intent is held for an operator (default 6). */
  readonly failureBudget?: number;
  readonly schedule?: (run: () => void, ms: number) => { cancel(): void };
  /** Financial mode is verified (`junoBackend.ts`); until then a pass signs, broadcasts and reads nothing. */
  readonly active?: () => boolean;
  /** Review #5/#6: the service's admission of a NEW attempt (the game's financial record: not held, pinned to this
   *  deployment, and -- for a Start -- still the current roster freeze). Default: admitted. */
  readonly admit?: (intent: ChainIntentRecord) => Promise<Admission>;
  /** LIVE-4 (L4-4): the canonical verdict for an open intent, asked before ANY write for it (the load and every pass).
   *  Default: only the relayer's own check (an intent for another deployment is skipped in memory). */
  readonly classify?: (intent: ChainIntentRecord) => Promise<IntentServing>;
}

export interface RelayerStatus {
  readonly open: number;
  readonly live: { readonly intent_id: string; readonly game_id: string; readonly tx_hash: string; readonly sequence: string } | null;
  readonly last_error: string | null;
  readonly passes: number;
  /** Journalled attempts the intent store does not know (a restored store): nothing new is signed until the chain has
   *  spent or expired them. */
  readonly forgotten_guard: { readonly attempts: number; readonly max_sequence: string; readonly until_height: string | null } | null;
  /** LIVE-4 (L4-4): open intents skipped in memory (not continued here), and the games whose intent files are another
   *  build's format (never parsed here). */
  readonly skipped: number;
  readonly skipped_games: number;
  /** LIVE-4 (L4-4): open intents whose verdict could not be computed yet (a read failed): untouched, asked again at
   *  every pass. */
  readonly undecided: number;
}

export interface Relayer {
  /** A new or changed intent: look at it soon. */
  poke(gameId: string, intentId: string): void;
  /** Find every open intent in the store (startup): the live attempt is observed before anything is signed. */
  load(): Promise<void>;
  /** A pass soon (the backend became active). */
  wake(): void;
  /** One pass now (tests drive this; the timer calls it too). */
  pass(): Promise<void>;
  status(): RelayerStatus;
  stop(): void;
}

const defaultSchedule = (run: () => void, ms: number) => {
  const handle = setTimeout(run, ms);
  (handle as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(handle) };
};

/** SDK codes the relayer recognises in a CheckTx or DeliverTx answer (codespace "sdk"). */
const SDK = Object.freeze({ insufficientFunds: 5, unauthorized: 4, outOfGas: 11, insufficientFee: 13, txInMempool: 19, wrongSequence: 32, txTimeoutHeight: 30 });

type Effect = { readonly kind: "done"; readonly detail: string } | { readonly kind: "absent" } | { readonly kind: "moot"; readonly why: string } | { readonly kind: "inconsistent"; readonly detail: string };
type Readiness = { readonly kind: "ready" } | { readonly kind: "wait"; readonly untilMs: number; readonly why: string } | { readonly kind: "moot"; readonly why: string } | { readonly kind: "hold"; readonly code: string; readonly detail: string };

const blockSeconds = (time: string): number => Math.floor(Date.parse(time) / 1000);
const maxHeight = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : BigInt(a) >= BigInt(b) ? a : b);

export function createJunoRelayer(deps: RelayerDeps): Relayer {
  const schedule = deps.schedule ?? defaultSchedule;
  const pollMs = deps.pollMs ?? 5_000;
  const rebroadcastMs = deps.rebroadcastMs ?? 30_000;
  const idleMs = deps.idleMs ?? 60_000;
  const failureBudget = deps.failureBudget ?? 6;
  /** intent_id -> game_id, for every intent not known to be terminal. */
  const open = new Map<string, string>();
  let timer: { cancel(): void; due: number } | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  let lastError: string | null = null;
  let passes = 0;
  let live: RelayerStatus["live"] = null;

  const audit = (event: string, fields: Record<string, unknown>) => deps.ops?.audit(event, fields);

  function kick(ms: number): void {
    if (stopped) return;
    const due = Date.now() + ms;
    if (timer !== null) {
      if (timer.due <= due) return;
      timer.cancel();
    }
    const scheduled = { cancel: () => undefined as void, due };
    timer = scheduled;
    const handle = schedule(() => {
      if (timer === scheduled) timer = null;
      void pass();
    }, ms);
    scheduled.cancel = () => handle.cancel();
  }

  let writesThisPass = 0;
  /** Review #3: any write that did not COMMIT (a conflict, a definite or an uncertain failure) ends the pass before
   *  anything else is signed -- an uncertain write may have landed a live attempt the pass cannot see. */
  let writeFailed = false;
  /** `untilHeight`: the highest journalled expiry of the forgotten attempts when every one carries it (review 2 #5: the
   *  configuration's timeout may have changed across the restart); else fixed at first sight from the configuration. */
  let forgotten: { attempts: number; maxSequence: bigint; untilHeight: bigint | null } | null = null;

  /** LIVE-4 (L4-4): intents skipped in memory (id -> why), games whose intents are another build's format, and the
   *  live attempts of skipped intents on THIS relayer's account (tx hash -> its sequence and expiry): nothing new is
   *  signed while one of them may still land. */
  const skipped = new Map<string, { readonly game_id: string; readonly why: string }>();
  const skippedGames = new Set<string>();
  const unobserved = new Map<string, { readonly sequence: bigint; readonly timeout: bigint | null }>();
  /** LIVE-4 (L4-4, review R-1/R-2): open intents whose verdict could not be computed (id -> game, and the last reason
   *  warned about): out of this relayer's work, untouched, and classified again at every pass -- one game's unreadable
   *  facts never stop the pass, the load, or anyone else's intents. */
  const undecided = new Map<string, { readonly game_id: string; why: string }>();

  /** A live attempt of an intent this relayer does not observe (skipped or undecided) keeps this account's sequence. */
  function guardLiveAttempts(intent: ChainIntentRecord): void {
    for (const attempt of intent.attempts) {
      if (isLiveAttempt(attempt) && attempt.account === deps.account.address) {
        unobserved.set(attempt.tx_hash, { sequence: BigInt(attempt.sequence), timeout: /^[0-9]+$/.test(attempt.timeout_height) ? BigInt(attempt.timeout_height) : null });
      }
    }
  }

  /** The verdict could not be computed now: nothing is written for the intent, no failure counted; it leaves this
   *  pass's work (its live attempt guarded) and is asked again at the next pass. One warning per reason. */
  function leaveUndecided(intent: ChainIntentRecord, why: string): void {
    open.delete(intent.intent_id);
    guardLiveAttempts(intent);
    const known = undecided.get(intent.intent_id);
    undecided.set(intent.intent_id, { game_id: intent.game_id, why });
    if (known?.why === why) return;
    deps.warn(`  relayer: ${intent.op.kind} for ${intent.game_id} is UNDECIDED (${why.slice(0, 240)}); nothing is written for it, and it is asked again at the next pass`);
    audit("chain.intent-undecided", { game_id: intent.game_id, intent_id: intent.intent_id, op: intent.op.kind, why: why.slice(0, 200) });
  }

  /** Not this relayer's to act on: dropped from its work, IN MEMORY ONLY -- nothing is written for it -- with one alarm.
   *  A live attempt of it on this account keeps the account's sequence (`unobservedBlocks`). */
  function skip(intent: ChainIntentRecord, why: string, detail: string): void {
    open.delete(intent.intent_id);
    undecided.delete(intent.intent_id);
    guardLiveAttempts(intent);
    const known = skipped.get(intent.intent_id);
    skipped.set(intent.intent_id, { game_id: intent.game_id, why });
    if (known?.why === why) return;
    deps.warn(`  relayer: SKIPPED ${intent.op.kind} for ${intent.game_id} (${why}) -- ${detail.slice(0, 240)}; nothing is written for it here`);
    audit("chain.intent-skipped", { game_id: intent.game_id, intent_id: intent.intent_id, op: intent.op.kind, why });
  }

  /** The relayer's own first check (an intent is submitted only to the deployment it was made for), then the service's
   *  canonical verdict. */
  async function servingOf(intent: ChainIntentRecord): Promise<IntentServing> {
    if (!ownInstance(intent)) return { kind: "skip", why: "deployment-unavailable", detail: `the intent belongs to ${intent.instance.slice(0, 160)}, not to this relayer's ${deps.chainId} ${deps.contract}` };
    return deps.classify === undefined ? { kind: "continues" } : deps.classify(intent);
  }

  /** Live attempts of skipped intents that may still land at this account's sequence: the chain must first spend their
   *  sequence or pass their expiry height. */
  async function unobservedBlocks(): Promise<boolean> {
    if (unobserved.size === 0) return false;
    const account = await accountOf();
    const block = await deps.rest.latestBlock();
    for (const [hash, attempt] of [...unobserved]) {
      if (BigInt(account.sequence) > attempt.sequence || (attempt.timeout !== null && BigInt(block.height) > attempt.timeout)) unobserved.delete(hash);
    }
    if (unobserved.size === 0) return false;
    lastError = `${unobserved.size} live attempts of intents this relayer does not observe now (not continued here, or undecided) may still land; nothing new is signed until the chain spends their sequence or passes their expiry`;
    return true;
  }

  /** One CAS write of a pure move; a stale record re-reads and gives up this pass (the next pass re-decides). */
  async function write(current: ChainIntentRecord, next: ChainIntentRecord): Promise<ChainIntentRecord | null> {
    const outcome = await deps.store.put(next, current.record_version);
    if (outcome.kind === "committed") {
      writesThisPass += 1;
      return next;
    }
    writeFailed = true;
    lastError = outcome.kind === "conflict" ? `intent ${current.intent_id.slice(0, 12)} changed under the relayer` : outcome.detail;
    return null;
  }

  /** Review #5: an intent is submitted only to the deployment it was made for (never re-pointed by configuration). */
  const ownInstance = (intent: ChainIntentRecord): boolean => intentBelongsTo(intent, junoInstanceOf(deps.chainId, deps.contract, intent.op.chain_game_id));

  async function resolved(record: ChainIntentRecord): Promise<void> {
    if (record.status === "confirmed" || record.status === "superseded") open.delete(record.intent_id);
    audit(`chain.intent-${record.status}`, {
      game_id: record.game_id,
      intent_id: record.intent_id,
      op: record.op.kind,
      ...(record.confirmation ? { how: record.confirmation.how, tx_hash: record.confirmation.tx_hash, height: record.confirmation.height } : {}),
      ...(record.superseded ? { why: record.superseded.why } : {}),
      ...(record.hold ? { code: record.hold.code, detail: record.hold.detail } : {}),
    });
    try {
      await deps.onResolved?.(record);
    } catch (error) {
      deps.warn(`  relayer: the resolution hook threw for ${record.game_id} -- ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /* ---------------- reading the contract ---------------- */

  async function readGame(chainGameId: string): Promise<JunoGameResponse> {
    return parseGameResponse(await deps.rest.smart(deps.contract, QUERY.game(chainGameId)));
  }

  async function effectOf(intent: ChainIntentRecord, game: JunoGameResponse): Promise<Effect> {
    const op = intent.op;
    const g = game.game;
    switch (op.kind) {
      case "start":
        if (g.roster_hash !== null) return g.roster_hash === op.roster_hash ? { kind: "done", detail: `started with roster ${op.roster_hash.slice(0, 12)}…` } : { kind: "inconsistent", detail: "the escrow started with another roster" };
        if (g.state === "FUNDED") {
          /* The contract recomputes the hash from its seats: a frozen roster its seats no longer are can never start. */
          const seats = JUNO_CODEC_V1.rosterHash(g.seats.map((seat) => seat.wallet)).hex;
          return seats === op.roster_hash ? { kind: "absent" } : { kind: "moot", why: "the escrow's funded seats are no longer the frozen roster (a seat withdrew or changed)" };
        }
        if (g.state === "FUNDING") return { kind: "moot", why: "the escrow is back in funding (a seat withdrew): the frozen roster can never start" };
        return { kind: "moot", why: `the escrow is ${g.state} and was never started` };
      case "checkpoint": {
        const views = parseCheckpointsResponse(await deps.rest.smart(deps.contract, QUERY.checkpoints(op.chain_game_id))).checkpoints;
        const mine = views.find((view) => view.payload.signer_key_id === op.signer_key_id);
        if (mine !== undefined && mine.payload.seq === op.seq) {
          return mine.payload.payload_digest === op.settle_digest ? { kind: "done", detail: `checkpoint seq ${op.seq} is on chain` } : { kind: "inconsistent", detail: `another payload is on chain at checkpoint seq ${op.seq} under signer key ${op.signer_key_id}` };
        }
        if (BigInt(game.trusted_seq) >= BigInt(op.seq)) return { kind: "moot", why: `the trusted sequence is ${game.trusted_seq} (a newer checkpoint or settlement covers seq ${op.seq})` };
        if (g.state !== "IN_PROGRESS") return { kind: "moot", why: `the escrow is ${g.state}; checkpoints are posted while it is in progress` };
        return { kind: "absent" };
      }
      case "settle": {
        const stored = g.settlement;
        if (stored !== null && stored.payload.seq === op.seq) {
          return stored.payload.payload_digest === op.settle_digest ? { kind: "done", detail: `settlement seq ${op.seq} is on chain` } : { kind: "inconsistent", detail: `another settlement payload is on chain at seq ${op.seq}` };
        }
        if (stored !== null && stored.source === "terminal_payload") return { kind: "inconsistent", detail: `a terminal settlement at seq ${stored.payload.seq} is on chain; this game's is ${op.seq}` };
        if (g.state === "IN_PROGRESS") return BigInt(game.trusted_seq) >= BigInt(op.seq) ? { kind: "inconsistent", detail: `the trusted sequence ${game.trusted_seq} is at or past the terminal seq ${op.seq}` } : { kind: "absent" };
        return { kind: "moot", why: `the escrow is ${g.state}${stored !== null ? ` (settled from ${stored.source})` : ""}: the chain ended it another way` };
      }
      case "finalize":
        if (g.state === "SETTLED") return { kind: "done", detail: `the escrow is settled (${g.outcome?.route ?? "?"})` };
        if (g.state === "SETTLEABLE") return { kind: "absent" };
        return { kind: "moot", why: `the escrow is ${g.state}; there is nothing to finalize` };
      case "consent": {
        /* ESCROW-4: one seat's consent to the stored settlement. The chain keeps a bit per seat, cleared when the seat's
           key rotates: done when the bit is set (by this relay or anyone's); moot once the stored settlement is another
           one, the escrow left SETTLEABLE, or the seat's key is no longer the one that signed. */
        if (g.state === "SETTLED" && g.outcome?.route === "consent_completed") return { kind: "done", detail: "every seat consented; the escrow paid out" };
        if (g.state !== "SETTLEABLE") return { kind: "moot", why: `the escrow is ${g.state}; a consent is relayed while it is settleable` };
        const stored = g.settlement;
        if (stored === null || stored.payload.seq !== op.seq || stored.payload.payload_digest !== op.settle_digest) return { kind: "moot", why: `the stored settlement is no longer seq ${op.seq}` };
        const seat = g.seats[op.seat_index];
        if (seat === undefined) return { kind: "inconsistent", detail: `the escrow has no chain seat ${op.seat_index}` };
        if ((g.consent_bitmap & (1 << op.seat_index)) !== 0) return { kind: "done", detail: `chain seat ${op.seat_index} has consented` };
        if (seat.consent_pubkey !== op.consent_pubkey) return { kind: "moot", why: `chain seat ${op.seat_index}'s consent key changed (the new key signs again)` };
        return { kind: "absent" };
      }
      case "annul":
        /* ESCROW-4: every seat's ANNUL over (domain, trusted_seq). A moved trusted sequence makes these signatures stale. */
        if (g.state === "ANNULLED") return { kind: "done", detail: "the escrow is annulled" };
        if (g.state !== "IN_PROGRESS" && g.state !== "SETTLEABLE") return { kind: "moot", why: `the escrow is ${g.state}; an annul needs it in progress or settleable` };
        if (game.trusted_seq !== op.trusted_seq) return { kind: "moot", why: `the trusted sequence moved to ${game.trusted_seq} (the seats sign again)` };
        if (g.seats.length !== op.seats) return { kind: "inconsistent", detail: "the escrow's roster is not the one the signatures were collected for" };
        return { kind: "absent" };
      default:
        return { kind: "inconsistent", detail: "an intent of an unknown kind" };
    }
  }

  async function readiness(intent: ChainIntentRecord, game: JunoGameResponse, blockTime: number): Promise<Readiness> {
    const op = intent.op;
    const g = game.game;
    const soon = deps.now() + pollMs * 6;
    switch (op.kind) {
      case "start":
        if (game.paused) return { kind: "wait", untilMs: soon, why: "the escrow is paused" };
        return { kind: "ready" };
      case "checkpoint":
        return { kind: "ready" }; // Checkpoint works while paused (ESCROW-2.2)
      case "settle":
        if (game.paused) return { kind: "wait", untilMs: soon, why: "the escrow is paused (Settle waits; checkpoints still land)" };
        return { kind: "ready" };
      case "finalize": {
        if (game.paused) return { kind: "wait", untilMs: soon, why: "the escrow is paused" };
        const end = game.deadlines.challenge_window_end;
        if (end === null) return { kind: "hold", code: "chain-inconsistent", detail: "a settleable escrow reports no challenge window" };
        if (blockTime < Number(end)) return { kind: "wait", untilMs: deps.now() + Math.max(pollMs, (Number(end) - blockTime + 6) * 1000), why: `the challenge window is open until ${end}` };
        return { kind: "ready" };
      }
      case "consent":
        /* Consent is refused while the contract is paused (it resumes); a compromised settlement is the simulation's
           never-retry refusal (CompromisedSettlement) -- held, never guessed at. */
        if (game.paused) return { kind: "wait", untilMs: soon, why: "the escrow is paused (consents wait)" };
        return { kind: "ready" };
      case "annul":
        return { kind: "ready" }; // AnnulByConsent works while paused (ESCROW-2.2)
      default:
        return { kind: "hold", code: "chain-intent-held", detail: "unknown intent kind" };
    }
  }

  /* ---------------- the live attempt ---------------- */

  /** What the chain says about the live attempt. Updates the intent; returns the record (null on a lost CAS). */
  async function observe(intent: ChainIntentRecord): Promise<ChainIntentRecord | null> {
    const attempt = intent.attempts[intent.attempts.length - 1];
    const at = deps.now();
    live = { intent_id: intent.intent_id, game_id: intent.game_id, tx_hash: attempt.tx_hash, sequence: attempt.sequence };
    const found = await deps.rest.tx(attempt.tx_hash);
    if (found !== null) return included(intent, attempt, found);
    const account = await accountOf();
    const sequenceNow = BigInt(account.sequence);
    const sequence = BigInt(attempt.sequence);
    if (sequenceNow > sequence) {
      /* The sequence is spent. By whom -- if a node indexes `tx.acc_seq`? */
      const users = await deps.rest.txsBySequence(deps.account.address, attempt.sequence).catch(() => null);
      const ours = users?.find((entry) => entry.txhash === attempt.tx_hash);
      if (ours !== undefined) return included(intent, attempt, ours);
      const other = users?.find((entry) => entry.txhash !== attempt.tx_hash);
      const patch: Partial<ChainAttempt> =
        other !== undefined
          ? { phase: "dead", death: { kind: "sequence-consumed", account_sequence: attempt.sequence, consumed_by_tx: other.txhash, consumed_at_height: other.height }, observed_at: at, resolved_height: maxHeight(other.height, account.height) }
          : { phase: "consumed", observed_at: at, resolved_height: account.height };
      /* Not a failure of this intent: another transaction used the sequence, or (unidentified) possibly this one --
         the contract's state, read before any next attempt, says which. */
      const next = await write(intent, withAttemptPatch(intent, patch, at));
      if (next !== null) audit("chain.attempt-resolved", { game_id: intent.game_id, intent_id: intent.intent_id, tx_hash: attempt.tx_hash, phase: patch.phase, ...(other ? { consumed_by: other.txhash } : {}) });
      return next;
    }
    const block = await deps.rest.latestBlock();
    const timeout = BigInt(attempt.timeout_height);
    if (BigInt(block.height) > timeout) {
      /* Past its expiry. It is dead only if the account's sequence was STILL the attempt's at a height above the
         timeout: the account read must be at (or after) such a height. When the node says the height it answered at,
         that is the proof; otherwise read the account again now that a later height has been observed. */
      const proof = account.height !== null && BigInt(account.height) > timeout ? account : await accountOf();
      /* Review #13: the proof is an account read AT a height above the timeout -- a node that does not say its height
         (or a lagging one after a failover) proves nothing, and the attempt stays live. */
      if (proof.height === null || BigInt(proof.height) <= timeout) {
        lastError = "an expired attempt cannot be proven dead: the node does not report a height above its timeout";
        return write(intent, withAttemptPatch(intent, { unknown_observations: attempt.unknown_observations + 1, observed_at: at }, at));
      }
      if (BigInt(proof.sequence) === sequence) {
        const patch: Partial<ChainAttempt> = {
          phase: "dead",
          death: { kind: "expiry-passed", timeout_height: attempt.timeout_height, observed_height: proof.height, attempt_sequence: attempt.sequence, account_next_sequence_at_observed: proof.sequence },
          observed_at: at,
          resolved_height: proof.height,
        };
        const next = await write(intent, withAttemptPatch(intent, patch, at, { failed: true }));
        if (next !== null) audit("chain.attempt-resolved", { game_id: intent.game_id, intent_id: intent.intent_id, tx_hash: attempt.tx_hash, phase: "dead", proof: "expiry-passed" });
        return next;
      }
      return intent; // the sequence moved between the reads: the next pass sees it consumed
    }
    /* Still includable: rebroadcast THE SAME BYTES (same hash) when it has not been handed to a node lately. */
    const lastSent = attempt.broadcast?.at ?? 0;
    if (attempt.phase === "signed" || at - lastSent >= rebroadcastMs) {
      return broadcast(intent, attempt);
    }
    return write(intent, withAttemptPatch(intent, { unknown_observations: attempt.unknown_observations + 1, observed_at: at }, at));
  }

  async function included(intent: ChainIntentRecord, attempt: ChainAttempt, result: TxResultView): Promise<ChainIntentRecord | null> {
    const at = deps.now();
    if (result.code === 0) {
      const next = await write(intent, confirmedIntent(intent, "tx", attempt.tx_hash, result.height, "included successfully", at));
      if (next !== null) await resolved(next);
      return next;
    }
    const error = classifyTxFailure(result);
    const failed = withAttemptPatch(intent, { phase: "included-failure", inclusion: { height: result.height, code: result.code, codespace: result.codespace, log: result.raw_log.slice(0, 500) }, error, observed_at: at, resolved_height: result.height }, at, { failed: true });
    const next = await write(intent, failed);
    if (next !== null && next.retry.failures >= failureBudget) await hold(next, "chain-intent-held", `${failureBudget} consecutive attempts failed; the last: ${error.native.name}`);
    if (next !== null) audit("chain.attempt-failed", { game_id: intent.game_id, intent_id: intent.intent_id, tx_hash: attempt.tx_hash, height: result.height, code: error.code, native: error.native.name });
    return next;
  }

  async function broadcast(intent: ChainIntentRecord, attempt: ChainAttempt): Promise<ChainIntentRecord | null> {
    const at = deps.now();
    let answer: TxResultView;
    try {
      answer = await deps.rest.broadcast(Buffer.from(attempt.tx_bytes, "base64"));
    } catch (error) {
      /* Transport failure: the bytes may or may not have reached a node. They stay live; the next pass observes. */
      lastError = `broadcast: ${error instanceof Error ? error.message : String(error)}`;
      return write(intent, withAttemptPatch(intent, { broadcast: { at, code: -1, codespace: "transport", log: lastError.slice(0, 300) }, broadcasts: attempt.broadcasts + 1 }, at));
    }
    const accepted = answer.code === 0 || (answer.codespace === "sdk" && answer.code === SDK.txInMempool);
    const next = await write(
      intent,
      withAttemptPatch(intent, { phase: accepted ? "broadcast" : attempt.phase, broadcast: { at, code: answer.code, codespace: answer.codespace, log: answer.raw_log.slice(0, 300) }, broadcasts: attempt.broadcasts + 1 }, at),
    );
    audit("chain.broadcast", { game_id: intent.game_id, intent_id: intent.intent_id, tx_hash: attempt.tx_hash, sequence: attempt.sequence, code: answer.code, codespace: answer.codespace, accepted });
    return next;
  }

  /* ---------------- a new attempt ---------------- */

  async function accountOf(): Promise<AccountView> {
    const account = await deps.rest.account(deps.account.address);
    if (account === null) throw new RelayerStop(`the relayer account ${deps.account.address} does not exist on ${deps.chainId} (fund it first)`);
    if (account.pub_key !== null && account.pub_key !== deps.account.signer.publicKey.toString("hex")) {
      throw new RelayerStop(`the relayer account ${deps.account.address} is controlled by another key than the configured signer`);
    }
    return account;
  }

  async function hold(intent: ChainIntentRecord, code: string, detail: string): Promise<void> {
    const next = await write(intent, heldIntent(intent, code, detail, deps.now()));
    if (next !== null) {
      deps.warn(`  relayer: HELD ${intent.op.kind} for ${intent.game_id} (${code}) -- ${detail}`);
      await resolved(next);
    }
  }

  async function defer(intent: ChainIntentRecord, untilMs: number, why: string, failed: boolean): Promise<void> {
    const next = await write(intent, deferredIntent(intent, untilMs, deps.now(), failed));
    if (next !== null && failed && next.retry.failures >= failureBudget) {
      await hold(next, "chain-intent-held", `${failureBudget} consecutive attempts failed; the last: ${why}`);
    }
  }

  const backoffMs = (failures: number) => Math.min(10 * 60_000, pollMs * 2 ** Math.min(failures, 8));

  /** Decides a pending intent: confirm / supersede / hold / wait, or sign and broadcast one attempt. */
  async function advance(intent: ChainIntentRecord): Promise<"in-flight" | "settled" | "waiting" | "stop"> {
    if (!ownInstance(intent)) {
      /* Review #5 / L4-4: made for another deployment (a restart re-pointed the server): never submitted here, never
         confirmed from this deployment's state -- and never held either: it is another pool's work, skipped in memory. */
      skip(intent, "deployment-unavailable", `the intent belongs to ${intent.instance.slice(0, 160)}, not to this relayer's ${deps.chainId} ${deps.contract}`);
      return "settled";
    }
    const game = await readGame(intent.op.chain_game_id);
    const effect = await effectOf(intent, game);
    if (effect.kind === "done") {
      const next = await write(intent, confirmedIntent(intent, "chain-state", null, null, effect.detail, deps.now()));
      if (next !== null) await resolved(next);
      return "settled";
    }
    if (effect.kind === "moot") {
      const next = await write(intent, supersededIntent(intent, effect.why, deps.now()));
      if (next !== null) await resolved(next);
      return "settled";
    }
    if (effect.kind === "inconsistent") {
      await hold(intent, "chain-inconsistent", effect.detail);
      return "settled";
    }
    /* A newer checkpoint of the same game, not yet on chain, makes this one unnecessary (nothing was signed for it). */
    if (intent.op.kind === "checkpoint") {
      const newer = [...open.entries()].filter(([id, gameId]) => gameId === intent.game_id && id !== intent.intent_id);
      for (const [id] of newer) {
        const other = await deps.store.load(intent.game_id, id).catch(() => null);
        /* Review #14: only a newer checkpoint that can still land (or has) supersedes -- never a held one. */
        if (other !== null && other.op.kind === "checkpoint" && (other.status === "pending" || other.status === "in-flight" || other.status === "confirmed") && BigInt(other.op.seq) > BigInt(intent.op.seq)) {
          const next = await write(intent, supersededIntent(intent, `a newer checkpoint (seq ${other.op.seq}) supersedes it`, deps.now()));
          if (next !== null) await resolved(next);
          return "settled";
        }
      }
    }
    const block = await deps.rest.latestBlock();
    const ready = await readiness(intent, game, blockSeconds(block.time));
    if (ready.kind === "wait") {
      await defer(intent, ready.untilMs, ready.why, false);
      return "waiting";
    }
    if (ready.kind === "moot") {
      const next = await write(intent, supersededIntent(intent, ready.why, deps.now()));
      if (next !== null) await resolved(next);
      return "settled";
    }
    if (ready.kind === "hold") {
      await hold(intent, ready.code, ready.detail);
      return "settled";
    }
    if (intent.attempts.length >= 32) {
      await hold(intent, "chain-intent-held", "the attempt budget is spent");
      return "settled";
    }
    /* Review #5/#6: the financial record's word (a held game submits nothing new; a released freeze's Start is dead). */
    const admission = deps.admit === undefined ? ({ kind: "ok" } as const) : await deps.admit(intent);
    if (admission.kind === "skip") {
      skip(intent, admission.why, admission.why);
      return "settled";
    }
    if (admission.kind === "undecided") {
      leaveUndecided(intent, admission.why);
      return "settled";
    }
    if (admission.kind === "wait") {
      await defer(intent, deps.now() + idleMs, admission.why, false);
      return "waiting";
    }
    if (admission.kind === "hold") {
      await hold(intent, admission.code, admission.why);
      return "settled";
    }

    /* 1. The authoritative account sequence, and the expiry height. */
    const account = await accountOf();
    const timeoutHeight = (BigInt(block.height) + BigInt(deps.timeoutBlocks)).toString();
    const base = {
      chainId: deps.chainId,
      accountNumber: account.account_number,
      sequence: account.sequence,
      sender: deps.account.address,
      contract: deps.contract,
      msgJson: intent.msg_json,
      publicKey: deps.account.signer.publicKey,
      timeoutHeight,
      memo: deps.memo ?? "",
    };
    /* 2. Simulate (the contract runs; nothing is signed or spent), then bound the gas. */
    const probe = prepareExecuteTx({ ...base, gasLimit: deps.gas.maxGas.toString(), fee: { denom: deps.gas.feeDenom, amount: "0" } });
    const simulated = await deps.rest.simulate(simulationTx(probe));
    if (!simulated.ok) {
      const { error } = classifyContractFailure(simulated.log);
      const known = /execute wasm contract failed|failed to execute message/.test(simulated.log);
      if (known && error.retry === "never") {
        await hold(intent, "chain-intent-held", `the contract refuses it (${error.native.name}): ${simulated.log.slice(0, 300)}`);
        return "settled";
      }
      /* StaleSeq / WrongState / a window: the next pass re-reads the effect. Review #14: a node's own trouble (not the
         contract's answer) backs off without spending the intent's failure budget. */
      const counts = known && !(error.code === "STALE_SEQUENCE" || error.code === "INVALID_LIFECYCLE" || error.code === "WINDOW_OPEN");
      lastError = `simulation refused: ${known ? error.native.name : simulated.log.slice(0, 200)}`;
      await defer(intent, deps.now() + backoffMs(intent.retry.failures), lastError, counts);
      return "waiting";
    }
    const gas = decideGas(simulated.gas_used, deps.gas);
    if (!gas.ok) {
      await hold(intent, "chain-intent-held", `gas refused: ${gas.reason}`);
      return "settled";
    }
    const fee: Coin = { denom: deps.gas.feeDenom, amount: gas.fee.toString() };
    /* 3. Sign the final bytes. */
    const prepared = prepareExecuteTx({ ...base, gasLimit: gas.gasLimit.toString(), fee });
    let signed: { txBytes: Buffer; txHash: string };
    try {
      signed = assembleTx(prepared, await deps.account.signer.sign(prepared.digest));
    } catch (error) {
      if (error instanceof SignerError && error.code !== "unavailable") {
        await hold(intent, "chain-intent-held", `the relayer key refused: ${error.message}`);
        return "settled";
      }
      await defer(intent, deps.now() + backoffMs(intent.retry.failures), `signing failed: ${error instanceof Error ? error.message : String(error)}`, true);
      return "waiting";
    }
    /* 4. PERSIST BEFORE BROADCAST -- the external journal FIRST (review #4: so every attempt the store holds, and so
       every attempt any later pass may rebroadcast, is journalled), then the store (CAS). If either fails, the bytes
       never leave this process and the pass ends; a journalled attempt the store never took is spent by nobody. */
    const at = deps.now();
    try {
      await deps.journal.recordAttempt({ intent_id: intent.intent_id, tx_id: signed.txHash, account: deps.account.address, account_sequence: account.sequence, expires_after_height: timeoutHeight });
    } catch (error) {
      lastError = `journal: ${error instanceof Error ? error.message : String(error)}`;
      deps.warn(`  relayer: the signing journal refused an attempt for ${intent.game_id}; nothing was stored or broadcast`);
      writeFailed = true;
      return "stop";
    }
    const withAttempt = withNewAttempt(
      intent,
      { account: deps.account.address, account_number: account.account_number, sequence: account.sequence, timeout_height: timeoutHeight, gas_limit: gas.gasLimit.toString(), fee, tx_hash: signed.txHash, tx_bytes: signed.txBytes.toString("base64"), signed_at: at },
      at,
    );
    const persisted = await write(intent, withAttempt);
    if (persisted === null) return "stop"; // not known to be stored: nothing is broadcast, nothing else is signed this pass
    audit("chain.signed", { game_id: intent.game_id, intent_id: intent.intent_id, op: intent.op.kind, tx_hash: signed.txHash, sequence: account.sequence, timeout_height: timeoutHeight, gas_limit: gas.gasLimit.toString(), fee: fee.amount });
    /* 5. Broadcast. Whatever the answer, the next passes observe the chain. */
    await broadcast(persisted, persisted.attempts[persisted.attempts.length - 1]);
    return "in-flight";
  }

  /* ---------------- the pass ---------------- */

  /** Review #3: an intent that cannot be read may hold the live attempt -- the pass ends (throws) and nothing is signed
   *  until it reads again (or an operator restores it). */
  /** The undecided intents as they are stored now (a resolved or vanished one leaves the set). */
  async function undecidedIntents(): Promise<ChainIntentRecord[]> {
    const out: ChainIntentRecord[] = [];
    for (const [intentId, entry] of [...undecided]) {
      const record = await deps.store.load(entry.game_id, intentId);
      if (record === null || record.status === "confirmed" || record.status === "superseded") {
        undecided.delete(intentId);
        continue;
      }
      out.push(record);
    }
    return out.sort(intentOrder);
  }

  async function openIntents(): Promise<ChainIntentRecord[]> {
    const out: ChainIntentRecord[] = [];
    for (const [intentId, gameId] of [...open]) {
      const record = await deps.store.load(gameId, intentId);
      if (record === null || record.status === "confirmed" || record.status === "superseded") {
        open.delete(intentId);
        continue;
      }
      out.push(record);
    }
    return out.sort(intentOrder);
  }

  /** The startup guard (review #1): journalled attempts the store forgot keep the account's sequence until the chain
   *  has spent past them, or until every one of them has expired (signed before this process started, each expires
   *  within `timeoutBlocks` of the height this pass first saw). */
  async function forgottenBlocks(): Promise<boolean> {
    if (forgotten === null) return false;
    const account = await accountOf();
    if (BigInt(account.sequence) > forgotten.maxSequence) {
      deps.warn(`  relayer: the chain has spent past every forgotten journalled attempt (sequence ${account.sequence}); signing resumes`);
      forgotten = null;
      return false;
    }
    const block = await deps.rest.latestBlock();
    const height = BigInt(block.height);
    if (forgotten.untilHeight === null) forgotten.untilHeight = height + BigInt(deps.timeoutBlocks) + BigInt(1);
    if (height > forgotten.untilHeight) {
      deps.warn(`  relayer: every forgotten journalled attempt has expired (height ${block.height}); signing resumes`);
      forgotten = null;
      return false;
    }
    lastError = `${forgotten.attempts} journalled attempts are unknown to the intent store (a restored store?); nothing new is signed until the chain spends sequence ${forgotten.maxSequence.toString()} or height ${forgotten.untilHeight.toString()} passes`;
    return true;
  }

  async function runPass(): Promise<number> {
    passes += 1;
    writesThisPass = 0;
    writeFailed = false;
    lastError = null; // the status names the LAST pass's trouble (set below, or by the pass's failure)
    if (deps.active?.() === false) return idleMs;
    /* L4-4: the verdict before any write -- every open intent (the live ones included) and every undecided one, once
       each. A skipped one leaves this relayer's work untouched on disk; an undecided one is asked again next pass; the
       owner's conflict is held (a held intent's live attempt is still observed below: its sequence is the account's
       until the chain resolves it). Only what THIS pass decided is acted on below: an intent poked in the meantime
       waits for the next pass's verdict. */
    const decided = new Set<string>();
    const queue = new Map<string, ChainIntentRecord>();
    for (const intent of [...(await openIntents()), ...(await undecidedIntents())]) if (!queue.has(intent.intent_id)) queue.set(intent.intent_id, intent); // once each (review N-2)
    for (const intent of queue.values()) {
      let verdict: IntentServing;
      try {
        verdict = await servingOf(intent);
      } catch (error) {
        leaveUndecided(intent, error instanceof Error ? error.message : String(error));
        continue;
      }
      if (verdict.kind === "skip") {
        skip(intent, verdict.why, verdict.detail);
        continue;
      }
      if (undecided.delete(intent.intent_id)) open.set(intent.intent_id, intent.game_id); // decided now: back in the work
      decided.add(intent.intent_id);
      if (verdict.kind === "hold" && intent.status !== "held") {
        await hold(intent, verdict.code, verdict.why);
        if (writeFailed) return pollMs;
      }
    }
    const intents = (await openIntents()).filter((intent) => decided.has(intent.intent_id));
    /* Every live attempt is observed first; while one is unresolved, nothing new is signed. A held intent's live
       attempt is still observed: its sequence is the account's until the chain resolves it. */
    const liveOnes = intents.filter((intent) => intent.attempts.some(isLiveAttempt));
    for (const intent of liveOnes) {
      const observed = await observe(intent);
      if (observed === null || observed.attempts.some(isLiveAttempt) || writeFailed) return pollMs;
    }
    live = null;
    if (await forgottenBlocks()) return pollMs * 2;
    if (await unobservedBlocks()) return pollMs * 2;
    const now = deps.now();
    const refreshed = (await openIntents()).filter((intent) => decided.has(intent.intent_id));
    const runnable = refreshed.filter((intent) => intent.status === "pending" && intent.retry.next_at <= now);
    for (const intent of runnable) {
      let outcome: Awaited<ReturnType<typeof advance>>;
      try {
        outcome = await advance(intent);
      } catch (error) {
        /* The chain itself unavailable (or the account unusable) ends the pass for everyone. Any other failure is THIS
           intent's (a refused query about its game, an answer that does not parse): it backs off, and the pass ENDS --
           nothing else is signed after an exception, and the next pass takes the others while this one waits. */
        if (error instanceof RelayerStop || (error instanceof JunoRpcError && error.kind !== "refused")) throw error;
        lastError = `${intent.op.kind} for ${intent.game_id}: ${error instanceof Error ? error.message : String(error)}`;
        deps.warn(`  relayer: ${lastError}`);
        const current = await deps.store.load(intent.game_id, intent.intent_id).catch(() => null);
        if (current !== null && current.status === "pending" && !current.attempts.some(isLiveAttempt)) await defer(current, deps.now() + backoffMs(current.retry.failures), lastError, true);
        return pollMs;
      }
      if (outcome === "in-flight" || outcome === "stop" || writeFailed) return pollMs;
    }
    const waiting = refreshed.filter((intent) => intent.status === "pending").map((intent) => intent.retry.next_at);
    if (runnable.length > 0) return writesThisPass > 0 ? 0 : pollMs; // progress: look again at once (never a hot loop on a failing store)
    return waiting.length > 0 ? Math.max(0, Math.min(idleMs, Math.min(...waiting) - now)) : idleMs;
  }

  function pass(): Promise<void> {
    if (running !== null) {
      again = true;
      return running;
    }
    const run = (async () => {
      let next = idleMs;
      try {
        next = await runPass();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const stop = error instanceof RelayerStop;
        const transport = error instanceof JunoRpcError;
        deps.warn(`  relayer: ${stop ? "STOPPED" : transport ? "chain unavailable" : "a pass failed"} -- ${lastError}`);
        next = stop ? idleMs : pollMs * 2;
      }
      return next;
    })().then((next) => {
      running = null;
      if (again) {
        again = false;
        kick(0);
      } else {
        kick(next);
      }
    });
    running = run;
    return run;
  }

  return {
    poke(gameId, intentId) {
      open.set(intentId, gameId);
      kick(0);
    },
    wake() {
      kick(0);
    },
    async load() {
      /* Review #3: a game whose intents cannot be listed may hold the live attempt: the load FAILS (the backend retries
         it) rather than start a relayer that cannot see it -- when they are DAMAGED. L4-4: intents in another build's
         format (newer, or older and no longer read) are another pool's work: never parsed here; their journalled
         attempts stay unknown to this load, so the forgotten-attempt guard below keeps the account's sequence for them
         (which needs a journal that lists every attempt: without one this still fails closed). An intent this relayer
         does not continue is skipped in memory, and one whose verdict cannot be computed now is left undecided (asked
         again at every pass); either way its live attempts on this account keep the account's sequence. */
      const known = new Set<string>();
      for (const gameId of await deps.store.games()) {
        const format = deps.store.formatOf === undefined ? "current" : await deps.store.formatOf(gameId);
        if ((format === "newer" || format === "older-unread") && deps.journal.allAttempts !== undefined) {
          if (!skippedGames.has(gameId)) {
            skippedGames.add(gameId);
            deps.warn(`  relayer: the chain intents of ${gameId} are in ${format === "newer" ? "a NEWER" : "an OLDER"} format than this build reads; never parsed or written here`);
            audit("chain.intents-skipped", { game_id: gameId, format });
          }
          continue;
        }
        const records = await deps.store.listGame(gameId);
        for (const record of records) {
          /* Every attempt this store holds is known (review R-7): a skipped or undecided intent's live attempts are
             guarded by `unobserved`; the forgotten guard is for attempts NO readable record holds. */
          for (const attempt of record.attempts) known.add(attempt.tx_hash);
          if (record.status === "confirmed" || record.status === "superseded") continue;
          let verdict: IntentServing;
          try {
            verdict = await servingOf(record);
          } catch (error) {
            /* One game's facts unreadable now never fails the load for everyone (review R-1): undecided, asked again. */
            leaveUndecided(record, error instanceof Error ? error.message : String(error));
            continue;
          }
          if (verdict.kind === "skip") {
            skip(record, verdict.why, verdict.detail);
            continue;
          }
          open.set(record.intent_id, gameId);
        }
      }
      /* LIVE-5 L5-5: an async read of this account's journalled attempts (the ledger is never loaded whole); a read that
         fails, or finds a damaged or newer record, fails the load -- the backend retries it, and nothing is signed meanwhile. */
      const journalled = deps.journal.allAttempts === undefined ? [] : await deps.journal.allAttempts(deps.account.address);
      const lost = journalled.filter((entry) => entry.account === deps.account.address && !known.has(entry.tx_id));
      if (lost.length > 0) {
        const max = lost.reduce((best, entry) => (BigInt(entry.sequence) > best ? BigInt(entry.sequence) : best), BigInt(0));
        const expiries = lost.map((entry) => entry.expires_after_height);
        const until = expiries.every((height): height is string => height !== undefined) ? expiries.reduce((best, height) => (BigInt(height) > best ? BigInt(height) : best), BigInt(0)) : null;
        forgotten = { attempts: lost.length, maxSequence: max, untilHeight: until };
        deps.warn(`  relayer: ${lost.length} journalled attempts are not in the intent store (highest sequence ${max.toString()}); nothing new is signed until the chain has spent or expired them`);
        audit("chain.forgotten-attempts", { attempts: lost.length, max_sequence: max.toString() });
      }
      kick(0);
    },
    pass,
    status: () => ({
      open: open.size,
      live,
      last_error: lastError,
      passes,
      forgotten_guard: forgotten === null ? null : { attempts: forgotten.attempts, max_sequence: forgotten.maxSequence.toString(), until_height: forgotten.untilHeight === null ? null : forgotten.untilHeight.toString() },
      skipped: skipped.size,
      skipped_games: skippedGames.size,
      undecided: undecided.size,
    }),
    stop() {
      stopped = true;
      timer?.cancel();
      timer = null;
    },
  };
}

/** Submission order: oldest first; within one game, by slot -- the Start, then checkpoints and the Settle by seq (the
 *  terminal checkpoint 2L before the Settle 2L+1), the Finalize last -- so a tie in creation time never reorders them. */
export function intentOrder(a: ChainIntentRecord, b: ChainIntentRecord): number {
  if (a.game_id === b.game_id) {
    /* ESCROW-4: a consent follows the Settle it consents to (same seq) and precedes its Finalize; an annul is ordered by
       the trusted sequence it binds. */
    const rank = (intent: ChainIntentRecord): [number, bigint] => {
      const op = intent.op;
      switch (op.kind) {
        case "start":
          return [0, BigInt(0)];
        case "finalize":
          return [3, BigInt(op.seq)];
        case "consent":
          return [2, BigInt(op.seq)];
        case "annul":
          return [1, BigInt(op.trusted_seq)];
        default:
          return [1, BigInt(op.seq)];
      }
    };
    const [ra, sa] = rank(a);
    const [rb, sb] = rank(b);
    if (ra !== rb) return ra - rb;
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return a.created_at - b.created_at || a.intent_id.localeCompare(b.intent_id);
}

/** A condition no intent can fix (a missing or foreign-keyed relayer account): the relayer waits for the operator. */
export class RelayerStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayerStop";
  }
}

/** A DeliverTx failure as a neutral error: the contract's refusal when it is one, else the SDK's. */
export function classifyTxFailure(result: { readonly code: number; readonly codespace: string; readonly raw_log: string }): EscrowError {
  if (result.codespace === "wasm" || /execute wasm contract failed/.test(result.raw_log)) return classifyContractFailure(result.raw_log).error;
  const native = { backend: "juno-cosmwasm" as const, name: `sdk/${result.codespace}/${result.code}`, message: result.raw_log.slice(0, 500) };
  if (result.codespace === "sdk" && (result.code === SDK.outOfGas || result.code === SDK.insufficientFee || result.code === SDK.wrongSequence || result.code === SDK.txTimeoutHeight)) {
    return { code: "TX_REJECTED", retry: "after-refresh", native };
  }
  if (result.codespace === "sdk" && (result.code === SDK.insufficientFunds || result.code === SDK.unauthorized)) return { code: "TX_REJECTED", retry: "backoff", native };
  return { code: "BACKEND_INVARIANT", retry: "reconcile-first", native };
}
