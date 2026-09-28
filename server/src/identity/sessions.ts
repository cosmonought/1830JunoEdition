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

import { createHash, timingSafeEqual } from "crypto";

import { StoreDefiniteError } from "../persistence/storeResult";
import { sessionSetCookie, type SessionCookieRead } from "./cookies";
import {
  canonicalLinkCode,
  cryptoRandom,
  familyIdOf,
  linkCodeHash,
  mintLinkCode,
  mintPrincipalId,
  mintProfileId,
  mintRecoveryKey,
  mintSecret,
  mintSessionId,
  mintUnique,
  parseRecoveryKey,
  secretHash,
  secretMatches,
  type RandomSource,
} from "./ids";
import {
  isDisplayName,
  isSecurityRevocation,
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

const DAY = 24 * 60 * 60 * 1000;

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
  /** LIVE-2E: how long a "Link another device" code lives. */
  linkCodeTtlMs: number;
  /** LIVE-2E: unexpired, unused link codes a profile may hold at once (a new one retires the oldest). */
  maxOutstandingLinkCodes: number;
  /** ESCROW-3A (brief §10B): how long a re-authentication (the recovery key, presented again) lets THIS session take a
   *  sensitive action -- rotate the recovery key, sign out other devices, and (ESCROW-4) change a wallet binding. */
  sensitiveAuthMs: number;
  /** ESCROW-3A (owner review): how long the ONE-TIME creation rescue stays open when a create's response may have been
   *  lost (`createProfile` with a creation receipt). It is consumed by its one use, closed at once by the creating
   *  page's acknowledgement of the key, and forgotten by a restart; this only bounds how long an unanswered one waits. */
  creationRescueMs: number;
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
  linkCodeTtlMs: 10 * 60 * 1000,
  /* LIVE-2E adversarial review (H1): ONE. A new code retires any earlier unused one, so a device that saw a single
     code cannot stockpile more to outlive the owner's "Sign out other devices". */
  maxOutstandingLinkCodes: 1,
  sensitiveAuthMs: 5 * 60 * 1000,
  creationRescueMs: 10 * 60 * 1000,
});

/** Why a known session no longer opens anything -- the stable reasons of `401 session-ended`. */
export type SessionEndReason = "expired" | "rotated" | "unreadable" | RevokeReason;

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

/* LIVE-2E: the answers of the profile operations. None carries an id; `recoveryKey` and `linkCode` are handed to the
   caller exactly once, to be returned to the one authenticated browser that asked, and are never kept. */
export type CreateProfileOutcome =
  | { kind: "ok"; name: string; recoveryKey: string }
  | { kind: "not-authenticated" }
  | { kind: "already-profiled"; name: string }
  | { kind: "bad-name" }
  | { kind: "unavailable" };

export type CredentialOutcome =
  | { kind: "ok"; name: string; setCookie: string; principalId: string }
  | { kind: "not-authenticated" }
  | { kind: "already-profiled" }
  /** LIVE-2E review (M2): this browser's principal is durable -- it played before profiles existed and may hold
   *  seats. Signing it in to another profile would orphan them; it must create its own profile to keep them. */
  | { kind: "has-tables" }
  /** One answer for every wrong, expired, used, revoked or disabled credential: nothing says which. */
  | { kind: "invalid" }
  | { kind: "unavailable" };

export type ProfileActionOutcome<T> =
  | ({ kind: "ok" } & T)
  | { kind: "not-authenticated" }
  | { kind: "profile-required" }
  /** ESCROW-3A: a sensitive action on a session that has not re-authenticated recently (the client asks for the
   *  recovery key, `POST /gs/api/profile/reauth`, and retries). Says nothing else. */
  | { kind: "reauth-required" }
  | { kind: "unavailable" };

/** ESCROW-3A: the answer to a re-authentication. `expiresAt` is when the grant lapses (the client may say so). */
export type ReauthOutcome =
  | { kind: "ok"; expiresAt: number }
  | { kind: "not-authenticated" }
  | { kind: "profile-required" }
  /** The one answer for every wrong, malformed or other profile's key: nothing says which. */
  | { kind: "invalid" };

/** ESCROW-3A (F-2): whether a credential issued under (principal, family, recovery selector) still stands. */
export type SecurityStanding = { kind: "standing" } | { kind: "ended"; why: "principal" | "profile" | "family" | "recovery-key" };

/** What `POST /gs/api/session` may say about the account: a name and a count, never an id. */
export interface AccountView {
  name: string;
  /** Other sessions (devices or browsers) of this profile that are signed in now. */
  otherSessions: number;
}

/* A digest that matches nothing (no preimage is known): an unknown recovery selector is compared against it, so a
   wrong selector costs the same constant-time comparison as a wrong secret. */
const NO_PROFILE_HASH = createHash("sha256").update("gs-no-such-recovery-key").digest("hex");

/** ESCROW-3A: a creation receipt is 32 random bytes in lowercase hex, made by the creating page and held only in its
 *  memory (`frontend/src/utils/profileApi.ts` `mintCreationReceipt`). Anything else is no receipt. */
export const CREATION_RECEIPT_PATTERN = /^[0-9a-f]{64}$/;
const isCreationReceipt = (value: unknown): value is string => typeof value === "string" && CREATION_RECEIPT_PATTERN.test(value);
/** What the rescue keeps of a receipt: a domain-separated digest, never the receipt. */
const receiptDigest = (receipt: string): Buffer => createHash("sha256").update(`18COSMOS/CREATION-RECEIPT/v1\n${receipt}`).digest();
/** Constant-time comparison of an offered receipt with a kept digest (anything that is not a receipt matches nothing). */
const receiptMatches = (offered: unknown, kept: string): boolean =>
  timingSafeEqual(receiptDigest(isCreationReceipt(offered) ? offered : "-"), Buffer.from(kept, "hex")) && isCreationReceipt(offered);

export interface IdentityHooks {
  /** Sessions that just ended for a SECURITY reason (logout, eviction, operator, principal disabled): their sockets
   *  close 4401. Called after the change is committed. */
  onSessionsEnded?: (sessionIds: readonly string[], principalId: string) => void;
  /** ESCROW-3A (F-2): a security event committed -- a family revoked (sign-out, sign-out-others, replacement, a disabled
   *  principal) or the recovery key rotated. Financial credentials DERIVE their standing from identity
   *  (`securityStanding`), so nothing is lost if this is not observed; it lets their ledger record the revocation. */
  onSecurityEvent?: (event: { readonly kind: "family-revoked" | "recovery-key-rotated" | "principal-disabled"; readonly principalId: string; readonly familyIds: readonly string[] }) => void;
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
  recoveries: number;
  links: number;
  linkCodesIssued: number;
  recoveryRotations: number;
  credentialFailures: number;
  familiesRevoked: number;
  reauths: number;
  reauthFailures: number;
  /** ESCROW-3A: lost-create-response rescues used, and initial key deliveries acknowledged. */
  creationRescues: number;
  keyDeliveriesAcknowledged: number;
  reauthRequired: number;
}

export interface IdentityServiceOptions {
  policy?: Partial<IdentityPolicy>;
  random?: RandomSource;
  hooks?: IdentityHooks;
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
  /** LIVE-2E: link codes by digest (durable; kept until they expire, used or not). */
  private readonly links = new Map<string, LinkCredential>();
  /** LIVE-2E: the order codes were issued in this process -- breaks a same-millisecond tie when the oldest unused
   *  code is retired (a restart falls back to the digest, which only matters for codes issued in one millisecond). */
  private readonly linkIssueOrder = new Map<string, number>();
  private linkIssues = 0;
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
    recoveries: 0,
    links: 0,
    linkCodesIssued: 0,
    recoveryRotations: 0,
    credentialFailures: 0,
    familiesRevoked: 0,
    reauths: 0,
    creationRescues: 0,
    keyDeliveriesAcknowledged: 0,
    reauthFailures: 0,
    reauthRequired: 0,
  };
  /** ESCROW-3A (IR-03): the session families (durable ones mirror the store; a provisional principal's live here). */
  private readonly families = new Map<string, SessionFamily>();
  /** ESCROW-3A (brief §10B): recent re-authentications, by SESSION. MEMORY ONLY, never persisted, never a secret: the
   *  grant names the family and the recovery selector it was made under, and lapses after `sensitiveAuthMs`. A restart
   *  forgets it (the player re-enters the key). LIVE-5: an item keyed by session with a TTL, checked in the same
   *  transaction as the action. */
  private readonly grants = new Map<string, { family_id: string; selector: string; expires_at: number }>();
  /** ESCROW-3A (owner review): the ONE-TIME creation rescue, by PROFILE -- open only while the profile's first key may
   *  not have reached the page that created it. MEMORY ONLY (a restart closes every one: fail closed), never a secret:
   *  it names the creating SESSION (not its family's successors), the family, the selector of the key that was issued,
   *  and the digest of the random creation receipt the creating page sent and holds in memory. See `createProfile`. */
  private readonly creationDeliveries = new Map<string, { session_id: string; family_id: string; selector: string; receipt_hash: string; expires_at: number }>();

  private constructor(
    private readonly store: IdentityStore,
    readonly policy: IdentityPolicy,
    private readonly random: RandomSource,
    private readonly hooks: IdentityHooks,
  ) {}

  /** Load what is durable. Throws (the server refuses to start) when the store cannot be read. */
  static async open(store: IdentityStore, options: IdentityServiceOptions = {}): Promise<IdentityService> {
    return IdentityService.fromSnapshot(store, await store.load(), options);
  }

  /** Over a snapshot already loaded from `store` (an empty one for a fresh in-memory store). */
  static fromSnapshot(store: IdentityStore, snapshot: IdentitySnapshot, options: IdentityServiceOptions = {}): IdentityService {
    const service = new IdentityService(store, { ...DEFAULT_IDENTITY_POLICY, ...(options.policy ?? {}) }, options.random ?? cryptoRandom, { ...(options.hooks ?? {}) });
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
    this.queue = run.catch(() => undefined);
    return run;
  }

  private isDurable(principalId: string): boolean {
    return (this.principals.get(principalId)?.activated_at ?? null) !== null;
  }

  isProvisional(principalId: string): boolean {
    const principal = this.principals.get(principalId);
    return principal !== undefined && principal.activated_at === null;
  }

  /** Write a change for a durable principal; a failure is counted, reported and rethrown. */
  private async commit(change: IdentityChange, what: string): Promise<void> {
    try {
      await this.store.commit(change);
    } catch (error) {
      this.stats.storeFailures += 1;
      this.hooks.onStoreFailure?.(what, error);
      throw error;
    }
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
    if (principal === undefined || principal.status !== "active") return { kind: "refused", why: "ended" };
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
      LIVE-2E: PROFILES -- MANDATORY, ONE PER PRINCIPAL, RECOVERED BY THE SAME PRINCIPAL
     ==================================================================
     A profile binds the principal that created it, for good. Recovery and device linking authenticate the PROFILE
     and issue a fresh, ordinary session for ITS principal -- the principal every seat already names -- so a new
     device has the same seats with nothing copied, transferred or reassigned. The browser's temporary unprofiled
     session is revoked `replaced` in the same durable commit (session fixation: whatever that cookie was, it opens
     nothing now). Every change is written before it is applied; a store failure answers `unavailable` and changes
     nothing. Secrets are compared in constant time; codes are found by digest; neither is kept in the clear. */

  /** The profile a principal belongs to, when it has one and both are active. */
  private activeProfileOf(principalId: string): Profile | null {
    const principal = this.principals.get(principalId);
    if (principal === undefined || principal.status !== "active" || principal.kind !== "profile") return null;
    const profile = this.profiles.get(principal.account_link as string);
    return profile !== undefined && profile.status === "active" ? profile : null;
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
    return { name: profile.display_name, otherSessions };
  }

  /** The current session a profile request authenticates with (never a rotated or ended one), without touching. */
  private currentOf(read: SessionCookieRead, now: number): Session | null {
    if (read.kind !== "session") return null;
    const session = this.sessions.get(read.sessionId);
    if (session === undefined || !secretMatches(read.secret, session.secret_hash)) return null;
    const principal = this.principals.get(session.principal_id);
    if (principal === undefined || principal.status !== "active") return null;
    if (session.revoked_at !== null || now >= session.expires_at) return null;
    if (this.familyRevoked(session)) return null;
    return session;
  }

  /** Create the profile of THIS browser's principal. Idempotent in effect: a second attempt (a retry, a race, a second
   *  tab) finds the principal already profiled and answers `already-profiled` -- never a second profile. */
  createProfile(read: SessionCookieRead, displayName: string, now: number, creationReceipt?: unknown): Promise<CreateProfileOutcome> {
    return this.serial(async () => {
      const session = this.currentOf(read, now);
      if (session === null) return { kind: "not-authenticated" as const };
      const principal = this.principals.get(session.principal_id) as Principal;
      if (principal.kind === "profile") {
        return { kind: "already-profiled" as const, name: this.profiles.get(principal.account_link as string)?.display_name ?? "" };
      }
      if (!isDisplayName(displayName)) return { kind: "bad-name" as const };
      const profileId = mintUnique(() => mintProfileId(this.random), (id) => this.profiles.has(id));
      let key = mintRecoveryKey(this.random);
      for (let attempt = 0; this.profileOfSelector.has(key.selector); attempt += 1) {
        if (attempt >= 4) throw new Error("identity: 5 consecutive recovery-selector collisions -- the random source is not random");
        key = mintRecoveryKey(this.random);
      }
      const profile: Profile = {
        profile_id: profileId,
        principal_id: principal.principal_id,
        display_name: displayName,
        created_at: now,
        status: "active",
        recovery_selector: key.selector,
        recovery_hash: secretHash(key.secret),
        recovery_rotated_at: now,
        schema: 1,
      };
      const bound: Principal = {
        ...principal,
        kind: "profile",
        account_link: profileId,
        activated_at: principal.activated_at ?? now,
        last_seen_at: now,
      };
      /* ONE commit: the profile, the principal bound to it, and (if it was provisional) every session of it. A crash
         leaves all of it or none of it; `checkSnapshot` refuses a half-bound pair at load. */
      const sessions = this.isDurable(principal.principal_id)
        ? []
        : [...(this.byPrincipal.get(principal.principal_id) ?? [])].map((id) => this.sessions.get(id) as Session);
      /* ESCROW-3A: a provisional browser's families become durable with its sessions. */
      const families = sessions.length === 0 ? [] : this.familiesOfPrincipal(principal.principal_id);
      try {
        await this.commit(
          {
            /* LIVE-3C: CREATE-IF-ABSENT -- the profile, its selector, and (for a provisional browser) the principal and
               its sessions; a durable principal must still be unprofiled. */
            expect: [
              this.isDurable(principal.principal_id)
                ? { kind: "principal-unprofiled" as const, principal_id: principal.principal_id }
                : { kind: "principal-absent" as const, principal_id: principal.principal_id },
              { kind: "profile-absent", profile_id: profileId },
              { kind: "selector-unused", recovery_selector: key.selector },
              ...sessions.map((session) => ({ kind: "session-absent" as const, session_id: session.session_id })),
              ...families.map((family) => ({ kind: "family-absent" as const, family_id: family.family_id })),
            ],
            principals: [bound],
            sessions,
            profiles: [profile],
            families,
          },
          "creating a profile",
        );
      } catch {
        return { kind: "unavailable" as const };
      }
      this.principals.set(bound.principal_id, bound);
      this.indexProfile(profile);
      this.provisional.delete(bound.principal_id);
      this.stats.profilesCreated += 1;
      /* ESCROW-3A: the response carrying the key may still be lost. If the creating page sent a creation receipt (random,
         held only in that page's memory), THIS session -- presenting that receipt -- may rotate the unseen key ONCE,
         until the page acknowledges the key or `creationRescueMs` passes. Only its digest is kept. */
      if (isCreationReceipt(creationReceipt)) {
        this.creationDeliveries.set(profileId, {
          session_id: session.session_id,
          family_id: session.family_id,
          selector: key.selector,
          receipt_hash: receiptDigest(creationReceipt).toString("hex"),
          expires_at: now + this.policy.creationRescueMs,
        });
      }
      return { kind: "ok" as const, name: displayName, recoveryKey: key.key };
    });
  }

  /** Recovery: the key authenticates a PROFILE; this browser gets a fresh session for that profile's principal, and
   *  its own temporary session is revoked `replaced`. Other devices' sessions are untouched. */
  recover(read: SessionCookieRead, rawKey: unknown, now: number): Promise<CredentialOutcome> {
    return this.serial(async () => {
      const current = this.currentOf(read, now);
      if (current === null) return { kind: "not-authenticated" as const };
      if ((this.principals.get(current.principal_id) as Principal).kind === "profile") return { kind: "already-profiled" as const };
      if (this.isDurable(current.principal_id)) return { kind: "has-tables" as const };
      const parsed = parseRecoveryKey(rawKey);
      if (parsed === null) {
        this.stats.credentialFailures += 1;
        return { kind: "invalid" as const };
      }
      const profileId = this.profileOfSelector.get(parsed.selector);
      const profile = profileId === undefined ? undefined : this.profiles.get(profileId);
      /* Constant time either way: an unknown selector is compared against a digest nothing matches. */
      const matches = secretMatches(parsed.secret, profile?.recovery_hash ?? NO_PROFILE_HASH);
      if (!matches || profile === undefined || this.activeProfileOf(profile.principal_id) === null) {
        this.stats.credentialFailures += 1;
        return { kind: "invalid" as const };
      }
      const issued = await this.issueFor(profile, current, now, {}, "recovery");
      if (issued.kind === "ok") this.stats.recoveries += 1;
      return issued;
    });
  }

  /** Redeem a "Link another device" code: consumed ATOMICALLY with the session it issues (one commit), so a crash
   *  leaves either both or neither, and a replay -- before or after a restart -- finds it used or gone: `invalid`. */
  redeemLink(read: SessionCookieRead, rawCode: unknown, now: number): Promise<CredentialOutcome> {
    return this.serial(async () => {
      const current = this.currentOf(read, now);
      if (current === null) return { kind: "not-authenticated" as const };
      if ((this.principals.get(current.principal_id) as Principal).kind === "profile") return { kind: "already-profiled" as const };
      if (this.isDurable(current.principal_id)) return { kind: "has-tables" as const };
      const canonical = canonicalLinkCode(rawCode);
      const link = canonical === null ? undefined : this.links.get(linkCodeHash(canonical));
      const profile = link === undefined ? undefined : this.profiles.get(link.profile_id);
      if (
        link === undefined ||
        link.consumed_at !== null ||
        now >= link.expires_at ||
        profile === undefined ||
        this.activeProfileOf(profile.principal_id) === null
      ) {
        this.stats.credentialFailures += 1;
        return { kind: "invalid" as const };
      }
      const consumed: LinkCredential = { ...link, consumed_at: now };
      /* LIVE-3C: SINGLE USE -- consumed only if still unconsumed and unexpired, in the same write as the session. */
      const issued = await this.issueFor(profile, current, now, { expect: [{ kind: "link-unconsumed", link_hash: link.link_hash, at: now }], links: [consumed] }, "link");
      if (issued.kind === "ok") {
        this.links.set(consumed.link_hash, consumed);
        this.stats.links += 1;
      }
      return issued;
    });
  }

  /** A fresh session for `profile`'s principal, replacing `old` (this browser's temporary session). Inside the queue. */
  private async issueFor(profile: Profile, old: Session, now: number, extra: IdentityChange, origin: "recovery" | "link"): Promise<CredentialOutcome> {
    const principalId = profile.principal_id;
    /* A recovered or linked browser FOUNDS a family: it is a new cookie jar, not a successor of any other device. */
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
    return { kind: "ok", name: profile.display_name, setCookie: sessionSetCookie(fresh.session_id, secret), principalId };
  }

  /** LIVE-2E adversarial review (H1): every link code of a profile, used or not -- retired together whenever the
   *  account is being secured (a sign-out, "Sign out other devices", a key rotation), so a code minted by a device
   *  that has just been thrown out cannot let it straight back in. */
  private linkHashesOf(profileId: string): string[] {
    return [...this.links.values()].filter((link) => link.profile_id === profileId).map((link) => link.link_hash);
  }

  private forgetLinks(hashes: readonly string[]): void {
    for (const hash of hashes) {
      this.links.delete(hash);
      this.linkIssueOrder.delete(hash);
    }
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

  /** "Link another device": a new single-use code, valid for `linkCodeTtlMs`. The oldest unused codes beyond the
   *  profile's allowance are retired in the same commit. */
  createLinkCode(read: SessionCookieRead, now: number): Promise<ProfileActionOutcome<{ code: string; expiresAt: number }>> {
    return this.serial(async () => {
      const who = this.profiledCurrent(read, now);
      if (typeof who === "string") return { kind: who };
      let minted = mintLinkCode(this.random);
      for (let attempt = 0; this.links.has(linkCodeHash(minted.canonical)); attempt += 1) {
        if (attempt >= 4) throw new Error("identity: 5 consecutive link-code collisions -- the random source is not random");
        minted = mintLinkCode(this.random);
      }
      const record: LinkCredential = {
        link_hash: linkCodeHash(minted.canonical),
        profile_id: who.profile.profile_id,
        created_at: now,
        expires_at: now + this.policy.linkCodeTtlMs,
        consumed_at: null,
      };
      const mine = [...this.links.values()].filter((link) => link.profile_id === who.profile.profile_id);
      const stale = mine.filter((link) => link.consumed_at !== null || now >= link.expires_at);
      const order = (link: LinkCredential) => this.linkIssueOrder.get(link.link_hash) ?? -1;
      const open = mine
        .filter((link) => link.consumed_at === null && now < link.expires_at)
        .sort((a, b) => a.created_at - b.created_at || order(a) - order(b) || (a.link_hash < b.link_hash ? -1 : 1));
      const retired = open.slice(0, Math.max(0, open.length + 1 - this.policy.maxOutstandingLinkCodes));
      const drop = [...stale, ...retired].map((link) => link.link_hash);
      try {
        await this.commit({ expect: [{ kind: "link-absent", link_hash: record.link_hash }], links: [record], dropLinks: drop }, "issuing a device-link code");
      } catch {
        return { kind: "unavailable" as const };
      }
      for (const hash of drop) {
        this.links.delete(hash);
        this.linkIssueOrder.delete(hash);
      }
      this.links.set(record.link_hash, record);
      this.linkIssueOrder.set(record.link_hash, (this.linkIssues += 1));
      this.stats.linkCodesIssued += 1;
      return { kind: "ok" as const, code: minted.display, expiresAt: record.expires_at };
    });
  }

  /** "Rotate recovery key": the old key stops working in the same commit that stores the new one's digest. */
  rotateRecoveryKey(read: SessionCookieRead, now: number, creationReceipt?: unknown): Promise<ProfileActionOutcome<{ recoveryKey: string }>> {
    return this.serial(async () => {
      const who = this.profiledCurrent(read, now);
      if (typeof who === "string") return { kind: who };
      /* ESCROW-3A (brief §10B, owner review): a live session alone NEVER rotates the key. A recent re-authentication by
         THIS session does -- or, once, the lost-create-response rescue: the creating session presenting the creating
         page's receipt, before that page acknowledged the key. */
      const granted = this.sensitiveAuthOf(who.session, who.profile, now);
      const rescue = !granted && this.creationRescueOf(who.session, who.profile, creationReceipt, now);
      if (!granted && !rescue) {
        this.stats.reauthRequired += 1;
        return { kind: "reauth-required" as const };
      }
      let key = mintRecoveryKey(this.random);
      for (let attempt = 0; this.profileOfSelector.has(key.selector); attempt += 1) {
        if (attempt >= 4) throw new Error("identity: 5 consecutive recovery-selector collisions -- the random source is not random");
        key = mintRecoveryKey(this.random);
      }
      const rotated: Profile = { ...who.profile, recovery_selector: key.selector, recovery_hash: secretHash(key.secret), recovery_rotated_at: now };
      const dropLinks = this.linkHashesOf(who.profile.profile_id);
      try {
        await this.commit(
          {
            /* LIVE-3C: COMPARE-AND-SWAP -- the old key dies in the same write that stores the new one, and only if it is
               still the profile's key. */
            expect: [
              { kind: "profile-selector", profile_id: who.profile.profile_id, recovery_selector: who.profile.recovery_selector },
              { kind: "selector-unused", recovery_selector: key.selector },
            ],
            profiles: [rotated],
            dropLinks,
          },
          "rotating a recovery key",
        );
      } catch {
        return { kind: "unavailable" as const };
      }
      this.forgetLinks(dropLinks);
      this.indexProfile(rotated);
      /* The rescue is one-time, and any rotation ends it (the key it would replace is gone). */
      this.creationDeliveries.delete(who.profile.profile_id);
      if (rescue) this.stats.creationRescues += 1;
      /* Every grant made under the old key is stale now (a grant names the selector it was made under). */
      for (const [sessionId, grant] of this.grants) if (grant.selector === who.profile.recovery_selector) this.grants.delete(sessionId);
      this.stats.recoveryRotations += 1;
      this.hooks.onSecurityEvent?.({ kind: "recovery-key-rotated", principalId: who.profile.principal_id, familyIds: [] });
      return { kind: "ok" as const, recoveryKey: key.key };
    });
  }

  /** "Sign out other devices": every other session of this principal ends `signed-out-remotely` (their sockets close
   *  4401); this one stays. Nothing about the profile or its seats changes. */
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
          for (const hash of expiredLinks) {
            this.links.delete(hash);
            this.linkIssueOrder.delete(hash);
          }
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
     A stolen live session is not, by itself, enough to rotate the recovery key, sign out the owner's other devices or
     (ESCROW-4) change a wallet binding: each asks for a RECENT re-authentication by the same session, made by presenting
     the profile's current recovery key again (`POST /gs/api/profile/reauth`). The grant is server-side and in memory
     only; it names the session, its family and the recovery selector it was made under, and lapses after
     `sensitiveAuthMs`. It cannot be borrowed: another session, another family, or the same session after the key was
     rotated (by anyone) finds no grant. No secret is kept -- the key is compared in constant time and dropped. */

  /** Re-authenticate THIS session with its own profile's recovery key. Constant time whatever is wrong. */
  reauthenticate(read: SessionCookieRead, rawKey: unknown, now: number): Promise<ReauthOutcome> {
    return this.serial(async () => {
      const who = this.profiledCurrent(read, now);
      if (typeof who === "string") return { kind: who };
      const parsed = parseRecoveryKey(rawKey);
      const selectorMatches = parsed !== null && parsed.selector === who.profile.recovery_selector;
      /* Compared against this profile's digest when the selector is its own, and against a digest nothing matches
         otherwise: the same work either way, and another profile's (valid) key is `invalid` here. */
      const secretOk = parsed !== null && secretMatches(parsed.secret, selectorMatches ? who.profile.recovery_hash : NO_PROFILE_HASH);
      if (!selectorMatches || !secretOk) {
        this.stats.reauthFailures += 1;
        return { kind: "invalid" as const };
      }
      const expiresAt = now + this.policy.sensitiveAuthMs;
      this.grants.set(who.session.session_id, { family_id: who.session.family_id, selector: who.profile.recovery_selector, expires_at: expiresAt });
      /* Whoever presents the key has it: the initial delivery is resolved. */
      this.creationDeliveries.delete(who.profile.profile_id);
      this.stats.reauths += 1;
      return { kind: "ok" as const, expiresAt };
    });
  }

  /** Whether THIS session holds a live re-authentication under the profile's CURRENT key. */
  private sensitiveAuthOf(session: Session, profile: Profile, now: number): boolean {
    const grant = this.grants.get(session.session_id);
    if (grant === undefined) return false;
    if (now >= grant.expires_at || grant.family_id !== session.family_id || grant.selector !== profile.recovery_selector || this.familyRevoked(session)) {
      this.grants.delete(session.session_id);
      return false;
    }
    return true;
  }

  /** ESCROW-3A (owner review): the lost-create-response rescue. Open only when ALL hold:
   *    - the profile's creation left a delivery record (the creating page sent a receipt) that nothing has closed:
   *      not acknowledged, not re-authenticated with the key, not rotated, not expired, not forgotten by a restart;
   *    - the caller IS the creating session -- the same session id and family: a linked or recovered device, another
   *      tab's later session, a rotation or grace successor never qualifies;
   *    - the key is still the one issued at creation (never rotated since);
   *    - the caller presents the creating page's receipt (compared by digest, in constant time).
   *  A stolen cookie alone therefore never qualifies: the receipt lives only in the creating page's memory, and once
   *  that page has the key it acknowledges it and the record is gone. Checking it consumes nothing; the rotation it
   *  permits deletes it. */
  private creationRescueOf(session: Session, profile: Profile, receipt: unknown, now: number): boolean {
    const pending = this.creationDeliveries.get(profile.profile_id);
    if (pending === undefined) return false;
    if (now >= pending.expires_at || pending.selector !== profile.recovery_selector || profile.recovery_rotated_at !== profile.created_at) {
      this.creationDeliveries.delete(profile.profile_id);
      return false;
    }
    const matches = receiptMatches(receipt, pending.receipt_hash);
    return matches && pending.session_id === session.session_id && pending.family_id === session.family_id && !this.familyRevoked(session);
  }

  /** ESCROW-3A: the creating page received its key -- the initial delivery is resolved and the rescue closes for good.
   *  Only the creating session with its receipt closes it (anyone else's call changes nothing); the answer is the same
   *  either way. */
  acknowledgeKeyDelivery(read: SessionCookieRead, receipt: unknown, now: number): Promise<{ kind: "ok" } | { kind: "not-authenticated" | "profile-required" }> {
    return this.serial(async () => {
      const who = this.profiledCurrent(read, now);
      if (typeof who === "string") return { kind: who };
      const pending = this.creationDeliveries.get(who.profile.profile_id);
      if (pending !== undefined && pending.session_id === who.session.session_id && receiptMatches(receipt, pending.receipt_hash)) {
        this.creationDeliveries.delete(who.profile.profile_id);
        this.stats.keyDeliveriesAcknowledged += 1;
      }
      return { kind: "ok" as const };
    });
  }

  /** Whether a lost-create-response rescue is open for the profile of the session `read` names (tests; operators). */
  hasOpenCreationRescue(read: SessionCookieRead, now: number): boolean {
    const who = this.profiledCurrent(read, now);
    if (typeof who === "string") return false;
    const pending = this.creationDeliveries.get(who.profile.profile_id);
    return pending !== undefined && now < pending.expires_at;
  }

  /** Whether the session a request authenticates with holds a live re-authentication (ESCROW-4's wallet binding asks). */
  hasSensitiveAuth(read: SessionCookieRead, now: number): boolean {
    const who = this.profiledCurrent(read, now);
    return typeof who !== "string" && this.sensitiveAuthOf(who.session, who.profile, now);
  }

  /* ==================================================================
      ESCROW-3A (F-2): WHAT A FINANCIAL CREDENTIAL IS ISSUED UNDER, AND WHETHER IT STILL STANDS
     ================================================================== */

  /** The security context of the session a request authenticates with -- for issuing a credential bound to it.
   *  Server-side only: none of these ids leaves the server. */
  securityContextOf(read: SessionCookieRead, now: number): { principalId: string; familyId: string; recoverySelector: string } | null {
    const who = this.profiledCurrent(read, now);
    return typeof who === "string" ? null : { principalId: who.session.principal_id, familyId: who.session.family_id, recoverySelector: who.profile.recovery_selector };
  }

  /** Whether a credential issued under (principal, family, recovery selector) still stands: the principal and its
   *  profile active, the family open (no sign-out of that device, no sign-out-others, no replacement, no disable), the
   *  recovery key unrotated. Synchronous against committed state. */
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

  /** Test support: a profile's stored shape (the tests assert no plaintext key is in it). */
  peekProfileOf(principalId: string): Readonly<Profile> | undefined {
    const id = this.profileOfPrincipal.get(principalId);
    return id === undefined ? undefined : this.profiles.get(id);
  }

  /** Test support: a session's stored shape (the tests assert no secret is in it). */
  peekSession(sessionId: string): Readonly<Session> | undefined {
    return this.sessions.get(sessionId);
  }

  peekPrincipal(principalId: string): Readonly<Principal> | undefined {
    return this.principals.get(principalId);
  }
}

export { StoreDefiniteError };
