// frontend/src/money/moneySession.ts
//
// ==================================================================
//  ESCROW-4: THIS PAGE'S WALLET CONNECTION AND "CONFIRM IT'S YOU" -- THE TWO THINGS A RELOAD FORGETS
// ==================================================================
//
// Everything else about a money seat is durable (the server's view, the chain, this browser's pending transaction and
// signing key). These two are not, and should not be: Keplr's connection is re-established silently on the next
// Connect, and the "Confirm it's you" grant lives on the server for five minutes, bound to this session. What this
// store keeps is only this page's own knowledge of them, so the waiting-room panel, the in-game strip and the result's
// band agree (one Keplr account, one grant). Never persisted.

import { useSyncExternalStore } from "react";

import { createKeplrWallet, type WalletPort } from "./keplrWallet";
import { browserConsentKeys, type ConsentKeys } from "./consentKeys";
import { browserPendingTxStore, type PendingTxStore } from "./pendingTx";
import { pinnedDeployment, type PinnedDeploymentResult } from "./escrowDeployment";

export interface MoneySessionState {
  readonly wallet: "unknown" | "unavailable" | "disconnected" | "connecting" | "connected";
  readonly address: string | null;
  /** Server ms until which this session's "Confirm it's you" grant is believed live (null: none). */
  readonly confirmedUntil: number | null;
  /** W2-M (AUD-20.02): when THIS page last had a wallet proof accepted by the server, per table, seat and wallet
   *  (`proofKey`). The view's `linkedAt` is when the link was made; a same-wallet re-proof keeps it, so without this a
   *  page that just re-proved would still read as aged. Like the grant above: this page's own knowledge, never
   *  persisted -- after a reload the browser goes by `linkedAt` alone (at worst, one more free re-proof). */
  readonly proofRenewedAt: Readonly<Record<string, number>>;
  /** Bumped when this browser's pending transactions or signing keys change (components re-read them). */
  readonly localVersion: number;
}

export interface MoneyServices {
  readonly wallet: WalletPort;
  readonly keys: ConsentKeys;
  readonly pending: PendingTxStore;
  readonly pin: () => PinnedDeploymentResult;
  readonly now: () => number;
}

let services: MoneyServices | null = null;

/** The page's money services (Keplr, IndexedDB keys, localStorage pending records, the build's pin). */
export function moneyServices(): MoneyServices {
  if (services === null) services = { wallet: createKeplrWallet(), keys: browserConsentKeys(), pending: browserPendingTxStore(), pin: pinnedDeployment, now: () => Date.now() };
  return services;
}

/** Tests: install fakes (or null for the browser's). */
export function installMoneyServicesForTests(next: MoneyServices | null): void {
  services = next;
  state = INITIAL;
  listeners.forEach((listener) => listener());
}

const INITIAL: MoneySessionState = Object.freeze({ wallet: "unknown", address: null, confirmedUntil: null, proofRenewedAt: Object.freeze({}), localVersion: 0 });
let state: MoneySessionState = INITIAL;
const listeners = new Set<() => void>();

export function moneySession(): MoneySessionState {
  return state;
}

export function updateMoneySession(patch: Partial<MoneySessionState>): void {
  state = Object.freeze({ ...state, ...patch });
  listeners.forEach((listener) => listener());
}

/** Something local changed (a pending record, a key): re-read. */
export function bumpLocal(): void {
  updateMoneySession({ localVersion: state.localVersion + 1 });
}

export function subscribeMoneySession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMoneySession(): MoneySessionState {
  return useSyncExternalStore(subscribeMoneySession, moneySession, moneySession);
}

/** The key of `proofRenewedAt`: one table, one seat, one wallet. */
export const proofKey = (gameId: string, playerId: string, wallet: string): string => `${gameId}\u0000${playerId}\u0000${wallet}`;

/** The server accepted a fresh wallet proof from this page at `at` (W2-M, AUD-20.02). */
export function recordProofRenewed(gameId: string, playerId: string, wallet: string, at: number): void {
  updateMoneySession({ proofRenewedAt: Object.freeze({ ...state.proofRenewedAt, [proofKey(gameId, playerId, wallet)]: at }) });
}

/** Whether the page believes it holds a live grant (the server still decides; a refusal clears it). */
export function isConfirmed(session: MoneySessionState, now: number): boolean {
  return session.confirmedUntil !== null && session.confirmedUntil - now > 5_000;
}
