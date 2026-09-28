// frontend/src/gameEngine/compat/continuationIdentity.ts
//
// ==================================================================
//  LIVE-4 (L4-1): WHAT A GAME IS, FOR THE QUESTION "MAY THIS BUILD CONTINUE IT?"
// ==================================================================
//
// A game's continuation identity is the set of SEMANTIC versions a deployment must carry to replay it and carry it on.
// It is four axes, kept apart because each one moves for its own reasons and is checked against its own set:
//
//   rules_engine_version   the program the log is (`rulesVersion.ts`). From the deal: `SetupGame.rules_engine_version`.
//   hosted_protocol        what the server-owned history means outside the reducer (`protocolVersions.ts`). From the
//                          deal: `SetupGame.hosted_protocol`, stamped by the server (LIVE-4 L4-2); ABSENT MEANS 1,
//                          because every deal written before LIVE-4 was dealt under hosted protocol 1 (OD-L4-1).
//   financial_protocol     money games only: the money lifecycle and its durable artifacts. From the game's money
//                          continuation identity (below), frozen when the table was created.
//   settlement_codec       money games only: the escrow wire its payloads are built in (`18JUNO/v1`). From the same
//                          identity, and it must equal the codec of the deployment the game is bound to.
//
// THE GAMEPLAY CONTINUATION IDENTITY (GCI v1) is the first two, derived from the deal and never stored as an object of
// its own: the deal is immutable (the log is append-only and nothing may undo it), it travels with every export and
// every offline tool, and discovery already reads it from a log's first line. THE MONEY CONTINUATION IDENTITY (MCI v1,
// `18COSMOS/MONEY-CONTINUATION/v1`, ESCROW-3A) is all four, frozen in the financial record at creation; it moved here
// from `server/src/escrow/moneyContinuation.ts` unchanged (which re-exports it), so the canonical verdict can read it
// on either side. For a dealt money game the two must agree: the MCI's rules and hosted protocol are the deal's, and
// its codec is its deployment's. A disagreement is a contradiction, not a routing question (`continuationVerdict.ts`).
//
// WHAT IS DELIBERATELY NOT HERE: the build. `SetupGame.build` names the server that dealt the game and stays exactly
// that -- historical and diagnostic (which image to fetch for a forensic replay, which build a divergence report
// names). Two deals that differ only in `build` have the same identity. Neither is the escrow deployment: WHERE a money
// game's money is (its contract) is the immutable binding in its financial record, and whether a pool serves that
// contract is a question about the pool (`deploymentCapability.ts`), not about the game's semantics.

import type { ReplayEntry } from "../replayLog";
import { effectiveActions } from "../logRevert";
import { RULES_ENGINE_VERSION_FIELD } from "../rulesVersion";
import type { EscrowCodecId } from "../escrow/escrowCodec";

/* ------------------------------------------------------------------ */
/* GCI v1: the gameplay continuation identity                          */
/* ------------------------------------------------------------------ */

export const GAME_CONTINUATION_FORMAT = "18COSMOS/GAME-CONTINUATION/v1";

/** The deal's field for the hosted protocol, beside `rules_engine_version`. Server-stamped only (L4-2). */
export const HOSTED_PROTOCOL_FIELD = "hosted_protocol";

/** What a deal that carries no `hosted_protocol` was dealt under (OD-L4-1): every game before LIVE-4. */
export const ABSENT_HOSTED_PROTOCOL = 1;

export interface GameContinuationIdentity {
  readonly format: typeof GAME_CONTINUATION_FORMAT;
  readonly rules_engine_version: number;
  readonly hosted_protocol: number;
}

/** Every version on every axis is a positive safe integer; nothing else is a version a server could have stamped. */
export function isVersionNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function gameContinuationIdentity(rulesEngineVersion: number, hostedProtocol: number): GameContinuationIdentity {
  if (!isVersionNumber(rulesEngineVersion) || !isVersionNumber(hostedProtocol)) {
    throw new TypeError(`a continuation identity names positive integer versions (rules ${String(rulesEngineVersion)}, hosted ${String(hostedProtocol)})`);
  }
  return Object.freeze({ format: GAME_CONTINUATION_FORMAT, rules_engine_version: rulesEngineVersion, hosted_protocol: hostedProtocol });
}

/** What the deal says about a game's identity. Classified here, once, for every caller. */
export type GameIdentityFacts =
  /** No deal stands in the effective log: a waiting table. */
  | { readonly kind: "undealt" }
  /** A deal written before #1520: its rules pin is absent or not an integer (today's rule, `rulesEngineVersionOf`). */
  | { readonly kind: "legacy" }
  /** A deal no server could have written: a server-stamped field that is present but not a version. */
  | { readonly kind: "malformed"; readonly detail: string }
  | { readonly kind: "dealt"; readonly gci: GameContinuationIdentity };

const own = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/**
 * The identity of a deal, from its `SetupGame` body (`null` when no deal stands).
 *
 *  - no `hosted_protocol` field: hosted protocol 1 (OD-L4-1); a rules pin that is not an integer is `legacy`,
 *    exactly as `rulesEngineVersionOf` reads it today.
 *  - a `hosted_protocol` field that is not a positive integer: `malformed`. Only the server stamps it, so a bad value is
 *    damage, never a client's claim and never a default.
 *  - a `hosted_protocol` field beside a rules pin that is not an integer: `malformed`, never `legacy` -- the hosted field
 *    exists only on deals stamped after LIVE-4, which always carry their pin.
 *  - an integer rules pin that no server could have stamped (zero, negative, beyond a safe integer): `malformed`. (Today's
 *    `replayCompatibility` calls such a pin `incompatible`; both are derived and neither writes. L4-2, which routes the
 *    session through this classification, keeps whichever reason it adopts consistent across discovery and rebuild.)
 *
 * `build` is not read.
 */
export function gameIdentityOfDeal(setup: unknown): GameIdentityFacts {
  if (setup === null || setup === undefined) return { kind: "undealt" };
  if (typeof setup !== "object" || Array.isArray(setup)) return { kind: "malformed", detail: "the deal is not an object" };
  const body = setup as Record<string, unknown>;
  const rules = own(body, RULES_ENGINE_VERSION_FIELD) ? body[RULES_ENGINE_VERSION_FIELD] : undefined;
  const pinned = typeof rules === "number" && Number.isInteger(rules);
  const hostedPresent = own(body, HOSTED_PROTOCOL_FIELD) && body[HOSTED_PROTOCOL_FIELD] !== undefined;

  if (hostedPresent) {
    const hosted = body[HOSTED_PROTOCOL_FIELD];
    if (!isVersionNumber(hosted)) return { kind: "malformed", detail: `the deal's hosted_protocol is ${JSON.stringify(hosted)}, not a version` };
    if (!pinned) return { kind: "malformed", detail: "the deal carries a hosted_protocol but no integer rules pin" };
  } else if (!pinned) {
    return { kind: "legacy" };
  }
  if (!isVersionNumber(rules)) return { kind: "malformed", detail: `the deal's rules pin is ${String(rules)}, not a version` };
  const hosted = hostedPresent ? (body[HOSTED_PROTOCOL_FIELD] as number) : ABSENT_HOSTED_PROTOCOL;
  return { kind: "dealt", gci: gameContinuationIdentity(rules, hosted) };
}

/**
 * The identity of the deal that stands in `entries`' EFFECTIVE log (a reverted deal pins nothing; the next deal pins
 * afresh). The same deal `rulesEngineVersionOf` reads: the first effective entry whose payload is an object carrying
 * `SetupGame`; a payload that is not JSON is skipped, as it is there.
 */
export function gameIdentityOfEntries(entries: readonly ReplayEntry[]): GameIdentityFacts {
  for (const entry of effectiveActions(entries)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.payload);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && "SetupGame" in parsed) {
      const setup = (parsed as { SetupGame: unknown }).SetupGame;
      /* A deal whose body is JSON null is still a deal: malformed, never "no deal". */
      return setup === null ? { kind: "malformed", detail: "the deal is not an object" } : gameIdentityOfDeal(setup);
    }
  }
  return { kind: "undealt" };
}

/* ------------------------------------------------------------------ */
/* MCI v1: the money continuation identity (ESCROW-3A, unchanged)      */
/* ------------------------------------------------------------------ */

export const MONEY_CONTINUATION_FORMAT = "18COSMOS/MONEY-CONTINUATION/v1";

export interface MoneyContinuationIdentity {
  readonly format: typeof MONEY_CONTINUATION_FORMAT;
  readonly rules_engine_version: number;
  readonly hosted_protocol: number;
  readonly financial_protocol: number;
  readonly settlement_codec: EscrowCodecId;
}

const IDENTITY_KEYS = ["format", "rules_engine_version", "hosted_protocol", "financial_protocol", "settlement_codec"];

/** Exactly a v1 identity: the five keys and no other, positive integer versions, a known codec. */
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

/** The gameplay half of a money game's identity: what its deal is (or will be) stamped with. A money deal is dealt
 *  under its MCI's rules and hosted protocol -- the ones committed on chain at `CreateGame` -- never under whatever the
 *  dealing pool would give a new no-money table. */
export function gameplayIdentityOfMoney(identity: MoneyContinuationIdentity): GameContinuationIdentity {
  return gameContinuationIdentity(identity.rules_engine_version, identity.hosted_protocol);
}
