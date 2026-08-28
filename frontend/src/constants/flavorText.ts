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
// ==================================================================
//  DESIGN NOTE 950: ONE TENSE, BECAUSE THEY SHARE A LINE WITH A RESULT
// ==================================================================
//
// ASKED: "in your example, 'B&O ran for $170' the flavor text is written in present tense, the others are in
// past tense. Is this present tense true of all the revenue unchanged flavor text sentences?"
//
// IT WAS TRUE OF ALL TWENTY. Every `unchanged` line was present tense -- "The trains run, the fares are
// collected" -- while all 100 lines in the four modifier buckets were past. The mismatch was invisible while
// the buckets were read in isolation and became obvious the moment #949 put each line directly after
// "[Corp] ran for $X.", which is past tense and is the sentence they now have to agree with.
//
// SO THE TWENTY MOVED, and the other hundred were not touched. Verified by diff rather than by eye: the four
// modifier buckets are byte-identical across this edit.
//
// TWO OUTLIERS SURVIVE IN THE OTHER BUCKETS and are deliberately left alone, because they are supplied copy
// and were not what was asked about:
//   criticalBonus -- "The executives are already discussing monuments to themselves."
//   criticalMalus -- "An alarming number of passengers appear to have boarded without purchasing tickets."
// Both read as a present consequence of a past event, which is defensible; both are also the only two of
// their hundred that do it. Flagged rather than edited.
//
// NOT EVERY PRESENT-TENSE VERB IS A MISMATCH, which is why this was not done with a regex. "The accountants
// discovered that optimism is not legal tender" is a past main clause with a present subordinate, and that
// is correct English -- a general truth stays present. A sweep for present-tense verbs flags ten such lines
// and every one of them is right as written.
//
// THE ARRAY LENGTHS ARE LOAD-BEARING. The index rules are `seed % 20` for `unchanged` and `seed % 25` for the
// other four, so a short array would index past its end and put `undefined` into the Activity Log. There is a
// case in `flavorText.test.ts` asserting each length, because a dropped comma during an edit is silent here
// and loud three screens away.

export const UNPREDICTABLE_REVENUE_FLAVOR = {
  criticalMalus: [
    "The day's revenue took an unexpected excursion through the countryside.",
    "The accountants discovered a thrilling new category of expense.",
    "An alarming number of passengers appear to have boarded without purchasing tickets.",
    "The company’s profits were misplaced somewhere between here and Cincinnati.",
    "Train robbers made an unscheduled withdrawal from the company treasury.",
    "The books balanced beautifully, provided nobody actually looked at them.",
    "Management blamed the weather, and the weather declined to comment.",
    "The treasurer recommended everyone remain calm and stop asking questions.",
    "The railroad had a banner day, though unfortunately the banner was on fire.",
    "Train robbers demonstrated the practical dangers of carrying money by rail.",
    "A mysterious, catastrophic leak was discovered in the company’s coffers.",
    "An ambitious fare collector abruptly discovered the limits of optimism.",
    "The boiler pressure gauge turned out to be purely decorative.",
    "The local telegraph operator translated the timetable into Morse code backward.",
    "An entire herd of stubbornly stationary cattle occupied the mainline.",
    "A mid-level clerk quietly embezzled the month's coal budget.",
    "The Pinkertons demanded double pay just to keep the tracks clear of bandits.",
    "A sudden cholera outbreak led to the immediate quarantine of the terminal.",
    "Local farmers tore up the rails to protest the noise of the engines.",
    "A poorly timed bridge collapse sent three freight cars directly into the river.",
    "Someone intentionally greased the rails on the steepest grade in the mountains.",
    "The state legislature suddenly remembered to collect the regional railway tax.",
    "Train robbers relieved the company of 20% of its revenue.",
    "A patent dispute resulted in the federal seizure of the driving wheels.",
    "The train arrived perfectly on time, though unfortunately, the money did not."
  ],
  minorMalus: [
    "The accountants finally discovered that optimism is not legal tender.",
    "A few fares evaporated somewhere between the station and the ledger.",
    "Ten percent of the revenue inexplicably went to a better-paying railway.",
    "The conductor reported unusually generous interpretations of 'free travel'.",
    "A handful of pennies mysteriously acquired the status of 'operating expenses'.",
    "The ticket office had a surprisingly successful day selling fares at the wrong price.",
    "The treasurer rounded several figures in a direction most favorable to himself.",
    "The railway’s earnings had to be trimmed for excessive enthusiasm.",
    "Wall Street was firmly advised that 90% is still a very respectable number.",
    "The revenue arrived 10% late and was therefore charged a penalty.",
    "The company lost a little money and gained considerable experience.",
    "A modest revenue decline was blamed entirely on 'market conditions'.",
    "A minor catastrophe was quietly downgraded to an 'adjustment'.",
    "A flock of sheep absolutely refused to yield the right-of-way.",
    "The dining car ran out of whiskey before noon, enraging the first-class travelers.",
    "The local alderman held up the train for a prolonged ribbon-cutting ceremony.",
    "The conductor mislaid his pocket watch and ran the route purely on intuition.",
    "The train was delayed by a slow-moving circus parade crossing the tracks in town.",
    "The coal tender caught fire, but only a little bit.",
    "A rogue spark set a wealthy passenger's bespoke hat ablaze.",
    "Local pranksters replaced the signal lanterns with red glass.",
    "A sudden downpour caused a brief flash flood over the tracks.",
    "The local water tower was accidentally drained by thirsty locals.",
    "An eccentric tycoon demanded an unscheduled stop to look at a nice tree.",
    "The trains ran splendidly, though the finances ran somewhat less so."
  ],
  unchanged: [
    "Nothing unexpected happened. The accountants were suspicious.",
    "The railway enjoyed the rare luxury of normality.",
    "The trains ran, the fares were collected, and nobody got robbed.",
    "The day passed without financial incident.",
    "The market experienced neither joy nor despair.",
    "A train departed. A train arrived. Money changed hands.",
    "The railway successfully avoided both prosperity and disaster.",
    "The books closed without requiring any creative interpretation.",
    "The day’s receipts were neither miraculous nor catastrophic.",
    "Business was conducted with admirable mediocrity.",
    "No robbers, disasters, or miracles disturbed the day’s receipts.",
    "The accountants found the books pleasantly boring.",
    "The company achieved the remarkable feat of changing nothing.",
    "Management was pleased to announce absolutely nothing.",
    "The railway neither struck gold nor lost its shirt.",
    "The railway avoided excitement, which was excellent news for the accountants.",
    "Passengers paid their fares, and everyone behaved themselves.",
    "Nothing happened to the revenue. For once, this was good news.",
    "The railway’s earnings remained as steady as the track.",
    "The treasurer closed the ledger and got to go home early."
  ],
  minorBonus: [
    "The railway finally discovered that people are willing to pay for this service.",
    "The railway accidentally made itself profitable.",
    "A fortunate combination of full trains and questionable accounting boosted receipts.",
    "Business was brisk, and nobody has yet asked why.",
    "Ticket sales exceeded expectations by a suspiciously convenient margin.",
    "Business was, as the treasurer announced, 'better than we have any right to expect'.",
    "The company discovered the ancient and powerful business strategy of charging money.",
    "Management congratulated itself on a plan it had absolutely nothing to do with.",
    "The increased receipts prompted immediate discussion of enormous executive salaries.",
    "A favorable wind blew directly into the corporate coffers.",
    "The company’s treasury enjoyed a modest but welcome expansion.",
    "The market discovered that optimism can, occasionally, be correct.",
    "Prosperity arrived promptly and without requiring a connecting train.",
    "A sudden local festival caused a massive surge in third-class ticket sales.",
    "A glorious tailwind across the plains saved half a ton of coal.",
    "The competing stagecoach company tragically broke an axle.",
    "The conductor somehow managed to cram forty extra people into the second-class car.",
    "A local bridge toll was unexpectedly suspended by the governor.",
    "The fireman discovered a vein of exceptionally high-grade anthracite.",
    "A rival company's train was delayed, sending all of their passengers to you.",
    "A mild winter kept the tracks perfectly clear of ice and snow.",
    "The dining car's new menu proved wildly popular with the socialites.",
    "Local merchants offered a bounty for the early delivery of their goods.",
    "An aggressive local advertising campaign actually worked for once.",
    "The trains were full, the fares were collected, and nobody lost the ledger."
  ],
  criticalBonus: [
    "The railway apparently discovered where all the money is.",
    "A glorious torrent of revenue flooded the company’s coffers.",
    "Passenger demand became briefly indistinguishable from panic.",
    "The treasurer checked the figures three times and liked them every time.",
    "The trains were packed, the fares were flowing, and the executives were insufferable.",
    "Revenue climbed like a locomotive with a downhill grade and no brakes.",
    "The company had its best day since someone invented the ticket.",
    "The railway enjoyed an almost suspicious degree of prosperity.",
    "Revenue exploded upward, prompting the treasurer to hide the good news from competitors.",
    "The company’s earnings entered the realm of the frankly ridiculous.",
    "The executives are already discussing monuments to themselves.",
    "Revenue arrived in such quantities that the accountants required a larger ledger.",
    "Business was booming, and management immediately took credit.",
    "The railroad struck financial gold without having to lay another mile of track.",
    "A sudden gold strike in the foothills caused an absolute passenger stampede.",
    "A competitor's bridge collapsed, giving the company a total monopoly for the week.",
    "A massive army deployment required every available flatcar at premium rates.",
    "A major industrialist decided to relocate his entire factory using the railway.",
    "The federal government decided to pay its freight debts in pure silver bullion.",
    "A tycoon bought every first-class ticket just to enjoy the silence.",
    "An unexpected World's Fair exhibit was routed exclusively through the network.",
    "Management successfully bribed the state legislature for a massive subsidy.",
    "A speculative land boom caused ticket prices to quadruple overnight.",
    "An incredibly wealthy eccentric rented the entire train for a private party.",
    "A fortunate alignment of the stars and the stock market essentially printed money."
  ]
};
