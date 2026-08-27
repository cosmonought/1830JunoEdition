/** @jest-environment node */
//
// The rotate odometer: which facing next, and which city the acting token sits in. Pure; no DOM.
//
// ==================================================================
//  DESIGN NOTE 889 (harness): THE THING A GREP COULD NOT CHECK
// ==================================================================
//
// `handlePreviewRotate` HELD FOUR RULES IN ONE `setPreviewTile` UPDATER -- #173's wrapping facing list,
// #824's city-as-outer-loop, #879's derive-per-facing, #886's one-derivation-for-every-path -- and the only
// available test was to scan `App.tsx` for their text. A source scan can say the words are present. It cannot
// say that pressing rotate six times on a two-city tile with three legal facings visits six distinct
// arrangements and then returns to the first, which is the entire user-visible contract.
//
// SO THE CENTREPIECE HERE IS A WALK, not a set of spot checks: drive the cycle and compare the whole sequence.
// Two of the three faults below were found by writing that walk down and reading it, not by suspecting them.

import {
  freeCityChoices,
  nextFreeCity,
  nextLegalFacing,
  nextPreviewArrangement,
  seedPreviewArrangement,
  type ActingTokenFit,
  type PreviewArrangement,
} from "./previewRotation";

/** A token with a network: the board decides, and it may decide differently at every facing. */
const anchoredAt = (city: number): ActingTokenFit => ({ ownIsFree: false, ownCity: city });
/** ERIE's home token before it has any track: nothing to preserve, so the president chooses. */
const FREE: ActingTokenFit = { ownIsFree: true, ownCity: undefined };
/** The acting corporation has no token on this hex at all -- an ordinary upgrade of somebody else's city. */
const ABSENT: ActingTokenFit = { ownIsFree: false, ownCity: undefined };

describe("the facing loop (design note #173)", () => {
  it("steps to the next legal angle and wraps", () => {
    expect(nextLegalFacing(0, [0, 2, 4])).toEqual({ orientation: 2, wrapped: false });
    expect(nextLegalFacing(2, [0, 2, 4])).toEqual({ orientation: 4, wrapped: false });
    /* THE WRAP IS THE EVENT THE CITY LOOP LISTENS FOR, so it is reported rather than recomputed by the
       caller from a length -- two callers deriving the same wrap is how they come to disagree. */
    expect(nextLegalFacing(4, [0, 2, 4])).toEqual({ orientation: 0, wrapped: true });
  });

  it("treats a single legal angle as an immediate wrap", () => {
    /* NOT A NO-OP AT THIS LEVEL. The tile cannot turn, but a free token still has a city to cycle, and with
       one facing every press must advance it -- otherwise the gesture does nothing at all on the one board
       state where the president most needs it (a green OO with exactly one legal orientation). */
    expect(nextLegalFacing(3, [3])).toEqual({ orientation: 3, wrapped: true });
  });

  it("has nowhere to go with no legal angles", () => {
    /* #173: "with none it leaves the orientation alone rather than inventing one." */
    expect(nextLegalFacing(0, [])).toBeNull();
  });

  it("snaps to the first legal angle when the current one is not on the list, WITHOUT wrapping", () => {
    /* #879's filter drops any facing that would strand a token, and the board can move under an open
       preview. The recovery must not read as a completed pass -- a free token's city advancing because the
       legality set changed would move a marker the president never touched.
       THE OLD INLINE FORM AGREED BY ACCIDENT: `at + 1 >= length` with `at === -1` is `0 >= length`, false for
       any non-empty list. Same answer, for a reason nobody had written down. */
    expect(nextLegalFacing(5, [0, 2])).toEqual({ orientation: 0, wrapped: false });
  });
});

describe("the city loop (design note #824, narrowed by #879)", () => {
  it("holds the city until the facings wrap", () => {
    expect(nextFreeCity({ current: 0, choices: [0, 1], wrapped: false })).toBe(0);
    expect(nextFreeCity({ current: 1, choices: [0, 1], wrapped: false })).toBe(1);
  });

  it("advances it on the wrap, and wraps itself", () => {
    expect(nextFreeCity({ current: 0, choices: [0, 1], wrapped: true })).toBe(1);
    expect(nextFreeCity({ current: 1, choices: [0, 1], wrapped: true })).toBe(0);
  });

  it("starts the cycle rather than resuming it when nothing has been chosen", () => {
    /* FAULT (a), AND THE FIRST OF THE TWO THE WALK EXPOSED. The inline form read
       `choices.indexOf(current.tokenCity ?? choices[0] ?? -1)`, so "no city yet" resolved to index 0 and the
       next wrap advanced to `choices[1]` -- past a state the president had never been shown. */
    expect(nextFreeCity({ current: undefined, choices: [0, 1], wrapped: true })).toBe(0);
    expect(nextFreeCity({ current: undefined, choices: [0, 1], wrapped: false })).toBe(0);
  });

  it("restarts the cycle when the carried city is no longer on offer", () => {
    /* Same arm, different cause: a candidate with fewer cities than the last one. Resuming from an index
       that is not in the list would be arithmetic on a coincidence. */
    expect(nextFreeCity({ current: 3, choices: [0, 1], wrapped: true })).toBe(0);
  });

  it("leaves a carried city alone when there is nothing on offer", () => {
    /* NOT `undefined`. An empty choice list is a caller that could not answer, not a board that says the
       token has no city -- dropping the marker on a failed lookup is the #886 disagreement again. */
    expect(nextFreeCity({ current: 1, choices: [], wrapped: true })).toBe(1);
  });

  it("never advances a single choice, which is every ordinary upgrade", () => {
    /* #824: "ONE CHOICE MEANS ONE PASS ... the city list has a single entry, the outer loop never advances,
       and `tokenCity` stays put." */
    expect(nextFreeCity({ current: 0, choices: [0], wrapped: true })).toBe(0);
  });
});

describe("the two loops together", () => {
  /** Drive the gesture and record what the president would see, arrangement by arrangement. */
  const walk = (input: {
    from: PreviewArrangement;
    legalRotations: readonly number[];
    fitAt: (orientation: number, chosenCity: number | undefined) => ActingTokenFit;
    cities: readonly number[];
    presses: number;
  }): string[] => {
    let at = input.from;
    const seen = [`${at.orientation}/${at.tokenCity ?? "-"}`];
    for (let i = 0; i < input.presses; i += 1) {
      const next = nextPreviewArrangement({
        current: at,
        legalRotations: input.legalRotations,
        fitAt: input.fitAt,
        freeCityChoices: () => input.cities,
      });
      if (next === null) {
        seen.push("(unchanged)");
        continue;
      }
      at = next;
      seen.push(`${at.orientation}/${at.tokenCity ?? "-"}`);
    }
    return seen;
  };

  it("shows every facing in one city before moving the token", () => {
    /* #824's ORDER, ASSERTED AS A SEQUENCE. "a president sees every facing with the marker in one city
       before it moves -- which is the order the question is actually asked in ('can I get the facing I
       want?' then 'and with the token where?')."
       THE FIXTURE CAN TELL THE TWO ORDERINGS APART, which the handoff lists as a vacuity trap in its own
       right: three facings and two cities give a six-state cycle, and city-inner would produce a visibly
       different string here rather than the same set in a different order. */
    expect(
      walk({
        from: { orientation: 0, tokenCity: 0 },
        legalRotations: [0, 2, 4],
        fitAt: () => FREE,
        cities: [0, 1],
        presses: 6,
      }),
    ).toEqual(["0/0", "2/0", "4/0", "0/1", "2/1", "4/1", "0/0"]);
  });

  it("returns to where it started, so nothing is unreachable", () => {
    /* THE ODOMETER PROPERTY. A cycle that does not close leaves an arrangement the president can see once
       and never get back to -- which is #824's original report ("may lock themselves out of an orientation
       they want and either have to accept suboptimal placement or force the game to undo"). */
    const seen = walk({
      from: { orientation: 0, tokenCity: 0 },
      legalRotations: [0, 2, 4],
      fitAt: () => FREE,
      cities: [0, 1],
      presses: 6,
    });
    expect(seen[6]).toBe(seen[0]);
    expect(new Set(seen.slice(0, 6)).size).toBe(6);
  });

  it("cycles the city alone when the tile has only one legal facing", () => {
    /* THE CASE A FACING-ONLY CYCLE WOULD STRAND. With one legal orientation the gesture would otherwise be a
       no-op, and ERIE's president could never move their token off the city we happened to seed. */
    expect(
      walk({
        from: { orientation: 3, tokenCity: 0 },
        legalRotations: [3],
        fitAt: () => FREE,
        cities: [0, 1],
        presses: 2,
      }),
    ).toEqual(["3/0", "3/1", "3/0"]);
  });

  it("follows the track instead of cycling when the token is anchored", () => {
    /* #879. The destination is "whichever city of THIS facing still owns the token's edges", so it can
       differ at every angle and the president is not choosing at all. */
    const byFacing: Record<number, ActingTokenFit> = {
      0: anchoredAt(0),
      2: anchoredAt(1),
      4: anchoredAt(1),
    };
    expect(
      walk({
        from: { orientation: 0, tokenCity: 0 },
        legalRotations: [0, 2, 4],
        fitAt: (orientation) => byFacing[orientation],
        cities: [0, 1],
        presses: 3,
      }),
    ).toEqual(["0/0", "2/1", "4/1", "0/0"]);
  });

  it("ignores the city list entirely for an anchored token", () => {
    /* THE SIDE DOOR #880 NAMED: "letting the choice win there would put the old bug back". Asserted with a
       choice list present and deliberately disagreeing with the derived city, so a regression that consults
       it is visible rather than merely possible. */
    const step = nextPreviewArrangement({
      current: { orientation: 4, tokenCity: 0 },
      legalRotations: [0, 2, 4],
      fitAt: () => anchoredAt(1),
      freeCityChoices: () => {
        throw new Error("an anchored token must not ask what is on offer");
      },
    });
    expect(step).toEqual({ orientation: 0, tokenCity: 1 });
  });

  it("leaves the marker off when the acting corporation has no token here", () => {
    /* Most upgrades in the game. `ownCity` is `undefined` and stays that way -- there is no marker to place,
       and `freeCityChoices` must not be consulted to invent one. */
    const step = nextPreviewArrangement({
      current: { orientation: 0, tokenCity: undefined },
      legalRotations: [0, 2],
      fitAt: () => ABSENT,
      freeCityChoices: () => [0, 1],
    });
    expect(step).toEqual({ orientation: 2, tokenCity: undefined });
  });

  it("reports nothing to do rather than an equal arrangement", () => {
    /* `null` LETS THE REACT UPDATER RETURN ITS PREVIOUS OBJECT BY IDENTITY and skip the render. Returning an
       equal-but-new object would repaint the canvas on every press of a gesture that changed nothing. */
    expect(
      nextPreviewArrangement({
        current: { orientation: 3, tokenCity: 0 },
        legalRotations: [3],
        fitAt: () => anchoredAt(0),
        freeCityChoices: () => [0],
      }),
    ).toBeNull();
    expect(
      nextPreviewArrangement({
        current: { orientation: 0, tokenCity: 0 },
        legalRotations: [],
        fitAt: () => FREE,
        freeCityChoices: () => [0, 1],
      }),
    ).toBeNull();
  });

  it("asks the fit about the NEXT facing, not the current one", () => {
    /* #878's TELL, IN THE CALL ORDER: "Connectivity is a property of the tile AS LAID, so a signature with no
       rotation in it cannot express the question." Probing the facing the player is leaving would answer
       about a tile that is about to stop existing. */
    const asked: number[] = [];
    nextPreviewArrangement({
      current: { orientation: 0, tokenCity: 0 },
      legalRotations: [0, 2, 4],
      fitAt: (orientation) => {
        asked.push(orientation);
        return anchoredAt(0);
      },
      freeCityChoices: () => [],
    });
    expect(asked).toEqual([2]);
  });
});

describe("the opening arrangement (design note #889, correction b)", () => {
  it("seats a free token at the first city on offer", () => {
    /* FAULT (b), AND THE ONE THAT REACHED THE BOARD. #886 passed `undefined` for the president's choice at
       selection -- right, they have not rotated -- and `tokenLandingsFor` omits a free token with no chosen
       city, so ERIE's opening preview drew NO MARKER. A lay from that state sends neither map nor index and
       `sandboxSession.ts`'s "absent means unchanged" arm leaves the token where it was: the ghost and the
       outcome disagreed, which is the fault #886 was written to close.
       A SEED IS NOT AN INDEX CLAIM. For a token with no network every city is equally legal, so opening at
       the first and letting the president rotate is #824's design -- not #1's superseded preservation. */
    expect(
      seedPreviewArrangement({ orientation: 2, fit: FREE, freeCityChoices: [0, 1] }),
    ).toEqual({ orientation: 2, tokenCity: 0 });
  });

  it("hands an anchored token its derived city untouched", () => {
    /* THE HALF #886 GOT RIGHT, pinned so the fix above cannot swallow it. A choice list is present and
       ignored. */
    expect(
      seedPreviewArrangement({ orientation: 0, fit: anchoredAt(1), freeCityChoices: [0, 1] }),
    ).toEqual({ orientation: 0, tokenCity: 1 });
  });

  it("places no marker when the acting corporation has no token here", () => {
    expect(
      seedPreviewArrangement({ orientation: 0, fit: ABSENT, freeCityChoices: [0, 1] }),
    ).toEqual({ orientation: 0, tokenCity: undefined });
  });

  it("survives a candidate with no cities", () => {
    /* A plain track tile. `freeCityChoices[0]` is `undefined`, which is exactly "no marker" -- but it is
       reached rather than assumed, so a future tile shape cannot turn it into `NaN` or `0`. */
    expect(
      seedPreviewArrangement({ orientation: 0, fit: FREE, freeCityChoices: [] }).tokenCity,
    ).toBeUndefined();
  });

  it("hands the seed straight into the cycle", () => {
    /* THE JOIN BETWEEN THE TWO HALVES. Seeding at `choices[0]` is what makes the first wrap advance to
       `choices[1]`; with the old `undefined` seed the first wrap skipped it. */
    const seed = seedPreviewArrangement({ orientation: 4, fit: FREE, freeCityChoices: [0, 1] });
    expect(
      nextPreviewArrangement({
        current: seed,
        legalRotations: [0, 2, 4],
        fitAt: () => FREE,
        freeCityChoices: () => [0, 1],
      }),
    ).toEqual({ orientation: 0, tokenCity: 1 });
  });
});

describe("which cities a free token may be put in", () => {
  it("is every city the candidate carries", () => {
    expect(freeCityChoices(2)).toEqual([0, 1]);
    expect(freeCityChoices(1)).toEqual([0]);
  });

  it("is empty for a tile with none", () => {
    expect(freeCityChoices(0)).toEqual([]);
    /* A missing catalogue entry returns 0 from `tileCityCount`, so a negative can only arrive from a bug --
       and an empty list is the safe reading of one.
       I WROTE A GUARD FOR THIS AND A COMMENT CLAIMING `Array.from({length: -1})` THROWS. It does not:
       `ToLength` clamps a negative to zero. The negative control removed the guard and this assertion stayed
       GREEN, which is what proved the claim wrong -- the third redundant guard a negative control has deleted
       here (#883). The assertion survives the guard because the PROPERTY is still worth pinning; what changed
       is which line enforces it. */
    expect(freeCityChoices(-1)).toEqual([]);
  });
});

describe("the shell asks the module and keeps only the board", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  };
  const RAW = read("App.tsx");
  /* #490a: the notes below quote the very names this block asserts the ABSENCE of. */
  const APP = RAW.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("rotates through the module", () => {
    const at = APP.indexOf("const handlePreviewRotate");
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, APP.indexOf("[radialSelector, handleDismissRadial", at));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("nextPreviewArrangement({");
    expect(body).toContain("if (step === null) return current;");
    /* THE BOARD LOOKUPS ARE WHAT STAYED, and they are the only thing the module cannot do for itself. */
    expect(body).toContain("fitAt: (orientation, chosenCity) =>");
    expect(body).toContain("freeCityChoices: () => freeCityChoices(tileCityCount(current.tileId)),");
  });

  it("seeds the first preview through the module too", () => {
    const at = APP.indexOf("onSelectCandidate={");
    expect(at).toBeGreaterThan(-1);
    const select = APP.slice(at, APP.indexOf("legalRotationCount=", at));
    expect(select.length).toBeGreaterThan(0);
    expect(select).toContain("seedPreviewArrangement({");
    /* AND THE MAP IS RECOMPUTED FOR THE SEEDED CITY, or the marker is drawn in a city the wire map omits --
       which is the #886 disagreement with the seed's sign reversed. */
    expect(select).toContain("seed.tokenCity,");
    expect(select).toContain("tokenCity: seed.tokenCity,");
  });

  it("has retired the last shell path into the superseded rule", () => {
    /* `tokenDestinationChoices` REACHES `previewTokenMigration`, which #878 superseded and its note says not
       to wire. `stationConnectivity.test.ts` asserts `App.tsx` never names `previewTokenMigration` -- and it
       never did: it named the wrapper, one indirection away. PROVING A SYMBOL LEFT IS NOT PROVING A RULE
       DID, which is why this is asserted on the wrapper as well.
       THE MODULE ITSELF IS NOT DELETED. It keeps its note as the record of the superseded reasoning, and
       `tokenDestination.test.ts` still exercises it. */
    expect(APP).not.toContain("tokenDestinationChoices(");
    expect(APP).not.toContain("previewTokenMigration(");
    /* THE NOTE SAYING WHY SURVIVES ITS OWN TEST -- asserted against RAW, per #490a. */
    expect(RAW).toContain("tokenDestinationChoices");
  });
});
