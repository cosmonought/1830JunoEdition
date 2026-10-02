// server/src/tools/walletGrants.ts
//
// ==================================================================
//  JX-3B (C-4a): ONE GAME'S WALLET GRANTS, READ-ONLY, REDACTED -- `gamesDoctor wallet-grants` / `gamesDoctor aws wallet-grants`
// ==================================================================
//
// The evidence a live JX-3 run files after each wallet step, without a raw table dump: every grant of one game's ticket
// ledger (`walletTickets.ts`) with its epoch, seat, wallet, proof (kind, the signing key, `challenge_digest`,
// `proof_hash`, `verified_at`), whether it stands NOW, its revoke reason and freeze -- judged exactly as the server judges
// it (the ledger's own `snapshot`, over a read-only store, with identity's `securityStanding` and the GameRecord's seat).
//
// What it never prints: session ids, cookies, recovery selectors or keys, consent private keys (the ledger holds none),
// or raw `pr_` / `sf_` ids. The security context a grant was issued under is shown as STABLE FINGERPRINTS (a tagged
// SHA-256 prefix: two grants under the same family show the same fingerprint, so a re-home is visible) and as its
// verdict -- "current" or "ended (family | recovery-key | profile | principal)". The ticket is shown as a fingerprint too
// (a re-adopted ticket shows the same one). Public material is printed as it is: the wallet, the signing public key and
// the proof digests (an auditor recomputes them with `jx3VerifyLink`).
//
// Reads only. File mode reads the ledger, the GameRecord and the identity snapshot + journal through read-only stores
// (safe beside a running server: it shows what was on disk at that moment). AWS mode reads the game table's
// `GAME#<g>/TICKETS` and record items and, from the identity table, only the principal, profile and family items the
// grants' contexts name (consistent GetItems with the operator's own credentials; no scan); if identity cannot be read,
// the grants are still printed, standing "not evaluated".

import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";

import { IDENTITY_FILE } from "../identity/fileStore";
import { IDENTITY_JOURNAL_FILE, parseSnapshotDocument, scanJournal } from "../identity/journalStore";
import { IdentityService, type SecurityStanding } from "../identity/sessions";
import { checkSnapshot, createMemoryIdentityStore, IdentityIndex, type IdentitySnapshot } from "../identity/store";
import { GAME_ID_PATTERN, seatOf, type GameRecord } from "../rooms/gameRecord";
import { createWalletTicketLedger, type WalletTicketContext, type WalletTicketDocument, type WalletTicketGrant, type WalletTicketStore } from "../escrow/walletTickets";

export const WALLET_GRANTS_VIEW_FORMAT = "18COSMOS/JX3B/WALLET-GRANTS/v1";
const FINGERPRINT_TAG = "18COSMOS/JX3B/REDACT/v1";

/** A stable, non-reversible fingerprint of a server-private id (or a ticket): `<kind>:<12 hex>`. */
export function fingerprint(kind: "principal" | "family" | "ticket", value: string): string {
  return `${kind}:${createHash("sha256").update(`${FINGERPRINT_TAG}\u0000${kind}\u0000${value}`).digest("hex").slice(0, 12)}`;
}

export type ContextVerdict = "current" | "ended:principal" | "ended:profile" | "ended:family" | "ended:recovery-key" | "not-evaluated";

export interface WalletGrantRow {
  readonly player_id: string;
  readonly epoch: number;
  /** The newest grant of its seat (only the newest can stand). */
  readonly newest: boolean;
  readonly wallet: string;
  readonly ticket: string;
  readonly issued_at: number;
  readonly relinked_from: number | null;
  readonly proof: { readonly kind: string; readonly wallet: string; readonly pubkey: string; readonly challenge_digest: string; readonly proof_hash: string; readonly verified_at: number } | null;
  readonly consent_keys: number;
  readonly admitted_until_secs: number | null;
  /** Whether the grant stands NOW, as the server judges it (null: identity or the GameRecord was not read). */
  readonly standing: boolean | null;
  readonly revoked_at: number | null;
  readonly revoke_reason: string | null;
  readonly frozen_at: number | null;
  readonly context: { readonly principal: string; readonly family: string; readonly verdict: ContextVerdict };
  /** Whether the issuing principal still holds the seat (null: the GameRecord was not read). */
  readonly seat_held: boolean | null;
}

export interface WalletGrantsView {
  readonly format: typeof WALLET_GRANTS_VIEW_FORMAT;
  readonly game_id: string;
  readonly source: "file" | "aws";
  readonly ledger_version: number;
  readonly frozen_at: number | null;
  readonly identity: { readonly read: boolean; readonly detail: string };
  readonly record: { readonly read: boolean; readonly detail: string };
  readonly grants: readonly WalletGrantRow[];
}

export interface WalletGrantsInput {
  readonly gameId: string;
  readonly source: "file" | "aws";
  readonly version: number;
  readonly document: WalletTicketDocument;
  /** Identity's verdict on a context (null: identity could not be read -- `identityDetail` says why). */
  readonly standing: ((context: WalletTicketContext) => SecurityStanding) | null;
  readonly identityDetail: string;
  /** The game's record (null: not read -- `recordDetail` says why). */
  readonly record: GameRecord | null;
  readonly recordDetail: string;
  readonly now: number;
}

const verdictOf = (standing: SecurityStanding): ContextVerdict => (standing.kind === "standing" ? "current" : `ended:${standing.why}`);

/** The redacted view of one game's ledger. Standing is the ledger's own judgement (its `snapshot`) over a read-only
 *  store; nothing is written. */
export async function walletGrantsView(input: WalletGrantsInput): Promise<WalletGrantsView> {
  const contextOf = (grant: WalletTicketGrant): WalletTicketContext => ({ principalId: grant.issued_under.principal_id, familyId: grant.issued_under.family_id, recoverySelector: grant.issued_under.recovery_selector });
  const holdsSeat = (principalId: string, playerId: string): boolean | null => (input.record === null ? null : seatOf(input.record, principalId)?.player_id === playerId);
  let standingByEpoch: Map<string, boolean> | null = null;
  /* Standing needs both halves the server reads: identity (the context) and the GameRecord (the seat). */
  if (input.standing !== null && input.record !== null) {
    const standing = input.standing;
    const readOnly: WalletTicketStore = {
      load: async () => ({ version: input.version, document: input.document }),
      put: async () => {
        throw new Error("walletGrantsView is read-only");
      },
    };
    const ledger = createWalletTicketLedger({
      store: readOnly,
      standing,
      holdsSeat: (_gameId, principalId, playerId) => holdsSeat(principalId, playerId) === true,
      now: () => input.now,
    });
    standingByEpoch = new Map((await ledger.snapshot(input.gameId)).grants.map((grant) => [`${grant.player_id}#${grant.epoch}`, grant.standing]));
  }
  const newestBySeat = new Map<string, number>();
  for (const grant of input.document.grants) newestBySeat.set(grant.player_id, Math.max(newestBySeat.get(grant.player_id) ?? 0, grant.epoch));
  const grants = [...input.document.grants]
    .sort((a, b) => (a.player_id < b.player_id ? -1 : a.player_id > b.player_id ? 1 : a.epoch - b.epoch))
    .map((grant): WalletGrantRow => ({
      player_id: grant.player_id,
      epoch: grant.epoch,
      newest: newestBySeat.get(grant.player_id) === grant.epoch,
      wallet: grant.wallet,
      ticket: fingerprint("ticket", grant.ticket),
      issued_at: grant.issued_at,
      relinked_from: grant.relinked_from,
      proof:
        grant.proof === null
          ? null
          : { kind: grant.proof.kind, wallet: grant.proof.wallet, pubkey: grant.proof.pubkey, challenge_digest: grant.proof.challenge_digest, proof_hash: grant.proof.proof_hash, verified_at: grant.proof.verified_at },
      consent_keys: grant.consent_keys.length,
      admitted_until_secs: grant.admitted_until_secs,
      standing: standingByEpoch === null ? null : (standingByEpoch.get(`${grant.player_id}#${grant.epoch}`) ?? false),
      revoked_at: grant.revoked_at,
      revoke_reason: grant.revoke_reason,
      frozen_at: grant.frozen_at,
      context: {
        principal: fingerprint("principal", grant.issued_under.principal_id),
        family: fingerprint("family", grant.issued_under.family_id),
        verdict: input.standing === null ? "not-evaluated" : verdictOf(input.standing(contextOf(grant))),
      },
      seat_held: holdsSeat(grant.issued_under.principal_id, grant.player_id),
    }));
  return {
    format: WALLET_GRANTS_VIEW_FORMAT,
    game_id: input.gameId,
    source: input.source,
    ledger_version: input.version,
    frozen_at: input.document.frozen_at,
    identity: { read: input.standing !== null, detail: input.identityDetail },
    record: { read: input.record !== null, detail: input.recordDetail },
    grants,
  };
}

const iso = (ms: number | null): string => (ms === null ? "-" : new Date(ms).toISOString());

/** The operator's text form (one block per grant; nothing beyond the view's fields). */
export function walletGrantsText(view: WalletGrantsView): string[] {
  const out: string[] = [];
  out.push(`wallet grants (READ-ONLY, ${view.source}) of ${view.game_id}: ${view.grants.length} grant(s), ledger version ${view.ledger_version}, ${view.frozen_at === null ? "NOT frozen" : `FROZEN at ${iso(view.frozen_at)}`}`);
  out.push(`  identity: ${view.identity.read ? "read" : "NOT read"} (${view.identity.detail}); record: ${view.record.read ? "read" : "NOT read"} (${view.record.detail})`);
  for (const g of view.grants) {
    const standing = g.standing === null ? "standing NOT EVALUATED" : g.standing ? "STANDING" : "not standing";
    out.push(`  ${g.player_id} epoch ${g.epoch}${g.newest ? " (newest)" : ""}  ${standing}  wallet ${g.wallet}`);
    out.push(`      ticket ${g.ticket}${g.relinked_from !== null ? ` (re-adopted from epoch ${g.relinked_from})` : ""}; issued ${iso(g.issued_at)}; consent keys ${g.consent_keys}${g.admitted_until_secs !== null ? `; admitted until ${new Date(g.admitted_until_secs * 1000).toISOString()}` : ""}`);
    out.push(`      context ${g.context.principal} ${g.context.family} -> ${g.context.verdict}; seat ${g.seat_held === null ? "not checked" : g.seat_held ? "held" : "NOT held"}`);
    out.push(`      revoked ${g.revoked_at === null ? "no" : `${iso(g.revoked_at)} (${g.revoke_reason})`}; frozen ${g.frozen_at === null ? "no" : iso(g.frozen_at)}`);
    if (g.proof === null) out.push("      proof: NONE (proves nothing; no admission is ever issued for it)");
    else {
      out.push(`      proof ${g.proof.kind}: pubkey ${g.proof.pubkey}${g.proof.wallet !== g.wallet ? ` -- PROOF WALLET ${g.proof.wallet} DIFFERS` : ""}`);
      out.push(`      challenge_digest ${g.proof.challenge_digest}`);
      out.push(`      proof_hash       ${g.proof.proof_hash}`);
      out.push(`      verified_at      ${iso(g.proof.verified_at)}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Sources                                                              */
/* ------------------------------------------------------------------ */

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The identity store of a file-mode data directory, READ-ONLY (the snapshot, the journal applied in memory). */
export async function readFileIdentitySnapshot(dataDir: string): Promise<IdentitySnapshot | null> {
  const raw = await readOptional(path.join(dataDir, IDENTITY_FILE));
  if (raw === null) return null;
  const parsed = parseSnapshotDocument(JSON.parse(raw.toString("utf8")), IDENTITY_FILE);
  const journal = await readOptional(path.join(dataDir, IDENTITY_JOURNAL_FILE));
  const scan = scanJournal(journal ?? Buffer.alloc(0), parsed.seq);
  if (scan.classification === "corrupt") throw new Error(`the identity journal is corrupt (${scan.detail})`);
  const index = IdentityIndex.from(parsed.snapshot);
  for (const { seq, change } of scan.changes) {
    const problem = index.check(change, `journal seq ${seq}`);
    if (problem !== null) throw new Error(problem);
    index.apply(change);
  }
  return checkSnapshot(index.snapshot(), "identity (wallet-grants, read-only)");
}

/** Identity's `securityStanding` over a snapshot, in memory (the service is never given a durable store). */
export function standingFromSnapshot(snapshot: IdentitySnapshot): (context: WalletTicketContext) => SecurityStanding {
  const service = IdentityService.fromSnapshot(createMemoryIdentityStore(snapshot), snapshot);
  return (context) => service.securityStanding(context);
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);

/** Everything a view needs, from injected readers (file or AWS). A reader that throws on the LEDGER fails the view; an
 *  identity or record reader that throws only leaves that side unevaluated. */
export async function collectWalletGrants(input: {
  readonly gameId: string;
  readonly source: "file" | "aws";
  readonly loadLedger: () => Promise<{ readonly version: number; readonly document: WalletTicketDocument }>;
  /** The identity records the ledger's contexts need (file mode: the whole snapshot; AWS mode: just those items). */
  readonly loadIdentity: (contexts: readonly WalletTicketContext[]) => Promise<IdentitySnapshot | null>;
  readonly loadRecord: () => Promise<GameRecord | null>;
  readonly now: number;
}): Promise<WalletGrantsView> {
  if (!GAME_ID_PATTERN.test(input.gameId)) throw new Error(`${JSON.stringify(input.gameId)} is not a game id`);
  const { version, document } = await input.loadLedger();
  let standing: ((context: WalletTicketContext) => SecurityStanding) | null = null;
  let identityDetail: string;
  try {
    const contexts = document.grants.map((grant): WalletTicketContext => ({ principalId: grant.issued_under.principal_id, familyId: grant.issued_under.family_id, recoverySelector: grant.issued_under.recovery_selector }));
    const snapshot = await input.loadIdentity(contexts);
    if (snapshot === null) identityDetail = "no identity store";
    else {
      standing = standingFromSnapshot(snapshot);
      identityDetail = "standing judged by identity's securityStanding";
    }
  } catch (error) {
    identityDetail = `unreadable: ${describe(error)}`;
  }
  let record: GameRecord | null = null;
  let recordDetail: string;
  try {
    record = await input.loadRecord();
    recordDetail = record === null ? "no game record" : `status ${record.status}, ${record.seats.length} seat(s)`;
  } catch (error) {
    recordDetail = `unreadable: ${describe(error)}`;
  }
  return walletGrantsView({ gameId: input.gameId, source: input.source, version, document, standing, identityDetail, record, recordDetail, now: input.now });
}
