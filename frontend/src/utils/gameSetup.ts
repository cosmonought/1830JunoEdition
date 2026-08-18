// frontend/src/utils/gameSetup.ts
//
// What a player count decides: starting cash, and the certificate limit.
//
// ===================================================================
//  DESIGN NOTE 526: THE THIRD COPY THAT DID NOT GET WRITTEN
// ===================================================================
//
// 1830 sets two numbers from the size of the table, and this codebase
// already held each of them twice:
//
//   `RulesReference.tsx`  `CERT_LIMIT_BY_PLAYERS`, `STARTING_CASH_BY_PLAYERS`
//   `utils/gameState.ts`  `CERT_LIMIT_BY_PLAYER_COUNT`
//
// The second is a hand-kept mirror and says so in its own doc comment --
// "Mirrors `RulesReference.tsx`'s `CERT_LIMIT_BY_PLAYERS`". That is a
// correctness requirement enforced by a sentence, which is precisely the
// arrangement TD-1 catalogued for the corporation palette and design note
// #507 for the ownership column: two places encoding one fact, one of them
// updated.
//
// Multiplayer initialisation needs both tables, so the choice was a third
// copy or a single home. This is the single home. `gameState.ts` delegates
// and `RulesReference` renders from here, so the rules screen, the
// certificate counter and the game that gets dealt cannot disagree about
// what a five-player game is.
//
// ===================================================================
//  DESIGN NOTE 526a: WHY THE LIMITS ARE APPLIED, NOT JUST REPORTED
// ===================================================================
//
// `certificateLimit` has always been a READOUT -- it tells the ledger what
// ceiling to print. Nothing dealt a game, because the sandbox opened from a
// fixture with a fixed roster.
//
// A room with a variable number of humans cannot do that: four players who
// sat down expecting $600 each must actually hold $600, and the bank must
// hold what it has left. So `initialiseSandboxGame` below WRITES the
// numbers, and it is deliberately a pure function of `(state, players)` --
// every client runs it on the same setup action and must arrive at
// byte-identical state, which is only guaranteed if nothing in it reads a
// clock, a random source or anything local.
//
// THE TURN ORDER IS RANDOMISED BY THE HOST, NOT HERE, and that is the same
// argument from the other side: a shuffle inside this function would give
// every client a different order from the same input. The host rolls once,
// puts the result in the payload, and this function honours it.

import type { GameplayExecuteMsg } from "./sessionKey";
/* TYPE-ONLY, and deliberately: `gameState.ts` imports `certLimitForPlayers`
   from here, so a value import would be a real cycle. A type import is
   erased at compile time, so this direction costs nothing at runtime and
   keeps `withEmptyRoster` exact about the shape it returns -- a structural
   generic was the first attempt and it widened the corporation and private
   arrays to `Record<string, unknown>`, which no caller could then use. */
import type { GameStateResponse, WaterfallStateResponse } from "./gameState";

/** The printed 1830 tables. Sourced from the physical rulebook's own setup
 *  chart; `RulesReference.tsx`'s Core Limits section renders these. */
export const CERT_LIMIT_BY_PLAYER_COUNT: Readonly<Record<number, number>> = {
  2: 28,
  3: 20,
  4: 16,
  5: 13,
  6: 11,
};

export const STARTING_CASH_BY_PLAYER_COUNT: Readonly<Record<number, number>> = {
  2: 1200,
  3: 800,
  4: 600,
  5: 480,
  6: 400,
};

/** 1830's bank is a fixed $12,000 however many are playing -- the player
 *  count changes what is dealt OUT of it, not its size. */
export const BANK_START = 12000;

/** The player counts the printed tables cover. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/** `null` for a count the printed table does not cover, so a caller renders
 *  "--" rather than inventing a ceiling. */
export function certLimitForPlayers(count: number): number | null {
  return CERT_LIMIT_BY_PLAYER_COUNT[count] ?? null;
}

/** `null` off the table, for the same reason. A game that cannot be dealt
 *  correctly must not be dealt approximately. */
export function startingCashForPlayers(count: number): number | null {
  return STARTING_CASH_BY_PLAYER_COUNT[count] ?? null;
}

/** Whether this many people can legally start an 1830 game. */
export function isLegalPlayerCount(count: number): boolean {
  return Number.isInteger(count) && count >= MIN_PLAYERS && count <= MAX_PLAYERS;
}

/** One seat at the table, as the waiting room agreed it. */
export interface SetupPlayer {
  /** Stable per browser session -- the log's actor stamp. */
  id: string;
  nickname: string;
}

/** What the host publishes when it starts the game.
 *
 *  `players` IS ALREADY IN TURN ORDER. See design note #526a: the shuffle
 *  happens once, on the host, and travels in the payload -- so every client
 *  deals the same table rather than each shuffling the same list
 *  differently. */
export interface SandboxSetup {
  players: readonly SetupPlayer[];
}

export interface DealtGame {
  /** Addresses in turn order -- what `player_addresses` becomes. */
  playerAddresses: string[];
  /** `player_cash` rows, every player on the same starting figure. */
  playerCash: Array<{ player: string; cash_vgp: string }>;
  /** What the bank has left after dealing. */
  bankRemaining: number;
  /** The room's certificate ceiling. */
  certLimit: number;
  startingCash: number;
}

/** Deals a game for exactly these players, or `null` when the count is one
 *  1830 does not define.
 *
 *  PURE, and the purity is load-bearing rather than stylistic: every client
 *  runs this on the same setup action and the results must be identical, so
 *  it reads no clock, no random source and nothing local. */
export function dealSandboxGame(setup: SandboxSetup): DealtGame | null {
  const count = setup.players.length;
  if (!isLegalPlayerCount(count)) return null;
  const startingCash = startingCashForPlayers(count);
  const certLimit = certLimitForPlayers(count);
  if (startingCash === null || certLimit === null) return null;

  const playerAddresses = setup.players.map((player) => player.id);
  return {
    playerAddresses,
    playerCash: playerAddresses.map((player) => ({
      player,
      cash_vgp: String(startingCash),
    })),
    /* The bank pays the players out of its own $12,000 -- it is not topped
       up per head. Floored at zero defensively; the real tables never come
       close (six at $400 is $2,400 of $12,000). */
    bankRemaining: Math.max(0, BANK_START - startingCash * count),
    certLimit,
    startingCash,
  };
}

/* ==================================================================
 *  DESIGN NOTE 526b: A DETERMINISTIC SHUFFLE, RUN ONCE
 * ==================================================================
 *
 * Turn order is random in 1830, and randomness is the one thing an
 * event-sourced log cannot replay. So the host shuffles ONCE, before the
 * action is written, and the order travels as data.
 *
 * This lives here rather than in the host's click handler because the
 * pairing matters: the function that deals a game and the function that
 * decides who deals first are the same rule, and separating them is how a
 * later pass "helpfully" reshuffles on replay.
 *
 * A PLAIN FISHER-YATES over `Math.random`. There is no need for a seeded
 * generator: the result is recorded, not reproduced.
 */
export function shuffleForTurnOrder(players: readonly SetupPlayer[]): SetupPlayer[] {
  const out = [...players];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ==================================================================
 *  DESIGN NOTE 530: THE SETUP ACTION IS SHAPED LIKE A MESSAGE
 * ==================================================================
 *
 * `{ SetupGame: { ... } }` -- a single-key object, exactly like every
 * `GameplayExecuteMsg` variant. That is not cosmetic: the whole dispatch
 * pipeline discriminates with `"LayTile" in msg`, so a setup action wearing
 * the same shape flows through `runGameplayAction`, the log, the replay and
 * the intercept without any of them learning a second convention.
 *
 * IT IS NOT A `GameplayExecuteMsg`, and must never become one. That type is
 * the contract's own message set -- `sessionKey.ts` maintains it as the
 * authz allow-list, and a variant the chain has never heard of appearing in
 * it would be a lie about what the wallet may sign. This is a SANDBOX-ONLY
 * event that shares a shape, which is why the union below lives here and the
 * two halves stay separately named.
 */
export interface SetupGameMsg {
  SetupGame: {
    /** Already shuffled, by the host, once -- design note #526b. */
    players: SetupPlayer[];
  };
}

/** Everything the sandbox log can carry -- the contract's own message set,
 *  plus this one sandbox-only setup event. A PRECISE union rather than an
 *  index signature: a loose type here would let any object into the replay
 *  and the pipeline would discover it was not a message at runtime. */
export type SandboxLogMsg = GameplayExecuteMsg | SetupGameMsg;

export function isSetupGameMsg(msg: unknown): msg is SetupGameMsg {
  return typeof msg === "object" && msg !== null && "SetupGame" in msg;
}

/* ==================================================================
 *  DESIGN NOTE 538: A ROOM NEVER BOOTS THE FIXTURE'S ROSTER
 * ==================================================================
 *
 * Two passes tried to make `SetupGame` OVERWRITE the four mock players, and
 * both failed in the same way: the fixture is the initial value, so any path
 * where the setup event does not land -- dropped, late, replayed against a
 * re-seed, mis-ordered -- leaves four strangers on the board, and leaves
 * them silently. The game looks dealt. It is just dealt for people who are
 * not in the room.
 *
 * Overwriting was the wrong shape of fix. A room's roster is not "the
 * fixture, corrected"; it is "nothing, until the log says otherwise". So the
 * fixture roster is never loaded in the first place, and this strips it.
 *
 * THE FAILURE MODE IS NOW VISIBLE. If setup does not arrive, the room shows
 * ZERO players -- obviously broken, in the direction that gets reported --
 * rather than four plausible ones nobody notices are wrong. That asymmetry
 * is the whole point: this codebase has hit the "wrong but plausible" class
 * repeatedly (design notes #492, #514, #537a), and an empty table cannot be
 * mistaken for a correct one.
 *
 * THE BOARD SURVIVES. Corporations, privates, the map and the market are
 * what a room plays WITH -- only the links to players are cut. The same cuts
 * the setup handler makes, applied earlier so there is no window in which
 * they have not been.
 */
export function withEmptyRoster(state: GameStateResponse): GameStateResponse {
  return {
    ...state,
    /* NEW ARRAYS, not filtered copies of the old ones. React compares by
       identity, and a reducer that hands back the same array reference is a
       re-render that never happens -- which is the other half of what the
       previous passes were fighting. */
    player_addresses: [],
    player_cash: [],
    max_players: 0,
    active_player_index: 0,
    priority_deal_index: 0,
    public_companies: state.public_companies.map((company) => ({
      ...company,
      president: null,
      player_holdings: [],
      is_floated: false,
    })),
    private_companies: state.private_companies.map((entry) => ({
      ...entry,
      owner: null,
      owner_protocol_id: null,
    })),
  };
}

/* ==================================================================
 *  DESIGN NOTE 542: THE AUCTION IS A FOURTH ATOM, AND IT WAS MISSED
 * ==================================================================
 *
 * REPORTED: the Action Bar's turn order is right, but the bottom Seating
 * Order is wrong and the bid labels name the wrong people.
 *
 * Two different atoms, and only one of them had been cleaned. `App.tsx`'s
 * own design note above `sandboxWaterfall` says it outright -- the sandbox
 * "keeps its game state in FOUR atoms, not one" -- and `withEmptyRoster`
 * plus the `SetupGame` handler between them touched exactly one:
 * `sandboxState`. The Action Bar reads that, so it was correct. The auction
 * dashboard reads `sandboxWaterfall`, which was still the fixture: mock
 * seating, mock bidders, mock `current_turn`.
 *
 * That is the same class of miss as the one before it, one atom over. The
 * lesson worth recording is that "the roster" is not a place in this
 * codebase -- it is a fact repeated across four independent stores, and a
 * fix applied to any one of them looks complete on whichever screen the
 * author happened to be looking at.
 *
 * A ROOM'S AUCTION STARTS CLEAN. No bids, nobody having passed, the turn on
 * the first seat in the dealt order. The fixture's half-finished auction is
 * a testbed for rendering a mid-auction screen alone; it is not an opening
 * position, and inheriting somebody else's bids is worse than inheriting
 * their names because the bids are ACTIONABLE.
 */
export function waterfallForRoster(
  /* NULL-SAFE, because `sandboxWaterfallState` returns `null` outside the
     auction phase -- a room that starts mid-game has no auction atom at all.
     Handling it here rather than at each call site keeps the two seeding
     points identical, which is the property that let them drift apart in the
     first place. */
  base: WaterfallStateResponse | null,
  playerAddresses: readonly string[],
): WaterfallStateResponse | null {
  if (!base) return null;
  return {
    ...base,
    /* The first seat in the dealt turn order. Empty roster -> empty string,
       which matches nobody -- so no client believes it is their turn, which
       is the right answer before a game has been dealt. */
    current_turn: playerAddresses[0] ?? "",
    consecutive_waterfall_passes: 0,
    mini_auction: null,
    privates: base.privates.map((entry) => ({ ...entry, bids: [] })),
  };
}
