// server/src/aws/operator/operatorTarget.ts
//
// ==================================================================
//  LIVE-6 L6-3: WHICH AWS DEPLOYMENT THE OPERATOR TOOL LOOKS AT -- L5-7's REFERENCE MODEL, READ THE SAME WAY, FAIL CLOSED
// ==================================================================
//
// `gamesDoctor aws ...` is pointed at a deployment exactly as an AWS task is (L5-7, `runtime/runtimeConfig.ts`): by the
// SSM parameter ARN of the runtime document `18COSMOS/AWS-RUNTIME/v1` -- `--aws-config <arn>` or `GS_AWS_CONFIG_PARAMETER`
// (they must agree). The document is read through L5-7's `ParameterSource` (a plain `String` parameter; a `SecureString`
// is refused) and parsed by L5-7's own `parseAwsRuntimeConfigText`: the game and identity tables, the ledger by its full
// ARN, the regions, the configured pool and generation. With escrow, the Juno configuration it names is read the same
// way and checked by `parseJunoBackendConfig` (production) and `checkEscrowConfigForAws` -- only to learn the relayer
// ACCOUNT (the `ROLE#relayer#<account>` mirror and the ledger's `FENCE#relayer#<account>`); a problem there is reported,
// and the relayer is then not inspected, but nothing else is refused (no mutation needs it).
//
// CREDENTIALS. There is no argument or document field that carries one. The clients come from `awsClients.ts` only
// (explicit regions, SDK retries off, bounded throwing timeouts, no configured endpoint can redirect them), and take the
// SDK's default chain -- on ECS the ops task role (preflight §18.1), on a workstation a profile or SSO session. Static keys
// in the environment (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`) are refused as L5-7 refuses them,
// by NAME: a value is never read into a message (for a real AWS target; a DynamoDB Local client never reads them).
//
// DYNAMODB LOCAL (development and tests): `GS_DYNAMODB_LOCAL_ENDPOINT` (a loopback http endpoint, `awsClients.ts`'s rule)
// with `--local-document <file>` -- a runtime document of the same format whose table names (and the ledger ARN's table
// part) are the local tables. Its escrow is not read (no SSM there): `--relayer <account>` names the account to inspect.
// Nothing else is accepted: no endpoint flag, no table flag, no credential.

import { promises as fs } from "fs";
import * as path from "path";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { parseSsmParameterArn } from "../arns";
import { createDynamoDbClient, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../awsClients";
import { relayerAccountProblem } from "../game/relayerRole";
import { ssmParameterSource, type ParameterSource } from "../runtime/configSource";
import { AWS_CONFIG_ENV, AWS_CONFIG_FLAG, checkEscrowConfigForAws, parseAwsRuntimeConfigText, REFUSED_CREDENTIAL_ENV, type AwsRuntimeConfig } from "../runtime/runtimeConfig";
import { flagValues, single, type Env } from "../runtime/storageMode";
import { parseJunoBackendConfig } from "../../escrow/juno/junoConfig";

export const LOCAL_DOCUMENT_FLAG = "--local-document";
export const RELAYER_FLAG = "--relayer";

/** The operator was given something it refuses to run with (exit 2). The message names settings, never values. */
export class OperatorRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorRefusal";
  }
}

export interface OperatorTables {
  readonly game: string;
  readonly identity: string;
  /** The ledger as its client addresses it: the full table ARN on AWS (cross-account), the table name locally. */
  readonly ledger: string;
}

/** What the escrow configuration said about the relayer (the only thing the tool needs from it). */
export type EscrowView =
  | { readonly state: "none" }
  | { readonly state: "ok"; readonly arn: string | null; readonly version: number | null; readonly relayer: string }
  | { readonly state: "unreadable"; readonly arn: string | null; readonly detail: string }
  /** DynamoDB Local: the document names an escrow, which is not read there (`--relayer` names the account). */
  | { readonly state: "not-read"; readonly arn: string | null };

export interface OperatorTarget {
  readonly kind: "aws" | "dynamodb-local";
  /** The app account's region: the game and identity tables. */
  readonly app: DynamoDBClient;
  /** The ledger's region (the same client when the regions agree). */
  readonly ledger: DynamoDBClient;
  readonly tables: OperatorTables;
  /** The runtime document (the configured pool, generation, environment...). */
  readonly config: AwsRuntimeConfig;
  readonly source: { readonly arn: string | null; readonly version: number | null; readonly file: string | null };
  readonly escrow: EscrowView;
  destroy(): void;
}

/** A NO_DATA_DIRECTORY for the Juno parser (an AWS configuration names no file journal; this path is never touched). */
const NO_DATA_DIRECTORY = "/nonexistent/gs-aws-operator-has-no-data-directory";

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Settings the AWS operator refuses outright (names only). Static keys are refused for a real AWS target; a DynamoDB
 *  Local client never reads them (it signs with fixed dummy keys, `awsClients.ts`). */
export function operatorReferenceProblems(argv: readonly string[], env: Env, kind: "aws" | "dynamodb-local" = "aws"): string[] {
  const problems: string[] = [];
  const credentials = kind === "aws" ? REFUSED_CREDENTIAL_ENV.filter((name) => env[name] !== undefined) : [];
  if (credentials.length > 0) {
    problems.push(`${credentials.join(", ")} ${credentials.length === 1 ? "is" : "are"} set: the AWS operator takes its credentials only from the SDK's default chain (the ops task role, a profile or an SSO session), never from static keys in the environment`);
  }
  if (flagValues(argv, "--data").length > 0) problems.push("--data is a file-mode setting: `gamesDoctor aws` reads DynamoDB only, and never a data directory");
  if (flagValues(argv, "--escrow-config").length > 0) problems.push("--escrow-config is a file-mode setting: in AWS the escrow configuration is the runtime document's escrow.config_parameter_arn");
  return problems;
}

/**
 * Resolve the deployment the operator named (see the header). Throws `OperatorRefusal` for anything it refuses to run
 * with. `parameters` / `readFile` / `clientFor` are seams for the tests (production: SSM, the file system, `awsClients`).
 */
export async function resolveOperatorTarget(input: {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly parameters?: ParameterSource;
  readonly readFile?: (file: string) => Promise<string>;
  readonly clientFor?: (target: { readonly kind: "aws"; readonly region: string } | { readonly kind: "dynamodb-local"; readonly endpoint: string }) => DynamoDBClient;
}): Promise<OperatorTarget> {
  const local = flagValues(input.argv, LOCAL_DOCUMENT_FLAG);
  const problems = operatorReferenceProblems(input.argv, input.env, local.length > 0 ? "dynamodb-local" : "aws");
  if (problems.length > 0) throw new OperatorRefusal(problems.join("; "));
  const clientFor = input.clientFor ?? ((target) => createDynamoDbClient(target));
  const relayerFlag = flagValues(input.argv, RELAYER_FLAG);

  if (local.length > 0) {
    /* ---- DynamoDB Local ---- */
    if (local.length > 1 || local[0] === "") throw new OperatorRefusal(`${LOCAL_DOCUMENT_FLAG} names one file`);
    let endpoint;
    try {
      endpoint = dynamoLocalTargetFromEnv(input.env as NodeJS.ProcessEnv);
    } catch (error) {
      throw new OperatorRefusal(describe(error));
    }
    if (endpoint === null) throw new OperatorRefusal(`${LOCAL_DOCUMENT_FLAG} runs only against DynamoDB Local: set ${DYNAMODB_LOCAL_ENV} to its loopback endpoint`);
    if (single(input.argv, input.env, AWS_CONFIG_ENV, AWS_CONFIG_FLAG).value !== undefined) throw new OperatorRefusal(`${LOCAL_DOCUMENT_FLAG} and ${AWS_CONFIG_ENV} / ${AWS_CONFIG_FLAG} name two deployments: give one`);
    const file = path.resolve(local[0]);
    let text: string;
    try {
      text = input.readFile !== undefined ? await input.readFile(file) : (await fs.readFile(file)).toString("utf8");
    } catch (error) {
      throw new OperatorRefusal(`the local runtime document ${file} cannot be read (${describe(error)})`);
    }
    let config: AwsRuntimeConfig;
    try {
      config = parseAwsRuntimeConfigText(text);
    } catch (error) {
      throw new OperatorRefusal(`the local runtime document ${file} does not check -- ${describe(error)}`);
    }
    if (relayerFlag.length > 1) throw new OperatorRefusal(`${RELAYER_FLAG} names one account`);
    let escrow: EscrowView = config.escrow === null ? { state: "none" } : { state: "not-read", arn: config.escrow.configParameter.arn };
    if (relayerFlag.length === 1) {
      const problem = relayerAccountProblem(relayerFlag[0]);
      if (problem !== null) throw new OperatorRefusal(`${RELAYER_FLAG}: ${problem}`);
      escrow = { state: "ok", arn: null, version: null, relayer: relayerFlag[0] };
    }
    const client = clientFor(endpoint);
    return {
      kind: "dynamodb-local",
      app: client,
      ledger: client,
      tables: { game: config.gameTable, identity: config.identityTable, ledger: config.ledger.table },
      config,
      source: { arn: null, version: null, file },
      escrow,
      destroy: () => client.destroy(),
    };
  }

  /* ---- AWS ---- */
  if (relayerFlag.length > 0) throw new OperatorRefusal(`${RELAYER_FLAG} is for DynamoDB Local only: on AWS the relayer account is the escrow configuration's`);
  const reference = single(input.argv, input.env, AWS_CONFIG_ENV, AWS_CONFIG_FLAG);
  if (reference.conflict !== undefined) throw new OperatorRefusal(reference.conflict);
  if (reference.value === undefined) throw new OperatorRefusal(`${AWS_CONFIG_ENV} (or ${AWS_CONFIG_FLAG}) is required: the SSM parameter ARN of the deployment's runtime configuration (or, for DynamoDB Local, ${LOCAL_DOCUMENT_FLAG})`);
  const arn = parseSsmParameterArn(reference.value);
  if ("problem" in arn) throw new OperatorRefusal(`${AWS_CONFIG_ENV}: ${arn.problem}`);
  const parameters = input.parameters ?? ssmParameterSource();
  let config: AwsRuntimeConfig;
  let version: number;
  try {
    const read = await parameters.read(arn.arn);
    config = parseAwsRuntimeConfigText(read.value);
    version = read.version;
  } catch (error) {
    throw new OperatorRefusal(`the runtime configuration ${arn.arn} is not usable -- ${describe(error)}`);
  }
  let escrow: EscrowView = { state: "none" };
  if (config.escrow !== null) {
    const where = config.escrow.configParameter.arn;
    try {
      const read = await parameters.read(where);
      let raw: unknown;
      try {
        raw = JSON.parse(read.value);
      } catch {
        throw new Error("it is not JSON");
      }
      const juno = parseJunoBackendConfig(raw, { serverMode: "production", dataDir: NO_DATA_DIRECTORY });
      const aws = checkEscrowConfigForAws(juno, config);
      if (aws.length > 0) throw new Error(aws.join("; "));
      escrow = { state: "ok", arn: where, version: read.version, relayer: juno.relayer.address };
    } catch (error) {
      escrow = { state: "unreadable", arn: where, detail: describe(error) };
    }
  }
  const app = clientFor({ kind: "aws", region: config.region });
  const ledger = config.ledger.region === config.region ? app : clientFor({ kind: "aws", region: config.ledger.region });
  return {
    kind: "aws",
    app,
    ledger,
    tables: { game: config.gameTable, identity: config.identityTable, ledger: config.ledger.arn },
    config,
    source: { arn: arn.arn, version, file: null },
    escrow,
    destroy: () => {
      app.destroy();
      if (ledger !== app) ledger.destroy();
    },
  };
}
