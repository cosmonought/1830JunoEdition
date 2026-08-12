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

import type { ChatMessage } from "../components/Chatbox";

export type ActionLogStatus = "pending" | "success" | "error" | "info";

export interface ActionLogEntry {
  id: number;
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
    logStatus: entry.status,
    logDetail: entry.detail,
  }));
  return [...chatItems, ...logItems].sort((a, b) => a.timestampMs - b.timestampMs);
}

/** Emoji + short category label per requested badge type (Tile/Stock/
 *  Train/Dividend/Phase Shift) -- see design note #3 for why this is a
 *  plain label-substring match, not a new structured field. Checked in a
 *  fixed priority order so a label that could plausibly match more than
 *  one category resolves deterministically. */
export function iconForLogEntry(label: string): { icon: string; category: string } {
  const lower = label.toLowerCase();
  if (lower.includes("tile") || lower.includes("station") || lower.includes("track")) {
    return { icon: "🛤️", category: "Tile" };
  }
  if (lower.includes("stock") || lower.includes("private")) {
    return { icon: "💹", category: "Stock" };
  }
  if (lower.includes("hardware") || lower.includes("train")) {
    return { icon: "🚂", category: "Train" };
  }
  if (lower.includes("dividend")) {
    return { icon: "💰", category: "Dividend" };
  }
  if (
    lower.includes("passturn") ||
    lower.includes("pass turn") ||
    lower.includes("skip") ||
    lower.includes("end turn") ||
    lower.includes("phase") ||
    lower.includes("undo")
  ) {
    return { icon: "🔄", category: "Phase Shift" };
  }
  return { icon: "📜", category: "Log" };
}

/** Status -> single-glyph indicator, shared by the Top Ticker's live
 *  preview (matching this pass's own requested `🟢 Alice laid Tile #57...`
 *  example format) and the Feed Overlay's log badge strips. */
export function iconForLogStatus(status: ActionLogStatus): string {
  switch (status) {
    case "success":
      return "🟢";
    case "error":
      return "🔴";
    case "pending":
      return "🟡";
    default:
      return "🔵";
  }
}

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
