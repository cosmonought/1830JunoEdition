// frontend/src/utils/playerLabels.ts
//
// WHAT TO CALL A PLAYER. One answer, for every surface.
//
// ==================================================================
//  DESIGN NOTE 559: TWO FUNCTIONS WITH ONE NAME
// ==================================================================
//
// REPORTED: in the Game Ledger's Corporation Assets panel the presidents
// are listed as `p-6aq2qcgg` rather than the names they set in the lobby.
//
// There were two `sandboxPlayerLabel`s. `App.tsx` declared a room-aware one
// at module scope; `utils/sandboxState.ts` exports the fixture's own
// Alice/Bob table under the same name. Every surface `App.tsx` rendered got
// real names, and the two components that imported the label directly --
// `FinancialLedger` and `ContextualSubPanel` -- got the fixture version,
// which has never heard of a room and correctly returns `null` for a `p-`
// id. The caller then fell back to `truncateAddress`, which is what the
// player saw.
//
// THE IMPORT LOOKED RIGHT, which is the whole difficulty. Nothing about
// `import { sandboxPlayerLabel } from "../utils/sandboxState"` suggests it
// resolves a different set of names from the identically-named function two
// files away, and the failure is silent and partial: most of the app shows
// names, one panel shows ids, and the panel that shows ids looks like it has
// a formatting bug rather than the wrong data source.
//
// So the registry lives here, and there is exactly one resolver. `App.tsx`
// imports it like everybody else -- being the file that happens to own the
// room does not entitle it to a private copy.
//

import { sandboxPlayerLabel as fixturePlayerLabel } from "./sandboxState";

/* ==================================================================
 *  DESIGN NOTE 535b: MODULE SCOPE, SO NO HOOK DEPENDS ON IT
 * ==================================================================
 *
 * The first cut of this resolver was a `useCallback` inside `AppShell`, and
 * the linter immediately named the cost: twelve hooks read it, so it became
 * a dependency of all twelve. A stable `[]` callback would have been
 * harmless in practice and would still have meant editing a dozen dependency
 * arrays to say so -- churn in exactly the hooks (the dispatch, the
 * auto-skip, the forced withhold) where an accidental rebuild re-arms an
 * effect that dispatches.
 *
 * A module-level map avoids the question rather than answering it. Its
 * lifetime is the tab, which is the same lifetime as the player id it keys
 * on (design note #528) and as the room itself -- and `AppShell` remounts on
 * any game change, so there is no stale-between-games case for it to carry.
 *
 * IT IS A FALLTHROUGH, not a replacement: no room means an empty map and the
 * fixture's own Alice/Bob table answers, exactly as it did before.
 */
let ROOM_NICKNAMES: Record<string, string> = {};
/* Design note #537b: whether a room has dealt. Distinct from "the map is
   empty" -- a room whose players all left blank nicknames would have an
   empty MAP and still must not borrow the fixture's names. */
let ROOM_ROSTER_ACTIVE = false;

export function setRoomNicknames(next: Record<string, string>): void {
  ROOM_NICKNAMES = next;
  ROOM_ROSTER_ACTIVE = true;
}

export function clearRoomNicknames(): void {
  ROOM_NICKNAMES = {};
  ROOM_ROSTER_ACTIVE = false;
}

/* ==================================================================
 *  DESIGN NOTE 537b: NO MOCK NAMES IN A REAL ROOM
 * ==================================================================
 *
 * Design note #535 made this a fallthrough -- room roster first, fixture
 * table second -- so solo sandbox kept Alice and Bob. That is right for the
 * solo case and wrong for a room, and the failure mode is the one worth
 * guarding against: if a real id ever failed to resolve, it would fall
 * through and be labelled with SOMEBODY ELSE'S NAME. A player mislabelled as
 * "Alice" is far worse than one labelled with a raw id, because it looks
 * correct. It would also be a name belonging to a person who is not in the
 * game, on a screen whose whole job is to say who is.
 *
 * So once a room has dealt, the fixture table is unreachable: an unknown id
 * returns `null` and every caller falls through to `truncateAddress`, which
 * is ugly and unmistakably NOT a claim about identity. Ugly and honest beats
 * tidy and wrong on a roster.
 */
export function sandboxPlayerLabel(address: string): string | null {
  const fromRoom = ROOM_NICKNAMES[address];
  if (fromRoom) return fromRoom;
  if (ROOM_ROSTER_ACTIVE) return null;
  return fixturePlayerLabel(address);
}
