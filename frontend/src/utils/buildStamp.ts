// frontend/src/utils/buildStamp.ts
//
// ===================================================================
//  DESIGN NOTE 640: WHICH BUILD IS THE BROWSER ACTUALLY RUNNING
// ===================================================================
//
// Three round-trips of one debugging session went to the question "is the
// build you are looking at current". Each time the answer had to be inferred
// from incidental evidence -- whether the phase badge read "Phase: 3 (Green)"
// or "Phase: Green (3-Train)", whether the depot showed one train or six --
// which works, is slow, and only works for whoever remembers what changed
// when.
//
// A REPORTED BUG THAT CANNOT BE REPRODUCED HAS EXACTLY TWO EXPLANATIONS, and
// they need completely different work: the code is wrong in a way the tests
// miss, or the running bundle predates the fix. Telling them apart first
// costs one number; guessing wrong costs a pass of investigation aimed at
// code that is already correct.
//
// SO IT IS A HAND-BUMPED CONSTANT, deliberately, rather than a git hash or a
// timestamp injected at compile time:
//
//   - A hash needs build plumbing (`REACT_APP_*`, a CI step) and answers
//     "which commit" -- true, and not the question. The question is "does
//     this bundle contain the change we just discussed", and that is a
//     human-scale fact.
//   - A timestamp answers "when was this compiled", which a stale dev server
//     will happily report as five seconds ago while serving a cached chunk.
//
// The number is this codebase's own currency: the highest design note in the
// source. Every substantive change here writes one, so bumping this is the
// same gesture as documenting the change, and a reader comparing "the fix is
// #621" against "your build says 612" needs no other context.
//
// IT WILL GO STALE IF SOMEBODY FORGETS. That is a real weakness and it is
// worth stating plainly rather than pretending the constant is authoritative:
// a build reporting 640 definitely contains #640, but a build reporting 640
// might also contain later work by an author who did not bump it. It fails in
// the safe direction -- understating, never overstating.

/** The highest design note present in this source tree. Bump it in the same
 *  edit that adds a note; see the module comment for why it is manual. */
export const UI_BUILD_NOTE = 640;

/** Rendered form: short enough to sit in a corner, specific enough to quote
 *  in a bug report. */
export const UI_BUILD_LABEL = `UI build #${UI_BUILD_NOTE}`;
