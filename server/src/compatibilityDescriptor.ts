// server/src/compatibilityDescriptor.ts
//
// ==================================================================
//  LIVE-4 (L4-6): WHAT COMPATIBILITY IDENTITY THIS PROCESS IS ACTUALLY SERVING -- ONE DESCRIPTOR, THREE SURFACES
// ==================================================================
//
// The operator's question is "what compatibility identity is this server serving?". It is answered from the ONE
// deployment capability the process judges everything against (`start.ts`: `serving.capability`, the money serving's --
// the same descriptor every session verdict, every money seam and every client verdict reads), never reconstructed from
// constants by hand. Three surfaces print it:
//
//   the startup banner         the key, and the axes it is made of (`bannerLines`)
//   `ops/status.json`          `compatibility` (this object, minus nothing), beside the store and actor counters
//   `gamesDoctor compat`       the same object, as canonical JSON, for the configuration the operator names
//
// WHAT IS IN IT, AND WHAT IS NOT:
//   `compatibility_key`        `compatibilityKey(capability)` -- production's own function over production's own
//                              descriptor. Nothing here hashes anything else.
//   `capability`               the canonical descriptor the key hashes (`deploymentCapability`), verbatim.
//   `axes`                     the same facts, named for a reader: rules (current / readable / settlement-certified),
//                              hosted, financial and client protocols, the settlement codecs, the served deployments.
//                              `client_protocol_of_this_source` is what a bundle built from this source announces
//                              (`cp`) -- not what is deployed or connected; the capability lists the protocols the server
//                              ACCEPTS. Both are shown; only the accepted list is keyed.
//   `diagnostics`              the build id (and nothing else today). DIAGNOSTIC ONLY: it is printed beside the key and
//                              is never an input to it, to any continuation verdict or to any protocol-1 client verdict.
//                              Two builds with equal keys are one pool (`deploymentCapability.ts`).
//
// Pure: no I/O, no clock. Canonical: `canonicalJson` (keys sorted recursively), so two processes with equal facts print
// byte-identical text -- and the diagnostic block is the only part that may differ between them.

import { canonicalJson } from "../../frontend/src/gameEngine/stateDigest";
import {
  capabilityCanonicalText,
  compatibilityKey,
  deploymentCapability,
  type DeploymentCapability,
} from "../../frontend/src/gameEngine/compat/deploymentCapability";
import { CLIENT_PROTOCOL_VERSION } from "../../frontend/src/gameEngine/protocolVersions";

export const COMPATIBILITY_DESCRIPTOR_FORMAT = "18COSMOS/COMPATIBILITY-DESCRIPTOR/v1";

export interface CompatibilityDescriptor {
  readonly format: typeof COMPATIBILITY_DESCRIPTOR_FORMAT;
  /** The pool's name: `compatibilityKey(capability)`. No build id is in it. */
  readonly compatibility_key: string;
  /** The canonical descriptor the key hashes, verbatim. */
  readonly capability: DeploymentCapability;
  /** The same facts, named for a reader (derived from `capability`, never separately sourced). */
  readonly axes: {
    readonly rules_engine_version: number;
    readonly readable_rules: readonly number[];
    readonly settlement_certified_rules: readonly number[];
    readonly hosted_protocols: readonly number[];
    readonly financial_protocols: readonly number[];
    /** What a bundle built from THIS SOURCE announces (`cp`) -- not a statement about the bundles actually deployed or
     *  connected. Not keyed: the accepted list below is. */
    readonly client_protocol_of_this_source: number;
    readonly accepted_client_protocols: readonly number[];
    readonly settlement_codecs: readonly string[];
    /** The deployment keys served (`backend|chain_id|contract`); empty when no escrow deployment is configured. */
    readonly escrow_deployments: readonly string[];
  };
  /** Diagnostic only: never an input to the key or to any compatibility decision. */
  readonly diagnostics: { readonly build_id: string | null };
}

/** The descriptor of `capability` -- the process's one capability -- with `build` as diagnostic metadata only. */
export function compatibilityDescriptor(capability: DeploymentCapability, diagnostics: { readonly build_id?: string | null } = {}): CompatibilityDescriptor {
  const canonical = deploymentCapability(capability);
  return Object.freeze({
    format: COMPATIBILITY_DESCRIPTOR_FORMAT,
    compatibility_key: compatibilityKey(canonical),
    capability: canonical,
    axes: Object.freeze({
      rules_engine_version: canonical.rules.current,
      readable_rules: canonical.rules.supported,
      settlement_certified_rules: canonical.rules.certified,
      hosted_protocols: canonical.hosted_protocols,
      financial_protocols: canonical.financial_protocols,
      client_protocol_of_this_source: CLIENT_PROTOCOL_VERSION,
      accepted_client_protocols: canonical.client_protocols,
      settlement_codecs: canonical.settlement_codecs,
      escrow_deployments: canonical.escrow_deployments.map((deployment) => deployment.key),
    }),
    diagnostics: Object.freeze({ build_id: diagnostics.build_id ?? null }),
  });
}

/** The build id an operator tool prints beside the key: `--build <id>` when given, else the process's `BUILD_ID`, else
 *  none. DIAGNOSTIC ONLY -- read here, beside the descriptor, so no continuation or money seam ever reads it. */
export function diagnosticBuildId(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (flag !== undefined && flag !== "") return flag;
  const fromEnv = env.BUILD_ID;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : null;
}

/** The operator tools' descriptor: `capability`'s, with `diagnosticBuildId(flag)` as its diagnostic. (Kept here so the
 *  tools that judge games never handle a build id themselves -- `gamesDoctor.ts` is guarded against any build token.) */
export function operatorDescriptor(capability: DeploymentCapability, flag: string | undefined): CompatibilityDescriptor {
  return compatibilityDescriptor(capability, { build_id: diagnosticBuildId(flag) });
}

/** The descriptor as canonical JSON (keys sorted recursively): byte-identical for equal facts and equal diagnostics. */
export function compatibilityDescriptorText(descriptor: CompatibilityDescriptor): string {
  return canonicalJson(descriptor);
}

/** The exact text the key hashes (re-exported so an operator can check a key by hand: `dc1-` + 24 hex of SHA-256). */
export const capabilityText = capabilityCanonicalText;

/** The banner's lines for the descriptor: the key first, then the axes, then the build as a diagnostic. */
export function bannerLines(descriptor: CompatibilityDescriptor): string[] {
  const a = descriptor.axes;
  const list = (values: readonly (number | string)[]) => (values.length === 0 ? "none" : values.join(", "));
  return [
    `  compatibility key ${descriptor.compatibility_key} -- the pool this process serves (LIVE-4); the build id is NOT part of it`,
    `    rules ${a.rules_engine_version} (reads [${list(a.readable_rules)}], settles [${list(a.settlement_certified_rules)}]); hosted [${list(a.hosted_protocols)}]; financial [${list(a.financial_protocols)}]; ` +
      `clients accepted [${list(a.accepted_client_protocols)}] (this source's bundle announces ${a.client_protocol_of_this_source}); codecs [${list(a.settlement_codecs)}]; escrow ${a.escrow_deployments.length === 0 ? "none configured" : list(a.escrow_deployments)}`,
    `    build "${descriptor.diagnostics.build_id ?? "?"}" is diagnostic only: protocol-1 clients and stored games are judged by the key's facts, never by build equality`,
  ];
}
