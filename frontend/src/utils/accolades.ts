// frontend/src/utils/accolades.ts
//
// ==================================================================
//  DESIGN NOTE 1416: THE ACCOLADES ARE A CATALOGUE AND A SELECTION, NOT A LIST
// ==================================================================
//
// ASKED: nineteen more accolades, "obviously far too many", with the question of how to pick which are shown
// -- and a ceremony that shows them one at a time, corporate first, each landing on the player who earned it.
//
// TWO TIERS. A CORE of five appears in every game: the winner's own (Robber Baron), the best single run, the
// busiest builder, the busiest trader, and the hardest-working corporation. Everything else is SITUATIONAL:
// computed every game, but shown only when it was actually notable -- one player holds it alone, the figure
// clears a floor (a Fundraiser needs a forced buy; a Salvager needs a trade-in; a Scrooge needs a real hoard),
// and it beat the runner-up by enough to be a story rather than a coin flip. The eligible ones are ranked by
// that margin and the top few of each scope make the ceremony, with a nudge toward players who have nothing yet
// so the awards spread across the table instead of piling on the winner.
//
// THE CATALOGUE IS DATA. `gameHistory.ts` produces the figures (it is the one place that replays the log);
// this module owns the names, the sentences, the floors and the selection, so a new accolade is one row here
// and one tally there, and the ceremony never has to be told about it.
//
// PHASE RUSHER, EARLY ADOPTER AND GRAVEDIGGER READ THE SAME EVENTS AND ARE NOT THE SAME AWARD, which was ruled
// explicitly: the Rusher is the player whose purchases moved the phase, the Adopter is the corporation that
// bought the first Diesel, the Gravedigger is the player whose fleets were rusted out from under them.

export type AccoladeScope = "player" | "corporation";

export type AccoladeKey =
  // core
  | "robber-baron"
  | "master-of-the-line"
  | "track-boss"
  | "market-manipulator"
  | "workhorse"
  // situational, player
  | "gravedigger"
  | "rust-belt"
  | "train-robber"
  | "the-wall"
  | "phase-rusher"
  | "fundraiser"
  | "corporate-raider"
  | "mr-monopoly"
  | "mountain-mover"
  | "last-call"
  | "scrooge"
  | "paper-millionaire"
  | "carcosan-railways"
  | "redeemer"
  | "bagholder"
  | "wrong-way-down"
  | "orphanage"
  | "passenger"
  | "greater-fool"
  | "human-stop-loss"
  | "farmhand"
  // situational, corporation
  | "early-adopter"
  | "capitalist-pig"
  | "fleet-admiral"
  | "shell-corporation"
  | "salvager"
  | "juggernaut"
  | "golden-goose"
  | "dividend-machine"
  | "little-engine"
  | "white-elephant"
  | "comeback-kid"
  // #1438
  | "scrooge-company"
  | "salt-daddy"
  | "sugar-daddy"
  | "railroad-baron";

export interface AccoladeSpec {
  key: AccoladeKey;
  title: string;
  /** One sentence, the ceremony's caption. */
  blurb: string;
  scope: AccoladeScope;
  core: boolean;
  /** The least a figure may be and still count (a situational accolade with nothing behind it is not shown). */
  floor: number;
  /** "lowest" accolades rank the other way -- the Shell Corporation is the SMALLEST price. */
  direction: "highest" | "lowest";
  /* ==================================================================
      DESIGN NOTE 1424: RARITY, AS A PRIOR UNTIL THERE ARE GAMES TO COUNT
     ==================================================================
     ASKED: "for the optional/rotating ones it would be worthwhile to select the rarest Accolades that are
     eligible ... we may need to look at actual game data to calculate rarity." Two finished logs exist
     (CV4, Z6C) -- enough to see that six awards fire in every game and the sign's fire in one -- not enough
     for a rate. So `expected` is the fraction of games this is EXPECTED to be eligible in, set by hand from
     the rule (an award that needs a variant, a forced buy or a die roll is rarer than one every game has a
     leader for), and `eligibilityRates` below measures the real figure off histories so the priors can be
     replaced once there are twenty games to count. Core awards carry 1 and are unaffected. */
  expected: number;
}

export const ACCOLADE_SPECS: readonly AccoladeSpec[] = [
  { key: "robber-baron", title: "Robber Baron", scope: "player", core: true, floor: 1, direction: "highest", expected: 1,
    blurb: "Collected the most in dividends over the whole game." },
  { key: "master-of-the-line", title: "Master of the Line", scope: "player", core: true, floor: 1, direction: "highest", expected: 1,
    blurb: "Presided over the single most valuable train run of the game." },
  { key: "track-boss", title: "Track Boss", scope: "player", core: true, floor: 1, direction: "highest", expected: 1,
    blurb: "Laid the most tiles and tokens across every corporation they ran." },
  { key: "market-manipulator", title: "Market Manipulator", scope: "player", core: true, floor: 1, direction: "highest", expected: 1,
    blurb: "Bought and sold the most certificates." },
  { key: "workhorse", title: "The Workhorse", scope: "corporation", core: true, floor: 1, direction: "highest", expected: 1,
    blurb: "Ran the highest lifetime revenue of any corporation." },

  /* #1422: TWO AWARDS FOR OBSOLESCENCE, RULED APART. The Gravedigger is the one who SENDS trains to the
     scrapheap -- whose purchases turned the phase and rusted or crowded out everybody else's fleet. The Rust
     Belt is the one who LOST the most to it. Both in dollars, not counts; neither counts the Yellow Sign's
     takings (the Mark and the Fog are the sign's story, not obsolescence). */
  { key: "gravedigger", title: "Gravedigger", scope: "player", core: false, floor: 1, direction: "highest", expected: 0.6,
    blurb: "Bought the trains that sent the most of the table's rolling stock to the scrapheap." },
  { key: "rust-belt", title: "The Rust Belt", scope: "player", core: false, floor: 1, direction: "highest", expected: 0.6,
    blurb: "Lost the most, in dollars, to rust and the train limit." },
  { key: "train-robber", title: "Train Robber", scope: "player", core: false, floor: 1, direction: "highest", expected: 0.1,
    blurb: "Dumped a trainless presidency on somebody else." },
  { key: "the-wall", title: "The Wall", scope: "player", core: false, floor: 1, direction: "highest", expected: 0.3,
    blurb: "Filled the last slot of a city another corporation was running through." },
  { key: "phase-rusher", title: "Phase Rusher", scope: "player", core: false, floor: 2, direction: "highest", expected: 0.6,
    blurb: "Bought the trains that moved the game into its next phase." },
  { key: "fundraiser", title: "Fundraiser", scope: "player", core: false, floor: 1, direction: "highest", expected: 0.3,
    blurb: "Paid the most out of their own pocket to keep a corporation in trains." },
  { key: "corporate-raider", title: "Corporate Raider", scope: "player", core: false, floor: 1, direction: "highest", expected: 0.3,
    blurb: "Took the most presidencies off other players in the stock market." },
  { key: "mr-monopoly", title: "Mr. Monopoly", scope: "player", core: false, floor: 2, direction: "highest", expected: 0.6,
    blurb: "Held the most presidencies at the end." },
  { key: "mountain-mover", title: "The Mountain Mover", scope: "player", core: false, floor: 1, direction: "highest", expected: 0.9,
    blurb: "Spent the most on terrain -- mountains, rivers and the rest." },
  { key: "last-call", title: "Last Call", scope: "player", core: false, floor: 1, direction: "highest", expected: 0.9,
    blurb: "Laid the last copy of a tile more often than anyone." },
  // #1423: renamed from "The Scrooge"; the key stays so nothing else moves.
  { key: "scrooge", title: "Moneybags", scope: "player", core: false, floor: 51, direction: "highest", expected: 0.3,
    blurb: "Finished with more than half of their worth in cash." },
  { key: "paper-millionaire", title: "The Paper Millionaire", scope: "player", core: false, floor: 70, direction: "highest", expected: 0.5,
    blurb: "Finished with almost everything they owned tied up in stock." },
  /* #1421: the Yellow Sign's two. A president who lived through any of the sequence -- the Mark, the gift, the
     fog -- without paying the Blood Price; and the one who paid it, buying the Carcosan train off them.
     UR-6 (Appendix B item 13; OD-UR-5(b), D-50): THE WORDS, NOT THE AWARD. The blurb read "never paid the Blood Price
     to be rid of it", as if the Carcosan president could pay to be rid of the train. The Blood Price is the BUYER's
     -- the buyer pays it and is The Redeemer -- so a seller released by another corporation's Blood Price still saw
     the Sign and never paid it, and keeps this award (UR-5 pinned the logic, `unpredictableRevenueStats`). The
     qualification is unchanged; the sentence now says what it measures. The Redeemer's already named the buyer. */
  { key: "carcosan-railways", title: "Carcosan Railways", scope: "player", core: false, floor: 1, direction: "highest", expected: 0.1,
    blurb: "Saw the Yellow Sign touch their railroad, and never paid a Blood Price to buy a gold-trimmed train." },
  { key: "redeemer", title: "The Redeemer", scope: "player", core: false, floor: 1, direction: "highest", expected: 0.05,
    blurb: "Paid the Blood Price and took the Carcosan train off another corporation." },
  /* ==================================================================
      DESIGN NOTE 1429: THE ANTI-AWARDS, AND FIVE MORE FOR THE CORPORATIONS
     ==================================================================
     SUPPLIED as two lists and reviewed award by award. What stayed, with the rule each was given:
       Bagman -- largest loss against starting cash. Wrong Way Down -- largest fall from the player's own peak,
       floored at a quarter. Orphanage -- most certificates in corporations they do not run. Passenger -- most
       dividends from corporations they never ran. Greater Fool / Human Stop-Loss -- paper lost on a buy, or
       forgone on a sell, measured against the next Stock Round's price; "immediately before" became "before
       the next SR", the unit the market moves in. Farmhand -- most animal lines on their runs, which is the
       Unpredictable Revenue flavour read back off the same seed.
       Juggernaut -- the biggest single run. Golden Goose -- most dividends paid. Dividend Machine -- most
       per round operated (Efficiency Expert retired: the two went to the same corporation). White Elephant --
       the fleet that fell furthest short of earning its own price (#1431: PAYBACK, `revenue - train spend`;
       a per-round rate had no baseline and called a $900 Diesel run once "efficient"). Little Engine -- the
       smallest float that earned back its float and its trains. Comeback Kid -- the largest climb from a
       post-float low to the finish.
     Dropped: Sleeper (same shape as Comeback Kid), Spectator ("least impact" is not a number, and it would
     land on the newest player), Trainspotter (White Elephant's twin), Express and Luxury Line (the same
     corporation as Dividend Machine and Juggernaut in practice). */
  { key: "bagholder", title: "The Bagholder", scope: "player", core: false, floor: 1, direction: "highest", expected: 0.7,
    blurb: "Finished holding stocks that lost value over the last two sets of Operating Rounds." },
  { key: "wrong-way-down", title: "The Wrong Way Down", scope: "player", core: false, floor: 25, direction: "highest", expected: 0.4,
    blurb: "Suffered the largest fall from their own peak net worth." },
  { key: "orphanage", title: "The Passenger", scope: "player", core: false, floor: 3, direction: "highest", expected: 0.8,
    blurb: "Ended holding the most certificates in corporations they did not run." },
  { key: "passenger", title: "The Hobo", scope: "player", core: false, floor: 1, direction: "highest", expected: 0.9,
    blurb: "Collected the most in dividends from corporations they did not run." },
  { key: "greater-fool", title: "The Greater Fool", scope: "player", core: false, floor: 100, direction: "highest", expected: 0.5,
    blurb: "Bought the most stock just before its price fell." },
  { key: "human-stop-loss", title: "The Panic Seller", scope: "player", core: false, floor: 100, direction: "highest", expected: 0.4,
    blurb: "Sold the most stock just before its price rose." },
  { key: "farmhand", title: "The Cowboy", scope: "player", core: false, floor: 2, direction: "highest", expected: 0.3,
    blurb: "Had the most run-ins with animals on the line." },

  { key: "early-adopter", title: "The Early Adopter", scope: "corporation", core: false, floor: 1, direction: "highest", expected: 0.6,
    blurb: "The first corporation to buy a Diesel." },
  { key: "scrooge-company", title: "The Scrooge Company", scope: "corporation", core: false, floor: 2, direction: "highest", expected: 0.9,
    blurb: "Withheld its dividends more often than any other corporation." },
  { key: "fleet-admiral", title: "Fleet Admiral", scope: "corporation", core: false, floor: 2, direction: "highest", expected: 0.9,
    blurb: "Bought more trains than any other corporation." },
  { key: "shell-corporation", title: "The Shell Corporation", scope: "corporation", core: false, floor: 1, direction: "lowest", expected: 0.9,
    blurb: "Floated, operated, and finished with the lowest share price on the board." },
  { key: "salvager", title: "The Salvager", scope: "corporation", core: false, floor: 1, direction: "highest", expected: 0.3,
    blurb: "Traded in the most trains." },
  { key: "juggernaut", title: "The Juggernaut", scope: "corporation", core: false, floor: 1, direction: "highest", expected: 0.9,
    blurb: "Ran the single biggest Operating Round of the game." },
  { key: "golden-goose", title: "The Golden Goose", scope: "corporation", core: false, floor: 2, direction: "highest", expected: 0.9,
    blurb: "Paid out its dividends more often than any other corporation." },
  { key: "dividend-machine", title: "The Dividend Machine", scope: "corporation", core: false, floor: 1, direction: "highest", expected: 0.9,
    blurb: "Paid its shareholders the most in dividends." },
  { key: "little-engine", title: "The Little Engine", scope: "corporation", core: false, floor: 1, direction: "lowest", expected: 0.6,
    blurb: "The smallest float that earned back both its float and its trains." },
  { key: "white-elephant", title: "The White Elephant", scope: "corporation", core: false, floor: 1, direction: "highest", expected: 0.5,
    blurb: "Spent more on trains than it ever earned back." },
  { key: "comeback-kid", title: "The Comeback Kid", scope: "corporation", core: false, floor: 30, direction: "highest", expected: 0.6,
    blurb: "Climbed the furthest from its lowest share price to the finish." },

  /* ==================================================================
      DESIGN NOTE 1438: THE RENAMES, THE BAGHOLDER, THE PIG, AND THE TWO DADDIES
     ==================================================================
     RULED, in one list: the Robber Baron keeps his name, and RAILROAD BARON is a new award -- "most
     corporations controlled over the course of the game": the number of different corporations a player
     was president of at any point (Mr. Monopoly is the count at the END). "Manifest Destiny" was floated
     for Track Boss and is a loaded phrase for some tables; Track Boss stays. Moneybags reads "more than half" (floor 51%). Paper
     Millionaire's floor drops to 70% -- "the game ends after a set of operating rounds, so players usually
     have a considerable amount of cash without a Stock Round to spend them on". The Bagman ("players start
     with 2400/n, and even players who play very poorly end with net worth above that") becomes THE
     BAGHOLDER: stock held at the end that fell over the last two Operating Round sets, counting only a
     loss of at least 5% of the player's final net worth. The Orphanage is retitled The
     Passenger and the old Passenger The Hobo; Human Stop-Loss is The Panic Seller; Farmhand is The Cowboy.
     The corporate Capitalist Pig (withheld most) is THE SCROOGE COMPANY, and THE CAPITALIST PIG is a new
     player award: the most made on share prices. The Golden Goose is now the corporation that paid out
     the most TIMES (the Scrooge Company's mirror) and the Dividend Machine the one that paid its
     shareholders the most in total (treasury's own share excluded).
     SALT DADDY and SUGAR DADDY: the president whose corporations bought trains off other corporations
     below (Salt) or above (Sugar) the depot price, at least twice; ties on the count break on the total
     saved or overspent. The two never go to one player -- whoever leads both keeps the one with the larger
     total and the other passes to the next in line. Keys are stable where a title changed (`orphanage`
     is titled The Passenger; the sounds and glyphs follow the key). */
  { key: "capitalist-pig", title: "The Capitalist Pig", scope: "player", core: false, floor: 1, direction: "highest", expected: 0.9,
    blurb: "Made the most on share prices -- bought low, then sold or held high." },
  { key: "salt-daddy", title: "Salt Daddy", scope: "player", core: false, floor: 2, direction: "highest", expected: 0.3,
    blurb: "Bought the most trains off other corporations below the depot price." },
  { key: "sugar-daddy", title: "Sugar Daddy", scope: "player", core: false, floor: 2, direction: "highest", expected: 0.3,
    blurb: "Paid over the depot price for other corporations' trains more than anyone." },
  { key: "railroad-baron", title: "Railroad Baron", scope: "player", core: false, floor: 2, direction: "highest", expected: 0.7,
    blurb: "Ran the most different corporations over the course of the game." },
];

export const ACCOLADE_SPEC_BY_KEY: ReadonlyMap<AccoladeKey, AccoladeSpec> = new Map(
  ACCOLADE_SPECS.map((spec) => [spec.key, spec]),
);

/** One accolade's result for one game. `holder` is a player address -- for a corporate accolade, the
 *  corporation's president -- and `null` when nobody qualified, in which case `detail` is "". */
export interface Accolade {
  key: AccoladeKey;
  title: string;
  blurb: string;
  scope: AccoladeScope;
  core: boolean;
  holder: string | null;
  companyId: number | null;
  ticker: string | null;
  /** The winning figure, in the accolade's own unit. */
  value: number;
  /** The next-best figure, for the margin. `null` when there was nobody else. */
  runnerUp: number | null;
  /** Whether somebody else matched the winning figure exactly. A tied situational accolade is not shown. */
  tied: boolean;
  /** The figure as a phrase: "$1,240 in dividends". */
  detail: string;
}

/** An accolade nobody earned, in the shape the charts expect. */
/** #1424: the measured eligibility rate per accolade across `histories`, for replacing the priors. */
export function eligibilityRates(histories: ReadonlyArray<{ accolades: readonly Accolade[] }>): Map<AccoladeKey, number> {
  const counts = new Map<AccoladeKey, number>();
  for (const history of histories) {
    for (const a of history.accolades) if (accoladeEligible(a)) counts.set(a.key, (counts.get(a.key) ?? 0) + 1);
  }
  const rates = new Map<AccoladeKey, number>();
  for (const spec of ACCOLADE_SPECS) rates.set(spec.key, histories.length === 0 ? 0 : (counts.get(spec.key) ?? 0) / histories.length);
  return rates;
}

export function unearned(key: AccoladeKey): Accolade {
  const spec = ACCOLADE_SPEC_BY_KEY.get(key)!;
  return {
    key, title: spec.title, blurb: spec.blurb, scope: spec.scope, core: spec.core,
    holder: null, companyId: null, ticker: null, value: 0, runnerUp: null, tied: false, detail: "",
  };
}

/** How far ahead the winner was, as a fraction of the larger figure: 1 when unopposed, 0 when tied. */
export function accoladeMargin(a: Pick<Accolade, "value" | "runnerUp">): number {
  if (a.runnerUp === null) return 1;
  const span = Math.max(Math.abs(a.value), Math.abs(a.runnerUp), 1);
  return Math.abs(a.value - a.runnerUp) / span;
}

/** A situational accolade is eligible when somebody earned it alone and the figure clears the floor. A core
 *  accolade is eligible whenever anybody earned it. */
export function accoladeEligible(a: Accolade): boolean {
  if (a.holder === null) return false;
  if (a.core) return true;
  const spec = ACCOLADE_SPEC_BY_KEY.get(a.key);
  if (!spec) return false;
  if (a.tied) return false;
  // A "lowest" accolade's floor is on the field, not the figure: there must be somebody to be lowest than.
  if (spec.direction === "lowest") return a.runnerUp !== null;
  return a.value >= spec.floor;
}

export interface CeremonyLimits {
  corporation: number;
  player: number;
}

export const DEFAULT_CEREMONY_LIMITS: CeremonyLimits = { corporation: 3, player: 4 };

/** The nudge toward a player with nothing yet, added to the margin when ranking. Enough to lift a close
 *  second past a comfortable first, not enough to promote a coin flip over a rout. */
const SPREAD_BONUS = 0.25;

/** #1424: the ranking score. Margin (0-1) says how decisively it was won; rarity (1 - expected, 0-0.95) says
 *  how seldom there is anything to win; the spread nudge is as before. A once-a-season award with a modest
 *  margin outranks an every-game award with a comfortable one, which is the ruling. */
export function accoladeScore(a: Accolade, unawardedHolder: boolean): number {
  const expected = ACCOLADE_SPEC_BY_KEY.get(a.key)?.expected ?? 1;
  return accoladeMargin(a) + (1 - expected) + (unawardedHolder ? SPREAD_BONUS : 0);
}

/* ==================================================================
    THE SELECTION, AND THE ORDER IT IS SHOWN IN
   ==================================================================
   CORE FIRST, ALWAYS, in both scopes. Then the situational ones by score (#1424: margin plus rarity), greedily, with the spread bonus
   re-evaluated after each pick (so the bonus goes to whoever still has nothing). The ceremony order is the
   award-show order: corporate awards, then player awards, and the Robber Baron last -- it is the winner's,
   and the finale. Within a scope the core ones come after the situational ones for the same reason: the
   smaller stories first, the headline last. */
export function selectCeremony(
  accolades: readonly Accolade[],
  players: readonly string[],
  limits: CeremonyLimits = DEFAULT_CEREMONY_LIMITS,
): Accolade[] {
  const eligible = accolades.filter(accoladeEligible);
  const core = eligible.filter((a) => a.core);
  const awarded = new Map<string, number>(players.map((p) => [p, 0]));
  for (const a of core) if (a.holder) awarded.set(a.holder, (awarded.get(a.holder) ?? 0) + 1);

  const pickScope = (scope: AccoladeScope, limit: number): Accolade[] => {
    const pool = eligible.filter((a) => !a.core && a.scope === scope);
    const chosen: Accolade[] = [];
    while (chosen.length < limit && pool.length > 0) {
      let bestAt = -1;
      let bestScore = -Infinity;
      pool.forEach((a, at) => {
        const score = accoladeScore(a, a.holder !== null && (awarded.get(a.holder) ?? 0) === 0);
        if (score > bestScore) {
          bestScore = score;
          bestAt = at;
        }
      });
      const [picked] = pool.splice(bestAt, 1);
      chosen.push(picked);
      if (picked.holder) awarded.set(picked.holder, (awarded.get(picked.holder) ?? 0) + 1);
    }
    return chosen;
  };

  const corporate = pickScope("corporation", limits.corporation);
  const player = pickScope("player", limits.player);

  /* ==================================================================
      DESIGN NOTE 1426: EVERY PLAYER GETS AT LEAST ONE
     ==================================================================
     RULED: "Accolades needs to give every player at least one award." The spread nudge made it likely; this
     makes it certain. A player still empty-handed after the picks above gets their best-scoring accolade
     among the ones they HOLD -- eligible ones first (unique, above the floor), then any they lead even if
     tied or below the floor, because "held the most presidencies, tied" is still theirs. It is appended to
     its scope's list past the cap; the cap was about crowding, and one card for a player who would
     otherwise watch the whole ceremony from the bench is not crowding. A corporate accolade counts for its
     president, since that is who it lands on. A player who holds nothing at all (rare: twenty-five awards,
     four to seven players) stays without one -- there is nothing honest to give. */
  const chosen = new Set<AccoladeKey>([...core, ...corporate, ...player].map((a) => a.key));
  for (const address of players) {
    if ((awarded.get(address) ?? 0) > 0) continue;
    const mine = accolades.filter((a) => a.holder === address && !a.core && !chosen.has(a.key));
    const best = [...mine.filter(accoladeEligible), ...mine].sort((x, y) => accoladeScore(y, true) - accoladeScore(x, true))[0];
    if (!best) continue;
    chosen.add(best.key);
    awarded.set(address, 1);
    (best.scope === "corporation" ? corporate : player).push(best);
  }
  const coreCorporate = core.filter((a) => a.scope === "corporation");
  const corePlayer = core.filter((a) => a.scope === "player" && a.key !== "robber-baron");
  const finale = core.filter((a) => a.key === "robber-baron");
  return [...corporate, ...coreCorporate, ...player, ...corePlayer, ...finale];
}
