// frontend/src/components/Chatbox.tsx
//
// A lightweight in-room chat panel, positioned above the board canvas in
// the "Game Board" tab (see App.tsx's restructure). Sits beside the Action
// Log so a player can narrate/coordinate alongside the log's own automatic
// transaction trail.
//
// Design notes:
// 1. **Local-only, illustrative chat -- NOT a real messaging transport.**
//    This CosmWasm contract has no chat/messaging `ExecuteMsg` or `QueryMsg`
//    at all (confirmed against `src/msg.rs` for this pass) -- there is no
//    on-chain or off-chain message bus to actually broadcast a chat message
//    to other players. Every message typed here is appended to a plain
//    local `useState` array and goes nowhere else; refreshing the page (or
//    another player's own browser) never sees it. This is the same
//    "illustrative, not fabricated backend behavior" discipline this
//    codebase already applies elsewhere (e.g. `App.tsx`'s pre-existing
//    "BuyStock (mock)" button, `TileSelectionPopup.tsx`'s real dispatch vs.
//    this component's deliberately fake one) -- rather than silently
//    pretending a chat transport exists, a small note in the panel itself
//    says so explicitly. A real implementation would need a genuine
//    off-chain relay (a websocket service, a Slack/Matrix-style bridge, or
//    an on-chain event log some indexer replays) that does not exist in
//    this project yet.
// 2. **Turn Alert Indicator.** `isMyTurn` compares `activePlayerAddress`
//    (the room's live `GameStateResponse.active_player_index`, resolved to
//    an address by the caller -- see `App.tsx`) against
//    `connectedWalletAddress` (the connected Keplr wallet's own address,
//    from `WalletContext`). When they match, the WRAPPER (not just an icon)
//    flashes a red alert tint via the `chatbox-turn-alert-flash` CSS
//    keyframe animation below. Plain React inline style objects (this
//    codebase's established styling convention -- see every other
//    component's own "no CSS framework/file yet" note) cannot express a
//    `@keyframes` rule at all; a `<style>` tag scoped to this component,
//    injected once in the JSX below, is the standard minimal escape hatch
//    for that specific limitation -- it is a small, self-contained
//    animation definition, not a new CSS-framework dependency for the
//    project. An alternative (a `setInterval`-driven JS color interpolation
//    written directly into inline styles) was considered and rejected: a
//    real CSS animation is smoother, cheaper (runs on the compositor
//    thread, not JS), and doesn't need a cleanup timer.
// 3. **Address resolution is the caller's job.** This component only ever
//    compares two already-resolved address strings -- it does not know
//    about `GameStateResponse.player_addresses`/`active_player_index`
//    itself, keeping it consistent with `HexGridRenderer.tsx`'s established
//    "presentational component, App.tsx owns wallet/session wiring" split.
// 4. **Upscaled chat text/composer (App.tsx design note #12/item 5's
//    "Left-Side Feed" bullet, final visual theme pass).** Pure typography/
//    spacing: message text, the composer input, and the Send button all
//    scaled up roughly 25-40% (12px -> 14-15px body text, taller composer
//    row) so this panel matches the rest of the dashboard's widescreen
//    upsizing. No behavior change -- see design note #1 above for what this
//    chat transport actually is (and isn't).
// 5. **Full-Width Flex Layout & Auto-Scroll (Left Panel refactor pass).**
//    Two fixes, layout/behavior only -- no chat transport change (design
//    note #1 still applies verbatim):
//    (1) `styles.root` gains an explicit `width: "100%"` and `minHeight: 0`
//    (the latter so it actually respects, rather than overflows, the
//    bounded height `App.tsx`'s `activityFeed` flex column now grants it --
//    see that file's own design note #16/item 1 for the matching other
//    half of this fix). `styles.messageList`'s old fixed `maxHeight: 180px`
//    is replaced with `flex: 1` + `minHeight: 0`, so the message stream now
//    genuinely "flexes to fill available vertical height" against however
//    much room the composer/header/disclaimer leave, rather than being
//    capped at an arbitrary fixed pixel height regardless of the panel's
//    actual size.
//    (2) Auto-scroll: unlike `App.tsx`'s `ActionLogPanel` (which prepends,
//    see that file's design note #16/item 2), `messages` here are
//    APPENDED (`setMessages((log) => [...log, newMessage])`), so the
//    newest message is always the LAST array entry, rendered at the
//    BOTTOM of the list -- ordinary chronological chat order. A
//    `useRef`+`useEffect` keyed on `messages.length` sets
//    `container.scrollTop = container.scrollHeight` whenever a new message
//    arrives, so an incoming message always scrolls the panel down to
//    reveal itself, matching how every ordinary chat UI behaves.
// 6. **Superseded as a directly-rendered panel (dashboard full-width layout
//    refactor, App.tsx design note #18).** This component is no longer
//    mounted directly by App.tsx -- the old always-visible left sidebar it
//    used to sit in (alongside `ActionLogPanel`, design note there #6) is
//    removed outright, replaced by a Compact Top Ticker + expandable
//    combined Feed Overlay (`TopTicker.tsx`/`FeedOverlay.tsx`) that merges
//    chat with the Action Log into one timeline. `chatMessages` state (and
//    the send-message logic below) moved up into App.tsx so it can be
//    merged with `actionLog` there (`utils/feed.ts`'s `mergeFeedItems`).
//    What's still reused from THIS file, unchanged: the `ChatMessage` type
//    (now exporting one new field, `timestampMs`, a real sortable epoch --
//    see `utils/feed.ts` design note #2 for why) and the now-exported
//    `truncateChatAddress` helper, both imported directly by App.tsx. The
//    `Chatbox` component function itself, design note #1's "local-only, not
//    a real transport" chat semantics, and design note #2's turn-alert
//    keyframes are all left fully intact and still exported, in case a
//    future pass wants a standalone chat panel again -- only this pass's
//    App.tsx render call site was removed.

import React, { useCallback, useEffect, useRef, useState } from "react";

export interface ChatMessage {
  id: number;
  author: string;
  text: string;
  timestamp: string;
  /** Real sortable epoch-ms, stamped at construction -- see design note #6
   *  and `utils/feed.ts` design note #2. */
  timestampMs: number;
}

export interface ChatboxProps {
  /** The room's currently active player's address, already resolved by the
   *  caller from `GameStateResponse.player_addresses[active_player_index]`
   *  -- or `null` if no live game state is available yet. */
  activePlayerAddress: string | null;
  /** The connected Keplr wallet's own address -- or `null` if not
   *  connected. */
  connectedWalletAddress: string | null;
  /** Optional short round label (e.g. "SR1" / "OR2.1") shown in the header
   *  for context -- purely cosmetic. */
  roundLabel?: string | null;
  className?: string;
}

let nextChatMessageId = 1;

export function Chatbox({
  activePlayerAddress,
  connectedWalletAddress,
  roundLabel,
  className,
}: ChatboxProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");

  // Design note #5/item 2: `messages` is append-only, so the newest entry
  // is always last -- scroll the list's own `scrollTop` to its
  // `scrollHeight` (the bottom) whenever the message count changes, so an
  // incoming message is always immediately visible.
  const messageListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = messageListRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length]);

  const isMyTurn =
    !!connectedWalletAddress &&
    !!activePlayerAddress &&
    connectedWalletAddress === activePlayerAddress;

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setMessages((log) => [
      ...log,
      {
        id: nextChatMessageId++,
        author: connectedWalletAddress ? truncateChatAddress(connectedWalletAddress) : "You",
        text,
        timestamp: new Date().toLocaleTimeString(),
        timestampMs: Date.now(),
      },
    ]);
    setDraft("");
  }, [draft, connectedWalletAddress]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div
      style={{ ...styles.root, ...(isMyTurn ? styles.rootAlert : {}) }}
      className={className}
    >
      {/* See design note #2: a `<style>` tag is the standard escape hatch
          for a `@keyframes` rule when the rest of this codebase uses plain
          inline style objects, which cannot express keyframes at all. */}
      <style>{TURN_ALERT_KEYFRAMES_CSS}</style>

      <div style={styles.header}>
        <span style={styles.headerTitle}>Chat</span>
        {roundLabel && <span style={styles.roundBadge}>{roundLabel}</span>}
        {isMyTurn && <span style={styles.turnAlertBadge}>YOUR TURN</span>}
      </div>

      <p style={styles.disclaimer}>
        Local-only, illustrative chat -- see design note #1. Messages are not sent to other
        players; this contract has no chat/messaging transport.
      </p>

      <div style={styles.messageList} ref={messageListRef}>
        {messages.length === 0 && <p style={styles.emptyHint}>No messages yet.</p>}
        {messages.map((message) => (
          <div key={message.id} style={styles.message}>
            <span style={styles.messageAuthor}>{message.author}</span>
            <span style={styles.messageTimestamp}>{message.timestamp}</span>
            <div style={styles.messageText}>{message.text}</div>
          </div>
        ))}
      </div>

      <div style={styles.composerRow}>
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Say something..."
          style={styles.composerInput}
        />
        <button type="button" style={styles.sendButton} onClick={handleSend} disabled={!draft.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

export default Chatbox;

// Exported as of design note #6 -- App.tsx's new chat-composer logic
// (moved up from this file's own `handleSend` above) reuses this exact
// truncation instead of re-implementing it.
export function truncateChatAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 8)}...${address.slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/* Turn Alert keyframes -- see design note #2                         */
/* ------------------------------------------------------------------ */

const TURN_ALERT_KEYFRAMES_CSS = `
@keyframes chatbox-turn-alert-flash {
  0%, 100% { background-color: #2a1414; box-shadow: 0 0 0 rgba(224, 90, 90, 0); }
  50% { background-color: #5a1f1f; box-shadow: 0 0 18px rgba(224, 90, 90, 0.55); }
}
`;

/* ------------------------------------------------------------------ */
/* Inline styles                                                      */
/* ------------------------------------------------------------------ */

// Design note #4 (final visual theme pass, App.tsx item 5's "Left-Side
// Feed" bullet): text output stream, composer input, and formatting all
// upscaled -- roughly 25-40% larger fonts, taller message list, and a
// bigger composer row -- so the chat panel reads comfortably at the same
// widescreen scale as the rest of this pass's dashboard upsizing.
const styles: Record<string, React.CSSProperties> = {
  // Design note #5/item 1: explicit `width: "100%"` (spans the full left
  // panel width its `App.tsx` parent grants it) and `minHeight: 0` (so it
  // respects that parent's bounded flex height instead of growing past it
  // -- see `App.tsx`'s design note #16/item 1 for the matching parent-side
  // half of this fix) alongside the pre-existing `flex: 1`, which is what
  // actually makes it "flex to fill available vertical height."
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "16px 18px",
    backgroundColor: "#161922",
    border: "1px solid #2a2e3a",
    borderRadius: "10px",
    color: "#e6e8ef",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    minWidth: "260px",
    width: "100%",
    boxSizing: "border-box",
    flex: 1,
    minHeight: 0,
  },
  rootAlert: {
    // The flat colors here are the animation's own `0%`/`100%` frame --
    // matters for the very first paint before the animation's first tick.
    backgroundColor: "#2a1414",
    borderColor: "#8a2020",
    animation: "chatbox-turn-alert-flash 1.4s ease-in-out infinite",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  headerTitle: {
    fontSize: "16px",
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
  turnAlertBadge: {
    fontSize: "13px",
    fontWeight: 700,
    padding: "3px 10px",
    borderRadius: "999px",
    backgroundColor: "#c0392b",
    color: "#ffe8e8",
    marginLeft: "auto",
  },
  disclaimer: {
    fontSize: "12px",
    color: "#6f7480",
    margin: 0,
    lineHeight: 1.4,
  },
  // Design note #5/item 1: `flex: 1` (replacing the old fixed
  // `maxHeight: "180px"`) so this list actually claims and scrolls within
  // whatever vertical space remains in `root` after the
  // header/disclaimer/composer, instead of being capped at an arbitrary
  // fixed height. `minHeight: "60px"` is kept, but now does double duty:
  // an explicit numeric `minHeight` (rather than the flex default of
  // `auto`, which is content-based) is also what stops this flex child
  // from stretching past its container and defeating internal
  // `overflowY: "auto"` scrolling -- while still acting as a floor so the
  // panel never collapses to nothing while empty.
  messageList: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    flex: 1,
    overflowY: "auto",
    minHeight: "60px",
  },
  emptyHint: {
    fontSize: "14px",
    color: "#6f7480",
    margin: 0,
  },
  message: {
    fontSize: "14px",
    borderLeft: "3px solid #3a3f4b",
    paddingLeft: "9px",
  },
  messageAuthor: {
    fontWeight: 700,
    marginRight: "8px",
  },
  messageTimestamp: {
    fontSize: "12px",
    color: "#6f7480",
  },
  messageText: {
    color: "#c7cbd4",
  },
  composerRow: {
    display: "flex",
    gap: "8px",
  },
  composerInput: {
    flex: 1,
    fontSize: "15px",
    padding: "10px 12px",
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
};
