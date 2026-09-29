// server/src/escrow/walletTicketFileStore.ts
//
// ==================================================================
//  ESCROW-3B (brief §14): THE WALLET-TICKET LEDGER ON DISK -- ONE DOCUMENT PER GAME, COMPARE-AND-SWAP, NEVER GUESSED AT
// ==================================================================
//
// ESCROW-3A's ledger (`walletTickets.ts`) decides everything -- one outstanding ticket per (game, player_id), epoch
// supersession, derived standing, the freeze -- and asks a `WalletTicketStore` for exactly two things: read a game's
// document with its version, and replace it if the version is still the one read. This is the durable store, and the
// shape LIVE-5 turns into one DynamoDB item per game with `ConditionExpression version = :expected`:
//
//   games/wallet-tickets/<game_id>.json   { format, version, game_id, document: { frozen_at, grants[] } }
//
// What it keeps: each grant's ticket (the value a wallet puts on chain -- public once used, bound to one wallet), the
// wallet, the epoch, when and under which security context it was issued (principal, session family, recovery selector:
// server-private ids, never on the wire), and when and why it stopped standing. What it never keeps: the ticket's
// secret randomness (used once, discarded at issue), a recovery key, a session secret. A revoked or superseded grant is
// KEPT (the audit trail says what ended it); the ledger never deletes.
//
// A document that is not exactly this shape -- torn JSON, a foreign game id, an unknown field, a duplicate epoch, two
// live grants for one seat -- is UNREADABLE: every read throws, so issuing, standing and the freeze all fail closed
// for that game until an operator restores it. Written by LIVE-3B's durable replacement under the data directory's lock.
//
// LIVE-4 (L4-4): AN UNREADABLE LEDGER HAS A CLASS (`formatOf`). The file carries no format version of its own: its
// grants' shape IS its financial protocol's. So a ledger whose every grant is a financial-protocol-2 grant (ESCROW-3B's
// or ESCROW-JOIN's keys) is `older-unread` -- an earlier build's, never damage, never upgraded -- and anything else this
// build cannot read is `corrupt`. A ledger of a NEWER financial protocol cannot be told apart by its bytes alone, and it
// never has to be: its game's financial record names that protocol, and the continuation verdict stops there
// (`financial-protocol`, or the record's own `newer-format`) before the ledger is ever classified (`escrowService.ts`).
// Whatever the class, the document is never overwritten here.

import * as path from "path";

import { nodeStoreFs, type StoreFs } from "../fileLogStore";
import { durableReplace } from "../persistence/durableReplace";
import { GAME_ID_PATTERN } from "../rooms/gameRecord";
import { WALLET_TICKET_FORMAT, type WalletTicketDocument, type WalletTicketGrant, type WalletTicketStore } from "./walletTickets";
import type { FormatFact } from "../../../frontend/src/gameEngine/compat/continuationVerdict";

export const WALLET_TICKET_FILE_FORMAT = "gs-wallet-tickets";

export class WalletTicketStoreUnreadableError extends Error {
  constructor(
    message: string,
    readonly gameId: string,
    /** LIVE-4 (L4-4): `older-unread` for a financial-protocol-2 ledger; `corrupt` for anything else unreadable. */
    readonly format: "corrupt" | "older-unread" = "corrupt",
  ) {
    super(message);
    this.name = "WalletTicketStoreUnreadableError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => key in value);
const time = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timeOrNull = (value: unknown) => value === null || time(value);
/** Financial protocol 2's grant shapes (ESCROW-3B's, then ESCROW-JOIN's `admitted_until_secs`). */
const GRANT_KEYS_3B = ["format", "game_id", "player_id", "epoch", "wallet", "ticket", "issued_at", "issued_under", "revoked_at", "revoke_reason", "frozen_at"];
const GRANT_KEYS_JOIN = [...GRANT_KEYS_3B, "admitted_until_secs"];
/** Financial protocol 3 (ESCROW-4): + the verified wallet proof, the registered consent keys, the relink origin and the
 *  chain's game-id floor when the ticket was minted. THE ONLY SHAPE THIS BUILD READS: a protocol-2 grant is never
 *  upgraded or reinterpreted as a v3 one (no money game was ever created under 2, so nothing is stranded -- the ESCROW-4
 *  amendment's no-migration rule); its file is refused as unreadable, which fails closed like any unreadable ledger. */
const GRANT_KEYS = [...GRANT_KEYS_JOIN, "proof", "consent_keys", "relinked_from", "create_floor"];
const HEX = (bytes: number) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);
const CONSENT_KEY = /^0[23][0-9a-f]{64}$/;

/** ESCROW-4: a recorded proof is exactly the wallet-link route's record, for the grant's own wallet. */
function isProof(value: unknown, wallet: unknown): boolean {
  if (value === null) return true;
  return (
    isObject(value) &&
    exact(value, ["kind", "wallet", "pubkey", "challenge_digest", "proof_hash", "verified_at"]) &&
    value.kind === "adr036" &&
    value.wallet === wallet &&
    typeof value.pubkey === "string" &&
    CONSENT_KEY.test(value.pubkey) &&
    typeof value.challenge_digest === "string" &&
    HEX(32).test(value.challenge_digest) &&
    typeof value.proof_hash === "string" &&
    HEX(32).test(value.proof_hash) &&
    time(value.verified_at)
  );
}

/** A grant of financial protocol 2 (for the operator's message only: it is refused like any unreadable grant). */
const isProtocol2Grant = (value: unknown): boolean => isObject(value) && (exact(value, GRANT_KEYS_JOIN) || exact(value, GRANT_KEYS_3B));

function isGrant(value: unknown, gameId: string): value is WalletTicketGrant {
  if (!isObject(value) || !exact(value, GRANT_KEYS)) return false;
  if (!timeOrNull(value.admitted_until_secs)) return false;
  const keys = value.consent_keys;
  if (!isProof(value.proof, value.wallet)) return false;
  if (!Array.isArray(keys) || keys.length > 8 || !keys.every((key) => typeof key === "string" && CONSENT_KEY.test(key)) || new Set(keys).size !== keys.length) return false;
  if (!(value.relinked_from === null || (Number.isSafeInteger(value.relinked_from) && (value.relinked_from as number) >= 1 && (value.relinked_from as number) < (value.epoch as number)))) return false;
  if (!(value.create_floor === null || (typeof value.create_floor === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value.create_floor)))) return false;
  const under = value.issued_under;
  return (
    value.format === WALLET_TICKET_FORMAT &&
    value.game_id === gameId &&
    typeof value.player_id === "string" &&
    /^p-[0-9A-Za-z_-]{1,32}$/.test(value.player_id) &&
    Number.isSafeInteger(value.epoch) &&
    (value.epoch as number) >= 1 &&
    typeof value.wallet === "string" &&
    value.wallet.length > 0 &&
    value.wallet.length <= 128 &&
    typeof value.ticket === "string" &&
    /^[0-9a-f]{64}$/.test(value.ticket) &&
    time(value.issued_at) &&
    isObject(under) &&
    exact(under, ["principal_id", "family_id", "recovery_selector"]) &&
    typeof under.principal_id === "string" &&
    typeof under.family_id === "string" &&
    typeof under.recovery_selector === "string" &&
    timeOrNull(value.revoked_at) &&
    (value.revoke_reason === null || value.revoke_reason === "superseded" || value.revoke_reason === "security-event" || value.revoke_reason === "seat-lost") &&
    (value.revoked_at === null) === (value.revoke_reason === null) &&
    timeOrNull(value.frozen_at)
  );
}

/** The document is exactly the ledger's shape, and obeys its invariants. */
export function isWalletTicketDocument(value: unknown, gameId: string): value is WalletTicketDocument {
  if (!isObject(value) || !exact(value, ["frozen_at", "grants"]) || !timeOrNull(value.frozen_at) || !Array.isArray(value.grants)) return false;
  const grants = value.grants as unknown[];
  if (!grants.every((grant) => isGrant(grant, gameId))) return false;
  const typed = grants as WalletTicketGrant[];
  const seen = new Set<string>();
  const liveBySeat = new Map<string, number>();
  for (const grant of typed) {
    const key = `${grant.player_id}#${grant.epoch}`;
    if (seen.has(key)) return false; // one epoch per seat, once
    seen.add(key);
    if (grant.revoked_at === null) liveBySeat.set(grant.player_id, (liveBySeat.get(grant.player_id) ?? 0) + 1);
    if (grant.frozen_at !== null && value.frozen_at === null) return false; // a frozen grant implies a frozen game
  }
  return [...liveBySeat.values()].every((count) => count <= 1); // one outstanding ticket per seat
}

export function walletTicketDirectory(dataDir: string): string {
  return path.join(dataDir, "games", "wallet-tickets");
}

export function createFileWalletTicketStore(
  dataDir: string,
  options: { fs?: StoreFs; platform?: string; writerCheck?: () => Promise<boolean>; warn?: (line: string) => void } = {},
): WalletTicketStore & { readonly directory: string; formatOf(gameId: string): Promise<FormatFact> } {
  const io = options.fs ?? nodeStoreFs;
  const directory = walletTicketDirectory(dataDir);
  // eslint-disable-next-line no-console
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const fileOf = (gameId: string) => path.join(directory, `${gameId}.json`);
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const run = (chains.get(key) ?? Promise.resolve()).then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  };

  async function read(gameId: string): Promise<{ version: number; document: WalletTicketDocument }> {
    if (!GAME_ID_PATTERN.test(gameId)) throw new WalletTicketStoreUnreadableError(`${gameId} is not a game id`, gameId);
    let raw: Buffer;
    try {
      raw = await io.readFile(fileOf(gameId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 0, document: { frozen_at: null, grants: [] } };
      throw error;
    }
    return parseWalletTicketFile(raw.toString("utf8"), gameId);
  }

  return {
    directory,
    load(gameId) {
      return serial(gameId, () => read(gameId));
    },
    put(gameId, document, expected) {
      return serial(gameId, async () => {
        const current = await read(gameId); // an unreadable document throws: it is never overwritten
        if (current.version !== expected) return "conflict";
        if (!isWalletTicketDocument(document, gameId)) throw new WalletTicketStoreUnreadableError(`refusing to write a ledger for ${gameId} that breaks its invariants`, gameId);
        if (options.writerCheck !== undefined && !(await options.writerCheck().catch(() => false))) return "conflict";
        await io.mkdir(directory);
        const outcome = await durableReplace(io, fileOf(gameId), Buffer.from(`${JSON.stringify({ format: WALLET_TICKET_FILE_FORMAT, version: expected + 1, game_id: gameId, document })}\n`, "utf8"), { platform: options.platform, warn });
        /* LIVE-5 L5-2 (F-L5-6): an unresolved replacement is UNCERTAIN -- never reported as a definite "conflict". */
        return outcome.kind === "committed" ? "committed" : outcome.kind === "uncertain" ? "uncertain" : "conflict";
      });
    },
    async listGames() {
      let names: string[];
      try {
        names = await io.readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return names.filter((name) => name.endsWith(".json") && GAME_ID_PATTERN.test(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort();
    },
    /* LIVE-4 (L4-4): the ledger's class, without throwing on its content (no file: an empty ledger, current). */
    formatOf(gameId) {
      return serial(gameId, async (): Promise<FormatFact> => {
        try {
          await read(gameId);
          return "current";
        } catch (error) {
          if (error instanceof WalletTicketStoreUnreadableError) return error.format;
          throw error;
        }
      });
    },
  };
}

/** A stored ledger's text, read exactly as this store reads its file: the version and document, or
 *  `WalletTicketStoreUnreadableError` with its class (LIVE-5 L5-2: shared with the DynamoDB adapter, which stores the same
 *  envelope as an item's body). */
export function parseWalletTicketFile(text: string, gameId: string): { version: number; document: WalletTicketDocument } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WalletTicketStoreUnreadableError(`wallet-tickets/${gameId}.json is not JSON`, gameId);
  }
  const format = walletTicketFileFormat(parsed, gameId);
  if (format !== "current" || !isObject(parsed)) {
    const document = isObject(parsed) && isObject(parsed.document) ? parsed.document : null;
    if (document !== null && Array.isArray(document.grants) && document.grants.some(isProtocol2Grant)) {
      throw new WalletTicketStoreUnreadableError(
        `wallet-tickets/${gameId}.json holds grants of financial protocol 2 (before ESCROW-4); this build reads protocol 3 only and never reinterprets them`,
        gameId,
        format === "older-unread" ? "older-unread" : "corrupt",
      );
    }
    throw new WalletTicketStoreUnreadableError(`wallet-tickets/${gameId}.json is not this game's ticket ledger`, gameId);
  }
  const document = parsed.document as WalletTicketDocument;
  return { version: parsed.version as number, document: { frozen_at: document.frozen_at, grants: [...document.grants] } };
}

/** LIVE-4 (L4-4): the class of a parsed ledger file for `gameId`: `current` (exactly this build's ledger), `older-unread`
 *  (a well-formed envelope whose every grant is a financial-protocol-2 grant), or `corrupt`. Never `newer`: see above. */
export function walletTicketFileFormat(parsed: unknown, gameId: string): FormatFact {
  if (
    !isObject(parsed) ||
    !exact(parsed, ["format", "version", "game_id", "document"]) ||
    parsed.format !== WALLET_TICKET_FILE_FORMAT ||
    parsed.game_id !== gameId ||
    !Number.isSafeInteger(parsed.version) ||
    (parsed.version as number) < 1
  ) {
    return "corrupt";
  }
  if (isWalletTicketDocument(parsed.document, gameId)) return "current";
  const document = parsed.document;
  if (isObject(document) && exact(document, ["frozen_at", "grants"]) && Array.isArray(document.grants) && document.grants.length > 0 && document.grants.every(isProtocol2Grant)) return "older-unread";
  return "corrupt";
}
