// server/src/identity/ludumDisplayNames.test.ts
//
// ==================================================================
//  LUDUM -- UNIQUE DISPLAY NAMES AND THE ONE CHANGE BEFORE THE FIRST GAME
// ==================================================================
//
//   A. the uniqueness key: case, width and spacing variants are one name;
//   B. account creation refuses a held name (`display-name-taken`), at the service and over HTTP (409);
//   C. the one change: once, unique, never while seated or playing, survives a restart (the index is rebuilt);
//   D. the store's compare-and-swap (`profile-name`): a second change written from a stale view is DEFINITE;
//   E. DynamoDB: the item round-trips `name_changed_at`; the plan pins the change exactly as the memory store does, and a
//      record without the change can never overwrite one with it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { cookieRead } from "../rooms/testSupport";
import { TEST_PASSWORD_KDF } from "../escrow/escrow4Support";
import { createAccountWith, keplrAccount } from "../testSupport/authorizationWallets";
import { StoreDefiniteError } from "../persistence/storeResult";
import { decodeItem, profileItem } from "../aws/identity/identityItems";
import { planIdentityChange } from "../aws/identity/identityPlan";
import { displayNameKey } from "./profileName";
import { IdentityService } from "./sessions";
import { applyChange, createMemoryIdentityStore, isProfile, type Profile } from "./store";
import { createMemorySecurityJournal, parseSecurityEventBody, SECURITY_EVENT_FORMAT, SECURITY_EVENT_VERSION, type SecurityEvent } from "./securityEvents";
import { planSecurityReplay, SecurityReplayError } from "./securityReplay";
import { mintPrincipalId, mintProfileId } from "./ids";

const mintPrincipalIdForTest = (): string => mintPrincipalId();
const mintProfileIdForTest = (): string => mintProfileId();

const PASSWORD = "correct horse battery";
const POLICY = { passwordKdf: TEST_PASSWORD_KDF };

async function guestOf(service: IdentityService, now: number) {
  const boot = await service.bootstrap({ kind: "none" }, false, now);
  assert.equal(boot.kind, "ok");
  return cookieRead(((boot as { setCookie: string }).setCookie as string).split(";")[0]);
}

async function account(service: IdentityService, username: string, displayName: string, now: number) {
  return createAccountWith(service, await guestOf(service, now), { username, password: PASSWORD, displayName, wallet: keplrAccount(`ludum-names/${username}`) }, now);
}

function principalOf(service: IdentityService, made: { setCookie?: string }, now: number): string {
  const auth = service.authenticate(cookieRead((made.setCookie as string).split(";")[0]), now);
  assert.equal(auth.kind, "ok");
  return (auth as { principalId: string }).principalId;
}

describe("Ludum display names A: the uniqueness key", () => {
  test("case, compatibility width and whitespace variants share one key; different names do not", () => {
    assert.equal(displayNameKey("Marlowe"), displayNameKey("marlowe"));
    assert.equal(displayNameKey("MARLOWE"), displayNameKey("ｍａｒｌｏｗｅ"));
    assert.equal(displayNameKey("Ann  Lee"), displayNameKey("ann lee"));
    assert.notEqual(displayNameKey("Ann"), displayNameKey("Anne"));
  });
});

describe("Ludum display names B: creation refuses a held name", () => {
  test("a second account cannot take a name another profile holds, in any case variant", async () => {
    const now = Date.now();
    const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: POLICY });
    assert.equal((await account(service, "ann", "Marlowe", now)).kind, "ok");
    assert.equal((await account(service, "bob", "marlowe", now)).kind, "display-name-taken");
    assert.equal((await account(service, "bob", "Marlowe", now)).kind, "display-name-taken");
    assert.equal((await account(service, "bob", "Bob", now)).kind, "ok");
  });
});

describe("Ludum display names C: the one change", () => {
  test("changes once, to a free name; the old name is released; a second change is refused", async () => {
    const now = Date.now();
    const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: POLICY });
    const ann = principalOf(service, (await account(service, "ann", "Ann", now)) as { setCookie: string }, now);
    const bob = principalOf(service, (await account(service, "bob", "Bob", now)) as { setCookie: string }, now);
    const none = () => "none" as const;
    assert.deepEqual(service.displayNameState(ann, "none"), { kind: "changeable" });
    assert.equal((await service.changeDisplayName(ann, "bob", none, now)).kind, "taken");
    assert.equal((await service.changeDisplayName(ann, "  ", none, now)).kind, "bad-name");
    assert.equal((await service.changeDisplayName(ann, 42, none, now)).kind, "bad-name");
    assert.equal((await service.changeDisplayName(ann, "Ann", none, now)).kind, "unchanged");
    assert.deepEqual(await service.changeDisplayName(ann, "Marlowe", none, now + 1), { kind: "ok", name: "Marlowe" });
    assert.equal(service.profileName(ann), "Marlowe");
    assert.deepEqual(service.displayNameState(ann, "none"), { kind: "changed", at: now + 1 });
    assert.equal((await service.changeDisplayName(ann, "Someone Else", none, now)).kind, "already-changed");
    /* The old name is free again; the new one is held. */
    assert.equal(service.displayNameTaken("ann"), false);
    assert.equal(service.displayNameTaken("MARLOWE"), true);
    assert.equal((await service.changeDisplayName(bob, "marlowe", none, now)).kind, "taken");
    assert.equal((await service.changeDisplayName(bob, "Ann", none, now)).kind, "ok");
  });

  test("never while the account holds a seat: at a waiting table, or once a game has started", async () => {
    const now = Date.now();
    const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: POLICY });
    const ann = principalOf(service, (await account(service, "ann", "Ann", now)) as { setCookie: string }, now);
    assert.deepEqual(service.displayNameState(ann, "seated"), { kind: "locked-seated" });
    assert.deepEqual(service.displayNameState(ann, "playing"), { kind: "locked-playing" });
    assert.equal((await service.changeDisplayName(ann, "Marlowe", () => "seated", now)).kind, "locked-seated");
    assert.equal((await service.changeDisplayName(ann, "Marlowe", () => "playing", now)).kind, "locked-playing");
    assert.equal(service.profileName(ann), "Ann");
  });

  test("a restart rebuilds the index and keeps the used change", async () => {
    const now = Date.now();
    const store = createMemoryIdentityStore();
    const first = IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy: POLICY });
    const ann = principalOf(first, (await account(first, "ann", "Ann", now)) as { setCookie: string }, now);
    assert.equal((await first.changeDisplayName(ann, "Marlowe", () => "none", now)).kind, "ok");
    const second = IdentityService.fromSnapshot(store, store.snapshot(), { policy: POLICY });
    assert.equal(second.displayNameTaken("marlowe"), true);
    assert.equal((await second.changeDisplayName(ann, "Other", () => "none", now)).kind, "already-changed");
    assert.equal((await account(second, "bob", "Marlowe", now)).kind, "display-name-taken");
  });
});

describe("Ludum display names D: the store's compare-and-swap", () => {
  test("a change pinned to a name the profile no longer holds, or after the change was used, is DEFINITE", async () => {
    const now = Date.now();
    const store = createMemoryIdentityStore();
    const service = IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy: POLICY });
    const ann = principalOf(service, (await account(service, "ann", "Ann", now)) as { setCookie: string }, now);
    const stale = IdentityService.fromSnapshot(store, store.snapshot(), { policy: POLICY });
    assert.equal((await service.changeDisplayName(ann, "Marlowe", () => "none", now)).kind, "ok");
    /* The stale writer still believes the change is unused: the store refuses it, nothing written. */
    assert.equal((await stale.changeDisplayName(ann, "Racer", () => "none", now)).kind, "unavailable");
    const durable = store.snapshot().profiles[0];
    assert.equal(durable.display_name, "Marlowe");
    await assert.rejects(
      store.commit({ expect: [{ kind: "profile-name", profile_id: durable.profile_id, display_name: "Marlowe" }], profiles: [{ ...durable, display_name: "Again" }] }),
      StoreDefiniteError,
    );
  });

  test("the record shape: only schema 3 may carry name_changed_at, and only as a time", () => {
    const base = { profile_id: "x" } as unknown as Profile;
    assert.equal(isProfile({ ...base, name_changed_at: 1 }), false, "a malformed record stays malformed");
  });
});

describe("Ludum display names E: DynamoDB", () => {
  async function renamedProfile(): Promise<{ before: Profile; after: Profile }> {
    const now = Date.now();
    const store = createMemoryIdentityStore();
    const service = IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy: POLICY });
    const ann = principalOf(service, (await account(service, "ann", "Ann", now)) as { setCookie: string }, now);
    const before = store.snapshot().profiles[0];
    await service.changeDisplayName(ann, "Marlowe", () => "none", now);
    return { before, after: store.snapshot().profiles[0] };
  }

  test("the profile item round-trips with and without name_changed_at (and carries no such attribute before the change)", async () => {
    const { before, after } = await renamedProfile();
    const plain = profileItem(before);
    assert.equal(plain.name_changed_at, undefined);
    assert.deepEqual((decodeItem(plain) as { record: Profile }).record, before);
    const renamed = profileItem(after);
    assert.ok(renamed.name_changed_at !== undefined);
    assert.deepEqual((decodeItem(renamed) as { record: Profile }).record, after);
  });

  test("the plan pins the one change (schema 3, the name, no change yet) and never lets a record without it overwrite one with it", async () => {
    const { before, after } = await renamedProfile();
    const view = { profileSelector: () => before.recovery_selector };
    const change = { expect: [{ kind: "profile-name" as const, profile_id: before.profile_id, display_name: before.display_name }], profiles: [after] };
    const plan = planIdentityChange(change, view, "identity-table");
    assert.equal(plan.kind, "plan");
    const text = JSON.stringify(plan);
    assert.match(text, /attribute_not_exists\(#?[^)]*\)/);
    assert.ok(text.includes("name_changed_at"));
    /* Any later write of the renamed profile WITHOUT the field (a stale view) is guarded. */
    const stale = planIdentityChange({ profiles: [before] }, view, "identity-table");
    assert.equal(stale.kind, "plan");
    assert.ok(JSON.stringify(stale).includes("name_changed_at"), "the guard names the field");
  });
});

/* ==================================================================
    F. THE IDENTITY RESTORE (L6-4) -- names stay unique across a restore and its journal replay
   ================================================================== */
describe("Ludum display names F: the identity restore replays the one change in order, and never serves a duplicate", () => {
  async function journaled() {
    const journal = createMemorySecurityJournal();
    const store = createMemoryIdentityStore();
    const service = IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy: POLICY, security: { journal } });
    const events = () => journal.snapshot().map((body) => parseSecurityEventBody(body) as SecurityEvent);
    return { journal, store, service, events };
  }
  const replayed = (snapshot: ReturnType<ReturnType<typeof createMemoryIdentityStore>["snapshot"]>, events: SecurityEvent[], at: number) => {
    const plan = planSecurityReplay({ snapshot, events, restoreId: "r-names", at });
    return { plan, after: plan.principals.reduce((state, entry) => (entry.change === null ? state : applyChange(state, entry.change)), snapshot) };
  };
  const nameOf = (snapshot: { profiles: readonly Profile[] }, profileId: string) => snapshot.profiles.find((p) => p.profile_id === profileId);

  test("a rename after the backup and a new account taking the freed name: both replayed, no duplicate; idempotent", async () => {
    const w = await journaled();
    const now = Date.now();
    const ann = principalOf(w.service, (await account(w.service, "ann", "Marlowe", now)) as { setCookie: string }, now);
    const atT = JSON.parse(JSON.stringify(w.store.snapshot()));
    assert.equal((await w.service.changeDisplayName(ann, "Quill", () => "none", now + 5)).kind, "ok");
    assert.equal((await account(w.service, "bob", "Marlowe", now + 6)).kind, "ok");
    const events = w.events();
    assert.ok(events.some((e) => e.kind === "display-name-changed"), "the change is journaled");
    const { after } = replayed(atT, events, now + 100);
    const annProfile = (w.service.peekProfileOf(ann) as Profile).profile_id;
    assert.equal(nameOf(after, annProfile)?.display_name, "Quill");
    assert.equal(nameOf(after, annProfile)?.name_changed_at, now + 5);
    assert.equal(after.profiles.filter((p) => displayNameKey(p.display_name) === "marlowe").length, 1, "one Marlowe: the new account");
    /* The restored identity serves the same rule: the used change stays used; the names stay held. */
    const restored = IdentityService.fromSnapshot(createMemoryIdentityStore(), after, { policy: POLICY });
    assert.equal(restored.displayNameTaken("quill"), true);
    assert.equal((await restored.changeDisplayName(ann, "Other", () => "none", now + 200)).kind, "already-changed");
    /* Idempotent: the replay of the replayed table plans no profile change. */
    const again = planSecurityReplay({ snapshot: after, events, restoreId: "r-names", at: now + 100 });
    assert.ok(again.principals.every((entry) => entry.change === null || entry.change.profiles === undefined));
  });

  test("without the change in the journal the replay would serve a duplicate -- it refuses (fail closed)", async () => {
    const w = await journaled();
    const now = Date.now();
    const ann = principalOf(w.service, (await account(w.service, "ann", "Marlowe", now)) as { setCookie: string }, now);
    const atT = JSON.parse(JSON.stringify(w.store.snapshot()));
    await w.service.changeDisplayName(ann, "Quill", () => "none", now + 5);
    await account(w.service, "bob", "Marlowe", now + 6);
    const withoutRenames = w.events().filter((e) => e.kind !== "display-name-changed" && !(e.kind === "confirmed" && e.confirmed_kind === "display-name-changed"));
    assert.throws(() => planSecurityReplay({ snapshot: atT, events: withoutRenames, restoreId: "r-names", at: now + 100 }), SecurityReplayError);
  });

  test("an unconfirmed change another account's later claim shows never committed is not applied", async () => {
    const w = await journaled();
    const now = Date.now();
    const ann = principalOf(w.service, (await account(w.service, "ann", "Marlowe", now)) as { setCookie: string }, now);
    const annProfile = w.service.peekProfileOf(ann) as Profile;
    const atT = JSON.parse(JSON.stringify(w.store.snapshot()));
    /* Ann's change to "Quill" was journaled but its write failed (no confirmation, the table never held it). */
    const phantom = { format: SECURITY_EVENT_FORMAT, version: SECURITY_EVENT_VERSION, event_id: "f".repeat(32), kind: "display-name-changed", at: now + 5, principal_id: ann, profile_id: annProfile.profile_id, from_name: "Marlowe", to_name: "Quill", changed_at: now + 5 } as unknown as SecurityEvent;
    assert.equal((await account(w.service, "bob", "Quill", now + 6)).kind, "ok", "the writer's index never held Quill for Ann");
    const { after } = replayed(atT, [...w.events(), phantom], now + 100);
    assert.equal(nameOf(after, annProfile.profile_id)?.display_name, "Marlowe");
    assert.equal(nameOf(after, annProfile.profile_id)?.name_changed_at, undefined, "Ann's one change is still hers to use");
    assert.equal(after.profiles.filter((p) => displayNameKey(p.display_name) === "quill").length, 1);
  });

  test("the event's shape: a well-formed change parses; a change to the same name, or a malformed name, does not", () => {
    const base = { format: SECURITY_EVENT_FORMAT, version: SECURITY_EVENT_VERSION, event_id: "a".repeat(32), kind: "display-name-changed", at: 1, principal_id: mintPrincipalIdForTest(), profile_id: mintProfileIdForTest(), from_name: "Ann", to_name: "Quill", changed_at: 1 };
    assert.notEqual(parseSecurityEventBody(JSON.stringify(base)), null);
    assert.equal(parseSecurityEventBody(JSON.stringify({ ...base, to_name: "Ann" })), null);
    assert.equal(parseSecurityEventBody(JSON.stringify({ ...base, to_name: "" })), null);
    assert.equal(parseSecurityEventBody(JSON.stringify({ ...base, extra: 1 })), null);
  });
});
