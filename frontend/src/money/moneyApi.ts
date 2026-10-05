// frontend/src/money/moneyApi.ts
//
// ==================================================================
//  ESCROW-4: THE `/gs/api/money/*` ROUTES, CLIENT SIDE -- ONE TYPED RESULT PER CALL, NEVER A REJECTION
// ==================================================================
//
// The same terms as `utils/profileApi.ts`: every call is a same-origin POST through the installed session port, with a
// closed JSON body and a path from the port's closed list, so nothing sensitive can reach a URL. The server
// (`server/src/escrow/moneyHttpApi.ts`, `moneyTables.ts`) decides everything; this file turns each answer into one
// result, and each refusal into the server's own code and sentence (never a generic "something went wrong").
//
// WHAT COMES BACK IS DATA, NOT AUTHORITY. A challenge text is parsed and checked by the caller before Keplr signs it
// (`walletChecks.ts`); an admission is checked against the pinned deployment, this seat's wallet and ticket and the
// table before a Join is built from it; a deposit hint (`deposit-sent`) is only ever a hint. Nothing here is logged.

import { sessionPort, type SessionApiAnswer, type SessionApiBody, type SessionApiPath, type SessionPort } from "../utils/sessionBootstrap";
import type { MoneyDeploymentView, MoneyDepositEntry, MoneyHintKind } from "../utils/moneyProtocol";

export interface MoneyFailure {
  readonly ok: false;
  /** The server's refusal code (`reauth-required`, `replace-required`, `admission-outstanding`, …), or this client's
   *  own: `network` (nothing answered), `unavailable` (no game server here), `bad-answer` (an answer that is not the
   *  route's shape), `rate-limited`. */
  readonly code: string;
  /** One sentence a player can act on. */
  readonly reason: string;
  readonly status: number | null;
  readonly retryAfterMs?: number;
}

export type MoneyResult<T> = { readonly ok: true; readonly value: T } | MoneyFailure;

const fail = (code: string, reason: string, status: number | null = null, retryAfterMs?: number): MoneyFailure => ({ ok: false, code, reason, status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });

const DEFAULT_REASONS: Readonly<Record<string, string>> = Object.freeze({
  network: "The game server didn't answer. Check your connection and try again.",
  unavailable: "Real-money play needs the hosted game server, which this page isn't connected to.",
  "bad-answer": "The game server's answer wasn't understood, so nothing was changed. Try again.",
  "not-authenticated": "This browser's session with the game server ended. Reload the page and sign in again.",
  "profile-required": "Sign in to a profile first.",
  "reauth-required": "Confirm it's you with your recovery key first.",
  "origin-forbidden": "This page isn't allowed to make that request.",
  "not-found": "The game server doesn't know that table (or real-money play isn't on here).",
  "bad-request": "The game server didn't accept that request.",
  internal: "The game server hit an error and changed nothing. Try again in a moment.",
});

/** Any answer that is not the route's success, as one failure with the server's own words. */
export function moneyFailureOf(answer: SessionApiAnswer): MoneyFailure {
  if (answer.kind === "network") return fail("network", DEFAULT_REASONS.network);
  if (answer.kind === "unavailable") return fail("unavailable", DEFAULT_REASONS.unavailable);
  const body = answer.body ?? {};
  const code = typeof body.error === "string" && /^[a-z0-9-]{1,48}$/.test(body.error) ? body.error : answer.status >= 500 ? "internal" : "bad-answer";
  const said = typeof body.reason === "string" && body.reason.trim() !== "" && body.reason.length <= 400 ? body.reason : null;
  if (answer.status === 429) {
    const wait = typeof body.retryAfterMs === "number" && Number.isFinite(body.retryAfterMs) && body.retryAfterMs > 0 ? body.retryAfterMs : 5_000;
    return fail("rate-limited", `Too many requests. Wait ${Math.max(1, Math.ceil(wait / 1000))} seconds and try again.`, 429, wait);
  }
  return fail(code, said ?? DEFAULT_REASONS[code] ?? `The game server refused that (${code}).`, answer.status);
}

async function post(port: SessionPort, route: string, body: SessionApiBody, success: readonly number[]): Promise<MoneyResult<Record<string, unknown>>> {
  let answer: SessionApiAnswer;
  try {
    answer = await port.api(`money/${route}` as SessionApiPath, body);
  } catch {
    return fail("network", DEFAULT_REASONS.network);
  }
  /* A 401 means this page's picture of the session is stale: the next bootstrap says what it is now. */
  if (answer.kind === "answered" && answer.status === 401) await port.ensure(true);
  if (answer.kind !== "answered" || !success.includes(answer.status) || answer.body === null) return moneyFailureOf(answer);
  return { ok: true, value: answer.body };
}

const badAnswer = (): MoneyFailure => fail("bad-answer", DEFAULT_REASONS["bad-answer"]);
const str = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/* ==================================================================
    THE ROUTES
   ================================================================== */

export interface MoneyConfig {
  /** Whether a real-money table can be opened on this server now. */
  readonly enabled: boolean;
  /** Why not (`money-games-disabled`, `rules-not-certified`, …) and the sentence. */
  readonly why: string | null;
  readonly reason: string | null;
  readonly deployment: MoneyDeploymentView;
  readonly feeBps: number | null;
  readonly minAnte: string | null;
}

export async function moneyConfig(port: SessionPort = sessionPort()): Promise<MoneyResult<MoneyConfig>> {
  const got = await post(port, "config", {}, [200]);
  if (!got.ok) return got;
  const v = got.value;
  const d = v.deployment as Record<string, unknown> | undefined;
  if (typeof v.enabled !== "boolean" || typeof d !== "object" || d === null) return badAnswer();
  if (!str(d.chainId) || !str(d.contract) || !str(d.codeChecksum) || !str(d.denom) || !str(d.symbol) || d.exponent !== 6 || d.backend !== "juno-cosmwasm" || !str(d.networkClass)) return badAnswer();
  return {
    ok: true,
    value: {
      enabled: v.enabled,
      why: typeof v.why === "string" ? v.why : null,
      reason: typeof v.reason === "string" ? v.reason : null,
      deployment: { backend: "juno-cosmwasm", chainId: d.chainId, networkClass: d.networkClass as MoneyDeploymentView["networkClass"], contract: d.contract, codeChecksum: d.codeChecksum, denom: d.denom, symbol: d.symbol, exponent: 6 },
      feeBps: num(v.feeBps) && Number.isInteger(v.feeBps) && v.feeBps >= 0 && v.feeBps <= 10_000 ? v.feeBps : null,
      minAnte: typeof v.minAnte === "string" && /^[0-9]{1,40}$/.test(v.minAnte) ? v.minAnte : null,
    },
  };
}

export interface WalletChallenge {
  readonly text: string;
  readonly nonce: string;
  readonly expiresAt: number;
  /** W2-M (AUD-20.14): the wallet this seat's standing link holds when it is ANOTHER wallet (linking would replace
   *  it), null when nothing would be replaced, undefined from a server that doesn't say. A hint for asking first; the
   *  link's own answer still decides. */
  readonly replaces?: string | null;
}

/** SENSITIVE: needs a live "Confirm it's you" on this session. */
export async function walletChallenge(gameId: string, wallet: string, port: SessionPort = sessionPort()): Promise<MoneyResult<WalletChallenge>> {
  const got = await post(port, "wallet-challenge", { gameId, wallet }, [200]);
  if (!got.ok) return got;
  const { text, nonce, expiresAt, replaces } = got.value;
  if (!str(text, 2048) || !str(nonce, 64) || !num(expiresAt)) return badAnswer();
  if (replaces === undefined) return { ok: true, value: { text, nonce, expiresAt } };
  if (replaces !== null && !str(replaces, 96)) return badAnswer();
  return { ok: true, value: { text, nonce, expiresAt, replaces } };
}

export interface WalletLinkAnswer {
  readonly mode: "issued" | "relinked" | "unchanged";
  readonly wallet: string;
  readonly epoch: number;
  readonly ticket: string;
}

/** SENSITIVE: the wallet's ADR-036 signature over the challenge, plus this browser's consent public key. */
export async function walletLink(
  input: { readonly gameId: string; readonly nonce: string; readonly pubKey: string; readonly signature: string; readonly consentKey: string; readonly replace?: boolean },
  port: SessionPort = sessionPort(),
): Promise<MoneyResult<WalletLinkAnswer>> {
  const body: SessionApiBody = { gameId: input.gameId, nonce: input.nonce, pubKey: input.pubKey, signature: input.signature, consentKey: input.consentKey };
  if (input.replace === true) body.replace = true;
  const got = await post(port, "wallet-link", body, [200]);
  if (!got.ok) return got;
  const { mode, wallet, epoch, ticket } = got.value;
  if ((mode !== "issued" && mode !== "relinked" && mode !== "unchanged") || !str(wallet, 128) || !num(epoch) || !str(ticket, 64)) return badAnswer();
  return { ok: true, value: { mode, wallet, epoch, ticket } };
}

/** The server's Join admission (ESCROW-JOIN), exactly as the Join carries it -- checked by the caller before use. */
export interface JoinAdmission {
  readonly chain_id: string;
  readonly contract: string;
  readonly chain_game_id: string;
  readonly wallet: string;
  readonly join_ticket: string;
  /** Unix seconds, decimal. */
  readonly expires_at: string;
  /** 64 bytes, lowercase hex. */
  readonly signature: string;
  readonly admission_pubkey: string;
}

export async function joinAdmission(gameId: string, port: SessionPort = sessionPort()): Promise<MoneyResult<JoinAdmission>> {
  const got = await post(port, "join-admission", { gameId }, [200]);
  if (!got.ok) return got;
  const a = got.value.admission as Record<string, unknown> | undefined;
  if (typeof a !== "object" || a === null) return badAnswer();
  const fields = ["chain_id", "contract", "chain_game_id", "wallet", "join_ticket", "expires_at", "signature", "admission_pubkey"] as const;
  if (!fields.every((field) => str(a[field], 256))) return badAnswer();
  return { ok: true, value: Object.fromEntries(fields.map((field) => [field, a[field]])) as unknown as JoinAdmission };
}

/** A HINT that a wallet transaction was sent (the server looks sooner). Funding is only ever what the chain shows. */
export async function depositSent(gameId: string, kind: MoneyHintKind, txHash: string, chainGameId: string | null, port: SessionPort = sessionPort(), timeoutHeight: string | null = null): Promise<MoneyResult<{ readonly accepted: boolean }>> {
  const body: SessionApiBody = { gameId, kind, txHash };
  if (chainGameId !== null) body.chainGameId = chainGameId;
  /* The height after which it can never land: the server drops the hint then (rather than believing it longer). */
  if (timeoutHeight !== null) body.timeoutHeight = timeoutHeight;
  const got = await post(port, "deposit-sent", body, [202, 200]);
  return got.ok ? { ok: true, value: { accepted: got.value.accepted === true } } : got;
}

/** SENSITIVE: register a signing key this browser made (before its SetConsentKey, or before a deposit carries it). */
export async function registerConsentKey(gameId: string, pubkey: string, port: SessionPort = sessionPort()): Promise<MoneyResult<{ readonly registered: boolean }>> {
  const got = await post(port, "consent-key", { gameId, pubkey }, [200]);
  return got.ok ? { ok: true, value: { registered: got.value.registered === true } } : got;
}

/** Relay this seat's own CONSENT signature (no re-authentication: the signature is the authority). */
export async function relayConsent(gameId: string, signature: string, port: SessionPort = sessionPort()): Promise<MoneyResult<{ readonly status: "queued" | "relayed" | "on-chain" }>> {
  const got = await post(port, "consent", { gameId, signature }, [200]);
  if (!got.ok) return got;
  const status = got.value.status;
  return status === "queued" || status === "relayed" || status === "on-chain" ? { ok: true, value: { status } } : badAnswer();
}

export interface AnnulAnswer {
  readonly trustedSeq: string;
  readonly collected: readonly number[];
  readonly needed: number;
  readonly submitted: boolean;
}

/** This seat's ANNUL signature (collected by the server; relayed once every seat's is in). */
export async function submitAnnul(gameId: string, signature: string, port: SessionPort = sessionPort()): Promise<MoneyResult<AnnulAnswer>> {
  const got = await post(port, "annul", { gameId, signature }, [200]);
  if (!got.ok) return got;
  const { trustedSeq, collected, needed, submitted } = got.value;
  if (!str(trustedSeq, 24) || !Array.isArray(collected) || !collected.every((at) => Number.isInteger(at)) || !num(needed) || typeof submitted !== "boolean") return badAnswer();
  return { ok: true, value: { trustedSeq, collected: collected as number[], needed, submitted } };
}

export interface SignedPayloadDetail {
  readonly seq: string;
  readonly log_len: number;
  readonly round_key: string | null;
  readonly payload: unknown;
  readonly signature: string;
  readonly settle_digest: string;
  readonly status: string;
}

export interface EscrowDetails {
  readonly checkpoint: SignedPayloadDetail | null;
  readonly settlement: SignedPayloadDetail | null;
  readonly chain: {
    readonly state: string;
    readonly domain: string | null;
    readonly trustedSeq: string;
    readonly latestCheckpointSeq: string | null;
    readonly livenessAvailableAt: number | null;
    readonly challengeWindowEnd: number | null;
    readonly resolverTimeoutAt: number | null;
    readonly bond: string | null;
    readonly observedAt: number | null;
  } | null;
  /** The frozen roster (every seat's chain position), once the seats are locked: what a device lays its own count of
   *  the final standings out by, to check the recorded payout (null before the freeze). */
  readonly roster: readonly { readonly playerId: string; readonly chainSeatIndex: number }[] | null;
}

const detailOf = (value: unknown): SignedPayloadDetail | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const d = value as Record<string, unknown>;
  if (!str(d.seq, 24) || !num(d.log_len) || !str(d.signature, 256) || !str(d.settle_digest, 128) || !str(d.status, 32)) return undefined;
  return { seq: d.seq, log_len: d.log_len, round_key: typeof d.round_key === "string" ? d.round_key : null, payload: d.payload, signature: d.signature, settle_digest: d.settle_digest, status: d.status };
};

/** The server's newest signed checkpoint and its settlement for this table, and what the chain last said. */
export async function escrowDetails(gameId: string, port: SessionPort = sessionPort()): Promise<MoneyResult<EscrowDetails>> {
  const got = await post(port, "escrow-details", { gameId }, [200]);
  if (!got.ok) return got;
  const checkpoint = detailOf(got.value.checkpoint ?? null);
  const settlement = detailOf(got.value.settlement ?? null);
  if (checkpoint === undefined || settlement === undefined) return badAnswer();
  const c = got.value.chain as Record<string, unknown> | null | undefined;
  const ms = (value: unknown) => (num(value) ? value : null);
  const chain =
    c === null || c === undefined || typeof c !== "object"
      ? null
      : {
          state: typeof c.state === "string" ? c.state : "unknown",
          domain: typeof c.domain === "string" ? c.domain : null,
          trustedSeq: typeof c.trustedSeq === "string" ? c.trustedSeq : "0",
          latestCheckpointSeq: typeof c.latestCheckpointSeq === "string" ? c.latestCheckpointSeq : null,
          livenessAvailableAt: ms(c.livenessAvailableAt),
          challengeWindowEnd: ms(c.challengeWindowEnd),
          resolverTimeoutAt: ms(c.resolverTimeoutAt),
          bond: typeof c.bond === "string" ? c.bond : null,
          observedAt: ms(c.observedAt),
        };
  const rawRoster = got.value.roster;
  let roster: EscrowDetails["roster"] = null;
  if (Array.isArray(rawRoster)) {
    const seats = rawRoster.map((seat) => (typeof seat === "object" && seat !== null ? (seat as Record<string, unknown>) : {}));
    if (!seats.every((seat) => str(seat.playerId, 128) && typeof seat.chainSeatIndex === "number" && Number.isInteger(seat.chainSeatIndex) && seat.chainSeatIndex >= 0 && seat.chainSeatIndex < 16)) return badAnswer();
    roster = seats.map((seat) => ({ playerId: seat.playerId as string, chainSeatIndex: seat.chainSeatIndex as number }));
  } else if (rawRoster !== null && rawRoster !== undefined) return badAnswer();
  return { ok: true, value: { checkpoint, settlement, chain, roster } };
}

/** "Your deposits": every escrow seat this profile's linked wallets hold, whatever became of the table. */
export async function yourDeposits(port: SessionPort = sessionPort()): Promise<MoneyResult<readonly MoneyDepositEntry[]>> {
  const got = await post(port, "deposits", {}, [200]);
  if (!got.ok) return got;
  const list = got.value.deposits;
  if (!Array.isArray(list)) return badAnswer();
  const entries = list.filter((entry): entry is MoneyDepositEntry => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return str(e.gameId, 64) && typeof e.tableOpen === "boolean" && typeof e.deployment === "object" && e.deployment !== null && str(e.chainGameId, 24) && str(e.wallet, 128) && str(e.grossDeposit, 40) && str(e.netDeposit, 40) && str(e.chainState, 24) && Array.isArray(e.actions) && typeof e.creator === "boolean" && (e.relation === "bound" || e.relation === "duplicate" || e.relation === "unlinked");
  });
  return { ok: true, value: entries };
}
