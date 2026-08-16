// frontend/src/components/TopTicker.tsx
//
// Top Ticker -- now an in-place accordion header+body (Accordion Panel
// refinement pass, see App.tsx's own design note #20), superseding
// FeedOverlay.tsx's old modal/pop-up entirely (that file is no longer
// imported or rendered -- see App.tsx design note #20 for the removal).
// Still previews the single most recent Feed item when collapsed; clicking
// the chevron now expands THIS SAME container in place to show a
// scrollable ~7-line history, rather than opening a floating panel.
//
// Design notes:
// 1. **Presentational only.** This component owns no state of its own --
//    `latestItem`/`items`/`unreadCount`/`isExpanded` are all derived or
//    owned by App.tsx (the single owner of `chatMessages`/`actionLog`),
//    matching this codebase's established "App.tsx owns state, child
//    components render it" split (e.g. Chatbox.tsx's own design note #3).
// 2. **Preview format unchanged from before this pass.** Chat items render
//    as `💬 {author}: "{text}"`; log items lead with `iconForLogStatus`
//    followed by the entry's real `logLabel` (and `logDetail` when short
//    enough to fit inline).
// 3. **Unread badge only shows while collapsed** -- `unreadCount` is
//    already computed by App.tsx as `0` whenever the panel is expanded
//    (mirroring what used to gate the modal), this component still
//    double-guards on `!isExpanded` itself so the badge can never flash
//    visible for one render during an expand/collapse transition.
// 4. **Prominent sizing/typography** (Top Ticker refinement pass, design
//    note #19): taller header row, bigger `#F8FAFC` medium-weight text,
//    unread badge/expand hint scaled up alongside it. Unchanged by this
//    pass other than the chevron now reflecting in-place expansion instead
//    of a modal.
// 5. **In-place accordion body (this pass, design note #20).** `items` is
//    the FILTERED array App.tsx already computes from `feedFilter` (the
//    same filter driving the pills InlineQuickChat.tsx now renders) --
//    this component just slices the last `HISTORY_LINE_COUNT` entries and
//    renders them, so filtering "instantly filters both the single-line
//    preview AND the 7-line expanded history view" (this pass's own
//    requirement) by construction: both this component's `latestItem` prop
//    and its `items` prop come from the same filtered source in App.tsx.
//    `maxHeight` on the scroll body is sized for ~7 compact rows
//    (`HISTORY_LINE_COUNT * HISTORY_LINE_HEIGHT_PX`), auto-scrolled to the
//    bottom (most recent) whenever it's open or a new filtered item
//    arrives while it's open -- the same scroll-to-bottom convention
//    FeedOverlay.tsx's own design note #6 established, ported here.
// 6. **Notification Settings REMOVED (Mandatory Turn Alerts pass, see
//    App.tsx's own design note #21).** The two toggle switches ("🔔 Tab
//    Title Flash" / "💫 Turn Pulse Glow") this component used to render at
//    the top of the expanded body (previously design note #6, itself
//    ported in from FeedOverlay.tsx's old modal) are gone entirely --
//    both turn-alert channels are now mandatory, always-on whenever
//    `isMyTurn === true`, with no per-player opt-out anywhere in the app.
//    The expanded body below is now JUST the scrollable history list --
//    see design note #21's own requirement that the expanded panel show
//    "clean, readable text logs and chat" with no settings/checkbox
//    clutter.
// 7. **No border-radius/shadow/backdrop.** This is no longer a floating
//    panel -- it's an in-place section of the page flowing directly out of
//    the active nav tab above it (App.tsx design note #20/item 3), so it
//    intentionally has none of FeedOverlay.tsx's old "floating card" chrome.

import React, { useEffect, useRef } from "react";
import type { FeedItem } from "../utils/feed";
import { colorForAuthor, iconForLogEntry, iconForLogStatus } from "../utils/feed";
import { FONT_FAMILY, FONT_SIZE } from "../styles/typography";

const HISTORY_LINE_COUNT = 7;
// Bumped 36 -> 46 alongside the typography scale: this constant sizes the
// scroll body to ~7 rows, so leaving it while row TEXT grew would have shown
// about five rows and clipped the sixth mid-glyph.
const HISTORY_LINE_HEIGHT_PX = 46;

export interface TopTickerProps {
  latestItem: FeedItem | null;
  /** Already filtered by the active feed filter -- see design note #5. */
  items: readonly FeedItem[];
  unreadCount: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

function previewText(item: FeedItem): string {
  if (item.kind === "chat") {
    return `💬 ${item.chatAuthor}: "${item.chatText}"`;
  }
  const icon = iconForLogStatus(item.logStatus ?? "info");
  const detail = item.logDetail && item.logDetail.length <= 40 ? ` — ${item.logDetail}` : "";
  const round = item.logRound ? `[${item.logRound}] ` : "";
  return `${icon} ${round}${item.logLabel}${detail}`;
}

export function TopTicker({ latestItem, items, unreadCount, isExpanded, onToggleExpand }: TopTickerProps) {
  // Design note #5: last HISTORY_LINE_COUNT of the already-filtered items,
  // oldest-to-newest so the most recent entry reads at the bottom (the
  // scroll body auto-scrolls there below).
  const historyItems = items.slice(Math.max(0, items.length - HISTORY_LINE_COUNT));

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isExpanded) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [isExpanded, historyItems.length]);

  return (
    <div style={styles.root}>
      <button
        type="button"
        style={{ ...styles.headerRow, ...(isExpanded ? styles.headerRowOpen : {}) }}
        onClick={onToggleExpand}
        aria-expanded={isExpanded}
        aria-label="Expand or collapse the chat and activity history"
      >
        <span style={styles.previewText}>
          {latestItem ? previewText(latestItem) : "No activity yet — click to expand the history."}
        </span>
        {!isExpanded && unreadCount > 0 && (
          <span style={styles.unreadBadge}>{unreadCount > 99 ? "99+" : unreadCount}</span>
        )}
        <span style={styles.expandHint}>{isExpanded ? "▲ Collapse" : "▼ Expand"}</span>
      </button>

      {/* Design note #5: in-place accordion body, no modal/backdrop.
          Design note #21: JUST the scrollable history list now -- no
          settings/checkbox/toggle UI of any kind. */}
      {isExpanded && (
        <div style={styles.body}>
          <div style={styles.historyList} ref={listRef}>
            {historyItems.length === 0 && <p style={styles.emptyHint}>Nothing here yet.</p>}
            {historyItems.map((item) =>
              item.kind === "chat" ? <ChatEntry key={item.id} item={item} /> : <LogEntry key={item.id} item={item} />,
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default TopTicker;

/* ------------------------------------------------------------------ */
/* Entry renderers -- ported from FeedOverlay.tsx's own design notes  */
/* #3/#4, unchanged other than living here now.                       */
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
      {/* Design note #343: the round this happened in, ahead of the label.
          Muted and monospaced so a column of them lines up and reads as a
          gutter rather than as part of each sentence. */}
      {item.logRound && <span style={styles.logRound}>[{item.logRound}]</span>}
      <span style={styles.logLabel}>{item.logLabel}</span>
      <span style={styles.timestamp}>{item.timestampLabel}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inline styles                                                      */
/* ------------------------------------------------------------------ */

// Design note #7: dark slate #1E293B for the header row (flowing directly
// out of the active nav tab above it, which now shares this exact color --
// see App.tsx design note #20/item 3), #0F172A for the recessed expanded
// body beneath it.
const styles: Record<string, React.CSSProperties> = {
  root: {
    width: "100%",
    backgroundColor: "#1E293B",
    boxSizing: "border-box",
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    width: "100%",
    minHeight: "52px",
    padding: "16px 28px",
    backgroundColor: "#1E293B",
    border: "none",
    color: "#F8FAFC",
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE.strong,
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "left",
    boxSizing: "border-box",
  },
  headerRowOpen: {
    backgroundColor: "#243247",
  },
  previewText: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  unreadBadge: {
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    minWidth: "24px",
    height: "24px",
    padding: "0 8px",
    borderRadius: "999px",
    backgroundColor: "#c0392b",
    color: "#ffe8e8",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  expandHint: {
    fontSize: FONT_SIZE.body,
    fontWeight: 600,
    color: "#9aa0ac",
    flexShrink: 0,
  },
  // ---- In-place accordion body -- design note #5. ----
  body: {
    backgroundColor: "#0F172A",
    borderTop: "1px solid #2a3a52",
    display: "flex",
    flexDirection: "column",
  },
  // ---- Scrollable ~7-line history -- design note #5. ----
  historyList: {
    maxHeight: `${HISTORY_LINE_COUNT * HISTORY_LINE_HEIGHT_PX}px`,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px 20px",
  },
  emptyHint: {
    fontSize: FONT_SIZE.control,
    color: "#6f7480",
    margin: 0,
  },
  // ---- Chat entries -- ported from FeedOverlay.tsx design note #3. ----
  chatEntry: {
    // Longhand: the JSX below applies a per-author `borderLeftColor`
    // inline, and overriding a longhand onto a shorthand is exactly the
    // mix React warns about.
    borderLeftWidth: "3px",
    borderLeftStyle: "solid",
    borderLeftColor: "#3a3f4b",
    backgroundColor: "#182236",
    borderRadius: "0 10px 10px 10px",
    padding: "6px 12px",
  },
  chatEntryHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
  },
  chatAuthor: {
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
  },
  chatText: {
    fontSize: FONT_SIZE.body,
    color: "#c7cbd4",
    marginTop: "1px",
  },
  // ---- Log entries -- ported from FeedOverlay.tsx design note #4. ----
  logEntry: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "5px 12px",
    backgroundColor: "#141c2c",
    border: "1px solid #1e2937",
    borderRadius: "999px",
    fontSize: FONT_SIZE.body,
  },
  logCategoryBadge: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: "999px",
    backgroundColor: "#1e293b",
    color: "#9aa0ac",
    whiteSpace: "nowrap",
  },
  logStatusIcon: {
    fontSize: FONT_SIZE.small,
  },
  logRound: {
    fontSize: FONT_SIZE.micro,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#6f7480",
    flexShrink: 0,
  },
  logLabel: {
    flex: 1,
    color: "#c7cbd4",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  timestamp: {
    fontSize: FONT_SIZE.small,
    color: "#6f7480",
    flexShrink: 0,
  },
};
