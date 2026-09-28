// server/src/escrow/juno/cosmosTx.ts
//
// ==================================================================
//  ESCROW-3B: A COSMOS SDK TRANSACTION, BYTE FOR BYTE -- ONLY WHAT THE RELAYER SENDS (MsgExecuteContract, DIRECT)
// ==================================================================
//
// The relayer submits exactly one kind of transaction: one `cosmwasm.wasm.v1.MsgExecuteContract` (a JSON execute
// message for the escrow contract; never funds -- every relayer route is non-payable), signed SIGN_MODE_DIRECT by one
// secp256k1 account, with a `timeout_height` (the attempt's expiry: after it the chain can never include these bytes,
// which is what makes "provably dead" decidable -- GNOLAND-1 §14) and an explicit fee. This file encodes that and nothing
// else, as the proto3 wire format the chain re-derives the sign bytes from:
//
//   TxRaw     { 1 body_bytes, 2 auth_info_bytes, 3 signatures[] }
//   TxBody    { 1 messages[] Any, 2 memo, 3 timeout_height }
//   AuthInfo  { 1 signer_infos[] { 1 public_key Any(secp256k1.PubKey{1 key}), 2 mode_info{1 single{1 mode=DIRECT}},
//               3 sequence }, 2 fee { 1 amount[] Coin{1 denom, 2 amount}, 2 gas_limit } }
//   SignDoc   { 1 body_bytes, 2 auth_info_bytes, 3 chain_id, 4 account_number }
//
// Proto3 rules: fields in number order, zero/empty scalars omitted, varints little-endian base-128. The TRANSACTION'S
// IDENTITY is SHA-256(TxRaw bytes) -- fixed the moment the bytes are signed, and persisted before any broadcast
// (`relayer.ts`): a retry rebroadcasts THOSE bytes; nothing is ever re-signed to "the same" transaction.
//
// Also here: bech32 (the account address a public key controls: RIPEMD-160(SHA-256(compressed key)) under the `juno`
// prefix), so the configured relayer address is PROVEN to be the signing key's, never trusted.
//
// Pinned by `junoCrypto.test.ts` and, byte for byte against CosmJS/cosmjs-types (which the frontend carries), by
// `frontend/src/utils/escrow3bCosmosTxParity.test.ts`.

import { createHash } from "crypto";

/* ------------------------------------------------------------------ */
/* Protobuf wire encoding (the subset used here)                        */
/* ------------------------------------------------------------------ */

export class CosmosTxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CosmosTxError";
  }
}

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

function varint(value: bigint): Buffer {
  if (value < BigInt(0) || value > U64_MAX) throw new CosmosTxError(`varint ${value.toString()} is not a u64`);
  const out: number[] = [];
  let v = value;
  do {
    let byte = Number(v & BigInt(0x7f));
    v >>= BigInt(7);
    if (v > BigInt(0)) byte |= 0x80;
    out.push(byte);
  } while (v > BigInt(0));
  return Buffer.from(out);
}

const tag = (field: number, wireType: 0 | 2): Buffer => varint(BigInt((field << 3) | wireType));

/** A length-delimited field (bytes, string, embedded message); proto3 omits an empty one. */
function lengthDelimited(field: number, bytes: Uint8Array, keepEmpty = false): Buffer {
  if (bytes.length === 0 && !keepEmpty) return Buffer.alloc(0);
  return Buffer.concat([tag(field, 2), varint(BigInt(bytes.length)), Buffer.from(bytes)]);
}

const stringField = (field: number, value: string): Buffer => lengthDelimited(field, Buffer.from(value, "utf8"));

/** A varint field; proto3 omits zero. */
function uintField(field: number, value: bigint): Buffer {
  if (value === BigInt(0)) return Buffer.alloc(0);
  return Buffer.concat([tag(field, 0), varint(value)]);
}

/** A decimal u64 string as a bigint (canonical: no sign, no leading zeros). */
export function u64Of(value: string, where: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new CosmosTxError(`${where}=${String(value)} is not a canonical u64 decimal`);
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new CosmosTxError(`${where}=${value} is not a u64`);
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export interface Coin {
  readonly denom: string;
  /** Base units, canonical decimal. */
  readonly amount: string;
}

export const MSG_EXECUTE_CONTRACT_TYPE_URL = "/cosmwasm.wasm.v1.MsgExecuteContract";
export const SECP256K1_PUBKEY_TYPE_URL = "/cosmos.crypto.secp256k1.PubKey";
/** `cosmos.tx.signing.v1beta1.SignMode.SIGN_MODE_DIRECT`. */
export const SIGN_MODE_DIRECT = 1;

const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);

const coin = (value: Coin): Buffer => {
  if (typeof value.amount !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(value.amount) || BigInt(value.amount) > U128_MAX) {
    throw new CosmosTxError(`coin amount ${String(value.amount)} is not a canonical u128 decimal`);
  }
  if (!/^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/.test(value.denom)) throw new CosmosTxError(`denom ${value.denom} is not a Cosmos denomination`);
  return Buffer.concat([stringField(1, value.denom), stringField(2, value.amount)]);
};

const any = (typeUrl: string, value: Uint8Array): Buffer => Buffer.concat([stringField(1, typeUrl), lengthDelimited(2, value)]);

/** `MsgExecuteContract { sender, contract, msg (JSON bytes), funds }` -- the relayer never attaches funds. */
export function encodeMsgExecuteContract(input: { readonly sender: string; readonly contract: string; readonly msg: Uint8Array; readonly funds?: readonly Coin[] }): Buffer {
  return Buffer.concat([
    stringField(1, input.sender),
    stringField(2, input.contract),
    lengthDelimited(3, input.msg),
    ...(input.funds ?? []).map((value) => lengthDelimited(5, coin(value), true)),
  ]);
}

export function encodeTxBody(input: { readonly messages: readonly { readonly typeUrl: string; readonly value: Uint8Array }[]; readonly memo: string; readonly timeoutHeight: bigint }): Buffer {
  return Buffer.concat([...input.messages.map((message) => lengthDelimited(1, any(message.typeUrl, message.value), true)), stringField(2, input.memo), uintField(3, input.timeoutHeight)]);
}

export function encodeAuthInfo(input: { readonly publicKey: Uint8Array; readonly sequence: bigint; readonly fee: readonly Coin[]; readonly gasLimit: bigint }): Buffer {
  if (input.publicKey.length !== 33) throw new CosmosTxError("the signer's public key must be 33 bytes (compressed secp256k1)");
  const pubKeyAny = any(SECP256K1_PUBKEY_TYPE_URL, lengthDelimited(1, input.publicKey));
  const modeInfo = lengthDelimited(1, uintField(1, BigInt(SIGN_MODE_DIRECT)), true);
  const signerInfo = Buffer.concat([lengthDelimited(1, pubKeyAny), lengthDelimited(2, modeInfo, true), uintField(3, input.sequence)]);
  const fee = Buffer.concat([...input.fee.map((value) => lengthDelimited(1, coin(value), true)), uintField(2, input.gasLimit)]);
  return Buffer.concat([lengthDelimited(1, signerInfo, true), lengthDelimited(2, fee, true)]);
}

export function encodeSignDoc(input: { readonly bodyBytes: Uint8Array; readonly authInfoBytes: Uint8Array; readonly chainId: string; readonly accountNumber: bigint }): Buffer {
  return Buffer.concat([lengthDelimited(1, input.bodyBytes), lengthDelimited(2, input.authInfoBytes), stringField(3, input.chainId), uintField(4, input.accountNumber)]);
}

export function encodeTxRaw(input: { readonly bodyBytes: Uint8Array; readonly authInfoBytes: Uint8Array; readonly signatures: readonly Uint8Array[] }): Buffer {
  return Buffer.concat([lengthDelimited(1, input.bodyBytes), lengthDelimited(2, input.authInfoBytes), ...input.signatures.map((signature) => lengthDelimited(3, signature, true))]);
}

/** The transaction id the chain reports (`txhash`): SHA-256 of the broadcast TxRaw bytes, upper-case hex. */
export const txHashOf = (txRaw: Uint8Array): string => createHash("sha256").update(txRaw).digest("hex").toUpperCase();

/** What the account signs: SHA-256(SignDoc bytes) (secp256k1 SIGN_MODE_DIRECT). */
export const signDocDigest = (signDoc: Uint8Array): Buffer => createHash("sha256").update(signDoc).digest();

/* ------------------------------------------------------------------ */
/* One relayer transaction                                             */
/* ------------------------------------------------------------------ */

export interface UnsignedExecuteTx {
  readonly chainId: string;
  readonly accountNumber: string;
  readonly sequence: string;
  readonly sender: string;
  readonly contract: string;
  /** The execute message, as the exact JSON bytes the contract will parse. */
  readonly msgJson: string;
  readonly publicKey: Uint8Array;
  readonly gasLimit: string;
  readonly fee: Coin;
  readonly timeoutHeight: string;
  readonly memo: string;
}

export interface PreparedTx {
  readonly bodyBytes: Buffer;
  readonly authInfoBytes: Buffer;
  readonly signDoc: Buffer;
  readonly digest: Buffer;
}

export function prepareExecuteTx(tx: UnsignedExecuteTx): PreparedTx {
  if (tx.memo.length > 256) throw new CosmosTxError("the memo is over 256 bytes");
  const msg = encodeMsgExecuteContract({ sender: tx.sender, contract: tx.contract, msg: Buffer.from(tx.msgJson, "utf8") });
  const bodyBytes = encodeTxBody({ messages: [{ typeUrl: MSG_EXECUTE_CONTRACT_TYPE_URL, value: msg }], memo: tx.memo, timeoutHeight: u64Of(tx.timeoutHeight, "timeout_height") });
  const authInfoBytes = encodeAuthInfo({ publicKey: tx.publicKey, sequence: u64Of(tx.sequence, "sequence"), fee: [tx.fee], gasLimit: u64Of(tx.gasLimit, "gas_limit") });
  const signDoc = encodeSignDoc({ bodyBytes, authInfoBytes, chainId: tx.chainId, accountNumber: u64Of(tx.accountNumber, "account_number") });
  return { bodyBytes, authInfoBytes, signDoc, digest: signDocDigest(signDoc) };
}

/** The bytes to broadcast, and their id. */
export function assembleTx(prepared: PreparedTx, signature: Uint8Array): { readonly txBytes: Buffer; readonly txHash: string } {
  if (signature.length !== 64) throw new CosmosTxError("a transaction signature is 64 bytes r||s");
  const txBytes = encodeTxRaw({ bodyBytes: prepared.bodyBytes, authInfoBytes: prepared.authInfoBytes, signatures: [signature] });
  return { txBytes, txHash: txHashOf(txBytes) };
}

/** The simulation form: the same body and auth info with an empty signature (the node skips signature checks when
 *  simulating, and charges the size of what it is given). */
export const simulationTx = (prepared: PreparedTx): Buffer => encodeTxRaw({ bodyBytes: prepared.bodyBytes, authInfoBytes: prepared.authInfoBytes, signatures: [Buffer.alloc(0)] });

/* ------------------------------------------------------------------ */
/* Bech32 and the address a key controls                               */
/* ------------------------------------------------------------------ */

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) chk ^= BECH32_GEN[i];
  }
  return chk >>> 0;
}

const hrpExpand = (hrp: string): number[] => [...hrp.split("").map((c) => c.charCodeAt(0) >> 5), 0, ...hrp.split("").map((c) => c.charCodeAt(0) & 31)];

function convertBits(data: readonly number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new CosmosTxError("bech32: a value is out of range");
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new CosmosTxError("bech32: non-zero padding");
  }
  return out;
}

export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits(Array.from(bytes), 8, 5, true);
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => BECH32_CHARSET[d]).join("")}`;
}

/** Strict: lowercase only (the form the chain writes), a valid checksum, the expected prefix when given. */
export function bech32Decode(address: string, expectedHrp?: string): { readonly hrp: string; readonly bytes: Buffer } {
  if (typeof address !== "string" || address.length > 90 || address !== address.toLowerCase()) throw new CosmosTxError("bech32: not a lowercase address");
  const at = address.lastIndexOf("1");
  if (at < 1 || at + 7 > address.length) throw new CosmosTxError("bech32: no separator");
  const hrp = address.slice(0, at);
  if (expectedHrp !== undefined && hrp !== expectedHrp) throw new CosmosTxError(`bech32: prefix ${hrp}, expected ${expectedHrp}`);
  const data = address.slice(at + 1).split("").map((c) => {
    const index = BECH32_CHARSET.indexOf(c);
    if (index < 0) throw new CosmosTxError("bech32: a character is outside the charset");
    return index;
  });
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new CosmosTxError("bech32: bad checksum");
  return { hrp, bytes: Buffer.from(convertBits(data.slice(0, -6), 5, 8, false)) };
}

/** The account address a compressed secp256k1 key controls: bech32(prefix, RIPEMD-160(SHA-256(key))). */
export function addressOfPublicKey(publicKey: Uint8Array, prefix: string): string {
  if (publicKey.length !== 33) throw new CosmosTxError("a secp256k1 account key is 33 bytes");
  let ripemd: Buffer;
  try {
    ripemd = createHash("ripemd160").update(createHash("sha256").update(publicKey).digest()).digest();
  } catch (error) {
    throw new CosmosTxError(`this Node build cannot compute RIPEMD-160 (${error instanceof Error ? error.message : String(error)}); the relayer address cannot be proven`);
  }
  return bech32Encode(prefix, ripemd);
}
