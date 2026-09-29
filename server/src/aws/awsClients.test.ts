// server/src/aws/awsClients.test.ts
//
// LIVE-5 L5-1: the AWS client convention, with no network at all (every request is stopped before it is sent). A
// DynamoDB Local client cannot be aimed anywhere but this machine, never reads the machine's AWS environment, and has
// SDK retries off and bounded, throwing timeouts; an AWS client ignores every configured endpoint override; and the
// source tree creates AWS clients in exactly one place. LIVE-5 L5-5: the same for the KMS client (`createKmsClient`).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ListTablesCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient, ListKeysCommand } from "@aws-sdk/client-kms";

import { AWS_CALL_POLICY, createDynamoDbClient, createKmsClient, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV, KMS_CALL_POLICY, LOCAL_TEST_CREDENTIALS, LOCAL_TEST_REGION, localEndpointProblem } from "./awsClients";

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

  test("the environment names DynamoDB Local explicitly; unset is null, and a set-but-unsafe value throws", () => {
    assert.equal(dynamoLocalTargetFromEnv({}), null);
    assert.equal(dynamoLocalTargetFromEnv({ [DYNAMODB_LOCAL_ENV]: "" }), null);
    assert.deepEqual(dynamoLocalTargetFromEnv({ [DYNAMODB_LOCAL_ENV]: "http://127.0.0.1:8000" }), { kind: "dynamodb-local", endpoint: "http://127.0.0.1:8000" });
    assert.throws(() => dynamoLocalTargetFromEnv({ [DYNAMODB_LOCAL_ENV]: "https://dynamodb.us-east-1.amazonaws.com" }), /GS_DYNAMODB_LOCAL_ENDPOINT/);
  });

  test("one convention: AWS clients are constructed only in aws/awsClients.ts, only the DynamoDB and (L5-5) KMS client packages are used, and no production file imports the conformance code", () => {
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
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8");
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (relative !== "aws/awsClients.ts" && /new\s+DynamoDB(Client)?\s*\(/.test(text)) offenders.push(`${relative}: constructs a DynamoDB client`);
      if (relative !== "aws/awsClients.ts" && /new\s+KMS(Client)?\s*\(/.test(text)) offenders.push(`${relative}: constructs a KMS client`);
      if (/DynamoDBDocument(Client)?\b/.test(text) && relative !== "aws/awsClients.test.ts") offenders.push(`${relative}: uses the document client (it marshals values: stored bytes must be exact)`);
      const modules = [...text.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);
      for (const name of modules) {
        if (name.startsWith("@aws-sdk/") && name !== "@aws-sdk/client-dynamodb" && name !== "@aws-sdk/client-kms") offenders.push(`${relative}: imports ${name}`);
        if (name.startsWith("@smithy/")) offenders.push(`${relative}: reaches into ${name} directly`);
        /* The proof adapter and the harness are test code: nothing outside the conformance directory may import them. */
        if (name.includes("persistence/conformance") && !conformance.test(relative)) offenders.push(`${relative}: imports the conformance harness (${name})`);
        if (/(^|\/)conformance\//.test(name) && relative.startsWith("persistence/") && !conformance.test(relative)) offenders.push(`${relative}: imports ${name}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
