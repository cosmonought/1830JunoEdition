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
//
// LIVE-6 L6-2 (L6-4's handoff): THE TABLE MUST BE SERVABLE, ASKED AT EVERY QUESTION. Before a session is looked at, the
// table's own restore state is read with L6-4's canonical check -- `identityServingProblem` (the `TABLE#identity` name and
// the `RESTORE#identity` marker, strongly, through `restoreLoadProblem`) -- the SAME rule the writer's load and every
// serving takeover apply. A fresh point-in-time copy (it names its source), a table mid-replay (`replaying`), a restore's
// superseded source, or one carrying another table's marker answers `unavailable` on a non-primary router exactly as the
// primary refuses to load it; a damaged marker or a failed read is `unavailable` too. Two more strong GetItems per question
// (`TABLE#identity`, `RESTORE#identity`), still no write, no cache and no role item: a supersession that lands while the
// router runs is seen at the next question.

import { GetItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { FAMILY_ID_PATTERN, PRINCIPAL_ID_PATTERN, PROFILE_ID_PATTERN, SESSION_ID_PATTERN } from "../../identity/ids";
import type { Principal, Profile, Session, SessionFamily } from "../../identity/store";
import { createSessionVerifier, IdentityRecordUnreadableError, type IdentityRecordReader, type SessionVerifier } from "../../identity/verifier";
import { identityServingProblem } from "./dynamoIdentityStore";
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
  return servingGatedVerifier(createSessionVerifier(dynamoIdentityRecordReader(client, table)), () => identityServingProblem(client, table));
}

/** L6-2 (L6-4's handoff): every question first asks whether the table may serve at all (see the header); anything but a
 *  clean `null` -- a restore state, damage, a failed read -- is `unavailable`, and the records are then not read. */
export function servingGatedVerifier(inner: SessionVerifier, servingProblem: () => Promise<string | null>): SessionVerifier {
  const gate = async (): Promise<{ readonly kind: "unavailable"; readonly detail: string } | null> => {
    try {
      const problem = await servingProblem();
      return problem === null ? null : { kind: "unavailable", detail: `the identity table may not serve: ${problem}` };
    } catch (error) {
      return { kind: "unavailable", detail: `the identity table's serving state could not be read (${(error as { name?: string } | null)?.name ?? "error"})` };
    }
  };
  return {
    async authenticate(read, now) {
      return (await gate()) ?? inner.authenticate(read, now);
    },
    async recheck(ctx, now) {
      return (await gate()) ?? inner.recheck(ctx, now);
    },
  };
}
