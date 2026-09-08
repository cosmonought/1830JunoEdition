// frontend/src/utils/divergenceWatch.ts
//
// Does this client's board still match the room's?
//
// ==================================================================
//  DESIGN NOTE 1223: THE ALARM THAT WAS BUILT AND NEVER CONNECTED
// ==================================================================
//
// #1207 ARGUED FOR KEEPING THE CLIENT'S REDUCER ALIVE, in as many words: "it is not a thin renderer, it is a
// second opinion", and the payoff named was free divergence detection -- two independent computations of the
// same log, so a disagreement is detectable at no extra cost. `stateDigest` was written for it. The server
// puts a digest on every `applied` and `catch-up` frame. **Nothing compared them.**
//
// SO THE COST WAS PAID AND THE PAYOFF WAS NOT COLLECTED, and a playtest showed exactly what that is worth: a
// client's board drifted from the room's during ten rapid undo/re-buy cycles, and the first anybody knew of
// it was a Buy Stock button that did nothing a full round later. The server would have allowed that purchase;
// the client refused it locally, from a board nobody else had. The evidence to catch it at the moment it
// opened was already on the wire and already being thrown away.
//
// ---------------------------------------------------------------------------
//  WHAT IT DOES AND DOES NOT DO
// ---------------------------------------------------------------------------
//
// IT REPORTS. It does not refuse actions, and it does not rebuild the board. Both were considered:
//
//   REFUSING would turn a false positive into a bricked game, and the client is already prevented from doing
//   real damage -- `turnAuthority` runs on the server, so a diverged client's bad move is refused there. The
//   damage from divergence is that the SCREEN lies, and a screen that lies while saying so is strictly better
//   than one that lies silently.
//
//   REBUILDING is the right eventual answer and is a bigger change: the drain already knows how to replay
//   from index 0 (#591's "a full replay is the cheap option"), so an automatic resync is reachable -- but a
//   rebuild triggered by a hash comparison that has never run in anger is a way to turn a cosmetic drift into
//   a loop. Report first, learn what fires, automate second.
//
// ONE ALARM PER EPISODE, NOT ONE PER SETTLE. A diverged client stays diverged until it reloads, so comparing
// on every settle point would put the same sentence on screen after every action in the game -- which trains
// the player to ignore it, and buries the one message that mattered. The report is armed again only after the
// two sides agree, which is what a resync looks like from here.
//
// A MISSING SERVER DIGEST IS NOT A DISAGREEMENT (#232). The Firestore path has no server to disagree with,
// and a frame that carried no digest is a frame that said nothing about the board. Both read as "no verdict",
// never as "diverged" -- an alarm that fires when it has no evidence is an alarm that gets turned off.

export interface DivergenceInput {
  /** The server's digest of the board after it applied the same entries. `null` when there is no server
   *  (the Firestore path) or when the frame carried none. */
  serverDigest: string | null;
  /** This client's digest of its own board, taken at the settle point. */
  clientDigest: string;
  /** The highest log index this client has applied. Names WHERE, which is what makes a report actionable. */
  appliedIndex: number;
  /** The index this client last reported a divergence at, or `null` if it is currently in agreement. */
  reportedAt: number | null;
  /* ==================================================================
      HAVE THE TWO SIDES EVER AGREED IN THIS SESSION?
     ==================================================================
     THE ALARM REPORTS DRIFT, AND DRIFT PRESUPPOSES A STARTING AGREEMENT. Two hashes that have never matched
     are not evidence of a game going wrong; they are evidence that something SYSTEMIC differs -- a seed, a
     field one side carries and the other does not, a serialisation detail. That is a bug in this mechanism,
     not in the room, and telling a player to reload would be both useless and constant.

     WHICH IS THE FAILURE MODE THAT KILLS AN ALARM. One that cries wolf from the first action gets ignored,
     then turned off, and the one time it was right nobody is listening. Requiring an agreement first costs a
     divergence that opens at action one -- a real but narrow case, and one a systemic mismatch is far more
     likely to be masquerading as.

     THE MISMATCH-FROM-THE-START CASE IS STILL REPORTED, just not to the player: the verdict returns a `note`
     for the console, so a build where the two halves never agree says so to whoever is looking for it. */
  everAgreed: boolean;
}

export interface DivergenceVerdict {
  /** True whenever the two digests are both present and differ, whether or not it is worth saying again. */
  diverged: boolean;
  /** A sentence for the player, or `null` when there is nothing NEW to say. */
  message: string | null;
  /** A line for the console and not for the player: the two halves have never agreed, which is a fault in
   *  this mechanism rather than in the room. `null` when there is nothing to note. */
  note: string | null;
  /** What the caller should store back as `reportedAt`. */
  reportedAt: number | null;
  /** What the caller should store back as `everAgreed`. */
  everAgreed: boolean;
}

/** The sentence a player sees. Names the fault, names the fix, and does not blame the player.
 *
 *  "RELOAD" IS THE HONEST INSTRUCTION because it is the one that works: the log is the game (#522), so a
 *  reloading client replays from index 0 and arrives at whatever the room actually holds. */
export function divergenceMessage(appliedIndex: number): string {
  return (
    `This tab has drifted from the room — its board no longer matches the server's (at action ${appliedIndex}). ` +
    `Reload to resync.`
  );
}

/** Compare the two boards and decide whether to say anything. */
export function divergenceVerdict(input: DivergenceInput): DivergenceVerdict {
  const { serverDigest, clientDigest, appliedIndex, reportedAt, everAgreed } = input;

  // #232: no digest is not a matching digest. Nothing is claimed either way, and the arming state is kept.
  if (serverDigest === null || serverDigest === "") {
    return { diverged: false, message: null, note: null, reportedAt, everAgreed };
  }

  if (serverDigest === clientDigest) {
    /* AGREEMENT RE-ARMS THE ALARM. A client that resynced and then drifted again has a second, genuinely new
       thing to report, and clearing here is what lets it be said. */
    return { diverged: false, message: null, note: null, reportedAt: null, everAgreed: true };
  }

  if (!everAgreed) {
    /* NEVER AGREED, SO THIS IS NOT DRIFT. See the field's note: a systemic mismatch would otherwise put a
       reload prompt on screen after every action in the game. Said once, to the console. */
    return {
      diverged: true,
      message: null,
      note:
        reportedAt === null
          ? `the server and this tab have not agreed on the board at any point this session (first checked ` +
            `at action ${appliedIndex}) — this is a fault in the digest comparison, not in the room`
          : null,
      reportedAt: reportedAt ?? appliedIndex,
      everAgreed: false,
    };
  }

  if (reportedAt !== null) {
    // Already told them. Still diverged, still true, not worth repeating after every action.
    return { diverged: true, message: null, note: null, reportedAt, everAgreed };
  }

  return {
    diverged: true,
    message: divergenceMessage(appliedIndex),
    note: null,
    reportedAt: appliedIndex,
    everAgreed,
  };
}
