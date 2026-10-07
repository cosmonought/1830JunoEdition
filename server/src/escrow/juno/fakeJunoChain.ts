// server/src/escrow/juno/fakeJunoChain.ts
//
// ==================================================================
//  ESCROW-3B TEST SUPPORT: AN OFFLINE JUNO -- ACCOUNTS, A MEMPOOL, BLOCKS, AN INDEX, AND THE ESCROW'S RELAYER ROUTES
// ==================================================================
//
// Never imported by production code. It implements `JunoRest` over an in-memory chain that behaves like the parts of
// Juno the relayer depends on, so the adversarial matrix (brief §24) runs without a network:
//
//   Cosmos      DECODES the relayer's TxRaw bytes (protobuf), verifies the secp256k1 SIGN_MODE_DIRECT signature over
//               the SignDoc it re-derives (chain id + account number), requires the exact account sequence, honours
//               `timeout_height`, charges the fee, and indexes inclusion by hash and by `tx.acc_seq`.
//   the escrow  Start / Checkpoint / Settle / Finalize with the frozen contract's rules and its Display-text refusals
//               (operator-only Start, the roster hash, the domain, the trusted sequence, signer keys, signatures over
//               the SETTLE digest, pause, the challenge window) -- through the certified SET-0C functions; a wallet's
//               Join (escrow 2.0.0) verifies the server's ADMISSION over the JOIN digest of its own sender, as the
//               contract does (`junoJoinAdmissionV1.ts`, pinned to the contract by the frozen vectors).
//   faults      a lost broadcast answer (the tx IS in the mempool), a broadcast that never arrived, an unavailable
//               node, a wrong chain id, a disabled tx index, an absurd simulation, a malformed answer.
//
// Blocks are produced only by `produceBlock()` (tests decide when time passes).
//
// FINANCIAL PROTOCOL 4 (Phase 3 escrow 2.1): the fake reports escrow 2.1.0. A game created or seeded WITH a deadline
// class carries the 2.1.0 exit policy (`timed_remedy_v1` / `no_deadline`, its allowance, its start time) and accepts
// `submit_remedy` exactly as `contracts/escrow/src/execute/remedy.rs` decides it (the REMEDY key registry, the
// attestation's shape against the game, finality, expiry, the trusted sequence, the approvals, the foreclosing
// remedies' pause rule, the three outcomes), and the universal unanimous annulment reaches its DISPUTED state; a
// resolver seated in a 2.1.0 game never resolves it, a third strike is never replaced, its trust is the remedy
// registry's, and a 2.1.0 game's compromised settlement is never replaced by a checkpoint at the resolver timeout. A
// Live game made or seeded WITHOUT a deadline gets the Live action clock (the only Live class the contract accepts); an
// async one without a deadline keeps the 2.0.0-stored shape (policy null) the pre-FP4 suites model -- a real 2.1.0
// contract refuses a CreateGame without a deadline.

import { createHash } from "crypto";

import {
  annulDigestV1,
  checkSettlementPayloadV1,
  consentDigestV1,
  encodeSettlementPayloadV1Hex,
  rosterHashV1,
  settleDigestOfEncodedHex,
  settlementDomainV1,
  settlementPayloadFromWire,
  SettlementPayloadError,
} from "../../../../frontend/src/gameEngine/settlementPayload";
import { encodeSignDoc, signDocDigest, txHashOf, u64Of } from "./cosmosTx";
import { JunoRpcError, type AccountView, type BlockView, type JunoContractFacts, type JunoRest, type SimulateResult, type TxResultView } from "./junoRest";
import { verifyDigest } from "./secp256k1";
import { joinAdmissionDigestV1 } from "../../../../frontend/src/gameEngine/escrow/junoJoinAdmissionV1";
import {
  ASYNC_PACES_SECS,
  LIVE_ACTION_SECS,
  LIVE_CURE_WINDOW_SECS,
  MAX_REMEDY_TTL_SECS,
  remedyApproveDigestV1,
  remedyDigestV1,
  remedyForecloses,
  remedyMode,
  remedyNeedsApprovals,
  type RemedyAttestationV1,
  type RemedyKindByte,
} from "../../../../frontend/src/gameEngine/escrow/junoRemedyV1";

/* ------------------------------------------------------------------ */
/* Protobuf decoding (the relayer's own transaction shape)              */
/* ------------------------------------------------------------------ */

type Fields = Map<number, Array<bigint | Buffer>>;

function readVarint(bytes: Buffer, at: number): [bigint, number] {
  let value = BigInt(0);
  let shift = BigInt(0);
  for (let i = at; i < bytes.length; i += 1) {
    const byte = bytes[i];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, i + 1];
    shift += BigInt(7);
  }
  throw new Error("truncated varint");
}

export function decodeFields(bytes: Buffer): Fields {
  const out: Fields = new Map();
  let at = 0;
  while (at < bytes.length) {
    const [key, next] = readVarint(bytes, at);
    at = next;
    const field = Number(key >> BigInt(3));
    const wire = Number(key & BigInt(7));
    let value: bigint | Buffer;
    if (wire === 0) {
      [value, at] = readVarint(bytes, at);
    } else if (wire === 2) {
      const [length, start] = readVarint(bytes, at);
      value = bytes.subarray(start, start + Number(length));
      if (value.length !== Number(length)) throw new Error("truncated field");
      at = start + Number(length);
    } else {
      throw new Error(`wire type ${wire} is not used by the relayer`);
    }
    out.set(field, [...(out.get(field) ?? []), value]);
  }
  return out;
}

const one = (fields: Fields, n: number): Buffer => (fields.get(n)?.[0] as Buffer | undefined) ?? Buffer.alloc(0);
const num = (fields: Fields, n: number): bigint => (fields.get(n)?.[0] as bigint | undefined) ?? BigInt(0);

export interface DecodedTx {
  readonly hash: string;
  readonly bodyBytes: Buffer;
  readonly authInfoBytes: Buffer;
  readonly signature: Buffer;
  readonly sender: string;
  readonly contract: string;
  readonly msg: Record<string, unknown>;
  readonly msgJson: string;
  readonly timeoutHeight: bigint;
  readonly publicKey: Buffer;
  readonly sequence: bigint;
  readonly gasLimit: bigint;
  readonly fee: bigint;
  readonly feeDenom: string;
}

export function decodeRelayerTx(txBytes: Buffer): DecodedTx {
  const raw = decodeFields(txBytes);
  const bodyBytes = one(raw, 1);
  const authInfoBytes = one(raw, 2);
  const signature = one(raw, 3);
  const body = decodeFields(bodyBytes);
  const anyMsg = decodeFields(one(body, 1));
  if (one(anyMsg, 1).toString() !== "/cosmwasm.wasm.v1.MsgExecuteContract") throw new Error("not MsgExecuteContract");
  const exec = decodeFields(one(anyMsg, 2));
  const msgJson = one(exec, 3).toString("utf8");
  const auth = decodeFields(authInfoBytes);
  const signerInfo = decodeFields(one(auth, 1));
  const pubAny = decodeFields(one(signerInfo, 1));
  const pub = decodeFields(one(pubAny, 2));
  const fee = decodeFields(one(auth, 2));
  const coin = decodeFields(one(fee, 1));
  return {
    hash: txHashOf(txBytes),
    bodyBytes,
    authInfoBytes,
    signature,
    sender: one(exec, 1).toString(),
    contract: one(exec, 2).toString(),
    msg: JSON.parse(msgJson) as Record<string, unknown>,
    msgJson,
    timeoutHeight: num(body, 3),
    publicKey: one(pub, 1),
    sequence: num(signerInfo, 3),
    gasLimit: num(fee, 2),
    fee: BigInt(one(coin, 2).toString() || "0"),
    feeDenom: one(coin, 1).toString(),
  };
}

/* ------------------------------------------------------------------ */
/* The escrow (relayer routes)                                         */
/* ------------------------------------------------------------------ */

export interface FakeSeat {
  wallet: string;
  consent_pubkey: string;
  join_ticket: string;
  /** ESCROW-4: chain seconds the seat joined (the creator's CreateGame, or its Join); the fake's clock when absent. */
  joined_at?: number;
  consent_key_rotated_at?: number | null;
  /** Escrow 2.1.0 (owner ruling, 2026-10-07): keys this seat replaced while its `timed_remedy_v1` game was IN_PROGRESS,
   *  oldest first, with the rotation's chain seconds (`state.rs::RETIRED_CONSENT_KEYS` -- kept OUTSIDE the game record:
   *  never part of a game answer; read by `SubmitRemedy` and the `consent_key_at` query). */
  retired_consent_keys?: { pubkey: string; retired_at: number }[];
}

/** `helpers.rs::consent_key_at`: the key `seat` held at `atSecs` (the first retired strictly after it, else current). */
export function fakeConsentKeyAt(seat: FakeSeat, atSecs: bigint): string {
  const retired = (seat.retired_consent_keys ?? []).find((entry) => BigInt(entry.retired_at) > atSecs);
  return retired === undefined ? seat.consent_pubkey : retired.pubkey;
}

interface PayloadRecordJson {
  seq: string;
  kind: number;
  reason: number;
  log_len: string;
  log_hash: string;
  appraisal_log_len: string;
  appraisal_state_hash: string;
  state_schema_version: number;
  settlement_weights: string[];
  signer_key_id: number;
  issued_at: string;
  payload_digest: string;
}

/** FP4 (escrow 2.1.0): a CreateGame's `deadline` (`msg.rs::DeadlineChoice`). */
export type FakeDeadline = { readonly live_action_clock: Record<string, never> } | { readonly async_pace: { readonly allowance_secs: number } } | { readonly no_deadline: Record<string, never> };

/** FP4: the accepted remedy (`state.rs::RemedyRecord`, the fields the server reads). */
interface FakeRemedy {
  kind: string;
  defaulting_seat: number;
  strike: number;
  overdue_epoch: string;
  log_len: string;
  final_at: string;
  attested_at: string;
  expires_at: string;
  remedy_key_id: number;
  remedy_digest: string;
  approvals_bitmap: number;
  accepted_at: number;
}

const REMEDY_KIND_NAMES: Readonly<Record<number, string>> = Object.freeze({ 1: "live_timeout_annul", 2: "live_foreclose", 3: "live_strike3_foreclose", 4: "async_annul", 5: "async_foreclose" });

/** The fake's terms for a game made without a deadline: Live -> the action clock; async -> the 2.0.0-stored shape. */
const defaultTerms = (mode: "live" | "async") => (mode === "live" ? { policy: "timed_remedy_v1" as const, allowance_secs: LIVE_ACTION_SECS } : { policy: null, allowance_secs: 0 });

/** FP4: a deadline class against the game's mode (`funding.rs::create_game`, escrow 2.1.0), or why it does not suit. */
export function fakePolicyOf(mode: "live" | "async", deadline: FakeDeadline): { readonly policy: "timed_remedy_v1" | "no_deadline"; readonly allowance_secs: number } | string {
  if ("live_action_clock" in deadline) return mode === "live" ? { policy: "timed_remedy_v1", allowance_secs: LIVE_ACTION_SECS } : "this deadline class does not suit the game's mode (live: live_action_clock; async: async_pace or no_deadline)";
  if (mode !== "async") return "this deadline class does not suit the game's mode (live: live_action_clock; async: async_pace or no_deadline)";
  if ("no_deadline" in deadline) return { policy: "no_deadline", allowance_secs: 0 };
  const pace = deadline.async_pace.allowance_secs;
  return ASYNC_PACES_SECS.includes(pace) ? { policy: "timed_remedy_v1", allowance_secs: pace } : `async pace ${pace} s is not one of 43200, 86400, 172800, 259200, 604800`;
}

interface FakeGame {
  chain_game_id: number;
  state: string;
  creator: string;
  max_players: number;
  mode: "live" | "async";
  rules_engine_version: number;
  variants_digest: string;
  denom: string;
  ante_gross: string;
  ante_net: string;
  seats: FakeSeat[];
  roster_hash: string | null;
  domain: string | null;
  bond: string | null;
  resolver: string | null;
  last_seq: string;
  settlement: { source: string; payload: PayloadRecordJson; accepted_at: number; window_end: number } | null;
  checkpoints: Map<number, { payload: PayloadRecordJson; accepted_at: number }>;
  /** JX-6B: `dispute.rs`'s DisputeRecord, as the contract stores it from `Challenge` on. */
  dispute: FakeDispute | null;
  outcome: { route: string; at: number; amounts: string[]; dust: string; distributed?: string; bond_returned?: string; bond_to_pool?: string } | null;
  last_activity: number | null;
  /* ESCROW-4: the contract's per-game facts the money layer reads (fixed at CreateGame, as the contract fixes them). */
  created_at: number;
  funding_deadline: number;
  subsidy_per_seat: string;
  subsidy_bps: number;
  consent_bitmap: number;
  /** FP4 (escrow 2.1.0): the exit policy and action allowance its deadline fixed (null / 0: a deadline-less game, the
   *  2.0.0-stored shape), its Start time, and its accepted remedy. */
  policy: "timed_remedy_v1" | "no_deadline" | null;
  allowance_secs: number;
  started_at: number | null;
  remedy: FakeRemedy | null;
}

/** JX-6B: the contract's `DisputeRecord` (resolution names: `state.rs::DisputeResolution`, snake_case on the wire). */
interface FakeDispute {
  challenger: string;
  bond: string;
  evidence_hash: string;
  disputed_at: number;
  resolution: "upheld" | "replaced" | "annulled" | "resolver_timeout" | "annulled_by_consent" | null;
  resolved_at: number | null;
}

/** JX-6B: a resolver's decision (`msg.rs::ResolveOutcome`); a Replace names only what the test varies. */
export type FakeResolveOutcome = { readonly uphold: Record<string, never> } | { readonly annul: Record<string, never> } | { readonly replace: { readonly settlement_weights: readonly string[] } };

class ContractFailure extends Error {}

const nanos = (secs: number) => (BigInt(secs) * BigInt(1_000_000_000)).toString();

export interface FakeChainOptions {
  readonly chainId: string;
  readonly contract: string;
  readonly operator: string;
  readonly resolver: string;
  readonly treasury: string;
  readonly denom: string;
  readonly admin: string | null;
  readonly codeId: string;
  readonly codeChecksum: string;
  readonly signerKeys: readonly string[];
  /** ESCROW-JOIN: the contract's `Config.admission_pubkey` (33-byte compressed, hex). */
  readonly admissionPubkey: string;
  readonly challengeWindowSecs?: number;
  readonly livenessWindowSecs?: number;
  readonly resolverTimeoutSecs?: number;
  /** JX-6B: the challenge bond's terms (`params.bond_bps` / `bond_floor`; default 0 / "0": no bond). */
  readonly bondBps?: number;
  readonly bondFloor?: string;
  readonly startTime?: number;
  readonly minGasPriceNum?: bigint;
  readonly minGasPriceDen?: bigint;
  /** ESCROW-4: the contract's fee on every deposit (basis points; config `params.subsidy_bps`, default 100). */
  readonly subsidyBps?: number;
  /** ESCROW-4: the funding period a CreateGame fixes (seconds; default 3600). */
  readonly fundingPeriodSecs?: number;
  readonly minAnte?: string;
  /** FP4 (escrow 2.1.0): the REMEDY key registry at instantiation (ids 1, 2, … in order). */
  readonly remedyKeys?: readonly string[];
}

export class FakeJunoChain implements JunoRest {
  readonly chainId: string;
  height = 100;
  time: number;
  paused = false;
  readonly accounts = new Map<string, { number: bigint; sequence: bigint; pubKey: string | null; balance: bigint }>();
  readonly mempool: DecodedTx[] = [];
  readonly txIndex = new Map<string, TxResultView & { sequenceKey: string }>();
  readonly games = new Map<number, FakeGame>();
  readonly signerKeys: Array<{ key_id: number; pubkey: string; retired: boolean; compromised: boolean }> = [];
  /** FP4 (escrow 2.1.0): the REMEDY key registry (a key class of its own; tests retire or compromise entries). */
  readonly remedyKeys: Array<{ key_id: number; pubkey: string; retired: boolean; compromised: boolean }> = [];
  readonly broadcasts: string[] = [];
  /* ---- faults ---- */
  indexDisabled = false;
  sequenceIndexDisabled = false;
  unavailable = false;
  wrongChainId: string | null = null;
  loseNextBroadcastAnswer = 0;
  dropNextBroadcast = 0;
  simulateGasOverride: string | null = null;
  /** JX-2B: while set, every new broadcast is refused at CheckTx with this answer (a node refusing for a reason the
   *  relayer does not name). */
  checkTxRefusal: { readonly code: number; readonly codespace: string; readonly raw_log: string } | null = null;
  malformedNextAccount = 0;
  /** A node that does not say the height it answered at (no death or rollback proof can be built on it). */
  heightsHidden = false;
  /** LIVE-4 (L4-4): the node reports it is still syncing (no verification-grade fact is read from it). */
  syncingNow = false;
  /** LIVE-4 (L4-4): what the contract REPORTS now, when it is no longer what it was instantiated with (an in-place
   *  migration to other code, another denom): the chain-attested facts a deployment conflict is judged on. */
  reportedChecksum: string | null = null;
  reportedDenom: string | null = null;
  /** FP4: what the contract's cw2 version REPORTS, when a test models other code (an escrow 2.0.0 deployment). */
  reportedContractVersion: string | null = null;
  private nextGameId = 1;
  private nextAccountNumber = BigInt(7);

  /** The admin's `SetAdmissionKey` (tests rotate it). */
  admissionPubkey: string;

  constructor(readonly options: FakeChainOptions) {
    this.chainId = options.chainId;
    this.admissionPubkey = options.admissionPubkey;
    this.time = options.startTime ?? 1_760_000_000;
    options.signerKeys.forEach((pubkey, i) => this.signerKeys.push({ key_id: i + 1, pubkey, retired: false, compromised: false }));
    (options.remedyKeys ?? []).forEach((pubkey, i) => this.remedyKeys.push({ key_id: i + 1, pubkey, retired: false, compromised: false }));
  }

  fund(address: string, amount: bigint): void {
    const account = this.accounts.get(address);
    if (account === undefined) {
      this.accounts.set(address, { number: this.nextAccountNumber, sequence: BigInt(0), pubKey: null, balance: amount });
      this.nextAccountNumber += BigInt(1);
    } else account.balance += amount;
  }

  /** A FUNDED game, as the players' wallets would have made it (CreateGame + Joins). */
  seedFundedGame(input: { seats: FakeSeat[]; anteGross: string; anteNet: string; rulesEngineVersion: number; variantsDigest: string; mode?: 0 | 1; deadline?: FakeDeadline }): string {
    const mode = input.mode === 1 ? "async" : "live";
    const terms = input.deadline === undefined ? defaultTerms(mode) : fakePolicyOf(mode, input.deadline);
    if (typeof terms === "string") throw new Error(`seedFundedGame: ${terms}`);
    const id = this.nextGameId;
    this.nextGameId += 1;
    this.games.set(id, {
      policy: terms.policy,
      allowance_secs: terms.allowance_secs,
      started_at: null,
      remedy: null,
      chain_game_id: id,
      state: "funded",
      creator: input.seats[0].wallet,
      max_players: input.seats.length,
      mode: input.mode === 1 ? "async" : "live",
      rules_engine_version: input.rulesEngineVersion,
      variants_digest: input.variantsDigest,
      denom: this.options.denom,
      ante_gross: input.anteGross,
      ante_net: input.anteNet,
      seats: input.seats.map((seat) => ({ ...seat })),
      roster_hash: null,
      domain: null,
      bond: null,
      resolver: null,
      last_seq: "0",
      settlement: null,
      checkpoints: new Map(),
      dispute: null,
      outcome: null,
      last_activity: null,
      created_at: this.time,
      funding_deadline: this.time + (this.options.fundingPeriodSecs ?? 3600),
      subsidy_per_seat: (BigInt(input.anteGross) - BigInt(input.anteNet)).toString(),
      subsidy_bps: this.options.subsidyBps ?? 100,
      consent_bitmap: 0,
    });
    return String(id);
  }

  /** ESCROW-4: a wallet's CreateGame, as `funding.rs::create_game` decides it: not paused, 2..7 players, the ante at or
   *  above `min_ante`, the fee cut from it (floor(gross * bps / 10000)), the creator seat 0, FUNDING until the deadline. */
  createGame(
    sender: string,
    msg: { readonly max_players: number; readonly mode: "live" | "async"; readonly rules_engine_version: number; readonly variants_digest: string; readonly consent_pubkey: string; readonly join_ticket: string; readonly deadline?: FakeDeadline },
    gross: string,
  ): { ok: true; chainGameId: string } | { ok: false; error: string } {
    if (this.paused) return { ok: false, error: "the contract is paused" };
    /* FP4: a deadline fixes the 2.1.0 policy (absent: `defaultTerms`). */
    const terms = msg.deadline === undefined ? defaultTerms(msg.mode) : fakePolicyOf(msg.mode, msg.deadline);
    if (typeof terms === "string") return { ok: false, error: terms };
    if (!Number.isInteger(msg.max_players) || msg.max_players < 2 || msg.max_players > 7) return { ok: false, error: `max_players must be between 2 and 7, got ${msg.max_players}` };
    if (!/^[0-9a-f]{64}$/.test(msg.variants_digest) || !/^[0-9a-f]{64}$/.test(msg.join_ticket) || !/^0[23][0-9a-f]{64}$/.test(msg.consent_pubkey)) return { ok: false, error: "bad length" };
    if (!/^[1-9][0-9]*$/.test(gross)) return { ok: false, error: `expected exactly one non-zero coin of ${this.options.denom}` };
    if (BigInt(gross) < BigInt(this.options.minAnte ?? "1")) return { ok: false, error: `deposit ${gross} is below the minimum ante ${this.options.minAnte ?? "1"}` };
    const bps = this.options.subsidyBps ?? 100;
    const subsidy = (BigInt(gross) * BigInt(bps)) / BigInt(10_000);
    const net = BigInt(gross) - subsidy;
    const id = this.nextGameId;
    this.nextGameId += 1;
    this.games.set(id, {
      policy: terms.policy,
      allowance_secs: terms.allowance_secs,
      started_at: null,
      remedy: null,
      chain_game_id: id,
      state: "funding",
      creator: sender,
      max_players: msg.max_players,
      mode: msg.mode,
      rules_engine_version: msg.rules_engine_version,
      variants_digest: msg.variants_digest,
      denom: this.options.denom,
      ante_gross: gross,
      ante_net: net.toString(),
      seats: [{ wallet: sender, consent_pubkey: msg.consent_pubkey, join_ticket: msg.join_ticket, joined_at: this.time, consent_key_rotated_at: null }],
      roster_hash: null,
      domain: null,
      bond: null,
      resolver: null,
      last_seq: "0",
      settlement: null,
      checkpoints: new Map(),
      dispute: null,
      outcome: null,
      last_activity: null,
      created_at: this.time,
      funding_deadline: this.time + (this.options.fundingPeriodSecs ?? 3600),
      subsidy_per_seat: subsidy.toString(),
      subsidy_bps: bps,
      consent_bitmap: 0,
    });
    return { ok: true, chainGameId: String(id) };
  }

  /** ESCROW-4: the seat's own wallet replaces its consent key (FUNDING..SETTLEABLE; never another seat's current key). A
   *  real rotation clears the seat's consent bit. */
  setConsentKey(chainGameId: string, wallet: string, pubkey: string): { ok: true } | { ok: false; error: string } {
    const game = this.games.get(Number(chainGameId));
    if (game === undefined) return { ok: false, error: `game ${chainGameId} not found` };
    if (!["funding", "funded", "in_progress", "settleable"].includes(game.state)) return { ok: false, error: `wrong state: game is ${game.state}` };
    const index = game.seats.findIndex((seat) => seat.wallet === wallet);
    if (index < 0) return { ok: false, error: `sender is not seated in game ${chainGameId}` };
    if (!/^0[23][0-9a-f]{64}$/.test(pubkey)) return { ok: false, error: "new_pubkey must be a valid 33-byte compressed secp256k1 public key" };
    const other = game.seats.findIndex((seat, at) => at !== index && seat.consent_pubkey === pubkey);
    if (other >= 0) return { ok: false, error: `this consent key is already used by seat ${other} of this game` };
    if (game.seats[index].consent_pubkey !== pubkey) {
      /* Escrow 2.1.0: a rotation in a remedy game's play keeps the replaced key (no limit; outside the game record). */
      if (game.state === "in_progress" && game.policy === "timed_remedy_v1") {
        game.seats[index].retired_consent_keys = [...(game.seats[index].retired_consent_keys ?? []), { pubkey: game.seats[index].consent_pubkey, retired_at: this.time }];
      }
      game.seats[index].consent_pubkey = pubkey;
      game.seats[index].consent_key_rotated_at = this.time;
      game.consent_bitmap &= ~(1 << index);
    }
    return { ok: true };
  }

  /** ESCROW-4 / JX-6B: a seat's Challenge, as `dispute.rs::challenge` decides it: SETTLEABLE, a seated wallet, block time
   *  before the window's end, exactly the game's frozen bond (`bond` defaults to it; none when it is zero). Works while
   *  paused. The bond is held beside the pool until the dispute ends. */
  challenge(chainGameId: string, wallet: string, options: { readonly bond?: string; readonly evidenceHash?: string } = {}): { ok: true } | { ok: false; error: string } {
    const game = this.games.get(Number(chainGameId));
    if (game === undefined) return { ok: false, error: "not found" };
    if (game.state !== "settleable" || game.settlement === null) return { ok: false, error: `wrong state: game is ${game.state}` };
    if (!game.seats.some((seat) => seat.wallet === wallet)) return { ok: false, error: "not seated" };
    if (this.time >= game.settlement.window_end) return { ok: false, error: "the challenge window closed" };
    const bond = game.bond ?? "0";
    const paid = options.bond ?? bond;
    if (paid !== bond) return { ok: false, error: `the challenge bond must be exactly ${bond}, got ${paid}` };
    game.dispute = { challenger: wallet, bond, evidence_hash: options.evidenceHash ?? "ee".repeat(32), disputed_at: this.time, resolution: null, resolved_at: null };
    game.state = "disputed";
    return { ok: true };
  }

  /** JX-6B: the game's resolver decides a DISPUTED game (`dispute.rs::resolve`). Uphold: the bond joins the pool, paid by
   *  the stored weights. Replace: a ResolverCorrection with the resolver's weights (authorised by the sender, never by a
   *  signature), the bond back to the challenger, paid at once. Annul: every net ante back, the bond back. */
  resolve(chainGameId: string, sender: string, outcome: FakeResolveOutcome): { ok: true } | { ok: false; error: string } {
    const game = this.games.get(Number(chainGameId));
    if (game === undefined) return { ok: false, error: "not found" };
    if (game.state !== "disputed" || game.dispute === null || game.settlement === null) return { ok: false, error: `wrong state: game is ${game.state}` };
    if (sender !== game.resolver) return { ok: false, error: "unauthorized: resolver" };
    /* Escrow 2.1.0: a resolver seated in the game never adjudicates it; a third strike is upheld or annulled only. */
    if (game.policy !== null && game.seats.some((seat) => seat.wallet === game.resolver)) return { ok: false, error: "the game's resolver holds a seat in it, so it can neither review nor judge it" };
    if ("replace" in outcome && game.settlement.source === "remedy_strike3") return { ok: false, error: "a third-strike foreclosure can only be upheld or annulled, never replaced" };
    const dispute = game.dispute;
    if ("uphold" in outcome) {
      dispute.resolved_at = this.time;
      dispute.resolution = "upheld";
      this.payOut(game, "resolver_uphold", { toPool: dispute.bond });
    } else if ("replace" in outcome) {
      const weights = [...outcome.replace.settlement_weights];
      if (weights.length !== game.seats.length) return { ok: false, error: "the roster length differs" };
      if (weights.every((w) => BigInt(w) === BigInt(0))) return { ok: false, error: "the settlement weights sum to zero" };
      /* The corrected payload: the stored one's log position and commitments, reason 5 (ResolverCorrection), the
         resolver's weights -- encoded and digested by the certified codec, as `resolve` stores it. */
      const p = game.settlement.payload;
      let replaced: PayloadRecordJson;
      try {
        const payload = settlementPayloadFromWire({
          version: 1, domain: game.domain, seq: p.seq, kind: 1, reason: 5, log_len: p.log_len, log_hash: p.log_hash,
          appraisal_log_len: p.log_len, appraisal_state_hash: p.appraisal_state_hash, state_schema_version: p.state_schema_version,
          seat_count: weights.length, settlement_weights: weights, signer_key_id: p.signer_key_id, issued_at: p.issued_at,
        });
        checkSettlementPayloadV1(payload, "ResolverReplace");
        replaced = { ...p, reason: 5, appraisal_log_len: p.log_len, settlement_weights: weights, payload_digest: settleDigestOfEncodedHex(encodeSettlementPayloadV1Hex(payload)) };
      } catch (error) {
        return { ok: false, error: `the replacement payload is malformed: ${error instanceof Error ? error.message : String(error)}` };
      }
      dispute.resolution = "replaced";
      dispute.resolved_at = this.time;
      game.settlement = { source: "resolver_replacement", payload: replaced, accepted_at: this.time, window_end: this.time };
      game.consent_bitmap = 0;
      this.payOut(game, "resolver_replace", { returned: dispute.bond });
    } else {
      dispute.resolution = "annulled";
      dispute.resolved_at = this.time;
      game.outcome = { route: "resolver_annul", at: this.time, amounts: game.seats.map(() => game.ante_net), dust: "0", distributed: (BigInt(game.ante_net) * BigInt(game.seats.length)).toString(), bond_returned: dispute.bond, bond_to_pool: "0" };
      game.state = "annulled";
    }
    return { ok: true };
  }

  /** JX-6B: a seat's LivenessSettle on a DISPUTED game once the resolver timeout has passed (`dispute.rs::liveness_settle`,
   *  the DISPUTED arm): the bond goes back; a trusted stored settlement is paid (`resolver_timeout_payout`); a
   *  compromised one falls back to the best trusted checkpoint (SETTLEABLE again, a fresh window) or refunds everyone
   *  (CANCELLED, `resolver_timeout_refund`). Only the DISPUTED arm is modelled here. */
  resolverTimeoutExit(chainGameId: string, wallet: string): { ok: true } | { ok: false; error: string } {
    const game = this.games.get(Number(chainGameId));
    if (game === undefined) return { ok: false, error: "not found" };
    if (game.state !== "disputed" || game.dispute === null || game.settlement === null) return { ok: false, error: `wrong state: only the DISPUTED arm is modelled, the game is ${game.state}` };
    if (!game.seats.some((seat) => seat.wallet === wallet)) return { ok: false, error: "not seated" };
    const at = game.dispute.disputed_at + (this.options.resolverTimeoutSecs ?? 604_800);
    if (this.time < at) return { ok: false, error: `the resolver timeout has not elapsed; available at ${nanos(at)}` };
    const dispute = game.dispute;
    dispute.resolution = "resolver_timeout";
    dispute.resolved_at = this.time;
    const keyId = game.settlement.payload.signer_key_id;
    const trusted = (id: number) => this.signerKeys.some((key) => key.key_id === id && !key.compromised);
    if (this.settlementTrusted(game)) {
      this.payOut(game, "resolver_timeout_payout", { returned: dispute.bond });
      return { ok: true };
    }
    void keyId;
    /* Escrow 2.1.0: a game with an exit policy never falls back to a checkpoint (a standings payout): it refunds. */
    const best = game.policy !== null ? undefined : [...game.checkpoints.entries()].filter(([id]) => trusted(id)).map(([, record]) => record).sort((a, b) => Number(BigInt(b.payload.seq) - BigInt(a.payload.seq)))[0];
    if (best !== undefined) {
      game.settlement = { source: "liveness_checkpoint", payload: best.payload, accepted_at: this.time, window_end: this.time + (this.options.challengeWindowSecs ?? 600) };
      game.consent_bitmap = 0;
      game.state = "settleable";
      return { ok: true };
    }
    game.outcome = { route: "resolver_timeout_refund", at: this.time, amounts: game.seats.map(() => game.ante_net), dust: "0", distributed: (BigInt(game.ante_net) * BigInt(game.seats.length)).toString(), bond_returned: dispute.bond, bond_to_pool: "0" };
    game.state = "cancelled";
    return { ok: true };
  }

  private check(): void {
    if (this.unavailable) throw new JunoRpcError("unavailable", "the fake node is down");
  }

  /** `helpers.rs::settlement_is_trusted`: the stored settlement's key, in the registry its source names (a third strike
   *  in the remedy registry, everything else in the signer registry), is not compromised. */
  private settlementTrusted(game: FakeGame): boolean {
    if (game.settlement === null) return false;
    const registry = game.settlement.source === "remedy_strike3" ? this.remedyKeys : this.signerKeys;
    const key = registry.find((entry) => entry.key_id === game.settlement?.payload.signer_key_id);
    return key !== undefined && !key.compromised;
  }

  private trustedSeq(game: FakeGame): bigint {
    let best = BigInt(0);
    for (const [keyId, record] of game.checkpoints) {
      if (this.signerKeys.find((key) => key.key_id === keyId)?.compromised) continue;
      if (BigInt(record.payload.seq) > best) best = BigInt(record.payload.seq);
    }
    /* A third-strike foreclosure's key is a REMEDY key: its trust is the remedy registry's (escrow 2.1.0). */
    const registry = game.settlement?.source === "remedy_strike3" ? this.remedyKeys : this.signerKeys;
    if (game.settlement !== null && !registry.find((key) => key.key_id === game.settlement?.payload.signer_key_id)?.compromised) {
      if (BigInt(game.settlement.payload.seq) > best) best = BigInt(game.settlement.payload.seq);
    }
    return best;
  }

  private gameResponse(game: FakeGame): unknown {
    const latest = [...game.checkpoints.values()].sort((a, b) => Number(BigInt(b.payload.seq) - BigInt(a.payload.seq)))[0] ?? null;
    return {
      game: {
        chain_game_id: game.chain_game_id,
        state: game.state,
        creator: game.creator,
        max_players: game.max_players,
        mode: game.mode,
        rules_engine_version: game.rules_engine_version,
        variants_digest: game.variants_digest,
        denom: game.denom,
        ante_gross: game.ante_gross,
        subsidy_per_seat: game.subsidy_per_seat,
        ante_net: game.ante_net,
        terms: {
          subsidy_bps: game.subsidy_bps,
          bond_bps: this.options.bondBps ?? 0,
          bond_floor: this.options.bondFloor ?? "0",
          challenge_window_secs: this.options.challengeWindowSecs ?? 600,
          liveness_window_secs: this.options.livenessWindowSecs ?? 86_400,
          resolver_timeout_secs: this.options.resolverTimeoutSecs ?? 604_800,
          treasury: this.options.treasury,
          /* FP4 (escrow 2.1.0; `#[serde(default)]` 0 / null on a deadline-less game). */
          review_delay_secs: game.policy === null ? 0 : 604_800,
          allowance_secs: game.allowance_secs,
          cure_window_secs: game.policy === "timed_remedy_v1" && game.mode === "live" ? LIVE_CURE_WINDOW_SECS : 0,
          policy: game.policy,
        },
        created_at: nanos(game.created_at),
        funding_deadline: nanos(game.funding_deadline),
        pool: (BigInt(game.ante_net) * BigInt(game.seats.length)).toString(),
        seats: game.seats.map((seat) => ({
          wallet: seat.wallet,
          consent_pubkey: seat.consent_pubkey,
          consent_key_rotated_at: seat.consent_key_rotated_at === undefined || seat.consent_key_rotated_at === null ? null : nanos(seat.consent_key_rotated_at),
          join_ticket: seat.join_ticket,
          gross_deposit: game.ante_gross,
          subsidy_paid: game.subsidy_per_seat,
          net_deposit: game.ante_net,
          joined_at: nanos(seat.joined_at ?? game.created_at),
        })),
        roster_hash: game.roster_hash,
        domain: game.domain,
        bond: game.bond,
        resolver: game.resolver,
        started_at: game.started_at === null ? null : nanos(game.started_at),
        last_activity: game.last_activity === null ? null : nanos(game.last_activity),
        last_seq: game.last_seq,
        settlement: game.settlement === null ? null : { source: game.settlement.source, payload: game.settlement.payload, accepted_at: nanos(game.settlement.accepted_at), window_end: nanos(game.settlement.window_end) },
        consent_bitmap: game.consent_bitmap,
        dispute:
          game.dispute === null
            ? null
            : { challenger: game.dispute.challenger, bond: game.dispute.bond, evidence_hash: game.dispute.evidence_hash, disputed_at: nanos(game.dispute.disputed_at), resolution: game.dispute.resolution, resolved_at: game.dispute.resolved_at === null ? null : nanos(game.dispute.resolved_at) },
        outcome:
          game.outcome === null
            ? null
            : { route: game.outcome.route, at: nanos(game.outcome.at), amounts: game.outcome.amounts, dust: game.outcome.dust, distributed: game.outcome.distributed ?? "0", bond_returned: game.outcome.bond_returned ?? "0", bond_to_pool: game.outcome.bond_to_pool ?? "0" },
        review_request: null,
        remedy: game.remedy === null ? null : { ...game.remedy, accepted_at: nanos(game.remedy.accepted_at) },
      },
      paused: this.paused,
      latest_checkpoint: latest === null ? null : { payload: latest.payload, accepted_at: nanos(latest.accepted_at) },
      trusted_seq: this.trustedSeq(game).toString(),
      deadlines: {
        funding_deadline: nanos(game.funding_deadline),
        liveness_available_at: null,
        /* `query.rs::deadlines`: the window end only while SETTLEABLE; the resolver timeout only while DISPUTED. */
        challenge_window_end: game.state === "settleable" && game.settlement !== null ? nanos(game.settlement.window_end) : null,
        resolver_timeout_at: game.state === "disputed" && game.dispute !== null ? nanos(game.dispute.disputed_at + (this.options.resolverTimeoutSecs ?? 604_800)) : null,
      },
    };
  }

  /* ---------------- contract execution ---------------- */

  private payloadRecord(wire: unknown, usage: "Checkpoint" | "Settle"): { record: PayloadRecordJson; digest: string; domain: string } {
    let payload;
    try {
      payload = settlementPayloadFromWire(wire);
      checkSettlementPayloadV1(payload, usage);
    } catch (error) {
      if (error instanceof SettlementPayloadError) {
        const code = error.code;
        if (code === "WRONG_KIND") throw new ContractFailure(`this message needs a ${usage === "Checkpoint" ? "checkpoint" : "terminal"} payload`);
        if (code === "BAD_SEQ") throw new ContractFailure(`seq 0 does not equal 2*log_len + kind_bit`);
        throw new ContractFailure(`payload is malformed: ${error.message}`);
      }
      throw error;
    }
    const encoded = encodeSettlementPayloadV1Hex(payload);
    const digest = settleDigestOfEncodedHex(encoded);
    return {
      digest: digest,
      domain: payload.domain,
      record: {
        seq: payload.seq.toString(),
        kind: payload.kind,
        reason: payload.reason,
        log_len: payload.log_len.toString(),
        log_hash: payload.log_hash,
        appraisal_log_len: payload.appraisal_log_len.toString(),
        appraisal_state_hash: payload.appraisal_state_hash,
        state_schema_version: payload.state_schema_version,
        settlement_weights: payload.settlement_weights.map((w) => w.toString()),
        signer_key_id: payload.signer_key_id,
        issued_at: payload.issued_at.toString(),
        payload_digest: digest,
      },
    };
  }

  private verifySigned(game: FakeGame, wire: unknown, signature: string, usage: "Checkpoint" | "Settle") {
    const { record, digest, domain } = this.payloadRecord(wire, usage);
    if (domain !== game.domain) throw new ContractFailure("the payload domain does not match this game");
    if (record.settlement_weights.length !== game.seats.length) throw new ContractFailure(`the payload carries ${record.settlement_weights.length} settlement weights, the roster has ${game.seats.length} seats`);
    const trusted = this.trustedSeq(game);
    if (BigInt(record.seq) <= trusted) throw new ContractFailure(`seq ${record.seq} does not exceed the trusted sequence ${trusted.toString()}`);
    const key = this.signerKeys.find((entry) => entry.key_id === record.signer_key_id);
    if (key === undefined) throw new ContractFailure(`signer key ${record.signer_key_id} is not registered`);
    if (key.retired) throw new ContractFailure(`signer key ${record.signer_key_id} is retired`);
    if (!/^[0-9a-f]{128}$/.test(signature)) throw new ContractFailure(`a signature must be 64 bytes r||s, got ${signature.length / 2}`);
    if (!verifyDigest(Buffer.from(key.pubkey, "hex"), Buffer.from(digest, "hex"), Buffer.from(signature, "hex"))) throw new ContractFailure("invalid signature");
    return record;
  }

  private execute(sender: string, msg: Record<string, unknown>, apply: boolean): void {
    const [variant] = Object.keys(msg);
    const body = msg[variant] as Record<string, unknown>;
    const game = this.games.get(Number(body.chain_game_id));
    if (game === undefined) throw new ContractFailure(`game ${String(body.chain_game_id)} not found`);
    const wrongState = (expected: string) => new ContractFailure(`wrong state: game is ${game.state}, this message needs ${expected}`);
    switch (variant) {
      case "start": {
        if (sender !== this.options.operator) throw new ContractFailure("unauthorized: only the operator may do this");
        if (this.paused) throw new ContractFailure("the contract is paused");
        if (game.state !== "funded") throw wrongState("funded");
        /* Escrow 2.1.0 (`play.rs::start`): a game whose seats include the current resolver does not start. */
        if (game.policy !== null && game.seats.some((seat) => seat.wallet === this.options.resolver)) throw new ContractFailure("the game's resolver holds a seat in it, so it can neither review nor judge it");
        const rosterHash = rosterHashV1(game.seats.map((seat) => seat.wallet));
        if (body.roster_hash !== rosterHash) throw new ContractFailure("the roster hash does not match the on-chain roster");
        if (!apply) return;
        game.state = "in_progress";
        game.roster_hash = rosterHash;
        game.domain = settlementDomainV1({
          chain_id: this.chainId,
          contract_addr: this.options.contract,
          chain_game_id: BigInt(game.chain_game_id),
          roster_hash: rosterHash,
          rules_engine_version: game.rules_engine_version,
          variants_digest: game.variants_digest,
          ante_gross: BigInt(game.ante_gross),
          mode: game.mode === "live" ? 0 : 1,
        });
        game.resolver = this.options.resolver;
        game.started_at = this.time;
        /* `payout.rs::bond_amount`: max(bond_floor, floor(ante_net * bond_bps / 10000)), frozen at Start. */
        {
          const proportional = (BigInt(game.ante_net) * BigInt(this.options.bondBps ?? 0)) / BigInt(10_000);
          const floor = BigInt(this.options.bondFloor ?? "0");
          game.bond = (proportional > floor ? proportional : floor).toString();
        }
        game.last_activity = this.time;
        return;
      }
      case "checkpoint": {
        if (game.state !== "in_progress") throw wrongState("in_progress");
        const record = this.verifySigned(game, body.payload, String(body.signature), "Checkpoint");
        if (!apply) return;
        game.checkpoints.set(record.signer_key_id, { payload: record, accepted_at: this.time });
        if (BigInt(record.seq) > BigInt(game.last_seq)) game.last_seq = record.seq;
        game.last_activity = this.time;
        return;
      }
      case "settle": {
        if (this.paused) throw new ContractFailure("the contract is paused");
        if (game.state !== "in_progress") throw wrongState("in_progress");
        const record = this.verifySigned(game, body.payload, String(body.signature), "Settle");
        if (!apply) return;
        game.settlement = { source: "terminal_payload", payload: record, accepted_at: this.time, window_end: this.time + (this.options.challengeWindowSecs ?? 600) };
        if (BigInt(record.seq) > BigInt(game.last_seq)) game.last_seq = record.seq;
        game.state = "settleable";
        return;
      }
      case "finalize": {
        if (this.paused) throw new ContractFailure("the contract is paused");
        if (game.state !== "settleable" || game.settlement === null) throw wrongState("settleable");
        if (!this.settlementTrusted(game)) throw new ContractFailure(`the stored settlement's signer key ${game.settlement.payload.signer_key_id} is compromised; it can no longer be finalized or consented to`);
        if (this.time < game.settlement.window_end) throw new ContractFailure(`the challenge window is open until ${nanos(game.settlement.window_end)}`);
        if (!apply) return;
        this.payOut(game, "finalized");
        return;
      }
      case "consent": {
        /* ESCROW-4 (`play.rs::consent`): SETTLEABLE, not paused; one seat's signature over the CONSENT digest of the stored
           settlement, verified against that seat's CURRENT key. Every seat consented: paid out at once. */
        if (game.state !== "settleable" || game.settlement === null) throw wrongState("settleable");
        if (this.paused) throw new ContractFailure("the contract is paused");
        if (!this.settlementTrusted(game)) throw new ContractFailure(`the stored settlement's signer key ${game.settlement.payload.signer_key_id} is compromised; it can no longer be finalized or consented to`);
        const seatIndex = Number(body.seat_index);
        const seat = game.seats[seatIndex];
        if (seat === undefined) throw new ContractFailure(`seat index ${String(body.seat_index)} is out of range`);
        const digest = consentDigestV1(game.domain ?? "", BigInt(game.settlement.payload.seq), game.settlement.payload.payload_digest);
        const signature = String(body.signature);
        if (!/^[0-9a-f]{128}$/.test(signature)) throw new ContractFailure(`a signature must be 64 bytes r||s, got ${signature.length / 2}`);
        if (!verifyDigest(Buffer.from(seat.consent_pubkey, "hex"), Buffer.from(digest, "hex"), Buffer.from(signature, "hex"))) throw new ContractFailure(`invalid signature for seat ${seatIndex}`);
        if (!apply) return;
        game.consent_bitmap |= 1 << seatIndex;
        if (game.consent_bitmap === (1 << game.seats.length) - 1) this.payOut(game, "consent_completed");
        return;
      }
      case "annul_by_consent": {
        /* ESCROW-4 (`dispute.rs::annul_by_consent`): IN_PROGRESS or SETTLEABLE (works while paused); EVERY seat's signature
           over ANNUL(domain, trusted_seq), each against that seat's current key; every net ante refunded. */
        /* FP4 (escrow 2.1.0): a game with an exit policy is annullable while DISPUTED too (the bond goes back). */
        const policyGame = game.policy !== null;
        if (game.state !== "in_progress" && game.state !== "settleable" && !(policyGame && game.state === "disputed")) throw wrongState(policyGame ? "in_progress, settleable or disputed" : "in_progress or settleable");
        const consents = Array.isArray(body.consents) ? (body.consents as Array<{ seat_index: number; signature: string }>) : [];
        const digest = annulDigestV1(game.domain ?? "", this.trustedSeq(game));
        const seen = new Set<number>();
        for (const consent of consents) {
          const seat = game.seats[consent.seat_index];
          if (seat === undefined) throw new ContractFailure(`seat index ${consent.seat_index} is out of range`);
          if (seen.has(consent.seat_index)) throw new ContractFailure(`duplicate signature for seat ${consent.seat_index}`);
          seen.add(consent.seat_index);
          if (!/^[0-9a-f]{128}$/.test(consent.signature) || !verifyDigest(Buffer.from(seat.consent_pubkey, "hex"), Buffer.from(digest, "hex"), Buffer.from(consent.signature, "hex"))) {
            throw new ContractFailure(`invalid signature for seat ${consent.seat_index}`);
          }
        }
        for (let at = 0; at < game.seats.length; at += 1) if (!seen.has(at)) throw new ContractFailure(`every seat must sign; seat ${at} is missing`);
        if (!apply) return;
        let bondReturned = "0";
        if (game.state === "disputed" && game.dispute !== null) {
          game.dispute.resolution = "annulled_by_consent";
          game.dispute.resolved_at = this.time;
          bondReturned = game.dispute.bond;
        }
        game.outcome = { route: "annul_by_consent", at: this.time, amounts: game.seats.map(() => game.ante_net), dust: "0", ...(bondReturned !== "0" ? { distributed: (BigInt(game.ante_net) * BigInt(game.seats.length)).toString(), bond_returned: bondReturned, bond_to_pool: "0" } : {}) };
        game.state = "annulled";
        return;
      }
      case "submit_remedy":
        this.submitRemedy(game, body, apply);
        return;
      default:
        throw new ContractFailure(`Generic error: unknown variant ${variant}`);
    }
  }

  /** FP4 (escrow 2.1.0): `execute/remedy.rs::submit_remedy`, in the contract's check order and with its Display texts:
   *  IN_PROGRESS, a `timed_remedy_v1` game, a known kind, the pause (the foreclosing kinds), the attestation against the
   *  game and its funded terms, finality and expiry against block time, the trusted sequence, an active REMEDY key and
   *  its signature over the REMEDY digest, then the approvals. Remedies 1 and 4 refund every net deposit (ANNULLED); 2
   *  and 5 pay the foreclosure split (SETTLED, the remainder to the treasury); 3 stores the foreclosure as a
   *  challengeable settlement (SETTLEABLE). */
  private submitRemedy(game: FakeGame, body: Record<string, unknown>, apply: boolean): void {
    if (game.state !== "in_progress") throw new ContractFailure(`wrong state: game is ${game.state}, this message needs in_progress`);
    if (game.policy !== "timed_remedy_v1") throw new ContractFailure("this game's escrow policy has no timed remedies");
    const w = (typeof body.attestation === "object" && body.attestation !== null ? body.attestation : {}) as Record<string, unknown>;
    const u64 = (field: string): bigint => {
      const value = w[field];
      if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new ContractFailure(`remedy attestation is malformed: ${field}`);
      return BigInt(value);
    };
    const small = (field: string, max: number): number => {
      const value = w[field];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw new ContractFailure(`remedy attestation is malformed: ${field}`);
      return value;
    };
    const hex32 = (field: string): string => {
      const value = w[field];
      if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new ContractFailure(`remedy attestation is malformed: ${field}`);
      return value;
    };
    const a: RemedyAttestationV1 = {
      version: small("version", 255) as 1,
      domain: hex32("domain"),
      chain_game_id: u64("chain_game_id"),
      remedy: small("remedy", 255) as RemedyKindByte,
      defaulting_seat: small("defaulting_seat", 255),
      strike: small("strike", 255),
      overdue_epoch: u64("overdue_epoch"),
      log_len: u64("log_len"),
      log_hash: hex32("log_hash"),
      allowance_secs: u64("allowance_secs"),
      overdue_at: u64("overdue_at"),
      final_at: u64("final_at"),
      attested_at: u64("attested_at"),
      expires_at: u64("expires_at"),
      evidence_hash: hex32("evidence_hash"),
      remedy_key_id: small("remedy_key_id", 0xffff),
    };
    const kind = a.remedy as number;
    if (![1, 2, 3, 4, 5].includes(kind)) throw new ContractFailure(`remedy ${kind} is unknown`);
    if (remedyForecloses(a.remedy) && this.paused) throw new ContractFailure("the contract is paused");
    if (a.version !== 1) throw new ContractFailure(`unsupported payload version ${a.version}`);
    if (remedyMode(a.remedy) !== (game.mode === "live" ? 0 : 1)) throw new ContractFailure(`remedy ${kind} does not apply to this game's mode`);
    if (a.domain !== game.domain || a.chain_game_id !== BigInt(game.chain_game_id)) throw new ContractFailure("the payload domain does not match this game");
    if (a.defaulting_seat >= game.seats.length) throw new ContractFailure(`seat index ${a.defaulting_seat} is out of range`);
    const strikeOk = kind === 1 || kind === 2 ? a.strike === 1 || a.strike === 2 : kind === 3 ? a.strike === 3 : a.strike === 0;
    if (!strikeOk) throw new ContractFailure(`strike ${a.strike} is not valid for remedy ${kind}`);
    if (a.allowance_secs !== BigInt(game.allowance_secs) || a.allowance_secs === BigInt(0)) throw new ContractFailure(`the attestation names allowance ${a.allowance_secs} s, the game was funded with ${game.allowance_secs} s`);
    const timing = (reason: string) => new ContractFailure(`the attestation's times are inconsistent: ${reason}`);
    if (a.overdue_at < BigInt(game.started_at ?? 0) + BigInt(game.allowance_secs)) throw timing("overdue_at precedes the end of the first allowance after the game's start");
    const finalOk = kind === 1 || kind === 2 ? a.final_at >= a.overdue_at + BigInt(LIVE_CURE_WINDOW_SECS) : kind === 3 ? a.final_at === a.overdue_at : a.final_at >= a.overdue_at;
    if (!finalOk) throw timing("final_at does not follow overdue_at as this remedy requires");
    if (a.attested_at < a.final_at) throw timing("attested_at precedes final_at");
    if (a.expires_at <= a.attested_at) throw timing("expires_at must lie after attested_at");
    if (a.expires_at > a.attested_at + BigInt(MAX_REMEDY_TTL_SECS)) throw timing("expires_at lies more than the remedy TTL after attested_at");
    if (BigInt(this.time) < a.final_at) throw new ContractFailure(`the remedy is not final before ${a.final_at}`);
    if (BigInt(this.time) < a.attested_at) throw timing("attested_at lies after the block time");
    if (BigInt(this.time) >= a.expires_at) throw new ContractFailure(`the remedy attestation expired at ${a.expires_at}`);
    const seq = a.log_len * BigInt(2) + BigInt(1);
    const trusted = this.trustedSeq(game);
    if (seq <= trusted) throw new ContractFailure(`seq ${seq} does not exceed the trusted sequence ${trusted}`);
    const key = this.remedyKeys.find((entry) => entry.key_id === a.remedy_key_id);
    if (key === undefined) throw new ContractFailure(`remedy key ${a.remedy_key_id} is not registered`);
    if (key.retired) throw new ContractFailure(`remedy key ${a.remedy_key_id} is retired`);
    const signature = String(body.signature);
    if (!/^[0-9a-f]{128}$/.test(signature)) throw new ContractFailure(`a signature must be 64 bytes r||s, got ${signature.length / 2}`);
    const digest = remedyDigestV1(a);
    if (!verifyDigest(Buffer.from(key.pubkey, "hex"), Buffer.from(digest, "hex"), Buffer.from(signature, "hex"))) throw new ContractFailure("invalid signature");
    const approvals = Array.isArray(body.approvals) ? (body.approvals as Array<{ seat_index: number; approve_until: string; signature: string }>) : [];
    let bitmap = 0;
    if (remedyNeedsApprovals(a.remedy)) {
      for (const approval of approvals) {
        const seat = game.seats[approval.seat_index];
        if (seat === undefined) throw new ContractFailure(`seat index ${approval.seat_index} is out of range`);
        if (approval.seat_index === a.defaulting_seat) throw new ContractFailure(`the defaulting seat ${approval.seat_index} cannot approve a remedy against itself`);
        if ((bitmap & (1 << approval.seat_index)) !== 0) throw new ContractFailure(`duplicate signature for seat ${approval.seat_index}`);
        if (typeof approval.approve_until !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(approval.approve_until)) throw new ContractFailure("Error parsing into type eighteen_cosmos_escrow::msg::ExecuteMsg: approve_until");
        const until = BigInt(approval.approve_until);
        /* Owner ruling (2026-10-07): judged at the attested final_at, never at the block time; under the key the seat
           held at final_at (`helpers.rs::verify_remedy_approvals`). */
        if (a.final_at >= until) throw new ContractFailure(`seat ${approval.seat_index}'s remedy approval expired at ${approval.approve_until}, not after the remedy's final_at ${a.final_at}`);
        const approve = remedyApproveDigestV1(a, until, approval.seat_index);
        if (!/^[0-9a-f]{128}$/.test(approval.signature) || !verifyDigest(Buffer.from(fakeConsentKeyAt(seat, a.final_at), "hex"), Buffer.from(approve, "hex"), Buffer.from(approval.signature, "hex"))) {
          throw new ContractFailure(`invalid signature for seat ${approval.seat_index}`);
        }
        bitmap |= 1 << approval.seat_index;
      }
      for (let at = 0; at < game.seats.length; at += 1) if (at !== a.defaulting_seat && (bitmap & (1 << at)) === 0) throw new ContractFailure(`every seat must sign; seat ${at} is missing`);
    } else if (approvals.length > 0) throw new ContractFailure(`remedy ${kind} carries no seat approvals`);
    if (!apply) return;
    const pool = BigInt(game.ante_net) * BigInt(game.seats.length);
    if (kind === 1 || kind === 4) {
      game.outcome = { route: kind === 1 ? "remedy_timeout_annul" : "remedy_annul", at: this.time, amounts: game.seats.map(() => game.ante_net), dust: "0", distributed: pool.toString(), bond_returned: "0", bond_to_pool: "0" };
      game.state = "annulled";
    } else if (kind === 2 || kind === 5) {
      /* `payout::foreclosure_split`: the defaulting seat 0; every other seat its net plus floor(net / (N-1)); the
         remainder to the treasury. */
      const net = BigInt(game.ante_net);
      const others = BigInt(game.seats.length - 1);
      const share = net / others;
      game.outcome = { route: "remedy_foreclosure", at: this.time, amounts: game.seats.map((_, at) => (at === a.defaulting_seat ? "0" : (net + share).toString())), dust: (net % others).toString(), distributed: pool.toString(), bond_returned: "0", bond_to_pool: "0" };
      game.state = "settled";
    } else {
      const record: PayloadRecordJson = {
        seq: seq.toString(),
        kind: 1,
        reason: 0,
        log_len: a.log_len.toString(),
        log_hash: a.log_hash,
        appraisal_log_len: "0",
        appraisal_state_hash: "00".repeat(32),
        state_schema_version: 0,
        settlement_weights: game.seats.map((_, at) => (at === a.defaulting_seat ? "0" : "1")),
        signer_key_id: a.remedy_key_id,
        issued_at: a.final_at.toString(),
        payload_digest: digest,
      };
      game.settlement = { source: "remedy_strike3", payload: record, accepted_at: this.time, window_end: this.time + (this.options.challengeWindowSecs ?? 600) };
      if (seq > BigInt(game.last_seq)) game.last_seq = seq.toString();
      game.consent_bitmap = 0;
      game.state = "settleable";
    }
    game.remedy = {
      kind: REMEDY_KIND_NAMES[kind],
      defaulting_seat: a.defaulting_seat,
      strike: a.strike,
      overdue_epoch: a.overdue_epoch.toString(),
      log_len: a.log_len.toString(),
      final_at: a.final_at.toString(),
      attested_at: a.attested_at.toString(),
      expires_at: a.expires_at.toString(),
      remedy_key_id: a.remedy_key_id,
      remedy_digest: digest,
      approvals_bitmap: bitmap,
      accepted_at: this.time,
    };
  }

  /** `helpers.rs::pay_out`; JX-6B: an Uphold adds the bond to the pool first (`toPool`), a Replace or a resolver timeout
   *  returns it (`returned`). */
  private payOut(game: FakeGame, route: string, bond: { readonly toPool?: string; readonly returned?: string } = {}): void {
    const weights = (game.settlement as NonNullable<FakeGame["settlement"]>).payload.settlement_weights.map((w) => BigInt(w));
    const pool = BigInt(game.ante_net) * BigInt(game.seats.length) + BigInt(bond.toPool ?? "0");
    const sum = weights.reduce((a, b) => a + b, BigInt(0));
    const amounts = weights.map((w) => (pool * w) / sum);
    const dust = pool - amounts.reduce((a, b) => a + b, BigInt(0));
    game.outcome = { route, at: this.time, amounts: amounts.map((a) => a.toString()), dust: dust.toString(), distributed: pool.toString(), bond_returned: bond.returned ?? "0", bond_to_pool: bond.toPool ?? "0" };
    game.state = "settled";
  }

  /** A wallet's Join, exactly as `contracts/escrow/src/execute/funding.rs::join` (escrow 2.0.0) decides it: FUNDING, a
   *  fresh wallet, not full, a 32-byte ticket, then the ADMISSION -- block time before its expiry, and the admission
   *  key's low-s signature over the JOIN digest of (this chain, this contract, this game, THE SENDER, this ticket, the
   *  expiry). A Join without one does not even parse (the field is required). */
  join(chainGameId: string, seat: FakeSeat, admission?: { readonly expires_at: string; readonly signature: string }): { ok: true } | { ok: false; error: string } {
    const game = this.games.get(Number(chainGameId));
    if (admission === undefined) return { ok: false, error: "Error parsing into type eighteen_cosmos_escrow::msg::ExecuteMsg: missing field `admission`" };
    if (game === undefined) return { ok: false, error: "not found" };
    if (game.state !== "funding") return { ok: false, error: `wrong state: game is ${game.state}` };
    if (game.seats.some((existing) => existing.wallet === seat.wallet)) return { ok: false, error: "already joined" };
    if (this.paused) return { ok: false, error: "the contract is paused" };
    if (game.seats.length >= game.max_players) return { ok: false, error: "game full" };
    if (this.time >= game.funding_deadline) return { ok: false, error: "the funding deadline has passed" };
    if (!/^[0-9a-f]{64}$/.test(seat.join_ticket)) return { ok: false, error: "join_ticket must be 32 bytes" };
    const keyUser = game.seats.findIndex((existing) => existing.consent_pubkey === seat.consent_pubkey);
    if (keyUser >= 0) return { ok: false, error: `this consent key is already used by seat ${keyUser} of this game` };
    if (!/^(0|[1-9][0-9]{0,19})$/.test(admission.expires_at)) return { ok: false, error: "Error parsing into type eighteen_cosmos_escrow::msg::ExecuteMsg: invalid Uint64" };
    if (BigInt(this.time) >= BigInt(admission.expires_at)) return { ok: false, error: `the join admission expired at ${admission.expires_at}` };
    let digest = "";
    try {
      digest = joinAdmissionDigestV1({ chain_id: this.chainId, contract_addr: this.options.contract, chain_game_id: BigInt(chainGameId), wallet: seat.wallet, join_ticket: seat.join_ticket, expires_at: BigInt(admission.expires_at) });
    } catch {
      digest = ""; // a sender spelling no admission can name
    }
    const signature = /^[0-9a-f]*$/.test(admission.signature) && admission.signature.length % 2 === 0 ? Buffer.from(admission.signature, "hex") : Buffer.alloc(0);
    if (digest === "" || signature.length !== 64 || !verifyDigest(Buffer.from(this.admissionPubkey, "hex"), Buffer.from(digest, "hex"), signature)) {
      return { ok: false, error: "the join admission does not authorize this wallet for this game" };
    }
    game.seats.push({ ...seat, joined_at: this.time, consent_key_rotated_at: null });
    if (game.seats.length === game.max_players) game.state = "funded";
    return { ok: true };
  }

  /** A seat's own pre-Start Withdraw (`funding.rs::withdraw`): later seats move up; FUNDED returns to FUNDING. */
  withdraw(chainGameId: string, wallet: string): { ok: true } | { ok: false; error: string } {
    const game = this.games.get(Number(chainGameId));
    if (game === undefined) return { ok: false, error: "not found" };
    if (game.state !== "funding" && game.state !== "funded") return { ok: false, error: `wrong state: game is ${game.state}` };
    const index = game.seats.findIndex((seat) => seat.wallet === wallet);
    if (index < 0) return { ok: false, error: "not seated" };
    game.seats.splice(index, 1);
    if (game.state === "funded") game.state = "funding";
    return { ok: true };
  }

  /** The creator's (or, after the deadline, anyone's) Cancel before Start. `sender` (ESCROW-4) is checked when given. */
  cancel(chainGameId: string, sender?: string): { ok: true } | { ok: false; error: string } {
    const game = this.games.get(Number(chainGameId));
    if (game === undefined) return { ok: false, error: "not found" };
    if (game.state !== "funding" && game.state !== "funded") return { ok: false, error: `wrong state: game is ${game.state}` };
    if (sender !== undefined && sender !== game.creator && this.time < game.funding_deadline) return { ok: false, error: "unauthorized: only the creator may do this" };
    game.state = "cancelled";
    game.outcome = { route: sender === undefined || sender === game.creator ? "creator_cancel" : "deadline_cancel", at: this.time, amounts: game.seats.map(() => game.ante_net), dust: "0" };
    return { ok: true };
  }

  /** A test's wallet action (a seat's LivenessSettle, an operator's pause, a consent completion...). */
  forceState(chainGameId: string, patch: Partial<Pick<FakeGame, "state" | "outcome">>): void {
    const game = this.games.get(Number(chainGameId));
    if (game !== undefined) Object.assign(game, patch);
  }

  /* ---------------- blocks ---------------- */

  produceBlock(seconds = 6): void {
    this.height += 1;
    this.time += seconds;
    const pending = this.mempool.splice(0, this.mempool.length);
    for (const tx of pending) {
      const account = this.accounts.get(tx.sender);
      if (tx.timeoutHeight !== BigInt(0) && BigInt(this.height) > tx.timeoutHeight) continue; // expired: never included
      if (account === undefined || tx.sequence !== account.sequence) {
        if (account !== undefined && tx.sequence > account.sequence) this.mempool.push(tx); // a gap: wait
        continue;
      }
      account.sequence += BigInt(1);
      account.pubKey = tx.publicKey.toString("hex");
      account.balance -= tx.fee;
      let code = 0;
      let log = "";
      try {
        this.execute(tx.sender, tx.msg, true);
      } catch (error) {
        if (!(error instanceof ContractFailure)) throw error;
        code = 5;
        log = `failed to execute message; message index: 0: ${error.message}: execute wasm contract failed`;
      }
      this.txIndex.set(tx.hash, { txhash: tx.hash, height: String(this.height), code, codespace: code === 0 ? "" : "wasm", raw_log: log, sequenceKey: `${tx.sender}/${tx.sequence.toString()}` });
    }
  }

  /** Includes a transaction built by someone else with the same key (an operator's own tooling). */
  consumeSequenceExternally(address: string): string {
    const account = this.accounts.get(address);
    if (account === undefined) throw new Error("no account");
    const hash = createHash("sha256").update(`external-${address}-${account.sequence.toString()}`).digest("hex").toUpperCase();
    this.txIndex.set(hash, { txhash: hash, height: String(this.height), code: 0, codespace: "", raw_log: "", sequenceKey: `${address}/${account.sequence.toString()}` });
    account.sequence += BigInt(1);
    return hash;
  }

  /* ---------------- JunoRest ---------------- */

  async nodeChainId(): Promise<string> {
    this.check();
    return this.wrongChainId ?? this.chainId;
  }

  async latestBlock(): Promise<BlockView> {
    this.check();
    const chainId = this.wrongChainId ?? this.chainId;
    if (chainId !== this.chainId) throw new JunoRpcError("wrong-chain", `the node is on ${chainId}, not ${this.chainId}`);
    return { chain_id: chainId, height: String(this.height), time: new Date(this.time * 1000).toISOString() };
  }

  /** Phase 3 final clocks: one node, so the quorum block read is its answer (a disagreeing second node is modelled by
   *  `quorumDisagrees`). */
  async latestBlockQuorum(): Promise<BlockView> {
    if (this.quorumDisagrees) throw new JunoRpcError("unavailable", "quorum block read: the endpoints disagree");
    return this.latestBlock();
  }

  async syncing(): Promise<boolean> {
    this.check();
    return this.syncingNow;
  }

  async account(address: string): Promise<AccountView | null> {
    this.check();
    if (this.malformedNextAccount > 0) {
      this.malformedNextAccount -= 1;
      throw new JunoRpcError("malformed", "account: the node's answer is not the expected shape");
    }
    const account = this.accounts.get(address);
    if (account === undefined) return null;
    return { height: this.heightsHidden ? null : String(this.height), address, account_number: account.number.toString(), sequence: account.sequence.toString(), pub_key: account.pubKey };
  }

  async contract(address: string): Promise<JunoContractFacts> {
    this.check();
    if (address !== this.options.contract) throw new JunoRpcError("malformed", "no such contract");
    return { address, code_id: this.options.codeId, admin: this.options.admin, creator: "juno1creator", label: "escrow" };
  }

  async codeChecksum(codeId: string): Promise<string> {
    this.check();
    if (codeId !== this.options.codeId) throw new JunoRpcError("malformed", "no such code");
    return this.reportedChecksum ?? this.options.codeChecksum;
  }

  async smart(contract: string, queryJson: string): Promise<unknown> {
    this.check();
    if (contract !== this.options.contract) throw new JunoRpcError("refused", "smart query refused: no such contract");
    const query = JSON.parse(queryJson) as Record<string, Record<string, unknown>>;
    const [variant] = Object.keys(query);
    const body = query[variant];
    if (variant === "config") {
      return {
        config: {
          admin: "juno1admin",
          operator: this.options.operator,
          admission_pubkey: this.admissionPubkey,
          resolver: this.options.resolver,
          treasury: this.options.treasury,
          denom: this.reportedDenom ?? this.options.denom,
          params: { subsidy_bps: this.options.subsidyBps ?? 100, min_ante: this.options.minAnte ?? "1", bond_bps: 0, bond_floor: "0", challenge_window_live_secs: 600, challenge_window_async_secs: 600, funding_period_live_secs: 3600, funding_period_async_secs: 3600, liveness_window_secs: this.options.livenessWindowSecs ?? 86_400, resolver_timeout_secs: this.options.resolverTimeoutSecs ?? 604_800 },
          paused: this.paused,
        },
        next_chain_game_id: this.nextGameId,
        next_signer_key_id: this.signerKeys.length + 1,
        next_remedy_key_id: this.remedyKeys.length + 1,
        contract_name: "crates.io:eighteen-cosmos-escrow",
        contract_version: this.reportedContractVersion ?? "2.1.0",
      };
    }
    if (variant === "games") {
      /* ESCROW-4: the game list, ascending by id after `start_after`, at most 30. */
      const after = body.start_after === null || body.start_after === undefined ? 0 : Number(body.start_after);
      const limit = Math.min(30, Number(body.limit ?? 10));
      return {
        games: [...this.games.values()]
          .filter((game) => game.chain_game_id > after)
          .sort((a, b) => a.chain_game_id - b.chain_game_id)
          .slice(0, limit)
          .map((game) => ({ chain_game_id: game.chain_game_id, state: game.state, creator: game.creator, mode: game.mode, max_players: game.max_players, seats_filled: game.seats.length, ante_gross: game.ante_gross, pool: (BigInt(game.ante_net) * BigInt(game.seats.length)).toString(), policy: game.policy })),
      };
    }
    if (variant === "remedy_keys") {
      /* FP4 (escrow 2.1.0): the REMEDY key registry, paged like the signer keys. */
      const after = body.start_after === null || body.start_after === undefined ? 0 : Number(body.start_after);
      const limit = Number(body.limit ?? 30);
      return { keys: this.remedyKeys.filter((key) => key.key_id > after).slice(0, limit).map((key) => ({ key_id: key.key_id, pubkey: key.pubkey, added_at: nanos(this.time), retired_at: key.retired ? nanos(this.time) : null, compromised: key.compromised })) };
    }
    if (variant === "signer_keys") {
      const after = body.start_after === null || body.start_after === undefined ? 0 : Number(body.start_after);
      const limit = Number(body.limit ?? 30);
      return { keys: this.signerKeys.filter((key) => key.key_id > after).slice(0, limit).map((key) => ({ key_id: key.key_id, pubkey: key.pubkey, added_at: nanos(this.time), retired_at: key.retired ? nanos(this.time) : null, compromised: key.compromised })) };
    }
    const game = this.games.get(Number(body.chain_game_id));
    if (game === undefined) throw new JunoRpcError("refused", `smart query refused: game ${String(body.chain_game_id)} not found`);
    if (variant === "game") return this.gameResponse(game);
    if (variant === "consent_key_at") {
      /* Escrow 2.1.0 (`query.rs` ConsentKeyAt): the key a seat held at block second `at`. */
      const seat = game.seats[Number(body.seat_index)];
      if (seat === undefined) throw new JunoRpcError("refused", `smart query refused: seat index ${String(body.seat_index)} is out of range`);
      return { pubkey: fakeConsentKeyAt(seat, BigInt(String(body.at))), retired_keys: (seat.retired_consent_keys ?? []).length };
    }
    if (variant === "checkpoints") {
      return {
        checkpoints: [...game.checkpoints.values()].map((record) => ({ checkpoint: { payload: record.payload, accepted_at: nanos(record.accepted_at) }, signer_key_retired: false, signer_key_compromised: false })),
        liveness_candidate_seq: null,
      };
    }
    throw new JunoRpcError("refused", `smart query refused: ${variant}`);
  }

  /** ESCROW-4: one node, so the quorum read is its answer (a disagreeing second node is modelled by `quorumDisagrees`). */
  quorumDisagrees = false;
  async smartQuorum(contract: string, queryJson: string): Promise<unknown> {
    if (this.quorumDisagrees) throw new JunoRpcError("unavailable", "quorum read: the endpoints disagree");
    return this.smart(contract, queryJson);
  }

  /** LIVE-4 (L4-4): one node, so the verification-grade read is its own answer -- refused while it is down, on another
   *  chain or syncing, or while a second node is modelled as disagreeing (`quorumDisagrees`). */
  async verifiedContractFacts(contract: string, configQueryJson: string): Promise<{ readonly code_checksum: string; readonly config: unknown }> {
    if (this.unavailable) throw new JunoRpcError("unavailable", "verification-grade read: the fake node is down");
    if (this.wrongChainId !== null && this.wrongChainId !== this.chainId) throw new JunoRpcError("unavailable", `verification-grade read: an endpoint is on ${this.wrongChainId}`);
    if (this.syncingNow) throw new JunoRpcError("unavailable", "verification-grade read: an endpoint is still syncing");
    if (this.quorumDisagrees) throw new JunoRpcError("unavailable", "verification-grade read: the endpoints disagree");
    const info = await this.contract(contract);
    return { code_checksum: await this.codeChecksum(info.code_id), config: await this.smart(contract, configQueryJson) };
  }

  /** One node: its answer, counted only when it says it read at `minHeight` or later (`heightsHidden`: it does not say). */
  async smartQuorumAtLeast(contract: string, queryJson: string, minHeight: string): Promise<unknown> {
    if (this.quorumDisagrees) throw new JunoRpcError("unavailable", "read at a known height: the endpoints disagree");
    const answer = await this.smartAt(contract, queryJson);
    if (answer.height === null || BigInt(answer.height) < BigInt(minHeight)) throw new JunoRpcError("unavailable", `read at height ${minHeight} or later: the node did not say it read there`);
    return answer.data;
  }

  async smartAt(contract: string, queryJson: string): Promise<{ readonly data: unknown; readonly height: string | null }> {
    const data = await this.smart(contract, queryJson);
    return { data, height: this.heightsHidden ? null : String(this.height) };
  }

  async endpointChains(): Promise<ReadonlyArray<{ readonly endpoint: string; readonly chain_id: string | null; readonly error: string | null }>> {
    if (this.unavailable) return [{ endpoint: "https://fake.node", chain_id: null, error: "the fake node is down" }];
    return [{ endpoint: "https://fake.node", chain_id: this.wrongChainId ?? this.chainId, error: null }];
  }

  private checkTx(tx: DecodedTx, simulate: boolean): string | null {
    const account = this.accounts.get(tx.sender);
    if (account === undefined) return "account not found";
    if (!simulate) {
      const expected = account.sequence + BigInt(this.mempool.filter((pending) => pending.sender === tx.sender).length);
      if (tx.sequence !== expected) return `account sequence mismatch, expected ${expected.toString()}, got ${tx.sequence.toString()}: incorrect account sequence`;
      const signDoc = encodeSignDoc({ bodyBytes: tx.bodyBytes, authInfoBytes: tx.authInfoBytes, chainId: this.chainId, accountNumber: account.number });
      if (!verifyDigest(tx.publicKey, signDocDigest(signDoc), tx.signature)) return "signature verification failed; please verify account number and chain-id: unauthorized";
      const minFee = (tx.gasLimit * (this.options.minGasPriceNum ?? BigInt(75)) + (this.options.minGasPriceDen ?? BigInt(1000)) - BigInt(1)) / (this.options.minGasPriceDen ?? BigInt(1000));
      if (tx.fee < minFee) return `insufficient fees; got: ${tx.fee.toString()}${tx.feeDenom} required: ${minFee.toString()}: insufficient fee`;
      /* JX-2B: the ante handler's fee deduction (the SDK's DeductFeeDecorator), after the fee check as in the SDK. */
      if (account.balance < tx.fee) return `insufficient funds to pay for fees; ${account.balance.toString()}${tx.feeDenom} < ${tx.fee.toString()}${tx.feeDenom}: insufficient funds`;
    }
    if (tx.timeoutHeight !== BigInt(0) && BigInt(this.height) >= tx.timeoutHeight) return "tx timeout height";
    return null;
  }

  async simulate(txBytes: Uint8Array): Promise<SimulateResult> {
    this.check();
    const tx = decodeRelayerTx(Buffer.from(txBytes));
    const refused = this.checkTx(tx, true);
    if (refused !== null) return { ok: false, code: 2, log: refused };
    try {
      this.execute(tx.sender, tx.msg, false);
    } catch (error) {
      if (!(error instanceof ContractFailure)) throw error;
      return { ok: false, code: 2, log: `failed to execute message; message index: 0: ${error.message}: execute wasm contract failed: invalid request` };
    }
    return { ok: true, gas_used: this.simulateGasOverride ?? "180000" };
  }

  async broadcast(txBytes: Uint8Array): Promise<TxResultView> {
    this.check();
    const tx = decodeRelayerTx(Buffer.from(txBytes));
    if (this.dropNextBroadcast > 0) {
      this.dropNextBroadcast -= 1;
      throw new JunoRpcError("timeout", "the broadcast never arrived");
    }
    this.broadcasts.push(tx.hash);
    const known = this.txIndex.has(tx.hash) || this.mempool.some((pending) => pending.hash === tx.hash);
    let answer: TxResultView;
    if (known) {
      answer = { txhash: tx.hash, height: "0", code: 19, codespace: "sdk", raw_log: "tx already exists in cache" };
    } else {
      const refused = this.checkTx(tx, false);
      if (this.checkTxRefusal !== null && refused === null) {
        answer = { txhash: tx.hash, height: "0", ...this.checkTxRefusal };
      } else if (refused !== null) {
        const code = /sequence/.test(refused) ? 32 : /insufficient funds/.test(refused) ? 5 : /fee/.test(refused) ? 13 : /timeout/.test(refused) ? 30 : 4;
        answer = { txhash: tx.hash, height: "0", code, codespace: "sdk", raw_log: refused };
      } else {
        this.mempool.push(tx);
        answer = { txhash: tx.hash, height: "0", code: 0, codespace: "", raw_log: "" };
      }
    }
    if (this.loseNextBroadcastAnswer > 0) {
      this.loseNextBroadcastAnswer -= 1;
      throw new JunoRpcError("timeout", "the broadcast answer was lost");
    }
    return answer;
  }

  async tx(hash: string): Promise<TxResultView | null> {
    this.check();
    if (this.indexDisabled) return null;
    const found = this.txIndex.get(hash);
    return found === undefined ? null : { txhash: found.txhash, height: found.height, code: found.code, codespace: found.codespace, raw_log: found.raw_log };
  }

  async txsBySequence(address: string, sequence: string): Promise<readonly TxResultView[] | null> {
    this.check();
    if (this.sequenceIndexDisabled) return null;
    u64Of(sequence, "sequence");
    return [...this.txIndex.values()].filter((entry) => entry.sequenceKey === `${address}/${sequence}`).map((entry) => ({ txhash: entry.txhash, height: entry.height, code: entry.code, codespace: entry.codespace, raw_log: entry.raw_log }));
  }
}
