// frontend/src/App.tsx
//
// AppShell: the dashboard shell. Wires the wallet + session-key layer, the
// 2D canvas engine, and the Firestore room log into one screen.
//
// Four top-level tabs (Rail Map / Stock Market / Game Ledger / Rules), a
// round-aware Contextual Action Bar above the canvas, and a top ticker that
// merges chat and the action log into one timeline.
//
// The contract is the authority for all game state; Firestore carries chat,
// presence and the sandbox action log only.
//
// Design history for this file lives in docs/ai_architecture/ - see INDEX.md.
// Inline references below name notes by number, e.g. "App.tsx #382".

// Design notes #15-#21 (map fixtures, activity log, tab rename, ticker,
// turn alerts) extracted - see docs/ai_architecture/INDEX.md

// Design note #605: `useLayoutEffect` for the status dock's scroll
// compensation -- it has to run after React commits the new bottom padding
// and before the browser paints, or the correction is visible as a jump.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { WalletProvider, useWallet, CONTRACT_ADDRESS } from "./context/WalletContext";
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";

import { JUNO_RPC_ENDPOINT } from "./config";
import { GameSessionProvider, useGameSession } from "./context/GameSessionContext";
import HexGridRenderer, {
  type RouteOverlay,
  type MapGridResponse,
  type HexClickQueryState,
  type StationPreviewMarker,
} from "./components/HexGridRenderer";
import { assignRouteSet } from "./utils/routeAutoTrace";
import {
  cityEnteredFrom,
  layableHexes,
  reachableNetwork,
  stationTokensOf,
  type StationToken,
} from "./utils/trackReach";
// Design note #888: which hexes the Lay Track jump frames, and the camera pose that frames them.
import { dividendDeclaration } from "./utils/dividendStep";
// Design note #591f: `actingActor` went with the snapshot stack it stamped.
import {
  countPhrase,
  describeGameplayAction,
  sentenceStatesTreasury,
  /* Design note #1063: the short form of the train-purchase sentence, for the one toast the whole table
     sees. Built beside the long one so a depot count is worded in exactly one place. */
  trainPurchaseToastLine,
} from "./utils/actionLog";
import { STATIC_BOARD_HEXES } from "./components/hexBoardData";
import {
  bestContrastTextColor,
  stationTickerColor,
  // Design note #496: the fallback ticker for a corporation the live
  // response has not named, so the cursor still carries a herald.
  stationTickerLabel,
} from "./components/hexContractTypes";
// Design note #885: `PrivateAbility` / `PrivateAbilityAction` came from `PrivatePowerPanel`, which is gone.
import { corporationPrivateCompanies } from "./utils/gameState";
import type { TrainRouteDraft } from "./components/RoutePlannerPanel";
import {
  citySlotCount,
  evaluateStationPlacement,
  nextStationTokenCost,
  placeableStationHexes,
  stationPlacementBlockReason,
  stationTokenSlots,
} from "./utils/stationTokens";
import { corporationFullName } from "./utils/corporationNames";
// Design note #494: one distinct ink per train, so overlapping routes are
// tellable apart. Shared with `RoutePlannerPanel`'s chips -- the same pure
// function on both surfaces rather than two tables.
import { routeEmphasisFor, routeTrainColor } from "./styles/routeLivery";
// Design note #530/#531: the setup event and the 1830 setup tables.
import {
  BANK_START,
  MIN_PLAYERS,
  dealSandboxGame,
  isCloseRoomMsg,
  isOpenStockRoundMsg,
  isPlaceHomeStationMsg,
  isExchangePrivateMsg,
  isProposePrivatePurchaseMsg,
  isAnswerPrivatePurchaseMsg,
  isProposeTrainPurchaseMsg,
  isAnswerTrainPurchaseMsg,
  isRevertToMsg,
  isSetBoParMsg,
  isSandboxOnlyMsg,
  isSetupGameMsg,
  shuffleForTurnOrder,
  waterfallForRoster,
  withEmptyRoster,
  type SandboxLogMsg,
} from "./utils/gameSetup";
// Design note #522: the Sandbox multiplayer bridge.
import SandboxRoomBar from "./components/SandboxRoomBar";
import SandboxWaitingRoom from "./components/SandboxWaitingRoom";
import {
  appendSandboxAction,
  appliedPrefixHolds,
  canStartSandboxGame,
  decodeAction,
  hostSandboxRoom,
  localPlayerId,
  markSandboxRoomPlaying,
  setSandboxRoomVariants,
  parseRoomCode,
  readSandboxLog,
  subscribeSandboxLog,
  // Design note #644: sandbox chat hangs off the sandbox room, not a lobby one.
  SANDBOX_ROOMS_COLLECTION,
  subscribeSandboxRoom,
  toSetupPlayers,
  upsertSandboxPlayer,
  /* Design note #668: NAMED, at last. #643 noted that the drain's hand-written
     copy of this shape had gone stale and dropped `at`; importing the type is
     the fix that note asked for, and it is what stops `derived` going the same
     way. */
  type SandboxAction,
  type SandboxRoomDoc,
} from "./utils/sandboxRoom";
import { isFirebaseConfigured } from "./config/firebase";
import StockMarketRenderer, {
  marketCellForPrice,
  // Design note #712: the price-to-zone lookup, injected into the purchase rules.
  marketZoneForPrice,
  parBoxCellFor,
  projectDividendCellMove,
  projectDividendFrom,
  // Design note #746: the fourth movement, ported from market.rs.
  projectRiseMove,
  projectShareSaleMove,
  type MarketGridResponse,
  /* Design note #1090: the fifth market movement, composed from the withhold step and the sale step so the
     Blood Price inherits every edge case those two already handle. */
  projectBloodPriceMove,
} from "./components/StockMarketRenderer";
import { describeSoldOutRise, soldOutRises } from "./utils/soldOutRise";
// Design note #750: the instrument for the phantom $1500 -- a diff, not an annotation.
import { describeTreasuryMoves, treasuryMoveLine } from "./utils/treasuryProvenance";
// Design note #768: the board cannot lose tiles; this is what says so out loud when it does.
import { describeGridChange, gridChangeLine } from "./utils/gridProvenance";
// Design note #751: the obligation lives on Pass, so the player keeps the choice of how to discharge it.
import { noDecisionRemains, trainPurchaseRefusal } from "./utils/trainObligation";
// Design note #759: the zone exemptions expire, and the debt shuts three doors.
import { divestmentDebt, divestmentRefusal } from "./utils/forcedDivestment";
// Design note #763: a floated corporation with no home token stops the game until the token is down.
import { homeTokenBlock } from "./utils/homeTokenGate";
// Design note #162: `TileSelectionPopup` is no longer rendered or imported
// -- the radial selector replaced it, and its two callbacks went with it.
// The file is retained on disk, unreferenced, until the radial path has been
// exercised against a live chain.
import RadialTileSelector, { RadialTokenConfirm } from "./components/RadialTileSelector";
import {
  PrivateTradePrompt,
  type PrivateTradeProposal,
} from "./components/PrivateTradePanel";
import TopTicker from "./components/TopTicker";
import InlineQuickChat from "./components/InlineQuickChat";
import ContextualSubPanel from "./components/ContextualSubPanel";
import FinancialLedger from "./components/FinancialLedger";
import RulesReference from "./components/RulesReference";
// Design note #697: the receipt for an action you just took.
import ActionToast, {
  DEPOT_TOAST_MS,
  PHASE_CHANGE_TOAST_MS,
  type ToastAnchor,
} from "./components/ActionToast";
/* ==================================================================
    DESIGN NOTE 1049: THE PRIVATE PAYOUT LEFT THE TOAST LAYER ENTIRELY
   ==================================================================
   `PRIVATE_REVENUE_TOAST_MS` AND `CARD_ACCENT` ARE NO LONGER IMPORTED HERE, because this file no longer raises
   that toast -- the payout is a phase with a modal of its own now (see `PrivateRevenueModal.tsx` #1049 for why
   #1047's argument against one was withdrawn). Both constants survive where they are declared: the duration is
   the record of three attempts at a number that does not exist for content of variable length, and the accent
   is still the auction private cards' own.
   #1048's OTHER HALF HAS NOW MOVED TOO, and the sentence that stood here has stopped being true rather than
   being deleted. It read: "'All other player-focused toasts in the player-color' was asked for and delivered
   on the dividend receipt, which still passes the viewer's seat colour through `showDividendToast`." That
   receipt is an overlay now (#1060) and raises no toast at all. THE REQUEST IS STILL HONOURED -- the seat
   colour goes to the money machine, as the dot beside the player's name -- so what changed is the surface
   and not the rule. `showDividendToast` survives for the era announcement, which is a fact about the table
   and passes no colour, exactly as #1048 said it should. */
import PrivateRevenueModal, {
  type PrivateRevenueOther,
} from "./components/PrivateRevenueModal";
/* Design note #1060: the dividend payout, shown as money arriving rather than as a sentence about it. The
   toast it replaces is gone from this file entirely -- see the receipt site for what moved and what was
   deliberately left behind. */
import DividendMoneyMachine, {
  MONEY_MACHINE_SFX,
  type DividendPayoutEvent,
} from "./components/DividendMoneyMachine";
// Design note #718: which dispatches earn a toast -- a named few, not everything that passes through.
import { deservesActionReceipt } from "./utils/actionReceipt";
// Design note #677: the Tiles tab.
import TileReference from "./components/TileReference";
import TrainTradePanel from "./components/TrainTradePanel";
/* Design note #508: the default export is gone from this import -- the panel
   is mounted by `ContextualActionBar` now, so this file supplies its props
   and no longer renders it. `TrainTradePrompt` still mounts here: it is the
   offer LEDGER, not the purchase control, and it never moved. */
import {
  TrainTradePrompt,
  type TrainTradeProposal,
} from "./components/TrainPurchasePanel";
import WaterfallAuctionDashboard from "./components/WaterfallAuctionDashboard";
import StockRoundPanel from "./components/StockRoundPanel";
import {
  useGameStatePolling,
  useTrainOffersPolling,
  useWaterfallStatePolling,
  type RoundType,
  type GameStateResponse,
  type WaterfallStateResponse,
  actingAddress,
  parPriceFor,
  actingSeatIndex,
  /* isSidelinedByMiniAuction not imported; the roster pills it fed are deleted.
     See docs/ai_architecture/state_machine.md - App.tsx #601 */
} from "./utils/gameState";
// Chat messages arrive pre-built from useFirestoreChat; this file constructs none.
// See docs/ai_architecture/firebase_middleware.md - App.tsx #22
import { mergeFeedItems, type ActionLogEntry, type FeedFilter } from "./utils/feed";
// Design note #670: the payout confirmation. The arithmetic is in the util so
// the replay and undo cases can be tested as sequences rather than screenshots.
import {
  cashByPlayer,
  cashChanges,
  settleCashDeltas,
  type CashByPlayer,
  type CashDelta,
} from "./utils/cashDelta";
import {
  depotInventory,
  derivePhase,
  rustOutlook,
  tierEra,
} from "./utils/gamePhase";
// Design note #703: the train-limit rule, so this gate and the Buy Trains panel cannot drift apart again.
import { countableTrainCount, isTrainLocked } from "./utils/trainLimit";
// Design note #1035: how close the privates are to closing, threaded to every surface that draws one.
import { privateClosureAlert } from "./utils/purchaseWarnings";
// Design note #705: the Pay column's before-and-after, alongside the Withhold column's.
import { projectDividendPayouts } from "./utils/dividendProjection";
// Design note #712: the market-zone purchase rules.
import { sharePurchaseBlock } from "./utils/sharePurchase";
// Design note #713: the sale's guards.
import { shareSaleBlock } from "./utils/shareSale";
// Design note #725: the D&H's two halves, and the order between them.
import {
  privatePowerHexKeys,
  privatePowerOfferAt,
  privatePowerOffers,
} from "./utils/privatePowerOffer";
/* Design note #887: `privatePowerFlow` itself is no longer imported here. The shell used to CALL it, in the
   memo that decided which flow was open; that decision moved to `activePrivatePower.ts`, which calls it
   instead. What is left is the open/closed predicate and the key type -- the two things the render needs. */
import { powerFlowOpen, type PowerAbilityKey } from "./utils/privatePowerFlow";
// Design note #729: which cities a corporation may not run through.
import { cityBlockerFor } from "./utils/cityBlocking";
// Design note #808: one predicate for the bow, consulted by the tracer, the legality check and the pricing.
import { hexOffersBypass, withForcedBypass } from "./utils/cityBypass";
// Design note #809: whose clicks the Lay Track glow may swallow -- watchers keep the inspector.
import { inspectorClickRefused } from "./utils/inspectorClick";
/* Design note #817: an armed errand's lifecycle -- what a click means, which lay is its own, and when it
   stops being relevant. Three questions that used to be answered by three unrelated `if`s. */
import {
  errandCancelLabel,
  homeCityRefusal,
  errandClaimsLay,
  errandClickIntent,
  errandSurvivesStep,
} from "./utils/privateErrand";
import { routeBlockedCityReason } from "./utils/routeWaypoints";
// Design note #738: the one notification a player gets about somebody else's action.
import { dividendReceipt } from "./utils/dividendReceipt";
// Design note #740: live, unsaved intent -- a hint, never a fact.
import {
  shouldPublishNow,
  shouldPublishRoutes,
  visiblePresence,
  type PresenceState,
} from "./utils/presence";
import {
  clearPresence,
  publishPresence,
  subscribeSandboxPresence,
} from "./utils/sandboxPresence";
/* Design note #1006: `printedMarkersFor` and `tileCitySlotCounts` are no longer imported here. Their one
   caller was `citySlotsAt`, whose body moved to `utils/stationTokens.ts` so the placement gate could reach it.
   Dropped rather than left imported, for #686's reason about `liveEdgesForHex`: an unused import of the tile
   catalog is an invitation for the next resolver to be written here instead of beside the rule again. */
import { tokenCityIndex, type StationTokenCompany } from "./components/hexContractTypes";
import {
  CSL_HEX_LABEL,
  CSL_PRIVATE_ID,
  DH_PRIVATE_ID,
  cslPowerState,
  dhPowerState,
  /* `dhStationDeclineForfeits`, `dhStationPromptNext` and `DhStationPrompt` are no longer imported: #849
     retired the prompt cursor into `activePowerFlow`, which derives the same two states from the power's own
     record. The transition table survives in `dhPower.ts` with its reasoning and its tests; see #849 there
     for why it is kept rather than deleted. */
  dhSelfLayWarning,
  privateSelfLayWarning,
} from "./utils/dhPower";
// Design note #717: the standing-pass instruction and what cancels it.
import {
  DEFAULT_AUTO_PASS_CONDITIONS,
  armAutoPass,
  autoPassAlreadyActed,
  autoPassDecision,
  exposedPresidencies,
  type AutoPassArm,
  type AutoPassConditions,
} from "./utils/autoPass";
import AutoPassModal from "./components/AutoPassModal";
import FleetLossModal from "./components/FleetLossModal";
// Design note #818: the D&H's free station, asked for rather than left to be noticed.
import { filterSandboxPlacements, isTokenableHex } from "./components/sandboxTileLegality";
// Design note #716: the whole tray at every facing, so the glow can ask what actually fits a hex.
import { localCatalogPlacements, tileCityCount } from "./components/hexGeometry";

// Design note #823: `describeTokenMigration` is no longer imported -- the ring stopped printing its
// sentence. The function survives in `tokenMigration.ts` with its own note; the arithmetic beside it is
// still what the radial thumbnails read.
import { planTokenUpgrade, tokenLandingsFor } from "./utils/tokenMigration";
/* Design note #889: the rotate odometer. `tokenDestinationChoices` is no longer imported -- it reached the
   superseded `previewTokenMigration` to decide whether a choice exists, and #878's `ownIsFree` answers that
   directly. It survives in `tokenMigration.ts` as the record, with no caller in the shell. */
import {
  freeCityChoices,
  nextPreviewArrangement,
  seedPreviewArrangement,
} from "./utils/previewRotation";
import type { LegalTilePlacement } from "./components/hexContractTypes";
import {
  /* Design note #1057: no longer used here -- the Auto-Skip line that named the step it was skipping is
     gone, because a step where nothing happened earns no line. The table itself is still the one source
     (`roundStampFor` reads it), which is #478's rule and is untouched. */
  OPERATING_SUB_PHASE_ORDER,
  initialOrSubPhase,
  visibleSubPhases,
  type OperatingSubPhase,
} from "./components/OperatingSubPhaseStepper";
// Design note #1008: the glow's condition travels beside `isMyTurn`, never folded into it.
import { useDocumentTitleFlash, useTurnGlowActive } from "./utils/turnAlert";
// Design note #1009: the whistle takes the same `isMyTurn` the other two turn alerts do.
import {
  duckRadio,
  // Design note #1073: the deep duck, for the one clip that competes with the bed rather than sitting over it.
  DUCK_FOR_VIDEO,
  playVariantCue,
  RADIO_STREAM_URL,
  RADIO_VOLUME,
  setRadioVolume,
  setSfxVolume,
  SFX_VOLUME,
  useRadioStream,
  useTurnWhistle,
} from "./utils/audio";
// Design note #1040: which sound a flavour line earns, and whether it brings a video with it.
import { isBonusBucket, variantCueFor } from "./utils/variantSfx";
// Design note #1044: the two-stage Easter egg, derived from the replayed log rather than a hidden flag.
import {
  escalationTier,
  ESCALATION_APPENDIX,
  lowestValueTrain,
  markPayout,
  MARK_APPENDIX,
  resolveFlavourLine,
  // Design note #1092: the doom clock, asked at the run rather than at the boundary.
  fogIsDue,
  yellowSignStateFrom,
} from "./utils/yellowSign";
import YellowSignOverlay from "./components/YellowSignOverlay";
import type { HauntingComposite } from "./components/YellowSignOverlay";
// Design note #1018: the auto-skip acts on a definite refusal, never on an unsettled one.
import { earnableRevenueVerdict, skipReasonFor } from "./utils/earnableRevenue";
import {
  placeParMark,
  // Design note #688: the invariant that replaced the par-mark edge detector.
  reconcileParMarks,
  sandboxInitialMarketPrices,
  sandboxMarketPriceTable,
  type SandboxMarketPrices,
  sandboxScenarioState,
  sandboxScenario,
  DEFAULT_SANDBOX_SCENARIO,
  type SandboxTrainFixture,
  type SandboxScenarioId,
  sandboxMarketPositions,
  sandboxWaterfallState,
  // Design note #746b: a rise is an arrival, stamped like every other landing (#646).
  withArrival,
} from "./utils/sandboxState";
import { availableCash, escrowedBids } from "./utils/auctionEscrow";
import { privateHexFor } from "./utils/privateReservations";
import { GameOverModal, type GameEndReason } from "./components/GameOverModal";
import { bankIsBroken, rankPlayers, PLACEHOLDER_TOTAL_ANTE, type PlayerStanding } from "./utils/endgame";
import { turnGuardKey } from "./utils/turnGuardKey";
import type { GameVariants } from "./utils/gameVariants";
import {
  boIsLocked,
  dividendStepsFor,
  /* Design note #1051: the pre-#1051 die, for a log entry written before the roll was recorded. Only the
     replay of an old game reaches it; a live turn always carries its own draw. */
  legacyTurnSeed,
  /* Design note #1051: the draw itself. This file is the ONLY one that calls it -- the reducer replays on
     every client and must never invent a number, so the die is thrown once here and travels in the log. */
  randomTurnSeed,
  resolveVariants,
  revenueDeltaPercent,
  revenueOutcome,
  rollTurnRevenue,
  flavorBucketFor,
  revenueFlavourClause,
  turnRevenueSentence,
} from "./utils/gameVariants";
/* Design note #1051: finding the roll a turn already made, in the RAW log -- including the entries an undo
   struck out, which is what makes an undo unable to re-roll the die. */
import { seedAlreadyRolled, turnSeedKey } from "./utils/turnSeed";
import {
  AUTO_CLOSE_MS,
  formatCountdown,
  settleRoomPayout,
} from "./utils/closeRoomPayout";
import {
  fleetLossNotices,
  isNoticeSilenced,
  nextDueNotice,
  noticeDismissKey,
  setNoticeSilenced,
  type FleetLossNotice,
} from "./utils/fleetLossNotice";
import { dividendRefused } from "./utils/dividendGate";
import { dividendSplit } from "./utils/dividendSplit";
import {
  actionWasRefused,
  refusalReasonFor,
  refusedActionLineWithReason,
} from "./utils/refusedAction";
import { roundLabelFor, roundStampFor } from "./utils/roundLabel";

import {
  EmergencyTrainPurchaseModal,
  buildEmergencyPurchasePlan,
} from "./components/EmergencyTrainPurchaseModal";
import type { GameplayExecuteMsg } from "./utils/sessionKey";
import {
  applySandboxAction,
  applySandboxMarketAction,
  applyPrivateRevenue,
  applySandboxWaterfallAction,
  /* Design note #642: `beginOperatingRound` is no longer imported here. The
     shell used to call it when it saw `stock_round_just_ended`; the reducer
     owns that now, which is the whole point of the change -- a round can only
     be opened by the path that replays. */
  pendingHomeTokens,
  placeHomeStationToken,
  describePrivatePayout,
  /* Design note #1049: the ROUND, not just the viewer's slice of it. `summarisePrivateRevenueForPlayer` is
     still the thing that itemises the viewer's own privates -- this wraps it and adds the other seats' totals,
     so the shell asks one question and the two halves cannot come from two different reads of the payouts. */
  summarisePrivateRevenueRound,
  describeFleetLoss,
  describeFleetLosses,
  describeReprieveExpiries,
  describePrivateClosures,
  applySandboxLayTile,
  describeFloat,
  isRouteTerminusHex,
  // Design note #624: counts a drafted route's paying STOPS against the
  // train's capacity. `isRouteTerminusHex` answers a different question --
  // towns pay but cannot end a route -- so the two are not interchangeable.
  boPresidencyRefusal,
  openingStockRoundReset,
  grantBOPresidency,
  sandboxRouteBreakdown,
  // Design note #1090: asked BEFORE the settle clears the seller's mark.
  isCarcosanTransfer,
  SANDBOX_NOMINAL_TOKEN_COST,
} from "./utils/sandboxSession";
/* Design note #1091: the curse's vocabulary, shared by the log, the three name surfaces and the
   scoreboard so none of them can word it differently. */
import { CARCOSA_STAMP_STEP, carcosaEpitaph, cursedCompanies } from "./utils/carcosaCurse";
import AppFooter from "./components/AppFooter";
import AuctionPromptModal from "./components/AuctionPromptModal";
import HomeStationPrompt from "./components/HomeStationPrompt";

// Step 4: Firebase Real-Time Integration -- see design notes #1 and #22.
import Lobby from "./components/Lobby";
import TutorialModal, {
  TutorialLibrary,
  OPERATING_ROUND_TUTORIAL,
  STOCK_MARKET_TUTORIAL,
  STOCK_ROUND_TUTORIAL,
  WATERFALL_AUCTION_TUTORIAL,
  TUTORIAL_LIBRARY,
  replayTutorials,
  tutorialModeEnabled,
} from "./components/TutorialModal";
import { useFirestoreChat } from "./components/ChatBox";
// truncateAddress comes from utils/address.ts (configurable lead/trail), not utils/lobby.
// Importing both would collide. See docs/ai_architecture/ui_shell_layout.md - App.tsx #382
import { loadDisplayName, usePresenceHeartbeat } from "./utils/lobby";

// ---- Extracted from this file; see design note #382 below. ----
import ContextualActionBar from "./panels/ContextualActionBar";
import TopBar from "./components/TopBar";
import MainTabBar, {
  isTabAvailable,
  surfaceTabFor,
  type MainTab,
} from "./components/MainTabBar";
import { styles } from "./styles/appStyles";
import { PHASE_SHIFT_PULSE_CSS, TURN_PULSE_KEYFRAMES_CSS } from "./styles/animations";
import {
  BO_PRIVATE_ID,
  BO_TICKER,
  ERA_FOR_PHASE_TINT,
  NO_TRAIN_ROUTE_REASON,
} from "./utils/gameConstants";
import {
  MOCK_BUY_STOCK_PAR_VALUE,
  MOCK_LAY_TILE_PROTOCOL_ID,
  MOCK_MAP_GRID,
  MOCK_MARKET_GRID,
  MOCK_TRAIN_CATALOG,
} from "./utils/mockFixtures";
import {
  routePointsToWaypoints,
  type RoutePoint,
  routeTokenBlockReason,
} from "./utils/routeWaypoints";
import {
  ACTIVE_GAME_STORAGE_KEY,
  readActiveGame,
  readActiveSandboxRoom,
  writeActiveSandboxRoom,
  SANDBOX_GAME_ID,
  SANDBOX_ROOM_ID,
  type ActiveGame,
  type BoardMode,
} from "./utils/activeGame";
import { STATION_PLACEMENT_HIGHLIGHT_INK } from "./components/hexBoardData";
import PlayerCards from "./components/PlayerCards";
import SeatOrderTrail from "./components/SeatOrderTrail";
// Design note #610: who has passed, derived rather than tracked.
import { passedSeatIndices } from "./utils/passedSeats";
// Design note #628: how many copies of a tile are still in the tray.
import { tileStock } from "./utils/tileSupply";
/* Design note #881 added `privateAcronym` here for the Stock Round chip label; design note #887 moved that
   label into `activePrivatePower.ts`, which imports the lookup directly. The catalog itself is still read
   here for other surfaces. */
import { PRIVATE_COMPANY_CATALOG } from "./utils/privateCatalog";
// Design note #887: the shell's private-power derivations, extracted so a test can call them.
import {
  deriveActivePowerFlow,
  ownsPrivateByCorporation,
  stockRoundExchangeOffers,
} from "./utils/activePrivatePower";
import { playerFinances } from "./utils/playerFinance";
import {
  applyPrivateExchange,
  CA_BONUS_TICKER,
  CA_PRIVATE_ID,
  MH_PRIVATE_ID,
  resolvePrivateExchange,
} from "./utils/privateExchange";
import { effectiveActions, undoReachFor } from "./utils/logRevert";
import { RIVAL_ROUTE_INDEX_BASE, watcherTrainDrafts } from "./utils/watcherRouteChips";
import { autoSkipExit } from "./utils/autoSkipExit";
import { overrunsReach, reachForDrafting } from "./utils/trainReach";
import { editRouteDraft } from "./utils/routeDraftEdit";
// Design note #1024: the splice is a rule about an array, so it lives where it can be tested as one.
import { stopsRemovedByTruncating, truncateRouteAtHex } from "./utils/routeTruncate";
import { runnableDrafts, runTrainsRefusal } from "./utils/runTrainsRules";
import { errandLaysBonus } from "./utils/bonusLay";
import { stepsFor } from "./utils/operatingCursor";
// Design note #673: one computation of what a previewed lay costs, read by the
// corporation card and by the radial confirm caption.
import { describePendingSpend, pendingSpend } from "./utils/pendingSpend";
import { pendingTileCost } from "./utils/pendingTileCost";
import { PrivatePowerFlowModal } from "./components/PrivatePowerFlowModal";
import { truncateAddress } from "./utils/address";
/* Design note #559: ONE label resolver, shared. `App.tsx` used to declare
   its own room-aware copy at module scope while two components imported the
   fixture-only one of the same name -- so most of the app showed names and
   the Ledger showed raw ids. */
import {
  clearRoomNicknames,
  sandboxPlayerLabel,
  seatColor,
  setRoomColors,
  setRoomNicknames,
} from "./utils/playerLabels";
import { RevenueModifierFlash, type RevenueFlashSignal } from "./components/RevenueModifierFlash";
/* Built once. `layTrackFocus` re-runs this filter for every candidate hex on the board, and rebuilding a
   276-entry list inside that loop would be the only expensive thing in the pass. */
const ALL_TILE_PLACEMENTS = localCatalogPlacements();

/* Design note #875: `RIVAL_ROUTE_INDEX_BASE` moved to `watcherRouteChips.ts`, which is now the thing that
   applies it. #740's reasoning travels with it: "rivals' live routes are keyed above any real train index, so
   a watcher's overlay can never collide with their own on the key three surfaces join by (#373)." Imported
   rather than redeclared, because the map overlay below keys rival routes the same way and a second literal
   1000 is how that join quietly breaks. */

/* Design note #887: `ownsPrivate` MOVED to `activePrivatePower.ts` as `ownsPrivateByCorporation`, with
   #727's note. It was module-private here -- not exported, so not callable, so the corporate half of #441's
   scope rule could only ever be asserted as a string. Renamed on the way out because `ownsPrivate` reads as
   "does anyone own it"; the question it answers is whether the OPERATING CORPORATION does. */

/* Move-only extraction: ~3,500 lines left this file for panels/, styles/ and utils/.
   See docs/ai_architecture/ui_shell_layout.md - App.tsx #382 */


/* Action Log entries are constructed here, rendered via the ticker.
   ActionLogEntry/ActionLogStatus live in utils/feed.ts - App.tsx #18 */

/** Round tag ("Auction"/"SR2"/"OR 1.1") from a state, not from what the browser shows; null before the first poll. roundLabelFor moved to utils/roundLabel.ts (#659).
 *  See docs/ai_architecture/state_machine.md - App.tsx #643 */
let nextLogEntryId = 1;

/* Design note #940: the floating modifier's re-arm token. Module scope beside `nextLogEntryId` and for the
   same reason -- it must be monotonic across every dispatch in a turn, and a value that lived in state would
   be read stale by a loop that dispatches three runs before React re-renders once. */
let revenueFlashToken = 0;
function nextRevenueFlashToken(): number {
  revenueFlashToken += 1;
  return revenueFlashToken;
}

/* ---- Design note #668: the feed's clock, and why it needed one. ----

   REPORTED: during OR 2.2 the Activity Log suddenly printed a backlog of setup
   events -- "Game dealt for 2 players", "Host won Mohawk & Hudson", "B&O
   floated" -- long after they happened.

   Nothing was buffering them. They were REPLAYED, correctly and in order, by a
   rebuild after an undo, and then SORTED into the wrong place. #643 gave a
   replayed action the log entry's own `createdAt` so a rebuild would not stamp
   the whole history with one instant; what it could not reach was `logInfo`,
   which every derived line goes through and which had no way to know a replay
   was running. So the action landed at its true time and its own consequences
   landed at `Date.now()`, at the bottom of a feed sorted on that field alone.

   Two things fix it and both are needed. `seq` (feed.ts #668) gives the feed a
   real order to fall back on. `replayClock` below gives the derived lines the
   right time in the first place, so the two orders agree instead of one papering
   over the other.

   The clock is also MONOTONIC. Firestore's `createdAt` is null in the optimistic
   local snapshot, so `at` is legitimately absent on a just-written entry; taking
   the greater of the stamp and the previous entry's keeps the log non-decreasing
   whatever the source, which is the property the sort actually relies on. */
let replayClock: number | null = null;
let lastLogStampMs = 0;

/* ==================================================================
   DESIGN NOTE 825: A TOAST MARKS A MOVE, NOT A CATCH-UP
   ==================================================================

   REPORTED: "when Undoing any action, a toast notification surfaces about the last corporation's payout.
   There shouldn't be any toast notifications on Undo."

   #670 WROTE THIS EXACT RULE AND APPLIED IT TO ONE SURFACE. Its note, still in the drain below, says: "A
   BADGE MARKS A MOVE, NOT A CATCH-UP ... Joining a room replays a whole game, and an undo rebuilds from the
   fixture -- in both, every balance on the board changes, and firing a badge per change would carpet the
   strip with figures about events that are minutes old." The cash badges have honoured that ever since. The
   TOASTS were added afterwards (#718's receipt, #786/#795's payout notice) and never asked.

   SO AN UNDO REPLAYED THE WHOLE GAME AND THE LAST DIVIDEND ANNOUNCED ITSELF AGAIN -- which is worse than
   merely noisy, because a payout toast is a claim that money has just moved, and during a rebuild nothing
   has: the board is being restored to a state it already reached.

   A FLAG BESIDE THE CLOCK, and for the same reason `replayClock` is one: the drain sets it around a
   dispatch, and everything downstream that needs to know "is this history or is this now" reads it without
   the answer being threaded through a dozen call sites. `isOrdinaryPlay` is the drain's own name for the
   distinction and already existed -- this only publishes it.

   GATED AT THE TWO DOORS rather than at the three call sites, which is #748a's rule: a call site that has to
   remember is a call site that will forget, and the next toast added would have forgotten too. */
let replayingHistory = false;

/** The instant to stamp the next entry with. `at` when the caller has one (a
 *  replayed action), the replay clock when a derived line is being written
 *  during one, and the wall clock otherwise -- never going backwards. */
function stampLogTime(at?: number): number {
  const proposed = at ?? replayClock ?? Date.now();
  const stamped = Math.max(proposed, lastLogStampMs);
  lastLogStampMs = stamped;
  return stamped;
}

/** Clears the clock, for a rebuild that is about to replay history from the
 *  start. Without this the previous run's high-water mark would flatten the
 *  whole replay onto one instant. */
function resetLogClock(): void {
  replayClock = null;
  lastLogStampMs = 0;
  // Design note #825: and the replay flag, so a rebuild that throws cannot leave the app permanently silent.
  replayingHistory = false;
}

// Chat ids are Firestore document ids, not a local counter, so they match across clients.
// See docs/ai_architecture/firebase_middleware.md - App.tsx #22

/* ------------------------------------------------------------------ */
/* App shell -- everything below here renders inside both providers   */
/* ------------------------------------------------------------------ */

interface AppShellProps {
  /** The contract's u64 game id. In every gameplay useCallback dependency array because a prop can go stale where the old module constant could not.
   *  See docs/ai_architecture/session_keys_wallet.md - App.tsx #26 */
  gameId: number;
  /** The FIRESTORE room id -- addresses off-chain chat and presence only.
   *  A different identifier for a different system; see design note #22. */
  roomId: string;
  /* The room is chosen in the Lobby and handed down as the starting value; the shell owns the listener.
     See docs/ai_architecture/firebase_middleware.md - App.tsx #524 */
  sandboxRoomSeed?: string | null;
  /** Returns to the Lobby. */
  onLeaveGame: () => void;
  /** Which of the three ways of looking at a board this is -- design note
   *  #24. The two booleans below are derived from it inside the component;
   *  the mode is the single source so they cannot contradict each other. */
  mode: BoardMode;
}

/* Design note #900: the reopen pill. Bottom-centre rather than in the action bar, because during `GameEnd`
   the bar carries the Close Room control and two end-of-game buttons side by side read as a choice between
   them. */
const gameOverReopenStyle: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  bottom: "18px",
  transform: "translateX(-50%)",
  zIndex: 1500,
  padding: "8px 16px",
  borderRadius: "999px",
  border: "1px solid #7a6320",
  backgroundColor: "#241d0e",
  color: "#f0dfa8",
  fontSize: "13px",
  fontWeight: 700,
  cursor: "pointer",
  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
};

function AppShell({ gameId, roomId, onLeaveGame, mode, sandboxRoomSeed = null }: AppShellProps) {
  const wallet = useWallet();
  const session = useGameSession();

  // Read-only mode is enforced at the two dispatch sites, not by disabling buttons. grep -rn 'execGameplay(' must return exactly two call sites.
  // See docs/ai_architecture/session_keys_wallet.md - App.tsx #23
  const spectator = mode === "spectate";

  // Design note #24. `sandbox` answers a different question from
  // `spectator`: not "may this viewer act?" but "is there a chain at all?".
  // Sandbox mode is emphatically NOT read-only -- the tile picker is the
  // main thing it exists to exercise -- it simply has nothing to talk to.
  const sandbox = mode === "sandbox";

  /* sessionReady is the wrong question in sandbox: no wallet means sessionStatus never leaves "uninitialized" and every bar button is silently disabled.
     See docs/ai_architecture/session_keys_wallet.md - App.tsx #220 */
  const controlsEnabled = session.sessionStatus === "ready" || sandbox;

  /* Sandbox scenario: a debug control, never a game mechanic. Feeds sandboxGameState only; the setter went with the toolbar (#177/#578).
     See docs/ai_architecture/state_machine.md - App.tsx #25 */
  const [sandboxScenarioId] = useState<SandboxScenarioId>(DEFAULT_SANDBOX_SCENARIO);
  const sandboxPhase = sandboxScenario(sandboxScenarioId).phase;
  /** Design note #9 in `sandboxState.ts`: the turn-1 fixture. */
  const sandboxIsZeroState = sandboxScenario(sandboxScenarioId).zeroState === true;

  /* Entering the zero state clears tutorial "seen" flags so a first game teaches them again; mid-game fixtures leave them alone.
     See docs/ai_architecture/state_machine.md - App.tsx #301 */
  useEffect(() => {
    if (!sandbox || !sandboxIsZeroState) return;
    replayTutorials(TUTORIAL_LIBRARY.map((topic) => topic.topicKey));
  }, [sandbox, sandboxIsZeroState, sandboxScenarioId]);

  /* Design note #1 in `PrivatePowerPanel.tsx`: which abilities have fired.
     Local, because there is no contract message to read it back from --
     the panel exists so the surface and its two gates are testable, and
     this is the smallest state that makes "Used" mean something. */
  const [usedPrivateAbilities, setUsedPrivateAbilities] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  /** Design note #303: what each private actually sold for, by id. */
  const [settledPrivatePrices, setSettledPrivatePrices] = useState<Readonly<Record<number, number>>>(
    {},
  );
  /** Design note #310: mirrored into a ref so the undo snapshot can capture
   *  it from inside the dispatch closure, the same reason `sandboxStateRef`
   *  exists. */
  const settledPrivatePricesRef = useRef<Readonly<Record<number, number>>>(settledPrivatePrices);
  useEffect(() => {
    settledPrivatePricesRef.current = settledPrivatePrices;
  }, [settledPrivatePrices]);

  // Train distribution is a second fixture axis, not a sixth scenario. Setter removed with the toolbar (#578).
  // See docs/ai_architecture/state_machine.md - App.tsx #246
  const [sandboxTrainFixture] = useState<SandboxTrainFixture>("default");

  /* Undo is a log revert now. The per-client snapshot stack (#178/#310) is deleted; its per-atom restore list moved into rebuildSandbox.
     See docs/ai_architecture/state_machine.md - App.tsx #591 */

  /* The hotseat seat switcher is gone with the mode it served.
     See docs/ai_architecture/state_machine.md - App.tsx #578 */

  /** Read-only identity: decides whose figures to show and which controls light up. It never signs.
   *  See docs/ai_architecture/session_keys_wallet.md - App.tsx #25 */
  const [sandboxRoomCode, setSandboxRoomCode] = useState<string | null>(sandboxRoomSeed);
  const localId = localPlayerId();

  /* In a room this browser is one person with one id, which makes every existing turn/president gate correct at once.
     See docs/ai_architecture/session_keys_wallet.md - App.tsx #534 */
  const viewerAddress = sandbox ? localId : wallet.address;

  /* Design note #573: read synchronously by `handleUsePrivateAbility`, which
     must not name `viewerAddress` as a dependency -- it feeds
     `runGameplayAction`'s neighbourhood and design note #536 explains why an
     identity that changes on every seat switch is expensive there. */
  const viewerAddressRef = useRef<string | null>(null);
  viewerAddressRef.current = viewerAddress ?? null;

  /* Design note #573b: the last refusal, for the panel. A REASON rather than
     a boolean -- "you cannot" sends the player looking for why, and the
     answer ("you hold 60% of the PRR") is the whole content of the message. */
  /* ==================================================================
      DESIGN NOTE 882: THE REASON KNOWS WHICH POWER IT IS ABOUT
     ==================================================================

     WAS `useState<string | null>`, and the string was written by `runPrivateExchange` and read by
     `PrivatePowerPanel`'s error line. That worked while the panel was the only surface, because the panel
     showed every power at once and the sentence named its own company.

     A BARE STRING IS A PROXY THAT STOPPED STANDING FOR ITS SUBJECT. The refusal now renders inside the flow
     modal, which shows ONE power -- so "the last refusal" has to answer "the last refusal FOR THIS POWER",
     and a lone string cannot. Left as a string, a refused M&H exchange would still be on screen inside a
     D&H modal raised two minutes later by the standing station obligation, attached to a power it says
     nothing about.
     SCOPED BY KEY, NOT CLEARED ON A TIMER OR ON EVERY OPEN. The match is computed where the modal is
     mounted, so a refusal belonging to another power cannot be shown at all rather than being cleared before
     it gets the chance -- the difference between a rule and a habit. Clearing on a fresh attempt is still
     done at the two doors, because a SAME-power refusal can go stale (sell the share, ask again) and no
     amount of scoping catches that one. */
  const [privatePowerRefusal, setPrivatePowerRefusal] = useState<{
    abilityKey: PowerAbilityKey;
    reason: string;
  } | null>(null);


  // Display name read once at mount; a rename must not rewrite bylines on messages already sent.
  // See docs/ai_architecture/firebase_middleware.md - App.tsx #22
  const [displayName] = useState<string>(() => loadDisplayName() ?? "");

  // Presence heartbeat: a UI hint with no authority. Suppressed for spectators (no seat doc) and sandbox (no room).
  // See docs/ai_architecture/firebase_middleware.md - App.tsx #22
  usePresenceHeartbeat(spectator || sandbox ? null : roomId, wallet.address);

  // A spectator may have no signing client, so fall back to an anonymous read-only CosmWasmClient.
  // See docs/ai_architecture/session_keys_wallet.md - App.tsx #23
  const [readOnlyClient, setReadOnlyClient] = useState<CosmWasmClient | null>(null);

  useEffect(() => {
    // A signing client is already query-capable; a second connection would
    // be pure waste.
    // Design note #24: sandbox never touches the network at all.
    if (sandbox) return undefined;
    if (wallet.signingClient) return undefined;
    // Offline Sandbox Mode: nothing to connect to, and this must not throw
    // (config.ts design note #0), so read the raw value rather than
    // `requireRpcEndpoint()`.
    if (!JUNO_RPC_ENDPOINT) return undefined;

    let cancelled = false;
    CosmWasmClient.connect(JUNO_RPC_ENDPOINT)
      .then((client) => {
        // The guard matters: without it, a connection resolving after the
        // user has navigated back to the lobby sets state on an unmounted
        // component, and worse, a wallet connecting mid-flight would leave
        // this stale client racing the real one.
        if (!cancelled) setReadOnlyClient(client);
      })
      .catch(() => {
        // Unreachable RPC. The polls simply report no state and every panel
        // shows its own empty/error affordance -- there is nothing useful to
        // add here that they do not already say.
      });

    return () => {
      cancelled = true;
    };
  }, [wallet.signingClient, sandbox]);

  /** undefined in sandbox, which stops every poll at source and lets panels render honest empty states.
   *  See docs/ai_architecture/session_keys_wallet.md - App.tsx #24 */
  const queryClient = sandbox ? undefined : (wallet.signingClient ?? readOnlyClient ?? undefined);

  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([]);
  /* Design note #1040: the log, readable from inside a dispatch handler. The Yellow Sign counts previous
     sightings and that count must be of the REPLAYED record every client shares -- reading the state
     directly from a closure built several commits earlier would count a stale log. */
  const actionLogRef = useRef<ActionLogEntry[]>([]);
  actionLogRef.current = actionLog;
  const [activeMainTab, setActiveMainTab] = useState<MainTab>("map");
  // The OR cursor is READ from the reducer's operating_sub_phase when present; this local state is what a live room follows until GetGameState reports one.
  // See docs/ai_architecture/state_machine.md - App.tsx #656
  const [liveOrSubPhase, setLiveOrSubPhase] = useState<OperatingSubPhase>(() =>
    initialOrSubPhase(null),
  );


  // Par is keyed per company_id, not one shared value; srSelectedProtocolId is gone (#29). B&O's par is held in a prompt (#399).
  // See docs/ai_architecture/stock_market.md - App.tsx #398
  const [boParPrompt, setBoParPrompt] = useState<{ player: string } | null>(null);
  const [srParValues, setSrParValues] = useState<Readonly<Record<number, string>>>({});
  /* Design note #553: the corporation's own par wins over this browser's
     ladder. The ladder is only consulted while the company has no price. */
  const parValueFor = useCallback(
    (companyId: number): string =>
      parPriceFor(
        gameStateRef.current,
        companyId,
        srParValues[companyId],
        MOCK_BUY_STOCK_PAR_VALUE,
      ),
    [srParValues],
  );
  const handleSelectParValue = useCallback((companyId: number, value: string) => {
    setSrParValues((prev) => ({ ...prev, [companyId]: value }));
  }, []);
  /** Design note #351/#398: mirrored so the dispatch path can read a
   *  selection synchronously, the same reason `sandboxStateRef` exists. Now
   *  a map, because "the ladder's current selection" is a question that only
   *  has an answer once you say WHICH ladder. */
  const srParValuesRef = useRef<Readonly<Record<number, string>>>(srParValues);
  useEffect(() => {
    srParValuesRef.current = srParValues;
  }, [srParValues]);
  /* parValueNumberFor is deleted: it read this browser's ladder and fell through to a hardcoded 100.
     See docs/ai_architecture/stock_market.md - App.tsx #579 */


  // Must be a ref, not state: the auto-switch fires only on genuine round-type transitions.
  // See docs/ai_architecture/state_machine.md - App.tsx #213
  const prevRoundTypeRef = useRef<RoundType | null>(null);

  // Design note #7: ONE shared live GetGameState poll. Every panel this
  // pass touches (Chatbox's turn alert, ContextualSubPanel, the Contextual
  // Top Action Bar's round-type switch, FinancialLedger,
  // HexGridRenderer's `currentEra`) derives from this same result.
  const {
    gameState: liveGameState,
    loading: gameStateLoading,
    error: gameStateError,
    refresh: refreshGameState,
  } = useGameStatePolling(queryClient, CONTRACT_ADDRESS, gameId);

  // Sandbox substitutes a hand-authored snapshot for the poll; real state, not a memo, and memoised so a dozen dependent hooks do not re-fire. Room rosters seed empty (#538).
  // See docs/ai_architecture/session_keys_wallet.md - App.tsx #62
  const seedSandboxState = useCallback(
    (roomCode: string | null): GameStateResponse | null => {
      if (!sandbox) return null;
      const board = sandboxScenarioState(sandboxScenarioId, gameId, sandboxTrainFixture);
      return roomCode ? withEmptyRoster(board) : board;
    },
    [sandbox, sandboxScenarioId, gameId, sandboxTrainFixture],
  );

  const [sandboxState, setSandboxState] = useState<GameStateResponse | null>(() =>
    sandbox
      ? sandboxRoomSeed
        ? withEmptyRoster(sandboxScenarioState(sandboxScenarioId, gameId, sandboxTrainFixture))
        : sandboxScenarioState(sandboxScenarioId, gameId, sandboxTrainFixture)
      : null,
  );

  /* Synchronous mirror of the sandbox atoms so a loop of dispatches sees each other's results. Seeded at construction (#537a).
     See docs/ai_architecture/state_machine.md - App.tsx #265 */
  const sandboxStateRef = useRef<GameStateResponse | null>(
    sandbox
      ? sandboxRoomSeed
        ? withEmptyRoster(sandboxScenarioState(sandboxScenarioId, gameId, sandboxTrainFixture))
        : sandboxScenarioState(sandboxScenarioId, gameId, sandboxTrainFixture)
      : null,
  );
  /* Design note #542: seeded, not null-until-an-effect-runs -- the same
     correction design note #537a made for `sandboxStateRef`, applied to the
     atom that was missed. */
  const sandboxWaterfallRef = useRef<WaterfallStateResponse | null>(
    sandbox
      ? sandboxRoomSeed
        ? waterfallForRoster(sandboxWaterfallState(sandboxPhase, gameId, sandboxIsZeroState), [])
        : sandboxWaterfallState(sandboxPhase, gameId, sandboxIsZeroState)
      : null,
  );
  useEffect(() => {
    sandboxStateRef.current = sandboxState;
  }, [sandboxState]);
  useEffect(() => {
    /* Scenario re-seeding stops at the room boundary: a room's state comes from the log, not the fixture.
       See docs/ai_architecture/firebase_middleware.md - App.tsx #537 */
    if (sandboxRoomCode) return;
    setSandboxState(seedSandboxState(null));
    // A scenario switch replaces the board, so the log and the three session-residue atoms go with it. Guarded on sandbox: gameId also changes on a live chain.
    // See docs/ai_architecture/state_machine.md - App.tsx #330
    if (sandbox) {
      setActionLog([]);
      setSettledPrivatePrices({});
      setUsedPrivateAbilities(new Set<string>());
    }
    // Design note #246: flipping the trade fixture re-seeds too. It changes
    // who owns what, which is board state rather than a view setting, so
    // applying it to a board mid-hotseat would leave trains appearing in
    // rosters with no action having created them.
  }, [sandbox, sandboxScenarioId, sandboxTrainFixture, gameId, sandboxRoomCode, seedSandboxState]);

  const gameState = sandboxState ?? liveGameState;

  /* Declared here because it needs gameState; the sandbox reducer's cursor wins when there is one.
     See docs/ai_architecture/state_machine.md - App.tsx #656 */
  const orSubPhase: OperatingSubPhase = gameState?.operating_sub_phase ?? liveOrSubPhase;

  /* Merged state, synchronously, for the par resolvers. Written during render on purpose - parValueFor reads it in the same render to price a button.
     See docs/ai_architecture/stock_market.md - App.tsx #553 */
  const gameStateRef = useRef<GameStateResponse | null>(null);
  gameStateRef.current = gameState;

  // Derived, not queried. Declared above runGameplayAction because its sandbox branch prices a route from the board and the era.
  // See docs/ai_architecture/state_machine.md - App.tsx #36
  const currentPhase = useMemo(() => derivePhase(gameState), [gameState]);

  /* The acting corporation comes from the operating queue, not the old hardcoded B&O constant, which is kept only as the empty-queue fallback.
     See docs/ai_architecture/state_machine.md - App.tsx #169 */
  const actingProtocolId = useMemo(() => {
    const queued = gameState?.active_operating_order[gameState.active_corporation_index];
    return queued ?? MOCK_LAY_TILE_PROTOCOL_ID;
  }, [gameState]);

  /* ==================================================================
      DESIGN NOTE 896: THE TRAINS A CORPORATION LOST WHILE IT WAS NOT ACTING
     ==================================================================
     Queued by the phase-change block below, drained at the top of the owning corporation's turn. A REF PLUS A
     MIRROR, which is the same shape the par-mark reconcile beside that block uses and for the same reason: the
     queue is written inside a dispatch that runs before React commits, so the ref is the truth and the state
     exists to make the modal re-render.
     `dismissed` IS A REF AND NOT STATE on purpose -- nothing renders from it, and putting it in state would
     re-run the memo that reads it every time it grew. */
  /* Design note #899: the standings and the trigger the closure handler needs, mirrored during render. The
     handler runs inside a dispatch and cannot read a `useMemo` from a later line; a ref written during render
     is the same arrangement `gameStateRef` uses two hundred lines up, for the same reason. */
  const finalStandingsRef = useRef<PlayerStanding[]>([]);
  const closeRoomTriggerRef = useRef<"manual" | "timer">("manual");

  const pendingFleetNoticesRef = useRef<FleetLossNotice[]>([]);
  const [pendingFleetNotices, setPendingFleetNotices] = useState<FleetLossNotice[]>([]);
  /** ==================================================================
   *   DESIGN NOTE 1107: A DISMISSAL HAS TO OUTLIVE THE PAGE, NOT JUST THE UNDO
   *  ==================================================================
   *
   * REPORTED: "refreshing the page triggered the Rust modal despite it having fired several subphases before."
   *
   * #1032 MADE THIS KEY THE EVENT rather than the turn, and its note says a rebuild "produces the same key
   * and a dismissed notice stays dismissed." TRUE OF AN UNDO, where the ref survives because the page does.
   * FALSE OF A REFRESH, which is the other kind of rebuild: the ref is reconstructed empty, the replay
   * re-queues the notice, and the modal interrupts a player who acknowledged it half a turn ago. The same
   * shape as #1094's era toast -- a guard that covers one kind of rebuild and silently not the other.
   *
   * `sessionStorage`, NOT THE LOG. #896 considered and rejected an acknowledgement ACTION: "a purely
   * cosmetic dismissal that Undo could then rewind". Whether one viewer clicked a modal is not game state and
   * must not enter the log every client replays. It is a per-viewer, per-session fact, which is what this
   * storage is for -- and what `Lobby` #114 already chose for the same reason ("rejoining a stale room in a
   * new tab" should not inherit the old one).
   *
   * KEYED BY ROOM, so two games in one session cannot inherit each other's acknowledgements.
   *
   * WRAPPED, because storage throws in a private window and on a browser with site data blocked -- and the
   * failure direction is the harmless one: an unreadable store means the modal shows again, which is the
   * behaviour that was there before this note. */
  /* Design note #1107: IN THE APP'S OWN STORAGE NAMESPACE, `1830juno.`, and versioned -- the shape
     `TutorialModal` and `fleetLossNotice`'s silence prefix already use. `appNaming.test.ts` #38 enforces it
     and explains why the namespace rather than an enumeration is the property: "a `localStorage` key is a
     persisted identifier -- renaming one silently discards every player's saved preference". My first draft
     wrote a bare `1830.` prefix and that suite caught it, which is exactly what it is for. */
  const dismissedStorageKey = sandboxRoomCode
    ? `1830juno.fleet_loss_dismissed.v1.${sandboxRoomCode}`
    : null;
  const dismissedFleetNoticesRef = useRef<Set<string>>(new Set());
  const dismissedLoadedForRef = useRef<string | null>(null);
  if (dismissedStorageKey && dismissedLoadedForRef.current !== dismissedStorageKey) {
    dismissedLoadedForRef.current = dismissedStorageKey;
    try {
      const saved = window.sessionStorage.getItem(dismissedStorageKey);
      dismissedFleetNoticesRef.current = new Set<string>(saved ? JSON.parse(saved) : []);
    } catch {
      dismissedFleetNoticesRef.current = new Set<string>();
    }
  }
  /** Design note #1107: written on every acknowledgement, so a refresh mid-turn keeps what was clicked. */
  const rememberDismissed = useCallback(
    (key: string) => {
      dismissedFleetNoticesRef.current.add(key);
      if (!dismissedStorageKey) return;
      try {
        window.sessionStorage.setItem(
          dismissedStorageKey,
          JSON.stringify(Array.from(dismissedFleetNoticesRef.current)),
        );
      } catch {
        /* A viewer whose browser refuses storage keeps the in-memory set and sees the modal again after a
           refresh -- the behaviour this note is improving on, not a new failure. */
      }
    },
    [dismissedStorageKey],
  );

  // Renders the whole depot tier by tier; depotInventory already applies the cheapest-first queue rule.
  // See docs/ai_architecture/contract_economy.md - App.tsx #203
  const depot = useMemo(() => depotInventory(gameState), [gameState]);
  /** Design note #1035: how close the private companies are to closing, for every surface that draws one.
   *
   *  DERIVED ONCE IN THE SHELL rather than in each card, which is the same division `outlook` and `depot`
   *  already follow: the components are handed a value and do not each reach for `gameState`. The rule itself
   *  lives in `purchaseWarnings`, beside the countdown it reads. */
  const closureAlert = useMemo(
    () => privateClosureAlert(currentPhase ?? null, depot),
    [currentPhase, depot],
  );

  const ownsAnyTrain = useMemo(() => {
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    // undefined means "this chain does not say", not "owns nothing": report false here so a legal skip stays enabled.
    // See docs/ai_architecture/contract_economy.md - App.tsx #293
    return (company?.owned_trains?.length ?? 0) > 0;
  }, [gameState, actingProtocolId]);

  /* Opposite direction from ownsAnyTrain: this gates End Turn, so ignorance must PERMIT or the turn deadlocks with no override.
     See docs/ai_architecture/contract_economy.md - App.tsx #293 */
  const trainlessAndReported = useMemo(() => {
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    const owned = company?.owned_trains;
    if (owned == null) return false;
    return owned.length === 0;
  }, [gameState, actingProtocolId]);


  /* Which train this route is for is the player's choice, seeded from the corporation's best owned train. null means not chosen yet.
     See docs/ai_architecture/contract_economy.md - App.tsx #227 */
  const bestOwnedTrain = useMemo(() => {
    const owned =
      gameState?.public_companies.find((company) => company.company_id === actingProtocolId)
        ?.owned_trains ?? [];
    let best = MOCK_TRAIN_CATALOG[0].modelType;
    let bestIndex = -1;
    for (const model of owned) {
      // `MOCK_TRAIN_CATALOG`'s ORDER is the tier order, so the highest index
      // a corporation holds is its best train.
      const index = MOCK_TRAIN_CATALOG.findIndex((train) => train.modelType === model);
      if (index > bestIndex) {
        bestIndex = index;
        best = model;
      }
    }
    return best;
  }, [gameState, actingProtocolId]);

  /* The train ROSTER, not the set of models - three 3-trains are three routes. Carries the index, the only thing telling them apart.
     See docs/ai_architecture/contract_economy.md - App.tsx #275 */
  const ownedTrainRoster = useMemo(() => {
    const owned =
      gameState?.public_companies.find((company) => company.company_id === actingProtocolId)
        ?.owned_trains ?? [];
    const rank = (model: string) =>
      MOCK_TRAIN_CATALOG.findIndex((train) => train.modelType === model);
    return owned
      .map((model, ownedIndex) => ({
        // Design note #275: the identity. Stable against re-sorting below,
        // because it is the position in `owned_trains` rather than here.
        trainIndex: ownedIndex,
        model,
        maxDistance: MOCK_TRAIN_CATALOG.find((train) => train.modelType === model)?.maxDistance,
      }))
      // Unknown models sort last rather than to the front, which is where a
      // `-1` from `findIndex` would otherwise put them.
      .sort((a, b) => (rank(a.model) < 0 ? 99 : rank(a.model)) - (rank(b.model) < 0 ? 99 : rank(b.model)));
  }, [gameState, actingProtocolId]);

  /** Stations left = station_token_limit minus tokens on the board, floored at zero.
   *  See docs/ai_architecture/state_machine.md - App.tsx #228 */
  const activeCorporationContext = useMemo(() => {
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    if (!company) return null;
    return {
      companyId: company.company_id,
      ticker: company.ticker,
      fullName: corporationFullName(company.ticker) ?? null,
      /** Design note #362: the printed home hex, for the token row. */
      homeHexLabel: company.home_hex_label ?? null,
      /** Design note #379: privates this corporation's TREASURY owns --
       *  bought from a player under the phase-gated corporate purchase, and
       *  until now visible on no surface at all. */
      privates: gameState
        ? corporationPrivateCompanies(company.company_id, gameState)
        : [],
      presidentLabel: company.president
        ? (sandboxPlayerLabel(company.president) ?? truncateAddress(company.president))
        : null,
      // Design note #441: the identity, for the corporate-power gate.
      presidentAddress: company.president ?? null,
      /* ==================================================================
          DESIGN NOTE 974: THE PRESIDENT'S OWN COLOUR, RESOLVED WHERE THE ROSTER IS
         ==================================================================
         REPORTED: "When buying private companies or trains from other corporations, it is hard to tell at a
         glance who owns the active corporation."
         RESOLVED HERE FOR #779's REASON, verbatim the rule three other panels already follow: `seatColor`
         wants the roster INDEX and the bar has a name, so the lookup happens where both exist. `null` for an
         address off the roster rather than a fallback tint -- "on a table where colour identifies a person,
         a wrong colour is worse than none."
         A COLOUR AND NOT A SEAT INDEX, because the bar has no other use for the index and handing it one
         would make a second surface responsible for knowing how seats map to hues. */
      presidentColor: (() => {
        if (!company.president || !gameState) return null;
        const seat = gameState.player_addresses.indexOf(company.president);
        return seat === -1 ? null : seatColor(company.president, seat);
      })(),
      /* Design note #806: `presidentCash` is GONE from this object, with the bar tooltip that was its only
         reader. #326 resolved it here -- "the president's OWN wallet, not the treasury", null when the room
         does not report it -- and that resolution was correct while the bar was the only Operating Round
         surface naming a player's money. `PlayerCashStrip` (#670) now shows every seat's cash under the
         board, so this lookup was being done on every render of the acting corporation to feed a hover that
         duplicated a visible row. The reasoning is kept at the render site rather than here. */
      treasury: Number(company.treasury) || 0,
      // Design note #237: the row needs every token and its own price, not a
      // remaining-count. `stationTokenSlots` owns 1830's schedule.
      stationSlots: stationTokenSlots(company),
      trains: company.owned_trains ?? [],
      /* Design note #1004: the models under a Gentle Rust reprieve, straight off the corporation. The bar
         cannot derive this -- the depot outlook has already moved past the tier that doomed them -- so it is
         the one fact about the fleet that has to travel rather than be recomputed. */
      reprievedTrains: company.pending_rust_trains ?? [],
      // Design note #1046: exempt from the limit until the Operating Round ends.
      ghostTrains: company.ghost_trains ?? [],
      /* Design note #1089: the two Carcosa facts, which expire on two clocks neither of which is the one
         above. The train keeps its gold trim for an OR set past the exemption; the corporation keeps the
         curse for the rest of the game unless it sells the train. */
      carcosanTrains: company.carcosan_trains ?? [],
      isCarcosan: company.is_carcosan === true,
    };
  }, [gameState, actingProtocolId]);

  /** 1830 token prices: home free, second $40, every one after $100. null means the allowance is spent.
   *  See docs/ai_architecture/contract_economy.md - App.tsx #237 */
  const activeStationCompany = gameState?.public_companies.find(
    (company) => company.company_id === actingProtocolId,
  );
  const stationTokenCost =
    nextStationTokenCost(activeStationCompany) ?? SANDBOX_NOMINAL_TOKEN_COST;

  const [pickedRouteTrain, setPickedRouteTrain] = useState<string | null>(null);

  // A pick belongs to the corporation that made it. Clearing on a change of
  // acting corporation stops a 5-train selection surviving onto a company
  // that owns nothing bigger than a 3 -- which would silently validate the
  // next player's route against a train they do not have.
  useEffect(() => {
    setPickedRouteTrain(null);
  }, [actingProtocolId]);

  const selectedHardwareModel =
    pickedRouteTrain !== null && ownedTrainRoster.some((t) => t.model === pickedRouteTrain)
      ? pickedRouteTrain
      : bestOwnedTrain;

  // The live board. STATE, not `useMemo`, so `applySandboxLayTile` can
  // replace it with a NEW object -- that identity change is what
  // `HexGridRenderer`'s draw effect watches, and mutating `tiles` in place
  // would leave the reference untouched and the canvas would never repaint.
  const [mapGrid, setMapGrid] = useState<MapGridResponse>(MOCK_MAP_GRID);

  /* Design note #757: THE GRID GETS A REF, for #411's reason and #723's. An Undo replays the whole log in
     one burst, so a legality check reading React state would judge every lay in that burst against the board
     as it stood before the burst began -- and refuse legitimate upgrades, because the tile they upgrade would
     not be there yet. The market atom already carries a ref for exactly this ("runGameplayAction refreshes it
     mid-dispatch, so a closure over state would order the queue on stale prices"); the tile grid needed the
     same treatment the moment anything started asking it questions. */
  const mapGridRef = useRef<MapGridResponse>(mapGrid);
  useEffect(() => {
    mapGridRef.current = mapGrid;
  }, [mapGrid]);

  // The auto-follow effect is gone; in a room the seat cursor never moves. actingSeatIndex's reasoning lives in utils/gameState.ts.
  // See docs/ai_architecture/state_machine.md - App.tsx #578

  // Second poll against GetWaterfallState, enabled only during the auction. WaterfallAuctionDashboard is the only consumer.
  // See docs/ai_architecture/contract_economy.md - App.tsx #90
  const isWaterfallPhase = gameState?.current_round_type === "WaterfallAuction";
  // Audit G-15: pending corporation-to-corporation train offers. Polled
  // separately from the board because a SELLER must see an offer arrive while
  // it is emphatically not their turn -- this cannot key off turn state.
  const { offers: trainOffers, refresh: refreshTrainOffers } = useTrainOffersPolling(
    queryClient,
    CONTRACT_ADDRESS,
    gameId,
  );

  const {
    waterfallState: liveWaterfallState,
    loading: waterfallStateLoading,
    error: waterfallStateError,
  } = useWaterfallStatePolling(
    queryClient,
    CONTRACT_ADDRESS,
    gameId,
    isWaterfallPhase,
  );

  /* The auction is state, not a memo, so the five handlers have somewhere to write. A room's copy seeds empty (#542).
     See docs/ai_architecture/contract_economy.md - App.tsx #261 */
  const [sandboxWaterfall, setSandboxWaterfall] = useState<WaterfallStateResponse | null>(() => {
    if (!sandbox) return null;
    const base = sandboxWaterfallState(sandboxPhase, gameId, sandboxIsZeroState);
    // Design note #578: always a room, so always an empty roster to start.
    return waterfallForRoster(base, []);
  });
  useEffect(() => {
    /* Design note #537's guard, applied to this atom: a room's auction comes
       from the log, so the scenario re-seed must not overwrite it. */
    if (sandboxRoomCode) return;
    setSandboxWaterfall(sandbox ? sandboxWaterfallState(sandboxPhase, gameId, sandboxIsZeroState) : null);
  }, [sandbox, sandboxPhase, gameId, sandboxIsZeroState, sandboxRoomCode]);
  useEffect(() => {
    sandboxWaterfallRef.current = sandboxWaterfall;
  }, [sandboxWaterfall]);

  /* The market chart is the third sandbox atom, with the same ref treatment as the other two (#265).
     See docs/ai_architecture/stock_market.md - App.tsx #272 */
  const [sandboxMarket, setSandboxMarket] = useState<SandboxMarketPrices>(() =>
    // Design note #387: the Zero State seeds an EMPTY chart. Nothing is
    // parred at turn one, so nothing has a market position.
    sandboxInitialMarketPrices(
      marketCellForPrice,
      parBoxCellFor,
      sandboxScenario(sandboxScenarioId).zeroState,
    ),
  );
  // Re-seeded on a scenario change for the same reason the other two are:
  // picking a scenario means "show me that screen", not "carry my moved
  // tokens into it".
  useEffect(() => {
    setSandboxMarket(
      sandboxInitialMarketPrices(
      marketCellForPrice,
      parBoxCellFor,
      sandboxScenario(sandboxScenarioId).zeroState,
    ),
    );
  }, [sandbox, sandboxScenarioId, gameId]);
  const sandboxMarketRef = useRef<SandboxMarketPrices>(sandboxMarket);
  useEffect(() => {
    sandboxMarketRef.current = sandboxMarket;
  }, [sandboxMarket]);

  /* Design note #2 in `sandboxState.ts`: the cards want prices, the chart
     wants cells, and both now come off the same object so they cannot
     disagree again. */
  const sandboxMarketPrices = useMemo(
    () => sandboxMarketPriceTable(sandboxMarket),
    [sandboxMarket],
  );

  /** Reads the market REF, not the memo: runGameplayAction refreshes it mid-dispatch, so a closure over state would order the queue on stale prices.
   *  See docs/ai_architecture/stock_market.md - App.tsx #411 */
  const marketPriceForCompany = useCallback(
    (companyId: number): number | null => sandboxMarketRef.current[companyId]?.price ?? null,
    [],
  );

  /* Operating-order tie-breaks read the same ref as the price, for the same reason (#411/#647).
     See docs/ai_architecture/stock_market.md - App.tsx #646 */
  const marketMarkForCompany = useCallback(
    (companyId: number) => sandboxMarketRef.current[companyId] ?? null,
    [],
  );

  /** The board's label to (q,r) table, hoisted (#416) so the float and the home-station prompt share one mapping.
   *  See docs/ai_architecture/canvas_rendering.md - App.tsx #363 */
  const homeHexToAxial = useCallback((label: string): readonly [number, number] | null => {
    const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
    return hex ? ([hex.q, hex.r] as const) : null;
  }, []);

  /* ==================================================================
     DESIGN NOTE 762: A REF IS ONLY AN ESCAPE HATCH FOR CALLBACKS
     ==================================================================
     REPORTED: "ReferenceError: can't access lexical declaration 'tr' before initialization" inside a
     `useMemo`, crashing both clients to a white screen when a share was bought while a home station was
     still unplaced.
     #730 CREATED THIS REF AND PUT IT IN THE WRONG PLACE, and its own note says why it thought that was safe:
     "three of the four places that need it are callbacks defined ABOVE it ... reordering the file for one
     dependency is a worse trade than naming the indirection." That is correct for a CALLBACK, whose body
     runs long after every declaration exists. It is false for a MEMO, whose body runs during the render pass
     at the line where the memo is created -- so `couldRunARouteIfItHadATrain` below was reading a `const`
     that was still in its temporal dead zone.
     THE FOURTH PLACE WAS A MEMO AND GOT SWEPT IN WITH THE THREE CALLBACKS. Nothing in the type system says
     so: TypeScript catches a direct use-before-declaration and cannot catch one inside a closure, because it
     has no way to know when the closure runs.
     WHY IT TOOK A PLAYTEST TO FIND. The memo returns early when the acting corporation holds no station
     token, so the throw is unreachable until somebody's token is on the board -- which in Stock Round 1 is
     exactly the moment the report describes.
     THE FIX IS THE DECLARATION MOVING UP, not another indirection. A `useRef` has no dependencies and can
     sit anywhere; hook ORDER only has to be stable between renders, which it is. */
  const blocksThroughCityRef = useRef<((q: number, r: number, city: number) => boolean) | undefined>(
    undefined,
  );

  /* Declared here because it reads sandboxMarketPrices and const bindings are not hoisted. Emergency = obliged AND cannot afford; #433 adds "and has a route to run".
     See docs/ai_architecture/contract_economy.md - App.tsx #332 */
  const couldRunARouteIfItHadATrain = useMemo(() => {
    const corporation = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    /* Design note #852: TOKENS, NOT HEXES. `station_token_hexes` drops the city index, and on New York that
       is the difference between NNH's own city and the disconnected one beside it. `stationTokensOf` is the
       same reader the network walk uses (#686), so the router and the veil agree about where a route may
       begin. */
    const startHexes = corporation ? stationTokensOf(corporation) : [];
    if (startHexes.length === 0) return false;

    const result = assignRouteSet({
      // Design note #730: a tokened-out city is a terminus, so no drafted route runs past one.
      blocksThrough: blocksThroughCityRef.current,
      mapGrid,
      era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
      startHexes,
      // The cheapest train in the depot -- see the note above on why the
      // smallest hypothetical is the correct one.
      trains: [{ trainIndex: 0, maxRevenueCentres: 2 }],
    });
    return result.totalRevenue > 0;
  }, [gameState, actingProtocolId, mapGrid, currentPhase]);

  /** Design note #433: BOTH conditions. Owning no train is necessary and was
   *  being treated as sufficient. */
  const mustBuyTrain = trainlessAndReported && couldRunARouteIfItHadATrain;

  const emergencyPurchasePlan = useMemo(() => {
    /* Three conditions, not one: an Operating Round, the Hardware step, and a treasury below the cheapest depot train.
       See docs/ai_architecture/contract_economy.md - App.tsx #358 */
    if (!mustBuyTrain || !gameState) return null;
    if (gameState.current_round_type !== "OperatingRound") return null;
    if (orSubPhase !== "Hardware") return null;
    const corporation = gameState.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    if (!corporation) return null;

    const cheapest = depotInventory(gameState).find(
      (row) => !row.rusted && (row.remaining === null || row.remaining > 0),
    );
    if (!cheapest) return null;

    const treasury = Number(corporation.treasury) || 0;
    // No shortfall, no emergency: the ordinary Buy Trains panel handles it.
    if (treasury >= cheapest.cost) return null;

    return buildEmergencyPurchasePlan({
      state: gameState,
      corporation,
      trainModel: cheapest.tier,
      trainCost: cheapest.cost,
      priceForCompany: (companyId) => (sandbox ? (sandboxMarketPrices[companyId] ?? null) : null),
      labelForAddress: (address) => sandboxPlayerLabel(address) ?? truncateAddress(address),
    });
  }, [mustBuyTrain, gameState, orSubPhase, actingProtocolId, sandbox, sandboxMarketPrices]);

  /* ==================================================================
   *  DESIGN NOTE 751b: THE PLAN IS NO LONGER THE MOUNT CONDITION
   * ==================================================================
   *
   * #3 read "the plan IS the mount condition; there is no dismissal", which enforced the obligation by
   * removing every other way of meeting it. #751 moves the enforcement to Pass, so the modal opens when the
   * president ASKS for it -- because buying a rival's train is the other legal answer and it lives on a
   * different panel.
   *
   * ONE EXCEPTION, AND IT IS #751a's: when the president cannot raise the money by any legal combination
   * there is nothing to choose, so the modal opens itself. Leaving that behind a button would let a player
   * who has already lost decline to press it and stall the table indefinitely, which is the exact failure
   * the report asks to prevent. */
  const [emergencyModalOpen, setEmergencyModalOpen] = useState(false);

  const emergencyForced =
    emergencyPurchasePlan !== null && noDecisionRemains(emergencyPurchasePlan);

  /* Closing the Hardware step closes the modal with it: a plan that has gone away cannot be acted on, and a
     modal outliving its plan would be a dialog about a turn that has ended. */
  useEffect(() => {
    if (emergencyPurchasePlan === null) setEmergencyModalOpen(false);
  }, [emergencyPurchasePlan]);

  const emergencyModalPlan =
    emergencyModalOpen || emergencyForced ? emergencyPurchasePlan : null;

  /* Two endings, both derived: bankruptcy is read off the emergency plan and wins over a broken bank.
     See docs/ai_architecture/state_machine.md - App.tsx #359 */
  const gameEndReason = useMemo<GameEndReason | null>(() => {
    if (emergencyPurchasePlan?.bankrupt) return "bankruptcy";
    /* ==================================================================
        DESIGN NOTE 898: THE ROUND SAYS SO, NOT THE BANK BALANCE
       ==================================================================
       WAS `sandbox && bankIsBroken(gameState)`, which ended the game the instant a payout emptied the bank --
       mid-turn, with corporations still owed their runs. The rule 1830 actually has is that the current
       Operating Round SET finishes first, and a derivation over the bank balance has no way to express a
       calendar.
       The reducer now owns it: `settleRoundTransitions` enters `GameEnd` when the first OR set completes at
       or after the break, which covers both reported cases with one condition. This reads that decision
       rather than re-deriving it -- two surfaces answering one question two ways is the bug this codebase
       produces most, and the bank balance is still sitting right there to be asked. */
    if (gameState?.current_round_type === "GameEnd") return "bank-broken";
    return null;
  }, [emergencyPurchasePlan, gameState]);

  const bankruptLabel = emergencyPurchasePlan?.bankrupt
    ? emergencyPurchasePlan.presidentLabel
    : null;

  /** Design note #3 in `endgame.ts`: cash, shares at market, privates at
   *  face. Computed only once the game has actually ended -- ranking four
   *  players on every render of a live game is work nobody is looking at. */
  const finalStandings = useMemo(() => {
    if (!gameEndReason || !gameState) return [];
    return rankPlayers({
      state: gameState,
      priceForCompany: (companyId) => (sandbox ? (sandboxMarketPrices[companyId] ?? null) : null),
      labelForAddress: (address) => sandboxPlayerLabel(address) ?? truncateAddress(address),
      bankruptAddress: emergencyPurchasePlan?.bankrupt
        ? emergencyPurchasePlan.presidentAddress
        : null,
      totalAnte: PLACEHOLDER_TOTAL_ANTE,
    });
  }, [gameEndReason, gameState, sandbox, sandboxMarketPrices, emergencyPurchasePlan]);

  /* Design note #899: HOISTED ABOVE ITS FIRST READER. `closeRoom` below calls through this ref, and it was
     declared two thousand lines lower -- fine for the callers that came after it, a temporal-dead-zone error
     for one that comes before. Moving the declaration is safer than moving the closure block, which depends
     on the standings above it. */
  const runGameplayActionRef = useRef<
    | ((
        fallbackLabel: string,
        msg: SandboxLogMsg,
        options?: { automatic?: boolean },
      ) => Promise<void> | void)
    | null
  >(null);

  /* Design note #899: mirrored for the closure handler, which runs inside a dispatch. */
  finalStandingsRef.current = finalStandings;

  /** Design note #899: the room's closure, and whether anything is still counting down toward it. */
  const roomClosed = gameState?.room_closed === true;

  /* ==================================================================
      DESIGN NOTE 899: EVERY CLIENT COUNTS DOWN, AND THAT IS THE POINT
     ==================================================================
     A single elected timekeeper dies with their browser tab, and then the room is held hostage by exactly the
     person the countdown was meant to route around. So all of them count, all of them dispatch, and the
     reducer takes the first -- #546's rule, which argued this before the countdown existed.
     THE DEADLINE IS DERIVED FROM WHEN THE GAME ENDED, not from when this effect mounted. A player who opens
     the tab ten minutes late must not restart the clock, and one who refreshes must not either. */
  const [gameEndedAt, setGameEndedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!gameEndReason) {
      setGameEndedAt(null);
      return;
    }
    setGameEndedAt((current) => current ?? Date.now());
  }, [gameEndReason]);

  useEffect(() => {
    if (!gameEndReason || roomClosed || gameEndedAt === null) return undefined;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [gameEndReason, roomClosed, gameEndedAt]);

  const autoCloseRemaining =
    gameEndedAt === null || roomClosed ? null : Math.max(0, gameEndedAt + AUTO_CLOSE_MS - now);

  const closeRoom = useCallback((trigger: "manual" | "timer") => {
    /* The trigger is stamped on a ref rather than carried in the message, and deliberately: it describes
       which CLIENT dispatched, which is local colour for the payout log line. Putting it in the payload
       would make it part of the shared log, where four clients would write four different answers to a
       question about one closure.
       THROUGH THE REF, like `handleProceedToStockRound`: `runGameplayAction` is declared two thousand lines
       below and a callback body reads the ref at call time rather than at declaration time.
       `automatic`, for the same reason the auction close is -- closing a finished room belongs to nobody's
       turn, so the turn gate has no rotation to check it against. */
    closeRoomTriggerRef.current = trigger;
    void runGameplayActionRef.current?.("closing the room", { CloseRoom: {} }, { automatic: true });
  }, []);

  useEffect(() => {
    if (autoCloseRemaining === null || autoCloseRemaining > 0) return;
    closeRoom("timer");
  }, [autoCloseRemaining, closeRoom]);

  /* ==================================================================
      DESIGN NOTE 905: THE SHELL'S AUCTION ATOM FOLLOWS THE REDUCER'S ROUND
     ==================================================================
     `waterfall_auction_active` lives on the shell's own atom rather than on `GameStateResponse`, so the
     reducer cannot set it when it moves the round to `WaterfallAuction` before Stock Round 3. This is the
     shell catching up -- the same direction #542 already runs in, with the reducer as the authority.
     A CONDITION, NOT AN EVENT, which is what makes it safe under #656's rule. It asks "is the round an
     auction that has not concluded" rather than watching for an edge, so a replay, a refresh and a late
     joiner all arrive at the same answer without anything having had to observe the transition happen. */
  useEffect(() => {
    if (gameState?.current_round_type !== "WaterfallAuction") return;
    if (gameState.private_auction_complete === true) return;
    const atom = sandboxWaterfallRef.current;
    if (!atom || atom.waterfall_auction_active) return;
    const armed = { ...atom, waterfall_auction_active: true };
    sandboxWaterfallRef.current = armed;
    setSandboxWaterfall(armed);
  }, [gameState?.current_round_type, gameState?.private_auction_complete]);

  /* Design note #900: dismissed, not destroyed. Re-armed whenever a NEW ending arrives so an Undo back into
     play and a second ending does not open silently behind a dismissal from the first. */
  const [gameOverDismissed, setGameOverDismissed] = useState(false);
  useEffect(() => {
    if (!gameEndReason) setGameOverDismissed(false);
  }, [gameEndReason]);

  const waterfallState = sandboxWaterfall ?? liveWaterfallState;

  // Resets the OR sub-phase on a genuine turn change. #385: never seed a step visibleSubPhases has dropped.
  // See docs/ai_architecture/state_machine.md - App.tsx #10
  useEffect(() => {
    /* This effect seeds a turn's opening step and cannot tell a mid-turn phase change from a new turn - fenced by the reducer's own cursor when it has one.
       See docs/ai_architecture/state_machine.md - App.tsx #656 */
    if (gameState?.operating_sub_phase !== undefined) return;
    const steps = visibleSubPhases(
      gameState?.current_global_era,
      gameState?.private_companies,
      // Design note #613: the phase number is the rule; the era is the
      // fallback when no corporation has reported a train yet.
      currentPhase?.known ? currentPhase.tier : null,
    );
    /* The sandbox "always open on Track" shortcut is gone with solo mode: skipping BuyPrivate in a real game is a rule not applied.
       See docs/ai_architecture/state_machine.md - App.tsx #574 */
    const opening = initialOrSubPhase(gameState?.current_global_era);
    setLiveOrSubPhase(steps.includes(opening) ? opening : steps[0]);
  }, [
    // Design note #656: the guard's own input, so the effect re-evaluates
    // the moment a room starts reporting a reducer-owned cursor.
    gameState?.operating_sub_phase,
    gameState?.current_round_type,
    gameState?.active_corporation_index,
    gameState?.current_global_era,
    gameState?.private_companies,
    currentPhase?.known,
    currentPhase?.tier,
    sandbox,
    sandboxRoomCode,
  ]);

  // Fires only on a genuine round-type transition (compared against prevRoundTypeRef), so it never overrides a manual tab click.
  // See docs/ai_architecture/state_machine.md - App.tsx #213
  useEffect(() => {
    const currentRoundType = gameState?.current_round_type ?? null;
    const previousRoundType = prevRoundTypeRef.current;
    if (currentRoundType !== previousRoundType) {
      prevRoundTypeRef.current = currentRoundType;
      // Design note #213: jump to the surface the new round is played on.
      // The four-way branch that stood here is now one lookup shared with
      // the availability guard below, which is what stops the two from
      // disagreeing about where a Stock Round lands.
      setActiveMainTab(surfaceTabFor(currentRoundType));

      /* Design note #331 paid the privates on this edge, and design note #685 moved that into the reducer.
         THE REF IS WHY IT HAD TO MOVE. `prevRoundTypeRef` survives `rebuildSandbox`, so after a rebuild it still
         read "OperatingRound" while the replay ended in one -- no edge, no payout, and no error anywhere. This
         effect's OWN job is unaffected by that: picking a tab is idempotent and a missed edge just leaves the
         player where they were. Moving money on a missed edge is silent, permanent and different per client.
         See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #685 */
    }
  }, [gameState?.current_round_type]);

  // Correctness guard: the tab set changes shape by phase, so the active tab can cease to exist under the player.
  // See docs/ai_architecture/state_machine.md - App.tsx #28
  useEffect(() => {
    const roundType = gameState?.current_round_type ?? null;
    if (!isTabAvailable(activeMainTab, roundType)) {
      // Ask surfaceTabFor for the round's own surface; a hardcoded "map" silently overrode the transition effect.
      // See docs/ai_architecture/state_machine.md - App.tsx #213
      setActiveMainTab(surfaceTabFor(roundType));
    }
  }, [activeMainTab, gameState?.current_round_type]);

  // vgpBalance and the whole optimistic-note chain are deleted with the top-bar Cash readout.
  // See docs/ai_architecture/ui_shell_layout.md - App.tsx #34

  /* `activePlayerAddress` went with design note #165's tray. It answered
     "whose privates can be sold right now", which only made sense while the
     tray was scoped to the acting player; the proposal sheet shops across
     every player's holdings, so the question no longer has a caller. */

  // Turn alerts are mandatory and key directly off isMyTurn. F-5: isMyTurn must be round-type aware - an OR's acting entity is a corporation's president, not the SR pointer. #544: resolved from actingAddress, since a mini-auction suspends the rotation.
  // See docs/ai_architecture/state_machine.md - App.tsx #21
  const isMyTurn = useMemo(() => {
    if (!viewerAddress || !gameState) return false;
    return actingAddress(gameState, waterfallState) === viewerAddress;
  }, [viewerAddress, gameState, waterfallState]);

  useDocumentTitleFlash(isMyTurn);

  /* Design note #1008: THE GLOW'S CONDITION, computed once here and passed down, so the full-viewport overlay
     and the action bar's lit border cannot disagree about whether the player has acknowledged their turn.
     Two surfaces answering one question two ways is this codebase's most frequent bug (#891), and these two
     are the same signal drawn in two places -- a player who dismissed one and kept the other would read it as
     the animation failing to clear rather than as two features. */
  const turnGlowActive = useTurnGlowActive(isMyTurn);

  /* ==================================================================
      DESIGN NOTE 1009: THE THIRD TURN ALERT, ON THE SAME SIGNAL AS THE OTHER TWO
     ==================================================================
     REQUESTED: "Wire the train whistle SFX to fire exactly once when the game state changes to 'Your Turn'
     (the exact same state that triggers the visual tab alerts)."

     "THE EXACT SAME STATE" IS THE INSTRUCTION AND IT IS ALSO THE ARCHITECTURE. `isMyTurn` is one value, and
     the title flash (#1008), the screen glow and now the whistle all take it from here rather than each
     working out whose turn it is. Three notifications that could disagree about that would be three bugs
     waiting, and #891's shape is the one this codebase produces most.

     THE MUTE IS SEPARATE FROM THE MUSIC, per the report: two toggles, two pieces of state, no shared
     "audio on". SFX default ON because a whistle needs no network and no autoplay permission until the edge
     fires -- and if the browser refuses it before the player's first click, `playQuietly` swallows it. Music
     defaults OFF, which is the autoplay rule stated as an initial value rather than enforced by a try/catch. */
  const [sfxEnabled, setSfxEnabled] = useState(true);
  /** Design note #1043: the clip currently haunting the board, or `null`. Held in the shell because the
   *  event that raises it is a dispatch, and cleared by its own timer rather than by the next render.
   *
   *  ==================================================================
   *   DESIGN NOTE 1093: ONE OBJECT, BECAUSE THE THREE FACTS ARRIVE TOGETHER
   *  ==================================================================
   *
   * WAS `hauntingSrc: string | null`, which was the whole of it while every clip was composited the same way.
   * The fog clip needs a different treatment and a different window (`variantSfx.ts` #1093), and the obvious
   * change -- a second and third `useState` beside this one -- is #891's shape exactly: three pieces of state
   * that must agree, set from one place and read from another, with nothing making them agree.
   * SO THEY ARE ONE VALUE. A clip, how to composite it, and how long it stays are a single fact about a
   * single event, and they are set and cleared together. */
  const [haunting, setHaunting] = useState<{
    src: string;
    composite: HauntingComposite;
    ms: number;
  } | null>(null);
  /* Design note #1040: read inside a dispatch handler long after the commit that set it, so refs rather than
     the state -- the same reason `useSoundEffect` holds its mute in one (#1009). */
  const sfxEnabledRef = useRef(sfxEnabled);
  sfxEnabledRef.current = sfxEnabled;
  const hauntingTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (hauntingTimerRef.current !== null) window.clearTimeout(hauntingTimerRef.current);
    },
    [],
  );
  const radio = useRadioStream(RADIO_STREAM_URL);

  /* ==================================================================
      DESIGN NOTE 1075: THE MIX IS THE PLAYER'S NOW, AND SO IS WHAT COUNTS AS AN EFFECT
     ==================================================================
     THREE CATEGORIES, RULED: turn notification, revenue events, payouts. Held here rather than in `audio.ts`
     because they gate WHICH CALLS HAPPEN rather than how loud a call is -- the engine plays what it is asked
     to play, and deciding whether to ask is the shell's job. That division is why `playVariantCue` still
     takes a single `enabled` boolean: every caller passes its own category ANDed with the master.
     MIRRORED INTO REFS for #967a's reason, the same one every other viewer read in this file has: the cue
     sites live inside `runGameplayAction`, a long-lived `useCallback`, and a closure read there would answer
     with whatever the settings were when the callback was built. */
  const [sfxTurnEnabled, setSfxTurnEnabled] = useState(true);
  const [sfxRevenueEnabled, setSfxRevenueEnabled] = useState(true);
  const [sfxPayoutEnabled, setSfxPayoutEnabled] = useState(true);
  const [sfxVolume, setSfxVolumeState] = useState(SFX_VOLUME);
  const [radioVolume, setRadioVolumeState] = useState(RADIO_VOLUME);
  const sfxRevenueRef = useRef(sfxRevenueEnabled);
  sfxRevenueRef.current = sfxRevenueEnabled;
  const sfxPayoutRef = useRef(sfxPayoutEnabled);
  sfxPayoutRef.current = sfxPayoutEnabled;

  /* Design note #1075: the master AND this cue's own category -- the same shape at all three cue sites.
     BELOW THE STATE, deliberately: this used to sit beside `useRadioStream` and the category it now reads is
     declared here, so the call moved rather than the declaration. Hook ORDER is unchanged relative to every
     other hook in this component, which is the only thing React cares about. */
  useTurnWhistle(isMyTurn, sfxEnabled && sfxTurnEnabled);

  /* Design note #1075: the slider writes THROUGH to the engine as well as into React state. The engine holds
     what the elements actually play at (`audio.ts` #1074) and React holds what the slider draws; a single
     source would mean either the non-component callers reaching into a hook or the slider reading a module
     variable it cannot re-render on. */
  const handleSfxVolume = useCallback((value: number) => {
    setSfxVolumeState(value);
    setSfxVolume(value);
  }, []);
  const handleRadioVolume = useCallback((value: number) => {
    setRadioVolumeState(value);
    setRadioVolume(value);
  }, []);

  const audioControls = useMemo(
    () => ({
      musicPlaying: radio.playing,
      onToggleMusic: radio.toggle,
      sfxEnabled,
      onToggleSfx: () => setSfxEnabled((on) => !on),
      radioVolume,
      onRadioVolume: handleRadioVolume,
      sfxVolume,
      onSfxVolume: handleSfxVolume,
      sfxCategories: [
        {
          key: "turn",
          label: "Turn notification",
          hint: "The whistle that sounds when your turn begins.",
          enabled: sfxTurnEnabled,
          onChange: setSfxTurnEnabled,
        },
        {
          key: "revenue",
          label: "Revenue events",
          hint: "The Unpredictable Revenue variant's flavour cues, on every corporation's run.",
          enabled: sfxRevenueEnabled,
          onChange: setSfxRevenueEnabled,
        },
        {
          key: "payouts",
          label: "Payouts",
          hint: "The cash register when a dividend reaches you.",
          enabled: sfxPayoutEnabled,
          onChange: setSfxPayoutEnabled,
        },
      ],
    }),
    [
      radio.playing,
      radio.toggle,
      sfxEnabled,
      radioVolume,
      handleRadioVolume,
      sfxVolume,
      handleSfxVolume,
      sfxTurnEnabled,
      sfxRevenueEnabled,
      sfxPayoutEnabled,
    ],
  );

  /* Mirrored into a ref: a dependency would rebuild runGameplayAction and re-arm the two effects that dispatch (#439).
     See docs/ai_architecture/session_keys_wallet.md - App.tsx #536 */
  const isMyTurnRef = useRef(isMyTurn);
  useEffect(() => {
    isMyTurnRef.current = isMyTurn;
  }, [isMyTurn]);

  /* Design note #549a: the seat on turn, for stamping automatic dispatches.
     A ref for design note #536's reason -- naming it as a dependency of
     `runGameplayAction` would rebuild the callback every turn, and two
     effects that DISPATCH key on that callback's identity. */
  const actingAddressRef = useRef<string | null>(null);
  useEffect(() => {
    actingAddressRef.current = gameState ? actingAddress(gameState, waterfallState) : null;
  }, [gameState, waterfallState]);

  /** The acting seat's cash; null when unknown, never $0. During the auction this is AVAILABLE cash, not the total (#317).
   *  See docs/ai_architecture/contract_economy.md - App.tsx #300 */
  const activeSeatCash = useMemo(() => {
    if (!gameState) return null;
    // Design note #544: during a contest this is the CONTESTANT's balance --
    // the figure sits beside the Raise control that would spend it.
    const address = actingAddress(gameState, waterfallState);
    if (!address) return null;
    return availableCash(gameState, waterfallState, address);
  }, [gameState, waterfallState]);

  /* Spendable cash per address for the inactive seats on the trail. A map, not an array - every consumer looked up by address.
     See docs/ai_architecture/ui_shell_layout.md - App.tsx #639 */
  const seatFunds = useMemo(() => {
    const table = new Map<string, { available: number; escrowed: number }>();
    if (!gameState) return table;
    if (
      gameState.current_round_type !== "WaterfallAuction" &&
      gameState.current_round_type !== "StockRound"
    ) {
      return table;
    }
    for (const address of gameState.player_addresses) {
      table.set(address, {
        available: availableCash(gameState, waterfallState, address) ?? 0,
        escrowed: escrowedBids(waterfallState, address),
      });
    }
    return table;
  }, [gameState, waterfallState]);

  /** What the acting seat has locked in standing bids, for the badge's
   *  tooltip. Zero outside the auction. */
  const activeSeatEscrow = useMemo(() => {
    if (!gameState) return 0;
    const address = actingAddress(gameState, waterfallState); // design note #544
    return address ? escrowedBids(waterfallState, address) : 0;
  }, [gameState, waterfallState]);

  /* The auction is over when nothing is left in it; there is no separate finished flag. Sandbox only (#306).
     See docs/ai_architecture/contract_economy.md - App.tsx #547 */
  const auctionHandoffPending =
    sandbox &&
    gameState?.current_round_type === "WaterfallAuction" &&
    (waterfallState?.privates.length ?? -1) === 0;

  /* The modal asks the board, not a flag, so a replay cannot re-raise an answered prompt. The latch stays only to say WHO may answer.
     See docs/ai_architecture/firebase_middleware.md - App.tsx #565 */
  const boParAlreadySet =
    (gameState?.public_companies.find((c) => c.ticker === BO_TICKER)?.par_value ?? null) !== null;

  /** Whose turn it is, as a name. `null` outside a seat-driven round or
   *  when the room has not started -- the header then shows nothing rather
   *  than an empty label. */
  const activeSeatLabel = useMemo(() => {
    if (!gameState) return null;
    const address = actingAddress(gameState, waterfallState); // design note #544
    if (!address) return null;
    return sandboxPlayerLabel(address) ?? truncateAddress(address);
  }, [gameState, waterfallState]);

  /* Clear half-made par choices when the acting seat changes, or an incoming player inherits a price they never picked.
     See docs/ai_architecture/stock_market.md - App.tsx #398 */
  useEffect(() => {
    setSrParValues({});
  }, [activeSeatLabel]);

  const [sandboxRoom, setSandboxRoom] = useState<SandboxRoomDoc | null>(null);

  /* ==================================================================
     DESIGN NOTE 764: `null` MEANT TWO THINGS AND THE SCREEN PICKED THE WRONG ONE
     ==================================================================
     REPORTED: "When players enter the room key and hit 'Join Game' it briefly takes them to the Auction round
     screen before flashing back to the waiting lobby."
     `sandboxRoom` STARTS AT `null` AND STAYS THERE UNTIL THE FIRST SNAPSHOT, and the waiting-room gate reads
     `sandboxRoom?.status === "waiting"`. So for one round trip the answer is "not waiting", the gate falls
     through, and the board renders on its seeded state -- which is a Waterfall Auction. The snapshot then
     lands, the gate matches, and the waiting room replaces it. That whole flash is the app confidently
     answering a question it did not have the data for.
     THE FIX IS A THIRD STATE, not a longer condition. `null` was carrying "no such room" and "have not heard
     yet", and those want opposite screens: the first is an error, the second is a wait. Distinguishing them
     is what lets the gate say "I do not know" instead of guessing.
     RESET ON THE CODE, not on the doc: joining a second room must go back to not-knowing rather than
     inheriting the previous room's answer. */
  const [sandboxRoomResolved, setSandboxRoomResolved] = useState(false);
  useEffect(() => {
    setSandboxRoomResolved(false);
  }, [sandboxRoomCode]);


  /* ==================================================================
     DESIGN NOTE 765: THE CHAT WAS GIVEN THE WRONG NAME
     ==================================================================
     REPORTED: "in the chat box, rather than our display names, the log reads: '[8:41 AM]p-y1p43wnz hello'".
     TWO NAMES EXIST AND THE CHAT ASKED FOR THE ONE THAT IS EMPTY. `displayName` is the LOBBY name, saved to
     local storage on the lobby screen; a sandbox room's name of record is the ROSTER NICKNAME, set in the
     waiting room and written to the room document by `upsertSandboxPlayer`. A player who joins a room by code
     never touches the lobby field, so `displayName` is "" and `seatLabel` falls back to `truncateAddress` --
     which in sandbox mode is truncating a local player id rather than a wallet.
     THE ROSTER IS ALREADY THE AUTHORITY EVERYWHERE ELSE: `SetupGame` maps `player.id` to `player.nickname`
     when it seeds the game, so the seat labels on the board have been right all along and only the chat was
     reading a different field.
     THESE THREE DECLARATIONS MOVED UP FOR THIS, and #762 is why that is worth a sentence: the chat hook's
     arguments are evaluated during render, so reading `sandboxRoom` from six hundred lines below would be a
     temporal dead zone -- the same fault that white-screened the game two reports ago. `tsc` catches the
     direct form, which is the only reason this one was cheap. */
  const sandboxChatName =
    (sandbox
      ? sandboxRoom?.players?.find((player) => player.id === localId)?.nickname
      : undefined) ?? displayName;

  // Chat state lives here so it can merge with actionLog via mergeFeedItems. Keyed on roomId (Firestore), not gameId (contract).
  // See docs/ai_architecture/firebase_middleware.md - App.tsx #22
  const {
    messages: chatMessages,
    sendMessage: sendChatMessage,
    error: chatError,
    // The sandbox gets its own room and its own identity: localId is the author, matching the action log's actor.
    // See docs/ai_architecture/firebase_middleware.md - App.tsx #644
  } = useFirestoreChat(
    sandbox ? sandboxRoomCode : roomId,
    sandbox ? localId : wallet.address,
    // Design note #765: the roster nickname in a sandbox room, the lobby name outside one.
    sandboxChatName,
    sandbox ? SANDBOX_ROOMS_COLLECTION : undefined,
  );
  const [chatDraft, setChatDraft] = useState("");
  // Renamed from `feedOpen` -- design note #20/item 1. Same boolean role,
  // now gates `TopTicker.tsx`'s in-place accordion body instead of a
  // modal's mount state.
  /* Design note #598: the message box, hidden until asked for. */
  const [isChatOpen, setIsChatOpen] = useState(false);

  /* The dock's real height is measured by a ResizeObserver and reserved as root padding; #605 also scrolls the page by the delta, in a layout effect, so the growth does not cover content.
     See docs/ai_architecture/ui_shell_layout.md - App.tsx #599 */
  const statusDockRef = useRef<HTMLDivElement | null>(null);
  const [statusDockHeight, setStatusDockHeight] = useState(96);
  const measuredDockHeightRef = useRef<number | null>(null);
  const pendingDockScrollRef = useRef(0);
  useEffect(() => {
    const node = statusDockRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      const next = node.getBoundingClientRect().height;
      const previous = measuredDockHeightRef.current;
      // Sub-pixel churn from fractional layout is not a resize anyone asked
      // about, and compensating for it would fight the scroller.
      if (previous !== null && Math.abs(next - previous) < 1) return;
      if (previous !== null) pendingDockScrollRef.current += next - previous;
      measuredDockHeightRef.current = next;
      setStatusDockHeight(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const delta = pendingDockScrollRef.current;
    if (delta === 0) return;
    pendingDockScrollRef.current = 0;
    // `scrollBy` clamps itself at both ends, so a collapse at the top of the
    // page is a no-op rather than a negative scroll.
    window.scrollBy(0, delta);
  }, [statusDockHeight]);
  const [isTickerExpanded, setIsTickerExpanded] = useState(false);
  const [feedFilter, setFeedFilter] = useState<FeedFilter>("all");
  // Counts CHAT items seen, not feed items - the two figures are subtracted, so they must share units.
  // See docs/ai_architecture/ui_shell_layout.md - App.tsx #616
  const [lastSeenFeedCount, setLastSeenFeedCount] = useState(0);

  const feedItems = useMemo(() => mergeFeedItems(chatMessages, actionLog), [chatMessages, actionLog]);
  // Filtered by the pills InlineQuickChat drives; the preview and the expanded history both read this array.
  // See docs/ai_architecture/ui_shell_layout.md - App.tsx #20
  const filteredFeedItems = useMemo(
    () => (feedFilter === "all" ? feedItems : feedItems.filter((item) => item.kind === feedFilter)),
    [feedItems, feedFilter],
  );
  const latestFeedItem = filteredFeedItems.length > 0 ? filteredFeedItems[filteredFeedItems.length - 1] : null;
  /* The badge counts unread CHAT off the unfiltered feed: a log entry is a record, not a queue somebody is owed.
     See docs/ai_architecture/ui_shell_layout.md - App.tsx #616 */
  const chatItemCount = useMemo(
    () => feedItems.reduce((total, item) => (item.kind === "chat" ? total + 1 : total), 0),
    [feedItems],
  );
  const unreadFeedCount = isTickerExpanded ? 0 : Math.max(0, chatItemCount - lastSeenFeedCount);

  // Marks everything as "seen" the moment the accordion is expanded (and
  // keeps it marked as items keep arriving while it stays expanded), so
  // the unread badge is always 0 while `isTickerExpanded` is true and only
  // starts counting again once it's collapsed.
  useEffect(() => {
    if (isTickerExpanded) {
      setLastSeenFeedCount(chatItemCount);
    }
  }, [isTickerExpanded, chatItemCount]);

  const handleToggleTickerExpand = useCallback(() => setIsTickerExpanded((prev) => !prev), []);

  // Pushes to games/{roomId}/chat; the draft clears optimistically because the write is optimistic too.
  // See docs/ai_architecture/firebase_middleware.md - App.tsx #22
  const handleSendChatMessage = useCallback(() => {
    const text = chatDraft.trim();
    if (!text) return;
    setChatDraft("");
    void sendChatMessage(text);
  }, [chatDraft, sendChatMessage]);

  /* The old inline tray's five state atoms are gone - the proposal sheet owns its own selection and reads every player's privates.
     See docs/ai_architecture/contract_economy.md - App.tsx #165 */


  /* The round as a short tag, lifted to utils/roundLabel.ts (#643/#659) so a log writer can ask about the state an action resolved to.
     See docs/ai_architecture/state_machine.md - App.tsx #343 */
  /* Design note #958: the STAMP, which carries the Operating Round's step. `roundLabelFor` is still what the
     round-transition announcements below use -- they are about a round starting, where no step applies. */
  const roundLabel = useMemo(() => roundStampFor(gameState), [gameState]);

  /* Read through a ref so the stamp is taken at write time, not closed over when the callback was built.
     See docs/ai_architecture/state_machine.md - App.tsx #343 */
  const roundLabelRef = useRef<string | null>(null);
  useEffect(() => {
    roundLabelRef.current = roundLabel;
  }, [roundLabel]);

  // Tile-selection state. previewTile is lifted here so it can be threaded into <HexGridRenderer>.
  // See docs/ai_architecture/canvas_rendering.md - App.tsx #7
  const [hexClickQuery, setHexClickQuery] = useState<HexClickQueryState | null>(null);
  /* Design note #831's `canvasPaneRef` is DELETED by #833. It was attached to `<main>`, which contains the
     action bar itself as well as the board -- so the node the bar observed as "the map" had the bar at its
     top edge and ran the length of the page. The jump target is `boardEl` below, which is the board pane and
     nothing else, and which the shell already held in state for the radial selector. */

  const [previewTile, setPreviewTile] = useState<
    {
      q: number;
      r: number;
      tileId: number;
      orientation: number;
      /** Design note #824: which city the token on this hex is being placed into, when that is a choice at
       *  all. `undefined` on every ordinary lay -- the index is preserved and there is nothing to pick.
       *  Design note #886: THE ACTING CORPORATION'S ONLY. It was being applied to every token on the hex,
       *  which is the same fault #880 removed from the wire -- see `tokenCities` below. */
      tokenCity?: number;
      /** Design note #886: `[company_id, city_index]` for EVERY token standing here, derived from
       *  connectivity at THIS orientation (#878). The board draws from it and the lay sends it, so the ghost
       *  and the dispatch cannot disagree about where a marker lands. */
      tokenCities?: ReadonlyArray<[number, number]>;
    } | null
  >(null);

  /** The board's DOM node, for anchoring the radial ring to the canvas
   *  rather than to the viewport. A callback ref rather than `useRef` so a
   *  re-mount re-measures instead of holding a stale node. */
  const [boardEl, setBoardEl] = useState<HTMLDivElement | null>(null);

  /** INSPECTING the board is open to anyone in any OR sub-phase; ACTING keeps every restriction (canLayTileNow).
   *  See docs/ai_architecture/canvas_rendering.md - App.tsx #437 */
  const tileInspectorArmed =
    (gameState?.current_round_type ?? null) === "OperatingRound";

  /** The Lay Track step proper -- what the veil and the legal-placement
   *  reach are about. Distinct from `tileInspectorArmed` above: this is the
   *  step, that is permission to look at it. */
  const tileLayStepActive =
    !spectator && tileInspectorArmed && orSubPhase === "Track";

  /* The Lay Track veil. undefined outside Lay Track, and undefined when the reach is unknowable - dimming everything reads as broken.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #224 */
  /* Design note #725: the D&H's two halves and the order between them. Derived rather than remembered: the
     forfeit depends on whether anybody has built on F16, which is a fact about the board, and `usedPrivateAbilities`
     supplies the rest. */
  const dhPower = useMemo(() => {
    const hex = privateHexFor(DH_PRIVATE_ID);
    const hexBuilt = hex
      ? mapGrid.tiles.some((tile) => tile.q === hex.q && tile.r === hex.r)
      : false;
    return dhPowerState({
      hexBuilt,
      layUsed: usedPrivateAbilities.has("dh-tile"),
      tokenUsed: usedPrivateAbilities.has("dh-token"),
    });
  }, [mapGrid, usedPrivateAbilities]);

  /* Design note #726: the C&SL's single half, same shape. */
  const cslPower = useMemo(() => {
    const hex = privateHexFor(CSL_PRIVATE_ID);
    const hexBuilt = hex
      ? mapGrid.tiles.some((tile) => tile.q === hex.q && tile.r === hex.r)
      : false;
    return cslPowerState({ hexBuilt, layUsed: usedPrivateAbilities.has("csl-tile") });
  }, [mapGrid, usedPrivateAbilities]);

  /* ==================================================================
     DESIGN NOTE 832 IS WITHDRAWN BY #834: `trackLaysThisTurn` IS GONE
     ==================================================================

     IT COUNTED the turn's tile lays -- one ordinarily, two while the C&SL's extra was unspent -- so the bar
     could label its jump "Lay 2 Track". #832's premise was sound and its remedy was not: "the C&SL's power is
     an EXTRA lay (#726) and nothing on screen ever said so" is true, and the place to say it is the private's
     own surface (#817's errand, #818's modal), not a second copy on the action bar.

     RULED OUT BY THE PERSON WHO ASKED FOR IT: "There should actually never be a 'Lay 2 Track' button because a
     'second' track lay is ONLY provided by the special power of a private company, for which we've already
     built a modal. The Action Bar should be used for the standard actions, let's leave the Special Powers
     where they are without trying to display them again."

     THE MEMO IS DELETED RATHER THAN LEFT FEEDING A CONSTANT, per #772's rule about orphans: a derivation
     nobody reads is invisible to `tsc` and to ESLint and sits there looking like the authority for something.
     The bar's label is the literal "Lay 1 Track" now, which is the only value it could ever have had.
     `cslPower` SURVIVES UNTOUCHED -- it still gates the errand below, which is the enforcement. Only the
     display of it here is gone. */

  /* Design note #833: bring the Rail Map forward for the bar's Lay Track jump. A tab change, not a game
     action -- see the bar's #833 for why the jump owns both halves. */
  const handleShowMap = useCallback(() => setActiveMainTab("map"), []);

  /* Design note #727: the hexes this corporation may build on by POWER rather than by reach. Both privates
     answer the same question, so one set covers them and a third power would need no renderer change. */
  /* Design note #845: ONE LIST, TWO ENTRY POINTS. The hexes the board rings and the chips the bar offers are
     the same offers -- `privatePowerGlowKeys` used to take its own reading of the same state, so a hex could
     ring while nothing offered it, which is exactly the "why is this glowing" the report describes. */
  const privatePowerOfferList = useMemo(
    () =>
      privatePowerOffers([
        {
          privateId: DH_PRIVATE_ID,
          abilityKey: "dh-tile",
          hex: privateHexFor(DH_PRIVATE_ID),
          usable:
            dhPower.layAvailable &&
            !dhPower.forfeited &&
            ownsPrivateByCorporation(gameState, DH_PRIVATE_ID, actingProtocolId),
        },
        {
          privateId: CSL_PRIVATE_ID,
          abilityKey: "csl-tile",
          hex: privateHexFor(CSL_PRIVATE_ID),
          usable:
            cslPower.layAvailable &&
            !cslPower.forfeited &&
            ownsPrivateByCorporation(gameState, CSL_PRIVATE_ID, actingProtocolId),
        },
      ]),
    [dhPower, cslPower, gameState, actingProtocolId],
  );
  /* ==================================================================
     DESIGN NOTE 849: THE MODAL IS DERIVED, NOT ONLY OPENED
     ==================================================================

     SPECIFIED: "Once a player has clicked the 'Lay Track on F16' button and completed that action, the modal
     should pop back up with the 'Lay Track on F16' button grayed out, and the 'Place Station Token on F16'
     and 'Forfeit Station Token' buttons now clickable."

     SO IT CANNOT BE A BOOLEAN SOMEBODY REMEMBERS TO SET. The D&H's second step happens AFTER the lay, and a
     D&H lay ENDS the Track step (`layEndsTrackStep` is `!isBonusLay`, and only the C&SL's lay is a bonus) --
     so the reopening spans a sub-phase change, a board dispatch and a re-render. An open flag set at the
     click site would have to survive all three.
     A REQUEST PLUS A STANDING OBLIGATION. `privatePowerRequest` is what a click sets; the D&H's unresolved
     second step raises the modal on its own, because at that point the game is WAITING for an answer that no
     other surface asks for. #818's whole reason for existing, made structural. */
  const [privatePowerRequest, setPrivatePowerRequest] = useState<PowerAbilityKey | null>(null);
  /* The forfeit is a DECISION and must be remembered as one (#818): `usedPrivateAbilities` records a token
     that was PLACED, and forfeiting spends the ability without placing anything. Kept apart so the modal can
     say which of the two happened. */
  const [dhStationForfeited, setDhStationForfeited] = useState(false);

  /* Design note #866: the standing request the board answers -- "resolve this hex's free-station slot".
     STATE RATHER THAN A ONE-SHOT CALL because the answer expires: the anchor is board-relative pixels, so a
     pan or a zoom while the confirmation is open changes it. The board re-reports on every view change and
     the ring stays on the token. Cleared by the X (#866 in `handleCancelTokenPlacement`) and by the station
     resolving either way. */
  const [autoStageStation, setAutoStageStation] = useState<{ q: number; r: number } | null>(null);

  /* Design note #873: the one-shot that opens the tile picker on a hex the player has already named.
     A TOKEN RATHER THAN A BOOLEAN OR A BARE COORDINATE. The same hex can be armed twice in a row -- cancel
     the C&SL's lay, then ask for it again -- and both a boolean and a coordinate would compare equal the
     second time, so the picker would open once and never again. The counter is what makes "again" a change. */
  const [autoSelectHex, setAutoSelectHex] = useState<{ q: number; r: number; token: number } | null>(
    null,
  );
  const autoSelectTokenRef = useRef(0);

  /* Design note #849: the flow the modal renders, or `null`. Derived from the same power state the panel and
     the board read -- so what the modal says has happened and what the game thinks has happened are one
     reading, not two. */
  const activePowerFlow = useMemo(
    /* Design note #887: the body of this memo is `deriveActivePowerFlow` now -- a pure function in
       `activePrivatePower.ts`, tested by CALLING it. What stood here was ~45 lines carrying #818's standing
       obligation, #871's ownership re-check and #312's "the M&H reserves no hex", none of which any test
       could execute; they were asserted by searching this file for the sentences that implement them. */
    () =>
      deriveActivePowerFlow({
        state: gameState,
        request: privatePowerRequest,
        usedAbilities: usedPrivateAbilities,
        dhStationForfeited,
        dhForfeited: dhPower.forfeited,
        actingProtocolId,
        /* Design note #871: `viewerAddress` is read by the M&H branch to check ownership. Missing from the
           dependency list in the first draft, which the lint caught -- and it would have been a real
           staleness bug rather than a hygiene point: a memo that never re-runs on a viewer change would keep
           offering the exchange to the browser that used to hold the private. */
        viewerAddress,
        dhPrivateId: DH_PRIVATE_ID,
        cslPrivateId: CSL_PRIVATE_ID,
        mhPrivateId: MH_PRIVATE_ID,
      }),
    [
      privatePowerRequest,
      usedPrivateAbilities,
      viewerAddress,
      dhStationForfeited,
      dhPower,
      gameState,
      actingProtocolId,
    ],
  );

  const privatePowerHexes = useMemo(
    () => privatePowerHexKeys(privatePowerOfferList),
    [privatePowerOfferList],
  );
  /* ==================================================================
      DESIGN NOTE 871: THE M&H RIDES IN THE BAR, NOT UNDER IT
     ==================================================================
     REPORTED: "In the Stock Round, the MH private power is pinned below the Action Bar rather than sticky
     with it, so it is easy to miss for players not scrolling up and down the page."

     AND THAT IS #785 WORKING AS DESIGNED, which is why it is a placement question rather than a bug in the
     panel. That pass moved every tall panel OUT of the sticky element on the finding that "the two that were
     [reported] are precisely the two that lived INSIDE the sticky element and pushed it past the budget".
     `PrivatePowerPanel` has always rendered past the bar's closing tag and was never the problem -- until a
     power that is one button and one decision inherited a placement chosen for tables and ledgers.
     SO THE OFFER TRAVELS AND THE PANEL STAYS. A chip costs a few pixels of resting height (#837 measures it),
     which is the trade #846 already made for the two hex powers: "one list feeds both entry points".
     SEPARATE FROM `privatePowerOffers`, deliberately. That module's note is explicit that it holds HEX powers
     -- "M&H and C&A are share exchanges" -- and that its list "can never hold more than two entries". Growing
     it here would falsify a note that is load-bearing for `privatePowerHexKeys`, which feeds the board's glow
     and must never be handed a power with no hex. Two lists, joined only where the bar takes a generic chip. */
  const stockRoundPowerOffers = useMemo(
    /* Design note #887: `stockRoundExchangeOffers` in `activePrivatePower.ts`. The three rules this memo
       used to state inline -- #883's sandbox gate, the Stock Round test, and #441's PLAYER-scope ownership --
       are now three branches a test can exercise one at a time instead of three sentences a scan has to
       find. The note above still explains WHY the offer travels with the bar; what it no longer has to do is
       be the only record of what the code checks. */
    () =>
      stockRoundExchangeOffers({
        state: gameState,
        viewerAddress,
        sandbox,
        mhPrivateId: MH_PRIVATE_ID,
      }),
    [gameState, viewerAddress, sandbox],
  );

  /* Read through a ref for the same reason `isMyTurnRef` is: the click handler is a `useCallback` the canvas
     holds across renders, and a click is a user event long after the commit that set it. */
  const privatePowerOffersRef = useRef(privatePowerOfferList);
  useEffect(() => {
    privatePowerOffersRef.current = privatePowerOfferList;
  }, [privatePowerOfferList]);

  /* Design note #1027: the cursor, mirrored for the canvas click handler. Read through a ref for #850's
     reason -- the handler is a `useCallback` the canvas holds across renders, and a click is a user event
     long after the commit that set it, so a closure would answer with the step the handler was built in. */
  const orSubPhaseRef = useRef(orSubPhase);
  useEffect(() => {
    orSubPhaseRef.current = orSubPhase;
  }, [orSubPhase]);

  /* ==================================================================
      DESIGN NOTE 1027: THE MODAL RESETS WHEN THE STEP TURNS
     ==================================================================
     REPORTED, the second half: "when they correctly entered the 'Lay Track' subphase, clicking the UI button
     applied the power but failed to show the modal."

     `privatePowerRequest` HOLDS AN ABILITY KEY, and `setPrivatePowerRequest(sameKey)` is a no-op to React --
     the state has not changed, so nothing re-renders and the modal does not re-open. The premature click at
     Buy Private had already parked that key there; by the time the player reached Lay Track and pressed the
     button, the request was ALREADY the value the button sets.

     SO THE STEP CHANGING CLEARS IT. A request raised at one step is not an answer to a question asked at
     another, and clearing on the boundary is what makes the button work the first time rather than the
     second. The phase gate above stops the key being parked in the first place; this is what unsticks a game
     that has already parked one. */
  useEffect(() => {
    setPrivatePowerRequest(null);
  }, [orSubPhase]);

  /* ==================================================================
   *  DESIGN NOTE 729: WHOSE CITIES ARE SHUT
   * ==================================================================
   *
   * REPORTED: "corporations' networks are not being blocked by tokened out cities."
   *
   * ASSEMBLED HERE because the two halves live in places the walk may not reach: the slot COUNTS are in the
   * tile catalog under `components/`, and the OCCUPANTS are in game state. `cityBlocking.ts` owns the rule,
   * `trackReach.ts` owns the walk, and this is the only place that can see both. Same shape as #7's callback
   * pattern and #716's `hasPlaceableTile`.
   *
   * PREPRINTED CITIES COUNT TOO -- New York, Baltimore and Boston hold tokens before anybody lays anything, so
   * a resolver that only read `tiles` would report zero slots on exactly the three hexes most worth blocking,
   * and #729's rule 3 would then read them as "not a city". */
  /* Design note #1006: the BODY moved to `utils/stationTokens.ts` and this is now a binding, not a resolver.
     The placement gate has to ask the same question -- that is the whole of this batch's bug -- and a second
     copy of the count living here is how the wall the board draws and the wall the gate enforces come to
     disagree about a preprinted city. Kept as a callback because `blocksThroughCity` below and the tile-lay
     glow both consume it in that shape. */
  const citySlotsAt = useCallback(
    (q: number, r: number, cityIndex: number): number => citySlotCount(mapGrid, q, r, cityIndex),
    [mapGrid],
  );

  const blocksThroughCity = useMemo(
    () =>
      cityBlockerFor({
        actingCompanyId: actingProtocolId,
        companies: gameState?.public_companies ?? [],
        slotsAt: citySlotsAt,
        cityOf: (company, q, r) =>
          tokenCityIndex(company as unknown as StationTokenCompany, q, r),
      }),
    [actingProtocolId, gameState, citySlotsAt],
  );

  useEffect(() => {
    blocksThroughCityRef.current = blocksThroughCity;
  }, [blocksThroughCity]);

  const layTrackFocus = useMemo(() => {
    // Design note #437: the STEP, not the inspector. Veiling the board
    // while a player is merely browsing would tell them they may not build
    // on hexes that are simply not their concern this second.
    if (!tileLayStepActive) return undefined;
    const corporation = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    const reach = layableHexes({
      // Design note #729: a tokened-out city is a wall, so the walk stops at it.
      blocksThrough: blocksThroughCity,
      mapGrid,
      // Design note #686: the recorded city slot travels with the token.
      stationHexes: corporation ? stationTokensOf(corporation) : [],
      /* Design note #716: the glow asks the TILE ENGINE, not just the ground. `evaluateHexForTileLaying`
         answers "may anything ever be built here"; this answers "is there a tile that fits, now, in this
         era, connecting to this network" -- which is what a white ring was already promising.
         THE SAME CALL THE PICKER MAKES, with the same era and the same network, so the ring and the panel it
         opens cannot disagree about whether there is anything to choose. */
      hasPlaceableTile: (q, r, network, ports) =>
        filterSandboxPlacements(ALL_TILE_PLACEMENTS, {
          mapGrid,
          q,
          r,
          networkHexes: network,
          networkPorts: ports,
          era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
        }).length > 0,
    });
    if (reach.unconstrained) return undefined;
    /* The corporation's own network stays lit beside the legal placements; unioned here because this layer has both halves.
       See docs/ai_architecture/canvas_rendering.md - App.tsx #241 */
    const visible = new Set<string>(reach.network);
    reach.hexes.forEach((key) => visible.add(key));
    /* ==================================================================
       DESIGN NOTE 844: THE VEIL NEVER LEARNED WHAT THE GLOW ALREADY KNEW
       ==================================================================

       REPORTED: "the relevant hexes currently have the rainbow outline on them (but for some reason in a
       recent pass they have been veiled again, rather than marked/highlighted for inclusion in a
       corporation's network as usual...this should be fixed)."

       #727 TAUGHT ONE PREDICATE AND NOT ITS SIBLING. That note is explicit -- "a private power's hex glows
       whether or not it is in the reach set -- being outside it is the point" -- and the renderer's GLOW arm
       honours it with an `||`. The VEIL arm three blocks above it asks `!layFocus.visible.has(key)`, and
       `powerHexes` was handed over beside `visible` rather than added to it.

       SO THE BOARD SAID BOTH THINGS AT ONCE and the darker one won: a rainbow outline drawn underneath the
       dim, which reads as "this is special" and "this is not for you" in the same pixel.

       THE SHAPE IS THE ONE THIS SESSION KEEPS FINDING -- a rule stated in one place and never asked in the
       authority beside it (#807, #809, #816, #820, #824, #825, #826, #831). Added HERE rather than excepted
       in the renderer, so there is one set that means "not veiled" and `powerHexes` keeps its own job of
       saying which hexes get the hue ring. */
    privatePowerHexes.forEach((key) => visible.add(key));
    // `network` is carried alongside for the rotation filter, which needs
    // the hexes that ACTUALLY CARRY TRACK -- not `visible`, which also holds
    // the empty extension candidates. A tile cannot join a bare hex.
    return {
      visible,
      highlighted: reach.hexes,
      network: reach.network,
      /* Design note #483: the reachable EDGES, carried alongside the hexes.
         The rotation filter needs both -- a hex set alone cannot say which
         side of a crossover the corporation is on, and re-deriving it there
         is what produced the reported bug. */
      ports: reach.ports,
      // Design note #252/#253: the acting corporation's colour, lifted if it
      // is too dark to read as light against the veiled board.
      // Design note #561: white, not the livery -- legibility over identity.
      glowColor: STATION_PLACEMENT_HIGHLIGHT_INK,
      // Design note #727: and the powers, which are marked in spite of being out of reach.
      powerHexes: privatePowerHexes,
    };
  }, [
    tileLayStepActive,
    gameState,
    actingProtocolId,
    mapGrid,
    currentPhase,
    privatePowerHexes,
    blocksThroughCity,
  ]);

  /* ==================================================================
      DESIGN NOTE 987: THE FRAME CHOOSER AND ITS REQUEST ARE GONE
     ==================================================================
     RULED: "the map is auto-zooming and panning into empty space ... Strip out the map auto-zoom
     functionality completely", and of the button that raised it: "its attempt to center on the home station
     is broken (it scrolls to the top of the page)."
     WHAT WAS HERE: `layTrackFrameKeys`, which asked `chooseFrameKeys` for the hexes to put on screen --
     #955's home station first, then #888's buildable set, then the network, then the station tokens -- and
     `handleFrameNetwork`, which raised them to the board as a one-shot token.
     THE WHOLE LADDER GOES, not just the top rung. #955's home-station rule is the version that was reported,
     but the layers under it are the same move with a different target: every one of them takes the camera
     somewhere the player did not ask to be. A desktop-first game shows the whole board at the default pose --
     which is exactly what #888's own note describes -- and the player has three visible controls for
     changing it.
     `frameHexes.ts` IS DELETED, both functions, because this was its only caller. An unused pure module with
     a passing suite is how a feature that was ruled off comes back: it looks available. */



  /* Layer 3: close the ring when the sub-phase advances, since that can happen without a board click.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #199 */
  useEffect(() => {
    if (tileInspectorArmed) return;
    setRadialSelector(null);
    setPreviewTile(null);
  }, [tileInspectorArmed]);

  /* With a ring open, the first board click outside it DISMISSES and the second selects. Read through a ref so the interceptor identity stays stable.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #622 */
  const openRingHexRef = useRef<{ q: number; r: number } | null>(null);

  const handleHexClickQuery = useCallback((state: HexClickQueryState) => {
    setHexClickQuery(state);

    /* The tile selector is a Lay Track tool: gated where the ring opens, in three layers. canLayTileNow is deliberately not the condition.
       See docs/ai_architecture/canvas_rendering.md - App.tsx #199 */
    if (!tileInspectorArmed) {
      setRadialSelector(null);
      setPreviewTile(null);
      return;
    }

    // A resolved hex click opens the ring; "blocked"/"loading" are not openings and "not-a-hex" is a closing (#172).
    // See docs/ai_architecture/canvas_rendering.md - App.tsx #162
    if (state.status === "success" || state.status === "offline") {
      /* Design note #622: a ring is already open. This click is a dismissal
         if it landed on a different hex, and nothing at all if it landed on
         the one already open. Either way it does not open a new ring. */
      /* ==================================================================
         DESIGN NOTE 850: TWO RINGS ON ONE HEX, AND THE PICKER WON
         ==================================================================
         REPORTED: "when I clicked yes to place the Station Marker and then clicked the tile itself, the
         tileselector radial menu popped up on top of the checkmark/x for the station. I then had to click
         off the hex to remove the tileselector menu and only see the checkmark/x."
         TWO CONFIRMATIONS FOR TWO DIFFERENT ACTIONS, drawn at the same place, and only one of them was
         asked about. `pendingToken` is a placement waiting for a tick; opening a tile picker over it offers
         a second, unrelated decision on top of an unanswered one -- and the player has to dismiss the thing
         they did not ask for to reach the thing they did.
         REFUSED HERE RATHER THAN RE-LAYERED. A `z-index` fight would leave both mounted, so a click could
         still land on the wrong one; the honest fix is that a hex with a staged placement is not accepting
         a second question. Same argument as #716's swallowed click, one layer up. */
      if (pendingTokenRef.current !== null) return;

      const openOn = openRingHexRef.current;
      if (openOn) {
        if (openOn.q !== state.q || openOn.r !== state.r) {
          setRadialSelector(null);
          setPreviewTile(null);
        }
        return;
      }

      /* Design note #716: A HEX WITH NOTHING TO OFFER SWALLOWS THE CLICK.
         REPORTED: "when I click a hex not in my network, it highlights just that hex (no tileselector menu
         pops up for it) and dims every other hex: it would be better if clicking those out-of-network hexes
         did nothing."
         Exactly so, and the two halves of that sentence are the same fault. `soleFocusKey` is set from
         `radialSelector`, so opening a ring is what deepens the veil -- and the ring opened for ANY resolved
         hex, then found no candidates to draw. The player got the whole board pushed back to look at an empty
         menu, which reads as the board reacting to a mistake they made.
         THE TEST IS THE GLOW SET, deliberately: `layTrackFocus.highlighted` is now the hexes a tile actually
         fits (#716 above), so "the ring opens where the ring has something to show" is true by construction
         rather than by two conditions agreeing.
         ONLY WHILE A LAY IS GATED. With no focus there is no veil to deepen and no network to be outside of --
         a spectator or a player browsing between turns keeps the inspector on every hex, which is #437's
         point about not telling somebody they may not build on hexes that are not their concern. */
      /* Design note #725: EXCEPT ON A PRIVATE POWER'S OWN HEX. Reported of the D&H: "it illuminates the
         correct hex, but it does not allow me to actually lay track. The special power allows players to lay
         the track without respect to network connectivity rules."
         #716's glow set is the acting corporation's REACH, and reaching F16 before your track does is the
         entire value of the power -- so the one errand that exists to ignore connectivity was being refused by
         the gate that enforces it. `privateTileHexKey` is non-null only while that errand is armed, and only
         for its own hex. */
      /* Design note #809: AND ONLY THE PLAYER WHO IS LAYING. Reported as a regression -- "non-active players
         used to be able to click the rail map and view possible track lays on any tile at any time. This
         ability seems to be blocked now during the active player's Lay Track subphase."
         The paragraph above already says a watcher "keeps the inspector on every hex"; the condition never
         asked. `layTrackFocus` is derived from the STEP, so it is defined for every seated viewer during
         anybody's Track step -- and it is built from the ACTING corporation's reach, so a watcher's clicks
         were being measured against somebody else's track.
         `isMyTurnRef` rather than `isMyTurn`, matching the two refs read beside it: this closure is rebuilt
         on `layTrackFocus`, and a click is a user event long after the commit that set the ref. */
      /* ==================================================================
         DESIGN NOTE 845: THE RINGED HEX ANSWERS THE CLICK IT WAS ATTRACTING
         ==================================================================
         The board has marked B20 and F16 with a hue ring since #727, and clicking one did what clicking any
         out-of-network hex does: nothing (#716). So the one affordance pointing at the power was inert, and
         the power itself lived in a subpanel below the fold -- which is the report.
         BEFORE `inspectorClickRefused`, deliberately. That gate exists to swallow clicks on hexes with
         nothing to offer, and this hex has something to offer precisely BECAUSE it is out of network. The
         same ordering #725 needed for the armed errand, one step earlier in the flow. */
      const powerOffer = privatePowerOfferAt({
        hexKey: `${state.q},${state.r}`,
        actingViewer: isMyTurnRef.current,
        errandArmed: privateTileHexKeyRef.current !== null,
        offers: privatePowerOffersRef.current,
        /* Design note #1027: and only at the step that can act on it. A D&H or C&SL power raised during Buy
           Private opens a modal for a lay the game is not ready to make. */
        subPhase: orSubPhaseRef.current,
      });
      if (powerOffer) {
        setRadialSelector(null);
        setPreviewTile(null);
        setPrivatePowerRequest(powerOffer.abilityKey);
        return;
      }

      if (
        inspectorClickRefused({
          actingViewer: isMyTurnRef.current,
          layFocusHighlighted: layTrackFocus?.highlighted,
          hexKey: `${state.q},${state.r}`,
          privateTileHexKey: privateTileHexKeyRef.current,
        })
      ) {
        setRadialSelector(null);
        setPreviewTile(null);
        return;
      }

      setPreviewTile(null);
      // Converted to a board-relative offset at capture time -- the raw
      // client point is only correct until something scrolls.
      setRadialSelector({
        q: state.q,
        r: state.r,
        hexLabel: state.hexLabel,
        // Design note #171: the HEX CENTRE, not the cursor. Already in
        // canvas-CSS pixels and already through the live pan/zoom
        // transform, so the ring sits on the hex however the board is
        // scrolled, panned or zoomed.
        offsetX: state.centroidX,
        offsetY: state.centroidY,
        /* Design note #506: and the hex's radius AS DRAWN, from the same
           report and through the same transform. The ring sizes its
           candidates and its clearance against this, so both follow the
           board's zoom instead of assuming one. */
        hexRadiusPx: state.hexRadiusPx,
        provisional: state.status === "offline",
        placements: state.status === "success" ? state.response.placements : state.placements,
      });
    } else {
      setRadialSelector(null);
      setPreviewTile(null);
    }
    // `boardEl` dropped: design note #171 replaced the `getBoundingClientRect`
    // arithmetic that needed it with the centroid the renderer now reports,
    // so this closure reads nothing from the DOM at all any more.
    // Design note #716: and `layTrackFocus`, whose glow set decides whether a click opens a ring at all.
  }, [tileInspectorArmed, layTrackFocus]);

  /* Click the preview to rotate: 60 degrees clockwise, wrapping at six. Only for the hex the selector is open on.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #162 */

  // A blocked cue is a transient nudge with its own timer; keyed on the whole state so a second blocked click restarts it.
  // See docs/ai_architecture/canvas_rendering.md - App.tsx #141
  useEffect(() => {
    if (hexClickQuery?.status !== "blocked") return undefined;
    const timer = window.setTimeout(() => {
      // Clears only if nothing has replaced it in the meantime -- otherwise
      // a timer from an earlier click could wipe a live "loading" or
      // "success" state belonging to a later one.
      setHexClickQuery((current) => (current === hexClickQuery ? null : current));
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [hexClickQuery]);


  // Manual route-point state. routeSelectMode rewires the canvas click to the builder (#44 arms the first-OR tutorial).
  // See docs/ai_architecture/routing_pathfinding.md - App.tsx #11
  const [marketTutorialArmed, setMarketTutorialArmed] = useState(false);

  // Design note #158: the Tutorials front door's open/closed state. Separate
  // from the four `TutorialModal`s' own state, and deliberately so -- those
  // track "has this player been shown this yet", which is a different
  // question from "is the reader open right now".
  const [tutorialLibraryOpen, setTutorialLibraryOpen] = useState(false);

  // Design note #159: station-token targeting mode. Same shape as
  // `routeSelectMode` -- while it is on, the board's query-firing click
  // interceptor is disarmed and clicks route to a token handler instead.
  const [tokenTargetMode, setTokenTargetMode] = useState(false);

  /* A token is STAGED, not dropped: nothing dispatches until the confirmation ring. Anchored to the hex centroid (#171).
     See docs/ai_architecture/canvas_rendering.md - App.tsx #201 */
  const [pendingToken, setPendingToken] = useState<{
    q: number;
    r: number;
    hexLabel: string;
    /* The company travels with the staged placement; null means "the corporation on turn".
       See docs/ai_architecture/canvas_rendering.md - App.tsx #556 */
    companyId: number | null;
    /** Design note #453: which city on the hex, or `null` when the geometry
     *  cannot say. Travels to `PlaceStationToken.city_index`. */
    cityIndex: number | null;
    /* Free placements (home station, D&H F16) stage and confirm like paid ones. kind decides what the confirmation dispatches.
       See docs/ai_architecture/canvas_rendering.md - App.tsx #454 */
    kind: "paid" | "free";
    offsetX: number;
    offsetY: number;
  } | null>(null);

  /* Design note #850: read through a ref for the same reason `isMyTurnRef` is -- the click handler is a
     `useCallback` the canvas holds across renders, and a click is a user event long after that commit. */
  const pendingTokenRef = useRef(pendingToken);
  useEffect(() => {
    pendingTokenRef.current = pendingToken;
  }, [pendingToken]);

  /* The same veil, for tokens. The SET differs: a token needs a city with a free unreserved slot ON the network. Only while targeting is armed.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #240 */
  const tokenTargetFocus = useMemo(() => {
    /* ==================================================================
     *  DESIGN NOTE 754: THE VEIL BELONGS TO THE STEP, NOT TO THE CURSOR
     * ==================================================================
     *
     * REPORTED: "the 'Place Station' action subphase lifts the network veil, but the network veil is still
     * very useful for the active corporation at this point, otherwise it appears it can place a station
     * anywhere on the map."
     *
     * THE CONDITION WAS `tokenTargetMode`, WHICH IS AN ARMED CURSOR. So the board unveiled the moment the
     * Tokens step opened and stayed unveiled until the president pressed Place Station -- which is exactly
     * backwards: the question "where may I put a token" is what a president is answering BEFORE they reach
     * for the control, and the answer was withheld until after they had committed to using it.
     *
     * THE TILE LAY NEVER HAD THIS PROBLEM because `tileLayStepActive` reads the STEP (#224). The two veils
     * were written to the same shape and gated on different kinds of thing, and only one of them was a mode.
     *
     * THE CURSOR KEEPS ITS OWN GATE. `onHexClick` still routes to `handleTokenHexClick` only while
     * `tokenTargetMode` is armed, so lighting the network does not make a hex clickable -- the veil informs,
     * the mode acts. Separating them is the whole fix and it is why this is safe: nothing about what a click
     * DOES has changed.
     *
     * AND THE SET IS ALREADY RIGHT. `placeableStationHexes` is the same predicate the placement uses (#5081
     * reuses it "so it cannot disagree with the veil"), so this shows the true legal set rather than a
     * second opinion about it. */
    if (orSubPhase !== "Tokens") return undefined;
    if (spectator) return undefined;
    if (!activeStationCompany) return undefined;
    const highlighted = placeableStationHexes({
      mapGrid,
      company: activeStationCompany,
      allCompanies: gameState?.public_companies ?? [],
      boardHexes: STATIC_BOARD_HEXES.map((hex) => [hex.q, hex.r] as const),
    });
    // Design note #241: same three tiers as the tile lay. A token placement
    // is judged against the network it joins, so that network stays lit.
    const visible = new Set<string>(
      // Design note #686: same resolver as the tile-lay veil, so the two tiers
      // cannot disagree about where this corporation's network reaches.
      // Design note #729: the token-placement highlight walks the same blocked network the tile glow does.
      reachableNetwork(mapGrid, stationTokensOf(activeStationCompany), blocksThroughCity),
    );
    highlighted.forEach((key) => visible.add(key));
    return {
      visible,
      highlighted,
      /* Read activeStationCompany, not the operating queue: identity and turn order agree only during an ordinary OR turn.
         See docs/ai_architecture/canvas_rendering.md - App.tsx #514 */
      glowColor: STATION_PLACEMENT_HIGHLIGHT_INK, // design note #561
    };
    // Design note #729: the walk now takes a blocker, so a change to who holds which city must repaint.
    // Design note #754: keyed on the STEP now, not on the armed cursor.
  }, [orSubPhase, spectator, activeStationCompany, gameState, mapGrid, blocksThroughCity]);


  /* Design note #715: `privateTradeOpen` is GONE with the modal. It existed to answer "is the sheet showing",
     and the sheet now shows exactly when the acting president is on the `BuyPrivate` step -- a fact the bar
     already holds, so a second piece of state saying the same thing could only ever disagree with it.
     The PROMPT keeps its own state; #166's argument survives for the half that outlives the step. */
  /* Derived from shared sandbox state, not useState. The display label is added at the edge; the wallet is what travels.
     See docs/ai_architecture/contract_economy.md - App.tsx #662 */
  const privateProposal = useMemo<PrivateTradeProposal | null>(() => {
    const offer = gameState?.private_purchase_offer ?? null;
    if (!offer) return null;
    return {
      privateId: offer.private_id,
      privateName: offer.private_name,
      ownerAddress: offer.owner,
      ownerLabel: sandboxPlayerLabel(offer.owner) ?? truncateAddress(offer.owner),
      buyerProtocolId: offer.buyer_protocol_id,
      buyerTicker: offer.buyer_ticker,
      price: offer.price,
    };
  }, [gameState?.private_purchase_offer]);

  /* Design note #205 said: "Trains have a full on-chain offer flow; privates are single-party.
     sandboxTrainProposal stands in for the offer register offline only." Both halves are true and the
     conclusion was not -- an offer register that lives in ONE client's `useState` is a register of one, so
     offline the seller was never told and the buyer answered their own offer.
     Design note #701: DERIVED FROM SHARED SANDBOX STATE, exactly as #662 did for privates. The wallet is what
     travels; the display label is resolved here, at the edge, because two clients can render the same wallet
     differently. */
  const sandboxTrainProposal = useMemo<TrainTradeProposal | null>(() => {
    const offer = gameState?.train_purchase_offer ?? null;
    if (!offer) return null;
    return {
      sellerProtocolId: offer.seller_protocol_id,
      sellerTicker: offer.seller_ticker,
      sellerPresident: offer.seller_president,
      sellerPresidentLabel:
        sandboxPlayerLabel(offer.seller_president ?? "") ??
        truncateAddress(offer.seller_president ?? ""),
      buyerProtocolId: offer.buyer_protocol_id,
      buyerTicker: offer.buyer_ticker,
      modelType: offer.model_type,
      price: offer.price,
    };
  }, [gameState?.train_purchase_offer]);

  /* Inspecting and dispatching are separate gestures; only the green check is gated.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #163 */
  const [radialSelector, setRadialSelector] = useState<{
    q: number;
    r: number;
    hexLabel: string;
    /** Offset of the click INSIDE the board element. Board-relative, so a
     *  page scroll cannot detach the ring from its hex. */
    offsetX: number;
    offsetY: number;
    /** Design note #506: the hex's centre-to-corner radius as drawn. */
    hexRadiusPx: number;
    /** These candidates came from the local catalog, not from a chain. */
    provisional: boolean;
    /** Verbatim `GetLegalTilePlacements`, when a chain answered. */
    placements: readonly LegalTilePlacement[];
  } | null>(null);

  /* Design note #622: the open ring's hex, mirrored for `handleHexClickQuery`
     to read without taking a dependency on it. Only the coordinates -- the
     click path asks "is this the same hex" and nothing else, and mirroring
     the whole object would re-run this effect on every candidate list. */
  useEffect(() => {
    openRingHexRef.current = radialSelector ? { q: radialSelector.q, r: radialSelector.r } : null;
  }, [radialSelector]);

  /* ==================================================================
   *  DESIGN NOTE 1037: LEAVING THE MAP CLOSES WHAT WAS OPEN ON IT
   * ==================================================================
   *
   * REPORTED: "If a player clicks away from the Rail Map tab and then returns, the tile selector radial menu
   * is inappropriately opening/staying open on a hex."
   *
   * AND THE RING WAS NEVER RENDERED WHILE THEY WERE AWAY. `RadialTileSelector` is already gated on
   * `activeMainTab === "map"` (#199, layer 3), so nothing was on screen -- the STATE simply outlived the
   * view. The ring is held here in the shell, which does not unmount when a tab changes, so returning to the
   * map re-rendered a selection made minutes earlier on a board the player has stopped thinking about.
   * A CONDITIONAL RENDER IS NOT A LIFECYCLE. That is the whole shape of this bug: hiding a component looks
   * like closing it right up until the moment it comes back.
   *
   * THIS WAS NOT THE REPORTED FAULT, AND THE NOTE SAID IT WAS. Given the reproduction -- "the exact same hex
   * (F16, where I had used DH's private power) ... only after I used the DH private power" -- the ring was
   * being RE-OPENED on every return by a one-shot auto-select whose consumed-token memory lived inside the
   * board component and died with it. #1038 fixes that, and it is the fix that cures the report.
   * THIS EFFECT IS KEPT ANYWAY, on its own merits: a ring the player opened by hand before wandering off
   * should not be waiting for them either, and that case is real and independent. Recorded rather than
   * quietly re-scoped, because a note claiming to fix a report it did not fix is worse than no note.
   *
   * WHAT IS CLEARED IS VIEW STATE ONLY, and the boundary matters more than the fix. These four are answers to
   * "what is open on the board right now":
   *   `radialSelector`  the tile ring, the reported symptom
   *   `pendingToken`    the station confirm ring, which is the same component (#201) with the same fault and
   *                     would otherwise be the half-fix this codebase keeps producing
   *   `previewTile`     the rotation preview the ring drives; #625 already clears these two together
   *   `hexClickQuery`   the in-flight lookup whose spinner is itself gated on the map tab
   *
   * WHAT IS DELIBERATELY LEFT ALONE is everything that describes the player's TURN rather than their screen:
   * `tileInspectorArmed`, `armedErrand`, `homeStationPlacement`, `routeDrafts`, `routeSelectMode`,
   * `tokenTargetMode`. A player who opens the Ledger to check a rival's cash has not abandoned a drafted
   * Diesel route or a Champlain & St. Lawrence errand, and clearing those would be a far worse bug than the
   * one being fixed -- silent, mid-turn, and costing real work. "Reset the local state" is easy to read as
   * "reset everything local", and everything local includes the turn.
   *
   * THE TOKEN RING IS THE ONE JUDGEMENT CALL. Closing it discards an uncommitted placement, so a player who
   * clicked a hex, wandered off and came back must click it again. That is recoverable in one click and it is
   * what "a clean map with no menus open" asks for; the alternative is a confirm ring floating over a board
   * whose context the player has lost. Nothing is dispatched either way -- the placement was never committed. */
  useEffect(() => {
    if (activeMainTab === "map") return;
    setRadialSelector(null);
    setPendingToken(null);
    setPreviewTile(null);
    setHexClickQuery(null);
  }, [activeMainTab]);

  /* A corporation handover closes the open picker and returns the new acting president to the board. Once per handover, and only for them.
     See docs/ai_architecture/state_machine.md - App.tsx #625 */
  const prevActingCorporationRef = useRef<number | null>(null);
  useEffect(() => {
    if ((gameState?.current_round_type ?? null) !== "OperatingRound") {
      prevActingCorporationRef.current = null;
      return;
    }
    const acting = actingProtocolId;
    if (prevActingCorporationRef.current === acting) return;
    prevActingCorporationRef.current = acting;

    const seat = gameState ? actingSeatIndex(gameState) : null;
    const actingPresident = seat === null ? null : (gameState?.player_addresses[seat] ?? null);
    if (!actingPresident || actingPresident !== viewerAddress) return;

    setRadialSelector(null);
    setPreviewTile(null);
    setActiveMainTab(surfaceTabFor("OperatingRound"));
  }, [gameState, actingProtocolId, viewerAddress]);
  const [routeSelectMode, setRouteSelectMode] = useState(false);
  /* One route per train, keyed by index into owned_trains - a model name does not identify one of three 3-trains.
     See docs/ai_architecture/routing_pathfinding.md - App.tsx #275 */
  const [routeDrafts, setRouteDrafts] = useState<Readonly<Record<number, RoutePoint[]>>>({});
  const [activeTrainIndex, setActiveTrainIndex] = useState<number>(0);
  const [routeFeedback, setRouteFeedback] = useState<string | null>(null);
  /* last_route_revenue cannot say whether revenue was earned THIS turn, so the turn's own history is observed; null enforces. #522: the room cursor, three refs so dispatching effects are not re-armed.
     See docs/ai_architecture/state_machine.md - App.tsx #278 */
  const [sandboxRoomError, setSandboxRoomError] = useState<string | null>(null);
  const [sandboxRoomBusy, setSandboxRoomBusy] = useState(false);
  const [sandboxAppliedCount, setSandboxAppliedCount] = useState(0);
  /* Design note #527: the anteroom's own state, from the room DOCUMENT
     rather than the log. `null` while it loads or when there is no room. */
  const sandboxRoomRef = useRef<string | null>(null);
  /** The next LOG index to append at -- the log's own length, which never
   *  shrinks even when the game is rewound. */
  const appliedIndexRef = useRef(0);
  /* Two counters: appliedIndexRef is where the next append goes, appliedCountRef is how much live history has run. Undo separates them.
     See docs/ai_architecture/firebase_middleware.md - App.tsx #591 */
  const appliedCountRef = useRef(0);
  /** Design note #591b: resets every atom to the room's boot state, so the
   *  drain can replay from the fixture. Published by an effect below,
   *  because the setters it needs are declared after this. */
  const rebuildRef = useRef<(() => void) | null>(null);
  /** The log as last seen, for the undo controls; a ref so pressing a button does not rebuild the handlers. Mirrors `at` too (#643), and `derived` (#668) -- typed as `SandboxAction` rather than restated, so the next field cannot go missing the way those two did.
   *  See docs/ai_architecture/state_machine.md - App.tsx #591 */
  const sandboxLogRef = useRef<SandboxAction[]>([]);
  /* Log index of the last round-opening action, derived from the log rather than counted, so an undo cannot leave it stale.
     See docs/ai_architecture/state_machine.md - App.tsx #592 */
  const roundBoundaryIndexRef = useRef<number | null>(null);
  const sandboxSeatRef = useRef<string>("");
  useEffect(() => {
    sandboxRoomRef.current = sandboxRoomCode;
  }, [sandboxRoomCode]);
  /* Who the log records as having acted. A LABEL, not an identity -- the
     sandbox has no authentication and this is for the readout, not for
     permission. */
  useEffect(() => {
    sandboxSeatRef.current = sandboxPlayerLabel(viewerAddress ?? "") ?? "sandbox";
  }, [viewerAddress]);

  const [routesRunThisTurn, setRoutesRunThisTurn] = useState<{
    protocolId: number;
    ran: boolean;
  } | null>(null);
  useEffect(() => {
    setRoutesRunThisTurn(null);
  }, [actingProtocolId]);

  /* Design note #940: the variant's floating modifier. Cleared by the component's own timer rather than
     here -- the two seconds belong to the thing displaying them, and a parent that also owned a timeout would
     be a second answer to "how long". */
  const [revenueFlash, setRevenueFlash] = useState<RevenueFlashSignal | null>(null);
  /** Design note #1095: the flash's way home. Stable, because it is an effect dependency in the component
   *  that calls it and an inline arrow would retrigger that effect on every render of this shell. */
  const clearRevenueFlash = useCallback(() => setRevenueFlash(null), []);
  /* ==================================================================
      DESIGN NOTE 934: #492'S CACHE IS GONE, AND SO IS THE RACE INSIDE IT
     ==================================================================
     `committedRouteRevenue` held the total this session watched a corporation commit at Run Routes, and
     `dividendDeclaration` preferred it over `last_route_revenue`. It existed because #492 found the field
     singular -- one `RunManualRoute` per train, each overwriting the last -- so a three-train turn left only
     the third train's figure standing.
     BOTH OF ITS REASONS HAVE SINCE BEEN FIXED IN THE FIELD ITSELF. #903's arm accumulates across the batch
     instead of overwriting, and #777 clears the figure on the turn change so it can no longer carry a
     previous turn forward. The cache was answering a question its subject had learned to answer.
     AND BY THEN IT WAS ANSWERING IT WRONG. It was filled from a state read taken the instant the dispatch
     loop finished, which in a sandbox ROOM is before the reducer has run at all -- `runGameplayAction`
     appends to the log and returns there, and the snapshots arrive afterwards. A turn of three runs committed
     whatever had landed by then, usually one, and the commitment then CAPPED the dividend at that. Reported
     as "$150 ran, $50 paid".
     WHAT REPLACED IT IS NOTHING, deliberately. `declareDividendsChoice` and the payout table both read
     `last_route_revenue` from render state at the moment the player declares, by which time every snapshot
     for the turn has landed; `routesRunThisTurn` still records the FACT of a run, which is the half of #492
     that is load-bearing -- it keeps `skippedRoutes` from inferring a skip on a corporation that ran and
     earned nothing. One authority for the amount, which is what #917 was reaching for. */
  /* One shared observation of "did this corporation run"; noEarnableRevenue probes the pathfinder and answers null in the case that matters.
     See docs/ai_architecture/state_machine.md - App.tsx #484 */
  const skippedRoutesThisTurn =
    routesRunThisTurn?.protocolId === actingProtocolId && routesRunThisTurn.ran === false;
  /* Design note #275: read by the canvas click handler, which must see the
     CURRENT draft without being rebuilt on every click. Mirrors, written
     alongside the state exactly as the sandbox atoms are (design note
     #265) -- the state stays the rendering source of truth. */
  const routeDraftsRef = useRef<Readonly<Record<number, RoutePoint[]>>>(routeDrafts);
  const activeTrainIndexRef = useRef<number>(activeTrainIndex);
  useEffect(() => {
    routeDraftsRef.current = routeDrafts;
  }, [routeDrafts]);
  useEffect(() => {
    activeTrainIndexRef.current = activeTrainIndex;
  }, [activeTrainIndex]);
  /* Design note #624: the roster, mirrored for the same reason and read for
     one thing -- how many revenue centres the ACTIVE train may run. Kept off
     the click handler's dependency list so a train purchase mid-step cannot
     rebuild the canvas's click prop while a route is being drawn. */
  const ownedTrainRosterRef = useRef(ownedTrainRoster);
  useEffect(() => {
    ownedTrainRosterRef.current = ownedTrainRoster;
  }, [ownedTrainRoster]);
  /* routeSelectMode is the CANVAS flag; routeBuildMode is gone (#493) because neither toggle position changed behaviour.
     See docs/ai_architecture/routing_pathfinding.md - App.tsx #266 */

  // Force route mode off when the Routes step ends, or it keeps swallowing tile-lay clicks with no visible control to disable it.
  // See docs/ai_architecture/routing_pathfinding.md - App.tsx #33
  const inRunTrainsSubPhase =
    (gameState?.current_round_type ?? null) === "OperatingRound" && orSubPhase === "Routes";
  useEffect(() => {
    if (inRunTrainsSubPhase) return;
    setRouteSelectMode(false);
    setRouteDrafts({});
    setActiveTrainIndex(0);
    setRouteFeedback(null);
  }, [inRunTrainsSubPhase]);

  /* Entering the step engages the builder: a visible builder whose map clicks go nowhere is worse than none.
     See docs/ai_architecture/routing_pathfinding.md - App.tsx #266 */
  useEffect(() => {
    if (!inRunTrainsSubPhase) return;
    setRouteSelectMode(true);
  }, [inRunTrainsSubPhase]);



  /** Design note #275: clears ONE train's route, or every train's when
   *  given `null` -- the panel offers both, because a player fixing one bad
   *  route should not lose the two good ones beside it. */
  const handleClearRoute = useCallback((trainIndex: number | null) => {
    setRouteDrafts((prev) => {
      if (trainIndex === null) return {};
      if (!(trainIndex in prev)) return prev;
      const next = { ...prev };
      delete next[trainIndex];
      return next;
    });
    setRouteFeedback(null);
    /* Design note #493: this used to flip the toggle to "Manual" so the
       control agreed with the button's own tooltip. With no toggle the
       agreement is automatic -- clearing leaves an empty draft the player
       fills by clicking, which is what the map has always allowed. */
  }, []);

  /* ==================================================================
      DESIGN NOTE 1024: ONE STOP, NOT THE WHOLE DRAFT
     ==================================================================
     REQUESTED: "the only option to modify the route is a global 'Clear' button that completely wipes the
     entire array ... allowing the player to seamlessly resume drawing from the new end point."

     THE SPLICE IS `routeTruncate`'s, not this callback's -- it is a rule about an array and belongs where it
     can be tested as one. What is here is the state write and the two things only the shell knows: which
     array the label refers to, and that a route reduced to nothing should leave no key behind.

     AN EMPTY RESULT DELETES THE ENTRY rather than storing `[]`, which is what `handleClearRoute` above does
     and what every reader downstream expects: `routeDrafts[i] ?? []` is the idiom throughout, so an empty
     array and an absent key are the same thing to every consumer and only one of them is the shape the rest
     of this file writes.

     UNCHANGED IS UNCHANGED. `truncateRouteAtHex` returns the SAME array when the label is not in the route --
     a stale click on a stop that has already gone -- so `prev` is returned by reference and React re-renders
     nothing. That is the difference between a no-op and a wipe on a control a player can double-fire. */
  const handleRemoveRouteStop = useCallback((trainIndex: number, hexLabel: string) => {
    setRouteDrafts((prev) => {
      const points = prev[trainIndex] ?? [];
      const next = truncateRouteAtHex(points, hexLabel);
      if (next === points) return prev;
      const updated = { ...prev };
      if (next.length === 0) delete updated[trainIndex];
      else updated[trainIndex] = next as RoutePoint[];
      return updated;
    });
    setRouteFeedback(null);
  }, []);

  /** Design note #1024: what that removal would cost, for the control's own label. Read from render state --
   *  this feeds a tooltip, not a dispatch, so the ref's argument (#275) does not apply. */
  const stopsRemovedByRemoval = useCallback(
    (trainIndex: number, hexLabel: string) =>
      stopsRemovedByTruncating(routeDrafts[trainIndex] ?? [], hexLabel),
    [routeDrafts],
  );

  /** Design note #275: which train the map is drafting for. */
  const handleSelectRouteTrain = useCallback((trainIndex: number) => {
    setActiveTrainIndex(trainIndex);
    setRouteFeedback(null);
  }, []);

  /* Auto Route pre-fills the manual builder and needs no chain; it is a suggestion, dispatched through the same RunManualRoute.
     See docs/ai_architecture/routing_pathfinding.md - App.tsx #202 */
  const handleAutoRoute = useCallback(() => {
    const corporation = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    /* Design note #250: NO TRAIN, NO ROUTE. A corporation with an empty
       roster has nothing to run, so drafting one would produce a priced
       path it can never declare -- a revenue figure with no train behind
       it, which is the "mock revenue" this block exists to stop. */
    if ((corporation?.owned_trains?.length ?? 0) === 0) {
      setRouteFeedback(NO_TRAIN_ROUTE_REASON);
      return;
    }

    /* assignRouteSet chooses the whole set jointly, per-rail rather than per-hex; this loop only unpacks the answer.
       See docs/ai_architecture/routing_pathfinding.md - App.tsx #280 */
    const result = assignRouteSet({
      // Design note #730: a tokened-out city is a terminus, so no drafted route runs past one.
      blocksThrough: blocksThroughCityRef.current,
      mapGrid,
      era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
      /* A route must touch a city this corporation has a token in, so its tokens are the only legal places
         to start looking -- and design note #852: the CITY, which `station_token_hexes` cannot say. */
      startHexes: corporation ? stationTokensOf(corporation) : [],
      trains: ownedTrainRoster.map((train) => ({
        trainIndex: train.trainIndex,
        /* Design note #881: the same permissive answer the click uses. It read `?? 4` -- a third fallback
           for one question, agreeing with neither of the other two -- and `routeAutoTrace` bounds an
           unlimited budget by `MAX_PATH_HEXES` at its own end, so this cannot run away. */
        maxRevenueCentres: reachForDrafting(train.maxDistance),
      })),
    });

    const drafted: Record<number, RoutePoint[]> = {};
    for (const assignment of result.assignments) {
      /* Design note #808: `variant` AND `bypass` COME ACROSS NOW. This map used to copy three fields and
         drop the two that say WHICH WAY THROUGH -- so a bow the tracer had correctly chosen arrived in the
         draft as a plain hex and was re-priced through the station. The reported "$10 counted rather than the
         bypass followed" happened on auto routes for this reason and on hand-drawn ones for another; this is
         the half that was pure loss, since the answer had already been worked out and was thrown away. */
      drafted[assignment.trainIndex] = assignment.path.map((point) => ({
        q: point.q,
        r: point.r,
        hexLabel: point.hexLabel,
        ...(point.variant !== undefined ? { variant: point.variant } : {}),
        ...(point.bypass === true ? { bypass: true } : {}),
      }));
    }

    const anyDrafted = Object.keys(drafted).length > 0;
    if (!anyDrafted) {
      setRouteFeedback(result.reason ?? NO_TRAIN_ROUTE_REASON);
      return;
    }

    setRouteDrafts(drafted);
    // Park the cursor on a train that actually has a route, so the panel's
    // highlighted row and the Clear Route button both refer to something.
    const firstDrafted = ownedTrainRoster.find((train) => drafted[train.trainIndex]);
    if (firstDrafted) setActiveTrainIndex(firstDrafted.trainIndex);
    // Turning the canvas flag on is part of the answer, not a side effect:
    // the drafted path is meant to be editable, and editing it means map
    // clicks have to reach the builder.
    setRouteSelectMode(true);
    /* No success message: every fact in it is already on screen as a fact.
       See docs/ai_architecture/routing_pathfinding.md - App.tsx #266 */
    setRouteFeedback(null);
  }, [gameState, actingProtocolId, mapGrid, currentPhase, ownedTrainRoster]);

  /* Draft once on arrival, then the route is the player's; guarded per corporation so a board change cannot overwrite hand edits.
     See docs/ai_architecture/routing_pathfinding.md - App.tsx #286 */
  const autoDraftedForRef = useRef<number | null>(null);
  useEffect(() => {
    if (!inRunTrainsSubPhase) {
      autoDraftedForRef.current = null;
      return;
    }
    if (autoDraftedForRef.current === actingProtocolId) return;
    autoDraftedForRef.current = actingProtocolId;
    handleAutoRoute();
  }, [inRunTrainsSubPhase, actingProtocolId, handleAutoRoute]);

  /* Design note #493: re-draft on demand. What the toggle's "auto" position
     did minus the mode change -- the tracer runs, the map stays editable,
     and nothing is left switched on. This is how a player abandons an edit
     and returns to the machine's answer. */
  const handleAutoRouteAgain = useCallback(() => {
    setRouteFeedback(null);
    setRouteSelectMode(true);
    handleAutoRoute();
  }, [handleAutoRoute]);

  /* ==================================================================
      DESIGN NOTE 882: THE RULES LEFT; THE PLUMBING STAYED
     ==================================================================
     THIS CALLBACK HELD SEVEN RULES -- where a route may start, what may be added, what a repeat click means,
     no hex twice, adjacency, the bridge, and the capacity -- and every one of them was reachable only
     through a React state setter. Not one had a test; the refusal strings appeared in no harness at all.
     Found by auditing this file rather than by a report, which is the only reason it was found before the
     next bug in it.
     WHAT IS LEFT HERE IS SHELL WORK: read the refs, ask the rule, write the state or show the sentence.
     `editRouteDraft` takes no refs, no setters and no React, so every one of those seven rules is now
     arithmetic a test can hold. */
  const handleRouteHexClick = useCallback(
    (info: {
      q: number;
      r: number;
      hexLabel: string;
      boardLabel: string | null;
      clientX: number;
      clientY: number;
    }) => {
      /* Store boardLabel (the canonical identifier), not hexLabel (the display string) - the pricing table
         and the contract both key on the former.
         See docs/ai_architecture/routing_pathfinding.md - App.tsx #243 */
      const boardLabel = info.boardLabel;
      if (boardLabel === null) return;

      /* Editing a draft makes it yours; with no auto/manual toggle there is nothing to correct.
         See docs/ai_architecture/routing_pathfinding.md - App.tsx #266 */
      setRouteDrafts((all) => {
        const trainIndex = activeTrainIndexRef.current;
        const edit = editRouteDraft({
          mapGrid,
          points: all[trainIndex] ?? [],
          click: { q: info.q, r: info.r, hexLabel: boardLabel },
          displayLabel: info.hexLabel,
          maxDistance: ownedTrainRosterRef.current.find(
            (train) => train.trainIndex === trainIndex,
          )?.maxDistance,
          /* Design note #1023: the same wall the network reach and the auto-tracer walk. Read through the ref
             for #850's reason -- this is a click handler the canvas holds across renders, so a closure over
             `blocksThroughCity` would judge the board as it stood when the handler was built. */
          blocksThrough: blocksThroughCityRef.current,
        });
        if (!edit.ok) {
          setRouteFeedback(edit.reason);
          return all;
        }
        setRouteFeedback(null);
        return { ...all, [trainIndex]: edit.points };
      });
    },
    // mapGrid joins for #186's track check; the draft and active train are read through refs so the canvas
    // click prop is not rebuilt mid-draw.
    // See docs/ai_architecture/routing_pathfinding.md - App.tsx #232
    [mapGrid],
  );

/* routeHopCount is deleted: a 2-train is capped at two revenue centres, not two hexes of travel.
   See docs/ai_architecture/routing_pathfinding.md - App.tsx #156 */

  // Every draft priced in one memo, so the panel, the total and the dispatch cannot disagree. #474: the corporation's tokens, derived once.
  // See docs/ai_architecture/routing_pathfinding.md - App.tsx #275
  /* Design note #853: TOKENS, NOT HEXES -- the same correction #852 made to the router's start, on the rule
     that judges a hand-drawn route. `station_token_hexes` cannot say which city on New York NNH holds, so a
     route entering by the other city's rail satisfied "contains one of your tokens". */
  const routeTokenHexes = useMemo<ReadonlyArray<StationToken>>(() => {
    const corporation = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    return corporation ? stationTokensOf(corporation) : [];
  }, [gameState, actingProtocolId]);

  const trainDrafts = useMemo<TrainRouteDraft[]>(() => {
    const era = ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"];
    return ownedTrainRoster.map((train) => {
      /* Design note #808: DERIVED AT THE PRICING BOUNDARY, not at click time. A hand-drawn route is a list of
         hexes; whether one of them must be crossed on a bow depends on who is acting and who holds tokens
         where, and both change under the player while the draft sits there. Marking it here means the answer
         cannot go stale, and means the pricing below and the dispatch in `handleRunTrains` apply the SAME
         function to the same points rather than two copies of one rule (#775's lesson). */
      const points = withForcedBypass(
        routeDrafts[train.trainIndex] ?? [],
        mapGrid,
        blocksThroughCityRef.current,
      );
      const breakdown =
        points.length < 2
          ? null
          : sandboxRouteBreakdown(mapGrid, routePointsToWaypoints(points), era);
      /* An unknown train falls back to the smallest real capacity rather than having none; the count is stops.length, the list the panel renders.
         See docs/ai_architecture/routing_pathfinding.md - App.tsx #285 */
      const centres = breakdown?.stops.length ?? 0;
      /* Design note #881: `cap` is gone from here -- `overrunsReach` below owns the fallback it carried, and
         a local that only fed one expression is how the fallback came to differ from its three siblings. */
      const last = points[points.length - 1];
      return {
        trainIndex: train.trainIndex,
        model: train.model,
        maxDistance: train.maxDistance,
        hexLabels: points.map((point) => point.hexLabel),
        stops: breakdown?.stops ?? [],
        /* Design note #250: `null`, not `0`, for a corporation with no
           trains -- zero is a real answer meaning "worth nothing" and the
           honest answer there is that the question does not apply. */
        value: ownsAnyTrain ? (breakdown?.revenue ?? null) : null,
        revenueCentres: centres,
        /* Design note #285: `999` is the Diesel's genuine "unlimited"; an absent figure is ignorance and must
           not read as one -- which is why the unknown fallback here is the SMALLEST train rather than no
           limit at all.
           Design note #881: and both halves of that now live in `overrunsReach`, because this file asked the
           same question in four places and no two agreed. The sentinel was `!== 999` here and `>= 999` in
           `routeAutoTrace`; the click path below had no sentinel at all. */
        exceedsMaxDistance: overrunsReach(centres, train.maxDistance),
        // Design note #256/#264: only meaningful once there is a route.
        endsOffTerminus:
          points.length >= 2 && last !== undefined
            ? !isRouteTerminusHex(mapGrid, last.hexLabel)
            : false,
        /* A route must touch a city this corporation holds a token in - ANY token, anywhere on the run.
           See docs/ai_architecture/routing_pathfinding.md - App.tsx #474 */
        tokenBlockReason:
          routeTokenBlockReason(points, routeTokenHexes, mapGrid) ??
          /* Design note #730a: and the wall, for a route drawn by hand. The tracer cannot produce one; a
             player can, and both go to the same dispatch. */
          routeBlockedCityReason(
            points,
            blocksThroughCityRef.current,
            (q, r) => STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r)?.label ?? null,
            /* Design note #808: and the hex that is not a wall. Altoona's bow does not enter its city, so a
               full city has nothing to say about it -- and refusing here is what produced the reported "it
               spit back the error that Altoona is tokened out" on a route the rules allow. */
            (q, r) => hexOffersBypass(mapGrid, q, r),
            /* Design note #1022: THE SAME RESOLVER THE ROUTER USES. `cityEnteredFrom` wraps `cityForArrival`,
               which is what `reachableTrack` and the route tracer ask -- so the validator now judges the city
               the route actually passes through rather than refusing a hex because its OTHER city is shut. */
            (hex, from) => cityEnteredFrom(mapGrid, hex, from),
          ),
      };
    });
  }, [ownedTrainRoster, routeDrafts, mapGrid, currentPhase, ownsAnyTrain, routeTokenHexes]);

  /* One overlay per drafted train, all in the corporation's colour. The hover cursor is shared by three surfaces and is deliberately not persisted.
     See docs/ai_architecture/routing_pathfinding.md - App.tsx #373 */
  const [highlightedTrainIndex, setHighlightedTrainIndex] = useState<number | null>(null);

  /* Cleared when the sub-phase moves off Run Routes: the cursor describes a
     relationship between three surfaces that only two of them show outside
     that step, and a stale highlight on a chip whose panel has gone would
     be a mark nothing explains. */
  useEffect(() => {
    if (orSubPhase !== "Routes") setHighlightedTrainIndex(null);
  }, [orSubPhase]);

  /* ==================================================================
   *  DESIGN NOTE 740: THE PRESENCE CHANNEL
   * ==================================================================
   *
   * REQUESTED: rivals watch a president draft routes live. #739 built the row that shows them and found the
   * blocker -- `routeDrafts` is local React state that never leaves the client.
   *
   * WHAT ARRIVES HERE IS A HINT AND NOTHING ELSE. It is held in its own state, feeds two read-only surfaces,
   * and is consulted by nothing that computes game state. `presence.ts` #740 has the full argument; the short
   * version is that this codebase's guarantees come from having exactly one source of truth, and a second
   * stream about the same game breaks them the moment anything downstream believes it. */
  const [presence, setPresence] = useState<PresenceState[]>([]);
  const lastPresenceAtRef = useRef<number | null>(null);

  useEffect(() => {
    const room = sandboxRoomCode;
    if (!room) {
      setPresence([]);
      return undefined;
    }
    return subscribeSandboxPresence(room, setPresence);
  }, [sandboxRoomCode]);

  /* PUBLISH, COALESCED. The effect re-runs on every draft keystroke and mostly does nothing -- `shouldPublishNow`
     is the floor, and a hex click is a keystroke. */
  useEffect(() => {
    const room = sandboxRoomCode;
    const me = viewerAddress;
    if (!room || !me) return;
    if (
      !shouldPublishRoutes({
        isMyTurn,
        orSubPhase: orSubPhase ?? null,
        inRoom: true,
      })
    ) {
      /* Design note #740: CLEARED, not left to go stale. Staleness is the safety net for a client that
         vanished; a turn that ended cleanly should take its routes off the board immediately. */
      if (lastPresenceAtRef.current !== null) {
        lastPresenceAtRef.current = null;
        void clearPresence(room, me);
      }
      return;
    }

    const now = Date.now();
    if (!shouldPublishNow(lastPresenceAtRef.current, now)) return;
    lastPresenceAtRef.current = now;
    void publishPresence(room, {
      playerId: me,
      at: now,
      actingCompanyId: actingProtocolId,
      routeDrafts: Object.fromEntries(
        Object.entries(routeDrafts).map(([index, points]) => [
          Number(index),
          points.map((point) => [point.q, point.r] as [number, number]),
        ]),
      ),
      /* ==================================================================
          DESIGN NOTE 1021: PUBLISH THE FIGURE, NOT JUST THE PATH
         ==================================================================
         REPORTED: the acting player's client priced a route at $440 and a watching client priced the same
         route at $450.

         `trainDrafts` IS THE ACTING PLAYER'S OWN ANSWER -- the exact value on the chips they are looking at,
         priced against their board, their era and their bypass marks. Publishing it means a watcher renders
         what the drafter sees rather than a second opinion assembled from inputs that only mostly agree.

         READ FROM `trainDrafts` RATHER THAN RE-PRICED HERE, which would have been the same mistake one file
         over: two calls to one pricer is still two answers. */
      routeValues: Object.fromEntries(
        trainDrafts
          .filter((draft) => draft.value !== null)
          .map((draft) => [draft.trainIndex, draft.value as number]),
      ),
    });
    // Design note #1021: `trainDrafts` joins the deps because the published figures come from it.
  }, [sandboxRoomCode, viewerAddress, isMyTurn, orSubPhase, routeDrafts, trainDrafts, actingProtocolId]);

  /** Design note #740: somebody else's live drafts, fresh and worth drawing. */
  const rivalPresence = useMemo(
    () => visiblePresence(presence, viewerAddress ?? null, Date.now()),
    [presence, viewerAddress],
  );

  /** Design note #740: the spectator's version of `trainDrafts`, built from the presence channel.
   *
   *  THE MODEL IS LOOKED UP, NOT CARRIED -- and the first version of this got the conclusion backwards.
   *
   *  It labelled the chips "Train 1", reasoning that presence carries a train INDEX and no roster, so the
   *  model was not knowable. REPORTED: "Nobody knows what 'Train 1' is. Have it display the actual train
   *  that's running." Correct, and the reasoning behind the placeholder was confused: the roster is not
   *  missing, it is GAME STATE -- which every client already holds, replayed from the same log. Presence
   *  carries `actingCompanyId` and an index; `gameState` turns that pair into "3-Train" locally.
   *
   *  WHICH IS THE SAME DISCIPLINE THE REVENUE ALREADY USED, and I applied it to one field and not the other.
   *  Both are DERIVED FROM TRUTH and merely INDEXED BY A HINT: the route being priced is a guess about what a
   *  rival will do, but the board it is priced against, and the fleet it is attributed to, are facts. Keeping
   *  the channel thin is right; refusing to join it to state the reader already has is not. */
  /* ==================================================================
      DESIGN NOTE 875: ONE CHIP PER TRAIN, OR ONE CHIP PER DRAFT?
     ==================================================================

     REPORTED, AND NOT FOR THE FIRST TIME: "On Run Routes subphase, non-active players STILL cannot see the
     train chips + revenue of the operating corporation. It is imperative that this gets fixed."

     THE TWO SIDES OF ONE PROP WERE BUILT FROM DIFFERENT THINGS, and that is the whole bug. `trainDrafts`
     above maps `ownedTrainRoster` -- one entry PER TRAIN, so a chip exists whether or not a route has been
     drawn for it, with `value: null` until one is. This mapped `entry.routeDrafts` -- one entry PER DRAFTED
     ROUTE. A president who has drafted nothing publishes nothing, so a watcher's array was EMPTY, and the
     row's own `trainDrafts.length > 0` guard then hid it completely. Not a missing chip: a missing row.

     WHICH IS WHY IT SURVIVED TWO FIXES. #740 and #802 both worked on this path and both tested it with
     routes already drawn, where presence does carry an entry per train and the row looks right. The failure
     is the state a watcher is in for most of the step -- watching, before anything is drawn.

     AND #802'S NOTE SAID THIS WAS ALREADY TRUE: "The chips render for the whole table (they come off
     `activeCorporation.trains`, which is shared state) and the drafts arrive through presence for a watcher
     and locally for the actor." That is exactly the right design and it describes the president's branch
     only. The watcher's branch never read the roster at all.

     SO THE FLEET COMES FROM STATE AND ONLY THE REVENUE COMES FROM PRESENCE. `ownedTrainRoster` is derived
     from `actingProtocolId` against `gameState`, so it is the same list on every client in the room --
     replayed from the same log. A watcher needs no channel to know which trains are running; they need one
     to know what the president has plotted for them, which is what presence is for and all it is for.
     THE INDEX CONVENTION SURVIVES. `RIVAL_ROUTE_INDEX_BASE` keeps a watcher's chips from colliding with
     their own drafts on the key three surfaces join by (#373/#740), and the map overlay below still keys
     rival routes the same way -- so hovering a chip still lights the right line. */
  /** Design note #1031: what the acting corporation's trains actually earned, once the run is committed.
   *
   *  ITS OWN MEMO RATHER THAN A READ INSIDE THE CHIP MEMO, for two reasons. The narrow one is dependencies:
   *  the chip memo lists `ownedTrainRoster` and `actingProtocolId` and adding the whole of `gameState` would
   *  rebuild every chip on any state change at all. The wider one is that `activeStationCompany` already sits
   *  a couple of thousand lines up, holding the same lookup under a name about token pricing -- and reusing a
   *  variable whose name has stopped describing what the caller wants is the shape that keeps producing bugs
   *  here (a proxy that no longer stands for its subject). A second lookup with an honest name is cheaper than
   *  a shared one with a misleading one. */
  const actingRunBreakdown = useMemo(
    () =>
      gameState?.public_companies.find((company) => company.company_id === actingProtocolId)
        ?.last_run_breakdown ?? null,
    [gameState, actingProtocolId],
  );

  /* Design note #875: the rule lives in `watcherRouteChips.ts` so it can be tested as arithmetic rather than
     scanned for. This memo supplies the board -- the roster from game state, the pricing and the hex names --
     and fills in the fields a watcher's row does not carry. */
  const rivalTrainDrafts = useMemo<TrainRouteDraft[]>(() => {
    const era = ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"];
    /* THE ACTING CORPORATION'S OWN ENTRY, not "any rival". Presence carries one entry per connected player;
       the one that matters is whoever is publishing drafts for the company now operating. `null` when nobody
       is -- the ordinary case at the start of the step, and the case that used to produce no row at all. */
    const actor =
      rivalPresence.find((entry) => entry.actingCompanyId === actingProtocolId) ?? null;
    return watcherTrainDrafts({
      roster: ownedTrainRoster,
      actorDrafts: actor?.routeDrafts ?? null,
      labelForHex: (q, r) => STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r)?.label,
      priceRoute: (labels) =>
        sandboxRouteBreakdown(mapGrid, labels.map((hex) => ({ hex })), era).revenue,
      /* Design note #890: the paying stops, from the SAME breakdown that prices the route one line up. Two
         calls rather than one because the two fields are optional independently -- and re-deriving the stops
         from a second pricing pass is how the figure and its itemisation come to disagree. */
      stopsFor: (labels) =>
        sandboxRouteBreakdown(mapGrid, labels.map((hex) => ({ hex })), era).stops,
      /* Design note #1021: the acting player's own figure, straight off the presence channel. `undefined`
         when they publish none, which falls through to `priceRoute` above. */
      valueFor: (trainIndex) => actor?.routeValues?.[trainIndex],
      /* ==================================================================
          DESIGN NOTE 1031: THE COMMITTED FIGURE, READ OFF THE REPLAYED STATE
         ==================================================================
         NOT FROM `actor`, WHICH IS THE POINT. Every other input to this memo that carries a revenue figure
         comes through presence and therefore exists only while somebody is publishing. This one is read from
         the corporation the round is operating, so it is there for a watcher who joined after the run, or
         reloaded, or simply looked at the panel a minute later.
         `undefined` RATHER THAN `0` WHEN THERE IS NO ENTRY, because the chip's chain distinguishes them:
         `??` falls through on `undefined` to the live figure, and would stop on a `0` that means "no such
         train in the breakdown". `find` returning nothing is the "cannot say" case (#232), and a train that
         genuinely earned nothing has an entry saying "0". */
      bankedFor: (trainIndex) => {
        const entry = actingRunBreakdown?.find((row) => row.train_index === trainIndex);
        return entry === undefined ? undefined : Number(entry.printed_revenue) || 0;
      },
    }).map((chip) => ({
      ...chip,
      /* Design note #740: the rest of the shape, filled with the honest empties. A watcher's row shows a chip
         and a figure; the fields behind the president's own planner -- capacity, the full path, the legality
         complaints -- are about a DECISION this reader is not making, and inventing plausible values for them
         would be the #724 mistake in a new place.
         ==================================================================
          DESIGN NOTE 890: THE PATH AND ITS STOPS ARE NOT AMONG THEM
         ==================================================================
         REPORTED: "Non-active players should see the same drafted route data the acting corporation does."
         #740's LINE IS DRAWN IN THE RIGHT PLACE AND TWO FIELDS WERE ON THE WRONG SIDE OF IT. Its rule is
         sound -- do not invent values for a decision this reader is not making -- and `maxDistance`,
         `exceedsMaxDistance`, `endsOffTerminus` and `tokenBlockReason` are exactly that: complaints about a
         draft the watcher cannot edit. But `hexLabels` and `stops` are not a decision, they are the ROUTE,
         and the watcher is already looking at it drawn across the board. Blanking them here is what made the
         chip say "No route drafted for this train yet" about a line the reader could see.
         `revenueCentres` STAYS ZERO, which is the boundary case worth naming: it is a count used to judge
         whether the run fits the train, which is the capacity question above. */
      maxDistance: undefined,
      revenueCentres: 0,
      exceedsMaxDistance: false,
      endsOffTerminus: false,
      tokenBlockReason: null,
    }));
  }, [
    rivalPresence,
    mapGrid,
    currentPhase,
    ownedTrainRoster,
    actingProtocolId,
    // Design note #1031: #1020's lesson at the memo layer -- a figure read inside a memo that does not list it
    // is a figure that stops updating the moment nothing else in the list changes.
    actingRunBreakdown,
  ]);

  const manualRouteOverlay = useMemo<RouteOverlay[]>(() => {
    const overlays: RouteOverlay[] = [];
    for (const train of ownedTrainRoster) {
      const points = routeDrafts[train.trainIndex] ?? [];
      // `drawRouteOverlays` skips anything shorter, but filtering here keeps
      // the array identity stable for the canvas's dependency check.
      if (points.length < 2) continue;
      overlays.push({
        trainLabel: `${train.model}-Train`,
        /* Design note #494: PER TRAIN. This was one corporation colour
           computed above the loop and given to every route, so overlapping
           runs were literally the same line drawn twice. */
        color: routeTrainColor(train.trainIndex),
        hexes: points.map((point) => [point.q, point.r] as [number, number]),
        /* Design note #820: and WHICH WAY THROUGH each one. #808 taught `RoutePoint` to carry the variant so
           the wire and the pricing agree; the drawing was the last surface still guessing, so a route priced
           on Altoona's bow was drawn through its station. Index-aligned with `hexes` above, from the same
           `points` in the same order. */
        variants: points.map((point) => point.variant),
        // Design note #373: the join key the three surfaces share.
        trainIndex: train.trainIndex,
        /* Connects highlightedTrainIndex to the renderer's primary/muted emphasis; normal when nothing is highlighted.
           See docs/ai_architecture/routing_pathfinding.md - App.tsx #495 */
        emphasis: routeEmphasisFor(train.trainIndex, highlightedTrainIndex),
      });
    }
    /* Design note #740: AND THE RIVALS' LIVE DRAFTS. Appended rather than merged, and after the local ones, so
       the viewer's own routes are drawn last and stay on top -- their emphasis is the one they are steering.
       IDENTIFIED BY SEAT, not by train index: two clients both drafting train 0 would otherwise collide on
       `trainIndex`, which is the key the highlight and the chip row join on. Offsetting into a private range
       keeps a rival's line un-hoverable from this player's chips, which is correct -- hovering somebody else's
       chip row is not a thing that exists. */
    for (const entry of rivalPresence) {
      /* ==================================================================
          DESIGN NOTE 890: THE OPERATING CORPORATION'S ROUTES ARE NOT "SOMEBODY ELSE'S"
         ==================================================================
         REPORTED: "the highlighting of the route dims the route for non-active players, whereas for the
         operating corporation it brightens (and slightly widens?). Everyone should get the brighter (and
         wider?) route highlighting."
         #740 WROTE ONE RULE FOR TWO POPULATIONS. Its sentence -- "a live draft belonging to somebody else is
         context, and drawing it at the same weight as the reader's own route would make the board argue
         about whose turn it is" -- is right about a RIVAL, and a rival is what it was written for. In an
         Operating Round there is one acting corporation, and the presence entry carrying its drafts is not
         somebody else's context: it is THE run, the only one on the board, and the thing every player at the
         table is watching. Muting it makes the board argue that nothing is happening.
         SO THE POPULATION IS SPLIT RATHER THAN THE RULE REWRITTEN. The offset and the mute survive for
         entries that are not the acting corporation's -- two clients drafting at once is still a real state
         in a sandbox, and #740's collision argument still holds there. */
      const isActor =
        entry.actingCompanyId !== null &&
        entry.actingCompanyId !== undefined &&
        entry.actingCompanyId === actingProtocolId;
      for (const [index, hexes] of Object.entries(entry.routeDrafts ?? {})) {
        if (hexes.length < 2) continue;
        overlays.push({
          trainLabel: isActor ? `${index}` : `${entry.playerId}'s route`,
          color: routeTrainColor(Number(index)),
          hexes: hexes.map((hex) => [hex[0], hex[1]] as [number, number]),
          /* THE REAL INDEX FOR THE ACTOR, so the chip row and the highlight join on it -- which is also what
             gives the route its emphasis, since `routeEmphasisFor` compares against the hovered chip. */
          trainIndex: isActor ? Number(index) : RIVAL_ROUTE_INDEX_BASE + Number(index),
          emphasis: isActor
            ? routeEmphasisFor(Number(index), highlightedTrainIndex)
            : "muted",
        });
      }
    }
    return overlays;
  }, [ownedTrainRoster, routeDrafts, highlightedTrainIndex, rivalPresence, actingProtocolId]);

  /* handleTileDispatched/handleCloseTilePopup removed: the radial selector confirms through runGameplayAction, so there is one dispatch route and one log writer.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #162 */


  // In sandbox the chart derives from the same corporations table the cards read. MOCK_MARKET_GRID is the placeholder path only.
  // See docs/ai_architecture/stock_market.md - App.tsx #247
  const marketGrid = useMemo<MarketGridResponse>(
    () =>
      sandbox
        ? {
            game_id: gameId,
            // Design note #272: `sandboxMarket`, not the fixture constant.
            // The old dependency list was `[sandbox, gameId]` -- neither of
            // which ever changes mid-session, which is precisely why the
            // chart could not move.
            positions: sandboxMarketPositions(sandboxMarket),
          }
        : MOCK_MARKET_GRID,
    [sandbox, gameId, sandboxMarket],
  );

  /* One PlayerFinances per seat, memoised - sellableHoldings walks every corporation for every player.
     See docs/ai_architecture/stock_market.md - App.tsx #563 */
  const playerFinancesBySeat = useMemo(() => {
    /* Design note #593 excluded the Operating Round here, "for the reason `actingSeatIndex` draws the same
       line -- its turn belongs to a corporation."
       Design note #819: THE ROUND GATE MOVES TO THE RENDER SITES, because the cards now render in an
       Operating Round too and finances are not a fact about a round. #606 had already taken the other half of
       this out -- `showSeatOrder` went because "`activeAddress` already carries the same fact" -- and what was
       left was a DATA gate doing a LAYOUT job. Nothing downstream changes: an OR passes the acting
       president's address, which is the line #593 wanted drawn, drawn where it belongs. */
    if (!gameState) return [];
    const prices = Object.fromEntries(
      (marketGrid?.positions ?? []).map((entry) => [entry.company_id, Number(entry.price)]),
    ) as Readonly<Record<number, number | null>>;
    return gameState.player_addresses
      .map((address) =>
        playerFinances(
          address,
          gameState,
          prices,
          settledPrivatePrices,
          /* Design note #734: the zone table, so the card's Certs figure honours the same yellow/orange/brown
             exemption the Ledger and the reducer already do. Without it the card was the only surface in the
             app counting exempt shares against the limit. */
          marketZoneForPrice,
        ),
      )
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }, [gameState, marketGrid, settledPrivatePrices]);

  /* ---- Design note #670: what just happened to everyone's money. ----

     REPORTED: "when players click Pay Dividends, it is very hard to tell if the
     game is actually doing so." The payout worked and the log said so; what a
     reader could not do was SEE it, because a balance of $540 confirms a payout
     only to somebody who had memorised $530. `cashDelta.ts` owns the
     arithmetic; this owns when to ask it.

     TWO SOURCES, BECAUSE THERE ARE TWO CLOCKS. In a room the board advances one
     logged action at a time and the drain below knows exactly which; on a live
     chain it advances when a poll comes back and nobody knows what moved. So the
     room measures per action and the chain diffs the poll -- and BOTH funnel
     into the one `noteCashChanges` so the badge cannot mean two things. */
  /* Design note #697: the toast. A token rather than a timestamp, because two identical purchases in a row
     produce the same SENTENCE, and the toast has to re-show for the second one -- which is the repeat this
     whole feature is about. */
  const [actionToast, setActionToast] = useState<{
    text: string;
    token: number;
    /** Design note #738: the dividend receipt's second line. Absent on an ordinary #697 receipt. */
    detail?: string | null;
    /** Design note #929: the era transition, when this toast is announcing one. */
    eraTransition?: { from: string; to: string } | null;
    /** Design note #966: a longer window for the one toast that is a LIST. Absent means the standard 3700ms.
     *  Design note #983: that window is 400ms now, on instruction -- shorter than the standard rather than
     *  longer. The field is unchanged; only the value one caller passes is. */
    durationMs?: number;
    /** Design note #984: the private-revenue table's rows, kept as rows so the toast can align them. */
    detailRows?: readonly { label: string; value: string }[] | null;
    /** Design note #1016: where it sits. Optional, so only the ambient toast names it. */
    anchor?: ToastAnchor;
      /* Design note #1047: carried on the toast rather than inferred from `detailRows` or the anchor -- the
       fifth recurring bug shape in this codebase is a proxy that stands for its subject until a second caller
       has rows, or wants the corner, and does not want to wait. */
    persistent?: boolean;
    /** Design note #1048: the left-edge identity colour, or `null` for a toast about the table. */
    accentColor?: string | null;
} | null>(null);
  const actionToastTokenRef = useRef(0);
  /* Design note #738: the same toast with a second line. Kept as a separate entry point rather than an extra
     argument on `showActionToast`, because the two have different RULES about when they fire -- #718's
     receipt is for your own dispatch, this is a notification about somebody else's -- and one function
     answering to both invitations is how #718's scope crept in the first place. */
  const showDividendToast = useCallback(
    (
      text: string,
      detail: string | null,
      eraTransition: { from: string; to: string } | null = null,
      durationMs?: number,
      /* Design note #984: LAST AND OPTIONAL, so the four existing call sites are untouched. One caller has a
         table; every other toast in this app has one thing to say (#697) and should not have to say `null`
         to a slot it does not use. */
      detailRows: readonly { label: string; value: string }[] | null = null,
      /* Design note #1016: LAST AND OPTIONAL for #984's reason -- four callers want the centred position and
         should not have to name it. */
      anchor: ToastAnchor = "center",
      /* Design note #1047: LAST AND OPTIONAL, for #984's and #1016's reason -- exactly one caller waits to be
         dismissed and the other four should not have to say `false`. */
      persistent = false,
      /* Design note #1048: whose toast this is. `null` for the era announcement, which is about the table. */
      accentColor: string | null = null,
    ) => {
      // Design note #825: nothing has just happened during a rebuild -- see the flag's own note.
      if (replayingHistory) return;
      actionToastTokenRef.current += 1;
      setActionToast({
        text,
        detail,
        // Design note #984: the structured rows, for the one toast that is a table rather than a sentence.
        detailRows,
        // Design note #1047: whether it waits for the player rather than for a clock.
        persistent,
        // Design note #1048: the identity edge -- the private cards' accent, or the viewer's seat colour.
        accentColor,
        // Design note #1016: where it sits, carried with it rather than inferred downstream from `detailRows`.
        anchor,
        eraTransition,
        durationMs,
        token: actionToastTokenRef.current,
      });
    },
    [],
  );

  /* ==================================================================
      DESIGN NOTE 1060: THE PAYOUT OVERLAY, RAISED LIKE EVERY OTHER NOTIFICATION
     ==================================================================
     GUARDED ON `replayingHistory` FOR #825's REASON, which matters more here than for a toast: joining a room
     replays every dividend the table has ever declared, and an unguarded overlay would run a 900ms animation
     and a sound for each of them, in sequence, while the board rebuilt. "A badge marks a move, not a
     catch-up" (#670), and this is the loudest thing in the app to get that wrong with.
     A TOKEN RATHER THAN THE OBJECT'S IDENTITY, because two dividends in one round can pay the same viewer the
     same amount from the same corporation -- #697's argument for the toast's token, and the same fix: the
     component keys its animation on the number, so an identical second payout restarts rather than sitting
     finished. */
  const moneyMachineTokenRef = useRef(0);
  const [dividendPayout, setDividendPayout] = useState<DividendPayoutEvent | null>(null);
  const showDividendPayout = useCallback((payout: DividendPayoutEvent) => {
    if (replayingHistory) return;
    setDividendPayout(payout);
  }, []);
  /* Design note #1062: THE COMPONENT OWNS THE TIMING AND THIS OWNS THE PLAYING, which keeps the mute and the
     radio ducking in the one helper every other cue goes through (#1041).
     Design note #1082: #1062's "fires on impact, not on mount" is superseded -- it now fires at 1.15s so the
     clip's bell, which sits 0.85s in, lands on the 2.0s merge. That figure lives with the schedule in
     `DividendMoneyMachine`; this side is unchanged and deliberately knows nothing about it. Which is the
     point of the split: re-timing the animation did not touch the audio wiring. */
  const handleMoneyMachineCue = useCallback(() => {
    playVariantCue(MONEY_MACHINE_SFX, sfxEnabledRef.current && sfxPayoutRef.current);
  }, []);
  const handleMoneyMachineDone = useCallback(() => setDividendPayout(null), []);

  const showActionToast = useCallback((text: string, durationMs?: number) => {
    /* Design note #825: and #718's receipt likewise. "Did my button register" is a question about a click
       that just happened; replayed a minute later it answers about somebody's move from ten turns ago. */
    if (replayingHistory) return;
    actionToastTokenRef.current += 1;
    /* Design note #1072: LAST AND OPTIONAL, so the refusal notice and every other receipt keep the standard
       window and do not have to name one -- #984's and #1016's rule for the same shape one file over. */
    setActionToast({ text, token: actionToastTokenRef.current, durationMs });
  }, []);

  /* ==================================================================
      DESIGN NOTE 1049: THE PAYOUT PHASE, AS A PIECE OF SHELL STATE
     ==================================================================
     RAISED THROUGH A GUARDED SETTER RATHER THAN SET DIRECTLY, and the guard is the whole reason this is a
     function at all when it has exactly one caller. `showDividendToast` and `showActionToast` above both open
     with the same line, for #825's reason: a client rebuilding the board by replaying the log is not watching
     anything happen. Without it, joining a game in progress would open, and demand a click on, one payout
     modal for every Operating Round the table has already played.
     STATE, NOT A REF, because the modal's visibility is rendered from it. And a plain object rather than a
     queue: at most one Operating Round opens per dispatch, so there is never a second one waiting. */
  const [privatePayoutPhase, setPrivatePayoutPhase] = useState<{
    viewerName: string;
    viewerSeatColor: string | null;
    // Design note #1052: `privateId` rides along so the panel numbers a private the way every other one does.
    lines: readonly { privateId: number; label: string; value: string }[];
    total: number;
    // Design note #1052: the movement, read off the two states rather than derived from the total.
    cashBefore: number | null;
    cashAfter: number | null;
    others: readonly PrivateRevenueOther[];
    roundLabel: string | null;
  } | null>(null);
  const showPrivatePayoutPhase = useCallback(
    (phase: NonNullable<typeof privatePayoutPhase>) => {
      if (replayingHistory) return;
      setPrivatePayoutPhase(phase);
    },
    [],
  );

  /* ==================================================================
      DESIGN NOTE 868: THE ERA IS GOOD NEWS, SO IT IS ANNOUNCED, NOT COUNTED DOWN TO
     ==================================================================

     SPECIFIED: "the meaningful era change information (Green Tiles are now available, Brown Tiles are now
     available) could be a toast notification to every player when the threshold is crossed. The Rust and
     Limit warnings restrict what players can do, the Era change expands their repertoires."

     THE DISTINCTION IS THE DESIGN. A warning badge is a countdown to a LOSS, and it earns its colour because
     a player may want to act before it lands -- sell a train, spend a slot. Nothing about new tiles needs
     preparing for, so counting down to them put good news in a row that means danger. This fires once, when
     it is true.

     `showDividendToast` RATHER THAN `showActionToast`, on #738's own distinction: that one is a receipt for
     YOUR dispatch, this is a notification about a change in the world, and every player at the table gets it
     because every player derives it from the same state.

     DERIVED, NOT DISPATCHED. There is no era-change message on the wire and there should not be -- the era
     is a function of the highest train in play (#1), so each client can see the moment it turns. A message
     would be a second source for a fact already in `gameState`.

     THE FIRST OBSERVATION IS NOT A CHANGE, which is the whole subtlety here. On page load, on a refresh, and
     on a client joining mid-game the ref starts empty and the era is simply whatever it is; toasting there
     would announce "Green Tiles are now available" to somebody who has been laying green tiles for an hour.
     `replayingHistory` is handled inside `showDividendToast` already (#825). */
  /* ==================================================================
      DESIGN NOTE 1094: THIS EFFECT IS GONE, AND ITS GUARD COULD NEVER HAVE WORKED
     ==================================================================
     IT RAISED THE ERA TOAST FROM A `useEffect` watching the derived phase, holding the previous era in a ref
     -- and its own note said the load case was handled, because "the ref starts empty and the era is simply
     whatever it is". That is true of the FIRST observation and false of every one after it during a rebuild.
     A refresh replays the whole action log, the phase crosses 2->3->5 as it goes, React commits between the
     awaited dispatches, and the effect sees each crossing as a live change. The player who reloaded gets told
     green tiles are available, then brown, for a game that has been brown for an hour. Reported exactly that
     way, and an undo does the same thing for the same reason.

     `showDividendToast` ALREADY GUARDS ON `replayingHistory` AND THE GUARD IS BLIND HERE. That flag is set
     and cleared SYNCHRONOUSLY around each dispatch (#825's `finally`); a `useEffect` runs after React
     commits, which is after the `finally`. So the flag is false every time this effect reads it -- not
     sometimes, always. It was the only ephemeral raiser called from an effect; the other four are called
     from inside dispatches, where the flag is exactly what it claims to be.

     SO THE TRANSITION IS DERIVED IN THE DISPATCH, from `before` and `after`, which is #1057's shape for
     every derived line in this shell: the reducer settles, the shell narrates the diff. #868's reasoning is
     untouched -- it still fires once when the threshold is crossed, it still goes to every player, and it is
     still derived rather than dispatched, because a state comparison is not a message. What changes is only
     WHERE the comparison happens, and therefore whether the replay guard can see it. See the era block beside
     the round transitions below.

     A SECOND FLAG WOULD HAVE BEEN THE WRONG FIX. Publishing "is a rebuild in flight" as React state so this
     effect could read it means two answers to one question kept in step by hand, which is #891, and it would
     still be racing the commit it was added to describe. */

  const [cashDeltas, setCashDeltas] = useState<CashDelta[]>([]);
  const noteCashChanges = useCallback(
    (changes: ReadonlyArray<{ address: string; amount: number }>) => {
      if (changes.length === 0) return;
      setCashDeltas((current) => settleCashDeltas(current, changes, Date.now()));
    },
    [],
  );

  /* A badge has to be able to expire with nothing else happening -- a dividend
     is often the last event for a while. So a timer re-settles the set, which
     drops whatever has aged out; `settleCashDeltas` returns the SAME array when
     nothing expired, so this cannot loop. */
  useEffect(() => {
    if (cashDeltas.length === 0) return undefined;
    const timer = window.setTimeout(() => {
      setCashDeltas((current) => {
        const next = settleCashDeltas(current, [], Date.now());
        return next.length === current.length ? current : next;
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [cashDeltas]);

  /* THE LIVE-CHAIN HALF. Polled state, so the only question a diff can answer
     is "different from last time" -- which is the right question there and the
     wrong one in a room, where a rebuild replays the entire game through the
     same state variable and would fire a badge for every historic action at
     once. Hence the guard: in a room the drain measures instead. */
  const polledCashRef = useRef<CashByPlayer>({});
  useEffect(() => {
    if (sandbox) return;
    const next = cashByPlayer(liveGameState);
    const previous = polledCashRef.current;
    polledCashRef.current = next;
    noteCashChanges(cashChanges(previous, next));
  }, [sandbox, liveGameState, noteCashChanges]);

  /** Keyed for the two surfaces that render a badge. Rebuilt only when the set
   *  changes, so a card is not re-rendered by an unrelated poll. */
  const cashDeltaByPlayer = useMemo(() => {
    const out: Record<string, CashDelta> = {};
    for (const delta of cashDeltas) out[delta.address] = delta;
    return out;
  }, [cashDeltas]);
  const cashDeltaFor = useCallback(
    (address: string) => cashDeltaByPlayer[address]?.amount ?? 0,
    [cashDeltaByPlayer],
  );

  /* Design note #670 built `playerCashRows` for the strip: "seating order, cash only -- everything else a
     player might want is a tab away, and a second copy of it here would be a second thing to keep true."
     Design note #819: DELETED WITH THE STRIP. `PlayerCards` reads `playerFinances`, which already carries the
     cash alongside everything else, so this was a second shape over one dataset -- exactly the "second thing
     to keep true" its own note warned about, kept alive by the component that needed the narrower one.
     ESLint found it; `tsc` would not have. */

  /* Pass stamps come from the two consecutive-pass counters, which self-clear. Suppressed during a mini-auction, empty in an Operating Round.
     See docs/ai_architecture/ui_shell_layout.md - App.tsx #610 */
  const passedSeats = useMemo(() => {
    if (!gameState) return new Set<number>();
    const acting = actingAddress(gameState, waterfallState);
    const activeIndex = acting ? gameState.player_addresses.indexOf(acting) : -1;
    if (gameState.current_round_type === "StockRound") {
      return passedSeatIndices({
        seatCount: gameState.player_addresses.length,
        activeIndex,
        consecutivePasses: gameState.consecutive_passes,
      });
    }
    if (gameState.current_round_type === "WaterfallAuction") {
      return passedSeatIndices({
        seatCount: gameState.player_addresses.length,
        activeIndex,
        consecutivePasses: waterfallState?.consecutive_waterfall_passes ?? 0,
        enabled: (waterfallState?.mini_auction ?? null) === null,
      });
    }
    return new Set<number>();
  }, [gameState, waterfallState]);

  /** Closing the auction goes through the dispatch path so it reaches the log and turns the round over for the whole table.
   *  See docs/ai_architecture/contract_economy.md - App.tsx #546 */
  const handleProceedToStockRound = useCallback(() => {
    void runGameplayActionRef.current?.(
      "The Waterfall Auction is complete \u2014 Stock Round 1 begins.",
      { OpenStockRound: {} },
      /* `automatic`, which exempts it from the turn gate. Closing the auction
         belongs to nobody's turn -- the rotation it would be checked against
         is the one that just ended. */
      { automatic: true },
    );
  }, []);

  /* ==================================================================
      DESIGN NOTE 885: `privateActionBlocks` GOES WITH ITS ONE READER
     ==================================================================
     IT READ, on one line per #814: `{ "dh-tile": dhPower.layBlockedReason, "dh-token": dhPower.tokenBlockedReason, "csl-tile": cslPower.layBlockedReason }`
     and #725's argument for it stands unchanged: "greyed with a reason rather than hidden. 'Lay the F16
     tile first' teaches the rule; a missing button teaches nothing and a live one that refuses on click
     teaches the wrong thing."

     THE RULE MOVED TO THE MODAL BEFORE THE PANEL DID. #849 gave the D&H's station step
     `enabled: layDone && station === "pending"`, and #848's note says why that greying IS the rule drawn:
     "#548: the token REQUIRES the lay -- there is nothing to put a marker on until the tile is down -- so
     this is not a UI courtesy, it is 1830 refusing an order of operations." So the sentences this memo
     produced had already been superseded by a step that greys itself for the same reason and says so in the
     step text.
     WHAT IT WAS FEEDING was the panel's per-action `blockedActions`, and with the panel gone the lint found
     it in the same pass. `dhPower.ts` still computes all three reasons; nothing reads them here any more.
     Deleted rather than left assigned, because a memo with no reader is how the panel's third surface comes
     back -- and because an unused binding is the one form of dead code the toolchain will actually report. */

  /* Hex-holding private powers route through the shared map flow and are marked spent WHEN THE CLICK LANDS. Share exchanges stay marked-and-logged.
     See docs/ai_architecture/contract_economy.md - App.tsx #444 */
  /* ==================================================================
     DESIGN NOTE 845: THE ARMING IS EXTRACTED, BECAUSE IT NOW HAS TWO CALLERS
     ==================================================================
     `handleUsePrivateAbility` owned this: set the errand, switch to the map, say which hex is lit. #845 adds
     a second way in -- the prompt raised by clicking the ringed hex, and the chip on the action bar that
     opens the same prompt -- and a second copy of four lines that must agree about `kind`, `returnTab` and
     the log entry is how the two paths come to arm different errands.
     THE `kind` MAPPING IS THE PART THAT WOULD HAVE DRIFTED: `dh-token` is a STATION placement and the two
     tile powers are not, which is #548's distinction and is invisible from the call site. */
  const armPrivateHexErrand = useCallback(
    (privateId: number, abilityKey: string, label: string) => {
      const reservation = privateHexFor(privateId);
      if (!reservation) return;
      setHomeStationPlacement({
        kind: abilityKey === "dh-token" ? "private-station" : "private-tile",
        companyId: actingProtocolId,
        q: reservation.q,
        r: reservation.r,
        hexLabel: reservation.hexLabel,
        abilityKey,
        returnTab: activeMainTab,
      });
      setActiveMainTab("map");
      /* ==================================================================
         DESIGN NOTE 873: THE PICKER OPENS ITSELF ON A HEX ALREADY CHOSEN
         ==================================================================
         ASKED: "Forcing them to click Yes on the modal, then click on the hex, feels like it has an
         unnecessary step."
         AND THE SENTENCE BELOW IS THE ADMISSION. It read "click F16 on the Rail Map, the only hex left lit"
         -- a line whose own wording says the destination is already decided. A gesture with one possible
         target is not a choice; the choice is WHICH TILE, and that is what the picker is for.
         ONLY THE TILE ERRANDS. A `private-station` errand does not open a picker at all -- #866 stages its
         token directly, because that placement has one answer too. This is the same reasoning applied to the
         step where a real question survives.
         THE ERRAND STILL ARMS, and that matters: it is what lifts the connectivity gate (#725), what the
         cancel banner reads (#817), and what `errandClickIntent` uses to decide what a click somewhere else
         means. Opening the picker is an addition to the errand, not a replacement for it -- a player who
         dismisses the ring is still armed and can click the hex the old way. */
      if (abilityKey !== "dh-token") {
        /* ==================================================================
           DESIGN NOTE 873a: THE REF HAS TO BE TRUE BEFORE THE EFFECT RUNS
           ==================================================================
           #725 PUT THIS REF IN AN EFFECT ON PURPOSE and said why: "written in an effect rather than at the
           two call sites that set the errand, so arming and disarming cannot get out of step -- the ref
           follows the state by construction." That is still the authority and the effect below still runs.
           WHAT #873 ADDED IS A READER INSIDE THE SAME COMMIT. The board's auto-select effect is a CHILD
           effect, and React runs child effects before parent ones -- so it calls back into
           `handleHexClickQuery` before App's own effect has mirrored the errand. `privatePowerOfferAt` reads
           this ref to decide whether the marked hex should raise the power prompt, and with a stale `null` it
           would raise it: the player presses "Lay Track on F16", the modal closes, and the modal immediately
           reopens instead of the picker. Not an infinite loop, but a control that appears to do nothing.
           SO THE WRITE IS ADDITIVE, NOT A SECOND AUTHORITY. The effect overwrites this on the next commit
           with the same value, and remains the only thing that CLEARS it -- which is the half #725's note is
           really about, since a disarm that forgot to clear is the failure it names. */
        privateTileHexKeyRef.current = `${reservation.q},${reservation.r}`;
        autoSelectTokenRef.current += 1;
        setAutoSelectHex({
          q: reservation.q,
          r: reservation.r,
          token: autoSelectTokenRef.current,
        });
      }
      logInfoRef.current?.(
        "Private Power",
        /* THE SENTENCE FOLLOWS THE BEHAVIOUR. It used to send the player hex-hunting; the picker is now
           already open on that hex, so the log says which hex and what to do in it. */
        `${label} — the tile picker is open on ${reservation.hexLabel}.`,
      );
    },
    [actingProtocolId, activeMainTab],
  );

  /* Design note #846: the chip RAISES THE PROMPT, it does not arm. A chip that armed directly would be a
     third path into the errand and a second thing "use this power" can mean -- one door asking and one door
     acting. It also keeps #263 satisfied: nothing on the bar dispatches. */
  const handleChipPowerOffer = useCallback(
    (abilityKey: string) => {
      /* Design note #871: the M&H is not in the hex-offer list and never will be -- see
         `stockRoundPowerOffers`. Its chip raises the same request all the same, because `activePowerFlow`
         re-checks ownership from game state before deriving a flow; the list lookup below is about which HEX
         powers are live, not about permission. */
      /* Design note #882: A FRESH ASK CLEARS THE LAST ANSWER. Scoping the refusal by ability key stops it
         appearing on somebody else's modal; it cannot stop it appearing on a SECOND attempt at the same
         power, where the refusal may no longer be true -- "sell a share first" is advice a player can act
         on and come straight back. Cleared where the question is raised rather than where the modal closes,
         because closing is not the event that makes the sentence stale. */
      setPrivatePowerRefusal(null);
      if (abilityKey === "mh-exchange") {
        setPrivatePowerRequest("mh-exchange");
        return;
      }
      const offer = privatePowerOffersRef.current.find(
        (entry) => entry.abilityKey === abilityKey,
      );
      if (offer) setPrivatePowerRequest(offer.abilityKey);
    },
    [],
  );

  /* ==================================================================
      DESIGN NOTE 871: ONE DISPATCH, TWO DOORS
     ==================================================================
     EXTRACTED FROM `handleUsePrivateAbility`, unchanged, because the flow modal now reaches the same move.
     #846 established the rule for the hex powers -- "One question, asked one way, whichever door a player
     came through" -- and a second copy of this dispatch would be the thing that rule exists to prevent: two
     paths to `ExchangePrivate` that could come to disagree about the legality check, the log line, or the
     turn gate. */
  /* ==================================================================
      DESIGN NOTE 882: A REFUSAL IS AN ANSWER, SO IT HAS TO REACH THE ASKER
     ==================================================================

     FOUND WHILE CHECKING WHAT THE POWERS PANEL WOULD TAKE WITH IT, not reported: the caller below used to
     read `runPrivateExchange(...)` and then close the modal unconditionally on the next line. So a REFUSED
     exchange dismissed the question as though it had been granted, and the reason went to a panel below the
     fold and to the log. Both M&H refusals are reachable -- `privateExchange.ts` returns one for a player
     already holding 60% of the NYC and one for no certificate being left in the IPO or the bank pool.

     THE RETURN VALUE IS THE FIX, not a second piece of state the caller inspects. `ok` is what the caller
     needs and it is what `resolvePrivateExchange` already computed; handing it back means the modal cannot
     close on a refusal without someone deliberately ignoring the answer.
     #573b's ARGUMENT IS WHY IT GOES IN THE MODAL AND NOT ONLY IN THE LOG: "the interesting refusals ... are
     facts about somewhere else on the board ... this one has to be a sentence the player can act on." That
     note predates the modal by three hundred numbers; the modal is where the player is standing when they
     ask, and it was already the right place the moment #871 built it. */
  const runPrivateExchange = useCallback((privateId: number, actionLabel: string): boolean => {
    const owner = viewerAddressRef.current;
    const outcome = resolvePrivateExchange(gameStateRef.current, privateId, owner ?? "");
    if (!outcome.ok) {
      setPrivatePowerRefusal({ abilityKey: "mh-exchange", reason: outcome.reason });
      logInfoRef.current?.("Private Power", outcome.reason);
      return false;
    }
    setPrivatePowerRefusal(null);
    void runGameplayActionRef.current?.(
      `${actionLabel} — exchanging for a 10% ${outcome.ticker} share.`,
      {
        ExchangePrivate: {
          private_id: outcome.privateId,
          company_id: outcome.companyId,
          player: outcome.player,
          source: outcome.source,
        },
      },
      /* `automatic`: an exchange may be taken between other players' turns (the M&H's own rule), so the turn
         gate would refuse the one moment the power is most useful. Ownership is the gate here and
         `resolvePrivateExchange` has already checked it. */
      { automatic: true },
    );
    /* Deliberately NOT marked used: design note #573a closes the COMPANY instead, which removes the row
       entirely rather than greying it. */
    return true;
  }, []);

  /* Design note #849: the modal's three answers, all landing on machinery that already existed. The flow
     module decides WHICH buttons are live; these decide what each one does, and neither duplicates the
     other's judgement. */
  const handlePowerFlowAct = useCallback(
    (step: "lay" | "station" | "exchange") => {
      const key = activePowerFlow?.abilityKey;
      if (!key) return;
      /* Design note #871: the exchange fires here rather than from the panel button, and it is the SAME
         dispatch `handleUsePrivateAbility` already makes -- `resolvePrivateExchange` for the legality answer,
         `ExchangePrivate` for the message, `automatic: true` because the M&H may be traded between other
         players' turns. What changed is that a confirmation now stands in front of it; the rule underneath is
         untouched, which is what keeps the panel's button and this modal from becoming two accounts of one
         move. */
      if (step === "exchange") {
        /* Design note #882: CLOSED ONLY IF IT FIRED. This read `runPrivateExchange(...); setPrivatePowerRequest(null);`
           -- two statements with no relationship between them, so the question was dismissed whether or not
           it had been answered. On a refusal the modal now stays open with the reason in it, which is also
           what makes the reason worth writing: #573b's "SHOWN AFTER THE ATTEMPT rather than pre-emptively,
           because the attempt costs nothing" only holds if the player is still looking at the thing they
           attempted. */
        if (runPrivateExchange(MH_PRIVATE_ID, "Exchange for NYC share")) {
          setPrivatePowerRequest(null);
        }
        return;
      }
      if (step === "lay") {
        /* The SAME arming the powers panel does (#845), so a lay reached through the modal and a lay reached
           through the panel are one errand. */
        armPrivateHexErrand(
          key === "dh-tile" ? DH_PRIVATE_ID : CSL_PRIVATE_ID,
          key,
          key === "dh-tile" ? "Lay Track (F16)" : "Lay Track (B20)",
        );
        return;
      }
      /* ==================================================================
         DESIGN NOTE 866: THE FREE STATION HAS ONE SLOT, SO IT IS STAGED, NOT HUNTED
         ==================================================================
         REPORTED: "clicking F16 to place the free station token is still calling up the tileselector radial
         menu. Why don't we just have the station automatically placed there with the green checkmark and red
         x above it, since there's no other placement possible in this private power?"
         THIS LINE USED TO READ `armPrivateHexErrand(DH_PRIVATE_ID, "dh-token", ...)`, which lit F16 and sent
         the player to go and click it. That click could only land one way -- F16 is Scranton, a single-city
         hex -- and because it was a click it also reached the tile inspector, which opened a picker over the
         confirmation. #850 guarded that collision with `pendingTokenRef`, but the guard only fires once a
         token is ALREADY staged; on the first click there is nothing staged for it to see.
         SO THE GESTURE IS REMOVED RATHER THAN THE COLLISION PATCHED. Asking the board to resolve the slot
         skips the inspector entirely, because no click happens.
         `armPrivateHexErrand` IS STILL THE FALLBACK, in the shell's auto-stage handler: a hex with two
         cities is a real choice and has to be asked (#858), and this must not become the code that answers
         it. */
      const hex = privateHexFor(DH_PRIVATE_ID);
      if (!hex) return;
      setActiveMainTab("map");
      setAutoStageStation({ q: hex.q, r: hex.r });
    },
    [activePowerFlow, armPrivateHexErrand, runPrivateExchange],
  );

  const handlePowerFlowDecline = useCallback((step: "lay" | "station" | "exchange") => {
    /* ==================================================================
       DESIGN NOTE 871: TWO DECLINES, TWO MEANINGS, AND THEY MUST NOT BE MERGED
       ==================================================================
       The D&H's decline SPENDS the power -- #818's whole argument is that the free placement must be
       forfeited by a named button rather than by a dismissal. The M&H's decline spends nothing: the private
       is still yours, the chip still offers it, and the question can be asked again next turn.
       #845 DREW THIS LINE ALREADY, one power earlier: "Declining THIS one costs nothing: the power is still
       unspent, the hex still rings, the chip still offers it. Two modals, two rules, and the difference is
       whether the question can be asked again." Same distinction, third power.
       SO THE EXCHANGE JUST CLOSES. No `usedPrivateAbilities` entry, no log line -- nothing happened, and a
       log entry for a question answered "no" would be a record of a non-event. */
    if (step === "exchange") {
      setPrivatePowerRequest(null);
      return;
    }
    /* ONLY THE STATION STEP OFFERS A DECLINE among the hex powers, and `privatePowerFlow` renders no decline
       button on the lay -- so this arm exists to make that explicit rather than to be reached. Spending the
       ability is what makes the forfeit a DECISION (#818) rather than a turn that moved on. */
    if (step !== "station") return;
    setDhStationForfeited(true);
    setPrivatePowerRequest(null);
    /* Design note #866: and the standing request goes with it. A forfeited placement that was still being
       resolved every frame would re-stage the token the player just declined. */
    setAutoStageStation(null);
    logInfoRef.current?.(
      "Private Power",
      "Delaware & Hudson — the free placement on F16 was forfeited. The marker returns to the supply.",
    );
  }, []);

  const handlePowerFlowCancel = useCallback(() => {
    /* Design note #849: the X, and it can only be reached while `cancellable`. Nothing has been spent, so
       nothing is marked used -- #573's rule that "a refusal must leave the power alone". */
    setPrivatePowerRequest(null);
    setHomeStationPlacement(null);
  }, []);

  /* ==================================================================
      DESIGN NOTE 885: `handleUsePrivateAbility` IS GONE, AND SO IS ITS PANEL
     ==================================================================

     ASKED: "Given how nice the modal is (it's big and easily readable) versus how cramped and hard to read
     the Private Powers subpanel is, I'm wondering if we should scrap the Private Powers subpanel
     completely... DH and CSL both have clickable rail map hexes that the rainbow outline is likely to get
     players' attention, and the 'Exchange MH for NYC' in the Action Bar is probably adequate for the only
     other player-interactive PC."

     THE PANEL WAS THE SECOND DOOR EVERYWHERE, AND NEVER THE BETTER ONE. Every row it rendered is offered
     somewhere a player is already looking: the D&H and C&SL by a rainbow-ringed hex and a bar chip built
     from ONE list (#845/#846, so the ring and the chip cannot disagree), the M&H by its own chip (#871). The
     panel added a third surface for each, below the fold, and #881 found what a third surface costs -- its
     button was the one door in the whole flow that dispatched without asking.

     WHAT IT UNIQUELY HELD, and where each piece went:
       #573b's REFUSAL SENTENCE -- into the flow modal (#882), which is where the player is standing when
         they ask. It was rendering below the fold while the modal closed on top of it.
       #576's C&A PARAGRAPH -- nowhere, because it was already somewhere. That note kept a button-less row so
         "a C&A owner who finds no row at all would reasonably conclude the company has no power", and #843
         then built the Rules Reference private table, whose C&A line says the same two things this row did
         ("Its auction buyer was handed a 10% PRR share on purchase. Nothing further to trigger -- the company
         stays open") with the revenue in a column beside it. #576's worry was about an ABSENCE being
         misread; with the panel gone there is no absence to misread.
       #1's SANDBOX GATE -- onto the offer list (#883). It was the load-bearing piece nobody had noticed the
         panel was carrying: `ExchangePrivate` is not in `GAMEPLAY_MESSAGE_KEYS`, and `if (!sandbox) return
         null` was the only thing stopping the chip offering it on chain.

     AND `PRIVATE_ABILITIES` GOES WITH IT, which is the part that deserved an argument rather than a
     deletion. That table declared four rules: each power's SCOPE (#441 -- the exchanges belong to a player,
     the lays to a corporation), its ROUND, its STEP (#782/#807 -- on the ACTION, because the D&H spans two),
     and `hideOutOfRound`. All four have living statements elsewhere, and had before this change:
       SCOPE     `stockRoundPowerOffers` tests `mh.owner !== viewerAddress`; `privatePowerOfferList` tests
                 `ownsPrivate(gameState, id, actingProtocolId)`. Those ARE the two scopes, applied.
       ROUND     the same two lists, one gated on `"StockRound"` and one reachable only with an
                 `actingProtocolId`.
       STEP      `ContextualActionBar`'s `case "Track"`, which is where a step gate can actually be read.
       hideOutOfRound  redundant since #470 made the round match unconditional; its own note says so.
     SO IT IS DELETED RATHER THAN REHOMED. A rules table with no reader is not a safeguard -- it is a fifth
     statement of four rules, kept alive by its tests, free to drift from the four that run. That is the
     failure this project keeps finding from the other end (#815's three chip rows, #829's two acronym
     vocabularies), and preserving the table "just in case" would be choosing it deliberately.
     WHAT THE TABLE SAID IS ABOVE, in words, which is what a design note is for. If a third hex power ever
     arrives, the place that needs a new entry is `privatePowerOffers`, not a table beside it.

     AND TWO RECORDS COME WITH IT, because a record kept in a file that gets deleted is not a record. Both
     are kept UNWRAPPED per #814 -- a comment that wraps mid-sentence preserves the words and destroys the
     string, and a harness asserting the record survived searches for the string.

     #871 REMOVED THIS FROM THE M&H's PANEL ROW, on the report "for some reason it has a multi-line/sentence
     explanation of this rule":
     "Mohawk & Hudson - the owner may exchange this private for a 10% share of the New York Central (NYC). The exchange closes this private permanently."
     Its replacement was the one-line "Trade in for a 10% NYC share. Taking it closes the company.", which is
     now itself gone: the rule is asked at the decision, in `privatePowerFlow.ts`'s exchange question.

     #576 KEPT THE C&A's ROW WITHOUT A BUTTON, and this is what it said:
     "Camden & Amboy — its purchaser received a 10% share of the Pennsylvania Railroad (PRR) free, at the moment they won it. Nothing further to trigger: the company stays open and keeps paying its revenue."
     The Rules Reference table says both halves and prints the $25 in a column, which is better than "keeps
     paying its revenue" -- a figure where there was a phrase. */

  /* round is an optional override; the default ref is right for every caller except a round transition, which announces a round the ref does not know yet.
     See docs/ai_architecture/state_machine.md - App.tsx #659 */
  /* Design note #1042: `tone` is optional and last, so the several dozen existing callers are untouched --
     only the variant's flavour line passes one. */
  const logInfo = useCallback((
    label: string,
    detail: string,
    round?: string | null,
    tone?: "bonus" | "malus",
    /** Design note #1079: the index in `label` where the flavour sentence begins. See `feed.ts` #1079 for
     *  why this is stamped here rather than found by the renderer, and why it is not `tone` wearing a hat. */
    flavourFrom?: number,
  ) => {
    const id = nextLogEntryId++;
    /* Design note #668: the replay clock, not `Date.now()`. Every derived line
       in the app goes through here -- Float, Round, Auto-Skip, Private Revenue
       -- and during a rebuild each one is a consequence of the action being
       replayed, so it belongs beside that action rather than at the instant the
       rebuild happened to run. */
    const timestampMs = stampLogTime();
    const timestamp = new Date(timestampMs).toLocaleTimeString();
    setActionLog((log) => [
      {
        id,
        // Design note #668: the counter is already monotonic; naming it `seq`
        // at the point of use is what lets the feed sort on it.
        seq: id,
        label,
        status: "info",
        detail,
        timestamp,
        timestampMs,
        round: (round ?? roundLabelRef.current) ?? undefined,
        ...(tone ? { tone } : {}),
        /* Design note #1079: `> 0` rather than truthiness -- an index of 0 would mean a line that is ALL
           flavour, which no composer produces and which would italicise the corporation's own name. */
        ...(flavourFrom !== undefined && flavourFrom > 0 ? { flavourFrom } : {}),
      },
      ...log,
    ]);
  }, []);

  /* `logInfo` is defined below the handler that uses it, so the handler
     reads it through a ref rather than forcing a reorder of a 6000-line
     file for one call. */
  const logInfoRef = useRef<((label: string, detail: string) => void) | null>(null);
  useEffect(() => {
    logInfoRef.current = logInfo;
  }, [logInfo]);

  /* A ref, not a dependency: runGameplayAction is in the dependency array of the two effects that dispatch.
     See docs/ai_architecture/session_keys_wallet.md - App.tsx #546 */

  /* `payPrivateRevenue` and its ref are GONE -- design note #685 moved the payout into `settleRoundTransitions`,
     where the round machine already lives and where a replay reproduces it.
     Deleted rather than left unused: a function that moves money, still exported into a ref, is not a dead
     branch somebody might tidy later -- it is a second way to pay the privates, waiting for a caller.
     WHAT SURVIVES IS THE LOG LINE, re-derived from the state diff in the sandbox dispatch below, the same way
     `describeFloat` reports a float nobody explicitly announced.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #685 */

  const runGameplayAction = useCallback(
    async (
      fallbackLabel: string,
      /* Design note #530: the sandbox log carries a setup event as well as
         contract messages, and both are single-key objects. Widened here so
         the SAME pipeline handles both -- the alternative was a second
         dispatch path for one message, which is how the two would drift. */
      msg: SandboxLogMsg,
      /* automatic marks the two effects that dispatch on the player's behalf. #492a resets the per-turn revenue sum; #522 isRemoteReplay marks a log-driven action; #549 names the seat it acts for.
         See docs/ai_architecture/state_machine.md - App.tsx #439 */
      options?: {
        automatic?: boolean;
        /** Design note #668: the game dispatched this, not the player -- the
         *  auto-skip and the forced withhold, and nothing else.
         *
         *  DELIBERATELY NOT `automatic`. That flag means "do not apply the turn
         *  gate", and a home station placement, a B&O par and a private exchange
         *  all set it while being decisions a player made and expects to be able
         *  to take back. Folding the two together would make Undo step silently
         *  past a real move, which is the bug #475 was fixed to prevent. */
        derived?: boolean;
        /** Design note #1070: why the shell skipped this step, for the sentence that reports it. `null` when
         *  a player pressed Skip themselves -- there is no reason to give beyond the press. */
        skipReason?: string | null;
        /** ==================================================================
         *   DESIGN NOTE 1077: THIS DISPATCH GETS NO LINE OF ITS OWN
         *  ==================================================================
         *
         * SET ONLY BY THE MULTI-TRAIN BUY, where one button press is several messages and a caller writes ONE
         * summary covering all of them. Without it the log shows the summary and every message it summarises.
         *
         * DELIBERATELY NOT `derived`. That flag means "the game dispatched this rather than the player"
         * (#668), which is false here -- the player pressed Buy -- and it also governs Undo's reach, so
         * borrowing it to quieten a line would make Undo step past a real purchase.
         * THE TOAST IS UNAFFECTED, and that is the point of a separate flag: the depot count is a glance at a
         * number going down, and a batch of two should still produce it. */
        silentInLog?: boolean;
        /** Design note #701: an answer the game is WAITING FOR from a player who is not on turn.
         *
         *  The turn gate below asks "is it your turn", which is the right question for a move and the wrong
         *  one for a consent answer: the whole point of a two-party trade is that the counterparty is not the
         *  one operating. Without this, the seller president clicks Accept and gets "It is not your turn" --
         *  and #662's private-company flow has the same hole, reached the same way, which is why both are
         *  marked here rather than only the train.
         *
         *  DELIBERATELY NOT `automatic`. That flag also re-attributes the log entry to `actingAddressRef`,
         *  and a consent answer must be recorded as the COUNTERPARTY's -- they are the author, and the log is
         *  the only place the table can see who agreed to what.
         *
         *  The authorisation this replaces is not weaker: the prompt renders only for the wallet named on the
         *  offer, and the drain refuses an answer that does not match the offer standing in shared state. A
         *  turn gate would add nothing to either. */
        offTurn?: boolean;
        isRemoteReplay?: boolean;
        /** Design note #643: the log entry's own `createdAt`, so a replayed
         *  action is timestamped when it HAPPENED rather than when it was
         *  replayed. Omitted by every live dispatch. */
        at?: number;
        actor?: string | null;
      },
    ) => {
      /* The label is derived here, once, from the state before the action applies - call sites used to pass contract variant names.
         See docs/ai_architecture/state_machine.md - App.tsx #262 */
      const describeContext = {
        gameState,
        mapGrid,
        era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
        labelForAddress: (address: string) =>
          sandboxPlayerLabel(address) ?? truncateAddress(address),
        marketPrices: Object.fromEntries(
          (marketGrid?.positions ?? []).map((entry) => [entry.company_id, Number(entry.price)]),
        ),
        /* `projectPrice` REMOVED with design note #775: the dividend sentence no longer projects a move,
           because `Market Move` already reports the one the market atom made. */
        /* Design note #478: the step the button was pressed FROM. Read from
           the state variable rather than a ref because the cursor only ever
           moves as a result of a dispatch, so it cannot be mid-flight the
           way the sandbox atoms can. */
        orSubPhase,
      };
      /* This guard NARROWS instead of returning: returning here dropped every SetupGame before the sandbox branch below could deal the game. #546: isSandboxOnlyMsg covers both chain-unknown events.
         See docs/ai_architecture/firebase_middleware.md - App.tsx #539 */
      const chainMsg: GameplayExecuteMsg | null = isSandboxOnlyMsg(msg) ? null : msg;

      let label =
        (chainMsg ? describeGameplayAction(chainMsg, describeContext) : null) ?? fallbackLabel;

      const id = nextLogEntryId++;
      /* A replayed action keeps its own clock: options.at is the log entry's createdAt, so a rebuild does not stamp the whole history with one instant.
         #668: through stampLogTime, which also holds the stamp monotonic -- `at` is legitimately absent on an entry Firestore has not resolved yet.
         See docs/ai_architecture/state_machine.md - App.tsx #643 */
      const timestampMs = stampLogTime(options?.at);
      const timestamp = new Date(timestampMs).toLocaleTimeString();

      // Read-only gate for dispatch path (1); the tile popup is path (2) and is gated by not being mounted. Refusals are logged, not silently dropped. Sandbox routes to the local reducer and never signs.
      // See docs/ai_architecture/session_keys_wallet.md - App.tsx #23
      if (sandbox) {
        /* In a room a local click APPENDS to the log and stops; the listener replays it back through this function. One order of operations for every client. #536: the turn gate lives here, with automatic and replay exempt.
           See docs/ai_architecture/firebase_middleware.md - App.tsx #522 */
        if (
          options?.isRemoteReplay !== true &&
          options?.automatic !== true &&
          // Design note #701: a consent answer is owed by the player who is NOT on turn.
          options?.offTurn !== true &&
          !isMyTurnRef.current
        ) {
          setSandboxRoomError("It is not your turn.");
          return;
        }

        /* The render gate guarantees a room, but the ref is typed nullable and narrowing here is cheaper than asserting.
           See docs/ai_architecture/firebase_middleware.md - App.tsx #578 */
        const roomCode = sandboxRoomRef.current;
        if (roomCode && options?.isRemoteReplay !== true) {
          /* actor is the SEAT the action acts for, not the browser that sent it - a nickname could never match player_addresses.
             See docs/ai_architecture/firebase_middleware.md - App.tsx #549 */
          const authorId = localPlayerId();
          /* ==================================================================
              DESIGN NOTE 916: A BATCH OF ACTIONS NEEDS A BATCH OF INDICES
             ==================================================================
             REPORTED as a log bug: "when a corporation runs multiple trains in a single turn, the Activity
             Log is only printing the run for one train and dropping the rest."
             IT IS NOT A LOGGING BUG. `appliedIndexRef.current` is advanced by the SNAPSHOT handler, and
             `appendSandboxAction` awaits only the write -- so a loop that dispatches three routes before the
             first snapshot returns appends all three AT THE SAME INDEX. The log then carries three entries
             claiming one position.
             AND THE CONSEQUENCES REACH FURTHER THAN THE FEED. `index` is what `orderBy` sorts on, what
             `effectiveActions` matches a `RevertTo` against (#892's seventeen reverts), and what the next
             append is computed from. Three actions at one index is an ambiguous ordering in the one structure
             this whole architecture treats as the source of truth -- "the log is the game" (#522).
             OPTIMISTIC, AND THE SNAPSHOT STILL CORRECTS IT. This advances the ref on a successful write so
             the next dispatch in the same tick lands one further on; when the snapshot arrives it recomputes
             from the log itself, which stays the authority. A failed write does not advance, so a refused
             append leaves the position free for a retry. */
          const appendAt = appliedIndexRef.current;
          const allocated = await appendSandboxAction(
            roomCode,
            appendAt,
            options?.automatic === true
              ? actingAddressRef.current ?? authorId
              : authorId,
            msg,
            /* Design note #668: recorded ON the entry. The client that
               dispatched it is the only one that knows, and every other client
               has to be able to answer "was this a decision?" from the log
               alone -- Undo lands on the same action for everybody or the
               table disagrees about what was taken back. */
            options?.derived === true,
          ).catch(() => null);
          /* ==================================================================
             DESIGN NOTE 1026: `null` IS THE FAILURE, AND `0` IS NOT
             ==================================================================
             This read `if (!ok)` against a boolean. `appendSandboxAction` now returns the index it ALLOCATED,
             and index 0 is a real allocation -- the `SetupGame` event that deals the game. A truthiness test
             would have reported the very first action of every room as a failed write, which is a fault the
             fix introduced rather than one it found. Compared against `null` explicitly. */
          if (allocated === null) {
            setSandboxRoomError("Could not reach the room — that action was not sent.");
          } else if (appliedIndexRef.current === appendAt) {
            /* Design note #916: only when nothing else has moved it. A snapshot may already have landed
               during the await and advanced it past this write; overwriting that with `appendAt + 1` would
               walk the cursor BACKWARDS and re-apply actions the client had already taken in. */
            appliedIndexRef.current = appendAt + 1;
          }
          /* ==================================================================
           *  DESIGN NOTE 794: THE RECEIPT MOVED TO WHERE THE TRUTH IS
           * ==================================================================
           *
           * REPORTED, three runs in a row: "the Dividends and the Activity Log showed the correct amounts, but
           * the toast notification said B&O paid $5 per share ... I'm not sure why you don't have the toast
           * notifications pulling from the same source as the Activity Log."
           *
           * THAT SENTENCE IS THE DIAGNOSIS. The toast used to fire HERE, from the label derived at DISPATCH
           * time; the Activity Log's line is rebuilt in the drain from the state the action actually applied
           * to. Same function, same message, two snapshots -- and #775 had already established that the
           * difference between two snapshots is exactly where this project's narration bugs live.
           *
           * THE FIGURES CONFIRM IT. B&O ran $100 and the toast said $50; $150, still $50; $190, $70. PRR ran
           * $30 correctly, then $70 and the toast said $30. Every wrong figure is a PARTIAL run -- one train's
           * worth. A turn dispatches one `RunManualRoute` per train, and at the instant the dividend button is
           * pressed this browser's React state has only caught up with some of them. The drain has all of
           * them, which is why the log was right every time.
           *
           * WHAT #697 WANTED AND WHAT IT COST. That note put the receipt at the moment of SENDING because
           * "they pressed a button and want to know it registered", which is the right instinct -- and it
           * bought immediacy with a figure that could be wrong. A receipt quoting a number the player did not
           * receive is worse than one arriving a round-trip later; the whole point of a receipt is that it can
           * be trusted. So the toast is raised in the drain now, from the SAME string the log entry gets.
           *
           * STILL ONLY THE PLAYER WHO ACTED, which is what #697's placement was also buying. The drain runs on
           * every client, so the actor test does that job instead -- and it is the same comparison #786 makes
           * in reverse for the payout notice, so the two can never both fire. */
          return;
        }

        /* Setup is handled first and returns: it is not a move. Idempotent by position, and a roster 1830 cannot deal leaves state untouched.
           See docs/ai_architecture/firebase_middleware.md - App.tsx #531 */
        if (isRevertToMsg(msg)) {
          /* A revert is an instruction about the log; effectiveActions has already honoured it, so applying it as a move would invent a rule.
             See docs/ai_architecture/state_machine.md - App.tsx #591 */
          return;
        }

        if (isExchangePrivateMsg(msg)) {
          /* Design note #573: the resolved grant, applied everywhere. The
             legality question was answered once, by the acting client,
             before this was ever appended -- see `ExchangePrivateMsg`. */
          const base = sandboxStateRef.current;
          if (!base) return;
          const { private_id, company_id, player, source, keep_open } = msg.ExchangePrivate;
          const priv = base.private_companies.find((e) => e.private_id === private_id);
          const exchanged = applyPrivateExchange(base, {
            ok: true,
            privateId: private_id,
            companyId: company_id,
            ticker:
              base.public_companies.find((c) => c.company_id === company_id)?.ticker ?? "",
            player,
            source,
            keepOpen: keep_open === true, // design note #576
          });
          if (exchanged === base) return;
          sandboxStateRef.current = exchanged;
          setSandboxState(exchanged);
          const ticker =
            base.public_companies.find((c) => c.company_id === company_id)?.ticker ??
            `#${company_id}`;
          logInfo(
            "Private Power",
            keep_open
              ? `${sandboxPlayerLabel(player) ?? truncateAddress(player)} receives a free 10% ` +
                `share of ${ticker} with the ${priv?.name ?? "private company"}, which stays open.`
              : `${sandboxPlayerLabel(player) ?? truncateAddress(player)} exchanged the ` +
                `${priv?.name ?? "private company"} for a 10% share of ${ticker}. ` +
                `The private company closes.`,
          );
          return;
        }

        if (isSetBoParMsg(msg)) {
          /* Design note #550: applied on every client, from the log. The
             winner travels IN the message -- see `SetBoParMsg.player` for
             why it is not inferred from the turn cursor. */
          const { player, par_value: parValue } = msg.SetBoPar;
          const base = sandboxStateRef.current;
          if (!base) return;
          /* Design note #904b: A REFUSAL THAT SAYS SO. This was a bare `if (granted === base) return;` and it
             swallowed the whole event -- a player who had just paid for the B&O private got no certificate, no
             par and no line anywhere. Asked before the grant so the sentence names the actual cause. */
          const refusal = boPresidencyRefusal(base, BO_TICKER);
          if (refusal !== null) {
            logInfo("B&O Presidency", refusal);
            setBoParPrompt(null);
            return;
          }
          const granted = grantBOPresidency(base, player, parValue, BO_TICKER);
          if (granted === base) return;
          sandboxStateRef.current = granted;
          setSandboxState(granted);

          /* A par set through the prompt writes the market mark too, so the Par Tray and the matrix cannot disagree (#468).
             See docs/ai_architecture/stock_market.md - App.tsx #461 */
          const par = Number(parValue);
          const bo = granted.public_companies.find((c) => c.ticker === BO_TICKER);
          if (bo && Number.isFinite(par) && par > 0) {
            const marked = placeParMark(sandboxMarketRef.current, bo.company_id, par, parBoxCellFor);
            if (marked !== sandboxMarketRef.current) {
              sandboxMarketRef.current = marked;
              setSandboxMarket(marked);
            }
          }
          /* Design note #565: the prompt closes wherever the answer lands,
             not only on the browser that gave it. `handleConfirmBoPar`
             cleared it locally, which was every client that had raised one
             minus the ones that had not yet seen the answer. */
          setBoParPrompt(null);
          logInfo(
            "B&O Presidency",
            `${sandboxPlayerLabel(player) ?? truncateAddress(player)} receives the B&O President's Certificate and pars it at $${parValue}.`,
          );
          return;
        }

        /* Private offers are written in the DRAIN so the seller's client sees them and the answer clears both screens.
           See docs/ai_architecture/firebase_middleware.md - App.tsx #662 */
        if (isProposePrivatePurchaseMsg(msg)) {
          const base = sandboxStateRef.current;
          if (!base) return;
          const { private_id, private_name, owner, buyer_protocol_id, buyer_ticker, price } =
            msg.ProposePrivatePurchase;
          const next: GameStateResponse = {
            ...base,
            private_purchase_offer: {
              private_id,
              private_name,
              owner,
              buyer_protocol_id,
              buyer_ticker,
              price,
            },
          };
          sandboxStateRef.current = next;
          setSandboxState(next);
          logInfo(
            "Private Offer",
            `${buyer_ticker} offers $${price} for ${private_name}. ${
              sandboxPlayerLabel(owner) ?? truncateAddress(owner)
            } must answer.`,
          );
          return;
        }

        if (isAnswerPrivatePurchaseMsg(msg)) {
          const base = sandboxStateRef.current;
          if (!base) return;
          const { private_id, accept } = msg.AnswerPrivatePurchase;
          const offer = base.private_purchase_offer ?? null;
          /* Answering an offer that is no longer there is not an error: the first answer settles it, the second finds nothing.
             See docs/ai_architecture/firebase_middleware.md - App.tsx #662 */
          if (!offer || offer.private_id !== private_id) return;
          const cleared: GameStateResponse = { ...base, private_purchase_offer: null };
          sandboxStateRef.current = cleared;
          setSandboxState(cleared);
          const ownerLabel = sandboxPlayerLabel(offer.owner) ?? truncateAddress(offer.owner);
          if (!accept) {
            logInfo(
              "Private Offer",
              `${ownerLabel} declined $${offer.price} for ${offer.private_name}.`,
            );
            return;
          }
          /* An accepted offer goes through the ordinary BuyPrivateCompany, so consent and legality use the same code as every purchase.
             See docs/ai_architecture/contract_economy.md - App.tsx #662 */
          void runGameplayActionRef.current?.(
            `BuyPrivateCompany: ${offer.private_name} @ $${offer.price}`,
            {
              BuyPrivateCompany: {
                game_id: gameId,
                protocol_id: offer.buyer_protocol_id,
                private_id: offer.private_id,
                price: String(offer.price),
              },
            },
          );
          return;
        }

        /* Design note #701: THE TRAIN OFFER, WRITTEN IN THE DRAIN so the SELLER'S client sees it. This was
           `setSandboxTrainProposal`, React state in this file, which is why the prompt only ever appeared on
           the buyer's screen -- the identical fault #662 fixed for privates, on the other half of the same
           feature. */
        if (isProposeTrainPurchaseMsg(msg)) {
          const base = sandboxStateRef.current;
          if (!base) return;
          const {
            seller_protocol_id,
            seller_ticker,
            seller_president,
            buyer_protocol_id,
            buyer_ticker,
            model_type,
            price,
          } = msg.ProposeTrainPurchase;
          const next: GameStateResponse = {
            ...base,
            train_purchase_offer: {
              seller_protocol_id,
              seller_ticker,
              seller_president,
              buyer_protocol_id,
              buyer_ticker,
              model_type,
              price,
            },
          };
          sandboxStateRef.current = next;
          setSandboxState(next);
          logInfo(
            "Train Offer",
            `${buyer_ticker} offers $${price} for one of ${seller_ticker}'s ${model_type}-trains. ${
              sandboxPlayerLabel(seller_president ?? "") ??
              truncateAddress(seller_president ?? "")
            } must answer.`,
          );
          return;
        }

        if (isAnswerTrainPurchaseMsg(msg)) {
          const base = sandboxStateRef.current;
          if (!base) return;
          const { seller_protocol_id, accept } = msg.AnswerTrainPurchase;
          const offer = base.train_purchase_offer ?? null;
          /* Answering an offer that is no longer there is not an error: the first answer settles it, the
             second finds nothing. Same guard as #662's, same reason. */
          if (!offer || offer.seller_protocol_id !== seller_protocol_id) return;
          const cleared: GameStateResponse = { ...base, train_purchase_offer: null };
          sandboxStateRef.current = cleared;
          setSandboxState(cleared);
          const sellerLabel =
            sandboxPlayerLabel(offer.seller_president ?? "") ??
            truncateAddress(offer.seller_president ?? "");
          if (!accept) {
            logInfo(
              "Train Offer",
              `${sellerLabel} declined $${offer.price} for ${offer.seller_ticker}'s ${offer.model_type}-train.`,
            );
            return;
          }
          /* An accepted offer goes through the ordinary BuyTrainFromCorporation, so the trade and its legality
             use the same code as every other purchase -- #662's rule, and the reason the accept path here is
             a dispatch rather than a second implementation of the transfer. */
          void runGameplayActionRef.current?.(
            `BuyTrainFromCorporation: ${offer.model_type}-train @ $${offer.price}`,
            {
              BuyTrainFromCorporation: {
                game_id: gameId,
                buyer_protocol_id: offer.buyer_protocol_id,
                seller_protocol_id: offer.seller_protocol_id,
                model_type: offer.model_type,
                price: offer.price,
              },
            },
          );
          return;
        }

        if (isPlaceHomeStationMsg(msg)) {
          // Design note #550: a placement is a choice about a shared board.
          const {
            company_id: companyId,
            q,
            r,
            kind,
            city_index: cityIndex,
            hex_label: hexLabel,
          } = msg.PlaceHomeStation;
          const base = sandboxStateRef.current;
          if (!base) return;
          const placed = placeHomeStationToken(base, companyId, q, r, cityIndex, homeHexToAxial);
          if (placed === base) return;
          sandboxStateRef.current = placed;
          setSandboxState(placed);
          const ticker =
            base.public_companies.find((e) => e.company_id === companyId)?.ticker ??
            `#${companyId}`;
          logInfo(
            "Station Token",
            kind === "home"
              ? `${ticker} places its home station token on ${hexLabel}.`
              : `${ticker} places a free station token on ${hexLabel} using the Delaware & Hudson.`,
          );
          return;
        }

        if (isOpenStockRoundMsg(msg)) {
          /* Design note #546: the round turns over for everyone, because
             every client replays this. Idempotent -- a second copy sets the
             same value, so the guard below is an optimisation and not a
             correctness requirement. */
          const base = sandboxStateRef.current;
          if (!base || base.current_round_type !== "WaterfallAuction") return;
          /* ==================================================================
              DESIGN NOTE 905: THE ONE EVENT THAT CLOSES THE AUCTION, WHENEVER IT RAN
             ==================================================================
             This handler was written for the genesis auction and is now reached twice over: at the top of a
             standard game, and mid-game under the delayed variant. Reusing it rather than writing a second
             closer is the point -- `private_auction_complete` is what unlocks the B&O (#904a), and two events
             that both had to remember to set it is precisely how one of them comes not to.
             THE ROUND IT OPENS IS DERIVED, not assumed to be Stock Round 1. `macro_round_number` already says
             which one this is, so the sentence and the state agree without a second counter. */
          const openingRound = base.macro_round_number ?? 1;
          const opened: GameStateResponse = {
            ...base,
            current_round_type: "StockRound",
            private_auction_complete: true,
            /* ==================================================================
                DESIGN NOTE 909: THE SECOND OPENING, WHICH WIPED NOTHING
               ==================================================================
               This handler set the round type and cleared `consecutive_passes` and nothing else -- correct
               for the genesis auction, where there is no previous Stock Round to have left anything behind,
               and WRONG the moment #905 gave it a second job. Under the delayed-auction variant it opens
               Stock Round 3 mid-game, so a player who sold PRR in Stock Round 2 would have carried the
               sell-then-buy lock (#744) into it and been refused the buy-back for the rest of the game.
               `openingStockRoundReset` is the one place that names what a Stock Round opening invalidates.
               It also seats the Priority Deal holder, which is the ruling for this auction: seeded by
               whoever holds it going in. In a standard game `priority_deal_index` is 0 at genesis, so that
               is the seat it always was. */
            ...openingStockRoundReset(base),
          };
          sandboxStateRef.current = opened;
          setSandboxState(opened);
          const closed = sandboxWaterfallRef.current
            ? { ...sandboxWaterfallRef.current, waterfall_auction_active: false }
            : null;
          sandboxWaterfallRef.current = closed;
          setSandboxWaterfall(closed);
          logInfo(
            "Round",
            openingRound > 1
              ? `The delayed private auction is complete \u2014 Stock Round ${openingRound} begins, and the B&O is now open for trading.`
              : "The Waterfall Auction is complete \u2014 Stock Round 1 begins.",
          );
          return;
        }

        if (isCloseRoomMsg(msg)) {
          /* ==================================================================
              DESIGN NOTE 899: THE FIRST CLOSE WINS AND THE REST ARE NOT ERRORS
             ==================================================================
             Every client runs its own fifteen-minute countdown and any player may press the button, so this
             handler is reached several times for one closure -- by design, per #546's rule that an elected
             owner strands the table when they walk away. The guards below are what make that safe, and each
             one refuses SILENTLY: a player whose timer lost the race has done nothing wrong, and logging it
             would put four identical scare lines in the Activity Log of a finished game.
             THE PAYOUT FIRES ON THE TRANSITION, never on the state. `room_closed` already true means this is
             a duplicate or a replay, and either way the money has been dealt with -- see `closeRoomPayout.ts`
             #899 for why the client-side guard is a courtesy and the contract still owes a real one. */
          const base = sandboxStateRef.current;
          if (!base) return;
          if (base.room_closed === true) return;
          if (base.current_round_type !== "GameEnd") return;

          const closed: GameStateResponse = { ...base, room_closed: true };
          sandboxStateRef.current = closed;
          setSandboxState(closed);

          const settlement = settleRoomPayout({
            roomCode: sandboxRoomCode,
            standings: finalStandingsRef.current,
            totalAnte: PLACEHOLDER_TOTAL_ANTE,
            trigger: closeRoomTriggerRef.current,
          });
          logInfo(
            "Room",
            settlement.dispatched
              ? "The room is closed. The payout distribution has been dispatched for on-chain settlement."
              : `The room is closed. No payout was dispatched — ${settlement.reason}`,
          );
          return;
        }

        if (isSetupGameMsg(msg)) {
          const dealt = dealSandboxGame({
            players: msg.SetupGame.players,
            /* Design note #902: FROM THE MESSAGE, not from local state. The host chose the variants and every
               client deals from this action -- reading a local selection here would give the host's browser
               one game and everybody else's another, which is #550's rule stated for house rules. */
            variants: msg.SetupGame.variants,
          });
          if (!dealt) {
            logInfo("Room", "That roster cannot be dealt — Project 18XX seats two to six players.");
            return;
          }
          /* Setup must not be skippable: fall back through the ref, the rendered state, then a fresh fixture, so there is no path where it does not run.
             See docs/ai_architecture/firebase_middleware.md - App.tsx #537 */
          const base = sandboxStateRef.current;
          if (!base) return;
          /* A room starts UNOWNED - the fixture's mock presidents and private owners are cut, because no canAct would ever match them. The board survives.
             See docs/ai_architecture/firebase_middleware.md - App.tsx #535 */
          const seated: GameStateResponse = {
            ...base,
            player_addresses: dealt.playerAddresses,
            player_cash: dealt.playerCash,
            virtual_bank_vgp: String(dealt.bankRemaining),
            /* Design note #902: what THIS game started with, not the printed constant -- a short game's
               ledger has to read $4,500 or the bank gauge measures against a pool that was never there. */
            virtual_bank_start: String(dealt.bankStart),
            /* Design note #902: recorded on state so the reducer can read it -- Unpredictable Revenue asks it
               on every run, and a replay must find the same answer the live game did. */
            variants: dealt.variants,
            max_players: dealt.playerAddresses.length,
            active_player_index: 0,
            priority_deal_index: 0,
            public_companies: base.public_companies.map((company) => ({
              ...company,
              president: null,
              player_holdings: [],
              is_floated: false,
            })),
            private_companies: base.private_companies.map((entry) => ({
              ...entry,
              owner: null,
              owner_protocol_id: null,
            })),
          };
          /* Design note #535: the room's names, for every label surface. A
             ref rather than state because `sandboxPlayerLabel` is a
             `useCallback` many components close over -- rebuilding it on
             every setup would churn them for a value that changes once. */
          setRoomNicknames(Object.fromEntries(
            msg.SetupGame.players.map((player) => [player.id, player.nickname || "Player"]),
          ));
          /* Design note #569: and their colours, from the same payload and in
             the same breath. Two registries fed by one event, because a seat
             whose name arrived and whose colour did not would be painted a
             default that some other seat may also have chosen. */
          setRoomColors(
            Object.fromEntries(
              msg.SetupGame.players
                .filter((player) => typeof player.color === "string" && player.color)
                .map((player) => [player.id, player.color as string]),
            ),
          );
          /* ==================================================================
              DESIGN NOTE 905: A DELAYED-AUCTION GAME OPENS ON STOCK ROUND 1
             ==================================================================
             RULED: "Straight to SR1; no privates exist yet ... corporations must float on share capital alone
             for two Stock Rounds", and that balance shift is intended rather than tolerated.
             THE AUCTION IS NOT SKIPPED, IT IS MOVED, so `private_auction_complete` stays FALSE here -- which is
             what keeps the B&O locked (#904a) and what tells `settleRoundTransitions` there is still an
             auction owing before Stock Round 3. Marking it complete would open on SR1 and never run it. */
          const opensOnStockRound = dealt.variants.delayedAuction;
          const dealtState: GameStateResponse = opensOnStockRound
            ? {
                ...seated,
                current_round_type: "StockRound",
                private_auction_complete: false,
                macro_round_number: 1,
              }
            : seated;
          sandboxStateRef.current = dealtState;
          setSandboxState(dealtState);

          /* The auction atom is dealt in the same handler from the same roster, read from the ref with no fallback.
             See docs/ai_architecture/firebase_middleware.md - App.tsx #542 */
          const dealtWaterfall = waterfallForRoster(
            sandboxWaterfallRef.current,
            dealt.playerAddresses,
          );
          /* Design note #905: DEALT NOW, RUN LATER. The auction's own atom is built from this roster at setup
             whichever variant is playing -- it is the same lots in the same order -- and only `active` decides
             whether it is happening. Deferring the deal as well would mean the roster it was built from could
             have changed by Stock Round 3, which is a different auction from the one the table agreed to. */
          const armedWaterfall =
            dealtWaterfall && opensOnStockRound
              ? { ...dealtWaterfall, waterfall_auction_active: false }
              : dealtWaterfall;
          sandboxWaterfallRef.current = armedWaterfall;
          setSandboxWaterfall(armedWaterfall);
          logInfo(
            "Room",
            `Game dealt for ${dealt.playerAddresses.length} players — $${dealt.startingCash} each, certificate limit ${dealt.certLimit}.`,
          );
          return;
        }

        /* The tile grid is its own atom; applying it inside the dispatch is what makes a lay replicate to every client.
           See docs/ai_architecture/firebase_middleware.md - App.tsx #522 */
        /* Design note #757: ONE PREDICATE, BOTH ATOMS. The tile grid and the game state are separate stores
           and a lay touches both -- plus the sub-phase cursor. Built once here and handed to each, so a
           refused placement cannot land on one and be rejected by the other. Board rules only: connectivity
           is left out because the D&H and C&SL lay track that legally ignores it (#725/#726) and this message
           does not say which power is in play. */
        /* ==================================================================
           DESIGN NOTE 766: THE GATE JUDGED THE BOARD IT HAD JUST CHANGED
           ==================================================================
           REPORTED: "corporations are only allowed to lay one tile per turn ... that restriction has been
           respected until this last build when suddenly the number of tile lays is unlimited."
           #757's PREDICATE READ THE REF AT CALL TIME, and this dispatch calls it TWICE: once for the tile
           grid, then again inside `applySandboxAction`. Between those two calls the grid write had already
           advanced `mapGridRef.current` to the board WITH the new tile on it -- so the second call asked
           "may a yellow tile go on this hex?" about a hex that now carried yellow, got "no", and the reducer
           refused a lay it had just performed.
           THE VISIBLE RESULT IS THE REGRESSION. Refusing returns the state unchanged, so the sub-phase never
           advanced from Track to Tokens, and the one-lay-per-turn rule is enforced entirely BY that advance.
           The tile still landed, because the grid is a separate atom that had already been written. Unlimited
           lays, each one individually "refused".
           THE FIX IS A SNAPSHOT, NOT A REORDER. Binding the predicate to the board as it stood BEFORE this
           action means both atoms judge the same thing, which is what #757 said it was doing and is the whole
           point of building the predicate once. Reordering the two calls would have worked today and left the
           next reader one edit away from reintroducing it. */
        const gridBeforeAction = mapGridRef.current;
        /* ==================================================================
            DESIGN NOTE 1106: #757 GAVE THE GRID A REF AND LEFT THE PHASE ON RENDER STATE
           ==================================================================
           REPORTED: "I refreshed and the entire board reset to Yellow tiles, erasing the Green upgrades that
           had been laid."

           THE ERA CAME FROM `currentPhase`, WHICH IS `useMemo(() => derivePhase(gameState))` -- React state.
           A refresh replays the whole log in one burst of awaited dispatches, and React does not commit
           between them in any way this closure can rely on, so `currentPhase` is still whatever it was when
           the burst BEGAN: phase 2, tint yellow. Every green upgrade in the log is then judged against a
           yellow board, `filterSandboxPlacements` returns nothing, `layRefused` answers true, and the tile is
           dropped. The board rebuilds with exactly the yellow tiles and none of the upgrades -- which is the
           report, precisely.

           #757 DIAGNOSED THIS EXACT FAILURE FOR THE OTHER INPUT and its note describes what I am fixing:
           "An Undo replays the whole log in one burst, so a legality check reading React state would judge
           every lay in that burst against the board as it stood before the burst began -- and refuse
           legitimate upgrades, because the tile they upgrade would not be there yet." It gave the GRID a ref
           and left the PHASE reading state. One rule, asked of one of its two inputs -- this project's
           signature fault, in the function whose note names it.

           SNAPSHOTTED BESIDE THE GRID, per #766's "a snapshot, not a reorder": both halves of this predicate
           must judge the same instant, or the pair disagrees the way #766's two calls did.
           READ FROM `sandboxStateRef`, which the reducer writes SYNCHRONOUSLY -- the only thing in this file
           that is current inside an awaited dispatch, and the reason that ref exists (#537a). */
        const phaseBeforeAction = derivePhase(sandboxStateRef.current);
        const layRefused = (q: number, r: number, tileId: number, orientation: number) =>
          filterSandboxPlacements([{ tile_id: tileId, orientation }], {
            mapGrid: gridBeforeAction,
            q,
            r,
            era: ERA_FOR_PHASE_TINT[phaseBeforeAction?.tint ?? "yellow"],
          }).length === 0;

        if ("LayTile" in msg) {
          const lay = msg.LayTile;
          /* Written through the REF and then to state, synchronously, so the next action in a replay burst
             sees this tile. `setMapGrid((current) => ...)` alone was correct for one lay and wrong for a
             sequence, which is every Undo. */
          const nextGrid = applySandboxLayTile(
            mapGridRef.current,
            lay.q,
            lay.r,
            lay.tile_id,
            lay.orientation,
            layRefused,
          );
          /* ==================================================================
              DESIGN NOTE 1029: THE INSTRUMENT KEEPS ITS ALARM AND LOSES ITS TICKING
             ==================================================================
             REPORTED: "The Activity Log is printing raw board state data like '[OR 6.2--Lay Track] Board --
             Board now holds 15 tiles (was 14).' This is unnecessary clutter."

             AND IT IS, ON THE EXPLAINED PATH. #768 added this to catch a board LOSING a tile -- "a fall is
             unconditionally a bug and this is the line that will name it" -- and then printed on every lay,
             so the one line worth reading arrives buried in one per tile ever placed. A log that reports the
             normal case as loudly as the impossible one is a log nobody is reading when the impossible one
             happens.

             SUPPRESSED, NOT DELETED. `describeGridChange` still runs and still classifies; only the
             `explained` case stops printing. Deleting the check outright would answer the report by removing
             the instrument, and the thing it watches for is a corrupted board -- which is the one class of
             bug this project cannot recover from and has already shipped twice.

             THE UNEXPLAINED LINE KEEPS ITS SHOUT, tag and all: it is not "Board", it is "Board
             (unexplained)", and it is the only board-state line a player will now ever see. */
          const gridChange = describeGridChange(msg, mapGridRef.current, nextGrid, fallbackLabel);
          if (gridChange?.unexplained) {
            logInfo("Board (unexplained)", gridChangeLine(gridChange));
          }
          if (nextGrid !== mapGridRef.current) {
            mapGridRef.current = nextGrid;
            setMapGrid(nextGrid);
          }
        }

        /* Resolve first, log second. A ref is written synchronously, which fixes both the cross-atom charge ordering and a loop of dispatches collapsing onto one base state.
           See docs/ai_architecture/state_machine.md - App.tsx #265 */
        const before = sandboxStateRef.current;

        // The snapshot push is gone with the stack it fed (#178/#310/#475): undo replays the log now.
        // See docs/ai_architecture/state_machine.md - App.tsx #591

        /* Design note #261: the auction's own atom, advanced alongside the
           game state. `applySandboxWaterfallAction` returns the cash it
           implies rather than reaching across into player wallets, so the
           charge is applied here through the ordinary path. */
        let after = before;
        const waterfallBefore = sandboxWaterfallRef.current;
        if (waterfallBefore) {
          const result = applySandboxWaterfallAction(
            waterfallBefore,
            msg,
            before?.player_addresses ?? [],
          );
          sandboxWaterfallRef.current = result.waterfall;
          setSandboxWaterfall(result.waterfall);

          /* Design note #334a: a LIST of charges, and not all of them the
             actor's -- an auto-awarded private is charged to its lone
             bidder, who may not be the player who just moved. */
          for (const { player, amount } of result.charges) {
            if (!after) break;
            after = {
              ...after,
              player_cash: after.player_cash.map((entry: { player: string; cash_vgp: string }) =>
                entry.player === player
                  ? {
                      ...entry,
                      cash_vgp: String(Math.max(0, (Number(entry.cash_vgp) || 0) - amount)),
                    }
                  : entry,
              ),
            };
          }

          /* The reducer REPORTS a win; the owner is written here, where both atoms are in hand. A list, because one purchase can cascade (#334).
             See docs/ai_architecture/contract_economy.md - App.tsx #303 */
          for (const { privateId, name, player, price } of result.won) {
            if (after) {
              after = {
                ...after,
                private_companies: after.private_companies.map((entry) =>
                  entry.private_id === privateId ? { ...entry, owner: player } : entry,
                ),
              };
            }
            /* The SETTLED price, kept beside the state - cost is a printed property of the company.
               See docs/ai_architecture/contract_economy.md - App.tsx #303 */
            setSettledPrivatePrices((prev) => ({ ...prev, [privateId]: price }));
            logInfo(
              "Private Won",
              `${sandboxPlayerLabel(player) ?? truncateAddress(player)} won ${name} for $${price}.`,
            );

            /* The B&O private grants a presidency, but not here: the grant needs a par, and the par is a decision, so the win raises a prompt (#399).
               See docs/ai_architecture/contract_economy.md - App.tsx #354 */
            if (privateId === BO_PRIVATE_ID) {
              setBoParPrompt({ player });
            }

            /* A consequence is DERIVED by every client, not appended by each of them - appending inside a replay is how one win issued two certificates. #550: a choice is logged, a consequence need not be.
               See docs/ai_architecture/firebase_middleware.md - App.tsx #576 */
            if (privateId === CA_PRIVATE_ID && after) {
              const prr = after.public_companies.find((c) => c.ticker === CA_BONUS_TICKER);
              if (prr) {
                const granted = applyPrivateExchange(after, {
                  ok: true,
                  privateId,
                  companyId: prr.company_id,
                  ticker: CA_BONUS_TICKER,
                  player,
                  source: prr.ipo_pool_percentage >= 10 ? "Ipo" : "Bank",
                  /* Design note #576: the company survives. Closing it would
                     cost its owner $25 an Operating Round for the rest of
                     the game. */
                  keepOpen: true,
                });
                if (granted !== after) {
                  after = granted;
                  logInfo(
                    "Private Power",
                    `${sandboxPlayerLabel(player) ?? truncateAddress(player)} receives a free 10% ` +
                      `${CA_BONUS_TICKER} share with the Camden & Amboy, which stays open.`,
                  );
                }
              }
            }
          }

          /* The reducer reports the all-pass markdown; the money moves here through applyPrivateRevenue, the same payout the Operating Round uses.
             See docs/ai_architecture/contract_economy.md - App.tsx #337 */
          if (result.markdown) {
            logInfo(
              "Waterfall",
              `Everyone passed \u2014 ${result.markdown.name} drops from $${result.markdown.from} to $${result.markdown.to}.`,
            );
          }
          if (result.allPassed && after) {
            const revenue = applyPrivateRevenue(after);
            if (revenue && revenue.state !== after) {
              after = revenue.state;
              const labelFor = (address: string) =>
                sandboxPlayerLabel(address) ?? truncateAddress(address);
              const tickerFor = (companyId: number) =>
                after?.public_companies.find((entry) => entry.company_id === companyId)?.ticker ??
                `company #${companyId}`;
              /* Design note #1059: THE SAME STAMP AS THE OTHER PAYOUT SITE. Two call sites printing one kind
                 of event two ways is #891's shape, and this is the one that pays the privates out of an
                 all-passed auction rather than an opening Operating Round -- same payment, same phase name. */
              const auctionPayoutStamp = `${roundLabelFor(after)}--Private Companies`;
              for (const payout of revenue.payouts) {
                logInfo(
                  describePrivatePayout(payout, labelFor, tickerFor),
                  "",
                  auctionPayoutStamp,
                );
              }
            }
          }
        }

        /* Design note #1054: the dividend's price move, held from the market atom until `label` is composed
           a few hundred lines below. `let` because it is written by the block that reads the atom's result
           and read by the one that builds the sentence -- the two are far apart precisely BECAUSE the atom
           has to move before the state settles (#272/#273), which is what makes the clause a report of a
           completed move rather than #775's projection of one. */
        let dividendMarketMove:
          | { from: number; to: number; reason: "payout" | "withhold" }
          | null = null;

        /* Design note #272/#273: the market atom, advanced BEFORE the game
           state because the game state needs the price it reports. Same
           contract as the waterfall's: this returns the figure rather than
           reaching into wallets, so one number is charged and logged. */
        const marketResult = applySandboxMarketAction(sandboxMarketRef.current, msg, {
          projectSale: (from, blocks) => projectShareSaleMove(from, blocks),
          /* Design note #1090: the Blood Price's geometry and its legality, injected as a pair for the same
             reason the sale's are -- `utils/` may not import `components/` (#273), and the chart must not
             move for a train sale the mark does not cover (#748a/#774, twice learned). `before` is the state
             the trade was proposed against, which still carries the seller's flag; the reducer clears it. */
          projectBloodPrice: (from) => projectBloodPriceMove(from),
          isCarcosanSale: (sellerId, modelType) =>
            before ? isCarcosanTransfer(before, sellerId, modelType) : false,
          /* Design note #291: the dividend decision moves the marker too.
             Design note #908: BY AS MANY CELLS AS THE PAYOUT EARNED. The step count is computed from the
             corporation's own revenue and its CURRENT price, read off `before` -- the board the payout was
             declared against. Reading the price after the move would be measuring the multiple against the
             cell the multiple just chose. */
          projectDividend: (from, choice) => {
            const declaring =
              "DeclareDividends" in msg
                ? before?.public_companies.find(
                    (entry) => entry.company_id === msg.DeclareDividends.protocol_id,
                  )
                : undefined;
            const payout = Number(declaring?.last_route_revenue ?? 0) || 0;
            /* ==================================================================
                DESIGN NOTE 988: THE CHOICE GOES IN, AND IT USED NOT TO
               ==================================================================
               THIS PASSED THE PAY-DERIVED COUNT TO WHICHEVER CHOICE ARRIVED, so a withhold under Dynamic
               Stock Market moved by the multiple the PAYOUT would have earned -- none for a small run, two
               for a large one. The readout twenty screens down already hard-coded one cell for a withhold
               and said so in a comment, which is #891's exact failure: the bar promising a move the board
               does not perform.
               ONE ARGUMENT FIXES BOTH SIDES because `dividendStepsFor` is now the only place that knows. */
            const steps = dividendStepsFor(
              payout,
              marketPriceForCompany(declaring?.company_id ?? -1),
              resolveVariants(before?.variants),
              choice,
            );
            return projectDividendCellMove(from, choice, steps);
          },
          /* Design note #748a: the SAME rule the reducer applies below, asked here because this atom runs
             first. Without it a refused sale still walked the token down and the chart and the board parted
             company for the rest of the game. `before` is the board the reducer will judge it against. */
          /* Design note #774: the SAME refusal the reducer applies below, asked here because this atom runs
             first. Without it the second copy of a forced withhold still stepped the token left, and two
             browsers meant two steps -- the reported "two cells rather than one". */
          dividendRefused: (companyId) => (before ? dividendRefused(before, companyId) : false),
          saleRefused: (companyId, percentage) => {
            const seller = options?.actor ?? viewerAddressRef.current;
            if (!before || !seller) return false;
            return (
              shareSaleBlock({ state: before, seller, companyId, percentage }) !== null
            );
          },
        });
        if (marketResult.prices !== sandboxMarketRef.current) {
          sandboxMarketRef.current = marketResult.prices;
          setSandboxMarket(marketResult.prices);
        }
        if (marketResult.moved) {
          const { companyId, from, to, reason } = marketResult.moved;
          const ticker =
            before?.public_companies.find((entry) => entry.company_id === companyId)?.ticker ??
            `#${companyId}`;
          /* Say what actually moved the price: a withheld dividend is not a share sale, and a payout rises.
             See docs/ai_architecture/stock_market.md - App.tsx #435 */
          const [verb, cause] =
            reason === "payout"
              ? (["rose", "on the dividend payout"] as const)
              : reason === "withhold"
                ? (["fell", "on the withheld dividend"] as const)
                : reason === "bloodPrice"
                  ? (["fell", "as the Blood Price"] as const)
                  : (["fell", "on the share sale"] as const);
          /* ==================================================================
              DESIGN NOTE 1090: THE TRANSFER'S OWN SENTENCE, STAMPED YELLOW SIGN
             ==================================================================
             RULED: "The gold-trimmed train was transferred. A Blood Price was paid: [Selling Corp]'s stock
             dropped from $X to $Y."
             ITS OWN LINE, NOT A CLAUSE ON THE SALE, which is the opposite of #1054's decision for the
             dividend and right for the opposite reason. A dividend's price move is a CONSEQUENCE OF THE
             DECLARATION and belongs in its sentence; this is a second event with its own cause, its own
             flavour and its own round stamp -- the fog collecting, not the trade completing. The ordinary
             trade line still prints beside it, saying who bought what for how much.
             THE FIGURES ARE THE ATOM'S, not a projection. #775 deleted a clause that predicted a move; these
             are `from` and `to` off the token that actually travelled. */
          if (reason === "bloodPrice") {
            logInfo(
              `The gold-trimmed train was transferred. A Blood Price was paid: ${ticker}'s stock dropped from $${from} to $${to}.`,
              "",
              roundStampFor({
                ...(before as GameStateResponse),
                operating_sub_phase: CARCOSA_STAMP_STEP as never,
              }),
            );
          }
          /* ==================================================================
              DESIGN NOTE 1054: A DIVIDEND'S PRICE MOVE IS PART OF THE DIVIDEND'S SENTENCE
             ==================================================================
             REPORTED: "the two Dividends entries can be combined into: 'B&O paid dividends on $X:.... B&O's
             share price rose from $90 to $100.'"
             SO THE FIGURES TRAVEL RATHER THAN GETTING THEIR OWN LINE. `dividendMarketMove` is read by
             `describeGameplayAction` a few hundred lines below, where `label` is composed -- the atom has
             already moved by then, which is what lets the clause quote a destination the token really
             reached. #775 deleted a version of this clause that PROJECTED one; the difference is the whole
             note, and it is why this is a stash rather than a second calculation.
             A SHARE SALE KEEPS ITS OWN LINE. It is a different action with a different sentence, and nobody
             asked for those to merge -- so the suppression is scoped to the two dividend causes rather than
             applied to every move the atom makes. */
          if (reason === "payout" || reason === "withhold") {
            dividendMarketMove = { from, to, reason };
          } else {
            logInfo("Market Move", `${ticker} ${verb} from $${from} to $${to} ${cause}.`);
          }
        }

        /* Design note #941: THE FLASH AND THE TURN'S SENTENCE LEFT THIS FUNCTION. #940 raised them here,
           once per dispatched route, which is exactly the reported complaint: four trains produced four
           flashes and four sentences about what is now a single roll. Both moved to `handleRunTrains`, which
           is the only place that can see the end of the dispatch loop and therefore the only place that
           knows a TURN has run. */

        if (after) {
          after = applySandboxAction(after, msg, {
            // Design note #549: the log's author, so a replayed purchase is
            // credited to the player who made it rather than to whoever this
            // browser's cursor happens to point at.
            actor: options?.actor,
            // Only `RunManualRoute` reads this, to total the printed value of
            // the stops the player picked instead of paying a flat nominal
            // for every route regardless of length.
            mapGrid,
            // Design note #492a: likewise read only by `RunManualRoute`.
            era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
            // Design note #273: what the chart says this share is worth, so
            // the wallet and the market agree about one trade.
            sharePrice: marketResult.tradePrice ?? undefined,
            /* Read the market ref the block above has just refreshed, so the queue reflects a move this dispatch caused.
               See docs/ai_architecture/stock_market.md - App.tsx #411 */
            marketPriceFor: marketPriceForCompany,
            /* Design note #712: the zone rules travel with the price, so the reducer refuses an illegal
               purchase on every client rather than trusting the one that drew the button. */
            marketZoneFor: (companyId: number) =>
              marketZoneForPrice(marketPriceForCompany(companyId)),
            marketPricesByCompany: Object.fromEntries(
              (marketGrid?.positions ?? []).map((entry) => [
                entry.company_id,
                Number(entry.price),
              ]),
            ),
            zoneForPrice: marketZoneForPrice,
            // Design note #647: the token's position -- column and arrival.
            marketMarkFor: marketMarkForCompany,
            /* Design note #746a: the chart's own UP step, so the reducer can raise a sold-out corporation
               before it sorts the operating queue on the prices that raise produced. */
            projectRise: (from) => projectRiseMove(from),
            /* The par comes from the MESSAGE's own protocol_id and par_value, not from any ambient ladder selection (#579).
               See docs/ai_architecture/stock_market.md - App.tsx #398 */
            parValue: (() => {
              if (!("BuyStock" in msg)) return undefined;
              const fromMsg = Number(msg.BuyStock.par_value ?? NaN);
              return Number.isFinite(fromMsg) && fromMsg > 0 ? fromMsg : undefined;
            })(),
            /* Design note #363: the board's own label -> (q, r) table, so a
               corporation that floats gets its home token on the hex the
               map actually draws rather than on a coordinate this reducer
               guessed. */
            homeHexToAxial,
            // Design note #757: the same refusal the tile grid applies, so the fee and the cursor agree.
            layRefused,
          });

          /* ==================================================================
           *  DESIGN NOTE 750: EVERY TREASURY MOVEMENT, NAMED OR FLAGGED
           * ==================================================================
           *
           * Reported: a corporation with $500 arrived at Buy Trains holding $1500. I could not find the
           * writer by reading, so this reads the DIFF rather than trusting any arm to declare what it
           * charged -- an arm that reports its own arithmetic will happily report a bug.
           *
           * A movement on a message with no business moving a treasury is printed as UNEXPLAINED, which is
           * the line worth having: the ordinary ones are bookkeeping and the surprising one is the bug. */
          /* Design note #1053: THE DIAGNOSTIC KEEPS ITS JOB AND LOSES ITS ECHO. An explained movement whose
             own sentence already carries `Treasury $A → $B` needs no second line; everything else -- and
             every UNEXPLAINED movement, which is the case this block was built for -- still gets one. See
             `sentenceStatesTreasury` for why the predicate lives beside the sentences rather than here. */
          if (after) {
            const statedInLine = sentenceStatesTreasury(msg);
            for (const move of describeTreasuryMoves(msg, before, after)) {
              if (!move.unexplained && statedInLine) continue;
              logInfo(
                move.unexplained ? "Treasury (unexplained)" : "Treasury",
                treasuryMoveLine(move, fallbackLabel),
              );
            }
          }

          /* ==================================================================
           *  DESIGN NOTE 746b: COMMITTING THE RISE TO THE CHART
           * ==================================================================
           *
           * The reducer has already USED these rises -- #746a overlays them so the operating queue sorts on
           * post-rise prices -- but the market atom is not part of `GameStateResponse`, so the tokens
           * themselves still have to be moved here. Both sides call `soldOutRises` with the same injected
           * traversal and the same two states, so the queue's idea of a price and the chart's cannot drift.
           *
           * AFTER the state, unlike the three ordinary moves above, and for the opposite reason: a dividend
           * or a sale is a move the MESSAGE determines, so the state needs the price it produced. A rise is a
           * move the RESULTING BOARD determines -- who is sold out, and whether the round just closed -- and
           * neither of those facts exists until the reducer has run. */
          if (after) {
            const rises = soldOutRises({
              before,
              after,
              markFor: marketMarkForCompany,
              projectRise: (from) => projectRiseMove(from),
            });
            if (rises.length > 0) {
              let chart = sandboxMarketRef.current;
              for (const rise of rises) {
                chart = {
                  ...chart,
                  // Design note #646: a rise is an arrival like any other, so it is stamped like one.
                  [rise.companyId]: withArrival(chart, rise.companyId, {
                    price: rise.to,
                    x: rise.x,
                    y: rise.y,
                  }),
                };
                logInfo("Market Move", describeSoldOutRise(rise));
              }
              sandboxMarketRef.current = chart;
              setSandboxMarket(chart);
            }
          }

          /* ==================================================================
           *  DESIGN NOTE 738: THE ONE NOTIFICATION, FIRED WHERE EVERY CLIENT SEES IT
           * ==================================================================
           *
           * REQUESTED: a toast when a player receives dividends.
           *
           * HERE, AND NOT AT THE DECLARE BUTTON, because the button only exists on the PRESIDENT'S client. A
           * dividend's whole point is that it reaches players who are not acting -- so the notification has to
           * be raised on the path every client runs, which is this one: `runGameplayAction` handles a remote
           * action with `isRemoteReplay: true` exactly as it handles a local one.
           *
           * AND `derived` IS EXCLUDED for #668's reason, unchanged: an auto-declared $0 withhold is the game
           * acting, and it pays nobody anyway.
           *
           * THE AMOUNT COMES FROM THE MODULE, THE TRANSITION FROM THE DIFF. `dividendReceipt` composes the
           * sentence from the same arithmetic the reducer uses, and the before/after cash is read off the two
           * states this dispatch already holds -- so the figure quoted and the figure that moved cannot come
           * apart the way #723's preview and debit did. */
          /* Design note #1017: the variant's narration, derived from the diff so EVERY client produces it.
             Deliberately not gated on `options?.derived`, unlike the receipt below: that flag means "the game
             dispatched this on the player's behalf", which is true of the forced withhold -- and a forced
             withhold happens only when nothing ran, so `printed_route_revenue` is zero and the guard below
             declines on the facts rather than on the flag. */
          /* ==================================================================
              DESIGN NOTE 1056: THE DIE IS REPORTED WHERE IT WAS ROLLED
             ==================================================================

             REPORTED: "in the Unpredictable Revenue variant, B&O ran but the log did not print the
             variant/flavor text and did not trigger any sound. This instead occurred a subphase later when
             clicking the 'Pay Dividends' button, which is too late for a player to make an informed
             decision."

             AND IT IS A DECISION-QUALITY BUG, not a cosmetic one. Pay-or-withhold is the choice the whole
             step exists for, and the modifier changes the number it is made against -- a 20% malus can be the
             difference between paying out and holding. The player was choosing blind and then being told.

             THIS BRANCH ASKED FOR `DeclareDividends` AND THE REASON EXPIRED. #963 put the narration here
             because the turn's printed total accumulated across one message per train, so Dividends was the
             first moment the TURN's figure was complete -- its own note says "the cursor is on Dividends by
             now, that is what makes this the right moment to read the total". #968 then made the whole turn a
             single `RunMultipleRoutes`, and the total has been complete at the end of the run ever since.
             The premise went and the code stayed, which is this codebase's third recurring shape.

             THE SEED COMES OFF THE MESSAGE NOW, which is the other thing that got simpler. #1051 records the
             roll on the run's own payload, so the sentence that describes the roll reads it from the action
             that made it -- no log scan, no re-derivation, and no chance of the narration and the reducer
             pricing the same turn from two different numbers.

             THE TOTAL IS READ OFF `after`, deliberately: the run has just banked it, and `before` holds the
             figure from the previous message of the same turn. The FLEET is read off `before`, because the
             Yellow Sign takes a train and the mark must judge the fleet as it ran. */
          if (
            before &&
            after &&
            "RunMultipleRoutes" in msg &&
            resolveVariants(before.variants).unpredictableRevenue
          ) {
            const companyId = msg.RunMultipleRoutes.protocol_id;
            const ran = before.public_companies.find((entry) => entry.company_id === companyId);
            const banked = after.public_companies.find((entry) => entry.company_id === companyId);
            const printedTurnTotal = Math.max(0, Number(banked?.printed_route_revenue ?? 0) || 0);
            if (printedTurnTotal > 0) {
              /* THE SEED IS READ OFF `before`, not off render state. #963 read `gameState` because the handler
                 had it; a replaying client has no render state that matches the action it is replaying, and a
                 seed taken from the wrong turn produces a different face and a different sentence on every
                 browser -- which is worse than the missing line this note is fixing. */
              /* ==================================================================
                  DESIGN NOTE 1051: THE NARRATION READS THE ROLL, IT DOES NOT REPEAT IT
                 ==================================================================
                 THIS SENTENCE IS WRITTEN ON `DeclareDividends`, and the die was thrown back on
                 `RunMultipleRoutes` -- so `msg` here is the wrong message to ask. Before this batch that did
                 not matter, because the face was a pure function of the turn and any caller could re-derive
                 it. It matters now: a real draw exists in exactly one place, the log.
                 SO IT LOOKS THE RUN UP, with the same helper and the same key the dispatch used. The reducer
                 priced the turn against `revenue_seed` and this sentence describes what the reducer did; two
                 reads of one recorded number cannot disagree, where a second draw here would put a different
                 percentage in the Activity Log than the one the board actually paid.
                 THE FALLBACK IS THE OLD DIE, for a pre-#1051 log whose run carried no seed -- the same answer
                 the reducer reaches for the same entry, which is what keeps the replay and its narration
                 telling one story. */
              const seed = {
                macroRound: before.macro_round_number ?? 0,
                subRound: before.sub_round_index ?? 0,
                companyId,
                /* Design note #1056: OFF THE MESSAGE, which is the simplification that came with moving this
                   block to the run. The dispatch that rolled the die is the dispatch being narrated, so the
                   sentence and the reducer read one number rather than two clients' worth of lookup. The
                   fallback is #1051's, for a run logged before the roll was recorded. */
                turnSeed:
                  msg.RunMultipleRoutes.revenue_seed ??
                  legacyTurnSeed(
                    before.macro_round_number ?? 0,
                    before.sub_round_index ?? 0,
                    companyId,
                  ),
              };
              const roll = rollTurnRevenue(printedTurnTotal, seed);
              /* Design note #963: stamped with the step it DESCRIBES. The cursor is on Dividends by now --
                 that is what makes this the right moment to read the total -- so the step is stated. */
              /* Design note #1046: the ruled stamp -- `[OR X.Y--Yellow Sign]`. Its own step name, because the
                 event is not part of Run Routes or Dividends and stamping it as either would file it under a
                 step that did not do it. */
              const yellowSignStamp = roundStampFor({
                ...before,
                operating_sub_phase: "Yellow Sign" as never,
              } as typeof before);
              const runRoutesStamp = roundStampFor({
                ...before,
                operating_sub_phase: "Routes",
              } as typeof before);
              /* ==================================================================
                  DESIGN NOTE 1040: THE SENTENCE, ITS SOUND AND ITS TINT, DECIDED TOGETHER
                 ==================================================================
                 ONE PLACE, because they are one event. The line is composed here, so this is where the
                 flavour clause exists to be scanned -- and re-deriving it in an effect downstream would mean
                 rolling the die twice or parsing the sentence back apart. */
              const bucket = flavorBucketFor(roll);
              const ticker = ran?.ticker ?? `Corporation #${companyId}`;
              /* ==================================================================
                  DESIGN NOTE 1044: THE STATE COMES OUT OF THE LOG, NOT OUT OF A FLAG
                 ==================================================================
                 READ BEFORE THIS LINE IS APPENDED, so a Stage 1 draw sees a game in which the sign has not
                 yet been seen -- and read from the log every client rebuilds identically, so every client
                 reaches the same verdict about the same turn. A flag written onto the corporation would live
                 in one browser's memory and be lost on the first reload. */
              const signState = yellowSignStateFrom(actionLogRef.current.map((entry) => entry.label));
              /* THE NATURAL DRAW FIRST, then the Easter egg's rules applied to it -- so this cannot disagree
                 with `revenueFlavourClause` about what would otherwise have been printed. */
              const naturalSentence = turnRevenueSentence(ticker, roll, seed);
              const resolved = resolveFlavourLine({
                naturalLine: revenueFlavourClause(roll, seed),
                bucket,
                ticker,
                parts: seed,
                state: signState,
                /* Design note #1046: the phase BEFORE this dispatch settled, which is the phase the turn was
                   played in. Reading it off `after` would judge a turn by a phase its own train purchase had
                   already turned. */
                phaseTier: derivePhase(before)?.tier ?? "2",
                owned: ran?.owned_trains,
                /* Design note #1092: the debt, asked of the board rather than of the line. `before` is the
                   state this run was dispatched against, so the clock is read where every other fact about
                   this turn is read. */
                fogDue: fogIsDue(ran, before?.macro_round_number ?? 0),
              });
              /* THE SENTENCE IS REBUILT ONLY WHEN THE EGG CHANGED THE CLAUSE, so an ordinary turn goes
                 through exactly the path it always did and the opening/tense rules (#944, #950) are not
                 restated here. */
              const flavourLine =
                resolved.line === revenueFlavourClause(roll, seed)
                  ? naturalSentence
                  : naturalSentence.replace(revenueFlavourClause(roll, seed), resolved.line);
              /* ==================================================================
                  DESIGN NOTE 1046: THE APPENDIX, THE ACTION AND THE SECOND LOG LINE
                 ==================================================================
                 THE APPENDIX IS PART OF THE SENTENCE, so it goes in before the line is logged -- the ruled
                 text ("One train mysteriously disappeared...") reads as the second half of the flavour, not
                 as a separate entry. The MECHANICAL line is separate and comes after, because it is a record
                 of what changed rather than a piece of atmosphere. */
              const flavourWithAppendix =
                resolved.stage === "mark"
                  ? `${flavourLine} ${MARK_APPENDIX}`
                  : resolved.stage === "carcosa"
                    ? `${flavourLine} ${ESCALATION_APPENDIX}`
                    : flavourLine;
              /* ==================================================================
                  DESIGN NOTE 1079: THE SEAM IS ARITHMETIC, NOT PARSING
                 ==================================================================
                 RULED: "Apply italics strictly to the flavor text string at the end of the line, leaving the
                 mechanical revenue math in the standard font."
                 THE TAIL IS BUILT FROM THE SAME PIECES THE SENTENCE WAS, three lines up, so the two cannot
                 disagree about where the flavour starts. `turnRevenueSentence` puts the clause LAST in all
                 three of its shapes (#944/#949) and the appendix appends to the clause (#1046) -- so the
                 flavour is a suffix, and a suffix's start is a subtraction.
                 NOT `indexOf(clause)`. A clause that happened to repeat a phrase from the mechanical half
                 would match the wrong occurrence, and `indexOf` returning -1 on a miss is the exact vacuity
                 `sourceScan.ts` #886 exists to stop us writing. Lengths cannot miss. */
              const flavourTail =
                resolved.stage === "mark"
                  ? `${resolved.line} ${MARK_APPENDIX}`
                  : resolved.stage === "carcosa"
                    ? `${resolved.line} ${ESCALATION_APPENDIX}`
                    : resolved.line;
              const flavourFrom = flavourWithAppendix.length - flavourTail.length;
              const cue = variantCueFor({ line: flavourWithAppendix, bucket, stage: resolved.stage });
              logInfo(
                flavourWithAppendix,
                "",
                runRoutesStamp,
                /* Design note #1042: `unchanged` earns no tint. It is the bucket that says nothing happened,
                   and a highlight on it would be the log emphasising the absence of news. */
                bucket === "unchanged" ? undefined : isBonusBucket(bucket) ? "bonus" : "malus",
                /* Design note #1079: PASSED ON EVERY BUCKET, INCLUDING `unchanged`, unlike the tint above.
                   The italic marks which half of the line is atmosphere, and an unchanged roll's line has the
                   same two halves as any other. Withholding it there would set a third of the variant's
                   flavour upright for a reason no player could see. */
                flavourFrom,
              );
              /* THE MECHANICS GO THROUGH THE LOG AS AN ACTION (#1046), not through a local mutation: they
                 delete a train and move money, and board state in this app is what the reducer writes while
                 replaying. Dispatched AFTER the flavour line so the Activity Log reads in the order a player
                 experiences it -- the sentence, then what it did. */
              if (resolved.stage === "mark") {
                const taken = lowestValueTrain(ran?.owned_trains);
                if (taken) {
                  const award = markPayout(taken);
                  logInfo(
                    `The ${taken}-train disappeared. $${award} found.`,
                    "",
                    yellowSignStamp,
                  );
                  void runGameplayAction("YellowSignEvent", {
                    YellowSignEvent: {
                      game_id: gameId,
                      protocol_id: companyId,
                      stage: "mark",
                      model: taken,
                      cash: String(award),
                    },
                  });
                }
              } else if (resolved.stage === "fog") {
                /* ==================================================================
                    DESIGN NOTE 1092: THE THIRD STAGE MOVES THE BOARD LIKE THE OTHER TWO
                   ==================================================================
                   THE SENTENCE IS ALREADY WRITTEN by the clause above; this is the half that takes the train.
                   Dispatched rather than mutated, for #1046's reason verbatim: "board state in this app is
                   what the reducer writes while replaying", and a train removed locally would come back on
                   the next rebuild.
                   THE MODEL IS NAMED ON THE MESSAGE, like the Mark's is (#902): by the time an old log
                   replays to here the fleet has moved on, and re-deriving "the marked train" against a later
                   roster could take a different one than the game took. */
                const taken = (ran?.carcosan_trains ?? [])[0] ?? null;
                if (taken) {
                  void runGameplayAction("YellowSignEvent", {
                    YellowSignEvent: {
                      game_id: gameId,
                      protocol_id: companyId,
                      stage: "fog",
                      model: taken,
                    },
                  });
                }
              } else if (resolved.stage === "carcosa") {
                const gifted = escalationTier(derivePhase(before)?.tier ?? "2");
                if (gifted) {
                  logInfo(`${ticker} received a ${gifted}-train.`, "", yellowSignStamp);
                  void runGameplayAction("YellowSignEvent", {
                    YellowSignEvent: {
                      game_id: gameId,
                      protocol_id: companyId,
                      stage: "carcosa",
                      model: gifted,
                    },
                  });
                }
              }
              /* ==================================================================
                  DESIGN NOTE 1094: THE EPHEMERAL HALF DOES NOT REPLAY
                 ==================================================================
                 REPORTED, as critical: "On page refresh, or when using Undo to return to the Dividends
                 subphase, the app erroneously replays the last visual animation (Unpredictable Revenue
                 flashes) or toast notification."

                 AND THIS BLOCK IS EXACTLY HALF RIGHT, WHICH IS WHY IT SURVIVED THIS LONG. Everything above
                 this line REBUILDS something -- the flavour clause, the Activity Log entry, the Yellow Sign
                 dispatch -- and every one of those MUST run on a replay, because a rebuilt client with no
                 Activity Log is a client that has lost the game's history. Everything below it HAPPENS: a
                 sound, a video, a flash. Those are events, and an event that already happened does not
                 happen again because somebody pressed F5.

                 THE FLAG WAS ALREADY THERE AND THIS BLOCK NEVER ASKED IT. `replayingHistory` is set around
                 every dispatch the drain makes (#825) and correctly true for both reported paths -- a refresh
                 replays the whole log, so `pending` is not 1; an undo sets `rewound`. Four other ephemeral
                 raisers ask it. This one was written as one block because the sentence and its sound were
                 decided together (#1040), and the guard belongs to only half of it.

                 GATED ON ONE FLAG AT ONE LINE rather than on each of the three, which is #748a's rule: a call
                 site that has to remember is a call site that will forget, and the fog video added a fourth
                 ephemeral effect here one batch ago without anybody noticing the first three were unguarded.

                 WHAT IS DELIBERATELY NOT GUARDED is the `YellowSignEvent` dispatch above. It moves the board,
                 the reducer refuses a duplicate on its own (#1092), and skipping it on a replay would rebuild
                 a game in which the fog never took the train. */
              const ephemeral = !replayingHistory;
              /* Design note #1081: `null` is the unchanged bucket's default -- "nothing happened" has nothing
                 to sound like. Guarded HERE rather than inside `playVariantCue`, because that function's
                 `enabled` argument means "the player muted this" and silence-by-design is a different fact:
                 folding them together would make a muted cue and an intentionally silent one indistinguish-
                 able at the one place either could be debugged from. */
              if (ephemeral && cue.audio !== null) {
                playVariantCue(cue.audio, sfxEnabledRef.current && sfxRevenueRef.current);
              }
              if (ephemeral && cue.video) {
                if (hauntingTimerRef.current !== null) {
                  window.clearTimeout(hauntingTimerRef.current);
                }
                setHaunting({
                  src: `/audio/${cue.video}`,
                  /* Design note #1093: `?? "screen"` is unreachable -- every branch that sets `video` sets
                     this too -- and it is here because the type is nullable for the cues that have no video
                     at all, not because a video without a composite is a state this shell can handle. */
                  composite: cue.videoComposite ?? "screen",
                  ms: cue.videoMs,
                });
                /* Design note #1045: the video's own audio is outside `playVariantCue`'s ducking, so the bed
                   is held down for the clip's whole run and released with it. Without this the radio plays
                   at full volume under a ten-second haunting. */
                /* Design note #1073: THE DEEP DUCK, ASKED FOR BY NAME. This is the one clip the shallow
                   default is wrong for -- ten seconds with its own dialogue, which #1045 added ducking for in
                   the first place. Every short cue takes the default and barely touches the bed. */
                /* ==================================================================
                    DESIGN NOTE 1093: AND THE SILENT CLIP TAKES NO DUCK AT ALL
                   ==================================================================
                   THE DUCK EXISTS FOR A SPECIFIC THING: audio inside the `<video>` element, which never
                   passes through `playVariantCue` and so is never ducked or concurrency-limited by it. The
                   fog clip has no audio stream -- its sound is the MP3 dispatched two lines above, which
                   ducks itself for its own 2.6 seconds. Holding the bed down at 20% for six more seconds
                   would silence the music to protect a silent film.
                   ASKED OF `videoHasOwnAudio`, not of the clip's name or its duration. */
                const releaseHaunting = cue.videoHasOwnAudio
                  ? duckRadio(DUCK_FOR_VIDEO)
                  : null;
                hauntingTimerRef.current = window.setTimeout(() => {
                  setHaunting(null);
                  hauntingTimerRef.current = null;
                  releaseHaunting?.();
                }, cue.videoMs);
              }
              /* #938'S PREDICATE, not `percent !== 100`: a 90% roll on a $50 turn pays $45, which rounds back
                 to $50, and flashing "-10%" over a turn that lost nothing is the confusion this exists to
                 prevent. */
              /* Design note #1040: AND THE HAUNTING PLAYS ALONE. Ruled: "the engine must completely
                 suppress the standard default visual UI animations ... for that specific submission. The
                 player should only see the 10000ms video overlay and the updated Activity Log styling."
                 ASKED OF THE CUE'S OWN FIELD rather than of `cue.video !== null`, so the rule is read where
                 it is written -- see the note on `suppressStandardVisuals`. */
              /* ==================================================================
                  DESIGN NOTE 1065: THE NEUTRAL ROLL NOW CONFIRMS ITSELF
                 ==================================================================
                 REPORTED: "When the variant rolls an unchanged revenue state (0% modifier), cleanly flash the
                 screen white and briefly display a `+0%` or `Unchanged` indicator to confirm the roll was
                 executed."
                 THE GUARD WAS `revenueOutcome(roll) !== "normal"` AND IT WAS RIGHT ABOUT THE WRONG THING.
                 #938's rule, quoted above, is that the flash must never claim a modifier the corporation did
                 not FEEL -- a 90% roll on a $50 turn pays $45, rounds back to $50, and "-10%" would be a lie.
                 Suppressing the whole overlay was one way to honour that; it also meant the commonest single
                 outcome of the die, a third of its faces, produced no feedback at all and looked exactly like
                 a variant that had failed to fire.
                 SO THE OUTCOME STILL DECIDES THE FIGURE -- it is just a figure now instead of silence. A
                 hard `0` for every `"normal"` roll, never `revenueDeltaPercent`, so the swallowed 90% flashes
                 `+0%` rather than the `-10%` #938 forbids. The nominal swing cannot reach this surface.
                 `+0%` RATHER THAN "Unchanged", ON INSTRUCTION. I argued for the word, because "normal" covers
                 both a true 100% and a rounded-away modifier; ruled otherwise, and rightly: "players don't
                 know the difference between roll3/roll4 and a 10% malus that rounded back up: for them the
                 end result is +0%." The figure describes the player's outcome, which is what every other
                 figure on this overlay describes. */
              if (ephemeral && !cue.suppressStandardVisuals) {
                setRevenueFlash({
                  delta: revenueOutcome(roll) === "normal" ? 0 : revenueDeltaPercent(roll),
                  token: nextRevenueFlashToken(),
                });
              }
            }
          }

          if (after && "DeclareDividends" in msg && options?.derived !== true) {
            const viewer = viewerAddressRef.current;
            const declared = msg.DeclareDividends;
            const company = before?.public_companies.find(
              (entry) => entry.company_id === declared.protocol_id,
            );
            const held =
              company?.player_holdings.find((entry) => entry.player === viewer)?.percentage ?? 0;
            const cashOf = (state: GameStateResponse | null) => {
              const raw = Number(
                state?.player_cash.find((row) => row.player === viewer)?.cash_vgp ?? NaN,
              );
              return Number.isFinite(raw) ? raw : null;
            };
            /* ==================================================================
             *  DESIGN NOTE 795: THE TOAST HAD ITS OWN IDEA OF THE REVENUE
             * ==================================================================
             *
             * REPORTED across three runs: "the Dividends and the Activity Log showed the correct amounts, but
             * the toast notification said B&O paid $5 per share ... I'm not sure why you don't have the toast
             * notifications pulling from the same source as the Activity Log."
             *
             * BECAUSE IT DID NOT. This line read `company.last_route_revenue` off the BEFORE state and floored
             * it -- a THIRD implementation of the per-share figure, beside the reducer's and the log's, and
             * the only one not fed by the declaration itself. `revenue_amount` is what the corporation
             * actually declared and what the reducer actually pays; `last_route_revenue` is a running total
             * that a multi-train turn fills in one message at a time, which is why every wrong figure the
             * report lists is one train's worth of a longer run.
             *
             * `dividendSplit` NOW ANSWERS ALL THREE. #775 pointed the log at it and #791's markers at the same
             * discipline; this was the copy that got missed, and it was the one on screen. */
            const settlement = dividendSplit(
              before,
              declared.protocol_id,
              declared.revenue_amount,
              declared.distribute === true,
            );
            const mine = settlement?.players.find((share) => share.player === viewer);
            const receipt = dividendReceipt({
              ticker: company?.ticker ?? "The corporation",
              distribute: declared.distribute === true,
              perShare: settlement?.perShare ?? 0,
              /* Design note #923: from the SAME settlement as the amount, so the two figures in one sentence
                 cannot come from two sources -- which is the failure #795 was reported for. */
              revenue: settlement?.revenue ?? 0,
              viewerPercentage: held,
              /* The figure the reducer spent on this viewer, not a re-derivation of it. `0` when they are not
                 on the list at all, which `dividendReceipt` turns into no toast. */
              amount: mine?.amount ?? 0,
              cashBefore: cashOf(before),
            });
            if (receipt) {
              /* The transition is recomputed from the ACTUAL after-state rather than trusted from the module,
                 which only ever projected it. Where the two disagree the board is right. */
              const settled = cashOf(after);
              const beforeCash = cashOf(before);
              /* Design note #1048: THE ONE OTHER PLAYER-FOCUSED TOAST. Asked for "all other player-focused
                 toasts in the player-color", and today that set has exactly one member -- this receipt, which
                 is about the viewer's own cash. The era toast is a fact about the table and stays unmarked. */
              const seatAt = gameState?.player_addresses.indexOf(viewerAddressRef.current ?? "") ?? -1;
              /* ==================================================================
                  DESIGN NOTE 1060: THE RECEIPT STOPS BEING A SENTENCE
                 ==================================================================
                 SPECIFIED: "Completely disable the default fast-fading toast notification for dividend
                 payouts", replaced by the money-machine overlay.
                 EVERY FIGURE IT SHOWED SURVIVES THE MOVE, which is the part worth checking rather than
                 assuming: the amount is still `receipt.amount` -- #795's rule that the number a player is
                 told they received is the reducer's, not this module's opinion -- and the balances are still
                 read off the two states rather than added here, so #670's before/after is intact.
                 WHAT IS LOST IS `receipt.headline`, and it is a real loss stated plainly: "PRR ran for $170.
                 Your 60% share paid $102" carried the ROUTE TOTAL and the HOLDING, and the overlay carries
                 neither. #923 chose those two deliberately, because a percentage and a total are facts a
                 player can check where "per share" no longer reconciles under the variant die. They are both
                 still in the Activity Log's dividend line, which is where a figure you want to verify
                 belongs; the overlay is for the money arriving.
                 BOTH BALANCES OR NEITHER. With either end unknown there is no movement to animate and no
                 total to count up to, so the overlay is skipped rather than shown with a guess -- #562's rule
                 about a missing figure, applied to the pair it takes to make one. */
              if (beforeCash !== null && settled !== null) {
                moneyMachineTokenRef.current += 1;
                showDividendPayout({
                  ticker: company?.ticker ?? "The corporation",
                  amount: receipt.amount,
                  /* Design note #559: the one shared resolver, not a local copy -- the whole reason that note
                     exists is that `App.tsx` once kept its own and two panels showed raw ids. */
                  playerName:
                    sandboxPlayerLabel(viewerAddressRef.current ?? "") ??
                    truncateAddress(viewerAddressRef.current ?? ""),
                  seatColor:
                    seatAt >= 0 ? seatColor(viewerAddressRef.current ?? "", seatAt) : null,
                  cashBefore: beforeCash,
                  cashAfter: settled,
                  token: moneyMachineTokenRef.current,
                });
              }
            }
          }

          /* A float is announced here by diffing before/after, naming the hex the home token landed on. #401: a par is also a cell on the chart.
             See docs/ai_architecture/state_machine.md - App.tsx #400 */
          /* Design note #688: EVERY PARRED CORPORATION HAS A MARK, checked as an invariant rather than caught as
             an edge. #468 enforced it "at FLOAT, not only at par", which was the right instinct chasing the wrong
             quarry -- both are still transitions, and a transition over an atom a rebuild resets is exactly the
             #685 failure: a missed edge is silent and permanent, because nothing looks again.
             `reconcileParMarks` is idempotent (`placeParMark` no-ops on a company that already has a mark, so a
             token that walked away from its par box is never dragged back), which is what makes running it on
             every action safe rather than merely cheap.
             Design note #415 survives inside it: `parBoxCellFor`, not `marketCellForPrice` -- the latter resolves
             a par to the chart's TOP ROW and put five of six par values on the wrong cell.
             THE REF IS WRITTEN SYNCHRONOUSLY, out of the state updater it used to hide in. #316 needed the ref
             fresh because the Stock Round close that opens an Operating Round runs in this same dispatch, before
             React commits -- and a write buried inside an updater is a side effect in a function React may call
             twice, or not until flush. Same requirement, honestly met. */
          {
            const marked = reconcileParMarks(
              sandboxMarketRef.current,
              after.public_companies,
              parBoxCellFor,
            );
            if (marked !== sandboxMarketRef.current) {
              sandboxMarketRef.current = marked;
              setSandboxMarket(marked);
            }
          }

          if (before) {
            for (const company of after.public_companies) {
              const previously = before.public_companies.find(
                (entry) => entry.company_id === company.company_id,
              );
              // Design note #400: the branching lives in `describeFloat`,
              // where a test can reach it.
              const line = previously ? describeFloat(previously, company) : null;
              if (line) logInfo("Float", line);
            }

            /* Design note #704: THE TRAINS THE PHASE TOOK. `applyPhaseChange` has rusted and trimmed fleets
               since #284 and has never said so -- the chips simply held fewer trains than they had a moment
               earlier. #703 made that reachable for the BUYER (before it, the panel refused the purchase that
               would leave them over the new limit), so the silence stopped being theoretical.
               Same division as the two blocks around it: the reducer settles, the shell narrates, and the
               branching lives in `sandboxSession` where a test can reach it. */
            const limitNow = depotInventory(after).find((row) => row.isCurrent)?.trainLimit ?? null;
            /* Design note #896: AND THE PRESIDENT IS STOPPED FOR IT, at the top of their own next turn. The
               line above is written whatever the player's toggles say -- silencing a notice changes WHEN they
               find out, never whether the game told them. */
            const arrivingTier = derivePhase(after)?.tier ?? null;
            const gentleRustOn = resolveVariants(after.variants).gentleRust;
            const queuedNotices = [...pendingFleetNoticesRef.current];
            for (const loss of describeFleetLosses(before, after)) {
              const sentence = describeFleetLoss(loss, limitNow);
              if (sentence) logInfo("Phase Change", sentence);

              for (const notice of fleetLossNotices(loss, arrivingTier, limitNow)) {
                /* ==================================================================
                    DESIGN NOTE 1002: UNDER GENTLE RUST THE RUST MODAL WAITS
                   ==================================================================
                   RULED: "the Rust modal must no longer trigger globally upon the purchase of the
                   phase-change train. Instead, scope it to trigger at the moment the gently rusted trains are
                   permanently destroyed."
                   AND ONLY THE RUST HALF WAITS. A train the LIMIT took is gone right now -- the trim is not
                   postponed by this variant -- so its notice is still due immediately, and suppressing both
                   would lose that one entirely. #896's split by cause is what makes the distinction
                   expressible at all.
                   THE ACTIVITY LOG IS UNTOUCHED: `describeFleetLoss` above still writes the line at the phase
                   change for every corporation, which is #896's standing rule -- silencing or deferring a
                   modal changes WHEN a player finds out, never whether the game told them. */
                if (gentleRustOn && notice.cause === "rust") continue;
                /* IDEMPOTENT, for #706's reason one function over: the Undo path replays the whole log, so
                   this block runs again for a phase change the player already saw. Keyed by CONTENT rather
                   than by position -- two different phase changes carry different arriving tiers and both
                   survive, while a replay of the same one lands on the same key and adds nothing.
                   ==================================================================
                    DESIGN NOTE 1032: AND "ALREADY SEEN" IS ALSO A REASON NOT TO QUEUE
                   ==================================================================
                   REPORTED: the modals "kept firing at the start of basically every operating round". The
                   dedupe below was asked only of the PENDING queue -- so it stopped a notice being queued
                   twice while it waited, and said nothing about one that had been queued, shown, dismissed
                   and thereby REMOVED from the queue. The next replay found the queue empty of it and added
                   it back. Both questions are the same question, so both now consult the same key. */
                const key = noticeDismissKey(notice);
                const already =
                  dismissedFleetNoticesRef.current.has(key) ||
                  queuedNotices.some((entry) => noticeDismissKey(entry) === key);
                if (!already) queuedNotices.push(notice);
              }
            }
            if (queuedNotices.length !== pendingFleetNoticesRef.current.length) {
              pendingFleetNoticesRef.current = queuedNotices;
              setPendingFleetNotices(queuedNotices);
            }

            /* ==================================================================
                DESIGN NOTE 1002: AND THE MODAL FOR A TRAIN THAT HAS JUST DIED
               ==================================================================
               THE OTHER END OF THE DEFERRAL ABOVE. `describeReprieveExpiries` reports the corporations whose
               marks emptied in THIS dispatch -- which after #1001 is the moment the cursor enters Buy Trains,
               with the trains actually gone from the fleet.
               ONE CORPORATION AT A TIME, BY CONSTRUCTION, which is the whole point: the expiry is the acting
               corporation's own, so the president who is about to buy a replacement is the one stopped, at
               the moment the slot they need has just opened.
               `arrivingTier` IS THE PHASE NOW IN FORCE, not the one that did the marking. The tier that
               killed these trains may be two phases back by the time the reprieve runs out, and the notice's
               body does not name it after #980 -- what it feeds is the tier field, which is honest as "the
               phase this happened in" and would be a guess as anything else. */
            const expiries = describeReprieveExpiries(before, after);
            if (expiries.length > 0) {
              const expiryQueue = [...pendingFleetNoticesRef.current];
              const expiryTier = derivePhase(after)?.tier ?? null;
              const expiryLimit =
                depotInventory(after).find((row) => row.isCurrent)?.trainLimit ?? null;
              for (const loss of expiries) {
                for (const notice of fleetLossNotices(loss, expiryTier, expiryLimit)) {
                  /* IDEMPOTENT ON A REPLAY, by content, exactly as the phase-change queue above is: Undo
                     rebuilds by replaying the log, so this block runs again for an expiry the player has
                     already acknowledged. Design note #1032: and the dismissed set is consulted here too --
                     this queue had the identical hole, and fixing one of two identical call sites is the
                     half-fix this codebase keeps producing. */
                  const key = noticeDismissKey(notice);
                  const already =
                    dismissedFleetNoticesRef.current.has(key) ||
                    expiryQueue.some((entry) => noticeDismissKey(entry) === key);
                  if (!already) expiryQueue.push(notice);
                }
              }
              if (expiryQueue.length !== pendingFleetNoticesRef.current.length) {
                pendingFleetNoticesRef.current = expiryQueue;
                setPendingFleetNotices(expiryQueue);
              }
            }

            /* Design note #736: AND THE PRIVATES THE PHASE CLOSED. Same division as the fleet losses beside
               it -- the reducer settled it, this says so. Worth a line of its own because the consequences
               are spread out and easy to misattribute: income stops, a certificate leaves the limit, and any
               special power on the board goes with it. */
            /* ==================================================================
                DESIGN NOTE 1058: WHICH CLOSURE THIS IS DECIDES WHAT IT MEANS
               ==================================================================
               REPORTED: "the 'Phase Change' line is written improperly: it is true BO closes as soon as B&O
               buys a train, but this is not a phase change and private companies DO continue paying out
               revenue."
               THE PHASE IS THE DISCRIMINATOR, asked of the two states this transition already holds rather
               than inferred from how many privates closed at once -- a Phase 5 arrival with five already-
               closed privates closes exactly one, and counting would call that a solo closure. */
            const closures = describePrivateClosures(before, after);
            if (closures.length > 0) {
              const phaseTurned = derivePhase(before)?.tier !== derivePhase(after)?.tier;
              const named = closures
                .map((entry) => `${entry.privateId}. ${entry.name}`)
                .join(", ");
              /* ==================================================================
                  DESIGN NOTE 1068: THE STAMP, NOT THE CATEGORY -- #1058 DID HALF OF THIS
                 ==================================================================
                 REPORTED: "The tag for Private company 6. BO needs to be '[OR 1.1--Private Companies] 6.
                 Baltimore & Ohio closes.' Anything involving private companies needs to be tagged [OR
                 X.Y--Private Companies]".
                 AND #1058 PUT THE WORDS IN THE WRONG SLOT. It changed the LABEL to "Private Companies", which
                 renders as a `Category — sentence` prefix, so the line came out
                 `[OR 1.1--Buy Trains] Private Companies — Private company 6. Baltimore & Ohio closes.` --
                 the classification twice and the stamp still naming whichever step the cursor happened to be
                 on. The payout lines got this right one batch earlier (#1059) and the closure did not.
                 SO IT TAKES THE SAME STAMP THE PAYOUTS TAKE, and the whole sentence goes in the label with an
                 empty detail, which is what removes the prefix. A phase-driven closure keeps `Phase Change`,
                 because at Phase 5 the subject really is the phase and the privates are its consequence. */
              const closureStamp = `${roundLabelFor(after)}--Private Companies`;
              if (phaseTurned) {
                logInfo(
                  "Phase Change",
                  /* #736's SENTENCE, UNCHANGED, and still correct for the event it was written about: at
                     Phase 5 every private closes together and every one of them stops paying. */
                  `${named} ${closures.length === 1 ? "closes" : "close"} — private companies pay no further revenue and no longer count toward the certificate limit.`,
                );
              } else {
                /* A SINGLE PRIVATE ON ITS OWN TRIGGER. Nothing about the phase moved and the others keep
                   paying every Operating Round, so the sentence claims neither -- and it no longer opens with
                   "Private company", because the stamp above it already says so. */
                logInfo(
                  `${named} ${closures.length === 1 ? "closes" : "close"}.`,
                  "",
                  closureStamp,
                );
              }
            }
          }

          /* Design note #685: the private income, REPORTED here and PAID by the reducer.
             The money moves inside `settleRoundTransitions`, so this only has to say what happened -- the same
             division `describeFloat` above works to: the reducer settles, the shell narrates.
             DERIVED FROM `before`, which is safe because nothing in the transition changes who owns a private:
             `applyPrivateRevenue` is pure, and asking it for its `payouts` list without taking its `state` reads
             the figures the reducer just paid without paying them again. The harness asserts that equivalence
             rather than trusting this sentence. */
          const openedOperatingRound =
            before !== null &&
            after !== null &&
            before.current_round_type !== "OperatingRound" &&
            after.current_round_type === "OperatingRound";
          if (openedOperatingRound && before !== null && after !== null) {
            const settled = after;
            const labelForAddress = (address: string) =>
              sandboxPlayerLabel(address) ?? truncateAddress(address);
            const labelForCompany = (companyId: number) =>
              settled.public_companies.find((entry) => entry.company_id === companyId)?.ticker ??
              `company #${companyId}`;
            const openingPayouts = applyPrivateRevenue(before)?.payouts ?? [];
            /* THE LOG KEEPS ITS LINE PER PRIVATE (#967): the feed is a record, and a record wants each
               payment findable. The toast is the surface that consolidates. */
            /* ==================================================================
                DESIGN NOTE 1059: THE PAYOUT PHASE STAMPS ITSELF
               ==================================================================
               REPORTED: "for the private company payouts, let's have the print be '[OR X.Y -- Private
               Companies] 1. Schuylkill Valley Pays $5 to Player' and remove 'Private Revenue --'."
               AND THE OLD STAMP WAS ACTIVELY WRONG. These lines took the default, which reads the cursor --
               so six payments made before any corporation acted were all filed under `Buy Trains`, a step
               none of them belong to and the one that happened to be current. The payout is its own phase
               (#1049); the stamp says so, exactly as the Yellow Sign's does (#1046).
               THE CATEGORY GOES WITH IT. `Private Revenue — ` was a prefix on a sentence that already names
               the private company in its first two words, and the stamp now carries the classification. The
               whole sentence goes in the label with an empty detail, which is the same shape the variant's
               flavour lines use. */
            const payoutStamp = `${roundLabelFor(after)}--Private Companies`;
            for (const payout of openingPayouts) {
              logInfo(
                describePrivatePayout(payout, labelForAddress, labelForCompany),
                "",
                payoutStamp,
              );
            }
            /* ==================================================================
                DESIGN NOTE 1049: THE TOAST BECOMES THE PHASE'S MODAL
               ==================================================================
               THREE SURFACES HAVE NOW STOOD HERE -- #967's consolidated toast, #1016's corner anchor, #1047's
               toast that waits for a click -- and each was a better answer to "how long should this be up"
               than the last. The question turned out to be the wrong one: "in the physical game, the PC
               payouts is a separate phase prior to any corporation acting ... I think the current version has
               minimized or obscured that process." A duration cannot fix a register.
               EVERY EARLIER DECISION SURVIVES INSIDE THE NEW SURFACE. One panel rather than one per private
               (#967), a table rather than a joined sentence (#984), a total at the foot of the column
               (#1047), the private cards' own paper (#1048). What changed is that it interrupts.
               Design note #967a still governs the read: THROUGH THE REF, like every other viewer read inside
               this callback. `runGameplayAction` is a long-lived `useCallback` and `viewerAddress` is not in
               its deps -- a closure read would show the wallet that was connected when the callback was
               built, which after a reconnect is somebody else's income. */
            const round = summarisePrivateRevenueRound(openingPayouts, viewerAddressRef.current);
            /* ==================================================================
                DESIGN NOTE 1049b: ONLY WHEN THE READER COLLECTED SOMETHING
               ==================================================================
               #967's `null` RULE IS KEPT, and it is what stops this becoming the thing #1047 feared. A player
               holding no privates has no payment to witness, and a modal telling them so every Operating
               Round would be an interruption whose entire content is other people's money -- which is #967's
               objection ("worse than silence") in its strongest form rather than its weakest.
               IT ALSO ENDS THE FEATURE CLEANLY. Once the privates close in Phase 5 nobody collects, the
               summary is null for everyone, and the modal simply stops appearing -- because at that point the
               payout phase genuinely no longer exists. Nothing has to be switched off. */
            if (round.mine) {
              const seatIndexOf = (address: string) =>
                settled.player_addresses.indexOf(address);
              const viewerSeat = seatIndexOf(viewerAddressRef.current ?? "");
              /* ==================================================================
                  DESIGN NOTE 1052: THE BALANCES, FROM THE TWO STATES THE TRANSITION ALREADY HAS
                 ==================================================================
                 ASKED: "on payouts, we usually include $before > $after somewhere", and for the other seats
                 "their $before + $payout > $new cash holdings."
                 READ OFF `before` AND `after` RATHER THAN COMPUTED. The payout total is already in hand and
                 `after = before + payout` is arithmetic anybody could do here -- and #685's rule is that the
                 reducer settles and the shell narrates, so a figure the reducer has banked must be READ. A
                 derived balance would be right until the day something else touches cash in the same
                 transition, and then it would be confidently wrong on a panel whose whole subject is money.
                 `null` FOR A SEAT THE STATE DID NOT REPORT, which the modal renders as no movement rather than
                 as a zero (#232, #562). */
              const cashIn = (state: GameStateResponse | null, address: string) => {
                const raw = Number(
                  state?.player_cash.find((row) => row.player === address)?.cash_vgp ?? NaN,
                );
                return Number.isFinite(raw) ? raw : null;
              };
              const viewer = viewerAddressRef.current ?? "";
              /* Design note #1049: THE SHELL RESOLVES THE IDENTITIES. Names come from the room's nickname
                 registry and colours from the seating index, neither of which a presentation component should
                 have to reach for -- see the modal's `PrivateRevenueOther` for the argument. */
              const others: PrivateRevenueOther[] = round.others.map((entry) => {
                const seat = seatIndexOf(entry.address);
                return {
                  name: labelForAddress(entry.address),
                  // `null` rather than a guessed hue for an address the roster cannot place (#232).
                  seatColor: seat >= 0 ? seatColor(entry.address, seat) : null,
                  total: entry.total,
                  // Design note #1052: what they now hold, not what they held -- the row states the arrival
                  // and the standing, and the `before` is the subtraction between them.
                  cashAfter: cashIn(after, entry.address),
                };
              });
              showPrivatePayoutPhase({
                viewerName: labelForAddress(viewer),
                viewerSeatColor:
                  viewerSeat >= 0 ? seatColor(viewer, viewerSeat) : null,
                lines: round.mine.rows,
                total: round.mine.total,
                cashBefore: cashIn(before, viewer),
                cashAfter: cashIn(after, viewer),
                others,
                // The round it belongs to, stamped now rather than read later from a board that has moved on.
                roundLabel: roundLabelFor(settled),
              });
            }
          }

          sandboxStateRef.current = after;
          setSandboxState(after);



          /* settleRoundTransitions performs the transition; the shell only logs it. Detected by comparing state, silent on a replay, and no tab navigation here (#213 owns that).
             See docs/ai_architecture/state_machine.md - App.tsx #642 */
        label =
          describeGameplayAction(msg, {
            ...describeContext,
            afterState: after,
            // Design note #1054: the atom's own move, so the dividend sentence carries it instead of a
            // second line repeating what the first one caused.
            marketMove: dividendMarketMove,
            // Design note #1070: the shell's verdict on why this step was skipped, if it skipped one.
            skipReason: options?.skipReason ?? null,
          }) ?? label;

        /* Design note #794: the receipt, from the sentence the Activity Log is about to show. One string, one
           snapshot, so the two cannot disagree about a figure. */
        /* ==================================================================
            DESIGN NOTE 1063: THE TRAIN PURCHASE IS NEWS FOR THE WHOLE TABLE
           ==================================================================
           REPORTED: "The train purchase notification is currently only firing locally for the active player.
           Update the websocket/event emission logic to broadcast this toast globally to all connected
           players."
           THE DIAGNOSIS IS RIGHT AND THE MECHANISM IS NOT WHAT IT SOUNDS LIKE. Nothing needed broadcasting:
           every client already runs this function for every action, which is #738's whole point ("the
           notification has to be raised on the path every client runs ... `runGameplayAction` handles a
           remote action with `isRemoteReplay: true` exactly as it handles a local one"). The toast was
           SUPPRESSED on arrival by the actor comparison below. The fix is a deleted condition, not a
           transport change -- worth stating, because looking for an emission to widen would have been a long
           search for something that does not exist.
           AND IT REVERSES #718's SCOPE FOR ONE MESSAGE, DELIBERATELY. That note scoped receipts to "your own
           dispatches" because "'Did it go through' is a question about a button you pressed; a toast for
           somebody else's action would be a notification feed, which is what the log already is." That
           reasoning still holds for the rest of the set. A depot train leaving is different in kind: it is
           the phase clock, every player is counting it, and a rival buying the last 4-train changes what
           everybody else should do next. It is the one action where somebody else's click is your business.
           THE REPLAY GUARD IS WHAT MAKES THIS SAFE. `showActionToast` returns early during a rebuild (#825),
           so joining a room does not carpet the screen with every train the table has ever bought -- which is
           exactly what widening the audience would otherwise have done. */
        const globallyBroadcast = trainPurchaseToastLine(msg, {
          ...describeContext,
          afterState: after,
        });
        if (
          options?.derived !== true &&
          deservesActionReceipt(msg) &&
          (globallyBroadcast !== null ||
            (options?.actor ?? viewerAddressRef.current) === viewerAddressRef.current)
        ) {
          /* Design note #1063: the short sentence when there is one, the log's own when there is not. Both
             come out of `actionLog.ts` and both are built from this dispatch's single snapshot, which is the
             property #794 actually protects. */
          /* ==================================================================
              DESIGN NOTE 1072: A SHORTER SENTENCE EARNS A SHORTER WINDOW
             ==================================================================
             REPORTED: "The toast notification for a corporation buying trains ... lasts for a very long time.
             I would guess 5+ seconds ... with the lesser amount of information on the toast, we can reduce
             the time it needs to stay up to 3 seconds."
             #928 SET THE STANDARD WINDOW AT 3,700ms FOR A LONGER LINE -- "too short for players to read the
             financial details", when the receipts carried a route total, a percentage and an amount. The
             depot toast is now six words and a number, so it is sized by the project's own rule of thumb:
             readable ~1.5x before it goes away. */
          showActionToast(
            globallyBroadcast ?? label,
            globallyBroadcast !== null ? DEPOT_TOAST_MS : undefined,
          );
        }

        /* Design note #784: computed ONCE, above the entry that reads it three times -- and once rather than
           three times is not only tidiness here: `refusalReasonFor` runs the real purchase and sale gates,
           and three identical calls per action is three times the work for one answer. */
        const refusalWasRefused = actionWasRefused(before, after, msg);
        const refusalReason = refusalWasRefused
          ? refusalReasonFor(before, msg, {
              actor: options?.actor ?? viewerAddressRef.current,
              marketZoneFor: (companyId: number) =>
                marketZoneForPrice(marketPriceForCompany(companyId)),
              marketPricesByCompany: Object.fromEntries(
                (marketGrid?.positions ?? []).map((entry) => [
                  entry.company_id,
                  Number(entry.price),
                ]),
              ),
              zoneForPrice: marketZoneForPrice,
            })
          : null;
        /* THE PLAYER IS LOOKING AT THE BOARD, NOT THE LOG. Reported as "there was no notification that the
           player was at certificate limit" -- the rule existed in a disabled button's tooltip, which is
           invisible on a tablet. A refused action is exactly the moment a receipt is owed. */
        if (refusalWasRefused && refusalReason && options?.isRemoteReplay !== true) {
          showActionToast(refusalReason);
        }

        /* ==================================================================
         *  DESIGN NOTE 786, WITHDRAWN BY #795: THERE WAS ALREADY A PAYOUT NOTICE
         * ==================================================================
         *
         * #786 answered "I don't receive any toast notifications when another player's corporation pays
         * dividends to me" by adding one here. It was a duplicate: `showDividendToast` below has fired for
         * every shareholder since #400, actor or not, and is not gated on who dispatched. Two notices for one
         * payout is the flood #718 removed, and I built half of it while looking for the reason the other
         * half was quoting a wrong figure.
         *
         * THE REAL FAULT WAS THAT THE EXISTING NOTICE READ `last_route_revenue`, so on a multi-train turn it
         * announced one train's worth -- which reads exactly like "no notification arrived" if the number is
         * wrong enough. #795 fixed the figure; the notice never needed replacing.
         *
         * RECORDED RATHER THAN DELETED because the lesson is mine: I added a feature that existed, in a file
         * I had already read, because I searched for the mechanism I expected instead of the one on screen. */

        /* ==================================================================
         *  DESIGN NOTE 1077: A SILENCED DISPATCH STILL SPEAKS WHEN IT WAS REFUSED
         * ==================================================================
         *
         * `silentInLog` is a promise by the CALLER that it will write one line covering this dispatch and its
         * siblings. That promise only holds for dispatches that WORKED: the multi-buy summary quotes a price,
         * a treasury transition and a depot count, and every one of those numbers assumes the purchase landed.
         * A refusal is not covered by that sentence, so suppressing it would take #778's whole point --
         * "the log says whether it happened" -- and hand it back to the bug it was written against.
         * HENCE THE `||`, not a plain skip. The quiet case is the success case only. */
        if (!options?.silentInLog || refusalWasRefused) {
        setActionLog((log) => [
          {
            id,
            seq: id, // design note #668
            /* Design note #778: THE LOG SAYS WHETHER IT HAPPENED. This entry was written `success` for every
               dispatch that reached the drain, describing the MESSAGE rather than its effect -- so every
               silent gate (#712, #748, #757, #763, #774) announced its refusals as completed actions.
               Reported as "the activity log printed the purchase went through but it didn't".
               IDENTITY, NOT A GUESS: every gate refuses by returning the state it was handed, so
               `before === after` is exact. `mayLegitimatelyDoNothing` carries the short list of messages for
               which an unchanged board means nothing is wrong.
               Design note #784: AND IT NAMES THE RULE, when one owns up. `refusalReasonFor` calls the very
               functions the reducer called, on the very state it called them with -- so the sentence is the
               reducer's own answer rather than a second opinion about it. */
            label: refusalWasRefused
              ? refusedActionLineWithReason(label, refusalReason)
              : label,
            status: refusalWasRefused ? "error" : "success",
            /* ==================================================================
                DESIGN NOTE 965: THE SANDBOX RECEIPT IS GONE FROM THE SUCCESS PATH
               ==================================================================
               REPORTED: "Remove the string 'Sandbox: applied to local mock state (nothing signed, no chain).'
               from the sandbox Activity Log outputs. It is unnecessary debug spam for our playtesting."
               AND IT SAYS THE SAME THING ON EVERY LINE, which is what makes it spam rather than information:
               the whole feed is the sandbox, so a per-entry reminder carries no bit. It was written when the
               sandbox and a live chain shared this feed and a reader needed to know which they were watching.
               THE REFUSAL SENTENCE STAYS. That one is not boilerplate -- it fires only when the reducer
               DECLINED a message, which is a fact about that entry and the only thing distinguishing it from
               an action that worked.
               EMPTY STRING, NOT `undefined`: `ActionLogEntry.detail` is a required `string`, and
               `feedItemText` already renders the " — " separator only when the detail is truthy. Widening the
               field to optional for one call site would touch every reader of the feed. */
            detail: refusalWasRefused
              ? "Sandbox: the reducer declined this message and the board is unchanged."
              : "",
            timestamp,
            timestampMs,
            /* Stamp the entry with the round the action was taken IN (before), not the one it resolved to.
               See docs/ai_architecture/state_machine.md - App.tsx #659 */
            /* Design note #958: stamped with the step the action was taken ON, from the same `before` state
               #659 chose for the round -- an action that advances the cursor must not be filed under the step
               it moved to.
               ==================================================================
                DESIGN NOTE 1069: ENDING A TURN BELONGS TO NO STEP
               ==================================================================
               REPORTED: "At the end of a corporation's turn, it clicks End Turn but the Activity Log prints
               '[OR 1.1--Buy Trains] B&O passed.' Let's instead have this say '[OR 1.1] B&O ended its turn.'
               Note there's no action subphase attached with ending the turn."
               AND THE STAMP WAS TELLING A SMALL LIE. `roundStampFor` reads the cursor, and the cursor is
               wherever the corporation happened to stop -- so ending a turn from Buy Trains filed the event
               under Buy Trains, an action the corporation explicitly did not take. #958's rule is that the
               tag names the step the action was taken ON; a turn ending is not taken on a step at all.
               `roundLabelFor` IS THE SAME FUNCTION WITHOUT THE SUFFIX, which is exactly the distinction
               `roundLabel.ts` #958 drew when it split the two: the round-transition announcements use it for
               the same reason, that "the announcement is about a round starting, at which point no
               corporation is on any step." */
            round:
              ("PassTurn" in msg ? roundLabelFor(before) : roundStampFor(before)) ?? undefined,
          },
          ...log,
        ]);
        }
          /* ==================================================================
              DESIGN NOTE 1094: THE ERA CROSSING, WHERE THE GUARD CAN SEE IT
             ==================================================================
             #868'S TOAST, MOVED HERE FROM THE RENDER EFFECT -- see the note where that effect used to be for
             why it could not be fixed in place. The rule is unchanged: announce the crossing once, to
             everybody, derived from state rather than from a message on the wire.

             GUARDED ON `replayingHistory`, NOT ON `options?.isRemoteReplay`, and the difference is the whole
             point of putting it here. The round-transition block below suppresses itself on every remote
             client, because that line is a receipt for a transition the local client drove. This one is the
             opposite: #868 ruled it goes "to every player when the threshold is crossed", and a live action
             arriving from another player's browser is a crossing that genuinely just happened. `isRemoteReplay`
             cannot tell those apart -- it is true for both -- and `replayingHistory` is precisely the
             distinction, since the drain sets it from `isOrdinaryPlay` (#825).

             READ OFF THE PHASE, NOT OFF A STORED PREVIOUS. There is no ref to go stale and nothing to
             re-baseline after a rebuild: two states, one comparison, and a rebuild simply never asks. */
          if (before !== null && !replayingHistory) {
            const eraBefore = derivePhase(before)?.tier;
            const eraAfter = derivePhase(after)?.tier;
            const from = eraBefore ? tierEra(eraBefore) : null;
            const to = eraAfter ? tierEra(eraAfter) : null;
            if (from !== null && to !== null && from !== to) {
              /* ==================================================================
                  DESIGN NOTE 966: THE ERA TOAST SAYS ONE THING
                 ==================================================================
                 REPORTED: "The current era change toast has too much text. Change the copy to simply read:
                 'Corporations can now upgrade yellow tiles to green.'"
                 AND #868'S REASON FOR THE TOAST SURVIVES THE TRIM -- "the Era change expands their
                 repertoires" -- it is the second line that was doing nothing the first did not.
                 DERIVED FROM THE TRANSITION, not written per era, so the Brown crossing reads the same way
                 without a table of sentences. */
              showDividendToast(
                `Corporations can now upgrade ${from.toLowerCase()} tiles to ${to.toLowerCase()}.`,
                null,
                /* Design note #929: the two eras the graphic draws -- a transition with one hex would be a
                   statement about nothing. */
                { from, to },
                /* Design note #1094: and its own window, 30% shorter than the standard one. */
                PHASE_CHANGE_TOAST_MS,
              );
            }
          }

          if (
            before !== null &&
            before.current_round_type !== after.current_round_type &&
            options?.isRemoteReplay !== true
          ) {
            /* The transition line names the round being announced explicitly, because no effect has refreshed the round ref yet.
               See docs/ai_architecture/state_machine.md - App.tsx #659 */
            const announcing = roundLabelFor(after) ?? undefined;
            const priorityHolder = after.player_addresses[after.priority_deal_index];
            const priorityLabel = priorityHolder
              ? (sandboxPlayerLabel(priorityHolder) ?? truncateAddress(priorityHolder))
              : "the next player";
            if (after.current_round_type === "OperatingRound") {
              logInfo(
                "Round",
                `Stock Round ends. Priority Deal shifts to ${priorityLabel}.`,
                announcing,
              );
            } else if (after.current_round_type === "StockRound") {
              /* ==================================================================
                  DESIGN NOTE 1092: #1089's BOUNDARY RECEIPT IS GONE
                 ==================================================================
                 IT PRINTED "The gold-trimmed train disappeared back into the fog." HERE, at the Stock Round
                 transition, derived from the diff. RULED SINCE that the fog is "the third step of the Yellow
                 Sign revenue sequence" -- a clause on a RUN, with its own cue -- and there is no run at a
                 round boundary. The line, the removal and the sound now all happen together at
                 `resolved.stage === "fog"`, where the other two stages already live.
                 DELETED RATHER THAN LEFT: two sentences for one event is the flood #718 removed, and this one
                 would have printed a round before the clause that says the same thing. */
              /* Name the Priority Deal on BOTH transitions - it was announced a round before it mattered and withheld when it decided who acts first.
                 See docs/ai_architecture/state_machine.md - App.tsx #659 */
              logInfo(
                "Round",
                `Operating Round ends — every corporation has operated. ${
                  roundLabelFor(after) ?? "The next Stock Round"
                } opens; ${priorityLabel} holds the Priority Deal and acts first.`,
                announcing,
              );
            }
          }
        }

        // Design note #265: described against the RESOLVED state.
        return;
      }

      if (spectator) {
        setActionLog((log) => [
          {
            id,
            seq: id, // design note #668
            label,
            status: "info",
            detail: "Spectator mode — watching only. Join from the lobby to play.",
            timestamp,
            timestampMs,
            // Design note #343: stamped at write time.
            round: roundLabelRef.current ?? undefined,
          },
          ...log,
        ]);
        return;
      }

      setActionLog((log) => [
        {
          id,
          seq: id, // design note #668
          label,
          status: "pending",
          detail: "Broadcasting via session key...",
          timestamp,
          timestampMs,
          // Design note #343: stamped at write time. The `log.map` updaters
          // below only change `status`/`detail`, so the stamp survives the
          // pending -> success transition.
          round: roundLabelRef.current ?? undefined,
        },
        ...log,
      ]);

      try {
        /* Design note #539: the guarantee, at the one call that needs it.
           Unreachable in practice -- the sandbox branch above returns for
           every setup event -- and enforced here rather than trusted. */
        if (!chainMsg) return;
        const result = await session.execGameplay(chainMsg);
        setActionLog((log) =>
          log.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  status: "success",
                  detail: `tx ${truncateAddress(result.transactionHash, 8, 6)}`,
                }
              : entry,
          ),
        );
        refreshGameState();
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error executing action.";
        setActionLog((log) =>
          log.map((entry) => (entry.id === id ? { ...entry, status: "error", detail: message } : entry)),
        );
      }
    },
    // mapGrid/currentPhase join because the sandbox branch prices a route from them; orSubPhase for the undo snapshot; logInfo for the auction announcement.
    // Design note #697: `showActionToast` is stable (`useCallback` with an empty list), so naming it costs
    // nothing and keeps the linter's guarantee -- the same reasoning #668 records for `noteCashChanges`.
    // See docs/ai_architecture/state_machine.md - App.tsx #265
    [
      showActionToast,
      // Design note #738: stable, like `showActionToast` beside it -- both are `useCallback` with empty lists.
      showDividendToast,
      /* Design note #1049: stable for the same reason and named for the same reason -- an omitted stable
         dependency is indistinguishable from a forgotten one to the next reader. */
      showPrivatePayoutPhase,
      session,
      refreshGameState,
      spectator,
      sandbox,
      mapGrid,
      currentPhase,
      orSubPhase,
      logInfo,
      /* The drain dispatches BuyPrivateCompany when an offer is accepted, and that dispatch names the game.
         See docs/ai_architecture/firebase_middleware.md - App.tsx #662 */
      gameId,
      // Design note #262: the label is derived from live state, so a stale
      // closure here would name the corporation that WAS acting and quote
      // the price the chart HAD -- a log that is wrong in exactly the way
      // the old variant-name labels never could be.
      gameState,
      marketGrid.positions,
      /* Stable useCallbacks over refs, listed anyway: an omitted stable dependency is
         still a dependency. See docs/ai_architecture/stock_market.md - App.tsx #398/#411 */
      marketPriceForCompany,
      // Design note #646: beside the price, and stable for the same reason
      // -- both are `useCallback`s over a ref, so neither changes identity.
      marketMarkForCompany,
      // Design note #416: hoisted out of this object literal, so it is a
      // dependency now rather than a freshly-built closure each call.
      homeHexToAxial,
    ],
  );

  /* Design note #546: published for `handleProceedToStockRound`, which is
     defined above this. Assigned in an effect rather than during render so
     the ref never holds a callback from a render that was thrown away. */
  useEffect(() => {
    runGameplayActionRef.current = runGameplayAction;
  }, [runGameplayAction]);

  /* A rebuild resets every atom through BOTH doors - refs and state together, plus the
     automatic guards. See docs/ai_architecture/state_machine.md - App.tsx #591c */
  const rebuildSandbox = useCallback(() => {
    const board = seedSandboxState(sandboxRoomRef.current);
    sandboxStateRef.current = board;
    setSandboxState(board);

    const waterfall = waterfallForRoster(
      sandboxWaterfallState(sandboxPhase, gameId, sandboxIsZeroState),
      [],
    );
    sandboxWaterfallRef.current = waterfall;
    setSandboxWaterfall(waterfall);

    /* The same seed the chart booted with -- design note #387: the Zero
       State starts EMPTY, because nothing is parred at turn one. */
    const market = sandboxInitialMarketPrices(
      marketCellForPrice,
      parBoxCellFor,
      sandboxScenario(sandboxScenarioId).zeroState,
    );
    sandboxMarketRef.current = market;
    setSandboxMarket(market);

    settledPrivatePricesRef.current = {};
    setSettledPrivatePrices({});

    /* ==================================================================
       DESIGN NOTE 767: A REF RESET IS HALF A RESET
       ==================================================================
       REPORTED: "in OR2.1, when a corporation laid its second track, all of the laid tiles on the board
       disappeared."
       EVERY OTHER ATOM IN THIS FUNCTION IS RESET AS A PAIR -- `sandboxMarketRef.current = market` beside
       `setSandboxMarket(market)`, `settledPrivatePricesRef.current = {}` beside its setter. #757 gave the tile
       grid a ref and did not add it here, so a rebuild reset the STATE and left the REF pointing at the board
       from before the rebuild.
       THE DISAPPEARANCE IS THE TWO WRITERS FIGHTING. `setMapGrid` is asynchronous, so the replay that follows
       a rebuild lays its first tiles onto the stale full board through the ref; React then commits the
       reset render and the mirroring effect writes the EMPTY grid back into the ref; the next lay builds from
       empty and every tile laid before it is gone. Which is the report exactly -- it takes a second lay,
       because the first one is what leaves the ref and the state disagreeing.
       RESET THE REF FIRST, then the state: the synchronous write is the one the replay reads, and the setter
       only has to agree with it. */
    /* Design note #768: a reset is legitimate and LOUD. It empties the board on purpose, so it is exempt from
       the tile-count invariant -- but a reset firing when nobody asked for one is exactly what a player would
       otherwise experience as "the tiles vanished", so it says so in the log rather than being silent. */
    if (mapGridRef.current.tiles.length > 0) {
      /* `logInfoRef`, not `logInfo`: this callback is declared above the logger, and the ref is the escape
         hatch this file already uses for exactly that (#2339). Adding `logInfo` to the dependency array
         would rebuild `rebuildSandbox` on every log line. */
      logInfoRef.current?.(
        "Board",
        `Board cleared for a rebuild — ${mapGridRef.current.tiles.length} tiles discarded.`,
      );
    }
    mapGridRef.current = MOCK_MAP_GRID;
    setMapGrid(MOCK_MAP_GRID);
    setLiveOrSubPhase("Track");

    // Any in-flight gesture belonged to the history just discarded.
    setPreviewTile(null);
    setRadialSelector(null);
    /* ==================================================================
       DESIGN NOTE 887: #767's SWEEP CAUGHT THE NEXT ONE
       ==================================================================
       FOUND BY THE HARNESS, NOT BY A REPORT, which is what #767 built it for: "Pinning 'the map grid is
       reset' would fix today and say nothing about the next ref somebody adds." This is the next ref
       somebody added. #850 gave `pendingToken` a ref -- the hex click handler is a `useCallback` the canvas
       holds across renders, so a click reads a commit-old closure -- and the rebuild reset only the state.
       THE SYMPTOM WOULD HAVE BEEN A DEAD TILE PICKER. `handleHexClick` refuses to open the ring while
       `pendingTokenRef.current !== null` (#850, so a tile question cannot land on top of an unanswered token
       question). After a rebuild the ref still held the discarded placement, so every hex click was
       swallowed -- silently, with no refusal to read -- until React committed the reset render and the
       mirroring effect caught up. In a replay burst that window is the whole burst.
       REF FIRST, THEN THE SETTER, for #767's reason exactly: the synchronous write is the one the click
       handler actually reads, and the setter only has to agree with it afterwards. */
    pendingTokenRef.current = null;
    setPendingToken(null);
    setHomeStationPlacement(null);
    setBoParPrompt(null);
    setUsedPrivateAbilities(new Set());

    autoSkippedRef.current = new Set();
    forcedWithholdRef.current = new Set();
  }, [seedSandboxState, sandboxPhase, gameId, sandboxIsZeroState, sandboxScenarioId]);

  useEffect(() => {
    rebuildRef.current = rebuildSandbox;
  }, [rebuildSandbox]);

  const handlePassTurn = useCallback(
    () => runGameplayAction("PassTurn", { PassTurn: { game_id: gameId } }),
    [runGameplayAction, gameId],
  );

  /* Undo APPENDS RevertTo to the log so the whole table undoes together; gated on authorship, not on turn. #591e: the button names the kind of action, since the full sentence cannot be rebuilt after the board has moved.
     See docs/ai_architecture/state_machine.md - App.tsx #591 */
  const describeLoggedAction = useCallback((action: { payload: string }): string => {
    const FRIENDLY: Readonly<Record<string, string>> = {
      BuyStock: "the last share purchase",
      SellStock: "the last share sale",
      PassTurn: "the last pass",
      LayTile: "the last tile lay",
      PlaceStationToken: "the last station placement",
      PlaceHomeStation: "the last home station placement",
      RunManualRoute: "the last route",
      // Design note #968: the whole turn's running is one action now, so the noun is plural.
      RunMultipleRoutes: "the last set of routes",
      DeclareDividends: "the last dividend decision",
      BuyHardwareFromPool: "the last train purchase",
      BuyTrainFromCorporation: "the last train trade",
      BuyPrivateCompany: "the last private company purchase",
      WaterfallBuyLowest: "the last private company purchase",
      WaterfallBidHigher: "the last bid",
      WaterfallPass: "the last pass",
      WaterfallMiniAuctionRaise: "the last raise",
      WaterfallMiniAuctionPass: "the last drop-out",
      SetBoPar: "the B&O's par price",
      ExchangePrivate: "the last private company exchange",
      OpenStockRound: "opening the Stock Round",
      AdvanceOperatingSubPhase: "the last skipped step",
    };
    try {
      const decoded: unknown = JSON.parse(action.payload);
      if (typeof decoded !== "object" || decoded === null) return "the last action";
      const key = Object.keys(decoded)[0] ?? "";
      return FRIENDLY[key] ?? key ?? "the last action";
    } catch {
      return "the last action";
    }
  }, []);

  /* undoReachFor decides both the button's enabled state and the dispatch; read-only is folded in so there is one reason to be disabled.
     See docs/ai_architecture/state_machine.md - App.tsx #592 */
  const undoBlockedReason = useMemo(() => {
    if (!sandbox) return controlsEnabled ? null : "Initialize the session key to act.";
    if (!controlsEnabled) return "Initialize the session key to act.";
    const reach = undoReachFor(
      sandboxLogRef.current,
      localId,
      sandboxRoom?.hostId === localId,
      describeLoggedAction,
    );
    return reach.index === null ? (reach.blockedReason ?? "There is nothing to undo.") : null;
    // sandboxAppliedCount is the real dependency and the linter cannot see it:
    // the reach is read out of a ref. See docs/ai_architecture/state_machine.md - App.tsx #592
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandbox, controlsEnabled, localId, sandboxRoom, describeLoggedAction, sandboxAppliedCount]);

  const handleUndoLastAction = useCallback(() => {
    if (!sandbox) {
      // Online the contract owns history; `UndoLastAction` is a real message
      // and a local rewind would put this browser out of step with the chain.
      void runGameplayAction("UndoLastAction", { UndoLastAction: { game_id: gameId } });
      return;
    }
    const reach = undoReachFor(
      sandboxLogRef.current,
      localId,
      sandboxRoom?.hostId === localId,
      (action) => describeLoggedAction(action),
    );
    if (reach.index === null) {
      logInfo("Undo", reach.blockedReason ?? "There is nothing to undo.");
      return;
    }
    void runGameplayActionRef.current?.(
      `Undo — ${reach.summary}`,
      {
        RevertTo: {
          index: reach.index,
          player: localId,
          summary: reach.summary,
        },
      },
      { automatic: true },
    );
  }, [sandbox, runGameplayAction, gameId, logInfo, localId, sandboxRoom, describeLoggedAction]);

  /* handleUndoToRoundStart is gone with the second button; undoToRoundStart stays exported and tested.
     See docs/ai_architecture/state_machine.md - App.tsx #592 */


  // The target company is an ARGUMENT: eight cards means eight live Buy buttons, and a shared selection would dispatch against the wrong one. #42: multi-buy is N sequential BuyStock messages. #558: the IPO always sells at par; only the bank pool prices from the matrix.
  // See docs/ai_architecture/stock_market.md - App.tsx #29
  const buyOneShare = useCallback(
    (protocolId: number, source: "Ipo" | "Bank", quantity = 1) => {
      return runGameplayAction(
        "BuyStock",
        {
          BuyStock: {
            game_id: gameId,
            protocol_id: protocolId,
            /* Design note #712: the whole purchase in one message, so a Brown-zone pool multi-buy is one
               turn. It used to be a loop of single buys, and `BuyStock` advances the seat -- so shares two
               and three were bought by whoever the seat had moved on to. */
            quantity,
            // Design note #18 in `StockRoundPanel.tsx`: the buy source is
            // per-card state now, so it arrives as an argument rather than
            // being read from a shared value that every card could flip.
            source,
            /* par_value carries the IPO's par; null means bank pool, priced from the matrix. Resolved from the company being bought (#398/#553).
               See docs/ai_architecture/stock_market.md - App.tsx #558 */
            par_value: source === "Ipo" ? parValueFor(protocolId) : null,
          },
        },
      );
    },
    // Design note #558: `gameState` went with the `is_floated` lookup.
    [runGameplayAction, gameId, parValueFor],
  );

  /* Derived from the board every render, so a reload or a double float cannot lose the prompt. Only the head of the queue is asked; naturally empty on a live chain.
     See docs/ai_architecture/state_machine.md - App.tsx #416 */
  const pendingHomeToken = useMemo(() => {
    if (!gameState) return null;
    const owed = pendingHomeTokens(gameState, homeHexToAxial)[0] ?? null;
    if (!owed) return null;

    /* ==================================================================
     *  DESIGN NOTE 788: THE WATCHER'S MODAL COULD NOT RENDER
     * ==================================================================
     *
     * REPORTED, after #783 shipped: "During the Place Home Station action of the Stock Round, no modal
     * popped up on other players' screen. However, their attempted actions were recorded in the activity log
     * as REFUSED."
     *
     * MY OWN BUG, AND THE EXACT SHAPE I HAD JUST SPENT THE DAY FIXING. #783 added a watcher arm to
     * `HomeStationPrompt` and a `viewerIsPresident` prop to choose between the two -- and this memo returned
     * `null` for anybody who was not the president, so the prop was never consulted and the arm never ran. A
     * branch that cannot be reached, exactly like #757's predicate that nothing asked.
     *
     * AND MY TEST COULD NOT SEE IT. `homeStationWait.test.ts` asserts the watcher copy EXISTS in the source,
     * which it did. A source scan cannot tell a rendered branch from a dead one; #490a already recorded that
     * limitation for design notes, and this is the same weakness applied to markup. The REFUSED lines in the
     * report are what proved the state knew -- `homeTokenBlock` saw the debt on the watcher's client while
     * this memo, one file away, was deciding the same client had nothing to be told about.
     *
     * SO THE FILTER MOVES TO WHERE THE DECISION IS. This memo answers "does the board owe a home token", which
     * is a fact about the BOARD and true identically on every client. Whether THIS viewer is the one who must
     * place it is a different question, and it already has a home: the `viewerIsPresident` prop below.
     *
     * ONE QUESTION, ONE ANSWER, in the place that can act on it -- the rule this project keeps rediscovering.
     * `viewerAddress` leaves the dependency list because nothing here reads it any more. */
    return owed;
  }, [gameState, homeHexToAxial]);

  /* #455's hotseat seat move is gone; in a room the prompt is already on the right client and there is no cursor to fight.
     See docs/ai_architecture/state_machine.md - App.tsx #578 */

  /* null when no home placement is in flight; otherwise the corporation, the one legal hex, and the tab to return to (captured, not assumed).
     See docs/ai_architecture/state_machine.md - App.tsx #440 */
  /* Design note #725: the armed private-tile errand's hex, as a `"q,r"` key.
     A REF because `handleHexClickQuery` is a `useCallback` the canvas holds across renders -- reading the
     state variable there would capture whichever errand was armed when the callback was built, which for a
     control the player arms and then clicks is reliably the wrong one. */
  const privateTileHexKeyRef = useRef<string | null>(null);

  const [homeStationPlacement, setHomeStationPlacement] = useState<{
    /* One veil, three errands. kind decides which cursor to arm and what the click does; private-tile deliberately does NOT intercept.
       See docs/ai_architecture/canvas_rendering.md - App.tsx #444 */
    kind: "home-station" | "private-station" | "private-tile";
    companyId: number;
    q: number;
    r: number;
    hexLabel: string;
    /** Design note #442: which action to mark spent once it lands. `null`
     *  for the home station, which is an obligation rather than a power. */
    abilityKey: string | null;
    returnTab: MainTab;
  } | null>(null);

  /* ==================================================================
     DESIGN NOTE 818: THE FREE STATION, ASKED FOR
     ==================================================================

     The transition table is in `dhPower.ts`; this holds the cursor and does the three things a table cannot:
     arm the board, forfeit the ability, and say so in the log.

     `abandon` IS THE GUARD THAT #817 EXISTS BECAUSE OF. A prompt that outlived its turn would be a modal
     over a board doing something else -- which is exactly 4c one layer up, and the reason it is wired to the
     same step change rather than left to be noticed. */
  /* ==================================================================
     DESIGN NOTE 849: `dhStationPrompt` IS RETIRED, AND SO IS ITS TABLE
     ==================================================================
     #818 held a three-state cursor -- asking / placing / null -- because the question and the placement were
     two moments of one modal with no other memory. `activePowerFlow` derives both from the power state
     itself: "asking" is `layDone && station === "pending"`, and "placing" is `homeStationPlacement !== null`,
     which is a fact the board already owns.
     THE RULES IT ENCODED ARE NOT LOST. `dhStationDeclineForfeits` distinguished "I chose not to" from "the
     turn moved on"; the modal now has no dismissal that could be mistaken for the second, because after the
     lay the only way out is the Forfeit button (#848). `abandon` guarded a prompt outliving its step, which
     the effect below still does for the request.
     DELETED RATHER THAN LEFT UNREAD, per #772: a state machine nobody consults is a second account of the
     truth, waiting to disagree with the first. */
  /* ==================================================================
     DESIGN NOTE 849a: THE CLOSE GUARD HAD TO WIDEN, AND #845 GOT IT WRONG
     ==================================================================
     It read `orSubPhase !== "Track"`. A D&H LAY ENDS THE TRACK STEP -- `layEndsTrackStep` is `!isBonusLay`
     and only the C&SL's lay is a bonus -- so that guard would have closed the modal at exactly the moment
     step two became live, which is the whole feature. #818's own condition was Track OR Tokens, for this
     reason, and that is what it is again. #817's rule is unchanged: the prompt still ends with its step. */
  useEffect(() => {
    if (orSubPhase !== "Track" && orSubPhase !== "Tokens") setPrivatePowerRequest(null);
  }, [orSubPhase]);

  /** Design note #818: whose token, and how many are left to spend.
   *
   *  FREE IS NOT COSTLESS -- #725: "free means no cash, not no token" -- so the modal names the supply the
   *  marker comes out of. A corporation down to its last one is choosing between Scranton and wherever else
   *  it wanted that marker, which is a real decision and not a formality.
   *  `null` rather than a guess when there is no corporation to read, which is #250's rule for a figure the
   *  room has not reported: an absent number is ignorance and must not read as zero. */
  const dhStationSupply = useMemo(() => {
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    if (!company) return { ticker: "This corporation", tokensLeft: null as number | null };
    return {
      ticker: company.ticker,
      tokensLeft: stationTokenSlots(company).filter((slot) => !slot.placed).length,
    };
  }, [gameState, actingProtocolId]);

  /* `handleAcceptDhStation` / `handleDeclineDhStation` are GONE (#849). The accept armed the same errand
     `armPrivateHexErrand` arms and the decline spent the ability; both are the flow modal's `onAct` and
     `onDecline` now, reaching the same two mechanisms without a second copy of either. */
  /* Design note #817: THE ERRAND ENDS WITH ITS STEP.
     REPORTED: "even once I skipped the Station Marker subphase into the Run Routes one, my cursor still
     showed the herald like a Place Station action, and indeed I was then able to place the station for free
     on the untiled F16 *in the middle* of Run Routes."
     Nothing tore the errand down, because nothing had ever been asked to. A tile errand belongs to Track and
     a station errand to Tokens; a home station belongs to no Operating Round step at all and survives, which
     is the distinction `errandSurvivesStep` exists to keep. */
  useEffect(() => {
    setHomeStationPlacement((armed) =>
      armed === null || errandSurvivesStep(armed, orSubPhase) ? armed : null,
    );
  }, [orSubPhase]);

  /** Design note #440: the single lit hex. Shaped exactly like
   *  `layTrackFocus`/`tokenTargetFocus` so it drops into the same `layFocus`
   *  prop -- one veil mechanism, three users, rather than a third way of
   *  dimming a board. */
  const homeStationFocus = useMemo(() => {
    if (!homeStationPlacement) return undefined;
    const only = new Set<string>([`${homeStationPlacement.q},${homeStationPlacement.r}`]);
    return {
      // `visible` and `highlighted` are the SAME single hex here, which is
      // the whole point: everything else on the board goes dark.
      visible: only,
      highlighted: only,
      glowColor: STATION_PLACEMENT_HIGHLIGHT_INK, // design note #561
      /* Design note #585: the ONLY focus that asks for slot rings. The
         ordinary Tokens step no longer draws them -- see the prop for why
         the trade favours the one placement a new player cannot guess at. */
      homeSlotGlow: true,
    };
  }, [homeStationPlacement]);

  /** The prompt's answer arms the map rather than placing anything; the placement is FREE and must not reach PlaceStationToken (#239/#440).
   *  See docs/ai_architecture/state_machine.md - App.tsx #416 */
  const handlePlaceHomeStation = useCallback(
    (companyId: number, q: number, r: number) => {
      setHomeStationPlacement({
        kind: "home-station",
        companyId,
        q,
        r,
        hexLabel:
          STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r)?.label ?? "its home hex",
        abilityKey: null,
        returnTab: activeMainTab,
      });
      setActiveMainTab("map");
      const ticker =
        gameState?.public_companies.find((entry) => entry.company_id === companyId)?.ticker ??
        `#${companyId}`;
      logInfo(
        "Home Station",
        `Click the lit hex on the Rail Map to place the ${ticker} home station.`,
      );
    },
    [gameState, activeMainTab, logInfo],
  );

  /** The board click STAGES the free placement; commitFreeStationPlacement runs when the ring is answered. Free, so not PlaceStationToken (#239).
   *  See docs/ai_architecture/canvas_rendering.md - App.tsx #454 */
  const handleStageFreeStation = useCallback(
    ({
      q,
      r,
      hexLabel,
      cityIndex,
      // Design note #858: which city the home is locked to here, from the same reader the ring uses.
      homeCityIndex,
      centroidX,
      centroidY,
      // Design note #516: the chosen city slot's own point.
      nodeX,
      nodeY,
    }: {
      q: number;
      r: number;
      hexLabel: string;
      cityIndex: number | null;
      homeCityIndex: number | null;
      centroidX: number;
      centroidY: number;
      /** Design note #516: the chosen city slot's centre, already through
       *  the board's live transform. Falls back to the centroid when the hex
       *  has no resolvable node. */
      nodeX: number;
      nodeY: number;
    }) => {
      const placement = homeStationPlacement;
      if (!placement) return;
      /* The veil already refuses every other hex (`layFocus.highlighted` is
         a one-element set), so this is a second lock on the same door --
         cheap, and the kind of guard that matters if the veil is ever
         loosened for a reason unrelated to this flow.
         Design note #817: AND THE OFF-HEX CLICK IS AN ANSWER NOW, not a silent `return`. Reported: "I have no
         clear way of escaping this action if I decide I don't want to do it." An optional power clicked away
         from is cancelled and the click goes on to be an ordinary one -- which is the escape the report found
         by accident and liked. A HOME station is compulsory and keeps its old behaviour of doing nothing,
         because the whole table is waiting on it (#783). */
      const intent = errandClickIntent(placement, q, r);
      if (intent === "ignore") return;
      if (intent === "cancel") {
        setHomeStationPlacement(null);
        return;
      }
      // Design note #444: a tile lay is not staged here. It falls through
      // to the tile picker and finishes in `handleConfirmRadialLay`.
      if (placement.kind === "private-tile") return;

      /* ==================================================================
         DESIGN NOTE 858: AND THE CITY, NOT ONLY THE HEX
         ==================================================================
         REPORTED: "for NNH's Home Station, the correct city is shown with the glow ring, but a player can
         select G19's other city and place the home station there."
         `errandClickIntent` above locks the HEX and always has. The city had no gate at all, so the pointer's
         answer went straight into the staged placement -- harmless on every one-city hex, which is why it
         lasted, and wrong on the one hex where the two questions differ.
         REFUSED WITH A SENTENCE rather than silently, because the player is looking at a ring on the OTHER
         circle and needs to be told which one (#619). */
      const cityRefusal = homeCityRefusal({
        clickedCityIndex: cityIndex,
        homeCityIndex,
        hexLabel: placement.hexLabel,
      });
      if (cityRefusal) {
        logInfoRef.current?.("Home Station", cityRefusal);
        return;
      }

      setPendingToken({
        q,
        r,
        hexLabel,
        cityIndex,
        // Design note #556: the corporation the player was prompted for.
        companyId: placement.companyId,
        kind: "free",
        /* Design note #516: the NODE, not the hex centre. On a dual-city
           home hex (ERIE's) or any OO tile the two are different points,
           and the ring belongs on the slot the token will occupy. */
        offsetX: nodeX,
        offsetY: nodeY,
      });
    },
    [homeStationPlacement],
  );

  /** What the confirmation ring runs for a free placement - never the paid PlaceStationToken message.
   *  See docs/ai_architecture/contract_economy.md - App.tsx #239 */
  const commitFreeStationPlacement = useCallback(
    ({ q, r, cityIndex }: { q: number; r: number; cityIndex: number | null }) => {
      const placement = homeStationPlacement;
      if (!placement) return;

      const ticker =
        gameState?.public_companies.find((e) => e.company_id === placement.companyId)?.ticker ??
        `#${placement.companyId}`;
      // Design note #550: through the log, so the token lands on every board.
      void runGameplayActionRef.current?.(
        placement.kind === "home-station"
          ? `${ticker} places its home station token on ${placement.hexLabel}.`
          : `${ticker} places a free station token on ${placement.hexLabel} using the Delaware & Hudson.`,
        {
          PlaceHomeStation: {
            company_id: placement.companyId,
            q,
            r,
            kind: placement.kind === "home-station" ? "home" : "dh",
            city_index: cityIndex, // design note #560
            hex_label: placement.hexLabel,
          },
        },
        { automatic: true },
      );
      if (placement.abilityKey) {
        setUsedPrivateAbilities((prev) => new Set(prev).add(placement.abilityKey as string));
      }
      /* Design note #849: the tick closes the question as well as the placement, and now does so by
         RECORDING the placement -- `usedPrivateAbilities` gains `dh-token` two lines up, which is what makes
         `activePowerFlow` report the step done. One fact, read; not a second cursor, written. */
      setHomeStationPlacement(null);
      // Back where they came from -- see the state's own note on why this
      // is captured rather than hardcoded to the Stocks tab.
      setActiveMainTab(placement.returnTab);
    },
    // Design note #550: `logInfo` went with the local write. The log line is
    // written by the replay handler now, on every client rather than only on
    // the one that clicked.
    [homeStationPlacement, gameState],
  );

  /* Design note #399: the prompt's answer. Grants the certificate AND sets
     the price in one reducer call, so the intermediate state -- presided
     over, unpriced -- never exists for a render to catch. */
  const handleConfirmBoPar = useCallback(
    (parValue: string) => {
      const winner = boParPrompt?.player;
      setBoParPrompt(null);
      if (!winner) return;

      /* Written OUTSIDE setSandboxState's updater: a state updater must be pure, and React may invoke it twice. #468 makes this belt-and-braces; #550 routes it through the log.
         See docs/ai_architecture/stock_market.md - App.tsx #461 */
      void runGameplayActionRef.current?.(
        `${sandboxPlayerLabel(winner) ?? truncateAddress(winner)} pars the B&O at $${parValue}.`,
        { SetBoPar: { player: winner, par_value: parValue } },
        /* `automatic`, because the auction's turn cursor has moved past the
           winner by the time the prompt is answered -- the turn gate would
           refuse the one player entitled to answer it. The prompt's own
           identity check (design note #543) is what guards this. */
        { automatic: true },
      );
    },
    [boParPrompt],
  );

  /* Design note #712: ONE DISPATCH, not a loop of them. The loop was inherited from the train multi-buy
     (#262), where it is correct because each train purchase really is a separate event that can advance the
     phase. A stock purchase advances the SEAT, so N of them is N turns. */
  const handleBuyShare = useCallback(
    (protocolId: number, source: "Ipo" | "Bank", quantity = 1) =>
      buyOneShare(protocolId, source, Math.max(1, Math.floor(quantity))),
    [buyOneShare],
  );

  /* Design note #712: THE ZONE RULES, RESOLVED WHERE THE BOARD IS. `sharePurchaseBlock` needs the private
     roster and the room's size for the certificate limit, and the panel is given neither -- so the answer is
     computed here and handed down as a question the card can ask with the source and quantity it has
     selected.
     `marketZoneForPrice` is injected for the reason #7 gives about `certificateBreakdown`: the price-to-zone
     table lives in `components/` and `utils/` may not import from it. */
  const purchaseBlockFor = useCallback(
    (companyId: number, source: "Ipo" | "Bank", quantity: number): string | null => {
      if (!gameState || !viewerAddress) return null;
      return sharePurchaseBlock({
        state: gameState,
        buyer: viewerAddress,
        companyId,
        source,
        quantity,
        zone: marketZoneForPrice(marketPriceForCompany(companyId)),
        marketPrices: Object.fromEntries(
          (marketGrid?.positions ?? []).map((entry) => [entry.company_id, Number(entry.price)]),
        ),
        zoneForPrice: marketZoneForPrice,
      });
    },
    [gameState, viewerAddress, marketGrid, marketPriceForCompany],
  );

  /* Design note #713: THE SALE'S TWO ANSWERS, resolved where the board and the chart both are.
     The successor rule reads every player's holdings and the price walk needs the token's CELL -- the Stock
     Round panel is handed neither, so both arrive as questions it can ask about the bundle it has selected. */
  const saleBlockFor = useCallback(
    (companyId: number, percentage: number): string | null => {
      if (!gameState || !viewerAddress) return null;
      return shareSaleBlock({ state: gameState, seller: viewerAddress, companyId, percentage });
    },
    [gameState, viewerAddress],
  );

  const salePriceAfter = useCallback(
    (companyId: number, certificates: number): number | null => {
      /* THE CELL, NOT THE PRICE. #434: "the chart repeats prices across rows, so a first-match search
         projected from the wrong box" -- the token's own coordinates are the only unambiguous starting
         point, and they are what `projectShareSaleMove` walks down from. */
      const cell = marketGrid?.positions.find((entry) => entry.company_id === companyId);
      if (!cell) return null;
      const landed = projectShareSaleMove({ x: cell.x, y: cell.y }, certificates);
      return landed ? landed.price : null;
    },
    [marketGrid],
  );

  /* ==================================================================
   *  DESIGN NOTE 717: AUTO-PASS
   * ==================================================================
   *
   * A standing instruction to pass, held HERE and never in the log: it is one viewer's preference about their
   * own client, not a move any other player replays. What reaches the log is the `PassTurn` it dispatches --
   * an ordinary turn, authored by this player, undoable, and indistinguishable afterwards from a pass they
   * clicked. The table should not be able to tell who was watching.
   *
   * ARMED PER STOCK ROUND, per the report: the arm carries the round it was made in and `autoPassDecision`
   * refuses on any other. */
  const [autoPassArm, setAutoPassArm] = useState<AutoPassArm | null>(null);
  /* Design note #728: the turn this arm has already passed for.
     THE EFFECT RE-RUNS ON EVERY `gameState` CHANGE, and `isMyTurn` is derived from React state while the
     reducer writes its ref synchronously (#670). So between dispatching a pass and React committing the seat
     advance there is a window where the effect can fire again and pass twice -- spending a turn the player
     never had. A ref rather than state because it must be readable and writable inside one effect run, before
     any re-render.
     Design note #816: THE LOG INDEX, not the seat. #728 keyed this on `${round}:${seat}` and claimed "a later
     turn in the same round is a different key" -- which is false, because a later turn in the same round is
     the same SEAT. See `autoPass.ts` #816 for the whole account; the short version is that auto-pass fired
     once per player per Stock Round and was silently guarded off every turn after. */
  const autoPassedAtLogIndexRef = useRef<number | null>(null);
  const [autoPassOpen, setAutoPassOpen] = useState(false);
  /** Remembered so re-arming next round does not re-ask from scratch. */
  const [autoPassChoices, setAutoPassChoices] = useState<AutoPassConditions>(
    DEFAULT_AUTO_PASS_CONDITIONS,
  );

  /* Design note #717: computed for the MODAL, so a player sees why Auto-Pass will not start before they click
     rather than watching it switch itself off a moment later. */
  const autoPassExposure = useMemo(
    () => (gameState && viewerAddress ? exposedPresidencies(gameState, viewerAddress) : []),
    [gameState, viewerAddress],
  );

  const handleArmAutoPass = useCallback(
    (conditions: AutoPassConditions) => {
      if (!gameState || !viewerAddress) return;
      setAutoPassChoices(conditions);
      autoPassedAtLogIndexRef.current = null;
      setAutoPassArm(armAutoPass(gameState, viewerAddress, conditions));
      setAutoPassOpen(false);
      logInfo("Auto-Pass", "Auto-Pass is on for this Stock Round.");
    },
    [gameState, viewerAddress, logInfo],
  );

  const handleDisarmAutoPass = useCallback(() => {
    setAutoPassArm(null);
    // Design note #728: a fresh arm may act on the very turn a previous one was disarmed in.
    autoPassedAtLogIndexRef.current = null;
    logInfo("Auto-Pass", "Auto-Pass is off.");
  }, [logInfo]);

  /* THE EFFECT THAT ACTS. Guarded four ways, and each guard is load-bearing:
       an arm exists          -- nothing to do otherwise
       it is a Stock Round    -- an Operating Round turn belongs to a corporation, not a player
       it is THIS player's    -- `isMyTurn` is the same predicate the turn gate uses
       the decision says pass -- and a "no" DISARMS, so the player keeps the turn it woke them for
     ONE DISPATCH PER TURN is enforced by the arm being cleared on a wake and by `isMyTurn` going false the
     moment the pass lands: the seat advances, the effect re-runs, and there is nothing to do. */
  /* ==================================================================
   *  DESIGN NOTE 1036: THE ARM IS CLEARED WHEN ITS ROUND ENDS
   * ==================================================================
   *
   * REQUESTED: "Ensure that a player's `autoPass` flag is automatically reset to `false` at the end of the
   * Stock Round so they do not accidentally auto-pass their first turn in the next Stock Round."
   *
   * THE SECOND HALF WAS ALREADY SAFE and the first was not. `autoPassDecision` refuses on any round but the
   * one the arm was made in (#717's `macroRoundNumber`), so a stale arm has never been able to pass a turn in
   * a later round -- it wakes the player and disarms instead. Nothing was ever auto-passed by accident.
   * WHAT SURVIVED WAS THE CLAIM. The acting effect below returns early outside a Stock Round, so the arm sat
   * there through the whole Operating Round with the button reading "Auto-Pass: On" -- and it kept reading it
   * into the next Stock Round until that player's first turn came round and the expiry fired. A control
   * announcing a setting that is no longer in force is the same fault as one that is missing, and #728 built
   * the always-visible disarm precisely so a player could trust what that button says.
   * CLEARED SILENTLY, WITHOUT `handleDisarmAutoPass`. That helper logs "Auto-Pass is off", which is right for
   * a player pressing the button and wrong here: the round ending is not a decision anybody made, and a line
   * in the Activity Log for every armed player at every round boundary is noise. The expiry sentence the
   * player will read if they re-arm and it lapses mid-round is unaffected. */
  useEffect(() => {
    if (!autoPassArm || !gameState) return;
    if (gameState.current_round_type === "StockRound") return;
    setAutoPassArm(null);
    autoPassedAtLogIndexRef.current = null;
  }, [autoPassArm, gameState]);

  useEffect(() => {
    if (!autoPassArm || !gameState || !viewerAddress) return;
    if (gameState.current_round_type !== "StockRound") return;
    if (autoPassArm.player !== viewerAddress) return;
    if (!isMyTurn) return;

    /* Design note #816: one dispatch per TURN, measured against the append-only log. Nothing has happened
       since this arm last acted means this is still that same turn; anything at all in the log means it is
       not. The seat index this used to key on cannot tell those apart, because a Stock Round gives every
       player the same seat index over and over. */
    const log = sandboxLogRef.current;
    const lastLogIndex = log.length > 0 ? log[log.length - 1].index : -1;
    if (autoPassAlreadyActed(autoPassedAtLogIndexRef.current, lastLogIndex)) return;

    /* Design note #759a: the debt is computed where the prices are, then handed in. */
    const decision = autoPassDecision(gameState, {
      ...autoPassArm,
      divestmentOwed: divestmentDebt({
        state: gameState,
        player: autoPassArm.player,
        marketPrices: sandboxMarketPrices,
        zoneForPrice: marketZoneForPrice,
      }).owed,
    });
    if (!decision.pass) {
      setAutoPassArm(null);
      /* SAID OUT LOUD, always. A turn that silently did not happen is the failure mode of every feature like
         this one, and the reason is the only thing that makes the interruption useful. */
      logInfo("Auto-Pass", `${decision.wakeReason} Auto-Pass is off.`);
      return;
    }
    autoPassedAtLogIndexRef.current = lastLogIndex;
    void handlePassTurn();
    // Design note #759a: the prices decide the debt, so a price move must re-run this.
  }, [autoPassArm, gameState, viewerAddress, isMyTurn, handlePassTurn, logInfo, sandboxMarketPrices]);

  const handleSellShares = useCallback(
    (protocolId: number, percentage: number) =>
      runGameplayAction(
        "SellStock",
        {
          SellStock: {
            game_id: gameId,
            protocol_id: protocolId,
            percentage,
          },
        },
      ),
    [runGameplayAction, gameId],
  );

  const handleRunTrains = useCallback(async () => {
    /* Design note #250: the same block on the dispatch path. Guarding only
       the builder would leave a route drafted before the last train was
       sold still declarable. */
    if (!ownsAnyTrain) {
      setRouteFeedback(NO_TRAIN_ROUTE_REASON);
      return;
    }

    /* One RunManualRoute per train, awaited in sequence. Invalid drafts are skipped, not refused - the good
       routes are not hostage to the bad one.
       See docs/ai_architecture/routing_pathfinding.md - App.tsx #275
       Design note #883: BOTH RULES LEFT. Which drafts may run, and -- when none may -- which of several true
       complaints the player is shown, were a filter and four ordered `if`s inside this callback. The ORDER
       was the part worth rescuing: it is a decision about what a player most needs to know, it was expressed
       only as source order, and nothing asserted it. */
    const runnable = runnableDrafts(trainDrafts);
    if (runnable.length === 0) {
      setRouteFeedback(runTrainsRefusal(trainDrafts));
      return;
    }

    /* Design note #777: `firstOfBatch` is gone with `resetRouteRevenue`. It flagged the message that was
       supposed to zero the running total, and the flag could never reach the reducer -- the log carries the
       message and nothing beside it, and every client applies by replaying. The turn change clears the
       figure now, which every client reaches from the log alone. */
    /* ==================================================================
        DESIGN NOTE 968: ONE MESSAGE FOR THE WHOLE TURN'S RUNNING
       ==================================================================
       REPORTED, from a live room: "B&O ran 3 trains. On a later turn, it ran 4 trains. In both cases, only 1
       train's revenue actually paid out."
       THIS LOOP WAS THE CAUSE, and it survived three batches of me looking at everything around it. Each
       iteration appended its own action at `appliedIndexRef.current` -- and the snapshot handler REASSIGNS
       that ref from the last action it can see, so a snapshot carrying only the first append rewinds the
       cursor while the second and third are still in flight. They land on an index already taken, and
       `effectiveActions` keys on `index`.
       #916 GUARDED THIS AND COULD NOT CLOSE IT. That note advanced the cursor optimistically so a burst would
       take successive slots, which is right until a snapshot lands mid-burst and moves it backwards. Every
       fix at this layer is a race against a listener the client does not control.
       SO THE BURST IS GONE RATHER THAN ORDERED. One action, one index, one document, one reducer transition:
       there is nothing left to interleave. The routes are gathered here, priced by the reducer in a single
       tick, and the die is rolled once on their sum -- which is what #941 already decided a turn's revenue
       was.
       THE POINTS ARE STILL MARKED PER ROUTE (#808), because that is a fact about each route's own path and
       the reducer prices what it is given. Gathering the dispatch does not gather the pricing. */
    /* ==================================================================
        DESIGN NOTE 1020: THE PAYLOAD READ A REF THAT LAGGED THE DRAFTS IT WAS BUILT FROM
       ==================================================================
       REPORTED: "A corporation ran a 5-train (for $200) and a D-train (for $440). The Dividends phase and
       Activity Log only processed a single $200 run."

       TWO SOURCES FOR ONE ANSWER, WHICH IS THIS PROJECT'S OLDEST BUG SHAPE. `runnable` is derived from
       `trainDrafts`, a `useMemo` over the `routeDrafts` STATE, so it is current at the instant of the click.
       The points beneath it came from `routeDraftsRef.current`, a mirror written by a `useEffect` -- one
       commit behind. A train whose route the memo can see and the ref cannot resolves to `[]`, is dropped by
       the two-point filter one line down, and never reaches the message at all. The board then pays for the
       routes that survived, which is a silent partial execution of exactly the kind #1019 has just finished
       removing from the train purchase.

       #275 GAVE THAT REF A REASON AND IT IS NOT THIS ONE. Its note: "read by the canvas click handler, which
       must see the CURRENT draft without being rebuilt on every click." That argument is about a callback the
       canvas holds across renders. `handleRunTrains` already lists `trainDrafts` in its dependencies, so it
       is rebuilt whenever a draft changes -- it can read the state directly and has no reason to consult a
       mirror of it. The ref stays for the handler it was built for.

       AND THE FILTER STAYS, because it is a different rule: a draft that passed `runnableDrafts` but resolves
       to fewer than two points is not a route, and the reducer would price an empty path at zero. What
       changes is that it can no longer be fed an empty path by a stale read. */
    /* Design note #1031: THE FLEET INDEX IS CARRIED THROUGH THE FILTER, not recovered after it. `turnRoutes`
       drops any draft that resolves to fewer than two points, so the surviving entries are NOT positionally
       aligned with `runnable` -- a route list of two built from a fleet of three cannot be re-joined to the
       fleet by position afterwards. Taking `trainIndex` along at the point where the draft is still in hand
       is the difference between a join that is exact and one that is a guess. */
    const turnRoutes = runnable
      .map((draft) => ({
        train: draft.model,
        trainIndex: draft.trainIndex,
        points: withForcedBypass(
          routeDrafts[draft.trainIndex] ?? [],
          mapGrid,
          blocksThroughCityRef.current,
        ),
      }))
      .filter((entry) => entry.points.length >= 2)
      .map((entry) => ({
        train: entry.train,
        trainIndex: entry.trainIndex,
        path: routePointsToWaypoints(entry.points),
      }));

    if (turnRoutes.length > 0) {
      await runGameplayAction("RunMultipleRoutes", {
        RunMultipleRoutes: {
          game_id: gameId,
          protocol_id: actingProtocolId,
          routes: turnRoutes.map((entry) => entry.path),
          /* ==================================================================
             DESIGN NOTE 1020: WHICH TRAIN RAN WHICH ROUTE, ON THE WIRE
             ==================================================================
             REPORTED, the other half: the log "incorrectly labeled it as the D-train's run".

             IT WAS NOT A MISLABEL SO MUCH AS A GUESS. `actionLog` had no way to know which train ran a given
             route, so it named the corporation's LARGEST OWNED train and attached that -- see its own note.
             With one route and a 5-train and a D-train in the fleet, the sentence necessarily said "with a
             D-train" whichever train had actually run.

             A PARALLEL ARRAY RATHER THAN A NEW ROUTE SHAPE, deliberately. Every action already in a saved log
             carries `routes` as an array of paths, and this game is rebuilt by replaying that log -- changing
             the element type would make every historical entry unreadable. `trains[i]` describes `routes[i]`,
             is optional, and #232's rule covers its absence: a log that does not say which train ran is a log
             that does not say, and the narration falls back to what it did before. */
          trains: turnRoutes.map((entry) => entry.train),
          // Design note #1031: the same list, identifying the FLEET SLOT rather than the model, so a
          // corporation with two 5-trains can still be told which one earned what.
          train_indices: turnRoutes.map((entry) => entry.trainIndex),
          /* ==================================================================
              DESIGN NOTE 1051: THE DIE IS ROLLED HERE, ONCE, AND THEN IT IS HISTORY
             ==================================================================
             THIS IS THE ONLY PLACE IN THE APP THAT DRAWS. The reducer cannot -- it replays on every client --
             and the old hash could not, which is why it was predictable. One dispatch, one draw, written into
             the message so every other client reads the number rather than computing one.
             AND IT IS NOT ALWAYS A DRAW. `seedAlreadyRolled` scans the RAW log, including the entries an undo
             has killed, for this turn's earlier roll. Found means the player has run, undone and come back:
             they get the face they already saw, which is the requirement this feature was specified with --
             "Undoing it should not change their roll, otherwise players would just slot machine their way to
             +20%." Absent means this turn has genuinely not rolled yet.
             `sandboxLogRef`, NOT the effective history. Every other reader in this file wants
             `effectiveActions` and would be wrong here: the entry being looked for is BY DEFINITION one an
             undo has struck out. See `turnSeed.ts` #1051 -- a tidy-up that "corrects" this to the effective
             log reinstates the slot machine and nothing fails. */
          revenue_seed: (() => {
            const key = turnSeedKey(
              gameState?.macro_round_number ?? 0,
              gameState?.sub_round_index ?? 0,
              actingProtocolId,
            );
            return seedAlreadyRolled(sandboxLogRef.current, key) ?? randomTurnSeed();
          })(),
          revenue_turn: turnSeedKey(
            gameState?.macro_round_number ?? 0,
            gameState?.sub_round_index ?? 0,
            actingProtocolId,
          ),
          // Withhold at Routes; the pay-or-withhold decision belongs to the very next step.
          // See docs/ai_architecture/routing_pathfinding.md - App.tsx #373
          payout_strategy: "Withhold",
        },
      });
    }

    /* ==================================================================
        DESIGN NOTE 917: THE DIVIDEND PAYS WHAT WAS BANKED, NOT WHAT WAS PLANNED
       ==================================================================
       REPORTED: "the Unpredictable Revenue variant is calculating the +/- modifier for the Activity Log, but
       the actual Dividends phase is still paying out based on the standard printed route value."
       AND #903 IS WHERE I INTRODUCED IT. The die is applied in the reducer, which writes the modified figure
       into `last_route_revenue` -- correct. This line then summed `draft.value`, the PLANNER's printed
       figure, and `dividendDeclaration` prefers a committed total over `last_route_revenue`. So the log said
       $84 and the treasury received $70, from two numbers that were both right about different questions.
       READ FROM THE REDUCER RATHER THAN RE-DERIVED. The obvious fix was to roll the die again here and sum
       the modified values, and that is the bug this project keeps finding: two implementations of one rule,
       one of which moves money (#775's exact words). The reducer has already accumulated the authoritative
       total across every train in this batch; this reads it.
       #492'S REASON SURVIVES INTACT. It exists so the Dividends step spends "the number the player watched
       being assembled" rather than a stale figure from a previous turn -- and `last_route_revenue` is no
       longer stale, because #777 made the turn change clear it. What is read here is this turn's running
       total, which is exactly what #492 wanted and could not safely have then.
       THE PLANNER SUM IS THE FALLBACK, for a build whose chain does not report the field at all (#232): an
       unmodified figure is wrong under the variant and right under standard rules, which is the better of the
       two ways to be wrong when the state cannot say. */
    /* ==================================================================
        DESIGN NOTE 934: THE TOTAL IS READ WHEN IT IS SPENT, NOT WHEN IT IS SENT
       ==================================================================
       REPORTED: "In OR 3.1, B&O ran three trains for $50 each (total $150) ... The Dividends phase only paid
       out $50 total, instead of $150."
       AND THIS READ IS WHERE THE OTHER $100 WENT. In a sandbox ROOM `runGameplayAction` APPENDS the action to
       the log and returns; the reducer runs later, from the snapshot. So the loop above appends three routes
       and this line then read `last_route_revenue` immediately -- catching however many snapshots happened to
       land during the three awaits. One had. It committed $50; the remaining two arrived and the field
       reached $150; and `dividendDeclaration` prefers a commitment over the field, so the commitment CAPPED
       the payout at a third of the run.
       #917 WAS RIGHT ABOUT THE AUTHORITY AND WRONG ABOUT THE CLOCK, which is worth stating plainly because I
       reported that note as the fix for this exact symptom. It moved the dividend off the planner's figure
       and onto the reducer's, correctly -- and the reducer does accumulate, verified across three sequential
       dispatches in `multiTrainRun.test.ts`. What it did not ask was whether the read happens before the
       writes arrive. In solo it does not; in a room it does.
       SO THE COMMITMENT GOES, RATHER THAN BEING RECONCILED WITH THE FIELD. The first fix I wrote took the
       larger of the two, which repaired the reported turn and quietly changed four unrelated cases --
       including #492's committed zero, which exists to stop a corporation declaring money for a run that did
       not happen. Two authorities reconciled by an arithmetic tiebreak is the shape this project keeps
       finding bugs in; the answer is for there to be one authority.
       AND #492'S REASON IS SPENT. It cached this figure because `last_route_revenue` was singular and kept
       only the last train's run -- both of which are fixed: the arm accumulates (#903), and #777 clears the
       field on the turn change so it can no longer carry a previous turn forward. The field is now exactly
       what #492 wanted and could not have then, and `declareDividendsChoice` reads it from render state at
       the moment the player actually declares -- by which time every snapshot for this turn has landed.
       WHAT STILL RECORDS THAT A RUN HAPPENED is `setRoutesRunThisTurn` on the next line, which is the half of
       #492 that is load-bearing: it is what keeps `skippedRoutes` from inferring a skip on a corporation that
       ran and earned nothing. The amount comes from the field; the fact of running comes from here. */
    /* Nothing to commit: the reducer owns the total and the Dividends step reads it when it spends it. */

    /* ==================================================================
        DESIGN NOTE 941: ONE ROLL, ONE FLASH, ONE SENTENCE -- HERE, BECAUSE HERE IS WHERE A TURN ENDS
       ==================================================================
       REPORTED: "a 4-train corporation forces the player to sit through 8 seconds of consecutive UI flashes
       (+10%, -20%, etc.), with no clear idea of which modifier applies to which train."
       #940 RAISED THE FLASH INSIDE `runGameplayAction`, which fires once per dispatched route. That was right
       when the die was per route and is the whole of the reported bug now that it is per turn. The loop above
       is the only code that knows a TURN of running has finished, so the turn-level narration belongs to it.
       THE PRINTED TOTAL COMES FROM THE DRAFTS, NOT FROM STATE, and that is deliberate after #934: a read of
       `last_route_revenue` here would race the snapshots in a sandbox room exactly as the committed total
       did. `runnable` is what this function just dispatched, priced by the same `sandboxRouteBreakdown` the
       reducer uses on the same `withForcedBypass` points (#808), so the two agree by construction rather than
       by coincidence.
       AND IT MOVES NO MONEY, which is what keeps this inside #917's rule. The reducer banks; this reacts. If
       the two ever disagreed the log would be wrong and the treasury right, which is the correct way round
       for a narration bug to fail. */
    /* ==================================================================
        DESIGN NOTE 1017: THE NARRATION MOVED OUT OF THE HANDLER, BECAUSE ONLY ONE BROWSER RUNS A HANDLER
       ==================================================================
       REPORTED: "Under the Unpredictable Revenue variant, the game modified a corporation's revenue but
       failed to print the flavor text in the Activity Log." And, diagnosing it mid-batch: "I think the
       variant texts may only be printing in the Activity Log for the local player who's the president."

       EXACTLY THAT, AND IT WAS NOT INTERMITTENT. `logInfo` appends to a LOCAL `actionLog` -- there is no
       shared feed to write to -- so a line is seen by whichever browser executed the code that raised it.
       Every other derived line in this app is raised inside `runGameplayAction`, which every seated client
       runs as it replays the action log; this one was raised HERE, in the Run Trains click handler, which
       only the acting president ever invokes. So the sentence existed in exactly one feed, and the report is
       what that looks like from any other seat.

       #941 PUT IT HERE FOR A GOOD REASON THAT HAS A BETTER ANSWER. Its argument was that "the loop above is
       the only code that knows a TURN of running has finished" -- true of the loop, and not true of the
       state. `DeclareDividends` is dispatched once, after running, by the same player, and it is on the wire:
       every client replays it, and at that moment `before` still carries the turn's final
       `printed_route_revenue` (it is cleared on the turn change, #941's own sibling reset). So the shared log
       has a marker for "this corporation has finished running" after all -- it is just a message rather than
       a loop.

       THE ROLL IS UNCHANGED AND CANNOT DRIFT. It is a pure function of `(macroRound, subRound, companyId)`
       and the banked printed total (#903's replay stability), so every client computes the same face from the
       same state. That is the property that makes deriving this legal at all -- a narration that had to be
       broadcast would be a second source for a fact already on the wire.

       THE FLASH GOES WITH IT, and #941's title is the reason: "ONE ROLL, ONE FLASH, ONE SENTENCE". Leaving
       the overlay in the handler would have fixed the log and split the pair -- the acting player seeing a
       flash at run time and reading the sentence a moment later at declare time, and everyone else seeing
       neither. It also lands where it is most useful: immediately before the dividend decision the modifier
       is about, rather than a step earlier. */
    // Design note #278: this corporation HAS run, so any revenue on it is
    // this turn's and the dividend choice is binding.
    setRoutesRunThisTurn({ protocolId: actingProtocolId, ran: true });

    // Optimistic advance to Dividends: running trains produces the figure that step decides about.
    // See docs/ai_architecture/state_machine.md - App.tsx #142
    setLiveOrSubPhase("Dividends");
    // Design note #808: `mapGrid` joins the deps because `withForcedBypass` reads the board -- whether a hex
    // offers a way round its centre is a fact about the tiles, and a stale grid here would dispatch a route
    // priced against a board that has since changed.
    /* Design note #1017: `gameState` and `logInfo` LEAVE the deps. #941 added them because the turn's seed and
       its sentence were read here; both moved to the dispatch path, so keeping them would rebuild this
       callback on every poll for a read it no longer makes. */
    /* Design note #1020: `routeDrafts` joins the deps because the payload reads it directly now. It is the
       state `trainDrafts` is already derived from, so this adds no rebuild the callback was not doing. */
  }, [runGameplayAction, gameId, trainDrafts, routeDrafts, actingProtocolId, ownsAnyTrain, mapGrid]);

  // revenue_amount reads the same field the panel renders, so the figure on screen and the figure in the message cannot differ. Read inside the callback for declaration order.
  // See docs/ai_architecture/routing_pathfinding.md - App.tsx #198
  const declareDividendsChoice = useCallback(
    (distribute: boolean, automatic = false) => {
      const corporation = gameState?.public_companies.find(
        (entry) => entry.company_id === actingProtocolId,
      );
      /* A skipped Routes step declares $0, not last turn's revenue; and it declares the same committed total the panel quotes (#492).
         See docs/ai_architecture/state_machine.md - App.tsx #484 */
      const revenue = dividendDeclaration({
        lastRouteRevenue: corporation?.last_route_revenue,
        skippedRoutes: skippedRoutesThisTurn,
        // Design note #934: the field is the only authority on the amount now.
        committedRevenue: null,
      }).revenue;
      runGameplayAction(
        distribute
          ? `DeclareDividends: Pay $${revenue}`
          : `DeclareDividends: Withhold $${revenue}`,
        {
          DeclareDividends: {
            game_id: gameId,
            protocol_id: actingProtocolId,
            revenue_amount: String(revenue),
            distribute,
          },
        },
        /* Design note #668: same reasoning as the sub-phase skip -- the flag is
           true only for `withholdRevenueAutomatically`, the forced $0 withhold
           the game declares on the player's behalf. Pay and Withhold are
           decisions and remain undoable. */
        { automatic, derived: automatic },
      );
      setLiveOrSubPhase("Hardware");
    },
    [runGameplayAction, gameId, actingProtocolId, gameState, skippedRoutesThisTurn],
  );
  /* All three take NO arguments, so an `onClick` handler's event object can
     never arrive where `distribute` or `automatic` is expected -- design
     note #439's hazard, avoided by construction rather than by care. */
  const handlePayDividends = useCallback(
    () => declareDividendsChoice(true),
    [declareDividendsChoice],
  );
  const handleWithholdRevenue = useCallback(
    () => declareDividendsChoice(false),
    [declareDividendsChoice],
  );
  /** The forced $0 withhold's entry point -- design note #439. */
  const withholdRevenueAutomatically = useCallback(
    () => declareDividendsChoice(false, true),
    [declareDividendsChoice],
  );

  /* BuyHardwareFromPool has no quantity field, so "buy 2" is two sequential messages - a tier purchase can advance the phase and rust trains. tier is for the log line only.
     See docs/ai_architecture/contract_economy.md - App.tsx #204 */
  const handleBuyTrainsFromBank = useCallback(
    async (tier: string, quantity: number) => {
      const times = Math.max(1, Math.floor(quantity));
      const before = depotInventory(gameState).find((row) => row.tier === tier);
      // Design note #1077: read BEFORE the loop, because by the summary the state has already moved.
      const beforeTreasury = gameState?.public_companies.find(
        (entry) => entry.company_id === actingProtocolId,
      )?.treasury;

      /* ==================================================================
          DESIGN NOTE 1077: ONE BUTTON PRESS, ONE LINE
         ==================================================================
         REPORTED: "In this example B&O used the selector to buy two trains at once. The Activity Log printed
         this one at a time. This is unnecessary ... So, if a player buys three trains one at a time, there
         should be three prints, but if they buy three trains at once, one print."
         AND THE THREE LINES CAME FROM A REAL CONSTRAINT PLUS ONE CHOICE. `BuyHardwareFromPool` carries no
         quantity (`TrainPurchasePanel` #1: "the quantity field is a convenience, not a batch"), so buying two
         genuinely IS two messages and the log wrote one line for each. #262 then added an aggregate summary
         ON TOP, which is the third line and the "Trains Bought —" prefix the report could not place.
         THE MESSAGES STAY TWO AND THE LINES BECOME ONE. Collapsing the dispatch would be a contract change
         for a display problem; suppressing the per-message entries and keeping the summary is the same board
         with a readable record. A SINGLE purchase is untouched -- it has no aggregate, so it keeps its own
         line, which is exactly the split the report asks for. */
      for (let i = 0; i < times; i += 1) {
        await runGameplayAction(
          times > 1
            ? `BuyHardwareFromPool: ${tier}-train (${i + 1} of ${times})`
            : `BuyHardwareFromPool: ${tier}-train`,
          { BuyHardwareFromPool: { game_id: gameId, protocol_id: actingProtocolId } },
          /* Design note #1077: silent only when there is a summary coming. The toast is NOT suppressed --
             it is one glance at a depot count and a batch of two should still produce it. */
          times > 1 ? { silentInLog: true } : undefined,
        );
      }

      /* #262 wrote this as a summary sitting ABOVE the per-message lines; #1077 suppressed those, so it is now
         the only line the buy produces. Still gated on `times > 1`: a single purchase has no aggregate and
         keeps its own entry.
         See docs/ai_architecture/state_machine.md - App.tsx #262 */
      if (times > 1 && before) {
        const ticker =
          gameState?.public_companies.find((entry) => entry.company_id === actingProtocolId)
            ?.ticker ?? `Corporation #${actingProtocolId}`;
        const remaining =
          before.remaining === null
            ? "unlimited"
            : `${Math.max(0, before.remaining - times)}/${before.total}`;
        /* Design note #1077: THE SUMMARY IS THE LINE NOW, so it says what the suppressed ones did -- the
           per-train price the report asked for ("for $80 each"), and the treasury transition every other
           action line carries since #1053. The `Trains Bought` category goes with them: with one line there
           is nothing to distinguish it from, and the stamp already files it under Buy Trains. */
        const treasuryBefore = beforeTreasury;
        const treasuryAfter = sandboxStateRef.current?.public_companies.find(
          (entry) => entry.company_id === actingProtocolId,
        )?.treasury;
        const movement =
          treasuryBefore !== undefined && treasuryAfter !== undefined && treasuryBefore !== treasuryAfter
            ? ` Treasury $${treasuryBefore} → $${treasuryAfter}.`
            : "";
        logInfo(
          `${ticker} bought ${countPhrase(times, `${tier}-train`)} for $${before.cost} each.` +
            `${movement} Remaining depot supply: ${remaining}.`,
          "",
        );
      }
    },
    [runGameplayAction, gameId, actingProtocolId, gameState, logInfo],
  );

  // Proposing dispatches nothing (#166). A president selling their own private into their own corporation settles immediately - one party means no prompt.
  // See docs/ai_architecture/contract_economy.md - App.tsx #206
  const handleProposePrivatePurchase = useCallback(
    (privateId: number, price: number) => {
      const target = gameState?.private_companies.find((p) => p.private_id === privateId);
      if (!target || !target.owner) return;
      const buyer = gameState?.public_companies.find(
        (c) => c.company_id === actingProtocolId,
      );
      const buyerTicker = buyer?.ticker ?? `#${actingProtocolId}`;
      const ownerLabel = sandboxPlayerLabel(target.owner) ?? truncateAddress(target.owner);
      /* Design note #715: nothing to dismiss. The sheet closed itself here when it was a modal; embedded, it
         leaves when the step does -- and the step advances on the purchase the way every other one does. */

      // The president of the buying corporation already owns it: one party,
      // nothing to negotiate, so the purchase completes outright.
      if (buyer?.president && buyer.president === target.owner) {
        runGameplayAction(`BuyPrivateCompany: ${target.name} @ $${price}`, {
          BuyPrivateCompany: {
            game_id: gameId,
            protocol_id: actingProtocolId,
            private_id: privateId,
            price: String(price),
          },
        });
        logInfo(
          "Buy Private Company",
          `${buyerTicker} bought ${target.name} from ${ownerLabel} for $${price} — its own President owned it, so it completed immediately.`,
        );
        return;
      }

      /* Design note #662: appended to the log so the OWNER sees it. This
         was a local `setPrivateProposal`, which is why the prompt only ever
         appeared on the buyer's screen. */
      runGameplayAction(`Offered $${price} for ${target.name}`, {
        ProposePrivatePurchase: {
          private_id: privateId,
          private_name: target.name,
          owner: target.owner,
          buyer_protocol_id: actingProtocolId,
          buyer_ticker: buyerTicker,
          price,
        },
      });
      /* The Activity Log line is written by the DRAIN now, from the message
         itself, so every client reads the same sentence. Writing it here as
         well would give the buyer two entries and the seller one. */
    },
    [gameState, logInfo, actingProtocolId, runGameplayAction, gameId],
  );

  /** The answer is a log entry, not a local dismissal: the drain clears the prompt on every client and dispatches the purchase on yes.
   *  See docs/ai_architecture/contract_economy.md - App.tsx #662 */
  const handleAcceptPrivateOffer = useCallback(() => {
    if (!privateProposal) return;
    runGameplayAction(
      `Accepted $${privateProposal.price} for ${privateProposal.privateName}`,
      { AnswerPrivatePurchase: { private_id: privateProposal.privateId, accept: true } },
      // Design note #701: the owner is answering, and the owner is not the player operating.
      { offTurn: true },
    );
  }, [privateProposal, runGameplayAction]);

  const handleRejectPrivateOffer = useCallback(() => {
    if (!privateProposal) return;
    runGameplayAction(
      `Declined $${privateProposal.price} for ${privateProposal.privateName}`,
      { AnswerPrivatePurchase: { private_id: privateProposal.privateId, accept: false } },
      { offTurn: true },
    );
  }, [privateProposal, runGameplayAction]);

  // Pre-Game Waterfall Auction Action Tray (`WaterfallAuctionDashboard.tsx`)
  // -- five real `ExecuteMsg` dispatches, `waterfall.rs`'s own five turn
  // actions exactly. `bid_amount`/`price` are stringified for the same
  // big-int-safety reason every other `Uint128` field in this file is.
  const handleWaterfallBuyLowest = useCallback(
    () => runGameplayAction("WaterfallBuyLowest", { WaterfallBuyLowest: { game_id: gameId } }),
    [runGameplayAction, gameId],
  );

  const handleWaterfallBidHigher = useCallback(
    (privateId: number, bidAmountVgp: number) =>
      runGameplayAction(`WaterfallBidHigher: private #${privateId} @ $${bidAmountVgp}`, {
        WaterfallBidHigher: {
          game_id: gameId,
          private_id: privateId,
          bid_amount: String(bidAmountVgp),
        },
      }),
    [runGameplayAction, gameId],
  );

  const handleWaterfallPass = useCallback(
    () => runGameplayAction("WaterfallPass", { WaterfallPass: { game_id: gameId } }),
    [runGameplayAction, gameId],
  );

  const handleWaterfallMiniAuctionRaise = useCallback(
    (bidAmountVgp: number) =>
      runGameplayAction(`WaterfallMiniAuctionRaise: $${bidAmountVgp}`, {
        WaterfallMiniAuctionRaise: { game_id: gameId, bid_amount: String(bidAmountVgp) },
      }),
    [runGameplayAction, gameId],
  );

  const handleWaterfallMiniAuctionPass = useCallback(
    () =>
      runGameplayAction("WaterfallMiniAuctionPass", {
        WaterfallMiniAuctionPass: { game_id: gameId },
      }),
    [runGameplayAction, gameId],
  );

  // A real mode toggle now, not a hint: turning it on disarms the tile picker and points the next board click at handleTokenHexClick.
  // See docs/ai_architecture/canvas_rendering.md - App.tsx #159
  /* ==================================================================
      DESIGN NOTE 1067: A CURSOR MODE IS NOT A GAME EVENT
     ==================================================================
     REPORTED: "The 'targeting mode' is not important and should not print on player-facing information, it's
     just clutter."
     AND IT WAS IN THE WRONG RECORD ENTIRELY. The Activity Log is the table's history of what HAPPENED --
     replayed identically on every client, scrolled back through to work out why a round closed when it did.
     "Targeting mode ON" is a fact about one player's cursor on one browser: it is not replayed, it did not
     change the board, and every other client saw it appear for no reason they could act on.
     THE HINT ITSELF IS NOT LOST. The button's own label and the map's targeting affordance both say the mode
     is armed, which is where a fact about the cursor belongs -- beside the cursor. */
  const handlePlaceStationTokenHint = useCallback(() => {
    setTokenTargetMode((current) => !current);
  }, []);

  /** A board click while token targeting is on. Takes the same
   *  `{ q, r, hexLabel, clientX, clientY }` info object `onHexClick` hands
   *  every consumer, so it drops into the same slot `handleRouteHexClick`
   *  already occupies. */
  const handleTokenHexClick = useCallback(
    ({
      q,
      r,
      hexLabel,
      cityIndex,
      centroidX,
      centroidY,
      // Design note #516: the chosen city slot's own point.
      nodeX,
      nodeY,
    }: {
      q: number;
      r: number;
      hexLabel: string;
      cityIndex: number | null;
      centroidX: number;
      centroidY: number;
      /** Design note #516: the chosen city slot's centre, already through
       *  the board's live transform. Falls back to the centroid when the hex
       *  has no resolvable node. */
      nodeX: number;
      nodeY: number;
    }) => {
      /* evaluateStationPlacement applies the same three refusals the contract does, before a signature, and returns the sentence explaining which bit.
         See docs/ai_architecture/canvas_rendering.md - App.tsx #238 */
      const placement = activeStationCompany
        ? evaluateStationPlacement({
            mapGrid,
            q,
            r,
            company: activeStationCompany,
            allCompanies: gameState?.public_companies ?? [],
            /* Design note #893: THE CIRCLE THE PLAYER CLICKED. This handler has had `cityIndex` since #453
               and the gate had nowhere to put it -- "a signature that can't express the question", and the
               reported OO bug is what that costs: reaching one city of D10 read as permission to token the
               other. `null` where the geometry cannot resolve a circle, which the gate treats as the
               hex-level question it always asked. */
            cityIndex,
          })
        : { allowed: isTokenableHex(mapGrid, q, r), reason: null };

      if (!placement.allowed) {
        setRouteFeedback(
          placement.reason ??
            `${hexLabel} has no city to place a token in. Pick a city hex, or lay a city tile there first.`,
        );
        return;
      }
      setRouteFeedback(null);
      // Stage, do not place, so a click on another city re-aims. #453: the node travels with the stage.
      // See docs/ai_architecture/canvas_rendering.md - App.tsx #201
      setPendingToken({
        q,
        r,
        hexLabel,
        cityIndex,
        /* Design note #556: `null` -- a paid Tokens-step placement really is
           the corporation on turn, and this is the one case where the
           operating cursor was the right answer all along. Written out
           rather than left optional so a third staging site has to decide. */
        companyId: null,
        kind: "paid",
        // Design note #516: the node's own point -- see the free placement.
        offsetX: nodeX,
        offsetY: nodeY,
      });
    },
    [mapGrid, activeStationCompany, gameState],
  );

  /** The green check. THIS is where the token is placed and the treasury
   *  charged -- design note #201. */
  const handleConfirmTokenPlacement = useCallback(() => {
    if (!pendingToken) return;
    const { q, r, cityIndex, kind } = pendingToken;
    setPendingToken(null);
    /* Design note #866: the standing request ends when the placement does. The board re-answers it on every
       view change, so a confirmed token that left the request set would immediately stage a second one. */
    setAutoStageStation(null);

    /* A free placement finishes through its own committer; PlaceStationToken would charge the escalating price.
       See docs/ai_architecture/contract_economy.md - App.tsx #239 */
    if (kind === "free") {
      // Design note #560: the slot travels with the placement.
      commitFreeStationPlacement({ q, r, cityIndex });
      return;
    }

    setTokenTargetMode(false);
    // A corporation places at most one token per turn, so the Tokens step
    // is done -- the same "the action completes the step" rule the tile
    // lay follows. Routes is next in `OPERATING_SUB_PHASE_ORDER`.
    setLiveOrSubPhase("Routes");
    runGameplayAction("PlaceStationToken", {
      PlaceStationToken: {
        game_id: gameId,
        protocol_id: actingProtocolId,
        q,
        r,
        /* Omitted when the geometry cannot resolve which city was clicked - the contract's documented default is a legal placement, a guessed 0 is not.
           See docs/ai_architecture/canvas_rendering.md - App.tsx #453 */
        ...(cityIndex === null ? {} : { city_index: cityIndex }),
      },
    });
  }, [pendingToken, gameId, runGameplayAction, actingProtocolId, commitFreeStationPlacement]);

  /** The red X. Discards the staging and leaves targeting armed, so the
   *  player is back where they were rather than having to re-open the mode.
   *
   *  Design note #818: AND FOR THE D&H'S FREE STATION, "back where they were" IS THE QUESTION. Requested:
   *  "if they click yes and then decide they don't want to, they click the X which takes them back to the
   *  modal where they can decline the power." Cancelling a PLACEMENT is not declining a POWER -- the X keeps
   *  meaning what it means everywhere else in this app, and the forfeit stays behind a button that says so. */
  /* Design note #866: the board's answer, turned into a staged placement.
     `useCallback` IS LOAD-BEARING HERE, not hygiene. This is a dependency of the board's reporting effect,
     so an inline arrow would change identity every render, re-run the effect, set state, and render again --
     a render loop rather than a stale closure. The deps are the two figures a placement carries. */
  const handleAutoStageStation = useCallback(
    (info: {
      q: number;
      r: number;
      hexLabel: string;
      boardLabel: string | null;
      cityIndex: number | null;
      nodeX: number;
      nodeY: number;
    }) => {
      /* TWO CITIES IS A REAL CHOICE AND MUST BE ASKED. #858 is the report that established it -- "a player
         can select G19's other city and place the home station there" -- and auto-staging one of two would
         be that bug with no click to blame. F16 has one city today; this is what happens if it ever does
         not, rather than a comment promising it never will. */
      if (info.cityIndex === null) {
        setAutoStageStation(null);
        armPrivateHexErrand(DH_PRIVATE_ID, "dh-token", "Place Station Token for $0 (F16)");
        return;
      }
      /* ==================================================================
         DESIGN NOTE 891: THE STAGED PLACEMENT NEEDED A PLACEMENT TO BELONG TO
         ==================================================================
         REPORTED: "when they click the modal to place the free station token and then click the green
         checkmark to confirm its placement, it returns them to the modal prompting them to place the free
         station token, in a loop they can only escape by forfeiting."
         `handleConfirmTokenPlacement` SENDS A FREE PLACEMENT TO `commitFreeStationPlacement`, whose first two
         lines are `const placement = homeStationPlacement; if (!placement) return;`. #866 built this
         auto-stage path to remove a click -- correctly, and it set `pendingToken` ALONE. So the tick called
         the committer, the committer found no placement in flight, and returned having done nothing: no
         `PlaceHomeStation` dispatched, and no `usedPrivateAbilities` entry.
         THAT SECOND OMISSION IS THE LOOP. `activePowerFlow` derives the D&H's standing obligation from
         `usedPrivateAbilities.has("dh-token")` (#849) -- an unresolved station raises the modal on every
         frame whether or not anybody asked. Nothing was ever recorded, so the obligation never ended and the
         only exit was the forfeit button, which is exactly what the report describes.
         A PROXY THAT STOPPED STANDING FOR ITS SUBJECT. `homeStationPlacement` means "a placement is in
         flight, and here is whose and which ability it spends"; #866 introduced a way to have a placement in
         flight without one. Setting it here is what makes the tick reach the committer with something to
         commit -- not a second cursor, the same one every other placement path already sets (#845). */
      setHomeStationPlacement({
        kind: "private-station",
        companyId: actingProtocolId,
        q: info.q,
        r: info.r,
        hexLabel: info.hexLabel,
        abilityKey: "dh-token",
        returnTab: "map",
      });
      setPendingToken({
        q: info.q,
        r: info.r,
        hexLabel: info.hexLabel,
        cityIndex: info.cityIndex,
        companyId: actingProtocolId,
        kind: "free",
        offsetX: info.nodeX,
        offsetY: info.nodeY,
      });
    },
    [actingProtocolId, armPrivateHexErrand],
  );

  const handleCancelTokenPlacement = useCallback(() => {
    /* Design note #818/#849: cancelling a PLACEMENT is not declining a POWER. Clearing the errand as well
       returns the player to the modal, where the forfeit is a button that says what it does -- so the X on
       the confirmation ring keeps the single meaning it has everywhere else in this app.
       Design note #866: AND THE STANDING REQUEST, or the X would not work. Asked for explicitly: "we need to
       make sure clicking X returns players to the modal where they click 'Forfeit' for the station
       placement." `autoStageStation` is a request the board answers on every view change (so the ring
       follows a pan); leaving it set would re-stage the token on the very next frame and the X would look
       broken. Clearing it is what lets `activePowerFlow`'s standing obligation raise the modal again --
       which is #818's mechanism, unchanged, reached through one more piece of state. */
    setPendingToken(null);
    setHomeStationPlacement(null);
    setAutoStageStation(null);
  }, []);

  // A staged placement must not outlive the mode that produced it -- the
  // same hazard design note #33 documents for the route toggle. Cleared
  // whenever targeting ends by any route (the Cancel banner, the sub-phase
  // advancing, the token being placed).
  useEffect(() => {
    if (!tokenTargetMode) setPendingToken(null);
  }, [tokenTargetMode]);

  // Leaving the Tokens step with targeting still on would leave the board
  // silently rewired -- the same hazard design note #33 documents for the
  // route toggle, and it is fixed the same way: the mode cannot outlive the
  // phase that offers it.
  useEffect(() => {
    if (orSubPhase !== "Tokens" && tokenTargetMode) setTokenTargetMode(false);
  }, [orSubPhase, tokenTargetMode, actingProtocolId]);

  // One real AdvanceOperatingSubPhase replaces three client-only skips; the chain owns the cursor. #179: in sandbox the reducer moves it. #439: two named callbacks so a MouseEvent cannot mark a manual skip automatic.
  // See docs/ai_architecture/state_machine.md - App.tsx #144
  /* ==================================================================
      DESIGN NOTE 1070: A SKIPPED STEP SAYS WHY IT WAS SKIPPED
     ==================================================================
     REPORTED of a trainless corporation: "'[OR 1.1--Run Routes] PRR passed.' This is maybe technically
     accurate, but for player-facing information it would be useful to state why."
     AND THE REASON WAS ALREADY COMPUTED, one screen away. `autoSkipReason` is what decides the step gets
     skipped at all -- "it owns no trains, so there is no route to run" -- and #1057 deleted the line that
     used to print it, on the rule that a step where nothing happened earns no line. That rule still holds:
     this is not a second line, it is the one line saying more.
     PASSED AT THE DISPATCH RATHER THAN READ FROM STATE, because the reason is a fact about the SHELL's
     verdict, not about the board -- a replaying client has no `autoSkipReason` of its own, so deriving it
     downstream would give the acting browser a sentence and everybody else a shorter one. */
  const skipSubPhase = useCallback((automatic: boolean, reason?: string | null) => {
    /* Design note #278: skipping Routes is the observation that makes a
       stale `last_route_revenue` harmless -- whatever the field says, this
       corporation did not run this turn, so there is nothing to allocate
       and Skip stays available on the Dividends step that follows. */
    if (orSubPhase === "Routes") {
      setRoutesRunThisTurn({ protocolId: actingProtocolId, ran: false });
    }
    runGameplayAction(
      "AdvanceOperatingSubPhase",
      {
        AdvanceOperatingSubPhase: {
          game_id: gameId,
          protocol_id: actingProtocolId,
        },
      },
      /* Design note #668: `derived` tracks `automatic` HERE, because here the
         two questions have the same answer -- #439's split entry points mean
         this flag is true only when the auto-skip effect called it. The Skip
         button passes `false` and stays undoable. */
      // Design note #1070: the shell's own verdict, carried so every client prints the same sentence.
      { automatic, derived: automatic, skipReason: reason ?? null },
    );
    if (!sandbox) return;
    setLiveOrSubPhase((current) => {
      // Design note #385: the same filtered list the strip renders, so Skip
      // walks past a hidden `Buy Private` rather than stopping on it.
      const steps = visibleSubPhases(
        gameState?.current_global_era,
        gameState?.private_companies,
        // Design note #613: same three inputs the strip renders from.
        currentPhase?.known ? currentPhase.tier : null,
      );
      const at = steps.indexOf(current);
      // Past the last step the turn is over, so hold rather than wrapping
      // back to Track -- wrapping would let a corporation lay a second tile.
      if (at < 0 || at >= steps.length - 1) return current;
      return steps[at + 1];
    });
  }, [runGameplayAction, gameId, actingProtocolId, sandbox, gameState, orSubPhase, currentPhase?.known, currentPhase?.tier]);

  /** The Skip button. Safe to pass straight to `onClick` -- it takes no
   *  arguments, so an event object cannot be mistaken for a flag. */
  const handleSkipSubPhase = useCallback(() => skipSubPhase(false), [skipSubPhase]);
  /** The auto-skip effect's entry point -- design note #439. */
  const skipSubPhaseAutomatically = useCallback(
    (reason?: string | null) => skipSubPhase(true, reason),
    [skipSubPhase],
  );

  /* Design note #876: the automatic twin of End Turn, and the same `{ automatic, derived }` pair the skip
     above carries -- #439's split entry points, so Undo rewinds past a turn the game ended on the player's
     behalf rather than stopping at it. `PassTurn` is what End Turn dispatches; this is that dispatch without
     the tutorial navigation, which belongs to a button somebody pressed. */
  const endTurnAutomatically = useCallback(
    () =>
      runGameplayAction("PassTurn", { PassTurn: { game_id: gameId } }, { automatic: true, derived: true }),
    [runGameplayAction, gameId],
  );

  // Audit G-15. Each refreshes the offer list on completion: the whole point
  // of these four is that they change what BOTH players can do next, and the
  // poll interval is too slow for an action the player just took themselves.
  const handleMakeTrainOffer = useCallback(
    (input: { sellerProtocolId: number; modelType: string; price: string }) => {
      runGameplayAction("BuyTrainFromCorporation", {
        BuyTrainFromCorporation: {
          game_id: gameId,
          buyer_protocol_id: actingProtocolId,
          seller_protocol_id: input.sellerProtocolId,
          model_type: input.modelType,
          price: input.price,
        },
      });
      refreshTrainOffers();
    },
    [runGameplayAction, gameId, refreshTrainOffers, actingProtocolId],
  );

  /** The consent fork is decided here because only this file knows the deployment: same president settles, different presidents ask (on chain online, locally in sandbox).
   *  See docs/ai_architecture/session_keys_wallet.md - App.tsx #414 */
  const handleProposeTrainTrade = useCallback(
    (proposal: TrainTradeProposal) => {
      const buyer = gameState?.public_companies.find(
        (entry) => entry.company_id === proposal.buyerProtocolId,
      );
      const samePresident =
        !!buyer?.president && buyer.president === proposal.sellerPresident;

      if (samePresident || !sandbox) {
        handleMakeTrainOffer({
          sellerProtocolId: proposal.sellerProtocolId,
          modelType: proposal.modelType,
          price: proposal.price,
        });
        logInfo(
          "Train Trade",
          samePresident
            ? `${proposal.buyerTicker} bought a ${proposal.modelType}-train from ${proposal.sellerTicker} for $${proposal.price} — same President, so it completed immediately.`
            : `${proposal.buyerTicker} offered $${proposal.price} to ${proposal.sellerTicker} for a ${proposal.modelType}-train. Awaiting ${proposal.sellerPresidentLabel}.`,
        );
        return;
      }

      /* Design note #701: appended to the log so the SELLER sees it. This was a local
         `setSandboxTrainProposal`, which is why the prompt only ever appeared on the buyer's screen.
         The Activity Log line is written by the DRAIN now, from the message itself, so every client reads the
         same sentence -- writing it here as well would give the buyer two entries and the seller one. */
      runGameplayAction(
        `Offered $${proposal.price} for a ${proposal.modelType}-train`,
        {
          ProposeTrainPurchase: {
            seller_protocol_id: proposal.sellerProtocolId,
            seller_ticker: proposal.sellerTicker,
            seller_president: proposal.sellerPresident,
            buyer_protocol_id: proposal.buyerProtocolId,
            buyer_ticker: proposal.buyerTicker,
            model_type: proposal.modelType,
            price: proposal.price,
          },
        },
      );
    },
    [gameState, sandbox, handleMakeTrainOffer, logInfo, runGameplayAction],
  );

  /** The answer is a log entry, not a local dismissal: the drain clears the prompt on every client and
   *  dispatches the purchase on yes.
   *
   *  Design note #701: this used to call `BuyTrainFromCorporation` straight from the buyer's client and clear
   *  its own `useState`. The dispatch was right and its AUTHOR was wrong -- the seller had never seen the
   *  offer, so "accepted" meant the buyer had agreed with themselves. The transfer still goes through the
   *  ordinary purchase message; it is now the drain that sends it, once the seller has answered. */
  const handleAcceptSandboxTrainOffer = useCallback(() => {
    if (!sandboxTrainProposal) return;
    runGameplayAction(
      `Accepted $${sandboxTrainProposal.price} for a ${sandboxTrainProposal.modelType}-train`,
      {
        AnswerTrainPurchase: {
          seller_protocol_id: sandboxTrainProposal.sellerProtocolId,
          accept: true,
        },
      },
      // Design note #701: the seller president answers, and it is the buyer who is on turn.
      { offTurn: true },
    );
  }, [sandboxTrainProposal, runGameplayAction]);

  const handleRejectSandboxTrainOffer = useCallback(() => {
    if (!sandboxTrainProposal) return;
    runGameplayAction(
      `Declined $${sandboxTrainProposal.price} for a ${sandboxTrainProposal.modelType}-train`,
      {
        AnswerTrainPurchase: {
          seller_protocol_id: sandboxTrainProposal.sellerProtocolId,
          accept: false,
        },
      },
      { offTurn: true },
    );
  }, [sandboxTrainProposal, runGameplayAction]);

  const handleAcceptTrainOffer = useCallback(
    (offerId: number) => {
      runGameplayAction("AcceptTrainOffer", {
        AcceptTrainOffer: { game_id: gameId, offer_id: offerId },
      });
      refreshTrainOffers();
    },
    [runGameplayAction, gameId, refreshTrainOffers],
  );

  const handleRejectTrainOffer = useCallback(
    (offerId: number) => {
      runGameplayAction("RejectTrainOffer", {
        RejectTrainOffer: { game_id: gameId, offer_id: offerId },
      });
      refreshTrainOffers();
    },
    [runGameplayAction, gameId, refreshTrainOffers],
  );

  const handleRescindTrainOffer = useCallback(
    (offerId: number) => {
      runGameplayAction("RescindTrainOffer", {
        RescindTrainOffer: { game_id: gameId, offer_id: offerId },
      });
      refreshTrainOffers();
    },
    [runGameplayAction, gameId, refreshTrainOffers],
  );

  /* A pending offer addressed to you should interrupt: the same prompt is derived from GetTrainOffers online. One at a time (#233 scopes the ledger to offers this viewer is party to).
     See docs/ai_architecture/session_keys_wallet.md - App.tsx #218 */
  const viewerTrainOffers = useMemo(() => {
    if (sandbox) return trainOffers;
    if (!viewerAddress) return [];
    return trainOffers.filter(
      (offer) =>
        offer.seller_president === viewerAddress || offer.buyer_president === viewerAddress,
    );
  }, [sandbox, viewerAddress, trainOffers]);

  const liveTrainOffer = useMemo(() => {
    if (sandbox || !viewerAddress) return null;
    const offer = trainOffers.find((entry) => entry.seller_president === viewerAddress);
    if (!offer) return null;
    const tickerFor = (id: number) =>
      gameState?.public_companies.find((company) => company.company_id === id)?.ticker ?? `#${id}`;
    const proposal: TrainTradeProposal = {
      sellerProtocolId: offer.seller_protocol_id,
      sellerTicker: tickerFor(offer.seller_protocol_id),
      sellerPresident: offer.seller_president,
      sellerPresidentLabel:
        sandboxPlayerLabel(offer.seller_president ?? "") ??
        truncateAddress(offer.seller_president ?? ""),
      buyerProtocolId: offer.buyer_protocol_id,
      buyerTicker: tickerFor(offer.buyer_protocol_id),
      modelType: offer.model_type,
      price: offer.price,
    };
    return { offerId: offer.offer_id, proposal };
  }, [sandbox, viewerAddress, trainOffers, gameState]);

  const handleAcceptLiveTrainOffer = useCallback(() => {
    if (!liveTrainOffer) return;
    handleAcceptTrainOffer(liveTrainOffer.offerId);
  }, [liveTrainOffer, handleAcceptTrainOffer]);

  const handleRejectLiveTrainOffer = useCallback(() => {
    if (!liveTrainOffer) return;
    handleRejectTrainOffer(liveTrainOffer.offerId);
  }, [liveTrainOffer, handleRejectTrainOffer]);



  /* A step with no decision in it skips itself - dispatched, not hidden, because the contract's cursor still walks it. Keyed on the corporation as well as the step.
     See docs/ai_architecture/state_machine.md - App.tsx #249 */
  const atTrainLimitNow = useMemo(() => {
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    const owned = company?.owned_trains?.length;
    // `undefined` means the chain does not report ownership. Skipping a step
    // on a guess would take the player's turn away from them, so an unknown
    // fleet is never treated as full.
    if (owned === undefined) return false;
    /* Design note #703: through the shared rule, not a second `>=`. This gate and the Buy Trains panel answer
       the same question -- is this corporation train-locked -- and they DISAGREED: the auto-skip read the
       CURRENT phase (correctly) while the panel enforced against the tier being bought, so a corporation the
       skip let through was refused by the panel it was sent to. One expression now, in `trainLimit.ts`. */
    /* Design note #1034: THE COUNTABLE FLEET, so this gate and `trainPurchaseRefusal` still answer with one
       number. #703's whole point was that these two disagreed; letting only the panel learn the exemption
       would reproduce that with the sides swapped -- the skip sending a corporation past Buy Trains that the
       panel would happily have served. */
    return isTrainLocked(
      countableTrainCount(
        company?.owned_trains,
        company?.pending_rust_trains,
        // Design note #1046: and the Yellow Sign's gift, which is exempt until the round ends.
        company?.ghost_trains,
      ),
      depot.find((tier) => tier.isCurrent)?.trainLimit ?? null,
    );
  }, [gameState, actingProtocolId, depot]);

  /* Owning a train is necessary and not sufficient. The probe is assignRouteSet, the same search Auto Route runs; null means "could not tell", never zero.
     See docs/ai_architecture/state_machine.md - App.tsx #414 */
  const maxRouteRevenue = useMemo<number | null>(() => {
    if ((gameState?.current_round_type ?? null) !== "OperatingRound") return null;
    if (orSubPhase !== "Routes" && orSubPhase !== "Dividends") return null;
    if (!ownsAnyTrain) return null;

    const corporation = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    /* ==============================================================
     *  DESIGN NOTE 484a: NO TOKEN IS A FACT, NOT AN ABSENCE OF ONE
     * ============================================================== */
    if (!corporation) return null; // the chain has not answered at all.
    /* Design note #852: TOKENS, NOT HEXES. `station_token_hexes` drops the city index, and on New York that
       is the difference between NNH's own city and the disconnected one beside it. `stationTokensOf` is the
       same reader the network walk uses (#686), so the router and the veil agree about where a route may
       begin. */
    const startHexes = stationTokensOf(corporation);
    if (startHexes.length === 0) {
      /* A corporation the chain reported with an empty token list has nowhere to start: that is the answer, not ignorance. Absent from the response stays null.
         See docs/ai_architecture/state_machine.md - App.tsx #414 */
      return corporation.station_token_hexes ? 0 : null;
    }

    const result = assignRouteSet({
      // Design note #730: a tokened-out city is a terminus, so no drafted route runs past one.
      blocksThrough: blocksThroughCityRef.current,
      mapGrid,
      era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
      startHexes,
      trains: ownedTrainRoster.map((train) => ({
        trainIndex: train.trainIndex,
        /* Design note #881: THE SIXTH SITE, and the audit missed it -- the harness's own "no bare 999 / no
           `?? 4`" assertion is what turned it up, which is the whole argument for asserting an absence
           across the file rather than checking the call sites you happen to have found. */
        maxRevenueCentres: reachForDrafting(train.maxDistance),
      })),
    });
    return result.totalRevenue;
  }, [
    gameState,
    orSubPhase,
    ownsAnyTrain,
    actingProtocolId,
    mapGrid,
    currentPhase,
    ownedTrainRoster,
  ]);

  /** Design note #414: whether this corporation can earn anything at all
   *  this turn. Owning no train and owning a stranded one are different
   *  facts with the same consequence, so they are answered together and the
   *  reason string keeps them distinguishable to the player. */
  /* Design note #1018: THREE STATES, and the shell only acts on one of them. This was
     `!ownsAnyTrain || maxRouteRevenue === 0`, which read a zero that could mean "the board has not loaded"
     as a zero that means "there is nothing to run" -- and the auto-skip's per-turn guard then made that
     answer permanent. See `earnableRevenue.ts` for the reported symptom and the arithmetic. */
  const earnableVerdict = useMemo(() => {
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    return earnableRevenueVerdict({
      ownedTrains: company?.owned_trains,
      stationTokenCount: company?.station_token_hexes?.length,
      mapGrid,
      /* Lazy: three of the guards inside settle the question without a pathfinder run, and this one is the
         expensive part of every render on the Routes step. */
      searchRevenue: () => maxRouteRevenue,
    });
  }, [gameState, actingProtocolId, mapGrid, maxRouteRevenue]);

  /** The reason this corporation cannot earn, or `null` -- where `null` now covers BOTH "it can" and "we
   *  cannot yet say". Every consumer of this value dispatches something, so the two collapse safely here and
   *  are kept apart in `earnableVerdict` for anything that needs to tell them apart. */
  const noEarnableRevenue = useMemo<string | null>(
    () => skipReasonFor(earnableVerdict),
    [earnableVerdict],
  );

  /* Blocking conditions in the order a player would discover them; the topological check reuses placeableStationHexes so it cannot disagree with the veil.
     See docs/ai_architecture/state_machine.md - App.tsx #438 */
  const stationPlacementBlock = useMemo<string | null>(() => {
    if ((gameState?.current_round_type ?? null) !== "OperatingRound") return null;
    if (orSubPhase !== "Tokens") return null;
    /* The rule lives in utils/stationTokens.ts, beside the two functions it consults.
       See docs/ai_architecture/state_machine.md - App.tsx #438 */
    return stationPlacementBlockReason({
      mapGrid,
      company: activeStationCompany,
      allCompanies: gameState?.public_companies ?? [],
      boardHexes: STATIC_BOARD_HEXES.map((hex) => [hex.q, hex.r] as const),
      /* Design note #781: the D&H's free, unconnected station, which every arm of that predicate was blind
         to -- so a corporation whose only placement WAS the D&H's got auto-skipped past the step and never
         reached the control. `dhPower` is declared far above this (line ~1513), so no dead zone: #762's
         lesson, checked rather than assumed.
         SCOPED TO THE OWNING CORPORATION, read from the roster here rather than trusted from the power
         state: `dhPowerState` knows whether the ABILITY is spent, not whose it is, and a rival mid-turn must
         not have its Tokens step held open by somebody else's private. */
      extraTokenAvailable:
        dhPower.tokenAvailable &&
        (gameState?.private_companies?.find((entry) => entry.private_id === DH_PRIVATE_ID)
          ?.owner_protocol_id ?? null) === actingProtocolId,
    });
  }, [gameState, orSubPhase, activeStationCompany, mapGrid, dhPower, actingProtocolId]);

  /** The re-entrancy guard is per TURN, not per game: macro_round_number + sub_round_index + active_corporation_index, built in utils/turnGuardKey.ts.
   *  See docs/ai_architecture/state_machine.md - App.tsx #653 */
  const turnIdentity = useMemo(
    () => ({
      macro_round_number: gameState?.macro_round_number ?? null,
      sub_round_index: gameState?.sub_round_index ?? null,
      active_corporation_index: gameState?.active_corporation_index ?? null,
    }),
    [
      gameState?.macro_round_number,
      gameState?.sub_round_index,
      gameState?.active_corporation_index,
    ],
  );

  /* ==================================================================
      DESIGN NOTE 896: WHICH LOSS THIS CORPORATION HAS NOT BEEN TOLD ABOUT
     ==================================================================
     NOT GATED ON THE OPENING SUB-PHASE, which the first draft did and which was wrong. "The absolute start of
     their turn" reads like `orSubPhase === openingSubPhase(state)`, but this app AUTO-SKIPS steps -- #414 and
     #438 skip Routes and Tokens outright -- so a corporation whose trains all rusted can be moved off the
     opening step before this ever renders, and the notice would be lost precisely in the case it matters most.
     Asking only "is it this corporation's turn, and is there something unsaid" fires on the first render of
     the turn whatever step that turn opens on, which is what the request actually wants.
     SILENCE IS READ HERE rather than watched, and the memo does not depend on the store. That is deliberate:
     the modal writes a toggle through immediately, and a memo that re-ran on that write would close the modal
     under the player's cursor. It recomputes when the QUEUE changes -- which is on acknowledgement -- and that
     is exactly when the next notice's toggle needs a fresh read. */
  const dueFleetNotice = useMemo<FleetLossNotice | null>(() => {
    if ((gameState?.current_round_type ?? null) !== "OperatingRound") return null;
    if (spectator) return null;
    /* ==================================================================
        DESIGN NOTE 1049a: THE PAYOUT IS READ FIRST, AND THIS IS WHERE THAT IS ENFORCED
       ==================================================================
       BOTH MODALS CAN COME DUE ON ONE DISPATCH. The private payout fires when an Operating Round opens; a
       fleet-loss notice fires at the acting corporation's turn, and the first corporation is already acting
       at that moment. From Phase 4 on -- which is the first phase with rust in it -- that collision is
       ordinary rather than exotic.
       THE COST WAS ACCEPTED, WITH A CONDITION IMPLIED BY HOW IT WAS PUT: "they might then get hit with two
       modals in a row on one OR ... two modals carrying meaningful information does not seem so
       overwhelming, and one is for players, the other is for the corporation." IN A ROW is the operative
       phrase, and it is the thing #1047 was right to worry about -- an undifferentiated stack trains a player
       to click through, and the fleet-loss modal is the one where clicking through costs a turn.
       SO IT IS A SEQUENCE, NOT A STACK, and the order is the physical one: everybody collects their private
       income, and then the first corporation acts. Withholding the notice while the payout is open is enough
       to produce that -- the queue is untouched, `dismissedFleetNoticesRef` is untouched, and the memo
       recomputes when this clears because the state it reads is in its dependency list. Nothing is lost by
       waiting; the notice is exactly as due a moment later.
       NOT DONE WITH Z-INDEX. Two mounted modals with one on top is two things to click through with the
       second one already visible behind the first, which is the stack this avoids rather than an
       implementation of avoiding it. */
    if (privatePayoutPhase !== null) return null;
    /* ==================================================================
        DESIGN NOTE 981: A BLOCKING MODAL FOR SOMEBODY ELSE'S CORPORATION
       ==================================================================
       REPORTED: "the Rust and Train Limit modals pop up for every player in the room ... Inactive players
       should not receive blocking pop-ups for corporate events they do not control."
       AND THE GATE THAT WAS HERE READS AS IF IT ALREADY DID THIS. `companyId === actingProtocolId` scopes the
       notice to the corporation whose turn it is -- which is a fact about the GAME, not about the VIEWER, so
       it is true on every client at once. Six players, six unskippable modals, five of them about a fleet the
       reader cannot spend, buy for or run. The only viewer-scoped condition in the whole memo was
       `spectator`, and a seated player who owns nothing is not a spectator.
       THE PRESIDENT IS THE RIGHT AUDIENCE and not merely a narrower one: #896's case for interrupting at all
       is that the loss "is about to change what you do next", and for anyone but the president it changes
       nothing they can act on. They are not left uninformed -- `describeFleetLoss` puts every loss in the
       Activity Log for the whole table, which is where a fact you cannot act on belongs.
       `viewerAddress` NULL MEANS UNIDENTIFIED, NOT UNAUTHORISED. A client that has not resolved its own
       address yet would otherwise be silently excluded from a notice it is owed, and #232's rule applies to
       the viewer as much as to the chain: absence is not an answer. Showing it is the recoverable direction
       -- a modal one dismiss away -- where hiding it loses the notice for that turn permanently. */
    const presidentOf = (companyId: number) =>
      gameState?.public_companies?.find((entry) => entry.company_id === companyId)?.president ?? null;
    const mine = pendingFleetNotices.filter((notice) => {
      if (notice.companyId !== actingProtocolId) return false;
      const president = presidentOf(notice.companyId);
      if (president === null || viewerAddress === null) return true;
      return president === viewerAddress;
    });
    return nextDueNotice(
      mine,
      (notice) => isNoticeSilenced(sandboxRoomCode, notice.companyId, notice.cause),
      dismissedFleetNoticesRef.current,
    );
  }, [
    gameState?.current_round_type,
    gameState?.public_companies,
    spectator,
    pendingFleetNotices,
    actingProtocolId,
    turnIdentity,
    sandboxRoomCode,
    viewerAddress,
    /* Design note #1049a: what makes the suppression above lift on its own. Listed rather than read through a
       ref precisely BECAUSE this memo must re-run when the payout modal closes -- a ref read would suppress
       the notice and then never notice it was safe to show it. */
    privatePayoutPhase,
  ]);

  const acknowledgeFleetNotice = useCallback(() => {
    const notice = dueFleetNotice;
    if (!notice) return;
    /* BOTH, and they do different jobs. Dropping it from the queue closes this modal now; remembering the
       EVENT key is what stops a log replay from raising it again -- see `fleetLossNotice.ts` #896, and #1032
       for why that key can no longer be the turn's. */
    // Design note #1107: through the helper, so the acknowledgement reaches `sessionStorage` and survives a
    // refresh -- the ref alone only ever survived an Undo.
    rememberDismissed(noticeDismissKey(notice));
    const next = pendingFleetNoticesRef.current.filter((entry) => entry !== notice);
    pendingFleetNoticesRef.current = next;
    setPendingFleetNotices(next);
  }, [dueFleetNotice, rememberDismissed]);

  const toggleFleetNoticeSilence = useCallback(
    (silenced: boolean) => {
      const notice = dueFleetNotice;
      if (!notice) return;
      setNoticeSilenced(sandboxRoomCode, notice.companyId, notice.cause, silenced);
    },
    [dueFleetNotice, sandboxRoomCode],
  );

  const autoSkipReason = useMemo<string | null>(() => {
    if ((gameState?.current_round_type ?? null) !== "OperatingRound") return null;
    if (spectator) return null;
    if (orSubPhase === "Routes") {
      /* Design note #414: was `ownsAnyTrain ? null : ...`. A corporation
         with a train and no reachable revenue was held on a step whose only
         control drafts a route that cannot exist. */
      return noEarnableRevenue;
    }
    /* The Tokens step exits itself when there is nowhere to place. Three reasons, reported separately - they call for different responses.
       See docs/ai_architecture/state_machine.md - App.tsx #438 */
    if (orSubPhase === "Tokens") return stationPlacementBlock;
    /* A trainless corporation DECLARES $0 withheld rather than skipping; 1830 has no third option, and the declaration is what steps the marker left. #414 widened it to a stranded train.
       See docs/ai_architecture/state_machine.md - App.tsx #292 */
    if (orSubPhase === "Dividends" && noEarnableRevenue !== null) return null;
    if (orSubPhase === "Hardware" && atTrainLimitNow) {
      return "it is already at its train limit";
    }
    return null;
  }, [gameState, spectator, orSubPhase, noEarnableRevenue, stationPlacementBlock, atTrainLimitNow]);

  /* Same once-per-(corporation, step) guard as the auto-skip: online the cursor is poll-driven, so an unguarded effect would re-broadcast every render.
     See docs/ai_architecture/state_machine.md - App.tsx #292 */
  const forcedWithholdRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if ((gameState?.current_round_type ?? null) !== "OperatingRound") return;
    if (spectator) return;
    if (orSubPhase !== "Dividends") return;
    /* ==================================================================
     *  DESIGN NOTE 774: ONE CLIENT DISPATCHES, NOT EVERY CLIENT
     * ==================================================================
     *
     * REPORTED: a share price that "moved two cells left rather than one" after a trainless Operating Round.
     *
     * EVERY CONDITION ABOVE IS SHARED STATE. The round type, the sub-phase and the revenue are all replayed
     * identically on every browser in the room, and `spectator` is about how you are WATCHING rather than
     * whether you are on turn. So every seated player's client reached this line and appended its own
     * `DeclareDividends`. Two players, two messages, two cells left.
     *
     * `forcedWithholdRef` BELOW IS NOT THE GUARD FOR THIS. It is a `Set` in one tab and it does its job --
     * it stops THIS client dispatching twice. It has no way to know another client exists, and #653 scoping
     * it to the turn did not change that.
     *
     * `automatic: true` IS EXEMPT FROM THE TURN GATE, correctly: `runGameplayAction` skips "is it your turn"
     * for the messages the game sends on a player's behalf. That exemption is what let the duplicate out, so
     * the ownership check has to be made here instead.
     *
     * THE SAME PREDICATE THE AUTO-PASS EFFECT ALREADY USES, whose note says it in one line: "it is THIS
     * player's -- `isMyTurn` is the same predicate the turn gate uses". In an Operating Round `isMyTurn`
     * resolves to the operating corporation's president, so exactly one client passes.
     *
     * IF THAT PRESIDENT'S BROWSER IS ABSENT, nothing is dispatched and the turn waits -- which is what
     * happens for every other action they owe, and a stall is recoverable in a way a corrupted market is
     * not. The reducer refuses a second declaration regardless (`dividendGate.ts`), so this is the source
     * and that is the door. */
    if (!isMyTurn) return;
    /* Having skipped Routes is an OBSERVATION and is enough on its own; the pathfinder prediction declines to answer in exactly this case. Manual skips count too.
       See docs/ai_architecture/state_machine.md - App.tsx #484 */
    if (noEarnableRevenue === null && !skippedRoutesThisTurn) return;
    // Design note #653: scoped to THIS turn, not to this corporation for
    // the whole game -- a corporation withholds on many turns.
    const key = turnGuardKey(turnIdentity, actingProtocolId, "withhold");
    if (forcedWithholdRef.current.has(key)) return;
    forcedWithholdRef.current.add(key);
    /* ==================================================================
        DESIGN NOTE 1057: THE DECLARATION'S OWN SENTENCE SAYS ALL OF THIS NOW
       ==================================================================
       THIS PRINTED "$0 withheld and the share price steps left" beside a `DeclareDividends` line that then
       said "B&O withheld $0 into its treasury", beside a `Market Move` line that said the price fell. Three
       lines, one event, and the middle one used a word for a choice the player never made.
       #1054 FOLDED ALL THREE INTO ONE: "B&O did not run any routes. Its share price fell from $100 to $90."
       The consequence is stated, which is what earns this event a line at all under #1057's rule -- so the
       line stays and the COMMENTARY goes. What is lost is the distinction between "no trains ran" and "no
       route earned anything", which was never visible to a player anyway: both produce a corporation that
       ran nothing, and the fleet is on the corporation card for anybody asking why. */
    withholdRevenueAutomatically();
  }, [
    gameState,
    spectator,
    isMyTurn,
    orSubPhase,
    noEarnableRevenue,
    skippedRoutesThisTurn,
    ownsAnyTrain,
    actingProtocolId,
    turnIdentity,
    withholdRevenueAutomatically,
    logInfo,
  ]);

  const autoSkippedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!autoSkipReason) return;
    /* Design note #774: the same fix as the forced withhold above, for the same reason. `autoSkipReason` is
       derived entirely from shared state, so every seated browser reached this line and appended its own
       `AdvanceOperatingSubPhase`. That produced no visible price bug -- the cursor arms are idempotent
       enough that a second skip usually lands on a step it would have reached anyway -- which is exactly why
       it would have gone on shipping. Fixed alongside its twin rather than waiting for the report. */
    if (!isMyTurn) return;
    // Design note #653: the turn is part of the key, so the guard re-arms.
    const key = turnGuardKey(turnIdentity, actingProtocolId, orSubPhase);
    if (autoSkippedRef.current.has(key)) return;
    autoSkippedRef.current.add(key);
    /* ==================================================================
       DESIGN NOTE 876: SKIPPING THE LAST STEP IS ENDING THE TURN
       ==================================================================
       ASKED: "When a corporation is at the train limit, I think the game should auto-skip to end their turn
       instead of making them click it."
       THE REASON WAS ALREADY HERE -- `autoSkipReason` has returned "it is already at its train limit" for the
       Hardware step since #249 -- and this line dispatched an advance into a step that does not exist.
       `nextSubPhase` returns `current` at the end of the list (#656: "a phase change is not a turn event"),
       so the cursor stayed put, the guard below marked the turn handled, and the only trace was a log line
       claiming a skip that never happened.
       THE PREDICATE IS A POSITION, NOT A NAME. `stepsFor` is the reducer's own list and it varies -- it drops
       `BuyPrivate` once the last private is bought -- so asking "is this the last one" keeps the shell and
       the reducer agreeing about where the turn ends. See `autoSkipExit.ts`. */
    const exit = gameState
      ? autoSkipExit(orSubPhase, stepsFor(gameState))
      : ("advance" as const);
    /* ==================================================================
        DESIGN NOTE 1057: A STEP WHERE NOTHING HAPPENED EARNS NO LINE
       ==================================================================
       ASKED: "for player-facing activity log, does it make sense to print [Corporation] passed on actions
       they skip? Or should the log only print when a corporation does something?"
       RULED: print when something CHANGED, which is not the same as the automatic/manual split the question
       offered -- and the reason is in the report's own item (v). An auto-skipped Run Routes changes nothing;
       an auto-withheld dividend MOVES THE SHARE PRICE, so it still prints. The dividing line is the
       consequence, not who pressed the button.
       AND A MANUAL SKIP IS SILENT TOO. "So they know their button press worked" is a real need and #718
       already meets it: the action toast is the receipt for a click, raised on the clicker's own screen. The
       log is the table's record, and a record of nothing having happened is what makes a feed unreadable.
       THE `Auto-Withhold` LINE BELOW IS DELIBERATELY UNTOUCHED -- see it for the price move that earns it. */
    // Design note #439: the AUTOMATIC entry points, so Undo rewinds past either.
    if (exit === "end-turn") endTurnAutomatically();
    else skipSubPhaseAutomatically(autoSkipReason);
  }, [
    autoSkipReason,
    isMyTurn,
    actingProtocolId,
    turnIdentity,
    orSubPhase,
    /* Design note #876: `gameState` joins the list because `stepsFor` reads it. The guard above makes the
       effect idempotent per turn, so a wider dependency costs a comparison rather than a second dispatch. */
    gameState,
    skipSubPhaseAutomatically,
    endTurnAutomatically,
    logInfo,
  ]);

  /* ==================================================================
      DESIGN NOTE 1094: THE BAR STOPS FLICKERING THROUGH SKIPPED STEPS
     ==================================================================
     REPORTED: "The Action Bar is currently flashing through skipped subphases quickly enough to be
     distracting but too fast to read. Batch these state updates so auto-skipped subphases resolve
     instantaneously without rendering intermediate UI states."

     WHY IT FLICKERS, WHICH DECIDES WHAT THE FIX CAN BE. The effect above dispatches ONE advance and then
     waits to be re-run, because the next step's verdict is not knowable until the board has moved: the
     reason is `autoSkipReason`, a `useMemo` over render state that reads `noEarnableRevenue` and
     `stationPlacementBlock`, both themselves derived at render. Each advance is an awaited dispatch, so each
     lands in its own commit, and the bar paints every step on the way past. A trainless corporation walks
     Routes, Dividends and Tokens in three frames.

     SO THIS CANNOT BE FIXED BY BATCHING THE DISPATCHES. Doing that honestly means making the verdict a pure
     function of `GameStateResponse` so the whole run could be computed before any of it is applied -- a real
     refactor of three memos and their inputs, and much wider than this report. What is fixed instead is what
     the report actually describes: the bar no longer PAINTS the steps it is walking through.

     HELD AT THE STEP THE RUN STARTED FROM, then released onto the step it settles on. Two states instead of
     five, which is the difference between a transition and a flicker.

     THE CONDITION IS THE EFFECT'S OWN, RE-ASKED -- reason present, my turn, and this key not already spent.
     That last clause is the one that matters and it is why this is not a stored latch: `autoSkippedRef`
     holding the key means the effect will NOT dispatch, and a freeze that did not ask would hold the bar
     frozen for the rest of the turn. Derived from the same three facts the dispatch is, it cannot outlive it.

     THE REF IS WRITTEN DURING RENDER, deliberately and idempotently: for a given render it stores the value
     that render already computed, so a double invocation under StrictMode writes the same thing twice. */
  const autoSkipPending =
    autoSkipReason !== null &&
    isMyTurn &&
    !autoSkippedRef.current.has(turnGuardKey(turnIdentity, actingProtocolId, orSubPhase));
  const settledSubPhaseRef = useRef(orSubPhase);
  if (!autoSkipPending) settledSubPhaseRef.current = orSubPhase;
  /** The step the Action Bar should draw: the live one, or the last settled one while a skip run resolves. */
  const displayedSubPhase = autoSkipPending ? settledSubPhaseRef.current : orSubPhase;

  // End Turn dispatches the same PassTurn the Stock Round uses. #44: the first-OR market lesson interrupts, guarded three ways; #412 gates only the NAVIGATION on tutorialMode.
  // See docs/ai_architecture/state_machine.md - App.tsx #44
  const handleEndOperatingTurn = useCallback(() => {
    const viewerIsPresident =
      viewerAddress != null &&
      (gameState?.public_companies ?? []).some((c) => c.president === viewerAddress);
    const isFirstOperatingRound = (gameState?.macro_round_number ?? 0) <= 1;

    handlePassTurn();
    setLiveOrSubPhase("Track");

    if (viewerIsPresident && isFirstOperatingRound) {
      if (tutorialModeEnabled()) setActiveMainTab("stock");
      setMarketTutorialArmed(true);
    }
  }, [handlePassTurn, viewerAddress, gameState]);

  // State, not a memo: applySandboxLayTile must replace the object, because that identity change is what the renderer's draw effect watches.
  // See docs/ai_architecture/canvas_rendering.md - App.tsx #435

  /** Three separate writes in three places; the charge goes through runGameplayAction so a lay uses the one dispatch path.
   *  See docs/ai_architecture/canvas_rendering.md - App.tsx #436 */
  const handleSandboxLayTile = useCallback(
    (
      q: number,
      r: number,
      tileId: number,
      orientation: number,
      bonusLay = false,
      /** Design note #824: where the token on this hex goes, when the president had a say. */
      tokenCity?: number,
      /** Design note #880: where EVERY token on this hex goes -- `[company_id, city_index]`, derived from
       *  connectivity. Supersedes `tokenCity`, which could only say one thing to all of them. */
      tokenCities?: ReadonlyArray<[number, number]>,
    ) => {
      /* The board write lives inside runGameplayAction's sandbox branch - outside it, a replayed lay charged the treasury and left the board blank.
         See docs/ai_architecture/canvas_rendering.md - App.tsx #522 */
      runGameplayAction("LayTile (sandbox)", {
        LayTile: {
          game_id: gameId,
          protocol_id: actingProtocolId,
          q,
          r,
          tile_id: tileId,
          orientation,
          /* Design note #776: ON the message, so every client's reducer reaches the same answer from the log
             alone. Omitted when false rather than sent as `false`: an ordinary lay's entry must look exactly
             like the ones written before this field existed. */
          ...(bonusLay ? { bonus_lay: true } : {}),
          /* Design note #824: ON the message for #776's reason, said again because it is the same reason --
             every client's reducer must reach the same answer from the log alone, and a choice the log does
             not carry is a choice that does not survive a replay. */
          ...(tokenCity !== undefined ? { token_city: tokenCity } : {}),
          /* Design note #880: and the per-company answer, which is the one the reducer prefers. Omitted when
             empty so an ordinary lay on an empty hex is byte-identical to what this app has always sent. */
          ...(tokenCities && tokenCities.length > 0 ? { token_cities: [...tokenCities] } : {}),
        },
      });

      // A corporation lays one tile per turn, so the Track step is done. This
      // mirrors what `hexmap::execute_lay_tile` does on chain (it advances
      // the cursor off `Track` on success) rather than inventing a sandbox
      // sequencing rule.
      setLiveOrSubPhase("Tokens");
      setPreviewTile(null);
    },
    [runGameplayAction, gameId, actingProtocolId],
  );

  /* Design note #163: the ONE gate. Everything else in the radial selector
     works regardless of whose turn it is. */
  const tileLayDisabledReason = useMemo(() => {
    if (spectator) return "Planning Mode: Tile lay disabled — you are spectating.";
    if (gameState?.current_round_type !== "OperatingRound") {
      return "Planning Mode: Tile lay disabled — track is laid in an Operating Round.";
    }
    if (orSubPhase !== "Track") {
      // Direction-aware: from Phase 3 the turn OPENS on BuyPrivate, so "past the Track step" was wrong in the commonest case.
      // See docs/ai_architecture/ui_shell_layout.md - App.tsx #440
      const order = OPERATING_SUB_PHASE_ORDER;
      const before = order.indexOf(orSubPhase) < order.indexOf("Track");
      return before
        ? `Planning Mode: Tile lay disabled — the turn is still on ${orSubPhase}. Advance to Lay Track first.`
        : `Planning Mode: Tile lay disabled — this corporation is past the Track step (now ${orSubPhase}).`;
    }
    // `actingSeatIndex` resolves the ACTING corporation's president during an
    // Operating Round, which is exactly the person entitled to lay here.
    const acting = gameState ? actingSeatIndex(gameState) : null;
    if (acting === null || gameState?.player_addresses[acting] !== viewerAddress) {
      return "Planning Mode: Tile lay disabled — not your corporation's turn.";
    }
    return null;
  }, [spectator, gameState, orSubPhase, viewerAddress]);
  const canLayTileNow = tileLayDisabledReason === null;

  /* canLayTileNow decides whether the carousel is narrowed to one corporation's reach - the same predicate the confirm button uses. Sandbox/offline path only; a chain answer is used verbatim.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #620 */
  /** Whether the ring currently open is the D&H's own errand -- the one lay that ignores connectivity. */
  const onPrivateTileHex =
    homeStationPlacement?.kind === "private-tile" &&
    radialSelector !== null &&
    homeStationPlacement.q === radialSelector.q &&
    homeStationPlacement.r === radialSelector.r;

  const radialCandidates = useMemo<readonly LegalTilePlacement[]>(() => {
    if (!radialSelector) return [];
    if (!radialSelector.provisional) return radialSelector.placements;
    return filterSandboxPlacements(radialSelector.placements, {
      mapGrid,
      q: radialSelector.q,
      r: radialSelector.r,
      // undefined for anyone who may not lay, which lets them browse the whole hex rather than one corporation's slice.
      // See docs/ai_architecture/canvas_rendering.md - App.tsx #620
      /* Design note #725: and undefined on the D&H's own hex, for the same reason the ring opens there at all.
         Passing the network here would hand the picker an empty candidate list -- the second half of the same
         refusal, and the one that would have survived fixing only the ring. */
      networkHexes: canLayTileNow && !onPrivateTileHex ? layTrackFocus?.network : undefined,
      networkPorts: canLayTileNow && !onPrivateTileHex ? layTrackFocus?.ports : undefined,
      // The era comes from `currentPhase.tint`, the SAME derivation the
      // phase badge displays, rather than a second reading of
      // `current_global_era`.
      era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
    });
  }, [
    radialSelector,
    mapGrid,
    currentPhase,
    canLayTileNow,
    onPrivateTileHex,
    layTrackFocus?.network,
    layTrackFocus?.ports,
  ]);

  /* Rotate only through legal angles; the set is already present as (tile_id, orientation) pairs, sorted for a predictable direction.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #173 */
  const legalRotations = useMemo<number[]>(() => {
    if (previewTile === null) return [];
    const angles = radialCandidates
      .filter((placement) => placement.tile_id === previewTile.tileId)
      /* ==================================================================
         DESIGN NOTE 879: AN ORIENTATION THAT SEVERS A NETWORK IS NOT LEGAL
         ==================================================================
         REPORTED: "if a Green OO has a station marker with connectivity to a specific hex, the only legal
         upgrades are those that preserve the station marker with that connectivity to that specific hex."
         SO THE FILTER IS PART OF LEGALITY, not a courtesy. `planTokenUpgrade` returns `null` when no city of
         the candidate at this facing still owns a standing token's edges -- and the rotate gesture must not
         be able to reach an arrangement the rules forbid, because a president who can see it will try to lay
         it.
         AN EMPTY HEX AND A FREE TOKEN BOTH PASS. The plan only refuses when there is a network to sever, so
         ordinary lays and ERIE's unconnected home keep every facing they had. */
      .filter(
        (placement) =>
          planTokenUpgrade(
            mapGrid,
            previewTile.q,
            previewTile.r,
            gameState?.public_companies ?? [],
            placement.tile_id,
            placement.orientation,
          ) !== null,
      )
      .map((placement) => placement.orientation);
    return Array.from(new Set(angles)).sort((a, b) => a - b);
  }, [radialCandidates, previewTile, mapGrid, gameState]);

  /* ==================================================================
      DESIGN NOTE 874: LEAVING THE PICKER LEAVES THE POWER
     ==================================================================

     REPORTED: "once a player selects the Lay Track power, there is no 'escape.' Selecting the red X on the
     tileselector preview tile does not escape the private power."

     THE RING AND THE ERRAND WERE TWO STATES AND ONLY ONE OF THEM CLOSED. Dismissing the picker cleared the
     ring and left `homeStationPlacement` armed -- so the veil stayed, the connectivity gate stayed lifted,
     and the only labelled way out was #817's cancel on the action bar, which the player is not looking at.
     BOTH EXITS AGREE NOW, which is the part that matters: the X and the click-away do the same thing, so a
     player who reaches for either gets the same answer. `errandClickIntent` already treats a click on ANOTHER
     hex as a cancel (#817), and this is the third gesture finally joining the other two.
     ONLY THE TILE ERRAND. A `private-station` errand opens no picker (#866) and a HOME station errand is
     compulsory -- "there is nothing to cancel and nowhere else to go" -- so neither is reachable from here.
     THE MODAL COMES BACK ON ITS OWN. `privatePowerRequest` is untouched by arming, so clearing the placement
     is enough for `activePowerFlow` to raise the flow again -- where the X cancels the power outright. */
  const handleDismissRadial = useCallback(() => {
    setRadialSelector(null);
    setPreviewTile(null);
    setHomeStationPlacement((current) =>
      current?.kind === "private-tile" ? null : current,
    );
  }, []);

  /* ==================================================================
      DESIGN NOTE 886: ONE DERIVATION, EVERY SURFACE THAT DRAWS A TOKEN
     ==================================================================

     REPORTED, of #878/#879's fix: "currently rotating through upgrade tiles on the ERIE home station hex is
     showing the correct/legal options, but the very first preview placement is jumping the station to the
     wrong city marker, even though all subsequent rotations place it correctly" -- and "on other OO hexes,
     the stations are previewing incorrectly and jumping around on rotations".

     TWO FAULTS, AND BOTH ARE THE SAME OMISSION SEEN FROM DIFFERENT ANGLES: #879 taught the ROTATE path to
     derive a token's city from connectivity and left every other path on the old rule.
       (i) SELECTION NEVER DERIVED. `onSelectCandidate` seeded `tokenCity` from `tokenDestinationChoices(...)
           [0]` -- #824's rule, which consults neither connectivity nor orientation -- so the FIRST preview
           was placed by the superseded rule and only rotating corrected it. Exactly what was reported.
       (ii) AND THE BOARD APPLIED ONE INDEX TO EVERYBODY. `previewTile.tokenCity` is a single number, and the
           renderer read it inside a per-company loop -- so two corporations on one OO hex were both drawn in
           the acting corporation's city, and it moved on every rotation. That is #880's wire bug over again
           on the canvas: an index cannot say where two tokens go.

     SO THE PREVIEW CARRIES THE MAP, not the index, and this is the only place it is computed. The ring's
     thumbnails, the board's ghost and the dispatched lay now read one answer. */
  const derivePreviewLandings = useCallback(
    (q: number, r: number, tileId: number, orientation: number, chosenCity: number | undefined) => {
      const plan = planTokenUpgrade(
        mapGrid,
        q,
        r,
        gameState?.public_companies ?? [],
        tileId,
        orientation,
      );
      const tokenCities = tokenLandingsFor({
        plan,
        actingCompanyId: actingProtocolId,
        chosenCity,
      });
      /* THE ACTING CORPORATION'S OWN CITY, kept beside the map because the rotate cycle needs to know
         whether it was ANCHORED (the board decided) or FREE (the president is cycling). `anyFree` answers
         that; the index alone cannot. */
      const own = plan?.landings.find((entry) => entry.companyId === actingProtocolId) ?? null;
      return {
        tokenCities,
        ownCity: own?.toCityIndex ?? chosenCity,
        ownIsFree: own !== null && own.toCityIndex === null,
        legal: plan !== null,
      };
    },
    [mapGrid, gameState, actingProtocolId],
  );

  const handlePreviewRotate = useCallback(
    ({ q, r }: { q: number; r: number }) => {
      // A click on a DIFFERENT hex while a preview is up means "I have
      // changed my mind about which hex" -- close, and let the next click
      // open the selector there. Rotating a tile the player is no longer
      // looking at would be the wrong reading of that gesture.
      if (!radialSelector || q !== radialSelector.q || r !== radialSelector.r) {
        handleDismissRadial();
        return;
      }
      setPreviewTile((current) => {
        if (!current) return current;
        // Design note #173: step to the next LEGAL angle, wrapping. With
        // one legal rotation this is a no-op, which is correct -- there is
        // nowhere else the tile may face -- and with none it leaves the
        // orientation alone rather than inventing one.
        if (legalRotations.length === 0) return current;
        /* ==================================================================
           DESIGN NOTE 824: THE CYCLE GAINS A SECOND DIMENSION
           ==================================================================

           REQUESTED: "if we can simply let players click through every possible Green tile upgrade with the
           station marker on one city, then do it again on the other city, this will resolve the ERIE home
           station issue."

           EXACTLY THAT, AND NO NEW CONTROL. The rotate gesture already means "show me the next arrangement";
           where the token's city is undetermined there are simply twice as many arrangements. Orientation is
           the INNER loop and the city the outer, so a president sees every facing with the marker in one
           city before it moves -- which is the order the question is actually asked in ("can I get the
           facing I want?" then "and with the token where?").

           ONE CHOICE MEANS ONE PASS, so every ordinary upgrade on the board cycles exactly as it did: the
           city list has a single entry, the outer loop never advances, and `tokenCity` stays put. */
        /* ==================================================================
           DESIGN NOTE 879: THE CITY IS DERIVED PER FACING, NOT CARRIED
           ==================================================================
           #824 CYCLED A CHOICE and that was right for the case it was built for -- ERIE's home token, where
           the board has never said which city it is in. It was wrong as a general rule, because for every
           OTHER token the destination is not a choice at all: it is whichever city of THIS facing still owns
           the token's edges, and it changes as the tile turns.
           SO THE OUTER LOOP SURVIVES ONLY WHERE THERE IS SOMETHING TO CHOOSE. `ownIsFree` is true exactly
           when a standing token has no network to preserve, which is #878's one-line statement of the ERIE
           case; everywhere else the marker follows the track and the president rotates through facings alone.
           ==================================================================
            DESIGN NOTE 889: THE ARITHMETIC LEFT, THE BOARD STAYED
           ==================================================================
           The odometer is `previewRotation.ts` now -- the wrapping facing list, the city-as-outer-loop, and
           the free-vs-anchored branch -- so it can be exercised as arithmetic instead of scanned for. What
           remains here is the two questions only the shell can answer: what connectivity does at a candidate
           facing, and how many cities the candidate carries. */
        const step = nextPreviewArrangement({
          current: { orientation: current.orientation, tokenCity: current.tokenCity },
          legalRotations,
          /* Design note #886: through the one derivation, so a rotation and a fresh selection place the
             marker by the same rule. Asked about the NEXT facing with the city the president currently has. */
          fitAt: (orientation, chosenCity) =>
            derivePreviewLandings(current.q, current.r, current.tileId, orientation, chosenCity),
          freeCityChoices: () => freeCityChoices(tileCityCount(current.tileId)),
        });
        if (step === null) return current;

        /* THE MAP IS RECOMPUTED FOR THE CHOSEN CITY, not reused from the probe inside the step: when the
           token is free and the cycle has just advanced it, the probe was asked about the PREVIOUS choice. */
        const landing = derivePreviewLandings(
          current.q,
          current.r,
          current.tileId,
          step.orientation,
          step.tokenCity,
        );
        return {
          ...current,
          orientation: step.orientation,
          tokenCity: step.tokenCity,
          tokenCities: landing.tokenCities,
        };
      });
    },
    [radialSelector, handleDismissRadial, legalRotations, derivePreviewLandings],
  );

  /** A live preview gives the canvas to rotation, so the query interceptor is disarmed. Token destinations are recomputed per candidate tile.
   *  See docs/ai_architecture/canvas_rendering.md - App.tsx #448 */
  const radialTokenNote = useMemo(() => {
    /* ==================================================================
       DESIGN NOTE 823: THE BOARD SAYS IT BETTER THAN THE SENTENCE DID
       ==================================================================

       REQUESTED: "there is a tooltip that says 'Station marker on city 1 of 2' but nobody playing the game
       knows what that means. We can remove that string and have the preview render the station marker."

       RIGHT, AND THE SENTENCE WAS ALWAYS STANDING IN FOR A PICTURE. "City 1 of 2" is an INDEX -- a number
       with no meaning on a board where the two cities are distinguished by where they sit, not by an order
       nobody can see. It existed because the preview could not show the answer, and #822 has just made it
       able to: the marker is now drawn on the ghost tile, in the circle it will occupy.
       A DRAWING BEATS A COORDINATE, which is the same trade #237 made when it replaced "2/4 - $40 ea" with
       the station circles themselves, and #779 made when a private's holder became a colour.

       `previewTokenMigration` STAYS, AND THE FIRST DRAFT OF THIS NOTE SAID IT STAYS *HERE*, which was false
       within four lines of being written: this memo no longer calls it at all. It is still called below, once
       per radial candidate, to decide which destination each thumbnail draws (#449) -- so the arithmetic has
       a live reader and the prose does not. Corrected rather than quietly reworded, because a note asserting
       something the code beneath it does not do is the single failure this project keeps finding.
       AND #879 RETIRED THAT READER TOO. The thumbnails now ask `planTokenUpgrade`, which knows the ORIENTATION
       and therefore can answer where a token lands; `previewTokenMigration` preserved a city INDEX and has no
       caller in this file any more. A third correction to one paragraph, left visible for the same reason the
       second was.

       THE MEMO ITSELF IS KEPT, returning `null`, rather than deleting the `tokenNote` prop: the ring's
       caption is a general facility (#684 shows it only while previewing) and a future note may earn it.
       Nothing is computed for it, so it costs nothing. */
    return null as string | null;
  }, []);

  /* One previewTokenMigration per candidate, keyed on its tile id - the destination depends on how many cities that tile carries. #628: tray counts read the live board.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #449 */
  const radialStockFor = useCallback(
    (tileId: number) => tileStock(mapGrid, tileId),
    [mapGrid],
  );

  const radialStationMarkersFor = useCallback(
    (tileId: number): readonly StationPreviewMarker[] => {
      if (!radialSelector) return [];
      /* ==================================================================
         DESIGN NOTE 879: A THUMBNAIL HAS TO PICK A FACING
         ==================================================================
         REPORTED: "the tileselector radial menu cannot predict where the station will be."
         EXACTLY SO, AND THAT IS NOT A REASON TO DRAW NOTHING. The destination depends on the orientation and
         the ring has not asked for one yet, so this shows the arrangement the player will actually meet
         FIRST: the lowest facing that is legal for this candidate. Pressing it opens the preview at that same
         facing (`legalRotations[0]`), so the marker on the thumbnail is the marker they then see on the board
         rather than a guess that changes under them.
         AND AN ILLEGAL CANDIDATE DRAWS NO MARKER, which is honest: if no facing of this tile can seat the
         tokens, there is no destination to promise. The candidate itself is filtered out of the ring by the
         same rule (#879 in `legalRotations`), so this is the belt to that braces. */
      const companies = gameState?.public_companies ?? [];
      const facing = radialCandidates
        .filter((placement) => placement.tile_id === tileId)
        .map((placement) => placement.orientation)
        .sort((a, b) => a - b)
        .find(
          (orientation) =>
            planTokenUpgrade(
              mapGrid,
              radialSelector.q,
              radialSelector.r,
              companies,
              tileId,
              orientation,
            ) !== null,
        );
      if (facing === undefined) return [];
      const plan = planTokenUpgrade(
        mapGrid,
        radialSelector.q,
        radialSelector.r,
        companies,
        tileId,
        facing,
      );
      if (!plan) return [];
      /* ==================================================================
         DESIGN NOTE 889: THE THUMBNAIL SEEDS LIKE THE PREVIEW SEEDS
         ==================================================================
         THE ORIGINAL RULE HERE WAS "A FREE TOKEN HAS NO DESTINATION TO DRAW. Rendering it at city 0 would be
         the superseded rule reappearing on the one surface that never had it." That was right while the
         preview drew nothing either. #889 seats the ACTING corporation's free token at the first city on
         offer -- so keeping the blank here would have made this note's own promise false: "the marker on the
         thumbnail is the marker they then see on the board rather than a guess that changes under them."
         Two surfaces answering one question two different ways is the pattern this project keeps producing;
         creating a fresh instance of it while fixing another would be a poor trade.
         SOMEBODY ELSE'S FREE TOKEN STILL DRAWS NOTHING, and that is the half of the old rule that survives.
         This president is not choosing for them (`tokenLandingsFor`, #885), so there is no arrangement to
         promise -- as opposed to one they are about to be handed. */
      const seededCity = freeCityChoices(tileCityCount(tileId))[0];
      return plan.landings
        .map((entry) => ({
          cityIndex:
            entry.toCityIndex ?? (entry.companyId === actingProtocolId ? seededCity : undefined),
          ticker: entry.ticker,
          color: stationTickerColor(entry.companyId),
        }))
        .filter(
          (marker): marker is { cityIndex: number; ticker: string; color: string } =>
            marker.cityIndex !== undefined,
        );
    },
    [radialSelector, mapGrid, gameState, radialCandidates, actingProtocolId],
  );

  /* Order matches cursorMode's: a home-station errand names its own corporation and wins. private-tile is excluded because it ends in the tile picker.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #496 */
  const stationCursorCorporation = useMemo<{ ticker: string; color: string } | null>(() => {
    const companyId =
      homeStationPlacement && homeStationPlacement.kind !== "private-tile"
        ? homeStationPlacement.companyId
        : tokenTargetMode
          ? actingProtocolId
          : null;
    if (companyId === null) return null;
    const ticker =
      gameState?.public_companies.find((entry) => entry.company_id === companyId)?.ticker ||
      stationTickerLabel(companyId);
    if (!ticker) return null;
    return { ticker, color: stationTickerColor(companyId) };
  }, [homeStationPlacement, tokenTargetMode, actingProtocolId, gameState]);

  /* The listener is the only writer: the tail past appliedIndexRef, replayed through runGameplayAction, sequential and awaited. #527: the room doc is a separate subscription.
     See docs/ai_architecture/firebase_middleware.md - App.tsx #523 */
  useEffect(() => {
    if (!sandbox || !sandboxRoomCode) {
      setSandboxRoom(null);
      return undefined;
    }
    return subscribeSandboxRoom(
      sandboxRoomCode,
      (room) => {
        setSandboxRoom(room);
        // Design note #764: the FIRST snapshot is what ends the not-knowing, whatever it contains.
        setSandboxRoomResolved(true);
      },
      (message) => setSandboxRoomError(message),
    );
  }, [sandbox, sandboxRoomCode]);

  /* ==================================================================
     DESIGN NOTE 856: JOINING A ROOM DID NOT PUT YOU IN IT
     ==================================================================

     REPORTED: "When I Host Game and a player joins, it does not update on my screen until/unless I refresh
     the page." And, decisively, on being asked which way round it failed: "the joiner sees the host, but the
     host doesn't see joiners."

     THAT ASYMMETRY IS THE WHOLE DIAGNOSIS. `hostSandboxRoom` writes the host into the room document, so a
     joiner's FIRST SNAPSHOT already contains them -- which is why the joiner's screen looked correct and made
     the listeners look healthy. `handleJoinSandboxRoom` reads the log and sets the room code, and writes
     NOTHING. `upsertSandboxPlayer` had exactly three callers, all of them waiting-room controls: set a
     nickname, pick a colour, press Ready. So a joiner who had not yet touched one of those three was not in
     the document at all, and the host's listener had nothing to fire on.

     IT WAS NEVER LAG, which is what it looks like from the host's chair -- "the joining player showed up on
     the host's browser while talking to you". The delay is exactly how long the joiner takes to type a name
     or press Ready, which is unbounded and feels like a slow network. Refreshing the host appeared to fix it
     because by then the joiner had usually interacted.

     AND IT IS NOT A REGRESSION, though it was reported as one. `git log -S upsertSandboxPlayer` finds three
     commits, all ADDING call sites, none in the join path; nothing was removed in the last two pushes or in
     any before them. What changed is probably the playtest habit, not the code.

     THE ROSTER IS LOAD-BEARING, which is why this is more than cosmetic: `SandboxWaitingRoom` derives
     `players.length` from it, and the host's Start button is gated on `MIN_PLAYERS` -- so an unseated joiner
     does not merely fail to appear, they cannot be started with.

     ONCE PER ROOM, THROUGH A REF. The effect must not re-fire on every snapshot: `upsertSandboxPlayer` is a
     read-modify-write transaction, and an effect keyed on the roster that writes the roster is a loop. The
     ref records which room code has been claimed, so a second room re-arms it and a failed write does not
     spin. #573's rule, applied to a write rather than to a power: an attempt that changes nothing must leave
     the world alone.

     THE NAME IS THE ONE THE HOST USES for itself -- `sandboxSeatRef`, falling back to "Player". #765 records
     that a code-joiner never touches the lobby's `displayName`, so anything read from there would be blank;
     the roster nickname is the name of record and the waiting room is where it is chosen. */
  const seatedRoomRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sandbox || !sandboxRoomCode) {
      seatedRoomRef.current = null;
      return;
    }
    // Not until the first snapshot: "no such room" and "have not heard yet" are different (#764).
    if (!sandboxRoomResolved || !sandboxRoom) return;
    if (seatedRoomRef.current === sandboxRoomCode) return;
    if (sandboxRoom.players.some((player) => player.id === localId)) {
      // Already in the roster -- the host, or a rejoin. Claim it so this cannot write over them later.
      seatedRoomRef.current = sandboxRoomCode;
      return;
    }
    seatedRoomRef.current = sandboxRoomCode;
    void upsertSandboxPlayer(sandboxRoomCode, {
      id: localId,
      nickname: sandboxSeatRef.current || "Player",
      isReady: false,
    });
  }, [sandbox, sandboxRoomCode, sandboxRoomResolved, sandboxRoom, localId]);

  const replayingRef = useRef(false);
  /* Design note #668: the ids of the entries this client has already applied,
     in the order it applied them. The drain's only record of WHICH history it
     replayed -- a count cannot tell one history from another of the same
     length, and that is exactly the case that stranded a player. */
  const appliedIdsRef = useRef<string[]>([]);
  /** Design note #668: the snapshot that arrived mid-replay, held rather than
   *  dropped. `null` when there is nothing waiting. */
  const pendingSnapshotRef = useRef<SandboxAction[] | null>(null);
  useEffect(() => {
    if (!sandbox || !sandboxRoomCode) return undefined;
    let live = true;

    /* Design note #668: `SandboxAction`, imported. #643 spelled this shape out
       by hand and it went stale immediately -- it omitted `at`, so the log's
       timestamp was dropped at the door and the whole rebuilt history was
       stamped with the instant of the rebuild. Naming the type is the fix that
       note asked for. */
    const drain = async (incoming: SandboxAction[]) => {
      /* A snapshot arriving mid-replay is now HELD, NOT DROPPED. This is the
         stranding: `subscribeSandboxLog` hands back the whole log, so a dropped
         snapshot is harmless only while another is coming. The LAST one has
         nothing behind it -- the room falls quiet because it is the other
         player's turn -- so the client that dropped it simply stops, mid-round,
         with a board every other client has moved past. Player 1 sits in OR 2.2
         while Player 2 reaches SR3, and no amount of waiting fixes it because
         Firestore has nothing left to send.
         See docs/ai_architecture/firebase_middleware.md - App.tsx #668 */
      if (replayingRef.current) {
        // Newest wins: the whole log, so an older held snapshot is a strict
        // subset of this one and worth nothing.
        pendingSnapshotRef.current = incoming;
        return;
      }
      replayingRef.current = true;
      try {
        let actions = incoming;
        // Drains until the room stops changing under it, so the coalesced
        // snapshot above is never left sitting.
        for (;;) {
          /* An undo, or a race resolved against this client, means the history it
             replayed is no longer the room's: throw the state away and replay from
             the fixture. A full replay is the cheap option.
             See docs/ai_architecture/firebase_middleware.md - App.tsx #591, #668 */
          sandboxLogRef.current = actions;
          /* Named history, not live - the first version shadowed the effect's own teardown flag.
             See docs/ai_architecture/firebase_middleware.md - App.tsx #454 */
          const history = effectiveActions(actions);
          /* Design note #592a: the newest round-opening action still standing.
             `SetupGame` counts as one -- it opens the auction -- so a host can
             always reach back to the top of the current round even in the
             first one. */
          roundBoundaryIndexRef.current =
            [...history].reverse().find((entry) => {
              const decoded = decodeAction(entry);
              return isSetupGameMsg(decoded) || isOpenStockRoundMsg(decoded);
            })?.index ?? null;
          /* Design note #668: PREFIX, not length. `history.length <
             appliedCountRef.current` catches an undo and misses a reorder --
             two clients appending at the same index each see their own entry
             first, and `sortActions`' document-id tie-break then puts them in
             an order one of them has already contradicted. Same length,
             different history, no rebuild, permanent divergence. */
          const rewound = !appliedPrefixHolds(
            appliedIdsRef.current.slice(0, appliedCountRef.current),
            history,
          );
          if (rewound) {
            rebuildRef.current?.();
            appliedCountRef.current = 0;
            appliedIdsRef.current = [];
            /* The log is a rendering of the action list, so a rewind rebuilds it from the same source rather than appending to it.
               See docs/ai_architecture/firebase_middleware.md - App.tsx #643 */
            setActionLog([]);
            // Design note #668: and the feed's clock goes back with it, or the
            // previous run's high-water mark flattens the whole replay onto one
            // instant.
            resetLogClock();
          }
          // The next log index to append at is the LOG's length, never the
          // effective count -- an undone action still occupies its index.
          appliedIndexRef.current =
            actions.length > 0 ? actions[actions.length - 1].index + 1 : 0;

          /* Design note #670: A BADGE MARKS A MOVE, NOT A CATCH-UP.
             This pass is ordinary play only when exactly ONE action is new and
             nothing was rewound. Joining a room replays a whole game, and an
             undo rebuilds from the fixture -- in both, every balance on the
             board changes, and firing a badge per change would carpet the strip
             with figures about events that are minutes old. Those passes
             re-baseline in silence, which is what `cashByPlayer` after the loop
             does for free. */
          const pending = history.length - appliedCountRef.current;
          const isOrdinaryPlay = !rewound && pending === 1;

          for (let at = appliedCountRef.current; at < history.length; at += 1) {
            if (!live) return;
            const action = history[at];
            const msg = decodeAction(action);
            /* A corrupt entry is SKIPPED PAST, cursor and all. Stopping would
               wedge the room on one bad document; re-reading it every
               snapshot would wedge it in a loop. */
            appliedCountRef.current = at + 1;
            appliedIdsRef.current[at] = action.id;
            if (!msg) continue;
            /* Design note #668: the replay clock is set BEFORE the dispatch and
               cleared after, so every derived line `runGameplayAction` writes
               through `logInfo` -- Float, Round, Auto-Skip -- is stamped with
               this action's instant rather than the rebuild's. */
            replayClock = action.at ?? null;
            /* Design note #825: and whether this is history or now. `isOrdinaryPlay` is the drain's own name
               for the distinction (#670) and was already deciding whether a cash badge fires; publishing it
               is what lets the toasts ask the same question. */
            replayingHistory = !isOrdinaryPlay;
            /* Design note #670: read off the REF, not the state variable. The
               reducer writes `sandboxStateRef` synchronously and React commits
               later, so the ref is the only thing that can be compared either
               side of one awaited dispatch. */
            const cashBefore = isOrdinaryPlay ? cashByPlayer(sandboxStateRef.current) : null;
            try {
              // eslint-disable-next-line no-await-in-loop
              await runGameplayAction("Sandbox room", msg, {
                isRemoteReplay: true,
                automatic: true,
                // Design note #549: WHO, straight off the log entry.
                actor: action.actor || null,
                // Design note #643: and WHEN, likewise. Without this the whole
                // rebuilt history is stamped with the instant of the rebuild.
                at: action.at,
              });
            } finally {
              // Cleared even if the dispatch threw: a stuck clock would stamp
              // every later live action with a replayed instant.
              replayClock = null;
              // Design note #825: and a stuck flag would silence every later toast, which is the failure
              // that reads as "notifications stopped working" and has no obvious cause.
              replayingHistory = false;
            }
            if (cashBefore && live) {
              noteCashChanges(cashChanges(cashBefore, cashByPlayer(sandboxStateRef.current)));
            }
          }
          if (live) setSandboxAppliedCount(appliedCountRef.current);

          /* Design note #668: whatever arrived while the loop was running. The
             room is only caught up once there is nothing waiting -- returning
             here with a snapshot still held is the stranding by another route. */
          const queued = pendingSnapshotRef.current;
          pendingSnapshotRef.current = null;
          if (!queued || !live) return;
          actions = queued;
        }
      } finally {
        replayingRef.current = false;
      }
    };

    const unsubscribe = subscribeSandboxLog(
      sandboxRoomCode,
      (actions) => {
        void drain(actions);
      },
      (message) => setSandboxRoomError(message),
    );
    return () => {
      live = false;
      unsubscribe();
      /* Design note #670: badges belong to the room they were earned in. */
      setCashDeltas([]);
      /* Design note #668: a held snapshot belongs to the room being left. The
         next room's first snapshot is a whole log of its own and needs no help
         from this one. */
      pendingSnapshotRef.current = null;
    };
    /* `noteCashChanges` is stable (`useCallback` with an empty dependency list),
       so naming it here costs nothing and keeps the linter's guarantee intact --
       an omission that happens to be safe today is the one that stops being safe
       silently. See docs/ai_architecture/ui_shell_layout.md - App.tsx #670 */
  }, [sandbox, sandboxRoomCode, runGameplayAction, noteCashChanges]);

  /** Design note #522: opens a room and publishes its code. */
  const handleHostSandboxRoom = useCallback(async () => {
    setSandboxRoomBusy(true);
    setSandboxRoomError(null);
    try {
      const code = await hostSandboxRoom(localPlayerId(), sandboxSeatRef.current || "Host");
      if (!code) {
        setSandboxRoomError("Firestore is not configured in this build.");
        return;
      }
      /* The cursor starts at zero for a room that starts empty, so the host
         replays its own actions from the log exactly as a joiner does --
         one code path, no host special case. */
      appliedIndexRef.current = 0;
      setSandboxAppliedCount(0);
      setSandboxRoomCode(code);
    } catch (error) {
      setSandboxRoomError(error instanceof Error ? error.message : "Could not open the room.");
    } finally {
      setSandboxRoomBusy(false);
    }
  }, []);

  /** Design note #522: joins an existing room and fast-forwards to it. */
  const handleJoinSandboxRoom = useCallback(async (raw: string) => {
    const code = parseRoomCode(raw);
    if (!code) {
      setSandboxRoomError("That is not a room code — they look like JUNO-4T2.");
      return;
    }
    setSandboxRoomBusy(true);
    setSandboxRoomError(null);
    try {
      /* Read once before subscribing only to tell the player the room exists; the listener owns the replay.
         See docs/ai_architecture/firebase_middleware.md - App.tsx #465 */
      const existing = await readSandboxLog(code);
      appliedIndexRef.current = 0;
      setSandboxAppliedCount(0);
      setSandboxRoomCode(code);
      if (existing.length === 0) {
        setSandboxRoomError("Joined — no actions in this room yet.");
      }
    } catch (error) {
      setSandboxRoomError(error instanceof Error ? error.message : "Could not join that room.");
    } finally {
      setSandboxRoomBusy(false);
    }
  }, []);

  /** Leaves the room. The BOARD IS LEFT WHERE IT IS rather than reset: the
   *  player is dropping out of the sync, not abandoning the position, and
   *  wiping a game they can still look at would be a surprising amount of
   *  destruction for a button labelled "Leave". */
  const handleLeaveSandboxRoom = useCallback(() => {
    // Design note #537b: release the roster, so a solo session afterwards
    // resolves the fixture's own names again rather than staying blank.
    clearRoomNicknames();
    setSandboxRoomCode(null);
    /* Forget the room on leave, so the next refresh does not silently rejoin it.
       See docs/ai_architecture/firebase_middleware.md - App.tsx #551 */
    writeActiveSandboxRoom(null);
    setSandboxRoomError(null);
    appliedIndexRef.current = 0;
    setSandboxAppliedCount(0);
  }, []);

  /* Append the setup event FIRST, then latch status to playing - the flag is what sends every client to the board.
     See docs/ai_architecture/firebase_middleware.md - App.tsx #532 */
  /** Design note #910: the host rewrites the table's house rules while the room is waiting. */
  const handleSetSandboxVariants = useCallback(
    async (next: GameVariants) => {
      if (!sandboxRoomCode) return;
      try {
        await setSandboxRoomVariants(sandboxRoomCode, next);
      } catch (error) {
        setSandboxRoomError(
          error instanceof Error ? error.message : "Could not save the house rules.",
        );
      }
    },
    [sandboxRoomCode],
  );

  const handleStartSandboxGame = useCallback(async () => {
    if (!sandboxRoomCode || !sandboxRoom) return;
    if (!canStartSandboxGame(sandboxRoom, MIN_PLAYERS)) return;
    setSandboxRoomBusy(true);
    setSandboxRoomError(null);
    try {
      const seated = shuffleForTurnOrder(toSetupPlayers(sandboxRoom));
      const allocated = await appendSandboxAction(sandboxRoomCode, appliedIndexRef.current, localId, {
        /* ==================================================================
            DESIGN NOTE 910: THE VARIANTS TRAVEL WITH THE SETUP, OR THEY DO NOT EXIST
           ==================================================================
           This read `SetupGame: { players: seated }` and carried no config at all, which is why every table
           played the printed game however the room was configured -- the schema (#902) was wired end to end
           and nothing ever put anything into it on this path.
           FROM THE ROOM DOCUMENT, exactly like the roster beside it. Every client deals from this one action,
           so the variants have to be IN it: reading a local selection at deal time would give the host's
           browser one game and every other browser another, which is #550's rule and the deepest desync
           available here. */
        SetupGame: { players: seated, variants: sandboxRoom.variants },
      });
      // Design note #1026: `null` is the failure; the setup event legitimately lands on index 0.
      if (allocated === null) {
        setSandboxRoomError("Could not reach the room — the game was not started.");
        return;
      }
      await markSandboxRoomPlaying(sandboxRoomCode);
    } catch (error) {
      setSandboxRoomError(error instanceof Error ? error.message : "Could not start the game.");
    } finally {
      setSandboxRoomBusy(false);
    }
  }, [sandboxRoomCode, sandboxRoom, localId]);

  /** Design note #527: nickname and ready are document writes, not log
   *  entries -- they toggle, and a toggle in an append-only log is two
   *  entries the replay would have to reconcile. */
  const handleSetSandboxNickname = useCallback(
    (nickname: string) => {
      if (!sandboxRoomCode) return;
      const mine = sandboxRoom?.players.find((player) => player.id === localId);
      void upsertSandboxPlayer(sandboxRoomCode, {
        id: localId,
        nickname: nickname.trim() || "Player",
        isReady: mine?.isReady ?? false,
        // Design note #569: carried, not dropped. The upsert REPLACES the
        // entry, so a field left out of one write is erased by it.
        ...(mine?.color ? { color: mine.color } : {}),
      });
    },
    [sandboxRoomCode, sandboxRoom, localId],
  );

  /* Design note #569: `null` clears the choice and returns this seat to the
     assigned default. Written through the same upsert as the nickname, so
     design note #541's in-place update keeps the roster order. */
  const handleSetSandboxColor = useCallback(
    (color: string | null) => {
      if (!sandboxRoomCode) return;
      const mine = sandboxRoom?.players.find((player) => player.id === localId);
      void upsertSandboxPlayer(sandboxRoomCode, {
        id: localId,
        nickname: mine?.nickname ?? "Player",
        isReady: mine?.isReady ?? false,
        ...(color ? { color } : {}),
      });
    },
    [sandboxRoomCode, sandboxRoom, localId],
  );

  const handleToggleSandboxReady = useCallback(
    (isReady: boolean) => {
      if (!sandboxRoomCode) return;
      const mine = sandboxRoom?.players.find((player) => player.id === localId);
      void upsertSandboxPlayer(sandboxRoomCode, {
        id: localId,
        nickname: mine?.nickname || "Player",
        isReady,
        // Design note #569: carried, for the same reason the nickname write
        // carries the ready flag -- this replaces the whole entry.
        ...(mine?.color ? { color: mine.color } : {}),
      });
    },
    [sandboxRoomCode, sandboxRoom, localId],
  );

  const previewRotateArmed = radialSelector !== null && previewTile !== null;

  /* Design note #673: what the tile lay in flight will cost, computed ONCE and
     rendered in two places -- the corporation card's provisional treasury and
     the radial confirm caption. Two surfaces deriving one figure is how the two
     come to show different figures.
     GATED ON THE STEP, not merely on the ring: the picker also opens as an
     inspector outside Lay Track (#437), where nothing is going to be spent and a
     projected treasury would be describing a purchase nobody is making. */
  const pendingLayCost = useMemo(() => {
    if (!radialSelector || orSubPhase !== "Track" || !canLayTileNow) return null;
    const cost = pendingTileCost(
      mapGrid,
      radialSelector.q,
      radialSelector.r,
      activeCorporationContext?.treasury ?? null,
      /* Design note #723: the reducer's own paid-ground ledger, so the preview quotes the figure the debit will
         actually be. Before this it read the tile grid and the reducer read nothing -- the preview said $0 on an
         upgrade and the treasury lost the full fee. */
      gameState?.terrain_fees_paid,
    );
    return cost.fee > 0 ? cost : null;
  }, [
    radialSelector,
    orSubPhase,
    canLayTileNow,
    mapGrid,
    activeCorporationContext,
    gameState?.terrain_fees_paid,
  ]);

  /** Derived from radialSelector: the ring and the veil must appear and vanish together.
   *  See docs/ai_architecture/canvas_rendering.md - App.tsx #472 */
  /* Design note #725: written in an effect rather than at the two call sites that set the errand, so arming
     and disarming cannot get out of step -- the ref follows the state by construction. */
  useEffect(() => {
    privateTileHexKeyRef.current =
      homeStationPlacement?.kind === "private-tile"
        ? `${homeStationPlacement.q},${homeStationPlacement.r}`
        : null;
  }, [homeStationPlacement]);

  /* Design note #725a: the flag a president gets before spending their own power by accident. Reported on
     confirming that a self-lay forfeits like any other: "we may want to include a flag of some sort that says
     'Hey, you own this private company, do you want to use it?'"
     Computed on the RING rather than on the hex, so it appears at the moment of committing rather than while
     browsing -- the same stage rule #684 applies to the fee. */
  const dhLayWarning = useMemo(() => {
    if (!radialSelector) return null;
    const dh = gameState?.private_companies?.find((entry) => entry.private_id === DH_PRIVATE_ID);
    const forDh = dhSelfLayWarning({
      q: radialSelector.q,
      r: radialSelector.r,
      dhHex: privateHexFor(DH_PRIVATE_ID),
      actingOwnsDh:
        !!dh && dh.owner_protocol_id != null && dh.owner_protocol_id === actingProtocolId,
      power: dhPower,
      usingPower: onPrivateTileHex,
    });
    if (forDh) return forDh;

    // Design note #726: the C&SL has the same trap and one fewer thing to lose.
    const csl = gameState?.private_companies?.find(
      (entry) => entry.private_id === CSL_PRIVATE_ID,
    );
    return privateSelfLayWarning({
      q: radialSelector.q,
      r: radialSelector.r,
      hex: privateHexFor(CSL_PRIVATE_ID),
      actingOwns:
        !!csl && csl.owner_protocol_id != null && csl.owner_protocol_id === actingProtocolId,
      layAvailable: cslPower.layAvailable,
      forfeited: cslPower.forfeited,
      usingPower: onPrivateTileHex,
      privateName: "Champlain & St. Lawrence",
      hexLabel: CSL_HEX_LABEL,
      buttonLabel: `Lay Track (${CSL_HEX_LABEL})`,
    });
  }, [radialSelector, gameState, actingProtocolId, dhPower, cslPower, onPrivateTileHex]);

  const soleFocusKey = useMemo(
    () => (radialSelector ? `${radialSelector.q},${radialSelector.r}` : undefined),
    [radialSelector],
  );

  /** Confirm. Sandbox lays locally; a chain-backed room dispatches. */
  const handleConfirmRadialLay = useCallback(() => {
    if (!radialSelector || !previewTile || !canLayTileNow) return;
    const { q, r } = radialSelector;
    /* ==================================================================
       DESIGN NOTE 891: A LAY THE TREASURY CANNOT COVER IS REFUSED HERE FIRST
       ==================================================================
       REPORTED: "B&O had $0 in its treasury and was able to lay a track tile on a terrain hex costing $80.
       Its treasury stayed $0. Corporations should not be able to lay track if they cannot afford the terrain
       cost."
       THE FIGURE WAS ALREADY ON SCREEN AND NOBODY ASKED IT. `pendingTileCost` (#673) computes exactly this
       and reports `short` -- the radial's own confirm caption has been printing "Costs $80 -- treasury $-80
       after" from the same call. So the app could say the corporation could not afford it, drew that
       sentence, and then laid the tile anyway: a rule stated on one surface and never asked in the one that
       acts, which is this codebase's most common bug wearing a price tag.
       REFUSED WITH A REASON, not silently. The player pressed a button; the log is where they find out why
       nothing happened, and `sandboxSession.ts` #891 is the authority that also refuses it on replay.
       `pendingLayCost` IS REUSED RATHER THAN RECOMPUTED, which is #673's own rule about this figure: "computed
       ONCE and rendered in two places ... Two surfaces deriving one figure is how the two come to show
       different figures." A third call here would be a third chance to disagree with the caption the player
       just read. It is gated on `orSubPhase === "Track" && canLayTileNow`, the same pair guarding this
       handler's first line, so it is non-null wherever this runs.
       SCOPE, STATED: this refuses what the reducer CHARGES. Whether the C&SL's bonus lay should be exempt
       from terrain at all is a separate question -- that arm charges `terrainFeeDue` unconditionally today
       (`sandboxSession.ts`), so refusing an unaffordable one is consistent with the bill rather than a new
       rule about which lays are free. */
    if (pendingLayCost?.short) {
      logInfoRef.current?.(
        "Lay Track",
        `${activeCorporationContext?.ticker ?? "This corporation"} cannot afford the $${pendingLayCost.fee} terrain cost here — its treasury holds $${pendingLayCost.before ?? 0}.`,
      );
      return;
    }
    const { tileId, orientation } = previewTile;
    /* Design note #776: THE C&StL'S LAY IS EXTRA, and this is the only place that knows it. The player
       reached this hex through the `csl-tile` errand, so the shell can state which lay it is instead of
       leaving the reducer to infer it from the hex -- and a connected B-20 lay CAN legitimately be the
       ordinary placement, so inference would grant a free second tile in that case.
       THE D&H IS EXCLUDED ON PURPOSE (#548): `dh-tile` consumes the corporation's placement; only its token
       is free. The two privates are exact opposites and this is where they part. */
    // Design note #885: the rule lives beside the one that READS the flag, so both halves are in one place.
    const bonusLay = errandLaysBonus(homeStationPlacement);
    /* ==================================================================
       DESIGN NOTE 880: EVERY TOKEN'S DESTINATION, NOT JUST THE ACTOR'S
       ==================================================================
       ASKED: "If a tile has multiple stations and a corporation upgrades it, it is necessary that all the
       stations maintain their connectivity, not just the one whose corporation is upgrading."
       `planTokenUpgrade` HAS ALWAYS COMPUTED ALL OF THEM -- the legality filter (#879) already refuses any
       orientation that strands anybody -- and the message could only carry one index, so the other tokens'
       answers were computed, drawn, and thrown away.
       THE ACTING CORPORATION'S ENTRY IS OVERRIDDEN by `previewTile.tokenCity` where the plan left it FREE:
       that is ERIE's case, where the board never distinguished the cities and the president has just chosen
       by rotating (#824). An anchored token ignores the choice, because there was none to make. */
    /* Design note #886: THE PREVIEW ALREADY HOLDS THIS. It was recomputed here, which is a second call to
       the same derivation on the same inputs -- and a second call is a second chance to disagree with the
       ghost the player is looking at. The lay now sends exactly what was drawn. */
    const tokenCities = previewTile.tokenCities ?? [];
    if (sandbox) {
      handleSandboxLayTile(q, r, tileId, orientation, bonusLay, previewTile.tokenCity, tokenCities);
    } else {
      runGameplayAction("LayTile", {
        LayTile: {
          game_id: gameId,
          protocol_id: actingProtocolId,
          q,
          r,
          tile_id: tileId,
          orientation,
          ...(bonusLay ? { bonus_lay: true } : {}),
          /* Design note #824: and where the token goes, when the president had a say. Omitted otherwise, so
             every ordinary lay is byte-identical to what this app has always sent -- the containment #808's
             `bypass` has, for the same reason. */
          ...(previewTile?.tokenCity !== undefined ? { token_city: previewTile.tokenCity } : {}),
          // Design note #880: the per-company map, which is what the reducer reads first.
          ...(tokenCities.length > 0 ? { token_cities: tokenCities } : {}),
        },
      });
    }
    /* A private-tile errand only veils, so its round trip ends here - marked spent on the LAY, not on the button press.
       See docs/ai_architecture/contract_economy.md - App.tsx #444
       Design note #817: AND ON *ITS* LAY. The test used to be that an errand was ARMED, which is the right
       intent asked the wrong way -- so a tile laid anywhere while the D&H's power was armed consumed that
       power and unlocked its free token. Reported: "I placed a tile that was not the F16 one, and it seems
       the DH power was consumed." `errandClaimsLay` asks the question the note always meant. */
    if (errandClaimsLay(homeStationPlacement, q, r)) {
      if (homeStationPlacement?.abilityKey) {
        setUsedPrivateAbilities((prev) =>
          new Set(prev).add(homeStationPlacement.abilityKey as string),
        );
      }
      /* Design note #818/#849: the D&H's lay is half a power, so landing it raises the other half as a
         question -- and nothing has to be told. `usedPrivateAbilities` gains `dh-tile` four lines up, and
         `activePowerFlow` reads a laid D&H with an unresolved station as an open flow. The reopening is a
         derivation, not an event somebody has to remember to fire across a sub-phase change. */
      setHomeStationPlacement(null);
      if (homeStationPlacement) setActiveMainTab(homeStationPlacement.returnTab);
    }
    handleDismissRadial();
  }, [
    radialSelector,
    previewTile,
    canLayTileNow,
    sandbox,
    handleSandboxLayTile,
    runGameplayAction,
    gameId,
    handleDismissRadial,
    actingProtocolId,
    homeStationPlacement,
    /* Design note #886: `mapGrid` and `gameState` left this list with the derivation itself -- the lay now
       sends the map the PREVIEW already holds, so it reads neither. #880 added them here for a computation
       that has since moved.
       Design note #891: and two arrive for the affordability refusal. `pendingLayCost` is the figure the
       radial's own caption is drawn from, so a handler holding a stale one would refuse against a price the
       player is not looking at -- the exact disagreement #673 built the single computation to prevent. */
    pendingLayCost,
    activeCorporationContext,
  ]);


  // Design note #4 in `TrainBadges.tsx`: the shared per-tier countdown, so
  // the action bar tag and every chip quote the same number.
  const currentRustOutlook = useMemo(() => rustOutlook(gameState), [gameState]);


  /* Design note #188: the dividend decision, costed. All four figures come
     from state already on screen -- the corporation's last route revenue,
     its holdings table, and its market price -- so none of this is a new
     source of truth, only arithmetic the player was being left to do. */
  const dividendCorp = gameState?.public_companies.find(
    (c) => c.company_id === actingProtocolId,
  );
  /* Design note #486: the declaration, derived once and shared with the
     dispatch above and the action bar below. `dividendRevenue` is now what
     this turn is WORTH rather than what the field remembers, so the payout
     table cannot list a split for a run that did not happen. */
  const dividendDeclarationNow = dividendDeclaration({
    lastRouteRevenue: dividendCorp?.last_route_revenue,
    skippedRoutes: skippedRoutesThisTurn,
    // Design note #934: the table quotes the same field the declaration spends.
    committedRevenue: null,
  });
  const dividendRevenue = dividendDeclarationNow.revenue;
  const dividendPerShare = dividendDeclarationNow.perShare;

  /* Design note #278: whether the Pay/Withhold choice is binding. `false`
     when this corporation is known to have skipped Routes -- see the state's
     own note for why `null` (unknown) counts as having run. */
  const dividendRevenueIsThisTurn = !skippedRoutesThisTurn;
  /* Design note #705: the rows now carry each holder's cash on BOTH sides of the payout, so the Pay column
     answers the same before-and-after question the Withhold column has answered since #509a. The arithmetic
     and the sort live in `dividendProjection`; the LABEL is resolved here, at the edge, because a wallet is
     what the state holds and a label is one client's rendering of it. */
  const dividendPayouts = useMemo(() => {
    if (!dividendCorp) return [];
    const cash = cashByPlayer(gameState);
    return projectDividendPayouts({
      holdings: dividendCorp.player_holdings,
      /* Design note #706: the BANK POOL pays the corporate treasury; unsold IPO shares pay nobody. The two
         were swapped in the reducer, which is why this column reported the wrong recipient twice. */
      bankPoolPercentage: dividendCorp.bank_pool_percentage,
      treasuryNow: Number(dividendCorp.treasury ?? 0) || 0,
      corporationLabel: dividendCorp.ticker,
      perShare: dividendPerShare,
      cashOf: (player) => cash[player] ?? null,
      labelOf: (player) => sandboxPlayerLabel(player) ?? truncateAddress(player),
    });
  }, [dividendCorp, dividendPerShare, gameState]);

  /* Carry the CELL through, not just the price: the chart repeats prices across rows, so a first-match search projected from the wrong box (#415).
     See docs/ai_architecture/stock_market.md - App.tsx #434 */
  const dividendCell = useMemo(
    () => marketGrid?.positions.find((p) => p.company_id === actingProtocolId) ?? null,
    [marketGrid, actingProtocolId],
  );
  const dividendPrice = useMemo(
    () => (dividendCell?.price != null ? Number(dividendCell.price) : null),
    [dividendCell],
  );
  /* Design note #908: THE READOUT TAKES THE SAME COUNT THE BOARD WILL TAKE. #891 is the whole reason this is
     not computed independently here -- "the readout came to promise a rise the board did not make" -- so the
     payout and the price go through `dividendStepsFor` on both sides and the only difference between them is
     which function they hand the answer to. */
  /* Design note #994: THE REVENUE THE DECISION IS ABOUT, read once and handed to both arms. It was inlined
     inside the pay memo while the withhold memo passed a hard-coded `0` -- which was correct only while a
     withhold could not scale, and became a wrong readout the moment #994 gave it a threshold. */
  const dividendRevenueForSteps = useMemo(
    () =>
      Number(
        gameState?.public_companies.find((entry) => entry.company_id === actingProtocolId)
          ?.last_route_revenue ?? 0,
      ) || 0,
    [gameState, actingProtocolId],
  );
  const dividendSteps = useMemo(
    () =>
      dividendStepsFor(
        dividendRevenueForSteps,
        dividendPrice,
        resolveVariants(gameState?.variants),
        // Design note #988: this count feeds the PAY projection only; the withhold asks for its own below.
        "pay",
      ),
    [dividendRevenueForSteps, gameState, dividendPrice],
  );
  const payProjection = useMemo(
    () => projectDividendFrom(dividendCell, "pay", dividendSteps),
    [dividendCell, dividendSteps],
  );
  /* ==================================================================
      DESIGN NOTE 994: THE WITHHOLD READOUT NEEDED THE FIGURE IT HAD BEEN DENIED
     ==================================================================
     #988 ROUTED THIS THROUGH `dividendStepsFor` and passed `0` as the payout, on the reasoning that a
     withhold pays nothing out so the amount could not matter. That was true of #988's rule and is false of
     #994's: the drop now scales with the revenue WITHHELD, so a zero here reports one cell for every turn
     including the ones the board moves two.
     THE FAILURE WOULD HAVE BEEN #891 AGAIN, from the opposite side -- the readout under-promising a fall the
     board then performs. Recorded because #988's own note is three lines up congratulating itself for
     closing exactly this gap: a placeholder argument is a rule waiting to change under it. */
  const withholdSteps = useMemo(
    () =>
      dividendStepsFor(
        dividendRevenueForSteps,
        dividendPrice,
        resolveVariants(gameState?.variants),
        "withhold",
      ),
    [dividendRevenueForSteps, gameState, dividendPrice],
  );
  const withholdProjection = useMemo(
    () => projectDividendFrom(dividendCell, "withhold", withholdSteps),
    [dividendCell, withholdSteps],
  );

  /* ==================================================================
      DESIGN NOTE 998: THE TWO COUNTS, NOT TWO SENTENCES
     ==================================================================
     #997 COMPUTED `dividendStepsExplanation` FOR BOTH DECISIONS and rendered them under the columns. ASKED
     SINCE: "can we actually just indicate this on the Market Move line? ... Maybe we replace both with
     (double move)?" -- so what the bar needs is how far each decision moves the token, which it already has
     an authority for.
     ASSEMBLED FROM THE TWO COUNTS ALREADY COMPUTED ABOVE rather than calling `dividendStepsFor` twice more.
     They are the same numbers the two projections take, so the marker on the line cannot disagree with the
     prices beside it -- which is #891's rule and the reason this is not derived in the panel. */
  const dividendMoveSteps = useMemo(
    () => ({ pay: dividendSteps, withhold: withholdSteps }),
    [dividendSteps, withholdSteps],
  );


  // Design note #28: the phase tab shares the workspace shell (canvas pane
  // + contextual panel) with the map and market tabs.
  const isWorkspaceTab =
    activeMainTab === "phase" ||
    activeMainTab === "corps" ||
    activeMainTab === "map" ||
    activeMainTab === "stock";

  /* No board until the setup event is in the log - starting cash and the certificate limit are undecided before it. #578: every sandbox session is a room, which collapsed 21 solo-vs-room branches.
     See docs/ai_architecture/firebase_middleware.md - App.tsx #533 */
  if (sandbox && !sandboxRoomCode) {
    return (
      <div style={styles.sandboxGateRoot}>
        <div style={styles.sandboxGateCard}>
          <h1 style={styles.sandboxGateTitle}>Sandbox</h1>
          <p style={styles.sandboxGateBody}>
            Every sandbox game runs in a room, so the board, the log and the turn order
            are the same ones a real table uses. Open a room and share the code, or join
            one you have been given.
          </p>
          <p style={styles.sandboxGateBody}>
            Testing alone? Open a room here, then join it from a second browser tab —
            each tab is its own player.
          </p>
          <SandboxRoomBar
            roomCode={sandboxRoomCode}
            available={isFirebaseConfigured()}
            error={sandboxRoomError}
            busy={sandboxRoomBusy}
            onHost={handleHostSandboxRoom}
            onJoin={handleJoinSandboxRoom}
          />
          <button type="button" style={styles.sandboxGateQuiet} onClick={onLeaveGame}>
            Back to the lobby
          </button>
        </div>
      </div>
    );
  }

  /* Design note #764: HOLD BEFORE THE FIRST SNAPSHOT. The board is not a safe default -- it renders the seeded
     Waterfall Auction, which is a screen from the middle of a game the player has not started. Waiting is the
     honest answer while the room's own state is still in flight, and it is one round trip. */
  if (sandbox && sandboxRoomCode && !sandboxRoomResolved) {
    return (
      <div style={styles.sandboxGateRoot}>
        <div style={styles.sandboxGateCard}>
          <h2 style={styles.sandboxGateTitle}>Joining {sandboxRoomCode}…</h2>
          <p style={styles.sandboxGateBody}>Fetching the room.</p>
          <button type="button" style={styles.sandboxGateQuiet} onClick={handleLeaveSandboxRoom}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (sandbox && sandboxRoomCode && sandboxRoom?.status === "waiting") {
    return (
      <SandboxWaitingRoom
        roomCode={sandboxRoomCode}
        room={sandboxRoom}
        localPlayerId={localId}
        error={sandboxRoomError}
        busy={sandboxRoomBusy}
        onSetNickname={handleSetSandboxNickname}
        onSetColor={handleSetSandboxColor}
        onToggleReady={handleToggleSandboxReady}
        onStart={handleStartSandboxGame}
        /* Design note #910: host-only, and `undefined` for a guest -- which is what renders the controls
           read-only for them rather than hiding the terms they are about to agree to. */
        onSetVariants={
          sandboxRoom?.hostId === localId ? handleSetSandboxVariants : undefined
        }
        onLeave={handleLeaveSandboxRoom}
      />
    );
  }

  /* Player cards are hoisted OUT of both ternary arms - the guard was correct and sat on an unmounted subtree. #604: the auction dashboard takes the node as a prop and places it.
     See docs/ai_architecture/stock_market.md - App.tsx #602 */
  const playersPanel =
    gameState &&
    (gameState.current_round_type === "StockRound" ||
      gameState.current_round_type === "WaterfallAuction") &&
    activeMainTab === surfaceTabFor(gameState.current_round_type) ? (
      <section style={styles.playerCardsSection}>
        <h3 style={styles.playerCardsTitle}>Players</h3>
        <PlayerCards
          players={playerFinancesBySeat}
          label={(address) => sandboxPlayerLabel(address) ?? truncateAddress(address)}
          activeAddress={actingAddress(gameState, waterfallState)}
          priorityAddress={gameState.player_addresses[gameState.priority_deal_index] ?? null}
          viewerAddress={viewerAddress ?? null}
          // Design note #569: their own choice, else the palette.
          colorForSeat={(index) => seatColor(gameState.player_addresses[index] ?? "", index)}
          // Design note #568: the auction's own text, same catalog.
          privateDescription={(privateId) =>
            PRIVATE_COMPANY_CATALOG[privateId]?.ability ?? null
          }
          // Design note #1035: amber at two buys from closure, red at one.
          privateClosureAlert={closureAlert}
          /* Design note #670: the same confirmation the Operating Round's cash
             strip gives, on the surface that owns cash in these two rounds. A
             share bought is a cash change like any other. */
          cashDelta={cashDeltaFor}
        />
      </section>
    ) : null;

  return (
    <div style={{ ...styles.appRoot, paddingBottom: `${statusDockHeight + 12}px` }}>
      {/* Design note #18/item 4, made MANDATORY by #21: keyframes injected unconditionally (Chatbox.tsx
         #2's convention for this codebase's inline-style escape hatch) and the pulsing overlay mounts off bare
         `isMyTurn` -- no gating value. The document-title flash is the other half and has no DOM footprint. */}
      <style>{TURN_PULSE_KEYFRAMES_CSS}</style>
      <style>{PHASE_SHIFT_PULSE_CSS}</style>
      {/* Design note #1008: `turnGlowActive`, not `isMyTurn`. The overlay is `pointerEvents: "none"`, so the
          click that dismisses it passes straight through to whatever the player was actually aiming at --
          which is what makes "dismiss on any click" safe to bind globally rather than to a close control. */}
      {turnGlowActive && <div style={styles.turnPulseOverlay} aria-hidden="true" />}

      {/* Hotseat dev toolbar -- rendered ONLY in the sandbox branch, so it is structurally impossible to reach
         in a live game. Sits above every other chrome element because it changes what the whole screen means. */}
      {/* Design note #537c: THE HOTSEAT TOOLBAR IS A SOLO TOOL, hidden in a room. The seat picker would offer
         a switch the dispatch gate refuses (#534 makes the local id the viewer); the scenario switcher re-seeds
         from a fixture, which #537 has just stopped doing in a room -- and a visible control that now does
         nothing reads as a broken game rather than as a control that does not apply. */}
      {/* Design note #578: THE SANDBOX TOOLBAR IS GONE. Seat switcher, auto-follow, scenario picker and train
         fixture were all controls for playing four people from one keyboard. The pickers went with them rather
         than being kept: they seed a board, and a room's board comes from its log. */}

      {/* Design note #32: FTUE mounted at the shell level, not inside the phase panels, so a modal survives its
         panel unmounting on a tab switch.
         Design note #39: THREE topics, one per round, all mounted unconditionally and each keyed on its own
         `active`. Safe against two firing at once because `current_round_type` is a single value -- the flags are
         mutually exclusive by construction, not by coordination. Each tracks its own "seen" flag. */}
      <TutorialModal
        topicKey="waterfall-auction"
        heading="Waterfall Auction"
        pages={WATERFALL_AUCTION_TUTORIAL}
        active={isWaterfallPhase}
      />
      <TutorialModal
        topicKey="stock-round"
        heading="Stock Round"
        pages={STOCK_ROUND_TUTORIAL}
        active={gameState?.current_round_type === "StockRound"}
      />
      <TutorialModal
        topicKey="operating-round"
        heading="Operating Round"
        pages={OPERATING_ROUND_TUTORIAL}
        active={gameState?.current_round_type === "OperatingRound"}
      />
      {/* Design note #44: the only tutorial not keyed to a round type. It
          opens on an event -- the player's first OR turn ending -- and the
          tab switch that precedes it is deliberate, not incidental. */}
      <TutorialModal
        topicKey="stock-market"
        heading="The Stock Market"
        pages={STOCK_MARKET_TUTORIAL}
        active={marketTutorialArmed}
      />

      {/* Design note #332: the mandatory buy the treasury cannot fund. Mounted at shell level beside the
         tutorials because it is a full-screen decision about the PRESIDENT's money -- the corporation's own
         panels are about the corporation's. */}
      {/* Design note #399: blocking, because until it is answered the B&O
          is presided over with no price -- a state design note #387 refuses
          to render a token or a figure for. */}
      {/* Design note #543: a prize is shown to whoever won it. The prompt fires wherever the winning action is
         APPLIED, and in a room every client applies every action (#522) -- so it was raised on both screens
         correctly and then rendered on both, because `open` asked only whether a prompt existed, not whose.
         It matters more than a label: the prompt SETS THE PAR PRICE, so two people answering it is two
         dispatches of one mandatory choice. Same identity branch #534 uses for the turn gate. */}
      {/* Design note #547: the par decision and the round handover, in one
          card. `parPending` carries design note #543's identity test already
          resolved -- see the prop's own comment for why it is decided here
          and not in the modal. */}
      <AuctionPromptModal
        /* Design note #543, simplified by #578: the room test is gone --
           there is no hotseat left in which every prompt is yours. */
        parPending={
          boParPrompt !== null && boParPrompt.player === viewerAddress && !boParAlreadySet
        }
        parWinnerLabel={
          boParPrompt
            ? sandboxPlayerLabel(boParPrompt.player) ?? truncateAddress(boParPrompt.player)
            : ""
        }
        onConfirmPar={handleConfirmBoPar}
        handoffPending={auctionHandoffPending}
        awaitingParFrom={
          boParPrompt && !boParAlreadySet && boParPrompt.player !== viewerAddress
            ? sandboxPlayerLabel(boParPrompt.player) ?? truncateAddress(boParPrompt.player)
            : null
        }
        onProceed={handleProceedToStockRound}
      />

      {/* Design note #416: blocking, for the same reason the B&O prompt is -- a floated corporation owes its
         home station and 1830 has no branch where it declines one. Shell level, because it can fire on any tab. */}
      {/* Design note #440: the modal hides once the player has accepted and been sent to the map -- a backdrop
         over the board they were just asked to click would be the flow blocking its own final step.
         `pendingHomeToken` stays true throughout, which brings the prompt back if the placement is abandoned. */}
      <HomeStationPrompt
        pending={homeStationPlacement ? null : pendingHomeToken}
        presidentLabel={
          pendingHomeToken?.president
            ? sandboxPlayerLabel(pendingHomeToken.president) ??
              truncateAddress(pendingHomeToken.president)
            : null
        }
        /* Design note #783: the whole table sees the card; only the President sees the ask. `viewerAddress`
           is null in hotseat, where one screen IS the president's, so the default there is the actionable
           form -- the same reasoning `holding.isSelf` uses on the roster. */
        viewerIsPresident={
          !pendingHomeToken?.president ||
          !viewerAddress ||
          pendingHomeToken.president === viewerAddress
        }
        liveryColor={
          pendingHomeToken ? stationTickerColor(pendingHomeToken.companyId) : "#0f0f0f"
        }
        liveryInk={
          pendingHomeToken
            ? bestContrastTextColor(stationTickerColor(pendingHomeToken.companyId))
            : "#eaf2ff"
        }
        onPlace={handlePlaceHomeStation}
      />

      <EmergencyTrainPurchaseModal
        plan={emergencyModalPlan}
        sandbox={sandbox}
        /* The forced sale dispatches the ordinary SellStock; endgame.ts already validated the block.
           See docs/ai_architecture/stock_market.md - App.tsx #490 */
        onSellShares={(companyId, percentage) => {
          void runGameplayAction("SellStock: emergency funding", {
            SellStock: { game_id: gameId, protocol_id: companyId, percentage },
          });
        }}
        onConfirm={() => {
          const plan = emergencyModalPlan;
          if (!plan) return;
          /* EmergencyBuyHardware, not BuyHardwareFromPool - the ordinary message charges the treasury and floors at zero.
             See docs/ai_architecture/contract_economy.md - App.tsx #333 */
          void runGameplayAction(
            `EmergencyBuyHardware: ${plan.trainModel}-train`,
            { EmergencyBuyHardware: { game_id: gameId, protocol_id: plan.corporationId } },
          );
          logInfo(
            "Emergency Purchase",
            `${plan.presidentLabel} covered $${plan.shortfall} of ${plan.corporationTicker}'s $${plan.trainCost} ${plan.trainModel}-train — $${plan.treasuryContribution} treasury, $${plan.fromPlayerCash} personal cash.`,
          );
        }}
      />

      {/* Design note #0 in `GameOverModal.tsx`: both endings, one surface.
          Mounted above the emergency modal in z-order because bankruptcy is
          declared FROM that modal -- the game ending has to be able to
          cover the screen the president was looking at when it happened. */}
      <GameOverModal
        /* Design note #900: dismissal hides the modal and nothing else -- the ending stands, and the rail
           below re-raises it. Passing `null` for the reason is what the component already treats as "absent",
           so a dismissed modal renders nothing at all rather than a hidden layer over the board. */
        reason={gameOverDismissed ? null : gameEndReason}
        standings={finalStandings}
        /* ==================================================================
            DESIGN NOTE 1091: THE EPITAPHS, BUILT WHERE THE ROSTER IS
           ==================================================================
           THE MODAL HAS PLAYERS AND THE CURSE IS ON CORPORATIONS, so somebody has to join the two -- and the
           shell is the only place holding both `gameState` and the seat labels. Passed as finished sentences
           rather than as raw flags for the same reason `roomContext` is a node: the modal renders what it is
           given and does not learn what a president is.
           BOTH STANDINGS COUNT, holding and haunted alike. `cursedCompanies` says why: the fog took an
           interest in this president whether or not the train survived to the final bell -- which is exactly
           the edge case the corporation-level flag was added for. */
        carcosa={cursedCompanies(gameState)
          .map((company) => {
            const president = company.president ?? null;
            const epitaph = carcosaEpitaph(
              company.ticker,
              president ? (sandboxPlayerLabel(president) ?? truncateAddress(president)) : null,
            );
            return epitaph && president ? { presidentAddress: president, epitaph } : null;
          })
          .filter((entry): entry is { presidentAddress: string; epitaph: string } => entry !== null)}
        viewerAddress={viewerAddress}
        totalAnte={PLACEHOLDER_TOTAL_ANTE}
        bankruptLabel={bankruptLabel}
        onDismiss={() => setGameOverDismissed(true)}
        /* Design note #899: no button once it is closed -- there is nothing left to do, and a control that
           silently no-ops is worse than one that is not there. */
        onCloseRoom={roomClosed ? null : () => closeRoom("manual")}
        autoCloseIn={autoCloseRemaining === null ? null : formatCountdown(autoCloseRemaining)}
        roomClosed={roomClosed}
      />

      {/* Design note #900: the way back in. Only while an ending is standing and the modal is down, so it
          never competes with the modal itself for the same corner. */}
      {gameEndReason && gameOverDismissed && (
        <button
          type="button"
          style={gameOverReopenStyle}
          onClick={() => setGameOverDismissed(false)}
        >
          {roomClosed
            ? "Final standings"
            : autoCloseRemaining !== null
              ? `Final standings · closing in ${formatCountdown(autoCloseRemaining)}`
              : "Final standings"}
        </button>
      )}

      {/* Design note #34: one bar. The room context is the middle of the single header now. It still says WHICH
         room this shell is bound to, and is still the only place `chatError` surfaces -- chat failing silently
         is worse than chat saying it is broken. */}
      <TopBar
        onLeaveGame={onLeaveGame}
        // Design note #1009: state from the shell, layout from the header.
        audio={audioControls}
        roomContext={
          <>
        {/* ==================================================================
             DESIGN NOTE 901: THE BANK IS BROKEN AND THE GAME HAS NOT STOPPED
            ==================================================================
            REQUESTED: "Add a persistent Bank Broken warning badge to the main UI once the bank has broken so
            all players are visually aware that they are in the final set of rounds."
            AND #898 IS WHAT MAKES IT NECESSARY. Before that fix the bank breaking ended the game on the spot,
            so there was no interval to warn about -- the modal WAS the notification. Now there is a stretch of
            real play between the break and the ending, during which every decision is a last decision, and
            nothing on screen said so. A player buying a train to set up next round needs to know there is no
            next round.
            IT NAMES WHAT IS LEFT rather than just raising an alarm. "Bank broken" alone tells a player
            something is wrong; the second half tells them what to do about it, and the two cases differ --
            finish this set, or play one more.
            NOT GATED ON `sandbox`, unlike the ending used to be. A broken bank is a fact about the game, not
            about which build is running it. */}
        {bankIsBroken(gameState) && gameState?.current_round_type !== "GameEnd" && (
          <span style={styles.bankBrokenBadge} title="The Bank cannot pay. The game ends when this Operating Round set finishes.">
            ⚠ BANK BROKEN &middot;{" "}
            {gameState?.current_round_type === "OperatingRound"
              ? "final OR set"
              : "one final OR set to play"}
          </span>
        )}

        {/* Design note #23: says plainly what mode this is, because a
            read-only board is otherwise indistinguishable from a board where
            it simply is not your turn. */}
        {spectator && <span style={styles.spectatorBadge}>👁 SPECTATING &middot; read-only</span>}
        {sandbox ? (
          // Design note #24: neither id means anything here, so neither is
          // shown. Displaying "game #0" would invite someone to go looking
          // for game 0 on chain.
          <>
            <span style={styles.sandboxBadge}>🧪 OFFLINE SANDBOX</span>
            {/* The phase switcher that stood here moved into the sandbox toolbar and went with it (#578). Two places
               to change sandbox settings is worse than one, and the seat switcher needed the room for four buttons. */}
            <span style={styles.roomStripLabel}>
              Mock state &middot; hotseat controls above
            </span>
          </>
        ) : (
          <>
            <span style={styles.roomStripLabel}>
              ⛓ On-chain game <strong style={styles.roomStripValue}>#{gameId}</strong>
            </span>
            <span style={styles.roomStripDivider} aria-hidden="true" />
            <span style={styles.roomStripLabel} title={`Firestore room ${roomId}`}>
              💬 Room <strong style={styles.roomStripValue}>{truncateAddress(roomId, 6, 4)}</strong>
            </span>
          </>
        )}
            {chatError && <span style={styles.roomStripError}>{chatError}</span>}
            {/* Design note #1083: the room's own error moved here with the room's name. It reports the same
               KIND of fact `chatError` does -- this room's connection is unhappy -- and the bar that used to
               carry it is gone. Only while IN a room: the join form still reports its own failures inline,
               where the player is looking when a code is refused. */}
            {sandboxRoomCode && sandboxRoomError && (
              <span style={styles.roomStripError}>{sandboxRoomError}</span>
            )}
          </>
        }
        /* Design note #1083: the sandbox room's code, in the slot the Neta DAO credit vacated. `null` for a
           solo sandbox and for an on-chain game, whose identity the strip above already names. */
        roomName={sandboxRoomCode}
      />

      {/* ==================================================================
       DESIGN NOTE 1084: THE BAR IS ABOVE THE TABS, AND ABOVE THE TAB BRANCH
      ==================================================================
      RULED: "Reorder the Layout Flow ... global controls sit above local navigation ... 1. Title Header.
      2. Action Bar (Global turn controls). 3. Tabs -- these must sit directly on top of the viewport.
      4. Current Tab Viewport. 5. Global Footer."

      IT MOVED OUT OF `isWorkspaceTab`, WHICH IS THE PART THAT IS NOT JUST A REORDER. #31 called this "THE
      one action bar" and it was one bar for four tabs; on `ledger`, `rules` and `tiles` it did not render
      at all, and #427 built a SECOND component to give those tabs a way back. Hoisted here it renders on
      every tab, which is what "global turn controls" means and what makes that second component
      redundant (see the deletion below).

      THE REFERENCE TABS ARE STILL SAFE, and by the mechanism that already existed rather than by not
      rendering: `misplacedSurfaceTab` returns non-null for any tab that is not the round's own surface,
      and #390/#404 REPLACE the entire bar with a single "Return to X" button in that case. So a player
      reading the rulebook gets one control that cannot spend a turn -- ruled explicitly: "when you're on
      a non-actionable tab like Rules Reference ... the Action Button still clicks to take you back to the
      working tab. That's the behavior we currently have."

      IT STAYS STICKY, AND IT TRAVELS OVER THE TABS. Ruled, with the trade named: "I don't think I want
      the tabs to become sticky: those eat an incredible amount of vertical space when most players don't
      use them unless they're intentionally trying to see something, and by that point they're already
      looking for them." So the tabs scroll away under the pinned bar and the turn controls are what stays.
      `actionBarCondensed` already supplies the pinned form -- squared top corners and a drop shadow --
      which answers the question asked with this batch: the separation is already built, and it appears at
      the moment it is needed rather than being drawn permanently. */}
      {/* Design note #31, kept: ONE bar. Two existed once, and on the phase tab during a Stock Round BOTH
         rendered, with two Undo buttons. That remains the rule this hoist must not break. */}
      {/* Item 5: the contextual gameplay action bar -- design notes #8/#10, with OR sub-phase guidance in
         #10/item 2.
         Design note #23: hidden entirely for spectators. This is the COURTESY half of read-only mode -- the
         guarantee is `runGameplayAction`'s gate, which holds whether or not this renders. Hidden rather than
         disabled because twenty greyed buttons offer a spectator nothing; the room strip's badge explains why. */}
      {/* ==================================================================
           DESIGN NOTE 1083: THE SHELL'S ROOM BAR WAS ALREADY UNREACHABLE
          ==================================================================
          #521 RENDERED IT HERE and the note above it argued, correctly for its time, that a spectator should
          still see the room strip. What has happened since is #533: `if (sandbox && !sandboxRoomCode)` returns
          the gate screen well above this point, so by the time the shell renders, `sandbox` IMPLIES a room
          code. With this batch's in-room branch gone the component returns `null` for exactly that case --
          so this instance could render nothing, ever.
          FOUND BY FOLLOWING THE DELETION rather than by a test: emptying the in-room branch made me ask what
          the remaining branch showed here, and the answer was "nothing, since #533". It had been dead for
          some time and cost nothing visible, which is why nobody found it.
          THE TWO LIVE INSTANCES ARE UNTOUCHED -- the sandbox gate (host or join, before any room exists) and
          the lobby's own panel. Both are surfaces where there is genuinely no room yet, which is the only
          state this component has anything to say in. */}
      {spectator ? (
        <div style={styles.spectatorNotice}>
          👁 Watching game #{gameId}. Board, ledger and market are live; every action
          control is hidden. Join a room from the lobby to play.
        </div>
      ) : (
      <ContextualActionBar
      /* Design note #899: any player may close a finished room; the reducer takes the first.
         PASSED EVEN WHEN CLOSED, because the bar disables it rather than dropping it -- the first
         draft here passed `undefined` once closed, which made the button vanish and contradicted
         the note in `ContextualActionBar` saying it stays. The handler is inert then anyway: the
         reducer refuses a second `CloseRoom`. */
      onCloseRoom={() => closeRoom("manual")}
      roomClosed={roomClosed}
        /* Design note #500: `latestFeedItem`/`onOpenActivityLog`
           are gone. The bar no longer echoes the activity log --
           `TopTicker` above carries it, from this same
           `latestFeedItem`. */
        roundType={gameState?.current_round_type ?? null}
        /* Design note #517: the board's own round numbering, from
           the same two fields `ContextualSubPanel` prints as
           "OR n.m". `null` before the first poll. */
        /* ==================================================================
            DESIGN NOTE 889: THE OPERATING ORDER, SORTED WHERE IT IS ALREADY SORTED
           ==================================================================
           `sortForOperatingOrder` is the authority (#285: reproducing the sort is what let the
           roster table re-sort mid-round while the frozen queue did not budge), so the bar is
           handed the result rather than the ingredients.
           `done` IS AN INDEX COMPARISON against `active_corporation_index`, which is the same
           cursor `actionLog.ts` and `dividendGate.ts` read -- not a second reading of who has
           acted. */
        operatingOrder={
          gameState && gameState.current_round_type === "OperatingRound"
            ? gameState.active_operating_order.map((companyId, index) => ({
                companyId,
                ticker:
                  gameState.public_companies.find(
                    (entry) => entry.company_id === companyId,
                  )?.ticker ?? `#${companyId}`,
                color: stationTickerColor(companyId),
                done: index < gameState.active_corporation_index,
              }))
            : []
        }
        /* Design note #890: the depot, unconditionally. The buy PANEL is Hardware-only; the
           rust and limit countdowns are not, and reading them off `trainPurchase` is what made the
           limit badge vanish when the step turned rather than when the threshold cleared. */
        depot={depot}
        // Design note #1033: the rust countdown's wording, and whether that badge pulses.
        gentleRust={resolveVariants(gameState?.variants).gentleRust}
        orSequence={
          gameState
            ? {
                cycle: gameState.macro_round_number,
                index: gameState.sub_round_index,
              }
            : null
        }
        // Design note #390: the bar compares these two and
        // replaces itself with a Return button when the player is
        // on another round's playing surface.
        activeTab={activeMainTab}
        onSelectTab={setActiveMainTab}
        /* Design note #1094: the DISPLAYED step, which is the live one except while a run of automatic skips
           is resolving -- see `displayedSubPhase`. Everything else in this shell still reads `orSubPhase`;
           this is a rendering decision and not a second cursor. */
        orSubPhase={displayedSubPhase}
        // Controls go dead off-turn so a player is not invited to click what the dispatch gate will refuse.
        // See docs/ai_architecture/session_keys_wallet.md - App.tsx #536
        sessionReady={controlsEnabled && isMyTurn}
        // WaterfallPass and PassTurn are different contract messages, not one action with two names.
        // See docs/ai_architecture/contract_economy.md - App.tsx #31
        onPassTurn={isWaterfallPhase ? handleWaterfallPass : handlePassTurn}
        /* Design note #717: offered only where a standing pass means something.
           Design note #728: but never WITHDRAWN while one is standing. `isWaterfallPhase` used to
           return `null` here, deleting the control outright -- and an arm can survive into the
           auction, so the one place a player could not reach the off switch included a phase where
           it was still notionally live. The bar decides what to show from `armed`. */
        autoPass={
          isWaterfallPhase && autoPassArm === null
            ? null
            : {
                armed: autoPassArm !== null,
                /* Design note #1036: `controlsEnabled` ALONE, deliberately not the `sessionReady`
                   below it. That one is `controlsEnabled && isMyTurn`, which is right for Pass and
                   wrong for a standing instruction: arming writes local state and the dispatch it
                   causes happens on this player's own turn, which the acting effect tests for
                   itself. Gating it on the turn made the control dead for the whole round except
                   the one turn a player least needs it. */
                canArm: controlsEnabled,
                onOpenSettings: () => setAutoPassOpen(true),
                onDisarm: handleDisarmAutoPass,
              }
        }
        /* Passing is always legal: an all-pass round is what marks the cheapest private down $5. A live mini-auction is still blocked - it has its own cursor and message.
           See docs/ai_architecture/contract_economy.md - App.tsx #311 */
        /* Design note #751: the mandatory purchase is enforced HERE, on Pass, rather than by an
           unskippable modal. The obligation is to acquire a train; buying from a rival discharges
           it just as well as the Depot does, and #3's undismissable modal made that unreachable. */
        passDisabledReason={
          /* Design note #763: FIRST, because it outranks every other reason -- while a home token
             is owed nothing may happen at all, and a player told about some later rule would fix
             that one and still find the button dead. */
          homeTokenBlock({
            state: gameState ?? ({ public_companies: [] } as never),
            homeHexToAxial,
            labelForAddress: (address) =>
              sandboxPlayerLabel(address) ?? truncateAddress(address),
          }) ??
          (isWaterfallPhase && waterfallState?.mini_auction
            ? "A mini-auction is running — use Drop out on the highlighted company card to leave it."
            : /* Design note #759, rule (iii): a player who owes a sell-down may not pass either.
                 Ahead of the train obligation because the two cannot both apply -- one is a Stock
                 Round debt and the other an Operating Round one -- and reading the seat's debt
                 first keeps the Stock Round's refusal from depending on an unrelated check. */
              divestmentRefusal(
                divestmentDebt({
                  state: gameState ?? ({ current_round_type: null } as never),
                  player: viewerAddress ?? "",
                  marketPrices: sandboxMarketPrices,
                  zoneForPrice: marketZoneForPrice,
                }),
              ) ??
              trainPurchaseRefusal({
                atHardwareStep:
                  gameState?.current_round_type === "OperatingRound" &&
                  orSubPhase === "Hardware",
                trainless: trainlessAndReported,
                couldRunARoute: couldRunARouteIfItHadATrain,
                ticker: activeCorporationContext?.ticker ?? "This corporation",
              }))
        }
        /* Design note #745: read off the replayed state, not off a React flag. The bar is a
           narrator (#400/#685) -- the reducer decides whether the turn has an action in it, and
           an Undo that rewinds past the sale must take the "End Turn" label back with it. */
        turnActionTaken={gameState?.turn_action_taken === true}
        onPlaceStationTokenHint={handlePlaceStationTokenHint}
        stationTokenCost={stationTokenCost}
        /* Design note #707: the same probe the Routes panel's Auto Route runs, so the button and
           the search cannot disagree about whether a run exists. */
        maxRouteRevenue={maxRouteRevenue}
        activeCorporation={activeCorporationContext}
        /* Design note #673: the previewed lay, as the card's provisional
           treasury. `after` is non-null here because `pendingLayCost` only
           survives with a positive fee, which needs a known balance. */
        pendingTreasury={
          pendingLayCost && pendingLayCost.after !== null
            ? { fee: pendingLayCost.fee, after: pendingLayCost.after }
            : null
        }
        onSkipSubPhase={handleSkipSubPhase}
        /* Design note #715: the sheet renders in the bar now. */
        privatePurchase={
          gameState
            ? {
                buyerTicker:
                  gameState.public_companies.find(
                    (c) => c.company_id === actingProtocolId,
                  )?.ticker ?? "This corporation",
                privates: gameState.private_companies ?? [],
                treasury: Number(
                  gameState.public_companies.find(
                    (c) => c.company_id === actingProtocolId,
                  )?.treasury ?? 0,
                ),
                labelForAddress: (address: string) =>
                  sandboxPlayerLabel(address) ?? truncateAddress(address),
                /* Design note #779: `seatColor` wants the roster INDEX and the panel is given a
                   lookup by address, so the resolution happens here where both exist. `null` for
                   an address off the roster rather than a fallback colour -- on a table where
                   colour identifies a person, a wrong colour is worse than none. */
                colorForAddress: (address: string) => {
                  const seat = gameState.player_addresses.indexOf(address);
                  return seat === -1 ? null : seatColor(address, seat);
                },
                onPropose: handleProposePrivatePurchase,
              }
            : null
        }
        onOpenPrivateTrade={() => undefined}
        /* Design note #833: the Lay Track step's destination -- the board pane itself, and ONLY
           while the Rail Map tab is the one showing. `boardEl` is the Stock Market's chart on that
           tab (both render `boardPane`), and jumping a player to the market chart because they
           asked for the map is #831's mistake in a smaller size. `null` elsewhere, which is what
           `onShowMap` exists to resolve. */
        mapEl={activeMainTab === "map" ? boardEl : null}
        onShowMap={handleShowMap}
        /* Design note #987: `onFrameNetwork`/`canFrameNetwork` are GONE. The Lay Track button now
           switches to the Rail Map tab and does nothing else -- no camera move, no page scroll. */
        /* Design note #846: the same offers the board rings, so the chip and the hue ring cannot
           disagree about whether a power is available. Empty outside Lay Track by construction --
           `dhPower`/`cslPower` report the lay unavailable once it is spent or forfeited. */
        /* Design note #871: the hex powers in an Operating Round, the M&H in a Stock Round. The two
           lists are disjoint by round, so this concatenation never shows both. */
        powerOffers={[...privatePowerOfferList, ...stockRoundPowerOffers]}
        onUsePowerOffer={handleChipPowerOffer}
        /* Design note #817: the named exit from an armed private power. `errandCancelLabel`
           returns `null` for the compulsory home station, which collapses the whole control. */
        armedErrand={
          errandCancelLabel(homeStationPlacement)
            ? {
                label: errandCancelLabel(homeStationPlacement) as string,
                onCancel: () => setHomeStationPlacement(null),
              }
            : null
        }
        ownsAnyTrain={ownsAnyTrain}
        mustBuyTrain={mustBuyTrain}
        /* Design note #570: the acting seat's colour, so the bar
           is as findable in a Stock Round as an Operating Round
           bar already is. `null` in an OR, which has the
           corporation's livery instead. */
        actingSeatColor={
          gameState &&
          (gameState.current_round_type === "StockRound" ||
            gameState.current_round_type === "WaterfallAuction")
            ? (() => {
                const acting = actingAddress(gameState, waterfallState);
                if (!acting) return null;
                const seat = gameState.player_addresses.indexOf(acting);
                return seat === -1 ? null : seatColor(acting, seat);
              })()
            : null
        }
        activePlayerName={activeSeatLabel}
        activePlayerCash={activeSeatCash}
        activePlayerEscrow={activeSeatEscrow}
        privateCompanies={gameState?.private_companies ?? []}
        /* ==================================================================
             DESIGN NOTE 885: SIX PROPS LEAVE WITH THE POWERS PANEL
           ==================================================================
           `privatePowerViewer`, `sandboxMode`, `usedPrivateAbilities`, `privateActionBlocks`,
           `onUsePrivateAbility` and `privateAbilityError` existed for one child, and the bar was a
           CONDUIT for all six -- it read none of them. #508's note names that arrangement where it
           is right ("the bar is a conduit for these, not a reader of them"), and the test of
           whether it is still right is whether the child is still there.
           `privateCompanies` STAYS because the bar genuinely reads it, in the rust/limit warnings
           memo. That is the difference between a prop that was passing through and one that
           arrived. */
        onRunTrains={handleRunTrains}
        onPayDividends={handlePayDividends}
        onWithholdRevenue={handleWithholdRevenue}
        /* Design note #508: the Buy Trains panels are rendered BY
           the bar now, so they inherit its stickiness and travel
           with it. Passed as one object -- the bar is a conduit for
           these, not a reader of them. */
        trainPurchase={
          gameState && orSubPhase === "Hardware"
            ? {
                depot,
                buyer:
                  gameState.public_companies.find(
                    (company) => company.company_id === actingProtocolId,
                  ) ?? null,
                companies: gameState.public_companies,
                canAct:
                  sandbox ||
                  (viewerAddress !== null &&
                    gameState.public_companies.find(
                      (company) => company.company_id === actingProtocolId,
                    )?.president === viewerAddress),
                blockedReason: trainOffers.some(
                  (offer) => offer.buyer_protocol_id === actingProtocolId,
                )
                  ? "One offer at a time — answer or rescind the outstanding one first."
                  : null,
                onBuyFromBank: handleBuyTrainsFromBank,
                /* ==================================================================
                    DESIGN NOTE 1101: THE SAME AUTHORITY THE AUTO-SKIP ASKS
                   ==================================================================
                   RULED: the Pay button should say "and End Turn" when the buy fills the train limit, "so
                   they know why they finished."
                   WHETHER IT DOES is #876's question and belongs to the step list, not to the panel:
                   `autoSkipExit` answers "end-turn" only when the step being skipped is the LAST one, and
                   `stepsFor` varies -- it drops `BuyPrivate` once the last private is bought. Asked here,
                   where `gameState` is, so the button and the auto-skip cannot disagree about whether the
                   turn is over. */
                endsTurnAtLimit: autoSkipExit("Hardware", stepsFor(gameState)) === "end-turn",
                /* Design note #751c: the button that replaces #3's unskippable modal. It is
                   offered exactly when a plan exists, which is the same condition the modal
                   itself used -- so nothing changed about WHEN the emergency applies, only about
                   who opens it. */
                onEmergencyPurchase: () => setEmergencyModalOpen(true),
                emergencyAvailable: emergencyPurchasePlan !== null,
                onProposeTrade: handleProposeTrainTrade,
                labelForAddress: (address: string) =>
                  sandboxPlayerLabel(address) ?? truncateAddress(address),
                /* Design note #914: the SAME resolution #779 already does for the private-purchase
                   panel -- `seatColor` wants a roster index and the panel asks by address, so it
                   happens here where both exist. `null` off the roster rather than a fallback: a
                   wrong colour on a table where colour identifies a person is worse than none. */
                colorForAddress: (address: string) => {
                  const seat = gameState?.player_addresses.indexOf(address) ?? -1;
                  return seat === -1 ? null : seatColor(address, seat);
                },
              }
            : null
        }
        dividendRevenue={dividendRevenue}
        dividendRevenueIsThisTurn={dividendRevenueIsThisTurn}
        dividendPerShare={dividendPerShare}
        dividendPayouts={dividendPayouts}
        rustOutlookForBar={currentRustOutlook}
        dividendPrice={dividendPrice}
        payProjection={payProjection}
        withholdProjection={withholdProjection}
        dividendMoveSteps={dividendMoveSteps}
        selectedHardwareModel={selectedHardwareModel}
        onEndOperatingTurn={handleEndOperatingTurn}
        onUndoLastAction={handleUndoLastAction}
        /* Design note #592c/#592d: one reason string, and it does
           NOT include "it is not your turn" -- see the prop. */
        undoBlockedReason={undoBlockedReason}
        /* Design note #595: seats take turns in the auction and the
           Stock Round; an Operating Round's queue names
           corporations and has its own step trail. */
        seatOrderTrail={
          gameState &&
          (gameState.current_round_type === "StockRound" ||
            gameState.current_round_type === "WaterfallAuction") ? (
            <SeatOrderTrail
              /* Design note #690: figures for EVERY seat. #639 had the trail
                 suppress them on the lit segment, back when it sat directly above
                 the seat card; #630 moved it under the round label and the
                 adjacency that justified the hole went with it. The caller always
                 passed all of them -- the suppression was, and is, the
                 component's own decision. */
              seats={gameState.player_addresses.map((address, index) => ({
                address,
                label: sandboxPlayerLabel(address) ?? truncateAddress(address),
                color: seatColor(address, index),
                available: seatFunds.get(address)?.available,
                escrowed: seatFunds.get(address)?.escrowed,
                // Design note #610: derived from the pass counter,
                // so it clears itself the moment anybody trades.
                passed: passedSeats.has(index),
              }))}
              activeAddress={actingAddress(gameState, waterfallState)}
              priorityAddress={
                gameState.player_addresses[gameState.priority_deal_index] ?? null
              }
              viewerAddress={viewerAddress ?? null}
            />
          ) : null
        }
        phase={currentPhase}
        // Design note #493: an action, not a mode.
        onAutoRoute={handleAutoRouteAgain}
        onSelectRouteTrain={handleSelectRouteTrain}
        highlightedRouteIndex={highlightedTrainIndex}
        onHighlightRoute={setHighlightedTrainIndex}
        /* Design note #740: the acting president reads their OWN drafts; everybody else reads the
           presence channel. One prop, two sources, because the bar renders the same row either way --
           which is what #739 meant by building it so live drafts would be a data swap. */
        trainDrafts={isMyTurn ? trainDrafts : rivalTrainDrafts}
        activeTrainIndex={activeTrainIndex}
        routeFeedback={routeFeedback}
        onClearRoute={handleClearRoute}
        // Design note #1024: the granular edit the report asked for.
        onRemoveRouteStop={handleRemoveRouteStop}
        stopsRemovedByRemoval={stopsRemovedByRemoval}
        currentGlobalEra={gameState?.current_global_era ?? null}
        isMyTurn={isMyTurn}
        // Design note #1008: the ATTENTION flag, separate from the rules flag beside it.
        turnGlowActive={turnGlowActive}
      />
      )}

      {/* Design note #1084: the tabs sit DIRECTLY on top of the viewport, which is the third item of the
         ruled order and the reason nothing else may be inserted below this point. */}
      <MainTabBar
        activeTab={activeMainTab}
        onSelect={setActiveMainTab}
        roundType={gameState?.current_round_type ?? null}
        onOpenTutorials={() => setTutorialLibraryOpen(true)}
      />
      {/* Design note #158: the on-demand reader. Rendered alongside the four
          auto-opening modals rather than inside the tab bar -- it is a modal
          over the whole shell, not a part of the navigation that summons
          it. */}
      <TutorialLibrary
        open={tutorialLibraryOpen}
        onClose={() => setTutorialLibraryOpen(false)}
      />

      {/* In-place accordion ticker + inline control strip -- design notes #18-#20. Docked below the nav tabs
         (#20/item 3), full-width, visible on every tab. No modal: the old Feed Overlay is gone, replaced by
         `TopTicker`'s own in-place accordion body. `InlineQuickChat` sits below it, always mounted regardless of
         expansion, sharing the same draft/filter state the preview and history both read from. */}
      {/* Design note #581: THE LOG IS A STATUS LINE, NOT A HEADLINE. The ticker and the action bar want opposite
         things from the reader -- one is what you MUST DO, the other what HAS HAPPENED -- and stacked at the top
         they compete, which is why putting the ticker inside the bar made things worse (#490).
         A status line at the bottom edge is what every IDE converges on for this content: peripheral, always
         present, never modal, and needing no dismissal at 1830's event volume.
         FIXED, so it survives scrolling. The app root carries matching bottom padding, and the box is anchored
         at the bottom rather than sized -- so the expanded history grows UPWARD instead of off the screen. */}
      <div ref={statusDockRef} style={styles.statusLineDock}>
        <TopTicker
          latestItem={latestFeedItem}
          items={filteredFeedItems}
          unreadCount={unreadFeedCount}
          isExpanded={isTickerExpanded}
          onToggleExpand={handleToggleTickerExpand}
          chatOpen={isChatOpen}
          onToggleChat={() => setIsChatOpen((open) => !open)}
        />
        {/* Design note #598: the input and its filter pills are the two rows
            that made the dock taller than the action bar. They appear on
            request and while the log is open -- reading the history is when
            filtering it means anything. */}
        {(isChatOpen || isTickerExpanded) && (
          <InlineQuickChat
            draft={chatDraft}
            onDraftChange={setChatDraft}
            onSend={handleSendChatMessage}
            filter={feedFilter}
            onFilterChange={setFeedFilter}
          />
        )}
      </div>

      {isWorkspaceTab && (
        <>
          {/* Design note #18/item 1: the old fixed-width left sidebar
              (ActivityFeed) is removed entirely -- `canvasPane` now renders
              directly, claiming the panel's full available width. */}
          {/* Design note #833: this is NOT the jump destination, and #831 made it one by mistake. See
              `boardEl`, which is the board pane the bar observes.
              Design note #1084: the clause "-- the bar renders inside here" is GONE, because it no longer
              does. That clause was the whole of #833's reasoning, and leaving it would have left a note
              explaining a layout that had moved out from under it. */}
          <main style={styles.canvasPane}>

            {isWaterfallPhase && activeMainTab === "phase" ? (
              /* && activeMainTab === "stock" is the fix: this branch sits inside isWorkspaceTab, so the auction replaced the workspace on the Rail Map tab too.
                 See docs/ai_architecture/ui_shell_layout.md - App.tsx #27 */
              <WaterfallAuctionDashboard
                waterfallState={waterfallState}
                loading={waterfallStateLoading}
                error={waterfallStateError}
                gameState={gameState}
                connectedWalletAddress={viewerAddress}
                playerLabel={sandbox ? sandboxPlayerLabel : undefined}
                // Design note #30 in that file: pass-and-play has no wallet
                // to compare a turn against, so the seat on turn is always
                // the one this keyboard may act for.
                /* Design note #578: `hotseat` gone -- every seat is a browser. */
                settledPrices={settledPrivatePrices}
                // Design note #306 in that file: the auction is over and
                // somebody has to open the Stock Round. Sandbox only --
                // a live chain advances its own round, and a client button
                // there would be a lie.
                onProceedToStockRound={sandbox ? handleProceedToStockRound : undefined}
                sessionReady={controlsEnabled}
                onBuyLowest={handleWaterfallBuyLowest}
                onBidHigher={handleWaterfallBidHigher}
                onMiniAuctionRaise={handleWaterfallMiniAuctionRaise}
                onMiniAuctionPass={handleWaterfallMiniAuctionPass}
                /* Handed in as a prop, not hung underneath: the slot the cards belong in is inside the dashboard.
                   See docs/ai_architecture/stock_market.md - App.tsx #604 */
                playersPanel={playersPanel}
              />
            ) : (
              <>
                {/* Audit G-15: train trading, shown only during Buy Trains. Safe to gate this tightly because an offer can
                   only be CREATED in Hardware and blocks the buyer's turn there while outstanding
                   (`operations::PendingTrainOfferBlocksTurn`) -- so it cannot outlive the phase that produced it.
                   `orSubPhase` tracks the ACTIVE corporation's step, not the viewer's, so a seller still sees this during
                   the buyer's Hardware phase, which is the only time their answer is wanted. */}
                {/* Design note #203: the Buy Trains step's own panel -- the
                    bank depot and the corporate marketplace, in that order,
                    with the second collapsed. Same `orSubPhase === "Hardware"`
                    gate the offer ledger below uses. */}
                {/* Design note #419: THE TRAIN PANELS BELONG TO ONE TAB. The gate `current_round_type === "OperatingRound"
                   && orSubPhase === "Hardware"` is a precise statement about WHEN this panel applies and says nothing
                   about WHERE -- and this branch sits inside `isWorkspaceTab`, true for four tabs, so during Buy Trains it
                   rendered on all four including the two whose entire subject is share trading.
                   This is #27's bug again: that note fixed the auction hijacking the Rail Map by adding a tab test to a
                   condition that had only a phase test, and wrote down the lesson. The Stock Round panel learned it.
                   `surfaceTabFor("OperatingRound")` rather than a literal `"map"`, so if the round's home tab moves this
                   follows it instead of quietly pointing at the wrong surface. */}
                {/* Design note #508: `TrainPurchasePanel` used to mount here. It is rendered BY the bar now, so it inherits
                   the bar's stickiness and travels with the player -- which is also what retired #491's jump button. */}
                {/* Design note #233: THE LEDGER APPEARS WHEN THERE IS ONE. This rendered on every Hardware step, empty,
                   reading "No offers outstanding" -- a permanent panel whose permanent content was that it had nothing to
                   show, sitting directly under the purchase panel.
                   A pending offer is an EVENT: it arrives, blocks a turn, gets answered and goes away. The gate is scoped
                   to offers the VIEWER is party to rather than any offer in the room, because this is where they ANSWER
                   one. `TrainTradePanel #1`'s "a pending offer is public information" is still true and is what the Action
                   Log carries; a dedicated panel on the buy screen is a different claim -- that you have something to do. */}
                {/* Design note #419: the offer ledger is the purchase panel's sibling and leaked identically -- same phase
                   gate, same missing tab gate, same four tabs. Fixed together, because a fix that left the ledger bleeding
                   onto the Stock Market tab would have answered the report rather than the bug. */}
                {activeMainTab === surfaceTabFor("OperatingRound") &&
                  gameState?.current_round_type === "OperatingRound" &&
                  orSubPhase === "Hardware" &&
                  viewerTrainOffers.length > 0 && (
                  <TrainTradePanel
                    // Design note #6 in that file: the compose form moved to
                    // `TrainPurchasePanel`; this renders the offer LEDGER.
                    composeEnabled={false}
                    offers={trainOffers}
                    companies={(gameState?.public_companies ?? []).map((company) => ({
                      company_id: company.company_id,
                      ticker: company.ticker,
                      president: company.president ?? null,
                      // Audit G-15c: drives the greyed-out model options.
                      // Passed through UNCHANGED, `undefined` included --
                      // that value means "this chain doesn't say", and the
                      // panel treats it differently from an empty list.
                      owned_train_models: company.owned_trains,
                    }))}
                    activeProtocolId={
                      gameState.active_operating_order[gameState.active_corporation_index] ?? null
                    }
                    connectedAddress={viewerAddress}
                    sessionReady={controlsEnabled}
                    onMakeOffer={handleMakeTrainOffer}
                    onAccept={handleAcceptTrainOffer}
                    onReject={handleRejectTrainOffer}
                    onRescind={handleRescindTrainOffer}
                  />
                )}

                {/* Stock Round panel -- requirement 1's "directly above the Stock Market Matrix", gated on a live Stock
                   Round (the Waterfall bypasses this branch entirely).
                   ALSO gated on the stock tab (design note #27), caught while fixing that one: this panel is not exclusive
                   -- it renders ABOVE the canvas rather than instead of it -- but its eight-card roster pushed the rail
                   map most of a screen down, and "visible if you scroll far enough" is not the Rail Map tab doing its job. */}
                {/* Design note #41: gated on the TAB alone, not on the round. The roster is a reference surface -- "what do
                   I own and what is it worth" does not stop being a question when the Stock Round ends. Its Buy/Sell
                   controls are separately gated, so an out-of-phase viewer reads but cannot act. */}
                {activeMainTab === "corps" && (
                  <StockRoundPanel
                    /* ==================================================================
                        DESIGN NOTE 948: THE LOCK IS RESOLVED ONCE, HERE
                       ==================================================================
                       `boIsLocked` is the authority (#904) and `sharePurchase` already asks it on the dispatch
                       path. The panel is handed the ANSWER rather than the inputs, so there is one place that
                       decides whether the B&O is tradeable -- a card that re-derived it from `variants` and
                       `private_auction_complete` would be the second implementation of a rule, and this
                       codebase's recurring fault is exactly that.
                       MATCHED BY TICKER, not by a hard-coded id: `BO_TICKER` is what `grantBOPresidency` and
                       `boPresidencyRefusal` both key on, and company ids are the sandbox's own numbering. */
                    lockedCompanyIds={
                      gameState &&
                      boIsLocked(
                        resolveVariants(gameState.variants),
                        gameState.private_auction_complete,
                      )
                        ? gameState.public_companies
                            .filter((entry) => entry.ticker === BO_TICKER)
                            .map((entry) => entry.company_id)
                        : []
                    }
                    publicCompanies={gameState?.public_companies ?? []}
                    // Design note #395 in that file: each card lists the
                    // privates its own corporation holds, expandable to
                    // their rules text.
                    privateCompanies={gameState?.private_companies}
                    // Design note #398: a lookup, not one shared string.
                    parValueFor={parValueFor}
                    // Design note #356/#357: the round number bans SR1
                    // sales; the acting seat's cash gates every buy.
                    macroRoundNumber={gameState?.macro_round_number}
                    playerCash={activeSeatCash}
                    onSelectParValue={handleSelectParValue}
                    onBuyShare={handleBuyShare}
                    purchaseBlockFor={purchaseBlockFor}
                    saleBlockFor={saleBlockFor}
                    salePriceAfter={salePriceAfter}
                    onSellShares={handleSellShares}
                    sessionReady={controlsEnabled}
                    isMyTurn={isMyTurn}
                    connectedAddress={viewerAddress}
                    // Design note #31 in that file: powers the front-face
                    // operating snapshot -- train limit and which tier is
                    // about to rust.
                    phase={currentPhase}
                    outlook={currentRustOutlook}
                    // Market price is separate data from the ownership registry; a live game passes undefined and the roster renders a dash. Read the live atom, not the frozen constant.
                    // See docs/ai_architecture/stock_market.md - App.tsx #247
                    marketPrices={sandbox ? sandboxMarketPrices : undefined}
                    playerLabel={sandbox ? sandboxPlayerLabel : undefined}
                    /* Design note #578: `hotseat` gone -- every seat is a browser. */
                    // Design note #34 in that file: the header names the
                    // seat that is up rather than telling the player to
                    // wait for themselves.
                    activePlayerLabel={activeSeatLabel}
                    /* Design note #682: the acting seat's own colour, for the treasury
                       projection under Buy/Sell. Resolved the same way the action bar's
                       seat card resolves it, so one player is one colour on both. */
                    actingSeatColor={(() => {
                      if (!gameState) return null;
                      const acting = actingAddress(gameState, waterfallState);
                      if (!acting) return null;
                      const seat = gameState.player_addresses.indexOf(acting);
                      return seat === -1 ? null : seatColor(acting, seat);
                    })()}
                    // Design note #41: the roster is readable in every
                    // phase, but shares only trade in a Stock Round.
                    // Design note #464: the card-order boundary.
                    roundType={gameState?.current_round_type ?? null}
                    actionsLockedReason={
                      gameState?.current_round_type === "StockRound"
                        ? null
                        : "Viewing only — shares can be bought and sold during a Stock Round."
                    }
                  />
                )}

                {/* Design note #602: the Stock Round's player-card mount point, between the corporation cards and the board
                   pane -- they are two halves of one screen, and the players belong under the companies they hold. Defined
                   once near the top of this render; see #563/#602 there for the guard. */}
                {playersPanel}

                {/* Design note #28: the phase tab renders NO reference board. Its content is the phase panel above, and the
                   market chart has its own tab -- rendering the chart here too is what the old single-tab design did, and
                   it is precisely the conflation this note split apart. */}
                {/* Design note #45: AN ALLOWLIST, NOT A DENYLIST. This read `activeMainTab !== "phase"`, which silently
                   assumed the only workspace tabs were the phase surface, the map and the chart -- so adding `"corps"`
                   (#41) opted it in by default and rendered a second Stock Market matrix under the corporation cards.
                   Naming the two tabs that OWN a board means a future tab has to ask for one rather than inherit it. */}
                {/* `RadialTileSelector` design note #1: the ring anchors to the board pane's live rect rather than to the
                   viewport, so a page scroll moves the two together. A callback ref, so a re-mount re-measures rather than
                   holding a stale node. */}
                {(activeMainTab === "map" || activeMainTab === "stock") && (
                <div style={styles.boardPane} ref={setBoardEl}>
                  {activeMainTab === "map" ? (
                    <HexGridRenderer
                      // Design note #723: so the red cost badge clears when the ground is PAID FOR, which is
                      // the same moment the reducer stops charging for it.
                      terrainFeesPaid={gameState?.terrain_fees_paid}
                      mapGrid={mapGrid}
                      // Withholding the four interceptor props is the MECHANISM, not tidiness: route mode, token targeting, preview rotation and being outside Lay Track all want the raw click. Sandbox withholds them to force the offline catalog path (#24).
                      // See docs/ai_architecture/canvas_rendering.md - App.tsx #519
                      queryClient={
                        !tileInspectorArmed ||
                        routeSelectMode ||
                        tokenTargetMode ||
                        /* Design note #440/#444: a TOKEN placement owns the
                           board and the picker must not open over it. The
                           tile errand is the opposite -- it needs the picker,
                           so it deliberately does not disarm here. */
                        (homeStationPlacement !== null &&
                          homeStationPlacement.kind !== "private-tile") ||
                        previewRotateArmed ||
                        spectator ||
                        sandbox
                          ? undefined
                          : queryClient
                      }
                      contractAddress={
                        !tileInspectorArmed ||
                        routeSelectMode ||
                        tokenTargetMode ||
                        previewRotateArmed ||
                        sandbox
                          ? undefined
                          : CONTRACT_ADDRESS
                      }
                      gameId={
                        !tileInspectorArmed ||
                        routeSelectMode ||
                        tokenTargetMode ||
                        previewRotateArmed
                          ? undefined
                          : gameId
                      }
                      protocolId={
                        !tileInspectorArmed ||
                        routeSelectMode ||
                        tokenTargetMode ||
                        previewRotateArmed
                          ? undefined
                          : actingProtocolId
                      }
                      cursorMode={
                        /* A home placement arms the same crosshair the ordinary token step uses; a private-tile errand keeps the default cursor (#444).
                           See docs/ai_architecture/canvas_rendering.md - App.tsx #440 */
                        (homeStationPlacement &&
                          homeStationPlacement.kind !== "private-tile") ||
                        tokenTargetMode
                          ? "token"
                          : "default"
                      }
                      /* Read from the same two sources as cursorMode, in the same order, or the pointer wears the wrong livery.
                         See docs/ai_architecture/canvas_rendering.md - App.tsx #496 */
                      tokenCursor={stationCursorCorporation}
                      onHexClick={
                        /* A home placement is modal in intent and takes the click first; a private-tile errand does not intercept at all (#444).
                           See docs/ai_architecture/canvas_rendering.md - App.tsx #523 */
                        homeStationPlacement &&
                        homeStationPlacement.kind !== "private-tile"
                          ? handleStageFreeStation
                          : tokenTargetMode
                            ? handleTokenHexClick
                            : routeSelectMode
                              ? handleRouteHexClick
                              : previewRotateArmed
                                ? handlePreviewRotate
                                : undefined
                      }
                      onHexClickQuery={handleHexClickQuery}
                      /* Design note #866: the standing request and the board's answer. */
                      autoStageStation={autoStageStation}
                      onAutoStageStation={handleAutoStageStation}
                      /* Design note #873: the one-shot that opens the picker where the errand points. */
                      autoSelectHex={autoSelectHex}
                      /* Design note #1038: the instruction is spent once the board has carried it out. Guarded
                         on the token so a clear cannot swallow a NEWER instruction issued between the select
                         and this commit -- #873's whole reason for keying on a token rather than a
                         coordinate, applied to the other end of the handshake. */
                      onAutoSelectConsumed={(token) =>
                        setAutoSelectHex((current) => (current?.token === token ? null : current))
                      }
                      /* Design note #888: the Lay Track jump's destination, as a one-shot token. */
                      previewTile={previewTile}
                      currentEra={gameState?.current_global_era ?? "Yellow"}
                      // PublicCompanyState[] is structurally assignable to StationTokenCompany[]; omitted entirely until gameState resolves.
                      // See docs/ai_architecture/canvas_rendering.md - App.tsx #36
                      publicCompanies={gameState?.public_companies}
                      // Design note #318: the reservation badges read this
                      // roster and clear themselves when a private closes.
                      privateCompanies={gameState?.private_companies}
                      routeOverlays={manualRouteOverlay}
                      // Design note #374: the map both reads and drives the
                      // shared cursor.
                      highlightedTrainIndex={highlightedTrainIndex}
                      onHighlightRoute={setHighlightedTrainIndex}
                      // One veil, two steps - track lay lights what the network can build on, token targeting the cities it may claim. #269: whichever ring is open owns the hover anchor.
                      // See docs/ai_architecture/canvas_rendering.md - App.tsx #240
                      suppressHoverTooltip={
                        (tileInspectorArmed && radialSelector !== null) || pendingToken !== null
                      }
                      /* isMyTurn answers "is the viewer the acting corporation's president"; spread onto whichever focus is live.
                         See docs/ai_architecture/canvas_rendering.md - App.tsx #377 */
                      layFocus={
                        /* The home placement's veil dims unconditionally - it exists only because THIS viewer accepted the prompt. #472: soleFocusKey deepens it while a selector is open.
                           See docs/ai_architecture/canvas_rendering.md - App.tsx #440 */
                        homeStationFocus
                          ? { ...homeStationFocus, dim: true, soleFocusKey }
                          : layTrackFocus
                            ? { ...layTrackFocus, dim: isMyTurn, soleFocusKey }
                            : tokenTargetFocus
                              ? { ...tokenTargetFocus, dim: isMyTurn, soleFocusKey }
                              : undefined
                      }
                    />
                  ) : (
                    <StockMarketRenderer
                      /* Design note #962: the compass rose states the movement rule for THIS table's variant
                         set, not the printed one. `resolveVariants` inside the rose turns an absent config
                         into the standard game, so this passes the raw field. */
                      variants={gameState?.variants}
                      marketGrid={marketGrid}
                      // The par track is fed by par_value, so a parred but unfloated company appears on it.
                      // See docs/ai_architecture/stock_market.md - App.tsx #530
                      parredCompanies={gameState?.public_companies}
                    />
                  )}
                </div>
                )}

                {/* Automated contextual block underneath the board. */}
                <ContextualSubPanel
                  gameState={gameState}
                  // Design note #405: the footer now renders the ledger's
                  // Player Assets table, which needs the same net-worth
                  // query the ledger runs and a way to name a seat.
                  queryClient={queryClient}
                  contractAddress={CONTRACT_ADDRESS}
                  gameId={gameId}
                  playerLabel={sandbox ? sandboxPlayerLabel : undefined}
                  loading={gameStateLoading}
                  error={gameStateError}
                  // Design note #10 in that file: market price is not on
                  // `GameStateResponse`, so the Market Value column needs
                  // the grid handed to it separately.
                  marketGrid={marketGrid}
                />

                {/* Design note #670: THE OPERATING ROUND IS THE ONE ROUND THAT SHOWED NOBODY'S BALANCE.
                    `PlayerCards` render on the Stock Round and auction surfaces; an OR's surface is the Rail
                    Map, whose footer is the corporation panel. So the round in which money is actually EARNED
                    had no cash on screen at all, and "did Pay Dividends work" had no answer but the log.
                    ONLY WHERE THE CARDS ARE NOT, which keeps `ContextualSubPanel` #572's rule rather than
                    breaking it: two readouts of one dataset make the reader prove they agree. The cards carry
                    the same badge (`PlayerCards` #670), so the confirmation is continuous across a round
                    change while the table showing it is not duplicated. */}
                {/* ==================================================================
                     DESIGN NOTE 819: THE SAME CARDS, IN EVERY ROUND
                    ==================================================================

                    REQUESTED: "at the bottom of the Rail Map during the Operating Rounds, we added a 'Cash'
                    panel to show players' holdings. I think we should just make this the Players panel from
                    the Stock Round and show them everything."

                    #670 CHOSE THE STRIP OVER THE CARDS FOR TWO REASONS AND ONLY ONE OF THEM HOLDS.
                      THE ONE THAT DISSOLVES: "it is not a second ledger ... a second opinion on any of them
                      is a fact in two places, which is how the two come to disagree." That argues against a
                      NEW readout, and `PlayerCards` is not one -- it is the component the Stock Round has
                      always used, reading `playerFinances` exactly as the Ledger does. Rendering one
                      component in a second place adds no second derivation, which is what #562's rule is
                      actually about. The duplication #670 feared was already there and was already fine.
                      THE ONE THAT SURVIVES: height. "Underneath an already-tall corporation panel, on the one
                      tab where the board is competing for every vertical pixel." That is a measurement, and
                      this session has twice been wrong about a height by reasoning about it (#508, #785).
                      It is a playtest question, and if the answer is "too tall" the fix is a collapse, not a
                      second component.

                    NOTHING IS LOST IN THE SWAP, which is the part that had to be checked rather than assumed:
                    #670 threaded `cashDelta` into `PlayerCards` at the time -- "so the card asks the same
                    question the strip asks" -- so the badge that answers "did that money arrive" comes across
                    intact. Had it not, this change would have re-opened the report #670 exists for. */}
                {gameState?.current_round_type === "OperatingRound" && (
                  <PlayerCards
                    players={playerFinancesBySeat}
                    label={(address) => sandboxPlayerLabel(address) ?? truncateAddress(address)}
                    /* The seat whose corporation is operating. An OR's turn belongs to a
                       corporation and `actingAddress` already draws that line, so the cards
                       do not draw a second one. */
                    activeAddress={actingAddress(gameState, waterfallState)}
                    /* Design note #819: NO PRIORITY MARK IN AN OPERATING ROUND. The Priority Deal decides who
                       opens the next STOCK round; naming it here would answer a question nobody is asking
                       mid-OR, which is #593's own argument about the seat ordinal. */
                    priorityAddress={null}
                    viewerAddress={viewerAddress ?? null}
                    colorForSeat={(index) =>
                      seatColor(gameState.player_addresses[index] ?? "", index)
                    }
                    // Design note #1035: the same escalation the Stock Round cards carry.
                    privateClosureAlert={closureAlert}
                    privateDescription={(privateId) =>
                      PRIVATE_COMPANY_CATALOG[privateId]?.ability ?? null
                    }
                    cashDelta={cashDeltaFor}
                  />
                )}
              </>
            )}
          </main>
        </>
      )}

      {/* ==================================================================
           DESIGN NOTE 1085: `ReturnToTurnBar` IS DELETED, BECAUSE THE BAR CAME TO IT
          ==================================================================
          #427 EXISTED FOR ONE REASON, stated in its first line: "The Ledger and the Rules carry no controls,
          so `ContextualActionBar` simply vanished there -- and with it the only persistent thing on screen
          saying a turn was in progress." #1084 made that false. The bar renders on every tab now, and on a
          reference tab #390/#404 replace it with exactly one control: "Return to <the round's surface>".

          SO THESE TABS WOULD HAVE HAD TWO WAYS BACK, stacked, in two different bars -- #891's shape, which
          this codebase produces more often than any other: two surfaces answering one question two ways.

          DELETED RATHER THAN LEFT UNRENDERED. A component whose entire job is now done elsewhere is a second
          implementation waiting for a caller, and this project's own rule (#685, #425) is that those go.

          ONE BEHAVIOUR CHANGES AND IT IS WORTH NAMING. #427 rendered only while `isMyTurn`, on the argument
          that "a permanent banner ... would mean nothing". The redirect is not gated on the turn, so the
          button is there whether or not you are on. That was already true on the four workspace tabs and
          nobody minded, and the objection does not carry over: #427's was a banner that appeared from
          nowhere, whereas this is the action bar's own content in a slot that is now always present. A slot
          that emptied itself on the reference tabs would make the tab strip jump as you switched. */}
      {activeMainTab === "ledger" && (
        <FinancialLedger
          gameState={gameState}
          loading={gameStateLoading}
          error={gameStateError}
          // Player Net Worth (FinancialLedger.tsx design note #4): same
          // live query client/contract/game id every other connected panel
          // in this file already uses.
          queryClient={queryClient}
          contractAddress={CONTRACT_ADDRESS}
          gameId={gameId}
          // Design note #14 in that file: the merged Corporation Assets
          // table's Market Price column. Not on `GameStateResponse`.
          marketGrid={marketGrid}
          // Design note #405: names, not truncated addresses.
          playerLabel={sandbox ? sandboxPlayerLabel : undefined}
        />
      )}

      {/* Design note #677: the tray and its upgrade paths. `mapGrid` is the only
         input -- supply is counted off the board, and the paths are derived from
         the board's own legality filter rather than authored (`tileUpgrades.ts`
         #675). */}
      {activeMainTab === "tiles" && <TileReference mapGrid={mapGrid} />}

      {activeMainTab === "rules" && (
        <RulesReference
          /* Design note #898: `GameEnd` is deliberately NOT widened into `RulesRoundType`. That union is the
             set of rounds with a rules FLOW to show, and the ending has none -- passing `null` falls back to
             the full reference, which is what a player reading the rules after the game is looking for.
             Widening the union instead would have required inventing a flow for a round nobody plays. */
          roundType={
            gameState?.current_round_type === "GameEnd"
              ? null
              : (gameState?.current_round_type ?? null)
          }
          operatingSubPhase={orSubPhase}
        />
      )}

      {/* The floating tile-selection overlay -- `HexGridRenderer.tsx` design note #7. Rail Map tab only, and only
         once the legality query has resolved; loading/error states get a lightweight inline indicator instead.
         `position: fixed`, so it is kept as a sibling of the main layout rather than nested inside `boardPane`
         and clipped by that pane's own overflow. */}
      {activeMainTab === "map" && hexClickQuery?.status === "loading" && (
        <div
          style={{
            ...styles.hexClickIndicator,
            left: hexClickQuery.clientX + 16,
            top: hexClickQuery.clientY + 16,
          }}
        >
          Querying legal placements at {hexClickQuery.hexLabel}...
        </div>
      )}
      {activeMainTab === "map" && hexClickQuery?.status === "error" && (
        <div
          style={{
            ...styles.hexClickIndicator,
            ...styles.hexClickIndicatorError,
            left: hexClickQuery.clientX + 16,
            top: hexClickQuery.clientY + 16,
          }}
        >
          GetLegalTilePlacements failed: {hexClickQuery.message}
        </div>
      )}
      {/* Design note #141: the cue for a hex that refused the click. AMBER, not red -- nothing failed and the
         player did nothing wrong; red is reserved for the query error above, which IS a fault. Reuses the same
         floating indicator the loading/error states use, so the feedback appears where the player is already
         watching after a hex click. Auto-dismisses. */}
      {activeMainTab === "map" &&
        hexClickQuery?.status === "blocked" &&
        hexClickQuery.message !== null && (
          <div
            role="status"
            style={{
              ...styles.hexClickIndicator,
              ...styles.hexClickIndicatorBlocked,
              left: hexClickQuery.clientX + 16,
              top: hexClickQuery.clientY + 16,
            }}
          >
            🚫 {hexClickQuery.message}
          </div>
        )}
      {/* Design note #23: `!spectator` is load-bearing, not decorative. `TileSelectionPopup` is the SECOND of
         this app's two gameplay dispatch paths -- it calls `execGameplay` itself (that file's #1) rather than
         routing through `runGameplayAction`, so the gate inside that function does not cover it. Not mounting
         it is what covers it. */}
      {/* Design note #162: THE IN-SITU RADIAL SELECTOR REPLACES THE POPUP. The floating card answered "which
         tiles exist" well and "does this tile fit HERE" not at all, because judging fit means looking at the hex
         and its neighbours, and the card covered them.
         Its two branches collapse into ONE here, safely, because the distinction never lived in the presentation:
         it is carried by `provisional` and by `canConfirm`. Keeping two nearly identical JSX blocks is how the
         old spectator bug got in -- one branch grew a `!spectator` guard the other did not need.
         The file is retained, unrendered, until the radial path has been exercised against a live chain. */}
      {/* Design note #697: the action receipt. Shell level, beside the two consent prompts and for the same
         reason (#165/#166): it outlives the panel that produced it -- a purchase that advances the phase
         unmounts the depot panel, and the confirmation for that purchase must not go with it. */}
      {/* Design note #940: dead centre, `pointer-events: none`, two seconds. Rendered beside the toast and
          deliberately NOT through it -- see the component's own note for why sharing that machinery would
          have contradicted "floating text ONLY". */}
      {/* Design note #1095: CLEARED WHEN IT FINISHES, which is the half #1094 did not cover. The guard there
          stops a rebuild re-FIRING this signal; this stops a stale one being re-CONSUMED by a fresh mount --
          the flash was the only ephemeral signal in this shell with no way home, so the last one of the game
          sat here for the rest of the session waiting for something to remount. */}
      <RevenueModifierFlash signal={revenueFlash} onDone={clearRevenueFlash} />
      <ActionToast
        message={actionToast?.text ?? null}
        // Design note #738: the treasury transition, when there is one.
        detail={actionToast?.detail ?? null}
        // Design note #984: the private-revenue table, stacked and aligned rather than joined onto one line.
        detailRows={actionToast?.detailRows ?? null}
        // Design note #929: the hex pair, on the one toast that is about a colour.
        eraTransition={actionToast?.eraTransition ?? null}
        /* Design note #967: the toast that is a list gets a longer window; everything else takes the default. */
        durationMs={actionToast?.durationMs}
        // Design note #1016: the ambient toast sits in the corner; every receipt stays on the reader's axis.
        anchor={actionToast?.anchor ?? "center"}
        // Design note #1047: the one toast that waits for a click instead of a timer.
        persistent={actionToast?.persistent ?? false}
        // Design note #1048: whose it is, as a colour.
        accentColor={actionToast?.accentColor ?? null}
        token={actionToast?.token ?? 0}
        onDismiss={() => setActionToast(null)}
      />
      {/* Design notes #165/#166 argued that BOTH halves of the trade engine belong at shell level, "because
         both outlive the panel that opened them".
         Design note #715 SPLIT THAT. It is true of the PROMPT, which has to survive the sub-phase advancing
         and is mounted just below -- and it was never true of the composing sheet, which is only ever open
         during `BuyPrivate` and now renders inside the bar on exactly that condition. What outlives the step
         is the ANSWER, not the offer. */}
      {/* Design note #717: the conditions, asked at the moment of arming rather than buried in a settings
         panel -- this is the one control that acts while the player is not looking. */}
      {/* ==================================================================
           DESIGN NOTE 848/#849: ONE MODAL, WHERE THERE WERE TWO HALVES
          ==================================================================
          `DhStationPrompt` (#818) and `PrivatePowerPrompt` (#845) are both retired into this. They were the
          second step and the first step of one flow, built a report apart, which is why "only the 'Station
          Marker' modal pops up" was the report: each was doing its own job correctly and neither knew it was
          half of something.
          NOT MOUNTED WHILE THE PLACEMENT IS IN FLIGHT. #818's own condition, kept: once the player has
          accepted, the board is the thing to look at and a modal over it is asking a question already
          answered. `armedErrand` is that state, and `powerFlowOpen` refuses a completed flow. */}
      {/* Design note #866: AND NOT OVER A STAGED PLACEMENT. The flow modal is a STANDING obligation -- a
          laid D&H with an unresolved station raises it whether or not anybody asked (#849) -- so once the
          station step stages its token without an errand to hide behind, the modal would cover the very
          confirmation it just produced. `pendingToken === null` is #850's rule one layer up: a player with an
          unanswered question in front of them is not being asked a second one.
          IT IS ALSO WHAT MAKES THE X WORK. Cancelling clears the token, the obligation is still standing, and
          the modal comes back on its own -- which is exactly what was asked for. */}
      {powerFlowOpen(activePowerFlow) &&
        homeStationPlacement === null &&
        pendingToken === null &&
        activePowerFlow && (
        <PrivatePowerFlowModal
          flow={activePowerFlow}
          ticker={activeCorporationContext?.ticker ?? "This corporation"}
          tokensLeft={dhStationSupply.tokensLeft}
          /* Design note #882: THE MATCH IS THE WHOLE GUARD. Passed only when the stored refusal belongs to
             the power on screen, so the modal never has to ask -- and a refusal that belongs to another
             power is not "cleared before it shows", it is unable to show. The D&H's modal is the case that
             makes this matter: it can be raised by a STANDING OBLIGATION rather than by a click (#849), so
             there is no door to hang a clear on. */
          refusal={
            privatePowerRefusal?.abilityKey === activePowerFlow.abilityKey
              ? privatePowerRefusal.reason
              : null
          }
          onAct={handlePowerFlowAct}
          onDecline={handlePowerFlowDecline}
          onCancel={handlePowerFlowCancel}
        />
      )}
      {/* Design note #1060: the payout overlay. Not a modal and deliberately not in this stack's ordering
          argument -- it is `pointerEvents: "none"` over the board's corner, so it can coexist with anything
          the shell is showing rather than needing a turn in a queue. */}
      <DividendMoneyMachine
        event={dividendPayout}
        onCue={handleMoneyMachineCue}
        onDone={handleMoneyMachineDone}
      />
      {/* Design note #1049: the phase before any corporation acts, so it is mounted before the modal about the
          corporation that acts first. The ordering is enforced in `dueFleetNotice` (#1049a) rather than by
          this position or by z-index; source order here simply agrees with it, so a reader is not looking at
          two files that appear to disagree about which comes first. */}
      <PrivateRevenueModal
        round={privatePayoutPhase}
        roundLabel={privatePayoutPhase?.roundLabel ?? null}
        onAcknowledge={() => setPrivatePayoutPhase(null)}
      />
      {/* Design note #896: unskippable, and above everything -- the turn does not start until it is answered.
          `key` remounts it per notice so the silence checkbox re-seeds from the store for each one. */}
      <FleetLossModal
        key={dueFleetNotice ? `${dueFleetNotice.companyId}:${dueFleetNotice.cause}` : "none"}
        notice={dueFleetNotice}
        silenced={
          dueFleetNotice
            ? isNoticeSilenced(sandboxRoomCode, dueFleetNotice.companyId, dueFleetNotice.cause)
            : false
        }
        onToggleSilence={toggleFleetNoticeSilence}
        onAcknowledge={acknowledgeFleetNotice}
      />

      <AutoPassModal
        open={autoPassOpen}
        initial={autoPassChoices}
        exposedPresidencies={autoPassExposure}
        onArm={handleArmAutoPass}
        onClose={() => setAutoPassOpen(false)}
      />
      {/* The train consent prompt -- design notes #205 and #218. ONE component, TWO sources, decided by
         deployment: SANDBOX uses local state (no chain to record an offer in, no second client to show it to),
         ONLINE derives from the contract's own register so the prompt reaches the real counterparty.
         Mutually exclusive by construction, so this can never show two offers at once. */}
      <TrainTradePrompt
        proposal={liveTrainOffer?.proposal ?? sandboxTrainProposal}
        /* Online, `liveTrainOffer` only exists for the seller's president, so its presence IS the check.
           Offline the wallets are compared.
           Design note #701 removed `sandbox ||` from the middle of this expression. #536's note read "Sandbox
           names the seller so the clicker knows whose decision they stand in for" -- written when a sandbox
           was one human at one wallet. #578 removed solo mode, and this bypass turned "the seller must
           consent" into "whoever proposed it may consent for them". #662 struck the identical clause out of
           `viewerIsOwner`; this is the same line on the other prompt. */
        viewerIsSeller={
          liveTrainOffer !== null || sandboxTrainProposal?.sellerPresident === viewerAddress
        }
        onAccept={liveTrainOffer ? handleAcceptLiveTrainOffer : handleAcceptSandboxTrainOffer}
        onReject={liveTrainOffer ? handleRejectLiveTrainOffer : handleRejectSandboxTrainOffer}
      />
      <PrivateTradePrompt
        proposal={privateProposal}
        /* The owner answers in EVERY mode - the sandbox bypass turned "the owner must consent" into "whoever proposed it may consent for them".
           See docs/ai_architecture/contract_economy.md - App.tsx #662 */
        viewerIsOwner={privateProposal?.ownerAddress === viewerAddress}
        // Design note #0 in that file: `BuyPrivateCompany` has no accept
        // step, so outside sandbox this is a confirmation and says so.
        consentIsBinding={sandbox}
        /* Design note #932: the OWNER's cash, since the owner is the one being asked and the one the sale
           pays. `null` when the roster does not carry them, which renders no projection rather than one with
           a guessed end (#670). */
        recipientCash={
          privateProposal
            ? cashByPlayer(gameState)[privateProposal.ownerAddress] ?? null
            : null
        }
        onAccept={handleAcceptPrivateOffer}
        onReject={handleRejectPrivateOffer}
      />
      {/* Design note #1043: the ten-second haunting. Inert to the pointer and screen-blended, so the player
          keeps their turn and the board shows through -- both ruled, both in the component. */}
      <YellowSignOverlay
        src={haunting?.src ?? null}
        composite={haunting?.composite ?? "screen"}
        ms={haunting?.ms ?? 0}
        sfxEnabled={sfxEnabled}
      />
      {/* Design note #201: the station token's confirm ring -- the same
          component the tile selector renders through (design note #200), so
          the red X and green check are identical by construction rather
          than by matching two sets of styles. */}
      {activeMainTab === "map" && pendingToken && (
        <RadialTokenConfirm
          anchorOffsetX={pendingToken.offsetX}
          anchorOffsetY={pendingToken.offsetY}
          canvasEl={boardEl}
          hexLabel={pendingToken.hexLabel}
          /* Design note #454: a free placement costs nothing, and the ring
             says so. Quoting the escalating price on a home station would
             be the ring describing a charge that never happens -- the same
             mismatch design note #239 removed from the button. */
          cost={pendingToken.kind === "free" ? 0 : stationTokenCost}
          /* Design note #836: and what the treasury is left with, in the same sentence the terrain lay uses.
             THE PLACEMENT'S OWN CORPORATION PAYS, not the operating cursor -- #556's rule, and it matters
             more here than for the ticker: quoting the acting company's balance while charging another
             company's token would be a figure belonging to nobody in the transaction.
             A free placement projects to `null` inside `describePendingSpend`, which is #454 arriving at the
             same answer from the fee rather than from a second branch here. */
          costNote={describePendingSpend(
            pendingSpend(
              pendingToken.kind === "free" ? 0 : stationTokenCost,
              (() => {
                const payer = gameState?.public_companies.find(
                  (c) => c.company_id === (pendingToken.companyId ?? actingProtocolId),
                );
                /* `Number(...)` WITHOUT this file's usual `|| 0` tail. `pendingSpend` turns a non-finite
                   balance into "unknown" and prints the price alone, which is the honest answer; `|| 0`
                   would report a corporation as broke on a figure nobody could read. */
                return payer === undefined ? null : Number(payer.treasury);
              })(),
            ),
          )}
          /* Design note #556: the staged placement's own corporation, and
             only then the operating cursor. */
          ticker={
            gameState?.public_companies.find(
              (c) => c.company_id === (pendingToken.companyId ?? actingProtocolId),
            )?.ticker ?? "this corporation"
          }
          /* Design note #462: the actual token, in the ring. Same livery
             and the same computed ink the map draws it with. */
          liveryColor={stationTickerColor(pendingToken.companyId ?? actingProtocolId)}
          liveryInk={bestContrastTextColor(
            stationTickerColor(pendingToken.companyId ?? actingProtocolId),
          )}
          canConfirm={controlsEnabled}
          confirmDisabledReason="Initialize the session key to place a token."
          onConfirm={handleConfirmTokenPlacement}
          onCancel={handleCancelTokenPlacement}
        />
      )}
      {/* Design note #199, layer 3: not mounted outside the Lay Track step. */}
      {activeMainTab === "map" && tileInspectorArmed && radialSelector && (
        <RadialTileSelector
          anchorOffsetX={radialSelector.offsetX}
          anchorOffsetY={radialSelector.offsetY}
          // Design note #506: sizes the candidates and the ring's clearance.
          hexRadiusPx={radialSelector.hexRadiusPx}
          canvasEl={boardEl}
          hexLabel={radialSelector.hexLabel}
          candidates={radialCandidates}
          selectedTileId={previewTile?.tileId ?? null}
          orientation={previewTile?.orientation ?? 0}
          canConfirm={canLayTileNow}
          confirmDisabledReason={tileLayDisabledReason ?? undefined}
          provisional={radialSelector.provisional}
          // The ring hands back that tile's FIRST legal orientation
          // (design note #173), so the preview never opens on an angle the
          // rotate cycle would then refuse to return to.
          onSelectCandidate={(tileId, orientation) => {
            /* ==================================================================
               DESIGN NOTE 886: THE FIRST PREVIEW DERIVES LIKE EVERY OTHER
               ==================================================================
               THIS SEEDED `tokenCity` FROM `tokenDestinationChoices(...)[0]` -- #824's rule, which knows
               nothing about connectivity or orientation. Reported: "the very first preview placement is
               jumping the station to the wrong city marker, even though all subsequent rotations place it
               correctly." Exactly so: #879 taught the ROTATE path to derive and left this one behind, so the
               opening placement was the only one still using the superseded rule.
               THE CHOICE IS `undefined` HERE and that is deliberate -- the president has not rotated yet, so
               a FREE token has no chosen city and the derivation must not pick one for them.
               ==================================================================
                DESIGN NOTE 889: ...AND THEN THE SEED PICKS ONE, ON PURPOSE
               ==================================================================
               THE LINE ABOVE WAS HALF A FIX. `tokenLandingsFor` omits a free token with no chosen city, so
               the opening preview of ERIE's home upgrade drew NO MARKER AT ALL -- while a lay from that state
               sends neither a map nor an index, and the reducer's "absent means unchanged" arm leaves the
               token in the city it was already in (`sandboxSession.ts` #880). Preview and outcome disagreed,
               which is the fault class #886 exists to close, so it had simply moved rather than gone.
               A SEED IS NOT A CLAIM ABOUT THE BOARD. For a token with no network there is nothing to get
               wrong -- every city is equally legal -- so opening at the first one and letting the president
               rotate is #824's design, not #1's superseded index-preservation. An ANCHORED token is untouched
               by this: `seedPreviewArrangement` hands its derived city straight back. */
            const probe = derivePreviewLandings(
              radialSelector.q,
              radialSelector.r,
              tileId,
              orientation,
              undefined,
            );
            const seed = seedPreviewArrangement({
              orientation,
              fit: probe,
              freeCityChoices: freeCityChoices(tileCityCount(tileId)),
            });
            const landing = derivePreviewLandings(
              radialSelector.q,
              radialSelector.r,
              tileId,
              orientation,
              seed.tokenCity,
            );
            setPreviewTile({
              q: radialSelector.q,
              r: radialSelector.r,
              tileId,
              orientation,
              tokenCity: seed.tokenCity,
              tokenCities: landing.tokenCities,
            });
          }}
          legalRotationCount={legalRotations.length}
          // Design note #0 in `utils/tokenMigration.ts`: where the tokens
          // already standing on this hex end up. `null` on the ordinary
          // empty hex, which is most of them.
          tokenNote={radialTokenNote}
          /* Design note #673: the price, on the control that commits to it. Same
             `pendingLayCost` the card's provisional treasury reads. */
          costNote={pendingLayCost ? describePendingSpend(pendingLayCost) : null}
          // Design note #725a: and what this lay costs beyond its price, when it costs anything.
          warningNote={dhLayWarning}
          // Design note #488b: the caption's picture -- the same migration,
          // drawn on each candidate instead of described.
          stationMarkersFor={radialStationMarkersFor}
          /* Design note #628: the tray count for each candidate. Derived
             from the board rather than queried -- see `utils/tileSupply.ts`
             for why that arithmetic is exact and what would replace it. */
          stockFor={radialStockFor}
          onConfirm={handleConfirmRadialLay}
          onCancel={() => setPreviewTile(null)}
          /* Design note #874: present only while a private power is armed, because only then is there
             somewhere to go BACK to. An ordinary lay keeps #471's bare click-away. */
          onEscape={
            homeStationPlacement?.kind === "private-tile" ? handleDismissRadial : null
          }
          escapeTitle="Cancel this lay and go back to the power — nothing is spent."
          onDismiss={handleDismissRadial}
        />
      )}

      {/* Design note #1083: the fifth and last item of the ruled order. `marginTop: auto` on its own style
         pins it to the bottom of the root's column on a short page and lets it follow the content on a long
         one -- see `appStyles` #1083 for why it is in the flow rather than fixed like the status dock. */}
      <AppFooter />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Room routing -- design note #1                                      */
/* ------------------------------------------------------------------ */

/** Holds both ids: the contract's u64 and the Firestore room id. Neither can be derived from the other.
 *  See docs/ai_architecture/firebase_middleware.md - App.tsx #548 */

function GameRouter() {
  const [activeGame, setActiveGame] = useState<ActiveGame | null>(readActiveGame);

  useEffect(() => {
    try {
      if (activeGame) window.sessionStorage.setItem(ACTIVE_GAME_STORAGE_KEY, JSON.stringify(activeGame));
      else window.sessionStorage.removeItem(ACTIVE_GAME_STORAGE_KEY);
    } catch {
      /* private browsing -- the game still works, it just is not resumable */
    }
  }, [activeGame]);

  const handleEnterGame = useCallback((gameId: number, roomId: string) => {
    setActiveGame({ gameId, roomId, mode: "play" });
  }, []);

  const handleSpectateGame = useCallback((gameId: number, roomId: string) => {
    setActiveGame({ gameId, roomId, mode: "spectate" });
  }, []);

  /** The escape hatch needs no wallet, contract or room. #524: the sandbox room code is held above AppShell, which remounts; #551 seeds it from the session.
   *  See docs/ai_architecture/session_keys_wallet.md - App.tsx #24 */
  const [sandboxRoomCode, setSandboxRoomCode] = useState<string | null>(readActiveSandboxRoom);
  useEffect(() => {
    writeActiveSandboxRoom(sandboxRoomCode);
  }, [sandboxRoomCode]);

  const handleEnterSandbox = useCallback((roomCode?: string | null) => {
    setSandboxRoomCode(roomCode ?? null);
    setActiveGame({ gameId: SANDBOX_GAME_ID, roomId: SANDBOX_ROOM_ID, mode: "sandbox" });
  }, []);

  const handleLeaveGame = useCallback(() => setActiveGame(null), []);

  if (!activeGame) {
    return (
      <Lobby
        onEnterGame={handleEnterGame}
        onSpectateGame={handleSpectateGame}
        onEnterSandbox={handleEnterSandbox}
      />
    );
  }

  return (
    <AppShell
      // Keyed on room and mode so a room change - or a spectator joining properly - gets a genuinely fresh shell.
      // See docs/ai_architecture/firebase_middleware.md - App.tsx #551
      key={`${activeGame.gameId}:${activeGame.roomId}:${activeGame.mode}`}
      gameId={activeGame.gameId}
      roomId={activeGame.roomId}
      mode={activeGame.mode}
      // Design note #524: `null` for every mode but a joined sandbox room.
      sandboxRoomSeed={activeGame.mode === "sandbox" ? sandboxRoomCode : null}
      onLeaveGame={handleLeaveGame}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Root export -- Provider wrapping, per design note above             */
/* ------------------------------------------------------------------ */

export default function App() {
  return (
    <WalletProvider>
      <GameSessionProvider>
        <GameRouter />
      </GameSessionProvider>
    </WalletProvider>
  );
}

// Plain inline style objects rather than a stylesheet, matching how this was requested.
// Note inline styles cannot express :disabled - see docs/ai_architecture/ui_shell_layout.md

/** The phase badge is a neutral LABEL: era tinting competed with the amber phase-shift warnings beside it. One record per tint so a subtle cue can return.
 *  See docs/ai_architecture/ui_shell_layout.md - App.tsx #324 */