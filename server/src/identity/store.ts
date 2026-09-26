// server/src/identity/store.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §3.3, §3.4, §14.1): THE RECORDS, AND THE STORE THAT KEEPS THEM
// ==================================================================
//
// Two frozen records and nothing else. A principal carries no IP address, no user-agent, no fingerprint and no
// nickname; a session carries the SHA-256 of its secret and never the secret (LIVE-2 §4.9). The field names are
// the design's, snake_case, because they are the stored shape LIVE-3 will migrate.
//
// WHAT IS DURABLE: an ACTIVATED principal and every session of it. A provisional guest -- one that has bootstrapped
// but never created or joined a room -- lives only in the identity service's bounded memory and is never written
// (§3.3): a bootstrap flood costs a cache, not store writes, and a restart forgets guests who own nothing.
//
// THE CONTRACT A STORE KEEPS (LIVE-3's classification, `persistence/storeResult.ts`): `commit` resolves only once
// the change is durable; it rejects `StoreDefiniteError` when nothing changed, and anything else when the outcome is
// unknown -- which the identity service treats as a restart-required fault, never as success and never silently.

import { StoreDefiniteError, StoreUncertainError } from "../persistence/storeResult";
import { PRINCIPAL_ID_PATTERN, PROFILE_ID_PATTERN, RECOVERY_SELECTOR_PATTERN, SESSION_ID_PATTERN } from "./ids";

/* ==================================================================
    LIVE-2E: A PRINCIPAL IS UNPROFILED OR IT BELONGS TO EXACTLY ONE PROFILE
   ==================================================================
   The layers: a PROFILE (application identity, mandatory to play) controls exactly one durable PRINCIPAL, which any
   number of SESSIONS (devices) authenticate, and which owns GameRecord seats (`player_id`, game-local and public).
   A recovered or newly linked device gets a fresh session for the SAME principal -- so it already holds every seat
   that principal holds, and nothing about a seat is ever copied or reassigned. An `unprofiled` principal is the
   temporary one a browser gets from the bootstrap so it can reach the profile gate; it can do nothing else.
   `account_link` (LIVE-2B's reserved seam) is the profile id of a `profile` principal, `null` otherwise. */
export type PrincipalKind = "unprofiled" | "profile";

export interface Principal {
  principal_id: string;
  kind: PrincipalKind;
  status: "active" | "disabled";
  created_at: number;
  /** First durable action (created or joined a room); `null` => provisional, memory only. */
  activated_at: number | null;
  /** Coarse: written behind, at most once per 15 minutes. */
  last_seen_at: number;
  /** LIVE-2E: the owning profile's id when `kind` is "profile"; `null` when "unprofiled". */
  account_link: string | null;
}

/** LIVE-2E: the application identity. PRIVATE: its id and its principal never leave the server. */
export interface Profile {
  profile_id: string;
  /** Immutable: the one principal this profile controls. */
  principal_id: string;
  /** Human-facing, 1-24 characters, never an authority key (duplicates are allowed). */
  display_name: string;
  created_at: number;
  status: "active" | "disabled";
  /** The recovery key's selector (`rk_…`), a lookup key. */
  recovery_selector: string;
  /** Hex SHA-256 of the recovery key's 32-byte secret. Never the secret. */
  recovery_hash: string;
  recovery_rotated_at: number;
  /** The record's own schema, for LIVE-3's migration. */
  schema: 1;
}

/** LIVE-2E: one "Link another device" code -- short-lived, single use, stored only as a digest. */
export interface LinkCredential {
  /** Hex SHA-256 of the code's canonical spelling: the lookup key and the only trace of the code. */
  link_hash: string;
  profile_id: string;
  created_at: number;
  expires_at: number;
  /** Set, durably and together with the session it issues, the one time the code is redeemed. */
  consumed_at: number | null;
}

/** LIVE-2E adds `replaced` (a bootstrap session replaced by a profile's at recovery or link -- session fixation) and
 *  `signed-out-remotely` (ended by "Sign out other devices"). Both are security revocations. */
export type RevokeReason = "logout" | "rotated" | "evicted" | "operator" | "principal-disabled" | "replaced" | "signed-out-remotely";
export const REVOKE_REASONS: readonly RevokeReason[] = Object.freeze([
  "logout",
  "rotated",
  "evicted",
  "operator",
  "principal-disabled",
  "replaced",
  "signed-out-remotely",
]);
/** Every revocation except rotation is a SECURITY revocation: it closes the session's sockets 4401 (§4.4). */
export const isSecurityRevocation = (reason: RevokeReason | null): boolean => reason !== null && reason !== "rotated";

export interface Session {
  session_id: string;
  principal_id: string;
  /** Hex SHA-256 of the secret's 32 bytes. */
  secret_hash: string;
  created_at: number;
  last_seen_at: number;
  /** min(last_seen_at + 30 d, created_at + 180 d). */
  expires_at: number;
  revoked_at: number | null;
  revoke_reason: RevokeReason | null;
  /** The successor, when `revoke_reason` is "rotated". */
  rotated_to: string | null;
}

export interface IdentitySnapshot {
  principals: Principal[];
  sessions: Session[];
  /** LIVE-2E. Absent in a snapshot built before profiles (read as empty). */
  profiles?: Profile[];
  /** LIVE-2E. Absent in a snapshot built before profiles (read as empty). */
  links?: LinkCredential[];
}

/** A snapshot with every collection present -- what `checkSnapshot` returns. */
export interface FullIdentitySnapshot {
  principals: Principal[];
  sessions: Session[];
  profiles: Profile[];
  links: LinkCredential[];
}

export interface IdentityChange {
  /** Upserted whole. */
  readonly principals?: readonly Principal[];
  /** Upserted whole. */
  readonly sessions?: readonly Session[];
  /** Removed (expired and retired sessions past their audit window). */
  readonly dropSessions?: readonly string[];
  /** LIVE-2E: upserted whole. A profile is never removed. */
  readonly profiles?: readonly Profile[];
  /** LIVE-2E: upserted whole (a new code, or one consumed). */
  readonly links?: readonly LinkCredential[];
  /** LIVE-2E: removed (expired codes, consumed or not). */
  readonly dropLinks?: readonly string[];
}

export interface IdentityStore {
  /** Everything durable. Throws on a file it cannot read without guessing (the server then refuses to start). */
  load(): Promise<FullIdentitySnapshot>;
  /** Durable before it resolves; `StoreDefiniteError` when nothing changed; anything else is an unknown outcome. */
  commit(change: IdentityChange): Promise<void>;
}

/* ---------------------------------------------------------------------------
    STRICT SHAPES: a stored record is exactly the frozen fields, or the store is unreadable
   --------------------------------------------------------------------------- */

const PRINCIPAL_KEYS = ["principal_id", "kind", "status", "created_at", "activated_at", "last_seen_at", "account_link"];
const PROFILE_KEYS = [
  "profile_id",
  "principal_id",
  "display_name",
  "created_at",
  "status",
  "recovery_selector",
  "recovery_hash",
  "recovery_rotated_at",
  "schema",
];
const LINK_KEYS = ["link_hash", "profile_id", "created_at", "expires_at", "consumed_at"];
export const PROFILE_NAME_MAX = 24;
const SESSION_KEYS = [
  "session_id",
  "principal_id",
  "secret_hash",
  "created_at",
  "last_seen_at",
  "expires_at",
  "revoked_at",
  "revoke_reason",
  "rotated_to",
];

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const exactKeys = (value: object, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
};
const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isPrincipal(value: unknown): value is Principal {
  if (!isRecordObject(value) || !exactKeys(value, PRINCIPAL_KEYS)) return false;
  const linked =
    (value.kind === "unprofiled" && value.account_link === null) ||
    (value.kind === "profile" && typeof value.account_link === "string" && PROFILE_ID_PATTERN.test(value.account_link));
  return (
    typeof value.principal_id === "string" &&
    PRINCIPAL_ID_PATTERN.test(value.principal_id) &&
    linked &&
    (value.status === "active" || value.status === "disabled") &&
    isTime(value.created_at) &&
    (value.activated_at === null || isTime(value.activated_at)) &&
    isTime(value.last_seen_at)
  );
}

/** A display name as stored: 1-24 characters, no control or line characters, no outer whitespace. */
export function isDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= PROFILE_NAME_MAX &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
  );
}

const HEX_64 = /^[0-9a-f]{64}$/;

export function isProfile(value: unknown): value is Profile {
  if (!isRecordObject(value) || !exactKeys(value, PROFILE_KEYS)) return false;
  return (
    typeof value.profile_id === "string" &&
    PROFILE_ID_PATTERN.test(value.profile_id) &&
    typeof value.principal_id === "string" &&
    PRINCIPAL_ID_PATTERN.test(value.principal_id) &&
    isDisplayName(value.display_name) &&
    isTime(value.created_at) &&
    (value.status === "active" || value.status === "disabled") &&
    typeof value.recovery_selector === "string" &&
    RECOVERY_SELECTOR_PATTERN.test(value.recovery_selector) &&
    typeof value.recovery_hash === "string" &&
    HEX_64.test(value.recovery_hash) &&
    isTime(value.recovery_rotated_at) &&
    value.schema === 1
  );
}

export function isLinkCredential(value: unknown): value is LinkCredential {
  if (!isRecordObject(value) || !exactKeys(value, LINK_KEYS)) return false;
  return (
    typeof value.link_hash === "string" &&
    HEX_64.test(value.link_hash) &&
    typeof value.profile_id === "string" &&
    PROFILE_ID_PATTERN.test(value.profile_id) &&
    isTime(value.created_at) &&
    isTime(value.expires_at) &&
    value.expires_at > value.created_at &&
    (value.consumed_at === null || isTime(value.consumed_at))
  );
}

export function isSession(value: unknown): value is Session {
  if (!isRecordObject(value) || !exactKeys(value, SESSION_KEYS)) return false;
  return (
    typeof value.session_id === "string" &&
    SESSION_ID_PATTERN.test(value.session_id) &&
    typeof value.principal_id === "string" &&
    PRINCIPAL_ID_PATTERN.test(value.principal_id) &&
    typeof value.secret_hash === "string" &&
    /^[0-9a-f]{64}$/.test(value.secret_hash) &&
    isTime(value.created_at) &&
    isTime(value.last_seen_at) &&
    isTime(value.expires_at) &&
    (value.revoked_at === null || isTime(value.revoked_at)) &&
    (value.revoke_reason === null || (REVOKE_REASONS as readonly unknown[]).includes(value.revoke_reason)) &&
    (value.revoked_at === null) === (value.revoke_reason === null) &&
    (value.rotated_to === null || (typeof value.rotated_to === "string" && SESSION_ID_PATTERN.test(value.rotated_to)))
  );
}

/** A stored identity set that cannot be read without guessing. Named by position only: never a record's content. */
export class IdentityStoreCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityStoreCorruptError";
  }
}

/** Check a whole snapshot: shapes, unique ids, every session's principal present and activated, and (LIVE-2E) the
 *  profile binding exact both ways -- a `profile` principal names a profile that names it back, one profile per
 *  principal, one principal per profile, recovery selectors unique, every link code's profile present. No partial
 *  profile/principal binding can be loaded, so none can be used. */
export function checkSnapshot(snapshot: unknown, where: string): FullIdentitySnapshot {
  if (!isRecordObject(snapshot) || !Array.isArray(snapshot.principals) || !Array.isArray(snapshot.sessions)) {
    throw new IdentityStoreCorruptError(`${where}: not an identity snapshot`);
  }
  const rawProfiles = snapshot.profiles === undefined ? [] : snapshot.profiles;
  const rawLinks = snapshot.links === undefined ? [] : snapshot.links;
  if (!Array.isArray(rawProfiles) || !Array.isArray(rawLinks)) throw new IdentityStoreCorruptError(`${where}: not an identity snapshot`);
  const principals = new Map<string, Principal>();
  snapshot.principals.forEach((record, at) => {
    if (!isPrincipal(record)) throw new IdentityStoreCorruptError(`${where}: principal #${at} is not a principal record`);
    if (record.activated_at === null) throw new IdentityStoreCorruptError(`${where}: principal #${at} was never activated`);
    if (principals.has(record.principal_id)) throw new IdentityStoreCorruptError(`${where}: principal #${at} is a duplicate`);
    principals.set(record.principal_id, record);
  });
  const sessions = new Set<string>();
  snapshot.sessions.forEach((record, at) => {
    if (!isSession(record)) throw new IdentityStoreCorruptError(`${where}: session #${at} is not a session record`);
    if (sessions.has(record.session_id)) throw new IdentityStoreCorruptError(`${where}: session #${at} is a duplicate`);
    if (!principals.has(record.principal_id)) throw new IdentityStoreCorruptError(`${where}: session #${at} names no stored principal`);
    sessions.add(record.session_id);
  });
  const profiles = new Map<string, Profile>();
  const profileOfPrincipal = new Set<string>();
  const selectors = new Set<string>();
  rawProfiles.forEach((record, at) => {
    if (!isProfile(record)) throw new IdentityStoreCorruptError(`${where}: profile #${at} is not a profile record`);
    if (profiles.has(record.profile_id)) throw new IdentityStoreCorruptError(`${where}: profile #${at} is a duplicate`);
    const owner = principals.get(record.principal_id);
    if (owner === undefined || owner.kind !== "profile" || owner.account_link !== record.profile_id) {
      throw new IdentityStoreCorruptError(`${where}: profile #${at} is not bound to its principal both ways`);
    }
    if (profileOfPrincipal.has(record.principal_id)) throw new IdentityStoreCorruptError(`${where}: profile #${at} shares a principal`);
    if (selectors.has(record.recovery_selector)) throw new IdentityStoreCorruptError(`${where}: profile #${at} repeats a recovery selector`);
    profiles.set(record.profile_id, record);
    profileOfPrincipal.add(record.principal_id);
    selectors.add(record.recovery_selector);
  });
  principals.forEach((record) => {
    /* Both ways (LIVE-2E review L2): the profile a principal names must name THAT principal back. */
    if (record.kind === "profile" && profiles.get(record.account_link as string)?.principal_id !== record.principal_id) {
      throw new IdentityStoreCorruptError(`${where}: a profile principal is not bound to its profile both ways`);
    }
  });
  const links = new Set<string>();
  rawLinks.forEach((record, at) => {
    if (!isLinkCredential(record)) throw new IdentityStoreCorruptError(`${where}: link code #${at} is not a link record`);
    if (links.has(record.link_hash)) throw new IdentityStoreCorruptError(`${where}: link code #${at} is a duplicate`);
    if (!profiles.has(record.profile_id)) throw new IdentityStoreCorruptError(`${where}: link code #${at} names no stored profile`);
    links.add(record.link_hash);
  });
  return {
    principals: [...principals.values()],
    sessions: snapshot.sessions as Session[],
    profiles: [...profiles.values()],
    links: rawLinks as LinkCredential[],
  };
}

/** Apply a change to a snapshot, returning a new one (the input is never mutated). */
export function applyChange(base: IdentitySnapshot, change: IdentityChange): FullIdentitySnapshot {
  const principals = new Map(base.principals.map((record) => [record.principal_id, record] as const));
  const sessions = new Map(base.sessions.map((record) => [record.session_id, record] as const));
  const profiles = new Map((base.profiles ?? []).map((record) => [record.profile_id, record] as const));
  const links = new Map((base.links ?? []).map((record) => [record.link_hash, record] as const));
  for (const record of change.principals ?? []) principals.set(record.principal_id, { ...record });
  for (const record of change.sessions ?? []) sessions.set(record.session_id, { ...record });
  for (const id of change.dropSessions ?? []) sessions.delete(id);
  for (const record of change.profiles ?? []) profiles.set(record.profile_id, { ...record });
  for (const record of change.links ?? []) links.set(record.link_hash, { ...record });
  for (const hash of change.dropLinks ?? []) links.delete(hash);
  const byId = <T>(key: (value: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return {
    principals: [...principals.values()].sort(byId((p: Principal) => p.principal_id)),
    sessions: [...sessions.values()].sort(byId((s: Session) => s.session_id)),
    profiles: [...profiles.values()].sort(byId((p: Profile) => p.profile_id)),
    links: [...links.values()].sort(byId((l: LinkCredential) => l.link_hash)),
  };
}

/* ---------------------------------------------------------------------------
    THE IN-MEMORY STORE: for tests and the smoke run. Every commit can be failed on demand.
   --------------------------------------------------------------------------- */

export interface MemoryIdentityStore extends IdentityStore {
  /** The durable content, as a restart would load it. */
  snapshot(): FullIdentitySnapshot;
  /** Failures to inject into the next commits, in order: "definite" (nothing changed) or "uncertain" (it did). */
  readonly failNext: Array<"definite" | "uncertain">;
  readonly stats: { commits: number; failed: number };
}

export function createMemoryIdentityStore(initial: IdentitySnapshot = { principals: [], sessions: [] }): MemoryIdentityStore {
  let durable = checkSnapshot(JSON.parse(JSON.stringify(initial)), "memory identity store");
  const failNext: Array<"definite" | "uncertain"> = [];
  const stats = { commits: 0, failed: 0 };
  return {
    failNext,
    stats,
    snapshot: () => JSON.parse(JSON.stringify(durable)) as FullIdentitySnapshot,
    async load() {
      return JSON.parse(JSON.stringify(durable)) as FullIdentitySnapshot;
    },
    async commit(change) {
      const fault = failNext.shift();
      if (fault === "definite") {
        stats.failed += 1;
        throw new StoreDefiniteError("injected identity-store failure (nothing written)");
      }
      const next = checkSnapshot(applyChange(durable, change), "memory identity store commit");
      durable = next;
      if (fault === "uncertain") {
        stats.failed += 1;
        throw new StoreUncertainError("injected identity-store failure (outcome unknown)");
      }
      stats.commits += 1;
    },
  };
}
