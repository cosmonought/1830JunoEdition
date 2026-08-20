// Inline Control Strip -- the composer and the ALL/CHAT/LOG filter pills,
// rendered directly below `TopTicker` so it stays anchored to that accordion.
//
// There is now exactly ONE composer in the app, so `draft`/`onDraftChange`/
// `onSend` are the single source of truth for `chatDraft`. Presentational only.
// Always mounted independent of the accordion's expand state, so nothing here is
// ever lost or re-focused. The pills drive the same `feedFilter` that feeds both
// `TopTicker`'s preview and its history.
//
// See docs/ai_architecture/firebase_middleware.md, InlineQuickChat.tsx.

import React from "react";
import type { FeedFilter } from "../utils/feed";
import { CONTROL_PADDING, FONT_SIZE } from "../styles/typography";

export interface InlineQuickChatProps {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  filter: FeedFilter;
  onFilterChange: (filter: FeedFilter) => void;
}

const FILTER_PILLS: ReadonlyArray<{ id: FeedFilter; label: string }> = [
  { id: "all", label: "ALL" },
  { id: "chat", label: "💬 CHAT" },
  { id: "log", label: "📜 LOG" },
];

export function InlineQuickChat({ draft, onDraftChange, onSend, filter, onFilterChange }: InlineQuickChatProps) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSend();
    }
  };

  return (
    <div style={styles.root}>
      <span style={styles.icon} aria-hidden="true">
        💬
      </span>
      <input
        type="text"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message..."
        aria-label="Quick chat message"
        style={styles.input}
      />
      <button type="button" style={styles.sendButton} onClick={onSend} disabled={!draft.trim()}>
        Send
      </button>

      {/* Design note #5: thin divider between the chat controls and the
          filter pills. */}
      <span style={styles.divider} aria-hidden="true" />

      {/* Design note #4: filter pills, directly to the right of the chat
          input controls. */}
      <div style={styles.pillRow} role="group" aria-label="Filter chat and activity feed">
        {FILTER_PILLS.map((pill) => (
          <button
            key={pill.id}
            type="button"
            style={{
              ...styles.pill,
              ...(filter === pill.id ? styles.pillActive : {}),
            }}
            onClick={() => onFilterChange(pill.id)}
            aria-pressed={filter === pill.id}
          >
            {pill.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default InlineQuickChat;

// Design note #4 (Accordion Panel refinement pass): part of the same
// #0F172A "recessed" surface as TopTicker.tsx's own expanded body, so this
// strip continues to read as the bottom edge of one connected module
// whether the accordion above it is collapsed or expanded.
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    padding: "6px 14px",
    /* Design note #457: the same surface and the same left accent the
       ticker above now carries, so the two read as one block -- the log and
       the chat are one conversation, and the boundary that matters is the
       one between them and the tab bar, not the one between each other. */
    backgroundColor: "#131a27",
    borderLeft: "3px solid #2f6f6a",
    borderBottom: "1px solid #0b1119",
    boxSizing: "border-box",
    flexWrap: "wrap",
  },
  icon: {
    fontSize: FONT_SIZE.strong,
    flexShrink: 0,
  },
  input: {
    flex: "1 1 160px",
    minWidth: "120px",
    fontSize: FONT_SIZE.control,
    padding: CONTROL_PADDING.input,
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#0a0e17",
    color: "#e6e8ef",
    boxSizing: "border-box",
  },
  sendButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    cursor: "pointer",
    flexShrink: 0,
  },
  // ---- Divider -- design note #5. `marginLeft: "auto"` absorbs the
  // remaining row width, so it (and the pill group right after it) sit
  // flush against the right edge while staying directly adjacent to each
  // other. ----
  divider: {
    width: "1px",
    alignSelf: "stretch",
    minHeight: "22px",
    backgroundColor: "#2a3a52",
    marginLeft: "auto",
    flexShrink: 0,
  },
  // ---- Filter pills -- design note #4. ----
  pillRow: {
    display: "flex",
    gap: "6px",
    flexShrink: 0,
  },
  pill: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: "999px",
    // Longhand: `pillActive` overrides `borderColor` alone, and mixing that
    // against a `border` shorthand is the same warning `Lobby.tsx`'s tab bar
    // hit.
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a3f4b",
    backgroundColor: "#1e2129",
    color: "#9aa0ac",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  pillActive: {
    backgroundColor: "#2a3a52",
    borderColor: "#4a6a92",
    color: "#e6e8ef",
  },
};
