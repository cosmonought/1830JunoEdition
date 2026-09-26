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
import { PRINCIPAL_ID_PATTERN, SESSION_ID_PATTERN } from "./ids";

export interface Principal {
  principal_id: string;
  kind: "guest";
  status: "active" | "disabled";
  created_at: number;
  /** First durable action (created or joined a room); `null` => provisional, memory only. */
  activated_at: number | null;
  /** Coarse: written behind, at most once per 15 minutes. */
  last_seen_at: number;
  account_link: null;
}

export type RevokeReason = "logout" | "rotated" | "evicted" | "operator" | "principal-disabled";
export const REVOKE_REASONS: readonly RevokeReason[] = Object.freeze(["logout", "rotated", "evicted", "operator", "principal-disabled"]);
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
}

export interface IdentityChange {
  /** Upserted whole. */
  readonly principals?: readonly Principal[];
  /** Upserted whole. */
  readonly sessions?: readonly Session[];
  /** Removed (expired and retired sessions past their audit window). */
  readonly dropSessions?: readonly string[];
}

export interface IdentityStore {
  /** Everything durable. Throws on a file it cannot read without guessing (the server then refuses to start). */
  load(): Promise<IdentitySnapshot>;
  /** Durable before it resolves; `StoreDefiniteError` when nothing changed; anything else is an unknown outcome. */
  commit(change: IdentityChange): Promise<void>;
}

/* ---------------------------------------------------------------------------
    STRICT SHAPES: a stored record is exactly the frozen fields, or the store is unreadable
   --------------------------------------------------------------------------- */

const PRINCIPAL_KEYS = ["principal_id", "kind", "status", "created_at", "activated_at", "last_seen_at", "account_link"];
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
  return (
    typeof value.principal_id === "string" &&
    PRINCIPAL_ID_PATTERN.test(value.principal_id) &&
    value.kind === "guest" &&
    (value.status === "active" || value.status === "disabled") &&
    isTime(value.created_at) &&
    (value.activated_at === null || isTime(value.activated_at)) &&
    isTime(value.last_seen_at) &&
    value.account_link === null
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

/** Check a whole snapshot: shapes, unique ids, and every session's principal present and activated. */
export function checkSnapshot(snapshot: unknown, where: string): IdentitySnapshot {
  if (!isRecordObject(snapshot) || !Array.isArray(snapshot.principals) || !Array.isArray(snapshot.sessions)) {
    throw new IdentityStoreCorruptError(`${where}: not an identity snapshot`);
  }
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
  return { principals: [...principals.values()], sessions: snapshot.sessions as Session[] };
}

/** Apply a change to a snapshot, returning a new one (the input is never mutated). */
export function applyChange(base: IdentitySnapshot, change: IdentityChange): IdentitySnapshot {
  const principals = new Map(base.principals.map((record) => [record.principal_id, record] as const));
  const sessions = new Map(base.sessions.map((record) => [record.session_id, record] as const));
  for (const record of change.principals ?? []) principals.set(record.principal_id, { ...record });
  for (const record of change.sessions ?? []) sessions.set(record.session_id, { ...record });
  for (const id of change.dropSessions ?? []) sessions.delete(id);
  const byId = <T>(key: (value: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return {
    principals: [...principals.values()].sort(byId((p: Principal) => p.principal_id)),
    sessions: [...sessions.values()].sort(byId((s: Session) => s.session_id)),
  };
}

/* ---------------------------------------------------------------------------
    THE IN-MEMORY STORE: for tests and the smoke run. Every commit can be failed on demand.
   --------------------------------------------------------------------------- */

export interface MemoryIdentityStore extends IdentityStore {
  /** The durable content, as a restart would load it. */
  snapshot(): IdentitySnapshot;
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
    snapshot: () => JSON.parse(JSON.stringify(durable)) as IdentitySnapshot,
    async load() {
      return JSON.parse(JSON.stringify(durable)) as IdentitySnapshot;
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
