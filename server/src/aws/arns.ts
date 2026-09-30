// server/src/aws/arns.ts
//
// LIVE-5 L5-5: the AWS names the configuration may carry, parsed strictly -- and with no AWS SDK import, so the Juno
// configuration (`escrow/juno/junoConfig.ts`) can check them without loading a client. A region is always EXPLICIT: it is
// read from the ARN the operator wrote, never from the environment, a profile or instance metadata.

const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

/** Whether `region` is written as an AWS region (the pattern every factory in `awsClients.ts` requires of an `aws` target). */
export const isAwsRegion = (region: unknown): region is string => typeof region === "string" && AWS_REGION.test(region);

export interface KmsKeyArn {
  readonly arn: string;
  readonly region: string;
  readonly account: string;
  readonly keyId: string;
}

const KEY_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/;

/**
 * A KMS KEY ARN, or why `text` is not one. Only the commercial partition, a 12-digit account and a key id (a single-region
 * UUID or a multi-region `mrk-` id); an alias ARN, a bare key id, an alias name or anything with extra parts is refused
 * (preflight §11.1: an alias can be repointed to another key). `region` is checked only for shape here (`[a-z0-9-]`):
 * whether it is a real AWS region is the configuration's check, and whether it is this client's is the digest client's.
 */
export function parseKmsKeyArn(text: unknown): KmsKeyArn | { readonly problem: string } {
  if (typeof text !== "string" || text.length === 0 || text.length > 256) return { problem: "a KMS key reference must be a key ARN (arn:aws:kms:<region>:<account>:key/<key id>)" };
  const parts = text.split(":");
  if (parts.length !== 6 || parts[0] !== "arn" || parts[1] !== "aws" || parts[2] !== "kms") return { problem: `${JSON.stringify(text)} is not a KMS key ARN in the aws partition` };
  const [, , , region, account, resource] = parts;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(region)) return { problem: `${JSON.stringify(text)}: the region is missing or malformed` };
  if (!/^[0-9]{12}$/.test(account)) return { problem: `${JSON.stringify(text)}: the account must be 12 digits` };
  if (resource.startsWith("alias/")) return { problem: `${JSON.stringify(text)} is an ALIAS ARN: name the key by its key ARN (an alias can be repointed to another key)` };
  if (!resource.startsWith("key/") || !KEY_ID.test(resource.slice(4))) return { problem: `${JSON.stringify(text)}: the resource must be key/<key id>` };
  return { arn: text, region, account, keyId: resource.slice(4) };
}

export interface DynamoTableArn {
  readonly arn: string;
  readonly region: string;
  readonly account: string;
  readonly table: string;
}

/** A DynamoDB TABLE ARN (the ledger is reached cross-account by its full table ARN, preflight §10.1), or why not. */
export function parseDynamoTableArn(text: unknown): DynamoTableArn | { readonly problem: string } {
  if (typeof text !== "string" || text.length === 0 || text.length > 1024) return { problem: "the ledger table must be a DynamoDB table ARN (arn:aws:dynamodb:<region>:<account>:table/<name>)" };
  const match = /^arn:aws:dynamodb:([a-z0-9-]+):([0-9]{12}):table\/([A-Za-z0-9_.-]{3,255})$/.exec(text);
  if (match === null) return { problem: `${JSON.stringify(text)} is not a DynamoDB table ARN in the aws partition (an index, a stream or another resource is not a table)` };
  if (!isAwsRegion(match[1])) return { problem: `${JSON.stringify(text)}: ${match[1]} is not an AWS region` };
  return { arn: text, region: match[1], account: match[2], table: match[3] };
}

/* ------------------------------------------------------------------ */
/* LIVE-5 L5-7: the runtime's configuration references                 */
/* ------------------------------------------------------------------ */

export interface SsmParameterArn {
  readonly arn: string;
  readonly region: string;
  readonly account: string;
  /** The parameter's name as SSM reports it: `/` + the ARN's path (`parameter/gs/prod/runtime` -> `/gs/prod/runtime`). */
  readonly name: string;
}

/**
 * An SSM PARAMETER ARN (the runtime's non-secret configuration, preflight §11.6: the environment carries only this
 * reference), or why `text` is not one. The region is the ARN's -- never the environment's -- so the client that reads it
 * is made for exactly that region. No version or label selector (`:3`, `:prod`): the parameter's current version is read
 * and its number is printed at startup.
 */
export function parseSsmParameterArn(text: unknown): SsmParameterArn | { readonly problem: string } {
  if (typeof text !== "string" || text.length === 0 || text.length > 2048) return { problem: "the runtime configuration must be named by an SSM parameter ARN (arn:aws:ssm:<region>:<account>:parameter/<name>)" };
  const match = /^arn:aws:ssm:([a-z0-9-]+):([0-9]{12}):parameter\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)$/.exec(text);
  if (match === null) return { problem: `${JSON.stringify(text)} is not an SSM parameter ARN in the aws partition (no version or label selector)` };
  if (!isAwsRegion(match[1])) return { problem: `${JSON.stringify(text)}: ${match[1]} is not an AWS region` };
  if (match[3].length > 1011) return { problem: `${JSON.stringify(text)}: the parameter name is too long` };
  return { arn: text, region: match[1], account: match[2], name: `/${match[3]}` };
}

export interface SecretArn {
  readonly arn: string;
  readonly region: string;
  readonly account: string;
}

/**
 * A Secrets Manager SECRET ARN -- the COMPLETE ARN, with the six-character suffix Secrets Manager appends (a partial ARN
 * or a bare name can resolve to another secret of the same prefix) -- or why not.
 */
export function parseSecretArn(text: unknown): SecretArn | { readonly problem: string } {
  if (typeof text !== "string" || text.length === 0 || text.length > 2048) return { problem: "a secret must be named by its complete Secrets Manager ARN (arn:aws:secretsmanager:<region>:<account>:secret:<name>-<suffix>)" };
  const match = /^arn:aws:secretsmanager:([a-z0-9-]+):([0-9]{12}):secret:[A-Za-z0-9/_+=.@-]{1,512}-[A-Za-z0-9]{6}$/.exec(text);
  if (match === null) return { problem: `${JSON.stringify(text)} is not a complete Secrets Manager secret ARN in the aws partition` };
  if (!isAwsRegion(match[1])) return { problem: `${JSON.stringify(text)}: ${match[1]} is not an AWS region` };
  return { arn: text, region: match[1], account: match[2] };
}
