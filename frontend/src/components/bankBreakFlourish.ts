// frontend/src/components/bankBreakFlourish.ts
//
// The Bank ticket's silhouette, its three tones, and the one-time BANK BROKEN stamp -- VF-6
// (VISUAL_FLOURISH_BACKLOG.md). Schedule and stylesheet only; `BankTicket.tsx` renders it, `App.tsx`
// raises it. The split VF-1/VF-3/VF-4 all keep.
//
/* ==================================================================
    DESIGN NOTE (VF-6): A TICKET, BECAUSE THE BANK IS NOT A WARNING CAPSULE
   ==================================================================
   The action bar already carries a row of pill-shaped alert capsules -- rust, train limit, the phase
   shift -- and before this batch the Bank countdown was one more of them. It is not the same kind of
   thing: those count down to a LOSS a player can prepare for, and this one counts down to the END OF THE
   GAME. Giving it a period railway-ticket silhouette makes it findable before its label is read, which is
   the whole of the brief's "distinguishable at a glance".

   THE SAME OBJECT BEFORE AND AFTER, which is the other half of the brief and the reason this is a shape
   rather than a post-break decoration. The badge that was counting dollars is the badge that counts
   rounds; chamfered corners and one dashed stub rule in both states, so the break reads as the ticket
   being STAMPED rather than as one badge being replaced by another.

   RESTRAINT IS A CONSTRAINT, NOT A STYLE PREFERENCE. At `FONT_SIZE.micro` in a crowded bar there is room
   for exactly two ticket cues: the corner chamfers (a silhouette, legible at any size) and a single
   dashed perforation rule (one hairline). A punch hole, a scalloped edge or a paper texture at this scale
   is noise that reads as a rendering fault. */

import { PRIVATE_POWER_GLOW_STOPS } from "../utils/privatePowerGlow";
import type { BankTicketTone } from "../utils/bankBreak";

/** What the shell stages when the Bank breaks: the ticket's pre-break text, plus a token so a second
 *  genuine break (an Undo back past it, then the same payout again) replays rather than sitting finished
 *  -- #1060's token idiom, kept by every flourish event since. */
export interface BankBreakFlipEvent {
  /** The critical countdown the ticket was showing a moment ago, or `null` when the Bank went from
   *  comfortable to broken in one payout and there was no ticket on screen to stage. */
  fromLabel: string | null;
  token: number;
}

/* ==================================================================
    FULL-MOTION TIMELINE -- A STAMP, NOT AN EXPLOSION
   ==================================================================
   Brief: "~800-1200 ms", and the concept is "critical railroad ticket -> forceful period accounting /
   railway-office stamp impact -> BANK BROKEN -> ticket resolves into rainbow post-break state". Longer
   than VF-4's phase flip (520ms) and deliberately so: a phase changes five times a game and the Bank
   breaks once. Shorter than VF-3's float ceremony, because this one happens in a status bar rather than
   on a card the player is already looking at. */

/** The ticket draws in a little, the way a card does under a descending press. No shake, no travel. */
export const BANK_BREAK_CHARGE_MS = 200;
/** The stamp lands. THE ONE BEAT A PLAYER WILL REMEMBER, so everything else is timed off it. */
export const BANK_BREAK_STAMP_AT_MS = BANK_BREAK_CHARGE_MS;
/** Its own impact, then how long BANK BROKEN holds legibly before the ticket resolves. */
export const BANK_BREAK_STAMP_IMPACT_MS = 110;
export const BANK_BREAK_STAMP_HOLD_MS = 230;
export const BANK_BREAK_STAMP_MS = BANK_BREAK_STAMP_IMPACT_MS + BANK_BREAK_STAMP_HOLD_MS;
/** ==================================================================
 *   THE COMMIT, AND WHY IT IS HERE RATHER THAN AT THE START
 *  ==================================================================
 *  Brief section 9: "avoid -- authoritative rainbow badge appears, then animation pretends it was still
 *  red, then rainbow again." So the ticket is STAGED CRITICAL from the first frame (A-2: the animation
 *  causes the final state), takes the stamp while still critical, and turns rainbow exactly once, here,
 *  as the stamp lifts. One transition, in the direction the event actually went. */
export const BANK_BREAK_RESOLVE_AT_MS = BANK_BREAK_STAMP_AT_MS + BANK_BREAK_STAMP_MS;
export const BANK_BREAK_RESOLVE_MS = 320;
/** Visible motion, 0 to the ticket at rest: 860ms. */
export const BANK_BREAK_VISIBLE_MS = BANK_BREAK_RESOLVE_AT_MS + BANK_BREAK_RESOLVE_MS;
/** VF-4's settle stage, for VF-4's reason: the last frame carries NO class and NO animation, so the
 *  resting ticket is the ordinary persistent ticket rather than an animation holding its final keyframe.
 *  Brief section 12 asks for this in as many words -- "do not animate indefinitely after the break". */
export const BANK_BREAK_SETTLE_AT_MS = BANK_BREAK_VISIBLE_MS;
export const BANK_BREAK_SETTLE_MS = 80;
export const BANK_BREAK_TOTAL_MS = BANK_BREAK_SETTLE_AT_MS + BANK_BREAK_SETTLE_MS;

/* ==================================================================
    REDUCED-MOTION TIMELINE
   ==================================================================
   Brief: "preserve the STATE CHANGE without the physical slam ... no shake / large stamp travel." Same
   four stages in the same order, so one set of staging code and one set of tests describe both; the stamp
   arrives by OPACITY alone, with no scale and no travel, and the whole sequence is well under half the
   full-motion length. */
export const BANK_BREAK_REDUCED_CHARGE_MS = 90;
export const BANK_BREAK_REDUCED_STAMP_AT_MS = BANK_BREAK_REDUCED_CHARGE_MS;
export const BANK_BREAK_REDUCED_STAMP_MS = 180;
export const BANK_BREAK_REDUCED_RESOLVE_AT_MS =
  BANK_BREAK_REDUCED_STAMP_AT_MS + BANK_BREAK_REDUCED_STAMP_MS;
export const BANK_BREAK_REDUCED_RESOLVE_MS = 140;
export const BANK_BREAK_REDUCED_SETTLE_AT_MS =
  BANK_BREAK_REDUCED_RESOLVE_AT_MS + BANK_BREAK_REDUCED_RESOLVE_MS;
export const BANK_BREAK_REDUCED_SETTLE_MS = 60;
export const BANK_BREAK_REDUCED_TOTAL_MS =
  BANK_BREAK_REDUCED_SETTLE_AT_MS + BANK_BREAK_REDUCED_SETTLE_MS;

/* ==================================================================
    NAMED MILESTONES, RESOLVED AGAINST THE ACTIVE SCHEDULE
   ==================================================================
   VF-4's correction, applied from the start here rather than after the fact: anything that has to happen
   "once the stamp has landed" or "once the ticket has settled" names the BEAT, and the timeline actually
   being played supplies the number. A full-motion constant used under reduced motion is dead air charged
   to the reader who asked for less presentation. `bankBreakTimeline` is the single source for both these
   milestones and the sequence's own `commitAt`/`totalMs`, so the two cannot drift. */
export interface BankBreakTimeline {
  /** The stamp's impact -- the beat the event is ABOUT. */
  stampedAt: number;
  /** The one instant the staged critical ticket becomes the authoritative rainbow one. */
  commitAt: number;
  /** The whole sequence; after it the ticket is the ordinary persistent ticket. */
  totalMs: number;
}

export function bankBreakTimeline(reducedMotion: boolean): BankBreakTimeline {
  return reducedMotion
    ? {
        stampedAt: BANK_BREAK_REDUCED_STAMP_AT_MS,
        commitAt: BANK_BREAK_REDUCED_RESOLVE_AT_MS,
        totalMs: BANK_BREAK_REDUCED_TOTAL_MS,
      }
    : {
        stampedAt: BANK_BREAK_STAMP_AT_MS,
        commitAt: BANK_BREAK_RESOLVE_AT_MS,
        totalMs: BANK_BREAK_TOTAL_MS,
      };
}

export type BankBreakMilestone = "stamped" | "committed" | "settled";

/** How long a surface waiting for `milestone` waits, under the timeline currently being played. */
export function bankBreakMilestoneMs(
  milestone: BankBreakMilestone,
  reducedMotion: boolean,
): number {
  const timeline = bankBreakTimeline(reducedMotion);
  if (milestone === "stamped") return timeline.stampedAt;
  if (milestone === "committed") return timeline.commitAt;
  return timeline.totalMs;
}

/* ==================================================================
    AUDIO: OPEN, AND SILENT UNTIL IT IS ANSWERED
   ==================================================================
   Brief: a railway/ticket-office stamp, a heavy rubber stamp, a short mechanical counter or office-register
   impact, a decisive thunk -- and explicitly NOT a cinematic boom, an explosion, a metallic screech, a long
   reverberant clang or a cash-register ding.
   THE TREE WAS AUDITED CLIP BY CLIP AND HAS NONE OF THOSE. Every percussive asset it holds is one of the
   things the brief rules out (`explosion.mp3`, `crash.mp3`, `rockslide.mp3`, `thunder.mp3`,
   `spooky_gong.mp3`, `church-bells.mp3`, `cha-ching.mp3`, `coins-clinking.mp3`, `sad-trombone.mp3`), and
   the three mechanical clips that are not (`telegraph.mp3`, `watch-wind.mp3`, `camera-shutter.mp3`) are
   each already OWNED by `variantSfx.ts`'s flavour-text matcher (`/telegraph/i`, `/pocket watch/i`,
   `/photograph/i`), where they mean "the line the ticker just printed mentions this thing". `floated.mp3`
   and `presidency.mp3` are one-off ceremonial stingers for other events, and `mutation.mp3`/`track.mp3`
   belong to the tile flourish.
   SO THE BREAK SHIPPED SILENT. Forcing `explosion.mp3` onto the one moment the brief says must not sound
   like an explosion would be the wrong answer written confidently. The asset this wants was recorded in
   VISUAL_FLOURISH_BACKLOG.md, with its cue point: a single dry rubber-stamp thunk of roughly 250-400ms,
   no tail, played so its own principal impact lands on `stampedAt` (the offset measurement VF-3 records
   for `floated.mp3` is the method).

   ==================================================================
    ANSWERED BY THE AUDIO WIRING PASS: `bank-broken.mp3`
   ==================================================================
   Supplied rather than found in the tree, which is what the audit above said it would take. A heavy,
   solid, dry impact of 1.36s with no tail to speak of -- the thunk the brief asked for, and none of the
   things it ruled out. The cue rides `playVariantCue` like every other one-off stinger, so the master
   SFX mute, the shared volume, the concurrency cap and the radio ducking all apply without this file
   knowing about any of them (#1041/#1457's split: the flourish owns WHEN, the shell owns WHETHER). */

/** The clip, in `public/audio/`. Named for the event rather than its provider, like every other cue. */
export const BANK_BREAK_SFX = "bank-broken.mp3";

/* ==================================================================
    AUDIO CUE ALIGNMENT: THE CLIP'S OWN PRINCIPAL IMPACT, NOT ITS FIRST SAMPLE
   ==================================================================
   VF-3's method, applied to this file: ffmpeg decode to raw mono PCM, then a whole-clip peak-sample
   search and a 10ms-window RMS envelope. `bank-broken.mp3` is already trimmed to its transient -- the
   loudest sample lands at 11.9ms and the loudest 10ms RMS window at 17ms, both inside an attack that
   starts at sample zero and is decaying by 35ms.
   SO THE OFFSET IS SMALL, AND IT IS STILL WRITTEN DOWN. Twelve milliseconds is under a frame and nobody
   would hear it; the constant exists so that the NEXT person to swap this asset changes one number
   rather than rediscovering that the alignment was never anything but luck. `floated.mp3`'s offset is
   458ms on the identical measurement, which is what a file with a lead-in costs. */
export const BANK_BREAK_AUDIO_IMPACT_OFFSET_MS = 12;

/** When to start the clip so its thunk lands on the stamp. Against the ACTIVE schedule, both of them:
 *  the reduced timeline stamps at 90ms rather than 200ms, and a full-motion constant used there would
 *  put the thunk 110ms after the ink. `Math.max(0, ...)` is a standing guard rather than a live clamp --
 *  both milestones are comfortably later than 12ms today. */
export function bankBreakCueAtMs(reducedMotion: boolean): number {
  const stampedAt = reducedMotion ? BANK_BREAK_REDUCED_STAMP_AT_MS : BANK_BREAK_STAMP_AT_MS;
  return Math.max(0, stampedAt - BANK_BREAK_AUDIO_IMPACT_OFFSET_MS);
}

export type BankBreakStageKind = "charge" | "stamp" | "resolve" | "settle";

export interface BankBreakStage {
  kind: BankBreakStageKind;
  at: number;
  durationMs: number;
}

export interface BankBreakApplication {
  /** A set, for parity with VF-1/VF-3/VF-4, though exactly one field lands. */
  applies: readonly ["broken"];
  at: number;
}

export interface BankBreakSequence {
  /** The staged pre-break text, or `null` when there was no ticket on screen to stage. */
  fromLabel: string | null;
  reducedMotion: boolean;
  stages: readonly BankBreakStage[];
  applications: readonly BankBreakApplication[];
  stampedAt: number;
  commitAt: number;
  totalMs: number;
}

/** The running order for one Bank break, or `null` when there is no event. Pure: no measurement, no
 *  timers, no rules re-derivation -- it is handed a completed fact and turns it into a schedule. */
export function buildBankBreakSequence(
  event: { fromLabel: string | null } | null,
  reducedMotion: boolean,
): BankBreakSequence | null {
  if (!event) return null;
  const timeline = bankBreakTimeline(reducedMotion);
  const stages: readonly BankBreakStage[] = reducedMotion
    ? [
        { kind: "charge", at: 0, durationMs: BANK_BREAK_REDUCED_CHARGE_MS },
        { kind: "stamp", at: timeline.stampedAt, durationMs: BANK_BREAK_REDUCED_STAMP_MS },
        { kind: "resolve", at: timeline.commitAt, durationMs: BANK_BREAK_REDUCED_RESOLVE_MS },
        {
          kind: "settle",
          at: BANK_BREAK_REDUCED_SETTLE_AT_MS,
          durationMs: BANK_BREAK_REDUCED_SETTLE_MS,
        },
      ]
    : [
        { kind: "charge", at: 0, durationMs: BANK_BREAK_CHARGE_MS },
        { kind: "stamp", at: timeline.stampedAt, durationMs: BANK_BREAK_STAMP_MS },
        { kind: "resolve", at: timeline.commitAt, durationMs: BANK_BREAK_RESOLVE_MS },
        { kind: "settle", at: BANK_BREAK_SETTLE_AT_MS, durationMs: BANK_BREAK_SETTLE_MS },
      ];
  return {
    fromLabel: event.fromLabel,
    reducedMotion,
    stages,
    applications: [{ applies: ["broken"], at: timeline.commitAt }],
    ...timeline,
  };
}

/** The stage active at `elapsedMs`, or `null` outside the sequence. VF-3's `floatStageAt`. */
export function bankBreakStageAt(
  sequence: BankBreakSequence,
  elapsedMs: number,
): BankBreakStage | null {
  let current: BankBreakStage | null = null;
  for (const stage of sequence.stages) {
    if (stage.at <= elapsedMs) current = stage;
  }
  return current;
}

/* ==================================================================
    THE TICKET'S OWN STYLESHEET
   ==================================================================
   #46/#18's escape hatch, on VF-1/VF-3/VF-4's rule: `clip-path`, a `::before` perforation, keyframes and
   a two-layer `background-clip` border are four things an inline style object cannot express. Durations
   are written inline by `BankTicket.tsx` from the constants above -- one set of numbers, not two.

   ==================================================================
    THE RAINBOW IS THE APPLICATION'S OWN, NOT A NEW ONE
   ==================================================================
   `PRIVATE_POWER_GLOW_STOPS` is the shared list #727 created for exactly this reason -- "two hard-coded
   palettes drifting apart is how the association quietly stops being one" -- and it is the palette a
   player has already met twice: ringing a contested mini-auction card (#320/#344) and haloing a hex a
   private power can act on. Both of those mean SOMETHING SPECIAL IS HAPPENING HERE, which is precisely
   what a broken Bank is and precisely what crimson would get wrong.

   THE TECHNIQUE IS THE MINI-AUCTION CARD'S, TOO, and for its stated reason: two background layers, an
   opaque fill clipped to the PADDING box and the gradient clipped to the BORDER box, so the only gradient
   visible is the ring. That keeps the ticket's INTERIOR dark and its text at full contrast -- brief
   section 12's requirement -- where a rainbow fill would leave white text crossing yellow.

   AND IT IS THE STATIC RING, DELIBERATELY. #320 animates a chase and defines its own reduced-motion form
   as "the multicolour ring stays, static"; brief section 12 says "do not animate indefinitely after the
   break". Those agree, so the resting ticket takes the treatment's existing still form rather than a new
   one invented for this surface. The event has already been announced by the stamp; a ring chasing for
   the rest of the game would be announcing it for ever. */
const RAINBOW_RING = PRIVATE_POWER_GLOW_STOPS.join(", ");

/** The chamfer, in pixels. One number, used by the clip path and quoted by the tests. */
export const BANK_TICKET_CHAMFER_PX = 5;

export const BANK_TICKET_CSS = `
.app-bank-ticket {
  position: relative;
  border-radius: 0;
  padding-left: 17px;
  clip-path: polygon(
    ${BANK_TICKET_CHAMFER_PX}px 0%,
    calc(100% - ${BANK_TICKET_CHAMFER_PX}px) 0%,
    100% ${BANK_TICKET_CHAMFER_PX}px,
    100% calc(100% - ${BANK_TICKET_CHAMFER_PX}px),
    calc(100% - ${BANK_TICKET_CHAMFER_PX}px) 100%,
    ${BANK_TICKET_CHAMFER_PX}px 100%,
    0% calc(100% - ${BANK_TICKET_CHAMFER_PX}px),
    0% ${BANK_TICKET_CHAMFER_PX}px
  );
}
/* NOTE FOR EDITORS: everything from here to the closing backtick is inside a TEMPLATE LITERAL, so no
   backticks -- #755 and #1004 both record terminating this kind of string four lines early by quoting an
   identifier, and this file did it a third time on its first draft (tsc caught it).
   The stub rule -- one dashed hairline in the ticket's own ink, which is the whole of the perforation.
   Inset top and bottom so it reads as a tear line rather than as a divider running edge to edge. */
.app-bank-ticket::before {
  content: "";
  position: absolute;
  left: 9px;
  top: 3px;
  bottom: 3px;
  border-left: 1px dashed currentColor;
  opacity: 0.5;
  pointer-events: none;
}
/* The resting POST-BREAK ticket: the mini-auction ring, still. No animation, by design. */
.app-bank-ticket-broken {
  border-color: transparent;
  background:
    linear-gradient(#1b1b1f, #1b1b1f) padding-box,
    linear-gradient(90deg, ${RAINBOW_RING}) border-box;
  background-size: 100% 100%, 200% 100%;
  background-repeat: no-repeat, repeat;
  color: #f4f2ec;
}
/* The stamp itself -- the word, pressed onto the ticket. Absolute, so it never reflows the bar. */
.app-bank-ticket-stamp {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  letter-spacing: 0.08em;
  /* OPAQUE, taking the ticket's own fill: the stamp COVERS the dollar countdown rather than printing
     across it. Two overlapping strings at micro size is not a stamp, it is a rendering fault -- and the
     covering is what makes the gesture read as something landing on the card. 'inherit' rather than a
     literal, so the plate is whatever colour the ticket is underneath it. */
  background-color: inherit;
  opacity: 0;
  animation-name: app-bank-stamp-impact;
  animation-timing-function: cubic-bezier(0.2, 0.9, 0.3, 1);
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
@keyframes app-bank-stamp-impact {
  0%   { opacity: 0; transform: scale(1.9); }
  42%  { opacity: 1; transform: scale(0.95); }
  62%  { opacity: 1; transform: scale(1.02); }
  100% { opacity: 1; transform: scale(1); }
}
/* The press: the ticket draws in slightly under the descending stamp and returns. Scale only, about its
   own centre -- no translation, so it never moves in the bar and never nudges a neighbour. */
@keyframes app-bank-ticket-charge {
  0%   { transform: scale(1); }
  100% { transform: scale(0.965); }
}
@keyframes app-bank-ticket-press {
  0%   { transform: scale(0.965); }
  30%  { transform: scale(1.035); }
  100% { transform: scale(1); }
}
.app-bank-ticket-charging {
  animation-name: app-bank-ticket-charge;
  animation-timing-function: ease-in;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
.app-bank-ticket-pressed {
  animation-name: app-bank-ticket-press;
  animation-timing-function: cubic-bezier(0.2, 0.9, 0.3, 1);
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
/* The resolve: the rainbow ring arrives by fading the old fill out from under it. No spin, no wipe. */
@keyframes app-bank-ticket-resolve {
  from { filter: saturate(0.2); opacity: 0.75; }
  to   { filter: saturate(1); opacity: 1; }
}
.app-bank-ticket-resolving {
  animation-name: app-bank-ticket-resolve;
  animation-timing-function: ease-out;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
@media (prefers-reduced-motion: reduce) {
  /* Belt and braces, as STOCK_TRANSFER_CSS puts it: BankTicket.tsx reads the preference itself and never
     attaches the press classes under it. This exists so a class left on by a stale render cannot move
     anything -- the one thing reduced motion is entitled to be certain about. The STAMP keeps its
     opacity and loses its travel, because a cue that disappears under reduced motion is an information
     problem (#26). */
  .app-bank-ticket-charging,
  .app-bank-ticket-pressed,
  .app-bank-ticket-resolving {
    animation: none !important;
    transform: none !important;
  }
  .app-bank-ticket-stamp {
    animation-name: app-bank-stamp-fade;
    transform: none !important;
  }
}
@keyframes app-bank-stamp-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}
`;

/** The class carrying this stage's motion, or `undefined` for a ticket at rest. `settle` is deliberately
 *  `undefined`: see `BANK_BREAK_SETTLE_AT_MS` for why the last frame must carry nothing. */
export function bankTicketStageClass(
  stage: BankBreakStageKind | null,
  reducedMotion: boolean,
): string | undefined {
  if (reducedMotion) return undefined;
  if (stage === "charge") return "app-bank-ticket-charging";
  if (stage === "stamp") return "app-bank-ticket-pressed";
  if (stage === "resolve") return "app-bank-ticket-resolving";
  return undefined;
}

/** The tone class for a resting ticket. Only the broken state has one; warn and critical keep the shared
 *  alert style objects (#7's one escalation decision) and add nothing of their own. */
export function bankTicketToneClass(tone: BankTicketTone): string | undefined {
  return tone === "broken" ? "app-bank-ticket-broken" : undefined;
}
