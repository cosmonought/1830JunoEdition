// server/src/ludum/wiring.test.ts
//
// LUDUM v1 (Lane A): the real `LudumPorts` (`wiring.ts`) over a real money world (`moneyServer`, `fakeJunoChain`): the
// record index, the financial record found by its chain game id, the chain read and its provenance, the pin, the product.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { hostCreates, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet } from "../escrow/escrow4Support";
import { quietConsole } from "../rooms/testSupport";
import { createLudumPorts, LudumIndexIncomplete, productKeyOf } from "./wiring";

quietConsole();

describe("LUDUM wiring: the production ports", () => {
  test("records, seatOf, financial / by chain game id, terminal evidence, chain game, pin and product", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const wallet = testWallet("host");
      const key = testConsentKey("host");
      const linked = await linkWallet(host, table.gameId, wallet, key);
      assert.equal(linked.status, 200, linked.text);
      const chainGameId = await hostCreates(world, host, table.gameId, wallet, key, linked.body?.ticket as string);
      await world.observe();

      const ports = createLudumPorts({ records: () => world.server.rooms.records(), money: () => world.money, now: () => world.clock.now });
      const record = [...ports.records()].find((candidate) => candidate.game_id === table.gameId);
      assert.ok(record, "the record index holds the table");
      const principal = world.identity.securityContextOf({ kind: "session", sessionId: host.browser.cookie.split("=")[1].split(".")[1], secret: host.browser.cookie.split(".")[2] }, world.clock.now)?.principalId;
      assert.ok(principal);
      assert.equal(ports.seatOf(record, principal)?.player_id, table.playerId);
      assert.equal(ports.seatOf(record, "pr_somebody_else"), null);

      const financial = await ports.financial(table.gameId);
      assert.equal(financial?.binding?.escrow?.chain_game_id, chainGameId);
      assert.equal((await ports.financialByChainGameId(chainGameId))?.game_id, table.gameId);
      assert.equal((await ports.financialByChainGameId(chainGameId))?.game_id, table.gameId, "again, from the remembered binding");
      assert.equal(await ports.financialByChainGameId("999"), null);
      assert.equal(await ports.financialByChainGameId("0"), null, "not a chain game id");
      assert.equal(await ports.financialByChainGameId("1 OR 1"), null);
      assert.equal(await ports.terminalEvidence(table.gameId), null, "no terminal evidence before the game ends");

      const chain = await ports.chainGame(chainGameId);
      assert.ok(chain);
      assert.equal(String((chain.game as { game: { chain_game_id: unknown } }).game.chain_game_id), chainGameId);
      /* Integration: the RAW contract answer (lowercase state, the fields the parser drops), never the parser's output. */
      const rawGame = (chain.game as { game: { state: unknown; seats: Array<Record<string, unknown>> } }).game;
      assert.equal(typeof rawGame.state, "string");
      assert.equal(rawGame.state, (rawGame.state as string).toLowerCase(), "a raw contract state");
      for (const seat of rawGame.seats) assert.ok("subsidy_paid" in seat, "the raw seat keeps subsidy_paid");
      assert.equal(chain.provenance, "chain-observed", "one endpoint: an observation, never labelled a quorum");
      assert.equal(chain.observedAt, new Date(world.clock.now).toISOString());
      assert.equal(await ports.chainGame("4242"), null, "past next_chain_game_id: the chain has no such game");
      assert.equal(await ports.chainGame("abc"), null);

      assert.deepEqual(ports.escrowPin(), { contract: world.money.ludumChain.pin().contract, chainId: world.money.ludumChain.pin().chainId, denom: "ujunox" });
      assert.deepEqual(ports.product(), { key: "project-18xx", name: "Project 18XX" });
      assert.equal(ports.now(), world.clock.now);
    } finally {
      await world.close();
    }
  });

  test("without a money layer every money port answers null (never throws)", async () => {
    const ports = createLudumPorts({ records: () => [], money: () => null, now: () => 5 });
    assert.deepEqual([...ports.records()], []);
    assert.equal(await ports.financial("g_x"), null);
    assert.equal(await ports.financialByChainGameId("1"), null);
    assert.equal(await ports.terminalEvidence("g_x"), null);
    assert.equal(await ports.chainGame("1"), null);
    assert.equal(ports.escrowPin(), null);
  });

  test("a quorum read (two or more endpoints) is chain-confirmed; a pin in another denom is no pin", async () => {
    const quorum = {
      financialRecord: async () => null,
      ludumChain: {
        pin: () => ({ contract: "juno1c", chainId: "uni-7", denom: "ujuno" }),
        game: async () => ({ game: {}, provenance: "chain-confirmed" as const, observedAt: "x" }),
      },
    };
    const ports = createLudumPorts({ records: () => [], money: () => quorum as never, now: () => 0 });
    assert.equal(ports.escrowPin(), null, "only ujunox is a Junox pin");
    assert.equal((await ports.chainGame("1"))?.provenance, "chain-confirmed");
    assert.equal(productKeyOf("20 Cosmos"), "20-cosmos");
  });
});

describe("LUDUM wiring (integration): an incomplete game index is never served as a whole history", () => {
  test("records() throws while the index is incomplete, and so does the chain-game lookup that scans it", async () => {
    const ports = createLudumPorts({ records: () => [], index: () => ({ complete: false, reason: "startup discovery has not finished" }), money: () => ({ financialRecord: async () => null }) as never, now: () => 0 });
    assert.throws(() => [...ports.records()], LudumIndexIncomplete);
    await assert.rejects(ports.financialByChainGameId("1"), LudumIndexIncomplete);
    const ready = createLudumPorts({ records: () => [], index: () => ({ complete: true }), money: () => null, now: () => 0 });
    assert.deepEqual([...ready.records()], []);
  });
});
