// ==================================================================
//  LUDUM v1 -- THE ROUTE TABLE (docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §3, §5, §9)
// ==================================================================
//  The one place a `/gs/api/ludum/v1/<route>` name maps to its handler and its access rule. Lane A's ingress resolves a
//  path here AFTER its origin / method / content-type / size checks and session resolution; it never routes anywhere
//  else. Owners: `session` (A, wired by the ingress), `games` / `game` (C, ./history), `case` (B2, ./disputes).

import type { LudumHandler } from "./ports";
import { games, game } from "./history";
import { caseRecord } from "./disputes";

export const LUDUM_PREFIX = "/gs/api/ludum/v1/";

export type LudumRouteName = "session" | "games" | "game" | "case";

export interface LudumRoute {
  readonly name: LudumRouteName;
  /** "public": answered for signed-out callers too. "profiled": a signed-out caller gets 401 `signed-out`. */
  readonly access: "public" | "profiled";
  /** null: answered by the ingress itself (`session`, Lane A). */
  readonly handler: LudumHandler | null;
}

export const LUDUM_ROUTES: Readonly<Record<LudumRouteName, LudumRoute>> = Object.freeze({
  session: { name: "session", access: "public", handler: null },
  games: { name: "games", access: "profiled", handler: games },
  game: { name: "game", access: "profiled", handler: game },
  case: { name: "case", access: "public", handler: caseRecord },
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
