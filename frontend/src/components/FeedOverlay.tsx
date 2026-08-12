// frontend/src/components/FeedOverlay.tsx
//
// Combined Feed Overlay -- dashboard full-width layout refactor (see
// App.tsx's own design note #18). Merges Live Chat + the Action Log into
// one chronologically sorted timeline (utils/feed.ts's own
// `mergeFeedItems`), with ALL/CHAT/LOG filter pills and a chat composer
// anchored at the bottom. Opened by clicking TopTicker.tsx's compact bar;
// replaces the old always-visible, fixed-width left-side Activity Feed
// sidebar (Chatbox + Action Log stacked in one bordered aside) -- see
// App.tsx's own design note #18 for the full before/after of this pass.
//
// Design notes:
// 1. **State ownership unchanged from before this pass.** `chatMessages`/
//    `actionLog`/the composer draft all still live in App.tsx exactly as
//    they did when Chatbox/ActionLogPanel rendered them directly (Chatbox's
//    own local-only chat transport, design note #1 there, is untouched --
//    only WHERE that state is rendered changes). This component receives
//    the already-merged, already-sorted `items` array plus the handful of
//    controlled-input props it needs to render the composer and pills; it
//    does not itself decide what counts as "chat" vs. "log" beyond
//    filtering the array it's given.
// 2. **Modal/dropdown, not a route.** Rendered unconditionally by App.tsx
//    (mounted regardless of `isOpen`, matching the existing convention
//    other overlays in this codebase use, e.g. TileSelectionPopup.tsx) so
//    its own internal scroll position isn't lost between opens. A
//    full-viewport `position: fixed` backdrop behind the panel closes the
//    overlay on click, in addition to the explicit close (×) button in its
//    own header.
// 3. **Chat entries get a player brand color tag** (`colorForAuthor`, see
//    utils/feed.ts's own design note) as a colored left border plus a
//    matching author-name color, with a lightly rounded "speech bubble"
//    background -- visually distinct from log entries' flatter badge-strip
//    look (item 4 below), so a fast-scrolling combined timeline still reads
//    as two different kinds of entries at a glance, exactly as requested.
// 4. **Log entries render as compact single-line badge strips** -- an icon
//    (`iconForLogEntry`, one of the five requested categories: Tile/Stock/
//    Train/Dividend/Phase Shift, or a generic fallback) plus the label,
//    status-colored, with the fuller `logDetail` (e.g. a tx hash) available
//    via the strip's own `title` tooltip rather than always rendered inline
//    -- kept deliberately compact, unlike the old standalone
//    `ActionLogPanel` entries this supersedes, which always rendered detail
//    as a full second line.
// 5. **Composer anchored at the bottom, outside the scrollable/filtered
//    list.** Matches this pass's own explicit requirement -- the input box
//    always stays visible and reachable regardless of which filter pill is
//    active or how far a player has scrolled up into history, the same
//    "composer pinned below a scrolling list" shape Chatbox.tsx used before
//    this pass (that file's own design note #5/item 1).
// 6. **Auto-scroll to bottom.** A `useRef`+`useEffect` keyed on the
//    FILTERED item count (not the unfiltered `items.length`) scrolls the
//    list to its `scrollHeight` whenever a new item that's actually visible
//    under the current filter arrives, or when the overlay first opens --
//    the same scroll-to-bottom convention Chatbox.tsx's own design note
//    #5/item 2 established for chat, now generalized to the merged list.
// 7. **Notification Settings + expanded composer (Top Ticker refinement
//    pass, see App.tsx's own design note #19).** Two additions, both
//    scoped to this modal only:
//    (1) A new settings row between the filter pills and the scrollable
//    list, two toggle switches ("🔔 Tab Title Flash" / "💫 Turn Pulse
//    Glow") that gate the Active Player Turn Notifications this app
//    already had (`utils/turnAlert.ts`'s `useDocumentTitleFlash`, and the
//    CSS pulse `App.tsx` applies around the viewport margin/top action
//    bar) -- letting a player reviewing past turns in this modal also
//    dial down or re-enable those two notification channels without
//    leaving it. State (`titleFlashEnabled`/`pulseGlowEnabled`) still
//    lives in App.tsx, the same "this component renders, App.tsx owns
//    state" split as every other prop here (design note #1).
//    (2) `styles.composerInput` grows (15px/10px-12px padding -> 16px/
//    12px-14px padding) relative to the new, deliberately compact
//    `InlineQuickChat.tsx` composer that now sits below the Top Ticker for
//    zero-friction sends -- this modal's own composer is the "expanded"
//    one a player reaches for when reviewing history and wants to reply
//    with more visual room, not the quick one-line send.

import React, { useEffect, useMemo, useRef } from "react";
import type { FeedFilter, FeedItem } from "../utils/feed";
import { colorForAuthor, iconForLogEntry, iconForLogStatus } from "../utils/feed";

export interface FeedOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  items: readonly FeedItem[];
  filter: FeedFilter;
  onFilterChange: (filter: FeedFilter) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  roundLabel: string | null;
  /** Notification Settings -- design note #7. */
  titleFlashEnabled: boolean;
  onToggleTitleFlash: () => void;
  pulseGlowEnabled: boolean;
  onTogglePulseGlow: () => void;
}

const FILTER_PILLS: ReadonlyArray<{ id: FeedFilter; label: string }> = [
  { id: "all", label: "ALL" },
  { id: "chat", label: "💬 CHAT" },
  { id: "log", label: "📜 LOG" },
];

export function FeedOverlay({
  isOpen,
  onClose,
  items,
  filter,
  onFilterChange,
  draft,
  onDraftChange,
  onSend,
  roundLabel,
  titleFlashEnabled,
  onToggleTitleFlash,
  pulseGlowEnabled,
  onTogglePulseGlow,
}: FeedOverlayProps) {
  const filteredItems = useMemo(
    () => (filter === "all" ? items : items.filter((item) => item.kind === filter)),
    [items, filter],
  );

  // Design note #6.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [isOpen, filteredItems.length]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSend();
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Design note #2: full-viewport backdrop, click to close. */}
      <div style={styles.backdrop} onClick={onClose} />
      <div style={styles.panel} role="dialog" aria-label="Combined chat and activity feed">
        <div style={styles.header}>
          <span style={styles.headerTitle}>Feed</span>
          {roundLabel && <span style={styles.roundBadge}>{roundLabel}</span>}
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close feed">
            &times;
          </button>
        </div>

        <div style={styles.pillRow}>
          {FILTER_PILLS.map((pill) => (
            <button
              key={pill.id}
              type="button"
              style={{
                ...styles.pill,
                ...(filter === pill.id ? styles.pillActive : {}),
              }}
              onClick={() => onFilterChange(pill.id)}
            >
              {pill.label}
            </button>
          ))}
        </div>

        {/* Design note #7: Notification Settings -- reviewing past turns
            here can also dial the two turn-notification channels up/down. */}
        <div style={styles.settingsRow}>
          <span style={styles.settingsLabel}>Notification Settings</span>
          <button
            type="button"
            role="switch"
            aria-checked={titleFlashEnabled}
            style={styles.settingsToggle}
            onClick={onToggleTitleFlash}
          >
            <span style={styles.settingsToggleTrack}>
              <span
                style={{
                  ...styles.settingsToggleThumb,
                  ...(titleFlashEnabled ? styles.settingsToggleThumbActive : {}),
                }}
              />
            </span>
            🔔 Tab Title Flash
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={pulseGlowEnabled}
            style={styles.settingsToggle}
            onClick={onTogglePulseGlow}
          >
            <span style={styles.settingsToggleTrack}>
              <span
                style={{
                  ...styles.settingsToggleThumb,
                  ...(pulseGlowEnabled ? styles.settingsToggleThumbActive : {}),
                }}
              />
            </span>
            💫 Turn Pulse Glow
          </button>
        </div>

        <div style={styles.list} ref={listRef}>
          {filteredItems.length === 0 && <p style={styles.emptyHint}>Nothing here yet.</p>}
          {filteredItems.map((item) =>
            item.kind === "chat" ? <ChatEntry key={item.id} item={item} /> : <LogEntry key={item.id} item={item} />,
          )}
        </div>

        {/* Design note #5: anchored at the bottom, outside the scrollable/
            filtered list, always reachable regardless of the active pill. */}
        <div style={styles.composerRow}>
          <input
            type="text"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Say something..."
            style={styles.composerInput}
          />
          <button type="button" style={styles.sendButton} onClick={onSend} disabled={!draft.trim()}>
            Send
          </button>
        </div>
        <p style={styles.disclaimer}>
          Chat is local-only and illustrative -- this contract has no chat/messaging transport, so
          messages are never sent to other players.
        </p>
      </div>
    </>
  );
}

export default FeedOverlay;

/* ------------------------------------------------------------------ */
/* Entry renderers -- design notes #3/#4                              */
/* ------------------------------------------------------------------ */

function ChatEntry({ item }: { item: FeedItem }) {
  const color = colorForAuthor(item.chatAuthor ?? "");
  return (
    <div style={{ ...styles.chatEntry, borderLeftColor: color }}>
      <div style={styles.chatEntryHeader}>
        <span style={{ ...styles.chatAuthor, color }}>{item.chatAuthor}</span>
        <span style={styles.timestamp}>{item.timestampLabel}</span>
      </div>
      <div style={styles.chatText}>{item.chatText}</div>
    </div>
  );
}

function LogEntry({ item }: { item: FeedItem }) {
  const { icon, category } = iconForLogEntry(item.logLabel ?? "");
  const statusIcon = iconForLogStatus(item.logStatus ?? "info");
  return (
    <div style={styles.logEntry} title={item.logDetail}>
      <span style={styles.logCategoryBadge}>
        {icon} {category}
      </span>
      <span style={styles.logStatusIcon}>{statusIcon}</span>
      <span style={styles.logLabel}>{item.logLabel}</span>
      <span style={styles.timestamp}>{item.timestampLabel}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inline styles                                                      */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    zIndex: 900,
  },
  panel: {
    position: "fixed",
    top: "104px",
    left: "50%",
    transform: "translateX(-50%)",
    width: "min(720px, 94vw)",
    maxHeight: "min(640px, 80vh)",
    display: "flex",
    flexDirection: "column",
    backgroundColor: "#161922",
    border: "1px solid #3a3f4b",
    borderRadius: "12px",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.55)",
    zIndex: 901,
    overflow: "hidden",
    color: "#e6e8ef",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "16px 20px",
    borderBottom: "1px solid #2a2e3a",
  },
  headerTitle: {
    fontSize: "17px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#9aa0ac",
  },
  roundBadge: {
    fontSize: "13px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    padding: "3px 9px",
    borderRadius: "999px",
    backgroundColor: "#242833",
    color: "#c7cbd4",
  },
  closeButton: {
    marginLeft: "auto",
    fontSize: "22px",
    lineHeight: 1,
    padding: "2px 8px",
    borderRadius: "6px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#c7cbd4",
    cursor: "pointer",
  },
  pillRow: {
    display: "flex",
    gap: "8px",
    padding: "12px 20px",
    borderBottom: "1px solid #2a2e3a",
  },
  pill: {
    fontSize: "13px",
    fontWeight: 700,
    padding: "6px 14px",
    borderRadius: "999px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#1e2129",
    color: "#9aa0ac",
    cursor: "pointer",
  },
  pillActive: {
    backgroundColor: "#2a3a52",
    borderColor: "#4a6a92",
    color: "#e6e8ef",
  },
  // ---- Notification Settings -- design note #7. ----
  settingsRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "16px",
    padding: "10px 20px",
    borderBottom: "1px solid #2a2e3a",
    backgroundColor: "#14161d",
  },
  settingsLabel: {
    fontSize: "12px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#6f7480",
  },
  settingsToggle: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "13px",
    color: "#c7cbd4",
    background: "none",
    border: "none",
    padding: "4px 6px",
    cursor: "pointer",
  },
  settingsToggleTrack: {
    display: "inline-flex",
    alignItems: "center",
    width: "30px",
    height: "16px",
    borderRadius: "999px",
    backgroundColor: "#3a3f4b",
    padding: "2px",
    boxSizing: "border-box",
  },
  settingsToggleThumb: {
    width: "12px",
    height: "12px",
    borderRadius: "999px",
    backgroundColor: "#c7cbd4",
    transition: "transform 0.12s ease",
  },
  settingsToggleThumbActive: {
    backgroundColor: "#caa42a",
    transform: "translateX(14px)",
  },
  list: {
    flex: 1,
    minHeight: "160px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "14px 20px",
  },
  emptyHint: {
    fontSize: "14px",
    color: "#6f7480",
    margin: 0,
  },
  // ---- Chat entries -- design note #3. ----
  chatEntry: {
    borderLeft: "3px solid #3a3f4b",
    backgroundColor: "#1e2129",
    borderRadius: "0 10px 10px 10px",
    padding: "8px 12px",
  },
  chatEntryHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
  },
  chatAuthor: {
    fontSize: "14px",
    fontWeight: 700,
  },
  chatText: {
    fontSize: "14px",
    color: "#c7cbd4",
    marginTop: "2px",
  },
  // ---- Log entries -- design note #4. ----
  logEntry: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "6px 12px",
    backgroundColor: "#1a1d26",
    border: "1px solid #262a34",
    borderRadius: "999px",
    fontSize: "13px",
  },
  logCategoryBadge: {
    fontSize: "12px",
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: "999px",
    backgroundColor: "#242833",
    color: "#9aa0ac",
    whiteSpace: "nowrap",
  },
  logStatusIcon: {
    fontSize: "12px",
  },
  logLabel: {
    flex: 1,
    color: "#c7cbd4",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  timestamp: {
    fontSize: "12px",
    color: "#6f7480",
    flexShrink: 0,
  },
  composerRow: {
    display: "flex",
    gap: "8px",
    padding: "14px 20px",
    borderTop: "1px solid #2a2e3a",
  },
  // Design note #7/item 2: deliberately larger than the compact
  // InlineQuickChat.tsx composer -- this is the "expanded chat text box".
  composerInput: {
    flex: 1,
    fontSize: "16px",
    padding: "12px 14px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#0e1015",
    color: "#e6e8ef",
  },
  sendButton: {
    fontSize: "15px",
    padding: "10px 18px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    cursor: "pointer",
  },
  disclaimer: {
    fontSize: "12px",
    color: "#6f7480",
    margin: "0 20px 14px",
    lineHeight: 1.4,
  },
};
