// frontend/src/constants/flavorText.ts
//
// ==================================================================
//  DESIGN NOTE 944: THE VARIANT'S VOICE, KEYED TO THE OUTCOME
// ==================================================================
//
// SUPPLIED VERBATIM and kept that way: this file is a payload, not a derivation. Nothing here is computed,
// nothing is interpolated, and the only reason to edit it is to change what the game says.
//
// WHY IT IS KEYED BY OUTCOME RATHER THAN BY DIE FACE, in the author's own words: "Because your base-10
// rounding logic occasionally swallows a 10% modifier and returns the payout to 100%, we cannot map the
// flavor text strictly to the raw die face. We must map it to the effective outcome."
//
// WHICH IS THE SAME PREDICATE #938 ALREADY OWNS. `revenueOutcome` asks whether the FINAL rounded payout
// differs from the printed figure, not whether the die rolled something other than 100 -- a $50 turn at 90%
// pays $45, rounds back to $50, and must read as an ordinary day. The selector in `gameVariants` asks that
// function; this file only supplies the words.
//
// THE ARRAY LENGTHS ARE LOAD-BEARING. The index rules are `seed % 20` for `unchanged` and `seed % 25` for the
// other four, so a short array would index past its end and put `undefined` into the Activity Log. There is a
// case in `flavorText.test.ts` asserting each length, because a dropped comma during an edit is silent here
// and loud three screens away.

export const UNPREDICTABLE_REVENUE_FLAVOR = {
  criticalMalus: [
    "the day's revenue took an unexpected excursion through the countryside.",
    "the accountants discovered a thrilling new category of expense.",
    "an alarming number of passengers appear to have boarded without purchasing tickets.",
    "the company’s profits were misplaced somewhere between here and Cincinnati.",
    "train robbers made an unscheduled withdrawal from the company treasury.",
    "the books balanced beautifully, provided nobody actually looked at them.",
    "management blamed the weather, and the weather declined to comment.",
    "the treasurer recommended everyone remain calm and stop asking questions.",
    "the railroad had a banner day, though unfortunately the banner was on fire.",
    "train robbers demonstrated the practical dangers of carrying money by rail.",
    "a mysterious, catastrophic leak was discovered in the company’s coffers.",
    "an ambitious fare collector abruptly discovered the limits of optimism.",
    "the boiler pressure gauge turned out to be purely decorative.",
    "the local telegraph operator translated the timetable into Morse code backward.",
    "an entire herd of stubbornly stationary cattle occupied the mainline.",
    "a mid-level clerk quietly embezzled the month's coal budget.",
    "the Pinkertons demanded double pay just to keep the tracks clear of bandits.",
    "a sudden cholera outbreak led to the immediate quarantine of the terminal.",
    "local farmers tore up the rails to protest the noise of the engines.",
    "a poorly timed bridge collapse sent three freight cars directly into the river.",
    "someone intentionally greased the rails on the steepest grade in the mountains.",
    "the state legislature suddenly remembered to collect the regional railway tax.",
    "train robbers relieved the company of 20% of its revenue.",
    "a patent dispute resulted in the federal seizure of the driving wheels.",
    "the train arrived perfectly on time, though unfortunately, the money did not."
  ],
  minorMalus: [
    "the accountants finally discovered that optimism is not legal tender.",
    "a few fares evaporated somewhere between the station and the ledger.",
    "ten percent of the revenue inexplicably went to a better-paying railway.",
    "the conductor reported unusually generous interpretations of 'free travel'.",
    "a handful of pennies mysteriously acquired the status of 'operating expenses'.",
    "the ticket office had a surprisingly successful day selling fares at the wrong price.",
    "the treasurer rounded several figures in a direction most favorable to himself.",
    "the railway’s earnings had to be trimmed for excessive enthusiasm.",
    "Wall Street was firmly advised that 90% is still a very respectable number.",
    "the revenue arrived 10% late and was therefore charged a penalty.",
    "the company lost a little money and gained considerable experience.",
    "a modest revenue decline was blamed entirely on 'market conditions'.",
    "a minor catastrophe was quietly downgraded to an 'adjustment'.",
    "a flock of sheep absolutely refused to yield the right-of-way.",
    "the dining car ran out of whiskey before noon, enraging the first-class travelers.",
    "the local alderman held up the train for a prolonged ribbon-cutting ceremony.",
    "the conductor mislaid his pocket watch and ran the route purely on intuition.",
    "the train was delayed by a slow-moving circus parade crossing the tracks in town.",
    "the coal tender caught fire, but only a little bit.",
    "a rogue spark set a wealthy passenger's bespoke hat ablaze.",
    "local pranksters replaced the signal lanterns with red glass.",
    "a sudden downpour caused a brief flash flood over the tracks.",
    "the local water tower was accidentally drained by thirsty locals.",
    "an eccentric tycoon demanded an unscheduled stop to look at a nice tree.",
    "the trains ran splendidly, though the finances ran somewhat less so."
  ],
  unchanged: [
    "Nothing unexpected happens. The accountants are suspicious.",
    "The railway enjoys the rare luxury of normality.",
    "The trains run, the fares are collected, and nobody gets robbed.",
    "The day passes without financial incident.",
    "The market experiences neither joy nor despair.",
    "A train departs. A train arrives. Money changes hands.",
    "The railway successfully avoids both prosperity and disaster.",
    "The books close without requiring any creative interpretation.",
    "The day’s receipts are neither miraculous nor catastrophic.",
    "Business is conducted with admirable mediocrity.",
    "No robbers, disasters, or miracles disturb the day’s receipts.",
    "The accountants find the books pleasantly boring.",
    "The company achieves the remarkable feat of changing nothing.",
    "Management is pleased to announce absolutely nothing.",
    "The railway neither strikes gold nor loses its shirt.",
    "The railway avoids excitement, which is excellent news for the accountants.",
    "Passengers pay their fares, and everyone behaves themselves.",
    "Nothing happens to the revenue. For once, this is good news.",
    "The railway’s earnings remain as steady as the track.",
    "The treasurer closes the ledger and gets to go home early."
  ],
  minorBonus: [
    "the railway finally discovered that people are willing to pay for this service.",
    "the railway accidentally made itself profitable.",
    "a fortunate combination of full trains and questionable accounting boosted receipts.",
    "business was brisk, and nobody has yet asked why.",
    "ticket sales exceeded expectations by a suspiciously convenient margin.",
    "business was, as the treasurer announced, 'better than we have any right to expect'.",
    "the company discovered the ancient and powerful business strategy of charging money.",
    "management congratulated itself on a plan it had absolutely nothing to do with.",
    "the increased receipts prompted immediate discussion of enormous executive salaries.",
    "a favorable wind blew directly into the corporate coffers.",
    "the company’s treasury enjoyed a modest but welcome expansion.",
    "the market discovered that optimism can, occasionally, be correct.",
    "prosperity arrived promptly and without requiring a connecting train.",
    "a sudden local festival caused a massive surge in third-class ticket sales.",
    "a glorious tailwind across the plains saved half a ton of coal.",
    "the competing stagecoach company tragically broke an axle.",
    "the conductor somehow managed to cram forty extra people into the second-class car.",
    "a local bridge toll was unexpectedly suspended by the governor.",
    "the fireman discovered a vein of exceptionally high-grade anthracite.",
    "a rival company's train was delayed, sending all of their passengers to you.",
    "a mild winter kept the tracks perfectly clear of ice and snow.",
    "the dining car's new menu proved wildly popular with the socialites.",
    "local merchants offered a bounty for the early delivery of their goods.",
    "an aggressive local advertising campaign actually worked for once.",
    "the trains were full, the fares were collected, and nobody lost the ledger."
  ],
  criticalBonus: [
    "the railway apparently discovered where all the money is.",
    "a glorious torrent of revenue flooded the company’s coffers.",
    "passenger demand became briefly indistinguishable from panic.",
    "the treasurer checked the figures three times and liked them every time.",
    "the trains were packed, the fares were flowing, and the executives were insufferable.",
    "revenue climbed like a locomotive with a downhill grade and no brakes.",
    "the company had its best day since someone invented the ticket.",
    "the railway enjoyed an almost suspicious degree of prosperity.",
    "revenue exploded upward, prompting the treasurer to hide the good news from competitors.",
    "the company’s earnings entered the realm of the frankly ridiculous.",
    "the executives are already discussing monuments to themselves.",
    "revenue arrived in such quantities that the accountants required a larger ledger.",
    "business was booming, and management immediately took credit.",
    "the railroad struck financial gold without having to lay another mile of track.",
    "a sudden gold strike in the foothills caused an absolute passenger stampede.",
    "a competitor's bridge collapsed, giving the company a total monopoly for the week.",
    "a massive army deployment required every available flatcar at premium rates.",
    "a major industrialist decided to relocate his entire factory using the railway.",
    "the federal government decided to pay its freight debts in pure silver bullion.",
    "a tycoon bought every first-class ticket just to enjoy the silence.",
    "an unexpected World's Fair exhibit was routed exclusively through the network.",
    "management successfully bribed the state legislature for a massive subsidy.",
    "a speculative land boom caused ticket prices to quadruple overnight.",
    "an incredibly wealthy eccentric rented the entire train for a private party.",
    "a fortunate alignment of the stars and the stock market essentially printed money."
  ]
};
