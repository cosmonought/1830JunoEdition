// frontend/src/components/TrainBadges.tsx
//
// The train chips, capacity pill and last-route-payout readout, shared by
// the Operating Round corporations table and the Stock Round card fronts.
//
// ===================================================================
//  DESIGN NOTE 0: SHARED BECAUSE THE RUST RULE MUST NOT FORK
// ===================================================================
//
// These started life inside `ContextualSubPanel.tsx`. The Stock Round card
// front now needs the same three readouts, and copying them would have
// duplicated the part that is easy to get subtly wrong: which tier is
// vulnerable, and how loud the warning should be. A second copy that
// drifted by one phase would show a player green chips on trains that rust
// on the very next purchase.
//
// So the rule lives once, here, reading `GamePhase` (`utils/gamePhase.ts`).
// Both callers pass the same derived phase object and get the same answer
// by construction rather than by discipline.
//
// ===================================================================
//  DESIGN NOTE 1: TWO SURFACES, BECAUSE THIS APP HAS TWO
// ===================================================================
//
// The Operating Round table sits on the dark chrome (`#1b2130`-ish); the
// Stock Round cards are linen white (`CARD_SURFACE`, `#f7f5f0`). A single
// chip palette cannot serve both -- the dark chip's `#232936` fill on a
// white card reads as a hole punched in the paper.
//
// `surface` therefore selects a palette, and it is a REQUIRED prop rather
// than one defaulting to `"dark"`. A caller that forgets it should fail to
// compile, not render invisible text on the surface the default did not
// anticipate.
//
// ===================================================================
//  DESIGN NOTE 2: COLOUR MEANS ONE THING EACH
// ===================================================================
//
//   amber  -> this train tier rusts in two more purchases
//   red    -> this train tier rusts on the very next purchase
//   purple -> this corporation is at its train limit
//
// Purple for the capacity pill specifically because the first two are
// warnings about DESTRUCTION and the third is a statement about CAPACITY.
// The pill was briefly amber, which put "you are full" in the same colour
// as "your trains are about to be destroyed" -- two unrelated facts, one
// signal, sitting in adjacent columns of the same row.

import React from "react";

import {
  ALERT_CRITICAL_BG,
  ALERT_CRITICAL_BORDER,
  ALERT_CRITICAL_INK,
  ALERT_WARN_BG,
  ALERT_WARN_BORDER,
  ALERT_WARN_INK,
  CARD_DIVIDER,
  CARD_INK,
  CARD_INK_FAINT,
  CARD_SURFACE_MUTED,
} from "../styles/palette";
import { FONT_SIZE } from "../styles/typography";
import {
  phaseAlertLevel,
  trainTier,
  type GamePhase,
  type TierRustOutlook,
  type TrainTier,
} from "../utils/gamePhase";

export type BadgeSurface = "dark" | "light";

export interface TrainBadgeCommonProps {
  /** Design note #1: required, not defaulted. */
  surface: BadgeSurface;
  /** Smaller type for the Stock Round card front, which packs these into a
   *  strip alongside prices rather than giving them a table column each. */
  compact?: boolean;
}

/* ------------------------------------------------------------------ */
/* Train chips                                                        */
/* ------------------------------------------------------------------ */

export interface TrainChipsProps extends TrainBadgeCommonProps {
  /** `undefined`/`null` means UNKNOWN -- a contract predating the field --
   *  and renders "?", never "none". See `PublicCompanyState.owned_trains`.
   *
   *  `readonly` because this component only reads it, and requiring a
   *  mutable array forced callers holding a frozen roster to copy or cast --
   *  a widening of the type, not a loosening of it. */
  trains?: readonly string[] | null;
  phase: GamePhase | null;
  /** Per-tier rust countdown (`rustOutlook`). Optional: without it a chip
   *  outside the currently-threatened tier still gets a tooltip naming what
   *  will destroy it, just without the "(N purchases away)" figure -- a
   *  number we cannot stand behind is worse than no number. */
  outlook?: Readonly<Record<TrainTier, TierRustOutlook>> | null;
  /* ==================================================================
   *  DESIGN NOTE 375: A CHIP IS A TRAIN, AND A TRAIN RUNS A ROUTE
   * ==================================================================
   *
   * `hexCanvasPrimitives.ts` design note #373 explains the shared cursor.
   * This is the chip's end of it.
   *
   * THE INDEX IS THE POSITION IN `trains`, which is the same key the Route
   * Planner's rows and the map overlays use -- design note #5 in
   * `RoutePlannerPanel` established that two 3-trains are two different
   * trains and get two rows, and this is the other half of that: two
   * 3-trains are two different chips and highlight independently.
   *
   * ALL THREE PROPS OPTIONAL, because this component renders in four
   * places and only one of them -- the Operating Round corporation strip
   * during Run Routes -- has a cursor to share. The Round Detail table and
   * the depot want a chip that does nothing on hover, and forcing them to
   * pass nulls would be plumbing a feature they do not have. */
  highlightedTrainIndex?: number | null;
  onHighlightTrain?: (trainIndex: number | null) => void;
  /** Design note #375: only the surface that shares a cursor makes its
   *  chips interactive. Elsewhere they stay inert badges. */
  interactive?: boolean;
}

/* ==================================================================
 *  DESIGN NOTE 4: EVERY CHIP SAYS SOMETHING, AND THE COUNTS AGREE
 * ==================================================================
 *
 * There are two different questions a chip can answer, and it used to
 * answer neither for most tiers:
 *
 *   ESCALATION (colour) -- am I in the danger window right now? Amber at
 *   one train left in the current depot tier, red at zero. Unchanged, and
 *   deliberately still driven by the DEPOT rather than the tier, so the
 *   warning does not shout from the moment a phase begins.
 *
 *   OUTLOOK (tooltip) -- what will eventually destroy this train, and how
 *   far off is it? Every tier gets this, including permanent ones, which
 *   say so plainly. A 5-train with no tooltip is indistinguishable from a
 *   5-train whose tooltip failed to load.
 *
 * The counts come from `rustOutlook`, which the action bar's phase tag also
 * reads (`gamePhase.ts` design notes #5 and #6). That shared source is the
 * fix for the mismatch this pass was raised for: the tag claimed "next buy"
 * while the chip said two purchases, and the chip was right.
 */
function rustTooltip(
  tier: TrainTier | null,
  phase: GamePhase | null,
  outlook: Readonly<Record<TrainTier, TierRustOutlook>> | null | undefined,
  inDangerWindow: "atRisk" | "doomed" | null,
): string | undefined {
  if (tier == null) return undefined;

  // The escalated wording wins while the chip is actually tinted -- it is
  // the more urgent and more specific of the two.
  if (inDangerWindow === "doomed") return "CRITICAL: Rusts on NEXT depot purchase!";
  if (inDangerWindow === "atRisk") {
    return "Vulnerable: Rusts after 2 purchases (1 to clear depot tier, 1 to rust).";
  }

  const entry = outlook?.[tier];
  if (entry && entry.rustedBy == null) return "Permanent: Never rusts.";
  if (entry?.rusted) return `${tier}-Trains have rusted and are out of play.`;

  // No outlook supplied: fall back to the static rule, which is still true.
  const trigger = entry?.rustedBy ?? STATIC_RUST_TRIGGER[tier];
  if (!trigger) return "Permanent: Never rusts.";
  const triggerName = trigger === "D" ? "Diesel" : `${trigger}-Train`;
  const away = entry?.purchasesAway;
  return away == null
    ? `Vulnerable: Rusts when the first ${triggerName} is purchased.`
    : `Vulnerable: Rusts when the first ${triggerName} is purchased (${away} purchase${away === 1 ? "" : "s"} away).`;
}

/** The rust rule with no game state attached, so a chip rendered without an
 *  `outlook` still describes itself correctly. */
const STATIC_RUST_TRIGGER: Readonly<Partial<Record<TrainTier, TrainTier>>> = {
  "2": "4",
  "3": "6",
  "4": "D",
};

export function TrainChips({
  trains,
  phase,
  surface,
  compact,
  outlook,
  highlightedTrainIndex = null,
  onHighlightTrain,
  interactive = false,
}: TrainChipsProps) {
  const ink = surface === "light" ? lightInk : darkInk;
  const size = compact ? FONT_SIZE.small : FONT_SIZE.strong;

  // Design note #3: THE EMPTY AND UNKNOWN STATES ARE CHIPS TOO.
  //
  // These used to be bare text while the populated state rendered pills, so
  // an unfloated corporation's row read as plain words sitting next to a
  // floated one's badges -- the two looked like different KINDS of readout
  // rather than the same readout with different contents. Same chip shell,
  // muted ink, so a column of cards lines up whatever each holds.
  const placeholderChip = (label: string) => (
    <span style={styles.chipRow}>
      <span
        style={{
          ...styles.chip,
          ...ink.chip,
          ...ink.empty,
          fontSize: size,
          padding: compact ? "1px 6px" : "2px 9px",
          minWidth: compact ? "22px" : "28px",
          fontWeight: 600,
          cursor: "default",
        }}
        title={
          label === "?"
            ? "This chain does not report train ownership."
            : "This corporation owns no trains."
        }
      >
        {label}
      </span>
    </span>
  );
  if (trains == null) return placeholderChip("?");
  if (trains.length === 0) return placeholderChip("none");

  const doomed = phase?.rustingTier ?? null;
  // Design note #7 (`gamePhase.ts`): severity comes from the SHARED
  // countdown, not from a second reading of `depotRemaining`. Same two
  // thresholds as before -- one purchase out is `doomed`, two is `atRisk`
  // -- but the action bar now reads the identical helper, so the chip and
  // the badge cannot escalate at different moments.
  //
  // Still untinted until the countdown reaches two, so the warning is not
  // shouting from the instant a phase begins.
  const alert = phaseAlertLevel(phase);
  const severity = alert === "critical" ? "doomed" : alert === "warn" ? "atRisk" : null;

  return (
    <span style={styles.chipRow}>
      {trains.map((model, index) => {
        const tier = trainTier(model);
        // Design note #4: the TINT is still depot-driven and still only
        // applies to the tier actually next in line to rust. Preserved
        // exactly -- the tooltip work below does not touch it.
        const inDangerWindow =
          doomed !== null && tier === doomed && severity !== null ? severity : null;
        const warning = rustTooltip(tier, phase, outlook, inDangerWindow);
        /* Design note #375: highlighted, faded, or neither. The muted state
           matters as much as the primary one -- with three chips in a row,
           "this one" is only legible if the others step back. */
        const isPrimary = interactive && highlightedTrainIndex === index;
        const isMuted =
          interactive && highlightedTrainIndex !== null && highlightedTrainIndex !== index;
        return (
          <span
            key={`${model}-${index}`}
            style={{
              ...styles.chip,
              ...ink.chip,
              fontSize: size,
              padding: compact ? "1px 6px" : "2px 9px",
              minWidth: compact ? "22px" : "28px",
              ...(inDangerWindow ? ink[inDangerWindow] : {}),
              ...(isPrimary ? styles.chipHighlighted : {}),
              ...(isMuted ? styles.chipMuted : {}),
              // Every chip carries a tooltip now (design note #4), so every
              // chip gets the help cursor -- and never the text I-beam,
              // which is wrong on a badge regardless.
              cursor: interactive ? "pointer" : warning ? "help" : "default",
            }}
            title={warning}
            onMouseEnter={interactive ? () => onHighlightTrain?.(index) : undefined}
            onMouseLeave={interactive ? () => onHighlightTrain?.(null) : undefined}
          >
            {model}
          </span>
        );
      })}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Capacity pill                                                      */
/* ------------------------------------------------------------------ */

export interface CapacityPillProps extends TrainBadgeCommonProps {
  trains?: string[] | null;
  phase: GamePhase | null;
}

export function CapacityPill({ trains, phase, surface, compact }: CapacityPillProps) {
  const ink = surface === "light" ? lightInk : darkInk;
  const size = compact ? FONT_SIZE.small : FONT_SIZE.strong;
  const atLimit = phase != null && trains != null && trains.length >= phase.trainLimit;

  return (
    <span
      style={{
        ...styles.pill,
        ...ink.chip,
        fontSize: size,
        padding: compact ? "1px 8px" : "2px 11px",
        ...(atLimit ? ink.atCapacity : {}),
        cursor: phase ? "help" : "default",
      }}
      title={
        phase
          ? `Phase ${phase.tier} allows ${phase.trainLimit} train${phase.trainLimit === 1 ? "" : "s"} per corporation.`
          : undefined
      }
    >
      {/* `owned_trains == null` is UNKNOWN, not zero -- "0 / 3" against a
          contract that never told us would read as "buy more trains" when
          the truth is "we cannot see them". */}
      {trains == null ? "?" : trains.length} / {phase ? phase.trainLimit : "?"}
      {atLimit && <span style={styles.pillMax}>MAX</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Last route payout                                                  */
/* ------------------------------------------------------------------ */

export interface LastRoutePayoutProps extends TrainBadgeCommonProps {
  /** The corporation's most recent route revenue --
   *  `PublicCompanyState.last_route_revenue`.
   *
   *  THIS IS NOW LIVE. The comment that stood here said it was "ALWAYS
   *  `undefined` TODAY... no query returns it and there is no field to
   *  reconstruct it from", and that was true when written. The contract
   *  since gained `last_route_revenue`, written on every route run and
   *  returned by `GetGameState`, so callers pass the real figure.
   *
   *  `undefined` still has a distinct meaning and is still rendered
   *  differently: it is what a contract predating the field returns, i.e.
   *  "this build cannot tell you". A real `"0"` means the corporation ran
   *  and earned nothing, which is a fact rather than an absence. */
  revenue?: string | number | null;
}

export function LastRoutePayout({ revenue, surface, compact }: LastRoutePayoutProps) {
  const ink = surface === "light" ? lightInk : darkInk;
  const size = compact ? FONT_SIZE.small : FONT_SIZE.strong;
  const value = revenue == null ? null : Number(revenue);
  const known = value !== null && Number.isFinite(value);

  return (
    <span
      style={{ ...styles.payout, fontSize: size, ...(known ? ink.value : ink.empty) }}
      // Plain language: the dash means "not reported", and a player is not
      // the audience for which query is missing.
      title={
        known ? undefined : "This build's contract does not report route revenue."
      }
    >
      {known ? `$${value}` : "--"}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Palettes                                                           */
/* ------------------------------------------------------------------ */

const darkInk = {
  chip: { borderColor: "#3a4150", backgroundColor: "#232936", color: "#e2e6ee" },
  // Design note #7 (`gamePhase.ts`): these are the SAME two constants the
  // action bar's phase-shift badge uses, so the chip and the badge escalate
  // together by construction. Amber became orange here specifically because
  // amber is already spent twice over -- on "look here" and on the Yellow
  // ERA -- which made an amber rust warning during the Yellow phase
  // near-invisible against the phase badge sitting beside it.
  atRisk: {
    borderColor: ALERT_WARN_BORDER,
    backgroundColor: ALERT_WARN_BG,
    color: ALERT_WARN_INK,
  },
  doomed: {
    borderColor: ALERT_CRITICAL_BORDER,
    backgroundColor: ALERT_CRITICAL_BG,
    color: ALERT_CRITICAL_INK,
  },
  atCapacity: {
    borderColor: "#a855f7",
    backgroundColor: "rgba(168, 85, 247, 0.18)",
    color: "#d8b4fe",
  },
  empty: { color: "#5a5f6b" },
  value: { color: "#e2e6ee" },
} as const;

// Same three meanings, re-mixed for paper: the tints are opaque pastels and
// the inks are dark, because a translucent white-on-white chip has no edge
// and light text on linen is unreadable.
const lightInk = {
  chip: { borderColor: CARD_DIVIDER, backgroundColor: CARD_SURFACE_MUTED, color: CARD_INK },
  atRisk: { borderColor: "#b8860b", backgroundColor: "#fdecc4", color: "#6b4e05" },
  doomed: { borderColor: "#b91c1c", backgroundColor: "#fadadd", color: "#7a1020" },
  atCapacity: { borderColor: "#7e22ce", backgroundColor: "#ece0fb", color: "#4a1670" },
  empty: { color: CARD_INK_FAINT },
  value: { color: CARD_INK },
} as const;

const styles: Record<string, React.CSSProperties> = {
  /* ==================================================================
   *  DESIGN NOTE 370: A CHIP'S HEIGHT WAS FONT METRICS, NOT A NUMBER
   * ==================================================================
   *
   * REPORTED: the train chips in the Corporation card are clipped at the
   * bottom.
   *
   * The chip had no height of its own. Its box came out of `lineHeight:
   * 1.25` on the inherited font -- 15px * 1.25 = 18.75px -- plus 2px of
   * padding and a 1px border each side, so 24.75px. Three things then
   * conspire:
   *
   *   IT IS FRACTIONAL. A 24.75px box on a display that snaps to device
   *   pixels rounds, and which way it rounds depends on the zoom and the
   *   element's subpixel offset. Round down and the 1px bottom border --
   *   the curved part of a 5px radius -- is the row that goes.
   *
   *   `inline-flex` SITS ON A BASELINE. The chip row is an inline-level box
   *   inside a text flow, aligned by the baseline of its first item, so its
   *   descent has to fit under the baseline in whatever line box the parent
   *   built from the SAME font metrics. A chip taller than its own line
   *   box overhangs.
   *
   *   THE CARD HAD 3px TO GIVE. Design note #299 cut `orContextCard`'s
   *   vertical padding to 3px and removed its 44px floor -- correct for the
   *   space it reclaimed, and it left nothing absorbing the overhang.
   *
   * `minHeight` states the box in whole pixels instead of deriving it from
   * a font, and `alignSelf: flex-start` stops the baseline alignment
   * stretching it. `App.tsx` design note #371 gives the card back the two
   * pixels the row needs. Both halves: an unclipped chip in a card too
   * short for it is still clipped. */
  chipRow: {
    display: "inline-flex",
    gap: "4px",
    flexWrap: "wrap",
    alignItems: "center",
    // Design note #370: the row is a block in its own right, so its height
    // is its content's rather than a line box's.
    verticalAlign: "middle",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "5px",
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
    borderWidth: "1px",
    borderStyle: "solid",
    lineHeight: 1.25,
    /* Design note #370: a whole-pixel floor. 24px clears the tallest chip
       this renders (15px text at 1.25 plus 2px padding and 1px borders =
       24.75px of content, which `box-sizing: border-box` fits) without the
       fractional rounding that was shaving the bottom border. */
    minHeight: "24px",
    boxSizing: "border-box",
    alignSelf: "center",
  },
  /* Design note #375: the highlight is a RING and a lift, not a colour
     change -- a chip's colour already carries the rust warning, and
     overwriting it to signal a hover would trade one meaning for another. */
  chipHighlighted: {
    boxShadow: "0 0 0 2px rgba(160, 200, 255, 0.85), 0 0 10px rgba(120, 170, 255, 0.5)",
    transform: "translateY(-1px)",
  },
  chipMuted: { opacity: 0.35 },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    borderRadius: "999px",
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
    borderWidth: "1px",
    borderStyle: "solid",
    whiteSpace: "nowrap",
    lineHeight: 1.25,
  },
  pillMax: { fontSize: FONT_SIZE.micro, letterSpacing: "0.06em", opacity: 0.85 },
  // No colour here on purpose -- it comes from the surface palette, since
  // a hardcoded ink would be invisible on one of the two backgrounds.
  payout: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontVariantNumeric: "tabular-nums",
    fontWeight: 700,
  },
};
