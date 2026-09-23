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

import { RoomEngine, type ReplayEntry, type ReplayProviders, type ReplaySeed } from "../gameEngine/replayLog";
import { fieldDigests, stateDigest } from "../gameEngine/stateDigest";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { tileEraFor } from "../gameEngine/gameConstants"; // #1683: the era the lay is judged in
import { effectiveActions } from "../gameEngine/logRevert";
import {
  SERVER_REPLAY_POLICY,
  SUPPORTED_RULES_ENGINE_VERSIONS,
  replayCompatibility,
  replayRefusal,
  rulesEngineVersionOf,
  type ReplayCompatibility,
  type ReplayPolicy,
} from "../gameEngine/rulesVersion";
import {
  buildsAgree,
  mintLogEntry,
  type BuildId,
  type ServerMessage,
} from "./serverProtocol";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { GameStateResponse } from "../gameEngine/gameState";
/* #1662 (S9-1): the ingress seam #1520 opened, generalised -- the version pin, the turn's draw, and the
   playtest waiver a hosted room does not admit. `isSetupGameMsg` / `stampRulesEngineVersion` moved inside it. */
import { normalizeForCommit } from "./serverIngress";
/* #1685 (Stage 10.2, S10-1): the one definition of "the authority declined this" (`actionOutcome.ts`), and the
   reducer's own sentence for it where one owns up (#784) -- the same function the shell's receipt asks. */
import { unchangedMeansRefused } from "../gameEngine/actionOutcome";
import { refusalReasonFor } from "./refusedAction";

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
  /** #1662 (S9-1): the server's revenue draw, injected for `mintId`'s reason -- a test needs the seed to be
   *  known, and the normalizer must not be the thing that decides to be deterministic. `randomTurnSeed` when
   *  absent, which is what a deployment gets. */
  mintSeed?: () => number;
  /** #1225: put per-field digests on every answer, so a client that detects a divergence can NAME the field
   *  instead of reporting two opaque hashes. Off by default: it is a diagnostic for local play, and a
   *  deployment should not pay for it on every frame. */
  explainDivergence?: boolean;
  /** #1520: what to do with a stored deal that carries no `rules_engine_version`. `SERVER_REPLAY_POLICY`
   *  (refuse) when absent, which is the only answer a deployment should give. `DEVELOPMENT_CORPUS_POLICY`
   *  is a local-play opt-in for the pre-pin playtest rooms, and the server says so on every room it admits.
   *  A deal pinned to a version this engine does not carry is refused under EITHER policy. */
  replayPolicy?: ReplayPolicy;
}

export interface SubmitInput {
  /** Established by the transport BEFORE this class is reached. Never taken from the request. */
  actor: string;
  build: BuildId;
  msg: GameplayExecuteMsg;
  baseIndex: number;
  submissionId?: string;
  /** #1249: the room's host from the room document, for the messages whose owner is the host. `null` when
   *  the room has no document (a test); the authority skips the host-only checks then. */
  host?: string | null;
}

export class RoomSession {
  /** Reassigned on a live `RevertTo` (#1233): a rewind is a rebuild, not a step. */
  private engine: RoomEngine;
  private readonly options: RoomSessionOptions;
  private readonly log: ServerLogEntry[] = [];
  /** #1209 mechanism 1, in memory. Rebuilt from the log by `restore`, so a restart loses nothing. */
  private readonly submissions = new Map<string, number>();

  /* ==================================================================
      DESIGN NOTE 1219: ONE PLAYER'S NONCE MUST NOT ANSWER FOR ANOTHER'S
     ==================================================================
     REPORTED: every button on the Auction tab did nothing, and the server said
     `catch-up: p-6l5brnvm sent WaterfallBuyLowest — client was at 0, room is at 0`. Not stale, then: the
     staleness test is `baseIndex < nextIndex - 1` and `0 < 0` is false. It was the DUPLICATE guard.

     BECAUSE EVERY CLIENT'S COUNTER STARTS AT THE SAME PLACE. `serverLink` minted `c1`, `c2`, `c3`... per
     link, and the registry was keyed on that string alone -- so the host's deal took `c1`, and the next
     player's FIRST MOVE OF THE GAME was also `c1` and was answered as a move already made. Their second
     collided with the host's second, and so on. A two-player room is a machine for producing this.

     THE KEY IS THE PAIR, AND THE ACTOR HALF COMES FROM THE CONNECTION (#1207). Keying on the actor the
     transport established -- never on anything in the frame -- means a client that mints ids carelessly, or
     maliciously, can only ever suppress its own moves. The client is now unique per link as well (its own
     note), but a rule that depends on every client being well-behaved is not a rule.

     WHY THE TESTS MISSED IT, WHICH IS THE THIRD TIME THIS SHAPE HAS COST A PLAYTEST: the smoke test wrote
     its ids by hand -- `setup-1`, `open-1`, `bob-1` -- so no two clients ever collided. Hand-picked inputs
     that are more distinct than the real ones test a world the product does not live in. */
  private submissionKey(actor: string, submissionId: string): string {
    return `${actor} ${submissionId}`;
  }

  /* ==================================================================
      DESIGN NOTE 1520: A ROOM THIS ENGINE MAY NOT INTERPRET IS HELD, NOT REBUILT
     ==================================================================
     Set by `restore` (and re-checked by every `rebuild`) from the effective log's deal, under the server's
     policy: a deal pinned to a version this engine does not support, or a deal with no pin at all, is
     incompatible. While it is set: the engine stays at its seed and never sees an entry; `submit` answers
     `incompatible` and appends nothing; `catchUp` answers `incompatible` and hands out no entries (a client
     must not be given a history the server will not interpret). The log on disk is untouched. Recovery is
     a server carrying a supported engine, which is a deployment decision and not this class's. */
  private incompatibility: { compatibility: ReplayCompatibility; reason: string } | null = null;

  constructor(options: RoomSessionOptions) {
    this.options = options;
    this.engine = new RoomEngine(options.providers, options.seed);
  }

  /** #1520: the version the effective deal names -- a number, `null` for a legacy deal, `undefined` undealt. */
  rulesEngineVersion(): number | null | undefined {
    return rulesEngineVersionOf(this.log);
  }

  /** #1520: the effective deal's compatibility with this engine, whatever the policy made of it. */
  replayCompatibility(): ReplayCompatibility {
    return replayCompatibility(this.log);
  }

  /** #1520: why this room is held, or `null` when it is being played. */
  get incompatible(): { compatibility: ReplayCompatibility; reason: string } | null {
    return this.incompatibility;
  }

  private incompatibleFrame(reason: string): ServerMessage {
    const compatibility = this.incompatibility?.compatibility;
    return {
      kind: "incompatible",
      reason,
      // A legacy deal (or an undealt log the policy refuses) has no pin to report: `null`.
      pinnedRulesEngineVersion: compatibility?.kind === "incompatible" ? compatibility.version : null,
      supportedRulesEngineVersions: SUPPORTED_RULES_ENGINE_VERSIONS,
      build: this.options.build,
    };
  }

  /** Rebuild from a stored log. The constructor plus this is a server restart.
   *
   *  APPLIED THROUGH `apply`, NEVER `submit` (#1203): the history already contains its derived entries, and
   *  generating them again would double every automatic action in the game. */
  restore(entries: readonly ServerLogEntry[]): void {
    for (const entry of entries) {
      this.log.push(entry);
      // #1219: keyed by the pair, exactly as `submit` records it, or a restart would forget who owned what.
      if (entry.submission_id) {
        this.submissions.set(this.submissionKey(entry.actor, entry.submission_id), entry.index);
      }
    }
    /* #1233: THROUGH THE EFFECTIVE LOG, not entry by entry. A stored log can hold `RevertTo` entries, and
       applying those in sequence would replay the reverted actions as if they had stood. `rebuild` is the one
       path that resolves reverts, so a restore is a rebuild. */
    this.rebuild();
  }

  /* ==================================================================
      DESIGN NOTE 1233: A LIVE REVERT IS A REBUILD, NOT A STEP
     ==================================================================
     REPORTED: "I used Undo from PRR back to B&O, which then tried buying two 2-trains: the screen flashed, the
     Activity Log printed the action happened, but no trains appeared in its assets, and the game locked."

     THE LOG ENDS AT THE REVERT. Every purchase B&O attempted after it was refused by this server and never
     appended -- with "It is not your turn", because on THIS board PRR was still operating. The client had
     rewound to B&O's Buy Trains step; the server had not rewound at all.

     `replayLog` RESOLVES REVERTS AND `RoomEngine.apply` CANNOT, and the file said so in as many words:
     "resolving reverts needs the WHOLE log, which a server appending one action at a time does not have. A
     room rebuilds through here; a room in play advances through `RoomEngine.apply`." Both halves were true
     and the second was the gap: nothing ever made a room in play rebuild. A `RevertTo` reached `submit`, was
     exempt from the turn gate (#1220 -- it is the room's, not a seat's), was appended, and was then handed to
     the reducer, which has no arm for it (#1026: "a revert is an instruction ABOUT the log") and returned the
     board unchanged. The log said one thing; the engine believed another; the divergence alarm could not
     help, because the CLIENT rebuilt correctly and so the two sides disagreed in exactly the direction the
     server was wrong.

     SO A REVERT REBUILDS. The entry is appended -- it belongs in the history, and the client's own drain
     needs to see it -- and the engine is then constructed afresh from the seed and fed the EFFECTIVE log, the
     same function the replay harness and the client's drain use. One implementation of undo, on both sides
     of the wire, which is the property #1184 exists to protect.

     THE GUARD REBUILDS WITH IT. `RoomEngine.apply` records each derived entry's turn key (#1208), so the
     rebuilt engine knows what the surviving log already contains and owes nothing twice. `settleOwed` runs
     afterwards for the same reason it runs before every submit: a rewound board may stand mid-burst.

     COST: a full replay per undo. A game is a few hundred entries and the reducer is fast; an undo is rare
     and a player-initiated wait is a wait they understand. If it ever matters, snapshots per round boundary
     are the answer -- the audit's checkpoints want those anyway -- and not a partial rewind, which would be a
     second implementation of the thing this note just removed. */
  private rebuild(): void {
    /* #1520: ASKED BEFORE THE FIRST ENTRY IS APPLIED, on every rebuild -- a restore, a revert, a discard --
       because each of them is the whole history being reinterpreted, and the deal in force can change under
       a revert. A held room keeps a seeded engine, which is the state "nothing has been interpreted". */
    const compatibility = replayCompatibility(this.log);
    const refusal = replayRefusal(compatibility, this.options.replayPolicy ?? SERVER_REPLAY_POLICY);
    this.engine = new RoomEngine(this.options.providers, this.options.seed);
    if (refusal !== null) {
      this.incompatibility = { compatibility, reason: refusal };
      return;
    }
    this.incompatibility = null;
    for (const entry of effectiveActions(this.log)) this.engine.apply(entry);
  }

  /** #1250: the store could not take what this submit appended. Drop it and rebuild, so the board is what
   *  the disk says it is -- the caller then answers the client with a refusal rather than an `applied`.
   *
   *  THE ONE PLACE THE LOG SHRINKS, and only ever back to a length the disk has acknowledged. Not a revert
   *  (#1233 keeps the entry; this removes it), because an entry the disk never held was never committed --
   *  "the append is the commit point" (#1209) now means the durable append, and an in-memory one that failed
   *  to reach it is a move that did not happen. The submission registry is rebuilt with the log so a retry of
   *  the same nonce is applied afresh rather than answered as already made. */
  discardAfter(length: number): void {
    if (this.log.length <= length) return;
    this.log.length = length;
    this.submissions.clear();
    for (const entry of this.log) {
      if (entry.submission_id) {
        this.submissions.set(this.submissionKey(entry.actor, entry.submission_id), entry.index);
      }
    }
    this.rebuild();
  }

  get state(): GameStateResponse {
    return this.engine.snapshot.state;
  }

  /** #1252: the build named by the deal that stands in the effective log, or `null` for an undealt room or a
   *  deal written before the field existed (#232: unpinned, not pinned to nothing). The EFFECTIVE log, so a
   *  deal that was reverted does not pin a room it no longer governs. */
  dealtBuild(): string | null {
    for (const entry of effectiveActions(this.log)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.payload);
      } catch {
        continue;
      }
      if (typeof parsed === "object" && parsed !== null && "SetupGame" in parsed) {
        const build = (parsed as { SetupGame: { build?: unknown } }).SetupGame.build;
        return typeof build === "string" && build !== "" ? build : null;
      }
    }
    return null;
  }

  get nextIndex(): number {
    return this.log.length === 0 ? 0 : this.log[this.log.length - 1].index + 1;
  }

  get entries(): readonly ServerLogEntry[] {
    return this.log;
  }

  /** Everything after `fromIndex`, for a client that fell behind or reconnected. */
  catchUp(fromIndex: number): ServerMessage {
    // #1520: a held room hands out no history; the client is told why instead.
    if (this.incompatibility !== null) return this.incompatibleFrame(this.incompatibility.reason);
    return {
      kind: "catch-up",
      entries: this.log.filter((entry) => entry.index > fromIndex),
      digest: stateDigest(this.state),
      ...this.explain(),
      build: this.options.build,
    };
  }

  /** #1225: the per-field digests, or nothing at all when the server was not asked to explain itself. */
  private explain(): { fields?: Record<string, string> } {
    return this.options.explainDivergence ? { fields: fieldDigests(this.state) } : {};
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

    /* ---- 1a. A HELD ROOM (#1520) ----
       Before the deal-build pin, the nonce and the staleness answers: none of them may run, because each
       reads or moves a board this engine has not built. Nothing is appended, whatever the message -- a
       `RevertTo` included, since a rewind is a rebuild under the same unsupported version. */
    if (this.incompatibility !== null) return this.incompatibleFrame(this.incompatibility.reason);

    /* ==================================================================
        DESIGN NOTE 1252: A ROOM IS PINNED TO THE REDUCER THAT DEALT IT
       ==================================================================
       `build-skew` above keeps a client and a server on different builds from talking. It does nothing about
       a server that RESTARTED on a new build with a stored log dealt on the old one (#1250 made that
       possible): the client and server would agree with each other and both apply new rules to a game in
       progress -- a deploy mid-game changing the outcome, which the audit (§6) names, and a client on the old
       build then "challenging" a correct settlement.
       THE DEAL RECORDS ITS BUILD (`SetupGame.build`, #1252 in `gameSetup.ts`) and this server refuses to
       continue any room whose deal names another. Read from the LOG, not from the state: the reducer does
       not need to know, so no field is added to the board and no digest moves. A refusal, not a skew frame:
       the client is not the one out of step, and the sentence says what to do -- run the build that dealt
       the game, or start a new one. A deal that names a build other than this server's is refused too; the
       client's own build already matched, so that is a client bug rather than a deploy, and it must not get
       a room pinned to a reducer nobody is running. */
    const dealt = this.dealtBuild();
    if (dealt !== null && !buildsAgree(dealt, this.options.build)) {
      return {
        kind: "refused",
        reason:
          `This game was dealt on build "${dealt}" and this server is build "${this.options.build}". ` +
          "A game is settled by the reducer that dealt it: run that build to continue, or start a new game.",
        build: this.options.build,
      };
    }
    if ("SetupGame" in (input.msg as Record<string, unknown>)) {
      // Through `unknown`: `SetupGame` is not a `GameplayExecuteMsg` (#1189's IOU), and the compiler is right.
      const named = (input.msg as unknown as { SetupGame: { build?: unknown } }).SetupGame.build;
      if (typeof named === "string" && !buildsAgree(named, this.options.build)) {
        return {
          kind: "refused",
          reason: `The deal names build "${named}", but this server is build "${this.options.build}".`,
          build: this.options.build,
        };
      }
    }

    /* ---- 2. A RETRY IS NOT A SECOND MOVE (#1209 mechanism 1) ----
       Answered before staleness, because a client retrying after a dropped socket is BOTH stale and
       duplicated, and telling it "you are behind" without telling it its move landed would invite a third
       attempt. The catch-up it gets here contains its own action, so it learns both at once. */
    if (
      input.submissionId !== undefined &&
      // #1219: the PAIR. `input.actor` was established by the transport and is not in the frame.
      this.submissions.has(this.submissionKey(input.actor, input.submissionId))
    ) {
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
      /* #1249: the two inputs #1220 said a turn gate did not have. The host comes from the room document via
         the caller; the log is this session's own, so a `RevertTo` is judged against the history it would
         rewrite. `undefined` host (no document) skips the host-only checks rather than refusing everyone. */
      host: input.host,
      log: this.log,
      // #1540: the grid, for the forced-purchase hold (the route walk needs it).
      mapGrid: this.engine.snapshot.grid,
      /* #1683 (Stage 10.1): the providers' own geometry, era-bound on the board as it stands, so the ingress
         answer for a `LayTile` is judged on exactly what `RoomEngine.applyOnBoard` will judge it on. */
      layRefused: (q, r, tileId, orientation) =>
        this.options.providers.layRefused(this.engine.snapshot.grid, q, r, tileId, orientation, tileEraFor(this.state)),
    });
    if (refusal !== null) {
      /* A REFUSAL STILL REPORTS THE REPAIR. The board moved before the refusal, so a client told only "not
         your turn" would be left behind by entries it never saw.
         #1685 (Stage 10.2): AND THE REPAIR STILL REPORTS THE REFUSAL. This answered a bare catch-up, which the
         client reads as "the room moved on, try again" (#1218's `onStale`) -- the sentence was lost, and the
         retry met it anyway. One `refused` frame now carries both, in the order they happened. */
      return this.refusedFrame(refusal, repaired, input.baseIndex);
    }

    /* ---- 6. APPLY AND APPEND ----
       The append is the commit point; the response is news (see the header).
       #1520: THE DEAL IS STAMPED BY THIS SERVER. Whatever version the client wrote into `SetupGame` -- the
       right one, a wrong one, none -- is replaced by the engine this process carries, so the pin is a fact
       about the server that dealt and never a claim the client made. It is written into the payload, which
       is the one part of the entry every rebuild reads first.
       #1662 (S9-1): AND SO IS THE TURN'S DRAW. The same seam now also owns `RunMultipleRoutes`'s turn key and
       `revenue_seed`, and drops `YellowSignEvent`'s playtest waiver. #1051 made the die a COMMITTED draw,
       which is a statement about reproducibility and not about authority: a crafted client could roll locally
       until the seed produced the Yellow Sign stage it wanted, and every derivation downstream would then
       faithfully reproduce the outcome the player had picked. The server draws instead, here, before the
       append -- so the number the log commits is the one this process rolled. `serverIngress.ts` #1662 has
       the rest, including why the raw log rather than the effective one answers the undo question.
       BEFORE THE APPEND AND ONLY HERE. Replay reads what was committed; nothing re-normalizes a stored
       entry, because `restore` replays entries that were normalized when they were first accepted. */
    /* #1685: the atoms as the authority is about to be handed them -- the repaired board -- for the refusal's
       sentence below, which must be asked of the board the reducer judged. */
    const boardBefore = this.state;
    const gridBefore = this.engine.snapshot.grid;
    const recorded = normalizeForCommit(input.msg, {
      board: this.state,
      /* THE RAW LOG, INCLUDING WHAT A REVERT STRUCK OUT -- #1051's rule, which is the whole reason a player
         cannot undo their way to a better face. `this.log` is that log. */
      rawLog: this.log,
      mintSeed: this.options.mintSeed,
    });
    const entry: ServerLogEntry = {
      ...mintLogEntry({
        index: this.nextIndex,
        id: this.options.mintId(),
        actor: input.actor,
        msg: recorded,
        at: this.options.now?.(),
      }),
      ...(input.submissionId === undefined ? {} : { submission_id: input.submissionId }),
    };

    /* PUSHED BEFORE THE ENGINE RUNS, so `nextIndex` is correct for every derived entry the burst mints. The
       log is storage; the engine holds the board. Appending first is also what makes the append the commit
       point rather than the response (see the header). */
    this.log.push(entry);
    if (input.submissionId !== undefined) {
      this.submissions.set(this.submissionKey(input.actor, input.submissionId), entry.index);
    }

    /* #1233: A REVERT IS NOT A MOVE TO APPLY. The entry is in the log now; the board is whatever the log,
       with that revert honoured, says it is. Rebuild, then finish any burst the rewound board owes. */
    if ("RevertTo" in (input.msg as Record<string, unknown>)) {
      this.rebuild();
      const owed = this.engine.settleOwed((msg) => this.appendDerived(msg, input.actor));
      return {
        kind: "applied",
        entries: [...repaired, entry, ...owed],
        digest: stateDigest(this.state),
        ...this.explain(),
        build: this.options.build,
      };
    }

    const settled = this.engine.submit(entry, (msg) => this.appendDerived(msg, input.actor));

    /* ==================================================================
        DESIGN NOTE 1685 (Stage 10.2, S10-1): WHAT THE REDUCER DECLINED IS NOT APPENDED
       ==================================================================
       THE LAST SILENT REFUSALS. Ingress (`turnRefusal`, step 5) answers most refusals with their sentence before
       anything is written. Every rule it does not mirror -- the depot purchase's own gate, the diesel exchange,
       the Yellow Sign's window, the train-obligation hold on `PassTurn`, `BeginOperatingRound`, the chain-era
       no-op arms -- reached the reducer, was declined BY IDENTITY, and was still answered `applied` and appended:
       a permanent entry that did nothing, broadcast to every client, committed by `logHash`, counted as the
       player's "last action" by `undoReachFor`, and -- for a declined `RunMultipleRoutes` -- carrying the seed
       `normalizeForCommit` had just drawn, so `seedAlreadyRolled` would pin it for the turn.
       THE BOUNDARY IS `RoomEngine.submit`'s `changed`: the engine's authoritative atoms (the state, with its
       chart and auction, and the tile grid) compared by content before and after the entry (`actionOutcome.ts`
       -- identity cannot answer it, because the chart step returns a fresh object for every charted action).
       A submission cannot move the engine's other two atoms (`emitted` is written for derived entries only;
       `unparseable` cannot be reached by a minted payload).
       WHEN IT DID NOT CHANGE, and the message is not one for which that is the design (`CloseRoom`'s race,
       #1685a), the move did not happen, and the session says so exactly as a store rejection does (#1250):
         * the entry is taken back off the log -- it is still the LAST entry, because an unchanged board owes no
           new derived action (the repair above drained everything the same board owed; `derived` is empty
           and is checked, not assumed);
         * the nonce is forgotten, so a retry of the same submission is JUDGED AGAIN, never answered as a move
           already made (#1209's catch-up would tell the client its refused move had landed);
         * the engine is not rebuilt: an unchanged board IS the board the shorter log describes;
         * the answer is `refused` with the reducer's own sentence where `refusalReasonFor` owns up to one
           (#784 -- the same function, on the same board, the shell's receipt asks), and a plain one otherwise.
       Stored logs are untouched: a no-op already on disk still replays as the no-op it always was. */
    /* #1687 (follow-up): asked of the board the message was judged on, so a consent answer that found nothing
       to answer -- #662's harmless duplicate -- stays applied, and one that answered a standing offer does not. */
    if (!settled.changed && settled.derived.length === 0 && unchangedMeansRefused(input.msg, boardBefore)) {
      this.log.pop();
      if (input.submissionId !== undefined) {
        this.submissions.delete(this.submissionKey(input.actor, input.submissionId));
      }
      const kind = Object.keys(input.msg as Record<string, unknown>)[0] ?? "That move";
      const reason =
        refusalReasonFor(boardBefore, input.msg, { actor: input.actor, mapGrid: gridBefore }) ??
        `${kind} was declined by the rules: the board did not change, and nothing was recorded.`;
      return this.refusedFrame(reason, repaired, input.baseIndex);
    }

    return {
      kind: "applied",
      entries: [...repaired, entry, ...settled.derived],
      digest: stateDigest(this.state),
      ...this.explain(),
      build: this.options.build,
    };
  }

  /** #1685: a refusal, carrying any repair this submit appended before it (see step 5). A bare `refused` when
   *  nothing was repaired -- the frame every client already understands (#1218). */
  private refusedFrame(reason: string, repaired: readonly ServerLogEntry[], baseIndex: number): ServerMessage {
    if (repaired.length === 0) return { kind: "refused", reason, build: this.options.build };
    return {
      kind: "refused",
      reason,
      catchUp: {
        entries: this.log.filter((entry) => entry.index > baseIndex),
        digest: stateDigest(this.state),
        ...this.explain(),
      },
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
