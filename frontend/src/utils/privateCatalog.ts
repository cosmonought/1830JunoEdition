// frontend/src/utils/privateCatalog.ts
//
// THE PRIVATE COMPANIES' REVENUE AND CANONICAL POWERS, in one place.
//
// Design note #391: ONE COPY OF THE DESCRIPTIONS. This lived inside `WaterfallAuctionDashboard.tsx`, the right
// home while the auction was the only screen that described a private. It no longer is -- the stock card
// expands them to their rules text and the Ledger names them too.
// One copy, imported by both, because two copies of a rules description will eventually differ and the failure
// is silent: both read plausibly and only one matches what the game actually does.
//
// DISPLAY SOURCE ONLY: nothing reads this to make a decision, and it is a hand-kept mirror of
// `auction.rs::CORE_PRIVATE_COMPANIES` that has to be updated by hand if the contract's abilities change.
//
// Design notes #13/#312/#423/#548/#661: see `docs/ai_architecture/contract_economy.md`.

/** One private company's display data -- revenue yield and canonical power. */
export interface PrivateCatalogEntry {
  revenue: number;
  /* Design note #661: THE POWER, IN ONE LINE, BEFORE THE PARAGRAPH. `ability` is exactly right for the powers
     panel, where a player has gone to LEARN the piece; it is the wrong length for a buying decision -- six
     paragraphs in a modal is not a comparison, it is a reading assignment, and a player deciding between the D&H
     and the C&StL needs the difference between them in the same glance.
     SO THE SUMMARY LIVES HERE, beside the paragraph it summarises, rather than in the modal that renders it. Two
     descriptions of one power kept in two files is the arrangement that drifts -- and this pair is unusually
     exposed to it, because the long text is the one that gets corrected when a rule is found wrong.
     WRITTEN TO BE SCANNED, not to be complete: it names the hex, says whether the action is free, and says whether
     it costs the corporation its ordinary lay -- the three things that decide a purchase. */
  abilitySummary: string;
  /** The private's special power, described in this codebase's own words (design note #548), one line.
   *  ENFORCEMENT BADGES REMOVED (design note #13). An earlier pass rendered an "ENFORCED"/"NOT IN THIS RULESET"
   *  badge beside each of these, because `auction.rs` only implements three of the six powers. Gone by explicit
   *  decision: all six privates are required parts of this ruleset, and the card should describe the piece rather
   *  than annotate the current state of the backend.
   *  CONSEQUENCE, RECORDED HERE ON PURPOSE. Two descriptions below now state powers this contract does NOT
   *  implement -- Champlain & St. Lawrence's free tile lay, and Camden & Amboy's exchange for a 10% PRR share.
   *  Schuylkill Valley is safe (canonically it HAS no power). D&H, M&H and B&O are genuinely enforced, though the
   *  hex-blocking text now states the official rule's two exceptions -- owning corporation, or closure -- and
   *  whether the contract honours BOTH is itself an audit question.
   *  So until those two are implemented, this UI describes an ability a player cannot exercise. That is a BACKEND
   *  gap, not a display bug. Do not "fix" it by editing the text back into vagueness -- fix it in `auction.rs`. */
  ability: string;
  /* Design note #423: THE ACRONYM IS A NAME, NOT A NUMBER. The chips rendered `private_id`, and #341 defended
     that: "players refer to these companies by that order ('the 3'), so six chips fit where six names never
     would."
     The premise is half true and the conclusion does not follow. Players do say "the 3" WHILE the auction cards
     are on screen and numbered, because the number is a POSITION in a list they are looking at. Away from that
     list -- in the Ledger's Player Assets table, or two rounds later -- `3` names nothing: it is not the
     company's identity, it is its rank in a queue that has since been consumed.
     The acronyms are the identity, they are what the rulebook and every player use once the auction is over, and
     they are short enough that the width argument never applied.
     WHY THE CATALOG AND NOT THE STATE: `PrivateCompanyState.name` carries the full name and the contract will
     never send an abbreviation, so this is frontend presentation data about a fixed set of six. Keyed by
     `private_id` so it cannot drift from `revenue` and `ability` beside it. */
  acronym: string;
}

/** The acronym for a private, or `null` if the id is not one of the six. `null` rather than a fallback to the
 *  number: a caller rendering a pill for an unrecognised private should decide for itself whether to draw
 *  nothing or to degrade, and quietly reintroducing the numeric chip this replaced is the one answer that should
 *  not be automatic. */
export function privateAcronym(privateId: number): string | null {
  return PRIVATE_COMPANY_CATALOG[privateId]?.acronym ?? null;
}

/** Hand-kept mirror of `auction.rs::CORE_PRIVATE_COMPANIES`'s revenue yields, plus a plain-language description
 *  of each private's power. DISPLAY SOURCE ONLY -- see `PrivateCatalogEntry.ability` for the two powers this
 *  text currently describes ahead of the contract.
 *  Design note #548: DESCRIBED, NOT QUOTED. These strings used to be the published rulebook's own sentences,
 *  carried verbatim, and the note they replace argued for FIDELITY -- which was answering the wrong question.
 *  Quoting a commercial rulebook at length in shipped software is a copyright exposure whatever its typography,
 *  and the accuracy it was protecting does not require the publisher's words, only their meaning. Game rules are
 *  not themselves copyrightable; the expression of them is.
 *  ACCURACY WAS THE POINT OF THE QUOTATION AND IT IS STILL THE POINT. The paraphrases the verbatim text
 *  originally replaced were wrong in four specific ways, and every one is preserved here deliberately:
 *    D&H  the tile is NOT free -- the mountain costs the usual $120 and only the TOKEN is free. The tile also
 *         CONSUMES the corporation's normal placement.
 *    C&SL the opposite: its lay is IN ADDITION, so the corporation may play two tiles that turn.
 *    M&H  the exchange has two conditions (under 60% held, and an NYC share available) and may be taken BETWEEN
 *         other players' turns, in either round type.
 *    C&A  is not an ability the owner triggers -- the share arrives on PURCHASE and the private stays open.
 *  SCHUYLKILL VALLEY canonically has no power at all, and its line says so outright rather than leaving a blank
 *  that reads as missing data.
 *  Design note #312 (preserved): TWO PRIVATES CANNOT RESERVE ONE HEX. An older set of paraphrases had D&H naming
 *  B20 -- C&SL's hex -- and M&H claiming F16, which is D&H's. The descriptions settle it by construction: C&SL is
 *  B-20, D&H is F-16, and M&H reserves nothing at all because its power is the NYC exchange.
 *  KEPT AS A NOTE because `privateReservations.ts` and `sandboxState.ts` cite #312 by number, and because the
 *  DIVERGENCE is still live and still belongs on the contract audit list: `auction.rs` gives Mohawk & Hudson a
 *  reserved hex of F16, which on this board is Scranton and Scranton is the D&H's. Nothing in the frontend reads
 *  the reserved hex to make a decision, so the divergence is cosmetic until the contract starts enforcing it --
 *  and fixing it properly means changing `auction.rs`, not editing this text. */
export const PRIVATE_COMPANY_CATALOG: Readonly<Record<number, PrivateCatalogEntry>> = {
  1: {
    acronym: "SV",
    revenue: 5,
    // Said plainly. A blank here would read as missing data rather than as
    // the answer, which is the same reasoning `ability` gives below.
    abilitySummary: "No special power \u2014 revenue only.",
    // Canonically correct: Schuylkill Valley is the one 1830 private with
    // NO special ability. Said outright rather than left blank, because a
    // blank slot reads as missing data.
    ability: "No special power \u2014 bought for its revenue and as cheap entry into the auction.",
  },
  2: {
    acronym: "C&StL",
    revenue: 10,
    abilitySummary: "Free extra tile lay on B-20, connected to nothing. Keeps the corporation\u2019s normal lay.",
    ability:
      "Its owning corporation may tile hex B-20 even where nothing connects to it \u2014 no station of its own, no track at all. The lay is a bonus rather than a substitute: the corporation still gets its ordinary tile placement that turn, so it may lay two.",
  },
  3: {
    acronym: "D&H",
    revenue: 15,
    abilitySummary: "Tile F-16 (pay the $120 mountain) plus a free station there. Uses the corporation\u2019s lay.",
    ability:
      "Its owning corporation may tile hex F-16 and drop a station there in one go, connected to nothing. The token is free; the mountain still charges its usual $120 for the tile. Unlike the C&StL this uses up the corporation\u2019s tile placement for the turn. Decline the token then and it can only be placed later under the ordinary connection rules. The power lapses entirely once any other corporation tiles F-16 first.",
  },
  4: {
    acronym: "M&H",
    revenue: 20,
    abilitySummary: "Owner may trade it for a 10% NYC share at any time. The trade closes it.",
    ability:
      "Its owning player may trade it in for a 10% NYC share, so long as they hold under 60% of the NYC already and a share is actually free in the bank or the pool. The trade can be made on their own stock-round turn, or in the gap between any other player\u2019s or corporation\u2019s turn, in either kind of round. Taking it closes the company.",
  },
  5: {
    acronym: "C&A",
    revenue: 25,
    abilitySummary: "Its auction buyer received a 10% PRR share. Nothing further \u2014 the company stays open.",
    ability:
      "Whoever buys it out of the auction is handed a 10% PRR share at once and at no further cost. Nothing is triggered and the company stays open. The PRR will not be operating yet, but the share is held or sold like any other.",
  },
  6: {
    acronym: "B&O",
    revenue: 30,
    // Design note #660: both halves are enforced now, so the summary can
    // state them as facts about the board rather than as flavour.
    abilitySummary: "Came with the B&O presidency. Never sellable to a corporation; closes on the B&O\u2019s first train.",
    ability:
      "Its owner takes the B&O president\u2019s certificate free on purchase and sets the corporation\u2019s par price immediately. It can never be sold to a corporation, and it stays with its owner even if they later lose the B&O presidency. It closes the moment the B&O buys its first train.",
  },
};
