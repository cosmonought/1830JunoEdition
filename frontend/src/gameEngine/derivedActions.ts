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
import type { GameplayExecuteMsg } from "../utils/sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { TileColorTier } from "../components/hexTileCatalog";
import type { OperatingSubPhase } from "./operatingSubPhase";

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
import { pendingTrainDiscards } from "./trainDiscard";
// Design note #1612 (Slice 8.2): the home station's obligation, derived on the cursor.
import { boardHomeHexToAxial, owedHomeStation } from "./homeStationAuthority";
import { privateSettlementMatches, trainSettlementMatches } from "./pendingOfferHold";
import type { PrivatePurchaseOffer, TrainPurchaseOffer } from "./gameState";
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
  /* Design note #1530: WHILE A DISCARD IS OWED THE GAME OWES NOTHING. A corporation over its train limit is
     waiting on its president's `DiscardTrain`, and the reducer refuses every other message meanwhile -- so an
     auto-skip or an end-of-turn generated here would only be refused, and a server that generated one
     anyway would be walking the turn past the decision the rules give to a player. Asked before the accepted
     offer below, because an accepted purchase is also "anything else". */
  if (pendingTrainDiscards(state) !== null) return null;
  /* ==================================================================
      DESIGN NOTE 1612 (derived): WHILE THE HOME STATION IS OWED THE GAME OWES NOTHING
     ==================================================================
     Slice 8.2 (S8-5). At the start of its first operating turn a corporation must place its home station before
     anything else; the reducer refuses every other message meanwhile (`homeStationHold`, #1613). Track is never
     auto-skipped, but Tokens, Routes, Dividends and Hardware are -- and a corporation with no token has nowhere
     to place, nothing to run and nothing to declare, so a loop that kept answering would walk it through its
     whole turn on the strength of a placement nobody has made. So: nothing, for the same reason as the discard
     line above, asked right after it (the four holds' priority) and before the accepted offer (which cannot
     stand at a turn opening, #1590). The board's own label table, as the reducer's providers hand it in. */
  if (owedHomeStation(state, boardHomeHexToAxial) !== null) return null;
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
     nothing and never reaches this branch. */
  /* Design note #1596 (Batch 7.4): THE SETTLEMENT ALWAYS RETIRES THE OFFER, applied or refused -- the purchase
     arm clears it on success, and `applySandboxActionCore` clears it when any gate refuses the settlement on a
     stale board -- so the board can never present the same accepted offer to this function twice, and the
     loop in `settleOwed` cannot spin on one. The funding offer (#1541) is never derived: its settlement is its
     own answer arm. */
  /* ==================================================================
      DESIGN NOTE 1597: THE KEY IS THE OFFER'S INSTANCE, NOT ITS TRANSACTION (Batch 7.4, R74-B)
     ==================================================================
     The key used to be a tuple of board facts -- the private, its owner, the buyer and the price; the seller,
     the model, the buyer and the buyer's FLEET SIZE -- on the reasoning that a private is bought once and a
     fleet grows by one per trade. Opus's matrix proved the reasoning wrong for trains in five legal sequences
     (R74-B.1-B.4, B.5b): rust, an intercorporate sale, a discard in a chain, or rust followed by a depot
     purchase bring the fleet back to a size already settled, a later DISTINCT offer between the same parties
     for the same model then derives a key the room's `emitted` set already holds, `settleOwed` derives
     nothing, and #1590's hold freezes the whole table around an accepted offer nobody can settle. The price
     would not have saved it: B.2 collides at an identical price.
     SO THE KEY NAMES THE LIFECYCLE. Every ordinary offer is numbered by its proposal arm (`offer_serial`,
     `allocateOfferInstance`), the number travels on the offer as `instance`, and the key is
     `offer:<kind>:<instance>` and nothing else. Two later offers identical in every game property are two
     instances; the same offer re-derived after a `RevertTo` past its settlement is the same instance, on a
     rebuilt engine whose set is fresh (#1233) -- which is exactly the exactly-once property `emitted` protects.
     The number is log-derived like every other field, so a restart recomputes the same key (#1208), and
     `derivedEntryKey` below is how the replay records it.
     AN OFFER WITHOUT A NUMBER exists only where a fixture wrote it by hand; it is keyed on its transaction so
     that such a board still settles once per engine lifetime, as it always did. */
  const privateOffer = state.private_purchase_offer ?? null;
  if (privateOffer?.accepted === true && privateOffer.funding !== true) {
    const key = privateOfferKey(privateOffer);
    if (!emitted.has(key)) {
      return {
        msg: {
          BuyPrivateCompany: {
            game_id: 0,
            protocol_id: privateOffer.buyer_protocol_id,
            private_id: privateOffer.private_id,
            price: String(privateOffer.price),
          },
        } as GameplayExecuteMsg,
        key,
        reason: "the owner accepted the offer",
        kind: "accepted-offer",
      };
    }
  }
  const trainOffer = state.train_purchase_offer ?? null;
  if (trainOffer?.accepted === true) {
    const key = trainOfferKey(trainOffer, state);
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

/** The derived settlement's idempotency key for an accepted ordinary private offer (#1597). */
export function privateOfferKey(offer: PrivatePurchaseOffer): string {
  return typeof offer.instance === "number"
    ? `offer:private:${offer.instance}`
    : `offer:private:unnumbered:${offer.private_id}:${offer.owner}:${offer.buyer_protocol_id}:${offer.price}`;
}

/** The derived settlement's idempotency key for an accepted train offer (#1597). The unnumbered fallback names the
 *  transaction (the pre-#1597 tuple plus the price) for hand-written fixtures only; no board a proposal arm wrote
 *  ever reaches it. */
export function trainOfferKey(offer: TrainPurchaseOffer, state: GameStateResponse): string {
  if (typeof offer.instance === "number") return `offer:train:${offer.instance}`;
  const fleet =
    state.public_companies.find((entry) => entry.company_id === offer.buyer_protocol_id)?.owned_trains?.length ?? 0;
  return `offer:train:unnumbered:${offer.seller_protocol_id}:${offer.model_type}:${offer.buyer_protocol_id}:${offer.price}:${fleet}`;
}

/* ==================================================================
    DESIGN NOTE 1598: A DERIVED ENTRY IS RECORDED UNDER THE KEY IT WAS DERIVED UNDER (Batch 7.4, O1)
   ==================================================================
   `RoomEngine.apply` records a key for every `derived` entry so a rebuild knows what the game already sent
   (#1208). It recorded `turnGuardKey(board, operating, step)` for ALL of them -- which is the right key for a
   skip, an end-turn and a forced withhold, and the WRONG key for an accepted-offer settlement, whose key is
   the offer's (#1247) and which is not a turn-progression action at all. The consequence (Opus, O1): a derived
   train settlement that fills the buyer to its limit at Hardware consumed the step's turn key, so the End Turn
   the board then owed -- the one a depot purchase filling the same fleet derives at once -- was never derived
   and the turn stayed open until the president ended it by hand. Two equivalent boards, two progressions.
   THIS FUNCTION IS THE ONE ANSWER TO "WHAT KEY DOES THIS ENTRY CONSUME", for the replay and the live loop
   alike: an entry that is the settlement of the standing accepted offer consumes that offer's instance key
   and no turn key; any other derived entry consumes the turn key of the board it was derived on. Computed
   BEFORE the arm runs, on the board `nextDerivedAction` looked at (the same instant as before). A settlement
   that matches no standing offer -- a stored log whose proposal a later engine refuses, FCJ 147 -- consumes
   nothing: it was never a turn's action, and recording a turn key for it would suppress a skip the rebuilt
   board still owes. After the fix the loop re-asks the post-settlement board and derives what a depot
   purchase would have: equivalent boards, equivalent progression, no special case for "offer => End Turn". */
export function derivedEntryKey(state: GameStateResponse, msg: GameplayExecuteMsg): string | null {
  if ("BuyPrivateCompany" in msg) {
    const offer = state.private_purchase_offer ?? null;
    return offer !== null && offer.funding !== true && offer.accepted === true && privateSettlementMatches(offer, msg.BuyPrivateCompany)
      ? privateOfferKey(offer)
      : null;
  }
  if ("BuyTrainFromCorporation" in msg) {
    const offer = state.train_purchase_offer ?? null;
    return offer !== null && offer.accepted === true && trainSettlementMatches(offer, msg.BuyTrainFromCorporation)
      ? trainOfferKey(offer, state)
      : null;
  }
  const owed = operatingCorporationId(state);
  const step = state.operating_sub_phase;
  return owed !== null && step !== undefined ? turnGuardKey(state, owed, step) : null;
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
  /** #1556: the era to price at, when the caller is comparing against a set priced at a known era. Defaults to
   *  the board's own (`tileEraFor`), which is what every live caller and the reducer's context agree on. */
  era?: TileColorTier,
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
  const result = routeSearchFor(
    state,
    companyId,
    mapGrid,
    startHexes,
    roster.map((train) => ({
      trainIndex: train.trainIndex,
      /* #881: THE SIXTH SITE, found by the harness's own "no bare 999 / no `?? 4`" assertion -- which is the
         argument for asserting an absence across a file rather than checking the call sites you happen to
         have found. */
      maxRevenueCentres: reachForDrafting(train.maxDistance),
    })),
    era,
  );
  return result.totalRevenue;
}

/** The one route search, with the board's own wall. Design note #1512: shared by the fleet's real search
 *  above and the trainless corporation's HYPOTHETICAL one below, so the two cannot walk two different boards.
 *  #730: a tokened-out city is a terminus, so no drafted route runs past one. Built here from the board rather
 *  than read from a ref, which is the whole difference between this file and the memo it was lifted from --
 *  `blocksThroughCityRef` exists because a React callback closes over a stale render, and there are no
 *  renders here. */
function routeSearchFor(
  state: GameStateResponse,
  companyId: number,
  mapGrid: MapGridResponse,
  startHexes: ReturnType<typeof stationTokensOf>,
  trains: ReadonlyArray<{ trainIndex: number; maxRevenueCentres: number }>,
  era: TileColorTier = tileEraFor(state), // #1312; #1556 lets the route authority name the era it priced at
) {
  const blocksThrough = cityBlockerFor({
    actingCompanyId: companyId,
    companies: state.public_companies,
    slotsAt: (q: number, r: number, cityIndex: number) => citySlotCount(mapGrid, q, r, cityIndex),
    cityOf: (company_, q, r) => tokenCityIndex(company_ as never, q, r),
    barredHexes: barredHexesFor(state, companyId), // #1323: Coal River, unlicensed
  });
  return assignRouteSet({
    blocksThrough,
    mapGrid,
    era,
    startHexes,
    companyId, // #1302
    trains,
  });
}

/** Whether this corporation HAS A LEGAL ROUTE -- the rulebook's precondition for the forced purchase
 *  (6.6.2: "If a corporation has a legal train route but has no train at the end of its Operating Turn, it
 *  must immediately purchase a train"; "If the corporation has no legal train route, it does not have to own
 *  or purchase a train").
 *
 *  Design note #1512: ASKED OF A HYPOTHETICAL TWO-STOP TRAIN, because the question is about the TRACK and not
 *  about the fleet -- a trainless corporation has nothing to run, and `maxRouteRevenueFor` would answer 0
 *  for it whatever the board looks like. A legal route is a route between two revenue centres, which is what
 *  the smallest train ever printed can run; if a 2-stop route exists, a route exists for any train the
 *  corporation could be made to buy. This is the same hypothetical `App.tsx` #433 has asked since the
 *  obligation was first surfaced ("The cheapest train in the depot"), now asked by the authority.
 *
 *  `null` MEANS "COULD NOT TELL" (#414's rule): a corporation the board does not describe, or whose tokens it
 *  has not reported. `false` is a real answer -- no tokens, or tokens with no two-stop route -- and the
 *  obligation does not arise on it. */
export function hasLegalRouteFor(
  state: GameStateResponse,
  companyId: number,
  mapGrid: MapGridResponse,
): boolean | null {
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company) return null;
  if (!company.station_token_hexes) return null;
  const startHexes = stationTokensOf(company);
  if (startHexes.length === 0) return false;
  const result = routeSearchFor(state, companyId, mapGrid, startHexes, [
    { trainIndex: 0, maxRevenueCentres: 2 },
  ]);
  return result.totalRevenue > 0;
}
