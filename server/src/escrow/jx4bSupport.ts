// server/src/escrow/jx4bSupport.ts
//
// JX-4B test support (never imported by production code): a real-money world in each state a live JX-4 run passes
// through -- CreateGame bound and both seats funded (pre-Start), the roster frozen with its Start intent pending, Start
// confirmed on chain, and a Start that needed a second attempt (the first one's bytes never reached a node and expired) --
// over the offline Juno (`juno/fakeJunoChain.ts`) and production identity. Synthetic only: test wallets, a test server;
// never real user data, never a real chain.

import assert from "node:assert/strict";
import { createHash } from "crypto";

import type { ChainIntentRecord } from "./chainIntents";
import { hostCreates, joinerFunds, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet, type MoneyServer, type Player, type TestConsentKey, type TestWallet } from "./escrow4Support";
import { addressOfPublicKey } from "./juno/cosmosTx";
import { publicKeyOf } from "./juno/secp256k1";

/** A bech32 resolver (a production configuration's trust policy names real addresses). */
export const JX4B_RESOLVER = addressOfPublicKey(publicKeyOf(createHash("sha256").update("18COSMOS/TEST/jx4b/resolver").digest()), "juno");

export type EvidenceStage = "unbound" | "pre-start" | "frozen" | "started" | "retry-live" | "retry-started";

export interface EvidenceWorld {
  readonly world: MoneyServer;
  readonly gameId: string;
  readonly chainGameId: string;
  readonly host: Player;
  readonly joiner: Player;
  readonly joinerPlayerId: string;
  readonly hostWallet: TestWallet;
  readonly joinerWallet: TestWallet;
  readonly hostKey: TestConsentKey;
  readonly joinerKey: TestConsentKey;
  startIntent(): Promise<ChainIntentRecord | undefined>;
}

/** A two-seat money table driven to `stage`. */
export async function moneyEvidenceWorld(stage: EvidenceStage): Promise<EvidenceWorld> {
  const world = await moneyServer({ resolver: JX4B_RESOLVER });
  const host = await player(world, "Hana");
  const table = await openMoneyTable(host);
  const hostWallet = testWallet("jx4b-host");
  const hostKey = testConsentKey("jx4b-host");
  const hostLink = await linkWallet(host, table.gameId, hostWallet, hostKey);
  assert.equal(hostLink.status, 200, hostLink.text);
  const startIntentOf = async () => (await world.intents.listGame(table.gameId)).find((intent) => intent.op.kind === "start");
  if (stage === "unbound") {
    /* The host linked a wallet; no CreateGame exists yet: FIN is pinned to the deployment, bound to no chain game. */
    const nobody = host;
    return { world, gameId: table.gameId, chainGameId: "", host, joiner: nobody, joinerPlayerId: "", hostWallet, joinerWallet: hostWallet, hostKey, joinerKey: hostKey, startIntent: startIntentOf };
  }
  const chainGameId = await hostCreates(world, host, table.gameId, hostWallet, hostKey, hostLink.body?.ticket as string);
  await world.observe();
  const joiner = await player(world, "Jo");
  const joined = await joiner.client.op({ type: "join", code: table.code, takeSeat: true });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  const joinerPlayerId = (joined.data as { playerId: string }).playerId;
  const joinerWallet = testWallet("jx4b-jo");
  const joinerKey = testConsentKey("jx4b-jo");
  const joinerLink = await linkWallet(joiner, table.gameId, joinerWallet, joinerKey);
  assert.equal(joinerLink.status, 200, joinerLink.text);
  await joinerFunds(world, joiner, table.gameId, joinerWallet, joinerKey, joinerLink.body?.ticket as string);
  await world.observe();
  const startIntent = async () => (await world.intents.listGame(table.gameId)).find((intent) => intent.op.kind === "start");
  const out: EvidenceWorld = { world, gameId: table.gameId, chainGameId, host, joiner, joinerPlayerId, hostWallet, joinerWallet, hostKey, joinerKey, startIntent };
  if (stage === "pre-start") return out;
  const started = await host.client.op({ type: "start-game" }, table.gameId);
  assert.equal(started.ok, true, JSON.stringify(started));
  await world.service.idle();
  await world.money.idle();
  if (stage === "frozen") return out;
  const active = async () => world.server.rooms.moneyPort.recordOf(table.gameId)?.status === "active";
  if (stage === "started") {
    await world.drive(active);
    return out;
  }
  /* A Start whose first bytes never reach a node: they expire unincluded (proven dead by height), and the relayer signs
     a second attempt at the chain's sequence. */
  world.chain.dropNextBroadcast = 100_000;
  await world.drive(async () => {
    const intent = await startIntent();
    return intent !== undefined && intent.attempts.length >= 2 && intent.attempts[0].phase === "dead";
  }, 60);
  if (stage === "retry-live") return out;
  world.chain.dropNextBroadcast = 0;
  await world.drive(active, 60);
  return out;
}
