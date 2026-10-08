// frontend/src/tutorial/TutorialLibrary.tsx
//
/* ==================================================================
    PHASE 3 FINAL PLAY TUTORIAL: THE LIBRARY -- EVERY LESSON, ON DEMAND, AND THE TWO SETTINGS
   ==================================================================
   THE SAME WORDS AS THE COACH. Topics and lessons come from `lessons.ts` (`LIBRARY_TOPICS`); nothing here is prose of
   its own. Reading a lesson here acknowledges nothing: it does not mark a live lesson answered, and it does not stop
   one being taught when its moment comes in play.

   A GENUINE MODAL, AND THEREFORE NATIVE (OD-15(b)): the player opened a reader, so the board may rest behind it. It
   is a `NativeModal` -- top layer, one close path (Escape / Close), focus restored to the Tutorials button -- and
   while it is open the coordinator holds the coach, like any other native dialog.

   THE SETTINGS ARE REVERSIBLE BOTH WAYS (the old "Turn tutorials off" was a one-way door):
     Automatic tutorials  On / Off -- this browser's preference; the library stays available either way.
     Restart tutorials for this game -- this seat forgets what it was taught in this game, and the orientation and
                          the current round's primer come straight back. Seated players only. */

import React, { useEffect, useState } from "react";
import NativeModal from "../components/NativeModal";
import { CONTROL_PADDING, FONT_FAMILY, FONT_SIZE, LINE_HEIGHT, RADIUS } from "../styles/typography";
import { SANDBOX_INK, SANDBOX_RAISED, SANDBOX_RULE_STRONG } from "../styles/palette";
import { LIBRARY_TOPICS, lessonById, lessonText, type LessonScope, type RulesPageId } from "./lessons";

export interface TutorialLibraryProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly scope: LessonScope;
  /** Automatic tutorials are on. */
  readonly auto: boolean;
  readonly onSetAuto: (enabled: boolean) => void;
  /** Restart is offered to a seated player in a game; `null` otherwise, with the reason shown. */
  readonly onRestart: (() => void) | null;
  readonly restartUnavailableReason?: string;
  readonly onOpenRules?: (page: RulesPageId, anchor?: string) => void;
}

export function TutorialLibrary({
  open,
  onClose,
  scope,
  auto,
  onSetAuto,
  onRestart,
  restartUnavailableReason,
  onOpenRules,
}: TutorialLibraryProps) {
  const [topicId, setTopicId] = useState<string | null>(null);
  const [restarted, setRestarted] = useState(false);
  useEffect(() => {
    if (!open) {
      setTopicId(null);
      setRestarted(false);
    }
  }, [open]);
  if (!open) return null;
  const topic = LIBRARY_TOPICS.find((entry) => entry.id === topicId) ?? null;

  return (
    <NativeModal
      name={topic ? `Tutorials: ${topic.heading}` : "Tutorials"}
      dismissible
      onDismiss={onClose}
      restoreOpener
      scrimStyle={styles.scrim}
      testId="tutorial-library"
    >
      <div style={styles.card}>
        <div style={styles.header}>
          <h2 style={styles.heading}>{topic ? topic.heading : "Tutorials"}</h2>
          <div style={styles.headerButtons}>
            {topic && (
              <button type="button" style={styles.secondaryButton} onClick={() => setTopicId(null)}>
                All topics
              </button>
            )}
            <button type="button" style={styles.primaryButton} onClick={onClose} data-testid="tutorial-library-close">
              Close
            </button>
          </div>
        </div>

        {topic ? (
          <div style={styles.body} data-testid="tutorial-library-topic">
            {topic.lessons.map((id) => {
              const lesson = lessonById(id);
              if (!lesson) return null;
              const text = lessonText(lesson, scope);
              const rules = lesson.rules;
              return (
                <article key={id} style={styles.lesson} data-lesson={id}>
                  <h3 style={styles.lessonTitle}>{text.title}</h3>
                  <p style={styles.text}>{text.summary}</p>
                  {(text.detail ?? []).map((line) => (
                    <p key={line} style={styles.detail}>
                      {line}
                    </p>
                  ))}
                  {rules && onOpenRules && (
                    <button type="button" style={styles.linkButton} onClick={() => onOpenRules(rules.page, rules.anchor)}>
                      Read the rule
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div style={styles.body}>
            <p style={styles.text}>
              Read any topic at any time. Reading here does not change what the game teaches you as it happens.
            </p>
            {LIBRARY_TOPICS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                style={styles.topicRow}
                onClick={() => setTopicId(entry.id)}
                data-testid={`tutorial-topic-${entry.id}`}
              >
                <span style={styles.topicHeading}>{entry.heading}</span>
                <span style={styles.topicBlurb}>{entry.blurb}</span>
              </button>
            ))}
            <div style={styles.settings} role="group" aria-label="Tutorial settings">
              <label style={styles.toggleRow}>
                <input
                  type="checkbox"
                  checked={auto}
                  onChange={(event) => onSetAuto(event.target.checked)}
                  data-testid="tutorial-auto-toggle"
                />
                <span>
                  <span style={styles.topicHeading}>Automatic tutorials: {auto ? "On" : "Off"}</span>
                  <span style={styles.topicBlurb}>
                    Explain each part of the game as you first meet it in play. Turn this off at any time and back on
                    here; these topics stay available either way.
                  </span>
                </span>
              </label>
              <div style={styles.restartRow}>
                <button
                  type="button"
                  style={styles.secondaryButton}
                  disabled={onRestart === null}
                  onClick={() => {
                    if (!onRestart) return;
                    onRestart();
                    setRestarted(true);
                  }}
                  data-testid="tutorial-restart"
                >
                  Restart tutorials for this game
                </button>
                <span style={styles.topicBlurb} role="status">
                  {onRestart === null
                    ? restartUnavailableReason ?? ""
                    : restarted
                      ? auto
                        ? "Restarted: the tutorials for this game begin again."
                        : "Restarted. Turn automatic tutorials on to see them."
                      : "Forget what this game has taught you so far and begin again."}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </NativeModal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  scrim: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 8, 12, 0.72)",
    fontFamily: FONT_FAMILY,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    width: "min(620px, 100%)",
    maxHeight: "calc(100vh - 48px)",
    padding: "20px 22px",
    borderRadius: RADIUS.layer,
    backgroundColor: "#141414",
    border: "1px solid #3a3a3a",
    boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
    color: "#f2f0eb",
    boxSizing: "border-box",
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
  headerButtons: { display: "flex", gap: "8px" },
  heading: { margin: 0, fontSize: FONT_SIZE.heading, fontWeight: 800 },
  body: { display: "flex", flexDirection: "column", gap: "10px", overflowY: "auto", minHeight: 0 },
  text: { margin: 0, fontSize: FONT_SIZE.body, lineHeight: LINE_HEIGHT.normal, color: "#e2e0da" },
  detail: { margin: 0, fontSize: FONT_SIZE.small, lineHeight: LINE_HEIGHT.normal, color: "#c8c6c0" },
  lesson: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "12px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #2a2a2a",
    backgroundColor: "#101010",
  },
  lessonTitle: { margin: 0, fontSize: FONT_SIZE.strong, fontWeight: 700, color: "#c9a94c" },
  topicRow: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "3px",
    width: "100%",
    textAlign: "left",
    padding: "10px 12px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#141414",
    color: "#f2f0eb",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  topicHeading: { display: "block", fontSize: FONT_SIZE.strong, fontWeight: 700 },
  topicBlurb: { display: "block", fontSize: FONT_SIZE.small, color: "#a8a6a0", lineHeight: 1.4 },
  settings: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "12px",
    borderRadius: RADIUS.control,
    border: `1px solid ${SANDBOX_RULE_STRONG}`,
    background: SANDBOX_RAISED,
  },
  toggleRow: { display: "flex", gap: "10px", alignItems: "flex-start", cursor: "pointer" },
  restartRow: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "4px" },
  primaryButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: CONTROL_PADDING.button,
    borderRadius: RADIUS.card,
    border: `1px solid ${SANDBOX_RULE_STRONG}`,
    backgroundColor: SANDBOX_RAISED,
    color: SANDBOX_INK,
    cursor: "pointer",
  },
  secondaryButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    padding: CONTROL_PADDING.button,
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#c8c6c0",
    cursor: "pointer",
  },
  linkButton: {
    alignSelf: "flex-start",
    padding: 0,
    border: "none",
    background: "none",
    color: "#a8a6a0",
    fontSize: FONT_SIZE.small,
    textDecoration: "underline",
    cursor: "pointer",
    fontFamily: "inherit",
  },
};
