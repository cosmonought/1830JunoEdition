// server/src/persistence/conformance/ludumDisplayNames.dynamoLocal.test.ts
//
// LUDUM v1.1 (unique display names, the one change) against the PRODUCTION identity store on DynamoDB Local
// (`GS_DYNAMODB_LOCAL_ENDPOINT`; fails with instructions, never skips). Uniqueness is enforced by the single fenced
// identity writer against its full index (rebuilt from the table at every load); the one change is a `profile-name`
// compare-and-swap INSIDE the write, and a used change can never be written away. Here:
//   A. a held name refuses a second account; a restart (a fresh load) rebuilds the index and keeps the used change;
//   B. concurrent registrations and renames on the one writer: exactly one wins each name;
//   C. a stale writer at the same epoch (its view predates a rename) is refused by DynamoDB itself;
//   D. a writer whose role was taken over is fenced: its rename and its registration never land; the new writer, loaded
//      after the takeover, holds every name;
//   E. a record without `name_changed_at` can never overwrite one with it (the plan's guard, evaluated by DynamoDB).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { GetItemCommand, PutItemCommand, UpdateItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline } from "../../aws/awsClients";
import { createDynamoIdentityStore, type DynamoIdentityStore } from "../../aws/identity/dynamoIdentityStore";
import { keyAttributes, keys, ROLE_KEY } from "../../aws/identity/identityItems";
import { TEST_PASSWORD_KDF } from "../../escrow/escrow4Support";
import { readSessionCookie } from "../../identity/cookies";
import { IdentityService } from "../../identity/sessions";
import type { Profile } from "../../identity/store";
import { StoreDefiniteError } from "../storeResult";
import { createAccountWith, keplrAccount } from "../../testSupport/authorizationWallets";
import { requireLocal } from "./dynamoLocal";
import { dynamoSuite, IMMEDIATE, QUIET, roleItem } from "./identityDynamoSubjects";

const suite = dynamoSuite();
const POLICY = { passwordKdf: TEST_PASSWORD_KDF };
const PASSWORD = "correct horse battery";

interface World {
  readonly table: string;
  readonly client: DynamoDBClient;
  readonly fenced: string[];
  open(epoch: number): DynamoIdentityStore;
  service(epoch: number): Promise<IdentityService>;
  takeOver(epoch: number): Promise<void>;
}

async function world(): Promise<World> {
  const table = await suite.tables.create("identity");
  const client = createDynamoDbClient(suite.target);
  await requireLocal(client);
  await suite.admin.send(new PutItemCommand({ TableName: table, Item: roleItem(1) }), { abortSignal: deadline() });
  const fenced: string[] = [];
  const open = (epoch: number) =>
    createDynamoIdentityStore(client, table, { epoch, sleep: IMMEDIATE, scanSegments: 2, pageSize: 40, warn: QUIET, onFenced: (d) => fenced.push(d), onRestartRequired: () => undefined });
  return {
    table,
    client,
    fenced,
    open,
    async service(epoch) {
      const store = open(epoch);
      return IdentityService.fromSnapshot(store, await store.load(), { policy: POLICY });
    },
    async takeOver(epoch) {
      await suite.admin.send(
        new UpdateItemCommand({ TableName: table, Key: keyAttributes(ROLE_KEY), UpdateExpression: "SET #e = :e", ExpressionAttributeNames: { "#e": "epoch" }, ExpressionAttributeValues: { ":e": { N: String(epoch) } } }),
        { abortSignal: deadline() },
      );
    },
  };
}

let serial = 0;
async function account(service: IdentityService, displayName: string, now = Date.now()) {
  serial += 1;
  const username = `dn${process.pid}x${serial}`;
  const boot = await service.bootstrap({ kind: "none" }, false, now);
  assert.equal(boot.kind, "ok");
  const read = readSessionCookie(((boot as { setCookie: string }).setCookie as string).split(";")[0]);
  return createAccountWith(service, read, { username, password: PASSWORD, displayName, wallet: keplrAccount(`ddb-names/${username}`) }, now);
}
function principalOf(service: IdentityService, made: unknown, now = Date.now()): string {
  assert.equal((made as { kind: string }).kind, "ok", JSON.stringify(made));
  const auth = service.authenticate(readSessionCookie((made as { setCookie: string }).setCookie.split(";")[0]), now);
  assert.equal(auth.kind, "ok");
  return (auth as { principalId: string }).principalId;
}
async function storedProfile(w: World, profileId: string) {
  const got = await suite.admin.send(new GetItemCommand({ TableName: w.table, Key: keyAttributes(keys.profile(profileId)), ConsistentRead: true }), { abortSignal: deadline() });
  return got.Item;
}
const none = () => "none" as const;

describe("Ludum display names on DynamoDB Local", () => {
  test("A. a held name refuses a second account; a restart rebuilds the index and keeps the used change", async () => {
    const w = await world();
    const first = await w.service(1);
    const ann = principalOf(first, await account(first, "Marlowe"));
    assert.equal((await account(first, "marlowe")).kind, "display-name-taken");
    assert.deepEqual(await first.changeDisplayName(ann, "Quill", none, 1_790_000_000_000), { kind: "ok", name: "Quill" });
    const profileId = (first.peekProfileOf(ann) as Profile).profile_id;
    const item = await storedProfile(w, profileId);
    assert.equal(item?.display_name?.S, "Quill");
    assert.equal(item?.name_changed_at?.N, "1790000000000");
    /* A fresh load (a restart, or the next writer): the index is rebuilt from the table. */
    const second = await w.service(1);
    assert.equal(second.displayNameTaken("quill"), true);
    assert.equal(second.displayNameTaken("marlowe"), false, "the released name is free again");
    assert.equal((await second.changeDisplayName(ann, "Other", none, Date.now())).kind, "already-changed");
    assert.equal((await account(second, "Quill")).kind, "display-name-taken");
    assert.equal((await account(second, "Marlowe")).kind, "ok");
  });

  test("B. concurrent registrations and renames on the one writer: exactly one wins each name", async () => {
    const w = await world();
    const s = await w.service(1);
    const creates = await Promise.all([account(s, "Tilde"), account(s, "tilde"), account(s, "TILDE")]);
    assert.deepEqual(creates.map((c) => c.kind).sort(), ["display-name-taken", "display-name-taken", "ok"]);
    const a = principalOf(s, await account(s, "Ash"));
    const b = principalOf(s, await account(s, "Birch"));
    const renames = await Promise.all([s.changeDisplayName(a, "Cedar", none, Date.now()), s.changeDisplayName(b, "cedar", none, Date.now())]);
    assert.deepEqual(renames.map((r) => r.kind).sort(), ["ok", "taken"]);
    const twice = await Promise.all([s.changeDisplayName(b, "Elm", none, Date.now()), s.changeDisplayName(b, "Fir", none, Date.now())]);
    assert.deepEqual(twice.map((r) => r.kind).sort(), ["already-changed", "ok"], "the one change, once");
    /* What the table holds agrees with the writer: a fresh load sees each name once. */
    const fresh = await w.service(1);
    for (const name of ["tilde", "cedar"]) assert.equal(fresh.displayNameTaken(name), true, name);
  });

  test("C. a stale writer at the same epoch (its view predates a rename) is refused by DynamoDB, nothing written", async () => {
    const w = await world();
    const live = await w.service(1);
    const ann = principalOf(live, await account(live, "Pike"));
    const stale = await w.service(1); // loaded now: sees Pike unchanged
    assert.equal((await live.changeDisplayName(ann, "Rook", none, Date.now())).kind, "ok");
    assert.equal((await stale.changeDisplayName(ann, "Knight", none, Date.now())).kind, "unavailable", "the profile-name condition fails in DynamoDB");
    const item = await storedProfile(w, (live.peekProfileOf(ann) as Profile).profile_id);
    assert.equal(item?.display_name?.S, "Rook");
  });

  test("D. a writer whose role was taken over is fenced: its rename and registration never land; the new writer holds every name", async () => {
    const w = await world();
    const old = await w.service(1);
    const ann = principalOf(old, await account(old, "Wren"));
    await w.takeOver(2);
    const next = await w.service(2);
    assert.equal((await old.changeDisplayName(ann, "Lark", none, Date.now())).kind, "unavailable");
    const made = await account(old, "Lark");
    assert.notEqual(made.kind, "ok", "a fenced writer registers nobody");
    assert.ok(w.fenced.length > 0, "the stale writer learned it is fenced");
    assert.equal(next.displayNameTaken("wren"), true);
    assert.equal(next.displayNameTaken("lark"), false, "nothing of the fenced writer landed");
    assert.equal((await next.changeDisplayName(ann, "Lark", none, Date.now())).kind, "ok");
  });

  test("E. a record without name_changed_at can never overwrite one with it (evaluated by DynamoDB)", async () => {
    const w = await world();
    const s = await w.service(1);
    const ann = principalOf(s, await account(s, "Moss"));
    const before = { ...(s.peekProfileOf(ann) as Profile) };
    assert.equal((await s.changeDisplayName(ann, "Fern", none, Date.now())).kind, "ok");
    const store = w.open(1);
    await store.load();
    await assert.rejects(store.commit({ profiles: [{ ...before, display_name: "Moss" }] }), StoreDefiniteError);
    const item = await storedProfile(w, before.profile_id);
    assert.equal(item?.display_name?.S, "Fern");
    assert.ok(item?.name_changed_at !== undefined);
  });
});
