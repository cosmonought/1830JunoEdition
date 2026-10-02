// server/src/aws/operator/jx4cOperatorEvidenceIam.test.ts
//
// ==================================================================
//  JX-4C: THE OPERATOR'S IAM IS SUFFICIENT FOR -- AND EXACTLY THE SHAPE OF -- THE JX-3B / JX-4B EVIDENCE READS
// ==================================================================
//
// A PERMISSION CONTRACT between the evidence code and the Terraform that authorises it. The operator's DynamoDB grants are
// read from the Terraform SOURCE -- modules/app/iam.tf `data "aws_iam_policy_document" "operator"` (the app account's
// half) and modules/ledger/main.tf `data "aws_iam_policy_document" "ledger_resource"`'s statements naming
// `local.operator_arn` (the ledger account's half) -- and enforced by a fake DynamoDB: a request is answered only when the
// app half allows it AND, on the ledger, the resource half allows it too (the cross-account rule); otherwise it is an
// AccessDeniedException, as AWS would answer. Then `gamesDoctor aws money` and `aws wallet-grants` run over a real money
// world (`escrow/jx4bSupport.ts`):
//
//   1  with the policies as written, every read is allowed: the journal is correlated (JOURNAL MATCH) and the grants'
//      standing is judged (check 3b PASS); every request falls inside the audited read surface (table x operation x key
//      class) -- a new read class fails here before it fails on AWS
//   2  either half of the ledger Query withdrawn: JOURNAL NOT EVALUATED, never a MATCH
//   3  any one of PRIN# / PROF# / FAM# withdrawn: standing NOT EVALUATED, never guessed
//   4  nothing of SESS# / LINK# (present in the table) is requested or printed; no recovery hash, selector, display name,
//      principal or family id is printed
//   5  reads only (GetItem / Query); --tx-bytes is byte-identical under the contract
//
// Evidence judgments are NOT changed to fit IAM: the code under test is unmodified production code.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { quietConsole } from "../../rooms/testSupport";
import { JX4B_RESOLVER, moneyEvidenceWorld, type EvidenceWorld } from "../../escrow/jx4bSupport";
import { ADMISSION_PUBKEY, CANONICAL_CHECKSUM, CHAIN_ID, CONTRACT, GAME_B, RELAYER_ADDRESS, SETTLEMENT_SECRET, T0 } from "../../escrow/escrow3bSupport";
import { TERMINAL_INTENT_STATUSES, type ChainIntentRecord } from "../../escrow/chainIntents";
import { publicKeyOf } from "../../escrow/juno/secp256k1";
import { WALLET_TICKET_FILE_FORMAT } from "../../escrow/walletTicketFileStore";
import { FIN_SK, gamePk, intentSk, key, META_SK, N, relayQueueKey, S, TICKETS_SK, type Item } from "../game/gameTable";
import { classOfKey, familyItem, keys as identityKeys, linkItem, principalItem, profileItem, sessionItem } from "../identity/identityItems";
import { LEDGER_KEYS } from "../ledger/dynamoSigningLedger";
import { EXIT, runAwsOperator } from "./operatorMain";
import type { MoneyEvidenceView } from "../../tools/moneyEvidence";
import type { WalletGrantsView } from "../../tools/walletGrants";

quietConsole();

const REPO = path.resolve(__dirname, "../../../../../.."); // dist/server/src/aws/operator -> the repository

/* ------------------------------------------------------------------ */
/* The operator's DynamoDB grants, from the Terraform source             */
/* ------------------------------------------------------------------ */

type TableKind = "game" | "identity" | "ledger";
interface Condition {
  readonly test: string;
  readonly variable: string;
  readonly values: readonly string[];
}
interface Grant {
  readonly sid: string;
  readonly actions: readonly string[];
  readonly table: TableKind;
  readonly conditions: readonly Condition[];
}

/** HCL without comments (# and // outside strings, block comments). */
function stripHcl(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      let quoted = false;
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (c === '"' && line[i - 1] !== "\\") quoted = !quoted;
        if (!quoted && (c === "#" || (c === "/" && line[i + 1] === "/"))) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** The brace-matched body that follows `start` (an index of the opening line). */
function bodyAt(text: string, start: number): string {
  let depth = 0;
  for (let i = text.indexOf("{", start); i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}" && --depth === 0) return text.slice(text.indexOf("{", start) + 1, i);
  }
  throw new Error("unbalanced HCL");
}

function blocks(body: string, name: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`(^|\\n)\\s*${name}\\s*\\{`, "g");
  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    const inner = bodyAt(body, match.index + match[1].length);
    out.push(inner);
    pattern.lastIndex = match.index + match[0].length + inner.length;
  }
  return out;
}

const list = (text: string): string[] => [...text.matchAll(/"([^"]*)"|([A-Za-z_][A-Za-z0-9_.]*)/g)].map((m) => m[1] ?? m[2]);

function policyStatements(file: string, document: string): Array<{ sid: string; actions: string[]; resources: string; conditions: Condition[] }> {
  const text = stripHcl(fs.readFileSync(path.join(REPO, file), "utf8"));
  const start = text.search(new RegExp(`data\\s+"aws_iam_policy_document"\\s+"${document}"\\s*\\{`));
  assert.ok(start >= 0, `${file}: data.aws_iam_policy_document.${document}`);
  return blocks(bodyAt(text, start), "statement").map((statement) => {
    const outer = statement.replace(/(condition|principals)\s*\{[^{}]*\}/g, "");
    /* Fail loudly on any shape this contract does not read exactly (review): a non-literal action list, a Deny, a
       NotAction / NotResource, an inverted principal. */
    assert.match(outer, /actions\s*=\s*\[[^\]]*\]/, `${file} ${document}: every statement's actions are a literal list`);
    assert.ok(!/\bnot_(actions|resources|principals)\b/.test(statement), `${file} ${document}: no not_actions / not_resources / not_principals`);
    const effect = /effect\s*=\s*"([^"]+)"/.exec(outer)?.[1] ?? "Allow";
    assert.equal(effect, "Allow", `${file} ${document}: only Allow statements (a Deny would change what this contract decides)`);
    return {
      sid: /sid\s*=\s*"([^"]+)"/.exec(outer)?.[1] ?? "",
      actions: list(/actions\s*=\s*\[([^\]]*)\]/.exec(outer)?.[1] ?? ""),
      resources: (/resources\s*=\s*([^\n]+)/.exec(outer)?.[1] ?? "").trim(),
      conditions: blocks(statement, "condition").map((c) => ({
        test: /test\s*=\s*"([^"]+)"/.exec(c)![1],
        variable: /variable\s*=\s*"([^"]+)"/.exec(c)![1],
        values: list(/values\s*=\s*\[([^\]]*)\]/.exec(c)?.[1] ?? /values\s*=\s*([^\n]+)/.exec(c)![1]),
      })),
    };
  });
}

function tableOf(resources: string): TableKind | null {
  if (resources === "values(local.game_table_arns)") return "game";
  if (resources === "[local.identity_table_arn]") return "identity";
  if (resources === "[var.ledger_table_arn]" || resources === "[aws_dynamodb_table.ledger.arn]") return "ledger";
  return null;
}

/** The app account's half: every DynamoDB statement of the operator's policy. An unrecognised resource is refused. */
function appHalf(): Grant[] {
  return policyStatements("infra/aws/modules/app/iam.tf", "operator")
    .filter((s) => s.actions.some((a) => a.startsWith("dynamodb:")))
    .map((s) => {
      const table = tableOf(s.resources);
      assert.ok(table !== null, `the operator's ${s.sid} names a DynamoDB resource this contract does not know: ${s.resources}`);
      return { sid: s.sid, actions: s.actions, table, conditions: s.conditions };
    });
}

/** The ledger account's half: the resource policy's statements whose aws:PrincipalArn names the operator. */
function ledgerHalf(): Grant[] {
  return policyStatements("infra/aws/modules/ledger/main.tf", "ledger_resource")
    .filter((s) => s.conditions.some((c) => c.variable === "aws:PrincipalArn" && c.values.includes("local.operator_arn")))
    .map((s) => {
      assert.equal(tableOf(s.resources), "ledger", s.sid);
      return { sid: s.sid, actions: s.actions, table: "ledger" as const, conditions: s.conditions.filter((c) => c.variable !== "aws:PrincipalArn") };
    });
}

const matches = (pattern: string, value: string) => (pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern);

/** Whether one grant allows `action` on the partition `pk` (null: no key in the request). Conditions it does not model
 *  never allow. */
function allows(grant: Grant, table: TableKind, action: string, pk: string | null): boolean {
  if (grant.table !== table || !grant.actions.some((a) => a === action || a === "dynamodb:*")) return false;
  return grant.conditions.every((c) => {
    if (c.variable !== "dynamodb:LeadingKeys") return false;
    if (c.test === "Null") return (pk === null) === (c.values[0] === "true");
    if (pk === null) return c.test.startsWith("ForAllValues:");
    if (c.test === "ForAllValues:StringLike") return c.values.some((p) => matches(p, pk));
    if (c.test === "ForAllValues:StringEquals") return c.values.includes(pk);
    if (c.test === "ForAllValues:StringNotEquals") return !c.values.includes(pk);
    return false;
  });
}

interface Policy {
  readonly app: readonly Grant[];
  readonly ledger: readonly Grant[];
}
const POLICY: Policy = { app: appHalf(), ledger: ledgerHalf() };

function permitted(policy: Policy, table: TableKind, action: string, pk: string | null): boolean {
  const app = policy.app.some((g) => allows(g, table, action, pk));
  return table === "ledger" ? app && policy.ledger.some((g) => allows(g, table, action, pk)) : app;
}

/** The policy with one grant's action or LeadingKeys pattern withdrawn (the negative cases). */
function withdraw(policy: Policy, half: "app" | "ledger", sid: string, what: { readonly action?: string; readonly pattern?: string }): Policy {
  const edit = (grants: readonly Grant[]) => {
    assert.ok(grants.some((g) => g.sid === sid), `${half} half has ${sid}`);
    return grants.map((g) =>
      g.sid !== sid
        ? g
        : {
            ...g,
            actions: g.actions.filter((a) => a !== what.action),
            conditions: g.conditions.map((c) => (c.variable === "dynamodb:LeadingKeys" && c.test !== "Null" ? { ...c, values: c.values.filter((v) => v !== what.pattern) } : c)),
          },
    );
  };
  return half === "app" ? { ...policy, app: edit(policy.app) } : { ...policy, ledger: edit(policy.ledger) };
}

/* ------------------------------------------------------------------ */
/* The world as DynamoDB holds it (identity with the classes the        */
/* operator must NOT read)                                               */
/* ------------------------------------------------------------------ */

const RUNTIME_ARN = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1";
const ESCROW_ARN = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/juno-backend";
const LEDGER_ARN = "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger";
const GAME_TABLE = "gs-staging-game-g1";
const IDENTITY_TABLE = "gs-staging-identity";
const DOC = { format: "18COSMOS/AWS-RUNTIME/v1", environment: "staging", region: "us-east-1", pool: "p1", generation: 1, game_table: GAME_TABLE, identity_table: IDENTITY_TABLE, ledger_table_arn: LEDGER_ARN, escrow: { config_parameter_arn: ESCROW_ARN } };
const kms = (n: string) => `arn:aws:kms:us-east-1:222222222222:key/${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ESCROW_DOC = {
  format: "18COSMOS/JUNO-BACKEND/v3",
  chain_id: CHAIN_ID,
  network_class: "testnet",
  rest_endpoints: ["https://juno-testnet-rest.example.net"],
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

interface Tables {
  game: Item[];
  identity: Item[];
  ledger: Item[];
}

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
    token: S("tok-jx4c"),
  });
  return [LEDGER_KEYS.txid(entry.tx_id), LEDGER_KEYS.attempt(entry.account, entry.sequence, entry.tx_id), LEDGER_KEYS.atti(entry.intent_id, entry.sequence, entry.tx_id)].map((k) => attributes(k as never));
}

async function project(e: EvidenceWorld): Promise<{ tables: Tables; secrets: string[] }> {
  const g = e.gameId;
  const fin = (await e.world.financial.load(g))!;
  const record = e.world.server.rooms.moneyPort.recordOf(g)!;
  const { version, document } = await e.world.ticketStore.load(g);
  const queueKeyOf = (intent: ChainIntentRecord) => relayQueueKey(RELAYER_ADDRESS, intent.created_at, g, intent.intent_id);
  const game: Item[] = [
    { ...key(gamePk(g), FIN_SK), body: S(JSON.stringify(fin)), record_version: N(fin.record_version) },
    { ...key(gamePk(g), META_SK), body: S(JSON.stringify(record)), record_version: N(record.record_version) },
    { ...key(gamePk(g), TICKETS_SK), body: S(JSON.stringify({ format: WALLET_TICKET_FILE_FORMAT, version, game_id: g, document })), version: N(version) },
  ];
  for (const intent of await e.world.intents.listGame(g)) {
    const q = queueKeyOf(intent);
    game.push({ ...key(gamePk(g), intentSk(intent.intent_id)), body: S(JSON.stringify(intent)), record_version: N(intent.record_version), relay_pk: q.pk, relay_sk: q.sk });
    if (!TERMINAL.has(intent.status)) game.push({ ...q, game_id: S(g), intent_id: S(intent.intent_id), created_at: N(intent.created_at) });
  }
  game.push({ ...relayQueueKey(RELAYER_ADDRESS, T0, GAME_B, "f".repeat(64)), game_id: S(GAME_B), intent_id: S("f".repeat(64)), created_at: N(T0) });
  const snapshot = e.world.identityStore.snapshot();
  /* The identity table as production holds it -- the classes the operator must never read included. */
  const identity = [
    ...snapshot.principals.map(principalItem),
    ...snapshot.profiles.map(profileItem),
    ...snapshot.families.map(familyItem),
    ...snapshot.sessions.map(sessionItem),
    ...snapshot.links.map(linkItem),
  ];
  assert.ok(snapshot.sessions.length > 0, "the world holds sessions (the class the operator must not read)");
  const secrets = [
    ...snapshot.sessions.flatMap((s) => [s.secret_hash, s.session_id]),
    ...snapshot.profiles.flatMap((p) => [p.recovery_hash, p.recovery_selector, p.display_name, p.profile_id]),
    ...snapshot.principals.map((p) => p.principal_id),
    ...snapshot.families.map((f) => f.family_id),
    ...snapshot.links.map((l) => l.link_hash),
  ].filter((value) => value.length >= 6);
  const ledger = (await e.world.journal.allAttempts()).flatMap((entry) => ledgerItems(entry));
  return { tables: { game, identity, ledger }, secrets };
}

/* ------------------------------------------------------------------ */
/* A fake DynamoDB that enforces the policy                              */
/* ------------------------------------------------------------------ */

const classOf = (pk: string) => (pk.includes("#") ? `${pk.slice(0, pk.indexOf("#"))}#` : pk);

function iamDynamo(tables: Tables, policy: Policy) {
  const kindOf: Record<string, TableKind> = { [GAME_TABLE]: "game", [IDENTITY_TABLE]: "identity", [LEDGER_ARN]: "ledger" };
  const byKind: Record<TableKind, Item[]> = { game: tables.game, identity: tables.identity, ledger: tables.ledger };
  const requests: Array<{ table: TableKind; action: string; pk: string; allowed: boolean }> = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name;
      const table = kindOf[command.input.TableName as string];
      assert.ok(table !== undefined, `an unknown table: ${String(command.input.TableName)}`);
      const action = `dynamodb:${name.replace(/Command$/, "")}`;
      const items = byKind[table];
      if (name === "GetItemCommand") {
        const wanted = command.input.Key as Record<string, { S: string }>;
        const allowed = permitted(policy, table, action, wanted.pk.S);
        requests.push({ table, action, pk: wanted.pk.S, allowed });
        if (!allowed) throw Object.assign(new Error(`User is not authorized to perform: ${action}`), { name: "AccessDeniedException" });
        const item = items.find((c) => c.pk.S === wanted.pk.S && c.sk.S === wanted.sk.S);
        return item === undefined ? {} : { Item: item };
      }
      if (name === "QueryCommand") {
        const values = command.input.ExpressionAttributeValues as Record<string, { S: string }>;
        const pk = values[":pk"].S;
        const allowed = permitted(policy, table, action, pk);
        requests.push({ table, action, pk, allowed });
        if (!allowed) throw Object.assign(new Error(`User is not authorized to perform: ${action}`), { name: "AccessDeniedException" });
        const prefix = values[":prefix"]?.S ?? "";
        const rows = items.filter((item) => item.pk.S === pk && (item.sk.S as string).startsWith(prefix)).sort((a, b) => ((a.sk.S as string) < (b.sk.S as string) ? -1 : 1));
        const start = command.input.ExclusiveStartKey as Record<string, { S: string }> | undefined;
        const from = start === undefined ? 0 : rows.findIndex((item) => item.sk.S === start.sk.S) + 1;
        const page = rows.slice(from, from + 2);
        return { Items: page, ...(from + 2 < rows.length ? { LastEvaluatedKey: { pk: page[page.length - 1].pk, sk: page[page.length - 1].sk } } : {}) };
      }
      requests.push({ table, action, pk: "", allowed: false });
      throw new Error(`the evidence tools are read-only: ${name}`);
    },
    destroy() {
      /* nothing */
    },
  };
  return { client: client as unknown as DynamoDBClient, requests };
}

async function operator(e: EvidenceWorld, tables: Tables, policy: Policy, args: string[]) {
  const dynamo = iamDynamo(tables, policy);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAwsOperator([...args, "--aws-config", RUNTIME_ARN], {}, { out: (line) => out.push(line), err: (line) => err.push(line) }, {
    parameters: { read: async (arn: string) => ({ value: JSON.stringify(arn === RUNTIME_ARN ? DOC : ESCROW_DOC), version: 3, arn }) },
    clientFor: () => dynamo.client,
    now: () => e.world.clock.now,
  });
  assert.ok(dynamo.requests.every((r) => r.action === "dynamodb:GetItem" || r.action === "dynamodb:Query"), `reads only: ${JSON.stringify(dynamo.requests)}`);
  return { code, out, err, text: [...out, ...err].join("\n"), requests: dynamo.requests };
}

const money = async (e: EvidenceWorld, tables: Tables, policy: Policy) => {
  const answered = await operator(e, tables, policy, ["money", e.gameId, "--json"]);
  return { ...answered, view: JSON.parse(answered.out.join("\n")) as MoneyEvidenceView };
};
const grants = async (e: EvidenceWorld, tables: Tables, policy: Policy) => {
  const answered = await operator(e, tables, policy, ["wallet-grants", e.gameId, "--json"]);
  return { ...answered, view: JSON.parse(answered.out.join("\n")) as WalletGrantsView };
};
const check = (v: MoneyEvidenceView, id: string) => v.checks.find((c) => c.id === id)!.status;

/** Part A's audited read surface: table x operation x key class (game-table classes are GameTableRead's, unchanged). */
const READ_SURFACE = new Set([
  "game dynamodb:GetItem GAME#",
  "game dynamodb:Query GAME#",
  "game dynamodb:Query RELAYQ#",
  "game dynamodb:GetItem RELAYQ#",
  "identity dynamodb:GetItem PRIN#",
  "identity dynamodb:GetItem PROF#",
  "identity dynamodb:GetItem FAM#",
  "ledger dynamodb:Query ATTI#",
  "ledger dynamodb:GetItem TXID#",
]);

/* ================================================================== */

describe("JX-4C: the operator's IAM against the JX-3B / JX-4B evidence reads (a permission contract)", () => {
  test("the contract reads the policies it claims to: both halves, the JX-4C statements included", () => {
    assert.deepEqual(
      POLICY.app.map((g) => `${g.sid}:${g.table}`).sort(),
      ["GameTableRead:game", "IdentityEvidenceRead:identity", "IdentityWriterRoleRead:identity", "LedgerJournalQuery:ledger", "LedgerRead:ledger", "OperatorRunHeadsAndRunPools:game", "RoutingAndEvidence:game"].sort(),
    );
    assert.deepEqual(POLICY.ledger.map((g) => g.sid).sort(), ["OperatorJournalQuery", "OperatorLedgerReadOnly"]);
    /* The evaluator itself: what IAM must and must not allow. */
    assert.equal(permitted(POLICY, "identity", "dynamodb:GetItem", "PRIN#pr_x"), true);
    assert.equal(permitted(POLICY, "identity", "dynamodb:GetItem", "SESS#se_x"), false);
    assert.equal(permitted(POLICY, "identity", "dynamodb:Scan", null), false);
    assert.equal(permitted(POLICY, "identity", "dynamodb:Query", "PRIN#pr_x"), false);
    assert.equal(permitted(POLICY, "ledger", "dynamodb:Query", "ATTI#x"), true);
    assert.equal(permitted(POLICY, "ledger", "dynamodb:Query", "SEC#pr_x"), false);
    assert.equal(permitted(withdraw(POLICY, "ledger", "OperatorJournalQuery", { action: "dynamodb:Query" }), "ledger", "dynamodb:Query", "ATTI#x"), false, "the ledger half alone refuses");
    assert.equal(permitted(POLICY, "ledger", "dynamodb:PutItem", "ATTI#x"), false);
  });

  test("1 + 4 + 5. as written: every evidence read is allowed -- journal MATCH, standing judged -- inside the audited surface; nothing secret requested or printed", async () => {
    const e = await moneyEvidenceWorld("started");
    try {
      const { tables, secrets } = await project(e);
      const m = await money(e, tables, POLICY);
      assert.deepEqual(m.requests.filter((r) => !r.allowed), [], "no read is denied");
      assert.equal(m.code, EXIT.ok, `${m.err.join("\n")}\n${JSON.stringify(m.view.checks, null, 1)}`);
      assert.equal(m.view.verdicts.journal, "JOURNAL MATCH");
      assert.equal(check(m.view, "7"), "pass");
      assert.equal(check(m.view, "3b"), "pass", "standing judged by identity");
      assert.equal(m.view.tickets.grants?.identity.read, true);
      assert.ok((m.view.tickets.grants?.grants.length ?? 0) > 0 && m.view.tickets.grants!.grants.every((grant) => grant.standing !== null), "every grant's standing evaluated");
      const g = await grants(e, tables, POLICY);
      assert.deepEqual(g.requests.filter((r) => !r.allowed), []);
      assert.equal(g.code, EXIT.ok, g.text);
      assert.equal(g.view.identity.read, true);
      assert.ok(g.view.grants.every((grant) => grant.standing !== null));
      /* The audited surface, exactly: every request inside it, and the identity / ledger classes actually exercised. */
      const seen = new Set([...m.requests, ...g.requests].map((r) => `${r.table} ${r.action} ${classOf(r.pk)}`));
      assert.deepEqual([...seen].filter((s) => !READ_SURFACE.has(s)), [], "a read outside the audited surface needs a JX-4C-style review first");
      for (const needed of ["identity dynamodb:GetItem PRIN#", "identity dynamodb:GetItem PROF#", "identity dynamodb:GetItem FAM#", "ledger dynamodb:Query ATTI#", "ledger dynamodb:GetItem TXID#"]) assert.ok(seen.has(needed), needed);
      /* Nothing of the other identity classes is even requested; nothing private is printed. */
      assert.ok([...m.requests, ...g.requests].every((r) => r.table !== "identity" || ["PRIN#", "PROF#", "FAM#"].includes(classOf(r.pk))));
      for (const secret of secrets) {
        assert.ok(!m.text.includes(secret), "money prints no identity secret, selector, name or id");
        assert.ok(!g.text.includes(secret), "wallet-grants prints no identity secret, selector, name or id");
      }
      const text = await operator(e, tables, POLICY, ["money", e.gameId]);
      const grantsText = await operator(e, tables, POLICY, ["wallet-grants", e.gameId]);
      for (const secret of secrets) {
        assert.ok(!text.text.includes(secret), "the money text view neither");
        assert.ok(!grantsText.text.includes(secret), "the wallet-grants text view neither");
      }
    } finally {
      await e.world.close();
    }
  });

  test("2. either half of the ledger Query withdrawn: JOURNAL NOT EVALUATED (exit 1) -- never a MATCH, never a PASS", async () => {
    const e = await moneyEvidenceWorld("started");
    try {
      const { tables } = await project(e);
      for (const [half, sid] of [["app", "LedgerJournalQuery"], ["ledger", "OperatorJournalQuery"]] as const) {
        const m = await money(e, tables, withdraw(POLICY, half, sid, { action: "dynamodb:Query" }));
        assert.ok(m.requests.some((r) => r.table === "ledger" && r.action === "dynamodb:Query" && !r.allowed), `${half}: the Query was refused`);
        assert.equal(m.code, EXIT.findings, half);
        assert.equal(m.view.verdicts.journal, "JOURNAL NOT EVALUATED", half);
        assert.equal(check(m.view, "7"), "not-evaluated", half);
        assert.equal(m.view.summary.clean, false, half);
      }
    } finally {
      await e.world.close();
    }
  });

  test("3. any one identity class withdrawn: standing NOT EVALUATED (exit 1) -- never guessed", async () => {
    const e = await moneyEvidenceWorld("started");
    try {
      const { tables } = await project(e);
      for (const pattern of ["PRIN#*", "PROF#*", "FAM#*"]) {
        const policy = withdraw(POLICY, "app", "IdentityEvidenceRead", { pattern });
        const m = await money(e, tables, policy);
        assert.ok(m.requests.some((r) => r.table === "identity" && !r.allowed), `${pattern}: an identity read was refused`);
        assert.equal(m.code, EXIT.findings, pattern);
        assert.equal(check(m.view, "3b"), "not-evaluated", pattern);
        assert.ok(m.view.tickets.grants?.grants.every((grant) => grant.standing === null), `${pattern}: standing is never guessed`);
        const g = await grants(e, tables, policy);
        assert.equal(g.code, EXIT.findings, pattern);
        assert.equal(g.view.identity.read, false, pattern);
        assert.ok(g.view.grants.every((grant) => grant.standing === null), pattern);
      }
    } finally {
      await e.world.close();
    }
  });

  test("the IAM classes stay META-only: under PRIN# / PROF# / FAM# no item but the record itself exists (IAM cannot restrict the sort key)", () => {
    /* IdentityEvidenceRead grants GetItem by PARTITION class. identityItems.ts names planned index items (PRIN#/SESS#,
       PRIN#/FAM#, FAM#/SESS#) that would share these partitions -- and session ids are not the operator's to read. Adding
       any item under these prefixes must fail here first, and come back to a JX-4C-style review of the operator grant. */
    assert.deepEqual([identityKeys.principal("pr_x").sk, identityKeys.profile("pf_x").sk, identityKeys.family("sf_x").sk], ["META", "META", "META"]);
    for (const pk of ["PRIN#pr_x", "PROF#pf_x", "FAM#sf_x"]) {
      for (const sk of ["SESS#se_x", "FAM#sf_x", "PROFILE", "LINK", "GRANT", "SESS", "META#1", ""]) assert.equal(classOfKey(pk, sk), null, `${pk} / ${sk} is no item class of this layout`);
      assert.notEqual(classOfKey(pk, "META"), null);
    }
  });

  test("5. --tx-bytes under the contract: the same exact stored bytes, from the game table only", async () => {
    const e = await moneyEvidenceWorld("started");
    try {
      const { tables } = await project(e);
      const stored = (await e.startIntent())!;
      const args = ["money", e.gameId, "--json", "--tx-bytes", stored.intent_id, ...(stored.attempts.length > 1 ? ["--tx-hash", stored.attempts.at(-1)!.tx_hash] : [])];
      const under = await operator(e, tables, POLICY, args);
      assert.equal(under.code, EXIT.ok, under.text);
      assert.deepEqual(under.requests.filter((r) => !r.allowed), []);
      assert.ok(under.requests.every((r) => r.table === "game"), "--tx-bytes reads the game table only (unchanged)");
      const exported = JSON.parse(under.out.join("\n")) as { tx_base64: string; tx_hash: string };
      const attempt = stored.attempts.find((a) => a.tx_hash === exported.tx_hash)!;
      assert.equal(exported.tx_base64, attempt.tx_bytes, "byte for byte the stored TxRaw");
    } finally {
      await e.world.close();
    }
  });
});
