// ==================================================================
//  LUDUM v1 -- THE ROUTE TABLE (docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §3, §5, §9)
// ==================================================================
//  The one place a `/gs/api/ludum/v1/<route>` name maps to its handler and its access rule. Lane A's ingress resolves a
//  path here AFTER its origin / method / content-type / size checks and session resolution; it never routes anywhere
//  else. Owners: `session` (A, wired by the ingress), `games` / `game` (C, ./history), `case` (B2, ./disputes).

import type { LudumHandler } from "./ports";
import { games, game } from "./history";
import { caseRecord } from "./disputes";
import { account, displayName } from "./account";
import { moderationCase, moderationDecide, moderationQueue } from "./moderation";

export const LUDUM_PREFIX = "/gs/api/ludum/v1/";

export type LudumRouteName =
  | "session"
  | "games"
  | "game"
  | "case"
  /* v1.1 (additive): the account's own page, and the conduct reviewers' routes. */
  | "account"
  | "display-name"
  | "moderation-queue"
  | "moderation-case"
  | "moderation-decide";

export interface LudumRoute {
  readonly name: LudumRouteName;
  /** "public": answered for signed-out callers too. "profiled": a signed-out caller gets 401 `signed-out`. "reviewer"
   *  (v1.1): anyone but a conduct reviewer -- signed out included -- gets 404 `not-found`, as for a route that does not
   *  exist (the handler checks again). */
  readonly access: "public" | "profiled" | "reviewer";
  /** null: answered by the ingress itself (`session`, Lane A). */
  readonly handler: LudumHandler | null;
}

export const LUDUM_ROUTES: Readonly<Record<LudumRouteName, LudumRoute>> = Object.freeze({
  session: { name: "session", access: "public", handler: null },
  games: { name: "games", access: "profiled", handler: games },
  game: { name: "game", access: "profiled", handler: game },
  case: { name: "case", access: "public", handler: caseRecord },
  account: { name: "account", access: "profiled", handler: account },
  "display-name": { name: "display-name", access: "profiled", handler: displayName },
  "moderation-queue": { name: "moderation-queue", access: "reviewer", handler: moderationQueue },
  "moderation-case": { name: "moderation-case", access: "reviewer", handler: moderationCase },
  "moderation-decide": { name: "moderation-decide", access: "reviewer", handler: moderationDecide },
});

/** The route a request path names, or null (not a Ludum v1 route). Exact match only: no trailing slash, no query
 *  string, no sub-path. */
export function ludumRouteOf(pathname: string): LudumRoute | null {
  if (!pathname.startsWith(LUDUM_PREFIX)) return null;
  const name = pathname.slice(LUDUM_PREFIX.length);
  return Object.prototype.hasOwnProperty.call(LUDUM_ROUTES, name) ? LUDUM_ROUTES[name as LudumRouteName] : null;
}

/** The answer a not-yet-implemented handler gives (step 0 stubs). */
export function unavailable(detail: string): { status: number; json: unknown } {
  return { status: 503, json: { error: "unavailable", detail } };
}
