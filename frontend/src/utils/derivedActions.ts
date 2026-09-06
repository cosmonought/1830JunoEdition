// frontend/src/utils/derivedActions.ts
//
// The actions the GAME sends, rather than a player.
//
// ==================================================================
//  DESIGN NOTE 1202: THE DERIVED ACTIONS COME OFF THE SHELL
// ==================================================================
//
// PHASE 2, STEP 2. `App.tsx` decides when the game should act on a player's behalf -- skip a step nothing can
// be done on, withhold $0 for a corporation that cannot earn, end a turn that has run out of steps -- and
// then DISPATCHES that decision as a logged action. A server has to make the same decision, because a server
// has no shell to make it.
//
// AND THE LIFT IS SMALLER THAN IT LOOKED. Every piece of judgement was already in a pure module:
// `earnableRevenueVerdict` and `skipReasonFor` (`earnableRevenue.ts`), `assignRouteSet` (`routeAutoTrace.ts`),
// `stationPlacementBlockReason` (`stationTokens.ts`), `isTrainLocked` (`trainLimit.ts`), `autoSkipExit`
// (`autoSkipExit.ts`), `stepsFor` (`operatingCursor.ts`). None of them imports React. What lived in the shell
// was ARGUMENT ASSEMBLY and memoisation -- which is why this file is mostly a switch and a few `find`s.
//
// THREE THINGS CHANGE IN THE MOVE, and they are the interesting part.
//
//   THE SPECTATOR GUARD IS GONE. `autoSkipReason` returned `null` for a spectator, which is a statement about
//   how somebody is WATCHING and not about the board. A server computes the board's answer; there is nobody
//   watching it.
//
//   #774's OWNERSHIP CHECK IS GONE, AND ITS PROBLEM WITH IT. The shell needed `isMyTurn` because every seated
//   browser reached the same conclusion from the same shared state and each appended its own copy -- "a share
//   price that moved two cells left rather than one". One writer cannot race itself. What survives is the
//   IDEMPOTENCY half: the caller passes the keys it has already emitted, because a server restarted mid-turn,
//   or one rebuilding from a log, must not re-send what the log already holds.
//
//   THE KEY IS LOG-DERIVED AND ALWAYS WAS. `turnGuardKey` is built from `macro_round_number`,
//   `sub_round_index` and `active_corporation_index` -- its own note says a replay "rebuilds state and
//   therefore the same key, where a parallel local tally could disagree with the log it is supposed to
//   describe". So the guard survives a restart for free, which is exactly what a server needs.
//
// ONE INPUT IS NOT LOG-DERIVED, AND IT IS NOT THIS FILE'S TO FIX.
//
//   `stationPlacementBlockReason` asks whether the D&H's free station is still available, and `App.tsx`
//   answers from `usedPrivateAbilities` -- a `useState<Set<string>>` in the shell. That is a fact ONE BROWSER
//   KNOWS, which is precisely what #1044 forbids in as many words: "anything not derivable from that log is a
//   fact one browser knows and the others do not". A player who reloads loses it; a player who joins late
//   never had it.
//
//   SO IT ARRIVES AS A PARAMETER AND DEFAULTS TO "STILL AVAILABLE". Guessing "spent" would auto-skip the
//   Tokens step for a corporation whose only legal placement is the D&H's, taking a player's turn away --
//   and #414 settled which of those two mistakes is the worse one. Recorded here so the gap is visible;
//   putting the ability's spent-ness on the board is its own change, and it belongs with the audit rather
//   than inside a lift-and-shift.

import type { GameStateResponse } from "./gameState";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { OperatingSubPhase } from "../components/OperatingSubPhaseStepper";

import { autoSkipExit } from "./autoSkipExit";
import { earnableRevenueVerdict, skipReasonFor } from "./earnableRevenue";
import { operatingCorporationId } from "./dividendGate";
import { stepsFor } from "./operatingCursor";
import { turnGuardKey } from "./turnGuardKey";
import { countableTrainCount, isTrainLocked } from "./trainLimit";
import { citySlotCount, stationPlacementBlockReason } from "./stationTokens";
import { stationTokensOf } from "./trackReach";
import { reachForDrafting } from "./trainReach";
import { assignRouteSet } from "./routeAutoTrace";
import { cityBlockerFor } from "./cityBlocking";
import { MOCK_TRAIN_CATALOG } from "./mockFixtures";
import { ERA_FOR_PHASE_TINT } from "./gameConstants";
import { depotInventory, derivePhase } from "./gamePhase";
import { tokenCityIndex } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";

/** One action the game sends on a corporation's behalf. */
export interface DerivedAction {
  /** The message to append to the log, exactly as a player's would be. */
  msg: GameplayExecuteMsg;
  /** `turnGuardKey(state, corporation, step)` -- the unit of idempotency, and log-derived. */
  key: string;
  /** Why, for the caller's log line. #1057: a step where nothing happened earns no line, but an auto-withheld
   *  dividend MOVES THE SHARE PRICE, so that one still prints. The dividing line is the consequence. */
  reason: string;
  kind: "skip" | "end-turn" | "forced-withhold";
}

export interface DerivedActionInput {
  state: GameStateResponse;
  mapGrid: MapGridResponse;
  /** Keys already emitted. A server restarted mid-turn, or rebuilding from a log, must not re-send. */
  emitted: ReadonlySet<string>;
  /** See the header: the D&H's free station is not on the board yet. Defaults to "still available", which is
   *  the mistake that costs a click rather than the one that costs a turn. */
  extraStationAvailable?: boolean;
}

/** The next action the game owes, or `null` when it owes none.
 *
 *  ONE AT A TIME, BY DESIGN. Applying a skip changes the step, which may make the next step skippable too --
 *  a trainless corporation walks Routes, then Dividends, then out of its turn. A caller loops until this
 *  returns `null`, and each answer is computed against the board the previous one produced. Returning a list
 *  would mean deciding the second answer against a board that does not exist yet, which is #766's
 *  "a snapshot, not a reorder" in a different costume. */
export function nextDerivedAction(input: DerivedActionInput): DerivedAction | null {
  const { state, mapGrid, emitted, extraStationAvailable = true } = input;

  if (state.current_round_type !== "OperatingRound") return null;

  const protocolId = operatingCorporationId(state);
  if (protocolId === null) return null;

  const step = state.operating_sub_phase ?? null;
  /* #232 AND `dividendGate`'s RULE, matched deliberately: an unknown cursor is allowed through rather than
     acted on. Emitting a skip against a step nobody can name would move a board on the strength of a missing
     field. */
  if (step === null) return null;

  const company = state.public_companies.find((entry) => entry.company_id === protocolId);
  if (!company) return null;

  const key = turnGuardKey(state, protocolId, step);
  if (emitted.has(key)) return null;

  /* #414: LAZY, because three of the guards inside settle the question without a pathfinder run and that
     search is the expensive part. On a server this runs once per turn rather than once per render, which is
     the same computation arriving far less often. */
  const earnable = earnableRevenueVerdict({
    ownedTrains: company.owned_trains,
    stationTokenCount: company.station_token_hexes?.length,
    mapGrid,
    searchRevenue: () => maxRouteRevenueFor(state, company.company_id, mapGrid),
  });
  const noEarnableRevenue = skipReasonFor(earnable);

  /* #292/#414: A TRAINLESS CORPORATION DECLARES $0 WITHHELD RATHER THAN SKIPPING. 1830 has no third option,
     and the declaration is what steps the marker left -- so this is an action with a consequence, not an
     absence of one, and it is checked before the skip below. */
  if (step === "Dividends" && noEarnableRevenue !== null) {
    return {
      msg: {
        DeclareDividends: {
          game_id: 0,
          protocol_id: protocolId,
          revenue_amount: "0",
          distribute: false,
        },
      } as GameplayExecuteMsg,
      key,
      reason: noEarnableRevenue,
      kind: "forced-withhold",
    };
  }

  const skipReason = autoSkipReasonFor({
    step,
    noEarnableRevenue,
    state,
    company,
    mapGrid,
    protocolId,
    extraStationAvailable,
  });
  if (skipReason === null) return null;

  /* #876: SKIPPING THE LAST STEP IS ENDING THE TURN. `nextSubPhase` returns `current` at the end of the list
     (#656), so an advance there moves nothing and the guard above marks the turn handled -- a log line
     claiming a skip that never happened, and a turn that will not end. The predicate is a POSITION rather
     than a name, because `stepsFor` varies. */
  const exit = autoSkipExit(step, stepsFor(state));
  return exit === "end-turn"
    ? {
        msg: { PassTurn: { game_id: 0 } } as GameplayExecuteMsg,
        key,
        reason: skipReason,
        kind: "end-turn",
      }
    : {
        msg: {
          AdvanceOperatingSubPhase: { game_id: 0, protocol_id: protocolId },
        } as GameplayExecuteMsg,
        key,
        reason: skipReason,
        kind: "skip",
      };
}

/** `autoSkipReason`, transcribed from `App.tsx` minus the spectator guard.
 *
 *  THE ORDER OF THE BRANCHES IS LOAD-BEARING and is kept exactly. `Dividends` returns `null` when there is no
 *  earnable revenue because the FORCED WITHHOLD above has already claimed that case -- reversing the two
 *  would skip the step whose whole job is to move the share price. */
function autoSkipReasonFor(input: {
  step: OperatingSubPhase;
  noEarnableRevenue: string | null;
  state: GameStateResponse;
  company: GameStateResponse["public_companies"][number];
  mapGrid: MapGridResponse;
  protocolId: number;
  extraStationAvailable: boolean;
}): string | null {
  const { step, noEarnableRevenue, state, company, mapGrid, extraStationAvailable } = input;

  /* #414: was `ownsAnyTrain ? null : ...`. A corporation with a train and no reachable revenue was held on a
     step whose only control drafts a route that cannot exist. */
  if (step === "Routes") return noEarnableRevenue;

  if (step === "Tokens") {
    return stationPlacementBlockReason({
      mapGrid,
      company,
      allCompanies: state.public_companies,
      boardHexes: STATIC_BOARD_HEXES.map((hex) => [hex.q, hex.r] as const),
      // See the file header: not log-derived yet, so the caller decides and the default does not skip.
      extraTokenAvailable: extraStationAvailable,
    });
  }

  if (step === "Dividends" && noEarnableRevenue !== null) return null;

  if (step === "Hardware") {
    /* #703/#1034: through the shared rule and on the COUNTABLE fleet, so this gate and
       `trainPurchaseRefusal` answer with one number. They disagreed once, and the corporation the skip let
       through was refused by the panel it was sent to. */
    const owned = company.owned_trains?.length;
    // An unknown fleet is never treated as full: skipping on a guess takes the player's turn away.
    if (owned === undefined) return null;
    const locked = isTrainLocked(
      countableTrainCount(company.owned_trains, company.pending_rust_trains, company.ghost_trains),
      depotInventory(state).find((tier) => tier.isCurrent)?.trainLimit ?? null,
    );
    return locked ? "it is already at its train limit" : null;
  }

  return null;
}

/** The best revenue this corporation could run, or `null` for "could not tell".
 *
 *  DELIBERATELY A SEPARATE FUNCTION AND DELIBERATELY LAZY at its call site. `App.tsx` computes this as its
 *  own memo because it is the expensive part of every render on the Routes step; here it is a thunk that the
 *  three cheap guards inside `earnableRevenueVerdict` usually settle without calling.
 *
 *  `null` MEANS "COULD NOT TELL", NEVER ZERO (#414). A search that cannot answer must not be read as a
 *  corporation that cannot earn, because the consumer of that answer skips somebody's turn. */
export function maxRouteRevenueFor(
  state: GameStateResponse,
  companyId: number,
  mapGrid: MapGridResponse,
): number | null {
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  /* #484a: NO TOKEN IS A FACT, NOT AN ABSENCE OF ONE -- but a corporation the board does not describe at all
     is ignorance, and the two must not collapse. */
  if (!company) return null;

  /* AN ABSENT LIST IS CHECKED BEFORE THE READER, NOT AFTER IT -- and this is the one place this file
     deliberately differs from the memo it was lifted from. `App.tsx` calls `stationTokensOf` first and only
     then asks whether the field was there, but `stationTokensOf` maps over `station_token_hexes` without
     guarding it, so an absent list throws before the question is reached. In a browser that path is
     unreachable in practice; on a server it would take the room down for one malformed snapshot. Asked in
     the safe order here, and the shell's ordering is worth a look during the audit.
     #484a: NO TOKEN IS A FACT, NOT AN ABSENCE OF ONE. Absent means the board did not say -- `null`, "could
     not tell". Empty means it said "nowhere to start" -- `0`. #414 keeps those apart precisely because the
     consumer of this answer takes somebody's turn away. */
  if (!company.station_token_hexes) return null;

  /* #852: TOKENS, NOT HEXES. `station_token_hexes` drops the city index, and on New York that is the
     difference between NNH's own city and the disconnected one beside it. `stationTokensOf` is the same
     reader the network walk uses (#686), so the router and the veil agree about where a route may begin. */
  const startHexes = stationTokensOf(company);
  if (startHexes.length === 0) return 0;

  /* #275: the identity is the position in `owned_trains`, stable against the sort below. Unknown models sort
     last rather than first, which is where a `-1` from `findIndex` would otherwise put them. */
  const rank = (model: string) =>
    MOCK_TRAIN_CATALOG.findIndex((train) => train.modelType === model);
  const roster = (company.owned_trains ?? [])
    .map((model, ownedIndex) => ({
      trainIndex: ownedIndex,
      model,
      maxDistance: MOCK_TRAIN_CATALOG.find((train) => train.modelType === model)?.maxDistance,
    }))
    .sort(
      (a, b) => (rank(a.model) < 0 ? 99 : rank(a.model)) - (rank(b.model) < 0 ? 99 : rank(b.model)),
    );
  if (roster.length === 0) return 0;

  /* #730: a tokened-out city is a terminus, so no drafted route runs past one. Built here from the board
     rather than read from a ref, which is the whole difference between this file and the memo it was lifted
     from -- `blocksThroughCityRef` exists because a React callback closes over a stale render, and there are
     no renders here. */
  const blocksThrough = cityBlockerFor({
    actingCompanyId: companyId,
    companies: state.public_companies,
    slotsAt: (q: number, r: number, cityIndex: number) => citySlotCount(mapGrid, q, r, cityIndex),
    cityOf: (company_, q, r) => tokenCityIndex(company_ as never, q, r),
  });

  const result = assignRouteSet({
    blocksThrough,
    mapGrid,
    era: ERA_FOR_PHASE_TINT[derivePhase(state)?.tint ?? "yellow"],
    startHexes,
    trains: roster.map((train) => ({
      trainIndex: train.trainIndex,
      /* #881: THE SIXTH SITE, found by the harness's own "no bare 999 / no `?? 4`" assertion -- which is the
         argument for asserting an absence across a file rather than checking the call sites you happen to
         have found. */
      maxRevenueCentres: reachForDrafting(train.maxDistance),
    })),
  });
  return result.totalRevenue;
}
