// frontend/src/components/stockTransferFocus.ts
//
// The order a stock transaction is read in, and how long each part of it takes.
//
/* ==================================================================
 *  DESIGN NOTE 1451: ONE TRANSACTION, TWO STEPS, A PAIR AT A TIME
 * ==================================================================
 *
 * RULED: "The corporation card stays focused continuously, while the two currently active entities change
 * from step to step ... Do not show all three entities at equal emphasis for the full sequence."
 *
 * A TAKEOVER HAS THREE PARTIES AND THE CARD CAN ONLY MAKE A CLAIM ABOUT TWO. A pool, a buyer and a displaced
 * president, all lit at once, is a picture of a situation rather than of an event -- the reader has to work
 * out which arrow happened. So the card's focus is CONTINUOUS (it is one transaction) and the emphasised
 * PAIR advances (it is two procedural steps), which is the difference between a diagram and a sentence.
 *
 * THE ORDER IS THE PROCEDURE, AND IT IS THE ONLY THING THIS MODULE DECIDES:
 *   A BUY pays first and is crowned second. The purchase is what causes the takeover, so showing the crown
 *   move before the shares arrive would show an effect ahead of its cause.
 *   A SALE is uncrowned first and delivers second. A president who sells below a rival gives up the
 *   certificate as part of the sale, not after it -- the 20% card is exchanged for two 10% cards, and only
 *   then do the shares the player actually sold reach the Bank Pool.
 *
 * AND NOTHING ELSE IS DECIDED HERE. `stockTransaction.ts` reports the kind from the message the reducer
 * applied and the crown from `president` before and after; this file turns those into a running order. It
 * computes no price, no legality, no successor, no percentage. Change the rule for who wins a tie and this
 * module is unaffected, because it never asks.
 *
 * ONE STAGE LIST RATHER THAN NESTED STEPS. The panel advances an index on a timer and renders whatever the
 * current stage says; a tree of steps and sub-steps would put the sequencing in the component, where it
 * could not be stated in a test. The four stage kinds are the four things a reader can see happen.
 *
 * REDUCED MOTION GETS THE SAME LIST. The stages carry the EMPHASIS as much as the movement, and stepping the
 * active pair through a takeover is information -- "omit or heavily simplify translated movement and animated
 * row swapping" is about the proxies and the row swap, which the panel withholds. The clock is unchanged, so
 * there is no second schedule to keep in step with this one.
 *
 * See docs/ai_architecture/stock_market.md, stockTransferFocus.ts #1451. */

import { PRESIDENT_CERTIFICATE_PERCENT } from "../gameEngine/presidencyTransfer";
import type {
  AppliedSteps,
  PresidencyHandoff,
  ShareHolder,
  StockTransaction,
} from "../utils/stockTransaction";

/* ==================================================================
    DESIGN NOTE 1457: ONE SOUND, ONE MEANING
   ==================================================================
   RULED: "The sound has exactly one meaning: a new president has just been installed. Play it when the new
   crown begins drawing in."
   SO IT LIVES BESIDE `crownArrivesOn`, which is the single fact both the animation and the cue read. Named
   with its owner and by its on-disk filename, which is #1062's rule for every cue in this app -- a missing
   audio file is the quietest failure here, because `playVariantCue` swallows the error by design (#1009) and
   a 404 is indistinguishable from a sound that is simply not very loud.
   NOTHING HERE PLAYS IT. This module names the file and the beat; the shell does the playing, through the
   same helper every other cue goes through, so the mute and the radio ducking stay in one place (#1041). */
export const PRESIDENCY_SFX = "presidency.mp3";

/** An ordinary transfer, start to finish. Inside the 200-400ms the brief asks for, with the release below
 *  taking the total to 350. */
export const TRANSFER_MS = 260;

/** The presidency step, in three overlapping beats. The old crown goes first so the row is visibly vacated;
 *  the certificates cross while it is gone; the handover -- the row reorder and the new crown together --
 *  lands on the arrival. They OVERLAP deliberately: three beats played end to end read as three animations,
 *  which is the thing the brief rules out. */
export const CROWN_OUT_MS = 90;
export const EXCHANGE_AT_MS = 60;
export const EXCHANGE_MS = 180;
export const HANDOVER_AT_MS = 215;
export const HANDOVER_MS = 165;
export const PRESIDENCY_MS = HANDOVER_AT_MS + HANDOVER_MS;

/** How long the card holds its border and its dimming after the last beat, so the sequence ends as one
 *  object settling rather than as the lights going out mid-gesture. */
export const FOCUS_RELEASE_MS = 90;

/* ==================================================================
    DESIGN NOTE 1452: WHERE INSIDE A BEAT THE FIGURES ACTUALLY CHANGE
   ==================================================================
   RULED: "Do not show the destination's final holding before the transfer reaches it" -- so the numbers move
   when the proxy ARRIVES, not when it sets off and not after it has gone.
   200 OF 260, WHICH IS ON THE MERGE. The chip holds full opacity to 70% of its travel (182ms) and contracts
   into its destination over the rest; changing the figures at 200 puts the increment underneath a chip that
   is still there and still shrinking, so the number is revealed by the certificate landing on it rather than
   beside it. Changing them at 260 -- after the chip has gone -- would read as the old bug again in
   miniature: a gesture, then a change.
   THE PRESIDENCY HAS NO SUCH OFFSET. Its beat IS the handover, where the crown is drawn and the rows move,
   so the field flips at that stage's own start. */
export const TRANSFER_RESOLVE_AT_MS = 200;

export type FocusStageKind =
  /** A grouped percentage travelling between two Shares cells. */
  | "transfer"
  /** The outgoing president's crown being taken away. */
  | "crown-out"
  /** The 20% president's certificate crossing with 20% of ordinary shares. */
  | "exchange"
  /** The rows reordering under the new president, and the new crown being drawn. */
  | "handover";

export interface FocusStage {
  kind: FocusStageKind;
  /** The two entities emphasised while this stage is current. Everything else in the table is subdued. */
  from: ShareHolder;
  to: ShareHolder;
  /** Milliseconds from the start of the sequence. */
  at: number;
  /** How long this stage's own motion runs. */
  durationMs: number;
  /** The figure the stage's proxy carries. Zero for `crown-out` and `handover`, which move no percentage. */
  percentage: number;
}

/** A moment at which the card's VISIBLE ownership advances one step toward the committed board.
 *
 *  SEPARATE FROM THE STAGES, because they answer different questions. A stage says what is moving and who is
 *  emphasised; an application says when the figures under it change. They are close together and they are not
 *  the same instant -- the transfer's figures land three-quarters of the way through its stage (#1452).
 *
 *  ==================================================================
 *   DESIGN NOTE 1453: A SET, BECAUSE TWO FIELDS CAN ADVANCE ON ONE BEAT
 *  ==================================================================
 *  A corporation's FIRST president arrives WITH the shares that earned them the certificate (below), so the
 *  holdings and the crown land together. Expressed as two applications at the same `at` that would be two
 *  timer callbacks, hence two React renders, hence one paintable frame in which the shares had moved and the
 *  crown had not -- a flicker of a board that never existed. One application carrying both keys is one
 *  `setApplied` and one render. */
export interface FocusApplication {
  applies: readonly (keyof AppliedSteps)[];
  at: number;
}

export interface FocusSequence {
  companyId: number;
  stages: readonly FocusStage[];
  /** Design note #1452: when the staged card advances toward `after`. */
  applications: readonly FocusApplication[];
  /** When the card drops its focus entirely. By then every application has landed, so the staged board and
   *  the committed board already agree and the handoff back is invisible. */
  totalMs: number;
  /** The two-player exchange, when there is one. `null` for a corporation's first president. */
  presidency: PresidencyHandoff | null;
  /** ==================================================================
   *   DESIGN NOTE 1455: THE ARRIVAL, NAMED SEPARATELY FROM THE EXCHANGE
   *  ==================================================================
   *  RULED, of a corporation's first president: "the crown draws/fades in beside the new president rather
   *  than simply popping into existence ... Conceptually this is the destination end of the normal
   *  presidency-change visual language, without the outgoing-president half."
   *  SO THE DESTINATION END GETS ITS OWN NAME. A handoff and a first presidency are different procedures --
   *  one has a certificate to take from somebody, the other has nothing to take it from -- but the ARRIVAL is
   *  the same gesture in both, and `presidency` could not express it: that field is `null` for a first
   *  president precisely because there is no exchange. Naming the arrival separately is what lets the card
   *  play half of the language without the other half.
   *  `null` WHEN NO CROWN MOVES, and read rather than derived: `after.president` verbatim when the two
   *  snapshots disagree about it. */
  crownArrivesOn: string | null;
}

function presidencyStages(handoff: PresidencyHandoff, base: number): FocusStage[] {
  const pair = { from: handoff.from, to: handoff.to };
  return [
    { kind: "crown-out", ...pair, at: base, durationMs: CROWN_OUT_MS, percentage: 0 },
    {
      kind: "exchange",
      ...pair,
      at: base + EXCHANGE_AT_MS,
      durationMs: EXCHANGE_MS,
      /* THE PRESIDENT'S CERTIFICATE, READ FROM THE MODULE THAT OWNS IT. `presidencyTransfer.ts` exports the
         figure because the swap is its rule; a 20 written here would be a second copy of a number that
         belongs to the engine. */
      percentage: PRESIDENT_CERTIFICATE_PERCENT,
    },
    { kind: "handover", ...pair, at: base + HANDOVER_AT_MS, durationMs: HANDOVER_MS, percentage: 0 },
  ];
}

/** The running order for one completed transaction, or `null` when there is nothing to show. */
export function buildFocusSequence(transaction: StockTransaction | null): FocusSequence | null {
  if (!transaction) return null;
  const { transfer, presidency } = transaction;
  if (!transfer && !presidency) return null;

  const stages: FocusStage[] = [];
  const applications: FocusApplication[] = [];
  /* Design note #1455: does the crown move at all, and where does it land. Two authoritative values
     compared; this asks nothing about who SHOULD preside. */
  const presidentMoved = transaction.before.president !== transaction.after.president;
  const crownArrivesOn = presidentMoved ? transaction.after.president : null;
  const transferStage = (at: number): FocusStage => ({
    kind: "transfer",
    from: transfer!.from,
    to: transfer!.to,
    at,
    durationMs: TRANSFER_MS,
    percentage: transfer!.percentage,
  });

  if (transfer && presidency) {
    /* The one decision in this file. A buy pays then is crowned; a sale is uncrowned then delivers. */
    if (transaction.kind === "buy") {
      stages.push(transferStage(0));
      applications.push({ applies: ["transfer"], at: TRANSFER_RESOLVE_AT_MS });
      stages.push(...presidencyStages(presidency, TRANSFER_MS));
      applications.push({ applies: ["presidency"], at: TRANSFER_MS + HANDOVER_AT_MS });
    } else {
      stages.push(...presidencyStages(presidency, 0));
      applications.push({ applies: ["presidency"], at: HANDOVER_AT_MS });
      stages.push(transferStage(PRESIDENCY_MS));
      applications.push({ applies: ["transfer"], at: PRESIDENCY_MS + TRANSFER_RESOLVE_AT_MS });
    }
  } else if (transfer) {
    /* ==================================================================
        DESIGN NOTE 1453: A CORPORATION'S FIRST PRESIDENT ARRIVES WITH THE CERTIFICATE
       ==================================================================
       REPORTED: "ensure the staged card does not hold `president = null` for the entire transfer and then
       abruptly snap to Alice only when the staged prop is released."
       IT DID, AND THE SNAP WAS THREE THINGS, NOT ONE. `presidencyHandoff` reports `null -> player` as no
       handoff -- correctly, there is no outgoing president to duel -- so no presidency beat was scheduled and
       `applied.presidency` never became true. The staged card therefore held `president: null` while the
       holdings were already `after`'s, and `certificateCardsInPool` reads that field: with no president, the
       President's Certificate is counted as still sitting in the IPO. A par purchase staged as "9 (100%)" in
       the IPO, then "7 (80%)" at the merge, then jumped to "8 (80%)" at release -- with the buyer going
       "2 (20%)" to "1 (20%)" and growing a crown at the same invisible moment.
       SO THE CROWN FOLLOWS THE SHARES WHEN THERE IS NOBODY TO TAKE IT FROM. Same beat, one application: the
       certificate arrives with the twenty per cent that bought it, which is what happens at the table.
       HALF THE LANGUAGE, NOT NONE OF IT (#1455). This sequence has no `crown-out` stage, so nothing fades
       out and no certificates cross -- but the crown still DRAWS IN on the player it lands on, because
       `crownArrivesOn` names that arrival independently of the exchange. An arriving crown that popped would
       be the only ungestured change on a card whose whole point is that nothing changes ungestured.
       READ, NOT DERIVED. This asks whether the two authoritative snapshots disagree about `president`; it
       does not ask who the president should be. */
    stages.push(transferStage(0));
    applications.push({
      applies: presidentMoved ? ["transfer", "presidency"] : ["transfer"],
      at: TRANSFER_RESOLVE_AT_MS,
    });
  } else if (presidency) {
    /* Unreachable through `describeStockTransaction` -- a crown moves because holdings moved -- but a
       sequence that cannot express it would be a branch nothing could ever test. */
    stages.push(...presidencyStages(presidency, 0));
    applications.push({ applies: ["presidency"], at: HANDOVER_AT_MS });
  }

  const last = stages[stages.length - 1];
  return {
    companyId: transaction.companyId,
    stages,
    applications,
    totalMs: last.at + last.durationMs + FOCUS_RELEASE_MS,
    presidency,
    crownArrivesOn,
  };
}

/* ==================================================================
    DESIGN NOTE 1452: `presidentDuringStage` IS GONE, AND SO IS THE SPECIAL CASE IT WAS
   ==================================================================
   #1451 lagged exactly one field -- the roster's president -- so the rows and the crown had two ends to
   bridge while every figure beside them was already final. That was half of the answer, and the half that
   was left out is what the report was about: the numbers still arrived before the gesture that explained
   them.
   THE WHOLE OWNERSHIP LAGS NOW (`stagedOwnership`), and the president is simply one of its fields. So the
   crown needs no rule of its own: it moves when `applied.presidency` flips, exactly as the holdings move
   when `applied.transfer` does, and there is one mechanism rather than one mechanism plus an exception. */

/** Whether `holder` is one of the two entities the current stage is about. */
export function isStageParticipant(stage: FocusStage | null, holder: ShareHolder): boolean {
  if (!stage) return false;
  return holder === stage.from || holder === stage.to;
}

/* ==================================================================
    DESIGN NOTE 1451: THE CARD'S OWN STYLESHEET
   ==================================================================
   INSIDE THE CARD, and every rule here is written so it cannot escape it: the proxies are absolutely
   positioned inside the ownership table, the dimming is an opacity on rows, and the focus is a border colour.
   Nothing is `position: fixed`, nothing is portalled, and there is no translation longer than the distance
   between two rows of one table -- which is the whole point. Slide-out movement across the shell belongs to
   money (`TreasuryMoneyMachine` #1272), and a certificate is not a dollar.
   TWO ANIMATIONS ON TWO NESTED ELEMENTS for the proxy, not one keyframe set: travel wants an ease-out curve
   and the fade wants to hold through the middle and shrink into its destination at the end. One set would
   apply a single timing function to both and put a speed change wherever the opacity has a stop. Both
   properties are compositor-only, so the whole thing runs off the main thread.
   DURATIONS ARE SET INLINE by the panel from the constants above (#970's rule: one number, not three
   literals that happen to agree), so this sheet owns curves and nothing else.
   NOTE FOR EDITORS: this is a TEMPLATE LITERAL, so no backticks anywhere inside it. `animations.ts` records
   two separate occasions on which that terminated the string four lines early. */
export const STOCK_TRANSFER_CSS = `
.app-stock-card {
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.app-stock-row {
  transition: opacity 130ms ease;
}
.app-stock-row-dim {
  /* Subdued, not disabled. Low enough that the two participants read as the subject of the card and high
     enough that the rest of the table is still a table -- the brief's "clear focus, not a
     nearly-disabled-looking card". */
  opacity: 0.45;
}
@keyframes app-stock-proxy-move {
  from { transform: translate(0px, 0px); }
  to   { transform: translate(var(--stock-dx, 0px), var(--stock-dy, 0px)); }
}
@keyframes app-stock-proxy-settle {
  0%   { opacity: 0; transform: scale(0.9); }
  18%  { opacity: 1; transform: scale(1); }
  70%  { opacity: 1; transform: scale(1); }
  /* Contracting into the figure it lands on, rather than fading in place: the merge is what says the
     certificate was absorbed by that row and not merely lost. Small -- this is a resolve, not a zoom. */
  100% { opacity: 0; transform: scale(0.88); }
}
.app-stock-proxy-travel {
  position: absolute;
  pointer-events: none;
  text-align: right;
  animation-name: app-stock-proxy-move;
  animation-timing-function: cubic-bezier(0.22, 0.61, 0.36, 1);
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
  will-change: transform;
}
.app-stock-proxy-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
  transform-origin: right center;
  animation-name: app-stock-proxy-settle;
  animation-timing-function: linear;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
@keyframes app-stock-crown-out {
  from { opacity: 1; transform: scale(1); }
  to   { opacity: 0; transform: scale(0.5); }
}
@keyframes app-stock-crown-in {
  0%   { opacity: 0; transform: scale(0.5); }
  70%  { opacity: 1; transform: scale(1.05); }
  100% { opacity: 1; transform: scale(1); }
}
.app-stock-crown-out {
  animation-name: app-stock-crown-out;
  animation-timing-function: ease-in;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
.app-stock-crown-in {
  animation-name: app-stock-crown-in;
  animation-timing-function: ease-out;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
@media (prefers-reduced-motion: reduce) {
  /* Belt and braces. The panel does not CREATE a proxy or start a row transition under this preference --
     which is the real defence, because the durations above are inline styles and an inline declaration beats
     a stylesheet rule that is not !important (#970b, learnt when the revenue arrows went on flying for a
     year). The crown keeps its fade: an opacity change carrying "this player is no longer president" is
     information, and the accommodation is about motion. */
  .app-stock-proxy-travel, .app-stock-proxy-chip { animation: none !important; opacity: 0 !important; }
}
`;
