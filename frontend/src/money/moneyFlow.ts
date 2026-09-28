// frontend/src/money/moneyFlow.ts
//
// ==================================================================
//  ESCROW-4: A MONEY SEAT'S STATE, DERIVED -- NEVER STORED, NEVER GUESSED
// ==================================================================
//
// PURE. What the money panel shows is recomputed on every render from four things, which is also exactly what a
// reload has (brief §23, preflight §7):
//
//   1. the server's `RoomView.money` -- the only source of "linked", "funded", "frozen", "started", "settled";
//   2. this browser's pending wallet transaction, if any (`pendingTx.ts`) -- "something may be on its way", never
//      "funded";
//   3. whether this browser holds the seat's signing key (`consentKeys.ts`);
//   4. this tab's wallet connection and "Confirm it's you" grant -- the two things that are not durable (Keplr
//      re-enables silently; the grant lives five minutes on the server).
//
// The progression is the brief's, one state per step and no state standing for two:
//
//   Connect -> Confirm -> Link -> Review -> Approve in Keplr -> Sent -> Funded -> Seats locked
//
// Every button offered here is one the server's `you.actions` allows (the server still decides each), or a purely
// local step (connect, confirm, review, re-send). A funded seat is only ever funded because the server read the chain.

import { formatAmount, shortWallet, type MoneyAction, type MoneySeatFunding, type MoneyStartBlocker, type RoomMoneyView } from "../utils/moneyProtocol";
import type { PendingWalletTx } from "./pendingTx";

export type StepKey = "connect" | "confirm" | "link" | "review" | "approve" | "sent" | "funded" | "locked";

export const FUNDING_STEPS: readonly { readonly key: StepKey; readonly label: string }[] = Object.freeze([
  { key: "connect", label: "Connect" },
  { key: "confirm", label: "Confirm" },
  { key: "link", label: "Link" },
  { key: "review", label: "Review" },
  { key: "approve", label: "Approve in Keplr" },
  { key: "sent", label: "Sent" },
  { key: "funded", label: "Funded" },
  { key: "locked", label: "Seats locked" },
]);

export type WalletState =
  /** This build has no pinned escrow (or it is mainnet): it signs nothing. */
  | { readonly kind: "no-pin"; readonly reason: string }
  /** No Keplr in this browser (a phone's ordinary browser, say): play works, wallet steps don't. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "connecting" }
  | { readonly kind: "connected"; readonly address: string };

export type ActionKind =
  | "connect"
  | "confirm"
  | "link"
  | "replace-link"
  | "open-review"
  | "approve"
  | "resend"
  | "withdraw"
  | "cancel-escrow"
  | "refund-after-deadline"
  | "relink"
  | "start"
  | "move-signing-key"
  /* Started on Juno but not dealt here (the waiting room still shows): the escrow's own exits (review R-M10). */
  | "liveness-settle"
  | "annul";

export interface FlowAction {
  readonly kind: ActionKind;
  readonly label: string;
  readonly tone: "primary" | "secondary" | "danger";
  readonly title?: string;
}

export type FlowStage = "watching" | "funding" | "starting" | "started" | "held" | "cancelled" | "unavailable";

export interface SeatFlow {
  readonly stage: FlowStage;
  /** Where this seat is on the progression (null: not a funding situation). */
  readonly step: StepKey | null;
  /** One sentence: this seat's money, now. */
  readonly headline: string;
  /** The next thing to know, or null. */
  readonly detail: string | null;
  /** The one primary button (null: nothing to press now). */
  readonly primary: FlowAction | null;
  readonly others: readonly FlowAction[];
  /** Why the primary can't be pressed on THIS device (Keplr missing, another account, …), or null. */
  readonly blocker: string | null;
}

export interface FlowInput {
  readonly view: RoomMoneyView;
  readonly isHost: boolean;
  readonly wallet: WalletState;
  /** This tab holds a live "Confirm it's you" grant, as far as it knows (the server has the last word). */
  readonly confirmed: boolean;
  /** This browser's newest pending wallet transaction for this seat, or null. */
  readonly pending: PendingWalletTx | null;
  /** This browser holds the seat's CURRENT signing key on chain. */
  readonly holdsChainKey: boolean;
  /** UI-local: the review card is open, or Keplr is being asked right now. */
  readonly ui: "idle" | "review" | "approving";
  readonly now: number;
}

const hhmm = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

export const amountText = (view: RoomMoneyView, base: string | null): string => formatAmount(base, view.deployment.exponent, view.deployment.symbol);

/** What a seat's funding tag says in the roster (replacing Ready at a money table). */
export function fundingTag(funding: MoneySeatFunding): string {
  switch (funding) {
    case "funded":
      return "Funded";
    case "sent":
      return "Sent";
    case "linked":
      return "Wallet linked";
    case "unlinked":
      return "Deposit not linked";
    default:
      return "Not funded";
  }
}

/** Why the table can't start, as a sentence everybody at the table reads the same way. */
export function startBlockerSentence(view: RoomMoneyView, blocker: MoneyStartBlocker | null): string | null {
  const funded = view.escrow.fundedSeats;
  const seats = view.terms.seats;
  const closes = view.escrow.fundingDeadline === null ? "" : ` Funding closes at ${hhmm(view.escrow.fundingDeadline)}.`;
  switch (blocker) {
    case null:
      return null;
    case "escrow-not-open":
      return "Waiting for the host to open the table on Juno.";
    case "need-seats":
      return `Waiting for every seat to be taken (${seats} players).`;
    case "need-funding": {
      const missing = Math.max(0, seats - funded);
      return `Waiting for ${missing} player${missing === 1 ? "" : "s"} to fund.${closes}`;
    }
    case "deposit-in-flight":
      return `A deposit is on its way to Juno.${closes}`;
    case "unknown-deposit":
      return "An unknown wallet holds a seat on this table's escrow. The table can't start until it withdraws; the host can cancel instead (deposits come back minus the fee).";
    case "unlinked-deposit":
      return "A seat's deposit isn't linked to it anymore. That player relinks it (free) or withdraws it before the game can start.";
    case "deadline-near":
      return "It's too close to Juno's funding deadline to start safely. From the deadline on, anyone can refund every deposit (minus the fee).";
    case "funding-closed":
      return "Funding has closed on Juno. Anyone at the table can refund every deposit (minus the fee).";
    case "paused":
      return "Juno's escrow is paused right now; the table starts once it resumes.";
    case "chain-unavailable":
      return "Juno can't be read right now; the table's money is unchanged. It is checked again shortly.";
    case "backend-unavailable":
      return "This server can't reach its Juno escrow right now; nothing about the table's money has changed.";
    case "held":
      return "This table's money is on hold for review.";
    default:
      return null;
  }
}

const has = (view: RoomMoneyView, action: MoneyAction): boolean => view.you?.actions.includes(action) === true;

const WITHDRAW_FLOW: FlowAction = { kind: "withdraw", label: "Withdraw deposit", tone: "secondary", title: "Your deposit comes back minus the fee (the fee isn't refunded)." };
const CANCEL_FLOW: FlowAction = { kind: "cancel-escrow", label: "Cancel table on Juno", tone: "danger", title: "Every deposit comes back to its wallet, minus the fee." };
const REFUND_FLOW: FlowAction = { kind: "refund-after-deadline", label: "Refund everyone (minus the fee)", tone: "secondary", title: "Funding has closed: anyone at the table may refund every deposit." };
const START_FLOW: FlowAction = { kind: "start", label: "Start game", tone: "primary", title: "Locks the seats with the escrow and starts the game on Juno." };
const RESEND_FLOW: FlowAction = { kind: "resend", label: "Send again", tone: "primary", title: "Sends the same signed transaction again (it can land only once)." };
const LIVENESS_FLOW: FlowAction = { kind: "liveness-settle", label: "Close and pay from the last recorded round", tone: "secondary", title: "The table has been quiet past Juno's inactivity window: close it and pay from the last recorded standings." };
const ANNUL_FLOW: FlowAction = { kind: "annul", label: "Agree to cancel this game", tone: "secondary", title: "If every player signs, the game is annulled and every deposit comes back (minus the fee)." };

const isDepositKind = (kind: string): boolean => kind === "create" || kind === "join";

/** The wallet-side blocker for a step that needs Keplr on this device (null: none). */
function walletBlocker(wallet: WalletState, need: string | null): string | null {
  if (wallet.kind === "no-pin") return wallet.reason;
  if (wallet.kind === "unavailable") return "Keplr isn't available in this browser. You can keep playing here; deposits need Keplr (the desktop extension or the Keplr app's browser) on a device where you're signed in to this profile.";
  if (wallet.kind === "connected" && need !== null && wallet.address !== need) return `Keplr is on ${shortWallet(wallet.address)}, but this seat uses ${shortWallet(need)}. Switch accounts in Keplr to continue.`;
  return null;
}

/** The waiting-room derivation for THIS viewer's seat (and a watcher's line). */
export function seatFlow(input: FlowInput): SeatFlow {
  const { view, isHost, wallet, confirmed, pending, ui } = input;
  const you = view.you;
  const ante = amountText(view, view.terms.anteGross);
  const base = { primary: null, others: [] as FlowAction[], blocker: null, detail: null };
  if (you === null) {
    return { ...base, stage: "watching", step: null, headline: `A real-money table: ${ante} per seat on ${view.deployment.chainId}.`, detail: startBlockerSentence(view, view.start.blocker) };
  }
  const funding: MoneySeatFunding = you.funding;
  const link = you.link;
  const needWallet = link?.wallet ?? null;
  const others: FlowAction[] = [];
  const offer = (action: MoneyAction, flow: FlowAction) => {
    if (has(view, action)) others.push(flow);
  };
  /* A transaction this browser signed but never handed to the network (a withdrawal, a cancel, …): it can be sent. */
  const unsent = pending !== null && pending.stage === "signed" && !isDepositKind(pending.kind);
  if (unsent) others.push(RESEND_FLOW);

  if (view.held) {
    /* The server's review holds what IT does; Juno's own exits stay the players' (review R-M7). */
    offer("withdraw", WITHDRAW_FLOW);
    offer("cancel-escrow", CANCEL_FLOW);
    offer("refund-after-deadline", REFUND_FLOW);
    const deposited = funding === "funded" || funding === "unlinked" || you.chainSeatIndex !== null;
    return {
      ...base,
      stage: "held",
      step: null,
      headline: "This table's money is on hold for review.",
      detail: deposited
        ? "This server won't start, pay or refund anything for this table until an operator has reviewed it. Your deposit stays in escrow on Juno, and Juno's own exits still work."
        : "This server won't start this table until an operator has reviewed it. You have no deposit in its escrow.",
      others,
      blocker: others.length > 0 ? walletBlocker(wallet, null) : null,
    };
  }
  if (view.escrow.state === "CANCELLED") {
    return { ...base, stage: "cancelled", step: null, headline: "The table was cancelled on Juno.", detail: "Every deposit went back to the wallet that made it, minus the fee." };
  }
  if (view.start.state === "started" || view.escrow.state === "IN_PROGRESS") {
    /* Normally the deal follows at once. If this table stays here (the deal was refused), the escrow's own exits are
       what's left: the inactivity exit when it opens, and cancelling by every player's agreement (review R-M10). */
    offer("liveness-settle", LIVENESS_FLOW);
    offer("annul", ANNUL_FLOW);
    return { ...base, stage: "started", step: "locked", headline: "Started on Juno — the game is being dealt.", detail: "Every deposit stays in escrow until the game ends.", others, blocker: others.some((action) => action.kind === "liveness-settle") ? walletBlocker(wallet, null) : null };
  }
  if (view.start.state === "starting") {
    return { ...base, stage: "starting", step: "locked", headline: "Seats locked — starting on Juno…", detail: "If Juno can't start it (a seat withdrew first), the table goes back to funding and says so.", others };
  }

  const rolledBack = view.start.state === "rolled-back" ? " The last Start didn't go through on Juno; the table is back to funding." : "";
  const closes = view.escrow.fundingDeadline === null ? null : `Funding closes at ${hhmm(view.escrow.fundingDeadline)}.`;

  /* A local deposit that may still land (or landed, not yet shown): nothing else is built for this seat until then. */
  const localDeposit = pending !== null && isDepositKind(pending.kind);
  if (funding === "funded") {
    offer("withdraw", WITHDRAW_FLOW);
    offer("cancel-escrow", CANCEL_FLOW);
    offer("refund-after-deadline", REFUND_FLOW);
    const primary = view.start.canStart ? START_FLOW : null;
    const anyoneAt = view.start.anyoneMayStartAt;
    const waitingForHost = primary === null && view.start.state === "ready" && !isHost && anyoneAt !== null;
    const detail =
      [
        waitingForHost ? `Everyone is funded. The host can start now; if they haven't by ${hhmm(anyoneAt)}, you can.` : primary === null ? startBlockerSentence(view, view.start.blocker) : isHost ? "Everyone is funded: you can start the game." : "Everyone is funded and the host hasn't started: you can start the game.",
        isHost ? "Until the game starts you can cancel the table on Juno (every deposit comes back, minus the fee)." : "Until the game starts you can withdraw (the fee isn't refunded).",
      ]
        .filter(Boolean)
        .join(" ") + rolledBack;
    return { stage: "funding", step: "funded", headline: `Funded — ${ante} from ${shortWallet(you.payoutWallet ?? needWallet)} is in this table's escrow.`, detail, primary, others, blocker: null };
  }
  if (funding === "unlinked") {
    offer("withdraw", WITHDRAW_FLOW);
    offer("cancel-escrow", CANCEL_FLOW);
    const deposit = you.unlinkedDeposit?.wallet ?? null;
    const needs = wallet.kind !== "connected" ? { kind: "connect" as const, label: "Connect wallet", tone: "primary" as const } : !confirmed ? { kind: "confirm" as const, label: "Confirm it's you", tone: "primary" as const } : { kind: "relink" as const, label: "Relink deposit (free)", tone: "primary" as const };
    return {
      stage: "funding",
      step: needs.kind === "connect" ? "connect" : needs.kind === "confirm" ? "confirm" : "link",
      headline: "Your deposit isn't linked to your seat anymore.",
      detail: `A sign-out or a new recovery key ended the link to ${shortWallet(deposit)}. Relink it — free, Keplr signs a message — or ${isHost ? "cancel the table on Juno" : "withdraw it"}.${rolledBack}`,
      primary: has(view, "relink") ? needs : null,
      others,
      blocker: walletBlocker(wallet, deposit),
    };
  }
  if (localDeposit || funding === "sent") {
    const signedOnly = pending !== null && isDepositKind(pending.kind) && pending.stage === "signed";
    const landed = pending !== null && isDepositKind(pending.kind) && pending.stage === "landed";
    const tx = pending?.txHash ?? you.pending?.txHash ?? null;
    return {
      stage: "funding",
      step: "sent",
      headline: signedOnly ? "Signed — not sent yet." : landed ? "Juno included your deposit — the table shows it in a moment." : "Sent — waiting for Juno.",
      detail: signedOnly
        ? "Keplr signed it, but it may not have reached Juno. Send it again: it's the same transaction, so it can land only once."
        : `${tx === null ? "" : `Transaction ${tx.slice(0, 8)}…. `}We keep checking; don't send it again. If Juno never includes it, this says so and nothing moved.`,
      primary: signedOnly ? RESEND_FLOW : null,
      others: [],
      blocker: null,
    };
  }
  if (funding === "linked" && link !== null) {
    const bound = view.escrow.chainGameId !== null;
    const canDeposit = isHost ? has(view, "open-escrow") : has(view, "deposit");
    if (has(view, "link-wallet")) others.push({ kind: "replace-link", label: "Change wallet", tone: "secondary", title: "Link another wallet to this seat (Confirm it's you, then Keplr signs)." });
    offer("cancel-escrow", CANCEL_FLOW);
    offer("refund-after-deadline", REFUND_FLOW);
    const blocker = walletBlocker(wallet, link.wallet);
    if (!canDeposit) {
      return {
        stage: "funding",
        step: "review",
        headline: `Wallet linked · ${shortWallet(link.wallet)}`,
        detail: !bound
          ? isHost
            ? startBlockerSentence(view, view.start.blocker)
            : "Waiting for the host to open the table on Juno. Your deposit button appears then."
          : view.escrow.state !== "FUNDING" && view.escrow.state !== "FUNDED"
            ? /* Juno can't be read just now (or the escrow moved on): say that, never guess what it holds. */
              (startBlockerSentence(view, view.start.blocker) ?? startBlockerSentence(view, "chain-unavailable"))
            : isHost
              ? "Your deposit isn't in this table's escrow on Juno anymore, so the table can't fill. Cancel it on Juno: every deposit comes back, minus the fee."
              : `This table's escrow isn't taking deposits right now.${closes === null ? "" : ` ${closes}`}`,
        primary: null,
        others,
        blocker: others.some((action) => action.kind === "cancel-escrow" || action.kind === "refund-after-deadline") ? walletBlocker(wallet, null) : null,
      };
    }
    const label = isHost ? `Open the table on Juno — deposit ${ante}` : `Deposit ${ante}`;
    if (ui === "approving") {
      return { stage: "funding", step: "approve", headline: "Approve in Keplr…", detail: "Keplr shows the transaction. Nothing is sent until you approve it there.", primary: null, others: [], blocker: null };
    }
    if (ui === "review") {
      return { stage: "funding", step: "review", headline: isHost ? "Review: open the table on Juno" : "Review: deposit to this table", detail: closes, primary: { kind: "approve", label: "Approve in Keplr", tone: "primary" }, others, blocker };
    }
    return {
      stage: "funding",
      step: "review",
      headline: `Wallet linked · ${shortWallet(link.wallet)}`,
      detail: `${isHost ? "Open the table on Juno with your deposit; the others deposit once it's open." : "Deposit to take your seat's place in the escrow."}${closes === null ? "" : ` ${closes}`}${rolledBack}`,
      primary: { kind: "open-review", label, tone: "primary" },
      others,
      blocker,
    };
  }
  /* No standing link: Connect -> Confirm -> Link. */
  const blocker = walletBlocker(wallet, null);
  const noteFirst = isHost ? "You open this table on Juno with your own deposit." : view.escrow.chainGameId === null ? "The host opens the table on Juno first; you can link your wallet now." : "Link your wallet, then deposit.";
  if (wallet.kind === "connected") {
    if (!confirmed) {
      return { stage: "funding", step: "confirm", headline: `Keplr: ${shortWallet(wallet.address)}`, detail: `Confirm it's you (your recovery key), then link this wallet to your seat. ${noteFirst}`, primary: { kind: "confirm", label: "Confirm it's you", tone: "primary" }, others: [], blocker: null };
    }
    return {
      stage: "funding",
      step: "link",
      headline: `Keplr: ${shortWallet(wallet.address)}`,
      detail: `Keplr will ask you to sign a message. It's free and moves no funds. ${noteFirst}`,
      primary: has(view, "link-wallet") ? { kind: "link", label: "Link wallet", tone: "primary" } : null,
      others: [],
      blocker: null,
    };
  }
  return {
    stage: "funding",
    step: "connect",
    headline: `A real-money table: ${ante} per seat.`,
    detail: `Connect Keplr to fund your seat. ${noteFirst}`,
    primary: wallet.kind === "unavailable" || wallet.kind === "no-pin" ? null : { kind: "connect", label: wallet.kind === "connecting" ? "Connecting…" : "Connect wallet", tone: "primary", title: "Keplr asks to share your Juno address with this site." },
    others: [],
    blocker,
  };
}

/* ==================================================================
    AFTER THE DEAL: THE FINANCIAL BAND (the game result is final before any of this)
   ================================================================== */

export type SettlementActionKind = "approve-payout" | "challenge" | "release-payout" | "liveness-settle" | "annul" | "move-signing-key";

export interface SettlementFlow {
  /** One status line (never "pending result": the result is final). */
  readonly headline: string;
  readonly detail: string | null;
  readonly actions: readonly { readonly kind: SettlementActionKind; readonly label: string; readonly tone: "primary" | "secondary" | "danger"; readonly title?: string }[];
  /** This seat's payout once the chain paid it (base units), or null. */
  readonly paid: string | null;
}

export interface SettlementInput {
  readonly view: RoomMoneyView;
  /** This browser holds the chain's current signing key for this seat. */
  readonly holdsChainKey: boolean;
  /** This device checked the recorded payout against its own copy of the game ("match"), found it differs, or can't. */
  readonly verification: "match" | "mismatch" | "unavailable";
  readonly now: number;
  /** Keplr can be used on this device (absent: assumed). Without it, the wallet's own transactions aren't offered here. */
  readonly keplr?: boolean;
}

/** What Keplr sends (the seat's wallet); approving and agreeing to cancel are signed by this device's key instead. */
const NEEDS_KEPLR: ReadonlySet<SettlementActionKind> = new Set<SettlementActionKind>(["move-signing-key", "challenge", "release-payout", "liveness-settle"]);

/** On a device without Keplr (a phone's browser, say): only what this device's own key signs is offered, and the
 *  band says where the rest is done (review R-M3). */
export function settlementFlow(input: SettlementInput): SettlementFlow {
  const flow = settlementFlowFor(input);
  if (input.keplr !== false) return flow;
  const kept = flow.actions.filter((action) => !NEEDS_KEPLR.has(action.kind));
  if (kept.length === flow.actions.length) return flow;
  const note = "Disputes, releases and the inactivity exit are sent with Keplr: use a device that has it.";
  return { ...flow, actions: kept, detail: flow.detail === null ? note : `${flow.detail} ${note}` };
}

function settlementFlowFor(input: SettlementInput): SettlementFlow {
  const { view, holdsChainKey, verification } = input;
  const s = view.settlement;
  const you = view.you;
  const chainSeat = you?.chainSeatIndex ?? null;
  const paid = s?.amounts != null && chainSeat !== null ? (s.amounts[chainSeat] ?? null) : null;
  const acts: { kind: SettlementActionKind; label: string; tone: "primary" | "secondary" | "danger"; title?: string }[] = [];
  const legal = (action: MoneyAction) => you?.actions.includes(action) === true;
  const releaseAt = s?.windowEnd ?? null;
  if (view.held || s?.status === "held") {
    /* The server's review holds what IT does; Juno's own exits stay the players' (review R-M7). */
    if (legal("challenge")) acts.push({ kind: "challenge", label: "Dispute", tone: "secondary", title: "Attaches the dispute bond; the resolver decides." });
    if (legal("liveness-settle")) acts.push({ kind: "liveness-settle", label: "Close and pay from the last recorded round", tone: "secondary", title: "The table has been quiet past Juno's inactivity window: close it and pay from the last recorded standings." });
    return { headline: "Payout on hold for review.", detail: "Your result is final. This server holds its part of the payout until an operator has reviewed it; what's in escrow on Juno is unchanged, and Juno's own exits still work.", actions: acts, paid };
  }
  if (s === null) {
    if (legal("liveness-settle")) acts.push({ kind: "liveness-settle", label: "Close and pay from the last recorded round", tone: "secondary", title: "The table has been quiet past Juno's inactivity window: close it and pay from the last recorded standings." });
    if (legal("annul")) acts.push({ kind: "annul", label: "Agree to cancel this game", tone: "secondary", title: "If every player signs, the game is annulled and every deposit comes back (minus the fee)." });
    return { headline: "Standings are recorded on Juno every round.", detail: "Nothing is needed from you while the game is played.", actions: acts, paid };
  }
  if (legal("move-signing-key") && !holdsChainKey && (s.status === "recorded" || s.status === "none" || s.status === "preparing" || s.status === "submitted")) {
    acts.push({ kind: "move-signing-key", label: "Use this device for signing", tone: "secondary", title: "Makes a signing key on this device and moves your seat's key to it on Juno (Keplr approves it). An approval already given with the old key stops counting." });
  }
  switch (s.status) {
    case "none": {
      /* The game is being played: nothing is asked of anyone. What the chain holds is said, and the inactivity exit. */
      if (legal("liveness-settle")) acts.push({ kind: "liveness-settle", label: "Close and pay from the last recorded round", tone: "secondary", title: "The table has been quiet past Juno's inactivity window: close it and pay from the last recorded standings." });
      if (legal("annul")) acts.push({ kind: "annul", label: "Agree to cancel this game", tone: "secondary", title: "If every player signs, the game is annulled and every deposit comes back (minus the fee)." });
      const checkpoint = s.lastCheckpoint;
      const recorded = checkpoint === null ? "Standings are recorded on Juno every round." : `Standings last recorded on Juno at ${checkpoint.roundKey}${checkpoint.confirmed ? "" : " (being confirmed)"}.`;
      const exit = s.livenessAvailableAt !== null && input.now < s.livenessAvailableAt ? ` If no round finishes by ${hhmm(s.livenessAvailableAt)}, any player may close the table on Juno and be paid from the last recorded standings.` : "";
      return { headline: recorded, detail: `Nothing is needed from you while the game is played; closing the browser changes nothing about your deposit.${exit}`, actions: acts, paid };
    }
    case "preparing":
      return { headline: "Result final. Preparing the settlement on Juno…", detail: null, actions: acts, paid };
    case "submitted":
      return { headline: "Result sent to Juno — confirming…", detail: null, actions: acts, paid };
    case "recorded": {
      const verified = verification === "match";
      if (legal("approve-payout") && holdsChainKey && verified) acts.unshift({ kind: "approve-payout", label: "Approve payout now", tone: "primary", title: "If every player approves, the payout is released at once." });
      if (legal("challenge") && verification === "mismatch") acts.unshift({ kind: "challenge", label: "Dispute the payout", tone: "danger", title: "Attaches the dispute bond; the resolver decides." });
      else if (legal("challenge")) acts.push({ kind: "challenge", label: "Dispute", tone: "secondary", title: "Attaches the dispute bond; the resolver decides." });
      if (legal("annul")) acts.push({ kind: "annul", label: "Agree to cancel this game", tone: "secondary", title: "If every player signs, the game is annulled and every deposit comes back (minus the fee)." });
      const note =
        verification === "mismatch"
          ? "This device's copy of the game doesn't match what Juno received. Don't approve it; you can dispute it before the window closes."
          : !holdsChainKey
            ? "Approving early is done on the device holding this table's signing key. You'll still be paid when the window closes without it."
            : verification === "unavailable"
              ? "This device can't re-check the result right now, so it doesn't offer early approval. You'll be paid when the window closes."
              : "Checked on this device: Juno's recorded result covers exactly this game's moves.";
      return { headline: `Recorded on Juno. The payout is released at ${hhmm(releaseAt)} unless a player disputes it.`, detail: note, actions: acts, paid };
    }
    case "release-available":
      if (legal("release-payout")) acts.unshift({ kind: "release-payout", label: "Release payout", tone: "primary", title: "Anyone may send this once the window has closed (Keplr pays the network fee)." });
      return { headline: "The challenge window has closed. The payout can be released now.", detail: "The server normally releases it; if it hasn't, any player can.", actions: acts, paid };
    case "paused":
      /* Disputes and the inactivity exit work while paused (the window keeps running). */
      if (legal("challenge")) acts.push({ kind: "challenge", label: "Dispute", tone: "secondary", title: "Attaches the dispute bond; the resolver decides." });
      if (legal("liveness-settle")) acts.push({ kind: "liveness-settle", label: "Close and pay from the last recorded round", tone: "secondary", title: "The table has been quiet past Juno's inactivity window: close it and pay from the last recorded standings." });
      return { headline: "Juno's escrow is paused, so approvals and releases wait.", detail: "Nothing is lost; they resume when it unpauses. Disputes and the inactivity exit still work.", actions: acts, paid };
    case "disputed":
      if (legal("liveness-settle")) acts.push({ kind: "liveness-settle", label: "Close through the inactivity exit", tone: "secondary" });
      return { headline: `A player disputed the payout. The resolver decides by ${hhmm(s.resolverTimeoutAt)}.`, detail: "After that, any seated player's wallet may close it through the inactivity exit.", actions: acts, paid };
    case "paid":
      return { headline: paid === null ? "Paid out on Juno." : paid === "0" ? "No payout for this seat." : `Paid: ${amountText(view, paid)} sent to ${shortWallet(you?.payoutWallet ?? null)}.`, detail: null, actions: [], paid };
    case "refunded":
      return { headline: paid === null ? "Refunded on Juno." : `Refunded: ${amountText(view, paid)} back to ${shortWallet(you?.payoutWallet ?? null)}.`, detail: "The fee isn't refunded.", actions: [], paid };
    case "annulled":
      return { headline: paid === null ? "The game was annulled; deposits came back." : `Annulled: ${amountText(view, paid)} back to ${shortWallet(you?.payoutWallet ?? null)}.`, detail: "The fee isn't refunded.", actions: [], paid };
    case "cancelled":
      return { headline: "The table was cancelled; deposits came back minus the fee.", detail: null, actions: [], paid };
    default:
      return { headline: "The settlement's state isn't known yet.", detail: null, actions: acts, paid };
  }
}
