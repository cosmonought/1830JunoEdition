// frontend/src/money/moneyActions.ts
//
// ==================================================================
//  ESCROW-4: WHAT EACH MONEY BUTTON DOES -- IN ORDER, WITH THE CHECKS FIRST AND THE RECORD BEFORE THE BROADCAST
// ==================================================================
//
// Every flow here resolves to one `ActionOutcome` (never a rejection) and follows the same order:
//
//   1. the build's pin, and the table checked against it (`walletChecks.tableSigningProblem`);
//   2. Keplr on the right account (re-read now, not remembered);
//   3. the deployment verified from the chain itself (chain id, contract code checksum) -- once per page;
//   4. the server's part (a challenge, an admission) checked field by field by THIS browser;
//   5. the message built HERE from neutral fields (`walletChecks.ts`); Keplr signs it;
//   6. the signed bytes and their hash KEPT (`pendingTx.ts`) -- if this browser can't keep them, nothing is sent;
//   7. broadcast; the outcome recorded; the server hinted (`deposit-sent`, a hint only).
//
// A deposit also needs this browser to hold a signing key the seat registered: if it doesn't (the wallet was linked
// on another device), a new one is made and STORED first, then registered ("Confirm it's you"), then carried by the
// deposit. Nothing is ever retried behind the player's back: a refusal is a sentence and, where one exists, the
// step that fixes it (`needs`).

import { APP_NAME } from "../config";
import type { GameVariants } from "../gameEngine/gameVariants";
import { annulDigestV1, consentDigestV1, settleDigestV1, settlementPayloadFromWire } from "../gameEngine/settlementPayload";
import { logHash, type HashableLogEntry } from "../gameEngine/logHash";
import { terminalStateHashV1 } from "../gameEngine/settlementDigest";
import { payoutPreview } from "../gameEngine/settlementPreview";
import type { GameStateResponse } from "../gameEngine/gameState";
import { sha256Hex } from "../gameEngine/sha256";
import { formatAmount, type MoneyDepositEntry, type RoomMoneyView } from "../utils/moneyProtocol";
import { sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import type { PinnedEscrowDeployment } from "./escrowDeployment";
import { txBytesToBase64 } from "./keplrWallet";
import {
  depositSent,
  escrowDetails,
  joinAdmission,
  registerConsentKey,
  relayConsent,
  signingKeyChallenge,
  submitAnnul,
  walletChallenge,
  walletLink,
  type MoneyFailure,
} from "./moneyApi";
import { ANTE_STATUS, linkRequestEndedSentence, type DisputeRead } from "./moneyFlow";
import { bumpLocal, moneyServices, moneySession, recordProofRenewed, updateMoneySession, type MoneyServices } from "./moneySession";
import type { PendingWalletTx } from "./pendingTx";
import { browserSameWalletAcks, SAME_WALLET_SENTENCE, sameWalletAccountKey } from "./sameWalletAck";
import { checkTerminalSettlement, type SealedReplay } from "./settlementCheck";
import {
  admissionProblem,
  cancelMessage,
  chainGameProblemForJoin,
  challengeMessage,
  challengeProblem,
  checkLinkChallenge,
  checkSigningKeyChallenge,
  createGameMessage,
  deadlineChoiceFor,
  finalizeMessage,
  joinMessage,
  livenessSettleMessage,
  requestReviewMessage,
  setConsentKeyMessage,
  tableSigningProblem,
  withdrawMessage,
  type ChainGameFacts,
  type TableDeadline,
  type WalletMessage,
} from "./walletChecks";
import { remedyApproveDigestV1, type RemedyKindByte } from "../gameEngine/escrow/junoRemedyV1";
import type { ClockOverdueView } from "../utils/clockProtocol";

/** The step a refusal asks for before the action can run again. W2-M adds `reprove`: the server refused a deposit's
 *  approval for want of a fresh wallet proof (AUD-20.02). */
export type OutcomeNeeds = "connect" | "replace" | "reprove" | "same-wallet";

export type ActionOutcome =
  | { readonly ok: true; readonly notice?: string }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly needs?: OutcomeNeeds;
      readonly replace?: { readonly from: string; readonly to: string };
      /** Owner ruling 2026-10-07 (`needs: "same-wallet"`): the wallet about to be bound is the account's Authorization
       *  Wallet. Nothing was signed or linked; the panel warns once and the player may continue. */
      readonly sameWallet?: { readonly wallet: string };
    };

const done = (notice?: string): ActionOutcome => ({ ok: true, ...(notice !== undefined ? { notice } : {}) });
const refuse = (reason: string, needs?: OutcomeNeeds): ActionOutcome => ({ ok: false, reason, ...(needs !== undefined ? { needs } : {}) });

/** A failure from the money routes, as an outcome: the server's own sentence; the free re-proof when a deposit's
 *  approval needs a fresh proof. PHASE 4 (owner): normal play never asks for the account password -- no money route
 *  answers "Confirm it's you" any more (a wallet's own Keplr signature is the authority), so nothing here offers it. */
function fromApi(failure: MoneyFailure, services?: MoneyServices): ActionOutcome {
  void services;
  if (failure.code === "replace-required") return refuse(failure.reason, "replace");
  /* `link-first` answers a join approval whose seat has no usable proof (missing or older than the server accepts) or
     ticket: the cure for every one is the same free re-proof of the linked wallet. */
  if (failure.code === "link-first") return refuse(failure.reason, "reprove");
  return refuse(failure.reason);
}

/** What every table-bound flow reads (the newest view, the table's own variants, who this seat is). */
export interface TableContext {
  readonly gameId: string;
  readonly view: RoomMoneyView;
  readonly variants: GameVariants;
  readonly isHost: boolean;
  /** Phase 3 final clocks: the table's deadline as the server's clock records it (what a deposit funds the escrow
   *  under), and whether THIS seat acknowledged a No-deadline table's disclosure. `null`/absent: not known (an Async
   *  table's deposit is then refused -- nothing is signed under a deadline this page cannot show). */
  readonly deadline?: TableDeadline | null;
  readonly port?: SessionPort;
  readonly services?: MoneyServices;
  /** This page's origin (the challenge's `Site:`); `window.location.origin` when absent. */
  readonly site?: string;
  /** PHASE 3 CLOSURE (the host ante race): the NEWEST view of this table as the server pushes it (null: not known). */
  readonly latest?: () => RoomMoneyView | null;
}

function pinOf(services: MoneyServices): { ok: true; pin: PinnedEscrowDeployment } | { ok: false; outcome: ActionOutcome } {
  const pinned = services.pin();
  return pinned.ok ? { ok: true, pin: pinned.pin } : { ok: false, outcome: refuse(pinned.reason) };
}

/* ==================================================================
    CONNECT, CONFIRM
   ================================================================== */

export async function connectWallet(services: MoneyServices = moneyServices()): Promise<ActionOutcome> {
  const pinned = pinOf(services);
  if (!pinned.ok) return pinned.outcome;
  if (!(await services.wallet.ready())) {
    updateMoneySession({ wallet: "unavailable", address: null });
    return refuse("Keplr isn't available in this browser. You can keep playing here; deposits need Keplr (the desktop extension or the Keplr app's browser).");
  }
  updateMoneySession({ wallet: "connecting" });
  const connected = await services.wallet.connect(pinned.pin);
  if (!connected.ok) {
    updateMoneySession({ wallet: connected.code === "not-installed" ? "unavailable" : "disconnected", address: null });
    return refuse(connected.reason);
  }
  updateMoneySession({ wallet: "connected", address: connected.value.address });
  return done();
}

/** The Keplr account now, re-read (and the session told), or the reason there isn't one. */
async function currentAccount(services: MoneyServices, pin: PinnedEscrowDeployment): Promise<{ ok: true; address: string } | { ok: false; outcome: ActionOutcome }> {
  const account = await services.wallet.account(pin);
  if (!account.ok) {
    updateMoneySession({ wallet: account.code === "not-installed" ? "unavailable" : "disconnected", address: null });
    return { ok: false, outcome: refuse(account.code === "not-installed" ? account.reason : "Connect Keplr first.", account.code === "not-installed" ? undefined : "connect") };
  }
  updateMoneySession({ wallet: "connected", address: account.value.address });
  return { ok: true, address: account.value.address };
}

/* ==================================================================
    SIGNING KEYS
   ================================================================== */

/** PHASE 4: put `pubkey` (a key this browser made and stored) on the seat, authorized by the seat's OWN wallet signing
 *  the server's single-use signing-key text in Keplr -- one Keplr approval, never a password. The text is checked
 *  before Keplr is asked (this site, network, contract, table, seat, the seat's wallet and exactly this key). Null when
 *  registered; the outcome to show otherwise. */
async function registerKeyWithWallet(ctx: TableContext, services: MoneyServices, pin: PinnedEscrowDeployment, playerId: string, pubkey: string): Promise<ActionOutcome | null> {
  const challenge = await signingKeyChallenge(ctx.gameId, pubkey, ctx.port);
  if (!challenge.ok) return fromApi(challenge, services);
  const wallet = challenge.value.wallet;
  const site = ctx.site ?? (typeof window === "undefined" ? "" : window.location.origin);
  const checked = checkSigningKeyChallenge(challenge.value.text, { appName: APP_NAME, site, pin, gameId: ctx.gameId, playerId, wallet, signingKey: pubkey, now: services.now() });
  if (!checked.ok) return refuse(checked.reason);
  const account = await currentAccount(services, pin);
  if (!account.ok) return account.outcome;
  if (account.address !== wallet) return refuse(`Switch Keplr to ${wallet} -- your seat's wallet -- so it can approve this device's signing key. Nothing was signed.`, "connect");
  const signed = await services.wallet.signLink(pin, wallet, challenge.value.text);
  if (!signed.ok) return refuse(signed.code === "rejected" ? "You declined in Keplr, so this device's signing key wasn't approved. Nothing moved." : signed.reason, signed.code === "wrong-account" ? "connect" : undefined);
  const registered = await registerConsentKey(ctx.gameId, pubkey, ctx.port, { nonce: challenge.value.nonce, pubKey: signed.value.pubKey, signature: signed.value.signature });
  if (!registered.ok) return fromApi(registered, services);
  return null;
}

/** A signing key this browser holds AND the seat registered -- made, stored and registered now if needed (PHASE 4: the
 *  seat's wallet approves it in Keplr; no password). */
async function registeredLocalKey(ctx: TableContext, services: MoneyServices, pin: PinnedEscrowDeployment, wallet: string): Promise<{ ok: true; pubkey: string } | { ok: false; outcome: ActionOutcome }> {
  const you = ctx.view.you;
  if (you === null) return { ok: false, outcome: refuse("You don't have a seat at this table.") };
  const registered = new Set(you.link?.consentKeys ?? []);
  for (const record of await services.keys.forSeat(ctx.gameId, you.playerId)) {
    if (registered.has(record.pubkey)) return { ok: true, pubkey: record.pubkey };
  }
  /* None here: make one (stored before anything carries it), then register it -- the seat's wallet approves it. */
  const made = await services.keys.create({ chainId: pin.chainId, contract: pin.contract, gameId: ctx.gameId, playerId: you.playerId, wallet });
  bumpLocal();
  if (!made.ok) return { ok: false, outcome: refuse(made.reason) };
  const refused = await registerKeyWithWallet(ctx, services, pin, you.playerId, made.pubkey);
  if (refused !== null) return { ok: false, outcome: refused };
  return { ok: true, pubkey: made.pubkey };
}

/* ==================================================================
    LINK (and relink)
   ================================================================== */

export interface LinkOptions {
  /** Replace the seat's standing link with this wallet (asked of the player BEFORE this runs: W2-M, AUD-20.03). */
  readonly replace?: boolean;
  /** The wallet the player chose (a replacement's, or the linked one being re-proven): if Keplr is on another account
   *  now, nothing is asked of Keplr and nothing is linked (W2-M). */
  readonly expectWallet?: string;
  /** This is the free re-proof of the seat's linked wallet (W2-M, AUD-20.02): say so when it lands. */
  readonly reprove?: boolean;
  /** With `replace`: the linked wallet the player agreed to replace (W2-M, AUD-20.14). If the seat's standing link is
   *  no longer that wallet -- by the server's challenge answer, or by the view from a server that doesn't say -- nothing
   *  is signed and the player is asked again. */
  readonly expectReplaces?: string;
  /** P3-ACCT: told the server's link answer (its wallet and ticket) when a link is accepted -- the Ante waits for the
   *  view to show THAT link before it builds a deposit on it. */
  readonly onLinked?: (linked: { readonly wallet: string; readonly ticket: string; readonly epoch: number; readonly consentKey: string }) => void;
}

/** Link the Keplr account to this seat: challenge -> this browser reads it -> Keplr signs it (ADR-036) -> link. */
export async function linkWallet(ctx: TableContext, options: LinkOptions = {}): Promise<ActionOutcome> {
  const services = ctx.services ?? moneyServices();
  const pinned = pinOf(services);
  if (!pinned.ok) return pinned.outcome;
  const pin = pinned.pin;
  const you = ctx.view.you;
  if (you === null) return refuse("You don't have a seat at this table.");
  const table = tableSigningProblem(pin, ctx.view);
  if (table !== null) return refuse(table);
  const account = await currentAccount(services, pin);
  if (!account.ok) return account.outcome;
  const wallet = account.address;
  if (options.expectWallet !== undefined && wallet !== options.expectWallet) {
    return refuse(`Keplr is on ${wallet} now, not ${options.expectWallet}. Nothing was signed or linked; switch accounts in Keplr and press the button again.`);
  }
  const challenge = await walletChallenge(ctx.gameId, wallet, ctx.port);
  if (!challenge.ok) return fromApi(challenge, services);
  /* W2-M (AUD-20.14): the server says, before Keplr signs, which wallet this link would replace. Unasked, the player
     is asked first (nothing signed; this unspent challenge is simply superseded by the next one). Asked, the wallet
     named in the question must still be the one standing. A server that doesn't say leaves the view's link as the
     check and its own `replace-required` as the answer. */
  const standing = challenge.value.replaces;
  if (options.replace === true) {
    if (options.expectReplaces !== undefined && (standing !== undefined ? standing : (you.link?.wallet ?? null)) !== options.expectReplaces) {
      return refuse("This seat's linked wallet changed since you were asked, so nothing was signed. Look at it again before replacing it.");
    }
    /* Asked without a named wallet (the server's own question after a signature): now that the server names the
       standing wallet, ask about THAT one before signing, rather than replace a wallet the player wasn't shown. */
    if (options.expectReplaces === undefined && typeof standing === "string" && standing !== wallet) {
      return { ok: false, reason: `This seat is linked to ${standing}. Replace it with ${wallet}?`, needs: "replace", replace: { from: standing, to: wallet } };
    }
  } else if (standing !== undefined && standing !== null && standing !== wallet) {
    return { ok: false, reason: `This seat is linked to ${standing}. Replace it with ${wallet}?`, needs: "replace", replace: { from: standing, to: wallet } };
  }
  /* OWNER RULING (2026-10-07): the account's Authorization Wallet MAY also be this table's financial wallet. It is here
     only because the player chose it -- it is the wallet Keplr is on now; nothing selects it for them. Before that same
     address is FIRST bound to a seat, the server's word (`authorizationWallet`) has the panel warn once per account and
     Authorization Wallet (`sameWalletAck.ts`) -- recommending a separate wallet, refusing nothing. Nothing is signed or
     linked until the player continues. A re-proof, the relink of its own deposit and a wallet this seat already holds
     are not a first binding. The roles stay apart: the link binds THIS seat's money only; the account is unchanged. */
  const alreadyBound = you.link?.wallet === wallet || you.payoutWallet === wallet || you.unlinkedDeposit?.wallet === wallet;
  if (challenge.value.authorizationWallet === true && options.reprove !== true && !alreadyBound) {
    const acks = services.sameWalletAcks ?? browserSameWalletAcks();
    if (!acks.has(sameWalletAccountKey((ctx.port ?? sessionPort()).account?.username), wallet)) {
      return { ok: false, reason: SAME_WALLET_SENTENCE, needs: "same-wallet", sameWallet: { wallet } };
    }
  }
  const site = ctx.site ?? (typeof window === "undefined" ? "" : window.location.origin);
  const checked = checkLinkChallenge(challenge.value.text, { appName: APP_NAME, site, pin, gameId: ctx.gameId, playerId: you.playerId, wallet, now: services.now() });
  if (!checked.ok) return refuse(checked.reason);
  const signed = await services.wallet.signLink(pin, wallet, challenge.value.text);
  if (!signed.ok) return refuse(signed.reason, signed.code === "wrong-account" ? "connect" : undefined);
  /* The signing key the deposit will carry: made and STORED here before the link names it. */
  const existing = (await services.keys.forSeat(ctx.gameId, you.playerId)).find((record) => record.wallet === wallet);
  let consentKey = existing?.pubkey ?? null;
  if (consentKey === null) {
    const made = await services.keys.create({ chainId: pin.chainId, contract: pin.contract, gameId: ctx.gameId, playerId: you.playerId, wallet });
    bumpLocal();
    if (!made.ok) return refuse(made.reason);
    consentKey = made.pubkey;
  }
  /* The proof the server records is verified after this instant: a conservative "proven at" for this page. */
  const sentAt = services.now();
  const linked = await walletLink({ gameId: ctx.gameId, nonce: challenge.value.nonce, pubKey: signed.value.pubKey, signature: signed.value.signature, consentKey, ...(options.replace === true ? { replace: true } : {}) }, ctx.port);
  if (!linked.ok) {
    /* W2-M (AUD-20.04): the server no longer holds the request -- say whether it expired or was dropped. */
    if (linked.code === "challenge-expired") return refuse(linkRequestEndedSentence(checked.value.expiresAt, services.now()));
    return fromApi(linked, services);
  }
  /* Every accepted link (issued, relinked, or the same wallet again) carries a proof the server verified just now. */
  recordProofRenewed(ctx.gameId, you.playerId, linked.value.wallet, sentAt);
  options.onLinked?.({ wallet: linked.value.wallet, ticket: linked.value.ticket, epoch: linked.value.epoch, consentKey });
  if (linked.value.mode === "unchanged") return done(options.reprove === true ? "Wallet proof renewed: you can deposit now. Nothing was charged." : "That wallet is already linked to your seat.");
  return done(linked.value.mode === "relinked" ? "Your deposit is linked to your seat again. Nothing was charged." : `Wallet linked: ${linked.value.wallet}.`);
}

/** W2-M (AUD-20.03, JX-3A E-2): "Change wallet", BEFORE anything is signed. Keplr's account is read now (no prompt):
 *  the seat's own linked wallet is not a change (nothing is asked of Keplr); any other is what the player is asked
 *  to confirm replacing it with -- and only then does Keplr sign, once, with the replacement stated up front. */
export async function prepareReplace(ctx: TableContext): Promise<{ readonly ok: true; readonly from: string; readonly to: string } | { readonly ok: false; readonly outcome: ActionOutcome }> {
  const services = ctx.services ?? moneyServices();
  const pinned = pinOf(services);
  if (!pinned.ok) return { ok: false, outcome: pinned.outcome };
  const from = ctx.view.you?.link?.wallet ?? null;
  if (from === null) return { ok: false, outcome: refuse("This seat has no linked wallet to change.") };
  const account = await currentAccount(services, pinned.pin);
  if (!account.ok) return account;
  if (account.address === from) {
    return { ok: false, outcome: refuse(`Keplr is on the wallet already linked to this seat (${from}). To use another wallet, switch accounts in Keplr first, then press Change wallet.`) };
  }
  return { ok: true, from, to: account.address };
}

/* ==================================================================
    SIGN, KEEP, SEND
   ================================================================== */

export interface SendTarget {
  readonly gameId: string;
  readonly playerId: string;
  /** The wallet that must send it (Keplr must be on this account). */
  readonly wallet: string;
}

/** Keplr signs `message`; the signed bytes are KEPT before they are broadcast; the server is hinted. */
export async function signKeepSend(
  services: MoneyServices,
  pin: PinnedEscrowDeployment,
  target: SendTarget,
  message: WalletMessage,
  port?: SessionPort,
  /** Asked AFTER Keplr signs and BEFORE anything is kept or sent: a sentence when the signed transaction no longer fits
   *  the table (it is then dropped unsent -- it cannot land), or null. */
  stillValid?: () => string | null,
): Promise<ActionOutcome> {
  const account = await currentAccount(services, pin);
  if (!account.ok) return account.outcome;
  if (account.address !== target.wallet) return refuse(`Switch Keplr to ${target.wallet} to sign this action. (Keplr is on ${account.address}.)`);
  const deployment = await services.wallet.verifyDeployment(pin);
  if (!deployment.ok) return refuse(deployment.reason);
  /* Single flight: a transaction of this wallet on this table that may still land blocks another of the same kind
     (and any second deposit) until the chain answers. */
  const deposit = (kind: string) => kind === "create" || kind === "join";
  const inFlight = services.pending.all().find((record) => record.gameId === target.gameId && record.sender === target.wallet && (record.kind === message.hint || (deposit(record.kind) && deposit(message.hint))));
  if (inFlight !== undefined) return refuse("A transaction for this is already on its way to Juno. Wait for Juno's answer (the panel says when), and don't send it again.");
  const signed = await services.wallet.signTx(pin, target.wallet, message, `${APP_NAME}: ${message.hint}`);
  if (!signed.ok) return refuse(signed.reason, signed.code === "wrong-account" ? "connect" : undefined);
  const stale = stillValid?.() ?? null;
  if (stale !== null) return refuse(stale);
  const record: PendingWalletTx = {
    v: 1,
    gameId: target.gameId,
    playerId: target.playerId,
    kind: message.hint,
    chainId: pin.chainId,
    contract: pin.contract,
    sender: target.wallet,
    chainGameId: message.chainGameId,
    txHash: signed.value.txHash,
    txBytes: txBytesToBase64(signed.value.txBytes),
    timeoutHeight: signed.value.timeoutHeight.toString(),
    createdAt: services.now(),
    stage: "signed",
    consentKey: message.consentKey,
  };
  if (!services.pending.put(record)) {
    return refuse("This browser couldn't keep a record of the signed transaction, so it wasn't sent (nothing moved). Allow this site's storage, then try again.");
  }
  bumpLocal();
  return broadcastKept(services, pin, record, signed.value.txBytes, port);
}

/** Broadcast kept bytes (the first time, or again after a reload); record what the network said; hint the server. */
async function broadcastKept(services: MoneyServices, pin: PinnedEscrowDeployment, record: PendingWalletTx, bytes: Uint8Array, port?: SessionPort): Promise<ActionOutcome> {
  const outcome = await services.wallet.broadcast(pin, bytes);
  if (outcome.kind === "refused") {
    services.pending.remove(record.txHash);
    bumpLocal();
    return refuse(`Juno refused the transaction, so nothing moved: ${outcome.reason}`);
  }
  services.pending.markSent(record.txHash);
  bumpLocal();
  /* A hint: the server looks sooner. Its answer changes nothing here (the chain decides). */
  void depositSent(record.gameId, record.kind, record.txHash, record.chainGameId, port, record.timeoutHeight);
  return done(outcome.kind === "accepted" ? "Sent — waiting for Juno." : "Sent, but Juno's answer didn't arrive. We keep checking; don't send it again.");
}

/** Re-send a kept transaction's SAME bytes (it can land only once). */
export async function resendPending(record: PendingWalletTx, services: MoneyServices = moneyServices(), port?: SessionPort): Promise<ActionOutcome> {
  const pinned = pinOf(services);
  if (!pinned.ok) return pinned.outcome;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(record.txBytes), (ch) => ch.charCodeAt(0));
  } catch {
    services.pending.remove(record.txHash);
    bumpLocal();
    return refuse("The kept transaction couldn't be read, so it was dropped. Nothing moved from this browser; check the table's state.");
  }
  return broadcastKept(services, pinned.pin, record, bytes, port);
}

/** How long a deposit Juno included is kept waiting for its table to show it, before this browser stops waiting. */
export const LANDED_WAIT_MS = 30 * 60 * 1000;

const isDeposit = (kind: string): boolean => kind === "create" || kind === "join";

/** What the chain says about this browser's kept transactions: an included deposit is kept as `landed` until the
 *  table's view shows it (`settleLandedDeposits`); any other included or an expired one is dropped (the server's view
 *  says what it did); a pending one is kept, its hint re-sent. Returns a notice, or null. */
export async function reconcilePending(gameId: string | null, services: MoneyServices = moneyServices(), port?: SessionPort): Promise<string | null> {
  const pinned = services.pin();
  if (!pinned.ok) return null;
  let notice: string | null = null;
  for (const record of services.pending.all().filter((entry) => gameId === null || entry.gameId === gameId)) {
    if (record.stage === "landed") {
      if (services.now() - record.createdAt > LANDED_WAIT_MS) {
        services.pending.remove(record.txHash);
        notice = `Juno included your ${record.kind === "create" ? "table-opening deposit" : "deposit"}, but the table hasn't shown it. Check "Your deposits" in the lobby: the deposit is yours to withdraw.`;
      }
      continue;
    }
    const status = await services.wallet.txStatus(pinned.pin, record.txHash, record.timeoutHeight);
    if (status.kind === "included") {
      if (status.ok && isDeposit(record.kind)) services.pending.markLanded(record.txHash);
      else services.pending.remove(record.txHash);
      if (!status.ok) notice = `Juno included your ${record.kind} transaction but it failed${status.log === null ? "" : ` (${status.log.slice(0, 120)})`}. Only the network fee was spent.`;
    } else if (status.kind === "expired") {
      services.pending.remove(record.txHash);
      notice = `Your ${record.kind} transaction wasn't included before its deadline, so it can never land. Nothing moved.`;
    } else if (status.kind === "pending" && record.stage === "sent") {
      void depositSent(record.gameId, record.kind, record.txHash, record.chainGameId, port, record.timeoutHeight);
    }
  }
  bumpLocal();
  return notice;
}

/** A landed deposit's record is done once the table's view shows the deposit (funded, or not linked), the escrow was
 *  cancelled, or this browser no longer has a seat there. */
export function settleLandedDeposits(gameId: string, view: RoomMoneyView | null, services: MoneyServices = moneyServices()): boolean {
  if (view === null) return false;
  let changed = false;
  for (const record of services.pending.all()) {
    if (record.gameId !== gameId || record.stage !== "landed") continue;
    const you = view.you;
    const shown = you === null || you.playerId !== record.playerId || you.funding === "funded" || you.funding === "unlinked" || view.escrow.state === "CANCELLED" || view.start.state === "started";
    if (shown) {
      services.pending.remove(record.txHash);
      changed = true;
    }
  }
  return changed;
}

/* ==================================================================
    DEPOSIT (the host's CreateGame, a joiner's Join)
   ================================================================== */

export async function approveDeposit(ctx: TableContext): Promise<ActionOutcome> {
  const services = ctx.services ?? moneyServices();
  const pinned = pinOf(services);
  if (!pinned.ok) return pinned.outcome;
  const pin = pinned.pin;
  const view = ctx.view;
  const you = view.you;
  if (you === null || you.link === null) return refuse("Link your wallet to this seat first.");
  const table = tableSigningProblem(pin, view);
  if (table !== null) return refuse(table);
  /* Single flight, BEFORE asking for anything: a deposit of this seat that may still land means no second one (and no
     new admission, which would lock the seat again for its lifetime). */
  const linkWallet_ = you.link.wallet;
  const inFlight = services.pending.all().find((record) => record.gameId === ctx.gameId && (record.kind === "create" || record.kind === "join") && (record.sender === linkWallet_ || record.playerId === you.playerId));
  if (inFlight !== undefined) {
    return refuse(inFlight.stage === "landed" ? "Juno included this seat's deposit; the table shows it in a moment. Don't send another." : "A deposit for this seat is already on its way to Juno. Wait for Juno's answer (the panel says when), and don't send it again.");
  }
  const account = await currentAccount(services, pin);
  if (!account.ok) return account.outcome;
  if (account.address !== you.link.wallet) return refuse(`Switch Keplr to ${you.link.wallet} to sign this action. (Keplr is on ${account.address}; this seat is linked to ${you.link.wallet}.)`, "connect");
  const deployment = await services.wallet.verifyDeployment(pin);
  if (!deployment.ok) return refuse(deployment.reason);
  const key = await registeredLocalKey(ctx, services, pin, you.link.wallet);
  if (!key.ok) return key.outcome;
  const target: SendTarget = { gameId: ctx.gameId, playerId: you.playerId, wallet: you.link.wallet };
  if (ctx.isHost) {
    const config = await services.wallet.chainConfig(pin);
    if (!config.ok) return refuse(config.reason);
    if (config.value.paused) return refuse("Juno's escrow is paused right now, so a table can't open on it. Try again later.");
    if (config.value.minAnte !== null && BigInt(view.terms.anteGross) < BigInt(config.value.minAnte)) return refuse("This table's stake is below what Juno's escrow accepts, so nothing was sent.");
    const message = createGameMessage(pin, view, ctx.variants, key.pubkey, ctx.deadline ?? null);
    if (!message.ok) return refuse(message.reason);
    /* PHASE 3 CLOSURE (the host ante race, set-ante): Keplr may stay open for minutes. If the table's ante changed
       meanwhile (the host's other device), or the table was opened on Juno, the CreateGame just signed would open an
       escrow this table can't use -- so it is dropped UNSENT (never kept, never broadcast: it cannot land). */
    const signedAnte = view.terms.anteGross;
    const stillValid = (): string | null => {
      const now = ctx.latest?.() ?? null;
      if (now === null) return null;
      if (now.escrow.chainGameId !== null) return "This table was opened on Juno while Keplr was open, so the transaction you signed wasn't sent (nothing moved).";
      if (now.terms.anteGross !== signedAnte) {
        return `The table's ante changed to ${formatAmount(now.terms.anteGross, now.deployment.exponent, now.deployment.symbol)} while Keplr was open, so the transaction you signed (${formatAmount(signedAnte, view.deployment.exponent, view.deployment.symbol)}) wasn't sent -- nothing moved. Press Ante again to open the table at the new ante.`;
      }
      return null;
    };
    return signKeepSend(services, pin, target, message.value, ctx.port, stillValid);
  }
  /* The escrow's own configuration first (its admission key, paused), then the server's approval checked against it. */
  const config = await services.wallet.chainConfig(pin);
  if (!config.ok) return refuse(config.reason);
  if (config.value.paused) return refuse("Deposits are paused on Juno right now, so nothing was sent. Try again later.");
  const asked = await joinAdmission(ctx.gameId, ctx.port);
  if (!asked.ok) return fromApi(asked, services);
  const problem = await admissionProblem(pin, view, asked.value, { wallet: you.link.wallet, now: services.now(), admissionKey: config.value.admissionPubkey });
  if (problem !== null) return refuse(problem);
  const facts = await services.wallet.chainGame(pin, asked.value.chain_game_id);
  if (!facts.ok) return refuse(facts.reason);
  const mismatch = chainGameProblemForJoin(pin, view, ctx.variants, facts.value, you.link.wallet, services.now(), ctx.deadline ?? null);
  if (mismatch !== null) return refuse(mismatch);
  const message = joinMessage(pin, view, asked.value, key.pubkey);
  if (!message.ok) return refuse(message.reason);
  return signKeepSend(services, pin, target, message.value, ctx.port);
}

/* ==================================================================
    PHASE 3 (P3-ACCT): "ANTE X JUNO" -- ONE BUTTON, ONLY THE STEPS STILL NEEDED, IN ORDER
   ==================================================================
   The owner's one-button ante. Each step below is the SAME function the separate buttons ran (so every check, the
   challenge's single use, the W2-M replacement question and the ticket rules are exactly theirs); this only decides,
   from the newest view, which of them the seat still needs, and says where it is:

     Connecting wallet…   Keplr connected on this page? If not, `connectWallet` (Keplr asks once per site).
     Verifying wallet…    no link for this seat -> `linkWallet` (Keplr signs the server's single-use challenge: free);
                          the server's own word that the proof is too old -> the free re-proof of the SAME wallet.
                          A link to ANOTHER wallet is never replaced here: the W2-M question is asked first.
     Waiting for deposit… `approveDeposit` (Keplr shows the transaction). If the server refuses its approval for want of
                          a fresh proof, the free re-proof of the SAME wallet runs once and the deposit is asked again
                          (the server's approval re-reads the proof itself; nothing waits on a view for it).
     Ante confirmed.      the server's view shows the deposit funded (Juno read by the server; never assumed here).

   KEPLR PROMPTS. Every table: connect (once per site), one link signature (the server's challenge names this table and
   seat and is single-use -- it cannot be skipped without changing the protocol) and one transaction. "Confirm it's you"
   (the password) is asked only for a wallet that is not the account's Authorization Wallet, and only more than five
   minutes after signing in. The Authorization Wallet is never required here: each table uses whatever wallet the player
   antes with, and THAT wallet is the table's payout wallet from the deposit on. Signatures are never combined: a message
   signature and a transaction are different things to Keplr and to Juno.

   STOPPING IS SAFE AT EVERY STEP. A refusal returns at once with its sentence and the step that cures it (`needs`):
   "Confirm it's you" (the server asked: a new wallet, more than five minutes after signing in -- once confirmed, the
   Ante carries on by itself), the W2-M replacement question (answered, it links; the player then presses Ante again,
   a decision the button never makes for them), Keplr not connected. Nothing is retried behind the player's back, and
   pressing Ante again re-reads everything and skips what is already done. */

export interface AnteHooks {
  /** Say where the ante is (the button's words while it runs). */
  readonly status: (text: string) => void;
  /** The newest server view (pushes arrive while this runs). */
  readonly latest: () => RoomMoneyView | null;
  /** Wait (bounded) for the server's view to satisfy `predicate`; the view, or null when it didn't in time. */
  readonly waitFor: (predicate: (view: RoomMoneyView) => boolean, ms: number) => Promise<RoomMoneyView | null>;
  /** W2-M (AUD-20.02): this seat's proof as the panel judges it (`refused` is the server's word). */
  readonly proof: "aged" | "refused" | null;
  /** Money review M2: the player pressed "Verify wallet (free)": verify, and STOP -- never a deposit, whatever the
   *  table did meanwhile (the host may open the escrow while Keplr is signing). */
  readonly verifyOnly?: boolean;
  /** Money review L1: a free re-proof was accepted (the panel's "the server refused the proof" state ends). */
  readonly onReproved?: () => void;
}

/** How long Ante waits for the server's view to show a link it just accepted. */
export const ANTE_VIEW_WAIT_MS = 15_000;

const canDepositIn = (view: RoomMoneyView, isHost: boolean, wallet: string): boolean => view.you?.link?.wallet === wallet && view.you.actions.includes(isHost ? "open-escrow" : "deposit");

/** What a link the server just accepted is known by: its ticket and the signing key it registered (null: not said). */
interface AcceptedLink {
  ticket: string | null;
  consentKey: string | null;
}

/** The same-wallet re-proof the Ante runs -- free, Keplr signs a message -- returning what the server accepted. */
async function reproveFor(ctx: TableContext, view: RoomMoneyView, wallet: string, hooks: AnteHooks): Promise<{ ok: true; accepted: AcceptedLink } | { ok: false; outcome: ActionOutcome }> {
  const accepted: AcceptedLink = { ticket: null, consentKey: null };
  const again = await linkWallet({ ...ctx, view }, { expectWallet: wallet, reprove: true, onLinked: (linked) => Object.assign(accepted, { ticket: linked.ticket, consentKey: linked.consentKey }) });
  if (!again.ok) return { ok: false, outcome: again };
  hooks.onReproved?.();
  return { ok: true, accepted };
}

/** Wait for the server's view to show the link just accepted: its ticket and the key it registered for this browser
 *  (so the deposit that follows signs with a key the seat already has -- never a separate, sensitive key registration). */
function showsLink(wallet: string, accepted: AcceptedLink): (view: RoomMoneyView) => boolean {
  return (view) =>
    view.you?.link?.wallet === wallet &&
    (accepted.ticket === null || view.you.link.ticket === accepted.ticket) &&
    (accepted.consentKey === null || view.you.link.consentKeys.includes(accepted.consentKey));
}

export async function anteNow(ctx: TableContext, hooks: AnteHooks): Promise<ActionOutcome> {
  const services = ctx.services ?? moneyServices();
  const pinned = pinOf(services);
  if (!pinned.ok) return pinned.outcome;
  let view = hooks.latest() ?? ctx.view;
  if (view.you === null) return refuse("You don't have a seat at this table.");
  const table = tableSigningProblem(pinned.pin, view);
  if (table !== null) return refuse(table);
  /* Consolidated final integration (review): a No-deadline table's disclosure is acknowledged BEFORE the Ante asks
     anything of Keplr -- not after a link signature the deposit's own check (`deadlineChoiceFor`) would then refuse.
     Verifying a wallet alone (`verifyOnly`) commits no money and is not gated. */
  if (hooks.verifyOnly !== true && ctx.deadline?.deadline === "no-deadline" && !ctx.deadline.acknowledged) {
    const gate = deadlineChoiceFor("async", ctx.deadline);
    if (!gate.ok) return refuse(gate.reason);
  }

  /* 1. Keplr on this page. */
  const session = moneySession();
  if (session.wallet !== "connected" || session.address === null) {
    hooks.status(ANTE_STATUS.connecting);
    const connected = await connectWallet(services);
    if (!connected.ok) return connected;
  }
  const account = await currentAccount(services, pinned.pin);
  if (!account.ok) return account.outcome;
  const wallet = account.address;

  /* 2. The wallet, verified for this seat. */
  view = hooks.latest() ?? view;
  const you = view.you;
  if (you === null) return refuse("You don't have a seat at this table.");
  const link = you.link ?? null;
  let verified = false;
  let accepted: AcceptedLink = { ticket: null, consentKey: null };
  if (link !== null && link.wallet !== wallet) {
    /* Never a silent replacement: the seat's wallet changes only through the W2-M question ("Change wallet"). */
    return refuse(`Switch Keplr to ${link.wallet} to sign this action — it is this seat's linked wallet (Keplr is on ${wallet}). To ante from another wallet, use Change wallet first.`, "connect");
  }
  /* Money review L2: a seat linked from ANOTHER device has no signing key on this one; registering one outside a link
     is a sensitive step (the password). A same-wallet re-proof registers this browser's key with the link instead --
     the wallet's own signature, free -- so the Ante never asks for a password just because the device changed. */
  const registered = new Set(link?.consentKeys ?? []);
  const holdsKey = link === null || (await services.keys.forSeat(ctx.gameId, you.playerId)).some((record) => registered.has(record.pubkey));
  if (link === null) {
    hooks.status(ANTE_STATUS.verifying);
    const linked = await linkWallet({ ...ctx, view }, { expectWallet: wallet, onLinked: (answer) => (accepted = { ticket: answer.ticket, consentKey: answer.consentKey }) });
    if (!linked.ok) return linked;
    verified = true;
  } else if ((hooks.proof === "refused" && !ctx.isHost) || !holdsKey) {
    hooks.status(ANTE_STATUS.verifying);
    const again = await reproveFor(ctx, view, wallet, hooks);
    if (!again.ok) return again.outcome;
    accepted = again.accepted;
    verified = true;
  }
  if (verified) {
    /* The server's next view shows the link just accepted -- its ticket -- (and, once the escrow is open, the deposit
       it allows). Money review L5: never a deposit built on a link the view hasn't caught up with. */
    const shown = await hooks.waitFor(showsLink(wallet, accepted), ANTE_VIEW_WAIT_MS);
    if (shown === null) return done("Wallet verified. The table hasn't caught up yet — press Ante again in a moment.");
    view = shown;
  }
  if (hooks.verifyOnly === true) return done(verified ? "Wallet verified. Nothing was charged." : "This wallet is already verified for your seat. Nothing was charged.");
  view = hooks.latest() ?? view;
  if (!canDepositIn(view, ctx.isHost, wallet)) {
    if (!ctx.isHost && view.escrow.chainGameId === null) return done("Wallet verified. Ante once the host opens the table on Juno — the button says so.");
    return done("Wallet verified. This table isn't taking deposits right now; the panel says why.");
  }

  /* 3. The deposit (Keplr shows the transaction). */
  hooks.status(ANTE_STATUS.depositing);
  let deposited = await approveDeposit({ ...ctx, view });
  if (!deposited.ok && deposited.needs === "reprove" && !verified && !ctx.isHost) {
    /* The server's word: the proof is too old. The free re-proof of the SAME wallet, once, then the deposit again --
       on the view that shows the re-proven link (its ticket may be new). */
    hooks.status(ANTE_STATUS.verifying);
    const again = await reproveFor(ctx, view, wallet, hooks);
    /* A re-proof that couldn't run leaves the server's word standing: the seat still needs one ("reprove"). */
    if (!again.ok) return again.outcome.ok || again.outcome.needs !== undefined ? again.outcome : { ...again.outcome, needs: "reprove" };
    const shown = await hooks.waitFor(showsLink(wallet, again.accepted), ANTE_VIEW_WAIT_MS);
    if (shown === null) return done("Wallet proof renewed. The table hasn't caught up yet — press Ante again in a moment.");
    view = shown;
    hooks.status(ANTE_STATUS.depositing);
    deposited = await approveDeposit({ ...ctx, view });
  }
  return deposited;
}

/* ==================================================================
    WITHDRAW, CANCEL, REFUND (pre-Start; also from "Your deposits")
   ================================================================== */

export type EscrowExit = "withdraw" | "cancel-escrow" | "refund-after-deadline";

/** Withdraw this seat's deposit, cancel the escrow (the creator), or refund everyone after the deadline (anyone). */
export async function escrowExit(ctx: TableContext, exit: EscrowExit): Promise<ActionOutcome> {
  const services = ctx.services ?? moneyServices();
  const pinned = pinOf(services);
  if (!pinned.ok) return pinned.outcome;
  const pin = pinned.pin;
  const you = ctx.view.you;
  if (you === null) return refuse("You don't have a seat at this table.");
  const table = tableSigningProblem(pin, ctx.view);
  if (table !== null) return refuse(table);
  let wallet = you.payoutWallet ?? you.unlinkedDeposit?.wallet ?? you.link?.wallet ?? null;
  if (exit === "cancel-escrow") {
    /* The creator's Cancel: it must come from the wallet that opened the escrow, as Juno itself says. */
    if (ctx.view.escrow.chainGameId === null) return refuse("This table isn't open on Juno.");
    const facts = await services.wallet.chainGame(pin, ctx.view.escrow.chainGameId);
    if (!facts.ok) return refuse(facts.reason);
    if (facts.value.state !== "FUNDING" && facts.value.state !== "FUNDED") return refuse("The escrow on Juno can't be cancelled now (the game has started or it is closed).");
    wallet = facts.value.creator;
  }
  if (wallet === null) return refuse("This seat has no deposit on Juno to withdraw.");
  const message = exit === "withdraw" ? withdrawMessage(pin, ctx.view.escrow.chainGameId) : cancelMessage(pin, ctx.view.escrow.chainGameId);
  if (!message.ok) return refuse(message.reason);
  return signKeepSend(services, pin, { gameId: ctx.gameId, playerId: you.playerId, wallet }, message.value, ctx.port);
}

/** The same exits for a "Your deposits" entry (its table may be gone). The entry's deployment must be the pin. */
export async function depositEntryExit(entry: MoneyDepositEntry, exit: EscrowExit, services: MoneyServices = moneyServices(), port?: SessionPort): Promise<ActionOutcome> {
  const pinned = pinOf(services);
  if (!pinned.ok) return pinned.outcome;
  const pin = pinned.pin;
  const differs = (["backend", "chainId", "networkClass", "contract", "codeChecksum", "denom"] as const).find((field) => pin[field] !== entry.deployment[field]);
  if (differs !== undefined) return refuse(`This deposit is on an escrow this app wasn't built for (its ${differs} differs), so nothing will be signed for it here.`);
  const facts = await services.wallet.chainGame(pin, entry.chainGameId);
  if (!facts.ok) return refuse(facts.reason);
  if (!facts.value.seats.some((seat) => seat.wallet === entry.wallet)) return refuse("Juno shows no deposit from that wallet in this escrow anymore. Nothing to do.");
  const message = exit === "withdraw" ? withdrawMessage(pin, entry.chainGameId) : cancelMessage(pin, entry.chainGameId);
  if (!message.ok) return refuse(message.reason);
  return signKeepSend(services, pin, { gameId: entry.gameId, playerId: `wallet:${entry.wallet}`, wallet: entry.wallet }, message.value, port);
}

/* ==================================================================
    THE SIGNING KEY: "Use this device for signing"
   ================================================================== */

export async function moveSigningKeyHere(ctx: TableContext): Promise<ActionOutcome> {
  const services = ctx.services ?? moneyServices();
  const pinned = pinOf(services);
  if (!pinned.ok) return pinned.outcome;
  const pin = pinned.pin;
  const you = ctx.view.you;
  const wallet = you?.payoutWallet ?? null;
  if (you === null || wallet === null) return refuse("This seat has no deposit on Juno yet.");
  /* Keplr on the seat's wallet first: a device that can't send the SetConsentKey makes and registers no key (M3). */
  const account = await currentAccount(services, pin);
  if (!account.ok) return account.outcome;
  if (account.address !== wallet) return refuse(`Switch Keplr to ${wallet} to sign this action. (Keplr is on ${account.address}; that is your seat's wallet.)`, "connect");
  const made = await services.keys.create({ chainId: pin.chainId, contract: pin.contract, gameId: ctx.gameId, playerId: you.playerId, wallet });
  bumpLocal();
  if (!made.ok) return refuse(made.reason);
  const refused = await registerKeyWithWallet(ctx, services, pin, you.playerId, made.pubkey);
  if (refused !== null) return refused;
  const message = setConsentKeyMessage(pin, ctx.view.escrow.chainGameId, made.pubkey);
  if (!message.ok) return refuse(message.reason);
  const sent = await signKeepSend(services, pin, { gameId: ctx.gameId, playerId: you.playerId, wallet }, message.value, ctx.port);
  return sent.ok ? done("Sent — once Juno records it, this device holds your seat's signing key.") : sent;
}

/* ==================================================================
    AFTER THE DEAL: APPROVE, DISPUTE, RELEASE, INACTIVITY EXIT, ANNUL
   ================================================================== */

export interface Verification {
  readonly result: "match" | "mismatch" | "unavailable";
  /** Every chain seat's payout (base units) from the recorded settlement, when it could be read. */
  readonly payouts: readonly string[] | null;
  readonly detail: string;
  /** WHICH recorded payout this is about -- as JUNO holds it, read through this build's pinned endpoint (review S-H1:
   *  an approval signs exactly the payout that was checked, on the escrow game that was read). */
  readonly settleDigest: string | null;
  readonly domain: string | null;
  readonly seq: string | null;
  /** The seat's key on that escrow game that this device holds (what an approval is signed with), or null. */
  readonly signingKey: string | null;
}

/** This device's own seat on an escrow game Juno showed it: the seat carrying a signing key THIS browser made for this
 *  table and seat (its vault's record, never the server's word), or null. */
async function ownSeatOn(facts: ChainGameFacts, gameId: string, playerId: string, pin: PinnedEscrowDeployment, services: MoneyServices): Promise<{ index: number; key: string } | null> {
  const mine = (await services.keys.forSeat(gameId, playerId)).filter((record) => record.chainId === pin.chainId && record.contract === pin.contract);
  for (let index = 0; index < facts.seats.length; index += 1) {
    const key = facts.seats[index].consentPubkey;
    if (mine.some((record) => record.pubkey === key)) return { index, key };
  }
  return null;
}

/** This device's check of the payout Juno recorded (`settlementCheck.ts`). Everything it signs over comes from Juno
 *  through this build's pinned endpoint: the escrow game's stored settlement (its sequence and payload digest), its
 *  settlement domain (which commits to that very escrow game) and this seat's own position there (the seat carrying a
 *  key this browser made). The server's signed payload must BE that settlement, and this device must re-derive it from
 *  its own copy of the game -- the history hashed, the sealed prefix replayed here to GameEnd, the final standings
 *  counted here and laid out in the roster's chain order, with this seat where Juno shows it. */
export async function verifyRecordedSettlement(
  gameId: string,
  view: RoomMoneyView,
  log: readonly HashableLogEntry[] | null,
  _board: GameStateResponse | null,
  port?: SessionPort,
  services: MoneyServices = moneyServices(),
  replay?: SealedReplay,
): Promise<Verification> {
  const s = view.settlement;
  let about: Pick<Verification, "settleDigest" | "domain" | "seq" | "signingKey"> = { settleDigest: s?.settleDigest ?? null, domain: s?.domain ?? null, seq: s?.seq ?? null, signingKey: null };
  const answer = (result: Verification["result"], detail: string, payouts: readonly string[] | null = null): Verification => ({ result, payouts, detail, ...about });
  if (s === null || s.settleDigest === null || s.domain === null || s.seq === null) return answer("unavailable", "Juno hasn't recorded a payout yet.");
  const details = await escrowDetails(gameId, port);
  if (!details.ok || details.value.settlement === null) return answer("unavailable", "The recorded payout couldn't be fetched just now.");
  let payload;
  try {
    payload = settlementPayloadFromWire(details.value.settlement.payload);
  } catch {
    return answer("unavailable", "The recorded payout couldn't be read.");
  }
  if (settleDigestV1(payload) !== s.settleDigest || payload.domain !== s.domain || payload.seq.toString() !== s.seq) {
    return answer("unavailable", "The server's copy of the payout isn't the one Juno recorded (it may have just changed). Try again in a moment.");
  }
  let payouts: string[] | null = null;
  if (view.terms.pot !== null) {
    try {
      payouts = payoutPreview(BigInt(view.terms.pot), payload.settlement_weights).payouts.map((value) => value.toString());
    } catch {
      payouts = null;
    }
  }
  const you = view.you;
  if (you === null) return answer("unavailable", "Only a seated player's device checks the payout.", payouts);
  if (log === null) return answer("unavailable", "This device doesn't hold the whole game to re-check it.", payouts);
  if (details.value.roster === null) return answer("unavailable", "The table's roster isn't available to check the payout against.", payouts);
  /* Juno itself, through the pinned endpoint: the escrow game must hold EXACTLY this payload (its digest and sequence)
     under exactly its domain -- the domain commits to the escrow game, so an approval can only ever count there -- and
     this device's own key must sit on one of its seats. */
  const pinned = services.pin();
  if (!pinned.ok || view.escrow.chainGameId === null) return answer("unavailable", "This device can't read the table's escrow on Juno.", payouts);
  const facts = await services.wallet.chainGame(pinned.pin, view.escrow.chainGameId);
  if (!facts.ok) return answer("unavailable", "Juno couldn't be read from this device just now, so the payout wasn't re-checked.", payouts);
  const stored = facts.value.settlement;
  if (facts.value.state !== "SETTLEABLE" || stored === null || facts.value.domain === null || stored.payloadDigest !== settleDigestV1(payload) || stored.seq !== payload.seq.toString() || facts.value.domain !== payload.domain) {
    return answer("unavailable", "The payout this device was shown isn't the one Juno holds right now, so it wasn't re-checked.", payouts);
  }
  const own = await ownSeatOn(facts.value, gameId, you.playerId, pinned.pin, services);
  if (own === null) return answer("unavailable", "This device holds no signing key of a seat in this escrow, so it didn't re-check the payout.", payouts);
  about = { settleDigest: stored.payloadDigest, domain: facts.value.domain, seq: stored.seq, signingKey: own.key };
  const checked = checkTerminalSettlement({ payload, log, roster: details.value.roster, playerId: you.playerId, chainSeatIndex: own.index, ...(replay !== undefined ? { replay } : {}) });
  return answer(checked.result, checked.detail, payouts);
}

/** "Approve payout now": this device's signing key signs CONSENT over exactly the settlement this device checked -- as
 *  Juno holds it -- and the server relays it. */
export async function approvePayout(ctx: TableContext, verification: Verification): Promise<ActionOutcome> {
  const services = ctx.services ?? moneyServices();
  const s = ctx.view.settlement;
  if (verification.result !== "match") return refuse("This device hasn't confirmed the recorded payout, so it won't approve it.");
  if (s === null || s.domain === null || s.seq === null || s.settleDigest === null) return refuse("Juno hasn't recorded a payout yet.");
  const { settleDigest, domain, seq, signingKey } = verification;
  if (settleDigest === null || domain === null || seq === null || settleDigest !== s.settleDigest || domain !== s.domain || seq !== s.seq) {
    return refuse("The recorded payout changed since this device checked it. It's being checked again; approve once it says so.");
  }
  if (signingKey === null || !(await services.keys.holds(signingKey))) return refuse("This device doesn't hold your seat's signing key. Use this device for signing first, or approve from the device that does.");
  const signature = await services.keys.signDigest(signingKey, consentDigestV1(domain, BigInt(seq), settleDigest));
  if (signature === null) return refuse("This device couldn't sign with the seat's key.");
  const relayed = await relayConsent(ctx.gameId, signature, ctx.port);
  if (!relayed.ok) return fromApi(relayed, services);
  return done(relayed.value.status === "on-chain" ? "Your approval is on Juno." : "Approved — your approval is on its way to Juno. If every player approves, the payout is released at once.");
}

/** "Agree to cancel this game": this device's key signs ANNUL over the escrow game's own domain and trusted sequence,
 *  read from Juno here (so it works whether or not this table's view knows them yet); collected until every seat has. */
export async function agreeToAnnul(ctx: TableContext): Promise<ActionOutcome> {
  const services = ctx.services ?? moneyServices();
  const pinned = pinOf(services);
  if (!pinned.ok) return pinned.outcome;
  const you = ctx.view.you;
  if (you === null) return refuse("You don't have a seat at this table.");
  if (ctx.view.escrow.chainGameId === null) return refuse("This table isn't open on Juno.");
  const facts = await services.wallet.chainGame(pinned.pin, ctx.view.escrow.chainGameId);
  if (!facts.ok) return refuse(facts.reason);
  /* Escrow 2.1.0 also takes the unanimous annulment of a DISPUTED game (a challenged remedy; the bond is returned). */
  const annullable = facts.value.state === "IN_PROGRESS" || facts.value.state === "SETTLEABLE" || (facts.value.state === "DISPUTED" && facts.value.policy !== null);
  if (!annullable || facts.value.domain === null || facts.value.trustedSeq === null) {
    return refuse("Juno's escrow isn't in a state where the game can be cancelled by agreement.");
  }
  const own = await ownSeatOn(facts.value, ctx.gameId, you.playerId, pinned.pin, services);
  if (own === null) return refuse("This device doesn't hold your seat's signing key. Use this device for signing first.");
  const signature = await services.keys.signDigest(own.key, annulDigestV1(facts.value.domain, BigInt(facts.value.trustedSeq)));
  if (signature === null) return refuse("This device couldn't sign with the seat's key.");
  const answer = await submitAnnul(ctx.gameId, signature, ctx.port);
  if (!answer.ok) return fromApi(answer, services);
  return done(answer.value.submitted ? "Every player agreed: the cancellation is on its way to Juno." : `Your agreement is recorded (${answer.value.collected.length} of ${answer.value.needed}). The game is cancelled only if every player agrees.`);
}

/* ==================================================================
    PHASE 3 FINAL CLOCKS (FP4): THIS SEAT'S REMEDY-APPROVE FOR ONE OVERDUE INSTANCE
   ==================================================================
   A money table's N-1 YES (Live foreclosure; Async neutral annulment or foreclosure) carries the seat's own consent-key
   signature over escrow 2.1.0's REMEDY-APPROVE digest. Everything it binds is checked HERE from facts this browser reads
   itself where it can: the domain and this seat's chain position from Juno through the pinned endpoint (the seat that
   carries a key this browser made), the defaulting player's chain seat from the frozen roster, and the overdue instance
   (strike, epoch, stalled position, its hash, the overdue moment) from the clock. The server verifies it against the
   seat's CURRENT key by quorum before it counts; the contract verifies it again under the key the seat held at the
   remedy's final moment (owner ruling, 2026-10-07: an approval valid when the outcome became final keeps counting for
   that sealed outcome, whatever expires or rotates later). No amount is computed anywhere. */

/** Live: an approval reaches as far as the server allows past the overdue (six hours, a minute short). A pause that
 *  outlasts it BEFORE minute 30 lapses the approval (the vote is then incomplete); once minute 30 seals the outcome,
 *  its expiry no longer matters. */
export const LIVE_APPROVAL_REACH_SECS = 6 * 3600 - 60;
/** An Async approval lasts 29 days: long enough for slow N-1 voters (the server refuses one with less than an hour of
 *  life), short of the server's 30-day ceiling with a day of clock skew to spare. Once the consensus completes (final at
 *  once), its expiry no longer matters. */
export const ASYNC_APPROVAL_REACH_SECS = 29 * 86_400;

export async function signRemedyApproval(
  ctx: TableContext,
  input: { readonly remedy: 2 | 4 | 5; readonly overdue: Pick<ClockOverdueView, "seat" | "strike" | "epoch" | "overdueAt" | "logLen" | "logHash">; readonly live: boolean; readonly serverNowMs?: number },
): Promise<{ readonly ok: true; readonly approveUntil: number; readonly signature: string } | { readonly ok: false; readonly outcome: ActionOutcome }> {
  const services = ctx.services ?? moneyServices();
  const pinned = pinOf(services);
  if (!pinned.ok) return { ok: false, outcome: pinned.outcome };
  const you = ctx.view.you;
  const chainGameId = ctx.view.escrow.chainGameId;
  if (you === null) return { ok: false, outcome: refuse("You don't have a seat at this table.") };
  if (chainGameId === null) return { ok: false, outcome: refuse("This table isn't open on Juno.") };
  if (!/^[0-9a-f]{64}$/.test(input.overdue.logHash) || !Number.isSafeInteger(input.overdue.logLen) || !Number.isSafeInteger(input.overdue.overdueAt)) return { ok: false, outcome: refuse("The overdue this vote is about isn't shown completely yet, so nothing was signed.") };
  const facts = await services.wallet.chainGame(pinned.pin, chainGameId);
  if (!facts.ok) return { ok: false, outcome: refuse(facts.reason) };
  if (facts.value.state !== "IN_PROGRESS" || facts.value.domain === null) return { ok: false, outcome: refuse("Juno's escrow isn't in play, so there is nothing to approve.") };
  const own = await ownSeatOn(facts.value, ctx.gameId, you.playerId, pinned.pin, services);
  if (own === null) return { ok: false, outcome: refuse("This device doesn't hold your seat's signing key. Use this device for signing first.") };
  const details = await escrowDetails(ctx.gameId, ctx.port);
  if (!details.ok) return { ok: false, outcome: fromApi(details, services) };
  const defaulting = details.value.roster?.find((seat) => seat.playerId === input.overdue.seat)?.chainSeatIndex ?? null;
  if (defaulting === null || !Number.isSafeInteger(defaulting) || defaulting < 0 || defaulting >= facts.value.seats.length) return { ok: false, outcome: refuse("The overdue player's seat on Juno isn't known, so nothing was signed.") };
  /* The server's roster must place THIS seat where Juno does (by this device's own key): a roster that disagrees could
     name the wrong defaulting seat, so nothing is signed on it. */
  const mineOnRoster = details.value.roster?.find((seat) => seat.playerId === you.playerId)?.chainSeatIndex ?? null;
  if (mineOnRoster !== own.index) return { ok: false, outcome: refuse("The table's roster doesn't match Juno for your seat, so nothing was signed.") };
  if (defaulting === own.index) return { ok: false, outcome: refuse("You can't approve a remedy against your own seat.") };
  /* Whole seconds, rounded UP (as the server and the contract read the overdue moment). Integers only. */
  const overdueAtSecs = Number((BigInt(input.overdue.overdueAt) + BigInt(999)) / BigInt(1000));
  /* The horizon is counted from the SERVER's time as this device last saw it (never this browser's wall clock alone). */
  const nowMs = input.serverNowMs !== undefined && Number.isSafeInteger(input.serverNowMs) ? input.serverNowMs : services.now();
  const nowSecs = Number(BigInt(nowMs) / BigInt(1000));
  const approveUntil = input.live ? overdueAtSecs + LIVE_APPROVAL_REACH_SECS : nowSecs + ASYNC_APPROVAL_REACH_SECS;
  let digest: string;
  try {
    digest = remedyApproveDigestV1(
      {
        domain: facts.value.domain,
        chain_game_id: BigInt(chainGameId),
        remedy: input.remedy as RemedyKindByte,
        defaulting_seat: defaulting,
        strike: input.overdue.strike,
        overdue_epoch: BigInt(input.overdue.epoch),
        log_len: BigInt(input.overdue.logLen),
        log_hash: input.overdue.logHash,
        overdue_at: BigInt(overdueAtSecs),
      },
      BigInt(approveUntil),
      own.index,
    );
  } catch {
    return { ok: false, outcome: refuse("The approval couldn't be built, so nothing was signed.") };
  }
  const signature = await services.keys.signDigest(own.key, digest);
  if (signature === null) return { ok: false, outcome: refuse("This device couldn't sign with the seat's key.") };
  return { ok: true, approveUntil, signature };
}

/** A wallet transaction on the table's escrow after the deal (dispute, release, the inactivity exit, the exceptional
 *  review request). */
export async function settlementTx(ctx: TableContext, kind: "challenge" | "release-payout" | "liveness-settle" | "request-review", evidence: { readonly log: readonly HashableLogEntry[] | null; readonly board: GameStateResponse | null } = { log: null, board: null }): Promise<ActionOutcome> {
  const services = ctx.services ?? moneyServices();
  const pinned = pinOf(services);
  if (!pinned.ok) return pinned.outcome;
  const pin = pinned.pin;
  const you = ctx.view.you;
  const wallet = you?.payoutWallet ?? null;
  const table = tableSigningProblem(pin, ctx.view);
  if (table !== null) return refuse(table);
  const chainGameId = ctx.view.escrow.chainGameId;
  let message;
  if (kind === "release-payout") {
    message = finalizeMessage(pin, chainGameId);
  } else if (kind === "liveness-settle") {
    message = livenessSettleMessage(pin, chainGameId);
  } else if (kind === "request-review") {
    /* Escrow 2.1.0: Juno itself, re-read through the pinned endpoint -- an in-progress 2.1.0 game (an exit policy), no
       request recorded yet. The request moves no funds; the resolver may only annul neutrally, after 7 days. */
    if (chainGameId === null) return refuse("This table isn't open on Juno.");
    const facts = await services.wallet.chainGame(pin, chainGameId);
    if (!facts.ok) return refuse(facts.reason);
    if (facts.value.state !== "IN_PROGRESS" || facts.value.policy === null) return refuse("Juno's escrow can't take a review request now (the game isn't in play under escrow 2.1), so nothing was sent.");
    message = requestReviewMessage(pin, chainGameId);
  } else {
    /* The evidence a dispute records: this device's own board commitment when it has one, else its history's. */
    let evidenceHash = "";
    try {
      evidenceHash = evidence.board !== null ? terminalStateHashV1(evidence.board) : evidence.log !== null ? logHash(evidence.log) : "";
    } catch {
      evidenceHash = "";
    }
    if (!/^[0-9a-f]{64}$/.test(evidenceHash)) evidenceHash = sha256Hex(`18COSMOS/DISPUTE/v1\n${ctx.gameId}\n${ctx.view.settlement?.seq ?? ""}`);
    /* W2-M (AUD-20.06, JX-6C): Juno itself, re-read through the pinned endpoint before Keplr opens -- still open to a
       challenge, storing exactly the payout this page showed, asking exactly the bond it showed, the window not
       closed. The bond attached is Juno's (equal to the shown one, or nothing is signed). */
    if (chainGameId === null) return refuse("This table isn't open on Juno.");
    const facts = await services.wallet.chainGame(pin, chainGameId);
    if (!facts.ok) return refuse(facts.reason);
    const problem = challengeProblem(ctx.view, facts.value, services.now());
    if (problem !== null) return refuse(problem);
    message = challengeMessage(pin, chainGameId, evidenceHash, facts.value.bond);
  }
  if (!message.ok) return refuse(message.reason);
  let sender = wallet;
  if (sender === null) {
    /* Release is permissionless: any account may send it. Everything else is the seat's own wallet's. */
    if (kind !== "release-payout") return refuse("This seat's wallet on Juno isn't known yet.");
    const account = await currentAccount(services, pin);
    if (!account.ok) return account.outcome;
    sender = account.address;
  }
  return signKeepSend(services, pin, { gameId: ctx.gameId, playerId: you?.playerId ?? "", wallet: sender }, message.value, ctx.port);
}

/** W2-M (AUD-20.07, JX-6E): what the dispute confirm and the band's dispute record read from Juno -- through this
 *  build's pinned endpoint, never the server -- the game's resolver window, its bond, its dispute record and its seats'
 *  wallets (to name which seat disputed). Never throws; a failed read is a sentence. */
export async function disputeChainFacts(view: RoomMoneyView, services: MoneyServices = moneyServices()): Promise<DisputeRead> {
  const pinned = services.pin();
  if (!pinned.ok) return { kind: "unavailable", reason: pinned.reason };
  const chainGameId = view.escrow.chainGameId;
  if (chainGameId === null) return { kind: "unavailable", reason: "This table isn't open on Juno." };
  const facts = await services.wallet.chainGame(pinned.pin, chainGameId);
  if (!facts.ok) return { kind: "unavailable", reason: facts.reason };
  return { kind: "read", resolverTimeoutSecs: facts.value.resolverTimeoutSecs, bond: facts.value.bond, dispute: facts.value.dispute, seats: facts.value.seats.map((seat) => seat.wallet) };
}
