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
// NO RECONNECTION, NO BACKOFF, DELIBERATELY. The owner asked for the happy path first and was right to: the
// resilience worth writing is the resilience whose failure modes have been seen, and none of them have been
// yet. What IS here is `baseIndex`, because the server needs it to answer a catch-up -- and a client that
// reconnects one day will find the protocol already knows how to say "here is what you missed".

import type { ReplayEntry } from "./replayLog";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { BuildId, ServerMessage } from "./serverProtocol";

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
  /** Entries to apply, in log order. The client's own reducer runs them exactly as a replay would -- which
   *  is what keeps the local computation live, and the divergence check with it (#1207). */
  onEntries: (entries: readonly ReplayEntry[]) => void;
  /** A refusal the player should see: `turnAuthority`'s sentence, verbatim. */
  onRefused?: (reason: string) => void;
  /** The two halves are not running the same code (#1206). Its own case, because an added field is not a
   *  divergence and a client that learns this should stop reporting desyncs. */
  onBuildSkew?: (clientBuild: BuildId, serverBuild: BuildId) => void;
  onError?: (message: string) => void;
  /** Defaults to the global `WebSocket`. */
  socketFactory?: (url: string) => SocketLike;
  /** Defaults to a counter-based nonce. Injected for deterministic tests. */
  mintSubmissionId?: () => string;
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
}

export function connectServerLink(options: ServerLinkOptions): ServerLink {
  const make = options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  let nonce = 0;
  const mintId = options.mintSubmissionId ?? (() => `c${(nonce += 1)}`);

  const socket = make(options.url);
  const pending: Pending[] = [];
  /** Queued until the socket opens. A dispatch made during connection is a real case -- the shell does not
   *  wait for a socket before letting somebody click. */
  const backlog: string[] = [];
  let open = false;
  let appliedIndex = -1;

  const raw = (frame: unknown) => {
    const text = JSON.stringify(frame);
    if (open) socket.send(text);
    else backlog.push(text);
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

  const applyEntries = (entries: readonly ReplayEntry[]): void => {
    if (entries.length === 0) return;
    for (const entry of entries) {
      if (entry.index > appliedIndex) appliedIndex = entry.index;
    }
    options.onEntries(entries);
  };

  socket.onopen = () => {
    open = true;
    /* HELLO CARRIES `baseIndex`, so a client that already holds part of the log is answered rather than sent
       the whole thing. Today that is always `-1`; it costs nothing and it is what a reconnect will need. */
    socket.send(
      JSON.stringify({
        kind: "hello",
        room: options.room,
        build: options.build,
        claim: options.claim,
        baseIndex: appliedIndex,
      }),
    );
    for (const queued of backlog.splice(0)) socket.send(queued);
  };

  socket.onmessage = (event) => {
    let message: ServerMessage | { kind: "error"; reason: string };
    try {
      message = JSON.parse(String(event.data)) as typeof message;
    } catch {
      options.onError?.("unparseable frame from server");
      return;
    }

    switch (message.kind) {
      case "applied": {
        applyEntries(message.entries);
        /* THE OWN-SUBMISSION CASE AND THE WATCHER CASE ARRIVE AS THE SAME FRAME, deliberately (#1210: the
           fan-out carries what was appended, because it is the same news). The queue is what tells them
           apart: a client with nothing outstanding is watching somebody else's move. */
        if (pending.length > 0) {
          const mine = message.entries.find(
            (entry) => (entry as { submission_id?: string }).submission_id !== undefined,
          ) as { index: number; submission_id?: string } | undefined;
          settleHead(mine?.index ?? message.entries[0]?.index ?? null, mine?.submission_id);
        }
        return;
      }
      case "catch-up": {
        applyEntries(message.entries);
        /* A CATCH-UP CAN ALSO BE AN ANSWER. #1209 returns one to a client whose retry was already applied,
           and to one that was behind -- so an outstanding submission is settled by it rather than left to
           hang. The index is this client's own entry where the nonce identifies it. */
        if (pending.length > 0) {
          const head = pending[0];
          const mine = message.entries.find(
            (entry) => (entry as { submission_id?: string }).submission_id === head.id,
          );
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
        options.onError?.((message as { reason?: string }).reason ?? "unknown frame from server");
        settleHead(null);
      }
    }
  };

  socket.onerror = () => options.onError?.("connection error");
  socket.onclose = () => {
    open = false;
    /* EVERY OUTSTANDING SUBMISSION RESOLVES `null` RATHER THAN HANGING. #1209 is explicit that the append is
       the commit point and the response is only news -- so a move whose answer was lost may well have
       happened. `null` means "this client did not see it applied", which is the honest thing the shell can
       act on, and is not the same claim as "it did not happen". */
    while (pending.length > 0) settleHead(null);
  };

  return {
    submit(msg) {
      return new Promise<number | null>((resolve) => {
        const id = mintId();
        pending.push({ id, resolve });
        raw({
          kind: "submit",
          build: options.build,
          msg,
          baseIndex: appliedIndex,
          submissionId: id,
        });
      });
    },
    get appliedIndex() {
      return appliedIndex;
    },
    close() {
      socket.close();
    },
  };
}
