// frontend/src/money/pendingTx.ts
//
// ==================================================================
//  ESCROW-4: A WALLET TRANSACTION THIS BROWSER SIGNED, KEPT BEFORE IT IS BROADCAST
// ==================================================================
//
// A deposit's answer can be lost: the tab closes, the network drops, Keplr's broadcast times out. So the moment Keplr
// hands back the SIGNED bytes -- and before they go to the network -- this browser keeps them (with their hash and the
// block height after which they can never land). On a reload the money panel finds the record and:
//
//   - never builds a second deposit for the seat while one may still land (single flight across reloads);
//   - re-sends the SAME signed bytes if the chain doesn't know them yet (idempotent: the same transaction, the same
//     account sequence -- it can land at most once);
//   - re-sends the server its hint (`deposit-sent`), which only makes the server look sooner.
//
// IT IS NEVER FUNDING. "Funded" is only ever the server's reading of the chain; a record here says "a transaction may
// be on its way", nothing more. A record is dropped when the chain shows the transaction (a deposit's is kept, marked
// `landed`, until the table's view shows the deposit -- so the seat never looks undeposited in between, which is when a
// second deposit could be made: review R-M1), when the chain has passed its timeout height without it (it can never
// land), or when the server's view shows what it did.
//
// Storage: `localStorage` under the app's namespace, wrapped (a private window or blocked storage just means no record:
// the panel then relies on the server's view and the chain, as it would on another device). Signed bytes are public
// the moment they are broadcast; nothing secret is kept here.

import type { MoneyHintKind } from "../utils/moneyProtocol";

export const PENDING_TX_STORAGE_KEY = "1830juno.money_pending_tx.v1";
/** Forget a record this long after it was made, whatever happened (its timeout height has long passed by then). */
export const PENDING_TX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PendingWalletTx {
  readonly v: 1;
  readonly gameId: string;
  readonly playerId: string;
  readonly kind: MoneyHintKind;
  readonly chainId: string;
  readonly contract: string;
  readonly sender: string;
  /** The escrow's game id the transaction names (null for CreateGame, until the chain answers). */
  readonly chainGameId: string | null;
  /** Upper-case hex SHA-256 of the signed bytes: the transaction's id on chain. */
  readonly txHash: string;
  /** Base64 of the signed `TxRaw` bytes (re-sendable as they are). */
  readonly txBytes: string;
  /** The block height after which the transaction can never be included (decimal). */
  readonly timeoutHeight: string;
  readonly createdAt: number;
  /** signed: kept, not yet handed to the network; sent: the network took it (or its answer was lost); landed: Juno
   *  included it successfully (a deposit, kept until the table's view shows it). */
  readonly stage: "signed" | "sent" | "landed";
  /** The consent key a deposit or SetConsentKey carries (the one this browser keeps), or null. */
  readonly consentKey: string | null;
}

/** The storage a store runs on: `window.localStorage`, or a map in a test. Every call may throw. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const HINT_KINDS: readonly MoneyHintKind[] = ["create", "join", "withdraw", "cancel", "set-consent-key", "challenge", "liveness-settle", "finalize"];

function isPending(value: unknown): value is PendingWalletTx {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    typeof r.gameId === "string" &&
    typeof r.playerId === "string" &&
    typeof r.kind === "string" &&
    HINT_KINDS.includes(r.kind as MoneyHintKind) &&
    typeof r.chainId === "string" &&
    typeof r.contract === "string" &&
    typeof r.sender === "string" &&
    (r.chainGameId === null || (typeof r.chainGameId === "string" && /^[1-9][0-9]{0,19}$/.test(r.chainGameId))) &&
    typeof r.txHash === "string" &&
    /^[0-9A-F]{64}$/.test(r.txHash) &&
    typeof r.txBytes === "string" &&
    r.txBytes.length > 0 &&
    r.txBytes.length < 200_000 &&
    typeof r.timeoutHeight === "string" &&
    /^[0-9]{1,20}$/.test(r.timeoutHeight) &&
    typeof r.createdAt === "number" &&
    Number.isFinite(r.createdAt) &&
    (r.stage === "signed" || r.stage === "sent" || r.stage === "landed") &&
    (r.consentKey === null || (typeof r.consentKey === "string" && /^0[23][0-9a-f]{64}$/.test(r.consentKey)))
  );
}

export interface PendingTxStore {
  /** Every record for this seat of this table (newest first). */
  forSeat(gameId: string, playerId: string): PendingWalletTx[];
  /** Every record (for "Your deposits" when a table is gone). */
  all(): PendingWalletTx[];
  /** Keep a record; false when this browser could not keep it (the caller must then not broadcast a deposit). */
  put(record: PendingWalletTx): boolean;
  /** Mark a record sent (the network took it, or its answer was lost). */
  markSent(txHash: string): void;
  /** Mark a deposit landed (Juno included it successfully; the table's view hasn't shown it yet). */
  markLanded(txHash: string): void;
  remove(txHash: string): void;
}

export function createPendingTxStore(storage: () => KeyValueStorage | null, now: () => number = () => Date.now()): PendingTxStore {
  const read = (): PendingWalletTx[] => {
    try {
      const raw = storage()?.getItem(PENDING_TX_STORAGE_KEY) ?? null;
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isPending).filter((record) => now() - record.createdAt < PENDING_TX_MAX_AGE_MS);
    } catch {
      return [];
    }
  };
  const write = (records: PendingWalletTx[]): boolean => {
    try {
      const target = storage();
      if (target === null) return false;
      if (records.length === 0) target.removeItem(PENDING_TX_STORAGE_KEY);
      else target.setItem(PENDING_TX_STORAGE_KEY, JSON.stringify(records.slice(0, 32)));
      return true;
    } catch {
      return false;
    }
  };
  return {
    forSeat: (gameId, playerId) => read().filter((record) => record.gameId === gameId && record.playerId === playerId).sort((a, b) => b.createdAt - a.createdAt),
    all: () => read().sort((a, b) => b.createdAt - a.createdAt),
    put(record) {
      if (!isPending(record)) return false;
      const others = read().filter((existing) => existing.txHash !== record.txHash);
      if (!write([record, ...others])) return false;
      /* Read back: a record that did not stick is not kept (the caller must not broadcast on a promise). */
      return read().some((existing) => existing.txHash === record.txHash);
    },
    markSent(txHash) {
      const records = read();
      write(records.map((record) => (record.txHash === txHash && record.stage === "signed" ? { ...record, stage: "sent" as const } : record)));
    },
    markLanded(txHash) {
      const records = read();
      write(records.map((record) => (record.txHash === txHash ? { ...record, stage: "landed" as const } : record)));
    },
    remove(txHash) {
      write(read().filter((record) => record.txHash !== txHash));
    },
  };
}

/** The browser's store (localStorage when this page may use it). */
export function browserPendingTxStore(): PendingTxStore {
  return createPendingTxStore(() => {
    try {
      return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
    } catch {
      return null;
    }
  });
}
