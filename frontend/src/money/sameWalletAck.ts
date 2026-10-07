// frontend/src/money/sameWalletAck.ts
//
/* ==================================================================
    PHASE 3 OWNER RULING (2026-10-07): THE AUTHORIZATION WALLET MAY ALSO BE A GAME'S FINANCIAL WALLET -- WARNED ONCE
   ==================================================================
   The account's Authorization Wallet (account recovery / authorization) and a table's financial wallet (the wallet a
   seat links and antes with) are DIFFERENT ROLES. The player may deliberately put the same address in both: that is
   allowed, never refused, and never chosen for them -- the financial wallet is always the wallet Keplr is on when the
   player presses Ante / Verify wallet / Change wallet. Before the FIRST binding of that same-address combination the
   panel says so once (`SAME_WALLET_*` below) and the player may continue; separation is recommended for stronger
   operational-security isolation, not required.

   WHO SAYS IT IS THE SAME ADDRESS: the server, in the wallet-challenge answer (`authorizationWallet: true`) -- it holds
   the account's Authorization Wallet and compares it to the wallet about to be linked, before anything is signed. The
   browser asks nothing extra and remembers no wallet to make the comparison.

   WHAT IS REMEMBERED, AND WHERE: one acknowledgement per ACCOUNT x AUTHORIZATION-WALLET ADDRESS, in this browser's
   `localStorage` (the app's `1830juno.` namespace, as the tutorial and notice acknowledgements). The record holds only a
   SHA-256 digest of the account key (`account:<username>`) and the address -- never the username, the address, an id
   or a secret in the clear (a digest only: a guessed pair could be confirmed by whoever reads this browser's storage)
   -- so it survives a reload and a new sign-in (a new session) on this browser, applies to
   every table of that account, and does not carry to another account on the same browser or to a replacement
   Authorization Wallet (a new combination is warned once again). Another device asks once more. Bounded (the newest
   `SAME_WALLET_ACK_MAX` records); an unusable storage degrades to this page's memory, so the warning is never shown in
   a loop within a page. Nothing here is a preference system: it is this one acknowledgement. */

import { sha256Hex } from "../gameEngine/sha256";
import { accountKeyOfUsername } from "../utils/sessionBootstrap";
import type { KeyValueStorage } from "./pendingTx";

export const SAME_WALLET_ACK_STORAGE_KEY = "1830juno.same_wallet_ack.v1";
/** How many account x wallet acknowledgements one browser keeps (the oldest is dropped past this). */
export const SAME_WALLET_ACK_MAX = 16;

/** The warning's words (concise; it is advice, not a refusal). */
export const SAME_WALLET_TITLE = "This is your Authorization Wallet";
export const SAME_WALLET_SENTENCE =
  "You're about to use your Authorization Wallet as this game's financial wallet. That's allowed. For stronger account-security isolation, consider using a separate wallet for game funds.";
export const SAME_WALLET_SWITCH_HINT = "To use another wallet, switch accounts in Keplr, then press the button again.";

/** The one acknowledgement, as this browser keeps it. */
export interface SameWalletAcks {
  has(accountKey: string, wallet: string): boolean;
  acknowledge(accountKey: string, wallet: string): void;
}

/** The digest a record is kept under: neither the account nor the address is stored in the clear (a digest, so someone
 *  who can read this browser's storage could still confirm a pair they already guessed -- no more than the account key
 *  and wallet addresses this app already keeps here in the clear reveal). */
export function sameWalletAckDigest(accountKey: string, wallet: string): string {
  return sha256Hex(`18COSMOS/SAME-WALLET-ACK/v1\n${accountKey}\n${wallet}`);
}

const DIGEST = /^[0-9a-f]{64}$/;

function readList(storage: KeyValueStorage | null): string[] | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(SAME_WALLET_ACK_STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string" && DIGEST.test(entry)).slice(-SAME_WALLET_ACK_MAX) : [];
  } catch {
    return null;
  }
}

/** A store over `storage` (null or throwing: this page's memory only). */
export function createSameWalletAcks(storage: () => KeyValueStorage | null): SameWalletAcks {
  const memory = new Set<string>();
  return {
    has(accountKey, wallet) {
      const digest = sameWalletAckDigest(accountKey, wallet);
      if (memory.has(digest)) return true;
      return (readList(storage()) ?? []).includes(digest);
    },
    acknowledge(accountKey, wallet) {
      const digest = sameWalletAckDigest(accountKey, wallet);
      memory.add(digest);
      const store = storage();
      if (store === null) return;
      /* An unreadable or damaged record is replaced (never kept as a reason to ask again on every page load). */
      const list = readList(store) ?? [];
      const next = [...list.filter((entry) => entry !== digest), digest].slice(-SAME_WALLET_ACK_MAX);
      try {
        store.setItem(SAME_WALLET_ACK_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* Kept in this page's memory: the warning is not shown again here; a reload may ask once more. */
      }
    },
  };
}

let browserStore: SameWalletAcks | null = null;

/** The account an acknowledgement belongs to: the username's account key (`account:<username>`, as an open table
 *  compares accounts). A session that names no username (the development stand-in) shares one key. */
export function sameWalletAccountKey(username: string | null | undefined): string {
  return typeof username === "string" && username.length > 0 ? accountKeyOfUsername(username) : "account:";
}

/** This browser's store (`localStorage` when the page may use it). */
export function browserSameWalletAcks(): SameWalletAcks {
  if (browserStore === null) {
    browserStore = createSameWalletAcks(() => {
      try {
        return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
      } catch {
        return null;
      }
    });
  }
  return browserStore;
}
