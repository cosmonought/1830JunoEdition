// server/src/persistence/conformance/identityDynamoLocal.properties.test.ts
//
// ==================================================================
//  LIVE-5 L5-4: WHAT THE DYNAMODB IDENTITY ADAPTER MUST SHOW BEYOND THE PORT'S CASES (DynamoDB Local)
// ==================================================================
//
//   A. CONDITIONS ALONE. Random changes are planned and sent with NO pre-check -- the table's own conditions are the only
//      judge -- and DynamoDB's verdict must be exactly the memory / journal stores' verdict, step after step, and the
//      table must hold exactly their state. Every precondition kind is seen refusing ALONE, and holding.
//   B. A CHANGE OF SEVERAL TRANSACTIONS. A sign-out bigger than one transaction lands family first; interrupted between
//      transactions it is UNKNOWN (never definite), the store holds itself for a restart, and the restart loads a valid,
//      safe prefix in which every member of the family is already refused.
//   C. THE ROLE. Taking the identity-writer role moves the epoch by exactly one, atomically with the caller's own
//      conditions; every earlier holder is refused by DynamoDB, and learns it (`onFenced`) once.
//   D. DAMAGE. Every way an item can be wrong refuses the load; nothing is guessed.
//   E. A TABLE CHANGED BEHIND THE WRITER. The conditions refuse what the writer's view accepted: DEFINITE, nothing
//      written, and the store holds itself for a restart.
//   F. THE SERVICE ON DYNAMODB. The identity service over this adapter, with the security substrate: profiles, a second
//      device, re-authentication, sign-outs and a key rotation across restarts; the security events written FIRST (an
//      event that cannot be written stops its change) and confirmed after; a grant that survives a restart (OD-5-4) and
//      dies with its key; a writer that was taken over journals nothing, and one taken over while its event is written
//      leaves that event unconfirmed (review F2).
//   Review fixes also shown here: F1 (a sign-out's security effects land in the FIRST transaction: the other families,
//   the link codes, the kept family's other members), F3 (a takeover writes only a role item its codec can read), F4 (a
//   grant write is bounded), F6 (a writer whose epoch is not the table's learns it at the load), F7 (a later chunk that
//   is throttled is retried for longer before the change counts as applied in part).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { DeleteItemCommand, PutItemCommand, UpdateItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { deadline } from "../../aws/awsClients";
import { createDynamoIdentityStore, NOT_EVALUATED_RETRY_WAITS, readIdentityRole, roleFence, takeOverIdentityWriter, transactionRunner, IdentityRoleRefusedError } from "../../aws/identity/dynamoIdentityStore";
import { createDynamoSecurityJournal, APPGEN_KEY } from "../../aws/identity/dynamoSecurityJournal";
import { keyAttributes, keys, ROLE_KEY, type Item } from "../../aws/identity/identityItems";
import { planIdentityChange, type PlannedAction } from "../../aws/identity/identityPlan";
import { readSessionCookie, type SessionCookieRead } from "../../identity/cookies";
import type { SecurityEvent } from "../../identity/securityEvents";
import { familyIdOf, mintPrincipalId, mintProfileId, mintRecoveryKey, mintSecret, mintSessionId, secretHash } from "../../identity/ids";
import { IdentityService } from "../../identity/sessions";
import {
  applyChange,
  changeShapeProblem,
  IdentityIndex,
  lookupsOf,
  preconditionFailure,
  type FullIdentitySnapshot,
  type IdentityChange,
  type IdentityPrecondition,
  type LinkCredential,
  type Principal,
  type Profile,
  type Session,
  type SessionFamily,
} from "../../identity/store";
import { FaultScript, gate } from "./faults";
import { installFaults } from "./dynamoLocal";
import { anotherSession, FIXTURE_PASSWORD_HASH, FIXTURE_WALLET, FIXTURE_WALLET_2, identitySet, seededRandom } from "./fixtures";
import { dynamoSuite, IMMEDIATE, QUIET, roleItem, tableItems } from "./identityDynamoSubjects";
import { T0, rejection } from "./harness";

const suite = dynamoSuite();
const admin = suite.admin;
const EMPTY: FullIdentitySnapshot = { principals: [], sessions: [], profiles: [], links: [], families: [] };
const isDefinite = (error: unknown) => error instanceof Error && error.name === "StoreDefiniteError";
const isUncertain = (error: unknown) => error instanceof Error && error.name === "StoreUncertainError";

async function identityTable(label: string, epoch: number | null = 1): Promise<string> {
  const table = await suite.tables.create(label);
  if (epoch !== null) await admin.send(new PutItemCommand({ TableName: table, Item: roleItem(epoch) }), { abortSignal: deadline() });
  return table;
}

function openStore(client: DynamoDBClient, table: string, epoch = 1, held: string[] = [], fenced: string[] = []) {
  return createDynamoIdentityStore(client, table, { epoch, sleep: IMMEDIATE, scanSegments: 3, pageSize: 30, warn: QUIET, onRestartRequired: (detail) => held.push(detail), onFenced: (detail) => fenced.push(detail) });
}

/** The change a profile creation commits for identity set `set`. */
const creation = (set: ReturnType<typeof identitySet>): IdentityChange => ({
  expect: [
    { kind: "principal-absent", principal_id: set.principal.principal_id },
    { kind: "profile-absent", profile_id: set.profile.profile_id },
    { kind: "selector-unused", recovery_selector: set.profile.recovery_selector },
    { kind: "session-absent", session_id: set.session.session_id },
    { kind: "family-absent", family_id: set.family.family_id },
  ],
  principals: [set.profiledPrincipal],
  profiles: [set.profile],
  sessions: [set.session],
  families: [set.family],
});

/* ================================================================================================= */
/* A. Conditions alone                                                                              */
/* ================================================================================================= */

interface Pools {
  principals: string[];
  profiles: string[];
  keys: Array<{ selector: string; hash: string }>;
  sessions: string[];
  families: string[];
  links: string[];
  secret: string;
}

function pools(seed: string): Pools {
  const random = seededRandom(seed);
  return {
    principals: Array.from({ length: 6 }, () => mintPrincipalId(random)),
    profiles: Array.from({ length: 5 }, () => mintProfileId(random)),
    keys: Array.from({ length: 8 }, () => {
      const key = mintRecoveryKey(random);
      return { selector: key.selector, hash: secretHash(key.secret) };
    }),
    sessions: Array.from({ length: 14 }, () => mintSessionId(random)),
    families: Array.from({ length: 8 }, () => familyIdOf(mintSessionId(random))),
    links: Array.from({ length: 5 }, () => secretHash(mintSecret(random))),
    secret: secretHash(mintSecret(random)),
  };
}

/** A deterministic generator of changes over small id pools, so records collide and every rule is exercised. */
function changeGenerator(pool: Pools, seed: number) {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const chance = (p: number) => random() < p;
  const tick = () => T0 + Math.floor(random() * 1000);
  const fresh = seededRandom(`fresh-${seed}`);

  const principal = (id: string, over: Partial<Principal> = {}): Principal => ({ principal_id: id, kind: "unprofiled", status: chance(0.9) ? "active" : "disabled", created_at: T0, activated_at: T0, last_seen_at: tick(), account_link: null, ...over });
  const profile = (id: string, principalId: string, key = pick(pool.keys)): Profile => ({
    profile_id: id,
    principal_id: principalId,
    display_name: "Diff",
    created_at: T0,
    status: "active",
    recovery_selector: key.selector,
    recovery_hash: key.hash,
    recovery_rotated_at: tick(),
    schema: 1,
  });
  const family = (id: string, principalId: string, over: Partial<SessionFamily> = {}): SessionFamily => ({ family_id: id, principal_id: principalId, created_at: T0, origin: "bootstrap", revoked_at: null, revoke_reason: null, ...over });
  const session = (id: string, principalId: string, familyId: string, over: Partial<Session> = {}): Session => ({
    session_id: id,
    principal_id: principalId,
    secret_hash: pool.secret,
    created_at: T0,
    last_seen_at: T0,
    expires_at: T0 + 86_400_000,
    revoked_at: null,
    revoke_reason: null,
    rotated_to: null,
    family_id: familyId,
    ...over,
  });
  const link = (hash: string, profileId: string, over: Partial<LinkCredential> = {}): LinkCredential => ({ link_hash: hash, profile_id: profileId, created_at: T0, expires_at: T0 + 600_000, consumed_at: null, ...over });
  /* P3-ACCT: usernames from a small pool whose canonical keys collide ("Ann" / "ann"), and two wallets. */
  const LOGINS = ["Ann", "ann", "Bob", "Cy"];
  const keyOf = (name: string) => name.toLowerCase();
  const withLogin = (target: Profile, name: string | null): Profile => ({
    ...target,
    schema: 2,
    login_key: name === null ? null : keyOf(name),
    login_name: name,
    password_hash: name === null ? null : FIXTURE_PASSWORD_HASH,
    password_set_at: name === null ? null : T0,
    wallet_address: target.schema === 2 ? (target.wallet_address ?? null) : null,
    wallet_verified_at: target.schema === 2 ? (target.wallet_verified_at ?? null) : null,
  });
  const withWallet = (target: Profile, wallet: string | null): Profile => {
    const base = target.schema === 2 ? target : withLogin(target, null);
    return { ...base, wallet_address: wallet, wallet_verified_at: wallet === null ? null : tick() };
  };

  const randomPrecondition = (s: FullIdentitySnapshot): IdentityPrecondition => {
    const known = <T>(items: readonly T[], fallback: T) => (items.length > 0 && chance(0.6) ? pick(items) : fallback);
    switch (Math.floor(random() * 14)) {
      case 0:
        return { kind: "principal-absent", principal_id: known(s.principals.map((p) => p.principal_id), pick(pool.principals)) };
      case 1:
        return { kind: "principal-unprofiled", principal_id: known(s.principals.map((p) => p.principal_id), pick(pool.principals)) };
      case 2:
        return { kind: "profile-absent", profile_id: known(s.profiles.map((p) => p.profile_id), pick(pool.profiles)) };
      case 3:
        return { kind: "selector-unused", recovery_selector: known(s.profiles.map((p) => p.recovery_selector), pick(pool.keys).selector) };
      case 4: {
        const target = known(s.profiles, null);
        return target !== null
          ? { kind: "profile-selector", profile_id: target.profile_id, recovery_selector: chance(0.7) ? target.recovery_selector : pick(pool.keys).selector }
          : { kind: "profile-selector", profile_id: pick(pool.profiles), recovery_selector: pick(pool.keys).selector };
      }
      case 5:
        return { kind: "session-absent", session_id: known(s.sessions.map((x) => x.session_id), pick(pool.sessions)) };
      case 6:
        return { kind: "session-open", session_id: known(s.sessions.map((x) => x.session_id), pick(pool.sessions)) };
      case 7:
        return { kind: "link-absent", link_hash: known(s.links.map((l) => l.link_hash), pick(pool.links)) };
      case 8: {
        const target = known(s.links, null);
        return { kind: "link-unconsumed", link_hash: target?.link_hash ?? pick(pool.links), at: chance(0.8) ? T0 + 10 : T0 + 600_000 };
      }
      case 9:
        return { kind: "family-absent", family_id: known(s.families.map((f) => f.family_id), pick(pool.families)) };
      case 11:
        return { kind: "login-unused", login_key: keyOf(pick(LOGINS)) };
      case 12:
        return { kind: "profile-no-login", profile_id: known(s.profiles.map((p) => p.profile_id), pick(pool.profiles)) };
      case 13: {
        const target = known(s.profiles, null);
        const held = target !== null && target.schema === 2 ? (target.wallet_address ?? null) : null;
        return { kind: "profile-wallet", profile_id: target?.profile_id ?? pick(pool.profiles), wallet_address: chance(0.6) ? held : pick([null, FIXTURE_WALLET, FIXTURE_WALLET_2]) };
      }
      default:
        return { kind: "family-open", family_id: known(s.families.map((f) => f.family_id), pick(pool.families)) };
    }
  };

  return (s: FullIdentitySnapshot): IdentityChange => {
    const principals = s.principals;
    const choice = Math.floor(random() * 17);
    let change: IdentityChange;
    if (choice === 0 || principals.length === 0) {
      /* sometimes a principal never seen before (so principal-absent keeps holding), sometimes one of the pool */
      const id = chance(0.4) ? mintPrincipalId(fresh) : pick(pool.principals);
      change = { principals: [principal(id)], expect: chance(0.5) ? [{ kind: "principal-absent", principal_id: id }] : [] };
    } else if (choice === 1) {
      /* a profile creation: bind a principal and a profile, with the create-if-absent terms (sometimes wrong) */
      const pr = chance(0.7) ? pick(principals).principal_id : pick(pool.principals);
      const pf = pick(pool.profiles);
      const key = pick(pool.keys);
      const bound = principal(pr, { kind: "profile", account_link: pf, status: "active" });
      const expect: IdentityPrecondition[] = [];
      if (chance(0.7)) expect.push(chance(0.8) ? { kind: "principal-unprofiled", principal_id: pr } : { kind: "principal-absent", principal_id: pr });
      if (chance(0.7)) expect.push({ kind: "profile-absent", profile_id: pf });
      if (chance(0.7)) expect.push({ kind: "selector-unused", recovery_selector: key.selector });
      /* P3-ACCT: sometimes a new ACCOUNT -- the profile at schema 2 with a username (and its login-unused term). */
      const login = chance(0.35) ? pick(LOGINS) : null;
      if (login !== null && chance(0.7)) expect.push({ kind: "login-unused", login_key: keyOf(login) });
      const made = login === null ? profile(pf, pr, key) : withLogin(profile(pf, pr, key), login);
      change = chance(0.85) ? { principals: [bound], profiles: [made], expect } : chance(0.5) ? { principals: [bound], expect } : { profiles: [made], expect };
    } else if (choice === 2 && s.profiles.length > 0) {
      /* a recovery-key rotation (or a move, or a selector someone else holds) */
      const target = pick(s.profiles);
      const key = chance(0.6) ? pick(pool.keys) : { selector: pick(s.profiles).recovery_selector, hash: target.recovery_hash };
      const moved = chance(0.1) ? { principal_id: pick(principals).principal_id } : {};
      const expect: IdentityPrecondition[] = [];
      if (chance(0.7)) expect.push({ kind: "profile-selector", profile_id: target.profile_id, recovery_selector: chance(0.8) ? target.recovery_selector : pick(pool.keys).selector });
      if (chance(0.6)) expect.push({ kind: "selector-unused", recovery_selector: key.selector });
      change = { profiles: [{ ...target, recovery_selector: key.selector, recovery_hash: key.hash, recovery_rotated_at: tick(), ...moved }], expect };
    } else if (choice === 3 && s.profiles.length > 1) {
      /* two profiles swap selectors in one change (the uniqueness items' movers) */
      const [a, b] = [pick(s.profiles), pick(s.profiles)];
      change = a.profile_id === b.profile_id ? { profiles: [{ ...a, recovery_rotated_at: tick() }] } : { profiles: [{ ...a, recovery_selector: b.recovery_selector }, { ...b, recovery_selector: a.recovery_selector }] };
    } else if (choice === 4) {
      /* a new session founding (or joining) a family */
      const pr = chance(0.85) ? pick(principals).principal_id : pick(pool.principals);
      const sf = pick(pool.families);
      const se = pick(pool.sessions);
      const withFamily = chance(0.5);
      const expect: IdentityPrecondition[] = [];
      if (chance(0.7)) expect.push({ kind: "session-absent", session_id: se });
      if (withFamily && chance(0.6)) expect.push({ kind: "family-absent", family_id: sf });
      if (!withFamily && chance(0.6)) expect.push({ kind: "family-open", family_id: sf });
      change = { sessions: [session(se, pr, sf)], families: withFamily ? [family(sf, chance(0.9) ? pr : pick(pool.principals))] : [], expect };
    } else if (choice === 5 && s.sessions.length > 0) {
      /* a rotation / revocation of a stored session (sometimes moving it) */
      const target = pick(s.sessions);
      const reason = pick(["rotated", "logout", "evicted", "signed-out-remotely"] as const);
      const moved = chance(0.1) ? { family_id: pick(pool.families) } : {};
      change = { sessions: [{ ...target, revoked_at: tick(), revoke_reason: reason, ...moved }], expect: chance(0.8) ? [{ kind: "session-open", session_id: target.session_id }] : [] };
    } else if (choice === 6 && s.families.length > 0) {
      /* a family revocation -- or an attempt to reopen, move, or re-origin one */
      const target = pick(s.families);
      const variant = Math.floor(random() * 5);
      const next =
        variant === 0
          ? { ...target, revoked_at: null, revoke_reason: null }
          : variant === 1
            ? { ...target, principal_id: pick(principals).principal_id }
            : variant === 2
              ? { ...target, origin: "link" as const }
              : { ...target, revoked_at: tick(), revoke_reason: "logout" as const };
      change = { families: [next], expect: chance(0.7) ? [{ kind: "family-open", family_id: target.family_id }] : [] };
    } else if (choice === 7) {
      /* a link code, new (or for no profile) */
      const hash = pick(pool.links);
      const pf = s.profiles.length > 0 && chance(0.85) ? pick(s.profiles).profile_id : pick(pool.profiles);
      change = { links: [link(hash, pf)], expect: chance(0.7) ? [{ kind: "link-absent", link_hash: hash }] : [] };
    } else if (choice === 8 && s.links.length > 0) {
      /* a link code consumed together with a session it issues */
      const target = pick(s.links);
      const at = chance(0.8) ? T0 + 10 : T0 + 700_000;
      const owner = s.profiles.find((p) => p.profile_id === target.profile_id);
      const se = pick(pool.sessions);
      const sf = pick(pool.families);
      change = {
        links: [{ ...target, consumed_at: at }],
        sessions: owner !== undefined ? [session(se, owner.principal_id, sf)] : [],
        families: owner !== undefined ? [family(sf, owner.principal_id, { origin: "link" })] : [],
        expect: [{ kind: "link-unconsumed", link_hash: target.link_hash, at }, ...(owner !== undefined ? [{ kind: "session-absent" as const, session_id: se }, { kind: "family-absent" as const, family_id: sf }] : [])],
      };
    } else if (choice === 9) {
      change = chance(0.5) ? { dropSessions: [pick(pool.sessions)] } : { dropLinks: [pick(pool.links)] };
    } else if ((choice === 14 || choice === 15) && s.profiles.length > 0) {
      /* P3-ACCT: a legacy profile establishing a username -- or a held one changed or dropped (refused: never moves) */
      const target = pick(s.profiles);
      const name = chance(0.85) ? pick(LOGINS) : null;
      const expect: IdentityPrecondition[] = [];
      if (chance(0.6)) expect.push({ kind: "profile-no-login", profile_id: target.profile_id });
      if (name !== null && chance(0.6)) expect.push({ kind: "login-unused", login_key: keyOf(name) });
      change = { profiles: [withLogin(target, name)], expect };
    } else if (choice === 16 && s.profiles.length > 0) {
      /* P3-ACCT: the persisted wallet set, replaced or forgotten (its CAS sometimes wrong), or a schema-2 downgrade */
      const target = pick(s.profiles);
      if (chance(0.1) && target.schema === 2) {
        const { login_key: _a, login_name: _b, password_hash: _c, password_set_at: _d, wallet_address: _e, wallet_verified_at: _f, ...v1 } = target;
        change = { profiles: [{ ...v1, schema: 1 }] };
      } else {
        const held = target.schema === 2 ? (target.wallet_address ?? null) : null;
        const next = pick([null, FIXTURE_WALLET, FIXTURE_WALLET_2]);
        change = { profiles: [withWallet(target, next)], expect: chance(0.8) ? [{ kind: "profile-wallet", profile_id: target.profile_id, wallet_address: chance(0.8) ? held : pick([null, FIXTURE_WALLET]) }] : [] };
      }
    } else if (choice === 10 && principals.length > 0) {
      /* a principal rewritten: sometimes leaving its profile, or bound to another */
      const target = pick(principals);
      const variant = Math.floor(random() * 3);
      const next = variant === 0 ? { ...target, kind: "unprofiled" as const, account_link: null } : variant === 1 ? { ...target, kind: "profile" as const, account_link: pick(pool.profiles) } : { ...target, last_seen_at: tick() };
      change = { principals: [next] };
    } else {
      change = { principals: [principal(pick(pool.principals))] };
    }
    /* Extra terms on records the change may not touch -- every kind, against whatever is stored. */
    const extra = Array.from({ length: Math.floor(random() * 3) }, () => randomPrecondition(s));
    return { ...change, expect: [...(change.expect ?? []), ...extra] };
  };
}

const pureVerdict = (state: FullIdentitySnapshot, change: IdentityChange): string | null =>
  changeShapeProblem(change) ?? IdentityIndex.from(state).check(change, "differential") ?? preconditionFailure(lookupsOf(state), change.expect);

describe("L5-4 A: conditions alone -- DynamoDB's verdict on a planned change is the memory and journal stores' verdict", () => {
  test("700 random changes sent with NO pre-check: accepted exactly when the pure verdict accepts, and the table always holds exactly the model's set", async (t) => {
    const table = await identityTable("differential");
    const client = await suite.client();
    const runner = transactionRunner(client, { fence: roleFence(table, 1), table, now: () => T0, sleep: IMMEDIATE, maxResends: 1 });
    const pool = pools("l5-4-differential");
    const next = changeGenerator(pool, 0x5454);
    let state = EMPTY;
    const tally = { accepted: 0, refusedPure: 0, refusedByPlan: 0, refusedByTable: 0 };
    /* Each precondition kind seen HOLDING in an accepted change, and seen as the ONLY failing term of a change the table
       (not the planner) refused. */
    const holds = new Map<string, number>();
    const soleRefusals = new Map<string, number>();
    const reached = { login: false, wallet: false };
    for (let step = 0; step < 700; step += 1) {
      const change = next(state);
      const pure = pureVerdict(state, change);
      const plan = planIdentityChange(change, { profileSelector: (id) => state.profiles.find((p) => p.profile_id === id)?.recovery_selector }, table);
      let accepted = false;
      if (plan.kind === "refused") {
        tally.refusedByPlan += 1;
      } else {
        assert.equal(plan.chunks.length, 1, "the generator keeps changes to one transaction");
        const outcome = await runner.run(plan.chunks[0].actions.map((planned) => planned.action));
        assert.notEqual(outcome.kind, "uncertain", `step ${step}: ${JSON.stringify(outcome)}`);
        if (outcome.kind === "definite") {
          assert.ok(outcome.evaluated && !outcome.fenced, `step ${step}: refused by a condition, not a rejection: ${JSON.stringify(outcome)}`);
          tally.refusedByTable += 1;
          const failing = (change.expect ?? []).filter((condition) => preconditionFailure(lookupsOf(state), [condition]) !== null);
          if (failing.length === 1 && IdentityIndex.from(state).check(change, "d") === null) soleRefusals.set(failing[0].kind, (soleRefusals.get(failing[0].kind) ?? 0) + 1);
        }
        accepted = outcome.kind === "committed";
      }
      assert.equal(accepted, pure === null, `step ${step}: the pure verdict is ${pure === null ? "accept" : `refuse (${pure})`}, the table ${accepted ? "accepted" : "refused"}: ${JSON.stringify(change).slice(0, 400)}`);
      if (pure === null) {
        tally.accepted += 1;
        for (const condition of change.expect ?? []) holds.set(condition.kind, (holds.get(condition.kind) ?? 0) + 1);
        state = applyChange(state, change);
        if (state.profiles.some((p) => p.schema === 2 && p.login_key !== null)) reached.login = true;
        if (state.profiles.some((p) => p.schema === 2 && p.wallet_address !== null)) reached.wallet = true;
      } else {
        tally.refusedPure += 1;
      }
      const loaded = await openStore(client, table).load();
      assert.deepEqual(loaded, applyChange(state, {}), `step ${step}: the table holds exactly the model's identity set`);
    }
    const kinds = ["principal-absent", "principal-unprofiled", "profile-absent", "selector-unused", "profile-selector", "session-absent", "session-open", "link-absent", "link-unconsumed", "family-absent", "family-open", "login-unused", "profile-no-login", "profile-wallet"];
    for (const kind of kinds) {
      assert.ok((holds.get(kind) ?? 0) >= 3, `${kind} held in an accepted change (${holds.get(kind) ?? 0})`);
      assert.ok((soleRefusals.get(kind) ?? 0) >= 1, `${kind} alone made the TABLE refuse (${soleRefusals.get(kind) ?? 0})`);
    }
    t.diagnostic(`tally ${JSON.stringify(tally)}; held ${JSON.stringify(Object.fromEntries(holds))}; refused alone by the table ${JSON.stringify(Object.fromEntries(soleRefusals))}`);
    assert.ok(tally.accepted > 100 && tally.refusedByTable > 100, `a real mix: ${JSON.stringify(tally)}`);
    assert.ok(state.profiles.length >= 2 && state.families.some((f) => f.revoked_at !== null) && state.links.length >= 1, "the run reached profiles, revoked families and links");
    assert.ok(reached.login && reached.wallet, `the run reached usernames and persisted wallets (P3-ACCT): ${JSON.stringify(reached)}`);
  });

  test("a stale view can only refuse: a plan made from a wrong selector for a profile is refused by the pin and writes nothing", async () => {
    const table = await identityTable("stale-view");
    const client = await suite.client();
    const store = openStore(client, table);
    await store.load();
    const set = identitySet(1);
    await store.commit(creation(set));
    const runner = transactionRunner(client, { fence: roleFence(table, 1), table, now: () => T0, sleep: IMMEDIATE, maxResends: 1 });
    const before = await tableItems(admin, table);
    const rotated = { ...set.profile, recovery_selector: identitySet(2).profile.recovery_selector, recovery_hash: identitySet(2).profile.recovery_hash };
    for (const wrong of [undefined, identitySet(3).profile.recovery_selector]) {
      const plan = planIdentityChange({ profiles: [rotated] }, { profileSelector: () => wrong }, table);
      assert.equal(plan.kind, "plan");
      const outcome = await runner.run((plan as unknown as { chunks: Array<{ actions: Array<{ action: never }> }> }).chunks[0].actions.map((planned) => planned.action));
      assert.equal(outcome.kind, "definite", `a view that says ${wrong ?? "no profile"} is refused`);
      assert.deepEqual(await tableItems(admin, table), before);
    }
  });

  test("every rule about a record's past, and every relation to a record the change does not carry, is a condition of the write: each violation, sent with NO pre-check, is refused by the table alone", async () => {
    const table = await identityTable("rules");
    const client = await suite.client();
    const store = openStore(client, table);
    await store.load();
    /* The stored state: P1 bound to PF1 (session S1 in family F1), a revoked family F3 of P1, and P2 unprofiled with
       session S2 in family F2. */
    const one = identitySet(1);
    const two = identitySet(2);
    await store.commit(creation(one));
    await store.commit({ expect: [{ kind: "principal-absent", principal_id: two.principal.principal_id }], principals: [two.principal], families: [two.family], sessions: [two.session] });
    const f3: SessionFamily = { ...one.family, family_id: familyIdOf(anotherSession(one, "f3").session_id) };
    await store.commit({ families: [f3] });
    await store.commit({ families: [{ ...f3, revoked_at: T0 + 1, revoke_reason: "logout" }] });
    const state = await store.load();
    const runner = transactionRunner(client, { fence: roleFence(table, 1), table, now: () => T0, sleep: IMMEDIATE, maxResends: 1 });
    const stranger = identitySet(9);
    const freshKey = identitySet(8).profile;
    const probes: Array<[string, IdentityChange]> = [
      ["a family never reopens", { families: [f3] }],
      ["a family never moves to another principal", { families: [{ ...one.family, principal_id: two.principal.principal_id }] }],
      ["a family never changes its origin", { families: [{ ...one.family, origin: "link" }] }],
      ["a session never moves to another family", { sessions: [{ ...one.session, family_id: f3.family_id }] }],
      ["a profile never moves to another principal", { profiles: [{ ...one.profile, principal_id: two.principal.principal_id }] }],
      ["a bound principal never leaves its profile", { principals: [{ ...one.profiledPrincipal, kind: "unprofiled", account_link: null }] }],
      [
        "a new profile's principal must be bound to it (it is stored, and unprofiled)",
        { profiles: [{ ...freshKey, profile_id: stranger.profile.profile_id, principal_id: two.principal.principal_id }] },
      ],
      ["a profile principal's profile must name it back", { principals: [{ ...two.principal, kind: "profile", account_link: one.profile.profile_id }] }],
      ["a session's family must be its principal's", { sessions: [anotherSession(two, "into-f1", { family_id: one.family.family_id })] }],
      ["a family's principal must be stored", { families: [{ ...stranger.family }] }],
      ["a session's principal must be stored", { sessions: [anotherSession(stranger, "orphan", { family_id: one.family.family_id })] }],
      ["a link code's profile must be stored", { links: [{ ...stranger.link }] }],
      ["no other profile holds a claimed selector", { principals: [{ ...two.principal, kind: "profile", account_link: stranger.profile.profile_id }], profiles: [{ ...stranger.profile, principal_id: two.principal.principal_id, recovery_selector: one.profile.recovery_selector }] }],
    ];
    const before = await tableItems(admin, table);
    for (const [rule, change] of probes) {
      assert.notEqual(pureVerdict(state, change), null, `${rule}: the pure verdict refuses it`);
      const plan = planIdentityChange(change, { profileSelector: (id) => state.profiles.find((p) => p.profile_id === id)?.recovery_selector }, table);
      assert.equal(plan.kind, "plan", `${rule}: not refused from the change alone -- only the stored state refuses it`);
      const chunks = (plan as unknown as { chunks: Array<{ actions: PlannedAction[] }> }).chunks;
      assert.equal(chunks.length, 1);
      const outcome = await runner.run(chunks[0].actions.map((planned) => planned.action));
      assert.equal(outcome.kind, "definite", `${rule}: the TABLE refuses it`);
      assert.ok((outcome as { evaluated: boolean }).evaluated && !(outcome as { fenced: boolean }).fenced, `${rule}: by a condition`);
      assert.deepEqual(await tableItems(admin, table), before, `${rule}: nothing written`);
    }
  });
});

/* ================================================================================================= */
/* B. A change of several transactions                                                               */
/* ================================================================================================= */

describe("L5-4 B: a change larger than one transaction", () => {
  const MEMBERS = 250;
  async function bigFamily(label: string) {
    const table = await identityTable(label);
    const client = await suite.client();
    const script = new FaultScript();
    installFaults(client, script);
    const held: string[] = [];
    const fenced: string[] = [];
    const store = openStore(client, table, 1, held, fenced);
    await store.load();
    const set = identitySet(1);
    await store.commit(creation(set));
    const members = Array.from({ length: MEMBERS - 1 }, (_, k) => anotherSession(set, `member-${k}`));
    await store.commit({ expect: members.map((m) => ({ kind: "session-absent" as const, session_id: m.session_id })), sessions: members });
    const all = [set.session, ...members];
    const at = T0 + 99;
    const signOut: IdentityChange = {
      expect: [{ kind: "family-open", family_id: set.family.family_id }, ...all.map((m) => ({ kind: "session-open" as const, session_id: m.session_id }))],
      families: [{ ...set.family, revoked_at: at, revoke_reason: "logout" }],
      sessions: all.map((m) => ({ ...m, revoked_at: at, revoke_reason: "logout" as const })),
    };
    return { table, client, script, held, fenced, store, set, all, signOut, at };
  }

  test("the plan: the family is in the first transaction, before any member; every transaction carries its own checks", async () => {
    const { signOut, table, store } = await bigFamily("chunk-plan");
    const plan = planIdentityChange(signOut, { profileSelector: () => undefined }, table);
    assert.equal(plan.kind, "plan");
    const chunks = (plan as unknown as { chunks: Array<{ actions: Array<{ cls: string; op: string }> }> }).chunks;
    assert.ok(chunks.length >= 3, `${chunks.length} transactions`);
    assert.equal(chunks[0].actions.find((action) => action.op === "put")?.cls, "family", "the family is the first write");
    for (const chunk of chunks) {
      assert.ok(chunk.actions.length <= 98, "each fits beside the fence and the marker");
      if (chunk.actions.some((action) => action.cls === "session" && action.op === "put")) assert.ok(chunk.actions.some((action) => action.cls === "principal" && action.op === "check"), "the sessions' principal is checked in their own transaction");
    }
    await store.commit(signOut);
    const loaded = await store.load();
    assert.equal(loaded.sessions.filter((m) => m.revoke_reason === "logout").length, MEMBERS);
  });

  for (const interruption of ["unresolved", "takeover"] as const) {
    test(`interrupted after its first transaction (${interruption}): UNKNOWN, never definite; the store holds; a restart loads a safe prefix -- the family revoked, so every member is refused`, async () => {
      const { table, client, script, held, fenced, store, set, all, signOut } = await bigFamily(`chunk-${interruption}`);
      const writes = { op: "TransactWriteItemsCommand" };
      if (interruption === "unresolved") {
        for (let n = 2; n <= 5; n += 1) script.add({ ...writes, nth: n, action: { kind: "fail", code: "TimeoutError" }, label: `send ${n}` });
      } else {
        const stall = gate();
        script.add({ ...writes, nth: 2, action: { kind: "stall", gate: stall }, label: "the second transaction stalls" });
        const pending = store.commit(signOut).then(
          () => null,
          (error: unknown) => error,
        );
        await stall.reached;
        await takeOverIdentityWriter(admin, table, { task: "successor", pool: "p", now: () => T0 });
        stall.release();
        const error = await pending;
        assert.ok(isUncertain(error), `applied in part is UNKNOWN: ${String(error)}`);
        assert.equal(fenced.length, 1, "the stale writer learns it is fenced");
      }
      if (interruption === "unresolved") {
        const error = await rejection(store.commit(signOut));
        assert.ok(isUncertain(error), `applied in part is UNKNOWN: ${String(error)}`);
      }
      assert.equal(held.length, 1);
      assert.match(held[0], /applied in part: 1 of \d+ transactions committed/);
      const later = await rejection(store.commit({ expect: [{ kind: "session-absent", session_id: anotherSession(set, "later").session_id }], sessions: [anotherSession(set, "later")] }));
      assert.ok(isDefinite(later), "the held store refuses DEFINITE");
      assert.deepEqual(script.unfired(), []);
      const epoch = (await readIdentityRole(admin, table))?.epoch ?? 1;
      const loaded = await openStore(client, table, epoch).load();
      assert.equal(loaded.families[0].revoked_at, T0 + 99, "the family -- the atomic revocation -- landed first");
      const revoked = loaded.sessions.filter((m) => m.revoke_reason === "logout").length;
      assert.ok(revoked > 0 && revoked < all.length, `a prefix of the members is revoked (${revoked} of ${all.length})`);
      const service = IdentityService.fromSnapshot(openStore(client, table, epoch), loaded);
      for (const member of loaded.sessions) {
        assert.equal(service.socketVerdict({ principalId: member.principal_id, sessionId: member.session_id, sessionExpiresAt: member.expires_at }, T0 + 100), "revoked", "every member of the family is refused, revoked record or not");
      }
    });
  }

  /** The pk an action names. */
  const pkOf = (planned: PlannedAction): string => planned.action.Put?.Item?.pk?.S ?? planned.action.Delete?.Key?.pk?.S ?? planned.action.ConditionCheck?.Key?.pk?.S ?? "";

  /** A principal with a profile, a link code, a kept family (the caller's session and three other members of it, created
   *  one second apart) and four other families of 30 members each -- and the "Sign out other devices" change the
   *  service commits for it (identity/sessions.ts `signOutOthers`): 128 writes, so two transactions. */
  async function manyDevices(label: string) {
    const table = await identityTable(label);
    const client = await suite.client();
    const script = new FaultScript();
    installFaults(client, script);
    const held: string[] = [];
    const store = openStore(client, table, 1, held);
    await store.load();
    const set = identitySet(1);
    await store.commit(creation(set));
    await store.commit({ expect: [{ kind: "link-absent", link_hash: set.link.link_hash }], links: [set.link] });
    /* The kept family's other members: two rotated predecessors and a live grace successor, oldest first. */
    const keptOthers = [1, 2, 3].map((k) =>
      anotherSession(set, `kept-${k}`, { created_at: T0 + k * 1000, last_seen_at: T0 + k * 1000, revoked_at: k < 3 ? T0 + k * 1000 + 500 : null, revoke_reason: k < 3 ? "rotated" : null }),
    );
    await store.commit({ expect: keptOthers.map((m) => ({ kind: "session-absent" as const, session_id: m.session_id })), sessions: keptOthers });
    const families: SessionFamily[] = [];
    const covered: Session[] = [];
    for (let f = 0; f < 4; f += 1) {
      const founder = anotherSession(set, `family-${f}`);
      const family: SessionFamily = { ...set.family, family_id: familyIdOf(founder.session_id) };
      const members = Array.from({ length: 30 }, (_, m) => anotherSession(set, `family-${f}-${m}`, { family_id: family.family_id }));
      await store.commit({ expect: [{ kind: "family-absent", family_id: family.family_id }, ...members.map((m) => ({ kind: "session-absent" as const, session_id: m.session_id }))], families: [family], sessions: members });
      families.push(family);
      covered.push(...members);
    }
    const at = T0 + 99_000;
    const others = [...keptOthers, ...covered];
    const signOutOthers: IdentityChange = {
      expect: [
        ...others.map((m) => ({ kind: "session-open" as const, session_id: m.session_id })),
        ...families.map((family) => ({ kind: "family-open" as const, family_id: family.family_id })),
        { kind: "family-open", family_id: set.family.family_id },
      ],
      sessions: others.map((m) => ({ ...m, revoked_at: at, revoke_reason: "signed-out-remotely" as const })),
      families: families.map((family) => ({ ...family, revoked_at: at, revoke_reason: "signed-out-remotely" as const })),
      dropLinks: [set.link.link_hash],
    };
    return { table, client, script, held, store, set, keptOthers, families, covered, signOutOthers };
  }

  test("review F1: every security effect of a sign-out-others lands in its FIRST transaction -- the other families, the profile's link code, and the kept family's other members, newest first -- before any member a revoked family already covers", async () => {
    const { table, set, keptOthers, families, covered, signOutOthers } = await manyDevices("chunk-others-plan");
    const plan = planIdentityChange(signOutOthers, { profileSelector: () => set.profile.recovery_selector }, table);
    assert.equal(plan.kind, "plan");
    const chunks = (plan as unknown as { chunks: Array<{ actions: PlannedAction[] }> }).chunks;
    assert.equal(chunks.length, 2, `${chunks.length} transactions`);
    const first = chunks[0].actions.filter((planned) => planned.op !== "check").map(pkOf);
    const position = (pk: string) => first.indexOf(pk);
    const familyAt = families.map((family) => position(`FAM#${family.family_id}`));
    const linkAt = position(`LINK#${set.link.link_hash}`);
    const keptAt = keptOthers.map((m) => position(`SESS#${m.session_id}`));
    assert.ok([...familyAt, linkAt, ...keptAt].every((at) => at >= 0), "all in the first transaction");
    assert.ok(Math.max(...familyAt) < linkAt && linkAt < Math.min(...keptAt), "families, then the link code, then the members ended one by one");
    assert.deepEqual([...keptAt].sort((a, b) => a - b), [keptAt[2], keptAt[1], keptAt[0]], "newest first");
    const coveredAt = covered.map((m) => position(`SESS#${m.session_id}`)).filter((at) => at >= 0);
    assert.ok(coveredAt.length > 0 && Math.min(...coveredAt) > Math.max(...keptAt), "the covered members only after every security effect");
  });

  test("review F1: a sign-out-others interrupted after its first transaction (UNKNOWN, held) leaves a prefix in which every other device is already out, the link code is gone, and this device stays in", async () => {
    const { table, client, script, held, store, set, keptOthers, covered, signOutOthers } = await manyDevices("chunk-others-cut");
    for (let n = 2; n <= 5; n += 1) script.add({ op: "TransactWriteItemsCommand", nth: n, action: { kind: "fail", code: "TimeoutError" }, label: `the second transaction, send ${n - 1}` });
    const error = await rejection(store.commit(signOutOthers));
    assert.ok(isUncertain(error), `applied in part is UNKNOWN: ${String(error)}`);
    assert.equal(held.length, 1);
    assert.match(held[0], /applied in part: 1 of 2 transactions committed/);
    assert.deepEqual(script.unfired(), []);
    const loaded = await openStore(client, table).load();
    assert.deepEqual(loaded.links, [], "the profile's link code is gone (LIVE-2E H1)");
    for (const member of keptOthers) {
      assert.equal(loaded.sessions.find((m) => m.session_id === member.session_id)?.revoke_reason, "signed-out-remotely", "the kept family's other members are ended");
    }
    const coveredRevoked = covered.filter((m) => loaded.sessions.find((x) => x.session_id === m.session_id)?.revoke_reason === "signed-out-remotely").length;
    assert.ok(coveredRevoked < covered.length, `the cut is real: ${coveredRevoked} of ${covered.length} covered members written`);
    const service = IdentityService.fromSnapshot(openStore(client, table), loaded);
    for (const member of [...keptOthers, ...covered]) {
      assert.equal(service.socketVerdict({ principalId: member.principal_id, sessionId: member.session_id, sessionExpiresAt: member.expires_at }, T0 + 100_000), "revoked", "every other device is out");
    }
    assert.equal(service.socketVerdict({ principalId: set.session.principal_id, sessionId: set.session.session_id, sessionExpiresAt: set.session.expires_at }, T0 + 100_000), "ok", "this device stays in");
  });

  test("review F7: a later transaction refused without being evaluated (throttled) is retried -- six refusals in a row are ridden out -- and only a budget spent makes the change applied in part", async () => {
    const { table, client, script, held, store, all, signOut } = await bigFamily("chunk-throttled");
    /* The attempt and five retries refused: the sixth retry lands (the budget is at least that, about 15 s). */
    for (let n = 2; n <= 7; n += 1) script.add({ op: "TransactWriteItemsCommand", nth: n, action: { kind: "fail" }, label: `the second transaction is throttled (${n - 1})` });
    await store.commit(signOut);
    assert.deepEqual(script.unfired(), []);
    assert.deepEqual(held, [], "not held: the change committed whole");
    const loaded = await openStore(client, table).load();
    assert.equal(loaded.sessions.filter((m) => m.revoke_reason === "logout").length, all.length);
    assert.ok(NOT_EVALUATED_RETRY_WAITS.reduce((sum, wait) => sum + wait, 0) <= 20_000, "and the budget is bounded");
    /* A throttle that never ends: the budget is finite -- applied in part, UNKNOWN, held. */
    const other = await bigFamily("chunk-throttled-forever");
    for (let n = 2; n <= 2 + NOT_EVALUATED_RETRY_WAITS.length; n += 1) other.script.add({ op: "TransactWriteItemsCommand", nth: n, action: { kind: "fail" }, label: `throttled (${n - 1})` });
    assert.ok(isUncertain(await rejection(other.store.commit(other.signOut))));
    assert.equal(other.held.length, 1);
  });

  test("a change whose single unit cannot fit one transaction is refused DEFINITE before anything is sent", () => {
    const set = identitySet(1);
    const plan = planIdentityChange(
      { expect: Array.from({ length: 120 }, (_, k) => ({ kind: "family-open" as const, family_id: familyIdOf(anotherSession(set, `gate-${k}`).session_id) })) },
      { profileSelector: () => undefined },
      "t",
    );
    assert.equal(plan.kind, "refused");
  });
});

/* ================================================================================================= */
/* C. The identity-writer role                                                                       */
/* ================================================================================================= */

describe("L5-4 C: the identity-writer role (ROLE_ID)", () => {
  test("each takeover moves the epoch by exactly one; every earlier holder is refused inside its write, learns it once, and sends nothing more", async () => {
    const table = await identityTable("role", null);
    const client = await suite.client();
    const script = new FaultScript();
    installFaults(client, script);
    assert.equal(await readIdentityRole(admin, table), null);
    const first = await takeOverIdentityWriter(admin, table, { task: "task-1", pool: "pool-a", now: () => T0 });
    assert.equal(first.epoch, 1);
    const fenced: string[] = [];
    const a = openStore(client, table, first.epoch, [], fenced);
    await a.load();
    const set = identitySet(1);
    await a.commit(creation(set));
    const second = await takeOverIdentityWriter(admin, table, { task: "task-2", pool: "pool-a", now: () => T0 + 1 });
    assert.equal(second.epoch, 2);
    const extra = anotherSession(set, "stale");
    const before = await tableItems(admin, table, [ROLE_KEY.pk]);
    assert.ok(isDefinite(await rejection(a.commit({ expect: [{ kind: "session-absent", session_id: extra.session_id }], sessions: [extra] }))));
    assert.equal(fenced.length, 1);
    const sent = script.count("TransactWriteItemsCommand");
    assert.ok(isDefinite(await rejection(a.commit({ expect: [{ kind: "session-absent", session_id: extra.session_id }], sessions: [extra] }))));
    assert.ok(isDefinite(await rejection(a.grants.put({ session_id: set.session.session_id, family_id: set.family.family_id, selector: set.profile.recovery_selector, expires_at: T0 + 1 }))));
    assert.equal(script.count("TransactWriteItemsCommand"), sent, "a fenced writer sends nothing more");
    assert.deepEqual(await tableItems(admin, table, [ROLE_KEY.pk]), before);
    const b = openStore(client, table, second.epoch);
    await b.load();
    await b.commit({ expect: [{ kind: "session-absent", session_id: extra.session_id }], sessions: [extra] });
    const role = await readIdentityRole(admin, table);
    assert.deepEqual([role?.epoch, role?.task, role?.pool], [2, "task-2", "pool-a"]);
  });

  test("the caller's own conditions are part of the takeover: one that fails refuses it and the epoch does not move", async () => {
    const table = await identityTable("role-checks", null);
    await takeOverIdentityWriter(admin, table, { task: "t", pool: "p", now: () => T0 });
    await admin.send(new PutItemCommand({ TableName: table, Item: { pk: { S: "ROUTING" }, sk: { S: "ROUTING" }, primary: { S: "pool-a" } } }), { abortSignal: deadline() });
    const primaryIs = (pool: string) => ({
      ConditionCheck: { TableName: table, Key: { pk: { S: "ROUTING" }, sk: { S: "ROUTING" } }, ConditionExpression: "#p = :p", ExpressionAttributeNames: { "#p": "primary" }, ExpressionAttributeValues: { ":p": { S: pool } } },
    });
    await assert.rejects(takeOverIdentityWriter(admin, table, { task: "t2", pool: "pool-b", now: () => T0, checks: [primaryIs("pool-b")] }), (error: Error) => error instanceof IdentityRoleRefusedError);
    assert.equal((await readIdentityRole(admin, table))?.epoch, 1);
    assert.equal((await takeOverIdentityWriter(admin, table, { task: "t3", pool: "pool-a", now: () => T0, checks: [primaryIs("pool-a")] })).epoch, 2);
  });

  test("two takeovers racing from the same reading never both hold one epoch: the loser re-reads and takes the next", async () => {
    const table = await identityTable("role-race", null);
    const client = await suite.client();
    const script = new FaultScript();
    installFaults(client, script);
    const stall = gate();
    script.add({ op: "TransactWriteItemsCommand", action: { kind: "stall", gate: stall }, label: "A's takeover stalls after its read" });
    const a = takeOverIdentityWriter(client, table, { task: "task-a", pool: "p", now: () => T0, sleep: IMMEDIATE });
    await stall.reached;
    const b = await takeOverIdentityWriter(admin, table, { task: "task-b", pool: "p", now: () => T0 });
    stall.release();
    const taken = await a;
    assert.equal(b.epoch, 1);
    assert.equal(taken.epoch, 2, "A's compare-and-swap failed on B's epoch; it took the next one");
    const role = await readIdentityRole(admin, table);
    assert.deepEqual([role?.epoch, role?.task], [2, "task-a"]);
  });

  test("an unknown takeover outcome is settled by the role's claim, never guessed: the epoch returned is the one this attempt set", async () => {
    const table = await identityTable("role-unknown", null);
    const client = await suite.client();
    const script = new FaultScript();
    installFaults(client, script);
    script.add({ op: "TransactWriteItemsCommand", action: { kind: "lose-answer" }, label: "the takeover lands, its answer is lost" });
    script.add({ op: "TransactWriteItemsCommand", nth: 2, action: { kind: "fail", code: "TimeoutError" }, label: "the resend times out" });
    script.add({ op: "TransactWriteItemsCommand", nth: 3, action: { kind: "fail", code: "TimeoutError" }, label: "and again" });
    script.add({ op: "TransactWriteItemsCommand", nth: 4, action: { kind: "fail", code: "TimeoutError" }, label: "and again" });
    const taken = await takeOverIdentityWriter(client, table, { task: "t", pool: "p", now: () => T0, sleep: IMMEDIATE });
    assert.equal(taken.epoch, 1);
    assert.equal((await readIdentityRole(admin, table))?.epoch, 1);
    assert.deepEqual(script.unfired(), []);
  });

  test("review F3: a takeover writes only a role item its codec reads back -- a task or pool it would refuse, or a time that is not one, is refused before anything is sent", async () => {
    const table = await identityTable("role-inputs", null);
    const client = await suite.client();
    const script = new FaultScript();
    installFaults(client, script);
    await takeOverIdentityWriter(client, table, { task: "task-1", pool: "pool-a", now: () => T0 });
    const sent = script.count("TransactWriteItemsCommand");
    const bad: Array<[string, { task: string; pool: string; now: () => number }]> = [
      ["a task with a space", { task: "task 2", pool: "pool-a", now: () => T0 }],
      ["an empty pool", { task: "task-2", pool: "", now: () => T0 }],
      ["a pool of 129 characters", { task: "task-2", pool: "p".repeat(129), now: () => T0 }],
      ["a task that is not ASCII", { task: "tâche", pool: "pool-a", now: () => T0 }],
      ["a time that is a fraction", { task: "task-2", pool: "pool-a", now: () => T0 + 0.5 }],
      ["a time before 1970", { task: "task-2", pool: "pool-a", now: () => -1 }],
      ["a time that is not a number", { task: "task-2", pool: "pool-a", now: () => Number.NaN }],
    ];
    for (const [label, takeover] of bad) {
      await assert.rejects(takeOverIdentityWriter(client, table, takeover), (error: Error) => error instanceof IdentityRoleRefusedError && /nothing was sent/.test(error.message), label);
    }
    assert.equal(script.count("TransactWriteItemsCommand"), sent, "nothing was sent");
    const role = await readIdentityRole(admin, table);
    assert.deepEqual([role?.epoch, role?.task, role?.pool], [1, "task-1", "pool-a"], "the role item is untouched, and still reads");
    assert.equal((await takeOverIdentityWriter(client, table, { task: "task-2", pool: "pool-a", now: () => T0 + 1 })).epoch, 2);
  });

  test("review F6: a writer whose epoch is not the table's learns it at the LOAD -- fenced once, every write refused without being sent -- and a table with no role at all fences it the same way", async () => {
    for (const tableEpoch of [2, null] as const) {
      const table = await identityTable(`load-fence-${tableEpoch ?? "none"}`, tableEpoch);
      const client = await suite.client();
      const script = new FaultScript();
      installFaults(client, script);
      const fenced: string[] = [];
      const stale = openStore(client, table, 1, [], fenced);
      const loaded = await stale.load();
      assert.deepEqual(loaded, EMPTY, "the load still answers");
      assert.equal(fenced.length, 1, "fenced at the load");
      assert.notEqual(stale.health().fenced, null);
      const set = identitySet(1);
      assert.ok(isDefinite(await rejection(stale.commit(creation(set)))));
      assert.ok(isDefinite(await rejection(stale.grants.put({ session_id: set.session.session_id, family_id: set.family.family_id, selector: set.profile.recovery_selector, expires_at: T0 + 1 }))));
      assert.equal(script.count("TransactWriteItemsCommand"), 0, "nothing was sent");
      assert.equal(fenced.length, 1, "learned once");
    }
  });

  test("review F4: a grant write is bounded -- one resend, then UNKNOWN -- and an unknown grant does not hold the identity writer", async () => {
    const table = await identityTable("grant-bounded");
    const client = await suite.client();
    const script = new FaultScript();
    installFaults(client, script);
    const held: string[] = [];
    const store = openStore(client, table, 1, held);
    await store.load();
    const set = identitySet(1);
    await store.commit(creation(set));
    for (let n = 1; n <= 2; n += 1) script.add({ op: "TransactWriteItemsCommand", nth: n, action: { kind: "fail", code: "TimeoutError" }, label: `grant send ${n}` });
    const before = script.count("TransactWriteItemsCommand");
    const error = await rejection(store.grants.put({ session_id: set.session.session_id, family_id: set.family.family_id, selector: set.profile.recovery_selector, expires_at: T0 + 300_000 }));
    assert.ok(isUncertain(error), String(error));
    assert.equal(script.count("TransactWriteItemsCommand") - before, 2, "the attempt and ONE resend");
    assert.deepEqual(script.unfired(), []);
    assert.deepEqual(held, [], "a grant can only add what the service allows: not held");
    const extra = anotherSession(set, "after-grant");
    await store.commit({ expect: [{ kind: "session-absent", session_id: extra.session_id }], sessions: [extra] });
  });
});

/* ================================================================================================= */
/* C'. The commit marker settles what the idempotency token cannot                                    */
/* ================================================================================================= */

describe("L5-4 C': a resend DynamoDB no longer recognises (its token window passed) is settled by the commit marker", () => {
  /** Installed BEFORE the fault script (so it sees every send): a transaction resent with a token this client already
   *  sent goes out under a new token -- DynamoDB then evaluates it as a new request, as it would past the window. */
  let forgotten = 0;
  function forgetResentTokens(client: DynamoDBClient): void {
    const sent = new Set<string>();
    client.middlewareStack.add(
      (next, context) => async (args) => {
        if ((context as { commandName?: string }).commandName !== "TransactWriteItemsCommand") return next(args);
        const input = (args as { input: { ClientRequestToken?: string } }).input;
        const token = input.ClientRequestToken ?? "";
        if (!sent.has(token)) {
          sent.add(token);
          return next(args);
        }
        forgotten += 1;
        /* A token nobody ever sent: DynamoDB remembers a token endpoint-wide for ten minutes, across tables and runs. */
        return next({ ...args, input: { ...input, ClientRequestToken: randomUUID() } } as typeof args);
      },
      { step: "initialize", name: "l54ForgetResentTokens" },
    );
  }

  for (const landed of [true, false]) {
    test(`the first attempt ${landed ? "LANDED" : "did not land"}: the unrecognised resend ${landed ? "is refused by the marker it finds -- committed, once" : "applies it -- committed, once"}`, async () => {
      const table = await identityTable(`marker-${landed}`);
      const client = await suite.client();
      forgetResentTokens(client);
      const script = new FaultScript();
      installFaults(client, script);
      const store = openStore(client, table);
      await store.load();
      const set = identitySet(1);
      await store.commit(creation(set));
      const extra = anotherSession(set, "window");
      script.add({ op: "TransactWriteItemsCommand", action: landed ? { kind: "lose-answer" } : { kind: "fail", code: "TimeoutError" }, label: "the first attempt's answer is lost" });
      const rewritten = forgotten;
      await store.commit({ expect: [{ kind: "session-absent", session_id: extra.session_id }], sessions: [extra] });
      assert.deepEqual(script.unfired(), []);
      assert.equal(forgotten, rewritten + 1, "the resend went out under a token DynamoDB had never seen");
      const loaded = await openStore(client, table).load();
      assert.equal(loaded.sessions.filter((session) => session.session_id === extra.session_id).length, 1, "applied exactly once");
      assert.equal(store.stats.redone, 1);
    });
  }

  test("the first attempt LANDED and no read can be made: the unrecognised resend, refused by its own marker, settles it by itself -- committed, once", async () => {
    const table = await identityTable("marker-unreadable");
    const client = await suite.client();
    forgetResentTokens(client);
    const script = new FaultScript();
    installFaults(client, script);
    const store = openStore(client, table);
    await store.load();
    const set = identitySet(1);
    await store.commit(creation(set));
    const extra = anotherSession(set, "unreadable");
    script.add({ op: "TransactWriteItemsCommand", action: { kind: "lose-answer" }, label: "the first attempt lands; its answer is lost" });
    for (let n = 1; n <= 6; n += 1) script.add({ op: "GetItemCommand", nth: n, action: { kind: "fail", code: "TimeoutError" }, label: `strong read ${n} fails` });
    await store.commit({ expect: [{ kind: "session-absent", session_id: extra.session_id }], sessions: [extra] });
    assert.equal(script.count("GetItemCommand"), 0, "no read was needed: the marker's own refusal is proof");
    const loaded = await openStore(client, table).load();
    assert.equal(loaded.sessions.filter((session) => session.session_id === extra.session_id).length, 1, "applied exactly once");
  });

  test("a late copy of an applied transaction, outside its token's window, can never apply twice: its own marker refuses it", async () => {
    const table = await identityTable("marker-late");
    const client = await suite.client();
    const script = new FaultScript();
    installFaults(client, script);
    const store = openStore(client, table);
    await store.load();
    const set = identitySet(1);
    await store.commit(creation(set));
    const extra = anotherSession(set, "late");
    await store.commit({ sessions: [{ ...extra }] }); // an upsert: no condition of its own would refuse a replay
    const sent = script.calls.filter((call) => call.op === "TransactWriteItemsCommand");
    const original = JSON.parse(sent[sent.length - 1].detail) as { TransactItems: unknown[]; ClientRequestToken: string };
    const before = await tableItems(admin, table);
    const { TransactWriteItemsCommand } = await import("@aws-sdk/client-dynamodb");
    await assert.rejects(
      admin.send(new TransactWriteItemsCommand({ TransactItems: original.TransactItems as never, ClientRequestToken: randomUUID() }), { abortSignal: deadline() }),
      (error: Error & { CancellationReasons?: Array<{ Code?: string }> }) => error.name === "TransactionCanceledException" && error.CancellationReasons?.[1]?.Code === "ConditionalCheckFailed",
    );
    assert.deepEqual(await tableItems(admin, table), before, "nothing applied twice");
  });
});

/* ================================================================================================= */
/* D. Damage                                                                                        */
/* ================================================================================================= */

describe("L5-4 D: every kind of damage refuses the load", () => {
  const variants: Array<[string, (table: string, items: Item[]) => Promise<void>]> = [];
  const find = (items: Item[], prefix: string) => {
    const found = items.find((item) => item.pk?.S?.startsWith(prefix));
    if (found === undefined) throw new Error(`no ${prefix} item`);
    return found;
  };
  const put = (table: string, item: Item) => admin.send(new PutItemCommand({ TableName: table, Item: item }), { abortSignal: deadline() }).then(() => undefined);
  variants.push(["a session attribute of the wrong type", (t, items) => put(t, { ...find(items, "SESS#"), expires_at: { S: "soon" } })]);
  variants.push(["an extra attribute on a principal", (t, items) => put(t, { ...find(items, "PRIN#"), nickname: { S: "x" } })]);
  variants.push([
    "a missing attribute on a family",
    (t, items) => {
      const { origin: _origin, ...rest } = find(items, "FAM#");
      return put(t, rest);
    },
  ]);
  /* (DynamoDB normalizes a number's spelling -- "0178..." is stored as "178..." -- so the damage a number can carry
     is its value: a fraction, or past the safe-integer range.) */
  variants.push(["a time that is a fraction", (t, items) => put(t, { ...find(items, "SESS#"), created_at: { N: "1780000000000.5" } })]);
  variants.push(["a time past the safe-integer range", (t, items) => put(t, { ...find(items, "FAM#"), created_at: { N: "90071992547409930" } })]);
  variants.push(["a key naming another record", (t, items) => put(t, { ...find(items, "SESS#"), pk: { S: `SESS#${anotherSession(identitySet(1), "elsewhere").session_id}` } })]);
  variants.push(["an item of no known class", (t) => put(t, { pk: { S: "FOO#x" }, sk: { S: "META" }, fmt: { N: "1" } })]);
  variants.push(["an item of another layout", (t, items) => put(t, { ...find(items, "PRIN#"), fmt: { N: "2" } })]);
  variants.push(["a profile whose selector item is gone", (t, items) => admin.send(new DeleteItemCommand({ TableName: t, Key: { pk: find(items, "SEL#").pk, sk: find(items, "SEL#").sk } }), { abortSignal: deadline() }).then(() => undefined)]);
  variants.push(["a live selector item naming no profile", (t) => put(t, { ...keyAttributes(keys.selector(identitySet(4).profile.recovery_selector)), fmt: { N: "1" }, recovery_selector: { S: identitySet(4).profile.recovery_selector }, profile_id: { S: identitySet(4).profile.profile_id }, retired_at: { NULL: true } })]);
  variants.push(["the current selector marked retired", (t, items) => put(t, { ...find(items, "SEL#"), retired_at: { N: String(T0) } })]);
  variants.push(["a session in another principal's family", (t, items) => put(t, { ...find(items, "SESS#"), principal_id: { S: identitySet(2).principal.principal_id } })]);
  variants.push(["a session whose principal is not stored", (t, items) => admin.send(new DeleteItemCommand({ TableName: t, Key: { pk: find(items, "PRIN#").pk, sk: find(items, "PRIN#").sk } }), { abortSignal: deadline() }).then(() => undefined)]);
  variants.push(["a second role item's worth of damage: a malformed role", (t) => admin.send(new UpdateItemCommand({ TableName: t, Key: keyAttributes(ROLE_KEY), UpdateExpression: "SET #e = :e", ExpressionAttributeNames: { "#e": "epoch" }, ExpressionAttributeValues: { ":e": { S: "one" } } }), { abortSignal: deadline() }).then(() => undefined)]);
  variants.push(["a grant whose TTL does not follow its expiry", (t, items) => put(t, { ...find(items, "GRANT#"), ttl: { N: "1" } })]);
  variants.push(["a commit marker with no TTL", (t, items) => {
    const { ttl: _ttl, ...rest } = find(items, "TXN#");
    return put(t, rest);
  }]);
  variants.push(["an unactivated principal", (t, items) => put(t, { ...find(items, "PRIN#"), activated_at: { NULL: true } })]);

  for (const [label, damage] of variants) {
    test(`${label}: the load refuses (IdentityStoreCorruptError) and changes nothing`, async () => {
      const table = await identityTable("damage");
      const client = await suite.client();
      const store = openStore(client, table);
      await store.load();
      const set = identitySet(1);
      await store.commit(creation(set));
      await store.grants.put({ session_id: set.session.session_id, family_id: set.family.family_id, selector: set.profile.recovery_selector, expires_at: T0 + 300_000 });
      await damage(table, await tableItems(admin, table));
      const damaged = await tableItems(admin, table);
      await assert.rejects(openStore(client, table).load(), (error: Error) => error.name === "IdentityStoreCorruptError" && !error.message.includes(set.session.session_id) && !error.message.includes(set.principal.principal_id));
      assert.deepEqual(await tableItems(admin, table), damaged, "a refused load writes nothing");
      await suite.tables.drop(table);
    });
  }
});

/* ================================================================================================= */
/* E. A table changed behind the writer's back                                                      */
/* ================================================================================================= */

describe("L5-4 E: the writer's view and the table disagree", () => {
  test("a family revoked behind the writer: its mint is refused by the table's condition, DEFINITE, nothing written, and the store holds for a restart", async () => {
    const table = await identityTable("divergence");
    const client = await suite.client();
    const held: string[] = [];
    const store = openStore(client, table, 1, held);
    await store.load();
    const set = identitySet(1);
    await store.commit(creation(set));
    await admin.send(
      new UpdateItemCommand({
        TableName: table,
        Key: keyAttributes(keys.family(set.family.family_id)),
        UpdateExpression: "SET #r = :r, #why = :why",
        ExpressionAttributeNames: { "#r": "revoked_at", "#why": "revoke_reason" },
        ExpressionAttributeValues: { ":r": { N: String(T0 + 5) }, ":why": { S: "operator" } },
      }),
      { abortSignal: deadline() },
    );
    const before = await tableItems(admin, table);
    const mint = anotherSession(set, "mint");
    const error = await rejection(store.commit({ expect: [{ kind: "family-open", family_id: set.family.family_id }, { kind: "session-absent", session_id: mint.session_id }], sessions: [mint] }));
    assert.ok(isDefinite(error), String(error));
    assert.match(String((error as Error).message), /refused a change this writer's view accepted/);
    assert.equal(held.length, 1, "the store holds itself for a restart");
    assert.deepEqual(await tableItems(admin, table), before, "nothing was written");
    assert.equal(store.stats.divergences, 1);
    assert.ok(isDefinite(await rejection(store.commit({ sessions: [] }))), "and refuses from then on");
  });
});

/* ================================================================================================= */
/* F. The identity service on DynamoDB, with the security substrate                                 */
/* ================================================================================================= */

describe("L5-4 F: the identity service over the DynamoDB adapter", () => {
  const readOf = (setCookie: string | null | undefined): SessionCookieRead => {
    assert.ok(setCookie, "a Set-Cookie");
    return readSessionCookie(setCookie.split(";")[0]);
  };
  const sessionIdOf = (read: SessionCookieRead) => (read.kind === "session" ? read.sessionId : "");

  async function world() {
    const identityTableName = await identityTable("service", null);
    const ledger = await suite.tables.create("service-ledger");
    await admin.send(new PutItemCommand({ TableName: ledger, Item: { ...APPGEN_KEY, current_generation: { N: "1" } } }), { abortSignal: deadline() });
    const client = await suite.client();
    const identityFaults = new FaultScript();
    installFaults(client, identityFaults);
    const ledgerClient = await suite.client();
    const ledgerFaults = new FaultScript();
    installFaults(ledgerClient, ledgerFaults);
    const journal = createDynamoSecurityJournal(ledgerClient, ledger, { generation: 1, sleep: IMMEDIATE });
    let clock = T0;
    const restart = async () => {
      const { epoch } = await takeOverIdentityWriter(admin, identityTableName, { task: `task-${clock}`, pool: "pool-a", now: () => clock });
      const held: string[] = [];
      const fenced: string[] = [];
      const store = openStore(client, identityTableName, epoch, held, fenced);
      const failures: string[] = [];
      const identity = await IdentityService.open(store, { security: { journal, grants: store.grants, clock: () => clock }, hooks: { onStoreFailure: (what) => failures.push(what) } });
      return { identity, store, failures, held, fenced };
    };
    return { identityTableName, ledger, client, journal, identityFaults, ledgerFaults, restart, now: () => clock, advance: (ms: number) => (clock += ms) };
  }

  test("a profile's life across restarts: every security change journaled first and in order; the grant survives a restart (OD-5-4) and dies with its key", async () => {
    const w = await world();
    let { identity } = await w.restart();
    const boot = await identity.bootstrap({ kind: "none" }, false, w.now());
    const ann = readOf((boot as { setCookie: string | null }).setCookie);
    const created = await identity.createProfile(ann, "Ann", w.now());
    assert.equal(created.kind, "ok");
    const key = (created as { recoveryKey: string }).recoveryKey;
    const principalId = identity.peekSession(sessionIdOf(ann))?.principal_id as string;
    w.advance(1000);
    /* A second device, by the recovery key. */
    const phoneBoot = await identity.bootstrap({ kind: "none" }, false, w.now());
    const recovered = await identity.recover(readOf((phoneBoot as { setCookie: string | null }).setCookie), key, w.now());
    assert.equal(recovered.kind, "ok");
    const phone = readOf((recovered as { setCookie: string }).setCookie);
    /* Re-authenticate, then restart: the grant is still there. */
    assert.equal((await identity.reauthenticate(ann, key, w.now())).kind, "ok");
    ({ identity } = await w.restart());
    w.advance(1000);
    assert.equal(identity.hasSensitiveAuth(ann, w.now()), true, "OD-5-4: a restart does not drop a live grant");
    assert.equal(identity.hasSensitiveAuth(phone, w.now()), false, "another session never borrows it");
    /* Sign out the other devices (it needs the grant), then rotate the key. */
    const others = await identity.signOutOthers(ann, w.now());
    assert.equal(others.kind, "ok");
    assert.equal(identity.authenticate(phone, w.now()).kind, "refused");
    w.advance(1000);
    const rotated = await identity.rotateRecoveryKey(ann, w.now());
    assert.equal(rotated.kind, "ok");
    await identity.settled(); // the confirmation follows the answer (R3-1); a graceful restart drains it first
    ({ identity } = await w.restart());
    assert.equal(identity.hasSensitiveAuth(ann, w.now()), false, "the reloaded grant names the old key: it is dead");
    assert.equal(identity.authenticate(phone, w.now()).kind, "refused", "the signed-out device stays out across a restart");
    assert.equal((await identity.recover(readOf(((await identity.bootstrap({ kind: "none" }, false, w.now())) as { setCookie: string | null }).setCookie), key, w.now())).kind, "invalid", "the old key is dead");
    /* Sign this device out. */
    w.advance(1000);
    assert.equal(await identity.revoke(sessionIdOf(ann), "logout", w.now()), true);
    await identity.settled();
    ({ identity } = await w.restart());
    assert.equal(identity.authenticate(ann, w.now()).kind, "refused");
    const events = await w.journal.eventsOf(principalId);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["profile-created", "confirmed", "signed-out-others", "confirmed", "recovery-key-rotated", "confirmed", "family-revoked", "confirmed"],
    );
    for (let at = 0; at < events.length; at += 2) {
      const confirmation = events[at + 1] as Extract<SecurityEvent, { kind: "confirmed" }>;
      assert.deepEqual([confirmation.confirms, confirmation.confirmed_kind, confirmation.at], [events[at].event_id, events[at].kind, events[at].at], "each change confirmed, straight after its event");
    }
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(key.split(".")[1]), "no recovery-key secret in the journal");
  });

  test("review F2: a writer that was taken over journals NOTHING (it reads its role before the event); one taken over while its event is written leaves that event UNCONFIRMED and its change refused DEFINITE, inside the write", async () => {
    const w = await world();
    const first = await w.restart();
    const boot = await first.identity.bootstrap({ kind: "none" }, false, w.now());
    const ann = readOf((boot as { setCookie: string | null }).setCookie);
    const created = await first.identity.createProfile(ann, "Ann", w.now());
    const key = (created as { recoveryKey: string }).recoveryKey;
    const principalId = first.identity.peekSession(sessionIdOf(ann))?.principal_id as string;
    const phoneBoot = await first.identity.bootstrap({ kind: "none" }, false, w.now());
    const phone = readOf(((await first.identity.recover(readOf((phoneBoot as { setCookie: string | null }).setCookie), key, w.now())) as { setCookie: string }).setCookie);
    assert.equal((await first.identity.reauthenticate(ann, key, w.now())).kind, "ok");
    const journaled = (await w.journal.eventsOf(principalId)).length;
    assert.equal(journaled, 2, "the creation and its confirmation");

    /* (a) The role moved behind this writer: its own role read, before the event, refuses the change. */
    await takeOverIdentityWriter(admin, w.identityTableName, { task: "successor", pool: "pool-a", now: () => w.now() });
    const identityBefore = await tableItems(admin, w.identityTableName, [ROLE_KEY.pk]);
    assert.equal((await first.identity.signOutOthers(ann, w.now())).kind, "unavailable");
    assert.equal((await w.journal.eventsOf(principalId)).length, journaled, "no event from a writer that could see it was stale");
    assert.equal(first.fenced.length, 1, "and it learned it");
    assert.deepEqual(await tableItems(admin, w.identityTableName, [ROLE_KEY.pk]), identityBefore);

    /* (b) The role moves WHILE the event is being written: the event lands, the write is refused inside the write. */
    w.advance(1000);
    const second = await w.restart();
    assert.equal((await second.identity.reauthenticate(ann, key, w.now())).kind, "ok");
    const before = await tableItems(admin, w.identityTableName, [ROLE_KEY.pk]);
    const stall = gate();
    w.ledgerFaults.add({ op: "TransactWriteItemsCommand", action: { kind: "stall", gate: stall }, label: "the event's append stalls" });
    const pending = second.identity.signOutOthers(ann, w.now());
    await stall.reached;
    await takeOverIdentityWriter(admin, w.identityTableName, { task: "third", pool: "pool-a", now: () => w.now() });
    stall.release();
    assert.equal((await pending).kind, "unavailable");
    assert.deepEqual(w.ledgerFaults.unfired(), []);
    assert.deepEqual(await tableItems(admin, w.identityTableName, [ROLE_KEY.pk]), before, "nothing was written: the fence inside the write");
    assert.equal(second.fenced.length, 1);
    const events = await w.journal.eventsOf(principalId);
    assert.equal(events.length, journaled + 1, "one more event, and no confirmation");
    const phantom = events.find((event) => event.kind === "signed-out-others") as SecurityEvent;
    const confirmed = new Set(events.flatMap((event) => (event.kind === "confirmed" ? [event.confirms] : [])));
    assert.ok(!confirmed.has(phantom.event_id), "the event stays, UNCONFIRMED: a phantom a replay reads as possibly never committed");
    /* The truth, after a restart: the other device is still signed in (the sign-out never happened). */
    const third = await w.restart();
    assert.equal(third.identity.authenticate(phone, w.now()).kind, "ok");
  });

  /** A profile with a second device, and a re-authentication (the grant sign-out-others and a rotation need). */
  async function annWithPhone(w: Awaited<ReturnType<typeof world>>) {
    const writer = await w.restart();
    const boot = await writer.identity.bootstrap({ kind: "none" }, false, w.now());
    const ann = readOf((boot as { setCookie: string | null }).setCookie);
    const created = await writer.identity.createProfile(ann, "Ann", w.now());
    const key = (created as { recoveryKey: string }).recoveryKey;
    const principalId = writer.identity.peekSession(sessionIdOf(ann))?.principal_id as string;
    const phoneBoot = await writer.identity.bootstrap({ kind: "none" }, false, w.now());
    const phone = readOf(((await writer.identity.recover(readOf((phoneBoot as { setCookie: string | null }).setCookie), key, w.now())) as { setCookie: string }).setCookie);
    assert.equal((await writer.identity.reauthenticate(ann, key, w.now())).kind, "ok");
    w.advance(1000);
    return { ...writer, ann, key, principalId, phone };
  }

  test("re-review N1: once its event is recorded, a change whose FIRST transaction is only throttled is retried -- it commits and is confirmed, not left a phantom", async () => {
    const w = await world();
    const { identity, ann, principalId, held } = await annWithPhone(w);
    for (let n = 1; n <= 2; n += 1) w.identityFaults.add({ op: "TransactWriteItemsCommand", nth: n, action: { kind: "fail" }, label: `the rotation's transaction is throttled (${n})` });
    const rotated = await identity.rotateRecoveryKey(ann, w.now());
    assert.equal(rotated.kind, "ok");
    assert.deepEqual(w.identityFaults.unfired(), []);
    assert.deepEqual(held, []);
    await identity.settled();
    const events = await w.journal.eventsOf(principalId);
    const rotation = events.find((event) => event.kind === "recovery-key-rotated") as SecurityEvent;
    assert.ok(events.some((event) => event.kind === "confirmed" && event.confirms === rotation.event_id), "the rotation is confirmed");
  });

  test("re-review N2 and R3-1: a committed sign-out is enforced AND answered while its confirmation is stalled; only the queue behind it waits", { timeout: 10_000 }, async () => {
    const w = await world();
    const { identity, ann, phone, principalId } = await annWithPhone(w);
    const stall = gate();
    w.ledgerFaults.add({ op: "TransactWriteItemsCommand", nth: 2, action: { kind: "stall", gate: stall }, label: "the confirmation's append stalls (the event's went through)" });
    assert.equal((await identity.signOutOthers(ann, w.now())).kind, "ok", "answered without waiting for its confirmation");
    await stall.reached;
    assert.equal(identity.authenticate(phone, w.now()).kind, "refused", "the other device is already out");
    let started = false;
    const next = identity.bootstrap({ kind: "none" }, false, w.now()).then((answer) => {
      started = true;
      return answer;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(started, false, "the next identity task waits for the pending confirmation");
    stall.release();
    await next;
    await identity.settled();
    assert.deepEqual(w.ledgerFaults.unfired(), []);
    const events = await w.journal.eventsOf(principalId);
    const signOut = events.find((event) => event.kind === "signed-out-others") as SecurityEvent;
    assert.ok(events.some((event) => event.kind === "confirmed" && event.confirms === signOut.event_id));
  });

  test("round-3 R3-1: a key rotation answers the new key while its confirmation is stalled -- a stalled ledger can no longer hold back the only copy of the key", { timeout: 10_000 }, async () => {
    const w = await world();
    const { identity, ann, principalId } = await annWithPhone(w);
    const stall = gate();
    w.ledgerFaults.add({ op: "TransactWriteItemsCommand", nth: 2, action: { kind: "stall", gate: stall }, label: "the rotation's confirmation stalls" });
    const rotated = await identity.rotateRecoveryKey(ann, w.now());
    assert.equal(rotated.kind, "ok", "the new key is answered");
    const newKey = (rotated as { recoveryKey: string }).recoveryKey;
    await stall.reached;
    assert.equal(identity.peekProfileOf(principalId)?.recovery_selector, newKey.split(".")[0]);
    stall.release();
    await identity.settled();
    const events = await w.journal.eventsOf(principalId);
    const rotation = events.find((event) => event.kind === "recovery-key-rotated") as SecurityEvent;
    assert.ok(events.some((event) => event.kind === "confirmed" && event.confirms === rotation.event_id), "and confirmed once the ledger answers");
    /* The key that was answered is the key that works. */
    const boot = await identity.bootstrap({ kind: "none" }, false, w.now());
    assert.equal((await identity.recover(readOf((boot as { setCookie: string | null }).setCookie), newKey, w.now())).kind, "ok");
  });

  test("journal first: an event that cannot be recorded stops its change -- nothing committed, the action answers unavailable", async () => {
    const w = await world();
    const { identity } = await w.restart();
    const boot = await identity.bootstrap({ kind: "none" }, false, w.now());
    const ann = readOf((boot as { setCookie: string | null }).setCookie);
    const created = await identity.createProfile(ann, "Ann", w.now());
    const key = (created as { recoveryKey: string }).recoveryKey;
    assert.equal((await identity.reauthenticate(ann, key, w.now())).kind, "ok");
    const before = await tableItems(admin, w.identityTableName, [ROLE_KEY.pk]);
    for (const fault of [{ kind: "fail" as const }, { kind: "fail" as const, code: "TimeoutError" }]) {
      const sends = fault.code === "TimeoutError" ? 4 : 1;
      for (let n = 1; n <= sends; n += 1) w.ledgerFaults.add({ op: "TransactWriteItemsCommand", nth: n, action: fault, label: `ledger send ${n}` });
      const outcome = await identity.rotateRecoveryKey(ann, w.now());
      assert.equal(outcome.kind, "unavailable", `a ${fault.code ?? "definite"} journal failure fails the rotation`);
      assert.deepEqual(await tableItems(admin, w.identityTableName, [ROLE_KEY.pk]), before, "no identity change was committed");
      assert.equal(identity.hasSensitiveAuth(ann, w.now()), true, "and the service's own state did not move");
    }
    assert.deepEqual(w.ledgerFaults.unfired(), []);
    assert.equal((await identity.rotateRecoveryKey(ann, w.now())).kind, "ok", "with the journal back, the rotation goes through");
  });
});
