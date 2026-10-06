// frontend/src/components/ReportPlayerControl.tsx
//
// ==================================================================
//  PHASE 3 (P3-N032): "REPORT A PLAYER" -- FROM THE TABLE, FOR A SEATED PLAYER ONLY
// ==================================================================
//
// A small control in the table's strip (beside the host's own controls) that opens one dialog: which player, what kind
// of conduct, and -- optionally -- a sentence or two. The report goes to the operator's review; it is not an accusation
// the game acts on, and the dialog says so in plain words before anything is sent:
//
//   - it does not change the game, any money, or anyone's profile or trust facts;
//   - the other player is not told, and nobody at the table sees it;
//   - the reviewer reads the game's own record (moves, offers, timing, chat), so nothing has to be pasted or captured.
//
// WHO SEES THE CONTROL: a signed-in player holding a seat at this table (the room view's `you.playerId`), on a table
// with at least one other seat. A watcher, a visitor, a Watch tab and a sandbox see nothing (the server refuses them
// anyway: `roomAuthz` "report", and a visitor's socket never carries the frame). The wording is neutral and factual
// (`conductReport.ts`), the note is short on purpose (the counter shows the bound; a longer note is refused, never cut),
// and a second report of the same player for the same thing is answered "already received" -- never a second case.

import React, { useId, useState } from "react";

import { NativeModal } from "./NativeModal";
import { disabledLook, profileStyles as styles } from "./profileStyles";
import type { RoomOpResult, RoomView } from "../utils/roomProtocol";
import { CONDUCT_CATEGORY_HINTS, CONDUCT_CATEGORY_LABELS, CONDUCT_CATEGORY_ORDER, MAX_REPORT_NOTE_LENGTH, checkConductNote, type ConductReportCategory } from "../utils/conductReport";
import { reportOutcomeOf, reportPlayerOp, type ReportOutcome, type ReportPlayerBody } from "../utils/conductApi";

export interface ReportPlayerControlProps {
  room: RoomView | null;
  /** A Watch tab (read-only, OD-19) never reports, whoever is signed in. */
  watchOnly?: boolean;
  /** Sends the room op on this table's link and resolves the server's answer. */
  onReport: (body: ReportPlayerBody) => Promise<RoomOpResult>;
}

/** Who may be reported from this view: every OTHER seat, by its nickname. Empty when this viewer holds no seat. */
export function reportablePlayers(room: RoomView | null, watchOnly = false): ReadonlyArray<{ id: string; nickname: string }> {
  if (room === null || watchOnly) return [];
  const mine = room.you.playerId;
  if (mine === null || room.you.kicked) return [];
  return room.players.filter((player) => player.id !== mine).map((player) => ({ id: player.id, nickname: player.nickname }));
}

export function ReportPlayerControl({ room, watchOnly = false, onReport }: ReportPlayerControlProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const players = reportablePlayers(room, watchOnly);
  if (players.length === 0) return null;
  return (
    <span style={wrap} data-testid="report-player-control">
      <button
        type="button"
        style={smallButton}
        onClick={() => setOpen(true)}
        title="Report a player's conduct to the operator for review. It does not change the game."
        data-testid="report-player-open"
      >
        Report…
      </button>
      {open ? <ReportPlayerDialog players={players} onReport={onReport} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

export interface ReportPlayerDialogProps {
  players: ReadonlyArray<{ id: string; nickname: string }>;
  onReport: (body: ReportPlayerBody) => Promise<RoomOpResult>;
  onClose: () => void;
}

export function ReportPlayerDialog({ players, onReport, onClose }: ReportPlayerDialogProps): JSX.Element {
  const headingId = useId();
  const [playerId, setPlayerId] = useState<string>(players.length === 1 ? players[0].id : "");
  const [category, setCategory] = useState<ConductReportCategory | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Extract<ReportOutcome, { ok: true }> | null>(null);

  const noteLength = Array.from(note).length;
  const noteCheck = checkConductNote(note, MAX_REPORT_NOTE_LENGTH);
  const ready = playerId !== "" && category !== null && noteCheck.ok && !busy;

  const send = async () => {
    if (!ready || category === null) return;
    setBusy(true);
    setError(null);
    try {
      const answer = reportOutcomeOf(await onReport(reportPlayerOp(playerId, category, note)));
      if (answer.ok) {
        setOutcome(answer);
        setNote("");
      } else {
        setError(answer.reason);
      }
    } catch {
      setError("The report could not be sent. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const chosenName = players.find((player) => player.id === playerId)?.nickname ?? null;

  return (
    <NativeModal labelledBy={headingId} dismissible={!busy} onDismiss={onClose} restoreOpener scrimStyle={scrim} testId="report-player-dialog">
      <div style={{ ...styles.card, maxWidth: "520px" }}>
        <h2 id={headingId} style={styles.heading}>
          Report a player
        </h2>
        {outcome !== null ? (
          <>
            <p style={styles.notice} role="status" data-testid="report-player-received">
              {outcome.already ? "Already received." : "Report received."}
            </p>
            <p style={styles.text}>{outcome.message}</p>
            <div style={styles.row}>
              <button type="button" style={styles.primary} onClick={onClose} data-testid="report-player-done" autoFocus>
                Close
              </button>
            </div>
          </>
        ) : (
          <form
            style={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <p style={styles.lead} data-testid="report-player-explainer">
              Reports go to the operator for review. A report does not change the game, any money, or anyone's profile, and the other player is not told. The reviewer reads this game's own record — moves, offers, timing and chat — so you don't need to copy anything.
            </p>
            <fieldset style={fieldset}>
              <legend style={styles.subheading}>Player</legend>
              <div style={styles.choices}>
                {players.map((player) => (
                  <label key={player.id} style={choice}>
                    <input type="radio" name="report-player" value={player.id} checked={playerId === player.id} onChange={() => setPlayerId(player.id)} disabled={busy} data-testid={`report-player-pick-${player.id}`} />
                    <span>{player.nickname}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset style={fieldset}>
              <legend style={styles.subheading}>What is it about?</legend>
              {CONDUCT_CATEGORY_ORDER.map((value) => (
                <label key={value} style={categoryRow}>
                  <input type="radio" name="report-category" value={value} checked={category === value} onChange={() => setCategory(value)} disabled={busy} data-testid={`report-category-${value}`} />
                  <span>
                    <span style={categoryLabel}>{CONDUCT_CATEGORY_LABELS[value]}</span>
                    <span style={styles.label}> — {CONDUCT_CATEGORY_HINTS[value]}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label style={styles.label} htmlFor={`${headingId}-note`}>
              Anything the reviewer should look at? (optional — a sentence or two)
            </label>
            <textarea
              id={`${headingId}-note`}
              style={{ ...styles.input, minHeight: "64px", resize: "vertical" }}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={MAX_REPORT_NOTE_LENGTH * 2}
              rows={3}
              disabled={busy}
              data-testid="report-note"
            />
            <p style={{ ...styles.label, color: noteLength > MAX_REPORT_NOTE_LENGTH ? "#ffb4a8" : undefined }} data-testid="report-note-count">
              {noteLength} / {MAX_REPORT_NOTE_LENGTH}
              {noteLength > MAX_REPORT_NOTE_LENGTH ? " — shorten the note to send it." : ""}
            </p>
            {error !== null ? (
              <p style={styles.error} role="alert" data-testid="report-player-error">
                {error}
              </p>
            ) : null}
            <div style={styles.row}>
              <button type="submit" style={disabledLook(styles.primary, !ready)} disabled={!ready} data-testid="report-player-send">
                {busy ? "Sending…" : chosenName !== null ? `Report ${chosenName}` : "Send report"}
              </button>
              <button type="button" style={disabledLook(styles.secondary, busy)} disabled={busy} onClick={onClose} data-testid="report-player-cancel">
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </NativeModal>
  );
}

const wrap: React.CSSProperties = { display: "inline-flex", alignItems: "center", marginLeft: 8 };
const smallButton: React.CSSProperties = {
  fontSize: 12,
  padding: "2px 8px",
  borderRadius: 4,
  border: "1px solid rgba(255,255,255,0.35)",
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  cursor: "pointer",
};
const scrim: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "16px",
  boxSizing: "border-box",
  backgroundColor: "rgba(0, 0, 0, 0.7)",
  overflowY: "auto",
};
const fieldset: React.CSSProperties = { border: "none", padding: 0, margin: "0 0 4px" };
const choice: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6 };
const categoryRow: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 8, margin: "0 0 6px" };
const categoryLabel: React.CSSProperties = { fontWeight: 600 };
