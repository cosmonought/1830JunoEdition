// frontend/src/utils/serverIngress.ts
//
// ==================================================================
//  DESIGN NOTE 1662 (S9-1, second half): WHAT THE SERVER OWNS ON THE WAY INTO THE LOG
// ==================================================================
//
// #1520 ESTABLISHED THE SHAPE AND THIS GENERALISES IT. "Whatever version the client wrote into `SetupGame` --
// the right one, a wrong one, none -- is replaced by the engine this process carries, so the pin is a fact
// about the server that dealt and never a claim the client made." One line in `RoomSession.submit`, applied
// between the authority gate and the append, rewriting the payload that every rebuild then reads.
//
// S9-1's FIRST HALF MADE THE YELLOW SIGN'S OUTCOME AUTHORITATIVE AND LEFT ITS INPUT ALONE. `resolveYellowSign`
// derives the stage, the train and the award from the committed board, so a client can no longer name them --
// but the board it derives from includes the turn's draw, and that draw was still a number the CLIENT chose.
// #1051 made it a committed draw (rolled once, written into the log, replayed rather than re-rolled) and that
// is honest about REPRODUCIBILITY; it says nothing about AUTHORITY. A crafted client could roll locally until
// the seed produced the stage it wanted and submit that one, and every derivation downstream would faithfully
// reproduce the outcome the player had picked. Committing a chosen number does not make it a draw.
//
// SO THE SERVER DRAWS. The same one-line seam, two more messages:
//
//   `SetupGame`          -- the version pin (#1520, unchanged).
//   `RunMultipleRoutes`  -- the turn key and the revenue seed. The key is rebuilt from the SERVER's board, not
//                           read off the message, because the key is what the seed is looked up by: a client
//                           that could name the key could point the lookup at a turn whose roll it liked. The
//                           seed is then #1051's own rule, asked of the server's raw log -- an earlier draw for
//                           this turn if one exists, a fresh one otherwise.
//   `YellowSignEvent`    -- `debug_force` is dropped. It is a playtest waiver (#1128) and there is no such
//                           thing as a playtest in an authoritative room; dropped rather than refused because
//                           the event itself is legitimate and the shell has already narrated it. What the
//                           client asked for simply never becomes part of the accepted entry.
//
// UNDO STILL DOES NOT RE-ROLL, which is the requirement #1051 was specified with -- "undoing it should not
// change their roll, otherwise players would just slot machine their way to +20%." `seedAlreadyRolled` scans
// the RAW log, including the entries a revert has struck out, so a player who runs, undoes and runs again is
// handed the face they already saw. The server's raw log is the better place to ask than the client's: the
// client's copy of a room's log can be behind, which is the race `App.tsx` #1051's note ends on.
//
// AND REPLAY NEVER COMES HERE. This runs once, at ingress, before the append. A rebuild reads the committed
// payload and the reducer consumes the stored seed -- there is no path on which a replayed entry is
// re-normalized, because `RoomSession.restore` replays entries that were normalized when they were first
// accepted.
//
// LOCAL SANDBOX PLAY IS UNAFFECTED, deliberately. A Firestore sandbox room has no server between the clients;
// it deals unpinned and keeps the shell's own draw (`App.tsx` #1051) and its own playtest waiver. That is the
// non-authoritative half of the split S9-1 already drew along `rules_engine_version`, and the reducer refuses
// to honour a waiver on a pinned board whatever reaches it (`sandboxSession.ts` #1662).

import { isSetupGameMsg } from "../gameEngine/gameSetup";
import { stampRulesEngineVersion } from "../gameEngine/rulesVersion";
import { randomTurnSeed } from "../gameEngine/gameVariants";
import { seedAlreadyRolled, turnSeedKey, type SeededEntry } from "./turnSeed";

/** What the normalizer needs from the server's board: the two round coordinates the turn key is built from. */
export interface IngressBoard {
  macro_round_number?: number;
  sub_round_index?: number;
}

export interface IngressContext {
  /** The board as the server holds it, AFTER any repair and before this message is applied. */
  board: IngressBoard;
  /** The session's RAW log -- including entries a revert has struck out (#1051's undo rule). */
  rawLog: readonly SeededEntry[];
  /** The server's draw. Injected like `mintId`, so a test is deterministic without the normalizer being. */
  mintSeed?: () => number;
}

/** The payload the server commits, given what the client sent.
 *
 *  Structural rather than typed against `GameplayExecuteMsg`: this rewrites two fields on two messages and
 *  passes everything else through by identity, and a union type here would force a cast per arm for no claim
 *  it could actually check. The caller keeps its own type. */
export function normalizeForCommit<T>(msg: T, ctx: IngressContext): T {
  if (typeof msg !== "object" || msg === null) return msg;

  /* #1520, moved here unchanged: the deal is stamped by the server that dealt it. */
  if (isSetupGameMsg(msg as never)) {
    return stampRulesEngineVersion(msg as unknown as { SetupGame: Record<string, unknown> }) as unknown as T;
  }

  const record = msg as Record<string, unknown>;

  if ("RunMultipleRoutes" in record) {
    const body = record.RunMultipleRoutes as Record<string, unknown>;
    const protocolId = Number(body.protocol_id);
    /* NOT `body.revenue_turn`. The key identifies the turn the draw belongs to and is the thing the lookup
       below searches on, so taking it from the message would let a client point the search at a turn whose
       roll it preferred -- the same defect one field over. Rebuilt from the server's own round coordinates,
       which is where #1051's note says the round and sub-round actually live. */
    const key = turnSeedKey(ctx.board.macro_round_number ?? 0, ctx.board.sub_round_index ?? 0, protocolId);
    const seed = seedAlreadyRolled(ctx.rawLog, key) ?? (ctx.mintSeed ?? randomTurnSeed)();
    return { ...record, RunMultipleRoutes: { ...body, revenue_turn: key, revenue_seed: seed } } as unknown as T;
  }

  if ("YellowSignEvent" in record) {
    const body = record.YellowSignEvent as Record<string, unknown>;
    if (!("debug_force" in body)) return msg;
    /* DROPPED, NOT FALSIFIED. The committed entry must read as an ordinary request, so a later reader cannot
       tell a client that tried from one that did not -- and cannot be tempted to honour the field either. */
    const { debug_force: _dropped, ...rest } = body;
    return { ...record, YellowSignEvent: rest } as unknown as T;
  }

  return msg;
}
