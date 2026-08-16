// frontend/src/utils/privateCatalog.ts
//
// THE PRIVATE COMPANIES' REVENUE AND CANONICAL POWERS, in one place.
//
// ==================================================================
//  DESIGN NOTE 391: ONE COPY OF A QUOTATION
// ==================================================================
//
// This table lived inside `WaterfallAuctionDashboard.tsx`, which was the
// right home while the auction was the only screen that described a
// private. It no longer is: the condensed stock card lists a
// corporation's privates and expands them to their rules text (design
// note #394), and the Financial Ledger names them too.
//
// The text is a QUOTATION -- design note #360 below is explicit that it is
// the rulebook's own words, verbatim including the typography, and that
// normalising a curly apostrophe would be an edit. A quotation that exists
// in two files is a quotation that will eventually differ between them,
// and the failure is silent: both copies look plausible and only one
// matches the book. So it moves rather than being duplicated, and both
// consumers import it.
//
// DISPLAY SOURCE ONLY, unchanged from the original: nothing reads this to
// make a decision, and it is a hand-kept mirror of
// `auction.rs::CORE_PRIVATE_COMPANIES` that has to be updated by hand if
// the contract's abilities change.

/** One private company's display data -- revenue yield and canonical power. */
export interface PrivateCatalogEntry {
  revenue: number;
  /** The private's canonical 1830 special power, one line.
   *
   *  ENFORCEMENT BADGES REMOVED (design note #13). An earlier pass rendered
   *  an "⛓ ENFORCED" / "○ NOT IN THIS RULESET" badge beside each of these,
   *  because `auction.rs` only implements three of the six powers. The
   *  badges are gone by explicit decision: all six privates are required
   *  parts of this ruleset, and the card should describe the piece rather
   *  than annotate the current state of the backend.
   *
   *  ⚠ CONSEQUENCE, RECORDED HERE ON PURPOSE. Two of the descriptions below
   *  now state powers this contract does NOT currently implement:
   *
   *    - Champlain & St. Lawrence -- free tile lay on its home hex
   *    - Camden & Amboy          -- exchange for a 10% PRR share
   *
   *  Schuylkill Valley is safe -- canonically it HAS no power, so there is
   *  nothing to enforce. D&H, M&H and B&O are genuinely enforced
   *  (`hexmap.rs` doc comment #24, `auction.rs` doc comment #4), though the
   *  hex-blocking text for D&H/M&H now states the official rule's two
   *  exceptions -- owning corporation, or closure -- and whether the
   *  contract honours BOTH of those exceptions is itself an audit
   *  question.
   *
   *  So until those two are implemented, this UI describes an ability a
   *  player cannot exercise. That is a BACKEND gap, not a display bug, and
   *  it belongs on the contract audit list. Do not "fix" it by editing the
   *  text back into vagueness -- fix it in `auction.rs`. */
  ability: string;
  /* ==================================================================
   *  DESIGN NOTE 423: THE ACRONYM IS A NAME, NOT A NUMBER
   * ==================================================================
   *
   * REPORTED: replace the numeric chips for private companies with named
   * acronym pills.
   *
   * The chips rendered `private_id` -- `1` through `6` -- and design note
   * #341 defended that: "the cards above are numbered 1-6 and players refer
   * to these companies by that order ('the 3'), so six chips fit where six
   * names never would."
   *
   * The premise is half true and the conclusion does not follow from it.
   * Players do say "the 3" while the auction cards are on screen and
   * numbered, because the number is a POSITION in a list they are looking
   * at. Away from that list -- in the Ledger's Player Assets table, or two
   * rounds later -- `3` names nothing. It is not the company's identity, it
   * is its rank in a queue that has since been consumed.
   *
   * The acronyms are the identity, they are what the rulebook and every
   * player use once the auction is over, and they are short enough that the
   * width argument never applied: `SV` is two characters against `1`'s one.
   *
   * WHY THE CATALOG AND NOT THE STATE. `PrivateCompanyState.name` carries
   * the full name and the contract will never send an abbreviation, so this
   * is frontend presentation data about a fixed set of six -- the same
   * reasoning `corporationNames.ts` records for the public companies'
   * table. Keyed by `private_id` so it cannot drift from `revenue` and
   * `ability` beside it. */
  acronym: string;
}

/** The acronym for a private, or `null` if the id is not one of the six.
 *
 *  `null` rather than a fallback to the number: a caller rendering a pill
 *  for an unrecognised private should decide for itself whether to draw
 *  nothing or to degrade, and quietly reintroducing the numeric chip this
 *  replaced is the one answer that should not be automatic. */
export function privateAcronym(privateId: number): string | null {
  return PRIVATE_COMPANY_CATALOG[privateId]?.acronym ?? null;
}

/** Hand-kept mirror of `auction.rs::CORE_PRIVATE_COMPANIES`'s revenue
 *  yields, plus each private's canonical 1830 special power.
 *
 *  DISPLAY SOURCE ONLY -- not derived from any schema, and nothing reads it
 *  to make a decision. Same convention as this codebase's other hand-kept
 *  mirrors (`HexGridRenderer.tsx`'s `TILE_CATALOG`, `App.tsx`'s
 *  `MOCK_TRAIN_CATALOG`): if the backend gains or changes an ability, this
 *  table has to be updated by hand. See `PrivateCatalogEntry.ability` for
 *  the two powers this text currently describes ahead of the contract. */
/* ==================================================================
 *  DESIGN NOTE 360: THE RULEBOOK'S OWN WORDS
 * ==================================================================
 *
 * These five strings are the 1830 rulebook's canonical text for the
 * privates' special powers, supplied verbatim. They replace paraphrases
 * that were shorter and, in three places, wrong in ways that mattered:
 *
 *   D&H  said the tile lay was free. It is not -- the mountain costs the
 *        usual $120 and only the TOKEN is free, which is most of the cost.
 *        It also omitted that the tile DOES consume the corporation's
 *        normal placement, the opposite of the C&SL's grant of a second.
 *   M&H  omitted both conditions on the exchange (the 60% cap, and NYC
 *        shares actually being available) and the fact that it can be done
 *        between other players' turns.
 *   C&A  was described as an ability the owner triggers. It is not: the
 *        share arrives on PURCHASE and the private stays open.
 *
 * VERBATIM, INCLUDING THE TYPOGRAPHY. The curly apostrophes and the em dash
 * are the source text's; normalising them to ASCII would be an edit, and
 * once one edit is allowed the text stops being quotable.
 *
 * ONE CORRECTION, MADE ON REQUEST. The supplied D&H copy read "it need not
 * be connect to any track"; it now reads "connected". The first pass
 * reproduced that typo deliberately and flagged it rather than fixing it
 * quietly -- correcting a quotation without saying so is how a quotation
 * stops matching its source. Raised, confirmed, changed. It is the only
 * departure from the text as given, which is why it is written down here
 * rather than left for a future reader to notice as a discrepancy.
 *
 * SCHUYLKILL VALLEY has no entry in the supplied set because it has no
 * power. Its line stays as the codebase's own, which says so outright
 * rather than leaving a blank that reads as missing data.
 *
 * ==================================================================
 *  DESIGN NOTE 312 (preserved): TWO PRIVATES CANNOT RESERVE ONE HEX
 * ==================================================================
 *
 * The paraphrases this replaces once had D&H naming B20 -- C&SL's hex --
 * and M&H claiming F16, which is D&H's. The canonical text above settles it
 * by construction: C&SL is B-20, D&H is F-16, and M&H reserves nothing at
 * all because its power is the NYC exchange.
 *
 * KEPT AS A NOTE because two other files cite #312 by number
 * (`utils/privateReservations.ts` and `utils/sandboxState.ts`), and because
 * the DIVERGENCE it recorded is still live and still belongs on the
 * contract audit list:
 *
 *   ⚠ `auction.rs` gives Mohawk & Hudson a reserved hex of F16. On this
 *     board F16 is Scranton and Scranton is the D&H's. Nothing in the
 *     frontend reads the reserved hex to make a decision, so the divergence
 *     is cosmetic until the contract starts enforcing it -- and fixing it
 *     properly means changing `auction.rs`, not editing this text back.
 */
export const PRIVATE_COMPANY_CATALOG: Readonly<Record<number, PrivateCatalogEntry>> = {
  1: {
    acronym: "SV",
    revenue: 5,
    // Canonically correct: Schuylkill Valley is the one 1830 private with
    // NO special ability. Said outright rather than left blank, because a
    // blank slot reads as missing data.
    ability: "No special power \u2014 bought for its revenue and as cheap entry into the auction.",
  },
  2: {
    acronym: "C&StL",
    revenue: 10,
    ability:
      "A railroad owning the CL may lay a tile on the CL\u2019s hex (B-20). This hex need not be connected to one of the railroad\u2019s stations, and it need not be connected to any track at all. This tile placement may be performed in addition to the railroad\u2019s normal tile placement\u2014on that turn only it may play two tiles.",
  },
  3: {
    acronym: "D&H",
    revenue: 15,
    ability:
      "A railroad owning the DH may lay a track tile and a station token on the DH\u2019s hex (F-16). The mountain costs $120 as usual, but laying the token is free. This hex need not be connected to one of the railroad\u2019s stations, and it need not be connected to any track at all. The tile laid does count as the owning railroad\u2019s one tile placement for his turn. If the DH does not lay a station token on the turn it lays the tile on its starting hex, it must follow the normal rules when placing a station (i.e., it must have a legal train route to the hex). Other railroads may lay a tile on the DH starting hex subject to the ordinary rules, after which the DH special effects are no longer available",
  },
  4: {
    acronym: "M&H",
    revenue: 20,
    ability:
      "A player owning the MH may exchange it for a 10% share of NYC, provided he does not already hold 60% of the NYC shares and there is NYC shares available in the bank or the pool. The exchange may be made during the player\u2019s turn of a stock round or between the turns of other players or railroads in either stock or operating rounds. This action closes the MH.",
  },
  5: {
    acronym: "C&A",
    revenue: 25,
    ability:
      "The initial purchaser of the CA immediately receives a 10% share of PRR shares without further payment. This action does not close the CA. The PRR railroad will not be running at this point, but the shares may be retained or sold subject to the ordinary rules of the game.",
  },
  6: {
    acronym: "B&O",
    revenue: 30,
    ability:
      "The owner of the BO private company immediately receives the president\u2019s certificate of the B&O railroad without further payment and immediately sets a par share value. The BO private company may not be sold to any corporation, and does not change hands if the owning player loses the presidency of the B&O. When the B&O railroad purchases its first train this private company is closed down.",
  },
};
