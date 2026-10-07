// frontend/src/utils/gameClockView.ts
//
// ==================================================================
//  PHASE 3 FINAL CLOCKS: WHAT THE TABLE SAYS ABOUT ITS CLOCK
// ==================================================================
//
// PURE: the server's clock view (`clockProtocol.ts`, `RoomView.clock` v2) in, one presentation out. No socket, no
// storage, no wall clock -- the caller supplies how long ago (MONOTONIC) it received the view, and whether this tab is
// CURRENT. The server is the clock: its numbers are as of `serverNow`, and a running timer counts on here only by the
// monotonic time since the view arrived. A tab that is not current shows no figure at all.
//
// THE OWNER'S PRESENTATION (2026-10-06):
//   Live          ONE ordinary action clock ("20:00"), never a reserve plus a countdown.
//   Train offer   the proposer's clock visibly PAUSED and "Train offer — 10:00 to respond" (the recipient is not overdue).
//   Overdue       "OVERDUE" and the time left to the 30:00 finality; the cure requirement; the foreclosure proposal and
//                 its votes; the automatic neutral annulment when no foreclosure consensus exists. Never three
//                 countdowns at once.
//   Strikes       "1 of 2 overdue cures used"; after the second, the prominent warning "Next action-clock expiry results
//                 in automatic foreclosure."; the third: the game ended by foreclosure (the money result challengeable).
//   Pause         a voluntary pause is not an overdue; a SYSTEM pause says "Game paused because server continuity was
//                 interrupted." / "All players must agree to resume." and shows the preserved timer before anyone votes.
//   Async         the pace and who is to act; when expired, "OVERDUE" with no fake automatic-annul countdown.
//   No-deadline   "No deadline", never a countdown.
//
// Eligibility for any remedy is the server's and the chain's -- never this countdown's.

import {
  CLOCK_LIVE_DECLINES_PER_ROUND_INSTANCE,
  declinesReachedSentence,
  STRIKE_TWO_WARNING,
  SYSTEM_PAUSE_RESUME_SENTENCE,
  SYSTEM_PAUSE_SENTENCE,
  type ClockEndKind,
  type ClockTableState,
  type RoomClockView,
} from "./clockProtocol";
import type { RequiredDecisionKind } from "../gameEngine/clockResponsibility";

export type ClockTone = "normal" | "warning" | "overdue" | "paused" | "muted" | "ended";

/** The controls a seat may use now (the server still decides every one). */
export interface ClockControls {
  /** Ask for a unanimous pause (Live, running or overdue, no request standing). */
  readonly requestPause: boolean;
  /** Ask for a unanimous resume (Live, paused, no request standing). */
  readonly requestResume: boolean;
  /** Answer the standing pause / resume request (this seat has not said yes). */
  readonly answerRequest: { readonly kind: "pause" | "resume"; readonly id: number; readonly by: string } | null;
  /** Vote to leave a system pause (this seat has not yet). */
  readonly systemResume: boolean;
  /** Propose an N-1 remedy against the overdue seat (`foreclose`, and on an Async table `annul`). */
  readonly propose: readonly ("foreclose" | "annul")[];
  /** Vote on the standing proposal (this seat is one of the N-1). */
  readonly vote: { readonly id: number; readonly kind: "foreclose" | "annul"; readonly mine: "yes" | "no" | null } | null;
  /** A free table's unanimous annulment (a money table annuls through its escrow: the money panel). */
  readonly annul: { readonly mine: boolean; readonly count: number; readonly needed: number } | null;
}

export interface ClockPresentation {
  readonly visible: boolean;
  readonly state: ClockTableState | "not-current";
  /** "Live", "Async · 24 h", "No deadline". */
  readonly modeLabel: string;
  /** What the chip says first ("Your action", "Bob to act", "OVERDUE", "Paused", ...). */
  readonly label: string;
  /** The one figure shown ("12:34", "8:05 to finality", "18h 02m"), or `null` (none may be shown). */
  readonly value: string | null;
  /** The lines of detail, most important first (the panel lists them; the chip's tooltip joins them). */
  readonly lines: readonly string[];
  /** A prominent warning for THIS seat, or `null` (the second strike's). */
  readonly warning: string | null;
  /** What the chip shows INLINE, always (never only behind the toggle): the second-strike warning, the system-pause
   *  sentences, the proposer's paused clock during a train offer. */
  readonly banner: string | null;
  readonly tone: ClockTone;
  readonly ticking: boolean;
  readonly controls: ClockControls;
}

export const NO_CONTROLS: ClockControls = Object.freeze({ requestPause: false, requestResume: false, answerRequest: null, systemResume: false, propose: Object.freeze([]), vote: null, annul: null });

/** Shown when a sealed outcome's player approvals can no longer reach Juno (a horizon passed, or a key changed): the
 *  outcome stays exactly as recorded and waits for the operator -- it is never changed and never voted on again. */
export const REMEDY_UNLANDABLE_DETAIL = "This outcome is recorded but can't be sent to Juno as signed (an approval expired or a player's key changed). It stays exactly as recorded and waits for the operator's decision.";

export const CLOCK_NOT_CURRENT_DETAIL = "This tab is catching up with the room, so its clock is not shown as current.";
export const CLOCK_PAUSED_DETAIL = "Paused by every player. Nothing is timed until every player agrees to resume.";
export const CLOCK_NO_DEADLINE_DETAIL = "This table has no action deadline. It ends when the game is finished or every player agrees to annul it.";
export const TRADE_NOT_OVERDUE_DETAIL = "Answering an offer is not an overdue: if the time runs out, the offer simply expires.";
export const ASYNC_OVERDUE_DETAIL = "Nothing happens automatically. The other players may all agree to annul the game or to foreclose.";
export const LIVE_NEUTRAL_OUTCOME = "If it is not cured by then: the game is annulled neutrally (everyone's own stake back).";
export const LIVE_FORECLOSE_OUTCOME = "If it is not cured by then: foreclosure (every other player agreed).";
export const STRIKE_ONE_NOTE = "1 of 2 overdue cures used";
/** What each deadline means, said where the host chooses it and with the table's terms. */
export const LIVE_DEADLINE_NOTE =
  "Live: 20:00 for each required action. An offer that pauses its maker's clock (a train offer, for one) gives its recipient 10:00 to answer. A player who runs out is overdue and has until 30:00 to make the move.";
export const ASYNC_DEADLINE_NOTE =
  "The time each player has for each required action, fixed once play begins. A player who runs out is overdue; nothing happens automatically, and the other players may agree to annul or foreclose.";
export const NO_DEADLINE_NOTE = "No action deadline: the game ends when it is finished or when every player agrees to annul it.";

const HIDDEN: ClockPresentation = Object.freeze({
  visible: false,
  state: "setup",
  modeLabel: "",
  label: "",
  value: null,
  lines: Object.freeze([]),
  warning: null,
  banner: null,
  tone: "muted",
  ticking: false,
  controls: NO_CONTROLS,
});

/** A duration: `m:ss` under an hour, `Hh MMm` under a day, `Dd Hh` beyond. Whole seconds, rounded DOWN. Integers only. */
export function formatClockDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The host's pace menu, in the owner's words. */
export function paceLabel(paceSecs: number | null): string {
  switch (paceSecs) {
    case 43_200:
      return "12 hours";
    case 86_400:
      return "24 hours";
    case 172_800:
      return "2 days";
    case 259_200:
      return "3 days";
    case 604_800:
      return "7 days";
    default:
      return "—";
  }
}

export function deadlineLabel(clock: Pick<RoomClockView, "deadline" | "paceSecs">): string {
  if (clock.deadline === "live") return "Live · 20:00 per action";
  if (clock.deadline === "no-deadline") return "No deadline";
  return `Async · ${paceLabel(clock.paceSecs)} per action`;
}

/** What the responsible seat owes, in words (the cure requirement). */
export function owedSentence(kind: RequiredDecisionKind | null | undefined, own = false): string {
  const whose = own ? "your" : "their";
  switch (kind) {
    case "auction-bid":
      return `${whose} bid or pass in the auction`;
    case "bo-par":
      return "the B&O par price";
    case "discard":
      return "the train discard";
    case "offer-answer":
      return `${whose} answer to the standing offer`;
    default:
      return `${whose} move`;
  }
}

/** A single NO on an N-1 proposal cancels it for everyone (the owner's veto). */
export const VETO_DETAIL_LIVE = "One NO cancels this proposal for everyone; the 30:00 outcome is then the neutral annulment unless the player cures.";
export const VETO_DETAIL_ASYNC = "One NO cancels this proposal for everyone.";

export function endedSentence(kind: ClockEndKind | undefined, money: boolean): string {
  switch (kind) {
    case "live-strike3-foreclosure":
      return money ? "Game ended: foreclosure after a third action-clock expiry. The money result can be challenged on Juno; play does not resume." : "Game ended: foreclosure after a third action-clock expiry.";
    case "live-foreclosure":
      return "Game ended: foreclosure — the overdue player did not cure by 30:00 and every other player agreed.";
    case "live-timeout-annul":
      return "Game ended: neutral timeout annulment — the overdue player did not cure by 30:00.";
    case "async-annul":
      return "Game ended: neutral annulment — every other player agreed while a player was overdue.";
    case "async-foreclosure":
      return "Game ended: foreclosure — every other player agreed while a player was overdue.";
    case "annulled":
      return "Game ended: annulled by every player.";
    case "escrow-ended":
      return "Game ended: this table's escrow has closed.";
    case "room-closed":
      return "The room was closed.";
    default:
      return "The game is over.";
  }
}

export interface ClockPresentationInput {
  readonly clock: RoomClockView | null | undefined;
  /** Monotonic ms since this view arrived (0 at receipt). */
  readonly sinceReceiptMs: number;
  /** This tab may present the room's clock: its room link is open, its board is current, it is not catching up. */
  readonly current: boolean;
  /** This viewer's seat (`null`: a watcher). */
  readonly viewerPlayerId: string | null;
  readonly nameOf: (playerId: string) => string;
}

export function presentClock(input: ClockPresentationInput): ClockPresentation {
  const clock = input.clock;
  if (clock === null || clock === undefined || clock.v !== 2) return HIDDEN;
  const me = input.viewerPlayerId;
  const seated = me !== null && clock.seats.includes(me);
  const name = (seat: string) => (seat === me ? "You" : input.nameOf(seat));
  const modeLabel = clock.deadline === "live" ? "Live" : clock.deadline === "no-deadline" ? "No deadline" : `Async · ${paceLabel(clock.paceSecs)}`;
  const elapsed = Math.max(0, input.sinceReceiptMs);
  const left = (timer: { remainingMs: number; running: boolean } | null) => (timer === null ? null : Math.max(0, timer.remainingMs - (timer.running ? elapsed : 0)));
  const base = { visible: true, modeLabel, warning: null as string | null, banner: null as string | null, controls: NO_CONTROLS };

  if (clock.state === "setup") {
    return { ...base, state: "setup", label: deadlineLabel(clock), value: null, lines: clock.deadline === "no-deadline" ? [CLOCK_NO_DEADLINE_DETAIL] : [], tone: "muted", ticking: false };
  }
  if (clock.state === "ended") {
    const kind = clock.ended?.kind;
    const lines = [endedSentence(kind, clock.money)];
    const unlandable = clock.money && clock.remedy !== null && clock.remedy.status === "refused" && Array.isArray(clock.remedy.stale) && clock.remedy.stale.length > 0;
    /* An ended game has nothing to resume: no system pause and no vote is shown for it (the owner's ruling) -- its sealed
       money outcome is carried on by the server as it stands. */
    if (clock.remedy !== null && clock.money) lines.push(unlandable ? REMEDY_UNLANDABLE_DETAIL : remedyStatusSentence(clock.remedy.status));
    return { ...base, controls: NO_CONTROLS, state: "ended", label: kind === "live-strike3-foreclosure" || kind === "live-foreclosure" || kind === "async-foreclosure" ? "Foreclosed" : kind === "game-end" ? "Game over" : "Ended", value: null, lines, tone: "ended", ticking: false };
  }
  /* NOT CURRENT: no figure at all -- a stale tab never shows a countdown as the room's. */
  if (!input.current) {
    return { ...base, state: "not-current", label: "Clock catching up", value: null, lines: [CLOCK_NOT_CURRENT_DETAIL], tone: "muted", ticking: false };
  }

  const strikes = me !== null ? (clock.strikes[me] ?? 0) : 0;
  const warning = clock.deadline === "live" && seated && strikes >= 2 ? STRIKE_TWO_WARNING : null;
  /* "1 of 2 overdue cures used" is said once the first overdue is behind the seat -- not during it. */
  const strikeLine = clock.deadline === "live" && seated && strikes === 1 && clock.overdue?.seat !== me ? STRIKE_ONE_NOTE : null;
  const controls = controlsOf(clock, me, seated);
  const responsible = clock.responsible;
  const actorLabel = responsible === null ? "Nobody to act" : responsible.seat === me ? "Your action" : `${input.nameOf(responsible.seat)} to act`;

  if (clock.state === "system-paused" && clock.system !== null) {
    const preserved = preservedLine(clock, name);
    const votes = `${clock.system.yes.length} of ${clock.system.needed.length} agreed to resume.`;
    return { ...base, warning, banner: `${SYSTEM_PAUSE_SENTENCE} ${SYSTEM_PAUSE_RESUME_SENTENCE}`, controls, state: "system-paused", label: "Paused (server)", value: null, lines: [SYSTEM_PAUSE_SENTENCE, SYSTEM_PAUSE_RESUME_SENTENCE, ...(preserved !== null ? [preserved] : []), votes], tone: "paused", ticking: false };
  }
  if (clock.state === "paused") {
    const preserved = preservedLine(clock, name);
    const request = clock.pause.request;
    const lines = [CLOCK_PAUSED_DETAIL, ...(preserved !== null ? [preserved] : [])];
    if (request !== null) lines.push(`${name(request.by)} asked to resume — ${request.yes.length} of ${request.needed.length} agree.`);
    return { ...base, warning, banner: warning, controls, state: "paused", label: "Paused", value: null, lines, tone: "paused", ticking: false };
  }

  const requestLine = clock.pause.request !== null ? `${name(clock.pause.request.by)} asked to pause — ${clock.pause.request.yes.length} of ${clock.pause.request.needed.length} agree. The clock runs until everyone agrees.` : null;
  const annulLine = clock.annul !== null ? `Annul game: ${clock.annul.yes.length} of ${clock.annul.needed.length} players agree.` : null;
  const extra = [requestLine, annulLine, strikeLine].filter((line): line is string => line !== null);

  if (clock.state === "overdue" && clock.overdue !== null) {
    const od = clock.overdue;
    const who = od.seat === me ? "You are" : `${input.nameOf(od.seat)} is`;
    const cure = `${who} overdue. To continue the game, ${od.seat === me ? "make" : `${input.nameOf(od.seat)} must make`} ${owedSentence(od.cure, od.seat === me)}.`;
    const proposal = od.proposal;
    /* A complete Live foreclosure decides 30:00 only while the server says it still would (its approvals outlive the
       finality as it now stands); otherwise the line says the neutral outcome stands. */
    const decides = proposal !== null && proposal.complete && clock.deadline === "live" && od.outcomeIfUncured === "foreclosure";
    const suffix = proposal === null || !proposal.complete ? "." : clock.deadline !== "live" ? "." : decides ? " — decided at 30:00 unless cured first." : " — but its approvals no longer reach 30:00, so the neutral outcome stands.";
    const proposalLine =
      proposal === null ? null : `${proposal.kind === "foreclose" ? "Foreclosure" : "Neutral annulment"} proposed by ${name(proposal.by)}: ${proposal.yes.length} of ${proposal.needed.length} agree${suffix}`;
    const vetoLine = proposal !== null && od.seat !== me && proposal.needed.includes(me ?? "") ? (clock.deadline === "live" ? VETO_DETAIL_LIVE : VETO_DETAIL_ASYNC) : null;
    if (clock.deadline === "live") {
      const finality = left(od.finality);
      const outcome = od.outcomeIfUncured === "foreclosure" ? LIVE_FORECLOSE_OUTCOME : LIVE_NEUTRAL_OUTCOME;
      return {
        ...base,
        warning,
        controls,
        banner: warning,
        state: "overdue",
        label: "OVERDUE",
        value: finality === null ? null : `${formatClockDuration(finality)} to 30:00`,
        lines: [cure, outcome, ...(proposalLine !== null ? [proposalLine] : []), ...(vetoLine !== null ? [vetoLine] : []), ...extra],
        tone: "overdue",
        ticking: od.finality?.running === true,
      };
    }
    /* Async: overdue only -- no automatic outcome, so no countdown at all. */
    return { ...base, warning, banner: warning, controls, state: "overdue", label: "OVERDUE", value: null, lines: [cure, ASYNC_OVERDUE_DETAIL, ...(proposalLine !== null ? [proposalLine] : []), ...(vetoLine !== null ? [vetoLine] : []), ...extra], tone: "overdue", ticking: false };
  }

  if (clock.state === "trade" && clock.trade !== null) {
    const respond = left(clock.trade.respond);
    const value = respond === null ? null : formatClockDuration(respond);
    return {
      ...base,
      warning,
      controls,
      banner: clock.trade.proposer === me ? `Your action clock is paused at ${formatClockDuration(clock.trade.proposerRemainingMs)}.` : warning,
      state: "trade",
      label: `${clock.trade.kind === undefined || clock.trade.kind === "train" ? "Train offer" : "Offer"} — ${value ?? "10:00"} to respond`,
      value: null,
      lines: [
        `${name(clock.trade.recipient)} ${clock.trade.recipient === me ? "have" : "has"} ${clock.trade.kind === undefined || clock.trade.kind === "train" ? "a train offer" : "an offer"} from ${clock.trade.proposer === me ? "you" : input.nameOf(clock.trade.proposer)}.`,
        `${clock.trade.proposer === me ? "Your" : `${input.nameOf(clock.trade.proposer)}'s`} action clock is paused at ${formatClockDuration(clock.trade.proposerRemainingMs)}.`,
        TRADE_NOT_OVERDUE_DETAIL,
        ...extra,
      ],
      tone: "normal",
      ticking: clock.trade.respond.running,
    };
  }

  if (clock.deadline === "no-deadline") {
    return { ...base, warning, banner: warning, controls, state: "running", label: actorLabel, value: null, lines: [CLOCK_NO_DEADLINE_DETAIL, ...extra], tone: "normal", ticking: false };
  }
  const remaining = left(clock.action);
  const allowance = clock.deadline === "live" ? 20 * 60_000 : (clock.paceSecs ?? 0) * 1000;
  const tone: ClockTone = remaining !== null && allowance > 0 && remaining <= Math.max(60_000, Math.floor(allowance / 5)) ? "warning" : "normal";
  return {
    ...base,
    warning,
    banner: warning,
    controls,
    state: "running",
    label: actorLabel,
    value: remaining === null ? null : formatClockDuration(remaining),
    lines: extra,
    tone: warning !== null && responsible?.seat === me ? "warning" : tone,
    ticking: clock.action?.running === true,
  };
}

function preservedLine(clock: RoomClockView, name: (seat: string) => string): string | null {
  if (clock.overdue !== null) {
    const f = clock.overdue.finality;
    return f === null ? `${name(clock.overdue.seat)}: overdue.` : `${name(clock.overdue.seat)}: overdue, ${formatClockDuration(f.remainingMs)} to 30:00 (kept exactly).`;
  }
  if (clock.trade !== null) return `Train offer: ${formatClockDuration(clock.trade.respond.remainingMs)} to respond (kept exactly).`;
  if (clock.responsible !== null && clock.action !== null) return `${name(clock.responsible.seat)}: ${formatClockDuration(clock.action.remainingMs)} on the action clock (kept exactly).`;
  return null;
}

export function remedyStatusSentence(status: string): string {
  switch (status) {
    case "sealed":
      return "The server recorded the outcome; it is being sent to Juno.";
    case "submitted":
      return "The outcome has been sent to Juno.";
    case "confirmed":
      return "Juno has recorded the outcome.";
    case "superseded":
      return "Juno recorded a different ending (an earlier result stands).";
    case "refused":
      return "The server cannot send this outcome to Juno right now; the escrow stays as it is.";
    default:
      return "";
  }
}

function controlsOf(clock: RoomClockView, me: string | null, seated: boolean): ClockControls {
  if (!seated || me === null) return NO_CONTROLS;
  const live = clock.deadline === "live";
  const active = clock.state === "running" || clock.state === "trade" || clock.state === "overdue";
  const request = clock.pause.request;
  const answerRequest = request !== null && !request.yes.includes(me) ? { kind: request.kind, id: request.id, by: request.by } : null;
  const od = clock.overdue;
  const isDefaulter = od !== null && od.seat === me;
  const proposal = od?.proposal ?? null;
  const propose: ("foreclose" | "annul")[] = [];
  if (clock.state === "overdue" && od !== null && !isDefaulter && proposal === null) {
    propose.push("foreclose");
    if (!live) propose.push("annul");
  }
  const vote =
    clock.state === "overdue" && proposal !== null && !isDefaulter && proposal.needed.includes(me)
      ? { id: proposal.id, kind: proposal.kind, mine: proposal.yes.includes(me) ? ("yes" as const) : proposal.no.includes(me) ? ("no" as const) : null }
      : null;
  const annulAvailable = !clock.money && (clock.state === "running" || clock.state === "trade" || clock.state === "overdue" || clock.state === "paused" || clock.state === "system-paused");
  return {
    requestPause: live && active && !clock.pause.paused && request === null && clock.system === null,
    requestResume: live && clock.state === "paused" && request === null,
    answerRequest: clock.system === null ? answerRequest : null,
    systemResume: clock.system !== null && !clock.system.yes.includes(me),
    propose: clock.system === null ? propose : [],
    vote: clock.system === null ? vote : null,
    annul: annulAvailable ? { mine: clock.annul?.yes.includes(me) ?? false, count: clock.annul?.yes.length ?? 0, needed: clock.seats.length } : null,
  };
}

/** The two-decline rule for THIS proposer and recipient in the current Operating Round: the owner's sentence, or `null`. */
export function declinesBlock(clock: RoomClockView | null | undefined, proposer: string | null, recipient: string | null, recipientName: string): string | null {
  if (clock === null || clock === undefined || clock.v !== 2 || clock.deadline !== "live" || proposer === null || recipient === null || proposer === recipient) return null;
  const row = clock.declines.find((entry) => entry.from === proposer && entry.to === recipient);
  return row !== undefined && row.count >= CLOCK_LIVE_DECLINES_PER_ROUND_INSTANCE ? declinesReachedSentence(recipientName) : null;
}
