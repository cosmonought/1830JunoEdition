// frontend/src/components/GameClockChip.tsx
//
/* ==================================================================
    PHASE 3 FINAL CLOCKS: THE TABLE CLOCK IN THE ROOM STRIP
   ==================================================================
   One chip beside the strip's other standing facts -- the deadline (Live / Async pace / No deadline), who owes the next
   required decision and the server's one figure -- and, on demand, a small panel with what the state means and the
   controls a seat may use now: ask for (and agree to) a unanimous pause or resume; agree to resume after a SYSTEM pause;
   while a player is overdue, propose or vote on the N-1 remedy (a money table's YES is the seat's own REMEDY-APPROVE,
   signed on this device); and a free table's unanimous "Annul game" (a money table annuls through its escrow, in the
   money panel). Every one of them is decided by the server; this component only asks.

   THE SERVER IS THE CLOCK (`gameClockView.ts`): the chip counts on from the server's view by the MONOTONIC time since
   it arrived, and shows no figure while this tab is not current (its room link down, its board not the room's, a
   catch-up running). No modal, no sound, no flashing; the figure is a `timer` (not announced every tick). */

import React, { useEffect, useMemo, useState } from "react";

import { styles } from "../styles/appStyles";
import { CLOCK_OPS, type RoomClockView } from "../utils/clockProtocol";
import { presentClock, type ClockTone } from "../utils/gameClockView";
import { roomOp, roomViewReceivedAt, watchRoomLink } from "../utils/roomLink";
import type { RoomOpBody, RoomViewPlayer } from "../utils/roomProtocol";

/** A money table's YES: the seat's REMEDY-APPROVE for the standing overdue instance (`moneyActions.signRemedyApproval`). */
export type ClockApprovalSigner = (input: {
  readonly remedy: 2 | 4 | 5;
  readonly overdue: Pick<NonNullable<RoomClockView["overdue"]>, "seat" | "strike" | "epoch" | "overdueAt" | "logLen" | "logHash">;
  readonly live: boolean;
  /** The server's time as this tab last saw it, carried on by monotonic time (an Async horizon is counted from it). */
  readonly serverNowMs?: number;
}) => Promise<{ readonly ok: true; readonly approveUntil: number; readonly signature: string } | { readonly ok: false; readonly reason: string }>;

export interface GameClockChipProps {
  gameId: string;
  clock: RoomClockView | undefined | null;
  players: readonly RoomViewPlayer[];
  viewerPlayerId: string | null;
  /** This tab's own currency: no connection notice standing, the board the room's, no catch-up, not held. */
  current: boolean;
  /** Money tables: signs this seat's REMEDY-APPROVE (absent: a money YES cannot be given from here). */
  signApproval?: ClockApprovalSigner;
  /** TESTS: a monotonic clock (`performance.now` when absent). */
  monotonic?: () => number;
  /** TESTS: the op sender (`roomOp` when absent). */
  sendOp?: typeof roomOp;
  /** TESTS: the room-link watcher (`watchRoomLink` when absent). */
  watchLink?: typeof watchRoomLink;
  /** TESTS: when the newest room view arrived, on the `monotonic` clock (`roomViewReceivedAt` when absent). */
  receivedAtOf?: (gameId: string) => number | null;
}

const TONE_STYLE: Record<ClockTone, React.CSSProperties> = {
  normal: { borderColor: "#3a3a3a", color: "#d8d5ce" },
  warning: { borderColor: "#6b5a24", color: "#d9b95c" },
  overdue: { borderColor: "#8a3a30", color: "#f3b1a6", fontWeight: 700 },
  paused: { borderColor: "#34506b", color: "#a9c8e8" },
  muted: { borderColor: "#2a2a2a", color: "#8a8780" },
  ended: { borderColor: "#3a3a3a", color: "#b8b5ae" },
};

const chipStyle: React.CSSProperties = {
  ...styles.forcedSignChip,
  cursor: "default",
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  fontVariantNumeric: "tabular-nums",
  position: "relative",
};

const modeStyle: React.CSSProperties = { opacity: 0.75, fontWeight: 700 };

const buttonStyle: React.CSSProperties = {
  font: "inherit",
  fontSize: "inherit",
  fontWeight: 700,
  padding: "2px 8px",
  borderRadius: "999px",
  border: "1px solid #3a3a3a",
  backgroundColor: "#1c1c1c",
  color: "#d8d5ce",
  cursor: "pointer",
};

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  left: 0,
  zIndex: 30,
  minWidth: "260px",
  maxWidth: "360px",
  padding: "10px 12px",
  borderRadius: "8px",
  border: "1px solid #3a3a3a",
  backgroundColor: "#151515",
  color: "#d8d5ce",
  boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
  fontWeight: 400,
  whiteSpace: "normal",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const warningStyle: React.CSSProperties = { color: "#f3b1a6", fontWeight: 700, border: "1px solid #8a3a30", borderRadius: "6px", padding: "4px 6px" };
const rowStyle: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: "6px" };

const defaultMonotonic = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());

export function GameClockChip({ gameId, clock, players, viewerPlayerId, current, signApproval, monotonic = defaultMonotonic, sendOp = roomOp, watchLink = watchRoomLink, receivedAtOf = roomViewReceivedAt }: GameClockChipProps) {
  /* When this view of the clock ARRIVED (monotonic): the room link's receipt time of the frame that carried it. */
  const arrivedAt = () => receivedAtOf(gameId) ?? monotonic();
  const [seen, setSeen] = useState<{ clock: RoomClockView | undefined | null; at: number }>(() => ({ clock, at: arrivedAt() }));
  if (seen.clock !== clock) setSeen({ clock, at: arrivedAt() });
  const receivedAt = seen.clock === clock ? seen.at : arrivedAt();
  const [, setTick] = useState(0);
  const [linkOpen, setLinkOpen] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  /* A money table's signature is asked for only after the player confirms what it approves. */
  const [confirming, setConfirming] = useState<{ readonly kind: "foreclose" | "annul"; readonly proposalId: number | null } | { readonly kind: "reapprove"; readonly remedy: 4 | 5 } | null>(null);

  useEffect(() => watchLink(gameId, setLinkOpen), [gameId, watchLink]);

  const nameOf = useMemo(() => {
    const names = new Map(players.map((player) => [player.id, player.nickname] as const));
    return (playerId: string) => names.get(playerId) ?? "Another player";
  }, [players]);

  const presentation = presentClock({ clock, sinceReceiptMs: monotonic() - receivedAt, current: current && linkOpen, viewerPlayerId, nameOf });

  /* Re-render once a second while the figure moves; nothing runs while it does not. */
  useEffect(() => {
    if (!presentation.ticking) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [presentation.ticking]);

  /* A refusal is about the clock STATE it was sent against: a change of that state retires it (a heartbeat's new
     revision does not). */
  const stateKey = clock === null || clock === undefined ? "" : [clock.state, clock.responsible?.seat ?? "", clock.overdue?.epoch ?? "", clock.overdue?.proposal?.id ?? "", clock.pause.request?.id ?? "", clock.system?.since ?? "", clock.remedy?.status ?? ""].join("|");
  useEffect(() => {
    setRefusal(null);
    setConfirming(null);
  }, [stateKey]);

  if (!presentation.visible || clock === undefined || clock === null) return null;
  const controls = presentation.controls;

  const send = (op: RoomOpBody) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    void sendOp(op, gameId).then((answer) => {
      setBusy(false);
      if (!answer.ok) setRefusal(answer.reason);
    });
  };

  const serverNowMs = () => Math.round(clock.serverNow + Math.max(0, monotonic() - receivedAt));
  const signFailed = (error: unknown) => {
    setBusy(false);
    setRefusal(`Nothing was signed: ${error instanceof Error ? error.message : "the signing step failed"}.`);
  };

  /* A money table's YES carries this seat's REMEDY-APPROVE (signed here, verified by the server and the chain) -- only
     after the player confirmed it. A free table's YES is sent at once. */
  const yes = (kind: "foreclose" | "annul", proposalId: number | null, confirmed = false) => {
    if (busy) return;
    if (clock.money && !confirmed) {
      setConfirming({ kind, proposalId });
      return;
    }
    setConfirming(null);
    const remedyOf = (k: "foreclose" | "annul"): 2 | 4 | 5 => (clock.deadline === "live" ? 2 : k === "foreclose" ? 5 : 4);
    const body = (approval: { approveUntil: number; signature: string } | null): RoomOpBody =>
      proposalId === null
        ? { type: CLOCK_OPS.propose, kind, ...(approval !== null ? approval : {}) }
        : { type: CLOCK_OPS.vote, proposalId, yes: true, ...(approval !== null ? approval : {}) };
    if (!clock.money) return send(body(null));
    const overdue = clock.overdue;
    if (signApproval === undefined || overdue === null) {
      setRefusal("This device can't sign the approval a table with stakes needs. Open the table's money panel on the device that holds your seat's key.");
      return;
    }
    setBusy(true);
    setRefusal(null);
    void signApproval({ remedy: remedyOf(kind), overdue, live: clock.deadline === "live", serverNowMs: serverNowMs() })
      .then((signed) => {
        setBusy(false);
        if (!signed.ok) {
          setRefusal(signed.reason);
          return;
        }
        send(body({ approveUntil: signed.approveUntil, signature: signed.signature }));
      })
      .catch(signFailed);
  };

  /* An Async N-1 outcome whose approval by this seat must be renewed: the SAME decision, signed again here. */
  const approveAgain = (remedy: 4 | 5, confirmed = false) => {
    if (busy) return;
    if (!confirmed) {
      setConfirming({ kind: "reapprove", remedy });
      return;
    }
    setConfirming(null);
    const facts = clock.remedy?.overdue ?? null;
    if (signApproval === undefined || facts === null) {
      setRefusal("This device can't sign the approval a table with stakes needs. Open the table's money panel on the device that holds your seat's key.");
      return;
    }
    setBusy(true);
    setRefusal(null);
    void signApproval({ remedy, overdue: facts, live: false, serverNowMs: serverNowMs() })
      .then((signed) => {
        setBusy(false);
        if (!signed.ok) {
          setRefusal(signed.reason);
          return;
        }
        send({ type: CLOCK_OPS.reapprove, approveUntil: signed.approveUntil, signature: signed.signature });
      })
      .catch(signFailed);
  };

  /* What the confirmation says the signature approves (the defaulting player, the outcome, its effect). */
  const confirmText = (() => {
    if (confirming === null) return null;
    const seat = confirming.kind === "reapprove" ? (clock.remedy?.overdue.seat ?? null) : (clock.overdue?.seat ?? null);
    const who = seat === null ? "the overdue player" : nameOf(seat);
    const outcome =
      confirming.kind === "reapprove"
        ? confirming.remedy === 5
          ? `foreclosure against ${who}`
          : `a neutral annulment of this game (${who} overdue)`
        : confirming.kind === "foreclose"
          ? `foreclosure against ${who}`
          : `a neutral annulment of this game (${who} overdue)`;
    const effect =
      (confirming.kind === "foreclose" || (confirming.kind === "reapprove" && confirming.remedy === 5))
        ? "Juno then splits the escrow by its foreclosure rule."
        : "Juno then returns every player's own stake (minus the fee).";
    return `Sign your approval of ${outcome} with this device's seat key? ${effect}`;
  })();

  const hasControls =
    controls.requestPause ||
    controls.requestResume ||
    controls.answerRequest !== null ||
    controls.systemResume ||
    controls.propose.length > 0 ||
    controls.vote !== null ||
    controls.annul !== null ||
    controls.reapprove !== null;
  const detail = [presentation.warning, ...presentation.lines, refusal].filter((line): line is string => line !== null && line !== "");
  const title = detail.join(" ") || undefined;

  return (
    <span style={{ ...chipStyle, ...TONE_STYLE[presentation.tone] }} title={open ? undefined : title} data-testid="game-clock" data-state={presentation.state} data-deadline={clock.deadline}>
      <span style={modeStyle} data-testid="game-clock-mode">
        {presentation.modeLabel}
      </span>
      <span aria-hidden="true">·</span>
      <span data-testid="game-clock-label">{presentation.label}</span>
      {presentation.value !== null && (
        <span role="timer" aria-label={`${presentation.label}: ${presentation.value}`} data-testid="game-clock-value">
          {presentation.value}
        </span>
      )}
      {presentation.warning !== null && (
        <span aria-hidden="true" style={{ color: "#f3b1a6" }} data-testid="game-clock-warning-mark">
          !
        </span>
      )}
      {presentation.banner !== null && (
        <span role={presentation.warning !== null ? "alert" : "status"} style={presentation.warning !== null ? { color: "#f3b1a6", fontWeight: 700 } : { fontWeight: 600 }} data-testid="game-clock-banner">
          {presentation.banner}
        </span>
      )}
      {(detail.length > 0 || hasControls) && (
        <button type="button" style={{ ...buttonStyle, padding: "0 6px" }} aria-expanded={open} aria-label="Clock details" onClick={() => setOpen((value) => !value)} data-testid="game-clock-toggle">
          {open ? "▴" : "▾"}
        </button>
      )}
      {open && (
        <span style={panelStyle} role="group" aria-label="Game clock" data-testid="game-clock-panel">
          {presentation.warning !== null && (
            <span style={warningStyle} role="alert" data-testid="game-clock-warning">
              {presentation.warning}
            </span>
          )}
          {presentation.lines.map((line, index) => (
            <span key={index} data-testid="game-clock-line">
              {line}
            </span>
          ))}
          <span style={rowStyle}>
            {controls.requestPause && (
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => send({ type: CLOCK_OPS.pause, action: "request", kind: "pause" })} data-testid="game-clock-request-pause" title="Every player must agree before the clock stops">
                Ask to pause
              </button>
            )}
            {controls.requestResume && (
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => send({ type: CLOCK_OPS.pause, action: "request", kind: "resume" })} data-testid="game-clock-request-resume">
                Ask to resume
              </button>
            )}
            {controls.answerRequest !== null && (
              <>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => send({ type: CLOCK_OPS.pause, action: "yes", kind: controls.answerRequest!.kind, id: controls.answerRequest!.id })} data-testid="game-clock-agree">
                  Agree to {controls.answerRequest.kind}
                </button>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => send({ type: CLOCK_OPS.pause, action: "no", kind: controls.answerRequest!.kind, id: controls.answerRequest!.id })} data-testid="game-clock-decline">
                  Don't {controls.answerRequest.kind}
                </button>
              </>
            )}
            {controls.systemResume && (
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => clock.system !== null && send({ type: CLOCK_OPS.systemResume, since: clock.system.since })} data-testid="game-clock-system-resume">
                Agree to resume
              </button>
            )}
            {controls.reapprove !== null && (
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => approveAgain(controls.reapprove!.remedy)} data-testid="game-clock-reapprove">
                Approve again
              </button>
            )}
            {confirmText !== null && confirming !== null && (
              <span style={{ display: "flex", flexDirection: "column", gap: "4px" }} role="group" aria-label="Confirm your approval" data-testid="game-clock-confirm">
                <span data-testid="game-clock-confirm-text">{confirmText}</span>
                <span style={rowStyle}>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={busy}
                    onClick={() => (confirming.kind === "reapprove" ? approveAgain(confirming.remedy, true) : yes(confirming.kind, confirming.proposalId, true))}
                    data-testid="game-clock-confirm-sign"
                  >
                    Sign and send
                  </button>
                  <button type="button" style={buttonStyle} disabled={busy} onClick={() => setConfirming(null)} data-testid="game-clock-confirm-cancel">
                    Cancel
                  </button>
                </span>
              </span>
            )}
            {controls.propose.map((kind) => (
              <button key={kind} type="button" style={buttonStyle} disabled={busy} onClick={() => yes(kind, null)} data-testid={`game-clock-propose-${kind}`}>
                {kind === "foreclose" ? "Propose foreclosure" : "Propose neutral annulment"}
              </button>
            ))}
            {controls.vote !== null && controls.vote.mine !== "yes" && (
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => yes(controls.vote!.kind, controls.vote!.id)} data-testid="game-clock-vote-yes">
                Agree ({controls.vote.kind === "foreclose" ? "foreclosure" : "annulment"})
              </button>
            )}
            {controls.vote !== null && (
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => send({ type: CLOCK_OPS.vote, proposalId: controls.vote!.id, yes: false })} data-testid="game-clock-vote-no">
                {controls.vote.mine === "yes" ? "Withdraw and veto (cancels it for everyone)" : "Veto (cancels it for everyone)"}
              </button>
            )}
            {controls.annul !== null && (
              <button
                type="button"
                style={buttonStyle}
                disabled={busy}
                onClick={() => send({ type: CLOCK_OPS.annul, yes: !controls.annul!.mine })}
                title="Ends the game for everyone, with no winner -- only if every player agrees"
                data-testid="game-clock-annul"
              >
                {controls.annul.mine ? `Withdraw "Annul game" (${controls.annul.count} of ${controls.annul.needed})` : `Annul game (${controls.annul.count} of ${controls.annul.needed} agree)`}
              </button>
            )}
          </span>
          {refusal !== null && (
            <span role="status" style={{ color: "#f0b0a8" }} data-testid="game-clock-refusal">
              {refusal}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export default GameClockChip;
