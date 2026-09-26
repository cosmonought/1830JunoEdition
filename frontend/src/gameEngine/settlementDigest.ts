// frontend/src/gameEngine/settlementDigest.ts
//
// ==================================================================
//  SET-0B: THE BOARD COMMITMENT, AND APPRAISING EXACTLY WHAT WAS COMMITTED
// ==================================================================
//
// THE HASH (ESCROW-1.5 §6.5, frozen):
//
//   terminal_state_hash_v1 = SHA-256( UTF8("18JUNO/STATE/v1\n") || canonicalJson(state) ), lowercase hex
//
// The payload field that carries it is `appraisal_state_hash` (ESCROW-2 amendment A1): the hash of the board at
// `appraisal_log_len`, which for BankBroken / Bankruptcy / ResolverCorrection and every checkpoint is the board at
// `log_len`. The construction is the same either way, so the helper keeps its SET-0A name.
//
// ONE CANONICAL FORM, NOT A SECOND ONE. `canonicalJson` is `stateDigest.ts`'s tested helper (sorted keys, arrays in
// order, `undefined` dropped, `null` kept, `-0` as `0`), and SHA-256 is `sha256.ts`'s FIPS-vectored implementation.
// Neither is reimplemented here. The FNV `stateDigest` stays the divergence alarm and is never signed.
//
// WHAT THE SHARED HELPER WILL NOT REFUSE, THIS DOES. `canonicalJson` writes `"__nonfinite:…"` / `"__unserialisable:…"`
// sentinels for a value with no JSON form, silently writes `null` for a `bigint` or a top-level `undefined`, skips
// array holes (emitting `[1,,3]`, which is not JSON), and reads every value through whatever getter or Proxy trap
// the object carries: fine for a divergence report, fatal for a signed commitment. So a board is first copied by
// `settlementSnapshot` (`settlementAppraisal.ts`) -- every value read exactly once into plain objects, anything that
// is not plain JSON data REFUSED (`STATE_NOT_HASHABLE`) -- and only that copy is canonicalised. The appraiser
// appraises the same kind of snapshot, so the two accept the same boards and read the same fields.
//
// PAYLOADS COME FROM ONE CALL. `terminalStateHashV1(state)` and `baseNetWorthVector(state, seats)` stay exported (the
// SET-0A API), but two separate calls each read the caller's object, and anything that changes it in between -- a
// plain mutation, a stateful Proxy -- makes them describe two boards. A settlement payload is therefore built ONLY
// from `commitAndAppraise(state, seats)` (or `appraiseCommittedState(canonicalStateText(state), seats)`): the text is
// taken once and the hash and the vector are both derived from those bytes.
//
// APPRAISE THE HASHED BYTES (§17). `appraiseCommittedState(text, seats)` requires `text` to be canonical (it must
// re-canonicalise to itself), hashes exactly those bytes, parses them into a fresh object nobody else holds, freezes
// it, and appraises THAT. There is no second live object that could differ from what was hashed -- no getter, no
// `undefined`-versus-absent difference, no mutation between hashing and appraising.

import type { GameStateResponse } from "./gameState";
import { canonicalJson } from "./stateDigest";
import { sha256Hex } from "./sha256";
import {
  SettlementAppraisalError,
  appraiseSeats,
  settlementSnapshot,
  type SeatAppraisal,
  type SettlementSeat,
} from "./settlementAppraisal";

/** The domain-separation prefix of `terminal_state_hash_v1` (ESCROW-1.5 §6.2), newline included. */
export const STATE_HASH_TAG_V1 = "18JUNO/STATE/v1\n";

/** The canonical text of a board: `canonicalJson` of its one-read plain snapshot. The board must be a plain object;
 *  anything that is not plain JSON data is refused (`STATE_NOT_HASHABLE`). This is the ONE producer of committed text:
 *  ESCROW-3 takes it once, then hashes and appraises those bytes with `appraiseCommittedState`. */
export function canonicalStateText(state: GameStateResponse): string {
  return canonicalJson(settlementSnapshot(state));
}

/** `terminal_state_hash_v1` of canonical text that is already in hand: SHA-256 over the tag and exactly these bytes.
 *  Refuses text that is not the canonical form of the value it parses to. */
export function terminalStateHashV1OfText(canonicalText: string): string {
  parseCanonicalText(canonicalText);
  return sha256Hex(STATE_HASH_TAG_V1 + canonicalText);
}

/** `terminal_state_hash_v1` of a board (the value of the payload's `appraisal_state_hash`). */
export function terminalStateHashV1(state: GameStateResponse): string {
  return sha256Hex(STATE_HASH_TAG_V1 + canonicalStateText(state));
}

/** Parses canonical text into a fresh, deep-frozen board, refusing text that is not canonical. */
function parseCanonicalText(canonicalText: string): GameStateResponse {
  if (typeof canonicalText !== "string") {
    throw new SettlementAppraisalError("NON_CANONICAL_STATE_TEXT", `expected a string, got ${typeof canonicalText}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalText);
  } catch {
    throw new SettlementAppraisalError("NON_CANONICAL_STATE_TEXT", "the text is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SettlementAppraisalError("NON_CANONICAL_STATE_TEXT", "the text is not a JSON object");
  }
  /* THE ROUND TRIP IS THE PROOF. If the text re-canonicalises to itself byte for byte, the object appraised below is
     exactly what the bytes say -- whitespace, key order, number spelling ("1.0", "1e2"), a duplicate key (JSON.parse
     keeps the last) and an overflowing literal ("1e400" -> Infinity) all fail here. */
  if (canonicalJson(parsed) !== canonicalText) {
    throw new SettlementAppraisalError("NON_CANONICAL_STATE_TEXT", "the text is not the canonical form of its value");
  }
  // The same gate as a live board: refuses what JSON can still carry but a board must not (a `__proto__` key).
  settlementSnapshot(parsed);
  return deepFreeze(parsed) as GameStateResponse;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** What `appraiseCommittedState` returns: the commitment and the vector of the same bytes. */
export interface CommittedAppraisal {
  /** `terminal_state_hash_v1` of the text: the payload's `appraisal_state_hash`. Lowercase hex. */
  appraisal_state_hash: string;
  /** The base settlement vector, in chain seat order. */
  vector: readonly bigint[];
  /** The per-seat components behind the vector. */
  appraisals: readonly SeatAppraisal[];
  /** The board parsed from the committed bytes, deep-frozen. */
  state: GameStateResponse;
}

/**
 * Hashes EXACTLY `canonicalText` and appraises the board parsed from those same bytes (SET-0A §17). The caller
 * produces the text once -- `canonicalStateText(S_L)` -- and never appraises a live object separately.
 */
export function appraiseCommittedState(canonicalText: string, seats: readonly SettlementSeat[]): CommittedAppraisal {
  const state = parseCanonicalText(canonicalText);
  const appraisal_state_hash = sha256Hex(STATE_HASH_TAG_V1 + canonicalText);
  const appraisals = appraiseSeats(state, seats);
  return Object.freeze({
    appraisal_state_hash,
    vector: Object.freeze(appraisals.map((seat) => seat.total)),
    appraisals,
    state,
  });
}

/** `canonicalStateText` + `appraiseCommittedState` in one call, returning the committed text too: the text is
 *  produced once and everything else is derived from those bytes. What ESCROW-3 calls on a sealed board. */
export function commitAndAppraise(
  state: GameStateResponse,
  seats: readonly SettlementSeat[],
): CommittedAppraisal & { canonical_text: string } {
  const canonical_text = canonicalStateText(state);
  return Object.freeze({ ...appraiseCommittedState(canonical_text, seats), canonical_text });
}
