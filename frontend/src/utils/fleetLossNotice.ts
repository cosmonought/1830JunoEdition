// frontend/src/utils/fleetLossNotice.ts
//
// What a corporation lost while it was not looking, and whether to say so.
//
/* ==================================================================
 *  DESIGN NOTE 896: THE TRAINS WENT AND NOBODY STOPPED THE PLAYER TO SAY SO
 * ==================================================================
 *
 * REQUESTED: "When a corporation loses trains to a rust event or to a train limit drop between turns, present
 * the active player with an unavoidable, blocking modal at the absolute start of their Operating Round turn."
 *
 * #704 ALREADY WRITES THE SENTENCE, and this is not a second copy of it. `describeFleetLoss` produces one
 * combined line for the Activity Log at the moment the phase turns -- correct, and read by nobody, because the
 * phase turns during SOMEBODY ELSE'S turn. The president whose fleet was emptied is two corporations away and
 * finds out by counting chips. A log line is the right record and the wrong interruption.
 *
 * SPLIT BY CAUSE, WHICH THE LOG LINE DOES NOT DO. `describeFleetLoss` joins rust and discard into one sentence
 * with "and". A modal cannot, because the silence toggle is per cause -- "don't notify me about Rust events for
 * this corporation" must not also silence a train limit drop, which is a different rule with a different
 * remedy. One loss therefore yields up to TWO notices, and they are independent all the way down.
 *
 * THE CAUSES ARE NOT SYMMETRICAL and the copy says so. A rust is the board acting on every corporation at once
 * and there was never a decision to make. A limit drop takes a train the corporation still legally owned a
 * moment earlier, cheapest-first, with no choice offered -- which is the part players misread as a bug, per
 * #704's own "I actually thought the 3-train purchase had been swapped out with it".
 *
 * WHY NOT DERIVE THIS FROM STATE AT TURN START, which would be the honest thing and is not available. "Lost
 * trains since its last turn" needs the fleet AS IT WAS at that last turn, and nothing in `GameStateResponse`
 * remembers it. The alternatives were both worse: a `pending_fleet_notice` field on the corporation would be a
 * schema change the Rust contract would then have to carry, and an acknowledgement ACTION would put a purely
 * cosmetic dismissal into the log that Undo could then rewind. So the notice is queued by the shell at the
 * transition -- where `before` and `after` are both in hand -- and this module owns everything about it that
 * can be tested without a browser.
 *
 * THE REPLAY HAZARD IS REAL AND IS GUARDED, not hand-waved. Undo rebuilds state by replaying the log, which
 * re-runs `applyPhaseChange` and re-queues every notice. Dismissal is therefore remembered against
 * `turnGuardKey` -- #653's key, derived from game state rather than counted locally, so a rebuild produces the
 * same key and a dismissed notice stays dismissed.
 * WHAT THAT KEY CANNOT TELL APART is the same turn reached twice by different histories: undo to a much
 * earlier point, play differently, arrive at OR 2.1 with corporation 3 again, and a notice dismissed in the
 * abandoned line is suppressed in the new one. #653 accepted the same trade for auto-skip. It is recorded here
 * rather than discovered later, and the failure mode is a missing notice rather than a wrong game state.
 *
 * See docs/ai_architecture/state_machine.md, fleetLossNotice.ts #896. */

import type { FleetLoss } from "./sandboxSession";
import { turnGuardKey, type OperatingTurnIdentity } from "./turnGuardKey";

/** Why the trains left. The toggle in the modal is per cause, so this is also the silence vocabulary. */
export type FleetLossCause = "rust" | "limit";

export interface FleetLossNotice {
  companyId: number;
  ticker: string;
  cause: FleetLossCause;
  /* Design note #1003: `gentleRust` IS GONE FROM THIS RECORD. #906 put it here so the copy could change
     tense -- "not gone yet, it runs once more" -- and that tense was only ever needed because the notice
     fired at the MARKING. #1002 moves it to the destruction, where the trains really are gone, so the
     standard sentence is the true one and there is nothing left for the flag to select. A field that can
     only ever be `false` is #788's unreachable arm wearing a boolean. */
  /** The models this cause took, in the order the reducer took them. */
  trains: readonly string[];
  /** The tier whose arrival did it -- "4" for the first 4-train. `null` when the chain did not say. */
  arrivingTier: string | null;
  /** The limit now in force. Only meaningful for a `limit` notice. */
  trainLimit: number | null;
}

/** "its 2-train", "its 3-train and 3-train" -- the tier spelled as players say it (#696).
 *
 *  A SECOND COPY OF `sandboxSession`'s `namedTrains`, deliberately: that one is module-private and exporting it
 *  to share four lines would widen a reducer's surface for a phrasing helper. If a third caller ever wants it,
 *  that is the moment to lift it out -- not this one. */
function namedTrains(models: readonly string[]): string {
  const named = models.map((model) => `${model}-train`);
  if (named.length === 1) return named[0];
  if (named.length === 2) return `${named[0]} and ${named[1]}`;
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/** One loss, split into the notices a player should be stopped for.
 *
 *  Returns `[]` when the loss took nothing, which is the same guard `describeFleetLoss` applies before building
 *  a sentence: a corporation that lost no trains gets no modal, and a caller looping over `describeFleetLosses`
 *  can hand every entry here without filtering first. */
export function fleetLossNotices(
  loss: FleetLoss,
  arrivingTier: string | null,
  trainLimit: number | null,
): FleetLossNotice[] {
  const notices: FleetLossNotice[] = [];
  const base = { companyId: loss.companyId, ticker: loss.ticker, arrivingTier, trainLimit };
  if (loss.rusted.length > 0) {
    notices.push({ ...base, cause: "rust", trains: [...loss.rusted] });
  }
  if (loss.discarded.length > 0) {
    notices.push({ ...base, cause: "limit", trains: [...loss.discarded] });
  }
  return notices;
}

/** The modal's title. Short, and it names the corporation, because the player may be running several. */
export function noticeHeadline(notice: FleetLossNotice): string {
  const count = notice.trains.length;
  const plural = count === 1 ? "train" : "trains";
  return notice.cause === "rust"
    ? `${notice.ticker} lost ${count} ${plural} to rust`
    : `${notice.ticker} gave up ${count} ${plural} to the train limit`;
}

/** What happened, in the order a president needs it: the event, then the consequence, then the remedy.
 *
 *  ==================================================================
 *   DESIGN NOTE 980: THE RUST MODAL WAS A WALL OF TEXT
 *  ==================================================================
 *
 *  RULED: "The current Rust modal contains a wall of text. Simplify it drastically." With the replacement
 *  given verbatim: `"[number] of your [train-type]-trains have rusted."`, and for the variant, `"Gentle rust:
 *  You can run these trains one more time before they retire."`
 *
 *  AND THE OLD COPY HAD ACQUIRED A FALSEHOOD, which is the better reason to cut it. Its last sentence read
 *  "It no longer counts against the train limit, so its replacement can be bought now" -- #906's rule, which
 *  #979 has just corrected. A long paragraph is where a stale clause hides; a one-line sentence has nowhere
 *  to put one.
 *
 *  WHAT THE TRIGGER SENTENCE WAS BUYING, and why losing it is affordable: it named which purchase caused this
 *  ("The first 4-train was bought"). That fact is in the Activity Log, on the line immediately above, with a
 *  timestamp and a round stamp -- and the modal is a blocking interruption, which is the worst surface in the
 *  app for a fact the player did not ask for.
 *
 *  NUMBER AGREEMENT IS THE ONE DEVIATION from the ruled string: with a single train it reads "1 of your
 *  2-trains has rusted." The template was written for the plural case and "have" is simply wrong for one.
 *
 *  THE LIMIT NOTICE IS UNTOUCHED. The ruling names the rust modal, and the limit copy is carrying a rule the
 *  player genuinely cannot infer -- which train went, and that they had no say. Trimming it was not asked for
 *  and it is not the same kind of text. */
export function noticeBody(notice: FleetLossNotice): string {
  const trains = namedTrains(notice.trains);
  if (notice.cause === "rust") {
    const verb = notice.trains.length === 1 ? "has" : "have";
    return `${notice.trains.length} of your ${notice.trains[0]}-trains ${verb} rusted.`;
  }
  /* THE LIMIT IS NAMED AND SO IS THE RULE, for #704's reason: "discarded its 2-train" without them reads as a
     choice the president made. It is not a choice -- 1830 takes the train, and the only latitude is which one. */
  const ceiling =
    notice.trainLimit === null ? "the new train limit" : `the new limit of ${notice.trainLimit}`;
  const trigger =
    notice.arrivingTier === null
      ? "The phase changed"
      : `The first ${notice.arrivingTier}-train started a new phase`;
  return (
    `${trigger} and cut the train limit. ${notice.ticker}'s ${trains} ${count(notice)} returned to ` +
    `the depot to meet ${ceiling}. The cheapest go first; the corporation gets no say in which.`
  );
}

const count = (notice: FleetLossNotice) => (notice.trains.length === 1 ? "is" : "are");

/** The line that makes the interruption fair.
 *
 *  A BLOCKING MODAL OWES THE PLAYER THIS. Being stopped is tolerable when the thing you are told could not have
 *  been avoided and is about to change what you do next; it is an insult when it is news you could have read.
 *  Both causes qualify -- neither is refusable and both happened while this corporation was not acting. */
/* ==================================================================
 *  DESIGN NOTE 990: `noticeConsequence` IS GONE, AND ITS LAST SENTENCE WAS WRONG ABOUT THE RULES
 * ==================================================================
 *
 * RULED: "The modal incorrectly states the discarded train returns to the depot. Discarded trains are
 * permanently removed from the game. Remove the sentence: 'The train is already back in the depot and may be
 * bought again by anyone.'"
 *
 * AND THAT IS A LORE ERROR I INTRODUCED AND THEN DEFENDED. #980 cut this line from the rust notice and kept
 * it for the limit one, on the argument that it was "a fact with a rival's decision attached -- a rival can
 * take it this round -- and it is nowhere else on screen". The decision it described does not exist: 1830
 * removes an over-limit discard from the game. So the sentence was not merely surplus, it was telling a
 * president to expect a train back that nobody will ever see again -- and my reason for keeping it was
 * entirely built on the thing that was false.
 *
 * THE FUNCTION GOES WITH IT rather than being left returning `null` for both causes. A predicate with one
 * reachable answer is #788's unreachable arm wearing a return type, and the next reader would take it for a
 * slot waiting to be filled.
 *
 * #896's ARGUMENT SURVIVES ITS LAST SENTENCE. "A blocking modal owes the player a reason it was worth
 * stopping them for" is about the modal, and after #980 the modal is a headline, a line of fact and the
 * trains it took. The interruption defends itself. */


/* ==================================================================
 *  DESIGN NOTE 1003: `noticeGentleRustLine` IS DELETED
 * ==================================================================
 *
 * RULED: "Since the modal now fires upon actual destruction, remove the special 'Gentle rust: You can run
 * these...' explanatory text. Use the standard rust notification copy."
 *
 * AND THE SENTENCE WAS ONLY EVER TRUE OF THE OLD TIMING. It said "you can run these trains one more time
 * before they retire" -- a promise about the future, correct at the moment the trains were MARKED and false
 * at the moment they die. #1002 moves the modal to the second of those, so the line would now be telling a
 * president they may run trains that left the fleet in the dispatch that raised the modal.
 * #980 RECORDED THAT THIS SENTENCE BECAME TRUE FOR THE FIRST TIME under #979, because until then the
 * reprieved train could not reach the route planner at all. It is worth noting that it has been true for
 * exactly two batches and is now unnecessary rather than wrong -- the variant still gives the extra run; the
 * modal simply is no longer the place that announces it.
 *
 * DELETED RATHER THAN LEFT RETURNING `null`, which is #990's rule for `noticeConsequence` and #998's for
 * `dividendStepsExplanation`. Three functions in this feature have now outlived their callers; leaving a
 * fourth as an always-null predicate is how the next reader concludes there is a slot to fill. */


/** The toggle's own label, phrased as the request asked and scoped as narrowly as it actually behaves. */
export function silenceLabel(notice: FleetLossNotice): string {
  return notice.cause === "rust"
    ? `Don't notify me about rust events for ${notice.ticker}`
    : `Don't notify me about train limit drops for ${notice.ticker}`;
}

/** Names one showing of one notice, so a replay cannot re-raise a dismissed one -- see the header.
 *
 *  THE STEP IS THE CAUSE, which is what keeps a dismissed rust notice from also swallowing the limit notice
 *  that arrived in the same phase change. They are two modals in sequence, not one with two paragraphs. */
export function noticeDismissKey(
  turn: OperatingTurnIdentity | null | undefined,
  notice: FleetLossNotice,
): string {
  return turnGuardKey(turn, notice.companyId, `fleetLoss:${notice.cause}`);
}

/** The first notice this corporation should be stopped for, or `null`.
 *
 *  ONE AT A TIME, IN THE ORDER THE RULES FIRED: rust destroys trains, and only then does the trim take what is
 *  still over the limit. A modal showing both at once would have to pick a headline, and the two causes have
 *  different remedies.
 *  SILENCED AND DISMISSED ARE ASKED SEPARATELY because they mean different things -- one is a standing player
 *  preference, the other is "you have already seen this". Collapsing them would make silencing a notice
 *  retroactively mark it seen, which matters the moment the player switches it back on. */
export function nextDueNotice(
  queued: readonly FleetLossNotice[],
  turn: OperatingTurnIdentity | null | undefined,
  isSilenced: (notice: FleetLossNotice) => boolean,
  dismissed: ReadonlySet<string>,
): FleetLossNotice | null {
  for (const notice of queued) {
    if (isSilenced(notice)) continue;
    if (dismissed.has(noticeDismissKey(turn, notice))) continue;
    return notice;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The silence toggles -- design note #896a                            */
/* ------------------------------------------------------------------ */

/* SCOPED TO THE ROOM, AND THAT IS THE WHOLE REASON THIS IS NOT `localStorage`.
   The request said "localStorage or component state ... so they persist for the current session", and those
   three are three different lifetimes. Component state dies on refresh, which loses a preference the player
   set thirty seconds ago. `localStorage` outlives the GAME -- and because the toggle is keyed per corporation,
   and 1830's corporations are the same eight every time, a rust notice silenced for PRR in one game would
   silence PRR in a different game a month later, with nothing on screen explaining why. `Lobby.tsx` already
   worried about exactly this shape for rooms and chose `sessionStorage` for it.
   So: `sessionStorage`, keyed by ROOM. That is "the current session" read literally, and it is the only one of
   the three that cannot leak into a game the player has not started yet.
   THE IN-MEMORY MAP IS THE TRUTH and storage is the mirror, which `TutorialModal`'s wrapper does not do
   because it had no need to: there, a throw means the tutorial shows again, and showing is the safe direction.
   Here a throw would mean a toggle the player just set silently doing nothing, so the Map answers first and
   private browsing costs persistence rather than the feature. */

const SILENCE_PREFIX = "1830juno.fleet_loss_silence.v1.";

const memory = new Map<string, boolean>();

function storageKey(roomCode: string | null, companyId: number, cause: FleetLossCause): string {
  // A null room is a local game with no code; it still gets a stable key so the toggle works within the tab.
  return `${SILENCE_PREFIX}${roomCode ?? "local"}.${companyId}.${cause}`;
}

/** Whether this corporation's notices of this cause are switched off. */
export function isNoticeSilenced(
  roomCode: string | null,
  companyId: number,
  cause: FleetLossCause,
): boolean {
  const key = storageKey(roomCode, companyId, cause);
  const remembered = memory.get(key);
  if (remembered !== undefined) return remembered;
  try {
    const stored = window.sessionStorage.getItem(key) === "1";
    memory.set(key, stored);
    return stored;
  } catch {
    /* Storage disabled, or no `window` at all. Not silenced is the safe direction: the player is told
       something true rather than quietly not told it. */
    return false;
  }
}

/** Set or clear the toggle. The Map is written first so the answer is right even when storage refuses. */
export function setNoticeSilenced(
  roomCode: string | null,
  companyId: number,
  cause: FleetLossCause,
  silenced: boolean,
): void {
  const key = storageKey(roomCode, companyId, cause);
  memory.set(key, silenced);
  try {
    if (silenced) window.sessionStorage.setItem(key, "1");
    else window.sessionStorage.removeItem(key);
  } catch {
    /* see `isNoticeSilenced` -- losing persistence is acceptable, losing the toggle is not. */
  }
}

/** Test seam: drops the in-memory mirror so a case can start from a known state.
 *  Exported rather than reached around because a test that pokes at module internals stops testing the
 *  module's own contract, which is the thing that has to keep working. */
export function resetNoticeSilenceCache(): void {
  memory.clear();
}
