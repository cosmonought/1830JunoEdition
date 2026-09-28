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

export const MONEY_CONTINUATION_FORMAT = "18COSMOS/MONEY-CONTINUATION/v1";
/** The server-owned history protocol (LIVE-2/3: log format, commit protocol, GameRecord schema 1, SetupGame, seal). */
export const HOSTED_PROTOCOL_VERSION = 1;
/** The money lifecycle protocol: the meaning and format of EVERY durable financial artifact of a game (the financial
 *  record, its chain intents and attempts, the wallet-ticket ledger) and every decision rule of its money lifecycle
 *  (LIVE-4 preflight §4.3). No money game was ever created under 1 or 2 (money games were disabled until ESCROW-4), so
 *  no bump strands anything and none carries migration machinery: an artifact of an older protocol is refused (the
 *  continuation verdict, the stores' exact-shape readers), never reinterpreted.
 *    1  ESCROW-3A.
 *    2  ESCROW-3B: record v2 (the money binding, the frozen roster, the post-intent chain phases) and chain intents
 *       persisted before broadcast; as of 6f05c80 it also carried ESCROW-JOIN's grant `admitted_until_secs` and its
 *       no-supersede-while-admitted rule (shipped under 2; retired by 3).
 *    3  ESCROW-4: the ticket file's v3 grants (the persisted ADR-036 wallet-control proof, registered consent keys, the
 *       relink origin and the CreateGame discovery floor) and their rules (proof-gated admission, R-J1, the exact link
 *       refusals, relink of a seat's own deposit); the relayed CONSENT / ANNUL chain intents and their key-suffixed
 *       instances; W-13's quorum-checked host binding; the close of a table that ended unbound; and the money
 *       GameRecord (`record_schema: 2`, written for money tables only -- no-money records stay exactly schema 1, so the
 *       hosted protocol does not move). */
export const FINANCIAL_PROTOCOL_VERSION = 3;
/** The settlement codecs this deployment carries (certified only). */
export const DEPLOYMENT_SETTLEMENT_CODECS: readonly EscrowCodecId[] = Object.freeze(["18JUNO/v1"]);

export interface MoneyContinuationIdentity {
  readonly format: typeof MONEY_CONTINUATION_FORMAT;
  readonly rules_engine_version: number;
  readonly hosted_protocol: number;
  readonly financial_protocol: number;
  readonly settlement_codec: EscrowCodecId;
}

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

const IDENTITY_KEYS = ["format", "rules_engine_version", "hosted_protocol", "financial_protocol", "settlement_codec"];

export function isMoneyContinuationIdentity(value: unknown): value is MoneyContinuationIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const int = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
  return (
    keys.length === IDENTITY_KEYS.length &&
    IDENTITY_KEYS.every((key) => keys.includes(key)) &&
    record.format === MONEY_CONTINUATION_FORMAT &&
    int(record.rules_engine_version) &&
    int(record.hosted_protocol) &&
    int(record.financial_protocol) &&
    (record.settlement_codec === "18JUNO/v1" || record.settlement_codec === "18GNO/v1")
  );
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
