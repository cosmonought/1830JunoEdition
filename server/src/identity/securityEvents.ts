// server/src/identity/securityEvents.ts
//
// ==================================================================
//  LIVE-5 L5-4: THE SECURITY-EVENT JOURNAL -- WRITTEN FIRST (preflight §7.6)
// ==================================================================
//
// Identity lives in a table that can be restored to an earlier moment (its own point-in-time recovery, preflight §17.3).
// A restore must never bring back what a security action ended: a signed-out device, a retired recovery key, a disabled
// principal -- and it must not lose a profile a player created after the restore point. So every such action is ALSO
// recorded, BEFORE its identity change is committed, as an append-only event in the ledger (preflight §3.4: `SEC#` items
// of the ledger table, outside the identity table's restore domain). The identity restore replays them (L6-4).
//
// JOURNAL FIRST, AND WHY THAT DIRECTION: the identity service appends the event, and only then is the change written --
// from INSIDE the identity store's commit, after every check the store makes before it writes (`IdentityCommitOptions.
// beforeWrite`, L5-4 review F2): a change the store refuses on its own checks (held, fenced as far as it can see, a
// failed precondition) leaves no event. If the append fails -- definitely or with an unknown outcome -- the change is NOT
// written and the action answers as any store failure does. Never the other way: no committed security change is ever
// missing from the journal. OWNER DECISION (2026-09-29): this stays FAIL-CLOSED -- while the journal cannot record,
// the security changes that need an event (a sign-out closing a family, "Sign out other devices", a key rotation, a
// profile creation, a disable) answer unavailable; a recovery, which records no event, stays available.
//
// PHANTOMS, AND THE CONFIRMATION. An event can still have no committed change: its write refused by a condition only the
// table checks (a writer whose view diverged), by the fence inside the write (a takeover in the moment between the
// store's role read and its write), an unknown outcome that did not in fact land, or a crash between the append and the
// write. So once its change is committed -- and applied and answered: the identity queue appends it before its next task,
// so the confirmation never holds back an answer (N2, round-3 R3-1) -- the service appends a `confirmed` event naming
// it. Best effort: one that cannot be written is reported and the action still succeeds. An event with a confirmation was committed; one without
// may or may not have been. A confirmation names its event by id (`confirms`) and carries that event's own `at`; within
// one writer its id sorts after the event's (the writer's count). A replay pairs them by id, never by position: two
// writers' events in one millisecond (a takeover, clock skew between tasks) have no defined order.
//
// THE REPLAY RULES THIS LEAVES TO L6-4 (the identity restore; stated here so the replay cannot miss them):
//   - `family-revoked`, `signed-out-others`, `principal-disabled`: re-applied, confirmed or not. They only ever end
//     things: a phantom ends what the restore's sign-out of every session ends anyway, or disables a principal whose
//     operator saw the action fail.
//   - `profile-created`: the principal's CONFIRMED creation when there is one (there is at most one: a profiled principal
//     is never created again); otherwise its last creation, confirmed or not -- a phantom's principal had no way back in
//     once the restore signs every session out, and a creation whose confirmation alone was lost is its player's only
//     way back.
//   - `recovery-key-rotated`, confirmed: applied as one step of the chain (`from_selector` dead, `to_selector` live).
//   - `recovery-key-rotated`, UNCONFIRMED: NEVER installed automatically. Its player holds `to_selector` only if the
//     change committed and just its confirmation was lost, and `from_selector` otherwise. OWNER DECISION (2026-09-29):
//     retire `from_selector` (its player asked for it to die: it must not come back), do NOT install `to_selector`, and
//     send the profile to an operator's review.
//   - `credentials-established` (P3-ACCT): a legacy profile's username and password. The profile's CONFIRMED one when
//     there is one; otherwise its last one, confirmed or not (as `profile-created`: a credential whose confirmation
//     alone was lost is its player's way back in, and a phantom's is a password its own player chose under "Confirm it's
//     you"). A username the replay finds held by another profile -- in the restored table, or by a confirmed event --
//     was never committed here (a username is unique, checked inside every write): such a phantom is not installed. A
//     new account's credential travels inside its schema-2 `profile-created` and follows that rule, with the same
//     username check.
//   - the persisted WALLET (P3-ACCT) is NOT journaled: the restore CLEARS every profile's wallet (fail safe -- a wallet
//     is re-proven, under a fresh sign-in, on its next money action; nothing the player removed can come back).
//
// WHAT IS RECORDED (and what is not): the six kinds of change below, each carrying exactly what a replay needs to
// re-apply it idempotently and in any order -- a rotation names the selector it replaced and the one it installed (a
// chain, not a clock), a revocation names its families -- and their confirmations. Plain session rotations and
// single-session evictions are NOT recorded: the restore procedure signs every session out (preflight §17.3 step 3). No
// secret is recorded: the recovery key is kept only as the SHA-256 of a 256-bit random secret (preflight §7.6: not
// sensitive), as in the identity table itself.
//
// PRIVATE: the ids here (`pr_`, `pf_`, `sf_`, `rk_`) never go on the wire, in a RoomView, a log, a hold or a chain.

import { StoreDefiniteError, StoreUncertainError } from "../persistence/storeResult";
import { isLoginKey, isLoginName, isPasswordHash, loginKeyOf } from "./accountCredentials";
import { FAMILY_ID_PATTERN, PRINCIPAL_ID_PATTERN, PROFILE_ID_PATTERN, RECOVERY_SELECTOR_PATTERN } from "./ids";
import { isPrincipal, isProfile, PROFILE_V2_FIELDS, REVOKE_REASONS, type Principal, type Profile, type RevokeReason } from "./store";

export const SECURITY_EVENT_FORMAT = "gs-security-event";
export const SECURITY_EVENT_VERSION = 1;
/** 32 lowercase hex characters: an event's identity (with its principal and time, its storage key). The identity
 *  service mints it as its writer's event count (8 hex) then 96 random bits, so within one writer and one millisecond
 *  the text order is the order the events were written. */
export const EVENT_ID_PATTERN = /^[0-9a-f]{32}$/;
/** Times are stored as 13-digit milliseconds (preflight §3.2): anything past 2286 is refused, not misordered. */
export const MAX_EVENT_TIME = 9_999_999_999_999;

interface SecurityEventCommon {
  readonly format: typeof SECURITY_EVENT_FORMAT;
  readonly version: typeof SECURITY_EVENT_VERSION;
  readonly event_id: string;
  /** When the identity service decided the change (the action's own `now`), epoch ms. */
  readonly at: number;
  readonly principal_id: string;
}

/** The kinds of security CHANGE an event records (every kind but `confirmed`). P3-ACCT adds `credentials-established`:
 *  a LEGACY profile set its username and password (a new account's are inside its `profile-created`, schema 2). */
export type SecurityChangeKind = "profile-created" | "recovery-key-rotated" | "family-revoked" | "signed-out-others" | "principal-disabled" | "credentials-established";
export const SECURITY_CHANGE_KINDS: readonly SecurityChangeKind[] = Object.freeze(["profile-created", "recovery-key-rotated", "family-revoked", "signed-out-others", "principal-disabled", "credentials-established"]);

export type SecurityEvent =
  /** A profile was created: the principal as bound to it and the profile, exactly as committed (no secret). */
  | (SecurityEventCommon & { readonly kind: "profile-created"; readonly principal: Principal; readonly profile: Profile })
  /** The recovery key was rotated: `from_selector` is dead from this change on; `to_selector` / `recovery_hash` live. */
  | (SecurityEventCommon & {
      readonly kind: "recovery-key-rotated";
      readonly profile_id: string;
      readonly from_selector: string;
      readonly to_selector: string;
      readonly recovery_hash: string;
      readonly rotated_at: number;
    })
  /** Families revoked by a sign-out of one device (or an operator's revocation). */
  | (SecurityEventCommon & { readonly kind: "family-revoked"; readonly family_ids: readonly string[]; readonly reason: RevokeReason })
  /** "Sign out other devices": every family of the principal except `kept_family_id` is closed. */
  | (SecurityEventCommon & { readonly kind: "signed-out-others"; readonly kept_family_id: string; readonly family_ids: readonly string[] })
  /** The principal was disabled (and these families closed with it). */
  | (SecurityEventCommon & { readonly kind: "principal-disabled"; readonly family_ids: readonly string[] })
  /** P3-ACCT: a legacy profile's username and password were set (the scrypt hash only -- never the password). The
   *  username is unique and never changes; the restore installs it (`securityReplay.ts`). */
  | (SecurityEventCommon & {
      readonly kind: "credentials-established";
      readonly profile_id: string;
      readonly login_key: string;
      readonly login_name: string;
      readonly password_hash: string;
      readonly set_at: number;
    })
  /** Review F2: the change the event `confirms` (of kind `confirmed_kind`, same principal) WAS committed. */
  | (SecurityEventCommon & { readonly kind: "confirmed"; readonly confirms: string; readonly confirmed_kind: SecurityChangeKind });

export type SecurityEventKind = SecurityEvent["kind"];
export const SECURITY_EVENT_KINDS: readonly SecurityEventKind[] = Object.freeze([...SECURITY_CHANGE_KINDS, "confirmed" as const]);

/** The fields of each kind after the common ones, in canonical order. */
const KIND_FIELDS: Readonly<Record<SecurityEventKind, readonly string[]>> = {
  "profile-created": ["principal", "profile"],
  "recovery-key-rotated": ["profile_id", "from_selector", "to_selector", "recovery_hash", "rotated_at"],
  "family-revoked": ["family_ids", "reason"],
  "signed-out-others": ["kept_family_id", "family_ids"],
  "principal-disabled": ["family_ids"],
  "credentials-established": ["profile_id", "login_key", "login_name", "password_hash", "set_at"],
  confirmed: ["confirms", "confirmed_kind"],
};
const COMMON_FIELDS = ["format", "version", "event_id", "kind", "at", "principal_id"];

const isRecordObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isEventTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_EVENT_TIME;
const HEX_64 = /^[0-9a-f]{64}$/;

/** Family ids: each an `sf_` id, strictly ascending (sorted and unique -- one spelling per set). */
const isFamilyList = (value: unknown, least: number): value is string[] =>
  Array.isArray(value) &&
  value.length >= least &&
  value.every((id, at) => typeof id === "string" && FAMILY_ID_PATTERN.test(id) && (at === 0 || (value[at - 1] as string) < id));

export function isSecurityEvent(value: unknown): value is SecurityEvent {
  if (!isRecordObject(value)) return false;
  const kind = value.kind;
  if (typeof kind !== "string" || !(SECURITY_EVENT_KINDS as readonly string[]).includes(kind)) return false;
  const expected = [...COMMON_FIELDS, ...KIND_FIELDS[kind as SecurityEventKind]];
  const own = Object.keys(value);
  if (own.length !== expected.length || !expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))) return false;
  if (value.format !== SECURITY_EVENT_FORMAT || value.version !== SECURITY_EVENT_VERSION) return false;
  if (typeof value.event_id !== "string" || !EVENT_ID_PATTERN.test(value.event_id)) return false;
  if (!isEventTime(value.at)) return false;
  if (typeof value.principal_id !== "string" || !PRINCIPAL_ID_PATTERN.test(value.principal_id)) return false;
  switch (kind as SecurityEventKind) {
    case "profile-created": {
      const principal = value.principal;
      const profile = value.profile;
      return (
        isPrincipal(principal) &&
        isProfile(profile) &&
        principal.principal_id === value.principal_id &&
        principal.kind === "profile" &&
        principal.activated_at !== null &&
        principal.account_link === profile.profile_id &&
        profile.principal_id === value.principal_id
      );
    }
    case "recovery-key-rotated":
      return (
        typeof value.profile_id === "string" &&
        PROFILE_ID_PATTERN.test(value.profile_id) &&
        typeof value.from_selector === "string" &&
        RECOVERY_SELECTOR_PATTERN.test(value.from_selector) &&
        typeof value.to_selector === "string" &&
        RECOVERY_SELECTOR_PATTERN.test(value.to_selector) &&
        value.from_selector !== value.to_selector &&
        typeof value.recovery_hash === "string" &&
        HEX_64.test(value.recovery_hash) &&
        isEventTime(value.rotated_at)
      );
    case "family-revoked":
      return isFamilyList(value.family_ids, 1) && typeof value.reason === "string" && (REVOKE_REASONS as readonly string[]).includes(value.reason) && value.reason !== "rotated";
    case "signed-out-others":
      return (
        typeof value.kept_family_id === "string" &&
        FAMILY_ID_PATTERN.test(value.kept_family_id) &&
        isFamilyList(value.family_ids, 0) &&
        !(value.family_ids as string[]).includes(value.kept_family_id)
      );
    case "principal-disabled":
      return isFamilyList(value.family_ids, 0);
    case "credentials-established":
      return (
        typeof value.profile_id === "string" &&
        PROFILE_ID_PATTERN.test(value.profile_id) &&
        isLoginName(value.login_name) &&
        isLoginKey(value.login_key) &&
        value.login_key === loginKeyOf(value.login_name as string) &&
        isPasswordHash(value.password_hash) &&
        isEventTime(value.set_at)
      );
    case "confirmed":
      return (
        typeof value.confirms === "string" &&
        EVENT_ID_PATTERN.test(value.confirms) &&
        value.confirms !== value.event_id &&
        typeof value.confirmed_kind === "string" &&
        (SECURITY_CHANGE_KINDS as readonly string[]).includes(value.confirmed_kind)
      );
    default:
      return false;
  }
}

/** The event in its canonical key order (nested records too) -- what `securityEventBody` serializes. */
export function canonicalSecurityEvent(event: SecurityEvent): SecurityEvent {
  const out: Record<string, unknown> = {};
  for (const key of COMMON_FIELDS) out[key] = (event as unknown as Record<string, unknown>)[key];
  for (const key of KIND_FIELDS[event.kind]) {
    const value = (event as unknown as Record<string, unknown>)[key];
    if (key === "principal") {
      const p = value as Principal;
      out[key] = { principal_id: p.principal_id, kind: p.kind, status: p.status, created_at: p.created_at, activated_at: p.activated_at, last_seen_at: p.last_seen_at, account_link: p.account_link };
    } else if (key === "profile") {
      const p = value as Profile;
      const profile: Record<string, unknown> = {
        profile_id: p.profile_id,
        principal_id: p.principal_id,
        display_name: p.display_name,
        created_at: p.created_at,
        status: p.status,
        recovery_selector: p.recovery_selector,
        recovery_hash: p.recovery_hash,
        recovery_rotated_at: p.recovery_rotated_at,
        schema: p.schema,
      };
      /* P3-ACCT: a schema-2 profile carries its six fields too, in their stored order (a schema-1 one, none). */
      if (p.schema === 2) for (const field of PROFILE_V2_FIELDS) profile[field] = (p as unknown as Record<string, unknown>)[field];
      out[key] = profile;
    } else if (key === "family_ids") {
      out[key] = [...(value as string[])];
    } else {
      out[key] = value;
    }
  }
  return out as unknown as SecurityEvent;
}

/** The exact text stored for an event (and compared, byte for byte, when a resend finds an event already there). */
export function securityEventBody(event: SecurityEvent): string {
  return JSON.stringify(canonicalSecurityEvent(event));
}

/** An event's storage identity: its principal, then its time and id (13-digit ms, so the text order is the time order). */
export function securityEventSortKey(event: Pick<SecurityEvent, "at" | "event_id">): string {
  return `${String(event.at).padStart(13, "0")}#${event.event_id}`;
}

/** Sorted family ids, as an event carries them. */
export const familyList = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

/** A stored event that cannot be read without guessing (damage, or another build's format). Names no content. */
export class SecurityJournalCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityJournalCorruptError";
  }
}

/** Parse a stored body: the event, when it is a well-formed event stored in exactly its canonical text. */
export function parseSecurityEventBody(body: string): SecurityEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isSecurityEvent(parsed)) return null;
  return securityEventBody(parsed) === body ? parsed : null;
}

/**
 * THE PORT. `append` resolves only once the event is durable; it rejects `StoreDefiniteError` when nothing was
 * written (including a DIFFERENT event already stored under the same key: the first one stands), and anything else when
 * the outcome is unknown. Appending an event that is already stored exactly (a resend) resolves. Never overwrites.
 */
export interface SecurityEventJournal {
  append(event: SecurityEvent): Promise<void>;
  /** Every event of the principal, oldest first (by time, then id). Throws on an event it cannot read without guessing. */
  eventsOf(principalId: string): Promise<SecurityEvent[]>;
}

/* ---------------------------------------------------------------------------
    THE IN-MEMORY JOURNAL: the reference model for the conformance cases and the service tests.
   --------------------------------------------------------------------------- */

export interface MemorySecurityJournal extends SecurityEventJournal {
  /** `<principal>|<sort key>` -> the stored body. */
  readonly bodies: Map<string, string>;
  readonly failNext: Array<"definite" | "uncertain">;
  /** Every body, in key order. */
  snapshot(): string[];
}

export function createMemorySecurityJournal(): MemorySecurityJournal {
  const bodies = new Map<string, string>();
  const failNext: Array<"definite" | "uncertain"> = [];
  const keyOf = (event: SecurityEvent) => `${event.principal_id}|${securityEventSortKey(event)}`;
  return {
    bodies,
    failNext,
    snapshot: () => [...bodies.keys()].sort().map((key) => bodies.get(key) as string),
    async append(event) {
      if (!isSecurityEvent(event)) throw new StoreDefiniteError("memory security journal: not a security event; nothing was written");
      const fault = failNext.shift();
      if (fault === "definite") throw new StoreDefiniteError("injected security-journal failure (nothing written)");
      const key = keyOf(event);
      const body = securityEventBody(event);
      const stored = bodies.get(key);
      if (stored !== undefined && stored !== body) throw new StoreDefiniteError("memory security journal: another event is already recorded under this key; the first one stands");
      bodies.set(key, body);
      if (fault === "uncertain") throw new StoreUncertainError("injected security-journal failure (outcome unknown)");
    },
    async eventsOf(principalId) {
      const prefix = `${principalId}|`;
      return [...bodies.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => {
          const event = parseSecurityEventBody(bodies.get(key) as string);
          if (event === null) throw new SecurityJournalCorruptError("memory security journal: a stored event is not a well-formed event");
          return event;
        });
    },
  };
}
