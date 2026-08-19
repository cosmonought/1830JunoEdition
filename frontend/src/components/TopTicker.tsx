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
//    this component renders them all, so filtering "instantly filters both
//    the single-line preview AND the expanded history view" (this pass's
//    own requirement) by construction: both this component's `latestItem`
//    prop and its `items` prop come from the same filtered source in
//    App.tsx. (It USED to slice the last `HISTORY_LINE_COUNT` entries here;
//    design note #476 removed that -- the panel now holds the whole game.)
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

/** How many rows the scroll body is TALL. Design note #476: not how many it
 *  holds -- it holds the whole game. */
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
  /* ==================================================================
   *  DESIGN NOTE 598: THE DOCK IS A STATUS LINE, SO IT IS ONE LINE
   * ==================================================================
   *
   * REPORTED: "the Chat/Activity log at the bottom needs to be slimmed down:
   * it's bigger than the traveling Action bar and ostensibly less useful."
   *
   * Both halves of that are true and the second explains the first. Design
   * note #581 docked this to the bottom edge precisely BECAUSE it is
   * peripheral -- "readable without ever demanding attention" -- and then
   * left it three rows tall: a 52px ticker, a permanent chat input, and a
   * row of filter pills. A peripheral surface taller than the primary one is
   * not peripheral.
   *
   * OPTION (b) FROM THE REPORT, taken as offered: "only show the ticker,
   * remove the log filters, and leave a 'Chat' button that opens the text
   * box below the ticker." The filters go with the input -- filtering is a
   * thing you do while READING the log, so they belong in the expanded view
   * and are noise on a one-line status strip.
   *
   * The toggle lives INSIDE the ticker's own header row rather than beside
   * it, because a second row for one button would be the problem again. */
  chatOpen?: boolean;
  onToggleChat?: () => void;
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
    // Design note #477: the same gutter. The log and the chat interleave in
    // one feed, so a line that skipped the prefix would break the column
    // the whole format exists to create.
    return `${clockPrefix(item)}${item.chatAuthor}: "${item.chatText}"`;
  }
  const round = item.logRound ? `[${item.logRound}] ` : "";
  /* Design note #425: the FULL detail, not a 40-character preview of it.
     The truncation existed because this string had to survive in a
     single-line ticker; the ticker clips with CSS `text-overflow` instead,
     which shortens the DISPLAY without shortening the sentence the
     expanded view then renders in full. */
  const detail = item.logDetail ? ` — ${item.logDetail}` : "";
  const failed = item.logStatus === "error" ? "Failed: " : "";
  return `${clockPrefix(item)}${round}${failed}${item.logLabel}${detail}`;
}

/* ==================================================================
 *  DESIGN NOTE 477: THE TIME LEADS
 * ==================================================================
 *
 * REPORTED: the timestamp sits at the end of the line; the format should be
 * `[hh:mm] [Phase/Round] [Actor] [Action]`.
 *
 * WHY THE FRONT IS RIGHT and not merely requested. The expanded history is
 * now the whole game (design note #476), so it is a column of entries a
 * player scrolls to find something in. A column is scanned down its LEFT
 * edge, and the two facts that locate an entry -- when, and in which round
 * -- were the two furthest from it: the round was second, and the time was
 * past the end of a sentence of variable length, so it landed in a
 * different column on every row and could not be scanned at all.
 *
 * Leading with both puts a fixed-width gutter down the left of the log:
 * `[14:32] [OR 1]` is the same shape on every line, and the prose starts
 * where the eye already is.
 *
 * hh:mm, NOT hh:mm:ss. `timestampLabel` is a full `toLocaleTimeString()`,
 * which carries seconds -- three characters of precision nobody needs about
 * a board game and enough width to unbalance the gutter. Seconds are
 * dropped for DISPLAY only; `timestampMs` remains the sort key
 * (`feed.ts` design note on why the label was never one).
 *
 * PARSED RATHER THAN REFORMATTED FROM THE EPOCH, deliberately. The label is
 * already localised -- 12-hour with an am/pm suffix in some locales, 24-hour
 * in others -- and re-deriving it from `timestampMs` here would impose this
 * module's idea of a locale on a string the rest of the app formats
 * elsewhere. Trimming what is there keeps one formatter.
 *
 * ANY LABEL IT CANNOT PARSE IS PASSED THROUGH WHOLE. A locale this regex
 * does not anticipate produces a slightly wider gutter, which is a
 * cosmetic defect; dropping the time entirely, or emitting `[Invalid
 * Date]`, would not be. */
export function clockPrefix(item: FeedItem): string {
  const label = item.timestampLabel;
  if (!label) return "";
  // `14:32:07` -> `14:32`; `2:32:07 PM` -> `2:32 PM`.
  const trimmed = label.replace(/^(\d{1,2}:\d{2}):\d{2}/, "$1");
  return `[${trimmed}] `;
}

export function TopTicker({
  latestItem,
  items,
  unreadCount,
  isExpanded,
  onToggleExpand,
  chatOpen = false,
  onToggleChat,
}: TopTickerProps) {
  // Design note #5: the already-filtered items, oldest-to-newest so the most
  // recent entry reads at the bottom (the scroll body auto-scrolls there
  // below).
  /* ==================================================================
   *  DESIGN NOTE 476: THE WHOLE GAME, NOT THE LAST SEVEN LINES
   * ==================================================================
   *
   * REPORTED: the Activity Log truncates and retains only the last handful
   * of entries.
   *
   * The STATE was never truncated -- `setActionLog` has always prepended
   * without a cap. What threw the history away was this line: the expanded
   * panel sliced the last `HISTORY_LINE_COUNT` items before rendering them,
   * so everything older existed in memory and could not be reached by
   * scrolling because it was never in the DOM to scroll to.
   *
   * That made the scroll container a lie. It had `overflowY: auto` and a
   * `maxHeight` of exactly seven lines, so it looked scrollable and had
   * nothing above the fold -- the one arrangement where a scrollbar never
   * appears and the player concludes the log simply forgets.
   *
   * `HISTORY_LINE_COUNT` survives as what it always physically was: the
   * VIEWPORT height, in lines. It sizes the box; it no longer decides what
   * exists.
   *
   * THE COST IS BOUNDED IN PRACTICE. A full 1830 game is a few hundred
   * entries, each a short string -- well inside what a list renders without
   * complaint. If a very long session ever makes this heavy the answer is
   * windowing, which needs the full array to window OVER; truncating the
   * source would remain the wrong fix. */
  const historyItems = items;

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isExpanded) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    // Design note #476: with the full history rendered the newest entry is
    // at the bottom of a potentially long list, so this is what puts the
    // player at "now" when they open the panel rather than at the start of
    // the game.
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
        {/* Design note #600: the hole the Chat button sits in. See the styles
            block -- this is the half that keeps the two controls apart. */}
        {onToggleChat && <span style={styles.chatToggleSlot} aria-hidden="true" />}
        <span style={styles.expandHint}>{isExpanded ? "▲ Collapse" : "▼ Expand"}</span>
      </button>
      {/* Design note #598: OUTSIDE the header button, not inside it -- a
          button nested in a button is invalid markup and the click would
          toggle both. Absolutely positioned so it costs the row no height. */}
      {onToggleChat && (
        <button
          type="button"
          style={{ ...styles.chatToggle, ...(chatOpen ? styles.chatToggleOpen : {}) }}
          onClick={onToggleChat}
          aria-expanded={chatOpen}
          title={chatOpen ? "Hide the message box." : "Send a message to the table."}
        >
          Chat
        </button>
      )}

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

/* ==================================================================
 *  DESIGN NOTE 458: THE LATEST LINE, WHERE THE PLAYER IS LOOKING
 * ==================================================================
 *
 * REPORTED: the Activity Log ticker scrolls out of view when scrolling
 * down the page, so the most recent instruction is lost exactly when the
 * player is working on the map or the tables below it.
 *
 * The ticker sits in the page chrome at the top, above the tab bar, and
 * scrolls away with it. The action bar directly below is `position:
 * sticky` (design note #426) and does not. So the fix is not to make a
 * second ticker sticky -- it is to put the one line that matters inside
 * the element that already stays.
 *
 * ONE LINE, NOT THE PANEL. This renders `feedItemText` and nothing else:
 * no expansion, no history, no chat input. The full ticker is still the
 * place to read back through what happened; this answers only "what just
 * happened", which is the question a player scrolling the board has.
 *
 * IT SHARES THE FORMATTER, so the sticky copy and the ticker cannot
 * disagree about the sentence -- design note #425 made that one string for
 * exactly this class of reason, and this is the third surface to read it.
 *
 * CLICKABLE, because a player who reads a truncated line needs somewhere to
 * go. `onExpand` scrolls them back to the full ticker rather than opening a
 * second copy of it. */
export function StickyTickerLine({
  latestItem,
  onExpand,
}: {
  latestItem: FeedItem | null;
  onExpand?: () => void;
}) {
  if (!latestItem) return null;
  return (
    <button
      type="button"
      style={styles.stickyLine}
      onClick={onExpand}
      title={`${feedItemText(latestItem)}\n\nClick to open the full activity log.`}
    >
      <span style={styles.stickyLineDot} aria-hidden="true" />
      <span style={styles.stickyLineText}>{feedItemText(latestItem)}</span>
    </button>
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
        {/* Design note #477: the clock LEADS here too. The log rows and the
            chat rows interleave in one scrolling column, so a chat row whose
            time sat on the right would break the left gutter every log row
            above and below it lines up on. */}
        <span style={styles.timestamp}>{clockPrefix(item).trim()}</span>
        <span style={{ ...styles.chatAuthor, color }}>{item.chatAuthor}</span>
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
      {/* Design note #477: no trailing timestamp. It leads the string now,
          and printing it at both ends would be the same fact twice on every
          line -- once in the gutter the format exists to create and once
          past the end of the sentence, where it was unscannable. */}
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
/* ==================================================================
 *  DESIGN NOTE 600: THE CHAT BUTTON WAS SITTING ON "EXPAND"
 * ==================================================================
 *
 * REPORTED: 'the "Chat" button sits on top of the Expand/Collapse words and
 * should be bumped left of that.'
 *
 * Correct, and the cause is design note #598's own fix. The Chat toggle HAS
 * to live outside the header element, because that element is a `<button>`
 * and a button cannot contain a button. #598 solved the nesting by taking
 * the toggle out of the flow entirely -- `position: absolute; right: 10px`.
 * But `expandHint` is the last flex child of that same full-width header
 * button, so it renders at the row's right edge too, 14px in. Two controls,
 * one corner, neither aware of the other. The overlap was not a near-miss;
 * it was guaranteed by construction.
 *
 * ABSOLUTE POSITIONING CANNOT BE UNDONE HERE -- the nesting rule is real, so
 * the toggle stays out of flow. What was missing is that nothing in the flow
 * KNEW about it. So the row now reserves the space: `chatToggleSlot` is an
 * empty, aria-hidden flex item of exactly the toggle's width, and the toggle
 * is positioned into it.
 *
 * WHICH MEANS THE THREE NUMBERS BELOW MUST AGREE, and that is the whole
 * reason they are named constants rather than literals at four call sites.
 * The toggle's offset from the right edge is the row's padding, plus the
 * hint's width, plus the flex gap between them -- change any one of those in
 * `headerRow` and this arithmetic has to move with it.
 *
 * `EXPAND_HINT_WIDTH` IS FIXED FOR A SECOND REASON. The label flips between
 * "▼ Expand" and "▲ Collapse", which are different widths -- so a hint sized
 * by its content would shift the reserved slot every time the panel opened,
 * dragging the Chat button sideways under the cursor mid-click. Pinning the
 * width to the longer of the two labels also stops the row twitching on
 * every toggle, which it did before and nobody had named.
 *
 * A SLOT ALSO FIXES A QUIETER BUG: `previewText` is `flex: 1` and was
 * measuring the full row, so a long activity line ellipsised UNDER the Chat
 * button rather than before it. The reserved item shortens the flex basis,
 * so the ellipsis now lands where the text actually stops being visible. */
const ROW_PAD_X_PX = 14;
const ROW_GAP_PX = 10;
/** Sized to "▲ Collapse", the longer of the two labels, at 13px/600. */
const EXPAND_HINT_WIDTH_PX = 78;
const CHAT_TOGGLE_WIDTH_PX = 54;

const styles: Record<string, React.CSSProperties> = {
  /* ==================================================================
   *  DESIGN NOTE 457: THE LOG BELONGS TO THE CHAT, NOT TO THE TABS
   * ==================================================================
   *
   * REPORTED: the ticker's background matches the tab bar above it, so it
   * is easy to miss.
   *
   * It matched because it was chosen to. Design note #20 paired the
   * ticker's header (`#1E293B`) with the tab bar's active tab, on the
   * reasoning that both are chrome. The consequence is that the one line on
   * screen carrying "what just happened" reads as a continuation of the
   * navigation -- an area the eye has already learned to skip, because
   * nothing in it ever changes.
   *
   * IT BELONGS DOWNWARD. Below the ticker is `InlineQuickChat`, and the two
   * are one conversation: the log is what the game said, the chat is what
   * the players said, and expanding the ticker shows them interleaved in a
   * single feed. Grouping it with the thing it is part of costs nothing and
   * gives it an edge the tabs do not share.
   *
   * A LEFT ACCENT RATHER THAN A BRIGHTER FILL. Raising the whole surface
   * would have made the newest game event the loudest thing on the page,
   * competing with the board. A 3px rule down the live edge separates it
   * from the tabs without shouting, and it is the same device the chat
   * entries already use to mark an author. */
  root: {
    // Design note #598: `relative`, so the Chat toggle can pin to this
    // strip's right edge without leaving the dock.
    position: "relative",
    width: "100%",
    backgroundColor: "#131a27",
    borderTop: "1px solid #0b1119",
    borderLeft: "3px solid #2f6f6a",
    boxSizing: "border-box",
  },
  /* Design note #598: 52px/16px was a HEADER's proportions on a strip that
     is a status line. A third of the height, and the padding with it -- the
     text is the same size, it simply is not swimming any more. */
  headerRow: {
    display: "flex",
    alignItems: "center",
    // Design note #600: these two feed the Chat toggle's offset. Not literals.
    gap: `${ROW_GAP_PX}px`,
    width: "100%",
    minHeight: "30px",
    padding: `4px ${ROW_PAD_X_PX}px`,
    // Design note #457: transparent, so the row takes the root's own
    // surface rather than reasserting the tab bar's.
    backgroundColor: "transparent",
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
  /* Design note #600: the empty flex item the toggle is positioned into. It
     draws nothing and is `aria-hidden` -- its entire job is to be the width
     the toggle occupies, so the flow accounts for a control it cannot
     contain. `flexShrink: 0` because a slot that can be squeezed is not a
     reservation. */
  chatToggleSlot: {
    width: `${CHAT_TOGGLE_WIDTH_PX}px`,
    flexShrink: 0,
  },
  /* Design note #600: parked in `chatToggleSlot`, LEFT of the expand hint --
     `right` is the row's padding, plus the hint, plus the gap between them.
     Design note #598's original `right: 10px` put it on top of the hint.

     Vertically centred by transform rather than a magic `top: 3px`, so the
     control stays centred if `headerRow`'s min-height or the toggle's own
     padding ever moves. */
  chatToggle: {
    position: "absolute",
    right: `${ROW_PAD_X_PX + EXPAND_HINT_WIDTH_PX + ROW_GAP_PX}px`,
    top: "50%",
    transform: "translateY(-50%)",
    width: `${CHAT_TOGGLE_WIDTH_PX}px`,
    boxSizing: "border-box",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "3px 0",
    borderRadius: "6px",
    border: "1px solid #2f3646",
    backgroundColor: "#1b2130",
    color: "#9aa0ac",
    cursor: "pointer",
    textAlign: "center",
    zIndex: 1,
  },
  chatToggleOpen: { borderColor: "#4d8ee0", color: "#cfe2ff", backgroundColor: "#1d3a55" },
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
  /* Design note #600: a FIXED width, right-aligned. Sizing to content would
     move the reserved slot -- and with it the Chat button -- every time the
     label flipped between "Expand" and "Collapse". */
  expandHint: {
    width: `${EXPAND_HINT_WIDTH_PX}px`,
    textAlign: "right",
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
    /* Design note #476: the VIEWPORT, not the retention. Seven lines of
       box, scrolling over however many entries the game has produced. */
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
  /* Design note #458: one clipped line inside the sticky action bar. It
     must never wrap -- the bar has a fixed height band (design note #426's
     `maxHeight`), and a two-line log entry would push the controls out of
     it. Ellipsis rather than a scrollbar: the full text is one click away
     and a scrolling sliver of text in a toolbar is unreadable. */
  stickyLine: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: 0,
    maxWidth: "100%",
    padding: "2px 8px",
    borderRadius: "6px",
    border: "1px solid transparent",
    backgroundColor: "transparent",
    color: "#9aa2b1",
    font: "inherit",
    fontSize: FONT_SIZE.micro,
    textAlign: "left",
    cursor: "pointer",
  },
  stickyLineDot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    backgroundColor: "#2f6f6a",
    flexShrink: 0,
  },
  stickyLineText: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
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
