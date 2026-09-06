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

import type { ReplayEntry } from "./replayLog";
import type { GameplayExecuteMsg } from "./sessionKey";
import { canonicalJson } from "./stateDigest";

/** Identifies the code both sides are running. Any string both halves agree on; a git sha in practice. */
export type BuildId = string;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export interface SubmitRequest {
  kind: "submit";
  room: string;
  build: BuildId;
  /** The move. NOT who is making it -- see the header. */
  msg: GameplayExecuteMsg;
  /** The last index this client has applied.
   *
   *  OPTIMISTIC CONCURRENCY, AND THE REASON THE SERVER CAN ANSWER "you are behind" RATHER THAN GUESSING. A
   *  client that has missed entries would otherwise apply the server's next burst onto a board that never
   *  saw the previous one, and derive a board nobody has -- a divergence manufactured by the transport
   *  rather than found by it. */
  baseIndex: number;
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

export type ClientMessage = SubmitRequest | DivergenceReport;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

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
  build: BuildId;
}

export interface RefusedResponse {
  kind: "refused";
  /** `turnAuthority`'s sentence, or a reducer refusal. Shown to the player as-is. */
  reason: string;
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
  build: BuildId;
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
}

export type ServerMessage =
  | AppliedResponse
  | RefusedResponse
  | CatchUpResponse
  | BuildSkewResponse;

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
  msg: GameplayExecuteMsg;
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
