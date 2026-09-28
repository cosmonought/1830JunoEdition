/** @jest-environment node */
// frontend/src/utils/escrowJoinAdmissionVectors.test.ts
//
// ==================================================================
//  ESCROW-JOIN (2026-09-28): THE JOIN ADMISSION DIGEST, TYPESCRIPT AGAINST THE FROZEN CROSS-LANGUAGE VECTORS
// ==================================================================
//
// `contracts/escrow/testdata/join_admission_vectors_v1.json` was written by an independent Python generator
// (`gen_join_admission_vectors.py`) from the specification text; the contract reproduces every byte and executes every
// vector on chain (`tests/join_admission_vectors.rs`). Here the TypeScript builder (`junoJoinAdmissionV1.ts`) and the
// Juno codec reproduce every preimage and digest, and an INDEPENDENT verifier (@cosmjs/crypto, plus the contract's
// explicit low-s rule) reaches exactly the contract's verdict on every signature. The GNOLAND-1 interface carries the
// admission for every backend: Juno certified, Gno declared and refusing until GNOLAND-2.

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { Secp256k1, Secp256k1Signature } from "@cosmjs/crypto";

import { EscrowInterfaceError } from "../gameEngine/escrow/escrowCodec";
import { JUNO_CODEC_V1 } from "../gameEngine/escrow/junoCodecV1";
import { GNO_CODEC_V1_DRAFT, GNO_TAGS_V1_DRAFT } from "../gameEngine/escrow/gnoCodecV1.draft";
import { GNO_CAPABILITIES_DRAFT, JUNO_CAPABILITIES_V1 } from "../gameEngine/escrow/escrowModel";
import { JUNO_JOIN_TAG_V1, JoinAdmissionInputError, joinAdmissionDigestV1, joinAdmissionPreimageV1 } from "../gameEngine/escrow/junoJoinAdmissionV1";

const FILE = join(__dirname, "..", "..", "..", "contracts", "escrow", "testdata", "join_admission_vectors_v1.json");
const FILE_SHA256 = "cacc9ea3d0086253e27d8a67b7c16266f7113799526e888fe810197d16763cfb";
const SECP_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

interface Vector {
  name: string;
  inputs: { chain_id: string; contract_addr: string; chain_game_id: string; wallet: string; join_ticket: string; expires_at: string };
  preimage: string;
  digest: string;
  signature: string;
  valid: boolean;
  mutates?: string;
}

const raw = readFileSync(FILE);
const doc = JSON.parse(raw.toString("utf8")) as { format: string; tag: string; keys: Record<string, { pubkey: string }>; vectors: Vector[] };
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const inputsOf = (v: Vector) => ({
  chain_id: v.inputs.chain_id,
  contract_addr: v.inputs.contract_addr,
  chain_game_id: BigInt(v.inputs.chain_game_id),
  wallet: v.inputs.wallet,
  join_ticket: v.inputs.join_ticket,
  expires_at: BigInt(v.inputs.expires_at),
});

/** The contract's rule, checked independently of the server: 64 bytes, low-s, ECDSA over the digest itself. */
async function contractVerdict(pubkeyHex: string, digestHex: string, sigHex: string): Promise<boolean> {
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return false;
  const s = BigInt(`0x${sigHex.slice(64)}`);
  const r = BigInt(`0x${sigHex.slice(0, 64)}`);
  if (r === BigInt(0) || s === BigInt(0) || r >= SECP_N || s >= SECP_N || s > SECP_N / BigInt(2)) return false;
  return Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(bytes(sigHex)), bytes(digestHex), bytes(pubkeyHex));
}

describe("ESCROW-JOIN: the frozen join-admission vectors", () => {
  it("the file is the frozen one", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(FILE_SHA256);
    expect(doc.format).toBe("18JUNO/JOIN/admission-vectors/v1");
    expect(doc.tag).toBe(JUNO_JOIN_TAG_V1);
    expect(doc.vectors).toHaveLength(20);
    expect(doc.vectors.filter((v) => v.valid).map((v) => v.name)).toEqual(["base", "testnet", "extremes", "keplr-20-byte-wallet"]);
  });

  it.each(doc.vectors.map((v) => [v.name, v] as const))("%s: preimage, digest (builder and codec) and the contract's verdict", async (_, v) => {
    const canonical = v.inputs.wallet === v.inputs.wallet.toLowerCase();
    if (canonical) {
      expect(Buffer.from(joinAdmissionPreimageV1(inputsOf(v))).toString("hex")).toBe(v.preimage);
      expect(joinAdmissionDigestV1(inputsOf(v))).toBe(v.digest);
      expect(createHash("sha256").update(Buffer.from(v.preimage, "hex")).digest("hex")).toBe(v.digest);
      const viaCodec = JUNO_CODEC_V1.joinAdmissionDigest({
        chain_id: v.inputs.chain_id,
        deployment: v.inputs.contract_addr,
        chain_game_id: BigInt(v.inputs.chain_game_id),
        wallet: v.inputs.wallet,
        join_ticket_hex: v.inputs.join_ticket,
        expires_at: BigInt(v.inputs.expires_at),
      });
      expect(viaCodec).toEqual({ codec: "18JUNO/v1", purpose: "join-admission", hex: v.digest });
    } else {
      // The chain's sender is lower-case bech32: a builder that hashed another spelling would sign a dead admission.
      expect(() => joinAdmissionPreimageV1(inputsOf(v))).toThrow(JoinAdmissionInputError);
    }
    expect(await contractVerdict(doc.keys.admission.pubkey, v.digest, v.signature)).toBe(v.valid);
  });

  it("every single-field mutation changes the digest; the copied signature never verifies", () => {
    const base = doc.vectors.find((v) => v.name === "base")!;
    const mutated = doc.vectors.filter((v) => v.name.startsWith("mutate-"));
    expect(mutated.map((v) => v.mutates).sort()).toEqual(["chain_id", "contract_addr", "chain_game_id", "expires_at", "join_ticket", "wallet", "wallet"].sort());
    for (const v of mutated) {
      expect(v.digest).not.toBe(base.digest);
      expect(v.signature).toBe(base.signature);
      expect(v.valid).toBe(false);
    }
  });

  it("the builder refuses what the chain could never present", () => {
    const base = inputsOf(doc.vectors.find((v) => v.name === "base")!);
    const bad = [
      { ...base, chain_id: "" },
      { ...base, contract_addr: "juno1 abc" },
      { ...base, wallet: "juno1ÄBC" },
      { ...base, join_ticket: "AB".repeat(32) },
      { ...base, join_ticket: "ab".repeat(31) },
      { ...base, chain_game_id: BigInt(-1) },
      { ...base, chain_game_id: BigInt(1) << BigInt(64) },
      { ...base, expires_at: BigInt(1) << BigInt(64) },
      { ...base, expires_at: 5 as unknown as bigint },
    ];
    for (const inputs of bad) expect(() => joinAdmissionDigestV1(inputs)).toThrow(JoinAdmissionInputError);
  });
});

describe("ESCROW-JOIN in the GNOLAND-1 interface: every backend's Join verifies a server admission", () => {
  it("both capability sets declare it; Juno signs admissions with secp256k1, the Gno draft with Ed25519", () => {
    expect([JUNO_CAPABILITIES_V1.joinAuthorization, GNO_CAPABILITIES_DRAFT.joinAuthorization]).toEqual(["server-admission", "server-admission"]);
    expect(JUNO_CAPABILITIES_V1.admissionScheme).toBe(JUNO_CODEC_V1.admissionScheme);
    expect(GNO_CAPABILITIES_DRAFT.admissionScheme).toBe(GNO_CODEC_V1_DRAFT.admissionScheme);
    expect([JUNO_CODEC_V1.admissionScheme, GNO_CODEC_V1_DRAFT.admissionScheme]).toEqual(["secp256k1-ecdsa-prehashed/rs64-low-s", "ed25519-pure/sig64"]);
  });

  it("the Gno draft declares its JOIN tag and refuses to produce bytes until GNOLAND-2", () => {
    expect(GNO_TAGS_V1_DRAFT.JOIN).toBe("18GNO/JOIN/v1");
    expect(GNO_TAGS_V1_DRAFT.JOIN).not.toBe(JUNO_JOIN_TAG_V1);
    let error: unknown = null;
    try {
      GNO_CODEC_V1_DRAFT.joinAdmissionDigest({ chain_id: "test5", deployment: "gno.land/r/x", chain_game_id: BigInt(1), wallet: "g1a", join_ticket_hex: "00".repeat(32), expires_at: BigInt(1) });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EscrowInterfaceError);
    expect((error as EscrowInterfaceError).code).toBe("NOT_IMPLEMENTED");
  });

  it("the Juno codec refuses a non-canonical deployment or wallet before hashing", () => {
    const base = doc.vectors.find((v) => v.name === "base")!.inputs;
    const args = { chain_id: base.chain_id, deployment: base.contract_addr, chain_game_id: BigInt(1), wallet: base.wallet, join_ticket_hex: base.join_ticket, expires_at: BigInt(base.expires_at) };
    expect(() => JUNO_CODEC_V1.joinAdmissionDigest({ ...args, wallet: base.wallet.toUpperCase() })).toThrow();
    expect(() => JUNO_CODEC_V1.joinAdmissionDigest({ ...args, deployment: "" })).toThrow();
  });
});
