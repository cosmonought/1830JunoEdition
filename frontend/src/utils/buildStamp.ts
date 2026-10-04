// Design note #640: which build is the browser actually running.
//
// Three round-trips of one debugging session went to that question, each time
// answered by inferring from incidental evidence -- which works, is slow, and
// only works for whoever remembers what changed when. A reported bug that cannot
// be reproduced has exactly two explanations needing completely different work:
// the code is wrong, or the running bundle predates the fix.
//
// ==================================================================
//  PHASE 3 W1-I (AUD-01.08): THE DEPLOY'S OWN ID, NOT A HAND-BUMPED NUMBER
// ==================================================================
//
// #640 chose a HAND-BUMPED CONSTANT (`UI_BUILD_NOTE`, "the highest design note in
// the source") and said in so many words that it would go stale if somebody
// forgot. It did: the stamp read "UI build #640" for well over a thousand notes.
// Its other objection -- that a git hash "needs build plumbing" -- no longer
// holds: `config.ts` already carries `CLIENT_BUILD_ID` (REACT_APP_BUILD_ID, else
// the Vercel commit SHA, else "dev"), announced to the server as `cb` (#1206,
// LIVE-4). The stamp now reads that one id, so the Rules Reference header and
// the server's diagnostics name the same build, and nothing has to be bumped.
//
// A full 40-hex commit SHA is shortened to 12 for the label; the full id is
// exported for the stamp's tooltip. A local or unset build reads "dev", which is
// the truth about it.

import { CLIENT_BUILD_ID } from "../config";

/** The build id this bundle announces (`CLIENT_BUILD_ID`), in full. */
export const UI_BUILD_ID: string = CLIENT_BUILD_ID;

/** Rendered form: short enough to sit in a corner, specific enough to quote in a bug report. */
export function buildStampLabel(buildId: string): string {
  const shown = /^[0-9a-f]{40}$/i.test(buildId) ? buildId.slice(0, 12) : buildId;
  return `Build ${shown}`;
}

/** The label the Rules Reference header shows. */
export const UI_BUILD_LABEL: string = buildStampLabel(UI_BUILD_ID);
