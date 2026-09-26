// Real-time chat transport over the game server's room socket (`roomLink`, keyed by `gameId`).
//
// The primary export is `useRoomChat`, NOT the component: the dashboard's chat surface is `TopTicker`'s
// accordion fed by `mergeFeedItems`. Chat is off-chain and carries NO AUTHORITY -- no code path in this app
// parses a chat message.
//
// #1361a: THE TRANSCRIPT LIVES ON THE GAME SERVER. It was `games/{roomId}/chat` on Firestore (and
// `sandbox_rooms/{code}/chat` for a sandbox room, #644); Firestore is gone. The server keeps one transcript
// per room, capped at `CHAT_HISTORY_LIMIT`, persisted beside the room's log, and sends the WHOLE of it on
// every change -- so ordering is the server's clock and there is no pending-write window for a message to
// fall out of. The hook's contract is unchanged: `ChatMessage[]` oldest-first, `sendMessage`, `error`,
// `available`.
//
// LIVE-2D: CHAT IS KEYED BY `gameId` AND SIGNED BY THE SERVER. The frame carries the text and nothing else -- the
// server stamps `author` (the speaking seat's `player_id`) and `displayName` (that seat's nickname) itself, and
// refuses a spectator (OD-L2-4: only seated players chat). The staging lobby's standalone chat box went with the
// staging lobby.
//
// See docs/ai_architecture/firebase_middleware.md, ChatBox.tsx #0 / #1 / #2.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { backendConfigError } from "../config/backend";
import { seatLabel } from "../utils/lobby";
import { roomLinkAvailable, sendChat, subscribeChat } from "../utils/roomLink";
import type { RoomChatEntry } from "../utils/roomProtocol";
import type { ChatMessage } from "../utils/feed";

/** How much scrollback a room keeps. Bounded because a transcript only ever grows and the server sends the
 *  whole of it on every change -- an unbounded one would re-send an entire game's chat per message. The
 *  server enforces it; this is the figure the client expects. */
export const CHAT_HISTORY_LIMIT = 200;

const MAX_MESSAGE_LENGTH = 500;

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

function decodeMessage(entry: RoomChatEntry): ChatMessage | null {
  const text = typeof entry.text === "string" ? entry.text.trim() : "";
  if (!text) return null;

  const address = typeof entry.author === "string" ? entry.author : "";
  const displayName = typeof entry.displayName === "string" ? entry.displayName : "";
  const timestampMs = typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : Date.now();

  return {
    id: String(entry.id),
    author: seatLabel({ address, displayName }),
    text: text.slice(0, MAX_MESSAGE_LENGTH),
    timestamp: new Date(timestampMs).toLocaleTimeString(),
    timestampMs,
  };
}

/* ------------------------------------------------------------------ */
/* The hook -- design note #0                                          */
/* ------------------------------------------------------------------ */

export interface RoomChatResult {
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
  /** `false` when the game server is unconfigured or no room is selected. */
  available: boolean;
}

/**
 * Subscribes to a room's transcript on the game server and returns it in the exact `ChatMessage[]` shape
 * `utils/feed.ts` already defines.
 *
 * @param roomId  LIVE-2D: the game's `gameId`. Pass `null` to subscribe to nothing.
 * @param address This tab's seat (`RoomView.you.playerId`) -- used ONLY to decide whether a Send is worth offering
 *                (a spectator may not chat). It is never sent: the server signs every line with the seat it derives.
 *                `null` disables sending (but not reading).
 * @param displayName Used only for the offline echo; the server signs delivered lines with the seat's nickname.
 */
/* Design note #644: the sandbox had no chat, twice over. Two independent gates,
   either enough on its own: `App.tsx` passed `sandbox ? null : roomId` on design
   note #24 reasoning that has not been true since #578 (the sandbox is the
   multiplayer mode and already has a real room writing an action log); and
   `sendMessage` refuses when `address` is null, which in a sandbox it always is.

   AND A THIRD CASE THE FIX HAS TO COVER: a build with no game server configured at all, which is a supported
   way to run this app. There is no transport there and a Send button that silently does nothing is the worst
   of the three outcomes, so the hook falls back to keeping messages in memory -- what chat was before design
   note #22 moved it off the client, and honest for a session that is local by construction.

   THE ERROR STATE IS NOT THE FALLBACK. A configured server that REFUSES a write still reports the failure; it
   does not quietly divert to local state and leave a player believing the table saw their message. Local is
   for "there is no transport", never for "the transport said no". */
let nextLocalChatId = 1;

export function useRoomChat(
  roomId: string | null,
  address: string | null,
  displayName: string,
): RoomChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const onServer = roomLinkAvailable();
  const available = onServer && roomId !== null;

  // Kept in a ref so `sendMessage` stays referentially stable across
  // renames -- `InlineQuickChat` receives it as an `onSend` prop, and an
  // identity that changed on every keystroke would defeat memoisation all
  // the way down that tree.
  const identityRef = useRef({ address, displayName });
  identityRef.current = { address, displayName };

  useEffect(() => {
    if (!onServer || !roomId) {
      setMessages([]);
      setError(onServer ? null : backendConfigError());
      return;
    }

    /* LIVE-2D: the game's own room socket -- the one its RoomView rides -- so a line is authorized against the same
       record the view is. */
    const unsubscribe = subscribeChat(
      roomId,
      (entries) => {
        const decoded = entries
          .map(decodeMessage)
          .filter((message): message is ChatMessage => message !== null)
          .sort((a, b) => a.timestampMs - b.timestampMs);
        setMessages(decoded);
        setError(null);
      },
      (code) => {
        /* Said as the refusal it is. A spectator's line is refused `forbidden` (OD-L2-4). */
        if (code === "forbidden" || code === "not-seated") setError("Only seated players can chat at this table.");
        else if (code === "rate-limited") setError("You are chatting too quickly. Wait a moment.");
        else if (code !== "wrong-state") setError("Chat is unavailable right now.");
      },
    );

    return unsubscribe;
    // Design note #644: switching rooms resubscribes rather than listening to the old one.
  }, [onServer, roomId]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!trimmed) return;

      const { address: sender, displayName: name } = identityRef.current;
      /* Design note #644: no transport is not a failure, it is a local
         session. The message is kept in memory so the button does what it
         says, and the feed shows it exactly as a delivered one -- because
         within this browser it IS delivered; there is nobody else to reach. */
      if (!onServer || !roomId) {
        setLocalMessages((current) => [
          ...current,
          {
            id: `local-${nextLocalChatId++}`,
            /* Design note #765: THE SAME FUNCTION THE DELIVERED MESSAGE USES. This read `sender || name`,
               which prefers the ADDRESS over the display name -- so an offline echo was labelled with a
               wallet or a local player id even when a perfectly good name was in hand, and the same message
               would relabel itself if it ever round-tripped. `seatLabel` is what `decodeMessage` calls, so
               the optimistic line and the delivered one cannot disagree by construction.
               `sender ?? ""` because the ADDRESS is nullable here and `seatLabel` is not -- offline with no
               wallet is exactly the case this branch exists for, and it falls through to "You". */
            author: seatLabel({ address: sender ?? "", displayName: name }) || "You",
            text: trimmed,
            timestamp: new Date().toLocaleTimeString(),
            timestampMs: Date.now(),
          },
        ]);
        setError(null);
        return;
      }
      if (!sender) {
        setError("Only seated players can chat at this table.");
        return;
      }

      try {
        /* #1361a: fire-and-forget. The message is visible when the server's next `chat` frame arrives -- the server
           is the one clock, the one order, and (LIVE-2D) the one that says who said it. */
        void name;
        sendChat(roomId, trimmed);
        setError(null);
      } catch (sendError) {
        setError(
          `[server] Message not sent: ${
            sendError instanceof Error ? sendError.message : String(sendError)
          }`,
        );
      }
    },
    [onServer, roomId],
  );

  /* Design note #644: one list either way. A caller should not have to know
     which transport answered -- and on the local path `messages` is empty, so
     this is a concatenation rather than a choice. */
  const allMessages = useMemo(
    () => (localMessages.length === 0 ? messages : [...messages, ...localMessages]),
    [messages, localMessages],
  );

  return { messages: allMessages, sendMessage, error, available };
}
