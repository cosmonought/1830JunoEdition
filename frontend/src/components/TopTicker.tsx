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
import { colorForAuthor } from "../utils/feed";
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

/* ==================================================================
 *  DESIGN NOTE 425: ONE STRING, AND NO PICTURES IN IT
 * ==================================================================
 *
 * REPORTED: make the expanded history render the full text string,
 * identical to the ticker -- e.g. "[OR 1] Private Revenue — Schuylkill
 * Valley pays $5 to Alice" -- and remove every emoji and graphical badge
 * from the log, relying on clean text alone.
 *
 * TWO RENDERERS, TWO DIFFERENT SENTENCES. The collapsed ticker built its
 * line here, in `previewText`; the expanded list built a different one in
 * `LogEntry` out of separate spans. They agreed about nothing: the ticker
 * appended `logDetail` (when short enough) and the list dropped it entirely
 * in favour of a hover `title`; the list rendered a category badge the
 * ticker had never heard of; both prefixed a status emoji, from the same
 * helper, in different positions. Expanding the panel to read a line in
 * full showed the reader a line they had not been reading.
 *
 * So the string is built ONCE, here, and both surfaces render exactly it.
 * "Identical to the ticker" is now structural rather than a thing to keep
 * in step by hand.
 *
 * THE EMOJI ARE GONE, ALL OF THEM. `iconForLogStatus`'s coloured circles
 * and `iconForLogEntry`'s category glyphs are no longer called from this
 * file. They were carrying real information badly: a green circle means
 * "succeeded", which in a log of things that have already happened is true
 * of nearly every line, so the column was a near-constant costing horizontal
 * space in a one-line ticker. The category badge was worse -- it was
 * inferred by substring-matching the label ("tile", "stock", "train"), so
 * it restated a word already visible in the sentence beside it, and
 * mis-tagged whenever a label happened to contain someone else's keyword.
 *
 * ERRORS KEEP THEIR MARK, IN WORDS. Dropping the status glyph would have
 * lost the one status that is not the default, so a failed action now says
 * so in text. That is the whole of what the circles were for.
 *
 * THE ROUND PREFIX STAYS `[OR 1]` and leads the line, matching the
 * requirement's example exactly. It is the only bracketed element left, so
 * it reads as a gutter rather than as one badge among several. */
export function feedItemText(item: FeedItem): string {
  if (item.kind === "chat") {
    return `${item.chatAuthor}: "${item.chatText}"`;
  }
  const round = item.logRound ? `[${item.logRound}] ` : "";
  /* Design note #425: the FULL detail, not a 40-character preview of it.
     The truncation existed because this string had to survive in a
     single-line ticker; the ticker clips with CSS `text-overflow` instead,
     which shortens the DISPLAY without shortening the sentence the
     expanded view then renders in full. */
  const detail = item.logDetail ? ` — ${item.logDetail}` : "";
  const failed = item.logStatus === "error" ? "Failed: " : "";
  return `${round}${failed}${item.logLabel}${detail}`;
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
          {latestItem ? feedItemText(latestItem) : "No activity yet — click to expand the history."}
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
  /* Design note #425: the SAME string the ticker shows, rendered whole.
     One span, because the sentence is one sentence -- the badge, the status
     glyph and the separately-styled round prefix are all gone, and with
     them the four-column layout that made this row a different artefact
     from the line it was supposed to be expanding.

     `whiteSpace: normal` on `logLabelFull` is the actual "render the full
     text" half: the collapsed ticker clips with ellipsis because it has one
     line, and this wraps because it does not. */
  return (
    <div style={styles.logEntry}>
      <span
        style={{
          ...styles.logLabelFull,
          ...(item.logStatus === "error" ? styles.logLabelError : {}),
        }}
      >
        {feedItemText(item)}
      </span>
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
    /* `flex-start`, not `center`: the label can now be several lines and a
       centred timestamp beside a three-line sentence floats in the middle
       of it. */
    alignItems: "flex-start",
    gap: "10px",
    padding: "6px 12px",
    backgroundColor: "#141c2c",
    border: "1px solid #1e2937",
    /* Design note #425: a rounded rectangle, not a 999px pill. The pill
       shape was built for a single clipped line; on wrapped text it bows
       the left and right edges away from the words. */
    borderRadius: "8px",
    fontSize: FONT_SIZE.body,
  },
  /* `logCategoryBadge`, `logStatusIcon`, `logRound` and `logLabel` were all
     DELETED by design note #425. They were the four columns of a row that
     no longer exists: an inferred category pill, a status emoji, a
     separately-styled round prefix, and a one-line clipped label. The round
     prefix survives inside the string itself, which is what makes the
     expanded line identical to the ticker's.

     Deleted rather than left unused -- an orphaned badge style is an
     invitation to render a badge again, which is the thing this pass was
     asked to remove. */
  logLabelFull: {
    flex: 1,
    color: "#c7cbd4",
    /* THE POINT OF THE WHOLE CHANGE. The ticker's own line clips to one
       row; here the text wraps and the entry grows, so a long entry is
       readable in full rather than ending in an ellipsis the reader
       expanded the panel specifically to get past. */
    whiteSpace: "normal",
    overflowWrap: "anywhere",
    lineHeight: 1.45,
  },
  /* Design note #425: the one status that is not the default, in colour
     AND in the words "Failed:" that `feedItemText` prepends -- so it
     survives being copied out of the panel as plain text, which a coloured
     glyph never did. */
  logLabelError: { color: "#f0a3a3" },
  timestamp: {
    fontSize: FONT_SIZE.small,
    color: "#6f7480",
    flexShrink: 0,
  },
};
