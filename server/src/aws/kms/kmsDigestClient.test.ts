// server/src/aws/kms/kmsDigestClient.test.ts
//
// ==================================================================
//  LIVE-5 L5-5: THE KMS BINDING, THROUGH THE REAL SDK, AGAINST A KMS STAND-IN ON THIS MACHINE
// ==================================================================
//
// No AWS account and no network beyond loopback: a small stand-in speaks KMS's JSON protocol (`TrentService.Sign`,
// `TrentService.GetPublicKey`) on 127.0.0.1, signs with a test secp256k1 key, and can be scripted to answer as another
// key, with another algorithm, with a malformed or high-s DER, with any KMS error, or not at all (a timeout BEFORE or
// AFTER it made the signature). The client is the production one: `createKmsClient` (the one factory) and
// `kmsDigestClient`, then `openKmsDigestSigner` (`signer.ts`), exactly as a KMS-configured key opens.
//
// What is pinned:
//   - the request: exactly the caller's 32 bytes, `MessageType=DIGEST`, `SigningAlgorithm=ECDSA_SHA_256`, the key ARN,
//     nothing else (no grant tokens, never a dry run) -- and a caller mutating its buffer mid-call changes nothing;
//   - the key identity: only a KMS KEY ARN in this client's region; an alias, a bare key id, another region or another
//     service is refused before anything is sent; every answer must name the requested key and algorithm;
//   - verify-before-use: another key's signature, a malformed DER, a wrong key spec are refusals, never signatures;
//   - every KMS failure has one explicit class (`unavailable` / `refused` / `verify-failed`), with whether a signature
//     may exist in a lost answer; a timeout before or after the signature was made is `unavailable`, and the retry is the
//     same key and the same digest.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";

import { createKmsClient, LOCAL_TEST_REGION } from "../awsClients";
import { classifyKmsError, kmsDigestClient, KmsCallError, parseKmsKeyArn } from "./kmsDigestClient";
import { openKmsDigestSigner, SignerError, type DigestSigner } from "../../escrow/juno/signer";
import { bigIntTo32, bytesToBigInt, decompressPublicKey, publicKeyOf, SECP256K1_N, signDigest, verifyDigest } from "../../escrow/juno/secp256k1";
import { junoJoinAdmissionSigner } from "../../escrow/juno/joinAdmission";
import { JUNO_CODEC_V1 } from "../../../../frontend/src/gameEngine/escrow/junoCodecV1";

/* ------------------------------------------------------------------ */
/* The KMS stand-in                                                     */
/* ------------------------------------------------------------------ */

const ARN = (id: string, region = LOCAL_TEST_REGION) => `arn:aws:kms:${region}:000000000000:key/${id}`;
const KEY_A = ARN("11111111-1111-4111-8111-111111111111");
const KEY_B = ARN("22222222-2222-4222-8222-222222222222");
const SECRET_A = Buffer.from("a1".repeat(32), "hex");
const SECRET_B = Buffer.from("b2".repeat(32), "hex");

const SPKI_PREFIX = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");
function spkiOf(secret: Buffer): Buffer {
  const { x, y } = decompressPublicKey(publicKeyOf(secret));
  return Buffer.concat([SPKI_PREFIX, Buffer.from([0x04]), bigIntTo32(x), bigIntTo32(y)]);
}
function derInteger(value: Buffer): Buffer {
  let body = value;
  while (body.length > 1 && body[0] === 0 && !(body[1] & 0x80)) body = body.subarray(1);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}
function derOf(compact: Buffer, highS = false): Buffer {
  const r = compact.subarray(0, 32);
  let s = compact.subarray(32);
  if (highS) s = bigIntTo32(SECP256K1_N - bytesToBigInt(s));
  const body = Buffer.concat([derInteger(r), derInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

type Script =
  | { readonly kind: "error"; readonly type: string; readonly status: number }
  | { readonly kind: "answer"; readonly mutate: (answer: Record<string, unknown>) => Record<string, unknown> }
  | { readonly kind: "stall-before-sign" }
  | { readonly kind: "stall-after-sign" }
  | { readonly kind: "high-s" }
  | { readonly kind: "sign-with"; readonly secret: Buffer };

class FakeKms {
  readonly requests: Array<{ readonly target: string; readonly body: Record<string, unknown> }> = [];
  /** Every signature the stand-in made (whether or not its answer ever arrived). */
  readonly signed: Buffer[] = [];
  private readonly scripts: Script[] = [];
  private readonly stalls: Array<() => void> = [];
  private server!: http.Server;
  endpoint = "";
  readonly keys = new Map<string, { readonly secret: Buffer; spec: string; usage: string; algorithms: string[] }>([
    [KEY_A, { secret: SECRET_A, spec: "ECC_SECG_P256K1", usage: "SIGN_VERIFY", algorithms: ["ECDSA_SHA_256"] }],
    [KEY_B, { secret: SECRET_B, spec: "ECC_SECG_P256K1", usage: "SIGN_VERIFY", algorithms: ["ECDSA_SHA_256"] }],
  ]);

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => void this.answer(String(request.headers["x-amz-target"] ?? ""), Buffer.concat(chunks).toString("utf8"), response));
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Idempotent, and never waits on a connection: a failing test must end, never hang `npm test` on an open socket. */
  async stop(): Promise<void> {
    for (const release of this.stalls.splice(0)) release();
    if (!this.server.listening) return;
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
  }

  next(script: Script): void {
    this.scripts.push(script);
  }

  private async answer(target: string, text: string, response: http.ServerResponse): Promise<void> {
    const body = JSON.parse(text || "{}") as Record<string, unknown>;
    this.requests.push({ target, body });
    const script = this.scripts.shift();
    const send = (status: number, payload: Record<string, unknown>) => {
      if (response.destroyed) return;
      response.writeHead(status, { "content-type": "application/x-amz-json-1.1" });
      response.end(JSON.stringify(payload));
    };
    if (script?.kind === "error") return send(script.status, { __type: `com.amazonaws.kms#${script.type}`, message: `scripted ${script.type}` });
    const key = this.keys.get(String(body.KeyId));
    if (key === undefined) return send(400, { __type: "NotFoundException", message: "no such key" });
    if (target === "TrentService.GetPublicKey") {
      const answer = { KeyId: body.KeyId, PublicKey: spkiOf(key.secret).toString("base64"), KeySpec: key.spec, KeyUsage: key.usage, SigningAlgorithms: key.algorithms };
      return send(200, script?.kind === "answer" ? script.mutate(answer) : answer);
    }
    if (target !== "TrentService.Sign") return send(400, { __type: "UnsupportedOperationException", message: target });
    if (body.MessageType !== "DIGEST" || body.SigningAlgorithm !== "ECDSA_SHA_256") return send(400, { __type: "ValidationException", message: "not DIGEST/ECDSA_SHA_256" });
    if (script?.kind === "stall-before-sign") await new Promise<void>((resolve) => this.stalls.push(resolve));
    const message = Buffer.from(String(body.Message), "base64");
    if (message.length !== 32) return send(400, { __type: "ValidationException", message: "a digest is 32 bytes" });
    const compact = signDigest(script?.kind === "sign-with" ? script.secret : key.secret, message);
    this.signed.push(compact);
    if (script?.kind === "stall-after-sign") await new Promise<void>((resolve) => this.stalls.push(resolve));
    const answer = { KeyId: body.KeyId, Signature: derOf(compact, script?.kind === "high-s").toString("base64"), SigningAlgorithm: "ECDSA_SHA_256" };
    return send(200, script?.kind === "answer" ? script.mutate(answer) : answer);
  }
}

async function withKms(body: (kms: FakeKms, open: (keyRef?: string, deadlineMs?: number) => Promise<DigestSigner>) => Promise<void>): Promise<void> {
  const kms = new FakeKms();
  await kms.start();
  const client = createKmsClient({ kind: "kms-local", endpoint: kms.endpoint });
  try {
    await body(kms, (keyRef = KEY_A, deadlineMs) => openKmsDigestSigner(kmsDigestClient(client, { region: LOCAL_TEST_REGION, ...(deadlineMs !== undefined ? { callDeadlineMs: deadlineMs } : {}) }), keyRef));
  } finally {
    client.destroy();
    await kms.stop();
  }
}

const DIGEST = Buffer.from("5d".repeat(32), "hex");
const signerCode = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "signed",
    (error: unknown) => (error instanceof SignerError ? `${error.code}${error.detail.signatureMayExist === true ? "+maybe-signed" : ""}` : `other:${(error as Error).name}`),
  );

/* ------------------------------------------------------------------ */

describe("L5-5 KMS: key identity", () => {
  test("only a KMS KEY ARN: an alias (it can be repointed), a bare id, another service or partition, a malformed one are refused", () => {
    assert.deepEqual(parseKmsKeyArn(KEY_A), { arn: KEY_A, region: LOCAL_TEST_REGION, account: "000000000000", keyId: "11111111-1111-4111-8111-111111111111" });
    assert.ok(!("problem" in parseKmsKeyArn("arn:aws:kms:us-east-1:123456789012:key/mrk-0123456789abcdef0123456789abcdef")), "a multi-region key is a key");
    for (const bad of [
      "arn:aws:kms:us-east-1:123456789012:alias/relayer",
      "11111111-1111-4111-8111-111111111111",
      "alias/relayer",
      "arn:aws:s3:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111",
      "arn:aws-cn:kms:cn-north-1:123456789012:key/11111111-1111-4111-8111-111111111111",
      "arn:aws:kms:us-east-1:12345678901:key/11111111-1111-4111-8111-111111111111",
      "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111:extra",
      "arn:aws:kms:us-east-1:123456789012:key/11111111111141118111111111111111",
      "arn:aws:kms::123456789012:key/11111111-1111-4111-8111-111111111111",
      "arn:aws:kms:US-EAST-1:123456789012:key/11111111-1111-4111-8111-111111111111",
      "",
    ]) {
      assert.ok("problem" in parseKmsKeyArn(bad), bad);
    }
  });

  test("a key in another region, a digest that is not 32 bytes, a client configured for another region: refused BEFORE anything is sent", async () => {
    await withKms(async (kms, open) => {
      assert.equal(await signerCode(open(ARN("11111111-1111-4111-8111-111111111111", "us-east-1"))), "refused");
      assert.equal(await signerCode(open("arn:aws:kms:gs-local:000000000000:alias/relayer")), "refused");
      assert.equal(await signerCode(open("11111111-1111-4111-8111-111111111111")), "refused");
      assert.equal(kms.requests.length, 0, "no request was sent for a key in another region, an alias or a bare id");
      const signer = await open();
      const sent = kms.requests.length;
      assert.equal(await signerCode(signer.sign(Buffer.alloc(31))), "refused");
      assert.equal(await signerCode(signer.sign(Buffer.alloc(33))), "refused");
      assert.equal(kms.requests.length, sent, "nothing was sent");
      const client = createKmsClient({ kind: "kms-local", endpoint: kms.endpoint });
      const misread = kmsDigestClient(client, { region: "us-east-1" });
      await assert.rejects(misread.getPublicKey(ARN("11111111-1111-4111-8111-111111111111", "us-east-1")), (error: KmsCallError) => error.failure === "refused" && /configured for gs-local/.test(error.message));
      client.destroy();
      assert.equal(kms.requests.length, sent, "still nothing was sent");
    });
  });
});

describe("L5-5 KMS: the request and the answer", () => {
  test("GetPublicKey gives the key; Sign is sent EXACTLY the caller's 32 bytes as a DIGEST with ECDSA_SHA_256 and the key ARN -- nothing else", async () => {
    await withKms(async (kms, open) => {
      const signer = await open();
      assert.deepEqual(signer.publicKey, publicKeyOf(SECRET_A));
      assert.equal(signer.label, KEY_A);
      const signature = await signer.sign(DIGEST);
      assert.ok(verifyDigest(publicKeyOf(SECRET_A), DIGEST, signature));
      const sign = kms.requests.find((request) => request.target === "TrentService.Sign");
      assert.deepEqual(sign?.body, { KeyId: KEY_A, Message: DIGEST.toString("base64"), MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }, "no grant tokens, no dry run, no other field");
      assert.deepEqual(kms.requests.find((request) => request.target === "TrentService.GetPublicKey")?.body, { KeyId: KEY_A });
    });
  });

  test("a caller that changes its buffer while KMS answers changes nothing: KMS signed, and the signer verified, the bytes it was given", async () => {
    await withKms(async (kms, open) => {
      const signer = await open();
      const buffer = Buffer.from(DIGEST);
      const pending = signer.sign(buffer);
      buffer.fill(0);
      const signature = await pending;
      assert.ok(verifyDigest(publicKeyOf(SECRET_A), DIGEST, signature), "a signature over the original digest");
      assert.equal(kms.requests.at(-1)?.body.Message, DIGEST.toString("base64"));
    });
  });

  test("a high-s DER from KMS is normalised to low-s (the only form Juno accepts) and still verified", async () => {
    await withKms(async (kms, open) => {
      const signer = await open();
      kms.next({ kind: "high-s" });
      const signature = await signer.sign(DIGEST);
      assert.ok(verifyDigest(publicKeyOf(SECRET_A), DIGEST, signature, true), "low-s");
    });
  });

  test("an answer that is not THIS key's signature is never used: another KeyId, another algorithm, another key's bytes, a malformed or missing DER", async () => {
    await withKms(async (kms, open) => {
      const signer = await open();
      kms.next({ kind: "answer", mutate: (answer) => ({ ...answer, KeyId: KEY_B }) });
      assert.equal(await signerCode(signer.sign(DIGEST)), "verify-failed+maybe-signed");
      kms.next({ kind: "answer", mutate: (answer) => ({ ...answer, SigningAlgorithm: "ECDSA_SHA_384" }) });
      assert.equal(await signerCode(signer.sign(DIGEST)), "verify-failed+maybe-signed");
      kms.next({ kind: "sign-with", secret: SECRET_B });
      assert.equal(await signerCode(signer.sign(DIGEST)), "verify-failed+maybe-signed");
      kms.next({ kind: "answer", mutate: (answer) => ({ ...answer, Signature: Buffer.from("300602010102010100", "hex").toString("base64") }) });
      assert.equal(await signerCode(signer.sign(DIGEST)), "verify-failed+maybe-signed", "a DER with bytes after it (L5-5: it used to escape as a raw Secp256k1Error)");
      kms.next({ kind: "answer", mutate: (answer) => ({ ...answer, Signature: Buffer.from("3006020100020101", "hex").toString("base64") }) });
      assert.equal(await signerCode(signer.sign(DIGEST)), "verify-failed+maybe-signed", "r = 0");
      kms.next({ kind: "answer", mutate: ({ Signature: _dropped, ...rest }) => rest });
      assert.equal(await signerCode(signer.sign(DIGEST)), "verify-failed+maybe-signed");
      assert.ok(verifyDigest(publicKeyOf(SECRET_A), DIGEST, await signer.sign(DIGEST)), "and the next honest answer is fine");
    });
  });

  test("GetPublicKey must describe THIS key as an ECC_SECG_P256K1 SIGN_VERIFY key offering ECDSA_SHA_256 -- or the key does not open", async () => {
    await withKms(async (kms, open) => {
      for (const mutate of [
        (answer: Record<string, unknown>) => ({ ...answer, KeyId: KEY_B }),
        (answer: Record<string, unknown>) => ({ ...answer, KeySpec: "ECC_NIST_P256" }),
        (answer: Record<string, unknown>) => ({ ...answer, KeyUsage: "ENCRYPT_DECRYPT" }),
        (answer: Record<string, unknown>) => ({ ...answer, SigningAlgorithms: ["ECDSA_SHA_384"] }),
        (answer: Record<string, unknown>) => ({ ...answer, PublicKey: Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex").toString("base64") }),
      ]) {
        kms.next({ kind: "answer", mutate });
        assert.notEqual(await signerCode(open()), "signed");
      }
      assert.ok(await open(), "an honest description opens");
    });
  });
});

describe("L5-5 KMS: every failure has one class, and a retry is the same key and the same digest", () => {
  test("the KMS error table", async () => {
    await withKms(async (kms, open) => {
      const signer = await open();
      const table: Array<[string, number, string]> = [
        ["ThrottlingException", 400, "unavailable"],
        ["LimitExceededException", 400, "unavailable"],
        ["KeyUnavailableException", 500, "unavailable"],
        ["KMSInternalException", 500, "unavailable+maybe-signed"],
        ["DependencyTimeoutException", 503, "unavailable+maybe-signed"],
        ["AccessDeniedException", 400, "unavailable"],
        ["NotFoundException", 400, "refused"],
        ["DisabledException", 400, "refused"],
        ["KMSInvalidStateException", 400, "refused"],
        ["InvalidKeyUsageException", 400, "refused"],
        ["InvalidGrantTokenException", 400, "refused"],
        ["ValidationException", 400, "refused"],
        ["SomeFutureClientException", 400, "refused"],
        ["SomeFutureServerException", 500, "unavailable+maybe-signed"],
      ];
      for (const [type, status, expected] of table) {
        kms.next({ kind: "error", type, status });
        assert.equal(await signerCode(signer.sign(DIGEST)), expected, type);
      }
      assert.ok(verifyDigest(publicKeyOf(SECRET_A), DIGEST, await signer.sign(DIGEST)));
      const opening: Array<[string, number, string]> = [
        ["NotFoundException", 400, "refused"],
        ["ThrottlingException", 400, "unavailable"],
      ];
      for (const [type, status, expected] of opening) {
        kms.next({ kind: "error", type, status });
        assert.equal(await signerCode(open()), expected, `GetPublicKey ${type}`);
      }
    });
  });

  for (const when of ["stall-before-sign", "stall-after-sign"] as const) {
    test(`a KMS timeout ${when === "stall-before-sign" ? "BEFORE" : "AFTER"} the signature was made: \`unavailable\`, a signature may exist, and the retry signs the same digest with the same key`, async () => {
      await withKms(async (kms, open) => {
        const signer = await open(KEY_A, 250);
        kms.next({ kind: when });
        assert.equal(await signerCode(signer.sign(DIGEST)), "unavailable+maybe-signed");
        assert.equal(kms.signed.length, when === "stall-after-sign" ? 1 : 0, when === "stall-after-sign" ? "KMS made a signature whose answer never arrived" : "nothing was signed yet");
        const retry = await signer.sign(DIGEST);
        assert.ok(verifyDigest(publicKeyOf(SECRET_A), DIGEST, retry));
        const signs = kms.requests.filter((request) => request.target === "TrentService.Sign");
        assert.deepEqual(new Set(signs.map((request) => `${String(request.body.KeyId)} ${String(request.body.Message)}`)), new Set([`${KEY_A} ${DIGEST.toString("base64")}`]), "every Sign: this key, this digest");
      });
    });
  }

  test("KMS unreachable (nothing listening): `unavailable`, a signature may exist -- never a refusal that would hold work on a guess", async () => {
    const kms = new FakeKms();
    await kms.start();
    const client = createKmsClient({ kind: "kms-local", endpoint: kms.endpoint });
    try {
      const signer = await openKmsDigestSigner(kmsDigestClient(client, { region: LOCAL_TEST_REGION, callDeadlineMs: 1_000 }), KEY_A);
      await kms.stop();
      assert.equal(await signerCode(signer.sign(DIGEST)), "unavailable+maybe-signed");
    } finally {
      client.destroy();
      await kms.stop();
    }
  });

  test("classifyKmsError: an unclassified error is transient with a possible signature; a KmsCallError passes through", () => {
    const unknown = classifyKmsError(new Error("socket hang up"), "Sign");
    assert.equal(unknown.failure, "transient");
    assert.equal(unknown.signatureMayExist, true);
    const refused = new KmsCallError("refused", false, "local:config", "x");
    assert.equal(classifyKmsError(refused, "Sign"), refused);
  });
});

/** The frozen cross-language JOIN admission vectors (ESCROW-JOIN): the digest KMS is asked to sign is exactly theirs. */
function frozenAdmissionVector(): { readonly input: Record<string, unknown>; readonly digest: string } {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, "contracts", "escrow", "testdata"))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error("the repository root was not found");
    dir = up;
  }
  const doc = JSON.parse(fs.readFileSync(path.join(dir, "contracts", "escrow", "testdata", "join_admission_vectors_v1.json"), "utf8")) as {
    vectors: Array<{ valid: boolean; digest: string; inputs: { chain_id: string; contract_addr: string; chain_game_id: string; wallet: string; join_ticket: string; expires_at: string } }>;
  };
  const vector = doc.vectors.find((entry) => entry.valid && entry.inputs.wallet === entry.inputs.wallet.toLowerCase());
  assert.ok(vector !== undefined, "a valid vector exists");
  const i = vector.inputs;
  return { input: { chain_id: i.chain_id, deployment: i.contract_addr, chain_game_id: BigInt(i.chain_game_id), wallet: i.wallet, join_ticket_hex: i.join_ticket, expires_at: BigInt(i.expires_at) }, digest: vector.digest };
}

describe("L5-5 KMS: the signer seam, end to end", () => {
  test("the JOIN admission signer over a KMS key: KMS is asked to sign exactly the frozen vector's digest, and the answer is verified against the configured admission key", async () => {
    await withKms(async (kms, open) => {
      const key = await open();
      const signer = junoJoinAdmissionSigner(publicKeyOf(SECRET_A).toString("hex"), JUNO_CODEC_V1, key);
      const vector = frozenAdmissionVector();
      const signed = await signer.sign(vector.input as never);
      assert.equal(signed.digest_hex, vector.digest, "the codec's digest, byte for byte (no settlement or admission byte changed)");
      assert.ok(verifyDigest(publicKeyOf(SECRET_A), Buffer.from(vector.digest, "hex"), Buffer.from(signed.signature_hex, "hex")));
      assert.equal(kms.requests.at(-1)?.body.Message, Buffer.from(vector.digest, "hex").toString("base64"), "KMS was asked to sign exactly that digest");
      assert.throws(() => junoJoinAdmissionSigner(publicKeyOf(SECRET_B).toString("hex"), JUNO_CODEC_V1, key), SignerError, "a KMS key that is not the configured admission key never opens");
      kms.next({ kind: "sign-with", secret: SECRET_B });
      assert.equal(await signerCode(signer.sign(vector.input as never)), "verify-failed+maybe-signed", "another key's answer is never an admission");
    });
  });
});
