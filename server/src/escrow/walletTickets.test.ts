// server/src/escrow/walletTickets.test.ts
//
// ==================================================================
//  ESCROW-3A (brief §9, F-2): WALLET TICKETS FOLLOW THE SEAT'S SECURITY CONTEXT -- AND THERE IS NO REBIND
// ==================================================================
//
// Every ticket here is issued through the real identity service's context and judged by its real standing; the roster
// freeze is GNOLAND-1's own `freezeEscrowRoster` recomputation (`ticketOf`) -- nothing is simulated but the seat check.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { readSessionCookie, type SessionCookieRead } from "../identity/cookies";
import { IdentityService } from "../identity/sessions";
import { createMemoryIdentityStore } from "../identity/store";
import { quietConsole } from "../rooms/testSupport";
import { joinTicketV1 } from "../../../frontend/src/gameEngine/escrow/escrowRoster";
import { createMemoryWalletTicketStore, createWalletTicketLedger, type WalletLinkProof, type WalletTicketContext, type WalletTicketStore } from "./walletTickets";

quietConsole();

const T0 = 1_760_000_000_000;
const MIN = 60_000;
const GAME = "g_0000000000000000000000000w";
const SEAT = "p-0000000000000001";
const BINDING = { backend: "juno-cosmwasm", chain_id: "juno-1", deployment_id: "juno1contract" };
const WALLET = "juno1wallet0000000000000000000000000000000";
const OTHER_WALLET = "juno1wallet1111111111111111111111111111111";

const readOf = (setCookie: string | null): SessionCookieRead => readSessionCookie((setCookie as string).split(";")[0]);
const sessionIdOf = (read: SessionCookieRead) => (read.kind === "session" ? read.sessionId : "");

async function world(options: { readonly store?: WalletTicketStore } = {}) {
  const identity = await IdentityService.open(createMemoryIdentityStore());
  const boot = await identity.bootstrap({ kind: "none" }, false, T0);
  const laptop = readOf((boot as { setCookie: string }).setCookie);
  const created = await identity.createProfile(laptop, "Ann", T0);
  const key = (created as { recoveryKey: string }).recoveryKey;
  const second = await identity.bootstrap({ kind: "none" }, false, T0 + 1);
  const phone = readOf((await identity.recover(readOf((second as { setCookie: string }).setCookie), key, T0 + 1) as { setCookie: string }).setCookie);
  const principalId = identity.securityContextOf(laptop, T0 + 2)!.principalId;
  let seatHolder = principalId;
  const ledger = createWalletTicketLedger({
    store: options.store ?? createMemoryWalletTicketStore(),
    standing: (context) => identity.securityStanding(context),
    holdsSeat: (_game, principal, player) => player === SEAT && principal === seatHolder,
    now: () => T0 + 10 * MIN,
  });
  const issueFrom = async (read: SessionCookieRead, now: number, wallet = WALLET) => {
    const context = identity.securityContextOf(read, now) as WalletTicketContext;
    return ledger.issue({ binding: BINDING, gameId: GAME, playerId: SEAT, wallet, context, reauthorized: identity.hasSensitiveAuth(read, now) });
  };
  return { identity, laptop, phone, key, ledger, issueFrom, setSeatHolder: (p: string) => (seatHolder = p) };
}

describe("ESCROW-3A F-2: one outstanding wallet ticket per seat, ended by every security event", () => {
  test("issuing needs a recent re-authentication of the SAME session: a stolen live session cannot bind a wallet", async () => {
    const w = await world();
    const t = T0 + 2 * 60 * MIN;
    assert.deepEqual(await w.issueFrom(w.phone, t), { ok: false, refusal: "reauth-required" });
    await w.identity.reauthenticate(w.phone, w.key, t);
    const issued = await w.issueFrom(w.phone, t);
    assert.equal(issued.ok, true);
    assert.match((issued as { ticket: string }).ticket, /^[0-9a-f]{64}$/);
    assert.equal(await w.ledger.ticketOf(GAME, SEAT, WALLET), (issued as { ticket: string }).ticket);
    assert.equal(await w.ledger.ticketOf(GAME, SEAT, OTHER_WALLET), "", "bound to its one wallet");
    const lookup = await w.ledger.lookupOf(GAME);
    assert.deepEqual([lookup(SEAT, WALLET), lookup(SEAT, OTHER_WALLET), lookup("p-0000000000000002", WALLET)], [(issued as { ticket: string }).ticket, "", ""], "the freeze's synchronous lookup agrees");
  });

  test("single outstanding: a new issue supersedes the old one (epoch + 1); the old ticket adopts nothing", async () => {
    const w = await world();
    const t = T0 + 2 * 60 * MIN;
    await w.identity.reauthenticate(w.laptop, w.key, t);
    const first = (await w.issueFrom(w.laptop, t)) as { ticket: string; epoch: number };
    const second = (await w.issueFrom(w.laptop, t, OTHER_WALLET)) as { ticket: string; epoch: number };
    assert.deepEqual([first.epoch, second.epoch], [1, 2]);
    assert.equal(await w.ledger.ticketOf(GAME, SEAT, WALLET), "", "the superseded ticket no longer recomputes");
    assert.equal(await w.ledger.ticketOf(GAME, SEAT, OTHER_WALLET), second.ticket);
  });

  test("outstanding ticket + sign out of the issuing device: ended; retried afterwards: adopts nothing", async () => {
    const w = await world();
    const t = T0 + 2 * 60 * MIN;
    await w.identity.reauthenticate(w.phone, w.key, t);
    const issued = (await w.issueFrom(w.phone, t)) as { ticket: string };
    await w.identity.revoke(sessionIdOf(w.phone), "logout", t + 1);
    assert.equal(await w.ledger.ticketOf(GAME, SEAT, WALLET), "");
    assert.notEqual(await w.ledger.ticketOf(GAME, SEAT, WALLET), issued.ticket);
    assert.equal(await w.ledger.revokeForSecurityEvent(GAME), 1, "the ledger records what ended it");
  });

  test("outstanding ticket + sign-out-others from another device: ended", async () => {
    const w = await world();
    const t = T0 + 2 * 60 * MIN;
    await w.identity.reauthenticate(w.phone, w.key, t);
    await w.issueFrom(w.phone, t);
    await w.identity.reauthenticate(w.laptop, w.key, t + 1);
    await w.identity.signOutOthers(w.laptop, t + 1);
    assert.equal(await w.ledger.ticketOf(GAME, SEAT, WALLET), "");
  });

  test("outstanding ticket + recovery-key rotation (by any device): ended -- including the rotating device's own", async () => {
    const w = await world();
    const t = T0 + 2 * 60 * MIN;
    await w.identity.reauthenticate(w.laptop, w.key, t);
    await w.issueFrom(w.laptop, t);
    await w.identity.rotateRecoveryKey(w.laptop, t + 1);
    assert.equal(await w.ledger.ticketOf(GAME, SEAT, WALLET), "");
    // A fresh re-authentication (with the new key) and a fresh ticket stand again.
    assert.deepEqual(await w.issueFrom(w.laptop, t + 2), { ok: false, refusal: "reauth-required" }, "the rotation made the grant stale");
  });

  test("a principal that does not hold the seat cannot be issued a ticket, and a disabled principal's tickets end", async () => {
    const w = await world();
    const t = T0 + 2 * 60 * MIN;
    await w.identity.reauthenticate(w.laptop, w.key, t);
    w.setSeatHolder("pr_someone_else");
    assert.deepEqual(await w.issueFrom(w.laptop, t), { ok: false, refusal: "not-seated" });
    w.setSeatHolder(w.identity.securityContextOf(w.laptop, t)!.principalId);
    await w.issueFrom(w.laptop, t);
    await w.identity.disablePrincipal(w.identity.securityContextOf(w.laptop, t)!.principalId, t + 1);
    assert.equal(await w.ledger.ticketOf(GAME, SEAT, WALLET), "");
  });

  test("FROZEN with the roster: a sign-out after the freeze cannot un-bind a deposit the chain already started with", async () => {
    const w = await world();
    const t = T0 + 2 * 60 * MIN;
    await w.identity.reauthenticate(w.phone, w.key, t);
    const issued = (await w.issueFrom(w.phone, t)) as { ticket: string };
    assert.equal(await w.ledger.freeze(GAME), "committed");
    await w.identity.revoke(sessionIdOf(w.phone), "logout", t + 1);
    assert.equal(await w.ledger.ticketOf(GAME, SEAT, WALLET), issued.ticket, "the frozen claim stands");
    await w.identity.reauthenticate(w.laptop, w.key, t + 2);
    assert.deepEqual(await w.issueFrom(w.laptop, t + 2), { ok: false, refusal: "frozen" }, "no new ticket after the freeze");
  });

  test("a freeze with NO standing ticket still closes issuing (the freeze is the game's fact, not its grants')", async () => {
    const w = await world();
    const t = T0 + 2 * 60 * MIN;
    assert.equal(await w.ledger.freeze(GAME), "committed");
    await w.identity.reauthenticate(w.laptop, w.key, t);
    assert.deepEqual(await w.issueFrom(w.laptop, t), { ok: false, refusal: "frozen" });
    assert.equal(await w.ledger.freeze(GAME), "committed", "a repeated freeze changes nothing");
  });

  test("the ticket is GNOLAND-1's joinTicketV1 (unchanged), over a secret the ledger does not keep", async () => {
    const w = await world();
    const t = T0 + 2 * 60 * MIN;
    await w.identity.reauthenticate(w.laptop, w.key, t);
    const issued = (await w.issueFrom(w.laptop, t)) as { ticket: string };
    const recomputed = joinTicketV1({ ...BINDING, game_id: GAME, player_id: SEAT, wallet: WALLET, secret_hex: "00".repeat(32) });
    assert.notEqual(issued.ticket, recomputed, "a guessed secret recomputes nothing");
    assert.match(issued.ticket, /^[0-9a-f]{64}$/);
  });
});

describe("LIVE-5 L5-2 (F-L5-6): an UNCERTAIN ledger write is never reported committed by the ledger", () => {
  test("issue, freeze, unfreeze, admission and key registration answer the store's `uncertain` as not-committed; the next call re-reads", async () => {
    const memory = createMemoryWalletTicketStore();
    let uncertainNext = 0;
    /* The write LANDS and its answer is lost (the worst case for a caller that would take it as done). */
    const store = {
      ...memory,
      async put(gameId: string, document: Parameters<typeof memory.put>[1], expected: number) {
        const landed = await memory.put(gameId, document, expected);
        if (uncertainNext > 0 && landed === "committed") {
          uncertainNext -= 1;
          return "uncertain" as const;
        }
        return landed;
      },
    };
    const ledger = createWalletTicketLedger({ store, standing: () => ({ kind: "standing" }), holdsSeat: () => true, now: () => T0 });
    const context: WalletTicketContext = { principalId: "pr_uncertainuncertain0001", familyId: "sf_uncertain", recoverySelector: "rk_uncertain" };
    const issue = () => ledger.issue({ binding: BINDING, gameId: GAME, playerId: SEAT, wallet: WALLET, context, reauthorized: true });
    uncertainNext = 1;
    assert.deepEqual(await issue(), { ok: false, refusal: "conflict" }, "an uncertain issue hands out no ticket");
    const reissued = (await issue()) as { ok: true; epoch: number; ticket: string };
    assert.equal(reissued.ok, true, "the next issue re-reads and supersedes whatever landed");
    assert.equal(reissued.epoch, 2, "the uncertain write had landed: its grant is superseded, never reused");
    uncertainNext = 1;
    assert.equal(await ledger.recordAdmission({ gameId: GAME, playerId: SEAT, epoch: 2, wallet: WALLET, ticket: reissued.ticket, expiresAt: 10 }), "uncertain");
    uncertainNext = 1;
    assert.equal(await ledger.registerConsentKey({ gameId: GAME, playerId: SEAT, principalId: context.principalId, pubkey: `02${"ab".repeat(32)}` }), "uncertain");
    uncertainNext = 1;
    assert.equal(await ledger.freeze(GAME, 77), "uncertain");
    assert.equal(await ledger.freeze(GAME, 77), "committed", "a repeat of the same freeze converges on what landed");
    uncertainNext = 1;
    assert.equal(await ledger.unfreeze(GAME, 77), "uncertain");
    assert.equal(await ledger.unfreeze(GAME, 77), "committed", "a repeat of the release converges on what landed");
    assert.equal(await ledger.frozenAt(GAME), null);
  });
});

/* ==================================================================
    JX-3B (owner ruling OD-JX3-1): a same-wallet proof from ANOTHER standing family RE-HOMES the pre-freeze grant
   ================================================================== */

describe("JX-3B OD-JX3-1: the ledger's re-home (issue({ rehome: true }))", () => {
  const proofFor = (label: string, wallet = WALLET): WalletLinkProof => ({
    kind: "adr036",
    wallet,
    pubkey: `02${label.padEnd(64, "0").slice(0, 64)}`,
    challenge_digest: label.padEnd(64, "a").slice(0, 64),
    proof_hash: label.padEnd(64, "b").slice(0, 64),
    verified_at: T0,
  });
  const KEY_A = `02${"a".repeat(64)}`;
  const KEY_B = `03${"b".repeat(64)}`;

  /** Laptop links WALLET (epoch 1); then the phone (another family of the same principal) re-proves it. */
  async function linkedOnLaptop(options: { readonly store?: WalletTicketStore } = {}) {
    const w = await world(options);
    const t = T0 + 2 * 60 * MIN;
    await w.identity.reauthenticate(w.laptop, w.key, t);
    await w.identity.reauthenticate(w.phone, w.key, t);
    const laptopContext = w.identity.securityContextOf(w.laptop, t) as WalletTicketContext;
    const phoneContext = w.identity.securityContextOf(w.phone, t) as WalletTicketContext;
    const first = await w.ledger.issue({ binding: BINDING, gameId: GAME, playerId: SEAT, wallet: WALLET, context: laptopContext, reauthorized: true, proof: proofFor("laptop"), consentKey: KEY_A, createFloor: "7" });
    assert.equal(first.ok, true);
    const rehome = (over: Partial<Parameters<typeof w.ledger.issue>[0]> = {}) =>
      w.ledger.issue({ binding: BINDING, gameId: GAME, playerId: SEAT, wallet: WALLET, context: phoneContext, reauthorized: true, proof: proofFor("phone"), consentKey: KEY_B, relinkFrom: 1, rehome: true, ...over });
    return { ...w, t, laptopContext, phoneContext, first: first as { ok: true; ticket: string; epoch: number }, rehome };
  }

  test("re-home: a new epoch re-adopts the SAME ticket for the SAME seat and wallet, issued under the PROVING family; standing follows it", async () => {
    const w = await linkedOnLaptop();
    const moved = await w.rehome();
    assert.deepEqual(moved, { ok: true, ticket: w.first.ticket, epoch: 2 });
    const { grants } = await w.ledger.snapshot(GAME);
    const [old, current] = grants;
    assert.deepEqual([old.epoch, old.revoke_reason, old.standing, old.issued_under.family_id], [1, "superseded", false, w.laptopContext.familyId], "the earlier grant keeps its context, for audit");
    assert.equal(current.player_id, SEAT, "no seat moved");
    assert.equal(current.wallet, WALLET, "no wallet changed");
    assert.equal(current.ticket, w.first.ticket, "the ticket is re-adopted, never re-minted");
    assert.equal(current.issued_under.family_id, w.phoneContext.familyId, "the proving family is the new security context");
    assert.equal(current.relinked_from, 1);
    assert.equal(current.create_floor, "7", "the adopted ticket's own CreateGame floor");
    assert.equal(current.proof?.challenge_digest, proofFor("phone").challenge_digest, "the fresh proof");
    assert.deepEqual(current.consent_keys, [KEY_A, KEY_B], "the seat's keys are kept and the proving browser's added");
    assert.equal(current.standing, true);
    /* Signing out the EARLIER family no longer ends it ... */
    await w.identity.revoke(sessionIdOf(w.laptop), "logout", w.t + 1);
    assert.equal(await w.ledger.ticketOf(GAME, SEAT, WALLET), w.first.ticket, "the laptop's sign-out does not end the re-homed grant");
    assert.equal(await w.ledger.revokeForSecurityEvent(GAME), 0, "nothing for the hook to end");
    /* ... signing out the PROVING family does. */
    await w.identity.revoke(sessionIdOf(w.phone), "logout", w.t + 2);
    assert.equal(await w.ledger.ticketOf(GAME, SEAT, WALLET), "", "the phone's sign-out ends it");
    assert.equal(await w.ledger.revokeForSecurityEvent(GAME), 1);
  });

  test("re-home refuses anything but the seat's newest standing proven grant of this principal for this wallet", async () => {
    const w = await linkedOnLaptop();
    assert.deepEqual(await w.rehome({ relinkFrom: 9 }), { ok: false, refusal: "relink-mismatch" }, "no such epoch");
    assert.deepEqual(await w.rehome({ wallet: OTHER_WALLET, proof: proofFor("phone", OTHER_WALLET) }), { ok: false, refusal: "relink-mismatch" }, "another wallet is never re-homed (it would be a replace)");
    assert.deepEqual(await w.rehome({ context: { ...w.phoneContext, principalId: "pr_someone-else" } }), { ok: false, refusal: "security-context-ended" }, "another principal's context does not even stand");
    /* An older epoch (not the newest) is refused: the laptop replaces with another wallet, then the phone names epoch 1. */
    const replaced = await w.ledger.issue({ binding: BINDING, gameId: GAME, playerId: SEAT, wallet: OTHER_WALLET, context: w.laptopContext, reauthorized: true, proof: proofFor("laptop2", OTHER_WALLET), consentKey: KEY_A });
    assert.equal(replaced.ok, true);
    assert.deepEqual(await w.rehome(), { ok: false, refusal: "relink-mismatch" }, "only the newest grant re-homes");
    /* A grant without a proof never re-homes. */
    const bare = await linkedOnLaptop();
    const unproven = await bare.ledger.issue({ binding: BINDING, gameId: GAME, playerId: SEAT, wallet: WALLET, context: bare.laptopContext, reauthorized: true });
    assert.equal((unproven as { epoch: number }).epoch, 2);
    assert.deepEqual(await bare.rehome({ relinkFrom: 2 }), { ok: false, refusal: "relink-mismatch" });
    assert.deepEqual(await bare.rehome({ reauthorized: false }), { ok: false, refusal: "reauth-required" }, "the proving session's Confirm it's you is required");
  });

  test("re-home never happens frozen, with an admission outstanding, or for a grant that stopped standing", async () => {
    /* Frozen: the frozen grant keeps its context forever. */
    const frozen = await linkedOnLaptop();
    assert.equal(await frozen.ledger.freeze(GAME, T0 + 5 * MIN), "committed");
    assert.deepEqual(await frozen.rehome(), { ok: false, refusal: "frozen" });
    await frozen.identity.revoke(sessionIdOf(frozen.laptop), "logout", frozen.t + 1);
    assert.equal(await frozen.ledger.ticketOf(GAME, SEAT, WALLET), frozen.first.ticket, "frozen semantics unchanged: a sign-out un-binds nothing");
    /* An admission outstanding on the seat: no re-home (it would carry the admission forward). */
    const admitted = await linkedOnLaptop();
    const nowSecs = Math.floor((T0 + 10 * MIN) / 1000);
    assert.equal(await admitted.ledger.recordAdmission({ gameId: GAME, playerId: SEAT, epoch: 1, wallet: WALLET, ticket: admitted.first.ticket, expiresAt: nowSecs + 600 }), "committed");
    assert.deepEqual(await admitted.rehome(), { ok: false, refusal: "admission-outstanding" });
    assert.equal((await admitted.ledger.snapshot(GAME)).grants.length, 1, "nothing written");
    /* The earlier family ended before the re-home: not re-homed ("try again" -- the next link is decided afresh). */
    const ended = await linkedOnLaptop();
    await ended.identity.revoke(sessionIdOf(ended.laptop), "logout", ended.t + 1);
    assert.deepEqual(await ended.rehome(), { ok: false, refusal: "conflict" });
  });

  test("a re-home racing a sign-out of the PROVING family: the grant written never stands under the ended context", async () => {
    /* The proving device is signed out between the ledger's checks and its CAS write (the write still lands). */
    const memory = createMemoryWalletTicketStore();
    let onPut: (() => Promise<void>) | null = null;
    const racing: WalletTicketStore = {
      load: (gameId) => memory.load(gameId),
      put: async (gameId, document, expected) => {
        const hook = onPut;
        onPut = null;
        if (hook !== null) await hook();
        return memory.put(gameId, document, expected);
      },
      listGames: () => memory.listGames!(),
    };
    const w = await linkedOnLaptop({ store: racing });
    onPut = async () => void (await w.identity.revoke(sessionIdOf(w.phone), "logout", w.t + 1));
    const moved = await w.rehome();
    assert.equal(moved.ok, true, "the write committed after the sign-out");
    const { grants } = await w.ledger.snapshot(GAME);
    assert.equal(grants.some((grant) => grant.standing), false, "no grant stands: the re-homed one's context ended, the old one is superseded");
    assert.equal(await w.ledger.ticketOf(GAME, SEAT, WALLET), "", "the freeze would adopt nothing");
    assert.equal(await w.ledger.revokeForSecurityEvent(GAME), 1, "the hook records it");
  });
});
