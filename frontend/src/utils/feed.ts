// frontend/src/utils/feed.ts
//
// Shared types/helpers for the Compact Top Ticker + combined Feed Overlay
// (dashboard full-width layout refactor) -- see App.tsx's own design note
// #18 for the pass this belongs to. Nothing here talks to the chain; it
// purely merges/labels the two ALREADY-LOCAL data sources App.tsx already
// owned before this pass (the Action Log's `ActionLogEntry[]` trail, and
// Chatbox's own local-only `ChatMessage[]` -- see that component's design
// note #1 for why chat has no real transport) into one chronologically
// sorted timeline, plus a few small presentation helpers (icons/colors)
// both new components share.
//
// Design notes:
// 1. **`ActionLogEntry`/`ActionLogStatus` moved here from App.tsx.** Same
//    shape as before this pass, plus exactly one new field --
//    `timestampMs`, a real sortable epoch alongside the existing
//    display-only `timestamp` string -- moved so both App.tsx (which still
//    constructs these) and this file's own `mergeFeedItems` (which needs
//    to sort them against chat messages) share one definition instead of
//    two independently drifting copies.
// 2. **Real sortable timestamps, not insertion-order guessing.** Both
//    `ActionLogEntry`/`ChatMessage` already carried a display-only
//    `toLocaleTimeString()` string with no reliable sort key. `timestampMs`
//    (`Date.now()` at construction, stamped by App.tsx) is what
//    `mergeFeedItems` actually sorts by, so the combined timeline is
//    genuinely chronological even though the two source arrays use
//    opposite insertion conventions internally (Action Log prepends, Chat
//    appends -- see each file's own design notes).
// 3. **Icon/category matching is a plain label-substring lookup, not a new
//    structured "action type" field on the contract or `ActionLogEntry`
//    itself.** Every `ActionLogEntry.label` this app already constructs
//    (`"LayTile #57 (orientation 3)"`, `"BuyStock (mock)"`,
//    `"BuyHardwareFromPool (mock)"`, `"DeclareDividends: Pay (mock)"`,
//    `"PassTurn"`, ...) is a human-readable string set by App.tsx's own
//    action handlers -- `iconForLogEntry` reads that same string to
//    classify it into one of this pass's five requested badge categories
//    (Tile/Stock/Train/Dividend/Phase Shift), falling back to a generic
//    icon for anything else (Undo, the Waterfall Auction's own five
//    actions, informational hints) rather than mis-tagging it into one of
//    the five.

// F-8 / tech-debt purge: `ChatMessage` and `truncateChatAddress` MOVED here
// from `../components/Chatbox`, and that file is deleted.
//
// Two reasons, one practical and one about layering:
//
//  - The `Chatbox` component itself was dead. It has not been rendered
//    anywhere since its state was hoisted into `App.tsx` and its UI replaced
//    by `TopTicker`'s in-place accordion plus `InlineQuickChat`. Only the
//    type and the truncation helper were still live, so the file was ~200
//    lines of unreachable React kept alive by two small exports.
//
//  - The dependency ran the wrong way. `utils/feed.ts` is a pure domain
//    module and it was importing a type out of `components/` -- utilities
//    depending on the view layer, which is backwards and is what made the
//    dead component look load-bearing. A shared chat type belongs here,
//    beside `FeedItem`, which is the only thing that consumes it.

/** One chat message in the merged activity feed. */
export interface ChatMessage {
  /** Widened from `number` to `string | number` for the Firebase Real-Time
   *  Integration pass (Step 4). Chat is no longer a local counter
   *  (`nextChatMessageId++` in App.tsx) -- it is a Firestore collection, and
   *  the identity of a message is its DOCUMENT ID, which is a string.
   *
   *  Deriving a number from that string (hashing it, or keeping a parallel
   *  counter) would be strictly worse: a hash can collide, and a counter is
   *  per-client, so the same message would carry different ids in different
   *  browsers -- which is exactly the wrong property for the value React
   *  uses as a list key and `mergeFeedItems` uses to build `FeedItem.id`.
   *  The document id is already globally unique and identical for everyone.
   *
   *  Nothing downstream needed changing: `mergeFeedItems` only ever
   *  interpolates this into a template string, and ordering has always come
   *  from `timestampMs`, never from the id. */
  id: string | number;
  /** The display label for the sender -- a player-chosen display name when
   *  one is set, otherwise a truncated address. NOT an identity: display
   *  names are self-asserted (see `utils/lobby.ts`'s note on why) and the
   *  wallet address remains the real identity everywhere it matters. */
  author: string;
  text: string;
  timestamp: string;
  /** Real sortable epoch-ms, stamped at construction -- see design note #2. */
  timestampMs: number;
}

/** Shortens a `juno1...` address for display in a feed byline.
 *  Addresses at or under 14 characters are returned untouched. */
export function truncateChatAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 8)}...${address.slice(-4)}`;
}

export type ActionLogStatus = "pending" | "success" | "error" | "info";

export interface ActionLogEntry {
  id: number;
  /* ==================================================================
   *  DESIGN NOTE 343: THE ROUND IS STAMPED, NOT DERIVED
   * ==================================================================
   *
   * The round context an entry happened in -- "Auction", "SR1", "OR 1.1".
   *
   * STORED ON THE ENTRY rather than computed when the log is rendered, and
   * the difference is the whole point. A derived prefix reads the CURRENT
   * round, so the moment the auction ended every historic line would
   * relabel itself "SR1" and the log would claim the privates were
   * auctioned during the Stock Round. A log that rewrites its own history
   * is worse than one with no prefixes at all.
   *
   * Optional so entries written before this field existed -- and any future
   * caller that has no round to report -- render without a prefix rather
   * than with an empty bracket.
   */
  round?: string;
  label: string;
  status: ActionLogStatus;
  detail: string;
  timestamp: string;
  /** Real sortable epoch-ms, stamped at construction -- see design note #2. */
  timestampMs: number;
}

export type FeedFilter = "all" | "chat" | "log";
export type FeedItemKind = "chat" | "log";

export interface FeedItem {
  id: string;
  kind: FeedItemKind;
  timestampMs: number;
  /** Pre-formatted display string (`toLocaleTimeString()`), reused as-is
   *  from whichever source entry this item was built from. */
  timestampLabel: string;
  chatAuthor?: string;
  chatText?: string;
  logLabel?: string;
  /** Design note #343: the round the entry was stamped with. */
  logRound?: string;
  logStatus?: ActionLogStatus;
  logDetail?: string;
}

/** Merges Chat + Action Log into one chronologically sorted (oldest-first)
 *  timeline -- design note #2. Oldest-first (not newest-first) matches
 *  ordinary chat reading order, since the Feed Overlay auto-scrolls to the
 *  bottom on new arrivals, the same convention Chatbox.tsx's own
 *  pre-existing scroll-to-bottom behavior already used. */
export function mergeFeedItems(
  chatMessages: readonly ChatMessage[],
  actionLog: readonly ActionLogEntry[],
): FeedItem[] {
  const chatItems: FeedItem[] = chatMessages.map((message) => ({
    id: `chat-${message.id}`,
    kind: "chat",
    timestampMs: message.timestampMs,
    timestampLabel: message.timestamp,
    chatAuthor: message.author,
    chatText: message.text,
  }));
  const logItems: FeedItem[] = actionLog.map((entry) => ({
    id: `log-${entry.id}`,
    kind: "log",
    timestampMs: entry.timestampMs,
    timestampLabel: entry.timestamp,
    logLabel: entry.label,
    logRound: entry.round,
    logStatus: entry.status,
    logDetail: entry.detail,
  }));
  return [...chatItems, ...logItems].sort((a, b) => a.timestampMs - b.timestampMs);
}

/* ==================================================================
 *  DESIGN NOTE 425: THE EMOJI HELPERS ARE GONE
 * ==================================================================
 *
 * `iconForLogEntry` and `iconForLogStatus` were DELETED, not merely left
 * uncalled. They produced the category badges (🛤 Tile, 💹 Stock, 🚂 Train
 * …) and the status circles (🟢🔴🟡🔵) that `TopTicker` used to prefix
 * every log line with, and the requirement is that the log carry clean text
 * and nothing else.
 *
 * WHY DELETE RATHER THAN STOP CALLING. Two exported functions whose entire
 * output is emoji, sitting in the module the log renders from, are a
 * standing invitation to put the badges back -- and the category one
 * deserved removing on its own merits regardless of this pass. It inferred
 * a type by substring-matching the label, so it restated a word already
 * visible in the sentence beside it and mis-tagged any entry that happened
 * to contain another category's keyword ("Skip Station Token" is a Tile;
 * "Private Revenue" is Stock).
 *
 * `ActionLogStatus` is unaffected and still carried on every entry --
 * `TopTicker` reads it to mark a failure in words. The status was never the
 * problem; rendering it as a coloured circle was.
 */

/** Deterministic per-author "player brand color tag" -- see
 *  FeedOverlay.tsx's own design note for how this is used. A fixed palette
 *  hashed by the author string (not a random/session-only assignment), so
 *  the same author reads as the same color across every render and every
 *  reopen of the overlay -- the same "fixed palette keyed by identity"
 *  convention `StockMarketRenderer.tsx`'s own `TICKER_COLORS` already
 *  established for corporation tokens. */
const AUTHOR_COLOR_PALETTE: readonly string[] = [
  "#c0392b", "#2980b9", "#8e44ad", "#27ae60",
  "#d68910", "#16a085", "#b03a2e", "#2c6e9e",
];

export function colorForAuthor(author: string): string {
  let hash = 0;
  for (let i = 0; i < author.length; i++) {
    hash = (hash * 31 + author.charCodeAt(i)) >>> 0;
  }
  return AUTHOR_COLOR_PALETTE[hash % AUTHOR_COLOR_PALETTE.length];
}
