// frontend/src/utils/devIdentity.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §4.8 item 5): THE ONE PLACE THE CLIENT NAMES A DEVELOPMENT CLAIM
// ==================================================================
//
// A development-mode game server knows a local tab by the claim on its socket URL, and nothing else. That claim
// is compiled in ONLY when the bundle is built with `REACT_APP_DEV_IDENTITY=1` -- `npm start` reads it from
// `.env.development`; `npm run build` never does. It is a BUILD-TIME substitution, never runtime configuration:
// in every other build the guard below folds to `if (false)` and the minifier deletes the branch, its string
// included, so a production bundle does not contain the claim parameter at all. `devIdentity.test.ts` pins the
// source shape and `scripts/scanDevIdentity.js` scans a built bundle.
//
// KEEP EVERY MENTION OF THE PARAMETER INSIDE THE GUARDED BRANCH. A mention anywhere else survives the minifier.

/** Whether this bundle was built with development identity (a constant folded at build time). */
export const DEV_IDENTITY_BUILD: boolean = process.env.REACT_APP_DEV_IDENTITY === "1";

/** The socket URL a link opens: with this tab's development claim in a development-identity build, unchanged
 *  in every other build (where the session cookie, bootstrapped first, is the identity). */
export function socketUrlFor(url: string, claim: string): string {
  if (process.env.REACT_APP_DEV_IDENTITY === "1") {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}dev_claim=${encodeURIComponent(claim)}`;
  }
  return url;
}
