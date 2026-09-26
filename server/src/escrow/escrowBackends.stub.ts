// server/src/escrow/escrowBackends.stub.ts
//
// ==================================================================
//  GNOLAND-1: COMPILE-ONLY ADAPTER SKELETONS (no chain I/O, no KMS, no broadcast)
// ==================================================================
//
// These prove the typing: a Juno backend and a Gno backend are both `EscrowBackend`s, selected from a binding, and
// ESCROW-3 code written against `EscrowBackend` compiles unchanged for either. Every transport method refuses with
// NOT_IMPLEMENTED (ESCROW-3 implements Juno's; GNOLAND-4 Gno's). The pieces that are pure and certified -- the Juno
// codec, the Juno capabilities, the ContractError classifier -- are real.

import { EscrowInterfaceError, type EscrowBackendKind, type SignatureSchemeId } from "../../../frontend/src/gameEngine/escrow/escrowCodec";
import {
  ESCROW_ERROR_RETRY,
  GNO_CAPABILITIES_DRAFT,
  JUNO_CAPABILITIES_V1,
  type EscrowBindingV2,
  type EscrowError,
} from "../../../frontend/src/gameEngine/escrow/escrowModel";
import { JUNO_CODEC_V1, junoContractError, junoDomainInputsOf } from "../../../frontend/src/gameEngine/escrow/junoCodecV1";
import { GNO_CODEC_V1_DRAFT, type GnoDomainInputsDraft } from "../../../frontend/src/gameEngine/escrow/gnoCodecV1.draft";
import type { SettlementDomainInputs } from "../../../frontend/src/gameEngine/settlementPayload";
import type { DeploymentPolicy, EscrowBackend, EscrowBackendRegistry, EscrowTransport, SignatureVerifier } from "./escrowPorts";

const notImplemented = (stage: string, what: string): never => {
  throw new EscrowInterfaceError("NOT_IMPLEMENTED", `${what} is ${stage}'s to implement`);
};

function stubTransport(backend: EscrowBackendKind, stage: string, classify: (nativeError: unknown) => EscrowError): EscrowTransport {
  return {
    backend,
    network: async () => notImplemented(stage, "network()"),
    readDeployment: async () => notImplemented(stage, "readDeployment()"),
    readGame: async () => notImplemented(stage, "readGame()"),
    readSignerRegistry: async () => notImplemented(stage, "readSignerRegistry()"),
    walletRequest: () => notImplemented(stage, "walletRequest()"),
    submit: async () => notImplemented(stage, "submit()"),
    inclusion: async () => notImplemented(stage, "inclusion()"),
    consumeSequence: async () => notImplemented(stage, "consumeSequence()"),
    classify,
  };
}

const stubVerifier = (stage: string) => (scheme: SignatureSchemeId): SignatureVerifier => ({
  scheme,
  verify: () => notImplemented(stage, `${scheme} verification`),
});

/** Juno: certified codec + capabilities + classifier; transport and verifier are ESCROW-3's. */
export function junoEscrowBackendSkeleton(chainId: string, acceptDeployment: DeploymentPolicy): EscrowBackend<SettlementDomainInputs> {
  return {
    kind: "juno-cosmwasm",
    chain_id: chainId,
    capabilities: JUNO_CAPABILITIES_V1,
    codec: JUNO_CODEC_V1,
    transport: stubTransport("juno-cosmwasm", "ESCROW-3", (nativeError) => {
      const shape = nativeError as { variant?: unknown; message?: unknown } | null;
      return typeof shape?.variant === "string"
        ? junoContractError(shape.variant, String(shape.message ?? ""))
        : { code: "TX_OUTCOME_UNKNOWN", retry: ESCROW_ERROR_RETRY.TX_OUTCOME_UNKNOWN, native: { backend: "juno-cosmwasm", name: "unclassified", message: String(nativeError) } };
    }),
    acceptDeployment,
    domainInputs: (binding: EscrowBindingV2, rosterHash: string) => junoDomainInputsOf(binding, rosterHash),
    verifier: stubVerifier("ESCROW-3"),
  };
}

/** Gno: the draft codec (refuses bytes) and draft capabilities; everything else is GNOLAND-2/4's. */
export function gnoEscrowBackendSkeleton(chainId: string, acceptDeployment: DeploymentPolicy): EscrowBackend<GnoDomainInputsDraft> {
  return {
    kind: "gno-realm",
    chain_id: chainId,
    capabilities: GNO_CAPABILITIES_DRAFT,
    codec: GNO_CODEC_V1_DRAFT,
    transport: stubTransport("gno-realm", "GNOLAND-4", (nativeError) => ({
      // GNOLAND-2 must give every realm refusal a stable machine code (panic text is never parsed for meaning).
      code: "TX_OUTCOME_UNKNOWN",
      retry: ESCROW_ERROR_RETRY.TX_OUTCOME_UNKNOWN,
      native: { backend: "gno-realm", name: "unclassified", message: String(nativeError) },
    })),
    acceptDeployment,
    domainInputs: () => notImplemented("GNOLAND-2", "the Gno domain inputs"),
    verifier: stubVerifier("GNOLAND-4"),
  };
}

/**
 * A registry over enabled backends, keyed by (backend, chain): a binding for another chain id is never served by
 * this chain's transport. A bundle whose codec and capabilities disagree (id, schemes, seat binding, maturity) is
 * refused at startup; a disabled or unknown backend answers UNSUPPORTED_CAPABILITY, never a fallback.
 */
export function escrowBackendRegistry(backends: readonly EscrowBackend[]): EscrowBackendRegistry {
  const byKey = new Map<string, EscrowBackend>();
  for (const backend of backends) {
    const key = JSON.stringify([backend.kind, backend.chain_id]);
    if (byKey.has(key)) throw new Error(`two ${backend.kind} backends registered for ${backend.chain_id}`);
    const { codec, capabilities } = backend;
    const coherent =
      codec.backend === backend.kind &&
      capabilities.backend === backend.kind &&
      capabilities.codec === codec.id &&
      capabilities.maturity === codec.maturity &&
      capabilities.settlementScheme === codec.settlementScheme &&
      capabilities.consentScheme === codec.consentScheme &&
      capabilities.consentBindsSeat === codec.consentBindsSeat &&
      capabilities.annulBindsSeat === codec.annulBindsSeat;
    if (!coherent) throw new Error(`the ${backend.kind} backend's codec and capabilities disagree`);
    byKey.set(key, backend);
  }
  return {
    forBinding(binding: EscrowBindingV2): EscrowBackend {
      const backend = byKey.get(JSON.stringify([binding.backend, binding.network.chain_id]));
      if (backend === undefined) throw new EscrowInterfaceError("UNSUPPORTED_CAPABILITY", `backend ${binding.backend} on ${binding.network.chain_id} is not enabled on this server`);
      if (backend.codec.id !== binding.codec) throw new EscrowInterfaceError("CODEC_MISMATCH", `binding codec ${binding.codec} is not ${backend.codec.id}`);
      return backend;
    },
  };
}
