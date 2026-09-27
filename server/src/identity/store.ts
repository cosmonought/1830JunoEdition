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

/* ==================================================================
    LIVE-3C (brief §12): THE CONDITIONS A CHANGE IS WRITTEN UNDER
   ==================================================================
   The identity service serializes every change in one process, so today each of these always holds when it is
   written -- and a store checks them anyway, in the same step that writes the change (nothing written when one fails:
   `StoreDefiniteError`). They are the change's CONTRACT with any store: the local journal checks them against its
   index; LIVE-5's DynamoDB store turns each into the ConditionExpression of the item it names, in the one
   TransactWriteItems that carries the change -- so no second process could ever issue a session to a revoked
   principal, spend a link code twice, or rotate a recovery key someone else already rotated. */
export type IdentityPrecondition =
  /** CREATE-IF-ABSENT: the principal is not stored yet (its activation). */
  | { readonly kind: "principal-absent"; readonly principal_id: string }
  /** The principal is stored, active and unprofiled (a profile may bind it). */
  | { readonly kind: "principal-unprofiled"; readonly principal_id: string }
  /** CREATE-IF-ABSENT for a profile. */
  | { readonly kind: "profile-absent"; readonly profile_id: string }
  /** No stored profile holds this recovery selector. */
  | { readonly kind: "selector-unused"; readonly recovery_selector: string }
  /** COMPARE-AND-SWAP for a recovery-key rotation: the profile's selector is still this one. */
  | { readonly kind: "profile-selector"; readonly profile_id: string; readonly recovery_selector: string }
  /** CREATE-IF-ABSENT for a session. */
  | { readonly kind: "session-absent"; readonly session_id: string }
  /** The session is stored and not security-revoked (live, or rotated and so still in its grace): it may be rotated,
   *  revoked or replaced. A session a logout already ended cannot be resurrected by a rotation racing it. */
  | { readonly kind: "session-open"; readonly session_id: string }
  /** CREATE-IF-ABSENT for a link code's digest. */
  | { readonly kind: "link-absent"; readonly link_hash: string }
  /** SINGLE USE: the code is stored, unconsumed and unexpired at `at` -- consumed in the same write as the session
   *  it issues. */
  | { readonly kind: "link-unconsumed"; readonly link_hash: string; readonly at: number };

export interface IdentityChange {
  /** LIVE-3C: checked by the store in the same step that writes the change; any failure writes nothing. */
  readonly expect?: readonly IdentityPrecondition[];
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
    LIVE-3C: PRECONDITIONS, AND A CHANGE CHECKED WITHOUT REVALIDATING EVERYTHING
   --------------------------------------------------------------------------- */

/** What a precondition can ask a store: the stored record, by key. */
export interface IdentityLookups {
  principal(id: string): Principal | undefined;
  session(id: string): Session | undefined;
  profile(id: string): Profile | undefined;
  link(hash: string): LinkCredential | undefined;
  profileOfSelector(selector: string): string | undefined;
}

/** The lookups of a whole snapshot (built per call: the memory and whole-file stores, for tests and the migration). */
export function lookupsOf(snapshot: IdentitySnapshot): IdentityLookups {
  const principals = new Map(snapshot.principals.map((record) => [record.principal_id, record] as const));
  const sessions = new Map(snapshot.sessions.map((record) => [record.session_id, record] as const));
  const profiles = new Map((snapshot.profiles ?? []).map((record) => [record.profile_id, record] as const));
  const links = new Map((snapshot.links ?? []).map((record) => [record.link_hash, record] as const));
  const selectors = new Map((snapshot.profiles ?? []).map((record) => [record.recovery_selector, record.profile_id] as const));
  return {
    principal: (id) => principals.get(id),
    session: (id) => sessions.get(id),
    profile: (id) => profiles.get(id),
    link: (hash) => links.get(hash),
    profileOfSelector: (selector) => selectors.get(selector),
  };
}

/** The first precondition that does not hold, as an operator-facing sentence naming only its kind and position (never
 *  a credential or an id), or `null` when every one holds. */
export function preconditionFailure(lookups: IdentityLookups, expect: readonly IdentityPrecondition[] | undefined): string | null {
  for (const [at, condition] of (expect ?? []).entries()) {
    const failed = (() => {
      switch (condition.kind) {
        case "principal-absent":
          return lookups.principal(condition.principal_id) !== undefined;
        case "principal-unprofiled": {
          const principal = lookups.principal(condition.principal_id);
          return principal === undefined || principal.kind !== "unprofiled" || principal.status !== "active";
        }
        case "profile-absent":
          return lookups.profile(condition.profile_id) !== undefined;
        case "selector-unused":
          return lookups.profileOfSelector(condition.recovery_selector) !== undefined;
        case "profile-selector":
          return lookups.profile(condition.profile_id)?.recovery_selector !== condition.recovery_selector;
        case "session-absent":
          return lookups.session(condition.session_id) !== undefined;
        case "session-open": {
          const session = lookups.session(condition.session_id);
          return session === undefined || isSecurityRevocation(session.revoke_reason);
        }
        case "link-absent":
          return lookups.link(condition.link_hash) !== undefined;
        case "link-unconsumed": {
          const link = lookups.link(condition.link_hash);
          return link === undefined || link.consumed_at !== null || condition.at >= link.expires_at;
        }
        default:
          return true; // an unknown condition never holds
      }
    })();
    if (failed) return `precondition #${at} (${(condition as { kind: string }).kind}) does not hold`;
  }
  return null;
}

/** One change may name each record at most once (a store transaction cannot touch one item twice -- LIVE-5 -- and a
 *  change that did would mean a caller bug). */
export function changeIdProblem(change: IdentityChange): string | null {
  const once = (label: string, keys: readonly string[]): string | null => (new Set(keys).size === keys.length ? null : `a change names one ${label} twice`);
  const sessionKeys = [...(change.sessions ?? []).map((record) => record.session_id), ...(change.dropSessions ?? [])];
  const linkKeys = [...(change.links ?? []).map((record) => record.link_hash), ...(change.dropLinks ?? [])];
  return (
    once("principal", (change.principals ?? []).map((record) => record.principal_id)) ??
    once("session", sessionKeys) ??
    once("profile", (change.profiles ?? []).map((record) => record.profile_id)) ??
    once("link code", linkKeys)
  );
}

/* ==================================================================
    LIVE-3C (LIVE-2E review M3): THE INCREMENTAL INDEX
   ==================================================================
   `checkSnapshot` validates a whole identity set -- O(everything) -- and the whole-file store ran it on every change.
   The journal store keeps this index instead and checks each change against it in O(the change): every record the
   change writes has its exact shape, and every relation a changed record takes part in (both ways) is checked against
   the state AFTER the change. Principals and profiles are never removed, and a profile's principal and a profiled
   principal's profile never change, so a relation between two records the change does not touch cannot be broken by
   it. `identityJournal.test` drives random changes through both checks and requires the same verdict every time. */
export class IdentityIndex implements IdentityLookups {
  readonly principals = new Map<string, Principal>();
  readonly sessions = new Map<string, Session>();
  readonly profiles = new Map<string, Profile>();
  readonly links = new Map<string, LinkCredential>();
  readonly selectors = new Map<string, string>();

  static from(snapshot: FullIdentitySnapshot): IdentityIndex {
    const index = new IdentityIndex();
    for (const record of snapshot.principals) index.principals.set(record.principal_id, record);
    for (const record of snapshot.sessions) index.sessions.set(record.session_id, record);
    for (const record of snapshot.profiles) {
      index.profiles.set(record.profile_id, record);
      index.selectors.set(record.recovery_selector, record.profile_id);
    }
    for (const record of snapshot.links) index.links.set(record.link_hash, record);
    return index;
  }

  principal(id: string) {
    return this.principals.get(id);
  }
  session(id: string) {
    return this.sessions.get(id);
  }
  profile(id: string) {
    return this.profiles.get(id);
  }
  link(hash: string) {
    return this.links.get(hash);
  }
  profileOfSelector(selector: string) {
    return this.selectors.get(selector);
  }

  /** Why this change would make the set invalid, or `null`. Checks the change alone against this index -- the
   *  relations of every record it writes -- never the whole set. `where` names the caller in the sentence. */
  check(change: IdentityChange, where: string): string | null {
    const ids = changeIdProblem(change);
    if (ids !== null) return `${where}: ${ids}`;
    const nextPrincipals = new Map((change.principals ?? []).map((record) => [record.principal_id, record] as const));
    const nextProfiles = new Map((change.profiles ?? []).map((record) => [record.profile_id, record] as const));
    const principalAfter = (id: string) => nextPrincipals.get(id) ?? this.principals.get(id);
    const profileAfter = (id: string) => nextProfiles.get(id) ?? this.profiles.get(id);
    for (const [at, record] of (change.principals ?? []).entries()) {
      if (!isPrincipal(record)) return `${where}: principal #${at} is not a principal record`;
      if (record.activated_at === null) return `${where}: principal #${at} was never activated`;
      const before = this.principals.get(record.principal_id);
      if (before !== undefined && before.kind === "profile" && (record.kind !== "profile" || record.account_link !== before.account_link)) {
        return `${where}: principal #${at} would leave the profile it is bound to`;
      }
      if (record.kind === "profile" && profileAfter(record.account_link as string)?.principal_id !== record.principal_id) {
        return `${where}: a profile principal is not bound to its profile both ways`;
      }
    }
    const selectorsTaken = new Map<string, string>();
    for (const [at, record] of (change.profiles ?? []).entries()) {
      if (!isProfile(record)) return `${where}: profile #${at} is not a profile record`;
      const before = this.profiles.get(record.profile_id);
      if (before !== undefined && before.principal_id !== record.principal_id) return `${where}: profile #${at} would move to another principal`;
      const owner = principalAfter(record.principal_id);
      if (owner === undefined || owner.kind !== "profile" || owner.account_link !== record.profile_id) {
        return `${where}: profile #${at} is not bound to its principal both ways`;
      }
      const holder = this.selectors.get(record.recovery_selector);
      const heldElsewhere = holder !== undefined && holder !== record.profile_id && profileAfter(holder)?.recovery_selector === record.recovery_selector;
      const takenInChange = selectorsTaken.has(record.recovery_selector);
      if (heldElsewhere || takenInChange) return `${where}: profile #${at} repeats a recovery selector`;
      selectorsTaken.set(record.recovery_selector, record.profile_id);
    }
    for (const [at, record] of (change.sessions ?? []).entries()) {
      if (!isSession(record)) return `${where}: session #${at} is not a session record`;
      if (principalAfter(record.principal_id) === undefined) return `${where}: session #${at} names no stored principal`;
    }
    for (const [at, record] of (change.links ?? []).entries()) {
      if (!isLinkCredential(record)) return `${where}: link code #${at} is not a link record`;
      if (profileAfter(record.profile_id) === undefined) return `${where}: link code #${at} names no stored profile`;
    }
    return null;
  }

  /** Apply a change this index already checked. */
  apply(change: IdentityChange): void {
    for (const record of change.principals ?? []) this.principals.set(record.principal_id, { ...record });
    for (const record of change.sessions ?? []) this.sessions.set(record.session_id, { ...record });
    for (const id of change.dropSessions ?? []) this.sessions.delete(id);
    for (const record of change.profiles ?? []) {
      const before = this.profiles.get(record.profile_id);
      if (before !== undefined && this.selectors.get(before.recovery_selector) === record.profile_id) this.selectors.delete(before.recovery_selector);
      this.profiles.set(record.profile_id, { ...record });
      this.selectors.set(record.recovery_selector, record.profile_id);
    }
    for (const record of change.links ?? []) this.links.set(record.link_hash, { ...record });
    for (const hash of change.dropLinks ?? []) this.links.delete(hash);
  }

  /** The whole set, in the stored order (`applyChange`'s). */
  snapshot(): FullIdentitySnapshot {
    return applyChange({ principals: [...this.principals.values()], sessions: [...this.sessions.values()], profiles: [...this.profiles.values()], links: [...this.links.values()] }, {});
  }

  sizes(): { principals: number; sessions: number; profiles: number; links: number } {
    return { principals: this.principals.size, sessions: this.sessions.size, profiles: this.profiles.size, links: this.links.size };
  }
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
      /* LIVE-3C: the change's own contract -- one record once, every precondition -- before anything is applied. */
      const problem = changeIdProblem(change) ?? preconditionFailure(lookupsOf(durable), change.expect);
      if (problem !== null) {
        stats.failed += 1;
        throw new StoreDefiniteError(`memory identity store: ${problem}; nothing was written`);
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
