// server/src/identity/sessions.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §3.3-§4.7): PRINCIPALS AND SESSIONS, IN ONE PLACE
// ==================================================================
//
// THE IN-MEMORY STATE IS THE COMMITTED STATE. Every change to a durable (activated) principal or its sessions is
// written to the store FIRST, and applied here only once the store has it -- a revoke the disk does not hold would
// resurrect at the next restart, a rotation it does not hold would strand the new cookie. So every mutation runs
// on one serial queue (check, write, apply, with nothing else interleaved), and every read -- an upgrade, a frame
// check -- is synchronous against what is committed. A store failure is RETHROWN to the caller, who refuses what
// it was doing (503 at the bootstrap, a refused room change at activation); it is never swallowed.
//
// PROVISIONAL GUESTS (§3.3) never touch the store: a bootstrap without a cookie mints a principal and a session in
// a bounded LRU (50,000). They become durable at ACTIVATION -- the first durable room action -- when the principal
// and its sessions are written together. A restart forgets the rest; they own nothing.
//
// THE LIFETIMES (§4.5): 30 days idle (sliding, from `last_seen_at`, which is written behind at most every 15
// minutes), 180 days absolute. At a bootstrap a session older than 7 days is ROTATED: a successor for the SAME
// principal, the old one retired `rotated` with `rotated_to`. For 24 hours a rotated session is still accepted BY
// THE BOOTSTRAP ONLY, which mints a further successor for the same principal -- so two tabs rotating at once, or a
// lost Set-Cookie, both end on the same principal. A rotated session never authenticates a new socket, and the
// sockets already open on it are not closed: rotation is hygiene, not a security event.
//
// A KNOWN SESSION THAT HAS ENDED -- expired, revoked, evicted, its principal disabled, rotated past the grace, or
// presented with the wrong secret -- is `ended`, NEVER a new guest (§4.1, the review's High finding 2). Only no
// cookie, an unknown selector, or the explicit `{fresh: true}` mints a principal. Ended sessions are therefore kept
// (in memory and in the store) until no browser could still hold their cookie: 180 days after the cookie was set,
// and never less than the 7-day audit window after a revocation.

import { APP_NAME } from "../../../frontend/src/config";
import { StoreDefiniteError } from "../persistence/storeResult";
import {
  cleanLoginName,
  cleanPassword,
  DEFAULT_PASSWORD_KDF,
  hashPassword,
  KdfGate,
  loginKeyOf,
  PASSWORD_MAX_BYTES,
  sealedRecoveryDigest,
  verifyPassword,
  warmPasswordKdf,
  type PasswordKdfParams,
  type PasswordProblem,
} from "./accountCredentials";
import { createAuthorizationBook, verifyAuthorization, type AuthorizationBook, type AuthorizationClient, type AuthorizationOperation, type AuthorizationSignature } from "./authorizationWallet";
import { sessionSetCookie, type SessionCookieRead } from "./cookies";
import type { SensitiveAuthGrantStore } from "./grants";
import {
  cryptoRandom,
  familyIdOf,
  mintPrincipalId,
  mintProfileId,
  mintRecoverySelector,
  mintSecret,
  mintSessionId,
  mintUnique,
  secretHash,
  secretMatches,
  type RandomSource,
} from "./ids";
import {
  authorizationWalletOf,
  isDisplayName,
  isSecurityRevocation,
  JUNO_WALLET_PATTERN,
  loginOf,
  type IdentityChange,
  type IdentitySnapshot,
  type IdentityStore,
  type LinkCredential,
  type Principal,
  type Profile,
  type RevokeReason,
  type Session,
  type SessionFamily,
} from "./store";
import { familyList, SECURITY_EVENT_FORMAT, SECURITY_EVENT_VERSION, type SecurityChangeKind, type SecurityEvent, type SecurityEventJournal } from "./securityEvents";

const DAY = 24 * 60 * 60 * 1000;
/** A reaction that settles quietly: the identity queue never rejects. */
const settledQuietly = (): undefined => undefined;

export interface IdentityPolicy {
  idleMs: number;
  absoluteMs: number;
  rotateAfterMs: number;
  rotatedGraceMs: number;
  lastSeenWriteMs: number;
  maxActiveSessions: number;
  provisionalLimit: number;
  /** A revoked session is kept at least this long for the audit trail (LIVE-2 §14.1). */
  auditRetentionMs: number;
  /** ESCROW-3A (brief §10B): how long a re-authentication ("Confirm it's you" with the password, or a sign-in) lets THIS
   *  session take a sensitive action -- sign out other devices, (ESCROW-4) link a wallet to a seat, and (PHASE 3 FINAL,
   *  an explicit confirmation only) begin replacing the Authorization Wallet. */
  sensitiveAuthMs: number;
  /** P3-ACCT: the scrypt parameters NEW password hashes are made with (a stored hash carries its own). */
  passwordKdf: PasswordKdfParams;
  /** P3-ACCT: how many password KDF computations may run at once (beyond it a request is answered `busy`). */
  kdfConcurrency: number;
}

export const DEFAULT_IDENTITY_POLICY: IdentityPolicy = Object.freeze({
  idleMs: 30 * DAY,
  absoluteMs: 180 * DAY,
  rotateAfterMs: 7 * DAY,
  rotatedGraceMs: DAY,
  lastSeenWriteMs: 15 * 60 * 1000,
  maxActiveSessions: 10,
  provisionalLimit: 50_000,
  auditRetentionMs: 7 * DAY,
  sensitiveAuthMs: 5 * 60 * 1000,
  passwordKdf: DEFAULT_PASSWORD_KDF,
  kdfConcurrency: 4,
});

/** Why a known session no longer opens anything -- the stable reasons of `401 session-ended`. PHASE 3 FINAL adds
 *  `retired`: the session belongs to a LEGACY profile (one made before Authorization Wallets), which this build does not
 *  serve -- its owner makes a new account. */
export type SessionEndReason = "expired" | "rotated" | "unreadable" | "retired" | RevokeReason;

export type BootstrapOutcome =
  /** `principalId` is for the server's own use (the profile answer); it never goes on the wire. */
  | { kind: "ok"; created: boolean; rotated: boolean; expiresAt: number; setCookie: string | null; principalId: string; sessionId: string }
  | { kind: "ended"; reason: SessionEndReason }
  /** The grace budget refused a further successor (charged inside the queue, so concurrent requests cannot slip by). */
  | { kind: "rate-limited"; retryAfterMs: number }
  /** The store did not take a change this bootstrap needed; nothing changed. */
  | { kind: "unavailable" };

/** What a bootstrap would do, before it is queued -- so the caller can charge the right rate limit. */
export type BootstrapClass =
  | { kind: "create" }
  /** `grace`: a rotated session inside its 24 hours -- the bootstrap will mint a further successor. */
  | { kind: "existing"; sessionId: string; grace: boolean }
  | { kind: "ended"; reason: SessionEndReason };

export type UpgradeAuth =
  | { kind: "ok"; principalId: string; sessionId: string; sessionExpiresAt: number; provisional: boolean }
  | { kind: "refused"; why: "no-cookie" | "malformed" | "unknown" | "ended" };

export type SocketVerdict = "ok" | "expired" | "revoked";

export type CredentialOutcome =
  /** `sessionId` is the fresh session's (server-side only: never on the wire). */
  | { kind: "ok"; name: string; setCookie: string; principalId: string; sessionId: string }
  | { kind: "not-authenticated" }
  | { kind: "already-profiled" }
  /** LIVE-2E review (M2): this browser's principal is durable -- it played before profiles existed and may hold
   *  seats. Signing it in to another profile would orphan them; it must create its own profile to keep them. */
  | { kind: "has-tables" }
  /** One answer for every wrong, unknown, disabled or malformed credential: nothing says which. */
  | { kind: "invalid" }
  /** PHASE 3 FINAL: the RIGHT password of a LEGACY account (made before Authorization Wallets): this build does not sign
   *  it in. Said only to a holder of that password. */
  | { kind: "legacy-account" }
  | { kind: "unavailable" };

export type ProfileActionOutcome<T> =
  | ({ kind: "ok" } & T)
  | { kind: "not-authenticated" }
  | { kind: "profile-required" }
  /** ESCROW-3A: a sensitive action on a session that has not re-authenticated recently (the client asks for the
   *  password, `POST /gs/api/profile/reauth`, and retries). Says nothing else. */
  | { kind: "reauth-required" }
  | { kind: "unavailable" };

/** ESCROW-3A: the answer to a re-authentication. `expiresAt` is when the grant lapses (the client may say so). */
export type ReauthOutcome =
  | { kind: "ok"; expiresAt: number }
  | { kind: "not-authenticated" }
  | { kind: "profile-required" }
  /** The one answer for every wrong or missing password: nothing says which. */
  | { kind: "invalid" };

/** ESCROW-3A (F-2): whether a credential issued under (principal, family, credential epoch) still stands. The epoch is
 *  the profile's `recovery_selector` (`why: "recovery-key"` keeps its historical name: it means the epoch moved). */
export type SecurityStanding = { kind: "standing" } | { kind: "ended"; why: "principal" | "profile" | "family" | "recovery-key" };

/** What `POST /gs/api/session` may say about the account: a name, the username and a count, never an id. */
export interface AccountView {
  name: string;
  /** Other sessions (devices or browsers) of this profile that are signed in now. */
  otherSessions: number;
  /** PHASE 3 FINAL: the account's username -- told only to the account's own session (the bootstrap answers the cookie's
   *  holder alone). The page uses it to notice that THIS BROWSER's account changed under an open table (another tab
   *  signed in or out) and to ask, never to re-seat a table silently as someone else. */
  username: string;
}

/** What `POST /gs/api/account/me` tells the account's OWN session (never an id, a hash or a selector). */
export interface AccountDetails extends AccountView {
  /** PHASE 3 FINAL: the account's designated Authorization Wallet (its own sessions only: it is the wallet the owner
   *  needs to recover the account), and when it was designated. */
  authorizationWallet: { address: string; since: number };
  /** When the profile was created (epoch ms). */
  memberSince: number;
}

/* ==================================================================
    THE ANSWERS OF THE ACCOUNT OPERATIONS (none carries an id, a password or a hash)
   ================================================================== */

/** PHASE 3 FINAL: why an Authorization Wallet proof was refused. One answer for a signature that does not verify, a key
 *  of another wallet, or an operation that is unknown, expired, another session's or of another kind. */
export type AuthorizationProblem = "authorization-invalid" | "authorization-used";

export type CreateAccountOutcome =
  | { kind: "ok"; name: string; username: string; setCookie: string; principalId: string; sessionId: string }
  | { kind: "not-authenticated" }
  | { kind: "already-profiled"; name: string }
  | { kind: "bad-name" }
  | { kind: "bad-username" }
  | { kind: "bad-password"; problem: PasswordProblem }
  /** The username is taken. (Account creation necessarily says so; it is budgeted like every creation.) */
  | { kind: "username-taken" }
  /** The Authorization Wallet's proof is missing, invalid, of another username, or already used. */
  | { kind: AuthorizationProblem }
  /** Too many password computations at once: try again in a moment. */
  | { kind: "busy" }
  | { kind: "unavailable" };

export type LoginOutcome = CredentialOutcome | { kind: "busy" };

/** PHASE 3 FINAL: an Authorization Wallet text minted for this browser (the operation names it; the texts are what Keplr
 *  signs, in order). */
export type MintOutcome =
  | { kind: "ok"; operation: string; texts: readonly { purpose: string; signer: string; text: string }[]; expiresAt: number }
  | { kind: "not-authenticated" }
  | { kind: "already-profiled" }
  | { kind: "has-tables" }
  | { kind: "profile-required" }
  | { kind: "reauth-required" }
  | { kind: "bad-username" }
  | { kind: "bad-wallet" }
  | { kind: "username-taken" }
  /** REPLACE: the new wallet is the current one. */
  | { kind: "same-wallet" }
  /** Security review L2: the server holds as many live operations as it may; nobody's is evicted for this one. */
  | { kind: "busy" };

/** "Change password" (signed in): the CURRENT password, in the request (never a standing grant: a cookie stolen inside a
 *  sign-in's five minutes must not replace a credential). */
export type ChangePasswordOutcome =
  /** `setCookie`: THIS browser's fresh session (same family); `signedOut`: the other devices that were signed in. */
  | { kind: "ok"; setCookie: string; principalId: string; sessionId: string; signedOut: number }
  | { kind: "not-authenticated" }
  | { kind: "profile-required" }
  | { kind: "bad-password"; problem: PasswordProblem }
  /** The current password is wrong. */
  | { kind: "invalid" }
  | { kind: "busy" }
  | { kind: "unavailable" };

/** "Forgot password?" by the Authorization Wallet. */
export type RecoverAccountOutcome =
  /** This browser is signed in to the recovered account on a fresh session; `signedOut`: devices that were signed in. */
  | { kind: "ok"; name: string; setCookie: string; principalId: string; sessionId: string; signedOut: number }
  | { kind: "not-authenticated" }
  | { kind: "already-profiled" }
  | { kind: "has-tables" }
  | { kind: "bad-password"; problem: PasswordProblem }
  /** ONE answer for: the signature does not verify; the wallet is not that account's Authorization Wallet; the account
   *  does not exist, is disabled or legacy; the operation is unknown, expired or another browser's. Nothing says which. */
  | { kind: "invalid" }
  | { kind: "authorization-used" }
  | { kind: "busy" }
  | { kind: "unavailable" };

/** "Change Authorization Wallet". */
export type ReplaceWalletOutcome =
  | { kind: "ok"; authorizationWallet: { address: string; since: number } }
  | { kind: "not-authenticated" }
  | { kind: "profile-required" }
  | { kind: "reauth-required" }
  | { kind: AuthorizationProblem }
  /** The account's Authorization Wallet changed meanwhile (another replacement won). */
  | { kind: "stale" }
  | { kind: "unavailable" };

/** How a sensitive-auth grant was made. P3-ACCT POLICY: only an explicit "Confirm it's you" (`confirmed`) authorizes the
 *  highest-authority actions (PHASE 3 FINAL: beginning an Authorization Wallet replacement); the automatic grant of a
 *  sign-in (`sign-in`) still covers the other sensitive actions. Only a `confirmed` grant is written durably (OD-5-4 is
 *  about re-authentications): a sign-in's grant lives in this process's memory only, so every grant a restart reloads is
 *  a `confirmed` one -- honoured exactly as before, and the durable grant item's shape is unchanged. */
type GrantHow = "sign-in" | "confirmed";

/** P3-ACCT: a password as a LOGIN sends it: text of bounded size, NFKC (the creation-time minimum length is not applied
 *  here -- a sign-in never re-judges a password the account already has). `null`: not one. */
function loginPasswordOf(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > PASSWORD_MAX_BYTES) return null;
  /* Re-review N4: a lone surrogate never matches (it would collapse to U+FFFD in the KDF input -- an alias). */
  if (/\p{Cs}/u.test(raw)) return null;
  const password = raw.normalize("NFKC");
  return Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES ? null : password;
}

export interface IdentityHooks {
  /** Sessions that just ended for a SECURITY reason (logout, eviction, operator, principal disabled): their sockets
   *  close 4401. Called after the change is committed. */
  onSessionsEnded?: (sessionIds: readonly string[], principalId: string) => void;
  /** ESCROW-3A (F-2): a security event committed -- a family revoked (sign-out, sign-out-others, a password change or
   *  recovery, a replacement, a disabled principal). Financial credentials DERIVE their standing from identity
   *  (`securityStanding`), so nothing is lost if this is not observed; it lets their ledger record the revocation. */
  onSecurityEvent?: (event: { readonly kind: "family-revoked" | "principal-disabled"; readonly principalId: string; readonly familyIds: readonly string[] }) => void;
  /** A durable write could not be made (definite or unknown) -- surfaced to the window by the caller as well. */
  onStoreFailure?: (what: string, error: unknown) => void;
}

export interface IdentityStats {
  guestsCreated: number;
  rotations: number;
  graceRotations: number;
  revocations: number;
  evictions: number;
  activations: number;
  provisionalEvicted: number;
  storeFailures: number;
  writeBehindWrites: number;
  sessionsCollected: number;
  profilesCreated: number;
  credentialFailures: number;
  familiesRevoked: number;
  reauths: number;
  reauthFailures: number;
  reauthRequired: number;
  /** P3-ACCT */
  accountsCreated: number;
  logins: number;
  loginFailures: number;
  kdfBusy: number;
  /** P3-ACCT POLICY */
  passwordChanges: number;
  /** PHASE 3 FINAL: recoveries by the Authorization Wallet, Authorization Wallet replacements, refused proofs. */
  accountRecoveries: number;
  authorizationReplacements: number;
  authorizationFailures: number;
  /** PHASE 3 FINAL: sign-ins refused because the account is legacy (made before Authorization Wallets). */
  legacyRefusals: number;
}

/* ==================================================================
    LIVE-5 L5-4: THE DURABLE SECURITY SUBSTRATE (the DynamoDB path; absent on the file path, where nothing changes)
   ==================================================================
   JOURNAL FIRST (preflight §7.6): with a `journal`, each durable security change -- a profile created, a recovery key
   rotated, a family revoked by a sign-out, "Sign out other devices", a principal disabled -- is appended to the
   security-event journal BEFORE its identity change is written, inside the same serial task: from inside the store's
   commit, once every check the store makes before writing has passed (`beforeWrite`, review F2), so a change the store
   refuses first leaves no event. An append that fails (definitely, or with an unknown outcome) fails the action exactly
   as a store failure does, and the identity change is NOT written: no committed security change is ever missing from
   the journal. Once the change is committed, applied and answered, a `confirmed` event names it (best effort, appended
   by the queue before the next task: a slow ledger never delays the enforcement or the answer of a committed change,
   re-review N2 and R3-1); an event without one may be a phantom -- its change refused or unresolved after the append --
   which the replay rules of securityEvents.ts handle.
   DURABLE GRANTS (preflight §7.4, OD-5-4): with `grants`, a re-authentication is also written as a grant item, and
   `open` reloads the live ones, so a restart of the identity writer does not drop them. Honoured exactly as before --
   the session current, its family the grant's and open, the profile's selector unchanged, before `expires_at` -- so a
   stored grant never adds a capability. Best effort: a grant that could not be written stays in this process's memory
   (today's behaviour, reported through `onStoreFailure`); only its survival across a restart is lost. */
export interface IdentitySecuritySubstrate {
  readonly journal?: SecurityEventJournal;
  readonly grants?: SensitiveAuthGrantStore;
  /** The clock `open` judges stored grants by (default `Date.now`). */
  readonly clock?: () => number;
}

type EventDraft<E> = E extends unknown ? Omit<E, "format" | "version" | "event_id"> : never;
/** A security change's event as a flow states it; the service adds the format and a fresh event id (and appends its
 *  confirmation itself). */
export type SecurityEventDraft = EventDraft<Exclude<SecurityEvent, { readonly kind: "confirmed" }>>;

export interface IdentityServiceOptions {
  policy?: Partial<IdentityPolicy>;
  random?: RandomSource;
  hooks?: IdentityHooks;
  /** PHASE 3 FINAL: the app's display name, written into the Authorization Wallet texts (default: the build's). */
  appName?: string;
  /** LIVE-5 L5-4: the durable security substrate. Absent: exactly the pre-LIVE-5 behaviour. */
  security?: IdentitySecuritySubstrate;
}

export class IdentityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityUnavailableError";
  }
}

export class IdentityService {
  private readonly principals = new Map<string, Principal>();
  private readonly sessions = new Map<string, Session>();
  private readonly byPrincipal = new Map<string, Set<string>>();
  /** Provisional principals in least-recently-used order (a Map iterates in insertion order). */
  private readonly provisional = new Map<string, true>();
  /** Durable sessions whose `last_seen_at` moved and has not been written yet. */
  private readonly dirty = new Set<string>();
  /** LIVE-2E: profiles by id, and the two lookups -- a principal's profile, a recovery selector's profile. */
  private readonly profiles = new Map<string, Profile>();
  private readonly profileOfPrincipal = new Map<string, string>();
  private readonly profileOfSelector = new Map<string, string>();
  /** P3-ACCT: a username's canonical key -> its profile. A username never changes or goes, so nothing is removed. */
  private readonly profileOfLogin = new Map<string, string>();
  /** P3-ACCT: the bound on concurrent password KDF computations. */
  private readonly kdf: KdfGate;
  /** LIVE-2E: link codes by digest. PHASE 3 FINAL: no code is issued or redeemed any more ("Link another device" is
   *  retired with the recovery key); stored ones are still read, dropped with the account's security actions and swept
   *  when they expire. */
  private readonly links = new Map<string, LinkCredential>();
  /** PHASE 3 FINAL: the open Authorization Wallet operations (memory only; `authorizationWallet.ts`). */
  private readonly authorizations: AuthorizationBook;
  private queue: Promise<unknown> = Promise.resolve();
  readonly stats: IdentityStats = {
    guestsCreated: 0,
    rotations: 0,
    graceRotations: 0,
    revocations: 0,
    evictions: 0,
    activations: 0,
    provisionalEvicted: 0,
    storeFailures: 0,
    writeBehindWrites: 0,
    sessionsCollected: 0,
    profilesCreated: 0,
    credentialFailures: 0,
    familiesRevoked: 0,
    reauths: 0,
    reauthFailures: 0,
    reauthRequired: 0,
    accountsCreated: 0,
    logins: 0,
    loginFailures: 0,
    kdfBusy: 0,
    passwordChanges: 0,
    accountRecoveries: 0,
    authorizationReplacements: 0,
    authorizationFailures: 0,
    legacyRefusals: 0,
  };
  /** ESCROW-3A (IR-03): the session families (durable ones mirror the store; a provisional principal's live here). */
  private readonly families = new Map<string, SessionFamily>();
  /** ESCROW-3A (brief §10B): recent re-authentications, by SESSION. MEMORY ONLY, never persisted, never a secret: the
   *  grant names the family and the credential epoch it was made under, and lapses after `sensitiveAuthMs`. A restart
   *  forgets it (the player confirms again). LIVE-5: an item keyed by session with a TTL, checked in the same
   *  transaction as the action. */
  private readonly grants = new Map<string, { family_id: string; selector: string; expires_at: number; how: GrantHow }>();
  /** LIVE-5 L5-4: the security events this process has journaled. An event id is this count (32 bits) then 96 random
   *  bits, so the journal's order -- by time, then by id -- is this writer's own causal order even within one
   *  millisecond (the serial queue appends them in order). */
  private securityEvents = 0;
  /** Security changes committed by the running task, awaiting their confirmation (appended when the task ends). */
  private readonly unconfirmed: Array<{ readonly event: SecurityEvent; readonly what: string }> = [];

  private constructor(
    private readonly store: IdentityStore,
    readonly policy: IdentityPolicy,
    private readonly random: RandomSource,
    private readonly hooks: IdentityHooks,
    private readonly security: IdentitySecuritySubstrate,
    appName: string,
  ) {
    this.kdf = new KdfGate(policy.kdfConcurrency);
    this.authorizations = createAuthorizationBook({ appName, random: (size) => random(size) });
    /* Review N1: the unknown-username dummy hash is made now, not on the first such login. */
    void warmPasswordKdf(policy.passwordKdf);
  }

  /** Load what is durable. Throws (the server refuses to start) when the store cannot be read. LIVE-5 L5-4: with
   *  durable grants, the live grants of known sessions are reloaded too (OD-5-4; honoured only as `sensitiveAuthOf`
   *  judges them at the moment of use). */
  static async open(store: IdentityStore, options: IdentityServiceOptions = {}): Promise<IdentityService> {
    const service = IdentityService.fromSnapshot(store, await store.load(), options);
    const grants = options.security?.grants;
    if (grants !== undefined) {
      const at = (options.security?.clock ?? Date.now)();
      for (const grant of await grants.live(at)) {
        /* P3-ACCT POLICY: only "Confirm it's you" grants are ever stored (`recordGrant`), so a reloaded one is `confirmed`. */
        if (service.sessions.has(grant.session_id)) service.grants.set(grant.session_id, { family_id: grant.family_id, selector: grant.selector, expires_at: grant.expires_at, how: "confirmed" });
      }
    }
    return service;
  }

  /** Over a snapshot already loaded from `store` (an empty one for a fresh in-memory store). */
  static fromSnapshot(store: IdentityStore, snapshot: IdentitySnapshot, options: IdentityServiceOptions = {}): IdentityService {
    const service = new IdentityService(
      store,
      { ...DEFAULT_IDENTITY_POLICY, ...(options.policy ?? {}) },
      options.random ?? cryptoRandom,
      { ...(options.hooks ?? {}) },
      { ...(options.security ?? {}) },
      options.appName ?? APP_NAME,
    );
    for (const principal of snapshot.principals) service.principals.set(principal.principal_id, principal);
    for (const session of snapshot.sessions) service.index(session);
    for (const profile of snapshot.profiles ?? []) service.indexProfile(profile);
    for (const link of snapshot.links ?? []) service.links.set(link.link_hash, link);
    for (const family of snapshot.families ?? []) service.families.set(family.family_id, family);
    return service;
  }

  private indexProfile(profile: Profile): void {
    const previous = this.profiles.get(profile.profile_id);
    if (previous !== undefined && previous.recovery_selector !== profile.recovery_selector) this.profileOfSelector.delete(previous.recovery_selector);
    this.profiles.set(profile.profile_id, profile);
    this.profileOfPrincipal.set(profile.principal_id, profile.profile_id);
    this.profileOfSelector.set(profile.recovery_selector, profile.profile_id);
    const login = loginOf(profile);
    if (login !== null) this.profileOfLogin.set(login.key, profile.profile_id);
  }

  /** Late wiring: the server installs its socket-closing hook once it exists. */
  setHooks(hooks: IdentityHooks): void {
    Object.assign(this.hooks, hooks);
  }

  private index(session: Session): void {
    this.sessions.set(session.session_id, session);
    let set = this.byPrincipal.get(session.principal_id);
    if (set === undefined) {
      set = new Set();
      this.byPrincipal.set(session.principal_id, set);
    }
    set.add(session.session_id);
  }

  private forgetSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    this.dirty.delete(sessionId);
    const set = this.byPrincipal.get(session.principal_id);
    set?.delete(sessionId);
    if (set !== undefined && set.size === 0) this.byPrincipal.delete(session.principal_id);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    /* LIVE-5 L5-4 (re-review N2; round-3 review R3-1): the task applies its committed security changes itself -- in
       memory, their hooks fired -- and ITS ANSWER IS NOT HELD for their confirmations: a best-effort write must never
       delay, or past a client's timeout lose, the answer of a committed change (a key rotation's answer is the only copy
       of the new recovery key). The QUEUE waits for them instead: every confirmation is appended before the next task
       runs, so its id sorts before that task's own event. A slow ledger still slows the tasks queued behind, as the
       event's own append does. */
    this.queue = run.then(settledQuietly, settledQuietly).then(() => this.confirmCommitted()).catch(settledQuietly);
    return run;
  }

  /** Resolves once every task queued so far, and the confirmations it left, have finished. For tests, and for a
   *  graceful shutdown (L5-7: drain it before the process exits, so a committed change's confirmation is not dropped).
   *  Never await it from inside a queued task, or from anything a task awaits: the queue waits for that task (deadlock). */
  settled(): Promise<void> {
    return this.queue.then(settledQuietly, settledQuietly);
  }

  /** Append the confirmation of every change committed by the task that just ran. Best effort: it runs in the queue after
   *  that task's answer, and a failure is counted and reported, never thrown to any action's caller. */
  private async confirmCommitted(): Promise<void> {
    const journal = this.security.journal;
    while (this.unconfirmed.length > 0) {
      const { event, what } = this.unconfirmed.shift() as { event: SecurityEvent; what: string };
      if (journal === undefined) continue;
      try {
        await journal.append({
          format: SECURITY_EVENT_FORMAT,
          version: SECURITY_EVENT_VERSION,
          event_id: this.nextEventId(),
          kind: "confirmed",
          at: event.at,
          principal_id: event.principal_id,
          confirms: event.event_id,
          confirmed_kind: event.kind as SecurityChangeKind,
        });
      } catch (error) {
        /* The change is committed and applied, and the action succeeds: only the proof that it was is missing (a replay
           then reads the event as possibly a phantom, securityEvents.ts). */
        this.stats.storeFailures += 1;
        this.hooks.onStoreFailure?.(`${what}: its security event's confirmation`, error);
      }
    }
  }

  private isDurable(principalId: string): boolean {
    return (this.principals.get(principalId)?.activated_at ?? null) !== null;
  }

  isProvisional(principalId: string): boolean {
    const principal = this.principals.get(principalId);
    return principal !== undefined && principal.activated_at === null;
  }

  /** A fresh event id: this writer's count (32 bits), then 96 random bits. */
  private nextEventId(): string {
    const id = `${(this.securityEvents % 0x1_0000_0000).toString(16).padStart(8, "0")}${this.random(12).toString("hex")}`;
    this.securityEvents += 1;
    return id;
  }

  /** Write a change for a durable principal; a failure is counted, reported and rethrown. LIVE-5 L5-4: a security
   *  change's `event` is appended to the security-event journal FIRST (when one is configured) -- from inside the
   *  store's commit, once the store's own checks have passed (review F2: a change the store refuses first leaves no
   *  event) -- and an append that fails fails the change before anything is written. Once the change is committed, its
   *  confirmation is appended by the queue after the running task has applied it and answered (best effort; N2, R3-1). */
  private async commit(change: IdentityChange, what: string, event?: SecurityEventDraft): Promise<void> {
    const journal = this.security.journal;
    if (event === undefined || journal === undefined) {
      try {
        await this.store.commit(change);
      } catch (error) {
        this.stats.storeFailures += 1;
        this.hooks.onStoreFailure?.(what, error);
        throw error;
      }
      return;
    }
    const recorded = { format: SECURITY_EVENT_FORMAT, version: SECURITY_EVENT_VERSION, event_id: this.nextEventId(), ...event } as SecurityEvent;
    let appended = false;
    let appendError: { readonly error: unknown } | null = null;
    const beforeWrite = async (): Promise<void> => {
      if (appended) return; // exactly once, whatever the store does
      try {
        await journal.append(recorded);
      } catch (error) {
        appendError = { error };
        throw error;
      }
      appended = true;
    };
    try {
      await this.store.commit(change, { beforeWrite });
    } catch (error) {
      this.stats.storeFailures += 1;
      const failed = appendError as { readonly error: unknown } | null;
      this.hooks.onStoreFailure?.(failed !== null && failed.error === error ? `${what}: its security event` : what, error);
      throw error;
    }
    if (!appended) {
      /* A store that committed without calling `beforeWrite` broke the port (every store in this repository calls it;
         conformance ID-20). The change is committed: its event is appended now rather than never, and that is reported. */
      this.stats.storeFailures += 1;
      this.hooks.onStoreFailure?.(`${what}: the store committed without its security event first`, new Error("the identity store did not call beforeWrite"));
      try {
        await journal.append(recorded);
      } catch (error) {
        this.stats.storeFailures += 1;
        this.hooks.onStoreFailure?.(`${what}: its security event`, error);
        return;
      }
    }
    /* Confirmed after the task that committed it has applied it and answered (`serial`, re-review N2, R3-1). */
    this.unconfirmed.push({ event: recorded, what });
  }

  private expiresAt(created: number, lastSeen: number): number {
    return Math.min(lastSeen + this.policy.idleMs, created + this.policy.absoluteMs);
  }

  /** A new session. `familyId` is the lineage it joins (a rotation or grace successor); `null` founds a new family,
   *  returned as `founded` (named after this session: `familyIdOf`). */
  private mintSession(
    principalId: string,
    now: number,
    familyId: string | null = null,
    origin: SessionFamily["origin"] = "bootstrap",
  ): { session: Session; secret: string; founded: SessionFamily | null } {
    const sessionId = mintUnique(() => mintSessionId(this.random), (id) => this.sessions.has(id));
    const secret = mintSecret(this.random);
    const family_id = familyId ?? familyIdOf(sessionId);
    return {
      secret,
      founded: familyId === null ? { family_id, principal_id: principalId, created_at: now, origin, revoked_at: null, revoke_reason: null } : null,
      session: {
        session_id: sessionId,
        principal_id: principalId,
        secret_hash: secretHash(secret),
        created_at: now,
        last_seen_at: now,
        expires_at: this.expiresAt(now, now),
        revoked_at: null,
        revoke_reason: null,
        rotated_to: null,
        family_id,
      },
    };
  }

  /* ==================================================================
      ESCROW-3A (IR-03): FAMILIES
     ================================================================== */

  /** Whether a session's family has been revoked (a sign-out, sign-out-others, a replacement, a disabled principal). */
  private familyRevoked(session: Session): boolean {
    return (this.families.get(session.family_id)?.revoked_at ?? null) !== null;
  }

  /** The families of these sessions that are still open, revoked for `reason` (records to write and to apply). */
  private revokedFamilies(familyIds: Iterable<string>, reason: RevokeReason, now: number): SessionFamily[] {
    const out: SessionFamily[] = [];
    for (const id of new Set(familyIds)) {
      const family = this.families.get(id);
      if (family !== undefined && family.revoked_at === null) out.push({ ...family, revoked_at: now, revoke_reason: reason });
    }
    return out;
  }

  /** Every member of these families that is not yet security-revoked, revoked for `reason`. */
  private membersOf(principalId: string, familyIds: ReadonlySet<string>, reason: RevokeReason, now: number, except: ReadonlySet<string> = new Set()): Session[] {
    return [...(this.byPrincipal.get(principalId) ?? [])]
      .map((id) => this.sessions.get(id) as Session)
      .filter((session) => familyIds.has(session.family_id) && !except.has(session.session_id) && !isSecurityRevocation(session.revoke_reason))
      .map((session) => ({ ...session, revoked_at: now, revoke_reason: reason }));
  }

  /** Apply committed family records (and forget the grants of their sessions). */
  private applyFamilies(records: readonly SessionFamily[]): void {
    for (const family of records) this.families.set(family.family_id, family);
    if (records.length === 0) return;
    const closed = new Set(records.filter((family) => family.revoked_at !== null).map((family) => family.family_id));
    for (const [sessionId, grant] of this.grants) if (closed.has(grant.family_id)) this.grants.delete(sessionId);
    this.stats.familiesRevoked += closed.size;
  }

  private familiesOfPrincipal(principalId: string): SessionFamily[] {
    const ids = new Set([...(this.byPrincipal.get(principalId) ?? [])].map((id) => (this.sessions.get(id) as Session).family_id));
    return [...ids].map((id) => this.families.get(id)).filter((family): family is SessionFamily => family !== undefined);
  }

  private touchProvisional(principalId: string): void {
    if (!this.provisional.has(principalId)) return;
    this.provisional.delete(principalId);
    this.provisional.set(principalId, true);
  }

  /** What a bootstrap presenting `read` (and `fresh`) would do. Synchronous, and repeated inside the queue. */
  classify(read: SessionCookieRead, fresh: boolean, now: number): BootstrapClass {
    if (fresh || read.kind === "none") return { kind: "create" };
    if (read.kind === "malformed") return { kind: "ended", reason: "unreadable" };
    const session = this.sessions.get(read.sessionId);
    if (session === undefined) return { kind: "create" }; // an unknown selector: a restart forgot a guest who owned nothing
    if (!secretMatches(read.secret, session.secret_hash)) return { kind: "ended", reason: "unreadable" };
    const principal = this.principals.get(session.principal_id);
    if (principal === undefined) return { kind: "ended", reason: "unreadable" };
    if (principal.status === "disabled") return { kind: "ended", reason: "principal-disabled" };
    /* PHASE 3 FINAL: a legacy profile (no Authorization Wallet) is retired -- its sessions end; its owner makes a new
       account (the explicit "Continue" bootstraps a fresh, signed-out session). */
    if (this.retired(principal)) return { kind: "ended", reason: "retired" };
    /* ESCROW-3A (IR-03): a member of a revoked family has ended, whatever its own record says -- a grace successor minted
       from it would be minted into a family a committed sign-out has closed. */
    const family = this.families.get(session.family_id);
    if (family !== undefined && family.revoked_at !== null) return { kind: "ended", reason: family.revoke_reason ?? "logout" };
    if (session.revoke_reason === "rotated") {
      return now - (session.revoked_at ?? 0) < this.policy.rotatedGraceMs
        ? { kind: "existing", sessionId: session.session_id, grace: true }
        : { kind: "ended", reason: "rotated" };
    }
    if (session.revoke_reason !== null) return { kind: "ended", reason: session.revoke_reason };
    if (now >= session.expires_at) return { kind: "ended", reason: "expired" };
    return { kind: "existing", sessionId: session.session_id, grace: false };
  }

  /** `POST /gs/api/session` (LIVE-2 §4.1). `graceBudget` charges a grace successor to its principal INSIDE the queue
   *  (0 = granted, else the wait): a check made before queueing would let a burst of concurrent requests -- each
   *  classified before the first one rotated -- all mint (LIVE-2B adversarial review). */
  bootstrap(
    read: SessionCookieRead,
    fresh: boolean,
    now: number,
    options: { graceBudget?: (principalId: string) => number } = {},
  ): Promise<BootstrapOutcome> {
    return this.serial(async () => {
      const decided = this.classify(read, fresh, now);
      if (decided.kind === "ended") return decided;
      if (decided.kind === "create") return this.createGuest(now);
      const session = this.sessions.get(decided.sessionId) as Session;
      const grace = session.revoke_reason === "rotated";
      if (grace) {
        const wait = options.graceBudget?.(session.principal_id) ?? 0;
        if (wait > 0) return { kind: "rate-limited", retryAfterMs: wait };
      }
      if (grace || now - session.created_at > this.policy.rotateAfterMs) {
        try {
          return await this.rotate(session, now, grace);
        } catch {
          return { kind: "unavailable" };
        }
      }
      this.touch(session, now);
      return {
        kind: "ok",
        created: false,
        rotated: false,
        expiresAt: (this.sessions.get(session.session_id) as Session).expires_at,
        setCookie: null,
        principalId: session.principal_id,
        sessionId: session.session_id,
      };
    });
  }

  private createGuest(now: number): BootstrapOutcome {
    const principalId = mintUnique(() => mintPrincipalId(this.random), (id) => this.principals.has(id));
    const principal: Principal = {
      principal_id: principalId,
      kind: "unprofiled",
      status: "active",
      created_at: now,
      activated_at: null,
      last_seen_at: now,
      account_link: null,
    };
    const { session, secret, founded } = this.mintSession(principalId, now);
    this.principals.set(principalId, principal);
    this.index(session);
    if (founded !== null) this.families.set(founded.family_id, founded); // memory only, like the provisional session
    this.provisional.set(principalId, true);
    this.stats.guestsCreated += 1;
    /* THE LRU BOUND (§3.3): the least recently used provisional guest is forgotten -- memory only, never a write. */
    while (this.provisional.size > this.policy.provisionalLimit) {
      const oldest = this.provisional.keys().next().value as string;
      this.provisional.delete(oldest);
      for (const id of [...(this.byPrincipal.get(oldest) ?? [])]) {
        const family = (this.sessions.get(id) as Session | undefined)?.family_id;
        this.forgetSession(id);
        if (family !== undefined) this.families.delete(family);
      }
      this.principals.delete(oldest);
      this.stats.provisionalEvicted += 1;
    }
    return {
      kind: "ok",
      created: true,
      rotated: false,
      expiresAt: session.expires_at,
      setCookie: sessionSetCookie(session.session_id, secret),
      principalId,
      sessionId: session.session_id,
    };
  }

  /** Active = not revoked (rotation included) and not expired. */
  private activeSessions(principalId: string, now: number): Session[] {
    return [...(this.byPrincipal.get(principalId) ?? [])]
      .map((id) => this.sessions.get(id) as Session)
      .filter((session) => session.revoked_at === null && now < session.expires_at);
  }

  /** §4.5 rotation, and the 24-hour grace path, which mints a further successor from an already-rotated session. */
  private async rotate(old: Session, now: number, grace: boolean): Promise<BootstrapOutcome> {
    const principalId = old.principal_id;
    /* ESCROW-3A (IR-03): a rotation or grace successor joins the lineage it was minted from. */
    const { session: successor, secret } = this.mintSession(principalId, now, old.family_id);
    const retired: Session = grace ? old : { ...old, revoked_at: now, revoke_reason: "rotated", rotated_to: successor.session_id };
    /* §4.7: at most 10 active sessions; the oldest beyond that is evicted, and its sockets close 4401. */
    const active = this.activeSessions(principalId, now).filter((session) => session.session_id !== old.session_id);
    const overflow = active.length + 1 - this.policy.maxActiveSessions;
    const evicted: Session[] =
      overflow > 0
        ? active
            .sort((a, b) => a.created_at - b.created_at || (a.session_id < b.session_id ? -1 : 1))
            .slice(0, overflow)
            .map((session) => ({ ...session, revoked_at: now, revoke_reason: "evicted" as const }))
        : [];
    if (this.isDurable(principalId)) {
      await this.commit(
        {
          /* LIVE-3C: only an OPEN session rotates (a logout that committed first wins), into an unused id. */
          expect: [
            { kind: "session-open", session_id: old.session_id },
            /* ESCROW-3A (IR-03): and only into an OPEN family -- a sign-out committed first closes it for every sibling. */
            { kind: "family-open", family_id: old.family_id },
            { kind: "session-absent", session_id: successor.session_id },
            ...evicted.map((session) => ({ kind: "session-open" as const, session_id: session.session_id })),
          ],
          sessions: [retired, successor, ...evicted],
        },
        "a session rotation",
      );
    }
    this.index(retired);
    this.index(successor);
    for (const session of evicted) this.index(session);
    this.touchProvisional(principalId);
    this.stats.rotations += 1;
    if (grace) this.stats.graceRotations += 1;
    this.stats.evictions += evicted.length;
    if (evicted.length > 0) {
      this.stats.revocations += evicted.length;
      this.hooks.onSessionsEnded?.(
        evicted.map((session) => session.session_id),
        principalId,
      );
    }
    return {
      kind: "ok",
      created: false,
      rotated: true,
      expiresAt: successor.expires_at,
      setCookie: sessionSetCookie(successor.session_id, secret),
      principalId,
      sessionId: successor.session_id,
    };
  }

  /** §4.5 write-behind: `last_seen_at` moves at most once per 15 minutes; a durable session is marked for the sweep. */
  private touch(session: Session, now: number): void {
    this.touchProvisional(session.principal_id);
    if (now - session.last_seen_at < this.policy.lastSeenWriteMs) return;
    const seen: Session = { ...session, last_seen_at: now, expires_at: this.expiresAt(session.created_at, now) };
    this.sessions.set(session.session_id, seen);
    const principal = this.principals.get(session.principal_id);
    if (principal !== undefined) this.principals.set(principal.principal_id, { ...principal, last_seen_at: now });
    if (this.isDurable(session.principal_id)) this.dirty.add(session.session_id);
  }

  /** LIVE-2 §4.3 step 5: a socket is opened only by a CURRENT session -- never a rotated one, never an ended one. */
  authenticate(read: SessionCookieRead, now: number): UpgradeAuth {
    if (read.kind === "none") return { kind: "refused", why: "no-cookie" };
    if (read.kind === "malformed") return { kind: "refused", why: "malformed" };
    const session = this.sessions.get(read.sessionId);
    if (session === undefined || !secretMatches(read.secret, session.secret_hash)) return { kind: "refused", why: "unknown" };
    const principal = this.principals.get(session.principal_id);
    if (principal === undefined || principal.status !== "active" || this.retired(principal)) return { kind: "refused", why: "ended" };
    if (session.revoked_at !== null || now >= session.expires_at) return { kind: "refused", why: "ended" };
    if (this.familyRevoked(session)) return { kind: "refused", why: "ended" };
    this.touch(session, now);
    const current = this.sessions.get(session.session_id) as Session;
    return {
      kind: "ok",
      principalId: principal.principal_id,
      sessionId: current.session_id,
      sessionExpiresAt: current.expires_at,
      provisional: principal.activated_at === null,
    };
  }

  /** The per-frame check (§4.4): expired by the socket's own frozen expiry, or security-revoked since. */
  socketVerdict(ctx: { principalId: string; sessionId: string; sessionExpiresAt: number }, now: number): SocketVerdict {
    if (now >= ctx.sessionExpiresAt) return "expired";
    const session = this.sessions.get(ctx.sessionId);
    if (session !== undefined && (isSecurityRevocation(session.revoke_reason) || this.familyRevoked(session))) return "revoked";
    const principal = this.principals.get(ctx.principalId);
    if (principal !== undefined && principal.status !== "active") return "revoked";
    /* PHASE 3 FINAL: no `retired` rule here on purpose -- a retired (legacy) account's socket cannot exist (its upgrade is
       refused, `authenticate`), and this per-frame check stays the session's security state alone. The non-primary
       verifier's re-check is stricter (it reads the profile anyway) -- stricter, never looser. */
    return "ok";
  }

  /** The session a revoke request authenticates with: current, not rotated, not ended. */
  currentSession(read: SessionCookieRead, now: number): string | null {
    const auth = this.authenticate(read, now);
    return auth.kind === "ok" ? auth.sessionId : null;
  }

  /** LIVE-2F/3D (C1-03b): the session "Sign out this device" ends -- the current one, or a rotated one still inside its
   *  grace (a browser that lost the rotation's Set-Cookie still holds it, and it can still bootstrap a successor: a
   *  sign-out that answered 401 would leave that browser signed in). `revoke` then ends its successors too. */
  revocableSession(read: SessionCookieRead, now: number): string | null {
    const current = this.currentSession(read, now);
    if (current !== null) return current;
    const decided = this.classify(read, false, now);
    return decided.kind === "existing" && decided.grace ? decided.sessionId : null;
  }

  /** A security revocation (logout, operator). Durable first for an activated principal; its sockets close 4401.
   *
   *  THE PRINCIPAL'S ROTATED PREDECESSORS END WITH IT (LIVE-2B adversarial review): otherwise the cookie that was
   *  rotated into the revoked one could still bootstrap a fresh successor for 24 hours -- a logout undone by an older
   *  cookie -- and a socket opened on it before the rotation would stay open.
   *  LIVE-2F/3D (C1-01): WHATEVER THEIR AGE. A rotation is not a security revocation, so a socket opened on a session
   *  before it rotated stays open for as long as that socket's own frozen expiry (up to 30 days) -- a long-lived tab
   *  that kept acting as the seat after "Sign out this device" once its session's rotation was more than a day old.
   *  Every rotated session of the principal ends now (a grace successor is not linked to its predecessor, so no
   *  narrower family can be read off the records); another device's pre-rotation socket is closed 4401 and reopens on
   *  its own current cookie.
   *  LIVE-2F/3D (C1-03a): AND ITS SUCCESSORS, when the revoked session itself was rotated while the revoke waited in
   *  the queue (another tab of the same browser bootstrapped it): the successor that rotation minted belongs to the
   *  same cookie jar, and a logout that answered 204 must not leave it live. */
  revoke(sessionId: string, reason: Exclude<RevokeReason, "rotated" | "principal-disabled">, now: number): Promise<boolean> {
    return this.serial(async () => {
      const session = this.sessions.get(sessionId);
      if (session === undefined || isSecurityRevocation(session.revoke_reason)) return false;
      const revoked: Session = { ...session, revoked_at: now, revoke_reason: reason };
      const predecessors: Session[] = [...(this.byPrincipal.get(session.principal_id) ?? [])]
        .map((id) => this.sessions.get(id) as Session)
        .filter((other) => other.session_id !== sessionId && other.revoke_reason === "rotated")
        .map((other) => ({ ...other, revoked_at: now, revoke_reason: reason }));
      const successors: Session[] = [];
      const seen = new Set<string>([sessionId, ...predecessors.map((other) => other.session_id)]);
      for (let next = session.rotated_to; next !== null && !seen.has(next); ) {
        seen.add(next);
        const successor = this.sessions.get(next);
        if (successor === undefined) break;
        if (!isSecurityRevocation(successor.revoke_reason)) successors.push({ ...successor, revoked_at: now, revoke_reason: reason });
        next = successor.rotated_to;
      }
      /* ESCROW-3A (IR-03): THE WHOLE FAMILY -- the family record closed, and every member of it that the walks above did
         not reach (a grace successor minted from an older member is linked by nothing else). One write: a mint racing
         it either committed first (and is a member here) or finds the family closed (`family-open` fails). */
      const walked = new Set(seen);
      const members = this.membersOf(session.principal_id, new Set([session.family_id]), reason, now, walked);
      const families = this.revokedFamilies([session.family_id], reason, now);
      const ended = [revoked, ...predecessors, ...successors, ...members];
      /* LIVE-2E (review H1): a signed-out device's profile keeps no outstanding link code. */
      const profileId = this.principals.get(session.principal_id)?.account_link ?? null;
      const dropLinks = profileId === null ? [] : this.linkHashesOf(profileId);
      if (this.isDurable(session.principal_id)) {
        await this.commit(
          {
            expect: [
              ...ended.map((record) => ({ kind: "session-open" as const, session_id: record.session_id })),
              ...families.map((family) => ({ kind: "family-open" as const, family_id: family.family_id })),
            ],
            sessions: ended,
            families,
            dropLinks,
          },
          `a session revocation (${reason})`,
          families.length > 0 ? { kind: "family-revoked", at: now, principal_id: session.principal_id, family_ids: familyList(families.map((family) => family.family_id)), reason } : undefined,
        );
      }
      this.forgetLinks(dropLinks);
      for (const record of ended) {
        this.index(record);
        this.dirty.delete(record.session_id);
        this.grants.delete(record.session_id);
      }
      this.applyFamilies(families);
      this.stats.revocations += ended.length;
      this.hooks.onSessionsEnded?.(
        ended.map((record) => record.session_id),
        session.principal_id,
      );
      if (families.length > 0) this.hooks.onSecurityEvent?.({ kind: "family-revoked", principalId: session.principal_id, familyIds: families.map((family) => family.family_id) });
      return true;
    });
  }

  /** Operator: disable a principal -- every session `principal-disabled`, every socket 4401 (§4.6). */
  disablePrincipal(principalId: string, now: number): Promise<boolean> {
    return this.serial(async () => {
      const principal = this.principals.get(principalId);
      if (principal === undefined || principal.status === "disabled") return false;
      const disabled: Principal = { ...principal, status: "disabled" };
      const ended = [...(this.byPrincipal.get(principalId) ?? [])]
        .map((id) => this.sessions.get(id) as Session)
        .filter((session) => !isSecurityRevocation(session.revoke_reason))
        .map((session) => ({
          ...session,
          revoked_at: now,
          revoke_reason: "principal-disabled" as const,
        }));
      const families = this.revokedFamilies(
        this.familiesOfPrincipal(principalId).map((family) => family.family_id),
        "principal-disabled",
        now,
      );
      if (this.isDurable(principalId)) {
        await this.commit(
          {
            expect: ended.map((session) => ({ kind: "session-open" as const, session_id: session.session_id })),
            principals: [disabled],
            sessions: ended,
            families,
          },
          "disabling a principal",
          { kind: "principal-disabled", at: now, principal_id: principalId, family_ids: familyList(families.map((family) => family.family_id)) },
        );
      }
      this.principals.set(principalId, disabled);
      for (const session of ended) {
        this.index(session);
        this.grants.delete(session.session_id);
      }
      this.applyFamilies(families);
      if (families.length > 0) this.hooks.onSecurityEvent?.({ kind: "principal-disabled", principalId, familyIds: families.map((family) => family.family_id) });
      this.stats.revocations += ended.length;
      this.hooks.onSessionsEnded?.(
        ended.map((session) => session.session_id),
        principalId,
      );
      return true;
    });
  }

  /* ==================================================================
      THE ACCOUNT: ONE PROFILE PER PRINCIPAL, SIGNED IN BY USERNAME + PASSWORD, OWNED BY ITS AUTHORIZATION WALLET
     ==================================================================
     PHASE 3 FINAL (owner ruling 2026-10-06): THE PROFILE / ACCOUNT IS THE PLAYER. A profile binds the principal that
     created it, for good; every seat names that principal; a wallet never names, selects or switches either one.
     Sign-in authenticates the PROFILE and issues a fresh, ordinary session for ITS principal -- the principal every
     seat already names -- so another device has the same seats with nothing copied, transferred or reassigned. The
     browser's temporary session is revoked `replaced` in the same durable commit (session fixation: whatever that cookie
     was, it opens nothing now). Every change is written before it is applied; a store failure answers `unavailable` and
     changes nothing.
     THE RECOVERY KEY IS GONE (it was LIVE-2E's sign-in and caad745's account-recovery credential): no account gets one,
     shows one, saves one or uses one. "Link another device" codes are gone with it (a second device logs in). A LEGACY
     profile -- schema 1 or 2, made before Authorization Wallets -- is RETIRED: it is not signed in, its sessions end
     (`retired`), and its owner makes a new account (owner ruling: legacy profiles were disposable test profiles; no
     migration). */

  /** PHASE 3 FINAL: a principal bound to a LEGACY profile (one without an Authorization Wallet): retired. */
  private retired(principal: Principal): boolean {
    if (principal.kind !== "profile") return false;
    const profile = this.profiles.get(principal.account_link as string);
    return profile !== undefined && profile.schema !== 3;
  }

  /** The profile a principal belongs to, when it has one, both are active, and it is an Authorization Wallet account. */
  private activeProfileOf(principalId: string): Profile | null {
    const principal = this.principals.get(principalId);
    if (principal === undefined || principal.status !== "active" || principal.kind !== "profile") return null;
    const profile = this.profiles.get(principal.account_link as string);
    return profile !== undefined && profile.status === "active" && profile.schema === 3 ? profile : null;
  }

  /** LIVE-2E: may this principal use the hosted game at all? Only a profiled, active one. (A development principal
   *  has no record here; the server answers for those from the mode.) */
  isProfiled(principalId: string): boolean {
    return this.activeProfileOf(principalId) !== null;
  }

  /** The profile's display name, for seeding a room nickname. Presentation only -- never an authority key. */
  profileName(principalId: string): string | null {
    return this.activeProfileOf(principalId)?.display_name ?? null;
  }

  /** What the bootstrap may tell this session about its account. */
  accountView(principalId: string, sessionId: string, now: number): AccountView | null {
    const profile = this.activeProfileOf(principalId);
    if (profile === null) return null;
    const otherSessions = this.activeSessions(principalId, now).filter((session) => session.session_id !== sessionId).length;
    return { name: profile.display_name, otherSessions, username: loginOf(profile)?.name ?? "" };
  }

  /** The account's own details (its username, its Authorization Wallet, when it was made). */
  accountDetails(read: SessionCookieRead, now: number): AccountDetails | null {
    const who = this.profiledCurrent(read, now);
    if (typeof who === "string") return null;
    const view = this.accountView(who.session.principal_id, who.session.session_id, now) as AccountView;
    const login = loginOf(who.profile);
    const authority = authorizationWalletOf(who.profile);
    if (login === null || authority === null) return null; // never: a schema-3 profile holds both
    return { ...view, authorizationWallet: { address: authority.address, since: authority.since }, memberSince: who.profile.created_at };
  }

  /** The current session a profile request authenticates with (never a rotated, ended or retired one), without touching. */
  private currentOf(read: SessionCookieRead, now: number): Session | null {
    if (read.kind !== "session") return null;
    const session = this.sessions.get(read.sessionId);
    if (session === undefined || !secretMatches(read.secret, session.secret_hash)) return null;
    const principal = this.principals.get(session.principal_id);
    if (principal === undefined || principal.status !== "active" || this.retired(principal)) return null;
    if (session.revoked_at !== null || now >= session.expires_at) return null;
    if (this.familyRevoked(session)) return null;
    return session;
  }

  /** A fresh session for `profile`'s principal, replacing `old` (this browser's temporary session). Inside the queue. */
  private async issueFor(profile: Profile, old: Session, now: number, extra: IdentityChange, origin: "recovery" | "login"): Promise<CredentialOutcome> {
    const principalId = profile.principal_id;
    /* A signed-in or recovered browser FOUNDS a family: it is a new cookie jar, not a successor of any other device. */
    const { session: fresh, secret, founded } = this.mintSession(principalId, now, null, origin);
    const active = this.activeSessions(principalId, now);
    const overflow = active.length + 1 - this.policy.maxActiveSessions;
    const evicted: Session[] =
      overflow > 0
        ? active
            .sort((a, b) => a.created_at - b.created_at || (a.session_id < b.session_id ? -1 : 1))
            .slice(0, overflow)
            .map((session) => ({ ...session, revoked_at: now, revoke_reason: "evicted" as const }))
        : [];
    /* The replaced session and its rotated predecessors still in their grace: none of them may bootstrap again. */
    const replaced: Session[] = [old, ...this.graceSessionsOf(old.principal_id, old.session_id, now)].map((session) => ({
      ...session,
      revoked_at: now,
      revoke_reason: "replaced" as const,
    }));
    const oldDurable = this.isDurable(old.principal_id);
    /* The replaced browser's family ends with it (only a durable one is written; a provisional one lives in memory). */
    const replacedFamilies = this.revokedFamilies([old.family_id], "replaced", now);
    const newFamilies = founded === null ? [] : [founded];
    try {
      await this.commit(
        {
          ...extra,
          expect: [
            ...(extra.expect ?? []),
            { kind: "session-absent", session_id: fresh.session_id },
            ...newFamilies.map((family) => ({ kind: "family-absent" as const, family_id: family.family_id })),
            ...[...evicted, ...(oldDurable ? replaced : [])].map((session) => ({ kind: "session-open" as const, session_id: session.session_id })),
          ],
          sessions: [fresh, ...evicted, ...(oldDurable ? replaced : [])],
          families: [...newFamilies, ...(oldDurable ? replacedFamilies : [])],
        },
        "signing a browser in to a profile",
      );
    } catch {
      return { kind: "unavailable" };
    }
    this.applyFamilies([...newFamilies, ...replacedFamilies]);
    this.index(fresh);
    for (const session of [...evicted, ...replaced]) {
      this.index(session);
      this.dirty.delete(session.session_id);
    }
    this.stats.evictions += evicted.length;
    this.stats.revocations += evicted.length + replaced.length;
    this.hooks.onSessionsEnded?.(
      replaced.map((session) => session.session_id),
      old.principal_id,
    );
    if (evicted.length > 0) {
      this.hooks.onSessionsEnded?.(
        evicted.map((session) => session.session_id),
        principalId,
      );
    }
    return { kind: "ok", name: profile.display_name, setCookie: sessionSetCookie(fresh.session_id, secret), principalId, sessionId: fresh.session_id };
  }

  /** LIVE-2E adversarial review (H1): every link code of a profile, used or not -- dropped whenever the account is being
   *  secured. PHASE 3 FINAL: no code is issued any more; a stored one is still dropped here. */
  private linkHashesOf(profileId: string): string[] {
    return [...this.links.values()].filter((link) => link.profile_id === profileId).map((link) => link.link_hash);
  }

  private forgetLinks(hashes: readonly string[]): void {
    for (const hash of hashes) this.links.delete(hash);
  }

  /** A principal's rotated sessions still inside their grace (other than `except`). */
  private graceSessionsOf(principalId: string, except: string, now: number): Session[] {
    return [...(this.byPrincipal.get(principalId) ?? [])]
      .map((id) => this.sessions.get(id) as Session)
      .filter((other) => other.session_id !== except && other.revoke_reason === "rotated" && now - (other.revoked_at ?? 0) < this.policy.rotatedGraceMs);
  }

  /** The profiled current session a profile action needs, or why not. */
  private profiledCurrent(read: SessionCookieRead, now: number): { session: Session; profile: Profile } | "not-authenticated" | "profile-required" {
    const session = this.currentOf(read, now);
    if (session === null) return "not-authenticated";
    const profile = this.activeProfileOf(session.principal_id);
    return profile === null ? "profile-required" : { session, profile };
  }

  /** "Sign out other devices": every other session of this principal ends `signed-out-remotely` (their sockets close
   *  4401); this one stays. Nothing about the profile, its Authorization Wallet or its seats changes. */
  signOutOthers(read: SessionCookieRead, now: number): Promise<ProfileActionOutcome<{ signedOut: number }>> {
    return this.serial(async () => {
      const who = this.profiledCurrent(read, now);
      if (typeof who === "string") return { kind: who };
      if (!this.sensitiveAuthOf(who.session, who.profile, now)) {
        this.stats.reauthRequired += 1;
        return { kind: "reauth-required" as const };
      }
      const principalId = who.session.principal_id;
      const others = [...(this.byPrincipal.get(principalId) ?? [])]
        .map((id) => this.sessions.get(id) as Session)
        .filter((session) => session.session_id !== who.session.session_id && !isSecurityRevocation(session.revoke_reason));
      const wasActive = others.filter((session) => session.revoked_at === null && now < session.expires_at).length;
      const dropLinks = this.linkHashesOf(who.profile.profile_id);
      /* ESCROW-3A (IR-03): every OTHER family is closed too, so no grace successor can be minted into one afterwards. */
      const families = this.revokedFamilies(
        this.familiesOfPrincipal(principalId)
          .map((family) => family.family_id)
          .filter((id) => id !== who.session.family_id),
        "signed-out-remotely",
        now,
      );
      if (others.length === 0 && dropLinks.length === 0 && families.length === 0) return { kind: "ok" as const, signedOut: 0 };
      const ended = others.map((session) => ({ ...session, revoked_at: now, revoke_reason: "signed-out-remotely" as const }));
      try {
        await this.commit(
          {
            expect: [
              ...ended.map((session) => ({ kind: "session-open" as const, session_id: session.session_id })),
              ...families.map((family) => ({ kind: "family-open" as const, family_id: family.family_id })),
              /* The caller's own family must still be open (its sign-out may have committed while this waited). */
              { kind: "family-open" as const, family_id: who.session.family_id },
            ],
            sessions: ended,
            families,
            dropLinks,
          },
          "signing out other devices",
          { kind: "signed-out-others", at: now, principal_id: principalId, kept_family_id: who.session.family_id, family_ids: familyList(families.map((family) => family.family_id)) },
        );
      } catch {
        return { kind: "unavailable" as const };
      }
      this.forgetLinks(dropLinks);
      for (const session of ended) {
        this.index(session);
        this.dirty.delete(session.session_id);
        this.grants.delete(session.session_id);
      }
      this.applyFamilies(families);
      if (families.length > 0) this.hooks.onSecurityEvent?.({ kind: "family-revoked", principalId, familyIds: families.map((family) => family.family_id) });
      this.stats.revocations += ended.length;
      this.hooks.onSessionsEnded?.(
        ended.map((session) => session.session_id),
        principalId,
      );
      return { kind: "ok" as const, signedOut: wasActive };
    });
  }

  /* ==================================================================
      PHASE 3 FINAL: THE AUTHORIZATION WALLET'S OPERATIONS (`authorizationWallet.ts`)
     ==================================================================
     MINT. A text is minted for THIS browser session: CREATE and RECOVER for a signed-out browser (its temporary
     session), REPLACE for a signed-in one under an explicit "Confirm it's you". RECOVER looks nothing up (the server says
     nothing about a username to a browser that has not yet proven the matching wallet); CREATE says "username taken"
     before Keplr signs (account creation necessarily says so; budgeted as every creation is).
     USE. The operation is taken whole (single use), the signature verified against the exact text minted, by the text's
     own signer; then the action is decided inside the identity queue against the state it names. */

  /** The browser session an Authorization Wallet operation of a SIGNED-OUT browser is bound to (and why not). */
  private signedOutSession(read: SessionCookieRead, now: number): Session | "not-authenticated" | "already-profiled" | "has-tables" {
    const current = this.currentOf(read, now);
    if (current === null) return "not-authenticated";
    if ((this.principals.get(current.principal_id) as Principal).kind === "profile") return "already-profiled";
    if (this.isDurable(current.principal_id)) return "has-tables";
    return current;
  }

  /** CREATE / RECOVER: mint the text the wallet signs. `wallet` is the wallet Keplr is on (CREATE: the one to designate;
   *  RECOVER: the one claimed to be the account's). */
  mintAuthorization(read: SessionCookieRead, input: { purpose: "create" | "recover"; username: unknown; wallet: unknown; site: string }, now: number, options: { client?: AuthorizationClient } = {}): MintOutcome {
    const current = this.signedOutSession(read, now);
    /* A durable unprofiled browser may still CREATE (its tables come with it, as ever); it may not sign in to another
       profile (LIVE-2E review M2). */
    if (current === "has-tables" && input.purpose === "recover") return { kind: "has-tables" };
    if (current === "not-authenticated" || current === "already-profiled") return { kind: current };
    const session = current === "has-tables" ? (this.currentOf(read, now) as Session) : current;
    const name = cleanLoginName(input.username);
    if (name === null) return { kind: "bad-username" };
    const wallet = typeof input.wallet === "string" && JUNO_WALLET_PATTERN.test(input.wallet) ? input.wallet : null;
    if (wallet === null) return { kind: "bad-wallet" };
    const loginKey = loginKeyOf(name);
    if (input.purpose === "create" && this.profileOfLogin.has(loginKey)) return { kind: "username-taken" };
    const op = this.authorizations.mint(
      { kind: input.purpose, binding: { sessionId: session.session_id, familyId: session.family_id, loginKey, profileId: null, epoch: null }, site: input.site, account: name, wallet, replaces: null, ...(options.client !== undefined ? { client: options.client } : {}) },
      now,
    );
    if (op === null) return { kind: "busy" };
    return { kind: "ok", operation: op.operation, texts: op.texts.map(({ purpose, signer, text }) => ({ purpose, signer, text })), expiresAt: op.expiresAt };
  }

  /** REPLACE: mint the two texts (the current wallet approves, the new one accepts) for this signed-in account. Needs an
   *  explicit "Confirm it's you" (the password) made by this session: a sign-in's automatic grant is not enough, and the
   *  password alone is not enough either -- both wallets must sign. */
  mintReplacement(read: SessionCookieRead, input: { newWallet: unknown; site: string }, now: number): MintOutcome {
    const who = this.profiledCurrent(read, now);
    if (typeof who === "string") return { kind: who };
    if (!this.sensitiveAuthOf(who.session, who.profile, now, "confirmed")) {
      this.stats.reauthRequired += 1;
      return { kind: "reauth-required" };
    }
    const wallet = typeof input.newWallet === "string" && JUNO_WALLET_PATTERN.test(input.newWallet) ? input.newWallet : null;
    if (wallet === null) return { kind: "bad-wallet" };
    const current = authorizationWalletOf(who.profile);
    const login = loginOf(who.profile);
    if (current === null || login === null) return { kind: "profile-required" };
    if (current.address === wallet) return { kind: "same-wallet" };
    const grant = this.grants.get(who.session.session_id);
    const op = this.authorizations.mint(
      {
        kind: "replace",
        binding: { sessionId: who.session.session_id, familyId: who.session.family_id, loginKey: login.key, profileId: who.profile.profile_id, epoch: who.profile.recovery_selector },
        site: input.site,
        account: login.name,
        wallet,
        replaces: current.address,
        notAfter: grant?.expires_at,
      },
      now,
    );
    if (op === null) return { kind: "busy" };
    return { kind: "ok", operation: op.operation, texts: op.texts.map(({ purpose, signer, text }) => ({ purpose, signer, text })), expiresAt: op.expiresAt };
  }

  /** Every text of `op` verified with the signature given for it (in order). Counted when refused. */
  private verified(op: AuthorizationOperation, signed: readonly AuthorizationSignature[], now: number): boolean {
    if (signed.length !== op.texts.length) return false;
    const ok = op.texts.every((text, at) => verifyAuthorization(text, signed[at], now).ok);
    if (!ok) this.stats.authorizationFailures += 1;
    return ok;
  }

  /* ==================================================================
      CREATE ACCOUNT, LOG IN
     ==================================================================
     CREATE ACCOUNT binds THIS browser's principal (a browser that played before profiles keeps its tables) to a new
     schema-3 profile: the username, the scrypt hash, its AUTHORIZATION WALLET (the CREATE text's signer, proven by its
     signature over the text minted for this session and this username) and a fresh internal credential epoch -- in ONE
     commit, so no account ever exists without its Authorization Wallet. It signs the browser in on a FRESH session in a
     new family, revoking the temporary one `replaced` in the same commit. No recovery key is made, shown or kept.
     LOG IN: the username and password authenticate the PROFILE; this browser gets a fresh session for its principal
     (`issueFor`). Every wrong, unknown, disabled or malformed credential is one answer (`invalid`), after the same KDF
     work. A legacy account's RIGHT password is told `legacy-account` (only a holder of that password hears it).
     Both make the new session's sensitive-auth grant at once (the player has just typed the password: a recent sign-in IS
     a recent authentication). Neither ever asks for a wallet: Keplr is not part of signing in.
     The KDF always runs OUTSIDE the identity queue (bounded by `KdfGate`); everything it was checked against is checked
     again inside the queue before anything is written. */

  async createAccount(
    read: SessionCookieRead,
    input: { username: unknown; password: unknown; displayName: string; authorization: { operation: unknown } & AuthorizationSignature },
    now: number,
    options: { client?: string } = {},
  ): Promise<CreateAccountOutcome> {
    const name = cleanLoginName(input.username);
    if (name === null) return { kind: "bad-username" };
    const password = cleanPassword(input.password);
    if (!password.ok) return { kind: "bad-password", problem: password.problem };
    if (!isDisplayName(input.displayName)) return { kind: "bad-name" };
    const key = loginKeyOf(name);
    /* The cheap answers first, so a refused attempt costs no KDF work (all re-checked inside the queue). */
    const early = this.currentOf(read, now);
    if (early === null) return { kind: "not-authenticated" };
    const earlyPrincipal = this.principals.get(early.principal_id) as Principal;
    if (earlyPrincipal.kind === "profile") return { kind: "already-profiled", name: this.profiles.get(earlyPrincipal.account_link as string)?.display_name ?? "" };
    if (this.profileOfLogin.has(key)) return { kind: "username-taken" };
    /* THE AUTHORIZATION WALLET: this session's CREATE operation, for THIS username, signed by its wallet. Taken (single
       use) before any KDF work; released only on a transient failure. */
    const taken = this.authorizations.take(input.authorization.operation, "create", { sessionId: early.session_id, familyId: early.family_id }, now);
    if (taken.kind !== "open") {
      this.stats.authorizationFailures += 1;
      return { kind: taken.kind === "used" ? "authorization-used" : "authorization-invalid" };
    }
    const op = taken.op;
    if (op.binding.loginKey !== key || !this.verified(op, [input.authorization], now)) {
      this.authorizations.spend(op.operation);
      if (op.binding.loginKey !== key) this.stats.authorizationFailures += 1;
      return { kind: "authorization-invalid" };
    }
    const hashed = await this.kdf.run(() => hashPassword(password.password, this.policy.passwordKdf, this.random), { client: options.client });
    if (hashed.kind === "busy") {
      this.authorizations.release(op.operation);
      this.stats.kdfBusy += 1;
      return { kind: "busy" };
    }
    const outcome = await this.serial(async (): Promise<CreateAccountOutcome> => {
      const current = this.currentOf(read, now);
      if (current === null || current.session_id !== op.binding.sessionId) return { kind: "not-authenticated" as const };
      const principal = this.principals.get(current.principal_id) as Principal;
      if (principal.kind === "profile") return { kind: "already-profiled" as const, name: this.profiles.get(principal.account_link as string)?.display_name ?? "" };
      if (this.profileOfLogin.has(key)) return { kind: "username-taken" as const };
      const profileId = mintUnique(() => mintProfileId(this.random), (id) => this.profiles.has(id));
      /* The internal credential epoch: random, never shown, never a credential (no recovery key exists to match it). */
      const epoch = mintUnique(() => mintRecoverySelector(this.random), (selector) => this.profileOfSelector.has(selector));
      const profile: Profile = {
        profile_id: profileId,
        principal_id: principal.principal_id,
        display_name: input.displayName,
        created_at: now,
        status: "active",
        recovery_selector: epoch,
        recovery_hash: sealedRecoveryDigest(epoch),
        recovery_rotated_at: now,
        schema: 3,
        login_key: key,
        login_name: name,
        password_hash: hashed.value,
        password_set_at: now,
        wallet_address: op.wallet,
        wallet_verified_at: now,
      };
      const bound: Principal = { ...principal, kind: "profile", account_link: profileId, activated_at: principal.activated_at ?? now, last_seen_at: now };
      const durable = this.isDurable(principal.principal_id);
      /* The fresh session (its own new family) the account is signed in on, and what it replaces: the browser's own
         session and its in-grace rotated predecessors. Only a DURABLE principal's are written (revoked); a provisional
         one's never were -- they end in memory, and a restart forgets them (an unknown cookie opens nothing). */
      const { session: fresh, secret, founded } = this.mintSession(principal.principal_id, now, null, "login");
      /* Review L3: EVERY live session of the principal ends with the temporary one -- its in-grace predecessors and, for a
         durable (pre-profile) principal, any other browser it ever had -- and every one of its families: the account
         starts with exactly the one fresh session, whatever cookies were out there before. */
      const graced = this.graceSessionsOf(principal.principal_id, current.session_id, now);
      const elsewhere = durable ? this.activeSessions(principal.principal_id, now).filter((session) => session.session_id !== current.session_id && !graced.some((gone) => gone.session_id === session.session_id)) : [];
      const replaced: Session[] = [current, ...graced, ...elsewhere].map((session) => ({ ...session, revoked_at: now, revoke_reason: "replaced" as const }));
      const replacedFamilies = this.revokedFamilies([...new Set([...replaced.map((session) => session.family_id), ...this.familiesOfPrincipal(principal.principal_id).map((family) => family.family_id)])], "replaced", now);
      const newFamilies = founded === null ? [] : [founded];
      try {
        await this.commit(
          {
            expect: [
              durable ? { kind: "principal-unprofiled" as const, principal_id: principal.principal_id } : { kind: "principal-absent" as const, principal_id: principal.principal_id },
              { kind: "profile-absent", profile_id: profileId },
              { kind: "selector-unused", recovery_selector: epoch },
              { kind: "login-unused", login_key: key },
              { kind: "session-absent", session_id: fresh.session_id },
              ...newFamilies.map((family) => ({ kind: "family-absent" as const, family_id: family.family_id })),
              ...(durable ? replaced.map((session) => ({ kind: "session-open" as const, session_id: session.session_id })) : []),
            ],
            principals: [bound],
            profiles: [profile],
            sessions: [fresh, ...(durable ? replaced : [])],
            families: [...newFamilies, ...(durable ? replacedFamilies : [])],
          },
          "creating an account",
          { kind: "profile-created", at: now, principal_id: bound.principal_id, principal: bound, profile },
        );
      } catch {
        return { kind: "unavailable" as const };
      }
      this.principals.set(bound.principal_id, bound);
      this.indexProfile(profile);
      this.provisional.delete(bound.principal_id);
      this.index(fresh);
      this.applyFamilies([...newFamilies, ...replacedFamilies]);
      for (const session of replaced) {
        this.index(session);
        this.dirty.delete(session.session_id);
        this.grants.delete(session.session_id);
      }
      this.stats.profilesCreated += 1;
      this.stats.accountsCreated += 1;
      this.stats.revocations += replaced.length;
      this.hooks.onSessionsEnded?.(
        replaced.map((session) => session.session_id),
        principal.principal_id,
      );
      await this.recordGrant(fresh, profile, now, "sign-in");
      return { kind: "ok" as const, name: input.displayName, username: name, setCookie: sessionSetCookie(fresh.session_id, secret), principalId: bound.principal_id, sessionId: fresh.session_id };
    });
    if (outcome.kind === "unavailable") this.authorizations.release(op.operation);
    else this.authorizations.spend(op.operation);
    return outcome;
  }

  async login(read: SessionCookieRead, input: { username: unknown; password: unknown }, now: number, options: { client?: string } = {}): Promise<LoginOutcome> {
    /* About THIS browser only (never about the credential): answered before any credential work. */
    const early = this.currentOf(read, now);
    if (early === null) return { kind: "not-authenticated" };
    if ((this.principals.get(early.principal_id) as Principal).kind === "profile") return { kind: "already-profiled" };
    if (this.isDurable(early.principal_id)) return { kind: "has-tables" };
    const name = cleanLoginName(input.username);
    const password = loginPasswordOf(input.password);
    const profileId = name === null ? undefined : this.profileOfLogin.get(loginKeyOf(name));
    const target = profileId === undefined ? undefined : this.profiles.get(profileId);
    const stored = target === undefined ? null : (loginOf(target)?.hash ?? null);
    /* The same KDF work whatever is wrong: an unknown or malformed username is checked against a dummy hash. */
    const checked = await this.kdf.run(() => verifyPassword(password ?? "", stored, this.policy.passwordKdf), { client: options.client });
    if (checked.kind === "busy") {
      this.stats.kdfBusy += 1;
      return { kind: "busy" };
    }
    return this.serial(async () => {
      const current = this.currentOf(read, now);
      if (current === null) return { kind: "not-authenticated" as const };
      if ((this.principals.get(current.principal_id) as Principal).kind === "profile") return { kind: "already-profiled" as const };
      if (this.isDurable(current.principal_id)) return { kind: "has-tables" as const };
      const profile = profileId === undefined ? undefined : this.profiles.get(profileId);
      const right = checked.value && password !== null && stored !== null && profile !== undefined && loginOf(profile)?.hash === stored;
      /* PHASE 3 FINAL: the right password of a LEGACY account -- said only to its holder; nothing is signed in. */
      if (right && profile !== undefined && profile.schema !== 3 && profile.status === "active" && this.principals.get(profile.principal_id)?.status === "active") {
        this.stats.legacyRefusals += 1;
        return { kind: "legacy-account" as const };
      }
      const ok = right && profile !== undefined && this.activeProfileOf(profile.principal_id) !== null;
      if (!ok) {
        this.stats.credentialFailures += 1;
        this.stats.loginFailures += 1;
        return { kind: "invalid" as const };
      }
      const issued = await this.issueFor(profile as Profile, current, now, {}, "login");
      if (issued.kind === "ok") {
        this.stats.logins += 1;
        const session = this.sessions.get(issued.sessionId);
        if (session !== undefined) await this.recordGrant(session, profile as Profile, now, "sign-in");
      }
      return issued;
    });
  }

  /* ==================================================================
      CHANGE PASSWORD, FORGOT PASSWORD (BY THE AUTHORIZATION WALLET), REPLACE THE AUTHORIZATION WALLET
     ==================================================================
     THE CREDENTIAL FENCES. A password's GENERATION is its stored hash (scrypt with a fresh random salt every time, so no
     two generations share one); the Authorization Wallet's is its address and designation time; the credential epoch
     (ESCROW-3A's, to which every wallet ticket and sensitive grant is bound) is the profile's `recovery_selector` --
     unchanged by every action here: none of them is about a game's financial credentials. Every write carries the
     compare-and-swaps of what it was decided against -- `profile-password`, `profile-wallet`, `profile-selector` -- so a
     change decided against a superseded credential (a racing change, recovery or replacement; a second writer) is refused
     by the store itself, in the same step as the write. The KDF runs OUTSIDE the identity queue (bounded by `KdfGate`);
     everything it was checked against is checked again inside the queue.
     SESSIONS. CHANGE: every session that predates it and is not the changer's own ends `signed-out-remotely` (their
       families closed; their sockets 4401; their wallet tickets stop standing: ESCROW-3A F-2 reads the family); this
       browser keeps going on a FRESH session minted into ITS OWN family (the seats' pre-freeze wallet links made here
       keep standing), every other member of that family ends `replaced`.
     RECOVER (signed out, "Forgot password?"): EVERY session and family of the account ends, and this browser gets a fresh
       session in a NEW family (exactly like a sign-in).
     REPLACE: no session ends (the owner is signed in, has confirmed with the password, and both wallets signed).
     WHAT NONE OF THEM TOUCHES: the profile and its principal (every seat), its username, its trust history, the credential
       epoch -- and every game's financial wallet binding (the ticket ledger, the frozen roster, the chain's deposits: a
       seat's wallet never changes here, and a funded seat's never changes at all). RECOVER and CHANGE keep the
       Authorization Wallet (it is the recovery authority); only REPLACE changes it, and only with both wallets' signatures.
     Every one is journaled first (`password-replaced`, `authorization-wallet-replaced`), so an identity restore never
     re-installs a retired password or wallet (`securityReplay.ts`). */

  /** "Change password" (signed in): the CURRENT password, in the request, and the new password. */
  async changePassword(read: SessionCookieRead, input: { currentPassword: unknown; newPassword: unknown }, now: number, options: { client?: string } = {}): Promise<ChangePasswordOutcome> {
    const before = this.profiledCurrent(read, now);
    if (typeof before === "string") return { kind: before };
    const held = loginOf(before.profile) as { key: string; name: string; hash: string };
    const next = cleanPassword(input.newPassword);
    if (!next.ok) return { kind: "bad-password", problem: next.problem };
    /* The current password, checked before any new hash is made (a wrong one costs the attacker the KDF, not us). */
    const typed = loginPasswordOf(input.currentPassword);
    const checked = await this.kdf.run(() => verifyPassword(typed ?? "", held.hash, this.policy.passwordKdf), { client: options.client, authenticated: true });
    if (checked.kind === "busy") {
      this.stats.kdfBusy += 1;
      return { kind: "busy" };
    }
    if (!checked.value || typed === null) {
      this.stats.credentialFailures += 1;
      return { kind: "invalid" };
    }
    const hashed = await this.kdf.run(() => hashPassword(next.password, this.policy.passwordKdf, this.random), { client: options.client, authenticated: true });
    if (hashed.kind === "busy") {
      this.stats.kdfBusy += 1;
      return { kind: "busy" };
    }
    return this.serial(async () => {
      const who = this.profiledCurrent(read, now);
      if (typeof who === "string") return { kind: who };
      /* The very session and password generation the credential was checked against (a change or recovery that landed
         meanwhile wins: the password this request proved is no longer the account's). */
      if (who.session.session_id !== before.session.session_id || loginOf(who.profile)?.hash !== held.hash) {
        this.stats.credentialFailures += 1;
        return { kind: "invalid" as const };
      }
      const principalId = who.session.principal_id;
      const kept = who.session.family_id;
      const { session: fresh, secret } = this.mintSession(principalId, now, kept);
      const standing = [...(this.byPrincipal.get(principalId) ?? [])].map((id) => this.sessions.get(id) as Session).filter((session) => !isSecurityRevocation(session.revoke_reason));
      const mine = standing.filter((session) => session.family_id === kept).map((session) => ({ ...session, revoked_at: now, revoke_reason: "replaced" as const }));
      const others = standing.filter((session) => session.family_id !== kept);
      const signedOut = others.filter((session) => session.revoked_at === null && now < session.expires_at).length;
      const ended = others.map((session) => ({ ...session, revoked_at: now, revoke_reason: "signed-out-remotely" as const }));
      const families = this.revokedFamilies(
        this.familiesOfPrincipal(principalId)
          .map((family) => family.family_id)
          .filter((id) => id !== kept),
        "signed-out-remotely",
        now,
      );
      const dropLinks = this.linkHashesOf(who.profile.profile_id);
      const updated: Profile = { ...who.profile, password_hash: hashed.value, password_set_at: now };
      try {
        await this.commit(
          {
            expect: [
              { kind: "profile-password", profile_id: updated.profile_id, password_hash: held.hash },
              { kind: "profile-selector", profile_id: updated.profile_id, recovery_selector: who.profile.recovery_selector },
              { kind: "family-open", family_id: kept },
              { kind: "session-absent", session_id: fresh.session_id },
              ...[...mine, ...ended].map((session) => ({ kind: "session-open" as const, session_id: session.session_id })),
              ...families.map((family) => ({ kind: "family-open" as const, family_id: family.family_id })),
            ],
            profiles: [updated],
            sessions: [fresh, ...mine, ...ended],
            families,
            dropLinks,
          },
          "changing a password",
          {
            kind: "password-replaced",
            at: now,
            principal_id: principalId,
            profile_id: updated.profile_id,
            from_hash: held.hash,
            to_hash: hashed.value,
            set_at: now,
            via: "password",
            kept_family_id: kept,
            family_ids: familyList(families.map((family) => family.family_id)),
          },
        );
      } catch {
        return { kind: "unavailable" as const };
      }
      this.indexProfile(updated);
      this.forgetLinks(dropLinks);
      this.index(fresh);
      for (const session of [...mine, ...ended]) {
        this.index(session);
        this.dirty.delete(session.session_id);
        this.grants.delete(session.session_id);
      }
      this.applyFamilies(families);
      this.stats.passwordChanges += 1;
      this.stats.revocations += mine.length + ended.length;
      /* Every session that ended -- this browser's old one too: its sockets close 4401 and reopen on the fresh cookie. */
      this.hooks.onSessionsEnded?.(
        [...mine, ...ended].map((session) => session.session_id),
        principalId,
      );
      if (families.length > 0) this.hooks.onSecurityEvent?.({ kind: "family-revoked", principalId, familyIds: families.map((family) => family.family_id) });
      await this.recordGrant(fresh, updated, now, "sign-in");
      return { kind: "ok" as const, setCookie: sessionSetCookie(fresh.session_id, secret), principalId, sessionId: fresh.session_id, signedOut };
    });
  }

  /** "Forgot password?" (signed out): this session's RECOVER operation (a username and the wallet Keplr signed with),
   *  its signature, and the new password. ONE answer (`invalid`) for every reason it is refused -- a signature that does
   *  not verify, a wallet that is not the account's Authorization Wallet (a previously used GAME wallet included), an
   *  account that does not exist, is disabled or legacy -- so the answer says nothing about any username to a browser
   *  that has not proven its Authorization Wallet. */
  async recoverAccount(read: SessionCookieRead, input: { operation: unknown; newPassword: unknown } & AuthorizationSignature, now: number, options: { client?: string } = {}): Promise<RecoverAccountOutcome> {
    /* About THIS browser only (never about the account): answered before any proof work. */
    const early = this.signedOutSession(read, now);
    if (typeof early === "string") return { kind: early };
    const next = cleanPassword(input.newPassword);
    if (!next.ok) return { kind: "bad-password", problem: next.problem };
    const taken = this.authorizations.take(input.operation, "recover", { sessionId: early.session_id, familyId: early.family_id }, now);
    if (taken.kind !== "open") {
      this.stats.authorizationFailures += 1;
      return taken.kind === "used" ? { kind: "authorization-used" } : { kind: "invalid" };
    }
    const op = taken.op;
    const profileId = this.profileOfLogin.get(op.binding.loginKey);
    const found = profileId === undefined ? undefined : this.profiles.get(profileId);
    const authority = found === undefined ? null : authorizationWalletOf(found);
    /* The signature first (by the operation's own signer, over its exact text), then the account: is THAT wallet this
       account's Authorization Wallet, and is the account active? */
    const signed = this.verified(op, [input], now);
    if (!signed || found === undefined || authority === null || authority.address !== op.wallet || this.activeProfileOf(found.principal_id) === null) {
      this.authorizations.spend(op.operation);
      if (signed) this.stats.authorizationFailures += 1;
      this.stats.credentialFailures += 1;
      return { kind: "invalid" };
    }
    const held = loginOf(found) as { key: string; name: string; hash: string };
    const hashed = await this.kdf.run(() => hashPassword(next.password, this.policy.passwordKdf, this.random), { client: options.client });
    if (hashed.kind === "busy") {
      this.authorizations.release(op.operation);
      this.stats.kdfBusy += 1;
      return { kind: "busy" };
    }
    const outcome = await this.serial(async (): Promise<RecoverAccountOutcome> => {
      const current = this.currentOf(read, now);
      if (current === null || current.session_id !== op.binding.sessionId) return { kind: "not-authenticated" as const };
      if ((this.principals.get(current.principal_id) as Principal).kind === "profile") return { kind: "already-profiled" as const };
      if (this.isDurable(current.principal_id)) return { kind: "has-tables" as const };
      /* The wallet and the password generation exactly as checked (a replacement, change or recovery that landed
         meanwhile wins; a replacement also purged this operation). */
      const profile = this.profiles.get(found.profile_id);
      const standingAuthority = profile === undefined ? null : authorizationWalletOf(profile);
      if (profile === undefined || this.activeProfileOf(profile.principal_id) === null || standingAuthority === null || standingAuthority.address !== op.wallet || standingAuthority.since !== authority.since || loginOf(profile)?.hash !== held.hash) {
        this.stats.credentialFailures += 1;
        return { kind: "invalid" as const };
      }
      const principalId = profile.principal_id;
      /* The recovering browser founds a family: a new cookie jar, signed in to the account. */
      const { session: fresh, secret, founded } = this.mintSession(principalId, now, null, "recovery");
      const standing = [...(this.byPrincipal.get(principalId) ?? [])].map((id) => this.sessions.get(id) as Session).filter((session) => !isSecurityRevocation(session.revoke_reason));
      const signedOut = standing.filter((session) => session.revoked_at === null && now < session.expires_at).length;
      const ended = standing.map((session) => ({ ...session, revoked_at: now, revoke_reason: "signed-out-remotely" as const }));
      const families = this.revokedFamilies(
        this.familiesOfPrincipal(principalId).map((family) => family.family_id),
        "signed-out-remotely",
        now,
      );
      /* This browser's temporary session (and its rotated predecessors in their grace) is replaced -- memory only: a
         provisional browser was never written. */
      const replaced: Session[] = [current, ...this.graceSessionsOf(current.principal_id, current.session_id, now)].map((session) => ({ ...session, revoked_at: now, revoke_reason: "replaced" as const }));
      const replacedFamilies = this.revokedFamilies([current.family_id], "replaced", now);
      const newFamilies = founded === null ? [] : [founded];
      const dropLinks = this.linkHashesOf(profile.profile_id);
      /* The Authorization Wallet is KEPT (it is the recovery authority); the credential epoch is unchanged. */
      const updated: Profile = { ...profile, password_hash: hashed.value, password_set_at: now };
      try {
        await this.commit(
          {
            expect: [
              { kind: "profile-password", profile_id: updated.profile_id, password_hash: held.hash },
              { kind: "profile-selector", profile_id: updated.profile_id, recovery_selector: profile.recovery_selector },
              { kind: "profile-authorization-wallet", profile_id: updated.profile_id, wallet_address: op.wallet, wallet_since: authority.since },
              { kind: "session-absent", session_id: fresh.session_id },
              ...newFamilies.map((family) => ({ kind: "family-absent" as const, family_id: family.family_id })),
              ...ended.map((session) => ({ kind: "session-open" as const, session_id: session.session_id })),
              ...families.map((family) => ({ kind: "family-open" as const, family_id: family.family_id })),
            ],
            profiles: [updated],
            sessions: [fresh, ...ended],
            families: [...newFamilies, ...families],
            dropLinks,
          },
          "recovering an account",
          {
            kind: "password-replaced",
            at: now,
            principal_id: principalId,
            profile_id: updated.profile_id,
            from_hash: held.hash,
            to_hash: hashed.value,
            set_at: now,
            via: "authorization-wallet",
            kept_family_id: null,
            family_ids: familyList(families.map((family) => family.family_id)),
          },
        );
      } catch {
        return { kind: "unavailable" as const };
      }
      this.indexProfile(updated);
      this.forgetLinks(dropLinks);
      this.applyFamilies([...newFamilies, ...families, ...replacedFamilies]);
      this.index(fresh);
      for (const session of [...ended, ...replaced]) {
        this.index(session);
        this.dirty.delete(session.session_id);
        this.grants.delete(session.session_id);
      }
      this.stats.accountRecoveries += 1;
      this.stats.revocations += ended.length + replaced.length;
      this.hooks.onSessionsEnded?.(
        replaced.map((session) => session.session_id),
        current.principal_id,
      );
      if (ended.length > 0) {
        this.hooks.onSessionsEnded?.(
          ended.map((session) => session.session_id),
          principalId,
        );
      }
      if (families.length > 0) this.hooks.onSecurityEvent?.({ kind: "family-revoked", principalId, familyIds: families.map((family) => family.family_id) });
      await this.recordGrant(fresh, updated, now, "sign-in");
      return { kind: "ok" as const, name: updated.display_name, setCookie: sessionSetCookie(fresh.session_id, secret), principalId, sessionId: fresh.session_id, signedOut };
    });
    if (outcome.kind === "unavailable") this.authorizations.release(op.operation);
    else this.authorizations.spend(op.operation);
    /* Security review (INFO): a recovery ends every other open RECOVER of the account -- one the wallet already signed
       elsewhere can no longer be answered after the password it would replace is gone. */
    if (outcome.kind === "ok") this.authorizations.purgeAccount(op.binding.loginKey, found.profile_id, op.operation);
    return outcome;
  }

  /** "Change Authorization Wallet" (signed in): this session's REPLACE operation, with the CURRENT Authorization
   *  Wallet's approval and the NEW one's acceptance. The password alone is never enough (it only opened the operation):
   *  both signatures, over the two texts of this one operation, by exactly the two wallets it names. */
  async replaceAuthorizationWallet(read: SessionCookieRead, input: { operation: unknown; approve: AuthorizationSignature; accept: AuthorizationSignature }, now: number): Promise<ReplaceWalletOutcome> {
    const before = this.profiledCurrent(read, now);
    if (typeof before === "string") return { kind: before };
    const taken = this.authorizations.take(input.operation, "replace", { sessionId: before.session.session_id, familyId: before.session.family_id }, now);
    if (taken.kind !== "open") {
      this.stats.authorizationFailures += 1;
      return { kind: taken.kind === "used" ? "authorization-used" : "authorization-invalid" };
    }
    const op = taken.op;
    if (op.binding.profileId !== before.profile.profile_id || !this.verified(op, [input.approve, input.accept], now)) {
      this.authorizations.spend(op.operation);
      return { kind: "authorization-invalid" };
    }
    const outcome = await this.serial(async (): Promise<ReplaceWalletOutcome> => {
      const who = this.profiledCurrent(read, now);
      if (typeof who === "string") return { kind: who };
      if (who.session.session_id !== op.binding.sessionId || who.profile.profile_id !== op.binding.profileId) return { kind: "authorization-invalid" as const };
      const current = authorizationWalletOf(who.profile);
      /* Decided against the designation and epoch the operation was minted under (a replacement that landed meanwhile
         wins -- and purged this operation). */
      if (current === null || current.address !== op.replaces || who.profile.recovery_selector !== op.binding.epoch) return { kind: "stale" as const };
      const since = Math.max(now, current.since + 1);
      const updated: Profile = { ...who.profile, wallet_address: op.wallet, wallet_verified_at: since };
      try {
        await this.commit(
          {
            expect: [
              { kind: "profile-authorization-wallet", profile_id: updated.profile_id, wallet_address: current.address, wallet_since: current.since },
              { kind: "profile-selector", profile_id: updated.profile_id, recovery_selector: who.profile.recovery_selector },
              { kind: "family-open", family_id: who.session.family_id },
            ],
            profiles: [updated],
          },
          "replacing an Authorization Wallet",
          {
            kind: "authorization-wallet-replaced",
            at: now,
            principal_id: who.profile.principal_id,
            profile_id: updated.profile_id,
            from_wallet: current.address,
            from_since: current.since,
            to_wallet: op.wallet,
            to_since: since,
          },
        );
      } catch {
        return { kind: "unavailable" as const };
      }
      this.indexProfile(updated);
      /* Every open operation issued under the old designation dies NOW: a RECOVER naming this account (it would be
         refused anyway -- the wallet no longer matches) and any other replacement of this profile. */
      this.authorizations.purgeAccount(loginOf(updated)?.key ?? "", updated.profile_id, op.operation);
      this.stats.authorizationReplacements += 1;
      return { kind: "ok" as const, authorizationWallet: { address: op.wallet, since } };
    });
    if (outcome.kind === "unavailable") this.authorizations.release(op.operation);
    else this.authorizations.spend(op.operation);
    return outcome;
  }

  /* ==================================================================
      WHAT OTHER LAYERS READ OF THE ACCOUNT
     ================================================================== */

  /** Trust indicators: what the public facts read of a principal's profile -- times only, never an id or an address. */
  trustProfileFacts(principalId: string): { createdAt: number; authorizationWalletSince: number | null } | null {
    const profile = this.activeProfileOf(principalId);
    return profile === null ? null : { createdAt: profile.created_at, authorizationWalletSince: authorizationWalletOf(profile)?.since ?? null };
  }

  /** The profile's Authorization Wallet (the money routes: a fresh proof BY THAT wallet authorizes its own seat link
   *  without "Confirm it's you" -- it is a stronger authority than the password). Never inferred from any other wallet. */
  authorizationWallet(principalId: string): { address: string; since: number } | null {
    const profile = this.activeProfileOf(principalId);
    return profile === null ? null : authorizationWalletOf(profile);
  }

  /* ==================================================================
      THE ACTIVATION SEAM (LIVE-2B §2)
     ==================================================================
     Called by the server before the first DURABLE room action of a principal (today: the legacy `host` and
     `upsert-player` room writes, which save a room document; LIVE-2C: GameRecord create / take-seat). Idempotent. A
     store failure is rethrown, and the room action is refused -- nothing claims a room for a principal the store
     would forget. Development principals (`pr_dev_…`) are synthetic and never stored. */
  activate(principalId: string, now: number): Promise<void> {
    /* The fast path: nothing to write, so nothing to queue behind (every durable room action calls this). */
    if (principalId.startsWith("pr_dev_") || (this.principals.get(principalId)?.activated_at ?? null) !== null) return Promise.resolve();
    return this.serial(async () => {
      const principal = this.principals.get(principalId);
      if (principal === undefined) throw new IdentityUnavailableError("this principal is no longer known to the server");
      if (principal.status !== "active") throw new IdentityUnavailableError("this principal has been disabled");
      if (principal.activated_at !== null) return;
      const activated: Principal = { ...principal, activated_at: now, last_seen_at: now };
      const sessions = [...(this.byPrincipal.get(principalId) ?? [])].map((id) => this.sessions.get(id) as Session);
      const families = this.familiesOfPrincipal(principalId);
      await this.commit(
        {
          /* LIVE-3C: CREATE-IF-ABSENT -- a principal and its sessions (ESCROW-3A: and their families) are made durable once. */
          expect: [
            { kind: "principal-absent", principal_id: principalId },
            ...sessions.map((session) => ({ kind: "session-absent" as const, session_id: session.session_id })),
            ...families.map((family) => ({ kind: "family-absent" as const, family_id: family.family_id })),
          ],
          principals: [activated],
          sessions,
          families,
        },
        "activating a principal",
      );
      this.principals.set(principalId, activated);
      this.provisional.delete(principalId);
      this.stats.activations += 1;
    });
  }

  /** The 60-second housekeeping: write `last_seen_at` behind, and collect sessions no browser can still present. */
  sweep(now: number): Promise<void> {
    return this.serial(async () => {
      const collect: string[] = [];
      for (const session of this.sessions.values()) {
        const cookieGone = session.created_at + this.policy.absoluteMs + DAY;
        const auditKept = session.revoked_at === null ? 0 : session.revoked_at + this.policy.auditRetentionMs;
        const ended = session.revoked_at !== null || now >= session.expires_at;
        if (ended && now > Math.max(cookieGone, auditKept)) collect.push(session.session_id);
      }
      const durableCollect = collect.filter((id) => this.isDurable((this.sessions.get(id) as Session).principal_id));
      /* LIVE-2E: a link code is dropped once it has expired, used or not -- a replay then finds nothing, which is the
         same `invalid` a used one gets. */
      const expiredLinks = [...this.links.values()].filter((link) => now >= link.expires_at).map((link) => link.link_hash);
      const writeBehind = [...this.dirty].filter((id) => !collect.includes(id)).map((id) => this.sessions.get(id) as Session);
      const principals = [...new Set(writeBehind.map((session) => session.principal_id))]
        .map((id) => this.principals.get(id))
        .filter((principal): principal is Principal => principal !== undefined && principal.activated_at !== null);
      if (durableCollect.length > 0 || writeBehind.length > 0 || expiredLinks.length > 0) {
        try {
          await this.commit({ sessions: writeBehind, principals, dropSessions: durableCollect, dropLinks: expiredLinks }, "the identity write-behind");
          for (const hash of expiredLinks) this.links.delete(hash);
          this.stats.writeBehindWrites += writeBehind.length;
          for (const session of writeBehind) this.dirty.delete(session.session_id);
        } catch {
          /* SURFACED, NOT SWALLOWED: counted and reported by `commit`; the dirty set is kept and the next sweep
             writes it again. Nothing is collected from memory that the store still holds. */
          return;
        }
      }
      for (const id of collect) this.forgetSession(id);
      for (const [principalId] of this.provisional) {
        if (!this.byPrincipal.has(principalId)) {
          this.provisional.delete(principalId);
          this.principals.delete(principalId);
        }
      }
      this.stats.sessionsCollected += collect.length;
    });
  }

  /** Flush the write-behind at shutdown. A failure is reported, not hidden. */
  async flush(now: number): Promise<void> {
    await this.sweep(now);
  }

  /** For tests and the operator report: counts only, never a record. */
  sizes(): { principals: number; provisional: number; sessions: number; dirty: number; profiles: number; links: number; families: number; grants: number } {
    return {
      principals: this.principals.size,
      provisional: this.provisional.size,
      sessions: this.sessions.size,
      dirty: this.dirty.size,
      profiles: this.profiles.size,
      links: this.links.size,
      families: this.families.size,
      grants: this.grants.size,
    };
  }

  /* ==================================================================
      ESCROW-3A (brief §10B): RE-AUTHENTICATION FOR SENSITIVE ACTIONS
     ==================================================================
     A stolen live session is not, by itself, enough to sign out the owner's other devices, (ESCROW-4) link a wallet to
     a seat or (PHASE 3 FINAL) begin replacing the Authorization Wallet: each asks for a RECENT re-authentication by the
     same session -- "Confirm it's you" with the account's PASSWORD (`POST /gs/api/profile/reauth`), or a sign-in in the
     last few minutes for the ordinary sensitive actions. The grant is server-side; it names the session, its family and
     the credential epoch it was made under, and lapses after `sensitiveAuthMs`. It cannot be borrowed: another session,
     another family, or the same session after the epoch moved finds no grant. No secret is kept. The Authorization
     Wallet is never asked for here: ordinary play never prompts for it. */

  /** A sensitive-auth grant for THIS session (inside the queue): memory, and durable too when configured -- best effort
   *  (the grant is honoured here either way; see `IdentitySecuritySubstrate`). Bound to the session, its family and the
   *  profile's credential epoch. Returns when it lapses. */
  private async recordGrant(session: Session, profile: Profile, now: number, how: GrantHow): Promise<number> {
    const expiresAt = now + this.policy.sensitiveAuthMs;
    const durable = this.security.grants;
    /* P3-ACCT POLICY: a sign-in's automatic grant is memory only (a restart drops it: the player confirms when asked). */
    if (durable !== undefined && how === "confirmed") {
      try {
        await durable.put({ session_id: session.session_id, family_id: session.family_id, selector: profile.recovery_selector, expires_at: expiresAt });
      } catch (error) {
        this.stats.storeFailures += 1;
        this.hooks.onStoreFailure?.("recording a re-authentication", error);
      }
    }
    this.grants.set(session.session_id, { family_id: session.family_id, selector: profile.recovery_selector, expires_at: expiresAt, how });
    return expiresAt;
  }

  /** "Confirm it's you" with the PASSWORD. The KDF runs outside the identity queue (it is slow on purpose); the grant is
   *  then made inside it, only if the profile still holds the very hash that was checked. One answer, `invalid`, for
   *  every wrong or missing password. */
  async reauthenticateWithPassword(read: SessionCookieRead, rawPassword: unknown, now: number, options: { client?: string } = {}): Promise<ReauthOutcome | { kind: "busy" }> {
    const before = this.profiledCurrent(read, now);
    if (typeof before === "string") return { kind: before };
    const password = loginPasswordOf(rawPassword);
    const stored = loginOf(before.profile)?.hash ?? null;
    /* Review M1: a signed-in session confirming it's you may use the gate's reserved slot. */
    const checked = await this.kdf.run(() => verifyPassword(password ?? "", stored, this.policy.passwordKdf), { client: options.client, authenticated: true });
    if (checked.kind === "busy") {
      this.stats.kdfBusy += 1;
      return { kind: "busy" };
    }
    return this.serial(async () => {
      const who = this.profiledCurrent(read, now);
      if (typeof who === "string") return { kind: who };
      const ok = checked.value && password !== null && stored !== null && who.session.session_id === before.session.session_id && loginOf(who.profile)?.hash === stored;
      if (!ok) {
        this.stats.reauthFailures += 1;
        return { kind: "invalid" as const };
      }
      const expiresAt = await this.recordGrant(who.session, who.profile, now, "confirmed");
      this.stats.reauths += 1;
      return { kind: "ok" as const, expiresAt };
    });
  }

  /** Whether THIS session holds a live re-authentication under the profile's CURRENT epoch. P3-ACCT POLICY: `need`
   *  "confirmed" accepts only an explicit "Confirm it's you", never a sign-in's grant. */
  private sensitiveAuthOf(session: Session, profile: Profile, now: number, need: GrantHow = "sign-in"): boolean {
    const grant = this.grants.get(session.session_id);
    if (grant === undefined) return false;
    if (now >= grant.expires_at || grant.family_id !== session.family_id || grant.selector !== profile.recovery_selector || this.familyRevoked(session)) {
      this.grants.delete(session.session_id);
      return false;
    }
    return need === "sign-in" || grant.how === "confirmed";
  }

  /** Whether the session a request authenticates with holds a live re-authentication (ESCROW-4's wallet binding asks). */
  hasSensitiveAuth(read: SessionCookieRead, now: number): boolean {
    const who = this.profiledCurrent(read, now);
    return typeof who !== "string" && this.sensitiveAuthOf(who.session, who.profile, now);
  }

  /* ==================================================================
      ESCROW-3A (F-2): WHAT A FINANCIAL CREDENTIAL IS ISSUED UNDER, AND WHETHER IT STILL STANDS
     ==================================================================
     PHASE 3 FINAL (the credential-epoch audit): `recoverySelector` here is the profile's INTERNAL CREDENTIAL EPOCH -- the
     stored `recovery_selector`, now random, never shown and never a credential. Its format (`rk_` + 128 bits) and its
     semantics (an opaque value compared for equality with the profile's current one) are exactly ESCROW-3A's, so every
     stored wallet ticket (`issued_under.recovery_selector`), durable grant and in-memory challenge context reads as it
     always did; nothing signed, nothing on the wire and nothing on chain ever carried it. No action of this build moves
     it (the recovery-key rotation that did is gone; a password change or recovery never moved it): a game's financial
     credentials depend on the session family and the seat, never on the Authorization Wallet. */

  /** The security context of the session a request authenticates with -- for issuing a credential bound to it.
   *  Server-side only: none of these ids leaves the server. */
  securityContextOf(read: SessionCookieRead, now: number): { principalId: string; familyId: string; recoverySelector: string } | null {
    const who = this.profiledCurrent(read, now);
    return typeof who === "string" ? null : { principalId: who.session.principal_id, familyId: who.session.family_id, recoverySelector: who.profile.recovery_selector };
  }

  /** Whether a credential issued under (principal, family, credential epoch) still stands: the principal and its
   *  profile active, the family open (no sign-out of that device, no sign-out-others, no replacement, no disable), the
   *  epoch unchanged. Synchronous against committed state. */
  securityStanding(context: { principalId: string; familyId: string; recoverySelector: string }): SecurityStanding {
    const principal = this.principals.get(context.principalId);
    if (principal === undefined || principal.status !== "active") return { kind: "ended", why: "principal" };
    const profile = this.activeProfileOf(context.principalId);
    if (profile === null) return { kind: "ended", why: "profile" };
    const family = this.families.get(context.familyId);
    if (family === undefined || family.principal_id !== context.principalId || family.revoked_at !== null) return { kind: "ended", why: "family" };
    if (profile.recovery_selector !== context.recoverySelector) return { kind: "ended", why: "recovery-key" };
    return { kind: "standing" };
  }

  /** Test support: a family's stored shape. */
  peekFamily(familyId: string): Readonly<SessionFamily> | undefined {
    return this.families.get(familyId);
  }

  /** Who holds a username (canonical key) NOW: an active account's principal, a held but inactive one, or nobody. For
   *  binding an operator-configured list of accounts (by username) to the accounts that exist; usernames are never
   *  released, so a held name can never pass to someone else. Server-side only. */
  usernameHolder(name: string): { readonly kind: "active"; readonly principalId: string } | { readonly kind: "inactive" } | { readonly kind: "unheld" } {
    const profileId = this.profileOfLogin.get(loginKeyOf(name));
    const profile = profileId === undefined ? undefined : this.profiles.get(profileId);
    if (profile === undefined) return { kind: "unheld" };
    if (profile.status !== "active" || this.activeProfileOf(profile.principal_id) === null) return { kind: "inactive" };
    return { kind: "active", principalId: profile.principal_id };
  }

  /** Test support: a profile's stored shape. */
  peekProfileOf(principalId: string): Readonly<Profile> | undefined {
    const id = this.profileOfPrincipal.get(principalId);
    return id === undefined ? undefined : this.profiles.get(id);
  }

  /** Test support (P3-ACCT): whether a username is taken. */
  peekLogin(username: string): boolean {
    const name = cleanLoginName(username);
    return name !== null && this.profileOfLogin.has(loginKeyOf(name));
  }

  /** Test support: a session's stored shape (the tests assert no secret is in it). */
  peekSession(sessionId: string): Readonly<Session> | undefined {
    return this.sessions.get(sessionId);
  }

  peekPrincipal(principalId: string): Readonly<Principal> | undefined {
    return this.principals.get(principalId);
  }

  /** Test support (PHASE 3 FINAL): how many Authorization Wallet operations are held. */
  peekAuthorizations(): number {
    return this.authorizations.size();
  }
}

export { StoreDefiniteError };
