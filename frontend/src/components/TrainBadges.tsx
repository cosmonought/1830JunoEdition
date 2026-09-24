// Train chips, capacity pill and last-route-payout readout, shared by the
// Operating Round corporations table and the Stock Round card fronts.
//
// Design note #0: SHARED because the rust rule must not fork. A second copy that
// drifted by one phase would show green chips on trains that rust on the very
// next purchase. The rule reads `GamePhase` (`gameEngine/gamePhase.ts`) once.
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

import React, { useEffect, useMemo, useState } from "react";

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
import { FONT_SIZE, RADIUS } from "../styles/typography";
import { TrainGlyph } from "./TrainGlyph";
import {
  phaseAlertLevel,
  trainTier,
  trainTierName,
  type GamePhase,
  type TierRustOutlook,
  type TrainTier,
} from "../gameEngine/gamePhase";
// Design note #1034: the one place that says a reprieved train occupies no limit slot.
import { countableTrainCount } from "../gameEngine/trainLimit";
// Design note #1702 (GR-3): the Final Run chip's wording, shared with the bar's badge.
import { finalRunChipTooltip } from "../utils/finalRunTiming";
/* Design note (VF-7): the rust flourish's schedule, crack geometry and stylesheet. This component owns
   the staging and the timers; that module owns everything testable without a DOM. */
import {
  buildRustSequence,
  crackFragments,
  crackPath,
  crackSeedFor,
  rustChipStageClass,
  rustCrackClass,
  rustedFleetFor,
  rustingPositions,
  TRAIN_RUST_CSS,
  type RustFlourishEvent,
  type RustSequence,
  type RustStageKind,
} from "./trainRustFlourish";
/* Design note (VF-8): the train-limit discard's own vocabulary. A SEPARATE module from the rust one,
   deliberately and not merely tidily: the two flourishes mean opposite things (destroyed versus
   transferred), and two vocabularies that shared an implementation would drift into looking alike. */
import {
  buildDiscardSequence,
  discardChipStageClass,
  discardCut,
  discardCutClass,
  discardCutSeedFor,
  discardFor,
  discardIsSplit,
  TRAIN_DISCARD_CSS,
  type DiscardSequence,
  type DiscardStageKind,
  type TrainDiscardEvent,
} from "./trainDiscardFlourish";

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

/** The Yellow Sign, served from `public/` by absolute path.
 *
 *  ==================================================================
 *   DESIGN NOTE 1088: NAMED HERE, AND ASSERTED AGAINST THE FILESYSTEM
 *  ==================================================================
 *
 *  NOT IMPORTED, which is `audio.ts` #1009's rule for the same reason: a bundled asset gets a content hash in
 *  its filename, and the path is the contract. `public/images/` rather than `public/audio/` -- the two Yellow
 *  Sign videos live in `audio/` and that is a wart, not a precedent for putting a PNG there.
 *
 *  #1040'S LESSON APPLIES TO PICTURES TOO. A missing media file is the quietest failure in this codebase: an
 *  `<img>` whose `src` 404s renders as nothing or as a broken-image glyph depending on the browser, and
 *  neither throws. `batch59` asserts this exact name exists on disk, which is the only thing that turns a
 *  typo into a red test rather than a chip that lost its icon in one game state nobody plays often. */
export const YELLOW_SIGN_IMAGE = "/images/yellow-sign.png";

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
  /** Design note #1004: the models under a Gentle Rust reprieve -- `pending_rust_trains`, verbatim. A chip
   *  matching one is on its final run whatever the depot outlook says, because the tier that doomed it has
   *  already arrived and the outlook has moved on to the next one. Optional: three of this component's four
   *  call sites have no reprieve to report, and absent means "none marked" rather than "unknown", which is
   *  the safe direction -- a missing mark under-warns, an invented one pulses a train that is fine. */
  reprieved?: readonly string[] | null;
  /** Design note #1702 (GR-3, U-1): the reprieves whose Final Run is the corporation's Operating Turn NOW IN
   *  PROGRESS -- `finalRunScheduleFor(state, id).thisTurn`, a sub-multiset of `reprieved`. A Final Run chip
   *  matching one says it goes after this turn's Run Routes; any other Final Run chip says its corporation's
   *  NEXT Operating Turn. Absent means the surface cannot say (it has no board to ask), and the tooltip then
   *  names the rule instead of a turn -- never a guess in either direction. Wording only: the fade is
   *  `reprieved`'s, unchanged. */
  reprievedThisTurn?: readonly string[] | null;
  /** ==================================================================
   *   DESIGN NOTE 1088: THE GHOSTS, FOR THE SAME REASON THE REPRIEVES TRAVEL
   *  ==================================================================
   *
   * RULED: "Check the train's state for the Carcosa/Yellow Sign flag. If true, render the provided Yellow
   * Sign image instead of the default train icon ... Make sure this applies everywhere train chips are
   * displayed."
   *
   * Design note #1089 REPOINTED THIS AT `carcosan_trains`. It was `ghost_trains`, which is the TRAIN-LIMIT
   * exemption and empties at the end of the Operating Round -- so the sign would have fallen off the chip one
   * round after the gift while the train was still gold-trimmed, and the doom clock would have had nothing to
   * point at. The prop keeps its name because what it means to this component is unchanged: "these models are
   * the Carcosa train".
   *
   * `carcosan_trains` VERBATIM, exactly as `reprieved` is `pending_rust_trains` verbatim. The gift joins
   * `owned_trains` like any other train (#1046: "the roster stays the one place a fleet lives, and the
   * exception is a mark beside it"), so a chip cannot tell on its own that it is looking at one -- the mark
   * has to arrive with it.
   *
   * A SECOND LIST RATHER THAN A WIDER `reprieved`, which is the distinction `CapacityPill` #1046 already
   * draws one interface down: the two marks expire on different clocks, and a chip that is BOTH is possible
   * in principle even if today's rules never produce it.
   *
   * OPTIONAL, and absent means "none marked" rather than "unknown" -- the safe direction, since a missing
   * mark shows an ordinary train where a standard game has no ghosts at all. */
  ghosts?: readonly string[] | null;
  /** ==================================================================
   *   DESIGN NOTE (VF-7): WHOSE FLEET THIS IS, AND THE RUST THAT JUST TOOK PART OF IT
   *  ==================================================================
   *
   * `companyId` IS NEW AND IS ONLY FOR THE FLOURISH. This component has never needed to know which
   * corporation it is drawing -- `trains` was the whole of its subject -- and it still does not, for
   * anything but deciding whether a global rust event is about this fleet. Optional, because two of the
   * five call sites draw a roster in a context where no rust can be live (the Stock Round card fronts and
   * the Ledger) and passing an id they would never match is noise.
   *
   * `rust` IS THE WHOLE EVENT, not this corporation's share of it, and that is deliberate: a phase change
   * rusts several fleets in one reducer call, and handing every chip row the same object is what keeps
   * them on one clock. The row picks out its own member with `rustedFleetFor` and ignores the rest.
   *
   * PRESENTATION ONLY, AND OPTIONAL AT BOTH ENDS (A-3): absent, `null`, superseded, or naming a
   * corporation this row is not, the chips render `trains` exactly as they did before this batch. */
  companyId?: number | null;
  rust?: RustFlourishEvent | null;
  /** Design note (VF-8): the president's train-limit discard, if this row's corporation is the one that
   *  just answered its obligation. One discard per event -- the rules never produce two at once -- so
   *  unlike `rust` this carries a single subject rather than a list. Optional and inert at both ends
   *  (A-3): absent, `null`, superseded, or naming a corporation this row is not, the chips render
   *  `trains` exactly as they did before this batch. */
  discard?: TrainDiscardEvent | null;
  /* Design note #375: the index is the position in `trains`, the same key the
     Route Planner rows and map overlays use -- two 3-trains are two different
     trains, get two rows and highlight independently (`RoutePlannerPanel #5`).
     All three cursor props are optional because this renders in four places and
     only the Operating Round strip during Run Routes has a cursor to share. */
  highlightedTrainIndex?: number | null;
  onHighlightTrain?: (trainIndex: number | null) => void;
  /* ==================================================================
   *  DESIGN NOTE 801: A CHIP IS A HANDLE, NOT ONLY A BADGE
   * ==================================================================
   *
   * REQUESTED: "the Run Routes fixed subpanel can be completely done away with in exchange for the ability to
   * click the train chips and have the sticky Action bar expand slightly to list its route. Players can click
   * through each one to see what it's doing without needing the huge subpanel."
   *
   * #375 MADE THE CHIP SHARE A CURSOR AND STOPPED THERE. It gave the chip hover -- "a chip and a route line
   * are two views of one thing" -- while the route line itself lived in a panel below. Selection is the other
   * half of that idea: if the chip and the line are one thing, the chip is where you ask for the line.
   *
   * SELECT AND HIGHLIGHT ARE DIFFERENT AND BOTH SURVIVE. Hover still previews on the map and is transient
   * (#9's rule); a CLICK is durable and is what opens the detail. Two cursors because they answer two
   * questions -- "what is this one" and "which one am I reading" -- and collapsing them would make the detail
   * flicker as the pointer crossed the row. */
  selectedTrainIndex?: number | null;
  onSelectTrain?: (trainIndex: number) => void;
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
  /* Design note #1007: THE ORIGINAL OF THE SPECIAL CASE, now deferring to the shared namer. This inline
     ternary predates the helper -- it is where "Diesel" entered the tree, and every other surface spelling it
     that way was copying this line. It is converted rather than left because a rule stated in one place and
     restated in its siblings is how the two spellings arose. */
  const triggerName = trainTierName(trigger);
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

/** The house idiom, optional-chained twice because a test environment has a `window` and no `matchMedia`
 *  (`BankTicket` VF-6, `PhaseBadge` VF-4, `StockRoundPanel` VF-3, `HexGridRenderer` #496). */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

interface RustProgress {
  sequence: RustSequence | null;
  stageIndex: number;
  vacated: boolean;
}

const NO_RUST: RustProgress = { sequence: null, stageIndex: 0, vacated: false };

function startOfRust(sequence: RustSequence | null): RustProgress {
  return { sequence, stageIndex: 0, vacated: false };
}

const NO_POSITIONS: ReadonlySet<number> = new Set<number>();

/** This row's share of a global rust event, and where the sequence has got to.
 *
 *  #1456's "the reset is a render, not an effect", for the reason VF-1, VF-3, VF-4 and VF-6 all keep it: a
 *  superseding rust must not let a stale `vacated` paint one frame of the new sequence, so the mismatch is
 *  resolved DURING render rather than in a passive effect. */
function useTrainRust(
  event: RustFlourishEvent | null | undefined,
  companyId: number | null,
): {
  sequence: RustSequence | null;
  stage: RustStageKind | null;
  vacated: boolean;
  before: readonly string[] | null;
  rustingAt: ReadonlySet<number>;
  reducedMotion: boolean;
} {
  const reducedMotion = prefersReducedMotion();
  const fleet = rustedFleetFor(event, companyId);
  /* Keyed on the EVENT'S OWN TOKEN and this row's id: two rust events in a row (an Undo past a phase
     change, then the same purchase again) are two ceremonies, and the models alone cannot tell them
     apart. A row the event does not name builds no sequence and schedules no timers at all. */
  const sequence = useMemo(
    () => (fleet ? buildRustSequence({ corporations: [fleet] }, reducedMotion) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [event?.token, companyId, reducedMotion],
  );
  const [progress, setProgress] = useState<RustProgress>(() => NO_RUST);

  const live = progress.sequence === sequence ? progress : startOfRust(sequence);
  if (live !== progress) setProgress(live);

  useEffect(() => {
    if (!sequence) return undefined;
    const timers: number[] = [];
    const advance = (at: number, step: (was: RustProgress) => RustProgress) => {
      timers.push(
        window.setTimeout(() => {
          setProgress((was) => (was.sequence !== sequence ? was : step(was)));
        }, at),
      );
    };
    sequence.stages.forEach((stage, index) => {
      if (index === 0) return;
      advance(stage.at, (was) => ({ ...was, stageIndex: index }));
    });
    sequence.applications.forEach((application) => {
      advance(application.at, (was) => ({ ...was, vacated: true }));
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [sequence]);

  const staging = sequence !== null && fleet !== null && !live.vacated;
  return {
    sequence,
    stage: sequence ? (sequence.stages[live.stageIndex]?.kind ?? null) : null,
    vacated: live.vacated,
    before: staging && fleet ? fleet.before : null,
    rustingAt: staging && fleet ? rustingPositions(fleet.before, fleet.rusted) : NO_POSITIONS,
    reducedMotion,
  };
}

interface DiscardProgress {
  sequence: DiscardSequence | null;
  stageIndex: number;
  transferred: boolean;
}

const NO_DISCARD: DiscardProgress = { sequence: null, stageIndex: 0, transferred: false };

function startOfDiscard(sequence: DiscardSequence | null): DiscardProgress {
  return { sequence, stageIndex: 0, transferred: false };
}

/** This row's discard, and where the sequence has got to. VF-7's `useTrainRust` exactly, one event shape
 *  over -- including #1456's "the reset is a render, not an effect", so a superseding discard cannot let
 *  a stale `transferred` paint one frame of the new sequence. */
function useTrainDiscard(
  event: TrainDiscardEvent | null | undefined,
  companyId: number | null,
): {
  sequence: DiscardSequence | null;
  stage: DiscardStageKind | null;
  before: readonly string[] | null;
  at: number;
  reducedMotion: boolean;
} {
  const reducedMotion = prefersReducedMotion();
  const mine = discardFor(event, companyId);
  const sequence = useMemo(
    () => (mine ? buildDiscardSequence({ discard: mine }, reducedMotion) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [event?.token, companyId, reducedMotion],
  );
  const [progress, setProgress] = useState<DiscardProgress>(() => NO_DISCARD);

  const live = progress.sequence === sequence ? progress : startOfDiscard(sequence);
  if (live !== progress) setProgress(live);

  useEffect(() => {
    if (!sequence) return undefined;
    const timers: number[] = [];
    const advance = (at: number, step: (was: DiscardProgress) => DiscardProgress) => {
      timers.push(
        window.setTimeout(() => {
          setProgress((was) => (was.sequence !== sequence ? was : step(was)));
        }, at),
      );
    };
    sequence.stages.forEach((stage, index) => {
      if (index === 0) return;
      advance(stage.at, (was) => ({ ...was, stageIndex: index }));
    });
    sequence.applications.forEach((application) => {
      advance(application.at, (was) => ({ ...was, transferred: true }));
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [sequence]);

  const staging = sequence !== null && !live.transferred;
  return {
    sequence,
    stage: sequence ? (sequence.stages[live.stageIndex]?.kind ?? null) : null,
    before: staging ? sequence.discard.before : null,
    at: staging ? sequence.discard.at : -1,
    reducedMotion,
  };
}

export function TrainChips({
  trains,
  phase,
  surface,
  compact,
  outlook,
  reprieved = null,
  reprievedThisTurn = null,
  ghosts = null,
  companyId = null,
  rust = null,
  discard = null,
  highlightedTrainIndex = null,
  onHighlightTrain,
  selectedTrainIndex = null,
  onSelectTrain,
  interactive = false,
}: TrainChipsProps) {
  const ink = surface === "light" ? lightInk : darkInk;
  const size = compact ? FONT_SIZE.small : FONT_SIZE.strong;

  /* ==================================================================
      DESIGN NOTE (VF-7): THE ROW RENDERS THE FLEET AS IT WAS, UNTIL THE SLOT IS GIVEN UP
     ==================================================================
     A-2, and the whole reason the event carries `before`. The authoritative roster has ALREADY lost the
     rusted trains by the time this renders -- the reducer settled before the shell narrated (#704) -- so
     a row drawing `trains` would show the final state and then, at best, mime a destruction that had
     already happened. Instead the row draws the pre-rust fleet, rusts the chips that are leaving, holds
     their slots until they are invisible, and only then falls through to `trains`.
     ABOVE THE EARLY RETURNS, AND THAT IS LOAD-BEARING TWICE OVER. Hooks cannot sit behind a conditional
     return -- and the "none" placeholder below is exactly the case a corporation whose WHOLE fleet rusted
     would hit: `trains` is `[]`, so without staging the chips would vanish on the spot and the row would
     print "none" before anything had been shown to fail. */
  const rustState = useTrainRust(rust, companyId ?? null);
  /* Design note (VF-8): the discard stages the same way and for the same reasons. The two can never be
     live for one corporation at once -- rust fires on a phase change or a reprieve expiry, a discard on
     the president's own answer to an obligation -- and if a future rule ever produced both, rust's
     staged roster wins by being asked first, which is the safe direction: a destroyed train must not be
     drawn as merely transferred. */
  const discardState = useTrainDiscard(discard, companyId ?? null);
  const staged = rustState.before ?? discardState.before ?? trains;

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
  if (staged == null) return placeholderChip("?");
  if (staged.length === 0) return placeholderChip("none");

  const doomed = phase?.rustingTier ?? null;
  // Design note #7 (`gamePhase.ts`): severity comes from the SHARED countdown, not
  // a second reading of `depotRemaining`. Same two thresholds -- one purchase out
  // is `doomed`, two is `atRisk` -- but the action bar reads the identical helper,
  // so the chip and the badge cannot escalate at different moments. Untinted until
  // the countdown reaches two.
  const alert = phaseAlertLevel(phase);
  const severity = alert === "critical" ? "doomed" : alert === "warn" ? "atRisk" : null;

  /* ==================================================================
      DESIGN NOTE 1004: A REPRIEVED TRAIN KEEPS ITS WARNING
     ==================================================================
     REPORTED: "When a phase-change train is bought, the red/amber warning badges and flashing train chips
     immediately disappear for the reprieved trains."
     AND THE CAUSE IS THAT THE DEPOT MOVED ON. `inDangerWindow` is computed from `doomed` -- the tier NEXT in
     line to rust, read off the depot outlook -- so the instant the phase turns, the tier that just rusted
     stops being the one at risk and every chip of it goes quiet. Correct for the standard game, where those
     trains no longer exist; wrong under Gentle Rust, where they are still in the fleet and still about to
     die.
     SO THE MARK IS AN INPUT NOW, not only a derivation. `reprieved` is the corporation's own
     `pending_rust_trains`, and a chip matching one is doomed whatever the depot says -- which is the same
     shape #979 used for the limit: the reprieve is a fact about THIS fleet, and a rule derived from the
     depot cannot see it.
     A MULTISET, CONSUMED AS IT MATCHES. A corporation holding one reprieved 3 and one live 3 must show one
     pulsing chip and one still one; a `.includes` would pulse both, which is the same off-by-one
     `trimToTrainLimit` records for the trim. */
  const reprievedPool = [...(reprieved ?? [])];
  /* Design note #1702 (GR-3): which Final Run chips are owed THIS turn, consumed the same way. `null` when the
     surface cannot say. */
  const thisTurnPool = reprievedThisTurn == null ? null : [...reprievedThisTurn];
  /* Design note #1088: A MULTISET, CONSUMED AS IT MATCHES, for exactly #1004's reason one line up. A
     corporation that already owned a 5-train and is then gifted one by Carcosa holds two identical models
     and must show one sign and one locomotive; `.includes` would mark both, which is the off-by-one
     `trimToTrainLimit` records and the reprieve pool above was written to avoid. */
  const ghostPool = [...(ghosts ?? [])];

  const rustAnimationMs =
    rustState.sequence?.stages.find(
      (entry) => entry.kind === (rustState.stage === "fail" ? "fail" : "oxidise"),
    )?.durationMs ?? null;

  /* ==================================================================
      DESIGN NOTE (VF-7): THE KEY DECIDES WHICH DUPLICATE SURVIVES, AND IT WAS DECIDING WRONGLY
     ==================================================================
     FOUND BY PROBING THE DOM ACROSS THE VACATE BOUNDARY, in the case the models are indistinguishable:
     a corporation holding ["3", "3", "5"] that loses ONE 3. The SELECTION was always right -- the
     multiset marks staged position 0 and only position 0, stably, on every stage render. The KEYING was
     not.

     `key={model-index}` NAMES A POSITION IN WHICHEVER ARRAY IS BEING RENDERED, and the two arrays are
     different lengths. Staged ["3","3","5"] gives 3-0, 3-1, 5-2; authoritative ["3","5"] gives 3-0, 5-1.
     So at the handover React matched `3-0` to `3-0` -- REUSING THE DYING CHIP'S DOM NODE FOR THE
     SURVIVING 3 -- unmounted `3-1`, which was the survivor that had been sitting there untouched, and
     remounted the 5 because its key moved from `5-2` to `5-1`. Measured, not reasoned: a probe tagging
     each node found the post-vacate "3" carrying the dying node's tag and the "5" carrying none.

     THAT IS THE BRIEF'S "do not rust both and recreate one afterward" arriving by the back door, and it
     breaks section 6's "preserve each corporation's unaffected chip order/identity" for the 5 as well --
     a chip that had nothing to do with the event was destroyed and rebuilt.

     SO A STAGED CHIP IS KEYED BY WHERE IT WILL BE, NOT BY WHERE IT IS. A survivor takes the key it will
     have in the authoritative roster (`after` is `before` minus the rusted models, order preserved, so
     counting non-rusting positions gives exactly that index); a dying chip takes a key of its own that
     simply disappears at the handover. React then unmounts precisely the chips that died and touches
     nothing else.
     AND WITH NOTHING RUSTING THE KEY IS BYTE-IDENTICAL to what it always was -- `survivorIndex` and
     `index` advance together -- so the ordinary row is unchanged. */
  let survivorIndex = 0;
  const chipKeys = staged.map((model, index) => {
    if (rustState.rustingAt.has(index)) return `rusting:${index}`;
    /* Design note (VF-8): the same rule for the departing chip, and it matters for the same reason --
       ["3","3","5"] discarding one 3 has the identical key collision VF-7's probe found in the DOM. */
    if (discardState.at === index) return `discarding:${index}`;
    const key = `${model}-${survivorIndex}`;
    survivorIndex += 1;
    return key;
  });

  /* ==================================================================
      DESIGN NOTE (VF-7): AND THE INTERACTION INDICES BELONG TO THE OTHER ARRAY
     ==================================================================
     `onSelectTrain(index)` and `onHighlightTrain(index)` hand out a position in the roster the caller
     knows about -- the AUTHORITATIVE one -- and while staging, `index` is a position in the pre-rust
     roster instead. A click during those few hundred milliseconds would open a different train's route
     than the one under the pointer.
     UNREACHABLE TODAY AND GUARDED ANYWAY. The chips are interactive only on the Routes step
     (`ContextualActionBar`: `interactive={orSubPhase === "Routes"}`), and a rust fires on a train
     purchase or a reprieve expiry, both of which happen elsewhere in the turn. But "cannot happen" is
     an argument about today's cursor rules made in a file that knows nothing about them, and this
     codebase's notes are full of exactly that argument going stale. One boolean makes the mismatch
     impossible instead. */
  const interactiveNow =
    interactive && rustState.before === null && discardState.before === null;

  return (
    <span style={styles.chipRow}>
      {/* #46/#18's escape hatch: keyframes, a dash-offset draw and a `::before`-free SVG overlay are what
         an inline style cannot express. Injected only for a row that is ACTUALLY rusting, unlike the
         roster-level sheets VF-1/VF-3 inject unconditionally -- this component renders once per
         corporation and there are eight of them, so an unconditional sheet would put eight identical
         copies in the table for an event that touches two. The style element and the class arrive in the
         same commit, so the keyframes are registered before the browser paints either. */}
      {rustState.sequence !== null && <style>{TRAIN_RUST_CSS}</style>}
      {discardState.sequence !== null && <style>{TRAIN_DISCARD_CSS}</style>}
      {staged.map((model, index) => {
        const tier = trainTier(model);
        // Design note #4: the TINT is still depot-driven and still only
        // applies to the tier actually next in line to rust. Preserved
        // exactly -- the tooltip work below does not touch it.
        const reprievedAt = reprievedPool.indexOf(model);
        const isFinalRun = reprievedAt >= 0;
        if (isFinalRun) reprievedPool.splice(reprievedAt, 1);
        const ghostAt = ghostPool.indexOf(model);
        const isGhost = ghostAt >= 0;
        if (isGhost) ghostPool.splice(ghostAt, 1);
        const inDangerWindow = isFinalRun
          ? "doomed"
          : doomed !== null && tier === doomed && severity !== null
            ? severity
            : null;
        /* Design note #1088: the ghost's tooltip REPLACES the rust one rather than joining it. A ghost is
           never in a rust window (see the glyph note below), so there is nothing to lose -- and "Yellow Sign
           ghost train" is the fact a player hovering an unfamiliar icon is actually asking about. */
        /* ==================================================================
            DESIGN NOTE 1702 (GR-3, U-1): A FINAL RUN CHIP HAS ALREADY RUSTED
           ==================================================================
           A reprieved chip took the `doomed` window above, and with it "CRITICAL: Rusts on NEXT depot
           purchase!" -- false twice over: the rust already happened, and no purchase destroys it. It goes after
           Run Routes in its one qualifying Operating Turn. So a Final Run chip says that, from the board: this
           turn if its mark is owed the turn in progress, the corporation's next Operating Turn otherwise, and
           the rule itself where the surface has no board to ask. The rust window's wording for a chip that is
           merely one purchase away is untouched (standard and Gentle Rust alike). */
        const finalRunWhen: "this-turn" | "next-turn" | null =
          !isFinalRun || thisTurnPool === null
            ? null
            : (() => {
                const at = thisTurnPool.indexOf(model);
                if (at < 0) return "next-turn";
                thisTurnPool.splice(at, 1);
                return "this-turn";
              })();
        const warning = isGhost
          ? "Yellow Sign ghost train — gifted by Carcosa. Occupies no train-limit slot until this Operating Round ends."
          : isFinalRun
            ? finalRunChipTooltip(finalRunWhen)
            : rustTooltip(tier, phase, outlook, inDangerWindow);
        /* Design note #375: highlighted, faded, or neither. The muted state
           matters as much as the primary one -- with three chips in a row,
           "this one" is only legible if the others step back. */
        const isPrimary = interactiveNow && highlightedTrainIndex === index;
        const isMuted =
          interactiveNow && highlightedTrainIndex !== null && highlightedTrainIndex !== index;
        /* Design note (VF-7): this chip's own place in the event. `rustingAt` is a multiset match against
           the staged roster, so a corporation holding two 2-trains that loses one rusts exactly one of
           them -- #1004's reprieve pool and #1088's ghost pool, a third time. */
        const isRusting = rustState.rustingAt.has(index);
        const rustClass = isRusting ? rustChipStageClass(rustState.stage) : undefined;
        /* ==================================================================
            DESIGN NOTE (AUDIO WIRING PASS): THE CHIP COMES APART AT `fail`
           ==================================================================
           ONLY AT `fail`, and only in full motion. Oxidation and the fracture are drawn on an intact chip
           -- the crack has to be readable ON something before that something gives way -- and reduced
           motion has no separation at all, by its own brief. So this is `null` for every other stage and
           every reduced-motion frame, and the row below then takes exactly the path it did before.
           THE SAME SEED AS THE CRACK, so the pieces are the pieces THAT crack made rather than a second
           fracture nobody saw drawn. */
        const shatterInto =
          isRusting && rustState.stage === "fail" && !rustState.reducedMotion
            ? crackFragments(crackSeedFor(companyId ?? 0, index))
            : null;
        const crackClass = isRusting ? rustCrackClass(rustState.stage, rustState.reducedMotion) : null;
        /* Design note (VF-8): this chip's place in a discard. ONE position, taken straight from the
           reducer's own `owned.indexOf(model_type)` (#1530) rather than matched here -- so the chip
           that animates is by construction the chip whose slot the reducer emptied. */
        const isDiscarding = discardState.at === index;
        const discardClass = isDiscarding ? discardChipStageClass(discardState.stage) : undefined;
        const bladeClass = isDiscarding
          ? discardCutClass(discardState.stage, discardState.reducedMotion)
          : null;
        const blade = isDiscarding ? discardCut(discardCutSeedFor(companyId ?? 0, index)) : null;
        const splitHere =
          isDiscarding && discardIsSplit(discardState.stage, discardState.reducedMotion);
        const discardAnimationMs = isDiscarding
          ? (discardState.sequence?.stages.find((entry) => entry.kind === discardState.stage)
              ?.durationMs ?? null)
          : null;
        /* ==================================================================
            DESIGN NOTE (VF-8): THE HALVES ARE SIBLINGS, NOT CHILDREN
           ==================================================================
           A `clip-path` clips its element AND its descendants, so a chip clipped to its own left half
           cannot contain its own right half -- the obvious arrangement is the one arrangement that
           cannot work. So during the split the row renders a SLOT: the left half in normal flow (which
           is what keeps the slot the chip's own size, and therefore reserved) and the right half
           absolutely positioned over it. Both are the same chip element, emitted twice.
           STILL INSIDE THE ROW (A-1): a wrapper span in the chip's own place, no portal, no
           `position: fixed`, no second fleet renderer. The wrapper exists for ~240ms and only for the
           one chip that is leaving. */
        const chipFor = (half: "whole" | "left" | "right", shard: number | null = null) => (
          <span
            /* The WRAPPER carries the destination-stable key when the chip is split; the halves are two
               fixed children of it and need only be told apart. */
            key={shard !== null ? `shard:${shard}` : half === "whole" ? chipKeys[index] : half}
            /* The right half is a duplicate of what the left half already says -- one chip read twice
               would be a chip that owns two trains. */
            /* One chip read three times would be a corporation that owns three trains: only the piece in
               normal flow is left in the accessibility tree. */
            aria-hidden={half === "right" || (shard !== null && shard > 0) ? true : undefined}
            /* Design note #755: THE PULSE IS THE CRITICAL STEP ONLY, matching the badge it was asked to match
               -- `phaseShiftBadgeCritical` animates and `phaseShiftBadgeWarn` does not. That keeps #702's
               rule that "the two countdown steps differ in COLOUR and not merely in whether they pulse", and
               adds a second axis on top of it: two away is amber and still, one away is red and moving. A
               board where every at-risk chip pulsed would have nothing left to escalate TO. */
            /* Design note #1004: the deeper fade for a train already rusted and running once more; the
               shared countdown pulse for one that is merely close. Two states, two classes -- see
               `animations.ts` for why a deeper version of the same keyframe would have read as the same
               warning turned up. */
            /* Design note (VF-7): RUST OUTRANKS BOTH WARNINGS, because both are warnings ABOUT this
               moment and this is the moment. A chip that is being destroyed must not also be breathing
               the "one purchase away" pulse or the reprieve's deeper fade -- two motions on one element
               read as a rendering fault, and the thing they were counting down to has arrived. */
            className={
              [
                /* Design note (VF-8): a discard outranks the warnings for VF-7's reason, and rust
                   outranks a discard because a destroyed train must never be drawn as merely
                   transferred. The two cannot both be live for one corporation today. */
                rustClass ??
                  discardClass ??
                  (isFinalRun
                    ? "app-train-final-run"
                    : inDangerWindow === "doomed"
                      ? "app-train-rust-critical"
                      : undefined),
                half === "left" ? "app-train-cut-left" : undefined,
                half === "right" ? "app-train-cut-right" : undefined,
                shard !== null ? "app-train-rust-shard" : undefined,
                shard !== null && shard > 0 ? "app-train-rust-shard-over" : undefined,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
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
              /* Design note #801: SELECTED OUTRANKS HIGHLIGHTED. Hover is transient and selection is what the
                 open detail is about, so a pointer crossing another chip must not make the panel's subject
                 look like a different train. */
              ...(selectedTrainIndex === index ? styles.chipSelected : {}),
              ...(isMuted ? styles.chipMuted : {}),
              // Every chip carries a tooltip now (design note #4), so every
              // chip gets the help cursor -- and never the text I-beam,
              // which is wrong on a badge regardless.
              cursor: interactiveNow ? "pointer" : warning ? "help" : "default",
              /* The stage that OWNS the running animation supplies its length -- `oxidise` for the wash
                 that spans oxidation and fracture, `fail` for the collapse. Held steady across the
                 oxidise -> fracture boundary on purpose: changing `animation-duration` mid-flight
                 retimes a running animation rather than restarting it, and the oxide would visibly jump. */
              ...(isRusting && rustAnimationMs !== null
                ? { animationDuration: `${rustAnimationMs}ms` }
                : {}),
              /* Design note (VF-8): each half is clipped to its own side of the blade, along the blade's
                 own line -- a polygon rather than an `inset`, so a slanted cut separates on the slant
                 instead of splitting vertically underneath a diagonal line. */
              ...(half === "left" && blade !== null
                ? {
                    clipPath: `polygon(0% 0%, ${blade.xPercent}% 0%, ${blade.xPercent + blade.slantPercent}% 100%, 0% 100%)`,
                  }
                : {}),
              ...(half === "right" && blade !== null
                ? {
                    clipPath: `polygon(${blade.xPercent}% 0%, 100% 0%, 100% 100%, ${blade.xPercent + blade.slantPercent}% 100%)`,
                  }
                : {}),
              ...(isDiscarding && discardAnimationMs !== null
                ? { animationDuration: `${discardAnimationMs}ms` }
                : {}),
              /* The piece's own clip and its own direction. The custom properties are read by
                 `app-train-rust-shard`'s keyframe, which is why one keyframe can serve every piece --
                 cast because React's `CSSProperties` has no index signature for `--*`. */
              ...(shard !== null && shatterInto !== null
                ? ({
                    clipPath: shatterInto[shard].clipPath,
                    "--shard-dx": `${shatterInto[shard].dx}px`,
                    "--shard-dy": `${shatterInto[shard].dy}px`,
                    "--shard-rot": `${shatterInto[shard].rotateDeg}deg`,
                  } as React.CSSProperties)
                : {}),
            }}
            title={warning}
            onMouseEnter={interactiveNow ? () => onHighlightTrain?.(index) : undefined}
            onMouseLeave={interactiveNow ? () => onHighlightTrain?.(null) : undefined}
            /* Design note #801: a click OPENS this train's route. `role`/`tabIndex`/`onKeyDown` rather than a
               `<button>` because the chip is a styled `span` shared by four surfaces, and wrapping it would
               change its layout everywhere to give one of them a handler. The keyboard half is not optional:
               a control reachable only by mouse is not a control on a tablet or for a keyboard player. */
            role={interactiveNow && onSelectTrain ? "button" : undefined}
            tabIndex={interactiveNow && onSelectTrain ? 0 : undefined}
            aria-pressed={interactiveNow && onSelectTrain ? selectedTrainIndex === index : undefined}
            onClick={interactiveNow && onSelectTrain ? () => onSelectTrain(index) : undefined}
            onKeyDown={
              interactiveNow && onSelectTrain
                ? (event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    // Space scrolls a page by default, which is the wrong answer inside a sticky bar.
                    event.preventDefault();
                    onSelectTrain(index);
                  }
                : undefined
            }
          >
            {/* ==================================================================
                 DESIGN NOTE (VF-7): THE FRACTURE, DRAWN OVER WHAT IT BREAKS
                ==================================================================
                ON TOP OF THE TEXT AND THE GLYPH, because a crack runs across whatever is printed on the
                thing that cracked -- and because the model must stay readable THROUGH the fracture: the
                player's question at this instant is what they just lost, and a chip that dissolves before
                it can be read answers the wrong one. The crack darkens the number; it does not hide it.
                A 0-100 VIEWBOX WITH `preserveAspectRatio="none"`, so one generator serves the 26px
                compact chip and the 34px full one and whatever a future surface asks for -- the brief's
                "not a raster image tied to one chip size", taken at its word.
                SEEDED FROM THE CORPORATION AND THE POSITION. The chip re-renders on every stage boundary,
                and a crack regenerated from `Math.random` would redraw itself mid-fracture -- a different
                crack every frame, which is not a crack. Same chip, same fracture, every render; two chips
                in a row, never the same one. */}
            {crackClass !== null && (
              <svg
                className={crackClass}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
                focusable="false"
              >
                <path d={crackPath(crackSeedFor(companyId ?? 0, index))} />
              </svg>
            )}
            {/* ==================================================================
                DESIGN NOTE 755: THE GLYPH TINTS TOO, AND THE PULSE TAKES OVER ITS OLD JOB
                ==================================================================

                #702 HELD THE GLYPH NEUTRAL ON PURPOSE and its reasoning was this: "The glyph is the chip's
                constant: it never tints, so the reader always has a fixed thing to find, and what the colour
                changes is legible AGAINST it rather than instead of it." That was the answer to a report
                about a 2-train chip vanishing into NNH's livery -- "I actually thought the 3-train purchase
                had been swapped out with it".

                REQUESTED NOW: "it should be the number AND the train icon that change colors, and they could
                pulsate like the 'Phase Shift' badge."

                WHICH IS A REVERSAL, AND IT WORKS BECAUSE THE PULSE REPLACES WHAT THE NEUTRAL WAS DOING. #702
                needed the reader to have something fixed to find, and used COLOUR-CONSTANCY for it. Motion
                does that job better: a pulsing chip is unmistakably present, where a chip that merely holds
                one colour steady is only present if you were already looking at it. The constant is now the
                SHAPE -- the locomotive is still there, still the same drawing, still never absent -- and the
                colour is free to escalate with the number.

                SO THE ORIGINAL BUG STAYS FIXED. What made a chip disappear was a translucent fill over an
                arbitrary livery (#702's measurement: 1.00 to 1.14:1 against all eight cards). The body is
                still opaque, the ring still tints, and the glyph now agrees with the number instead of
                arguing with it. */}
            {/* ==================================================================
                 DESIGN NOTE 1088: THE SIGN TAKES THE LOCOMOTIVE'S PLACE, AND ITS BOX
                ==================================================================
                RULED: "render the provided Yellow Sign image instead of the default train icon ... Ensure
                the image is constrained to the exact dimensions of the standard train icon so it does not
                break the chip's layout."

                THE HEIGHT IS THE GLYPH'S OWN, not a new number: `TrainGlyph` is authored at 12 and scaled,
                and both branches read the same `compact ? 9 : 10`. `objectFit: contain` with `width: auto`
                lets the sign keep its 456x547 proportion inside that height -- about 8px wide against the
                locomotive's 11, which is narrower and cannot overflow. `flex: "none"` and `display: "block"`
                are copied from `TrainGlyph`'s own root so the chip's flex row treats the two identically.

                IT CANNOT TINT, AND THAT IS FINE HERE -- but it is worth saying why, because #1074 spent a
                batch on exactly this trap: an image ignores CSS `color`, so a ghost chip in a rust window
                would show a yellow sign inside a red chip. A ghost train cannot BE in one: Carcosa gifts a
                train matching the CURRENT phase tier, and the rusting tier is always an older one. The chip
                body, ring and number still tint around it, so the danger state is not lost even if that
                combination ever became reachable.

                `alt` RATHER THAN `aria-hidden`, which is the opposite of what `TrainGlyph` does. The
                locomotive is decoration -- the model number beside it says everything -- but the sign is the
                ONLY thing on the chip that says this train is a ghost. A screen reader that skipped it would
                hear an ordinary 5-train. */}
            {isGhost ? (
              <img
                src={YELLOW_SIGN_IMAGE}
                alt="Carcosa ghost train"
                aria-label="Yellow Sign"
                height={compact ? 9 : 10}
                style={{
                  height: compact ? 9 : 10,
                  width: "auto",
                  maxHeight: "100%",
                  objectFit: "contain",
                  flex: "none",
                  display: "block",
                }}
              />
            ) : (
              <TrainGlyph
                tier={tier ?? model}
                color={String(
                  (inDangerWindow ? ink[inDangerWindow].color : undefined) ?? ink.chip.color,
                )}
                carriages={false}
                height={compact ? 9 : 10}
              />
            )}
            {model}
            {/* Design note (VF-8): THE BLADE. One straight, near-vertical line, full height, arriving at
               once rather than travelling -- a guillotine falls, it does not propagate, which is the
               whole contrast with VF-7's crack drawing itself across the chip. Drawn in the chip's own
               ink (`currentColor`): this event adds no colour, because nothing about it is a warning.
               On BOTH halves, so the kerf has an edge on each side as they part. */}
            {bladeClass !== null && blade !== null && (
              <svg
                className={bladeClass}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
                focusable="false"
                style={
                  discardAnimationMs !== null ? { animationDuration: `${discardAnimationMs}ms` } : {}
                }
              >
                <line
                  x1={blade.xPercent}
                  y1={0}
                  x2={blade.xPercent + blade.slantPercent}
                  y2={100}
                />
              </svg>
            )}
          </span>
        );
        /* A chip cannot be discarded and rusting at once (see the staging note above), so these two are
           alternatives rather than a case that has to compose. Rust is asked first, for the same reason
           its staged roster wins: a destroyed train must not be drawn as merely cut. */
        if (shatterInto !== null) {
          return (
            <span key={chipKeys[index]} className="app-train-rust-shatter">
              {shatterInto.map((_piece, piece) => chipFor("whole", piece))}
            </span>
          );
        }
        if (!splitHere) return chipFor("whole");
        return (
          <span key={chipKeys[index]} className="app-train-cut-slot">
            {chipFor("left")}
            {chipFor("right")}
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
  /** Design note #1034: the models under a Gentle Rust reprieve, which occupy no limit slot. Absent means
   *  "none marked" rather than "unknown" -- most call sites have no reprieve to report, and a standard game
   *  never has one. */
  reprieved?: readonly string[] | null;
  /** Design note #1046: the Yellow Sign's gift, exempt from the limit until the Operating Round ends. A
   *  second list rather than a wider `reprieved` -- they expire on different clocks. */
  ghosts?: readonly string[] | null;
}

export function CapacityPill({
  trains,
  phase,
  surface,
  compact,
  reprieved,
  ghosts,
}: CapacityPillProps) {
  const ink = surface === "light" ? lightInk : darkInk;
  const size = compact ? FONT_SIZE.small : FONT_SIZE.strong;
  /* ==================================================================
      DESIGN NOTE 1034: THE PILL COUNTS WHAT THE LIMIT COUNTS
     ==================================================================
     RULED, following 1846's delayed obsolescence: gently rusted trains "stop counting to the train limit".
     THIS PILL IS WHERE A PLAYER CHECKS THAT, so a numerator that disagreed with the gate would be the #979
     report again -- one rule, two figures, and the player believing the one on screen. The chips beside it
     still show every train including the condemned ones (that is the ruling's other half); this figure is
     about SLOTS, and the two differing is the fact being communicated rather than an inconsistency.
     `??` NOT `||` ON THE COUNT: zero countable trains is a real answer. */
  const countable = trains == null ? null : countableTrainCount(trains, reprieved, ghosts);
  const atLimit = phase != null && countable != null && countable >= phase.trainLimit;

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
          ? `Phase ${phase.tier} allows ${phase.trainLimit} train${phase.trainLimit === 1 ? "" : "s"} per corporation.` +
            /* Design note #1034: the exemption is stated where the number is, because a pill reading "2 / 2"
               beside three chips is otherwise a corporation that appears to be miscounting its own fleet. */
            /* #1702 (GR-3, U-10): and it names WHAT it is not counted toward, and that the train is still owned --
               "not counted" alone reads as "gone", which is the opposite of SR-1 (audit §3.1). */
            (reprieved && reprieved.length > 0
              ? ` ${reprieved.length} on a Final Run under Gentle Rust: not counted against the train limit, but still the corporation's trains until removed.`
              : "")
          : undefined
      }
    >
      {/* `owned_trains == null` is UNKNOWN, not zero -- "0 / 3" against a
          contract that never told us would read as "buy more trains" when
          the truth is "we cannot see them". */}
      {countable == null ? "?" : countable} / {phase ? phase.trainLimit : "?"}
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

/** ==================================================================
 *   DESIGN NOTE 1391: ONE RULE FOR "LAST RUN", WHEREVER IT IS PRINTED
 *  ==================================================================
 *  `last_route_revenue` is the CURRENT turn's run and is cleared when the turn moves on (#777);
 *  `last_completed_run_revenue` is what the corporation last filed. The Stock panel has combined them since
 *  #1032 -- the live figure while it exists, else the filed one -- and the Rail Map's corporations panel and
 *  the Ledger kept reading the turn-scoped field alone, so between turns every corporation showed $0. The
 *  rule lives beside the component that prints the figure, and the three surfaces call it. */
export function lastRunFigure(
  company: { last_route_revenue?: string | null; last_completed_run_revenue?: string | null },
): string {
  const live = Number(company.last_route_revenue ?? 0) || 0;
  const filed = Number(company.last_completed_run_revenue ?? 0) || 0;
  return String(live > 0 ? live : filed);
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
  chip: { borderColor: "#3a3a3a", backgroundColor: "#1c1c1c", color: "#f2f0eb" },
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
  empty: { color: "#6e6c68" },
  value: { color: "#f2f0eb" },
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
  /* Design note #801: the open chip. An outline rather than a fill, because the chip's fill already carries
     the rust state (#755) and a second meaning on the same channel is how #732's colour-only signals go
     wrong. `outlineOffset` keeps it clear of #702's ring. */
  chipSelected: {
    outline: "2px solid rgba(255, 255, 255, 0.92)",
    outlineOffset: "1px",
  },
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
    borderRadius: RADIUS.control,
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
    borderRadius: RADIUS.pill,
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
