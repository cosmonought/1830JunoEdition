// frontend/src/components/RadialTileSelector.tsx
//
// The in-situ radial tile picker -- candidate tiles arranged around the hex you clicked, in the
// 18xx.games idiom.
//
// Design note #0: the PREVIEW is canvas (drawn on the real board, at the real zoom, beside the real
// neighbouring track -- you are judging whether the tile FITS) and the RING is DOM (hit-testing, hover,
// focus, keyboard traversal and disabled states come from the platform, correctly). Each candidate still
// renders its real artwork from the same catalog the board uses.
//
// Design note #1: anchored to the BOARD, not the viewport -- the stored value is the click's offset
// inside the canvas, re-projected on scroll (captured) and resize. Pan and zoom of the board are still
// not followed; #506 solves the sizing half of that unit problem.
//
// Design note #2: two stages, one overlay -- CHOOSING (ring visible, dismiss X only) and PREVIEWING
// (ring hidden, confirm/discard above the hex). The X dismisses in the first and steps BACK in the
// second: one escape control that always undoes exactly one step.
//
// Full design history: see `docs/ai_architecture/canvas_rendering.md`.

import React, { useEffect, useRef, useState } from "react";

import { TilePreviewThumbnail, type StationPreviewMarker } from "./HexGridRenderer";
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
  /** Design note #506: the central hex's centre-to-corner radius AS DRAWN,
   *  through the board's live zoom. Sizes the candidates and sets the ring's
   *  clearance. `null` falls back to the pre-#506 fixed constants. */
  hexRadiusPx?: number | null;
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
  /* Design note #260: the provisional caveat no longer renders. On the offline path EVERY candidate is
     local, so the tag was permanently present and never varied -- a caveat that never changes carries no
     information and only undermines confidence in a picker that is filtering correctly. The flag stays on
     the interface because the caller still distinguishes the two sources for `canConfirm` and the log. */
  provisional?: boolean;
  /** `App.tsx` design note #173: how many rotations this tile may legally take here. Drives the caption --
   *  "click to rotate" is a lie when the tile has one legal facing, and a player who clicks and sees nothing
   *  move will assume the gesture is broken rather than that it is already correct. */
  legalRotationCount?: number;
  /* Design note #271b: where the pieces already on the hex will end up. On an ordinary empty hex there is
     nothing to say; on a president's home city being split in two by an OO upgrade, which half their station
     lands in is the one thing they want to know -- and they were finding out by looking afterwards.
     A string rather than a structure: this component renders a caption and `utils/tokenMigration.ts` owns
     what the sentence should be. `null` on every hex with no tokens, which is most of them. */
  tokenNote?: string | null;
  /* Design note #673: what this lay costs and what the treasury is left with, as one string. Built by
     `utils/pendingTileCost.ts` from the same `terrainBuildFeeAt` the board badge prints and the reducer
     charges, so the three cannot disagree about a figure the player is about to commit to.
     A STRING, like `tokenNote` and for the same reason: this component renders a caption. `null` for a free
     lay -- most hexes, and every upgrade, since 1830 bills the ground once.
     Design note #684: shown only while PREVIEWING, like `tokenNote` -- the choosing stage's ring covers the
     caption slot. See the `cost=` prop below for the geometry that decides it. */
  costNote?: string | null;
  /** Design note #725a: threaded to the confirm caption's `warning` slot, on the same PREVIEWING gate as the
   *  cost -- a caution a player cannot read is not a warning. */
  warningNote?: string | null;
  /* Design note #488b: the caption's picture. #271b answered "which half" with a sentence; this is the same
     answer drawn on the tile, and the two MUST come from one computation or the ring can say "city 2 of 2"
     while the marker sits on city 1 -- the near-miss duplicate class TD-1 catalogued, in the version a
     player actually sees.
     A FUNCTION OF `tileId`, not a flat list: the destination depends on the candidate, and the ring shows
     every candidate at once. Omitted, every thumbnail draws exactly what it drew before. */
  stationMarkersFor?: (tileId: number) => readonly StationPreviewMarker[];
  /* Design note #628: the tray count, asked per candidate. A lookup rather than a table, for the same reason
     the marker helper is one: the ring shows a handful of tiles out of forty-six, and handing it the whole
     manifest would make this a consumer of the catalog rather than of its caller.
     `undefined` renders no counts at all; `null` from the lookup means the catalog does not carry that tile
     and is likewise silent -- a mirror gap must not be displayed as a supply problem. */
  stockFor?: (tileId: number) => { printed: number; remaining: number } | null;
  onSelectCandidate: (tileId: number, orientation: number) => void;
  onConfirm: () => void;
  /** Step back one stage -- design note #2. */
  onCancel: () => void;
  onDismiss: () => void;
}

/* Design note #174b: the thumbnail, and with it the ring, is sized for a 1080p board rather than a 4K one.
   `ringRadiusFor` solves the radius FROM this number, so shrinking the thumbnail shrinks the ring
   proportionally and the spacing maths needs no edit.
   Design note #471: bigger candidates. 38px carried a whole hex's artwork at roughly favicon size, which
   fails exactly in the dense areas where the choice turns on which edges each tile connects. The increase
   costs nothing in layout because the geometry was already parameterised on this constant.
   Design note #506: THE RING WAS MEASURED IN THE WRONG UNIT. The ring is sized in fixed CSS pixels while
   the hex is drawn at `hexSize * zoom`, so every constant here was calibrated against one on-screen size
   and is wrong by exactly the zoom factor at any other -- at zoom 2 the candidates sat INSIDE the hex they
   were replacing, and got worse the further a player zoomed in to read a dense area.
   Both size and radius are derived from the hex AS DRAWN now, reported through the live transform
   (`HexGridRenderer` #506). `null` keeps the old constants rather than collapsing the ring to zero. */

/** The candidate tile as a fraction of the central hex's full height. A FLOOR rather than a target: the
 *  larger of this and the absolute pixel floor wins, so zooming out cannot shrink a tile past legibility
 *  and zooming in cannot let it fall below the ratio. */
export const CANDIDATE_HEX_FRACTION = 0.6;

/* #471 raised this 38 -> 54 for dense areas; #506 raises it again, since the report that motivated the
   zoom fix also said the tiles were simply too small. This is the absolute floor for a zoomed-OUT board,
   where the ratio rule would otherwise produce something smaller than #471 already rejected. */
const THUMB_FLOOR = 64;

/** The size to draw each candidate at, for a central hex of `hexRadiusPx`. A pointy-top hex's height is
 *  twice its centre-to-corner radius, and the thumbnail is square with its own hex inscribed, so the two
 *  are directly comparable. */
export function candidateThumbSize(hexRadiusPx?: number | null): number {
  const radius = Number(hexRadiusPx);
  if (!Number.isFinite(radius) || radius <= 0) return THUMB_FLOOR;
  return Math.max(THUMB_FLOOR, Math.round(2 * radius * CANDIDATE_HEX_FRACTION));
}

/* Design note #174: THE RADIUS IS SOLVED FOR, NOT PICKED. Fixed capacity at a fixed radius is the overlap
   bug -- at eight items the thumbnails already sat ~80px apart, and a hex offering more packed them
   tighter still because the second ring only opened at nine.
   N items evenly spaced on a circle of radius R sit `2 * R * sin(pi / N)` apart, so requiring that to clear
   the thumbnail plus a gutter gives `R >= needed / (2 * sin(pi / N))`. The radius grows exactly as fast as
   the count demands and no faster, with no capacity cliff.
   `MIN_RADIUS` keeps a small ring clear of the hex and the action buttons; the `sin` term takes over from
   about five candidates. `N = 1` and `N = 2` are special-cased because `sin(pi/1)` is 0 (a division by
   zero) and `sin(pi/2)` is 1 (a needlessly wide ring for two items opposite each other). */

/** The fallback when no hex radius is known -- the pre-#506 constant, so an
 *  un-updated caller sees exactly the old ring. */
const MIN_RADIUS = 76;
/** The smallest gap between a candidate and the hex that still reads as a
 *  gap rather than as a touch. Also the gutter between two candidates. */
const RING_GAP = 12;

/* Design note #506a: A HALO, SOLVED RATHER THAN NUDGED. "Absolutely zero overlap" is a guarantee, so:
   `ringRadius >= hexRadiusPx + thumb/2 + RING_GAP`.
   BOTH TERMS ARE THE CONSERVATIVE EXTENT. A pointy-top hex's centre-to-edge distance varies between its
   apothem (0.866 R) and its full R, and using R for both assumes the two point vertices straight at each
   other -- the worst case, true at only two of twelve positions. The cost is a few pixels of air at the
   other ten; the benefit is a guarantee that holds without anyone reasoning about relative orientation,
   which is the sort of reasoning that produces a bug at exactly one candidate count.
   A `Math.max` WITH the spacing term, not a replacement: #174 keeps candidates off EACH OTHER, this keeps
   them off the HEX, and they bind in different regimes, so both are required and the larger wins. */

/** The radius `count` candidates need: clear of each other, and clear of a
 *  central hex of `hexRadiusPx`. */
export function ringRadiusFor(count: number, hexRadiusPx?: number | null): number {
  const thumb = candidateThumbSize(hexRadiusPx);
  const radius = Number(hexRadiusPx);
  /* The halo floor. Falls back to the old constant when the hex's drawn size
     is unknown, which is the one case where no guarantee can be made. */
  const clearance =
    Number.isFinite(radius) && radius > 0
      ? Math.ceil(radius + thumb / 2 + RING_GAP)
      : MIN_RADIUS;
  if (count <= 2) return clearance;
  const spacing = (thumb + RING_GAP + 2) / (2 * Math.sin(Math.PI / count));
  return Math.max(clearance, Math.ceil(spacing));
}

/** Polar position of candidate `index` of `count`, relative to the anchor.
 *
 *  Starts at 12 o'clock and runs clockwise, so the reading order matches
 *  the order the candidates were listed in. */
export function ringPosition(
  index: number,
  count: number,
  hexRadiusPx?: number | null,
): { x: number; y: number } {
  const radius = ringRadiusFor(count, hexRadiusPx);
  const angle = (index / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/* Design note #200: THE CONFIRM RING IS ITS OWN COMPONENT. Placing a station token used to be instant,
   while laying a tile -- comparably expensive and just as irreversible -- always asked for a green check.
   Two board interactions, two contracts with the player, and the more expensive had no confirmation step.
   The requirement was the EXACT same ring, and "exact" is doing real work: a second implementation with
   matching colours would drift the first time either was touched, and the divergence would be invisible in
   review because each file would look right on its own.
   So the ring is extracted rather than copied. `RadialConfirmRing` owns the board-anchored positioning
   (#1), the outside-click and Escape dismissal, the two floating buttons and the caption pill; this file is
   a thin wrapper supplying thumbnails, and the token flow supplies none. */
export interface RadialConfirmRingProps {
  anchorOffsetX: number;
  anchorOffsetY: number;
  canvasEl: HTMLElement | null;
  /** Accessible name for the dialog, and the bold text in the caption pill. */
  /** Design note #512: `null` renders no title line. */
  title: string | null;
  /** Design note #512: the accessible name when `title` is null, so removing
   *  the visible caption does not leave the dialog unnamed. */
  hexLabelForAria: string;
  /** The one-line explanation under the title. */
  /** Design note #512: `null` renders no hint line. With both null and no
   *  note, the caption element itself is not rendered. */
  hint: string | null;
  /* Design note #290: A SLOT WITH A JOB, WHICH `tag` NEVER HAD. #270 deleted a generic `tag` slot because a
     prop with no callers is not flexibility but the bug waiting to be re-enabled. That still stands, and this
     is not that slot under a new name: `tag` was a formatting hook with no subject, and this states one
     specific fact. The test the old slot failed is the one this passes -- it has a caller, and the caller
     could not say this any other way. */
  note?: string;

  /* Design note #270: THE `tag` SLOT IS GONE TOO. #260 stopped PASSING "(unvalidated)" and left the slot
     that rendered it "in case a future caller wants an italic caveat". Nine chunks later nothing does, and
     what the slot preserved was the ability to put that exact string back on the exact surface it was removed
     from.
     Whether the green check is shown at all: the tile flow hides it while the player is still choosing; the
     token flow always shows it, because there is nothing to choose. */
  showConfirm: boolean;
  /* Design note #471: THE X BEHIND THE TOP HEX. The action row sits directly above the ring, and #174 made
     the radius grow with the candidate count -- so at any useful count the 12 o'clock thumbnail rises to meet
     the buttons and the X ends up BEHIND a tile. It is also redundant there, since a click outside closes.
     NOT REMOVED OUTRIGHT: while a tile is PREVIEWED the X is half of a check/X pair and the ring is hidden
     (#2), so nothing overlaps it. The station-token ring is the same shape and the same argument. */
  showCancel?: boolean;
  canConfirm: boolean;
  confirmDisabledReason?: string;
  confirmTitle: string;
  confirmAriaLabel: string;
  cancelTitle: string;
  cancelAriaLabel: string;
  /** Design note #673: what pressing the tick will cost, and what it leaves.
   *  `null` when it is free -- most hexes are, and a permanent "Costs $0"
   *  teaches a player to stop reading the line that matters on the two
   *  terrains where it does.
   *
   *  Design note #684: `null` at the CHOOSING stage too. The caller decides,
   *  because the caller is the one that knows which stage it is in -- this
   *  component draws a caption and does not get an opinion about when a fee is
   *  worth stating. */
  cost?: string | null;
  /** Design note #725a: a caution about what this lay COSTS BEYOND ITS PRICE -- today, a president about to
   *  forfeit their own D&H power by laying F16 the ordinary way.
   *  A SEPARATE SLOT rather than appended to `cost`, because the two are different moods and the price must
   *  survive: "Costs $120" and "this destroys a power you own" are both wanted, and a warning that displaced
   *  the figure would trade one surprise for another. */
  warning?: string | null;
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
  hexLabelForAria,
  hint,
  note,
  showConfirm,
  showCancel = true,
  canConfirm,
  confirmDisabledReason,
  confirmTitle,
  confirmAriaLabel,
  cancelTitle,
  cancelAriaLabel,
  cost = null,
  warning = null,
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

  /* Design note #512: the caption exists only when it has something to say. `null` for both lines AND no
     note means the element is not rendered at all -- an empty positioned div still occupies its slot above
     the hex and still paints, so suppressing the TEXT alone would leave the clutter it was asked to remove. */
  const caption =
    title === null && hint === null && !note && !cost ? null : { title, hint };

  return (
    /* Design note #168: THE BACKDROP MUST NOT SWALLOW BOARD CLICKS. It was `position: fixed; inset: 0` with
       pointer events ON, and it caught every click including those aimed at the board -- so clicking the
       previewed hex to rotate hit the backdrop, matched `target === currentTarget` and DISMISSED the selector.
       Rotation looked unresponsive; it was never being asked.
       The backdrop is inert now and each interactive child opts back in. The board stays live underneath, which
       is what an IN-SITU picker requires. Dismissal moved to the three places that can answer honestly: the X
       button, a click on a DIFFERENT hex (a new selection rather than a dismissal), and the outside-pointerdown
       listener for a click off the board entirely. */
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
        /* Design note #512: the hex name leaves the VISIBLE caption but not the accessible name. A dialog needs
           one, and "which hex is this picker for" is exactly the question a screen-reader user cannot answer by
           glancing at the ring's position on the board -- which is how a sighted player answers it, and why the
           visible copy is redundant for them and not for everyone. */
        aria-label={title ?? hexLabelForAria}
      >
        {/* Floating action buttons, above the hex. Design note #174: the offset TRACKS THE RADIUS. A fixed -158px
           was correct only while the ring was fixed too; now that the radius grows with the candidate count, a
           large ring would put its 12 o'clock thumbnail above a fixed button row and the two would collide. */}
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
          {showCancel && (
            <button
              type="button"
              onClick={onCancel}
              aria-label={cancelAriaLabel}
              title={cancelTitle}
              style={{ ...styles.fab, ...styles.fabCancel }}
            >
              &#10006;
            </button>
          )}
        </div>

        {/* ---- The caption. Sits under the action buttons so the two read
                as one floating control group attached to this hex. */}
        {/* Design note #512: TWO CAPTIONS, ONE OF THEM SAYING NOTHING. The choosing caption told the player what
           they had just done -- they clicked that hex, so its name and coordinates are the one thing they cannot
           be unsure of, and "N options" counts tiles visibly arranged in a ring around the caption. #266 deleted
           the Auto-Route success message for exactly this reason.
           The rotation caption keeps only its instruction. The facing count was #173's answer to a real problem
           (one legal facing makes "click to rotate" a lie) but it solved it by making the player read a number to
           find out whether a gesture would do anything.
           THE ELEMENT GOES WITH THE TEXT, not just its content: an empty positioned div still occupies its slot
           above the hex and still paints its background. */}
        {caption !== null && (
        <div style={{ ...styles.caption, top: `${-radius}px` }}>
          {caption.title !== null && <span style={styles.captionHex}>{caption.title}</span>}
          {caption.hint !== null && <span style={styles.captionHint}>{caption.hint}</span>}
          {/* Design note #673: THE PRICE, WHERE THE PLAYER COMMITS TO IT.
              FIRST in the caption and the only emphasised line in it, above both the rotate hint and the token
              migration -- those describe the move, this is what the move costs, and a player scanning a floating
              caption before pressing a tick reads the top line.
              NOT A SECOND DIALOG, which is what a literal "are you sure?" would have been: the tick and cross ARE
              the confirmation (#2), and they have been since the picker gained a preview stage. All that was
              missing is that they never said the price. */}
          {cost && <span style={styles.captionCost}>{cost}</span>}
          {/* Design note #725a: amber, under the price. Amber and not red for #700's reason -- the lay is
              legal and occasionally correct, so colouring it as an error would argue with a president who
              meant it. */}
          {warning && <span style={styles.captionWarning}>{warning}</span>}
          {/* Design note #290: the migration line, when there is one. */}
          {note && <span style={styles.captionNote}>{note}</span>}
        </div>
        )}

        {children}
      </div>
    </div>
  );
}

export function RadialTileSelector({
  anchorOffsetX,
  anchorOffsetY,
  canvasEl,
  hexRadiusPx = null,
  hexLabel,
  candidates,
  selectedTileId,
  orientation,
  canConfirm,
  confirmDisabledReason,
  provisional = false,
  legalRotationCount,
  tokenNote = null,
  costNote = null,
  warningNote = null,
  stationMarkersFor,
  stockFor,
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

  /* Design note #174: while previewing, the ring is hidden, so only the
     clearance matters -- but it is still the HEX'S clearance (design note
     #506), not a fixed constant, or the caption and action buttons sit on
     top of a zoomed-in hex exactly as the candidates used to. */
  const thumb = candidateThumbSize(hexRadiusPx);
  const radius = previewing
    ? ringRadiusFor(0, hexRadiusPx)
    : ringRadiusFor(tiles.length, hexRadiusPx);

  return (
    <RadialConfirmRing
      anchorOffsetX={anchorOffsetX}
      anchorOffsetY={anchorOffsetY}
      canvasEl={canvasEl}
      /* Design note #512: no visible title in either stage. The hex name and
         coordinates answer "which hex did I just click", which is the one
         thing the player is certain of -- the ring is drawn on it. */
      title={null}
      hexLabelForAria={hexLabel}
      /* Design note #512: exactly one string, and only while previewing. The choosing stage says nothing --
         "N options" counts tiles arranged in a visible ring around the caption counting them.
         The facing count is gone from the preview string too: #173 added it to stop "click to rotate" lying on a
         single-facing tile, which was a real problem solved by making the player read a number to predict a
         gesture. The tile is on the board and clicking it either turns or does not. */
      hint={previewing ? "Click the tile to rotate" : null}
      // Design note #271b: only while a tile is actually being previewed --
      // before that there is no destination to describe.
      note={previewing ? (tokenNote ?? undefined) : undefined}
      /* Design note #673 argued BOTH STAGES: the terrain fee is a property of the GROUND (`sandboxSession.ts`
         #432 -- "the fee belongs to the ground, not the tile"), so it is known the moment the ring opens, and
         withholding it would let a player pick a tile for a hex they were never going to build on.

         Design note #684: THAT WAS TRUE ABOUT THE DATA AND WRONG ABOUT THE SCREEN. Reported: during the choosing
         stage the caption is "almost completely covered by the radial menu".
         It is, and the geometry says so plainly. The caption is positioned at `-radius`, and #174 made that
         radius GROW WITH THE CANDIDATE COUNT -- so on the choosing stage it sits inside a ring of thumbnails
         rather than above it. Previewing hides the ring and collapses the radius to `ringRadiusFor(0)`, which is
         the only stage where anything anchored to it has clear space.
         SO IT FOLLOWS `note` AFTER ALL, and for a reason #271b never had to state: not "there is nothing to say
         yet" but "there is nowhere to say it". A fee a player cannot read is not an early warning.
         THE COST IS NOT LOST AT THE CHOOSING STAGE -- `HexGridRenderer` #136 prints the terrain badge on the hex
         itself, which is what the player is looking at, and the corporation card's provisional treasury (#673)
         updates the moment the ring opens. This caption was the third telling of it, and the one with no room. */
      cost={previewing ? costNote : null}
      warning={previewing ? warningNote : null}
      // Design note #2: nothing to confirm until a tile has been chosen.
      showConfirm={previewing}
      /* Design note #471: the candidate ring's X sits behind its own top
         thumbnail and duplicates click-away. The preview state keeps it --
         there it is the discard half of a check/X pair, with the ring
         hidden behind the previewed tile. */
      showCancel={previewing}
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
            const position = ringPosition(index, tiles.length, hexRadiusPx);
            /* Design note #629: AN EXHAUSTED TILE IS NOT AN OPTION. #628 labelled the count and left the candidate
               live, reasoning that the placement rules do not consult the tray and the contract is what refuses it.
               True, and a control that looks available, accepts the click and produces a rejected transaction is the
               failure shape this codebase has removed repeatedly. The tray count is knowable BEFORE the click.
               GREYED AND DISABLED, NOT HIDDEN: removing the thumbnail would leave a player wondering whether the tile
               was ever legal here, and "there are no more #57s" is often the reason a plan has to change.
               THE DERIVATION IS NOT THE AUTHORITY -- `tileStock` counts the board rather than reading `REMAINING_TILES`,
               so this can only refuse a tile the contract would also refuse, and the contract still has the last word. */
            const stock = stockFor?.(tile.tileId) ?? null;
            const exhausted = stock !== null && stock.remaining === 0;
            /* Design note #471: the catalog lookup went with the tooltip.
               It existed only to name the tier in that string; the tier is
               visible as the thumbnail's own colour. */
            return (
              <button
                key={tile.tileId}
                type="button"
                onClick={() => onSelectCandidate(tile.tileId, tile.firstOrientation)}
                disabled={exhausted}
                /* Design note #471: NO `title`. A native tooltip on every thumbnail in a ring of eight means one follows
                   the cursor continuously as the player sweeps the options, covering the very tiles they are comparing.
                   The id is printed on the tile and its tier is its colour -- both readable without hovering. */
                aria-label={
                  exhausted
                    ? `Tile ${tile.tileId} — none left in the supply`
                    : `Preview tile ${tile.tileId} on ${hexLabel}`
                }
                style={{
                  ...styles.candidate,
                  ...(exhausted ? styles.candidateExhausted : {}),
                  transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px)`,
                }}
              >
                <TilePreviewThumbnail
                  tileId={tile.tileId}
                  orientation={tile.firstOrientation}
                  size={thumb}
                  // Design note #488b: where this candidate would put the
                  // tokens already standing on the hex.
                  stationMarkers={stationMarkersFor?.(tile.tileId)}
                />
                <span style={styles.candidateNumber}>{tile.tileId}</span>
                {/* Design note #628: SCARCITY, WHERE THE CHOICE IS MADE. `contract.rs` has always seeded a per-game tray
                   and decremented `REMAINING_TILES` as tiles are laid, so this was enforced state the UI had never shown --
                   a player could be refused a lay for a reason nothing on screen predicted.
                   ON THE CANDIDATE RATHER THAN IN A REFERENCE TABLE, because scarcity is only actionable while choosing:
                   "there are four #57s in the game" is trivia; "1 left" while picking between two tiles is the decision.
                   ONLY WHEN IT IS WORTH SAYING -- a comfortable count on every thumbnail is noise that hides the one that
                   matters, so the badge appears from two copies down. */}
                {(() => {
                  if (!stock || stock.remaining > 2) return null;
                  return (
                    <span
                      style={{
                        ...styles.candidateStock,
                        ...(stock.remaining === 0
                          ? styles.candidateStockNone
                          : stock.remaining === 1
                            ? styles.candidateStockLast
                            : {}),
                      }}
                      aria-label={`${stock.remaining} of ${stock.printed} copies of tile ${tile.tileId} remain`}
                    >
                      {stock.remaining === 0 ? "none left" : `${stock.remaining} left`}
                    </span>
                  );
                })()}
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
  /** Design note #836: "Costs $40 — treasury $960 after", from `describePendingSpend` -- the SAME sentence
   *  the tile ring's `costNote` carries, built by the same function.
   *
   *  REPORTED: "the Station Marker tooltip confirmation should list the Treasury effect", pointing at the
   *  terrain lay as the thing to match. `cost` above answers "what does this cost" and this answers "what am
   *  I left with", which #673 argued is the question a president actually has. Two slots because they are two
   *  questions, and the price must survive -- the same reasoning #725a gave for keeping `warning` separate.
   *
   *  `null` for a free placement, where the ring already says $0 (#454) and a remainder that has not moved is
   *  an arrow pointing at itself. */
  costNote?: string | null;
  /** The corporation the token belongs to. */
  ticker: string;
  /** Design note #462: the corporation's livery, so the ring shows the
   *  actual token rather than describing it. */
  liveryColor: string;
  /** Ink that contrasts with `liveryColor` -- computed by the caller with
   *  the same helper the map tokens use, so the preview and the piece it
   *  previews cannot pick different text colours. */
  liveryInk: string;
  canConfirm: boolean;
  confirmDisabledReason?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The station token's confirm ring -- the SAME red X / green check the tile selector uses, because it is
 *  literally the same component (design note #200). No candidate ring: there is nothing to choose here, only
 *  a placement to agree to, so it opens straight into its confirm stage. */
export function RadialTokenConfirm({
  anchorOffsetX,
  anchorOffsetY,
  canvasEl,
  hexLabel,
  cost,
  costNote = null,
  ticker,
  liveryColor,
  liveryInk,
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
      /* Design note #512 is scoped to the TILE picker. The token ring keeps
         its caption: it names a corporation and a price the player has not
         seen elsewhere, which is the opposite of the tile ring's case. */
      title={hexLabel}
      hexLabelForAria={hexLabel}
      hint={`Place ${ticker}'s station token — $${cost}`}
      showConfirm
      canConfirm={canConfirm}
      confirmDisabledReason={confirmDisabledReason}
      /* Design note #836: the caption slot the tile ring has always used, so the two rings say the treasury
         effect in one voice rather than two. */
      cost={costNote}
      /* AND THE SAME FACT IN THE TOOLTIP, which is what the report actually names -- "the Station Marker
         TOOLTIP confirmation should list the Treasury effect". Appended rather than substituted: the
         sentence already says what is charged and to whom, and this says what survives it. */
      confirmTitle={
        `Place ${ticker}'s token on ${hexLabel} and charge $${cost} to its treasury.` +
        (costNote === null ? "" : ` ${costNote}.`)
      }
      confirmAriaLabel="Confirm station token placement"
      cancelTitle="Cancel — nothing is placed and nothing is charged."
      cancelAriaLabel="Cancel station token placement"
      radius={MIN_RADIUS}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onDismiss={onCancel}
    >
      {/* Design note #462: SHOW THE PIECE BEING PLACED. The ring named the corporation in its caption and drew
         nothing, while its sibling has always previewed the TILE -- so the token ring asked for the same
         commitment with nothing on screen but a ticker in a sentence.
         This is the token as the map draws it: livery fill, contrast ink, ticker, dark rim, centred over the city
         node just clicked, so the question becomes "does that look right there" rather than "do I trust the
         label". `pointerEvents: none`, or the centre becomes a dead zone. */}
      <span
        aria-hidden="true"
        style={{
          ...styles.tokenPreview,
          backgroundColor: liveryColor,
          color: liveryInk,
        }}
      >
        {ticker}
      </span>
    </RadialConfirmRing>
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                             */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  /* Design note #462: the station token, previewed at the ring's centre.
     Same silhouette the canvas draws -- circle, livery fill, contrast ink,
     dark rim, monospace ticker -- so the preview and the piece are visibly
     the same object rather than two designers' idea of one. */
  tokenPreview: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "30px",
    height: "30px",
    borderRadius: "50%",
    border: "2px solid rgba(0, 0, 0, 0.45)",
    boxShadow: "0 2px 5px rgba(0,0,0,0.55)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "9px",
    fontWeight: 700,
    lineHeight: 1,
    letterSpacing: "-0.02em",
    // The ring's buttons are the interactive parts; a preview that ate
    // clicks would make the centre a dead zone.
    pointerEvents: "none",
  },
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
  /* Design note #174b: the confirm/cancel discs come down with the ring they orbit. 44px was a comfortable
     touch target on a 4K panel and an oversized one on a 13" laptop, where it sat larger than the thumbnails
     it was confirming. 34px still clears the ~24px minimum a pointer needs. */
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
  captionWarning: {
    fontSize: FONT_SIZE.micro,
    color: "#e0b062",
    lineHeight: 1.35,
    maxWidth: "260px",
    textAlign: "center",
  },
  captionNote: {
    fontSize: FONT_SIZE.micro,
    color: "#e0b062",
    lineHeight: 1.35,
    maxWidth: "260px",
  },
  /* Design note #673: the one line in this caption a player is about to spend money on, so it is the one line
     with weight. A step up from `captionNote`'s micro and a plainer ink than its amber -- the migration note is
     a WARNING about a side effect, this is the price of the thing being asked for, and rendering them the same
     would make the caption read as two alerts.
     `tabular-nums` so "$1000 → $920" does not jitter as the figures change while the player cycles hexes. */
  captionCost: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#f2f4f8",
    fontVariantNumeric: "tabular-nums",
    lineHeight: 1.35,
  },
  /* Design note #369: THE CHROME WAS THE OTHER HALF OF THE RECTANGLE. `HexGridRenderer` #368 fixed the
     artwork; this is the half that was visible even once it was not -- a rounded rectangle with a border and
     an opaque fill wrapped around a hexagonal tile, so six vertices of dark background showed at the corners
     and the eye read the CARD, not the tile.
     The border was also redundant: the thumbnail already strokes the tile in the same tier colour, so the
     ring carried two rims of one colour around two different shapes. What remains is a transparent hit
     target -- the tile is its own chrome. */
  candidate: {
    pointerEvents: "auto",
    position: "absolute",
    left: 0,
    top: 0,
    padding: 0,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    lineHeight: 0,
    /* The shadow moves off the box and onto the SHAPE. `box-shadow` on a
       clipped element is clipped with it; `filter: drop-shadow` follows the
       alpha, so the hex casts a hex-shaped shadow. */
    filter: "drop-shadow(0 3px 8px rgba(0,0,0,0.55))",
  },
  candidateNumber: {
    display: "block",
    fontSize: FONT_SIZE.micro,
    lineHeight: 1.2,
    color: "#9aa0ac",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    textAlign: "center",
  },
  /* Design note #629: the exhausted candidate. The drop-shadow goes with the opacity -- a shadow at full
     strength under a faded thumbnail keeps it looking raised and clickable, which is the one impression this
     state has to undo.
     `grayscale` ON TOP OF THE FADE, because tier colour is how a player reads the ring at speed: a merely
     faint green tile still reads as an available green tile out of the corner of the eye. */
  candidateExhausted: {
    opacity: 0.38,
    filter: "grayscale(0.85) drop-shadow(0 1px 3px rgba(0,0,0,0.4))",
    cursor: "not-allowed",
  },
  /* Design note #628: quieter than the tile id above it by default -- a
     comfortable count is context, not a warning. The two states that ARE
     warnings take colour, and only those. */
  candidateStock: {
    display: "block",
    fontSize: "9px",
    lineHeight: 1.3,
    fontWeight: 700,
    letterSpacing: "0.02em",
    color: "#8a919e",
    textAlign: "center",
    whiteSpace: "nowrap",
  },
  /* The last copy in the game. Amber rather than red: taking it is a
     legitimate and often correct move, and red would read as a refusal. */
  candidateStockLast: { color: "#e0b050" },
  /* Exhausted. Still SHOWN rather than hidden -- the candidate is offered by
     the placement rules, which do not consult the tray, and a player who
     picks it will be refused by the contract. Saying so on the thumbnail is
     better than letting them find out from a rejected transaction. */
  candidateStockNone: { color: "#e08a8a" },
};
