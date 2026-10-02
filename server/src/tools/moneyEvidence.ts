// server/src/tools/moneyEvidence.ts
//
// ==================================================================
//  JX-4B: ONE MONEY GAME'S EVIDENCE -- THE SHARED, READ-ONLY MODEL, ITS VERDICTS AND ITS TEXT (`gamesDoctor aws money`)
// ==================================================================
//
// The evidence a live JX-4 run (CreateGame / Join / freeze / Start) files for one money game, judged in one place:
//
//   FIN              the financial record: phase, version, hold, continuation identity, the deployment pin and chain
//                    binding, the roster epoch, the frozen roster (complete roster hash and expected domain, every seat:
//                    player, chain seat index, payout wallet, ticket FINGERPRINT, consent public key -- in stored order),
//                    chain progress (Start height / domain / time, checkpoints, settle, outcome);
//   TICKETS          JX-3B's wallet-grant view of the same game (`walletGrants.ts`: its parser, its standing, its redaction);
//   CHAIN INTENTS    every `INTENT#` of the game with EVERY attempt (never only the newest): tx hash, account, account
//                    number, sequence, gas limit, fee, timeout height, phase, CheckTx answer, inclusion, resolution, death
//                    proof, failure; the execute message as stored;
//   RELAY QUEUE      the configured relayer's `RELAYQ#<relayer>` (strongly read, every page): this game's entries against
//                    what each intent's status says the queue must hold;
//   SIGNING JOURNAL  each stored attempt against the ledger's `ATTI#<intent>` and `TXID#<tx>` (tx id, account, sequence,
//                    expiry), and every journalled attempt the intents do not hold;
//   CHAIN (--chain)  the contract's config, the chain game and the contract's bank balance, compared field by field with
//                    FIN (the roster hash and domain RECOMPUTED with the codec's own `rosterHash` / `bindDomain`).
//
// This file decides nothing from a missing fact: each check is PASS, FAIL, NOT EVALUATED (a fact it needs could not be
// read) or N/A (nothing to compare in this state) -- a read that failed is never a PASS. Readers supply the facts
// (`aws/operator/moneyEvidence.ts` for DynamoDB); nothing here reads, writes, signs or broadcasts.
//
// OUTPUT SAFETY: public material is printed whole (wallets, compressed public keys, hashes and digests, tx hashes, gas,
// fees, sequences, chain and game ids, the execute message as it goes on chain). Join tickets are FINGERPRINTS (JX-3B's
// `fingerprint`: the same value shows the same fingerprint in every view). No principal, family, session, selector,
// cookie, recovery or private key is ever in the inputs' printed fields; no AWS ARN or table name is printed. The signed
// bytes themselves are printed only by the explicit `--tx-bytes` export (`selectTxBytes`).

import { createHash } from "crypto";

import { escrowInstanceKey, type EscrowBindingV2, type JunoDeploymentV1 } from "../../../frontend/src/gameEngine/escrow/escrowModel";
import { JUNO_CODEC_V1, junoDomainInputsOf } from "../../../frontend/src/gameEngine/escrow/junoCodecV1";
import { intentBelongsTo, startEpochOf, startInstanceOf, TERMINAL_INTENT_STATUSES, type ChainAttempt, type ChainIntentRecord, type RelayQueueEntry } from "../escrow/chainIntents";
import { RELAYER_EXECUTE, type JunoConfig, type JunoGameResponse } from "../escrow/juno/junoContract";
import { moneyContinuationVerdict, THIS_DEPLOYMENT } from "../escrow/moneyContinuation";
import { DEALT_PHASES, type FinancialGameRecord } from "../escrow/moneyLifecycle";
import type { WalletTicketDocument, WalletTicketGrant } from "../escrow/walletTickets";
import type { GameRecord } from "../rooms/gameRecord";
import { fingerprint, walletGrantsText, type WalletGrantsView } from "./walletGrants";

export const MONEY_EVIDENCE_FORMAT = "18COSMOS/JX4B/MONEY-EVIDENCE/v1";
export const TX_BYTES_EXPORT_FORMAT = "18COSMOS/JX4B/TX-BYTES/v1";

/* ------------------------------------------------------------------ */
/* Facts (what a reader could say about one thing it was asked to read)  */
/* ------------------------------------------------------------------ */

export type Fact<T> =
  | { readonly state: "ok"; readonly value: T }
  /** There is no such item. */
  | { readonly state: "absent" }
  /** The item EXISTS and this build cannot read it (damaged, or a later build's). */
  | { readonly state: "unreadable"; readonly detail: string }
  /** The READ failed (timeout, throttling, access denied): nothing is known. */
  | { readonly state: "unavailable"; readonly detail: string }
  /** It was not asked (no relayer configured, a mode without it, an earlier read it depends on failed). */
  | { readonly state: "not-read"; readonly detail: string };

const factWord = <T>(fact: Fact<T>): string => (fact.state === "ok" ? "read" : fact.state === "absent" ? "absent" : `${fact.state.toUpperCase()}: ${fact.detail}`);

/** A journalled attempt as the signing ledger stores it (the reader maps its own record to this). */
export interface JournalAttemptFact {
  readonly intent_id: string;
  readonly tx_id: string;
  readonly account: string;
  readonly sequence: string;
  readonly expires_after_height: string | null;
  readonly relayer_epoch: number | null;
  readonly generation: number | null;
}

/** One `INTENT#` item of the game: parsed by the intent store's own parser, or unreadable (listed, never dropped). */
export interface IntentItemRead {
  readonly intent_id: string;
  readonly intent: Fact<ChainIntentRecord>;
  /** The relay-queue key the intent item was created with (null: the item carries none). */
  readonly relay_key: { readonly pk: string; readonly sk: string } | null;
}

/** What the contract and the chain said (read-only queries against the deployment FIN names). */
export interface ChainEvidenceRead {
  /** `verified`: every configured endpoint answered and agreed (`verifiedContractFacts`); `single-endpoint`: a failover read. */
  readonly grade: "verified" | "single-endpoint";
  readonly chain_id: string;
  readonly contract: string;
  readonly height: string | null;
  readonly block_time: string | null;
  readonly code_id: string | null;
  readonly code_checksum: string;
  readonly wasm_admin: string | null;
  readonly config: JunoConfig;
  readonly game: Fact<JunoGameResponse>;
  readonly game_height: string | null;
  readonly balance: Fact<{ readonly amount: string; readonly denom: string; readonly height: string | null }>;
}

/** What this deployment's configuration says the chain must show (never printed beyond these public values). */
export interface ChainExpectation {
  readonly configured_chain_id: string;
  readonly configured_contract: string;
  readonly relayer: string | null;
  readonly operators: readonly string[];
  readonly resolvers: readonly string[];
  readonly admission_pubkey: string | null;
}

export interface MoneyEvidenceInput {
  readonly gameId: string;
  readonly source: "aws" | "file";
  readonly now: number;
  /** Public facts about where the evidence was read (no ARN, no table name). */
  readonly deployment: { readonly environment: string; readonly configuration_version: number | null; readonly escrow_configuration_version: number | null; readonly relayer: string | null; readonly relayer_detail: string };
  readonly fin: Fact<FinancialGameRecord>;
  readonly record: Fact<GameRecord>;
  /** The ticket ledger's document (the raw tickets and consent keys are compared here; only fingerprints are printed). */
  readonly tickets: Fact<{ readonly version: number; readonly document: WalletTicketDocument }>;
  /** JX-3B's view of the same ledger (standing judged by identity, redacted). */
  readonly grants: Fact<WalletGrantsView>;
  readonly intents: Fact<readonly IntentItemRead[]>;
  /** The configured relayer's queue, every entry (this view filters the game's). */
  readonly queue: Fact<{ readonly queue: string; readonly entries: readonly RelayQueueEntry[] }>;
  /** An intent whose queue key names ANOTHER queue (made under an earlier relayer): whether that item exists. */
  readonly foreignQueue: ReadonlyMap<string, Fact<boolean>>;
  /** `ATTI#<intent>` per intent id, and `TXID#<tx>` per stored attempt's tx id. Null: the journal was not read at all. */
  readonly journal: { readonly byIntent: ReadonlyMap<string, Fact<readonly JournalAttemptFact[]>>; readonly byTx: ReadonlyMap<string, Fact<JournalAttemptFact>> } | { readonly notRead: string };
  /** `--chain`: what the configuration expects and what the chain said. Null: not asked. */
  readonly chain: { readonly expect: ChainExpectation | null; readonly read: Fact<ChainEvidenceRead> } | null;
}

/* ------------------------------------------------------------------ */
/* The view                                                             */
/* ------------------------------------------------------------------ */

export type CheckStatus = "pass" | "fail" | "not-evaluated" | "n/a";

export interface EvidenceCheck {
  readonly id: string;
  readonly name: string;
  readonly status: CheckStatus;
  /** Every reason, one per line (a failure names each field that differs). */
  readonly details: readonly string[];
}

export interface RosterSeatView {
  readonly chain_seat_index: number;
  readonly player_id: string;
  readonly payout_wallet: string;
  readonly ticket: string;
  readonly consent_public_key: string;
}

export interface FinView {
  readonly read: string;
  readonly phase: string | null;
  readonly record_version: number | null;
  readonly dealt: boolean | null;
  readonly hold: { readonly code: string; readonly detail: string; readonly from: string; readonly at: number } | null;
  readonly continuation: { readonly rules_engine_version: number; readonly hosted_protocol: number; readonly financial_protocol: number; readonly settlement_codec: string } | null;
  readonly continued_here: { readonly continues: boolean; readonly why: string | null } | null;
  readonly deployment: { readonly backend: string; readonly codec: string; readonly chain_id: string; readonly network_class: string; readonly contract_address: string; readonly code_checksum: string; readonly denom: string } | null;
  readonly escrow: {
    readonly chain_game_id: string;
    readonly instance: string;
    readonly chain_id: string;
    readonly contract_address: string | null;
    readonly denom: string;
    readonly terms: EscrowBindingV2["terms"];
    readonly commitments: EscrowBindingV2["commitments"];
    readonly bound_at: number;
  } | null;
  readonly roster_epoch: number | null;
  readonly start_progress: string;
  readonly roster: { readonly frozen_at: number; readonly roster_hash: string; readonly expected_domain: string; readonly seats: readonly RosterSeatView[] } | null;
  readonly chain: {
    readonly started: { readonly height: string; readonly domain: string; readonly at: number } | null;
    readonly checkpoint_prepared: { readonly seq: string; readonly log_len: number; readonly intent_id: string } | null;
    readonly checkpoint_confirmed: { readonly seq: string; readonly log_len: number } | null;
    readonly settle_confirmed: { readonly seq: string; readonly window_end_secs: string } | null;
    readonly outcome: { readonly state: string; readonly route: string } | null;
  } | null;
}

export interface JournalCorrelation {
  /** `match`: ATTI# holds this tx with the same account, sequence and expiry; else what differs. */
  readonly atti: "match" | "missing" | "mismatch" | "not-evaluated";
  readonly txid: "match" | "missing" | "mismatch" | "not-evaluated";
  readonly details: readonly string[];
  readonly relayer_epoch: number | null;
  readonly generation: number | null;
}

export interface AttemptView {
  readonly n: number;
  readonly tx_hash: string;
  /** SHA-256 of the stored TxRaw bytes equals `tx_hash` (the durable bytes are the attempt's). */
  readonly tx_bytes_hash_ok: boolean;
  readonly tx_bytes_length: number;
  readonly account: string;
  readonly account_number: string;
  readonly sequence: string;
  readonly gas_limit: string;
  readonly fee: { readonly amount: string; readonly denom: string };
  readonly timeout_height: string;
  readonly phase: string;
  readonly signed_at: number;
  readonly broadcast: { readonly at: number; readonly code: number; readonly codespace: string; readonly log: string } | null;
  readonly broadcasts: number;
  readonly inclusion: { readonly height: string; readonly code: number; readonly codespace: string; readonly log: string } | null;
  readonly resolved_height: string | null;
  readonly death: unknown;
  readonly error: { readonly code: string; readonly retry: string; readonly native: string } | null;
  readonly observed_at: number | null;
  readonly unknown_observations: number;
  /** In words: live (outcome unknown) / included: success / included: FAILED / dead / consumed. */
  readonly failure_state: string;
  readonly journal: JournalCorrelation;
}

export interface IntentView {
  readonly intent_id: string;
  readonly read: string;
  readonly op: string | null;
  readonly op_fields: unknown;
  readonly status: string | null;
  readonly record_version: number | null;
  readonly created_at: number | null;
  readonly updated_at: number | null;
  readonly instance: string | null;
  /** For a Start: the roster epoch its slot names (null: not a Start, or not this game's instance). */
  readonly start_epoch: number | null;
  /** Whether it belongs to the game's bound escrow instance (null: the binding is not known). */
  readonly belongs: boolean | null;
  readonly key: unknown;
  readonly subject: unknown;
  readonly msg_json: string | null;
  readonly retry: { readonly failures: number; readonly next_at: number } | null;
  readonly confirmation: unknown;
  readonly superseded: unknown;
  readonly hold: unknown;
  readonly relay: { readonly key: string | null; readonly expected: "queued" | "not-queued" | null; readonly present: boolean | null; readonly verdict: "ok" | "MISSING" | "UNEXPECTED" | "STRANDED" | "not-evaluated"; readonly detail: string };
  readonly attempts: readonly AttemptView[];
}

export interface ChainView {
  readonly read: string;
  readonly grade: string | null;
  readonly chain_id: string | null;
  readonly contract: string | null;
  readonly height: string | null;
  readonly block_time: string | null;
  readonly code_checksum: string | null;
  readonly config: { readonly operator: string; readonly resolver: string; readonly admission_pubkey: string; readonly denom: string; readonly paused: boolean; readonly contract_version: string } | null;
  readonly game: {
    readonly read: string;
    readonly chain_game_id: string | null;
    readonly state: string | null;
    readonly pool: string | null;
    readonly roster_hash: string | null;
    readonly domain: string | null;
    readonly resolver: string | null;
    readonly seats: ReadonlyArray<{ readonly index: number; readonly wallet: string; readonly ticket: string; readonly consent_public_key: string; readonly gross_deposit: string; readonly net_deposit: string }>;
    /** The codec's roster hash over the chain's seat wallets, computed here (null: fewer than two seats, or refused). */
    readonly computed_roster_hash: string | null;
  } | null;
  readonly balance: string;
}

export interface MoneyEvidenceView {
  readonly format: typeof MONEY_EVIDENCE_FORMAT;
  readonly game_id: string;
  readonly source: "aws" | "file";
  readonly read_at: number;
  readonly deployment: MoneyEvidenceInput["deployment"];
  readonly fin: FinView;
  readonly tickets: { readonly read: string; readonly ledger_version: number | null; readonly frozen_at: number | null; readonly grants: WalletGrantsView | null; readonly grants_read: string };
  readonly intents: { readonly read: string; readonly items: readonly IntentView[] };
  readonly relay_queue: { readonly read: string; readonly queue: string | null; readonly total_entries: number | null; readonly game_entries: ReadonlyArray<RelayQueueEntry & { readonly verdict: string }> };
  readonly journal: { readonly read: string; readonly journal_only: ReadonlyArray<JournalAttemptFact & { readonly why: string }> };
  readonly chain: ChainView | null;
  readonly checks: readonly EvidenceCheck[];
  readonly verdicts: { readonly journal: string; readonly roster: string | null; readonly chain_binding: string | null };
  readonly summary: { readonly pass: number; readonly fail: number; readonly not_evaluated: number; readonly not_applicable: number; readonly clean: boolean };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const TERMINAL = new Set<string>(TERMINAL_INTENT_STATUSES);
const sha256Upper = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex").toUpperCase();
const iso = (ms: number | null | undefined): string => (ms === null || ms === undefined ? "-" : new Date(ms).toISOString());
const ticketFp = (hex: string): string => fingerprint("ticket", hex);

function computedDomain(escrow: EscrowBindingV2, rosterHash: string): { readonly ok: true; readonly hex: string } | { readonly ok: false; readonly why: string } {
  try {
    return { ok: true, hex: JUNO_CODEC_V1.bindDomain(junoDomainInputsOf(escrow, rosterHash)).domain.hex };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
}

function computedRosterHash(wallets: readonly string[]): { readonly ok: true; readonly hex: string } | { readonly ok: false; readonly why: string } {
  try {
    return { ok: true, hex: JUNO_CODEC_V1.rosterHash(wallets).hex };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
}

function failureStateOf(attempt: ChainAttempt): string {
  switch (attempt.phase) {
    case "signed":
      return attempt.broadcast === null ? "live: signed, never answered by a node (outcome unknown)" : `live: signed, last CheckTx ${attempt.broadcast.codespace || "-"}/${attempt.broadcast.code} (outcome unknown)`;
    case "broadcast":
      return "live: accepted into a mempool (outcome unknown)";
    case "included-success":
      return "included: success";
    case "included-failure":
      return `included: FAILED (${attempt.inclusion?.codespace || "-"}/${attempt.inclusion?.code ?? "?"})`;
    case "consumed":
      return "consumed: its sequence was spent on chain by another transaction (these bytes can never land)";
    case "dead":
      return `dead (${(attempt.death as { kind?: string } | null)?.kind ?? "proof not recorded"}): these bytes can never land`;
  }
}

/* ------------------------------------------------------------------ */
/* Building the view                                                    */
/* ------------------------------------------------------------------ */

export function buildMoneyEvidence(input: MoneyEvidenceInput): MoneyEvidenceView {
  const checks: EvidenceCheck[] = [];
  const add = (id: string, name: string, status: CheckStatus, details: readonly string[]) => checks.push({ id, name, status, details });

  const fin = input.fin.state === "ok" ? input.fin.value : null;
  const record = input.record.state === "ok" ? input.record.value : null;
  const ticketDoc = input.tickets.state === "ok" ? input.tickets.value.document : null;
  const grants = input.grants.state === "ok" ? input.grants.value : null;
  const escrow = fin?.binding?.escrow ?? null;
  const instance = escrow === null ? null : escrowInstanceKey(escrow);
  const roster = fin?.roster ?? null;

  /* ---- FIN ---- */
  const continuedHere = fin === null ? null : (() => {
    const verdict = moneyContinuationVerdict(fin.continuation, THIS_DEPLOYMENT);
    return verdict.continues ? { continues: true, why: null } : { continues: false, why: `${verdict.why}: ${verdict.detail}` };
  })();
  const startProgress =
    fin === null
      ? "unknown (no financial record read)"
      : roster === null
        ? fin.roster_epoch === 0
          ? "not frozen (pre-Start: funding)"
          : `not frozen (roster epoch ${fin.roster_epoch} was released: its Start was proven never to land)`
        : fin.chain.started === null
          ? `FROZEN, epoch ${fin.roster_epoch}, Start PENDING (provisional: released only if the chain proves Start never happened)`
          : `FROZEN, epoch ${fin.roster_epoch}, Start CONFIRMED at height ${fin.chain.started.height} (permanent)`;
  const finView: FinView = {
    read: factWord(input.fin),
    phase: fin?.phase ?? null,
    record_version: fin?.record_version ?? null,
    dealt: fin === null ? null : DEALT_PHASES.includes(fin.phase),
    hold: fin?.hold === null || fin === null ? null : { code: fin.hold.code, detail: fin.hold.detail, from: fin.hold.from, at: fin.hold.at },
    continuation: fin?.continuation === null || fin === null ? null : { rules_engine_version: fin.continuation.rules_engine_version, hosted_protocol: fin.continuation.hosted_protocol, financial_protocol: fin.continuation.financial_protocol, settlement_codec: fin.continuation.settlement_codec },
    continued_here: continuedHere,
    deployment: fin?.binding === null || fin === null ? null : { ...fin.binding.deployment },
    escrow:
      escrow === null || instance === null
        ? null
        : {
            chain_game_id: escrow.chain_game_id,
            instance,
            chain_id: escrow.network.chain_id,
            contract_address: escrow.deployment.kind === "juno-cosmwasm" ? (escrow.deployment as JunoDeploymentV1).contract_address : null,
            denom: escrow.asset.denom,
            terms: escrow.terms,
            commitments: escrow.commitments,
            bound_at: escrow.bound_at,
          },
    roster_epoch: fin?.roster_epoch ?? null,
    start_progress: startProgress,
    roster:
      roster === null
        ? null
        : {
            frozen_at: roster.frozen_at,
            roster_hash: roster.roster_hash,
            expected_domain: roster.expected_domain,
            seats: roster.roster.map((seat) => ({ chain_seat_index: seat.chain_seat_index, player_id: seat.player_id, payout_wallet: seat.payout_address, ticket: ticketFp(seat.join_ticket_hex), consent_public_key: seat.consent_public_key_hex })),
          },
    chain:
      fin === null
        ? null
        : {
            started: fin.chain.started,
            checkpoint_prepared: fin.chain.checkpoint_prepared === null ? null : { seq: fin.chain.checkpoint_prepared.seq, log_len: fin.chain.checkpoint_prepared.log_len, intent_id: fin.chain.checkpoint_prepared.intent_id },
            checkpoint_confirmed: fin.chain.checkpoint_confirmed === null ? null : { seq: fin.chain.checkpoint_confirmed.seq, log_len: fin.chain.checkpoint_confirmed.log_len },
            settle_confirmed: fin.chain.settle_confirmed === null ? null : { seq: fin.chain.settle_confirmed.seq, window_end_secs: fin.chain.settle_confirmed.window_end_secs },
            outcome: fin.chain_outcome === null ? null : { state: fin.chain_outcome.state, route: fin.chain_outcome.route },
          },
  };

  /* CHECK 1: the FIN binding is readable and internally valid. */
  {
    const problems: string[] = [];
    if (input.fin.state === "unavailable" || input.fin.state === "not-read") add("1", "FIN binding readable and internally valid", "not-evaluated", [`the financial record could not be read: ${factWord(input.fin)}`]);
    else if (input.fin.state === "absent") add("1", "FIN binding readable and internally valid", "fail", ["there is no financial record (FIN) for this game: not a money game, or its record is missing"]);
    else if (input.fin.state === "unreadable") add("1", "FIN binding readable and internally valid", "fail", [`the financial record exists and this build cannot read it: ${input.fin.detail}`]);
    else if (fin !== null) {
      const notes: string[] = [];
      if (fin.binding === null) problems.push("FIN carries no money binding (no deployment pin)");
      else {
        const pin = fin.binding.deployment;
        if (record !== null) {
          const terms = record.money;
          if (terms === null) problems.push("the GameRecord is not a money table (record_schema 1) but has a financial record");
          else {
            for (const [field, want, got] of [
              ["chain_id", pin.chain_id, terms.chain_id],
              ["network_class", pin.network_class, terms.network_class],
              ["contract_address", pin.contract_address, terms.contract_address],
              ["code_checksum", pin.code_checksum, terms.code_checksum],
              ["denom", pin.denom, terms.denom],
            ] as const)
              if (want !== got) problems.push(`FIN deployment ${field} ${want} differs from the GameRecord's money terms ${got}`);
          }
        } else notes.push(`the GameRecord was not compared (${factWord(input.record)})`);
        if (escrow !== null) {
          if (escrow.backend !== pin.backend) problems.push(`the chain binding's backend ${escrow.backend} is not the pin's ${pin.backend}`);
          if (escrow.codec !== pin.codec) problems.push(`the chain binding's codec ${escrow.codec} is not the pin's ${pin.codec}`);
          if (escrow.network.chain_id !== pin.chain_id) problems.push(`the chain binding's chain ${escrow.network.chain_id} is not the pin's ${pin.chain_id}`);
          if (escrow.network.network_class !== pin.network_class) problems.push(`the chain binding's network class ${escrow.network.network_class} is not the pin's ${pin.network_class}`);
          if (escrow.deployment.kind !== "juno-cosmwasm" || (escrow.deployment as JunoDeploymentV1).contract_address !== pin.contract_address) problems.push("the chain binding's contract is not the pin's");
          if (escrow.asset.denom !== pin.denom) problems.push(`the chain binding's denom ${escrow.asset.denom} is not the pin's ${pin.denom}`);
          if (fin.continuation !== null && escrow.commitments.rules_engine_version !== fin.continuation.rules_engine_version) problems.push(`the chain binding commits rules ${escrow.commitments.rules_engine_version}, the continuation identity says ${fin.continuation.rules_engine_version}`);
        } else if (roster !== null) problems.push("a roster is frozen but FIN binds no chain game");
        if (roster !== null && escrow !== null) {
          const recomputed = computedRosterHash(roster.roster.map((seat) => seat.payout_address));
          if (!recomputed.ok) problems.push(`the frozen roster's hash cannot be recomputed: ${recomputed.why}`);
          else if (recomputed.hex !== roster.roster_hash) problems.push(`the frozen roster_hash ${roster.roster_hash} is not the codec's hash of its payout wallets (${recomputed.hex})`);
          const domain = computedDomain(escrow, roster.roster_hash);
          if (!domain.ok) problems.push(`the expected domain cannot be recomputed: ${domain.why}`);
          else if (domain.hex !== roster.expected_domain) problems.push(`the frozen expected_domain ${roster.expected_domain} is not the codec's domain for this binding and roster (${domain.hex})`);
        }
        if (fin.chain.started !== null) {
          if (roster === null) problems.push("FIN says Start was confirmed but holds no frozen roster");
          else if (fin.chain.started.domain !== roster.expected_domain) problems.push(`the domain Start confirmed (${fin.chain.started.domain}) is not the frozen expected_domain`);
        }
      }
      if (fin.phase === "held") notes.push(`HELD ${fin.hold?.code ?? "?"}: ${fin.hold?.detail ?? ""}`);
      add("1", "FIN binding readable and internally valid", problems.length > 0 ? "fail" : "pass", problems.length > 0 ? [...problems, ...notes] : [`readable; ${fin.binding === null ? "" : "pin, binding, roster hash and domain agree"}`.trim(), ...notes]);
    }
  }

  /* CHECK 2: the ticket ledger's freeze is the roster's. */
  if (fin === null) add("2", "TICKETS frozen_at equals FIN roster frozen_at", "not-evaluated", ["no financial record was read"]);
  else if (ticketDoc === null) add("2", "TICKETS frozen_at equals FIN roster frozen_at", "not-evaluated", [`the ticket ledger could not be read: ${factWord(input.tickets)}`]);
  else if (roster === null) {
    if (ticketDoc.frozen_at === null) add("2", "TICKETS frozen_at equals FIN roster frozen_at", "pass", ["neither is frozen (pre-Start)"]);
    else add("2", "TICKETS frozen_at equals FIN roster frozen_at", "fail", [`the ticket ledger is frozen at ${ticketDoc.frozen_at} (${iso(ticketDoc.frozen_at)}) but FIN holds no frozen roster (a freeze a crash left without its roster; the escrow service releases it -- review)`]);
  } else if (ticketDoc.frozen_at === roster.frozen_at) add("2", "TICKETS frozen_at equals FIN roster frozen_at", "pass", [`both ${roster.frozen_at} (${iso(roster.frozen_at)})`]);
  else add("2", "TICKETS frozen_at equals FIN roster frozen_at", "fail", [`TICKETS frozen_at ${ticketDoc.frozen_at ?? "null"}, FIN roster frozen_at ${roster.frozen_at}`]);

  /* CHECK 3: every roster seat maps player/seat <-> chain index <-> wallet <-> ticket <-> consent key. */
  if (fin === null) add("3", "every roster seat maps player <-> chain index <-> wallet <-> ticket <-> consent key", "not-evaluated", ["no financial record was read"]);
  else if (roster === null) add("3", "every roster seat maps player <-> chain index <-> wallet <-> ticket <-> consent key", "n/a", ["no roster is frozen (the mapping is fixed at the freeze)"]);
  else {
    const problems: string[] = [];
    const missing: string[] = [];
    roster.roster.forEach((seat, at) => {
      const where = `seat ${at} (${seat.player_id})`;
      if (seat.chain_seat_index !== at) problems.push(`${where}: stored at position ${at} with chain_seat_index ${seat.chain_seat_index}`);
      if (record !== null) {
        if (!record.seats.some((s) => s.player_id === seat.player_id)) problems.push(`${where}: no seat of the GameRecord is this player`);
      } else missing.push(`${where}: the GameRecord was not read (${factWord(input.record)})`);
      if (ticketDoc !== null) {
        const frozen: WalletTicketGrant[] = ticketDoc.grants.filter((grant) => grant.player_id === seat.player_id && grant.frozen_at === roster.frozen_at);
        if (frozen.length !== 1) problems.push(`${where}: ${frozen.length} grants of this player are frozen with this roster (exactly one expected)`);
        else {
          const grant = frozen[0];
          if (grant.wallet !== seat.payout_address) problems.push(`${where}: the frozen grant (epoch ${grant.epoch}) names wallet ${grant.wallet}, the roster ${seat.payout_address}`);
          if (grant.ticket !== seat.join_ticket_hex) problems.push(`${where}: the frozen grant's ticket ${ticketFp(grant.ticket)} is not the roster's ${ticketFp(seat.join_ticket_hex)}`);
          if (!grant.consent_keys.includes(seat.consent_public_key_hex)) {
            /* The grant keeps the newest MAX_CONSENT_KEYS (8): a full list may have rotated the frozen key out. */
            if (grant.consent_keys.length >= 8) missing.push(`${where}: the roster's consent key is not among the grant's ${grant.consent_keys.length} newest keys (the list is full: it may have rotated out -- compare with the chain, --chain)`);
            else problems.push(`${where}: the roster's consent key ${seat.consent_public_key_hex} is not among the grant's ${grant.consent_keys.length} registered consent key(s)`);
          }
          if (grant.proof !== null && grant.proof.wallet !== seat.payout_address) problems.push(`${where}: the grant's proof is for ${grant.proof.wallet}`);
        }
      } else missing.push(`${where}: the ticket ledger was not read (${factWord(input.tickets)})`);
    });
    add("3", "every roster seat maps player <-> chain index <-> wallet <-> ticket <-> consent key", problems.length > 0 ? "fail" : missing.length > 0 ? "not-evaluated" : "pass", problems.length > 0 ? [...problems, ...missing] : missing.length > 0 ? missing : [`${roster.roster.length} seat(s): each in its chain position, a seat of the record, one frozen grant with the same wallet, ticket and a registered consent key`]);
  }

  /* CHECK 3b: the identity evidence (standing) behind the tickets. */
  if (grants === null) add("3b", "ticket standing judged by identity", "not-evaluated", [`the wallet grants could not be read: ${factWord(input.grants)}`]);
  else if (!grants.identity.read || !grants.record.read) add("3b", "ticket standing judged by identity", "not-evaluated", [`identity ${grants.identity.read ? "read" : `NOT read (${grants.identity.detail})`}; record ${grants.record.read ? "read" : `NOT read (${grants.record.detail})`}: standing is never guessed`]);
  else if (roster !== null) {
    const notStanding = roster.roster.filter((seat) => !grants.grants.some((grant) => grant.player_id === seat.player_id && grant.frozen_at === roster.frozen_at && grant.standing === true));
    add("3b", "ticket standing judged by identity", notStanding.length === 0 ? "pass" : "fail", notStanding.length === 0 ? ["every roster seat's frozen grant stands"] : notStanding.map((seat) => `${seat.player_id}: its frozen grant does not stand`));
  } else {
    const standing = grants.grants.filter((grant) => grant.newest && grant.standing === true).length;
    add("3b", "ticket standing judged by identity", "pass", [`pre-freeze: ${standing} seat(s) hold a standing newest grant (standing judged by identity; unfrozen grants follow it)`]);
  }

  /* CHECKS 4, 5: no duplicate chain index, no duplicate payout wallet. */
  if (roster === null) {
    add("4", "no duplicate chain seat index", fin === null ? "not-evaluated" : "n/a", [fin === null ? "no financial record was read" : "no roster is frozen"]);
    add("5", "no duplicate payout wallet", fin === null ? "not-evaluated" : "n/a", [fin === null ? "no financial record was read" : "no roster is frozen"]);
  } else {
    const indices = roster.roster.map((seat) => seat.chain_seat_index);
    const dupIndex = indices.filter((value, at) => indices.indexOf(value) !== at);
    add("4", "no duplicate chain seat index", dupIndex.length === 0 ? "pass" : "fail", dupIndex.length === 0 ? [`indices ${indices.join(", ")}`] : [`duplicated: ${[...new Set(dupIndex)].join(", ")}`]);
    const wallets = roster.roster.map((seat) => seat.payout_address);
    const dupWallet = wallets.filter((value, at) => wallets.indexOf(value) !== at);
    add("5", "no duplicate payout wallet", dupWallet.length === 0 ? "pass" : "fail", dupWallet.length === 0 ? [`${wallets.length} distinct wallet(s) (the contract seats a wallet once)`] : [`duplicated: ${[...new Set(dupWallet)].join(", ")}`]);
  }

  /* ---- intents, attempts, journal, relay queue ---- */
  const items = input.intents.state === "ok" ? input.intents.value : [];
  const queueRead = input.queue.state === "ok" ? input.queue.value : null;
  const gameQueue = queueRead === null ? [] : queueRead.entries.filter((entry) => entry.game_id === input.gameId);
  const journalRead = "notRead" in input.journal ? null : input.journal;
  const storedTx = new Set<string>();
  const journalProblems: string[] = [];
  const journalUnknown: string[] = [];
  const relayProblems: string[] = [];
  const relayUnknown: string[] = [];
  const unexplained: string[] = [];
  let attemptCount = 0;

  const intentViews: IntentView[] = items.map((item): IntentView => {
    if (item.intent.state !== "ok") {
      unexplained.push(`intent ${item.intent_id}: its item cannot be read (${factWord(item.intent)}) -- its attempts cannot be accounted for`);
      return {
        intent_id: item.intent_id,
        read: factWord(item.intent),
        op: null,
        op_fields: null,
        status: null,
        record_version: null,
        created_at: null,
        updated_at: null,
        instance: null,
        start_epoch: null,
        belongs: null,
        key: null,
        subject: null,
        msg_json: null,
        retry: null,
        confirmation: null,
        superseded: null,
        hold: null,
        relay: { key: item.relay_key === null ? null : `${item.relay_key.pk} / ${item.relay_key.sk}`, expected: null, present: null, verdict: "not-evaluated", detail: "the intent cannot be read" },
        attempts: [],
      };
    }
    const intent = item.intent.value;
    const belongs = instance === null ? null : intentBelongsTo(intent, instance);
    if (belongs === false) unexplained.push(`intent ${intent.intent_id} (${intent.op.kind}) belongs to instance ${intent.instance}, not this game's ${instance}`);
    if (instance === null) unexplained.push(`intent ${intent.intent_id} (${intent.op.kind}) exists but FIN binds no chain game`);

    /* The relay queue. */
    const terminal = TERMINAL.has(intent.status);
    const expected: "queued" | "not-queued" = terminal ? "not-queued" : "queued";
    let present: boolean | null = null;
    let verdict: IntentView["relay"]["verdict"] = "not-evaluated";
    let relayDetail: string;
    const configuredPk = queueRead === null ? null : `RELAYQ#${queueRead.queue}`;
    const keyText = item.relay_key === null ? null : `${item.relay_key.pk} / ${item.relay_key.sk}`;
    if (item.relay_key !== null && configuredPk !== null && item.relay_key.pk !== configuredPk) {
      /* Made in ANOTHER relayer's queue (an earlier relayer address). The configured relayer never reads that partition
         (no queue migration: `aws/deploy/relayerRotation.ts`), so unfinished work there is STRANDED whatever its entry
         says; finished work must have left it. */
      const foreign = input.foreignQueue.get(intent.intent_id);
      if (!terminal) {
        verdict = "STRANDED";
        present = foreign !== undefined && foreign.state === "ok" ? foreign.value : null;
        relayDetail = `made in another relayer's queue ${item.relay_key.pk} (${present === null ? "its entry not read" : present ? "its entry present there" : "its entry absent there"}): the configured relayer ${queueRead?.queue ?? "?"} never reads that queue`;
      } else if (foreign === undefined || foreign.state !== "ok") {
        relayDetail = `made in another relayer's queue ${item.relay_key.pk}; that item was ${foreign === undefined ? "not read" : factWord(foreign)}`;
        relayUnknown.push(`intent ${intent.intent_id}: ${relayDetail}`);
      } else {
        present = foreign.value;
        verdict = present ? "UNEXPECTED" : "ok";
        relayDetail = `made in another relayer's queue ${item.relay_key.pk} (an earlier relayer); ${present ? "present" : "absent"} there`;
      }
      const stray = gameQueue.find((candidate) => candidate.intent_id === intent.intent_id);
      if (stray !== undefined) {
        verdict = verdict === "STRANDED" ? "STRANDED" : "UNEXPECTED";
        relayDetail += `; an entry for it also sits in the configured queue (${stray.created_at}), which its item does not name`;
      }
    } else if (queueRead === null) {
      relayDetail = `the relay queue was not read (${factWord(input.queue)})`;
      relayUnknown.push(`intent ${intent.intent_id}: ${relayDetail}`);
    } else {
      const entry = gameQueue.find((candidate) => candidate.intent_id === intent.intent_id);
      present = entry !== undefined;
      verdict = present === !terminal ? "ok" : present ? "UNEXPECTED" : "MISSING";
      relayDetail = present ? `queued at ${entry!.created_at}${entry!.created_at !== intent.created_at ? ` -- NOT the intent's created_at ${intent.created_at}` : ""}` : "not in the queue";
      if (entry !== undefined && entry.created_at !== intent.created_at) {
        verdict = "UNEXPECTED";
        relayDetail += " (a queue entry that is not this intent's)";
      }
      if (item.relay_key === null) relayDetail += "; the intent item carries no queue key";
    }
    if (verdict === "STRANDED") relayProblems.push(`intent ${intent.intent_id} (${intent.op.kind}, ${intent.status}) is not terminal and STRANDED: ${relayDetail}`);
    if (verdict === "MISSING") relayProblems.push(`intent ${intent.intent_id} (${intent.op.kind}, ${intent.status}) is not terminal and is NOT in the relay queue: the relayer would never see it`);
    if (verdict === "UNEXPECTED") relayProblems.push(`intent ${intent.intent_id} (${intent.op.kind}, ${intent.status}) is ${terminal ? "TERMINAL and still queued" : "queued under another creation time"}: ${relayDetail}`);

    /* Every attempt, with its journal correlation. */
    const atti = journalRead?.byIntent.get(intent.intent_id);
    /* The intent's journal read itself: an ATTI# read that failed is NOT EVALUATED even when the intent stores no attempt
       (the journal-first crash leaves exactly an intent with none and an ATTI# entry). */
    if (journalRead !== null && (atti === undefined || atti.state !== "ok") && intent.attempts.length === 0) journalUnknown.push(`intent ${intent.intent_id} (${intent.op.kind}): ATTI#${intent.intent_id} ${atti === undefined ? "was not read" : factWord(atti)} -- a journalled attempt the intent does not store cannot be ruled out`);
    const attempts = intent.attempts.map((attempt): AttemptView => {
      attemptCount += 1;
      storedTx.add(attempt.tx_hash);
      let bytes: Buffer;
      try {
        bytes = Buffer.from(attempt.tx_bytes, "base64");
      } catch {
        bytes = Buffer.alloc(0);
      }
      const hashOk = sha256Upper(bytes) === attempt.tx_hash;
      if (!hashOk) journalProblems.push(`intent ${intent.intent_id} attempt ${attempt.n}: SHA-256 of its stored tx_bytes is not its tx_hash ${attempt.tx_hash}`);
      const details: string[] = [];
      let attiWord: JournalCorrelation["atti"] = "not-evaluated";
      let txidWord: JournalCorrelation["txid"] = "not-evaluated";
      let epoch: number | null = null;
      let generation: number | null = null;
      const compare = (label: string, entry: JournalAttemptFact): string[] => {
        const out: string[] = [];
        if (entry.intent_id !== intent.intent_id) out.push(`${label} names intent ${entry.intent_id}`);
        if (entry.tx_id !== attempt.tx_hash) out.push(`${label} tx ${entry.tx_id}`);
        if (entry.account !== attempt.account) out.push(`${label} account ${entry.account}, the attempt ${attempt.account}`);
        if (entry.sequence !== attempt.sequence) out.push(`${label} sequence ${entry.sequence}, the attempt ${attempt.sequence}`);
        if ((entry.expires_after_height ?? null) !== attempt.timeout_height) out.push(`${label} expiry ${entry.expires_after_height ?? "none"}, the attempt's timeout_height ${attempt.timeout_height}`);
        return out;
      };
      if (journalRead === null) details.push(`the journal was not read (${"notRead" in input.journal ? input.journal.notRead : ""})`);
      else {
        if (atti === undefined || atti.state !== "ok") {
          details.push(`ATTI#${intent.intent_id}: ${atti === undefined ? "not read" : factWord(atti)}`);
        } else {
          const found = atti.value.filter((entry) => entry.tx_id === attempt.tx_hash);
          if (found.length === 0) {
            attiWord = "missing";
            details.push(`ATTI#${intent.intent_id} holds no entry for tx ${attempt.tx_hash}`);
          } else {
            const diff = compare("ATTI#", found[0]);
            attiWord = diff.length === 0 ? "match" : "mismatch";
            details.push(...diff);
            epoch = found[0].relayer_epoch;
            generation = found[0].generation;
          }
        }
        const txid = journalRead.byTx.get(attempt.tx_hash);
        if (txid === undefined || (txid.state !== "ok" && txid.state !== "absent")) details.push(`TXID#${attempt.tx_hash}: ${txid === undefined ? "not read" : factWord(txid)}`);
        else if (txid.state === "absent") {
          txidWord = "missing";
          details.push(`TXID#${attempt.tx_hash} does not exist`);
        } else {
          const diff = compare("TXID#", txid.value);
          txidWord = diff.length === 0 ? "match" : "mismatch";
          details.push(...diff);
        }
      }
      const where = `intent ${intent.intent_id} (${intent.op.kind}) attempt ${attempt.n} tx ${attempt.tx_hash}`;
      if (attiWord === "missing" || attiWord === "mismatch" || txidWord === "missing" || txidWord === "mismatch") journalProblems.push(`${where}: ATTI ${attiWord}, TXID ${txidWord}${details.length > 0 ? ` -- ${details.join("; ")}` : ""}`);
      else if (attiWord === "not-evaluated" || txidWord === "not-evaluated") journalUnknown.push(`${where}: ${details.join("; ")}`);
      return {
        n: attempt.n,
        tx_hash: attempt.tx_hash,
        tx_bytes_hash_ok: hashOk,
        tx_bytes_length: bytes.length,
        account: attempt.account,
        account_number: attempt.account_number,
        sequence: attempt.sequence,
        gas_limit: attempt.gas_limit,
        fee: { amount: attempt.fee.amount, denom: attempt.fee.denom },
        timeout_height: attempt.timeout_height,
        phase: attempt.phase,
        signed_at: attempt.signed_at,
        broadcast: attempt.broadcast,
        broadcasts: attempt.broadcasts,
        inclusion: attempt.inclusion,
        resolved_height: attempt.resolved_height,
        death: attempt.death,
        error: attempt.error === null ? null : { code: attempt.error.code, retry: attempt.error.retry, native: `${attempt.error.native.name}: ${attempt.error.native.message}`.slice(0, 300) },
        observed_at: attempt.observed_at,
        unknown_observations: attempt.unknown_observations,
        failure_state: failureStateOf(attempt),
        journal: { atti: attiWord, txid: txidWord, details, relayer_epoch: epoch, generation },
      };
    });
    return {
      intent_id: intent.intent_id,
      read: "read",
      op: intent.op.kind,
      op_fields: intent.op,
      status: intent.status,
      record_version: intent.record_version,
      created_at: intent.created_at,
      updated_at: intent.updated_at,
      instance: intent.instance,
      start_epoch: intent.op.kind === "start" && instance !== null ? startEpochOf(intent.instance, instance) : null,
      belongs,
      key: intent.key,
      subject: intent.subject,
      msg_json: intent.msg_json,
      retry: intent.retry,
      confirmation: intent.confirmation,
      superseded: intent.superseded,
      hold: intent.hold,
      relay: { key: keyText, expected, present, verdict, detail: relayDetail },
      attempts,
    };
  });

  /* Journal entries the intents do not hold. */
  const journalOnly: Array<JournalAttemptFact & { readonly why: string }> = [];
  if (journalRead !== null) {
    const unreadableIntents = new Set(items.filter((item) => item.intent.state !== "ok").map((item) => item.intent_id));
    const heldIntents = new Set(items.map((item) => item.intent_id));
    for (const [intentId, fact] of journalRead.byIntent) {
      if (fact.state !== "ok") continue;
      for (const entry of fact.value) {
        if (storedTx.has(entry.tx_id)) continue;
        const why = !heldIntents.has(intentId)
          ? `journalled for intent ${intentId}, which this game table does NOT hold (one of this game's Start slots): the ledger is ahead of the table (a restored table?) -- review before anything is signed again`
          : unreadableIntents.has(intentId)
            ? `journalled for intent ${intentId}, whose item cannot be read: the attempt cannot be matched to a stored one`
            : `journalled for intent ${intentId} but no stored attempt of it carries tx ${entry.tx_id}: the relayer journals FIRST, so a crash or a refused store write between the two leaves exactly this -- those bytes were never handed to a node by this server; check the chain for ${entry.tx_id} and the account sequence ${entry.sequence}`;
        journalOnly.push({ ...entry, why });
        unexplained.push(`journal-only attempt ${entry.tx_id} (intent ${intentId}, sequence ${entry.sequence})`);
      }
    }
  }

  if (journalRead !== null) {
    for (const [intentId, fact] of journalRead.byIntent) {
      if (items.some((item) => item.intent_id === intentId) || fact.state === "ok") continue;
      journalUnknown.push(`ATTI#${intentId} (a Start slot of this game with no INTENT# item): ${factWord(fact)}`);
    }
  }

  /* Queue entries of this game that no intent explains. */
  const known = new Set(items.map((item) => item.intent_id));
  const queueEntries = gameQueue.map((entry) => {
    const owner = intentViews.find((view) => view.intent_id === entry.intent_id);
    let verdict: string;
    if (!known.has(entry.intent_id)) {
      verdict = "UNEXPECTED: no intent of this game has this id";
      relayProblems.push(`the queue holds ${entry.intent_id} for this game, which no intent of the game explains`);
    } else if (owner !== undefined && owner.relay.key !== null && queueRead !== null && !owner.relay.key.startsWith(`RELAYQ#${queueRead.queue} / `)) verdict = `UNEXPECTED: the intent was made in another queue (${owner.relay.key.split(" / ")[0]})`;
    else if (owner !== undefined && owner.status !== null && TERMINAL.has(owner.status)) verdict = `UNEXPECTED: the intent is ${owner.status} (terminal)`;
    else verdict = owner !== undefined && owner.read === "read" ? `expected (${owner.status})` : "the intent cannot be read";
    return { ...entry, verdict };
  });

  /* CHECK 6: every Start intent carries FIN's roster hash. */
  {
    const starts = intentViews.filter((view) => view.op === "start");
    if (input.intents.state !== "ok") add("6", "every Start intent's roster_hash equals FIN roster_hash", "not-evaluated", [`the intents could not be read: ${factWord(input.intents)}`]);
    else if (fin === null) add("6", "every Start intent's roster_hash equals FIN roster_hash", "not-evaluated", ["no financial record was read"]);
    else if (starts.length === 0) {
      if (roster === null) add("6", "every Start intent's roster_hash equals FIN roster_hash", "n/a", ["no roster is frozen and no Start intent exists"]);
      else add("6", "every Start intent's roster_hash equals FIN roster_hash", "not-evaluated", ["the roster is frozen but no Start intent exists yet (the freeze's task, the load or the sweep writes it)"]);
    } else {
      const problems: string[] = [];
      const notes: string[] = [];
      let current = 0;
      for (const view of starts) {
        const op = view.op_fields as { readonly chain_game_id: string; readonly roster_hash: string };
        const subject = view.subject as { readonly kind: string; readonly roster_hash?: string };
        if (subject.kind !== "roster" || subject.roster_hash !== op.roster_hash) problems.push(`Start ${view.intent_id}: its subject is not its op's roster hash`);
        if (view.msg_json !== RELAYER_EXECUTE.start(op.chain_game_id, op.roster_hash)) problems.push(`Start ${view.intent_id}: its execute message is not the canonical Start for chain game ${op.chain_game_id} and its roster hash`);
        if (escrow !== null && op.chain_game_id !== escrow.chain_game_id) problems.push(`Start ${view.intent_id}: chain game ${op.chain_game_id}, FIN binds ${escrow.chain_game_id}`);
        const isCurrent = roster !== null && instance !== null && view.instance === startInstanceOf(instance, fin.roster_epoch);
        if (isCurrent) {
          current += 1;
          if (op.roster_hash !== roster.roster_hash) problems.push(`Start ${view.intent_id} (epoch ${fin.roster_epoch}, the current freeze): roster_hash ${op.roster_hash}, FIN ${roster.roster_hash}`);
        } else if (view.start_epoch !== null) {
          if (view.status !== null && !TERMINAL.has(view.status)) problems.push(`Start ${view.intent_id} of epoch ${view.start_epoch} is ${view.status} but is NOT the current freeze's (${roster === null ? "none frozen" : `epoch ${fin.roster_epoch}`})`);
          else notes.push(`Start ${view.intent_id} of epoch ${view.start_epoch} (a released freeze, ${view.status}): roster_hash ${op.roster_hash}`);
        }
      }
      if (roster !== null && current === 0) problems.push(`no Start intent is the current freeze's (epoch ${fin.roster_epoch})`);
      add("6", "every Start intent's roster_hash equals FIN roster_hash", problems.length > 0 ? "fail" : "pass", problems.length > 0 ? [...problems, ...notes] : [`${current} current Start intent(s) carry ${roster?.roster_hash ?? "-"}`, ...notes]);
    }
  }

  /* CHECK 7: the journal's metadata equals the intents' attempts. */
  let journalVerdict: string;
  if (input.intents.state !== "ok") {
    add("7", "journal attempt metadata equals intent attempt metadata", "not-evaluated", [`the intents could not be read: ${factWord(input.intents)}`]);
    journalVerdict = "JOURNAL NOT EVALUATED";
  } else if (journalProblems.length > 0 || journalOnly.length > 0) {
    /* A mismatch is reported even when another attempt could not be compared (those are listed with it). */
    add("7", "journal attempt metadata equals intent attempt metadata", "fail", [...journalProblems, ...journalOnly.map((entry) => `journal-only ${entry.tx_id}: ${entry.why}`), ...journalUnknown.map((line) => `NOT EVALUATED: ${line}`)]);
    journalVerdict = "JOURNAL MISMATCH";
  } else if (journalUnknown.length > 0 || (journalRead === null && attemptCount > 0)) {
    add("7", "journal attempt metadata equals intent attempt metadata", "not-evaluated", journalUnknown.length > 0 ? journalUnknown : ["the journal was not read"]);
    journalVerdict = "JOURNAL NOT EVALUATED";
  } else if (attemptCount === 0) {
    add("7", "journal attempt metadata equals intent attempt metadata", journalRead === null ? "not-evaluated" : "pass", [journalRead === null ? "the journal was not read" : "no attempt was ever signed for this game, and the journal holds none for its intents"]);
    journalVerdict = journalRead === null ? "JOURNAL NOT EVALUATED" : "JOURNAL MATCH";
  } else {
    add("7", "journal attempt metadata equals intent attempt metadata", "pass", [`${attemptCount} attempt(s): ATTI# and TXID# agree on tx id, account, sequence and expiry; no journal attempt is unaccounted for`]);
    journalVerdict = "JOURNAL MATCH";
  }

  /* CHECK 8: the relay queue agrees with each intent's live/terminal state. */
  if (input.intents.state !== "ok") add("8", "RELAYQ membership agrees with each intent's live/terminal state", "not-evaluated", [`the intents could not be read: ${factWord(input.intents)}`]);
  else if (relayProblems.length > 0) add("8", "RELAYQ membership agrees with each intent's live/terminal state", "fail", [...relayProblems, ...relayUnknown]);
  else if (relayUnknown.length > 0 || queueRead === null) add("8", "RELAYQ membership agrees with each intent's live/terminal state", "not-evaluated", relayUnknown.length > 0 ? relayUnknown : [`the relay queue was not read (${factWord(input.queue)})`]);
  else add("8", "RELAYQ membership agrees with each intent's live/terminal state", "pass", [`RELAYQ#${queueRead.queue}: ${gameQueue.length} entr${gameQueue.length === 1 ? "y" : "ies"} of this game (of ${queueRead.entries.length}); every non-terminal intent queued, no terminal one`]);

  /* CHECK 9: nothing unexplained. */
  if (input.intents.state !== "ok") add("9", "no unexplained intent or journal attempt for this game", "not-evaluated", [`the intents could not be read: ${factWord(input.intents)}`]);
  else if (unexplained.length > 0) add("9", "no unexplained intent or journal attempt for this game", "fail", unexplained);
  else if (journalRead === null) add("9", "no unexplained intent or journal attempt for this game", "not-evaluated", ["the journal was not read"]);
  else if ([...journalRead.byIntent.values()].some((fact) => fact.state !== "ok") || items.some((item) => !journalRead.byIntent.has(item.intent_id))) {
    add("9", "no unexplained intent or journal attempt for this game", "not-evaluated", ["an ATTI# read failed: a journalled attempt no intent stores cannot be ruled out"]);
  }
  else add("9", "no unexplained intent or journal attempt for this game", "pass", [`${items.length} intent(s), every one of this game's escrow instance; every journalled attempt is stored on its intent`]);

  /* ---- CHAIN (--chain) ---- */
  let chainView: ChainView | null = null;
  let rosterVerdict: string | null = null;
  let bindingVerdict: string | null = null;
  if (input.chain !== null) {
    const result = chainChecks(input, fin, record, ticketDoc);
    chainView = result.view;
    for (const check of result.checks) checks.push(check);
    rosterVerdict = result.roster;
    bindingVerdict = result.binding;
  }

  const count = (status: CheckStatus) => checks.filter((check) => check.status === status).length;
  const summary = { pass: count("pass"), fail: count("fail"), not_evaluated: count("not-evaluated"), not_applicable: count("n/a"), clean: count("fail") === 0 && count("not-evaluated") === 0 };
  return {
    format: MONEY_EVIDENCE_FORMAT,
    game_id: input.gameId,
    source: input.source,
    read_at: input.now,
    deployment: input.deployment,
    fin: finView,
    tickets: {
      read: factWord(input.tickets),
      ledger_version: input.tickets.state === "ok" ? input.tickets.value.version : null,
      frozen_at: ticketDoc?.frozen_at ?? null,
      grants,
      grants_read: factWord(input.grants),
    },
    intents: { read: factWord(input.intents), items: intentViews },
    relay_queue: { read: factWord(input.queue), queue: queueRead?.queue ?? null, total_entries: queueRead?.entries.length ?? null, game_entries: queueEntries },
    journal: { read: journalRead === null ? `NOT READ: ${"notRead" in input.journal ? input.journal.notRead : ""}` : "read", journal_only: journalOnly },
    chain: chainView,
    checks,
    verdicts: { journal: journalVerdict, roster: rosterVerdict, chain_binding: bindingVerdict },
    summary,
  };
}

/* ------------------------------------------------------------------ */
/* --chain: what the contract says, field by field                       */
/* ------------------------------------------------------------------ */

const CHAIN_STATE_WORD: Readonly<Record<string, string>> = Object.freeze({ FUNDING: "funding", FUNDED: "funded", IN_PROGRESS: "in progress", SETTLEABLE: "settleable", DISPUTED: "disputed", SETTLED: "settled", CANCELLED: "cancelled", ANNULLED: "annulled" });
const PRE_START = new Set(["FUNDING", "FUNDED", "CANCELLED"]);

function chainChecks(input: MoneyEvidenceInput, fin: FinancialGameRecord | null, record: GameRecord | null, ticketDoc: WalletTicketDocument | null): { readonly view: ChainView; readonly checks: EvidenceCheck[]; readonly roster: string; readonly binding: string } {
  const chain = input.chain!;
  const checks: EvidenceCheck[] = [];
  const read = chain.read.state === "ok" ? chain.read.value : null;
  const escrow = fin?.binding?.escrow ?? null;
  const pin = fin?.binding?.deployment ?? null;
  const roster = fin?.roster ?? null;
  const game = read !== null && read.game.state === "ok" ? read.game.value : null;
  const seatsOnChain = game?.game.seats ?? [];
  const computed = seatsOnChain.length >= 2 ? computedRosterHash(seatsOnChain.map((seat) => seat.wallet)) : null;
  const view: ChainView = {
    read: factWord(chain.read),
    grade: read?.grade ?? null,
    chain_id: read?.chain_id ?? null,
    contract: read?.contract ?? null,
    height: read?.height ?? null,
    block_time: read?.block_time ?? null,
    code_checksum: read?.code_checksum ?? null,
    config: read === null ? null : { operator: read.config.operator, resolver: read.config.resolver, admission_pubkey: read.config.admission_pubkey, denom: read.config.denom, paused: read.config.paused, contract_version: `${read.config.contract_name} ${read.config.contract_version}` },
    game:
      read === null
        ? null
        : {
            read: factWord(read.game),
            chain_game_id: game?.game.chain_game_id ?? null,
            state: game?.game.state ?? null,
            pool: game?.game.pool ?? null,
            roster_hash: game?.game.roster_hash ?? null,
            domain: game?.game.domain ?? null,
            resolver: game?.game.resolver ?? null,
            seats: seatsOnChain.map((seat, index) => ({ index, wallet: seat.wallet, ticket: ticketFp(seat.join_ticket), consent_public_key: seat.consent_pubkey, gross_deposit: seat.gross_deposit, net_deposit: seat.net_deposit })),
            computed_roster_hash: computed !== null && computed.ok ? computed.hex : null,
          },
    balance: read === null ? "not read" : read.balance.state === "ok" ? `${read.balance.value.amount}${read.balance.value.denom}${read.balance.value.height !== null ? ` at height ${read.balance.value.height}` : ""}` : factWord(read.balance),
  };

  const word = (status: CheckStatus, label: string, details: readonly string[]) => (status === "pass" ? `${label} MATCH` : status === "fail" ? `${label} MISMATCH: ${details[0] ?? ""}` : status === "n/a" ? `${label} N/A (${details[0] ?? ""})` : `${label} NOT EVALUATED (${details[0] ?? ""})`);
  if (read === null || fin === null || pin === null) {
    const why = read === null ? `the chain could not be read: ${factWord(chain.read)}` : fin === null ? "no financial record was read" : "FIN carries no deployment pin";
    checks.push({ id: "C1", name: "ROSTER: FIN roster equals the chain's seats", status: "not-evaluated", details: [why] });
    checks.push({ id: "C2", name: "CHAIN BINDING: contract, chain game, terms, state, resolver, operator", status: "not-evaluated", details: [why] });
    checks.push({ id: "C3", name: "the contract's bank balance covers this game's pool", status: "not-evaluated", details: [why] });
    return { view, checks, roster: `ROSTER NOT EVALUATED (${why})`, binding: `CHAIN BINDING NOT EVALUATED (${why})` };
  }

  /* CHAIN BINDING */
  const binding: string[] = [];
  const bindingUnknown: string[] = [];
  const expect = chain.expect;
  if (expect !== null && expect.configured_contract !== pin.contract_address) binding.push(`this deployment's configuration serves contract ${expect.configured_contract}, FIN is bound to ${pin.contract_address}`);
  if (read.chain_id !== pin.chain_id) binding.push(`the chain answered as ${read.chain_id}, FIN is bound to ${pin.chain_id}`);
  if (read.code_checksum !== pin.code_checksum) binding.push(`the contract's code checksum is ${read.code_checksum}, FIN's ${pin.code_checksum}`);
  if (read.config.denom !== pin.denom) binding.push(`the contract's denom is ${read.config.denom}, FIN's ${pin.denom}`);
  if (expect !== null && expect.relayer !== null && read.config.operator !== expect.relayer) binding.push(`the contract's operator is ${read.config.operator}, the configured relayer ${expect.relayer}`);
  if (expect !== null && expect.operators.length > 0 && !expect.operators.includes(read.config.operator)) binding.push(`the contract's operator ${read.config.operator} is not in the trust policy's operators`);
  if (expect !== null && expect.resolvers.length > 0 && !expect.resolvers.includes(read.config.resolver)) binding.push(`the contract's resolver ${read.config.resolver} is not in the trust policy's resolvers`);
  if (expect !== null && expect.admission_pubkey !== null && read.config.admission_pubkey !== expect.admission_pubkey) binding.push(`the contract's admission key ${read.config.admission_pubkey} is not the configured ${expect.admission_pubkey}`);
  if (expect === null) bindingUnknown.push("this deployment's escrow configuration was not read: the operator, resolver and admission key were not compared with it");
  if (escrow === null) {
    /* Before the host's CreateGame is bound: the contract-level facts are still comparable; the game-level ones are not. */
    if (roster !== null) binding.push("a roster is frozen but FIN binds no chain game");
    const status: CheckStatus = binding.length > 0 ? "fail" : bindingUnknown.length > 0 ? "not-evaluated" : "pass";
    const details = binding.length > 0 ? [...binding, ...bindingUnknown] : bindingUnknown.length > 0 ? bindingUnknown : [`contract ${read.contract} (${read.grade}), chain ${read.chain_id}, checksum, denom, operator, resolver and admission key agree; no chain game is bound yet`];
    const notBound = ["FIN binds no chain game yet (the host's CreateGame is not bound)"];
    checks.push({ id: "C1", name: "ROSTER: FIN roster equals the chain's seats", status: "n/a", details: notBound });
    checks.push({ id: "C2", name: "CHAIN BINDING: contract, chain game, terms, state, resolver, operator", status, details });
    checks.push({ id: "C3", name: "the contract's bank balance covers this game's pool", status: "n/a", details: notBound });
    return { view, checks, roster: word("n/a", "ROSTER", notBound), binding: word(status, "CHAIN BINDING", details) };
  }
  if (read.game.state !== "ok") binding.push(`chain game ${escrow.chain_game_id}: ${factWord(read.game)}`);
  else {
    const g = read.game.value.game;
    if (g.chain_game_id !== escrow.chain_game_id) binding.push(`the chain answered game ${g.chain_game_id}, FIN binds ${escrow.chain_game_id}`);
    if (g.denom !== pin.denom) binding.push(`the chain game's denom is ${g.denom}, FIN's ${pin.denom}`);
    for (const [field, want, got] of [
      ["ante_gross", escrow.terms.ante_gross, g.ante_gross],
      ["ante_net", escrow.terms.ante_net, g.ante_net],
      ["max_players", String(escrow.terms.max_players), String(g.max_players)],
      ["mode", String(escrow.terms.mode), String(g.mode)],
      ["rules_engine_version", String(escrow.commitments.rules_engine_version), String(g.rules_engine_version)],
      ["variants_digest", escrow.commitments.variants_digest, g.variants_digest],
    ] as const)
      if (want !== got) binding.push(`the chain game's ${field} is ${got}, FIN's binding ${want}`);
    if (g.resolver !== null && expect !== null && expect.resolvers.length > 0 && !expect.resolvers.includes(g.resolver)) binding.push(`the chain game's resolver ${g.resolver} is not in the trust policy's resolvers`);
    /* The chain's state against what FIN says happened. */
    const started = fin.chain.started !== null;
    if (roster === null && !PRE_START.has(g.state)) binding.push(`the chain game is ${CHAIN_STATE_WORD[g.state] ?? g.state}, but FIN froze no roster (the chain started a game the server never froze)`);
    if (started && PRE_START.has(g.state)) binding.push(`FIN says Start was confirmed at ${fin.chain.started!.height}, the chain game is ${CHAIN_STATE_WORD[g.state] ?? g.state}`);
    if (fin.chain_outcome !== null && g.state !== fin.chain_outcome.state) binding.push(`FIN recorded the outcome ${fin.chain_outcome.state}, the chain game is ${g.state}`);
    if (started && g.domain !== fin.chain.started!.domain) binding.push(`the chain game's domain ${g.domain ?? "null"} is not the one FIN saw Start confirm (${fin.chain.started!.domain})`);
    if (record !== null && record.money !== null && record.money.contract_address !== read.contract) binding.push(`the GameRecord's contract ${record.money.contract_address} is not the contract read`);
  }
  const bindingStatus: CheckStatus = binding.length > 0 ? "fail" : bindingUnknown.length > 0 ? "not-evaluated" : "pass";
  checks.push({
    id: "C2",
    name: "CHAIN BINDING: contract, chain game, terms, state, resolver, operator",
    status: bindingStatus,
    details: binding.length > 0 ? [...binding, ...bindingUnknown] : bindingUnknown.length > 0 ? bindingUnknown : [`contract ${read.contract} (${read.grade}), chain ${read.chain_id}, checksum, denom, chain game ${escrow.chain_game_id} and its terms, operator, resolver and admission key agree`],
  });

  /* ROSTER */
  const rosterProblems: string[] = [];
  const rosterNotes: string[] = [];
  let rosterStatus: CheckStatus;
  if (read.game.state !== "ok") {
    rosterStatus = "not-evaluated";
    rosterNotes.push(`chain game ${escrow.chain_game_id}: ${factWord(read.game)}`);
  } else if (roster === null) {
    rosterStatus = "n/a";
    rosterNotes.push(`no roster is frozen; the chain holds ${seatsOnChain.length} funded seat(s)`);
    if (ticketDoc !== null) {
      seatsOnChain.forEach((seat, index) => {
        const bound = ticketDoc.grants.some((grant) => grant.wallet === seat.wallet && grant.ticket === seat.join_ticket);
        rosterNotes.push(`chain seat ${index} ${seat.wallet} ${ticketFp(seat.join_ticket)}: ${bound ? "its (wallet, ticket) is a grant of this game" : "NO grant of this game carries its (wallet, ticket): unbound (refundable) unless relinked"}`);
      });
    }
  } else {
    const g = read.game.value.game;
    if (g.seats.length !== roster.roster.length) rosterProblems.push(`the chain holds ${g.seats.length} seat(s), the frozen roster ${roster.roster.length}`);
    roster.roster.forEach((seat, index) => {
      const onChain = g.seats[index];
      if (onChain === undefined) return;
      if (onChain.wallet !== seat.payout_address) rosterProblems.push(`seat ${index}: the chain's wallet ${onChain.wallet}, the roster's ${seat.payout_address}`);
      if (onChain.join_ticket !== seat.join_ticket_hex) rosterProblems.push(`seat ${index}: the chain's ticket ${ticketFp(onChain.join_ticket)}, the roster's ${ticketFp(seat.join_ticket_hex)}`);
      if (onChain.consent_pubkey !== seat.consent_public_key_hex) {
        const grant = ticketDoc?.grants.find((candidate) => candidate.player_id === seat.player_id && candidate.frozen_at === roster.frozen_at);
        if (grant !== undefined && grant.consent_keys.includes(onChain.consent_pubkey)) rosterNotes.push(`seat ${index}: the chain's consent key ${onChain.consent_pubkey} moved from the frozen ${seat.consent_public_key_hex} (SetConsentKey); the new key is registered on the seat's grant`);
        else rosterProblems.push(`seat ${index}: the chain's consent key ${onChain.consent_pubkey}, the roster's ${seat.consent_public_key_hex}${ticketDoc === null ? "" : " (and the seat's grant does not register the chain's key)"}`);
      }
    });
    if (computed === null) rosterProblems.push(`the roster hash cannot be recomputed from ${seatsOnChain.length} chain seat(s)`);
    else if (!computed.ok) rosterProblems.push(`the roster hash cannot be recomputed from the chain's seats: ${computed.why}`);
    else if (computed.hex !== roster.roster_hash) rosterProblems.push(`the codec's roster hash of the chain's seats is ${computed.hex}, FIN's roster_hash ${roster.roster_hash}`);
    const domain = computedDomain(escrow, roster.roster_hash);
    if (!domain.ok) rosterProblems.push(`the domain cannot be recomputed: ${domain.why}`);
    else if (domain.hex !== roster.expected_domain) rosterProblems.push(`the codec's domain is ${domain.hex}, FIN's expected_domain ${roster.expected_domain}`);
    if (PRE_START.has(g.state)) {
      rosterNotes.push(`the chain has not started the game (${CHAIN_STATE_WORD[g.state] ?? g.state}): its roster_hash and domain are not frozen yet${g.roster_hash !== null ? "" : " (null)"}`);
    } else {
      if (g.roster_hash !== roster.roster_hash) rosterProblems.push(`the chain froze roster_hash ${g.roster_hash ?? "null"}, FIN ${roster.roster_hash}`);
      if (g.domain !== roster.expected_domain) rosterProblems.push(`the chain froze domain ${g.domain ?? "null"}, FIN's expected_domain ${roster.expected_domain}`);
      if (fin.chain.started === null) rosterNotes.push("the chain started the game; FIN has not observed it yet (the next observation records it)");
    }
    rosterStatus = rosterProblems.length > 0 ? "fail" : "pass";
    if (rosterStatus === "pass") rosterNotes.unshift(`${roster.roster.length} seat(s) in chain order; recomputed roster_hash ${roster.roster_hash} and domain ${roster.expected_domain} match`);
  }
  checks.unshift({ id: "C1", name: "ROSTER: FIN roster equals the chain's seats", status: rosterStatus, details: [...rosterProblems, ...rosterNotes] });

  /* BALANCE */
  if (read.balance.state !== "ok") checks.push({ id: "C3", name: "the contract's bank balance covers this game's pool", status: "not-evaluated", details: [`the contract's balance: ${factWord(read.balance)}`] });
  else if (read.game.state !== "ok") checks.push({ id: "C3", name: "the contract's bank balance covers this game's pool", status: "not-evaluated", details: ["the chain game was not read"] });
  else {
    const g = read.game.value.game;
    const balance = BigInt(read.balance.value.amount);
    const pool = BigInt(g.pool);
    const terminal = g.state === "SETTLED" || g.state === "CANCELLED" || g.state === "ANNULLED";
    if (read.balance.value.denom !== pin.denom) checks.push({ id: "C3", name: "the contract's bank balance covers this game's pool", status: "fail", details: [`the balance was read in ${read.balance.value.denom}, FIN's denom is ${pin.denom}`] });
    else if (terminal) checks.push({ id: "C3", name: "the contract's bank balance covers this game's pool", status: "n/a", details: [`the chain game is ${g.state}: its pool was paid out; balance ${balance}${pin.denom}`] });
    else checks.push({ id: "C3", name: "the contract's bank balance covers this game's pool", status: balance >= pool ? "pass" : "fail", details: [`balance ${balance}${pin.denom}, this game's pool ${pool}${pin.denom}${balance >= pool ? "" : " -- the contract holds LESS than this one game's pool"}`] });
  }

  const rosterCheck = checks.find((check) => check.id === "C1")!;
  const bindingCheck = checks.find((check) => check.id === "C2")!;
  return {
    view,
    checks,
    roster: word(rosterCheck.status, "ROSTER", rosterCheck.details),
    binding: word(bindingCheck.status, "CHAIN BINDING", bindingCheck.details),
  };
}

/* ------------------------------------------------------------------ */
/* The exit code and the text form                                      */
/* ------------------------------------------------------------------ */

/** 0 only when every evaluated check passed and none was left unevaluated (N/A is not a finding). */
export const moneyEvidenceClean = (view: MoneyEvidenceView): boolean => view.summary.clean;

const STATUS_WORD: Readonly<Record<CheckStatus, string>> = Object.freeze({ pass: "PASS         ", fail: "FAIL         ", "not-evaluated": "NOT EVALUATED", "n/a": "N/A          " });

export function moneyEvidenceText(view: MoneyEvidenceView): string[] {
  const out: string[] = [];
  const d = view.deployment;
  out.push(`money evidence (READ-ONLY, ${view.source}) of ${view.game_id} -- ${view.format}, read ${iso(view.read_at)}`);
  out.push("  reads: each item strongly consistent, read one after another (not one snapshot): on a LIVE game re-run a transient MISMATCH / MISSING before acting on it");
  out.push(`  deployment: environment ${d.environment}${d.configuration_version !== null ? `, runtime configuration v${d.configuration_version}` : ""}${d.escrow_configuration_version !== null ? `, escrow configuration v${d.escrow_configuration_version}` : ""}; relayer ${d.relayer ?? "NONE"} (${d.relayer_detail})`);

  /* FIN */
  const f = view.fin;
  out.push("FIN");
  if (f.phase === null) out.push(`  ${f.read}`);
  else {
    out.push(`  phase ${f.phase}${f.dealt ? " (dealt)" : " (not dealt)"}, record_version ${f.record_version}, hold ${f.hold === null ? "none" : `HELD ${f.hold.code} (from ${f.hold.from}, ${iso(f.hold.at)}): ${f.hold.detail}`}`);
    out.push(`  continuation ${f.continuation === null ? "NONE (a placeholder)" : `rules ${f.continuation.rules_engine_version}, hosted ${f.continuation.hosted_protocol}, financial ${f.continuation.financial_protocol}, codec ${f.continuation.settlement_codec}`}; ${f.continued_here === null ? "" : f.continued_here.continues ? "continued by this build" : `NOT continued by this build (${f.continued_here.why})`}`);
    if (f.deployment === null) out.push("  deployment: NONE");
    else out.push(`  deployment ${f.deployment.backend} ${f.deployment.codec} chain ${f.deployment.chain_id} (${f.deployment.network_class}) contract ${f.deployment.contract_address} code ${f.deployment.code_checksum} denom ${f.deployment.denom}`);
    if (f.escrow === null) out.push("  chain game: NOT BOUND (the host's CreateGame is not bound yet)");
    else {
      out.push(`  chain_game_id ${f.escrow.chain_game_id}, bound ${iso(f.escrow.bound_at)}; instance ${f.escrow.instance}`);
      out.push(`  terms ante_gross ${f.escrow.terms.ante_gross} ante_net ${f.escrow.terms.ante_net} max_players ${f.escrow.terms.max_players} mode ${f.escrow.terms.mode === 0 ? "live" : "async"}; commitments rules ${f.escrow.commitments.rules_engine_version} variants ${f.escrow.commitments.variants_digest}`);
    }
    out.push(`  roster_epoch ${f.roster_epoch}; start: ${f.start_progress}`);
    if (f.roster !== null) {
      out.push(`  frozen_at       ${f.roster.frozen_at} (${iso(f.roster.frozen_at)})`);
      out.push(`  roster_hash     ${f.roster.roster_hash}`);
      out.push(`  expected_domain ${f.roster.expected_domain}`);
      for (const seat of f.roster.seats) out.push(`  seat ${seat.chain_seat_index}  ${seat.player_id}  wallet ${seat.payout_wallet}  ${seat.ticket}  consent ${seat.consent_public_key}`);
    }
    if (f.chain !== null) {
      out.push(`  chain.started   ${f.chain.started === null ? "-" : `height ${f.chain.started.height}, domain ${f.chain.started.domain}, at ${iso(f.chain.started.at)}`}`);
      out.push(`  checkpoint      prepared ${f.chain.checkpoint_prepared === null ? "-" : `seq ${f.chain.checkpoint_prepared.seq} (log ${f.chain.checkpoint_prepared.log_len})`}; confirmed ${f.chain.checkpoint_confirmed === null ? "-" : `seq ${f.chain.checkpoint_confirmed.seq} (log ${f.chain.checkpoint_confirmed.log_len})`}; settle ${f.chain.settle_confirmed === null ? "-" : `seq ${f.chain.settle_confirmed.seq}`}; outcome ${f.chain.outcome === null ? "-" : `${f.chain.outcome.state} (${f.chain.outcome.route})`}`);
    }
  }

  /* TICKETS */
  out.push(`TICKETS (JX-3B wallet grants): ledger ${view.tickets.read}${view.tickets.ledger_version !== null ? `, version ${view.tickets.ledger_version}` : ""}; frozen_at ${view.tickets.frozen_at === null ? "null" : `${view.tickets.frozen_at} (${iso(view.tickets.frozen_at)})`}`);
  if (view.tickets.grants === null) out.push(`  grants: ${view.tickets.grants_read}`);
  else for (const line of walletGrantsText(view.tickets.grants)) out.push(`  ${line}`);

  /* INTENTS */
  out.push(`CHAIN INTENTS (${view.intents.read}): ${view.intents.items.length}`);
  for (const intent of view.intents.items) {
    if (intent.read !== "read") {
      out.push(`  intent ${intent.intent_id}  ${intent.read}`);
      continue;
    }
    out.push(`  intent ${intent.intent_id}  ${intent.op}${intent.start_epoch !== null ? ` (start epoch ${intent.start_epoch})` : ""}  status ${intent.status}  record_version ${intent.record_version}  created ${intent.created_at} (${iso(intent.created_at)})  updated ${iso(intent.updated_at)}`);
    out.push(`      instance ${intent.instance}${intent.belongs === false ? "  -- NOT THIS GAME'S INSTANCE" : ""}`);
    out.push(`      key ${JSON.stringify(intent.key)}  subject ${JSON.stringify(intent.subject)}`);
    out.push(`      op ${JSON.stringify(intent.op_fields)}`);
    out.push(`      msg ${intent.msg_json}`);
    out.push(`      retry failures ${intent.retry?.failures ?? "-"}, next ${iso(intent.retry?.next_at)}; confirmation ${JSON.stringify(intent.confirmation)}; superseded ${JSON.stringify(intent.superseded)}; hold ${JSON.stringify(intent.hold)}`);
    out.push(`      relay queue: expected ${intent.relay.expected ?? "?"}, ${intent.relay.present === null ? "presence not evaluated" : intent.relay.present ? "PRESENT" : "absent"} -> ${intent.relay.verdict} (${intent.relay.detail}); key ${intent.relay.key ?? "none"}`);
    if (intent.attempts.length === 0) out.push("      attempts: none (nothing was ever signed for it)");
    for (const a of intent.attempts) {
      out.push(`      attempt ${a.n}  tx ${a.tx_hash}  phase ${a.phase}  -- ${a.failure_state}`);
      out.push(`          account ${a.account} account_number ${a.account_number} sequence ${a.sequence} gas_limit ${a.gas_limit} fee ${a.fee.amount}${a.fee.denom} timeout_height ${a.timeout_height}`);
      out.push(`          signed ${iso(a.signed_at)}; tx_bytes ${a.tx_bytes_length} B, SHA-256 ${a.tx_bytes_hash_ok ? "= tx hash" : "!= tx hash (DAMAGE)"}`);
      out.push(`          broadcast ${a.broadcast === null ? "never answered" : `code ${a.broadcast.code} codespace ${a.broadcast.codespace || "-"} at ${iso(a.broadcast.at)}${a.broadcast.log !== "" ? ` log ${JSON.stringify(a.broadcast.log.slice(0, 160))}` : ""}`} (${a.broadcasts} broadcast(s))`);
      out.push(`          inclusion ${a.inclusion === null ? "-" : `height ${a.inclusion.height} code ${a.inclusion.code} codespace ${a.inclusion.codespace || "-"}`}; resolved_height ${a.resolved_height ?? "-"}; death ${a.death === null ? "-" : JSON.stringify(a.death)}; error ${a.error === null ? "-" : `${a.error.code} (${a.error.retry}) ${a.error.native}`}; observed ${iso(a.observed_at)}, ${a.unknown_observations} undecided observation(s)`);
      out.push(`          journal: ATTI ${a.journal.atti.toUpperCase()}, TXID ${a.journal.txid.toUpperCase()}${a.journal.relayer_epoch !== null ? ` (relayer epoch ${a.journal.relayer_epoch}, generation ${a.journal.generation})` : ""}${a.journal.details.length > 0 ? ` -- ${a.journal.details.join("; ")}` : ""}`);
    }
  }

  /* RELAY QUEUE */
  const q = view.relay_queue;
  out.push(`RELAY QUEUE ${q.queue === null ? "(not read)" : `RELAYQ#${q.queue}`} (${q.read}, strongly consistent, every page): ${q.game_entries.length} entr${q.game_entries.length === 1 ? "y" : "ies"} of this game${q.total_entries !== null ? ` (of ${q.total_entries})` : ""}`);
  for (const entry of q.game_entries) out.push(`  ${String(entry.created_at).padStart(13, "0")}#${entry.game_id}#${entry.intent_id} -> ${entry.verdict}`);

  /* JOURNAL */
  out.push(`SIGNING JOURNAL (${view.journal.read}): ${view.journal.journal_only.length} journal-only attempt(s)`);
  for (const entry of view.journal.journal_only) out.push(`  JOURNAL-ONLY tx ${entry.tx_id} intent ${entry.intent_id} account ${entry.account} sequence ${entry.sequence} expiry ${entry.expires_after_height ?? "-"}: ${entry.why}`);

  /* CHAIN */
  if (view.chain !== null) {
    const c = view.chain;
    out.push(`CHAIN (--chain, read-only queries; ${c.read}${c.grade !== null ? `, ${c.grade}` : ""})`);
    if (c.config !== null) {
      out.push(`  chain ${c.chain_id} at height ${c.height ?? "?"} (${c.block_time ?? "?"}); contract ${c.contract} code ${c.code_checksum} (${c.config.contract_version})`);
      out.push(`  config operator ${c.config.operator} resolver ${c.config.resolver} admission ${c.config.admission_pubkey} denom ${c.config.denom} paused ${c.config.paused}`);
    }
    if (c.game !== null) {
      out.push(`  game ${c.game.chain_game_id ?? "?"} (${c.game.read}): state ${c.game.state ?? "?"} pool ${c.game.pool ?? "?"} resolver ${c.game.resolver ?? "-"}`);
      out.push(`  roster_hash          ${c.game.roster_hash ?? "null (not started)"}`);
      out.push(`  computed roster_hash ${c.game.computed_roster_hash ?? "-"}`);
      out.push(`  domain               ${c.game.domain ?? "null (not started)"}`);
      for (const seat of c.game.seats) out.push(`  chain seat ${seat.index}  wallet ${seat.wallet}  ${seat.ticket}  consent ${seat.consent_public_key}  deposit ${seat.gross_deposit} (net ${seat.net_deposit})`);
    }
    out.push(`  contract balance ${c.balance}`);
  }

  /* VERDICTS */
  out.push("VERDICTS");
  for (const check of view.checks) {
    out.push(`  ${STATUS_WORD[check.status]}  ${check.id.padEnd(3)} ${check.name}`);
    for (const detail of check.details) out.push(`                      ${detail}`);
  }
  out.push(view.verdicts.journal);
  if (view.verdicts.roster !== null) out.push(view.verdicts.roster);
  if (view.verdicts.chain_binding !== null) out.push(view.verdicts.chain_binding);
  const s = view.summary;
  out.push(s.clean ? `EVIDENCE CLEAN: ${s.pass} passed, ${s.not_applicable} not applicable` : `EVIDENCE FINDINGS: ${s.fail} failed, ${s.not_evaluated} not evaluated (${s.pass} passed, ${s.not_applicable} not applicable)`);
  return out;
}

/* ------------------------------------------------------------------ */
/* --tx-bytes: one attempt's exact durable TxRaw bytes                   */
/* ------------------------------------------------------------------ */

export interface TxBytesExport {
  readonly format: typeof TX_BYTES_EXPORT_FORMAT;
  readonly game_id: string;
  readonly intent_id: string;
  readonly op: string;
  readonly attempt: number;
  readonly of_attempts: number;
  /** How the attempt was chosen: `--attempt`, `--tx-hash`, `only attempt`, `the one included attempt`. */
  readonly chosen_by: string;
  readonly tx_hash: string;
  /** The stored base64 EXACTLY as the intent holds it (never decoded and re-encoded). */
  readonly tx_base64: string;
  readonly sha256_matches_tx_hash: boolean;
  readonly account: string;
  readonly account_number: string;
  readonly sequence: string;
  readonly gas_limit: string;
  readonly fee: { readonly amount: string; readonly denom: string };
  readonly timeout_height: string;
  readonly phase: string;
  readonly contract: string | null;
  readonly chain_id: string | null;
  /** The offline check, ready to run (`frontend/scripts/jx2VerifyTx.js`; the relayer's public key is the operator's input). */
  readonly verify_with: string;
}

export type TxBytesSelection = { readonly ok: true; readonly export: TxBytesExport } | { readonly ok: false; readonly reason: string };

/** Choose ONE attempt of ONE explicitly named intent. Ambiguity is refused: several attempts need `--attempt <n>` or
 *  `--tx-hash <HASH>`, unless exactly one of them was included on chain. Nothing is decoded or rebuilt. */
export function selectTxBytes(input: {
  readonly gameId: string;
  readonly intents: readonly IntentItemRead[];
  readonly intentId: string;
  readonly attempt?: number;
  readonly txHash?: string;
  readonly contract: string | null;
  readonly chainId: string | null;
}): TxBytesSelection {
  if (!/^[0-9a-f]{64}$/.test(input.intentId)) return { ok: false, reason: `--tx-bytes names an intent by its full id (64 lowercase hex), not ${JSON.stringify(input.intentId)}` };
  const item = input.intents.find((candidate) => candidate.intent_id === input.intentId);
  if (item === undefined) return { ok: false, reason: `game ${input.gameId} holds no intent ${input.intentId}` };
  if (item.intent.state !== "ok") return { ok: false, reason: `intent ${input.intentId} cannot be read (${factWord(item.intent)}); nothing is exported` };
  const intent = item.intent.value;
  const list = intent.attempts;
  const summary = list.map((a) => `attempt ${a.n} tx ${a.tx_hash} ${a.phase}`).join("; ");
  if (list.length === 0) return { ok: false, reason: `intent ${input.intentId} (${intent.op.kind}) has no attempt: nothing was ever signed for it` };
  let chosen: ChainAttempt | undefined;
  let how: string;
  if (input.attempt !== undefined && input.txHash !== undefined) return { ok: false, reason: "give --attempt or --tx-hash, not both" };
  if (input.attempt !== undefined) {
    chosen = list.find((a) => a.n === input.attempt);
    how = "--attempt";
    if (chosen === undefined) return { ok: false, reason: `intent ${input.intentId} has no attempt ${input.attempt} (${summary})` };
  } else if (input.txHash !== undefined) {
    chosen = list.find((a) => a.tx_hash === input.txHash!.toUpperCase());
    how = "--tx-hash";
    if (chosen === undefined) return { ok: false, reason: `intent ${input.intentId} has no attempt with tx ${input.txHash} (${summary})` };
  } else if (list.length === 1) {
    chosen = list[0];
    how = "only attempt";
  } else {
    const included = list.filter((a) => a.phase === "included-success" || a.phase === "included-failure");
    if (included.length !== 1) return { ok: false, reason: `intent ${input.intentId} has ${list.length} attempts and ${included.length === 0 ? "none" : included.length} was included -- AMBIGUOUS: name one with --attempt <n> or --tx-hash <HASH> (${summary})` };
    chosen = included[0];
    how = "the one included attempt";
  }
  let matches = false;
  try {
    matches = sha256Upper(Buffer.from(chosen.tx_bytes, "base64")) === chosen.tx_hash;
  } catch {
    matches = false;
  }
  const verify = [
    "node frontend/scripts/jx2VerifyTx.js --tx-file <the base64 saved to a file>",
    input.chainId !== null ? `--chain-id ${input.chainId}` : "--chain-id <chain id>",
    `--account-number ${chosen.account_number}`,
    "--pubkey <the relayer's compressed public key: awsDeploy signer-keys>",
    `--hash ${chosen.tx_hash}`,
    ...(input.contract !== null ? [`--contract ${input.contract}`] : []),
    `--sequence ${chosen.sequence}`,
    `--fee ${chosen.fee.amount}`,
    `--denom ${chosen.fee.denom}`,
    `--gas-limit ${chosen.gas_limit}`,
  ].join(" ");
  return {
    ok: true,
    export: {
      format: TX_BYTES_EXPORT_FORMAT,
      game_id: input.gameId,
      intent_id: intent.intent_id,
      op: intent.op.kind,
      attempt: chosen.n,
      of_attempts: list.length,
      chosen_by: how,
      tx_hash: chosen.tx_hash,
      tx_base64: chosen.tx_bytes,
      sha256_matches_tx_hash: matches,
      account: chosen.account,
      account_number: chosen.account_number,
      sequence: chosen.sequence,
      gas_limit: chosen.gas_limit,
      fee: { amount: chosen.fee.amount, denom: chosen.fee.denom },
      timeout_height: chosen.timeout_height,
      phase: chosen.phase,
      contract: input.contract,
      chain_id: input.chainId,
      verify_with: verify,
    },
  };
}

