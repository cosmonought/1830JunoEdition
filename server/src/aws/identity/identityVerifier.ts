// server/src/aws/identity/identityVerifier.ts
//
// ==================================================================
//  LIVE-6 L6-1: THE IDENTITY VERIFIER'S READER ON THE L5-4 IDENTITY TABLE -- STRONG GETITEMS, STRICT DECODING, NOTHING ELSE
// ==================================================================
//
// `identity/verifier.ts` decides; this file only READS, for a task that does not hold the identity-writer role (a
// non-primary pool's task, preflight §7.2). It uses L5-4's own item layout and codec (`identityItems.ts`: the keys, the
// exact attribute set, `decodeItem`) -- there is no second identity model -- and it sends exactly one kind of request:
//
//     GetItem { TableName, Key: { pk, sk }, ConsistentRead: true }
//
// Never a write, a transaction, a scan, a query, a conditional check or a read of the role item: nothing here can take,
// hold, move or impersonate the identity-writer role, and nothing here can change a byte of the table (the DynamoDB Local
// suite checks the table is identical after it, and that no other command was sent).
//
// FAIL CLOSED: an item whose key names another class, whose attributes are not exactly its class's, whose values are not
// canonical, or whose record fails the record's own shape check, is `IdentityRecordUnreadableError` (the class only,
// never its content); a read that fails (timeout, throttle, access) rethrows. The verifier turns both into
// `unavailable`. Absent means absent (`null`): the verifier decides what an absence means.

import { GetItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { FAMILY_ID_PATTERN, PRINCIPAL_ID_PATTERN, PROFILE_ID_PATTERN, SESSION_ID_PATTERN } from "../../identity/ids";
import type { Principal, Profile, Session, SessionFamily } from "../../identity/store";
import { createSessionVerifier, IdentityRecordUnreadableError, type IdentityRecordReader, type SessionVerifier } from "../../identity/verifier";
import { decodeItem, keyAttributes, keys, type Item, type ItemKey } from "./identityItems";

type RecordClass = "session" | "principal" | "family" | "profile";

/** The identity table's records, read one at a time, strongly -- and nothing else (see the header). */
export function dynamoIdentityRecordReader(client: DynamoDBClient, table: string): IdentityRecordReader {
  async function read<T>(cls: RecordClass, key: ItemKey): Promise<T | null> {
    const answer = await client.send(new GetItemCommand({ TableName: table, Key: keyAttributes(key), ConsistentRead: true }), { abortSignal: deadline() });
    if (answer.Item === undefined) return null;
    const decoded = decodeItem(answer.Item as Item);
    if ("problem" in decoded) throw new IdentityRecordUnreadableError(`identity table: ${decoded.problem}`);
    if (decoded.kind !== cls) throw new IdentityRecordUnreadableError(`identity table: a ${cls} key holds a ${decoded.kind} item`);
    return decoded.record as T;
  }
  /* An id that is not an id of its class is never sent as a key (it could only name another item). */
  const guarded =
    <T>(cls: RecordClass, pattern: RegExp, keyOf: (id: string) => ItemKey) =>
    (id: string): Promise<T | null> =>
      pattern.test(id) ? read<T>(cls, keyOf(id)) : Promise.reject(new IdentityRecordUnreadableError(`identity table: not a ${cls} id`));
  return {
    session: guarded<Session>("session", SESSION_ID_PATTERN, keys.session),
    principal: guarded<Principal>("principal", PRINCIPAL_ID_PATTERN, keys.principal),
    family: guarded<SessionFamily>("family", FAMILY_ID_PATTERN, keys.family),
    profile: guarded<Profile>("profile", PROFILE_ID_PATTERN, keys.profile),
  };
}

/** The non-writer identity path for a non-primary task: the verifier over the identity table (read-only). */
export function createDynamoIdentityVerifier(client: DynamoDBClient, table: string): SessionVerifier {
  return createSessionVerifier(dynamoIdentityRecordReader(client, table));
}
