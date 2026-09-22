// frontend/src/components/trainRustFlourish.ts
//
// What a rusting train chip does on its way out -- VF-7 (VISUAL_FLOURISH_BACKLOG.md). Schedule, crack
// geometry and stylesheet only; `TrainBadges.tsx` renders it, `App.tsx` raises it. The split VF-1, VF-3,
// VF-4 and VF-6 all keep.
//
/* ==================================================================
    DESIGN NOTE (VF-7): RUST IS DESTRUCTION, AND IT MUST NOT LOOK ADMINISTRATIVE
   ==================================================================
   THE WHOLE POINT OF THIS VOCABULARY IS WHAT IT IS NOT. A train-limit discard is a president choosing a
   train, a clean removal, a card going to the Bank Pool where somebody may buy it again. Rust is the
   opposite in every respect: nobody chose, nothing is recoverable, and the train has left the game. #896
   already split the two by CAUSE in the copy and #990 records getting the lore wrong in the other
   direction ("the train is already back in the depot", of a discard that is permanently removed). So the
   two need two vocabularies, and this one is the destructive half: oxidation, an irregular structural
   fracture, failure, and a slot that closes.

   THE FAILURE IS SMALL, DELIBERATELY. The brief rules out explosion, flying debris, a physics sequence and
   arcade shake, and the surface argues the same way: these are 24px chips in a table of eight
   corporations, and a rust event can take six of them at once. One shudder of a pixel or two and a few
   pixels of separation is the most this surface can carry before it reads as a rendering fault.

   THE MODEL STAYS READABLE THROUGH MOST OF THE SEQUENCE, which is a requirement rather than a nicety: the
   player's question at this instant is WHAT they just lost, and a chip that dissolves before it can be
   read answers the wrong one. Oxidation keeps full text contrast, the fracture draws over it, and the text
   goes only with the chip itself. */

/* ==================================================================
    THE EVENT: ONE GLOBAL RUST, HOWEVER MANY CORPORATIONS IT TOUCHED
   ==================================================================
   A phase change rusts every corporation's doomed trains in one reducer call, so this is ONE event with a
   list inside it rather than a queue of per-corporation events. That is not merely tidy -- it is what lets
   every chip on the board run off one clock, and it is what makes "one cue per event, never one per train"
   expressible at all.

   THE MEMBERS CARRY `before`, NOT JUST THE MODELS TAKEN. Staging needs the roster AS IT WAS -- the chips
   in their original positions, with the doomed ones still among them -- and reconstructing that by pushing
   the lost models onto the end of the authoritative roster would put them in the wrong place and reorder
   the survivors. The shell has `before` in hand at the moment it narrates (#704's division), so it hands
   it over rather than making the chip guess. */

/** One corporation's share of a rust event. */
export interface RustedFleet {
  companyId: number;
  ticker: string;
  /** `owned_trains` as it stood BEFORE the dispatch -- the roster the chips stage. */
  before: readonly string[];
  /** The models rust destroyed, with multiplicity, in the order the reducer took them. */
  rusted: readonly string[];
}

/** What the shell hands down: one authoritative rust event, plus a token so a second genuine rust replays
 *  rather than sitting finished -- #1060's idiom, kept by every flourish event since. */
export interface RustFlourishEvent {
  corporations: readonly RustedFleet[];
  token: number;
}

/** This corporation's share of the event, or `null` when the event did not touch it. A chip asks this and
 *  nothing else; it never inspects the other members. */
export function rustedFleetFor(
  event: RustFlourishEvent | null | undefined,
  companyId: number | null | undefined,
): RustedFleet | null {
  if (!event || companyId == null) return null;
  return event.corporations.find((entry) => entry.companyId === companyId) ?? null;
}

/* ==================================================================
    DESIGN NOTE (VF-7): "RUSTED" IS NOT ALWAYS "DESTROYED", AND THE DIFFERENCE IS THE WHOLE OF SECTION 8
   ==================================================================
   FOUND BY RUNNING IT, against the Gentle Rust case the brief singles out. `describeFleetLosses` reports
   the newly MARKED models as `rusted` under that variant -- deliberately, and #979 explains why: rust
   stops removing anything, so "the reprieve is diffed too ... trains newly ADDED to
   `pending_rust_trains` are the rust event", because otherwise the notice would go silent for the one
   variant whose whole point is announcing it. That is right for a SENTENCE and wrong for a DESTRUCTION
   ANIMATION: the trains are still in the fleet, still runnable, and still drawn as chips.

   SO THE FLOURISH INTERSECTS THE NARRATOR'S ANSWER WITH AN OBSERVABLE FACT -- did these models actually
   leave `owned_trains` between the two settled states. Nothing here re-derives a rule (A-4): which
   trains rust is still entirely `describeFleetLosses`' and `describeReprieveExpiries`' answer, and this
   only asks whether the reducer has yet acted on it.

   AND IT IS A DESTRUCTION TEST RATHER THAN A VARIANT TEST, which matters more than it looks. The obvious
   fix was `if (!gentleRustOn)` at the collection site -- correct today, and a rule stated in a second
   place that a third variant, or a change to when marks clear, would have to remember to update. Asking
   the fleets themselves cannot go stale: a marking destroys nothing and yields nothing here; an expiry
   destroys and yields; a standard rust destroys and yields. One rule, three cases, no special case.

   THE MULTISET AGAIN, for the reason every other one in this file exists: a corporation holding two
   2-trains that loses one has one destroyed model and one survivor of the same name. */

/** The subset of `rusted` that has genuinely left the fleet between two settled rosters.
 *
 *  `null` on either roster is "the chain did not say" (#232/#897), and a fleet that cannot be compared
 *  yields nothing -- A-3's direction, since an invented destruction is worse than a missing flourish. */
export function destroyedRustedModels(
  before: readonly string[] | null | undefined,
  after: readonly string[] | null | undefined,
  rusted: readonly string[],
): readonly string[] {
  if (before == null || after == null) return [];
  const remaining = [...after];
  const gone: string[] = [];
  for (const model of before) {
    const at = remaining.indexOf(model);
    if (at >= 0) remaining.splice(at, 1);
    else gone.push(model);
  }
  const pool = [...gone];
  const destroyed: string[] = [];
  for (const model of rusted) {
    const at = pool.indexOf(model);
    if (at < 0) continue;
    pool.splice(at, 1);
    destroyed.push(model);
  }
  return destroyed;
}

/** Which positions in the staged roster are the ones rusting.
 *
 *  A MULTISET, CONSUMED AS IT MATCHES, which is this file's third instance of a rule the codebase keeps
 *  relearning (#1004's reprieve pool, #1088's ghost pool, `trimToTrainLimit`'s own off-by-one). A
 *  corporation holding two 2-trains that loses ONE of them must show one chip rusting and one intact; a
 *  `.includes` would rust both.
 *  LEFT TO RIGHT, because that is the order `applyPhaseChange` filters in and therefore the order in which
 *  the survivors keep their places. */
export function rustingPositions(
  before: readonly string[],
  rusted: readonly string[],
): ReadonlySet<number> {
  const pool = [...rusted];
  const out = new Set<number>();
  before.forEach((model, index) => {
    const at = pool.indexOf(model);
    if (at < 0) return;
    pool.splice(at, 1);
    out.add(index);
  });
  return out;
}

/* ==================================================================
    FULL-MOTION TIMELINE
   ==================================================================
   Brief: "roughly 450-600 ms", and the named beats are NORMAL -> OXIDATION -> FRACTURE -> FAILURE ->
   DISAPPEAR -> ROSTER SETTLES. Those are four stages plus a settle, and the one that is easy to get wrong
   is the gap between FAILURE and the roster closing: if the slot collapses while the chip is still
   fading, the surviving chips slide under a ghost and the whole thing reads as a layout bug. So the chip
   reaches zero opacity BEFORE its slot is given up, and the roster settles once, cleanly, afterwards. */

/** Oxidation: a muted oxide wash crosses the chip. Text stays at full contrast throughout. */
export const RUST_OXIDISE_MS = 190;
/** The fracture begins -- THE BEAT THE EVENT IS ABOUT, and the audio cue point if a cue ever exists. */
export const RUST_FRACTURE_AT_MS = RUST_OXIDISE_MS;
export const RUST_FRACTURE_MS = 140;
/** Failure: one small shudder, a few pixels of separation, opacity to zero. */
export const RUST_FAIL_AT_MS = RUST_FRACTURE_AT_MS + RUST_FRACTURE_MS;
export const RUST_FAIL_MS = 120;
/** ==================================================================
 *   THE SLOT IS GIVEN UP AFTER THE CHIP IS GONE, NOT WITH IT
 *  ==================================================================
 *  The chip is at zero opacity when `RUST_FAIL_MS` elapses and STILL OCCUPIES ITS SLOT until here -- which
 *  is the one instant the staged roster is dropped for the authoritative one and the survivors close up.
 *  Collapsing the slot during the fade would slide the surviving chips leftwards underneath a chip that is
 *  still visible, and a row that moves while something on it is disappearing reads as a glitch rather than
 *  as a loss. Two beats, in the order the brief names them: DISAPPEAR, then ROSTER SETTLES. */
export const RUST_VACATE_AT_MS = RUST_FAIL_AT_MS + RUST_FAIL_MS;
/** How long the row takes to close up. */
export const RUST_VACATE_MS = 80;
/** VF-4/VF-6's settle: the last frame carries NO class and NO animation, so the resting row is the
 *  ordinary row rather than an animation holding its final keyframe. */
export const RUST_TOTAL_MS = RUST_VACATE_AT_MS + RUST_VACATE_MS;

/* ==================================================================
    REDUCED-MOTION TIMELINE
   ==================================================================
   Brief: "normal chip -> brief rust tint -> crossfade away -> roster closes. No shudder. No fragment
   travel. No crack-piece separation animation. If a static crack appears briefly, that is acceptable, but
   do not animate its propagation."
   SO THE CRACK STAYS AND ONLY ITS DRAWING GOES. The fracture is what distinguishes rust from every other
   way a chip can leave, and a reader who has switched off motion is entitled to the same information
   (#26's rule, which this codebase applies to the auction ring and the final-run fade). It is rendered
   whole, at once, with no dash-offset animation behind it -- which is a static mark, not a movement. */
export const RUST_REDUCED_OXIDISE_MS = 90;
export const RUST_REDUCED_FRACTURE_AT_MS = RUST_REDUCED_OXIDISE_MS;
export const RUST_REDUCED_FRACTURE_MS = 40;
export const RUST_REDUCED_FAIL_AT_MS = RUST_REDUCED_FRACTURE_AT_MS + RUST_REDUCED_FRACTURE_MS;
export const RUST_REDUCED_FAIL_MS = 110;
export const RUST_REDUCED_VACATE_AT_MS = RUST_REDUCED_FAIL_AT_MS + RUST_REDUCED_FAIL_MS;
export const RUST_REDUCED_VACATE_MS = 50;
export const RUST_REDUCED_TOTAL_MS = RUST_REDUCED_VACATE_AT_MS + RUST_REDUCED_VACATE_MS;

/* ==================================================================
    NAMED MILESTONES, RESOLVED AGAINST THE ACTIVE SCHEDULE
   ==================================================================
   VF-4's correction and VF-6's practice: anything that has to happen "once the fracture is visible" or
   "once the row has settled" names the BEAT, and the timeline being played supplies the number. A
   full-motion constant used under reduced motion is dead air charged to the reader who asked for less
   presentation -- and here it would hold the Tutorial modal for half a second after a 240ms sequence has
   finished. `rustTimeline` is the single source for both these milestones and the sequence's own beats. */
export interface RustTimeline {
  /** The fracture's first frame. The audio cue point, and the earliest moment the event is legible. */
  fracturedAt: number;
  /** The one instant the staged roster is dropped for the authoritative one. */
  vacatedAt: number;
  /** The whole sequence; afterwards the row is the ordinary row. */
  totalMs: number;
}

export function rustTimeline(reducedMotion: boolean): RustTimeline {
  return reducedMotion
    ? {
        fracturedAt: RUST_REDUCED_FRACTURE_AT_MS,
        vacatedAt: RUST_REDUCED_VACATE_AT_MS,
        totalMs: RUST_REDUCED_TOTAL_MS,
      }
    : {
        fracturedAt: RUST_FRACTURE_AT_MS,
        vacatedAt: RUST_VACATE_AT_MS,
        totalMs: RUST_TOTAL_MS,
      };
}

export type RustMilestone = "fractured" | "vacated" | "settled";

/** How long a surface waiting for `milestone` waits, under the timeline currently being played. */
export function rustMilestoneMs(milestone: RustMilestone, reducedMotion: boolean): number {
  const timeline = rustTimeline(reducedMotion);
  if (milestone === "fractured") return timeline.fracturedAt;
  if (milestone === "vacated") return timeline.vacatedAt;
  return timeline.totalMs;
}

/* ==================================================================
    NO STAGGER, AND THAT IS A DECISION RATHER THAN AN OMISSION
   ==================================================================
   The brief permits "a tiny deterministic stagger ... if it materially improves readability", with two
   conditions: the event stays short, and the order must not imply rules precedence that does not exist.
   THE SECOND CONDITION IS THE PROBLEM. Any stagger has to be ordered by something, and the only orders
   available here are the operating order or the company id -- both of which a player will read as "this
   corporation lost its trains first", which is false: one reducer call destroys every doomed train in the
   same instant, and 1830 has no sequence among them.
   SO EVERY CHIP RUNS ON ONE CLOCK. If the simultaneous version reads as a single indistinct flicker at
   playtest, a stagger can be added -- but it should then be ordered by something meaningless on purpose
   (a hash of the model, say) rather than by anything a player could mistake for precedence. Recorded in
   the backlog rather than left as an unused constant. */

/* ==================================================================
    AUDIO: OPEN, AND SILENT UNTIL IT IS ANSWERED
   ==================================================================
   Wanted: one short brittle cast-iron fracture per GLOBAL EVENT, dry, a single useful onset, perhaps a
   small muted debris component. Ruled out by name: metal screech, long clang, explosion, crash pile, steam
   hiss, shovel/dirt, cinematic boom.
   THE TREE WAS AUDITED CLIP BY CLIP AND HAS NO UNOWNED CANDIDATE. Every clip in `public/audio` with the
   right envelope is already claimed by `variantSfx.ts`'s flavour-text matcher, where it means "the line
   the ticker just printed mentions this thing": `metal_clunk.mp3` (`/coupling|axles|wheels/`),
   `engine_trouble.mp3` (`/broke down|defective/`), `machinery.mp3` (`/iron|factory|mills/`),
   `tree-branch.mp3` (`/fallen tree/`) and `iec-crack.mp3` (`/ice/`). The rest are the excluded list
   itself -- `crash.mp3`, `explosion.mp3`, `rockslide.mp3`, `steam_hiss.mp3`, `shovel.mp3`,
   `spooky_gong.mp3`, `thunder.mp3`.
   THE NEAR MISS IS NAMED RATHER THAN BURIED, because the owner may want to overrule this cheaply:
   `iec-crack.mp3` is exactly the right ENVELOPE -- a dry brittle fracture with one onset and no tail --
   and the only objection is that a flavour line mentioning ice would then play the sound of the most
   consequential event in the game. #1040 records that matcher as the worst false-positive in the table
   ("23 of 25 matches were service, office, price, twice, choice"), which cuts both ways: the collision is
   rare, and the collision is with a matcher already known to fire wrongly.
   SO RUST SHIPPED SILENT, and the specification went into the backlog with its cue point: ONE cue per
   global event, fired on the `fractured` milestone -- never on oxidation, and never once per train --
   under the master SFX switch with no category of its own (#1457's rule for the presidency cue).

   ==================================================================
    ANSWERED BY THE AUDIO WIRING PASS: `rust.mp3`
   ==================================================================
   Supplied rather than found, so `iec-crack.mp3` keeps its ice. A stylised brittle break of 2.0s, and
   measuring it is what settled the alignment: it is not one hit but a SEQUENCE -- near silence, then a
   decisive crack at ~100ms (peak 31738 out of a floor around 200), then a clatter of secondary breaks
   spread over 230-540ms, then a tail.
   THE PRINCIPAL IMPACT IS THE FIRST CRACK, NOT THE LOUDEST WINDOW. The whole-clip loudest 10ms RMS is at
   525ms and the whole-clip peak sample at 387ms, and BOTH ARE INSIDE THE CLATTER. Taking either as the
   alignment point -- which a naive "find the peak" measurement does -- would have started the clip so
   early that its opening crack landed during oxidation, before anything had fractured. The event's own
   onset is the break out of silence; everything after it is that break's debris, and the debris is
   exactly what the brief wants falling across the failure phase ("the secondary brittle/clatter tail may
   naturally accompany the existing failure/shatter portion"). */

/** The clip, in `public/audio/`. */
export const RUST_SFX = "rust.mp3";

/* The first crack, measured three ways inside a 3ms band (ffmpeg decode to raw mono PCM): the peak
   sample at 100.4ms, the loudest 10ms RMS window of that transient centred at 101ms, and the first
   sample above 30% of that transient's peak at 97.5ms. VF-3's method on `floated.mp3` exactly. */
export const RUST_AUDIO_IMPACT_OFFSET_MS = 100;

/** When to start the clip so its first crack lands on `fractured`, against the ACTIVE schedule.
 *
 *  THE CLAMP IS LIVE UNDER REDUCED MOTION, unlike the Bank's. That timeline fractures at 90ms, which is
 *  earlier than the clip's own crack at 100ms, so the earliest legal start -- the sequence's own
 *  beginning -- puts the crack 10ms after the fracture rather than on it. Ten milliseconds is a third of
 *  a frame and nothing else could be done about it without seeking into the file or trimming the asset,
 *  both of which VF-3 ruled out for `floated.mp3` (whose equivalent miss is 298ms). */
export function rustCueAtMs(reducedMotion: boolean): number {
  const fracturedAt = reducedMotion ? RUST_REDUCED_FRACTURE_AT_MS : RUST_FRACTURE_AT_MS;
  return Math.max(0, fracturedAt - RUST_AUDIO_IMPACT_OFFSET_MS);
}

export type RustStageKind = "oxidise" | "fracture" | "fail" | "vacate";

export interface RustStage {
  kind: RustStageKind;
  at: number;
  durationMs: number;
}

export interface RustApplication {
  /** A set, for parity with VF-1/VF-3/VF-4/VF-6, though exactly one field lands. */
  applies: readonly ["vacated"];
  at: number;
}

export interface RustSequence {
  reducedMotion: boolean;
  stages: readonly RustStage[];
  applications: readonly RustApplication[];
  fracturedAt: number;
  vacatedAt: number;
  totalMs: number;
}

/** The running order for one rust event, or `null` when there is nothing to show. Pure: no measurement,
 *  no timers, no rules re-derivation -- it is handed a completed fact and turns it into a schedule. */
export function buildRustSequence(
  event: { corporations: readonly RustedFleet[] } | null,
  reducedMotion: boolean,
): RustSequence | null {
  if (!event || event.corporations.length === 0) return null;
  const timeline = rustTimeline(reducedMotion);
  const stages: readonly RustStage[] = reducedMotion
    ? [
        { kind: "oxidise", at: 0, durationMs: RUST_REDUCED_OXIDISE_MS },
        { kind: "fracture", at: timeline.fracturedAt, durationMs: RUST_REDUCED_FRACTURE_MS },
        { kind: "fail", at: RUST_REDUCED_FAIL_AT_MS, durationMs: RUST_REDUCED_FAIL_MS },
        { kind: "vacate", at: timeline.vacatedAt, durationMs: RUST_REDUCED_VACATE_MS },
      ]
    : [
        { kind: "oxidise", at: 0, durationMs: RUST_OXIDISE_MS },
        { kind: "fracture", at: timeline.fracturedAt, durationMs: RUST_FRACTURE_MS },
        { kind: "fail", at: RUST_FAIL_AT_MS, durationMs: RUST_FAIL_MS },
        { kind: "vacate", at: timeline.vacatedAt, durationMs: RUST_VACATE_MS },
      ];
  return {
    reducedMotion,
    stages,
    applications: [{ applies: ["vacated"], at: timeline.vacatedAt }],
    ...timeline,
  };
}

/** The stage active at `elapsedMs`, or `null` outside the sequence. VF-3's `floatStageAt`. */
export function rustStageAt(sequence: RustSequence, elapsedMs: number): RustStage | null {
  let current: RustStage | null = null;
  for (const stage of sequence.stages) {
    if (stage.at <= elapsedMs) current = stage;
  }
  return current;
}

/* ==================================================================
    THE CRACK: PROCEDURAL, DETERMINISTIC, AND RESOLUTION-FREE
   ==================================================================
   Brief: "jagged diagonal / branching crack; not a straight geometric split ... procedural/CSS/SVG where
   practical, not a raster image tied to one chip size."

   AN SVG PATH IN A 0-100 SQUARE, stretched with `preserveAspectRatio="none"`, so one generator serves a
   26px compact chip and a 34px full one and anything a future surface asks for. A raster crack would need
   two assets today and a third the next time a chip changes size.

   DETERMINISTIC FROM A SEED, which matters more than it looks. The chip re-renders several times during
   the sequence (once per stage, once per application), and a crack regenerated from `Math.random` on each
   render would REDRAW ITSELF mid-fracture -- a visibly different crack every frame, which is not a crack.
   Seeded from the chip's own position, so the same chip always fractures the same way and two chips in a
   row never fracture identically.

   A HAND-ROLLED LCG rather than anything imported: eight lines, no dependency, and reproducible in a test
   without stubbing a global. The constants are Numerical Recipes' -- an arbitrary well-behaved choice, and
   nothing here depends on their statistical quality, only on their repeatability.

   ONE MAIN FRACTURE AND ONE BRANCH. A crack with three branches at 24px is a smudge; one diagonal that
   changes direction twice, plus one short limb leaving it, is the least that reads as "structural failure"
   rather than "a line". */

function seededRandom(seed: number): () => number {
  let state = (Math.abs(Math.floor(seed)) % 2147483647) + 1;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** A jagged, branching fracture across a 0-100 box, as an SVG path. Same seed, same crack, always.
 *
 *  ==================================================================
 *   DESIGN NOTE (WARNING-MARK PASS): `steps` EXISTS SO THE STATIC BADGE IS THE SAME CRACK, NOT A SECOND ONE
 *  ==================================================================
 *  VF-7's I-10 predicted this reuse: "`crackPath` is the piece that pass would reuse -- it produces a
 *  resolution-free fracture from a seed, so a badge icon can be the same mark at a fixed seed." It is, with
 *  one correction that only appeared on rendering it: four steps across a 34x24 chip is a 4-vertex fracture
 *  with segments around 8px, and the same path inside a ~13px badge glyph has segments around 3px, which is
 *  the "mud at micro scale" the brief rules out and is I-6's own risk one size further down.
 *  SO THE DETAIL IS A PARAMETER RATHER THAN THE BADGE GETTING ITS OWN GENERATOR. One vocabulary, one set of
 *  rules about what a fracture looks like here (corner to corner, alternating jitter, one branch off an
 *  interior vertex), and the badge asks for less of it. A separate `badgeCrackPath` would have been a second
 *  definition of "what a crack is" in the file whose whole subject is that question.
 *  AND THE FLOOR IS THREE, WHICH WAS FOUND BY LOOKING. Two steps leaves exactly ONE interior vertex, and the
 *  branch is specified to leave from an interior vertex -- so at `steps: 2` this generator can only ever
 *  draw three limbs meeting at one point, which rendered at 120px is unmistakably a clock face. A clock in a
 *  countdown badge is not a near miss; it is a wrong meaning that happens to be plausible. Three steps gives
 *  the branch somewhere to leave from that is not also the fracture's only corner.
 *  DEFAULTS TO 4, so every VF-7 call site is untouched and unchanged. */
export function crackPath(seed: number, steps = 4): string {
  const next = seededRandom(seed);
  /* The main fracture runs corner to corner rather than edge to edge: a crack that starts and ends on the
     same pair of opposite edges reads as a cut, and a chip that has been CUT has been dealt with tidily,
     which is the vocabulary this batch exists to avoid. */
  const startY = 6 + next() * 22;
  const endY = 72 + next() * 22;
  const points: Array<[number, number]> = [[0, startY]];
  for (let step = 1; step < steps; step += 1) {
    const x = (100 / steps) * step;
    const along = startY + ((endY - startY) * step) / steps;
    // The zig: each vertex leaves the straight run by up to a fifth of the box, alternating sides.
    const jitter = (next() - 0.5) * 42;
    points.push([x, Math.max(4, Math.min(96, along + jitter))]);
  }
  points.push([100, endY]);
  const main = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${round(x)} ${round(y)}`).join(" ");

  /* THE BRANCH leaves the main fracture at one of its interior vertices and runs a short way off it,
     which is what a real fracture does at a flaw and what distinguishes this from a polyline. */
  const from = points[1 + Math.floor(next() * (points.length - 2))];
  const branchX = from[0] + (next() - 0.5) * 30;
  const branchY = from[1] + (next() < 0.5 ? -1 : 1) * (18 + next() * 20);
  const branch = `M${round(from[0])} ${round(from[1])} L${round(clamp(branchX))} ${round(clamp(branchY))}`;

  return `${main} ${branch}`;
}

const clamp = (value: number) => Math.max(2, Math.min(98, value));
const round = (value: number) => Math.round(value * 10) / 10;

/* ==================================================================
    DESIGN NOTE (AUDIO WIRING PASS): THE CHIP HAD TO ACTUALLY COME APART
   ==================================================================
   THE AUDIT THE AUDIO ASKED FOR. `rust.mp3` is a brittle break followed by a clatter of secondary
   fragments, and the question the brief put was whether VF-7's failure phase justifies it. It did not,
   and by more than the brief allowed for: the brief's worst case was "two broad pieces that gently fade",
   and what VF-7 actually shipped is ONE piece. `app-train-rust-fail` translates and rotates the whole chip
   as a single object and fades it out; the fracture is DRAWN ACROSS an intact chip that never divides. So
   the clip's first crack lands on a crack being drawn -- which is right -- and its clatter falls over a
   failure phase where nothing breaks apart at all.

   SO THE CHIP NOW GIVES WAY ALONG THE CRACK IT WAS JUST DRAWN. Smallest change that makes the claim true:
   the same fracture geometry, used a second time as a partition. No particles, no shards beyond three, no
   new beats, no change to `RUST_FAIL_AT_MS` or any other milestone, and nothing at all under reduced
   motion (where the chip still leaves by opacity alone).

   WHY THE BRANCH IS EXTENDED. `crackPath` draws a main run edge to edge plus one branch that stops in the
   interior, which divides the chip into exactly TWO regions -- a branch that stops short is a flaw, not a
   seam. Run that branch on to the boundary it was heading for and the same crack makes three. That is also
   what a cracked thing does when it finally gives: the flaw runs out. The DRAWN crack is unchanged, so the
   third seam appears as the gap that opens rather than as a line that was there all along, which is the
   order those two things happen in.

   AND A SPLINTER IS NOT A FRAGMENT. Measured over 572 seeds, the three-way split tiles the chip exactly
   every time -- but 30% of seeds put one piece under 8% of the area, and at 34x24 that is a hairline that
   reads as a rendering fault rather than as a piece of chip. Those fall back to the two-piece split on the
   main run alone, which is still a chip coming apart and is never a splinter. "A few chunky fragments",
   taken literally in both directions. */

/** A piece of a chip that has given way: where to clip it, and which way it goes. */
export interface RustFragment {
  /** A `clip-path: polygon(...)` over the chip's own box. */
  clipPath: string;
  /** Drift, in px. Small -- see `RUST_FRAGMENT_DRIFT_PX`. */
  dx: number;
  dy: number;
  /** A degree or two of tumble, signed by the drift so a piece turns the way it is going. */
  rotateDeg: number;
}

/** Below this share of the chip a piece is a splinter, and the chip breaks in two instead. */
export const RUST_FRAGMENT_MIN_AREA_PERCENT = 8;
/** How far a piece travels. `app-train-rust-fail`'s own 3px, because this REPLACES that movement rather
 *  than adding to it: the chip is a 24px pill in a row of them and anything larger overlaps a neighbour. */
export const RUST_FRAGMENT_DRIFT_PX = 3;
export const RUST_FRAGMENT_TUMBLE_DEG = 2;

type Point = readonly [number, number];

/** The generator's own main run and branch, as points rather than as a path string. One parse of the rules
 *  about what a fracture looks like, read twice -- `crackPath` draws it, this partitions on it. */
function crackGeometry(seed: number): { main: Point[]; vertex: number; branchEnd: Point } {
  const next = seededRandom(seed);
  const startY = 6 + next() * 22;
  const endY = 72 + next() * 22;
  const points: Array<[number, number]> = [[0, startY]];
  const steps = 4;
  for (let step = 1; step < steps; step += 1) {
    const x = (100 / steps) * step;
    const along = startY + ((endY - startY) * step) / steps;
    const jitter = (next() - 0.5) * 42;
    points.push([x, Math.max(4, Math.min(96, along + jitter))]);
  }
  points.push([100, endY]);
  const rounded: Point[] = points.map(([x, y]) => [round(x), round(y)] as Point);
  const vertex = 1 + Math.floor(next() * (points.length - 2));
  const from = points[vertex];
  const branchX = from[0] + (next() - 0.5) * 30;
  const branchY = from[1] + (next() < 0.5 ? -1 : 1) * (18 + next() * 20);
  return { main: rounded, vertex, branchEnd: [clamp(branchX), clamp(branchY)] as Point };
}

/** The branch's direction, run on to the edge of the chip. */
function runToEdge(from: Point, toward: Point): Point {
  const dx = toward[0] - from[0];
  const dy = toward[1] - from[1];
  const hits: number[] = [];
  const consider = (numerator: number, denominator: number) => {
    if (Math.abs(denominator) < 1e-9) return;
    const t = numerator / denominator;
    if (t > 1e-6) hits.push(t);
  };
  consider(0 - from[0], dx);
  consider(100 - from[0], dx);
  consider(0 - from[1], dy);
  consider(100 - from[1], dy);
  const t = hits.length > 0 ? Math.min(...hits) : 1;
  return [round(from[0] + dx * t), round(from[1] + dy * t)] as Point;
}

const polygonArea = (ring: readonly Point[]): number => {
  let twice = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
};

const asClipPath = (ring: readonly Point[]): string =>
  `polygon(${ring.map(([x, y]) => `${x}% ${y}%`).join(", ")})`;

const withDrift = (ring: readonly Point[]): RustFragment => {
  /* AWAY FROM THE MIDDLE, which is the only direction a piece of a broken thing can sensibly go and is
     also what keeps the three of them from drifting on top of one another. Derived from the piece's own
     centroid, so it is as deterministic as the crack that made it. */
  let cx = 0;
  let cy = 0;
  for (const [x, y] of ring) {
    cx += x;
    cy += y;
  }
  cx = cx / ring.length - 50;
  cy = cy / ring.length - 50;
  const length = Math.hypot(cx, cy);
  /* A piece centred on the chip's own centre has no direction to take; down is the one that never looks
     like a mistake. Unreachable for a three-way split and reachable for a two-way one. */
  const ux = length < 1e-6 ? 0 : cx / length;
  const uy = length < 1e-6 ? 1 : cy / length;
  return {
    clipPath: asClipPath(ring),
    dx: round(ux * RUST_FRAGMENT_DRIFT_PX),
    dy: round(uy * RUST_FRAGMENT_DRIFT_PX),
    rotateDeg: round((ux >= 0 ? 1 : -1) * RUST_FRAGMENT_TUMBLE_DEG),
  };
};

/** The pieces one chip breaks into: three where the crack makes three chunky ones, two otherwise.
 *
 *  SAME SEED, SAME PIECES, EVERY RENDER -- `crackSeedFor`'s requirement, for its reason: the chip
 *  re-renders on every stage boundary and pieces that re-cut themselves mid-failure would be two
 *  failures. */
export function crackFragments(seed: number): readonly RustFragment[] {
  const { main, vertex, branchEnd } = crackGeometry(seed);
  const top: Point[] = [...main, [100, 0], [0, 0]];
  const bottom: Point[] = [...main, [100, 100], [0, 100]];
  const twoWay = [withDrift(top), withDrift(bottom)];

  const V = main[vertex];
  const E = runToEdge(V, branchEnd);
  const B = main[main.length - 1];
  const splitsTop = E[1] < V[1];
  const ring: Point[] = splitsTop ? [...top] : [...bottom];
  const other: Point[] = splitsTop ? bottom : top;
  /* WHERE `E` SITS ON THE RING. The ring runs along the fracture from the left edge to the right edge and
     then back around the boundary, so the boundary run is (right edge) -> (far corner) -> (near corner) ->
     (left edge) and `E` is on exactly one of those three legs. */
  const onRightEdge = Math.abs(E[0] - 100) < 1e-6 && (splitsTop ? E[1] < B[1] : E[1] > B[1]);
  const onFarEdge = Math.abs(E[1] - (splitsTop ? 0 : 100)) < 1e-6;
  const at = onRightEdge ? main.length : onFarEdge ? main.length + 1 : main.length + 2;
  ring.splice(at, 0, E);

  const iv = ring.findIndex((point) => point === V);
  const ie = ring.indexOf(E);
  if (iv < 0 || ie < 0) return twoWay;
  const lo = Math.min(iv, ie);
  const hi = Math.max(iv, ie);
  const first = ring.slice(lo, hi + 1);
  const second = [...ring.slice(hi), ...ring.slice(0, lo + 1)];
  if (first.length < 3 || second.length < 3) return twoWay;
  const pieces = [other, first, second];
  const smallest = Math.min(...pieces.map(polygonArea));
  if (smallest < RUST_FRAGMENT_MIN_AREA_PERCENT * 100) return twoWay;
  return pieces.map(withDrift);
}

/** The seed a chip uses: its corporation and its position, so one chip's crack is stable across every
 *  render of one sequence and two chips in a row are never identical. */
export function crackSeedFor(companyId: number, index: number): number {
  return companyId * 977 + index * 31 + 7;
}

/* ==================================================================
    THE CHIP'S OWN STYLESHEET
   ==================================================================
   #46/#18's escape hatch, on VF-1/VF-3/VF-4/VF-6's rule: keyframes, a dash-offset draw and a mix-blend
   overlay are what an inline style cannot express. Durations are written inline by `TrainBadges.tsx` from
   the constants above -- one set of numbers, not two.

   THE OXIDE PALETTE IS BURNT IRON, NOT FIRE. The brief rules out bright orange cartoon rust, glow and
   sparks by name, and the surface agrees: these chips sit on corporation cards painted the company's own
   livery (#702's whole report), where a saturated orange collides with NNH and a glow bleeds over the
   chips either side. `#6b3f2a` and `#8a4a2f` are dull oxides that darken every livery they land on rather
   than competing with it.

   NOTE FOR EDITORS: everything from here to the closing backtick is inside a TEMPLATE LITERAL, so no
   backticks -- #755, #1004 and VF-6 each record terminating this kind of string early by quoting an
   identifier. */
export const TRAIN_RUST_CSS = `
@keyframes app-train-rust-oxidise {
  from { background-color: rgba(107, 63, 42, 0); border-color: inherit; }
  to   { background-color: rgba(107, 63, 42, 0.85); border-color: #8a4a2f; }
}
.app-train-rusting {
  position: relative;
  animation-name: app-train-rust-oxidise;
  animation-timing-function: ease-in;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
/* The crack overlay. Stretched to the chip with preserveAspectRatio none, so one 0-100 path fits any
   chip size -- and drawn ON TOP of the text, because a fracture runs across whatever is printed on the
   thing that fractured. */
.app-train-rust-crack {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}
.app-train-rust-crack path {
  fill: none;
  stroke: #1a0c06;
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
/* The propagation: the fracture is drawn rather than revealed, so it travels the way a crack does. 200 is
   comfortably longer than the longest path this generator can produce in a 0-100 box, so the dash always
   covers it; a measured length would need a layout read per chip for no visible gain. */
@keyframes app-train-rust-propagate {
  from { stroke-dashoffset: 200; }
  to   { stroke-dashoffset: 0; }
}
.app-train-rust-crack-drawing path {
  stroke-dasharray: 200;
  animation-name: app-train-rust-propagate;
  animation-timing-function: cubic-bezier(0.15, 0.8, 0.4, 1);
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
/* Failure: one shudder of a pixel or two, a few pixels of separation, and out. The translate never exceeds
   3px in any direction -- the brief's "pieces separate only a few pixels", taken literally, because this
   is a 24px chip in a row of them and anything larger overlaps its neighbour. */
@keyframes app-train-rust-fail {
  0%   { transform: translate(0, 0) rotate(0deg); opacity: 1; }
  18%  { transform: translate(-1px, 1px) rotate(-0.8deg); opacity: 1; }
  36%  { transform: translate(1px, -1px) rotate(0.8deg); opacity: 0.95; }
  60%  { transform: translate(-2px, 2px) rotate(-1.4deg); opacity: 0.6; }
  100% { transform: translate(-3px, 3px) rotate(-2deg); opacity: 0; }
}
.app-train-rust-failing {
  animation-name: app-train-rust-fail;
  animation-timing-function: ease-in;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
/* ==================================================================
    THE PIECES, AND WHY THEY REPLACE THE FAILURE RATHER THAN JOIN IT
   ==================================================================
   NOTE FOR EDITORS, again: no backticks anywhere below -- this is still inside the template literal, and
   quoting an identifier here is how #755, #1004, VF-6 and VF-7 each terminated this string early. Written
   out in full the first time, and this block was the fifth time it happened.
   A shard carries app-train-rust-failing like any failing chip, so every reader that asks "is this chip
   failing" still gets a yes -- and then overrides its animation, because the whole chip's shudder and a
   piece's own drift are the SAME movement seen at two granularities, and running both would be the chip
   moving twice. The two-class selector is VF-8's idiom (app-train-cut-left + app-train-discard-parting),
   which is how this stylesheet says "this element, in this role" without an important flag.
   THE DIRECTION IS THE ELEMENT'S OWN, through custom properties set inline by TrainBadges.tsx from
   crackFragments. Keyframes resolve var() against the animating element, so one keyframe serves every
   piece of every chip rather than three hand-written variants that could disagree with the geometry. */
@keyframes app-train-rust-shard {
  0%   { transform: translate(0, 0) rotate(0deg); opacity: 1; }
  35%  { transform: translate(calc(var(--shard-dx) * 0.4), calc(var(--shard-dy) * 0.4)) rotate(calc(var(--shard-rot) * 0.4)); opacity: 1; }
  100% { transform: translate(var(--shard-dx), var(--shard-dy)) rotate(var(--shard-rot)); opacity: 0; }
}
.app-train-rust-failing.app-train-rust-shard {
  animation-name: app-train-rust-shard;
  animation-timing-function: ease-in;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
/* The chip's place in the row while it is in pieces. The first piece is in normal flow and therefore keeps
   the slot the chip's own size; the rest are laid over it. VF-8's app-train-cut-slot, one event over --
   and the same reason it has to exist at all: a clip-path clips its descendants, so a chip clipped to
   one piece of itself cannot contain the other two. */
.app-train-rust-shatter {
  position: relative;
  display: inline-flex;
}
.app-train-rust-shard-over {
  position: absolute;
  inset: 0;
}
/* Gone, but still holding its slot: the row does not close up until the staged roster is dropped. */
.app-train-rust-spent {
  opacity: 0;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  /* Belt and braces, as STOCK_TRANSFER_CSS puts it: TrainBadges.tsx reads the preference itself and never
     attaches the failing class or the drawing class under it. This exists so a class left on by a stale
     render cannot move or redraw anything. THE OXIDE AND THE CRACK BOTH STAY -- a cue that disappears
     under reduced motion is an information problem (#26) -- and the chip leaves by opacity alone. */
  .app-train-rust-failing {
    animation: none !important;
    transform: none !important;
    opacity: 0 !important;
    transition: opacity 110ms linear;
  }
  /* Belt and braces again: TrainBadges.tsx never breaks a chip into pieces under reduced motion, so this
     exists only so a class left on by a stale render cannot start one drifting. */
  .app-train-rust-failing.app-train-rust-shard {
    animation: none !important;
    transform: none !important;
  }
  .app-train-rust-crack-drawing path {
    animation: none !important;
    stroke-dasharray: none !important;
    stroke-dashoffset: 0 !important;
  }
}
`;

/** The class carrying this stage, or `undefined` for a chip at rest. `vacate` is deliberately `undefined`:
 *  by then the staged roster has been dropped and this chip does not exist.
 *
 *  THE SAME CLASSES UNDER BOTH TIMELINES, and the media query above is what makes that safe: the oxide is
 *  information and stays, while `app-train-rust-failing` is neutralised to a plain opacity transition with
 *  `animation: none !important; transform: none !important`. Branching here as well would be two places
 *  deciding one accommodation, and the stylesheet is the one that cannot be bypassed by a stale render. */
export function rustChipStageClass(stage: RustStageKind | null): string | undefined {
  if (stage === "oxidise" || stage === "fracture") return "app-train-rusting";
  if (stage === "fail") return "app-train-rusting app-train-rust-failing";
  return undefined;
}

/** Whether the crack is drawn at all, and whether it PROPAGATES.
 *
 *  Brief: under reduced motion "if a static crack appears briefly, that is acceptable, but do not animate
 *  its propagation". So the mark is rendered from the fracture beat onwards either way, and only the
 *  dash-offset draw is withheld -- the difference between a crack that arrives and a crack that travels. */
export function rustCrackClass(
  stage: RustStageKind | null,
  reducedMotion: boolean,
): string | null {
  if (stage !== "fracture" && stage !== "fail") return null;
  return reducedMotion
    ? "app-train-rust-crack"
    : "app-train-rust-crack app-train-rust-crack-drawing";
}
