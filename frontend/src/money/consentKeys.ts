// frontend/src/money/consentKeys.ts
//
// ==================================================================
//  ESCROW-4 (F-3): THE SEAT'S CONSENT SIGNING KEY -- MADE IN THIS BROWSER, KEPT IN THIS BROWSER, NEVER SENT
// ==================================================================
//
// A money seat has two keys. The WALLET (Keplr) owns the deposit and the payout: it signs every transaction that moves
// JUNO, and the chain authorizes those by its address. The CONSENT KEY is a separate secp256k1 key, one per seat per
// table, made here: it signs only two things, a CONSENT to the settlement Juno has recorded (release now instead of
// waiting for the challenge window) and an ANNUL (every seat agreeing to cancel a started game). Its power is bounded:
// it can never move a deposit, change the payout wallet, or make a settlement -- only the server's settlement key can
// record one, and a consent only approves the one already on chain.
//
// POLICY (preflight P5-P7, brief §17):
//   - made by this browser; the private key never leaves it (the server gets the PUBLIC key only, with "Confirm it's
//     you"); there is no "backup secret" to copy in this phase;
//   - kept durably (IndexedDB, awaiting the transaction's completion) BEFORE the deposit that carries it is signed --
//     `create` resolves only once the record is stored, and the deposit flow refuses to continue otherwise;
//   - losing it loses nothing: the settlement pays through the challenge window without any consent, and "Use this
//     device for signing" (a new key here + the wallet's SetConsentKey on chain) moves signing to another device;
//   - signing out removes this browser's keys by default, after saying so (`ProfileMenu`).
//
// Signatures are 64-byte r‖s, low-S (cosmjs/elliptic `canonical`), over a 32-byte digest this browser computed itself
// with the tagged digests (`consentDigestV1` / `annulDigestV1`) -- never over bytes a server supplied.

import { Random, Secp256k1 } from "@cosmjs/crypto";
import { fromHex, toHex } from "@cosmjs/encoding";

export const CONSENT_KEY_DB = "1830juno.money_keys.v1";
const STORE = "consentKeys";
const PUBKEY = /^0[23][0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export interface ConsentKeyScope {
  readonly chainId: string;
  readonly contract: string;
  readonly gameId: string;
  readonly playerId: string;
  /** The wallet the seat is linking (or linked), for the record only. */
  readonly wallet: string | null;
}

export interface ConsentKeyRecord extends ConsentKeyScope {
  readonly v: 1;
  /** Compressed secp256k1 public key, lowercase hex (what the chain and the server see). */
  readonly pubkey: string;
  /** 32-byte private key, lowercase hex. Never leaves this browser. */
  readonly privkey: string;
  readonly createdAt: number;
}

/** Where records live: IndexedDB in a browser, a map in a test. `put` resolves only once the record is durable. */
export interface ConsentKeyVault {
  list(): Promise<ConsentKeyRecord[]>;
  get(pubkey: string): Promise<ConsentKeyRecord | null>;
  put(record: ConsentKeyRecord): Promise<void>;
  remove(pubkey: string): Promise<void>;
  clear(): Promise<void>;
}

const isRecord = (value: unknown): value is ConsentKeyRecord => {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    typeof r.pubkey === "string" &&
    PUBKEY.test(r.pubkey) &&
    typeof r.privkey === "string" &&
    /^[0-9a-f]{64}$/.test(r.privkey) &&
    typeof r.chainId === "string" &&
    typeof r.contract === "string" &&
    typeof r.gameId === "string" &&
    typeof r.playerId === "string" &&
    (r.wallet === null || typeof r.wallet === "string") &&
    typeof r.createdAt === "number"
  );
};

export function memoryConsentKeyVault(): ConsentKeyVault & { readonly records: Map<string, ConsentKeyRecord> } {
  const records = new Map<string, ConsentKeyRecord>();
  return {
    records,
    list: async () => Array.from(records.values()),
    get: async (pubkey) => records.get(pubkey) ?? null,
    put: async (record) => {
      records.set(record.pubkey, record);
    },
    remove: async (pubkey) => {
      records.delete(pubkey);
    },
    clear: async () => {
      records.clear();
    },
  };
}

/** The browser's vault, or null when this page has no IndexedDB (a private mode that blocks it, an old browser). */
export function indexedDbConsentKeyVault(factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB): ConsentKeyVault | null {
  if (factory === undefined) return null;
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (opening === null) {
      opening = new Promise<IDBDatabase>((resolve, reject) => {
        let request: IDBOpenDBRequest;
        try {
          request = factory.open(CONSENT_KEY_DB, 1);
        } catch (error) {
          reject(error);
          return;
        }
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "pubkey" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
        request.onblocked = () => reject(new Error("IndexedDB open blocked"));
      }).catch((error) => {
        opening = null;
        throw error;
      });
    }
    return opening;
  };
  /** One transaction, resolved on its COMPLETION (the record is durable), never on the request's success alone. */
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest | null): Promise<T | undefined> => {
    const db = await open();
    return new Promise<T | undefined>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = (db.transaction as (names: string, mode: IDBTransactionMode, options?: { durability?: string }) => IDBTransaction)(STORE, mode, { durability: "strict" });
      } catch {
        tx = db.transaction(STORE, mode);
      }
      let result: T | undefined;
      const request = work(tx.objectStore(STORE));
      if (request !== null) request.onsuccess = () => (result = request.result as T);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  };
  return {
    list: async () => ((await run<unknown[]>("readonly", (store) => store.getAll())) ?? []).filter(isRecord),
    get: async (pubkey) => {
      const found = await run<unknown>("readonly", (store) => store.get(pubkey));
      return isRecord(found) ? found : null;
    },
    put: async (record) => {
      await run("readwrite", (store) => store.put(record));
    },
    remove: async (pubkey) => {
      await run("readwrite", (store) => store.delete(pubkey));
    },
    clear: async () => {
      await run("readwrite", (store) => store.clear());
    },
  };
}

export type CreatedConsentKey = { readonly ok: true; readonly pubkey: string } | { readonly ok: false; readonly reason: string };

export interface ConsentKeys {
  /** Whether this browser can keep a signing key at all. */
  readonly available: boolean;
  /** A new key for this seat, STORED before it is returned: a deposit carrying it can never outlive it here. */
  create(scope: ConsentKeyScope): Promise<CreatedConsentKey>;
  holds(pubkey: string | null | undefined): Promise<boolean>;
  /** This browser's keys for a seat (newest first). */
  forSeat(gameId: string, playerId: string): Promise<ConsentKeyRecord[]>;
  /** A 64-byte low-S signature (lowercase hex) over a 32-byte digest, by the key `pubkey`, or null (not held here). */
  signDigest(pubkey: string, digestHex: string): Promise<string | null>;
  count(): Promise<number>;
  /** Remove every key this browser keeps (sign-out); how many were removed. */
  removeAll(): Promise<number>;
}

export function createConsentKeys(vault: ConsentKeyVault | null, now: () => number = () => Date.now()): ConsentKeys {
  const unavailable = "This browser can't keep a signing key (its site storage is blocked or unavailable), so it can't fund a seat. Use a browser that allows site storage.";
  return {
    available: vault !== null,
    async create(scope) {
      if (vault === null) return { ok: false, reason: unavailable };
      let privkey: Uint8Array | null = null;
      let pubkey = "";
      for (let attempt = 0; attempt < 8 && privkey === null; attempt += 1) {
        const candidate = Random.getBytes(32);
        try {
          const keypair = await Secp256k1.makeKeypair(candidate); // refuses 0 and anything >= the curve order
          pubkey = toHex(Secp256k1.compressPubkey(keypair.pubkey));
          privkey = candidate;
        } catch {
          /* astronomically rare: draw again */
        }
      }
      if (privkey === null || !PUBKEY.test(pubkey)) return { ok: false, reason: "This browser couldn't make a signing key. Try again." };
      const record: ConsentKeyRecord = { v: 1, ...scope, pubkey, privkey: toHex(privkey), createdAt: now() };
      try {
        await vault.put(record);
        const back = await vault.get(pubkey);
        if (back === null || back.privkey !== record.privkey) return { ok: false, reason: "This browser didn't keep the signing key it made, so nothing was sent. Try again." };
      } catch {
        return { ok: false, reason: unavailable };
      }
      /* Ask the browser to keep this site's storage through pressure (best effort; nothing depends on the answer). */
      try {
        void (navigator as Navigator & { storage?: { persist?: () => Promise<boolean> } }).storage?.persist?.();
      } catch {
        /* not offered here */
      }
      return { ok: true, pubkey };
    },
    async holds(pubkey) {
      if (vault === null || typeof pubkey !== "string" || !PUBKEY.test(pubkey)) return false;
      try {
        return (await vault.get(pubkey)) !== null;
      } catch {
        return false;
      }
    },
    async forSeat(gameId, playerId) {
      if (vault === null) return [];
      try {
        return (await vault.list()).filter((record) => record.gameId === gameId && record.playerId === playerId).sort((a, b) => b.createdAt - a.createdAt);
      } catch {
        return [];
      }
    },
    async signDigest(pubkey, digestHex) {
      if (vault === null || !PUBKEY.test(pubkey) || !DIGEST.test(digestHex)) return null;
      let record: ConsentKeyRecord | null;
      try {
        record = await vault.get(pubkey);
      } catch {
        return null;
      }
      if (record === null) return null;
      const signature = await Secp256k1.createSignature(fromHex(digestHex), fromHex(record.privkey));
      /* The chain's 64 bytes: r, then s, each already padded to 32 bytes. They are NOT wrapped in a
         `Secp256k1Signature` again: its constructor refuses a padded half that begins with a zero byte, which about one
         signature in a hundred has, and RFC 6979 makes the same key sign the same digest the same way on every retry
         (owner broad gate, ESCROW-4 report §21). */
      return toHex(signature.r(32)) + toHex(signature.s(32));
    },
    async count() {
      if (vault === null) return 0;
      try {
        return (await vault.list()).length;
      } catch {
        return 0;
      }
    },
    async removeAll() {
      if (vault === null) return 0;
      try {
        const count = (await vault.list()).length;
        await vault.clear();
        return count;
      } catch {
        return 0;
      }
    },
  };
}

let browserKeys: ConsentKeys | null = null;

/** This browser's signing keys (IndexedDB), created once. */
export function browserConsentKeys(): ConsentKeys {
  if (browserKeys === null) browserKeys = createConsentKeys(indexedDbConsentKeyVault());
  return browserKeys;
}

/** Tests: install a vault (or null to go back to the browser's). */
export function installConsentKeysForTests(keys: ConsentKeys | null): void {
  browserKeys = keys;
}
