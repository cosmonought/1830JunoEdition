// server/src/escrow/juno/junoConfigLedger.test.ts
//
// ==================================================================
//  LIVE-5 L5-5: THE CONFIGURATION OF THE SIGNING LEDGER AND THE KMS KEYS -- EXPLICIT, NEVER A FALLBACK
// ==================================================================
//
// `18COSMOS/JUNO-BACKEND/v3` names the signing journal's KIND (`file` with its directory, or the DynamoDB ledger by its
// table ARN) instead of v2's bare `journal_dir`; v2 stays accepted, exactly as it was. Every KMS key -- in either format --
// is named by its key ARN and every one of them is in one region, read from the ARNs, never from the environment. A
// configuration that names the ledger is refused by `start.ts` until L5-7 wires it: it never becomes a file journal.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { publicKeyOf } from "./secp256k1";
import { fileJournalDirOf, JunoConfigError, JUNO_BACKEND_CONFIG_FORMAT, JUNO_BACKEND_CONFIG_FORMAT_V3, parseJunoBackendConfig } from "./junoConfig";
import { ADMISSION_PUBKEY, CANONICAL_CHECKSUM, CHAIN_ID, CONTRACT, RELAYER_ADDRESS, SETTLEMENT_SECRET } from "../escrow3bSupport";

const KEY = (n: number, region = "us-east-1") => `arn:aws:kms:${region}:123456789012:key/${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const TABLE = "arn:aws:dynamodb:us-east-1:210987654321:table/gs-prod-ledger";
const dev = { serverMode: "development" as const, dataDir: "/data" };
const prod = { serverMode: "production" as const, dataDir: "/data" };

/** A v2 configuration as ESCROW-JOIN wrote it (development keys, a file journal). */
const v2 = (over: Record<string, unknown> = {}) => ({
  format: JUNO_BACKEND_CONFIG_FORMAT,
  chain_id: CHAIN_ID,
  network_class: "testnet",
  rest_endpoints: ["https://rest.example"],
  contract_address: CONTRACT,
  code_checksum: CANONICAL_CHECKSUM,
  wasm_admin: null,
  denom: "ujunox",
  asset_symbol: "JUNOX",
  relayer: { address: RELAYER_ADDRESS, signer: { kind: "development", key_file: "/keys/relayer.key" } },
  settlement_key: { signer_key_id: 1, public_key_hex: publicKeyOf(SETTLEMENT_SECRET).toString("hex"), signer: { kind: "development", key_file: "/keys/settlement.key" } },
  admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "development", key_file: "/keys/admission.key" } },
  trust: { operators: [RELAYER_ADDRESS], resolvers: [RELAYER_ADDRESS], min_challenge_window_secs: "60", min_liveness_window_secs: "3600", min_resolver_timeout_secs: "3600" },
  journal_dir: "/journal",
  dev_signer: "allow-unprotected-testnet-key",
  ...over,
});

/** A v3 production configuration: three KMS keys (by ARN, one region) and the DynamoDB ledger. */
const v3 = (over: Record<string, unknown> = {}) => {
  const { journal_dir: _dir, dev_signer: _dev, ...rest } = v2();
  return {
    ...rest,
    format: JUNO_BACKEND_CONFIG_FORMAT_V3,
    relayer: { address: RELAYER_ADDRESS, signer: { kind: "kms", key_ref: KEY(1) } },
    settlement_key: { signer_key_id: 1, public_key_hex: publicKeyOf(SETTLEMENT_SECRET).toString("hex"), signer: { kind: "kms", key_ref: KEY(2) } },
    admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "kms", key_ref: KEY(3) } },
    journal: { kind: "dynamodb", table_arn: TABLE },
    ...over,
  };
};

function problems(raw: unknown, context: { readonly serverMode: "development" | "production"; readonly dataDir: string } = dev): string {
  try {
    parseJunoBackendConfig(raw, context);
    return "";
  } catch (error) {
    assert.ok(error instanceof JunoConfigError, String(error));
    return error.problems.join(" | ");
  }
}

describe("L5-5 configuration: v2 exactly as before", () => {
  test("v2 is a file journal at journal_dir; it knows no `journal` field; development keys name no KMS region", () => {
    const parsed = parseJunoBackendConfig(v2(), dev);
    assert.deepEqual(parsed.journal, { kind: "file", dir: "/journal" });
    assert.equal(parsed.format, JUNO_BACKEND_CONFIG_FORMAT);
    assert.equal(parsed.kmsRegion, null);
    assert.equal(fileJournalDirOf(parsed), "/journal");
    assert.match(problems(v2({ journal: { kind: "dynamodb", table_arn: TABLE } })), /unknown field journal/);
    assert.match(problems(v2({ journal_dir: "relative/journal" })), /journal_dir must be an absolute path/);
    assert.match(problems(v2({ journal_dir: "/data/journal" }), prod), /journal_dir must be OUTSIDE the data directory in production/);
    assert.match(problems(v2({ format: "18COSMOS/JUNO-BACKEND/v1" })), /format must be 18COSMOS\/JUNO-BACKEND\/v2/);
  });
});

describe("L5-5 configuration: v3 names the journal's kind -- and nothing defaults", () => {
  test("the DynamoDB ledger, by its table ARN, with three KMS keys in one region: accepted in production", () => {
    const parsed = parseJunoBackendConfig(v3(), prod);
    assert.deepEqual(parsed.journal, { kind: "dynamodb", tableArn: TABLE, region: "us-east-1", account: "210987654321", table: "gs-prod-ledger" });
    assert.equal(parsed.kmsRegion, "us-east-1");
    assert.deepEqual(parsed.relayer.signer, { kind: "kms", key_ref: KEY(1) });
  });

  test("a v3 file journal: its absolute directory, outside the data directory in production", () => {
    const parsed = parseJunoBackendConfig(v3({ journal: { kind: "file", dir: "/journal" } }), prod);
    assert.deepEqual(parsed.journal, { kind: "file", dir: "/journal" });
    assert.equal(fileJournalDirOf(parsed), "/journal");
    assert.match(problems(v3({ journal: { kind: "file", dir: "/data/journal" } }), prod), /journal.dir must be OUTSIDE the data directory/);
    assert.match(problems(v3({ journal: { kind: "file", dir: "journal" } })), /journal.dir must be an absolute path/);
    assert.match(problems(v3({ journal: { kind: "file", dir: "/journal", lock: true } })), /unknown field journal.lock/);
  });

  test("no journal, an unknown kind, v2's journal_dir, a malformed ledger ARN: refused -- never read as a file journal", () => {
    const { journal: _journal, ...none } = v3();
    assert.match(problems(none), /journal must be/);
    assert.match(problems(v3({ journal: { kind: "s3", bucket: "x" } })), /journal.kind must be "file" or "dynamodb".*nothing defaults/);
    assert.match(problems(v3({ journal: "/journal" })), /journal must be/);
    assert.match(problems(v3({ journal_dir: "/journal" })), /unknown field journal_dir/);
    for (const arn of [
      "gs-prod-ledger",
      "arn:aws:dynamodb:us-east-1:210987654321:table/gs-prod-ledger/index/by-x",
      "arn:aws:dynamodb:us-east-1:210987654321:table/gs-prod-ledger/stream/2026",
      "arn:aws-cn:dynamodb:cn-north-1:210987654321:table/gs-prod-ledger",
      "arn:aws:dynamodb:gs-local:210987654321:table/gs-prod-ledger",
      "arn:aws:dynamodb:us-east-1:21098765432:table/gs-prod-ledger",
      "arn:aws:kms:us-east-1:210987654321:key/11111111-1111-4111-8111-111111111111",
    ]) {
      assert.match(problems(v3({ journal: { kind: "dynamodb", table_arn: arn } })), /journal.table_arn/, arn);
    }
    assert.match(problems(v3({ journal: { kind: "dynamodb", table_arn: TABLE, endpoint: "http://127.0.0.1:8000" } })), /unknown field journal.endpoint/);
  });

  test("start.ts opens only a file journal: a configuration naming the ledger is refused (L5-7 wires it), never a fallback", () => {
    const parsed = parseJunoBackendConfig(v3(), prod);
    assert.throws(() => fileJournalDirOf(parsed), (error: JunoConfigError) => error instanceof JunoConfigError && /DynamoDB signing ledger/.test(error.message) && /L5-7/.test(error.message) && /never falls back to a file journal/.test(error.message));
  });
});

describe("L5-5 configuration: KMS keys by key ARN, in one explicit region", () => {
  test("an alias, a bare key id, another service, a non-region: refused (in v2 as in v3)", () => {
    for (const make of [v2, v3]) {
      const kms = (key_ref: string) => make({ relayer: { address: RELAYER_ADDRESS, signer: { kind: "kms", key_ref } } });
      assert.match(problems(kms("arn:aws:kms:us-east-1:123456789012:alias/relayer")), /relayer.signer.key_ref: .*ALIAS ARN/);
      assert.match(problems(kms("11111111-1111-4111-8111-111111111111")), /relayer.signer.key_ref/);
      assert.match(problems(kms("alias/relayer")), /relayer.signer.key_ref/);
      assert.match(problems(kms("arn:aws:secretsmanager:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111")), /relayer.signer.key_ref/);
      assert.match(problems(kms(KEY(1, "gs-local"))), /relayer.signer.key_ref: gs-local is not an AWS region/);
    }
  });

  test("KMS keys in two regions are refused: one configuration, one KMS region -- read from the ARNs, never from the environment", () => {
    assert.match(problems(v3({ admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "kms", key_ref: KEY(3, "eu-west-1") } } })), /one region \(these name eu-west-1, us-east-1\)/);
    const saved = { AWS_REGION: process.env.AWS_REGION, AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION };
    process.env.AWS_REGION = "ap-south-1";
    process.env.AWS_DEFAULT_REGION = "ap-south-1";
    try {
      assert.equal(parseJunoBackendConfig(v3(), prod).kmsRegion, "us-east-1", "the environment's region is never used");
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("the three roles never share a key, and a development key stays refused in production (unchanged rules, v3 too)", () => {
    assert.match(problems(v3({ admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "kms", key_ref: KEY(1) } } })), /admission key and the relayer key must be different keys/);
    assert.match(problems(v3({ settlement_key: { signer_key_id: 1, public_key_hex: publicKeyOf(SETTLEMENT_SECRET).toString("hex"), signer: { kind: "kms", key_ref: KEY(1) } } })), /settlement key and the relayer key must be different keys/);
    assert.match(problems(v3({ relayer: { address: RELAYER_ADDRESS, signer: { kind: "development", key_file: "/keys/relayer.key" } } }), prod), /development signer is refused in production/);
  });
});
