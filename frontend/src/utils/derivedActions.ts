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
//   IT ARRIVED AS A PARAMETER AND DEFAULTED TO "STILL AVAILABLE" -- and #1237 records what that default cost:
//   `stationPlacementBlockReason` treats the flag as "a placement exists" and stops looking, so on the server
//   the Tokens step was never auto-skipped for ANY corporation, and every playtest reported it as "Lay Track
//   did not advance". #1204 has since put the spent-ness on the board (`used_private_abilities`), so the
//   default is now COMPUTED from the state by the shell's own rule (`dhFreeStationAvailableFor`), scoped to
//   the corporation whose president owns the D&H. #414's ordering of the two mistakes still stands; it is
//   just no longer a reason to guess.

import type { GameStateResponse } from "./gameState";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { OperatingSubPhase } from "../components/OperatingSubPhaseStepper";

import { autoSkipExit } from "./autoSkipExit";
import { DH_PRIVATE_ID, dhFreeStationAvailableFor } from "./dhPower";
import { privateHexFor } from "./privateReservations";
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
import { barredHexesFor } from "./kanawhaLicense";
import { MOCK_TRAIN_CATALOG } from "./mockFixtures";
import { tileEraFor } from "./gameConstants";
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
  kind: "skip" | "end-turn" | "forced-withhold" | "accepted-offer";
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
  /* #1237: WHEN THE CALLER DOES NOT SAY, THE BOARD SAYS. The old default was `true` -- "still available" --
     which made `stationPlacementBlockReason` return "possible" for every corporation before it looked at
     reachability, so the Tokens step was never auto-skipped on the server. The answer is on the state now
     (#1204), and `dhFreeStationAvailableFor` is the shell's own rule, shared. A caller that knows better may
     still say so; nobody has to. */
  const { state, mapGrid, emitted } = input;
  const extraStationAvailable =
    input.extraStationAvailable ??
    (() => {
      const companyId = operatingCorporationId(state);
      if (companyId === null) return false;
      const dhHex = privateHexFor(DH_PRIVATE_ID);
      return dhFreeStationAvailableFor({
        companyId,
        privates: state.private_companies,
        usedAbilities: state.used_private_abilities ?? [],
        dhHexBuilt: dhHex ? mapGrid.tiles.some((tile) => tile.q === dhHex.q && tile.r === dhHex.r) : false,
      });
    })();

  /* ==================================================================
      DESIGN NOTE 1247: AN ACCEPTED OFFER IS A PURCHASE THE BOARD OWES
     ==================================================================
     The reducer's answer arms record a yes as `accepted: true` on the offer and nothing else; the purchase
     that follows is generated here, once, by whoever settles the board (the server on the server path, the
     on-turn client on Firestore) and applied by every client from the log -- the same route as an auto-skip,
     for the same reason (#576: derived by every client, appended by one). ASKED FIRST, before the round and
     the step, because an accepted offer is owed whatever else the board is doing.
     THE KEY NEEDS NO TURN. `emitted` guards a restarted server against re-sending what the log already
     holds, and the purchase arms clear the offer they settle, so a rebuilt board that already bought owes
     nothing and never reaches this branch. The key is still unique per settlement -- a private is bought once;
     a train key counts the buyer's fleet, which grows by one with each trade -- so two trades of the same
     model in one turn are two keys. */
  const privateOffer = state.private_purchase_offer ?? null;
  if (privateOffer?.accepted === true && !emitted.has(`offer:private:${privateOffer.private_id}`)) {
    return {
      msg: {
        BuyPrivateCompany: {
          game_id: 0,
          protocol_id: privateOffer.buyer_protocol_id,
          private_id: privateOffer.private_id,
          price: String(privateOffer.price),
        },
      } as GameplayExecuteMsg,
      key: `offer:private:${privateOffer.private_id}`,
      reason: "the owner accepted the offer",
      kind: "accepted-offer",
    };
  }
  const trainOffer = state.train_purchase_offer ?? null;
  if (trainOffer?.accepted === true) {
    const fleet =
      state.public_companies.find((entry) => entry.company_id === trainOffer.buyer_protocol_id)
        ?.owned_trains?.length ?? 0;
    const key = `offer:train:${trainOffer.seller_protocol_id}:${trainOffer.model_type}:${trainOffer.buyer_protocol_id}:${fleet}`;
    if (!emitted.has(key)) {
      return {
        msg: {
          BuyTrainFromCorporation: {
            game_id: 0,
            buyer_protocol_id: trainOffer.buyer_protocol_id,
            seller_protocol_id: trainOffer.seller_protocol_id,
            model_type: trainOffer.model_type,
            price: trainOffer.price,
          },
        } as GameplayExecuteMsg,
        key,
        reason: "the seller accepted the offer",
        kind: "accepted-offer",
      };
    }
  }

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
    /* Design note #1277: counted through the reader that knows about heralds. PRR on 1830+ has a network
       before it has a token (#1302), and `station_token_hexes.length` answered 0 -- so JUNO-CV4 87-89 skipped
       PRR's Routes step and forced a withhold on a corporation that could have run from H12. */
    stationTokenCount:
      company.station_token_hexes == null ? undefined : stationTokensOf(company).length,
    mapGrid,
    searchRevenue: () => maxRouteRevenueFor(state, company.company_id, mapGrid),
  });
  /* ==================================================================
      DESIGN NOTE 1275: NOTHING RAN, SO THERE IS NOTHING TO DECLARE
     ==================================================================
     REPORTED (JUNO-CV4, 108-109): C&O held a 3-train and a station, skipped Routes without running, and
     Dividends then waited on the president with "Withhold $0" -- index 109 is a hand-sent declaration of
     nothing. `earnableRevenueVerdict` had answered "can earn", which is the right question at ROUTES and the
     wrong one here: once the Routes step is behind the corporation with nothing run, the only legal
     declaration is $0 withheld, and #292's reasoning applies -- that is an action with a consequence (the
     marker steps left), not a choice. So it is forced, exactly as the trainless case below is.
     `routes_run_this_turn` IS THE FACT, and #232's rule reads its absence as "this build did not say" rather
     than as zero -- a log from before the counter existed does not get a forced withhold it never had. The
     revenue is checked beside it so a run that was recorded without the counter (none exist, but the guard
     is cheap) still declares itself. */
  const nothingRan =
    step === "Dividends" &&
    company.routes_run_this_turn === 0 &&
    Number(company.last_route_revenue ?? 0) === 0;
  const noEarnableRevenue =
    skipReasonFor(earnable) ?? (nothingRan ? "it ran no routes this turn" : null);

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
      // #1237: log-derived now -- computed from the board above unless the caller knows better.
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
    barredHexes: barredHexesFor(state, companyId), // #1323: Coal River, unlicensed
  });

  const result = assignRouteSet({
    blocksThrough,
    mapGrid,
    era: tileEraFor(state), // #1312
    startHexes,
    companyId: company.company_id, // #1302

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
