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
//    clicking the hex preview changes which of `placements`' legal
//    orientations is currently selected, and "Confirm Placement" submits
//    exactly that one.
// 3. **Floating position, not a fixed layout.** `anchorClientX`/
//    `anchorClientY` (the raw `event.clientX`/`clientY` from
//    `HexGridRenderer`'s `onHexClick`) position this card via `position:
//    fixed` with a small offset, clamped so it can't render off the right/
//    bottom edge of the viewport. This deliberately does NOT try to
//    project the hex's on-canvas position through the canvas's own pan/
//    zoom transform a second time -- the click's own screen coordinates are
//    already exactly where the player just clicked, which is the more
//    honest anchor point for a floating popup than re-deriving it.
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
//    offline tray is filtered by ERA AND NOTHING ELSE -- no connectivity, no
//    landmark/OO/"B"/"NY" reservation, no upgrade colour step, no tray
//    depletion -- so most of what it shows would be rejected outright by
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

import React, { useEffect, useMemo, useState } from "react";
import type { DeliverTxResponse } from "@cosmjs/stargate";

import { useGameSession } from "../context/GameSessionContext";
import { TilePreviewThumbnail, TILE_CATALOG_BY_ID } from "./HexGridRenderer";
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

/** One carousel entry: a legal `tile_id` plus every orientation the
 *  contract will currently accept for it at this hex. `tier` is resolved
 *  from `HexGridRenderer.tsx`'s catalog mirror and is `null` for an id that
 *  mirror hasn't caught up to (see design note #5). */
interface TileGroup {
  tileId: number;
  orientations: number[];
  tier: TileColorTier | null;
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
  const groups: TileGroup[] = Array.from(byTile.entries()).map(([tileId, orientations]) => ({
    tileId,
    orientations: [...orientations].sort((a, b) => a - b),
    tier: TILE_CATALOG_BY_ID.get(tileId)?.color ?? null,
  }));
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

  const groups = useMemo(() => groupPlacementsByTile(placements), [placements]);

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

  const handleSelectTile = (tileId: number) => {
    setSelectedTileId(tileId);
    setOrientationIndex(0);
    setDispatchState({ status: "idle" });
  };

  const handleCycleOrientation = () => {
    if (!selectedGroup || selectedGroup.orientations.length <= 1) return;
    setOrientationIndex((prev) => (prev + 1) % selectedGroup.orientations.length);
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

  // Clamp so the card can't render off the right/bottom edge of the
  // viewport -- see design note #3.
  const CARD_WIDTH = 280;
  const CARD_MAX_HEIGHT = 420;
  const OFFSET = 16;
  const left = Math.min(
    Math.max(8, anchorClientX + OFFSET),
    (typeof window !== "undefined" ? window.innerWidth : 1200) - CARD_WIDTH - 8,
  );
  const top = Math.min(
    Math.max(8, anchorClientY + OFFSET),
    (typeof window !== "undefined" ? window.innerHeight : 800) - CARD_MAX_HEIGHT - 8,
  );

  const dispatchDisabled =
    offline ||
    selectedTileId === null ||
    selectedOrientation === null ||
    sessionStatus !== "ready" ||
    dispatchState.status === "pending";

  return (
    <div
      style={{
        position: "fixed",
        left,
        top,
        width: CARD_WIDTH,
        maxHeight: CARD_MAX_HEIGHT,
        background: "#1c2620",
        border: "1px solid #3a4a3f",
        borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        color: "#eaf2ea",
        fontFamily: "sans-serif",
        fontSize: 13,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px",
          borderBottom: "1px solid #3a4a3f",
        }}
      >
        <div>
          <div style={{ fontWeight: 700 }}>Lay Tile</div>
          <div style={{ opacity: 0.75, fontSize: 11 }}>
            {hexLabel} &middot; ({q}, {r})
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close tile selection popup"
          style={{
            background: "transparent",
            border: "none",
            color: "#eaf2ea",
            fontSize: 16,
            cursor: "pointer",
            lineHeight: 1,
          }}
        >
          &times;
        </button>
      </div>

      <div style={{ padding: "10px 12px", overflowY: "auto" }}>
        {/* Design note #6: unmissable, above the carousel rather than
            tucked in the footer, because the tiles below LOOK exactly like
            contract-approved ones. Says plainly what was and wasn't
            checked, so nobody reads this tray as a legality answer. */}
        {offline && (
          <div
            style={{
              marginBottom: 8,
              padding: "6px 8px",
              borderRadius: 6,
              background: "#3a3320",
              border: "1px solid #8a7332",
              color: "#f0d9a0",
              fontSize: 11,
              lineHeight: 1.35,
            }}
          >
            <strong>Offline preview &mdash; not validated.</strong> No chain connection, so
            the contract was never asked. These are the local catalog&rsquo;s tiles for the
            current era only: connectivity, hex reservations, upgrade steps and tray supply
            have <em>not</em> been checked, and placement is disabled.
          </div>
        )}
        {groups.length === 0 ? (
          <div style={{ opacity: 0.75 }}>No legal tile placements at this hex right now.</div>
        ) : (
          <>
            <div style={{ marginBottom: 6, opacity: 0.85 }}>
              {offline ? "Catalog tiles" : "Legal tiles"} ({groups.length}) &mdash; scroll to see
              more:
            </div>
            {/* Scrollable gallery carousel of legal tile_id entries. */}
            <div
              style={{
                display: "flex",
                gap: 8,
                overflowX: "auto",
                paddingBottom: 8,
                marginBottom: 10,
              }}
            >
              {groups.map((group) => {
                const isSelected = group.tileId === selectedTileId;
                return (
                  <button
                    key={group.tileId}
                    type="button"
                    onClick={() => handleSelectTile(group.tileId)}
                    style={{
                      flex: "0 0 auto",
                      padding: 4,
                      background: isSelected ? "#2f4a37" : "#26332a",
                      border: isSelected ? "2px solid #6fcf7c" : "2px solid transparent",
                      borderRadius: 8,
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 2,
                    }}
                  >
                    <TilePreviewThumbnail tileId={group.tileId} orientation={group.orientations[0]} size={56} hexSize={24} />
                    {/* Real 1830 tray number -- see design note #5. */}
                    <span style={{ fontSize: 11 }}>#{group.tileId}</span>
                    <span
                      style={{
                        fontSize: 9,
                        letterSpacing: 0.3,
                        textTransform: "uppercase",
                        color: group.tier ? TIER_LABEL_COLOR[group.tier] : "#8a8a8a",
                      }}
                    >
                      {group.tier ?? "Unmapped"}
                    </span>
                  </button>
                );
              })}
            </div>

            {selectedGroup && selectedOrientation !== null && (
              <div style={{ textAlign: "center" }}>
                <div style={{ opacity: 0.85, marginBottom: 4 }}>
                  Click the preview to choose your rotation:
                </div>
                <button
                  type="button"
                  onClick={handleCycleOrientation}
                  disabled={selectedGroup.orientations.length <= 1}
                  title="Cycle through this tile's legal orientations"
                  style={{
                    background: "transparent",
                    border: "1px dashed #6fcf7c",
                    borderRadius: 8,
                    padding: 4,
                    cursor: selectedGroup.orientations.length > 1 ? "pointer" : "default",
                  }}
                >
                  <TilePreviewThumbnail
                    tileId={selectedGroup.tileId}
                    orientation={selectedOrientation}
                    size={96}
                    hexSize={40}
                  />
                </button>
                <div style={{ fontSize: 11, opacity: 0.75, marginTop: 4 }}>
                  Orientation {selectedOrientation} of{" "}
                  {/* Design note #6: offline, all six rotations are offered
                      because nothing filtered them -- calling that list
                      "legal" would be a claim the contract never made. */}
                  {offline ? "all" : "legal"}: {selectedGroup.orientations.join(", ")}
                </div>
                {/* See design note #2: this used to be a "preview only"
                    disclaimer back when LayTile had no orientation field
                    and the contract always auto-picked the lowest legal
                    rotation. That's no longer true -- the contract now
                    commits exactly this selected orientation -- so this is
                    a plain confirmation of what will actually be
                    submitted, not a caveat. Design note #6 restores a
                    genuine caveat for the offline case only, where there is
                    no contract to commit anything. */}
                <div style={{ fontSize: 10, opacity: 0.6, marginTop: 2, fontStyle: "italic" }}>
                  {offline ? (
                    <>
                      Artwork preview only &mdash; tile #{selectedGroup.tileId} at orientation{" "}
                      {selectedOrientation} cannot be laid without a chain connection.
                    </>
                  ) : (
                    <>
                      Tile #{selectedGroup.tileId} will be laid at exactly this orientation (
                      {selectedOrientation}) when confirmed.
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ padding: "10px 12px", borderTop: "1px solid #3a4a3f" }}>
        {dispatchState.status === "error" && (
          <div style={{ color: "#e08080", fontSize: 11, marginBottom: 6 }}>
            {dispatchState.message}
          </div>
        )}
        {/* Design note #6: offline suppresses the session-key hint, which
            would otherwise be actively misleading -- it implies initializing
            a session key is the one thing standing between the player and a
            placement, when the real blocker is that there is no chain to
            place onto and no contract has approved this tile. */}
        {!offline && sessionStatus !== "ready" && (
          <div style={{ opacity: 0.7, fontSize: 11, marginBottom: 6 }}>
            Session key not ready -- initialize it before dispatching.
          </div>
        )}
        <button
          type="button"
          onClick={handleConfirmPlacement}
          disabled={dispatchDisabled}
          style={{
            width: "100%",
            padding: "8px 0",
            background: dispatchDisabled ? "#3a4a3f" : "#3f8f4f",
            color: "#eaf2ea",
            border: "none",
            borderRadius: 6,
            fontWeight: 700,
            cursor: dispatchDisabled ? "default" : "pointer",
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
