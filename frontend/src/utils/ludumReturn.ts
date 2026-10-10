// frontend/src/utils/ludumReturn.ts
//
// ==================================================================
//  LUDUM (Lane A): `?ludum=signin&return=<path>` -- SIGN IN ON PLAY, THEN GO BACK TO LUDUM
// ==================================================================
//
// docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §2.1. Sign-in happens on Play; the Ludum site links here. This opens the
// existing account dialog (`accountPrompt.ts` `requireAccount`) and, on a successful sign-in -- or at once when this
// browser is already signed in -- sends the browser to `LUDUM_ORIGIN + path`.
//
// NOT AN OPEN REDIRECT: the host is this build constant, never read from the URL; the path must match
// `^/[a-z0-9/_-]{0,128}$` (no `.`, no `:`, no `?`, no `#`, no `%`, no `\`); `ludum` and `return` must each appear exactly
// once; and the final URL's origin is checked to be `LUDUM_ORIGIN`. Anything else: nothing happens, the visitor stays on
// Play. Closing the dialog drops the return (the visitor chose not to sign in).
//
// LUDUM v1.1: `?ludum=confirm&return=<path>` -- "Confirm it's you" on Play (a conduct reviewer's decision on Ludum needs
// the session's live sensitive grant; the password is only ever typed on Play). Signed in: Play's own `ConfirmItsYou`
// (`LudumConfirmHost`), then back. Signed out: the sign-in dialog -- a fresh sign-in IS the grant for its first five
// minutes -- then back. The same path rule; cancelling stays on Play.

import { isSignedIn, requireAccount as defaultRequireAccount } from "./accountPrompt";
import { sessionPort, type SessionPort } from "./sessionBootstrap";

/** The Ludum site's origin (a build constant: the only place Play ever sends a browser back to). */
export const LUDUM_ORIGIN = "https://ludum.netadao.org";

/** §2.1: the only paths Play returns to. */
export const LUDUM_RETURN_PATH = /^\/[a-z0-9/_-]{0,128}$/;

/** What Play does before returning: sign in, or confirm it's you (v1.1). */
export type LudumReturnMode = "signin" | "confirm";

/** The Ludum URL a page's query asks to return to after sign-in (or, `mode` "confirm", after "Confirm it's you"), or
 *  null (not that request, or not a safe one). */
export function ludumReturnTarget(search: string, mode: LudumReturnMode = "signin"): string | null {
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    return null;
  }
  const paths = query.getAll("return");
  const modes = query.getAll("ludum");
  if (modes.length !== 1 || modes[0] !== mode) return null;
  if (paths.length !== 1 || !LUDUM_RETURN_PATH.test(paths[0])) return null;
  let target: URL;
  try {
    target = new URL(paths[0], LUDUM_ORIGIN);
  } catch {
    return null;
  }
  if (target.origin !== LUDUM_ORIGIN || target.pathname !== paths[0]) return null;
  return `${LUDUM_ORIGIN}${paths[0]}`;
}

export interface LudumSignInDeps {
  readonly search: string;
  /** Leaves Play for `url` (the browser's `location.assign`). */
  readonly navigate: (url: string) => void;
  readonly requireAccount?: (run: () => void, reason: string) => boolean;
}

/** Handle a Ludum sign-in request on page load. True when the query was one (and the sign-in was asked for or done). */
export function handleLudumSignIn(deps: LudumSignInDeps): boolean {
  const target = ludumReturnTarget(deps.search);
  if (target === null) return false;
  const ask = deps.requireAccount ?? ((run: () => void, reason: string) => defaultRequireAccount(run, reason));
  ask(() => deps.navigate(target), "Log in to continue to Ludum.");
  return true;
}

/* ------------------------------------------------------------------ */
/* v1.1: "Confirm it's you", then back to Ludum                         */
/* ------------------------------------------------------------------ */

let confirmTarget: string | null = null;
const confirmListeners = new Set<() => void>();
const setConfirmTarget = (target: string | null) => {
  confirmTarget = target;
  confirmListeners.forEach((listener) => listener());
};

/** The Ludum URL the open confirmation returns to, or null (no confirmation is open). */
export const ludumConfirmTarget = (): string | null => confirmTarget;
export function subscribeLudumConfirm(listener: () => void): () => void {
  confirmListeners.add(listener);
  return () => confirmListeners.delete(listener);
}
/** Cancel: the visitor stays on Play. */
export const closeLudumConfirm = (): void => setConfirmTarget(null);

export interface LudumConfirmDeps {
  readonly search: string;
  readonly navigate: (url: string) => void;
  readonly port?: SessionPort;
  readonly requireAccount?: (run: () => void, reason: string) => boolean;
  /** Show Play's "Confirm it's you" for `target` (default: `LudumConfirmHost`). */
  readonly openConfirm?: (target: string) => void;
}

/** Handle a Ludum "Confirm it's you" request on page load. True when the query was one. */
export function handleLudumConfirm(deps: LudumConfirmDeps): boolean {
  const target = ludumReturnTarget(deps.search, "confirm");
  if (target === null) return false;
  const port = deps.port ?? sessionPort();
  const open = deps.openConfirm ?? setConfirmTarget;
  const ask = deps.requireAccount ?? ((run: () => void, reason: string) => defaultRequireAccount(run, reason));
  const decide = () => {
    /* Signed in: confirm with the password. Signed out: the sign-in is the confirmation (its own five-minute grant). */
    if (isSignedIn(port)) open(target);
    else ask(() => deps.navigate(target), "Log in to continue to Ludum.");
  };
  if (port.state === "unknown") void port.ensure().then(decide, decide);
  else decide();
  return true;
}
