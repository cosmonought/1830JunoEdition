// frontend/src/utils/runTrainsRules.ts
//
// Which drafted routes may run, and which complaint wins when none may.
//
// ==================================================================
//  DESIGN NOTE 883: A PRIORITY ORDER IS A RULE, AND IT WAS INVISIBLE
// ==================================================================
//
// EXTRACTED FROM `App.handleRunTrains` BY AUDIT, second on the shortlist after #882. It held two rules:
// which drafts are runnable, and -- when none are -- which of several true complaints the player is shown.
// The second is the interesting one. It was four `if`s in source order inside an async dispatch callback,
// so the ordering was real, load-bearing, and asserted nowhere.
//
// THE ORDER IS DELIBERATE AND #474 ARGUED FOR IT: "the token warning comes first, because a tokenless route
// is wrong about where it runs." A route that ends in the wrong place is a drawing mistake; a route that
// never touches your own network is a misunderstanding of the rules, and telling a player about the ending
// first would answer the smaller question.
//
// ==================================================================
//  AND A GAP THE ORDER WAS HIDING
// ==================================================================
//
// Opening it up turned up a case with no arm at all: a route that is legal in every respect and worth
// NOTHING. Albany (E19) is a real, blank $0 printed city, and 1830 prints others -- so two of them joined by
// track is a lawful route paying zero. `value > 0` correctly keeps it out of the runnable set, and then the
// chain fell through to "No drafted route can run yet", which tells a player who has drawn a perfectly good
// route precisely nothing.
//
// THE FILTER ITSELF IS RIGHT AND STAYS. `routeStep.ts`'s obligation already settled this from the other
// side -- "null is ignorance and must not block; 0 is a real answer that permits Skip" -- so a corporation
// whose only route is worthless is not compelled to run it, and the two rules agree. What was missing was
// the sentence saying so.

/** Only the fields these two rules read. Deliberately structural: the caller's `TrainRouteDraft` carries a
 *  dozen more and none of them belong to this question. */
export interface RunnableDraftShape {
  value: number | null;
  exceedsMaxDistance: boolean;
  endsOffTerminus: boolean;
  tokenBlockReason: string | null;
  hexLabels: readonly string[];
}

/** The drafts that may actually be dispatched.
 *
 *  INVALID DRAFTS ARE SKIPPED, NOT REFUSED (#275): the good routes are not held hostage by the bad one, so
 *  this is a filter rather than a gate. */
export function runnableDrafts<T extends RunnableDraftShape>(drafts: readonly T[]): T[] {
  return drafts.filter(
    (draft) =>
      draft.value !== null &&
      /* `> 0`, MATCHING THE OBLIGATION. A $0 route is lawful and pays nothing, and `routeRunObligation`
         already declines to compel one; running it would change nothing except the log. Kept out here so the
         two rules cannot disagree about whether a worthless route counts. */
      draft.value > 0 &&
      !draft.exceedsMaxDistance &&
      !draft.endsOffTerminus &&
      // Design note #474: and it must touch one of this corporation's tokens.
      draft.tokenBlockReason === null,
  );
}

/** Why nothing can run, or `null` when something can.
 *
 *  THE ORDER IS THE RULE. Each arm below is true of a different mistake, several can be true at once, and a
 *  player is shown one sentence -- so which one comes first is a decision about what they most need to know. */
export function runTrainsRefusal(drafts: readonly RunnableDraftShape[]): string | null {
  if (runnableDrafts(drafts).length > 0) return null;

  const drafted = drafts.filter((draft) => draft.hexLabels.length > 0);
  /* NOTHING DRAWN AT ALL comes first because it is not a mistake, it is a step not yet taken. */
  if (drafted.length === 0) {
    return "Select at least two connected hexes on the Rail Map to declare a route.";
  }

  /* THE TOKEN FIRST (#474): a tokenless route is wrong about WHERE it runs, which is a larger
     misunderstanding than a route that stops in the wrong place. */
  const tokenless = drafted.find((draft) => draft.tokenBlockReason !== null);
  if (tokenless?.tokenBlockReason) return tokenless.tokenBlockReason;

  /* THEN THE ENDING. Reported here rather than refused on click (#256), because a player mid-draw has not
     finished yet and refusing every non-terminus would make drawing impossible. */
  const offTerminus = drafted.find((draft) => draft.endsOffTerminus);
  if (offTerminus) {
    const last = offTerminus.hexLabels[offTerminus.hexLabels.length - 1];
    return `${last} cannot END a route. Routes finish at a city or a red off-board hex — click one to finish, or click ${last} again to step back.`;
  }

  /* THEN TOO LONG. Below the ending because a route that runs too far is at least going the right way, and
     the panel already marks the offending chip. */
  const overlong = drafted.find((draft) => draft.exceedsMaxDistance);
  if (overlong) {
    return "That route has more stops than the train can run. Step back a hex, or run it with a longer train.";
  }

  /* ==================================================================
      AND THE ARM THAT WAS MISSING (design note #883)
     ==================================================================
     A LAWFUL ROUTE WORTH NOTHING fell through every arm above and landed on "No drafted route can run yet",
     which is true and useless: the player has drawn a legal route and is told the app cannot see one.
     Albany is a blank $0 city and 1830 prints others, so this is reachable rather than theoretical. */
  /* TWO CONDITIONS, NOT FIVE. The first draft of this arm also required `!exceedsMaxDistance`,
     `!endsOffTerminus` and `tokenBlockReason === null` -- and a negative control proved all three
     unreachable: every arm above returns if ANY drafted route has those faults, so by the time control
     arrives here none does. The guards read as caution and were dead code.
     WHICH IS AN ARGUMENT FOR THE ORDER RATHER THAN AGAINST THE GUARDS. What makes this arm narrow is its
     POSITION, not its predicate -- so the order is doing real work and the test that pins it is pinning
     something load-bearing. Deleted rather than left in (#772's rule), with the reason kept. */
  const worthless = drafted.find((draft) => draft.value !== null && draft.value <= 0);
  if (worthless) {
    return "That route is legal but pays $0, so there is nothing to run. Extend it to a paying city, or skip the step.";
  }

  return "No drafted route can run yet.";
}
