// frontend/src/utils/ceremonySounds.ts -- design note #1419.
//
// WHICH SOUND, AT WHICH MOMENT OF THE CEREMONY. Nine clips were supplied in `public/audio/game over/` with the
// worry that "two sounds repeated ~12 times might be grating". So the mapping is by MOMENT rather than by
// accolade, and the two moments that recur most -- a card appearing, a card landing -- differ between the
// corporate and player halves and alternate within the player half. A game of twelve accolades plays no file
// more than four times.
//
// PURE, so the table is testable and the ceremony component only asks "what plays now". The shell turns the
// answer into `playVariantCue`, which owns the mute, the duck and the concurrency cap.

import type { Accolade } from "./accolades";

export type CeremonyCue =
  | { kind: "title" }
  | { kind: "present"; accolade: Accolade; ordinal: number }
  | { kind: "land"; accolade: Accolade; ordinal: number }
  | { kind: "sweep" }
  | { kind: "finale"; accolade: Accolade };

const DIR = "game over";

export const CEREMONY_SOUNDS = {
  drumroll: `${DIR}/drumroll.mp3`,
  horn: `${DIR}/tada_horn.mp3`,
  whistle: `${DIR}/train_whistle.mp3`,
  twinkle: `${DIR}/twinkle.mp3`,
  twinkleDown: `${DIR}/twinkle_down.mp3`,
  magical: `${DIR}/magical.mp3`,
  tadaTwinkle: `${DIR}/tada_twinkle.mp3`,
  clap: `${DIR}/accolade_clap.mp3`,
  stinger: `${DIR}/robber_baron_stinger.mp3`,
  /** #1426: supplied for the Yellow Sign's two awards. */
  carcosan: `${DIR}/carcosan.mp3`,
  /* #1428: SUPPLIED PER ACCOLADE, named for the award each goes to. Levelled to one loudness so a quiet clip
     does not follow a loud one; `corporate_raider` is the supplied `cha-ching` spliced in front of the
     supplied `sinister_sting` -- the take, then the menace. */
  capitalistPig: `${DIR}/capitalist_pig.mp3`,
  corporateRaider: `${DIR}/corporate_raider.mp3`,
  mountainMover: `${DIR}/mountain_mover.mp3`,
  orphanage: `${DIR}/orphanage.mp3`,
  paperMillionaire: `${DIR}/paper_millionaire.mp3`,
  passenger: `${DIR}/passenger.mp3`,
  phaseRusher: `${DIR}/phase_rusher.mp3`,
  redeemer: `${DIR}/redeemer.mp3`,
  theWall: `${DIR}/the_wall.mp3`,
  trainRobber: `${DIR}/train_robber.mp3`,
  whiteElephant: `${DIR}/white_elephant.mp3`,
  wrongWayDown: `${DIR}/wrong_way_down.mp3`,
} as const;

/** #1428: an award with its own clip plays it, whatever its tone. #1429: the four staged clips join, and the
 *  Farmhand borrows the in-game cow. */
const ACCOLADE_SOUNDS: Readonly<Partial<Record<Accolade["key"], string>>> = {
  orphanage: CEREMONY_SOUNDS.orphanage,
  passenger: CEREMONY_SOUNDS.passenger,
  "white-elephant": CEREMONY_SOUNDS.whiteElephant,
  "wrong-way-down": CEREMONY_SOUNDS.wrongWayDown,
  farmhand: "cow-happy.mp3",
  "capitalist-pig": CEREMONY_SOUNDS.capitalistPig,
  "corporate-raider": CEREMONY_SOUNDS.corporateRaider,
  "mountain-mover": CEREMONY_SOUNDS.mountainMover,
  "paper-millionaire": CEREMONY_SOUNDS.paperMillionaire,
  "phase-rusher": CEREMONY_SOUNDS.phaseRusher,
  redeemer: CEREMONY_SOUNDS.redeemer,
  "the-wall": CEREMONY_SOUNDS.theWall,
  "train-robber": CEREMONY_SOUNDS.trainRobber,
  "carcosan-railways": CEREMONY_SOUNDS.carcosan,
};

/** #1426: the four core player awards each get their own announcement -- "the last four awards all having
 *  the same sound feels anti-climactic". The Robber Baron's is the stinger, fired as the finale. */
const CORE_SOUNDS: Readonly<Partial<Record<Accolade["key"], string>>> = {
  "master-of-the-line": CEREMONY_SOUNDS.whistle,
  "track-boss": CEREMONY_SOUNDS.horn,
  "market-manipulator": CEREMONY_SOUNDS.clap,
  "robber-baron": CEREMONY_SOUNDS.stinger,
};

/** The whistle is for the two awards that are about trains; everything else corporate gets the horn. */
const WHISTLE_KEYS: ReadonlySet<Accolade["key"]> = new Set<Accolade["key"]>(["early-adopter", "fleet-admiral"]);

/** RULED: the descending twinkle is for "awards that are more hostile to other players" -- won at somebody
 *  else's expense, or a misfortune wearing a ribbon. Whatever the scope, these get it instead of the fanfare.
 *  Fundraiser is not here: paying out of pocket is sympathetic, not hostile. */
const SARDONIC_KEYS: ReadonlySet<Accolade["key"]> = new Set<Accolade["key"]>([
  "the-wall",
  "train-robber",
  "corporate-raider",
  "gravedigger",
  "rust-belt",
  "scrooge-company",
  "shell-corporation",
  // #1429
  "bagholder",
  "sugar-daddy",
  "greater-fool",
  "human-stop-loss",
  "orphanage",
  "white-elephant",
  "wrong-way-down",
]);

/** The file for a cue, relative to `/audio/`, or `null` for a moment that is silent. */
export function ceremonySoundFor(cue: CeremonyCue): string | null {
  switch (cue.kind) {
    case "title":
      return CEREMONY_SOUNDS.drumroll;
    case "sweep":
      return CEREMONY_SOUNDS.twinkle;
    case "finale":
      return CEREMONY_SOUNDS.stinger;
    case "present": {
      const own = ACCOLADE_SOUNDS[cue.accolade.key];
      if (own) return own;
      if (SARDONIC_KEYS.has(cue.accolade.key)) return CEREMONY_SOUNDS.twinkleDown;
      if (cue.accolade.scope === "corporation") {
        return WHISTLE_KEYS.has(cue.accolade.key) ? CEREMONY_SOUNDS.whistle : CEREMONY_SOUNDS.horn;
      }
      /* #1423: THE CLAP IS A CORE AWARD'S FANFARE, NOT ITS LANDING. It was played on the landing of the four
         core player awards, and REPORTED: "it's the applause in particular that runs over things on the last
         four or five accolades" -- a two-second clap starting at a half-second landing runs a second and a
         half into the next card's own sound. So the core player awards are announced BY the applause, on the
         same beat every other card is announced on, and nothing plays at any landing. */
      if (cue.accolade.core) return CORE_SOUNDS[cue.accolade.key] ?? CEREMONY_SOUNDS.clap;
      // The finale's own present is the stinger, fired as `finale`; this is every other player card.
      return cue.ordinal % 2 === 0 ? CEREMONY_SOUNDS.magical : CEREMONY_SOUNDS.tadaTwinkle;
    }
    case "land":
      /* SILENT. The card's own sound is still ringing when it lands; a sound here stacked on the next card's. */
      return null;
    default:
      return null;
  }
}
