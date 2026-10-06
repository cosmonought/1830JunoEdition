// frontend/src/components/ConductReviewPanel.tsx
//
// ==================================================================
//  PHASE 3 (P3-N032): THE CONDUCT REVIEW PANEL -- THE MINIMUM A REVIEWER NEEDS FOR PHASE 4, AND NO MORE
// ==================================================================
//
// Opened from the profile menu, only for an account the server names as a reviewer (`conduct/me`), as a full-window
// reading page like Rules and Terms (`utils/infoPages.ts`; no router). It shows:
//
//   the queue        every case, latest report first: when, category, status, who reported whom (nicknames), how many
//                    times. "Waiting" (open / under review / escalated) or all. A case the reviewer is a party to (the
//                    reporter, the reported account, or seated at its table) is never served to them at all.
//   one case         the table and its rules / build; both parties as public seat ids, nicknames and ACCOUNT
//                    FINGERPRINTS (the same account shows the same fingerprint in every case; never an id or username);
//                    the reporter's note, as plain text; the server's evidence -- the log pointer and whether it still
//                    verifies against the authoritative log NOW, both parties' offer / answer / rescind / undo / pass
//                    counts, the recent timeline (index, time, who, message type -- no payload), the parties' stored
//                    chat lines, a real-money table's financial standing, and what this build could not capture; other
//                    cases naming the same reported account (counts only); and the case's review history.
//   a decision       the next status (only the transitions the workflow allows) and an optional reviewer note; it asks
//                    "Confirm it's you" when the server wants it (a decision needs the session's live grant), and a
//                    case that changed meanwhile is reloaded rather than overwritten.
//
// It decides NOTHING about a player: no sanction, score, block or money control exists here. A status records the
// reviewer's finding on this case, for the operator.

import React, { useCallback, useEffect, useState } from "react";

import { NativeModal } from "./NativeModal";
import { ConfirmItsYou } from "./ConfirmItsYou";
import { disabledLook, profileStyles as styles } from "./profileStyles";
import { CONDUCT_STATUS_LABELS, CONDUCT_TRANSITIONS, MAX_REVIEW_NOTE_LENGTH, isConductCaseActive, type ConductStatus } from "../utils/conductReport";
import { decideCase, reviewCase, reviewErrorSentence, reviewQueue, type CaseSummary, type CaseView, type OfferCounts } from "../utils/conductApi";
import { sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { SANDBOX_INK, SANDBOX_PANEL, SANDBOX_RULE, SANDBOX_TEXT } from "../styles/palette";
import { FONT_FAMILY, FONT_FAMILY_MONO, FONT_SIZE } from "../styles/typography";

const when = (ms: number | null): string => (ms === null ? "—" : new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC");
const COUNT_ROWS: ReadonlyArray<[keyof OfferCounts, string]> = [
  ["actions", "Actions (all)"],
  ["offers", "Offers made"],
  ["accepted", "Offers accepted"],
  ["declined", "Offers declined"],
  ["rescinded", "Offers withdrawn"],
  ["forgone", "Offers forgone"],
  ["undos", "Undos"],
  ["passes", "Passes"],
];

export function ConductReviewPanel({ onClose, port = sessionPort() }: { onClose: () => void; port?: SessionPort }): JSX.Element {
  const [cases, setCases] = useState<readonly CaseSummary[] | null>(null);
  const [unreadable, setUnreadable] = useState(0);
  const [onlyWaiting, setOnlyWaiting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<CaseView | null>(null);
  const [loading, setLoading] = useState(false);

  const loadQueue = useCallback(async () => {
    setError(null);
    const answer = await reviewQueue(port);
    if (!answer.ok) {
      setError(reviewErrorSentence(answer.error, answer.reason));
      return;
    }
    setCases(answer.value.cases);
    setUnreadable(answer.value.unreadable);
  }, [port]);

  const open = useCallback(
    async (caseId: string) => {
      setSelected(caseId);
      setView(null);
      setLoading(true);
      setError(null);
      try {
        const answer = await reviewCase(caseId, port);
        if (answer.ok) setView(answer.value);
        else setError(reviewErrorSentence(answer.error, answer.reason));
      } finally {
        setLoading(false);
      }
    },
    [port],
  );

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const shown = (cases ?? []).filter((entry) => !onlyWaiting || isConductCaseActive(entry.status));

  return (
    <NativeModal name="Conduct reports" dismissible onDismiss={onClose} restoreOpener scrimStyle={scrim} testId="conduct-review-panel">
      <div style={page}>
        <div style={header}>
          <h2 style={styles.heading}>Conduct reports</h2>
          <button type="button" style={styles.secondary} onClick={onClose} data-testid="conduct-review-close">
            Close
          </button>
        </div>
        <p style={styles.lead}>
          Each report is a request to look, not a finding. Nothing here changes a game, money, a profile or anyone's trust facts; a status records your finding on the case.
        </p>
        {error !== null ? (
          <p style={styles.error} role="alert" data-testid="conduct-review-error">
            {error}
          </p>
        ) : null}
        <div style={columns}>
          <section style={queueColumn} aria-label="Cases">
            <div style={styles.row}>
              <label style={styles.check}>
                <input type="checkbox" checked={onlyWaiting} onChange={(event) => setOnlyWaiting(event.target.checked)} data-testid="conduct-review-waiting" />
                Waiting only
              </label>
              <button type="button" style={styles.secondary} onClick={() => void loadQueue()} data-testid="conduct-review-refresh">
                Refresh
              </button>
            </div>
            {cases === null ? <p style={styles.label}>Loading…</p> : null}
            {cases !== null && shown.length === 0 ? <p style={styles.label}>{onlyWaiting ? "No case is waiting." : "No reports yet."}</p> : null}
            {unreadable > 0 ? <p style={styles.error}>{unreadable} stored case(s) cannot be read; they are left as stored for the operator.</p> : null}
            <ul style={list} data-testid="conduct-review-queue">
              {shown.map((entry) => (
                <li key={entry.caseId}>
                  <button
                    type="button"
                    style={{ ...queueItem, ...(selected === entry.caseId ? queueItemSelected : {}) }}
                    onClick={() => void open(entry.caseId)}
                    data-testid={`conduct-case-${entry.caseId}`}
                  >
                    <span style={queueTitle}>
                      {entry.categoryLabel} · {entry.statusLabel}
                    </span>
                    <span style={styles.label}>
                      {entry.reporter.nickname} → {entry.reported.nickname} · {when(entry.lastReportAt)}
                      {entry.reports > 1 ? ` · reported ${entry.reports} times` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section style={caseColumn} aria-label="Case">
            {loading ? <p style={styles.label}>Loading the case…</p> : null}
            {view !== null ? (
              <CaseDetail
                view={view}
                port={port}
                onDecided={(next) => {
                  setView(next);
                  void loadQueue();
                }}
                onReload={() => void open(view.caseId)}
              />
            ) : !loading ? (
              <p style={styles.label}>Choose a case.</p>
            ) : null}
          </section>
        </div>
      </div>
    </NativeModal>
  );
}

function CaseDetail({ view, port, onDecided, onReload }: { view: CaseView; port: SessionPort; onDecided: (next: CaseView) => void; onReload: () => void }): JSX.Element {
  const choices = CONDUCT_TRANSITIONS[view.status];
  const [to, setTo] = useState<ConductStatus | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const noteLength = Array.from(note).length;

  useEffect(() => {
    setTo("");
    setNote("");
    setProblem(null);
    setStale(false);
    setConfirming(false);
  }, [view.caseId, view.revision]);

  const decide = async () => {
    if (to === "" || noteLength > MAX_REVIEW_NOTE_LENGTH) return;
    setBusy(true);
    setProblem(null);
    try {
      const answer = await decideCase({ caseId: view.caseId, revision: view.revision, status: to, note }, port);
      if (answer.ok) {
        onDecided(answer.value);
        return;
      }
      if (answer.error === "reauth-required") {
        setConfirming(true);
        return;
      }
      if (answer.error === "stale") setStale(true);
      setProblem(reviewErrorSentence(answer.error, answer.reason));
    } finally {
      setBusy(false);
    }
  };

  const evidence = view.evidence;
  const verification = view.verification.verified === true ? "Verified" : view.verification.verified === false ? "DOES NOT VERIFY" : "Not checked";
  return (
    <div data-testid="conduct-case-detail">
      <h3 style={styles.subheading}>
        {view.categoryLabel} — {view.statusLabel}
      </h3>
      <dl style={facts}>
        <dt>Case</dt>
        <dd style={mono}>{view.caseId}</dd>
        <dt>Table</dt>
        <dd style={mono}>{view.gameId}</dd>
        <dt>Reported</dt>
        <dd>{when(view.createdAt)}</dd>
        <dt>Reporter</dt>
        <dd>
          {view.reporter.nickname} <span style={mono}>({view.reporter.playerId}, {view.reporter.account})</span> · seated {when(view.reporter.joinedAt)}
        </dd>
        <dt>Reported player</dt>
        <dd>
          {view.reported.nickname} <span style={mono}>({view.reported.playerId}, {view.reported.account})</span> · seated {when(view.reported.joinedAt)}
        </dd>
        <dt>Other cases about this account</dt>
        <dd data-testid="conduct-case-related">
          {view.related.known
            ? `${view.related.total} (${view.related.active} waiting) · from ${view.related.reporters} reporter(s) at ${view.related.games} table(s) · ${view.related.confirmed} confirmed, ${view.related.closedNoViolation} no violation`
            : "Could not be counted just now."}
        </dd>
      </dl>
      <h4 style={sectionHeading}>Reporter's note</h4>
      <p style={styles.text} data-testid="conduct-case-note">
        {view.note ?? "None."}
      </p>

      <h4 style={sectionHeading}>Evidence (derived by the server)</h4>
      <dl style={facts}>
        <dt>Rules</dt>
        <dd>
          deal pinned to {evidence.rules.dealPin ?? "—"}; server engine {evidence.rules.engine}; build {evidence.serverBuild}
        </dd>
        <dt>Table then</dt>
        <dd>
          {evidence.table.status}, {evidence.table.visibility}, {evidence.table.seats} seats{evidence.table.money ? ", real money" : ""}
          {evidence.money !== null ? ` (escrow ${evidence.money.phase ?? "unknown"}${evidence.money.held ? ", held" : ""})` : ""}
        </dd>
        <dt>Game log</dt>
        <dd>
          {evidence.log.captured ? `${evidence.log.entries} entries` : "not captured"}
          {evidence.log.hash !== null ? <span style={mono}> · {evidence.log.hash.slice(0, 16)}…</span> : null}
          {evidence.log.windowFrom !== null ? ` · timeline ${evidence.log.windowFrom}–${evidence.log.windowTo}` : ""}
        </dd>
        <dt>Log check now</dt>
        <dd data-testid="conduct-case-verification">
          <strong>{verification}</strong> — {view.verification.detail}
        </dd>
      </dl>
      <table style={table} data-testid="conduct-case-counts">
        <thead>
          <tr>
            <th style={cell} />
            <th style={cell}>{view.reporter.nickname} (reporter)</th>
            <th style={cell}>{view.reported.nickname} (reported)</th>
          </tr>
        </thead>
        <tbody>
          {COUNT_ROWS.map(([key, label]) => (
            <tr key={key}>
              <td style={cell}>{label}</td>
              <td style={cell}>{evidence.counts.reporter[key]}</td>
              <td style={cell}>{evidence.counts.reported[key]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {evidence.chat !== null && evidence.chat.length > 0 ? (
        <>
          <h4 style={sectionHeading}>Their recent chat</h4>
          <ul style={plainList} data-testid="conduct-case-chat">
            {evidence.chat.map((line) => (
              <li key={line.id}>
                <span style={styles.label}>
                  {when(line.at)} · {line.by === "reporter" ? view.reporter.nickname : view.reported.nickname}:
                </span>{" "}
                {line.text}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <details style={detailsBlock}>
        <summary>Timeline ({evidence.timeline.length} most recent entries)</summary>
        <table style={table} data-testid="conduct-case-timeline">
          <thead>
            <tr>
              <th style={cell}>#</th>
              <th style={cell}>Time</th>
              <th style={cell}>Who</th>
              <th style={cell}>Message</th>
            </tr>
          </thead>
          <tbody>
            {evidence.timeline.map((row) => (
              <tr key={row.i}>
                <td style={cell}>{row.i}</td>
                <td style={cell}>{when(row.at)}</td>
                <td style={cell}>
                  {row.derived ? "server" : ""}
                  {row.derived && row.by !== "other" ? " (after " : ""}
                  {row.by === "reporter" ? view.reporter.nickname : row.by === "reported" ? view.reported.nickname : row.derived ? "" : "—"}
                  {row.derived && row.by !== "other" ? ")" : ""}
                </td>
                <td style={cell}>
                  {row.type}
                  {row.outcome !== undefined ? ` (${row.outcome})` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {view.rereports.length > 0 ? (
        <>
          <h4 style={sectionHeading}>Reported again ({view.rereports.length})</h4>
          <ol style={plainList} data-testid="conduct-case-rereports">
            {view.rereports.map((entry, at) => (
              <li key={at}>
                {when(entry.at)} · log at {entry.log.entries} entries
                {entry.log.hash !== null ? <span style={mono}> · {entry.log.hash.slice(0, 16)}…</span> : null} · {view.reported.nickname}: {entry.counts.reported.offers} offers, {entry.counts.reported.rescinded} withdrawn, {entry.counts.reported.passes} passes, {entry.counts.reported.actions} actions in all
                {entry.note !== null ? <div style={styles.text}>{entry.note}</div> : null}
                {entry.chat.length > 0 ? (
                  <ul style={plainList}>
                    {entry.chat.map((line) => (
                      <li key={line.id}>
                        <span style={styles.label}>
                          {when(line.at)} · {line.by === "reporter" ? view.reporter.nickname : view.reported.nickname}:
                        </span>{" "}
                        {line.text}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {evidence.notCaptured.length > 0 ? (
        <>
          <h4 style={sectionHeading}>Not captured</h4>
          <ul style={plainList} data-testid="conduct-case-not-captured">
            {evidence.notCaptured.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      ) : null}

      <h4 style={sectionHeading}>Review history</h4>
      {view.history.length === 0 ? (
        <p style={styles.label}>No decision yet.</p>
      ) : (
        <ol style={plainList} data-testid="conduct-case-history">
          {view.history.map((event, at) => (
            <li key={at}>
              {when(event.at)} · {CONDUCT_STATUS_LABELS[event.from]} → {CONDUCT_STATUS_LABELS[event.to]} · {event.byYou ? "you" : <span style={mono}>{event.reviewer}</span>}
              {event.note !== null ? <div style={styles.label}>{event.note}</div> : null}
            </li>
          ))}
        </ol>
      )}

      <h4 style={sectionHeading}>Decide</h4>
      {confirming ? (
        <ConfirmItsYou
          purpose="To record a decision on this case"
          port={port}
          testIdPrefix="conduct-reauth"
          onCancel={() => setConfirming(false)}
          onConfirmed={async () => {
            setConfirming(false);
            await decide();
          }}
        />
      ) : (
        <form
          style={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void decide();
          }}
        >
          <label style={styles.label} htmlFor="conduct-decision-status">
            New status
          </label>
          <select id="conduct-decision-status" style={styles.input} value={to} onChange={(event) => setTo(event.target.value as ConductStatus | "")} disabled={busy} data-testid="conduct-decision-status">
            <option value="">Choose…</option>
            {choices.map((choice) => (
              <option key={choice} value={choice}>
                {CONDUCT_STATUS_LABELS[choice]}
              </option>
            ))}
          </select>
          <label style={styles.label} htmlFor="conduct-decision-note">
            Reviewer note (optional; kept with the case, never shown to players)
          </label>
          <textarea
            id="conduct-decision-note"
            style={{ ...styles.input, minHeight: "64px", resize: "vertical" }}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={MAX_REVIEW_NOTE_LENGTH * 2}
            disabled={busy}
            data-testid="conduct-decision-note"
          />
          <p style={styles.label}>
            {noteLength} / {MAX_REVIEW_NOTE_LENGTH}
          </p>
          {problem !== null ? (
            <p style={styles.error} role="alert" data-testid="conduct-decision-error">
              {problem}
            </p>
          ) : null}
          <div style={styles.row}>
            <button type="submit" style={disabledLook(styles.primary, busy || to === "" || noteLength > MAX_REVIEW_NOTE_LENGTH)} disabled={busy || to === "" || noteLength > MAX_REVIEW_NOTE_LENGTH} data-testid="conduct-decision-save">
              {busy ? "Saving…" : "Record decision"}
            </button>
            {stale ? (
              <button type="button" style={styles.secondary} onClick={onReload} data-testid="conduct-decision-reload">
                Reload the case
              </button>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}

const scrim: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  pointerEvents: "auto",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "16px",
  boxSizing: "border-box",
  backgroundColor: "rgba(0, 0, 0, 0.7)",
  overflowY: "auto",
};
const page: React.CSSProperties = {
  width: "100%",
  maxWidth: "1100px",
  padding: "20px",
  boxSizing: "border-box",
  borderRadius: "12px",
  border: `1px solid ${SANDBOX_RULE}`,
  backgroundColor: SANDBOX_PANEL,
  color: SANDBOX_INK,
  fontFamily: FONT_FAMILY,
};
const header: React.CSSProperties = { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", marginBottom: "8px" };
const columns: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "flex-start" };
const queueColumn: React.CSSProperties = { flex: "1 1 280px", minWidth: 0 };
const caseColumn: React.CSSProperties = { flex: "2 1 480px", minWidth: 0 };
const list: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "6px" };
const plainList: React.CSSProperties = { margin: "0 0 12px", paddingLeft: "20px", fontSize: FONT_SIZE.body, lineHeight: 1.5 };
const queueItem: React.CSSProperties = {
  width: "100%",
  textAlign: "left",
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  padding: "8px 10px",
  borderRadius: "8px",
  border: `1px solid ${SANDBOX_RULE}`,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  font: "inherit",
};
const queueItemSelected: React.CSSProperties = { border: "1px solid #9ec5ff", background: "rgba(158,197,255,0.08)" };
const queueTitle: React.CSSProperties = { fontWeight: 600 };
const sectionHeading: React.CSSProperties = { margin: "16px 0 6px", fontSize: FONT_SIZE.body, color: SANDBOX_TEXT, textTransform: "uppercase", letterSpacing: "0.04em" };
const facts: React.CSSProperties = { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px", margin: "0 0 12px", fontSize: FONT_SIZE.body };
const mono: React.CSSProperties = { fontFamily: FONT_FAMILY_MONO, fontSize: FONT_SIZE.small, overflowWrap: "anywhere" };
const table: React.CSSProperties = { borderCollapse: "collapse", margin: "0 0 12px", fontSize: FONT_SIZE.small, width: "100%" };
const cell: React.CSSProperties = { border: `1px solid ${SANDBOX_RULE}`, padding: "3px 6px", textAlign: "left" };
const detailsBlock: React.CSSProperties = { margin: "0 0 12px" };
