// server/src/aws/operator/jx4bMoneyEvidence.test.ts
//
// ==================================================================
//  JX-4B: `gamesDoctor aws money` -- ONE MONEY GAME'S EVIDENCE OVER DYNAMODB AND (WITH --chain) JUNO, READS ONLY
// ==================================================================
//
// A real money world (production identity, the real escrow service, relayer and ticket ledger over the offline Juno --
// `escrow/jx4bSupport.ts`) is driven to each state of a live JX-4 run; its durable state is then served to the tool by a
// FAKE DynamoDB client exactly as the L5-2 stores and the L5-5 ledger store it (FIN, META, TICKETS, INTENT# with its queue
// key, RELAYQ#, identity, ATTI# / TXID# / ATTEMPT#), and the chain by the offline chain behind a read-only port. No network.
//
//   A healthy pre-Start game           B frozen roster + pending Start     C confirmed Start
//   D Start with several attempts       E journal mismatch                  F queue mismatch
//   G missing ticket data               H missing identity (standing)       I a terminal intent still queued
//   J --tx-bytes: the exact stored bytes  K --tx-bytes: ambiguity refused   L --chain: success
//   M --chain: mismatches               N read failures                     O --apply (and every mutation mode) refused
//   P redaction: nothing private, no ARN, no table, no endpoint
//
// Pinned throughout: only GetItem and Query are ever sent (no Scan, no write); no chain method beyond reads is reachable.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { quietConsole } from "../../rooms/testSupport";
import { JX4B_RESOLVER, moneyEvidenceWorld, type EvidenceWorld } from "../../escrow/jx4bSupport";
import { ADMISSION_PUBKEY, CANONICAL_CHECKSUM, CHAIN_ID, CONTRACT, GAME_B, RELAYER_ADDRESS, SETTLEMENT_SECRET, T0 } from "../../escrow/escrow3bSupport";
import { TERMINAL_INTENT_STATUSES, type ChainIntentRecord } from "../../escrow/chainIntents";
import { parseGameResponse, QUERY } from "../../escrow/juno/junoContract";
import { createJunoRest, JunoRpcError, type HttpRequest, type JunoRest } from "../../escrow/juno/junoRest";
import { publicKeyOf } from "../../escrow/juno/secp256k1";
import { WALLET_TICKET_FILE_FORMAT } from "../../escrow/walletTicketFileStore";
import { FIN_SK, gamePk, intentSk, key, META_SK, N, relayQueueKey, S, TICKETS_SK, type Item } from "../game/gameTable";
import { familyItem, principalItem, profileItem } from "../identity/identityItems";
import { LEDGER_KEYS } from "../ledger/dynamoSigningLedger";
import { EXIT, runAwsOperator } from "./operatorMain";
import { chainReadPort } from "./moneyEvidence";
import type { MoneyEvidenceView, TxBytesExport } from "../../tools/moneyEvidence";

quietConsole();

const RUNTIME_ARN = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1";
const ESCROW_ARN = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/juno-backend";
const LEDGER_ARN = "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger";
const GAME_TABLE = "gs-staging-game-g1";
const IDENTITY_TABLE = "gs-staging-identity";
const SECRET_ENDPOINT = "https://juno-testnet-rest.example.net/secret-path-token-do-not-print";
const DOC = { format: "18COSMOS/AWS-RUNTIME/v1", environment: "staging", region: "us-east-1", pool: "p1", generation: 1, game_table: GAME_TABLE, identity_table: IDENTITY_TABLE, ledger_table_arn: LEDGER_ARN, escrow: { config_parameter_arn: ESCROW_ARN } };
const kms = (n: string) => `arn:aws:kms:us-east-1:222222222222:key/${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
/** A production escrow configuration (v3, KMS keys, the ledger journal) naming the offline chain's deployment. */
const ESCROW_DOC = {
  format: "18COSMOS/JUNO-BACKEND/v3",
  chain_id: CHAIN_ID,
  network_class: "testnet",
  rest_endpoints: [SECRET_ENDPOINT],
  contract_address: CONTRACT,
  code_checksum: CANONICAL_CHECKSUM,
  wasm_admin: null,
  denom: "ujunox",
  asset_symbol: "JUNOX",
  relayer: { address: RELAYER_ADDRESS, signer: { kind: "kms", key_ref: kms("1") } },
  settlement_key: { signer_key_id: 1, public_key_hex: publicKeyOf(SETTLEMENT_SECRET).toString("hex"), signer: { kind: "kms", key_ref: kms("2") } },
  admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "kms", key_ref: kms("3") }, ttl_secs: 600 },
  trust: { operators: [RELAYER_ADDRESS], resolvers: [JX4B_RESOLVER], min_challenge_window_secs: "1", min_liveness_window_secs: "1", min_resolver_timeout_secs: "1" },
  journal: { kind: "dynamodb", table_arn: LEDGER_ARN },
  timeout_blocks: 60,
};

const TERMINAL = new Set<string>(TERMINAL_INTENT_STATUSES);
const WRITE_COMMANDS = ["PutItemCommand", "UpdateItemCommand", "DeleteItemCommand", "TransactWriteItemsCommand", "BatchWriteItemCommand", "ScanCommand"];

/* ------------------------------------------------------------------ */
/* The world's durable state, as DynamoDB holds it                       */
/* ------------------------------------------------------------------ */

interface Tables {
  game: Item[];
  identity: Item[];
  ledger: Item[];
}

const queueKeyOf = (gameId: string, intent: ChainIntentRecord) => relayQueueKey(RELAYER_ADDRESS, intent.created_at, gameId, intent.intent_id);
const queueItem = (gameId: string, intent: ChainIntentRecord): Item => ({ ...queueKeyOf(gameId, intent), game_id: S(gameId), intent_id: S(intent.intent_id), created_at: N(intent.created_at) });

/** The ledger's three items of one attempt, exactly as `recordAttempt` writes them. */
function ledgerItems(entry: { intent_id: string; tx_id: string; account: string; sequence: string; expires_after_height?: string }): Item[] {
  const attributes = (k: { pk: { S: string }; sk: { S: string } }): Item => ({
    pk: k.pk,
    sk: k.sk,
    schema: N(1),
    kind: S("attempt"),
    intent_id: S(entry.intent_id),
    tx_id: S(entry.tx_id),
    account: S(entry.account),
    sequence: S(entry.sequence),
    ...(entry.expires_after_height !== undefined ? { expires_after_height: S(entry.expires_after_height) } : {}),
    at: N(T0),
    generation: N(1),
    relayer_epoch: N(1),
    token: S("tok-jx4b"),
  });
  return [LEDGER_KEYS.txid(entry.tx_id), LEDGER_KEYS.attempt(entry.account, entry.sequence, entry.tx_id), LEDGER_KEYS.atti(entry.intent_id, entry.sequence, entry.tx_id)].map((k) => attributes(k as never));
}

async function project(e: EvidenceWorld): Promise<Tables> {
  const g = e.gameId;
  const fin = (await e.world.financial.load(g))!;
  const record = e.world.server.rooms.moneyPort.recordOf(g)!;
  const { version, document } = await e.world.ticketStore.load(g);
  const game: Item[] = [
    { ...key(gamePk(g), FIN_SK), body: S(JSON.stringify(fin)), record_version: N(fin.record_version) },
    { ...key(gamePk(g), META_SK), body: S(JSON.stringify(record)), record_version: N(record.record_version) },
    { ...key(gamePk(g), TICKETS_SK), body: S(JSON.stringify({ format: WALLET_TICKET_FILE_FORMAT, version, game_id: g, document })), version: N(version) },
  ];
  for (const intent of await e.world.intents.listGame(g)) {
    const q = queueKeyOf(g, intent);
    game.push({ ...key(gamePk(g), intentSk(intent.intent_id)), body: S(JSON.stringify(intent)), record_version: N(intent.record_version), relay_pk: q.pk, relay_sk: q.sk });
    if (!TERMINAL.has(intent.status)) game.push(queueItem(g, intent));
  }
  /* Another game's queue entry (the queue is shared): never this game's evidence. */
  game.push({ ...relayQueueKey(RELAYER_ADDRESS, T0, GAME_B, "f".repeat(64)), game_id: S(GAME_B), intent_id: S("f".repeat(64)), created_at: N(T0) });
  const snapshot = e.world.identityStore.snapshot();
  const identity = [...snapshot.principals.map(principalItem), ...snapshot.profiles.map(profileItem), ...snapshot.families.map(familyItem)];
  const ledger = (await e.world.journal.allAttempts()).flatMap((entry) => ledgerItems(entry));
  return { game, identity, ledger };
}

/* ------------------------------------------------------------------ */
/* A fake DynamoDB: GetItem and Query (paged) only                       */
/* ------------------------------------------------------------------ */

type Fault = (table: string, command: string, pk: string, sk: string | null) => Error | null;
const denied = (what: string) => Object.assign(new Error(`User is not authorized to perform: ${what}`), { name: "AccessDeniedException" });

function fakeDynamo(tables: Tables, fault: Fault = () => null, pageSize = 2) {
  const sent: string[] = [];
  const byTable: Record<string, Item[]> = { [GAME_TABLE]: tables.game, [IDENTITY_TABLE]: tables.identity, [LEDGER_ARN]: tables.ledger };
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name;
      const table = command.input.TableName as string;
      sent.push(`${name} ${table}`);
      const items = byTable[table] ?? [];
      if (name === "GetItemCommand") {
        const wanted = command.input.Key as Record<string, { S: string }>;
        const error = fault(table, name, wanted.pk.S, wanted.sk.S);
        if (error !== null) throw error;
        const item = items.find((candidate) => candidate.pk.S === wanted.pk.S && candidate.sk.S === wanted.sk.S);
        return item === undefined ? {} : { Item: item };
      }
      if (name === "QueryCommand") {
        const values = command.input.ExpressionAttributeValues as Record<string, { S: string }>;
        const pk = values[":pk"].S;
        const error = fault(table, name, pk, null);
        if (error !== null) throw error;
        const prefix = values[":prefix"]?.S ?? "";
        const rows = items.filter((item) => item.pk.S === pk && (item.sk.S as string).startsWith(prefix)).sort((a, b) => ((a.sk.S as string) < (b.sk.S as string) ? -1 : 1));
        const start = command.input.ExclusiveStartKey as Record<string, { S: string }> | undefined;
        const from = start === undefined ? 0 : rows.findIndex((item) => item.sk.S === start.sk.S) + 1;
        const page = rows.slice(from, from + pageSize);
        const more = from + pageSize < rows.length;
        return { Items: page, ...(more ? { LastEvaluatedKey: { pk: page[page.length - 1].pk, sk: page[page.length - 1].sk } } : {}) };
      }
      throw new Error(`a read-only view sent ${name}`);
    },
    destroy() {
      /* nothing */
    },
  };
  return { client: client as unknown as DynamoDBClient, sent };
}

/* ------------------------------------------------------------------ */
/* The offline chain, behind a read port (with a bank read)               */
/* ------------------------------------------------------------------ */

function chainOf(e: EvidenceWorld, over: Partial<JunoRest> = {}) {
  const chain = e.world.chain;
  const forbidden: string[] = [];
  const no = (what: string) => async () => {
    forbidden.push(what);
    throw new Error(`${what} is not a read`);
  };
  const rest = {
    chainId: chain.chainId,
    latestBlock: () => chain.latestBlock(),
    contract: (address: string) => chain.contract(address),
    codeChecksum: (codeId: string) => chain.codeChecksum(codeId),
    smartAt: (contract: string, query: string) => chain.smartAt(contract, query),
    verifiedContractFacts: (contract: string, query: string) => chain.verifiedContractFacts(contract, query),
    /* The contract's bank balance: every pool it still holds. */
    async bankBalance(address: string, denom: string) {
      if (address !== CONTRACT || denom !== "ujunox") return { amount: "0", height: String(chain.height) };
      let total = BigInt(0);
      for (const id of chain.games.keys()) {
        const game = parseGameResponse(await chain.smart(CONTRACT, QUERY.game(String(id)))).game;
        if (!["SETTLED", "CANCELLED", "ANNULLED"].includes(game.state)) total += BigInt(game.pool);
      }
      return { amount: total.toString(), height: String(chain.height) };
    },
    simulate: no("simulate"),
    broadcast: no("broadcast"),
    tx: no("tx"),
    txsBySequence: no("txsBySequence"),
    account: no("account"),
    ...over,
  };
  return { rest: rest as unknown as JunoRest, forbidden };
}

/* ------------------------------------------------------------------ */
/* Running the CLI                                                       */
/* ------------------------------------------------------------------ */

async function run(e: EvidenceWorld, tables: Tables, extra: string[] = [], options: { fault?: Fault; chain?: JunoRest } = {}) {
  const dynamo = fakeDynamo(tables, options.fault);
  const reads: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAwsOperator(["money", e.gameId, "--aws-config", RUNTIME_ARN, ...extra], {}, { out: (line) => out.push(line), err: (line) => err.push(line) }, {
    parameters: {
      read: async (arn: string) => {
        reads.push(arn);
        return { value: JSON.stringify(arn === RUNTIME_ARN ? DOC : ESCROW_DOC), version: 3, arn };
      },
    },
    clientFor: () => dynamo.client,
    now: () => e.world.clock.now,
    ...(options.chain !== undefined ? { chainRest: () => options.chain! } : {}),
  });
  assert.equal(dynamo.sent.filter((line) => WRITE_COMMANDS.some((name) => line.startsWith(name))).length, 0, `reads only: ${dynamo.sent.join(", ")}`);
  assert.ok(dynamo.sent.every((line) => line.startsWith("GetItemCommand ") || line.startsWith("QueryCommand ")), `GetItem / Query only: ${dynamo.sent.join(", ")}`);
  return { code, out, err, text: out.join("\n"), sent: dynamo.sent, reads };
}

async function view(e: EvidenceWorld, tables: Tables, extra: string[] = [], options: { fault?: Fault; chain?: JunoRest } = {}) {
  const answered = await run(e, tables, ["--json", ...extra], options);
  return { ...answered, view: JSON.parse(answered.text) as MoneyEvidenceView };
}

const check = (v: MoneyEvidenceView, id: string) => {
  const found = v.checks.find((c) => c.id === id);
  assert.ok(found !== undefined, `check ${id} is reported`);
  return found;
};
const without = (tables: Tables, drop: (item: Item) => boolean): Tables => ({ game: tables.game.filter((item) => !drop(item)), identity: tables.identity, ledger: tables.ledger.filter((item) => !drop(item)) });
const replaced = (tables: Tables, pick: (item: Item) => boolean, change: (item: Item) => Item): Tables => ({
  game: tables.game.map((item) => (pick(item) ? change(item) : item)),
  identity: tables.identity,
  ledger: tables.ledger.map((item) => (pick(item) ? change(item) : item)),
});

/* ================================================================== */

describe("JX-4B: gamesDoctor aws money -- the money game's evidence, read-only", () => {
  test("A. a healthy pre-Start game: FIN bound, both seats funded, nothing frozen, no intent -- clean (and --chain: binding MATCH, roster N/A)", async () => {
    const e = await moneyEvidenceWorld("pre-start");
    try {
      const tables = await project(e);
      const { code, view: v, err } = await view(e, tables);
      assert.equal(code, EXIT.ok, `${err.join("\n")}\n${JSON.stringify(v.checks, null, 1)}`);
      assert.equal(v.fin.phase, "funding");
      assert.equal(v.fin.dealt, false);
      assert.equal(v.fin.escrow?.chain_game_id, e.chainGameId);
      assert.equal(v.fin.roster, null);
      assert.match(v.fin.start_progress, /not frozen \(pre-Start/);
      assert.equal(v.intents.items.length, 0);
      assert.equal(v.relay_queue.queue, RELAYER_ADDRESS);
      assert.equal(v.relay_queue.game_entries.length, 0, "the other game's queue entry is never this game's");
      assert.equal(check(v, "1").status, "pass");
      assert.equal(check(v, "2").status, "pass");
      assert.equal(check(v, "3").status, "n/a");
      assert.equal(check(v, "3b").status, "pass");
      assert.equal(check(v, "6").status, "n/a");
      assert.equal(check(v, "7").status, "pass");
      assert.equal(check(v, "8").status, "pass");
      assert.equal(check(v, "9").status, "pass");
      assert.equal(v.verdicts.journal, "JOURNAL MATCH");
      assert.equal(v.summary.clean, true);
      assert.equal(v.tickets.grants?.grants.length, 2);
      /* --chain before Start: the binding is comparable, the roster is not frozen yet. */
      const chain = chainOf(e);
      const chained = await view(e, tables, ["--chain"], { chain: chain.rest });
      assert.equal(chained.code, EXIT.ok, JSON.stringify(chained.view.checks, null, 1));
      assert.equal(chained.view.verdicts.chain_binding, "CHAIN BINDING MATCH");
      assert.match(chained.view.verdicts.roster ?? "", /^ROSTER N\/A/);
      assert.equal(chained.view.chain?.game?.seats.length, 2);
      assert.equal(check(chained.view, "C3").status, "pass", "the contract holds this game's pool");
      assert.deepEqual(chain.forbidden, [], "no chain method beyond reads is reachable");
    } finally {
      await e.world.close();
    }
  });

  test("B + F. frozen roster with a pending Start: full roster hash and domain, every seat mapped, the Start queued -- then the queue entry gone (MISSING)", async () => {
    const e = await moneyEvidenceWorld("frozen");
    try {
      const tables = await project(e);
      const fin = (await e.world.financial.load(e.gameId))!;
      const { code, view: v, text, err } = await (async () => {
        const answered = await view(e, tables);
        const textual = await run(e, tables);
        return { ...answered, text: textual.text };
      })();
      assert.equal(code, EXIT.ok, `${err.join("\n")}\n${JSON.stringify(v.checks, null, 1)}`);
      assert.ok(fin.roster !== null);
      assert.equal(v.fin.roster?.roster_hash, fin.roster.roster_hash);
      assert.equal(v.fin.roster?.expected_domain, fin.roster.expected_domain);
      assert.match(text, new RegExp(`roster_hash +${fin.roster.roster_hash}`), "the COMPLETE roster hash is printed");
      assert.match(text, new RegExp(`expected_domain +${fin.roster.expected_domain}`), "the COMPLETE domain is printed");
      assert.deepEqual(v.fin.roster?.seats.map((seat) => [seat.chain_seat_index, seat.payout_wallet, seat.consent_public_key]), [
        [0, e.hostWallet.address, e.hostKey.pubkey],
        [1, e.joinerWallet.address, e.joinerKey.pubkey],
      ]);
      assert.match(v.fin.start_progress, /Start PENDING/);
      assert.equal(v.tickets.frozen_at, fin.roster.frozen_at);
      const start = v.intents.items.find((intent) => intent.op === "start")!;
      assert.equal(start.status, "pending");
      assert.equal(start.attempts.length, 0);
      assert.equal(start.relay.verdict, "ok");
      assert.equal(start.relay.present, true);
      for (const id of ["1", "2", "3", "3b", "4", "5", "6", "7", "8", "9"]) assert.equal(check(v, id).status, "pass", `check ${id}: ${check(v, id).details.join(" | ")}`);
      /* F: the queue item is gone -- the relayer would never see the Start. */
      const gone = without(tables, (item) => item.pk.S === `RELAYQ#${RELAYER_ADDRESS}` && item.intent_id?.S === start.intent_id);
      const missing = await view(e, gone);
      assert.equal(missing.code, EXIT.findings);
      assert.equal(check(missing.view, "8").status, "fail");
      assert.equal(missing.view.intents.items.find((intent) => intent.op === "start")?.relay.verdict, "MISSING");
      assert.match(check(missing.view, "8").details.join("\n"), /is NOT in the relay queue/);
    } finally {
      await e.world.close();
    }
  });

  test("C + E + I + J. a confirmed Start: every attempt with its journal MATCH; a damaged / missing / extra journal entry is a MISMATCH; a terminal intent still queued is caught; --tx-bytes returns the exact stored bytes", async () => {
    const e = await moneyEvidenceWorld("started");
    try {
      const tables = await project(e);
      const { code, view: v, err } = await view(e, tables);
      assert.equal(code, EXIT.ok, `${err.join("\n")}\n${JSON.stringify(v.checks, null, 1)}`);
      assert.ok(v.fin.chain?.started !== null, "Start confirmed");
      assert.match(v.fin.start_progress, /Start CONFIRMED at height/);
      assert.equal(v.fin.dealt, true);
      const start = v.intents.items.find((intent) => intent.op === "start")!;
      assert.equal(start.status, "confirmed");
      assert.ok(start.attempts.length >= 1);
      const included = start.attempts.find((a) => a.phase === "included-success")!;
      assert.ok(included !== undefined);
      assert.equal(included.tx_bytes_hash_ok, true);
      assert.equal(included.journal.atti, "match");
      assert.equal(included.journal.txid, "match");
      assert.equal(start.relay.verdict, "ok", "a confirmed intent is no longer queued");
      assert.equal(v.verdicts.journal, "JOURNAL MATCH");
      for (const id of ["1", "2", "3", "3b", "4", "5", "6", "7", "8", "9"]) assert.equal(check(v, id).status, "pass", `check ${id}: ${check(v, id).details.join(" | ")}`);
      const stored = (await e.startIntent())!;
      const attempt = stored.attempts.find((a) => a.phase === "included-success")!;

      /* E1: the ATTI# entry's expiry differs from the attempt's timeout height. */
      const attiKey = LEDGER_KEYS.atti(stored.intent_id, attempt.sequence, attempt.tx_hash);
      const expiry = replaced(tables, (item) => item.pk.S === attiKey.pk.S && item.sk.S === attiKey.sk.S, (item) => ({ ...item, expires_after_height: S("999999") }));
      const e1 = await view(e, expiry);
      assert.equal(e1.code, EXIT.findings);
      assert.equal(e1.view.verdicts.journal, "JOURNAL MISMATCH");
      assert.match(check(e1.view, "7").details.join("\n"), /expiry 999999, the attempt's timeout_height/);
      /* E2: the TXID# record is missing. */
      const noTxid = without(tables, (item) => item.pk.S === `TXID#${attempt.tx_hash}`);
      const e2 = await view(e, noTxid);
      assert.equal(e2.view.verdicts.journal, "JOURNAL MISMATCH");
      assert.match(check(e2.view, "7").details.join("\n"), /TXID missing/);
      /* E3: the TXID# record names another account. */
      const otherAccount = replaced(tables, (item) => item.pk.S === `TXID#${attempt.tx_hash}`, (item) => ({ ...item, account: S("juno1someoneelse") }));
      const e3 = await view(e, otherAccount);
      assert.equal(e3.view.verdicts.journal, "JOURNAL MISMATCH");
      /* E4: an attempt the ledger journalled that no intent stores (journal-only): never silently omitted. */
      const extraTx = "E".repeat(64);
      const extra: Tables = { ...tables, ledger: [...tables.ledger, ...ledgerItems({ intent_id: stored.intent_id, tx_id: extraTx, account: RELAYER_ADDRESS, sequence: "77", expires_after_height: "1000" })] };
      const e4 = await view(e, extra);
      assert.equal(e4.code, EXIT.findings);
      assert.equal(e4.view.verdicts.journal, "JOURNAL MISMATCH");
      assert.deepEqual(e4.view.journal.journal_only.map((entry) => entry.tx_id), [extraTx]);
      assert.equal(check(e4.view, "9").status, "fail");
      assert.match(check(e4.view, "9").details.join("\n"), new RegExp(`journal-only attempt ${extraTx}`));

      /* I: the confirmed Start is still in the relay queue. */
      const queued: Tables = { ...tables, game: [...tables.game, queueItem(e.gameId, stored)] };
      const i = await view(e, queued);
      assert.equal(i.code, EXIT.findings);
      assert.equal(check(i.view, "8").status, "fail");
      assert.match(check(i.view, "8").details.join("\n"), /TERMINAL and still queued/);
      assert.match(i.view.relay_queue.game_entries[0].verdict, /UNEXPECTED: the intent is confirmed/);

      /* J: --tx-bytes: stdout is the stored base64, byte for byte; the description is on stderr. */
      const exported = await run(e, tables, ["--tx-bytes", stored.intent_id, ...(stored.attempts.length > 1 ? ["--tx-hash", attempt.tx_hash] : [])]);
      assert.equal(exported.code, EXIT.ok, exported.err.join("\n"));
      assert.deepEqual(exported.out, [attempt.tx_bytes], "exactly the durable bytes, nothing else on stdout");
      assert.equal(createHash("sha256").update(Buffer.from(exported.out[0], "base64")).digest("hex").toUpperCase(), attempt.tx_hash);
      assert.match(exported.err.join("\n"), /SHA-256 of the stored bytes = the tx hash/);
      assert.match(exported.err.join("\n"), /jx2VerifyTx\.js --tx-file .* --chain-id uni-7 --account-number \d+ .* --hash [0-9A-F]{64} --contract juno1\S+ --sequence \d+ --fee \d+ --denom ujunox --gas-limit \d+/);
      const json = await run(e, tables, ["--json", "--tx-bytes", stored.intent_id, "--tx-hash", attempt.tx_hash.toLowerCase()]);
      const exportView = JSON.parse(json.text) as TxBytesExport;
      assert.equal(exportView.tx_base64, attempt.tx_bytes);
      assert.equal(exportView.sha256_matches_tx_hash, true);
      assert.equal(exportView.intent_id, stored.intent_id);
      assert.equal(exportView.account, RELAYER_ADDRESS);
      /* A stored attempt whose bytes are not its hash: exported as stored, flagged, nonzero. */
      const damaged = { ...stored, attempts: stored.attempts.map((a) => (a.tx_hash === attempt.tx_hash ? { ...a, tx_bytes: Buffer.from("not the transaction").toString("base64") } : a)) };
      const damagedTables = replaced(tables, (item) => item.sk?.S === intentSk(stored.intent_id), (item) => ({ ...item, body: S(JSON.stringify(damaged)) }));
      const bad = await run(e, damagedTables, ["--tx-bytes", stored.intent_id, "--tx-hash", attempt.tx_hash]);
      assert.equal(bad.code, EXIT.findings);
      assert.match(bad.err.join("\n"), /!= THE TX HASH/);
      const badView = await view(e, damagedTables);
      assert.equal(badView.view.verdicts.journal, "JOURNAL MISMATCH", "the stored bytes are not the attempt's: never a match");
    } finally {
      await e.world.close();
    }
  });

  test("D + K. a Start that needed a second attempt: EVERY attempt listed (the dead one with its proof), each journalled; --tx-bytes refuses to guess while no attempt is included", async () => {
    const live = await moneyEvidenceWorld("retry-live");
    try {
      const tables = await project(live);
      const stored = (await live.startIntent())!;
      assert.ok(stored.attempts.length >= 2);
      const v = (await view(live, tables)).view;
      const text = (await run(live, tables)).text;
      const start = v.intents.items.find((intent) => intent.op === "start")!;
      assert.equal(start.attempts.length, stored.attempts.length, "no attempt is omitted");
      assert.equal(start.attempts[0].phase, "dead");
      assert.equal((start.attempts[0].death as { kind: string }).kind, "expiry-passed");
      assert.match(start.attempts[0].failure_state, /dead \(expiry-passed\)/);
      assert.ok(start.attempts.every((a) => a.journal.atti === "match" && a.journal.txid === "match"));
      assert.match(text, /attempt 1 +tx [0-9A-F]{64} +phase dead/);
      assert.match(text, /attempt 2 +tx [0-9A-F]{64}/);
      assert.equal(v.verdicts.journal, "JOURNAL MATCH");
      /* K: several attempts and none included -> ambiguous: refused unless one is named. */
      const ambiguous = await run(live, tables, ["--tx-bytes", stored.intent_id]);
      assert.equal(ambiguous.code, EXIT.findings);
      assert.deepEqual(ambiguous.out, [], "nothing exported");
      assert.match(ambiguous.err.join("\n"), /AMBIGUOUS: name one with --attempt <n> or --tx-hash <HASH>/);
      const first = await run(live, tables, ["--tx-bytes", stored.intent_id, "--attempt", "1"]);
      assert.equal(first.code, EXIT.ok);
      assert.deepEqual(first.out, [stored.attempts[0].tx_bytes]);
      const second = await run(live, tables, ["--tx-bytes", stored.intent_id, "--tx-hash", stored.attempts[1].tx_hash]);
      assert.deepEqual(second.out, [stored.attempts[1].tx_bytes]);
      assert.equal((await run(live, tables, ["--tx-bytes", stored.intent_id, "--attempt", "9"])).code, EXIT.findings);
      assert.equal((await run(live, tables, ["--tx-bytes", stored.intent_id, "--attempt", "1", "--tx-hash", stored.attempts[1].tx_hash])).code, EXIT.usage, "both selectors: refused before anything is read");
      assert.equal((await run(live, tables, ["--tx-bytes", "abc"])).code, EXIT.findings, "an intent is named by its full id");
      assert.equal((await run(live, tables, ["--tx-bytes", "0".repeat(64)])).code, EXIT.findings, "an intent this game does not hold");
    } finally {
      await live.world.close();
    }
    const done = await moneyEvidenceWorld("retry-started");
    try {
      const tables = await project(done);
      const stored = (await done.startIntent())!;
      const { code, view: v } = await view(done, tables);
      assert.equal(code, EXIT.ok, JSON.stringify(v.checks, null, 1));
      assert.equal(v.intents.items.find((intent) => intent.op === "start")?.attempts.length, stored.attempts.length);
      /* With exactly one included attempt, that one is the sensible one. */
      const picked = await run(done, tables, ["--tx-bytes", stored.intent_id]);
      assert.equal(picked.code, EXIT.ok, picked.err.join("\n"));
      const included = stored.attempts.find((a) => a.phase === "included-success")!;
      assert.deepEqual(picked.out, [included.tx_bytes]);
      assert.match(picked.err.join("\n"), /\(the one included attempt\)/);
    } finally {
      await done.world.close();
    }
  });

  test("G + H. missing ticket data, an unreadable ledger, identity that cannot be read: never a PASS from a missing fact", async () => {
    const e = await moneyEvidenceWorld("frozen");
    try {
      const tables = await project(e);
      /* G1: no TICKETS item at all -- the freeze and the seats' grants are contradicted. */
      const noTickets = without(tables, (item) => item.sk?.S === TICKETS_SK);
      const g1 = await view(e, noTickets);
      assert.equal(g1.code, EXIT.findings);
      assert.equal(check(g1.view, "2").status, "fail");
      assert.equal(check(g1.view, "3").status, "fail");
      /* G2: the TICKETS read is denied -- not evaluated, and neither are the grants. */
      const g2 = await view(e, tables, [], { fault: (table, command, _pk, sk) => (table === GAME_TABLE && command === "GetItemCommand" && sk === TICKETS_SK ? denied("dynamodb:GetItem") : null) });
      assert.equal(g2.code, EXIT.findings);
      assert.match(g2.view.tickets.read, /UNAVAILABLE: AccessDeniedException/);
      assert.equal(check(g2.view, "2").status, "not-evaluated");
      assert.equal(check(g2.view, "3").status, "not-evaluated");
      assert.equal(check(g2.view, "3b").status, "not-evaluated");
      assert.equal(check(g2.view, "1").status, "pass", "FIN itself was read");
      /* G3: a TICKETS item this build cannot read (its version attribute disagrees): not evaluated, never a pass. */
      const ticketsDenied = await view(e, replaced(tables, (item) => item.sk?.S === TICKETS_SK, (item) => ({ ...item, version: N(999) })));
      assert.equal(check(ticketsDenied.view, "2").status, "not-evaluated", "a ledger item this build cannot read is not evaluated");
      assert.match(ticketsDenied.view.tickets.read, /UNREADABLE/);
      assert.equal(check(ticketsDenied.view, "3").status, "not-evaluated");
      assert.equal(ticketsDenied.code, EXIT.findings);
      /* H: identity cannot be read -- standing NOT EVALUATED, the grants still shown. */
      const h = await view(e, tables, [], { fault: (table) => (table === IDENTITY_TABLE ? denied("dynamodb:GetItem") : null) });
      assert.equal(h.code, EXIT.findings);
      assert.equal(check(h.view, "3b").status, "not-evaluated");
      assert.equal(h.view.tickets.grants?.identity.read, false);
      assert.ok(h.view.tickets.grants?.grants.every((grant) => grant.standing === null), "standing is never guessed");
      assert.equal(check(h.view, "3").status, "pass", "the mapping itself is still evaluated from the ledger");
    } finally {
      await e.world.close();
    }
  });

  test("L + M. --chain: the bound deployment read and compared (ROSTER MATCH, CHAIN BINDING MATCH); a moved seat, another code, another operator are exact mismatches", async () => {
    const e = await moneyEvidenceWorld("started");
    try {
      const tables = await project(e);
      const chain = chainOf(e);
      const ok = await view(e, tables, ["--chain"], { chain: chain.rest });
      assert.equal(ok.code, EXIT.ok, JSON.stringify(ok.view.checks, null, 1));
      assert.equal(ok.view.verdicts.roster, "ROSTER MATCH");
      assert.equal(ok.view.verdicts.chain_binding, "CHAIN BINDING MATCH");
      assert.equal(ok.view.chain?.grade, "verified");
      assert.equal(ok.view.chain?.game?.state, "IN_PROGRESS");
      assert.equal(ok.view.chain?.game?.computed_roster_hash, ok.view.fin.roster?.roster_hash, "recomputed with the codec's own rosterHash");
      assert.equal(ok.view.chain?.game?.domain, ok.view.fin.roster?.expected_domain);
      assert.equal(check(ok.view, "C3").status, "pass");
      assert.deepEqual(chain.forbidden, []);
      const text = (await run(e, tables, ["--chain"], { chain: chain.rest })).text;
      assert.match(text, /^ROSTER MATCH$/m);
      assert.match(text, /^CHAIN BINDING MATCH$/m);
      assert.match(text, /^JOURNAL MATCH$/m);
      assert.match(text, /^EVIDENCE CLEAN/m);

      /* M1: the chain shows another wallet in seat 1 (and so another roster hash). */
      const swapped = chainOf(e, {
        smartAt: async (contract: string, query: string) => {
          const answer = await e.world.chain.smartAt(contract, query);
          if (!query.startsWith('{"game"')) return answer;
          const data = JSON.parse(JSON.stringify(answer.data)) as { game: { seats: Array<{ wallet: string }> } };
          data.game.seats[1].wallet = e.hostWallet.address.replace(/.$/, (c) => (c === "q" ? "p" : "q"));
          return { data, height: answer.height };
        },
      });
      const m1 = await view(e, tables, ["--chain"], { chain: swapped.rest });
      assert.equal(m1.code, EXIT.findings);
      assert.match(m1.view.verdicts.roster ?? "", /^ROSTER MISMATCH: seat 1: the chain's wallet/);
      /* M2: the contract now reports other code (an in-place migration). */
      e.world.chain.reportedChecksum = "a".repeat(64);
      const m2 = await view(e, tables, ["--chain"], { chain: chainOf(e).rest });
      assert.equal(m2.code, EXIT.findings);
      assert.match(m2.view.verdicts.chain_binding ?? "", /^CHAIN BINDING MISMATCH: the contract's code checksum is a{64}/);
      e.world.chain.reportedChecksum = null;
      /* M3: the contract's operator is not the configured relayer. */
      const otherOperator = chainOf(e, {
        verifiedContractFacts: async (contract: string, query: string) => {
          const facts = await e.world.chain.verifiedContractFacts(contract, query);
          const config = JSON.parse(JSON.stringify(facts.config)) as { config: { operator: string } };
          config.config.operator = JX4B_RESOLVER;
          return { code_checksum: facts.code_checksum, config };
        },
      });
      const m3 = await view(e, tables, ["--chain"], { chain: otherOperator.rest });
      assert.equal(m3.code, EXIT.findings);
      assert.match(check(m3.view, "C2").details.join("\n"), /the contract's operator is juno1\S+, the configured relayer juno1\S+/);
      assert.equal(m3.view.verdicts.roster, "ROSTER MATCH", "each verdict is its own");
    } finally {
      await e.world.close();
    }
  });

  test("N. read failures: an unreachable chain, the intents' query, the ledger, FIN -- each NOT EVALUATED (exit 1), nothing changed, never a PASS", async () => {
    const e = await moneyEvidenceWorld("started");
    try {
      const tables = await project(e);
      e.world.chain.unavailable = true;
      const chainDown = await view(e, tables, ["--chain"], { chain: chainOf(e).rest });
      e.world.chain.unavailable = false;
      assert.equal(chainDown.code, EXIT.findings);
      assert.match(chainDown.view.verdicts.roster ?? "", /^ROSTER NOT EVALUATED/);
      assert.match(chainDown.view.verdicts.chain_binding ?? "", /^CHAIN BINDING NOT EVALUATED/);
      assert.equal(chainDown.view.verdicts.journal, "JOURNAL MATCH", "the table evidence is unaffected by a chain read that failed");
      /* --chain where no escrow configuration was read (DynamoDB Local): not evaluated, nonzero. */
      {
        const dynamo = fakeDynamo(tables);
        const out: string[] = [];
        const code = await runAwsOperator(["money", e.gameId, "--chain", "--json", "--local-document", "doc.json", "--relayer", RELAYER_ADDRESS], { GS_DYNAMODB_LOCAL_ENDPOINT: "http://127.0.0.1:8000" }, { out: (line) => out.push(line), err: () => undefined }, {
          readFile: async () => JSON.stringify({ ...DOC, ledger_table_arn: LEDGER_ARN }),
          clientFor: () => dynamo.client,
          now: () => e.world.clock.now,
        });
        assert.equal(code, EXIT.findings);
        const local = JSON.parse(out.join("\n")) as MoneyEvidenceView;
        assert.match(local.verdicts.roster ?? "", /NOT EVALUATED \(the chain could not be read: NOT-READ: DynamoDB Local reads no escrow configuration/);
        assert.equal(local.relay_queue.queue, RELAYER_ADDRESS, "the queue named by --relayer");
      }
      const intentsDown = await view(e, tables, [], { fault: (table, command, pk) => (table === GAME_TABLE && command === "QueryCommand" && pk === gamePk(e.gameId) ? Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }) : null) });
      assert.equal(intentsDown.code, EXIT.findings);
      assert.match(intentsDown.view.intents.read, /UNAVAILABLE: ThrottlingException/);
      for (const id of ["6", "7", "8", "9"]) assert.equal(check(intentsDown.view, id).status, "not-evaluated", `check ${id}`);
      assert.equal(intentsDown.view.verdicts.journal, "JOURNAL NOT EVALUATED");
      const ledgerDown = await view(e, tables, [], { fault: (table) => (table === LEDGER_ARN ? denied("dynamodb:Query") : null) });
      assert.equal(ledgerDown.code, EXIT.findings);
      assert.equal(ledgerDown.view.verdicts.journal, "JOURNAL NOT EVALUATED");
      assert.equal(check(ledgerDown.view, "7").status, "not-evaluated");
      const finDown = await view(e, tables, ["--chain"], { chain: chainOf(e).rest, fault: (table, command, _pk, sk) => (table === GAME_TABLE && command === "GetItemCommand" && sk === FIN_SK ? Object.assign(new Error("timed out"), { name: "TimeoutError" }) : null) });
      assert.equal(finDown.code, EXIT.findings);
      assert.equal(check(finDown.view, "1").status, "not-evaluated");
      assert.match(finDown.view.verdicts.roster ?? "", /NOT EVALUATED/);
      /* A damaged intent item is LISTED (never skipped) and its attempts cannot be accounted for. */
      const stored = (await e.startIntent())!;
      const damaged = replaced(tables, (item) => item.sk?.S === intentSk(stored.intent_id), (item) => ({ ...item, record_version: N(stored.record_version + 1) }));
      const d = await view(e, damaged);
      assert.equal(d.code, EXIT.findings);
      assert.match(d.view.intents.items.find((i) => i.intent_id === stored.intent_id)?.read ?? "", /UNREADABLE: .*version attribute/);
      assert.equal(check(d.view, "9").status, "fail");
    } finally {
      await e.world.close();
    }
  });

  test("O. --apply and every mutation mode are refused before anything is read; money's options belong to money", async () => {
    const e = await moneyEvidenceWorld("pre-start");
    try {
      const tables = await project(e);
      for (const extra of [["--apply"], ["--note", "why"], ["--expect-version", "3"], ["--run", "op:r-1"], ["--rollback"], ["--flip-record", "x.json"], ["--attempt", "1"], ["--tx-bytes", "a".repeat(64), "--chain"], ["--money"]]) {
        const answered = await run(e, tables, extra);
        assert.equal(answered.code, EXIT.usage, extra.join(" "));
        assert.deepEqual(answered.sent, [], `${extra.join(" ")}: nothing was read`);
        assert.deepEqual(answered.reads, [], `${extra.join(" ")}: not even the configuration`);
      }
      assert.match((await run(e, tables, ["--apply"])).err.join("\n"), /read-only: --apply means nothing here/);
      /* money's own options on another command */
      const out: string[] = [];
      const err: string[] = [];
      assert.equal(await runAwsOperator(["status", "--chain", "--aws-config", RUNTIME_ARN], {}, { out: (l) => out.push(l), err: (l) => err.push(l) }), EXIT.usage);
      assert.match(err.join("\n"), /--chain belongs to `money`/);
    } finally {
      await e.world.close();
    }
  });

  test("P. redaction: no principal / family / session / recovery material, no raw ticket, no ARN, table name or endpoint -- in text or JSON, with --chain", async () => {
    const e = await moneyEvidenceWorld("started");
    try {
      const tables = await project(e);
      const chain = chainOf(e).rest;
      const text = (await run(e, tables, ["--chain"], { chain })).text;
      const json = (await run(e, tables, ["--chain", "--json"], { chain })).text;
      const snapshot = e.world.identityStore.snapshot();
      const { document } = await e.world.ticketStore.load(e.gameId);
      const secrets = [
        ...snapshot.principals.map((p) => p.principal_id),
        ...snapshot.families.map((f) => f.family_id),
        ...snapshot.sessions.map((s) => s.session_id),
        ...document.grants.map((g) => g.ticket),
        ...document.grants.map((g) => g.issued_under.recovery_selector),
        /* PHASE 3 FINAL: no recovery key exists; the accounts' passwords and their stored hashes are the credentials now. */
        e.host.browser.password,
        e.joiner.browser.password,
        ...snapshot.profiles.map((p) => p.password_hash as string),
        e.host.browser.cookie,
        e.joiner.browser.cookie,
        RUNTIME_ARN,
        ESCROW_ARN,
        LEDGER_ARN,
        GAME_TABLE,
        IDENTITY_TABLE,
        SECRET_ENDPOINT,
        "secret-path-token-do-not-print",
        "arn:aws:",
      ];
      for (const output of [text, json]) {
        /* JX-3B's rule (no server-private id prefix, no cookie, no recovery field), by id SHAPE -- so a JSON key such as
           `network_class` is not mistaken for an `rk_` id. */
        assert.equal(/(^|[^A-Za-z0-9])(pr|sf|se|rk|pf)_[0-9a-z]/.test(output), false, "a server-private id");
        for (const word of ["__Host-", "recovery_selector", "recoveryKey", "recovery_hash", "issued_under", "principal_id", "family_id"]) assert.equal(output.includes(word), false, word);
        for (const secret of secrets) assert.equal(output.includes(secret), false, `the output carries ${secret.slice(0, 12)}...`);
      }
      /* The signed bytes are not in the evidence view (only the explicit --tx-bytes export prints them). */
      const stored = (await e.startIntent())!;
      for (const attempt of stored.attempts) {
        assert.ok(!text.includes(attempt.tx_bytes) && !json.includes(attempt.tx_bytes));
        assert.ok(text.includes(attempt.tx_hash), "the tx hash (public) is printed");
      }
      /* Public material IS printed whole: wallets, consent public keys, the roster hash and domain. */
      for (const value of [e.hostWallet.address, e.joinerWallet.address, e.hostKey.pubkey, e.joinerKey.pubkey]) assert.ok(text.includes(value), value);
    } finally {
      await e.world.close();
    }
  });

  test("the chain read port: JunoRest's bank read is strict and chain-checked, and the port the tool holds has no simulate, broadcast or tx method", async () => {
    const asked: HttpRequest[] = [];
    let balance: unknown = { balance: { denom: "ujunox", amount: "1980000" } };
    const http = async (request: HttpRequest) => {
      asked.push(request);
      if (request.url.endsWith("/cosmos/base/tendermint/v1beta1/node_info")) return { status: 200, text: JSON.stringify({ default_node_info: { network: CHAIN_ID } }) };
      if (request.url.includes("/cosmos/bank/v1beta1/balances/")) return { status: 200, text: JSON.stringify(balance), height: "4242" };
      return { status: 404, text: "{}" };
    };
    const rest = createJunoRest({ endpoints: ["https://rest.example/SECRET-KEY-IN-PATH"], expectedChainId: CHAIN_ID, allowInsecureLocalHttp: false, timeoutMs: 1000, maxResponseBytes: 10_000, maxCodeBytes: 10_000 }, http);
    assert.deepEqual(await rest.bankBalance!(CONTRACT, "ujunox"), { amount: "1980000", height: "4242" });
    assert.equal(asked[0].url, "https://rest.example/SECRET-KEY-IN-PATH/cosmos/base/tendermint/v1beta1/node_info", "the chain id is asked first");
    assert.equal(asked[1].method, "GET");
    assert.equal(asked[1].url, `https://rest.example/SECRET-KEY-IN-PATH/cosmos/bank/v1beta1/balances/${CONTRACT}/by_denom?denom=ujunox`);
    balance = { balance: { denom: "ujunox", amount: "0" } };
    assert.equal((await rest.bankBalance!(CONTRACT, "ujunox")).amount, "0");
    for (const wrong of [{ balance: { denom: "ujuno", amount: "5" } }, { balance: { denom: "ujunox", amount: "5.0" } }, { balance: { denom: "ujunox", amount: 5 } }, {}]) {
      balance = wrong;
      await assert.rejects(
        () => rest.bankBalance!(CONTRACT, "ujunox"),
        (error: unknown) => error instanceof JunoRpcError && error.kind === "malformed" && !error.message.includes("SECRET") && !(error.endpoint ?? "").includes("SECRET"),
        JSON.stringify(wrong),
      );
    }
    await assert.rejects(() => rest.bankBalance!("JUNO1UPPER", "ujunox"), (error: unknown) => error instanceof JunoRpcError && error.kind === "refused");
    assert.ok(asked.every((request) => request.method === "GET"), "reads only");
    /* The tool's port: reads only, whatever the transport offers. */
    const port = chainReadPort(rest);
    assert.deepEqual(Object.keys(port).sort(), ["bankBalance", "chainId", "codeChecksum", "contract", "latestBlock", "smartAt", "verifiedContractFacts"]);
    for (const name of ["simulate", "broadcast", "tx", "txsBySequence", "account", "smart", "smartQuorum"]) assert.equal(name in port, false, name);
  });

  test("review: an ATTI# read that fails for an intent with NO attempt is never a pass; a journal-first crash and a table behind the ledger are caught; live work in an old relayer's queue is STRANDED", async () => {
    const e = await moneyEvidenceWorld("frozen");
    try {
      const tables = await project(e);
      const start = (await e.startIntent())!;
      assert.equal(start.attempts.length, 0);
      /* The ledger cannot be read: no attempt is stored, but one may be journalled -- NOT EVALUATED, not "match". */
      const down = await view(e, tables, [], { fault: (table) => (table === LEDGER_ARN ? denied("dynamodb:Query") : null) });
      assert.equal(down.code, EXIT.findings);
      assert.equal(check(down.view, "7").status, "not-evaluated");
      assert.equal(check(down.view, "9").status, "not-evaluated");
      assert.equal(down.view.verdicts.journal, "JOURNAL NOT EVALUATED");
      /* The journal-first crash: the ledger journalled an attempt the intent never stored. */
      const crashed: Tables = { ...tables, ledger: [...tables.ledger, ...ledgerItems({ intent_id: start.intent_id, tx_id: "C".repeat(64), account: RELAYER_ADDRESS, sequence: "0", expires_after_height: "105" })] };
      const crash = await view(e, crashed);
      assert.equal(crash.code, EXIT.findings);
      assert.equal(crash.view.verdicts.journal, "JOURNAL MISMATCH");
      assert.match(crash.view.journal.journal_only[0].why, /the relayer journals FIRST/);
      /* Live work made in ANOTHER relayer's queue: the configured relayer never reads it. */
      const OLD = "juno1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn2rlq5v";
      const oldKey = relayQueueKey(OLD, start.created_at, e.gameId, start.intent_id);
      const moved = replaced(
        without(tables, (item) => item.pk.S === `RELAYQ#${RELAYER_ADDRESS}` && item.intent_id?.S === start.intent_id),
        (item) => item.sk?.S === intentSk(start.intent_id),
        (item) => ({ ...item, relay_pk: oldKey.pk, relay_sk: oldKey.sk }),
      );
      moved.game.push({ ...oldKey, game_id: S(e.gameId), intent_id: S(start.intent_id), created_at: N(start.created_at) });
      const stranded = await view(e, moved);
      assert.equal(stranded.code, EXIT.findings);
      assert.equal(check(stranded.view, "8").status, "fail");
      assert.equal(stranded.view.intents.items.find((i) => i.intent_id === start.intent_id)?.relay.verdict, "STRANDED");
      assert.match(check(stranded.view, "8").details.join("\n"), /STRANDED: made in another relayer's queue RELAYQ#juno1qqq/);
    } finally {
      await e.world.close();
    }
    /* A game table restored BEHIND the ledger: the Start's INTENT# item is gone, its journalled attempts are not. */
    const s2 = await moneyEvidenceWorld("started");
    try {
      const tables = await project(s2);
      const start = (await s2.startIntent())!;
      const behind = without(tables, (item) => item.sk?.S === intentSk(start.intent_id));
      const b = await view(s2, behind);
      assert.equal(b.code, EXIT.findings);
      assert.equal(b.view.verdicts.journal, "JOURNAL MISMATCH");
      assert.ok(b.view.journal.journal_only.length >= 1);
      assert.match(b.view.journal.journal_only[0].why, /which this game table does NOT hold/);
      assert.equal(check(b.view, "9").status, "fail");
    } finally {
      await s2.world.close();
    }
  });

  test("review: AWS error text never carries an ARN, a table name or an endpoint; a pre-bind game's contract-level binding is still judged with --chain; selectors are checked before anything is read", async () => {
    const e = await moneyEvidenceWorld("unbound");
    try {
      const tables = await project(e);
      const fin = (await e.world.financial.load(e.gameId))!;
      assert.equal(fin.binding?.escrow, null, "no chain game is bound");
      const chained = await view(e, tables, ["--chain"], { chain: chainOf(e).rest });
      assert.equal(chained.code, EXIT.ok, JSON.stringify(chained.view.checks, null, 1));
      assert.equal(check(chained.view, "C2").status, "pass");
      assert.equal(check(chained.view, "C1").status, "n/a");
      assert.equal(check(chained.view, "C3").status, "n/a");
      assert.equal(chained.view.verdicts.chain_binding, "CHAIN BINDING MATCH");
      /* A realistic AccessDenied (the SDK's message quotes the role and the table ARNs). */
      const realistic = Object.assign(new Error(`User: arn:aws:sts::111111111111:assumed-role/gs-staging-ops/session is not authorized to perform: dynamodb:Query on resource: ${LEDGER_ARN} because no identity-based policy allows it (table ${GAME_TABLE}, https://dynamodb.us-east-1.amazonaws.com/secret)`), { name: "AccessDeniedException" });
      for (const json of [false, true]) {
        const answered = await run(e, tables, json ? ["--json"] : [], { fault: () => realistic });
        const all = [...answered.out, ...answered.err].join("\n");
        assert.equal(answered.code, EXIT.findings);
        assert.match(all, /AccessDeniedException/);
        for (const leak of ["arn:aws", "111111111111", "222222222222", GAME_TABLE, IDENTITY_TABLE, "gs-staging-ledger", "amazonaws.com", "secret"]) assert.equal(all.includes(leak), false, `${leak} leaked`);
      }
      /* --tx-bytes over an unreadable table: the outer failure is scrubbed too. */
      const exported = await run(e, tables, ["--tx-bytes", "a".repeat(64)], { fault: () => realistic });
      assert.equal([...exported.out, ...exported.err].join("\n").includes("arn:aws"), false);
      /* Selectors: repeated, both, malformed -- refused before the configuration is read. */
      for (const extra of [["--tx-bytes", "a".repeat(64), "--attempt", "1", "--attempt", "2"], ["--tx-bytes", "a".repeat(64), "--attempt", "1", "--tx-hash", "A".repeat(64)], ["--tx-bytes", "a".repeat(64), "--attempt", "0"], ["--tx-bytes", "a".repeat(64), "--tx-hash", "xyz"]]) {
        const refused = await run(e, tables, extra);
        assert.equal(refused.code, EXIT.usage, extra.join(" "));
        assert.deepEqual(refused.reads, [], extra.join(" "));
      }
    } finally {
      await e.world.close();
    }
  });
});
