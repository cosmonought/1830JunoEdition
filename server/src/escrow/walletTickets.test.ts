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
import { createMemoryWalletTicketStore, createWalletTicketLedger, type WalletTicketContext } from "./walletTickets";

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

async function world() {
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
    store: createMemoryWalletTicketStore(),
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
