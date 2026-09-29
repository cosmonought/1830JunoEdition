// frontend/src/utils/serverProtocol.ts
//
// What a client sends the server, and what comes back.
//
// ==================================================================
//  DESIGN NOTE 1207: THE WIRE CARRIES LOG ENTRIES, NOT BOARDS
// ==================================================================
//
// THE SERVER SHIPS WHAT IT APPENDED, and the client derives the board from it exactly as it derives one from
// a replay. Three reasons, and the third is the one that decided it:
//
//   IT IS SMALLER. A settled burst is one to six entries; a board is every corporation, every private, every
//   token and the whole market chart.
//
//   IT IS ALREADY THE SOURCE OF TRUTH. The log is what settlement commits to and what a rebuild reads. A
//   protocol that shipped boards would introduce a SECOND representation of the game to keep in step with the
//   first, which is this project's oldest failure shape.
//
//   IT KEEPS THE CLIENT'S OWN REDUCER HONEST. Clients still apply locally (the owner's call), and a client
//   handed a finished board would have nothing to apply -- the local computation would become decorative, and
//   the divergence check with it. Handed entries, both sides do the same work and can be compared, which is
//   the free detection that has found most of this migration's bugs.
//
// THE ACTOR IS DELIBERATELY NOT ON THE WIRE.
//
//   A submission says WHAT the player wants to do and never WHO they are. The server knows who they are from
//   the authenticated connection, and a field saying so would be a field a client could lie in.
//
//   THIS IS THE SAME LESSON `turnAuthority` LEARNED ONE LAYER DOWN (#1205): the consent exemption asks the
//   BOARD whether this actor is the counterparty, rather than trusting an `offTurn: true` flag the sender set
//   about itself. That was safe while the shell called its own code. It stops being safe the moment the
//   sender is a network client, and so does this.
//
// THE SERVER MINTS THE BYTES, WHICH IS A CHANGE AND AN IMPROVEMENT.
//
//   #1188 found that `payload` is JSON text minted once by the dispatching CLIENT and distributed verbatim,
//   and called that a happy accident -- it is what makes the log hashable without a canonicalisation scheme.
//   With one writer the accident becomes a guarantee: the server serialises through `canonicalJson`, so the
//   log's bytes are canonical BY CONSTRUCTION rather than by nobody having touched them.
//
//   WHICH ALSO REMOVES A SUBTLETY NOBODY HAD NOTICED. Two clients sending the same logical move could
//   previously mint different bytes for it -- same state, different text -- because key order follows
//   whichever object literal the shell happened to build. Harmless for replay, and quietly awkward for a
//   commitment. One serialiser ends it.
//
// EVERY MESSAGE CARRIES A BUILD IDENTIFIER, and #1206 is why it is not optional. `stateDigest` covers the
// WHOLE state, so a client on an older build disagrees with the server about a field that is not a divergence
// at all. Without a build on the wire that surfaces as a phantom desync -- which is the precise thing this
// migration exists to stop people chasing.

import type { ReplayEntry } from "../gameEngine/replayLog";
import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import { canonicalJson } from "../gameEngine/stateDigest";

/** Identifies the code both sides are running. Any string both halves agree on; a git sha in practice. */
export type BuildId = string;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export interface SubmitRequest {
  kind: "submit";
  room: string;
  build: BuildId;
  /** The move. NOT who is making it -- see the header. Stage 10.5 (S10-9): any logged room message (the deal,
   *  the room-only events, contract gameplay) -- the family `messageSchema.ts` validates at ingress. */
  msg: SandboxLogMsg;
  /** The last index this client has applied.
   *
   *  OPTIMISTIC CONCURRENCY, AND THE REASON THE SERVER CAN ANSWER "you are behind" RATHER THAN GUESSING. A
   *  client that has missed entries would otherwise apply the server's next burst onto a board that never
   *  saw the previous one, and derive a board nobody has -- a divergence manufactured by the transport
   *  rather than found by it. */
  baseIndex: number;
  /** LIVE-3A (L3-3): the `id` of the entry this client holds at `baseIndex` -- the anchor. The server refuses a
   *  submission whose anchor names an entry the room does not hold there (`resync`), which catches a history that
   *  diverged even when it is BEHIND rather than ahead. Absent when `baseIndex` is -1, and from an older client,
   *  which then gets the index-only rules. */
  baseId?: string;
  /** The digest of this client's board BEFORE the move.
   *
   *  Optional because a client that has just joined has nothing to compare, and because a divergence report
   *  is worth more than a refusal: the server applies regardless and says so, rather than rejecting a move
   *  on the strength of a mismatch nobody has diagnosed yet. */
  clientDigest?: string;
}

/** Sent when a client's own replay disagrees with the server's answer.
 *
 *  A REPORT, NOT A REQUEST. There is nothing for the client to ask for -- the server is the authority and its
 *  board is the game. What this buys is the one thing the old architecture could never get: a divergence that
 *  ANNOUNCES ITSELF, at the index where it began, instead of surfacing as a station token somebody else
 *  cannot see. */
export interface DivergenceReport {
  kind: "divergence";
  room: string;
  build: BuildId;
  /** The last index both sides agree was applied. */
  atIndex: number;
  clientDigest: string;
  serverDigest: string;
}

/** The log subscription (#1209 mechanism 2): what this client has applied, so a reconnect is answered rather than
 *  guessed at. `claim`, `pin` and `token` are the legacy identity fields LIVE-2 removes. */
export interface HelloRequest {
  kind: "hello";
  room: string;
  build: BuildId;
  claim?: unknown;
  pin?: unknown;
  token?: unknown;
  /** The last index this client has applied; -1 for nothing. */
  baseIndex?: number;
  /** LIVE-3A: the anchor, exactly as on `SubmitRequest`. */
  baseId?: string;
}

export type ClientMessage = SubmitRequest | DivergenceReport;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/* ==================================================================
    LIVE-3A (L3-3): A DIRECT ANSWER NAMES THE SUBMISSION IT ANSWERS
   ==================================================================
   The per-game actor serializes a room's submissions, so another player's fan-out now arrives, deterministically,
   BEFORE this client's own queued answer -- and a client that matched replies first-in-first-out resolved its
   submission with the other player's index (LIVE-3 P4). So every DIRECT answer to a `submit` -- applied, refused,
   catch-up, build-skew, incompatible -- carries `inReplyTo: submissionId`, and fan-out frames never do. The client
   settles exactly the submission a frame names; a frame that names none is history. */

/** The machine code on a refusal the transport decided rather than the rules. Absent on a rules refusal
 *  (`turnAuthority`'s or the reducer's sentence), which every client already shows as-is. */
export type RefusalCode =
  /** LIVE-2C (RV-1): the sender holds no seat in the room's GameRecord; nothing was read or recorded. */
  | "not-seated"
  /** `baseIndex` is above the room's durable watermark: this client holds history the room does not. */
  | "ahead"
  /** `baseId` names an entry the room does not hold at `baseIndex`: the two histories diverged. */
  | "resync"
  /** Nothing was recorded -- the store definitely did not take it, or the task never ran. Act again. */
  | "retry"
  /** The store's outcome is not known yet. The move appears when the game resumes, if it landed. */
  | "unavailable"
  /** The game is held and cannot be changed. */
  | "held"
  /** The game's queue is full. */
  | "busy"
  /** The server failed before anything was committed; the sentence carries a reference to its log line. */
  | "internal";

export interface AppliedResponse {
  kind: "applied";
  /** The player's action and every derived action the burst generated, in log order.
   *
   *  ONE MESSAGE PER SETTLE POINT (#1203), never one per action. That is the whole of item 6: the burst is
   *  over when the game stops owing actions, and a client that rendered each step would flicker through the
   *  sub-phases exactly as the shell does today. */
  entries: ReplayEntry[];
  /** The server's board after the whole burst. The client compares its own. */
  digest: string;
  /** #1225: one digest per top-level field, present only when the server was started to explain divergences
   *  (local play). A hash says "different" and not "where"; this says where in one step, and costs nothing on
   *  a deployment that leaves it off. */
  fields?: Record<string, string>;
  build: BuildId;
  /** LIVE-3A: the submission this answers. Absent on fan-out: a watcher's copy of somebody else's move. */
  inReplyTo?: string;
}

export interface RefusedResponse {
  kind: "refused";
  /** `turnAuthority`'s sentence, or a reducer refusal. Shown to the player as-is. */
  reason: string;
  /** LIVE-3A: present when the transport, not the rules, refused (see `RefusalCode`). */
  code?: RefusalCode;
  /** LIVE-3A: the room's durable watermark, on `ahead` and `resync`. */
  watermark?: number;
  /** LIVE-3A: the submission this answers. */
  inReplyTo?: string;
  /** #1685 (Stage 10.2): the entries this submit appended BEFORE it was refused -- the repair of a burst a crash
   *  interrupted (#1209) -- which the submitter has not seen. Present only when there were any; applied by the
   *  client exactly as a catch-up, before the refusal is shown. Never contains the refused move: that was not
   *  appended. */
  catchUp?: { entries: ReplayEntry[]; digest: string; fields?: Record<string, string> };
  build: BuildId;
}

/** The client was behind, so here is what it missed.
 *
 *  ENTRIES RATHER THAN A BOARD, for the header's third reason: a client handed a board would have nothing to
 *  apply, and the local reducer is what makes the divergence check possible at all. */
export interface CatchUpResponse {
  kind: "catch-up";
  entries: ReplayEntry[];
  digest: string;
  /** #1225: one digest per top-level field, present only when the server was started to explain divergences
   *  (local play). A hash says "different" and not "where"; this says where in one step, and costs nothing on
   *  a deployment that leaves it off. */
  fields?: Record<string, string>;
  build: BuildId;
  /** LIVE-3A: the submission this answers (a duplicate or a stale submit). Absent on the hello's catch-up. */
  inReplyTo?: string;
  /** LIVE-3A: on the hello's catch-up only -- the submissions this principal originated that are still being
   *  committed. A reconnecting client keeps those pending instead of calling them lost; each settles when its
   *  entry arrives or when `abandoned` names it. ALWAYS present on a LIVE-3A server's hello answer, empty or not:
   *  its presence is how a client knows the server answers by `inReplyTo`. */
  inFlight?: string[];
}

/** The two halves are not running the same code.
 *
 *  ITS OWN CASE, NOT AN ERROR STRING, because #1206's digest covers the whole state and an added field is not
 *  a divergence. A client that learns this should say so plainly and stop reporting desyncs, rather than
 *  filing reports nobody can act on. */
export interface BuildSkewResponse {
  kind: "build-skew";
  clientBuild: BuildId;
  serverBuild: BuildId;
  /** LIVE-3A: the submission this answers. */
  inReplyTo?: string;
}

/** #1520: the room's deal is pinned to a rules-engine version this server does not carry (or to none at all,
 *  which the server refuses too -- a missing pin is never read as the current version).
 *
 *  ITS OWN CASE, LIKE `build-skew`, because it is not a refusal of one move and not a desync: nothing was
 *  interpreted. The room's log is intact on disk and untouched; no entry was appended and none will be until
 *  a server carrying the pinned version loads it. A client that receives this has no history to apply, and
 *  should say so and stop, rather than retry -- the same hello earns the same answer. */
export interface IncompatibleResponse {
  kind: "incompatible";
  reason: string;
  /** LIVE-4 (L4-2), additive: why this server does not continue (or no longer serves) the game, in the canonical
   *  verdict's words (`rules-not-supported`, `hosted-protocol`, `malformed`, ...) or the serving decision's
   *  (`drain-expired`, ...). Derived, never a hold. An older client ignores it. */
  why?: string;
  /** The version the deal names, or `null` for a legacy (unpinned) deal. */
  pinnedRulesEngineVersion: number | null;
  supportedRulesEngineVersions: readonly number[];
  build: BuildId;
  /** LIVE-3A: the submission this answers, when it answers one (a hello's is not an answer to a submission). */
  inReplyTo?: string;
}

export type ServerMessage =
  | AppliedResponse
  | RefusedResponse
  | CatchUpResponse
  | BuildSkewResponse
  | IncompatibleResponse;

/** LIVE-3A (§4.2): a submission whose origin socket went away while it was being committed ended WITHOUT
 *  committing. Sent to the principal's current sockets, so a reconnected client that kept it pending (`inFlight`)
 *  settles it as not landed -- the one answer that may be followed by trying again. */
export interface AbandonedFrame {
  kind: "abandoned";
  inReplyTo: string;
  reason: string;
}

/** LIVE-3A (E-10): the game's availability, sent to every subscriber on each hold and resume. `unavailable`
 *  while the server cannot establish what its store holds; `held` when it will not interpret the room; `live`
 *  when submitting works again. */
export interface RoomStatusFrame {
  kind: "status";
  state: "live" | "unavailable" | "held";
  reason?: string;
}

/** A subscription-level refusal (and the few transport replies that are not a `ServerMessage`). LIVE-3A adds the
 *  codes: `resync` answers a hello whose history the room does not hold (with the room's `watermark`);
 *  `unavailable` a room that could not be loaded. */
export interface ServerErrorFrame {
  kind: "error";
  reason: string;
  code?: string;
  watermark?: number;
  /** LIVE-3A: present when the error answers a `submit`. */
  inReplyTo?: string;
}

/** Everything a game-server socket may carry to a client. */
export type ServerFrame = ServerMessage | AbandonedFrame | RoomStatusFrame | ServerErrorFrame;

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/** Build the log entry for a message.
 *
 *  THE ONLY PLACE A PAYLOAD IS SERIALISED, and it goes through `canonicalJson` so the log's bytes are
 *  canonical by construction (#1207). `derived` is omitted rather than written `false`, because #232's rule
 *  applies to the log as much as to the board: absent means "not a derived action", and a field written on
 *  every entry to say "no" is a field that will eventually be written wrong. */
export function mintLogEntry(input: {
  index: number;
  id: string;
  actor: string;
  msg: SandboxLogMsg;
  derived?: boolean;
  at?: number;
}): ReplayEntry {
  return {
    index: input.index,
    id: input.id,
    actor: input.actor,
    payload: canonicalJson(input.msg),
    ...(input.at === undefined ? {} : { at: input.at }),
    ...(input.derived ? { derived: true } : {}),
  };
}

/** Whether these two builds may talk to each other.
 *
 *  EXACT MATCH, AND NOTHING CLEVERER. A comparison that tolerated "compatible" versions would need somebody
 *  to decide what compatible means for a state digest that covers every field -- and the honest answer is
 *  that one added field makes them incompatible for this purpose. Cheap to be strict; expensive to be wrong. */
export function buildsAgree(clientBuild: BuildId, serverBuild: BuildId): boolean {
  return clientBuild === serverBuild;
}
