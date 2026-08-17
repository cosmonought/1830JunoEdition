// frontend/src/components/HexGridRenderer.tsx
//
// Milestone 3: the 2D Canvas Graphics Engine's hex-map layer.
//
// ===================================================================
//  THE DESIGN NOTES FOR THIS FILE LIVE IN
//      ./HexGridRenderer.design-notes.md
// ===================================================================
//
// That document holds the full numbered design-note history this header used
// to carry inline -- ~3,180 lines of it, 26% of this file, all of it sitting
// above the first `import`. Every `design note #N` reference in this file and
// elsewhere in the codebase resolves to an entry there, under its original
// number.
//
// Moved rather than deleted (monolith split, Phase 0): the notes are the
// record of WHY this renderer is shaped the way it is, and several of them
// document bugs that are easy to reintroduce. They are worth more in a file
// you can read as prose than as a wall a code reader has to scroll past.
//
// NEW DESIGN NOTES GO IN THAT FILE, not back here.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FONT_SIZE } from "../styles/typography";
import {
  tileCitySlotCounts,
  tileCitySlotPoints,
  tileCityTokenRadius,
} from "./TileGraphics";
// Monolith split, Phase 1. Imported under their own names because this file's
// own code refers to them unqualified throughout; the matching
// `export ... from` re-export further down keeps them on this module's public
// surface for `App.tsx` / `TileSelectionPopup.tsx`. A re-export creates no
// local binding, so the two statements do not collide.
//
// MUST live here, at the top, not beside that re-export: ESLint's
// `import/first` requires every `import` to precede all other statements, and
// this file's first statement is ~3,300 lines below its own header comment,
// which makes "next to the thing it relates to" and "at the top" look like
// the same place when they are not.
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
  chainTileRevenue,
  stationTickerColor,
  stationTickerLabel,
  tokenCityIndex,
  STATION_HOME_HEXES,
  type HexClickQueryState,
  type LegalTilePlacementsResponse,
  type MapGridResponse,
  type QueryCapableClient,
  type StationTokenCompany,
} from "./hexContractTypes";
import { reservationsByHex } from "../utils/privateReservations";
import type { PrivateCompanyState } from "../utils/gameState";
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
  stationMarkerPoint,
  withHexClip,
  type RouteOverlay,
} from "./hexCanvasPrimitives";

/* ------------------------------------------------------------------ */
/* Contract data mirrors -- see design note #2                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Contract mirrors -- EXTRACTED (monolith split, Phase 3a)             */
/* ------------------------------------------------------------------ */
//
// `MapTileEntry`, `MapGridResponse`, `QueryCapableClient`,
// `StationTokenCompany`, `LegalTilePlacement(sResponse)`,
// `HexClickQueryState` and their helpers now live in `./hexContractTypes`.
// Extracted ahead of the geometry (Phase 3) because the slot engine takes
// these types and would otherwise have imported back into this file.
//
// Re-exported below: `App.tsx` and `TileSelectionPopup.tsx` import several of
// these from THIS module, so the re-export keeps every existing import path
// working and makes the move verifiable as a pure relocation.
export type {
  HexClickQueryState,
  LegalTilePlacement,
  LegalTilePlacementsResponse,
  MapGridResponse,
  QueryCapableClient,
  StationTokenCompany,
} from "./hexContractTypes";
export type { RouteOverlay } from "./hexCanvasPrimitives";

/** `DoubleTown` (item 1/2, structural calibration pass): a single hex
 *  printing TWO independent town stops -- Akron & Canton (G7), Reading &
 *  Allentown (G17), New Haven & Hartford (F20) on the real board. Mirrors
 *  `state::TerrainType::DoubleTown` in the Rust backend exactly.
 *
 *  `DoubleCityHub` (Tile Selection Catalog verification pass): the same
 *  "two stops, one hex" pattern as `DoubleTown`, but for the four
 *  preprinted OO double-city hexes (`YELLOW_OO_HEXES`) instead of an
 *  ordinary town. Mirrors `state::TerrainType::DoubleCityHub` exactly --
 *  see `hexmap.rs` module doc comment #18 for the full backend enforcement
 *  this terrain now drives (an OO hex can only ever be upgraded with this
 *  terrain's tile, never plain `MajorCityHub`). */
/* ------------------------------------------------------------------ */
/* Tile catalog -- EXTRACTED (monolith split, Phase 1)                  */
/* ------------------------------------------------------------------ */
//
// `TerrainType`, `TileColorTier`, `TileCatalogEntry`, the 46-entry
// `TILE_CATALOG` mirror of `hexmap::TILE_CATALOG`, `TILE_CATALOG_BY_ID` and
// both dev-only drift tripwires now live in `./hexTileCatalog`.
//
// Re-exported here rather than merely imported, because these are part of
// this component's PUBLIC surface -- `App.tsx` and `TileSelectionPopup.tsx`
// both import `TerrainType`/`TileCatalogEntry` from this module today. A
// re-export keeps every existing import path working, so the extraction is
// invisible to consumers and can be verified as a pure move: no call site
// changed, and `tsc` proves the graph still resolves.
//
// The matching `import` of the same names is at the TOP of this file, not
// here -- `import/first`. Only these `export ... from` statements may sit in
// the module body.
export type { TerrainType, TileColorTier, TileCatalogEntry } from "./hexTileCatalog";
export { TILE_CATALOG_SIZE, TILE_CATALOG_BY_ID } from "./hexTileCatalog";

/* ------------------------------------------------------------------ */
/* Board data -- EXTRACTED (monolith split, Phase 2)                    */
/* ------------------------------------------------------------------ */
//
// Every static table describing the 1830 board -- hexes, landmarks, gray
// hexes, off-board terminals, palettes, terrain fees -- now lives in
// `./hexBoardData`, along with the pure lookups over them. The `import` is at
// the TOP of this file, not here: `import/first` requires every import to
// precede all other statements.


/* ------------------------------------------------------------------ */
/* Hex geometry + slot engine -- EXTRACTED (monolith split, Phase 3)    */
/* ------------------------------------------------------------------ */
//
// The axial coordinate system, board topology, the archetype classifier, the
// 13-slot perimeter placement engine and the hex naming/valuation lookups all
// live in `./hexGeometry` now. The `import` is at the top of this file, with
// the others -- `import/first`.

// `RouteOverlay` moved to `./hexCanvasPrimitives` alongside its only consumer,
// `drawRouteOverlays`. Re-exported below so `App.tsx`'s import path is unchanged.

export interface HexGridRendererProps {
  /** `QueryMsg::GetMapGrid`'s response, verbatim. */
  mapGrid: MapGridResponse;
  /** Pixel radius (center to corner) of one hex. Default 42. */
  hexSize?: number;
  /** Explicit pixel size override. Omit both (the default, and the expected
   *  usage per design note #19/Request F item 3, refined by design note
   *  #27/item 1) to let this component measure its own wrapping `<div>`'s
   *  available WIDTH via `ResizeObserver` and flex-fill that; `height` in
   *  that case is no longer independently measured -- it's DERIVED from the
   *  real board's own aspect ratio at that width, so the canvas always
   *  renders at its true full proportional size instead of being cropped to
   *  fit a bounded ancestor pane. Provide both explicitly to keep the old
   *  fixed-pixel, independently-set-dimensions behavior. */
  width?: number;
  height?: number;
  className?: string;
  /** Enables the click interceptor (design note #7): when all four of
   *  `queryClient`/`contractAddress`/`gameId`/`protocolId` are provided, a
   *  genuine click on a hex (as opposed to a pan drag -- see
   *  `handlePointerUp`) converts the pixel to `(q, r)` and fires
   *  `GetLegalTilePlacements` against `queryClient`. Omit any of them to
   *  keep this component's original pan/zoom-only, query-free behavior. */
  queryClient?: QueryCapableClient;
  contractAddress?: string;
  gameId?: number;
  protocolId?: number;
  /** Traced train routes to draw over the rail map -- design note #137
   *  (F-1). One entry per train; omit or pass `[]` for no overlay.
   *
   *  This is the layer the board previously had NO equivalent of: track was
   *  drawn, but which track a train actually RAN was never shown, so a player
   *  building a manual route had no visual confirmation of the path they were
   *  assembling. */
  routeOverlays?: readonly RouteOverlay[];
  /* ==================================================================
   *  DESIGN NOTE 374: THE MAP DRIVES THE CURSOR TOO
   * ==================================================================
   *
   * `hexCanvasPrimitives.ts` design note #373 explains the shared cursor.
   * This is the map's end of it, and it is the only one of the three
   * surfaces that has to WORK for the connection: on a canvas there are no
   * elements to hover, so a route path cannot raise an event by itself.
   *
   * THE HIT TEST IS HEX-GRAINED, deliberately. `handlePointerMove` already
   * resolves the pointer to an axial `(q, r)` for the tooltip and the hover
   * highlight; asking which overlays contain that hex is a lookup against
   * data already in hand. Pixel-perfect proximity to the drawn spline would
   * mean re-deriving every authored `Path2D` under its transform and
   * running `isPointInStroke` per frame, for a gain the player cannot see:
   * routes run along rails, and a rail occupies its hex.
   *
   * A HEX ON TWO ROUTES HIGHLIGHTS NEITHER. Overlapping routes are the
   * common case in 1830 -- that is why they have separate colours at all --
   * and picking one arbitrarily would be worse than picking none: the
   * player would hover a shared segment, see a highlight, and conclude the
   * wrong train ran it. Ambiguity resolves to no answer.
   */
  highlightedTrainIndex?: number | null;
  onHighlightRoute?: (trainIndex: number | null) => void;
  /* ==================================================================
   *  DESIGN NOTE 223: THE WILD BLUE YONDER
   * ==================================================================
   *
   * REPORTED BUG: "players can currently click anywhere to lay track."
   *
   * They could. The click path's only board-level gate is
   * `evaluateHexForTileLaying`, which answers a STATIC question -- is this a
   * real hex, and is it the kind of hex a tile may ever go on -- and knows
   * nothing about the corporation doing the laying. So every buildable hex
   * on the board opened the picker, including ones on the far side of the
   * map from any track the company owns.
   *
   * When this set is supplied the board renders 18xx.games-style: hexes the
   * acting corporation's network reaches keep their normal brightness and
   * take a highlight ring, everything else is veiled, and a click outside
   * the set is reported as `"blocked"` with a reason rather than opening a
   * picker the contract would refuse.
   *
   * KEYED `"q,r"`, matching `utils/trackReach.ts`'s `hexKey`. A `Set` rather
   * than an array because the draw loop tests every hex on the board on
   * every frame, and a linear scan per hex is quadratic on a 100-hex map.
   *
   * OMITTED means NO DIMMING AND NO GATE -- the previous behaviour exactly.
   * That is what every phase other than Lay Track passes, and what Lay Track
   * itself passes when the corporation's reach cannot be determined (see
   * `LayableHexResult.unconstrained`): a board dimmed on a guess would take
   * the map away from the player over missing data. */
  /* ==================================================================
   *  DESIGN NOTE 241: THREE TIERS, NOT TWO
   * ==================================================================
   *
   * This was a single `ReadonlySet` of legal hexes: anything in it kept its
   * brightness, everything else was veiled. Two reports came out of that
   * shape and both are about the same missing tier.
   *
   *   THE NETWORK VANISHED. A player choosing where to extend is reasoning
   *   about the route the extension joins -- and that route was in the dark,
   *   because it is not itself a legal target. `visible` is the fix: the
   *   corporation's own track stays lit alongside the placements.
   *
   *   THE HIGHLIGHT WAS A BORDER. A crisp green ring reads as a hard UI
   *   chrome element stamped over the cardboard. `highlighted` still marks
   *   the legal set, but it is drawn as a soft bloom (see the draw pass) so
   *   it reads as the board glowing rather than as a box drawn on it.
   *
   * `highlighted` MUST BE A SUBSET OF `visible` -- a hex that is legal but
   * dimmed would be the worst of both. The caller unions them rather than
   * this asserting it, since the caller is the one with both sets in hand.
   */
  /* ==================================================================
   *  DESIGN NOTE 269: ONE THING ON A HEX AT A TIME
   * ==================================================================
   *
   * REPORTED: clicking a hex during Lay Track opens the tile selector AND
   * leaves the hover tooltip sitting on top of it.
   *
   * Both are anchored to the same hex, so they do not merely overlap by
   * accident -- they are drawn at the same point by design, one over the
   * other. The tooltip is also the less useful of the two by a distance:
   * it names a hex the player has just deliberately clicked, and the
   * selector directly above it already says which hex it is for.
   *
   * The tooltip is HOVER state, and the picker is a MODAL surface, so the
   * renderer cannot work this out for itself: the ring is mounted by
   * `App.tsx`, outside this component. Hence a prop rather than internal
   * logic -- the owner of the modal is the only one who knows it is open.
   *
   * `handlePointerMove` refuses to set the tooltip while this is on, and an
   * effect clears any tooltip already showing when it goes on. Both are
   * needed: the first stops it reappearing on the next mouse move, the
   * second removes the one that was on screen at the moment of the click. */
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
    /* ==================================================================
     *  DESIGN NOTE 377: THE VEIL IS BACK, FOR ONE PLAYER
     * ==================================================================
     *
     * Design note #367 removed the Lay Track veil outright on two
     * objections. Only one of them survives, and it needed a condition
     * rather than a deletion:
     *
     *   RIGHT: "it dimmed the board for EVERYONE." `layFocus` describes ONE
     *   corporation's reach and every player sees the same canvas, so three
     *   of four watched the map grey out for a restriction that was not
     *   theirs. That is what this flag fixes -- the veil now belongs to the
     *   player whose turn it is.
     *
     *   OVERSTATED: "it suppressed the board to emphasise a subset." True
     *   at `0.55`, where more than half the light went. The active player
     *   genuinely does want contrast against their own legal set, and the
     *   answer is a lighter overlay (`LAY_TRACK_DIM_ALPHA`, now `0.22`),
     *   not none. Deleting it removed the contrast along with the problem.
     *
     * SET BY THE SHELL, from `isMyTurn`, because only the shell knows who
     * is watching -- the renderer has a board and no identity. In hotseat
     * it is true by construction (whoever is at the keyboard holds the
     * turn) and correctly goes false when a tester pins the view to another
     * seat, which is how the passive-player case is reachable in sandbox.
     *
     * DEFAULT `false`: a caller that has not thought about whose turn it is
     * gets the undimmed board, which is the safe half of the asymmetry. */
    dim?: boolean;
  };
  /** Design note #159: the pointer's meaning right now.
   *
   *  `"token"` puts the canvas in station-token targeting mode: a crosshair
   *  cursor, so the board visibly stops being a place you click to lay
   *  track and becomes a place you click to drop a token. A mode with no
   *  cursor change is a mode players forget they are in, and then every
   *  subsequent click does something they did not intend. */
  cursorMode?: "default" | "token";
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
    q: number;
    r: number;
    /** The HUMAN name -- "New York (G19)". For messages, never for lookups
     *  or wire payloads; see `boardHexLabel`'s design note #242. */
    hexLabel: string;
    /** The hex's canonical board label -- "G19". `null` for a coordinate
     *  that is not a real board hex. THIS is the identifier. */
    boardLabel: string | null;
    clientX: number;
    clientY: number;
  }) => void;
  /** Reports the click-triggered `GetLegalTilePlacements` query's
   *  lifecycle -- see `HexClickQueryState`. */
  onHexClickQuery?: (state: HexClickQueryState) => void;
  /** When set, draws a translucent dashed-outline "ghost" preview of
   *  `tileId` at `orientation` on hex `(q, r)` -- the live map preview (see
   *  design note #7 / item 3 of the popup feature). */
  previewTile?: { q: number; r: number; tileId: number; orientation: number } | null;
  /** The room's live `GameStateResponse.current_global_era` -- see design
   *  note #15/item 4. Drives which single off-board revenue tier renders
   *  inside each red off-board hex. Defaults to `"Yellow"` (every new
   *  game's real starting era) so this component still renders sensibly
   *  when the host app hasn't wired a live `GetGameState` query yet. */
  currentEra?: TileColorTier;
  /** The room's live `GameStateResponse.public_companies`, verbatim (or a
   *  `StationTokenCompany[]` subset of it) -- see design note #36. Drives
   *  the Station Token marker rendering pass: a muted preprinted marker at
   *  each `STATION_HOME_HEXES` entry for any company not yet `is_floated`,
   *  and a real ticker-labeled marker at every one of a floated company's
   *  own `station_token_hexes`. Defaults to an empty array, so this
   *  component still renders its existing city circles sensibly (just with
   *  no Station Token overlay at all) when the host app hasn't wired a
   *  live `GetGameState` query yet -- the same fallback pattern `currentEra`
   *  above already establishes. */
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

/** Design note #36/item 1: was a flat `MAX_ZOOM = 3` ABSOLUTE cap, applied
 *  not just to the interactive zoom-in handlers below but to `minZoom`
 *  itself (the baseline board-fit zoom) -- on a wide-enough viewport,
 *  `fitZoom = width / boundsWidth` legitimately exceeds `3`, and that old
 *  absolute cap would silently clamp the baseline fit back DOWN to `3`,
 *  leaving real unused width on a widescreen pane instead of letting the
 *  board's true full-width scale (this item's "static max/min scale
 *  fraction override" that "compresses our map"). Redefined as a
 *  MULTIPLIER on `minZoom` instead of an absolute pixel-density constant --
 *  every use site below now computes `minZoom * MAX_ZOOM_MULTIPLIER`
 *  fresh, so the interactive "zoom in past the fit baseline" ceiling always
 *  scales WITH the baseline instead of ever being able to sit below it
 *  (the old absolute constant could invert -- a `minZoom` of `4` on a very
 *  wide viewport with the old `MAX_ZOOM = 3` would have made the
 *  "detail zoom" ceiling literally SMALLER than the baseline fit, an
 *  impossible zoomed-OUT "zoom in" button). `3` is kept as the multiplier's
 *  own value -- unrelated to the old absolute-pixel-density meaning, it
 *  just happens to be a reasonable "3x closer than the full-board fit"
 *  interactive zoom-in ceiling either way. */
const MAX_ZOOM_MULTIPLIER = 3;

/** Design note #43: how far BELOW the fit-to-screen scale a player may zoom.
 *
 *  `minZoom` is the scale at which the board exactly fills the pane, and it
 *  was also used as the hard lower bound -- so "Fit to Screen" WAS the zoom
 *  floor and the "-" button became a no-op the moment you reached it. That
 *  is wrong for a board this wide: pulling back past the fit to see the
 *  whole map with margin around it, while judging a long route, is a normal
 *  thing to want and there was no way to do it.
 *
 *  0.4 lets the board shrink to roughly a third of the pane width, which is
 *  far enough to be useful and near enough that the map is still legible.
 *  `ABSOLUTE_MIN_ZOOM_FLOOR` still backstops a degenerate viewport. */
const MIN_ZOOM_MULTIPLIER = 0.4;
/** Absolute safety floor under the dynamically-computed board-fit minimum
 *  zoom (design note #8) -- guards only against a degenerate near-zero
 *  viewport/`hexSize` combination; in normal use the computed `minZoom`
 *  below is always well above this. */
const ABSOLUTE_MIN_ZOOM_FLOOR = 0.1;

/** Rail Map Overhaul (design note #42): "Clean Up Control Overlay Overlaps."
 *  The old separate "Toggle Detailed View" button (design note #13) is
 *  removed outright per that item's explicit instruction -- `detailedView`
 *  itself is UNCHANGED (still gates pan/zoom, design note #13), it's just no
 *  longer toggled by its own dedicated button; `handleZoomStep` (design note
 *  #17) already flips it on by itself the moment "+"/"-" is pressed, and
 *  "Fit to Screen" already re-locks it back off, so removing this one
 *  redundant control loses no capability. The former "+"/"-"/"Fit to
 *  Screen" stack is consolidated into ONE floating "clean container" (this
 *  panel) -- a single bordered/backed card holding City Names/"-"/"+"/"Fit
 *  to Screen" as a horizontal row -- instead of two separate overlay
 *  clusters. Positioned top-right (the corner the old toggle button used to
 *  occupy) with a generous `20px` margin inset -- larger than the old
 *  16px -- specifically so this single compact row sits further inside the
 *  canvas, away from `drawBoardMarginLabels`' own row-letter/column-number
 *  text, which (design note #28) is drawn deliberately close to the true
 *  board edge. */
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

/** The floating "G19: New York (Value: $20)"-style coordinate+value
 *  tooltip -- see design note #21, scaled up and value-enriched by design
 *  note #26/item 2. `position: fixed` since it tracks the raw viewport
 *  pointer position (`clientX`/`clientY`), not anything relative to the
 *  wrapping panel. `pointerEvents: "none"` so it can never itself intercept
 *  the pointer events it's reporting on. Padding/font size roughly doubled
 *  from the original coordinate-only tooltip (design note #21) so the now-
 *  longer "{label}: {name} (Value: $X)" string stays fully legible instead
 *  of reading as a cramped afterthought. */
/* ==================================================================
 *  DESIGN NOTE 29: THE HOVER CARD WAS A HEADING WITH A BOX AROUND IT
 * ==================================================================
 *
 * REPORTED: hover cards and tooltips render at massive dimensions.
 *
 * This one was the worst offender on the board, and for a specific
 * reason: it drew at `FONT_SIZE.heading` -- the SECTION HEADING step, the
 * same size a panel title uses -- with `whiteSpace: "nowrap"` and no
 * maximum width. So a hover over New York produced a single unbroken line
 * at heading size carrying the hex name, its value, its terrain cost and
 * every station on it, and the card grew until the sentence ended. On a
 * 1080p screen that is a band most of the way across the map.
 *
 * A tooltip is ANNOTATION. It sits over the thing it describes and should
 * be the smallest readable thing on screen, not the largest -- so it takes
 * the `small` step, a hard 280px ceiling, and wraps rather than growing.
 *
 * `nowrap` went with the width cap, necessarily: a cap on a line that
 * cannot break is a cap that does nothing. */
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

/** The `[lo, hi]` pan range, along one axis, that keeps the board's own
 *  footprint from ever being fully dragged out of the canvas viewport at a
 *  given zoom level -- see design note #8. A single formula handles both
 *  the "board bigger than the viewport" case (keep the viewport inside the
 *  board) and the "board smaller than the viewport" case (keep the board
 *  inside the viewport): the two raw candidate bounds swap their min/max
 *  ordering exactly at the point where the board's scaled size crosses the
 *  viewport size, so sorting them always produces the correct pair either
 *  way, with no branching needed. */
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

/** Stable empty-array default for the `publicCompanies` prop (design note
 *  #36) -- a fresh `[]` literal in the destructuring default below would
 *  be a NEW array reference on every render, which would in turn make
 *  `draw`'s own `useCallback` dependency array (which includes
 *  `publicCompanies`) see a "changed" dependency every render and rebuild
 *  the callback needlessly. One shared module-level reference avoids that.
 *  Typed as plain (non-`readonly`) `StationTokenCompany[]`, matching the
 *  prop's own declared type exactly -- never actually mutated, but a
 *  `readonly` array literal here would not be assignable to that
 *  destructuring default. */
const EMPTY_PUBLIC_COMPANIES: StationTokenCompany[] = [];
/** Same reasoning: a stable identity so an omitted roster does not remount
 *  the memo that derives the reservations. */
const EMPTY_PRIVATE_COMPANIES: PrivateCompanyState[] = [];

/** Design note #365: how long a pointer must rest on a hex before its
 *  tooltip appears.
 *
 *  Design note #383: 2000ms -> 1200ms, reported as slightly too long. The
 *  delay exists so that sweeping the pointer across the board does not trail
 *  a queue of tooltips behind it, and 1200ms still clears that bar -- a
 *  deliberate pause reads as roughly a second, while a sweep crosses a hex
 *  in a fraction of one. What 2000ms additionally cost was the case the
 *  delay is FOR: a player who stops on a hex intending to read it waited
 *  long enough to wonder whether anything was coming. */
export const HEX_TOOLTIP_DELAY_MS = 1200;

/* ==================================================================
 *  DESIGN NOTE 366: THE RESERVATION, IN THE TOOLTIP
 * ==================================================================
 *
 * The badge (design note #364) says a hex is spoken for; it does not have
 * room to say by whom in words, and two or three letters on a corner are
 * only legible to somebody who already knows the abbreviation.
 *
 * The tooltip is where that gets spelled out, and it is now worth reading:
 * design note #365 made it something a player deliberately waits for rather
 * than something that flashes past, so a line appended here is a line
 * somebody asked for.
 *
 * ONE SHORT CLAUSE, appended rather than substituted. The hex's own
 * description -- its name, its terrain, its value -- is why the player
 * hovered; the reservation is a qualifier on it. "Reserved by CSL" is four
 * words and matches the badge exactly, so the mark on the board and the
 * text under the cursor teach each other.
 */
export function withReservationNote(
  description: string,
  reservation: { initials: string } | null,
): string {
  return reservation ? `${description} — Reserved by ${reservation.initials}` : description;
}

export function HexGridRenderer({
  mapGrid,
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
  previewTile,
  currentEra = "Yellow",
  publicCompanies = EMPTY_PUBLIC_COMPANIES,
  routeOverlays = EMPTY_ROUTE_OVERLAYS,
  highlightedTrainIndex = null,
  onHighlightRoute,
  cursorMode = "default",
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
      // Guard against a transient near-zero-size measurement clobbering the
      // last known-good `measuredSize` (design note #34/item 1). Originally
      // just `< 1`, which only caught a literal zero -- too narrow to catch
      // the actual reported bug: switching away from this component's tab
      // and back (a React re-render that toggles the host pane's display,
      // not an unmount) can report a transient SINGLE-DIGIT pixel size for
      // one observation (e.g. a hidden pane briefly reporting `contentRect`
      // as `{width: 4, height: 2}` mid-swap, before layout settles back to
      // its real size) -- comfortably past the old `< 1` gate, so it used to
      // sail through and collapse `measuredSize` (and therefore `hexSize`/
      // `minZoom`/the whole camera fit) down to that near-zero size, which
      // is the "crashing the layout down to zero" this item reports.
      // Widened to `<= 10`: still small enough that no real, usable board
      // pane will ever legitimately measure at or under it, but comfortably
      // covers the transient tab-swap readings actually seen. Simply
      // `return`ing here (skipping `setMeasuredSize` entirely) is already
      // exactly the "preserve last known valid ... settings" behavior this
      // item asks for -- React state isn't touched, so `measuredSize` stays
      // at whatever it was before this bad reading, with zero extra state
      // needed to "remember" it separately.
      if (observedWidth <= 10 || observedHeight <= 10) return;
      setMeasuredSize((prev) => {
        if (prev.width === observedWidth && prev.height === observedHeight) return prev;
        return { width: observedWidth, height: observedHeight };
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [widthProp, heightProp]);

  // The board's own fixed, unscaled footprint -- deliberately memoized on
  // `hexSize` alone, NOT on `mapGrid.tiles` (design note #8): the
  // clampable/fittable area is the physical board, not whatever happens to
  // be laid on it yet. MOVED above the `width`/`height` derivation below
  // (design note #27/item 1) -- `height` is now DERIVED from this board's
  // own aspect ratio, so it has to exist first.
  const boardContentBounds = useMemo<BoardContentBounds>(() => {
    const points = [
      ...STATIC_BOARD_HEXES.map((h) => axialToPixel(h.q, h.r, hexSize)),
      ...LANDMARK_HEXES.map((l) => axialToPixel(l.q, l.r, hexSize)),
    ];
    // Design note #26: tightened to the hexes' own true outermost
    // coordinate edges -- `hexSize` is the exact center-to-corner radius
    // (see `pointOnCircle(center, size, cornerAngleRad(i))` in
    // `drawHexPath`), so padding by exactly `hexSize` is the tight,
    // mathematically-derived bound against each edge hex's real corner,
    // not an arbitrary buffer. The previous `hexSize * 2.5` term (extra
    // clearance reserved for the margin labels drawn outside the board)
    // has been removed outright per that item's explicit "completely
    // remove any large hardcoded pixel padding" instruction -- see design
    // note #26 for the accepted margin-label tradeoff this creates.
    //
    // FOLLOW-UP ("Camera Padding Must Reserve Room For Margin Labels"):
    // design note #26's tight `hexSize`-only padding left literally ZERO
    // slack beyond each edge hex's own corner point -- fine for the board
    // itself, but it meant there was no room at all left over for the
    // margin labels drawn just outside that corner, which is the deeper
    // reason column-number labels kept overlapping the top/bottom hexes
    // even after `computeBoardMarginLabels`'s own width-vs-height
    // measurement bug was fixed (that fix corrected WHICH dimension the
    // label's clearance came from, but there was no budget left in that
    // dimension to spend). `marginLabelReserve` adds back a small,
    // proportional reservation -- NOT the old flat `hexSize * 2.5` -- sized
    // off `hexSize`/font size alone so it stays a minimal, formula-derived
    // top-up rather than the "large hardcoded pixel padding" that note #26
    // was written to remove. `computeBoardMarginLabels` MUST keep deriving
    // its own `hexEdgePadding` from this exact same total (see its own
    // comment) or the two fall back out of sync.
    const hexEdgePadding = hexSize + marginLabelReserve(hexSize);
    return {
      minX: Math.min(...points.map((p) => p.x)) - hexEdgePadding,
      maxX: Math.max(...points.map((p) => p.x)) + hexEdgePadding,
      minY: Math.min(...points.map((p) => p.y)) - hexEdgePadding,
      maxY: Math.max(...points.map((p) => p.y)) + hexEdgePadding,
    };
  }, [hexSize]);

  const width = widthProp ?? measuredSize.width;
  /** ITEM 1 FIX (design note #27): `height` used to come straight from the
   *  `ResizeObserver`'s own measured container height -- which only ever
   *  reflected whatever fixed/clamped height an ancestor pane imposed (see
   *  `App.tsx` design note #13), i.e. exactly the "tiny panel box" this item
   *  reports. Now that no ancestor imposes one, that measurement would be
   *  meaningless (a `height: auto` box just mirrors back whatever this
   *  component itself renders -- circular). `height` is now DERIVED from
   *  the board's own true aspect ratio (`boardContentBounds`) at the
   *  available `width`, so the canvas always renders at its full natural
   *  proportional height for that width -- "true maximum proportional scale
   *  bounds," not vertically cropped/shrunk to fit whatever bounded
   *  viewport happened to be available. Ancestors are now free to just grow
   *  to match (`App.tsx` design note #13), letting the BROWSER's own page
   *  scrollbar carry the rest. */
  /* ==================================================================
   *  DESIGN NOTE 30: REVERTED -- THE BOARD IS NOT A SCROLL WINDOW
   * ==================================================================
   *
   * This briefly capped the height at 72% of the viewport, on the
   * reasoning that a board taller than the window pushes the action bar
   * and the status panels off screen.
   *
   * It was wrong, and the way it was wrong is worth keeping. The
   * assumption was that a canvas shorter than the board's aspect ratio
   * would LETTERBOX -- that `fitView` would refit the map into whatever
   * box it was given and leave margin at the sides. It does not: the
   * camera holds a locked baseline pose (design note #8), so a shorter
   * canvas simply shows less of the board. The map was cropped top and
   * bottom, and the only way to see the missing rows was to pan inside the
   * canvas -- a scroll window nested inside a scrolling page, which is
   * worse than the problem it replaced.
   *
   * Design note #27 had already settled this, and design note #13 in
   * `App.tsx` dropped `overflow: auto` from the board's ancestors on
   * purpose so the PAGE scrollbar carries the map. The height is derived
   * from the board's own aspect ratio at the available width, the wrapper
   * grows to match, and the whole board is reachable by scrolling the page
   * exactly like any other tall content.
   *
   * If the chrome being pushed down is worth solving later, the fix is a
   * smaller board -- fewer pixels per hex -- not a smaller window onto the
   * same board. */
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

  /** The zoom level used for the locked baseline camera pose -- see design
   *  note #8, tightened by design note #26.
   *
   *  ITEM 1 FIX (design note #27, supersedes the structural calibration
   *  pass's `Math.max(width / boundsWidth, height / boundsHeight)` "fill
   *  both edge-to-edge, crop whichever axis doesn't fit" formula): now that
   *  `height` (above) is DERIVED to always match `boundsWidth`'s own aspect
   *  ratio at this `width`, fitting to `width` alone is exactly equivalent
   *  to fitting to both axes -- there is no longer a mismatched-aspect-ratio
   *  viewport to crop against, because the viewport's own aspect ratio now
   *  always matches the board's. This is what "true maximum proportional
   *  scale bounds" means concretely: the hex size that makes the board's
   *  full width exactly fill the available `width`, with zero cropping on
   *  either axis, rather than the previous pass's deliberate crop-to-fill.
   *  Toggling "Detailed View" still lets a player pan/zoom in past this for
   *  a closer look, same as before. */
  const minZoom = useMemo(() => {
    const boundsWidth = Math.max(boardContentBounds.maxX - boardContentBounds.minX, 1);
    const fitZoom = width / boundsWidth;
    // Design note #36/item 1: no upper clamp here anymore -- only the
    // degenerate-viewport floor. `fitZoom` IS "the base hex radius
    // multiplier scaled up so the map naturally occupies the widescreen
    // space," so nothing should cap it back down on a wide viewport.
    return Math.max(ABSOLUTE_MIN_ZOOM_FLOOR, fitZoom);
  }, [boardContentBounds, width]);

  /** The locked "100% view" camera pose -- see design note #13. Exactly
   *  `minZoom`, centered on the board's own bounds, i.e. the same
   *  computation the one-shot auto-fit (design note #5) already used. This
   *  is now also the camera's permanent baseline pose: with
   *  `detailedView === false`, `view` is always exactly this (drag/wheel
   *  handlers are no-ops at baseline), and toggling detailed view back off
   *  snaps the camera back to precisely this pose. */
  const fitView = useMemo<ViewTransform>(() => {
    const centerX = (boardContentBounds.minX + boardContentBounds.maxX) / 2;
    const centerY = (boardContentBounds.minY + boardContentBounds.maxY) / 2;
    return {
      zoom: minZoom,
      panX: width / 2 - centerX * minZoom,
      panY: height / 2 - centerY * minZoom,
    };
  }, [boardContentBounds, minZoom, width, height]);

  /** `false` (the default): the camera is locked at exactly `fitView` --
   *  the "100% view", the whole board framed in the viewport -- and pan/
   *  zoom input is ignored (see design note #13). `true`: the "Toggle
   *  Detailed View" button was clicked -- the camera jumped to a closer,
   *  zoomed-in pose and drag-pan/wheel-zoom are both live so the player can
   *  inspect close details manually. */
  const [detailedView, setDetailedView] = useState(false);

  /** Rail Map Overhaul (design note #42): "City Nameplate Visibility
   *  Toggle." `true` (the default): city/landmark name plates render
   *  normally, exactly as before this item. `false`: `draw()`'s every
   *  name-label pass (landmark names, gray/OO hex names, the stacked
   *  dual-city/dual-town name pairs, and the off-board zone nameplates) is
   *  skipped outright -- station tokens, revenue/value badges, and every
   *  track spline are all drawn by entirely separate passes earlier in
   *  `draw()` and are completely unaffected either way, per this item's own
   *  explicit "while maintaining station tokens, revenue badges, and track
   *  splines" wording. */
  const [showCityNames, setShowCityNames] = useState(true);

  /** The off-board hex currently under the pointer, if any -- see design
   *  note #15/item 4. Tracked independently of drag/`detailedView` state
   *  (hover works at the locked 100% baseline too, not just in detailed
   *  view): `handlePointerMove` updates this on every move, `handlePointerUp`
   *  (also wired to `onPointerLeave`) clears it. Stored as the hovered
   *  hex's own axial `(q, r)`, not a pixel/label, so it stays correct
   *  across zoom/pan changes without needing to be recomputed. */
  const [hoveredOffboardHex, setHoveredOffboardHex] = useState<{ q: number; r: number } | null>(
    null,
  );

  /** The hex currently under the pointer, if any -- see item 7 ("Muted Base
   *  Text with Hover Glow"). Deliberately separate from `hoveredOffboardHex`
   *  above (which only ever populates for an off-board zone hex, for that
   *  feature's own narrower tooltip purpose): this one is set on EVERY
   *  pointer move regardless of what kind of hex is under it, so `draw()`'s
   *  city/town/landmark name-label passes can look it up to decide whether
   *  that specific hex's label should render in its bright, bold, 100%-
   *  opaque hover style instead of its default muted/translucent one. */
  const [hoveredHexCoord, setHoveredHexCoord] = useState<{ q: number; r: number } | null>(null);

  /* ==================================================================
   *  DESIGN NOTE 365: THE TOOLTIP WAITS
   * ==================================================================
   *
   * REPORTED: map tooltips appear instantly, causing visual fatigue while
   * scanning the board.
   *
   * They did, and the cost compounds with the board's density: dragging the
   * pointer across the map fired a tooltip on every hex it crossed, so
   * moving from one side to the other flashed a dozen panels the player had
   * not asked for. An instant tooltip is right for a control whose meaning
   * is unclear; it is wrong for a hundred adjacent things you are looking
   * PAST on your way somewhere.
   *
   * TWO SECONDS, which is long by tooltip conventions and correct here: the
   * point is that a hex you are merely crossing never shows one, and the
   * pointer crosses a hex in a fraction of a second. The delay only expires
   * when a player has genuinely stopped on something.
   *
   * WHAT IS NOT DELAYED: `hoveredHexCoord`, the highlight the board draws
   * under the cursor. That is FEEDBACK -- it tells the player what they are
   * pointing at -- and delaying it would make the map feel unresponsive.
   * Only the text panel waits.
   *
   * THE TIMER IS RESTARTED, not merely started, on every move onto a new
   * hex, which is what makes the delay per-hex rather than per-entry: a
   * slow sweep across five hexes shows nothing until the pointer settles.
   */
  /* Design note #380: the last repaint's route stroke geometry, in board
     pixels. `null` until the first draw, which is the state the pointer
     handler treats as "no pixel answer available". */
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

  /** The active-coordinate hover tooltip's live state -- see design note
   *  #21. `label` is the same board-label string `describeHex` would
   *  produce (a landmark's name + label, an off-board zone's name + label,
   *  or a plain board label like `"G19"`); `null` whenever the pointer
   *  isn't over a real hex of the authentic board at all, which hides the
   *  tooltip entirely rather than reporting a meaningless "off the board"
   *  string. `clientX`/`clientY` are the raw viewport pointer coordinates
   *  (NOT canvas-relative), so the DOM tooltip below can position itself
   *  with plain `position: fixed` math. `preferLeft`/`preferAbove` (design
   *  note #75) mirror `drawOffboardTooltip`'s own "ADAPTIVE QUADRANT"
   *  pattern for this file's OTHER tooltip -- reported: this one always
   *  anchored down-right of the cursor regardless of available room, so it
   *  ran off the panel for any hex near the panel's own right/bottom edge
   *  (Boston, Fall River). Set once per pointer move, from the cursor's
   *  position within the CANVAS's own bounding rect (i.e. the panel), not
   *  the browser window -- so the flip threshold tracks the panel's actual
   *  edges even if the canvas doesn't fill the whole viewport. */
  const [hoveredCoordLabel, setHoveredCoordLabel] = useState<{
    label: string;
    clientX: number;
    clientY: number;
    preferLeft: boolean;
    preferAbove: boolean;
  } | null>(null);

  /** The full draw pass: background, landmark shading, every laid tile's
   *  fill + track path, then landmark labels on top so they stay legible
   *  regardless of what's drawn beneath them. */
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
      // Design note #26/item 3: I1/J2 (Gulf) suppress their one shared
      // interior edge here so the two hexes read as a single merged region
      // -- `drawHexEdges` re-strokes the OTHER five edges individually
      // instead of `ctx.stroke()`ing the full closed path `drawHexPath`
      // just traced above. Item 9: A9/A11 (Canadian West) get the identical
      // treatment via `CANADIAN_WEST_HIDDEN_EDGE`.
      const hiddenEdge = GULF_HIDDEN_EDGE[hex.label] ?? CANADIAN_WEST_HIDDEN_EDGE[hex.label];
      if (hiddenEdge !== undefined) {
        drawHexEdges(ctx, center, hexSize, new Set([hiddenEdge]));
      } else {
        ctx.stroke();
      }
    }

    // Design note #72: ONE claimed-slot ledger, shared by every one of this
    // render's slot-picking passes (terrain icon, restriction badge,
    // terrain-cost label, revenue badge) in their existing draw order --
    // see `claimHexSlot`'s own doc comment for why this exists (New York/
    // G19's badge, cost label, and icon all independently picking the same
    // one open corner). Declared fresh here, at the top of this whole block
    // of passes, and threaded through every one of them below.
    const claimedHexSlots = new Map<string, Set<number>>();

    // Design note #72: the SE-edge-first preference a complex hex's terrain
    // icon/cost share -- pulled out to a shared constant so both stay in
    // visual agreement about which corner/edge is "the bottom-right
    // quadrant". Design note #87: RENAMED from `DOUBLE_CITY_TERRAIN_SLOT_PREFERENCE`
    // (unchanged values) now that it's used by every complex hex's ONE
    // compound [icon+cost] badge claim, not just DoubleCity's separate
    // icon-slot claim.
    //
    // Design note #105: REORDERED, per direct request -- now leads with
    // (what the request calls) "Vertex 2" and "Vertex 4", this system's
    // own slot 9 (Lower-Right corner) and slot 11 (Lower-Left corner)
    // respectively, before falling through to the original SE-edge/
    // Bottom-Point pair (slots 3/10) as before.
    const COMPLEX_HEX_TERRAIN_SLOT_PREFERENCE: readonly number[] = [9, 11, 3, 10];

    // ---- Buildable terrain icons (design note #9; SPLIT from its own cost
    // label by design note #55's Strict Canvas Layering Hierarchy -- a cost
    // label is Layer 4 (text) content and now draws in that section further
    // below, alongside every other badge/label; only the Layer 1 terrain
    // VECTOR itself belongs this early). Mountain hexes get a brown
    // twin-peak icon, River hexes get a blue river-line icon -- both now sit
    // on the standard land fill drawn above, so they read as "buildable, at
    // a cost" rather than "impassable obstacle".
    //
    // Design note #87: a "complex" hex -- one with a city/town archetype OR
    // real live track -- no longer draws a standalone icon here AT ALL.
    // GENERALIZED from the old DoubleCity-only check, which missed the
    // SingleCity `cityDesignation` River hexes (Toledo/F4, Providence/F22,
    // Washington D.C./J14) -- those rendered a FULL-SIZE, dead-CENTERED
    // icon directly under their own revenue badge/nameplate, since
    // `isDoubleCityHex` was false for them. Every complex hex's icon is now
    // drawn together with its cost, as ONE compound badge, by the
    // terrain-cost pass further below (Layer 4) -- claiming exactly ONE
    // slot there, instead of the two separate claims (one here, one there)
    // a DoubleCity hex used to make.
    for (const hex of STATIC_BOARD_HEXES) {
      if (hex.type !== "Mountain" && hex.type !== "River") continue;
      // Design note #150: A LAID TILE COVERS THE PREPRINT.
      //
      // On the physical board a tile is a piece of cardboard placed ON TOP
      // of the printed hex; the mountain artwork underneath is not visible
      // through it. This renderer drew both, so a tiled mountain showed the
      // tile's track AND the mountain icon it was supposedly covering.
      //
      // The `isComplexHex` test below already skipped most tiled hexes as a
      // side effect (a laid tile has live edges), but only incidentally --
      // it is asking "is this hex visually busy", not "is it covered". The
      // explicit check states the actual rule, and covers the case the
      // incidental one missed.
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

    // ---- Landmark dashed outline (drawn next, so a laid hub tile there,
    // and the label drawn later, both sit visibly on top of it).
    // ITEM 1 FIX (color calibration pass, "Unify All Board Yellow
    // Shades"): this loop used to ALSO re-fill each landmark hex with its
    // own translucent per-city tint (`LANDMARK_FILL` -- a ~20%-alpha red/
    // blue/green painted over that hex's ordinary cream `BOARD_HEX_FILL.Plain`
    // base from the static-background pass above), which is exactly the
    // "lighter pastel/cream" look this item reports -- visually distinct
    // from every other real pre-printed yellow hex on the board. Design
    // note #12 already established, from the same sourced data as the
    // pre-printed yellow "OO" hexes, that New York/Boston/Baltimore ARE
    // real pre-printed yellow hexes too -- so `STATIC_BOARD_HEXES`'s own
    // entries for G19/E23/I15 now carry `printedColor: "Yellow"` just like
    // every OO hex, which means the static-background pass above already
    // fills them with the exact same shared `PRINTED_HEX_FILL.Yellow`
    // constant an OO hex gets -- genuinely "the exact same... fill color"
    // this item asks for, not just a matching hex string. FACTUAL
    // CORRECTION: this item's own suggested `#FFCC00` example doesn't match
    // what this file actually uses for OO/catalog yellow anywhere --
    // `PRINTED_HEX_FILL.Yellow` is `#e8d488`, a deliberately muted
    // "cardstock" gold (design note #12), not a bright saturated color; no
    // bright/saturated yellow fill exists anywhere else in this file to
    // match. Using the literal `#FFCC00` example instead would have
    // introduced a FOURTH distinct yellow shade rather than unifying to the
    // three hexes that already share one -- so this pass points landmarks
    // at the real shared constant instead, which is what actually delivers
    // this item's own stated goal ("a uniform visual look across the map").
    // This loop's own `LANDMARK_FILL` fill is removed outright (the base
    // pass already paints the correct fill); only the dashed white outline
    // -- which still usefully flags "this hex is a landmark station",
    // unrelated to fill color uniformity -- remains here.
    /* REMOVED (design note #160): the dashed white perimeter this loop drew
       around Boston, Baltimore and New York.

       It was the last survivor of a treatment whose other half -- the
       per-landmark translucent fill -- the comment above records being
       deleted for making these three hexes look unlike every other
       preprinted yellow hex. The outline had exactly the same effect for
       exactly the same reason: G19/E23/I15 are ordinary preprinted yellow
       hexes that happen to carry a letter code, and ringing them in dashes
       drew a distinction the board itself does not make.

       Dashes also already MEAN something else in this renderer -- both other
       users are "provisional": the ghost tile preview and
       `drawUnknownTilePlaceholder`. A permanent feature drawn in the
       provisional idiom reads as unfinished.

       Nothing is lost. The "B"/"NY" corner restriction badges still mark
       these hexes, say WHICH code each carries rather than merely that one
       exists, and persist across every tier (design note #49). */

    // ---- Every laid tile: fill, outline, and its decoded track path.
    // Landmark hexes (New York/Boston/Baltimore) skip the generic
    // bitmask-driven `drawTrackPath` entirely -- their authentic
    // pre-printed track is drawn unconditionally in a dedicated pass below
    // instead (see design note #6b). The fill/outline (including any
    // color-tier upgrade) still draws here either way.
    // BUG FIX ("Unify All Board Yellow Shades" follow-up -- reported: I15/
    // G19/E23 render a visibly different shade of yellow from every other
    // pre-printed yellow hex). The earlier pass fixed the STATIC background
    // fill (`STATIC_BOARD_HEXES`'s own `printedColor: "Yellow"` entries,
    // painted with `PRINTED_HEX_FILL.Yellow` = `#e8d488` before any tile is
    // laid), but this loop repaints right over that base the moment a real
    // `mapGrid.tiles` entry exists at that hex -- which, for a landmark, is
    // basically always true (a `MajorCityHub`/`DoubleCityHub` tile is
    // required there per the backend's landmark reservation, not an
    // optional player upgrade), using `ERA_TILE_FILL[catalogEntry.color]` (design note #122)
    // instead -- `TERRAIN_FILL.MajorCityHub`/`DoubleCityHub` is `#e8d9c0`, a
    // distinctly lighter/less-saturated tan than `#e8d488`, which is
    // exactly the "different shade of yellow" this reports. The same latent
    // mismatch applies to the four `YELLOW_OO_HEXES` once THEY receive a
    // laid `DoubleCityHub` tile too (tile 15) -- they just hadn't yet in
    // this game state, which is why only the landmarks showed it. Elsewhere
    // in this file, a laid tile's FILL is deliberately terrain-only, with
    // color-tier (Yellow/Green/Brown) conveyed purely through the stroke
    // below (`COLOR_TIER_STROKE`) -- never the fill -- so this keeps that
    // same convention for these hexes: any hex whose `STATIC_BOARD_HEXES`
    // entry is `printedColor: "Yellow"` (landmarks AND OO hexes alike) always
    // keeps the shared `PRINTED_HEX_FILL.Yellow` fill regardless of which
    // hub tile ends up laid there or what tier it's since been upgraded to
    // -- exactly mirroring how the pre-laid static pass already treats it,
    // and how an ordinary buildable hex's fill never encodes tier either.

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
        // Design note #133: the `!landmarkAt(...)` guard that used to sit
        // here is GONE, and its removal is the real fix for the reported
        // "tile 62 draws crossing track with a station dumped on the
        // intersection".
        //
        // New York, Boston and Baltimore are `LANDMARK_HEXES`. The guard
        // meant a laid tile on one of them never called `drawTrackPath` at
        // all -- so #54/#62 (NY) and #53/#61 (B) could never reach the
        // hardcoded artwork catalog no matter what was in it. What the
        // player saw on G19 instead was the PRE-PRINTED landmark track
        // from `drawLandmarkTrack`, whose two stubs run to
        // `twoNodePositions`' fixed NE/SW diagonal: a stub from the NW
        // edge sweeping down to the SW node crosses the other stub, and
        // the station sits on the crossing. Exactly the reported symptom,
        // and entirely upstream of the #62 path strings -- those are
        // provably non-crossing (see `TILE_GRAPHICS_CATALOG`'s #62 note:
        // the two arcs occupy x >= 0.366 and x <= -0.366 respectively).
        //
        // The pre-printed track pass below is now the one that yields,
        // which is the correct direction: printed artwork is what a hex
        // shows UNTIL a tile covers it.
        // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
        withHexClip(ctx, center, hexSize, () => {
          // Design note #121: no longer passes `tile.paths`. Double-town
          // artwork now comes from the explicit `DOUBLE_TOWN_ROUTES` table
          // keyed on `tile_id`, and every other tile was always drawn from
          // `connections` alone -- so there is nothing left for the
          // per-tile query value to feed. The contract still sends it and
          // `MapTileEntry.paths` still types it; this renderer just has no
          // use for it now.
          drawTrackPath(ctx, center, hexSize, catalogEntry, tile.orientation, false);
        });
      } else {
        // Unknown tile_id -- see design notes #2 and #118. Renders generic
        // provisional artwork rather than silently drawing nothing (or,
        // as previously, an alarming bare red "?" that read as an error
        // state). Every one of the backend's 46 real tray tiles IS in the
        // mirror above, so reaching this path means the mirror has fallen
        // behind a further backend change -- degraded, but never a crash.
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
      // Design note #133: "always drawn" was the bug's other half. A
      // landmark's pre-printed track is its STARTING artwork, not a
      // permanent overlay -- once a real tile is laid the printed stubs are
      // physically covered by it. Continuing to draw them on top of a laid
      // #62 stacked two different renderings of New York in the same hex.
      if (hexHasLaidTile(mapGrid, landmark.q, landmark.r)) continue;
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
      withHexClip(ctx, center, hexSize, () => {
        // Design note #211: keyed on the hex LABEL, which is what the
        // printed artwork catalog is authored against.
        drawLandmarkTrack(ctx, center, hexSize, landmark.label);
      });
    }

    // ---- Off-board pre-printed track, always drawn (see design note #10)
    // -- symmetric with the landmark track pass above. No laid-tile loop
    // ever needs to skip over these coordinates the way it does for
    // landmarks: `hexmap::OffboardHexNotBuildable` makes it impossible for
    // `mapGrid.tiles` to ever contain an entry here in the first place.
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
      // Design note #150. "Always drawn" (#12) was written when nothing
      // could be laid on these four hexes. Now that green #59 and the five
      // brown OO tiles can be, "always" produced the worst ghost on the
      // board: #59 draws its OWN two stations, so an upgraded Philadelphia
      // & Trenton rendered FOUR station circles -- two of them belonging to
      // a preprint the tile was sitting on top of.
      //
      // NOT to be confused with the "OO" corner RESTRICTION badge further
      // down, which design note #49 deliberately keeps visible across every
      // tier. That badge says what MAY be laid here; these circles claim
      // what IS here, and only the second claim goes stale.
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #55: Strict Hex Boundary Clipping, extended to station
      // markers -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        drawOOCityMarkers(ctx, center, hexSize);
      });
    }

    // ---- Item 1/8 (structural calibration pass): ordinary white Town/
    // Double-Town-DESIGNATED hexes get their dark dit marker(s) drawn even
    // though they carry no printed track of their own (see
    // `BoardHex.townDesignation`'s doc comment) -- a single dark dit for a
    // Single-Town designation, two side-by-side dark dits (mirroring
    // `drawOOCityMarkers`'s two-station layout) for a Double-Town
    // designation, so a player can see at a glance which blank hexes are
    // reserved for a Town/Double-Town tile rather than ordinary track.
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
          // Design note #54/#55/#58: Unified Diagonal Node Geometry -- the
          // SAME shared `twoNodePositions` tuple `drawOOCityMarkers` uses
          // for its two station circles, not an independently-tuned
          // side-by-side layout, so every two-node hex on the board reads
          // identically. Index 0/1 map straight onto the two `drawDitMarker`
          // calls, first slot then second, with no re-sorting.
          const [node0, node1] = twoNodePositions(center, hexSize);
          drawDitMarker(ctx, node0, hexSize * 0.85); // index 0: top-right
          drawDitMarker(ctx, node1, hexSize * 0.85); // index 1: bottom-left
        } else {
          drawDitMarker(ctx, center, hexSize);
        }
      });
    }

    // ---- Design note #34/item 2: ordinary white single-CITY-DESIGNATED
    // hexes (Toledo/Providence/Pittsburgh/Columbus/Washington/Lancaster/
    // Ottawa/Barrie) get the same "marker with no printed track" treatment
    // as the Town/Double-Town pass just above, but using the SAME
    // `drawStationCircle` (white fill, dark stroke) every other real city
    // marker in this file uses -- landmarks, `GRAY_HEXES` cities, OO
    // stations, laid `MajorCityHub` tiles -- rather than `drawDitMarker`, so
    // these read as genuine cities rather than minor town stops, matching
    // this item's own explicit "correct white station circles" ask. All
    // eight are single-city hexes on the real board (none of them a
    // double-city pair like `YELLOW_OO_HEXES`), so this is always one
    // centered circle, no offset pair needed.
    for (const hex of STATIC_BOARD_HEXES) {
      if (!hex.cityDesignation) continue;
      // Design note #150: same as the Town pass above. A laid `MajorCityHub`
      // tile draws its own station circle in the same place, so without this
      // the two stack -- producing a subtly heavier, off-centre circle
      // rather than an obviously doubled one, which is worse: it reads as a
      // rendering imprecision rather than as a bug.
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #55: Strict Hex Boundary Clipping, extended to station
      // markers -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        drawStationCircle(ctx, center, hexSize);
      });
    }

    // ---- Traced train routes (design note #137 / F-1). ----
    //
    // POSITION IN THE PASS ORDER IS DELIBERATE, and is the whole reason this
    // sits here rather than at the end: AFTER every track pass, so a route
    // reads as running ON the rails rather than under them; BEFORE station
    // tokens, city circles and every badge, so the overlay can never bury the
    // markers a player needs in order to read the board. A route is an
    // annotation over the map, not a replacement for it.
    // Design note #155: hand the overlay the laid tiles so it can trace each
    // hex's real authored rail. A plain lookup closure rather than the whole
    // grid -- the primitive has no business knowing what a `MapGridResponse`
    // is, and this keeps it a pure drawing function.
    // Design note #195: the SECOND lookup is the one that fixes preprinted
    // track. `tilesAt` above can only ever answer for a hex carrying a laid
    // `MapTileEntry`; every gray hex, all three landmarks and every off-board
    // terminal have real rails and no tile record, so the overlay had nothing
    // to follow and fell back to a straight edge-to-centre spoke. This hands
    // the glow the same four sources the four track passes above draw from,
    // in the same precedence order they run in.
    /* Design note #373: emphasis is computed HERE, where the cursor is
       known, and handed down as data. `drawRouteOverlays` stays a pure
       renderer of what it is given. */
    const emphasised = routeOverlays.map((overlay) => ({
      ...overlay,
      emphasis:
        highlightedTrainIndex === null || overlay.trainIndex === undefined
          ? ("normal" as const)
          : overlay.trainIndex === highlightedTrainIndex
            ? ("primary" as const)
            : ("muted" as const),
    }));

    /* Design note #380: the draw hands back the flattened stroke geometry
       it just painted, one path per train, for the pointer to test against.
       Stashed in a ref rather than state -- it changes on every repaint,
       and re-rendering React because the hit geometry moved would repaint
       the canvas, which would rebuild the geometry. */
    routeHitRef.current = drawRouteOverlays(
      ctx,
      hexSize,
      emphasised,
      (q, r) => mapGrid.tiles.find((tile) => tile.q === q && tile.r === r),
      // Design note #226: the whole-hex `railsAt` lookup is gone. Endpoints
      // resolve to a single authored rail now, so there is no branch left
      // that needs to know how a hex was drawn -- only which path to stroke.
      // Design note #215: the printed label, so a route crossing a gray hex
      // or a landmark highlights the ONE rail it runs along rather than
      // every rail on the hex. Only hexes with authored printed artwork
      // qualify -- an off-board terminal has stubs rather than a traversable
      // path, and falls through to the whole-hex trace above.
      (q, r) => {
        const boardHex = STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r);
        if (boardHex && GRAY_HEXES[boardHex.label]) return boardHex.label;
        const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
        return landmark?.label;
      },
    );

    /* ==================================================================
     *  DESIGN NOTE 222: TOKENS ARE DRAWN LAST, NOT MERELY LATE
     * ==================================================================
     *
     * REPORTED BUG: badges render on top of and obscure tracks and cities.
     *
     * This pass used to run HERE, immediately after the city-circle passes,
     * on the reasoning recorded in its own comment: "layered on TOP of every
     * white/gray/OO station circle drawn above." True of the circles, and
     * false of everything that came after -- the value badges, the "B"/"NY"/
     * "OO" restriction badges and every nameplate pass all draw further down
     * this function, so all of them landed on top of the tokens.
     *
     * A badge covering a token is worse than a badge covering track: a token
     * is the one marker that says WHOSE network this is, and a route's
     * legality turns on it. The value badge sitting over it is information
     * the player can get from the tooltip; the token is not.
     *
     * The pass is now a closure invoked after every badge and label pass, so
     * the marker z-order ends: track -> route glow -> city circles ->
     * badges/labels -> STATION TOKENS -> live tile preview. Deferred rather
     * than physically relocated because it reads `claimedHexSlots` and the
     * company map built alongside the passes above; moving the code would
     * have meant moving those too, and the ordering is the whole change.
     */
    const drawStationTokenPass = () =>
    {
      const companiesById = new Map<number, StationTokenCompany>();
      for (const company of publicCompanies) {
        companiesById.set(company.company_id, company);
      }

      for (const home of STATION_HOME_HEXES) {
        const company = companiesById.get(home.companyId);
        if (company && company.is_floated) continue; // drawn by the floated pass below instead
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
        // Design note #106 (E11/Dunkirk & Buffalo only): reported the
        // reserved marker's straight-down margin point slightly overlaps
        // the bottom city marker there -- moved to Vertex 2/slot9
        // (Lower-Right), the requested destination, via `hexSlotDirection`
        // at the SAME `0.46 * hexSize` magnitude as the original
        // straight-down point (direction changed, distance from center
        // unchanged, per the user's own separate observation that these
        // offset magnitudes may already be too large -- no reason to make
        // this one any larger while fixing its direction). The other three
        // `YELLOW_OO_HEXES` (Detroit & Windsor/E5, Hamilton & Toronto/D10,
        // H18) were NOT reported and keep the original straight-down point
        // unchanged.
        const erieVertex2 = hexSlotDirection(9);
        const point =
          home.label === "E11"
            ? { x: homeCenter.x + erieVertex2.x * hexSize * 0.46, y: homeCenter.y + erieVertex2.y * hexSize * 0.46 }
            : YELLOW_OO_HEXES.has(home.label)
              ? { x: homeCenter.x, y: homeCenter.y + hexSize * 0.46 }
              : stationMarkerPoint(home.q, home.r, hexSize);
        // Design note #55: Strict Hex Boundary Clipping, extended to
        // station token markers -- previously only track/text calls were
        // wrapped.
        withHexClip(ctx, homeCenter, hexSize, () => {
          drawStationTokenMarker(
            ctx,
            point,
            hexSize,
            // Corporate Acronym Overlay guarantee (design note #45): prefer
            // a live `company.ticker` when `publicCompanies` has already
            // loaded this company, but fall back to the static
            // `stationTickerLabel` table (never an empty string) so every
            // reserved/unfloated home badge draws its acronym
            // unconditionally, regardless of query timing -- see that
            // table's own doc comment.
            company?.ticker || stationTickerLabel(home.companyId),
            stationTickerColor(home.companyId),
            true,
          );
        });
      }

      // ---- Design note #134: PER-SLOT token placement. ----
      //
      // A 2-slot city draws a pill with one ring per slot, so a token has to
      // land ON a ring rather than at the pill's centre -- two tokens at the
      // centre of one pill stack on top of each other and hide a real,
      // decision-relevant fact (whether that city still has room).
      //
      // The chain records WHICH CITY a token is in (`station_tokens`,
      // backend Audit G-12) but not which SLOT, because a slot has no
      // meaning in the rules -- capacity is a count, and two tokens in one
      // city are interchangeable. So slot order is chosen here, by ascending
      // `company_id`. That is deterministic and identical on every client
      // and every re-render, which is the property that actually matters; it
      // just isn't authoritative about which physical circle a company
      // "owns", and nothing downstream should read it as though it were.
      const occupantsByCity = new Map<string, StationTokenCompany[]>();
      for (const company of publicCompanies) {
        if (!company.is_floated) continue;
        for (const [q, r] of company.station_token_hexes) {
          // Design note #251: the bucket key must match the index the draw
          // pass below resolves, or a company would be counted into one
          // city's occupants and drawn from another's slot list.
          const laid = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
          const cities = laid ? tileCitySlotCounts(laid.tile_id).length : 0;
          const city = tokenCityIndex(company, q, r) ?? (cities === 1 ? 0 : 0);
          const key = `${q},${r},${city}`;
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
          const laidTile = mapGrid.tiles.find((laid) => laid.q === q && laid.r === r);
          const chainCity = tokenCityIndex(company, q, r);
          const tokenCenter = axialToPixel(q, r, hexSize);

          let point: { x: number; y: number } | undefined;
          // Design note #151: the docking RADIUS, resolved from the same
          // artwork the slot position comes from. Left `undefined` on the
          // fallback path below, where there is no pill to dock into and
          // the legacy `size * 0.22` is the correct answer.
          let dockRadius: number | undefined;

          /* ==================================================================
           *  DESIGN NOTE 251: A PILL HAS SLOTS; DOCK INTO ONE
           * ==================================================================
           *
           * REPORTED BUG: a token placed on a double-station "pill" city
           * snaps to the exact centre of the pill instead of into one of its
           * circular slots.
           *
           * The slot machinery below has always been right. What gated it was
           * `chainCity !== undefined` -- `tokenCityIndex` returns `undefined`
           * whenever the chain omits `station_tokens`, which the sandbox does
           * and any contract predating Audit G-12 does. So every token on
           * every laid tile fell through to `stationMarkerPoint`, which
           * answers per HEX and therefore returns the pill's centre anchor.
           * Two companies sharing a 2-slot city stacked on the same point.
           *
           * The original caution behind that gate is real and is preserved:
           * on a genuinely TWO-CITY tile (#54/#62's New York, the OO tiles) a
           * guess about WHICH city would draw a token in the wrong station,
           * which is worse than drawing it centrally. But that risk does not
           * exist on a one-city tile -- #14, #15, #63 and every pill in the
           * game have exactly one city, so its index is 0 and there is
           * nothing to guess.
           *
           * So the inference is made only where it is not a guess: one city
           * means city 0, more than one means fall back exactly as before.
           */
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
            // A bucket longer than the city has slots means the chain and
            // this mirror disagree about capacity (see
            // `tileCitySlotCounts`' own note). Clamping to the last real
            // slot keeps the token visible and stacked rather than
            // vanishing, which is the more debuggable failure.
            point = slotPoints[Math.min(Math.max(slot, 0), slotPoints.length - 1)];
            // Only when a real slot point was found. If `slotPoints` came
            // back empty the token falls through to the per-hex anchor
            // below, and a docking radius there would shrink a token that
            // is not docked in anything.
            if (point) dockRadius = tileCityTokenRadius(laidTile.tile_id, hexSize);
          }

          // Fallback: a pre-G-12 chain, an unknown tile, or an untiled
          // preprinted city -- all cases where there is no per-slot answer
          // to be had, so the legacy per-hex anchor is the honest one.
          const resolved = point ?? stationMarkerPoint(q, r, hexSize, laidTile);
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

    // ---- Landmark labels, always on top. Font size responsively shrinks
    // (see design note #3b / `fitFontSize`) so the name never overflows
    // the hex's own flat-to-flat width or collides with the track above.
    // Item 3 (Three-Tier Local Deflection Stack): drawn in the hex's UPPER
    // third (negative offset), clear of the station circle locked at
    // absolute center and the terrain-cost slot in the lower third. Item 7
    // (Muted Base Text with Hover Glow): styling/hover-pop now handled by
    // `drawHexNameLabel`, shared with the gray/OO name pass below.
    // Universal Canvas Layout Engine (design note #55): a landmark's
    // nameplate anchor/format is now derived from its ARCHETYPE
    // (`archetypeForHex`), not a name check -- Boston/Baltimore
    // (SingleCity) get the shared Archetype A upper-left wedge anchor
    // (`singleNodeNameplateAnchor`), while New York (DoubleCity, per its
    // own real "two disconnected stations" `LANDMARK_TRACKS` shape) gets
    // the shared Archetype B dead-center anchor, splitting into the same
    // compact 2-line "A & B" stacked format the OO pass below uses whenever
    // a name actually contains " & " (dropping the ampersand) -- New York's
    // own name has no ampersand, so it renders as a single centered line,
    // but the ANCHOR POINT and formatting RULE are identical to every other
    // DoubleCity hex, not a special case of its own.
    for (const landmark of LANDMARK_HEXES) {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle -- station tokens/badges/tracks are all drawn by separate
      // passes above and are unaffected by this skip.
      if (!showCityNames) continue;
      // Dynamic City Nameplate Suppression (design note #47): once a real
      // tile is laid here, physical-board parity says its preprinted name
      // is covered -- see `hexHasLaidTile`'s own doc comment. The name
      // stays 100% available on hover (`describeHex`, extended this same
      // pass to cover every `NAMED_HEX_LABELS` city too, not just
      // landmarks/off-board zones).
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
      // Design note #53: Hex Boundary Clipping Mask, extended to nameplate
      // text -- `withHexClip` (design note #42) previously only wrapped
      // track-drawing calls; a nameplate positioned close to a hex's own
      // edge could still bleed its text into the neighboring hex. Now every
      // `drawHexNameLabel` call site is wrapped the same way.
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

    // ---- Pre-printed gray hex name labels (design note #12), also always
    // on top. Item 3 (Three-Tier Local Deflection Stack): UPPER third, same
    // as the landmark pass above. Item 7: styling/hover-pop via
    // `drawHexNameLabel`. Item 4 (Split Dual-City Labels): the four
    // `YELLOW_OO_HEXES` are deliberately EXCLUDED here -- a single centered
    // string through a hex with two independent stations is exactly what
    // item 4 asks to stop doing -- and get their own split-label pass right
    // below instead.
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
      // Design note #55: Universal Canvas Layout Engine -- every hex this
      // pass ever reaches (a real GRAY single-city hex, an ordinary white
      // `cityDesignation` hex, or a real GRAY single-town hex) resolves to
      // the SingleCity or SingleTown archetype, both of which share the
      // Archetype A upper-left wedge anchor (`singleNodeNameplateAnchor`) --
      // REPLACING the previous upper-CENTER anchor. Design note #70: now
      // dynamically slot-aware, see that function's own doc comment.
      const anchor = singleNodeNameplateAnchor(center, hexSize, mapGrid, hex.q, hex.r, claimedHexSlots);
      // Design note #53: Hex Boundary Clipping Mask, extended to nameplate
      // text -- see the landmark pass above for the full reasoning.
      withHexClip(ctx, center, hexSize, () => {
        drawSingleNodeNameplate(ctx, name, anchor, hexFlatWidth * 0.92, isHovered);
      });
    }

    // ---- Item 4 (Split Dual-City Labels), STACKED (design note #41), REPOSITIONED
    // to dead-center by design note #49: the four preprinted yellow "OO"
    // double-city hexes (Detroit & Windsor, Hamilton & Toronto, Dunkirk &
    // Buffalo, Philadelphia & Trenton) get TWO independent name labels
    // instead of one string through the center -- one line directly above
    // the other. Design note #49 moved this pass from the upper-third band
    // (shared with every other name label, `center.y - hexSize * 0.58`) to
    // TRUE HEX CENTER, per the OO Double-City Layout & Geometry Refactor's
    // explicit request: with the two station circles now on a top-right/
    // bottom-left diagonal (`ooCityMarkerOffset`, was left/right), the open
    // space actually available for a nameplate is the center of the hex,
    // between the two circles, not the upper third (which the top-right
    // circle now partly occupies). Reported for the original side-by-side
    // layout: each half squeezed into less than half the hex's own width
    // (`hexFlatWidth * 0.42`), which a longer name like "Philadelphia" or
    // "Hamilton" overflowed and visibly collided with -- unreadable.
    // Stacking instead gives each line the hex's (nearly) full width to
    // itself. Each half still independently uses `drawHexNameLabel` (item
    // 7's muted/hover-glow styling), and each half's own hover state is
    // judged by the SAME shared hex coordinate -- the two stations aren't
    // separately hoverable, only the hex as a whole is.
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
      // Design note #84: line spacing (`NAMEPLATE_LINE_HEIGHT_PX / 2`) is
      // now derived inside `drawStackedNameLabel` itself, from the SAME
      // constant design note #51 tuned here -- no longer computed at this
      // call site.
      // Design note #53: Hex Boundary Clipping Mask, extended to nameplate
      // text -- see the landmark pass above for the full reasoning.
      withHexClip(ctx, center, hexSize, () => {
        drawStackedNameLabel(ctx, [primaryName, secondaryName], center, lineMaxWidth, isHovered);
      });
    }

    // ---- Stacked Dual-Name Labels (design note #41), part 2: the three
    // double-town hexes -- Akron & Canton (G7), Reading & Allentown (G17),
    // New Haven & Hartford (F20) -- each name TWO independent town stops
    // sharing one hex, exactly the same "A & B" shape as the four OO
    // double-city hexes above, but previously still rendered as a single
    // un-split "A & B" string via the generic single-name pass above
    // (before this pass excluded `townDesignation === "double"` from it).
    // Split and stacked the identical way the OO pass just above is, for
    // the same readability reason.
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
      // Design note #84: line spacing now derived inside
      // `drawStackedNameLabel` itself -- no longer computed at this call
      // site (was design note #51's same font-size-relative spacing the
      // OO pass above also used).
      // Design note #54: Compact Stacked Nameplate Centering -- moved from
      // the upper-third band (`center.y - hexSize * 0.58 +/- lineOffset`,
      // shared with every single-name label) to TRUE HEX CENTER, mirroring
      // design note #49's identical repositioning for the OO pass just
      // above. Now that the two dit markers sit on the same diagonal
      // top-right/bottom-left layout OO uses (this same design note), true
      // center is the open channel between them, not the upper third (which
      // the top-right marker now partly occupies) -- so this pass no longer
      // needs its own separate "no station circles to clear" carve-out.
      // Design note #53: Hex Boundary Clipping Mask, extended to nameplate
      // text -- see the landmark pass above for the full reasoning.
      withHexClip(ctx, center, hexSize, () => {
        drawStackedNameLabel(ctx, [primaryName, secondaryName], center, lineMaxWidth, isHovered);
      });
    }

    // ---- Red off-board revenue zone labels ("Chicago", "Gulf", etc.) plus
    // ONLY the currently active era's value, now as a circular color-coded
    // badge rather than a second text plate (design note #22) -- see design
    // note #6 / OFFBOARD_LABELS. Same responsive font-fit treatment as the
    // landmark labels above. The name plate sits above center (pushed up
    // slightly further than before -- design note #22's "explicit offset
    // padding" ask) and the value badge sits below, so both stay clear of
    // the pre-printed track stubs (design note #10) converging toward
    // center. The FULL Yellow/Green/Brown progression is still available --
    // via the floating hover tooltip card drawn later in this function, see
    // design note #15/item 4.
    //
    // Factored into a small closure (design note #26/item 3) so the SAME
    // nameplate-plus-badge drawing can be pointed at an arbitrary center --
    // needed below to draw Gulf's single merged nameplate at the I1/J2
    // midpoint instead of twice, once per hex, like every other zone here.
    //
    // Design note #78: name line(s) and revenue badge are now computed and
    // laid out as ONE combined block, anchored so the BLOCK's own vertical
    // center (not each piece independently) lands on `center` -- REPLACING
    // the previous two fixed hex-relative offsets (name pinned `hexSize *
    // 0.42` above center, badge pinned `hexSize * 0.44` below, regardless of
    // whether the name was one line or two). The badge sits a small
    // proportional gap directly beneath the name block. Also picks up the
    // shared white translucent shield (`NAMEPLATE_SHIELD_FILL`/`_HOVERED`)
    // and the standardized regular-weight `NAMEPLATE_FONT_SIZE_PX`/`_MIN_PX`
    // scale, same as every other nameplate on the board.
    const drawOffboardNameplate = (
      center: { x: number; y: number },
      offboardName: string,
      isHovered: boolean,
    ) => {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle gates ONLY the name text -- the value badge below is drawn
      // unconditionally, per that item's explicit "maintaining ... revenue
      // badges" requirement (so a hidden-name hex still shows a
      // badge-only block, centered on the hex).
      //
      // Design note #83: wraps onto two stacked lines ONLY for "Maritime
      // Provinces" -- the one explicitly named exception, too long to fit
      // its single hex on one line despite naming only one place -- via
      // `offboardNameplateLines` below. Every other off-board zone name
      // ("Chicago", "Gulf", "Canadian West", "Deep South") now stays a
      // single line, REVERSING #47's old "every multi-word name wraps"
      // rule: per explicit request, wrapping is reserved for names that
      // either denote two separate cities (an ampersand -- none of this
      // file's off-board zones have one) or are this one named exception.
      const nameLines: readonly string[] = showCityNames ? offboardNameplateLines(offboardName) : [];
      const nameBlockHeight = nameLines.length * NAMEPLATE_LINE_HEIGHT_PX;

      const tiers = OFFBOARD_REVENUE[offboardName];
      // Design note #66: `$` prefix DROPPED, same reasoning as
      // `drawValueBadge`'s own comment.
      const activeValue = tiers ? `${offboardValueForEra(tiers, currentEra)}` : "";
      // Design note #63/#64/#65/#66: Text-Driven Badge Sizing -- see
      // `drawValueBadge`'s own comment for the shared font/padding/floor
      // reasoning behind this exact formula. Badge text stays BOLD --
      // design note #78 scopes the regular-weight typography change to
      // nameplate TEXT, not revenue/terrain-cost badge figures.
      const offboardFontSizePx = Math.max(9, hexSize * 0.24) - 1;
      let badgeRadius = 0;
      if (tiers) {
        ctx.font = `bold ${offboardFontSizePx}px ${FONT_FAMILY_STACK}`;
        badgeRadius = badgeRadiusForLabel(ctx.measureText(activeValue), offboardFontSizePx, "square", 2, 1.5, 5);
      }
      const badgeDiameter = badgeRadius * 2;
      // Small proportional gap between the badge's own bottom and the name
      // block's own top (design note #85 flipped which sits on top) --
      // only when BOTH are actually present, so a name-only (era has no
      // revenue -- doesn't happen today, but kept correct) or badge-only
      // (`showCityNames` off) block doesn't carry a stray empty gap.
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

      // Design note #84: a 2-line name (only "Maritime Provinces", per #83)
      // draws through `drawStackedNameLabel` for its ONE shared background
      // shield, instead of each line painting its own box independently
      // (the overlap-darkening seam that fixed). A 1-line name (every other
      // off-board zone, now, per #83) draws through the ordinary
      // `drawHexNameLabel`, same as every on-board single-line nameplate.
      // Design note #85: now positioned at `nameBlockStart` (beneath the
      // badge), not at `blockTop` (was the top of the block).
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

    // ---- Gulf's and Canadian West's single merged nameplates (design note
    // #26/item 3, generalized by item 9) -- drawn once, at the midpoint
    // between each zone's two hex centers, instead of the per-hex loop
    // above's usual one-nameplate-per-hex treatment. Matches the merged
    // single-region border stroke drawn in the static board background pass
    // above. Deliberately NOT wrapped in a single-hex `withHexClip` (design
    // note #55's otherwise-universal clipping requirement) -- the midpoint
    // sits ON the shared border between the two real hexes this nameplate
    // spans, by design (the same "merged region" treatment
    // `GULF_HIDDEN_EDGE`/`CANADIAN_WEST_HIDDEN_EDGE` gives their shared
    // border stroke above); clipping to either ONE hex's boundary alone
    // would incorrectly slice the text in half instead of protecting it.
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

    // ---- Terrain build-cost labels (design note #9, RELOCATED here by
    // design note #55's Strict Canvas Layering Hierarchy -- Layer 4/text
    // content, drawn after every Layer 1-3 pass rather than immediately
    // after the Layer 1 terrain icon that used to sit right next to it).
    // RECOLORED by design note #68: solid red box + white text (was the
    // same tier-colored shield box every other text element on the board
    // uses, `nameplateBoxFillFor`) -- reported: terrain costs needed to
    // read as visually distinct from revenue badges (#62-#66's white
    // squares), and a red box unambiguously reads as "cost," not
    // "revenue." Tight 2px padding/radius unchanged.
    for (const hex of STATIC_BOARD_HEXES) {
      if (hex.type !== "Mountain" && hex.type !== "River") continue;
      // Design note #150, and this one is a CORRECTNESS fix rather than a
      // cosmetic one.
      //
      // `hexmap.rs`'s `execute_lay_tile` charges terrain from the hex, once:
      //
      //     let effective_terrain_cost =
      //         if is_upgrade { Uint128::zero() } else { terrain_build_fee(q, r) };
      //
      // with the stated rule "a hex's printed terrain fee is paid exactly
      // once, when that hex is first built on -- every later colour upgrade
      // of the same hex is free". So once this hex carries a tile, the $80
      // or $120 on the badge is not what the next lay costs. It is what the
      // LAST one cost, rendered as though it were a live price.
      //
      // Design note #136 established that this label and the contract's fee
      // must be the same lookup. Keeping the badge after the first lay broke
      // that guarantee in the one direction #136 could not see: the lookup
      // was right, the precondition was not.
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const terrainType = hex.type;
      // Design note #136 (F-2): the printed figure comes from the
      // coordinate-keyed mirror of `hexmap::terrain_build_fee`, so the label
      // on the board and the fee the contract charges are the same lookup.
      const terrainFee = terrainBuildFeeAt(hex.q, hex.r);
      if (terrainFee <= 0) continue;
      const costLabel = String(terrainFee);
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #87: GENERALIZED past the old DoubleCity-only
      // `isDoubleCityHex` check -- see the terrain-icon pass above's own
      // comment for why (SingleCity `cityDesignation` River hexes like
      // Toledo/Providence/Washington, D.C. needed the same treatment and
      // weren't getting it). This is the SAME `isComplexHex` test that
      // pass uses, so the two always agree on which hexes are complex.
      const isComplexHex =
        archetypeForHex(mapGrid, hex.q, hex.r) !== "Plain" ||
        liveEdgesForHex(mapGrid, hex.q, hex.r).length > 0;
      // Design note #70 (13-Slot Perimeter Anchor System): Item 3's old
      // fixed "lower third" / "bottom-right quadrant" literals are now
      // resolved through the shared slot engine per Requirement 4 ("Tile
      // IDs... anchor along open outer edge faces such as the bottom
      // vertex or lower edge margins, clear of track entry points") --
      // terrain cost labels are the closest existing on-board element to
      // that description (see this task's closing summary for why no
      // actual tile-ID number is rendered on the board today), so they're
      // the one refactored against it. Default (simple hex) prefers the
      // true BOTTOM POINT (slot 10, straight down -- byte-identical
      // direction to the old fixed `{x: center.x, y: center.y +
      // hexSize*0.58}`, so the overwhelmingly common unblocked case looks
      // unchanged), then the two lower edges (4/SW, 3/SE), then the two
      // lower corners as a last resort. Any complex hex keeps its own
      // distinct bottom-RIGHT preference by starting at the SE edge (slot
      // 3) instead of the bottom point.
      // Design note #87: this is now the ONLY slot claim for a complex
      // hex's terrain icon+cost -- REPLACES the old two-claim split (one
      // here, a separate one in the icon pass above) with a SINGLE
      // `claimHexSlot` call for the whole compound badge. A simple hex's
      // claim is unchanged from before.
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
      // Design note #122: the compound [icon+cost] badge's own anchor,
      // offset at `0.65` instead of the plain cost box's `0.58` above --
      // matches `drawValueBadge`'s own `REVENUE_BADGE_OFFSET` (design note
      // #109) exactly, per direct request to give the (recently shrunk,
      // design note #121) compound badge the same offset treatment the
      // revenue badge already has. Scoped to ONLY the compound badge --
      // `point` above (the plain-hex cost box's own anchor) is untouched,
      // same "only the compound badge" scope #121's own shrink used.
      const COMPOUND_BADGE_OFFSET = 0.65;
      const compoundBadgePoint = {
        x: center.x + costDirection.x * hexSize * COMPOUND_BADGE_OFFSET,
        y: center.y + costDirection.y * hexSize * COMPOUND_BADGE_OFFSET,
      };
      withHexClip(ctx, center, hexSize, () => {
        if (isComplexHex) {
          // Design note #87: ONE compound [icon+cost] pill, REPLACING the
          // plain cost-only box below for every complex hex -- the
          // standalone icon pass above already skipped drawing anything
          // for this hex, so this is the ONLY place its terrain icon
          // renders at all.
          drawTerrainCompoundBadge(ctx, terrainType, costLabel, compoundBadgePoint, hexFlatWidth * 0.85);
          return;
        }
        // Design note #68: font dropped 1pt (base `9` instead of `10`) as
        // part of the same terrain-cost-vs-revenue-badge distinction pass.
        // Design note #92: dropped another 1pt (base `8`) on top of #91's
        // tightened box padding (kept, not reverted) -- per direct request,
        // both changes now apply together.
        // Design note #95: raised back 1pt (base `9`) now that the `$`
        // prefix is gone (#94) -- freed-up horizontal room lets the number
        // read at its original size again.
        // Design note #99: raised another 1pt (base `10`), per direct
        // request.
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

    // ---- City/town route-value badges (design note #26/item 5) -- a
    // small, color-coded $-value plate next to every printed destination
    // city/town circle: the three landmark cities, every pre-printed gray
    // hex city/town marker, every yellow "OO" hex, and any laid
    // SmallTown/MajorCityHub tile. FACTUAL NOTE (see design note #26): the
    // request that asked for this called the value "phase-dependent...
    // based on the current game phase tier," but `terrainBaseValue` (this
    // file's mirror of the actual `hexmap::terrain_base_value` rule
    // `RunManualRoute`'s payout math uses) is flat and terrain-only -- a
    // hex's value never changes as the game advances through color tiers.
    // The two example numbers that request gave ($10 towns / $20 base
    // cities) DO match this flat table, so they're used here verbatim; a
    // second, era-varying value for the same hex was NOT implemented,
    // since the backend has no such rule to mirror (unlike the off-board
    // zones' badges above, which genuinely are era-tiered).
    // Design note #35/items 2-3: a hex listed in `HEX_START_VALUE_OVERRIDE`
    // uses its real sourced $ figure instead of the flat terrain default --
    // and if that real figure is exactly `$0` (the four `YELLOW_OO_HEXES`,
    // and all eight `cityDesignation` hexes), the badge is skipped
    // entirely rather than drawn showing "$0", per this item's own "fully
    // hiding or removing" instruction. `undefined` (a hex absent from the
    // override table entirely) falls through to `drawValueBadge`'s own
    // unchanged flat-by-terrain default.
    for (const landmark of LANDMARK_HEXES) {
      // Design note #133: same yield as the track pass above, and for the
      // same reason one step further on -- `HEX_START_VALUE_OVERRIDE` is
      // this hex's PRINTED starting value. Once a tile is laid, the tile's
      // own chain revenue is the figure that pays (a laid #62 pays $90, not
      // New York's printed starting value), and the laid-tile badge loop
      // below now prints it.
      if (hexHasLaidTile(mapGrid, landmark.q, landmark.r)) continue;
      const override = HEX_START_VALUE_OVERRIDE[landmark.label];
      if (override === 0) continue;
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      // ADAPTIVE PLACEMENT (see `drawValueBadge`'s own doc comment): this
      // landmark's own real printed track edges, flattened out of
      // `LANDMARK_TRACKS`'s per-segment shape -- exactly the data that lets
      // New York's badge dodge its NE stub (edge 1) instead of sitting on
      // top of it, which is the G19 collision this pass was reported for.
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
      // REVERTED (this pass, "Only Real-Track Towns Show Revenue" --
      // reported: every blank Town/Double-Town-designated hex shows a
      // revenue badge, when only the three hexes with REAL pre-printed
      // track -- Kingston C15, Atlantic City I19, Fall River F24, the
      // `GRAY_HEXES`/`grayTrack.marker !== "none"` branch above -- should).
      // The item 1 fix this reverts gave every blank `townDesignation` hex
      // (London E7, Burlington B20, Flint D4, Erie F10, Akron & Canton G7,
      // Reading & Allentown G17, New Haven & Hartford F20 -- see
      // `TOWN_DESIGNATED_HEXES`'s own doc comment in `hexmap.rs` for the
      // full sourcing) the same flat SmallTown/DoubleTown badge as a REAL
      // printed town, even though these seven have no printed track at all
      // -- a bare town PLACEHOLDER, not a scored destination, until a
      // player actually lays a real tile there. `hexRouteValue`'s own
      // matching fallback (used by the hover tooltip) is fixed the same way
      // just below. The backend (`pathfinding::effective_tile_and_value`)
      // was independently verified to already treat these seven correctly
      // -- `gray_preprinted_name_at` only ever matches the twelve REAL gray
      // hexes (the six cities, C15/I19/F24, and the three bare connectors),
      // never these seven blank placeholders, so a route can't pass through
      // or score value at one of them until a real tile is laid; this was a
      // frontend-only display bug, nothing to change on-chain.
      // Design note #34/item 2, values corrected by design note #35/item 3:
      // the blank single-CITY-designated hexes' real printed value is $0
      // (bare `city`/`city=revenue:0` source entries, no track), so their
      // badge is skipped entirely -- `override` is always exactly `0` for
      // every one of these eight hexes (see `HEX_START_VALUE_OVERRIDE`).
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
      /* ==================================================================
       *  DESIGN NOTE 288: THE LANDMARK HUBS UPGRADE LIKE ANYTHING ELSE
       * ==================================================================
       *
       * REPORTED: G19's green upgrade has no revenue badge.
       *
       * `NewYorkHub` and `BostonHub` were deliberately excluded here, on
       * the reasoning recorded below: "both terrains only ever occur at a
       * LANDMARK_HEXES hex, which the landmark badge pass always catches
       * first". That was true when written and stopped being true one
       * design note later -- #133 made the landmark pass YIELD as soon as a
       * tile is laid, precisely so the laid tile could draw its own badge.
       *
       * Which left the two hub terrains falling between the passes: the
       * landmark pass stood aside for the tile, and the tile pass did not
       * accept the terrain. Lay tile #54 on G19 and its $60 vanished --
       * every other upgrade on the board gained a badge and the busiest hex
       * in the game lost one.
       *
       * `drawValueBadge`'s parameter is widened to match rather than the
       * terrains being mapped onto a narrower lookalike: a NewYorkHub is
       * not a DoubleCityHub, and pretending otherwise to satisfy a type
       * would be the kind of near-enough this file's notes keep unpicking.
       */
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
      // design note #49: `BostonHub`/`NewYorkHub` are deliberately NOT
      // added to the allow-list above (even though they're now real
      // `TerrainType` members, closing the gap described in that type's own
      // doc comment) -- both terrains only ever occur at a `LANDMARK_HEXES`
      // hex, which the `landmarkAt` skip just below always catches first,
      // and `drawValueBadge`'s own `terrain` parameter is intentionally
      // typed to the narrower `SmallTown | DoubleTown | MajorCityHub |
      // DoubleCityHub` union it's always accepted -- widening the allow-list
      // above would widen `catalogEntry.terrain`'s narrowed type past what
      // `drawValueBadge` accepts for no functional benefit (this branch is
      // unreachable for a landmark hex either way).
      // Design note #133: no longer skipped for a landmark hex. The
      // landmark badge pass above now yields whenever a tile is laid, so
      // exactly one badge is drawn either way -- the printed value while the
      // hex is bare, the chain's `MapTileEntry.revenue` once it is not.
      const center = axialToPixel(tile.q, tile.r, hexSize);
      // Local `const` so the allow-list narrowing above (`catalogEntry.terrain
      // !== ...`) survives being read inside the `withHexClip` closure below
      // -- TS does not carry property-access narrowing across a function
      // boundary, only a local variable's.
      const terrain = catalogEntry.terrain;
      // ADAPTIVE PLACEMENT (see `drawValueBadge`'s own doc comment): this
      // laid tile's actual live edges at its current orientation -- the
      // same `rotateConnections`/`liveEdges` pair `drawTrackPath` itself
      // uses to draw the real track, so the badge dodges exactly what's
      // actually drawn, not the tile's unrotated base artwork.
      const tileEdges = liveEdges(rotateConnections(catalogEntry.connections, tile.orientation));
      // Design note #132: THE revenue figure, read off `MapTileEntry.revenue`
      // -- `hexmap::tile_base_value`, the same call `pathfinding::HexInfo`
      // and `operations::execute_run_manual_route` price a route through.
      // What is printed here is therefore what the contract will actually
      // pay, by construction. It is no longer computed on the frontend at
      // all; `drawValueBadge`'s existing `valueOverride` parameter is the
      // channel, so nothing about badge placement or styling changes.
      const chainRevenue = chainTileRevenue(tile);
      // `0` is a real chain answer -- plain connector track pays nothing --
      // and a `$0` badge is noise, so suppress it. `undefined` (a pre-G-11
      // contract) keeps the old terrain-bucket fallback by passing through.
      if (chainRevenue === 0) continue;
      withHexClip(ctx, center, hexSize, () => {
        drawValueBadge(ctx, center, tile.q, tile.r, terrain, hexSize, chainRevenue, tileEdges, claimedHexSlots);
      });
    }

    // ---- Canonical Tile Upgrade Restriction badges ("B"/"NY"/"OO", design
    // note #47, REVISED by design note #49, mirroring `hexmap.rs` module
    // doc comment #26/#27): Boston AND Baltimore each get a "B" corner
    // badge (Baltimore added by #49 -- real 1830 prints the "B" label on
    // both hexes, not just Boston, see #27's own Verification Status
    // paragraph), New York gets "NY", and each of the four
    // `YELLOW_OO_HEXES` gets "OO" -- see `drawRestrictionBadge`'s own doc
    // comment for the fixed-corner-and-plain-text styling. Drawn right
    // after the landmark name pass, so it layers on top of the printed
    // track/station circle beneath it but stays visually distinct from the
    // (possibly now-suppressed) name label above center.
    //
    // PERSISTENCE (design note #49, REVERSING #47): #47 gated both loops
    // below on `!hexHasLaidTile`, hiding each badge once its hex was tiled.
    // This request explicitly asks these labels to "remain visible across
    // ALL tile upgrade phases (un-tiled preprinted hexes, yellow tiles,
    // green tiles, and brown tiles)" -- the opposite of #47's own framing
    // ("before tiles are laid"). Both `hexHasLaidTile` checks are removed
    // outright; #47 itself is left in place, unedited, as the historical
    // record of the original (now-superseded) decision, per this file's own
    // convention of never silently deleting a prior pass's reasoning.
    for (const landmark of LANDMARK_HEXES) {
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      const archetype = archetypeForHex(mapGrid, landmark.q, landmark.r);
      // Badge TEXT content ("B" vs "NY") is genuine per-hex DATA (which
      // letter a real landmark prints), read the same structural way
      // `archetypeForHex` itself classifies the hex -- not a separate name
      // check -- so a DoubleCity landmark always gets "NY" and a
      // SingleCity landmark always gets "B", by construction.
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

    /* ---- Design note #318: private company reservations. -------------
       Drawn after the printed restriction badges and before the station
       token pass, which puts it in the same band as every other
       game-state-derived mark: above the cardboard, below the pieces.

       NOT clipped to the hex. Every pass above is, because printed artwork
       belongs inside its own hex -- but this is a marker sitting on the
       board, and a pill wide enough to carry "C&SL" legibly would be sliced
       by the boundary at the smaller zoom levels. It is the only mark here
       allowed to overhang, which is also what makes it read as a piece. */
    // `forEach` rather than `for...of` over `.values()`: this build targets
    // ES5 without `--downlevelIteration`, so iterating a Map's iterator does
    // not compile. Same workaround the Set spreads in this file use.
    reservations.forEach((reservation) => {
      const center = axialToPixel(reservation.q, reservation.r, hexSize);
      drawReservationBadge(ctx, center, hexSize, reservation.initials, reservation.slot);
    });

    // ---- Impassable border edges (design note #38): a fixed set of four
    // board crossings (E7/F8, D12/C11, D12/C13, C17/B16) across which track
    // may never be built, marked with a thick red bar. Drawn after every
    // tile/badge pass above so the bar is never hidden underneath a laid
    // tile's own track or fill, but before the live preview ghost tile
    // below, so a player actively previewing a placement there still sees
    // their own tentative track on top.
    for (const border of IMPASSABLE_BORDER_EDGES) {
      const center = axialToPixel(border.q, border.r, hexSize);
      drawImpassableBorderEdge(ctx, center, hexSize, border.edge);
    }


    // Design note #222: tokens go on last, above every badge and nameplate.
    drawStationTokenPass();

    /* ==================================================================
     *  DESIGN NOTE 367: THE VEIL IS GONE
     * ==================================================================
     *
     * REPORTED: during Lay Track the entire map dims, for all players. It
     * is visually confusing and unnecessary.
     *
     * Design note #223 introduced it to answer a real bug -- "players can
     * click anywhere to lay track" -- by making unreachable hexes read as
     * unreachable. It over-answered. Two things were wrong with it:
     *
     *   IT DIMMED THE BOARD FOR EVERYONE. The veil is drawn from
     *   `layFocus`, which describes ONE corporation's reach, and every
     *   player at the table sees the same canvas. So three of four players
     *   watched the map grey out for a restriction that was not theirs and
     *   could not act on it either way.
     *
     *   IT SUPPRESSED THE BOARD TO EMPHASISE A SUBSET. An 1830 player
     *   reading the map during a tile lay is looking at the whole network
     *   -- where rivals are, where the route wants to go next -- and the
     *   veil took that away at the moment it was most wanted, to mark
     *   something the glow already marks.
     *
     * WHAT REMAINS is design note #252's outer glow on the legal hexes, in
     * the acting corporation's own colour. That is ADDITIVE: it draws the
     * eye to the legal set without taking the rest of the board away, and
     * it is the half of the pair that was doing the work.
     *
     * THE CLICK GATE IS UNAFFECTED. `layFocus.highlighted` still decides
     * which hexes open the picker (see `handlePointerUp`), so the original
     * "click anywhere" bug stays fixed -- it was always enforced by the
     * set, never by the dimming. */
    if (layFocus) {
      for (const hex of STATIC_BOARD_HEXES) {
        const key = `${hex.q},${hex.r}`;
        const center = axialToPixel(hex.q, hex.r, hexSize);

        /* Design note #377: dimmed only for the player on turn, and only
           the hexes outside their reach. `visible` carries the network as
           well as the legal targets (design note #241), so the route an
           extension joins stays lit alongside the placements. */
        if (layFocus.dim && !layFocus.visible.has(key)) {
          ctx.save();
          ctx.globalAlpha = LAY_TRACK_DIM_ALPHA;
          ctx.fillStyle = LAY_TRACK_DIM_INK;
          drawHexPath(ctx, center, hexSize);
          ctx.fill();
          ctx.restore();
          /* NOT `continue`. Design note #367 deleted the veil and with it
             the early-exit that used to sit here, and the exit was a second
             bug in its own right: a hex could be dimmed OR glowed, never
             both. A legal target is always inside `visible`, so the two
             never actually collided -- but the structure said they might,
             and falling through means the glow below is reached on every
             hex regardless of what this branch did. */
        }

        /* ==================================================================
         *  DESIGN NOTE 252: AN OUTER GLOW, NOT A RING WITH A SHADOW
         * ==================================================================
         *
         * REPORTED BUG: the legal-placement highlight is a thick solid green
         * border with no actual glow.
         *
         * Two things made it read that way, and the second is the one that
         * mattered.
         *
         *   THE LINE WAS TOO HEAVY. `hexSize * 0.13` is wider than the track
         *   artwork itself (`0.12`), so whatever the alpha, the eye read it
         *   as a drawn border. It is now `hexSize * 0.02` -- a reduction of
         *   roughly 85%, floored at one pixel so it never vanishes at small
         *   zoom.
         *
         *   THE SHADOW BLOOMED BOTH WAYS. `ctx.shadowBlur` spreads a halo
         *   symmetrically, so half of every "glow" was painted INSIDE the
         *   hex, over the cardboard. Inward bloom on a hex-sized ring fills
         *   the hex -- which is exactly what turns a glow into a solid tint,
         *   and then reads as a border with a muddy interior rather than as
         *   light coming off an edge.
         *
         * A true outer glow needs the inside masked. The clip below is a
         * generous rect MINUS this hex, built as one path and clipped
         * `evenodd`; stroking the hex through it discards everything on the
         * inward side and leaves only the halo escaping outward. That is
         * what a glow is -- light spilling out of a shape, not a ring drawn
         * around it.
         *
         * THE COLOUR IS THE CORPORATION'S, matching the action toolbar and
         * the route line so "PRR is acting" is one colour across the screen
         * -- with a fallback for a brand colour too dark to register as
         * light, since a glow that cannot be seen is not a glow.
         *
         * Design note #367 removed the veil this used to be seen against,
         * which makes the glow the ONLY guide to the legal set. The three
         * falloff passes below matter more for that reason, not less: it
         * now has to carry the signal alone. */
        if (layFocus.highlighted.has(key)) {
          const glow = layFocus.glowColor ?? LAY_TRACK_HIGHLIGHT_INK;
          ctx.save();

          ctx.beginPath();
          ctx.rect(center.x - hexSize * 4, center.y - hexSize * 4, hexSize * 8, hexSize * 8);
          drawHexPath(ctx, center, hexSize);
          ctx.clip("evenodd");

          ctx.strokeStyle = glow;
          ctx.shadowColor = glow;
          ctx.lineWidth = Math.max(1, hexSize * 0.02);
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

    // ---- Live preview tile, drawn last so it sits on top of everything.
    //
    // DESIGN NOTE 167: FULLY OPAQUE, and the ghost styling is gone.
    //
    // It used to render at `globalAlpha = 0.65` so it would "clearly read as
    // a not-yet-confirmed preview". That reasoning came from a flow where
    // the preview was the ONLY signal that something was pending -- there
    // was no explicit confirm, so the tile itself had to look tentative.
    //
    // The radial selector changed that: a green check and a red X float
    // directly above the hex whenever a preview is live, and nothing is
    // committed until the check is pressed. The pending state is stated by
    // a control, not implied by transparency -- and transparency was
    // costing the one thing the preview exists for. At 0.65 the board
    // colours underneath bled through the tile, which on the new saturated
    // palette turned a yellow tile over a green hex into a muddy third
    // colour and made the track hard to trace against its neighbours. The
    // whole point of an in-situ preview is judging whether the tile FITS,
    // and it was being judged through a veil.
    //
    // The DASHED outline stays. It is the cheap half of the old signal --
    // it costs no legibility, keeps working for anyone who cannot see the
    // buttons (they sit above the hex, which may be off-screen on a panned
    // board), and matches this renderer's existing idiom for provisional
    // artwork.
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
          // No query paths to pass (design note #119): `previewTile` is a
          // ghost of a tile the player is CONSIDERING, built client-side by
          // `TileSelectionPopup` from a `GetLegalTilePlacements` pairing --
          // it isn't on the board, so no `MapTileEntry` describes it.
          // `pathsForTile` falls back to the catalog mirror, which is why
          // the mirror had to carry `paths` too: a previewed double-town
          // must draw identically to the same tile once it is laid.
          drawTrackPath(ctx, previewCenter, hexSize, previewCatalogEntry, previewTile.orientation);
        });
      }
      ctx.restore();
    }

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
        // Point the card back toward the board's own interior (see
        // `drawOffboardTooltip`'s "ADAPTIVE QUADRANT" doc comment) rather
        // than always up-right, so zones near the top/right edge (Canadian
        // West, Maritime Provinces) get room to render instead of clipping
        // off the visible canvas.
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
    // Design note #223: the veil is part of the picture, so a change to the
    // reachable set has to repaint. Omitted, the board would keep the
    // dimming from whichever corporation was acting when it was last drawn.
    layFocus,
    // `mapGrid`, not `mapGrid.tiles` (react-hooks/exhaustive-deps).
    //
    // The body reads the WHOLE object, not just the array: `hexHasLaidTile`,
    // `archetypeForHex`, `liveEdgesForHex`, `hexBlockedSlots` and
    // `singleNodeNameplateAnchor` all take `mapGrid` itself. Depending only
    // on `.tiles` was a narrower key than the closure actually needs, which
    // is the definition of a stale-closure hazard: any change to `mapGrid`
    // that did not also replace `.tiles` would leave this callback painting
    // from the previous board.
    //
    // It costs nothing to widen. A live `GetMapGrid` response is freshly
    // parsed per poll, so `mapGrid` and `mapGrid.tiles` get new identities
    // together -- the narrow key only ever helped in the one case where a
    // parent reuses the tiles array inside a new wrapper object, which no
    // caller does.
    //
    // WHY THIS WAS INVISIBLE: `App.tsx` currently supplies
    // `useMemo(() => MOCK_MAP_GRID, [])` -- a frozen mock that never changes
    // at all, so neither the stale read nor any extra repaint could be
    // observed. The hazard only becomes real when this is wired to the live
    // poll, which is exactly when it would have been hardest to diagnose.
    //
    // NOTE FOR CALLERS: pass a STABLE `mapGrid` reference (memoised or
    // straight from the polling hook). An object literal built inline in JSX
    // gets a new identity every render and would repaint the canvas on every
    // render of the parent.
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

  // BUG FIX ("Tab-Switch Shrink" -- reported: returning to the Rail Map tab
  // after visiting another tab renders the board shrunk, fixed only by
  // manually clicking "Fit to Screen"). This used to be a ONE-SHOT auto-fit
  // effect (guarded by `hasAutoFitRef`, empty deps, "must run exactly once")
  // that snapped `view` to `fitView` a single time on mount. That's the bug:
  // `App.tsx` fully unmounts/remounts this component on every Rail Map <->
  // Stock Market tab switch (a plain ternary, not a CSS display toggle), so
  // "on mount" happens on every single return trip, not just first page
  // load -- and on this component's very first render after each such
  // mount, `width` is still seeded with the small `DEFAULT_WIDTH` fallback,
  // because the `ResizeObserver` above hasn't reported its real, larger
  // measurement yet (that callback fires asynchronously, after this
  // synchronous first paint). The one-shot effect fired at that exact
  // moment, captured a `fitView` computed from the too-small fallback
  // width, and then never ran again -- so `view` stayed locked to that
  // stale shrunk fit even after `measuredSize`/`width`/`fitView` corrected
  // themselves moments later once the `ResizeObserver`'s real reading
  // arrived. Clicking "Fit to Screen" happened to fix it only because that
  // handler independently re-reads the CURRENT `fitView` at click time.
  //
  // Fixed by re-running on every `fitView` change instead of once -- this
  // is also just what design note #13's own stated invariant already
  // claims ("with detailedView === false, `view` is always exactly
  // `fitView`"), now actually enforced continuously instead of only at two
  // isolated trigger points (mount, and toggling detailed view off).
  // Gated on `!detailedView` so it never fights a player's own free pan/
  // zoom while inspecting details; `handlePointerMove`/`handleWheel`
  // already independently no-op pan/zoom mutations at that baseline (see
  // design note #13), so this effect is the only writer to `view` while
  // `detailedView` is false, and cannot loop (`fitView` itself doesn't
  // depend on `view`).
  useEffect(() => {
    if (detailedView) return;
    setView(fitView);
  }, [fitView, detailedView]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      // Always tracked, even at the locked 100% baseline (design note #13)
      // -- `dragStateRef` doubles as the click-vs-drag distance check
      // `handlePointerUp`'s click interceptor (design note #7) relies on,
      // so a genuine click must still register at baseline even though the
      // pan itself is disabled there (see `handlePointerMove` below).
      dragStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originPanX: view.panX,
        originPanY: view.panY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [view.panX, view.panY],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      // Off-board hover tracking (design note #15/item 4) -- runs on EVERY
      // pointer move, independent of drag/`detailedView` state, so the
      // tooltip works even at the locked 100% baseline and even when no
      // button is pressed at all (ordinary hover, not a drag gesture).
      // Reuses the SAME transform-undo math `handlePointerUp`'s click
      // interceptor already uses to convert a raw pointer position into an
      // axial `(q, r)`.
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

      /* ==============================================================
       *  DESIGN NOTE 380 (pointer half): THE LINE, NOT THE HEX
       * ==============================================================
       *
       * `drawRouteOverlays` returns the exact stroke geometry it painted,
       * so "is the pointer on this route" is a question about the curve
       * rather than about the hex containing it. Two trains sharing a hex
       * now resolve to whichever line is actually under the cursor, which
       * is the case design note #374 had to give up on.
       *
       * THE TRANSFORM, THE PEN AND THE POINT SPACE all have to match the
       * draw, and the argument for each is long enough that it lives with
       * the draw rather than here -- see `hitTestRoutes` and design note
       * #381 in `hexCanvasPrimitives.ts`. This handler's job is to supply
       * the pointer, the view and the device ratio.
       *
       * NO HEX FALLBACK when the paths exist. Hovering inside a hex but
       * not on any line now highlights nothing, and that is correct: the
       * whole point is that the hex is no longer the unit. The fallback
       * survives only for the case where the mechanism itself is missing
       * (`DOMMatrix`, checked at draw time), where hex-grained hover is
       * better than none. */
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

      // Active coordinate + value hover tooltip (design note #21, enriched
      // by design note #26/item 2) -- `describeHexWithValue` builds on
      // `describeHex` (still used, unchanged, by the click interceptor) so
      // the tooltip's naming still matches this file's one existing
      // hex-naming convention, with a "(Value: $X)" suffix appended. Only
      // shown over a real hex of the authentic board (a landmark or a
      // `STATIC_BOARD_HEXES` entry); the plain charcoal workspace outside
      // the board (design note #18) shows no tooltip at all.
      const hoveredLandmark = LANDMARK_HEXES.find((l) => l.q === hoverQ && l.r === hoverR);
      // Design note #269: a picker is open on a hex -- it owns the anchor.
      if (suppressHoverTooltip) {
        cancelTooltipTimer();
        setHoveredCoordLabel((prev) => (prev === null ? prev : null));
      } else if (hoveredLandmark || hoveredBoardHex) {
        // Design note #75: flip toward whichever side of the PANEL (this
        // canvas's own `rect`, already computed above for the hex-hit-test)
        // still has room, mirroring `drawOffboardTooltip`'s own adaptive
        // quadrant logic -- `cssX`/`cssY` are the cursor's position relative
        // to the canvas's own top-left corner, so comparing them against
        // half the canvas's own width/height (not `window.innerWidth`/
        // `innerHeight`) keeps this correct even when the canvas doesn't
        // fill the whole browser viewport.
        /* Design note #365: everything the panel needs is captured NOW and
           shown later. Reading `event` inside the timeout would be a use
           after React has pooled it, and re-deriving the hex would risk
           describing whatever is under the pointer two seconds later
           rather than the hex the player actually stopped on. */
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
      // Design note #13: pan is only live in detailed view -- at the locked
      // 100% baseline, pointer movement is still tracked above (so
      // `handlePointerUp`'s click-vs-drag distance check, and therefore the
      // click interceptor, keeps working) but never actually updates
      // `view.panX`/`panY`.
      if (!detailedView) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      // Design note #8: rigid boundary clamping on drag displacement --
      // `clampPanToBoard` stops the raw drag-following pan the instant it
      // would pull the board's own edge past the viewport edge, rather
      // than letting the map drift into empty canvas space and relying on
      // the user to notice and drag back.
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
      // Design note #138: `mapGrid` and `currentEra` added. The comment that
      // stood here previously acknowledged both were missing and deferred
      // them as "out of scope"; they are in scope now, and both were real
      // staleness bugs rather than lint noise.
      //
      // All three feed the SAME call -- `describeHexWithValue(hoverQ, hoverR,
      // mapGrid, currentEra, publicCompanies)` -- which builds the hover
      // tooltip, so a stale closure here does not fail loudly. It quietly
      // reports outdated numbers, indefinitely:
      //
      //   - `currentEra` is the worse of the two. It selects which off-board
      //     revenue TIER the tooltip prints, and it advances Yellow -> Green
      //     -> Brown as the game progresses. Frozen at first render, every
      //     off-board hover would show Yellow-era revenue for the entire rest
      //     of the game -- a number the contract stopped paying rounds ago.
      //   - `mapGrid` selects the hex's own value. Frozen, hovering a hex
      //     someone just upgraded reports its PRE-tile value.
      //
      // Cheap to fix: this is an `onPointerMove` prop, so a new identity just
      // swaps the handler React has attached. Nothing re-subscribes, and
      // nothing here writes state that could feed back into these deps.
      mapGrid,
      currentEra,
      // Design note #269: same class of staleness as the three above, and
      // the one that would bite hardest -- frozen at `false`, the tooltip
      // would keep reappearing under an open picker on every mouse move,
      // which is the reported bug with an extra step.
      suppressHoverTooltip,
    ],
  );

  /** Canvas Click Interceptor (design note #7 / item 1). Pointer-up is used
   *  rather than a native `click` event so this can distinguish a genuine
   *  click from the tail end of a pan drag using the SAME `dragStateRef`
   *  already tracked for panning, instead of a second parallel gesture
   *  tracker. */
  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragStateRef.current;
      dragStateRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);

      if (!drag) return;
      const movedX = event.clientX - drag.startX;
      const movedY = event.clientY - drag.startY;
      const movedDistance = Math.sqrt(movedX * movedX + movedY * movedY);
      // A real pan drag almost always moves several pixels even when the
      // user "meant" to click; a small dead zone tells the two apart
      // without feeling laggy on a genuine click.
      const CLICK_MOVEMENT_THRESHOLD_PX = 4;
      if (movedDistance > CLICK_MOVEMENT_THRESHOLD_PX) return;

      const rect = event.currentTarget.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      // Undo `draw()`'s own `ctx.translate(view.panX, view.panY)` /
      // `ctx.scale(view.zoom, view.zoom)` to land back in the hex layer's
      // own untransformed coordinate space that `pixelToAxial` expects.
      const contentX = (cssX - view.panX) / view.zoom;
      const contentY = (cssY - view.panY) / view.zoom;
      const { q, r } = pixelToAxial(contentX, contentY, hexSize);
      const hexLabel = describeHex(q, r);

      // Tile Selection Catalog verification pass, item 1 ("Expose Selection
      // Logs"): fires the instant a player clicks a hex to open the tile
      // picker -- BEFORE the async `GetLegalTilePlacements` query below even
      // starts, since the hex's own coordinate/preprinted terrain/
      // designation is already known synchronously at this point. The
      // "complete filtered array of allowed tile_ids" this item also asks
      // for genuinely can't be logged here too: it doesn't exist yet until
      // that query resolves (this is a live on-chain query, not a local
      // filter) -- see the second `console.log` in the `.then` handler
      // below for that half, fired the moment the response actually arrives.
      // eslint-disable-next-line no-console
      console.log("[TileSelection] hex clicked", {
        hex_coordinate: { q, r, hex_label: hexLabel },
        preprinted: describeHexDesignationForLog(q, r),
      });

      /* ---- Design note #141: the four static board gates ---------------
       *
       * Split deliberately either side of `onHexClick`, because the two
       * halves answer different questions and only one of them is about
       * laying a tile.
       *
       * GATE 1 RUNS FIRST, BEFORE `onHexClick`. "This coordinate is not a
       * hex" is not a tile-laying rule, it is the absence of a target.
       * `pixelToAxial` maps every point in the canvas to SOME axial
       * coordinate -- including the wide empty margins around the board and
       * the real gaps inside its non-convex outline (row A has no A13/A15)
       * -- so without this, clicking blank background is indistinguishable
       * from clicking a hex. Nothing downstream should react to it: not the
       * picker, and not route-point selection either, which would otherwise
       * happily append a route point in the middle of the Atlantic.
       */
      // Design note #171: computed once, here, so every report below --
      // `onHexClick` and all six `onHexClickQuery` statuses -- carries the
      // same centre. Above the gate, because `"not-a-hex"` reports it too.
      const centre = axialToPixel(q, r, hexSize);
      const centroidX = centre.x * view.zoom + view.panX;
      const centroidY = centre.y * view.zoom + view.panY;

      const eligibility = evaluateHexForTileLaying(q, r, mapGrid);
      if (eligibility.reason === "not-a-hex") {
        // Design note #172: SAY SO, rather than returning silently.
        //
        // This returned with no signal at all, which was right when the only
        // consumer was the tile picker -- there is nothing to open over open
        // water. It stopped being right once something could already be
        // OPEN: a radial menu anchored to a previous hex stayed up while the
        // player clicked around the ocean trying to dismiss it, because the
        // one gesture that obviously means "never mind" produced no event.
        //
        // `"not-a-hex"` is now a real reported status. It carries no
        // placements and opens nothing; its entire job is to let a listener
        // close what it opened.
        onHexClickQuery?.({
          status: "not-a-hex",
          q,
          r,
          hexLabel,
          clientX: event.clientX,
          clientY: event.clientY,
          centroidX,
          centroidY,
        });
        return;
      }

      // Design note #171: the hex's own CENTRE, in canvas-CSS pixels.
      //
      // Callers were anchoring UI to `clientX`/`clientY` -- the cursor. A
      // radial menu built on that opens wherever the pointer happened to
      // land, so clicking a hex near its rim produced a ring visibly off
      // its own hex, and two clicks on the same hex produced two different
      // rings. Anchoring wants the HEX, and the hex's centre is a property
      // of the grid, not of the click.
      //
      // Projected through the SAME transform `draw()` applies
      // (`translate(pan)` then `scale(zoom)`), which is the inverse of the
      // `contentX`/`contentY` computation above -- so it tracks pan and
      // zoom for free rather than needing its own correction.
      onHexClick?.({
        q,
        r,
        hexLabel,
        // Design note #242: the identifier, alongside the display name.
        boardLabel: boardHexLabel(q, r),
        clientX: event.clientX,
        clientY: event.clientY,
        centroidX,
        centroidY,
      });

      // Design note #120: this guard used to be a single condition covering
      // all four interceptor props, and it is now split in two, because the
      // props go missing for two completely different reasons that were
      // being treated identically.
      //
      // FIRST: the interceptor is switched OFF deliberately. `App.tsx`'s
      // route-select mode omits `gameId`/`protocolId` (and `contractAddress`
      // and `queryClient`) specifically so a route-point click doesn't also
      // pop the LayTile picker open underneath it -- see design note #7 and
      // App.tsx design note #11. That must keep bailing out silently.
      //
      // REGRESSION FIX (design note #139): `!contractAddress` USED TO BE PART
      // OF THIS GUARD, and moving it out is the entire fix for "clicking a
      // hex no longer opens the tile picker offline".
      //
      // A contract address is a CHAIN concern, not a "which hex am I laying
      // on" concern, so it never belonged in the deliberately-off test. It
      // survived here only because it was never previously falsy: the address
      // was a hardcoded placeholder string (`"juno1...eighteencosmos..."`)
      // that was invalid but TRUTHY, so this guard always passed and control
      // always reached the offline fallback below. Offline mode was, without
      // anyone intending it, load-bearing on a fake constant being truthy.
      //
      // F-4 moved the address into the environment, where an unset variable
      // is correctly `undefined` -- and this guard, unchanged, began swallowing
      // every hex click in exactly the sandbox mode that has no address by
      // design. Silent, too: `onHexClick` had already fired, so the
      // "[TileSelection] hex clicked" log above still printed while the popup
      // never opened.
      //
      // `gameId`/`protocolId` are the honest discriminator: `App.tsx` supplies
      // both in normal mode and omits both in route-select mode, and neither
      // has anything to do with whether a chain is reachable.
      if (gameId === undefined || protocolId === undefined) {
        return;
      }

      /* ==================================================================
       *  DESIGN NOTE 257: A DIMMED HEX SAYS IT ALREADY
       * ==================================================================
       *
       * REPORTED: clicking a dimmed hex during Lay Track pops up an
       * unnecessary explainer.
       *
       * This used to report a `"blocked"` status carrying a sentence about
       * the corporation's reach, which `App` rendered as a floating amber
       * cue near the cursor. That was the right call when the board gave no
       * other signal -- design note #141's own reasoning, that this codebase
       * had twice shipped a hex click that logged and then silently did
       * nothing.
       *
       * The veil changed the premise. When `layFocus` is active the hex the
       * player just clicked is VISIBLY dimmed and the legal ones are
       * VISIBLY glowing, so the explainer restates in words what the board
       * has already said in light -- and it does so as a popup that follows
       * the cursor, which is a lot of ceremony for "not there". Worse, it
       * fires on every stray click during the one step where a player is
       * most likely to be clicking around the map deciding.
       *
       * So under the veil the click is simply ignored. The status is still
       * SUPERSEDED (`clickQuerySeqRef`) so a late response for a previous
       * hex cannot open a picker over the one just refused -- silence must
       * not mean "and also let the last thing through".
       *
       * WITHOUT A VEIL NOTHING CHANGES. Gates 2 and 3 below still report
       * their reasons, because with no dimming those hexes look identical to
       * legal ones and the cue is the only feedback there is. */
      /* ==================================================================
       *  DESIGN NOTE 437: THE GATE IS THE ACTOR'S, NOT EVERYONE'S
       * ==================================================================
       *
       * REPORTED: non-active players cannot select hexes to view the tile
       * selector during an Operating Round.
       *
       * This gate was `if (layFocus && ...)`, so it applied to anyone
       * looking at a board that had a focus set -- and during the Track
       * step every viewer gets one, built from the ACTING corporation's
       * reach. A player waiting their turn could therefore only click the
       * hexes the current corporation could build on, which is the least
       * useful subset for someone planning their own turn.
       *
       * `dim` is the right condition and not merely a convenient one. It is
       * documented above as being set from `isMyTurn` precisely because
       * "only the shell knows who is watching" -- it already means "this
       * viewer is the one who may act on this set". The refusal and the
       * veil are two expressions of that single fact, so they read one
       * flag: a second boolean saying the same thing is a thing that can
       * disagree with it, and a board that dims for one player while
       * refusing another's clicks is exactly that disagreement.
       *
       * For a non-acting viewer there is now no veil and no refusal -- the
       * glow still marks the acting corporation's legal set, which is
       * information worth having while watching, and clicks fall through to
       * open the picker anywhere. Whether they may LAY is a separate
       * question the ring's confirm button answers (`canLayTileNow`). */
      if (layFocus?.dim && !layFocus.highlighted.has(`${q},${r}`)) {
        clickQuerySeqRef.current += 1;
        return;
      }

      /* ---- Gates 2 and 3 -- design note #141 ---------------------------
       *
       * These run AFTER `onHexClick` and after the route-select bail-out,
       * both on purpose.
       *
       * After `onHexClick`, because off-board and gray hexes are perfectly
       * legal things for a ROUTE to run through -- that is what red
       * terminals and gray connector hexes are FOR. These gates say "no
       * tile may be laid here", which is a different claim from "nothing
       * may happen here", and conflating the two would break the manual
       * route-point tool (App.tsx design note #11) for precisely the hexes
       * it most needs to reach.
       *
       * After the route-select bail-out, because in that mode the picker is
       * switched off entirely and reporting a blocked status would put a
       * tooltip on screen for a picker that was never going to open.
       *
       * Reported rather than silently dropped: `"blocked"` carries the
       * reason to the UI. This codebase has shipped a silent-hex-click bug
       * twice already (design notes #120 and #139) and both times the
       * symptom was a click that logged and then did nothing.
       */
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
          clientX: event.clientX,
          clientY: event.clientY,
          centroidX,
          centroidY,
          // Non-null: `"not-a-hex"` already returned above, and it is the
          // only reason with no message.
          reason: eligibility.reason!,
          message: eligibility.message,
        });
        return;
      }

      // SECOND: the interceptor is ON -- the caller supplied the hex's
      // identity -- but there is no chain client to ask. In practice that
      // means the app is running without a connected wallet or node, which
      // is the ordinary state of `npm start` against no backend.
      //
      // THE BUG THIS FIXES: the old combined guard returned here too, so
      // `onHexClickQuery` never fired, `App.tsx`'s `hexClickQuery` stayed
      // `null`, and its `hexClickQuery?.status === "success"` gate never
      // rendered the popup. The picker appeared completely dead on click --
      // no popup, no error, no exception, and the "[TileSelection] hex
      // clicked" log above still printing perfectly, because the handler had
      // genuinely run and then decided there was nothing to do. Nothing was
      // hanging and no promise was pending; the flow simply had no offline
      // path at all.
      //
      // Now it falls back to the local catalog mirror so the picker still
      // opens and the tray still renders. `localCatalogPlacements` filters by
      // era ONLY -- see its doc comment -- so the result is explicitly
      // provisional and goes out under `status: "offline"`, which the UI is
      // required to label as such and must not dispatch from.
      // Design note #139: `!contractAddress` now sits HERE, alongside
      // `!queryClient`, because the two mean the same thing -- there is no
      // chain to ask. Either one missing takes the offline path, which is the
      // behaviour the sandbox has always needed and only accidentally had.
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
          clientX: event.clientX,
          clientY: event.clientY,
          centroidX,
          centroidY,
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
        clientX: event.clientX,
        clientY: event.clientY,
          centroidX,
          centroidY,
      });

      queryClient
        .queryContractSmart(contractAddress, {
          GetLegalTilePlacements: { game_id: gameId, protocol_id: protocolId, q, r },
        })
        .then((response) => {
          // Stale-response guard: a rapid earlier click's request can
          // resolve after a newer click's -- only the latest matters.
          if (clickQuerySeqRef.current !== seq) return;

          // Tile Selection Catalog verification pass, item 1 (continued):
          // the "complete filtered array of allowed tile_ids" half of this
          // item's log, fired now that the upgrade catalog module
          // (`hexmap::legal_tile_placements` on-chain) has actually
          // returned it -- each entry is a `(tile_id, orientation)` pairing
          // the live `LayTile` call would currently accept at this hex.
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
            clientX: event.clientX,
            clientY: event.clientY,
          centroidX,
          centroidY,
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
            clientX: event.clientX,
            clientY: event.clientY,
          centroidX,
          centroidY,
            message,
          });
        });
    },
    [
      // Design note #223: a stale set here would gate clicks against the
      // PREVIOUS corporation's reach -- refusing hexes the current one may
      // build on, and accepting ones it may not.
      layFocus,
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
      // Design note #141: gate 3 reads the laid tile at the clicked hex out
      // of `mapGrid`, so a stale closure here would keep judging a hex by
      // whatever was on it when the handler was last built -- meaning a hex
      // upgraded to Brown during play would go on opening the picker until
      // something unrelated forced a re-render.
      mapGrid,
      // Design note #125 dropped `currentEra` from here: the offline
      // fallback no longer filters by era, so the handler has nothing
      // era-dependent left to close over. Era browsing is now a view control
      // inside `TileSelectionPopup` instead.
    ],
  );

  /** Design note #67: Scroll-Wheel Zoom Disabled. Previously zoomed the
   *  board around the cursor (`deltaY < 0` -> `factor = 1.1`, else `1 /
   *  1.1`, the exact same `setView`/`clampPanToBoard` update the "+"/"-"
   *  camera buttons below still use) -- reported: the ONLY way to zoom
   *  should be those manual buttons, not an incidental scroll-wheel
   *  gesture while the cursor happens to be over the map. The zoom
   *  math/state update is REMOVED entirely (not merely gated off, so
   *  there's no dead `minZoom`/`MAX_ZOOM_MULTIPLIER`/`clampPanToBoard`
   *  zoom-on-wheel path left to accidentally re-enable) -- `handleWheel`
   *  now does exactly one thing: `preventDefault()`, still unconditional,
   *  still purely to stop the page itself from scrolling while the cursor
   *  is over the canvas (design note #13's own reasoning, UNCHANGED by
   *  this pass -- that's a scroll-containment concern, not a zoom one). */
  const handleWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
  }, []);

  /** "+"/"-" camera overlay button handler -- see design note #17.
   *  Zooms by `factor` around the canvas's own screen-space center (a
   *  button click has no cursor position to anchor on, unlike
   *  `handleWheel`'s mouse-anchored zoom), clamped to
   *  `[minZoom, minZoom * MAX_ZOOM_MULTIPLIER]` (design note #36/item 1 --
   *  relative to `minZoom`, not the old absolute `MAX_ZOOM`)
   *  and pan-clamped to the board exactly like every other zoom path here.
   *  If the camera is still at the locked `fitView` baseline
   *  (`detailedView === false`), this ALSO flips `detailedView` on -- these
   *  buttons are meant to work standalone, without first requiring a
   *  separate "Toggle Detailed View" click, so the very first "+"/"-"
   *  press starts from `fitView`'s own zoom/pan (captured via the
   *  `detailedView` dependency below) rather than being a no-op. */
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

  /** "Fit to Screen" camera overlay button handler -- see design note #17
   *  (button removed and consolidated per design note #42, handler logic
   *  unchanged). Unconditionally snaps the camera back to exactly `fitView`
   *  and re-locks it (`detailedView` false) -- idempotent and always
   *  available as its own explicit action, regardless of whether the camera
   *  got to its current pose via drag/wheel or the "+"/"-" buttons above. */
  const handleFitToScreen = useCallback(() => {
    setDetailedView(false);
    setView(fitView);
    scheduleDraw();
  }, [fitView, scheduleDraw]);

  /* Design note #269, the other half: the tooltip on screen AT THE MOMENT
     the picker opens. The guard in `handlePointerMove` only stops the next
     one from being set, and a click does not move the pointer -- so without
     this the stale tooltip would sit under the ring until the player
     happened to move the mouse. */
  useEffect(() => {
    if (!suppressHoverTooltip) return;
    setHoveredCoordLabel((prev) => (prev === null ? prev : null));
    setHoveredOffboardHex((prev) => (prev === null ? prev : null));
  }, [suppressHoverTooltip]);

  /** The pointer has left the canvas entirely -- clears the off-board hover
   *  tooltip (design note #15/item 4) in addition to `handlePointerUp`'s own
   *  drag-release handling, since `handlePointerMove` (the only other place
   *  that updates `hoveredOffboardHex`) stops firing once the pointer is
   *  outside the element. */
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

  /* Design note #44: the control cluster moved OUT of the canvas.
   *
   * It was `position: absolute; top/right: 20px` inside the canvas
   * container, which put it directly on top of the board's top-right
   * coordinate labels -- the one part of the map that is pure reference
   * text and therefore the worst thing to cover. There is no placement
   * inside a full-bleed canvas that does not cover SOMETHING, so the
   * controls leave the canvas entirely and sit in normal flow underneath
   * it. The canvas keeps its own `position: relative` wrapper (the tooltip
   * and click-indicator overlays still need it); this just adds a column
   * around the pair. */
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
        // ITEM 1 FIX (design note #27): was `heightProp ?? "100%"` -- a
        // percentage height only ever resolves against an ANCESTOR's own
        // definite height, which no longer exists once `App.tsx` (design
        // note #13) stops imposing one. This is now the same computed pixel
        // `height` the `<canvas>` below uses (derived from the board's own
        // aspect ratio, not measured), so this wrapper's real DOM box is
        // exactly as tall as its content actually needs -- letting that
        // height propagate straight up through every unconstrained ancestor
        // to the page itself.
        height: `${height}px`,
      }}
      className={className}
    >
      {/* Design note #25: the map canvas is once again the direct, single
          child here -- no nested wrapper div. Design notes #20/#23/#24's DOM
          overlay/frame detour is gone entirely: the row/column margin
          labels are now drawn NATIVELY on the canvas itself (see
          `drawBoardMarginLabels`, called at the end of `draw()`'s
          world-space pass), so there's no longer any separate DOM element
          that needs to be sized or positioned relative to the canvas at
          all. */}
      <canvas
        ref={canvasRef}
        style={{
          width,
          height,
          touchAction: "none",
          // Design note #159: targeting beats panning. While a token is
          // being placed the crosshair is the more important signal -- the
          // player can still pan, they just need to know what a click does.
          // Design note #183: a STATION TOKEN, not a bare crosshair.
          //
          // `crosshair` says "you are about to click precisely somewhere",
          // which is true of route-point selection and tile laying too --
          // it marked that a mode was active without saying WHICH. An
          // inline SVG cursor showing the token itself names the mode at
          // the pointer, where the player is actually looking.
          //
          // Data-URI rather than a file: it is nine elements, it must not
          // race a network fetch (a cursor that arrives late is a cursor
          // that flickers), and the hotspot has to be declared in the same
          // breath as the art. `16 16` centres it, because a token is
          // placed AT a point rather than pointed at from a corner.
          //
          // `, crosshair` is the fallback, not decoration: a browser that
          // rejects the URI keeps the old behaviour instead of silently
          // reverting to an arrow that says nothing.
          cursor:
            cursorMode === "token"
              ? `url("${STATION_TOKEN_CURSOR}") 16 16, crosshair`
              : detailedView
                ? "grab"
                : "default",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onWheel={handleWheel}
      />
      {/* Active coordinate + value hover tooltip -- see design note #21,
          enriched by design note #26/item 2 (drops the old "Hovering: "
          prefix so the on-screen text matches that item's own literal
          "G19: New York (Value: $20)" example exactly). Positioned with
          plain `position: fixed` viewport coordinates (not relative to
          this wrapper), so it tracks the raw cursor position exactly.
          Design note #75: ADAPTIVE QUADRANT, mirroring `drawOffboardTooltip`
          -- reported, this always anchored down-right of the cursor
          regardless of room, running off the panel for hexes near its
          right/bottom edge (Boston, Fall River). `preferLeft`/`preferAbove`
          (computed in `handlePointerMove` from the cursor's position within
          the canvas's own panel) flip which corner of the tooltip sits at
          the cursor, using `right`/`bottom` (viewport-anchored, same as
          `left`/`top`) instead of just always growing down-right. */}
      {hoveredCoordLabel && (
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
/* ------------------------------------------------------------------ */
/* Canvas primitives -- EXTRACTED (monolith split, Phase 4)             */
/* ------------------------------------------------------------------ */
//
// Every drawing function moved to `./hexCanvasPrimitives`. With that, this
// file holds only the React component: lifecycle, state, events and the
// orchestration of the draw passes. The `import` is at the top -- `import/first`.

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
  /* ==================================================================
   *  DESIGN NOTE 368: THE HEX HAS TO FIT ITS OWN CANVAS
   * ==================================================================
   *
   * REPORTED: the radial tile selector shows its previews as rectangles
   * instead of hexagons, so the artwork looks clipped.
   *
   * It was clipped, and by exactly one number. This defaulted to a FIXED
   * radius of 40 while `size` defaulted to 96, and the two were only
   * compatible by luck: `drawHexPath` draws a POINTY-TOP hex, whose height
   * is 2R and whose width is √3·R, so a radius of 40 needs an 80px canvas.
   *
   * `RadialTileSelector` passes `size={38}` and left `hexSize` alone. A
   * 40-radius hex is 80px tall inside a 38px canvas, so five sixths of it
   * -- every vertex, top and bottom -- fell outside the bitmap and what
   * survived was the middle band: a rectangle. Not a styling problem at
   * all, and not visible from the CSS, which is why it reads as one.
   *
   * DERIVED, so the two can never disagree again. `(size - 2) / 2` is the
   * largest radius whose 2px tier stroke still lands inside the canvas;
   * height is the binding dimension for a pointy-top hex, and the √3/2
   * width then fits with room to spare. `TileSelectionPopup` passes both
   * explicitly (150/64, which fits) and is unaffected.
   *
   * A DEFAULT RATHER THAN A COMPUTATION AT THE CALL SITE, because the
   * relationship is a property of the drawing, not of any one caller --
   * and the bug was a caller being asked to know it. */
  hexSize?: number;
  className?: string;
}

/** A small, self-contained canvas that renders exactly one catalog tile in
 *  isolation -- terrain fill, color-tier outline, and its decoded track
 *  path at the given `orientation` -- reusing this file's own
 *  `TILE_CATALOG_BY_ID`/`drawHexPath`/`drawTrackPath` rather than a second
 *  hand-kept catalog mirror (see design note #2's "DESIGN GAP" discipline).
 *  Built for `TileSelectionPopup.tsx`'s carousel thumbnails and its larger
 *  rotation preview; has no wallet/session/query dependency of its own,
 *  matching this file's presentational-only design. */
/** Design note #183: the station-token placement cursor.
 *
 *  A white disc with a dark rim and a centre dot -- the same vocabulary
 *  `drawStationTokenMarker` uses on the board, so the pointer looks like
 *  the thing it is about to place. The outer dark ring keeps it visible on
 *  the light tile colours (`#FDE900` especially) as well as on the dark
 *  board chrome, which a plain white disc would not manage. */
const STATION_TOKEN_CURSOR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
      '<circle cx="16" cy="16" r="10" fill="#ffffff" stroke="#1a1a1a" stroke-width="3"/>' +
      '<circle cx="16" cy="16" r="3.5" fill="#1a1a1a"/>' +
      '<path d="M16 1 v5 M16 26 v5 M1 16 h5 M26 16 h5" stroke="#1a1a1a" stroke-width="2.5" stroke-linecap="round"/>' +
      "</svg>",
  );

export function TilePreviewThumbnail({
  tileId,
  orientation = 0,
  size = 96,
  // Design note #368: derived from `size`, never a bare constant.
  hexSize = (size - 2) / 2,
  className,
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
        // Mirror-only, by construction (design note #119): this component
        // renders an UN-LAID tile in the picker carousel and has no query
        // row for it -- see this file's `pathsForTile`. It is also the
        // reason the mirror carries `paths` at all rather than the backend
        // being the single source: a tile has to render correctly before it
        // exists on the board.
        drawTrackPath(ctx, center, hexSize, catalogEntry, orientation);
      });
    } else {
      // Unknown tile_id -- see design notes #2/#118 -- same generic
      // provisional artwork as the main board renderer, rather than
      // silently drawing nothing. This path matters more here than on the
      // board: `TileSelectionPopup`'s carousel renders one of these per
      // legal placement the contract returned, so an id this mirror hasn't
      // caught up to is still a real, clickable, submittable choice and
      // needs to at least show its own number.
      withHexClip(ctx, center, hexSize, () => {
        drawUnknownTilePlaceholder(ctx, center, hexSize, tileId);
      });
    }

    ctx.restore();
  }, [tileId, orientation, size, hexSize]);

  /* Design note #368: the element's own bounds are the hexagon too, not
     just the artwork inside it. The canvas is transparent outside the hex
     either way, but a square element means any chrome BEHIND it -- the
     radial ring's button background, a hover fill -- shows through the
     corners and frames the tile as a card. Clipping the element makes the
     preview read as a game piece.

     The polygon is a pointy-top hex inscribed in the square, height-bound:
     ±(√3/2)/2 = ±43.3% horizontally, the full height vertically. Same
     proportions as `drawHexPath`, so the clip lands exactly on the stroke
     rather than shaving it. */
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
