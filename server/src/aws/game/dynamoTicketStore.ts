// server/src/aws/game/dynamoTicketStore.ts
//
// ==================================================================
//  LIVE-5 L5-2: THE WALLET-TICKET LEDGER ON DYNAMODB -- ONE ITEM PER GAME, CAS ON ITS VERSION, AND AN EXPLICIT `uncertain`
// ==================================================================
//
//   TICKETS          `body` is the file store's envelope exactly ({format, version, game_id, document}), so one reader
//                    (`parseWalletTicketFile`) classifies both: current, older-unread (financial protocol 2) or corrupt.
//                    `version` beside it; `att`/`atts` the attempt tokens.
//   LIST#tickets/<g> the port's listing (the security-event hook walks it).
//
// PUT: [FENCE(g); Put TICKETS COND (expected 0: attribute_not_exists; else version = expected AND att = the token of the
// document it read); the first document also puts its listing]. The port's answers (`WalletTicketStore.put`):
//   committed   written once (after a lost answer, settled by the strong read finding this write's token);
//   conflict    DEFINITELY not written: the version moved, this writer was fenced, or DynamoDB refused it unapplied;
//   uncertain   (F-L5-6, closed here) the answer was lost and could not be settled: the old or the new document.
// An unreadable stored ledger throws on every read and every write (it fails closed, and is never overwritten); a
// document that breaks the ledger's invariants is never written.

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";

import type { FormatFact } from "../../../../frontend/src/gameEngine/compat/continuationVerdict";
import { GAME_ID_PATTERN } from "../../rooms/gameRecord";
import { isWalletTicketDocument, parseWalletTicketFile, WALLET_TICKET_FILE_FORMAT, WalletTicketStoreUnreadableError } from "../../escrow/walletTicketFileStore";
import type { TicketPutOutcome, WalletTicketDocument, WalletTicketStore } from "../../escrow/walletTickets";
import { carriesAttempt, gameFence, gamePk, getItem, key, listKey, listPk, N, observedCondition, queryAll, S, stampAttempt, TICKETS_SK, type Item } from "./gameTable";
import { needsSettling, resolveOptions, type GameTableStoreOptions } from "./storeSupport";
import { transactWrite } from "./transact";

export interface DynamoTicketStore extends WalletTicketStore {
  listGames(): Promise<string[]>;
  formatOf(gameId: string): Promise<FormatFact>;
}

const ticketsKey = (gameId: string): Item => key(gamePk(gameId), TICKETS_SK);
const EMPTY = (): { version: number; document: WalletTicketDocument } => ({ version: 0, document: { frozen_at: null, grants: [] } });

export function createDynamoTicketStore(options: GameTableStoreOptions): DynamoTicketStore {
  const { client, table, fence, timing, pageSize } = resolveOptions(options, "createDynamoTicketStore");

  async function read(gameId: string): Promise<{ readonly item: Item | null; readonly version: number; readonly document: WalletTicketDocument }> {
    if (!GAME_ID_PATTERN.test(gameId)) throw new WalletTicketStoreUnreadableError(`${gameId} is not a game id`, gameId);
    const item = await getItem(client, table, ticketsKey(gameId));
    if (item === null) return { item, ...EMPTY() };
    if (typeof item.body?.S !== "string") throw new WalletTicketStoreUnreadableError(`the ticket ledger of ${gameId} holds no document`, gameId);
    const parsed = parseWalletTicketFile(item.body.S, gameId);
    /* The version every condition compares is the item's attribute: it must be the ledger's own, or the item is damage. */
    if (item.version?.N !== String(parsed.version)) throw new WalletTicketStoreUnreadableError(`the ticket ledger of ${gameId} disagrees with its item's version attribute`, gameId);
    return { item, ...parsed };
  }

  return {
    async load(gameId) {
      const { version, document } = await read(gameId);
      return { version, document };
    },

    async put(gameId, document, expected): Promise<TicketPutOutcome> {
      const current = await read(gameId); // an unreadable document throws: it is never overwritten
      if (current.version !== expected) return "conflict";
      if (!isWalletTicketDocument(document, gameId)) throw new WalletTicketStoreUnreadableError(`refusing to write a ledger for ${gameId} that breaks its invariants`, gameId);
      const token = timing.token();
      const body = JSON.stringify({ format: WALLET_TICKET_FILE_FORMAT, version: expected + 1, game_id: gameId, document });
      const held = current.item === null ? null : observedCondition(current.item);
      const condition =
        held === null
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : {
              ConditionExpression: `#v = :expected AND ${held.expression}`,
              ExpressionAttributeNames: { "#v": "version", ...held.names },
              ExpressionAttributeValues: { ":expected": N(expected), ...held.values },
            };
      const items: TransactWriteItem[] = [
        gameFence(table, gameId, fence),
        { Put: { TableName: table, Item: { ...ticketsKey(gameId), body: S(body), version: N(expected + 1), ...stampAttempt(token, current.item) }, ...condition } },
      ];
      if (expected === 0) items.push({ Put: { TableName: table, Item: { ...listKey("tickets", gameId), game_id: S(gameId) } } });
      const answer = await transactWrite(client, items, { ...timing, token: () => token });
      if (answer.kind === "applied") return "committed";
      if (!needsSettling(answer)) return "conflict"; // refused by a condition (the fence, or the version) or unapplied
      let item: Item | null;
      try {
        item = await getItem(client, table, ticketsKey(gameId));
      } catch {
        return "uncertain";
      }
      if (carriesAttempt(item, token)) return "committed";
      return answer.kind === "refused" ? "conflict" : "uncertain";
    },

    async listGames() {
      return (await queryAll(client, table, listPk("tickets"), { pageSize })).map((item) => item.sk?.S ?? "").filter((id) => GAME_ID_PATTERN.test(id)).sort();
    },

    async formatOf(gameId) {
      try {
        await read(gameId);
        return "current";
      } catch (error) {
        if (error instanceof WalletTicketStoreUnreadableError) return error.format;
        throw error;
      }
    },
  };
}
