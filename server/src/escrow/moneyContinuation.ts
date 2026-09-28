// server/src/escrow/moneyContinuation.ts
//
// ==================================================================
//  ESCROW-3A (brief §8): WHICH DEPLOYMENT MAY CONTINUE A FUNDED GAME -- A SEMANTIC IDENTITY, NOT A COMMIT HASH
// ==================================================================
//
// #1252 pins every hosted game to the BUILD that dealt it: another build serves it read-only. For an ordinary game that
// is the safe answer. For a FUNDED game it strands money on every deploy -- the players' antes sit in escrow while no
// server may continue the game that decides them (LIVE-2F/3D §14.5). Weakening the build pin globally is not the answer
// either: the pin exists because nothing else says "this reducer means what the dealing one meant".
//
// For money games this module says it, explicitly. A funded game carries a durable CONTINUATION IDENTITY, frozen when it
// is created (ESCROW-3B writes it into the financial record with the money binding), and a deployment may continue the
// game -- across builds -- only when its own identity is COMPATIBLE with the stored one:
//
//   rules_engine_version   the deal's pin: this deployment must PLAY it (`SUPPORTED_RULES_ENGINE_VERSIONS`) and SETTLE it
//                          (`SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS`). Every change to what a stored log replays to
//                          bumps it (PROJECT_CANONICAL_CONTEXT §D.1), so equal pins are equal gameplay semantics.
//   hosted_protocol        the server-owned history's meaning outside the reducer: the log format and its commit
//                          protocol, the GameRecord schema, the server-built SetupGame, the terminal seal and the sealed
//                          prefix. Bumped by any change that would make this server read a stored history differently.
//   financial_protocol     the money lifecycle (`moneyLifecycle.ts`): its phases, transitions and policy, and the
//                          settlement intent's identity `(gameId, seal.log_len)`. Bumped by any change to them.
//   settlement_codec       the escrow wire the game's payloads are built in (SettlementCoreV1 under `18JUNO/v1`): the
//                          deployment must carry that certified codec.
//
// Equal identities (and a deployment that plays and settles the pin) CONTINUE; anything else FAILS CLOSED: the game stays
// read-only there (#1252's answer), nothing is replayed under unproven semantics, and LIVE-6 routes the game to a task
// that is compatible. A git commit is deliberately NOT part of the identity: two builds that differ only in a comment,
// a copy change or an unrelated fix may continue each other's games; a build that changes semantics must say so by
// bumping one of the four, and then it cannot.
//
// Today no funded game exists (`record.money` is null; money games are disabled), so nothing consults this for real;
// the RoomSession and the room host carry the seam (`continuesDealtBuild`) and ESCROW-3B wires the stored identity.

import { RULES_ENGINE_VERSION, SUPPORTED_RULES_ENGINE_VERSIONS } from "../../../frontend/src/gameEngine/rulesVersion";
import { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } from "../../../frontend/src/gameEngine/settlementAppraisal";
import type { EscrowCodecId } from "../../../frontend/src/gameEngine/escrow/escrowCodec";
import { FINANCIAL_PROTOCOL_VERSION, HOSTED_PROTOCOL_VERSION } from "../../../frontend/src/gameEngine/protocolVersions";
import { isMoneyContinuationIdentity, MONEY_CONTINUATION_FORMAT, type MoneyContinuationIdentity } from "../../../frontend/src/gameEngine/compat/continuationIdentity";

/* LIVE-4 (L4-1): the version constants and the money continuation identity moved, unchanged, to the shared canonical
   modules -- `gameEngine/protocolVersions.ts` (the hosted and financial protocols, each with its changelog) and
   `gameEngine/compat/continuationIdentity.ts` (the identity and its reader) -- so the canonical compatibility model can
   read them on either side. They are re-exported here so every existing importer compiles unchanged. */
export { FINANCIAL_PROTOCOL_VERSION, HOSTED_PROTOCOL_VERSION, isMoneyContinuationIdentity, MONEY_CONTINUATION_FORMAT };
export type { MoneyContinuationIdentity };

/** The settlement codecs this deployment carries (certified only). */
export const DEPLOYMENT_SETTLEMENT_CODECS: readonly EscrowCodecId[] = Object.freeze(["18JUNO/v1"]);

/** What one deployment can continue. */
export interface DeploymentContinuation {
  readonly supportedRules: readonly number[];
  readonly certifiedRules: readonly number[];
  readonly hostedProtocol: number;
  readonly financialProtocol: number;
  readonly settlementCodecs: readonly string[];
}

export const THIS_DEPLOYMENT: DeploymentContinuation = Object.freeze({
  supportedRules: SUPPORTED_RULES_ENGINE_VERSIONS,
  certifiedRules: SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS,
  hostedProtocol: HOSTED_PROTOCOL_VERSION,
  financialProtocol: FINANCIAL_PROTOCOL_VERSION,
  settlementCodecs: DEPLOYMENT_SETTLEMENT_CODECS,
});

/** The identity a money game created on this deployment now would carry (ESCROW-3B freezes it at creation). */
export function currentMoneyContinuation(codec: EscrowCodecId = "18JUNO/v1"): MoneyContinuationIdentity {
  return {
    format: MONEY_CONTINUATION_FORMAT,
    rules_engine_version: RULES_ENGINE_VERSION,
    hosted_protocol: HOSTED_PROTOCOL_VERSION,
    financial_protocol: FINANCIAL_PROTOCOL_VERSION,
    settlement_codec: codec,
  };
}

export type ContinuationVerdict =
  | { readonly continues: true }
  | {
      readonly continues: false;
      readonly why: "malformed" | "rules-not-supported" | "rules-not-certified" | "hosted-protocol" | "financial-protocol" | "settlement-codec";
      readonly detail: string;
    };

/** Whether `deployment` may continue a funded game whose stored identity is `stored`. Pure; fail-closed. */
export function moneyContinuationVerdict(stored: unknown, deployment: DeploymentContinuation = THIS_DEPLOYMENT): ContinuationVerdict {
  if (!isMoneyContinuationIdentity(stored)) return { continues: false, why: "malformed", detail: "the stored continuation identity is not a v1 identity" };
  if (!deployment.supportedRules.includes(stored.rules_engine_version)) {
    return { continues: false, why: "rules-not-supported", detail: `the game plays rules engine ${stored.rules_engine_version}; this deployment plays ${deployment.supportedRules.join(", ")}` };
  }
  if (!deployment.certifiedRules.includes(stored.rules_engine_version)) {
    return { continues: false, why: "rules-not-certified", detail: `rules engine ${stored.rules_engine_version} is not settlement-certified on this deployment` };
  }
  if (stored.hosted_protocol !== deployment.hostedProtocol) {
    return { continues: false, why: "hosted-protocol", detail: `hosted protocol ${stored.hosted_protocol}; this deployment speaks ${deployment.hostedProtocol}` };
  }
  if (stored.financial_protocol !== deployment.financialProtocol) {
    return { continues: false, why: "financial-protocol", detail: `financial protocol ${stored.financial_protocol}; this deployment speaks ${deployment.financialProtocol}` };
  }
  if (!deployment.settlementCodecs.includes(stored.settlement_codec)) {
    return { continues: false, why: "settlement-codec", detail: `settlement codec ${stored.settlement_codec} is not carried by this deployment` };
  }
  return { continues: true };
}

/** The room host's and the session's seam: may this deployment continue `gameId`, dealt on build `dealtBuild`? Only a
 *  funded game with a compatible stored identity is ever continued across builds; every other game keeps #1252. */
export interface MoneyContinuationPolicy {
  continues(gameId: string, dealtBuild: string): boolean;
}

/** No funded games (today): nothing is continued across builds. */
export const NO_MONEY_CONTINUATION: MoneyContinuationPolicy = Object.freeze({ continues: () => false });

/** A policy over the stored identities (the financial store's index): continue exactly the compatible ones. */
export function continuationPolicyOf(identityOf: (gameId: string) => unknown | undefined, deployment: DeploymentContinuation = THIS_DEPLOYMENT): MoneyContinuationPolicy {
  return {
    continues(gameId: string): boolean {
      const stored = identityOf(gameId);
      return stored !== undefined && moneyContinuationVerdict(stored, deployment).continues;
    },
  };
}
