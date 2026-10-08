// server/src/aws/runtime/runtimeConfig.ts
//
// ==================================================================
//  LIVE-5 L5-7: THE AWS STORAGE MODE'S REFERENCES AND ITS ONE CONFIGURATION DOCUMENT -- PARSED STRICTLY, FAIL CLOSED
// ==================================================================
//
// THE STORAGE MODE. `GS_STORAGE` (or `--storage`) is `file` -- today's PROCESS mode, the data directory and its lock,
// byte-for-byte unchanged -- or `aws`. Absent means `file`, so every existing start command keeps working exactly as
// before; any other value refuses the start (exit 2), and so does an environment and a flag that disagree.
//
// THE AWS MODE'S ENVIRONMENT holds REFERENCES ONLY (preflight §11.6):
//   GS_MODE=production                       AWS storage is production-only (development identity is loopback-only and
//                                            never points at real tables);
//   GS_AWS_CONFIG_PARAMETER=<SSM param ARN>  (or `--aws-config`) the one runtime configuration document below;
//   BUILD_ID, PORT, GS_ALLOWED_ORIGINS, GS_TRUSTED_PROXY_HOPS, ESCROW_MONEY_TABLES   as in PROCESS mode.
// Refused in AWS mode, with the reason, never ignored:
//   DATA_DIR / --data                        AWS storage keeps no data directory (nothing ever falls back to files);
//   ESCROW_JUNO_CONFIG / --escrow-config     the escrow configuration is the runtime document's SSM reference;
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN
//                                            credentials in the environment: the task role (the SDK's default chain on
//                                            ECS) is the only credential source (their VALUES are never read or printed).
//
// THE RUNTIME DOCUMENT (`18COSMOS/AWS-RUNTIME/v1`, a JSON SSM `String` parameter; no secret in it, ever):
//
//   {
//     "format":           "18COSMOS/AWS-RUNTIME/v1",
//     "environment":      "prod",                     a label for the startup lines ([a-z][a-z0-9-]{0,31})
//     "region":           "us-east-1",                the app account's region: the game and identity tables
//     "pool":             "p1",                       this task's pool (a pool id; never an operator run `op:`)
//     "generation":       1,                          the adopted app generation this task is for (the ledger's APPGEN
//                                                     must equal it at startup, and keep equalling it)
//     "game_table":       "gs-prod-game-g1",          table NAMES in the app account (`region`)
//     "identity_table":   "gs-prod-identity",
//     "ledger_table_arn": "arn:aws:dynamodb:us-east-1:<ledger account>:table/gs-prod-ledger",
//                                                     the ledger by its full table ARN (cross-account; its region is the
//                                                     ARN's): APPGEN, SEC#, and -- with escrow -- the signing journal
//     "escrow":           null | { "config_parameter_arn": "<SSM param ARN>" }
//                                                     the Juno backend configuration (`18COSMOS/JUNO-BACKEND/v3`), itself
//                                                     an SSM String parameter; null: no escrow (money games stay off)
//   }
//
// Every field is required, nothing else is allowed, and a value that does not check refuses the start: a typo is never a
// default. With escrow, the Juno configuration must name the SAME ledger (`journal: {kind: "dynamodb", table_arn}`) and
// only KMS keys (`checkEscrowConfigForAws`): an AWS task never opens a file journal and never a development signer.
//
// LIVE-6 L6-1: FORMAT v2 (`18COSMOS/AWS-RUNTIME/v2`) is v1 plus ONE required field, the deployment's TRUSTED ROUTE TABLE:
//
//   "routes": { "<pool>": { "ws_path": "/gs/p/<pool>", "bundle_path": "/r/<release>/" (optional) }, ... }   ({} allowed)
//
// -- where each pool the deployment exposes is reached: its socket path on the game server's origin (under `/gs/`, which
// the edge forwards to the game servers; the load balancer's rule for it must send it to that pool's tasks), and, when the
// pool plays another release's games, that release's bundle path on the page's origin. PATHS ONLY: never a host, a scheme,
// a query or an escape (`rooms/gameRoutes.ts` `routeEntryProblem`, the client's own `safeRoutePath`), so a route can never
// send a browser off-site. It is the ONLY source of a route's path; which pool a game is routed to comes from the tables
// (the game's HEAD, `SYSTEM/ROUTING`), never from here. A v1 document is still accepted, unchanged: it has no route table,
// so no route destination exists and every "not here" is answered exactly as before L6-1.

import { isAwsRegion, parseDynamoTableArn, parseSsmParameterArn, type DynamoTableArn, type SsmParameterArn } from "../arns";
import { primaryPoolProblem } from "../game/routing";
import { routeEntryProblem, type PoolRouteEntry } from "../../rooms/gameRoutes";
import type { JunoBackendConfig, SignerRef } from "../../escrow/juno/junoConfig";
import { flagValues, single, STORAGE_ENV, type Env } from "./storageMode";

export const AWS_RUNTIME_CONFIG_FORMAT = "18COSMOS/AWS-RUNTIME/v1";
/** LIVE-6 L6-1: v1 plus the trusted route table (`routes`). */
export const AWS_RUNTIME_CONFIG_FORMAT_V2 = "18COSMOS/AWS-RUNTIME/v2";
/** The most pools one route table names. */
export const MAX_ROUTE_ENTRIES = 32;

export const AWS_CONFIG_ENV = "GS_AWS_CONFIG_PARAMETER";
export const AWS_CONFIG_FLAG = "--aws-config";

/** Environment variables an AWS task refuses to start with: static credentials (the task role is the only source). */
export const REFUSED_CREDENTIAL_ENV: readonly string[] = Object.freeze(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]);

export class AwsRuntimeConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the AWS runtime configuration does not check: ${problems.join("; ")}`);
    this.name = "AwsRuntimeConfigError";
  }
}

export interface AwsRuntimeConfig {
  readonly format: typeof AWS_RUNTIME_CONFIG_FORMAT | typeof AWS_RUNTIME_CONFIG_FORMAT_V2;
  readonly environment: string;
  readonly region: string;
  readonly pool: string;
  readonly generation: number;
  readonly gameTable: string;
  readonly identityTable: string;
  readonly ledger: DynamoTableArn;
  readonly escrow: null | { readonly configParameter: SsmParameterArn };
  /** LIVE-6 L6-1: the trusted route table (v2); empty for a v1 document (no route destination exists). */
  readonly routes: Readonly<Record<string, PoolRouteEntry>>;
}

/* -------------------------------------------------------------------- */
/* The references: environment and flags                                 */
/* -------------------------------------------------------------------- */

export interface AwsStartupReferences {
  readonly configParameter: SsmParameterArn;
}

/**
 * The AWS mode's references, and every setting it refuses (see the header). Only NAMES of refused variables are ever put
 * in a reason: a credential's value is never read into a message.
 */
export function awsStartupReferences(argv: readonly string[], env: Env, serverMode: "development" | "production"): { readonly ok: true; readonly refs: AwsStartupReferences } | { readonly ok: false; readonly reason: string } {
  const problems: string[] = [];
  if (serverMode !== "production") problems.push(`${STORAGE_ENV}=aws runs only with GS_MODE=production (development identity is loopback-only and never points at AWS tables)`);
  if (env.DATA_DIR !== undefined || flagValues(argv, "--data").length > 0) problems.push("DATA_DIR / --data is refused: AWS storage keeps no data directory, and nothing falls back to files");
  if (env.ESCROW_JUNO_CONFIG !== undefined || flagValues(argv, "--escrow-config").length > 0) {
    problems.push("ESCROW_JUNO_CONFIG / --escrow-config is refused: in AWS storage the escrow configuration is the runtime document's escrow.config_parameter_arn");
  }
  const credentials = REFUSED_CREDENTIAL_ENV.filter((name) => env[name] !== undefined);
  if (credentials.length > 0) problems.push(`${credentials.join(", ")} ${credentials.length === 1 ? "is" : "are"} set: AWS storage takes its credentials only from the task role (the SDK's default chain), never from the environment`);
  const parameter = single(argv, env, AWS_CONFIG_ENV, AWS_CONFIG_FLAG);
  let configParameter: SsmParameterArn | null = null;
  if (parameter.conflict !== undefined) problems.push(parameter.conflict);
  else if (parameter.value === undefined) problems.push(`${AWS_CONFIG_ENV} (or ${AWS_CONFIG_FLAG}) is required: the SSM parameter ARN of the runtime configuration`);
  else {
    const parsed = parseSsmParameterArn(parameter.value);
    if ("problem" in parsed) problems.push(`${AWS_CONFIG_ENV}: ${parsed.problem}`);
    else configParameter = parsed;
  }
  if (problems.length > 0 || configParameter === null) return { ok: false, reason: problems.join("; ") };
  return { ok: true, refs: { configParameter } };
}

/* -------------------------------------------------------------------- */
/* The document                                                          */
/* -------------------------------------------------------------------- */

const FIELDS = ["format", "environment", "region", "pool", "generation", "game_table", "identity_table", "ledger_table_arn", "escrow"] as const;
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The runtime document, from its JSON text. Throws `AwsRuntimeConfigError` naming every problem. */
export function parseAwsRuntimeConfigText(text: string): AwsRuntimeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AwsRuntimeConfigError([`it is not JSON (${error instanceof Error ? error.message.slice(0, 120) : "unparseable"})`]);
  }
  return parseAwsRuntimeConfig(raw);
}

export function parseAwsRuntimeConfig(raw: unknown): AwsRuntimeConfig {
  const problems: string[] = [];
  if (!isObject(raw)) throw new AwsRuntimeConfigError(["the document must be a JSON object"]);
  if (raw.format !== AWS_RUNTIME_CONFIG_FORMAT && raw.format !== AWS_RUNTIME_CONFIG_FORMAT_V2) {
    throw new AwsRuntimeConfigError([`format must be ${JSON.stringify(AWS_RUNTIME_CONFIG_FORMAT)} or ${JSON.stringify(AWS_RUNTIME_CONFIG_FORMAT_V2)} (got ${JSON.stringify(raw.format ?? null)})`]);
  }
  const v2 = raw.format === AWS_RUNTIME_CONFIG_FORMAT_V2;
  const fields: readonly string[] = v2 ? [...FIELDS, "routes"] : FIELDS;
  for (const name of Object.keys(raw)) if (!fields.includes(name)) problems.push(`unknown field ${name} (a misspelt setting is never ignored)`);
  for (const name of fields) if (!(name in raw)) problems.push(`${name} is required`);

  const environment = raw.environment;
  if (typeof environment !== "string" || !ENVIRONMENT.test(environment)) problems.push("environment must be a short lower-case label ([a-z][a-z0-9-]{0,31})");
  const region = raw.region;
  if (!isAwsRegion(region)) problems.push(`region must be an AWS region (got ${JSON.stringify(region ?? null)}); it is never taken from the environment`);
  const pool = raw.pool;
  const poolProblem = typeof pool === "string" ? primaryPoolProblem(pool) : "it must be a string";
  if (poolProblem !== null) problems.push(`pool: ${poolProblem}`);
  const generation = raw.generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) problems.push("generation must be a positive whole number (the ledger's adopted app generation this task is for)");
  const gameTable = raw.game_table;
  const identityTable = raw.identity_table;
  if (typeof gameTable !== "string" || !TABLE_NAME.test(gameTable)) problems.push("game_table must be a DynamoDB table name in the app account");
  if (typeof identityTable !== "string" || !TABLE_NAME.test(identityTable)) problems.push("identity_table must be a DynamoDB table name in the app account");
  if (typeof gameTable === "string" && gameTable === identityTable) problems.push("game_table and identity_table must be two tables");
  const ledger = parseDynamoTableArn(raw.ledger_table_arn);
  if ("problem" in ledger) problems.push(`ledger_table_arn: ${ledger.problem}`);
  else if (ledger.table === gameTable || ledger.table === identityTable) problems.push("ledger_table_arn must name the ledger, not the game or identity table");

  let escrow: AwsRuntimeConfig["escrow"] = null;
  if (raw.escrow !== null && raw.escrow !== undefined) {
    if (!isObject(raw.escrow)) problems.push('escrow must be null or {"config_parameter_arn": <SSM parameter ARN>}');
    else {
      for (const name of Object.keys(raw.escrow)) if (name !== "config_parameter_arn") problems.push(`unknown field escrow.${name}`);
      const parameter = parseSsmParameterArn(raw.escrow.config_parameter_arn);
      if ("problem" in parameter) problems.push(`escrow.config_parameter_arn: ${parameter.problem}`);
      else escrow = { configParameter: parameter };
    }
  }
  const routes: Record<string, PoolRouteEntry> = {};
  if (v2 && "routes" in raw) {
    if (!isObject(raw.routes)) problems.push('routes must be an object {"<pool>": {"ws_path": "/gs/...", "bundle_path"?: "/..."}}');
    else {
      const entries = Object.entries(raw.routes);
      if (entries.length > MAX_ROUTE_ENTRIES) problems.push(`routes names ${entries.length} pools; at most ${MAX_ROUTE_ENTRIES}`);
      const paths = new Set<string>();
      for (const [routePool, value] of entries) {
        const idProblem = primaryPoolProblem(routePool);
        if (idProblem !== null) {
          problems.push(`routes: ${JSON.stringify(routePool.slice(0, 80))} is not a pool (${idProblem})`);
          continue;
        }
        if (!isObject(value)) {
          problems.push(`routes.${routePool} must be {"ws_path": ..., "bundle_path"?: ...}`);
          continue;
        }
        for (const name of Object.keys(value)) if (name !== "ws_path" && name !== "bundle_path") problems.push(`unknown field routes.${routePool}.${name}`);
        if (typeof value.ws_path !== "string") {
          problems.push(`routes.${routePool}.ws_path is required (a path string)`);
          continue;
        }
        if (value.bundle_path !== undefined && typeof value.bundle_path !== "string") {
          problems.push(`routes.${routePool}.bundle_path must be a path string when present`);
          continue;
        }
        const entry: PoolRouteEntry = { wsPath: value.ws_path, ...(value.bundle_path !== undefined ? { bundlePath: value.bundle_path as string } : {}) };
        const entryProblem = routeEntryProblem(entry);
        if (entryProblem !== null) {
          problems.push(`routes.${routePool}: ${entryProblem}`);
          continue;
        }
        if (paths.has(entry.wsPath)) problems.push(`routes.${routePool}.ws_path ${entry.wsPath} is another pool's too`);
        paths.add(entry.wsPath);
        routes[routePool] = Object.freeze(entry);
      }
    }
  }
  if (problems.length > 0) throw new AwsRuntimeConfigError(problems);
  return Object.freeze({
    format: v2 ? AWS_RUNTIME_CONFIG_FORMAT_V2 : AWS_RUNTIME_CONFIG_FORMAT,
    environment: environment as string,
    region: region as string,
    pool: pool as string,
    generation: generation as number,
    gameTable: gameTable as string,
    identityTable: identityTable as string,
    ledger: ledger as DynamoTableArn,
    escrow,
    routes: Object.freeze(routes),
  });
}

/**
 * The Juno backend configuration, as an AWS task may run it (in addition to `parseJunoBackendConfig`'s own checks):
 * the DynamoDB signing ledger -- the SAME ledger as the runtime's -- and KMS keys only, in one region. Returns the
 * problems (empty: it may run). A file journal is never opened by an AWS task, and a development signer never.
 */
export function checkEscrowConfigForAws(config: JunoBackendConfig, runtime: AwsRuntimeConfig): string[] {
  const problems: string[] = [];
  if (config.journal.kind !== "dynamodb") problems.push("the escrow configuration names a FILE signing journal; AWS storage opens only the DynamoDB ledger (journal.kind \"dynamodb\"), and never falls back to a file");
  else if (config.journal.tableArn !== runtime.ledger.arn) problems.push(`the escrow configuration's ledger (${config.journal.tableArn}) is not the runtime's (${runtime.ledger.arn}): one task, one ledger`);
  /* Phase 3 escrow 2.1: the dedicated REMEDY key, when configured, is a KMS key too (never a development signer on AWS). */
  const signers: ReadonlyArray<readonly [string, SignerRef]> = [
    ["relayer", config.relayer.signer],
    ["settlement_key", config.settlementKey.signer],
    ["admission_key", config.admissionKey.signer],
    ...(config.remedyKey !== null ? [["remedy_key", config.remedyKey.signer] as const] : []),
  ];
  for (const [role, ref] of signers) {
    if (ref.kind !== "kms") problems.push(`${role}: AWS storage signs only with KMS keys (a ${ref.kind} signer is refused)`);
  }
  if (config.kmsRegion === null) problems.push("the escrow configuration names no KMS region");
  return problems;
}
