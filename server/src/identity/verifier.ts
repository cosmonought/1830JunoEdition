// server/src/identity/verifier.ts
//
// ==================================================================
//  LIVE-6 L6-1: THE IDENTITY VERIFIER -- WHO IS SPEAKING, ANSWERED FROM THE DURABLE RECORDS, WITHOUT BEING THE WRITER
// ==================================================================
//
// Preflight §7.2: exactly ONE task writes identity -- the primary pool's current task, which holds the identity-writer
// role and answers every identity question from its in-memory `IdentityService` (loaded AFTER it took the role, so no
// identity write it cannot see can follow). Every OTHER task (a non-primary pool's) runs this verifier instead:
//
//   - it answers ONLY by reading the durable records -- strongly consistent reads, at the moment of the question, every
//     time. It keeps NO copy of any identity record: nothing is cached, indexed or remembered between two questions, so
//     it can never answer from a stale copy of a writer's memory (a family revoked, a key rotated, a principal disabled
//     on the primary is seen by the very next question);
//   - it NEVER WRITES: this port has no write, the reader it is built on (`IdentityRecordReader`) has none, and the
//     DynamoDB reader (`aws/identity/identityVerifier.ts`) sends nothing but strongly consistent `GetItem`s. So there is
//     no `last_seen` write-behind, no rotation, no grant, no sweep, no security event -- and no role: it never reads,
//     takes or names the identity-writer role, and nothing it does needs one;
//   - it FAILS CLOSED: a record that cannot be read (a timeout, a throttle), one that is damaged or of another layout,
//     one that is missing where the records require it (a session whose principal or family is not there, a profiled
//     principal whose profile is not), or records that disagree with each other, is `unavailable` -- never `ok`, never
//     guessed. Only a question the records answer is answered.
//
// THE ANSWERS ARE THE WRITER'S, DECISION FOR DECISION -- `IdentityService.authenticate` (the upgrade's step 5),
// `isProfiled` (step 5b and every frame's defence in depth) and `socketVerdict` (every frame): the same record fields,
// read the same way, give the same verdict. The differences are only in the direction of refusing more, never less:
//   - `authenticate` does not `touch` (no write-behind): the socket's frozen expiry is the session's DURABLE
//     `expires_at`, which a writer's unflushed sliding expiry can only have moved LATER -- so a socket opened here ends
//     no later than the writer's would;
//   - a record the writer's snapshot check would call damage (a session without its family, a family of another
//     principal, a profiled principal without its profile) is `unavailable` here, where the writer refuses to load at
//     all;
//   - a session gone from the table at a frame's re-check is `unavailable` (the writer's index would keep it).
// Neither answer ever lets through what the writer would refuse. The provisional-guest cap is moot: a provisional guest
// is never durable, so its cookie is `unknown` here (the writer would refuse it at the profile step anyway).
//
// WHAT IT IS FOR (L6-1): a non-primary task authenticates a socket at the upgrade and re-checks it on every frame, then
// answers a game it does not serve with a route -- the destination is operational information, never an authority, and
// the task that serves the game authenticates the socket again itself.

import { SESSION_ID_PATTERN, secretMatches } from "./ids";
import type { SessionCookieRead } from "./cookies";
import { isSecurityRevocation, type Principal, type Profile, type Session, type SessionFamily } from "./store";

/** A record the reader could not give: a failed read, damage, another layout. The message names the record class only --
 *  never an id, a hash or a value. */
export class IdentityRecordUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityRecordUnreadableError";
  }
}

/**
 * Strongly consistent reads of single identity records, by id. `null`: there is no such record. Throws
 * (`IdentityRecordUnreadableError`, or the read's own error) when the record cannot be given as a well-formed record of
 * this build's layout. Read-only by construction: this is the whole interface.
 */
export interface IdentityRecordReader {
  session(sessionId: string): Promise<Session | null>;
  principal(principalId: string): Promise<Principal | null>;
  family(familyId: string): Promise<SessionFamily | null>;
  profile(profileId: string): Promise<Profile | null>;
}

/** The upgrade's authentication (the writer's `UpgradeAuth`, plus `profiled` -- step 5b from the same reads -- and
 *  `unavailable`, which the writer's in-memory answer never needs). */
export type VerifiedAuth =
  | { readonly kind: "ok"; readonly principalId: string; readonly sessionId: string; readonly sessionExpiresAt: number; readonly provisional: boolean; readonly profiled: boolean }
  | { readonly kind: "refused"; readonly why: "no-cookie" | "malformed" | "unknown" | "ended" }
  /** The records could not answer (a failed read, damage, records that disagree): refused, and never charged to the caller. */
  | { readonly kind: "unavailable"; readonly detail: string };

/** A frame's re-check (the writer's `SocketVerdict`, plus `profiled` and `unavailable`). */
export type VerifiedSocket =
  | { readonly kind: "ok"; readonly profiled: boolean }
  | { readonly kind: "expired" }
  | { readonly kind: "revoked" }
  | { readonly kind: "unavailable"; readonly detail: string };

export interface SessionVerifier {
  /** The upgrade's step 5 and 5b, from the durable records read now. Never writes. */
  authenticate(read: SessionCookieRead, now: number): Promise<VerifiedAuth>;
  /** A frame's re-check of a socket's frozen context, from the durable records read now. Never writes. */
  recheck(ctx: { readonly principalId: string; readonly sessionId: string; readonly sessionExpiresAt: number }, now: number): Promise<VerifiedSocket>;
}

const describe = (error: unknown): string => (error instanceof IdentityRecordUnreadableError ? error.message : `a read failed (${(error as { name?: string } | null)?.name ?? "error"})`);

/** Whether an active principal is profiled -- the writer's `activeProfileOf`, with the one extra consistency check the
 *  writer's snapshot load makes (the profile names this principal). Throws when the records disagree. */
async function profiledOf(reader: IdentityRecordReader, principal: Principal): Promise<boolean> {
  if (principal.status !== "active" || principal.kind !== "profile") return false;
  if (principal.account_link === null) throw new IdentityRecordUnreadableError("a profiled principal names no profile");
  const profile = await reader.profile(principal.account_link);
  if (profile === null) throw new IdentityRecordUnreadableError("a profiled principal's profile is not in the records");
  if (profile.principal_id !== principal.principal_id) throw new IdentityRecordUnreadableError("a principal's profile names another principal");
  return profile.status === "active";
}

/** The verifier over a reader (the DynamoDB one in production; a snapshot one in the tests). */
export function createSessionVerifier(reader: IdentityRecordReader): SessionVerifier {
  return {
    async authenticate(read, now) {
      /* The writer's order (`IdentityService.authenticate`), then its `isProfiled`. */
      if (read.kind === "none") return { kind: "refused", why: "no-cookie" };
      if (read.kind === "malformed") return { kind: "refused", why: "malformed" };
      if (!SESSION_ID_PATTERN.test(read.sessionId)) return { kind: "refused", why: "unknown" };
      try {
        const session = await reader.session(read.sessionId);
        /* Nothing more is read for a cookie whose secret does not match: an unauthenticated caller costs one read. */
        if (session === null || !secretMatches(read.secret, session.secret_hash)) return { kind: "refused", why: "unknown" };
        const [principal, family] = await Promise.all([reader.principal(session.principal_id), reader.family(session.family_id)]);
        /* The writer's snapshot never holds a session without its principal and its own family: damage, not an answer. */
        if (principal === null) return { kind: "unavailable", detail: "a session's principal is not in the records" };
        if (family === null) return { kind: "unavailable", detail: "a session's family is not in the records" };
        if (family.principal_id !== session.principal_id) return { kind: "unavailable", detail: "a session's family belongs to another principal" };
        if (principal.status !== "active") return { kind: "refused", why: "ended" };
        if (session.revoked_at !== null || now >= session.expires_at) return { kind: "refused", why: "ended" };
        if (family.revoked_at !== null) return { kind: "refused", why: "ended" };
        const profiled = await profiledOf(reader, principal);
        return {
          kind: "ok",
          principalId: principal.principal_id,
          sessionId: session.session_id,
          /* The DURABLE expiry: no touch, no write-behind (see the header -- never later than the writer's). */
          sessionExpiresAt: session.expires_at,
          provisional: principal.activated_at === null,
          profiled,
        };
      } catch (error) {
        return { kind: "unavailable", detail: describe(error) };
      }
    },

    async recheck(ctx, now) {
      /* The writer's `socketVerdict`: the frozen expiry first, then a security revocation of the session or its family,
         then the principal; and `isProfiled`, which every frame asks too. */
      if (now >= ctx.sessionExpiresAt) return { kind: "expired" };
      try {
        const [session, principal] = await Promise.all([reader.session(ctx.sessionId), reader.principal(ctx.principalId)]);
        if (session === null) return { kind: "unavailable", detail: "a socket's session is no longer in the records" };
        if (session.principal_id !== ctx.principalId) return { kind: "unavailable", detail: "a socket's session names another principal" };
        if (principal === null) return { kind: "unavailable", detail: "a socket's principal is not in the records" };
        if (isSecurityRevocation(session.revoke_reason)) return { kind: "revoked" };
        const family = await reader.family(session.family_id);
        if (family === null) return { kind: "unavailable", detail: "a session's family is not in the records" };
        if (family.principal_id !== session.principal_id) return { kind: "unavailable", detail: "a session's family belongs to another principal" };
        if (family.revoked_at !== null) return { kind: "revoked" };
        if (principal.status !== "active") return { kind: "revoked" };
        return { kind: "ok", profiled: await profiledOf(reader, principal) };
      } catch (error) {
        return { kind: "unavailable", detail: describe(error) };
      }
    },
  };
}

/** A reader over a committed identity snapshot (the tests: the same records the writer loaded, read one at a time). */
export function snapshotRecordReader(snapshot: {
  readonly principals: readonly Principal[];
  readonly sessions: readonly Session[];
  readonly profiles?: readonly Profile[];
  readonly families?: readonly SessionFamily[];
}): IdentityRecordReader {
  const by = <T>(records: readonly T[] | undefined, id: (record: T) => string) => new Map((records ?? []).map((record) => [id(record), record] as const));
  const sessions = by(snapshot.sessions, (record) => record.session_id);
  const principals = by(snapshot.principals, (record) => record.principal_id);
  const families = by(snapshot.families, (record) => record.family_id);
  const profiles = by(snapshot.profiles, (record) => record.profile_id);
  return {
    session: async (id) => sessions.get(id) ?? null,
    principal: async (id) => principals.get(id) ?? null,
    family: async (id) => families.get(id) ?? null,
    profile: async (id) => profiles.get(id) ?? null,
  };
}
