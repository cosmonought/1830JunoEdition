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
import { FONT_FAMILY, FONT_SIZE, RADIUS } from "../styles/typography";

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

/** Design note #1079: ONE alpha for both tints, named because the report's rule is that they SHARE it --
 *  "the exact same opacity/transparency value". Two literals a hundredth apart is what #1042 left behind.
 *
 *  ==================================================================
 *   DESIGN NOTE 1095: 0.12 -> 0.32, AND WHY IT STOPS THERE
 *  ==================================================================
 *
 * RULED: "increase the opacity and saturation of the red and green background tints. They need to stand out
 * clearly and 'pop' against the dark background without looking washed out."
 *
 * 0.12 WAS #1042's FIGURE AND ITS REASONING HAS EXPIRED. It argued that "under the Unpredictable Revenue
 * variant a flavour line lands on most operating turns, so a saturated fill would turn the Activity Log into
 * stripes" -- with the italic "doing most of the work" and the tint only saying which direction. But #1079
 * then removed the coloured ink, and this batch moves the fill to the whole row, so the tint is now the
 * ONLY thing carrying direction. A signal doing the whole job cannot be the quietest thing on the row.
 *
 * 0.32 IS MEASURED, NOT PICKED BY EYE. Composited over the row's `#141c2c` and checked for WCAG contrast
 * against the log's `#c7cbd4` ink, the green fill -- always the binding one, being the lighter tint -- reads:
 *
 *     0.12  8.23:1      0.26  5.78:1      0.32  4.91:1      0.36  4.41:1  FAILS AA
 *
 * So 0.32 is the largest round value with real headroom over the 4.5:1 floor, and it nearly doubles the
 * row's separation from an untinted neighbour (1.27:1 -> 2.14:1). `batch62` asserts the floor, so the next
 * person who wants more pop is told by a test where the ceiling is rather than finding it in play.
 *
 * SATURATION COMES WITH IT rather than from new hues. The blend's own saturation rises 0.35 -> 0.42 as the
 * alpha does, and #1079's argument against a fresh pair of colours stands: `#4ade80` and `#f43f5e` are
 * already this app's green and red at sixteen call sites, and a seventeenth would say what the sixteenth
 * says. */
const TONE_TINT_ALPHA = 0.32;

/* ==================================================================
    DESIGN NOTE 1095: ONE ALPHA, TWO SURFACES, TWO CORRECT RENDERINGS
   ==================================================================
   THE TWO FEED SURFACES SIT ON DIFFERENT GROUND. The expanded row paints its own `#141c2c`; the collapsed
   ticker's wrapper paints nothing and sits on the header band's `#131a27`. So one shared `rgba` would be
   right on the ticker and, on the row, would REPLACE the row's own background and composite against the
   list behind it instead -- a different colour than intended, arrived at by accident of stacking.
   SO THE ROW GETS A PRE-COMPOSITED SOLID and the ticker gets the wash, both derived from ONE alpha and ONE
   pair of hues. That is the opposite of #891: not two answers to one question, but one answer rendered
   correctly for two grounds -- and there is nothing to keep in step by hand, because both are computed.
   RULED "SOLID ... DO NOT USE GRADIENTS OR FADES", which is also #1080's epitaph: that batch reached for a
   `backgroundImage` gradient to layer a wash over the row's own fill. Compositing the two into one opaque
   colour is the same intent without the layer. */
const TONE_BONUS_RGB = [74, 222, 128] as const; // #4ade80
const TONE_MALUS_RGB = [244, 63, 94] as const; // #f43f5e
/** The expanded row's own ground, as numbers -- see `logEntry`, which paints it. */
const LOG_ROW_RGB = [20, 28, 44] as const; // #0f0f0f

/** The tint laid over the row's ground and flattened to one opaque colour. */
function toneOverRow(tint: readonly [number, number, number]): string {
  const mix = (i: number) =>
    Math.round(LOG_ROW_RGB[i] + (tint[i] - LOG_ROW_RGB[i]) * TONE_TINT_ALPHA);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

/** The same tint as a wash, for the surface that has no ground of its own to flatten against. */
function toneWash(tint: readonly [number, number, number]): string {
  return `rgba(${tint[0]}, ${tint[1]}, ${tint[2]}, ${TONE_TINT_ALPHA})`;
}

/* ==================================================================
    DESIGN NOTE 1080, WITHDRAWN: THE BACKGROUND DID NOT NEED TOUCHING
   ==================================================================
   #1080 MOVED THE FILL ONTO THE ROW, converted it to a `backgroundImage` gradient so it would layer over the
   row's own `#141c2c`, and dropped the padding and radius that then had nothing to sit on. Every one of
   those was a consequence of the first move, and the first move was mine to begin with: #1079 described the
   existing fill as sitting "on the sentence, not the whole row" and offered to widen it.

   THAT DESCRIPTION WAS WRONG. `logLabelFull` is `flex: 1`, so the tint has filled the line from the gutter
   to the right edge since #1042 -- the padding and radius shape its ends, they do not shrink-wrap it to the
   words. The offer invented a problem, the answer accepted the invention, and three edits followed from it.

   RECORDED RATHER THAN DELETED, because the lesson is one I have written down before in this file's
   neighbours and evidently not learned: I described a layout from the style object without checking what
   `flex: 1` did to it, and then acted on my own description. Reading the rendered geometry costs one
   grep. */

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
    /* Design note #477: the same gutter. The log and the chat interleave in
       one feed, so a line that skipped the prefix would break the column
       the whole format exists to create.

       ==================================================================
        DESIGN NOTE 1011: THE QUOTATION MARKS GO
       ==================================================================
       RULED: "Remove the quotation marks around player chat messages. The format should simply be:
       `[3:27 PM] P1: Hello`."

       THEY WERE DOING A JOB THAT `Author:` ALREADY DOES. The quotes marked where the player's own words began
       -- but the colon after the author marks that too, and it is the convention every chat client uses. What
       the quotes added on top was a second delimiter around text a player did not write with delimiters, so
       anything containing an apostrophe or a nested quote came out looking mis-punctuated.

       AND THEY WERE WORST ON THE SHORT LINES. A ticker clipped to one line spends its width on the message;
       two characters of it went to punctuation on every single chat entry, in the surface where width is
       scarcest. */
    return `${clockPrefix(item)}${item.chatAuthor}: ${item.chatText}`;
  }
  const round = item.logRound ? `[${item.logRound}] ` : "";
  /* Design note #1076: `feedItemText` STILL RETURNS ONE STRING, and it has to. It is the ticker's clipped
     preview, the chat's line, and what a dozen suites assert against -- so the parts-based rendering below
     is an ADDITION rather than a replacement, and `feedItemParts` is derived from the same fields so the two
     cannot describe an entry differently. */
  /* Design note #425: the FULL detail, not a 40-character preview. The truncation existed because this string
     had to survive in a single-line ticker; the ticker clips with CSS `text-overflow` instead, which shortens
     the DISPLAY without shortening the sentence the expanded view then renders in full. */
  const detail = item.logDetail ? ` — ${item.logDetail}` : "";
  const failed = item.logStatus === "error" ? "Failed: " : "";
  return `${clockPrefix(item)}${round}${failed}${item.logLabel}${detail}`;
}

/** The same line, split where the eye needs a break.
 *
 *  ==================================================================
 *   DESIGN NOTE 1076: THREE FIELDS THAT READ AS ONE LONG STRING
 *  ==================================================================
 *
 *  REPORTED: "every element of the Activity Log is printed in the same font with the same weight and
 *  emphasis: [time] [round] [information] all read as one long string. Let's make it easier on the eye to
 *  scan and bold the [round] information."
 *
 *  AND THE SECOND HALF IS THE SAME COMPLAINT: "the timestamps are the first thing players see and communicate
 *  almost nothing ... I click the log event and the timestamp appears where it currently is at the left."
 *  Both are about the LEFT GUTTER -- one column, carrying the least useful field, in the same weight as the
 *  sentence. So the gutter carries the round tag by default, in bold, and gives its place to the time only
 *  when a reader asks for it.
 *
 *  NOT DELETED, and the reason is async play: somebody comes back to a room hours later, and the log is the
 *  only record of when a round happened. A click is the whole cost of getting it back.
 *
 *  RETURNED AS DATA rather than as JSX, so this stays testable without a renderer and so the collapsed
 *  preview and the expanded row compose from one answer -- #694's rule, which #1055 had to apply to the tint
 *  for exactly the same reason. */
export interface FeedItemParts {
  /** The bold gutter: the round tag, or the time when the reader has asked for it. `""` when neither exists. */
  gutter: string;
  /** Everything after it, in the ordinary weight. */
  body: string;
  /** ==================================================================
   *   DESIGN NOTE 1079: THE FLAVOUR IS ITS OWN PART, SO IT CAN BE ITS OWN FONT
   *  ==================================================================
   *
   * RULED: "Apply italics strictly to the flavor text string at the end of the line, leaving the mechanical
   * revenue math in the standard font." A renderer holding one string cannot do that, so the string arrives
   * split -- at an index the composer stamped (`feed.ts` #1079), never at one guessed from punctuation here.
   *
   * `""` ON EVERY OTHER LINE, which is what lets both renderers write the same unconditional pair of spans
   * instead of branching. An ordinary action line is all mechanics and has no seam to mark. */
  flavour: string;
}

export function feedItemParts(item: FeedItem, showTime = false): FeedItemParts {
  if (item.kind === "chat") {
    /* A CHAT LINE'S GUTTER IS ITS CLOCK, always. It has no round tag, and #477's column is the whole reason
       the two kinds interleave legibly -- an empty gutter on every chat row would break it. */
    return {
      gutter: clockPrefix(item).trim(),
      body: `${item.chatAuthor}: ${item.chatText}`,
      // A player's own words are not our flavour text, whatever they wrote.
      flavour: "",
    };
  }
  const time = clockPrefix(item).trim();
  const round = item.logRound ? `[${item.logRound}]` : "";
  const detail = item.logDetail ? ` — ${item.logDetail}` : "";
  const failed = item.logStatus === "error" ? "Failed: " : "";
  const label = item.logLabel ?? "";
  /* ==================================================================
      DESIGN NOTE 1079: THREE CONDITIONS, AND EACH ONE IS A REAL CASE
     ==================================================================
     `> 0` -- an index of 0 means a line that is ALL flavour, which no composer produces and which would
        italicise the corporation's own name if one ever slipped through.
     `< label.length` -- an index at or past the end yields an empty tail, so the split would be invisible
        while still costing a span. Refusing it keeps "there is a flavour part" and "the flavour part has
        text in it" the same statement.
     `detail === ""` -- THE ORDERING TRAP. The detail is appended AFTER the label, so splitting a line that
        has one would put the em-dash detail between the mechanics and the flavour and italicise neither
        correctly. Nothing produces both today; this is what stops it rendering wrong the day something does,
        rather than a comment hoping nobody tries. */
  const at = item.logFlavourFrom;
  const splitAt =
    detail === "" && typeof at === "number" && at > 0 && at < label.length ? at : null;
  return {
    // The time REPLACES the tag rather than joining it: "the timestamp appears where it currently is at the
    // left", which is the column the tag is occupying.
    gutter: showTime ? time : round || time,
    body: `${failed}${splitAt === null ? label : label.slice(0, splitAt)}${detail}`,
    flavour: splitAt === null ? "" : label.slice(splitAt),
  };
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
          {/* ==================================================================
               DESIGN NOTE 1055: THE TINT REACHES THE COLLAPSED LINE TOO
              ==================================================================
              REPORTED: "when the activity log is expanded, the flavor text lines carry some formatting.
              However, they do not carry any formatting when the log is collapsed, which is how most players
              see it."
              AND #694 IS FOUR LINES ABOVE THIS, ARGUING THE SAME THING ABOUT A DIFFERENT PROPERTY: "the rule
              reaches the COLLAPSED line too ... applying it there alone would leave the same feed saying two
              different things about the same message depending on whether it happened to be open." #1042
              added the bonus/malus tone to `LogEntry` and did not follow that rule, so the variant's own
              lines were styled in the panel a player opens on purpose and plain in the one they actually
              watch.
              THE PRECEDENCE ORDER IS #1042's, UNCHANGED, and it has to be: chat after tone would let a
              flavour line borrow the chat colour, and error is a more urgent fact than which way a die
              rolled. Same sequence in both renderers, which is what stops the two drifting again. */}
          {/* ==================================================================
               DESIGN NOTE 1080: THE WRAPPER, WHICH IS THIS SURFACE'S WHOLE ENTRY
              ==================================================================
              RULED: "please tint the entire activity log entry for the Revenue Event." #1079 read the earlier
              bullet about the `[time]` and `[round]` tags as "keep the fill off the gutter" and moved this
              inward; the ruling is the other reading, and the tags' own ink was never at issue either way.
              SO IT IS BACK ON THE WRAPPER -- and the wrapper is the right target here for the same reason the
              row is in the expanded panel: it is the whole entry as this surface displays it, gutter
              included, and it is what clips the line to one row.
              #1042's PRECEDENCE RETURNS WITH IT. Chat after tone, or a flavour line could borrow the chat
              weight in this surface and not the other -- which is the drift `batch51` exists to catch. */}
          <span
            style={{
              ...styles.previewText,
              ...(latestItem?.logTone === "bonus"
                ? styles.logToneBonus
                : latestItem?.logTone === "malus"
                  ? styles.logToneMalus
                  : {}),
              ...(latestItem?.kind === "chat" ? styles.previewTextChat : {}),
            }}
          >
            {/* Design note #1076: THE SAME PARTS, for #694's reason -- "the same feed saying two different
                things about the same message depending on whether it happened to be open" is the failure this
                dock has now had twice. The preview never shows the time: it is one line at the edge of a
                board, and the click that would reveal it is spoken for by the expand toggle. */}
            {latestItem ? (
              <>
                {feedItemParts(latestItem).gutter && (
                  <span style={styles.previewGutter}>{feedItemParts(latestItem).gutter}</span>
                )}
                {/* Design note #1080: the inner tone span is GONE -- the wash moved out to the wrapper, so a
                    span whose only job was to carry it would now carry nothing. What stays is #1079's split:
                    the flavour in italic, the revenue math upright, exactly as in `LogEntry`. */}
                {feedItemParts(latestItem).body}
                {feedItemParts(latestItem).flavour && (
                  <span style={styles.logFlavourText}>{feedItemParts(latestItem).flavour}</span>
                )}
              </>
            ) : (
              "No activity yet — click to expand the history."
            )}
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
          {/* ==================================================================
               DESIGN NOTE 1012: THE PANEL OPENS UPWARD AND THE ARROWS DID NOT KNOW
              ==================================================================
              REPORTED: "The expand/collapse arrows are backwards. Reverse their rendering logic."

              THEY WERE WRITTEN FOR A PANEL THAT DROPS DOWN, which is what almost every disclosure does and
              what this one did when the arrows were chosen. `App.tsx` #614 then anchored this dock to the
              bottom edge of the viewport -- its own note says it plainly: "the box is anchored at the bottom
              rather than sized -- so the expanded history grows UPWARD instead of off the screen."

              THE ARROW NAMES A DIRECTION OF TRAVEL, not a state, because it is paired with a verb. "Expand"
              with a down arrow promised the history would appear below the line; it appears above it. So
              collapsed offers UP (press to open upward) and expanded offers DOWN (press to close downward).

              WHICH IS ALSO WHY THIS IS NOT THE DISCLOSURE-TRIANGLE CONVENTION the roster carets use
              (`PlayerCards` and `TrainPurchasePanel`: right when shut, down when open). Those report a STATE
              and have no verb beside them; this one is an instruction, and an instruction that pointed the
              wrong way was worse than no arrow at all. */}
          <span style={styles.expandHint}>{isExpanded ? "▼ Collapse" : "▲ Expand"}</span>
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
  /* Design note #1076: PER ROW, not per feed. A reader wanting the time of one entry does not want every
     other tag replaced, and a feed-wide toggle would be a setting to find rather than a click to make. */
  const [showTime, setShowTime] = React.useState(false);
  const parts = feedItemParts(item, showTime);
  /* Design note #425: the SAME string the ticker shows, rendered whole. One span, because the sentence is one
     sentence -- the badge, the status glyph and the separately-styled round prefix are gone, and with them the
     four-column layout that made this row a different artefact from the line it was expanding.
     `whiteSpace: normal` is the actual "render the full text" half: the ticker clips because it has one line,
     and this wraps because it does not. */
  return (
    /* Design note #1076: THE ROW IS THE TARGET. "I click the log event and the timestamp appears where it
       currently is at the left" -- so the whole line takes the click rather than the gutter alone, which at
       this type size is a target a few characters wide. `role="button"` and the key handler because a `div`
       that responds to a click and not to Enter is a control only a mouse can reach. */
    <div
      style={{
        ...styles.logEntry,
        /* ==================================================================
            DESIGN NOTE 1095: THE ROW IS THE TARGET, WHICH #1080 GOT RIGHT AND EARLY
           ==================================================================
           RULED: "apply the green and red background tints to the full parent row container, not just the
           text elements ... a solid, uniform block of color spanning the entire width of the line."
           IT WAS ON `logLabelFull`, WHICH IS A SIBLING OF THE GUTTER. `flex: 1` made it fill from the gutter
           to the right edge -- which is what #1080's withdrawal established, and it is true and was never
           the whole line. The `[OR 2.1]` tag, the 10px gap beside it and the row's own left padding all sat
           outside the fill, so the block started a couple of centimetres in.
           AND THE COLLAPSED TICKER HAS TINTED ITS WHOLE ENTRY SINCE #1080. Two surfaces answering one
           question two ways is #891, and this is the half that was wrong. */
        ...(item.logTone === "bonus"
          ? styles.logRowToneBonus
          : item.logTone === "malus"
            ? styles.logRowToneMalus
            : {}),
      }}
      role="button"
      tabIndex={0}
      onClick={() => setShowTime((on) => !on)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setShowTime((on) => !on);
        }
      }}
      title={showTime ? "Click to show the round" : "Click to show the time"}
    >
      {parts.gutter && <span style={styles.logGutter}>{parts.gutter}</span>}
      <span
        style={{
          ...styles.logLabelFull,
          ...(item.logStatus === "error" ? styles.logLabelError : {}),
          /* Design note #1095: THE TONE SPREAD IS GONE FROM HERE, onto the row `div` above. #1042 put it on
             this span and #1080 moved it to the row and was withdrawn for moving three other things with it;
             ruled since that the row is the target, which it now is -- and this time nothing else moves.
             THE ERROR STYLE STAYS, and with it #1042's precedence: a failed action is a more urgent fact
             about a line than which way its die rolled. The two cannot co-occur today, so the order is a
             statement of intent rather than a live conflict. */
        }}
      >
        {parts.body}
        {/* Design note #1079: NESTED, not a sibling. The tint is a pill around the whole sentence and the
            italic is a property of one part of it -- two sibling spans would break the fill into two pills
            with a seam down the middle of a sentence. */}
        {parts.flavour && <span style={styles.logFlavourText}>{parts.flavour}</span>}
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
/** Sized to "▼ Collapse", the longer of the two labels, at 13px/600. Design note #1012 swapped the
 *  glyphs; the measurement is unchanged, since the two triangles have the same advance. */
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
    backgroundColor: "#1c1c1c",
    borderTop: "1px solid #2a2a2a",
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
    color: "#f2f0eb",
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE.strong,
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "left",
    boxSizing: "border-box",
  },
  headerRowOpen: {
    backgroundColor: "#2a2a2a",
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
    borderRadius: RADIUS.control,
    border: "1px solid #2a2a2a",
    backgroundColor: "#141414",
    color: "#a8a6a0",
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
    borderRadius: RADIUS.pill,
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
    color: "#a8a6a0",
    flexShrink: 0,
  },
  // ---- In-place accordion body -- design note #5. ----
  body: {
    backgroundColor: "#0f0f0f",
    borderTop: "1px solid #2a2a2a",
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
    color: "#6e6c68",
    margin: 0,
  },
  // ---- Chat entries -- ported from FeedOverlay.tsx design note #3. ----
  chatEntry: {
    // Longhand: the JSX below applies a per-author `borderLeftColor`
    // inline, and overriding a longhand onto a shorthand is exactly the
    // mix React warns about.
    borderLeftWidth: "3px",
    borderLeftStyle: "solid",
    borderLeftColor: "#3a3a3a",
    backgroundColor: "#1c1c1c",
    borderRadius: `0 ${RADIUS.card} ${RADIUS.card} ${RADIUS.card}`,
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
    color: "#c8c6c0",
    marginTop: "1px",
  },
  // ---- Log entries -- ported from FeedOverlay.tsx design note #4. ----
  /* Design note #1076: THE GUTTER IS THE ONE BOLD THING ON THE ROW. Reported: "[time] [round] [information]
     all read as one long string." Weight rather than colour, because the row already spends colour on the
     error state and on the variant's bonus/malus tint -- a third meaning in the same channel would collide
     with both. */
  logGutter: {
    fontWeight: 800,
    color: "#c8c6c0",
    flex: "none",
    marginRight: "8px",
    fontVariantNumeric: "tabular-nums",
  },
  previewGutter: { fontWeight: 800, marginRight: "8px", fontVariantNumeric: "tabular-nums" },
  logEntry: {
    display: "flex",
    /* `flex-start`, not `center`: the label can now be several lines and a
       centred timestamp beside a three-line sentence floats in the middle
       of it. */
    alignItems: "flex-start",
    gap: "10px",
    padding: "6px 12px",
    backgroundColor: "#0f0f0f",
    border: "1px solid #1c1c1c",
    /* Design note #425: a rounded rectangle, not a 999px pill. The pill
       shape was built for a single clipped line; on wrapped text it bows
       the left and right edges away from the words. */
    borderRadius: RADIUS.card,
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
    borderRadius: RADIUS.control,
    border: "1px solid transparent",
    backgroundColor: "transparent",
    color: "#a8a6a0",
    font: "inherit",
    fontSize: FONT_SIZE.micro,
    textAlign: "left",
    cursor: "pointer",
  },
  stickyLineDot: {
    width: "6px",
    height: "6px",
    borderRadius: RADIUS.circle,
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
    color: "#c8c6c0",
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
  /* ==================================================================
      DESIGN NOTE 1042: SUBTLE, BECAUSE EVERY THIRD LINE IS ONE OF THESE
     ==================================================================
     RULED as "a subtle gold background for bonuses and a subtle red background for maluses, italicizing the
     text". The alphas are low deliberately: under the Unpredictable Revenue variant a flavour line lands on
     most operating turns, so a saturated fill would turn the Activity Log into stripes and stop reading as
     emphasis at all. The italic is doing most of the work; the tint says which direction.
     PADDING AND A RADIUS COME WITH THE FILL, because a background flush against the text reads as a
     rendering artefact rather than a highlight. */
  /* ==================================================================
      DESIGN NOTE 1079: GREEN AND RED, ONE ALPHA, AND NOTHING ELSE
     ==================================================================
     RULED: "Bonus Events: Apply a soft green background ... using the exact same opacity/transparency value
     currently utilized by the temporary amber background. Malus Events: Apply a soft red background [same].
     Unchanged Events: Apply no background color ... Do not bold the event text or change the core font
     colour. Apply italics strictly to the flavor text string at the end of the line."

     THE AMBER'S 0.12 IS THE FIGURE, and the malus moves 0.11 -> 0.12 to match. That eleventh was never a
     decision -- #1042 wrote two numbers by eye and they came out a hundredth apart, which is invisible on
     screen and exactly the kind of near-agreement that reads as intent to the next person to open the file.
     One alpha, named once, for both.

     `#4ade80` IS THIS APP'S POSITIVE GREEN already (sixteen call sites) and `#f43f5e` its red. Reaching for
     a fresh pair here would put a seventeenth green in the palette to say the thing the sixteenth says.

     THE COLOUR AND THE ITALIC ARE GONE FROM BOTH, which is the substance of this change rather than the
     hues. `color` overrode `logLabelFull`'s `#c7cbd4` on every flavour line, so the variant's lines read in
     a different ink from the log around them -- two signals for one fact, and the report asked for the
     background to carry it alone. The italic moved to `logFlavourText`, which is applied to the flavour
     SENTENCE rather than to the whole line: the revenue math is now upright, as ruled.

     UNCHANGED ROLLS NEED NO ENTRY HERE. They pass no tone (#1042), so they match neither branch and take no
     fill -- "a neutral, transparent state" is the absence of a rule, not a third rule. */
  /* Design note #1095: THE COLLAPSED TICKER'S WASH. Its wrapper paints no background of its own, so an
     `rgba` composites against the header band exactly as intended and stays uniform across the line. The
     padding and radius finish its ends, which is #1042's shape and unchanged.
     ONLY THE ALPHA MOVED HERE. This surface has tinted its whole entry, gutter included, since #1080 -- it
     was already what the ruling asks for; the expanded row is the one that had to catch up. */
  logToneBonus: {
    backgroundColor: toneWash(TONE_BONUS_RGB),
    padding: "1px 6px",
    borderRadius: RADIUS.control,
  },
  logToneMalus: {
    backgroundColor: toneWash(TONE_MALUS_RGB),
    padding: "1px 6px",
    borderRadius: RADIUS.control,
  },
  /* ==================================================================
      DESIGN NOTE 1095: THE EXPANDED ROW'S FILL, FLATTENED
     ==================================================================
     ONE OPAQUE COLOUR, not a wash. `logEntry` paints `#141c2c`, and a `backgroundColor` set here REPLACES
     that rather than layering over it -- so a wash would silently composite against the list behind the row
     and land on a colour nobody chose. These are the same tint at the same alpha, arithmetic already done.
     NO PADDING AND NO RADIUS OF THEIR OWN. The row brings both (`6px 12px`, `8px`), which is exactly why the
     fill now reaches the line's ends -- and adding a second set here is the kind of consequential edit that
     got #1080 withdrawn. The only thing these change is the colour of the row. */
  logRowToneBonus: { backgroundColor: toneOverRow(TONE_BONUS_RGB) },
  logRowToneMalus: { backgroundColor: toneOverRow(TONE_MALUS_RGB) },
  /* Design note #1079: the ONLY emphasis on a flavour line. Not recoloured -- ruled, and right on its own
     terms: the tint already says which direction the die went, and a second signal saying the same thing is
     how the log came to be reading in stripes.
     ==================================================================
      DESIGN NOTE 1095: BOLD JOINS THE ITALIC, WHICH REVERSES HALF OF #1079
     ==================================================================
     RULED: "update the Unpredictable Revenue flavor text styling from standard italics to bold-italics to
     improve legibility on small screens."
     #1079 RULED "DO NOT BOLD" AND THIS IS NOT THAT RULING OVERTURNED. That one was about the EVENT TEXT --
     "do not bold the event text or change the core font colour" -- and the event text is still upright and
     unweighted. What gains weight is the flavour clause alone, and for a reason #1079 was not answering: an
     italic at this size on a phone is the least legible thing on the row, because the slant is what a small
     rasteriser loses first.
     THE INK IS STILL UNCHANGED, which is the part of #1079 that matters most -- colour was the second signal
     it removed, and weight is not colour. */
  logFlavourText: { fontStyle: "italic", fontWeight: 700 },
  timestamp: {
    fontSize: FONT_SIZE.small,
    color: "#6e6c68",
    flexShrink: 0,
  },
};
