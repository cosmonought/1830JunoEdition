// frontend/src/utils/gameSetup.ts
//
// What a player count decides: starting cash, and the certificate limit -- plus the dealer that writes them
// and the sandbox-only event types that carry a room's shared decisions.
//
// Design note #526: THE THIRD COPY THAT DID NOT GET WRITTEN. 1830 sets two numbers from the size of the
// table and this codebase already held each of them twice, one a hand-kept mirror whose own doc comment said
// so -- a correctness requirement enforced by a sentence. This is the single home; `gameState.ts` delegates
// and `RulesReference` renders from here.
//
// Design note #526a: the limits are APPLIED, not just reported -- and `initialiseSandboxGame` is a pure
// function of `(state, players)`, because every client runs it on the same setup action and must arrive at
// byte-identical state.
// Design note #526b: the turn order is randomised BY THE HOST and travels in the payload, because randomness
// is the one thing an event-sourced log cannot replay.
//
// Design notes #530/#538/#542/#546/#550/#573/#591/#594/#611/#662:
// see `docs/ai_architecture/sandbox_reducer.md`.

import type { GameplayExecuteMsg } from "./sessionKey";
/* TYPE-ONLY, and deliberately: `gameState.ts` imports from here, so a value import would be a real cycle. A
   type import is erased at compile time, and it keeps the roster stripper exact about the shape it returns --
   a structural generic was the first attempt and it widened the corporation and private arrays to
   `Record<string, unknown>`, which no caller could then use. */
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
  /** Design note #569: the seat's chosen colour, if they picked one. */
  color?: string;
}

/** What the host publishes when it starts the game. `players` IS ALREADY IN TURN ORDER (design note #526a):
 *  the shuffle happens once, on the host, and travels in the payload -- so every client deals the same table
 *  rather than each shuffling the same list differently. */
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

/** Deals a game for exactly these players, or `null` when the count is one 1830 does not define.
 *  PURE, and the purity is load-bearing rather than stylistic: every client runs this on the same setup
 *  action and the results must be identical, so it reads no clock, no random source and nothing local. */
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

/* Design note #526b: A DETERMINISTIC SHUFFLE, RUN ONCE. Turn order is random in 1830, and randomness is the
   one thing an event-sourced log cannot replay -- so the host shuffles ONCE, before the action is written,
   and the order travels as data.
   This lives here rather than in the host's click handler because the pairing matters: the function that
   deals a game and the function that decides who deals first are the same rule, and separating them is how a
   later pass "helpfully" reshuffles on replay.
   A plain Fisher-Yates over `Math.random` -- no seeded generator is needed, because the result is recorded,
   not reproduced. */
export function shuffleForTurnOrder(players: readonly SetupPlayer[]): SetupPlayer[] {
  const out = [...players];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* Design note #530: THE SETUP ACTION IS SHAPED LIKE A MESSAGE. A single-key object, exactly like every
   `GameplayExecuteMsg` variant -- not cosmetic: the dispatch pipeline discriminates with `"LayTile" in msg`,
   so a setup action wearing the same shape flows through `runGameplayAction`, the log, the replay and the
   intercept without any of them learning a second convention.
   IT IS NOT A `GameplayExecuteMsg`, and must never become one. That type is the contract's own message set --
   `sessionKey.ts` maintains it as the authz allow-list, and a variant the chain has never heard of appearing
   in it would be a lie about what the wallet may sign. */
export interface SetupGameMsg {
  SetupGame: {
    /** Already shuffled, by the host, once -- design note #526b. */
    players: SetupPlayer[];
  };
}

/* Design note #546: CLOSING THE AUCTION IS A TABLE DECISION. Writing `current_round_type` straight into
   local state is exactly right in solo sandbox and advances ONE BROWSER in a room -- and the divergence is
   not cosmetic: every later action replays into whatever round the receiving client believes it is in, so
   two clients holding different values are two clients running two different reducers over one log. That is
   the deepest desync available here, and it surfaces later as unexplainable state rather than as a visible
   failure at the moment it happened.
   IDEMPOTENT ON PURPOSE, which is what lets every client offer the button rather than electing one owner. A
   second copy in the log is noise, not a bug; nominating one player strands the table when they walk away. */
export interface OpenStockRoundMsg {
  OpenStockRound: Record<string, never>;
}

/* Design note #550: EVERY DECISION GOES IN THE LOG, OR IT IS NOT SHARED. Reported: P1 won the B&O and set
   its par, P1 could see themselves as president, P2 could not -- and then tried to buy the same certificate.
   The handler wrote the presidency, the par and the market mark straight into local state, and its own note
   (#461/#468) said so plainly and treated it as a curiosity. In a room it means the one client that answered
   the prompt is the only client that ever learns the answer. The free-station handler had the identical
   shape and would have been reported next.
   THIS IS THE THIRD TIME -- #546 was the same bug, fixed one pass earlier without anyone checking for
   siblings. So the rule, stated as a rule: IN A ROOM, ANY WRITE TO SANDBOX STATE THAT DOES NOT GO THROUGH
   `runGameplayAction` IS A WRITE ONLY ONE PLAYER SEES. No warning, no error, no visible failure -- the
   clients simply stop being the same game, and #549 explains why the damage then compounds silently.
   (`payPrivateRevenue` is deliberately not in this list: it is a derived payout fired by the round
   transition on every client from state they all share. A CHOICE must be logged, a CONSEQUENCE need not be.) */
export interface SetBoParMsg {
  SetBoPar: {
    /** The winning player, carried explicitly rather than inferred from the
     *  turn cursor -- the auction's cursor has already moved on by the time
     *  the prompt is answered, and design note #549 is about exactly this
     *  class of inference. */
    player: string;
    par_value: string;
  };
}

/** Design note #573: the Mohawk & Hudson's and Camden & Amboy's exchanges. Sandbox-only, and logged because
 *  it is a CHOICE (#550) -- a share arriving in one browser only is the same class of bug as the B&O
 *  presidency was. The RESOLVED grant travels, not the request: legality is decided once, on the acting
 *  client, so every client applies the same result even if their view of the IPO differs by a share.
 *  Design note #591: UNDO IS AN EVENT, NOT A REWIND. Undo was a per-client SNAPSHOT STACK (#178) -- exact and
 *  free in a solo sandbox, incoherent in a room, where each browser holds only the actions IT dispatched, so
 *  popping would rewind one screen and leave the others playing a game that had not been undone. The stack
 *  also bypasses the log entirely, and the log is the game (#522).
 *  SO UNDO APPENDS. `RevertTo { index }` means "every action from `index` onward did not happen"; every client
 *  replays it, drops those actions and rebuilds from the seed.
 *  NOTHING IS DELETED, which is the property that makes this safe -- the log grows forward even when the game
 *  goes backward, so a bad revert can itself be reverted and two clients cannot disagree about what was undone.
 *  REBUILDING IS CHEAP AND IS THE POINT: a replay reaches EXACTLY the state the log describes, where inverting
 *  each message needs one correct inverse per type and gets subtly wrong for anything that touched the market,
 *  the era or a cascade. */
export interface RevertToMsg {
  RevertTo: {
    /** The first log index that no longer counts. Everything from here
     *  onward is dropped, including any earlier `RevertTo` in that range. */
    index: number;
    /** Who asked, for the log line. */
    player: string;
    /** What the player was told they were undoing, so the sentence the
     *  Activity Log prints matches the one they clicked. */
    summary: string;
  };
}

export interface ExchangePrivateMsg {
  ExchangePrivate: {
    private_id: number;
    company_id: number;
    player: string;
    source: "Ipo" | "Bank";
    /** Design note #576: the Camden & Amboy's purchase bonus grants a share
     *  WITHOUT consuming the company -- it stays open and keeps paying. The
     *  Mohawk & Hudson's exchange does consume it. Absent means "close it",
     *  which keeps every existing log entry meaning what it meant. */
    keep_open?: boolean;
  };
}

export interface PlaceHomeStationMsg {
  PlaceHomeStation: {
    company_id: number;
    q: number;
    r: number;
    /** `home` places a corporation's free starting token; `dh` spends the
     *  Delaware & Hudson's power. Two different rules, one placement. */
    kind: "home" | "dh";
    /** Design note #560: WHICH city on the hex the player clicked. `null`
     *  when the geometry could not say, which leaves the renderer's
     *  heuristic in charge exactly as before. */
    city_index: number | null;
    /** The hex's printed label, carried rather than re-derived on each
     *  client. Purely for the log line -- and carrying it means every
     *  client's Activity Log quotes the same sentence the acting player
     *  read, which is the point of a shared log. */
    hex_label: string;
  };
}

/* Design note #662: AN OFFER NOBODY ELSE COULD SEE. The proposal was React state in `App.tsx`, and #205 says
   exactly why: the local stand-in existed "for exactly ONE deployment: the offline sandbox, which has no
   chain to record an offer in and no second client to show it to."
   THAT PREMISE EXPIRED. #578 removed solo mode and #536 settled that "a room is not a hotseat". There IS a
   second client now -- so the seller was never asked, and the sandbox override forced the consent check open
   for the same expired reason, which is why the buyer could answer their own offer.
   TWO MESSAGES, not one: a proposal and its answer are separate events with different authors, and collapsing
   them would lose the interval in which the offer is pending -- the only part of this flow the other player
   experiences.
   SANDBOX-ONLY, because the contract's `BuyPrivateCompany` is single-party. Until it grows an accept step,
   consent is a rule this frontend keeps by itself, and a rule kept by one client is not kept at all. */
export interface ProposePrivatePurchaseMsg {
  ProposePrivatePurchase: {
    private_id: number;
    /** Carried rather than re-derived, so every client's prompt names the
     *  private the buyer was looking at -- the same reasoning
     *  `PlaceHomeStation` gives for carrying `hex_label`. */
    private_name: string;
    /** The wallet whose consent 1830 requires. */
    owner: string;
    buyer_protocol_id: number;
    buyer_ticker: string;
    /** Whole VGP. A string would match the contract's convention, but this
     *  message has no contract to match and an integer price is what every
     *  reader wants. */
    price: number;
  };
}

/** The owner's answer. Rejecting is a real event, not the absence of one:
 *  it clears the offer on every client and it belongs in the log so the
 *  Activity Log can say the sale was declined rather than silently dropping
 *  it. */
export interface AnswerPrivatePurchaseMsg {
  AnswerPrivatePurchase: {
    private_id: number;
    accept: boolean;
  };
}

/* Design note #701: THE SAME NEGOTIATION, FOR TRAINS.
   REPORTED: "the 'Buy Trains from Other Corporations' action offer is not sending the modal notification to
   the selling player. Instead, it is showing up as a modal on the Buyer's screen and they can accept/reject
   it as they wish. I thought this bug had been fixed before?"
   IT WAS -- FOR PRIVATES, at #662. That fix moved the proposal out of React state and into the log, and
   removed the `sandbox ||` bypass from the consent check. The train flow was the OTHER instance of the same
   two faults and was left with both. #662's own note even names trains in its opening clause ("Trains have a
   full on-chain offer flow; privates are single-party") -- true of the ONLINE path, and the sandbox path was
   reading that sentence as though it covered both.
   WHY TRAINS NEED THIS AT ALL, given the contract has `GetTrainOffers`: the sandbox has no chain to hold the
   register. Online, `liveTrainOffer` filters the contract's own offers by `seller_president` and reaches the
   right client. Offline there was nothing between the two browsers, so a local `useState` was standing in for
   a shared register -- which is a register of one.
   TWO MESSAGES for the reason #662 gives: a proposal and its answer have different authors, and collapsing
   them loses the interval in which the offer is pending -- the only part of this the seller experiences. */
export interface ProposeTrainPurchaseMsg {
  ProposeTrainPurchase: {
    seller_protocol_id: number;
    seller_ticker: string;
    /** The wallet whose consent 1830 requires. `null` for a corporation with no president on record, which
     *  cannot be asked and therefore cannot sell. */
    seller_president: string | null;
    buyer_protocol_id: number;
    buyer_ticker: string;
    model_type: string;
    /** A STRING, matching `TrainTradeProposal` and the contract's `Uint128`. Unlike the private offer's
     *  integer price this one does have a contract to match, and parsing it to `Number` anywhere on the path
     *  would be a silent precision bug for no benefit. */
    price: string;
  };
}

/** The seller's answer. A refusal is a real event, not the absence of one: it clears the offer on every client
 *  and it belongs in the log so the Activity Log can say the sale was declined. */
export interface AnswerTrainPurchaseMsg {
  AnswerTrainPurchase: {
    /** Which offer is being answered. Trains have no id of their own in the sandbox register -- there is only
     *  ever one pending offer -- so the seller identifies it, which is enough for the drain to refuse an
     *  answer aimed at an offer that has already been settled or replaced. */
    seller_protocol_id: number;
    accept: boolean;
  };
}

/** Everything the sandbox log can carry -- the contract's own message set,
 *  plus the sandbox-only round events. A PRECISE union rather than an
 *  index signature: a loose type here would let any object into the replay
 *  and the pipeline would discover it was not a message at runtime. */
export type SandboxLogMsg =
  | GameplayExecuteMsg
  | SetupGameMsg
  | OpenStockRoundMsg
  | SetBoParMsg
  | PlaceHomeStationMsg
  | ExchangePrivateMsg
  | ProposePrivatePurchaseMsg
  | AnswerPrivatePurchaseMsg
  | ProposeTrainPurchaseMsg
  | AnswerTrainPurchaseMsg
  | RevertToMsg;

export function isProposeTrainPurchaseMsg(msg: unknown): msg is ProposeTrainPurchaseMsg {
  return typeof msg === "object" && msg !== null && "ProposeTrainPurchase" in msg;
}

export function isAnswerTrainPurchaseMsg(msg: unknown): msg is AnswerTrainPurchaseMsg {
  return typeof msg === "object" && msg !== null && "AnswerTrainPurchase" in msg;
}

export function isProposePrivatePurchaseMsg(msg: unknown): msg is ProposePrivatePurchaseMsg {
  return typeof msg === "object" && msg !== null && "ProposePrivatePurchase" in msg;
}

export function isAnswerPrivatePurchaseMsg(msg: unknown): msg is AnswerPrivatePurchaseMsg {
  return typeof msg === "object" && msg !== null && "AnswerPrivatePurchase" in msg;
}

export function isSetupGameMsg(msg: unknown): msg is SetupGameMsg {
  return typeof msg === "object" && msg !== null && "SetupGame" in msg;
}

export function isOpenStockRoundMsg(msg: unknown): msg is OpenStockRoundMsg {
  return typeof msg === "object" && msg !== null && "OpenStockRound" in msg;
}

export function isSetBoParMsg(msg: unknown): msg is SetBoParMsg {
  return typeof msg === "object" && msg !== null && "SetBoPar" in msg;
}

export function isPlaceHomeStationMsg(msg: unknown): msg is PlaceHomeStationMsg {
  return typeof msg === "object" && msg !== null && "PlaceHomeStation" in msg;
}

export function isExchangePrivateMsg(msg: unknown): msg is ExchangePrivateMsg {
  return typeof msg === "object" && msg !== null && "ExchangePrivate" in msg;
}

export function isRevertToMsg(msg: unknown): msg is RevertToMsg {
  return typeof msg === "object" && msg !== null && "RevertTo" in msg;
}

/** Neither sandbox-only event may reach `execGameplay` -- the contract has
 *  no such message. One predicate so a third event cannot be added to the
 *  union and forgotten at the one call site that must refuse them. */
export function isSandboxOnlyMsg(
  msg: unknown,
):
  msg is
    | SetupGameMsg
    | OpenStockRoundMsg
    | SetBoParMsg
    | PlaceHomeStationMsg
    | ExchangePrivateMsg
    // Design note #662: the private-purchase negotiation. Added HERE and
    // nowhere else, which is the point of this predicate existing (#546).
    | ProposePrivatePurchaseMsg
    | AnswerPrivatePurchaseMsg
    // Design note #701: and the train negotiation, which is the same shape.
    | ProposeTrainPurchaseMsg
    | AnswerTrainPurchaseMsg
    | RevertToMsg {
  return (
    isSetupGameMsg(msg) ||
    isOpenStockRoundMsg(msg) ||
    isSetBoParMsg(msg) ||
    isPlaceHomeStationMsg(msg) ||
    isExchangePrivateMsg(msg) ||
    isProposePrivatePurchaseMsg(msg) ||
    isAnswerPrivatePurchaseMsg(msg) ||
    isProposeTrainPurchaseMsg(msg) ||
    isAnswerTrainPurchaseMsg(msg) ||
    isRevertToMsg(msg)
  );
}

/* Design note #538: A ROOM NEVER BOOTS THE FIXTURE'S ROSTER. Two passes tried to OVERWRITE the four mock
   players and both failed the same way: the fixture is the initial value, so any path where the setup event
   does not land leaves four strangers on the board, silently. The game looks dealt. It is just dealt for
   people who are not in the room.
   A room's roster is not "the fixture, corrected"; it is "nothing, until the log says otherwise".
   THE FAILURE MODE IS NOW VISIBLE: no setup means ZERO players -- obviously broken, in the direction that
   gets reported -- rather than four plausible ones nobody notices are wrong. This codebase has hit the
   "wrong but plausible" class repeatedly (#492, #514, #537a), and an empty table cannot be mistaken for a
   correct one.
   THE BOARD SURVIVES: corporations, privates, the map and the market are what a room plays WITH. */
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
    // Design note #594: AN UNSTARTED CORPORATION HAS NO PRICE EITHER. This stripped president, holdings and
    // float and left `par_value` alone -- and the fixture is a MID-GAME testbed whose corporations are already
    // parred. So every corporation read as already started under #587's `par_value === null` test: the founding
    // buy granted no presidency, set no par, and the fallback kept the fixture's figure instead of the player's.
    // THE SHARE POOLS GO TOO: a fixture corporation has already sold shares, so an untouched IPO pool would let
    // a room's first buyer draw from a pile a game which never happened had already emptied.
    // THE RULE THIS KEEPS ARRIVING AT (#538, #542, this): a room starts from the fixture's BOARD with every trace
    // of a played game removed. Anything a game WROTE has to be reset here, and `par_value` was a written thing
    // that looked like a printed one.
    // Design note #611: THE PHASE WAS A WRITTEN THING TOO. `current_global_era` and `owned_trains` are written by
    // a game being played and neither was reset -- so a room booted into the fixture's Green mid-game state, the
    // opening-sub-phase rule correctly answered "BuyPrivate" for Phase 3, and the first Operating Round of a new
    // game opened on a step the rules do not offer until two phases later.
    // NOTHING WAS WRONG WITH THE SUB-PHASE LOGIC, which is why this took a report to find. Every consumer behaved
    // correctly for the phase they were told they were in. They were told the wrong phase.
    // BOTH FIELDS, NOT JUST THE ERA -- resetting the era alone leaves a room whose corporations own trains they
    // never bought, which sets the train limit, the rust outlook, the depot count and the phase badge from a game
    // that did not happen.
    // `[]`, NOT DELETED: `gamePhase.ts #3` distinguishes "no corporation reported trains" from "this corporation
    // owns none", and a fresh board is the second.
    current_global_era: "Yellow",
    public_companies: state.public_companies.map((company) => ({
      ...company,
      president: null,
      player_holdings: [],
      is_floated: false,
      par_value: null,
      ipo_pool_percentage: 100,
      bank_pool_percentage: 0,
      // Design note #611: nobody has bought a train yet.
      owned_trains: [],
      /* `treasury`, NOT `treasury_vgp`. The first version of this line invented the second name -- a spread accepts
         any extra key, so nothing complained and the real treasury went on carrying the fixture's balance. Only a
         TEST reading the field caught it, which is the argument for asserting the reset rather than trusting the
         write. */
      treasury: "0",
    })),
    private_companies: state.private_companies.map((entry) => ({
      ...entry,
      owner: null,
      owner_protocol_id: null,
    })),
  };
}

/* Design note #542: THE AUCTION IS A FOURTH ATOM, AND IT WAS MISSED. Reported: the Action Bar's turn order is
   right, the Seating Order is wrong and the bid labels name the wrong people. Two different atoms, and only
   one had been cleaned -- the bar reads `sandboxState`, so it was correct; the dashboard reads
   `sandboxWaterfall`, which was still the fixture.
   The lesson worth recording is that "the roster" is not a place in this codebase -- it is a fact repeated
   across four independent stores, and a fix applied to any one of them looks complete on whichever screen the
   author happened to be looking at.
   A ROOM'S AUCTION STARTS CLEAN. Inheriting somebody else's bids is worse than inheriting their names, because
   the bids are ACTIONABLE. */
export function waterfallForRoster(
  /* NULL-SAFE, because the waterfall atom is `null` outside the auction phase. Handled here rather than at each
     call site, which keeps the two seeding points identical -- the property that let them drift apart in the
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
