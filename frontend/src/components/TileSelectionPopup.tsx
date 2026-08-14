// frontend/src/components/TileSelectionPopup.tsx
//
// The Interactive Floating Tile-Selection Popup Overlay -- the floating
// modal panel half of the click-to-lay-a-tile flow. `HexGridRenderer.tsx`'s
// click interceptor (see that file's design note #7) owns converting a
// canvas click to `(q, r)` and firing the read-only `GetLegalTilePlacements`
// query; this file owns everything that happens once that query resolves:
// showing the legal `tile_id`s as a scrollable carousel, letting the player
// preview a selected tile's legal rotations, and dispatching the real
// `LayTile` transaction through the session-key pipeline.
//
// Design notes:
// 1. **Self-contained dispatch, observer-only callback out.** This
//    component calls `useGameSession().execGameplay` itself (matching the
//    feature request's framing that the popup's OWN "Confirm Placement"
//    button routes through the session-key pipeline) rather than asking
//    `App.tsx` to do the dispatch on its behalf. `onDispatched` is an
//    optional observer callback so `App.tsx` can still fold the result into
//    its existing centralized Action Log (see `App.tsx`'s
//    `runGameplayAction`) for UI consistency with the sidebar's other
//    actions, without this component needing to know that log exists.
// 2. **Orientation cycling is informational, not a binding choice --
//    IMPORTANT LIMITATION.** `ExecuteMsg::LayTile` (see `msg.rs`) and this
//    codebase's `GameplayExecuteMsg`'s `LayTile` variant (see
//    `utils/sessionKey.ts`) both take `{ game_id, protocol_id, q, r,
//    tile_id }` -- there is NO `orientation` field anywhere in that
//    message. `hexmap::execute_lay_tile` always auto-picks the LOWEST legal
//    orientation for the given `tile_id` at that hex, using the exact same
//    "iterate orientation 0..6, take the first legal one" logic that
//    `legal_tile_placements` (the query backing `GetLegalTilePlacements`)
//    uses to build its response in the first place. STRUCTURAL FIX: a
//    prior pass of this component was built against a contract that had no
//    `orientation` input on `LayTile` at all -- the contract auto-picked
//    the lowest legal rotation server-side, so this popup could only ever
//    preview rotations, never actually choose one, and said so explicitly
//    in the UI. That auto-pick has since been removed from the contract
//    (see `src/hexmap.rs` module doc comment #4 / `src/msg.rs`'s
//    `ExecuteMsg::LayTile`): `orientation` is now a required message field,
//    and the contract commits *exactly* whichever rotation is submitted,
//    rejecting it if that specific angle isn't legal. This component's
//    rotation cycle is therefore a REAL, binding choice now, not a preview:
//    the rotation gesture changes which of `placements`' legal orientations
//    is currently selected, and "Confirm Placement" submits exactly that
//    one. (Design note #7 changed WHAT that gesture is -- double-clicking
//    the tile in the row, not clicking a separate preview panel -- but not
//    that it is binding.)
// 3. **Floating position, not a fixed layout.** `anchorClientX`/
//    `anchorClientY` (the raw `event.clientX`/`clientY` from
//    `HexGridRenderer`'s `onHexClick`) position this card via `position:
//    fixed` with a small offset, clamped so it can't render off the right/
//    bottom edge of the viewport. This deliberately does NOT try to
//    project the hex's on-canvas position through the canvas's own pan/
//    zoom transform a second time -- the click's own screen coordinates are
//    already exactly where the player just clicked, which is the more
//    honest anchor point for a floating popup than re-deriving it.
//    UPDATED by design note #7: still anchored to the click, for exactly
//    the reason above, but the plain clamp became flip-aware once the card
//    grew to ~900px. A docked bottom bar and a centred modal were both
//    considered and rejected -- the bar costs too much mouse travel on a
//    large scrollable map, and the modal hides the very board you need to
//    see while judging a rotation.
// 4. **No client-side re-validation of legality.** The carousel only ever
//    offers `tile_id`s the contract's own `GetLegalTilePlacements` query
//    already returned, and "Confirm Placement" sends exactly that
//    `tile_id` -- this component does not attempt to re-implement
//    `hexmap::legal_tile_placements`'s connectivity/terrain rules
//    client-side (that logic is nontrivial and already lives correctly on
//    the contract; duplicating it here would just be a second place for it
//    to drift out of sync, per this codebase's established "hand-kept
//    mirror" caution -- see `HexGridRenderer.tsx` design note #2).
// 5. **Real 1830 tray numbers, and why this file needed almost no change
//    for them** (backend Audit G-5; see `HexGridRenderer.tsx` design note
//    #118). The backend catalog now keys every tile on its REAL physical
//    1830 tray number across a full 46-tile roster, replacing this engine's
//    old synthetic internal ids -- so `GetLegalTilePlacements` returns e.g.
//    #54 where it used to return 17, #53 where it used to return 16, #59
//    where it used to return 15, #57 where it used to return 10. Design
//    note #4 above is exactly why that overhaul cost this component almost
//    nothing: it has never held a tile-id table, a label map, an artwork
//    switch, or any id literal at all. Every id it touches arrives from the
//    query and is handed straight to `TilePreviewThumbnail`, which resolves
//    artwork through the ONE mirror in `HexGridRenderer.tsx`. What this
//    pass did add is presentational only, and driven by that same single
//    mirror rather than a second copy: the carousel now groups by colour
//    tier before tray number (see `groupPlacementsByTile`) and labels each
//    thumbnail with its tier. Both matter more than they used to -- 46 real
//    tray numbers are not contiguous and not tier-ordered (a hex can offer
//    #8 next to #57, or #16 next to #53), so a bare ascending numeric list
//    gave the player no signal about which era's artwork they were picking.
// 6. **`offline` -- the picker without a chain.** Set when these
//    `placements` came from `HexGridRenderer`'s local `TILE_CATALOG` mirror
//    instead of from `GetLegalTilePlacements` (that file's design note #120
//    and its `HexClickQueryState` `"offline"` variant). It exists so the
//    picker still opens while developing against no backend, which it
//    previously did not: with no chain client the click handler bailed
//    before ever reporting a state, so this popup never mounted at all.
//
//    Design note #4 above says the carousel offers only what the contract
//    returned. That invariant is NOT relaxed here, it is made visible. An
//    offline tray is filtered by NOTHING AT ALL as of design note #8 -- not
//    even by era: no connectivity, no landmark/OO/"B"/"NY" reservation, no
//    upgrade colour step, no tray depletion -- so most of what it shows
//    would be rejected outright by
//    `hexmap::execute_lay_tile`. Presenting that silently, in a UI otherwise
//    identical to the authoritative one, would be the worst outcome
//    available: it looks exactly like a legality answer while being nothing
//    of the kind.
//
//    So the mode is stated three times over, and dispatch is blocked twice.
//    A banner above the carousel says plainly what was and wasn't checked;
//    the heading reads "Catalog tiles" rather than "Legal tiles"; the
//    rotation caption drops the word "legal", since all six are offered
//    precisely because nothing filtered them. `handleConfirmPlacement`
//    returns immediately AND the button is disabled and relabelled -- belt
//    and braces, because the disabled attribute alone is a presentational
//    guarantee and this needs a behavioural one.
// 8. **Era tabs, offline only.** Reported: offline, the player was trapped
//    looking at the Yellow tray with no way to see the rest of the catalog.
//    Two things caused that together. `HexGridRenderer`'s offline fallback
//    filtered the catalog to the room's `currentEra`, which at game start is
//    Yellow -- twelve tiles of forty-six; and this popup had no way to ask
//    for anything else. Both are fixed, in the places they belong: the
//    fallback now returns the whole catalog (see that file's design note
//    #125 for why that weakens no rule -- it was never enforcing one), and
//    the browsing lives HERE as a view control the player can change, rather
//    than as a filter upstream they cannot see or reach.
//
//    Strictly gated on `offline`. Online, `placements` is the contract's own
//    answer about ONE hex and every entry in it is genuinely legal there --
//    an era tab would only let a player hide legal moves from themselves,
//    and worse, a hex mid-upgrade legitimately offers two eras at once, so
//    hiding one would look like the picker was broken. The strip is also
//    hidden when only one era is present, which is the common case for a
//    real hex, so it costs nothing when it has nothing to offer.
//
//    Switching tabs can hide the current selection, so an effect pulls it
//    back to the first visible tile -- otherwise the footer readout blanks
//    and a ghost preview strands itself on a board hex whose tile is no
//    longer on screen.

// 7. **Flattened single-row layout, double-click to rotate.** Direct user
//    feedback: "the font is very small and split into two parts... it would
//    be better to have just the legal tiles all in one row/panel, and double
//    clicking them rotates them."
//
//    The split was the substantive complaint. The card used to be a 280px
//    column: a cramped strip of 56px thumbnails on top, and beneath it a
//    second panel holding ONE enlarged copy of whichever tile was selected,
//    which was also the only surface that rotated. So the tile you were
//    turning was never the tile you had just clicked, and comparing two
//    candidates meant selecting one, reading the bottom panel, selecting the
//    other, reading it again. The bottom panel is now deleted outright and
//    its job folded into the row: the selected tile renders at its live
//    orientation IN PLACE, so rotation happens exactly where you are
//    looking.
//
//    Interaction: single click selects, double click rotates. The one real
//    trap is documented at `handleSelectTile` -- a double click fires
//    `click`, `click`, `dblclick`, so selecting must not reset the rotation
//    or every double click would appear stuck one step from home. Because
//    double-click is undiscoverable on its own it is also stated in the
//    header legend, in each tile's `title`, and as a live `↻ n/m` readout on
//    the selected tile; and because it is unreachable by keyboard, `r` and
//    `ArrowRight` do the same thing (Enter/Space are left alone -- the
//    browser already turns those into a `click`, which selects).
//
//    Readability: base font 13 -> 15, tile numbers 11 -> 17 bold, thumbnails
//    56 -> 104px. The artwork is the actual content here, so its size was
//    the biggest single win -- at 56px a #57 city and a #9 straight were
//    genuinely hard to tell apart.
//
//    The row scrolls horizontally rather than wrapping, which keeps design
//    note #5's tier ordering legible as one left-to-right Yellow -> Green ->
//    Brown progression. That matters most in offline mode, where a Brown-era
//    tray is all 46 catalog tiles.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeliverTxResponse } from "@cosmjs/stargate";

import { useGameSession } from "../context/GameSessionContext";
import { TilePreviewThumbnail, TILE_CATALOG_BY_ID } from "./HexGridRenderer";
import { FONT_FAMILY, FONT_SIZE } from "../styles/typography";
import type { LegalTilePlacement, TileColorTier } from "./HexGridRenderer";

/** Display order for the colour tiers in the carousel -- chronological
 *  (the order a hex is actually upgraded through), not alphabetical. An
 *  id missing from the catalog mirror sorts last, after every known tile,
 *  so it can never push a recognisable tile out of the visible run. */
const TIER_SORT_ORDER: Readonly<Record<TileColorTier, number>> = {
  Yellow: 0,
  Green: 1,
  Brown: 2,
};

/** Tier accent colours, matching `HexGridRenderer.tsx`'s own
 *  `COLOR_TIER_STROKE` so the label under a thumbnail reads as the same
 *  tier as the outline drawn around it. */
const TIER_LABEL_COLOR: Readonly<Record<TileColorTier, string>> = {
  Yellow: "#caa42a",
  Green: "#6fcf7c",
  Brown: "#c08a5a",
};

export interface TileSelectionPopupProps {
  gameId: number;
  protocolId: number;
  q: number;
  r: number;
  hexLabel: string;
  /** The legal `(tile_id, orientation)` pairs from `GetLegalTilePlacements`,
   *  verbatim -- see design note #4: this is the ONLY source of truth for
   *  what's offered. */
  placements: readonly LegalTilePlacement[];
  /** Raw `event.clientX`/`clientY` from `HexGridRenderer`'s `onHexClick` --
   *  see design note #3. */
  anchorClientX: number;
  anchorClientY: number;
  /** Called whenever the live preview (selected tile + orientation) should
   *  change on the board -- wire straight into
   *  `<HexGridRenderer previewTile={...} />`. Called with `null` on close
   *  or when nothing is selected yet. */
  onPreviewChange: (preview: { q: number; r: number; tileId: number; orientation: number } | null) => void;
  /** Called after a "Confirm Placement" dispatch settles (success or
   *  failure) -- see design note #1. Not called if the player closes the
   *  popup without confirming. */
  onDispatched?: (result: { tileId: number; orientation: number } & (
    | { status: "success"; response: DeliverTxResponse }
    | { status: "error"; message: string }
  )) => void;
  /** Called when the player closes the popup (the "x" button, or after a
   *  successful dispatch). */
  onClose: () => void;
  /** Design note #6: these `placements` did NOT come from the contract.
   *  No chain client was available, so `HexGridRenderer` fell back to its
   *  local `TILE_CATALOG` mirror filtered by era alone -- see that file's
   *  `localCatalogPlacements` and its `HexClickQueryState`'s `"offline"`
   *  variant. Makes the popup label itself provisional and hard-refuse to
   *  dispatch. Defaults to `false`, so the ordinary contract-backed path is
   *  entirely unaffected. */
  offline?: boolean;
}

/** Live viewport size, for design note #7's flip-aware positioning.
 *
 *  The old 280px card read `window.innerWidth`/`innerHeight` straight
 *  through during render and never subscribed to `resize`. That was
 *  survivable when the card was narrow -- being a little mispositioned
 *  after a resize is cosmetic. At up to 900px it is not: `cardWidth` itself
 *  is derived from the viewport, so a stale reading can leave the card
 *  wider than the window and hang its right-hand tiles off-screen with no
 *  way to scroll to them. SSR-safe defaults, since this component is
 *  rendered from a `position: fixed` overlay that may mount before layout. */
function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: typeof window === "undefined" ? 1440 : window.innerWidth,
    height: typeof window === "undefined" ? 900 : window.innerHeight,
  }));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/* ==================================================================== */
/*  DESIGN NOTE 10: DRAGGING                                            */
/* ==================================================================== */
//
// The card is anchored next to the hex you clicked (design note #3) and
// flips sides to avoid the viewport edge (design note #7), but on a dense
// board there is no side that is guaranteed clear -- the card is up to
// 1040px wide and the interesting hex is often surrounded by the very hexes
// you are comparing it against. Auto-placement cannot solve that, because
// only the player knows which neighbours they are currently looking at. So
// they get to move it.
//
// Implementation notes, each of which is a bug avoided:
//
//   - POINTER EVENTS, not mouse events. One code path covers mouse, touch
//     and pen, and `setPointerCapture` means the drag keeps tracking even
//     when the cursor outruns the card (easy to do on a fast drag) or
//     crosses the canvas underneath.
//   - OFFSET-BASED, not delta-accumulating. The drag records where in the
//     card you grabbed it and positions from that, so the card never
//     "slides" relative to the cursor over a long drag the way accumulated
//     deltas do once a single frame is dropped.
//   - The offset RESETS when the popup re-anchors to a different hex. A
//     dragged position is a statement about one hex's surroundings; keeping
//     it for the next hex would mean the card opens somewhere arbitrary
//     with no relationship to the click that opened it. Keyed on
//     `anchorClientX`/`Y` rather than on `q`/`r` so it also resets when the
//     board is panned under a re-opened popup.
//   - Clamped so the card can never be dragged fully off-screen, which
//     would strand its close button somewhere unreachable. The clamp keeps
//     the whole card inside the viewport rather than merely a corner of it,
//     since a card that is 90% off-screen is not meaningfully recoverable.

interface DragOffset {
  dx: number;
  dy: number;
}

function useDraggableCard(anchorKey: string) {
  const [offset, setOffset] = useState<DragOffset>({ dx: 0, dy: 0 });
  const [dragging, setDragging] = useState(false);
  // Where inside the card the pointer went down, in card-local pixels.
  const grabRef = useRef<{ x: number; y: number } | null>(null);
  // The offset at the moment the drag started -- added to the pointer delta
  // so a second drag continues from where the first left off.
  const startOffsetRef = useRef<DragOffset>({ dx: 0, dy: 0 });

  // Reset on re-anchor. See design note #10.
  useEffect(() => {
    setOffset({ dx: 0, dy: 0 });
  }, [anchorKey]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Left button / primary contact only -- a right-click on the header
      // should open the context menu, not start a drag.
      if (event.button !== 0) return;
      // Never start a drag from a control inside the header. Without this,
      // pressing the close button would begin a drag and the subsequent
      // `click` would be swallowed, making the button feel broken.
      if ((event.target as HTMLElement).closest("button")) return;

      grabRef.current = { x: event.clientX, y: event.clientY };
      startOffsetRef.current = offset;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [offset],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const grab = grabRef.current;
      if (!grab) return;
      setOffset({
        dx: startOffsetRef.current.dx + (event.clientX - grab.x),
        dy: startOffsetRef.current.dy + (event.clientY - grab.y),
      });
    },
    [],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!grabRef.current) return;
    grabRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return {
    offset,
    dragging,
    reset: useCallback(() => setOffset({ dx: 0, dy: 0 }), []),
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}

/** One carousel entry: a legal `tile_id` plus every orientation the
 *  contract will currently accept for it at this hex. `tier` is resolved
 *  from `HexGridRenderer.tsx`'s catalog mirror and is `null` for an id that
 *  mirror hasn't caught up to (see design note #5). */
interface TileGroup {
  tileId: number;
  orientations: number[];
  tier: TileColorTier | null;
  /** The tile's own PRINTED revenue, from the shared catalog mirror's
   *  `TileCatalogEntry.revenue` -- design note #9.
   *
   *  `null` for plain track (most Yellow tiles have no revenue at all), and
   *  also `null` for an id the mirror has not caught up to. Those two cases
   *  are deliberately NOT distinguished in the UI: rendering "0" for a
   *  track tile would be wrong, and rendering "?" for a catalog gap would
   *  be noise, so both simply show no badge. */
  revenue: number | null;
}

/** Groups `placements` by `tile_id`, sorting each tile's legal orientations
 *  ascending purely for a stable, predictable initial selection (index 0)
 *  when a tile is first chosen from the carousel -- see design note #2:
 *  every orientation in the group is an equally real, submittable choice
 *  now, not just index 0.
 *
 *  Design note #5: groups are ordered by COLOUR TIER first (Yellow, then
 *  Green, then Brown -- the order a hex is really upgraded through), and
 *  only then by tray number within a tier. Under the old synthetic ids a
 *  plain ascending numeric sort happened to produce roughly that order for
 *  free, because the ids were allocated tier by tier. Real 1830 tray
 *  numbers carry no such guarantee -- Yellow #55-#58 and #69 sort above
 *  Green #14-#29, and Brown #39-#47 sort below both -- so an ascending sort
 *  now interleaves the eras arbitrarily. The tier is read from the single
 *  shared catalog mirror; this file keeps no tile table of its own. */
function groupPlacementsByTile(
  placements: readonly LegalTilePlacement[],
): ReadonlyArray<TileGroup> {
  const byTile = new Map<number, number[]>();
  for (const placement of placements) {
    const existing = byTile.get(placement.tile_id);
    if (existing) {
      existing.push(placement.orientation);
    } else {
      byTile.set(placement.tile_id, [placement.orientation]);
    }
  }
  const groups: TileGroup[] = Array.from(byTile.entries()).map(([tileId, orientations]) => {
    const entry = TILE_CATALOG_BY_ID.get(tileId);
    return {
      tileId,
      orientations: [...orientations].sort((a, b) => a - b),
      tier: entry?.color ?? null,
      // Design note #9. Read from the SAME catalog mirror the tier comes
      // from -- this file still keeps no tile table of its own, which is
      // the discipline design note #5 already established here.
      revenue: typeof entry?.revenue === "number" ? entry.revenue : null,
    };
  });
  groups.sort((a, b) => {
    // Unknown tier sorts last (999) rather than first, so a mirror gap can
    // never bury the recognisable tiles below the fold of a scroll strip.
    const tierA = a.tier ? TIER_SORT_ORDER[a.tier] : 999;
    const tierB = b.tier ? TIER_SORT_ORDER[b.tier] : 999;
    if (tierA !== tierB) return tierA - tierB;
    return a.tileId - b.tileId;
  });
  return groups;
}

export function TileSelectionPopup({
  gameId,
  protocolId,
  q,
  r,
  hexLabel,
  placements,
  anchorClientX,
  anchorClientY,
  onPreviewChange,
  onDispatched,
  onClose,
  offline = false,
}: TileSelectionPopupProps) {
  const { execGameplay, sessionStatus } = useGameSession();

  const allGroups = useMemo(() => groupPlacementsByTile(placements), [placements]);

  // Design note #8: OFFLINE-ONLY era filter. `null` means "show everything",
  // which is the only value the contract-backed path ever takes -- see the
  // tab strip's own comment for why this must not exist online.
  const [eraFilter, setEraFilter] = useState<TileColorTier | null>(null);
  const availableEras = useMemo(() => {
    const present = new Set(allGroups.map((group) => group.tier).filter(Boolean));
    return (["Yellow", "Green", "Brown"] as const).filter((tier) => present.has(tier));
  }, [allGroups]);
  const groups = useMemo(
    () => (eraFilter ? allGroups.filter((group) => group.tier === eraFilter) : allGroups),
    [allGroups, eraFilter],
  );

  const [selectedTileId, setSelectedTileId] = useState<number | null>(groups[0]?.tileId ?? null);
  const [orientationIndex, setOrientationIndex] = useState(0);
  const [dispatchState, setDispatchState] = useState<
    { status: "idle" } | { status: "pending" } | { status: "error"; message: string }
  >({ status: "idle" });

  const selectedGroup = groups.find((group) => group.tileId === selectedTileId) ?? null;
  const selectedOrientation = selectedGroup
    ? selectedGroup.orientations[orientationIndex % selectedGroup.orientations.length]
    : null;

  // Keep the live board preview (HexGridRenderer's `previewTile` prop) in
  // sync with whichever tile/orientation is currently selected -- see
  // design note #3's sibling wiring in App.tsx.
  useEffect(() => {
    if (selectedTileId !== null && selectedOrientation !== null) {
      onPreviewChange({ q, r, tileId: selectedTileId, orientation: selectedOrientation });
    } else {
      onPreviewChange(null);
    }
    // Intentionally omitting `onPreviewChange` from deps -- App.tsx passes
    // a fresh inline setter each render, and depending on it would refire
    // this effect (and thus re-set the same preview) every render for no
    // reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTileId, selectedOrientation, q, r]);

  // Clear the board preview on unmount (e.g. popup closed) so a stale ghost
  // tile doesn't linger on the board after the popup itself is gone.
  useEffect(() => {
    return () => onPreviewChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Design note #7: keep the selected tile scrolled into view in the single
  // row. Matters most in offline Brown era, where the row holds all 46
  // catalog tiles and the initial selection (#1, a Yellow tile) is at the
  // far left while a keyboard user arrowing through can easily walk the
  // selection off the right-hand edge. `block: "nearest"` so this never
  // scrolls the PAGE, only the row's own overflow container.
  const tileButtonRefs = useRef(new Map<number, HTMLButtonElement>());
  useEffect(() => {
    if (selectedTileId === null) return;
    tileButtonRefs.current
      .get(selectedTileId)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedTileId]);

  // Design note #7: single click selects. The `tileId === selectedTileId`
  // early return is what makes double-click-to-rotate work at all, and is
  // easy to delete by accident, so: a double click dispatches `click`,
  // `click`, THEN `dblclick`. If selecting always reset `orientationIndex`
  // to 0, those two leading clicks would zero the rotation a beat before
  // `dblclick` advanced it, so every double click would land on index 1 and
  // the tile would appear stuck one step from home no matter how many times
  // it was rotated. Resetting only on a genuine tile CHANGE fixes that.
  //
  // Note what this does NOT do: `orientationIndex` is one shared value, not
  // a per-tile map, so switching to a different tile and back restarts that
  // tile at its first legal orientation rather than restoring where you left
  // it. That is deliberate for now -- predictable, and it keeps the rotation
  // state a single number -- but it is the obvious next step if players ask
  // to compare two part-rotated tiles side by side.
  // Design note #8: switching era tabs can hide whatever was selected. Pull
  // the selection back to the first visible tile rather than leaving it
  // dangling -- a stale `selectedTileId` would blank the footer readout and
  // strand a ghost preview on a board hex the player can no longer see the
  // tile for.
  useEffect(() => {
    if (groups.length === 0) return;
    if (groups.some((group) => group.tileId === selectedTileId)) return;
    setSelectedTileId(groups[0].tileId);
    setOrientationIndex(0);
  }, [groups, selectedTileId]);

  const handleSelectTile = (tileId: number) => {
    setDispatchState({ status: "idle" });
    if (tileId === selectedTileId) return;
    setSelectedTileId(tileId);
    setOrientationIndex(0);
  };

  /** Advances `tileId` one step through its own legal orientations, in
   *  place in the row -- design note #7's rotation half. Also handles the
   *  case where the tile wasn't the selected one yet, which keeps a
   *  double-click on a cold tile from being swallowed. */
  const handleRotateTile = (tileId: number) => {
    const group = groups.find((candidate) => candidate.tileId === tileId);
    if (!group) return;
    setDispatchState({ status: "idle" });
    if (tileId !== selectedTileId) {
      // A double click that landed on a tile which wasn't selected. In
      // practice React has already processed the two leading `click`s and
      // re-rendered by now, so this is a rare-but-real ordering guard
      // rather than the usual path: select it AND take the first rotation
      // step, so the gesture always visibly does something.
      setSelectedTileId(tileId);
      setOrientationIndex(1 % group.orientations.length);
      return;
    }
    if (group.orientations.length <= 1) return;
    setOrientationIndex((prev) => (prev + 1) % group.orientations.length);
  };

  const handleConfirmPlacement = async () => {
    // Design note #6: a hard stop, not merely a disabled button. The button
    // below is already disabled in offline mode, but this path is what
    // actually guarantees an unvalidated, locally-invented placement can
    // never reach `execGameplay` -- there is no contract behind these tiles
    // to have approved them, and `hexmap::execute_lay_tile` would reject
    // most of them outright.
    if (offline) return;
    if (selectedTileId === null || selectedOrientation === null || sessionStatus !== "ready") {
      return;
    }
    // The exact orientation currently selected/previewed is what gets
    // submitted -- see design note #2: the contract now commits precisely
    // this rotation (or rejects it if it isn't legal), rather than
    // silently auto-picking the lowest one on the player's behalf.
    const orientationToSubmit = selectedOrientation;
    setDispatchState({ status: "pending" });
    try {
      const response = await execGameplay({
        LayTile: {
          game_id: gameId,
          protocol_id: protocolId,
          q,
          r,
          tile_id: selectedTileId,
          orientation: orientationToSubmit,
        },
      });
      onDispatched?.({
        tileId: selectedTileId,
        orientation: orientationToSubmit,
        status: "success",
        response,
      });
      setDispatchState({ status: "idle" });
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown LayTile dispatch error.";
      setDispatchState({ status: "error", message });
      onDispatched?.({
        tileId: selectedTileId,
        orientation: orientationToSubmit,
        status: "error",
        message,
      });
    }
  };

  // Design note #7: smart positioning for a card that is now ~3x wider than
  // the one the original clamp was written for.
  //
  // The old version clamped `anchorClient* + 16` against a hardcoded 280x420
  // and read `window.inner*` during render, which was fine for a small card
  // and is not for a wide one: at 900px a card anchored right of a click
  // past mid-screen would previously have been shoved hard against the right
  // edge, sliding it far from the hex it belongs to. So instead of only
  // clamping, this FLIPS to the other side of the cursor when the preferred
  // side doesn't fit, and only clamps as a last resort -- which keeps the
  // card near the click, the whole reason design note #3 anchors it there.
  const viewport = useViewportSize();
  // Design note #9: 900 -> 1040. The tiles inside grew from 104px to 150px
  // and each gained a revenue badge, so the row needs more width to still
  // show a useful number of them before scrolling.
  const CARD_MAX_WIDTH = 1040;
  const VIEWPORT_MARGIN = 12;
  const CURSOR_GAP = 18;
  // Never wider than the viewport allows; on a narrow window this collapses
  // gracefully to "almost full width" without any breakpoint logic.
  const cardWidth = Math.min(CARD_MAX_WIDTH, viewport.width - VIEWPORT_MARGIN * 2);
  // Height is content-driven (one row, not a scrolling list), so this is
  // only the reservation used for flip decisions -- the card itself is
  // capped by `maxHeight` below and will usually be shorter.
  // Design note #9: raised alongside the tile upscale (104 -> 150px artwork
  // plus a larger type scale throughout). This drives the flip-above/below
  // decision, so leaving it at the old value would have had the card decide
  // it fits below the cursor when it no longer does, and open with its
  // footer -- and therefore its Confirm button -- past the bottom edge.
  const CARD_HEIGHT_ESTIMATE = offline ? 470 : 410;

  const fitsRight = anchorClientX + CURSOR_GAP + cardWidth <= viewport.width - VIEWPORT_MARGIN;
  const rawLeft = fitsRight
    ? anchorClientX + CURSOR_GAP
    : // Flip to the cursor's left rather than jamming against the edge.
      anchorClientX - CURSOR_GAP - cardWidth;
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, rawLeft),
    Math.max(VIEWPORT_MARGIN, viewport.width - cardWidth - VIEWPORT_MARGIN),
  );

  const fitsBelow =
    anchorClientY + CURSOR_GAP + CARD_HEIGHT_ESTIMATE <= viewport.height - VIEWPORT_MARGIN;
  const rawTop = fitsBelow
    ? anchorClientY + CURSOR_GAP
    : // Flip above the cursor, so the card never covers the hex you clicked.
      anchorClientY - CURSOR_GAP - CARD_HEIGHT_ESTIMATE;
  const top = Math.min(
    Math.max(VIEWPORT_MARGIN, rawTop),
    Math.max(VIEWPORT_MARGIN, viewport.height - CARD_HEIGHT_ESTIMATE - VIEWPORT_MARGIN),
  );

  /* ---- Drag -- design note #10 ---------------------------------------- */
  //
  // Applied ON TOP of the auto-placement above rather than replacing it:
  // the card still opens next to the hex you clicked, and dragging moves it
  // from there. Re-anchoring resets the offset (see the hook), so the two
  // systems never fight -- auto-placement decides where it OPENS, the drag
  // decides where it SITS.
  const drag = useDraggableCard(`${anchorClientX}:${anchorClientY}`);

  // Clamped so the whole card stays on screen. Without this a drag could
  // strand the close button past the viewport edge with no way back.
  const draggedLeft = Math.min(
    Math.max(VIEWPORT_MARGIN, left + drag.offset.dx),
    Math.max(VIEWPORT_MARGIN, viewport.width - cardWidth - VIEWPORT_MARGIN),
  );
  const draggedTop = Math.min(
    Math.max(VIEWPORT_MARGIN, top + drag.offset.dy),
    // Uses the height ESTIMATE, not a measured height: the card is
    // content-driven and measuring it would need a layout effect and a
    // resize observer for a clamp that only has to be approximately right.
    // Erring toward the estimate keeps at least the header reachable.
    Math.max(VIEWPORT_MARGIN, viewport.height - CARD_HEIGHT_ESTIMATE - VIEWPORT_MARGIN),
  );
  const hasBeenDragged = drag.offset.dx !== 0 || drag.offset.dy !== 0;

  const dispatchDisabled =
    offline ||
    selectedTileId === null ||
    selectedOrientation === null ||
    sessionStatus !== "ready" ||
    dispatchState.status === "pending";

  const tileCount = groups.length;
  // Design note #9: `rotationHint` is REMOVED, not merely unrendered. It
  // said "Double-click a tile to rotate it" / "This tile has only one legal
  // rotation" -- both of which are now stated closer to where they matter:
  // the gesture by the permanent header legend, and the per-tile rotation
  // state by each tile's own "↻ 1/3" / "• fixed" readout. Keeping the
  // variable around unused would leave the next reader wondering which of
  // the three the real one is.

  return (
    <div
      role="dialog"
      aria-label="Tile selection"
      style={{
        position: "fixed",
        left: draggedLeft,
        top: draggedTop,
        width: cardWidth,
        // Content-driven height (design note #7): one row, so this cap only
        // ever bites on a very short viewport, where the row scrolls.
        maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
        background: "#1c2620",
        border: "1px solid #3a4a3f",
        borderRadius: 12,
        // Lifts while dragging so the card reads as picked up, and so it
        // clears the board art it is being moved across.
        boxShadow: drag.dragging ? "0 22px 56px rgba(0,0,0,0.65)" : "0 12px 32px rgba(0,0,0,0.5)",
        color: "#eaf2ea",
        fontFamily: FONT_FAMILY,
        // Every unstyled string in this card inherits this, so the base
        // readability is set once here rather than per element.
        fontSize: FONT_SIZE.body,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        // No transition on left/top: the card must track the pointer
        // exactly during a drag, and any easing reads as lag.
        userSelect: drag.dragging ? "none" : undefined,
      }}
    >
      {/* ---- Header / drag handle (design note #10) --------------------- */}
      <div
        {...drag.handleProps}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          padding: "14px 18px",
          borderBottom: "1px solid #3a4a3f",
          // The whole header is the handle, which is the convention every
          // desktop window uses -- so it needs no instruction beyond the
          // cursor. `grabbing` while active gives the drag its feedback.
          cursor: drag.dragging ? "grabbing" : "grab",
          background: drag.dragging ? "#243128" : "transparent",
          // Stops the browser from claiming the gesture for panning/scroll
          // on touch and pen, which would otherwise pre-empt the drag
          // entirely on a trackpad or tablet.
          touchAction: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
          <span aria-hidden="true" style={{ opacity: 0.5, fontSize: FONT_SIZE.body }}>
            ⠿
          </span>
          <span style={{ fontWeight: 700, fontSize: FONT_SIZE.heading }}>Lay Tile</span>
          <span style={{ opacity: 0.85, fontSize: FONT_SIZE.control, whiteSpace: "nowrap" }}>
            {hexLabel} &middot; ({q}, {r})
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {/* Interaction legend. Double-click and drag are both
              non-discoverable gestures, so both are stated outright. */}
          {tileCount > 0 && (
            <span style={{ opacity: 0.7, fontSize: FONT_SIZE.small, whiteSpace: "nowrap" }}>
              Click to select &middot; Double-click to rotate &middot; Drag this bar to move
            </span>
          )}
          {/* Only offered once it would do something. A "reset position"
              control on a card that has never moved is clutter. */}
          {hasBeenDragged && (
            <button
              type="button"
              onClick={drag.reset}
              title="Snap the picker back beside the hex you clicked"
              style={{
                background: "transparent",
                border: "1px solid #3a4a3f",
                borderRadius: 6,
                color: "#eaf2ea",
                fontSize: FONT_SIZE.small,
                cursor: "pointer",
                padding: "4px 10px",
                whiteSpace: "nowrap",
              }}
            >
              ⤺ Snap back
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close tile selection popup"
            style={{
              background: "transparent",
              border: "none",
              color: "#eaf2ea",
              fontSize: FONT_SIZE.display,
              cursor: "pointer",
              lineHeight: 1,
              padding: "0 4px",
            }}
          >
            &times;
          </button>
        </div>
      </div>

      {/* ---- Offline banner (design note #6, unchanged in substance) ---- */}
      {offline && (
        <div
          style={{
            margin: "12px 16px 0",
            padding: "10px 12px",
            borderRadius: 8,
            background: "#3a3320",
            border: "1px solid #8a7332",
            color: "#f0d9a0",
            fontSize: FONT_SIZE.small,
            lineHeight: 1.45,
          }}
        >
          <strong>Offline preview &mdash; not validated.</strong> No chain connection, so the
          contract was never asked. This is the whole local catalog, browsable by era &mdash;
          era locks, connectivity, hex reservations, upgrade steps and tray supply have{" "}
          <em>not</em> been checked, and placement is disabled.
        </div>
      )}

      {/* ---- Era tabs, OFFLINE ONLY (design note #8) -------------------- */}
      {offline && availableEras.length > 1 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 16px 0",
          }}
        >
          <span style={{ fontSize: FONT_SIZE.small, opacity: 0.7 }}>Era</span>
          {([null, ...availableEras] as const).map((tier) => {
            const isActive = eraFilter === tier;
            const label = tier ?? "All";
            const count = tier
              ? allGroups.filter((group) => group.tier === tier).length
              : allGroups.length;
            return (
              <button
                key={label}
                type="button"
                onClick={() => setEraFilter(tier)}
                aria-pressed={isActive}
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  fontSize: FONT_SIZE.control,
                  cursor: "pointer",
                  color: "inherit",
                  font: "inherit",
                  background: isActive ? "#2f4a37" : "transparent",
                  border: `1px solid ${
                    isActive && tier ? TIER_LABEL_COLOR[tier] : isActive ? "#6fcf7c" : "#3a4a3f"
                  }`,
                }}
              >
                {label}{" "}
                <span style={{ opacity: 0.6, fontSize: FONT_SIZE.small }}>({count})</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ---- The single tile row --------------------------------------- */}
      {tileCount === 0 ? (
        <div style={{ padding: "22px 18px", opacity: 0.8, fontSize: FONT_SIZE.control }}>
          {offline && eraFilter
            ? `No ${eraFilter} tiles in the catalog.`
            : "No legal tile placements at this hex right now."}
        </div>
      ) : (
        <div style={{ padding: "14px 18px 6px", minHeight: 0 }}>
          {/* Design note #9: the old two-item caption row is down to one
              item. `rotationHint` ("Double-click a tile to rotate it" /
              "This tile has only one legal rotation") was removed as
              redundant clutter -- the header legend already states the
              double-click gesture permanently, and the per-tile rotation
              readout below already shows "1/3" or "fixed", which says the
              same thing about the specific tile in the place you are
              looking. Three statements of one fact is two too many. */}
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: FONT_SIZE.control, opacity: 0.85 }}>
              {/* Design note #6: "Catalog tiles" offline, never "Legal". */}
              {offline ? "Catalog tiles" : "Legal tiles"} ({tileCount})
            </span>
          </div>

          {/* ONE row. Horizontal scroll rather than wrapping, so the tier
              ordering stays a single readable Yellow -> Green -> Brown
              progression left to right (design note #5). */}
          <div
            role="listbox"
            aria-label={offline ? "Catalog tiles" : "Legal tiles"}
            style={{
              display: "flex",
              gap: 12,
              overflowX: "auto",
              overflowY: "hidden",
              paddingBottom: 12,
            }}
          >
            {groups.map((group) => {
              const isSelected = group.tileId === selectedTileId;
              // The selected tile renders at its LIVE rotation, in place --
              // this is what "rotates it right there in the row" means, and
              // is why the old bottom preview panel is gone. Unselected
              // tiles show their first legal orientation.
              const shownOrientation =
                isSelected && selectedOrientation !== null
                  ? selectedOrientation
                  : group.orientations[0];
              const canRotate = group.orientations.length > 1;
              return (
                <button
                  key={group.tileId}
                  ref={(node) => {
                    if (node) tileButtonRefs.current.set(group.tileId, node);
                    else tileButtonRefs.current.delete(group.tileId);
                  }}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => handleSelectTile(group.tileId)}
                  onDoubleClick={() => handleRotateTile(group.tileId)}
                  onKeyDown={(event) => {
                    // Keyboard equivalent of the double click -- design
                    // note #7. `r` and the arrow keys rotate; Enter/Space
                    // are left alone because the browser already turns
                    // those into a `click`, which selects.
                    if (event.key === "r" || event.key === "R" || event.key === "ArrowRight") {
                      event.preventDefault();
                      handleRotateTile(group.tileId);
                    }
                  }}
                  title={
                    canRotate
                      ? `Tile #${group.tileId} -- double-click (or press R) to rotate`
                      : `Tile #${group.tileId} -- only one legal rotation here`
                  }
                  style={{
                    flex: "0 0 auto",
                    padding: "10px 12px 8px",
                    background: isSelected ? "#2f4a37" : "#26332a",
                    border: isSelected ? "2px solid #6fcf7c" : "2px solid transparent",
                    borderRadius: 10,
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 6,
                    color: "inherit",
                    font: "inherit",
                    // Stops a double click from selecting the label text
                    // underneath it, which otherwise flashes a highlight on
                    // every rotation.
                    userSelect: "none",
                  }}
                >
                  {/* Design note #9: 104px -> 150px (originally 56px). The
                      artwork IS the content of this picker -- everything
                      else on the card is a label for it -- so it gets the
                      space. At 150px the track geometry of a #57 vs a #9 is
                      distinguishable without leaning in. */}
                  <div style={{ position: "relative" }}>
                    <TilePreviewThumbnail
                      tileId={group.tileId}
                      orientation={shownOrientation}
                      size={150}
                      hexSize={64}
                    />

                    {/* Design note #9: REVENUE, the number that actually
                        decides which tile you want, overlaid on the artwork
                        rather than listed underneath it. Placement is the
                        point: revenue is a property OF the tile, and a
                        player scanning the row compares artwork, so the
                        figure has to live where their eye already is. Gold
                        on near-black is the highest-contrast pairing on
                        this card and is used for nothing else, so the
                        numbers read as a set at a glance.

                        Absent for plain track -- see `TileGroup.revenue`
                        for why no badge beats a "0". */}
                    {group.revenue !== null && (
                      <span
                        title={`Printed revenue: ${group.revenue}`}
                        style={{
                          position: "absolute",
                          top: 4,
                          right: 4,
                          minWidth: 34,
                          padding: "3px 9px",
                          borderRadius: 999,
                          background: "#0d0f0c",
                          border: "2px solid #e8c860",
                          color: "#ffd970",
                          fontSize: FONT_SIZE.control,
                          fontWeight: 800,
                          lineHeight: 1.15,
                          textAlign: "center",
                          fontVariantNumeric: "tabular-nums",
                          boxShadow: "0 2px 6px rgba(0,0,0,0.6)",
                          pointerEvents: "none",
                        }}
                      >
                        {group.revenue}
                      </span>
                    )}
                  </div>

                  <span style={{ fontSize: FONT_SIZE.heading, fontWeight: 700, lineHeight: 1 }}>
                    #{group.tileId}
                  </span>
                  <span
                    style={{
                      fontSize: FONT_SIZE.micro,
                      letterSpacing: 0.6,
                      textTransform: "uppercase",
                      color: group.tier ? TIER_LABEL_COLOR[group.tier] : "#8a8a8a",
                      lineHeight: 1,
                    }}
                  >
                    {group.tier ?? "Unmapped"}
                  </span>
                  {/* Live rotation readout on the selected tile only, so
                      the row stays uncluttered but the thing you are
                      currently turning always shows where it is. */}
                  <span
                    style={{
                      fontSize: FONT_SIZE.small,
                      opacity: isSelected ? 0.9 : 0,
                      lineHeight: 1,
                      whiteSpace: "nowrap",
                      // Reserved even when invisible, so selecting a tile
                      // doesn't jog the row's height.
                      visibility: isSelected ? "visible" : "hidden",
                    }}
                  >
                    {canRotate
                      ? `↻ ${group.orientations.indexOf(shownOrientation) + 1}/${group.orientations.length}`
                      : "• fixed"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ---- Footer ---------------------------------------------------- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          padding: "12px 16px",
          borderTop: "1px solid #3a4a3f",
        }}
      >
        <div style={{ minWidth: 0, fontSize: FONT_SIZE.small, lineHeight: 1.45 }}>
          {dispatchState.status === "error" && (
            <div style={{ color: "#e08080", marginBottom: 4 }}>{dispatchState.message}</div>
          )}
          {/* Design note #6: offline suppresses the session-key hint, which
              would otherwise imply a session key is the one thing between
              the player and a placement, when the real blocker is that
              there is no chain and no contract has approved this tile. */}
          {!offline && sessionStatus !== "ready" && (
            <div style={{ opacity: 0.75, marginBottom: 4 }}>
              Session key not ready -- initialize it before dispatching.
            </div>
          )}
          {selectedGroup && selectedOrientation !== null && (
            <div style={{ opacity: 0.8 }}>
              {offline ? (
                <>
                  Artwork preview only &mdash; tile{" "}
                  <strong>#{selectedGroup.tileId}</strong> at orientation{" "}
                  <strong>{selectedOrientation}</strong> cannot be laid without a chain
                  connection.
                </>
              ) : (
                <>
                  Tile <strong>#{selectedGroup.tileId}</strong> will be laid at orientation{" "}
                  <strong>{selectedOrientation}</strong>
                  {selectedGroup.orientations.length > 1 && (
                    <span style={{ opacity: 0.7 }}>
                      {" "}
                      (of legal: {selectedGroup.orientations.join(", ")})
                    </span>
                  )}
                  .
                </>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={handleConfirmPlacement}
          disabled={dispatchDisabled}
          style={{
            flex: "0 0 auto",
            padding: "12px 28px",
            background: dispatchDisabled ? "#3a4a3f" : "#3f8f4f",
            color: "#eaf2ea",
            border: "none",
            borderRadius: 8,
            fontWeight: 700,
            fontSize: FONT_SIZE.control,
            cursor: dispatchDisabled ? "default" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {offline
            ? "Placement unavailable (offline)"
            : dispatchState.status === "pending"
              ? "Broadcasting..."
              : "Confirm Placement"}
        </button>
      </div>
    </div>
  );
}

export default TileSelectionPopup;
