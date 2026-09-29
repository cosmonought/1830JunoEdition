// server/src/identity/grants.ts
//
// ==================================================================
//  LIVE-5 L5-4: SENSITIVE-AUTH GRANTS AS DURABLE STATE (preflight §7.4, OD-5-4)
// ==================================================================
//
// ESCROW-3A's "Confirm it's you" grant: a session that has just presented its profile's recovery key again may, for
// `sensitiveAuthMs`, rotate the key, sign out the other devices and (ESCROW-4) change a wallet binding. Until LIVE-5 it
// lived in the identity service's memory only. On AWS it is ALSO an item of the identity table (`GRANT#<session>`),
// written by the identity writer under its role fence, so that
//   - a restart of that writer does not drop it (it lives out its five minutes: OD-5-4, the design's recommended
//     default -- the one semantic change of this slice, and only on the DynamoDB path), and
//   - a task that is not the identity writer can answer it from strong reads (the preflight's IdentityVerifier, a
//     later slice).
//
// WHAT A GRANT IS -- UNCHANGED: it names the SESSION it was made for, that session's FAMILY and the recovery SELECTOR
// that was current, and when it lapses. It carries no secret. It is honoured only while, read at the moment of use,
//   the session is current (not rotated, revoked or expired; its principal active), the family is the grant's and open,
//   the profile's selector is still the grant's, and the time is before `expires_at`
// -- so a sign-out, a family revocation, a disabled principal or any key rotation makes a stored grant useless whether
// or not its item was ever deleted, and a grant item can never ADD a capability the service would not grant from its
// own state. Deleting one is hygiene; the table's TTL (`expires_at` + 1 h) collects the rest.

import { FAMILY_ID_PATTERN, RECOVERY_SELECTOR_PATTERN, SESSION_ID_PATTERN } from "./ids";
import { StoreDefiniteError, StoreUncertainError } from "../persistence/storeResult";

export interface SensitiveAuthGrant {
  readonly session_id: string;
  /** The session's family when the grant was made. */
  readonly family_id: string;
  /** The profile's recovery selector when the grant was made (a rotation since makes the grant useless). */
  readonly selector: string;
  /** Epoch ms; the grant is dead from this moment on. */
  readonly expires_at: number;
}

export const GRANT_KEYS: readonly string[] = Object.freeze(["session_id", "family_id", "selector", "expires_at"]);

export function isSensitiveAuthGrant(value: unknown): value is SensitiveAuthGrant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const own = Object.keys(record);
  if (own.length !== GRANT_KEYS.length || !GRANT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(record, key))) return false;
  return (
    typeof record.session_id === "string" &&
    SESSION_ID_PATTERN.test(record.session_id) &&
    typeof record.family_id === "string" &&
    FAMILY_ID_PATTERN.test(record.family_id) &&
    typeof record.selector === "string" &&
    RECOVERY_SELECTOR_PATTERN.test(record.selector) &&
    typeof record.expires_at === "number" &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at > 0
  );
}

/** A grant in its canonical key order (what every store hands back). */
export const canonicalGrant = (grant: SensitiveAuthGrant): SensitiveAuthGrant => ({
  session_id: grant.session_id,
  family_id: grant.family_id,
  selector: grant.selector,
  expires_at: grant.expires_at,
});

/**
 * THE PORT. The same contract as `IdentityStore.commit` for its writes: a write resolves only once durable, rejects
 * `StoreDefiniteError` when nothing was written, and anything else when the outcome is unknown. Reads are strong.
 */
export interface SensitiveAuthGrantStore {
  /** Store (or renew) this session's grant: the newest re-authentication replaces the older one whole. */
  put(grant: SensitiveAuthGrant): Promise<void>;
  /** The session's stored grant, `null` when none (lapsed ones included: the caller judges `expires_at`). Throws on an
   *  item it cannot read without guessing. */
  get(sessionId: string): Promise<SensitiveAuthGrant | null>;
  /** Every stored grant that has not lapsed at `now`, by session id. The identity writer reloads these at open. */
  live(now: number): Promise<SensitiveAuthGrant[]>;
  /** Hygiene: forget these sessions' grants (a missing one is not an error). */
  remove(sessionIds: readonly string[]): Promise<void>;
}

/* ---------------------------------------------------------------------------
    THE IN-MEMORY STORE: the reference model for the conformance cases and the service tests.
   --------------------------------------------------------------------------- */

export interface MemoryGrantStore extends SensitiveAuthGrantStore {
  readonly grants: Map<string, SensitiveAuthGrant>;
  /** Failures to inject into the next writes, in order: "definite" (nothing written) or "uncertain" (it was). */
  readonly failNext: Array<"definite" | "uncertain">;
  snapshot(): SensitiveAuthGrant[];
}

export function createMemoryGrantStore(): MemoryGrantStore {
  const grants = new Map<string, SensitiveAuthGrant>();
  const failNext: Array<"definite" | "uncertain"> = [];
  const sorted = () => [...grants.values()].sort((a, b) => (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0)).map(canonicalGrant);
  return {
    grants,
    failNext,
    snapshot: sorted,
    async put(grant) {
      if (!isSensitiveAuthGrant(grant)) throw new StoreDefiniteError("memory grant store: not a sensitive-auth grant; nothing was written");
      const fault = failNext.shift();
      if (fault === "definite") throw new StoreDefiniteError("injected grant-store failure (nothing written)");
      grants.set(grant.session_id, canonicalGrant(grant));
      if (fault === "uncertain") throw new StoreUncertainError("injected grant-store failure (outcome unknown)");
    },
    async get(sessionId) {
      const grant = grants.get(sessionId);
      return grant === undefined ? null : canonicalGrant(grant);
    },
    async live(now) {
      return sorted().filter((grant) => now < grant.expires_at);
    },
    async remove(sessionIds) {
      if (!Array.isArray(sessionIds) || !sessionIds.every((id) => typeof id === "string" && SESSION_ID_PATTERN.test(id))) {
        throw new StoreDefiniteError("memory grant store: a removal names something that is not a session id; nothing was written");
      }
      const fault = failNext.shift();
      if (fault === "definite") throw new StoreDefiniteError("injected grant-store failure (nothing written)");
      for (const id of sessionIds) grants.delete(id);
      if (fault === "uncertain") throw new StoreUncertainError("injected grant-store failure (outcome unknown)");
    },
  };
}
