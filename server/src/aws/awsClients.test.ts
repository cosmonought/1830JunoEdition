// server/src/aws/awsClients.test.ts
//
// LIVE-5 L5-1: the AWS client convention, with no network at all (every request is stopped before it is sent). A
// DynamoDB Local client cannot be aimed anywhere but this machine, never reads the machine's AWS environment, and has
// SDK retries off and bounded, throwing timeouts; an AWS client ignores every configured endpoint override; and the
// source tree creates AWS clients in exactly one place. LIVE-5 L5-5: the same for the KMS client (`createKmsClient`).
// LIVE-5 L5-7: the same for SSM and Secrets Manager (the runtime configuration's clients), and the import guard lifted
// for ONE place -- the AWS runtime composition, `aws/runtime/` -- and tightened for the ledger, KMS and the runtime.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ListTablesCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient, ListKeysCommand } from "@aws-sdk/client-kms";
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { ListSecretsCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import { AWS_CALL_POLICY, CONFIG_CALL_POLICY, createDynamoDbClient, createKmsClient, createSecretsManagerClient, createSsmClient, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV, KMS_CALL_POLICY, LOCAL_TEST_CREDENTIALS, LOCAL_TEST_REGION, localEndpointProblem } from "./awsClients";

/** The host and port a request WOULD be sent to; the request is stopped before the network. */
async function destination(client: DynamoDBClient | KMSClient): Promise<string> {
  let seen = "";
  const probe = { step: "finalizeRequest" as const, name: "l5DestinationProbe" };
  const stop = () => async (args: unknown) => {
    const request = (args as { request: { protocol: string; hostname: string; port?: number } }).request;
    seen = `${request.protocol}//${request.hostname}${request.port !== undefined ? `:${request.port}` : ""}`;
    throw new Error("stopped before the network");
  };
  if (client instanceof KMSClient) {
    client.middlewareStack.add(stop, probe);
    await assert.rejects(client.send(new ListKeysCommand({})), /stopped before the network/);
  } else {
    client.middlewareStack.add(stop, probe);
    await assert.rejects(client.send(new ListTablesCommand({})), /stopped before the network/);
  }
  return seen;
}

/** A shared config file that would redirect, FIPS-ify and rate-limit any client that read it. */
function hostileConfigFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gs-l5aws-")), "config");
  const profile = "use_fips_endpoint = true\nuse_dualstack_endpoint = true\nretry_mode = adaptive\nendpoint_url = http://hostile.example:4568\nregion = eu-west-1\n";
  fs.writeFileSync(file, `[default]\n${profile}[profile gs-l5-no-such-profile]\n${profile}`);
  return file;
}

/** Run `body` with hostile AWS settings in the environment, restoring it afterwards. */
async function withHostileEnvironment(body: () => Promise<void>, options: { readonly profile?: boolean } = {}): Promise<void> {
  const hostile: Record<string, string> = {
    AWS_ACCESS_KEY_ID: "AKIAHOSTILEHOSTILE00",
    AWS_SECRET_ACCESS_KEY: "hostile",
    AWS_SESSION_TOKEN: "hostile",
    AWS_REGION: "eu-west-1",
    AWS_DEFAULT_REGION: "eu-west-1",
    AWS_PROFILE: "gs-l5-no-such-profile",
    AWS_ENDPOINT_URL: "http://hostile.example:4566",
    AWS_ENDPOINT_URL_DYNAMODB: "http://hostile.example:4567",
    AWS_ENDPOINT_URL_KMS: "http://hostile.example:4569",
    AWS_CONFIG_FILE: hostileConfigFile(),
    AWS_USE_FIPS_ENDPOINT: "true",
    AWS_USE_DUALSTACK_ENDPOINT: "true",
    AWS_RETRY_MODE: "adaptive",
  };
  /* A named profile makes the SDK skip the environment keys; the AWS-client case needs keys it can sign with (it stops
     before the network), so it leaves the profile out. */
  if (options.profile === false) delete hostile.AWS_PROFILE;
  const saved = new Map(Object.keys(hostile).map((key) => [key, process.env[key]] as const));
  Object.assign(process.env, hostile);
  try {
    await body();
  } finally {
    fs.rmSync(path.dirname(hostile.AWS_CONFIG_FILE), { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("L5-1 AWS client convention", () => {
  test("only plain http on a loopback host with an explicit port is a DynamoDB Local endpoint", () => {
    for (const good of ["http://127.0.0.1:8000", "http://localhost:8000", "http://[::1]:8000", "http://127.0.0.1:8000/"]) assert.equal(localEndpointProblem(good), null, good);
    for (const bad of [
      "https://127.0.0.1:8000",
      "https://dynamodb.us-east-1.amazonaws.com",
      "http://dynamodb.us-east-1.amazonaws.com:80",
      "http://127.0.0.1.nip.io:8000",
      "http://169.254.169.254:80",
      "http://10.0.0.5:8000",
      "http://host.docker.internal:8000",
      "http://127.0.0.1",
      "http://user:pass@127.0.0.1:8000",
      "http://127.0.0.1:8000/prefix",
      "http://127.0.0.1:8000/?x=1",
      "127.0.0.1:8000",
      "",
    ]) {
      assert.notEqual(localEndpointProblem(bad), null, bad);
      assert.throws(() => createDynamoDbClient({ kind: "dynamodb-local", endpoint: bad }), /refusing/);
    }
  });

  test("a DynamoDB Local client uses exactly its endpoint, the fake region and the dummy keys -- whatever the environment says", async () => {
    await withHostileEnvironment(async () => {
      const client = createDynamoDbClient({ kind: "dynamodb-local", endpoint: "http://127.0.0.1:8000" });
      assert.equal(await destination(client), "http://127.0.0.1:8000");
      assert.equal(await client.config.region(), LOCAL_TEST_REGION);
      const credentials = await client.config.credentials();
      assert.equal(credentials.accessKeyId, LOCAL_TEST_CREDENTIALS.accessKeyId);
      assert.equal(credentials.sessionToken, undefined);
      assert.equal(await client.config.useFipsEndpoint(), false);
      assert.equal(await client.config.useDualstackEndpoint(), false);
      assert.equal(((await client.config.retryStrategy()) as { mode?: string }).mode, "standard", "not the adaptive rate limiter the config file asked for");
      client.destroy();
    });
  });

  test("an AWS client ignores every configured endpoint override and goes to the region's own endpoint", async () => {
    await withHostileEnvironment(async () => {
      const client = createDynamoDbClient({ kind: "aws", region: "us-east-1" });
      assert.equal(await destination(client), "https://dynamodb.us-east-1.amazonaws.com");
      assert.equal(((await client.config.retryStrategy()) as { mode?: string }).mode, "standard");
      client.destroy();
    }, { profile: false });
    assert.throws(() => createDynamoDbClient({ kind: "aws", region: "gs-local" }), /not an AWS region/);
    assert.throws(() => createDynamoDbClient({ kind: "aws", region: "" }), /not an AWS region/);
  });

  test("SDK retries are off and the socket timeouts are bounded and THROW (they are not merely logged)", async () => {
    const client = createDynamoDbClient({ kind: "dynamodb-local", endpoint: "http://127.0.0.1:8000" });
    assert.equal(await client.config.maxAttempts(), AWS_CALL_POLICY.maxAttempts);
    assert.equal(AWS_CALL_POLICY.maxAttempts, 1);
    const handler = client.config.requestHandler as unknown as { configProvider?: Promise<Record<string, unknown>>; config?: Record<string, unknown> };
    const resolved = (await handler.configProvider) ?? handler.config ?? {};
    assert.equal(resolved.connectionTimeout, AWS_CALL_POLICY.connectionTimeoutMs);
    assert.equal(resolved.requestTimeout, AWS_CALL_POLICY.requestTimeoutMs);
    assert.equal(resolved.throwOnRequestTimeout, true);
    client.destroy();
  });

  test("L5-5: a local KMS client (the tests' stand-in) goes only to its loopback endpoint, with the fake region and the dummy keys -- whatever the environment says", async () => {
    await withHostileEnvironment(async () => {
      const client = createKmsClient({ kind: "kms-local", endpoint: "http://127.0.0.1:8123" });
      assert.equal(await destination(client), "http://127.0.0.1:8123");
      assert.equal(await client.config.region(), LOCAL_TEST_REGION);
      const credentials = await client.config.credentials();
      assert.equal(credentials.accessKeyId, LOCAL_TEST_CREDENTIALS.accessKeyId);
      assert.equal(credentials.sessionToken, undefined);
      assert.equal(await client.config.useFipsEndpoint(), false);
      assert.equal(await client.config.useDualstackEndpoint(), false);
      assert.equal(((await client.config.retryStrategy()) as { mode?: string }).mode, "standard");
      client.destroy();
    });
    for (const bad of ["https://127.0.0.1:8123", "http://kms.us-east-1.amazonaws.com:80", "http://10.0.0.5:8123", "http://127.0.0.1", "http://127.0.0.1:8123/x"]) {
      assert.throws(() => createKmsClient({ kind: "kms-local", endpoint: bad }), /refusing to create a local KMS client/, bad);
    }
  });

  test("L5-5: an AWS KMS client ignores every configured endpoint override and goes to its region's own KMS; the region is explicit and must be one", async () => {
    await withHostileEnvironment(async () => {
      const client = createKmsClient({ kind: "aws", region: "us-east-1" });
      assert.equal(await destination(client), "https://kms.us-east-1.amazonaws.com");
      assert.equal(await client.config.region(), "us-east-1", "not the environment's eu-west-1");
      assert.equal(((await client.config.retryStrategy()) as { mode?: string }).mode, "standard");
      client.destroy();
    }, { profile: false });
    for (const region of ["gs-local", "", "US-EAST-1", "us-east-1 "]) assert.throws(() => createKmsClient({ kind: "aws", region }), /not an AWS region/, JSON.stringify(region));
    assert.throws(() => createKmsClient({ kind: "vault" } as never), /not an AWS region/);
  });

  test("L5-5: KMS calls are never retried by the SDK, and their socket timeouts are bounded (3 s, preflight §11.2) and THROW", async () => {
    const client = createKmsClient({ kind: "kms-local", endpoint: "http://127.0.0.1:8123" });
    assert.equal(await client.config.maxAttempts(), 1);
    assert.equal(KMS_CALL_POLICY.maxAttempts, 1);
    const handler = client.config.requestHandler as unknown as { configProvider?: Promise<Record<string, unknown>>; config?: Record<string, unknown> };
    const resolved = (await handler.configProvider) ?? handler.config ?? {};
    assert.equal(resolved.connectionTimeout, KMS_CALL_POLICY.connectionTimeoutMs);
    assert.equal(resolved.requestTimeout, KMS_CALL_POLICY.requestTimeoutMs);
    assert.equal(KMS_CALL_POLICY.requestTimeoutMs, 3_000);
    assert.equal(resolved.throwOnRequestTimeout, true);
    assert.ok(KMS_CALL_POLICY.callDeadlineMs > KMS_CALL_POLICY.requestTimeoutMs && KMS_CALL_POLICY.callDeadlineMs <= 5_000);
    client.destroy();
  });

  test("L5-7: the SSM and Secrets Manager clients go to their region's own endpoint whatever the environment says; the region is explicit; SDK retries off; bounded, throwing timeouts", async () => {
    const stoppedAt = async (client: SSMClient | SecretsManagerClient, command: GetParameterCommand | ListSecretsCommand): Promise<string> => {
      let seen = "";
      (client.middlewareStack as unknown as { add(middleware: unknown, options: unknown): void }).add(
        () => async (args: unknown) => {
          const request = (args as { request: { protocol: string; hostname: string } }).request;
          seen = `${request.protocol}//${request.hostname}`;
          throw new Error("stopped before the network");
        },
        { step: "finalizeRequest", name: "l5ConfigDestinationProbe" },
      );
      await assert.rejects((client.send as (c: unknown) => Promise<unknown>)(command), /stopped before the network/);
      return seen;
    };
    await withHostileEnvironment(async () => {
      const ssm = createSsmClient({ kind: "aws", region: "us-east-1" });
      assert.equal(await stoppedAt(ssm, new GetParameterCommand({ Name: "arn:aws:ssm:us-east-1:123456789012:parameter/gs/x" })), "https://ssm.us-east-1.amazonaws.com");
      assert.equal(await ssm.config.region(), "us-east-1", "not the environment's eu-west-1");
      assert.equal(await ssm.config.maxAttempts(), CONFIG_CALL_POLICY.maxAttempts);
      const secrets = createSecretsManagerClient({ kind: "aws", region: "us-east-1" });
      assert.equal(await stoppedAt(secrets, new ListSecretsCommand({})), "https://secretsmanager.us-east-1.amazonaws.com");
      assert.equal(((await secrets.config.retryStrategy()) as { mode?: string }).mode, "standard");
      const handler = ssm.config.requestHandler as unknown as { configProvider?: Promise<Record<string, unknown>>; config?: Record<string, unknown> };
      const resolved = (await handler.configProvider) ?? handler.config ?? {};
      assert.equal(resolved.throwOnRequestTimeout, true);
      assert.equal(resolved.requestTimeout, CONFIG_CALL_POLICY.requestTimeoutMs);
      ssm.destroy();
      secrets.destroy();
    }, { profile: false });
    for (const region of ["gs-local", "", "US-EAST-1"]) {
      assert.throws(() => createSsmClient({ kind: "aws", region }), /not an AWS region/, JSON.stringify(region));
      assert.throws(() => createSecretsManagerClient({ kind: "aws", region }), /not an AWS region/, JSON.stringify(region));
    }
    assert.throws(() => createSsmClient({ kind: "dynamodb-local", endpoint: "http://127.0.0.1:8000" } as never), /not an AWS region/);
  });

  test("the environment names DynamoDB Local explicitly; unset is null, and a set-but-unsafe value throws", () => {
    assert.equal(dynamoLocalTargetFromEnv({}), null);
    assert.equal(dynamoLocalTargetFromEnv({ [DYNAMODB_LOCAL_ENV]: "" }), null);
    assert.deepEqual(dynamoLocalTargetFromEnv({ [DYNAMODB_LOCAL_ENV]: "http://127.0.0.1:8000" }), { kind: "dynamodb-local", endpoint: "http://127.0.0.1:8000" });
    assert.throws(() => dynamoLocalTargetFromEnv({ [DYNAMODB_LOCAL_ENV]: "https://dynamodb.us-east-1.amazonaws.com" }), /GS_DYNAMODB_LOCAL_ENDPOINT/);
  });

  test("one convention: AWS clients are constructed only in aws/awsClients.ts, only the pinned AWS client packages are used, no production file imports the conformance code, and the AWS substrate is reached only through the L5-7 runtime", () => {
    const root = path.resolve(__dirname, "../../../../src"); // dist/server/src/aws -> server/src
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts")) sources.push(full);
      }
    };
    walk(root);
    assert.ok(sources.length > 50, `the source tree was found (${root})`);
    const offenders: string[] = [];
    const conformance = /^persistence\/conformance\//;
    const under = (target: string, dir: string) => target === dir || target.startsWith(`${dir}/`);
    /* LIVE-5 L5-7: the SSM and Secrets Manager clients are the runtime configuration's (`aws/runtime/configSource.ts`),
       made only by `aws/awsClients.ts`. */
    const configClientFiles = new Set(["aws/awsClients.ts", "aws/awsClients.test.ts", "aws/runtime/configSource.ts"]);
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8");
      const relative = path.relative(root, file).split(path.sep).join("/");
      const runtime = relative.startsWith("aws/runtime/");
      if (relative !== "aws/awsClients.ts" && /new\s+DynamoDB(Client)?\s*\(/.test(text)) offenders.push(`${relative}: constructs a DynamoDB client`);
      if (relative !== "aws/awsClients.ts" && /new\s+KMS(Client)?\s*\(/.test(text)) offenders.push(`${relative}: constructs a KMS client`);
      if (relative !== "aws/awsClients.ts" && /new\s+(SSM|SecretsManager)(Client)?\s*\(/.test(text)) offenders.push(`${relative}: constructs an SSM or Secrets Manager client`);
      if (/DynamoDBDocument(Client)?\b/.test(text) && relative !== "aws/awsClients.test.ts") offenders.push(`${relative}: uses the document client (it marshals values: stored bytes must be exact)`);
      const modules = [...text.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);
      for (const name of modules) {
        if (name === "@aws-sdk/client-ssm" || name === "@aws-sdk/client-secrets-manager") {
          if (!configClientFiles.has(relative) && !(runtime && relative.endsWith(".test.ts"))) offenders.push(`${relative}: imports ${name} (only the runtime configuration's source reads SSM and Secrets Manager)`);
        } else if (name.startsWith("@aws-sdk/") && name !== "@aws-sdk/client-dynamodb" && name !== "@aws-sdk/client-kms") offenders.push(`${relative}: imports ${name}`);
        if (name.startsWith("@smithy/")) offenders.push(`${relative}: reaches into ${name} directly`);
        /* The proof adapter and the harness are test code: nothing outside the conformance directory may import them. */
        if (name.includes("persistence/conformance") && !conformance.test(relative)) offenders.push(`${relative}: imports the conformance harness (${name})`);
        if (/(^|\/)conformance\//.test(name) && relative.startsWith("persistence/") && !conformance.test(relative)) offenders.push(`${relative}: imports ${name}`);
        /* LIVE-5 L5-2 ... L5-6 kept the AWS adapters out of the server; LIVE-5 L5-7 wires them, and lifts the rule for ONE
           place only: the runtime composition, `aws/runtime/` (the AWS storage mode). Everything else stays under the rule:
             aws/game, aws/identity  -- themselves, the ownership layer (it composes the two), the runtime, the conformance;
             aws/ownership           -- itself, the runtime, the conformance;
             aws/ledger              -- itself, the ownership layer (APPGEN, the relayer role), the runtime, the conformance;
             aws/kms                 -- itself, the runtime, the conformance;
             aws/runtime             -- itself; and start.ts, which reads the storage mode and loads the AWS entry only.
           Every relative import is RESOLVED against its file, so no spelling (`../../game/x`, `./aws/game`) slips past. */
        if (name.startsWith(".")) {
          const target = path.relative(root, path.resolve(path.dirname(file), name)).split(path.sep).join("/");
          const composer = relative.startsWith("aws/ownership/");
          const allowed = (dir: string, also: boolean) => relative.startsWith(`${dir}/`) || also || runtime || conformance.test(relative);
          if (under(target, "aws/game") && !allowed("aws/game", composer)) offenders.push(`${relative}: imports the game-table adapters (${name}) outside the L5-7 runtime`);
          if (under(target, "aws/identity") && !allowed("aws/identity", composer)) offenders.push(`${relative}: imports the identity adapters (${name}) outside the L5-7 runtime`);
          if (under(target, "aws/ownership") && !allowed("aws/ownership", false)) offenders.push(`${relative}: imports the ownership layer (${name}) outside the L5-7 runtime`);
          if (under(target, "aws/ledger") && !allowed("aws/ledger", composer)) offenders.push(`${relative}: imports the signing ledger (${name}) outside the L5-7 runtime`);
          if (under(target, "aws/kms") && !allowed("aws/kms", false)) offenders.push(`${relative}: imports the KMS binding (${name}) outside the L5-7 runtime`);
          if (under(target, "aws/runtime") && !runtime && !conformance.test(relative) && !(relative === "start.ts" && (target === "aws/runtime/storageMode" || target === "aws/runtime/awsMain"))) {
            offenders.push(`${relative}: imports the AWS runtime (${name}); only start.ts reaches it (the storage mode, and the AWS entry)`);
          }
        } else if (/(^|\/)aws\/(game|identity|ownership|ledger|kms|runtime)(\/|$)/.test(name)) offenders.push(`${relative}: imports an AWS module by a non-relative path (${name})`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
