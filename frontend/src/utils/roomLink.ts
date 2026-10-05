// frontend/src/utils/roomLink.ts
//
// ==================================================================
//  LIVE-2D: THE ROOM SOCKET -- THE SERVER-OWNED ROOM PROTOCOL, CLIENT SIDE
// ==================================================================
//
// REPLACES `roomDocLink.ts`, whose socket carried a last-write-wins room document, seat PINs and tokens, the parked
// staging lobby and room-code-keyed chat and presence. What rides here now is LIVE-2C's protocol and nothing else:
//
//   up    `room-op {requestId, gameId?, op}`   every change to a table -- create, join, seats, ready, profile,
//                                              visibility, code rotation, kick, host transfer, cancel, start
//         `rooms-watch {on}`                   the public list
//         `room-hello {gameId}`                one game's RoomView, transcript and presence
//         `chat-send {gameId, text}`, `presence-set {gameId, state}`
//   down  `room-ack {requestId, ok, data | code, reason}`, `rooms`, `room {gameId, view}`, `chat`, `presence`,
//         `error {code, reason}`
//
// ONE CHANNEL PER GAME, AND ONE FOR THE LOBBY. The server keeps ONE room view per socket, and its `error` frames name
// no request -- so a socket that watches exactly one game is a socket whose every `error` is about that game. The
// lobby's channel carries the public list and the two ops that name no game yet (create, join). A channel reconnects
// on a short backoff while anybody listens, re-stating its standing subscriptions; a channel nobody listens to is
// closed.
//
// ACCESS LOST IS TERMINAL. `not-found` / `gone` (and the 4410 close that follows them), and `room-full` on a view,
// mean this tab may not read this game any more -- kicked, the room cancelled or expired, a private room dealt
// without it. The channel stops, says so once, and never loops on a reconnect the server will refuse again.
//
// 4401 (the session ended under an open socket) and three failed opens re-bootstrap the session first, exactly as
// the game link does (LIVE-2B); `session-ended` stops everything and `SessionEndedNotice` asks the player.
//
// LIVE-4 (L4-3): EVERY CHANNEL ANNOUNCES THIS BUNDLE (`clientAnnouncement.ts`) -- the lobby's too -- and `reload`,
// `route` and close 4426 are TERMINAL for the channel that gets them, exactly as for the game link:
//   a connection-level `reload` (this bundle's protocol is not accepted, or its announcement unreadable) ends EVERY
//     channel -- the page itself is out of step -- and nothing opens another socket until the page reloads;
//   a per-game `reload` (`client-rules`: this tab cannot play that table's rules) ends that game's channel;
//   a `route` is followed only to a checked destination (`clientAnswers.ts` `routeTargetOf`): another bundle on this
//     page's origin (the page navigates), or another socket path on the game server's (this channel re-attaches
//     there, at most `MAX_ROUTE_HOPS` times); anything else ends the channel as "cannot continue here".
// The page's port (`clientUpdate.ts`) decides what the page does: reload once, or ask; nothing here loops.

import { GAME_SERVER_URL } from "../config";
import { socketUrlFor } from "./devIdentity";
import type { ClientVerdictCode } from "../gameEngine/compat/clientCompatibility";
import { withClientAnnouncement } from "./clientAnnouncement";
import { CLIENT_ANSWER_CLOSE_CODE, CLIENT_ANSWER_SENTENCES, routeTargetOf, type RouteFrame } from "./clientAnswers";
import { MAX_ROUTE_HOPS, clientUpdatePort, type ClientUpdatePort } from "./clientUpdate";
import type { PresenceState } from "./presence";
import {
  ROOM_LOST_CODES,
  refusalMessage,
  supportRefOf,
  type ChatFrame,
  type PresenceFrame,
  type RoomAck,
  type RoomChatEntry,
  type RoomFrame,
  type RoomOpBody,
  type RoomOpResult,
  type RoomSummary,
  type RoomsFrame,
  type RoomView,
} from "./roomProtocol";
import { sessionPort } from "./sessionBootstrap";

/** The lobby's channel: the public list, and the ops that name no game yet. */
export const LOBBY_CHANNEL = "~lobby";

/** How long an op waits for its ack before it is answered as unanswered. Generous: the wire may be a tunnel. */
export const ROOM_OP_TIMEOUT_MS = 12_000;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
/** A channel nobody listens to is closed after this long (so a remount does not cost a reconnect). */
const IDLE_CLOSE_MS = 1_500;

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Why a game's view is gone for this tab (terminal). */
export interface RoomLoss {
  code: string;
  reason: string;
}

interface ViewListener {
  onView: (view: RoomView) => void;
  onLost?: (loss: RoomLoss) => void;
  onError?: (code: string, reason: string) => void;
}

interface Channel {
  key: string;
  socket: SocketLike;
  open: boolean;
  /** Frames written before the socket opened; an op's frame carries its request id so a settled op is withdrawn. */
  backlog: Array<{ text: string; requestId?: string }>;
  /** Subscriptions the server keeps per socket, re-stated after every reconnect. */
  standing: Map<string, string>;
  pending: Map<string, (result: RoomOpResult) => void>;
  views: Set<ViewListener>;
  rooms: Set<{ onRooms: (rooms: RoomSummary[]) => void; onError?: (message: string) => void }>;
  chats: Set<{ onChat: (messages: RoomChatEntry[]) => void; onError?: (code: string, reason: string) => void }>;
  presences: Set<(entries: PresenceState[], serverNow?: number) => void>;
  last: { view?: RoomView; rooms?: RoomSummary[]; chat?: RoomChatEntry[]; presence?: { entries: PresenceState[]; now?: number } };
  /** Terminal: this tab may not read this game any more. */
  lost: RoomLoss | null;
  /** The code of the last `error` frame, so a 4410 close can say which loss it was. */
  lastErrorCode: string | null;
  reconnect: ReturnType<typeof setTimeout> | null;
  idle: ReturnType<typeof setTimeout> | null;
  attempts: number;
  failedOpens: number;
  rebootstrap: boolean;
  retired: boolean;
  /** LIVE-4 (L4-3): the socket URL a checked route moved this channel to (another path on the game server), or null. */
  url: string | null;
  /** LIVE-4 (L4-3): routes to another socket path this channel has followed. */
  socketRoutes: number;
  /** LIVE-4 (L4-3): set while this channel closes its own socket to re-attach on a routed path. */
  rerouting: boolean;
}

const channels = new Map<string, Channel>();
/** Games this tab lost for good (kicked, gone, a private room it may no longer read): a later subscription is told at
 *  once instead of asking the server again. A full viewer cap is not remembered -- a seat may free up. */
const lostGames = new Map<string, RoomLoss>();
let requestSeq = 0;

let socketFactory: (url: string) => SocketLike = (url) => new WebSocket(url) as unknown as SocketLike;

/* ==================================================================
    LIVE-4 (L4-3): WHAT THIS PAGE WAS TOLD TO STOP TALKING ABOUT
   ================================================================== */
/** A connection-level `reload` ended the page's links: nothing opens another socket until the page reloads. */
let pageAnswer: { code: ClientVerdictCode; reason: string } | null = null;
/** Games whose channel a per-game `reload` / `route` ended: not asked again until the page reloads. */
const answeredGames = new Map<string, string>();
let updatePort: ClientUpdatePort | null = null;
let announcementOverride: string | null = null;
let routeEnvironmentOverride: { pageOrigin: string; bundleBase: string } | null = null;

const port = (): ClientUpdatePort => updatePort ?? clientUpdatePort();

/** Injectable for tests; the browser has no reason to touch it. */
export function setRoomSocketFactory(factory: (url: string) => SocketLike): void {
  socketFactory = factory;
}

/** LIVE-4 (L4-3), tests only: the page's port, this tab's announcement and its route environment. */
export function setRoomClientUpdate(options: { port?: ClientUpdatePort | null; announcement?: string | null; routeEnvironment?: { pageOrigin: string; bundleBase: string } | null }): void {
  if (options.port !== undefined) updatePort = options.port;
  if (options.announcement !== undefined) announcementOverride = options.announcement;
  if (options.routeEnvironment !== undefined) routeEnvironmentOverride = options.routeEnvironment;
}

/** Drops every channel. Tests only. */
export function resetRoomLinks(): void {
  channels.forEach((channel) => retire(channel));
  channels.clear();
  lostGames.clear();
  answeredGames.clear();
  pageAnswer = null;
}

/** Whether a game server is configured -- the same switch the game link uses (#1213). */
export function roomLinkAvailable(): boolean {
  return Boolean(GAME_SERVER_URL);
}

/** LIVE-4 (L4-3): the sentence a request is answered with because this page (or this table) was told `reload` or
 *  `route` -- `null` when it was not, and the request may go out. */
function clientAnswerFor(gameId: string | undefined): string | null {
  if (pageAnswer !== null) return pageAnswer.reason;
  return gameId === undefined ? null : (answeredGames.get(gameId) ?? null);
}

const NO_SOCKET_YET: SocketLike = { send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null };

function listening(channel: Channel): boolean {
  return channel.views.size + channel.rooms.size + channel.chats.size + channel.presences.size + channel.pending.size > 0;
}

function retire(channel: Channel, pendingReason = "The connection to the game server closed."): void {
  channel.retired = true;
  if (channel.reconnect !== null) clearTimeout(channel.reconnect);
  if (channel.idle !== null) clearTimeout(channel.idle);
  channel.reconnect = null;
  channel.idle = null;
  channel.pending.forEach((settle) => settle({ ok: false, code: "unavailable", reason: pendingReason }));
  channel.pending.clear();
  try {
    channel.socket.close();
  } catch {
    /* already closed */
  }
  if (channels.get(channel.key) === channel) channels.delete(channel.key);
}

/** Close a channel nobody listens to, after a moment (a remount re-subscribes without a reconnect). */
function releaseIfIdle(channel: Channel): void {
  if (listening(channel) || channel.retired) return;
  if (channel.idle !== null) clearTimeout(channel.idle);
  channel.idle = setTimeout(() => {
    channel.idle = null;
    if (!listening(channel)) retire(channel);
  }, IDLE_CLOSE_MS);
}

function scheduleReconnect(channel: Channel): void {
  if (channel.retired || channel.lost !== null) return;
  if (!listening(channel)) {
    retire(channel);
    return;
  }
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(channel.attempts, 4));
  channel.attempts += 1;
  channel.reconnect = setTimeout(() => {
    channel.reconnect = null;
    if (channel.retired || !listening(channel)) {
      retire(channel);
      return;
    }
    attach(channel);
  }, delay);
}

/** Opens (or reopens) the channel's socket -- once the session is bootstrapped (LIVE-2 §4.3). */
/** P3-ACCT (public first): a signed-out visitor's session opens sockets too -- the server answers it the public,
 *  read-only surface only (the list, a public table's view and log) and `profile-required` to everything else. */
const canOpen = (state: string): boolean => state === "ready" || state === "unprofiled";

function attach(channel: Channel): void {
  const session = sessionPort();
  if (canOpen(session.state) && !(channel.rebootstrap && session.refreshable)) {
    channel.rebootstrap = false;
    attachNow(channel);
    return;
  }
  const force = channel.rebootstrap;
  channel.rebootstrap = false;
  channel.socket = NO_SOCKET_YET;
  void session.ensure(force).then((state) => {
    if (channel.retired || channels.get(channel.key) !== channel) return;
    /* Review L1: a socket opened meanwhile (a renewal's own attach answered first) is the channel's; never a second. */
    if (channel.socket !== NO_SOCKET_YET) return;
    if (canOpen(state)) attachNow(channel);
    else if (state === "unknown") scheduleReconnect(channel);
    /* "ended": terminal for this page -- `SessionEndedNotice` asks the player; nothing reconnects. */
  });
}

let renewals = 0;
const renewalListeners = new Set<() => void>();

/** How many times this page's links were renewed (an answer to an op sent before a renewal belongs to the old session). */
export function roomLinkRenewals(): number {
  return renewals;
}

/** Told after every renewal (the lobby re-asks what it read on the old session: review M2). */
export function onRoomLinksRenewed(listener: () => void): () => void {
  renewalListeners.add(listener);
  return () => {
    renewalListeners.delete(listener);
  };
}

/** P3-ACCT: this browser just signed in (or out): its session was REPLACED, and every socket on the old one is about to
 *  be closed 4401 by the server. Re-open every channel now on the session the port holds, re-stating its standing
 *  subscriptions, so the action the player was resuming goes out on the new session rather than the dying socket. An
 *  op SENT on the old socket and still unanswered is told the connection was renewed (it may or may not have landed:
 *  the view pushed after the re-open says which). Review M2: an op that never left this page (still in the backlog,
 *  waiting for a socket) is not ambiguous at all -- it stays queued and goes out on the new socket. */
export function renewRoomLinks(): void {
  renewals += 1;
  for (const channel of Array.from(channels.values())) {
    if (channel.retired) continue;
    const old = channel.socket;
    channel.open = false;
    const unsent = new Set(channel.backlog.map((queued) => queued.requestId).filter((id): id is string => id !== undefined));
    channel.pending.forEach((settle, requestId) => {
      if (unsent.has(requestId)) return;
      settle({ ok: false, code: "unavailable", reason: "The connection to the game server was renewed for your account. Check the table and try again." });
      channel.pending.delete(requestId);
    });
    if (channel.reconnect !== null) {
      clearTimeout(channel.reconnect);
      channel.reconnect = null;
    }
    channel.rebootstrap = false;
    channel.failedOpens = 0;
    channel.socket = NO_SOCKET_YET;
    attach(channel);
    try {
      old.close();
    } catch {
      /* already closed */
    }
  }
  renewalListeners.forEach((listener) => listener());
}

/** A loss is said once, to every view listener, and the channel stops for good. */
function lose(channel: Channel, loss: RoomLoss): void {
  if (channel.lost !== null) return;
  channel.lost = loss;
  if (loss.code !== "room-full") lostGames.set(channel.key, loss);
  channel.views.forEach((listener) => listener.onLost?.(loss));
  retire(channel);
}

/* ---------------------------------------------------------------------------
    LIVE-4 (L4-3): `reload`, `route`, 4426 -- TERMINAL FOR THE CHANNEL; THE PAGE DECIDES
   --------------------------------------------------------------------------- */

const CONNECTION_LEVEL_CODES: ReadonlySet<string> = new Set(["client-protocol", "client-announcement"]);

/** `reload` (or a bare 4426). A connection-level one ends every channel of this page; a per-game one ends this game's. */
function answerReload(channel: Channel, code: ClientVerdictCode): void {
  if (channel.retired && pageAnswer !== null) return;
  if (CONNECTION_LEVEL_CODES.has(code) || channel.key === LOBBY_CHANNEL) {
    const connection: ClientVerdictCode = CONNECTION_LEVEL_CODES.has(code) ? code : "client-protocol";
    if (pageAnswer !== null) return;
    pageAnswer = { code: connection, reason: CLIENT_ANSWER_SENTENCES[connection] };
    for (const other of Array.from(channels.values())) {
      other.rooms.forEach((listener) => listener.onError?.(CLIENT_ANSWER_SENTENCES[connection]));
      retire(other, CLIENT_ANSWER_SENTENCES[connection]);
    }
    port().reload({ code: connection, gameId: null });
    return;
  }
  if (answeredGames.has(channel.key)) return;
  answeredGames.set(channel.key, CLIENT_ANSWER_SENTENCES["client-rules"]);
  /* A channel nobody listens to any more (the table was just left; it closes after IDLE_CLOSE_MS) is retired, and the
     page is not reloaded for a table it is no longer showing. */
  const listened = listening(channel);
  retire(channel, CLIENT_ANSWER_SENTENCES["client-rules"]);
  if (listened) port().reload({ code: "client-rules", gameId: channel.key });
}

/** `route`: follow a checked destination, or end the channel as "cannot continue here" (never a made-up target). */
function answerRoute(channel: Channel, frame: RouteFrame): void {
  if (channel.retired) return;
  const environment = routeEnvironmentOverride ?? pageRouteEnvironment();
  const target = routeTargetOf(frame, { ...environment, gameServerUrl: GAME_SERVER_URL ?? null, gameId: channel.key === LOBBY_CHANNEL ? null : channel.key });
  if (target.kind === "bundle") {
    answeredGames.set(channel.key, CLIENT_ANSWER_SENTENCES.route);
    retire(channel, CLIENT_ANSWER_SENTENCES.route);
    port().routeToBundle({ url: target.url, gameId: channel.key });
    return;
  }
  if (target.kind === "socket" && channel.socketRoutes < MAX_ROUTE_HOPS) {
    channel.socketRoutes += 1;
    channel.url = target.url;
    channel.rerouting = true;
    try {
      channel.socket.close();
    } catch {
      /* already closed: its close handler re-attaches */
    }
    return;
  }
  /* Fail closed, as for a table this server does not continue: said once, nothing reconnects -- and NOT a loss. The
     table is still this player's and is kept exactly as it was, so the tab keeps its pointer to it (a loss would forget
     it and say "not open to you"): every listener is told the sentence, as the log link says it, and a later
     subscriber hears it at once (`clientAnswerFor`). */
  const sentence = CLIENT_ANSWER_SENTENCES["route-unavailable"];
  if (channel.key === LOBBY_CHANNEL) {
    channel.rooms.forEach((listener) => listener.onError?.(sentence));
  } else {
    answeredGames.set(channel.key, sentence);
    channel.views.forEach((listener) => listener.onError?.("unavailable", sentence));
    channel.chats.forEach((listener) => listener.onError?.("unavailable", sentence));
  }
  retire(channel, sentence);
}

/** This page's origin and this bundle's base path (a route to it is no route). */
function pageRouteEnvironment(): { pageOrigin: string; bundleBase: string } {
  const pageOrigin = typeof window !== "undefined" && typeof window.location !== "undefined" ? window.location.origin : "";
  let bundleBase = "/";
  try {
    bundleBase = new URL(process.env.PUBLIC_URL || "/", pageOrigin || "http://localhost").pathname;
  } catch {
    bundleBase = "/";
  }
  return { pageOrigin, bundleBase };
}

function attachNow(channel: Channel): void {
  /* LIVE-4 (L4-3): the announcement on every channel's socket; a routed channel opens on its routed path. */
  const url = channel.url ?? GAME_SERVER_URL ?? "";
  const socket = socketFactory(socketUrlFor(announcementOverride === null ? withClientAnnouncement(url) : withClientAnnouncement(url, announcementOverride)));
  channel.socket = socket;
  let opened = false;

  socket.onopen = () => {
    if (channel.socket !== socket) return;
    opened = true;
    channel.open = true;
    channel.failedOpens = 0;
    channel.attempts = 0;
    channel.standing.forEach((text) => socket.send(text));
    for (const queued of channel.backlog.splice(0)) socket.send(queued.text);
  };

  socket.onmessage = (event) => {
    if (channel.socket !== socket) return;
    let frame: { kind?: unknown; [field: string]: unknown };
    try {
      frame = JSON.parse(String(event.data)) as typeof frame;
    } catch {
      return;
    }
    switch (frame.kind) {
      case "room-ack": {
        const ack = frame as unknown as RoomAck;
        const settle = channel.pending.get(ack.requestId);
        if (settle === undefined) return;
        channel.pending.delete(ack.requestId);
        settle(ack.ok ? { ok: true, data: ack.data ?? {} } : { ok: false, code: ack.code, reason: ack.reason });
        releaseIfIdle(channel);
        return;
      }
      case "room": {
        const view = (frame as unknown as RoomFrame).view;
        if (!view || (frame as unknown as RoomFrame).gameId !== channel.key) return;
        channel.last.view = view;
        channel.views.forEach((listener) => listener.onView(view));
        return;
      }
      case "rooms": {
        const rooms = Array.isArray((frame as unknown as RoomsFrame).rooms) ? (frame as unknown as RoomsFrame).rooms : [];
        channel.last.rooms = rooms;
        channel.rooms.forEach((listener) => listener.onRooms(rooms));
        return;
      }
      /* LIVE-4 (L4-3): client protocol 1's answers -- terminal for this channel; the page decides. */
      case "reload": {
        const code = frame.code === "client-rules" || frame.code === "client-announcement" ? frame.code : "client-protocol";
        answerReload(channel, code);
        return;
      }
      case "route": {
        answerRoute(channel, frame as unknown as RouteFrame);
        return;
      }
      case "chat": {
        const chat = frame as unknown as ChatFrame;
        if (chat.gameId !== channel.key) return;
        const messages = Array.isArray(chat.messages) ? chat.messages : [];
        channel.last.chat = messages;
        channel.chats.forEach((listener) => listener.onChat(messages));
        return;
      }
      case "presence": {
        const presence = frame as unknown as PresenceFrame;
        if (presence.gameId !== channel.key) return;
        const entries = Array.isArray(presence.entries) ? presence.entries : [];
        const now = typeof presence.now === "number" && Number.isFinite(presence.now) ? presence.now : undefined;
        channel.last.presence = { entries, now };
        channel.presences.forEach((listener) => listener(entries, now));
        return;
      }
      case "error": {
        const code = typeof frame.code === "string" ? frame.code : "error";
        const reason = typeof frame.reason === "string" ? frame.reason : "The game server refused that.";
        channel.lastErrorCode = code;
        if (channel.key === LOBBY_CHANNEL) {
          /* The player reads a sentence; a support reference goes to the console, never the screen. */
          const ref = supportRefOf(reason);
          // eslint-disable-next-line no-console
          if (ref !== null) console.warn(`[rooms] the game list was refused (${code}, ref ${ref})`);
          channel.rooms.forEach((listener) => listener.onError?.(refusalMessage(code, reason)));
          return;
        }
        /* A game channel watches one game, so every error on it is about that game. Access lost is terminal. */
        if (ROOM_LOST_CODES.has(code) || code === "room-full") {
          lose(channel, { code, reason });
          return;
        }
        channel.views.forEach((listener) => listener.onError?.(code, reason));
        channel.chats.forEach((listener) => listener.onError?.(code, reason));
        return;
      }
      default:
        return;
    }
  };

  socket.onerror = () => undefined;

  socket.onclose = (event) => {
    if (channel.socket !== socket) return;
    channel.open = false;
    const code = (event as { code?: unknown } | null)?.code;
    /* LIVE-4 (L4-3): this channel closed its own socket to follow a route to another path -- re-attach there now,
       re-stating its standing subscriptions. */
    if (channel.rerouting && !channel.retired) {
      channel.rerouting = false;
      channel.pending.forEach((settle) => settle({ ok: false, code: "unavailable", reason: "The connection to the game server dropped. Check the table and try again." }));
      channel.pending.clear();
      channel.backlog = channel.backlog.filter((queued) => queued.requestId === undefined);
      attach(channel);
      return;
    }
    /* LIVE-4 (L4-3): 4426 -- this bundle may not talk to this server (its `reload` frame, if one came, ended the
       channel already). Terminal, never looped on. */
    if (code === CLIENT_ANSWER_CLOSE_CODE) {
      if (!channel.retired) answerReload(channel, "client-protocol");
      return;
    }
    /* 4410: read access to this game is gone (§6.2). Terminal; the error frame before it named why. */
    if (code === 4410 && channel.key !== LOBBY_CHANNEL) {
      const known = channel.lastErrorCode;
      lose(channel, { code: known !== null && (ROOM_LOST_CODES.has(known) || known === "room-full") ? known : "not-found", reason: "You no longer have access to that table." });
      return;
    }
    if (!opened) channel.failedOpens += 1;
    if (code === 4401 || channel.failedOpens >= 3) {
      channel.failedOpens = 0;
      channel.rebootstrap = true;
    }
    /* An op in flight when the wire dropped may or may not have landed; the view pushed after the reconnect says
       which. Its caller is told the connection went, never that it failed. */
    channel.pending.forEach((settle) => settle({ ok: false, code: "unavailable", reason: "The connection to the game server dropped. Check the table and try again." }));
    channel.pending.clear();
    /* LIVE-2D: AN OP ITS CALLER WAS TOLD FAILED IS NEVER SENT LATER. One still queued (the socket never opened) is
       withdrawn with its answer -- else the next open would create the table the player was told was not created,
       and a second click would make two. */
    channel.backlog = channel.backlog.filter((queued) => queued.requestId === undefined);
    if (channel.retired) return;
    scheduleReconnect(channel);
  };
}

function channelFor(key: string): Channel {
  const existing = channels.get(key);
  if (existing && !existing.retired) {
    if (existing.idle !== null) {
      clearTimeout(existing.idle);
      existing.idle = null;
    }
    return existing;
  }
  const channel: Channel = {
    key,
    socket: NO_SOCKET_YET,
    open: false,
    backlog: [],
    standing: new Map(),
    pending: new Map(),
    views: new Set(),
    rooms: new Set(),
    chats: new Set(),
    presences: new Set(),
    last: {},
    lost: null,
    lastErrorCode: null,
    reconnect: null,
    idle: null,
    attempts: 0,
    failedOpens: 0,
    rebootstrap: false,
    retired: false,
    url: null,
    socketRoutes: 0,
    rerouting: false,
  };
  channels.set(key, channel);
  attach(channel);
  return channel;
}

function send(channel: Channel, frame: object, requestId?: string): void {
  const text = JSON.stringify(frame);
  if (channel.open) channel.socket.send(text);
  else channel.backlog.push({ text, requestId });
}

/** A subscription the server keeps per socket. Re-stated only when it changes (or after a reconnect): the server
 *  answers every `room-hello` with a fresh view and transcript, so saying it again on every chat line or remount
 *  would re-push the room to everybody for nothing. */
function stand(channel: Channel, key: string, frame: object): void {
  const text = JSON.stringify(frame);
  if (channel.standing.get(key) === text) return;
  channel.standing.set(key, text);
  if (channel.open) channel.socket.send(text);
}

/* ---------------------------------------------------------------------------
    THE API
   --------------------------------------------------------------------------- */

/** One room operation, answered by its ack. Create and join ride the lobby channel (they name no game yet); every
 *  other op rides its game's channel, behind that game's `room-hello`. Resolved, never rejected. */
export function roomOp(op: RoomOpBody, gameId?: string): Promise<RoomOpResult> {
  if (!roomLinkAvailable()) return Promise.resolve({ ok: false, code: "unavailable", reason: "No game server is configured in this build." });
  /* LIVE-4 (L4-3): nothing is sent after this page (or this table) was told it cannot talk here. */
  const answered = clientAnswerFor(gameId);
  if (answered !== null) return Promise.resolve({ ok: false, code: "unavailable", reason: answered });
  const known = gameId === undefined ? undefined : lostGames.get(gameId);
  if (known !== undefined) return Promise.resolve({ ok: false, code: known.code, reason: known.reason });
  const channel = channelFor(gameId ?? LOBBY_CHANNEL);
  requestSeq += 1;
  const requestId = `r${Date.now().toString(36)}${requestSeq.toString(36)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!channel.pending.has(requestId)) return;
      channel.pending.delete(requestId);
      channel.backlog = channel.backlog.filter((queued) => queued.requestId !== requestId);
      resolve({ ok: false, code: "timeout", reason: "The game server did not answer. Check the connection and try again." });
      releaseIfIdle(channel);
    }, ROOM_OP_TIMEOUT_MS);
    channel.pending.set(requestId, (result) => {
      clearTimeout(timer);
      /* LIVE-2D: a table this tab lost (it left, was made private, its code rotated) and has just been admitted to
         again is readable again -- forget the loss, or the new seat would be one it cannot see. */
      if (result.ok && (op.type === "create" || op.type === "join") && typeof result.data.gameId === "string") {
        lostGames.delete(result.data.gameId);
      }
      resolve(result);
    });
    send(channel, { kind: "room-op", requestId, ...(gameId !== undefined ? { gameId } : {}), op }, requestId);
  });
}

/** The public list (`rooms-watch`). Returns the unsubscribe. */
export function watchPublicRooms(onRooms: (rooms: RoomSummary[]) => void, onError?: (message: string) => void): () => void {
  if (pageAnswer !== null) {
    onError?.(pageAnswer.reason);
    return () => undefined;
  }
  const channel = channelFor(LOBBY_CHANNEL);
  const listener = { onRooms, onError };
  channel.rooms.add(listener);
  stand(channel, "rooms-watch", { kind: "rooms-watch", on: true });
  if (channel.last.rooms !== undefined) onRooms(channel.last.rooms);
  return () => {
    channel.rooms.delete(listener);
    if (channel.rooms.size === 0) {
      channel.standing.delete("rooms-watch");
      if (channel.open) channel.socket.send(JSON.stringify({ kind: "rooms-watch", on: false }));
    }
    releaseIfIdle(channel);
  };
}

/** One game's RoomView (`room-hello {gameId}`), pushed on every committed change. A late subscriber is handed the
 *  last view at once. `onLost` is terminal. Returns the unsubscribe. */
export function watchRoom(gameId: string, listener: ViewListener): () => void {
  const known = lostGames.get(gameId);
  if (known !== undefined) {
    listener.onLost?.(known);
    return () => undefined;
  }
  const answered = clientAnswerFor(gameId);
  if (answered !== null) {
    listener.onError?.("unavailable", answered);
    return () => undefined;
  }
  const channel = channelFor(gameId);
  channel.views.add(listener);
  stand(channel, "room-hello", { kind: "room-hello", gameId });
  if (channel.last.view !== undefined) listener.onView(channel.last.view);
  return () => {
    channel.views.delete(listener);
    releaseIfIdle(channel);
  };
}

/** The game's transcript, whole, on every line (it rides the game's `room-hello`). */
export function subscribeChat(
  gameId: string,
  onChat: (messages: RoomChatEntry[]) => void,
  onError?: (code: string, reason: string) => void,
): () => void {
  if (lostGames.has(gameId)) return () => undefined;
  /* LIVE-4 (L4-3): a table (or page) this tab was told it cannot talk about here: said at once, nothing opened. */
  const answered = clientAnswerFor(gameId);
  if (answered !== null) {
    onError?.("unavailable", answered);
    return () => undefined;
  }
  const channel = channelFor(gameId);
  const listener = { onChat, onError };
  channel.chats.add(listener);
  stand(channel, "room-hello", { kind: "room-hello", gameId });
  if (channel.last.chat !== undefined) onChat(channel.last.chat);
  return () => {
    channel.chats.delete(listener);
    releaseIfIdle(channel);
  };
}

/** A chat line. The server signs it with this principal's seat (`author` = player id, `displayName` = its nickname);
 *  the frame carries neither. Spectators may not chat (OD-L2-4) and are told so in `onError`. */
export function sendChat(gameId: string, text: string): void {
  if (lostGames.has(gameId) || clientAnswerFor(gameId) !== null) return;
  const channel = channelFor(gameId);
  stand(channel, "room-hello", { kind: "room-hello", gameId }); // a no-op when it already stands
  send(channel, { kind: "chat-send", gameId, text });
}

export function subscribePresence(gameId: string, onPresence: (entries: PresenceState[], serverNow?: number) => void): () => void {
  if (lostGames.has(gameId) || clientAnswerFor(gameId) !== null) return () => undefined;
  const channel = channelFor(gameId);
  channel.presences.add(onPresence);
  stand(channel, "room-hello", { kind: "room-hello", gameId });
  if (channel.last.presence !== undefined) onPresence(channel.last.presence.entries, channel.last.presence.now);
  return () => {
    channel.presences.delete(onPresence);
    releaseIfIdle(channel);
  };
}

/** This seat's presence hint (`null` clears it). The server stamps `playerId` and `at` itself. */
export function sendPresence(gameId: string, state: PresenceState | null): void {
  const channel = channels.get(gameId);
  if (channel === undefined || channel.retired || channel.lost !== null) return;
  send(channel, { kind: "presence-set", gameId, state });
}
