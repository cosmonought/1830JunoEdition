// frontend/src/components/RadialTileSelector.tsx
//
// The in-situ radial tile picker -- candidate tiles arranged around the hex
// you clicked, in the 18xx.games idiom.
//
// ===================================================================
//  DESIGN NOTE 0: WHY THE RING IS DOM AND THE PREVIEW IS CANVAS
// ===================================================================
//
// This is a deliberate split, not an inconsistency.
//
// THE PREVIEW IS CANVAS. When a candidate is chosen it is drawn onto the
// board itself, through the renderer's existing `previewTile` path, at the
// real hex, at the real zoom, in the real palette, with the real
// neighbouring track either side of it. That is the entire point of an
// in-situ picker: you are judging whether the tile FITS, and a thumbnail
// in a panel cannot answer that question no matter how accurate it is.
//
// THE RING IS DOM. The candidates themselves are buttons in an absolutely
// positioned overlay. Drawing them into the canvas would mean hand-rolling
// hit-testing, hover, focus, keyboard traversal and disabled states that
// the platform already provides correctly -- and getting one of them subtly
// wrong is how a picker becomes unusable with a trackpad or unreachable
// without a mouse. Each candidate still renders its REAL artwork, because
// `TilePreviewThumbnail` is itself a canvas drawn from the same catalog the
// board uses; there is no second, diverging illustration of a tile
// anywhere.
//
// ===================================================================
//  DESIGN NOTE 1: ANCHORED TO THE BOARD, NOT TO THE VIEWPORT
// ===================================================================
//
// The anchor was the click's raw `clientX`/`clientY`, frozen at the moment
// of the click and rendered `position: fixed`. Fixed positioning is
// relative to the VIEWPORT, so the instant the page scrolled the board slid
// away underneath a ring that stayed exactly where it was. The menu
// detached from its own hex and floated over unrelated parts of the screen.
//
// What is stored now is the click's offset INSIDE THE CANVAS -- a board
// coordinate, unaffected by where the canvas happens to be on screen. The
// on-screen position is recomputed from `canvasEl.getBoundingClientRect()`
// whenever anything could have moved it: scroll (captured, so ancestor
// scroll containers count too, not just the window) and resize.
//
// STILL NOT FOLLOWED: pan and zoom of the board itself. Those move the hex
// WITHIN the canvas, which this offset cannot see -- correcting for them
// needs the renderer's live transform, not just its rect. The ring is a
// short-lived interaction and panning mid-pick is not a flow anyone is in,
// so this is left as a stated limitation rather than a hidden one. It is
// strictly better than before either way: page scroll is the motion that
// actually happens while a picker is open.
//
// ===================================================================
//  DESIGN NOTE 2: TWO STAGES, ONE OVERLAY
// ===================================================================
//
//   CHOOSING  -- no tile picked yet. The ring is visible; the only other
//                control is a dismiss X, because there is nothing yet to
//                confirm or to revert.
//   PREVIEWING -- a tile is on the hex. The ring is hidden (it would sit on
//                top of the very thing you are now judging) and the two
//                floating action buttons appear above the hex.
//
// The X means different things in the two stages, and that is intentional
// rather than sloppy: while choosing it dismisses, while previewing it
// steps BACK to the ring. One escape control that always undoes exactly one
// step is easier to trust than two that each undo a different amount.

import React, { useEffect, useRef, useState } from "react";

import { TilePreviewThumbnail } from "./HexGridRenderer";
import { TILE_CATALOG_BY_ID } from "./hexTileCatalog";
import { COLOR_TIER_STROKE } from "./hexBoardData";
import type { LegalTilePlacement } from "./hexContractTypes";
import { FONT_SIZE } from "../styles/typography";

export interface RadialTileSelectorProps {
  /** The click's offset INSIDE the canvas -- design note #1. Board-relative,
   *  so it survives the page scrolling. */
  anchorOffsetX: number;
  anchorOffsetY: number;
  /** The canvas the offset is relative to. The ring reads its live rect to
   *  turn that offset back into a screen position. */
  canvasEl: HTMLElement | null;
  hexLabel: string;
  /** Already filtered to what may be laid here. */
  candidates: readonly LegalTilePlacement[];
  selectedTileId: number | null;
  orientation: number;
  /** Planning mode (design note #3): whether a lay may actually be
   *  dispatched right now. `false` keeps everything else working and
   *  disables only the confirm. */
  canConfirm: boolean;
  /** Shown on the disabled confirm. Required whenever `canConfirm` is
   *  false -- a disabled control with no explanation is the thing this
   *  prop exists to prevent. */
  confirmDisabledReason?: string;
  /* ==================================================================
   *  DESIGN NOTE 260: THE PROVISIONAL CAVEAT IS GONE
   * ==================================================================
   *
   * This flag used to append an italic caveat to the ring's caption
   * whenever the candidates came from the local tile catalog rather than
   * from a chain's `GetLegalTilePlacements`. The distinction is true and
   * entirely internal.
   *
   * To a player it read as a warning about the tile they were about to lay
   * -- and on the offline sandbox path EVERY candidate is local, so the tag
   * was permanently present and never varied. A caveat that never changes
   * carries no information; all it does is undermine confidence in a picker
   * that is, in fact, filtering correctly.
   *
   * The flag stays on the interface because the caller still distinguishes
   * the two sources for its own reasons (`canConfirm`, the Action Log), and
   * removing it would push that distinction out of a component that may want
   * it again. It simply no longer renders anything. */
  provisional?: boolean;
  /** Design note #173 (App.tsx): how many rotations this tile may legally
   *  take here. Drives the caption -- "click to rotate" is a lie when the
   *  tile has exactly one legal facing, and a player who clicks and sees
   *  nothing move will assume the gesture is broken rather than that it is
   *  already correct. */
  legalRotationCount?: number;
  /* ==================================================================
   *  DESIGN NOTE 271b: WHERE THE PIECES ALREADY THERE WILL END UP
   * ==================================================================
   *
   * The ring previews the TILE and says nothing about the tokens standing
   * on the hex it replaces. On an ordinary empty hex there is nothing to
   * say; on a president's own home city being split into two by an OO
   * upgrade, the one thing they want to know is which half their station
   * ends up in -- and they were finding out by looking at the board
   * afterwards.
   *
   * A string rather than a structure: this component renders a caption, and
   * `utils/tokenMigration.ts` owns what the sentence should be. `null` on
   * every hex with no tokens, which is most of them. */
  tokenNote?: string | null;
  onSelectCandidate: (tileId: number, orientation: number) => void;
  onConfirm: () => void;
  /** Step back one stage -- design note #2. */
  onCancel: () => void;
  onDismiss: () => void;
}

/* Design note #174b: the thumbnail, and with it the whole ring, is sized
   for a 1080p board rather than a 4K one. `ringRadiusFor` solves the radius
   FROM this number (design note #174 below), so shrinking the thumbnail
   shrinks the ring proportionally and the spacing maths needs no edit --
   which is the property that note was written to get. 54 -> 38. */
const THUMB = 38;

/* ===================================================================
 *  DESIGN NOTE 174: THE RADIUS IS SOLVED FOR, NOT PICKED
 * ===================================================================
 *
 * The ring used two fixed radii (104px, then 176px) with a fixed capacity
 * of 8 per ring. Fixed capacity at a fixed radius is the overlap bug: at
 * eight items the 54px thumbnails already sit about 80px apart centre to
 * centre, which is close, and any hex offering more than eight packed them
 * tighter still because the second ring only opened at nine.
 *
 * The relationship is geometric, so it can be solved rather than tuned. N
 * items evenly spaced on a circle of radius R sit `2 * R * sin(pi / N)`
 * apart, centre to centre. Requiring that to be at least the thumbnail
 * width plus a gutter and rearranging gives the radius the layout needs:
 *
 *      R  >=  needed / (2 * sin(pi / N))
 *
 * So the radius grows exactly as fast as the count demands and no faster --
 * three candidates stay in a tight, close-to-hand ring, and twelve open out
 * far enough to stay separate, with no capacity cliff between them.
 *
 * `MIN_RADIUS` keeps a small ring clear of the hex it surrounds and of the
 * action buttons above it; the `sin` term takes over from about five
 * candidates on. `N = 1` and `N = 2` are special-cased because `sin(pi/1)`
 * is 0 (a division by zero) and `sin(pi/2)` is 1 (a needlessly wide ring
 * for two items sitting opposite each other).
 */

/** Clear of the hex and of the action buttons above it. */
const MIN_RADIUS = 76;
/** Thumbnail width plus the smallest gap that still reads as a gap. */
const NEEDED_SPACING = THUMB + 14;

/** The radius this many candidates need in order not to touch. */
export function ringRadiusFor(count: number): number {
  if (count <= 2) return MIN_RADIUS;
  const required = NEEDED_SPACING / (2 * Math.sin(Math.PI / count));
  return Math.max(MIN_RADIUS, Math.ceil(required));
}

/** Polar position of candidate `index` of `count`, relative to the anchor.
 *
 *  Starts at 12 o'clock and runs clockwise, so the reading order matches
 *  the order the candidates were listed in. */
export function ringPosition(index: number, count: number): { x: number; y: number } {
  const radius = ringRadiusFor(count);
  const angle = (index / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/* ===================================================================
 *  DESIGN NOTE 200: THE CONFIRM RING IS ITS OWN COMPONENT NOW
 * ===================================================================
 *
 * Placing a station token used to be instant: click a city, the treasury is
 * charged, the token is on the board. Laying a tile -- the other thing a
 * click on the map can mean, costing a comparable amount of money and just
 * as irreversible -- has always asked for a green check first. Two board
 * interactions, two different contracts with the player, and the more
 * expensive of the two was the one with no confirmation step.
 *
 * The requirement was for the EXACT same red-X / green-check ring, and
 * "exact" is doing real work in that sentence. A second implementation with
 * matching colours and sizes would drift the first time either was touched,
 * and the divergence would be invisible in review because the two files
 * would each look right on their own.
 *
 * So the ring is extracted rather than copied. `RadialConfirmRing` owns
 * everything that is not tile-specific: the board-anchored positioning
 * (design note #1), the outside-click and Escape dismissal, the two floating
 * action buttons and the caption pill. `RadialTileSelector` below is now a
 * thin wrapper that supplies the candidate thumbnails as children, and the
 * token flow supplies none. There is one confirm ring in this app, and both
 * callers get it by construction.
 */
export interface RadialConfirmRingProps {
  anchorOffsetX: number;
  anchorOffsetY: number;
  canvasEl: HTMLElement | null;
  /** Accessible name for the dialog, and the bold text in the caption pill. */
  title: string;
  /** The one-line explanation under the title. */
  hint: string;
  /* ==================================================================
   *  DESIGN NOTE 290: A SLOT WITH A JOB, WHICH `tag` NEVER HAD
   * ==================================================================
   *
   * Design note #270 deleted a generic `tag` slot on the grounds that a
   * prop with no callers is not flexibility but the bug waiting to be
   * re-enabled. That still stands, and this is not that slot returning
   * under a new name -- `tag` was a formatting hook with no subject, and
   * this states one specific fact: what happens to the pieces already on
   * the hex when the previewed tile lands.
   *
   * The test the old slot failed is the one this passes: it has a caller,
   * and the caller could not say this any other way. */
  note?: string;

  /* DESIGN NOTE 270: THE `tag` SLOT IS GONE TOO.
     Design note #260 stopped PASSING "(unvalidated)" and left the slot that
     rendered it, on the reasoning that some future caller might want an
     italic caveat. Nine chunks later nothing does, and what the slot
     actually preserved was the ability to put that exact string back on the
     exact surface it was removed from. A prop with no callers is not
     flexibility, it is the bug waiting to be re-enabled -- so the slot and
     its style go with it. A future caveat can add its own. */
  /** Whether the green check is shown at all. The tile flow hides it while
   *  the player is still choosing from the ring; the token flow always shows
   *  it, because there is nothing to choose. */
  showConfirm: boolean;
  canConfirm: boolean;
  confirmDisabledReason?: string;
  confirmTitle: string;
  confirmAriaLabel: string;
  cancelTitle: string;
  cancelAriaLabel: string;
  /** How far out the ring's own contents sit, so the buttons and caption
   *  clear them. */
  radius: number;
  onConfirm: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  children?: React.ReactNode;
}

export function RadialConfirmRing({
  anchorOffsetX,
  anchorOffsetY,
  canvasEl,
  title,
  hint,
  note,
  showConfirm,
  canConfirm,
  confirmDisabledReason,
  confirmTitle,
  confirmAriaLabel,
  cancelTitle,
  cancelAriaLabel,
  radius,
  onConfirm,
  onCancel,
  onDismiss,
  children,
}: RadialConfirmRingProps) {
  // Design note #1: the screen position, recomputed rather than remembered.
  const [screen, setScreen] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!canvasEl) {
      setScreen(null);
      return undefined;
    }
    const sync = () => {
      const rect = canvasEl.getBoundingClientRect();
      setScreen({ x: rect.left + anchorOffsetX, y: rect.top + anchorOffsetY });
    };
    sync();
    // `capture: true` so scrolling of any ANCESTOR is caught, not just the
    // window -- this board sits inside its own scrollable pane, and a
    // window-only listener would miss the scroll that matters most.
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
    };
  }, [canvasEl, anchorOffsetX, anchorOffsetY]);

  // Dismiss on a pointer-down that lands outside BOTH the ring and the
  // board. A click on the board is never a dismissal -- it is either a
  // rotation, a new selection or a new target, and the canvas click path
  // decides which (design note #168).
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (canvasEl?.contains(target)) return;
      onDismiss();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [canvasEl, onDismiss]);

  // Escape always closes outright, from either stage. A player who has lost
  // track of which stage they are in should still have one key that exits.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    /* ===================================================================
        DESIGN NOTE 168: THE BACKDROP MUST NOT SWALLOW BOARD CLICKS
       ===================================================================

       This was `position: fixed; inset: 0` with pointer events ON, to
       "catch the click that means somewhere else". It caught every click,
       including the ones aimed at the board underneath -- so clicking the
       previewed hex to rotate it never reached the canvas at all. It hit
       the backdrop, matched `target === currentTarget`, and DISMISSED the
       selector instead. Rotation looked unresponsive; it was never being
       asked.

       The backdrop is now inert (`pointerEvents: "none"`) and each
       interactive child opts back in. The board stays live underneath,
       which is what an IN-SITU picker requires -- the hex it is anchored to
       has to remain clickable, or the "click the tile to rotate" gesture
       cannot exist.

       Dismissal did not disappear with it, it moved to the three places
       that can each answer honestly:
         - the X button, for an explicit close;
         - a click on a DIFFERENT hex, handled by the board's own click
           path, which is a new selection rather than a dismissal;
         - the outside-pointerdown listener above, for a click that lands
           off the board entirely. */
    <div style={styles.backdrop} role="presentation" ref={rootRef}>
      <div
        style={{
          ...styles.anchor,
          left: screen?.x ?? 0,
          top: screen?.y ?? 0,
          // Hidden until the first measurement lands, so the ring never
          // flashes at the top-left corner before snapping into place.
          visibility: screen ? "visible" : "hidden",
        }}
        role="dialog"
        aria-label={title}
      >
        {/* ---- Floating action buttons, above the hex ----
             Design note #174: the offset TRACKS THE RADIUS. A fixed -158px
             was correct only while the ring was fixed too; now that the
             radius grows with the candidate count, a large ring would put
             its 12 o'clock thumbnail ABOVE a fixed button row and the two
             would collide. */}
        <div style={{ ...styles.actions, top: `${-radius - 38}px` }}>
          {showConfirm && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={!canConfirm}
              aria-label={confirmAriaLabel}
              title={canConfirm ? confirmTitle : (confirmDisabledReason ?? "Disabled")}
              style={{
                ...styles.fab,
                ...(canConfirm ? styles.fabConfirm : styles.fabConfirmDisabled),
              }}
            >
              &#10004;
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            aria-label={cancelAriaLabel}
            title={cancelTitle}
            style={{ ...styles.fab, ...styles.fabCancel }}
          >
            &#10006;
          </button>
        </div>

        {/* ---- The caption. Sits under the action buttons so the two read
                as one floating control group attached to this hex. */}
        <div style={{ ...styles.caption, top: `${-radius}px` }}>
          <span style={styles.captionHex}>{title}</span>
          <span style={styles.captionHint}>{hint}</span>
          {/* Design note #290: the migration line, when there is one. */}
          {note && <span style={styles.captionNote}>{note}</span>}
        </div>

        {children}
      </div>
    </div>
  );
}

export function RadialTileSelector({
  anchorOffsetX,
  anchorOffsetY,
  canvasEl,
  hexLabel,
  candidates,
  selectedTileId,
  orientation,
  canConfirm,
  confirmDisabledReason,
  provisional = false,
  legalRotationCount,
  tokenNote = null,
  onSelectCandidate,
  onConfirm,
  onCancel,
  onDismiss,
}: RadialTileSelectorProps) {
  const previewing = selectedTileId !== null;

  // Deduplicated by tile: the ring offers TILES, and rotation is chosen
  // afterwards on the board itself. Six ring entries for one tile at six
  // rotations would be six thumbnails a player cannot tell apart.
  const tiles: { tileId: number; firstOrientation: number }[] = [];
  const seen = new Set<number>();
  for (const placement of candidates) {
    if (seen.has(placement.tile_id)) continue;
    seen.add(placement.tile_id);
    tiles.push({ tileId: placement.tile_id, firstOrientation: placement.orientation });
  }

  // Design note #174: while previewing, the ring is hidden, so the minimum
  // radius is enough to clear the hex.
  const radius = previewing ? MIN_RADIUS : ringRadiusFor(tiles.length);

  return (
    <RadialConfirmRing
      anchorOffsetX={anchorOffsetX}
      anchorOffsetY={anchorOffsetY}
      canvasEl={canvasEl}
      title={hexLabel}
      hint={
        previewing
          ? legalRotationCount === 1
            ? "Only one legal facing here"
            : legalRotationCount !== undefined && legalRotationCount > 1
              ? `Click the tile to rotate (${legalRotationCount} legal facings)`
              : "Click the tile on the board to rotate"
          : tiles.length === 0
            ? "No legal upgrade here"
            : `${tiles.length} option${tiles.length === 1 ? "" : "s"}`
      }
      // Design note #271b: only while a tile is actually being previewed --
      // before that there is no destination to describe.
      note={previewing ? (tokenNote ?? undefined) : undefined}
      // Design note #2: nothing to confirm until a tile has been chosen.
      showConfirm={previewing}
      canConfirm={canConfirm}
      confirmDisabledReason={confirmDisabledReason ?? "Tile lay disabled"}
      confirmTitle={`Lay this tile on ${hexLabel}.`}
      confirmAriaLabel="Confirm tile lay"
      // The X means different things in the two stages, and that is
      // intentional rather than sloppy -- see design note #2.
      cancelTitle={
        previewing ? "Discard this preview and go back to the tile options." : "Close."
      }
      cancelAriaLabel={previewing ? "Discard preview" : "Close tile options"}
      radius={radius}
      onConfirm={onConfirm}
      onCancel={previewing ? onCancel : onDismiss}
      onDismiss={onDismiss}
    >
        {/* ---- The candidate ring. Hidden while previewing -- design note
                #2: it would cover the tile the player is now judging. ---- */}
        {!previewing &&
          tiles.map((tile, index) => {
            const position = ringPosition(index, tiles.length);
            const entry = TILE_CATALOG_BY_ID.get(tile.tileId);
            const tier = entry?.color;
            return (
              <button
                key={tile.tileId}
                type="button"
                onClick={() => onSelectCandidate(tile.tileId, tile.firstOrientation)}
                title={`Preview tile #${tile.tileId}${tier ? ` (${tier})` : ""} on ${hexLabel}`}
                style={{
                  ...styles.candidate,
                  transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px)`,
                  // The tier's own rim, so the ring is sorted by era at a
                  // glance without needing a label on every thumbnail.
                  borderColor: tier ? COLOR_TIER_STROKE[tier] : "#4a5163",
                }}
              >
                <TilePreviewThumbnail
                  tileId={tile.tileId}
                  orientation={tile.firstOrientation}
                  size={THUMB}
                />
                <span style={styles.candidateNumber}>{tile.tileId}</span>
              </button>
            );
          })}
    </RadialConfirmRing>
  );
}

export default RadialTileSelector;

/* ------------------------------------------------------------------ */
/* Station token confirmation -- design note #200                      */
/* ------------------------------------------------------------------ */

export interface RadialTokenConfirmProps {
  anchorOffsetX: number;
  anchorOffsetY: number;
  canvasEl: HTMLElement | null;
  hexLabel: string;
  /** What the placement will cost this corporation's treasury. On the
   *  caption for the same reason design note #181 put it on the button: the
   *  UI knows the number and the player is about to commit to it. */
  cost: number;
  /** The corporation the token belongs to. */
  ticker: string;
  canConfirm: boolean;
  confirmDisabledReason?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The station token's confirm ring -- the SAME red X / green check the tile
 *  selector uses, because it is literally the same component (design note
 *  #200). No candidate ring: there is nothing to choose here, only a
 *  placement to agree to, so the ring opens straight into its confirm
 *  stage. */
export function RadialTokenConfirm({
  anchorOffsetX,
  anchorOffsetY,
  canvasEl,
  hexLabel,
  cost,
  ticker,
  canConfirm,
  confirmDisabledReason,
  onConfirm,
  onCancel,
}: RadialTokenConfirmProps) {
  return (
    <RadialConfirmRing
      anchorOffsetX={anchorOffsetX}
      anchorOffsetY={anchorOffsetY}
      canvasEl={canvasEl}
      title={hexLabel}
      hint={`Place ${ticker}'s station token -- $${cost}`}
      showConfirm
      canConfirm={canConfirm}
      confirmDisabledReason={confirmDisabledReason}
      confirmTitle={`Place ${ticker}'s token on ${hexLabel} and charge $${cost} to its treasury.`}
      confirmAriaLabel="Confirm station token placement"
      cancelTitle="Cancel -- nothing is placed and nothing is charged."
      cancelAriaLabel="Cancel station token placement"
      radius={MIN_RADIUS}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onDismiss={onCancel}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                             */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 60,
    // No fill. The board must stay fully visible -- judging a tile in place
    // is the whole feature, and dimming the surroundings would defeat it.
    backgroundColor: "transparent",
    // Design note #168. Inert by default; the buttons below opt back in.
    pointerEvents: "none",
  },
  anchor: { position: "fixed", width: 0, height: 0, pointerEvents: "none" },
  actions: {
    pointerEvents: "auto",
    position: "absolute",
    left: "50%",
    // `top` is supplied per-render -- it has to clear whatever radius the
    // count produced. See the call site.
    transform: "translateX(-50%)",
    display: "flex",
    flexDirection: "row",
    gap: "10px",
  },
  /* Design note #174b: the confirm/cancel discs come down with the ring
     they orbit. 44px was a comfortable touch target on a 4K panel and is
     an oversized one on a 13" laptop, where it sat larger than the tile
     thumbnails it was confirming. 34px still clears the ~24px minimum a
     pointer needs. */
  fab: {
    width: "34px",
    height: "34px",
    borderRadius: "999px",
    borderWidth: "2px",
    borderStyle: "solid",
    fontSize: "16px",
    lineHeight: 1,
    fontFamily: "inherit",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 3px 12px rgba(0,0,0,0.5)",
  },
  fabConfirm: { backgroundColor: "#16a34a", borderColor: "#4ade80", color: "#ffffff" },
  // Inline styles cannot express `:disabled` (Lobby.tsx design note #3), so
  // the disabled look is computed. Kept VISIBLE rather than hidden: in
  // planning mode the player should see that confirming is a thing that
  // exists and is currently unavailable, which is what the tooltip explains.
  fabConfirmDisabled: {
    backgroundColor: "#1f2937",
    borderColor: "#374151",
    color: "#6b7280",
    cursor: "not-allowed",
  },
  fabCancel: { backgroundColor: "#b91c1c", borderColor: "#f87171", color: "#ffffff" },
  caption: {
    pointerEvents: "auto",
    position: "absolute",
    left: "50%",
    // `top` supplied per-render -- see the call site.
    transform: "translateX(-50%)",
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "8px",
    padding: "4px 12px",
    borderRadius: "999px",
    backgroundColor: "rgba(15, 20, 32, 0.92)",
    border: "1px solid #3a4150",
    whiteSpace: "nowrap",
  },
  captionHex: {
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    color: "#e2e6ee",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  captionHint: { fontSize: FONT_SIZE.micro, color: "#9aa0ac" },
  /* Design note #290: brighter than the hint it sits under. The hint
     explains the CONTROL; this reports a consequence of using it, which is
     the more consequential of the two and was previously not said at all. */
  captionNote: {
    fontSize: FONT_SIZE.micro,
    color: "#e0b062",
    lineHeight: 1.35,
    maxWidth: "260px",
  },
  candidate: {
    pointerEvents: "auto",
    position: "absolute",
    left: 0,
    top: 0,
    padding: "3px",
    borderRadius: "10px",
    borderWidth: "2px",
    borderStyle: "solid",
    backgroundColor: "rgba(15, 20, 32, 0.94)",
    cursor: "pointer",
    lineHeight: 0,
    boxShadow: "0 3px 12px rgba(0,0,0,0.5)",
  },
  candidateNumber: {
    display: "block",
    fontSize: FONT_SIZE.micro,
    lineHeight: 1.2,
    color: "#9aa0ac",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    textAlign: "center",
  },
};
