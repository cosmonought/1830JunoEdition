// frontend/src/components/ChatBox.tsx
//
// Real-time chat transport over `games/{roomId}/chat` (Step 4: Firebase
// Real-Time Integration), plus one small standalone view for the pre-game
// staging room.
//
// ===================================================================
//  DESIGN NOTE 0: THIS FILE IS MOSTLY A TRANSPORT, NOT A PANEL
// ===================================================================
//
// The primary export is `useFirestoreChat`, NOT the component underneath
// it. The dashboard deliberately does not gain a chat panel: it already has
// one chat surface -- `TopTicker`'s in-place accordion fed by
// `utils/feed.ts`'s `mergeFeedItems`, composed in `InlineQuickChat` -- and
// `feed.ts`'s own header records that the previous `Chatbox.tsx` component
// was DELETED precisely because hoisting state into `App.tsx` had left it
// unreachable. Re-adding a second chat panel would recreate that mistake
// and give players two inboxes with different contents.
//
// So this pass changes chat's TRANSPORT and nothing else. `App.tsx` swaps
// `useState<ChatMessage[]>` for `useFirestoreChat(roomId)`; `TopTicker` and
// `InlineQuickChat` are untouched and become multiplayer for free, because
// both already read from the merged feed rather than owning any chat state
// themselves. The hook returns `ChatMessage[]` -- `feed.ts`'s existing type
// -- specifically so that substitution is a one-line change at the call
// site.
//
// The `<ChatBox>` component at the bottom exists for exactly one place the
// ticker does not reach: the staging room in `Lobby.tsx`, which renders
// before the dashboard (and therefore before `TopTicker`) exists. It points
// at the SAME collection, so the transcript is continuous -- what players
// said while waiting is still there once the board loads, rather than
// resetting at launch.
//
// ===================================================================
//  DESIGN NOTE 1: CHAT IS OFF-CHAIN AND CARRIES NO AUTHORITY
// ===================================================================
//
// Nothing here may be read as game state. A message saying "I pass" is a
// social utterance; only `PassTurn` on the contract passes a turn. This
// matters more than it sounds: Firestore is in Test Mode, so any client can
// write any message claiming to be from any address. `firestore.rules`
// tightens that (author must match, messages are immutable and
// append-only), but even fully locked down, chat is testimony, never
// evidence. No code path anywhere in this app parses a chat message.
//
// ===================================================================
//  DESIGN NOTE 2: WHY ORDERING USES A CLIENT TIMESTAMP, NOT serverTimestamp
// ===================================================================
//
// This is the subtle one, and getting it wrong produces two bugs that are
// easy to ship and unpleasant to debug.
//
// `serverTimestamp()` resolves to `null` in the local snapshot -- the SDK
// applies your write optimistically before the server has assigned a time
// (`snapshot.metadata.hasPendingWrites` is `true` during that window).
// Firestore sorts `null` as the smallest possible value. So if the query
// were `orderBy("createdAt", "desc"), limit(N)`:
//
//   1. A message you just sent sorts LAST in the descending order, i.e. it
//      appears at the OLDEST end of the reversed list -- your own message
//      jumps to the top of the history, then snaps to the bottom a moment
//      later when the server timestamp lands.
//   2. Worse, with `limit(N)` and N or more confirmed messages already
//      present, your pending message is CUT BY THE LIMIT entirely. You type,
//      press send, and your message simply does not appear until the server
//      round-trip completes. On a slow connection that reads as a broken
//      chat box.
//
// Both are fixed by ordering on `clientCreatedAtMs`, a plain number written
// at the same instant, which is therefore never null and never reorders.
//
// The cost is that ordering now trusts the sender's clock, and a client with
// a badly wrong clock would place its messages wrongly for everyone.
// `firestore.rules` bounds that: a write whose `clientCreatedAtMs` is more
// than a few minutes from the server's own `request.time` is rejected, so a
// broken or malicious clock cannot pin a message to the top of the room's
// history permanently. `createdAt` is still written on every message and is
// still the tamper-resistant record -- it is what gets DISPLAYED whenever it
// has resolved; `clientCreatedAtMs` only ever decides sort position.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Timestamp,
  addDoc,
  collection,
  limit as fsLimit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  type DocumentData,
  type FirestoreError,
  type QueryDocumentSnapshot,
} from "firebase/firestore";

import { firebaseConfigError, getFirestoreDb } from "../config/firebase";
import { chatCollectionPath, seatLabel } from "../utils/lobby";
import { colorForAuthor, type ChatMessage } from "../utils/feed";
import { CONTROL_PADDING, FONT_FAMILY, FONT_SIZE } from "../styles/typography";

/** How much scrollback a client subscribes to. Bounded because this is a
 *  live listener over a collection that only ever grows -- an unbounded
 *  subscription re-downloads and re-renders an entire game's transcript. */
export const CHAT_HISTORY_LIMIT = 200;

const MAX_MESSAGE_LENGTH = 500;

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

function decodeMessage(snapshot: QueryDocumentSnapshot<DocumentData>): ChatMessage | null {
  const data = snapshot.data() ?? {};

  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (!text) return null; // Test Mode lets anything be written; drop junk quietly.

  const address = typeof data.author === "string" ? data.author : "";
  const displayName = typeof data.displayName === "string" ? data.displayName : "";

  // Design note #2: `createdAt` is authoritative and preferred for DISPLAY,
  // but is null while the write is pending, so fall back to the client
  // stamp -- which is also what ordering used, keeping the two consistent.
  const serverMs = data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : null;
  const clientMs =
    typeof data.clientCreatedAtMs === "number" && Number.isFinite(data.clientCreatedAtMs)
      ? data.clientCreatedAtMs
      : null;
  const timestampMs = serverMs ?? clientMs ?? Date.now();

  return {
    id: snapshot.id,
    author: seatLabel({ address, displayName }),
    text: text.slice(0, MAX_MESSAGE_LENGTH),
    timestamp: new Date(timestampMs).toLocaleTimeString(),
    timestampMs,
  };
}

/* ------------------------------------------------------------------ */
/* The hook -- design note #0                                          */
/* ------------------------------------------------------------------ */

export interface FirestoreChatResult {
  /** Oldest-first, matching the ordering convention `mergeFeedItems`
   *  documents and `TopTicker` renders against. */
  messages: ChatMessage[];
  /** Rejects empty/whitespace text. Resolves once the write is queued
   *  locally; the message is visible immediately (design note #2) and the
   *  server round-trip completes in the background. */
  sendMessage: (text: string) => Promise<void>;
  /** Non-null when chat is unavailable or a send failed. Surfaced rather
   *  than swallowed: a chat box that silently drops messages is worse than
   *  one that says it is offline. */
  error: string | null;
  /** `false` when Firebase is unconfigured or no room is selected. */
  available: boolean;
}

/**
 * Subscribes to `games/{roomId}/chat` and returns the transcript in the
 * exact `ChatMessage[]` shape `utils/feed.ts` already defines.
 *
 * @param roomId  The FIRESTORE room id -- `RoomDoc.id`, not the on-chain
 *                `chainGameId`. Chat is an off-chain concern keyed to the
 *                off-chain room, which is what lets a staging room have a
 *                transcript before it has any on-chain identity at all.
 *                Pass `null` to subscribe to nothing.
 * @param address The sender's `juno1...` address, stamped on outgoing
 *                messages. `null` disables sending (but not reading).
 * @param displayName Denormalised onto each message on purpose: a player
 *                who later renames themselves should not retroactively
 *                rewrite the byline on things they already said.
 */
export function useFirestoreChat(
  roomId: string | null,
  address: string | null,
  displayName: string,
): FirestoreChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const db = getFirestoreDb();
  const available = db !== null && roomId !== null;

  // Kept in a ref so `sendMessage` stays referentially stable across
  // renames -- `InlineQuickChat` receives it as an `onSend` prop, and an
  // identity that changed on every keystroke would defeat memoisation all
  // the way down that tree.
  const identityRef = useRef({ address, displayName });
  identityRef.current = { address, displayName };

  useEffect(() => {
    if (!db || !roomId) {
      setMessages([]);
      setError(db ? null : firebaseConfigError());
      return;
    }

    const [rooms, room, chat] = chatCollectionPath(roomId);
    const chatQuery = query(
      collection(db, rooms, room, chat),
      // Design note #2: `clientCreatedAtMs`, NOT `createdAt`. Ordering on
      // the server timestamp drops pending writes past the limit and makes
      // your own message jump.
      orderBy("clientCreatedAtMs", "desc"),
      fsLimit(CHAT_HISTORY_LIMIT),
    );

    const unsubscribe = onSnapshot(
      chatQuery,
      (snapshot) => {
        const decoded = snapshot.docs
          .map(decodeMessage)
          .filter((message): message is ChatMessage => message !== null)
          // Queried newest-first (that is what `limit` needs in order to
          // return the most RECENT N rather than the oldest N); reversed
          // here to the oldest-first order the feed renders in.
          .reverse();
        setMessages(decoded);
        setError(null);
      },
      (snapshotError: FirestoreError) => {
        setError(`[firebase] Chat is unavailable: ${snapshotError.message}`);
      },
    );

    return unsubscribe;
  }, [db, roomId]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!trimmed) return;

      const { address: sender, displayName: name } = identityRef.current;
      if (!db || !roomId) {
        setError(firebaseConfigError() ?? "Join a room before sending a message.");
        return;
      }
      if (!sender) {
        setError("Connect a wallet before sending a message.");
        return;
      }

      const [rooms, room, chat] = chatCollectionPath(roomId);
      try {
        await addDoc(collection(db, rooms, room, chat), {
          author: sender,
          displayName: name,
          text: trimmed,
          // Both, and each for its own reason -- design note #2.
          createdAt: serverTimestamp(),
          clientCreatedAtMs: Date.now(),
        });
        setError(null);
      } catch (sendError) {
        setError(
          `[firebase] Message not sent: ${
            sendError instanceof Error ? sendError.message : String(sendError)
          }`,
        );
      }
    },
    [db, roomId],
  );

  return { messages, sendMessage, error, available };
}

/* ------------------------------------------------------------------ */
/* Standalone view -- staging room only, design note #0                */
/* ------------------------------------------------------------------ */

export interface ChatBoxProps {
  roomId: string | null;
  address: string | null;
  displayName: string;
  /** Rendered above the transcript. */
  title?: string;
}

/**
 * A compact scrolling transcript + composer, for the pre-game staging room
 * in `Lobby.tsx`. NOT used on the dashboard -- see design note #0.
 */
export function ChatBox({ roomId, address, displayName, title = "Room chat" }: ChatBoxProps) {
  const { messages, sendMessage, error, available } = useFirestoreChat(roomId, address, displayName);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll-to-bottom on new arrivals -- the same convention `TopTicker`'s
  // own design note #5 established for the accordion history, so both chat
  // surfaces behave identically.
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length]);

  const handleSend = useCallback(() => {
    const text = draft;
    setDraft(""); // cleared optimistically; the write is visible immediately
    void sendMessage(text);
  }, [draft, sendMessage]);

  const canSend = available && address !== null && draft.trim().length > 0;

  const body = useMemo(() => {
    if (!available) {
      return <p style={styles.hint}>Real-time chat is offline. {error ?? ""}</p>;
    }
    if (messages.length === 0) {
      return <p style={styles.hint}>No messages yet -- say hello while the table fills up.</p>;
    }
    return messages.map((message) => (
      <div key={message.id} style={styles.message}>
        <div style={styles.messageHeader}>
          <span style={{ ...styles.messageAuthor, color: colorForAuthor(message.author) }}>
            {message.author}
          </span>
          <span style={styles.messageTime}>{message.timestamp}</span>
        </div>
        <div style={styles.messageText}>{message.text}</div>
      </div>
    ));
  }, [available, error, messages]);

  return (
    <section style={styles.root} aria-label={title}>
      <header style={styles.header}>
        <span>💬 {title}</span>
        {messages.length > 0 && <span style={styles.count}>{messages.length}</span>}
      </header>

      <div style={styles.list} ref={listRef}>
        {body}
      </div>

      {error && available && <p style={styles.error}>{error}</p>}

      <div style={styles.composer}>
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleSend();
            }
          }}
          placeholder={address ? "Type a message..." : "Connect a wallet to chat"}
          aria-label="Room chat message"
          disabled={!available || address === null}
          style={styles.input}
        />
        <button type="button" onClick={handleSend} disabled={!canSend} style={styles.sendButton}>
          Send
        </button>
      </div>
    </section>
  );
}

export default ChatBox;

/* ------------------------------------------------------------------ */
/* Inline styles                                                       */
/* ------------------------------------------------------------------ */
//
// Plain inline styles, matching this codebase's established escape hatch
// (see `TopTicker.tsx`/`InlineQuickChat.tsx`), and the same #0F172A /
// #1E293B recessed-surface palette so the staging room reads as part of
// the same application as the dashboard it hands off to.

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    backgroundColor: "#0F172A",
    border: "1px solid #1e2937",
    borderRadius: "12px",
    overflow: "hidden",
    fontFamily: FONT_FAMILY,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    backgroundColor: "#1E293B",
    borderBottom: "1px solid #2a3a52",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    color: "#F8FAFC",
  },
  count: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: "999px",
    backgroundColor: "#2a3a52",
    color: "#9aa0ac",
  },
  list: {
    flex: 1,
    minHeight: "200px",
    maxHeight: "360px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px 16px",
  },
  hint: {
    fontSize: FONT_SIZE.body,
    color: "#6f7480",
    margin: 0,
  },
  message: {
    borderLeft: "3px solid #2a3a52",
    backgroundColor: "#182236",
    borderRadius: "0 10px 10px 10px",
    padding: "6px 12px",
  },
  messageHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
  },
  messageAuthor: {
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
  },
  messageTime: {
    fontSize: FONT_SIZE.small,
    color: "#6f7480",
  },
  messageText: {
    fontSize: FONT_SIZE.body,
    color: "#c7cbd4",
    marginTop: "1px",
    overflowWrap: "anywhere",
  },
  error: {
    margin: 0,
    padding: "8px 16px",
    fontSize: FONT_SIZE.small,
    color: "#f0b0a8",
    backgroundColor: "#2a1614",
    borderTop: "1px solid #5a2a24",
  },
  composer: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 16px",
    borderTop: "1px solid #1e2937",
  },
  input: {
    flex: 1,
    fontSize: FONT_SIZE.control,
    padding: CONTROL_PADDING.input,
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#0a0e17",
    color: "#e6e8ef",
    boxSizing: "border-box",
  },
  sendButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    cursor: "pointer",
    flexShrink: 0,
  },
};
