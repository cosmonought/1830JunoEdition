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

import { PRIVATE_ABILITIES } from "../components/PrivatePowerPanel";

const CSL = 2;
const DH = 3;

const abilityFor = (privateId: number) =>
  PRIVATE_ABILITIES.find((entry) => entry.privateId === privateId)!;

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

  it("puts the D&H's free station on Tokens", () => {
    /* THE CASE THE OLD ABILITY-LEVEL FIELD COULD NOT EXPRESS, and the reason it went unused: one ability,
       two steps. Paired with #781, which taught the step-skipper that this placement exists. */
    expect(abilityFor(DH).actions.find((a) => a.key === "dh-token")?.subPhase).toBe("Tokens");
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

  it("offers the free station on Tokens", () => {
    expect(liveActions(DH, "Tokens", NONE)).toEqual(["dh-token"]);
  });
});

describe("a spent power stops being displayed", () => {
  it("drops the C&StL once its lay is taken", () => {
    expect(liveActions(CSL, "Track", new Set(["csl-tile"]))).toEqual([]);
  });

  it("drops the D&H's tile but keeps its station", () => {
    /* THE HALF THAT MAKES THIS PER-ACTION RATHER THAN PER-ABILITY. Spending the lay is exactly when the token
       becomes available (`dhPower.ts` #725), so dropping the whole ability here would hide the power at the
       moment it is finally usable. */
    expect(liveActions(DH, "Track", new Set(["dh-tile"]))).toEqual([]);
    expect(liveActions(DH, "Tokens", new Set(["dh-tile"]))).toEqual(["dh-token"]);
  });

  it("drops the D&H entirely once both halves are spent", () => {
    const both = new Set(["dh-tile", "dh-token"]);
    for (const step of ["Track", "Tokens", "Routes"]) {
      expect(liveActions(DH, step, both)).toEqual([]);
    }
  });
});

describe("the panel is wired to the filter", () => {
  const PANEL = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(
      path.join(__dirname, "..", "components", "PrivatePowerPanel.tsx"),
      "utf8",
    );
    // #490a: the notes quote the round-only gate while explaining what replaced it.
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  })();

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
