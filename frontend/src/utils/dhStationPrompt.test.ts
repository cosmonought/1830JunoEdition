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

describe("the shell drives the machine rather than duplicating it", () => {
  const read = (relative: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
  };
  const APP = read("App.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const MODAL = read("components/DhStationPrompt.tsx");

  it("raises the question on the D&H's lay and no other", () => {
    /* The C&SL's lay is the WHOLE of its power (#726) and has nothing to follow -- a prompt after it would be
       an offer of something that does not exist. */
    expect(APP).toContain('if (homeStationPlacement?.abilityKey === "dh-tile") {');
    expect(APP).toContain('dhStationPromptNext(current, "lay-landed")');
  });

  it("arms the same errand the power's own button arms", () => {
    /* One mechanism, two entry points, rather than a second copy of the placement for this one. #817 gave
       that errand a lifecycle; a bespoke path here would not have it. */
    expect(APP).toContain('kind: "private-station"');
    expect(APP).toContain('abilityKey: "dh-token"');
  });

  it("sends the ring's X back to the question", () => {
    expect(APP).toContain('dhStationPromptNext(current, "cancel-placement")');
  });

  it("spends the ability only through the forfeit check", () => {
    expect(APP).toContain('if (dhStationDeclineForfeits(current, "decline")) {');
    expect(APP).toContain('new Set(prev).add("dh-token")');
  });

  it("records the forfeit in the log", () => {
    // #717's rule: a thing that quietly stopped being available is this app's worst failure mode.
    expect(APP).toContain("the free station on F16 was forfeited.");
  });

  it("abandons the question when the step moves on", () => {
    expect(APP).toContain('dhStationPromptNext(current, "abandon")');
  });

  it("offers no third exit from the modal", () => {
    /* THE ONE PLACE THIS DEPARTS FROM THE APP'S OTHER MODALS. `AutoPassModal` has a close button and a
       backdrop dismiss, because a settings dialog dismissed unanswered leaves the world as it was. Here a
       dismissal is either an acceptance or a forfeit, and there is no third thing an X in the corner could
       honestly mean. */
    expect(MODAL).not.toContain('aria-label="Close"');
    expect(MODAL).not.toContain("event.currentTarget");
  });

  it("names the supply the marker comes out of", () => {
    // #725: "free means no cash, not no token". A corporation on its last marker is making a real choice.
    expect(MODAL).toContain("station {tokensLeft === 1 ?");
    expect(MODAL).toContain("disabled={tokensLeft === 0}");
    expect(APP).toContain("stationTokenSlots(company).filter((slot) => !slot.placed).length");
  });
});
