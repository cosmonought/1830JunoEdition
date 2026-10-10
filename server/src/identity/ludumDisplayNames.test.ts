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
import { createMemoryIdentityStore, isProfile, type Profile } from "./store";

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
