// frontend/src/utils/actionLog.ts
//
// Turns a dispatched ExecuteMsg into a line a player can read.
//
// The label is DERIVED from the message and the state it acted on, never passed
// in: hand-written labels at each call site named the contract's variants, leaked
// the backend, and never said WHO acted -- which made the log a list of verbs.
//
// `gameState` is the BEFORE state, the only one every caller has at dispatch
// time; `afterState` is the resolved one where a synchronous reducer offers it.
// Each figure takes the side it belongs to -- see #2.
//
// See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #0, #1

import type { GameStateResponse } from "./gameState";
import { dividendSplit } from "./dividendSplit";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { TileColorTier } from "../components/hexTileCatalog";
import { boardHexLabel } from "../components/hexGeometry";
import type { OperatingSubPhase } from "../components/OperatingSubPhaseStepper";
import { depotInventory } from "./gamePhase";
import { hasActedThisTurn } from "./turnAction";
import { sandboxRouteBreakdown } from "./sandboxSession";
import { stationTokenPrice } from "./stationTokens";

export interface ActionLogContext {
  /** The board and room as they stand BEFORE this action -- design note #1. */
  gameState: GameStateResponse | null;
  /* AFTER for where things stand now (depot stock, a balance); BEFORE for facts about the action (what it cost, who acted). undefined on a live chain, where the before-derived phrasing stands.
     See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #2 */
  afterState?: GameStateResponse | null;
  mapGrid: MapGridResponse;
  era: TileColorTier;
  /** Renders a wallet as a readable name. */
  labelForAddress: (address: string) => string;
  /** Current market price by `company_id`, for the dividend line's
   *  before/after. `undefined` when the chart is not available, and the line
   *  then omits the price move rather than inventing one. */
  marketPrices?: Readonly<Record<number, number | undefined>>;
  /* `projectPrice` REMOVED by design note #775, and #434's warning is why it is worth recording rather than
     just deleting. That note fixed this callback to step from the CELL because a price-keyed search "quoted a
     destination the token never reached" -- the right fix to the wrong question. The sentence should not have
     been projecting a destination at all: `Market Move` reports the one the atom actually reached. A
     projection is the correct tool for a PREVIEW, where the player has not yet chosen; it is never the
     correct tool for a record of something that already happened. */
  /* An OR is corporation-driven, so the line names the CORPORATION and the step it declined. The step is not on GameStateResponse, so it is passed in and stays optional.
     See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #478 */
  orSubPhase?: OperatingSubPhase | null;
  /** ==================================================================
   *   DESIGN NOTE 1054: THE MOVE THE MARKET ATOM ACTUALLY MADE
   *  ==================================================================
   *
   * REPORTED: "the two Dividends entries can be combined into: 'B&O paid dividends on $X:.... B&O's share
   * price rose from $90 to $100.'"
   *
   * AND #775 IS THE REASON THIS IS A PARAMETER RATHER THAN A CALCULATION. That note deleted a price clause
   * from this very sentence because it "quoted the destination of a SECOND move that never happened" -- the
   * branch read the current price and projected a step from it, after the atom had already stepped. Its
   * conclusion was that `Market Move` should own the answer, "the authority's report of what it did, not a
   * second opinion about what it should do."
   *
   * SO THE AUTHORITY'S REPORT IS HANDED IN. `applySandboxMarketAction` returns `moved`, the shell has it
   * before this sentence is composed, and passing it here folds two lines into one WITHOUT reintroducing the
   * projection #775 removed. The figures are the atom's own; this branch only puts them in a clause.
   *
   * OPTIONAL, AND ABSENT MEANS NO MOVE. A clamped token at the edge of the chart moves nothing and gets no
   * clause -- which is exactly what #775 recorded as the accepted cost of deleting the old one. */
  marketMove?: { from: number; to: number; reason: "payout" | "withhold" | "sale" } | null;
  /** Design note #1070: why the shell skipped a step, when it skipped one on the player's behalf. */
  skipReason?: string | null;
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six"] as const;

/** "two 3-trains", "one 3-train". Small counts read better as words in a
 *  sentence, and every count this log reports is small by construction --
 *  the depot never holds more than six of a tier. */
export function countPhrase(count: number, singular: string): string {
  const word = count < NUMBER_WORDS.length ? NUMBER_WORDS[count] : String(count);
  return `${word} ${singular}${count === 1 ? "" : "s"}`;
}

/** A corporation's ticker, or a readable stand-in. Never a bare id: "#4 laid
 *  a tile" is the same failure as naming the message. */
function corp(state: GameStateResponse | null, companyId: number): string {
  return (
    state?.public_companies.find((entry) => entry.company_id === companyId)?.ticker ??
    `Corporation #${companyId}`
  );
}

/** Whoever the room says is acting right now -- the actor for every
 *  player-driven message, none of which carry an address of their own. */
function actingPlayer(context: ActionLogContext): string {
  const state = context.gameState;
  const address = state?.player_addresses[state.active_player_index];
  return address ? context.labelForAddress(address) : "A player";
}

/** Whoever is acting, as the round defines it. Exported because App.tsx needs the same answer when recording what an Undo would revert.
 *  See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #478 */
export function actingActor(context: ActionLogContext): string {
  const state = context.gameState;
  if (state?.current_round_type === "OperatingRound") {
    const companyId = state.active_operating_order[state.active_corporation_index];
    if (companyId !== undefined) return corp(state, companyId);
  }
  return actingPlayer(context);
}

/* ==================================================================
    DESIGN NOTE 958: `stepName` IS GONE, AND `orSubPhase` IS NOT
   ==================================================================
   #478 built this to put the step in the sentence -- "the strip's own `stepLabel`, so the log and the stepper
   cannot describe the same step differently." Its two callers now say "passed." and let the tag carry the
   step, so the helper had no reader left. Removed rather than kept warm: a function nothing calls is a
   standing invitation to put the duplication back.
   `orSubPhase` STAYS ON THE CONTEXT and is still read -- the pass line asks whether the cursor is on a step
   at all, to choose between "passed." and "passed its turn." The field carries a fact this file still needs;
   only the formatting of that fact moved.
   AND THE STEPPER'S LABELS ARE STILL THE ONE SOURCE. `roundStampFor` reads `OPERATING_SUB_PHASE_LABELS`
   itself, so #478's actual rule -- one table, so the log and the strip cannot disagree -- survives the move
   intact; what changed is which file does the reading. */

/** " Treasury $A → $B." for a corporation that just spent, or "" when the resolved state is not available
 *  (a live chain -- design note #2).
 *
 *  ==================================================================
 *   DESIGN NOTE 1053: THE MOVEMENT, NOT THE DESTINATION
 *  ==================================================================
 *
 *  REPORTED, of a station placement: two lines where one would do --
 *      "B&O placed a station on J14 for $40. Treasury now $880."
 *      "Treasury — B&O spent $40 — treasury $920 → $880."
 *  -- "can be condensed into one log: 'B&O placed a station on J14 for $40. Treasury $920 → $880.'"
 *
 *  AND THE SECOND LINE IS NOT A DUPLICATE OF THE FIRST BY ACCIDENT. #750 prints it by reading the treasury
 *  DIFF rather than trusting any arm to declare what it charged, on the stated grounds that "an arm that
 *  reports its own arithmetic will happily report a bug". That is a real safeguard and it stays -- see
 *  `App.tsx` #1053 for how it now stays silent when the action line has already said the same thing, and
 *  stays loud when it has not.
 *
 *  WHAT THIS SUFFIX GIVES UP IS NOTHING. "Treasury now $880" is the destination; the diff line was carrying
 *  the origin. Printing both figures here is what makes the second line redundant rather than merely noisy --
 *  and it is the same before/after form #670 settled for the dividend report and #682 for the Stock Round's
 *  projection. One shape for money moving, everywhere.
 *
 *  BOTH STATES OR NEITHER. `gameState` is the BEFORE state on this context (the station price is read off it
 *  one branch below) and `afterState` is the settled one. With either missing there is no movement to state,
 *  so the suffix is empty rather than half-printed -- #562's rule that a missing figure and a real one are
 *  different facts, applied to a pair. */
/* ==================================================================
    DESIGN NOTE 1146: A BALANCE PRINTED AFTER AN ACTION READS AS A CONSEQUENCE OF IT
   ==================================================================
   REPORTED: "the log is printing statements like 'PRR laid Tile #57 on H10. Treasury now $1000.' If an action
   results in no change to a corporation's treasury, the treasury amount does not need to print. It falsely
   implies the treasury was affected."

   AND THE IMPLICATION IS THE WHOLE PROBLEM, because most tile lays are free. A reader who sees a figure at the
   end of a sentence about an action reasonably takes the two to be related -- so the one form of this line
   that was meant to be NEUTRAL is the form that misinforms, and it is also the form that prints most often.

   #1066 SAW THIS FROM THE OTHER SIDE AND IS WHAT MAKES THE FIX OBVIOUS. It observed that "Treasury now $920 --
   a balance -- invites no question. A TRANSITION invites one immediately", and used that to argue for showing
   the movement. The same observation says what to do when there is no movement: a balance that invites no
   question is not worth a clause, and printing it where nothing happened is the only case where it can
   actively mislead.

   SO THE LINE IS NOW EXACTLY THE MOVEMENT AND NOTHING ELSE. Silent when the figure did not move, and silent
   when there is no BEFORE to compare against -- which is `describeTreasuryMoves`' own rule, stated there as
   "a corporation that did not exist before has no MOVE to report; its opening balance is not a change". The
   two authorities on this figure now answer the question identically, which is #891's fault closed off rather
   than left open.
   NOTHING IS LOST TO THE DIAGNOSTIC. #750's separate line reads the DIFF and already skips `from === to`, so
   a suppressed clause here can never be the only record of a movement -- there is no movement. */
function treasurySuffix(context: ActionLogContext, companyId: number): string {
  const before = treasuryIn(context.gameState, companyId);
  const after = treasuryIn(context.afterState, companyId);
  if (after === undefined || before === undefined || before === after) return "";
  return ` Treasury $${before} → $${after}.`;
}

function treasuryIn(
  state: ActionLogContext["afterState"],
  companyId: number,
): string | undefined {
  return state?.public_companies.find((entry) => entry.company_id === companyId)?.treasury;
}

/** Whether this action actually charged the corporation anything.
 *
 *  ==================================================================
 *   DESIGN NOTE 1066: THE FIGURE MOVED, AND THE SENTENCE DID NOT SAY WHY
 *  ==================================================================
 *
 *  REPORTED of a tile lay: "It should say WHY the treasury was affected: B&O laid Tile #57 on J14 and paid
 *  the terrain cost."
 *
 *  AND #1053 IS WHAT MADE THE QUESTION ASKABLE. Before it the line said "Treasury now $920" -- a balance,
 *  which invites no question. A TRANSITION invites one immediately: money left, and the sentence named a tile
 *  lay, which is free on most hexes.
 *
 *  ASKED OF THE DIFF, NOT OF THE FEE TABLE. `terrainFeeDue` would need the board's own `terrainBuildFeeAt`
 *  threaded onto this context, and it would be a SECOND opinion about what was charged -- exactly what #750
 *  refuses to trust ("an arm that reports its own arithmetic will happily report a bug"). Nothing else moves
 *  a treasury on a `LayTile`, so a movement IS the fee, and the amount is already in the transition. */
function chargedSomething(context: ActionLogContext, companyId: number): boolean {
  const before = treasuryIn(context.gameState, companyId);
  const after = treasuryIn(context.afterState, companyId);
  return before !== undefined && after !== undefined && before !== after;
}

/** The train purchase, as short as a corner toast wants it.
 *
 *  ==================================================================
 *   DESIGN NOTE 1063: A SECOND RENDERING, NOT A SECOND SOURCE
 *  ==================================================================
 *
 *  SPECIFIED: "The toast should simply read: `[Corporation] bought a [Tier]-train. Depot: [X] remaining.`"
 *  The Activity Log's line is longer -- it carries the price and the treasury movement -- so the toast can no
 *  longer be the log's string, which is what it has been since #794.
 *
 *  AND #794's RULE IS ABOUT SNAPSHOTS, NOT ABOUT LENGTH, which is what makes this safe. Its report was a
 *  toast that said "$5 per share" beside a log that said the right figure, and its diagnosis was two
 *  SNAPSHOTS: "the toast used to fire from the label derived at DISPATCH time; the Activity Log's line is
 *  rebuilt in the drain from the state the action actually applied to." Its fix was to raise the toast from
 *  the rebuilt label. Two sentences of different lengths built in one function from one `context` cannot
 *  reproduce that, because there is only one snapshot in the room.
 *
 *  SO IT LIVES HERE, BESIDE THE SENTENCE IT SHORTENS, rather than in the shell. A caller composing its own
 *  short version would be a second place that decides how a depot count is worded, which is #891's shape --
 *  and `batch52` asserts the two agree about the tier and the remaining count.
 *
 *  `null` FOR ANYTHING ELSE, so the caller falls back to the full label rather than showing an empty toast. */
export function trainPurchaseToastLine(
  msg: GameplayExecuteMsg,
  context: ActionLogContext,
): string | null {
  if (!("BuyHardwareFromPool" in msg) && !("EmergencyBuyHardware" in msg)) return null;
  const protocolId =
    "BuyHardwareFromPool" in msg
      ? msg.BuyHardwareFromPool.protocol_id
      : msg.EmergencyBuyHardware.protocol_id;
  // The same `find` the long sentence makes: the depot sells cheapest-first, so the tier bought is the first
  // row with stock BEFORE the purchase.
  const tier = context.gameState
    ? depotInventory(context.gameState).find((row) => row.remaining === null || row.remaining > 0)
    : undefined;
  if (!tier) return null;
  const settled = context.afterState
    ? depotInventory(context.afterState).find((row) => row.tier === tier.tier)
    : undefined;
  const left = settled ? settled.remaining : Math.max(0, (tier.remaining ?? 1) - 1);
  /* `unlimited` FOR THE DIESELS, matching the long line. "Depot: null remaining" is the failure #232 keeps
     naming, and the D-train genuinely has no count to give. */
  /* ==================================================================
      DESIGN NOTE 1147: THE TOAST FIRES WHEN THE CLOCK IS NEARLY OUT, NOT ON EVERY TICK
     ==================================================================
     REPORTED: "the train-buying toasts are lasting too long and firing too often ... only fire these toasts
     when the Depot has 2 or fewer available trains."

     #1063 WIDENED THIS TOAST TO EVERY SEAT and the argument was about the END of a tier, not the middle of
     one: "a depot train leaving is the phase clock, every player is counting it, and a rival buying the last
     4-train changes what everybody else should do next." Six 4-trains means six toasts, and five of them say
     the clock is still running -- which is the thing nobody needs telling. The sixth is the one that matters.
     SO THE RULE IS THE NOTE'S OWN REASONING, APPLIED. Silent while the tier has depth; audible for the last
     two, which is the window in which a rival's purchase actually changes anybody's plan.
     THE TIER'S COUNT, NOT THE WHOLE DEPOT'S. It is the number this very sentence prints, it is what the phase
     change is keyed on, and a total across every tier would stay above two until the endgame -- silencing the
     toast through every phase change in the game except the last.
     `unlimited` IS NEVER FEWER THAN TWO. The diesels have no count to run down and no phase beyond them, so
     there is no clock for this toast to be reporting. */
  if (left === null || left > 2) return null;
  const remaining = `${left}`;
  /* ==================================================================
      DESIGN NOTE 1072: THE TOAST IS ABOUT THE DEPOT, NOT ABOUT THE BUYER
     ==================================================================
     REPORTED: "the toast notification should just be for the Depot Supply, so it doesn't need to say which
     corporation bought a train (players will already know whose turn it is)."
     AND THAT IS THE ARGUMENT FOR WIDENING IT IN THE FIRST PLACE. #1063 broadcast this to every seat because
     a depot train leaving is the phase clock -- everybody is counting them. The corporation's name is the
     part of the sentence that belongs to the TURN, which is already on screen in the action bar and the
     operating queue; the count is the part that belongs to the table.
     THE ACTIVITY LOG STILL NAMES THE BUYER, and that is the division: the log is the record you scroll back
     through, where "who" is the first thing you need; the toast is a glance at a number going down. */
  /* ==================================================================
      DESIGN NOTE 1147 REVERSES #1072 ON THE BUYER'S NAME, AND SAYS WHY
     ==================================================================
     #1072 REMOVED IT, on this reasoning: "the toast notification should just be for the Depot Supply, so it
     doesn't need to say which corporation bought a train (players will already know whose turn it is)." That
     was right for the toast it was describing -- one that fired on EVERY depot purchase, where the name was
     the predictable half of a sentence a player was about to see six more of.
     THE RULE ABOVE CHANGES WHAT THIS SENTENCE IS. It now fires two or three times a game, at the moments the
     phase clock is about to turn over, and at those moments WHO bought is no longer the incidental half: the
     corporation that takes the second-to-last 4-train is the one that will be operating with a train the
     others may not get, and a player reading a corner toast is not necessarily looking at the operating
     queue. A rare sentence can afford the word that a frequent one could not.
     REQUESTED IN THOSE TERMS -- "update the text to explicitly state which corporation bought the train" --
     and recorded as a reversal rather than folded in silently, because the earlier reasoning was sound and a
     future reader deserves to know which premise expired rather than concluding the note was ignored. */
  const ticker =
    context.gameState?.public_companies.find((entry) => entry.company_id === protocolId)?.ticker ??
    null;
  const buyer = ticker === null ? "A corporation" : ticker;
  return `${buyer} bought a ${tier.tier}-train. Depot: ${remaining} remaining.`;
}

/** Whether this message's own sentence already states the corporation's treasury movement.
 *
 *  ==================================================================
 *   DESIGN NOTE 1053: WHO GETS TO SAY THE TREASURY MOVED
 *  ==================================================================
 *
 *  #750 PRINTS A SEPARATE LINE FOR EVERY TREASURY MOVEMENT and the reason is a good one: it reads the DIFF
 *  rather than trusting any arm to declare what it charged, because "an arm that reports its own arithmetic
 *  will happily report a bug". Reported against it, three times in one log: for a tile lay, a station
 *  placement and a train purchase, the line said exactly what the sentence above it had just said.
 *
 *  SO THE DIAGNOSTIC KEEPS ITS JOB AND LOSES ITS ECHO. The line is suppressed only where the sentence has
 *  already carried the figures -- and the UNEXPLAINED variant is never suppressed, because a movement on a
 *  message with no business moving a treasury is the line #750 exists for and no sentence will mention it.
 *
 *  NOT EVERY TREASURY MOVER STATES ITS OWN. `TREASURY_MOVERS` in `treasuryProvenance.ts` also lists
 *  `DeclareDividends`, `BuyStock`, `PassTurn` and `OpenStockRound` -- a float capitalising a corporation and
 *  an Operating Round opening pay treasuries through sentences that say nothing about a balance. Those keep
 *  the #750 line, which is their only record.
 *
 *  THIS LIST MUST MATCH `treasurySuffix`'s CALLERS, which is #891's shape waiting to happen: two places
 *  deciding one thing. It is asserted rather than remembered -- `batch51.test.ts` counts the call sites in
 *  this file and compares them with the arms below, so adding a suffix without adding an arm goes red. */
export function sentenceStatesTreasury(msg: GameplayExecuteMsg): boolean {
  return (
    "LayTile" in msg ||
    "PlaceStationToken" in msg ||
    "BuyHardwareFromPool" in msg ||
    "EmergencyBuyHardware" in msg
  );
}

/** A skip reason with its pronoun removed, so a ticker can take the subject position.
 *
 *  ==================================================================
 *   DESIGN NOTE 1070: ONE SET OF REASONS, TWO SENTENCE SHAPES
 *  ==================================================================
 *
 *  `earnableRevenue.ts` PHRASES ITS VERDICTS TO FOLLOW A DASH -- "it owns no trains, so there is no route to
 *  run" was written for "Skipped Run Routes — it owns no trains...", and the auto-skip caption in the panel
 *  still reads them that way. Dropped straight into "PRR ..." they produce "PRR it owns no trains", which is
 *  the shape a naive interpolation always produces.
 *
 *  THE PRONOUN IS TRANSFORMED RATHER THAN THE REASONS BEING DUPLICATED. A second copy of the three sentences
 *  phrased for this sentence would be #891's shape in copy: two wordings of one verdict, free to drift, and
 *  the panel and the log would eventually disagree about why a corporation could not run.
 *
 *  BOTH FORMS, because the verdicts use both: "it owns no trains" is nominative and "its trains cannot reach"
 *  is possessive, so the ticker takes an apostrophe in the second case and not in the first. Anything that
 *  does not start with either is passed through untouched -- a reason written in some third shape says what
 *  it says, and mangling it to fit would be worse than leaving it.
 *
 *  IT BUILDS THE WHOLE SENTENCE rather than returning a fragment to interpolate. A first draft returned the
 *  reason with its pronoun stripped and left the caller to write `${ticker} ${fragment}` -- which gives
 *  "PRR 's trains cannot reach" for the possessive form, because the apostrophe has to touch the ticker and a
 *  template literal cannot know that. Owning both halves is the only way the join can be right for both. */
function subjectSentence(ticker: string, reason: string): string {
  if (reason.startsWith("its ")) return `${ticker}'s ${reason.slice(4)}.`;
  if (reason.startsWith("it ")) return `${ticker} ${reason.slice(3)}.`;
  return `${ticker} ${reason}.`;
}

function hexName(mapGrid: MapGridResponse, q: number, r: number): string {
  void mapGrid;
  return boardHexLabel(q, r) ?? `(${q}, ${r})`;
}

/** null rather than a generic fallback: the caller keeps its own label, and a sentence saying less than the variant name is a downgrade dressed as an improvement.
 *  See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #0 */
export function describeGameplayAction(
  msg: GameplayExecuteMsg,
  context: ActionLogContext,
): string | null {
  const { gameState, mapGrid, era } = context;

  /* ---- Operating Round: the corporation acts. ---- */

  if ("LayTile" in msg) {
    const { protocol_id, tile_id, q, r } = msg.LayTile;
    return (
      `${corp(gameState, protocol_id)} laid Tile #${tile_id} on ${hexName(mapGrid, q, r)}` +
      /* Design note #1066: named only when something was actually charged. Most hexes are free, and a
         sentence that mentioned a terrain cost on every lay would be wrong far more often than right. */
      (chargedSomething(context, protocol_id) ? " and paid the terrain cost." : ".") +
      treasurySuffix(context, protocol_id)
    );
  }

  if ("PlaceStationToken" in msg) {
    const { protocol_id, q, r } = msg.PlaceStationToken;
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === protocol_id,
    );
    // Design note #1: priced from the BEFORE state, so this is what the
    // token about to be placed costs -- not what the next one will.
    const cost = stationTokenPrice(company?.station_token_hexes.length ?? 0);
    return (
      `${corp(gameState, protocol_id)} placed a station on ${hexName(mapGrid, q, r)} for $${cost}.` +
      treasurySuffix(context, protocol_id)
    );
  }

  /* ==================================================================
      DESIGN NOTE 968: THE TURN'S ROUTES, IN ONE SENTENCE
     ==================================================================
     The dispatch is one message now, so the log gets one line for it. It names each route's track the way
     the per-route line did -- that is still the thing only this entry can say -- and totals the printed
     value, which is what the turn actually ran before the die.
     THE DIE IS NOT MENTIONED HERE, for #941's reason: the modifier is a fact about the TURN and is stated
     once, by `turnRevenueSentence`, from the shell. This line is the record of which track was run. */
  if ("RunMultipleRoutes" in msg) {
    const { protocol_id, routes, trains } = msg.RunMultipleRoutes;
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === protocol_id,
    );
    /* ==================================================================
        DESIGN NOTE 1020: THE TRAIN THAT RAN, NOT THE BIGGEST ONE OWNED
       ==================================================================
       REPORTED: a $200 run "incorrectly labeled ... as the D-train's run", when the 5-train had run it.

       THIS WAS A GUESS AND READ AS A FACT. The line was
         `const train = (company?.owned_trains ?? []).slice().sort().pop();`
       -- the corporation's largest owned train, attached to whatever ran. With a 5-train and a D-train in the
       fleet the sentence could only ever say "D", however many trains ran and whichever of them did. It also
       could not name more than one, so a two-train turn had to hedge as "trains up to a D".

       THE MESSAGE CARRIES THE ANSWER NOW (#1020 on `RunMultipleRoutes.trains`), so the narration reads it
       instead of inferring it. Each leg is priced and named individually, which is what the report asked for:
       the whole array preserved, each train against its own figure.

       THE OLD GUESS SURVIVES ONLY AS THE FALLBACK, for actions logged before the field existed -- #232's
       rule, and this log is replayed from history. It is marked as an inference in that case by saying "up
       to", which is the one honest thing that sentence was doing. */
    const legs = routes.map((path, at) => {
      const stops = path
        .map((stop) => stop.hex)
        .filter((hex, index, all) => all.indexOf(hex) === index);
      return {
        train: trains?.[at] ?? null,
        value: sandboxRouteBreakdown(mapGrid, path, era).revenue,
        stops: stops.join(" -> "),
      };
    });
    const total = legs.reduce((sum, leg) => sum + leg.value, 0);
    /** The pre-#1020 inference, used only when the log did not record the trains. */
    const largestOwned = (company?.owned_trains ?? []).slice().sort().pop();

    /* ONE ROUTE READS AS ONE ROUTE. A corporation with a single train is the common case for most of a game,
       and "ran 1 route" would be a worse sentence than the one this replaces. */
    if (legs.length === 1) {
      const only = legs[0];
      const named = only.train ?? largestOwned;
      return (
        `${corp(gameState, protocol_id)} ran a $${only.value} route` +
        (named ? ` with ${only.train ? "its" : "a"} ${named}-train` : "") +
        ` through ${only.stops}.`
      );
    }
    /* EVERY TRAIN AND EVERY FIGURE, which is the report's own request: "$200 for the 5-train, $440 for the
       D-train" is the sentence a player can reconcile against their chips, and one aggregate never was. */
    if (legs.every((leg) => leg.train !== null)) {
      return (
        `${corp(gameState, protocol_id)} ran ${legs.length} routes for $${total}: ` +
        legs
          .map((leg) => `${leg.train}-train $${leg.value} (${leg.stops})`)
          .join("; ") +
        "."
      );
    }
    return (
      `${corp(gameState, protocol_id)} ran ${legs.length} routes for $${total}` +
      (largestOwned ? ` with trains up to a ${largestOwned}` : "") +
      `: ${legs.map((leg) => leg.stops).join("; ")}.`
    );
  }

  if ("RunManualRoute" in msg) {
    const { protocol_id, path } = msg.RunManualRoute;
    const breakdown = sandboxRouteBreakdown(mapGrid, path, era);
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === protocol_id,
    );
    // The biggest train it owns is the one a route is run with -- the same
    // derivation the route builder defaults to.
    const train = (company?.owned_trains ?? []).slice().sort().pop();
    const stops = path
      .map((stop) => stop.hex)
      .filter((hex, index, all) => all.indexOf(hex) === index);

    /* ==================================================================
     *  DESIGN NOTE 941: THIS LINE NAMES THE TRACK; THE TURN'S LINE NAMES THE MONEY
     * ==================================================================
     *
     * #939 PUT THE VARIANT'S THREE SENTENCES HERE, and that was right while the die was rolled per route.
     * The die is now rolled once per TURN (#941), so a four-train corporation would have printed four bonus
     * sentences about one roll -- the reported complaint in a second currency.
     * SO THIS ARM GOES BACK TO BEING FACTUAL and says the only thing it is uniquely placed to say: which
     * track this train ran, and what that track prints. `turnRevenueSentence` carries the modifier, once,
     * from the shell -- which is the only place that can see the end of the dispatch loop.
     * THE FIGURE IS THE PRINTED ONE, deliberately, and it is not a return to #935's bug. That note found the
     * log quoting a printed figure while the reducer banked a modified one FOR THE SAME QUANTITY. These are
     * two different quantities now: this sentence is about one route, the turn's sentence is about the sum.
     * A route's printed value is a fact about the board and is not modified by anything. */
    return (
      `${corp(gameState, protocol_id)} ran a $${breakdown.revenue} route` +
      (train ? ` with a ${train}-train` : "") +
      ` through ${stops.join(" -> ")}.`
    );
  }

  if ("DeclareDividends" in msg) {
    const { protocol_id, revenue_amount, distribute } = msg.DeclareDividends;
    const ticker = corp(gameState, protocol_id);

    /* ==================================================================
     *  DESIGN NOTE 775: THIS SENTENCE REPORTS; IT NO LONGER RECOMPUTES
     * ==================================================================
     *
     * THE PRICE CLAUSE IS GONE, and it was the reported bug. It read the corporation's CURRENT price and
     * then projected a dividend step from it -- but by the time this line is built the market atom has
     * already made that step, so the sentence quoted the destination of a SECOND move that never happened.
     * The log showed it exactly: `Market Move — C&O fell from $82 to $76` beside `C&O withheld $0 ... Share
     * price moved from $76 to $71`. $76 is where the token had just landed.
     *
     * ONE QUESTION, ONE ANSWER, AND `Market Move` IS IT. #435 built that line from
     * `applySandboxMarketAction`'s own `moved` result -- the authority's report of what it did, not a second
     * opinion about what it should do -- and it is the line that came out right in every log. Confirmed by
     * the report: "The Market Move log is the correct movement for the corporation's share price."
     *
     * WHAT IS LOST, STATED PLAINLY: the "Share price held at $X" case, for a token already at the edge of
     * the chart. `Market Move` is silent when nothing moves, so a clamped step now goes unremarked. That is
     * a rare, visible-on-the-chart situation, and it is a much smaller cost than a sentence that regularly
     * names a price the token never reached.
     *
     * THE SPLIT COMES FROM `dividendSplit` for the same reason: the payout toast was reporting double what
     * was actually paid, because this branch re-derived the revenue and re-split it from its own snapshot
     * while the reducer split it from the state the action applied to. Now both read one calculation. */
    const settlement = dividendSplit(gameState, protocol_id, revenue_amount, distribute);
    const revenue = settlement?.revenue ?? 0;

    /* ==================================================================
     *  DESIGN NOTE 1054: THE PRICE MOVE JOINS THE SENTENCE THAT CAUSED IT
     * ==================================================================
     * The atom's own figures, handed in rather than derived -- see `marketMove` on the context for why that
     * distinction is the whole of #775. Silent when nothing moved, and silent for a share sale, which is a
     * different action with a line of its own. */
    const move =
      context.marketMove && context.marketMove.reason !== "sale"
        ? ` Its share price ${context.marketMove.reason === "payout" ? "rose" : "fell"} from ` +
          `$${context.marketMove.from} to $${context.marketMove.to}.`
        : "";

    if (!distribute) {
      /* ==================================================================
       *  DESIGN NOTE 1054: "WITHHELD $0" DESCRIBES A CHOICE NOBODY MADE
       * ==================================================================
       * REPORTED: "the Dividends log needs to be one line: 'B&O did not run any routes. Its share price fell
       * from $100 to $90.' This version is player-facing, and players do not select 'Withhold $0,' so saying
       * that their corporation did is potentially confusing, even if that's how the reducer and backend will
       * need to process it."
       * AND THE DISTINCTION IS EXACTLY THE ONE #292 DREW FROM THE OTHER SIDE: "a trainless corporation
       * DECLARES $0 withheld rather than skipping; 1830 has no third option". That is a statement about the
       * MESSAGE, and it is still true -- the declaration is what steps the marker left, and removing it would
       * break the round. What was wrong is that the log repeated the reducer's vocabulary to a player who
       * never saw a Withhold button, and then said the price moved in a separate line as if by coincidence.
       * ZERO IS THE DISCRIMINATOR, and it is exact rather than convenient: a corporation that ran anything at
       * all withheld a real figure, and one that ran nothing is the only way to reach $0 here. */
      return revenue === 0
        ? `${ticker} did not run any routes.${move}`
        : `${ticker} withheld $${revenue} into its treasury.${move}`;
    }

    /* Sorted for READING only -- largest holding first. The amounts are the reducer's own, so the order
       here cannot change what anybody is paid. */
    const split = [...(settlement?.players ?? [])]
      .sort((a, b) => b.amount - a.amount)
      .map((share) => `$${share.amount} to ${context.labelForAddress(share.player)}`);
    return (
      `${ticker} paid dividends on $${revenue}` +
      (split.length > 0 ? `: ${split.join(", ")}.` : " — no shareholders on record.") +
      move
    );
  }

  if ("BuyHardwareFromPool" in msg || "EmergencyBuyHardware" in msg) {
    const protocolId =
      "BuyHardwareFromPool" in msg
        ? msg.BuyHardwareFromPool.protocol_id
        : msg.EmergencyBuyHardware.protocol_id;
    // The depot sells cheapest-first, so the tier bought is the first row
    // with stock BEFORE the purchase -- the same `find` the panel makes.
    const tier = depotInventory(gameState).find(
      (row) => row.remaining === null || row.remaining > 0,
    );
    if (!tier) return `${corp(gameState, protocolId)} tried to buy a train from an empty depot.`;

    /* Supply is an after-figure and price is a before-figure, in one sentence. Reading the resolved state means the log cannot disagree with the depot panel.
       See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #2 */
    const settled = context.afterState
      ? depotInventory(context.afterState).find((row) => row.tier === tier.tier)
      : undefined;
    const left = settled ? settled.remaining : Math.max(0, (tier.remaining ?? 1) - 1);
    const remaining = left === null ? "unlimited" : `${left}/${tier.total}`;
    /* ==================================================================
        DESIGN NOTE 1053: THIS BRANCH HAD ITS OWN COPY OF THE SUFFIX
       ==================================================================
       IT READ `afterState` AND BUILT `Treasury now $X` INLINE -- the same four lines `treasurySuffix` is,
       written out again. So when that helper became a TRANSITION the train purchase silently kept printing a
       destination, and the reported duplicate (`B&O bought a 2-train ... Treasury now $800` beside
       `Treasury — B&O spent $80 — treasury $880 → $800`) would have survived the fix that removed it
       everywhere else.
       FOUND BY THE ANTI-DRIFT CASE rather than by reading: `batch51` counts `sentenceStatesTreasury`'s arms
       against this file's `treasurySuffix` call sites, and the two disagreed 4 to 2. That case was written to
       catch a future divergence and caught a present one on its first run, which is the argument for pinning
       relationships rather than values. */
    return (
      `${corp(gameState, protocolId)} bought a ${tier.tier}-train for $${tier.cost}. ` +
      `Remaining depot supply: ${remaining}.` +
      treasurySuffix(context, protocolId)
    );
  }

  if ("BuyTrainFromCorporation" in msg) {
    const { buyer_protocol_id, seller_protocol_id, model_type, price } =
      msg.BuyTrainFromCorporation;
    return (
      `${corp(gameState, buyer_protocol_id)} offered $${price} to ` +
      `${corp(gameState, seller_protocol_id)} for a ${model_type}-train.`
    );
  }

  if ("AcceptTrainOffer" in msg) return `${actingPlayer(context)} accepted a train offer.`;
  if ("RejectTrainOffer" in msg) return `${actingPlayer(context)} rejected a train offer.`;
  if ("RescindTrainOffer" in msg) return `${actingPlayer(context)} withdrew a train offer.`;

  /* Privates are named "3. Delaware & Hudson" -- players refer to them by waterfall order as much as by name. One helper, so the log cannot develop two formats.
     See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #361 */
  const namePrivate = (privateId: number): string => {
    const entry = context.gameState?.private_companies.find(
      (row) => row.private_id === privateId,
    );
    return entry ? `${entry.private_id}. ${entry.name}` : `private #${privateId}`;
  };

  if ("BuyPrivateCompany" in msg) {
    const { protocol_id, private_id, price } = msg.BuyPrivateCompany;
    const target = gameState?.private_companies.find(
      (entry) => entry.private_id === private_id,
    );
    const seller = target?.owner ? context.labelForAddress(target.owner) : "its owner";
    return (
      `${corp(gameState, protocol_id)} bought ${namePrivate(private_id)} ` +
      `from ${seller} for $${price}.`
    );
  }

  if ("AdvanceOperatingSubPhase" in msg) {
    /* The one message whose whole content IS which step, and the step was the only part left out. The cursor has not moved at dispatch time.
       See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #478 */
    /* ==================================================================
        DESIGN NOTE 958: THE STEP LEFT THE SENTENCE FOR THE TAG
       ==================================================================
       REPORTED: "instead of, e.g., `[3:06 PM] [OR 2.1] NNH passed Buy Trains.` it would read
       `[3:06 PM] [OR 2.1--Buy Trains] NNH passed.`"
       WHICH RETIRES #478'S SENTENCE, and that note's own reasoning is why the move is safe rather than a
       loss: "The one message whose whole content IS which step, and the step was the only part left out." The
       step is still the whole content -- it has moved to the column where it can be scanned instead of read.
       SAYING IT IN BOTH PLACES WOULD BE THE REGRESSION. "[OR 2.1--Buy Trains] NNH passed Buy Trains." is the
       duplication #775 keeps finding in a new currency, and the tag is the copy that lands in one column. */
    const ticker = corp(gameState, msg.AdvanceOperatingSubPhase.protocol_id);
    /* ==================================================================
        #478'S FALLBACK SURVIVES -- AND MY FIRST REASON FOR KEEPING IT WAS WRONG
       ==================================================================
       I WROTE that with no step in the tag either, "PRR passed." "names nothing at all". CORRECTED: "if it's
       in the context of [OR 2.1--Lay Tracks] then 'PRR passed' DOES tell everyone what happened." That is
       right, and it is right in the fallback case too -- "[OR 2.1] PRR passed." says a corporation passed
       during OR 2.1, which is not nothing.
       THE REASON THAT ACTUALLY HOLDS is narrower and is about the MESSAGE rather than the step. When the
       cursor is known, `PassTurn` and `AdvanceOperatingSubPhase` produce the same sentence -- and they did
       before #958 as well, both reading "PRR passed <step>." (verified against the previous revision). The
       no-cursor branch is the one place the two ever read differently: "skipped a step" is a step boundary
       crossed, "passed its turn" is the turn ending. That distinction costs one ternary and is the whole of
       what this fallback earns.
       RECORDING THE CORRECTION rather than quietly swapping the sentence, because a note that argues for a
       branch on a reason that does not hold is worse than no note -- the next reader would delete the branch
       AND the real reason with it. */
    /* ==================================================================
        DESIGN NOTE 1070: THE SKIP EXPLAINS ITSELF
       ==================================================================
       REPORTED: "'[OR 1.1--Run Routes] PRR passed.' This is maybe technically accurate, but for player-facing
       information it would be useful to state why they (auto-passed), so either: '[Corp] has no trains to
       run' or '[Corp] has no routes to run,' depending on circumstance."
       BOTH SENTENCES ALREADY EXISTED, in `earnableRevenue.ts`, as the reason the shell skips the step at all
       -- and #1057 removed the line that used to print them, on the rule that a step where nothing happened
       earns no line. That rule is untouched: this is the same single line, saying more.
       `skipReason` IS ABSENT WHEN A PLAYER PRESSED SKIP, and the shorter sentence is right there: they chose
       to, and the log has no reason to offer beyond the press. */
    if (context.skipReason) return subjectSentence(ticker, context.skipReason);
    return context.orSubPhase ? `${ticker} passed.` : `${ticker} skipped a step.`;
  }

  /* ---- Stock Round and the auction: the player acts. ---- */

  if ("BuyStock" in msg) {
    /* The price is the one figure a reader cannot reconstruct afterwards. From the message first (par_value travels in the purchase), then the chart. SILENT when unknown -- an invented figure is worse than an omission.
       See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #554 */
    const { protocol_id, source, par_value: parValue } = msg.BuyStock;
    const fromIpo = source === "Ipo";
    const priced = Number(parValue);
    const price =
      fromIpo && Number.isFinite(priced) && priced > 0
        ? priced
        : context.marketPrices?.[protocol_id];
    /* ==================================================================
       DESIGN NOTE 770: THE OPENING PURCHASE IS NOT A 10% SHARE
       ==================================================================
       REPORTED: "When a player first buys a share in a company in the Stock Round, the Activity Log reads:
       'Player bought a 10% share of C&O from the IPO for $100.' This should state that Player bought the 20%
       President's share from the IPO and set par at $x."
       THE LINE WAS WRONG ON ALL THREE COUNTS. The first purchase of an unopened corporation is the President's
       Certificate: 20%, not 10%; bought at TWICE par, so $200 rather than $100 at a par of $100; and it is the
       act that SETS the par, which is the single most consequential decision in a Stock Round and was not
       being recorded at all. A player scrolling back to ask "what did C&O par at" found a line that did not
       say.
       THE OPENING PURCHASE IS IDENTIFIED THE WAY THE REDUCER IDENTIFIES IT -- an untouched IPO and no
       president yet (`trading.rs`: "the first purchase of an unopened corporation is the 20% card at exactly
       twice par"). Read off the state BEFORE the action, which is what `gameState` is here (#1). */
    const target = gameState?.public_companies.find((entry) => entry.company_id === protocol_id);
    const opening =
      fromIpo &&
      !!target &&
      target.president === null &&
      (target.par_value === null || target.par_value === undefined);

    if (opening) {
      const par = Number.isFinite(priced) && priced > 0 ? priced : null;
      /* SILENT ON AN UNKNOWN PAR rather than inventing one -- #554's rule, and the par is precisely the figure
         a reader cannot reconstruct afterwards. */
      const parPhrase = par === null ? "" : `, setting par at $${par}`;
      const paid = par === null ? "" : ` for $${par * 2}`;
      return (
        `${actingPlayer(context)} bought the 20% President's Certificate of ` +
        `${corp(gameState, protocol_id)} from the IPO${paid}${parPhrase}.`
      );
    }

    const cost = typeof price === "number" && price > 0 ? ` for $${price}` : "";
    return (
      `${actingPlayer(context)} bought a 10% share of ${corp(gameState, protocol_id)} ` +
      `from the ${fromIpo ? "IPO" : "bank pool"}${cost}.`
    );
  }

  if ("SellStock" in msg) {
    const { protocol_id, percentage } = msg.SellStock;
    return `${actingPlayer(context)} sold ${percentage}% of ${corp(gameState, protocol_id)}.`;
  }

  if ("WaterfallBuyLowest" in msg) {
    return `${actingPlayer(context)} bought the cheapest private company at face value.`;
  }

  if ("WaterfallBidHigher" in msg) {
    const { private_id, bid_amount } = msg.WaterfallBidHigher;
    /* "private #3" is the contract's identifier and means nothing at the table; the lookup lives in namePrivate so both arms format identically.
       See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #361 */
    return `${actingPlayer(context)} bid $${bid_amount} on ${namePrivate(private_id)}.`;
  }

  if ("WaterfallMiniAuctionRaise" in msg) {
    return `${actingPlayer(context)} raised to $${msg.WaterfallMiniAuctionRaise.bid_amount}.`;
  }

  if ("WaterfallMiniAuctionPass" in msg) {
    return `${actingPlayer(context)} passed in the mini-auction.`;
  }

  if ("WaterfallPass" in msg) return `${actingPlayer(context)} passed.`;
  if ("BidOnPrivate" in msg) {
    return `${actingPlayer(context)} bid $${msg.BidOnPrivate.bid_amount} on a private company.`;
  }

  if ("PassTurn" in msg) {
    /* In an OR, Pass ends the CORPORATION's turn from a step; outside one it really is a seated player passing and the original wording is right.
       See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #478 */
    if (gameState?.current_round_type === "OperatingRound") {
      /* ==================================================================
          DESIGN NOTE 1069: A CORPORATION ENDS ITS TURN; IT DOES NOT PASS A STEP
         ==================================================================
         REPORTED: "At the end of a corporation's turn, it clicks End Turn but the Activity Log prints '[OR
         1.1--Buy Trains] B&O passed.' Let's instead have this say '[OR 1.1] B&O ended its turn.'"
         #958 SPLIT THIS SENTENCE ON THE CURSOR and the split has stopped meaning anything. With a step known
         it said "passed", which reads as "declined this step" -- and `AdvanceOperatingSubPhase` is the
         message that actually means that. `PassTurn` in an Operating Round is the corporation saying it is
         finished, whatever step it happened to be standing on.
         ONE SENTENCE NOW, because the two branches were describing one event two ways. The stamp drops its
         step alongside (`App.tsx` #1069), so the tag no longer files the ending under an action the
         corporation declined to take. */
      return `${actingActor(context)} ended its turn.`;
    }
    /* Design note #745: a turn the player already acted in is ENDED, not passed, and the log must say so --
       it is the record players scroll back through to work out why a round closed when it did. The state
       here is the one BEFORE the message applies, which is exactly when the flag is still set. */
    return hasActedThisTurn(gameState ?? {})
      ? `${actingPlayer(context)} ended the turn.`
      : `${actingPlayer(context)} passed the turn.`;
  }
  if ("UndoLastAction" in msg) {
    /* Online the client does not know what it undid -- a live chain resolves undo a block or two later, so naming an action would be a guess printed as a fact.
       See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #479 */
    return `${actingActor(context)} reverted their last action.`;
  }
  if ("BeginOperatingRound" in msg) return "The Operating Round began.";

  // `ExecuteOperatingRound` and anything added later: the caller's own label
  // stands. Design note #0 -- a vaguer sentence than the variant name would
  // be a downgrade.
  return null;
}
