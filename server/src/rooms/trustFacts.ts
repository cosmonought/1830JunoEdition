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
//                                   `completed_at`; the record index is loaded from the durable records at every start).
//   unresolvedDisputes              of this profile's real-money tables, those whose money is in DISPUTE now (the
//                                   financial record's phase `disputed`: the resolver has not ruled). A dispute is a
//                                   table's -- the record does not say which seat raised it, and none is blamed here.
//   disputedGames / inactivityExits of this profile's real-money tables, those the escrow CLOSED through the dispute
//                                   resolver (route `resolver_*`) / through its inactivity exit (`liveness_*`,
//                                   `settleable_timeout_*`) -- the chain's own outcome, as the financial record keeps it.
//   walletVerified / since          the profile has a persisted wallet it PROVED it controls (identity; no address, no
//                                   proof material is published here).
//   establishedOpponents            ALWAYS null in this build: "distinct ESTABLISHED profiles played with" needs the
//                                   owner's definition of "established" (none exists in the repository). The data path is
//                                   here (`opponentsOf` + `ESTABLISHED_PROFILE`): once the owner defines the predicate,
//                                   this one fact is filled without touching anything else. No threshold is invented.
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
  /** Pending the owner's definition of an "established" profile: always null in this build (see the header). */
  readonly establishedOpponents: number | null;
}

/** What an "established" profile is -- THE OWNER'S DECISION (none exists in the repository). `null` until it is made;
 *  while null, `establishedOpponents` is null. A predicate over another profile's own facts. */
export const ESTABLISHED_PROFILE: ((facts: TrustFacts) => boolean) | null = null;

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
const isInactivityRoute = (route: string | undefined): boolean => typeof route === "string" && (route.startsWith("liveness_") || route.startsWith("settleable_timeout_"));

export function createTrustFacts(deps: TrustFactsDeps) {
  const cache = new Map<string, { readonly at: number; readonly facts: TrustFacts | null }>();
  const reuseMs = deps.reuseMs ?? 60_000;

  /** The other principals this one completed a real-money game with (the data path of `establishedOpponents`). */
  function opponentsOf(principalId: string): Set<string> {
    const out = new Set<string>();
    for (const record of deps.tablesOf(principalId)) {
      if (record.money === null || record.completed_at === null) continue;
      for (const seat of record.seats) if (seat.principal_id !== principalId) out.add(seat.principal_id);
    }
    return out;
  }

  async function compute(principalId: string): Promise<TrustFacts | null> {
    const profile = deps.profileFacts(principalId);
    if (profile === null) return null;
    const now = deps.now();
    const money = deps
      .tablesOf(principalId)
      .filter((record) => record.money !== null)
      .sort((a, b) => b.created_at - a.created_at);
    let unresolvedDisputes = 0;
    let disputedGames = 0;
    let inactivityExits = 0;
    if (deps.financial !== undefined) {
      for (const record of money.slice(0, MAX_MONEY_TABLES_READ)) {
        let fin: FinancialGameRecord | null;
        try {
          fin = await deps.financial(record.game_id);
        } catch {
          fin = null; // a record that cannot be read just now counts as nothing (never as a dispute)
        }
        if (fin === null) continue;
        if (fin.phase === "disputed") unresolvedDisputes += 1;
        if (isDisputeRoute(fin.chain_outcome?.route)) disputedGames += 1;
        if (isInactivityRoute(fin.chain_outcome?.route)) inactivityExits += 1;
      }
    }
    const base: TrustFacts = {
      memberSince: monthOf(profile.createdAt),
      accountAgeDays: coarseAgeDays(profile.createdAt, now),
      completedMoneyGames: money.filter((record) => record.completed_at !== null).length,
      unresolvedDisputes,
      disputedGames,
      inactivityExits,
      walletVerified: profile.walletVerifiedAt !== null,
      walletVerifiedSince: profile.walletVerifiedAt === null ? null : monthOf(profile.walletVerifiedAt),
      establishedOpponents: null,
    };
    const predicate = ESTABLISHED_PROFILE as ((facts: TrustFacts) => boolean) | null;
    if (predicate === null) return base;
    /* Reached only once the owner defines "established" (the opponents' own facts, never their ids, decide it). */
    let established = 0;
    for (const other of opponentsOf(principalId)) {
      const theirs = await factsOf(other, false);
      if (theirs !== null && predicate(theirs)) established += 1;
    }
    return { ...base, establishedOpponents: established };
  }

  /** One profile's facts (reused for `reuseMs`); null for a principal with no profile. */
  async function factsOf(principalId: string, useCache = true): Promise<TrustFacts | null> {
    const at = deps.now();
    const cached = cache.get(principalId);
    if (useCache && cached !== undefined && at - cached.at < reuseMs) return cached.facts;
    const facts = await compute(principalId);
    cache.set(principalId, { at, facts });
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
    return facts;
  }

  return { factsOf, opponentsOf, forget: (principalId: string) => cache.delete(principalId) };
}

export type TrustFactsService = ReturnType<typeof createTrustFacts>;
