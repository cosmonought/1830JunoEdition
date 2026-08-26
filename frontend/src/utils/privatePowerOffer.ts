// frontend/src/utils/privatePowerOffer.ts
//
// The private powers a corporation may use on its own turn, as offers with a hex and a sentence.
//
// ==================================================================
//  DESIGN NOTE 845: THE MARKED HEX ASKS
// ==================================================================
//
// THE PROBLEM, stated as a principle: "what a player needs to do needs to be present on the screen without
// scrolling or guessing where they need to look." A power lives in a subpanel below the fold; the player
// spends the Lay Track step looking at the map; nothing on the map offered the power, and the one thing that
// marked it was being drawn under a veil (#844).
//
// THREE AFFORDANCES WERE WEIGHED and two were built. The one that was NOT: making the private pills on the
// corporation card clickable. Ruled out by its own author -- "the addition of the PCs to the corp card is
// practically unnoticeable and players might still miss it" -- and the objection cannot be engineered around,
// because making an unnoticeable thing clickable does not make it noticeable. It also fails at the edge:
// Schuylkill Valley has no power, so some pills would answer a click and others would not, which teaches a
// player that pills are inert.
//
// THE FEAR ABOUT THE STICKY CHIP WAS MEASURED AND IS UNFOUNDED. "if somehow a corporation bought all five
// PCs, the sticky might overwhelm the screen" -- but only two 1830 privates have a Lay Track power at all
// (the D&H's F16 lay and the C&SL's B20 lay). SV has none; M&H and C&A are share exchanges; the B&O's share
// arrives at purchase. This list can never hold more than two entries, and `restingHeight` (#837) is there if
// that ever stops being true.
//
// SO ONE LIST FEEDS BOTH ENTRY POINTS. The hex the board rings and the chip the bar offers are the same
// offer, derived once -- otherwise the glow and the chip can disagree about whether a power is available,
// which is #815's three chip rows and #829's two vocabularies in a third costume.
//
// AND THE PROMPT MAY BE DECLINED, unlike #818's. That modal has no dismissal because a dismissal there is a
// forfeit and there is no third thing an X could mean. Declining THIS one costs nothing: the power is still
// unspent, the hex still rings, the chip still offers it. Two modals, two rules, and the difference is
// whether the question can be asked again.

import { PRIVATE_COMPANY_CATALOG } from "./privateCatalog";

/** The two hex-holding Lay Track powers. Named rather than open-ended: a third would need copy, a hex and a
 *  rule, none of which a wildcard could supply. */
export type PowerAbilityKey = "csl-tile" | "dh-tile";

export interface PrivatePowerOffer {
  abilityKey: PowerAbilityKey;
  privateId: number;
  /** `SV`/`CSL`/`DH`... -- the map's vocabulary since #364, and this panel's since #829. */
  acronym: string;
  /** `"q,r"`, matching the key the veil and the glow sets use. */
  hexKey: string;
  hexLabel: string;
  /** The chip's label. Short: it sits beside "Lay 1 Track" and "Skip Track". */
  chipLabel: string;
  /** The prompt's heading. */
  title: string;
  /** What the power does, in the catalog's own words -- so the modal and the private's card cannot describe
   *  one company two ways. */
  body: string;
  /** The accepting button. Names the hex, because accepting sends the player to it. */
  confirmLabel: string;
}

export interface PrivatePowerCandidate {
  privateId: number;
  abilityKey: PowerAbilityKey;
  hex: { q: number; r: number; hexLabel: string } | null;
  /** Owned by the acting corporation, unspent, unforfeited -- resolved by the shell, which holds the power
   *  state. This module decides what to SAY, never whether the power exists. */
  usable: boolean;
}

/** The usable offers, in the order given.
 *
 *  A CANDIDATE WITHOUT A HEX IS DROPPED, not rendered with a placeholder: `privateHexFor` returns `null` for
 *  an id with no reservation rule, and an offer that cannot name where to go is not an offer. */
export function privatePowerOffers(
  candidates: readonly PrivatePowerCandidate[],
): readonly PrivatePowerOffer[] {
  const offers: PrivatePowerOffer[] = [];
  for (const candidate of candidates) {
    if (!candidate.usable || candidate.hex === null) continue;
    const catalog = PRIVATE_COMPANY_CATALOG[candidate.privateId];
    if (catalog === undefined) continue;
    offers.push({
      abilityKey: candidate.abilityKey,
      privateId: candidate.privateId,
      acronym: catalog.acronym,
      hexKey: `${candidate.hex.q},${candidate.hex.r}`,
      hexLabel: candidate.hex.hexLabel,
      chipLabel: `Use ${catalog.acronym} Power`,
      title: `Use the ${catalog.acronym}'s private power?`,
      /* THE CATALOG'S FIRST BULLET, not a sentence written here. #661 built `abilityBullets` as the one
         description of a power, and a modal with prose of its own is how a rule comes to be stated twice and
         then corrected once. */
      body: catalog.abilityBullets[0] ?? catalog.ability,
      confirmLabel: `Use it on ${candidate.hex.hexLabel}`,
    });
  }
  return offers;
}

/** The hexes the board should ring, from the same offers the bar chips.
 *
 *  DERIVED RATHER THAN COMPUTED TWICE. `privatePowerGlowKeys` took its own list of candidates, so the glow
 *  and the offer could be built from two readings of the same state -- and a hex that rings but offers
 *  nothing when clicked is worse than one that never rang. */
export function privatePowerHexKeys(
  offers: readonly PrivatePowerOffer[],
): ReadonlySet<string> {
  return new Set(offers.map((offer) => offer.hexKey));
}

/** The offer a click on `hexKey` should raise, or `null` when the click is somebody else's business.
 *
 *  REFUSED WHILE AN ERRAND IS ARMED. Once a power is armed the same hex is where the player LAYS -- #725
 *  exists so that click reaches the tile picker -- so asking again would put a modal between them and the
 *  action they already agreed to.
 *  AND ONLY FOR THE ACTING VIEWER, per #413/#809: a watcher clicking F16 is inspecting the board, and an
 *  offer to use somebody else's power is an instruction they cannot follow. */
export function privatePowerOfferAt(input: {
  hexKey: string;
  actingViewer: boolean;
  errandArmed: boolean;
  offers: readonly PrivatePowerOffer[];
}): PrivatePowerOffer | null {
  if (!input.actingViewer || input.errandArmed) return null;
  return input.offers.find((offer) => offer.hexKey === input.hexKey) ?? null;
}
