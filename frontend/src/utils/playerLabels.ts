// What to call a player. One answer, for every surface.
//
// Design note #559: there were TWO `sandboxPlayerLabel`s -- a room-aware one at
// `App.tsx` module scope, and `utils/sandboxState.ts`'s fixture Alice/Bob table
// under the same name. `FinancialLedger` and `ContextualSubPanel` imported the
// fixture version, which has never heard of a room and correctly returns `null`
// for a `p-` id, so those two panels fell back to `truncateAddress`.
//
// THE IMPORT LOOKED RIGHT, which is the whole difficulty, and the failure is
// silent and partial: most of the app shows names, one panel shows ids, and the
// panel that shows ids looks like it has a formatting bug rather than the wrong
// data source. One registry, one resolver -- owning the room does not entitle
// `App.tsx` to a private copy.
//
// See docs/ai_architecture/ui_shell_layout.md, playerLabels.ts #559.

import { sandboxPlayerLabel as fixturePlayerLabel } from "./sandboxState";

/* Design note #535b: MODULE SCOPE, so no hook depends on it. The first cut was a
   `useCallback` in `AppShell`, and the linter named the cost immediately: twelve
   hooks read it, so it became a dependency of all twelve -- churn in exactly the
   hooks (the dispatch, the auto-skip, the forced withhold) where an accidental
   rebuild re-arms an effect that dispatches.

   A module-level map avoids the question rather than answering it. Its lifetime
   is the tab, the same lifetime as the player id it keys on (#528) and as the
   room; `AppShell` remounts on any game change, so there is no stale case. */
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

/* Design note #537b: NO MOCK NAMES IN A REAL ROOM. #535's fallthrough is right
   for solo sandbox and wrong for a room -- a real id that failed to resolve
   would be labelled with SOMEBODY ELSE'S NAME, which is far worse than a raw id
   because it looks correct, on a screen whose whole job is to say who is here.
   Once a room has dealt, the fixture table is unreachable and callers fall
   through to `truncateAddress`: ugly and honest beats tidy and wrong.

   Design note #578: with no solo sandbox left, the fixture branch is reachable
   only in the moments before a room's `SetupGame` replays. KEPT, not deleted,
   because the fixture still seeds the BOARD a room boots from, so a corporation
   could momentarily carry a fixture president -- the guard is the part that
   matters, and it stays. */
export function sandboxPlayerLabel(address: string): string | null {
  const fromRoom = ROOM_NICKNAMES[address];
  if (fromRoom) return fromRoom;
  if (ROOM_ROSTER_ACTIVE) return null;
  return fixturePlayerLabel(address);
}


/* Design note #569: a seat colour that does a job. ASKED whether the player
   cards work better with colours, noting "the colors don't get used elsewhere"
   -- which is the whole argument, and it points at a fix rather than a removal:
   colour in exactly one place is decoration; colour meaning the same thing in
   several places is a language.

   So it gets a second job. The action bar is easy to see during an Operating
   Round because it wears the acting CORPORATION's livery, and hard to see in the
   Auction and Stock Rounds, which have no corporation to borrow from -- but they
   have an acting PLAYER.

   NOT the corporation liveries, on instruction: a player stripe in the PRR's red
   would read as a claim about the PRR. CHOSEN OR ASSIGNED -- both paths live
   here rather than the picker owning the fallback, so no seat is ever colourless
   and two seats can never share a colour. */
/* ==================================================================
    DESIGN NOTE 1097: THREE SEATS RE-CUT, AND ONE OF THEM STOPS BEING GREEN
   ==================================================================
   TWO FAULTS, FOUND TOGETHER (TECH_DEBT TD-4). Three of the six were too faint on the president badge's
   white plate -- Moss 4.10:1, Teal 3.98:1, Ochre 3.30:1, all under the 4.5 floor. And #569's own rule above
   -- "a player stripe in the PRR's red would read as a claim about the PRR" -- was being broken by Moss,
   which sat 8.2 dE from the B&M's green. Close enough to read as the same colour, on a board where green
   already means a corporation.

   MOSS COULD NOT BE SAVED AS A GREEN. The B&M owns mid-green; the whole space was searched, and every green
   dark enough to clear 4.5:1 on white lands within ~11 dE of it. The choice was a tighter margin or a
   different hue, and the hue was chosen deliberately: #569's rule is about player colour never making a
   claim about a corporation, and the cleanest way to honour it is for the player set to stop competing for
   the board's hues at all. Mulberry sits in genuinely empty space -- 24.8 dE from its nearest corporation,
   26.3 from Plum, and separated from Plum by 27 points of LIGHTNESS as well as hue, so the two hold apart
   for a reader who cannot use the hue difference.

   THE OTHER TWO ARE ORDINARY DARKENINGS, same names, same character.

   WHAT THIS DOES NOT FIX: Brick is 12.9 dE from the CPR's brown -- below the 15 this pass treated as the
   bar, above the 8.4 the codebase floors at. It was not one of the three failing contrast and is left
   alone rather than swept up; recorded here so the next reader knows it was seen and not missed.

   STORED SEATS ARE NOT MIGRATED. A room already holding `#4f8a5c` keeps rendering it -- `player.color`
   wins over this list, and `SEAT_COLOR_NAMES` falls back to the raw hex for anything unlisted, which is
   why every call site writes `?? color`. Existing games therefore keep the old dots; new ones get these. */
export const SEAT_COLORS = [
  "#3f6fa8",
  "#a8593f",
  "#5a003c",
  "#7a5aa8",
  "#847400",
  "#00686c",
] as const;

export const SEAT_COLOR_NAMES: Readonly<Record<string, string>> = {
  "#3f6fa8": "Slate blue",
  "#a8593f": "Brick",
  "#5a003c": "Mulberry",
  "#7a5aa8": "Plum",
  "#847400": "Ochre",
  "#00686c": "Teal",
};

let ROOM_COLORS: Record<string, string> = {};

export function setRoomColors(next: Record<string, string>): void {
  ROOM_COLORS = next;
}

/** This seat's colour: their own choice, else the palette by index.
 *
 *  `index` rather than a hash of the address, deliberately -- a hash gives two
 *  seats the same colour roughly a third of the time at six players, and
 *  "roughly" is not a property a table of six people can live with. */
export function seatColor(address: string, index: number): string {
  return ROOM_COLORS[address] ?? SEAT_COLORS[index % SEAT_COLORS.length];
}

/** Which colours are already spoken for, so a picker can grey them out. */
export function takenSeatColors(exceptId?: string): ReadonlySet<string> {
  const taken = new Set<string>();
  for (const [id, color] of Object.entries(ROOM_COLORS)) {
    if (id !== exceptId) taken.add(color);
  }
  return taken;
}
