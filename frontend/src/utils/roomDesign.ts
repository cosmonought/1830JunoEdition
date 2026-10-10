// frontend/src/utils/roomDesign.ts
//
// PLAY HOST A GAME + WAITING ROOM (approved design, "play-host-waiting-handoff"): the PURE parts of the two screens --
// the pace and bank lines, "How the clock works" (§9.3, written to the clock model and kept faithful to it), the
// table's status word, the boarding pass's paper patch and its tear (§6), the status sentence on your pass (§6),
// the start blocker in the design's wording, and the Keplr approval count of the one-button Ante (§7). Everything here
// is derived from what the server already sends; nothing here decides anything the server decides.

import { bankSizeLabel, type GameLength, type GameMode } from "../gameEngine/gameVariants";
import { CLOCK_LIVE_ACTION_MS, CLOCK_LIVE_CURE_MS, CLOCK_LIVE_FREE_OVERDUES, CLOCK_LIVE_TRADE_MS, type ClockDeadlineClass } from "./clockProtocol";
import { formatAmount, type MoneyStartBlocker, type RoomMoneyView } from "./moneyProtocol";
import { PACE_LABEL } from "./lobbyBoard";
import { startBlockerSentence, ANTE_STATUS } from "../money/moneyFlow";
import { formatMoneyTime } from "../money/moneyTime";

/* ------------------------------------------------------------------ pace, bank, fee */

/** The table's pace as the design reads it: Live, an Async pace, or Async with no deadline (null: not known yet). */
export interface PaceChoice {
  readonly mode: GameMode;
  readonly deadline: ClockDeadlineClass | null;
  readonly paceSecs: number | null;
}

const mmss = (ms: number): string => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
const minutes = (ms: number): string => `${Math.round(ms / 60_000)}m`;

/** "Live · 20m per action", "Async · 2d per action", "Async · no deadline" -- or "Async" while the deadline is unknown. */
export function paceText(pace: PaceChoice): string {
  if (pace.mode === "live") return `Live · ${minutes(CLOCK_LIVE_ACTION_MS)} per action`;
  if (pace.deadline === "no-deadline") return "Async · no deadline";
  const short = pace.paceSecs === null ? undefined : PACE_LABEL[pace.paceSecs];
  return short === undefined ? "Async" : `Async · ${short} per action`;
}

/** The preview row's Mode cell: "Live", "Async: 2d", or "Async" with no deadline. */
export function paceModeCell(pace: PaceChoice): string {
  if (pace.mode === "live") return "Live";
  const short = pace.deadline === "async-pace" && pace.paceSecs !== null ? PACE_LABEL[pace.paceSecs] : undefined;
  return short === undefined ? "Async" : `Async: ${short}`;
}

export const LENGTH_WORD: Readonly<Record<GameLength, string>> = { short: "Short", standard: "Standard", long: "Long" };

/** "$12,000 (Standard)". */
export const bankText = (length: GameLength): string => `${bankSizeLabel(length)} (${LENGTH_WORD[length]})`;

/** Basis points as a percentage, integers only ("250" -> "2.5%"); null when the fee isn't known. */
export function feePercent(feeBps: number | null | undefined): string | null {
  if (typeof feeBps !== "number" || !Number.isInteger(feeBps) || feeBps < 0) return null;
  const whole = Math.floor(feeBps / 100);
  const part = String(feeBps % 100).padStart(2, "0").replace(/0+$/, "");
  return `${whole}${part === "" ? "" : `.${part}`}%`;
}

/** "Each seat deposits X; the 2.5% developer fee (Y) isn't refunded." -- the fee from the deployment, never a constant. */
export function anteFeeSentence(base: string, feeBps: number | null | undefined, exponent: number, symbol: string): string {
  const pct = feePercent(feeBps);
  const each = formatAmount(base, exponent, symbol);
  if (pct === null || typeof feeBps !== "number") return `Each seat deposits ${each}; the escrow's developer fee isn't refunded.`;
  const fee = /^[0-9]{1,40}$/.test(base) ? ((BigInt(base) * BigInt(feeBps)) / BigInt(10_000)).toString() : null;
  return `Each seat deposits ${each}; the ${pct} developer fee (${formatAmount(fee, exponent, symbol)}) isn't refunded.`;
}

/* ------------------------------------------------------------------ how the clock works (§9.3, exact text) */

/** PACE_LONG: the long form of each Async pace, as the clock text reads it. */
export const PACE_LONG: Readonly<Record<number, string>> = { 43_200: "12 hours", 86_400: "24 hours", 172_800: "2 days", 259_200: "3 days", 604_800: "7 days" };

/** The lines for the chosen mode and pace, matched to the clock model (`server/src/rooms/clock/clockModel.ts`): Live
 *  20:00 per required action and a 10:00 cure window, the minute-30 outcome (foreclosure only with every other player's
 *  YES, neutral annulment otherwise), strikes counted only in Live (the third forecloses at once), a 10:00 response
 *  timer and a 10:00 freeze budget per required-action episode; timed Async: Overdue only, N-1 unanimous annul or
 *  foreclose, one NO vetoes, a cure moots it; No deadline: nothing timed, never Overdue. The fee is the deployment's. */
export function clockRules(pace: PaceChoice, feeBps: number | null | undefined): string[] {
  const pct = feePercent(feeBps);
  const back = `every ante is returned, less the ${pct === null ? "escrow's" : pct} fee`;
  if (pace.mode === "live") {
    const overdueLimit = CLOCK_LIVE_FREE_OVERDUES === 2 ? "twice" : `${CLOCK_LIVE_FREE_OVERDUES} times`;
    return [
      `Live: ${mmss(CLOCK_LIVE_ACTION_MS)} for each required action.`,
      `A player who runs out is marked Overdue and has until ${mmss(CLOCK_LIVE_ACTION_MS + CLOCK_LIVE_CURE_MS)} to make the move; play waits for it. If they don't make it, the game ends: their ante is forfeited if every other player has voted for that, and otherwise ${back}.`,
      `A player may only be Overdue ${overdueLimit} in a game. A third Overdue automatically ends the game and forfeits their ante, which is split among the other players.`,
      `A trade offer that pauses its maker's clock (a train offer, for example) gives its recipient ${mmss(CLOCK_LIVE_TRADE_MS)} to answer. Each required action gets at most ${mmss(CLOCK_LIVE_TRADE_MS)} of paused time in total; after that, the maker's clock keeps running while the offer waits.`,
    ];
  }
  if (pace.deadline !== "no-deadline" && pace.paceSecs !== null && PACE_LONG[pace.paceSecs] !== undefined) {
    return [
      `Async: ${PACE_LONG[pace.paceSecs]} for each required action.`,
      "A player who runs out is marked Overdue. Nothing happens automatically: play isn't held up and no money moves.",
      `The other players may all agree to annul the game (${back}) or to foreclose (the Overdue player's ante is forfeited and split among them). One "no" vote stops it, and making the move first ends the Overdue.`,
      "There is no limit on Overdues in Async, and nothing ends the game automatically.",
      "A trade offer doesn't pause its maker's clock; the wait for an answer counts against the maker.",
    ];
  }
  if (pace.deadline === "no-deadline") {
    return [
      "Async with no deadline: nothing is timed, and no player can ever become Overdue.",
      "The game ends when it is finished, or when every player agrees to annul it.",
      "If it doesn't finish and not every player agrees to annul it, the antes in escrow may stay locked indefinitely.",
    ];
  }
  return ["Async: the table's deadline is being read from the server."];
}

/* ------------------------------------------------------------------ the sign's status */

export type RoomStatus = "departing" | "full" | "final-call" | "boarding";
export const ROOM_STATUS_WORD: Readonly<Record<RoomStatus, string>> = { departing: "Departing", full: "Full", "final-call": "Final call", boarding: "Boarding" };
/** The lobby's colours for each word (`lobbyDesignCss.ts`). */
export const ROOM_STATUS_CLASS: Readonly<Record<RoomStatus, string>> = { departing: "lb-st-under-way", full: "lb-st-full", "final-call": "lb-st-final-call", boarding: "lb-st-boarding" };

/** Departing once the host has started; Full when every seat is taken; Final call on an exact table with one seat
 *  left (never on an Any table); Boarding otherwise. */
export function roomStatus(input: { departing: boolean; seated: number; cap: number; exact: boolean }): RoomStatus {
  if (input.departing) return "departing";
  if (input.seated >= input.cap) return "full";
  if (input.exact && input.cap - input.seated === 1) return "final-call";
  return "boarding";
}

/* ------------------------------------------------------------------ the boarding pass: its paper and its tear */

/** A seat's seed: the mockup's string hash (31, from 7), so a pass always shows the same patch and tears the same way. */
export function passSeed(text: string): number {
  let h = 7;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/** Where on the 512 px rag-paper tile this pass sits (so no two passes look stamped from one sheet). */
export function paperOffset(seed: number): { x: number; y: number } {
  return { x: -(seed % 512), y: -((seed >>> 9) % 512) };
}

export const TEAR_DEPTH_PX = 7;
export const TEAR_SEGMENTS = 22;

/** The tear (§6 step 1): one ragged profile of 22 segments, up to 7 px deep, seeded by the seat -- cut into the pass's
 *  right edge and, offset by the tear's width, into the stub's left edge, so the two torn edges match. */
export function cutsFor(seed: number): { main: string; stub: string } {
  let r = seed % 233_280;
  const rnd = (): number => {
    r = (r * 9301 + 49_297) % 233_280;
    return r / 233_280;
  };
  const t = TEAR_DEPTH_PX;
  const n = TEAR_SEGMENTS;
  const ys: number[] = [];
  const js: number[] = [];
  for (let k = 0; k <= n; k += 1) {
    ys.push(k === 0 ? 0 : k === n ? 100 : ((k + (rnd() - 0.5) * 0.7) / n) * 100);
    js.push(Number((rnd() * t).toFixed(1)));
  }
  const mid = ys.slice(1, -1).map((y, k): [string, number] => [y.toFixed(1), js[k + 1]]);
  const main = `polygon(0 0, calc(100% - ${js[0]}px) 0, ${mid.map(([y, j]) => `calc(100% - ${j}px) ${y}%`).join(", ")}, calc(100% - ${js[n]}px) 100%, 0 100%)`;
  const stub = `polygon(${(t - js[0]).toFixed(1)}px 0, 100% 0, 100% 100%, ${(t - js[n]).toFixed(1)}px 100%, ${mid
    .slice()
    .reverse()
    .map(([y, j]) => `${(t - j).toFixed(1)}px ${y}%`)
    .join(", ")})`;
  return { main, stub };
}

/** A seat's pass state, in words on the pass (the stamps and the tear are decorative; this is the text). */
export type PassState = "paid" | "sent" | "opens" | "unlinked" | "none" | "ready" | "not-ready";
export const PASS_STATE_TEXT: Readonly<Record<PassState, string>> = {
  paid: "Ante paid",
  sent: "Ante sent · waiting for Juno",
  opens: "Antes first, to open the table",
  unlinked: "Deposit not linked",
  none: "Not anted yet",
  ready: "Ready",
  "not-ready": "Not ready",
};

/* ------------------------------------------------------------------ your pass: the blocker and the status sentence */

/** Play's `startBlockerSentence`, with the design's two wording changes (§6): the seats, and "to ante". */
export function departureBlocker(view: RoomMoneyView, blocker: MoneyStartBlocker | null, now: number, table: { exact: boolean; seated: number; cap: number }): string | null {
  const closes = view.escrow.fundingDeadline === null ? "" : ` Funding closes at ${formatMoneyTime(view.escrow.fundingDeadline, { now })}.`;
  if (blocker === "need-seats") return table.exact ? `Waiting for every seat to be taken (${table.cap} players).` : "Waiting for at least 2 players.";
  if (blocker === "need-funding") {
    const missing = Math.max(0, (table.exact ? view.terms.seats : table.seated) - view.escrow.fundedSeats);
    return `Waiting for ${missing} player${missing === 1 ? "" : "s"} to ante.${closes}`;
  }
  return startBlockerSentence(view, blocker, now);
}

export interface LeadInput {
  readonly departing: boolean;
  readonly isHost: boolean;
  readonly hostName: string;
  /** The ante, formatted ("10 JUNOX"). */
  readonly ante: string;
  readonly exact: boolean;
  readonly seated: number;
  /** A Keplr approval is open right now (the Ante is running). */
  readonly approving: boolean;
  /** This seat's funding as the server reads it. */
  readonly funding: "none" | "linked" | "sent" | "funded" | "unlinked";
  /** This browser holds a deposit that may still land. */
  readonly sending: boolean;
  /** The host's ante has opened the table on Juno. */
  readonly escrowOpen: boolean;
  /** Every seat (exact) / everyone seated, at least two (Any) has anted. */
  readonly allIn: boolean;
  /** The start may be pressed now by this viewer. */
  readonly canStart: boolean;
  /** Why the table can't start, in the design's wording (or null). */
  readonly blocker: string | null;
  /** Play's own sentence for a money state the design leaves to Play (held, cancelled, unlinked, …), or null. */
  readonly special: string | null;
}

/** The status sentence on your pass (§6's table, `role="status"`): where things stand and what to do next. */
export function leadSentence(input: LeadInput): string {
  if (input.departing) return "Departing.";
  if (input.approving) return "Keplr shows each step before anything moves. Approve it there.";
  if (input.special !== null) return input.special;
  if (input.funding === "sent" || input.sending) return "Your ante is on its way to Juno.";
  if (input.funding !== "funded") {
    if (input.isHost) return `Ante ${input.ante} to open the table on Juno. The others ante once it's open.`;
    if (!input.escrowOpen) return `${input.hostName} antes first, which opens the table on Juno. Your Ante button works once it's open.`;
    return `Ante ${input.ante} to board. Keplr asks you to approve each step; nothing moves until you do.`;
  }
  if (input.isHost) {
    if (input.canStart) return input.exact ? "Every seat has anted. Start locks the seats and deals the game." : `Everyone seated has anted. Start deals the game for ${input.seated}; open seats close.`;
    return input.blocker ?? "";
  }
  if (input.allIn) return `You're on board. ${input.exact ? "Every seat has" : "Everyone seated has"} anted; waiting for the host to start the game…`;
  return `You're on board.${input.blocker === null ? "" : ` ${input.blocker}`}`;
}

/* ------------------------------------------------------------------ the one-button Ante: which Keplr approvals (§7) */

export type ApprovalStep = "connect" | "verify" | "deposit";

export const APPROVAL_TEXT: Readonly<Record<ApprovalStep, string>> = {
  connect: "connect your wallet",
  verify: "sign a free message proving the wallet is yours",
  deposit: "approve the deposit",
};

/** The approvals one press of Ante will ask for, as far as this page can tell before the first: Keplr connects when this
 *  page isn't connected, a free signature when the seat has no standing link (or the server said its proof is too old),
 *  and the deposit. `moneyActions.anteNow` decides as it runs; when it asks for one this list didn't plan, the count is
 *  dropped (`approvalStatus`) rather than shown wrong. */
export function plannedApprovals(input: { connected: boolean; linked: boolean; proofRefused: boolean; isHost: boolean }): ApprovalStep[] {
  const steps: ApprovalStep[] = [];
  if (!input.connected) steps.push("connect");
  if (!input.linked || (input.proofRefused && !input.isHost)) steps.push("verify");
  steps.push("deposit");
  return steps;
}

/** Which approval a running Ante's status line names (`ANTE_STATUS`), or null. */
export function approvalOf(progress: string | null): ApprovalStep | null {
  if (progress === ANTE_STATUS.connecting) return "connect";
  if (progress === ANTE_STATUS.verifying) return "verify";
  if (progress === ANTE_STATUS.depositing) return "deposit";
  return null;
}

/** "Check Keplr: sign a free message proving the wallet is yours (2 of 3)." -- or without the count when the approvals
 *  seen so far left the plan (an unplanned re-proof, say): the total can't be known, so it isn't guessed. */
export function approvalStatus(plan: readonly ApprovalStep[], seen: readonly ApprovalStep[]): string | null {
  if (seen.length === 0) return null;
  const now = seen[seen.length - 1];
  const onPlan = seen.length <= plan.length && seen.every((step, i) => plan[i] === step);
  return `Check Keplr: ${APPROVAL_TEXT[now]}${onPlan ? ` (${seen.length} of ${plan.length})` : ""}.`;
}
