// server/src/escrow/p3FinalHostAnteBinding.test.ts
//
// ==================================================================
//  PHASE 3 FINAL -- A HOST'S ANTE BINDS ITS WALLET, EVEN BEFORE THE TABLE IS BOUND (security review, money layer)
// ==================================================================
//
// The owner's rule: once a seat has anted into a table, that game+seat's deposit/payout wallet binding cannot be changed
// by anything (no relink to another wallet, no account action, no security event, no recovery); refunds and payouts are
// never redirected. A host's ante is its CreateGame, which needs no admission -- so it can sit on chain while the table
// is still UNBOUND (no hint, a restart, a bind refused for a moment). Pinned here, over real HTTP, production identity
// and the offline Juno (`escrow4Support.ts`):
//
//   - a link of ANOTHER wallet by the host is decided by a CONCLUSIVE search of the chain for an ante under ANY proven
//     ticket of the host's seat (`hostAnteOnChain`): found -> refused (or, for the anted wallet itself, a free relink that
//     binds the escrow); can't tell -> 503, nothing issued. However many games the contract holds after the ticket's
//     floor, whatever bind refusal the observer met, whichever ticket order the CreateGames landed in.
//   - the observer's discovery sets aside only a candidate refused for ITSELF, and only for the ticket it was refused
//     for; a refusal that is about the table or the moment (restore-unverified, a serving verdict) is retried.
//   - cancel-room never drops a table over an unbound ante on chain (or one that may still land).
//   - a restored table's money writes wait for its restore check (L6-2), as its seat ops do.
//   - take-seat: an outsider of a private table learns nothing from the free-table check.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { RESTORE_READ_ONLY_SENTENCE } from "./escrowService";
import { hostCreates, joinerFunds, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet, viewOf, type MoneyServer, type Player } from "./escrow4Support";
import { HINT_TTL_MS, HOST_ANTE_MAX_PAGES, HOST_CREATE_WINDOW_MS } from "./moneyTables";
import { createMemoryRecordStore } from "../rooms/recordStore";
import { apiRequest, Client, loginOnFreshBrowser, quietConsole, startServer, stopServer } from "../rooms/testSupport";
import type { RoomMoneyView } from "../../../frontend/src/utils/moneyProtocol";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";

quietConsole();

const moneyOf = (view: Record<string, unknown>) => view.money as RoomMoneyView;
const boundOf = async (world: MoneyServer, gameId: string): Promise<string | null> => (await world.financial.load(gameId))?.binding?.escrow?.chain_game_id ?? null;
const grantCount = async (world: MoneyServer, gameId: string): Promise<number> => (await world.ledger.snapshot(gameId)).grants.length;
const HOST_SENTENCE = (wallet: string) => new RegExp(`already on Juno from ${wallet}`);

/** The host signs in on a phone (username + password), confirms, and signs out every other device: a security event
 *  that ends the host's link (it stops standing). The phone is returned as a player. */
async function hostPhoneSignsOutOthers(world: MoneyServer, host: Player): Promise<Player> {
  const signedIn = await loginOnFreshBrowser(world.port, host.browser.username, host.browser.password);
  assert.equal(signedIn.answer.status, 200, signedIn.answer.text);
  const cookie = signedIn.cookie as string;
  const confirm = async () => {
    const answer = await apiRequest(world.port, "/gs/api/profile/reauth", { cookie, body: { password: host.browser.password } });
    assert.equal(answer.status, 200, answer.text);
  };
  await confirm();
  assert.equal((await apiRequest(world.port, "/gs/api/profile/sign-out-others", { cookie, body: {} })).status, 200);
  await world.money.idle();
  const client = await Client.openWithCookie(world.port, cookie, `${host.name}-phone`);
  return { browser: { ...host.browser, cookie }, client, name: `${host.name}-phone`, api: (route, body = {}) => apiRequest(world.port, `/gs/api/money/${route}`, { cookie, body }), confirm };
}

/** `count` games of other people on the same contract (after the host's ticket floor). A handful of other wallets
 *  (deriving a key per game would block the event loop for thousands of games). */
function otherGames(world: MoneyServer, count: number, label: string): void {
  const others = [0, 1, 2].map((i) => ({ wallet: testWallet(`${label}/other/${i}`).address, key: testConsentKey(`${label}/other/${i}`).pubkey }));
  for (let i = 0; i < count; i += 1) {
    const other = others[i % others.length];
    const made = world.chain.createGame(other.wallet, { max_players: 3, mode: "live", rules_engine_version: RULES_ENGINE_VERSION, variants_digest: "ab".repeat(32), consent_pubkey: other.key, join_ticket: "cd".repeat(32) }, "1000000");
    assert.equal(made.ok, true, JSON.stringify(made));
  }
}

/** A host with a table, wallet A linked (ticket T1), its CreateGame on chain WITHOUT a hint (`others` other games land
 *  first), and the host's link then ended by a security event from a phone -- the table still unbound. */
async function unboundAnte(world: MoneyServer, label: string, others = 0) {
  const host = await player(world, "Hana");
  const table = await openMoneyTable(host);
  const A = testWallet(`${label}/A`);
  const kA = testConsentKey(`${label}/A`);
  const linked = await linkWallet(host, table.gameId, A, kA);
  assert.equal(linked.status, 200, linked.text);
  otherGames(world, others, label);
  const chainGameId = await hostCreates(world, host, table.gameId, A, kA, linked.body?.ticket as string, { hint: false });
  const phone = await hostPhoneSignsOutOthers(world, host);
  assert.equal(await boundOf(world, table.gameId), null, "the host's CreateGame is on chain and the table is unbound (the case under test)");
  return { host, phone, table, A, kA, ticket: linked.body?.ticket as string, chainGameId };
}

/* ================================================================================================= */
/* The conclusive search: a host's link of another wallet                                             */
/* ================================================================================================= */

describe("PHASE 3 FINAL: a host's unbound ante on chain fixes the seat's wallet (the conclusive search)", () => {
  test("positive: after a security event, another wallet is refused naming the anted one; relinking the anted wallet is free and binds", async () => {
    const world = await moneyServer();
    try {
      const { phone, table, A, ticket, chainGameId } = await unboundAnte(world, "hab/pos");
      try {
        const before = await grantCount(world, table.gameId);
        const swap = await linkWallet(phone, table.gameId, testWallet("hab/pos/B"), testConsentKey("hab/pos/B"));
        assert.deepEqual([swap.status, swap.body?.error], [409, "withdraw-or-relink-first"], swap.text);
        assert.match(String(swap.body?.reason), HOST_SENTENCE(A.address));
        assert.equal(await grantCount(world, table.gameId), before, "nothing was issued");
        const relink = await linkWallet(phone, table.gameId, A, testConsentKey("hab/pos/A2"));
        assert.deepEqual([relink.status, relink.body?.mode], [200, "relinked"], relink.text);
        assert.equal(relink.body?.ticket, ticket, "the relink re-adopts the ticket the ante carries");
        await world.observe();
        assert.equal(await boundOf(world, table.gameId), chainGameId);
        const view = moneyOf(await viewOf(phone.client, table.gameId));
        assert.deepEqual([view.you?.funding, view.you?.payoutWallet], ["funded", A.address]);
      } finally {
        await phone.client.close();
      }
    } finally {
      await world.close();
    }
  });

  test("positive: relinking the anted wallet straight away binds the escrow in the link itself", async () => {
    const world = await moneyServer();
    try {
      const { phone, table, A, chainGameId } = await unboundAnte(world, "hab/pos2");
      try {
        const relink = await linkWallet(phone, table.gameId, A, testConsentKey("hab/pos2/A2"));
        assert.deepEqual([relink.status, relink.body?.mode], [200, "relinked"], relink.text);
        assert.equal(await boundOf(world, table.gameId), chainGameId, "bound by the link's W-13 bind (no observation in between)");
      } finally {
        await phone.client.close();
      }
    } finally {
      await world.close();
    }
  });

  test("more than 90 other games after the ticket's floor: the search reads to the end of the list and still refuses", async () => {
    const world = await moneyServer();
    try {
      const { phone, table, A, chainGameId } = await unboundAnte(world, "hab/many", 95);
      try {
        assert.equal(chainGameId, "96");
        const before = await grantCount(world, table.gameId);
        const swap = await linkWallet(phone, table.gameId, testWallet("hab/many/B"), testConsentKey("hab/many/B"));
        assert.deepEqual([swap.status, swap.body?.error], [409, "withdraw-or-relink-first"], `FAIL-OPEN: ${swap.text}`);
        assert.match(String(swap.body?.reason), HOST_SENTENCE(A.address));
        assert.equal(await grantCount(world, table.gameId), before);
        const relink = await linkWallet(phone, table.gameId, A, testConsentKey("hab/many/A2"));
        assert.equal(relink.status, 200, relink.text);
        assert.equal(await boundOf(world, table.gameId), chainGameId);
      } finally {
        await phone.client.close();
      }
    } finally {
      await world.close();
    }
  });

  test("a game list longer than one search may read (HOST_ANTE_MAX_PAGES): 503 and nothing issued -- never 'no ante'; the next searches go on where it stopped and find the ante", async () => {
    const world = await moneyServer();
    try {
      const { phone, table, A, chainGameId } = await unboundAnte(world, "hab/cap", 6_005);
      try {
        assert.ok(HOST_ANTE_MAX_PAGES * 30 < 6_005, "the list is longer than one search reads");
        const before = await grantCount(world, table.gameId);
        const B = testWallet("hab/cap/B");
        const answers: string[] = [];
        let swap = await linkWallet(phone, table.gameId, B, testConsentKey("hab/cap/B"));
        for (let attempt = 0; attempt < 5 && swap.status === 503; attempt += 1) {
          answers.push(`${swap.status} ${String(swap.body?.error)}`);
          assert.equal(await grantCount(world, table.gameId), before, "nothing was issued");
          swap = await linkWallet(phone, table.gameId, B, testConsentKey("hab/cap/B"));
        }
        assert.deepEqual(answers, ["503 chain-unavailable", "503 chain-unavailable"], "two searches cut short by the cap (3,000 games each), never 'absent'");
        assert.ok(world.warnings.some((line) => new RegExp(`could not be told -- the game list did not end within ${HOST_ANTE_MAX_PAGES} pages`).test(line)), world.warnings.slice(-3).join(" | "));
        assert.deepEqual([swap.status, swap.body?.error], [409, "withdraw-or-relink-first"], `FAIL-OPEN: ${swap.text}`);
        assert.match(String(swap.body?.reason), HOST_SENTENCE(A.address));
        assert.equal(await grantCount(world, table.gameId), before);
        assert.equal(await boundOf(world, table.gameId), chainGameId);
      } finally {
        await phone.client.close();
      }
    } finally {
      await world.close();
    }
  });

  test("a bind refused for a moment (restore-unverified) during the search: another wallet is still refused, and the escrow binds later", async () => {
    const world = await moneyServer();
    try {
      const { phone, table, A, chainGameId } = await unboundAnte(world, "hab/transient");
      try {
        const original = world.service.bindHostChainGame;
        let attempts = 0;
        world.service.bindHostChainGame = async () => {
          attempts += 1;
          return { ok: false, code: "restore-unverified", detail: "simulated (L6-2 post-restore safe mode)" };
        };
        const before = await grantCount(world, table.gameId);
        let swap;
        try {
          swap = await linkWallet(phone, table.gameId, testWallet("hab/transient/B"), testConsentKey("hab/transient/B"));
        } finally {
          world.service.bindHostChainGame = original;
        }
        assert.deepEqual([swap.status, swap.body?.error], [409, "withdraw-or-relink-first"], `FAIL-OPEN (bind attempts ${attempts}): ${swap.text}`);
        assert.match(String(swap.body?.reason), HOST_SENTENCE(A.address));
        assert.equal(await grantCount(world, table.gameId), before);
        const relink = await linkWallet(phone, table.gameId, A, testConsentKey("hab/transient/A2"));
        assert.deepEqual([relink.status, relink.body?.mode], [200, "relinked"], relink.text);
        await world.observe();
        assert.equal(await boundOf(world, table.gameId), chainGameId, "the transient refusal did not set the host's escrow aside");
      } finally {
        await phone.client.close();
      }
    } finally {
      await world.close();
    }
  });

  test("tickets T1(A), T2(B), T3(A) and T1's CreateGame landing late: never filed away by T3's scan; another wallet refused, standing or not", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const A = testWallet("hab/order/A");
      const B = testWallet("hab/order/B");
      const kA = testConsentKey("hab/order/A");
      const t1 = await linkWallet(host, table.gameId, A, kA);
      assert.equal(t1.status, 200, t1.text);
      assert.equal((await linkWallet(host, table.gameId, B, testConsentKey("hab/order/B"), { replace: true })).status, 200);
      const t3 = await linkWallet(host, table.gameId, A, testConsentKey("hab/order/A3"), { replace: true });
      assert.equal(t3.status, 200, t3.text);
      assert.notEqual(t3.body?.ticket, t1.body?.ticket);
      /* The T1 CreateGame (signed before the relinks) lands now, no hint. The observer's scan (standing T3) meets it. */
      const chainGameId = await hostCreates(world, host, table.gameId, A, kA, t1.body?.ticket as string, { hint: false });
      world.advance(HOST_CREATE_WINDOW_MS + 1_000);
      await world.observe();
      assert.equal(await boundOf(world, table.gameId), null, "W-13 refuses it for T3 (not the standing ticket)");
      /* The standing link (A, T3) replaced by C: refused -- the ante is A's. */
      const C = testWallet("hab/order/C");
      const standingSwap = await linkWallet(host, table.gameId, C, testConsentKey("hab/order/C"), { replace: true });
      assert.deepEqual([standingSwap.status, standingSwap.body?.error], [409, "withdraw-or-relink-first"], `FAIL-OPEN (standing): ${standingSwap.text}`);
      assert.match(String(standingSwap.body?.reason), HOST_SENTENCE(A.address));
      /* After a security event, from a phone: refused too. */
      const phone = await hostPhoneSignsOutOthers(world, host);
      try {
        const before = await grantCount(world, table.gameId);
        const swap = await linkWallet(phone, table.gameId, C, testConsentKey("hab/order/C2"));
        assert.deepEqual([swap.status, swap.body?.error], [409, "withdraw-or-relink-first"], `FAIL-OPEN: ${swap.text}`);
        assert.match(String(swap.body?.reason), HOST_SENTENCE(A.address));
        assert.equal(await grantCount(world, table.gameId), before);
        /* A relinks -- re-adopting T1, the ticket its ante carries -- and the escrow binds. */
        const relink = await linkWallet(phone, table.gameId, A, testConsentKey("hab/order/A4"));
        assert.deepEqual([relink.status, relink.body?.mode, relink.body?.ticket], [200, "relinked", t1.body?.ticket], relink.text);
        await world.observe();
        assert.equal(await boundOf(world, table.gameId), chainGameId);
        assert.equal(moneyOf(await viewOf(phone.client, table.gameId)).you?.funding, "funded");
      } finally {
        await phone.client.close();
      }
    } finally {
      await world.close();
    }
  });

  test("a STANDING host link replaced by another wallet after the hint aged out, while the observer could not bind the ante: refused", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const A = testWallet("hab/standing/A");
      const kA = testConsentKey("hab/standing/A");
      const linked = await linkWallet(host, table.gameId, A, kA);
      assert.equal(linked.status, 200, linked.text);
      await world.money.idle();
      /* A serving verdict that is momentarily not "continues": every bind of this table is refused for now. */
      const original = world.service.bindHostChainGame;
      world.service.bindHostChainGame = async () => ({ ok: false, code: "deployment-unverified", detail: "simulated" });
      try {
        const chainGameId = await hostCreates(world, host, table.gameId, A, kA, linked.body?.ticket as string);
        await world.observe();
        world.advance(HINT_TTL_MS + 60_000);
        await world.observe();
        assert.equal(await boundOf(world, table.gameId), null);
        assert.equal(world.money.hintsOf(table.gameId).length, 0, "the hint aged out");
        const before = await grantCount(world, table.gameId);
        const swap = await linkWallet(host, table.gameId, testWallet("hab/standing/B"), testConsentKey("hab/standing/B"), { replace: true });
        assert.deepEqual([swap.status, swap.body?.error], [409, "withdraw-or-relink-first"], `FAIL-OPEN: ${swap.text}`);
        assert.match(String(swap.body?.reason), HOST_SENTENCE(A.address));
        assert.equal(await grantCount(world, table.gameId), before);
        /* The same wallet again: the table is already open on Juno with it. */
        const same = await linkWallet(host, table.gameId, A, testConsentKey("hab/standing/A2"));
        assert.deepEqual([same.status, same.body?.error], [409, "already-funded"], same.text);
        world.service.bindHostChainGame = original;
        await world.observe();
        assert.equal(await boundOf(world, table.gameId), chainGameId, "the refusal set nothing aside: the observer binds it once binds are served");
      } finally {
        world.service.bindHostChainGame = original;
      }
    } finally {
      await world.close();
    }
  });

  test("a chain read that fails during the search: 503 and nothing issued (the 4th page of the game list, or the quorum read)", async () => {
    const world = await moneyServer();
    try {
      const { phone, table, A, chainGameId } = await unboundAnte(world, "hab/fail", 95);
      try {
        const smart = world.chain.smart.bind(world.chain);
        /* Every game-list page from id 90 on fails (an endpoint dropping out mid-search). */
        world.chain.smart = async (contract: string, queryJson: string) => {
          const query = JSON.parse(queryJson) as { games?: { start_after: number | null } };
          if (query.games !== undefined && (query.games.start_after ?? 0) >= 90) throw new Error("simulated: the node went away");
          return smart(contract, queryJson);
        };
        const before = await grantCount(world, table.gameId);
        const B = testWallet("hab/fail/B");
        let swap;
        try {
          swap = await linkWallet(phone, table.gameId, B, testConsentKey("hab/fail/B"));
        } finally {
          world.chain.smart = smart;
        }
        assert.deepEqual([swap.status, swap.body?.error], [503, "chain-unavailable"], `FAIL-OPEN: ${swap.text}`);
        assert.match(String(swap.body?.reason), /Juno couldn't be checked just now/);
        assert.equal(await grantCount(world, table.gameId), before, "nothing was issued");
        /* The quorum read of the candidate disagrees: 503 too. */
        world.chain.quorumDisagrees = true;
        try {
          const disagreed = await linkWallet(phone, table.gameId, B, testConsentKey("hab/fail/B2"));
          assert.deepEqual([disagreed.status, disagreed.body?.error], [503, "chain-unavailable"], disagreed.text);
        } finally {
          world.chain.quorumDisagrees = false;
        }
        assert.equal(await grantCount(world, table.gameId), before);
        assert.equal(await boundOf(world, table.gameId), null);
        /* Once Juno answers: refused, naming the anted wallet. */
        const answered = await linkWallet(phone, table.gameId, B, testConsentKey("hab/fail/B3"));
        assert.deepEqual([answered.status, answered.body?.error], [409, "withdraw-or-relink-first"], answered.text);
        assert.match(String(answered.body?.reason), HOST_SENTENCE(A.address));
        assert.equal(await boundOf(world, table.gameId), chainGameId);
      } finally {
        await phone.client.close();
      }
    } finally {
      await world.close();
    }
  });
});

/* ================================================================================================= */
/* Review NEW 2: the search can't be forced into "can't tell" for good                                */
/* ================================================================================================= */

/** Every `games` list query the chain answers (one endpoint or the quorum), by its `start_after` (null: from game 1). */
function countListReads(world: MoneyServer): { readonly starts: Array<number | null>; restore(): void } {
  const smart = world.chain.smart.bind(world.chain);
  const starts: Array<number | null> = [];
  world.chain.smart = async (contract: string, queryJson: string) => {
    const query = JSON.parse(queryJson) as { games?: { start_after: number | null } };
    if (query.games !== undefined) starts.push(query.games.start_after);
    return smart(contract, queryJson);
  };
  return { starts, restore: () => void (world.chain.smart = smart) };
}

describe("PHASE 3 FINAL (review NEW 2): the conclusive search goes on where it stopped, and never mints a ticket without a floor", () => {
  test("the chain's next game id can't be read: no fresh ticket (503, nothing issued, the signed link not spent); once it can, the link carries a floor", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const A = testWallet("hab/floor/A");
      const kA = testConsentKey("hab/floor/A");
      const smart = world.chain.smart.bind(world.chain);
      /* The config answers, but without the next game id (as an endpoint that can't say it). */
      world.chain.smart = async (contract: string, queryJson: string) => {
        const answer = await smart(contract, queryJson);
        return (JSON.parse(queryJson) as { config?: unknown }).config !== undefined ? { ...(answer as Record<string, unknown>), next_chain_game_id: null } : answer;
      };
      let refused;
      let challenge;
      try {
        await host.confirm();
        challenge = await host.api("wallet-challenge", { gameId: table.gameId, wallet: A.address });
        assert.equal(challenge.status, 200, challenge.text);
        const signed = A.signArbitrary(challenge.body?.text as string);
        refused = await host.api("wallet-link", { gameId: table.gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: kA.pubkey });
      } finally {
        world.chain.smart = smart;
      }
      assert.deepEqual([refused.status, refused.body?.error], [503, "chain-unavailable"], `a ticket with no floor: ${refused.text}`);
      assert.equal(await grantCount(world, table.gameId), 0, "nothing was issued");
      /* The same signed link, once the chain answers: issued, with the chain's next game id as its floor. */
      const signed = A.signArbitrary(challenge.body?.text as string);
      const linked = await host.api("wallet-link", { gameId: table.gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: kA.pubkey });
      assert.deepEqual([linked.status, linked.body?.mode], [200, "issued"], linked.text);
      const grant = (await world.ledger.snapshot(table.gameId)).grants[0];
      assert.equal(grant.create_floor, String(world.chain.games.size + 1), "the floor is the chain's next game id, read fresh");
    } finally {
      await world.close();
    }
  });

  test("once a search over a long list concluded 'absent', a later cancel reads only the games that are new -- and never goes unknown", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      assert.equal((await linkWallet(host, table.gameId, testWallet("hab/mark/A"), testConsentKey("hab/mark/A"))).status, 200);
      otherGames(world, 6_005, "hab/mark");
      const phone = await hostPhoneSignsOutOthers(world, host);
      try {
        /* The first link after the security event searches 6,005 games: two searches cut short, then 'absent'. */
        const B = testWallet("hab/mark/B");
        const answers: number[] = [];
        let linked = await linkWallet(phone, table.gameId, B, testConsentKey("hab/mark/B"));
        for (let attempt = 0; attempt < 5 && linked.status === 503; attempt += 1) {
          answers.push(linked.status);
          linked = await linkWallet(phone, table.gameId, B, testConsentKey("hab/mark/B"));
        }
        assert.deepEqual(answers, [503, 503]);
        assert.deepEqual([linked.status, linked.body?.mode], [200, "issued"], linked.text);
        const head = world.chain.games.size;
        otherGames(world, 12, "hab/mark/later");
        world.advance(HOST_CREATE_WINDOW_MS + 1_000);
        await world.money.idle();
        const reads = countListReads(world);
        let cancelled;
        try {
          cancelled = await phone.client.op({ type: "cancel-room" }, table.gameId);
        } finally {
          reads.restore();
        }
        assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
        assert.ok(reads.starts.length > 0 && reads.starts.length <= 6, `a page or two (and the observer's): ${JSON.stringify(reads.starts)}`);
        assert.ok(reads.starts.every((start) => start !== null && start >= head), `nothing at or below game ${head} read again: ${JSON.stringify(reads.starts)}`);
        assert.equal(world.warnings.filter((line) => /could not be told/.test(line)).length, 2, "only the two searches cut short");
      } finally {
        await phone.client.close();
      }
    } finally {
      await world.close();
    }
  });

  test("a CreateGame landing AFTER a search concluded 'absent', under a ticket that search covered, is still found", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const A = testWallet("hab/late/A");
      const kA = testConsentKey("hab/late/A");
      const t1 = await linkWallet(host, table.gameId, A, kA);
      assert.equal(t1.status, 200, t1.text);
      otherGames(world, 40, "hab/late");
      const phone = await hostPhoneSignsOutOthers(world, host);
      try {
        /* Absent: B is linked (the search covered A's ticket T1 through the head). */
        const B = testWallet("hab/late/B");
        const linked = await linkWallet(phone, table.gameId, B, testConsentKey("hab/late/B"));
        assert.deepEqual([linked.status, linked.body?.mode], [200, "issued"], linked.text);
        /* A's CreateGame, signed with T1 before, lands now (no hint), after more games. */
        otherGames(world, 35, "hab/late/more");
        const chainGameId = await hostCreates(world, host, table.gameId, A, kA, t1.body?.ticket as string, { hint: false });
        const C = testWallet("hab/late/C");
        const swap = await linkWallet(phone, table.gameId, C, testConsentKey("hab/late/C"), { replace: true });
        assert.deepEqual([swap.status, swap.body?.error], [409, "withdraw-or-relink-first"], `the mark hid the ante: ${swap.text}`);
        assert.match(String(swap.body?.reason), HOST_SENTENCE(A.address));
        /* Remembered: a cancel finds it again (read by quorum), and A relinks it. */
        world.advance(HOST_CREATE_WINDOW_MS + 1_000);
        const cancel = await phone.client.op({ type: "cancel-room" }, table.gameId);
        assert.equal(cancel.ok, false, JSON.stringify(cancel));
        const relink = await linkWallet(phone, table.gameId, A, testConsentKey("hab/late/A2"));
        assert.deepEqual([relink.status, relink.body?.mode, relink.body?.ticket], [200, "relinked", t1.body?.ticket], relink.text);
        assert.equal(await boundOf(world, table.gameId), chainGameId);
      } finally {
        await phone.client.close();
      }
    } finally {
      await world.close();
    }
  });

  test("one endpoint lagging (its list ends before the host's CreateGame) or skipping it: the rest is read by quorum, never a false 'absent'", async () => {
    for (const mode of ["lagging", "skipping"] as const) {
      const world = await moneyServer();
      try {
        const { phone, table, A, chainGameId } = await unboundAnte(world, `hab/lag/${mode}`, 50);
        otherGames(world, 3, `hab/lag/${mode}/after`);
        try {
          const smart = world.chain.smart.bind(world.chain);
          const ante = Number(chainGameId);
          /* One endpoint (the one-endpoint reads): its game list lacks the host's CreateGame -- every game from it on
             (lagging), or just that one (skipping). Every endpoint asked together (the quorum) answers as the chain. */
          world.chain.smartQuorum = async (contract: string, queryJson: string) => smart(contract, queryJson);
          world.chain.smart = async (contract: string, queryJson: string) => {
            const answer = await smart(contract, queryJson);
            if ((JSON.parse(queryJson) as { games?: unknown }).games === undefined) return answer;
            const games = (answer as { games: Array<{ chain_game_id: number }> }).games;
            return { games: games.filter((game) => (mode === "lagging" ? game.chain_game_id < ante : game.chain_game_id !== ante)) };
          };
          const swap = await linkWallet(phone, table.gameId, testWallet(`hab/lag/${mode}/B`), testConsentKey(`hab/lag/${mode}/B`));
          assert.deepEqual([swap.status, swap.body?.error], [409, "withdraw-or-relink-first"], `${mode}: ${swap.text}`);
          assert.match(String(swap.body?.reason), HOST_SENTENCE(A.address));
        } finally {
          await phone.client.close();
        }
      } finally {
        await world.close();
      }
    }
  });
});

/* ================================================================================================= */
/* The observer: a refusal about the moment is retried                                                */
/* ================================================================================================= */

describe("PHASE 3 FINAL: the observer sets aside only a candidate refused for itself", () => {
  test("one transient restore-unverified refusal does not poison the host's escrow: it binds once binds are served", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const A = testWallet("hab/observer/A");
      const kA = testConsentKey("hab/observer/A");
      const linked = await linkWallet(host, table.gameId, A, kA);
      assert.equal(linked.status, 200, linked.text);
      await world.money.idle();
      const original = world.service.bindHostChainGame;
      world.service.bindHostChainGame = async () => ({ ok: false, code: "restore-unverified", detail: "simulated" });
      let chainGameId: string;
      try {
        chainGameId = await hostCreates(world, host, table.gameId, A, kA, linked.body?.ticket as string);
        await world.observe();
      } finally {
        world.service.bindHostChainGame = original;
      }
      assert.equal(await boundOf(world, table.gameId), null);
      world.advance(20_000);
      await world.observe();
      assert.equal(await boundOf(world, table.gameId), chainGameId, "retried, not filed as a duplicate");
      /* And after the hint is gone (the scan alone finds it), the same: a second table, its hint aged out first. */
      const table2 = await openMoneyTable(host);
      const linked2 = await linkWallet(host, table2.gameId, A, testConsentKey("hab/observer/A2"));
      assert.equal(linked2.status, 200, linked2.text);
      world.service.bindHostChainGame = async () => ({ ok: false, code: "restore-unverified", detail: "simulated" });
      let chainGameId2: string;
      try {
        chainGameId2 = await hostCreates(world, host, table2.gameId, A, kA, linked2.body?.ticket as string, { hint: false });
        await world.observe();
      } finally {
        world.service.bindHostChainGame = original;
      }
      assert.equal(await boundOf(world, table2.gameId), null);
      world.advance(20_000);
      await world.observe();
      assert.equal(await boundOf(world, table2.gameId), chainGameId2);
    } finally {
      await world.close();
    }
  });
});

/* ================================================================================================= */
/* cancel-room over an unbound ante                                                                   */
/* ================================================================================================= */

describe("PHASE 3 FINAL: cancel-room never drops a table over the host's unbound ante", () => {
  test("after a security event: refused while the CreateGame may land, refused (try again) when Juno can't say, refused when the ante is on chain", async () => {
    const world = await moneyServer();
    try {
      const { phone, table, A, chainGameId } = await unboundAnte(world, "hab/cancel");
      try {
        const early = await phone.client.op({ type: "cancel-room" }, table.gameId);
        assert.deepEqual([early.ok, early.code], [false, "deposit-in-flight"], `the ended link's CreateGame may still be in flight: ${JSON.stringify(early)}`);
        world.advance(HOST_CREATE_WINDOW_MS + 1_000);
        world.chain.quorumDisagrees = true;
        let unknown;
        try {
          unknown = await phone.client.op({ type: "cancel-room" }, table.gameId);
        } finally {
          world.chain.quorumDisagrees = false;
        }
        assert.deepEqual([unknown.ok, unknown.code], [false, "chain-unknown"], JSON.stringify(unknown));
        assert.match(String(unknown.reason), /Try again/);
        const found = await phone.client.op({ type: "cancel-room" }, table.gameId);
        assert.deepEqual([found.ok, found.code], [false, "cancel-on-juno"], JSON.stringify(found));
        assert.match(String(found.reason), new RegExp(A.address));
        assert.equal(world.server.rooms.moneyPort.recordOf(table.gameId)?.status, "waiting", "the room stands");
        /* The host cancels the escrow on Juno (every deposit back to its depositor): the room follows. */
        assert.ok(world.chain.cancel(chainGameId, A.address).ok);
        await world.observe();
        await world.observe();
        assert.equal(world.server.rooms.moneyPort.recordOf(table.gameId)?.status, "cancelled");
      } finally {
        await phone.client.close();
      }
    } finally {
      await world.close();
    }
  });

  test("no ante on chain: the room cancels once the CreateGame window has passed (unchanged)", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      assert.equal((await linkWallet(host, table.gameId, testWallet("hab/cancel-none/A"), testConsentKey("hab/cancel-none/A"))).status, 200);
      otherGames(world, 40, "hab/cancel-none");
      const phone = await hostPhoneSignsOutOthers(world, host);
      try {
        world.advance(HOST_CREATE_WINDOW_MS + 1_000);
        const cancelled = await phone.client.op({ type: "cancel-room" }, table.gameId);
        assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
      } finally {
        await phone.client.close();
      }
    } finally {
      await world.close();
    }
  });
});

/* ================================================================================================= */
/* L6-2: a restored table's money writes wait for its restore check                                   */
/* ================================================================================================= */

describe("PHASE 3 FINAL: money writes of a restored table wait for its restore check (L6-2)", () => {
  test("wallet challenge, wallet link, signing key and join admission are refused while the restore gate is closed; the view is still served", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const jo = await player(world, "Jo");
      const table = await openMoneyTable(host);
      const A = testWallet("hab/restore/A");
      const kA = testConsentKey("hab/restore/A");
      const linked = await linkWallet(host, table.gameId, A, kA);
      assert.equal(linked.status, 200, linked.text);
      const chainGameId = await hostCreates(world, host, table.gameId, A, kA, linked.body?.ticket as string);
      await world.observe();
      assert.equal(await boundOf(world, table.gameId), chainGameId);
      assert.equal((await jo.client.op({ type: "join", code: table.code, takeSeat: true })).ok, true);
      const J = testWallet("hab/restore/J");
      const kJ = testConsentKey("hab/restore/J");
      const joLinked = await linkWallet(jo, table.gameId, J, kJ);
      assert.equal(joLinked.status, 200, joLinked.text);
      /* The joiner's wallet K signed a link challenge before the restore gate closed. */
      const K = testWallet("hab/restore/K");
      const kK = testConsentKey("hab/restore/K");
      await jo.confirm();
      const minted = await jo.api("wallet-challenge", { gameId: table.gameId, wallet: K.address });
      assert.equal(minted.status, 200, minted.text);
      const signed = K.signArbitrary(minted.body?.text as string);
      const linkBody = { gameId: table.gameId, nonce: minted.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: kK.pubkey, replace: true };
      const original = world.service.restoreGate;
      world.service.restoreGate = (gameId: string) => (gameId === table.gameId ? RESTORE_READ_ONLY_SENTENCE : original(gameId));
      try {
        const before = await grantCount(world, table.gameId);
        const link = await jo.api("wallet-link", linkBody);
        assert.deepEqual([link.status, link.body?.error, link.body?.reason], [503, "held", RESTORE_READ_ONLY_SENTENCE], link.text);
        assert.equal(await grantCount(world, table.gameId), before, "nothing was written to the ledger");
        const admission = await jo.api("join-admission", { gameId: table.gameId });
        assert.deepEqual([admission.status, admission.body?.error], [503, "held"], admission.text);
        await jo.confirm();
        const key = await jo.api("consent-key", { gameId: table.gameId, pubkey: testConsentKey("hab/restore/J2").pubkey });
        assert.deepEqual([key.status, key.body?.error], [503, "held"], key.text);
        const challenge = await jo.api("wallet-challenge", { gameId: table.gameId, wallet: testWallet("hab/restore/C").address });
        assert.deepEqual([challenge.status, challenge.body?.error], [503, "held"], challenge.text);
        const grants = (await world.ledger.snapshot(table.gameId)).grants;
        assert.ok(grants.every((grant) => !grant.consent_keys.includes(testConsentKey("hab/restore/J2").pubkey) && grant.admitted_until_secs === null), "no key registered, no admission recorded");
        /* Read-only: the table's money view is served as ever. */
        const view = moneyOf(await viewOf(jo.client, table.gameId));
        assert.equal(view.escrow.chainGameId, chainGameId);
        assert.equal(view.you?.link?.wallet, J.address);
      } finally {
        world.service.restoreGate = original;
      }
      /* Verified: the same signed link goes through (a 503 never spent it), and K funds the seat. */
      await jo.confirm();
      const relinked = await jo.api("wallet-link", linkBody);
      assert.deepEqual([relinked.status, relinked.body?.mode], [200, "issued"], relinked.text);
      const funded = await joinerFunds(world, jo, table.gameId, K, kK, relinked.body?.ticket as string);
      assert.equal(funded.chainGameId, chainGameId);
    } finally {
      await world.close();
    }
  });
});

/* ================================================================================================= */
/* take-seat: authorization before the free-table check                                               */
/* ================================================================================================= */

describe("PHASE 3 FINAL: take-seat answers an outsider of a private table as if the table did not exist", () => {
  test("a private legacy no-ante table: the outsider is told not-found (not ante-required); a viewer of a public one is told ante-required", async () => {
    const records = createMemoryRecordStore();
    const before = await startServer({ records });
    let privateId: string;
    let publicId: string;
    try {
      const alice = await Client.open(before.port, "alice");
      const made = await alice.op({ type: "create", visibility: "private", exactPlayers: null, variants: {}, nickname: "alice" });
      assert.equal(made.ok, true, JSON.stringify(made));
      privateId = (made.data as { gameId: string }).gameId;
      const open = await alice.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "alice" });
      assert.equal(open.ok, true, JSON.stringify(open));
      publicId = (open.data as { gameId: string }).gameId;
      await alice.close();
    } finally {
      await stopServer(before.server);
    }
    const after = await startServer({ records, freeTables: false });
    try {
      const outsider = await Client.open(after.port, "mallory");
      const took = await outsider.op({ type: "take-seat" }, privateId);
      assert.deepEqual([took.ok, took.code], [false, "not-found"], `an outsider learns nothing: ${JSON.stringify(took)}`);
      const viewer = await outsider.op({ type: "take-seat" }, publicId);
      assert.deepEqual([viewer.ok, viewer.code], [false, "ante-required"], JSON.stringify(viewer));
      await outsider.close();
    } finally {
      await stopServer(after.server);
    }
  });
});
