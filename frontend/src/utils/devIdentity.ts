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
//
// LIVE-2D: THE CLAIM IS THE TAB'S, NOT A PLAYER ID. It used to be this tab's client-minted `p-…` player id, which
// was also its seat. Seats are the server's now (`RoomView.you.playerId`), so the development claim is only "which
// local principal is this tab": minted once per tab into `sessionStorage` -- two tabs are two principals (the
// two-player local workflow), a reload keeps its principal and therefore its seat, and a duplicated tab copies it
// exactly as a production tab shares its browser's cookie.

/** Whether this bundle was built with development identity (a constant folded at build time). */
export const DEV_IDENTITY_BUILD: boolean = process.env.REACT_APP_DEV_IDENTITY === "1";

/** Where a development tab keeps its local principal's claim. Not a secret and not a seat. */
const TAB_PRINCIPAL_KEY = "juno.devIdentity.tab";

/** This tab's development principal: minted once, `[A-Za-z0-9_-]{1,32}` (the server's claim pattern). */
function tabPrincipal(): string {
  const mint = () => `t-${Array.from({ length: 12 }, () => "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 32)]).join("")}`;
  try {
    const existing = window.sessionStorage.getItem(TAB_PRINCIPAL_KEY);
    if (existing && /^[A-Za-z0-9_-]{1,32}$/.test(existing)) return existing;
    const minted = mint();
    window.sessionStorage.setItem(TAB_PRINCIPAL_KEY, minted);
    return minted;
  } catch {
    return FALLBACK_PRINCIPAL;
  }
}
const FALLBACK_PRINCIPAL = `t-${Math.random().toString(36).slice(2, 14)}`;

/** The socket URL a link opens: with this tab's development claim in a development-identity build, unchanged
 *  in every other build (where the session cookie, bootstrapped first, is the identity). */
export function socketUrlFor(url: string): string {
  if (process.env.REACT_APP_DEV_IDENTITY === "1") {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}dev_claim=${encodeURIComponent(tabPrincipal())}`;
  }
  return url;
}
