// frontend/src/utils/trustApi.ts
//
// PHASE 3 (P3-ACCT): THE FACTUAL TRUST INDICATORS, CLIENT SIDE. The server derives every fact from its durable records
// (`server/src/rooms/trustFacts.ts`); this file only reads `POST /gs/api/trust/table` (each seat of a table the reader
// may read, keyed by the seat's public id) and `POST /gs/api/trust/me` (the account's own), checks every field, and
// drops anything it does not recognise. There is NO score: a fact is a fact, shown under its own label. No answer
// carries an id, a username or a wallet address, and nothing here asks for one.

import { sessionPort, type SessionPort } from "./sessionBootstrap";

export interface TrustFacts {
  /** `YYYY-MM`, UTC (the server says the month only: review L4, no exact creation time to correlate). */
  readonly memberSince: string;
  /** Exact under a week, then whole weeks (in days), as the server coarsens it. */
  readonly accountAgeDays: number;
  readonly completedMoneyGames: number;
  readonly unresolvedDisputes: number;
  readonly disputedGames: number;
  readonly inactivityExits: number;
  readonly walletVerified: boolean;
  /** `YYYY-MM`, UTC. */
  readonly walletVerifiedSince: string | null;
  /** Null until the owner defines an "established" profile (no threshold is invented here or on the server). */
  readonly establishedOpponents: number | null;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const count = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** One seat's facts, strictly read; null for anything that is not exactly the shape. */
export function trustFactsOf(raw: unknown): TrustFacts | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const numbers = [count(r.accountAgeDays), count(r.completedMoneyGames), count(r.unresolvedDisputes), count(r.disputedGames), count(r.inactivityExits)];
  if (typeof r.memberSince !== "string" || !MONTH.test(r.memberSince) || numbers.some((n) => n === null) || typeof r.walletVerified !== "boolean") return null;
  const since = r.walletVerifiedSince;
  if (!(since === null || (typeof since === "string" && MONTH.test(since)))) return null;
  const established = r.establishedOpponents;
  if (!(established === null || count(established) !== null)) return null;
  const [accountAgeDays, completedMoneyGames, unresolvedDisputes, disputedGames, inactivityExits] = numbers as number[];
  return {
    memberSince: r.memberSince,
    accountAgeDays,
    completedMoneyGames,
    unresolvedDisputes,
    disputedGames,
    inactivityExits,
    walletVerified: r.walletVerified,
    walletVerifiedSince: since as string | null,
    establishedOpponents: established as number | null,
  };
}

export type TrustTableResult = { ok: true; seats: ReadonlyMap<string, TrustFacts> } | { ok: false };

/** The facts of every seat at a real-money table this account may read (signed in only: the server answers 403 to a
 *  visitor and 404 for a free table -- review L4). */
export async function tableTrustFacts(gameId: string, port: SessionPort = sessionPort()): Promise<TrustTableResult> {
  const answer = await port.api("trust/table", { gameId });
  if (answer.kind !== "answered" || answer.status !== 200 || !Array.isArray(answer.body?.seats)) return { ok: false };
  const seats = new Map<string, TrustFacts>();
  for (const entry of answer.body?.seats as unknown[]) {
    const seat = entry as { playerId?: unknown; facts?: unknown } | null;
    if (seat === null || typeof seat.playerId !== "string") continue;
    const facts = trustFactsOf(seat.facts);
    if (facts !== null) seats.set(seat.playerId, facts);
  }
  return { ok: true, seats };
}

/** This account's own facts (signed in). */
export async function myTrustFacts(port: SessionPort = sessionPort()): Promise<TrustFacts | null> {
  const answer = await port.api("trust/me", {});
  if (answer.kind !== "answered" || answer.status !== 200) return null;
  return trustFactsOf(answer.body?.facts);
}
