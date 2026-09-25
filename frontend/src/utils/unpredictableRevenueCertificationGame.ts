// frontend/src/utils/unpredictableRevenueCertificationGame.ts
//
// TEST SUPPORT ONLY for UR-7 (Variant Certification 1B -- Unpredictable Revenue certification). Nothing in the app
// imports this.
//
// ==================================================================
//  UR-7 (support): THE CONSTRUCTED CERTIFICATION GAME -- G1 (two tails) AND G0 (the standard control)
// ==================================================================
//
// A CONSTRUCTED CERTIFICATION GAME -- NOT A HISTORICAL GAME, NOT A GOLDEN. It is never exported, never added to the
// development corpus and never blessed: a starting board plus a fixed, board-driven script of messages, played through
// the same `RoomSession` a server runs (ingress, the server's own draw, the append, the room's derived entries), so the
// Unpredictable Revenue rules as the owner decided them (OD-UR-1 ... OD-UR-13, OD-GR-3) are proved to COMPOSE in one
// game -- with Gentle Rust on, as the audit's G1 prescribes (§14.2) -- rather than only on isolated boards.
//
// THE RANDOMNESS IS SCRIPTED BY REPLACING THE RNG, NOT THE RULES (§14.1). `mintSeed` is the server's draw; here it
// answers with the draw the driver ARMED for the run it is about to submit (`drawStage`: the stage the script needs of
// that turn). Every draw is FOUND, never asserted: the first seed from 1 upward whose outcome -- by the pure selectors the reducer
// and the shell both use (`rollTurnRevenue`, `flavorBucketFor`, `revenueFlavourClause`, `carcosaRollHits`, through
// `yellowSignRunBoundSupport`'s predicates) -- is the stage the script needs on the printed total the run will score.
// So a change to the flavour payload or the extractions shifts a seed rather than silently shifting the game, and the
// test re-derives each stage from its seed and from the board the room produced. A draw the driver did not arm THROWS:
// the server may draw nowhere the script did not plan (a restore, a replay and an undo's re-run draw nothing).
// (The audit's §14.1 sketched seed CONSTANTS that fail loudly when the payload moves; searching at run time, as UR-3's
// support does, keeps the game playing its stages after such a change -- the test still pins each stage on the board.
// A quiet draw starts its search at an offset taken from its turn, so the quiet runs meet every non-stage face.)
//
// PROVENANCE OF THE STARTING BOARD. The board is CONSTRUCTED, as GR-4's was: the phase, the Depot, the fleets, the
// holdings, the cursor and the private companies are each reachable by legal play; the route network, the treasuries and
// the share prices are set rather than earned (no track on this map could have earned PRR's $1,500), and say so below:
//   * THE NETWORK (constructed). The Gulf line the Batch-6 route-authority harness proves (`routeAuthority.test.ts`,
//     `yellowSignRunBoundSupport.ts`): yellow city tiles on I5, I7 and I9, the plain curve I3, the Gulf off-board J2
//     (yellow $30, brown $60). C&O's station on I5 and B&O's second station on I9 are constructed facts -- the printed
//     map would need several Operating Rounds of tile lays to give any corporation an earning route, and the variant
//     rides on runs that earn (a Mark needs a real reduction, a Carcosa a real increase). Every other corporation's
//     token is on its REAL printed home (`STATION_HOME_HEXES`) with no track: none of them has a route, so the room's
//     own derived actions skip their Routes steps and force their $0 withholds (GR-4's device).
//   * Rules: Unpredictable Revenue + Gentle Rust (G1) or Gentle Rust alone (G0), standard 1830 otherwise, pinned to the
//     engine's `RULES_ENGINE_VERSION` -- replayed under `SERVER_REPLAY_POLICY`, no legacy adapter involved.
//   * Cursor: Operating Round 3.1 of a two-round set (phase 3 sets are two rounds), NYC -- first in the order -- at the
//     START of its turn (Lay Track). The round's opening (operating order, private income) has happened.
//   * Phase 3, limit 4: all six 2-trains and all five 3-trains are owned, none in the Bank Pool (the limit did not drop
//     between phases 2 and 3, so no excess discard has happened), so the depot's head is the first 4-train.
//   * Six corporations floated -- NYC, PRR, CPR, ERIE, B&O, C&O -- every certificate in players' hands (10 issued);
//     NNH and B&M unfloated. Fleets (limit 4): NYC [2,3], PRR [2,3], CPR [2,3], ERIE [3], B&O [2,2,3], C&O [2].
//   * Share prices (constructed) on real chart cells of ONE row (`marketCellForPrice`): NYC 112, PRR 100, CPR 90,
//     ERIE 82, B&O 76, C&O 71 -- which is the operating order. Pars are printed par values (100, 90, 82, 76, 71, 67).
//   * Treasuries (constructed): what each corporation's scripted purchases need -- NYC $1,200, PRR $1,500, CPR $1,000,
//     ERIE $1,000, B&O $1,700, C&O $1,300.
//   * Private companies: all six sold in the opening auction; C&O bought the Schuylkill Valley from its owner in phase 3
//     (legal from the first 3-train), so its $5 comes to C&O's TREASURY each Operating Round -- the income the die never
//     touches (UR-N12). The B&O private is closed (the B&O corporation has bought a train, #660); the others close at the
//     first 5-train.
//   * Money: every dollar of the $12,000 bank is accounted for -- bank + player cash + treasuries = 12,000.
// After this board the game advances ONLY by messages submitted through `RoomSession.submit` with the acting president
// (or the Stock Round seat) as the author; the room appends its own derived entries. No board is patched between steps.

import type { GameStateResponse, PublicCompanyState, PrivateCompanyState } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { STATION_HOME_HEXES } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import { RoomSession, type ServerLogEntry } from "./roomSession";
import { resolveVariants, type GameVariants, type RevenueSeedParts } from "../gameEngine/gameVariants";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { marketCellForPrice } from "../gameEngine/marketGeometry";
import { stateDigest } from "../gameEngine/stateDigest";
import {
  GULF,
  R,
  roomProviders,
  seedWhere,
  isMarkDraw,
  isCarcosaDraw,
  isQuietDraw,
  type Route,
} from "./yellowSignRunBoundSupport";
import { revenueDieFace } from "../gameEngine/gameVariants";
import { derivePhase, depotInventory } from "../gameEngine/gamePhase";
import { countableTrainCount } from "../gameEngine/trainLimit";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { sandboxActionContext } from "../gameEngine/actionContext";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";

export const P1 = "p1";
export const P2 = "p2";
export const P3 = "p3";

export const PRR = 1;
export const NYC = 2;
export const CPR = 3;
export const BO = 4;
export const CO = 5;
export const ERIE = 6;

export const TICKER: Record<number, string> = { 1: "PRR", 2: "NYC", 3: "CPR", 4: "B&O", 5: "C&O", 6: "ERIE", 7: "NNH", 8: "B&M" };
/** 1830's printed station allowance, home token included (`sandboxState.ts` #237). */
const TOKENS: Record<number, number> = { 1: 4, 2: 4, 3: 4, 4: 3, 5: 3, 6: 3, 7: 2, 8: 2 };

export const BANK_SIZE = 12_000;

interface Floated {
  id: number;
  president: string;
  /** A printed par value. */
  par: number;
  holdings: Array<[string, number]>;
  treasury: number;
  trains: string[];
  price: number;
  /** Station hexes, home first. Defaults to the printed home. */
  tokens?: string[];
}

/** The six floated corporations of the starting board, in operating order. */
export const FLOATED: readonly Floated[] = [
  { id: NYC, par: 100, president: P2, holdings: [[P2, 60], [P1, 20], [P3, 20]], treasury: 1_200, trains: ["2", "3"], price: 112 },
  { id: PRR, par: 90, president: P1, holdings: [[P1, 60], [P2, 20], [P3, 20]], treasury: 1_500, trains: ["2", "3"], price: 100 },
  { id: CPR, par: 82, president: P3, holdings: [[P3, 60], [P1, 20], [P2, 20]], treasury: 1_000, trains: ["2", "3"], price: 90 },
  { id: ERIE, par: 76, president: P2, holdings: [[P2, 60], [P3, 20], [P1, 20]], treasury: 1_000, trains: ["3"], price: 82 },
  { id: BO, par: 71, president: P3, holdings: [[P3, 60], [P2, 20], [P1, 20]], treasury: 1_700, trains: ["2", "2", "3"], price: 76, tokens: ["I15", "I9"] },
  { id: CO, par: 67, president: P1, holdings: [[P1, 60], [P2, 20], [P3, 20]], treasury: 1_300, trains: ["2"], price: 71, tokens: ["I5"] },
];

export const PLAYER_CASH: Readonly<Record<string, number>> = { [P1]: 500, [P2]: 500, [P3]: 500 };

/** Every private sold in the opening auction; C&O bought the Schuylkill Valley in phase 3; the B&O private closed when
 *  the B&O corporation bought its first train (#660). */
const PRIVATES: ReadonlyArray<{ id: number; name: string; cost: number; revenue: number; owner: string | null; corp: number | null; closed: boolean }> = [
  { id: 1, name: "Schuylkill Valley", cost: 20, revenue: 5, owner: null, corp: CO, closed: false },
  { id: 2, name: "Champlain & St. Lawrence", cost: 40, revenue: 10, owner: P2, corp: null, closed: false },
  { id: 3, name: "Delaware & Hudson", cost: 70, revenue: 15, owner: P1, corp: null, closed: false },
  { id: 4, name: "Mohawk & Hudson", cost: 110, revenue: 20, owner: P2, corp: null, closed: false },
  { id: 5, name: "Camden & Amboy", cost: 160, revenue: 25, owner: P1, corp: null, closed: false },
  { id: 6, name: "Baltimore & Ohio", cost: 220, revenue: 30, owner: P3, corp: null, closed: true },
];

function hex(label: string): { q: number; r: number } {
  const found = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!found) throw new Error(`no hex ${label}`);
  return { q: found.q, r: found.r };
}
const home = (id: number) => STATION_HOME_HEXES.find((entry) => entry.companyId === id)!;

/** The constructed network (see the header): `yellowSignRunBoundSupport`'s Gulf line. */
export const NETWORK: MapGridResponse = GULF;

export interface StartOptions {
  /** Unpredictable Revenue on (G1, the default) or off (G0, the paired standard control). Gentle Rust is on in both. */
  unpredictableRevenue?: boolean;
}

export function certificationVariants(options: StartOptions = {}): GameVariants {
  return resolveVariants({ unpredictableRevenue: options.unpredictableRevenue ?? true, gentleRust: true } as Partial<GameVariants>);
}

/** The constructed starting board. A fresh object every call. */
export function certificationStart(options: StartOptions = {}): GameStateResponse {
  const treasuries = FLOATED.reduce((sum, entry) => sum + entry.treasury, 0);
  const cash = Object.values(PLAYER_CASH).reduce((sum, value) => sum + value, 0);
  const floated = (entry: Floated): PublicCompanyState => {
    const tokens = (entry.tokens ?? [home(entry.id).label]).map(hex);
    return {
      company_id: entry.id,
      ticker: TICKER[entry.id],
      is_floated: true,
      treasury: String(entry.treasury),
      total_shares_issued: 10,
      par_value: String(entry.par),
      last_route_revenue: "0",
      president: entry.president,
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      player_holdings: entry.holdings.map(([player, percentage]) => ({ player, percentage })),
      home_hex_label: entry.tokens?.[0] ?? home(entry.id).label,
      station_token_hexes: tokens.map(({ q, r }) => [q, r]),
      station_tokens: tokens.map(({ q, r }) => [q, r, 0]),
      station_token_limit: TOKENS[entry.id],
      owned_trains: [...entry.trains],
      pending_rust_trains: [],
    } as unknown as PublicCompanyState;
  };
  const unfloated = (id: number): PublicCompanyState =>
    ({
      company_id: id,
      ticker: TICKER[id],
      is_floated: false,
      treasury: "0",
      total_shares_issued: 0,
      par_value: null,
      last_route_revenue: "0",
      president: null,
      ipo_pool_percentage: 100,
      bank_pool_percentage: 0,
      player_holdings: [],
      home_hex_label: home(id).label,
      station_token_hexes: [],
      station_tokens: [],
      station_token_limit: TOKENS[id],
      owned_trains: [],
      pending_rust_trains: [],
    }) as unknown as PublicCompanyState;
  return {
    game_id: 1,
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: String(PLAYER_CASH[player]) })),
    virtual_bank_vgp: String(BANK_SIZE - treasuries - cash),
    virtual_bank_start: String(BANK_SIZE),
    private_companies: PRIVATES.map(
      (entry) =>
        ({
          private_id: entry.id,
          name: entry.name,
          cost: String(entry.cost),
          revenue_per_or: String(entry.revenue),
          owner: entry.owner,
          owner_protocol_id: entry.corp,
          closed: entry.closed,
        }) as PrivateCompanyState,
    ),
    variants: certificationVariants(options),
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    operating_round_sequence_length: 2,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    active_operating_order: FLOATED.map((entry) => entry.id),
    active_corporation_index: 0,
    operating_sub_phase: "Track",
    rules_engine_version: RULES_ENGINE_VERSION,
    returned_trains: [],
    market_positions: Object.fromEntries(
      FLOATED.map((entry, index) => [entry.id, { price: entry.price, ...marketCellForPrice(entry.price)!, enteredAt: index + 1 }]),
    ),
    public_companies: [...FLOATED.map(floated), unfloated(7), unfloated(8)].sort((a, b) => a.company_id - b.company_id),
  } as unknown as GameStateResponse;
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

type Msg = SandboxLogMsg;
const m = (msg: unknown) => msg as Msg;
export const ADVANCE = (id: number) => m({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: id } });
export const PASS = m({ PassTurn: { game_id: 1 } });
export const BUY = (id: number, tier?: string) => m({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, ...(tier === undefined ? {} : { model_type: tier }) } });
export const BUY_POOL = (id: number, model: string) => m({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, returned_model_type: model } });
export const EXCHANGE = (id: number, model: string) => m({ ExchangeTrainForDiesel: { game_id: 1, protocol_id: id, model_type: model } });
export const DECLARE = (id: number, amount: number, distribute: boolean) =>
  m({ DeclareDividends: { game_id: 1, protocol_id: id, revenue_amount: String(amount), distribute } });
export const RUN = (id: number, routes: Route[], trains: string[], indices: number[], seed?: number) =>
  m({
    RunMultipleRoutes: {
      game_id: 1,
      protocol_id: id,
      routes,
      trains,
      train_indices: indices,
      ...(seed === undefined ? {} : { revenue_seed: seed }),
      payout_strategy: "Withhold",
    },
  });
export const PROPOSE = (seller: number, buyer: number, model: string, price: number, gilded?: boolean) =>
  m({
    ProposeTrainPurchase: {
      game_id: 1,
      seller_protocol_id: seller,
      seller_ticker: TICKER[seller],
      seller_president: "narration",
      buyer_protocol_id: buyer,
      buyer_ticker: TICKER[buyer],
      model_type: model,
      price: String(price),
      ...(gilded === undefined ? {} : { gilded }),
    },
  });
export const ANSWER = (seller: number, accept: boolean) => m({ AnswerTrainPurchase: { game_id: 1, seller_protocol_id: seller, accept } });
export const REVERT = (index: number, player: string) => m({ RevertTo: { index, player, summary: "undo" } });
/** A client's Yellow Sign request -- never a source of authority on a pinned table (OD-UR-1). */
export const SIGN = (id: number, extra: Record<string, unknown> = {}) => m({ YellowSignEvent: { game_id: 1, protocol_id: id, ...extra } });

/* ------------------------------------------------------------------ */
/* The network's routes                                                */
/* ------------------------------------------------------------------ */

/** C&O's short route to the Gulf: I5-I3-J2 -- yellow $50, brown $80. */
export const GULF_SHORT = R("I5", "I3", "J2");
/** C&O's line: I5-I7-I9 -- $60 in every era (it ends at B&O's I9 station, which a route may end at, never pass). */
export const LINE = R("I5", "I7", "I9");
/** A 4-city run for one train: J2-I3-I5-I7-I9 -- yellow $90, brown $120. */
export const LONG = R("J2", "I3", "I5", "I7", "I9");
/** B&O's one route from its I9 station: I9-I7-I5 (it ends at C&O's full I5) -- $60 in every era. */
export const BO_LINE = R("I9", "I7", "I5");
/** A 2-city shortfall for C&O's lone 2-train: I5-I7, $40 where the Gulf pays $50 (S6-3 refuses it). */
export const SHORTFALL = R("I5", "I7");

/* ------------------------------------------------------------------ */
/* The draws                                                           */
/* ------------------------------------------------------------------ */

export type SeedStage = "tie+10" | "mark" | "carcosa" | "quiet";

export type PlannedDraw = Pick<Draw, "macro" | "sub" | "corp" | "printed" | "stage">;

const parts = (draw: Pick<PlannedDraw, "macro" | "sub" | "corp">, turnSeed: number): RevenueSeedParts => ({
  macroRound: draw.macro,
  subRound: draw.sub,
  companyId: draw.corp,
  turnSeed,
});

/** Whether `seed` gives `draw` its stage, by the pure selectors. */
export function drawReaches(draw: PlannedDraw, seed: number): boolean {
  const at = parts(draw, seed);
  switch (draw.stage) {
    case "tie+10":
      // face 5 (+10%) on a printed total that ties, and nothing the Sign can read (face 5 is neither of its buckets).
      return revenueDieFace(at) === 5 && isQuietDraw(draw.printed, at);
    case "mark":
      return isMarkDraw(draw.printed, at);
    case "carcosa":
      return isCarcosaDraw(draw.printed, at);
    case "quiet":
      return isQuietDraw(draw.printed, at);
  }
}

export const drawKey = (macro: number, sub: number, corp: number) => `${macro}.${sub}.${corp}`;

/** The stage the script needs from the draw of `corp`'s run on `state`:
 *    - C&O's first run (OR 3.1, a lone 2-train, printed $50): face 5, the exact $5 tie of OD-UR-10;
 *    - C&O's Gentle Rust grace turn (OR 3.2, [2 on its Final Run, 4], printed $110): the Mark;
 *    - C&O's first run while Marked in phase 5 with every 5 sold (the Depot's lowest train is a 6): Carcosa -- a gift
 *      ABOVE the phase;
 *    - every other run: quiet -- no Sign line, no critical bonus. */
export function drawStage(state: GameStateResponse, corp: number): SeedStage {
  if (corp !== CO) return "quiet";
  const c = state.public_companies.find((entry) => entry.company_id === CO)!;
  if (state.macro_round_number === 3 && state.sub_round_index === 1) return "tie+10";
  if (state.macro_round_number === 3 && state.sub_round_index === 2) return "mark";
  const head = depotInventory(state).find((row) => row.remaining === null || (row.remaining ?? 0) > 0)?.tier ?? null;
  if (c.has_yellow_sign === true && derivePhase(state)?.tier === "5" && head === "6") return "carcosa";
  return "quiet";
}

/** One draw the server made: the turn it belongs to, the printed total the run scored, the stage the script needed and
 *  the seed found for it. The test re-derives each stage from its seed and checks the board applied it. */
export interface Draw {
  turn: string;
  macro: number;
  sub: number;
  corp: number;
  printed: number;
  stage: SeedStage;
  seed: number;
}

/* ------------------------------------------------------------------ */
/* The script                                                          */
/* ------------------------------------------------------------------ */

/** One submitted message. `expect` is the room's answer; `label` names the checkpoint the test inspects. */
export interface ScriptStep {
  label: string;
  actor: string;
  msg: Msg;
  expect: "applied" | "refused";
}

const step = (label: string, actor: string, msg: Msg, expect: "applied" | "refused" = "applied"): ScriptStep => ({ label, actor, msg, expect });

/** A sentinel `RevertTo` resolved at send time to the index of the latest run entry. */
export const REVERT_LAST_RUN = m({ RevertTo: { index: -1, player: "resolve", summary: "undo" } });

type Sub = "Routes" | "Dividends" | "Hardware";

/** A scripted moment: on `corp`'s turn, at `at`, once `when` holds of the board, its steps are sent in order (one per
 *  turn of the driver's loop, so each reads the board the previous one left). WHEN IS A FUNCTION OF THE BOARD ALONE (and
 *  of which labels were already sent), so the script is fixed and replayable while the operating order -- which the
 *  share prices decide -- is left to the game. */
export interface ScriptEvent {
  corp: number;
  at: Sub;
  when: (state: GameStateResponse, done: ReadonlySet<string>) => boolean;
  steps: ScriptStep[];
}

const company = (state: GameStateResponse, id: number) => state.public_companies.find((entry) => entry.company_id === id)!;
const fleet = (state: GameStateResponse, id: number) => company(state, id).owned_trains ?? [];
const gilded = (state: GameStateResponse, id: number) => company(state, id).carcosan_trains ?? [];
const copiesOf = (list: readonly string[], model: string) => list.filter((entry) => entry === model).length;
/** Ordinary (not gold-trimmed) copies of `model` in `id`'s fleet. */
const ordinary = (state: GameStateResponse, id: number, model: string) => copiesOf(fleet(state, id), model) - copiesOf(gilded(state, id), model);
const turnIs = (state: GameStateResponse, macro: number, sub: number) => state.macro_round_number === macro && state.sub_round_index === sub;
const phaseOf = (state: GameStateResponse) => derivePhase(state)?.tier ?? null;
const headTier = (state: GameStateResponse) => depotInventory(state).find((row) => row.remaining === null || (row.remaining ?? 0) > 0)?.tier ?? null;
/** Whether `id` may take one more ordinary train (its countable fleet below the phase's limit). */
const hasSlot = (state: GameStateResponse, id: number) => {
  const c = company(state, id);
  return countableTrainCount(c.owned_trains, c.pending_rust_trains, c.carcosan_trains) < (derivePhase(state)?.trainLimit ?? 0);
};
const provenance = (state: GameStateResponse, id: number) => company(state, id).ghost_trains ?? [];
const poolProvenance = (state: GameStateResponse) =>
  (state as GameStateResponse & { returned_ghost_trains?: readonly string[] }).returned_ghost_trains ?? [];

/** The main path: the tie, the undo, the Mark on a Gentle Rust grace turn, the gift above the phase, the first real 6
 *  and the first real D (the doom trigger), and C&O's ordinary 6 beside its gold-trimmed one. Tail A is this script
 *  played on to the fog. */
export const MAIN_EVENTS: readonly ScriptEvent[] = [
  // ---- OR 3.1: a refused run pins nothing; the tie; an undo reuses the draw; the tie again; paid out.
  { corp: CO, at: "Routes", when: (s) => turnIs(s, 3, 1), steps: [step("C&O's shortfall run is refused", P1, RUN(CO, [SHORTFALL], ["2"], [0]), "refused")] },
  { corp: CO, at: "Dividends", when: (s) => turnIs(s, 3, 1), steps: [step("C&O undoes its run", P1, REVERT_LAST_RUN)] },
  {
    corp: CO,
    at: "Routes",
    when: (s, done) => turnIs(s, 3, 1) && done.has("C&O undoes its run"),
    steps: [step("C&O runs the same turn again", P1, RUN(CO, [GULF_SHORT], ["2"], [0]))],
  },
  // The FIRST 4, bought by C&O itself: a Gentle Rust self-trigger -- every 2-train marked, C&O's own included.
  { corp: CO, at: "Hardware", when: (s) => turnIs(s, 3, 1), steps: [step("C&O buys the FIRST 4", P1, BUY(CO))] },
  // ---- OR 3.2: two rivals buy 4s; C&O's grace turn is the Mark -- the run's own consequence: no client may add,
  // repeat or redirect a stage (OD-UR-1); C&O, trainless, must buy a 4.
  {
    corp: CO,
    at: "Dividends",
    when: (s) => turnIs(s, 3, 2),
    steps: [
      step("a client's Yellow Sign request for C&O is refused", P1, SIGN(CO), "refused"),
      step("a client's Yellow Sign request aimed at B&O is refused", P3, SIGN(BO), "refused"),
      step("a forced Yellow Sign request is refused", P1, SIGN(CO, { debug_force: true }), "refused"),
    ],
  },
  { corp: PRR, at: "Hardware", when: (s) => phaseOf(s) === "4" && headTier(s) === "4", steps: [step("PRR buys a 4", P1, BUY(PRR))] },
  { corp: CPR, at: "Hardware", when: (s) => phaseOf(s) === "4" && headTier(s) === "4", steps: [step("CPR buys a 4", P3, BUY(CPR))] },
  {
    corp: CO,
    at: "Hardware",
    when: (s) => turnIs(s, 3, 2) && fleet(s, CO).length === 0,
    steps: [
      // Trainless with a route: the ordinary obligation stands (UR-N34) -- the turn may not end without a train.
      step("C&O, trainless after the Mark, may not end its turn", P1, PASS, "refused"),
      step("C&O, trainless after the Mark, buys a 4", P1, BUY(CO)),
    ],
  },
  // ---- Set 4: the first 5 (the brown era); the other two 5s; then the Carcosa gift on C&O's run (above the phase).
  {
    corp: NYC,
    at: "Hardware",
    when: (s) => (s.macro_round_number ?? 0) >= 4 && phaseOf(s) === "4" && headTier(s) === "5",
    steps: [step("NYC buys the FIRST 5", P2, BUY(NYC))],
  },
  { corp: CO, at: "Hardware", when: (s) => phaseOf(s) === "5" && headTier(s) === "5" && ordinary(s, CO, "5") === 0, steps: [step("C&O buys a 5", P1, BUY(CO))] },
  { corp: BO, at: "Hardware", when: (s) => phaseOf(s) === "5" && headTier(s) === "5" && ordinary(s, BO, "5") === 0, steps: [step("B&O buys a 5", P3, BUY(BO))] },
  // ---- Set 5 (set N): the first REAL 6 -- after the gift -- and the first REAL D, the doom trigger.
  {
    corp: ERIE,
    at: "Hardware",
    when: (s) => (s.macro_round_number ?? 0) >= 5 && phaseOf(s) === "5" && gilded(s, CO).length > 0,
    steps: [step("ERIE buys the FIRST real 6", P2, BUY(ERIE))],
  },
  {
    corp: PRR,
    at: "Hardware",
    when: (s) => phaseOf(s) === "6" && hasSlot(s, PRR),
    steps: [step("PRR buys the FIRST real D", P1, BUY(PRR, "D"))],
  },
  {
    corp: CO,
    at: "Hardware",
    when: (s) => phaseOf(s) === "D" && ordinary(s, CO, "6") === 0 && gilded(s, CO).length > 0 && hasSlot(s, CO) && headTier(s) === "6",
    // Three trains at limit 2 and no discard owed: the gold-trimmed copy occupies no slot, the other two fill it -- the room
    // ends C&O's Buy Trains at the limit (read by the test).
    steps: [step("C&O buys the last real 6", P1, BUY(CO, "6"))],
  },
];

/** Tail B -- the Blood Price. The same game as the main path until B&O's first Buy Trains at which C&O holds a
 *  gold-trimmed AND an ordinary 6 and B&O has a slot; then the buyer's lifecycle, through the old deadline. */
export const TAIL_B_EVENTS: readonly ScriptEvent[] = [
  {
    corp: BO,
    at: "Hardware",
    when: (s) => gilded(s, CO).includes("6") && ordinary(s, CO, "6") > 0 && hasSlot(s, BO),
    steps: [
      // The seller holds both copies of the model: an offer that names neither is ambiguous and refused (OD-UR-5(c)).
      step("B&O offers for C&O's 6 without naming the copy -- refused", P3, PROPOSE(CO, BO, "6", 300), "refused"),
      step("B&O offers for C&O's GOLD-TRIMMED 6", P3, PROPOSE(CO, BO, "6", 300, true)),
      step("C&O accepts: the Blood Price", P1, ANSWER(CO, true)),
    ],
  },
  {
    // The cured train is ordinary: it counts against B&O's limit (5 + 6 at limit 2), so the Depot sells B&O nothing more.
    // (The room keeps B&O's Buy Trains open: at the limit a Diesel exchange is still possible, DT-1.)
    corp: BO,
    at: "Hardware",
    when: (s, done) => done.has("C&O accepts: the Blood Price") && provenance(s, BO).includes("6"),
    steps: [step("B&O, at its limit with the cured 6, may buy no Diesel from the Depot", P3, BUY(BO, "D"), "refused")],
  },
  {
    corp: BO,
    at: "Hardware",
    when: (s, done) =>
      done.has("C&O accepts: the Blood Price") &&
      provenance(s, BO).includes("6") &&
      (company(s, BO).last_run_breakdown ?? []).some((row) => row.model === "6"),
    steps: [step("B&O trades the cured 6 in for a Diesel", P3, EXCHANGE(BO, "6"))],
  },
  {
    corp: CPR,
    at: "Hardware",
    when: (s) => poolProvenance(s).includes("6") && hasSlot(s, CPR),
    steps: [step("CPR buys the cured 6 from the Bank Pool", P3, BUY_POOL(CPR, "6"))],
  },
  {
    corp: ERIE,
    at: "Hardware",
    when: (s) => provenance(s, CPR).includes("6") && hasSlot(s, ERIE),
    steps: [
      step("ERIE offers for CPR's 6 -- an ordinary sale", P2, PROPOSE(CPR, ERIE, "6", 200)),
      step("CPR accepts", P3, ANSWER(CPR, true)),
    ],
  },
];

/** Which script a run plays. */
export type Tail = "A" | "B";
export const eventsFor = (tail: Tail): readonly ScriptEvent[] => (tail === "B" ? [...MAIN_EVENTS, ...TAIL_B_EVENTS] : MAIN_EVENTS);

/** C&O's run for the fleet it holds -- the authority's best total on the network, which S6-3 demands. */
export function coRun(state: GameStateResponse): { routes: Route[]; trains: string[]; indices: number[] } {
  const f = fleet(state, CO);
  const at = (model: string) => f.indexOf(model);
  if (f.length === 1 && f[0] === "2") return { routes: [GULF_SHORT], trains: ["2"], indices: [0] };
  if (at("2") >= 0 && at("4") >= 0) return { routes: [GULF_SHORT, LINE], trains: ["2", "4"], indices: [at("2"), at("4")] };
  if (f.length === 1 && f[0] === "4") return { routes: [LONG], trains: ["4"], indices: [0] };
  if (at("4") >= 0 && at("5") >= 0 && at("6") < 0) return { routes: [GULF_SHORT, LINE], trains: ["4", "5"], indices: [at("4"), at("5")] };
  if (at("5") >= 0 && at("6") >= 0) return { routes: [GULF_SHORT, LINE], trains: ["5", "6"], indices: [at("5"), at("6")] };
  throw new Error(`C&O has no scripted run for [${f.join(", ")}]`);
}

/** B&O's run: its one route, with a 6 when it holds one (tail B's cured train), else the first train that reaches three
 *  cities (a 2-train cannot). */
export function boRun(state: GameStateResponse): { routes: Route[]; trains: string[]; indices: number[] } | null {
  const f = fleet(state, BO);
  const six = f.indexOf("6");
  const at = six >= 0 ? six : f.findIndex((model) => model !== "2");
  if (at < 0) return null;
  return { routes: [BO_LINE], trains: [f[at]], indices: [at] };
}

/** C&O pays out its tie (the paid cash pinned) and withholds the rest (its purchases need the cash); B&O pays out every
 *  turn, which keeps its marker off the chart's left edge -- where the Blood Price's Left 1 / Down 1 reads in its ordinary
 *  form (at the edge a Left becomes a Down). */
const paysOut = (state: GameStateResponse, corp: number) => (corp === CO && turnIs(state, 3, 1)) || corp === BO;

/* ------------------------------------------------------------------ */
/* The driver                                                          */
/* ------------------------------------------------------------------ */

export interface Played {
  step: ScriptStep;
  kind: string;
  reason: string | null;
  /** Every entry the submission appended (its own and the derived ones), as `Kind` / `Kind*`. */
  entries: string[];
  indices: number[];
  before: GameStateResponse;
  after: GameStateResponse;
}

export interface CertificationRun {
  room: RoomSession;
  played: Played[];
  /** The server's draws, in order. */
  draws: Draw[];
  at: (label: string) => GameStateResponse;
  before: (label: string) => GameStateResponse;
  find: (label: string) => Played;
}

export const BUILD = "ur7";

export const operatingCorp = (state: GameStateResponse): number | null =>
  state.current_round_type === "OperatingRound" ? (state.active_operating_order[state.active_corporation_index] ?? null) : null;


/** A room over the starting board. Its draws come from `nextDraw`, which the driver sets from `drawStage` before each
 *  run it submits; a draw the driver did not arm THROWS -- the server may draw nowhere the script did not plan -- and a
 *  run whose turn already rolled (an undo's re-run, #1051) draws nothing and leaves the armed draw unused. */
export function certificationRoom(seed: GameStateResponse, onDraw: () => number): RoomSession {
  let minted = 0;
  return new RoomSession({
    providers: roomProviders(seed, NETWORK),
    seed: { state: seed, waterfall: null },
    build: BUILD,
    mintId: () => `ur7-${(minted += 1)}`,
    now: () => 0,
    mintSeed: onDraw,
  });
}

/** The printed total a run scores on `state`: the same message on the same board with the die off, so no stage can
 *  touch the figure (Gentle Rust's settlement changes the fleet, never the run's revenue). */
export function printedOf(state: GameStateResponse, msg: Msg): number {
  const off = { ...state, variants: { ...resolveVariants(state.variants), unpredictableRevenue: false } } as GameStateResponse;
  const ctx = sandboxActionContext(sandboxReplayProviders(), { state: off, msg, actor: null, grid: NETWORK, gridBefore: NETWORK });
  const after = applySandboxAction(off, msg as never, ctx);
  const c = after.public_companies.find((entry) => entry.company_id === Number((msg as { RunMultipleRoutes: { protocol_id: number } }).RunMultipleRoutes.protocol_id))!;
  return Number(c.last_route_revenue ?? 0);
}

export interface PlayOptions {
  tail?: Tail;
  start?: StartOptions;
  /** Stop BEFORE the first board this answers true for. */
  stop: (state: GameStateResponse) => boolean;
  limit?: number;
}

/** Plays the certification game through one room until `stop`. Throws (with the step's label) when the room's answer
 *  differs from the script's expectation. */
export function playCertificationGame(options: PlayOptions): CertificationRun {
  const events = eventsFor(options.tail ?? "A");
  const draws: Draw[] = [];
  let armed: Draw | null = null;
  const room = certificationRoom(certificationStart(options.start), () => {
    if (armed === null) throw new Error("the server drew where the script armed no draw");
    const draw: Draw = armed;
    armed = null;
    draws.push(draw);
    return draw.seed;
  });
  const played: Played[] = [];
  const done = new Set<string>();

  const submit = (s: ScriptStep) => {
    const before = room.state;
    let msg = s.msg;
    armed = null;
    if ("RunMultipleRoutes" in (msg as object)) {
      // Arm the draw this run owes: the stage the script needs, on the printed total the run will score.
      const corp = Number((msg as { RunMultipleRoutes: { protocol_id: number } }).RunMultipleRoutes.protocol_id);
      const macro = before.macro_round_number ?? 0;
      const subRound = before.sub_round_index ?? 0;
      const printed = printedOf(before, msg);
      const stage = drawStage(before, corp);
      const planned: PlannedDraw = { macro, sub: subRound, corp, printed, stage };
      // A quiet draw's search starts at an offset from its turn, so quiet runs meet every non-stage face (not only the
      // first one from 1); a stage's search starts at 1.
      const from = stage === "quiet" ? 1 + ((macro * 7 + subRound * 3 + corp) % 6) : 1;
      armed = { ...planned, turn: drawKey(macro, subRound, corp), seed: seedWhere((seed) => drawReaches(planned, seed), from) };
    }
    if (msg === REVERT_LAST_RUN) {
      const lastRun = [...room.entries].reverse().find((entry) => "RunMultipleRoutes" in JSON.parse(entry.payload));
      if (!lastRun) throw new Error(`${s.label}: no run to undo`);
      msg = REVERT(lastRun.index, s.actor);
    }
    const response = room.submit({ actor: s.actor, build: BUILD, host: P1, msg, baseIndex: room.nextIndex - 1 }) as {
      kind: string;
      reason?: string;
      entries?: ServerLogEntry[];
    };
    const kind = response.kind === "applied" ? "applied" : response.kind;
    if (kind !== s.expect) {
      const error = new Error(
        `${s.label}: expected ${s.expect}, the room answered ${response.kind}${response.reason ? ` (${response.reason})` : ""}` +
          ` at ${before.current_round_type} ${before.macro_round_number}.${before.sub_round_index} ${TICKER[operatingCorp(before) ?? 0] ?? "-"} @ ${before.operating_sub_phase}`,
      );
      (error as Error & { played?: Played[] }).played = played;
      throw error;
    }
    done.add(s.label);
    played.push({
      step: { ...s, msg },
      kind,
      reason: response.reason ?? null,
      entries: (response.entries ?? []).map((entry) => `${Object.keys(JSON.parse(entry.payload))[0]}${entry.derived ? "*" : ""}`),
      indices: (response.entries ?? []).map((entry) => entry.index),
      before,
      after: room.state,
    });
  };
  /** The next unsent step of the first event that applies here, if any. */
  const scripted = (state: GameStateResponse, corp: number, at: Sub): ScriptStep | null => {
    for (const event of events) {
      if (event.corp !== corp || event.at !== at) continue;
      const next = event.steps.find((s) => !done.has(s.label));
      if (next && event.when(state, done)) return next;
    }
    return null;
  };

  const limit = options.limit ?? 2_000;
  for (let guard = 0; !options.stop(room.state); guard += 1) {
    if (guard > limit) throw new Error("the game did not reach its stop condition");
    const state = room.state;
    const tag = `${state.macro_round_number}.${state.sub_round_index}`;
    if (state.current_round_type === "StockRound") {
      submit(step(`SR ${state.macro_round_number} ${state.player_addresses[state.active_player_index]} passes (${guard})`, state.player_addresses[state.active_player_index], PASS));
      continue;
    }
    if (state.current_round_type !== "OperatingRound") throw new Error(`unexpected round ${state.current_round_type}`);
    const corp = operatingCorp(state)!;
    const president = company(state, corp).president!;
    const who = `${tag} ${TICKER[corp]}`;
    const sub = state.operating_sub_phase;
    if (sub === "Track" || sub === "Tokens") {
      submit(step(`${who} leaves ${sub === "Track" ? "Lay Track" : "Place Tokens"} (${guard})`, president, ADVANCE(corp)));
      continue;
    }
    if (sub !== "Routes" && sub !== "Dividends" && sub !== "Hardware") throw new Error(`${who}: unexpected step ${sub}`);
    const next = scripted(state, corp, sub);
    if (next) {
      submit(next);
      continue;
    }
    if (sub === "Routes") {
      const run = corp === CO ? coRun(state) : corp === BO ? boRun(state) : null;
      if (!run) throw new Error(`${who}: at Routes with no run`);
      const label = `${who} runs`;
      if (done.has(label)) throw new Error(`${who}: still at Routes after its run`);
      submit(step(label, president, RUN(corp, run.routes, run.trains, run.indices)));
      continue;
    }
    if (sub === "Dividends") {
      const paid = Number(company(state, corp).last_route_revenue ?? 0);
      const payout = paysOut(state, corp);
      submit(step(`${who} ${payout ? "pays out" : "withholds"} $${paid}`, president, DECLARE(corp, paid, payout)));
      continue;
    }
    submit(step(`${who} ends its turn (${guard})`, president, PASS));
  }

  const find = (label: string) => {
    const hit = played.find((entry) => entry.step.label === label);
    if (!hit) throw new Error(`no step labelled ${label}`);
    return hit;
  };
  return { room, played, draws, find, at: (label) => find(label).after, before: (label) => find(label).before };
}

/** A compact, comparable fingerprint of a run: every step's answer, entries and board digest. */
export const runFingerprint = (run: CertificationRun) =>
  run.played.map((entry) => [entry.step.label, entry.kind, entry.entries.join(" "), stateDigest(entry.after)]);

/** Stop conditions. */
export const atStockRound = (macro: number) => (state: GameStateResponse) =>
  state.current_round_type === "StockRound" && state.macro_round_number === macro;
