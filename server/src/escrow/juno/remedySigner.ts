// server/src/escrow/juno/remedySigner.ts
//
// ==================================================================
//  PHASE 3 FINAL CLOCKS (FP4): THE DEDICATED REMEDY SIGNER -- IT SIGNS REMEDY ATTESTATIONS, AND NOTHING ELSE
// ==================================================================
//
// Owner decision R1 (2026-10-06): a timed remedy reaches escrow 2.1.0 only as an attestation of the DEDICATED REMEDY
// KEY (`18JUNO/REMEDY/v1`, `junoRemedyV1.ts`) -- a key class of its own on chain (`Config.remedy_keys`), never the
// settlement signer, the join-admission key or the relayer. This is that key's port:
//
//   - one `DigestSigner` (KMS in production -- the REMEDY KMS key is the owner's to create; this pass creates none --
//     or a development key only where `checkDevelopmentSignerAllowed` says, never on mainnet);
//   - the digest is ALWAYS re-derived here from the typed attestation (`remedyDigestV1`), never handed in, after the
//     contract's own shape rules (`remedyShapeProblem`) and the configured key id are checked;
//   - every signature is verified against the configured REMEDY public key before it is returned.
//
// FAIL CLOSED. No configured remedy key -> no `RemedySigner` -> the pipeline refuses every remedy (`remedyPipeline.ts`);
// the ordinary settlement signer NEVER substitutes (nothing here, or anywhere, falls back to another key). The config
// refuses a remedy key that is the relayer's, the settlement key or the admission key; the contract refuses the same on
// chain (`register_remedy_key`).

import { encodeRemedyAttestationV1, remedyDigestV1, remedyShapeProblem, type RemedyAttestationV1 } from "../../../../frontend/src/gameEngine/escrow/junoRemedyV1";
import { developmentDigestSigner, SignerError, type DigestSigner } from "./signer";
import { verifyDigest } from "./secp256k1";

export interface SignedRemedy {
  readonly digest_hex: string;
  /** 64 bytes r‖s, low-s, lowercase hex: `SubmitRemedy.signature` on the wire. */
  readonly signature_hex: string;
}

export interface RemedySigner {
  /** The contract's REMEDY key id this key is registered under (`remedy_key_id` in every attestation it signs). */
  readonly remedyKeyId: number;
  /** 33-byte compressed, lowercase hex: must equal the chain registry's key at `remedyKeyId`. */
  readonly publicKeyHex: string;
  readonly kind: DigestSigner["kind"];
  sign(attestation: RemedyAttestationV1): Promise<SignedRemedy>;
}

export function junoRemedySigner(remedyKeyId: number, publicKeyHex: string, signer: DigestSigner): RemedySigner {
  if (!Number.isInteger(remedyKeyId) || remedyKeyId < 1 || remedyKeyId > 0xffff) throw new SignerError("config", "the remedy key id must be 1..65535");
  if (!/^0[23][0-9a-f]{64}$/.test(publicKeyHex)) throw new SignerError("config", "the remedy public key is not a 33-byte compressed key");
  if (signer.publicKey.toString("hex") !== publicKeyHex) throw new SignerError("config", `the remedy key ${signer.label} is not the configured remedy public key`);
  const publicKey = Buffer.from(publicKeyHex, "hex");
  return {
    remedyKeyId,
    publicKeyHex,
    kind: signer.kind,
    async sign(attestation) {
      if (attestation.remedy_key_id !== remedyKeyId) throw new SignerError("config", `the attestation names remedy key ${attestation.remedy_key_id}; this signer is key ${remedyKeyId}`);
      encodeRemedyAttestationV1(attestation); // every field in range (throws otherwise)
      const shape = remedyShapeProblem(attestation);
      if (shape !== null) throw new SignerError("config", `the attestation is refused before signing: ${shape}`);
      const digestHex = remedyDigestV1(attestation);
      const digest = Buffer.from(digestHex, "hex");
      const signature = await signer.sign(digest);
      if (!verifyDigest(publicKey, digest, signature)) throw new SignerError("verify-failed", "the remedy signature does not verify under the configured remedy key");
      return { digest_hex: digestHex, signature_hex: signature.toString("hex") };
    },
  };
}

/** TESTS ONLY: a deterministic remedy signer from a 32-byte secret (the vectors' convention). Never wired by
 *  `start.ts`; production opens the configured key (`openJunoBackend`). */
export function deterministicTestRemedySigner(remedyKeyId: number, secret: Buffer): RemedySigner {
  const signer = developmentDigestSigner(secret, `test remedy key ${remedyKeyId}`, { serverMode: "development", networkClass: "local", chainId: "testing", acknowledged: true });
  return junoRemedySigner(remedyKeyId, signer.publicKey.toString("hex"), signer);
}
