// frontend/src/tutorial/triggers.ts
//
/* ==================================================================
    PHASE 3 FINAL PLAY TUTORIAL: PLAY TRIGGERS (layer B of three)
   ==================================================================
   WHICH WITNESSED GAME STATE OR EVENT RAISES WHICH LESSON. Pure functions of the two boards an applied log entry
   moves between -- the same `before` / `after` pair every other one-shot in the shell already reads (the float
   ceremony, the Phase 3 edge, the payout phase). Nothing here keys on an Activity Log row id (those are local
   counters), and nothing here adds server state: every edge below is deterministic from the authoritative log.

   THE CALLER DECIDES WHETHER AN ENTRY WAS WITNESSED. `lessonsForTransition` is asked only for an entry applied as
   live play (`!replayingHistory`), never for a history catch-up, a reload's rebuild or an Undo's replay -- which is
   what keeps a late joiner, a new device or a reload from receiving a backlog (see `tutorialLedger.ts`).

   THREE KINDS OF TRIGGER:
     1. THE DEAL      the `SetupGame` entry: the orientation primer.
     2. EDGES         a change between the two boards: a round opening (its primer), a par value set, a float, a
                      sale, a presidency changing hands, a share price moving, a phase change, a rust.
     3. DECISIONS     the board AFTER the entry puts a choice in front of THIS viewer: their auction turn, their
                      Stock Round turn, their corporation reaching an Operating step. Taught at the decision rather
                      than after it. A decision lesson is RELEVANT only while that decision still stands
                      (`lessonRelevant`), so one held back by a mandatory notice is dropped -- not acknowledged --
                      if the moment passes, and is raised again the next time the decision comes round. */

import { actingAddress, type GameStateResponse } from "../gameEngine/gameState";
import { derivePhase } from "../gameEngine/gamePhase";
import type { LessonId } from "./lessons";

/** One raised lesson. `subject` is the corporation an event lesson is about (the coach highlights its market
 *  token), when there is one. */
export interface RaisedLesson {
  readonly id: LessonId;
  readonly subject?: number;
}

export interface TutorialTransition {
  /** The board before the entry; `null` before the first entry of a game. */
  readonly before: GameStateResponse | null;
  readonly after: GameStateResponse;
  /** The applied log message (a single-key object such as `{ BuyStock: {...} }`). */
  readonly msg: unknown;
  /** This seat's player id. Watchers are never asked. */
  readonly viewer: string;
}

/* The deal's orientation: two short cards. `orientation.money` deepens the cash / treasury split the first card
   states, and is in the library ("Getting Oriented"); the round primers repeat the split where it bites. */
const ORIENTATION: readonly LessonId[] = ["orientation.goal", "orientation.flow"];

function messageKind(msg: unknown): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  const keys = Object.keys(msg);
  return keys.length === 1 ? keys[0] : null;
}

/** The primer a round opens with. */
export function primerFor(round: GameStateResponse["current_round_type"] | null | undefined): LessonId | null {
  switch (round) {
    case "WaterfallAuction":
      return "auction.primer";
    case "StockRound":
      return "stock.primer";
    case "OperatingRound":
      return "operating.primer";
    default:
      return null;
  }
}

/** The corporation operating now, or `null`. */
export function operatingCompanyId(state: GameStateResponse): number | null {
  if (state.current_round_type !== "OperatingRound") return null;
  const id = state.active_operating_order?.[state.active_corporation_index];
  return typeof id === "number" ? id : null;
}

/** Whether `viewer` presides over the corporation operating now. */
export function viewerOperates(state: GameStateResponse, viewer: string): boolean {
  const id = operatingCompanyId(state);
  if (id === null || !viewer) return false;
  return state.public_companies.some((company) => company.company_id === id && company.president === viewer);
}

/** Whether the board is waiting on `viewer` for an auction or Stock Round move. */
function viewerActs(state: GameStateResponse, viewer: string): boolean {
  if (!viewer) return false;
  return actingAddress(state, state.waterfall ?? null) === viewer;
}

const STEP_LESSON: Readonly<Record<string, LessonId>> = {
  Track: "operating.track",
  Tokens: "operating.tokens",
  Routes: "operating.routes",
  Dividends: "operating.dividends",
  Hardware: "operating.trains",
};

function ownsTrain(state: GameStateResponse, companyId: number | null): boolean {
  if (companyId === null) return false;
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  return (company?.owned_trains?.length ?? 0) > 0;
}

/** The decision lessons the board puts in front of `viewer` right now, in the order they are needed. */
export function decisionLessons(state: GameStateResponse, viewer: string): LessonId[] {
  switch (state.current_round_type) {
    case "WaterfallAuction":
      return viewerActs(state, viewer) && !state.waterfall?.mini_auction ? ["auction.choices"] : [];
    case "StockRound": {
      if (!viewerActs(state, viewer)) return [];
      const unparred = state.public_companies.some((company) => company.par_value === null || company.par_value === undefined);
      return unparred ? ["stock.turn", "stock.par"] : ["stock.turn"];
    }
    case "OperatingRound": {
      if (!viewerOperates(state, viewer)) return [];
      const step = state.operating_sub_phase;
      if (!step) return [];
      const lesson = STEP_LESSON[step];
      if (!lesson) return [];
      /* A corporation with no train is skipped past Run Routes and has its $0 withhold declared for it: nothing to
         decide at either step, so nothing to teach there. */
      if ((lesson === "operating.routes" || lesson === "operating.dividends") && !ownsTrain(state, operatingCompanyId(state))) {
        return [];
      }
      return [lesson];
    }
    default:
      return [];
  }
}

function priceOf(state: GameStateResponse | null, companyId: number): number | null {
  const mark = state?.market_positions?.[companyId];
  return mark ? Number(mark.price) : null;
}

function trainCount(state: GameStateResponse): number {
  return state.public_companies.reduce((sum, company) => sum + (company.owned_trains?.length ?? 0), 0);
}

/** The event lessons the step from `before` to `after` raises. */
export function eventLessons(before: GameStateResponse, after: GameStateResponse, msg: unknown): RaisedLesson[] {
  const raised: RaisedLesson[] = [];
  const kind = messageKind(msg);

  /* The auction: a contest opening, or a purchase that settled more than one company, is the cascade. */
  const privatesBefore = before.waterfall?.privates?.length ?? 0;
  const privatesAfter = after.waterfall?.privates?.length ?? 0;
  /* Both boards must carry the auction: the round closing (its atom cleared) is not a cascade. */
  const auctionOnBoth = Boolean(before.waterfall) && Boolean(after.waterfall);
  if (
    auctionOnBoth &&
    ((!before.waterfall?.mini_auction && after.waterfall?.mini_auction) || privatesBefore - privatesAfter >= 2)
  ) {
    raised.push({ id: "auction.cascade" });
  }
  /* Every player passed in a row: the reducer settles the round of passes and resets the count. */
  if (
    kind === "WaterfallPass" &&
    (before.waterfall?.consecutive_waterfall_passes ?? 0) > 0 &&
    after.waterfall?.consecutive_waterfall_passes === 0 &&
    privatesAfter === privatesBefore
  ) {
    raised.push({ id: "auction.allPass" });
  }

  const priorById = new Map(before.public_companies.map((company) => [company.company_id, company]));
  for (const company of after.public_companies) {
    const prior = priorById.get(company.company_id);
    if (!prior) continue;
    if ((prior.par_value === null || prior.par_value === undefined) && company.par_value) {
      raised.push({ id: "stock.par", subject: company.company_id });
    }
    if (!prior.is_floated && company.is_floated) raised.push({ id: "stock.float", subject: company.company_id });
    if (prior.president && company.president && prior.president !== company.president) {
      raised.push({ id: "stock.presidency", subject: company.company_id });
    }
  }

  if (kind === "SellStock" && before !== after) raised.push({ id: "stock.selling" });
  if (kind === "PassTurn" && before.current_round_type === "StockRound") raised.push({ id: "stock.passing" });

  /* A share price moved. The first corporation to withhold with no train to run is the first-turn lesson. */
  const companies = new Set<number>([
    ...Object.keys(before.market_positions ?? {}).map(Number),
    ...Object.keys(after.market_positions ?? {}).map(Number),
  ]);
  for (const companyId of Array.from(companies).sort((a, b) => a - b)) {
    const from = priceOf(before, companyId);
    const to = priceOf(after, companyId);
    if (from === null || to === null || from === to) continue;
    /* A trainless corporation's forced withhold is taught by its own lesson rather than the general one, so one move
       is never two back-to-back cards. */
    if (
      to < from &&
      before.current_round_type === "OperatingRound" &&
      operatingCompanyId(before) === companyId &&
      kind !== "SellStock" &&
      !ownsTrain(after, companyId) &&
      !ownsTrain(before, companyId)
    ) {
      raised.push({ id: "market.firstWithhold", subject: companyId });
    } else {
      raised.push({ id: "market.moves", subject: companyId });
    }
  }

  /* A phase change, and the trains it rusted. */
  const phaseBefore = derivePhase(before);
  const phaseAfter = derivePhase(after);
  if (phaseBefore?.known && phaseAfter?.known && phaseBefore.tier !== phaseAfter.tier) {
    raised.push({ id: "trains.phases" });
    if (trainCount(after) < trainCount(before)) raised.push({ id: "trains.rust" });
  }
  return raised;
}

/** Every lesson a WITNESSED log entry raises for one seated viewer, in teaching order: the orientation (at the
 *  deal), the primer of a round that just opened, what just happened, then the decision now in front of them. */
export function lessonsForTransition({ before, after, msg, viewer }: TutorialTransition): RaisedLesson[] {
  const raised: RaisedLesson[] = [];
  const kind = messageKind(msg);
  if (kind === "SetupGame") {
    /* The deal: orientation, then the primer of the round the game opens on (the auction; a Delayed Auction
       table opens on a Stock Round). The seeded board before it is not a game yet, so nothing is diffed. */
    for (const id of ORIENTATION) raised.push({ id });
    const primer = primerFor(after.current_round_type);
    if (primer) raised.push({ id: primer });
  } else if (before) {
    if (before.current_round_type === "StockRound" && after.current_round_type !== "StockRound") {
      raised.push({ id: "stock.roundEnd" });
    }
    if (before.current_round_type !== after.current_round_type) {
      const primer = primerFor(after.current_round_type);
      if (primer) raised.push({ id: primer });
    }
    raised.push(...eventLessons(before, after, msg));
  }
  for (const id of decisionLessons(after, viewer)) raised.push({ id });

  const seen = new Set<string>();
  return raised.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/** Lessons a seated player is taught in the waiting room, from the room's own terms (not the log): what an ante
 *  is on a money table, and what the table's pace means. Asked only before the deal. */
export function waitingRoomLessons(input: { money: boolean; clocked: boolean }): LessonId[] {
  const lessons: LessonId[] = [];
  if (input.money) lessons.push("money.ante");
  if (input.clocked) lessons.push("pace.modes");
  return lessons;
}

/** Every lesson a trigger in this file can raise -- for the registry test that each one is a real lesson. */
export const TRIGGERED_LESSONS: readonly LessonId[] = [
  ...ORIENTATION,
  "auction.primer",
  "stock.primer",
  "operating.primer",
  ...Object.values(STEP_LESSON),
  "auction.choices",
  "stock.turn",
  "stock.par",
  "auction.cascade",
  "auction.allPass",
  "stock.float",
  "stock.presidency",
  "stock.selling",
  "stock.passing",
  "stock.roundEnd",
  "market.moves",
  "market.firstWithhold",
  "trains.phases",
  "trains.rust",
  "money.ante",
  "pace.modes",
];

export const DECISION_LESSONS: ReadonlySet<string> = new Set<LessonId>([
  "auction.choices",
  "stock.turn",
  "stock.par",
  "operating.track",
  "operating.tokens",
  "operating.routes",
  "operating.dividends",
  "operating.trains",
]);

const PRIMER_ROUND: Readonly<Record<string, GameStateResponse["current_round_type"]>> = {
  "auction.primer": "WaterfallAuction",
  "stock.primer": "StockRound",
  "operating.primer": "OperatingRound",
};

/** Relevance cannot be judged yet: the board on screen is not a dealt game (the waiting room's seed, or a reload's
 *  seed before its catch-up has drained). Hold the lesson; do not withdraw it. */
export const RELEVANCE_UNKNOWN = "unknown" as const;
export type Relevance = boolean | typeof RELEVANCE_UNKNOWN;

/** Whether the board on screen is a dealt game. The seed every table starts from has no roster. */
export function boardDealt(state: GameStateResponse | null): state is GameStateResponse {
  return state !== null && state.player_addresses.length > 0;
}

/** Whether a raised lesson still belongs on screen. A decision lesson needs its decision to still stand; a round
 *  primer needs its round; the waiting room's lessons belong before the deal. The orientation and an event that
 *  happened stay relevant. Before the board is dealt (the waiting room, or a reload still catching up) every
 *  board-dependent lesson is UNKNOWN: held, never withdrawn -- withdrawing against a seed board would throw away a
 *  reload's pending lessons. */
export function lessonRelevant(entry: RaisedLesson | string, state: GameStateResponse | null, viewer: string): Relevance {
  const id = typeof entry === "string" ? entry : entry.id;
  const subject = typeof entry === "string" ? undefined : entry.subject;
  if (id.startsWith("orientation.")) return true;
  if (id === "money.ante" || id === "pace.modes") return !boardDealt(state);
  if (!boardDealt(state)) return RELEVANCE_UNKNOWN;
  /* A par value somebody else just set is an event, not this viewer's decision. */
  if (id === "stock.par" && subject !== undefined) return true;
  if (DECISION_LESSONS.has(id)) {
    if (id === "stock.par") return decisionLessons(state, viewer).includes("stock.turn");
    return decisionLessons(state, viewer).includes(id as LessonId);
  }
  const round = PRIMER_ROUND[id];
  if (round) return state.current_round_type === round;
  return true;
}
