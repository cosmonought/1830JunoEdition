// frontend/src/utils/roomSession.ts
//
// One room, server-side: authenticate elsewhere, gate here, apply, append, answer.
//
// ==================================================================
//  DESIGN NOTE 1209: THE LOOP, AND WHAT A DROPPED SOCKET DOES TO IT
// ==================================================================
//
// THE ORDER IS THE DESIGN. Build skew, then replay-safety, then staleness, then authority, then apply. Each
// step answers a question the next one would otherwise answer wrongly, and every one of them is cheaper than
// the step after it.
//
// IT DOES NOT AUTHENTICATE, DELIBERATELY. A session is CONSTRUCTED with an identity the transport has already
// established, and never told one by a request (#1207: the actor is not on the wire). Keeping the check out
// of this class is what makes it testable without a socket -- and what stops a future refactor from adding a
// convenient `actorId` parameter to `submit`.
//
// ---------------------------------------------------------------------------
//  THE SOCKET THAT DIES MID-BURST
// ---------------------------------------------------------------------------
//
// A client sends a move. The engine applies it, generates the derived actions the game owes, appends the lot
// -- and the connection drops before the answer lands. The player sees nothing. What now?
//
// THE FIRST ANSWER IS THAT THE BURST IS ALREADY REAL. The append is the commit point, not the response; the
// response is news. Anything else means a game whose history depends on whether a packet arrived, which is
// the same class of fault as a board that depends on which browser you are sitting at.
//
// SO THE ONLY QUESTION IS WHETHER A RETRY CAN HURT, and untreated it can: the client reconnects, resends, and
// the move happens twice. Three mechanisms, in the order they catch it.
//
//   1. THE SUBMISSION ID. The client stamps each move with a nonce and reuses it on retry. The server records
//      it ON THE LOG ENTRY, so "have I already applied this?" is a question about the history rather than
//      about a table that a restart would empty. Same reasoning as `turnGuardKey` (#1145) and the same
//      payoff: it survives a crash without anything being persisted alongside it.
//
//   2. `baseIndex`. A reconnecting client says what it last applied; anything newer comes back as a catch-up
//      rather than as a refusal. This is the ordinary path -- a client that reconnects BEFORE retrying never
//      needs mechanism 1 at all.
//
//   3. THE TURN GATE. A duplicate that somehow reached the engine would usually be refused anyway, because
//      the first copy moved the cursor off this player. That is a backstop and not a design: it is silent
//      about WHY, and it fails exactly where a duplicate is most plausible -- an action that does not end a
//      turn.
//
// AND THE HARDER CRASH IS MID-BURST, NOT MID-RESPONSE. If the server dies between appending the player's
// action and appending the auto-skip it owes, the log holds a move whose consequences never landed.
//
//   THAT REPAIRS ITSELF, AND #1208 IS WHY. Derived actions are not remembered, they are RE-DERIVED: on
//   restart the engine replays the log, `nextDerivedAction` looks at the resulting board and says the game
//   still owes an auto-skip. The `emitted` guard is rebuilt from the log's own `derived` entries, so an
//   action already appended is not owed twice and one that never landed still is.
//
//   WHICH MEANS THE INTERRUPTED BURST FINISHES ON THE NEXT SUBMISSION rather than needing a repair path.
//   `settleOwed` below is that step, and it runs before anything else touches the board -- because a board
//   mid-burst is a board no rule was written against.

import { RoomEngine, type ReplayEntry, type ReplayProviders, type ReplaySeed } from "./replayLog";
import { stateDigest } from "./stateDigest";
import { turnRefusal } from "./turnAuthority";
import {
  buildsAgree,
  mintLogEntry,
  type BuildId,
  type ServerMessage,
} from "./serverProtocol";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { GameStateResponse } from "./gameState";

/** An entry as this server stores it: the shared shape plus the nonce that makes a retry safe. */
export interface ServerLogEntry extends ReplayEntry {
  /** #1209 mechanism 1. Absent on derived entries and on anything written before this note. */
  submission_id?: string;
}

export interface RoomSessionOptions {
  providers: ReplayProviders;
  seed: ReplaySeed;
  build: BuildId;
  /** Ids for new entries. Injected so a test is deterministic and the server can use whatever its store
   *  prefers -- the engine has no opinion, and #1026's Firestore-minted id was only ever one answer. */
  mintId: () => string;
  /** Wall clock, injected for the same reason. `#643`: an entry keeps its own stamp. */
  now?: () => number;
}

export interface SubmitInput {
  /** Established by the transport BEFORE this class is reached. Never taken from the request. */
  actor: string;
  build: BuildId;
  msg: GameplayExecuteMsg;
  baseIndex: number;
  submissionId?: string;
}

export class RoomSession {
  private readonly engine: RoomEngine;
  private readonly options: RoomSessionOptions;
  private readonly log: ServerLogEntry[] = [];
  /** #1209 mechanism 1, in memory. Rebuilt from the log by `restore`, so a restart loses nothing. */
  private readonly submissions = new Map<string, number>();

  constructor(options: RoomSessionOptions) {
    this.options = options;
    this.engine = new RoomEngine(options.providers, options.seed);
  }

  /** Rebuild from a stored log. The constructor plus this is a server restart.
   *
   *  APPLIED THROUGH `apply`, NEVER `submit` (#1203): the history already contains its derived entries, and
   *  generating them again would double every automatic action in the game. */
  restore(entries: readonly ServerLogEntry[]): void {
    for (const entry of entries) {
      this.log.push(entry);
      if (entry.submission_id) this.submissions.set(entry.submission_id, entry.index);
      this.engine.apply(entry);
    }
  }

  get state(): GameStateResponse {
    return this.engine.snapshot.state;
  }

  get nextIndex(): number {
    return this.log.length === 0 ? 0 : this.log[this.log.length - 1].index + 1;
  }

  get entries(): readonly ServerLogEntry[] {
    return this.log;
  }

  /** Everything after `fromIndex`, for a client that fell behind or reconnected. */
  catchUp(fromIndex: number): ServerMessage {
    return {
      kind: "catch-up",
      entries: this.log.filter((entry) => entry.index > fromIndex),
      digest: stateDigest(this.state),
      build: this.options.build,
    };
  }

  submit(input: SubmitInput): ServerMessage {
    /* ---- 1. BUILD SKEW, FIRST ----
       #1206: the digest covers the whole state, so a client on an older build disagrees about fields that
       are not divergences. Answered before anything else because every later answer -- including a refusal --
       would be measured against a board the two halves describe differently. */
    if (!buildsAgree(input.build, this.options.build)) {
      return {
        kind: "build-skew",
        clientBuild: input.build,
        serverBuild: this.options.build,
      };
    }

    /* ---- 2. A RETRY IS NOT A SECOND MOVE (#1209 mechanism 1) ----
       Answered before staleness, because a client retrying after a dropped socket is BOTH stale and
       duplicated, and telling it "you are behind" without telling it its move landed would invite a third
       attempt. The catch-up it gets here contains its own action, so it learns both at once. */
    if (input.submissionId !== undefined && this.submissions.has(input.submissionId)) {
      return this.catchUp(input.baseIndex);
    }

    /* ---- 3. STALENESS ----
       A client that has missed entries must not have this burst applied on top of a board that never saw the
       last one -- it would derive a board nobody has, which is a divergence manufactured by the transport
       rather than found by it (#1207). */
    if (input.baseIndex < this.nextIndex - 1) {
      return this.catchUp(input.baseIndex);
    }

    /* ---- 4. FINISH ANY BURST A CRASH INTERRUPTED ----
       Before the gate, because the gate asks whose turn it is and a board mid-burst has not finished
       answering. See the header: a server that died between a move and the auto-skip it owed comes back with
       both facts in the log and neither contradiction resolved. */
    const repaired = this.settleOwed();

    /* ---- 5. AUTHORITY (#1205) ----
       Asked against the board as repaired, and with the auction atom, which is the thing `applyOneAction`
       never had and the reason #1174 could not do this. */
    const refusal = turnRefusal({
      state: this.state,
      waterfall: this.engine.snapshot.waterfall,
      actor: input.actor,
      msg: input.msg,
    });
    if (refusal !== null) {
      /* A REFUSAL STILL REPORTS THE REPAIR. The board moved before the refusal, so a client told only "not
         your turn" would be left behind by entries it never saw. */
      if (repaired.length > 0) return this.catchUp(input.baseIndex);
      return { kind: "refused", reason: refusal, build: this.options.build };
    }

    /* ---- 6. APPLY AND APPEND ----
       The append is the commit point; the response is news (see the header). */
    const entry: ServerLogEntry = {
      ...mintLogEntry({
        index: this.nextIndex,
        id: this.options.mintId(),
        actor: input.actor,
        msg: input.msg,
        at: this.options.now?.(),
      }),
      ...(input.submissionId === undefined ? {} : { submission_id: input.submissionId }),
    };

    /* PUSHED BEFORE THE ENGINE RUNS, so `nextIndex` is correct for every derived entry the burst mints. The
       log is storage; the engine holds the board. Appending first is also what makes the append the commit
       point rather than the response (see the header). */
    this.log.push(entry);
    if (input.submissionId !== undefined) this.submissions.set(input.submissionId, entry.index);

    const settled = this.engine.submit(entry, (msg) => this.appendDerived(msg, input.actor));

    return {
      kind: "applied",
      entries: [...repaired, entry, ...settled.derived],
      digest: stateDigest(this.state),
      build: this.options.build,
    };
  }

  /** Mint a derived entry, append it, and hand it back for the engine to apply.
   *
   *  APPENDING INSIDE THE MINT is what keeps the numbering right: each call reads `nextIndex` off a log that
   *  already holds every entry minted before it, so a burst of four is numbered n+1..n+4 without anybody
   *  counting. */
  private appendDerived(msg: GameplayExecuteMsg, actor: string): ServerLogEntry {
    const entry = mintLogEntry({
      index: this.nextIndex,
      id: this.options.mintId(),
      /* THE GAME'S OWN ACTIONS CARRY THE ACTOR THEY WERE PROVOKED BY, matching what the shell logs today --
         `runGameplayAction(..., { automatic: true })` runs on the acting client and is attributed to it.
         #549 wants an author on every entry, and "the game" is not one the roster can resolve. */
      actor,
      msg,
      derived: true,
      at: this.options.now?.(),
    });
    this.log.push(entry);
    return entry;
  }

  /** Finish a burst a crash left half-applied, and return what that took.
   *
   *  RE-DERIVED RATHER THAN REMEMBERED (#1208). The engine replayed the log on restore, so it knows what the
   *  game still owes and -- because `apply` now records each derived entry's turn key -- what it does not. */
  private settleOwed(): ServerLogEntry[] {
    /* THE ACTOR IS THE ONE WHOSE MOVE WAS INTERRUPTED -- read off the last entry, because that is whose burst
       this finishes. A repair with no author would be the one entry in the log #549 cannot attribute. */
    const provoker = this.log.length === 0 ? "" : this.log[this.log.length - 1].actor;
    return this.engine.settleOwed((msg) => this.appendDerived(msg, provoker));
  }
}
