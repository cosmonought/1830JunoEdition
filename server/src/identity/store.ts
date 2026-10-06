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
import { isLoginKey, isLoginName, isPasswordHash, loginKeyOf, sealedRecoveryDigest } from "./accountCredentials";
import { FAMILY_ID_PATTERN, familyIdOf, PRINCIPAL_ID_PATTERN, PROFILE_ID_PATTERN, RECOVERY_SELECTOR_PATTERN, SESSION_ID_PATTERN } from "./ids";

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

/** LIVE-2E: the application identity. PRIVATE: its id and its principal never leave the server.
 *
 *  PHASE 3 (P3-ACCT): SCHEMA 2 adds the ordinary account credential and the persisted wallet, as six fields present on
 *  every schema-2 record and on no schema-1 one (a schema-1 record is read exactly as before and stays schema 1 until
 *  the profile next changes something schema 2 carries). An older build reads a schema-2 record as damage and refuses
 *  to load -- it never silently ignores a credential or a wallet.
 *    login_key / login_name / password_hash / password_set_at   all null (a LEGACY profile: recovery key only, not yet
 *        migrated) or all set: the username's canonical form (unique, the login lookup -- NEVER an authority key), the
 *        username as chosen (shown only to the account's own sessions), the scrypt hash (`accountCredentials.ts`), and
 *        when it was set. Once set, the username never changes (no rename in this phase).
 *    wallet_address / wallet_verified_at   both null, or (schema 2: 343fac2 / caad745 only) the payout wallet a game link
 *        persisted for convenience. A browser's claim never set it.
 *
 *  PHASE 3 FINAL (AUTHORIZATION WALLET, owner ruling 2026-10-06): SCHEMA 3 is the account model this build makes. Same
 *  keys as schema 2, with stricter meaning -- every schema-3 record holds ALL of:
 *    the username login (all four login fields set: the ordinary sign-in is username + password);
 *    wallet_address / wallet_verified_at   the profile's ONE designated AUTHORIZATION WALLET (proven by an ADR-036
 *        signature over a domain-separated "1830JUNO/PROFILE-AUTHORIZATION" text the server minted -- at creation, or by
 *        a replacement both the old and the new wallet signed) and when that designation was made. Never null: no
 *        schema-3 profile exists without its Authorization Wallet (the store refuses one).
 *    recovery_selector / recovery_hash / recovery_rotated_at   NO RECOVERY KEY. The selector is now the profile's
 *        INTERNAL CREDENTIAL EPOCH only: random (128 bits), never shown, never a credential -- ESCROW-3A binds every
 *        sensitive grant and every wallet ticket to it, so it keeps exactly its stored format (`rk_…`) and its equality
 *        semantics. The digest is the SEALED one (`accountCredentials.sealedRecoveryDigest`): no key can ever match it.
 *  A schema-3 record never goes back to schema 2 or 1, and no schema-1/2 record ever becomes schema 3 (there is no legacy
 *  migration: a profile without an Authorization Wallet is RETIRED -- see `sessions.ts` -- and its owner makes a new
 *  account). */
export interface Profile {
  profile_id: string;
  /** Immutable: the one principal this profile controls. */
  principal_id: string;
  /** Human-facing, 1-24 characters, never an authority key (duplicates are allowed). */
  display_name: string;
  created_at: number;
  status: "active" | "disabled";
  /** The profile's INTERNAL CREDENTIAL EPOCH (`rk_…`; ESCROW-3A: every sensitive grant and wallet ticket is bound to
   *  it). Schema 3: random, never shown, never a credential (no recovery key exists). Schemas 1-2 (legacy, retired): it
   *  was also the lookup key of a recovery key. */
  recovery_selector: string;
  /** Schema 3: the SEALED digest (no key matches). Legacy: hex SHA-256 of a recovery key's secret. Never a secret. */
  recovery_hash: string;
  /** When the credential epoch was last set. */
  recovery_rotated_at: number;
  /** The record's own schema, for LIVE-3's migration. 2: P3-ACCT (the six fields below are present). 3: the
   *  Authorization Wallet model (the same six fields, every one set). */
  schema: 1 | 2 | 3;
  login_key?: string | null;
  login_name?: string | null;
  password_hash?: string | null;
  password_set_at?: number | null;
  wallet_address?: string | null;
  wallet_verified_at?: number | null;
}

/** P3-ACCT: the fields a schema-2 profile adds, in their stored order. */
export const PROFILE_V2_FIELDS = Object.freeze(["login_key", "login_name", "password_hash", "password_set_at", "wallet_address", "wallet_verified_at"] as const);

/** P3-ACCT: a profile as schema 2 (a schema-1 record gains the six fields, every one null). Never changes a schema-2
 *  (or schema-3) record. Used only by the identity restore's replay of a LEGACY profile's journaled credentials. */
export function asSchema2(profile: Profile): Profile {
  if (profile.schema !== 1) return { ...profile };
  return { ...profile, schema: 2, login_key: null, login_name: null, password_hash: null, password_set_at: null, wallet_address: null, wallet_verified_at: null };
}

/** P3-ACCT: the profile's username login, when it has one. */
export const loginOf = (profile: Profile): { key: string; name: string; hash: string } | null =>
  profile.schema !== 1 && typeof profile.login_key === "string" && typeof profile.login_name === "string" && typeof profile.password_hash === "string"
    ? { key: profile.login_key, name: profile.login_name, hash: profile.password_hash }
    : null;

/** P3-ACCT (schema 2 only): the LEGACY persisted convenience wallet, when it has one. It authorizes nothing in this build;
 *  only the identity restore reads it (to clear it). */
export const walletOf = (profile: Profile): { address: string; verifiedAt: number } | null =>
  profile.schema === 2 && typeof profile.wallet_address === "string" && typeof profile.wallet_verified_at === "number" ? { address: profile.wallet_address, verifiedAt: profile.wallet_verified_at } : null;

/** PHASE 3 FINAL: the profile's designated AUTHORIZATION WALLET and when it was designated (schema 3 only; every
 *  schema-3 profile has one). Null for a legacy profile (retired). */
export const authorizationWalletOf = (profile: Profile): { address: string; since: number } | null =>
  profile.schema === 3 && typeof profile.wallet_address === "string" && typeof profile.wallet_verified_at === "number" ? { address: profile.wallet_address, since: profile.wallet_verified_at } : null;

/** The wallet field AS STORED (any schema): what the `profile-wallet` compare-and-swap compares. */
export const storedWalletOf = (profile: Profile): string | null => (profile.schema !== 1 && typeof profile.wallet_address === "string" ? profile.wallet_address : null);

/** P3-ACCT: a canonical Juno account address (20-byte data: `juno1` + 38 bech32 symbols). Shape only; the money layer
 *  decodes the bech32 (`walletProof.canonicalJunoWallet`) before anything sets a wallet. */
export const JUNO_WALLET_PATTERN = /^juno1[02-9ac-hj-np-z]{38}$/;

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
  /** ESCROW-3A (IR-03): the rotation lineage this session belongs to (`SessionFamily`). A rotation successor and a grace
   *  successor inherit it; a bootstrap, a recovery and a link found a new one. Never changes. */
  family_id: string;
}

/* ==================================================================
    ESCROW-3A (IR-03): THE SESSION FAMILY RECORD
   ==================================================================
   One browser's cookie-jar lineage: the session a bootstrap, a recovery or a link issued, and every session rotated or
   grace-minted from it. LIVE-2F/3D's IR-03: a grace successor minted from an old cookie by a sibling tab at the moment of
   a sign-out was linked to nothing the sign-out walked, so it could survive. Now a sign-out revokes the FAMILY -- one
   record -- and every member with it; a rotation or grace mint must find its family open (precondition `family-open`),
   so no successor can be minted into a family a committed sign-out has closed, in whatever order the two arrive. In
   LIVE-5 the revocation is ONE conditional update of the family item (`revoked_at` absent) and every mint carries a
   ConditionCheck on it: two processes cannot interleave a sign-out and a mint into a survivor. PRIVATE: never on the
   wire, in a RoomView, a gameplay log, a hold, an audit line or a chain; not an application or player identity. */
export type FamilyOrigin =
  /** A browser's own bootstrap (and so, for a profile, the browser that CREATED it). */
  | "bootstrap"
  /** A browser signed in by the recovery key. */
  | "recovery"
  /** A browser signed in by a "Link another device" code. */
  | "link"
  /** Derived at the migration of a pre-family session (its founding is not on record). */
  | "legacy"
  /** P3-ACCT: a browser signed in by a username and password (a login, or the account creation that signs it in). */
  | "login";
export const FAMILY_ORIGINS: readonly FamilyOrigin[] = Object.freeze(["bootstrap", "recovery", "link", "legacy", "login"]);

export interface SessionFamily {
  family_id: string;
  principal_id: string;
  created_at: number;
  /** How the family was founded (bootstrap, recovery, link, or legacy for a v3 lineage). Informational and audit-facing:
   *  no permission is derived from it (ESCROW-3A's lost-create-response rescue is bound to the creating SESSION). */
  origin: FamilyOrigin;
  /** Set once, by a security revocation of the family; a revoked family never reopens. */
  revoked_at: number | null;
  revoke_reason: RevokeReason | null;
}

export interface IdentitySnapshot {
  principals: Principal[];
  sessions: Session[];
  /** LIVE-2E. Absent in a snapshot built before profiles (read as empty). */
  profiles?: Profile[];
  /** LIVE-2E. Absent in a snapshot built before profiles (read as empty). */
  links?: LinkCredential[];
  /** ESCROW-3A. Absent in a snapshot built before session families (a legacy load derives them). */
  families?: SessionFamily[];
}

/** A snapshot with every collection present -- what `checkSnapshot` returns. */
export interface FullIdentitySnapshot {
  principals: Principal[];
  sessions: Session[];
  profiles: Profile[];
  links: LinkCredential[];
  families: SessionFamily[];
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
  | { readonly kind: "link-unconsumed"; readonly link_hash: string; readonly at: number }
  /** ESCROW-3A: CREATE-IF-ABSENT for a session family. */
  | { readonly kind: "family-absent"; readonly family_id: string }
  /** ESCROW-3A (IR-03): the family is stored and not revoked -- a member may be minted into it, or it may be revoked. */
  | { readonly kind: "family-open"; readonly family_id: string }
  /** P3-ACCT: no stored profile holds this username (its canonical login key). */
  | { readonly kind: "login-unused"; readonly login_key: string }
  /** P3-ACCT: the profile is stored and has no username login yet (a legacy profile establishing one). */
  | { readonly kind: "profile-no-login"; readonly profile_id: string }
  /** P3-ACCT: COMPARE-AND-SWAP of the profile's persisted wallet -- the profile is stored and holds exactly this wallet
   *  (`null`: none). */
  | { readonly kind: "profile-wallet"; readonly profile_id: string; readonly wallet_address: string | null }
  /** P3-ACCT POLICY: COMPARE-AND-SWAP of the PASSWORD GENERATION -- the profile is stored and its username login holds
   *  exactly this password hash. Every password hash is made with a fresh random salt, so the hash IS the generation:
   *  a change decided against a superseded password (a second writer, a racing change or reset) is refused by every
   *  store, in the same step as the write. */
  | { readonly kind: "profile-password"; readonly profile_id: string; readonly password_hash: string };

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
  /** ESCROW-3A: upserted whole (a new family, or one revoked). A family is never removed while a session names it. */
  readonly families?: readonly SessionFamily[];
}

/** LIVE-5 L5-4 (review F2): what a caller may ask of one commit. */
export interface IdentityCommitOptions {
  /**
   * Called exactly once, AFTER every check the store makes before it writes has passed -- it is loaded and not held,
   * its fence as far as it can see, the change's own shape and every precondition against its view -- and immediately
   * BEFORE the write. Never called for a change the store refuses on those checks. The change is written only once it
   * resolves; if it rejects, nothing is written and `commit` rejects with that same error, unchanged.
   * The identity service appends a security change's event here, so a change the store refuses first leaves no event
   * behind. What no store can rule out: a write refused or left unresolved after the hook ran (a condition only the
   * table can check, the fence inside the write, a lost answer) -- that event has no committed change (a phantom,
   * securityEvents.ts).
   */
  readonly beforeWrite?: () => Promise<void>;
}

export interface IdentityStore {
  /** Everything durable. Throws on a file it cannot read without guessing (the server then refuses to start). */
  load(): Promise<FullIdentitySnapshot>;
  /** Durable before it resolves; `StoreDefiniteError` when nothing changed; anything else is an unknown outcome
   *  (except `options.beforeWrite`'s own rejection, passed through: nothing was written). */
  commit(change: IdentityChange, options?: IdentityCommitOptions): Promise<void>;
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
  "family_id",
];
const FAMILY_KEYS = ["family_id", "principal_id", "created_at", "origin", "revoked_at", "revoke_reason"];

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
  if (!isRecordObject(value)) return false;
  if (value.schema === 2 || value.schema === 3) {
    if (!exactKeys(value, [...PROFILE_KEYS, ...PROFILE_V2_FIELDS])) return false;
    /* P3-ACCT: the login is all or nothing, and its key is its name's canonical form; the wallet is a pair. */
    const login = [value.login_key, value.login_name, value.password_hash, value.password_set_at];
    const noLogin = login.every((field) => field === null);
    const hasLogin =
      isLoginName(value.login_name) && isLoginKey(value.login_key) && value.login_key === loginKeyOf(value.login_name as string) && isPasswordHash(value.password_hash) && isTime(value.password_set_at);
    const noWallet = value.wallet_address === null && value.wallet_verified_at === null;
    const hasWallet = typeof value.wallet_address === "string" && JUNO_WALLET_PATTERN.test(value.wallet_address) && isTime(value.wallet_verified_at);
    if (value.schema === 3) {
      /* PHASE 3 FINAL: a username login AND an Authorization Wallet, always; and no recovery key can exist (the sealed
         digest of its own epoch). */
      if (!hasLogin || !hasWallet) return false;
      if (typeof value.recovery_selector !== "string" || value.recovery_hash !== sealedRecoveryDigest(value.recovery_selector)) return false;
    } else if (!(noLogin || hasLogin) || !(noWallet || hasWallet)) return false;
  } else if (!exactKeys(value, PROFILE_KEYS)) {
    return false;
  }
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
    (value.schema === 1 || value.schema === 2 || value.schema === 3)
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
    (value.rotated_to === null || (typeof value.rotated_to === "string" && SESSION_ID_PATTERN.test(value.rotated_to))) &&
    typeof value.family_id === "string" &&
    FAMILY_ID_PATTERN.test(value.family_id)
  );
}

export function isSessionFamily(value: unknown): value is SessionFamily {
  if (!isRecordObject(value) || !exactKeys(value, FAMILY_KEYS)) return false;
  return (
    typeof value.family_id === "string" &&
    FAMILY_ID_PATTERN.test(value.family_id) &&
    typeof value.principal_id === "string" &&
    PRINCIPAL_ID_PATTERN.test(value.principal_id) &&
    isTime(value.created_at) &&
    (FAMILY_ORIGINS as readonly unknown[]).includes(value.origin) &&
    (value.revoked_at === null || isTime(value.revoked_at)) &&
    (value.revoke_reason === null || ((REVOKE_REASONS as readonly unknown[]).includes(value.revoke_reason) && value.revoke_reason !== "rotated")) &&
    (value.revoked_at === null) === (value.revoke_reason === null)
  );
}

/* ==================================================================
    ESCROW-3A: THE LEGACY MIGRATION -- A SESSION WRITTEN BEFORE FAMILIES EXISTED
   ==================================================================
   Explicit and one way, like v1 -> v2 and v2 -> v3: a legacy session record (the nine LIVE-2B keys, no `family_id`) is
   given the family of its ROTATION LINEAGE -- the `rotated_to` chain is walked back to the session that founded it, and
   the family is named after that founder (`familyIdOf`), the same derivation a new family uses. Deterministic: every
   load that migrates the same records derives the same families, so a crash before the migrated snapshot is written
   loses nothing. One residual, disclosed: a GRACE successor minted before this migration was never linked by
   `rotated_to` (that was IR-03), so it founds a family of its own; it is still ended by "Sign out other devices", by a
   key rotation's successors, and by the principal-wide rotated sweep of LIVE-2F/3D (C1-01). */
export function isLegacySession(value: unknown): boolean {
  if (!isRecordObject(value) || !exactKeys(value, SESSION_KEYS.filter((key) => key !== "family_id"))) return false;
  return isSession({ ...value, family_id: familyIdOf(String(value.session_id)) });
}

/** A legacy session set, each with its lineage's family, and the families it implies (open: a revoked member stays
 *  revoked on its own record; nothing about a family's revocation can be read off pre-family records). */
export function withLegacyFamilies(sessions: readonly unknown[], where: string, existing?: (sessionId: string) => string | undefined): { sessions: Session[]; families: SessionFamily[] } {
  const bySession = new Map<string, Record<string, unknown>>();
  const predecessor = new Map<string, string>();
  sessions.forEach((record, at) => {
    if (!isLegacySession(record) && !isSession(record)) throw new IdentityStoreCorruptError(`${where}: session #${at} is not a session record`);
    const session = record as Record<string, unknown>;
    /* A repeated session id is corruption, exactly as `checkSnapshot` and a journal line call it: never resolved by
       keeping one of them (that could bring a revoked session back). */
    if (bySession.has(session.session_id as string)) throw new IdentityStoreCorruptError(`${where}: session #${at} repeats a session id`);
    bySession.set(session.session_id as string, session);
    if (typeof session.rotated_to === "string") predecessor.set(session.rotated_to, session.session_id as string);
  });
  const familyOf = (sessionId: string): string => {
    const known = existing?.(sessionId);
    if (known !== undefined) return known;
    const own = bySession.get(sessionId);
    if (own !== undefined && typeof own.family_id === "string") return own.family_id;
    const seen = new Set<string>([sessionId]);
    let root = sessionId;
    for (let back = predecessor.get(root); back !== undefined && !seen.has(back); back = predecessor.get(root)) {
      const alreadyKnown = existing?.(back) ?? (bySession.get(back)?.family_id as string | undefined);
      if (alreadyKnown !== undefined) return alreadyKnown;
      seen.add(back);
      root = back;
    }
    return familyIdOf(root);
  };
  const families = new Map<string, SessionFamily>();
  const out: Session[] = [];
  for (const session of bySession.values()) {
    const family_id = familyOf(session.session_id as string);
    const migrated = { ...session, family_id } as unknown as Session;
    out.push(migrated);
    const current = families.get(family_id);
    if (current === undefined || migrated.created_at < current.created_at) {
      families.set(family_id, { family_id, principal_id: migrated.principal_id, created_at: migrated.created_at, origin: "legacy", revoked_at: null, revoke_reason: null });
    }
  }
  return { sessions: out, families: [...families.values()] };
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
  const rawFamilies = snapshot.families === undefined ? [] : snapshot.families;
  if (!Array.isArray(rawProfiles) || !Array.isArray(rawLinks) || !Array.isArray(rawFamilies)) throw new IdentityStoreCorruptError(`${where}: not an identity snapshot`);
  const principals = new Map<string, Principal>();
  snapshot.principals.forEach((record, at) => {
    if (!isPrincipal(record)) throw new IdentityStoreCorruptError(`${where}: principal #${at} is not a principal record`);
    if (record.activated_at === null) throw new IdentityStoreCorruptError(`${where}: principal #${at} was never activated`);
    if (principals.has(record.principal_id)) throw new IdentityStoreCorruptError(`${where}: principal #${at} is a duplicate`);
    principals.set(record.principal_id, record);
  });
  const families = new Map<string, SessionFamily>();
  rawFamilies.forEach((record, at) => {
    if (!isSessionFamily(record)) throw new IdentityStoreCorruptError(`${where}: session family #${at} is not a family record`);
    if (families.has(record.family_id)) throw new IdentityStoreCorruptError(`${where}: session family #${at} is a duplicate`);
    if (!principals.has(record.principal_id)) throw new IdentityStoreCorruptError(`${where}: session family #${at} names no stored principal`);
    families.set(record.family_id, record);
  });
  const sessions = new Set<string>();
  snapshot.sessions.forEach((record, at) => {
    if (!isSession(record)) throw new IdentityStoreCorruptError(`${where}: session #${at} is not a session record`);
    if (sessions.has(record.session_id)) throw new IdentityStoreCorruptError(`${where}: session #${at} is a duplicate`);
    if (!principals.has(record.principal_id)) throw new IdentityStoreCorruptError(`${where}: session #${at} names no stored principal`);
    /* ESCROW-3A: every session belongs to a stored family of ITS OWN principal. */
    if (families.get(record.family_id)?.principal_id !== record.principal_id) {
      throw new IdentityStoreCorruptError(`${where}: session #${at} names no session family of its principal`);
    }
    sessions.add(record.session_id);
  });
  const profiles = new Map<string, Profile>();
  const profileOfPrincipal = new Set<string>();
  const selectors = new Set<string>();
  const logins = new Set<string>();
  rawProfiles.forEach((record, at) => {
    if (!isProfile(record)) throw new IdentityStoreCorruptError(`${where}: profile #${at} is not a profile record`);
    if (profiles.has(record.profile_id)) throw new IdentityStoreCorruptError(`${where}: profile #${at} is a duplicate`);
    const owner = principals.get(record.principal_id);
    if (owner === undefined || owner.kind !== "profile" || owner.account_link !== record.profile_id) {
      throw new IdentityStoreCorruptError(`${where}: profile #${at} is not bound to its principal both ways`);
    }
    if (profileOfPrincipal.has(record.principal_id)) throw new IdentityStoreCorruptError(`${where}: profile #${at} shares a principal`);
    if (selectors.has(record.recovery_selector)) throw new IdentityStoreCorruptError(`${where}: profile #${at} repeats a recovery selector`);
    /* P3-ACCT: a username belongs to one profile. */
    const login = loginOf(record);
    if (login !== null && logins.has(login.key)) throw new IdentityStoreCorruptError(`${where}: profile #${at} repeats a username`);
    profiles.set(record.profile_id, record);
    profileOfPrincipal.add(record.principal_id);
    selectors.add(record.recovery_selector);
    if (login !== null) logins.add(login.key);
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
    families: [...families.values()],
  };
}

/** Apply a change to a snapshot, returning a new one (the input is never mutated). */
export function applyChange(base: IdentitySnapshot, change: IdentityChange): FullIdentitySnapshot {
  const principals = new Map(base.principals.map((record) => [record.principal_id, record] as const));
  const sessions = new Map(base.sessions.map((record) => [record.session_id, record] as const));
  const profiles = new Map((base.profiles ?? []).map((record) => [record.profile_id, record] as const));
  const links = new Map((base.links ?? []).map((record) => [record.link_hash, record] as const));
  const families = new Map((base.families ?? []).map((record) => [record.family_id, record] as const));
  for (const record of change.principals ?? []) principals.set(record.principal_id, { ...record });
  for (const record of change.families ?? []) families.set(record.family_id, { ...record });
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
    families: [...families.values()].sort(byId((f: SessionFamily) => f.family_id)),
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
  family(id: string): SessionFamily | undefined;
  /** P3-ACCT: the profile holding this username's canonical key. */
  profileOfLogin(loginKey: string): string | undefined;
}

/** The lookups of a whole snapshot (built per call: the memory and whole-file stores, for tests and the migration). */
export function lookupsOf(snapshot: IdentitySnapshot): IdentityLookups {
  const principals = new Map(snapshot.principals.map((record) => [record.principal_id, record] as const));
  const sessions = new Map(snapshot.sessions.map((record) => [record.session_id, record] as const));
  const profiles = new Map((snapshot.profiles ?? []).map((record) => [record.profile_id, record] as const));
  const links = new Map((snapshot.links ?? []).map((record) => [record.link_hash, record] as const));
  const selectors = new Map((snapshot.profiles ?? []).map((record) => [record.recovery_selector, record.profile_id] as const));
  const families = new Map((snapshot.families ?? []).map((record) => [record.family_id, record] as const));
  const logins = new Map<string, string>();
  for (const record of snapshot.profiles ?? []) {
    const login = loginOf(record);
    if (login !== null) logins.set(login.key, record.profile_id);
  }
  return {
    principal: (id) => principals.get(id),
    session: (id) => sessions.get(id),
    profile: (id) => profiles.get(id),
    link: (hash) => links.get(hash),
    profileOfSelector: (selector) => selectors.get(selector),
    family: (id) => families.get(id),
    profileOfLogin: (loginKey) => logins.get(loginKey),
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
        case "family-absent":
          return lookups.family(condition.family_id) !== undefined;
        case "family-open": {
          const family = lookups.family(condition.family_id);
          return family === undefined || family.revoked_at !== null;
        }
        case "login-unused":
          return lookups.profileOfLogin(condition.login_key) !== undefined;
        case "profile-no-login": {
          const profile = lookups.profile(condition.profile_id);
          return profile === undefined || loginOf(profile) !== null;
        }
        case "profile-wallet": {
          const profile = lookups.profile(condition.profile_id);
          return profile === undefined || storedWalletOf(profile) !== condition.wallet_address;
        }
        case "profile-password": {
          const profile = lookups.profile(condition.profile_id);
          return profile === undefined || loginOf(profile)?.hash !== condition.password_hash;
        }
        default:
          return true; // an unknown condition never holds
      }
    })();
    if (failed) return `precondition #${at} (${(condition as { kind: string }).kind}) does not hold`;
  }
  return null;
}

/* ==================================================================
    LIVE-5 L5-4: A CHANGE'S OWN FIELDS ARE WELL-FORMED BEFORE ANY STORE LOOKS AT THEM
   ==================================================================
   The records a change writes are shape-checked by `IdentityIndex.check` / `checkSnapshot`. Its PRECONDITIONS and its
   DROPS were not: a precondition naming an id of the wrong type, or a `link-unconsumed` whose `at` is not a time, was
   evaluated anyway -- `NaN >= expires_at` is false, so such a term "held". A DynamoDB store cannot even express those
   (a number attribute cannot hold NaN; a key cannot be 3 KB), so it would refuse where the memory and journal stores
   accept. Every store now refuses a malformed change DEFINITE, before anything is looked up, with the same answer --
   conformance ID-19. Never reached by the service (its ids are minted and its times are clock readings). Commit paths
   only: a stored journal line is never re-judged by this at a load. */
type FieldShape = RegExp | "time" | ((value: unknown) => boolean);
const walletOrNull = (value: unknown): boolean => value === null || (typeof value === "string" && JUNO_WALLET_PATTERN.test(value));
const PRECONDITION_SHAPES: Readonly<Record<IdentityPrecondition["kind"], readonly [string, FieldShape][]>> = {
  "principal-absent": [["principal_id", PRINCIPAL_ID_PATTERN]],
  "principal-unprofiled": [["principal_id", PRINCIPAL_ID_PATTERN]],
  "profile-absent": [["profile_id", PROFILE_ID_PATTERN]],
  "selector-unused": [["recovery_selector", RECOVERY_SELECTOR_PATTERN]],
  "profile-selector": [
    ["profile_id", PROFILE_ID_PATTERN],
    ["recovery_selector", RECOVERY_SELECTOR_PATTERN],
  ],
  "session-absent": [["session_id", SESSION_ID_PATTERN]],
  "session-open": [["session_id", SESSION_ID_PATTERN]],
  "link-absent": [["link_hash", HEX_64]],
  "link-unconsumed": [
    ["link_hash", HEX_64],
    ["at", "time"],
  ],
  "family-absent": [["family_id", FAMILY_ID_PATTERN]],
  "family-open": [["family_id", FAMILY_ID_PATTERN]],
  "login-unused": [["login_key", isLoginKey]],
  "profile-no-login": [["profile_id", PROFILE_ID_PATTERN]],
  "profile-wallet": [
    ["profile_id", PROFILE_ID_PATTERN],
    ["wallet_address", walletOrNull],
  ],
  "profile-password": [
    ["profile_id", PROFILE_ID_PATTERN],
    ["password_hash", isPasswordHash],
  ],
};

/** Why a change's preconditions or drops are malformed (`null`: they are not). Names the kind and position only. */
export function changeShapeProblem(change: IdentityChange): string | null {
  if (!isRecordObject(change)) return "a change is not an object";
  const expect = (change as { expect?: unknown }).expect;
  if (expect !== undefined) {
    if (!Array.isArray(expect)) return "a change's preconditions are not a list";
    for (const [at, condition] of expect.entries()) {
      if (!isRecordObject(condition) || typeof condition.kind !== "string" || !Object.prototype.hasOwnProperty.call(PRECONDITION_SHAPES, condition.kind)) {
        return `precondition #${at} is not a known precondition`;
      }
      const fields = PRECONDITION_SHAPES[condition.kind as IdentityPrecondition["kind"]];
      if (!exactKeys(condition, ["kind", ...fields.map(([name]) => name)])) return `precondition #${at} (${condition.kind}) is not well-formed`;
      for (const [name, shape] of fields) {
        const value = condition[name];
        const ok = shape === "time" ? isTime(value) : typeof shape === "function" ? shape(value) : typeof value === "string" && shape.test(value);
        if (!ok) return `precondition #${at} (${condition.kind}) is not well-formed`;
      }
    }
  }
  const drops: Array<[string, RegExp]> = [
    ["dropSessions", SESSION_ID_PATTERN],
    ["dropLinks", HEX_64],
  ];
  for (const [field, pattern] of drops) {
    const ids = (change as Record<string, unknown>)[field];
    if (ids === undefined) continue;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && pattern.test(id))) return `a change's ${field} names something that is not an id`;
  }
  for (const field of ["principals", "sessions", "profiles", "links", "families"]) {
    const records = (change as Record<string, unknown>)[field];
    if (records !== undefined && (!Array.isArray(records) || !records.every(isRecordObject))) return `a change's ${field} are not a list of records`;
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
    once("link code", linkKeys) ??
    once("session family", (change.families ?? []).map((record) => record.family_id))
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
  readonly families = new Map<string, SessionFamily>();
  /** P3-ACCT: username (canonical key) -> profile. A login never changes or goes once set, so nothing is ever removed. */
  readonly logins = new Map<string, string>();

  static from(snapshot: FullIdentitySnapshot): IdentityIndex {
    const index = new IdentityIndex();
    for (const record of snapshot.principals) index.principals.set(record.principal_id, record);
    for (const record of snapshot.sessions) index.sessions.set(record.session_id, record);
    for (const record of snapshot.profiles) {
      index.profiles.set(record.profile_id, record);
      index.selectors.set(record.recovery_selector, record.profile_id);
      const login = loginOf(record);
      if (login !== null) index.logins.set(login.key, record.profile_id);
    }
    for (const record of snapshot.links) index.links.set(record.link_hash, record);
    for (const record of snapshot.families) index.families.set(record.family_id, record);
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
  family(id: string) {
    return this.families.get(id);
  }
  profileOfLogin(loginKey: string) {
    return this.logins.get(loginKey);
  }

  /** Why this change would make the set invalid, or `null`. Checks the change alone against this index -- the
   *  relations of every record it writes -- never the whole set. `where` names the caller in the sentence. */
  check(change: IdentityChange, where: string): string | null {
    const ids = changeIdProblem(change);
    if (ids !== null) return `${where}: ${ids}`;
    const nextPrincipals = new Map((change.principals ?? []).map((record) => [record.principal_id, record] as const));
    const nextProfiles = new Map((change.profiles ?? []).map((record) => [record.profile_id, record] as const));
    const nextFamilies = new Map((change.families ?? []).map((record) => [record.family_id, record] as const));
    const principalAfter = (id: string) => nextPrincipals.get(id) ?? this.principals.get(id);
    const profileAfter = (id: string) => nextProfiles.get(id) ?? this.profiles.get(id);
    const familyAfter = (id: string) => nextFamilies.get(id) ?? this.families.get(id);
    for (const [at, record] of (change.families ?? []).entries()) {
      if (!isSessionFamily(record)) return `${where}: session family #${at} is not a family record`;
      if (principalAfter(record.principal_id) === undefined) return `${where}: session family #${at} names no stored principal`;
      const before = this.families.get(record.family_id);
      if (before !== undefined && before.principal_id !== record.principal_id) return `${where}: session family #${at} would move to another principal`;
      if (before !== undefined && before.origin !== record.origin) return `${where}: session family #${at} would change its origin`;
      if (before !== undefined && before.revoked_at !== null && record.revoked_at === null) return `${where}: session family #${at} would reopen a revoked family`;
    }
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
    const loginsTaken = new Set<string>();
    for (const [at, record] of (change.profiles ?? []).entries()) {
      if (!isProfile(record)) return `${where}: profile #${at} is not a profile record`;
      const before = this.profiles.get(record.profile_id);
      if (before !== undefined && before.principal_id !== record.principal_id) return `${where}: profile #${at} would move to another principal`;
      /* P3-ACCT: a profile never goes back to schema 1, and its username, once set, never changes or goes. */
      if (before !== undefined && before.schema === 2 && record.schema === 1) return `${where}: profile #${at} would return to schema 1`;
      /* PHASE 3 FINAL: a schema-3 profile is made as one and stays one (no legacy profile is ever given an Authorization
         Wallet -- there is no migration -- and no Authorization-Wallet profile ever loses it). */
      if (before !== undefined && (before.schema === 3) !== (record.schema === 3)) return `${where}: profile #${at} would change between the legacy and the Authorization Wallet schema`;
      const loginBefore = before === undefined ? null : loginOf(before);
      const login = loginOf(record);
      if (loginBefore !== null && login?.key !== loginBefore.key) return `${where}: profile #${at} would change or drop its username`;
      if (login !== null) {
        const holder = this.logins.get(login.key);
        if ((holder !== undefined && holder !== record.profile_id) || loginsTaken.has(login.key)) return `${where}: profile #${at} repeats a username`;
        loginsTaken.add(login.key);
      }
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
      if (familyAfter(record.family_id)?.principal_id !== record.principal_id) return `${where}: session #${at} names no session family of its principal`;
      const before = this.sessions.get(record.session_id);
      if (before !== undefined && before.family_id !== record.family_id) return `${where}: session #${at} would move to another family`;
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
      const login = loginOf(record);
      if (login !== null) this.logins.set(login.key, record.profile_id);
    }
    for (const record of change.links ?? []) this.links.set(record.link_hash, { ...record });
    for (const hash of change.dropLinks ?? []) this.links.delete(hash);
    for (const record of change.families ?? []) this.families.set(record.family_id, { ...record });
  }

  /** The whole set, in the stored order (`applyChange`'s). */
  snapshot(): FullIdentitySnapshot {
    return applyChange(
      { principals: [...this.principals.values()], sessions: [...this.sessions.values()], profiles: [...this.profiles.values()], links: [...this.links.values()], families: [...this.families.values()] },
      {},
    );
  }

  sizes(): { principals: number; sessions: number; profiles: number; links: number; families: number } {
    return { principals: this.principals.size, sessions: this.sessions.size, profiles: this.profiles.size, links: this.links.size, families: this.families.size };
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
    async commit(change, options) {
      const fault = failNext.shift();
      if (fault === "definite") {
        stats.failed += 1;
        throw new StoreDefiniteError("injected identity-store failure (nothing written)");
      }
      /** The change against what is durable now: the next content, or DEFINITE (nothing written). */
      const decide = (): FullIdentitySnapshot => {
        /* LIVE-3C: the change's own contract -- one record once, every precondition -- before anything is applied. */
        /* P3-ACCT: and the rules about a record's own past (a username never changes; a family never reopens; ...), as
           the journal store (`IdentityIndex.check`) and the DynamoDB conditions apply them. */
        const problem = changeShapeProblem(change) ?? changeIdProblem(change) ?? IdentityIndex.from(durable).check(change, "memory identity store") ?? preconditionFailure(lookupsOf(durable), change.expect);
        if (problem !== null) {
          stats.failed += 1;
          throw new StoreDefiniteError(`memory identity store: ${problem}; nothing was written`);
        }
        /* LIVE-5 L5-1 (conformance ID-08): a change that would break a relation is refused DEFINITE -- nothing was
           written -- exactly as the production journal store refuses it. It used to escape as `IdentityStoreCorruptError`,
           which the port's contract reads as an UNKNOWN outcome (a restart-required fault) for a change that never landed. */
        try {
          return checkSnapshot(applyChange(durable, change), "memory identity store commit");
        } catch (error) {
          stats.failed += 1;
          throw new StoreDefiniteError(`${error instanceof Error ? error.message : String(error)}; nothing was written`);
        }
      };
      let next = decide();
      if (options?.beforeWrite !== undefined) {
        await options.beforeWrite();
        /* The hook yielded, and this store has no queue: another commit may have landed meanwhile. The write is decided
           against what is durable NOW (as a condition inside the write would be). */
        next = decide();
      }
      durable = next;
      if (fault === "uncertain") {
        stats.failed += 1;
        throw new StoreUncertainError("injected identity-store failure (outcome unknown)");
      }
      stats.commits += 1;
    },
  };
}
