// Train chips, capacity pill and last-route-payout readout, shared by the
// Operating Round corporations table and the Stock Round card fronts.
//
// Design note #0: SHARED because the rust rule must not fork. A second copy that
// drifted by one phase would show green chips on trains that rust on the very
// next purchase. The rule reads `GamePhase` (`utils/gamePhase.ts`) once.
//
// Design note #1: `surface` selects a palette and is REQUIRED, not defaulted --
// the dark chip's fill on a linen card reads as a hole punched in the paper, and
// a caller that forgets should fail to compile rather than render invisibly.
//
// Design note #2: amber = rusts in two purchases, red = rusts next purchase,
// purple = at the train limit. Purple because the first two warn about
// DESTRUCTION and the third states CAPACITY.
//
// See docs/ai_architecture/contract_economy.md, TrainBadges.tsx #0 / #1 / #2.

import React from "react";

import {
  /* Design note #702: `ALERT_CRITICAL_BG` and `ALERT_WARN_BG` are gone from this import, and their absence is
     the fix. They were the translucent fills that let the corporation's livery through the chip. The BORDER
     and INK constants stay, because those are the two properties the warning now uses -- and they are still
     the same constants the action bar's phase badge reads, so chip and badge escalate together (#7). */
  ALERT_CRITICAL_BORDER,
  ALERT_CRITICAL_INK,
  ALERT_WARN_BORDER,
  ALERT_WARN_INK,
  CARD_DIVIDER,
  CARD_INK,
  CARD_INK_FAINT,
  CARD_SURFACE_MUTED,
} from "../styles/palette";
import { FONT_SIZE } from "../styles/typography";
import { TrainGlyph } from "./TrainGlyph";
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
  /** `undefined`/`null` means UNKNOWN -- a contract predating the field -- and
   *  renders "?", never "none". See `PublicCompanyState.owned_trains`. `readonly`
   *  because requiring a mutable array forced callers holding a frozen roster to
   *  copy or cast, which widens the type rather than loosening it. */
  trains?: readonly string[] | null;
  phase: GamePhase | null;
  /** Per-tier rust countdown (`rustOutlook`). Optional: without it a chip
   *  outside the currently-threatened tier still gets a tooltip naming what
   *  will destroy it, just without the "(N purchases away)" figure -- a
   *  number we cannot stand behind is worse than no number. */
  outlook?: Readonly<Record<TrainTier, TierRustOutlook>> | null;
  /* Design note #375: the index is the position in `trains`, the same key the
     Route Planner rows and map overlays use -- two 3-trains are two different
     trains, get two rows and highlight independently (`RoutePlannerPanel #5`).
     All three cursor props are optional because this renders in four places and
     only the Operating Round strip during Run Routes has a cursor to share. */
  highlightedTrainIndex?: number | null;
  onHighlightTrain?: (trainIndex: number | null) => void;
  /** Design note #375: only the surface that shares a cursor makes its
   *  chips interactive. Elsewhere they stay inert badges. */
  interactive?: boolean;
}

/* Design note #4: two questions, both now answered for every tier. ESCALATION
   is the chip's COLOUR, driven by the DEPOT rather than the tier so the warning
   does not shout from the moment a phase begins. OUTLOOK is the TOOLTIP, present
   even on permanent tiers -- a 5-train with no tooltip is indistinguishable from
   one whose tooltip failed to load. Counts come from `rustOutlook`, which the
   action bar's phase tag also reads (`gamePhase.ts #5` / `#6`), which is the fix
   for the tag and the chip disagreeing about how many purchases were left. */
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

  // Design note #3: the empty and unknown states are chips too. They used to be
  // bare text beside a floated corporation's pills, so the two read as different
  // KINDS of readout rather than the same one with different contents. Same shell,
  // muted ink, so a column of cards lines up whatever each holds.
  const placeholderChip = (label: string) => (
    <span style={styles.chipRow}>
      <span
        style={{
          ...styles.chip,
          ...ink.chip,
          ...ink.empty,
          // Design note #702: the same ring. "none" and "?" are chips too (#3), and a placeholder without an
          // edge would dissolve into a livery card exactly as a real one did.
          boxShadow: surface === "light" ? LIGHT_CHIP_RING : DARK_CHIP_RING,
          fontSize: size,
          padding: compact ? "1px 6px" : "2px 9px",
          minWidth: compact ? "22px" : "28px",
          fontWeight: 600,
          cursor: "default",
          // No locomotive: there is no train to draw, which is what the word says.
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
  // Design note #7 (`gamePhase.ts`): severity comes from the SHARED countdown, not
  // a second reading of `depotRemaining`. Same two thresholds -- one purchase out
  // is `doomed`, two is `atRisk` -- but the action bar reads the identical helper,
  // so the chip and the badge cannot escalate at different moments. Untinted until
  // the countdown reaches two.
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
              // Design note #702: the ring, on EVERY chip and in every state. See `styles.chip`.
              boxShadow: surface === "light" ? LIGHT_CHIP_RING : DARK_CHIP_RING,
              fontSize: size,
              padding: compact ? "1px 5px 1px 4px" : "2px 8px 2px 6px",
              minWidth: compact ? "26px" : "34px",
              gap: compact ? "3px" : "4px",
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
            {/* Design note #702: THE LOCOMOTIVE HOLDS STILL WHILE THE NUMBER CHANGES COLOUR.
                REPORTED: "the train icon could be black or something to signal it's still there even as the
                number turns amber, red."
                That is the whole job. Once the tint moved to the number, a tinted chip and a plain one differ
                only by the colour of one numeral -- which is exactly the discrimination that failed at the top
                of this report ("I actually thought the 3-train purchase had been swapped out"). The glyph is
                the chip's constant: it never tints, so the reader always has a fixed thing to find, and what
                the colour changes is legible AGAINST it rather than instead of it.
                `ink.chip.color`, not the tint -- deliberately the SAME neutral in all three states. */}
            <TrainGlyph
              tier={tier ?? model}
              color={String(ink.chip.color)}
              carriages={false}
              height={compact ? 9 : 10}
            />
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
  /** The corporation's most recent route revenue -- `PublicCompanyState.
   *  last_route_revenue`. THIS IS NOW LIVE: the contract gained the field, writes
   *  it on every route run and returns it from `GetGameState`.
   *
   *  `undefined` still means "this build cannot tell you" and renders differently.
   *  A real `"0"` means the corporation ran and earned nothing, which is a fact
   *  rather than an absence. */
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
  /* Design note #7 (`gamePhase.ts`): the SAME two constants the action bar's phase-shift badge uses, so chip
     and badge escalate together by construction. Amber became orange here because amber is already spent on
     "look here" and on the Yellow ERA.

     Design note #702: NO `backgroundColor`. THE TINT COLOURS THE NUMBER, NOT THE BODY.

     REPORTED: "NNH is running and already owned a 2-train and a 3-train ... Its 2-train chip almost
     disappears into its corporation card -- I actually thought the 3-train purchase had been swapped out with
     it because it is so hard to see ... To avoid this issue on other corporations (red on red later, etc),
     what if we just colored the number itself and left the train chip alone?"

     THE FILLS WERE TRANSLUCENT -- `rgba(249, 115, 22, 0.1)` and `rgba(244, 63, 94, 0.2)`. Ten percent of a
     colour over ninety percent of whatever is behind it is not a chip, it is a tint on the backdrop, and the
     backdrop here is the CORPORATION'S LIVERY (`ContextualActionBar` paints the card
     `stationTickerColor(companyId)`). Measured against all eight cards the tinted body scores 1.00 to 1.14:1
     -- it has no edge on ANY of them. NNH is 1.00:1 exactly, because its livery `#ee7c22` and this warning
     orange `#f97316` are the same hue at the same lightness, which is why NNH is where it was noticed.

     SO THE BUG WAS NEVER "AMBER ON ORANGE". It was a translucent fill on an arbitrary hue, and NNH was the
     one collision loud enough to report. Dropping `backgroundColor` gives every state the opaque body above,
     and the tint moves to the two properties that sit ON that body and can be measured against it. */
  atRisk: {
    borderColor: ALERT_WARN_BORDER,
    color: ALERT_WARN_INK,
  },
  doomed: {
    borderColor: ALERT_CRITICAL_BORDER,
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
  /* Design note #702: the light palette's tints were already OPAQUE pastels, so they never had the dissolving
     problem -- and they go too, for the other half of the report. "To avoid this issue on other corporations
     (red on red later, etc)" is asking for one rule rather than one fix, and a chip that changes its whole
     body on one surface and only its number on the other is two rules wearing one name. */
  atRisk: { borderColor: "#b8860b", color: "#6b4e05" },
  doomed: { borderColor: "#b91c1c", color: "#7a1020" },
  atCapacity: { borderColor: "#7e22ce", backgroundColor: "#ece0fb", color: "#4a1670" },
  empty: { color: CARD_INK_FAINT },
  value: { color: CARD_INK },
} as const;

/* Design note #702: A CHIP THAT HAS AN EDGE ON ANY BACKDROP.

   REPORTED, of the untinted chips: "on the blue B&O corporate card, the train chips similarly dissolve, though
   it is not quite as dramatic as the NNH 2-train disappearing act, so I'm wondering if we need to do something
   more for the train chips themselves to make them stand out ... make the chips '3D'?"

   MEASURED: the plain dark chip `#232936` scores 1.50:1 against B&O's `#12408f` and 1.20:1 against NYC's
   `#1a1a1a`. `surface: "dark" | "light"` names the app CHROME, and these are drawn on a card painted the
   corporation's own colour -- a prop with two values cannot describe eight backdrops, so the palette was
   answering a question it had not been asked.

   NO SINGLE COLOUR CAN FIX THIS, and that is the whole design. The liveries span the full lightness range,
   `#1a1a1a` to `#f5cd3a`; any fixed edge colour is near-invisible against SOME card, and searching for the
   best one gets 1.5:1 at its optimum. The way out is to stop asking the ring to contrast with the card and
   make the RING CONTAIN ITS OWN CONTRAST: a near-black stroke immediately outside the chip and a light
   hairline immediately inside it. Those two are ADJACENT, so the reader sees a light-against-dark boundary
   whatever is behind -- 4.1:1 at worst across all eight liveries, and card-independent by construction. It is
   the same instrument a map label uses to stay legible over aerial photography, and the honest version of
   "3D": the bevel is real, not decorative.

   `box-shadow`, not a second border: a border changes the box's size, and #370 settled this geometry in whole
   pixels after a fractional height cost the bottom edge. Shadows are drawn outside the layout. The third
   layer is an ordinary soft drop, which does the depth the report asked for and nothing structural. */
const DARK_CHIP_RING = [
  "inset 0 0 0 1px rgba(255, 255, 255, 0.45)",
  "0 0 0 1px rgba(0, 0, 0, 0.8)",
  "0 1px 2px rgba(0, 0, 0, 0.4)",
].join(", ");
/* On paper the pair swaps polarity: the chip is pale, so the inner hairline goes dark to read against it while
   the outer stroke softens -- a linen card is not a surface anything casts a hard shadow onto. */
const LIGHT_CHIP_RING = [
  "inset 0 0 0 1px rgba(0, 0, 0, 0.16)",
  "0 0 0 1px rgba(0, 0, 0, 0.28)",
  "0 1px 2px rgba(0, 0, 0, 0.16)",
].join(", ");

const styles: Record<string, React.CSSProperties> = {
  /* Design note #370: the chip had no height of its own -- `lineHeight: 1.25` on a
     15px font plus padding and borders gave a FRACTIONAL 24.75px box, which rounds
     unpredictably by zoom and subpixel offset and drops the 1px bottom border.
     `inline-flex` also sits on a baseline, so a chip taller than its own line box
     overhangs, and #299 had cut `orContextCard`'s padding to 3px with nothing left
     to absorb it. `minHeight` states the box in whole pixels and
     `alignSelf: flex-start` stops baseline alignment stretching it; `App.tsx #371`
     gives the card back the two pixels the row needs. Both halves are required. */
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
