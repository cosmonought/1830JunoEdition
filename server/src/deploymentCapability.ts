// server/src/deploymentCapability.ts
//
// ==================================================================
//  LIVE-4 (L4-1): THIS BUILD'S DEPLOYMENT CAPABILITY -- WHAT A POOL RUNNING IT CAN CONTINUE
// ==================================================================
//
// The canonical descriptor (`frontend/src/gameEngine/compat/deploymentCapability.ts`) filled in from this build's own
// constants and the escrow deployments its configuration serves. Pure: no I/O, no clock, no build id. The facts come
// from where they already live -- the rules engine and its settlement certification, the protocol axes, the codecs
// and the escrow contract code this build speaks (`CANONICAL_JUNO_ESCROW_CHECKSUMS`, which is server-only) -- so
// nothing is restated.
//
// NOT WIRED YET. L4-1 is the pure model: nothing at startup computes, prints or compares this. L4-2 hands it to the
// continuation verdict at every load, L4-6 prints its key in the banner and `ops/status.json`, and LIVE-5 compares the
// key with the pool item's. Until then its one reader is the test that pins this build's key, so that any change that
// moves the key is visible in review.

import { RULES_ENGINE_VERSION, SUPPORTED_RULES_ENGINE_VERSIONS } from "../../frontend/src/gameEngine/rulesVersion";
import { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } from "../../frontend/src/gameEngine/settlementAppraisal";
import { ACCEPTED_CLIENT_PROTOCOLS, FINANCIAL_PROTOCOL_VERSION, HOSTED_PROTOCOL_VERSION } from "../../frontend/src/gameEngine/protocolVersions";
import {
  DEPLOYMENT_CAPABILITY_FORMAT,
  deploymentCapability,
  servedDeployment,
  type DeploymentCapability,
  type DeploymentPin,
} from "../../frontend/src/gameEngine/compat/deploymentCapability";
import { DEPLOYMENT_SETTLEMENT_CODECS } from "./escrow/moneyContinuation";
import { CANONICAL_JUNO_ESCROW_CHECKSUMS } from "./escrow/juno/junoConfig";

/**
 * This build's capability, serving `escrowDeployments` (the configured backend's pin, `pinOf(config)`, or none).
 * Without an escrow deployment it speaks no financial protocol: no money lifecycle runs on such a server, so no money
 * game is continued by it, and two such releases never differ in that field.
 */
export function thisDeploymentCapability(escrowDeployments: readonly DeploymentPin[]): DeploymentCapability {
  return deploymentCapability({
    format: DEPLOYMENT_CAPABILITY_FORMAT,
    rules: {
      current: RULES_ENGINE_VERSION,
      supported: SUPPORTED_RULES_ENGINE_VERSIONS,
      certified: SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS,
    },
    hosted_protocols: [HOSTED_PROTOCOL_VERSION],
    financial_protocols: escrowDeployments.length === 0 ? [] : [FINANCIAL_PROTOCOL_VERSION],
    settlement_codecs: DEPLOYMENT_SETTLEMENT_CODECS,
    escrow_abi_checksums: CANONICAL_JUNO_ESCROW_CHECKSUMS,
    escrow_deployments: escrowDeployments.map(servedDeployment),
    client_protocols: ACCEPTED_CLIENT_PROTOCOLS,
  });
}
