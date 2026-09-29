// server/src/escrow/juno/signer.ts
//
// ==================================================================
//  ESCROW-3B: THE SERVER'S TWO JUNO KEYS -- BEHIND ONE SIGNING SEAM, NEVER INSIDE GAMEPLAY CODE
// ==================================================================
//
// The server holds two DIFFERENT secp256k1 keys for a Juno deployment (GNOLAND-1 §18), and neither ever reaches
// gameplay code, a record, a log line, a RoomView, the client bundle or a URL:
//
//   the SETTLEMENT key   signs SETTLE digests of payloads it re-derived itself (checkpoints and terminal settlements);
//                        registered in the contract's signer registry under `signer_key_id`;
//   the RELAYER key      signs Cosmos transactions (SHA-256 of the SignDoc) for the fee-paying account that is also the
//                        contract's `operator` (only the operator may Start a game).
//
// Both are a `DigestSigner`: a public key and "sign these 32 bytes". Two implementations:
//
//   KMS           (production)   AWS KMS `ECC_SECG_P256K1`, `ECDSA_SHA_256`, `MessageType=DIGEST` -> DER -> r‖s ->
//                                low-s. `KmsClient` is the port; LIVE-5 binds it to the AWS SDK and IAM (kms:Sign on
//                                exactly this key). This file does the DER, the key parsing and the checks.
//   DEVELOPMENT  (Junox, local)  RFC 6979 in-process over a key read from a FILE (a 64-hex secret or a BIP-39 mnemonic
//                                at m/44'/118'/0'/0/0 -- the path Keplr and junod use). REFUSED unless the server runs
//                                GS_MODE=development, the network class is `testnet` or `local`, the chain id is not
//                                a mainnet id, and the configuration says so explicitly. A key never comes from an
//                                environment variable's VALUE or a command line (shell history, process listings).
//
// Every signature is VERIFIED against the signer's public key before it is used (sign-then-verify): a KMS that
// answers for another key, a corrupted DER or a bug in this file produces a refusal, never a transaction.

import { createHmac, pbkdf2Sync } from "crypto";
import { promises as fsp } from "fs";

import { requireDigest, type CodecDigest, type EscrowCodec } from "../../../../frontend/src/gameEngine/escrow/escrowCodec";
import type { BuiltSettlementCoreV1 } from "../../../../frontend/src/gameEngine/escrow/settlementCoreV1";
import { settlementDigestToSign, type SchemeSignature, type SettlementKeyConfig, type SettlementSigner, type SigningJournal } from "../escrowPorts";
import { SECP256K1_N, bigIntTo32, bytesToBigInt, derToCompact, publicKeyOf, signDigest, verifyDigest } from "./secp256k1";

/**
 * What a signer failure means to the caller (LIVE-5 L5-5 made the KMS classes explicit):
 *   config           the key does not match the configuration (open time) -- nothing is ever signed with it;
 *   refused          the signer refuses this key or request (KMS: not found, disabled, wrong usage...): an operator acts;
 *   verify-failed    an answer that is not a valid low-s signature BY THIS KEY over THESE bytes: never used;
 *   journal-conflict another digest is already reserved at this slot: the caller HOLDS;
 *   unavailable      no usable answer now (throttled, a fault, a timeout): a retry is the SAME request -- the same key
 *                    and the same digest (a settlement digest is reserved before it is signed; a lost relayer signature
 *                    never became a transaction). `signatureMayExist`: the request may have been signed in a lost answer.
 * No failure ever selects another key, signer or digest: there is no fallback anywhere.
 */
export type SignerErrorCode = "config" | "refused" | "verify-failed" | "journal-conflict" | "unavailable";

export class SignerError extends Error {
  constructor(
    readonly code: SignerErrorCode,
    message: string,
    readonly detail: { readonly signatureMayExist?: boolean; readonly native?: string } = {},
  ) {
    super(message);
    this.name = "SignerError";
  }
}

/** A KMS port failure as a `SignerError` (duck-typed on `aws/kms/kmsDigestClient.ts`'s `KmsCallError`, so this module
 *  never loads the AWS SDK). Anything unclassified is `unavailable` with a possible signature: never a guess that
 *  nothing was signed, and never a refusal that would hold work on a guess. */
function signerErrorOf(error: unknown, what: string): SignerError {
  if (error instanceof SignerError) return error;
  const kms = error as { name?: unknown; failure?: unknown; signatureMayExist?: unknown; native?: unknown; message?: unknown };
  const message = `${what}: ${error instanceof Error ? error.message : String(error)}`;
  if (kms?.name === "KmsCallError") {
    const detail = { signatureMayExist: kms.signatureMayExist === true, native: typeof kms.native === "string" ? kms.native : undefined };
    if (kms.failure === "refused") return new SignerError("refused", message, detail);
    if (kms.failure === "invalid-answer") return new SignerError("verify-failed", message, detail);
    if (kms.failure === "transient") return new SignerError("unavailable", message, detail);
  }
  return new SignerError("unavailable", message, { signatureMayExist: true });
}

export interface DigestSigner {
  readonly kind: "kms" | "development";
  /** Non-secret: a KMS key ARN, or `development:<file name>`. Safe to log. */
  readonly label: string;
  /** 33-byte compressed secp256k1 key. */
  readonly publicKey: Buffer;
  /** 64 bytes r‖s, low-s, verified against `publicKey` before it is returned. */
  sign(digest: Buffer): Promise<Buffer>;
}

/* ------------------------------------------------------------------ */
/* KMS                                                                 */
/* ------------------------------------------------------------------ */

/** The AWS KMS operations the signer needs (LIVE-5 implements it with the SDK; tests fake it). */
export interface KmsClient {
  /** `GetPublicKey`: the DER SubjectPublicKeyInfo. */
  getPublicKey(keyRef: string): Promise<Uint8Array>;
  /** `Sign` with `SigningAlgorithm=ECDSA_SHA_256`, `MessageType=DIGEST`: the DER ECDSA-Sig-Value. */
  signDigest(keyRef: string, digest: Uint8Array): Promise<Uint8Array>;
}

/** SubjectPublicKeyInfo for id-ecPublicKey on secp256k1 (1.3.132.0.10) with an uncompressed point: a fixed prefix. */
const SECP256K1_SPKI_PREFIX = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");

export function compressedKeyFromSpki(spki: Uint8Array): Buffer {
  const der = Buffer.from(spki);
  if (der.length !== SECP256K1_SPKI_PREFIX.length + 65 || !der.subarray(0, SECP256K1_SPKI_PREFIX.length).equals(SECP256K1_SPKI_PREFIX) || der[SECP256K1_SPKI_PREFIX.length] !== 0x04) {
    throw new SignerError("config", "the KMS key is not an uncompressed secp256k1 (ECC_SECG_P256K1) public key");
  }
  const x = der.subarray(SECP256K1_SPKI_PREFIX.length + 1, SECP256K1_SPKI_PREFIX.length + 33);
  const y = der.subarray(SECP256K1_SPKI_PREFIX.length + 33);
  return Buffer.concat([Buffer.from([y[31] & 1 ? 0x03 : 0x02]), x]);
}

/**
 * A `DigestSigner` over ONE KMS key, fixed at open: its reference (a key ARN; `kmsDigestClient` refuses anything else) and
 * the public key KMS reported for it (the caller checks that against the configuration, `checkSignerIdentities`). Every
 * signature is over exactly the caller's 32 bytes and is verified against that public key before it is returned; an
 * answer that is not DER, not low-s-normalisable or not this key's is `verify-failed`, never used (L5-5: a malformed DER
 * used to escape as a raw `Secp256k1Error`, outside the signer's classes). No failure tries another key.
 */
export async function openKmsDigestSigner(client: KmsClient, keyRef: string): Promise<DigestSigner> {
  let publicKey: Buffer;
  try {
    publicKey = compressedKeyFromSpki(await client.getPublicKey(keyRef));
  } catch (error) {
    throw signerErrorOf(error, `KMS GetPublicKey failed for ${keyRef}`);
  }
  return {
    kind: "kms",
    label: keyRef,
    publicKey,
    async sign(digest) {
      if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new SignerError("refused", "a digest is 32 bytes");
      /* The bytes asked for and the bytes verified are one private copy: nothing that happens to the caller's buffer
         while KMS answers changes either. */
      const exact = Buffer.from(digest);
      let der: Uint8Array;
      try {
        der = await client.signDigest(keyRef, Uint8Array.from(exact));
      } catch (error) {
        throw signerErrorOf(error, "KMS Sign failed");
      }
      let signature: Buffer;
      try {
        signature = derToCompact(der);
      } catch (error) {
        throw new SignerError("verify-failed", `the KMS answer is not a valid DER signature (${error instanceof Error ? error.message : String(error)}); it is never used`, { signatureMayExist: true });
      }
      if (!verifyDigest(publicKey, exact, signature)) throw new SignerError("verify-failed", "the KMS signature does not verify under the key's own public key", { signatureMayExist: true });
      return signature;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Development                                                         */
/* ------------------------------------------------------------------ */

export const DEFAULT_COSMOS_HD_PATH = "m/44'/118'/0'/0/0";

/** BIP-32 private derivation along `path` from a BIP-39 seed. */
export function deriveSecp256k1FromSeed(seed: Uint8Array, hdPath: string = DEFAULT_COSMOS_HD_PATH): Buffer {
  const parts = hdPath.split("/");
  if (parts[0] !== "m" || parts.length < 2) throw new SignerError("config", `HD path ${hdPath} is not m/...`);
  let node = createHmac("sha512", "Bitcoin seed").update(seed).digest();
  let key = node.subarray(0, 32);
  let chain = node.subarray(32);
  if (bytesToBigInt(key) === BigInt(0) || bytesToBigInt(key) >= SECP256K1_N) throw new SignerError("config", "the seed yields an invalid master key");
  for (const part of parts.slice(1)) {
    const hardened = part.endsWith("'");
    const index = Number(hardened ? part.slice(0, -1) : part);
    if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new SignerError("config", `HD path element ${part} is not an index`);
    const i = hardened ? index + 0x80000000 : index;
    const ser = Buffer.alloc(4);
    ser.writeUInt32BE(i >>> 0);
    const data = hardened ? Buffer.concat([Buffer.from([0]), key, ser]) : Buffer.concat([publicKeyOf(key), ser]);
    node = createHmac("sha512", chain).update(data).digest();
    const il = bytesToBigInt(node.subarray(0, 32));
    const child = (il + bytesToBigInt(key)) % SECP256K1_N;
    if (il >= SECP256K1_N || child === BigInt(0)) throw new SignerError("config", "an HD derivation step is invalid (use another index)");
    key = bigIntTo32(child);
    chain = node.subarray(32);
  }
  return Buffer.from(key);
}

/** The secret a development key file holds: 64 hex characters, or a BIP-39 mnemonic (12-24 words). */
export function secretFromKeyText(text: string, hdPath: string = DEFAULT_COSMOS_HD_PATH): Buffer {
  const trimmed = text.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed.replace(/^0x/, ""), "hex");
  const words = trimmed.normalize("NFKD").split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length) || !words.every((word) => /^[a-z]+$/.test(word))) {
    throw new SignerError("config", "the development key file holds neither a 64-hex secret nor a 12-24 word lowercase mnemonic");
  }
  const seed = pbkdf2Sync(words.join(" "), "mnemonic", 2048, 64, "sha512");
  return deriveSecp256k1FromSeed(seed, hdPath);
}

export interface DevelopmentSignerGuard {
  readonly serverMode: "development" | "production";
  readonly networkClass: "mainnet" | "testnet" | "local";
  readonly chainId: string;
  /** The explicit configuration switch (`ESCROW_DEV_SIGNER=allow-unprotected-testnet-key`). */
  readonly acknowledged: boolean;
}

/** Mainnet chain ids a development key may never sign for, whatever else is configured. */
export const MAINNET_CHAIN_IDS: readonly string[] = Object.freeze(["juno-1"]);

export function checkDevelopmentSignerAllowed(guard: DevelopmentSignerGuard): void {
  if (guard.serverMode !== "development") throw new SignerError("refused", "a development signer is refused in GS_MODE=production (use KMS)");
  if (guard.networkClass === "mainnet" || MAINNET_CHAIN_IDS.includes(guard.chainId)) throw new SignerError("refused", "a development signer never signs for a mainnet chain");
  if (!guard.acknowledged) throw new SignerError("refused", "a development signer must be enabled explicitly (ESCROW_DEV_SIGNER=allow-unprotected-testnet-key)");
}

/** A development signer over a key held in memory (tests pass the secret directly; the server reads a key file). */
export function developmentDigestSigner(secret: Uint8Array, label: string, guard: DevelopmentSignerGuard): DigestSigner {
  checkDevelopmentSignerAllowed(guard);
  const key = Buffer.from(secret);
  const publicKey = publicKeyOf(key);
  return {
    kind: "development",
    label: `development:${label}`,
    publicKey,
    async sign(digest) {
      if (digest.length !== 32) throw new SignerError("refused", "a digest is 32 bytes");
      const signature = signDigest(key, digest);
      if (!verifyDigest(publicKey, digest, signature)) throw new SignerError("verify-failed", "the development signature does not verify");
      return signature;
    },
  };
}

export async function openDevelopmentSignerFile(file: string, guard: DevelopmentSignerGuard, hdPath: string = DEFAULT_COSMOS_HD_PATH): Promise<DigestSigner> {
  checkDevelopmentSignerAllowed(guard);
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    throw new SignerError("config", `the development key file cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  const secret = secretFromKeyText(text, hdPath);
  const name = file.split(/[\\/]/).pop() ?? "key";
  return developmentDigestSigner(secret, name, guard);
}

/* ------------------------------------------------------------------ */
/* The settlement signer (GNOLAND-1 §7, O-3)                           */
/* ------------------------------------------------------------------ */

/**
 * Signs settlement payloads: re-derives the digest from the payload (never trusting `built.settle`), requires this
 * key's registry id and the game's frozen domain, RESERVES the digest in the external journal, signs, and verifies.
 * A journal conflict (a different digest already reserved at this seq under this key) refuses: the caller HOLDS.
 */
export function junoSettlementSigner(key: SettlementKeyConfig, codec: EscrowCodec<unknown>, signer: DigestSigner, journal: SigningJournal): SettlementSigner {
  if (signer.publicKey.toString("hex") !== key.public_key_hex) {
    throw new SignerError("config", `the settlement key ${signer.label} is not the configured public key for signer key ${key.signer_key_id}`);
  }
  return {
    key,
    codec,
    async signPayload(input: { readonly instance: string; readonly built: BuiltSettlementCoreV1; readonly frozen_domain: string }): Promise<SchemeSignature> {
      const digest: CodecDigest<"settle"> = settlementDigestToSign(key, codec, input.built, input.frozen_domain);
      const reserved = await journal.reserveSettlement({ instance: input.instance, seq: input.built.payload.seq.toString(), signer_key_id: key.signer_key_id, digest });
      if (reserved.kind === "conflict") {
        throw new SignerError("journal-conflict", `seq ${input.built.payload.seq.toString()} under key ${key.signer_key_id} was already reserved for another digest (${reserved.digest_hex.slice(0, 16)}…)`);
      }
      const digestBytes = Buffer.from(requireDigest(digest, codec.id, "settle", "the settlement digest").hex, "hex");
      const signature = await signer.sign(digestBytes);
      if (!verifyDigest(Buffer.from(key.public_key_hex, "hex"), digestBytes, signature)) throw new SignerError("verify-failed", "the settlement signature does not verify under the registered key");
      return {
        scheme: key.scheme,
        codec: codec.id,
        purpose: "settle",
        digest_hex: digest.hex,
        signature_hex: signature.toString("hex"),
        signer_key_id: key.signer_key_id,
      };
    },
  };
}
