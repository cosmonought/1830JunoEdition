/** @jest-environment node */
//
// The D&H's free station: taken, declined, or abandoned — and the three are different. No DOM.
//
// ==================================================================
//  DESIGN NOTE 818 (harness): THE RED X MEANT SOMETHING ALREADY
// ==================================================================
//
// REQUESTED: "if they do lay the F16 tile, a modal pops up and asks them 'Do you want to place a Station
// Marker on this tile for free? If you do not use this power now, it will be forfeited,' then (i) if they
// click yes ... the usual green checkmark and red x ... (ii) if they click yes and then decide they don't
// want to they click the X which takes them back to the modal where they can decline the power, or (iii)
// they click no and the game advances."
//
// I ARGUED AGAINST THE MODAL AND THE ARGUMENT AGAINST ME IS THE INTERESTING PART. My proposal was to skip it:
// arm the placement automatically after the lay and let the ring's red X decline the power. Reported back: "I
// fear without the station marker modal that players may not realize they are forfeiting the special power."
// Right -- and the sharper form is about the CONTROL rather than the player. A red X dismisses everywhere else
// in this app: nothing happened, come back later. Giving it a second, permanent job on the one screen where
// the mistake cannot be undone would teach a player the opposite of what every other X has taught them.
//
// SO THE FLOW HAS TWO DECISIONS AND TWO CONTROLS, and the whole of this file is that they stay apart:
// cancelling a PLACEMENT returns to the question, and only the question's own button spends the power.
//
// WHY A TRANSITION TABLE AT ALL. #817 is the record of what a five-line lifecycle costs when it lives as
// scattered `setState` calls in a 10,000-line component: four separate reports, one missing set of rules. The
// table is smaller than the bug it prevents and it can be asked questions.

import {
  dhStationDeclineForfeits,
  dhStationPromptNext,
  DH_STATION_PROMPT_FORFEIT,
  type DhStationPrompt,
} from "./dhPower";

/** Walk the machine through a sequence, for the paths the report describes. */
const walk = (...events: Parameters<typeof dhStationPromptNext>[1][]): DhStationPrompt =>
  events.reduce<DhStationPrompt>((state, event) => dhStationPromptNext(state, event), null);

describe("the question opens when the power's own tile lands", () => {
  it("asks after the lay", () => {
    expect(walk("lay-landed")).toBe("asking");
  });

  it("is closed at every other moment", () => {
    /* THE DEFAULT, and it matters: this modal covers the board, so anything that raises it spuriously is
       worse than not having it. Only the lay opens it. */
    for (const event of ["accept", "decline", "cancel-placement", "placed", "abandon"] as const) {
      expect(dhStationPromptNext(null, event)).toBeNull();
    }
  });
});

describe("(i) yes, then the tick", () => {
  it("arms the placement and then closes", () => {
    expect(walk("lay-landed", "accept")).toBe("placing");
    expect(walk("lay-landed", "accept", "placed")).toBeNull();
  });
});

describe("(ii) yes, then the X, back to the question", () => {
  it("returns to asking rather than forfeiting", () => {
    /* THE REPORT'S OWN CASE, and the reason the machine has two states instead of a boolean: "they click the
       X which takes them back to the modal where they can decline the power". A red X means "not this
       placement", which leaves the OFFER standing. */
    expect(walk("lay-landed", "accept", "cancel-placement")).toBe("asking");
  });

  it("can then be declined, or taken after all", () => {
    // Both exits are still open from there -- that is what "back to the modal" has to mean.
    expect(walk("lay-landed", "accept", "cancel-placement", "decline")).toBeNull();
    expect(walk("lay-landed", "accept", "cancel-placement", "accept")).toBe("placing");
  });

  it("does not forfeit on the way past", () => {
    /* THE ASSERTION THIS FILE EXISTS FOR. If cancelling a placement spent the power, the red X would have
       become the destructive control -- which is exactly the design that was talked out of me. */
    expect(dhStationDeclineForfeits("placing", "cancel-placement")).toBe(false);
  });
});

describe("(iii) no, and the power is gone", () => {
  it("closes the question", () => {
    expect(walk("lay-landed", "decline")).toBeNull();
  });

  it("forfeits, and only from the question", () => {
    /* #725a's rule -- the two halves are one turn -- made explicit at the moment it applies. A decline is a
       DECISION; the states either side of the question are not. */
    expect(dhStationDeclineForfeits("asking", "decline")).toBe(true);
    expect(dhStationDeclineForfeits(null, "decline")).toBe(false);
    expect(dhStationDeclineForfeits("placing", "decline")).toBe(false);
  });

  it("says so before it happens", () => {
    // The sentence is the whole point of the modal, so it is pinned rather than left to a component.
    expect(DH_STATION_PROMPT_FORFEIT).toContain("forfeited");
    expect(DH_STATION_PROMPT_FORFEIT).toContain("now");
  });
});

describe("abandoning is not declining", () => {
  it("closes from any state", () => {
    /* #817's lesson one layer up: a prompt that outlived its turn would be a modal over a board doing
       something else, which is 4c wearing a dialog. */
    for (const state of [null, "asking", "placing"] as const) {
      expect(dhStationPromptNext(state, "abandon")).toBeNull();
    }
  });

  it("does not spend the power", () => {
    /* THE DISTINCTION THAT KEEPS THE FORFEIT HONEST. A player who never answered has not chosen to give it
       up -- and nothing is left lying about either, because `dhPowerState` refuses the token on any later
       turn regardless. The forfeit is a consequence of choosing, not of the clock. */
    expect(dhStationDeclineForfeits("asking", "abandon")).toBe(false);
    expect(dhStationDeclineForfeits("placing", "abandon")).toBe(false);
  });
});

/* ==================================================================
    DESIGN NOTE 849: THE SHELL NO LONGER DRIVES THIS MACHINE
   ==================================================================
   The block that stood here asserted `App.tsx` called `dhStationPromptNext` at five sites and that
   `DhStationPrompt.tsx` refused a close button. #848 folded that modal into `PrivatePowerFlowModal` and #849
   derived the cursor from the power's own record, so both subjects are gone -- the assertions would now be
   about files that do not exist.
   THE PROPERTIES THEY GUARDED MOVED WITH THEM, and are asserted in `privatePowerFlow.test.ts`:
     - the question is raised on the D&H's lay and never on the C&SL's        -> "csl has one step"
     - the forfeit is a DECISION, distinguished from a turn moving on          -> "the X is gone once anything is committed"
     - the same errand is armed, not a second copy of the placement            -> "one arming callback"
     - the forfeit is written to the log                                       -> App assertion, same wording
   THE TRANSITION TABLE'S OWN TESTS ABOVE ARE UNTOUCHED. `dhPower.ts` #849 records that the table is
   deliberately unused rather than orphaned by oversight, and these are what keep it honest if it is ever
   read again. Deleting them along with the wiring would throw away the reasoning with the plumbing. */
