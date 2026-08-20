// Design note #640: which build is the browser actually running.
//
// Three round-trips of one debugging session went to that question, each time
// answered by inferring from incidental evidence -- which works, is slow, and
// only works for whoever remembers what changed when. A reported bug that cannot
// be reproduced has exactly two explanations needing completely different work:
// the code is wrong, or the running bundle predates the fix.
//
// A HAND-BUMPED CONSTANT rather than a git hash (needs build plumbing and
// answers "which commit", not "does this bundle contain the change we just
// discussed") or a timestamp (a stale dev server reports five seconds ago while
// serving a cached chunk). The number is the highest design note in the source,
// so bumping it is the same gesture as documenting the change.
//
// IT WILL GO STALE IF SOMEBODY FORGETS. A build reporting 640 definitely
// contains #640; it might also contain later work by an author who did not bump
// this. It fails in the safe direction -- understating, never overstating.

/** The highest design note present in this source tree. Bump it in the same
 *  edit that adds a note; see the module comment for why it is manual. */
export const UI_BUILD_NOTE = 640;

/** Rendered form: short enough to sit in a corner, specific enough to quote
 *  in a bug report. */
export const UI_BUILD_LABEL = `UI build #${UI_BUILD_NOTE}`;
