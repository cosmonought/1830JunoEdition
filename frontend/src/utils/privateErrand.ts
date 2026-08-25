// frontend/src/utils/privateErrand.ts
//
// An armed errand is a MODE, with a beginning, an end and a way out.
//
// ==================================================================
//  DESIGN NOTE 817: A VEIL IS NOT A MODE
// ==================================================================
//
// REPORTED, four symptoms:
//   4)  "when I click the DH's Special Powers' 'Lay Track' button, it correctly reduces the veil to the
//       single legal hex. However, I have no clear way of escaping this action if I decide I don't want to do
//       it ... they may think once they click the Special Power they have no choice but to follow through."
//   4a) "I placed a tile that was not the F16 one, and it seems the DH power was consumed."
//   4b) "clicking the 'Place Station' special power and then clicking the un-tiled F16 (and indeed any other
//       hex/tile!) instead brought up the tileselector ... the checkmark is disabled. So it seems like the
//       Special Power is technically disabled, it just affords players the opportunity to find out that it
//       isn't."
//   4c) "even once I skipped the Station Marker subphase into the Run Routes one, my cursor still showed the
//       herald like a Place Station action, and indeed I was then able to place the station for free on the
//       untiled F16 *in the middle* of Run Routes."
//
// ONE DEFECT, FOUR FACES. `homeStationPlacement` arms a veil and two click handlers, and each handler decides
// on its own whether this click is its business. Nothing else in the flow is stated anywhere:
//   * NO CANCEL, so the only exit was to do something else and hope (4).
//   * NO SCOPE ON COMPLETION. `handleConfirmRadialLay` marked the ability spent whenever a `private-tile`
//     errand was ARMED, without asking where the tile landed -- so an ordinary lay on any hex consumed the
//     D&H's power and unlocked its free token (4a). The note above that line said "marked spent on the LAY,
//     not on the button press", which is the right intent tested the wrong way: it checked that an errand
//     existed, not that the lay was the errand's.
//   * NO TEARDOWN. Nothing ended the errand when the step moved on, so a token errand armed in Tokens was
//     still armed in Run Routes (4c).
//   * AND TWO HANDLERS ON ONE CLICK. Off its hex the station errand's handler `return`ed silently and the
//     ordinary tile inspector took the click instead, which is why a station power opened a tile picker (4b).
//     4b's root is 4a: with the lay correctly scoped, `dhPowerState` never unlocks the token before the F16
//     tile exists, so the button that led there is not offered in the first place.
//
// SO THE LIFECYCLE IS WRITTEN DOWN HERE, once, and the shell asks it. The three questions an armed errand has
// to answer are "what does this click mean", "is this completed action mine", and "am I still relevant" --
// and every one of them was previously answered by a different `if` in a different callback.
//
// THE HOME STATION IS NOT CANCELLABLE, which is the distinction that makes this a table rather than a rule.
// Placing a home token is compulsory and the whole table is blocked on it (#783's waiting modal exists for
// exactly that), so a click off its hex must do nothing at all. A PRIVATE power is optional by definition --
// nobody is waiting, and #725a already established that spending one by accident is this flow's sharpest
// edge. Same veil, opposite answer, and conflating them is how the compulsory one would become escapable.

/** The three errands that share one veil. */
export type PrivateErrandKind = "home-station" | "private-station" | "private-tile";

export interface ArmedErrand {
  kind: PrivateErrandKind;
  q: number;
  r: number;
}

/** What a click on `(q, r)` means for the errand currently armed.
 *
 *  `"complete"` -- this is the errand's own hex; the errand's handler owns the click.
 *  `"cancel"`   -- an optional errand, clicked away from; disarm and let the click be an ordinary one.
 *  `"ignore"`   -- nothing armed, or a compulsory errand clicked away from; the errand is unchanged.
 *
 *  CANCEL DOES NOT SWALLOW THE CLICK, and that is deliberate. The report describes discovering the escape by
 *  accident -- "I can escape it by clicking the veiled legal placement options and laying track there" -- and
 *  that behaviour was the one part of this flow that worked. Making the click BOTH cancel and land keeps it,
 *  where swallowing would answer a player's first attempt to leave with nothing happening. */
export function errandClickIntent(
  errand: ArmedErrand | null,
  q: number,
  r: number,
): "complete" | "cancel" | "ignore" {
  if (!errand) return "ignore";
  if (errand.q === q && errand.r === r) return "complete";
  // Compulsory: there is nothing to cancel and nowhere else to go.
  if (errand.kind === "home-station") return "ignore";
  return "cancel";
}

/** Whether a tile lay that has just landed on `(q, r)` is THIS errand's lay.
 *
 *  THE 4a FIX, in one comparison. Only a `private-tile` errand claims a lay at all -- a station errand ends
 *  in a token, and a home-station errand lays nothing -- and it claims only the hex it was armed for. */
export function errandClaimsLay(errand: ArmedErrand | null, q: number, r: number): boolean {
  if (!errand || errand.kind !== "private-tile") return false;
  return errand.q === q && errand.r === r;
}

/** Whether an armed errand still belongs to the step now on screen.
 *
 *  THE 4c FIX. A tile errand is a Track-step thing and a station errand is a Tokens-step thing; either one
 *  outliving its step leaves an armed cursor over a board that is doing something else, which is how a free
 *  station came to be placed during Run Routes.
 *  A HOME STATION SURVIVES EVERYTHING, because it is not part of an Operating Round turn at all -- it is
 *  raised when a corporation floats, in whatever round that happens, and it is compulsory. `null` for the
 *  sub-phase (a Stock Round, or before the first poll) therefore keeps it and drops the other two: an errand
 *  that cannot see the step cannot claim to belong to it. */
export function errandSurvivesStep(
  errand: ArmedErrand | null,
  orSubPhase: string | null,
): boolean {
  if (!errand) return false;
  if (errand.kind === "home-station") return true;
  if (errand.kind === "private-tile") return orSubPhase === "Track";
  return orSubPhase === "Tokens";
}

/** The label for the control that leaves an armed private errand.
 *
 *  A VISIBLE EXIT IS THE OTHER HALF OF (4), and the report is precise about why: the escape existed and was
 *  invisible, so "they may think once they click the Special Power they have no choice but to follow
 *  through." A cancel that only works by doing something else is a rule the player has to guess.
 *  `null` for the home station, which has no exit by design. */
export function errandCancelLabel(errand: ArmedErrand | null): string | null {
  if (!errand || errand.kind === "home-station") return null;
  return errand.kind === "private-tile" ? "Cancel Track Lay" : "Cancel Station";
}
