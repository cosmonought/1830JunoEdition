// frontend/src/gameEngine/index.ts
//
// ==================================================================
//  DESIGN NOTE 1500: THE ENGINE'S FRONT DOOR
// ==================================================================
//
// WHAT THIS DIRECTORY IS. The authoritative off-chain 1830 machine: the reducer, the rules it enforces,
// the state it produces and the log it replays. `server/src/gameServer.ts` runs it; the browser runs the
// same code so a sandbox game and a hosted game cannot disagree. The Rust crate at the repo root is being
// retired to the Juno escrow/settlement contract and decides no gameplay.
//
// WHY IT IS NOT IN `utils/` ANY MORE. It was, and the name said nothing true about it -- `utils/` is also
// where toasts, audio, gestures and UI-scale live, and a reader had no way to tell the game's rules from
// the shell's conveniences. The audit of 2026-09-13 put it plainly: the authoritative path is
// `gameServer.ts` -> `RoomSession.submit` -> `RoomEngine.apply` -> these modules, and that path should be
// obvious from the tree.
//
// WHY IT IS STILL UNDER `frontend/src/`. A repo-root `shared/` package is where this belongs and is a
// later infrastructure batch. Reaching it means patching CRA's `ModuleScopePlugin`, babel-loader's
// `include`, `tsconfig`'s `include` and the `src`-relative reader in `sourceScan.ts` that 137 suites use
// -- build-system work with its own risk, which has no business riding along with a file move whose whole
// claim is that nothing changed. The engine is a sibling of `components/` and `utils/`, not a child of
// either, and the server imports it directly.
//
// ------------------------------------------------------------------
//  WHAT THIS FILE EXPORTS, AND WHAT IT DELIBERATELY DOES NOT
// ------------------------------------------------------------------
//
// THE SERVER'S SURFACE, and nothing else. Every symbol below is one `server/src/` or `RoomSession`
// actually holds. The rules modules stay internal: `sharePurchase`, `dividendGate`, `trainLimit`,
// `routeAutoTrace` and the rest are the engine's own business, and a caller reaching past this file for
// one of them is doing something this note would like to hear about first.
//
// THE UI STILL IMPORTS DEEP, on purpose. Two hundred component and test files name the module they want;
// funnelling them through one barrel would be churn with no reader served, and the direction of travel is
// the other way -- fewer UI callers asking the engine for rule answers, not more. This file is the
// SERVER's door. It is not a barrel for the app.
//
// ------------------------------------------------------------------
//  THE BOUNDARY THIS DIRECTORY KEEPS
// ------------------------------------------------------------------
//
// NO REACT, NO DOM, NO CLIENT NETWORKING. Three paths used to break that and all three are closed: the
// polling hooks left `gameState.ts` (#1500 in `utils/gameStatePolling.ts`), the chart's geometry left
// `StockMarketRenderer.tsx` (#1501 in `marketGeometry.ts`), and the OR sub-phase rules left
// `OperatingSubPhaseStepper.tsx` (#1502 in `operatingSubPhase.ts`).
//
// ONE UPWARD DEPENDENCY REMAINS AND IS DELIBERATE: the board/tile/chart data cluster in `components/`
// (`hexBoardData*`, `hexGeometry`, `hexTileCatalog`, `hexContractTypes`, `TileGraphics`, `tileTray*`,
// `marketChart`, `sandboxTileLegality`). It is pure TypeScript with no React in it, so the engine stays
// server-safe; it is in the wrong directory, and it moves with tile and station legality in the batch
// that owns them.

/* ------------------------------------------------------------------ */
/* The game state, as every consumer sees it                          */
/* ------------------------------------------------------------------ */
export type {
  GameStateResponse,
  WaterfallStateResponse,
  RoundType,
  PublicCompanyState,
  PrivateCompanyState,
  MarketPositionMark,
} from "./gameState";

/* ------------------------------------------------------------------ */
/* Setup: a room's opening state                                      */
/* ------------------------------------------------------------------ */
export {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
  type SandboxMarketPrices,
} from "./sandboxState";
export { waterfallForRoster, withEmptyRoster } from "./gameSetup";
export { STANDARD_VARIANTS, resolveVariants, type GameVariants } from "./gameVariants";

/* ------------------------------------------------------------------ */
/* Execution: the reducer and the log that drives it                  */
/* ------------------------------------------------------------------ */
export { applySandboxAction } from "./sandboxSession";
export {
  RoomEngine,
  replayLog,
  entriesFromExport,
  type ExportedEntry,
  type ReplayEntry,
  type ReplayProviders,
  type ReplaySeed,
} from "./replayLog";
/* #1520: the rules-engine version a deal is pinned to, and the compatibility boundary every replay crosses
   before its first entry is applied. */
export {
  RULES_ENGINE_VERSION,
  SUPPORTED_RULES_ENGINE_VERSIONS,
  RULES_ENGINE_CHANGELOG,
  SERVER_REPLAY_POLICY,
  DEVELOPMENT_CORPUS_POLICY,
  ReplayIncompatibleError,
  replayCompatibility,
  replayRefusal,
  rulesEngineVersionOf,
  type ReplayCompatibility,
  type ReplayPolicy,
} from "./rulesVersion";
/* The one set of providers, for every headless consumer -- #1199. A server that assembled its own copy of
   the chart geometry and the board's legality rules would be one rule implemented twice, which is the
   mistake #1184, #1193 and #1194 each record. */
export { sandboxReplayProviders } from "./replayProviders";
export { effectiveActions } from "./logRevert";

/* ------------------------------------------------------------------ */
/* The wire's structural contract (#1449)                             */
/* ------------------------------------------------------------------ */
/* Shape only. What a message must LOOK like to be a message at all; whether the move is legal stays with
   the reducer. The server enforces this before `RoomSession.submit`. */
export {
  validateGameplayMessage,
  validateSubmitEnvelope,
  isRecognisedClientFrame,
  GAMEPLAY_MESSAGE_KINDS,
  GAMEPLAY_MESSAGE_SCHEMA,
  CLIENT_FRAME_KINDS,
  type MessageValidation,
} from "./messageSchema";

/* ------------------------------------------------------------------ */
/* Derivations a host needs to answer for a room                      */
/* ------------------------------------------------------------------ */
export { derivePhase, type GamePhase } from "./gamePhase";
export { stateDigest, fieldDigests } from "./stateDigest";
export { logHash } from "./logHash";
export { turnRefusal } from "./turnAuthority";
/* #1530: the excess-train obligation -- who must discard, in what order, and what a discard may do. */
export {
  pendingTrainDiscards,
  discardTrainRefusal,
  pendingDiscardBlock,
  excessTrainCount,
  countableTrainsOf,
  type PendingTrainDiscards,
  type TrainDiscardDue,
} from "./trainDiscard";
/* #1540: the forced train purchase -- the president's money, the forced sales, bankruptcy. */
export {
  emergencyFundingFor,
  forcedSaleRefusal,
  emergencyFundingBlock,
  emergencyPurchaseRefusal,
  legalForcedSales,
  type EmergencyFunding,
  type LegalForcedSale,
} from "./emergencyFunding";
