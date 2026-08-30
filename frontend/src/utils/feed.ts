// frontend/src/utils/feed.ts
//
// Shared types and helpers for the top ticker and its in-place feed.
//
// ActionLogEntry/ActionLogStatus live here so App.tsx (which constructs them)
// and mergeFeedItems (which sorts them against chat) share one definition.
// timestampMs interleaves the two streams -- the two source arrays use opposite
// insertion conventions, so neither array's own order helps.
//
// Design note #668: a WALL CLOCK IS NOT AN ORDER. Sorting the merged feed by
// `timestampMs` alone is what printed setup events in the middle of OR 2.2: a
// replay stamps a rebuilt entry with the log's `createdAt` while every line
// DERIVED from it ("B&O floated", "Priority Deal shifts to...") was stamped
// `Date.now()`, so an entry and its own consequences landed hours apart in the
// feed. `seq` is the real order -- monotonic, assigned at construction, and the
// tie-break that makes the sort total. See the App.tsx note of the same number
// for the other half: the replay clock that keeps the stamps monotonic too.
//
// See docs/ai_architecture/ui_shell_layout.md - feed.ts #1, #2, #3, #668

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
  /** Design note #668: the ORDER this entry was produced in, monotonic across
   *  the session. Distinct from `id` in intent even where a caller derives one
   *  from the other -- `id` identifies an entry so a later update can find it,
   *  `seq` places it. The merge sorts by this, never by the clock alone. */
  seq: number;
  /* The round is STAMPED on the entry, not derived at render: a derived prefix reads the CURRENT round, so every historic line would relabel itself when the round changed.
     See docs/ai_architecture/ui_shell_layout.md - feed.ts #343 */
  round?: string;
  label: string;
  status: ActionLogStatus;
  detail: string;
  timestamp: string;
  /** Real sortable epoch-ms, stamped at construction -- see design note #2. */
  timestampMs: number;
  /** ==================================================================
   *   DESIGN NOTE 1042: WHICH WAY THE VARIANT WENT, FOR THE READER
   *  ==================================================================
   *
   * RULED: "Apply distinct CSS classes to variant flavor text entries in the Activity Log. Use a subtle gold
   * background for bonuses and a subtle red background for maluses, italicizing the text."
   *
   * STAMPED ON THE ENTRY RATHER THAN RE-DERIVED AT RENDER, which is #343's rule for the round prefix and is
   * right here for the same reason: the tint is a fact about the roll that produced this line, and a renderer
   * that re-read the CURRENT variant state would repaint every historic entry the moment a later turn rolled
   * differently.
   * ABSENT ON EVERY OTHER LINE, so the log's ordinary entries are untouched -- this marks the variant's
   * flavour text and nothing else. */
  tone?: "bonus" | "malus";
}

export type FeedFilter = "all" | "chat" | "log";
export type FeedItemKind = "chat" | "log";

export interface FeedItem {
  id: string;
  /** THE SORT KEY, and for a log entry not necessarily the stamp it was built
   *  with -- design note #668 holds the log's own timestamps non-decreasing so
   *  a bad clock cannot reorder it. Display reads `timestampLabel`, which is
   *  left exactly as the source entry formatted it. */
  kind: FeedItemKind;
  timestampMs: number;
  /** Design note #668: the log entry's `seq`, carried through so the merge has
   *  a real order to fall back on. `0` for chat, which has no such stream --
   *  its own arrival time is the only order it has. */
  seq: number;
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
  /** Design note #1042: the variant tint, carried through the merge. */
  logTone?: "bonus" | "malus";
}

/** Oldest-first, matching ordinary chat reading order, since the feed auto-scrolls to the bottom on new arrivals.
 *
 *  Design note #668: THE LOG IS ORDERED BY `seq`; THE CLOCK ONLY PLACES CHAT
 *  AGAINST IT.
 *
 *  The two streams share nothing but a clock, so a clock is how they interleave
 *  -- but sorting the log on it too is what printed setup events in the middle
 *  of OR 2.2. So the log is sorted by its own sequence first and its stamps are
 *  then held NON-DECREASING along it, purely as sort keys. A log entry whose
 *  clock disagrees with its position is dragged to its position rather than the
 *  other way round, and chat still lands where its own arrival time says.
 *
 *  Monotonised HERE and not only at the call site, because this is where the
 *  property is needed and a pure function that depends on its caller having been
 *  careful is a property nobody can test. App.tsx keeps its own clock for the
 *  same reason in reverse: it owns the time each entry DISPLAYS, which a sort
 *  cannot correct.
 *
 *  The trailing id tie-break makes the comparator total. One that can return 0
 *  for distinct items leaves their order to `Array.sort` -- and two browsers
 *  would then render one history two ways.
 *
 *  See docs/ai_architecture/ui_shell_layout.md - feed.ts #2, #668 */
export function mergeFeedItems(
  chatMessages: readonly ChatMessage[],
  actionLog: readonly ActionLogEntry[],
): FeedItem[] {
  const chatItems: FeedItem[] = chatMessages.map((message) => ({
    id: `chat-${message.id}`,
    kind: "chat",
    timestampMs: message.timestampMs,
    // Design note #668: chat is not part of the action stream and has no
    // sequence of its own.
    seq: 0,
    timestampLabel: message.timestamp,
    chatAuthor: message.author,
    chatText: message.text,
  }));

  /* In sequence, then non-decreasing along it. `id` breaks a `seq` tie so this
     first pass is itself deterministic -- the monotonising below depends on the
     order it walks in, so an ambiguous one would be a second way two clients
     could disagree. */
  const inSequence = [...actionLog].sort((a, b) => a.seq - b.seq || a.id - b.id);
  let floor = Number.NEGATIVE_INFINITY;
  const logItems: FeedItem[] = inSequence.map((entry) => {
    const timestampMs = Math.max(entry.timestampMs, floor);
    floor = timestampMs;
    return {
      id: `log-${entry.id}`,
      kind: "log",
      timestampMs,
      seq: entry.seq,
      // The stamp the entry was BUILT with -- see the note on `FeedItem`.
      timestampLabel: entry.timestamp,
      logLabel: entry.label,
      logRound: entry.round,
      logStatus: entry.status,
      logDetail: entry.detail,
      logTone: entry.tone,
    };
  });

  return [...chatItems, ...logItems].sort(
    (a, b) =>
      a.timestampMs - b.timestampMs || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
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
