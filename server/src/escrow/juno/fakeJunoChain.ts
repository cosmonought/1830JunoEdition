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
//               the SETTLE digest, pause, the challenge window) -- through the certified SET-0C functions.
//   faults      a lost broadcast answer (the tx IS in the mempool), a broadcast that never arrived, an unavailable
//               node, a wrong chain id, a disabled tx index, an absurd simulation, a malformed answer.
//
// Blocks are produced only by `produceBlock()` (tests decide when time passes).

import { createHash } from "crypto";

import {
  checkSettlementPayloadV1,
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
  dispute: null;
  outcome: { route: string; at: number; amounts: string[]; dust: string } | null;
  last_activity: number | null;
}

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
  readonly challengeWindowSecs?: number;
  readonly livenessWindowSecs?: number;
  readonly resolverTimeoutSecs?: number;
  readonly startTime?: number;
  readonly minGasPriceNum?: bigint;
  readonly minGasPriceDen?: bigint;
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
  readonly broadcasts: string[] = [];
  /* ---- faults ---- */
  indexDisabled = false;
  sequenceIndexDisabled = false;
  unavailable = false;
  wrongChainId: string | null = null;
  loseNextBroadcastAnswer = 0;
  dropNextBroadcast = 0;
  simulateGasOverride: string | null = null;
  malformedNextAccount = 0;
  /** A node that does not say the height it answered at (no death or rollback proof can be built on it). */
  heightsHidden = false;
  private nextGameId = 1;
  private nextAccountNumber = BigInt(7);

  constructor(readonly options: FakeChainOptions) {
    this.chainId = options.chainId;
    this.time = options.startTime ?? 1_760_000_000;
    options.signerKeys.forEach((pubkey, i) => this.signerKeys.push({ key_id: i + 1, pubkey, retired: false, compromised: false }));
  }

  fund(address: string, amount: bigint): void {
    const account = this.accounts.get(address);
    if (account === undefined) {
      this.accounts.set(address, { number: this.nextAccountNumber, sequence: BigInt(0), pubKey: null, balance: amount });
      this.nextAccountNumber += BigInt(1);
    } else account.balance += amount;
  }

  /** A FUNDED game, as the players' wallets would have made it (CreateGame + Joins). */
  seedFundedGame(input: { seats: FakeSeat[]; anteGross: string; anteNet: string; rulesEngineVersion: number; variantsDigest: string; mode?: 0 | 1 }): string {
    const id = this.nextGameId;
    this.nextGameId += 1;
    this.games.set(id, {
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
    });
    return String(id);
  }

  private check(): void {
    if (this.unavailable) throw new JunoRpcError("unavailable", "the fake node is down");
  }

  private trustedSeq(game: FakeGame): bigint {
    let best = BigInt(0);
    for (const [keyId, record] of game.checkpoints) {
      if (this.signerKeys.find((key) => key.key_id === keyId)?.compromised) continue;
      if (BigInt(record.payload.seq) > best) best = BigInt(record.payload.seq);
    }
    if (game.settlement !== null && !this.signerKeys.find((key) => key.key_id === game.settlement?.payload.signer_key_id)?.compromised) {
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
        subsidy_per_seat: "0",
        ante_net: game.ante_net,
        terms: {
          subsidy_bps: 0,
          bond_bps: 0,
          bond_floor: "0",
          challenge_window_secs: this.options.challengeWindowSecs ?? 600,
          liveness_window_secs: this.options.livenessWindowSecs ?? 86_400,
          resolver_timeout_secs: this.options.resolverTimeoutSecs ?? 604_800,
          treasury: this.options.treasury,
        },
        created_at: nanos(this.time),
        funding_deadline: nanos(this.time + 3600),
        pool: (BigInt(game.ante_net) * BigInt(game.seats.length)).toString(),
        seats: game.seats.map((seat) => ({ wallet: seat.wallet, consent_pubkey: seat.consent_pubkey, consent_key_rotated_at: null, join_ticket: seat.join_ticket, gross_deposit: game.ante_gross, subsidy_paid: "0", net_deposit: game.ante_net, joined_at: nanos(this.time) })),
        roster_hash: game.roster_hash,
        domain: game.domain,
        bond: game.bond,
        resolver: game.resolver,
        started_at: game.roster_hash === null ? null : nanos(this.time),
        last_activity: game.last_activity === null ? null : nanos(game.last_activity),
        last_seq: game.last_seq,
        settlement: game.settlement === null ? null : { source: game.settlement.source, payload: game.settlement.payload, accepted_at: nanos(game.settlement.accepted_at), window_end: nanos(game.settlement.window_end) },
        consent_bitmap: 0,
        dispute: null,
        outcome: game.outcome === null ? null : { route: game.outcome.route, at: nanos(game.outcome.at), amounts: game.outcome.amounts, dust: game.outcome.dust, distributed: "0", bond_returned: "0", bond_to_pool: "0" },
      },
      paused: this.paused,
      latest_checkpoint: latest === null ? null : { payload: latest.payload, accepted_at: nanos(latest.accepted_at) },
      trusted_seq: this.trustedSeq(game).toString(),
      deadlines: {
        funding_deadline: nanos(this.time + 3600),
        liveness_available_at: null,
        challenge_window_end: game.settlement === null ? null : nanos(game.settlement.window_end),
        resolver_timeout_at: null,
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
        game.bond = "0";
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
        if (this.time < game.settlement.window_end) throw new ContractFailure(`the challenge window is open until ${nanos(game.settlement.window_end)}`);
        if (!apply) return;
        const weights = game.settlement.payload.settlement_weights.map((w) => BigInt(w));
        const pool = BigInt(game.ante_net) * BigInt(game.seats.length);
        const sum = weights.reduce((a, b) => a + b, BigInt(0));
        const amounts = weights.map((w) => (pool * w) / sum);
        const dust = pool - amounts.reduce((a, b) => a + b, BigInt(0));
        game.outcome = { route: "finalized", at: this.time, amounts: amounts.map((a) => a.toString()), dust: dust.toString() };
        game.state = "settled";
        return;
      }
      default:
        throw new ContractFailure(`Generic error: unknown variant ${variant}`);
    }
  }

  /** A wallet's Join, exactly as `contracts/escrow/src/execute/funding.rs::join` decides it: FUNDING, before the
   *  deadline, not full, a fresh wallet, a well-formed consent key and a 32-byte ticket -- and NOTHING about who issued
   *  the ticket (the ESCROW-3B junk-Join limitation: any wallet paying the ante takes a seat). */
  join(chainGameId: string, seat: FakeSeat): { ok: true } | { ok: false; error: string } {
    const game = this.games.get(Number(chainGameId));
    if (game === undefined) return { ok: false, error: "not found" };
    if (game.state !== "funding") return { ok: false, error: `wrong state: game is ${game.state}` };
    if (game.seats.some((existing) => existing.wallet === seat.wallet)) return { ok: false, error: "already joined" };
    if (game.seats.length >= game.max_players) return { ok: false, error: "game full" };
    if (!/^[0-9a-f]{64}$/.test(seat.join_ticket)) return { ok: false, error: "join_ticket must be 32 bytes" };
    game.seats.push({ ...seat });
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

  /** The creator's (or, after the deadline, anyone's) Cancel before Start. */
  cancel(chainGameId: string): void {
    const game = this.games.get(Number(chainGameId));
    if (game !== undefined && (game.state === "funding" || game.state === "funded")) {
      game.state = "cancelled";
      game.outcome = { route: "creator_cancel", at: this.time, amounts: game.seats.map(() => game.ante_net), dust: "0" };
    }
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

  async syncing(): Promise<boolean> {
    this.check();
    return false;
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
    return this.options.codeChecksum;
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
          resolver: this.options.resolver,
          treasury: this.options.treasury,
          denom: this.options.denom,
          params: { subsidy_bps: 100, min_ante: "1", bond_bps: 0, bond_floor: "0", challenge_window_live_secs: 600, challenge_window_async_secs: 600, funding_period_live_secs: 3600, funding_period_async_secs: 3600, liveness_window_secs: this.options.livenessWindowSecs ?? 86_400, resolver_timeout_secs: this.options.resolverTimeoutSecs ?? 604_800 },
          paused: this.paused,
        },
        next_chain_game_id: this.nextGameId,
        next_signer_key_id: this.signerKeys.length + 1,
        contract_name: "crates.io:eighteen-cosmos-escrow",
        contract_version: "1.0.0",
      };
    }
    if (variant === "signer_keys") {
      const after = body.start_after === null || body.start_after === undefined ? 0 : Number(body.start_after);
      const limit = Number(body.limit ?? 30);
      return { keys: this.signerKeys.filter((key) => key.key_id > after).slice(0, limit).map((key) => ({ key_id: key.key_id, pubkey: key.pubkey, added_at: nanos(this.time), retired_at: key.retired ? nanos(this.time) : null, compromised: key.compromised })) };
    }
    const game = this.games.get(Number(body.chain_game_id));
    if (game === undefined) throw new JunoRpcError("refused", `smart query refused: game ${String(body.chain_game_id)} not found`);
    if (variant === "game") return this.gameResponse(game);
    if (variant === "checkpoints") {
      return {
        checkpoints: [...game.checkpoints.values()].map((record) => ({ checkpoint: { payload: record.payload, accepted_at: nanos(record.accepted_at) }, signer_key_retired: false, signer_key_compromised: false })),
        liveness_candidate_seq: null,
      };
    }
    throw new JunoRpcError("refused", `smart query refused: ${variant}`);
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
      if (refused !== null) {
        const code = /sequence/.test(refused) ? 32 : /fee/.test(refused) ? 13 : /timeout/.test(refused) ? 30 : 4;
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
