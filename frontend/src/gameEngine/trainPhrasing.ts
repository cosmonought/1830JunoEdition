// frontend/src/utils/trainPhrasing.ts
//
// How this app says how many trains, and which ones.
//
// ==================================================================
//  DESIGN NOTE 1100: NUMERALS ARE FOR TIERS, WORDS ARE FOR COUNTS
// ==================================================================
//
// RULED: "when dealing with train quantities, let's write out the number of trains and reserve numerals for
// the train tiers. So e.g. 'B&O lost three trains to rust. Three of your 2-Trains have rusted.' seems less
// likely to cause confusion."
//
// AND THE CONFUSION IS REAL AND SPECIFIC, which is why the rule is worth a module. Every train in 1830 is
// named by a numeral -- a 2-train, a 4-train, a D -- so a sentence that also counts in numerals puts two
// unrelated numbers next to each other in the same typeface: "3 of your 2-trains" asks the reader to work out
// which 3 is a quantity and which 2 is a name. Spelling the quantity makes the numeral mean one thing.
//
// ==================================================================
//  DESIGN NOTE 1100: AND THE TWO COPIES OF `namedTrains` ARE NOW ONE
// ==================================================================
//
// `sandboxSession` AND `fleetLossNotice` EACH HELD A COPY, with a note on the second reading: "a second copy
// deliberately ... if a third caller ever wants it, that is the moment to lift it out -- not this one."
//
// A THIRD CALLER IS NOT WHAT HAPPENED. What happened is a RULE CHANGE, which has to reach both copies at once
// or the Activity Log and the modal start describing one loss two ways -- #891, the shape this project pays
// for more than any other. The note named a trigger for lifting and picked the wrong one: duplication is
// cheap until the thing duplicated is a rule somebody can revise.
//
// IDENTICAL MODELS COLLAPSE, which is the other half of the same ruling. The reported modal said "B&O's
// 2-train, 2-train and 2-train are returned to the depot" -- three names for what a player thinks of as
// "three 2-trains", and the exact confusion the rule is about. A list is right for a mixed fleet and wrong
// for a uniform one.

/** Spelled out through twelve, which is past any fleet 1830 permits; numerals beyond that rather than
 *  inventing prose for a number this game cannot reach. */
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
] as const;

/** `3` -> `"three"`. Lower case, because most uses sit mid-sentence; `capitalise` is separate on purpose. */
export function spellCount(n: number): string {
  if (!Number.isInteger(n) || n < 0) return String(n);
  return n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

/** First letter up, for a count that opens a sentence.
 *
 *  Design note #1100: A SEPARATE FUNCTION rather than a flag on `spellCount`, so a caller reads as what it is
 *  doing -- and so the sentence case lives at the sentence, which is the only place that knows it is one. */
export function capitalise(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/** `["2"]` -> `"2-train"`; `["2","2","2"]` -> `"three 2-trains"`; `["2","3"]` -> `"2-train and 3-train"`.
 *
 *  ==================================================================
 *   DESIGN NOTE 1100: A LIST FOR A MIXED FLEET, A COUNT FOR A UNIFORM ONE
 *  ==================================================================
 *
 *  NO "its" PREFIX. The two callers introduce the phrase differently -- `describeFleetLoss` says "its ...",
 *  the modal says "B&O's ..." -- and a helper that assumed one of them would have to be worked around by the
 *  other. The possessive belongs to the sentence.
 *
 *  THE COLLAPSE IS NOT AN OPTIMISATION, it is the ruling: "2-train, 2-train and 2-train" names one thing three
 *  times where a player counts. Mixed fleets keep the list, because there the names are the information. */
export function namedTrains(models: readonly string[]): string {
  if (models.length === 0) return "";
  const first = models[0];
  if (models.every((model) => model === first)) {
    return models.length === 1
      ? `${first}-train`
      : `${spellCount(models.length)} ${first}-trains`;
  }
  const named = models.map((model) => `${model}-train`);
  if (named.length === 2) return `${named[0]} and ${named[1]}`;
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/** `"three trains"` / `"one train"` -- the quantity when the TIER is not being named.
 *
 *  Design note #1100: the headline's phrase. It says how many were lost without saying which, because the
 *  body says which one line later and a title that carried both would be the same fact twice (#1052's rule,
 *  arrived at on a different surface). */
export function countedTrains(n: number): string {
  return `${spellCount(n)} ${n === 1 ? "train" : "trains"}`;
}
