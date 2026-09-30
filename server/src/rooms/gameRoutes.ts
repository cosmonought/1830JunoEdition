// server/src/rooms/gameRoutes.ts
//
// ==================================================================
//  LIVE-6 L6-1: WHERE A GAME THIS TASK DOES NOT SERVE IS SERVED -- AUTHORITATIVE OWNER, TRUSTED PATH, THE FROZEN FRAME
// ==================================================================
//
// A route answer has two halves, and each comes from exactly one place:
//
//   WHICH POOL   only from AUTHORITATIVE ownership / routing, read at the moment of the question -- never from a
//                discovery snapshot, an index, a cache or anything a client sent:
//                  - on a task whose load CLAIMED the game (POOL ownership), the claim's own refusal: `GameRoutedError`
//                    names the HEAD's owner as the table evaluated it (L5-3);
//                  - on a task that claims nothing (a non-primary pool's router, `routerServer.ts`), a strongly
//                    consistent read of the game's HEAD; a game its pool RELEASED is the primary's, from a strongly
//                    consistent read of `SYSTEM/ROUTING` (`routeOfGame`).
//                An operator run (`op:`), this task's own pool, a HEAD or a routing item this build cannot read, and no
//                routing at all, have NO destination: nothing is guessed.
//   WHICH PATH   only from TRUSTED DEPLOYMENT CONFIGURATION: the runtime document's `routes` (`poolRoutes`), one entry per
//                pool the deployment exposes, each checked at startup to be a path the client would follow
//                (`safeRoutePath`: absolute, plain segments, no host, no scheme, no escape) -- a socket path under `/gs/`
//                on the game server's origin, and optionally a bundle path on the page's. Never a host: the answer names
//                no topology and cannot send a browser off-site (no open redirect). A pool with no entry has no
//                destination.
//
// THE FRAME IS LIVE-4's, UNCHANGED (`frontend/src/utils/clientAnswers.ts`): `routeFrameFor` -- the one builder, which
// refuses a destination no client would follow -- then close 4426. Client protocol 1 has exactly ONE route frame (code
// `client-rules`, the protocol's only route code) and its client follows any route frame by its checked destination
// alone, so an ownership route reuses that frame byte for byte rather than inventing a code: no wire, protocol or
// compatibility identity moves. It is sent only to a protocol-1 socket whose FROZEN connection verdict is `ok` -- a
// legacy socket (no announcement) never sees one and keeps exactly its pre-LIVE-6 answer, and a socket told `reload`
// or `legacy-refused` never gets this far.
//
// A ROUTE IS NOT AN AUTHORITY. It is sent only after the socket authenticated (the upgrade) and the game's record
// authorized the principal to read it (an outsider of a private game is told what no game at all answers); the pool it
// names authenticates the socket again at its own upgrade, authorizes every frame from its own records and judges the
// tab against the game with its own client verdict. A route bypasses nothing.

import type { RouteDestination, RouteFrame } from "../../../frontend/src/utils/clientAnswers";
import { routeFrameFor, safeRoutePath } from "../../../frontend/src/utils/clientAnswers";

/** One pool's entry of the trusted configuration. */
export interface PoolRouteEntry {
  /** The socket path (on the game server's origin) where this pool is reached, e.g. `/gs/p/p2`. */
  readonly wsPath: string;
  /** A bundle path (on the page's origin) whose bundle plays this pool's games, when it is another release's. */
  readonly bundlePath?: string;
}

/** The deployment's route table as this task uses it. */
export interface PoolRoutes {
  /** This task's own pool (never a destination: a task never routes a client to itself). */
  readonly self: string;
  /** The destination of a pool, or `null`: this pool, an operator run, a pool the configuration does not expose. */
  destinationOf(pool: string): RouteDestination | null;
  /** The socket paths this task answers besides `/gs`: its own pool's configured path (empty when it has none). */
  readonly ownWsPaths: readonly string[];
}

/** Why a route table entry cannot be used (`null`: it can). Checked at startup (the runtime document refuses it). */
export function routeEntryProblem(entry: PoolRouteEntry): string | null {
  if (safeRoutePath(entry.wsPath) !== entry.wsPath) return "ws_path is not a plain absolute path a client would follow";
  if (!entry.wsPath.startsWith("/gs/")) return "ws_path must be under /gs/ (the edge forwards only /gs* to the game servers)";
  if (entry.bundlePath !== undefined) {
    if (safeRoutePath(entry.bundlePath) !== entry.bundlePath) return "bundle_path is not a plain absolute path a client would follow";
    if (entry.bundlePath === "/gs" || entry.bundlePath.startsWith("/gs/")) return "bundle_path must be a page path, not under /gs";
  }
  return null;
}

/** The route table from the trusted configuration. Throws for an entry that cannot be used (the caller refuses the
 *  start). */
export function poolRoutes(self: string, table: Readonly<Record<string, PoolRouteEntry>>): PoolRoutes {
  const entries = new Map<string, RouteDestination>();
  const seenPaths = new Set<string>();
  for (const [pool, entry] of Object.entries(table)) {
    const problem = routeEntryProblem(entry);
    if (problem !== null) throw new Error(`routes.${pool}: ${problem}`);
    if (seenPaths.has(entry.wsPath)) throw new Error(`routes.${pool}: ws_path ${entry.wsPath} is another pool's too`);
    seenPaths.add(entry.wsPath);
    entries.set(pool, Object.freeze({ wsPath: entry.wsPath, ...(entry.bundlePath !== undefined ? { bundlePath: entry.bundlePath } : {}) }));
  }
  const own = entries.get(self);
  return Object.freeze({
    self,
    destinationOf(pool: string): RouteDestination | null {
      if (pool === self || pool.startsWith("op:")) return null;
      return entries.get(pool) ?? null;
    },
    ownWsPaths: Object.freeze(own?.wsPath !== undefined ? [own.wsPath] : []),
  });
}

/** No route table (PROCESS mode, and an AWS runtime document of format v1): no destination for any pool. */
export const NO_ROUTES: PoolRoutes = Object.freeze({ self: "", destinationOf: () => null, ownWsPaths: Object.freeze([]) as readonly string[] });

/** The frozen verdict an ownership route is framed with: client protocol 1's one route (see the header). */
const OWNERSHIP_ROUTE = Object.freeze({ kind: "route" as const, code: "client-rules" as const, detail: "the game is served by another pool" });

/** The route frame for `gameId` to `destination` -- LIVE-4's builder, unchanged. `null` when the destination is not one a
 *  client would follow (never sent; the caller answers as it would without a destination). */
export function ownershipRouteFrame(gameId: string, destination: RouteDestination): RouteFrame | null {
  try {
    return routeFrameFor(OWNERSHIP_ROUTE, destination, { gameId });
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
    A task that claims nothing: the owner from a strong read of the HEAD (and of the routing for a released game)
   --------------------------------------------------------------------------- */

/** What the ownership store says of a game's HEAD, read strongly NOW (the AWS side normalises its items to this). */
export type GameOwnerRead =
  | { readonly kind: "owned"; readonly pool: string }
  /** Its pool released it (no owner): the primary claims it at its next load. */
  | { readonly kind: "released" }
  /** No HEAD: no such game in the ownership store. */
  | { readonly kind: "absent" };

export interface GameDirectory {
  /** The HEAD's owner, strongly consistent. Throws when it cannot be read or is not well-formed (damage). */
  ownerOf(gameId: string): Promise<GameOwnerRead>;
  /** The primary pool (`SYSTEM/ROUTING`), strongly consistent; `null`: no routing. Throws when it cannot be read. */
  primaryPool(): Promise<string | null>;
}

export type RouteLookup =
  | { readonly kind: "route"; readonly pool: string; readonly destination: RouteDestination }
  | { readonly kind: "none"; readonly why: "absent" | "operator" | "self" | "no-destination" | "no-primary" | "unreadable" };

/** Where a game this task does not serve is served, from the authoritative reads and the trusted table (see the
 *  header). Never throws: anything that cannot be established is `none`. */
export async function routeOfGame(gameId: string, directory: GameDirectory, routes: PoolRoutes): Promise<RouteLookup> {
  let owner: GameOwnerRead;
  try {
    owner = await directory.ownerOf(gameId);
  } catch {
    return { kind: "none", why: "unreadable" };
  }
  if (owner.kind === "absent") return { kind: "none", why: "absent" };
  let pool: string;
  if (owner.kind === "owned") {
    pool = owner.pool;
  } else {
    let primary: string | null;
    try {
      primary = await directory.primaryPool();
    } catch {
      return { kind: "none", why: "unreadable" };
    }
    if (primary === null) return { kind: "none", why: "no-primary" };
    pool = primary;
  }
  if (pool.startsWith("op:")) return { kind: "none", why: "operator" };
  if (pool === routes.self) return { kind: "none", why: "self" };
  const destination = routes.destinationOf(pool);
  return destination === null ? { kind: "none", why: "no-destination" } : { kind: "route", pool, destination };
}
