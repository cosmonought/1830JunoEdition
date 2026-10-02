// server/src/aws/operator/jx3bWalletGrants.test.ts
//
// ==================================================================
//  JX-3B (C-4a): `gamesDoctor aws wallet-grants` -- THE REDACTED WALLET-GRANT VIEW OVER DYNAMODB, READS ONLY
// ==================================================================
//
// The game table's `GAME#<g>/TICKETS` item and the identity table's principal / profile / family items are served by a
// fake DynamoDB client from the state of a real money world (the JX-3 re-home scenario, `escrow/jx3bSupport.ts`),
// encoded by the production item encoders. Pinned: the view agrees with the server's own standing; only GetItem is
// ever sent (no scan, no write); an identity table it cannot read leaves standing "not evaluated", never a guess; a
// ledger item whose version attribute disagrees is refused; nothing private is printed.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { quietConsole } from "../../rooms/testSupport";
import { assertRedacted, evidenceWorld } from "../../escrow/jx3bSupport";
import { WALLET_TICKET_FILE_FORMAT } from "../../escrow/walletTicketFileStore";
import { gamePk, key, N, S, TICKETS_SK, type Item } from "../game/gameTable";
import { familyItem, principalItem, profileItem } from "../identity/identityItems";
import { runAwsOperator } from "./operatorMain";
import type { WalletGrantsView } from "../../tools/walletGrants";

quietConsole();

const ARN = "arn:aws:ssm:us-east-1:123456789012:parameter/gs/prod/runtime";
const DOC = { format: "18COSMOS/AWS-RUNTIME/v1", environment: "prod", region: "us-east-1", pool: "p1", generation: 1, game_table: "gs-prod-game-g1", identity_table: "gs-prod-identity", ledger_table_arn: "arn:aws:dynamodb:us-east-1:210987654321:table/gs-prod-ledger", escrow: null };

/** A DynamoDB client answering GetItem from two tables' items; anything else is recorded and refused. */
function fakeTables(tables: Record<string, Item[]>, options: { readonly identityDenied?: boolean } = {}) {
  const sent: string[] = [];
  const byKey = new Map<string, Item>();
  for (const [table, items] of Object.entries(tables)) for (const item of items) byKey.set(`${table}|${(item.pk as { S: string }).S}|${(item.sk as { S: string }).S}`, item);
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name;
      const table = command.input.TableName as string;
      sent.push(`${name} ${table}`);
      if (name !== "GetItemCommand") throw new Error(`a read-only view sent ${name}`);
      if (options.identityDenied && table === DOC.identity_table) throw Object.assign(new Error("User is not authorized to perform: dynamodb:GetItem"), { name: "AccessDeniedException" });
      const wanted = command.input.Key as Record<string, { S: string }>;
      const item = byKey.get(`${table}|${wanted.pk.S}|${wanted.sk.S}`);
      return item === undefined ? {} : { Item: item };
    },
    destroy() {
      /* nothing */
    },
  };
  return { client: client as unknown as DynamoDBClient, sent };
}

async function run(client: DynamoDBClient, gameId: string, now: number, extra: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAwsOperator(["wallet-grants", gameId, "--aws-config", ARN, ...extra], {}, { out: (line) => out.push(line), err: (line) => err.push(line) }, {
    parameters: { read: async (arn: string) => ({ value: JSON.stringify(DOC), version: 1, arn }) },
    clientFor: () => client,
    now: () => now,
  });
  return { code, out, err };
}

describe("JX-3B C-4a: gamesDoctor aws wallet-grants", () => {
  test("the view over DynamoDB: standing as the server judges it, from just the identity items the contexts name -- GetItem only, nothing private printed", async () => {
    const e = await evidenceWorld();
    try {
      const { version, document } = await e.world.ticketStore.load(e.table.gameId);
      const ticketItem: Item = { ...key(gamePk(e.table.gameId), TICKETS_SK), body: S(JSON.stringify({ format: WALLET_TICKET_FILE_FORMAT, version, game_id: e.table.gameId, document })), version: N(version) };
      const snapshot = e.world.identityStore.snapshot();
      const identityItems = [...snapshot.principals.map(principalItem), ...snapshot.profiles.map(profileItem), ...snapshot.families.map(familyItem)];
      /* The record item, as the L5-2 record store stores it (its `load` is the reader). */
      const record = e.world.server.rooms.moneyPort.recordOf(e.table.gameId)!;
      const recordItem: Item = { ...key(gamePk(e.table.gameId), "META"), body: S(JSON.stringify(record)), record_version: N(record.record_version) };
      const tables = fakeTables({ [DOC.game_table]: [ticketItem, recordItem], [DOC.identity_table]: identityItems });
      const answered = await run(tables.client, e.table.gameId, e.world.clock.now, ["--json"]);
      const view = JSON.parse(answered.out.join("\n")) as WalletGrantsView;
      assert.equal(view.source, "aws");
      assert.equal(view.identity.read, true, view.identity.detail);
      const live = (await e.world.ledger.snapshot(e.table.gameId)).grants;
      assert.equal(view.record.read, true, view.record.detail);
      assert.equal(answered.code, 0, answered.err.join("\n"));
      assert.deepEqual(view.grants.map((grant) => [grant.player_id, grant.epoch, grant.standing]).sort(), live.map((grant) => [grant.player_id, grant.epoch, grant.standing]).sort(), "the view's standing is the server's");
      const seat = view.grants.filter((grant) => grant.player_id === e.playerId);
      assert.deepEqual(seat.map((grant) => grant.context.verdict), ["ended:family", "current"], "the laptop signed out; the re-homed phone grant stands");
      assert.equal(seat[0].ticket, seat[1].ticket, "the re-home re-adopted the same ticket");
      assert.notEqual(seat[0].context.family, seat[1].context.family);
      assert.ok(tables.sent.every((line) => line.startsWith("GetItemCommand ")), `reads only, no scan: ${tables.sent.join(", ")}`);
      const identityReads = tables.sent.filter((line) => line.endsWith(DOC.identity_table)).length;
      assert.ok(identityReads <= 2 * 2 + 3, `only the contexts' principal, profile and family items (${identityReads} reads)`);
      assertRedacted(answered.out.join("\n"), [e.families.laptop, e.families.phone, document.grants[0].ticket, e.joiner.browser.recoveryKey]);
      /* The text form. */
      const text = await run(tables.client, e.table.gameId, e.world.clock.now);
      assert.match(text.out.join("\n"), /wallet grants \(READ-ONLY, aws\)/);
      assertRedacted(text.out.join("\n"), [e.families.laptop, e.families.phone, document.grants[0].ticket]);
    } finally {
      await e.world.close();
    }
  });

  test("an identity table it cannot read: the grants are shown, standing not evaluated (exit 1); a damaged ledger item is refused; --apply means nothing", async () => {
    const e = await evidenceWorld();
    try {
      const { version, document } = await e.world.ticketStore.load(e.table.gameId);
      const body = S(JSON.stringify({ format: WALLET_TICKET_FILE_FORMAT, version, game_id: e.table.gameId, document }));
      const denied = fakeTables({ [DOC.game_table]: [{ ...key(gamePk(e.table.gameId), TICKETS_SK), body, version: N(version) }] }, { identityDenied: true });
      const answered = await run(denied.client, e.table.gameId, e.world.clock.now, ["--json"]);
      assert.equal(answered.code, 1);
      const view = JSON.parse(answered.out.join("\n")) as WalletGrantsView;
      assert.equal(view.identity.read, false);
      assert.match(view.identity.detail, /unreadable: User is not authorized/);
      assert.equal(view.grants.filter((grant) => grant.player_id === e.playerId).length, 2);
      assert.ok(view.grants.every((grant) => grant.standing === null && grant.context.verdict === "not-evaluated"), "never a guess");
      /* The item's version attribute disagrees with its document: damage, refused. */
      const damaged = fakeTables({ [DOC.game_table]: [{ ...key(gamePk(e.table.gameId), TICKETS_SK), body, version: N(version + 1) }] });
      const refused = await run(damaged.client, e.table.gameId, e.world.clock.now);
      assert.equal(refused.code, 1, "a read failure is a finding (nothing was changed)");
      assert.match(refused.err.join("\n"), /disagrees with its item's version attribute/);
      assert.equal((await run(denied.client, e.table.gameId, e.world.clock.now, ["--apply"])).code, 2, "a read takes no --apply");
    } finally {
      await e.world.close();
    }
  });
});
