// server/src/escrow/jx3bMultiDevice.test.ts
//
// ==================================================================
//  JX-3B: WALLET BINDING ACROSS DEVICES -- THE PROVING FAMILY OWNS THE PRE-FREEZE STANDING CONTEXT (OD-JX3-1)
// ==================================================================
//
// Every step goes through the production surface (`escrow4Support.ts`): profiled browsers, "Confirm it's you", the
// identity routes that found a second session family (a device-link code, a recovery), sign-out, sign-out-others and
// recovery-key rotation, and `/gs/api/money/*` over the offline Juno. What is pinned:
//
//   1. two families of one principal linking the SAME wallet: the second family's proof re-homes the grant (a new
//      epoch, the same ticket) -- the first family's sign-out no longer ends it, the proving family's does;
//   2. the re-home never bypasses the seat locks (admission outstanding, deposit pending, funded) and never happens on
//      a started (frozen) table;
//   3. two families linking DIFFERENT wallets at once: serialized by the game's actor task -- one link, one
//      replace-required; nothing moves a seat;
//   4. a link racing the proving family's sign-out: no grant stands under a context that ended;
//   5. recovery on a new device, then the same wallet: the grant re-homes to the recovered family;
//   6. recovery-key rotation ends the pre-freeze grant (re-homed or not);
//   7. consent from two devices after a key move: only the chain-current key authorizes; repeats are idempotent.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { apiRequest, Client, cookieRead, quietConsole, sessionIdOfCookie, type ApiAnswer } from "../rooms/testSupport";
import { hostCreates, joinerFunds, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet, viewOf, type MoneyServer, type Player, type TestConsentKey, type TestWallet } from "./escrow4Support";
import type { RoomMoneyView } from "../../../frontend/src/utils/moneyProtocol";

quietConsole();

const moneyOf = (view: Record<string, unknown>) => view.money as RoomMoneyView;
const freshCookie = async (world: MoneyServer): Promise<string> => (await apiRequest(world.port, "/gs/api/session", {})).headers["set-cookie"]![0].split(";")[0];
const cookieOf = (answer: ApiAnswer): string => answer.headers["set-cookie"]![0].split(";")[0];

/** One browser of a principal: its own session (and so its own session family). */
interface Device {
  cookie: string;
  recoveryKey: string;
  api(route: string, body?: object): Promise<ApiAnswer>;
  confirm(): Promise<void>;
  link(gameId: string, wallet: TestWallet, key: TestConsentKey, replace?: boolean): Promise<ApiAnswer>;
  /** "Sign out" on this device: its whole session family is revoked. */
  signOut(): Promise<void>;
  familyId(): string;
}

function deviceOf(world: MoneyServer, cookie: string, recoveryKey: string): Device {
  const device: Device = {
    cookie,
    recoveryKey,
    api: (route, body = {}) => apiRequest(world.port, `/gs/api/money/${route}`, { cookie: device.cookie, body }),
    async confirm() {
      const answer = await apiRequest(world.port, "/gs/api/profile/reauth", { cookie: device.cookie, body: { recoveryKey: device.recoveryKey } });
      assert.equal(answer.status, 200, `reauth: ${answer.text}`);
    },
    async link(gameId, wallet, key, replace) {
      await device.confirm();
      const challenge = await device.api("wallet-challenge", { gameId, wallet: wallet.address });
      if (challenge.status !== 200) return challenge;
      const signed = wallet.signArbitrary(challenge.body?.text as string);
      return device.api("wallet-link", { gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: key.pubkey, ...(replace !== undefined ? { replace } : {}) });
    },
    async signOut() {
      const answer = await apiRequest(world.port, "/gs/api/session/revoke", { cookie: device.cookie, body: {} });
      assert.equal(answer.status, 204, `revoke: ${answer.status} ${answer.text}`);
      await world.money.idle();
    },
    familyId: () => world.identity.peekSession(sessionIdOfCookie(device.cookie))!.family_id,
  };
  return device;
}

/** The player's first browser, as a Device. */
const firstDevice = (world: MoneyServer, who: Player): Device => deviceOf(world, who.browser.cookie, who.browser.recoveryKey);

/** A second browser of the same profile, signed in by a device-link code from the first (a new family, origin "link"). */
async function linkedDevice(world: MoneyServer, who: Player): Promise<Device> {
  const code = await apiRequest(world.port, "/gs/api/profile/link-code", { cookie: who.browser.cookie, body: {} });
  assert.equal(code.status, 201, code.text);
  const linked = await apiRequest(world.port, "/gs/api/profile/link", { cookie: await freshCookie(world), body: { code: code.body?.code } });
  assert.equal(linked.status, 200, linked.text);
  return deviceOf(world, cookieOf(linked), who.browser.recoveryKey);
}

/** A new browser that recovers the profile with its recovery key (a new family, origin "recovery"). */
async function recoveredDevice(world: MoneyServer, who: Player): Promise<Device> {
  const recovered = await apiRequest(world.port, "/gs/api/profile/recover", { cookie: await freshCookie(world), body: { recoveryKey: who.browser.recoveryKey } });
  assert.equal(recovered.status, 200, recovered.text);
  return deviceOf(world, cookieOf(recovered), who.browser.recoveryKey);
}

async function seatJoiner(world: MoneyServer, name: string, code: string): Promise<{ who: Player; playerId: string }> {
  const who = await player(world, name);
  const joined = await who.client.op({ type: "join", code, takeSeat: true });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return { who, playerId: (joined.data as { playerId: string }).playerId };
}

/** A table with a bound host escrow and a seated joiner (not yet linked or funded). */
async function hostOpened(world: MoneyServer) {
  const host = await player(world, "Hana");
  const table = await openMoneyTable(host);
  const hostWallet = testWallet("host");
  const hostKey = testConsentKey("host");
  const linked = await linkWallet(host, table.gameId, hostWallet, hostKey);
  assert.equal(linked.status, 200, linked.text);
  const chainGameId = await hostCreates(world, host, table.gameId, hostWallet, hostKey, linked.body?.ticket as string);
  await world.observe();
  const joiner = await seatJoiner(world, "Jo", table.code);
  return { host, table, hostWallet, hostKey, chainGameId, joiner };
}

/** The seat's grants, oldest first. */
async function grantsOf(world: MoneyServer, gameId: string, playerId: string) {
  return (await world.ledger.snapshot(gameId)).grants.filter((grant) => grant.player_id === playerId).sort((a, b) => a.epoch - b.epoch);
}

async function standingOf(world: MoneyServer, gameId: string, playerId: string) {
  return (await grantsOf(world, gameId, playerId)).filter((grant) => grant.standing);
}

describe("JX-3B / OD-JX3-1: the same wallet proven from another family re-homes the pre-freeze grant", () => {
  test("two families, same wallet: the second family's proof re-homes; the first family's sign-out no longer ends it; the proving family's does", async () => {
    const world = await moneyServer();
    try {
      const { table, joiner } = await hostOpened(world);
      const laptop = firstDevice(world, joiner.who);
      const phone = await linkedDevice(world, joiner.who);
      assert.notEqual(laptop.familyId(), phone.familyId(), "two session families of one principal");
      const w1 = testWallet("jo");
      const first = await laptop.link(table.gameId, w1, testConsentKey("jo-laptop"));
      assert.equal(first.status, 200, first.text);
      assert.equal(first.body?.mode, "issued");
      /* The phone proves the SAME wallet. */
      const again = await phone.link(table.gameId, w1, testConsentKey("jo-phone"));
      assert.equal(again.status, 200, again.text);
      assert.equal(again.body?.mode, "unchanged", "to the player: the same wallet, the same ticket");
      assert.equal(again.body?.rehomed, true);
      assert.equal(again.body?.epoch, (first.body?.epoch as number) + 1, "a new epoch");
      assert.equal(again.body?.ticket, first.body?.ticket, "the same ticket, re-adopted");
      const [old, current] = await grantsOf(world, table.gameId, joiner.playerId);
      assert.equal(old.issued_under.family_id, laptop.familyId(), "the superseded grant keeps the laptop's context (audit)");
      assert.equal(old.revoke_reason, "superseded");
      assert.equal(current.issued_under.family_id, phone.familyId(), "the proving family is the grant's security context");
      assert.equal(current.player_id, joiner.playerId);
      assert.equal(current.wallet, w1.address);
      assert.deepEqual(current.consent_keys, [testConsentKey("jo-laptop").pubkey, testConsentKey("jo-phone").pubkey]);
      assert.ok(
        world.ops.lines.some((line) => line.event === "money.wallet-linked" && line.game_id === table.gameId && line.rehome === true && line.epoch === current.epoch && line.from_epoch === old.epoch),
        "the audit trail names the re-home",
      );
      assert.equal(JSON.stringify(world.ops.lines).includes("sf_"), false, "no family id in the audit trail");
      /* The proving family's own repeat is the ordinary same-context renew: same epoch. */
      const repeat = await phone.link(table.gameId, w1, testConsentKey("jo-phone"));
      assert.equal(repeat.body?.mode, "unchanged");
      assert.equal(repeat.body?.rehomed, undefined);
      assert.equal(repeat.body?.epoch, current.epoch, "same family: no epoch change");
      /* The laptop signs out: the re-homed link still stands. */
      await laptop.signOut();
      await world.observe();
      assert.deepEqual((await standingOf(world, table.gameId, joiner.playerId)).map((grant) => grant.epoch), [current.epoch], "the laptop's sign-out no longer ends the link");
      const phoneClient = await Client.openWithCookie(world.port, phone.cookie, "phone");
      assert.equal(moneyOf(await viewOf(phoneClient, table.gameId)).you?.funding, "linked");
      /* The phone (the proving family) signs out: before the freeze, that ends it. */
      await phone.signOut();
      await world.observe();
      assert.deepEqual(await standingOf(world, table.gameId, joiner.playerId), [], "the proving family's sign-out ends the link");
      const ended = (await grantsOf(world, table.gameId, joiner.playerId)).find((grant) => grant.epoch === current.epoch);
      assert.equal(ended?.revoke_reason, "security-event");
      await phoneClient.close();
    } finally {
      await world.close();
    }
  });

  test("the re-home never bypasses the seat locks: an outstanding admission, a pending deposit and a funded seat refuse; a started table keeps its context", async () => {
    const world = await moneyServer();
    try {
      const { host, table, joiner } = await hostOpened(world);
      const laptop = firstDevice(world, joiner.who);
      const phone = await linkedDevice(world, joiner.who);
      const w1 = testWallet("jo");
      const k1 = testConsentKey("jo");
      const linked = await laptop.link(table.gameId, w1, k1);
      assert.equal(linked.status, 200, linked.text);
      const epoch = linked.body?.epoch as number;
      /* An admission outstanding: refused, nothing written. */
      const admitted = await laptop.api("join-admission", { gameId: table.gameId });
      assert.equal(admitted.status, 200, admitted.text);
      const whileAdmitted = await phone.link(table.gameId, w1, testConsentKey("jo-phone"));
      assert.equal(whileAdmitted.status, 409, whileAdmitted.text);
      assert.equal(whileAdmitted.body?.error, "admission-outstanding");
      /* A deposit hinted: refused. */
      assert.equal((await laptop.api("deposit-sent", { gameId: table.gameId, kind: "join", txHash: "E1".repeat(32), timeoutHeight: "999999" })).status, 202);
      await world.money.idle();
      const whilePending = await phone.link(table.gameId, w1, testConsentKey("jo-phone"));
      assert.equal(whilePending.body?.error, "deposit-pending", whilePending.text);
      /* Funded on chain: refused. */
      const admission = admitted.body?.admission as Record<string, string>;
      assert.ok(world.chain.join(admission.chain_game_id, { wallet: w1.address, consent_pubkey: k1.pubkey, join_ticket: linked.body?.ticket as string }, { expires_at: admission.expires_at, signature: admission.signature }).ok);
      await world.observe();
      const whileFunded = await phone.link(table.gameId, w1, testConsentKey("jo-phone"));
      assert.equal(whileFunded.body?.error, "already-funded", whileFunded.text);
      let grants = await grantsOf(world, table.gameId, joiner.playerId);
      assert.deepEqual(grants.map((grant) => [grant.epoch, grant.issued_under.family_id]), [[epoch, laptop.familyId()]], "no re-home was written");
      /* Started: the roster froze with the laptop's grant; the phone cannot even ask, and nothing un-binds it. */
      assert.equal((await host.client.op({ type: "start-game" }, table.gameId)).ok, true);
      await world.drive(async () => world.server.rooms.moneyPort.recordOf(table.gameId)?.status === "active");
      await phone.confirm();
      const frozen = await phone.api("wallet-challenge", { gameId: table.gameId, wallet: w1.address });
      assert.equal(frozen.status, 409);
      assert.equal(frozen.body?.error, "wrong-state");
      assert.deepEqual(await world.ledger.issue({ binding: { backend: "juno-cosmwasm", chain_id: world.chain.chainId, deployment_id: world.chain.options.contract }, gameId: table.gameId, playerId: joiner.playerId, wallet: w1.address, context: world.identity.securityContextOf(cookieRead(phone.cookie), world.clock.now)!, reauthorized: true, relinkFrom: epoch, rehome: true }), { ok: false, refusal: "frozen" }, "the ledger refuses a frozen re-home too");
      await laptop.signOut();
      grants = await grantsOf(world, table.gameId, joiner.playerId);
      assert.deepEqual(grants.map((grant) => [grant.epoch, grant.issued_under.family_id, grant.standing, grant.frozen_at !== null]), [[epoch, laptop.familyId(), true, true]], "frozen: the laptop's sign-out un-binds nothing");
    } finally {
      await world.close();
    }
  });

  test("two families, different wallets, at once: serialized -- one link and one replace-required; replace supersedes; no seat moves", async () => {
    const world = await moneyServer();
    try {
      const { table, joiner } = await hostOpened(world);
      const laptop = firstDevice(world, joiner.who);
      const phone = await linkedDevice(world, joiner.who);
      const w1 = testWallet("jo-1");
      const w2 = testWallet("jo-2");
      /* Both confirm and hold a challenge; then both links arrive together. */
      await laptop.confirm();
      await phone.confirm();
      const c1 = await laptop.api("wallet-challenge", { gameId: table.gameId, wallet: w1.address });
      const c2 = await phone.api("wallet-challenge", { gameId: table.gameId, wallet: w2.address });
      const s1 = w1.signArbitrary(c1.body?.text as string);
      const s2 = w2.signArbitrary(c2.body?.text as string);
      const [a1, a2] = await Promise.all([
        laptop.api("wallet-link", { gameId: table.gameId, nonce: c1.body?.nonce, pubKey: s1.pubKey, signature: s1.signature, consentKey: testConsentKey("k1").pubkey }),
        phone.api("wallet-link", { gameId: table.gameId, nonce: c2.body?.nonce, pubKey: s2.pubKey, signature: s2.signature, consentKey: testConsentKey("k2").pubkey }),
      ]);
      const answers = [a1, a2].map((answer) => (answer.status === 200 ? `200 ${answer.body?.mode}` : `${answer.status} ${answer.body?.error}`)).sort();
      assert.deepEqual(answers, ["200 issued", "409 replace-required"], `${a1.text} | ${a2.text}`);
      const winner = a1.status === 200 ? { device: laptop, wallet: w1 } : { device: phone, wallet: w2 };
      const loser = a1.status === 200 ? { device: phone, wallet: w2, key: testConsentKey("k2") } : { device: laptop, wallet: w1, key: testConsentKey("k1") };
      let standing = await standingOf(world, table.gameId, joiner.playerId);
      assert.deepEqual(standing.map((grant) => [grant.wallet, grant.issued_under.family_id]), [[winner.wallet.address, winner.device.familyId()]]);
      /* The other device replaces explicitly: a new epoch for ITS wallet, the old one superseded. */
      const replaced = await loser.device.link(table.gameId, loser.wallet, loser.key, true);
      assert.equal(replaced.status, 200, replaced.text);
      assert.equal(replaced.body?.mode, "issued");
      standing = await standingOf(world, table.gameId, joiner.playerId);
      assert.deepEqual(standing.map((grant) => [grant.wallet, grant.issued_under.family_id]), [[loser.wallet.address, loser.device.familyId()]]);
      /* The same wallet from both families at once: one issue (or same-family renew) and one re-home, in some order. */
      const w3 = testWallet("jo-3");
      await laptop.confirm();
      await phone.confirm();
      const d1 = await laptop.api("wallet-challenge", { gameId: table.gameId, wallet: w3.address });
      const d2 = await phone.api("wallet-challenge", { gameId: table.gameId, wallet: w3.address });
      const t1 = w3.signArbitrary(d1.body?.text as string);
      const t2 = w3.signArbitrary(d2.body?.text as string);
      const [b1, b2] = await Promise.all([
        laptop.api("wallet-link", { gameId: table.gameId, nonce: d1.body?.nonce, pubKey: t1.pubKey, signature: t1.signature, consentKey: testConsentKey("k1").pubkey, replace: true }),
        phone.api("wallet-link", { gameId: table.gameId, nonce: d2.body?.nonce, pubKey: t2.pubKey, signature: t2.signature, consentKey: testConsentKey("k2").pubkey, replace: true }),
      ]);
      assert.deepEqual([b1.status, b2.status], [200, 200], `${b1.text} | ${b2.text}`);
      assert.equal(b1.body?.ticket, b2.body?.ticket, "one ticket for the one wallet");
      const last = (b1.body?.epoch as number) > (b2.body?.epoch as number) ? laptop : phone;
      standing = await standingOf(world, table.gameId, joiner.playerId);
      assert.equal(standing.length, 1);
      assert.equal(standing[0].wallet, w3.address);
      assert.equal(standing[0].issued_under.family_id, last.familyId(), "the device whose proof landed last holds the context");
      /* Through all of it: one seat, never moved. */
      const record = world.server.rooms.moneyPort.recordOf(table.gameId)!;
      assert.equal(record.seats.length, 2);
      assert.ok((await grantsOf(world, table.gameId, joiner.playerId)).every((grant) => grant.player_id === joiner.playerId));
      assert.equal((await world.ledger.snapshot(table.gameId)).grants.filter((grant) => grant.player_id !== joiner.playerId).length, 1, "the host's single grant is untouched");
    } finally {
      await world.close();
    }
  });

  test("a link racing the proving family's sign-out: no grant stands under a context that ended before (or after) the commit", async () => {
    const world = await moneyServer();
    try {
      const { table, joiner } = await hostOpened(world);
      const laptop = firstDevice(world, joiner.who);
      const w1 = testWallet("jo");
      const first = await laptop.link(table.gameId, w1, testConsentKey("jo"));
      assert.equal(first.status, 200, first.text);
      for (const order of ["link-first", "revoke-first"] as const) {
        const phone = await linkedDevice(world, joiner.who);
        await phone.confirm();
        const challenge = await phone.api("wallet-challenge", { gameId: table.gameId, wallet: w1.address });
        const signed = w1.signArbitrary(challenge.body?.text as string);
        const link = () => phone.api("wallet-link", { gameId: table.gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: testConsentKey("phone").pubkey });
        const revoke = () => apiRequest(world.port, "/gs/api/session/revoke", { cookie: phone.cookie, body: {} });
        const [linked, revoked] = order === "link-first" ? await Promise.all([link(), revoke()]) : (await Promise.all([revoke(), link()])).reverse();
        assert.equal(revoked.status, 204);
        await world.money.idle();
        const phoneFamily = phone.familyId();
        const standing = await standingOf(world, table.gameId, joiner.playerId);
        assert.equal(standing.some((grant) => grant.issued_under.family_id === phoneFamily), false, `${order}: nothing stands under the ended family (${linked.status} ${linked.text})`);
        if (linked.status === 200) {
          assert.equal(linked.body?.rehomed, true);
          assert.deepEqual(standing, [], `${order}: the re-homed grant ended with its family, and the earlier one was superseded`);
        } else {
          assert.ok([401, 403, 409].includes(linked.status), `${order}: ${linked.status} ${linked.text}`);
        }
        /* Whatever happened, the laptop can always link again. */
        if (standing.length === 0) {
          const again = await laptop.link(table.gameId, w1, testConsentKey("jo"));
          assert.equal(again.status, 200, again.text);
        }
        assert.deepEqual((await standingOf(world, table.gameId, joiner.playerId)).map((grant) => grant.issued_under.family_id), [laptop.familyId()]);
      }
    } finally {
      await world.close();
    }
  });

  test("recovery on a new device, then the same wallet: the grant re-homes to the recovered device's new family", async () => {
    const world = await moneyServer();
    try {
      const { table, joiner } = await hostOpened(world);
      const laptop = firstDevice(world, joiner.who);
      const w1 = testWallet("jo");
      const first = await laptop.link(table.gameId, w1, testConsentKey("jo"));
      assert.equal(first.status, 200, first.text);
      const recovered = await recoveredDevice(world, joiner.who);
      assert.equal(world.identity.peekFamily(recovered.familyId())?.origin, "recovery");
      const relinked = await recovered.link(table.gameId, w1, testConsentKey("jo-recovered"));
      assert.equal(relinked.status, 200, relinked.text);
      assert.deepEqual([relinked.body?.mode, relinked.body?.rehomed, relinked.body?.ticket], ["unchanged", true, first.body?.ticket]);
      const standing = await standingOf(world, table.gameId, joiner.playerId);
      assert.deepEqual(standing.map((grant) => grant.issued_under.family_id), [recovered.familyId()]);
      /* The old device signs out (or is lost): the link stands, and the recovered device's proof feeds the admission. */
      await laptop.signOut();
      assert.equal((await standingOf(world, table.gameId, joiner.playerId)).length, 1);
      const admitted = await recovered.api("join-admission", { gameId: table.gameId });
      assert.equal(admitted.status, 200, admitted.text);
    } finally {
      await world.close();
    }
  });

  test("recovery-key rotation ends the pre-freeze grant, re-homed or not; the new key confirms a fresh link", async () => {
    const world = await moneyServer();
    try {
      const { table, joiner } = await hostOpened(world);
      const laptop = firstDevice(world, joiner.who);
      const phone = await linkedDevice(world, joiner.who);
      const w1 = testWallet("jo");
      assert.equal((await laptop.link(table.gameId, w1, testConsentKey("jo"))).status, 200);
      const rehomed = await phone.link(table.gameId, w1, testConsentKey("jo-phone"));
      assert.equal(rehomed.body?.rehomed, true, rehomed.text);
      /* The phone rotates the recovery key (after Confirm it's you): the selector changes, the grant ends. */
      await phone.confirm();
      const rotated = await apiRequest(world.port, "/gs/api/profile/recovery-key", { cookie: phone.cookie, body: {} });
      assert.equal(rotated.status, 200, rotated.text);
      await world.money.idle();
      assert.deepEqual(await standingOf(world, table.gameId, joiner.playerId), [], "the rotating device's own re-homed grant ends too");
      const ended = (await grantsOf(world, table.gameId, joiner.playerId)).at(-1);
      assert.equal(ended?.revoke_reason, "security-event");
      /* The old key no longer confirms; the new one does, and a fresh link stands. */
      const stale = await apiRequest(world.port, "/gs/api/profile/reauth", { cookie: phone.cookie, body: { recoveryKey: joiner.who.browser.recoveryKey } });
      assert.notEqual(stale.status, 200);
      phone.recoveryKey = rotated.body?.recoveryKey as string;
      const fresh = await phone.link(table.gameId, w1, testConsentKey("jo-phone"));
      assert.equal(fresh.status, 200, fresh.text);
      assert.equal(fresh.body?.mode, "issued", "nothing stood: a fresh ticket (no deposit to re-adopt)");
      assert.deepEqual((await standingOf(world, table.gameId, joiner.playerId)).map((grant) => grant.issued_under.family_id), [phone.familyId()]);
    } finally {
      await world.close();
    }
  });
});

describe("JX-3B: consent from two devices after the signing key moved (the chain-current key is the sole authority)", () => {
  /** A started, dealt table whose escrow holds a stored settlement THIS server signed (as `escrow4Money.test.ts`). */
  async function settleable(world: MoneyServer) {
    const opened = await hostOpened(world);
    const jWallet = testWallet("jo");
    const jKey = testConsentKey("jo");
    const linked = await linkWallet(opened.joiner.who, opened.table.gameId, jWallet, jKey);
    await joinerFunds(world, opened.joiner.who, opened.table.gameId, jWallet, jKey, linked.body?.ticket as string);
    await world.observe();
    assert.equal((await opened.host.client.op({ type: "start-game" }, opened.table.gameId)).ok, true);
    await world.drive(async () => world.server.rooms.moneyPort.recordOf(opened.table.gameId)?.status === "active");
    const fin = await world.financial.load(opened.table.gameId);
    const binding = fin!.binding!.escrow!;
    const game = world.chain.games.get(Number(binding.chain_game_id))!;
    const digest = "7e".repeat(32);
    const seq = "21";
    game.state = "settleable";
    game.settlement = {
      source: "terminal_payload",
      payload: { seq, kind: 1, reason: 1, log_len: "10", log_hash: "11".repeat(32), appraisal_log_len: "10", appraisal_state_hash: "22".repeat(32), state_schema_version: 1, settlement_weights: ["3", "1"], signer_key_id: 1, issued_at: "0", payload_digest: digest },
      accepted_at: world.chain.time,
      window_end: world.chain.time + 3600,
    };
    const { newChainIntent } = await import("./chainIntents");
    const { escrowInstanceKey } = await import("../../../frontend/src/gameEngine/escrow/escrowModel");
    const own = newChainIntent({ game_id: opened.table.gameId, instance: escrowInstanceKey(binding), key: { op: "settle", seq }, subject: { kind: "digest", digests: [] }, op: { kind: "settle", chain_game_id: binding.chain_game_id, seq, log_len: 10, settle_digest: digest, signer_key_id: 1 }, msg_json: "{}", now: world.clock.now });
    await world.intents.create({ ...own, status: "confirmed", confirmation: { how: "chain-state", tx_hash: null, height: null, detail: "test", at: world.clock.now } });
    await world.observe();
    return { ...opened, jWallet, jKey, domain: game.domain as string, seq, digest, chainGameId: binding.chain_game_id };
  }

  test("after the key moves to the phone, the laptop's and the phone's consents arrive together: only the chain-current key is relayed; repeats are idempotent", async () => {
    const world = await moneyServer();
    try {
      const { joiner, jWallet, jKey, table, domain, seq, digest, chainGameId } = await settleable(world);
      const laptop = firstDevice(world, joiner.who);
      const phone = await linkedDevice(world, joiner.who);
      const phoneKey = testConsentKey("jo-phone");
      /* The phone registers its key (Confirm it's you) -- registered is not yet authorized: the chain still names the
         laptop's key. */
      await phone.confirm();
      assert.equal((await phone.api("consent-key", { gameId: table.gameId, pubkey: phoneKey.pubkey })).status, 200);
      const early = await phone.api("consent", { gameId: table.gameId, signature: phoneKey.consent(domain, seq, digest) });
      assert.equal(early.body?.error, "wrong-key", "a registered key the chain does not name is refused");
      /* The wallet moves it on chain. */
      assert.ok(world.chain.setConsentKey(chainGameId, jWallet.address, phoneKey.pubkey).ok);
      await world.observe();
      const [fromLaptop, fromPhone] = await Promise.all([
        laptop.api("consent", { gameId: table.gameId, signature: jKey.consent(domain, seq, digest) }),
        phone.api("consent", { gameId: table.gameId, signature: phoneKey.consent(domain, seq, digest) }),
      ]);
      assert.equal(fromLaptop.status, 409, fromLaptop.text);
      assert.equal(fromLaptop.body?.error, "wrong-key", "the moved-away key no longer authorizes");
      assert.equal(fromPhone.status, 200, fromPhone.text);
      assert.equal(fromPhone.body?.status, "queued");
      /* Repeats: the same (seq, seat, key) is the same work; the old key stays refused. */
      const [laptopAgain, phoneAgain] = await Promise.all([
        laptop.api("consent", { gameId: table.gameId, signature: jKey.consent(domain, seq, digest) }),
        phone.api("consent", { gameId: table.gameId, signature: phoneKey.consent(domain, seq, digest) }),
      ]);
      assert.equal(laptopAgain.body?.error, "wrong-key");
      assert.equal(phoneAgain.status, 200, phoneAgain.text);
      assert.equal(phoneAgain.body?.status, "relayed");
      await world.drive(async () => (world.chain.games.get(Number(chainGameId))!.consent_bitmap & 2) !== 0);
      const consentIntents = (await world.intents.listGame(table.gameId)).filter((intent) => intent.key.op === "relay-consent");
      assert.equal(consentIntents.length, 1, "exactly one consent relayed for the seat");
    } finally {
      await world.close();
    }
  });
});
