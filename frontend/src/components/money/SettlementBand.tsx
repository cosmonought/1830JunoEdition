// frontend/src/components/money/SettlementBand.tsx
//
// ==================================================================
//  ESCROW-4 (brief §20-21): THE FINANCIAL BAND UNDER THE RESULT, AND THE MONEY LINE IN THE TABLE'S BAR
// ==================================================================
//
// THE GAME RESULT IS FINAL BEFORE ANY OF THIS COMPLETES. The band never says the result is pending and never makes
// Game Over wait for Juno: it says where the MONEY is -- preparing, submitted, recorded (released at a time unless
// disputed), release available, paid, disputed, held, paused, annulled, refunded -- and offers only what the server
// says this seat may do now: approve the payout early (on the device holding the seat's signing key, after this
// device checked the recorded payout against its own copy of the game), dispute it (the bond attached), release it
// once the window has closed, close a stalled table through Juno's inactivity exit, agree to annul, or move signing
// to this device. Each wallet action is asked once more, with its consequence, before Keplr opens.
//
// Checkpoints are the server's (signed every round automatically): the band shows the last one, never a control that
// implies a player picks them. Nothing here says closing the browser forfeits or refunds anything -- it doesn't.

import React, { useState } from "react";

import type { GameStateResponse } from "../../gameEngine/gameState";
import type { HashableLogEntry } from "../../gameEngine/logHash";
import { formatAmount, shortWallet } from "../../utils/moneyProtocol";
import type { RoomView } from "../../utils/roomProtocol";
import type { SessionPort } from "../../utils/sessionBootstrap";
import { ConfirmItsYou } from "../ConfirmItsYou";
import type { SettlementActionKind } from "../../money/moneyFlow";
import type { MoneyServices } from "../../money/moneySession";
import { formatMoneyTime } from "../../money/moneyTime";
import { useMoneyTable } from "../../money/useMoneyTable";
import { buttonStyle, moneyStyles as styles } from "./moneyStyles";

export interface SettlementBandProps {
  room: RoomView;
  /** This device's log and board, for its own check of the recorded payout. */
  log?: readonly HashableLogEntry[] | null;
  board?: GameStateResponse | null;
  /** The table bar's one-line form (in game), rather than the result's band. */
  compact?: boolean;
  port?: SessionPort;
  services?: MoneyServices;
}

export function SettlementBand({ room, log = null, board = null, compact = false, port, services }: SettlementBandProps): JSX.Element | null {
  const money = room.money ?? null;
  const table = useMoneyTable({ gameId: room.gameId, view: money, variants: room.variants, isHost: room.you.role === "host", log, board, port, services });
  const [asking, setAsking] = useState<SettlementActionKind | null>(null);
  if (money === null || table.settlement === null || money.you === null) {
    return money === null || compact ? null : (
      <div style={styles.band} data-testid="settlement-band">
        <p style={styles.bandTitle}>Real-money table</p>
        <p style={styles.detail}>You watched this table; its payouts go to the seated players' wallets on Juno.</p>
      </div>
    );
  }
  const band = table.settlement;
  const s = money.settlement;
  const fmt = (base: string | null) => formatAmount(base, money.deployment.exponent, money.deployment.symbol);
  const seat = money.you.chainSeatIndex;
  const preview = table.verification?.payouts ?? null;
  const yourPreview = preview !== null && seat !== null ? (preview[seat] ?? null) : null;
  const inFlight = table.busy !== null;
  const consequence = (kind: SettlementActionKind): string => {
    switch (kind) {
      case "challenge":
        return `Dispute the payout recorded on Juno? Keplr attaches the ${fmt(s?.bond ?? null)} bond. The resolver decides by ${formatMoneyTime(s?.resolverTimeoutAt ?? null, { now: table.now }) || "its deadline"}; if the dispute fails, the bond joins the pool.`;
      case "liveness-settle":
        return "Close the table on Juno and pay everyone from the last recorded standings? This can't be undone; the payout is then released after its own challenge window.";
      case "annul":
        return "Agree to cancel this game? It is annulled only if every player agrees; then every deposit comes back to its wallet, minus the fee.";
      case "release-payout":
        return "Release the payout recorded on Juno to every seat's wallet? Keplr pays the network fee.";
      case "move-signing-key":
        return "Make a signing key on this device and move your seat's key to it on Juno (Keplr approves the change)? The key on your other device stops counting, and an approval already given with it no longer counts.";
      default:
        return "";
    }
  };
  const press = (kind: SettlementActionKind) => {
    if (kind === "approve-payout") {
      void table.run(kind);
      return;
    }
    setAsking(kind);
  };

  if (compact) {
    /* The table bar shows only what needs this player now -- not a standing "cancel this game" or key move all game. */
    const urgent = band.actions.filter(
      (action) =>
        action.kind === "approve-payout" ||
        action.kind === "release-payout" ||
        action.kind === "liveness-settle" ||
        (action.kind === "challenge" && table.verification?.result === "mismatch") ||
        (action.kind === "annul" && (s?.annulSigned.length ?? 0) > 0) ||
        (action.kind === "move-signing-key" && s?.status === "recorded"),
    );
    const action = urgent[0] ?? null;
    return (
      <span style={styles.strip} data-testid="money-strip">
        <span style={styles.stakeTag}>
          {fmt(money.terms.anteGross)} table
        </span>
        <span>{band.headline}</span>
        {action !== null ? (
          <button type="button" style={styles.quiet} disabled={inFlight} onClick={() => press(action.kind)} title={action.title} data-testid={`money-strip-${action.kind}`}>
            {action.label}
          </button>
        ) : null}
        {asking !== null ? (
          <span style={styles.strip}>
            <span>{consequence(asking)}</span>
            <button
              type="button"
              style={styles.quiet}
              disabled={inFlight}
              onClick={() => {
                const kind = asking;
                setAsking(null);
                void table.run(kind);
              }}
            >
              {asking === "annul" ? "Sign my agreement" : "Continue in Keplr"}
            </button>
            <button type="button" style={styles.quiet} onClick={() => setAsking(null)}>
              Keep
            </button>
          </span>
        ) : null}
        {table.error !== null ? <span style={styles.error}>{table.error}</span> : null}
        {table.notice !== null ? <span style={styles.notice}>{table.notice}</span> : null}
        {table.needs !== null && table.needs.kind === "confirm" ? (
          <ConfirmItsYou purpose="To set up signing on this device" port={port} showOrigin testIdPrefix="money-strip-reauth" onConfirmed={(expiresAt) => table.confirmed(expiresAt)} onCancel={table.cancelNeeds} cancelLabel="Not now" />
        ) : null}
      </span>
    );
  }

  return (
    <section style={styles.band} aria-label="Financial settlement" data-testid="settlement-band">
      <p style={styles.bandTitle}>Financial settlement · {money.deployment.chainId}</p>
      <p style={styles.headline} data-testid="settlement-headline">
        {band.headline}
      </p>
      {band.detail ? <p style={styles.detail}>{band.detail}</p> : null}
      {band.paid === null && yourPreview !== null ? (
        <p style={styles.detail} data-testid="settlement-preview">
          Your payout as recorded: <strong>{fmt(yourPreview)}</strong> of the {fmt(money.terms.pot)} pot, to {shortWallet(money.you.payoutWallet)}.
        </p>
      ) : null}
      {table.verification !== null && table.verification.result !== "match" && s?.status === "recorded" ? <p style={styles.faint}>{table.verification.detail}</p> : null}
      {s?.lastCheckpoint ? <p style={styles.faint}>Standings last recorded on Juno at {s.lastCheckpoint.roundKey}.</p> : null}

      {asking !== null ? (
        <div style={styles.confirm} role="group" aria-label="Confirm" data-testid="settlement-confirm">
          <p style={styles.detail}>{consequence(asking)}</p>
          <div style={styles.row}>
            <button
              type="button"
              style={buttonStyle(asking === "challenge" ? "danger" : "primary", inFlight)}
              disabled={inFlight}
              onClick={() => {
                const kind = asking;
                setAsking(null);
                void table.run(kind);
              }}
              data-testid="settlement-continue"
            >
              {asking === "annul" ? "Sign my agreement" : "Continue in Keplr"}
            </button>
            <button type="button" style={buttonStyle("secondary", false)} onClick={() => setAsking(null)}>
              Keep it
            </button>
          </div>
        </div>
      ) : band.actions.length > 0 ? (
        <div style={styles.row}>
          {band.actions.map((action) => (
            <button key={action.kind} type="button" style={buttonStyle(action.tone, inFlight)} disabled={inFlight} title={action.title} onClick={() => press(action.kind)} data-testid={`settlement-action-${action.kind}`}>
              {table.busy === action.kind ? `${action.label}…` : action.label}
            </button>
          ))}
        </div>
      ) : null}
      {table.needs !== null && table.needs.kind === "confirm" ? (
        <ConfirmItsYou purpose="To set up signing on this device" port={port} showOrigin testIdPrefix="settlement-reauth" onConfirmed={(expiresAt) => table.confirmed(expiresAt)} onCancel={table.cancelNeeds} cancelLabel="Not now" />
      ) : null}
      {table.error !== null ? (
        <p style={styles.error} role="alert" data-testid="settlement-error">
          {table.error}
        </p>
      ) : null}
      {table.notice !== null ? (
        <p style={styles.notice} role="status">
          {table.notice}
        </p>
      ) : null}
    </section>
  );
}

export default SettlementBand;
