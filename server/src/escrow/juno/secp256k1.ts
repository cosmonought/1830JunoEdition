// server/src/escrow/juno/secp256k1.ts
//
// ==================================================================
//  ESCROW-3B: SECP256K1 OVER A 32-BYTE DIGEST -- THE ONE SIGNATURE SCHEME THE JUNO BACKEND SIGNS AND CHECKS
// ==================================================================
//
// Two things on Juno are "ECDSA secp256k1 over a 32-byte digest, 64-byte r‖s, low-s":
//   - a settlement payload's signature: the digest IS the codec's SETTLE digest (`secp256k1_verify(digest, sig, key)`
//     in the contract; GNOLAND-1 scheme `secp256k1-ecdsa-prehashed/rs64-low-s`);
//   - a Cosmos transaction's signature: the digest is SHA-256(SignDoc bytes) (SIGN_MODE_DIRECT).
// Node's `crypto.sign` always hashes its input again, and AWS KMS signs a DIGEST (`MessageType=DIGEST`) and answers
// DER. So this module is the pure arithmetic both need: key derivation, RFC 6979 deterministic signing over a digest
// (the DEVELOPMENT signer only), verification over a digest (sign-then-verify, KMS output checks), DER -> r‖s, and low-s
// normalisation. BigInt only; no floating point; no dependency.
//
// NOT CONSTANT TIME. `signDigest` exists for the development/test signer (`signer.ts` refuses it in production); a
// production key never enters this process (KMS signs). Verification handles only public values.
//
// Pinned by `junoCrypto.test.ts`: every ESCROW-2 Python RFC 6979 signature in the frozen `payload_vectors_v1.json` is
// reproduced byte for byte from its test secret, and Node's own OpenSSL verifies and produces signatures this module
// accepts (both directions), so three implementations agree.

import { createHmac } from "crypto";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const THREE = BigInt(3);
const SEVEN = BigInt(7);

/** The field prime and the group order. */
export const SECP256K1_P = BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f");
export const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const HALF_N = SECP256K1_N / TWO;
const GX = BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
const GY = BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8");

export class Secp256k1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Secp256k1Error";
  }
}

const mod = (a: bigint, m: bigint): bigint => {
  const r = a % m;
  return r >= ZERO ? r : r + m;
};

function invert(a: bigint, m: bigint): bigint {
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [ONE, ZERO];
  while (r !== ZERO) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== ONE) throw new Secp256k1Error("not invertible");
  return mod(oldS, m);
}

function powMod(base: bigint, exponent: bigint, m: bigint): bigint {
  let result = ONE;
  let b = mod(base, m);
  let e = exponent;
  while (e > ZERO) {
    if ((e & ONE) === ONE) result = (result * b) % m;
    b = (b * b) % m;
    e >>= ONE;
  }
  return result;
}

/* Jacobian coordinates: (X, Y, Z) is the affine point (X/Z², Y/Z³); Z = 0 is the point at infinity. */
type Jacobian = readonly [bigint, bigint, bigint];
const INFINITY: Jacobian = [ZERO, ONE, ZERO];

function double(p: Jacobian): Jacobian {
  const [x, y, z] = p;
  if (z === ZERO || y === ZERO) return INFINITY;
  const P = SECP256K1_P;
  const ysq = (y * y) % P;
  const s = (BigInt(4) * x * ysq) % P;
  const m = (THREE * x * x) % P; // a = 0
  const nx = mod(m * m - TWO * s, P);
  const ny = mod(m * (s - nx) - BigInt(8) * ysq * ysq, P);
  const nz = (TWO * y * z) % P;
  return [nx, ny, nz];
}

function add(p: Jacobian, q: Jacobian): Jacobian {
  if (p[2] === ZERO) return q;
  if (q[2] === ZERO) return p;
  const P = SECP256K1_P;
  const [x1, y1, z1] = p;
  const [x2, y2, z2] = q;
  const z1z1 = (z1 * z1) % P;
  const z2z2 = (z2 * z2) % P;
  const u1 = (x1 * z2z2) % P;
  const u2 = (x2 * z1z1) % P;
  const s1 = (y1 * z2 * z2z2) % P;
  const s2 = (y2 * z1 * z1z1) % P;
  if (u1 === u2) return s1 === s2 ? double(p) : INFINITY;
  const h = mod(u2 - u1, P);
  const r = mod(s2 - s1, P);
  const hh = (h * h) % P;
  const hhh = (h * hh) % P;
  const v = (u1 * hh) % P;
  const nx = mod(r * r - hhh - TWO * v, P);
  const ny = mod(r * (v - nx) - s1 * hhh, P);
  const nz = (z1 * z2 * h) % P;
  return [nx, ny, nz];
}

function multiply(k: bigint, point: Jacobian): Jacobian {
  let result = INFINITY;
  let addend = point;
  let e = k;
  while (e > ZERO) {
    if ((e & ONE) === ONE) result = add(result, addend);
    addend = double(addend);
    e >>= ONE;
  }
  return result;
}

function affine(p: Jacobian): { x: bigint; y: bigint } | null {
  if (p[2] === ZERO) return null;
  const zi = invert(p[2], SECP256K1_P);
  const zi2 = (zi * zi) % SECP256K1_P;
  return { x: (p[0] * zi2) % SECP256K1_P, y: (p[1] * zi2 * zi) % SECP256K1_P };
}

const G: Jacobian = [GX, GY, ONE];

/* ------------------------------------------------------------------ */
/* Bytes                                                               */
/* ------------------------------------------------------------------ */

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = ZERO;
  for (let i = 0; i < bytes.length; i += 1) value = (value << BigInt(8)) | BigInt(bytes[i]);
  return value;
}

export function bigIntTo32(value: bigint): Buffer {
  if (value < ZERO || value >= ONE << BigInt(256)) throw new Secp256k1Error("value does not fit 32 bytes");
  const out = Buffer.alloc(32);
  let v = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & BigInt(0xff));
    v >>= BigInt(8);
  }
  return out;
}

const hexBuf = (hex: string, bytes: number, what: string): Buffer => {
  if (typeof hex !== "string" || hex.length !== bytes * 2 || !/^[0-9a-f]*$/.test(hex)) throw new Secp256k1Error(`${what} must be ${bytes} bytes of lowercase hex`);
  return Buffer.from(hex, "hex");
};

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

/** A valid secret scalar: 1 ≤ d < n. */
export function checkSecret(secret: Uint8Array): bigint {
  if (secret.length !== 32) throw new Secp256k1Error("a secret key is 32 bytes");
  const d = bytesToBigInt(secret);
  if (d === ZERO || d >= SECP256K1_N) throw new Secp256k1Error("the secret key is out of range");
  return d;
}

/** The 33-byte compressed public key of a secret. */
export function publicKeyOf(secret: Uint8Array): Buffer {
  const point = affine(multiply(checkSecret(secret), G));
  if (point === null) throw new Secp256k1Error("the secret key is out of range");
  return Buffer.concat([Buffer.from([point.y & ONE ? 0x03 : 0x02]), bigIntTo32(point.x)]);
}

/** A 33-byte compressed key, decompressed and checked to be on the curve. */
export function decompressPublicKey(compressed: Uint8Array): { x: bigint; y: bigint } {
  if (compressed.length !== 33 || (compressed[0] !== 0x02 && compressed[0] !== 0x03)) throw new Secp256k1Error("a compressed public key is 33 bytes with prefix 02 or 03");
  const x = bytesToBigInt(compressed.subarray(1));
  if (x >= SECP256K1_P) throw new Secp256k1Error("the public key's x is out of range");
  const ySquared = mod(x * x * x + SEVEN, SECP256K1_P);
  let y = powMod(ySquared, (SECP256K1_P + ONE) / BigInt(4), SECP256K1_P);
  if ((y * y) % SECP256K1_P !== ySquared) throw new Secp256k1Error("the public key is not on the curve");
  if ((y & ONE) !== BigInt(compressed[0] & 1)) y = SECP256K1_P - y;
  return { x, y };
}

/* ------------------------------------------------------------------ */
/* Signatures                                                          */
/* ------------------------------------------------------------------ */

/** A signature in the only form Juno accepts: 64 bytes r‖s with s ≤ n/2. */
export function normalizeLowS(signature: Uint8Array): Buffer {
  if (signature.length !== 64) throw new Secp256k1Error("a signature is 64 bytes r||s");
  const r = bytesToBigInt(signature.subarray(0, 32));
  let s = bytesToBigInt(signature.subarray(32));
  if (r === ZERO || r >= SECP256K1_N || s === ZERO || s >= SECP256K1_N) throw new Secp256k1Error("the signature is out of range");
  if (s > HALF_N) s = SECP256K1_N - s;
  return Buffer.concat([bigIntTo32(r), bigIntTo32(s)]);
}

export const isLowS = (signature: Uint8Array): boolean => signature.length === 64 && bytesToBigInt(signature.subarray(32)) <= HALF_N;

/** A DER `ECDSA-Sig-Value` (what AWS KMS returns) as 64 bytes r‖s, low-s normalised. Strict: one SEQUENCE of two
 *  minimal positive INTEGERs, nothing after it. */
export function derToCompact(der: Uint8Array): Buffer {
  const fail = (why: string): never => {
    throw new Secp256k1Error(`the DER signature is malformed: ${why}`);
  };
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30) fail("not a short SEQUENCE");
  if (der[1] !== der.length - 2) fail("the SEQUENCE length is not the rest of the input");
  let at = 2;
  const integer = (): bigint => {
    if (der[at] !== 0x02) fail("an element is not an INTEGER");
    const length = der[at + 1];
    if (length === undefined || length === 0 || length > 33 || at + 2 + length > der.length) fail("an INTEGER length is out of range");
    const body = der.subarray(at + 2, at + 2 + length);
    if (body[0] & 0x80) fail("an INTEGER is negative");
    if (length > 1 && body[0] === 0x00 && !(body[1] & 0x80)) fail("an INTEGER is not minimal");
    at += 2 + length;
    return bytesToBigInt(body);
  };
  const r = integer();
  const s = integer();
  if (at !== der.length) fail("bytes follow the two INTEGERs");
  if (r === ZERO || r >= SECP256K1_N || s === ZERO || s >= SECP256K1_N) fail("r or s is out of range");
  return normalizeLowS(Buffer.concat([bigIntTo32(r), bigIntTo32(s)]));
}

/** Verifies a 64-byte r‖s signature over a 32-byte digest. `requireLowS` is the contract's and the chain's rule. */
export function verifyDigest(publicKey: Uint8Array, digest: Uint8Array, signature: Uint8Array, requireLowS = true): boolean {
  try {
    if (digest.length !== 32 || signature.length !== 64) return false;
    const q = decompressPublicKey(publicKey);
    const r = bytesToBigInt(signature.subarray(0, 32));
    const s = bytesToBigInt(signature.subarray(32));
    if (r === ZERO || r >= SECP256K1_N || s === ZERO || s >= SECP256K1_N) return false;
    if (requireLowS && s > HALF_N) return false;
    const z = mod(bytesToBigInt(digest), SECP256K1_N);
    const w = invert(s, SECP256K1_N);
    const u1 = (z * w) % SECP256K1_N;
    const u2 = (r * w) % SECP256K1_N;
    const point = affine(add(multiply(u1, G), multiply(u2, [q.x, q.y, ONE])));
    return point !== null && mod(point.x, SECP256K1_N) === r;
  } catch {
    return false;
  }
}

const hmac = (key: Buffer, ...parts: Buffer[]): Buffer => {
  const mac = createHmac("sha256", key);
  for (const part of parts) mac.update(part);
  return mac.digest();
};

/**
 * RFC 6979 deterministic ECDSA over a 32-byte digest (HMAC-SHA-256), low-s normalised: the same secret and digest
 * always give the same 64 bytes. DEVELOPMENT/TEST SIGNING ONLY (not constant time; see the header).
 */
export function signDigest(secret: Uint8Array, digest: Uint8Array): Buffer {
  if (digest.length !== 32) throw new Secp256k1Error("a digest is 32 bytes");
  const d = checkSecret(secret);
  const z = mod(bytesToBigInt(digest), SECP256K1_N);
  const x = bigIntTo32(d);
  const h1 = bigIntTo32(z);
  let v = Buffer.alloc(32, 0x01);
  let k = Buffer.alloc(32, 0x00);
  k = hmac(k, v, Buffer.from([0x00]), x, h1);
  v = hmac(k, v);
  k = hmac(k, v, Buffer.from([0x01]), x, h1);
  v = hmac(k, v);
  for (let guard = 0; guard < 1000; guard += 1) {
    v = hmac(k, v);
    const candidate = bytesToBigInt(v);
    if (candidate >= ONE && candidate < SECP256K1_N) {
      const point = affine(multiply(candidate, G));
      if (point !== null) {
        const r = mod(point.x, SECP256K1_N);
        if (r !== ZERO) {
          const s = mod(invert(candidate, SECP256K1_N) * (z + r * d), SECP256K1_N);
          if (s !== ZERO) return normalizeLowS(Buffer.concat([bigIntTo32(r), bigIntTo32(s)]));
        }
      }
    }
    k = hmac(k, v, Buffer.from([0x00]));
    v = hmac(k, v);
  }
  throw new Secp256k1Error("RFC 6979 found no nonce (unreachable)");
}

/** Hex conveniences for callers that keep keys and digests as lowercase hex. */
export const signDigestHex = (secretHex: string, digestHex: string): string => signDigest(hexBuf(secretHex, 32, "the secret"), hexBuf(digestHex, 32, "the digest")).toString("hex");
export const verifyDigestHex = (publicKeyHex: string, digestHex: string, signatureHex: string): boolean => {
  try {
    return verifyDigest(hexBuf(publicKeyHex, 33, "the public key"), hexBuf(digestHex, 32, "the digest"), hexBuf(signatureHex, 64, "the signature"));
  } catch {
    return false;
  }
};
