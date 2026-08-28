// frontend/src/components/HexGridRenderer.tsx
//
// The 2D canvas rail-map layer: terrain fills, decoded track, landmarks,
// station tokens, badges, nameplates, route overlays and the click interceptor.
//
// Design history -- notes #1 through #600+ -- lives in
// docs/ai_architecture/canvas_rendering.md (this component) and
// docs/ai_architecture/hex_tile_math.md (the four modules split out of it).
//
// The five rail-map modules share ONE note-numbering space: the monolith split
// moved code and its notes together, so #209 means the same note wherever it
// is cited. New notes go in docs/ai_architecture/, not back in this header.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FONT_SIZE } from "../styles/typography";
import {
  STATION_RADIUS_RATIO,
  tileCityAnchors,
  tileCitySlotCounts,
  tileCitySlotPoints,
  tileCityTokenRadius,
} from "./TileGraphics";
// Imported here AND re-exported below: the re-export keeps App.tsx's and
// TileSelectionPopup's import paths working, and creates no local binding so the two
// do not collide. MUST be at the top -- ESLint import/first.
import {
  TILE_CATALOG_BY_ID,
  type TileColorTier,
} from "./hexTileCatalog";
import {
  BOARD_HEX_FILL,
  BOARD_HEX_STROKE,
  CANADIAN_WEST_HIDDEN_EDGE,
  COLOR_TIER_STROKE,
  ERA_TILE_FILL,
  GRAY_HEXES,
  GULF_HIDDEN_EDGE,
  HEX_START_VALUE_OVERRIDE,
  IMPASSABLE_BORDER_EDGES,
  LAY_TRACK_DIM_ALPHA,
  LAY_TRACK_FOCUS_DIM_ALPHA,
  LAY_TRACK_DIM_INK,
  LAY_TRACK_HIGHLIGHT_INK,
  LANDMARK_HEXES,
  LANDMARK_TRACKS,
  NAMED_HEX_LABELS,
  OFFBOARD_LABELS,
  OFFBOARD_REVENUE,
  OFFBOARD_TRACKS,
  PRINTED_HEX_FILL,
  PRINTED_HEX_STROKE,
  STATIC_BOARD_HEXES,
  YELLOW_OO_HEXES,
  offboardValueForEra,
  terrainBuildFeeAt,
} from "./hexBoardData";
import {
  bestContrastTextColor,
  chainTileRevenue,
  stationTickerColor,
  stationTickerLabel,
  hasStationTokenAt,
  tokenCityIndex,
  STATION_HOME_HEXES,
  type HexClickQueryState,
  type LegalTilePlacementsResponse,
  type MapGridResponse,
  type MapTileEntry,
  type QueryCapableClient,
  type StationTokenCompany,
} from "./hexContractTypes";
// Design note #496: the station cursor composites the real herald, so it
// resolves the path the same way every other logo surface does.
import { logoSrcFor } from "./CorporateLogo";
import { reservationsByHex } from "../utils/privateReservations";
// Design note #888: the camera pose that puts a set of hexes on screen, as a function that can be called.
import { frameHexes } from "../utils/frameHexes";
import { canvasTouchAction, isTapGesture } from "../utils/mapGesture";
// Design note #723: the one place that decides whether ground is still unpaid.
import { terrainFeeDue } from "../utils/terrainFee";
// Design note #727: the palette a private power's hex is marked with.
import { PRIVATE_POWER_GLOW_STOPS } from "../utils/privatePowerGlow";
import type { PrivateCompanyState } from "../utils/gameState";
import {
  cityIndexAtPoint,
  cityNodePoints,
  soleCityIndex,
  stationSlotAnchor,
  tokenCityBucket,
} from "../utils/stationTokens";
import {
  archetypeForHex,
  axialToPixel,
  boardHexLabel,
  claimHexSlotPreferring,
  deadEdgesAt,
  describeHex,
  describeHexDesignationForLog,
  describeHexWithValue,
  evaluateHexForTileLaying,
  hexBlockedSlots,
  hexHasLaidTile,
  hexSlotDirection,
  liveEdges,
  liveEdgesForHex,
  localCatalogPlacements,
  marginLabelReserve,
  pixelToAxial,
  resolveSlotOverride,
  rotateConnections,
  singleNodeNameplateAnchor,
  slotsBlockedByEdges,
  twoNodePositions,
  withSlotReserve,
} from "./hexGeometry";
import {
  EMPTY_ROUTE_OVERLAYS,
  FONT_FAMILY_STACK,
  NAMEPLATE_LINE_HEIGHT_PX,
  badgeRadiusForLabel,
  drawBadgeShape,
  drawBoardMarginLabels,
  drawDitMarker,
  drawHexEdges,
  drawHexNameLabel,
  drawHexPath,
  drawImpassableBorderEdge,
  drawLabelWithBackground,
  drawLandmarkTrack,
  drawOOCityMarkers,
  drawOffboardTooltip,
  drawOffboardTrack,
  drawPrintedTrack,
  drawRestrictionBadge,
  drawReservationBadge,
  drawRouteOverlays,
  hitTestRoutes,
  type RouteHitPaths,
  drawSingleNodeNameplate,
  drawStackedNameLabel,
  drawStationCircle,
  drawStationTokenMarker,
  drawTerrainCompoundBadge,
  drawTerrainIcon,
  drawTrackPath,
  drawUnknownTilePlaceholder,
  drawValueBadge,
  fitFontSize,
  offboardNameplateLines,
  homeSlotIndex,
  stationMarkerPoint,
  stationMarkerRadius,
  withHexClip,
  type RouteOverlay,
} from "./hexCanvasPrimitives";

/* ------------------------------------------------------------------ */
/* Contract data mirrors -- see design note #2                        */
/* ------------------------------------------------------------------ */

// Contract mirrors extracted to ./hexContractTypes (Phase 3a), ahead of the geometry because the slot engine takes these types and would otherwise import back into this file.
// See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #55
export type {
  HexClickQueryState,
  LegalTilePlacement,
  LegalTilePlacementsResponse,
  MapGridResponse,
  QueryCapableClient,
  StationTokenCompany,
} from "./hexContractTypes";
export type { RouteOverlay } from "./hexCanvasPrimitives";

// DoubleTown/DoubleCityHub mirror state::TerrainType exactly. Tile catalog extracted to ./hexTileCatalog (Phase 1); re-exported because these are part of this component's public surface.
// See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #55
export type { TerrainType, TileColorTier, TileCatalogEntry } from "./hexTileCatalog";
export { TILE_CATALOG_SIZE, TILE_CATALOG_BY_ID } from "./hexTileCatalog";

// Board data extracted to ./hexBoardData (Phase 2). The import is at the top of the file -- import/first.
// See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #55


// Geometry and the 13-slot engine extracted to ./hexGeometry (Phase 3).
// See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #55

// `RouteOverlay` moved to `./hexCanvasPrimitives` alongside its only consumer,
// `drawRouteOverlays`. Re-exported below so `App.tsx`'s import path is unchanged.

export interface HexGridRendererProps {
  /** `QueryMsg::GetMapGrid`'s response, verbatim. */
  mapGrid: MapGridResponse;
  /** Design note #723: which hexes have had their terrain fee settled, from `state.terrain_fees_paid`.
   *  The badge advertises a PRICE, so it must go when the price has been paid rather than when a tile
   *  happens to be present -- see `terrainFee.ts` #723 for why those are different questions. */
  terrainFeesPaid?: readonly string[] | null;
  /** Pixel radius (center to corner) of one hex. Default 42. */
  hexSize?: number;
  /** Omit both to measure the wrapper's WIDTH and derive height from the board's own aspect ratio, so the canvas renders at true full proportional scale instead of being cropped to a bounded ancestor.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #27 */
  width?: number;
  height?: number;
  className?: string;
  /** All four interceptor props together enable the click -> GetLegalTilePlacements path; omit any to keep pan/zoom-only, query-free behaviour.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #7 */
  queryClient?: QueryCapableClient;
  contractAddress?: string;
  gameId?: number;
  protocolId?: number;
  /** Traced train routes to draw over the map. The layer the board had no equivalent of: track was drawn, but which track a train RAN was never shown.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #137 */
  routeOverlays?: readonly RouteOverlay[];
  /* The map's end of the shared route cursor, and the only surface that has to work -- on a canvas there are no elements to hover. Hex-grained hit test; a hex on two routes highlights neither.
     See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #374 */
  highlightedTrainIndex?: number | null;
  onHighlightRoute?: (trainIndex: number | null) => void;
  /* layFocus dims what the acting corporation cannot reach. #241: three tiers, not two -- the corporation's own network stays lit alongside the legal placements, and highlighted must be a subset of visible. #269: one thing on a hex at a time.
     See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #223 */
  suppressHoverTooltip?: boolean;
  layFocus?: {
    /** Not dimmed: the corporation's network plus its legal targets. */
    visible: ReadonlySet<string>;
    /** Softly glowed, and the only hexes the picker will open on. */
    highlighted: ReadonlySet<string>;
    /** Design note #252: the glow's colour -- the acting corporation's, so
     *  the board, the toolbar and the route line agree about whose turn it
     *  is. Omitted falls back to the neutral highlight ink. */
    glowColor?: string;
    /** Design note #727: hexes the acting corporation may build on by PRIVATE POWER rather than by reach.
     *  Drawn in the auction's full-hue palette so the mark cannot be read as the white "your network gets
     *  here" glow, which is the one thing it is not saying. */
    powerHexes?: ReadonlySet<string>;
    /* Slot rings are for HOME placements only, and only the home slot -- resolved by asking stationMarkerPoint (#584) rather than a second table of home cities.
       See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #585 */
    homeSlotGlow?: boolean;
    /* The veil belongs to the player whose turn it is. Set by the shell from isMyTurn, because the renderer has a board and no identity. Default false -- the undimmed board is the safe half.
       See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #377 */
    dim?: boolean;
    /* A KEY, not a set: exactly one radial menu can be open, so a set would permit a state the app cannot reach.
       See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #472 */
    soleFocusKey?: string;
  };
  /** A mode with no cursor change is a mode players forget they are in, and then every later click does something they did not intend.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #159 */
  cursorMode?: "default" | "token";
  /** Both fields together rather than a ticker this component looks a colour up for -- #428 spent a whole pass removing the last duplicate of that mapping. Omitted keeps the generic icon.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #496 */
  tokenCursor?: { ticker: string; color: string } | null;
  /** Design note #318: the live private company roster, for the reservation
   *  badges. Omitted draws none -- a board with no roster must not invent a
   *  restriction, and every caller that does not have one (the lobby
   *  preview, a thumbnail) genuinely has nothing to say about it. */
  privateCompanies?: readonly PrivateCompanyState[];
  /** Fired synchronously on every genuine hex click, before the
   *  `GetLegalTilePlacements` query (if enabled) resolves -- lets the host
   *  app position a popup immediately instead of waiting on the network. */
  onHexClick?: (info: {
    /** Design note #171: the hex's centre in canvas-CSS pixels, already
     *  through the live pan/zoom transform. Anchor in-situ UI to THIS, not
     *  to the cursor. */
    centroidX: number;
    centroidY: number;
    /* The centroid is right for a TILE picker and wrong for a STATION confirmation. Falls back to the centroid rather than being nullable: a hex with no resolvable node has exactly one sensible anchor.
       See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #516 */
    nodeX: number;
    nodeY: number;
    q: number;
    r: number;
    /** The HUMAN name -- "New York (G19)". For messages, never for lookups
     *  or wire payloads; see `boardHexLabel`'s design note #242. */
    hexLabel: string;
    /** The hex's canonical board label -- "G19". `null` for a coordinate
     *  that is not a real board hex. THIS is the identifier. */
    boardLabel: string | null;
    /* null means "could not tell", NOT "city zero" -- omitting lets the contract apply its documented fallback rather than sending a guessed index with full confidence.
       See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #453 */
    cityIndex: number | null;
    /** Design note #858: which city a HOME station is locked to on this hex, or `null` where the president
     *  may choose (an OO hex, per #742). Computed by the same `homeSlotIndex` the glow ring calls.
     *  NOT "which city was clicked" -- that is `cityIndex` above, and the whole bug was that only one of the
     *  two questions was ever asked. */
    homeCityIndex: number | null;
    clientX: number;
    clientY: number;
  }) => void;
  /** Reports the click-triggered `GetLegalTilePlacements` query's
   *  lifecycle -- see `HexClickQueryState`. */
  onHexClickQuery?: (state: HexClickQueryState) => void;
  /* ==================================================================
      DESIGN NOTE 866: A PLACEMENT WITH ONE ANSWER SHOULD NOT NEED A CLICK
     ==================================================================

     REPORTED: "clicking F16 to place the free station token is still calling up the tileselector radial
     menu. Why don't we just have the station automatically placed there with the green checkmark and red x
     above it, since there's no other placement possible in this private power?"

     TWO FAULTS AND THE SECOND ONE EXPLAINS THE FIRST. `onHexClick` and `onHexClickQuery` are BOTH wired, so
     one click on F16 reached the station stager AND the tile inspector -- the inspector opened its ring over
     the confirmation. #850 caught this shape once already and guarded it with `pendingTokenRef`, which only
     covers the case where a token is ALREADY staged; on the first click nothing is staged yet, so the guard
     is not looking.
     AND THE CLICK WAS CARRYING NO INFORMATION. F16 is a single-city hex, so the D&H's station step has one
     legal slot. A gesture whose outcome is fixed before it happens is not a choice, and making the player
     perform it is what created the collision in the first place.

     SO THE HOST ASKS AND THE BOARD ANSWERS, rather than the host waiting for a pointer it does not need. The
     board is the only thing that knows the live pan/zoom, which is why this is a prop pair here rather than
     arithmetic in the shell.
     RE-REPORTED WHENEVER THE VIEW MOVES, deliberately: the anchor is board-relative pixels, so a pan or a
     zoom while the confirmation is open would otherwise leave the ring behind the token it belongs to. */
  /** Ask the board to resolve this hex's free-station slot without a click. `null` asks nothing. */
  autoStageStation?: { q: number; r: number } | null;
  /* ==================================================================
      DESIGN NOTE 873: OPEN THE PICKER ON A HEX THE PLAYER ALREADY CHOSE
     ==================================================================
     ASKED: "why don't we have the tileselector radial menu automatically pop up on the designated hex?
     Forcing them to click Yes on the modal, then click on the hex, feels like it has an unnecessary step."
     A TOKEN, NOT A STANDING QUESTION, and that is the difference from `autoStageStation` above. That request
     is re-answered on every view change so the confirmation ring follows a pan; this one ISSUES A QUERY, so
     re-answering it on every frame of a drag would be a request per frame. The shell hands over a token and
     clears it once the board has acted on it. */
  /** A one-shot request: resolve this hex as though it had been clicked. Changing the token re-fires. */
  autoSelectHex?: { q: number; r: number; token: number } | null;
  /* ==================================================================
      DESIGN NOTE 888: FRAME THESE HEXES, BECAUSE THE MAP IS FITTED NOT SCROLLED
     ==================================================================
     REPORTED, of the Lay Track button: "Would it make more sense for this button to auto-scroll them to
     their network on the map?"
     AND THERE IS NOTHING TO SCROLL. This component opens with `detailedView = false`, which locks the camera
     at `fitView` -- the whole board fitted to the pane and centred on its own bounds -- so a player at the
     default pose already has their network on screen. It is not off screen; it is SMALL. The move that
     answers the report is a ZOOM.
     A TOKEN, THE SAME SHAPE AS `autoSelectHex` ABOVE and for the same reason: this is a one-shot request,
     not a standing question. Re-answering it every frame would fight the player's own pan the moment they
     touched the board, which is #866's collision in a different costume. */
  /** A one-shot request to frame these `"q,r"` hexes. Changing the token re-fires. */
  frameHexRequest?: { keys: readonly string[]; token: number } | null;
  /** The resolved anchor. `cityIndex` is `null` where the hex has more than one city -- the caller must then
   *  fall back to asking, because auto-staging a choice would be #858's bug with no click to blame. */
  onAutoStageStation?: (info: {
    q: number;
    r: number;
    hexLabel: string;
    boardLabel: string | null;
    cityIndex: number | null;
    nodeX: number;
    nodeY: number;
  }) => void;
  /** When set, draws a translucent dashed-outline "ghost" preview of
   *  `tileId` at `orientation` on hex `(q, r)` -- the live map preview (see
   *  design note #7 / item 3 of the popup feature). */
  previewTile?: {
    q: number;
    r: number;
    tileId: number;
    orientation: number;
    /** Design note #824: the city the token on this hex is being placed into while the ghost is up. Only
     *  meaningful where that is a choice -- an unlaid preprinted double city, whose two cities the cardboard
     *  never distinguished. `undefined` everywhere else, where the index is simply preserved.
     *  Design note #886: THE ACTING CORPORATION'S ONLY, and no longer read here. See `tokenCities`. */
    tokenCity?: number;
    /** Design note #886: `[company_id, city_index]` for every token standing on the hex, derived from
     *  connectivity at this facing (#878). */
    tokenCities?: ReadonlyArray<readonly [number, number]>;
  } | null;
  /** The live current_global_era, driving which off-board revenue tier renders. Defaults to Yellow so this still renders before a live query is wired.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #15 */
  currentEra?: TileColorTier;
  /** The live public_companies, driving the station-token pass. Defaults to an empty array -- the same fallback pattern currentEra establishes.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #36 */
  publicCompanies?: StationTokenCompany[];
}

interface ViewTransform {
  panX: number;
  panY: number;
  zoom: number;
}

const DEFAULT_HEX_SIZE = 42;
const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 640;

/** MAX_ZOOM is a MULTIPLIER on minZoom, not an absolute cap: the old constant could clamp the baseline fit down on a wide viewport, and could invert outright.
 *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #36 */
const MAX_ZOOM_MULTIPLIER = 3;

/** How far BELOW the fit a player may zoom. minZoom was also the hard floor, so "Fit to Screen" WAS the floor and "-" became a no-op there.
 *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #43 */
const MIN_ZOOM_MULTIPLIER = 0.4;
/** Absolute safety floor under the dynamically-computed board-fit minimum
 *  zoom (design note #8) -- guards only against a degenerate near-zero
 *  viewport/`hexSize` combination; in normal use the computed `minZoom`
 *  below is always well above this. */
const ABSOLUTE_MIN_ZOOM_FLOOR = 0.1;

/** The consolidated top-right control card, inset 20px so it clears drawBoardMarginLabels' own text (#28 draws those deliberately close to the board edge).
 *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #42 */
const MAP_CONTROLS_PANEL_STYLE: React.CSSProperties = {
  // Design note #44: static, below the map. Was `absolute; top/right: 20px`
  // over the canvas, covering the coordinate labels.
  display: "flex",
  justifyContent: "flex-end",
  flexWrap: "wrap",
  flexDirection: "row",
  alignItems: "stretch",
  gap: "6px",
  padding: "8px",
  borderRadius: "10px",
  border: "1.5px solid #5c6a52",
  backgroundColor: "rgba(20, 20, 20, 0.85)",
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.5)",
};

/** Base style shared by every button inside `MAP_CONTROLS_PANEL_STYLE` --
 *  see design note #42. `minWidth`/`textAlign` keep the single-character
 *  "+"/"-" buttons the same width as their wordier siblings in the same
 *  row. */
const CAMERA_CONTROL_BUTTON_STYLE: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "6px",
  border: "2px solid #5c6a52",
  backgroundColor: "rgba(255, 255, 255, 0.06)",
  color: "#f4ecd8",
  fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  fontSize: FONT_SIZE.heading,
  fontWeight: 700,
  lineHeight: 1,
  cursor: "pointer",
  minWidth: "44px",
  textAlign: "center",
};

/** A tooltip is ANNOTATION -- the smallest readable thing on screen, not the largest. This drew at heading size with nowrap and no max width. nowrap went with the cap: a cap on a line that cannot break does nothing.
 *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #29 */
const HOVER_TOOLTIP_STYLE: React.CSSProperties = {
  position: "fixed",
  zIndex: 20,
  pointerEvents: "none",
  padding: "6px 8px",
  borderRadius: "6px",
  backgroundColor: "rgba(18, 20, 26, 0.94)",
  border: "1px solid #6a7285",
  color: "#f4ecd8",
  fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  fontSize: FONT_SIZE.small,
  fontWeight: 600,
  maxWidth: "280px",
  lineHeight: 1.35,
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.55)",
};

interface BoardContentBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** One reflected min/max formula covers both cases without branching -- the two candidate bounds swap ordering exactly where the scaled board crosses the viewport size, so sorting always yields the right pair.
 *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #8 */
function panClampRange(
  boundMin: number,
  boundMax: number,
  zoom: number,
  viewportSize: number,
): { lo: number; hi: number } {
  const a = viewportSize - boundMax * zoom;
  const b = -boundMin * zoom;
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

/** Clamps a candidate `(panX, panY)` into the range `panClampRange`
 *  computes for each axis -- see design note #8. */
function clampPanToBoard(
  panX: number,
  panY: number,
  zoom: number,
  bounds: BoardContentBounds,
  viewportWidth: number,
  viewportHeight: number,
): { panX: number; panY: number } {
  const xRange = panClampRange(bounds.minX, bounds.maxX, zoom, viewportWidth);
  const yRange = panClampRange(bounds.minY, bounds.maxY, zoom, viewportHeight);
  return {
    panX: Math.min(xRange.hi, Math.max(xRange.lo, panX)),
    panY: Math.min(yRange.hi, Math.max(yRange.lo, panY)),
  };
}

/** One shared module-level empty array: a fresh [] in the destructuring default would be a new reference every render and rebuild draw's useCallback.
 *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #36 */
const EMPTY_PUBLIC_COMPANIES: StationTokenCompany[] = [];
/** Same reasoning: a stable identity so an omitted roster does not remount
 *  the memo that derives the reservations. */
const EMPTY_PRIVATE_COMPANIES: PrivateCompanyState[] = [];

/** 2000ms -> 1200ms. The delay stops a sweep trailing tooltips; 2000ms additionally cost the case the delay is FOR -- a player who stopped waited long enough to wonder if anything was coming.
 *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #383 */
export const HEX_TOOLTIP_DELAY_MS = 1200;

/* The badge says a hex carries a private's power; the tooltip says which power. APPENDED rather than
   substituted -- the hex's description is why the player hovered.
   See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #366

   Design note #714: IT SAID "RESERVED BY", AND NOTHING IS RESERVED.
   REPORTED: "these hexes are actually not locked by the private companies: any corporation can build on those
   hexes following the usual rules, it's only that the owning corporations of DH or CSL get their special
   power." "Reserved by DH" tells a president to build elsewhere, which is the opposite of true and is advice
   they may act on -- F16 is Scranton and there are turns where laying it is the right move for anybody.
   IT PRINTS THE POWER NOW, rather than paraphrasing it. `HexReservation.power` has carried the accurate
   sentence all along ("its owner may lay a tile AND place a station here at no cost") and no surface showed
   it; the badge invented a shorter, wrong one instead. */
export function withReservationNote(
  description: string,
  reservation: { initials: string; power?: string } | null,
): string {
  if (!reservation) return description;
  const clause = reservation.power
    ? `${reservation.initials}: ${reservation.power}`
    : // No power on record is still not a claim of exclusivity -- name the private and stop.
      `${reservation.initials} has a special power here`;
  return `${description} — ${clause}`;
}

/** Release a pointer capture without caring whether there was one.
 *  Design note #773: `releasePointerCapture` THROWS `NotFoundError` for a pointer that is no longer active,
 *  which is exactly the state a cancelled pointer is in -- the browser releases capture implicitly when it
 *  takes a gesture over for scrolling. Both `pointerup` and `pointercancel` call this, so the unguarded
 *  version would have turned handing scroll back to the browser into a thrown error on every swipe.
 *  A module-level `function` rather than a hook: hoisted, so it cannot repeat #762's dead zone. */
function releaseCapture(event: React.PointerEvent<HTMLCanvasElement>): void {
  try {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  } catch {
    /* The pointer ended before we got here. There is nothing left to release. */
  }
}

export function HexGridRenderer({
  mapGrid,
  terrainFeesPaid,
  hexSize = DEFAULT_HEX_SIZE,
  width: widthProp,
  height: heightProp,
  className,
  queryClient,
  contractAddress,
  gameId,
  protocolId,
  onHexClick,
  onHexClickQuery,
  autoStageStation = null,
  onAutoStageStation,
  autoSelectHex = null,
  frameHexRequest = null,
  previewTile,
  currentEra = "Yellow",
  publicCompanies = EMPTY_PUBLIC_COMPANIES,
  routeOverlays = EMPTY_ROUTE_OVERLAYS,
  highlightedTrainIndex = null,
  onHighlightRoute,
  cursorMode = "default",
  tokenCursor = null,
  suppressHoverTooltip = false,
  layFocus,
  privateCompanies = EMPTY_PRIVATE_COMPANIES,
}: HexGridRendererProps) {
  /* Design note #318: derived once per roster change, not per frame. The
     draw loop runs on every pan and zoom tick, and re-scanning the private
     companies inside it would redo the same six-entry search sixty times a
     second for a result that changes twice a game. */
  const reservations = useMemo(
    () => reservationsByHex(privateCompanies),
    [privateCompanies],
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafHandleRef = useRef<number | null>(null);
  /** Live-measured size of the wrapping `<div>` -- see design note #19.
   *  Only consulted when `widthProp`/`heightProp` are omitted; seeded with
   *  the old fixed defaults purely as a sane first-paint fallback before
   *  the `ResizeObserver` below reports its first real measurement. */
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number }>({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });

  useEffect(() => {
    if (widthProp !== undefined && heightProp !== undefined) return;
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width: observedWidth, height: observedHeight } = entry.contentRect;
      // Widened from < 1 to <= 10: a tab swap can report a transient single-digit contentRect that sails past the old gate and collapses the whole camera fit. Returning without setState already IS "preserve last known valid".
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #34
      if (observedWidth <= 10 || observedHeight <= 10) return;
      setMeasuredSize((prev) => {
        if (prev.width === observedWidth && prev.height === observedHeight) return prev;
        return { width: observedWidth, height: observedHeight };
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [widthProp, heightProp]);

  // Memoised on hexSize ALONE, not on mapGrid.tiles -- the fittable area is the physical board, not what is laid on it. Moved above the height derivation (#27), which reads it.
  // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #8
  const boardContentBounds = useMemo<BoardContentBounds>(() => {
    const points = [
      ...STATIC_BOARD_HEXES.map((h) => axialToPixel(h.q, h.r, hexSize)),
      ...LANDMARK_HEXES.map((l) => axialToPixel(l.q, l.r, hexSize)),
    ];
    // Padded by exactly hexSize -- the hexes' own centre-to-corner radius, a geometry correctness floor, not a cosmetic buffer. marginLabelReserve adds back a small proportional top-up; computeBoardMarginLabels MUST derive from the same total.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #26
    const hexEdgePadding = hexSize + marginLabelReserve(hexSize);
    return {
      minX: Math.min(...points.map((p) => p.x)) - hexEdgePadding,
      maxX: Math.max(...points.map((p) => p.x)) + hexEdgePadding,
      minY: Math.min(...points.map((p) => p.y)) - hexEdgePadding,
      maxY: Math.max(...points.map((p) => p.y)) + hexEdgePadding,
    };
  }, [hexSize]);

  const width = widthProp ?? measuredSize.width;
  /** height is DERIVED from the board's aspect ratio at the measured width, not measured -- a height:auto box just mirrors back what this renders. #30: a shorter canvas does not letterbox, it shows LESS of the board.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #27 */
  const height = useMemo(() => {
    if (heightProp !== undefined) return heightProp;
    const boundsWidth = Math.max(boardContentBounds.maxX - boardContentBounds.minX, 1);
    const boundsHeight = Math.max(boardContentBounds.maxY - boardContentBounds.minY, 1);
    return Math.round(width * (boundsHeight / boundsWidth));
  }, [heightProp, boardContentBounds, width]);
  /** Monotonic counter guarding against a stale `GetLegalTilePlacements`
   *  response (from an earlier click) resolving after a newer click's
   *  request has already superseded it -- only the most recent request's
   *  result is ever reported to `onHexClickQuery`. */
  const clickQuerySeqRef = useRef(0);

  const [view, setView] = useState<ViewTransform>({
    panX: width / 2,
    panY: height / 2,
    zoom: 1,
  });
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    originPanX: number;
    originPanY: number;
  } | null>(null);

  /** Fitting to width alone is now exactly equivalent to fitting both axes, because height matches width's implied aspect ratio by construction.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #27 */
  const minZoom = useMemo(() => {
    const boundsWidth = Math.max(boardContentBounds.maxX - boardContentBounds.minX, 1);
    const fitZoom = width / boundsWidth;
    // Design note #36/item 1: no upper clamp here anymore -- only the
    // degenerate-viewport floor. `fitZoom` IS "the base hex radius
    // multiplier scaled up so the map naturally occupies the widescreen
    // space," so nothing should cap it back down on a wide viewport.
    return Math.max(ABSOLUTE_MIN_ZOOM_FLOOR, fitZoom);
  }, [boardContentBounds, width]);

  /** The locked "100% view" pose -- exactly minZoom, centred on the board's own bounds.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #13 */
  const fitView = useMemo<ViewTransform>(() => {
    const centerX = (boardContentBounds.minX + boardContentBounds.maxX) / 2;
    const centerY = (boardContentBounds.minY + boardContentBounds.maxY) / 2;
    return {
      zoom: minZoom,
      panX: width / 2 - centerX * minZoom,
      panY: height / 2 - centerY * minZoom,
    };
  }, [boardContentBounds, minZoom, width, height]);

  /** false locks the camera at fitView and ignores pan/zoom input; true unlocks both.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #13 */
  const [detailedView, setDetailedView] = useState(false);

  /** City Nameplate Visibility toggle gates every NAME pass only -- station tokens, value badges and track splines are separate unconditional passes.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #42 */
  const [showCityNames, setShowCityNames] = useState(true);

  /** The hovered off-board hex, stored as axial (q,r) not a pixel, so it stays correct across zoom/pan. Tracked independently of drag/detailedView.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #15 */
  const [hoveredOffboardHex, setHoveredOffboardHex] = useState<{ q: number; r: number } | null>(
    null,
  );

  /** Set on EVERY pointer move regardless of hex kind, so the name-label passes can look it up for hover styling.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #15 */
  const [hoveredHexCoord, setHoveredHexCoord] = useState<{ q: number; r: number } | null>(null);

  /* The tooltip WAITS. What is not delayed is hoveredHexCoord -- that is feedback about what you are pointing at, and delaying it would make the map feel unresponsive. The timer is RESTARTED per hex. #380: the last repaint's route geometry, in board pixels.
     See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #365 */
  const routeHitRef = useRef<RouteHitPaths | null>(null);

  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTooltipTimer = useCallback(() => {
    if (tooltipTimerRef.current !== null) {
      clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
  }, []);
  // Cleared on unmount, so a pending tooltip cannot fire into a dead tree.
  useEffect(() => cancelTooltipTimer, [cancelTooltipTimer]);

  /** clientX/clientY are raw viewport coords for position:fixed. preferLeft/preferAbove flip toward whichever side of the CANVAS still has room -- not the browser window.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #75 */
  const [hoveredCoordLabel, setHoveredCoordLabel] = useState<{
    label: string;
    clientX: number;
    clientY: number;
    preferLeft: boolean;
    preferAbove: boolean;
  } | null>(null);

  /** The repaint loop is GATED on cursorMode === "token": a pulsing glow needs frames, the rest of the board does not. prefers-reduced-motion stops it entirely rather than shortening it. #496: the station cursor hook costs nothing when no corporation is armed.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #463 */
  const stationCursor = useStationCursor(
    cursorMode === "token" ? (tokenCursor?.ticker ?? null) : null,
    cursorMode === "token" ? (tokenCursor?.color ?? null) : null,
  );

  const [pulsePhase, setPulsePhase] = useState(0);
  useEffect(() => {
    if (cursorMode !== "token") {
      setPulsePhase(0);
      return;
    }
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      // Held at the swell's midpoint -- a visible ring that does not move.
      setPulsePhase(0.25);
      return;
    }
    let handle = 0;
    const started = performance.now();
    const step = (now: number) => {
      setPulsePhase((((now - started) / 1600) % 1 + 1) % 1);
      handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => cancelAnimationFrame(handle);
  }, [cursorMode]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // Neutral dark charcoal workspace background -- see design note #18.
    // Everything outside the authentic 93-hex footprint (including the real
    // A13/A15 gap) simply shows this solid fill; no decorative hex fills any
    // of that space anymore.
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, width, height);

    ctx.translate(view.panX, view.panY);
    ctx.scale(view.zoom, view.zoom);

    // Used by every label pass below (moved up from its previous spot
    // right before the landmark labels, since the new terrain-icon labels
    // pass now needs it earlier too).
    const hexFlatWidth = Math.sqrt(3) * hexSize;

    // ---- Static board background (see design note #6) -- drawn first, so
    // everything else (landmark shading, laid tiles, labels) layers on top
    // of it. This is what makes the board visible at game launch, before
    // any tile has been laid.
    for (const hex of STATIC_BOARD_HEXES) {
      const center = axialToPixel(hex.q, hex.r, hexSize);
      drawHexPath(ctx, center, hexSize);
      // Pre-printed gray/yellow hexes override the ordinary terrain fill
      // (see design note #12) -- `hex.type` still drives the terrain icon
      // pass below regardless, so e.g. E5 gets BOTH the yellow fill AND its
      // river icon/cost label.
      ctx.fillStyle = hex.printedColor ? PRINTED_HEX_FILL[hex.printedColor] : BOARD_HEX_FILL[hex.type];
      ctx.fill();
      ctx.strokeStyle = hex.printedColor
        ? PRINTED_HEX_STROKE[hex.printedColor]
        : BOARD_HEX_STROKE[hex.type];
      ctx.lineWidth = 1;
      // Gulf (I1/J2) and Canadian West (A9/A11) suppress their one shared interior edge so each reads as a single merged region.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #26
      const hiddenEdge = GULF_HIDDEN_EDGE[hex.label] ?? CANADIAN_WEST_HIDDEN_EDGE[hex.label];
      if (hiddenEdge !== undefined) {
        drawHexEdges(ctx, center, hexSize, new Set([hiddenEdge]));
      } else {
        ctx.stroke();
      }
    }

    // ONE claimed-slot ledger per render, threaded through every slot-picking pass in draw order -- New York's badge, cost label and icon all independently picked the same open corner.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #72
    const claimedHexSlots = new Map<string, Set<number>>();

    // The complex-hex terrain preference, shared by the icon and cost so both agree which quadrant is "bottom-right". #105 reordered it to lead with the two lower corners.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #105
    const COMPLEX_HEX_TERRAIN_SLOT_PREFERENCE: readonly number[] = [9, 11, 3, 10];

    // A complex hex draws NO standalone Layer-1 icon -- it is folded into the compound [icon+cost] badge below, claiming ONE slot instead of two. Generalised past the old DoubleCity-only check, which missed the SingleCity River hexes.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #87
    for (const hex of STATIC_BOARD_HEXES) {
      if (hex.type !== "Mountain" && hex.type !== "River") continue;
      // A LAID TILE COVERS THE PREPRINT. The isComplexHex test already skipped most tiled hexes as a SIDE EFFECT -- it asks "is this busy", not "is it covered".
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #150
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const terrainType = hex.type;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isComplexHex =
        archetypeForHex(mapGrid, hex.q, hex.r) !== "Plain" ||
        liveEdgesForHex(mapGrid, hex.q, hex.r).length > 0;
      if (isComplexHex) continue;
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask --
      // the terrain icon itself never bleeds past this hex's own border.
      withHexClip(ctx, center, hexSize, () => {
        drawTerrainIcon(ctx, terrainType, center, hexSize);
      });
    }

    // The dashed landmark outline is REMOVED: dashes already mean "provisional" in this renderer (the ghost preview, the unknown-tile placeholder), and ringing three ordinary preprinted yellow hexes drew a distinction the board does not make.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #160

    // A printedColor:"Yellow" hex no longer keeps its yellow fill once upgraded -- ERA wins everywhere, which is what tells a player the hex has actually moved tier.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #122

    for (const tile of mapGrid.tiles) {
      const catalogEntry = TILE_CATALOG_BY_ID.get(tile.tile_id);
      const center = axialToPixel(tile.q, tile.r, hexSize);

      drawHexPath(ctx, center, hexSize);
      // Design note #122: era, and only era. No terrain keying, and no
      // printed-yellow override for landmark/OO hexes -- see `ERA_TILE_FILL`.
      ctx.fillStyle = catalogEntry ? ERA_TILE_FILL[catalogEntry.color] : "#dddddd";
      ctx.fill();
      ctx.strokeStyle = catalogEntry ? COLOR_TIER_STROKE[catalogEntry.color] : "#9a9a9a";
      ctx.lineWidth = 2;
      ctx.stroke();

      if (catalogEntry) {
        // The !landmarkAt guard is GONE, and its removal is the real fix: it meant a laid tile on a landmark never called drawTrackPath, so what the player saw was the PRE-PRINTED stubs crossing with a station on the intersection.
        // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #133
        withHexClip(ctx, center, hexSize, () => {
          // No longer passes tile.paths -- double-town artwork comes from the explicit DOUBLE_TOWN_ROUTES table. #486: showRestriction false, because the hex badge already labels it one slot away.
          // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #121
          drawTrackPath(ctx, center, hexSize, catalogEntry, tile.orientation, false, undefined, false);
        });
      } else {
        // Unknown tile_id draws readable provisional artwork rather than an alarming bare red "?" that read as an error state.
        // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #118
        withHexClip(ctx, center, hexSize, () => {
          drawUnknownTilePlaceholder(ctx, center, hexSize, tile.tile_id);
        });
      }
    }

    // ---- Landmark pre-printed track, always drawn (see design note #6b).
    // Positioned after the per-tile loop (not folded into the earlier
    // landmark-shading pass) so a laid hub tile's own opaque fill -- drawn
    // in that loop above -- can never paint over this authentic track.
    for (const landmark of LANDMARK_HEXES) {
      // A landmark's printed track is STARTING artwork, not a permanent overlay -- once a tile is laid the stubs are physically covered.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #133
      if (hexHasLaidTile(mapGrid, landmark.q, landmark.r)) continue;
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
      withHexClip(ctx, center, hexSize, () => {
        // Design note #211: keyed on the hex LABEL, which is what the
        // printed artwork catalog is authored against.
        drawLandmarkTrack(ctx, center, hexSize, landmark.label);
      });
    }

    // Off-board printed track is always drawn; OffboardHexNotBuildable makes it impossible for mapGrid.tiles to ever hold an entry here.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #10
    for (const hex of STATIC_BOARD_HEXES) {
      const edges = OFFBOARD_TRACKS[hex.label];
      if (!edges) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
      withHexClip(ctx, center, hexSize, () => {
        drawOffboardTrack(ctx, center, hexSize, edges);
      });
    }

    // ---- Pre-printed gray hex track + city/town markers, always drawn
    // (see design note #12) -- symmetric with the landmark/off-board track
    // passes above.
    for (const hex of STATIC_BOARD_HEXES) {
      const grayTrack = GRAY_HEXES[hex.label];
      if (!grayTrack) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
      withHexClip(ctx, center, hexSize, () => {
        drawPrintedTrack(ctx, center, hexSize, hex.label);
      });
    }

    // ---- Pre-printed yellow "OO" double-city hexes (see design note #12)
    // -- two independent station circles, no connecting track (the real
    // board prints none there either).
    for (const hex of STATIC_BOARD_HEXES) {
      if (!YELLOW_OO_HEXES.has(hex.label)) continue;
      // "Always drawn" was written when nothing could be laid on these four hexes. Once green #59 could be, an upgraded OO hex rendered FOUR station circles. Not to be confused with the corner OO RESTRICTION badge, which #49 keeps across every tier.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #150
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #55: Strict Hex Boundary Clipping, extended to station
      // markers -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        drawOOCityMarkers(ctx, center, hexSize);
      });
    }

    // Blank Town/Double-Town designated hexes get their dit marker(s) even with no printed track, so a player can see which blank hexes are reserved for a town tile.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #55
    for (const hex of STATIC_BOARD_HEXES) {
      if (!hex.townDesignation) continue;
      // Design note #150: a laid tile carries its own town/city artwork, so
      // the "reserved for a Town tile" marker has done its job and is now
      // describing a hex that is no longer blank.
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #55: Strict Hex Boundary Clipping, extended to station/
      // dit markers -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        if (hex.townDesignation === "double") {
          // The SAME shared twoNodePositions tuple drawOOCityMarkers uses, indexed 0/1 with no re-sorting -- every two-node hex reads identically.
          // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #58
          const [node0, node1] = twoNodePositions(center, hexSize);
          drawDitMarker(ctx, node0, hexSize * 0.85); // index 0: top-right
          drawDitMarker(ctx, node1, hexSize * 0.85); // index 1: bottom-left
        } else {
          drawDitMarker(ctx, center, hexSize);
        }
      });
    }

    // Blank city-designated hexes use drawStationCircle, the same primitive every real city marker uses, so they read as genuine cities rather than town stops.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #34
    for (const hex of STATIC_BOARD_HEXES) {
      if (!hex.cityDesignation) continue;
      // A laid MajorCityHub draws its own circle in the same place; stacking two reads as a rendering imprecision rather than an obvious bug, which is worse.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #150
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #55: Strict Hex Boundary Clipping, extended to station
      // markers -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        drawStationCircle(ctx, center, hexSize);
      });
    }

    // Route overlays draw AFTER every track pass (so a route runs ON the rails) and BEFORE tokens and badges (so it never buries the markers). #195: the second lookup is what fixes preprinted track. #373: emphasis is computed here and handed down as data.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #137
    const emphasised = routeOverlays.map((overlay) => ({
      ...overlay,
      emphasis:
        highlightedTrainIndex === null || overlay.trainIndex === undefined
          ? ("normal" as const)
          : overlay.trainIndex === highlightedTrainIndex
            ? ("primary" as const)
            : ("muted" as const),
    }));

    /* The draw hands back the flattened stroke geometry for the pointer to test against. A ref, not state -- re-rendering because the hit geometry moved would repaint the canvas, which rebuilds the geometry.
       See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #380 */
    routeHitRef.current = drawRouteOverlays(
      ctx,
      hexSize,
      emphasised,
      (q, r) => mapGrid.tiles.find((tile) => tile.q === q && tile.r === r),
      // Endpoints resolve to a single authored rail, so no branch needs to know how a hex was drawn. #215: the printed label, so a route across a gray hex lights the ONE rail it runs along.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #226
      (q, r) => {
        const boardHex = STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r);
        if (boardHex && GRAY_HEXES[boardHex.label]) return boardHex.label;
        /* Design note #895: the red areas answer here too. They were absent, so a route running onto an
           off-board hex resolved no label, found no authored rail, and was drawn in no colour at all. Their
           stubs are generated into `PRINTED_GRAPHICS_CATALOG` from `OFFBOARD_TRACKS`, so from this callback's
           point of view an off-board hex is simply another preprinted one -- which is what it is. */
        if (boardHex && OFFBOARD_TRACKS[boardHex.label]) return boardHex.label;
        const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
        return landmark?.label;
      },
    );

    /* Tokens are drawn LAST, not merely late. A badge covering a token is worse than a badge covering track: a token says whose network this is, and a route's legality turns on it.
       See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #222 */
    const drawStationTokenPass = () =>
    {
      const companiesById = new Map<number, StationTokenCompany>();
      for (const company of publicCompanies) {
        companiesById.set(company.company_id, company);
      }

      for (const home of STATION_HOME_HEXES) {
        const company = companiesById.get(home.companyId);
        /* The test is the TOKEN, not is_floated. Between floating and placing, is_floated is already true and no token exists -- so the badge was skipped and the pass below had nothing to draw, blanking exactly the hex the Place Home Station prompt is about.
           See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #608 */
        /* Design note #724: AND IT IS THE RIGHT TOKEN LIST. This read `station_tokens`, the OPTIONAL
           `(q, r, city_index)` mirror, whose own type comment says an empty one means "this chain doesn't
           know" rather than "no tokens" -- so the badge survived the placement it was reserving for and
           reappeared as a second marker the moment an upgrade gave the city a second slot. `station_token_hexes`
           is the required list and the one the real-token pass below already walks. */
        const homePlaced = company ? hasStationTokenAt(company, home.q, home.r) : false;
        if (homePlaced) continue; // the real token is drawn by the pass below instead
        // Station Token Badges (design note #43): a RESERVED (not-yet-
        // floated) marker on a `YELLOW_OO_HEXES` home hex (today, only
        // ERIE/E11) is drawn in neutral hex-margin space below both station
        // circles -- NOT `stationMarkerPoint`'s own left-circle anchor --
        // since real 1830 lets that corporation's President choose EITHER
        // of the two slots on its first Operating Round turn after
        // floating (module doc comment #23 in `hexmap.rs`); anchoring the
        // still-undecided reserved badge onto one specific circle would
        // misleadingly imply that slot is already committed. The ACTUAL
        // token, once floated, still renders via `stationMarkerPoint`
        // below (unchanged) -- the chain only ever records this hex's one
        // `(q, r)`, not which of the two corners was chosen, so the real
        // marker keeps its existing left-circle convention.
        const homeCenter = axialToPixel(home.q, home.r, hexSize);
        // E11 only: the reserved marker's straight-down point overlapped the bottom city marker, moved to Vertex 2 at the SAME magnitude. The other three OO hexes were not reported and are unchanged.
        // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #106
        const erieVertex2 = hexSlotDirection(9);
        /* Design note #724a: THE BADGE FOLLOWS THE TILE, like the token it stands in for. This passed no
           `laidTile`, so it took `stationMarkerPoint`'s tile-less fallback and sat wherever the bare hex put
           it -- while the real token, once a tile exists, uses that tile's own city anchor. The two agree only
           while the hex is bare, which is why the stale badge #724 fixed looked like a single correct marker
           until somebody upgraded underneath it.
           IT MATTERS ON ITS OWN, not just as part of that bug: another corporation may lay track on an unfloated
           company's home hex, and the reservation badge should mark the city it is reserving rather than a
           point the tile no longer has a station at.
           THE TWO OO BRANCHES ARE UNTOUCHED. #43 anchors those in neutral hex-margin space ON PURPOSE, because
           the President still gets to choose either slot and committing the badge to one would lie about it. */
        const homeLaidTile = mapGrid.tiles.find((tile) => tile.q === home.q && tile.r === home.r);
        /* Design note #826: THE BADGE THAT STANDS IN THE MARGIN. #43 put the OO hexes' reservations in
           neutral hex-margin space because the President has not chosen a circle yet; every other home hex
           marks the city its token will occupy. That difference is what decides whether a RING belongs --
           see `drawStationTokenMarker`'s `ringed`. */
        const inMargin = YELLOW_OO_HEXES.has(home.label);
        const point =
          home.label === "E11"
            ? { x: homeCenter.x + erieVertex2.x * hexSize * 0.46, y: homeCenter.y + erieVertex2.y * hexSize * 0.46 }
            : inMargin
              ? { x: homeCenter.x, y: homeCenter.y + hexSize * 0.46 }
              : stationMarkerPoint(home.q, home.r, hexSize, homeLaidTile);
        // Design note #55: Strict Hex Boundary Clipping, extended to
        // station token markers -- previously only track/text calls were
        // wrapped.
        withHexClip(ctx, homeCenter, hexSize, () => {
          drawStationTokenMarker(
            ctx,
            point,
            hexSize,
            // Prefer the live ticker, fall back to the static table -- never an empty string, so every reserved badge draws its acronym regardless of query timing.
            // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #45
            company?.ticker || stationTickerLabel(home.companyId),
            stationTickerColor(home.companyId),
            true,
            undefined,
            // Design note #826: no ring on a badge that is not in a city.
            !inMargin,
          );
        });
      }

      // PER-SLOT placement: two tokens at a pill's centre stack and hide whether the city still has room. The chain records WHICH CITY but not which SLOT, because a slot has no meaning in the rules -- so order is chosen here, deterministically, and nothing downstream should read it as authoritative.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #134
      const occupantsByCity = new Map<string, StationTokenCompany[]>();
      for (const company of publicCompanies) {
        if (!company.is_floated) continue;
        for (const [q, r] of company.station_token_hexes) {
          /* Design note #251: the bucket key must match the index the draw pass below resolves, or a company
             would be counted into one city's occupants and drawn from another's slot list.
             Design note #698 moved the rule itself into `tokenCityBucket`, because the PREVIEW has to count
             these same buckets to know which slot it is about to fill. The old expression here read
             `?? (cities === 1 ? 0 : 0)`, both arms zero -- an unfinished thought that had already collapsed to
             the fallback the helper now states plainly. */
          const key = `${q},${r},${tokenCityBucket(company, q, r)}`;
          const bucket = occupantsByCity.get(key);
          if (bucket) bucket.push(company);
          else occupantsByCity.set(key, [company]);
        }
      }
      // `forEach`, not `for...of` over `.values()` -- tsconfig targets ES5
      // without `downlevelIteration`, so iterating a Map iterator is a
      // compile error here.
      occupantsByCity.forEach((bucket) => {
        bucket.sort((a, b) => a.company_id - b.company_id);
      });

      for (const company of publicCompanies) {
        if (!company.is_floated) continue;
        for (const [q, r] of company.station_token_hexes) {
          /* Design note #822: THE TILE THE PLAYER IS LOOKING AT. While a preview is up on this hex the token
             is about to sit on the PREVIEWED tile, so its slot geometry is what the marker must be drawn
             against -- otherwise a two-city upgrade puts the token in the city it used to be in rather than
             the one this orientation gives it.
             AND ON A PREPRINTED HEX THERE IS NO OTHER ANSWER. ERIE's home is an unlaid OO hex, so `laid` is
             `undefined` until the green upgrade lands: without this the preview has no tile to anchor to at
             all, which is exactly where the report starts. */
          const laid = mapGrid.tiles.find((entry) => entry.q === q && entry.r === r);
          const laidTile: MapTileEntry | undefined =
            previewTile && previewTile.q === q && previewTile.r === r
              ? /* Everything the geometry reads comes from `tile_id` and `orientation`; `landmark` is carried
                   across from the real entry, or null on a preprinted hex that has no entry yet. Spelling the
                   whole shape out rather than casting, so a field added to `MapTileEntry` later fails here
                   instead of arriving as `undefined` inside a renderer. */
                {
                  q,
                  r,
                  tile_id: previewTile.tileId,
                  orientation: previewTile.orientation,
                  paths: laid?.paths ?? null,
                  revenue: laid?.revenue ?? null,
                  landmark: laid?.landmark ?? null,
                }
              : laid;
          /* Design note #824: while a preview is up on this hex and the president is choosing a destination,
             the marker belongs in the city they are looking at rather than the one the chain recorded --
             which on an unlaid preprinted pair was never a fact about the board anyway.
             ==================================================================
              DESIGN NOTE 886: ONE INDEX CANNOT PLACE TWO MARKERS
             ==================================================================
             REPORTED: "on other OO hexes, the stations are previewing incorrectly and jumping around on
             rotations, not maintaining their corporation's network connectivity as they must."
             THIS READ `previewTile.tokenCity` -- ONE NUMBER -- INSIDE A PER-COMPANY LOOP. Every token on the
             hex was drawn in the ACTING corporation's chosen city, and that number changes with every
             rotation, so a rival's marker hopped from circle to circle while its own network stayed put.
             It is #880's wire bug on the canvas: an index says where ONE token goes, and an OO hex can hold
             two. The map answers per company, and a company with no entry keeps what the chain recorded. */
          const previewCity =
            previewTile && previewTile.q === q && previewTile.r === r
              ? previewTile.tokenCities?.find(([id]) => id === company.company_id)?.[1]
              : undefined;
          const chainCity = previewCity ?? tokenCityIndex(company, q, r);
          const tokenCenter = axialToPixel(q, r, hexSize);

          let point: { x: number; y: number } | undefined;
          /* Design note #151: the docking RADIUS, resolved from the same artwork the slot position comes
             from. #699 rewrote the tail of that sentence: it used to be left `undefined` on the fallback path
             "where there is no pill to dock into and the legacy `size * 0.22` is the correct answer". It was
             not the correct answer -- a preprinted hex still draws a circle with a size, and 0.22 happened to
             equal it on a single city and overflow it on an OO pair. `stationMarkerRadius` asks properly. */
          let dockRadius: number | undefined;

          /* The slot machinery was always right; what gated it was chainCity !== undefined. The original caution holds for a genuinely TWO-city tile, but a one-city tile's index is 0 and there is nothing to guess.
             See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #251 */
          const cityCount = laidTile ? tileCitySlotCounts(laidTile.tile_id).length : 0;
          const resolvedCity = chainCity ?? (cityCount === 1 ? 0 : undefined);

          if (laidTile && resolvedCity !== undefined) {
            const slotPoints = tileCitySlotPoints(
              laidTile.tile_id,
              resolvedCity,
              laidTile.orientation,
              tokenCenter,
              hexSize,
            );
            const bucket = occupantsByCity.get(`${q},${r},${resolvedCity}`) ?? [];
            const slot = bucket.findIndex((entry) => entry.company_id === company.company_id);
            // A bucket longer than the city has slots means chain and mirror disagree about capacity; clamping keeps the token visible rather than vanishing -- the more debuggable failure.
            // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #251
            point = slotPoints[Math.min(Math.max(slot, 0), slotPoints.length - 1)];
            // Only when a real slot point was found. If `slotPoints` came
            // back empty the token falls through to the per-hex anchor
            // below, and a docking radius there would shrink a token that
            // is not docked in anything.
            // Design note #699: the CITY's radius, not the tile's -- a tile can carry a shared city beside an
            // unshared one, and only the shared one owes the pill's inset.
            if (point) dockRadius = tileCityTokenRadius(laidTile.tile_id, hexSize, resolvedCity);
          }

          // The city travels to the fallback too: on an UNLAID preprinted OO hex there is no artwork to anchor to, so without it a token in the north-east city was drawn in the south-west one.
          // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #459
          const resolved = point ?? stationMarkerPoint(q, r, hexSize, laidTile, chainCity);
          /* Design note #699: and the radius from the SAME branch that chose the point. Left undefined, the
             fallback fell to a flat `size * 0.22` -- which on preprinted Baltimore is its circle's exact
             radius, so a home token painted the circle out, and on a preprinted OO hex overflowed it. That
             difference is the "border around the second station" report: not a style, just two radii. */
          dockRadius = dockRadius ?? stationMarkerRadius(q, r, hexSize, laidTile, chainCity);
          withHexClip(ctx, tokenCenter, hexSize, () => {
            drawStationTokenMarker(
              ctx,
              resolved,
              hexSize,
              company.ticker,
              stationTickerColor(company.company_id),
              false,
              dockRadius,
            );
          });
        }
      }
    };

    // A landmark's nameplate anchor is derived from its ARCHETYPE, not a name check -- Boston/Baltimore take the SingleCity wedge, New York the DoubleCity dead-centre anchor.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #55
    for (const landmark of LANDMARK_HEXES) {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle -- station tokens/badges/tracks are all drawn by separate
      // passes above and are unaffected by this skip.
      if (!showCityNames) continue;
      // Dynamic City Nameplate Suppression: a laid tile physically covers the printed name. The name stays available on hover, which is why describeHex was extended to cover every named hex.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #47
      if (hexHasLaidTile(mapGrid, landmark.q, landmark.r)) continue;
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === landmark.q && hoveredHexCoord.r === landmark.r,
      );
      const archetype = archetypeForHex(mapGrid, landmark.q, landmark.r);
      // Design note #78: the nameplate shows `displayName` when the landmark
      // has one (New York -> "New York & Newark"), falling back to the real
      // structural `name` otherwise -- see that field's own doc comment.
      const displayName = landmark.displayName ?? landmark.name;
      // withHexClip extended to nameplate text -- a name near a hex's edge could bleed into the neighbour.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #53
      withHexClip(ctx, center, hexSize, () => {
        if (archetype === "DoubleCity") {
          const parts = displayName.split(" & ");
          if (parts.length === 2) {
            const lineMaxWidth = hexFlatWidth * 0.85;
            drawStackedNameLabel(ctx, [parts[0], parts[1]], center, lineMaxWidth, isHovered);
          } else {
            drawHexNameLabel(ctx, displayName, center, hexFlatWidth * 0.85, isHovered);
          }
        } else {
          const anchor = singleNodeNameplateAnchor(
            center,
            hexSize,
            mapGrid,
            landmark.q,
            landmark.r,
            claimedHexSlots,
          );
          drawSingleNodeNameplate(ctx, displayName, anchor, hexFlatWidth * 0.92, isHovered);
        }
      });
    }

    // Gray hex names, upper third. The four OO hexes are excluded here and get their own split-label pass -- one centred string through a hex with two stations is what that pass exists to stop.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #12
    for (const hex of STATIC_BOARD_HEXES) {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle.
      if (!showCityNames) continue;
      const name = NAMED_HEX_LABELS[hex.label];
      if (!name) continue;
      if (YELLOW_OO_HEXES.has(hex.label)) continue;
      // Design note #41 (Stacked Dual-Name Labels): the three double-town
      // hexes get their own split+stacked pass below, same as the OO
      // double-city hexes just below that -- skip the single-centered-
      // string treatment here for them.
      if (hex.townDesignation === "double") continue;
      // Dynamic City Nameplate Suppression (design note #47): see the
      // landmark pass above -- identical skip, applied here for every
      // remaining `NAMED_HEX_LABELS` city (Washington, Toledo, Providence,
      // Albany, Cleveland, Altoona, and the rest).
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === hex.q && hoveredHexCoord.r === hex.r,
      );
      // Every hex this pass reaches resolves to SingleCity or SingleTown, both sharing the upper-left wedge anchor. #70: now dynamically slot-aware.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #55
      const anchor = singleNodeNameplateAnchor(center, hexSize, mapGrid, hex.q, hex.r, claimedHexSlots);
      // Design note #53: Hex Boundary Clipping Mask, extended to nameplate
      // text -- see the landmark pass above for the full reasoning.
      withHexClip(ctx, center, hexSize, () => {
        drawSingleNodeNameplate(ctx, name, anchor, hexFlatWidth * 0.92, isHovered);
      });
    }

    // OO names are SPLIT and STACKED at true hex centre: with the two circles on a diagonal, the open space is the middle of the hex, not the top. Side-by-side squeezed each half into less than half the hex's width.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #49
    for (const hex of STATIC_BOARD_HEXES) {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle.
      if (!showCityNames) continue;
      const name = NAMED_HEX_LABELS[hex.label];
      if (!name || !YELLOW_OO_HEXES.has(hex.label)) continue;
      // Dynamic City Nameplate Suppression (design note #47): see the
      // landmark pass above -- UNCHANGED by design note #49, which only
      // repositions where this nameplate sits, not whether it persists.
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const [primaryName, secondaryName] = name.split(" & ");
      if (!primaryName || !secondaryName) continue; // defensive -- every real OO name is "A & B"
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === hex.q && hoveredHexCoord.r === hex.r,
      );
      const lineMaxWidth = hexFlatWidth * 0.85;
      // Line spacing is derived inside drawStackedNameLabel from the same constant, no longer computed at this call site.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #84
      withHexClip(ctx, center, hexSize, () => {
        drawStackedNameLabel(ctx, [primaryName, secondaryName], center, lineMaxWidth, isHovered);
      });
    }

    // The three double-town hexes split the same "A & B" way as the OO pass, for the same readability reason.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #41
    for (const hex of STATIC_BOARD_HEXES) {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle.
      if (!showCityNames) continue;
      if (hex.townDesignation !== "double") continue;
      const name = NAMED_HEX_LABELS[hex.label];
      if (!name) continue;
      // Dynamic City Nameplate Suppression (design note #47): see the
      // landmark pass above.
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const [primaryName, secondaryName] = name.split(" & ");
      if (!primaryName || !secondaryName) continue; // defensive -- every real double-town name is "A & B"
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === hex.q && hoveredHexCoord.r === hex.r,
      );
      const lineMaxWidth = hexFlatWidth * 0.85;
      // Moved to TRUE HEX CENTRE, mirroring #49's OO repositioning -- with the dits now diagonal, centre is the open channel between them.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #54
      withHexClip(ctx, center, hexSize, () => {
        drawStackedNameLabel(ctx, [primaryName, secondaryName], center, lineMaxWidth, isHovered);
      });
    }

    // Name lines and revenue badge lay out as ONE combined block centred on the hex, replacing two fixed offsets that only looked adjacent for a one-line name.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #78
    const drawOffboardNameplate = (
      center: { x: number; y: number },
      offboardName: string,
      isHovered: boolean,
    ) => {
      // Wraps onto two lines ONLY for "Maritime Provinces" -- the one named exception. Every other zone name stays single-line, reversing #47's "every multi-word name wraps".
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #83
      const nameLines: readonly string[] = showCityNames ? offboardNameplateLines(offboardName) : [];
      const nameBlockHeight = nameLines.length * NAMEPLATE_LINE_HEIGHT_PX;

      const tiers = OFFBOARD_REVENUE[offboardName];
      // Design note #66: `$` prefix DROPPED, same reasoning as
      // `drawValueBadge`'s own comment.
      const activeValue = tiers ? `${offboardValueForEra(tiers, currentEra)}` : "";
      // Text-driven badge sizing; badge text stays BOLD, since #78's regular-weight change is scoped to nameplate TEXT.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #63
      const offboardFontSizePx = Math.max(9, hexSize * 0.24) - 1;
      let badgeRadius = 0;
      if (tiers) {
        ctx.font = `bold ${offboardFontSizePx}px ${FONT_FAMILY_STACK}`;
        badgeRadius = badgeRadiusForLabel(ctx.measureText(activeValue), offboardFontSizePx, "square", 2, 1.5, 5);
      }
      const badgeDiameter = badgeRadius * 2;
      // The gap is only drawn when both pieces are present, so a badge-only block carries no stray empty gap.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #85
      const gap = nameLines.length > 0 && tiers ? hexSize * 0.08 : 0;
      const totalHeight = nameBlockHeight + gap + badgeDiameter;
      const blockTop = center.y - totalHeight / 2;
      // Design note #85: order flipped -- badge now occupies the TOP of the
      // combined block, name text sits directly beneath it (was the
      // reverse). `nameBlockStart` (below) marks where the name text's own
      // band begins, after the badge and the gap.
      const nameBlockStart = blockTop + badgeDiameter + gap;

      if (tiers) {
        // Centered at the TOP of the combined block.
        const badgeCenter = { x: center.x, y: blockTop + badgeRadius };

        // Design note #62: solid white square badge, dark-navy stroke --
        // off-board revenue is grouped with city hub revenue under this
        // pass's "Squares = City/Off-Board Revenue" rule.
        drawBadgeShape(ctx, badgeCenter, badgeRadius, "square");

        // Bold black text -- no halo needed on a white fill.
        ctx.fillStyle = "#000000";
        ctx.font = `bold ${offboardFontSizePx}px ${FONT_FAMILY_STACK}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(activeValue, badgeCenter.x, badgeCenter.y);
      }

      // A two-line name draws through drawStackedNameLabel for ONE shared shield -- two independent 0.55-alpha boxes composited into a visibly darker seam.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #84
      if (nameLines.length === 2) {
        const linesCenterY = nameBlockStart + NAMEPLATE_LINE_HEIGHT_PX;
        drawStackedNameLabel(ctx, [nameLines[0], nameLines[1]], { x: center.x, y: linesCenterY }, hexFlatWidth * 0.92, isHovered);
      } else if (nameLines.length === 1) {
        const lineCenterY = nameBlockStart + NAMEPLATE_LINE_HEIGHT_PX * 0.5;
        drawHexNameLabel(ctx, nameLines[0], { x: center.x, y: lineCenterY }, hexFlatWidth * 0.92, isHovered);
      }
    };

    for (const hex of STATIC_BOARD_HEXES) {
      const offboardName = OFFBOARD_LABELS[hex.label];
      if (!offboardName) continue;
      // Design note #26/item 3 / item 9: I1/J2 (Gulf) and A9/A11 (Canadian
      // West) are each drawn with ONE shared nameplate below instead of one
      // each here.
      if (GULF_HIDDEN_EDGE[hex.label] !== undefined) continue;
      if (CANADIAN_WEST_HIDDEN_EDGE[hex.label] !== undefined) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === hex.q && hoveredHexCoord.r === hex.r,
      );
      // Design note #55: Strict Hex Boundary Clipping, extended to
      // off-board nameplates -- previously unclipped.
      withHexClip(ctx, center, hexSize, () => {
        drawOffboardNameplate(center, offboardName, isHovered);
      });
    }

    // Gulf's and Canadian West's merged nameplates draw once at the two hexes' midpoint. Deliberately NOT withHexClip'd: the midpoint sits ON the shared border, and clipping to either hex would slice the text in half.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #26
    for (const [labelA, labelB, name] of [
      ["I1", "J2", "Gulf"],
      ["A9", "A11", "Canadian West"],
    ] as const) {
      const hexA = STATIC_BOARD_HEXES.find((h) => h.label === labelA);
      const hexB = STATIC_BOARD_HEXES.find((h) => h.label === labelB);
      if (hexA && hexB) {
        const centerA = axialToPixel(hexA.q, hexA.r, hexSize);
        const centerB = axialToPixel(hexB.q, hexB.r, hexSize);
        const mergedCenter = { x: (centerA.x + centerB.x) / 2, y: (centerA.y + centerB.y) / 2 };
        const isHovered = Boolean(
          hoveredHexCoord &&
            ((hoveredHexCoord.q === hexA.q && hoveredHexCoord.r === hexA.r) ||
              (hoveredHexCoord.q === hexB.q && hoveredHexCoord.r === hexB.r)),
        );
        drawOffboardNameplate(mergedCenter, name, isHovered);
      }
    }

    // Terrain cost is a solid RED box with white text -- a different shape AND a different colour from the white revenue squares, so a cost cannot be read as revenue.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #68
    for (const hex of STATIC_BOARD_HEXES) {
      if (hex.type !== "Mountain" && hex.type !== "River") continue;
      // A CORRECTNESS fix: execute_lay_tile charges terrain ONCE, on first build. Keeping the badge after that renders what the LAST lay cost as though it were a live price.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #150
      /* Design note #723: ASKED OF THE LEDGER, NOT THE BOARD. This was the third copy of "charged once" in the
         codebase -- the projection had it, this had it, and the reducer that moves the money did not. The two
         predicates agree on every hex today, which is exactly why nobody noticed the third disagreed: the
         badge and the preview were consistent with each other and both wrong about the debit. All three now
         ask `terrainFeeDue`. */
      if (terrainFeeDue(terrainFeesPaid, hex.q, hex.r, terrainBuildFeeAt) <= 0) continue;
      const terrainType = hex.type;
      // Design note #136 (F-2): the printed figure comes from the
      // coordinate-keyed mirror of `hexmap::terrain_build_fee`, so the label
      // on the board and the fee the contract charges are the same lookup.
      const terrainFee = terrainBuildFeeAt(hex.q, hex.r);
      const costLabel = String(terrainFee);
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // The SAME isComplexHex test the icon pass uses, so the two always agree on which hexes are complex.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #87
      const isComplexHex =
        archetypeForHex(mapGrid, hex.q, hex.r) !== "Plain" ||
        liveEdgesForHex(mapGrid, hex.q, hex.r).length > 0;
      // Slot-resolved rather than a fixed lower-third literal. A simple hex prefers the true bottom point -- byte-identical direction to the old fixed offset -- and a complex hex the SE edge. #87: ONE claim for the whole compound badge.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #70
      const blockedCostSlots = hexBlockedSlots(mapGrid, hex.q, hex.r);
      const deadCostSlots = slotsBlockedByEdges(deadEdgesAt(hex.q, hex.r), false);
      const costOverride = resolveSlotOverride(hex.q, hex.r, "terrain");
      const costSlotPreference = withSlotReserve(
        hex.q,
        hex.r,
        "terrain",
        isComplexHex ? COMPLEX_HEX_TERRAIN_SLOT_PREFERENCE : [10, 4, 3, 11, 9],
      );
      const costSlot = claimHexSlotPreferring(
        claimedHexSlots,
        hex.q,
        hex.r,
        costOverride,
        costSlotPreference,
        blockedCostSlots,
        deadCostSlots,
      );
      const costDirection = hexSlotDirection(costSlot);
      const point = {
        x: center.x + costDirection.x * hexSize * 0.58,
        y: center.y + costDirection.y * hexSize * 0.58,
      };
      // The compound badge sits at 0.65, matching REVENUE_BADGE_OFFSET exactly. Scoped to the compound badge only -- the plain cost box's anchor is untouched.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #122
      const COMPOUND_BADGE_OFFSET = 0.65;
      const compoundBadgePoint = {
        x: center.x + costDirection.x * hexSize * COMPOUND_BADGE_OFFSET,
        y: center.y + costDirection.y * hexSize * COMPOUND_BADGE_OFFSET,
      };
      withHexClip(ctx, center, hexSize, () => {
        if (isComplexHex) {
          // ONE compound [icon+cost] pill; the standalone icon pass already skipped this hex, so this is the only place its terrain icon renders.
          // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #87
          drawTerrainCompoundBadge(ctx, terrainType, costLabel, compoundBadgePoint, hexFlatWidth * 0.85);
          return;
        }
        // Font history: 10 -> 9 (#68) -> 8 (#92) -> 9 (#95, once the $ was dropped) -> 10 (#99).
        // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #99
        ctx.font = fitFontSize(ctx, costLabel, 10, hexFlatWidth * 0.85, 6, "bold");
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // Design note #68: white text on the new solid-red box, replacing
        // the old black-on-tier-color styling.
        ctx.fillStyle = "#FFFFFF";
        // Design note #91 REVERTED (design note #97): padding tried
        // tightened 2->1 on both axes, but per direct follow-up request
        // the box is reverted back to its original 2/2 padding.
        drawLabelWithBackground(ctx, costLabel, point, {
          paddingX: 2,
          paddingY: 2,
          // Design note #68: literal solid red, this file's own established
          // "crisp" red (`drawImpassableBorderEdge`'s `#E53E3E`, design note
          // #42) -- reused here rather than inventing a new red, so the
          // board's palette stays consistent.
          fillStyle: "#E53E3E",
          cornerRadiusPx: 2,
        });
      });
    }

    // A hex in HEX_START_VALUE_OVERRIDE uses its real sourced figure; an exact $0 SKIPS the badge entirely rather than printing "$0". terrainBaseValue is flat and terrain-only -- a hex's value never changes with the colour tier.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #35
    for (const landmark of LANDMARK_HEXES) {
      // Same yield as the track pass, one step on: once a tile is laid its own chain revenue is the figure that pays, not the hex's printed starting value.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #133
      if (hexHasLaidTile(mapGrid, landmark.q, landmark.r)) continue;
      const override = HEX_START_VALUE_OVERRIDE[landmark.label];
      if (override === 0) continue;
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      // The landmark's own printed edges, flattened -- exactly the data that lets New York's badge dodge its NE stub instead of sitting on it.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #39
      const landmarkEdges = (LANDMARK_TRACKS[landmark.name] ?? []).flatMap((segment) => segment.edges);
      // Design note #55: Strict Hex Boundary Clipping, extended to value
      // badges -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        drawValueBadge(
          ctx,
          center,
          landmark.q,
          landmark.r,
          "MajorCityHub",
          hexSize,
          override,
          landmarkEdges,
          claimedHexSlots,
        );
      });
    }
    for (const hex of STATIC_BOARD_HEXES) {
      const override = HEX_START_VALUE_OVERRIDE[hex.label];
      const grayTrack = GRAY_HEXES[hex.label];
      if (grayTrack && grayTrack.marker !== "none") {
        if (override !== 0) {
          const center = axialToPixel(hex.q, hex.r, hexSize);
          withHexClip(ctx, center, hexSize, () => {
            drawValueBadge(
              ctx,
              center,
              hex.q,
              hex.r,
              grayTrack.marker === "city" ? "MajorCityHub" : "SmallTown",
              hexSize,
              override,
              grayTrack.edges,
              claimedHexSlots,
            );
          });
        }
        continue;
      }
      if (YELLOW_OO_HEXES.has(hex.label)) {
        if (override !== 0) {
          const center = axialToPixel(hex.q, hex.r, hexSize);
          withHexClip(ctx, center, hexSize, () => {
            drawValueBadge(ctx, center, hex.q, hex.r, "MajorCityHub", hexSize, override, [], claimedHexSlots);
          });
        }
      }
      // REVERTED: only the three gray hexes with REAL printed track show a town badge. The seven blank town-designated hexes are placeholders, not scored destinations, until a tile is laid -- the backend already treats them that way, so this was a frontend-only display bug.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #35
      if (hex.cityDesignation && override !== 0) {
        const center = axialToPixel(hex.q, hex.r, hexSize);
        withHexClip(ctx, center, hexSize, () => {
          drawValueBadge(ctx, center, hex.q, hex.r, "MajorCityHub", hexSize, override, [], claimedHexSlots);
        });
      }
    }
    for (const tile of mapGrid.tiles) {
      const catalogEntry = TILE_CATALOG_BY_ID.get(tile.tile_id);
      if (!catalogEntry) continue;
      /* NewYorkHub/BostonHub were excluded because the landmark pass "always catches them first" -- true when written and false one note later, once #133 made that pass yield to a laid tile. The parameter is widened rather than the terrains mapped onto a lookalike.
         See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #288 */
      if (
        catalogEntry.terrain !== "SmallTown" &&
        catalogEntry.terrain !== "DoubleTown" &&
        catalogEntry.terrain !== "MajorCityHub" &&
        catalogEntry.terrain !== "DoubleCityHub" && // Tile Selection Catalog verification pass, tile 15
        catalogEntry.terrain !== "NewYorkHub" &&
        catalogEntry.terrain !== "BostonHub"
      ) {
        continue;
      }
      // No longer skipped for a landmark hex: the landmark badge pass yields once a tile is laid, so exactly one badge is drawn either way.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #133
      const center = axialToPixel(tile.q, tile.r, hexSize);
      // Local `const` so the allow-list narrowing above (`catalogEntry.terrain
      // !== ...`) survives being read inside the `withHexClip` closure below
      // -- TS does not carry property-access narrowing across a function
      // boundary, only a local variable's.
      const terrain = catalogEntry.terrain;
      // The laid tile's ACTUAL live edges at its current orientation -- the same rotateConnections pair drawTrackPath uses, so the badge dodges what is actually drawn.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #39
      const tileEdges = liveEdges(rotateConnections(catalogEntry.connections, tile.orientation));
      // THE revenue figure, off MapTileEntry.revenue -- the same call the contract prices a route through, so what is printed is what will actually be paid.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #132
      const chainRevenue = chainTileRevenue(tile);
      // `0` is a real chain answer -- plain connector track pays nothing --
      // and a `$0` badge is noise, so suppress it. `undefined` (a pre-G-11
      // contract) keeps the old terrain-bucket fallback by passing through.
      if (chainRevenue === 0) continue;
      withHexClip(ctx, center, hexSize, () => {
        drawValueBadge(ctx, center, tile.q, tile.r, terrain, hexSize, chainRevenue, tileEdges, claimedHexSlots);
      });
    }

    // B/NY/OO badges persist across EVERY tier, reversing #47's "before tiles are laid" gate. #47 is left in place as the record of the superseded decision.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #49
    for (const landmark of LANDMARK_HEXES) {
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      const archetype = archetypeForHex(mapGrid, landmark.q, landmark.r);
      // Badge TEXT is genuine per-hex data read the same structural way archetypeForHex classifies the hex -- not a separate name check.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #55
      const badgeText = archetype === "DoubleCity" ? "NY" : "B";
      withHexClip(ctx, center, hexSize, () => {
        drawRestrictionBadge(
          ctx,
          center,
          hexSize,
          badgeText,
          archetype,
          mapGrid,
          landmark.q,
          landmark.r,
          claimedHexSlots,
        );
      });
    }
    for (const hex of STATIC_BOARD_HEXES) {
      if (!YELLOW_OO_HEXES.has(hex.label)) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      withHexClip(ctx, center, hexSize, () => {
        drawRestrictionBadge(ctx, center, hexSize, "OO", "DoubleCity", mapGrid, hex.q, hex.r, claimedHexSlots);
      });
    }

    // Private company reservations, drawn above the cardboard and below the pieces. NOT clipped to the hex: it is a marker sitting ON the board, and a pill wide enough for "C&SL" would be sliced at smaller zooms. forEach, not for...of -- ES5 target without downlevelIteration.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #318
    reservations.forEach((reservation) => {
      const center = axialToPixel(reservation.q, reservation.r, hexSize);
      drawReservationBadge(ctx, center, hexSize, reservation.initials, reservation.slot);
    });

    // Four fixed board crossings track may never be built over, drawn after every tile pass so the bar is never hidden, but before the preview ghost.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #38
    for (const border of IMPASSABLE_BORDER_EDGES) {
      const center = axialToPixel(border.q, border.r, hexSize);
      drawImpassableBorderEdge(ctx, center, hexSize, border.edge);
    }


    /* The token pass moved AFTER the veil: a reservation badge is already at 0.45 alpha, and under the deep focus veil the product of the two is effectively nothing. A veil is a badge over the whole hex.
       See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #588 */

    /* The veil was deleted here on two objections; only one survived -- it dimmed the board for EVERYONE. The remedy was a CONDITION, not a deletion. The click gate was never the veil's job.
       See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #367 */
    if (layFocus) {
      for (const hex of STATIC_BOARD_HEXES) {
        const key = `${hex.q},${hex.r}`;
        const center = axialToPixel(hex.q, hex.r, hexSize);

        /* Two veils, one pass: a ring open means every other hex goes to the deep alpha, legal or not; no ring means the ordinary survey veil.
           See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #472 */
        const focused = layFocus.soleFocusKey !== undefined;
        const veiled = focused
          ? key !== layFocus.soleFocusKey
          : layFocus.dim && !layFocus.visible.has(key);
        if (veiled) {
          ctx.save();
          ctx.globalAlpha = focused ? LAY_TRACK_FOCUS_DIM_ALPHA : LAY_TRACK_DIM_ALPHA;
          ctx.fillStyle = LAY_TRACK_DIM_INK;
          drawHexPath(ctx, center, hexSize);
          ctx.fill();
          ctx.restore();
          /* NOT continue. The old early-exit meant a hex could be dimmed OR glowed, never both -- the two never actually collided, but the structure said they might.
             See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #367 */
        }

        /* An OUTER glow needs the inside masked: shadowBlur blooms symmetrically, so half of every "glow" was painted inside the hex, which is what turns a glow into a solid tint. #463: node rings while a placement is armed, on the SAME geometry a click resolves against. #585: home slots only.
           See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #252 */
        if (
          cursorMode === "token" &&
          layFocus.homeSlotGlow === true &&
          layFocus.soleFocusKey === undefined &&
          layFocus.highlighted.has(key)
        ) {
          const glow = layFocus.glowColor ?? LAY_TRACK_HIGHLIGHT_INK;
          // 0..1..0 over the cycle, so the ring breathes rather than
          // stepping. `pulsePhase` is a plain 0..1 ramp from the loop.
          const swell = Math.sin(pulsePhase * Math.PI * 2) * 0.5 + 0.5;
          /* The ring's radius comes from the TOKEN that will land there, not from hexSize -- on a laid multi-city tile the same ring drew a halo at twice the radius of the thing it was pointing at.
             See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #515 */
          const laidHere = mapGrid.tiles.find((tile) => tile.q === hex.q && tile.r === hex.r);
          /* Design note #699: through the same resolver the token itself uses, so the ring cannot frame a
             circle of one size around a token of another. The `?? hexSize * 0.22` tail is gone with it --
             that literal WAS the mismatched fallback. */
          const slotRadius =
            stationMarkerRadius(hex.q, hex.r, hexSize, laidHere) ?? hexSize * STATION_RADIUS_RATIO;
          // A thin band just outside the token: enough to read as a frame,
          // not enough to read as an orbit.
          const ringRadius = slotRadius * (1.28 + swell * 0.14);
          /* Design note #584: the slot the reservation marker is already
             drawn in -- so the ring and the badge cannot point at different
             circles on a two-station hex like New York.
             Design note #742: EXCEPT WHERE THE PRESIDENT STILL CHOOSES. On an OO hex the badge is anchored to
             no circle at all, by #43's deliberate design, so asking which circle it sits nearest answers a
             question it was placed to avoid -- and rings one slot as though the other were unavailable.
             Reported of ERIE's E11 after a brown upgrade. Both slots are lit there; everywhere else #584's
             pairing stands untouched. */
          /* Design note #858: ONE FUNCTION, and the click handler below calls it too -- so the circle that
             lights and the circle that may be clicked cannot diverge. It was two inline lines here and
             nothing at all there, which is the bug. */
          const slotNodes = cityNodePoints(mapGrid, hex.q, hex.r, hexSize);
          const homeSlot = homeSlotIndex(
            STATIC_BOARD_HEXES.find((entry) => entry.q === hex.q && entry.r === hex.r)?.label,
            slotNodes,
            stationMarkerPoint(hex.q, hex.r, hexSize, laidHere),
          );
          const litNodes = homeSlot === null ? slotNodes : [slotNodes[homeSlot]];
          for (const node of litNodes) {
            if (!node) continue;
            ctx.save();
            ctx.globalAlpha = 0.45 + swell * 0.5;
            ctx.strokeStyle = glow;
            ctx.shadowColor = glow;
            ctx.shadowBlur = slotRadius * (0.35 + swell * 0.35);
            ctx.lineWidth = Math.max(1.5, slotRadius * 0.22);
            ctx.beginPath();
            ctx.arc(node.x, node.y, ringRadius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
        }

        /* Design note #472: likewise the hex glow. Under a focus veil only
           the open hex keeps it -- it is the one thing the player is
           looking at, and the others have been pushed back deliberately. */
        /* Design note #727: a private power's hex glows whether or not it is in the reach set -- being outside
           it is the point. So this arm is `||`, not a branch inside the reach test. */
        const poweredHere = layFocus.powerHexes?.has(key) === true;
        if (
          (layFocus.highlighted.has(key) || poweredHere) &&
          (layFocus.soleFocusKey === undefined || key === layFocus.soleFocusKey)
        ) {
          const glow = layFocus.glowColor ?? LAY_TRACK_HIGHLIGHT_INK;
          ctx.save();

          ctx.beginPath();
          ctx.rect(center.x - hexSize * 4, center.y - hexSize * 4, hexSize * 8, hexSize * 8);
          drawHexPath(ctx, center, hexSize);
          ctx.clip("evenodd");

          /* Design note #727: the full hue circle around the perimeter, from the auction's own stop list.
             A LINEAR GRADIENT ACROSS THE HEX rather than a conic one: the stroke is a closed path, so a
             left-to-right ramp reads as a band of colour on every edge, and `createConicGradient` is not
             available in every browser this ships to. The shadow cannot take a gradient at all -- canvas
             `shadowColor` is a single colour -- so the halo behind it uses the middle stop, which keeps the
             bloom neutral while the ring carries the identity. */
          if (poweredHere) {
            const ramp = ctx.createLinearGradient(
              center.x - hexSize,
              center.y - hexSize,
              center.x + hexSize,
              center.y + hexSize,
            );
            PRIVATE_POWER_GLOW_STOPS.forEach((stop, index) => {
              ramp.addColorStop(index / (PRIVATE_POWER_GLOW_STOPS.length - 1), stop);
            });
            ctx.strokeStyle = ramp;
            ctx.shadowColor = PRIVATE_POWER_GLOW_STOPS[4];
            // Thicker than the reach glow: this one is rarer and says more.
            ctx.lineWidth = Math.max(1.5, hexSize * 0.035);
          } else {
            ctx.strokeStyle = glow;
            ctx.shadowColor = glow;
            ctx.lineWidth = Math.max(1, hexSize * 0.02);
          }
          // Three passes rather than one wide blur: each adds a further
          // falloff step, so the halo fades gradually instead of ending at
          // the visible edge a single shadow leaves.
          for (const blur of [hexSize * 0.5, hexSize * 0.28, hexSize * 0.12]) {
            ctx.shadowBlur = Math.max(4, blur);
            drawHexPath(ctx, center, hexSize);
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }

    /* Design note #222/#588: tokens go on last -- above every badge, every
       nameplate AND the focus veil. */
    /* ==================================================================
        DESIGN NOTE 822: #222 SAID TOKENS ARE DRAWN LAST, AND THE PREVIEW WAS DRAWN AFTER THEM
       ==================================================================
    
       REPORTED: "the tileselector radial menu renders the stations, but when players click the tile to
       preview it on the hex, no station marker appears. It's only after they confirm placement that the
       station marker appears."
    
       THE PREVIEW IS OPAQUE ON PURPOSE (#167: "at 0.65 the board bled through and a yellow tile over a
       green hex became a muddy third colour") and it was painted AFTER `drawStationTokenPass`, so it
       covered every token on its hex. #222's rule is right there above that pass -- "tokens are drawn
       LAST, not merely late ... a token says whose network this is, and a route's legality turns on it" --
       and this one block was the exception nobody had noticed.
    
       SO THE PREVIEW MOVES UP RATHER THAN THE TOKENS MOVING DOWN, which keeps #222 as written and makes
       the ghost tile obey the same ordering as a real one. The pass then draws the carried tokens ON the
       preview, at the previewed tile's own city geometry -- see the tile lookup in that pass.
    
       REPORTED FOR ERIE FIRST and correctly suspected to be general: "I suspect it may be worth checking
       whether all the double city tiles (OO and NY) continue previewing preexisting stations." It is every
       tile on every hex -- ERIE's home is simply where a two-city upgrade makes the omission unmissable. */
    // The preview is FULLY OPAQUE. Transparency was costing the one thing it exists for: at 0.65 the board bled through and a yellow tile over a green hex became a muddy third colour. The dashed outline stays -- the cheap half of the old signal.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #167
    if (previewTile) {
      const previewCatalogEntry = TILE_CATALOG_BY_ID.get(previewTile.tileId);
      const previewCenter = axialToPixel(previewTile.q, previewTile.r, hexSize);
      ctx.save();
      drawHexPath(ctx, previewCenter, hexSize);
      ctx.fillStyle = previewCatalogEntry ? ERA_TILE_FILL[previewCatalogEntry.color] : "#dddddd";
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = previewCatalogEntry
        ? COLOR_TIER_STROKE[previewCatalogEntry.color]
        : "#c0392b";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.setLineDash([]);
      if (previewCatalogEntry) {
        // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
        withHexClip(ctx, previewCenter, hexSize, () => {
          // previewTile is a tile being CONSIDERED, so no MapTileEntry describes it; the catalog mirror is why it must carry paths. #486: showRevenue stays true -- the ghost is not on the board, so nothing else can show its value.
          // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #119
          drawTrackPath(
            ctx,
            previewCenter,
            hexSize,
            previewCatalogEntry,
            previewTile.orientation,
            true,
            undefined,
            false,
          );
        });
      }
      ctx.restore();
    }

    drawStationTokenPass();


    // ---- Off-board hover tooltip (design note #15/item 4), drawn LAST so
    // it's always on top of everything else, including the ghost preview
    // tile above.
    if (hoveredOffboardHex) {
      const hex = STATIC_BOARD_HEXES.find(
        (h) => h.q === hoveredOffboardHex.q && h.r === hoveredOffboardHex.r,
      );
      const offboardName = hex ? OFFBOARD_LABELS[hex.label] : undefined;
      const tiers = offboardName ? OFFBOARD_REVENUE[offboardName] : undefined;
      if (hex && offboardName && tiers) {
        const center = axialToPixel(hex.q, hex.r, hexSize);
        // Point the card back toward the board's interior rather than always up-right, so zones near the top/right edge get room instead of clipping.
        // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #15
        const boardCenterX = (boardContentBounds.minX + boardContentBounds.maxX) / 2;
        const boardCenterY = (boardContentBounds.minY + boardContentBounds.maxY) / 2;
        const preferLeft = center.x > boardCenterX;
        const preferBelow = center.y < boardCenterY;
        drawOffboardTooltip(
          ctx,
          center,
          hexSize,
          offboardName,
          tiers,
          currentEra,
          preferLeft,
          preferBelow,
        );
      }
    }

    // ---- Board margin labels (row letters / column numbers), drawn LAST
    // in this world-space pass -- see design note #25. Native canvas text,
    // inside the same `ctx.translate`/`ctx.scale` transform as everything
    // else above, so it automatically pans/zooms/aligns with the board.
    drawBoardMarginLabels(ctx, hexSize);

    ctx.restore();
  }, [
    /* Design note #723: the cost badges are part of the picture too, so paying a hex's fee has to repaint.
       Omitted, the red $80 would sit on New York until some unrelated change happened to redraw the board --
       advertising a price that has already been settled, which is the exact failure #150 removed the badge
       after a build to prevent. */
    terrainFeesPaid,
    // Design note #223: the veil is part of the picture, so a change to the
    // reachable set has to repaint. Omitted, the board would keep the
    // dimming from whichever corporation was acting when it was last drawn.
    layFocus,
    // mapGrid, not mapGrid.tiles -- the body reads the whole object. Invisible today because App.tsx supplies a frozen mock; the hazard becomes real exactly when this is wired to the live poll. Callers must pass a STABLE reference.
    // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #138
    mapGrid,
    hexSize,
    width,
    height,
    view,
    previewTile,
    currentEra,
    hoveredOffboardHex,
    hoveredHexCoord,
    boardContentBounds,
    publicCompanies,
    // Design note #318: a private closing must repaint the board -- the
    // badge's whole job is to disappear when the reservation lifts.
    reservations,
    // Design note #137: a new route trace must repaint the canvas. Omitting
    // this from the dep list is the classic failure here -- the prop updates,
    // React re-renders, and the memoised draw callback never re-runs, so the
    // overlay silently never appears.
    routeOverlays,
    // Design note #373: a change of cursor repaints, or the emphasis would
    // only appear on the next unrelated redraw.
    highlightedTrainIndex,
    showCityNames,
    // Design note #463: the pulse advances, so the board repaints with it.
    // Only ever changes while a placement is armed.
    pulsePhase,
    cursorMode,
  ]);

  /** Coalesces pan/zoom-driven redraws to at most one per animation
   *  frame -- see design note #4. */
  const scheduleDraw = useCallback(() => {
    if (rafHandleRef.current !== null) return;
    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = null;
      draw();
    });
  }, [draw]);

  // Prop-driven redraw (new map data, resize, or hex size change).
  useEffect(() => {
    draw();
  }, [draw]);

  // Cancel any in-flight coalesced redraw on unmount.
  useEffect(() => {
    return () => {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
      }
    };
  }, []);

  // Re-runs on every fitView change rather than once. The one-shot version fired on the first render after each remount, capturing a fitView from the DEFAULT_WIDTH fallback before the ResizeObserver reported -- and never ran again.
  // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #13
  useEffect(() => {
    if (detailedView) return;
    setView(fitView);
  }, [fitView, detailedView]);

  /* Design note #866: the board answers the host's standing question about one hex's free-station slot.
     KEYED ON `view` AS WELL AS THE REQUEST, so a pan or a zoom re-reports and the confirmation ring follows
     the token it belongs to. The alternative -- resolving once and remembering -- is how a ring ends up
     floating over empty board after a drag.
     `mapGrid` IS IN THE LIST because the slot depends on what is laid and on who is already tokened there;
     `publicCompanies` for the same reason, via `nextCitySlotPoint`'s occupancy walk. */
  useEffect(() => {
    if (!autoStageStation || !onAutoStageStation) return;
    const { q, r } = autoStageStation;
    const { nodeX, nodeY } = stationSlotAnchor({
      mapGrid,
      publicCompanies,
      q,
      r,
      cityIndex: soleCityIndex(mapGrid, q, r, hexSize),
      hexSize,
      zoom: view.zoom,
      panX: view.panX,
      panY: view.panY,
    });
    onAutoStageStation({
      q,
      r,
      hexLabel: describeHex(q, r),
      boardLabel: boardHexLabel(q, r),
      cityIndex: soleCityIndex(mapGrid, q, r, hexSize),
      nodeX,
      nodeY,
    });
  }, [autoStageStation, onAutoStageStation, mapGrid, publicCompanies, hexSize, view]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      // Always tracked, even at the locked baseline: dragStateRef doubles as the click-vs-drag check the interceptor relies on.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #13
      dragStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originPanX: view.panX,
        originPanY: view.panY,
      };
      /* Design note #773: capture only where the drag is live. Following a pointer outside the element is
         what capture is FOR, and at the baseline there is no pan to follow -- an unnecessary capture on a
         touch pointer is one more thing standing between a swipe and the browser's scroller. */
      if (detailedView) {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* A pointer that ended between the event and this line. Nothing to capture and nothing to do:
             the drag state above is still correct, and pointercancel will clear it. */
        }
      }
    },
    [view.panX, view.panY, detailedView],
  );

  /** The browser took the gesture over -- a swipe that became a page scroll, or a palm. Not a click and not
   *  the end of a pan: the drag state has to go, and it must not run the selection path.
   *  Design note #773: A REF WITH NO RESET IS THE SHAPE OF THIS SESSION'S LAST THREE BUGS. Handing scroll
   *  back to the browser means `pointerup` stops being guaranteed -- a cancelled pointer fires this instead,
   *  and without it `dragStateRef` would keep a dead press's origin until the next `pointerdown`
   *  overwrote it. */
  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      dragStateRef.current = null;
      releaseCapture(event);
      cancelTooltipTimer();
      setHoveredCoordLabel((prev) => (prev === null ? prev : null));
      setHoveredOffboardHex((prev) => (prev === null ? prev : null));
    },
    [cancelTooltipTimer],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      // Off-board hover runs on EVERY move, independent of drag state, reusing the same transform-undo math the click interceptor uses.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #15
      const rect = event.currentTarget.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      const contentX = (cssX - view.panX) / view.zoom;
      const contentY = (cssY - view.panY) / view.zoom;
      const { q: hoverQ, r: hoverR } = pixelToAxial(contentX, contentY, hexSize);
      const hoveredBoardHex = STATIC_BOARD_HEXES.find((h) => h.q === hoverQ && h.r === hoverR);
      const isOffboardHover = !!(hoveredBoardHex && OFFBOARD_LABELS[hoveredBoardHex.label]);

      // Item 7 ("Muted Base Text with Hover Glow") -- tracked unconditionally,
      // unlike `hoveredOffboardHex` just below, since every labeled hex type
      // (landmark, gray/OO, plain) needs to know when it's the one under the
      // pointer, not just off-board zones.
      setHoveredHexCoord((prev) => {
        if (prev && prev.q === hoverQ && prev.r === hoverR) return prev;
        return { q: hoverQ, r: hoverR };
      });

      /* THE LINE, NOT THE HEX. Two trains sharing a hex now resolve to whichever line is under the cursor. No hex fallback when the paths exist -- the whole point is that the hex is no longer the unit.
         See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #380 */
      if (onHighlightRoute) {
        const hit = routeHitRef.current;
        const ctx2d = event.currentTarget.getContext("2d");

        if (hit && hit.paths.size > 0 && ctx2d) {
          onHighlightRoute(
            hitTestRoutes(ctx2d, hit, cssX, cssY, view, window.devicePixelRatio || 1),
          );
        } else {
          /* Design note #374's test, kept for the no-`DOMMatrix` case only.
             A hex on two routes still resolves to nothing there, because
             without the geometry there is nothing better to say. */
          const carrying = routeOverlays.filter(
            (overlay) =>
              overlay.trainIndex !== undefined &&
              overlay.hexes.some(([q, r]) => q === hoverQ && r === hoverR),
          );
          onHighlightRoute(
            carrying.length === 1 ? (carrying[0].trainIndex as number) : null,
          );
        }
      }

      setHoveredOffboardHex((prev) => {
        if (isOffboardHover) {
          if (prev && prev.q === hoverQ && prev.r === hoverR) return prev;
          return { q: hoverQ, r: hoverR };
        }
        return prev === null ? prev : null;
      });

      // describeHexWithValue builds on describeHex so naming matches the one existing convention. Shown only over a real hex; the charcoal workspace outside the board shows nothing.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #26
      const hoveredLandmark = LANDMARK_HEXES.find((l) => l.q === hoverQ && l.r === hoverR);
      // Design note #269: a picker is open on a hex -- it owns the anchor.
      if (suppressHoverTooltip) {
        cancelTooltipTimer();
        setHoveredCoordLabel((prev) => (prev === null ? prev : null));
      } else if (hoveredLandmark || hoveredBoardHex) {
        // Flip toward whichever side of the CANVAS still has room, not the browser window. #365: everything the panel needs is captured NOW -- reading the event later would be a use after React pooled it.
        // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #75
        const pending = {
          // Design note #366: the reservation note, appended while it stands.
          label: withReservationNote(
            describeHexWithValue(hoverQ, hoverR, mapGrid, currentEra, publicCompanies),
            reservations.get(`${hoverQ},${hoverR}`) ?? null,
          ),
          clientX: event.clientX,
          clientY: event.clientY,
          preferLeft: cssX > rect.width / 2,
          preferAbove: cssY > rect.height / 2,
        };
        cancelTooltipTimer();
        tooltipTimerRef.current = setTimeout(() => {
          tooltipTimerRef.current = null;
          setHoveredCoordLabel(pending);
        }, HEX_TOOLTIP_DELAY_MS);
      } else {
        cancelTooltipTimer();
        setHoveredCoordLabel((prev) => (prev === null ? prev : null));
      }

      const drag = dragStateRef.current;
      if (!drag) return;
      // Pan is only live in detailed view; movement is still tracked at baseline so the click-vs-drag check keeps working.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #13
      if (!detailedView) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      // Rigid boundary clamping on drag: stop the pan the instant it would pull the board's edge past the viewport, rather than letting the map drift into empty space.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #8
      setView((prev) => {
        const clamped = clampPanToBoard(
          drag.originPanX + dx,
          drag.originPanY + dy,
          prev.zoom,
          boardContentBounds,
          width,
          height,
        );
        return { ...prev, panX: clamped.panX, panY: clamped.panY };
      });
      scheduleDraw();
    },
    [
      detailedView,
      scheduleDraw,
      boardContentBounds,
      width,
      height,
      /* The WHOLE view, not its three fields. `hitTestRoutes` takes the
         object, so the three narrower entries no longer cover every read
         and the lint rule is right to say so (design note #381). */
      view,
      hexSize,
      // Design note #118: added so the tooltip's new real-ticker station
      // list doesn't close over a stale `publicCompanies` array from this
      // callback's first render -- station tokens are placed live during
      // play.
      publicCompanies,
      /* Design note #366: the tooltip appends the reservation note, so a
         stale map here would keep saying "Reserved by DH" after the D&H
         closed -- the same class of staleness the two entries below record,
         on a line that is a rule rather than a number. */
      reservations,
      // Design note #374: the hit test reads both.
      routeOverlays,
      onHighlightRoute,
      /* Design note #365: stable (a `useCallback` with no deps), listed
         because the delay timer is cleared through it and an omitted
         stable dep is still a dep. */
      cancelTooltipTimer,
      // mapGrid and currentEra were real staleness bugs, not lint noise: frozen at first render, every off-board hover would report Yellow-era revenue for the rest of the game.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #138
      mapGrid,
      currentEra,
      // Design note #269: same class of staleness as the three above, and
      // the one that would bite hardest -- frozen at `false`, the tooltip
      // would keep reappearing under an open picker on every mouse move,
      // which is the reported bug with an extra step.
      suppressHoverTooltip,
    ],
  );

  /** Pointer-up rather than a native click, so a genuine click is told from the tail of a pan drag using the SAME dragStateRef already tracked for panning.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #7 */
  /* ==================================================================
      DESIGN NOTE 873: A HEX CAN BE SELECTED WITHOUT BEING CLICKED
     ==================================================================

     ASKED: "When a player indicates that they want to use the CSL or DH Lay Track power, why don't we have
     the tileselector radial menu automatically pop up on the designated hex? Forcing them to click Yes on
     the modal, then click on the hex, feels like it has an unnecessary step."

     THE SAME OBSERVATION AS #866, ONE POWER OVER. That report was about the D&H's free station, where the
     click carried no information because F16 has one city. This one is subtler: the PICKER still has to
     open, because which tile to lay is a real choice. What carries no information is the gesture that opens
     it -- the veil has already reduced the board to one lit hex, so "click the hex" is a step whose only
     possible outcome is the one the player just asked for.

     SO THE POINTER-DEPENDENT PART STAYS IN THE HANDLER and everything after the coordinate moves here. The
     handler works out WHICH hex from a pointer; this works out what selecting a hex MEANS. Extracted rather
     than duplicated for #866's reason: two copies of the eligibility gates and the query lifecycle would be
     two chances to answer one question differently.
     `clientX`/`clientY` ARE PARAMETERS because App still positions the query's status toast from them
     (`hexClickQuery.clientX + 16`). The auto path passes the hex's own centre on screen, which is where a
     player is looking. */
  const selectHex = useCallback(
    (params: {
      q: number;
      r: number;
      clientX: number;
      clientY: number;
      /** The city a pointer landed in, or `null` where there was no pointer. */
      cityIndexAtPoint2: number | null;
    }) => {
      const { q, r, clientX, clientY, cityIndexAtPoint2 } = params;
      const hexLabel = describeHex(q, r);

      // Click-time log: the hex's coordinate and preprinted terrain are known synchronously.
      // The legal tile_ids cannot be logged here -- they do not exist until the query resolves.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #7
      // eslint-disable-next-line no-console
      console.log("[TileSelection] hex clicked", {
        hex_coordinate: { q, r, hex_label: hexLabel },
        preprinted: describeHexDesignationForLog(q, r),
      });

      // Gate 1 runs BEFORE onHexClick: "not a hex" is the absence of a target, not a tile-laying rule. pixelToAxial maps every canvas point to SOME coordinate, including the margins and the board's real interior gaps. #171: the centre is computed once so every report carries the same one.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #141
      const centre = axialToPixel(q, r, hexSize);
      const centroidX = centre.x * view.zoom + view.panX;
      const centroidY = centre.y * view.zoom + view.panY;
      /* The hex's ON-SCREEN radius: hexSize is the board's unit and says nothing about how big the hex looks, so a clearance computed from it is wrong by exactly the zoom factor.
         See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #506 */
      const hexRadiusPx = hexSize * view.zoom;

      const eligibility = evaluateHexForTileLaying(q, r, mapGrid);
      if (eligibility.reason === "not-a-hex") {
        // "not-a-hex" is a real reported status. Returning silently was right when only the picker listened; it stopped being right once a ring could already be OPEN and the obvious dismissal gesture produced no event.
        // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #172
        onHexClickQuery?.({
          status: "not-a-hex",
          q,
          r,
          hexLabel,
          clientX: clientX,
          clientY: clientY,
          centroidX,
          centroidY,
        hexRadiusPx,
        });
        return;
      }

      // The hex's own CENTRE, not the cursor: a ring built on clientX/Y opens wherever the pointer landed, so two clicks on one hex produced two different rings. #453: the city node, measured in content space.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #171
      // Design note #873: supplied by the caller. `null` is the honest answer for a selection with no
      // pointer behind it -- which is what this field's own doc says `null` means.
      const cityIndex = cityIndexAtPoint2 ?? null;

      /* The chosen slot's centre, through the same transform -- the SAME geometry the click resolved against and the pulse drew on, so the confirmation lands where the glow promised.
         See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #516 */
      const nodes = cityNodePoints(mapGrid, q, r, hexSize);
      /* ONE CITY IS NOT AN AMBIGUOUS CITY. The centroid fallback is right when the geometry cannot say, and wrong when there is exactly one node. THE ANCHOR ONLY -- cityIndex still travels as null, because it answers a different question that other board modes read.
         See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #557 */
      /* Design note #866: `soleNode` moved into `stationSlotAnchor` with the rest of the fallback chain.
         `nodes` stays because `homeSlotIndex` below still reads it. */
      /* Design note #698: THE SLOT, THEN THE CITY, THEN THE CENTROID.
         Reported: the Place Station preview sits "in the middle of the tile, though it moves to a correct
         position after placement". It never moved -- the preview anchored HERE, to a city, and the placed
         token docks into a SLOT (#134/#251). On a one-slot city those are the same point, which is why this
         held for so long; on a pill the city's anchor is the gap BETWEEN the two circles a token can occupy.
         `nextCitySlotPoint` answers the placement's question rather than the click's, so the ring opens on the
         circle the token then appears in. The two fallbacks below are unchanged and still needed: a preprinted
         OO hex has no artwork to dock into (#459), and a hex with no resolvable node has only its centroid. */
      /* Design note #866: THIS ARITHMETIC IS NOW SHARED, because a second caller needs it without a pointer.
         The chain and its order are unchanged -- slot, then city, then sole node, then centroid -- it simply
         lives in `stationSlotAnchor` so the auto-staged placement lands on the same pixel this click would
         have chosen, by construction rather than by two copies agreeing. `nodes` and `soleNode` above are
         still read by the reporting below, so they stay. */
      const { nodeX, nodeY } = stationSlotAnchor({
        mapGrid,
        publicCompanies,
        q,
        r,
        cityIndex,
        hexSize,
        zoom: view.zoom,
        panX: view.panX,
        panY: view.panY,
      });

      onHexClick?.({
        q,
        r,
        hexLabel,
        // Design note #242: the identifier, alongside the display name.
        boardLabel: boardHexLabel(q, r),
        cityIndex,
        /* Design note #858: which city a HOME station is locked to here, or `null` where the president may
           choose. The same function the ring calls, so the circle that lights and the circle a placement will
           accept are one answer. The shell compares this against `cityIndex`; the board does not decide what
           to do about a mismatch, because it does not know which errand is armed. */
        homeCityIndex: homeSlotIndex(
          boardHexLabel(q, r) ?? undefined,
          nodes,
          stationMarkerPoint(q, r, hexSize, mapGrid.tiles.find((t) => t.q === q && t.r === r)),
        ),
        clientX: clientX,
        clientY: clientY,
        centroidX,
        centroidY,
        nodeX,
        nodeY,
        /* hexRadiusPx is deliberately NOT reported here: none of onHexClick's consumers position a surface that has to clear the hex.
           See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #506 */
      });

      // The guard is SPLIT, because the props go missing for two unrelated reasons. #139: !contractAddress moved out -- it survived here only because the address was a truthy placeholder, so offline mode was load-bearing on a fake constant.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #120
      if (gameId === undefined || protocolId === undefined) {
        return;
      }

      /* LOOKING IS NEVER GATED. Opening a picker is not a click that needs refusing -- it shows candidates and commits nothing. Execution is untouched: canLayTileNow gates the confirm button, with the reason ON it.
         See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #469 */

      /* Gates 2 and 3 run AFTER onHexClick and after the route bail-out, both on purpose: off-board and gray hexes are legal things for a ROUTE to run through. Reported rather than dropped -- this codebase has shipped a silent hex click twice.
         See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #141 */
      if (!eligibility.eligible) {
        // eslint-disable-next-line no-console
        console.log("[TileSelection] hex blocked -- picker suppressed", {
          hex_coordinate: { q, r, hex_label: eligibility.hexLabel },
          reason: eligibility.reason,
        });
        // Supersede any in-flight query, so a response for a PREVIOUS hex
        // cannot land after this and re-open the picker the gate just
        // refused. Same guard the offline path uses below.
        clickQuerySeqRef.current += 1;
        onHexClickQuery?.({
          status: "blocked",
          q,
          r,
          hexLabel: eligibility.hexLabel,
          clientX: clientX,
          clientY: clientY,
          centroidX,
          centroidY,
        hexRadiusPx,
          // Non-null: `"not-a-hex"` already returned above, and it is the
          // only reason with no message.
          reason: eligibility.reason!,
          message: eligibility.message,
        });
        return;
      }

      // The offline path: no chain client means fall back to the local catalog mirror and report status "offline", which the UI must label and must not dispatch from.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #120
      if (!queryClient || !contractAddress) {
        const placements = localCatalogPlacements();
        // eslint-disable-next-line no-console
        console.log("[TileSelection] no chain client -- local catalog fallback", {
          hex_coordinate: { q, r, hex_label: hexLabel },
          eras: "all (browse via the picker's era tabs)",
          tile_count: new Set(placements.map((p) => p.tile_id)).size,
          contract_validated: false,
        });
        // Supersede any in-flight real query, so a response that arrives
        // after the client drops can't overwrite this offline state.
        clickQuerySeqRef.current += 1;
        onHexClickQuery?.({
          status: "offline",
          q,
          r,
          hexLabel,
          clientX: clientX,
          clientY: clientY,
          centroidX,
          centroidY,
        hexRadiusPx,
          placements,
        });
        return;
      }

      const seq = ++clickQuerySeqRef.current;
      onHexClickQuery?.({
        status: "loading",
        q,
        r,
        hexLabel,
        clientX: clientX,
        clientY: clientY,
          centroidX,
          centroidY,
        hexRadiusPx,
      });

      queryClient
        .queryContractSmart(contractAddress, {
          GetLegalTilePlacements: { game_id: gameId, protocol_id: protocolId, q, r },
        })
        .then((response) => {
          // Stale-response guard: a rapid earlier click's request can
          // resolve after a newer click's -- only the latest matters.
          if (clickQuerySeqRef.current !== seq) return;

          // The resolved legal (tile_id, orientation) pairings, logged the moment the query returns.
          // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #7
          // eslint-disable-next-line no-console
          console.log("[TileSelection] legal placements resolved", {
            hex_coordinate: { q, r, hex_label: hexLabel },
            allowed_placements: (response as LegalTilePlacementsResponse).placements,
          });

          onHexClickQuery?.({
            status: "success",
            q,
            r,
            hexLabel,
            clientX: clientX,
            clientY: clientY,
          centroidX,
          centroidY,
        hexRadiusPx,
            response: response as LegalTilePlacementsResponse,
          });
        })
        .catch((error: unknown) => {
          if (clickQuerySeqRef.current !== seq) return;
          const message = error instanceof Error ? error.message : String(error);
          onHexClickQuery?.({
            status: "error",
            q,
            r,
            hexLabel,
            clientX: clientX,
            clientY: clientY,
          centroidX,
          centroidY,
        hexRadiusPx,
            message,
          });
        });
    },
    [
      /* layFocus DROPPED: there is no gate any more, and the veil that still reads it lives in draw, which has its own dependency.
         See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #469 */
      view.panX,
      view.panY,
      view.zoom,
      hexSize,
      queryClient,
      contractAddress,
      gameId,
      protocolId,
      onHexClick,
      onHexClickQuery,
      // Gate 3 reads the laid tile out of mapGrid, so a stale closure would keep judging a hex by whatever was on it when the handler was built.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #141
      mapGrid,
      /* Design note #698: the preview anchor counts the tokens already in the city, so a handler built before
         the last placement would open the next ring on the slot that placement just took. */
      publicCompanies,
      // Design note #125 dropped `currentEra` from here: the offline
      // fallback no longer filters by era, so the handler has nothing
      // era-dependent left to close over. Era browsing is now a view control
      // inside `TileSelectionPopup` instead.
    ],
  );

  /* Design note #873: the one-shot. Keyed on the TOKEN rather than on the coordinate, so arming the same hex
     twice in a row still opens the picker -- a player who cancels the C&SL and then asks for it again is
     naming the same hex, and a coordinate-keyed effect would silently do nothing the second time.
     THE CANVAS RECT IS READ HERE because `selectHex` reports `clientX`/`clientY` to the shell, which
     positions the query's status toast from them. The hex's own centre on screen is where the player is
     already looking, and it is the same point a click on the middle of that hex would have produced. */
  const lastAutoSelectRef = useRef<number | null>(null);
  useEffect(() => {
    if (!autoSelectHex) {
      lastAutoSelectRef.current = null;
      return;
    }
    if (lastAutoSelectRef.current === autoSelectHex.token) return;
    lastAutoSelectRef.current = autoSelectHex.token;
    const { q, r } = autoSelectHex;
    const centre = axialToPixel(q, r, hexSize);
    const rect = canvasRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    selectHex({
      q,
      r,
      clientX: left + centre.x * view.zoom + view.panX,
      clientY: top + centre.y * view.zoom + view.panY,
      /* NO POINTER, NO CITY. A tile lay does not ask which city was hit, and `null` is what this field means
         when the geometry cannot say -- see `onHexClick`'s own note (#453). */
      cityIndexAtPoint2: null,
    });
  }, [autoSelectHex, selectHex, hexSize, view.zoom, view.panX, view.panY]);

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragStateRef.current;
      dragStateRef.current = null;
      releaseCapture(event);

      if (!drag) return;
      const movedX = event.clientX - drag.startX;
      const movedY = event.clientY - drag.startY;
      const movedDistance = Math.sqrt(movedX * movedX + movedY * movedY);
      /* A real pan drag almost always moves several pixels even when the user "meant" to click; a small dead
         zone tells the two apart without feeling laggy on a genuine click.
         Design note #773: THE ZONE DEPENDS ON THE POINTER. It was a flat 4px, which is a mouse's figure. A
         fingertip rolls further than that in the act of pressing, so on a tablet a genuine tap read as a
         drag and selected nothing. `isTapGesture` keeps 4px for a mouse and gives a finger 10. */
      if (!isTapGesture(event.pointerType, movedDistance)) return;

      const rect = event.currentTarget.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      // Undo `draw()`'s own `ctx.translate(view.panX, view.panY)` /
      // `ctx.scale(view.zoom, view.zoom)` to land back in the hex layer's
      // own untransformed coordinate space that `pixelToAxial` expects.
      const contentX = (cssX - view.panX) / view.zoom;
      const contentY = (cssY - view.panY) / view.zoom;
      const { q, r } = pixelToAxial(contentX, contentY, hexSize);
      const cityIndex = cityIndexAtPoint(mapGrid, q, r, contentX, contentY, hexSize);
      selectHex({ q, r, clientX: event.clientX, clientY: event.clientY, cityIndexAtPoint2: cityIndex });
    },
    [view.panX, view.panY, view.zoom, hexSize, selectHex, mapGrid],
  );


  /** Scroll-wheel zoom REMOVED entirely, not merely gated, so no dead path can be re-enabled. preventDefault stays -- scroll containment, not zoom.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #67 */
  const handleWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
  }, []);

  /** Zooms around the canvas's own centre, since a button has no cursor to anchor on. Flips detailedView on itself so the first press is not a no-op.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #17 */
  const handleZoomStep = useCallback(
    (factor: number) => {
      setDetailedView(true);
      setView((prev) => {
        const baseView = detailedView ? prev : fitView;
        // Design note #43: the floor is now `minZoom * MIN_ZOOM_MULTIPLIER`,
        // not `minZoom` itself, so "-" keeps working past Fit to Screen.
        const zoomFloor = Math.max(ABSOLUTE_MIN_ZOOM_FLOOR, minZoom * MIN_ZOOM_MULTIPLIER);
        const nextZoom = Math.min(
          minZoom * MAX_ZOOM_MULTIPLIER,
          Math.max(zoomFloor, baseView.zoom * factor),
        );
        // Keep the point currently at the canvas's own screen-space center
        // fixed in world space while zooming, so repeated +/- presses zoom
        // in/out around the middle of the view rather than drifting.
        const centerWorldX = (width / 2 - baseView.panX) / baseView.zoom;
        const centerWorldY = (height / 2 - baseView.panY) / baseView.zoom;
        const clamped = clampPanToBoard(
          width / 2 - centerWorldX * nextZoom,
          height / 2 - centerWorldY * nextZoom,
          nextZoom,
          boardContentBounds,
          width,
          height,
        );
        return { zoom: nextZoom, panX: clamped.panX, panY: clamped.panY };
      });
      scheduleDraw();
    },
    [detailedView, fitView, minZoom, boardContentBounds, width, height, scheduleDraw],
  );
  const handleZoomIn = useCallback(() => handleZoomStep(1.25), [handleZoomStep]);
  const handleZoomOut = useCallback(() => handleZoomStep(1 / 1.25), [handleZoomStep]);

  /** An idempotent, always-available snap back to exactly fitView, re-locking the camera.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #17 */
  const handleFitToScreen = useCallback(() => {
    setDetailedView(false);
    setView(fitView);
    scheduleDraw();
  }, [fitView, scheduleDraw]);

  /* ==================================================================
      DESIGN NOTE 888: THE FRAMING REQUEST, ANSWERED ONCE PER TOKEN
     ==================================================================
     THE ARITHMETIC IS NOT HERE. `frameHexes` is a pure module (#887's argument, applied on purpose this
     time): a camera pose is a calculation with an answer, and every way it can be wrong is a NUMBER -- an
     axis fitted on the wrong side, a clamp applied before the centring, a zoom that inverts on a set of one.
     Inside this component none of that could be asserted except by scanning for the presence of arithmetic.
     `handleFitToScreen` IS THE WAY BACK, unchanged and already on screen. That is what makes this an
     acceptable thing to do to a player's camera on a button press: the pose is reversible by a control they
     can see, which #818's rule about decisions-by-dismissal is the general case of.
     CLAMPED THE SAME WAY A DRAG IS. `clampPanToBoard` is what stops a frame near the board's edge leaving
     half the canvas empty; skipping it here would make the button the one camera move in this component that
     can leave the board off-centre against its own bounds. */
  const lastFrameTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!frameHexRequest) {
      lastFrameTokenRef.current = null;
      return;
    }
    if (lastFrameTokenRef.current === frameHexRequest.token) return;
    lastFrameTokenRef.current = frameHexRequest.token;
    const points = frameHexRequest.keys
      .map((key) => {
        const [q, r] = key.split(",").map(Number);
        return Number.isFinite(q) && Number.isFinite(r) ? axialToPixel(q, r, hexSize) : null;
      })
      .filter((point): point is { x: number; y: number } => point !== null);
    /* Design note #888: a hex-radius and a half of slack, so the outermost hex of the set is not flush
       against the canvas edge and its neighbours read as context rather than as a crop. */
    const framed = frameHexes(points, { width, height }, {
      padding: hexSize * 1.5,
      minZoom,
      maxZoom: minZoom * MAX_ZOOM_MULTIPLIER,
    });
    if (!framed) return;
    setDetailedView(true);
    const clamped = clampPanToBoard(
      framed.panX,
      framed.panY,
      framed.zoom,
      boardContentBounds,
      width,
      height,
    );
    setView({ zoom: framed.zoom, panX: clamped.panX, panY: clamped.panY });
    scheduleDraw();
  }, [frameHexRequest, hexSize, width, height, minZoom, boardContentBounds, scheduleDraw]);

  /* THE THIRD TOOLTIP -- the one armed but not yet fired. #269 handled "already showing" and "about to be set"; a click during #365's dwell fires the timer ON TOP of the open ring. It survived because both natural ways to test it pass.
     See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #505 */
  useEffect(() => {
    if (!suppressHoverTooltip) return;
    cancelTooltipTimer();
    setHoveredCoordLabel((prev) => (prev === null ? prev : null));
    setHoveredOffboardHex((prev) => (prev === null ? prev : null));
  }, [suppressHoverTooltip, cancelTooltipTimer]);

  /** Pointer left the canvas: clears the off-board hover, since handlePointerMove stops firing outside the element.
   *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #15 */
  const handlePointerLeave = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      setHoveredOffboardHex(null);
      setHoveredCoordLabel(null);
      cancelTooltipTimer();
      onHighlightRoute?.(null);
      setHoveredHexCoord(null);
      handlePointerUp(event);
    },
    // Design note #374: the leave handler clears the cursor too.
    [handlePointerUp, cancelTooltipTimer, onHighlightRoute],
  );

  /* The control cluster moved OUT of the canvas: absolutely positioned, it sat on the board's own coordinate labels -- the one part of the map that is pure reference text.
     See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #44 */
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: widthProp ?? "100%" }}>
    <div
      ref={containerRef}
      style={{
        position: "relative",
        // Design note #19: with no explicit `widthProp`, this wrapper
        // flex-fills its host pane's WIDTH (`ResizeObserver` above measures
        // the pixel width that resolves to); an explicit override keeps the
        // old fixed-pixel behavior.
        width: widthProp ?? "100%",
        // A computed pixel height, not "100%": a percentage only resolves against an ancestor's definite height, which no longer exists.
        // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #27
        height: `${height}px`,
      }}
      className={className}
    >
      {/* Design note #25: the map canvas is the direct, single child again. The DOM overlay/frame detour of
         #20/#23/#24 is gone -- the row/column margin labels are drawn NATIVELY on the canvas (see
         `drawBoardMarginLabels`), so no separate DOM element needs sizing against the canvas at all. */}
      <canvas
        ref={canvasRef}
        style={{
          width,
          height,
          /* Design note #773: the canvas claims the touch gesture only in the mode that uses one. At the
             locked baseline `handlePointerMove` returns without panning, so `none` there was a promise to
             the browser that the map had no intention of keeping -- and on an iPad the board is most of the
             screen, so there was nowhere left to swipe the page. `manipulation` keeps taps arriving. */
          touchAction: canvasTouchAction(detailedView),
          // The cursor is the PIECE: a composed PNG rather than the .webp direct, because cursor:url() has no error path and a broken herald would silently become a crosshair -- the feature would look unbuilt rather than broken. Hotspot 16 16, because a token is placed AT a point.
          // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #496
          cursor:
            cursorMode === "token"
              ? `url("${stationCursor}") 16 16, crosshair`
              : detailedView
                ? "grab"
                : "default",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        /* Design note #773: with `manipulation` at the baseline the browser may claim a swipe for a page
           scroll, and a claimed pointer fires this INSTEAD of `pointerup`. Without it the drag origin
           outlives the press that set it. */
        onPointerCancel={handlePointerCancel}
        onPointerLeave={handlePointerLeave}
        onWheel={handleWheel}
      />
      {/* Coordinate + value hover tooltip -- design note #21, enriched by #26/item 2 (drops the "Hovering: "
         prefix so the text matches the specified format literally). Plain `position: fixed` viewport coordinates
         rather than relative to this wrapper, so it tracks the raw cursor exactly.
         Design note #75: ADAPTIVE QUADRANT, mirroring `drawOffboardTooltip`. It always anchored down-right
         regardless of room, running off the panel for hexes near the right/bottom edge (Boston, Fall River).
         `preferLeft`/`preferAbove` flip which corner sits at the cursor, using `right`/`bottom` instead. */}
      {/* Design note #505: gated at the RENDER, not only at the three places that set it. "A picker owns this
         hex, so nothing else annotates it" is then true by construction -- a future fourth path cannot
         reintroduce the pop-over-the-ring bug, because there is nowhere left for it to appear. */}
      {hoveredCoordLabel && !suppressHoverTooltip && (
        <div
          style={{
            ...HOVER_TOOLTIP_STYLE,
            ...(hoveredCoordLabel.preferLeft
              ? { right: window.innerWidth - hoveredCoordLabel.clientX + 14 }
              : { left: hoveredCoordLabel.clientX + 14 }),
            ...(hoveredCoordLabel.preferAbove
              ? { bottom: window.innerHeight - hoveredCoordLabel.clientY + 14 }
              : { top: hoveredCoordLabel.clientY + 14 }),
          }}
        >
          {hoveredCoordLabel.label}
        </div>
      )}
    </div>

      {/* Design note #44: ONE control cluster, in normal flow BELOW the
          map -- it no longer overlays the coordinate labels it used to sit
          on top of. Consolidation from design note #42 is unchanged; only
          the placement moved. */}
      <div style={MAP_CONTROLS_PANEL_STYLE}>
        <button
          type="button"
          onClick={() => setShowCityNames((prev) => !prev)}
          style={CAMERA_CONTROL_BUTTON_STYLE}
          aria-label={showCityNames ? "Hide city names" : "Show city names"}
        >
          {showCityNames ? "Hide City Names" : "Show City Names"}
        </button>
        <button type="button" onClick={handleZoomOut} style={CAMERA_CONTROL_BUTTON_STYLE} aria-label="Zoom out">
          -
        </button>
        <button type="button" onClick={handleZoomIn} style={CAMERA_CONTROL_BUTTON_STYLE} aria-label="Zoom in">
          +
        </button>
        <button
          type="button"
          onClick={handleFitToScreen}
          style={CAMERA_CONTROL_BUTTON_STYLE}
          aria-label="Fit to screen"
        >
          Fit to Screen
        </button>
      </div>
    </div>
  );
}
// Every drawing function extracted to ./hexCanvasPrimitives (Phase 4). This file now holds only the React component.
// See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #55

/* ------------------------------------------------------------------ */
/* Tile preview thumbnail -- for TileSelectionPopup.tsx (design note #7) */
/* ------------------------------------------------------------------ */

export interface TilePreviewThumbnailProps {
  tileId: number;
  /** Legal orientation angle (0-5) to preview -- see design note #7's
   *  orientation-cycling limitation. Default 0 (the lowest legal
   *  orientation, which is also always what the contract itself will
   *  auto-pick for a given `tile_id`). */
  orientation?: number;
  /** Overall canvas size in CSS pixels (square). Default 96. */
  size?: number;
  /* hexSize is DERIVED from size so the two cannot disagree: a pointy-top hex is 2R tall, so a radius of 40 needs an 80px canvas -- five sixths of it fell outside a 38px bitmap and what survived was a rectangle.
     See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #368 */
  hexSize?: number;
  className?: string;
  /* SHOW THE PIECES. A caption asks the player to hold "city 2" in their head and check it against artwork they have not seen; the marker just shows them. Drawn from tileCityAnchors, the same function that places the real token.
     See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #488 */
  stationMarkers?: readonly StationPreviewMarker[];
}

/** cityIndex is the destination on the CANDIDATE tile; resolving it is tokenMigration's job, so the caption and the marker come from one computation.
 *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #488 */
export interface StationPreviewMarker {
  cityIndex: number;
  ticker: string;
  color: string;
}

/** An isolated single-tile canvas for the picker, reusing this file's own catalog and draw functions rather than a second mirror. The cursor disc uses the same vocabulary drawStationTokenMarker uses on the board.
 *  See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #183 */
const TICKER_LEGIBLE_RADIUS = 9;

const STATION_TOKEN_CURSOR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
      '<circle cx="16" cy="16" r="10" fill="#ffffff" stroke="#1a1a1a" stroke-width="3"/>' +
      '<circle cx="16" cy="16" r="3.5" fill="#1a1a1a"/>' +
      '<path d="M16 1 v5 M16 26 v5 M1 16 h5 M26 16 h5" stroke="#1a1a1a" stroke-width="2.5" stroke-linecap="round"/>' +
      "</svg>",
  );

/* The fallback is rendered FIRST -- a liveried disc with the ticker -- so the cursor is corporation-specific from the first frame and merely gets sharper, instead of flickering from generic to branded. 32px because browsers cap cursors.
   See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #496 */
const CURSOR_PX = 32;

function drawCursorDisc(
  ctx: CanvasRenderingContext2D,
  liveryColor: string,
  ticker: string,
  withText: boolean,
): void {
  const c = CURSOR_PX / 2;
  ctx.clearRect(0, 0, CURSOR_PX, CURSOR_PX);
  ctx.beginPath();
  ctx.arc(c, c, c - 3, 0, Math.PI * 2);
  ctx.fillStyle = liveryColor;
  ctx.fill();
  // A dark rim, the same charcoal `drawStationTokenMarker` uses, so the disc
  // reads as a piece against both the pale tile fills and the dark chrome.
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 2;
  ctx.stroke();
  if (!withText || !ticker) return;
  ctx.font = fitFontSize(ctx, ticker, 11, (c - 4) * 1.7, 7, "bold");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = bestContrastTextColor(liveryColor);
  ctx.fillText(ticker, c, c);
}

/** The station-placement cursor for one corporation: its herald on its own
 *  livery, as a PNG data URI. Falls back to the liveried ticker disc while
 *  the image loads and permanently if it fails -- design note #496. */
function useStationCursor(ticker: string | null, liveryColor: string | null): string {
  const [cursor, setCursor] = useState<string>(STATION_TOKEN_CURSOR);

  useEffect(() => {
    if (!ticker || !liveryColor) {
      setCursor(STATION_TOKEN_CURSOR);
      return undefined;
    }
    if (typeof document === "undefined") return undefined;

    const canvas = document.createElement("canvas");
    canvas.width = CURSOR_PX;
    canvas.height = CURSOR_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setCursor(STATION_TOKEN_CURSOR);
      return undefined;
    }

    // The fallback, painted immediately: correct, liveried, and already
    // better than the generic icon before any network work begins.
    drawCursorDisc(ctx, liveryColor, ticker, true);
    let live = true;
    try {
      setCursor(canvas.toDataURL("image/png"));
    } catch {
      /* `toDataURL` throws on a tainted canvas. Nothing here is
         cross-origin, but a thrown cursor should not take the board down --
         the generic icon is a complete answer. */
      setCursor(STATION_TOKEN_CURSOR);
      return undefined;
    }

    const image = new Image();
    image.onload = () => {
      if (!live) return;
      try {
        // Redraw the disc WITHOUT the ticker, then the herald over it: the
        // text was the stand-in for the artwork, not a label beside it.
        drawCursorDisc(ctx, liveryColor, ticker, false);
        const inset = 6;
        const box = CURSOR_PX - inset * 2;
        // Fitted to the shorter side so a wide herald is not squashed --
        // `CorporateLogo`'s design note #429 makes the same call for the
        // circular market tokens, and for the same reason: a distorted
        // herald reads as a rendering fault.
        const scale = Math.min(box / image.width, box / image.height);
        const w = image.width * scale;
        const h = image.height * scale;
        ctx.drawImage(image, (CURSOR_PX - w) / 2, (CURSOR_PX - h) / 2, w, h);
        setCursor(canvas.toDataURL("image/png"));
      } catch {
        /* Leave the ticker disc already set. */
      }
    };
    // No `onerror` handler is needed beyond ignoring it: the ticker disc is
    // already the current cursor, which is exactly the degradation
    // `CorporateLogo` performs for a missing herald.
    image.src = logoSrcFor(ticker);

    return () => {
      live = false;
    };
  }, [ticker, liveryColor]);

  return cursor;
}

export function TilePreviewThumbnail({
  tileId,
  orientation = 0,
  size = 96,
  // Design note #368: derived from `size`, never a bare constant.
  hexSize = (size - 2) / 2,
  className,
  stationMarkers,
}: TilePreviewThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const center = { x: size / 2, y: size / 2 };
    const catalogEntry = TILE_CATALOG_BY_ID.get(tileId);

    drawHexPath(ctx, center, hexSize);
    ctx.fillStyle = catalogEntry ? ERA_TILE_FILL[catalogEntry.color] : "#dddddd";
    ctx.fill();
    ctx.strokeStyle = catalogEntry ? COLOR_TIER_STROKE[catalogEntry.color] : "#9a9a9a";
    ctx.lineWidth = 2;
    ctx.stroke();

    if (catalogEntry) {
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
      withHexClip(ctx, center, hexSize, () => {
        // Mirror-only by construction: this renders an UN-LAID tile with no query row, which is why the mirror carries paths at all.
        // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #119
        drawTrackPath(ctx, center, hexSize, catalogEntry, orientation);
      });
    } else {
      // An unknown id matters more here than on the board: the carousel renders one per legal placement the contract returned, so it is still a clickable, submittable choice.
      // See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #118
      withHexClip(ctx, center, hexSize, () => {
        drawUnknownTilePlaceholder(ctx, center, hexSize, tileId);
      });
    }

    /* An out-of-range index draws NOTHING rather than falling back to node 0 -- a token silently shown on the wrong circle is worse than one not shown, since the point of this pass is to be believed.
       See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #488 */
    if (stationMarkers && stationMarkers.length > 0) {
      const anchors = tileCityAnchors(tileId, orientation, center, hexSize);
      // Docked radius, so the marker sits inside the city circle the artwork
      // actually drew rather than at the legacy preprinted size. Same helper,
      // and therefore the same number, the board docks against.
      // Design note #699: resolved per marker below, since two cities on one tile can want different radii.
      /* Design note #698: THE SLOT, NOT THE PILL'S MIDDLE. Reported alongside the board preview and it is the
         same fault: `tileCityAnchors` gives one point per CITY, and on a two-slot green city that point is
         between the circles rather than in one. #488's note says this draws "from tileCityAnchors, the same
         function that places the real token" -- which stopped being true at #134, when the board moved to
         `tileCitySlotPoints`. This is the thumbnail catching up.
         SLOTS ARE ASSIGNED BY ORDER WITHIN THE CITY, which is exactly what the draw pass does with its
         occupant bucket -- so two tokens migrating into one city preview side by side instead of stacking. */
      const slotCursor = new Map<number, number>();
      for (const marker of stationMarkers) {
        const used = slotCursor.get(marker.cityIndex) ?? 0;
        slotCursor.set(marker.cityIndex, used + 1);
        const slots = tileCitySlotPoints(tileId, marker.cityIndex, orientation, center, hexSize);
        // Clamped, then the city anchor, then nothing -- #251's ladder: a token that cannot find its slot is
        // better drawn on its city than not drawn, and a city that does not exist draws neither.
        const point =
          slots.length > 0
            ? slots[Math.min(used, slots.length - 1)]
            : anchors[marker.cityIndex];
        if (!point) continue;
        const dockRadius = tileCityTokenRadius(tileId, hexSize, marker.cityIndex);
        /* The ticker is gated on MEASURED size: below a threshold an acronym becomes a smudge, and a smudge reads as a rendering fault where a plain disc reads as a decision.
           See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #488 */
        const radius = dockRadius ?? hexSize * 0.22;
        const ticker = radius >= TICKER_LEGIBLE_RADIUS ? marker.ticker : "";
        drawStationTokenMarker(ctx, point, hexSize, ticker, marker.color, false, radius);
      }
    }

    ctx.restore();
  }, [tileId, orientation, size, hexSize, stationMarkers]);

  /* The ELEMENT is clipped to the hexagon too: a square element lets chrome behind it show through the corners and frames the tile as a card.
     See docs/ai_architecture/canvas_rendering.md - HexGridRenderer.tsx #368 */
  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, clipPath: HEX_CLIP_PATH }}
      className={className}
    />
  );
}

/** Design note #368: a pointy-top hexagon, in percentages so it scales with
 *  whatever box it is applied to. */
export const HEX_CLIP_PATH =
  "polygon(50% 0%, 93.3% 25%, 93.3% 75%, 50% 100%, 6.7% 75%, 6.7% 25%)";

export default HexGridRenderer;
