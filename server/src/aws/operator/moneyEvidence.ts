// server/src/aws/operator/moneyEvidence.ts
//
// ==================================================================
//  JX-4B: `gamesDoctor aws money <game_id>` -- ONE MONEY GAME'S EVIDENCE OVER DYNAMODB (AND, WITH --chain, JUNO), READ-ONLY
// ==================================================================
//
// The readers behind `tools/moneyEvidence.ts` (which judges and prints). Every read here is a READ, through the
// production parser of the item it reads -- never a second parser, never a writer:
//
//   GAME#<g> / FIN                 the L5-2 financial store's own `load` (its parser; a read-only fence it never writes with)
//   GAME#<g> / META                the L5-2 record store's own `load`
//   GAME#<g> / TICKETS + identity  JX-3B: `readTicketLedger` (the ledger's own file parser) and `collectWalletGrants` with
//                                  `readIdentitySlice` (only the principal / profile / family items the grants name)
//   GAME#<g> / INTENT#...          one strongly consistent Query of the game's intent items, each parsed by the intent
//                                  store's own `parseChainIntentItem` (an unreadable item is LISTED, never skipped)
//   RELAYQ#<relayer>               the configured relayer's queue, every page, strongly consistent, each entry parsed by
//                                  the store's own strict `parseRelayQueueItem` (one damaged entry refuses the queue);
//                                  an intent made in another relayer's queue is checked by one GetItem of its own key
//   ATTI#<intent>, TXID#<tx>       the signing ledger's own strict parser (`readLedgerAttemptsOfIntent` /
//                                  `readLedgerAttemptByTx`) -- the ledger account's table, read with GetItem / Query only
//   --chain                        the configured REST endpoints (the escrow configuration's), through `JunoRest`'s
//                                  READ methods only (a narrowed port: no simulate, no broadcast is reachable): latest
//                                  block, the contract's code checksum and config (verification grade when the
//                                  transport offers it), the chain game, the contract's bank balance
//
// Nothing here writes, claims, signs (no KMS call of any kind), simulates or broadcasts. A read that fails is a FACT of
// its own ("unavailable"), never an empty answer: the judge then says NOT EVALUATED. No ARN, table name or endpoint URL
// is put in the view (the deployment is named by environment and configuration versions).

import { escrowInstanceKey, intentIdOf } from "../../../../frontend/src/gameEngine/escrow/escrowModel";
import { ChainIntentUnreadableError, RelayQueueDamageError, startInstanceOf, type RelayQueueEntry } from "../../escrow/chainIntents";
import { FinancialRecordUnreadableError } from "../../escrow/financialGameStore";
import { parseConfigResponse, parseGameResponse, QUERY, type JunoGameResponse } from "../../escrow/juno/junoContract";
import type { JunoRest } from "../../escrow/juno/junoRest";
import { WalletTicketStoreUnreadableError } from "../../escrow/walletTicketFileStore";
import type { FinancialGameRecord } from "../../escrow/moneyLifecycle";
import { StoreCorruptError, StoreIncompatibleError } from "../../persistence/storeResult";
import { GAME_ID_PATTERN } from "../../rooms/gameRecord";
import { collectWalletGrants } from "../../tools/walletGrants";
import { buildMoneyEvidence, selectTxBytes, type ChainEvidenceRead, type ChainExpectation, type Fact, type IntentItemRead, type JournalAttemptFact, type MoneyEvidenceView, type TxBytesSelection } from "../../tools/moneyEvidence";
import { createDynamoFinancialStore } from "../game/dynamoFinancialStore";
import { parseChainIntentItem, parseRelayQueueItem, relayKeyOfIntentItem } from "../game/dynamoIntentStore";
import { createDynamoRecordStore } from "../game/dynamoRecordStore";
import { gamePk, getItem, INTENT_PREFIX, key, queryAll } from "../game/gameTable";
import { LedgerUnreadableError, readLedgerAttemptByTx, readLedgerAttemptsOfIntent, type LedgerAttemptRecord } from "../ledger/dynamoSigningLedger";
import { ItemUnreadableError, readIdentitySlice, readTicketLedger } from "./inspect";
import type { OperatorTarget } from "./operatorTarget";

/** The L5-2 stores are used for `load` only, under a fence no task ever holds (as `inspect.ts`). */
const READ_ONLY_FENCE = Object.freeze({ pool: "op:read-only-inspection", epoch: 1 });

/** JX-4B: the chain READS this tool may make -- a narrowed `JunoRest` (no simulate, no broadcast, no tx lookup). */
export type ChainReadPort = Pick<JunoRest, "chainId" | "latestBlock" | "contract" | "codeChecksum" | "smartAt"> & Partial<Pick<JunoRest, "verifiedContractFacts" | "bankBalance">>;

/** Narrow any `JunoRest` to the read port (the object handed on carries no other method). */
export function chainReadPort(rest: ChainReadPort): ChainReadPort {
  return Object.freeze({
    chainId: rest.chainId,
    latestBlock: () => rest.latestBlock(),
    contract: (address: string) => rest.contract(address),
    codeChecksum: (codeId: string) => rest.codeChecksum(codeId),
    smartAt: (contract: string, query: string) => rest.smartAt(contract, query),
    ...(rest.verifiedContractFacts !== undefined ? { verifiedContractFacts: (contract: string, query: string) => rest.verifiedContractFacts!(contract, query) } : {}),
    ...(rest.bankBalance !== undefined ? { bankBalance: (address: string, denom: string) => rest.bankBalance!(address, denom) } : {}),
  });
}

/**
 * No AWS identifier or endpoint in anything this tool prints: an SDK error's message can quote the caller's role ARN and
 * the resource's table ARN ("User: arn:aws:sts::... is not authorized to perform: dynamodb:Query on resource:
 * arn:aws:dynamodb:...:table/<name>"), and a transport error can quote a URL (a provider key can sit in its path). Every
 * ARN, URL and this deployment's table names are replaced by a placeholder before a detail is kept.
 */
export function scrubOperatorText(text: string, target?: Pick<OperatorTarget, "tables"> | null): string {
  let out = text.replace(/arn:aws[a-z-]*:[^\s"',;)\]]*/gi, "<arn>").replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"',;)\]]+/gi, "<endpoint>");
  if (target !== undefined && target !== null) {
    for (const name of [target.tables.game, target.tables.identity, target.tables.ledger, target.tables.ledger.replace(/^.*:table\//, "")]) {
      if (name.length >= 3) out = out.split(name).join("<table>");
    }
  }
  return out;
}

let scrubTarget: Pick<OperatorTarget, "tables"> | null = null;
const describe = (error: unknown): string => scrubOperatorText((error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/\s+/g, " "), scrubTarget).slice(0, 300);

const UNREADABLE = [ItemUnreadableError, LedgerUnreadableError, ChainIntentUnreadableError, RelayQueueDamageError, WalletTicketStoreUnreadableError, FinancialRecordUnreadableError, StoreCorruptError, StoreIncompatibleError];

/** One read, as one of the four facts (absent / ok / unreadable: the item exists and cannot be read / unavailable: the
 *  read itself failed). */
async function factOf<T>(read: () => Promise<T | null>): Promise<Fact<T>> {
  try {
    const value = await read();
    return value === null ? { state: "absent" } : { state: "ok", value };
  } catch (error) {
    if (UNREADABLE.some((kind) => error instanceof kind)) return { state: "unreadable", detail: describe(error) };
    return { state: "unavailable", detail: describe(error) };
  }
}

const journalFact = (record: LedgerAttemptRecord): JournalAttemptFact => ({
  intent_id: record.intent_id,
  tx_id: record.tx_id,
  account: record.account,
  sequence: record.sequence,
  expires_after_height: record.expires_after_height,
  relayer_epoch: record.relayer_epoch,
  generation: record.generation,
});

/** Every `INTENT#` item of the game, each through the intent store's own parser; an unreadable one is listed. */
export async function readGameIntents(target: OperatorTarget, gameId: string): Promise<IntentItemRead[]> {
  const items = await queryAll(target.app, target.tables.game, gamePk(gameId), { prefix: INTENT_PREFIX });
  return items
    .map((item): IntentItemRead => {
      const intentId = (item.sk?.S ?? "").slice(INTENT_PREFIX.length);
      if (!/^[0-9a-f]{64}$/.test(intentId)) return { intent_id: intentId, intent: { state: "unreadable", detail: "the item's key names no intent" }, relay_key: null };
      try {
        return { intent_id: intentId, intent: { state: "ok", value: parseChainIntentItem(gameId, intentId, item) }, relay_key: relayKeyOfIntentItem(item) };
      } catch (error) {
        return { intent_id: intentId, intent: { state: "unreadable", detail: describe(error) }, relay_key: relayKeyOfIntentItem(item) };
      }
    })
    .sort((a, b) => {
      const ca = a.intent.state === "ok" ? a.intent.value.created_at : Number.MAX_SAFE_INTEGER;
      const cb = b.intent.state === "ok" ? b.intent.value.created_at : Number.MAX_SAFE_INTEGER;
      return ca - cb || a.intent_id.localeCompare(b.intent_id);
    });
}

/** The relay queue `RELAYQ#<queue>`: every entry (strict, strongly consistent, every page). */
export async function readRelayQueue(target: OperatorTarget, queue: string): Promise<RelayQueueEntry[]> {
  return (await queryAll(target.app, target.tables.game, `RELAYQ#${queue}`)).map((item) => parseRelayQueueItem(queue, item));
}

/** The chain's answers (read-only), or why not. */
export async function readChainEvidence(rest: ChainReadPort, fin: FinancialGameRecord): Promise<Fact<ChainEvidenceRead>> {
  const pin = fin.binding?.deployment ?? null;
  const escrow = fin.binding?.escrow ?? null;
  if (pin === null) return { state: "not-read", detail: "FIN carries no deployment pin: nothing to read on chain" };
  if (pin.backend !== "juno-cosmwasm") return { state: "not-read", detail: `a ${pin.backend} deployment is not read by the Juno transport` };
  if (rest.chainId !== pin.chain_id) return { state: "not-read", detail: `the configured transport serves chain ${rest.chainId}; FIN is bound to ${pin.chain_id} (no chain read is made for another chain)` };
  try {
    const block = await rest.latestBlock();
    if (block.chain_id !== pin.chain_id) return { state: "unavailable", detail: `the node answered for chain ${block.chain_id}` };
    let grade: ChainEvidenceRead["grade"];
    let codeChecksum: string;
    let rawConfig: unknown;
    let codeId: string | null = null;
    let admin: string | null = null;
    const info = await rest.contract(pin.contract_address).catch(() => null);
    if (info !== null) {
      codeId = info.code_id;
      admin = info.admin;
    }
    if (rest.verifiedContractFacts !== undefined) {
      const facts = await rest.verifiedContractFacts(pin.contract_address, QUERY.config());
      grade = "verified";
      codeChecksum = facts.code_checksum;
      rawConfig = facts.config;
    } else {
      if (info === null) return { state: "unavailable", detail: `the contract ${pin.contract_address} could not be described` };
      grade = "single-endpoint";
      codeChecksum = await rest.codeChecksum(info.code_id);
      rawConfig = (await rest.smartAt(pin.contract_address, QUERY.config())).data;
    }
    const config = parseConfigResponse(rawConfig);
    let game: Fact<JunoGameResponse> = { state: "not-read", detail: "FIN binds no chain game yet" };
    let gameHeight: string | null = null;
    if (escrow !== null) {
      try {
        const answer = await rest.smartAt(pin.contract_address, QUERY.game(escrow.chain_game_id));
        gameHeight = answer.height;
        game = { state: "ok", value: parseGameResponse(answer.data) };
      } catch (error) {
        const text = describe(error);
        game = /not ?found/i.test(text) ? { state: "absent" } : { state: "unavailable", detail: text };
      }
    }
    let balance: ChainEvidenceRead["balance"];
    if (rest.bankBalance === undefined) balance = { state: "not-read", detail: "this chain transport offers no bank read" };
    else {
      try {
        const answer = await rest.bankBalance(pin.contract_address, pin.denom);
        balance = { state: "ok", value: { amount: answer.amount, denom: pin.denom, height: answer.height } };
      } catch (error) {
        balance = { state: "unavailable", detail: describe(error) };
      }
    }
    return {
      state: "ok",
      value: { grade, chain_id: block.chain_id, contract: pin.contract_address, height: block.height, block_time: block.time, code_id: codeId, code_checksum: codeChecksum, wasm_admin: admin, config, game, game_height: gameHeight, balance },
    };
  } catch (error) {
    /* A chain read that fails is not a write and changes nothing: the comparison is NOT EVALUATED. */
    return { state: "unavailable", detail: describe(error) };
  }
}

export interface AwsMoneyEvidenceOptions {
  readonly now: number;
  /** `--chain`: the read port and what this deployment's configuration expects (null: not asked); `unavailable`: asked,
   *  but no chain transport could be made (the reason). */
  readonly chain: { readonly port: ChainReadPort; readonly expect: ChainExpectation | null } | { readonly unavailable: string } | null;
}

/** One money game's evidence over DynamoDB (and, with `--chain`, Juno). Reads only. */
export async function awsMoneyEvidence(target: OperatorTarget, gameId: string, options: AwsMoneyEvidenceOptions): Promise<MoneyEvidenceView> {
  if (!GAME_ID_PATTERN.test(gameId)) throw new Error(`${JSON.stringify(gameId)} is not a game id`);
  scrubTarget = target;
  const base = { client: target.app, table: target.tables.game, fence: READ_ONLY_FENCE };
  const fin = await factOf(() => createDynamoFinancialStore(base).load(gameId));
  const record = await factOf(() => createDynamoRecordStore(base).load(gameId));
  const tickets = await factOf(async () => readTicketLedger(target, gameId));
  /* JX-3B's view over the same items (its own reads: the ledger, the record and identity's slice). */
  const grants = await factOf(async () =>
    collectWalletGrants({
      gameId,
      source: "aws",
      loadLedger: () => readTicketLedger(target, gameId),
      loadIdentity: (contexts) => readIdentitySlice(target, contexts),
      loadRecord: () => createDynamoRecordStore(base).load(gameId),
      now: options.now,
    }),
  );
  const intents = await factOf(async () => readGameIntents(target, gameId));
  const relayer = target.escrow.state === "ok" ? target.escrow.relayer : null;
  const queue: Fact<{ readonly queue: string; readonly entries: readonly RelayQueueEntry[] }> =
    relayer === null
      ? { state: "not-read", detail: target.escrow.state === "none" ? "no escrow is configured (no relayer, no queue)" : target.escrow.state === "not-read" ? "DynamoDB Local: name the relayer with --relayer to read its queue" : "the escrow configuration is not usable (`gamesDoctor aws status` says why)" }
      : await factOf(async () => ({ queue: relayer, entries: await readRelayQueue(target, relayer) }));
  /* An intent made in another relayer's queue: its own key, one GetItem. */
  const foreignQueue = new Map<string, Fact<boolean>>();
  if (intents.state === "ok" && relayer !== null) {
    for (const item of intents.value) {
      if (item.relay_key === null || item.relay_key.pk === `RELAYQ#${relayer}`) continue;
      const relayKey = item.relay_key;
      foreignQueue.set(item.intent_id, await factOf(async () => (await getItem(target.app, target.tables.game, key(relayKey.pk, relayKey.sk))) !== null));
    }
  }
  /* The ledger: ATTI# of every intent, TXID# of every stored attempt and every journalled one. */
  const byIntent = new Map<string, Fact<readonly JournalAttemptFact[]>>();
  const byTx = new Map<string, Fact<JournalAttemptFact>>();
  if (intents.state === "ok") {
    const txs = new Set<string>();
    for (const item of intents.value) {
      if (!/^[0-9a-f]{64}$/.test(item.intent_id)) continue;
      const fact = await factOf(async () => (await readLedgerAttemptsOfIntent(target.ledger, target.tables.ledger, item.intent_id)).map(journalFact));
      byIntent.set(item.intent_id, fact);
      if (fact.state === "ok") for (const entry of fact.value) txs.add(entry.tx_id);
      if (item.intent.state === "ok") for (const attempt of item.intent.value.attempts) txs.add(attempt.tx_hash);
    }
    /* Review: a journalled attempt for an intent the table does NOT hold (a table restored behind the ledger) is invisible
       to a per-intent read of the intents it holds. Every Start slot of this game -- epochs 1 .. roster_epoch + 1, the
       ones `escrowService` itself probes -- is read too. */
    const escrow = fin.state === "ok" ? fin.value.binding?.escrow ?? null : null;
    if (escrow !== null && fin.state === "ok") {
      const instance = escrowInstanceKey(escrow);
      for (let epoch = 1; epoch <= fin.value.roster_epoch + 1 && epoch <= 64; epoch += 1) {
        const intentId = intentIdOf(startInstanceOf(instance, epoch), { op: "start" });
        if (byIntent.has(intentId) || intents.value.some((item) => item.intent_id === intentId)) continue;
        const fact = await factOf(async () => (await readLedgerAttemptsOfIntent(target.ledger, target.tables.ledger, intentId)).map(journalFact));
        /* Only a slot that holds something (or could not be read) is evidence. */
        if (fact.state !== "ok" || fact.value.length > 0) byIntent.set(intentId, fact);
        if (fact.state === "ok") for (const entry of fact.value) txs.add(entry.tx_id);
      }
    }
    for (const tx of [...txs].sort()) {
      if (!/^[0-9A-F]{64}$/.test(tx)) continue;
      byTx.set(tx, await factOf(async () => {
        const stored = await readLedgerAttemptByTx(target.ledger, target.tables.ledger, tx);
        return stored === null ? null : journalFact(stored);
      }));
    }
  }
  const journal = intents.state === "ok" ? { byIntent, byTx } : { notRead: "the intents could not be read" };
  /* --chain */
  let chain: Parameters<typeof buildMoneyEvidence>[0]["chain"] = null;
  if (options.chain !== null) {
    if ("unavailable" in options.chain) chain = { expect: null, read: { state: "not-read", detail: options.chain.unavailable } };
    else if (fin.state !== "ok") chain = { expect: options.chain.expect, read: { state: "not-read", detail: `no financial record was read (${fin.state}): the deployment to read is not known` } };
    else chain = { expect: options.chain.expect, read: await readChainEvidence(options.chain.port, fin.value) };
  }
  return buildMoneyEvidence({
    gameId,
    source: "aws",
    now: options.now,
    deployment: {
      environment: target.config.environment,
      configuration_version: target.source.version,
      escrow_configuration_version: target.escrow.state === "ok" ? target.escrow.version : null,
      relayer,
      relayer_detail: target.escrow.state === "ok" ? "the escrow configuration's relayer account" : target.escrow.state === "none" ? "no escrow configured" : target.escrow.state === "not-read" ? "not read on DynamoDB Local (--relayer names it)" : "the escrow configuration is not usable",
    },
    fin,
    record,
    tickets,
    grants,
    intents,
    queue,
    foreignQueue,
    journal,
    chain,
  });
}

/** `--tx-bytes <intent_id>`: one attempt's exact stored TxRaw base64 (the intent item only, plus FIN for the contract
 *  and chain the verifier needs). Reads only; never decoded and re-encoded, never sent anywhere. */
export async function awsTxBytes(target: OperatorTarget, gameId: string, intentId: string, selector: { readonly attempt?: number; readonly txHash?: string }): Promise<TxBytesSelection> {
  if (!GAME_ID_PATTERN.test(gameId)) throw new Error(`${JSON.stringify(gameId)} is not a game id`);
  const intents = await readGameIntents(target, gameId);
  const fin = await factOf(() => createDynamoFinancialStore({ client: target.app, table: target.tables.game, fence: READ_ONLY_FENCE }).load(gameId));
  const pin = fin.state === "ok" ? fin.value.binding?.deployment ?? null : null;
  return selectTxBytes({ gameId, intents, intentId, ...selector, contract: pin?.contract_address ?? null, chainId: pin?.chain_id ?? null });
}
