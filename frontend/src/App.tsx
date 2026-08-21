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
import { liveEdgesForHex } from "./components/hexGeometry";
import { assignRouteSet, bridgeWaypoints } from "./utils/routeAutoTrace";
import { layableHexes, reachableNetwork } from "./utils/trackReach";
import { dividendDeclaration } from "./utils/dividendStep";
// Design note #591f: `actingActor` went with the snapshot stack it stamped.
import { countPhrase, describeGameplayAction } from "./utils/actionLog";
import { STATIC_BOARD_HEXES } from "./components/hexBoardData";
import {
  bestContrastTextColor,
  stationTickerColor,
  // Design note #496: the fallback ticker for a corporation the live
  // response has not named, so the cursor still carries a herald.
  stationTickerLabel,
} from "./components/hexContractTypes";
import {
  type PrivateAbility,
  type PrivateAbilityAction,
} from "./components/PrivatePowerPanel";
import { corporationPrivateCompanies } from "./utils/gameState";
import type { TrainRouteDraft } from "./components/RoutePlannerPanel";
import {
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
  isOpenStockRoundMsg,
  isPlaceHomeStationMsg,
  isExchangePrivateMsg,
  isProposePrivatePurchaseMsg,
  isAnswerPrivatePurchaseMsg,
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
  parBoxCellFor,
  projectDividendCellMove,
  projectDividendFrom,
  projectShareSaleMove,
  type MarketGridResponse,
} from "./components/StockMarketRenderer";
// Design note #162: `TileSelectionPopup` is no longer rendered or imported
// -- the radial selector replaced it, and its two callbacks went with it.
// The file is retained on disk, unreferenced, until the radial path has been
// exercised against a live chain.
import RadialTileSelector, { RadialTokenConfirm } from "./components/RadialTileSelector";
import {
  PrivateTradePrompt,
  ProposePrivatePurchase,
  type PrivateTradeProposal,
} from "./components/PrivateTradePanel";
import TopTicker from "./components/TopTicker";
import InlineQuickChat from "./components/InlineQuickChat";
import ContextualSubPanel from "./components/ContextualSubPanel";
import FinancialLedger from "./components/FinancialLedger";
import RulesReference from "./components/RulesReference";
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
import PlayerCashStrip from "./components/PlayerCashStrip";
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
} from "./utils/gamePhase";
import { filterSandboxPlacements, isTokenableHex } from "./components/sandboxTileLegality";
import { describeTokenMigration, previewTokenMigration } from "./utils/tokenMigration";
import type { LegalTilePlacement } from "./components/hexContractTypes";
import {
  OPERATING_SUB_PHASE_LABELS,
  OPERATING_SUB_PHASE_ORDER,
  initialOrSubPhase,
  visibleSubPhases,
  type OperatingSubPhase,
} from "./components/OperatingSubPhaseStepper";
import { useDocumentTitleFlash } from "./utils/turnAlert";
import {
  placeParMark,
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
} from "./utils/sandboxState";
import { availableCash, escrowedBids } from "./utils/auctionEscrow";
import { privateHexFor } from "./utils/privateReservations";
import { GameOverModal, type GameEndReason } from "./components/GameOverModal";
import { bankIsBroken, rankPlayers, PLACEHOLDER_TOTAL_ANTE } from "./utils/endgame";
import { turnGuardKey } from "./utils/turnGuardKey";
import { roundLabelFor } from "./utils/roundLabel";

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
  applySandboxLayTile,
  describeFloat,
  isRouteTerminusHex,
  // Design note #624: counts a drafted route's paying STOPS against the
  // train's capacity. `isRouteTerminusHex` answers a different question --
  // towns pay but cannot end a route -- so the two are not interchangeable.
  isRevenueCentreHex,
  grantBOPresidency,
  sandboxRouteBreakdown,
  SANDBOX_NOMINAL_TOKEN_COST,
} from "./utils/sandboxSession";
import AuctionPromptModal from "./components/AuctionPromptModal";
import HomeStationPrompt from "./components/HomeStationPrompt";
import ReturnToTurnBar from "./panels/ReturnToTurnBar";

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
  SMALLEST_TRAIN_CAPACITY,
} from "./utils/gameConstants";
import {
  MOCK_BUY_STOCK_PAR_VALUE,
  MOCK_LAY_TILE_PROTOCOL_ID,
  MOCK_MAP_GRID,
  MOCK_MARKET_GRID,
  MOCK_TRAIN_CATALOG,
} from "./utils/mockFixtures";
import {
  axialHexDistance,
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
import { PRIVATE_COMPANY_CATALOG } from "./utils/privateCatalog";
import { playerFinances } from "./utils/playerFinance";
import {
  applyPrivateExchange,
  CA_BONUS_TICKER,
  CA_PRIVATE_ID,
  resolvePrivateExchange,
} from "./utils/privateExchange";
import { effectiveActions, undoReachFor } from "./utils/logRevert";
// Design note #673: one computation of what a previewed lay costs, read by the
// corporation card and by the radial confirm caption.
import { describePendingTileCost, pendingTileCost } from "./utils/pendingTileCost";
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

/* Move-only extraction: ~3,500 lines left this file for panels/, styles/ and utils/.
   See docs/ai_architecture/ui_shell_layout.md - App.tsx #382 */


/* Action Log entries are constructed here, rendered via the ticker.
   ActionLogEntry/ActionLogStatus live in utils/feed.ts - App.tsx #18 */

/** Round tag ("Auction"/"SR2"/"OR 1.1") from a state, not from what the browser shows; null before the first poll. roundLabelFor moved to utils/roundLabel.ts (#659).
 *  See docs/ai_architecture/state_machine.md - App.tsx #643 */
let nextLogEntryId = 1;

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
  const [privateAbilityError, setPrivateAbilityError] = useState<string | null>(null);


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

  // Renders the whole depot tier by tier; depotInventory already applies the cheapest-first queue rule.
  // See docs/ai_architecture/contract_economy.md - App.tsx #203
  const depot = useMemo(() => depotInventory(gameState), [gameState]);

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
      /** Design note #326: the president's OWN wallet, not the treasury.
       *  `null` when there is no president or the room does not report their
       *  cash -- the tooltip is then omitted entirely rather than promising
       *  a figure it does not have. */
      presidentCash: company.president
        ? (() => {
            const entry = gameState?.player_cash.find((row) => row.player === company.president);
            const value = entry ? Number(entry.cash_vgp) : NaN;
            return Number.isFinite(value) ? value : null;
          })()
        : null,
      treasury: Number(company.treasury) || 0,
      // Design note #237: the row needs every token and its own price, not a
      // remaining-count. `stationTokenSlots` owns 1830's schedule.
      stationSlots: stationTokenSlots(company),
      trains: company.owned_trains ?? [],
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

  /* Declared here because it reads sandboxMarketPrices and const bindings are not hoisted. Emergency = obliged AND cannot afford; #433 adds "and has a route to run".
     See docs/ai_architecture/contract_economy.md - App.tsx #332 */
  const couldRunARouteIfItHadATrain = useMemo(() => {
    const corporation = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    const startHexes = corporation?.station_token_hexes ?? [];
    if (startHexes.length === 0) return false;

    const result = assignRouteSet({
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

  /* The plan IS the mount condition; there is no dismissal.
     See docs/ai_architecture/contract_economy.md - App.tsx #3 */
  const emergencyModalPlan = emergencyPurchasePlan;

  /* Two endings, both derived: bankruptcy is read off the emergency plan and wins over a broken bank.
     See docs/ai_architecture/state_machine.md - App.tsx #359 */
  const gameEndReason = useMemo<GameEndReason | null>(() => {
    if (emergencyPurchasePlan?.bankrupt) return "bankruptcy";
    if (sandbox && bankIsBroken(gameState)) return "bank-broken";
    return null;
  }, [emergencyPurchasePlan, sandbox, gameState]);

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

      /* The privates are paid on this round-change edge and only here - a per-turn trigger would pay them once per company. Sandbox only.
         See docs/ai_architecture/contract_economy.md - App.tsx #331 */
      if (sandbox && currentRoundType === "OperatingRound") {
        payPrivateRevenueRef.current?.();
      }
    }
  }, [gameState?.current_round_type, sandbox]);

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
    displayName,
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
  const roundLabel = useMemo(() => roundLabelFor(gameState), [gameState]);

  /* Read through a ref so the stamp is taken at write time, not closed over when the callback was built.
     See docs/ai_architecture/state_machine.md - App.tsx #343 */
  const roundLabelRef = useRef<string | null>(null);
  useEffect(() => {
    roundLabelRef.current = roundLabel;
  }, [roundLabel]);

  // Tile-selection state. previewTile is lifted here so it can be threaded into <HexGridRenderer>.
  // See docs/ai_architecture/canvas_rendering.md - App.tsx #7
  const [hexClickQuery, setHexClickQuery] = useState<HexClickQueryState | null>(null);
  const [previewTile, setPreviewTile] = useState<
    { q: number; r: number; tileId: number; orientation: number } | null
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
  const layTrackFocus = useMemo(() => {
    // Design note #437: the STEP, not the inspector. Veiling the board
    // while a player is merely browsing would tell them they may not build
    // on hexes that are simply not their concern this second.
    if (!tileLayStepActive) return undefined;
    const corporation = gameState?.public_companies.find(
      (entry) => entry.company_id === actingProtocolId,
    );
    const reach = layableHexes({
      mapGrid,
      stationHexes: corporation?.station_token_hexes ?? [],
    });
    if (reach.unconstrained) return undefined;
    /* The corporation's own network stays lit beside the legal placements; unioned here because this layer has both halves.
       See docs/ai_architecture/canvas_rendering.md - App.tsx #241 */
    const visible = new Set<string>(reach.network);
    reach.hexes.forEach((key) => visible.add(key));
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
    };
  }, [tileLayStepActive, gameState, actingProtocolId, mapGrid]);


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
      const openOn = openRingHexRef.current;
      if (openOn) {
        if (openOn.q !== state.q || openOn.r !== state.r) {
          setRadialSelector(null);
          setPreviewTile(null);
        }
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
  }, [tileInspectorArmed]);

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

  /* The same veil, for tokens. The SET differs: a token needs a city with a free unreserved slot ON the network. Only while targeting is armed.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #240 */
  const tokenTargetFocus = useMemo(() => {
    if (!tokenTargetMode) return undefined;
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
      reachableNetwork(mapGrid, activeStationCompany.station_token_hexes),
    );
    highlighted.forEach((key) => visible.add(key));
    return {
      visible,
      highlighted,
      /* Read activeStationCompany, not the operating queue: identity and turn order agree only during an ordinary OR turn.
         See docs/ai_architecture/canvas_rendering.md - App.tsx #514 */
      glowColor: STATION_PLACEMENT_HIGHLIGHT_INK, // design note #561
    };
  }, [tokenTargetMode, activeStationCompany, gameState, mapGrid]);


  /* Both local: BuyPrivateCompany is single-party, so the proposal is never synchronised and the prompt says so.
     See docs/ai_architecture/contract_economy.md - App.tsx #166 */
  const [privateTradeOpen, setPrivateTradeOpen] = useState(false);
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

  /* Trains have a full on-chain offer flow; privates are single-party. sandboxTrainProposal stands in for the offer register offline only.
     See docs/ai_architecture/contract_economy.md - App.tsx #205 */
  const [sandboxTrainProposal, setSandboxTrainProposal] =
    useState<TrainTradeProposal | null>(null);

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
  const [sandboxRoom, setSandboxRoom] = useState<SandboxRoomDoc | null>(null);

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

  /* The total actually committed at Run Routes, summed across trains and keyed by corporation. last_route_revenue holds only the last message.
     See docs/ai_architecture/routing_pathfinding.md - App.tsx #492 */
  const [committedRouteRevenue, setCommittedRouteRevenue] = useState<{
    protocolId: number;
    total: number;
  } | null>(null);
  useEffect(() => {
    setCommittedRouteRevenue(null);
  }, [actingProtocolId]);
  /* Mirrored into a ref so declareDividendsChoice's identity stays stable and the forced-withhold effect is not re-armed.
     See docs/ai_architecture/routing_pathfinding.md - App.tsx #492 */
  const committedRouteRevenueRef = useRef<{ protocolId: number; total: number } | null>(null);
  useEffect(() => {
    committedRouteRevenueRef.current = committedRouteRevenue;
  }, [committedRouteRevenue]);
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
      mapGrid,
      era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
      // A route must touch a city this corporation has a token in, so its
      // tokens are the only legal places to start looking.
      startHexes: corporation?.station_token_hexes ?? [],
      trains: ownedTrainRoster.map((train) => ({
        trainIndex: train.trainIndex,
        // `999` is the Diesel's unlimited; 4 is the safe default for a model
        // this build's catalog does not know.
        maxRevenueCentres: train.maxDistance ?? 4,
      })),
    });

    const drafted: Record<number, RoutePoint[]> = {};
    for (const assignment of result.assignments) {
      drafted[assignment.trainIndex] = assignment.path.map((point) => ({
        q: point.q,
        r: point.r,
        hexLabel: point.hexLabel,
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

  const handleRouteHexClick = useCallback(
    (info: {
      q: number;
      r: number;
      hexLabel: string;
      boardLabel: string | null;
      clientX: number;
      clientY: number;
    }) => {
      /* Store boardLabel (the canonical identifier), not hexLabel (the display string) - the pricing table and the contract both key on the former.
         See docs/ai_architecture/routing_pathfinding.md - App.tsx #243 */
      const boardLabel = info.boardLabel;
      if (boardLabel === null) return;
      const point: RoutePoint = { q: info.q, r: info.r, hexLabel: boardLabel };

      /* Editing a draft makes it yours; with no auto/manual toggle there is nothing to correct.
         See docs/ai_architecture/routing_pathfinding.md - App.tsx #266 */

      // A route runs between two revenue centres: the FIRST click is refused outright if it is not one; the last is left to the readout. Towns are not termini (#264).
      // See docs/ai_architecture/routing_pathfinding.md - App.tsx #256
      const current = routeDraftsRef.current[activeTrainIndexRef.current] ?? [];
      if (current.length === 0 && !isRouteTerminusHex(mapGrid, boardLabel)) {
        setRouteFeedback(
          `${info.hexLabel} cannot START a route. Routes begin at a city or a red off-board hex — towns and plain track are passed through.`,
        );
        return;
      }

      /* A waypoint needs track. liveEdgesForHex counts preprinted rails as well as laid tiles.
         See docs/ai_architecture/routing_pathfinding.md - App.tsx #186 */
      if (liveEdgesForHex(mapGrid, info.q, info.r).length === 0) {
        setRouteFeedback(
          `${info.hexLabel} has no track. Lay a tile there first, or pick a hex the network already runs through.`,
        );
        return;
      }

      setRouteDrafts((all) => {
        const trainIndex = activeTrainIndexRef.current;
        const prev = all[trainIndex] ?? [];
        /* Refuse the click that would exceed the train's capacity, counted in revenue CENTRES and checked on the commit so a bridge's extra stops count.
           See docs/ai_architecture/routing_pathfinding.md - App.tsx #624 */
        const cap =
          ownedTrainRosterRef.current.find((train) => train.trainIndex === trainIndex)
            ?.maxDistance ?? null;
        const centresIn = (points: readonly RoutePoint[]) =>
          points.reduce(
            (total, entry) => (isRevenueCentreHex(mapGrid, entry.hexLabel) ? total + 1 : total),
            0,
          );
        /** Appends, unless doing so would overrun the train. */
        const commit = (next: RoutePoint[]) => {
          if (cap !== null) {
            const centres = centresIn(next);
            if (centres > cap) {
              setRouteFeedback(
                `That would give this train ${centres} stops and it can only run ${cap}. Click ${prev[prev.length - 1]?.hexLabel ?? "a hex on the route"} to step back, or select a longer train.`,
              );
              return all;
            }
          }
          setRouteFeedback(null);
          return { ...all, [trainIndex]: next };
        };
        const write = (next: RoutePoint[]) => ({ ...all, [trainIndex]: next });
        const last = prev[prev.length - 1];
        // Clicking the most recently added point again is a quick one-step
        // undo, rather than a no-op or a rejected duplicate.
        if (last && last.q === point.q && last.r === point.r) {
          setRouteFeedback(null);
          return write(prev.slice(0, -1));
        }
        if (prev.length === 0) {
          // Design note #624: even the first stop is capped -- a 1-stop cap
          // is not a state 1830 has, but the check is uniform rather than
          // special-cased, which is what keeps it honest for the Diesel.
          return commit([point]);
        }

        // Clicking a hex the route already passes through, other than the
        // last one, would make the chain visit it twice -- and 1830 pays a
        // hex once per pass, so the drawing and the pricing would disagree.
        // Refused with the reason rather than silently ignored.
        if (prev.some((entry) => entry.q === point.q && entry.r === point.r)) {
          setRouteFeedback(
            `${point.hexLabel} is already on this route. A route may not visit the same hex twice — click ${last.hexLabel} to step back instead.`,
          );
          return all;
        }

        /* Design note #276: ADJACENT CLICKS ARE UNCHANGED.
           A neighbouring hex is appended exactly as before, which is what
           keeps hex-by-hex drawing available for disambiguating a branch --
           the bridge below only fills gaps the player chose to leave. */
        if (axialHexDistance(last, point) === 1) {
          return commit([...prev, point]);
        }

        /* bridgeWaypoints fills the gap between two stops, preferring plain track over a third city. A failed bridge is still refused.
           See docs/ai_architecture/routing_pathfinding.md - App.tsx #276 */
        const bridge = bridgeWaypoints(
          mapGrid,
          last,
          point,
          // A route is a simple path, so the bridge may not loop back
          // through hexes the player has already routed over.
          new Set(prev.map((entry) => `${entry.q},${entry.r}`)),
        );
        if (!bridge) {
          setRouteFeedback(
            `No track path from ${last.hexLabel} to ${point.hexLabel}. Lay the missing tiles, or click through the hexes you want the route to take.`,
          );
          return all;
        }
        // Design note #624: the bridge may add several paying stops at once.
        return commit([...prev, ...bridge]);
      });
    },
    // mapGrid joins for #186's track check; the draft and active train are read through refs so the canvas click prop is not rebuilt mid-draw.
    // See docs/ai_architecture/routing_pathfinding.md - App.tsx #232
    [mapGrid],
  );

/* routeHopCount is deleted: a 2-train is capped at two revenue centres, not two hexes of travel.
   See docs/ai_architecture/routing_pathfinding.md - App.tsx #156 */

  // Every draft priced in one memo, so the panel, the total and the dispatch cannot disagree. #474: the corporation's tokens, derived once.
  // See docs/ai_architecture/routing_pathfinding.md - App.tsx #275
  const routeTokenHexes = useMemo<ReadonlyArray<readonly [number, number]>>(
    () =>
      gameState?.public_companies.find((entry) => entry.company_id === actingProtocolId)
        ?.station_token_hexes ?? [],
    [gameState, actingProtocolId],
  );

  const trainDrafts = useMemo<TrainRouteDraft[]>(() => {
    const era = ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"];
    return ownedTrainRoster.map((train) => {
      const points = routeDrafts[train.trainIndex] ?? [];
      const breakdown =
        points.length < 2
          ? null
          : sandboxRouteBreakdown(mapGrid, routePointsToWaypoints(points), era);
      /* An unknown train falls back to the smallest real capacity rather than having none; the count is stops.length, the list the panel renders.
         See docs/ai_architecture/routing_pathfinding.md - App.tsx #285 */
      const centres = breakdown?.stops.length ?? 0;
      const cap = train.maxDistance ?? SMALLEST_TRAIN_CAPACITY;
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
        // Design note #285: `999` is the Diesel's genuine "unlimited"; an
        // absent figure is ignorance and must not read as one.
        exceedsMaxDistance: cap !== 999 && centres > cap,
        // Design note #256/#264: only meaningful once there is a route.
        endsOffTerminus:
          points.length >= 2 && last !== undefined
            ? !isRouteTerminusHex(mapGrid, last.hexLabel)
            : false,
        /* A route must touch a city this corporation holds a token in - ANY token, anywhere on the run.
           See docs/ai_architecture/routing_pathfinding.md - App.tsx #474 */
        tokenBlockReason: routeTokenBlockReason(points, routeTokenHexes),
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
        // Design note #373: the join key the three surfaces share.
        trainIndex: train.trainIndex,
        /* Connects highlightedTrainIndex to the renderer's primary/muted emphasis; normal when nothing is highlighted.
           See docs/ai_architecture/routing_pathfinding.md - App.tsx #495 */
        emphasis: routeEmphasisFor(train.trainIndex, highlightedTrainIndex),
      });
    }
    return overlays;
  }, [ownedTrainRoster, routeDrafts, highlightedTrainIndex]);

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
  const stockRoundPlayerFinances = useMemo(() => {
    /* Design note #593: both seat-driven rounds. The Operating Round is
       excluded for the reason `actingSeatIndex` draws the same line -- its
       turn belongs to a corporation. */
    if (
      !gameState ||
      (gameState.current_round_type !== "StockRound" &&
        gameState.current_round_type !== "WaterfallAuction")
    ) {
      return [];
    }
    const prices = Object.fromEntries(
      (marketGrid?.positions ?? []).map((entry) => [entry.company_id, Number(entry.price)]),
    ) as Readonly<Record<number, number | null>>;
    return gameState.player_addresses
      .map((address) => playerFinances(address, gameState, prices, settledPrivatePrices))
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

  /** Design note #670: the strip's rows. Seating order, cash only -- everything
   *  else a player might want is a tab away, and a second copy of it here would
   *  be a second thing to keep true. */
  const playerCashRows = useMemo(() => {
    if (!gameState) return [];
    const cash = cashByPlayer(gameState);
    return gameState.player_addresses.map((address) => ({
      address,
      cash: address in cash ? cash[address] : null,
    }));
  }, [gameState]);

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

  /* Hex-holding private powers route through the shared map flow and are marked spent WHEN THE CLICK LANDS. Share exchanges stay marked-and-logged.
     See docs/ai_architecture/contract_economy.md - App.tsx #444 */
  const handleUsePrivateAbility = useCallback(
    (ability: PrivateAbility, action: PrivateAbilityAction) => {
      const reservation = privateHexFor(ability.privateId);
      const targetsHex = action.key === "dh-tile" || action.key === "dh-token" ||
        action.key === "csl-tile";

      if (targetsHex && reservation) {
        setHomeStationPlacement({
          kind: action.key === "dh-token" ? "private-station" : "private-tile",
          companyId: actingProtocolId,
          q: reservation.q,
          r: reservation.r,
          hexLabel: reservation.hexLabel,
          abilityKey: action.key,
          returnTab: activeMainTab,
        });
        setActiveMainTab("map");
        logInfoRef.current?.(
          "Private Power",
          `${action.label} — click ${reservation.hexLabel} on the Rail Map, the only hex left lit.`,
        );
        return;
      }

      /* A refusal must leave the power alone - returning before setUsedPrivateAbilities is the whole difference.
         See docs/ai_architecture/contract_economy.md - App.tsx #573 */
      if (action.key === "mh-exchange" || action.key === "ca-exchange") {
        const owner = viewerAddressRef.current;
        const outcome = resolvePrivateExchange(
          gameStateRef.current,
          ability.privateId,
          owner ?? "",
        );
        if (!outcome.ok) {
          setPrivateAbilityError(outcome.reason);
          logInfoRef.current?.("Private Power", outcome.reason);
          return;
        }
        setPrivateAbilityError(null);
        void runGameplayActionRef.current?.(
          `${action.label} — exchanging for a 10% ${outcome.ticker} share.`,
          {
            ExchangePrivate: {
              private_id: outcome.privateId,
              company_id: outcome.companyId,
              player: outcome.player,
              source: outcome.source,
            },
          },
          /* `automatic`: an exchange may be taken between other players'
             turns (the M&H's own rule), so the turn gate would refuse the
             one moment the power is most useful. Ownership is the gate here
             and `resolvePrivateExchange` has already checked it. */
          { automatic: true },
        );
        /* Deliberately NOT marked used: design note #573a closes the COMPANY
           instead, which removes the row entirely rather than greying it. */
        return;
      }

      setUsedPrivateAbilities((prev) => new Set(prev).add(action.key));
      logInfoRef.current?.("Private Power", `${action.label} — ${ability.description}`);
    },
    [actingProtocolId, activeMainTab],
  );

  /* round is an optional override; the default ref is right for every caller except a round transition, which announces a round the ref does not know yet.
     See docs/ai_architecture/state_machine.md - App.tsx #659 */
  const logInfo = useCallback((label: string, detail: string, round?: string | null) => {
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
  const runGameplayActionRef = useRef<
    | ((
        fallbackLabel: string,
        msg: SandboxLogMsg,
        options?: { automatic?: boolean },
      ) => Promise<void> | void)
    | null
  >(null);

  /* Reached through a ref for declaration order, and reads sandboxStateRef so the payout is not credited against a stale board.
     See docs/ai_architecture/contract_economy.md - App.tsx #331 */
  const payPrivateRevenue = useCallback(() => {
    const before = sandboxStateRef.current;
    if (!before) return;
    const result = applyPrivateRevenue(before);
    // Identity, not length: `applyPrivateRevenue` returns the same object
    // when nothing is owed, so this is also the "no re-render" check.
    if (!result || result.state === before) return;

    sandboxStateRef.current = result.state;
    setSandboxState(result.state);

    const labelForAddress = (address: string) =>
      sandboxPlayerLabel(address) ?? truncateAddress(address);
    const labelForCompany = (companyId: number) =>
      before.public_companies.find((entry) => entry.company_id === companyId)?.ticker ??
      `company #${companyId}`;

    for (const payout of result.payouts) {
      logInfoRef.current?.(
        "Private Revenue",
        describePrivatePayout(payout, labelForAddress, labelForCompany),
      );
    }
  }, []);

  const payPrivateRevenueRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    payPrivateRevenueRef.current = payPrivateRevenue;
  }, [payPrivateRevenue]);

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
        resetRouteRevenue?: boolean;
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
        /* Design note #434: steps from the CELL. This took a bare price and
           re-derived a coordinate from it, so the log quoted the same wrong
           destination the readout did. `marketGrid.positions` is the same
           source the panel reads, so the sentence and the screen agree. */
        projectPrice: (companyId: number, choice: "pay" | "withhold") =>
          projectDividendFrom(
            marketGrid?.positions.find((p) => p.company_id === companyId) ?? null,
            choice,
          )?.price ?? null,
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
          const ok = await appendSandboxAction(
            roomCode,
            appliedIndexRef.current,
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
          ).catch(() => false);
          if (!ok) {
            setSandboxRoomError("Could not reach the room — that action was not sent.");
          }
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
          const placed = placeHomeStationToken(base, companyId, q, r, cityIndex);
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
          const opened: GameStateResponse = {
            ...base,
            current_round_type: "StockRound",
            consecutive_passes: 0,
          };
          sandboxStateRef.current = opened;
          setSandboxState(opened);
          const closed = sandboxWaterfallRef.current
            ? { ...sandboxWaterfallRef.current, waterfall_auction_active: false }
            : null;
          sandboxWaterfallRef.current = closed;
          setSandboxWaterfall(closed);
          logInfo("Round", "The Waterfall Auction is complete \u2014 Stock Round 1 begins.");
          return;
        }

        if (isSetupGameMsg(msg)) {
          const dealt = dealSandboxGame({ players: msg.SetupGame.players });
          if (!dealt) {
            logInfo("Room", "That roster cannot be dealt — 1830 seats two to six players.");
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
            virtual_bank_start: String(BANK_START),
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
          sandboxStateRef.current = seated;
          setSandboxState(seated);

          /* The auction atom is dealt in the same handler from the same roster, read from the ref with no fallback.
             See docs/ai_architecture/firebase_middleware.md - App.tsx #542 */
          const dealtWaterfall = waterfallForRoster(
            sandboxWaterfallRef.current,
            dealt.playerAddresses,
          );
          sandboxWaterfallRef.current = dealtWaterfall;
          setSandboxWaterfall(dealtWaterfall);
          logInfo(
            "Room",
            `Game dealt for ${dealt.playerAddresses.length} players — $${dealt.startingCash} each, certificate limit ${dealt.certLimit}.`,
          );
          return;
        }

        /* The tile grid is its own atom; applying it inside the dispatch is what makes a lay replicate to every client.
           See docs/ai_architecture/firebase_middleware.md - App.tsx #522 */
        if ("LayTile" in msg) {
          const lay = msg.LayTile;
          setMapGrid((current) =>
            applySandboxLayTile(current, lay.q, lay.r, lay.tile_id, lay.orientation),
          );
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
              for (const payout of revenue.payouts) {
                logInfo("Private Revenue", describePrivatePayout(payout, labelFor, tickerFor));
              }
            }
          }
        }

        /* Design note #272/#273: the market atom, advanced BEFORE the game
           state because the game state needs the price it reports. Same
           contract as the waterfall's: this returns the figure rather than
           reaching into wallets, so one number is charged and logged. */
        const marketResult = applySandboxMarketAction(sandboxMarketRef.current, msg, {
          projectSale: (from, blocks) => projectShareSaleMove(from, blocks),
          // Design note #291: the dividend decision moves the marker too.
          projectDividend: (from, choice) => projectDividendCellMove(from, choice),
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
                : (["fell", "on the share sale"] as const);
          logInfo("Market Move", `${ticker} ${verb} from $${from} to $${to} ${cause}.`);
        }

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
            resetRouteRevenue: options?.resetRouteRevenue ?? false,
            era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
            // Design note #273: what the chart says this share is worth, so
            // the wallet and the market agree about one trade.
            sharePrice: marketResult.tradePrice ?? undefined,
            /* Read the market ref the block above has just refreshed, so the queue reflects a move this dispatch caused.
               See docs/ai_architecture/stock_market.md - App.tsx #411 */
            marketPriceFor: marketPriceForCompany,
            // Design note #647: the token's position -- column and arrival.
            marketMarkFor: marketMarkForCompany,
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
          });
          /* A float is announced here by diffing before/after, naming the hex the home token landed on. #401: a par is also a cell on the chart.
             See docs/ai_architecture/state_machine.md - App.tsx #400 */
          if (before) {
            for (const company of after.public_companies) {
              const wasUnparred =
                before.public_companies.find((e) => e.company_id === company.company_id)
                  ?.par_value ?? null;
              const wasFloated =
                before.public_companies.find((e) => e.company_id === company.company_id)
                  ?.is_floated ?? false;
              /* The invariant is enforced at FLOAT, not only at par: the B&O's par is set by the auction prompt and never passes through this diff. Idempotent by construction.
                 See docs/ai_architecture/stock_market.md - App.tsx #468 */
              const parredNow = wasUnparred === null && company.par_value !== null;
              const floatedNow = !wasFloated && company.is_floated;
              if ((parredNow || floatedNow) && company.par_value !== null) {
                const par = Number(company.par_value);
                /* Design note #415: `parBoxCellFor`, not `marketCellForPrice`. The
                   latter resolves a par to the chart's TOP ROW -- see its own
                   note -- which is what put five of the six par values on the
                   wrong cell. */
                setSandboxMarket((prices) => {
                  const next = placeParMark(prices, company.company_id, par, parBoxCellFor);
                  /* Write the ref too: the Stock Round close that opens the Operating Round runs in this same dispatch, before React commits.
                     See docs/ai_architecture/stock_market.md - App.tsx #316 */
                  if (next !== prices) sandboxMarketRef.current = next;
                  return next;
                });
              }
            }
            for (const company of after.public_companies) {
              const previously = before.public_companies.find(
                (entry) => entry.company_id === company.company_id,
              );
              // Design note #400: the branching lives in `describeFloat`,
              // where a test can reach it.
              const line = previously ? describeFloat(previously, company) : null;
              if (line) logInfo("Float", line);
            }
          }

          sandboxStateRef.current = after;
          setSandboxState(after);

          /* settleRoundTransitions performs the transition; the shell only logs it. Detected by comparing state, silent on a replay, and no tab navigation here (#213 owns that).
             See docs/ai_architecture/state_machine.md - App.tsx #642 */
        label =
          describeGameplayAction(msg, { ...describeContext, afterState: after }) ?? label;

        setActionLog((log) => [
          {
            id,
            seq: id, // design note #668
            label,
            status: "success",
            detail: "Sandbox: applied to local mock state (nothing signed, no chain).",
            timestamp,
            timestampMs,
            /* Stamp the entry with the round the action was taken IN (before), not the one it resolved to.
               See docs/ai_architecture/state_machine.md - App.tsx #659 */
            round: roundLabelFor(before) ?? undefined,
          },
          ...log,
        ]);
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
    // See docs/ai_architecture/state_machine.md - App.tsx #265
    [
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

    setMapGrid(MOCK_MAP_GRID);
    setLiveOrSubPhase("Track");

    // Any in-flight gesture belonged to the history just discarded.
    setPreviewTile(null);
    setRadialSelector(null);
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
    (protocolId: number, source: "Ipo" | "Bank") => {
      return runGameplayAction(
        "BuyStock",
        {
          BuyStock: {
            game_id: gameId,
            protocol_id: protocolId,
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

    /* The prompt fires immediately on the FACT of the float, and only for the president - strict identity, one render after the seat sync lands (#440/#455).
       See docs/ai_architecture/state_machine.md - App.tsx #460 */
    if (!owed.president || owed.president !== viewerAddress) return null;
    return owed;
  }, [gameState, homeHexToAxial, viewerAddress]);

  /* #455's hotseat seat move is gone; in a room the prompt is already on the right client and there is no cursor to fight.
     See docs/ai_architecture/state_machine.md - App.tsx #578 */

  /* null when no home placement is in flight; otherwise the corporation, the one legal hex, and the tab to return to (captured, not assumed).
     See docs/ai_architecture/state_machine.md - App.tsx #440 */
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
      const placement = homeStationPlacement;
      if (!placement) return;
      /* The veil already refuses every other hex (`layFocus.highlighted` is
         a one-element set), so this is a second lock on the same door --
         cheap, and the kind of guard that matters if the veil is ever
         loosened for a reason unrelated to this flow. */
      if (q !== placement.q || r !== placement.r) return;
      // Design note #444: a tile lay is not staged here. It falls through
      // to the tile picker and finishes in `handleConfirmRadialLay`.
      if (placement.kind === "private-tile") return;

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

  const handleBuyShare = useCallback(
    async (protocolId: number, source: "Ipo" | "Bank", quantity = 1) => {
      const times = Math.max(1, Math.floor(quantity));
      for (let i = 0; i < times; i += 1) {
        await buyOneShare(protocolId, source);
      }
    },
    [buyOneShare],
  );

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

    /* One RunManualRoute per train, awaited in sequence. Invalid drafts are skipped, not refused - the good routes are not hostage to the bad one.
       See docs/ai_architecture/routing_pathfinding.md - App.tsx #275 */
    const runnable = trainDrafts.filter(
      (draft) =>
        draft.value !== null &&
        draft.value > 0 &&
        !draft.exceedsMaxDistance &&
        !draft.endsOffTerminus &&
        // Design note #474: and it must touch one of this corporation's
        // tokens. The one 1830 rule this filter did not express.
        draft.tokenBlockReason === null,
    );

    if (runnable.length === 0) {
      const drafted = trainDrafts.filter((draft) => draft.hexLabels.length > 0);
      if (drafted.length === 0) {
        setRouteFeedback(
          "Select at least two connected hexes on the Rail Map to declare a route.",
        );
        return;
      }
      /* The LAST stop is reported here, not refused on click. #474: the token warning comes first, because a tokenless route is wrong about where it runs.
         See docs/ai_architecture/routing_pathfinding.md - App.tsx #256 */
      const tokenless = drafted.find((draft) => draft.tokenBlockReason !== null);
      if (tokenless?.tokenBlockReason) {
        setRouteFeedback(tokenless.tokenBlockReason);
        return;
      }
      const offTerminus = drafted.find((draft) => draft.endsOffTerminus);
      if (offTerminus) {
        const last = offTerminus.hexLabels[offTerminus.hexLabels.length - 1];
        setRouteFeedback(
          `${last} cannot END a route. Routes finish at a city or a red off-board hex — click one to finish, or click ${last} again to step back.`,
        );
        return;
      }
      setRouteFeedback("No drafted route can run yet.");
      return;
    }

    let firstOfBatch = true;
    for (const draft of runnable) {
      const points = routeDraftsRef.current[draft.trainIndex] ?? [];
      if (points.length < 2) continue;
      // eslint-disable-next-line no-await-in-loop
      await runGameplayAction(
        "RunManualRoute",
        {
          RunManualRoute: {
            game_id: gameId,
            protocol_id: actingProtocolId,
            path: routePointsToWaypoints(points),
            // Withhold at Routes; the pay-or-withhold decision belongs to the very next step.
            // See docs/ai_architecture/routing_pathfinding.md - App.tsx #373
            payout_strategy: "Withhold",
          },
        },
        /* Only the first message of a turn's batch clears the running total, flagged inside the loop because short drafts are skipped.
           See docs/ai_architecture/routing_pathfinding.md - App.tsx #492 */
        { resetRouteRevenue: firstOfBatch },
      );
      firstOfBatch = false;
    }

    /* Record the total from the list actually dispatched, so the Dividends step spends the number the player watched being assembled.
       See docs/ai_architecture/routing_pathfinding.md - App.tsx #492 */
    const committedTotal = runnable.reduce((sum, draft) => sum + (draft.value ?? 0), 0);
    setCommittedRouteRevenue({ protocolId: actingProtocolId, total: committedTotal });

    // Design note #278: this corporation HAS run, so any revenue on it is
    // this turn's and the dividend choice is binding.
    setRoutesRunThisTurn({ protocolId: actingProtocolId, ran: true });

    // Optimistic advance to Dividends: running trains produces the figure that step decides about.
    // See docs/ai_architecture/state_machine.md - App.tsx #142
    setLiveOrSubPhase("Dividends");
  }, [runGameplayAction, gameId, trainDrafts, actingProtocolId, ownsAnyTrain]);

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
        committedRevenue:
          committedRouteRevenueRef.current?.protocolId === actingProtocolId
            ? committedRouteRevenueRef.current.total
            : null,
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

      for (let i = 0; i < times; i += 1) {
        await runGameplayAction(
          times > 1
            ? `BuyHardwareFromPool: ${tier}-train (${i + 1} of ${times})`
            : `BuyHardwareFromPool: ${tier}-train`,
          { BuyHardwareFromPool: { game_id: gameId, protocol_id: actingProtocolId } },
        );
      }

      /* One aggregate summary above the per-message lines, and only when there is an aggregate to state.
         See docs/ai_architecture/state_machine.md - App.tsx #262 */
      if (times > 1 && before) {
        const ticker =
          gameState?.public_companies.find((entry) => entry.company_id === actingProtocolId)
            ?.ticker ?? `Corporation #${actingProtocolId}`;
        const remaining =
          before.remaining === null
            ? "unlimited"
            : `${Math.max(0, before.remaining - times)}/${before.total}`;
        logInfo(
          "Trains Bought",
          `${ticker} bought ${countPhrase(times, `${tier}-train`)} for $${before.cost * times}. ` +
            `Remaining depot supply: ${remaining}.`,
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
      setPrivateTradeOpen(false);

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
    );
  }, [privateProposal, runGameplayAction]);

  const handleRejectPrivateOffer = useCallback(() => {
    if (!privateProposal) return;
    runGameplayAction(
      `Declined $${privateProposal.price} for ${privateProposal.privateName}`,
      { AnswerPrivatePurchase: { private_id: privateProposal.privateId, accept: false } },
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
  const handlePlaceStationTokenHint = useCallback(() => {
    setTokenTargetMode((current) => {
      const next = !current;
      logInfo(
        "Place Station Token",
        next
          ? "Targeting mode ON — click a city hex on the Rail Map to place the token. Click the button again to cancel."
          : "Targeting mode cancelled.",
      );
      return next;
    });
  }, [logInfo]);

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
   *  player is back where they were rather than having to re-open the mode. */
  const handleCancelTokenPlacement = useCallback(() => {
    setPendingToken(null);
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
  const skipSubPhase = useCallback((automatic: boolean) => {
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
      { automatic, derived: automatic },
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
  const skipSubPhaseAutomatically = useCallback(() => skipSubPhase(true), [skipSubPhase]);

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

      setSandboxTrainProposal(proposal);
      logInfo(
        "Train Offer",
        `${proposal.buyerTicker} offered $${proposal.price} for one of ${proposal.sellerTicker}'s ${proposal.modelType}-trains. Awaiting ${proposal.sellerPresidentLabel}.`,
      );
    },
    [gameState, sandbox, handleMakeTrainOffer, logInfo],
  );

  /** Accepted in the sandbox. THIS is where the real message goes -- the one
   *  the contract has always had, sent only after both sides have said yes. */
  const handleAcceptSandboxTrainOffer = useCallback(() => {
    if (!sandboxTrainProposal) return;
    const proposal = sandboxTrainProposal;
    setSandboxTrainProposal(null);
    runGameplayAction(
      `BuyTrainFromCorporation: ${proposal.modelType}-train @ $${proposal.price}`,
      {
        BuyTrainFromCorporation: {
          game_id: gameId,
          buyer_protocol_id: proposal.buyerProtocolId,
          seller_protocol_id: proposal.sellerProtocolId,
          model_type: proposal.modelType,
          price: proposal.price,
        },
      },
    );
  }, [sandboxTrainProposal, runGameplayAction, gameId]);

  const handleRejectSandboxTrainOffer = useCallback(() => {
    if (!sandboxTrainProposal) return;
    logInfo(
      "Offer Rejected",
      `${sandboxTrainProposal.sellerPresidentLabel} declined $${sandboxTrainProposal.price} for ${sandboxTrainProposal.sellerTicker}'s ${sandboxTrainProposal.modelType}-train.`,
    );
    setSandboxTrainProposal(null);
  }, [sandboxTrainProposal, logInfo]);


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
    const limit = depot.find((tier) => tier.isCurrent)?.trainLimit;
    if (limit === undefined) return false;
    return owned >= limit;
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
    const startHexes = corporation.station_token_hexes ?? [];
    if (startHexes.length === 0) {
      /* A corporation the chain reported with an empty token list has nowhere to start: that is the answer, not ignorance. Absent from the response stays null.
         See docs/ai_architecture/state_machine.md - App.tsx #414 */
      return corporation.station_token_hexes ? 0 : null;
    }

    const result = assignRouteSet({
      mapGrid,
      era: ERA_FOR_PHASE_TINT[currentPhase?.tint ?? "yellow"],
      startHexes,
      trains: ownedTrainRoster.map((train) => ({
        trainIndex: train.trainIndex,
        maxRevenueCentres: train.maxDistance ?? 4,
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
  const noEarnableRevenue = useMemo<string | null>(() => {
    if (!ownsAnyTrain) return "it owns no trains, so there is no route to run";
    if (maxRouteRevenue === 0) {
      return "its trains cannot reach a route that earns anything";
    }
    return null;
  }, [ownsAnyTrain, maxRouteRevenue]);

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
    });
  }, [gameState, orSubPhase, activeStationCompany, mapGrid]);

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
    /* Having skipped Routes is an OBSERVATION and is enough on its own; the pathfinder prediction declines to answer in exactly this case. Manual skips count too.
       See docs/ai_architecture/state_machine.md - App.tsx #484 */
    if (noEarnableRevenue === null && !skippedRoutesThisTurn) return;
    // Design note #653: scoped to THIS turn, not to this corporation for
    // the whole game -- a corporation withholds on many turns.
    const key = turnGuardKey(turnIdentity, actingProtocolId, "withhold");
    if (forcedWithholdRef.current.has(key)) return;
    forcedWithholdRef.current.add(key);
    logInfo(
      "Auto-Withhold",
      `${
        skippedRoutesThisTurn
          ? "No routes were run"
          : ownsAnyTrain
            ? "No route earned anything"
            : "No trains ran"
      }, so there is nothing to pay out — $0 withheld and the share price steps left.`,
    );
    withholdRevenueAutomatically();
  }, [
    gameState,
    spectator,
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
    // Design note #653: the turn is part of the key, so the guard re-arms.
    const key = turnGuardKey(turnIdentity, actingProtocolId, orSubPhase);
    if (autoSkippedRef.current.has(key)) return;
    autoSkippedRef.current.add(key);
    logInfo(
      "Auto-Skip",
      `Skipped ${OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel} — ${autoSkipReason}.`,
    );
    // Design note #439: the AUTOMATIC entry point, so Undo rewinds past it.
    skipSubPhaseAutomatically();
  }, [
    autoSkipReason,
    actingProtocolId,
    turnIdentity,
    orSubPhase,
    skipSubPhaseAutomatically,
    logInfo,
  ]);

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
    (q: number, r: number, tileId: number, orientation: number) => {
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
  const radialCandidates = useMemo<readonly LegalTilePlacement[]>(() => {
    if (!radialSelector) return [];
    if (!radialSelector.provisional) return radialSelector.placements;
    return filterSandboxPlacements(radialSelector.placements, {
      mapGrid,
      q: radialSelector.q,
      r: radialSelector.r,
      // undefined for anyone who may not lay, which lets them browse the whole hex rather than one corporation's slice.
      // See docs/ai_architecture/canvas_rendering.md - App.tsx #620
      networkHexes: canLayTileNow ? layTrackFocus?.network : undefined,
      networkPorts: canLayTileNow ? layTrackFocus?.ports : undefined,
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
    layTrackFocus?.network,
    layTrackFocus?.ports,
  ]);

  /* Rotate only through legal angles; the set is already present as (tile_id, orientation) pairs, sorted for a predictable direction.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #173 */
  const legalRotations = useMemo<number[]>(() => {
    if (previewTile === null) return [];
    const angles = radialCandidates
      .filter((placement) => placement.tile_id === previewTile.tileId)
      .map((placement) => placement.orientation);
    return Array.from(new Set(angles)).sort((a, b) => a - b);
  }, [radialCandidates, previewTile]);

  const handleDismissRadial = useCallback(() => {
    setRadialSelector(null);
    setPreviewTile(null);
  }, []);

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
        const at = legalRotations.indexOf(current.orientation);
        const next = legalRotations[(at + 1) % legalRotations.length];
        return next === current.orientation ? current : { ...current, orientation: next };
      });
    },
    [radialSelector, handleDismissRadial, legalRotations],
  );

  /** A live preview gives the canvas to rotation, so the query interceptor is disarmed. Token destinations are recomputed per candidate tile.
   *  See docs/ai_architecture/canvas_rendering.md - App.tsx #448 */
  const radialTokenNote = useMemo(() => {
    if (!radialSelector || !previewTile) return null;
    return describeTokenMigration(
      previewTokenMigration(
        mapGrid,
        radialSelector.q,
        radialSelector.r,
        gameState?.public_companies ?? [],
        previewTile.tileId,
      ),
    );
  }, [radialSelector, previewTile, mapGrid, gameState]);

  /* One previewTokenMigration per candidate, keyed on its tile id - the destination depends on how many cities that tile carries. #628: tray counts read the live board.
     See docs/ai_architecture/canvas_rendering.md - App.tsx #449 */
  const radialStockFor = useCallback(
    (tileId: number) => tileStock(mapGrid, tileId),
    [mapGrid],
  );

  const radialStationMarkersFor = useCallback(
    (tileId: number): readonly StationPreviewMarker[] => {
      if (!radialSelector) return [];
      const preview = previewTokenMigration(
        mapGrid,
        radialSelector.q,
        radialSelector.r,
        gameState?.public_companies ?? [],
        tileId,
      );
      if (!preview) return [];
      return preview.migrations.map((entry) => ({
        cityIndex: entry.toCityIndex,
        ticker: entry.ticker,
        color: stationTickerColor(entry.companyId),
      }));
    },
    [radialSelector, mapGrid, gameState],
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
      (room) => setSandboxRoom(room),
      (message) => setSandboxRoomError(message),
    );
  }, [sandbox, sandboxRoomCode]);

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
  const handleStartSandboxGame = useCallback(async () => {
    if (!sandboxRoomCode || !sandboxRoom) return;
    if (!canStartSandboxGame(sandboxRoom, MIN_PLAYERS)) return;
    setSandboxRoomBusy(true);
    setSandboxRoomError(null);
    try {
      const seated = shuffleForTurnOrder(toSetupPlayers(sandboxRoom));
      const ok = await appendSandboxAction(sandboxRoomCode, appliedIndexRef.current, localId, {
        SetupGame: { players: seated },
      });
      if (!ok) {
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
    );
    return cost.fee > 0 ? cost : null;
  }, [radialSelector, orSubPhase, canLayTileNow, mapGrid, activeCorporationContext]);

  /** Derived from radialSelector: the ring and the veil must appear and vanish together.
   *  See docs/ai_architecture/canvas_rendering.md - App.tsx #472 */
  const soleFocusKey = useMemo(
    () => (radialSelector ? `${radialSelector.q},${radialSelector.r}` : undefined),
    [radialSelector],
  );

  /** Confirm. Sandbox lays locally; a chain-backed room dispatches. */
  const handleConfirmRadialLay = useCallback(() => {
    if (!radialSelector || !previewTile || !canLayTileNow) return;
    const { q, r } = radialSelector;
    const { tileId, orientation } = previewTile;
    if (sandbox) {
      handleSandboxLayTile(q, r, tileId, orientation);
    } else {
      runGameplayAction("LayTile", {
        LayTile: { game_id: gameId, protocol_id: actingProtocolId, q, r, tile_id: tileId, orientation },
      });
    }
    /* A private-tile errand only veils, so its round trip ends here - marked spent on the LAY, not on the button press.
       See docs/ai_architecture/contract_economy.md - App.tsx #444 */
    if (homeStationPlacement?.kind === "private-tile") {
      if (homeStationPlacement.abilityKey) {
        setUsedPrivateAbilities((prev) =>
          new Set(prev).add(homeStationPlacement.abilityKey as string),
        );
      }
      setHomeStationPlacement(null);
      setActiveMainTab(homeStationPlacement.returnTab);
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
    // Design note #492: the multi-train total this corporation committed at
    // Run Routes, when this session watched it commit one.
    committedRevenue:
      committedRouteRevenue?.protocolId === actingProtocolId
        ? committedRouteRevenue.total
        : null,
  });
  const dividendRevenue = dividendDeclarationNow.revenue;
  const dividendPerShare = dividendDeclarationNow.perShare;

  /* Design note #278: whether the Pay/Withhold choice is binding. `false`
     when this corporation is known to have skipped Routes -- see the state's
     own note for why `null` (unknown) counts as having run. */
  const dividendRevenueIsThisTurn = !skippedRoutesThisTurn;
  const dividendPayouts = useMemo(() => {
    if (!dividendCorp) return [];
    const rows = dividendCorp.player_holdings.map((entry) => ({
      holder: sandboxPlayerLabel(entry.player) ?? truncateAddress(entry.player),
      percentage: entry.percentage,
      amount: dividendPerShare * (entry.percentage / 10),
    }));
    // The bank pool is paid too -- its share goes to the bank, and omitting
    // it would make the listed payouts fail to add up to the revenue.
    if (dividendCorp.bank_pool_percentage > 0) {
      rows.push({
        holder: "Bank Pool",
        percentage: dividendCorp.bank_pool_percentage,
        amount: dividendPerShare * (dividendCorp.bank_pool_percentage / 10),
      });
    }
    return rows.sort((a, b) => b.percentage - a.percentage);
  }, [dividendCorp, dividendPerShare]);

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
  const payProjection = useMemo(
    () => projectDividendFrom(dividendCell, "pay"),
    [dividendCell],
  );
  const withholdProjection = useMemo(
    () => projectDividendFrom(dividendCell, "withhold"),
    [dividendCell],
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
            appliedCount={sandboxAppliedCount}
            error={sandboxRoomError}
            busy={sandboxRoomBusy}
            onHost={handleHostSandboxRoom}
            onJoin={handleJoinSandboxRoom}
            onLeave={handleLeaveSandboxRoom}
          />
          <button type="button" style={styles.sandboxGateQuiet} onClick={onLeaveGame}>
            Back to the lobby
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
          players={stockRoundPlayerFinances}
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
      {isMyTurn && <div style={styles.turnPulseOverlay} aria-hidden="true" />}

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
        liveryColor={
          pendingHomeToken ? stationTickerColor(pendingHomeToken.companyId) : "#171c28"
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
        reason={gameEndReason}
        standings={finalStandings}
        viewerAddress={viewerAddress}
        totalAnte={PLACEHOLDER_TOTAL_ANTE}
        bankruptLabel={bankruptLabel}
      />

      {/* Design note #34: one bar. The room context is the middle of the single header now. It still says WHICH
         room this shell is bound to, and is still the only place `chatError` surfaces -- chat failing silently
         is worse than chat saying it is broken. */}
      <TopBar
        onLeaveGame={onLeaveGame}
        roomContext={
          <>
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
          </>
        }
      />

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
          <main style={styles.canvasPane}>
            {/* Design note #31: THE one action bar, hoisted above the phase branch so it renders on every active tab.
               It used to live inside the non-auction branch only, which is why the auction grew its own Pass and the
               phase tab ended up with two bars. */}
                {/* Item 5: the contextual gameplay action bar -- design notes #8/#10, with OR sub-phase guidance in
                   #10/item 2.
                   Design note #23: hidden entirely for spectators. This is the COURTESY half of read-only mode -- the
                   guarantee is `runGameplayAction`'s gate, which holds whether or not this renders. Hidden rather than
                   disabled because twenty greyed buttons offer a spectator nothing; the room strip's badge explains why. */}
                {/* Design note #521: sandbox multiplayer, offered rather than demanded. Outside the spectator branch on
                   purpose -- a spectator has no action bar (#23) and the room strip is not an action, so hiding it with
                   the controls would take away the one thing a watcher might legitimately want. */}
                {sandbox && (
                  <SandboxRoomBar
                    roomCode={sandboxRoomCode}
                    available={isFirebaseConfigured()}
                    appliedCount={sandboxAppliedCount}
                    error={sandboxRoomError}
                    busy={sandboxRoomBusy}
                    onHost={handleHostSandboxRoom}
                    onJoin={handleJoinSandboxRoom}
                    onLeave={handleLeaveSandboxRoom}
                  />
                )}
                {spectator ? (
                  <div style={styles.spectatorNotice}>
                    👁 Watching game #{gameId}. Board, ledger and market are live; every action
                    control is hidden. Join a room from the lobby to play.
                  </div>
                ) : (
                <ContextualActionBar
                  /* Design note #500: `latestFeedItem`/`onOpenActivityLog`
                     are gone. The bar no longer echoes the activity log --
                     `TopTicker` above carries it, from this same
                     `latestFeedItem`. */
                  roundType={gameState?.current_round_type ?? null}
                  /* Design note #517: the board's own round numbering, from
                     the same two fields `ContextualSubPanel` prints as
                     "OR n.m". `null` before the first poll. */
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
                  orSubPhase={orSubPhase}
                  // Controls go dead off-turn so a player is not invited to click what the dispatch gate will refuse.
                  // See docs/ai_architecture/session_keys_wallet.md - App.tsx #536
                  sessionReady={controlsEnabled && isMyTurn}
                  // WaterfallPass and PassTurn are different contract messages, not one action with two names.
                  // See docs/ai_architecture/contract_economy.md - App.tsx #31
                  onPassTurn={isWaterfallPhase ? handleWaterfallPass : handlePassTurn}
                  /* Passing is always legal: an all-pass round is what marks the cheapest private down $5. A live mini-auction is still blocked - it has its own cursor and message.
                     See docs/ai_architecture/contract_economy.md - App.tsx #311 */
                  passDisabledReason={
                    isWaterfallPhase && waterfallState?.mini_auction
                      ? "A mini-auction is running — use Drop out on the highlighted company card to leave it."
                      : null
                  }
                  onPlaceStationTokenHint={handlePlaceStationTokenHint}
                  stationTokenCost={stationTokenCost}
                  activeCorporation={activeCorporationContext}
                  /* Design note #673: the previewed lay, as the card's provisional
                     treasury. `after` is non-null here because `pendingLayCost` only
                     survives with a positive fee, which needs a known balance. */
                  pendingTreasury={
                    pendingLayCost && pendingLayCost.after !== null
                      ? { fee: pendingLayCost.fee, after: pendingLayCost.after }
                      : null
                  }
                  tokenTargetMode={tokenTargetMode}
                  setTokenTargetMode={setTokenTargetMode}
                  onSkipSubPhase={handleSkipSubPhase}
                  onOpenPrivateTrade={() => setPrivateTradeOpen(true)}
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
                  privatePowerViewer={viewerAddress}
                  sandboxMode={sandbox}
                  usedPrivateAbilities={usedPrivateAbilities}
                  onUsePrivateAbility={handleUsePrivateAbility}
                  privateAbilityError={privateAbilityError}
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
                          onProposeTrade: handleProposeTrainTrade,
                          labelForAddress: (address: string) =>
                            sandboxPlayerLabel(address) ?? truncateAddress(address),
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
                        /* Design note #639: figures for the seats that are
                           NOT acting -- the trail suppresses them on the lit
                           segment, where the card below says it properly. */
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
                  trainDrafts={trainDrafts}
                  activeTrainIndex={activeTrainIndex}
                  routeFeedback={routeFeedback}
                  onClearRoute={handleClearRoute}
                  currentGlobalEra={gameState?.current_global_era ?? null}
                  isMyTurn={isMyTurn}
                />
                )}

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
                {gameState?.current_round_type === "OperatingRound" && (
                  <PlayerCashStrip
                    players={playerCashRows}
                    label={(address) => sandboxPlayerLabel(address) ?? truncateAddress(address)}
                    colorForSeat={(index) =>
                      seatColor(gameState.player_addresses[index] ?? "", index)
                    }
                    deltas={cashDeltaByPlayer}
                    /* The seat whose corporation is operating. An OR's turn belongs to a
                       corporation and `actingAddress` already draws that line, so the strip
                       does not draw a second one. */
                    activeAddress={actingAddress(gameState, waterfallState)}
                    viewerAddress={viewerAddress ?? null}
                  />
                )}
              </>
            )}
          </main>
        </>
      )}

      {/* Design note #427: the reference tabs get a way back. Only while
          the viewer is on turn -- see that file for why a permanent banner
          would be worse than none. */}
      {/* Design note #677: `tiles` joins the list. #427's whole point is that a
         reference tab has no way back to the turn, and the new tab is exactly as
         easy to get lost on as the two that prompted it -- more so, since a
         player opens it mid-lay to check what a hex becomes. */}
      {(activeMainTab === "ledger" || activeMainTab === "rules" || activeMainTab === "tiles") && (
        <ReturnToTurnBar
          isMyTurn={isMyTurn}
          roundType={gameState?.current_round_type ?? null}
          onReturn={setActiveMainTab}
        />
      )}

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
          roundType={gameState?.current_round_type ?? null}
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
      {/* Design notes #165/#166: the two halves of the trade engine -- the sheet composes an offer, the prompt
         answers one. Shell level rather than inside the action bar because both outlive the panel that opened
         them; the prompt in particular has to survive the sub-phase advancing. */}
      <ProposePrivatePurchase
        open={privateTradeOpen}
        buyerTicker={
          gameState?.public_companies.find((c) => c.company_id === actingProtocolId)
            ?.ticker ?? "This corporation"
        }
        privates={gameState?.private_companies ?? []}
        labelForAddress={(address) => sandboxPlayerLabel(address) ?? truncateAddress(address)}
        treasury={Number(
          gameState?.public_companies.find((c) => c.company_id === actingProtocolId)
            ?.treasury ?? 0,
        )}
        onPropose={handleProposePrivatePurchase}
        onClose={() => setPrivateTradeOpen(false)}
      />
      {/* The train consent prompt -- design notes #205 and #218. ONE component, TWO sources, decided by
         deployment: SANDBOX uses local state (no chain to record an offer in, no second client to show it to),
         ONLINE derives from the contract's own register so the prompt reaches the real counterparty.
         Mutually exclusive by construction, so this can never show two offers at once. */}
      <TrainTradePrompt
        proposal={liveTrainOffer?.proposal ?? sandboxTrainProposal}
        // Sandbox names the seller so the clicker knows whose decision they stand in for; online, liveTrainOffer only exists for the seller's president.
        // See docs/ai_architecture/session_keys_wallet.md - App.tsx #536
        viewerIsSeller={
          liveTrainOffer !== null ||
          sandbox ||
          sandboxTrainProposal?.sellerPresident === viewerAddress
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
        onAccept={handleAcceptPrivateOffer}
        onReject={handleRejectPrivateOffer}
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
          onSelectCandidate={(tileId, orientation) =>
            setPreviewTile({ q: radialSelector.q, r: radialSelector.r, tileId, orientation })
          }
          legalRotationCount={legalRotations.length}
          // Design note #0 in `utils/tokenMigration.ts`: where the tokens
          // already standing on this hex end up. `null` on the ordinary
          // empty hex, which is most of them.
          tokenNote={radialTokenNote}
          /* Design note #673: the price, on the control that commits to it. Same
             `pendingLayCost` the card's provisional treasury reads. */
          costNote={pendingLayCost ? describePendingTileCost(pendingLayCost) : null}
          // Design note #488b: the caption's picture -- the same migration,
          // drawn on each candidate instead of described.
          stationMarkersFor={radialStationMarkersFor}
          /* Design note #628: the tray count for each candidate. Derived
             from the board rather than queried -- see `utils/tileSupply.ts`
             for why that arithmetic is exact and what would replace it. */
          stockFor={radialStockFor}
          onConfirm={handleConfirmRadialLay}
          onCancel={() => setPreviewTile(null)}
          onDismiss={handleDismissRadial}
        />
      )}
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