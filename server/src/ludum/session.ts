// server/src/ludum/session.ts
//
// ==================================================================
//  LUDUM v1 (Lane A): `POST /gs/api/ludum/v1/session {}` -- WHO IS SIGNED IN, AS §5 `SessionResponse`
// ==================================================================
//
// PUBLIC, 200 either way. The caller is the ingress's (`ludumCallerOf`: a current, activated, profiled, standing session,
// or signed out). Signed in: the SAME data `/gs/api/account/me` answers (`IdentityService.accountDetails`) -- the account's
// display name, username, the month it was made, and its Authorization Wallet -- reshaped to the frozen contract. Never an
// id, never the count of other sessions, nothing else. Signed out: where to sign in (Play), returning to Ludum's home.
//
// Sign-in and account management happen on Play (§2.1); Play has no deep link into its account menu yet, so `manageUrl`
// is Play's home, where the account chip is.

import type { SessionCookieRead } from "../identity/cookies";
import type { IdentityService } from "../identity/sessions";
import type { SessionResponse } from "./contract";
import type { LudumCaller } from "./ports";

/** §2.1: the path Play may send a browser back to on Ludum (Play checks it again: `frontend/src/utils/ludumReturn.ts`). */
export const LUDUM_RETURN_PATH = /^\/[a-z0-9/_-]{0,128}$/;

/** `https://<play>/?ludum=signin&return=<path>`; a path that does not match `LUDUM_RETURN_PATH` returns to `/`. */
export function ludumSignInUrl(playOrigin: string, returnPath = "/"): string {
  const path = LUDUM_RETURN_PATH.test(returnPath) ? returnPath : "/";
  return `${playOrigin}/?ludum=signin&return=${encodeURIComponent(path)}`;
}

/** v1.1: `https://<play>/?ludum=confirm&return=<path>` -- Play's "Confirm it's you" (the password stays on Play), then back.
 *  Play checks the path again (`frontend/src/utils/ludumReturn.ts`). */
export function ludumConfirmUrl(playOrigin: string, returnPath = "/"): string {
  const path = LUDUM_RETURN_PATH.test(returnPath) ? returnPath : "/";
  return `${playOrigin}/?ludum=confirm&return=${encodeURIComponent(path)}`;
}

/** `YYYY-MM` (UTC) of an epoch-ms instant. */
export const yearMonthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

export function sessionAnswer(identity: IdentityService, read: SessionCookieRead, caller: LudumCaller, now: number, playOrigin: string, reviewer = false): SessionResponse {
  const signedOut: SessionResponse = { signedIn: false, signInUrl: ludumSignInUrl(playOrigin) };
  if (caller.principalId === null) return signedOut;
  const details = identity.accountDetails(read, now);
  if (details === null) return signedOut;
  return {
    signedIn: true,
    account: {
      name: details.name,
      username: details.username,
      memberSince: yearMonthOf(details.memberSince),
      authorizationWallet: details.authorizationWallet === null ? null : { address: details.authorizationWallet.address, since: new Date(details.authorizationWallet.since).toISOString() },
    },
    manageUrl: `${playOrigin}/`,
    /* v1.1: whether the account menu draws Moderation (a bound conduct reviewer). Nothing else about the role. */
    roles: { reviewer },
  };
}
