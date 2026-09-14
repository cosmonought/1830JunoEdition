// frontend/src/utils/privateOrdinal.ts
//
// The number a private company is called by, everywhere it is named.
//
// ==================================================================
//  DESIGN NOTE 1370: THE NUMBER IS THE AUCTION POSITION, NOT THE CATALOG ID
// ==================================================================
//
// REPORTED: "On LPF, the numbering on the private companies is correct in the Auction Round, but it's
// incorrect on the player cards and elsewhere. Mine lists '1. SV' '7. JK' '6. BO' and those numbers are wrong."
//
// EVERY SURFACE PRINTED `private_id`, and in the printed game that IS the position: ids 1-6 are the six
// privates in face-value order, which is the order the waterfall offers them, which is the order a player
// reads off the auction screen and says out loud (#341, #568). The Level Playing Field broke the coincidence.
// Its seventh private keeps id 7 -- ids are what the log and the reducer key on and cannot move (#1320) --
// and is offered by face value between the M&H and the C&A. So the table plays an auction that goes SV, CS,
// DH, MH, JK, CA, BO, and then every card outside it says "7. JK" and "6. BO" about the fifth and seventh.
//
// SO THE NUMBER IS DERIVED FROM THE ORDER IN PLAY. `private_companies` is dealt in auction order -- the
// LPF splice puts the JK after the last private cheaper than it -- so a private's number is one more than its
// index there. For the printed game that is its id, exactly as before; for the LPF it is the number the
// auction screen already showed.
//
// A REGISTRY RATHER THAN A PROP, for `playerLabels.ts` #535b's reason: nine surfaces print this string --
// cards, ledger, trade panel, action bar, auction, revenue modal, the feed's two writers -- with nine prop
// shapes between them, and the fact they all need is one short list that changes once, at the deal. The shell
// writes it whenever the roster of privates changes; everything else asks. With nothing written (a test, a
// headless replay, a surface rendered before any state) the id stands in, which is the old behaviour.

let ORDER: readonly number[] = [];

/** The shell calls this with the state's privates, in the order they are held. Idempotent. */
export function setPrivateOrder(privates: ReadonlyArray<{ private_id: number }>): void {
  ORDER = privates.map((entry) => entry.private_id);
}

/** Tests only. */
export function clearPrivateOrder(): void {
  ORDER = [];
}

/** The number this private is called by: its position in the order in play, else its id. */
export function privateOrdinal(privateId: number): number {
  const at = ORDER.indexOf(privateId);
  return at === -1 ? privateId : at + 1;
}

/** "5. James River & Kanawha Company" -- the one form every surface uses (#1052). */
export function numberedPrivate(privateId: number, name: string): string {
  return `${privateOrdinal(privateId)}. ${name}`;
}
