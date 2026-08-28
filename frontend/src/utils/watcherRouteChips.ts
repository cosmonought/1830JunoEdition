// frontend/src/utils/watcherRouteChips.ts
//
// The chip row a player who is NOT operating sees during Run Routes.
//
// ==================================================================
//  DESIGN NOTE 875: ONE CHIP PER TRAIN, OR ONE CHIP PER DRAFT?
// ==================================================================
//
// REPORTED, AND NOT FOR THE FIRST TIME: "On Run Routes subphase, non-active players STILL cannot see the
// train chips + revenue of the operating corporation. It is imperative that this gets fixed."
//
// THE TWO SIDES OF ONE PROP WERE BUILT FROM DIFFERENT THINGS. The president's row maps the acting
// corporation's ROSTER -- one entry per train, so a chip exists whether or not a route has been drawn for it.
// The watcher's row mapped the presence channel's `routeDrafts` -- one entry per DRAFTED ROUTE. A president
// who has drafted nothing publishes nothing, so the watcher's array was empty; and the row's own
// `trainDrafts.length > 0` guard then hid it entirely. Not a missing chip: a missing row.
//
// WHICH IS WHY IT SURVIVED TWO FIXES. #740 and #802 both worked this path and both were exercised with routes
// already drawn, where presence does carry an entry per train and the row looks correct. The broken state is
// the one a watcher is in for most of the step -- watching, before anything is drawn.
//
// AND #802's NOTE ASSERTED THIS WAS ALREADY TRUE: "The chips render for the whole table (they come off
// `activeCorporation.trains`, which is shared state) and the drafts arrive through presence for a watcher and
// locally for the actor." The right design, describing the president's branch only.
//
// EXTRACTED FROM `App.tsx` SO THE PROPERTY IS ARITHMETIC. Inline in the shell it could only be checked by
// scanning source, and a grep cannot tell you that an empty draft map still yields four chips -- which is the
// exact fact that was wrong. The pricing and the hex-name lookup arrive as callbacks so this stays pure and
// the caller keeps owning the board.

/** The acting corporation's fleet, as the shell already derives it from game state. */
export interface WatcherRosterEntry {
  /** Position in `owned_trains` -- the key the map overlay, the chips and the planner join on (#373). */
  trainIndex: number;
  model: string;
}

/** What the operating president has published for this company, or `null` when nothing has been. */
export type ActorRouteDrafts = Readonly<
  Record<number, ReadonlyArray<readonly [number, number]>>
> | null;

export interface WatcherChip {
  trainIndex: number;
  model: string;
  /** The route's revenue, or `null` for a train with nothing drafted yet. */
  value: number | null;
  /* ==================================================================
      DESIGN NOTE 890: THE PATH, BECAUSE THE CHIP OPENS INTO IT
     ==================================================================
     REPORTED: "although non-active players can see the route printed on the board, when they click the train
     chip, it says 'No route drafted for this train yet.'"
     THE CHIP CARRIED THE PRICE AND NOT THE ROUTE. `RouteChipDetail` reads `stops` and `hexLabels`; a watcher
     chip supplied neither, so the component took its `stops.length === 0` branch -- which is #802's honest
     "an empty route is a state, not a blank" answering a question nobody asked. The route was on the board
     the whole time, drawn from the same presence entry this is built from.
     #802's OWN NOTE CLAIMED THIS ALREADY WORKED: "the drafts arrive through presence for a watcher and
     locally for the actor. The only thing that changes with `canClear` is whether the Clear button is
     there." The drafts arrived; the PATHS did not. Corrected in place, because the sentence states the
     intention this change implements. */
  hexLabels: readonly string[];
  /** The paying stops. `value` is the sum; this is what the readout lists. */
  stops: ReadonlyArray<{ hex: string; value: number }>;
}

/** Rivals' live routes are keyed above any real train index, so a watcher's overlay can never collide with
 *  their own on the three surfaces that join by it (#740). Re-exported here because this module is now the
 *  thing that applies it, and a second literal 1000 elsewhere is how the join quietly breaks. */
export const RIVAL_ROUTE_INDEX_BASE = 1000;

/** One chip per train in the acting corporation's fleet, priced where a draft exists.
 *
 *  THE FLEET COMES FROM STATE AND ONLY THE REVENUE COMES FROM PRESENCE. The roster is derived from the
 *  acting company against `gameState`, so it is the same list on every client in the room -- replayed from
 *  the same log. A watcher needs no channel to know WHICH trains are running; they need one to know what the
 *  president has plotted for them, which is what presence is for and all it is for. */
export function watcherTrainDrafts(input: {
  roster: readonly WatcherRosterEntry[];
  actorDrafts: ActorRouteDrafts;
  /** `undefined` for a coordinate that is not a board hex, so a malformed draft prices as nothing. */
  labelForHex: (q: number, r: number) => string | undefined;
  /** `null` where the caller cannot price it. Fewer than two stops is never priced at all. */
  priceRoute: (labels: readonly string[]) => number | null;
  /** Design note #890: what each stop pays, for the readout the chip opens into. `null` where the caller
   *  cannot price the individual stops -- the chip then lists the path without figures rather than
   *  inventing them, which is the same rule `value: null` follows one line down. */
  stopsFor?: (labels: readonly string[]) => ReadonlyArray<{ hex: string; value: number }>;
}): WatcherChip[] {
  const { roster, actorDrafts, labelForHex, priceRoute, stopsFor } = input;
  return roster.map((train) => {
    const hexes = actorDrafts?.[train.trainIndex] ?? [];
    const labels = hexes
      .map(([q, r]) => labelForHex(q, r))
      .filter((label): label is string => label !== undefined);
    /* A ONE-STOP ROUTE IS NOT A ROUTE and must not price as `0`. Zero is a run that earned nothing, which is
       a different fact from a draft that is still being drawn -- the same distinction #498 drew for the em
       dash on the chip. */
    return {
      /* ==================================================================
          DESIGN NOTE 890: THE ACTOR'S TRAINS KEEP THEIR REAL INDICES
         ==================================================================
         WAS `RIVAL_ROUTE_INDEX_BASE + train.trainIndex`, and #740's reason for the offset was that "two
         clients both drafting train 0 would otherwise collide on `trainIndex`, which is the key the highlight
         and the chip row join on."
         THAT PREMISE DOES NOT HOLD FOR THESE CHIPS. An Operating Round has ONE acting corporation, and this
         function builds chips for its roster alone -- `actorDrafts` comes from the presence entry whose
         `actingCompanyId` matches. There is no second drafter to collide with, so the offset was buying
         collision-safety against a state the round cannot be in, and charging for it in the one place that
         matters: the join. A chip at index 1000 matches no overlay at index 0, so the watcher's route was
         never `primary` and was drawn muted -- the reported dimming.
         THE OFFSET SURVIVES WHERE ITS PREMISE DOES, in `App.tsx`'s overlay loop, for presence entries that
         are NOT the acting corporation's. */
      trainIndex: train.trainIndex,
      model: train.model,
      value: labels.length >= 2 ? priceRoute(labels) : null,
      hexLabels: labels,
      stops: labels.length >= 2 && stopsFor ? stopsFor(labels) : [],
    };
  });
}
