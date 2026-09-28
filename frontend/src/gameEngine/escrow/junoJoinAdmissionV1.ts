// frontend/src/gameEngine/escrow/junoJoinAdmissionV1.ts
//
// ==================================================================
//  ESCROW-JOIN (2026-09-28): THE JUNO JOIN ADMISSION DIGEST -- WHAT THE HOSTED SERVER SIGNS SO ONE WALLET MAY JOIN
// ==================================================================
//
// Before this, the escrow contract's `Join` checked only the join ticket's 32-byte SHAPE: any wallet that paid the exact
// ante could take a seat, including with a ticket copied out of an honest player's visible `Join` (the ESCROW-3B
// junk-Join production blocker). The contract (escrow 2.0.0, `contracts/escrow/src/crypto.rs`) now needs the server's
// ADMISSION: a secp256k1 signature, by the key in `Config.admission_pubkey`, over
//
//   join = SHA-256("18JUNO/JOIN/v1" ‖ u16(len) ‖ chain_id ‖ u16(len) ‖ contract_addr ‖ u64(chain_game_id)
//                  ‖ u16(len) ‖ wallet ‖ join_ticket(32) ‖ u64(expires_at))
//
// with every integer fixed-width big-endian, every string its exact bytes (addresses are the chain's canonical lower-case
// bech32; no JSON anywhere), and `wallet` = the Join transaction's own SENDER -- so an admission copied into another
// wallet's Join never verifies. `expires_at` is Unix seconds; the contract requires block time < expires_at.
//
// This is the ONLY TypeScript spelling of those bytes. Three independent implementations agree on them byte for byte:
// this file, the contract (`crypto::join_admission_digest`), and the Python generator of the frozen vectors
// (`contracts/escrow/testdata/gen_join_admission_vectors.py` → `join_admission_vectors_v1.json`), pinned by
// `frontend/src/utils/escrowJoinAdmissionVectors.test.ts`. It is not a settlement byte: SET-0C is untouched.

import { sha256HexOfBytes, utf8Bytes } from "../sha256";

export const JUNO_JOIN_TAG_V1 = "18JUNO/JOIN/v1";

/** The admission's inputs, exactly as the contract rebuilds them. */
export interface JunoJoinAdmissionInputs {
  /** The chain id the node reports (`env.block.chain_id`), e.g. `juno-1`, `uni-7`. */
  readonly chain_id: string;
  /** This escrow contract's canonical bech32 address (`env.contract.address`). */
  readonly contract_addr: string;
  /** The contract's u64 game id. */
  readonly chain_game_id: bigint;
  /** The joining wallet's canonical (lower-case) bech32 address: the future `Join` sender. */
  readonly wallet: string;
  /** The seat's join ticket (32 bytes, lowercase hex), carried verbatim by the same `Join`. */
  readonly join_ticket: string;
  /** Unix seconds; the contract accepts the Join only while block time is strictly before it. */
  readonly expires_at: bigint;
}

export class JoinAdmissionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JoinAdmissionInputError";
  }
}

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const HEX32 = /^[0-9a-f]{64}$/;

/** A string the chain could present as this field: non-empty printable ASCII with no upper case (bech32 is canonical
 *  in lower case; the chain id is lower case too), at most u16 bytes. Anything else can never match the chain's own
 *  bytes, so it is refused rather than hashed. */
function field(value: unknown, where: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) throw new JoinAdmissionInputError(`${where} must be a non-empty string`);
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (code < 0x21 || code > 0x7e || (code >= 0x41 && code <= 0x5a)) throw new JoinAdmissionInputError(`${where} must be lower-case printable ASCII (the chain's canonical spelling)`);
  }
  if (value.length > 0xffff) throw new JoinAdmissionInputError(`${where} is longer than a u16 length prefix allows`);
  const bytes = utf8Bytes(value);
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (bytes.length >> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

function u64(value: unknown, where: string): Uint8Array {
  if (typeof value !== "bigint" || value < BigInt(0) || value > U64_MAX) throw new JoinAdmissionInputError(`${where} must be a u64 bigint`);
  const out = new Uint8Array(8);
  let rest = value;
  for (let at = 7; at >= 0; at -= 1) {
    out[at] = Number(rest & BigInt(0xff));
    rest >>= BigInt(8);
  }
  return out;
}

function ticketBytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || !HEX32.test(value)) throw new JoinAdmissionInputError("join_ticket must be 32 bytes of lowercase hex");
  const out = new Uint8Array(32);
  for (let at = 0; at < 32; at += 1) out[at] = parseInt(value.slice(at * 2, at * 2 + 2), 16);
  return out;
}

/** The exact bytes the admission key's digest is taken over. */
export function joinAdmissionPreimageV1(inputs: JunoJoinAdmissionInputs): Uint8Array {
  const parts = [
    utf8Bytes(JUNO_JOIN_TAG_V1),
    field(inputs.chain_id, "chain_id"),
    field(inputs.contract_addr, "contract_addr"),
    u64(inputs.chain_game_id, "chain_game_id"),
    field(inputs.wallet, "wallet"),
    ticketBytes(inputs.join_ticket),
    u64(inputs.expires_at, "expires_at"),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** SHA-256 of the preimage: the 32-byte digest the admission key signs (lowercase hex). */
export function joinAdmissionDigestV1(inputs: JunoJoinAdmissionInputs): string {
  return sha256HexOfBytes(joinAdmissionPreimageV1(inputs));
}
