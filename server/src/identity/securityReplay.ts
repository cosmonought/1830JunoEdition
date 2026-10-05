// server/src/identity/securityReplay.ts
//
// ==================================================================
//  LIVE-6 L6-4: THE IDENTITY RESTORE'S REPLAY OF THE SECURITY-EVENT JOURNAL -- PURE, DETERMINISTIC, IDEMPOTENT
// ==================================================================
//
// An identity table restored to a point in time T holds the identity set as it stood at T. The security-event journal
// (`securityEvents.ts`, the ledger's `SEC#` items) is OUTSIDE that restore domain and holds every security change ever
// made, journal-first. This module computes, from (the restored table as it stands now, the WHOLE journal), the changes
// that make the table safe to serve: no security action the journal records is undone, and every session is signed out.
// It reads nothing and writes nothing (the DynamoDB application is `aws/identity/identityRestore.ts`).
//
// THE RULES -- exactly `securityEvents.ts`'s header (L5-4), and the owner's decision (2026-09-29):
//   sessions             EVERY session is signed out (revoked `operator`, or `principal-disabled` for a disabled
//                        principal) and EVERY family closed: plain rotations and single evictions are not journaled, so
//                        only a global sign-out can end what they ended after T. Every link code is dropped too (a link
//                        code is a credential that issues a session). Sensitive-auth grants die with their sessions (the
//                        application also removes their items).
//   family-revoked, signed-out-others, principal-disabled
//                        re-applied whether confirmed or not -- they only end authority. A family the restored table does
//                        not hold (created after T) has nothing to end; a principal-disabled disables the principal.
//   profile-created      the principal's CONFIRMED creation when there is one (at most one), otherwise its LAST creation
//                        (by the journal's key order: time, then event id), confirmed or not. A profile the restored table
//                        already holds is PROOF its creation committed: it stands (a confirmed creation of another profile
//                        is a contradiction -- refused). Nothing else ever makes a profile.
//   recovery-key-rotated, CONFIRMED
//                        one step of the chain: `from_selector` dead, `to_selector` live -- followed from the key the
//                        restored table holds, so steps already in the table are not re-applied and a resumed replay
//                        continues from wherever it stopped.
//   recovery-key-rotated, UNCONFIRMED (the OWNER DECISION)
//                        `from_selector` retired; `to_selector` NEVER installed (and if the restored table already holds
//                        it, it is taken out); the profile goes to OPERATOR REVIEW -- `disabled`, with a review record
//                        naming the events. The profile keeps the confirmed chain's head as its key only when that key is
//                        neither a retired `from_selector` nor an unconfirmed `to_selector`; otherwise it gets a
//                        QUARANTINE key nobody holds (a selector and a digest derived from the restore and the profile, the
//                        digest of a text far longer than a key, so no key can match it). Either way no selector whose
//                        outcome is unknown is accepted, and nothing the player asked to end comes back.
//   USERNAMES (P3-ACCT)  a username is unique. Each is WON by the profile the restored table gives it, else by the
//                        profile a CONFIRMED event gives it (two different ones: refused), else by the profile of its LAST
//                        unconfirmed claim (journal order: time, then event id) -- an earlier claimant's write could not
//                        have committed (the username's uniqueness is checked inside every write). A creation or a
//                        `credentials-established` whose username another profile won was never committed: not installed.
//   credentials-established (P3-ACCT)
//                        a legacy profile's username and password: the confirmed one, else the last, installed on a
//                        profile that has none (a table profile holding a different one than a confirmed event: refused).
//   WALLETS (P3-ACCT)    every profile's persisted wallet is CLEARED (not journaled: re-proven on the next money action).
//
// THE PROPERTIES (what the tests pin):
//   deterministic   a function of (the table's identity set, the journal as a SET, the restore id, the replay's fixed
//                   time `at`): the journal is de-duplicated by key and sorted; principals in id order; every time the
//                   replay writes is `at` or an event's own time.
//   idempotent      a change is made only where the table differs from the target; the target is invariant under the
//                   replay's own changes (a revocation is never undone or rewritten; a key already advanced is followed
//                   from where it is; the quarantine key is recognised as this restore's) -- so a second run, or a run
//                   resumed after any prefix of the changes, plans exactly what is left and then nothing. A confirmation
//                   that arrives between two runs (the journal grew) is honoured: the replay's OWN review of that
//                   profile (`reviews`: its review record is in the table) is withdrawn -- the profile active again
//                   with the confirmed chain's key -- the same table as a replay that saw it from the start.
//   strict          an event that is not a well-formed event, two different events under one key, one event id at two
//                   keys, a confirmation of nothing (or of another kind), two confirmed creations, a key rotation of
//                   another principal's profile, two rotations to one key, two confirmed rotations from one key, a
//                   cycle, a family of another principal: `SecurityReplayError` -- the replay stops, and the table
//                   stays unserved (fail closed). Messages name kinds and event ids, never a selector or a hash.

import { createHash } from "crypto";

import { base32Lower, ID_BYTES } from "./ids";
import { isSecurityEvent, securityEventBody, securityEventSortKey, type SecurityEvent } from "./securityEvents";
import { asSchema2, loginOf, walletOf, type FullIdentitySnapshot, type IdentityChange, type IdentityPrecondition, type Principal, type Profile, type RevokeReason, type Session, type SessionFamily } from "./store";

export class SecurityReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityReplayError";
  }
}

export interface ReplayInput {
  /** The restored identity table's identity set, as it stands now (a replay resumed after a prefix sees that prefix). */
  readonly snapshot: FullIdentitySnapshot;
  /** The WHOLE journal, in any order; an event repeated exactly is read once. */
  readonly events: readonly SecurityEvent[];
  readonly restoreId: string;
  /** The replay's own fixed time (the restore marker's `started_at`): every sign-out and quarantine carries it. */
  readonly at: number;
  /** The review records the table holds (any restore's). THIS restore's (a resumed replay): the profile's disabled status
   *  is the replay's own doing, withdrawn when the journal no longer calls for a review. ANOTHER restore's still open:
   *  its disabled status is not this replay's to withdraw. Any restore's: that restore's quarantine key is recognised as
   *  a quarantine (never a key the journal contradicts), and replaced by this restore's where a key is still unsettled. */
  readonly reviews?: ReadonlyArray<{ readonly profile_id: string; readonly restore_id: string; readonly resolved_at: number | null; readonly prior_status: "active" | "disabled" }>;
}

export interface ReviewDraft {
  readonly profile_id: string;
  readonly principal_id: string;
  readonly unconfirmed_events: readonly string[];
  readonly confirmed_events: readonly string[];
  readonly selector_state: "confirmed-head-retained" | "quarantined";
  /** The profile's status before this restore's review (kept from this restore's own record on a resume). */
  readonly prior_status: "active" | "disabled";
  /** Evidence for the operator (not a decision; from the journal alone, so a resumed replay reports the same): a
   *  confirmed rotation starts from an unconfirmed one's new key -- so that one did commit. */
  readonly evidence: { readonly later_confirmed_from_unconfirmed: boolean };
}

export interface PrincipalReplay {
  readonly principal_id: string;
  /** `null`: nothing to change for this principal (already as the target). */
  readonly change: IdentityChange | null;
  readonly review: ReviewDraft | null;
  /** This restore's own review record of the profile is to be removed (the journal no longer calls for it). */
  readonly dropReview: string | null;
}

export interface ReplayReport {
  readonly principals: number;
  readonly events: { readonly total: number; readonly confirmations: number; readonly by_kind: Readonly<Record<string, number>>; readonly unconfirmed_changes: number };
  readonly changes: number;
  readonly profiles_created: number;
  readonly keys_advanced: number;
  readonly reviews: number;
  /** Reviews this restore opened earlier and withdraws (a confirmation arrived since). */
  readonly reviews_withdrawn: number;
  readonly principals_disabled: number;
  readonly families_closed: number;
  readonly sessions_signed_out: number;
  readonly links_dropped: number;
  /** Families named by the journal that the restored table never held (created after T): nothing to end. */
  readonly families_unknown_to_table: number;
  /** P3-ACCT: legacy profiles whose username and password the journal installed. */
  readonly credentials_installed: number;
  /** P3-ACCT: profiles whose persisted wallet the restore cleared. */
  readonly wallets_cleared: number;
}

export interface ReplayPlan {
  readonly journal: { readonly digest: string; readonly events: number };
  /** Only principals with something to do (a change, or a review record), in principal-id order. */
  readonly principals: readonly PrincipalReplay[];
  readonly reviews: readonly ReviewDraft[];
  readonly report: ReplayReport;
}

/* ------------------------------------------------------------------ */
/* The journal as a set                                                */
/* ------------------------------------------------------------------ */

/** The journal de-duplicated by key and sorted (principal, then time, then id), and its digest. Strict. */
export function canonicalJournal(events: readonly SecurityEvent[]): { readonly events: SecurityEvent[]; readonly digest: string } {
  const byKey = new Map<string, { readonly event: SecurityEvent; readonly body: string }>();
  for (const [at, event] of events.entries()) {
    if (!isSecurityEvent(event)) throw new SecurityReplayError(`journal entry #${at} is not a well-formed security event`);
    const key = `${event.principal_id}|${securityEventSortKey(event)}`;
    const body = securityEventBody(event);
    const seen = byKey.get(key);
    if (seen !== undefined && seen.body !== body) throw new SecurityReplayError(`two different events are stored under one journal key (event ${event.event_id})`);
    byKey.set(key, { event, body });
  }
  const keys = [...byKey.keys()].sort();
  const hash = createHash("sha256").update("18COSMOS/SECURITY-JOURNAL-DIGEST/v1\n");
  for (const key of keys) hash.update(`${key}|${(byKey.get(key) as { body: string }).body}\n`);
  return { events: keys.map((key) => (byKey.get(key) as { event: SecurityEvent }).event), digest: hash.digest("hex") };
}

/* ------------------------------------------------------------------ */
/* The quarantine key                                                  */
/* ------------------------------------------------------------------ */

const QUARANTINE_SELECTOR_TAG = "18COSMOS/IDENTITY-RESTORE/QUARANTINE-SELECTOR/v1\n";
const QUARANTINE_DIGEST_TAG = "18COSMOS/IDENTITY-RESTORE/QUARANTINE-DIGEST/v1\n";

/** The key a profile under review gets when no key it had may stay live: a selector and a digest derived from the restore
 *  and the profile (deterministic, so a resumed replay recognises it). The digest is SHA-256 of a text far longer than 32
 *  bytes; a recovery key is 32 bytes whose SHA-256 must equal it -- a second preimage nobody can find. (The profile is
 *  `disabled` besides: recovery refuses it before any comparison matters.) */
export function quarantineKeyOf(restoreId: string, profileId: string): { readonly selector: string; readonly digest: string } {
  const selector = `rk_${base32Lower(createHash("sha256").update(QUARANTINE_SELECTOR_TAG).update(`${restoreId}\n${profileId}`).digest().subarray(0, ID_BYTES))}`;
  const digest = createHash("sha256").update(QUARANTINE_DIGEST_TAG).update(`${restoreId}\n${profileId}\n`).digest("hex");
  return { selector, digest };
}

/* ------------------------------------------------------------------ */
/* The plan                                                            */
/* ------------------------------------------------------------------ */

type Rotation = Extract<SecurityEvent, { kind: "recovery-key-rotated" }>;
type Creation = Extract<SecurityEvent, { kind: "profile-created" }>;
type Establishment = Extract<SecurityEvent, { kind: "credentials-established" }>;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The replay plan (see the header). Throws `SecurityReplayError` when the journal, or the journal against the table,
 *  cannot be read without guessing. */
export function planSecurityReplay(input: ReplayInput): ReplayPlan {
  if (!Number.isSafeInteger(input.at) || input.at < 0) throw new SecurityReplayError("the replay's time must be whole milliseconds");
  const journal = canonicalJournal(input.events);
  const snapshot = input.snapshot;
  const principals = new Map(snapshot.principals.map((record) => [record.principal_id, record] as const));
  const profileOfPrincipal = new Map(snapshot.profiles.map((record) => [record.principal_id, record] as const));
  const profilesById = new Map(snapshot.profiles.map((record) => [record.profile_id, record] as const));
  const profileOfSelector = new Map(snapshot.profiles.map((record) => [record.recovery_selector, record.profile_id] as const));
  const families = new Map(snapshot.families.map((record) => [record.family_id, record] as const));
  const familiesOf = new Map<string, SessionFamily[]>();
  for (const family of snapshot.families) familiesOf.set(family.principal_id, [...(familiesOf.get(family.principal_id) ?? []), family]);
  const sessionsOf = new Map<string, Session[]>();
  for (const session of snapshot.sessions) sessionsOf.set(session.principal_id, [...(sessionsOf.get(session.principal_id) ?? []), session]);
  const eventsOf = new Map<string, SecurityEvent[]>();
  for (const event of journal.events) eventsOf.set(event.principal_id, [...(eventsOf.get(event.principal_id) ?? []), event]);

  const byKind: Record<string, number> = {};
  for (const event of journal.events) byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
  const counters = { withdrawn: 0, changes: 0, created: 0, advanced: 0, disabled: 0, familiesClosed: 0, signedOut: 0, links: 0, unknownFamilies: 0, unconfirmed: 0, credentials: 0, wallets: 0 };

  /* ---- P3-ACCT: who wins each username (the header's rule), over the whole journal ---- */
  const confirmedAnywhere = new Set<string>();
  {
    const kindOf = new Map(journal.events.map((event) => [`${event.principal_id}|${event.event_id}`, event.kind] as const));
    for (const event of journal.events) {
      if (event.kind === "confirmed" && kindOf.get(`${event.principal_id}|${event.confirms}`) === event.confirmed_kind) confirmedAnywhere.add(`${event.principal_id}|${event.confirms}`);
    }
  }
  const loginClaims = new Map<string, Array<{ readonly profileId: string; readonly confirmed: boolean; readonly order: string; readonly eventId: string }>>();
  for (const event of journal.events) {
    const claim =
      event.kind === "profile-created" ? (() => {
        const login = loginOf(event.profile);
        return login === null ? null : { key: login.key, profileId: event.profile.profile_id };
      })()
      : event.kind === "credentials-established" ? { key: event.login_key, profileId: event.profile_id }
      : null;
    if (claim === null) continue;
    loginClaims.set(claim.key, [...(loginClaims.get(claim.key) ?? []), { profileId: claim.profileId, confirmed: confirmedAnywhere.has(`${event.principal_id}|${event.event_id}`), order: `${securityEventSortKey(event)}#${event.principal_id}`, eventId: event.event_id }]);
  }
  const tableLogins = new Map<string, string>();
  for (const record of snapshot.profiles) {
    const login = loginOf(record);
    if (login !== null) tableLogins.set(login.key, record.profile_id);
  }
  const loginWinner = (key: string): string | undefined => {
    const held = tableLogins.get(key);
    const claims = loginClaims.get(key) ?? [];
    const confirmedBy = [...new Set(claims.filter((claim) => claim.confirmed).map((claim) => claim.profileId))];
    if (held !== undefined) {
      if (confirmedBy.some((profileId) => profileId !== held)) throw new SecurityReplayError(`a confirmed event gives a username the restored table holds to another profile (${claims.find((claim) => claim.confirmed && claim.profileId !== held)?.eventId})`);
      return held;
    }
    if (confirmedBy.length > 1) throw new SecurityReplayError(`two profiles' confirmed events claim one username (${claims.filter((claim) => claim.confirmed).map((claim) => claim.eventId).join(", ")})`);
    if (confirmedBy.length === 1) return confirmedBy[0];
    const last = [...claims].sort((a, b) => byText(a.order, b.order)).pop();
    return last?.profileId;
  };
  const out: PrincipalReplay[] = [];
  const reviews: ReviewDraft[] = [];

  const ids = [...new Set([...principals.keys(), ...eventsOf.keys()])].sort(byText);
  for (const principalId of ids) {
    const events = eventsOf.get(principalId) ?? []; // already in key order (time, then id)
    /* Confirmations pair BY ID (never by position): each names an event of this principal, of the kind it says. */
    const byId = new Map<string, SecurityEvent>();
    for (const event of events) {
      if (byId.has(event.event_id)) throw new SecurityReplayError(`event ${event.event_id} is stored twice under different times`);
      byId.set(event.event_id, event);
    }
    const confirmed = new Set<string>();
    for (const event of events) {
      if (event.kind !== "confirmed") continue;
      const target = byId.get(event.confirms);
      if (target === undefined) throw new SecurityReplayError(`confirmation ${event.event_id} names an event (${event.confirms}) this principal's journal does not hold`);
      if (target.kind !== event.confirmed_kind) throw new SecurityReplayError(`confirmation ${event.event_id} says ${event.confirmed_kind} but names a ${target.kind} event`);
      confirmed.add(event.confirms);
    }
    for (const event of events) if (event.kind !== "confirmed" && !confirmed.has(event.event_id)) counters.unconfirmed += 1;

    const tablePrincipal = principals.get(principalId);
    const tableProfile = profileOfPrincipal.get(principalId);

    /* ---- the profile: the table's (proof of commit), else the confirmed creation, else the last one ---- */
    const creations = events.filter((event): event is Creation => event.kind === "profile-created");
    const confirmedCreations = creations.filter((event) => confirmed.has(event.event_id));
    if (new Set(confirmedCreations.map((event) => event.profile.profile_id)).size > 1) throw new SecurityReplayError(`principal has two confirmed profile creations (${confirmedCreations.map((event) => event.event_id).join(", ")})`);
    let chosen: Creation | undefined = confirmedCreations[0] ?? creations[creations.length - 1];
    /* P3-ACCT: a creation whose username another profile won never committed (a confirmed one losing it is refused). */
    const chosenLogin = chosen === undefined ? null : loginOf(chosen.profile);
    if (chosen !== undefined && chosenLogin !== null && tableProfile === undefined && loginWinner(chosenLogin.key) !== chosen.profile.profile_id) {
      if (confirmed.has(chosen.event_id)) throw new SecurityReplayError(`creation ${chosen.event_id}: its username is another profile's`);
      chosen = undefined;
    }
    let principal: Principal | undefined = tablePrincipal;
    let profile: Profile | undefined = tableProfile;
    let created = false;
    if (tableProfile !== undefined) {
      if (confirmedCreations.length > 0 && confirmedCreations[0].profile.profile_id !== tableProfile.profile_id) {
        throw new SecurityReplayError(`the restored table holds another profile than the principal's confirmed creation (${confirmedCreations[0].event_id})`);
      }
    } else if (chosen !== undefined) {
      if (tablePrincipal !== undefined && tablePrincipal.kind !== "unprofiled") throw new SecurityReplayError(`creation ${chosen.event_id}: the restored principal is already profiled`);
      if (profilesById.has(chosen.profile.profile_id)) throw new SecurityReplayError(`creation ${chosen.event_id}: its profile id is another principal's in the restored table`);
      principal = { ...chosen.principal, status: tablePrincipal?.status === "disabled" ? "disabled" : chosen.principal.status };
      profile = { ...chosen.profile };
      created = true;
    }

    /* The profile's status before THIS restore's review: from this restore's own review record when one is in the table
       (a resume: the table's status is then the review's own doing), else the status the profile has now. */
    const ownRecord = profile === undefined ? undefined : (input.reviews ?? []).find((entry) => entry.profile_id === profile?.profile_id && entry.restore_id === input.restoreId);
    const priorStatus: "active" | "disabled" = ownRecord?.prior_status ?? profile?.status ?? "active";

    /* ---- the recovery key: the confirmed chain from the table's key; unconfirmed rotations to review ---- */
    const rotations = events.filter((event): event is Rotation => event.kind === "recovery-key-rotated");
    let review: ReviewDraft | null = null;
    let keyAdvanced = false;
    if (rotations.length > 0) {
      if (profile === undefined) throw new SecurityReplayError(`key rotation ${rotations[0].event_id} names a profile this principal does not have`);
      const profileId = profile.profile_id;
      for (const rotation of rotations) if (rotation.profile_id !== profileId) throw new SecurityReplayError(`key rotation ${rotation.event_id} names another profile than this principal's`);
      const toCount = new Map<string, number>();
      for (const rotation of rotations) toCount.set(rotation.to_selector, (toCount.get(rotation.to_selector) ?? 0) + 1);
      if ([...toCount.values()].some((count) => count > 1)) throw new SecurityReplayError("two key rotations install the same key");
      const confirmedFrom = new Map<string, Rotation>();
      const confirmedTo = new Map<string, Rotation>();
      for (const rotation of rotations) {
        if (!confirmed.has(rotation.event_id)) continue;
        if (confirmedFrom.has(rotation.from_selector)) throw new SecurityReplayError(`two confirmed key rotations start from one key (${confirmedFrom.get(rotation.from_selector)?.event_id}, ${rotation.event_id})`);
        confirmedFrom.set(rotation.from_selector, rotation);
        confirmedTo.set(rotation.to_selector, rotation);
      }
      const unconfirmed = rotations.filter((rotation) => !confirmed.has(rotation.event_id));
      /* The confirmed rotations form SEGMENTS of the key's history: one chain when every confirmation arrived, several
         when one in the middle was lost (the unconfirmed rotation between them is the gap -- confirmations are best
         effort, so that is a real journal, never a contradiction). Refused only: a cycle, or two confirmed rotations
         from one key (checked above), or two installing one key (checked above). */
      const segmentOf = new Map<string, number>();
      const ends: Rotation[] = [];
      const starts = [...confirmedFrom.keys()].filter((key) => !confirmedTo.has(key)).sort(byText);
      for (const [index, first] of starts.entries()) {
        segmentOf.set(first, index);
        let last: Rotation | null = null;
        for (let edge = confirmedFrom.get(first); edge !== undefined; edge = confirmedFrom.get(edge.to_selector)) {
          if (segmentOf.has(edge.to_selector)) throw new SecurityReplayError(`the confirmed key rotations form a cycle (${edge.event_id})`);
          segmentOf.set(edge.to_selector, index);
          last = edge;
        }
        ends.push(last as Rotation);
      }
      if (segmentOf.size !== confirmedFrom.size + starts.length) throw new SecurityReplayError("the confirmed key rotations form a cycle");
      const retired = new Set(rotations.map((rotation) => rotation.from_selector));
      const unknownOutcome = new Set(unconfirmed.map((rotation) => rotation.to_selector));
      const quarantine = quarantineKeyOf(input.restoreId, profileId);
      if (retired.has(quarantine.selector) || toCount.has(quarantine.selector)) throw new SecurityReplayError("the quarantine key collides with a journaled key");
      /* The head: from the key the table holds. On a segment -> that segment's end (steps before T are already in the
         table). This restore's own quarantine key -> the end of the ONE chain when every rotation is now confirmed (a
         confirmation arrived since this restore quarantined the key: the replay converges on what the journal now says),
         else the quarantine key stays. Off every segment: kept only to be judged below (an implicated key is
         quarantined); a key the journal contradicts (on no segment, not implicated, while confirmed rotations exist) is
         refused. */
      const s0 = profile.recovery_selector;
      /* Earlier restores' quarantine keys of this profile (named by their review records): a quarantine, never a key. */
      const priorQuarantine = new Set((input.reviews ?? []).filter((entry) => entry.profile_id === profileId && entry.restore_id !== input.restoreId).map((entry) => quarantineKeyOf(entry.restore_id, profileId).selector));
      const isQuarantine = s0 === quarantine.selector || priorQuarantine.has(s0);
      let head = s0;
      let digest = profile.recovery_hash;
      let rotatedAt = profile.recovery_rotated_at;
      const segment = isQuarantine ? (starts.length === 1 && unconfirmed.length === 0 ? 0 : undefined) : segmentOf.get(s0);
      if (segment !== undefined) {
        const end = ends[segment];
        head = end.to_selector;
        digest = end.recovery_hash;
        rotatedAt = end.rotated_at;
      } else if (!isQuarantine && starts.length > 0 && !retired.has(s0) && !unknownOutcome.has(s0)) {
        throw new SecurityReplayError("the restored table's key is on none of the journal's confirmed rotations and not implicated by any");
      }
      let state: ReviewDraft["selector_state"] = "confirmed-head-retained";
      if (head === quarantine.selector) {
        state = "quarantined"; // a resumed replay: this restore already quarantined the key
      } else if (retired.has(head) || unknownOutcome.has(head) || priorQuarantine.has(head)) {
        head = quarantine.selector;
        digest = quarantine.digest;
        rotatedAt = input.at;
        state = "quarantined";
      }
      const holder = profileOfSelector.get(head);
      if (holder !== undefined && holder !== profileId) throw new SecurityReplayError("the key the replay would install is another profile's");
      if (unconfirmed.length > 0) {
        review = {
          profile_id: profileId,
          principal_id: principalId,
          unconfirmed_events: unconfirmed.map((rotation) => rotation.event_id).sort(byText),
          confirmed_events: rotations.filter((rotation) => confirmed.has(rotation.event_id)).map((rotation) => rotation.event_id).sort(byText),
          selector_state: state,
          prior_status: priorStatus,
          evidence: { later_confirmed_from_unconfirmed: unconfirmed.some((rotation) => confirmedFrom.has(rotation.to_selector)) },
        };
      } else if (state === "quarantined") {
        throw new SecurityReplayError("a quarantine key without an unconfirmed rotation or a confirmed chain (the table is not this replay's)");
      }
      keyAdvanced = head !== profile.recovery_selector;
      profile = { ...profile, recovery_selector: head, recovery_hash: digest, recovery_rotated_at: rotatedAt };
    }
    /* ---- P3-ACCT: a legacy profile's username and password (the header's rule) ---- */
    const establishments = events.filter((event): event is Establishment => event.kind === "credentials-established");
    let credentialsInstalled: string | null = null;
    if (establishments.length > 0) {
      if (profile === undefined) throw new SecurityReplayError(`credentials ${establishments[0].event_id} name a profile this principal does not have`);
      const profileId = profile.profile_id;
      for (const event of establishments) if (event.profile_id !== profileId) throw new SecurityReplayError(`credentials ${event.event_id} name another profile than this principal's`);
      const confirmedEstablishments = establishments.filter((event) => confirmed.has(event.event_id));
      if (new Set(confirmedEstablishments.map((event) => `${event.login_key}|${event.password_hash}`)).size > 1) throw new SecurityReplayError(`two different confirmed credentials (${confirmedEstablishments.map((event) => event.event_id).join(", ")})`);
      const held = loginOf(profile);
      if (held !== null) {
        const first = confirmedEstablishments[0];
        if (first !== undefined && (first.login_key !== held.key || first.password_hash !== held.hash)) throw new SecurityReplayError(`credentials ${first.event_id} are not the ones the profile holds`);
      } else {
        const pick = confirmedEstablishments[0] ?? establishments[establishments.length - 1];
        if (loginWinner(pick.login_key) === profileId) {
          profile = { ...asSchema2(profile), login_key: pick.login_key, login_name: pick.login_name, password_hash: pick.password_hash, password_set_at: pick.set_at };
          credentialsInstalled = pick.login_key;
        } else if (confirmed.has(pick.event_id)) {
          throw new SecurityReplayError(`credentials ${pick.event_id}: the username is another profile's`);
        }
      }
    }
    /* ---- P3-ACCT: the persisted wallet is cleared (re-proven on the next money action) ---- */
    let walletCleared = false;
    if (profile !== undefined && walletOf(profile) !== null) {
      profile = { ...profile, wallet_address: null, wallet_verified_at: null };
      walletCleared = true;
    }

    /* The profile's status: disabled under review. When the journal no longer calls for a review that THIS restore opened
       earlier (a confirmation arrived since), the replay withdraws its own review record and the profile gets back
       exactly the status it had before that review (recorded in the record) -- never more. Any other status stays. */
    const dropReview = ownRecord !== undefined && review === null;
    if (profile !== undefined) {
      if (review !== null) profile = { ...profile, status: "disabled" };
      else if (dropReview) profile = { ...profile, status: priorStatus };
    }

    /* ---- terminal actions: re-applied whatever their confirmation ---- */
    const disabledByJournal = events.some((event) => event.kind === "principal-disabled");
    if (principal !== undefined && disabledByJournal && principal.status !== "disabled") principal = { ...principal, status: "disabled" };
    const disabled = principal?.status === "disabled";
    const journalRevocation = new Map<string, { readonly reason: Exclude<RevokeReason, "rotated">; readonly at: number }>();
    for (const event of events) {
      const listed: Array<[readonly string[], Exclude<RevokeReason, "rotated">]> =
        event.kind === "family-revoked"
          ? [[event.family_ids, event.reason as Exclude<RevokeReason, "rotated">]]
          : event.kind === "signed-out-others"
            ? [[event.family_ids, "signed-out-remotely"]]
            : event.kind === "principal-disabled"
              ? [[event.family_ids, "principal-disabled"]]
              : [];
      for (const [familyIds, reason] of listed) {
        for (const familyId of familyIds) {
          const family = families.get(familyId);
          if (family === undefined) {
            counters.unknownFamilies += 1;
            continue;
          }
          if (family.principal_id !== principalId) throw new SecurityReplayError(`event ${event.event_id} names a session family of another principal`);
          if (!journalRevocation.has(familyId)) journalRevocation.set(familyId, { reason, at: event.at });
        }
      }
    }

    /* ---- the change: only what differs from the table ---- */
    const expect: IdentityPrecondition[] = [];
    const change: { principals?: Principal[]; profiles?: Profile[]; families?: SessionFamily[]; sessions?: Session[]; dropLinks?: string[] } = {};
    if (created && principal !== undefined && profile !== undefined) {
      expect.push(tablePrincipal === undefined ? { kind: "principal-absent", principal_id: principalId } : { kind: "principal-unprofiled", principal_id: principalId });
      expect.push({ kind: "profile-absent", profile_id: profile.profile_id }, { kind: "selector-unused", recovery_selector: profile.recovery_selector });
      const login = loginOf(profile);
      if (login !== null) expect.push({ kind: "login-unused", login_key: login.key });
      counters.created += 1;
    } else if (profile !== undefined && tableProfile !== undefined && profile.recovery_selector !== tableProfile.recovery_selector) {
      expect.push({ kind: "profile-selector", profile_id: profile.profile_id, recovery_selector: tableProfile.recovery_selector }, { kind: "selector-unused", recovery_selector: profile.recovery_selector });
    }
    if (credentialsInstalled !== null && profile !== undefined && !created) {
      expect.push({ kind: "profile-no-login", profile_id: profile.profile_id }, { kind: "login-unused", login_key: credentialsInstalled });
    }
    if (credentialsInstalled !== null) counters.credentials += 1;
    if (walletCleared) counters.wallets += 1;
    if (keyAdvanced) counters.advanced += 1;
    if (principal !== undefined && !same(principal, tablePrincipal)) {
      change.principals = [principal];
      if (principal.status === "disabled" && tablePrincipal?.status !== "disabled") counters.disabled += 1;
    }
    if (profile !== undefined && !same(profile, tableProfile)) change.profiles = [profile];
    const closing = (familiesOf.get(principalId) ?? [])
      .filter((family) => family.revoked_at === null)
      .sort((a, b) => byText(a.family_id, b.family_id))
      .map((family): SessionFamily => {
        const journaled = journalRevocation.get(family.family_id);
        return { ...family, revoked_at: journaled?.at ?? input.at, revoke_reason: journaled?.reason ?? (disabled ? "principal-disabled" : "operator") };
      });
    if (closing.length > 0) {
      change.families = closing;
      for (const family of closing) expect.push({ kind: "family-open", family_id: family.family_id });
      counters.familiesClosed += closing.length;
    }
    const signingOut = (sessionsOf.get(principalId) ?? [])
      .filter((session) => session.revoked_at === null)
      .sort((a, b) => byText(a.session_id, b.session_id))
      .map((session): Session => ({ ...session, revoked_at: input.at, revoke_reason: disabled ? "principal-disabled" : "operator" }));
    if (signingOut.length > 0) {
      change.sessions = signingOut;
      for (const session of signingOut) expect.push({ kind: "session-open", session_id: session.session_id });
      counters.signedOut += signingOut.length;
    }
    const links = tableProfile === undefined ? [] : snapshot.links.filter((link) => link.profile_id === tableProfile.profile_id).map((link) => link.link_hash).sort(byText);
    if (links.length > 0) {
      change.dropLinks = links;
      counters.links += links.length;
    }
    const empty = change.principals === undefined && change.profiles === undefined && change.families === undefined && change.sessions === undefined && change.dropLinks === undefined;
    if (empty && review === null && !dropReview) continue;
    if (!empty) counters.changes += 1;
    if (review !== null) reviews.push(review);
    if (dropReview) counters.withdrawn += 1;
    out.push({ principal_id: principalId, change: empty ? null : { ...(expect.length > 0 ? { expect } : {}), ...change }, review, dropReview: dropReview ? (profile as Profile).profile_id : null });
  }

  return {
    journal: { digest: journal.digest, events: journal.events.length },
    principals: out,
    reviews,
    report: {
      principals: ids.length,
      events: { total: journal.events.length, confirmations: byKind.confirmed ?? 0, by_kind: byKind, unconfirmed_changes: counters.unconfirmed },
      changes: counters.changes,
      profiles_created: counters.created,
      keys_advanced: counters.advanced,
      reviews: reviews.length,
      reviews_withdrawn: counters.withdrawn,
      principals_disabled: counters.disabled,
      families_closed: counters.familiesClosed,
      sessions_signed_out: counters.signedOut,
      links_dropped: counters.links,
      families_unknown_to_table: counters.unknownFamilies,
      credentials_installed: counters.credentials,
      wallets_cleared: counters.wallets,
    },
  };
}
