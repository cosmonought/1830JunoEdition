// server/src/persistence/conformance/fixtures.ts
//
// LIVE-5 L5-1: deterministic, valid values of every stored shape, built through the production constructors where one
// exists (`createRecord`, `newFinancialRecord`, `newChainIntent`, `makeHold`), so a fixture is exactly what the server
// itself would store. Ids are derived from a counter, never random: a conformance run is the same run every time.

import type { ServerLogEntry } from "../../../../frontend/src/utils/roomSession";
import { resolveVariants } from "../../../../frontend/src/gameEngine/gameVariants";
import { createRecord } from "../../rooms/roomService";
import { GAME_ID_PATTERN, JOIN_CODE_ALPHABET, PLAYER_ID_PATTERN, type GameRecord } from "../../rooms/gameRecord";
import { makeHold, type GameHold } from "../../rooms/holdStore";
import { newFinancialRecord, type FinancialGameRecord } from "../../escrow/moneyLifecycle";
import { currentMoneyContinuation } from "../../escrow/moneyContinuation";
import { newChainIntent, junoInstanceOf, type ChainIntentRecord } from "../../escrow/chainIntents";
import { WALLET_TICKET_FORMAT, type WalletTicketDocument, type WalletTicketGrant } from "../../escrow/walletTickets";
import type { LinkCredential, Principal, Profile, Session, SessionFamily } from "../../identity/store";
import { createHash } from "crypto";

import { familyIdOf, mintPrincipalId, mintProfileId, mintRecoveryKey, mintSecret, mintSessionId, secretHash } from "../../identity/ids";
import { T0 } from "./harness";

const B32 = "0123456789abcdefghjkmnpqrstvwxyz";
const base32 = (n: number, width: number): string => {
  let out = "";
  let rest = n;
  for (let at = 0; at < width; at += 1) {
    out = B32[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
};

/** The n-th fixed game id (`g_` + 25 base32 + a valid final character). */
export function gameId(n: number): string {
  const id = `g_${base32(n, 25)}0`;
  if (!GAME_ID_PATTERN.test(id)) throw new Error(`fixture game id ${id} is not a game id`);
  return id;
}

export function playerId(n: number): string {
  const id = `p-${base32(n, 16)}`;
  if (!PLAYER_ID_PATTERN.test(id)) throw new Error(`fixture player id ${id} is not a player id`);
  return id;
}

export function joinCode(n: number): string {
  const a = JOIN_CODE_ALPHABET;
  const pick = (k: number) => a[Math.floor(n / a.length ** k) % a.length];
  return `JUNO-${pick(0)}${pick(1)}${pick(2)}${pick(3)}-AAAA`;
}

export const PRINCIPAL = "pr_conformanceconformance01";

/* ---- log entries: the stored shape (`ServerLogEntry`: index, id, actor, payload as JSON TEXT, at, derived,
        submission_id). The store interprets only `index` and `id`; the payload's bytes must round-trip exactly. ---- */

export function entries(from: number, count: number, tag = "s0"): ServerLogEntry[] {
  return Array.from({ length: count }, (_, k) => {
    const index = from + k;
    const payload = JSON.stringify({ type: "CONFORMANCE", n: index, text: `entry ${index} \u2014 "quoted", back\\slash, ✓ 𝄞`, path: [[1, 2], [3]] });
    const entry: Record<string, unknown> = { index, id: `${tag}-${index}`, actor: k === 0 ? "p-0000000000000000" : "SERVER", payload, at: 1_780_000_000_000 + index };
    if (k === 0) entry.submission_id = `sub-${tag}-${index}`;
    else entry.derived = true;
    return entry as unknown as ServerLogEntry;
  });
}

/** One entry whose payload is `bytes` long (the frame cap is 32 KiB: a stored entry can be nearly that). */
export function largeEntry(index: number, bytes: number): ServerLogEntry {
  const filler = "x".repeat(Math.max(0, bytes - 64));
  return { index, id: `big-${index}`, actor: "p-0000000000000000", payload: JSON.stringify({ type: "LARGE", filler }), at: 1_780_000_000_000 + index } as unknown as ServerLogEntry;
}

/* ---- GameRecord ---- */

export function gameRecord(n: number, now = T0): GameRecord {
  const made = createRecord({
    gameId: gameId(n),
    joinCode: joinCode(n),
    principalId: PRINCIPAL,
    now,
    visibility: "private",
    exactPlayers: null,
    variants: resolveVariants({}),
    nickname: "Conformance",
    color: null,
    hostPlayerId: playerId(n),
  });
  if (!made.ok || made.record === null) throw new Error("createRecord refused the conformance fixture");
  return made.record;
}

/** The record's next version (what an actor's commit writes). */
export function nextRecord(record: GameRecord, at: number): GameRecord {
  return { ...record, record_version: record.record_version + 1, last_activity_at: at };
}

/* ---- holds ---- */

export function hold(n: number, code: GameHold["code"] = "log-corrupt", at = T0, detail = "conformance hold"): GameHold {
  return makeHold({ gameId: gameId(n), code, detail, at, source: "load", build: "conformance", rulesEngineVersion: 11, evidence: { log_entries: 3 } });
}

/* ---- financial records ---- */

export function financial(n: number, now = T0): FinancialGameRecord {
  return newFinancialRecord(gameId(n), currentMoneyContinuation(), now);
}

export function nextFinancial(record: FinancialGameRecord, at: number): FinancialGameRecord {
  return { ...record, record_version: record.record_version + 1, updated_at: at, last_activity_at: at };
}

/* ---- chain intents ---- */

export const INSTANCE = junoInstanceOf("uni-7", "juno1conformanceconformanceconformance0000", "7");

export function intent(n: number, seq: number, now = T0, message = "{}"): ChainIntentRecord {
  const s = String(seq);
  return newChainIntent({
    game_id: gameId(n),
    instance: INSTANCE,
    key: { op: "settle", seq: s },
    subject: { kind: "digest", digests: [] },
    op: { kind: "settle", chain_game_id: "7", seq: s, log_len: 10 + seq, settle_digest: "ab".repeat(32), signer_key_id: 1 },
    msg_json: message,
    now,
  });
}

export function nextIntent(record: ChainIntentRecord, at: number): ChainIntentRecord {
  return { ...record, record_version: record.record_version + 1, updated_at: at, retry: { failures: record.retry.failures + 1, next_at: at + 1000 } };
}

/* ---- wallet tickets ---- */

export function grant(n: number, seat: number, epoch: number, at = T0): WalletTicketGrant {
  return {
    format: WALLET_TICKET_FORMAT,
    game_id: gameId(n),
    player_id: playerId(seat),
    epoch,
    wallet: `juno1wallet${seat}conformance`,
    ticket: (seat * 16 + epoch).toString(16).padStart(2, "0").repeat(32),
    issued_at: at,
    issued_under: { principal_id: PRINCIPAL, family_id: "sf_conformance", recovery_selector: "rk_conformance" },
    revoked_at: null,
    revoke_reason: null,
    frozen_at: null,
    admitted_until_secs: null,
    proof: null,
    consent_keys: [],
    relinked_from: null,
    create_floor: null,
  };
}

export function ticketDocument(grants: readonly WalletTicketGrant[], frozenAt: number | null = null): WalletTicketDocument {
  return { frozen_at: frozenAt, grants };
}

/* ---- identity (shapes as `identityJournal.test.ts` builds them; ids minted from a seeded source) ---- */

/** A deterministic random source: the same seed always mints the same ids and secrets. */
export function seededRandom(seed: string): (size: number) => Buffer {
  let counter = 0;
  return (size: number) => {
    const out = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const block = createHash("sha256").update(`${seed}#${counter++}`).digest();
      block.copy(out, filled, 0, Math.min(block.length, size - filled));
      filled += block.length;
    }
    return out;
  };
}

export interface IdentitySet {
  readonly principal: Principal;
  /** The same principal, bound to `profile` (what a profile creation commits). */
  readonly profiledPrincipal: Principal;
  readonly profile: Profile;
  readonly session: Session;
  readonly family: SessionFamily;
  readonly link: LinkCredential;
}

export function identitySet(n: number): IdentitySet {
  const random = seededRandom(`identity-${n}`);
  const principalId = mintPrincipalId(random);
  const sessionId = mintSessionId(random);
  const profileId = mintProfileId(random);
  const key = mintRecoveryKey(random);
  const principal: Principal = { principal_id: principalId, kind: "unprofiled", status: "active", created_at: T0, activated_at: T0, last_seen_at: T0, account_link: null };
  const profiledPrincipal: Principal = { ...principal, kind: "profile", account_link: profileId };
  const profile: Profile = {
    profile_id: profileId,
    principal_id: principalId,
    display_name: `Conf ${n}`,
    created_at: T0,
    status: "active",
    recovery_selector: key.selector,
    recovery_hash: secretHash(key.secret),
    recovery_rotated_at: T0,
    schema: 1,
  };
  const session: Session = {
    session_id: sessionId,
    principal_id: principalId,
    secret_hash: secretHash(mintSecret(random)),
    created_at: T0,
    last_seen_at: T0,
    expires_at: T0 + 30 * 86_400_000,
    revoked_at: null,
    revoke_reason: null,
    rotated_to: null,
    family_id: familyIdOf(sessionId),
  };
  const family: SessionFamily = { family_id: session.family_id, principal_id: principalId, created_at: T0, origin: "bootstrap", revoked_at: null, revoke_reason: null };
  const link: LinkCredential = { link_hash: secretHash(mintSecret(random)), profile_id: profileId, created_at: T0, expires_at: T0 + 600_000, consumed_at: null };
  return { principal, profiledPrincipal, profile, session, family, link };
}

/** Another session of the same principal and family (a rotation successor or a second device's session). */
export function anotherSession(set: IdentitySet, tag: string, over: Partial<Session> = {}): Session {
  const random = seededRandom(`session-${set.session.session_id}-${tag}`);
  return { ...set.session, session_id: mintSessionId(random), secret_hash: secretHash(mintSecret(random)), ...over };
}

/* ---- P3-ACCT: username/password and the persisted wallet (storage shapes only: the hash need not be a real scrypt) ---- */

/** A well-formed stored password hash (fixed bytes; storage tests never verify it). */
export const FIXTURE_PASSWORD_HASH = `scrypt$1$10$1$1$${Buffer.alloc(16, 7).toString("base64url")}$${Buffer.alloc(32, 9).toString("base64url")}`;
/** P3-ACCT POLICY: a second, different hash (a replaced password's next generation). */
export const FIXTURE_PASSWORD_HASH_2 = `scrypt$1$10$1$1$${Buffer.alloc(16, 8).toString("base64url")}$${Buffer.alloc(32, 10).toString("base64url")}`;
/** A canonical Juno wallet address (20-byte data). */
export const FIXTURE_WALLET = "juno1qyqszqgpqyqszqgpqyqszqgpqyqszqgpypz92q";
export const FIXTURE_WALLET_2 = "juno1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz49yqpk";

/** `set`'s profile as schema 2, with `login` (a username) and/or a wallet. */
export function accountProfile(set: IdentitySet, over: { readonly login?: string | null; readonly wallet?: string | null; readonly at?: number } = {}): Profile {
  const at = over.at ?? T0;
  const login = over.login ?? null;
  const wallet = over.wallet ?? null;
  return {
    ...set.profile,
    schema: 2,
    login_key: login === null ? null : login.normalize("NFKC").toLowerCase().normalize("NFKC"),
    login_name: login,
    password_hash: login === null ? null : FIXTURE_PASSWORD_HASH,
    password_set_at: login === null ? null : at,
    wallet_address: wallet,
    wallet_verified_at: wallet === null ? null : at,
  };
}
