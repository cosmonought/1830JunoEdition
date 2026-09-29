// server/src/escrow/juno/chainFacts.ts
//
// ==================================================================
//  LIVE-4 (L4-4): WHAT THE CHAIN ITSELF SAYS ABOUT A DEPLOYMENT -- THE ONLY SOURCE OF `runtime.chainFacts`
// ==================================================================
//
// The canonical continuation verdict (`frontend/src/gameEngine/compat/continuationVerdict.ts`) holds a money game for a
// DEPLOYMENT CONFLICT only when the contract at the game's address REPORTS, on chain, another code checksum or denom than
// the game was bound to. That is the one deployment answer that writes a durable hold, so the facts it is judged on come
// from here and nowhere else:
//
//   - never from configuration (a typo in `ESCROW_JUNO_CONFIG` is a DERIVED `deployment-unverified`, never a hold);
//   - never from a browser's statement or a cache from an earlier run;
//   - never from one failover answer: `JunoRest.verifiedContractFacts` asks EVERY configured endpoint -- each for its own
//     chain id, whether it is syncing, the contract's code id, that code's checksum and the config query -- and needs
//     every one to answer on the configured chain, not syncing, and (two or more) to agree exactly;
//   - and a malformed answer is no fact: a checksum that is not 64 lowercase hex, or a denom that is not a printable
//     token, reads as "not read" (the verdict itself re-checks the same shape).
//
// Anything short of that is `unavailable`: no entry, so the verdict can never conclude a conflict from it, and a money
// game whose configured facts differ from its binding stays `deployment-unverified` (derived; paged; nothing written).

import { deploymentKey } from "../../../../frontend/src/gameEngine/compat/deploymentCapability";
import type { ChainAttestedFacts } from "../../../../frontend/src/gameEngine/compat/continuationVerdict";
import type { FinancialDeploymentPin } from "../moneyLifecycle";
import { parseConfigResponse, QUERY } from "./junoContract";
import type { JunoRest } from "./junoRest";

export type ChainFactsRead =
  /** A verification-grade read: `facts` are what the contract at `key` reports now. */
  | { readonly kind: "read"; readonly key: string; readonly facts: ChainAttestedFacts; readonly read_at: number } // read_at: when the read STARTED
  /** No verification-grade fact this time (and so none to conclude on): why, for the operator. */
  | { readonly kind: "unavailable"; readonly key: string; readonly detail: string };

const CHECKSUM = /^[0-9a-f]{64}$/;
const DENOM = /^[\x21-\x7e]{1,128}$/;

/** The deployment `pin` names, read from the chain at verification grade -- or why not. Never throws. */
export async function readVerifiedChainFacts(pin: FinancialDeploymentPin, rest: JunoRest, now: () => number = Date.now): Promise<ChainFactsRead> {
  const key = deploymentKey(pin);
  const unavailable = (detail: string): ChainFactsRead => ({ kind: "unavailable", key, detail: detail.slice(0, 400) });
  if (pin.backend !== "juno-cosmwasm") return unavailable(`a ${pin.backend} deployment is not read by the Juno transport`);
  if (rest.chainId !== pin.chain_id) return unavailable(`the transport is configured for ${rest.chainId}, not ${pin.chain_id}`);
  if (rest.verifiedContractFacts === undefined) return unavailable("this chain transport cannot make a verification-grade read");
  const started = now();
  try {
    const answer = await rest.verifiedContractFacts(pin.contract_address, QUERY.config());
    const config = parseConfigResponse(answer.config);
    const facts: ChainAttestedFacts = { code_checksum: answer.code_checksum, denom: config.denom };
    if (typeof facts.code_checksum !== "string" || !CHECKSUM.test(facts.code_checksum)) return unavailable("the chain's code checksum is not 64 lowercase hex");
    if (typeof facts.denom !== "string" || !DENOM.test(facts.denom)) return unavailable("the contract's denom is not a printable token");
    return { kind: "read", key, facts, read_at: started };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}
