// frontend/src/utils/serverLink.ts
//
// The client half of the wire. Submits intents; receives log entries.
//
// ==================================================================
//  DESIGN NOTE 1212: SHAPED LIKE WHAT IT REPLACES
// ==================================================================
//
// THE SHELL TODAY CALLS TWO THINGS: `appendSandboxAction(room, nextIndex, actor, msg, derived)`, which
// returns the index it allocated, and `subscribeSandboxLog(room, onActions)`, which hands back entries. Both
// are Firestore's shape, and both are about to stop being how a room works.
//
// SO THIS FILE DELIBERATELY OFFERS THE SAME TWO SHAPES. `submit` resolves to an allocated index or `null`;
// entries arrive through a callback. The cutover in `App.tsx` is then a SWAP rather than a rewrite -- which
// matters more than elegance here, because that file is the one place this project cannot verify cheaply and
// every line of diff in it is a line nobody can test.
//
// WHAT IS NOT MIRRORED IS WHO ALLOCATES. `appendSandboxAction` ran a Firestore transaction because racing
// BROWSERS collided on an index (#1026). One writer needs no transaction: the server allocates and the index
// comes back on the entry. That machinery becomes dead weight the moment this file is wired in, and not one
// commit before.
//
// ---------------------------------------------------------------------------
//  MATCHING A REPLY TO A SUBMISSION
// ---------------------------------------------------------------------------
//
// A burst of dispatches puts several submissions in flight at once -- the shell loops over routes, and #941
// records why. So a reply has to find its caller.
//
// FIFO IS CORRECT AND IS THE MECHANISM. One socket delivers frames in order, the server handles them in
// order, and it answers each before reading the next. The oldest unanswered submission is therefore the one
// this reply belongs to, whatever kind of reply it is -- and a refusal carries no entry, so it could not be
// matched any other way.
//
// THE NONCE IS THE CHECK, NOT THE MECHANISM. An `applied` frame carries the entry, and the entry carries the
// `submission_id` this client minted (#1209). Where it is present it is asserted against the queue's head.
// If those two ever disagree the ordering assumption above has broken, and a silent mismatch would resolve
// somebody else's dispatch with this one's index -- so it is reported rather than shrugged at.
//
// ==================================================================
//  LIVE-3A (L3-3): THE ANSWER NAMES ITS SUBMISSION, AND FIFO IS ONLY THE FALLBACK
// ==================================================================
//
// THE ORDERING ASSUMPTION ABOVE BROKE, AND ON PURPOSE. The server now runs each room's submissions one at a
// time on the room's actor, so another player's move that committed first is fanned out to this socket BEFORE
// this client's own queued answer -- deterministically. FIFO then resolved this client's submission with the
// other player's index, reported "out of order", and dropped the real answer (LIVE-3 P4). So every DIRECT answer
// to a submit carries `inReplyTo`, and the rule is:
//   a frame WITH `inReplyTo` settles exactly that submission;
//   a frame WITHOUT one is history -- its entries are applied and it settles nothing.
// LIVE-2D: the FIFO fallback for a server older than LIVE-3A is DELETED -- every server this client can reach names
// the submission it answers, so a frame without `inReplyTo` is always history and never settles anybody's move.
//
// THREE MORE THINGS THE ANSWER CAN SAY NOW:
//   `inFlight` on a reconnecting hello: a submission of this player's that is still being committed. It stays
//      pending -- NOT "try again", or the player makes a move twice (LIVE-3 Appendix C.2 #7) -- until its entry
//      arrives (it landed) or `abandoned` names it (it did not).
//   `ahead` / `resync`: this client holds history the room does not. Everything pending resolves `null`, the
//      local history is dropped (`onResync` -- the shell clears what it accumulated), and the link says hello
//      again from -1. Frames that arrive before that fresh catch-up are dropped: it carries all of them.
//   `status`: the room's availability, for a banner (`onRoomStatus`).
//
// ==================================================================
//  DESIGN NOTE 1253: RECONNECTION, AND WHAT HAPPENS TO A MOVE THAT WAS IN THE AIR
// ==================================================================
//
// #1212 LEFT THIS OUT ON PURPOSE -- "the resilience worth writing is the resilience whose failure modes have
// been seen" -- and kept `baseIndex` so the protocol would already know how to say "here is what you missed".
// The audit (§9, triage 2.5c) then made the case that it is not a nicety: once clocks exist, "a dropped socket
// means a reload" is a reserve tax on bad connections in a money game. So the link now outlives its socket.
//
// ONE LINK, MANY SOCKETS. `connectServerLink` returns the same object for the room's whole life (#1242 made
// that the shell's assumption); when the socket closes for any reason but `close()`, a new one is opened after
// a backoff (half a second, doubling, capped at eight) and says `hello` with the index this client has
// applied. The server answers with exactly what was missed (#1209 mechanism 2), and play resumes.
//
// A SUBMISSION IN FLIGHT WHEN THE SOCKET DROPPED IS SETTLED BY THE CATCH-UP, NOT RE-SENT. It may have landed
// -- the append is the commit point and the answer is only news -- so re-sending blindly would be wrong in
// one direction, and re-sending an older move after a newer one has landed would be wrong in the other (a
// refusal that was lost is not a refusal that will recur). So the hello's catch-up is read against the queue:
// an in-flight submission whose entry is in it resolves with that index; one whose entry is not resolves
// `null` with `onStale`, which the shell already words as "the board is current -- try that again". The
// player makes the move again against the board that exists. No double moves, no ghost moves, and the one
// case that costs a click is the case where a click is the right answer.
//
// A SUBMISSION MADE WHILE THE SOCKET WAS DOWN WAS NEVER SENT, so it is simply sent after the hello, in
// order, as the backlog always was. `sent` on each pending item is what tells the two apart.
//
// THE SHELL IS TOLD (`onStatus`), because a player deserves to know the difference between "the server is
// thinking" and "the wire is down". The status is the link's, not the socket's: `reconnecting` from the
// first close to the next open, `open` thereafter.
//
// ==================================================================
//  LIVE-2D: THE LINK IS KEYED BY `gameId`, AND ACCESS LOST IS TERMINAL
// ==================================================================
//
// `hello {gameId}` -- the server-minted game id, never a room code -- and nothing else: no claim, no seat PIN, no
// seat token. Who this socket is was settled at the upgrade (the session cookie, or a development tab's claim), and
// which seat it plays is the server's to derive from its GameRecord for every move. A server that says this tab may
// not read the game (`not-found`, `gone`, `forbidden`, `room-full` at the hello, or a 4410 close when access is
// removed mid-game) is answered once, through `onAccessLost`, and the link stops: a reconnect would earn the same
// answer, so looping on it is the one wrong response.

import type { ReplayEntry } from "../gameEngine/replayLog";
import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import type { BuildId, ServerFrame } from "./serverProtocol";
import { socketUrlFor } from "./devIdentity";
import { sessionPort as appSessionPort, type SessionPort } from "./sessionBootstrap";

/** The slice of `WebSocket` this file uses. Injected so a test needs no browser and no server. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface ServerLinkOptions {
  url: string;
  /** LIVE-2D: the server-minted game id (`g_…`). */
  gameId: string;
  build: BuildId;
  /** LIVE-2B: the session this link waits for before opening a socket. The app's installed port when absent. */
  session?: SessionPort;
  /** Entries to apply, in log order. The client's own reducer runs them exactly as a replay would -- which
   *  is what keeps the local computation live, and the divergence check with it (#1207).
   *
   *  `serverDigest` IS THE SECOND HALF OF THAT PROMISE (#1223). It is the server's hash of the board AFTER
   *  it applied exactly these entries, so a client that applies them and hashes its own board has a like-for-
   *  like comparison and no extra round trip. It arrived on the wire from the first day and was dropped on the
   *  floor; passing it on is the whole of the wiring. `null` when the frame carried none. */
  onEntries: (
    entries: readonly ReplayEntry[],
    serverDigest: string | null,
    /** #1225: the server's per-field digests, when it was started to explain itself. Naming the field turns
     *  a divergence from an evening of archaeology into one line of reasoning. `null` otherwise. */
    serverFields: Record<string, string> | null,
    /** #1238: WHICH KIND OF FRAME CARRIED THESE. `applied` is live play -- a settle-point burst that just
     *  happened and deserves its toasts and modals. `catch-up` is history -- a join or a reconnect -- and
     *  must arrive in silence. The shell used to infer this from the batch SIZE, which the server path made
     *  wrong on every burst. */
    source: "applied" | "catch-up",
  ) => void;
  /** A refusal the player should see: `turnAuthority`'s sentence, verbatim. */
  onRefused?: (reason: string) => void;
  /** The two halves are not running the same code (#1206). Its own case, because an added field is not a
   *  divergence and a client that learns this should stop reporting desyncs. */
  onBuildSkew?: (clientBuild: BuildId, serverBuild: BuildId) => void;
  /** #1520: the room's deal is pinned to a rules-engine version the server does not carry (or to none). The
   *  server built nothing and will apply nothing; the link closes for good after this, because the answer
   *  cannot change until a different server loads the room. Distinct from `onBuildSkew`: a build is a UI
   *  deploy, a rules version is the meaning of the log. */
  onIncompatible?: (reason: string, pinned: number | null, supported: readonly number[]) => void;
  /** #1218: the move was answered with a resync rather than applied, because this client was behind. Not an
   *  error and not a refusal -- the third way a `submit` resolves `null`, and the only one that used to be
   *  silent. */
  onStale?: () => void;
  onError?: (message: string) => void;
  /** #1253: the link's state, for a banner. `reconnecting` from a socket's close to the next socket's open. */
  onStatus?: (status: "open" | "reconnecting") => void;
  /** LIVE-3A: the server answered `ahead` or `resync` -- this client's history is not the room's. The link has
   *  already resolved everything pending `null`, forgotten its applied index, and is saying hello again from -1;
   *  the shell must drop the entries it accumulated, or the full catch-up that follows is appended to a history
   *  it contradicts. Counted in `resyncs`: on one server with one store, any resync is a durability alarm. */
  onResync?: (reason: string) => void;
  /** LIVE-3A (E-10): the room's availability. `live` re-enables submitting after `unavailable` or `held`. */
  onRoomStatus?: (state: "live" | "unavailable" | "held", reason?: string) => void;
  /** LIVE-2D: this tab may not read the game any more (kicked, the table cancelled or expired, a private game dealt
   *  without it, or a full watcher cap). Terminal: the link has stopped and will not reconnect. */
  onAccessLost?: (code: string, reason: string) => void;
  /** Defaults to the global `WebSocket`. */
  socketFactory?: (url: string) => SocketLike;
  /** Defaults to a counter-based nonce. Injected for deterministic tests. */
  mintSubmissionId?: () => string;
  /** #1253: defaults to `setTimeout`. Injected so a test can drive the backoff by hand. */
  schedule?: (callback: () => void, delayMs: number) => void;
}

export interface ServerLink {
  /** Send a move. Resolves to the index the server allocated, or `null` if it was not applied.
   *
   *  `null` RATHER THAN A THROW, matching `appendSandboxAction`'s contract exactly. The shell already has a
   *  branch for "the append did not happen"; a rejection would need a new one in a file that should be
   *  gaining as little as possible. */
  submit(msg: SandboxLogMsg): Promise<number | null>;
  /** The highest index this client has applied. What a catch-up is measured from. */
  readonly appliedIndex: number;
  /** LIVE-3A: how many times this link has had to rebuild the room's history from the start. */
  readonly resyncs: number;
  close(): void;
}

interface Pending {
  id: string;
  resolve: (index: number | null) => void;
  /** #1253: the message, kept so a submission queued while the socket was down can be sent when it is up --
   *  with the `baseIndex` of THAT moment, not of the click, so the server does not answer it as stale
   *  against entries the hello's catch-up has since delivered. */
  msg: SandboxLogMsg;
  /** #1253: whether this submission has been put on a socket. Unsent ones go after the next hello; sent ones
   *  are settled by the hello's catch-up, never re-sent. */
  sent: boolean;
}

/** #1253: the backoff between reconnection attempts, in milliseconds, by attempt number (0-based). */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** Math.max(0, attempt));
}

export function connectServerLink(options: ServerLinkOptions): ServerLink {
  const make = options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  let nonce = 0;
  /* ==================================================================
      DESIGN NOTE 1219: `c1` WAS EVERY CLIENT'S FIRST MOVE
     ==================================================================
     A bare counter is unique within one link and identical across all of them, so in a room of two the
     second player's opening move carried the same nonce as the host's deal and was answered as a move
     already made. Every button did nothing, and the server said so only once it was asked to.

     THE SERVER NOW KEYS THE REGISTRY BY (ACTOR, NONCE) and that is the fix that matters -- it does not
     depend on clients behaving. THIS HALF IS STILL WORTH HAVING, because the actor is stable across a
     reload while the counter is not: a player who refreshed would mint `c1` again, and their own first move
     after the reload would collide with their own first move before it.

     PER LINK, NOT PER PLAYER, AND THAT IS A DELIBERATE LIMIT. #1209 mechanism 1 exists so a RETRY is
     recognised, and a retry lives in `pending` on this link -- it cannot outlive the connection that holds
     it. A nonce that survived a reconnect would only matter once reconnection exists, and mechanism 2
     (`baseIndex`) is what answers a reconnecting client today: "a client that reconnects BEFORE retrying
     never needs mechanism 1 at all." */
  const linkId = Math.random().toString(36).slice(2, 10);
  const mintId = options.mintSubmissionId ?? (() => `${linkId}-${(nonce += 1)}`);

  const schedule = options.schedule ?? ((callback: () => void, delayMs: number) => { setTimeout(callback, delayMs); });
  const pending: Pending[] = [];
  let socket: SocketLike | null = null;
  let open = false;
  let appliedIndex = -1;
  /* #1253: the link's own lifecycle, apart from any one socket's. */
  let closedByUs = false;
  let everOpened = false;
  let attempts = 0;
  /** True between a `hello` and its catch-up. That catch-up is the reconciliation point for in-flight moves. */
  let awaitingHello = false;
  /** The submissions that were on the wire when the last socket dropped, by nonce. Settled by the next
   *  hello's catch-up and never re-sent. */
  let orphaned = new Set<string>();
  /** LIVE-3A: the id of the entry at `appliedIndex` -- the anchor every hello and submit names (`baseId`). */
  let appliedId: string | undefined;
  /** LIVE-3A: submissions the server is still committing (or could not yet confirm), kept pending until their
   *  entry arrives or `abandoned` names them. */
  let inFlight = new Set<string>();
  /** LIVE-3A: between a resync and the fresh catch-up that answers it, every other frame is dropped. */
  let resyncing = false;
  let resyncs = 0;
  /** LIVE-3A: every entry id already handed to `onEntries` since the last resync. The actor answers a stale
   *  submit AFTER the fan-out of the moves that made it stale, so its catch-up repeats entries this client has
   *  just been given; the shell accumulates without deduplicating (App.tsx #1213), and an entry handed over twice
   *  would be applied twice. By id, not index, so a legacy log whose indices repeat still arrives whole. */
  let delivered = new Set<string>();

  /** The hello, with what this client has applied and the anchor for it. */
  const helloFrame = () => {
    return JSON.stringify({
      kind: "hello",
      gameId: options.gameId,
      build: options.build,
      baseIndex: appliedIndex,
      baseId: appliedIndex >= 0 ? appliedId : undefined,
    });
  };

  /** Put a frame on the wire now if there is one, else leave it for the next hello. */
  const flushUnsent = () => {
    if (!open || !socket) return;
    for (const item of pending) {
      if (!item.sent) {
        item.sent = true;
        socket.send(
          JSON.stringify({
            kind: "submit",
            build: options.build,
            msg: item.msg,
            baseIndex: appliedIndex,
            baseId: appliedIndex >= 0 ? appliedId : undefined,
            submissionId: item.id,
          }),
        );
      }
    }
  };

  /** LIVE-3A: settle exactly the submission a frame names. A frame naming one this link no longer holds (an
   *  orphan the hello already settled, a submission a resync cleared) settles nothing. */
  const settleById = (id: string, index: number | null): boolean => {
    const at = pending.findIndex((item) => item.id === id);
    inFlight.delete(id);
    orphaned.delete(id);
    if (at === -1) return false;
    const [item] = pending.splice(at, 1);
    item.resolve(index);
    return true;
  };

  /** LIVE-3A: entries that arrived as history may be an in-flight submission landing. */
  const settleLanded = (entries: readonly ReplayEntry[]) => {
    if (inFlight.size === 0) return;
    for (const entry of entries) {
      const id = (entry as { submission_id?: string }).submission_id;
      if (id !== undefined && inFlight.has(id)) settleById(id, entry.index);
    }
  };

  /** LIVE-3A: this client's history is not the room's. Settle everything, forget what was applied, and say hello
   *  again from -1 on the same socket. Never a merge: the room's history is the only one there is. */
  const resync = (reason: string) => {
    resyncs += 1;
    // eslint-disable-next-line no-console
    console.warn(`[resync] game ${options.gameId}: ${reason} (resync ${resyncs}; LIVE-3 §5.2 counts every one)`);
    const settled = pending.splice(0);
    orphaned = new Set<string>();
    inFlight = new Set<string>();
    delivered = new Set<string>();
    appliedIndex = -1;
    appliedId = undefined;
    if (settled.length > 0) options.onStale?.();
    options.onResync?.(reason);
    for (const item of settled) item.resolve(null);
    resyncing = true;
    if (open && socket) {
      awaitingHello = true;
      socket.send(helloFrame());
    }
  };

  /** Settle everything still pending as not seen applied -- the link is closing for good. */
  const settleAll = () => {
    for (const item of pending.splice(0)) item.resolve(null);
    orphaned = new Set<string>();
    inFlight = new Set<string>();
  };

  /** LIVE-2D: this tab may not read the game any more. Said once; the link stops and settles what it holds. */
  let accessLost = false;
  const loseAccess = (code: string, reason: string) => {
    if (accessLost) return;
    accessLost = true;
    closedByUs = true;
    awaitingHello = false;
    resyncing = false;
    settleAll();
    options.onAccessLost?.(code, reason);
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
  };

  /** #1253: the hello's catch-up, read against the submissions that were in the air when the socket dropped.
   *  Found in it: landed, resolve with the index. Not found: did not land (or its answer was lost), resolve
   *  `null` and say the board is current. Never re-sent -- see the header. Submissions made since -- queued
   *  during the outage and sent after the hello -- are not orphans and are answered in their own turn. */
  const reconcileOrphans = (entries: readonly ReplayEntry[], running?: readonly string[]) => {
    if (orphaned.size === 0) return;
    const landed = new Map<string, number>();
    for (const entry of entries) {
      const id = (entry as { submission_id?: string }).submission_id;
      if (id !== undefined) landed.set(id, entry.index);
    }
    for (const item of pending.filter((candidate) => orphaned.has(candidate.id))) {
      const index = landed.get(item.id);
      /* LIVE-3A (§4.2): STILL BEING COMMITTED. Not landed yet, and not lost either -- calling it lost would invite
         the player to make it again. It stays pending until its entry arrives or `abandoned` names it. */
      if (index === undefined && running?.includes(item.id)) {
        inFlight.add(item.id);
        continue;
      }
      pending.splice(pending.indexOf(item), 1);
      if (index === undefined) options.onStale?.();
      item.resolve(index ?? null);
    }
    orphaned = new Set<string>();
  };

  const applyEntries = (
    entries: readonly ReplayEntry[],
    serverDigest: string | null,
    serverFields: Record<string, string> | null,
    source: "applied" | "catch-up",
  ): void => {
    /* THE DIGEST IS DELIVERED EVEN WHEN THE FRAME CARRIED NO ENTRIES, which is not a special case but the
       most useful one: a catch-up with nothing in it is the server saying "you are level with me", and that
       is precisely when a silent drift is worth catching. Returning early on an empty batch -- as this did --
       threw away the cheapest verdict available. */
    const fresh: ReplayEntry[] = [];
    for (const entry of entries) {
      if (delivered.has(entry.id)) continue;
      delivered.add(entry.id);
      fresh.push(entry);
      /* `>=`: the anchor is the entry this client holds at `appliedIndex` -- for a legacy log that repeats an
         index, the one it received last, which is the one the server's own lookup answers with. */
      if (entry.index >= appliedIndex) {
        appliedIndex = entry.index;
        appliedId = entry.id;
      }
    }
    options.onEntries(fresh.length === entries.length ? entries : fresh, serverDigest, serverFields, source);
  };

  /* ==================================================================
      LIVE-2B (LIVE-2 §4.3): NO SOCKET BEFORE A SESSION, AND A FRESH ONE AFTER THREE FAILED OPENS
     ==================================================================
     A refused upgrade reaches the browser only as a close before `onopen` (1006). Three of those in a row -- or a
     4401, the server saying the session ended under an open socket -- and the next attempt bootstraps again first
     (a cookie rotated by another tab, or lost with a response, is recovered to the same guest), then the existing
     backoff resumes. A session the server says has ended stops the link: `SessionEndedNotice` asks the player. */
  const session = options.session ?? appSessionPort();
  let failedOpens = 0;
  let rebootstrap = false;

  /** #1253: open a socket and wire it. Called once at construction and once per reconnection. */
  const connect = () => {
    if (closedByUs) return;
    if (session.state === "ready" && !(rebootstrap && session.refreshable)) {
      rebootstrap = false;
      openSocket();
      return;
    }
    const force = rebootstrap;
    rebootstrap = false;
    void session.ensure(force).then((state) => {
      if (closedByUs) return;
      if (state === "ready") {
        openSocket();
        return;
      }
      if (state === "ended") {
        /* Terminal for this page: nothing reconnects under an identity the server has ended. */
        options.onStatus?.("reconnecting");
        return;
      }
      if (attempts === 0) options.onStatus?.("reconnecting");
      const delay = reconnectDelayMs(attempts);
      attempts += 1;
      schedule(() => {
        if (!closedByUs) connect();
      }, delay);
    });
  };

  const openSocket = () => {
    const current = make(socketUrlFor(options.url));
    socket = current;
    let opened = false;

    current.onopen = () => {
      if (socket !== current) return;
      opened = true;
      failedOpens = 0;
      open = true;
      /* #1346: `attempts` is NOT reset here. It used to be, and a socket the server accepted and then closed
         at the hello (a seat refusal, a handler that threw) counted as a fresh outage every time: a 0.5s
         loop, the "reconnecting" banner re-fired on every cycle, one identity line per cycle in the server
         window. The attempt is over when the hello's CATCH-UP arrives, and that is where the counter resets. */
      /* HELLO CARRIES `baseIndex`, so a client that already holds part of the log is answered rather than
         sent the whole thing: `-1` on a fresh join, the last applied index on a reconnect (#1209 mechanism
         2). The catch-up it earns is the reconciliation point for anything that was in flight. */
      awaitingHello = true;
      current.send(helloFrame());
      if (everOpened) options.onStatus?.("open");
      everOpened = true;
      /* WHATEVER WAS QUEUED WHILE THE WIRE WAS DOWN GOES OUT NOW, behind the hello. The server reads frames in
         order, so their answers follow the hello's catch-up; and each carries the `baseIndex` of this moment,
         so a move made against a board that moved while this client was offline is answered as stale -- which
         is what it is. */
      flushUnsent();
    };

    current.onmessage = (event) => {
      if (socket !== current) return;
      onFrame(event);
    };

    current.onerror = () => {
      if (socket === current) options.onError?.("connection error");
    };

    current.onclose = (event) => {
      if (socket !== current) return;
      open = false;
      awaitingHello = false;
      /* LIVE-2D: 4410 -- read access to this game was removed (kicked, cancelled, dropped at a private deal). */
      if ((event as { code?: unknown } | null)?.code === 4410 && !closedByUs) {
        loseAccess("not-found", "You no longer have access to this game.");
        return;
      }
      /* LIVE-2B: a close before `onopen` is a failed open (a refused upgrade looks exactly like this). */
      if (!opened) failedOpens += 1;
      if ((event as { code?: unknown } | null)?.code === 4401 || failedOpens >= 3) {
        failedOpens = 0;
        rebootstrap = true;
      }
      /* LIVE-3A: a resync the drop interrupted is finished by the next hello, which says -1 anyway; submissions the
         server had called in flight are orphans again, and the next hello says whether they still are. */
      resyncing = false;
      inFlight = new Set<string>();
      if (closedByUs) {
        /* THE LINK IS BEING CLOSED ON PURPOSE (the room was left). Every outstanding submission resolves
           `null` rather than hanging: `null` means "this client did not see it applied", which is the honest
           thing the shell can act on, and is not the same claim as "it did not happen" (#1209). */
        settleAll();
        return;
      }
      /* THE WIRE DROPPED. Nothing is settled here -- the next hello's catch-up says what landed (see the
         header) -- and a new socket is tried after a backoff. The shell is told once per outage. */
      for (const item of pending) if (item.sent) orphaned.add(item.id);
      if (attempts === 0) options.onStatus?.("reconnecting");
      const delay = reconnectDelayMs(attempts);
      attempts += 1;
      schedule(() => {
        if (!closedByUs && socket === current) connect();
      }, delay);
    };
  };

  const onFrame = (event: { data: unknown }) => {
    let message: ServerFrame;
    try {
      message = JSON.parse(String(event.data)) as typeof message;
    } catch {
      options.onError?.("unparseable frame from server");
      return;
    }
    const inReplyTo = (message as { inReplyTo?: unknown }).inReplyTo;
    const answers = typeof inReplyTo === "string" ? inReplyTo : undefined;

    /* LIVE-3A: BETWEEN A RESYNC AND ITS FRESH CATCH-UP, NOTHING ELSE IS APPLIED. Every entry in a frame that
       arrives in between is in that catch-up too -- the server computes it from everything committed before it
       read the hello -- and applying both would hand the shell each of them twice. */
    if (
      resyncing &&
      !(message.kind === "catch-up" && answers === undefined) &&
      message.kind !== "incompatible" &&
      message.kind !== "status" &&
      message.kind !== "error"
    ) {
      return;
    }

    switch (message.kind) {
      case "applied": {
        applyEntries(message.entries, message.digest ?? null, message.fields ?? null, "applied");
        /* LIVE-3A: the submitter's own answer names it; a watcher's copy of somebody's move names nothing and
           settles nothing -- except a submission this client was told is still in flight, landing now. */
        if (answers !== undefined) {
          const mine = message.entries.find((entry) => (entry as { submission_id?: string }).submission_id === answers);
          settleById(answers, mine?.index ?? message.entries[0]?.index ?? null);
        } else {
          settleLanded(message.entries);
        }
        return;
      }
      case "catch-up": {
        /* #1253: THE HELLO'S CATCH-UP IS NOT AN ANSWER TO ANY SUBMISSION. It reconciles whatever was in
           flight when the previous socket dropped, and then the submissions queued while the wire was down
           go out -- after it, so their `baseIndex` and the server's idea of this client agree. */
        if (awaitingHello && answers === undefined) {
          resyncing = false;
          applyEntries(message.entries, message.digest ?? null, message.fields ?? null, "catch-up");
          awaitingHello = false;
          attempts = 0; // #1346: the socket is up and answered; only now is the outage over.
          reconcileOrphans(message.entries, message.inFlight);
          settleLanded(message.entries);
          return;
        }
        applyEntries(message.entries, message.digest ?? null, message.fields ?? null, "catch-up");
        if (answers !== undefined) {
          /* #1218: A CATCH-UP THAT DOES NOT CONTAIN THIS CLIENT'S OWN ENTRY answered the move by resyncing
             instead of applying it -- the client was behind. Not an error; the move is worth making again. */
          const mine = message.entries.find((entry) => (entry as { submission_id?: string }).submission_id === answers);
          if (mine === undefined && pending.some((item) => item.id === answers)) options.onStale?.();
          settleById(answers, mine?.index ?? null);
        } else {
          settleLanded(message.entries);
        }
        return;
      }
      case "refused": {
        /* #1685 (Stage 10.2): a refusal that followed a repair carries the repair. Applied first, as history
           (the entries are the game's, appended before this move was judged), then the sentence. */
        if (message.catchUp !== undefined) {
          applyEntries(message.catchUp.entries, message.catchUp.digest ?? null, message.catchUp.fields ?? null, "catch-up");
        }
        /* LIVE-3A: `ahead` / `resync` -- this client holds history the room does not. Not a refusal to show: the
           room is rebuilt from the start. */
        if (message.code === "ahead" || message.code === "resync") {
          resync(message.reason);
          return;
        }
        if (answers === undefined) {
          options.onRefused?.(message.reason);
          return;
        }
        if (message.code === "unavailable") {
          /* §17 class 4: the server could not confirm the move was recorded. It is kept pending -- it appears
             when the game resumes if it landed, and `abandoned` says so if it did not. Never re-sent. */
          if (pending.some((item) => item.id === answers)) {
            inFlight.add(answers);
            options.onRefused?.(message.reason);
          }
          return;
        }
        if (pending.some((item) => item.id === answers)) options.onRefused?.(message.reason);
        settleById(answers, null);
        return;
      }
      case "build-skew": {
        options.onBuildSkew?.(message.clientBuild, message.serverBuild);
        if (answers !== undefined) settleById(answers, null);
        return;
      }
      case "incompatible": {
        /* #1520: TERMINAL -- the room is held by the server until a compatible engine loads it, and the same
           hello earns the same answer, so a reconnect loop would only repeat it. The reason names the pinned and
           supported versions; nothing else is applied and nothing is retried. */
        closedByUs = true;
        awaitingHello = false;
        resyncing = false;
        if (options.onIncompatible) {
          options.onIncompatible(message.reason, message.pinnedRulesEngineVersion, message.supportedRulesEngineVersions);
        } else {
          options.onError?.(message.reason);
        }
        settleAll();
        socket?.close();
        return;
      }
      case "abandoned": {
        /* LIVE-3A (§4.2): a submission that was still being committed when its socket went away ended without
           committing. It did not land, so it is the one answer after which trying again is right. */
        if (settleById(message.inReplyTo, null)) options.onStale?.();
        return;
      }
      case "status": {
        options.onRoomStatus?.(message.state, message.reason);
        return;
      }
      default: {
        const code = (message as { code?: string }).code;
        const reason = (message as { reason?: string }).reason ?? "The game server refused that.";
        /* LIVE-3A: the hello's history is not the room's -- the same resync as a submit's `ahead`. */
        if (code === "resync") {
          resync(reason);
          return;
        }
        /* LIVE-2D: THE HELLO WAS REFUSED FOR ACCESS -- no such game for this principal, a game that is over and gone,
           or a watcher cap that is full. Terminal: the same hello earns the same answer. */
        if (code === "not-found" || code === "gone" || code === "kicked" || code === "forbidden" || code === "room-full") {
          loseAccess(code, reason);
          return;
        }
        options.onError?.(reason);
        if (answers !== undefined) settleById(answers, null);
      }
    }
  };

  connect();

  return {
    submit(msg) {
      return new Promise<number | null>((resolve) => {
        const id = mintId();
        pending.push({ id, resolve, msg, sent: false });
        // Sent now if there is a socket to send on; otherwise it waits for the next hello.
        flushUnsent();
      });
    },
    get appliedIndex() {
      return appliedIndex;
    },
    get resyncs() {
      return resyncs;
    },
    close() {
      closedByUs = true;
      socket?.close();
    },
  };
}
