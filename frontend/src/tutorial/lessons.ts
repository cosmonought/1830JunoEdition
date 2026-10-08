// frontend/src/tutorial/lessons.ts
//
/* ==================================================================
    PHASE 3 FINAL PLAY TUTORIAL: THE CANONICAL LESSON CONTENT (layer A of three)
   ==================================================================
   CONTENT ONLY. Every word the Play tutorial teaches lives here, once, under a stable lesson id -- the coach that
   pops up during play and the on-demand library read the SAME records, so the two cannot drift into two copies of
   one explanation (the old `TutorialModal.tsx` page arrays are retired into this file).

   THREE LAYERS, KEPT APART (the owner's final tutorial brief):
     A. CONTENT       this file -- title, the short explanation, optional deeper text, the related rule.
     B. PLAY TRIGGER  `triggers.ts` -- which WITNESSED game state or event raises a lesson.
     C. PRESENTATION  `presentation.ts` -- what a lesson highlights and where the coach sits.

   PORTABLE ON PURPOSE. This module imports nothing -- no React, no engine, no Play runtime -- so a future Ludum
   "Learn to Play" frontend can read or transform the concepts without importing the game. It is data and two tiny
   pure readers.

   FACTS ARE THE ENGINE'S. Every rule stated here was checked against the implemented rules (the reducer and the
   Rules Reference, which is the final word on Project 18XX's rules). In particular: an Operating turn is FIVE
   numbered steps -- Lay Track, Station Tokens, Run Routes, Dividends, Buy Trains -- with buying a private company a
   side action from Phase 3, not a sixth step (`operatingSubPhase.ts` OPERATING_SUB_PHASE_ORDER; the Rules
   Reference's "Order of play"); and a corporation must buy a train only when it has none AND has a legal route
   (`trainAvailability.ts` trainObligationFor). Nothing here states a fee percentage, a challenge-window length or
   any money figure the deployment configures. */

export type LessonTopicId =
  | "orientation"
  | "auction"
  | "stock"
  | "operating"
  | "market"
  | "trains"
  | "money"
  | "pace"
  | "juno";

/** The Rules Reference's pages (`RulesReference.tsx` SECTION_ORDER), by id. */
export type RulesPageId = "overview" | "stock" | "operating" | "auction" | "tables";

export interface LessonText {
  /** A concise heading. */
  readonly title: string;
  /** What the coach shows: two or three sentences, the concept and why it matters. */
  readonly summary: string;
  /** Optional deeper text, one paragraph or bullet per entry (an entry starting "• " is a bullet). Shown behind
   *  "More" in the coach and in full in the library. */
  readonly detail?: readonly string[];
}

export interface Lesson extends LessonText {
  readonly id: string;
  readonly topic: LessonTopicId;
  /** A primer opens a round or the game; a concept teaches one mechanic. */
  readonly kind: "primer" | "concept";
  /** The related rule, for a "Rules" link: a Rules Reference page and, optionally, an element id on it. */
  readonly rules?: { readonly page: RulesPageId; readonly anchor?: string };
  /** Text that replaces this lesson's on a table playing a variant. Only the Delayed Auction rewrites lessons. */
  readonly variants?: { readonly delayedAuction?: Partial<LessonText> };
}

const LESSON_LIST = [
  /* ---------------------------------------------------------------- orientation */
  {
    id: "orientation.goal",
    topic: "orientation",
    kind: "primer",
    title: "What you are playing",
    summary:
      "Project 18XX is a railway game about personal wealth. You buy shares in railway corporations; the largest shareholder is president and runs the corporation with its own treasury, not your cash. The richest player at the end wins.",
    detail: [
      "Your final score is your own cash, plus your shares at their market price, plus the face value of any private company you still own.",
      "A corporation's treasury, track and trains never count toward anyone's score. A railway matters to you only through the share price and the dividends it pays its shareholders.",
    ],
    rules: { page: "tables", anchor: "rules-reference-game-end" },
  },
  {
    id: "orientation.money",
    topic: "orientation",
    kind: "primer",
    title: "Your money and a corporation's money",
    summary:
      "There are two kinds of money. Your cash is yours: you bid for private companies and buy shares with it. A corporation has its own treasury, which pays for its track, stations and trains.",
    detail: [
      "As president you decide how a corporation spends its treasury, but you do not spend your own cash on it — except in an emergency train purchase, when the treasury cannot afford a train the corporation must buy.",
      "A corporation's treasury is funded when it floats: the bank pays it ten times its par value.",
    ],
    rules: { page: "stock", anchor: "rules-section-float" },
  },
  {
    id: "orientation.flow",
    topic: "orientation",
    kind: "primer",
    title: "How a game unfolds",
    summary:
      "The game opens with an auction of private companies. After that it alternates: a Stock Round, where players trade shares, then a set of Operating Rounds, where the corporations lay track, run trains and earn revenue.",
    detail: [
      "A set has one Operating Round early in the game, two once green tiles arrive and three from the brown phase on.",
      "The game ends at once if a player goes bankrupt. It also ends when the bank runs out of money: if that happens in an Operating Round, the set is finished; if in a Stock Round, that round and one more set of Operating Rounds are played.",
    ],
    rules: { page: "overview" },
    variants: {
      delayedAuction: {
        summary:
          "At this table the game opens with a Stock Round, where players trade shares, then alternates with sets of Operating Rounds, where the corporations lay track, run trains and earn revenue. The private companies are auctioned after the Operating Round set in which the first 3-train is bought.",
      },
    },
  },

  /* ---------------------------------------------------------------- the auction */
  {
    id: "auction.primer",
    topic: "auction",
    kind: "primer",
    title: "The opening auction",
    summary:
      "Before any corporation exists, the private companies are sold. Each pays its owner a fixed income at the start of every Operating Round, and some carry a special power.",
    detail: [
      "Cash you spend here is cash you will not have for shares in the first Stock Round, where the corporations are started.",
      "Any private company still open closes when the first 5-train is bought.",
    ],
    rules: { page: "auction" },
    variants: {
      delayedAuction: {
        title: "The private company auction",
        summary:
          "At this table the private companies are sold mid-game, after the Operating Round set in which the first 3-train is bought. Each pays its owner a fixed income at the start of every Operating Round, and some carry a special power.",
        detail: [
          "You bid with the cash you have now, and the Stock Round opens straight after the auction.",
          "Any private company still open closes when the first 5-train is bought.",
        ],
      },
    },
  },
  {
    id: "auction.choices",
    topic: "auction",
    kind: "concept",
    title: "Your three options",
    summary:
      "On your turn you buy the cheapest unsold private company at its face value, bid on a more expensive one, or pass.",
    detail: [
      "A bid is a claim, not a purchase: it is settled only when the cheaper companies have been sold and the auction reaches the one you bid on.",
    ],
    rules: { page: "auction" },
  },
  {
    id: "auction.cascade",
    topic: "auction",
    kind: "concept",
    title: "The cascade",
    summary:
      "When the cheapest company is bought, the auction moves to the next one. If it has a single bid, that bidder buys it; if several players bid, they settle it in a short auction among themselves.",
    detail: [
      "The cascade continues until it reaches a company nobody has bid on. Then ordinary turns resume.",
    ],
    rules: { page: "auction" },
  },
  {
    id: "auction.allPass",
    topic: "auction",
    kind: "concept",
    title: "When everybody passes",
    summary:
      "Passing moves the auction along. If every player passes in a row, one of two things happens before your turn comes back: the Schuylkill Valley's price drops by $5 while it is unsold, or — once it has been sold — every private company already owned pays its revenue.",
    detail: [
      "• While the Schuylkill Valley is still unsold, its price drops by $5 — it is the only private company ever marked down. If its price reaches $0, the player whose turn it is must take it for free.",
      "• Once the Schuylkill Valley has been bought, no price drops. Instead every private company already owned pays its printed revenue to its owner.",
      "So passing has a cost. Waiting can make the Schuylkill Valley cheaper, but once it is sold, waiting pays income to everyone who has already bought.",
    ],
    rules: { page: "auction" },
  },
  {
    id: "auction.cash",
    topic: "auction",
    kind: "concept",
    title: "Watch your cash",
    summary:
      "Everyone starts with the same cash — $600 each in a four-player game. Do not spend it all here, or you will have nothing left to buy shares with in the first Stock Round.",
    rules: { page: "tables", anchor: "rules-reference-player-limits" },
    variants: {
      delayedAuction: {
        summary:
          "This auction comes in the middle of the game, so you bid with the cash you have now — and the Stock Round opens straight after it.",
        detail: [
          "A private company won here counts toward your certificate limit, and the C&A or the B&O brings a share with it. If that puts you over a limit you will have to sell down in that Stock Round.",
        ],
      },
    },
  },

  /* ---------------------------------------------------------------- the stock round */
  {
    id: "stock.primer",
    topic: "stock",
    kind: "primer",
    title: "The Stock Round",
    summary:
      "Players now buy and sell shares in the railway corporations. Shares belong to players; a corporation's own money is separate and is raised once, when it floats. The largest shareholder is president and controls the corporation.",
    detail: [
      "Owning shares pays you when the corporation pays dividends, and your shares count toward your score at their market price.",
      "Control matters as much as income: the president decides how the corporation builds, runs and spends.",
    ],
    rules: { page: "stock" },
    variants: {
      delayedAuction: {
        detail: [
          "At this table the private companies are not sold yet: their auction is held after the Operating Round set in which the first 3-train is bought, and the B&O cannot be traded until it is over.",
          "Owning shares pays you when the corporation pays dividends, and your shares count toward your score at their market price.",
        ],
      },
    },
  },
  {
    id: "stock.turn",
    topic: "stock",
    kind: "concept",
    title: "Your Stock Round turn",
    summary:
      "On your turn you may sell, then buy one certificate, then sell again. Buying from a corporation's Initial Offering costs its par value; buying from the Bank Pool costs its current share price.",
    detail: [
      "The turn is Sell → Buy 1 certificate → Sell. You may sell after buying.",
      "The first certificate bought in a corporation is its 20% President's Certificate: the buyer chooses the par value and pays twice it.",
      "No certificates may be sold in the first Stock Round.",
      "There is a limit on how many certificates you may hold; the Rules Reference's Tables give it for each player count.",
    ],
    rules: { page: "stock", anchor: "rules-section-buy" },
  },
  {
    id: "stock.par",
    topic: "stock",
    kind: "concept",
    title: "Choosing a par value",
    summary:
      "Par value is the price a corporation's Initial Offering shares sell at, and where its share price starts on the Stock Market. It never changes afterwards.",
    detail: [
      "It also sets the corporation's starting treasury: when it floats, the bank pays it ten times par. A higher par means a richer corporation but dearer shares for everyone buying in.",
    ],
    rules: { page: "stock", anchor: "rules-section-buy" },
  },
  {
    id: "stock.float",
    topic: "stock",
    kind: "concept",
    title: "A corporation has floated",
    summary:
      "A corporation floats once 60% of its shares have left the Initial Offering. The bank then pays ten times its par value into its treasury, and it operates in the next Operating Round.",
    detail: [
      "Floating places nothing on the map: the home station goes down at the start of the corporation's first Operating Round turn.",
    ],
    rules: { page: "stock", anchor: "rules-section-float" },
  },
  {
    id: "stock.selling",
    topic: "stock",
    kind: "concept",
    title: "Selling shares",
    summary:
      "Selling puts certificates in the Bank Pool and moves that corporation's share price down one box per certificate. You receive the price before the drop.",
    detail: [
      "• Once you sell a corporation's shares, you may not buy that corporation again in the same Stock Round.",
      "• The Bank Pool can never hold more than half of a corporation.",
      "• The President's Certificate is never sold. Selling down until another player holds more than you hands them the presidency first.",
    ],
    rules: { page: "stock", anchor: "rules-section-sell" },
  },
  {
    id: "stock.presidency",
    topic: "stock",
    kind: "concept",
    title: "A change of president",
    summary:
      "The president is the player holding the most shares. Another player takes over only by holding strictly more — a tie keeps the current president.",
    detail: [
      "The change is immediate. The corporation's treasury, trains and stations go with the presidency, so a president who loses control loses the say over all of them.",
    ],
    rules: { page: "stock", anchor: "rules-section-ownership" },
  },
  {
    id: "stock.passing",
    topic: "stock",
    kind: "concept",
    title: "Passing is not permanent",
    summary:
      "Passing gives up this turn, not the round. If anyone else buys or sells, the turn comes back to you and you may act on what you have just seen.",
    detail: [
      "A Stock Round ends only when every player passes in a row, with no buy or sell in between. One purchase anywhere starts that count again.",
    ],
    rules: { page: "stock" },
  },
  {
    id: "stock.roundEnd",
    topic: "stock",
    kind: "concept",
    title: "The end of a Stock Round",
    summary:
      "Every player passed in a row, so the Stock Round is over. The Priority Deal — the first turn of the next Stock Round — goes to the player to the left of the last player who bought or sold; if nobody did, it stays where it is.",
    detail: [
      "A corporation whose shares are all held by players at the end of the round (none in the Initial Offering or the Bank Pool) moves up one box on the Stock Market.",
      "Being the last to buy or sell therefore hands the next round's opening move to your neighbour. Sometimes that is worth it; sometimes it costs you the corporation you wanted to start.",
    ],
    rules: { page: "stock" },
  },

  /* ---------------------------------------------------------------- the operating round */
  {
    id: "operating.primer",
    topic: "operating",
    kind: "primer",
    title: "The Operating Round",
    summary:
      "Now the corporations act, not the players. Each floated corporation takes one turn, in order of share price from highest to lowest; its president makes every decision and the corporation pays from its own treasury.",
    detail: [
      "Each turn has five steps in order: Lay Track, Station Tokens, Run Routes, Dividends, Buy Trains.",
      "From Phase 3 a corporation may also buy a private company from a player at any time during its turn. That is a side action, not a sixth step.",
      "At the start of each Operating Round, every open private company pays its owner.",
    ],
    rules: { page: "overview" },
  },
  {
    id: "operating.track",
    topic: "operating",
    kind: "concept",
    title: "Step 1: Lay Track",
    summary:
      "The corporation may lay one new tile or upgrade one existing tile. Track is how it reaches the cities its trains will run between.",
    detail: [
      "• Click a hex on the Rail Map to lay a tile; click the laid preview again to rotate it before you confirm.",
      "• An upgrade replaces a tile with the next colour and must keep every existing connection. Track is never downgraded.",
      "• Mountains and rivers add a terrain cost, paid from the corporation's treasury.",
      "• A corporation's first turn begins with its home station, placed free before anything else.",
    ],
    rules: { page: "operating", anchor: "rules-section-track" },
  },
  {
    id: "operating.tokens",
    topic: "operating",
    kind: "concept",
    title: "Step 2: Station Tokens",
    summary:
      "A station token claims a space in a city for the corporation. Its routes must start from one of its own stations, and a city whose spaces are all taken blocks rival trains from running through it.",
    detail: [
      "After the free home station, further stations are paid from the treasury — in the standard game $40 for the second and $100 for each after that; some variants charge differently, and the Rules Reference shows this table's costs. At most one per turn.",
    ],
    rules: { page: "operating", anchor: "rules-section-station" },
  },
  {
    id: "operating.routes",
    topic: "operating",
    kind: "concept",
    title: "Step 3: Run Routes",
    summary:
      "Each train runs a route through cities and towns connected by track, counting at most as many stops as its number — a 2-train counts two. The values of the stops it visits are the corporation's revenue.",
    detail: [
      "• A route may not use the same track twice or visit the same city twice.",
      "• A corporation's trains must run separate routes: two of its trains may not share track.",
      "• Auto-Route drafts routes for you as a suggestion; you can adjust them before you run.",
    ],
    rules: { page: "operating", anchor: "rules-section-routes" },
  },
  {
    id: "operating.dividends",
    topic: "operating",
    kind: "concept",
    title: "Step 4: Dividends",
    summary:
      "The president chooses: pay the revenue out to the shareholders, or withhold it in the treasury. Paying out moves the share price right; withholding moves it left.",
    detail: [
      "Each 10% share is paid a tenth of the revenue, the president's own shares included. Dividends on shares in the Bank Pool go into the corporation's treasury; unsold Initial Offering shares receive nothing.",
      "Withholding builds the treasury for trains; paying out raises the share price and the players' wealth.",
    ],
    rules: { page: "operating", anchor: "rules-section-revenue" },
  },
  {
    id: "operating.trains",
    topic: "operating",
    kind: "concept",
    title: "Step 5: Buy Trains",
    summary:
      "The corporation may buy trains from the bank (new, or second-hand from the Bank Pool) or from another corporation, paying from its treasury. A corporation with a legal route but no train must buy one.",
    detail: [
      "• The depot sells cheapest-first, one tier per purchase: every 3-train must be sold before the first 4-train can be bought. Buy one at a time, because a purchase can start a new phase.",
      "• A corporation may not hold more trains than the current train limit.",
      "• A train bought this turn first runs on the corporation's next turn.",
    ],
    rules: { page: "operating", anchor: "rules-section-buyTrains" },
  },
  {
    id: "operating.privates",
    topic: "operating",
    kind: "concept",
    title: "Buying a private company",
    summary:
      "From Phase 3, a corporation may buy a private company (never the B&O) from a player at any time during its turn, for between half and twice its face value. The owner has to agree: it is a negotiation, not a purchase you can force.",
    detail: [
      "A private company's special power goes with it to the corporation. Any private company still open closes when the first 5-train is bought.",
    ],
    rules: { page: "auction" },
  },

  /* ---------------------------------------------------------------- the stock market */
  {
    id: "market.moves",
    topic: "market",
    kind: "concept",
    title: "How share prices move",
    summary:
      "A share price just moved. Prices move on the Stock Market chart: right when a corporation pays a dividend, left when it withholds, down one box per certificate sold, and up when it ends a Stock Round with every share held by players.",
    detail: [
      "Prices decide the order corporations operate in, what Bank Pool shares cost, and what everyone's shares are worth at the end.",
    ],
    rules: { page: "stock", anchor: "rules-section-movement" },
  },
  {
    id: "market.firstWithhold",
    topic: "market",
    kind: "concept",
    title: "Why the price moved left",
    summary:
      "A corporation that earns nothing — no train, or no route to run — must withhold, and withholding moves its price one box left. Every corporation's first turn ends this way, because a train bought in that turn cannot run until the next one.",
    detail: [
      "On a first turn it is not a mistake: buying a train then is what lets the corporation earn from its second. Later, it is the cost of a fleet that has rusted away.",
    ],
    rules: { page: "operating", anchor: "rules-section-revenue" },
  },
  {
    id: "market.edges",
    topic: "market",
    kind: "concept",
    title: "The edges of the chart",
    summary:
      "At the right end of its row, a price that should move right moves up instead, if it can; at the left end, a price that should move left moves down, if it can. A price at the bottom of its column cannot fall further, and one at the top cannot rise.",
    rules: { page: "stock", anchor: "rules-section-market" },
  },

  /* ---------------------------------------------------------------- trains and phases */
  {
    id: "trains.phases",
    topic: "trains",
    kind: "concept",
    title: "A new phase",
    summary:
      "Each new phase starts with the first train of a new size. Phases unlock new tile colours, set how many Operating Rounds a set has, and can lower the train limit.",
    detail: [
      "• Train limit: four per corporation in Phases 2 and 3, three in Phase 4, two from Phase 5.",
      "• Phase 3 lets corporations buy private companies; Phase 5 closes them.",
    ],
    rules: { page: "tables", anchor: "rules-reference-phases" },
  },
  {
    id: "trains.rust",
    topic: "trains",
    kind: "concept",
    title: "Trains rust",
    summary:
      "Older trains wear out. The first 4-train rusts every 2-train, the first 6-train every 3-train and the first Diesel every 4-train — in the standard game they leave at once. Under the Gentle Rust variant they get one final run first.",
    detail: [
      "Larger trains do not rust. A president who lets a corporation's whole fleet rust may have to buy a replacement out of their own pocket.",
    ],
    rules: { page: "tables", anchor: "rules-reference-phases" },
  },
  {
    id: "trains.emergency",
    topic: "trains",
    kind: "concept",
    title: "Emergency train purchases",
    summary:
      "A corporation with a legal route but no train must buy one. If its treasury cannot pay for the cheapest train available, the president must make up the difference from their own cash, and sell shares if that is not enough.",
    detail: [
      "A president who still cannot raise the money goes bankrupt, and the game ends. Keep an eye on which trains are about to rust.",
    ],
    rules: { page: "tables", anchor: "rules-reference-forced-purchase" },
  },

  /* ---------------------------------------------------------------- money tables */
  {
    id: "money.ante",
    topic: "money",
    kind: "primer",
    title: "Playing for an ante",
    summary:
      "Every seat at this table deposits the same ante in JUNO into an escrow contract on Juno. The game is played with in-game dollars; when it ends, the escrowed pot is paid out according to the final result.",
    detail: [
      "The escrow keeps a fee, set by the escrow, from every deposit; it is not refunded. The money panel shows the amount before you deposit. You also pay the network fee for your own transactions, which Keplr shows before you approve.",
      "Deposits on Juno are public: anyone can see which wallet funded the table.",
    ],
  },
  {
    id: "money.wallets",
    topic: "money",
    kind: "concept",
    title: "Your two wallets",
    summary:
      "Your Authorization Wallet proves your account is yours. The wallet you ante with at a table is that table's financial wallet, and it is where that table's winnings are paid.",
    detail: [
      "The Authorization Wallet is never chosen as a game wallet for you. The same wallet may serve both roles if you deliberately ante with it — that is allowed, and you are warned once; keeping them separate is safer.",
      "Once the game starts, a seat's payout wallet cannot change.",
    ],
  },
  {
    id: "money.payout",
    topic: "money",
    kind: "concept",
    title: "How the pot is paid",
    summary:
      "The pot is not winner-take-all. It is split in proportion to each player's final net worth — cash, shares at market price and any private company still owned.",
    detail: [
      "A result waits out a challenge window before it pays, during which any player may dispute it on Juno by posting a bond; a resolver then decides.",
      "Rounding remainders go to the escrow's treasury. A game ended by foreclosure or annulment pays out differently; the clock's details explain those outcomes.",
    ],
  },
  {
    id: "money.beforeStart",
    topic: "money",
    kind: "concept",
    title: "Before the game starts",
    summary:
      "Until the game starts you may withdraw your deposit; the escrow fee is not refunded. Once it starts, every deposit stays in escrow until the game ends.",
  },

  /* ---------------------------------------------------------------- pace and clocks */
  {
    id: "pace.modes",
    topic: "pace",
    kind: "primer",
    title: "Live, Async and No deadline",
    summary:
      "A table's pace is set when it is created. Live is played in one sitting with a 20-minute clock on each required action. Async is played over days, with the clock the host chose. No deadline has no clock at all.",
    detail: [
      "On a money table with no deadline, a game that is never finished and not annulled by every player can leave the escrowed funds locked indefinitely — which is why you are asked to acknowledge it.",
    ],
  },
  {
    id: "pace.clock",
    topic: "pace",
    kind: "concept",
    title: "The action clock",
    summary:
      "The action clock runs only for the player who owes the next required decision — a turn, an auction bid or pass, or a forced choice. Chat and watching never run it.",
    detail: [
      "On a Live table an offer's recipient has a separate ten-minute answer timer, and an unanswered offer expires and counts as a decline. On an Async table your own deadline keeps running while your offer waits for an answer.",
    ],
  },
  {
    id: "pace.pause",
    topic: "pace",
    kind: "concept",
    title: "Pausing",
    summary:
      "A Live table can pause only if every seated player agrees, and resumes only when every player agrees again. If the server's continuity is interrupted, a Live game pauses itself until every player agrees to resume.",
    detail: ["Async tables do not pause; time lost to a server interruption is credited back instead."],
  },
  {
    id: "pace.overdue",
    topic: "pace",
    kind: "concept",
    title: "When a clock runs out",
    summary:
      "A player whose clock runs out is overdue. On a Live table they have ten more minutes to cure it by moving. Meanwhile the other players may all approve foreclosure; at minute 30 an uncured game is foreclosed if they did, and otherwise annulled neutrally.",
    detail: [
      "On an Async table nothing happens automatically: the other players may all agree to annul the game or to foreclose.",
      "A third expired clock on a Live table forecloses at once. The clock's details panel, beside the timer, shows where a table stands.",
    ],
  },

  /* ---------------------------------------------------------------- Project 18XX on Juno */
  {
    id: "juno.edition",
    topic: "juno",
    kind: "concept",
    title: "Project 18XX on Juno",
    summary:
      "The game's rules engine decides what is legal: a move it refuses is not allowed, and the Rules Reference is the final word on the rules. The tutorial only explains — it never limits a legal move.",
    detail: [
      "Money tables keep real stakes in an escrow on Juno, while the game itself is played with in-game dollars.",
      "The host may choose variants. Rules that belong to a variant are marked in the Rules Reference and shown only at tables playing it.",
    ],
    rules: { page: "overview" },
  },
] as const satisfies readonly Lesson[];

export type LessonId = (typeof LESSON_LIST)[number]["id"];

/** Every lesson, in teaching order. */
export const LESSONS: readonly Lesson[] = LESSON_LIST;

const BY_ID: ReadonlyMap<string, Lesson> = new Map(LESSONS.map((lesson) => [lesson.id, lesson]));

/** The lesson with this id, or `null`. */
export function lessonById(id: string): Lesson | null {
  return BY_ID.get(id) ?? null;
}

/** Whether `id` names a lesson -- a stored id from an older build may not. */
export function isLessonId(id: string): id is LessonId {
  return BY_ID.has(id);
}

/** The table facts that change a lesson's wording. */
export interface LessonScope {
  readonly delayedAuction?: boolean;
}

/** A lesson's text as this table reads it. */
export function lessonText(lesson: Lesson, scope: LessonScope = {}): LessonText {
  const override = scope.delayedAuction ? lesson.variants?.delayedAuction : undefined;
  if (!override) return { title: lesson.title, summary: lesson.summary, detail: lesson.detail };
  return {
    title: override.title ?? lesson.title,
    summary: override.summary ?? lesson.summary,
    detail: override.detail ?? lesson.detail,
  };
}

export interface LibraryTopic {
  readonly id: LessonTopicId;
  readonly heading: string;
  readonly blurb: string;
  readonly lessons: readonly LessonId[];
}

/** The library, in the order a new player would read it. Every lesson appears under exactly one topic. */
export const LIBRARY_TOPICS: readonly LibraryTopic[] = [
  {
    id: "orientation",
    heading: "Getting Oriented",
    blurb: "What the game is about, whose money is whose, and how a game unfolds.",
    lessons: ["orientation.goal", "orientation.money", "orientation.flow"],
  },
  {
    id: "auction",
    heading: "Waterfall Auction",
    blurb: "How the private companies are sold.",
    lessons: ["auction.primer", "auction.choices", "auction.cascade", "auction.allPass", "auction.cash"],
  },
  {
    id: "stock",
    heading: "Stock Round",
    blurb: "Buying and selling shares, par values, floating, presidency and the Priority Deal.",
    lessons: [
      "stock.primer",
      "stock.turn",
      "stock.par",
      "stock.float",
      "stock.selling",
      "stock.presidency",
      "stock.passing",
      "stock.roundEnd",
    ],
  },
  {
    id: "operating",
    heading: "Operating Round",
    blurb: "A corporation's turn: track, stations, routes, dividends and trains.",
    lessons: [
      "operating.primer",
      "operating.track",
      "operating.tokens",
      "operating.routes",
      "operating.dividends",
      "operating.trains",
      "operating.privates",
    ],
  },
  {
    id: "market",
    heading: "Stock Market",
    blurb: "Why share prices move, and what happens at the edges of the chart.",
    lessons: ["market.moves", "market.firstWithhold", "market.edges"],
  },
  {
    id: "trains",
    heading: "Trains and Phases",
    blurb: "Phases, train limits, rust and emergency purchases.",
    lessons: ["trains.phases", "trains.rust", "trains.emergency"],
  },
  {
    id: "money",
    heading: "Money and Wallets",
    blurb: "Antes and the escrow, your two wallets, and how a pot is paid.",
    lessons: ["money.ante", "money.wallets", "money.payout", "money.beforeStart"],
  },
  {
    id: "pace",
    heading: "Pace and Clocks",
    blurb: "Live, Async and No deadline; the action clock, pauses and overdue players.",
    lessons: ["pace.modes", "pace.clock", "pace.pause", "pace.overdue"],
  },
  {
    id: "juno",
    heading: "Project 18XX on Juno",
    blurb: "What decides the rules here, variants, and real stakes.",
    lessons: ["juno.edition"],
  },
];
