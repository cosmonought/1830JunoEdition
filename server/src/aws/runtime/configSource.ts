// server/src/aws/runtime/configSource.ts
//
// ==================================================================
//  LIVE-5 L5-7: WHERE THE AWS RUNTIME'S CONFIGURATION AND SECRETS COME FROM -- SSM AND SECRETS MANAGER, READ ONCE
// ==================================================================
//
// Preflight §11.6: the task's environment carries only REFERENCES (the mode, the build, the storage kind and the SSM
// parameter ARN of the runtime configuration). The configuration itself is one non-secret SSM `String` parameter; a
// secret, when one is ever needed (an RPC provider's key -- none is today), is read from Secrets Manager by its complete
// ARN into memory, and never into the environment (so ECS's `secrets` field, which injects values INTO environment
// variables, is not used).
//
// THE PORTS (`ParameterSource`, `SecretSource`) are what the runtime composition reads through; the SDK implementations
// below are the only ones production builds, from `awsClients.ts`'s factories (SDK retries off, bounded throwing
// timeouts, the client's region the ARN's own). Tests fake the ports.
//
// FAIL CLOSED:
//   - a parameter that is not a plain `String` is refused: a `SecureString` means someone put a secret in the
//     configuration (it belongs in Secrets Manager), and a `StringList` is not a document;
//   - the answer must name the parameter asked for (its ARN), and carry a version;
//   - nothing is retried inside the SDK; a failed read refuses the start (exit 2: ECS starts the task again).
//
// A SECRET NEVER PRINTS. `SecretValue` holds the bytes privately; its string, JSON and inspection forms are all
// `[secret]`, so a secret handed to a log line, a status snapshot or an error message shows nothing. `reveal()` is the one
// way to read it, for the one caller that needs it.

import { inspect } from "util";

import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import { parseSecretArn, parseSsmParameterArn } from "../arns";
import { CONFIG_CALL_POLICY, createSecretsManagerClient, createSsmClient, deadline } from "../awsClients";

/** The most the runtime ever reads from one parameter (SSM's advanced tier holds 8 KB). */
export const MAX_PARAMETER_BYTES = 8 * 1024;
/** Secrets Manager holds at most 64 KiB per secret. */
export const MAX_SECRET_BYTES = 64 * 1024;

export class ConfigSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigSourceError";
  }
}

export interface ParameterRead {
  /** The parameter's value (a JSON document for the runtime and escrow configurations). Never a secret. */
  readonly value: string;
  /** Its version, printed at startup so an operator knows which configuration a task runs. */
  readonly version: number;
  readonly arn: string;
}

export interface ParameterSource {
  /** One `String` parameter, by its ARN. Rejects `ConfigSourceError` for anything else (see the header). */
  read(arn: string): Promise<ParameterRead>;
}

/** A secret's value, which never prints (see the header). */
export class SecretValue {
  readonly #bytes: Buffer;
  constructor(bytes: Uint8Array) {
    this.#bytes = Buffer.from(bytes);
  }
  /** The one way to read the value. */
  reveal(): string {
    return this.#bytes.toString("utf8");
  }
  get length(): number {
    return this.#bytes.length;
  }
  toString(): string {
    return "[secret]";
  }
  toJSON(): string {
    return "[secret]";
  }
  [inspect.custom](): string {
    return "[secret]";
  }
}

export interface SecretSource {
  /** One secret, by its complete ARN, into memory. */
  read(arn: string): Promise<SecretValue>;
}

const describe = (error: unknown): string => {
  /* The SDK's error names and messages carry no secret value (they may name ARNs and the task's role, which are not
     secrets); they are shortened, and never include a response body. */
  const name = (error as { name?: unknown } | null)?.name;
  const message = error instanceof Error ? error.message : String(error);
  return `${typeof name === "string" ? `${name}: ` : ""}${message}`.slice(0, 300);
};

/** The SSM implementation of `ParameterSource` (one client per region, made on first use by `createSsmClient`). */
export function ssmParameterSource(options: { readonly client?: (region: string) => SSMClient } = {}): ParameterSource {
  const clients = new Map<string, SSMClient>();
  const clientFor = (region: string): SSMClient => {
    let client = clients.get(region);
    if (client === undefined) {
      client = options.client?.(region) ?? createSsmClient({ kind: "aws", region });
      clients.set(region, client);
    }
    return client;
  };
  return {
    async read(arn) {
      const parsed = parseSsmParameterArn(arn);
      if ("problem" in parsed) throw new ConfigSourceError(parsed.problem);
      let answer;
      try {
        answer = await clientFor(parsed.region).send(new GetParameterCommand({ Name: parsed.arn, WithDecryption: false }), { abortSignal: deadline(CONFIG_CALL_POLICY.callDeadlineMs) });
      } catch (error) {
        throw new ConfigSourceError(`the SSM parameter ${parsed.arn} could not be read (${describe(error)})`);
      }
      const parameter = answer.Parameter;
      if (parameter === undefined) throw new ConfigSourceError(`the SSM parameter ${parsed.arn} answered no parameter`);
      if (parameter.Type !== "String") {
        throw new ConfigSourceError(
          `the SSM parameter ${parsed.arn} is a ${JSON.stringify(parameter.Type ?? null)}, not a plain String` +
            (parameter.Type === "SecureString" ? " (a secret never goes in the runtime configuration: it belongs in Secrets Manager, by reference)" : ""),
        );
      }
      if (parameter.ARN !== parsed.arn && parameter.Name !== parsed.name) throw new ConfigSourceError(`the SSM answer names ${JSON.stringify(parameter.ARN ?? parameter.Name ?? null)}, not ${parsed.arn}`);
      if (typeof parameter.Version !== "number" || !Number.isSafeInteger(parameter.Version) || parameter.Version < 1) throw new ConfigSourceError(`the SSM parameter ${parsed.arn} answered no version`);
      const value = parameter.Value;
      if (typeof value !== "string" || value.length === 0) throw new ConfigSourceError(`the SSM parameter ${parsed.arn} is empty`);
      if (Buffer.byteLength(value, "utf8") > MAX_PARAMETER_BYTES) throw new ConfigSourceError(`the SSM parameter ${parsed.arn} is larger than ${MAX_PARAMETER_BYTES} bytes`);
      return { value, version: parameter.Version, arn: parsed.arn };
    },
  };
}

/** The Secrets Manager implementation of `SecretSource`. Nothing here ever logs or returns the value in any other form. */
export function secretsManagerSource(options: { readonly client?: (region: string) => SecretsManagerClient } = {}): SecretSource {
  const clients = new Map<string, SecretsManagerClient>();
  const clientFor = (region: string): SecretsManagerClient => {
    let client = clients.get(region);
    if (client === undefined) {
      client = options.client?.(region) ?? createSecretsManagerClient({ kind: "aws", region });
      clients.set(region, client);
    }
    return client;
  };
  return {
    async read(arn) {
      const parsed = parseSecretArn(arn);
      if ("problem" in parsed) throw new ConfigSourceError(parsed.problem);
      let answer;
      try {
        answer = await clientFor(parsed.region).send(new GetSecretValueCommand({ SecretId: parsed.arn }), { abortSignal: deadline(CONFIG_CALL_POLICY.callDeadlineMs) });
      } catch (error) {
        throw new ConfigSourceError(`the secret ${parsed.arn} could not be read (${describe(error)})`);
      }
      if (answer.ARN !== parsed.arn) throw new ConfigSourceError(`the Secrets Manager answer names ${JSON.stringify(answer.ARN ?? null)}, not ${parsed.arn}`);
      const bytes = typeof answer.SecretString === "string" ? Buffer.from(answer.SecretString, "utf8") : answer.SecretBinary instanceof Uint8Array ? Buffer.from(answer.SecretBinary) : null;
      if (bytes === null || bytes.length === 0) throw new ConfigSourceError(`the secret ${parsed.arn} has no value`);
      if (bytes.length > MAX_SECRET_BYTES) throw new ConfigSourceError(`the secret ${parsed.arn} is larger than ${MAX_SECRET_BYTES} bytes`);
      const value = new SecretValue(bytes);
      bytes.fill(0);
      return value;
    },
  };
}
