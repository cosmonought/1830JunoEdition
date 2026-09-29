// frontend/src/utils/clientAnswers.ts
//
// ==================================================================
//  LIVE-4 (L4-3): WHAT A PROTOCOL-1 CLIENT IS TOLD WHEN IT MAY NOT TALK ABOUT A GAME -- `reload`, `route`, CLOSE 4426
// ==================================================================
//
// PURE: the frames, the close code, the player sentences and the route-destination check -- no socket, no storage, no
// window. The server builds these frames from the canonical client verdict (`gameEngine/compat/clientCompatibility.ts`)
// and the client links read them (`serverLink.ts`, `roomLink.ts`); both ends import THIS file, so the two cannot
// drift apart.
//
// THE THREE ANSWERS, AND WHO GETS THEM (client protocol 1, `protocolVersions.ts` row 1):
//
//   reload     THIS release can serve the game, but this browser bundle cannot: its client protocol is not accepted,
//              its announcement is broken, or it lacks the game's rules while this release's bundle carries them.
//              Terminal for the link; the page reloads ONCE (`clientUpdate.ts` keeps it from looping).
//   route      this release's bundle cannot play the game either (its rules are not this release's at all): the game is
//              served by another bundle / pool. The frame carries the destination as PATHS ONLY -- a bundle path on the
//              page's own origin, a socket path on the game server's -- never a host, so it names no deployment
//              topology and cannot send a browser off-site. LIVE-6 supplies the destinations; before LIVE-6 a server
//              has none, and answers exactly what it answers for a game it does not continue (`incompatible`).
//   close 4426 the socket-level form of `reload` (a 4426 close with no frame is read as `reload/client-protocol`).
//
// NEVER TO THE LEGACY WIRE. A socket that announced no protocol (a pre-LIVE-4 bundle) is never sent `reload`, `route`
// or 4426: such a bundle does not know them and would reconnect-loop on the close. What it is told when protocol 0 is
// retired is built from frames it already treats as terminal (the server's `legacyRefusal*` answers).

import type { ClientVerdict, ClientVerdictCode } from "../gameEngine/compat/clientCompatibility";

/** The close code that ends a protocol-1 socket after a `reload` (or `route`) answer: "upgrade required" (HTTP 426).
 *  A protocol-1 client treats it as terminal for that link; a legacy socket is never closed with it. */
export const CLIENT_ANSWER_CLOSE_CODE = 4426;
/** The close reason sent with 4426 (bounded, fixed, carries nothing the client sent). */
export const CLIENT_ANSWER_CLOSE_REASON = "client update needed";

/** THIS release can serve the game (or the table list), but this bundle cannot. */
export interface ReloadFrame {
  kind: "reload";
  code: ClientVerdictCode;
  /** A fixed player-facing sentence (`CLIENT_ANSWER_SENTENCES`). */
  reason: string;
  /** The game this is about: present for `client-rules`, absent for a connection-level answer. */
  gameId?: string;
  /** The client protocols this server accepts (connection-level answers only). */
  accepted?: readonly number[];
  /** The submission this answers, when it answers one. */
  inReplyTo?: string;
}

/** The destination of a route: PATHS, never hosts (see the header). At least one is present in a followable route. */
export interface RouteDestination {
  /** A path on the PAGE's origin where a bundle that can play the game is served (e.g. `/r/11/`). */
  readonly bundlePath?: string;
  /** A path on the GAME SERVER's origin where the pool that continues the game listens (e.g. `/gs/p/dc1-…`). */
  readonly wsPath?: string;
}

/** Another bundle / pool serves this game (the client half ships in LIVE-4; LIVE-6 sends destinations). */
export interface RouteFrame {
  kind: "route";
  code: "client-rules";
  reason: string;
  gameId?: string;
  bundlePath?: string;
  wsPath?: string;
  inReplyTo?: string;
}

export type ClientAnswerFrame = ReloadFrame | RouteFrame;

/** The player's sentences, one per answer. Plain words: no internal code, no version numbers the player cannot act on. */
export const CLIENT_ANSWER_SENTENCES = Object.freeze({
  "client-protocol": "This page and the game server are running different versions of the game. Reload the page to continue.",
  "client-announcement": "This page could not tell the game server which version of the game it is running. Reload the page to continue.",
  "client-rules": "This table plays a version of the rules this page does not have. Reload the page to continue.",
  route: "This table is played on another version of the game server.",
  /** A route this tab could not follow: no destination, an unsafe one, or too many hops (fail closed). */
  "route-unavailable": "This table cannot continue on this server right now. It is kept exactly as it was.",
} as const);

/** The `reload` frame for a reload verdict. `accepted` rides only on a connection-level answer (protocol or
 *  announcement): a `client-rules` answer is about one game. */
export function reloadFrameFor(verdict: Extract<ClientVerdict, { readonly kind: "reload" }>, context: { gameId?: string; inReplyTo?: string } = {}): ReloadFrame {
  return {
    kind: "reload",
    code: verdict.code,
    reason: CLIENT_ANSWER_SENTENCES[verdict.code],
    ...(context.gameId !== undefined ? { gameId: context.gameId } : {}),
    ...(verdict.code !== "client-rules" ? { accepted: [...verdict.accepted] } : {}),
    ...(context.inReplyTo !== undefined ? { inReplyTo: context.inReplyTo } : {}),
  };
}

/** The `route` frame for a route verdict and a destination LIVE-6 supplied. Refuses (throws) a destination that is not
 *  a safe path, so a server can never emit one this module's client would refuse to follow. */
export function routeFrameFor(
  verdict: Extract<ClientVerdict, { readonly kind: "route" }>,
  destination: RouteDestination,
  context: { gameId?: string; inReplyTo?: string } = {},
): RouteFrame {
  const bundlePath = destination.bundlePath === undefined ? undefined : safeRoutePath(destination.bundlePath);
  const wsPath = destination.wsPath === undefined ? undefined : safeRoutePath(destination.wsPath);
  if (bundlePath === null || wsPath === null || (bundlePath === undefined && wsPath === undefined)) {
    throw new TypeError("a route names a safe bundle path or socket path (LIVE-6 supplies them); without one the answer is the game's own");
  }
  return {
    kind: "route",
    code: verdict.code,
    reason: CLIENT_ANSWER_SENTENCES.route,
    ...(context.gameId !== undefined ? { gameId: context.gameId } : {}),
    ...(bundlePath !== undefined ? { bundlePath } : {}),
    ...(wsPath !== undefined ? { wsPath } : {}),
    ...(context.inReplyTo !== undefined ? { inReplyTo: context.inReplyTo } : {}),
  };
}

/* ---------------------------------------------------------------------------
    THE TRANSPORT'S ANSWER TO A CLIENT VERDICT (the one mapping; the server wires it)
   --------------------------------------------------------------------------- */

/** What the transport does with a client verdict. */
export type ClientAnswer =
  /** `ok` / `legacy`: talk normally (the legacy wire keeps its own pre-LIVE-4 path, build compare included). */
  | { readonly kind: "talk" }
  /** Send the frame, then close 4426 (a protocol-1 client ends the link and the page reloads once). */
  | { readonly kind: "reload"; readonly frame: ReloadFrame }
  /** Send the frame, then close 4426 -- only when a destination was supplied (LIVE-6). */
  | { readonly kind: "route"; readonly frame: RouteFrame }
  /** A route with no destination (every route before LIVE-6): answer exactly what a game this pool does not continue
   *  is answered -- "cannot continue here" -- and make nothing up. */
  | { readonly kind: "not-continued-here" }
  /** Protocol 0 retired: answer only with frames a legacy bundle already understands (never reload / route / 4426). */
  | { readonly kind: "legacy-refused" };

/**
 * THE MAPPING, verdict by verdict: `ok` and `legacy` talk; `reload` becomes its frame; `route` becomes its frame only
 * with a destination LIVE-6 supplied, and otherwise the game's own fail-closed answer; `legacy-refused` gets legacy
 * frames only. Pure; the server passes `destination: null` until LIVE-6 has routing to supply.
 */
export function clientAnswerFor(
  verdict: ClientVerdict,
  context: { gameId?: string; inReplyTo?: string; destination?: RouteDestination | null } = {},
): ClientAnswer {
  switch (verdict.kind) {
    case "ok":
    case "legacy":
      return { kind: "talk" };
    case "legacy-refused":
      return { kind: "legacy-refused" };
    case "reload":
      return { kind: "reload", frame: reloadFrameFor(verdict, { gameId: context.gameId, inReplyTo: context.inReplyTo }) };
    case "route": {
      const destination = context.destination ?? null;
      if (destination === null || (destination.bundlePath === undefined && destination.wsPath === undefined)) return { kind: "not-continued-here" };
      try {
        return { kind: "route", frame: routeFrameFor(verdict, destination, { gameId: context.gameId, inReplyTo: context.inReplyTo }) };
      } catch {
        return { kind: "not-continued-here" }; // a destination no client would follow is never sent: fail closed
      }
    }
  }
}

/* ---------------------------------------------------------------------------
    WHERE A ROUTE MAY SEND A TAB: PATHS ON TWO KNOWN ORIGINS, NOTHING ELSE
   --------------------------------------------------------------------------- */

/** The longest route path a client follows. */
export const MAX_ROUTE_PATH_LENGTH = 256;
/** An absolute path of plain segments: no scheme, host, `//`, backslash, percent-escape, query, fragment, space or
 *  control character can appear, so the URL built from it stays on the origin it is resolved against. */
const ROUTE_PATH = /^\/[A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._~-]*)*$/;

/** `value` when it is a path a route may name, else `null`: absolute, plain characters only, no empty (`//`), `.` or
 *  `..` segment, at most `MAX_ROUTE_PATH_LENGTH` long. */
export function safeRoutePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ROUTE_PATH_LENGTH || !ROUTE_PATH.test(value)) return null;
  const segments = value.split("/").slice(1);
  /* A trailing slash leaves one empty last segment (`/r/11/`): allowed. Any other empty segment is a `//`. */
  for (let at = 0; at < segments.length; at += 1) {
    const segment = segments[at];
    if (segment === "." || segment === "..") return null;
    if (segment === "" && at !== segments.length - 1) return null;
  }
  return value;
}

/** Where a route frame sends THIS link, or why it cannot be followed. */
export type RouteTarget =
  /** Load another bundle on the page's own origin (the page navigates; the table is kept by its stored pointer). */
  | { readonly kind: "bundle"; readonly url: string; readonly path: string }
  /** Reconnect this link to another path on the game server's origin (same bundle). */
  | { readonly kind: "socket"; readonly url: string; readonly path: string }
  /** Fail closed: nothing to follow, or nothing this tab will follow. */
  | { readonly kind: "none"; readonly why: "no-destination" | "unsafe-destination" | "other-game" };

export interface RouteEnvironment {
  /** The page's origin (`window.location.origin`). */
  readonly pageOrigin: string;
  /** This bundle's own base path (`process.env.PUBLIC_URL`, "" at the root): a route to it is not a route. */
  readonly bundleBase: string;
  /** The game server's socket URL (`GAME_SERVER_URL`), or null when none is configured. */
  readonly gameServerUrl: string | null;
  /** The game this link is about (`null`: the lobby's channel). */
  readonly gameId: string | null;
}

const normalizedBase = (path: string): string => (path.endsWith("/") ? path : `${path}/`);

/**
 * The target of a route frame for one link, CHECKED: a bundle path resolved on the page's origin, or a socket path on
 * the game server's -- each must be a safe path (`safeRoutePath`) and must stay on its origin once resolved. A route
 * about another game, one with an unsafe path anywhere in it, or one with nothing to follow is `none` (the caller
 * fails closed: "cannot continue here", exactly as for a game this server does not continue). A bundle path that is
 * this bundle's own base is not a bundle route; the socket path then decides.
 */
export function routeTargetOf(frame: { gameId?: unknown; bundlePath?: unknown; wsPath?: unknown }, env: RouteEnvironment): RouteTarget {
  if (frame.gameId !== undefined && frame.gameId !== env.gameId) return { kind: "none", why: "other-game" };
  if (env.gameId === null) return { kind: "none", why: "other-game" }; // the lobby plays no game: nothing to route
  const bundlePath = frame.bundlePath === undefined ? undefined : safeRoutePath(frame.bundlePath);
  const wsPath = frame.wsPath === undefined ? undefined : safeRoutePath(frame.wsPath);
  if (bundlePath === null || wsPath === null) return { kind: "none", why: "unsafe-destination" };
  if (bundlePath !== undefined && normalizedBase(bundlePath) !== normalizedBase(env.bundleBase || "/")) {
    let url: URL;
    try {
      url = new URL(bundlePath, env.pageOrigin);
    } catch {
      return { kind: "none", why: "unsafe-destination" };
    }
    if (url.origin !== env.pageOrigin) return { kind: "none", why: "unsafe-destination" };
    return { kind: "bundle", url: url.href, path: bundlePath };
  }
  if (wsPath !== undefined) {
    if (env.gameServerUrl === null) return { kind: "none", why: "no-destination" };
    let base: URL;
    let url: URL;
    try {
      base = new URL(env.gameServerUrl);
      url = new URL(wsPath, base);
    } catch {
      return { kind: "none", why: "unsafe-destination" };
    }
    if (url.protocol !== base.protocol || url.host !== base.host) return { kind: "none", why: "unsafe-destination" };
    return { kind: "socket", url: url.href, path: wsPath };
  }
  return { kind: "none", why: "no-destination" };
}
