// server/src/escrow/juno/joinAdmission.ts
//
// ==================================================================
//  ESCROW-JOIN (2026-09-28): THE SERVER'S THIRD JUNO KEY -- IT SIGNS JOIN ADMISSIONS, AND NOTHING ELSE
// ==================================================================
//
// Escrow 2.0.0's `Join` seats a wallet only with the hosted server's ADMISSION: a secp256k1 signature, by the key in the
// contract's `Config.admission_pubkey`, over the JOIN digest of (chain id, contract, chain game id, the joining WALLET,
// the seat's join ticket, an expiry) -- `junoJoinAdmissionV1.ts`, pinned by the frozen cross-language vectors. The
// contract rebuilds the digest from the Join transaction's own sender, so an admission copied into another wallet's
// Join never verifies, and a ticket copied without its admission seats nobody.
//
// The admission key is its OWN key (GNOLAND-1 §18 discipline): never the relayer's Cosmos account key, never the
// settlement key (the contract refuses a current or former admission key as a signer key and vice versa; the config
// refuses the same signer reference or public key twice). A leak of the admission key lets an attacker seat wallets --
// the pre-repair status quo, griefing only: it moves no money, settles nothing and starts nothing (Start is the
// operator's, settlement the settlement key's). Rotation is the admin's `SetAdmissionKey` plus this server's config.
//
// Like the other two keys it is a `DigestSigner` (KMS in production -- LIVE-5 wires the client, until then a KMS key
// refuses to open and no admission is ever issued; a development key only where `checkDevelopmentSignerAllowed` says).
// The digest is always re-derived HERE from the inputs (the caller never hands in a digest), and every signature is
// verified against the configured admission public key before it is returned. It is not journalled: an admission is
// not a settlement, is bound to one wallet and expires; the service records it on the seat's ticket grant first.

import { requireDigest, type EscrowCodec, type JoinAdmissionInput } from "../../../../frontend/src/gameEngine/escrow/escrowCodec";
import { SignerError, type DigestSigner } from "./signer";
import { verifyDigest } from "./secp256k1";

export interface SignedJoinAdmission {
  readonly digest_hex: string;
  /** 64 bytes r‖s, low-s, lowercase hex: `JoinAdmission.signature` on the wire. */
  readonly signature_hex: string;
}

export interface JoinAdmissionSigner {
  readonly codec: EscrowCodec<unknown>;
  /** 33-byte compressed, lowercase hex: must equal the contract's `Config.admission_pubkey`. */
  readonly publicKeyHex: string;
  readonly kind: DigestSigner["kind"];
  sign(input: JoinAdmissionInput): Promise<SignedJoinAdmission>;
}

export function junoJoinAdmissionSigner(publicKeyHex: string, codec: EscrowCodec<unknown>, signer: DigestSigner): JoinAdmissionSigner {
  if (codec.id !== "18JUNO/v1" || codec.admissionScheme !== "secp256k1-ecdsa-prehashed/rs64-low-s") throw new SignerError("config", "the Juno admission signer needs the 18JUNO/v1 codec (secp256k1 admissions)");
  if (!/^0[23][0-9a-f]{64}$/.test(publicKeyHex)) throw new SignerError("config", "the admission public key is not a 33-byte compressed key");
  if (signer.publicKey.toString("hex") !== publicKeyHex) throw new SignerError("config", `the admission key ${signer.label} is not the configured admission public key`);
  const publicKey = Buffer.from(publicKeyHex, "hex");
  return {
    codec,
    publicKeyHex,
    kind: signer.kind,
    async sign(input) {
      const digest = requireDigest(codec.joinAdmissionDigest(input), codec.id, "join-admission", "the join admission digest");
      const digestBytes = Buffer.from(digest.hex, "hex");
      const signature = await signer.sign(digestBytes);
      if (!verifyDigest(publicKey, digestBytes, signature)) throw new SignerError("verify-failed", "the admission signature does not verify under the configured admission key");
      return { digest_hex: digest.hex, signature_hex: signature.toString("hex") };
    },
  };
}
