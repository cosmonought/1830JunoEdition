// frontend/src/components/TileSelectionPopup.tsx
//
// The floating tile-selection overlay -- the modal-panel half of the click-to-lay-a-tile flow.
// `HexGridRenderer.tsx`'s click interceptor (#7 there) owns converting a canvas click to `(q, r)` and
// firing `GetLegalTilePlacements`; this file owns everything after that query resolves.
//
// UNRENDERED since `App.tsx` design note #162 -- `RadialTileSelector` replaced it. Retained, unmounted,
// until the radial path has been exercised against a live chain.
//
// Design note #1: self-contained dispatch -- this calls `execGameplay` itself rather than asking `App.tsx`
// to dispatch on its behalf, which is why `App.tsx #23` must not MOUNT it for a spectator.
// Design note #2: the rotation is a BINDING choice now. `orientation` is a required message field and the
// contract commits exactly what is submitted; a prior pass was built against a contract that auto-picked.
// Design note #4: no client-side re-validation -- the carousel only offers ids the contract returned.
// Design note #6: `offline` means these came from the local catalog mirror, filtered by NOTHING at all.
//
// Design history: see `docs/ai_architecture/canvas_rendering.md`.

// Design note #7: FLATTENED SINGLE-ROW LAYOUT, DOUBLE-CLICK TO ROTATE. The split was the substantive
// complaint: a cramped strip of thumbnails on top and a second panel below holding ONE enlarged copy of the
// selection, which was also the only surface that rotated -- so the tile you were turning was never the
// tile you had just clicked, and comparing two candidates meant selecting each in turn and reading the
// bottom panel twice. That panel is deleted and its job folded into the row.
// Single click selects, double click rotates; the one real trap is documented at `handleSelectTile`.
// Because double-click is undiscoverable it is also stated in the header legend, in each tile's `title` and
// as a live rotation readout, and because it is unreachable by keyboard, `r` and `ArrowRight` do the same
// (Enter/Space are left alone -- the browser already turns those into a `click`, which selects).
// The row scrolls horizontally rather than wrapping, which keeps #5's tier ordering legible as one
// left-to-right progression -- most important offline, where a Brown-era tray is all 46 catalog tiles.

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
  /** Design note #6: these placements did NOT come from the contract. No chain client was available, so the
   *  renderer fell back to its local catalog mirror. Makes the popup label itself provisional and hard-refuse
   *  to dispatch. Defaults to `false`, so the contract-backed path is entirely unaffected. */
  offline?: boolean;
  /** Offline sandbox hotseat mode -- a NARROWER claim than `offline`, and the difference is the whole point.
   *  `offline` means "no chain answered, so these tiles are unvalidated", which is true here too and keeps the
   *  provisional labelling on. What `offline` ALSO meant, until this prop existed, was "there is nowhere for a
   *  placement to go" -- and that is no longer true: the sandbox has a local reducer that accepts the lay.
   *  So `sandbox` re-enables Confirm and routes it locally. A plain `offline` popup -- a spectator, or a dev
   *  whose RPC dropped -- still hard-refuses, because for those two there genuinely is no destination and a
   *  placement would be a lie. Ignored unless `offline` is also set. */
  sandbox?: boolean;
  /** Where a sandbox placement goes instead of the chain. Called with the
   *  confirmed tile and rotation; the host applies it to the local board. */
  onSandboxLay?: (placement: { tileId: number; orientation: number }) => void;
}

/** Live viewport size, for design note #7's flip-aware positioning. The old 280px card read `window.inner*`
 *  during render and never subscribed to `resize` -- survivable when the card is narrow, and not when
 *  `cardWidth` itself is derived from the viewport: a stale reading can leave the card wider than the window
 *  and hang its right-hand tiles off-screen with no way to scroll to them. SSR-safe defaults, since this is
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

// Design note #10: DRAGGING. The card is anchored next to the clicked hex (#3) and flips to avoid the
// viewport edge (#7), but on a dense board no side is guaranteed clear -- and auto-placement cannot solve
// that, because only the player knows which neighbours they are comparing against.
// Four implementation notes, each a bug avoided:
//   - POINTER EVENTS, not mouse events. One path covers mouse, touch and pen, and `setPointerCapture` keeps
//     tracking when the cursor outruns the card or crosses the canvas underneath.
//   - OFFSET-BASED, not delta-accumulating, so the card never slides relative to the cursor over a long drag
//     the way accumulated deltas do once a frame is dropped.
//   - THE OFFSET RESETS on re-anchor -- a dragged position is a statement about one hex's surroundings.
//     Keyed on the anchor coordinates rather than `(q, r)`, so it also resets when the board is panned.
//   - CLAMPED so the card can never be dragged fully off-screen, which would strand its close button. The
//     clamp keeps the WHOLE card inside the viewport -- one that is 90% off-screen is not recoverable.

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
  /** The tile's own PRINTED revenue, from the shared catalog mirror -- design note #9. `null` for plain track
   *  and also `null` for an id the mirror has not caught up to, and the two are deliberately NOT distinguished
   *  in the UI: rendering "0" for a track tile would be wrong and "?" for a catalog gap would be noise, so
   *  both simply show no badge. */
  revenue: number | null;
}

/** Groups placements by `tile_id`, sorting each tile's orientations ascending purely for a stable initial
 *  selection -- design note #2: every orientation is an equally real, submittable choice now.
 *  Design note #5: groups are ordered by COLOUR TIER first, then tray number within a tier. Under the old
 *  synthetic ids an ascending numeric sort happened to produce that order for free; real 1830 tray numbers
 *  carry no such guarantee -- Yellow #55-#58 sort above Green #14-#29 and Brown #39-#47 below both -- so an
 *  ascending sort now interleaves the eras arbitrarily. The tier is read from the single shared mirror. */
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
  sandbox = false,
  onSandboxLay,
}: TileSelectionPopupProps) {
  const { execGameplay, sessionStatus } = useGameSession();

  // Design note #162: the sandbox legality narrowing and the empty-tray explanation that sat here are GONE,
  // along with this component's rendering. `RadialTileSelector` owns both now. Keeping a second, diverging
  // copy of the filter wired up to a component nothing mounts would be the drift hazard, not insurance.
  const allGroups = useMemo(() => groupPlacementsByTile(placements), [placements]);

  // The era tab strip's filter (design note #8), unchanged. `groups` is what
  // the carousel renders.
  const [eraFilter, setEraFilter] = useState<TileColorTier | null>(null);
  const availableEras = useMemo(() => {
    const present = new Set(allGroups.map((group) => group.tier).filter(Boolean));
    return (["Yellow", "Green", "Brown"] as const).filter((tier) => present.has(tier));
  }, [allGroups]);
  const groups = useMemo(
    () => (eraFilter ? allGroups.filter((group) => group.tier === eraFilter) : allGroups),
    [allGroups, eraFilter],
  );
  const emptyReason: string | null = null;

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
    // Intentionally omitting `onPreviewChange` from deps -- `App.tsx` passes a fresh inline setter each render,
    // and depending on it would refire this effect every render for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTileId, selectedOrientation, q, r]);

  // Clear the board preview on unmount (e.g. popup closed) so a stale ghost
  // tile doesn't linger on the board after the popup itself is gone.
  useEffect(() => {
    return () => onPreviewChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Design note #7: keep the selected tile scrolled into view in the single row. Matters most offline in the
  // Brown era, where the row holds all 46 catalog tiles and a keyboard user can walk the selection off the
  // right-hand edge. `block: "nearest"` so this never scrolls the PAGE, only the row's own container.
  const tileButtonRefs = useRef(new Map<number, HTMLButtonElement>());
  useEffect(() => {
    if (selectedTileId === null) return;
    tileButtonRefs.current
      .get(selectedTileId)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedTileId]);

  // Design note #7: single click selects. The `tileId === selectedTileId` early return is what makes
  // double-click-to-rotate work at all, and is easy to delete by accident: a double click dispatches `click`,
  // `click`, THEN `dblclick`, so if selecting always reset the rotation those two leading clicks would zero
  // it a beat before `dblclick` advanced it -- every double click would land on index 1 and the tile would
  // appear stuck one step from home. Resetting only on a genuine tile CHANGE fixes that.
  // What this does NOT do: the orientation index is one shared value, not a per-tile map, so switching tiles
  // and back restarts at the first legal orientation. Deliberate for now, and the obvious next step if
  // players ask to compare two part-rotated tiles side by side.
  // Design note #8: switching era tabs can hide the selection, so it is pulled back to the first visible tile
  // -- a stale id would blank the footer readout and strand a ghost preview on a hex the player can no longer
  // see the tile for.
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
      // A double click that landed on a tile which was not selected. In practice React has already processed the
      // two leading clicks and re-rendered, so this is a rare-but-real ordering guard rather than the usual path:
      // select it AND take the first rotation step, so the gesture always visibly does something.
      setSelectedTileId(tileId);
      setOrientationIndex(1 % group.orientations.length);
      return;
    }
    if (group.orientations.length <= 1) return;
    setOrientationIndex((prev) => (prev + 1) % group.orientations.length);
  };

  const handleConfirmPlacement = async () => {
    // Sandbox: apply locally and stop. Deliberately BEFORE the offline hard stop below, and deliberately never
    // touching `execGameplay` -- there is no session, no signer and no chain, so calling the dispatch path would
    // hang on a request nobody can answer and then surface a wallet error for a game that is not on a chain.
    if (sandbox) {
      if (selectedTileId === null || selectedOrientation === null) return;
      onSandboxLay?.({ tileId: selectedTileId, orientation: selectedOrientation });
      onClose();
      return;
    }

    // Design note #6: a hard stop, not merely a disabled button. The button below is already disabled offline,
    // but this path is what guarantees an unvalidated, locally-invented placement can never reach
    // `execGameplay` -- there is no contract behind these tiles to have approved them.
    // Still reached by a NON-sandbox offline popup (a spectator, or a dropped RPC), which is who it is for.
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

  // Design note #7: smart positioning for a card ~3x wider than the one the original clamp was written for.
  // The old version clamped against a hardcoded size and read `window.inner*` during render, which was fine
  // for a small card and is not for a wide one: at 900px a card anchored right of a click past mid-screen
  // would be shoved against the right edge, sliding it far from the hex it belongs to. So it FLIPS to the
  // other side of the cursor when the preferred side does not fit, and only clamps as a last resort.
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
  // Height is content-driven, so this is only the reservation used for flip decisions -- the card itself is
  // capped by `maxHeight` and will usually be shorter.
  // Design note #9: raised alongside the tile upscale. This drives the flip-above/below decision, so leaving
  // it at the old value would have had the card decide it fits below the cursor when it no longer does, and
  // open with its Confirm button past the bottom edge.
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

  // Drag -- design note #10. Applied ON TOP of the auto-placement rather than replacing it: the card still
  // opens next to the hex you clicked and dragging moves it from there. Re-anchoring resets the offset, so
  // the two never fight -- auto-placement decides where it OPENS, the drag decides where it SITS.
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

  // A sandbox confirm needs a selection and nothing else: there is no
  // session to be "ready" and no dispatch that can be "pending", so folding
  // those two in would disable the button permanently for the one mode that
  // is supposed to be interactive.
  const dispatchDisabled = sandbox
    ? selectedTileId === null || selectedOrientation === null
    : offline ||
      selectedTileId === null ||
      selectedOrientation === null ||
      sessionStatus !== "ready" ||
      dispatchState.status === "pending";

  const tileCount = groups.length;
  // Design note #9: `rotationHint` is REMOVED, not merely unrendered. Both of its strings are now stated
  // closer to where they matter -- the gesture by the permanent header legend, the per-tile rotation state by
  // each tile's own readout. Keeping the variable around unused would leave the next reader wondering which
  // of the three is the real one.

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
          <strong>
            {sandbox ? "Sandbox preview" : "Offline preview"} &mdash; not validated.
          </strong>{" "}
          No chain connection, so the contract was never asked. This is the whole local
          catalog, browsable by era &mdash; era locks, connectivity, hex reservations,
          upgrade steps and tray supply have <em>not</em> been checked
          {sandbox ? (
            <>
              . You can still place it: the sandbox will accept tiles the real game would
              refuse, which is exactly what makes it useful for exercising the picker.
            </>
          ) : (
            <>, and placement is disabled.</>
          )}
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
          {/* Design note #9: the old two-item caption row is down to one. `rotationHint` was removed as redundant
             clutter -- the header legend already states the double-click gesture permanently, and the per-tile
             readout already shows "1/3" or "fixed" in the place you are looking. Three statements of one fact is two
             too many. */}
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
            {emptyReason && (
              <p
                style={{
                  margin: 0,
                  padding: "14px 12px",
                  fontSize: FONT_SIZE.small,
                  color: "#c9b98a",
                  lineHeight: 1.45,
                }}
              >
                {emptyReason}
              </p>
            )}
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
                      ? `Tile #${group.tileId} — double-click (or press R) to rotate`
                      : `Tile #${group.tileId} — only one legal rotation here`
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
                  {/* Design note #9: 104px -> 150px (originally 56px). The artwork IS the content of this picker --
                     everything else on the card is a label for it -- so it gets the space. At 150px the track geometry of a
                     #57 versus a #9 is distinguishable without leaning in. */}
                  <div style={{ position: "relative" }}>
                    <TilePreviewThumbnail
                      tileId={group.tileId}
                      orientation={shownOrientation}
                      size={150}
                      hexSize={64}
                    />

                    {/* Design note #9: REVENUE, the number that actually decides which tile you want, overlaid on the artwork
                       rather than listed underneath. Placement is the point: revenue is a property OF the tile, and a player
                       scanning the row compares artwork, so the figure has to live where their eye already is. Gold on
                       near-black is the highest-contrast pairing on this card and is used for nothing else.
                       Absent for plain track -- see the group's own note for why no badge beats a "0". */}
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
              Session key not ready — initialize it before dispatching.
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
          {sandbox
            ? "Confirm Lay (sandbox)"
            : offline
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
