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

import { requireAccount as defaultRequireAccount } from "./accountPrompt";

/** The Ludum site's origin (a build constant: the only place Play ever sends a browser back to). */
export const LUDUM_ORIGIN = "https://ludum.netadao.org";

/** §2.1: the only paths Play returns to. */
export const LUDUM_RETURN_PATH = /^\/[a-z0-9/_-]{0,128}$/;

/** The Ludum URL a page's query asks to return to after sign-in, or null (not a Ludum sign-in, or not a safe one). */
export function ludumReturnTarget(search: string): string | null {
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    return null;
  }
  const mode = query.getAll("ludum");
  const paths = query.getAll("return");
  if (mode.length !== 1 || mode[0] !== "signin") return null;
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
