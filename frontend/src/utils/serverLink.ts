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

import type { ReplayEntry } from "./replayLog";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { BuildId, ServerMessage } from "./serverProtocol";
import { SEAT_REFUSED_CODE, SEAT_SUPERSEDED_CODE, forgetSeat } from "./seatPin";

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
  room: string;
  build: BuildId;
  /** What this client says it is. The server decides whether to believe it (#1210). */
  claim: string;
  /** Design note #1341: the seat PIN this tab holds for the room, demanded by the server when the claimed seat
   *  has one. Absent for a seat without a PIN. */
  pin?: string;
  /** Design note #1341: the seat's session token, so a device another one has superseded is turned away. */
  token?: string;
  /* ==================================================================
      DESIGN NOTE 1364: THE SECRETS ARE READ AT EVERY HELLO, NOT AT CONNECT
     ==================================================================
     REPORTED: a host set their PIN in the waiting room, a red line appeared -- the server's "This seat has a
     PIN. Rejoin it ..." -- and Start Game did nothing. THE LINK WAS ALREADY UP WHEN THE PIN WAS SET, with a
     hello that carried no PIN because there was none. `pin` and `token` were captured ONCE, here, so the next
     reconnect -- and through a tunnel the next reconnect is never far off -- re-sent the stale hello, the seat
     now had a PIN, the server refused, and #1346 rightly made the refusal terminal. Every submission after
     that sat in the queue waiting for a socket that would never open.
     SO THE HELLO ASKS FOR THE SECRETS EACH TIME IT IS SENT. `seat` is a reader over the store the modal
     writes to (`seatPin.ts`), so a PIN set, changed or adopted after the link opened is what the next hello
     carries. The static `pin`/`token` stay as the fallback for callers without a store (tests, the CLI). */
  seat?: () => { pin?: string; token?: string };
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
  /** #1218: the move was answered with a resync rather than applied, because this client was behind. Not an
   *  error and not a refusal -- the third way a `submit` resolves `null`, and the only one that used to be
   *  silent. */
  onStale?: () => void;
  onError?: (message: string) => void;
  /** #1253: the link's state, for a banner. `reconnecting` from a socket's close to the next socket's open. */
  onStatus?: (status: "open" | "reconnecting") => void;
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
  submit(msg: GameplayExecuteMsg): Promise<number | null>;
  /** The highest index this client has applied. What a catch-up is measured from. */
  readonly appliedIndex: number;
  close(): void;
}

interface Pending {
  id: string;
  resolve: (index: number | null) => void;
  /** #1253: the message, kept so a submission queued while the socket was down can be sent when it is up --
   *  with the `baseIndex` of THAT moment, not of the click, so the server does not answer it as stale
   *  against entries the hello's catch-up has since delivered. */
  msg: GameplayExecuteMsg;
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
            submissionId: item.id,
          }),
        );
      }
    }
  };

  /** Resolve the oldest unanswered submission. See the header: FIFO is the mechanism. */
  const settleHead = (index: number | null, seen?: string) => {
    const head = pending.shift();
    if (!head) return;
    if (seen !== undefined && seen !== head.id) {
      /* THE ORDERING ASSUMPTION HAS BROKEN. Resolving anyway would hand this reply's index to a different
         dispatch, which is a bug that would surface as a board disagreeing with its own log. */
      options.onError?.(
        `submission ${seen} answered while ${head.id} was outstanding — replies are out of order`,
      );
    }
    head.resolve(index);
  };

  /** #1253: the hello's catch-up, read against the submissions that were in the air when the socket dropped.
   *  Found in it: landed, resolve with the index. Not found: did not land (or its answer was lost), resolve
   *  `null` and say the board is current. Never re-sent -- see the header. Submissions made since -- queued
   *  during the outage and sent after the hello -- are not orphans and are answered in their own turn. */
  const reconcileOrphans = (entries: readonly ReplayEntry[]) => {
    if (orphaned.size === 0) return;
    const landed = new Map<string, number>();
    for (const entry of entries) {
      const id = (entry as { submission_id?: string }).submission_id;
      if (id !== undefined) landed.set(id, entry.index);
    }
    for (const item of pending.filter((candidate) => orphaned.has(candidate.id))) {
      pending.splice(pending.indexOf(item), 1);
      const index = landed.get(item.id);
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
    for (const entry of entries) {
      if (entry.index > appliedIndex) appliedIndex = entry.index;
    }
    options.onEntries(entries, serverDigest, serverFields, source);
  };

  /** #1253: open a socket and wire it. Called once at construction and once per reconnection. */
  const connect = () => {
    const current = make(options.url);
    socket = current;

    current.onopen = () => {
      if (socket !== current) return;
      open = true;
      /* #1346: `attempts` is NOT reset here. It used to be, and a socket the server accepted and then closed
         at the hello (a seat refusal, a handler that threw) counted as a fresh outage every time: a 0.5s
         loop, the "reconnecting" banner re-fired on every cycle, one identity line per cycle in the server
         window. The attempt is over when the hello's CATCH-UP arrives, and that is where the counter resets. */
      /* HELLO CARRIES `baseIndex`, so a client that already holds part of the log is answered rather than
         sent the whole thing: `-1` on a fresh join, the last applied index on a reconnect (#1209 mechanism
         2). The catch-up it earns is the reconciliation point for anything that was in flight. */
      awaitingHello = true;
      // #1364: read now, not at connect -- a PIN set since the last hello is the one this hello must carry.
      const seat = options.seat?.() ?? {};
      current.send(
        JSON.stringify({
          kind: "hello",
          room: options.room,
          build: options.build,
          claim: options.claim,
          pin: seat.pin ?? options.pin,
          token: seat.token ?? options.token,
          baseIndex: appliedIndex,
        }),
      );
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

    current.onclose = () => {
      if (socket !== current) return;
      open = false;
      awaitingHello = false;
      if (closedByUs) {
        /* THE LINK IS BEING CLOSED ON PURPOSE (the room was left). Every outstanding submission resolves
           `null` rather than hanging: `null` means "this client did not see it applied", which is the honest
           thing the shell can act on, and is not the same claim as "it did not happen" (#1209). */
        while (pending.length > 0) settleHead(null);
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
    let message: ServerMessage | { kind: "error"; reason: string };
    try {
      message = JSON.parse(String(event.data)) as typeof message;
    } catch {
      options.onError?.("unparseable frame from server");
      return;
    }

    switch (message.kind) {
      case "applied": {
        applyEntries(message.entries, message.digest ?? null, message.fields ?? null, "applied");
        /* THE OWN-SUBMISSION CASE AND THE WATCHER CASE ARRIVE AS THE SAME FRAME, deliberately (#1210: the
           fan-out carries what was appended, because it is the same news). The queue is what tells them
           apart: a client with nothing outstanding is watching somebody else's move. */
        // #1253: only a SENT submission can have been answered; an unsent one at the head is a watcher's queue.
        if (pending.length > 0 && pending[0].sent) {
          const mine = message.entries.find(
            (entry) => (entry as { submission_id?: string }).submission_id !== undefined,
          ) as { index: number; submission_id?: string } | undefined;
          settleHead(mine?.index ?? message.entries[0]?.index ?? null, mine?.submission_id);
        }
        return;
      }
      case "catch-up": {
        applyEntries(message.entries, message.digest ?? null, message.fields ?? null, "catch-up");
        /* #1253: THE HELLO'S CATCH-UP IS NOT AN ANSWER TO ANY SUBMISSION. It reconciles whatever was in
           flight when the previous socket dropped, and then the submissions queued while the wire was down
           go out -- after it, so their `baseIndex` and the server's idea of this client agree. */
        if (awaitingHello) {
          awaitingHello = false;
          attempts = 0; // #1346: the socket is up and answered; only now is the outage over.
          reconcileOrphans(message.entries);
          return;
        }
        /* A CATCH-UP CAN ALSO BE AN ANSWER. #1209 returns one to a client whose retry was already applied,
           and to one that was behind -- so an outstanding submission is settled by it rather than left to
           hang. The index is this client's own entry where the nonce identifies it. */
        if (pending.length > 0 && pending[0].sent) {
          const head = pending[0];
          const mine = message.entries.find(
            (entry) => (entry as { submission_id?: string }).submission_id === head.id,
          );
          /* ==================================================================
              DESIGN NOTE 1218: THE ONE ANSWER THAT EXPLAINED NOTHING
             ==================================================================
             A catch-up that does NOT contain this client's own entry means the server answered the move by
             resyncing instead of applying it -- the client was behind (#1209 step 3). Every other `null` here
             arrives with a callback that says why; this one resolved silently, so the shell had nothing to
             report but "could not reach the room", which is both wrong and undiagnosable.
             IT IS NOT AN ERROR, WHICH IS WHY IT HAS ITS OWN CALLBACK. Nothing is broken and nothing was lost:
             the board just moved while the player was deciding, and the move is worth making again against
             the board that now exists. */
          if (mine === undefined) options.onStale?.();
          settleHead(mine?.index ?? null, head.id);
        }
        return;
      }
      case "refused": {
        options.onRefused?.(message.reason);
        // No entry, so no nonce: FIFO is the only thing that can match this, which is why it is the mechanism.
        settleHead(null);
        return;
      }
      case "build-skew": {
        options.onBuildSkew?.(message.clientBuild, message.serverBuild);
        settleHead(null);
        return;
      }
      default: {
        /* #1341: superseded -- another device took this seat. Forget it, reload as a visitor; no reconnect. */
        if ((message as { code?: string }).code === SEAT_SUPERSEDED_CODE) {
          closedByUs = true;
          forgetSeat(options.room);
          return;
        }
        /* #1346: a seat refusal is TERMINAL -- the same hello cannot earn a different answer, so retrying it
           on a backoff is a loop. Say why, once, and stop. */
        if ((message as { code?: string }).code === SEAT_REFUSED_CODE) {
          closedByUs = true;
          options.onError?.((message as { reason?: string }).reason ?? "This seat refused the connection.");
          return;
        }
        options.onError?.((message as { reason?: string }).reason ?? "unknown frame from server");
        settleHead(null);
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
    close() {
      closedByUs = true;
      socket?.close();
    },
  };
}
