// frontend/src/utils/previewRotation.ts
//
// What the rotate gesture shows next: which facing, and which city the acting corporation's token sits in.
//
// ==================================================================
//  DESIGN NOTE 889: THE ODOMETER, LIFTED OUT OF THE SHELL
// ==================================================================
//
// `handlePreviewRotate` WAS 44 LINES AND 21 DECISIONS, and every one of them was a rule about the game rather
// than about React: #173's wrapping facing list, #824's city-as-outer-loop, #879's derive-per-facing, and
// #886's one-derivation-for-every-path. Inline in a `setPreviewTile` updater none of it could be checked
// except by scanning source -- and a grep cannot tell you that pressing rotate five times on a two-city tile
// with three legal facings visits five distinct arrangements, which is the only thing anybody cares about.
//
// THE BOARD STAYS IN THE SHELL. This module never sees `mapGrid`, `gameState` or a hex; it asks two questions
// through callbacks -- "what does the acting token do at THIS facing?" and "which cities are on offer if it is
// free?" -- and does the arithmetic. Same arrangement as `watcherRouteChips.ts` (#875), for the same reason.
//
// ==================================================================
//  THE TWO LOOPS, AND WHY THE CITY IS THE OUTER ONE
// ==================================================================
//
// #824, kept verbatim because the reasoning is still the reasoning: "The rotate gesture already means 'show me
// the next arrangement'; where the token's city is undetermined there are simply twice as many arrangements.
// Orientation is the INNER loop and the city the outer, so a president sees every facing with the marker in
// one city before it moves -- which is the order the question is actually asked in ('can I get the facing I
// want?' then 'and with the token where?')."
//
// #879 THEN NARROWED WHEN THE OUTER LOOP EXISTS AT ALL. A city is only a choice for a token with no network to
// preserve; for every other token the destination is derived from connectivity and changes as the tile turns,
// so there is nothing to cycle. `ActingTokenFit.ownIsFree` is the whole of that test.
//
// ONE CHOICE MEANS ONE PASS, so every ordinary upgrade on the board cycles exactly as it always did: the
// choice list is empty or single, the outer loop never advances, and the marker follows the track.
//
// ==================================================================
//  TWO CORRECTIONS THE EXTRACTION MADE VISIBLE
// ==================================================================
//
// (a) "UNSET" WAS TREATED AS "ALREADY AT THE FIRST CHOICE". The inline form read
// `choices.indexOf(current.tokenCity ?? choices[0] ?? -1)`, so a token with no city yet resolved to index 0
// and the next wrap advanced it to `choices[1]` -- past a state the president had never been shown. The cycle
// now STARTS at `choices[0]` when nothing has been chosen, rather than resuming in the middle of itself.
//
// (b) A FREE TOKEN HAD NO SEED AT ALL. #886 fixed the first preview by deriving instead of guessing, and
// passed `undefined` for the president's choice because they have not rotated yet. Right for an ANCHORED
// token and wrong for a free one: `tokenLandingsFor` omits a free token with no chosen city, so the opening
// preview of ERIE's home upgrade drew NO marker -- while the reducer, receiving no map and no index, leaves
// the token where it was (`sandboxSession.ts` #880, "absent means unchanged"). Preview and outcome disagreed,
// which is the exact fault class #886 existed to close. `seedPreviewArrangement` is the missing half: a free
// token opens at the first city on offer, and rotating cycles it from there.

/** A preview's two adjustable coordinates. The hex and the tile are fixed for the life of the gesture. */
export interface PreviewArrangement {
  orientation: number;
  /** Where the ACTING corporation's token sits. `undefined` when they have no token on this hex. */
  tokenCity: number | undefined;
}

/** What the connectivity rule says about the acting corporation's own token at one candidate facing.
 *
 *  Exactly the shape `derivePreviewLandings` already returns, so the shell passes it straight through. */
export interface ActingTokenFit {
  /** The token stands here and has no network to preserve, so the president chooses (#878's ERIE case). */
  ownIsFree: boolean;
  /** Where connectivity puts it; `undefined` when the acting corporation has no token on this hex. */
  ownCity: number | undefined;
}

/** One step through the legal facings.
 *
 *  `wrapped` means this step went past the end of the list and back to the start -- i.e. the president has
 *  now seen every facing, which is the event the city loop advances on. */
export interface FacingStep {
  orientation: number;
  wrapped: boolean;
}

/** The next legal facing, or `null` when there is nowhere to go.
 *
 *  #173: with one legal rotation this returns that same angle -- correct, there is nowhere else the tile may
 *  face -- and with none it returns `null` rather than inventing one. */
export function nextLegalFacing(
  orientation: number,
  legalRotations: readonly number[],
): FacingStep | null {
  if (legalRotations.length === 0) return null;
  const at = legalRotations.indexOf(orientation);
  /* NOT IN THE LIST IS A REAL STATE, not a bug to assert away: #879's filter drops any facing that would
     strand a token, and the board can change under an open preview. Snapping to the first legal angle is the
     recovery -- and it is deliberately NOT a wrap, because no full pass has been made and a free token's city
     must not advance on a correction the president did not ask for. */
  if (at === -1) return { orientation: legalRotations[0], wrapped: false };
  const next = (at + 1) % legalRotations.length;
  return { orientation: legalRotations[next], wrapped: next === 0 };
}

/** The next city for a token the rules have left free, given whether the facings just wrapped.
 *
 *  Only ever asked about the ACTING corporation's own token. Somebody else's free token is not this
 *  president's to move (`tokenLandingsFor`, #885). */
export function nextFreeCity(input: {
  current: number | undefined;
  choices: readonly number[];
  wrapped: boolean;
}): number | undefined {
  const { current, choices, wrapped } = input;
  /* NOTHING ON OFFER means nothing to say. Returning `choices[0]` here would be `undefined` anyway, but
     saying it this way keeps a carried city from being silently dropped by an empty list. */
  if (choices.length === 0) return current;
  const at = choices.indexOf(current ?? -1);
  /* CORRECTION (a): THE CYCLE STARTS, IT DOES NOT RESUME. Reached when no city has been chosen yet, or when
     the one that was is no longer on offer. Either way the president has not seen `choices[0]` in this cycle,
     so advancing past it would skip a state -- which is what the inline `?? choices[0]` fallback did. */
  if (at === -1) return choices[0];
  if (!wrapped) return current;
  return choices[(at + 1) % choices.length];
}

/** Where a token sits the moment a candidate tile is first previewed, before any rotation.
 *
 *  CORRECTION (b). An anchored token goes where connectivity says. A FREE one opens at the first city on
 *  offer -- a default the president changes by rotating, not a claim about the board -- because a preview
 *  that draws no marker disagrees with a lay that leaves the token where it was. */
export function seedPreviewArrangement(input: {
  orientation: number;
  fit: ActingTokenFit;
  freeCityChoices: readonly number[];
}): PreviewArrangement {
  const { orientation, fit, freeCityChoices } = input;
  return {
    orientation,
    tokenCity: fit.ownIsFree ? freeCityChoices[0] : fit.ownCity,
  };
}

/** The arrangement one rotate gesture from here, or `null` when the gesture changes nothing.
 *
 *  `null` RATHER THAN THE INPUT, so a caller inside a React updater can return the previous object by
 *  identity and skip the render, and so "nothing moved" cannot be confused with "moved to an equal value".
 *
 *  `fitAt` IS ASKED ABOUT THE NEXT FACING, NOT THE CURRENT ONE -- #879: an anchored token's city is a
 *  property of the tile AS LAID, so the question only has an answer once the facing is chosen. It is passed
 *  the city the president currently holds, which is what a free token's fit reports back unchanged. */
export function nextPreviewArrangement(input: {
  current: PreviewArrangement;
  legalRotations: readonly number[];
  fitAt: (orientation: number, chosenCity: number | undefined) => ActingTokenFit;
  freeCityChoices: () => readonly number[];
}): PreviewArrangement | null {
  const { current, legalRotations, fitAt, freeCityChoices } = input;
  const facing = nextLegalFacing(current.orientation, legalRotations);
  if (facing === null) return null;

  const fit = fitAt(facing.orientation, current.tokenCity);
  const tokenCity = fit.ownIsFree
    ? nextFreeCity({
        current: current.tokenCity,
        choices: freeCityChoices(),
        wrapped: facing.wrapped,
      })
    : /* ANCHORED, OR NO TOKEN AT ALL: the board decides, and it may differ at every facing. */
      fit.ownCity;

  if (facing.orientation === current.orientation && tokenCity === current.tokenCity) return null;
  return { orientation: facing.orientation, tokenCity };
}

/** Every city index a candidate tile carries, which is every city a FREE token may be put in.
 *
 *  THIS REPLACES `tokenDestinationChoices` ON THE ROTATE PATH, and that is a correction rather than a
 *  simplification. That function reaches `previewTokenMigration` -- the index-preserving rule #878 superseded
 *  and the notes say not to wire -- to decide whether a choice exists at all, using #824a's proxies for the
 *  question: has the hex a laid tile, has it fewer than two cities, has it printed track. #878 answers the
 *  real question directly, and the caller has already asked it: a token is free exactly when it has no edges
 *  to preserve, and then every city of the candidate satisfies it vacuously.
 *
 *  THE ABSENCE ASSERTION DID NOT CATCH THIS. `stationConnectivity.test.ts` pins that `App.tsx` never names
 *  `previewTokenMigration`, and it never did -- it called `tokenDestinationChoices`, one indirection away.
 *  Proving a symbol left a file is not proving a rule did.
 *
 *  A NEGATIVE COUNT YIELDS AN EMPTY LIST, and this used to be spelled as an explicit `cityCount <= 0` guard
 *  with a comment claiming `Array.from({length: -1})` throws. IT DOES NOT -- `ToLength` clamps a negative to
 *  zero -- and the negative control proved the guard unreachable, which is the third redundant guard a
 *  negative control has deleted in this project (see #883). The claim is recorded rather than quietly
 *  removed, because a wrong belief about a language primitive is worth more written down than erased. */
export function freeCityChoices(cityCount: number): number[] {
  return Array.from({ length: cityCount }, (_, index) => index);
}
