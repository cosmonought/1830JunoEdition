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

import { StoreDefiniteError } from "../persistence/storeResult";
import { sessionSetCookie, type SessionCookieRead } from "./cookies";
import { cryptoRandom, mintPrincipalId, mintSecret, mintSessionId, mintUnique, secretHash, secretMatches, type RandomSource } from "./ids";
import {
  isSecurityRevocation,
  type IdentityChange,
  type IdentitySnapshot,
  type IdentityStore,
  type Principal,
  type RevokeReason,
  type Session,
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
});

/** Why a known session no longer opens anything -- the stable reasons of `401 session-ended`. */
export type SessionEndReason = "expired" | "rotated" | "unreadable" | RevokeReason;

export type BootstrapOutcome =
  | { kind: "ok"; created: boolean; rotated: boolean; expiresAt: number; setCookie: string | null }
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

export interface IdentityHooks {
  /** Sessions that just ended for a SECURITY reason (logout, eviction, operator, principal disabled): their sockets
   *  close 4401. Called after the change is committed. */
  onSessionsEnded?: (sessionIds: readonly string[], principalId: string) => void;
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
  };

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
    return service;
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

  private mintSession(principalId: string, now: number): { session: Session; secret: string } {
    const sessionId = mintUnique(() => mintSessionId(this.random), (id) => this.sessions.has(id));
    const secret = mintSecret(this.random);
    return {
      secret,
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
      },
    };
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
      return { kind: "ok", created: false, rotated: false, expiresAt: (this.sessions.get(session.session_id) as Session).expires_at, setCookie: null };
    });
  }

  private createGuest(now: number): BootstrapOutcome {
    const principalId = mintUnique(() => mintPrincipalId(this.random), (id) => this.principals.has(id));
    const principal: Principal = {
      principal_id: principalId,
      kind: "guest",
      status: "active",
      created_at: now,
      activated_at: null,
      last_seen_at: now,
      account_link: null,
    };
    const { session, secret } = this.mintSession(principalId, now);
    this.principals.set(principalId, principal);
    this.index(session);
    this.provisional.set(principalId, true);
    this.stats.guestsCreated += 1;
    /* THE LRU BOUND (§3.3): the least recently used provisional guest is forgotten -- memory only, never a write. */
    while (this.provisional.size > this.policy.provisionalLimit) {
      const oldest = this.provisional.keys().next().value as string;
      this.provisional.delete(oldest);
      for (const id of [...(this.byPrincipal.get(oldest) ?? [])]) this.forgetSession(id);
      this.principals.delete(oldest);
      this.stats.provisionalEvicted += 1;
    }
    return { kind: "ok", created: true, rotated: false, expiresAt: session.expires_at, setCookie: sessionSetCookie(session.session_id, secret) };
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
    const { session: successor, secret } = this.mintSession(principalId, now);
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
      await this.commit({ sessions: [retired, successor, ...evicted] }, "a session rotation");
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
    return { kind: "ok", created: false, rotated: true, expiresAt: successor.expires_at, setCookie: sessionSetCookie(successor.session_id, secret) };
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
    if (session !== undefined && isSecurityRevocation(session.revoke_reason)) return "revoked";
    const principal = this.principals.get(ctx.principalId);
    if (principal !== undefined && principal.status !== "active") return "revoked";
    return "ok";
  }

  /** The session a revoke request authenticates with: current, not rotated, not ended. */
  currentSession(read: SessionCookieRead, now: number): string | null {
    const auth = this.authenticate(read, now);
    return auth.kind === "ok" ? auth.sessionId : null;
  }

  /** A security revocation (logout, operator). Durable first for an activated principal; its sockets close 4401.
   *
   *  THE PRINCIPAL'S ROTATED PREDECESSORS STILL IN THEIR GRACE END WITH IT (LIVE-2B adversarial review): otherwise
   *  the cookie that was rotated into the revoked one could still bootstrap a fresh successor for 24 hours -- a
   *  logout undone by an older cookie -- and a socket opened on it before the rotation would stay open. */
  revoke(sessionId: string, reason: Exclude<RevokeReason, "rotated" | "principal-disabled">, now: number): Promise<boolean> {
    return this.serial(async () => {
      const session = this.sessions.get(sessionId);
      if (session === undefined || isSecurityRevocation(session.revoke_reason)) return false;
      const revoked: Session = { ...session, revoked_at: now, revoke_reason: reason };
      const predecessors: Session[] = [...(this.byPrincipal.get(session.principal_id) ?? [])]
        .map((id) => this.sessions.get(id) as Session)
        .filter((other) => other.session_id !== sessionId && other.revoke_reason === "rotated" && now - (other.revoked_at ?? 0) < this.policy.rotatedGraceMs)
        .map((other) => ({ ...other, revoked_at: now, revoke_reason: reason }));
      const ended = [revoked, ...predecessors];
      if (this.isDurable(session.principal_id)) await this.commit({ sessions: ended }, `a session revocation (${reason})`);
      for (const record of ended) {
        this.index(record);
        this.dirty.delete(record.session_id);
      }
      this.stats.revocations += ended.length;
      this.hooks.onSessionsEnded?.(
        ended.map((record) => record.session_id),
        session.principal_id,
      );
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
      if (this.isDurable(principalId)) await this.commit({ principals: [disabled], sessions: ended }, "disabling a principal");
      this.principals.set(principalId, disabled);
      for (const session of ended) this.index(session);
      this.stats.revocations += ended.length;
      this.hooks.onSessionsEnded?.(
        ended.map((session) => session.session_id),
        principalId,
      );
      return true;
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
      if (principal === undefined) throw new IdentityUnavailableError("this guest is no longer known to the server");
      if (principal.status !== "active") throw new IdentityUnavailableError("this guest has been disabled");
      if (principal.activated_at !== null) return;
      const activated: Principal = { ...principal, activated_at: now, last_seen_at: now };
      const sessions = [...(this.byPrincipal.get(principalId) ?? [])].map((id) => this.sessions.get(id) as Session);
      await this.commit({ principals: [activated], sessions }, "activating a guest");
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
      const writeBehind = [...this.dirty].filter((id) => !collect.includes(id)).map((id) => this.sessions.get(id) as Session);
      const principals = [...new Set(writeBehind.map((session) => session.principal_id))]
        .map((id) => this.principals.get(id))
        .filter((principal): principal is Principal => principal !== undefined && principal.activated_at !== null);
      if (durableCollect.length > 0 || writeBehind.length > 0) {
        try {
          await this.commit({ sessions: writeBehind, principals, dropSessions: durableCollect }, "the identity write-behind");
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
  sizes(): { principals: number; provisional: number; sessions: number; dirty: number } {
    return { principals: this.principals.size, provisional: this.provisional.size, sessions: this.sessions.size, dirty: this.dirty.size };
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
