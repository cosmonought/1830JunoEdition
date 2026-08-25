// frontend/src/utils/inspectorClick.ts
//
// Whose clicks the Lay Track glow is allowed to swallow.
//
// ==================================================================
//  DESIGN NOTE 809: THE NOTE SAID "A SPECTATOR KEEPS THE INSPECTOR"
// ==================================================================
//
// REPORTED as a regression: "non-active players used to be able to click the rail map and view possible track
// lays on any tile at any time. This ability seems to be blocked now during the active player's Lay Track
// subphase."
//
// #716 WROTE THIS RULE DOWN AND THEN DID NOT ASK IT. Its own note ends: "ONLY WHILE A LAY IS GATED. With no
// focus there is no veil to deepen and no network to be outside of -- a spectator or a player browsing
// between turns keeps the inspector on every hex, which is #437's point about not telling somebody they may
// not build on hexes that are not their concern."
//
// That is exactly right and the condition it shipped was `layTrackFocus && ...`. `layTrackFocus` is derived
// from the STEP (#437: "the STEP, not the inspector"), not from whose turn it is -- so during ANY president's
// Track step it is defined for EVERY seated viewer, and the gate swallowed everybody's out-of-network clicks.
//
// AND IT WAS GATING THEM AGAINST SOMEBODY ELSE'S NETWORK. `layTrackFocus` is computed from
// `actingProtocolId`'s reach, so a watcher's clicks were being measured against the acting corporation's
// track. There is no reading of that which is the rule.
//
// THE HALF-VISIBLE STATE IS WHY IT READ AS BROKEN RATHER THAN AS A RESTRICTION, and it is the same species as
// #786/#787's watcher bugs. The veil already restricts itself to the actor -- the shell passes
// `dim: isMyTurn` -- so a watcher saw an undimmed board with no visual sign of any restriction, and their
// clicks silently did nothing. Hidden and consistent would have been better; visible and inert is the worst
// of the three.
//
// EXTRACTED RATHER THAN PATCHED IN PLACE because this predicate has now been wrong once while its prose was
// right, and a closure inside a 10,000-line component is reachable by no test. The rule is four booleans; it
// belongs somewhere it can be stated and checked.

export interface InspectorClickInput {
  /** Whether this viewer is the one who may lay track right now. Only their clicks can be out of network,
   *  because only they are laying anything. */
  actingViewer: boolean;
  /** The Lay Track glow: the hexes a tile actually fits, from `layableHexes` (#716). `undefined` outside the
   *  step, or when the reach is unknowable -- both of which mean there is nothing to be outside of. */
  layFocusHighlighted: ReadonlySet<string> | undefined;
  /** `"q,r"` for the hex that was clicked. */
  hexKey: string;
  /** Design note #725: the D&H's own hex while its errand is armed. That power exists precisely to reach a
   *  hex before your track does, so the gate that enforces connectivity must not refuse the one lay that
   *  ignores it. `null` whenever no such errand is armed. */
  privateTileHexKey: string | null;
}

/** Whether this click should do nothing at all.
 *
 *  REFUSING IS THE UNUSUAL ANSWER, and the shape says so: every clause has to be true. A viewer who is not
 *  acting, a step with no glow, a hex inside the glow and a private power's own hex all fall through to the
 *  inspector -- which is what #437 and #716 both describe and what the reported regression removed. */
export function inspectorClickRefused(input: InspectorClickInput): boolean {
  if (!input.actingViewer) return false;
  if (!input.layFocusHighlighted) return false;
  if (input.layFocusHighlighted.has(input.hexKey)) return false;
  if (input.privateTileHexKey === input.hexKey) return false;
  return true;
}
