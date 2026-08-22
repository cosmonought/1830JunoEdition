// frontend/src/components/TopTicker.tsx
//
// The activity ticker: a one-line status strip that expands in place into a scrollable history.
// Supersedes `FeedOverlay.tsx`'s old modal entirely (`App.tsx #20`).
//
// Design note #1: presentational only -- every prop is derived or owned by `App.tsx`, the single owner of
// the chat and action log. The unread badge double-guards on `!isExpanded` itself so it can never flash
// visible for one render during a transition.
// Design note #5: `items` is the FILTERED array `App.tsx` already computes, so filtering the preview and
// the history is one thing by construction rather than two kept in step.
// Design note #6: the notification toggles are gone -- both turn-alert channels are mandatory (`App.tsx
// #21`), and the expanded body is JUST the scrollable list.
// Design note #7: no border-radius, shadow or backdrop. This is an in-place section of the page, not a
// floating card.
//
// Design notes #425/#457/#458/#476/#477/#598/#600/#614-#616: `docs/ai_architecture/ui_shell_layout.md`.

import React, { useEffect, useRef } from "react";
import type { FeedItem } from "../utils/feed";
import { colorForAuthor } from "../utils/feed";
import { FONT_FAMILY, FONT_SIZE } from "../styles/typography";

/* Design note #615: FIVE ROWS, NOW THAT FIVE ROWS IS NOT A LIMIT. Seven was never chosen as a reading
   height -- #476 found this constant being used to TRUNCATE the history and left it at seven while
   converting it into a viewport. At the time the number decided what existed, so shrinking it would have
   thrown entries away. It decides nothing now.
   Five rows is ~230px against seven's 320, which takes the open dock from about half a laptop viewport to
   under a third. NOT LOWER THAN FIVE: a log you have to scroll every second entry is a log you stop
   opening, and five holds a full turn's worth of actions on one screen. */
const HISTORY_LINE_COUNT = 5;
// Bumped 36 -> 46 alongside the typography scale. This is the per-row
// figure `HISTORY_LINE_COUNT` multiplies: leaving it while row TEXT grew
// would have shown fewer rows than asked for and clipped the last one
// mid-glyph.
const HISTORY_LINE_HEIGHT_PX = 46;

export interface TopTickerProps {
  latestItem: FeedItem | null;
  /** Already filtered by the active feed filter -- see design note #5. */
  items: readonly FeedItem[];
  /** Design note #616: unread CHAT MESSAGES, not unread feed items. Log entries are a record to consult
   *  rather than a queue to clear, and counting them gave a badge that read four digits and meant nothing.
   *  Counted off the UNFILTERED feed by the caller, so a player filtered to "log" is still told a message
   *  arrived. */
  unreadCount: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  /* Design note #598: THE DOCK IS A STATUS LINE, SO IT IS ONE LINE. #581 docked this to the bottom edge
     precisely BECAUSE it is peripheral -- "readable without ever demanding attention" -- and then left it
     three rows tall. A peripheral surface taller than the primary one is not peripheral.
     The filters go with the input: filtering is a thing you do while READING the log, so they belong in the
     expanded view and are noise on a one-line status strip. The toggle lives INSIDE the header row, because
     a second row for one button would be the problem again. */
  chatOpen?: boolean;
  onToggleChat?: () => void;
}

/* Design note #425: ONE STRING, AND NO PICTURES IN IT. Two renderers built two different sentences -- the
   ticker appended the detail when short enough while the list dropped it for a hover `title`, the list
   rendered a category badge the ticker had never heard of, and both prefixed a status emoji in different
   positions. Expanding the panel to read a line in full showed the reader a line they had not been reading.
   So the string is built ONCE and both surfaces render exactly it.
   THE EMOJI ARE GONE, ALL OF THEM. A green circle means "succeeded", which in a log of things that have
   already happened is true of nearly every line -- a near-constant costing horizontal space in a one-line
   ticker. The category badge was worse: inferred by substring-matching the label, so it restated a word
   already visible beside it and mis-tagged whenever a label contained someone else's keyword.
   ERRORS KEEP THEIR MARK, IN WORDS -- that is the whole of what the circles were for.
   THE ROUND PREFIX STAYS `[OR 1]` and leads the line: the only bracketed element left, so it reads as a
   gutter rather than as one badge among several. */
export function feedItemText(item: FeedItem): string {
  if (item.kind === "chat") {
    // Design note #477: the same gutter. The log and the chat interleave in
    // one feed, so a line that skipped the prefix would break the column
    // the whole format exists to create.
    return `${clockPrefix(item)}${item.chatAuthor}: "${item.chatText}"`;
  }
  const round = item.logRound ? `[${item.logRound}] ` : "";
  /* Design note #425: the FULL detail, not a 40-character preview. The truncation existed because this string
     had to survive in a single-line ticker; the ticker clips with CSS `text-overflow` instead, which shortens
     the DISPLAY without shortening the sentence the expanded view then renders in full. */
  const detail = item.logDetail ? ` — ${item.logDetail}` : "";
  const failed = item.logStatus === "error" ? "Failed: " : "";
  return `${clockPrefix(item)}${round}${failed}${item.logLabel}${detail}`;
}

/* Design note #477: THE TIME LEADS. The expanded history is the whole game now (#476), so it is a column a
   player scrolls to find something in -- and a column is scanned down its LEFT edge, while the two facts
   that locate an entry were the two furthest from it: the round was second, and the time sat past a
   sentence of variable length, landing in a different column on every row.
   Leading with both puts a fixed-width gutter down the left: `[14:32] [OR 1]` is the same shape every line.
   hh:mm, NOT hh:mm:ss -- three characters of precision nobody needs about a board game, and enough width to
   unbalance the gutter. Dropped for DISPLAY only; the epoch remains the sort key.
   PARSED RATHER THAN REFORMATTED FROM THE EPOCH: the label is already localised, and re-deriving it here
   would impose this module's idea of a locale on a string the rest of the app formats elsewhere.
   ANY LABEL IT CANNOT PARSE IS PASSED THROUGH WHOLE. An unanticipated locale produces a slightly wider
   gutter, which is cosmetic; dropping the time entirely, or emitting `[Invalid Date]`, would not be. */
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
  // Design note #5: the already-filtered items, oldest-to-newest so the most recent reads at the bottom.
  // Design note #476: THE WHOLE GAME, NOT THE LAST SEVEN LINES. The STATE was never truncated -- what threw
  // the history away was this line, which sliced the last N items before rendering, so everything older
  // existed in memory and could not be reached by scrolling because it was never in the DOM to scroll to.
  // That made the scroll container a lie: `overflowY: auto` with a `maxHeight` of exactly seven lines is the
  // one arrangement where a scrollbar never appears and the player concludes the log simply forgets.
  // The constant survives as what it always physically was -- the VIEWPORT height, in lines.
  // THE COST IS BOUNDED IN PRACTICE: a full game is a few hundred short strings. If a long session ever makes
  // this heavy the answer is windowing, which needs the full array to window OVER.
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
      {/* Design note #614: THE HEADER IS ITS OWN POSITIONING CONTEXT. Reported as "a stray 'Chat' button in the
         expanded window" -- and it was the same button. #598 could not nest it inside the header (a button in a
         button is invalid markup), so it went `position: absolute` against the root: correct while the root WAS
         the header row and nothing else. Expanding the log makes the root the header plus a 300px scrolling body,
         and an element centred on that box lands halfway down the history.
         So the header and its satellite get their own relatively-positioned wrapper, and the Chat button is
         centred on the ROW it belongs to whatever the panel below it is doing. */}
      <div style={styles.headerBand}>
        <button
          type="button"
          style={{ ...styles.headerRow, ...(isExpanded ? styles.headerRowOpen : {}) }}
          onClick={onToggleExpand}
          aria-expanded={isExpanded}
          aria-label="Expand or collapse the chat and activity history"
        >
          {/* Design note #694: the rule reaches the COLLAPSED line too. The expanded panel is where the request
              was aimed, and applying it there alone would leave the same feed saying two different things
              about the same message depending on whether it happened to be open -- which is the half-applied
              shape #691 and #681 both cost a report to find.
              IT MATTERS MORE HERE, if anything: this one line is what a player sees while they are looking at
              the board, and "did somebody say something to me" is exactly the question a glance at it asks. */}
          <span
            style={{
              ...styles.previewText,
              ...(latestItem?.kind === "chat" ? styles.previewTextChat : {}),
            }}
          >
            {latestItem ? feedItemText(latestItem) : "No activity yet — click to expand the history."}
          </span>
          {/* Design note #616: unread CHAT, which is why the count can be
              trusted to stay small and why the title says "message". The
              `99+` cap stays anyway -- a cap that only fires in a pathological
              case is the one worth keeping. */}
          {!isExpanded && unreadCount > 0 && (
            <span
              style={styles.unreadBadge}
              title={`${unreadCount} unread message${unreadCount === 1 ? "" : "s"} from the table.`}
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
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
      </div>

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

/* Design note #458: THE LATEST LINE, WHERE THE PLAYER IS LOOKING. The ticker sits in the page chrome and
   scrolls away; the action bar below is sticky and does not. So the fix is not a second sticky ticker -- it
   is to put the one line that matters inside the element that already stays.
   ONE LINE, NOT THE PANEL: no expansion, no history, no chat input. The full ticker is still where you read
   back through what happened; this answers only "what just happened".
   IT SHARES THE FORMATTER, so the sticky copy and the ticker cannot disagree -- #425 made that one string
   for exactly this class of reason, and this is the third surface to read it.
   CLICKABLE, because a player who reads a truncated line needs somewhere to go: it scrolls them back to the
   full ticker rather than opening a second copy of it. */
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
      <span
        style={{
          ...styles.stickyLineText,
          // Design note #694: same rule, same reason -- see the preview above.
          ...(latestItem.kind === "chat" ? styles.previewTextChat : {}),
        }}
      >
        {feedItemText(latestItem)}
      </span>
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
  /* Design note #425: the SAME string the ticker shows, rendered whole. One span, because the sentence is one
     sentence -- the badge, the status glyph and the separately-styled round prefix are gone, and with them the
     four-column layout that made this row a different artefact from the line it was expanding.
     `whiteSpace: normal` is the actual "render the full text" half: the ticker clips because it has one line,
     and this wraps because it does not. */
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

// Design note #7: dark slate for the header row (flowing out of the active nav tab above it, which shares
// this exact colour), recessed slate for the expanded body beneath.
// Design note #600: THE CHAT BUTTON WAS SITTING ON "EXPAND". The toggle HAS to live outside the header,
// because that element is a `<button>` and a button cannot contain a button -- so #598 took it out of flow
// entirely. But the expand hint is the last flex child of that same full-width header, so it renders at the
// row's right edge too. Two controls, one corner, neither aware of the other: guaranteed by construction.
// ABSOLUTE POSITIONING CANNOT BE UNDONE HERE -- the nesting rule is real. What was missing is that nothing
// in the flow KNEW about it, so the row now reserves the space with an empty aria-hidden flex item.
// WHICH MEANS THE THREE NUMBERS BELOW MUST AGREE, and that is why they are named constants rather than
// literals at four call sites: the offset is the row's padding, plus the hint, plus the gap.
// THE HINT WIDTH IS FIXED FOR A SECOND REASON: the label flips between "Expand" and "Collapse", which are
// different widths, so a hint sized by its content would drag the Chat button sideways under the cursor.
// A SLOT ALSO FIXES A QUIETER BUG: the preview is `flex: 1` and was measuring the full row, so a long line
// ellipsised UNDER the Chat button rather than before it.
const ROW_PAD_X_PX = 14;
const ROW_GAP_PX = 10;
/** Sized to "▲ Collapse", the longer of the two labels, at 13px/600. */
const EXPAND_HINT_WIDTH_PX = 78;
const CHAT_TOGGLE_WIDTH_PX = 54;

const styles: Record<string, React.CSSProperties> = {
  /* Design note #457: THE LOG BELONGS TO THE CHAT, NOT TO THE TABS. It matched the tab bar because #20 chose
     to pair them as chrome -- and the consequence is that the one line carrying "what just happened" reads as
     a continuation of the navigation, an area the eye has learned to skip because nothing in it ever changes.
     IT BELONGS DOWNWARD: below is `InlineQuickChat`, and the two are one conversation -- the log is what the
     game said, the chat is what the players said, and expanding shows them interleaved in a single feed.
     A LEFT ACCENT RATHER THAN A BRIGHTER FILL: raising the whole surface would make the newest game event the
     loudest thing on the page. A 3px rule down the live edge is the same device the chat entries already use. */
  root: {
    /* Design note #614: NOT `relative` any more. It was, so the Chat toggle
       could anchor here -- and that is precisely how the toggle ended up in
       the middle of the expanded log. The anchor moved to `headerBand`; this
       element is once again just the dock's column. */
    width: "100%",
    /* Design note #614: a column, and one that can be SHORTER than its
       content wants. The header band is `flex: none` and the body is the
       flexible one, so on a short viewport the history list gives up rows
       and the collapse control stays exactly where it is. */
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    backgroundColor: "#131a27",
    borderTop: "1px solid #0b1119",
    borderLeft: "3px solid #2f6f6a",
    boxSizing: "border-box",
  },
  /* Design note #614: the header row and the Chat button that overlays it,
     as one positioning context. `flex: none` so the band keeps its height
     when the body beside it is being squeezed -- the collapse control must
     never be the thing that gets shortened. */
  headerBand: {
    position: "relative",
    width: "100%",
    flex: "none",
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
  /* Design note #694: the one-line forms share this, so the collapsed ticker and the sticky line cannot
     disagree about whether a message is a message. Weight only -- the expanded panel's chat row has a colour,
     a border and a background to distinguish it, and a single line in a bar has none of those to spare. */
  previewTextChat: { fontWeight: 700 },
  /* Design note #600: the empty flex item the toggle is positioned into. It draws nothing and is
     `aria-hidden` -- its entire job is to be the width the toggle occupies, so the flow accounts for a control
     it cannot contain. `flexShrink: 0` because a slot that can be squeezed is not a reservation. */
  chatToggleSlot: {
    width: `${CHAT_TOGGLE_WIDTH_PX}px`,
    flexShrink: 0,
  },
  /* Design note #600: parked in the reserved slot, LEFT of the expand hint -- `right` is the row's padding,
     plus the hint, plus the gap. #598's original put it on top of the hint.
     Vertically centred by transform rather than a magic `top: 3px`, so the control stays centred if the row's
     min-height or the toggle's own padding ever moves. */
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
    // Design note #614: the part that yields when the dock is capped.
    flex: "1 1 auto",
    minHeight: 0,
  },
  // ---- Scrollable ~5-line history -- design notes #5 and #615. ----
  historyList: {
    /* Design note #476: the VIEWPORT, not the retention. A few lines of
       box, scrolling over however many entries the game has produced. */
    maxHeight: `${HISTORY_LINE_COUNT * HISTORY_LINE_HEIGHT_PX}px`,
    overflowY: "auto",
    /* Design note #614: `minHeight: 0` is what lets this shrink below its
       content on a short viewport. Without it a flex child refuses to go
       under its content height and pushes the overflow up the chain -- onto
       the dock, which used to answer by scrolling the header out of sight. */
    flex: "1 1 auto",
    minHeight: 0,
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
  /* Design note #694: A PERSON SPEAKING, IN A COLUMN OF NARRATION.
     Requested: chat bold, activity log plain. The log was already plain -- both were, at weight 400 in the
     same ink and the same size -- so the whole change is that the chat now carries weight and the log is left
     exactly as it was.
     THE FEED IS MOSTLY LOG, and that asymmetry is the argument. Emphasis belongs on the exception, and in a
     scrolling column where nine rows in ten are the game describing itself, the one row that is a human
     talking is the one worth catching an eye that is not currently reading.
     WEIGHT RATHER THAN COLOUR, and it is the fourth mark this row carries -- after the author's own colour,
     the coloured left border and the tinted background. The first three all live at the row's EDGES, which is
     what a reader scanning down a fast-moving column looks past. Weight is the only signal that survives in
     the text itself, and the text is what the reader is actually there for.
     THE INK IS UNCHANGED. Bold and brighter would be two changes for one purpose, and `#c7cbd4` is already
     the panel's reading colour -- lifting it too would push chat past "notable" into "alarming", which is what
     the app reserves for a contested auction and a failed action. */
  chatText: {
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
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
  /* Design note #425: the four columns of the old expanded row are DELETED -- an inferred category pill, a
     status emoji, a separately-styled round prefix and a one-line clipped label. The prefix survives inside
     the string itself, which is what makes the expanded line identical to the ticker's. Deleted rather than
     left unused: an orphaned badge style is an invitation to render a badge again.
     Design note #458: one clipped line inside the sticky bar. It must never wrap -- the bar has a fixed height
     band, and a two-line entry would push the controls out of it. Ellipsis rather than a scrollbar: the full
     text is one click away and a scrolling sliver of text in a toolbar is unreadable. */
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
