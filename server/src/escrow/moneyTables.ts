// server/src/escrow/moneyTables.ts
//
// ==================================================================
//  ESCROW-4: REAL-MONEY TABLES -- THE PLAYER-FACING LAYER OVER THE 3A/3B BACKEND AND THE 2.0.0 CONTRACT
// ==================================================================
//
// The room host owns the table (its seats, host, code and lifecycle); the escrow service owns the money (the financial
// record, the chain intents, the relayer); the ticket ledger owns who may deposit into which seat. This module is the
// seam between them and the players, and it DECIDES NOTHING THE CHAIN DECIDES:
//
//   create          a money table's terms come from the server's pinned deployment, never from a caller: the host
//                   chooses the ante and the exact player count (the escrow's pace is the table's own pace). Mainnet is refused; the operator's switch
//                   (`ESCROW_MONEY_TABLES=nonmainnet`) and a verified backend are required; the rules must be
//                   settlement-certified. The financial record is written BEFORE the GameRecord (no money table ever
//                   exists without one).
//   link            "Confirm it's you" (the session's own /reauth grant) + an ADR-036 signature over a server-minted,
//                   single-use challenge naming this site, network, contract, table, seat and wallet
//                   (`walletProof.ts`) -> a ticket issued in the game's ACTOR TASK, with the verified proof recorded on
//                   the grant (the join admission's precondition). The refusal policy is exact (below); nothing is ever
//                   reassigned automatically.
//   admission       a joiner's Join needs the server's admission (ESCROW-JOIN): `authorizeJoin` runs in the game's actor
//                   task, so a seat op and an admission never interleave (R-J1: the seat is locked until the admission's
//                   expiry plus the clock margin).
//   funding         the chain says it, read by quorum when two or more endpoints are configured (a tx hash is only ever a
//                   HINT that makes the server look sooner). A host's CreateGame is bound only under W-13
//                   (`escrowService.bindHostChainGame`): found by the hint's chain game id or by scanning the contract's
//                   game list from the ticket's own floor -- never taken on the browser's word.
//   seat locks      W-2 / R-J1 / W-3: kick, release and cancel are refused while a seat has a live admission, a deposit
//                   in flight, or a deposit on chain (or the chain cannot be read to say it has none); the host of a
//                   money table is the chain creator (no transfer before the deal; the host leaves by Cancel on Juno).
//                   Leave is always an unsubscribe.
//   start           the host (or, from ten minutes after the chain shows the table fully funded, any funded player) asks;
//                   the 3B reversible freeze runs in the actor task; the relayer sends Start; the deal follows the chain's
//                   confirmation (a server task). A Start the chain proves can never land releases the freeze: the table
//                   is back to its funded pre-Start state. Nothing is simulated with client state.
//   consent/annul   a player's own consent key signs; the server verifies the signature against the chain's CURRENT key
//                   of that seat (one the seat registered) and relays it. No re-authentication: the signature is the
//                   authority (owner ruling). Registering or moving a key needs "Confirm it's you" (+ the wallet's
//                   SetConsentKey on chain).
//   projection      `RoomView.money` per viewer (`frontend/src/utils/moneyProtocol.ts`), `RoomSummary.stake`,
//                   `MyTableSummary.money`, and "Your deposits": no principal, session or secret ever appears; the
//                   viewer's own ticket only in its own `you`.
//
// Everything here is in MEMORY except what the ledger, the financial record and the chain intents already keep durably:
// challenges, deposit hints and the observation cache. A restart forgets them and loses nothing -- the chain and the
// durable records say the rest (a player confirms again; a hint is re-sent by the browser's pending transaction).

import { createHash } from "crypto";

import { variantsDigestV1 } from "../../../frontend/src/gameEngine/escrow/variantsDigest";
import type {
  MoneyAction,
  MoneyDeploymentView,
  MoneyDepositEntry,
  MoneyEscrowState,
  MoneyHintKind,
  MoneySeatFunding,
  MoneySettlementStatus,
  MoneySettlementView,
  MoneyStartBlocker,
  MoneyStartView,
  MoneyYouView,
  MyTableMoneySummary,
  RoomMoneyView,
  RoomStakeSummary,
} from "../../../frontend/src/utils/moneyProtocol";
import type { GameVariants } from "../../../frontend/src/gameEngine/gameVariants";
import type { OpsRecorder } from "../persistence/opsRecorder";
import { MONEY_TABLE_FORMAT, seatOf, type GameMoneyTerms, type GameRecord } from "../rooms/gameRecord";
import type { ChainIntentRecord } from "./chainIntents";
import type { EscrowService } from "./escrowService";
import type { FinancialGameStore } from "./financialGameStore";
import { DEALT_PHASES, type FinancialDeploymentPin, type FinancialGameRecord } from "./moneyLifecycle";
import { moneyTermsKey } from "./moneyServing";
import { ADMISSION_CLOCK_SKEW_MS, admissionOutstanding, type WalletLinkProof, type WalletTicketLedger } from "./walletTickets";
import { canonicalJunoWallet, createChallengeBook, verifyAdr036, type ChallengeBook } from "./walletProof";
import { parseConfigResponse, parseGameResponse, parseGamesResponse, QUERY, type JunoGameResponse } from "./juno/junoContract";
import type { JunoRest } from "./juno/junoRest";

/* ==================================================================
    POLICY CONSTANTS
   ================================================================== */

/** The operator's switch: `ESCROW_MONEY_TABLES=nonmainnet` (or `--money-tables nonmainnet`). Nothing else enables it. */
export const MONEY_TABLES_SWITCH = "nonmainnet";
/** OD-4-7 / W-15: a fully funded table whose host has not pressed Start may be started by any funded player after this. */
export const START_GRACE_MS = 10 * 60 * 1000;
/** W-4: Start is refused this close to the chain's funding deadline (from it on, anyone may Cancel the escrow). */
export const START_MARGIN_MS = 5 * 60 * 1000;
/** W-2: a host's CreateGame may be in flight this long after its link (no admission gates CreateGame). */
export const HOST_CREATE_WINDOW_MS = 10 * 60 * 1000;
/** A deposit hint is forgotten this long after it was sent, if the chain never showed its transaction. */
export const HINT_TTL_MS = 10 * 60 * 1000;
/** Review S-M2: how many join admissions one seat may be given at one table (each locks the seat for its lifetime). */
export const MAX_ADMISSIONS_PER_SEAT = 8;
/** W-5: a bound table's waiting room lives at least this long past the chain's funding deadline. */
export const ROOM_DEADLINE_MARGIN_MS = 60 * 60 * 1000;
/** How fresh a chain read must be for a seat op to rely on it (else it reads again, inside the task). */
const SEAT_OP_FRESH_MS = 15_000;
/** How many pages (30 games each) one discovery pass reads of the contract's game list. */
const SCAN_PAGES = 3;
/** "Your deposits": the ledgers looked at, the tables read from Juno (newest first), and how long an answer is reused. */
const DEPOSITS_MAX_LEDGERS = 200;
const DEPOSITS_MAX_GAMES = 25;
const DEPOSITS_REUSE_MS = 5_000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
/** What a wallet link answers when the ledger refuses its issue (the sentences the link has always used). */
const LINK_REFUSALS: Readonly<Record<string, readonly [number, string]>> = {
  "reauth-required": [403, "Confirm it's you first."],
  "not-seated": [403, "You don't have a seat at that table."],
  "security-context-ended": [403, "This device was signed out (or your recovery key changed). Sign in again, confirm it's you, and link again."],
  frozen: [409, "The seats are locked with the escrow; the payout wallet can't change now."],
  conflict: [409, "The link changed meanwhile. Try again."],
  "admission-outstanding": [409, "This seat's join approval hasn't expired yet."],
  "proof-mismatch": [403, "The proof doesn't match the wallet."],
  "relink-mismatch": [409, "That deposit can't be relinked to this seat."],
};

/* ==================================================================
    TYPES
   ================================================================== */

/** The authenticated caller of a `/gs/api/money/*` route (server-private: never on the wire). */
export interface MoneyCaller {
  readonly sessionId: string;
  readonly familyId: string;
  readonly recoverySelector: string;
  readonly principalId: string;
  /** This session holds a live "Confirm it's you" grant (`/gs/api/profile/reauth`, 3A) -- and nothing else counts. */
  readonly sensitive: boolean;
  /** The request's allow-listed Origin: the challenge's `Site:`. */
  readonly origin: string;
}

export type MoneyAnswer = { readonly ok: true; readonly status?: number; readonly body: Record<string, unknown> } | { readonly ok: false; readonly status: number; readonly code: string; readonly reason: string };

const answer = (body: Record<string, unknown>, status = 200): MoneyAnswer => ({ ok: true, status, body });
const refusal = (status: number, code: string, reason: string): MoneyAnswer => ({ ok: false, status, code, reason });

/** What the room host lends this module (every mutation of a table stays the room host's, in the game's actor). */
export interface MoneyRoomPort {
  /** Run `task` inside the game's actor ("room-op"): serialized with every seat op and move of the game. */
  runTask<T>(gameId: string, task: (record: GameRecord) => Promise<T>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly reason: string }>;
  /** The table's record as last committed (the room index), or null. */
  recordOf(gameId: string): GameRecord | null;
  /** Push fresh views to the table's readers (and the lobby list). */
  refresh(gameId: string): void;
  hasViewers(gameId: string): boolean;
  /** Every money table the room host knows. */
  moneyRecords(): GameRecord[];
  /** Server tasks (idempotent): W-5's expiry extension; mirroring the chain's CANCELLED; the deal after the chain's Start. */
  extendExpiry(gameId: string, until: number): Promise<void>;
  mirrorCancelled(gameId: string): Promise<void>;
  dealStarted(gameId: string): Promise<void>;
}

export interface MoneyTablesDeps {
  /** The operator's switch (`MONEY_TABLES_SWITCH`). Off: no money table is created (existing ones keep working). */
  readonly enabled: boolean;
  readonly service: EscrowService;
  readonly pin: FinancialDeploymentPin;
  readonly symbol: string;
  readonly rest: JunoRest;
  readonly tickets: WalletTicketLedger;
  readonly financial: FinancialGameStore;
  /** The app's display name, written into the wallet-link challenge. */
  readonly appName: string;
  readonly now: () => number;
  readonly warn: (line: string) => void;
  readonly ops?: OpsRecorder;
  readonly challenges?: ChallengeBook;
  /** Tests: the observer's ticks are driven by hand. */
  readonly manualObserver?: boolean;
}

type Snapshot = Awaited<ReturnType<WalletTicketLedger["snapshot"]>>;
type Grant = Snapshot["grants"][number];

interface Hint {
  readonly playerId: string;
  readonly kind: MoneyHintKind;
  readonly txHash: string;
  readonly chainGameId: string | null;
  /** When this transaction was FIRST hinted (a re-send of the same hash never extends it: review R-M8). */
  readonly at: number;
  /** The height after which the transaction can never land (its timeout height, as the browser signed it), if said. */
  readonly timeoutHeight: string | null;
  /** Juno included it successfully: a deposit's hint is kept until the chain read shows what it did (the seat funded,
   *  the host's escrow bound), so the seat never looks undeposited in between (review R-M1). */
  readonly landed: boolean;
}

interface TableCache {
  readonly gameId: string;
  financial: FinancialGameRecord | null;
  financialError: boolean;
  ledger: Snapshot | null;
  chain: { readonly observedAt: number; readonly response: JunoGameResponse } | null;
  chainError: string | null;
  intents: readonly ChainIntentRecord[];
  observedAt: number;
  refreshing: Promise<void> | null;
  again: boolean;
  digest: string;
  /** Discovery of the host's CreateGame: the ticket being looked for, and how far the game list was read. */
  scan: { ticket: string; cursor: string | null } | null;
  /** Chain games the host's wallet opened that W-13 refused (another ticket: a duplicate escrow, A-4). */
  duplicates: Set<string>;
}

interface ChainConfig {
  readonly feeBps: number;
  readonly minAnte: string | null;
  readonly nextChainGameId: string | null;
  readonly fundingPeriodLiveSecs: string | null;
  readonly fundingPeriodAsyncSecs: string | null;
  readonly paused: boolean;
  readonly at: number;
}

/** A seat's position, as the ledger and the chain say it together. */
interface SeatClaim {
  funding: MoneySeatFunding;
  chainSeatIndex: number | null;
  payoutWallet: string | null;
  unlinked: string | null;
}

/* ==================================================================
    PURE PROJECTION HELPERS (also used when no backend is configured)
   ================================================================== */

export function deploymentViewOf(terms: GameMoneyTerms): MoneyDeploymentView {
  return { backend: terms.backend, chainId: terms.chain_id, networkClass: terms.network_class, contract: terms.contract_address, codeChecksum: terms.code_checksum, denom: terms.denom, symbol: terms.symbol, exponent: terms.exponent };
}

const secsToMs = (secs: string | null | undefined): number | null => (typeof secs === "string" && /^[0-9]{1,15}$/.test(secs) ? Number(secs) * 1000 : null);

/** A money table's view when this server has no working money layer (the backend is off or unconfigured): terms only. */
export function disabledMoneyView(record: GameRecord, principalId: string | null): RoomMoneyView | null {
  const terms = record.money;
  if (terms === null) return null;
  const seat = principalId === null ? null : seatOf(record, principalId);
  return {
    deployment: deploymentViewOf(terms),
    terms: { anteGross: terms.ante_gross, feeBps: null, anteNet: null, pot: null, mode: terms.mode, seats: record.exact_players ?? record.seats.length, minAnte: null, rulesEngineVersion: null },
    escrow: { chainGameId: null, state: "unknown", paused: false, fundingDeadline: null, observedAt: null, fundedSeats: 0, foreignSeats: 0, fullyFundedAt: null },
    seats: record.seats.map((entry) => ({ playerId: entry.player_id, funding: "none" as const })),
    start: { state: "not-ready", blocker: "backend-unavailable", anyoneMayStartAt: null, canStart: false, epoch: 0 },
    settlement: null,
    you:
      seat === null
        ? null
        : { playerId: seat.player_id, link: null, funding: "none", chainSeatIndex: null, payoutWallet: null, chainConsentKey: null, unlinkedDeposit: null, admissionUntil: null, pending: null, actions: [] },
    held: false,
  };
}

export function disabledStake(record: GameRecord): RoomStakeSummary | null {
  const terms = record.money;
  if (terms === null) return null;
  return { anteGross: terms.ante_gross, symbol: terms.symbol, exponent: terms.exponent, networkClass: terms.network_class, funded: 0, seats: record.exact_players ?? record.seats.length };
}

const HINT_KINDS: readonly MoneyHintKind[] = ["create", "join", "withdraw", "cancel", "set-consent-key", "challenge", "liveness-settle", "finalize"];
const CONSENT_KEY = /^0[23][0-9a-f]{64}$/;
/* PHASE 3 W2-K (U-44, owner OD-9(a)): a player reads money times in their own local time with its zone -- which only
   the browser knows. These refusal sentences go to one player at the moment of the refusal, so they say how long
   from now rather than a clock in a zone the player doesn't live in. Copy only: the instants, the checks and the
   codes are unchanged; machine evidence and logs stay UTC. */
const fromNow = (at: number, now: number): string => {
  const minutes = Math.max(1, Math.ceil((at - now) / 60_000));
  if (minutes === 1) return "about a minute";
  if (minutes < 120) return `about ${minutes} minutes`;
  return `about ${Math.round(minutes / 60)} hours`;
};

/* ==================================================================
    THE MONEY LAYER
   ================================================================== */

export function createMoneyTables(deps: MoneyTablesDeps, room: MoneyRoomPort) {
  const challenges = deps.challenges ?? createChallengeBook({ now: deps.now, appName: deps.appName });
  const cache = new Map<string, TableCache>();
  const hints = new Map<string, Map<string, Hint>>();
  /** Join admissions signed per seat (`gameId\0playerId`), in memory (S-M2's budget). */
  const admissionsAsked = new Map<string, number>();
  let config: ChainConfig | null = null;
  let configLoading: Promise<ChainConfig | null> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = 0;
  const audit = (event: string, fields: Record<string, unknown>) => deps.ops?.audit(event, fields);
  const contract = deps.pin.contract_address;

  /* ---------------- enablement ---------------- */

  /** Whether a money table may be created here now -- checked BEFORE anything is written (no code, no financial record,
   *  no GameRecord): the operator's switch, never mainnet, a configured and chain-verified escrow deployment, and the
   *  CREATION VERDICT (LIVE-4 amendment §4): the identity the table would freeze -- the current rules engine and
   *  protocols -- is one this deployment continues, so rules not yet settlement-certified refuse `rules-not-certified`.
   *  `createMoneyGame` asks the same verdict again before it writes. */
  function creationStatus(): { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason: string } {
    if (!deps.enabled) return { ok: false, code: "money-games-disabled", reason: "Real-money tables are not enabled on this server." };
    if (deps.pin.network_class === "mainnet") return { ok: false, code: "money-games-disabled", reason: "Real-money tables are not open on Juno mainnet yet." };
    if (!deps.service.isReady()) return { ok: false, code: "money-games-disabled", reason: "The Juno escrow is not verified yet. Try again in a minute." };
    /* LIVE-4 (L4-4): the canonical creation verdict (identity, protocols, codec, and the deployment served AND verified
       at verification grade this run); `createMoneyGame` asks it again before it writes. */
    const verdict = deps.service.creationVerdict();
    if (verdict.kind !== "continues") {
      if (verdict.why === "rules-not-certified") return { ok: false, code: "rules-not-certified", reason: "This server's game rules aren't certified for real-money settlement yet, so real-money tables can't open here." };
      if (verdict.why === "deployment-unverified") return { ok: false, code: "deployment-unverified", reason: "The Juno escrow hasn't been confirmed from the chain yet. Try again in a minute." };
      return { ok: false, code: verdict.why, reason: "This server can't continue a real-money table it would open now (its money protocol isn't one it serves), so none can open here." };
    }
    return { ok: true };
  }

  /* ---------------- chain reads ---------------- */

  async function quorumSmart(query: string): Promise<unknown> {
    return deps.rest.smartQuorum !== undefined ? deps.rest.smartQuorum(contract, query) : deps.rest.smart(contract, query);
  }

  async function readChainGame(chainGameId: string): Promise<JunoGameResponse> {
    return parseGameResponse(await quorumSmart(QUERY.game(chainGameId)));
  }

  async function chainConfig(maxAgeMs = 60_000): Promise<ChainConfig | null> {
    if (config !== null && deps.now() - config.at < maxAgeMs) return config;
    if (configLoading !== null) return configLoading;
    configLoading = (async () => {
      try {
        const parsed = parseConfigResponse(await deps.rest.smart(contract, QUERY.config()));
        config = {
          feeBps: parsed.subsidy_bps,
          minAnte: parsed.min_ante,
          nextChainGameId: parsed.next_chain_game_id,
          fundingPeriodLiveSecs: parsed.funding_period_live_secs,
          fundingPeriodAsyncSecs: parsed.funding_period_async_secs,
          paused: parsed.paused,
          at: deps.now(),
        };
      } catch (error) {
        deps.warn(`  money: the escrow's configuration could not be read -- ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        configLoading = null;
      }
      return config;
    })();
    return configLoading;
  }

  /* ---------------- the cache ---------------- */

  function entryOf(gameId: string): TableCache {
    let entry = cache.get(gameId);
    if (entry === undefined) {
      entry = { gameId, financial: null, financialError: false, ledger: null, chain: null, chainError: null, intents: [], observedAt: 0, refreshing: null, again: false, digest: "", scan: null, duplicates: new Set() };
      cache.set(gameId, entry);
    }
    return entry;
  }

  const hintsOf = (gameId: string): Map<string, Hint> => {
    let map = hints.get(gameId);
    if (map === undefined) {
      map = new Map();
      hints.set(gameId, map);
    }
    return map;
  };

  const newestOf = (grants: readonly Grant[], playerId: string): Grant | undefined =>
    grants.filter((grant) => grant.player_id === playerId).reduce<Grant | undefined>((best, grant) => (best === undefined || grant.epoch > best.epoch ? grant : best), undefined);

  /** The seat's standing, proven link (the one a deposit carries), or null. */
  const standingLinkOf = (grants: readonly Grant[], playerId: string): Grant | null => {
    const newest = newestOf(grants, playerId);
    return newest !== undefined && newest.standing && newest.proof !== null ? newest : null;
  };

  /** Every seat's position from the ledger and the chain: funded (the chain seat carries the seat's standing ticket),
   *  unlinked (an earlier ticket of the seat), and the chain seats nobody at the table claims. */
  function claimsOf(record: GameRecord, grants: readonly Grant[], game: JunoGameResponse | null, seatHints: Map<string, Hint> | undefined): { readonly bySeat: Map<string, SeatClaim>; readonly foreign: number[] } {
    const bySeat = new Map<string, SeatClaim>();
    for (const seat of record.seats) bySeat.set(seat.player_id, { funding: "none", chainSeatIndex: null, payoutWallet: null, unlinked: null });
    const foreign: number[] = [];
    if (game !== null) {
      game.game.seats.forEach((chainSeat, index) => {
        /* The NEWEST grant carrying this (wallet, ticket): a relink re-adopts a ticket under a later epoch. */
        const grant = grants
          .filter((entry) => entry.wallet === chainSeat.wallet && entry.ticket === chainSeat.join_ticket)
          .reduce<Grant | undefined>((best, entry) => (best === undefined || entry.epoch > best.epoch ? entry : best), undefined);
        const claim = grant === undefined ? undefined : bySeat.get(grant.player_id);
        if (grant === undefined || claim === undefined) {
          foreign.push(index);
          return;
        }
        const newest = newestOf(grants, grant.player_id);
        if (newest !== undefined && newest.epoch === grant.epoch && grant.standing) {
          claim.funding = "funded";
          claim.chainSeatIndex = index;
          claim.payoutWallet = chainSeat.wallet;
        } else if (claim.funding !== "funded") {
          claim.unlinked = chainSeat.wallet;
          claim.chainSeatIndex = index;
        }
      });
    }
    for (const [playerId, claim] of bySeat) {
      if (claim.funding === "funded") continue;
      if (claim.unlinked !== null) claim.funding = "unlinked";
      else if (seatHints?.get(playerId) !== undefined && (seatHints.get(playerId)?.kind === "create" || seatHints.get(playerId)?.kind === "join")) claim.funding = "sent";
      else if (standingLinkOf(grants, playerId) !== null) claim.funding = "linked";
    }
    return { bySeat, foreign };
  }

  const dealtRecord = (record: GameRecord): boolean => record.started_at !== null || record.status === "active" || record.status === "completed";

  /** The instants at which what a player may do changes while nothing else does -- anyone may start, Start closes,
   *  funding closes, the challenge window ends, the inactivity exit opens, an admission lapses, the host's CreateGame
   *  window ends (review R-H2). The observer's next pass after one of them pushes the view again. */
  function thresholdsOf(entry: TableCache): number[] {
    const out: number[] = [];
    const response = entry.chain?.response ?? null;
    if (response !== null) {
      const deadline = secsToMs(response.deadlines.funding_deadline);
      if (deadline !== null) out.push(deadline - START_MARGIN_MS, deadline);
      const full = fullyFundedAtOf(response.game);
      if (full !== null) out.push(full + START_GRACE_MS);
      for (const at of [response.deadlines.challenge_window_end, response.deadlines.liveness_available_at, response.deadlines.resolver_timeout_at]) {
        const ms = secsToMs(at);
        if (ms !== null) out.push(ms);
      }
    }
    for (const grant of entry.ledger?.grants ?? []) {
      if (grant.admitted_until_secs !== null) out.push(grant.admitted_until_secs * 1000 + ADMISSION_CLOCK_SKEW_MS);
      out.push(grant.issued_at + HOST_CREATE_WINDOW_MS);
    }
    return out;
  }

  function digestOf(entry: TableCache): string {
    const hintList = [...(hints.get(entry.gameId)?.values() ?? [])].map((hint) => `${hint.playerId}:${hint.kind}:${hint.txHash}:${hint.landed}`);
    const now = deps.now();
    return createHash("sha256")
      .update(
        JSON.stringify({
          t: thresholdsOf(entry).map((at) => now >= at),
          f: entry.financial === null ? null : [entry.financial.record_version, entry.financial.phase],
          l: entry.ledger?.grants.map((grant) => [grant.player_id, grant.epoch, grant.standing, grant.admitted_until_secs, grant.consent_keys.length, grant.frozen_at]) ?? null,
          c: entry.chain?.response ?? null,
          e: entry.chainError !== null,
          h: hintList,
          i: entry.intents.map((intent) => [intent.intent_id, intent.status]),
          a: deps.service.annulCollected(entry.gameId),
        }),
      )
      .digest("hex");
  }

  /** The newest committed record of a table from the room index. */
  const recordOf = (gameId: string): GameRecord | null => {
    const record = room.recordOf(gameId);
    return record !== null && record.money !== null ? record : null;
  };

  /* ---------------- discovery of a host's CreateGame (W-13 binds it) ---------------- */

  function hostExpectation(record: GameRecord, grant: Grant) {
    const terms = record.money as GameMoneyTerms;
    return { creator: grant.wallet, ticket: grant.ticket, anteGross: terms.ante_gross, maxPlayers: record.exact_players ?? 0, mode: (terms.mode === "live" ? 0 : 1) as 0 | 1 };
  }

  /** Look for the host's CreateGame: first a hinted chain game id, then the contract's game list from the ticket's own
   *  floor. Every candidate is BOUND only through W-13 (a quorum read proving it is exactly the table's). */
  async function discover(entry: TableCache, record: GameRecord): Promise<boolean> {
    if (!deps.service.isReady()) return false;
    const grants = entry.ledger?.grants ?? [];
    const hostGrant = standingLinkOf(grants, record.host_player_id);
    if (hostGrant === null) return false;
    const expect = hostExpectation(record, hostGrant);
    /* A candidate refused because the backend isn't verified yet may pass later: the scan stops before it and reads it
       again next time (review S-L1). Every other refusal is about the candidate itself (not the host's escrow, other
       terms, an invalid binding) and is final -- it is set aside and the scan moves on (verification pass). A read that
       fails throws, and the cursor stays where it was. */
    let retryFrom: string | null | undefined;
    const tryBind = async (chainGameId: string, before: string | null): Promise<boolean> => {
      const bound = await deps.service.bindHostChainGame(record.game_id, chainGameId, record.variants, expect);
      if (bound.ok) {
        audit("money.host-escrow-bound", { game_id: record.game_id, chain_game_id: chainGameId });
        entry.financial = await deps.financial.load(record.game_id).catch(() => entry.financial);
        entry.scan = null;
        return true;
      }
      if (bound.code === "not-verified") {
        if (retryFrom === undefined) retryFrom = before;
      } else entry.duplicates.add(chainGameId);
      return false;
    };
    const hint = hints.get(record.game_id)?.get(record.host_player_id);
    if (hint !== undefined && hint.kind === "create" && hint.chainGameId !== null && !entry.duplicates.has(hint.chainGameId)) {
      if (await tryBind(hint.chainGameId, null)) return true;
      retryFrom = undefined; // the hinted id is re-read from the hint next time; it moves no cursor
    }
    if (entry.scan === null || entry.scan.ticket !== hostGrant.ticket) {
      const floor = hostGrant.create_floor;
      entry.scan = { ticket: hostGrant.ticket, cursor: floor !== null && floor !== "0" ? (BigInt(floor) - BigInt(1)).toString() : null };
    }
    for (let page = 0; page < SCAN_PAGES; page += 1) {
      const scan = entry.scan;
      if (scan === null) break;
      const games = parseGamesResponse(await deps.rest.smart(contract, QUERY.games(scan.cursor, 30)));
      let previous = scan.cursor;
      for (const summary of games) {
        const candidate = summary.creator === expect.creator && summary.state === "FUNDING" && summary.seats_filled === 1 && summary.ante_gross === expect.anteGross && summary.max_players === expect.maxPlayers && summary.mode === expect.mode;
        if (candidate && !entry.duplicates.has(summary.chain_game_id) && (await tryBind(summary.chain_game_id, previous))) return true;
        if (retryFrom !== undefined) {
          scan.cursor = retryFrom;
          return false;
        }
        previous = summary.chain_game_id;
      }
      if (games.length > 0) scan.cursor = games[games.length - 1].chain_game_id;
      if (games.length < 30) break;
    }
    return false;
  }

  /* ---------------- refresh: what the table's money is now ---------------- */

  async function resolveHints(gameId: string): Promise<void> {
    const map = hints.get(gameId);
    if (map === undefined) return;
    let height: bigint | null | undefined;
    const chainHeight = async (): Promise<bigint | null> => {
      if (height === undefined) {
        try {
          const block = await deps.rest.latestBlock();
          height = /^[0-9]{1,20}$/.test(block.height) ? BigInt(block.height) : null;
        } catch {
          height = null;
        }
      }
      return height;
    };
    for (const [key, hint] of [...map]) {
      if (deps.now() - hint.at > HINT_TTL_MS) {
        map.delete(key);
        continue;
      }
      if (hint.landed) continue; // settled by the chain read (refreshNow), or it ages out
      try {
        const found = await deps.rest.tx(hint.txHash);
        if (found === null) {
          /* Not (yet) on this node. Past its timeout height it can never land: the hint is void. */
          const now = hint.timeoutHeight === null ? null : await chainHeight();
          if (now !== null && hint.timeoutHeight !== null && now > BigInt(hint.timeoutHeight)) map.delete(key);
        } else if (found.code !== 0 || (hint.kind !== "create" && hint.kind !== "join")) {
          /* Failed, or not a deposit: the chain state read decides what it did; the hint's work is done. */
          map.delete(key);
        } else {
          map.set(key, { ...hint, landed: true });
        }
      } catch {
        /* unknown: kept until the chain answers or the hint ages out */
      }
    }
  }

  /** A deposit's hint is done once the chain read shows what it was for: the seat's deposit (funded or unlinked), or --
   *  the host's CreateGame -- the escrow bound (discovery was the hint's only job; a later CreateGame of the host is a
   *  duplicate, found by "Your deposits"). Landed or not. */
  function settleDepositHints(record: GameRecord, entry: TableCache): void {
    const map = hints.get(record.game_id);
    if (map === undefined || entry.ledger === null) return;
    const claims = claimsOf(record, entry.ledger.grants, entry.chain?.response ?? null, undefined);
    const bound = entry.financial?.binding?.escrow != null && entry.chain !== null;
    for (const [key, hint] of [...map]) {
      if (hint.kind !== "create" && hint.kind !== "join") continue;
      const claim = claims.bySeat.get(hint.playerId);
      const shown = claim !== undefined && (claim.funding === "funded" || claim.funding === "unlinked");
      if (shown || (hint.kind === "create" && bound) || claim === undefined) map.delete(key);
    }
  }

  async function refreshNow(gameId: string): Promise<void> {
    const record = recordOf(gameId);
    if (record === null) {
      cache.delete(gameId);
      return;
    }
    const entry = entryOf(gameId);
    try {
      entry.financial = await deps.financial.load(gameId);
      entry.financialError = false;
    } catch {
      entry.financialError = true;
    }
    try {
      entry.ledger = await deps.tickets.snapshot(gameId);
    } catch {
      entry.ledger = null;
    }
    /* LIVE-4 (L4-4, review R-3 / N-1): the canonical verdict BEFORE anything this observation can lead to. Two gates:
       - READ: the chain is read for the players' projection -- their own exits (withdraw, refund, challenge) on their
         own contract -- only when the table's escrow IS this server's deployment (its key served here: the chain game
         read is then the table's own; another deployment's game of the same number never is). Reads write nothing.
       - ACT: a bind, the deal, a cancelled or extended room, a closed record -- only for a table this server CONTINUES.
       A table whose escrow is elsewhere (or whose facts cannot be read now) is projected from what is stored. */
    const decision = entry.financial === null ? null : await deps.service.servingDecision(gameId, { where: "money observer", ownerKey: moneyTermsKey(record.money) }).catch(() => null);
    const ownContract = decision !== null && decision.owner;
    const continued = decision !== null && decision.verdict.kind === "continues";
    if (!ownContract) {
      entry.observedAt = deps.now();
      const digest = digestOf(entry);
      if (digest !== entry.digest) {
        entry.digest = digest;
        room.refresh(gameId);
      }
      return;
    }
    await resolveHints(gameId);
    const fin = entry.financial;
    const waiting = record.status === "waiting" && !dealtRecord(record);
    if (continued && fin !== null && fin.binding?.escrow == null && waiting && fin.phase === "funding") {
      try {
        await discover(entry, record);
        entry.chainError = null;
      } catch (error) {
        entry.chainError = error instanceof Error ? error.message : String(error);
      }
    }
    const bound = entry.financial?.binding?.escrow ?? null;
    const terminalRead = entry.chain !== null && ["SETTLED", "ANNULLED", "CANCELLED"].includes(entry.chain.response.game.state);
    if (bound !== null && entry.financial !== null && entry.financial.phase !== "closed" && entry.financial.phase !== "cancelled") {
      try {
        entry.chain = { observedAt: deps.now(), response: await readChainGame(bound.chain_game_id) };
        entry.chainError = null;
      } catch (error) {
        entry.chainError = error instanceof Error ? error.message : String(error);
      }
    } else if (bound !== null && !terminalRead) {
      /* A closed escrow: read until its outcome (amounts, route) is seen, then never again. */
      try {
        entry.chain = { observedAt: deps.now(), response: parseGameResponse(await deps.rest.smart(contract, QUERY.game(bound.chain_game_id))) };
        entry.chainError = null;
      } catch {
        /* the financial record says enough */
      }
    }
    if (entry.financial !== null && (entry.financial.roster !== null || DEALT_PHASES.includes(entry.financial.phase) || entry.financial.phase === "held")) {
      entry.intents = await deps.service.intentsOf(gameId).catch(() => entry.intents);
    }
    if (entry.chainError === null) settleDepositHints(record, entry);
    entry.observedAt = deps.now();
    if (continued) await consequences(entry, record);
    const digest = digestOf(entry);
    if (digest !== entry.digest) {
      entry.digest = digest;
      room.refresh(gameId);
    }
  }

  /** What an observation obliges the server to do (each a server task on the table, idempotent). */
  async function consequences(entry: TableCache, record: GameRecord): Promise<void> {
    const fin = entry.financial;
    const g = entry.chain?.response.game ?? null;
    const waiting = record.status === "waiting" && !dealtRecord(record);
    if (fin === null) return;
    /* The chain's Start is confirmed: deal (the roster source re-checks the chain at the deal). */
    if (fin.chain.started !== null && waiting) await room.dealStarted(record.game_id).catch((error) => deps.warn(`  money: the deal of ${record.game_id} after its Start failed -- ${error instanceof Error ? error.message : String(error)}`));
    if (g !== null && fin.binding?.escrow != null) {
      /* The escrow was cancelled on chain (the creator, or anyone after the deadline): the record closes, the room too. */
      if (g.state === "CANCELLED") {
        if (fin.phase === "funding") await deps.service.observe(record.game_id);
        if (record.status === "waiting") await room.mirrorCancelled(record.game_id).catch(() => undefined);
      }
      /* W-5: a bound table's waiting room outlives the chain's funding deadline. */
      const deadline = secsToMs(entry.chain?.response.deadlines.funding_deadline);
      if (waiting && deadline !== null && (record.expires_at ?? 0) < deadline + ROOM_DEADLINE_MARGIN_MS) await room.extendExpiry(record.game_id, deadline + ROOM_DEADLINE_MARGIN_MS).catch(() => undefined);
    }
    /* A table that ended before any escrow was bound closes its financial record -- unless the host's CreateGame may
       still be in flight (then the chain answers first). */
    if ((record.status === "cancelled" || record.status === "expired") && fin.phase === "funding" && fin.binding?.escrow == null) {
      const hostGrant = standingLinkOf(entry.ledger?.grants ?? [], record.host_player_id);
      if (hostGrant === null || !hostCreateInFlight(record, hostGrant)) await deps.service.closeUnboundTable(record.game_id);
    }
  }

  /** One refresh at a time per table; a request while one runs runs once more after it. */
  function refresh(gameId: string): Promise<void> {
    const entry = entryOf(gameId);
    if (entry.refreshing !== null) {
      entry.again = true;
      return entry.refreshing;
    }
    running += 1;
    const run = (async () => {
      try {
        do {
          entry.again = false;
          await refreshNow(gameId);
        } while (entry.again);
      } catch (error) {
        deps.warn(`  money: ${gameId} could not be observed -- ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        entry.refreshing = null;
        running -= 1;
      }
    })();
    entry.refreshing = run;
    return run;
  }

  const soon = (gameId: string) => void refresh(gameId);

  /* ---------------- the observer's cadence ---------------- */

  function cadenceOf(record: GameRecord, entry: TableCache | undefined): number | null {
    const phase = entry?.financial?.phase ?? "funding";
    if (phase === "closed" || phase === "cancelled") return null;
    if (record.archived_at !== null || record.status === "cancelled" || record.status === "expired") return hints.get(record.game_id)?.size ? 60_000 : null;
    const viewers = room.hasViewers(record.game_id);
    if (!dealtRecord(record)) return viewers ? 15_000 : 60_000;
    if (phase === "in-progress" || phase === "liveness") return viewers ? 60_000 : 5 * 60_000;
    return viewers ? 15_000 : 60_000;
  }

  function tick(): void {
    const now = deps.now();
    for (const record of room.moneyRecords()) {
      if (running >= 4) return;
      const entry = cache.get(record.game_id);
      const cadence = cadenceOf(record, entry);
      if (cadence === null) continue;
      if (entry !== undefined && (entry.refreshing !== null || now - entry.observedAt < cadence)) continue;
      soon(record.game_id);
    }
  }

  /* ---------------- the projection ---------------- */

  function settlementOf(fin: FinancialGameRecord, entry: TableCache, record: GameRecord): MoneySettlementView | null {
    const dealt = DEALT_PHASES.includes(fin.phase) || (fin.phase === "held" && fin.chain.started !== null) || dealtRecord(record);
    if (!dealt && fin.phase !== "cancelled") return null;
    const response = entry.chain?.response ?? null;
    const g = response?.game ?? null;
    const now = deps.now();
    const chainState: MoneyEscrowState = g === null ? "unknown" : g.state;
    const settleIntent = entry.intents.filter((intent) => intent.op.kind === "settle").sort((a, b) => b.created_at - a.created_at)[0];
    const windowEnd = secsToMs(response?.deadlines.challenge_window_end ?? null);
    let status: MoneySettlementStatus;
    if (fin.phase === "held") status = "held";
    else if (fin.phase === "cancelled") status = "cancelled";
    else if (fin.phase === "closed" || (g !== null && (g.state === "SETTLED" || g.state === "ANNULLED" || g.state === "CANCELLED"))) {
      const state = g?.state ?? fin.chain_outcome?.state;
      status = state === "ANNULLED" ? "annulled" : state === "CANCELLED" ? "refunded" : "paid";
    } else if (g !== null && g.state === "DISPUTED") status = "disputed";
    else if (g !== null && g.state === "SETTLEABLE") status = response?.paused ? "paused" : windowEnd !== null && now >= windowEnd ? "release-available" : "recorded";
    else if (fin.phase === "terminal-eligible" || fin.phase === "intent-prepared") status = settleIntent !== undefined && settleIntent.status !== "pending" ? "submitted" : "preparing";
    else status = "none";
    const stored = g?.settlement ?? null;
    const prepared = fin.chain.checkpoint_prepared;
    const confirmed = fin.chain.checkpoint_confirmed;
    return {
      status,
      phase: fin.phase,
      chainState,
      seq: stored?.payload.seq ?? null,
      settleDigest: stored?.payload.payload_digest ?? null,
      domain: g?.domain ?? null,
      source: stored?.source ?? null,
      windowEnd,
      livenessAvailableAt: secsToMs(response?.deadlines.liveness_available_at ?? null),
      resolverTimeoutAt: secsToMs(response?.deadlines.resolver_timeout_at ?? null),
      consentedSeats: g === null ? [] : g.seats.map((_, index) => index).filter((index) => (g.consent_bitmap & (1 << index)) !== 0),
      payable: stored === null ? null : !entry.intents.some((intent) => intent.status === "held" && intent.op.kind === "finalize"),
      amounts: g?.outcome?.amounts ? [...g.outcome.amounts] : null,
      route: g?.outcome?.route ?? fin.chain_outcome?.route ?? null,
      trustedSeq: response?.trusted_seq ?? null,
      annulSigned: [...(deps.service.annulCollected(fin.game_id)?.collected ?? [])],
      bond: g?.bond ?? null,
      lastCheckpoint:
        prepared === null
          ? null
          : { seq: prepared.seq, logLen: prepared.log_len, roundKey: prepared.round_key, confirmed: confirmed !== null && BigInt(confirmed.seq) >= BigInt(prepared.seq) },
    };
  }

  function startOf(record: GameRecord, entry: TableCache, claims: ReturnType<typeof claimsOf> | null, viewerSeat: string | null, isHost: boolean): MoneyStartView {
    const fin = entry.financial;
    const response = entry.chain?.response ?? null;
    const g = response?.game ?? null;
    const now = deps.now();
    const epoch = fin?.roster_epoch ?? 0;
    if (fin !== null && fin.chain.started !== null) return { state: "started", blocker: null, anyoneMayStartAt: null, canStart: false, epoch };
    if (fin !== null && fin.roster !== null) return { state: "starting", blocker: null, anyoneMayStartAt: null, canStart: false, epoch };
    const base: MoneyStartView["state"] = epoch > 0 ? "rolled-back" : "not-ready";
    const blocked = (blocker: MoneyStartBlocker): MoneyStartView => ({ state: base, blocker, anyoneMayStartAt: null, canStart: false, epoch });
    if (fin === null || entry.financialError) return blocked("backend-unavailable");
    if (fin.phase === "held") return blocked("held");
    if (!deps.service.isReady()) return blocked("backend-unavailable");
    if (fin.binding?.escrow == null) return blocked("escrow-not-open");
    if (g === null || entry.chainError !== null || claims === null) return blocked("chain-unavailable");
    if (response?.paused) return blocked("paused");
    const deadline = secsToMs(response?.deadlines.funding_deadline ?? null);
    if (deadline !== null && now >= deadline) return blocked("funding-closed");
    if (record.seats.length < (record.exact_players ?? 0)) return blocked("need-seats");
    if (claims.foreign.length > 0) return blocked("unknown-deposit");
    const positions = [...claims.bySeat.values()];
    if (positions.some((claim) => claim.funding === "unlinked")) return blocked("unlinked-deposit");
    if (g.state !== "FUNDED" || positions.some((claim) => claim.funding !== "funded")) return blocked(positions.some((claim) => claim.funding === "sent") ? "deposit-in-flight" : "need-funding");
    if (deadline !== null && now >= deadline - START_MARGIN_MS) return blocked("deadline-near");
    const fullyFundedAt = fullyFundedAtOf(g);
    const anyoneAt = fullyFundedAt === null ? null : fullyFundedAt + START_GRACE_MS;
    const viewerFunded = viewerSeat !== null && claims.bySeat.get(viewerSeat)?.funding === "funded";
    const canStart = isHost || (viewerFunded && anyoneAt !== null && now >= anyoneAt);
    return { state: base === "rolled-back" ? "rolled-back" : "ready", blocker: null, anyoneMayStartAt: anyoneAt, canStart, epoch };
  }

  function fullyFundedAtOf(g: JunoGameResponse["game"]): number | null {
    if (g.state === "FUNDING" || g.seats.length === 0) return null;
    const joined = g.seats.map((seat) => secsToMs(seat.joined_at_secs)).filter((value): value is number => value !== null);
    return joined.length === g.seats.length ? Math.max(...joined) : null;
  }

  function actionsOf(record: GameRecord, entry: TableCache, claim: SeatClaim, link: Grant | null, isHost: boolean, start: MoneyStartView, settlement: MoneySettlementView | null, chainSeatConsented: boolean): MoneyAction[] {
    const out: MoneyAction[] = [];
    const fin = entry.financial;
    const response = entry.chain?.response ?? null;
    const g = response?.game ?? null;
    const now = deps.now();
    if (fin === null) return out;
    const held = fin.phase === "held";
    const frozen = fin.roster !== null || fin.chain.started !== null;
    const waiting = record.status === "waiting" && !dealtRecord(record);
    const bound = fin.binding?.escrow != null;
    const preStart = g !== null && (g.state === "FUNDING" || g.state === "FUNDED");
    const deadline = secsToMs(response?.deadlines.funding_deadline ?? null);
    /* The host is the escrow's creator: it leaves by Cancel (every deposit comes back), never by Withdraw -- a creator's
       withdrawal would leave an escrow its table can never fill (review R-H1). */
    if (waiting && !frozen && !held) {
      if (claim.funding === "none") out.push("link-wallet");
      if (claim.funding === "linked") {
        if (!isHost) out.push(bound && g?.state === "FUNDING" ? "deposit" : "link-wallet");
        else if (!bound) out.push("open-escrow", "link-wallet");
      }
      if (claim.funding === "unlinked") out.push(...(isHost ? (["relink"] as const) : (["relink", "withdraw"] as const)));
      if (claim.funding === "funded" && preStart && !isHost) out.push("withdraw");
      if (start.canStart) out.push("start");
    }
    if (isHost && bound && preStart && !frozen) out.push("cancel-escrow");
    /* A held table: the server's review holds what IT does; Juno's own exits stay the players' (below, and a
       non-host's withdrawal before the Start). */
    if (held && preStart && !frozen && !isHost && (claim.funding === "funded" || claim.funding === "unlinked")) out.push("withdraw");
    if (bound && preStart && deadline !== null && now >= deadline && (claim.funding === "funded" || claim.funding === "unlinked") && !frozen) out.push("refund-after-deadline");
    if (g !== null && claim.chainSeatIndex !== null && (g.state === "FUNDING" || g.state === "FUNDED" || g.state === "IN_PROGRESS" || g.state === "SETTLEABLE") && link !== null && !held) out.push("move-signing-key");
    if (settlement !== null && g !== null && claim.chainSeatIndex !== null) {
      /* Approving, releasing and the annul relay go through this server: not while it holds the table for review. */
      if (g.state === "SETTLEABLE" && !chainSeatConsented && settlement.status === "recorded" && !held) out.push("approve-payout");
      if (g.state === "SETTLEABLE" && settlement.windowEnd !== null && now < settlement.windowEnd) out.push("challenge");
      if (g.state === "SETTLEABLE" && settlement.windowEnd !== null && now >= settlement.windowEnd && !held) out.push("release-payout");
      const liveness = settlement.livenessAvailableAt ?? settlement.resolverTimeoutAt;
      if (liveness !== null && now >= liveness && (g.state === "IN_PROGRESS" || g.state === "SETTLEABLE" || g.state === "DISPUTED")) out.push("liveness-settle");
      if ((g.state === "IN_PROGRESS" || g.state === "SETTLEABLE") && !held) out.push("annul");
    } else if (g !== null && g.state === "IN_PROGRESS" && claim.chainSeatIndex !== null) {
      const liveness = secsToMs(response?.deadlines.liveness_available_at ?? null);
      if (liveness !== null && now >= liveness) out.push("liveness-settle");
      if (!held) out.push("annul");
    }
    return [...new Set(out)];
  }

  /** The chain seat a DEALT (or frozen) table's seat holds, from the frozen financial roster. */
  const frozenSeatOf = (fin: FinancialGameRecord | null, playerId: string): { index: number; wallet: string } | null => {
    const entry = fin?.roster?.roster.find((seat) => seat.player_id === playerId);
    return entry === undefined ? null : { index: entry.chain_seat_index, wallet: entry.payout_address };
  };

  function viewFor(record: GameRecord, principalId: string | null): RoomMoneyView | null {
    const terms = record.money;
    if (terms === null) return null;
    const entry = cache.get(record.game_id);
    if (entry === undefined) {
      soon(record.game_id);
      return disabledMoneyView(record, principalId);
    }
    const fin = entry.financial;
    const response = entry.chain?.response ?? null;
    const g = response?.game ?? null;
    const grants = entry.ledger?.grants ?? [];
    const seatHints = hints.get(record.game_id);
    const claims = entry.ledger === null ? null : claimsOf(record, grants, response, seatHints);
    /* Once frozen (or started), the frozen roster says who holds which chain seat (the payout wallet is final). */
    if (claims !== null && fin?.roster != null) {
      for (const seat of fin.roster.roster) {
        const claim = claims.bySeat.get(seat.player_id);
        if (claim !== undefined) {
          claim.funding = "funded";
          claim.chainSeatIndex = seat.chain_seat_index;
          claim.payoutWallet = seat.payout_address;
          claim.unlinked = null;
        }
      }
    }
    const seat = principalId === null ? null : seatOf(record, principalId);
    const isHost = seat !== null && seat.player_id === record.host_player_id;
    const start = startOf(record, entry, claims, seat?.player_id ?? null, isHost);
    const settlement = fin === null ? null : settlementOf(fin, entry, record);
    const bound = fin?.binding?.escrow ?? null;
    const escrowState: MoneyEscrowState = bound === null ? (fin?.phase === "cancelled" ? "CANCELLED" : "unbound") : g === null ? "unknown" : g.state;
    const feeBps = g?.terms.subsidy_bps ?? config?.feeBps ?? null;
    const anteNet = bound?.terms.ante_net ?? null;
    const exact = record.exact_players ?? record.seats.length;
    let you: MoneyYouView | null = null;
    if (seat !== null) {
      const claim = claims?.bySeat.get(seat.player_id) ?? { funding: "none" as MoneySeatFunding, chainSeatIndex: null, payoutWallet: null, unlinked: null };
      const frozenSeat = frozenSeatOf(fin, seat.player_id);
      const chainIndex = frozenSeat?.index ?? claim.chainSeatIndex;
      const link = standingLinkOf(grants, seat.player_id);
      const newest = newestOf(grants, seat.player_id);
      /* Every grant of the seat (a relink's newer grant may carry none while an older admission still lands). */
      const admittedSecs = grants.filter((grant) => grant.player_id === seat.player_id && admissionOutstanding(grant.admitted_until_secs, deps.now())).map((grant) => grant.admitted_until_secs as number);
      const admissionUntil = admittedSecs.length === 0 ? null : Math.max(...admittedSecs) * 1000;
      const hint = seatHints?.get(seat.player_id) ?? null;
      const chainSeat = g !== null && chainIndex !== null ? g.seats[chainIndex] : undefined;
      const consented = g !== null && chainIndex !== null && (g.consent_bitmap & (1 << chainIndex)) !== 0;
      you = {
        playerId: seat.player_id,
        link:
          link === null
            ? null
            : /* W2-M (AUD-20.13): the stored proof's own time -- a same-wallet re-proof renews it and keeps `issued_at`. */
              { wallet: link.wallet, epoch: link.epoch, ticket: link.ticket, linkedAt: link.issued_at, consentKeys: [...link.consent_keys], ...(link.proof !== null ? { proofVerifiedAt: link.proof.verified_at } : {}) },
        funding: claim.funding,
        chainSeatIndex: chainIndex,
        payoutWallet: frozenSeat?.wallet ?? claim.payoutWallet,
        chainConsentKey: chainSeat?.consent_pubkey ?? null,
        unlinkedDeposit: claim.unlinked === null ? null : { wallet: claim.unlinked },
        admissionUntil,
        pending: hint === null ? null : { kind: hint.kind, txHash: hint.txHash, at: hint.at },
        actions: actionsOf(record, entry, { ...claim, chainSeatIndex: chainIndex }, link, isHost, start, settlement, consented),
      };
    }
    const funded = claims === null ? 0 : [...claims.bySeat.values()].filter((claim) => claim.funding === "funded").length;
    return {
      deployment: deploymentViewOf(terms),
      terms: {
        anteGross: terms.ante_gross,
        feeBps,
        anteNet,
        pot: anteNet === null ? null : (BigInt(anteNet) * BigInt(exact)).toString(),
        mode: terms.mode,
        seats: exact,
        minAnte: config?.minAnte ?? null,
        rulesEngineVersion: fin?.continuation?.rules_engine_version ?? null,
      },
      escrow: {
        chainGameId: bound?.chain_game_id ?? null,
        state: escrowState,
        paused: response?.paused ?? false,
        fundingDeadline: secsToMs(response?.deadlines.funding_deadline ?? null),
        observedAt: entry.chain?.observedAt ?? null,
        fundedSeats: funded,
        foreignSeats: claims?.foreign.length ?? 0,
        fullyFundedAt: g === null ? null : fullyFundedAtOf(g),
      },
      seats: record.seats.map((entrySeat) => ({ playerId: entrySeat.player_id, funding: claims?.bySeat.get(entrySeat.player_id)?.funding ?? "none" })),
      start,
      settlement,
      you,
      held: fin?.phase === "held",
    };
  }

  function stakeFor(record: GameRecord): RoomStakeSummary | null {
    const base = disabledStake(record);
    if (base === null) return null;
    const entry = cache.get(record.game_id);
    if (entry === undefined || entry.ledger === null) return base;
    const claims = claimsOf(record, entry.ledger.grants, entry.chain?.response ?? null, hints.get(record.game_id));
    return { ...base, funded: [...claims.bySeat.values()].filter((claim) => claim.funding === "funded").length };
  }

  function myTableFor(record: GameRecord, principalId: string): MyTableMoneySummary | null {
    const terms = record.money;
    if (terms === null) return null;
    const view = viewFor(record, principalId);
    const base = { anteGross: terms.ante_gross, symbol: terms.symbol, exponent: terms.exponent, networkClass: terms.network_class };
    if (view === null || view.you === null) return { ...base, status: "link-wallet", actionNeeded: false };
    const phase = cache.get(record.game_id)?.financial?.phase ?? "funding";
    let status: MyTableMoneySummary["status"];
    if (view.held) status = "held";
    else if (phase === "cancelled" || view.escrow.state === "CANCELLED") status = "cancelled";
    else if (phase === "closed") status = "settled";
    else if (phase === "terminal-eligible" || phase === "intent-prepared" || phase === "settleable" || phase === "disputed") status = "settling";
    else if (phase === "in-progress" || phase === "liveness" || view.start.state === "started") status = "playing";
    else if (view.start.state === "starting") status = "starting";
    else if (view.you.funding === "none") status = "link-wallet";
    else if (view.you.funding === "linked") status = view.you.actions.includes("deposit") || view.you.actions.includes("open-escrow") ? "deposit" : "linked";
    else status = view.you.funding;
    /* "Change wallet" (a linked seat's `link-wallet`) is an option, not something this seat needs to do. */
    const needs = new Set<MoneyAction>([...(view.you.funding === "none" ? (["link-wallet"] as const) : []), "open-escrow", "deposit", "relink", "start", "approve-payout", "release-payout", "refund-after-deadline"]);
    return { ...base, status, actionNeeded: view.you.actions.some((action) => needs.has(action)) };
  }

  /* ---------------- seat locks (R-J1, W-2, W-3), inside the actor task ---------------- */

  function hostCreateInFlight(record: GameRecord, hostGrant: Grant): boolean {
    const hint = hints.get(record.game_id)?.get(record.host_player_id);
    return (hint !== undefined && hint.kind === "create") || deps.now() - hostGrant.issued_at < HOST_CREATE_WINDOW_MS;
  }

  /** A chain read of the bound game fresh enough to rely on for a seat op (the cache's, or one read now). */
  async function freshChain(gameId: string, chainGameId: string): Promise<JunoGameResponse | null> {
    const entry = entryOf(gameId);
    if (entry.chain !== null && entry.chainError === null && deps.now() - entry.chain.observedAt < SEAT_OP_FRESH_MS) return entry.chain.response;
    try {
      const response = await readChainGame(chainGameId);
      entry.chain = { observedAt: deps.now(), response };
      entry.chainError = null;
      return response;
    } catch (error) {
      entry.chainError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  /** Why this seat cannot be released or removed now (null: it can). */
  async function seatLock(record: GameRecord, fin: FinancialGameRecord | null, snapshot: Snapshot, playerId: string): Promise<{ readonly code: string; readonly reason: string } | null> {
    const grants = snapshot.grants.filter((grant) => grant.player_id === playerId);
    const outstanding = grants.filter((grant) => admissionOutstanding(grant.admitted_until_secs, deps.now()));
    if (outstanding.length > 0) {
      const until = Math.max(...outstanding.map((grant) => (grant.admitted_until_secs as number) * 1000)) + 120_000;
      return { code: "admission-outstanding", reason: `This seat can still be funded on Juno for ${fromNow(until, deps.now())} more (its join approval hasn't expired), so it can't be released or removed before then.` };
    }
    /* A joiner's Join can land only under a live admission (checked above, with the clock margin): a hint adds nothing
       to that lock, and a hint is only the browser's word -- so it never locks a joiner's seat (review S-M2). The
       host's CreateGame needs no admission: its hint (and its window after the link) is what says one may land. */
    const bound = fin?.binding?.escrow ?? null;
    const hint = hints.get(record.game_id)?.get(playerId);
    if (playerId === record.host_player_id && hint !== undefined && hint.kind === "create") return { code: "deposit-pending", reason: "Your table may be opening on Juno right now. Wait until Juno answers, then try again." };
    if (playerId === record.host_player_id && bound === null) {
      const hostGrant = standingLinkOf(snapshot.grants, playerId);
      if (hostGrant !== null && hostCreateInFlight(record, hostGrant)) return { code: "deposit-in-flight", reason: "The table may be opening on Juno right now. Wait for Juno to answer (a few minutes), then try again." };
    }
    if (bound !== null && grants.length > 0) {
      const game = await freshChain(record.game_id, bound.chain_game_id);
      if (game === null) return { code: "chain-unknown", reason: "Juno couldn't be checked just now, so nothing was changed. Try again in a moment." };
      const wallets = new Set(grants.map((grant) => grant.wallet));
      if ((game.game.state === "FUNDING" || game.game.state === "FUNDED") && game.game.seats.some((chainSeat) => wallets.has(chainSeat.wallet))) {
        return { code: "withdraw-first", reason: "This seat has a deposit on Juno. It has to be withdrawn first (Withdraw deposit), or the table cancelled on Juno." };
      }
    }
    return null;
  }

  /** The money table's own refusal of a seat op, decided in the game's actor task (null: the ordinary rules decide). */
  async function seatOpRefusal(record: GameRecord, op: string, principalId: string, targetPlayerId: string | null): Promise<{ readonly code: string; readonly reason: string } | null> {
    if (record.money === null) return null;
    if (dealtRecord(record)) return null;
    if (op === "transfer-host") return { code: "money-host-fixed", reason: "At a real-money table the host is the escrow's creator on Juno, so hosting can't be handed over before the game starts." };
    if (op !== "kick" && op !== "release-seat" && op !== "cancel-room") return null;
    let fin: FinancialGameRecord | null;
    let snapshot: Snapshot;
    try {
      fin = await deps.financial.load(record.game_id);
      snapshot = await deps.tickets.snapshot(record.game_id);
    } catch {
      return { code: "unavailable", reason: "The table's money records could not be read just now, so nothing was changed. Try again." };
    }
    if (fin?.phase === "held") return { code: "held", reason: "This table's money is on hold for review; its seats can't change." };
    const bound = fin?.binding?.escrow ?? null;
    if (op === "cancel-room") {
      if (bound !== null) {
        const game = await freshChain(record.game_id, bound.chain_game_id);
        if (game === null) return { code: "chain-unknown", reason: "Juno couldn't be checked just now, so the table wasn't cancelled. Try again in a moment." };
        if (game.game.state === "CANCELLED") return null;
        return { code: "cancel-on-juno", reason: "This table is open on Juno. Cancel it there (Cancel table on Juno): every deposit comes back minus the fee." };
      }
      const hostGrant = standingLinkOf(snapshot.grants, record.host_player_id);
      if (hostGrant !== null && hostCreateInFlight(record, hostGrant)) return { code: "deposit-in-flight", reason: "Your table may be opening on Juno right now. Wait for Juno to answer (a few minutes), then try again." };
      if (snapshot.grants.some((grant) => grant.player_id === record.host_player_id && grant.proof !== null)) {
        /* The host linked a wallet: look once more for its CreateGame before the table is dropped. */
        const entry = entryOf(record.game_id);
        entry.ledger = snapshot;
        try {
          if (await discover(entry, record)) return { code: "cancel-on-juno", reason: "This table is open on Juno. Cancel it there (Cancel table on Juno): every deposit comes back minus the fee." };
        } catch {
          return { code: "chain-unknown", reason: "Juno couldn't be checked just now, so the table wasn't cancelled. Try again in a moment." };
        }
      }
      return null;
    }
    const target = op === "kick" ? targetPlayerId : seatOf(record, principalId)?.player_id ?? null;
    if (target === null) return null;
    if (op === "release-seat" && target === record.host_player_id && (bound !== null || snapshot.grants.some((grant) => grant.player_id === target && grant.proof !== null))) {
      return bound !== null
        ? { code: "host-cancel-on-juno", reason: "The host of a real-money table leaves by cancelling it on Juno (Cancel table on Juno), so every deposit comes back." }
        : { code: "host-cancel-table", reason: "The host of a real-money table can't hand it over. Cancel the table instead (nothing of yours is on Juno yet)." };
    }
    return seatLock(record, fin, snapshot, target);
  }

  /* ---------------- start, inside the actor task ---------------- */

  const START_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
    "not-funded": "The table isn't fully funded on Juno yet.",
    "unbound-seat": "A wallet the table doesn't recognise holds a seat on Juno. It has to withdraw (or the table be cancelled) before the game can start.",
    "unfunded-player": "A seated player hasn't funded their seat on Juno yet.",
    "claim-conflict": "Two seats claim the same deposit on Juno; nothing was started.",
    "terms-mismatch": "The escrow on Juno doesn't match this table's terms; nothing was started.",
    "trust-policy": "The escrow on Juno isn't under this server's accepted terms; nothing was started.",
    paused: "Juno's escrow is paused right now. Start again once it resumes.",
    retry: "The previous Start didn't go through and is being rolled back. Start again in a moment.",
    conflict: "The table changed while it was being started. Start again.",
  });

  async function startInTask(record: GameRecord, principalId: string): Promise<{ readonly kind: "deal" } | { readonly kind: "starting" } | { readonly kind: "refused"; readonly code: string; readonly reason: string }> {
    const no = (code: string, reason: string) => ({ kind: "refused" as const, code, reason });
    if (!deps.service.isReady()) return no("unavailable", "The Juno escrow isn't reachable right now. Try again in a minute.");
    let fin: FinancialGameRecord | null;
    try {
      fin = await deps.financial.load(record.game_id);
    } catch {
      return no("unavailable", "The table's money record could not be read just now. Try again.");
    }
    if (fin === null) return no("unavailable", "This table's money record is missing; an operator has been alerted.");
    if (fin.phase === "held") return no("held", "This table's money is on hold for review.");
    if (fin.chain.started !== null) return { kind: "deal" };
    if (fin.roster !== null) {
      const again = await deps.service.requestStart(record.game_id, record.seats);
      soon(record.game_id);
      return again.ok ? { kind: "starting" } : no(again.code === "retry" ? "retry" : "wrong-state", START_REFUSALS[again.code] ?? again.detail);
    }
    const bound = fin.binding?.escrow ?? null;
    if (bound === null) return no("escrow-not-open", "The host hasn't opened the table on Juno yet.");
    const seat = seatOf(record, principalId);
    if (seat === null) return no("forbidden", "Only a seated player can start this table.");
    let game: JunoGameResponse;
    let snapshot: Snapshot;
    try {
      game = await readChainGame(bound.chain_game_id);
      snapshot = await deps.tickets.snapshot(record.game_id);
    } catch {
      return no("chain-unavailable", "Juno couldn't be checked just now, so nothing was started. Try again in a moment.");
    }
    const entry = entryOf(record.game_id);
    entry.chain = { observedAt: deps.now(), response: game };
    entry.ledger = snapshot;
    const claims = claimsOf(record, snapshot.grants, game, hints.get(record.game_id));
    const isHost = seat.player_id === record.host_player_id;
    const now = deps.now();
    if (!isHost) {
      if (claims.bySeat.get(seat.player_id)?.funding !== "funded") return no("forbidden", "Only the host -- or, ten minutes after the table is fully funded, any funded player -- can start this table.");
      const fullyFundedAt = fullyFundedAtOf(game.game);
      if (fullyFundedAt === null || now < fullyFundedAt + START_GRACE_MS) {
        return no("host-grace", fullyFundedAt === null ? "The table isn't fully funded on Juno yet." : `The host can start now; any funded player can in ${fromNow(fullyFundedAt + START_GRACE_MS, now)}.`);
      }
    }
    if (game.paused) return no("paused", START_REFUSALS.paused);
    const deadline = secsToMs(game.deadlines.funding_deadline);
    if (deadline !== null && now >= deadline) return no("funding-closed", "Funding on Juno has closed for this table; it can only be refunded now.");
    if (deadline !== null && now >= deadline - START_MARGIN_MS) return no("deadline-near", "It's too close to Juno's funding deadline to start safely; the table can be refunded from the deadline on.");
    if (claims.foreign.length > 0) return no("unknown-deposit", START_REFUSALS["unbound-seat"]);
    if ([...claims.bySeat.values()].some((claim) => claim.funding === "unlinked")) return no("unlinked-deposit", "A seat's deposit isn't linked to it anymore (relink or withdraw it first).");
    if (game.game.state !== "FUNDED" || record.seats.length !== record.exact_players || [...claims.bySeat.values()].some((claim) => claim.funding !== "funded")) {
      return no("need-funding", "Every seat has to be funded on Juno before the game can start.");
    }
    const started = await deps.service.requestStart(record.game_id, record.seats);
    soon(record.game_id);
    if (!started.ok) return no(started.code === "retry" ? "retry" : "not-ready", START_REFUSALS[started.code] ?? `The game could not be started (${started.code}).`);
    audit("money.start-requested", { game_id: record.game_id, by_host: isHost, roster_hash: started.roster_hash });
    return { kind: "starting" };
  }

  /* ---------------- the HTTP actions ---------------- */

  function tableFor(caller: MoneyCaller, gameId: unknown): { readonly record: GameRecord; readonly playerId: string; readonly isHost: boolean } | MoneyAnswer {
    if (typeof gameId !== "string" || gameId.length === 0 || gameId.length > 64) return refusal(400, "bad-request", "That request names no table.");
    const record = recordOf(gameId);
    /* Not a money table, or no such game: the same answer (a private table's existence is never confirmed). */
    if (record === null) return refusal(404, "not-found", "There is no such real-money table.");
    const seat = seatOf(record, caller.principalId);
    if (seat === null) return refusal(403, "not-seated", "You don't have a seat at that table.");
    return { record, playerId: seat.player_id, isHost: seat.player_id === record.host_player_id };
  }

  const isTable = (value: unknown): value is { record: GameRecord; playerId: string; isHost: boolean } => typeof value === "object" && value !== null && "record" in value;

  const serviceReady = (): MoneyAnswer | null => (deps.service.isReady() ? null : refusal(503, "money-unavailable", "The Juno escrow isn't reachable right now. Try again in a minute."));

  async function config_(): Promise<MoneyAnswer> {
    const status = creationStatus();
    const current = status.ok ? await chainConfig() : config;
    return answer({
      enabled: status.ok,
      ...(status.ok ? {} : { why: status.code, reason: status.reason }),
      deployment: { backend: deps.pin.backend, chainId: deps.pin.chain_id, networkClass: deps.pin.network_class, contract: deps.pin.contract_address, codeChecksum: deps.pin.code_checksum, denom: deps.pin.denom, symbol: deps.symbol, exponent: 6 },
      feeBps: current?.feeBps ?? null,
      minAnte: current?.minAnte ?? null,
      fundingPeriodSecs: { live: current?.fundingPeriodLiveSecs ?? null, async: current?.fundingPeriodAsyncSecs ?? null },
    });
  }

  async function walletChallenge(caller: MoneyCaller, body: Record<string, unknown>): Promise<MoneyAnswer> {
    const down = serviceReady();
    if (down !== null) return down;
    if (!caller.sensitive) return refusal(403, "reauth-required", "Confirm it's you first (your recovery key), then link the wallet.");
    const table = tableFor(caller, body.gameId);
    if (!isTable(table)) return table;
    const wallet = canonicalJunoWallet(body.wallet);
    if (wallet === null) return refusal(400, "bad-wallet", "That isn't a Juno wallet address.");
    if (table.record.status !== "waiting" || dealtRecord(table.record)) return refusal(409, "wrong-state", "A wallet is linked before the game starts.");
    /* W2-M (AUD-20.14): before the wallet signs, say which wallet this seat's standing link would replace (the
       standing-link half of the link's `replace-required` test; the link's earlier refusals and its relink of an own
       deposit still decide first), so the browser asks first and the wallet signs once. A hint only:
       the challenge, its single use and the link's own decision are unchanged, and it names nothing the seat's own
       view doesn't already carry. A ledger that can't be read just now leaves it out (the link still decides). */
    let replaces: string | null | undefined;
    try {
      const standing = standingLinkOf((await deps.tickets.snapshot(table.record.game_id)).grants, table.playerId);
      replaces = standing !== null && standing.wallet !== wallet ? standing.wallet : null;
    } catch {
      replaces = undefined;
    }
    const minted = challenges.mint({
      context: { sessionId: caller.sessionId, familyId: caller.familyId, recoverySelector: caller.recoverySelector, principalId: caller.principalId },
      gameId: table.record.game_id,
      playerId: table.playerId,
      wallet,
      site: caller.origin,
      chainId: deps.pin.chain_id,
      contract,
    });
    return answer({ text: minted.text, nonce: minted.nonce, expiresAt: minted.expiresAt, ...(replaces !== undefined ? { replaces } : {}) });
  }

  type LinkDecision = { readonly kind: "issue"; readonly relinkFrom: number | null } | { readonly kind: "unchanged"; readonly grant: Grant } | { readonly kind: "refused"; readonly status: number; readonly code: string; readonly reason: string };

  /** The exact refusal policy of a wallet link (preflight §3.1 D; nothing is ever reassigned automatically). */
  async function linkDecision(record: GameRecord, playerId: string, isHost: boolean, wallet: string, replace: boolean): Promise<LinkDecision> {
    const no = (status: number, code: string, reason: string): LinkDecision => ({ kind: "refused", status, code, reason });
    const fin = await deps.financial.load(record.game_id);
    const snapshot = await deps.tickets.snapshot(record.game_id);
    if (fin === null) return no(409, "wrong-state", "This table's money record is missing.");
    if (fin.phase === "held") return no(409, "held", "This table's money is on hold for review.");
    if (fin.roster !== null || fin.chain.started !== null || snapshot.frozen_at !== null) return no(409, "frozen", "The seats are locked with the escrow; the payout wallet can't change now.");
    const grants = snapshot.grants.filter((grant) => grant.player_id === playerId);
    const newest = newestOf(snapshot.grants, playerId);
    /* An outstanding admission -- on ANY of the seat's grants, not only the newest: a relink writes a newer grant, and
       the older admission still seats its wallet on chain (review S-M1) -- blocks every OTHER wallet (R-J1); relinking
       the admitted wallet itself is decided below from the chain (its deposit, under the admitted ticket, is what a
       relink re-adopts). */
    const admittedGrants = grants.filter((grant) => admissionOutstanding(grant.admitted_until_secs, deps.now()));
    const admitted = admittedGrants.length === 0 ? null : admittedGrants.reduce((best, grant) => (grant.epoch > best.epoch ? grant : best));
    if (admittedGrants.some((grant) => grant.wallet !== wallet)) {
      return no(409, "admission-outstanding", "This seat's join approval for its linked wallet hasn't expired yet. Deposit with that wallet, or wait for the approval to lapse.");
    }
    const hint = hints.get(record.game_id)?.get(playerId);
    if (hint !== undefined && (hint.kind === "create" || hint.kind === "join")) return no(409, "deposit-pending", "A deposit from this seat is on its way to Juno. Wait until Juno answers.");
    if (snapshot.grants.some((grant) => grant.player_id !== playerId && grant.standing && grant.proof !== null && grant.wallet === wallet)) {
      return no(409, "wallet-in-use", "That wallet is already linked to another seat at this table.");
    }
    const bound = fin.binding?.escrow ?? null;
    if (bound !== null) {
      let game: JunoGameResponse;
      try {
        game = await readChainGame(bound.chain_game_id);
      } catch {
        return no(503, "chain-unavailable", "Juno couldn't be checked just now, so the wallet wasn't linked. Try again in a moment.");
      }
      const seats = game.game.seats;
      if (newest !== undefined && newest.standing && seats.some((seat) => seat.wallet === newest.wallet && seat.join_ticket === newest.ticket)) {
        return no(409, "already-funded", "This seat is already funded on Juno with its linked wallet. To use another wallet, withdraw the deposit first.");
      }
      const onChain = seats.find((seat) => seat.wallet === wallet);
      if (onChain !== undefined) {
        const earlier = grants.find((grant) => grant.wallet === wallet && grant.ticket === onChain.join_ticket);
        if (earlier !== undefined) return { kind: "issue", relinkFrom: earlier.epoch };
        return no(409, "wallet-in-use", "That wallet already holds another seat on this table's escrow.");
      }
      if (admitted !== null) return no(409, "admission-outstanding", "This seat's join approval hasn't expired yet. Deposit with the linked wallet, or wait for the approval to lapse.");
      const mine = new Set(grants.map((grant) => grant.wallet));
      const earlierDeposit = seats.find((seat) => mine.has(seat.wallet) && seat.wallet !== wallet);
      if (earlierDeposit !== undefined) return no(409, "withdraw-or-relink-first", `This seat still has a deposit from ${earlierDeposit.wallet} on Juno. Relink that wallet (free), or withdraw its deposit first.`);
    } else if (isHost && newest !== undefined && newest.standing && newest.proof !== null) {
      /* A host's CreateGame needs no admission: before a new ticket orphans it, look for it once more. */
      const entry = entryOf(record.game_id);
      entry.ledger = snapshot;
      try {
        if (await discover(entry, record)) return no(409, "already-funded", "Your table is already open on Juno with the linked wallet.");
      } catch {
        return no(503, "chain-unavailable", "Juno couldn't be checked just now, so the wallet wasn't linked. Try again in a moment.");
      }
    }
    if (admitted !== null) return no(409, "admission-outstanding", "This seat's join approval hasn't expired yet.");
    if (newest !== undefined && newest.standing && newest.proof !== null) {
      if (newest.wallet === wallet) return { kind: "unchanged", grant: newest };
      if (!replace) return no(409, "replace-required", `This seat is linked to ${newest.wallet}. Replace it with this wallet?`);
    }
    return { kind: "issue", relinkFrom: null };
  }

  /** LIVE-4 (L4-4): a route that writes a game's ticket ledger first asks whether this server continues the game at all
   *  (its money identity, its artifacts, the escrow it is bound to served here): if not, nothing is written. */
  async function notServedHere(record: GameRecord): Promise<MoneyAnswer | null> {
    const decision = await deps.service.servingDecision(record.game_id, { where: "money route", ownerKey: moneyTermsKey(record.money) }).catch(() => null);
    if (decision !== null && decision.verdict.kind === "continues") return null;
    return refusal(409, "not-served-here", "This table's escrow isn't served by this server right now, so nothing was changed. Try again later.");
  }

  async function walletLink(caller: MoneyCaller, body: Record<string, unknown>): Promise<MoneyAnswer> {
    const down = serviceReady();
    if (down !== null) return down;
    if (!caller.sensitive) return refusal(403, "reauth-required", "Confirm it's you first (your recovery key), then link the wallet.");
    const table = tableFor(caller, body.gameId);
    if (!isTable(table)) return table;
    const elsewhere = await notServedHere(table.record);
    if (elsewhere !== null) return elsewhere;
    const context = { sessionId: caller.sessionId, familyId: caller.familyId, recoverySelector: caller.recoverySelector, principalId: caller.principalId };
    const signature = typeof body.signature === "string" ? body.signature : "";
    const taken = challenges.take(body.nonce, context, table.record.game_id);
    if (taken.kind === "unknown") return refusal(409, "challenge-expired", "That link request has expired or belongs to another session. Start the link again.");
    if (taken.kind === "spent") return taken.signature === signature ? (taken.result as MoneyAnswer) : refusal(409, "challenge-used", "That link request was already used. Start the link again.");
    const entry = taken.entry;
    const nonce = entry.nonce;
    /* The nonce is spent with its answer -- unless the answer is "try again" (the chain or the table busy for a moment):
       then the same signed challenge may be sent again, and a lost answer is not replayed as that failure (S-L4). */
    const finish = (result: MoneyAnswer): MoneyAnswer => {
      if (result.ok || result.status !== 503) challenges.spend(nonce, signature, result);
      return result;
    };
    if (entry.playerId !== table.playerId) return finish(refusal(409, "seat-changed", "Your seat at this table changed. Start the link again."));
    const verdict = verifyAdr036({ wallet: entry.wallet, text: entry.text, pubKeyBase64: typeof body.pubKey === "string" ? body.pubKey : "", signatureBase64: signature, now: deps.now() });
    if (!verdict.ok) {
      audit("money.wallet-proof-refused", { game_id: table.record.game_id, why: verdict.why });
      return finish(refusal(403, "invalid-proof", verdict.why === "wrong-wallet" ? "The signature came from another wallet than the one you're linking." : "The wallet's signature didn't check out. Nothing was linked."));
    }
    const consentKey = typeof body.consentKey === "string" ? body.consentKey : "";
    if (!CONSENT_KEY.test(consentKey)) return finish(refusal(400, "bad-consent-key", "The signing key this browser made isn't a valid key."));
    const proof: WalletLinkProof = verdict.proof;
    const replace = body.replace === true;
    const current = await chainConfig();
    const ran = await room.runTask(table.record.game_id, async (record): Promise<MoneyAnswer> => {
      const seat = seatOf(record, caller.principalId);
      if (record.money === null || seat === null || seat.player_id !== table.playerId) return refusal(409, "seat-changed", "Your seat at this table changed. Start the link again.");
      if (record.status !== "waiting" || dealtRecord(record)) return refusal(409, "wrong-state", "A wallet is linked before the game starts.");
      const decision = await linkDecision(record, seat.player_id, seat.player_id === record.host_player_id, entry.wallet, replace);
      if (decision.kind === "refused") return refusal(decision.status, decision.code, decision.reason);
      if (decision.kind === "unchanged") {
        const grant = decision.grant;
        const sameContext = grant.issued_under.family_id === caller.familyId && grant.issued_under.recovery_selector === caller.recoverySelector;
        if (sameContext || grant.issued_under.principal_id !== caller.principalId) {
          /* The same wallet again, from the SAME security context: its fresh proof replaces the old one (a proof ages
             out for the join admission), and this browser's key is registered. The ticket and epoch stay (review S-M3).
             (Another principal's grant cannot stand on this principal's seat; `renewProof` refuses it as ever.) */
          const renewed = await deps.tickets.renewProof({ gameId: record.game_id, playerId: seat.player_id, principalId: caller.principalId, proof, consentKey });
          if (renewed !== "committed") return refusal(409, "conflict", "The link changed meanwhile. Try again.");
          return answer({ mode: "unchanged", wallet: grant.wallet, epoch: grant.epoch, ticket: grant.ticket });
        }
        /* JX-3B (owner ruling OD-JX3-1): the same wallet, proven again by the same principal from ANOTHER standing
           security context (a second device, or a recovered one). Before the freeze the grant RE-HOMES to the proving
           context: a new epoch re-adopting the same ticket (the RELINKED mechanism, stricter: `issue({ rehome })`),
           so signing out the earlier device no longer ends the link and signing out this one does. Every refusal
           `linkDecision` applies (held, frozen, admission outstanding, deposit pending, already funded, the host's
           CreateGame found) has already been passed to reach "unchanged"; the ledger re-checks freeze, admissions and
           standing inside its own CAS. The player sees "unchanged" (same wallet, same ticket) with the new epoch. */
        const rehomed = await deps.tickets.issue({
          binding: { backend: deps.pin.backend, chain_id: deps.pin.chain_id, deployment_id: contract },
          gameId: record.game_id,
          playerId: seat.player_id,
          wallet: entry.wallet,
          context: { principalId: caller.principalId, familyId: caller.familyId, recoverySelector: caller.recoverySelector },
          reauthorized: caller.sensitive,
          proof,
          consentKey,
          relinkFrom: grant.epoch,
          rehome: true,
        });
        if (!rehomed.ok) {
          const [status, reason] = LINK_REFUSALS[rehomed.refusal] ?? [409, "The wallet wasn't linked."];
          return refusal(status, rehomed.refusal === "relink-mismatch" ? "conflict" : rehomed.refusal, rehomed.refusal === "relink-mismatch" ? LINK_REFUSALS.conflict[1] : reason);
        }
        audit("money.wallet-linked", { game_id: record.game_id, epoch: rehomed.epoch, relink: false, rehome: true, from_epoch: grant.epoch });
        return answer({ mode: "unchanged", wallet: entry.wallet, epoch: rehomed.epoch, ticket: rehomed.ticket, rehomed: true });
      }
      const issued = await deps.tickets.issue({
        binding: { backend: deps.pin.backend, chain_id: deps.pin.chain_id, deployment_id: contract },
        gameId: record.game_id,
        playerId: seat.player_id,
        wallet: entry.wallet,
        context: { principalId: caller.principalId, familyId: caller.familyId, recoverySelector: caller.recoverySelector },
        reauthorized: caller.sensitive,
        proof,
        consentKey,
        relinkFrom: decision.relinkFrom,
        createFloor: current?.nextChainGameId ?? null,
      });
      if (!issued.ok) {
        const [status, reason] = LINK_REFUSALS[issued.refusal] ?? [409, "The wallet wasn't linked."];
        return refusal(status, issued.refusal, reason);
      }
      audit("money.wallet-linked", { game_id: record.game_id, epoch: issued.epoch, relink: decision.relinkFrom !== null });
      return answer({ mode: decision.relinkFrom === null ? "issued" : "relinked", wallet: entry.wallet, epoch: issued.epoch, ticket: issued.ticket });
    });
    soon(table.record.game_id);
    return finish(ran.ok ? ran.value : refusal(ran.code === "not-found" ? 404 : 503, ran.code, ran.reason));
  }

  async function joinAdmission(caller: MoneyCaller, body: Record<string, unknown>): Promise<MoneyAnswer> {
    const down = serviceReady();
    if (down !== null) return down;
    const table = tableFor(caller, body.gameId);
    if (!isTable(table)) return table;
    if (table.isHost) return refusal(409, "host-creates", "As the host you open the table on Juno with your own deposit; no join approval is needed.");
    const ran = await room.runTask(table.record.game_id, async (record): Promise<MoneyAnswer> => {
      const seat = seatOf(record, caller.principalId);
      if (seat === null || record.money === null) return refusal(403, "not-seated", "You don't have a seat at that table.");
      if (record.status !== "waiting" || dealtRecord(record)) return refusal(409, "wrong-state", "Deposits are made before the game starts.");
      /* Each admission keeps the seat unremovable for its lifetime (R-J1): a seat that never deposits must not hold its
         place forever by asking again and again (review S-M2). */
      const budgetKey = `${record.game_id}\u0000${seat.player_id}`;
      if ((admissionsAsked.get(budgetKey) ?? 0) >= MAX_ADMISSIONS_PER_SEAT) {
        return refusal(409, "too-many-admissions", "This seat has used up its join approvals at this table (each one reserves the seat for a while). Ask the host to seat you again, or leave the seat and take it again once the last approval has lapsed.");
      }
      const snapshot = await deps.tickets.snapshot(record.game_id);
      const link = standingLinkOf(snapshot.grants, seat.player_id);
      if (link === null) return refusal(409, "link-first", "Link your wallet to this seat first.");
      const admitted = await deps.service.authorizeJoin({ gameId: record.game_id, playerId: seat.player_id, principalId: caller.principalId, wallet: link.wallet, joinTicket: link.ticket });
      if (admitted.ok) {
        admissionsAsked.set(budgetKey, (admissionsAsked.get(budgetKey) ?? 0) + 1);
        if (admissionsAsked.size > 10_000) admissionsAsked.delete(admissionsAsked.keys().next().value as string);
      }
      if (!admitted.ok) {
        const map: Record<string, [number, string, string]> = {
          "not-bound": [409, "escrow-not-open", "The host hasn't opened the table on Juno yet."],
          "wallet-unproven": [409, "link-first", "Link your wallet to this seat again (the proof is missing or too old)."],
          "no-standing-ticket": [409, "link-first", "Link your wallet to this seat again."],
          "not-seat-owner": [403, "not-seated", "This seat's link was made by another account."],
          "ticket-mismatch": [409, "link-first", "Link your wallet to this seat again."],
          "wallet-conflict": [409, "wallet-in-use", "That wallet is linked to another seat."],
          frozen: [409, "frozen", "The seats are locked with the escrow."],
          "wrong-state": [409, "wrong-state", "The escrow isn't taking deposits now."],
          paused: [409, "paused", "Deposits are paused on Juno right now. Try again later."],
          "funding-closed": [409, "funding-closed", "Funding for this table has closed on Juno."],
          "already-seated": [409, "already-funded", "Your wallet already holds a seat on this table's escrow."],
          "admission-unavailable": [503, "admission-unavailable", "The server can't approve deposits right now. Try again later."],
          "not-verified": [503, "money-unavailable", "The Juno escrow isn't reachable right now."],
          conflict: [409, "conflict", "The seat changed meanwhile. Try again."],
        };
        const [status, code, reason] = map[admitted.code] ?? [409, admitted.code, "The deposit wasn't approved."];
        return refusal(status, code, reason);
      }
      return answer({ admission: admitted.admission });
    });
    soon(table.record.game_id);
    return ran.ok ? ran.value : refusal(ran.code === "not-found" ? 404 : 503, ran.code, ran.reason);
  }

  async function depositSent(caller: MoneyCaller, body: Record<string, unknown>): Promise<MoneyAnswer> {
    const table = tableFor(caller, body.gameId);
    if (!isTable(table)) return table;
    const kind = body.kind as MoneyHintKind;
    if (!HINT_KINDS.includes(kind)) return refusal(400, "bad-request", "That is not a kind of deposit transaction.");
    /* Only the host opens the escrow; only a joiner joins it (review S-M2: a hint is the browser's word, and says only
       what that seat could have sent). */
    if ((kind === "create" && !table.isHost) || (kind === "join" && table.isHost)) return refusal(400, "bad-request", "This seat doesn't send that kind of deposit.");
    const txHash = typeof body.txHash === "string" && /^[0-9A-Fa-f]{64}$/.test(body.txHash) ? body.txHash.toUpperCase() : null;
    if (txHash === null) return refusal(400, "bad-request", "That is not a transaction hash.");
    const chainGameId = typeof body.chainGameId === "string" && /^[1-9][0-9]{0,19}$/.test(body.chainGameId) ? body.chainGameId : null;
    const timeoutHeight = typeof body.timeoutHeight === "string" && /^[1-9][0-9]{0,19}$/.test(body.timeoutHeight) ? body.timeoutHeight : null;
    /* A HINT: it says where to look, sooner. Funding is only ever what the chain shows. The same transaction hinted
       again keeps its first time (a re-send never extends how long it is believed: review R-M8). */
    /* A seat's DEPOSIT hint (what its funding and locks read) is kept apart from its other transactions' hints, so a
       withdrawal or a cancel never replaces a deposit still on its way (verification pass). */
    const map = hintsOf(table.record.game_id);
    const key = kind === "create" || kind === "join" ? table.playerId : `${table.playerId}\u0000${kind}`;
    const existing = map.get(key);
    if (existing !== undefined && existing.txHash === txHash) {
      map.set(key, { ...existing, chainGameId: existing.chainGameId ?? chainGameId, timeoutHeight: existing.timeoutHeight ?? timeoutHeight });
    } else {
      map.set(key, { playerId: table.playerId, kind, txHash, chainGameId, at: deps.now(), timeoutHeight, landed: false });
    }
    soon(table.record.game_id);
    return answer({ accepted: true }, 202);
  }

  async function consentKey(caller: MoneyCaller, body: Record<string, unknown>): Promise<MoneyAnswer> {
    if (!caller.sensitive) return refusal(403, "reauth-required", "Confirm it's you first (your recovery key) to set up signing on this device.");
    const table = tableFor(caller, body.gameId);
    if (!isTable(table)) return table;
    const pubkey = typeof body.pubkey === "string" ? body.pubkey : "";
    if (!CONSENT_KEY.test(pubkey)) return refusal(400, "bad-consent-key", "That isn't a valid signing key.");
    const elsewhere = await notServedHere(table.record);
    if (elsewhere !== null) return elsewhere;
    const registered = await deps.tickets.registerConsentKey({ gameId: table.record.game_id, playerId: table.playerId, principalId: caller.principalId, pubkey });
    if (registered === "refused") return refusal(409, "link-first", "This seat has no standing wallet link made by your account. Link (or relink) the wallet first.");
    /* LIVE-5 L5-2 (F-L5-6): an UNCERTAIN ledger write is never reported as registered -- the next attempt re-reads. */
    if (registered !== "committed") return refusal(409, "conflict", "The seat's link changed meanwhile. Try again.");
    audit("money.consent-key-registered", { game_id: table.record.game_id });
    soon(table.record.game_id);
    return answer({ registered: true });
  }

  /** The keys a seat's owner registered (every epoch of the seat), and its chain seat in the frozen roster. */
  async function relayTarget(caller: MoneyCaller, gameId: string, playerId: string): Promise<{ readonly index: number; readonly keys: readonly string[] } | MoneyAnswer> {
    const fin = await deps.financial.load(gameId);
    const seat = fin?.roster?.roster.find((entry) => entry.player_id === playerId);
    if (fin === null || seat === undefined) return refusal(409, "wrong-state", "This table's escrow hasn't started, so there is nothing to sign yet.");
    const snapshot = await deps.tickets.snapshot(gameId);
    const keys = snapshot.grants.filter((grant) => grant.player_id === playerId && grant.issued_under.principal_id === caller.principalId).flatMap((grant) => grant.consent_keys);
    return { index: seat.chain_seat_index, keys: [...new Set(keys)] };
  }

  const RELAY_REFUSALS: Readonly<Record<string, [number, string]>> = Object.freeze({
    "not-bound": [409, "This table's escrow hasn't started."],
    "not-settleable": [409, "There is no recorded payout on Juno to approve right now."],
    "not-ours": [409, "The payout recorded on Juno isn't this server's; it won't be approved through it."],
    "no-seat": [409, "Your seat isn't on this table's escrow."],
    "key-not-registered": [409, "Your seat's signing key on Juno wasn't set up from your account. Use this device for signing first."],
    "wrong-key": [409, "That approval wasn't signed by your seat's current signing key (it may have moved to another device)."],
    "request-invalid": [400, "That signature isn't well formed."],
    held: [409, "This table's money is on hold for review."],
    "wrong-state": [409, "The escrow isn't in a state that can be annulled."],
    "not-verified": [503, "The Juno escrow isn't reachable right now."],
    store: [503, "The server couldn't record that right now. Try again."],
  });

  async function consent(caller: MoneyCaller, body: Record<string, unknown>): Promise<MoneyAnswer> {
    const table = tableFor(caller, body.gameId);
    if (!isTable(table)) return table;
    const target = await relayTarget(caller, table.record.game_id, table.playerId);
    if (!("index" in target)) return target;
    const relayed = await deps.service.relayConsent({ gameId: table.record.game_id, chainSeatIndex: target.index, signature: typeof body.signature === "string" ? body.signature : "", registeredKeys: target.keys });
    soon(table.record.game_id);
    if (!relayed.ok) {
      const [status, reason] = RELAY_REFUSALS[relayed.code] ?? [409, "The approval wasn't relayed."];
      return refusal(status, relayed.code, reason);
    }
    return answer({ status: relayed.status });
  }

  async function annul(caller: MoneyCaller, body: Record<string, unknown>): Promise<MoneyAnswer> {
    const table = tableFor(caller, body.gameId);
    if (!isTable(table)) return table;
    const target = await relayTarget(caller, table.record.game_id, table.playerId);
    if (!("index" in target)) return target;
    const submitted = await deps.service.submitAnnul({ gameId: table.record.game_id, chainSeatIndex: target.index, signature: typeof body.signature === "string" ? body.signature : "", registeredKeys: target.keys });
    soon(table.record.game_id);
    if (!submitted.ok) {
      const [status, reason] = RELAY_REFUSALS[submitted.code] ?? [409, "The signature wasn't accepted."];
      return refusal(status, submitted.code, reason);
    }
    return answer({ trustedSeq: submitted.trusted_seq, collected: submitted.collected, needed: submitted.needed, submitted: submitted.submitted });
  }

  async function escrowDetails(caller: MoneyCaller, body: Record<string, unknown>): Promise<MoneyAnswer> {
    const table = tableFor(caller, body.gameId);
    if (!isTable(table)) return table;
    const details = await deps.service.escrowDetails(table.record.game_id);
    const entry = cache.get(table.record.game_id);
    const response = entry?.chain?.response ?? null;
    /* The frozen roster (player -> chain seat), for a seated player's device to lay its own count of the final standings
       out in chain order and check the recorded payout (review S-H1). Chain seats are public on Juno; this names which
       of the table's players holds each, to the table's own players only. */
    const fin = await deps.financial.load(table.record.game_id).catch(() => null);
    const roster = fin?.roster?.roster.map((seat) => ({ playerId: seat.player_id, chainSeatIndex: seat.chain_seat_index })) ?? null;
    return answer({
      roster,
      checkpoint: details.checkpoint,
      settlement: details.settlement,
      chain:
        response === null
          ? null
          : {
              state: response.game.state,
              domain: response.game.domain,
              trustedSeq: response.trusted_seq,
              latestCheckpointSeq: response.latest_checkpoint?.payload.seq ?? null,
              livenessAvailableAt: secsToMs(response.deadlines.liveness_available_at),
              challengeWindowEnd: secsToMs(response.deadlines.challenge_window_end),
              resolverTimeoutAt: secsToMs(response.deadlines.resolver_timeout_at),
              bond: response.game.bond,
              observedAt: entry?.chain?.observedAt ?? null,
            },
    });
  }

  /** "Your deposits": every escrow seat this principal's wallets hold for a table it linked at -- however the table is
   *  now (gone from the lobby, expired, cancelled, its host gone), plus a host's duplicate escrows (A-4). Money that is
   *  no longer in an escrow (paid out, refunded, annulled) is not listed. The newest tables first, at most
   *  `DEPOSITS_MAX_GAMES` of them that may still hold money; an answer is reused for a few seconds (each one reads Juno). */
  const depositAnswers = new Map<string, { readonly at: number; readonly answer: Promise<MoneyAnswer> }>();
  async function deposits(caller: MoneyCaller): Promise<MoneyAnswer> {
    const down = serviceReady();
    if (down !== null) return down;
    const cached = depositAnswers.get(caller.principalId);
    if (cached !== undefined && deps.now() - cached.at < DEPOSITS_REUSE_MS) return cached.answer;
    const answer_ = depositsNow(caller);
    depositAnswers.set(caller.principalId, { at: deps.now(), answer: answer_ });
    for (const [key, value] of depositAnswers) if (deps.now() - value.at >= DEPOSITS_REUSE_MS) depositAnswers.delete(key);
    return answer_;
  }

  async function depositsNow(caller: MoneyCaller): Promise<MoneyAnswer> {
    const out: MoneyDepositEntry[] = [];
    const now = deps.now();
    /* The principal's games, newest link first; a game whose money is known to be settled is skipped (unless this was
       its host: a duplicate escrow of the host's may still hold a deposit). */
    const candidates: Array<{ readonly gameId: string; readonly snapshot: Snapshot; readonly newest: number }> = [];
    for (const gameId of (await deps.tickets.gamesIssuedTo(caller.principalId)).slice(0, DEPOSITS_MAX_LEDGERS)) {
      const snapshot = await deps.tickets.snapshot(gameId).catch(() => null);
      if (snapshot === null) continue;
      const mine = snapshot.grants.filter((grant) => grant.issued_under.principal_id === caller.principalId);
      if (mine.length === 0) continue;
      candidates.push({ gameId, snapshot, newest: Math.max(...mine.map((grant) => grant.issued_at)) });
    }
    candidates.sort((a, b) => b.newest - a.newest);
    let read = 0;
    for (const { gameId, snapshot } of candidates) {
      if (read >= DEPOSITS_MAX_GAMES) break;
      const mine = snapshot.grants.filter((grant) => grant.issued_under.principal_id === caller.principalId);
      const fin = await deps.financial.load(gameId).catch(() => null);
      const record = room.recordOf(gameId);
      const playerId = mine[0].player_id;
      const hostSeat = record !== null && record.host_player_id === playerId;
      if (fin?.phase === "closed" && !hostSeat) continue;
      read += 1;
      const terms = record?.money ?? null;
      const deployment: MoneyDeploymentView =
        terms !== null ? deploymentViewOf(terms) : { backend: "juno-cosmwasm", chainId: deps.pin.chain_id, networkClass: deps.pin.network_class, contract, codeChecksum: deps.pin.code_checksum, denom: deps.pin.denom, symbol: deps.symbol, exponent: 6 };
      const tableOpen = record !== null && record.archived_at === null && record.status !== "cancelled" && record.status !== "expired";
      const wallets = new Set(mine.map((grant) => grant.wallet));
      const describe = (chainGameId: string, game: JunoGameResponse, relationOf: (wallet: string, ticket: string) => MoneyDepositEntry["relation"] | null) => {
        const g = game.game;
        /* Money still in this escrow: before the Start (refundable), or while the game runs or settles. */
        if (g.state !== "FUNDING" && g.state !== "FUNDED" && g.state !== "IN_PROGRESS" && g.state !== "SETTLEABLE" && g.state !== "DISPUTED") return;
        const deadline = secsToMs(game.deadlines.funding_deadline);
        for (const seat of g.seats) {
          if (!wallets.has(seat.wallet)) continue;
          const relation = relationOf(seat.wallet, seat.join_ticket);
          if (relation === null) continue;
          const preStart = g.state === "FUNDING" || g.state === "FUNDED";
          const creator = g.creator === seat.wallet;
          const actions: MoneyDepositEntry["actions"] = [];
          if (preStart) {
            /* The creator leaves by Cancel (every deposit comes back); anyone else by Withdraw (review R-H1). */
            if (creator) actions.push("cancel-escrow");
            else {
              actions.push("withdraw");
              if (deadline !== null && now >= deadline) actions.push("refund-after-deadline");
            }
            if (relation === "unlinked" && tableOpen && fin?.roster == null) actions.push("relink");
          }
          if (tableOpen) actions.push("open-table");
          out.push({ gameId, tableOpen, deployment, chainGameId, wallet: seat.wallet, grossDeposit: seat.gross_deposit, netDeposit: seat.net_deposit, chainState: g.state, fundingDeadline: deadline, relation, creator, actions });
        }
      };
      const bound = fin?.binding?.escrow ?? null;
      if (bound !== null && fin?.phase !== "closed") {
        try {
          const game = parseGameResponse(await deps.rest.smart(contract, QUERY.game(bound.chain_game_id)));
          const newest = newestOf(snapshot.grants, playerId);
          describe(bound.chain_game_id, game, (wallet, ticket) => {
            const grant = mine.filter((entry) => entry.wallet === wallet && entry.ticket === ticket).reduce<Grant | undefined>((best, entry) => (best === undefined || entry.epoch > best.epoch ? entry : best), undefined);
            if (grant === undefined) return null;
            return fin?.roster != null || (newest !== undefined && newest.epoch === grant.epoch && grant.standing) ? "bound" : "unlinked";
          });
        } catch {
          /* unreadable now: the table's own view says so */
        }
      }
      if (hostSeat) {
        /* A-4: other escrows this host's wallets opened for this table (a duplicate CreateGame, or one opened under an
           earlier ticket), found from the tickets' floor. */
        const tickets = new Set(mine.map((grant) => grant.ticket));
        const floors = mine.map((grant) => grant.create_floor).filter((floor): floor is string => floor !== null);
        const lowest = floors.length === 0 ? null : floors.reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
        let cursor: string | null = lowest === null || lowest === "0" ? null : (BigInt(lowest) - BigInt(1)).toString();
        try {
          for (let page = 0; page < SCAN_PAGES; page += 1) {
            const games = parseGamesResponse(await deps.rest.smart(contract, QUERY.games(cursor, 30)));
            for (const summary of games) {
              if (!wallets.has(summary.creator) || summary.chain_game_id === bound?.chain_game_id || (summary.state !== "FUNDING" && summary.state !== "FUNDED")) continue;
              const game = parseGameResponse(await deps.rest.smart(contract, QUERY.game(summary.chain_game_id)));
              if (!tickets.has(game.game.seats[0]?.join_ticket ?? "")) continue;
              describe(summary.chain_game_id, game, (wallet) => (wallet === game.game.creator ? "duplicate" : null));
            }
            if (games.length > 0) cursor = games[games.length - 1].chain_game_id;
            if (games.length < 30) break;
          }
        } catch {
          /* the scan is best effort; the bound escrow above is the table's */
        }
      }
    }
    return answer({ deposits: out });
  }

  /* ---------------- lifecycle ---------------- */

  deps.service.onChange((gameId) => {
    if (recordOf(gameId) !== null) soon(gameId);
  });

  return {
    creationStatus,
    /** A create's money terms, checked against this deployment (never a caller's claim about the deployment). */
    async prepareCreate(input: { readonly stake: unknown; readonly exactPlayers: unknown; readonly variants: GameVariants }): Promise<{ readonly ok: true; readonly terms: GameMoneyTerms } | { readonly ok: false; readonly code: string; readonly reason: string }> {
      const status = creationStatus();
      if (!status.ok) return { ok: false, code: status.code, reason: status.reason };
      if (typeof input.stake !== "string" || !/^[1-9][0-9]{0,29}$/.test(input.stake)) return { ok: false, code: "bad-stake", reason: "The stake must be a whole number of the token's base units, above zero." };
      const current = await chainConfig();
      if (current === null) return { ok: false, code: "money-games-disabled", reason: "Juno's escrow can't be read right now. Try again in a minute." };
      if (current.minAnte !== null && BigInt(input.stake) < BigInt(current.minAnte)) return { ok: false, code: "bad-stake", reason: `The smallest stake Juno's escrow accepts is ${current.minAnte} base units.` };
      if (current.paused) return { ok: false, code: "money-games-disabled", reason: "Juno's escrow is paused right now; new tables can't open on it." };
      const exact = input.exactPlayers;
      if (typeof exact !== "number" || !Number.isInteger(exact) || exact < MIN_PLAYERS || exact > MAX_PLAYERS) return { ok: false, code: "exact-players-required", reason: "A real-money table needs an exact number of players (2 to 6)." };
      /* The escrow's pace (its funding period and challenge window) is the table's own pace: one choice, never two. */
      const pace: "live" | "async" = input.variants.mode === "async" ? "async" : "live";
      try {
        variantsDigestV1(input.variants);
      } catch {
        return { ok: false, code: "bad-frame", reason: "These variants can't be committed to an escrow." };
      }
      return {
        ok: true,
        terms: {
          format: MONEY_TABLE_FORMAT,
          backend: "juno-cosmwasm",
          chain_id: deps.pin.chain_id,
          network_class: deps.pin.network_class,
          contract_address: contract,
          code_checksum: deps.pin.code_checksum,
          denom: deps.pin.denom,
          symbol: deps.symbol,
          exponent: 6,
          ante_gross: input.stake,
          mode: pace,
        },
      };
    },
    /** The financial record, BEFORE the GameRecord (no money table exists without one). */
    async openFinancial(gameId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason: string }> {
      const created = await deps.service.createMoneyGame(gameId);
      if (!created.ok) return { ok: false, code: "unavailable", reason: "The table's money record could not be written. Try again." };
      return { ok: true };
    },
    viewFor,
    stakeFor,
    myTableFor,
    /** Before a table's first view is sent: observe it if the cache is cold (bounded wait). */
    async prepareView(gameId: string): Promise<void> {
      const entry = cache.get(gameId);
      if (entry !== undefined && deps.now() - entry.observedAt < 30_000) return;
      await Promise.race([refresh(gameId), new Promise((resolve) => setTimeout(resolve, 2_000).unref?.())]);
    },
    seatOpRefusal,
    startInTask,
    refresh,
    /** A security event ended credentials of `principalId`: every money table it sits at is re-projected at once (W-8). */
    onSecurityEvent(principalId: string): void {
      for (const record of room.moneyRecords()) if (seatOf(record, principalId) !== null) soon(record.game_id);
    },
    routes: {
      config: (_caller: MoneyCaller) => config_(),
      "wallet-challenge": walletChallenge,
      "wallet-link": walletLink,
      "join-admission": joinAdmission,
      "deposit-sent": depositSent,
      "consent-key": consentKey,
      consent,
      annul,
      "escrow-details": escrowDetails,
      deposits: (caller: MoneyCaller) => deposits(caller),
    } as Record<string, (caller: MoneyCaller, body: Record<string, unknown>) => Promise<MoneyAnswer>>,
    start(): void {
      if (deps.manualObserver === true || timer !== null) return;
      timer = setInterval(tick, 5_000);
      timer.unref?.();
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    /** Tests: one observer tick, and waiting for every refresh in flight. */
    tick,
    async idle(): Promise<void> {
      for (;;) {
        const pending = [...cache.values()].map((entry) => entry.refreshing).filter((run): run is Promise<void> => run !== null);
        if (pending.length === 0) return;
        await Promise.all(pending);
      }
    },
    hintsOf: (gameId: string) => [...(hints.get(gameId)?.values() ?? [])],
    challenges,
  };
}

export type MoneyTables = ReturnType<typeof createMoneyTables>;
