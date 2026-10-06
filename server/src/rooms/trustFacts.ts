// server/src/rooms/trustFacts.ts
//
// ==================================================================
//  PHASE 3 (P3-ACCT): FACTUAL TRUST INDICATORS -- DERIVED FROM DURABLE RECORDS, NEVER A SCORE
// ==================================================================
//
// The owner's direction: no composite numeric "trust score". What a player deciding whether to sit at a stranger's
// table may read is a handful of FACTS, each labelled for what it is (the client groups them as "Profile history",
// "Prior relationships" and "Identity assurance"), none of which proves anything about who controls a profile:
//
//   memberSince / accountAgeDays    the profile's own creation time (identity's durable profile record): the month,
//                                   and the age in WHOLE WEEKS (as days) counted from the start of the UTC week it was
//                                   made in -- so the number steps on the same Monday, 00:00 UTC, for every account of
//                                   that week, and watching it change says nothing finer than the week (review L4,
//                                   re-review N-4: no exact date or time is published). 0: under a week old.
//   completedMoneyGames             real-money tables this profile sat at whose GAME COMPLETED (the GameRecord's
//                                   `completed_at`; the record index is loaded from the durable records at every start)
//                                   and whose escrow was neither CANCELLED nor ANNULLED (the financial record: its phase
//                                   `cancelled`, or the chain's terminal state ANNULLED / CANCELLED -- an annul can close
//                                   the escrow while play goes on to the end). P3-ACCT POLICY: with a money layer, a table
//                                   whose financial record cannot be read just now is NOT counted (fail closed: a fact
//                                   that cannot be checked never adds standing, and such an answer is not reused); a
//                                   table HELD for an operator's attention is not counted either. Counted over the newest
//                                   `MAX_MONEY_TABLES_READ` real-money tables of the profile (the bound on one answer's
//                                   reads).
//   unresolvedDisputes              of this profile's real-money tables, those whose money is in DISPUTE now (the
//                                   financial record's phase `disputed`: the resolver has not ruled). A dispute is a
//                                   table's -- the record does not say which seat raised it, and none is blamed here.
//   disputedGames / inactivityExits of this profile's real-money tables, those the escrow CLOSED through the dispute
//                                   resolver (route `resolver_*`) / through its inactivity exit (`liveness_*`,
//                                   `settleable_timeout_*`) -- the chain's own outcome, as the financial record keeps it.
//   walletVerified / since          the profile has a persisted wallet it PROVED it controls (identity; no address, no
//                                   proof material is published here).
//   establishedOpponents            P3-ACCT POLICY (owner ruling 2026-10-05): the number of DISTINCT other profiles this
//                                   one has completed a counted real-money game with (exactly the games
//                                   `completedMoneyGames` counts), each counted ONCE however many games they played
//                                   together, that are ESTABLISHED: a profile is established once it has completed at
//                                   least one real-money game (`isEstablished`). Free, cancelled and annulled games never
//                                   count; no account age is required. A counted game establishes BOTH of its players, so
//                                   once it is complete its opponent counts (provided that profile still exists and is
//                                   active). Two profiles are never inferred to be one person from any address or device
//                                   signal: shared-network facts stay security evidence only, never read here.
//
// What is deliberately NOT here: any ranking, score or sanction; any device, address, session or wallet-relationship
// signal (those may exist as security evidence elsewhere; they are not proof of anything and are not published); any
// "forfeit" count -- the authoritative model has no forfeit record (no auto-forfeit exists: AUD-11.04 builds clocks
// without automatic consequences), so the nearest honest fact is the escrow's own inactivity exit above.
//
// PRIVACY: the answer is keyed by the table's PUBLIC seat ids (`player_id`, already in every view). No principal,
// profile, session or family id, no username, no IP and no wallet address ever appears in it.

import type { FinancialGameRecord } from "../escrow/moneyLifecycle";
import type { GameRecord } from "./gameRecord";

/** The public facts of one profile (never an id). */
export interface TrustFacts {
  /** The profile's creation month, `YYYY-MM` (UTC). */
  readonly memberSince: string;
  readonly accountAgeDays: number;
  readonly completedMoneyGames: number;
  readonly unresolvedDisputes: number;
  readonly disputedGames: number;
  readonly inactivityExits: number;
  readonly walletVerified: boolean;
  /** The month the wallet was proved, `YYYY-MM` (UTC), or null. */
  readonly walletVerifiedSince: string | null;
  /** Distinct established profiles this one has completed a counted real-money game with (see the header). A number
   *  (the type keeps `null` for a client of an older build's answer). */
  readonly establishedOpponents: number | null;
}

/** THE OWNER'S DEFINITION (2026-10-05): a profile is ESTABLISHED once it has COMPLETED at least one real-money game
 *  (cancelled and annulled games, and free ones, never count; no account-age requirement). */
export const ESTABLISHED_MIN_COMPLETED_MONEY_GAMES = 1;
export const isEstablished = (facts: Pick<TrustFacts, "completedMoneyGames">): boolean => facts.completedMoneyGames >= ESTABLISHED_MIN_COMPLETED_MONEY_GAMES;

export interface TrustFactsDeps {
  /** The profile behind a principal: its creation time and its proven wallet's verification time (identity). */
  readonly profileFacts: (principalId: string) => { readonly createdAt: number; readonly walletVerifiedAt: number | null } | null;
  /** Every table the index knows that this principal sits at (the room host's record index). */
  readonly tablesOf: (principalId: string) => readonly GameRecord[];
  /** A real-money table's financial record (absent: no money layer -- every money count is from the records alone). */
  readonly financial?: (gameId: string) => Promise<FinancialGameRecord | null>;
  readonly now: () => number;
  /** How long an answer is reused (default one minute). */
  readonly reuseMs?: number;
}

const DAY = 24 * 60 * 60 * 1000;
/** A profile's real-money tables looked at, newest first (a bound on the financial reads of one answer). */
export const MAX_MONEY_TABLES_READ = 200;
const MAX_CACHED = 5_000;

/* Review L4: published to the MONTH -- an exact day, beside the other facts, would single a player out across tables. */
const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
const WEEK = 7 * DAY;
/** The start (Monday 00:00 UTC) of the UTC week holding `ms`. (1970-01-01 was a Thursday: day 4 of its ISO week.) */
export const weekStartOf = (ms: number): number => {
  const day = Math.floor(ms / DAY);
  return (day - ((day + 3) % 7)) * DAY;
};
/** The age in whole weeks (as days) from the start of the creation week: the same steps for every account of a week. */
export const coarseAgeDays = (createdAt: number, now: number): number => Math.max(0, Math.floor((now - weekStartOf(createdAt)) / WEEK)) * 7;
const isDisputeRoute = (route: string | undefined): boolean => typeof route === "string" && route.startsWith("resolver_");
/** P3-ACCT POLICY: a table whose escrow was cancelled or annulled is no completed real-money game. */
const cancelledOrAnnulled = (fin: FinancialGameRecord): boolean => fin.phase === "cancelled" || fin.chain_outcome?.state === "ANNULLED" || fin.chain_outcome?.state === "CANCELLED";
/** Review NIT 10: a table held for an operator's attention is not (yet) a completed real-money game. */
const notCounted = (fin: FinancialGameRecord): boolean => cancelledOrAnnulled(fin) || fin.phase === "held";
const isInactivityRoute = (route: string | undefined): boolean => typeof route === "string" && (route.startsWith("liveness_") || route.startsWith("settleable_timeout_"));

export function createTrustFacts(deps: TrustFactsDeps) {
  const cache = new Map<string, { readonly at: number; readonly facts: TrustFacts | null }>();
  const reuseMs = deps.reuseMs ?? 60_000;

  /** The real-money tables of this principal that COUNT as completed (see the header), newest first, with the
   *  dispute / inactivity facts read on the way. */
  async function moneyFacts(principalId: string): Promise<{ readonly counted: readonly GameRecord[]; readonly unresolvedDisputes: number; readonly disputedGames: number; readonly inactivityExits: number; readonly incomplete: boolean }> {
    const money = deps
      .tablesOf(principalId)
      .filter((record) => record.money !== null)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, MAX_MONEY_TABLES_READ);
    const counted: GameRecord[] = [];
    let unresolvedDisputes = 0;
    let disputedGames = 0;
    let inactivityExits = 0;
    /* Review L5: a record that could not be read is not a fact -- the answer counts nothing for it, and is not reused. */
    let incomplete = false;
    for (const record of money) {
      let fin: FinancialGameRecord | null = null;
      if (deps.financial !== undefined) {
        try {
          fin = await deps.financial(record.game_id);
        } catch {
          fin = null; // a record that cannot be read just now counts as nothing (never as a dispute, never as a game)
        }
        if (fin === null) incomplete = true;
        if (fin !== null) {
          if (fin.phase === "disputed") unresolvedDisputes += 1;
          if (isDisputeRoute(fin.chain_outcome?.route)) disputedGames += 1;
          if (isInactivityRoute(fin.chain_outcome?.route)) inactivityExits += 1;
        }
      }
      if (record.completed_at === null || record.cancelled_at !== null) continue;
      if (deps.financial !== undefined && (fin === null || notCounted(fin))) continue;
      counted.push(record);
    }
    return { counted, unresolvedDisputes, disputedGames, inactivityExits, incomplete };
  }

  async function compute(principalId: string): Promise<{ readonly facts: TrustFacts | null; readonly reusable: boolean }> {
    const profile = deps.profileFacts(principalId);
    if (profile === null) return { facts: null, reusable: true };
    const now = deps.now();
    const facts = await moneyFacts(principalId);
    /* Every opponent of a counted game completed that SAME game, so by the owner's definition it is established by it
       (`isEstablished` holds for any profile with one counted game) -- no further read is needed, and each counts once.
       It counts while its profile exists and is active (`profileFacts`): a disabled or unknown one does not. */
    const opponents = new Set<string>();
    for (const record of facts.counted) for (const seat of record.seats) if (seat.principal_id !== principalId) opponents.add(seat.principal_id);
    let establishedOpponents = 0;
    for (const other of opponents) if (deps.profileFacts(other) !== null) establishedOpponents += 1;
    const result: TrustFacts = {
      memberSince: monthOf(profile.createdAt),
      accountAgeDays: coarseAgeDays(profile.createdAt, now),
      completedMoneyGames: facts.counted.length,
      unresolvedDisputes: facts.unresolvedDisputes,
      disputedGames: facts.disputedGames,
      inactivityExits: facts.inactivityExits,
      walletVerified: profile.walletVerifiedAt !== null,
      walletVerifiedSince: profile.walletVerifiedAt === null ? null : monthOf(profile.walletVerifiedAt),
      establishedOpponents,
    };
    return { facts: result, reusable: !facts.incomplete };
  }

  /** One profile's facts (reused for `reuseMs`); null for a principal with no profile. */
  async function factsOf(principalId: string, useCache = true): Promise<TrustFacts | null> {
    const at = deps.now();
    const cached = cache.get(principalId);
    if (useCache && cached !== undefined && at - cached.at < reuseMs) return cached.facts;
    const computed = await compute(principalId);
    if (computed.reusable) {
      cache.set(principalId, { at, facts: computed.facts });
      while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
    } else {
      cache.delete(principalId);
    }
    return computed.facts;
  }

  return { factsOf, forget: (principalId: string) => cache.delete(principalId) };
}

export type TrustFactsService = ReturnType<typeof createTrustFacts>;
