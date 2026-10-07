// frontend/src/components/money/MoneyPanel.tsx
//
// ==================================================================
//  ESCROW-4 (brief §14): THE WAITING ROOM'S MONEY PANEL -- THE SEAT'S FUNDING, ONE STEP AT A TIME
// ==================================================================
//
// At a real-money table the waiting room's Ready is replaced by this panel (a deposit on Juno IS the seat's
// readiness). It draws the seat's state from `useMoneyTable` -- the server's view, this browser's pending transaction
// and signing key, this page's Keplr connection and "Confirm it's you" -- and offers exactly one primary button at a
// time.
//
// PHASE 3 (P3-ACCT, owner 2026-10-05): that button is "Ante X JUNO". One press runs what the seat still needs --
// Connecting wallet… -> Verifying wallet… -> Waiting for deposit… -> Ante confirmed -- and the progress line shows five
// steps (Connect wallet, Verify wallet, Deposit, Ante confirmed, Seats locked). The deposit's terms are always on the
// panel before the press (the compact line, with the full terms one click away, and the Terms page linked: AUD-20.08);
// Keplr shows the transaction itself before anything moves. Before a withdrawal or a cancel it says what comes back.
// Every refusal is the sentence that explains it; nothing here is a generic failure.

import React, { useState } from "react";

import { feeOf, formatAmount, netOf, shortWallet, type RoomMoneyView } from "../../utils/moneyProtocol";
import type { RoomView } from "../../utils/roomProtocol";
import type { SessionPort } from "../../utils/sessionBootstrap";
import { ConfirmItsYou } from "../ConfirmItsYou";
import { explorerLink } from "../../money/escrowDeployment";
import { amountText, FUNDING_STEPS, fundingStepIndex, startBlockerSentence, type FlowAction } from "../../money/moneyFlow";
import { TermsLink } from "../InfoPages";
import type { MoneyServices } from "../../money/moneySession";
import { moneyServices } from "../../money/moneySession";
import { formatMoneyTime } from "../../money/moneyTime";
import { useMoneyTable, type MoneyActionKind } from "../../money/useMoneyTable";
import { KeplrMark } from "./KeplrMark";
import { SAME_WALLET_SENTENCE, SAME_WALLET_SWITCH_HINT, SAME_WALLET_TITLE } from "../../money/sameWalletAck";
import { buttonStyle, moneyStyles as styles } from "./moneyStyles";
import { CLOCK_OPS, NO_DEADLINE_DISCLOSURE, type RoomClockView } from "../../utils/clockProtocol";
import { deadlineLabel } from "../../utils/gameClockView";
import { roomOp } from "../../utils/roomLink";

export interface MoneyPanelProps {
  room: RoomView;
  /** The room's own Start (`room-op start-game`). */
  onStart: () => void;
  /** A room op is in flight. */
  busy?: boolean;
  port?: SessionPort;
  services?: MoneyServices;
}

/** Basis points as a percentage, in integers only ("100" -> "1%", "250" -> "2.5%"). */
export function bpsText(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) return "";
  const whole = Math.floor(bps / 100);
  const part = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return `${whole}${part === "" ? "" : `.${part}`}%`;
}

/** The one line every seat (and a watcher) reads first: what kind of table this is. */
export function StakeStrip({ money, now }: { money: RoomMoneyView; now?: number }): JSX.Element {
  const fee = money.terms.feeBps === null ? null : `${bpsText(money.terms.feeBps)} fee`;
  const network = money.deployment.networkClass === "testnet" ? `Juno testnet (${money.deployment.chainId})` : money.deployment.networkClass === "local" ? `local Juno (${money.deployment.chainId})` : `Juno (${money.deployment.chainId})`;
  return (
    <p style={styles.strip} data-testid="money-stake-strip">
      <span style={styles.stakeTag}>Real {money.deployment.symbol} table</span>
      <span>{amountText(money, money.terms.anteGross)} per seat</span>
      <span>· {network}</span>
      {fee !== null ? <span>· {fee}</span> : null}
      <span>
        · {money.escrow.fundedSeats} of {money.terms.seats} funded
      </span>
      {money.escrow.fundingDeadline !== null ? <span>· funding closes {formatMoneyTime(money.escrow.fundingDeadline, { now })}</span> : null}
    </p>
  );
}

/** Phase 3 final clocks: a No-deadline table's disclosure, conspicuous BEFORE any ante -- the owner's words, verbatim --
 *  with this seat's acknowledgement (persisted by the server per player per table; no deposit is approved without it). */
export function NoDeadlineNotice({ gameId, clock, playerId, sendOp = roomOp }: { gameId: string; clock: RoomClockView | null | undefined; playerId: string | null; sendOp?: typeof roomOp }): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (clock === null || clock === undefined || clock.deadline !== "no-deadline" || playerId === null) return null;
  const acknowledged = clock.noDeadlineAcks.includes(playerId);
  if (acknowledged) {
    return (
      <p style={styles.faint} data-testid="no-deadline-acknowledged">
        You acknowledged: {NO_DEADLINE_DISCLOSURE}
      </p>
    );
  }
  return (
    <div role="alert" data-testid="no-deadline-notice" style={{ ...styles.confirm, borderColor: "#8a6a1c", backgroundColor: "rgba(138,106,28,0.14)" }}>
      <p style={{ ...styles.detail, fontWeight: 700 }} data-testid="no-deadline-disclosure">
        {NO_DEADLINE_DISCLOSURE}
      </p>
      <div style={styles.row}>
        <button
          type="button"
          className="wr-touch"
          style={buttonStyle("primary", busy)}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void sendOp({ type: CLOCK_OPS.ackNoDeadline }, gameId).then((answer) => {
              setBusy(false);
              if (!answer.ok) setError(answer.reason);
            });
          }}
          data-testid="no-deadline-ack"
        >
          I understand
        </button>
      </div>
      {error !== null ? (
        <p style={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The deposit's terms, in full, before "Approve in Keplr" (brief §14's list). */
function ReviewCard({ money, isHost, wallet, now, clock }: { money: RoomMoneyView; isHost: boolean; wallet: string | null; now: number; clock?: RoomClockView | null }): JSX.Element {
  const from = wallet === null ? "the wallet you deposit from" : shortWallet(wallet);
  const exponent = money.deployment.exponent;
  const symbol = money.deployment.symbol;
  const fmt = (base: string | null) => formatAmount(base, exponent, symbol);
  const feeBps = money.terms.feeBps;
  const net = money.terms.anteNet ?? (feeBps === null ? null : netOf(money.terms.anteGross, feeBps));
  const fee = feeBps === null ? null : feeOf(money.terms.anteGross, feeBps);
  const pot = money.terms.pot ?? (net === null ? null : (BigInt(net) * BigInt(money.terms.seats)).toString());
  const network = `${money.deployment.networkClass === "testnet" ? "Juno testnet" : money.deployment.networkClass === "local" ? "local Juno" : "Juno"} (${money.deployment.chainId})`;
  return (
    <div style={styles.review} role="group" aria-label="Deposit terms" data-testid="money-review">
      <p style={styles.reviewTitle}>{isHost ? "Open the table on Juno" : "Deposit to this table"}</p>
      <dl style={styles.terms}>
        <dt style={styles.termLabel}>You send</dt>
        <dd style={styles.termValue} data-testid="money-review-ante">
          {fmt(money.terms.anteGross)} from {from}
        </dd>
        <dt style={styles.termLabel}>Into the pot</dt>
        <dd style={styles.termValue}>{net === null ? "shown once the escrow is read" : fmt(net)}</dd>
        <dt style={styles.termLabel}>Escrow fee</dt>
        <dd style={styles.termValue} data-testid="money-review-fee">
          {fee === null ? "the escrow's fee (read from Juno)" : `${fmt(fee)} — not refunded`}
        </dd>
        <dt style={styles.termLabel}>Network fee</dt>
        <dd style={styles.termValue}>paid by you in {symbol}; Keplr shows it before you approve</dd>
        <dt style={styles.termLabel}>Pot when full</dt>
        <dd style={styles.termValue}>
          {pot === null ? "—" : fmt(pot)} ({money.terms.seats} seats)
        </dd>
        <dt style={styles.termLabel}>Network</dt>
        <dd style={styles.termValue}>{network}</dd>
        <dt style={styles.termLabel}>Escrow</dt>
        <dd style={styles.termValue}>
          <span style={styles.mono} data-testid="money-review-contract">
            {money.deployment.contract}
          </span>
        </dd>
        <dt style={styles.termLabel}>Winnings go to</dt>
        <dd style={styles.termValue}>{from} — the depositing wallet; it can't change once the game starts</dd>
        <dt style={styles.termLabel}>Deadline</dt>
        <dd style={styles.termValue} data-testid="money-review-deadline">
          {clock === null || clock === undefined ? (money.terms.mode === "live" ? "Live · 20:00 per action" : "—") : deadlineLabel(clock)}
        </dd>
        <dt style={styles.termLabel}>Funding closes</dt>
        <dd style={styles.termValue}>{money.escrow.fundingDeadline === null ? (isHost ? "set by Juno when you open the table" : "—") : formatMoneyTime(money.escrow.fundingDeadline, { now })}</dd>
      </dl>
      <p style={styles.faint}>Until the game starts you can withdraw your deposit (the fee isn't refunded). Once it starts, the deposit stays in escrow until the game ends.</p>
      <p style={styles.faint}>Deposits on Juno are public: anyone can see which wallet funded this table.</p>
    </div>
  );
}

type AskedKind = "withdraw" | "cancel-escrow" | "refund-after-deadline" | "liveness-settle" | "annul";

/** What a withdrawal, a cancel, a refund -- or, once started on Juno, an exit -- does, asked before anything is signed. */
function exitSentence(money: RoomMoneyView, kind: AskedKind): string {
  if (kind === "liveness-settle") return "Close the table on Juno and pay everyone from the last recorded standings? This can't be undone; the payout is then released after its own challenge window.";
  if (kind === "annul") return "Agree to cancel this game? It is annulled only if every player agrees; then every deposit comes back to its wallet, minus the fee.";
  const back = money.terms.anteNet === null ? "your deposit minus the fee" : amountText(money, money.terms.anteNet);
  const fee = money.terms.anteNet === null || money.terms.feeBps === null ? "the fee" : amountText(money, feeOf(money.terms.anteGross, money.terms.feeBps));
  const to = shortWallet(money.you?.payoutWallet ?? money.you?.unlinkedDeposit?.wallet ?? money.you?.link?.wallet ?? null);
  if (kind === "withdraw") return `You get ${back} back to ${to}; ${fee} isn't returned. Your seat stays until you give it up.`;
  if (kind === "cancel-escrow") return `Cancel the table on Juno? Everyone gets their deposit back minus the fee (${back} each), and the table closes.`;
  return `Funding has closed. Refund every deposit (${back} each, minus the fee)? Keplr sends it from ${to}.`;
}

/** P3-ACCT: the deposit's terms in one line, before the Ante press (the full card is one click away). */
function CompactTerms({ money, wallet, clock }: { money: RoomMoneyView; wallet: string | null; clock?: RoomClockView | null }): JSX.Element {
  const exponent = money.deployment.exponent;
  const symbol = money.deployment.symbol;
  const fmt = (base: string | null) => formatAmount(base, exponent, symbol);
  const feeBps = money.terms.feeBps;
  const fee = feeBps === null ? null : feeOf(money.terms.anteGross, feeBps);
  const net = money.terms.anteNet ?? (feeBps === null ? null : netOf(money.terms.anteGross, feeBps));
  const pot = money.terms.pot ?? (net === null ? null : (BigInt(net) * BigInt(money.terms.seats)).toString());
  return (
    <p style={styles.faint} data-testid="money-compact-terms">
      You send {fmt(money.terms.anteGross)}
      {fee !== null ? ` · escrow fee ${fmt(fee)} (not refunded)` : ""}
      {pot !== null ? ` · pot when full ${fmt(pot)}` : ""} · winnings go to {wallet === null ? "the wallet you deposit from" : shortWallet(wallet)}
      {/* Consolidated final integration (review): the deadline the escrow is funded under, beside the Ante, as in the full terms. */}
      {clock !== null && clock !== undefined ? ` · deadline ${deadlineLabel(clock)}` : money.terms.mode === "live" ? " · deadline Live · 20:00 per action" : ""} · Keplr shows the network fee. <TermsLink className="wr-touch" />
    </p>
  );
}

const CONFIRM_PURPOSE: Partial<Record<MoneyActionKind, string>> = {
  ante: "To use this wallet here",
  verify: "To use this wallet here",
  link: "To link a wallet to this table",
  relink: "To relink your deposit to your seat",
  "replace-link": "To replace this seat's wallet",
  "replace-confirmed": "To replace this seat's wallet",
  reprove: "To prove your wallet again for this table",
  approve: "To set up this device's signing key for your deposit",
  "move-signing-key": "To set up signing on this device",
};

/* W2-K (OD-14(i)): the waiting room's keyboard focus ring (`.wr-columns button:focus-visible`) reaches this panel's
   buttons; its disclosure and its explorer link get the same ring here, so every stop in the panel shows focus the
   same way. Scoped to the panel's own class. */
const MONEY_PANEL_CSS = `
.money-seat-panel summary:focus-visible,
.money-seat-panel a:focus-visible,
.money-seat-panel button:focus-visible { outline: 2px solid #8a8a86; outline-offset: 2px; }
`;

export function MoneyPanel({ room, onStart, busy = false, port, services }: MoneyPanelProps): JSX.Element | null {
  const money = room.money ?? null;
  const svc = services ?? moneyServices();
  const table = useMoneyTable({ gameId: room.gameId, view: money, variants: room.variants, isHost: room.you.role === "host", port, services: svc, onStart, clock: room.clock ?? null });
  const [asking, setAsking] = useState<AskedKind | null>(null);
  if (money === null || table.flow === null) return null;
  const flow = table.flow;
  const pinned = svc.pin();
  const stepIndex = fundingStepIndex(flow.step);
  const inFlight = table.busy !== null || busy;
  const press = (action: FlowAction) => {
    if (action.kind === "withdraw" || action.kind === "cancel-escrow" || action.kind === "refund-after-deadline" || action.kind === "liveness-settle" || action.kind === "annul") {
      setAsking(action.kind);
      return;
    }
    void table.run(action.kind);
  };
  const wallet = table.wallet.kind === "connected" ? table.wallet.address : (money.you?.link?.wallet ?? "");
  const pendingLink = table.pending !== null && pinned.ok ? explorerLink(pinned.pin, table.pending.txHash) : null;
  const tableLine = flow.stage === "funding" && flow.step !== "funded" ? startBlockerSentence(money, money.start.blocker, table.now) : null;

  return (
    <section className="money-seat-panel" style={styles.panel} aria-label="Your deposit" data-testid="money-panel">
      <style>{MONEY_PANEL_CSS}</style>
      <p style={styles.sectionLabel} aria-hidden="true">
        Your deposit
      </p>
      <StakeStrip money={money} now={table.now} />
      {flow.stage === "funding" || flow.stage === "starting" ? (
        <ol style={styles.steps} aria-label="Funding progress" data-testid="money-steps">
          {FUNDING_STEPS.map((step, index) => (
            <li key={step.key} style={index < stepIndex ? styles.stepDone : index === stepIndex ? styles.stepNow : styles.step} aria-current={index === stepIndex ? "step" : undefined}>
              {step.label}
            </li>
          ))}
        </ol>
      ) : null}
      <p style={styles.headline} data-testid="money-headline">
        {flow.headline}
      </p>
      {(table.busy === "ante" || table.busy === "verify") && table.progress !== null ? (
        <p style={styles.notice} role="status" aria-live="polite" data-testid="money-progress">
          {table.progress}
        </p>
      ) : null}
      {flow.detail ? (
        <p style={styles.detail} data-testid="money-detail">
          {flow.detail}
        </p>
      ) : null}
      {tableLine !== null && tableLine !== flow.detail ? <p style={styles.faint}>{tableLine}</p> : null}

      {table.needs !== null && table.needs.kind === "confirm" ? (
        <div data-testid="money-confirm">
          <ConfirmItsYou
            purpose={CONFIRM_PURPOSE[table.needs.then ?? "link"] ?? "To continue"}
            port={port}
            showOrigin
            testIdPrefix="money-reauth"
            onConfirmed={(expiresAt) => table.confirmed(expiresAt)}
            onCancel={table.cancelNeeds}
            cancelLabel="Not now"
          />
        </div>
      ) : null}
      {table.needs !== null && table.needs.kind === "replace" ? (
        <div style={styles.confirm} role="group" aria-label="Replace the linked wallet" data-testid="money-replace">
          {/* W2-M (AUD-20.03): asked BEFORE Keplr signs, so the replacement is one signature (or, when the server had
              to ask, one more -- and it says so). */}
          <p style={styles.detail} data-testid="money-replace-question">
            {table.needs.said !== null ? table.needs.said : `This seat is linked to ${table.needs.from === null ? "another wallet" : shortWallet(table.needs.from)}. Replace it with ${shortWallet(table.needs.to ?? wallet)}?`} The old link stops working; nothing is charged.{" "}
            {table.needs.to === null ? "Connect Keplr on the wallet you want, then link again." : table.needs.again ? "Keplr asks you to sign the link message once more." : "Keplr then asks you to sign one link message."}
          </p>
          <div style={styles.row}>
            {table.needs.to !== null ? (
              <button type="button" className="wr-touch" style={buttonStyle("primary", inFlight)} disabled={inFlight} onClick={() => void table.run("replace-confirmed")} data-testid="money-replace-confirm">
                Replace wallet
              </button>
            ) : null}
            <button type="button" className="wr-touch" style={buttonStyle("secondary", inFlight)} disabled={inFlight} onClick={table.cancelNeeds}>
              Keep the linked wallet
            </button>
          </div>
        </div>
      ) : null}
      {table.needs !== null && table.needs.kind === "same-wallet" ? (
        <div style={styles.confirm} role="group" aria-label="Authorization Wallet as this game's financial wallet" data-testid="money-same-wallet">
          {/* Owner ruling 2026-10-07: allowed, warned once per account and Authorization Wallet -- before that same
              address is first bound to a seat. Nothing was signed or linked; continuing runs the pressed action again
              with whatever wallet Keplr is on. */}
          <p style={styles.detail} role="status" aria-live="polite" data-testid="money-same-wallet-text">
            <strong>{SAME_WALLET_TITLE}.</strong> {SAME_WALLET_SENTENCE}
          </p>
          <p style={styles.faint} data-testid="money-same-wallet-wallets">
            Authorization Wallet: <span title={table.needs.wallet}>{shortWallet(table.needs.wallet)}</span> · This game&apos;s funds:{" "}
            <span title={table.needs.wallet}>{shortWallet(table.needs.wallet)}</span> — the same address. {SAME_WALLET_SWITCH_HINT}
          </p>
          <div style={styles.row}>
            <button type="button" className="wr-touch" style={buttonStyle("primary", inFlight)} disabled={inFlight} onClick={() => void table.acknowledgeSameWallet()} data-testid="money-same-wallet-continue">
              Continue with this wallet
            </button>
            <button type="button" className="wr-touch" style={buttonStyle("secondary", inFlight)} disabled={inFlight} onClick={table.cancelNeeds} data-testid="money-same-wallet-cancel">
              Not now
            </button>
          </div>
        </div>
      ) : null}

      {flow.stage === "funding" ? <NoDeadlineNotice gameId={room.gameId} clock={room.clock} playerId={room.you.playerId ?? null} /> : null}
      {table.reviewing && flow.step === "review" && money.you?.link ? <ReviewCard money={money} isHost={room.you.role === "host"} wallet={money.you.link.wallet} now={table.now} clock={room.clock ?? null} /> : null}
      {/* P3-ACCT: before the Ante press, the terms are on the panel -- one line, the full card a click away. */}
      {(flow.primary?.kind === "ante" || flow.primary?.kind === "verify") && !table.reviewing ? (
        <>
          <CompactTerms money={money} wallet={money.you?.link?.wallet ?? (table.wallet.kind === "connected" ? table.wallet.address : null)} clock={room.clock ?? null} />
          <details data-testid="money-full-terms">
            <summary style={styles.disclosure}>Full deposit terms</summary>
            <ReviewCard money={money} isHost={room.you.role === "host"} wallet={money.you?.link?.wallet ?? (table.wallet.kind === "connected" ? table.wallet.address : null)} now={table.now} clock={room.clock ?? null} />
          </details>
        </>
      ) : null}

      {asking !== null ? (
        <div style={styles.confirm} role="group" aria-label="Confirm" data-testid="money-exit-confirm">
          <p style={styles.detail}>{exitSentence(money, asking)}</p>
          <div style={styles.row}>
            <button
              type="button"
              className="wr-touch"
              style={buttonStyle(asking === "cancel-escrow" ? "danger" : "primary", inFlight)}
              disabled={inFlight}
              onClick={() => {
                const kind = asking;
                setAsking(null);
                void table.run(kind);
              }}
              data-testid="money-exit-continue"
            >
              {asking === "annul" ? "Sign my agreement" : "Continue in Keplr"}
            </button>
            <button type="button" className="wr-touch" style={buttonStyle("secondary", false)} onClick={() => setAsking(null)}>
              Keep it
            </button>
          </div>
        </div>
      ) : null}

      {(flow.primary !== null || flow.others.length > 0) && asking === null ? (
        <div style={styles.row}>
          {flow.primary !== null ? (
            <button
              type="button"
              className="wr-touch"
              style={buttonStyle("primary", inFlight || flow.blocker !== null)}
              disabled={inFlight || flow.blocker !== null}
              title={flow.primary.title}
              onClick={() => press(flow.primary as FlowAction)}
              data-testid={`money-action-${flow.primary.kind}`}
            >
              {flow.primary.kind === "connect" ? <KeplrMark /> : null}
              {(table.busy === "ante" || table.busy === "verify") && table.busy === flow.primary.kind ? (table.progress ?? `${flow.primary.label}…`) : table.busy === flow.primary.kind ? `${flow.primary.label}…` : flow.primary.label}
            </button>
          ) : null}
          {table.reviewing && flow.step === "review" ? (
            <button type="button" className="wr-touch" style={buttonStyle("secondary", inFlight)} disabled={inFlight} onClick={table.closeReview} data-testid="money-review-close">
              Not now
            </button>
          ) : null}
          {flow.others.map((action) => (
            <button key={action.kind} type="button" className="wr-touch" style={buttonStyle(action.tone, inFlight)} disabled={inFlight} title={action.title} onClick={() => press(action)} data-testid={`money-action-${action.kind}`}>
              {table.busy === action.kind ? `${action.label}…` : action.label}
            </button>
          ))}
        </div>
      ) : null}

      {flow.blocker !== null ? (
        <p style={styles.blocker} data-testid="money-blocker">
          {flow.blocker}
        </p>
      ) : null}
      {table.error !== null ? (
        <p style={styles.error} role="alert" data-testid="money-error">
          {table.error}
        </p>
      ) : null}
      {table.notice !== null ? (
        <p style={styles.notice} role="status" data-testid="money-notice">
          {table.notice}
        </p>
      ) : null}
      {table.pending !== null ? (
        <p style={styles.faint} data-testid="money-pending">
          {table.pending.stage === "signed" ? "This browser signed (and may not have sent) transaction " : table.pending.stage === "landed" ? "Juno included transaction " : "This browser sent transaction "}
          <span style={styles.mono}>{table.pending.txHash.slice(0, 12)}…</span>
          {pendingLink !== null ? (
            <>
              {" "}
              (
              <a href={pendingLink} target="_blank" rel="noreferrer noopener" style={{ color: "#9ec5ff" }}>
                see it on the explorer
              </a>
              )
            </>
          ) : null}
          . Juno decides whether it counts; the panel follows.
        </p>
      ) : null}

      <details data-testid="money-details">
        <summary style={styles.disclosure}>Escrow details</summary>
        <dl style={{ ...styles.terms, ...styles.disclosureBody }}>
          <dt style={styles.termLabel}>Network</dt>
          <dd style={styles.termValue}>{money.deployment.chainId}</dd>
          <dt style={styles.termLabel}>Contract</dt>
          <dd style={styles.termValue}>
            <span style={styles.mono}>{money.deployment.contract}</span>
          </dd>
          <dt style={styles.termLabel}>Code checksum</dt>
          <dd style={styles.termValue}>
            <span style={styles.mono}>{money.deployment.codeChecksum}</span>
          </dd>
          <dt style={styles.termLabel}>Escrow game</dt>
          <dd style={styles.termValue}>{money.escrow.chainGameId ?? "not open yet"}</dd>
          {money.you?.payoutWallet ? (
            <>
              <dt style={styles.termLabel}>Your payout wallet</dt>
              <dd style={styles.termValue}>
                <span style={styles.mono}>{money.you.payoutWallet}</span>
              </dd>
            </>
          ) : null}
          {money.you?.chainConsentKey ? (
            <>
              <dt style={styles.termLabel}>Signing key</dt>
              <dd style={styles.termValue} data-testid="money-signing-key">
                {table.holdsChainKey ? "on this device" : "on another device (you can still play and be paid; approving early is done there)"}
              </dd>
            </>
          ) : null}
        </dl>
        <p style={styles.faint}>
          This page checks every table against the escrow it was built for ({pinned.ok ? `${pinned.pin.chainId} · ${shortWallet(pinned.pin.contract)}` : "none in this build"}) before Keplr signs anything, and
          never signs a transaction the server made.
        </p>
      </details>
    </section>
  );
}

export default MoneyPanel;
