/** @jest-environment node */
//
// The Private Powers panel shows what can be done here, now. No DOM.
//
// ==================================================================
//  DESIGN NOTE 782 (harness): A PANEL THAT OUTSTAYED ITS SUBJECT
// ==================================================================
//
// REPORTED, two asks:
//   1)  "During Run Routes, the 'Private Powers' subpanel is still visible. There's no reason for it to be
//       visible."
//   1a) "once CSL and DH's powers are used, they do not need to be displayed in the Private Powers subpanel."
//
// THE FIELD EXISTED AND NOTHING ASKED IT -- this project's signature failure, now on a panel rather than in a
// rule. #349 put `subPhase: "Track"` on the C&StL three notes ago and wrote down why; the filter never read
// it, and gated on the ROUND alone. So both corporate powers rendered through Routes, Dividends and Hardware,
// where neither can do anything.
//
// AND IT COULD NOT HAVE WORKED WHERE IT WAS. `subPhase` sat on the ABILITY, and the D&H is one ability
// spanning two steps -- its tile is a Track action, its free station a Tokens action. An ability-level field
// cannot express that, which is very likely why it was never wired up. Moving it onto the ACTION is what
// makes the question answerable at all.
//
// A SPENT POWER IS NOT CONTEXT. #349's "a disabled row is useful context rather than noise" was argued for a
// SHORT wait; #470 found the limit when the wait is a different round. A power that is gone for the rest of
// the game is not a wait at all.
//
// ==================================================================
//  DESIGN NOTE 807 (harness): #782 MOVED THE FIELD AND LEFT THE OLD READER
// ==================================================================
//
// REPORTED: "DH's Special Power is two parts: a Lay Track action that consumes the owning corporation's Lay
// Track subphase, and then a free bonus Place Station action that does not consume its Place Station
// subphase. Right now, I was able to correctly use the Lay Track action and was bumped into the Place Station
// action, but the Special Power for Place Station is grayed out and I cannot test if it allows the
// corporation to place TWO stations in one turn."
//
// THE PANEL HAD TWO STEP GATES READING TWO DIFFERENT FIELDS. #782 put the step on the ACTION and taught the
// FILTER to read it. It did not remove the one on the ABILITY, which `reason` was still reading to decide
// whether to GREY the button. The D&H's ability said "Track"; its `dh-token` action said "Tokens". On the
// Tokens step the action passed the filter and was disabled by the reason -- the right button, in the right
// step, greyed out with a tooltip naming a step the player had just left.
//
// AND THIS FILE IS WHY IT SURVIVED A HARNESS. Everything below reproduces the FILTER and asserts against the
// copy, so it could only ever confirm the half that was fixed. The panel had a second question about the same
// fact and nothing here knew it existed. The assertions added at the bottom are about ENABLEMENT, and they
// are source scans on purpose: a reproduction of the rule would have passed this bug too.
//
// THE FIX IS A DELETION, twice over. The ability-level field is gone, and so is `reason` -- whose OTHER arm
// ("Only usable during an Operating Round") had been unreachable since #470 made the round filter
// unconditional. One arm dead, one arm wrong.

import { PRIVATE_ABILITIES } from "../components/PrivatePowerPanel";

const CSL = 2;
const DH = 3;

const abilityFor = (privateId: number) =>
  PRIVATE_ABILITIES.find((entry) => entry.privateId === privateId)!;

/** The panel's source, comment-stripped.
 *
 *  #490a: the notes quote the round-only gate, the ability-level `subPhase` and the deleted `reason` while
 *  explaining what replaced them, so every scan below runs on a copy with the prose removed.
 *  AT MODULE SCOPE because #807's assertions are about enablement and #782's are about the filter, and both
 *  read the same file -- it was declared inside one `describe`, which is a fine place for it right up until a
 *  second block needs it and fails with `PANEL is not defined`. */
const PANEL = (() => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs
    .readFileSync(path.join(__dirname, "..", "components", "PrivatePowerPanel.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
})();

/** The panel's own filter, reproduced over the catalog: what survives at this step, given these spends. */
const liveActions = (privateId: number, orSubPhase: string | null, used: ReadonlySet<string>) =>
  abilityFor(privateId)
    .actions.filter(
      (action) =>
        !used.has(action.key) &&
        (action.subPhase === undefined || action.subPhase === orSubPhase),
    )
    .map((action) => action.key);

const NONE: ReadonlySet<string> = new Set();

describe("every corporate action names its step", () => {
  it("puts both tile lays on Track", () => {
    expect(abilityFor(CSL).actions.map((a) => a.subPhase)).toEqual(["Track"]);
    expect(abilityFor(DH).actions.find((a) => a.key === "dh-tile")?.subPhase).toBe("Track");
  });

  it("gives each power one entry point, not one per step (design note #849)", () => {
    /* THE PANEL'S `dh-token` ACTION IS GONE, and #782's property is not. That note put the free station on
       the Tokens step so "the step stays open AND the button is on screen when it does"; #848's flow modal
       is the surface that walks the two steps now, and it reaches the station step during Tokens exactly as
       the button did.
       #442 SPLIT THIS INTO TWO BUTTONS for a reason that still holds -- "the rulebook grants the tile and
       the token independently" -- and the modal expresses it BETTER: two lines with their own buttons, the
       second greyed until the first is done, which two peer buttons on a panel could only imply.
       WHAT WOULD BE A REGRESSION is the step-skipper forgetting the placement exists, so that is asserted
       directly rather than through the button that used to imply it. */
    expect(abilityFor(DH).actions).toHaveLength(1);
    expect(abilityFor(DH).actions[0].key).toBe("dh-tile");
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const tokens = fs.readFileSync(path.join(__dirname, "stationTokens.ts"), "utf8");
    expect(tokens).toContain("extraTokenAvailable");
    expect(fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8")).toContain(
      "stationPlacementBlockReason({",
    );
  });

  it("leaves no corporate action unassigned", () => {
    /* An action with no step shows everywhere, which is the bug. Asserted across the catalog so a power added
       later has to make the decision rather than inherit the old behaviour. */
    for (const ability of PRIVATE_ABILITIES) {
      if (ability.scope !== "corporation") continue;
      for (const action of ability.actions) {
        expect(action.subPhase).toBeDefined();
      }
    }
  });
});

describe("the panel is empty where nothing can be done", () => {
  it("offers nothing during Run Routes", () => {
    /* THE REPORT. Neither power has a Routes action, so nothing survives the filter and the panel renders
       null -- its own #2 rule: "nothing owned means nothing to say". */
    expect(liveActions(CSL, "Routes", NONE)).toEqual([]);
    expect(liveActions(DH, "Routes", NONE)).toEqual([]);
  });

  it("offers nothing during Dividends or Hardware either", () => {
    for (const step of ["Dividends", "Hardware"]) {
      expect(liveActions(CSL, step, NONE)).toEqual([]);
      expect(liveActions(DH, step, NONE)).toEqual([]);
    }
  });

  it("offers the lays on Track", () => {
    // THE CONTROL: a filter that hid the powers everywhere would satisfy the report and break the feature.
    expect(liveActions(CSL, "Track", NONE)).toEqual(["csl-tile"]);
    expect(liveActions(DH, "Track", NONE)).toEqual(["dh-tile"]);
  });

  it("offers nothing on Tokens, because the flow is what asks there", () => {
    /* #849: the panel is an ENTRY POINT and the entry is on Track. A D&H that has laid its tile is carried
       to the station question by `activePowerFlow`, which raises the modal whether or not anybody asked --
       so a second control here would be a second way into one question. */
    expect(liveActions(DH, "Tokens", NONE)).toEqual([]);
  });
});

describe("a spent power stops being displayed", () => {
  it("drops the C&StL once its lay is taken", () => {
    expect(liveActions(CSL, "Track", new Set(["csl-tile"]))).toEqual([]);
  });

  it("drops the D&H's entry once its lay is taken", () => {
    /* THE PROPERTY THIS GUARDED -- that spending the lay is exactly when the token becomes available
       (`dhPower.ts` #725), so the power must not vanish at the moment it is finally usable -- MOVED WITH THE
       CONTROL. `privatePowerFlow.test.ts` asserts the station step goes live on `layDone`, which is the same
       rule where the buttons now are. Here, the entry point is spent. */
    expect(liveActions(DH, "Track", new Set(["dh-tile"]))).toEqual([]);
    expect(liveActions(DH, "Tokens", new Set(["dh-tile"]))).toEqual([]);
  });

  it("drops the D&H entirely once both halves are spent", () => {
    const both = new Set(["dh-tile", "dh-token"]);
    for (const step of ["Track", "Tokens", "Routes"]) {
      expect(liveActions(DH, step, both)).toEqual([]);
    }
  });
});

describe("the panel is wired to the filter", () => {
  it("filters actions by the step and by what is spent", () => {
    expect(PANEL).toContain("!usedAbilities.has(action.key)");
    expect(PANEL).toContain("action.subPhase === orSubPhase");
  });

  it("drops an ability with nothing left in it", () => {
    /* Rather than rendering a "Private Powers" heading over an empty list, which is #2's complaint about a
       permanent empty panel wearing a different hat. */
    expect(PANEL).toContain("entry.ability.actions.length > 0");
  });

  it("keeps the round gate as well", () => {
    // #470: a power is shown in its own round or not at all. The step filter narrows that, it does not replace it.
    expect(PANEL).toContain("roundType === entry.ability.phase");
  });
});

describe("the step is asked once (design note #807)", () => {
  it("no longer lets an ability name a step", () => {
    /* THE FIELD THAT GREYED THE BUTTON. A power spanning two steps has no single right value for it, so the
       only safe number of ability-level step fields is zero -- otherwise the next two-step power repeats
       this exactly, and it will compile. */
    for (const ability of PRIVATE_ABILITIES) {
      expect(ability).not.toHaveProperty("subPhase");
    }
  });

  it("does not declare one on the type either", () => {
    /* The entries above could be right today and the field still be there to be filled in tomorrow. Asserted
       on the interface, in the region between `scope` and `hideOutOfRound` where it used to sit. */
    const abilityType = PANEL.slice(
      PANEL.indexOf("export interface PrivateAbility {"),
      PANEL.indexOf("export const PRIVATE_ABILITIES"),
    );
    expect(abilityType).toContain("scope: AbilityScope;");
    expect(abilityType).not.toContain("subPhase?: OperatingSubPhase;");
  });

  it("keeps the field on the action, where a two-step power can use it", () => {
    // The control: deleting BOTH would satisfy the assertion above and un-fix #782.
    const actionType = PANEL.slice(
      PANEL.indexOf("export interface PrivateAbilityAction {"),
      PANEL.indexOf("export interface PrivateAbility {"),
    );
    expect(actionType).toContain("subPhase?: OperatingSubPhase;");
  });
});

describe("what greys a button, now that the clock does not (design note #807)", () => {
  /* SOURCE SCANS, DELIBERATELY. Everything above this point reproduces the panel's filter and checks the
     copy -- which is exactly why it passed while the panel was greying a live button. `privateOffer.test.ts`
     #662 records the same lesson in the same words: "a local copy of a rule passes whatever the real one
     does, and would have gone on passing through the exact regression it was written to catch."
     So these read the panel. What they assert is narrow enough to survive a reformat and specific enough to
     fail if the shadowing term comes back. */

  it("asks the per-action block first", () => {
    /* #725's sentence -- "lay the F16 tile first" -- is the one thing that can usefully appear on a greyed
       D&H button. `reason` sat in front of it in the `??` chain and shadowed it whenever it fired, so in the
       Tokens step the player got a message about the Track step instead. */
    expect(PANEL).toContain("blockedActions?.[action.key] ??");
    expect(PANEL).not.toContain("reason ??");
  });

  it("computes no round or step reason at all", () => {
    /* BOTH ARMS DELETED. The round arm was unreachable -- `owned` filters on `roundType === ability.phase`,
       so `inPhase` was true by construction (#788: an arm that cannot fire passes every test written for
       it). The step arm was the reported bug. */
    expect(PANEL).not.toContain("const inSubPhase");
    expect(PANEL).not.toContain("const inPhase");
    expect(PANEL).not.toContain("Only usable during the");
  });

  it("leaves the two questions that are about the power rather than the clock", () => {
    // THE CONTROL. A panel that greyed nothing would satisfy both assertions above and hand a president a
    // live "Place Station for $0" button before they had laid the tile.
    expect(PANEL).toContain("const used = usedAbilities.has(action.key);");
    expect(PANEL).toContain('(used ? "Already used this game." : null)');
    expect(PANEL).toContain("disabled={blocked !== null || !controlsEnabled}");
  });

  it("still routes the D&H's ordering through dhPower", () => {
    /* The rule itself is unchanged and is tested in `dhPower.test.ts`: the token is unreachable until the lay
       is taken, and available the moment it is. What #807 fixes is that the answer now arrives. */
    const app = (() => {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      return fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    })();
    expect(app).toContain('"dh-token": dhPower.tokenBlockedReason');
    expect(app).toContain('layUsed: usedPrivateAbilities.has("dh-tile")');
  });
});
