// server/src/aws/identity/dynamoSecurityJournal.ts
//
// ==================================================================
//  LIVE-5 L5-4: THE SECURITY-EVENT JOURNAL ON DYNAMODB -- `SEC#` ITEMS OF THE LEDGER TABLE (preflight §3.4, §7.6)
// ==================================================================
//
// Append-only. One item per event, keyed by the event itself:
//
//   pk  SEC#<principal_id>      sk  <at, 13 digits>#<event_id>
//   attributes  fmt (1), kind, at, event_id, body -- `body` is the event's canonical JSON text, stored and compared
//               byte for byte (`securityEventBody`); `kind`, `at` and `event_id` are copies for an operator's queries,
//               checked against the body at every read.
//
// Every append is ONE TransactWriteItems with a fresh ClientRequestToken:
//   [GEN]  ConditionCheck APPGEN `current_generation = :g` -- the ledger's rule for every write (preflight D-9, §17): a
//          task still pointed at a superseded app generation records nothing. The generation is an explicit constructor
//          argument; `null` states that no generation fence exists yet (before L6-4 adopts one), and is never a default.
//   Put    the event item, `attribute_not_exists(pk)`: first writer wins; nothing is ever overwritten.
// Outcomes: committed; DEFINITE when nothing was written (the generation fence, a malformed event, a DIFFERENT event
// already under the key, or a service rejection); UNKNOWN (a timeout, a 5xx) is resent identically and settled by a
// strong read of the event's own item: our exact body there -> committed; the resend evaluated and refused with the item
// absent -> definite; still unknown -> StoreUncertainError. The event item is its own commit marker: its key is random
// (the event id), so an item there with our exact body can only be ours.
//
// The ledger table is L5-5's (its own account, PITR, never rolled back with the app, deletes denied by IAM). This file
// needs of it only this item class and the `APPGEN` item's key; it adds no client of its own (awsClients.ts).

import { GetItemCommand, QueryCommand, type AttributeValue, type DynamoDBClient, type TransactWriteItem, type TransactWriteItemsCommandInput } from "@aws-sdk/client-dynamodb";
import { randomUUID } from "crypto";

import { deadline } from "../awsClients";
import { PRINCIPAL_ID_PATTERN } from "../../identity/ids";
import {
  isSecurityEvent,
  parseSecurityEventBody,
  SecurityJournalCorruptError,
  securityEventBody,
  securityEventSortKey,
  type SecurityEvent,
  type SecurityEventJournal,
} from "../../identity/securityEvents";
import { StoreDefiniteError, StoreUncertainError } from "../../persistence/storeResult";
import { IDENTITY_ITEM_FORMAT, N, S, type Item } from "./identityItems";
import { sendTransaction } from "./dynamoIdentityStore";

export const APPGEN_KEY = Object.freeze({ pk: { S: "APPGEN" }, sk: { S: "APPGEN" } });
export const securityEventKey = (event: Pick<SecurityEvent, "principal_id" | "at" | "event_id">) => ({ pk: { S: `SEC#${event.principal_id}` }, sk: { S: securityEventSortKey(event) } });

export interface DynamoSecurityJournalOptions {
  /** The app generation this task writes under (`APPGEN current_generation`), or `null`: no generation fence. */
  readonly generation: number | null;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxResends?: number;
  readonly pageSize?: number;
  /** The generation moved on: this task points at a superseded app generation. */
  readonly onFenced?: (detail: string) => void;
}

const CCF = "ConditionalCheckFailed";
const RESEND_WAITS = [50, 200, 800];
const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function generationFence(table: string, generation: number): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: table,
      Key: { ...APPGEN_KEY },
      ConditionExpression: "#g = :g",
      ExpressionAttributeNames: { "#g": "current_generation" },
      ExpressionAttributeValues: { ":g": { N: String(generation) } },
    },
  };
}

export function eventItem(event: SecurityEvent): Item {
  return { ...securityEventKey(event), fmt: N(IDENTITY_ITEM_FORMAT), kind: S(event.kind), at: N(event.at), event_id: S(event.event_id), body: S(securityEventBody(event)) };
}

/** The event an item holds, when it is exactly a well-formed event item; `null` otherwise. */
export function decodeEventItem(item: Record<string, AttributeValue>): SecurityEvent | null {
  const names = Object.keys(item)
    .filter((name) => item[name] !== undefined)
    .sort()
    .join(",");
  if (names !== "at,body,event_id,fmt,kind,pk,sk") return null;
  const body = item.body?.S;
  if (typeof body !== "string" || item.fmt?.N !== String(IDENTITY_ITEM_FORMAT)) return null;
  const event = parseSecurityEventBody(body);
  if (event === null) return null;
  const key = securityEventKey(event);
  const ok = item.pk?.S === key.pk.S && item.sk?.S === key.sk.S && item.kind?.S === event.kind && item.at?.N === String(event.at) && item.event_id?.S === event.event_id;
  return ok ? event : null;
}

export function createDynamoSecurityJournal(client: DynamoDBClient, table: string, options: DynamoSecurityJournalOptions): SecurityEventJournal {
  if (options.generation !== null && (!Number.isSafeInteger(options.generation) || options.generation < 1)) throw new Error("dynamo security journal: the generation must be a positive integer, or null");
  const sleep = options.sleep ?? sleepReal;
  const maxResends = options.maxResends ?? 3;
  const pageSize = options.pageSize ?? 200;
  let fenced: string | null = null;

  /** The body stored under the event's key (`null`: none), or `undefined` when the read failed. */
  const storedBody = async (event: SecurityEvent): Promise<string | null | undefined> => {
    try {
      const answer = await client.send(new GetItemCommand({ TableName: table, Key: securityEventKey(event), ConsistentRead: true }), { abortSignal: deadline() });
      return answer.Item?.body?.S ?? null;
    } catch {
      return undefined;
    }
  };

  return {
    async append(event) {
      if (!isSecurityEvent(event)) throw new StoreDefiniteError("not a security event; nothing was written");
      if (fenced !== null) throw new StoreDefiniteError(`this task's app generation was superseded (${fenced}); nothing was written`);
      const body = securityEventBody(event);
      const fence = options.generation === null ? [] : [generationFence(table, options.generation)];
      const input: TransactWriteItemsCommandInput = {
        ClientRequestToken: randomUUID(),
        TransactItems: [...fence, { Put: { TableName: table, Item: eventItem(event), ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" } } }],
      };
      const putAt = fence.length;
      const refusedFenced = () => {
        const detail = `the app generation is no longer ${options.generation}`;
        if (fenced === null) {
          fenced = detail;
          options.onFenced?.(detail);
        }
        return new StoreDefiniteError(`this task's app generation was superseded (${detail}); nothing was written`);
      };
      const occupied = async (): Promise<void> => {
        const stored = await storedBody(event);
        if (stored === body) return; // this exact event is already recorded: an idempotent resend
        throw new StoreDefiniteError("another event is already recorded under this event's key (the first one stands); nothing was written");
      };

      const first = await sendTransaction(client, input);
      if (first.kind === "ok") return;
      if (first.kind === "refused") throw new StoreDefiniteError(`${first.detail}; nothing was written`);
      if (first.kind === "canceled") {
        if (first.codes[putAt] === CCF) return occupied();
        if (fence.length > 0 && first.codes[0] === CCF) throw refusedFenced();
        throw new StoreDefiniteError(`${first.detail}; nothing was written`);
      }
      let last = first.detail;
      for (let resend = 0; resend < maxResends; resend += 1) {
        await sleep(RESEND_WAITS[Math.min(resend, RESEND_WAITS.length - 1)]);
        const again = await sendTransaction(client, input);
        if (again.kind === "ok") return;
        last = again.detail;
        if (again.kind === "in-progress" || again.kind === "unknown") continue;
        const stored = await storedBody(event);
        if (stored === body) return; // ours landed
        if (again.kind === "canceled" && stored !== undefined) {
          if (again.codes[putAt] === CCF) throw new StoreDefiniteError("another event is already recorded under this event's key (the first one stands); nothing was written");
          if (fence.length > 0 && again.codes[0] === CCF) throw refusedFenced();
        }
      }
      if ((await storedBody(event)) === body) return;
      throw new StoreUncertainError(`the outcome of a security-event append is unknown (${last})`);
    },

    async eventsOf(principalId) {
      if (typeof principalId !== "string" || !PRINCIPAL_ID_PATTERN.test(principalId)) return [];
      const out: SecurityEvent[] = [];
      let start: Record<string, AttributeValue> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: table,
            ConsistentRead: true,
            KeyConditionExpression: "#pk = :pk",
            ExpressionAttributeNames: { "#pk": "pk" },
            ExpressionAttributeValues: { ":pk": { S: `SEC#${principalId}` } },
            Limit: pageSize,
            ExclusiveStartKey: start,
          }),
          { abortSignal: deadline() },
        );
        for (const item of page.Items ?? []) {
          const event = decodeEventItem(item);
          if (event === null) throw new SecurityJournalCorruptError(`security journal ${table}: a stored event is not a well-formed event item`);
          out.push(event);
        }
        start = page.LastEvaluatedKey;
      } while (start !== undefined);
      return out;
    },
  };
}
