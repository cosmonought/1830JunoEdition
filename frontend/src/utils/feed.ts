// frontend/src/utils/feed.ts
//
// Shared types and helpers for the top ticker and its in-place feed.
//
// ActionLogEntry/ActionLogStatus live here so App.tsx (which constructs them)
// and mergeFeedItems (which sorts them against chat) share one definition.
// timestampMs is what the merge sorts by -- the two source arrays use opposite
// insertion conventions, so neither array's own order helps.
//
// See docs/ai_architecture/ui_shell_layout.md - feed.ts #1, #2, #3

// ChatMessage and truncateChatAddress moved here and Chatbox.tsx was deleted: the component was dead, and a pure domain module importing a type out of components/ ran the dependency backwards.
// See docs/ai_architecture/ui_shell_layout.md - feed.ts #1

/** One chat message in the merged activity feed. */
export interface ChatMessage {
  /** string | number, because a chat id is now a Firestore DOCUMENT ID. A hash can collide and a counter is per-client -- both are the wrong property for a React list key.
   *  See docs/ai_architecture/ui_shell_layout.md - feed.ts #1 */
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
  /* The round is STAMPED on the entry, not derived at render: a derived prefix reads the CURRENT round, so every historic line would relabel itself when the round changed.
     See docs/ai_architecture/ui_shell_layout.md - feed.ts #343 */
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

/** Oldest-first, matching ordinary chat reading order, since the feed auto-scrolls to the bottom on new arrivals.
 *  See docs/ai_architecture/ui_shell_layout.md - feed.ts #2 */
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

/* The emoji helpers were DELETED, not left uncalled: two exported functions whose entire output is emoji are an invitation to put the badges back, and the category one mis-tagged by substring.
   See docs/ai_architecture/ui_shell_layout.md - feed.ts #425 */

/** A fixed palette hashed by the author string, not a session assignment, so an author reads as the same colour across every render.
 *  See docs/ai_architecture/ui_shell_layout.md - feed.ts #425 */
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
