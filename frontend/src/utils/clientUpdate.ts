// frontend/src/utils/clientUpdate.ts
//
// ==================================================================
//  LIVE-4 (L4-3): THE PAGE'S ANSWER TO "THIS BUNDLE CANNOT PLAY THIS" -- RELOAD ONCE, FOLLOW A ROUTE, NEVER LOOP
// ==================================================================
//
// The links (`serverLink.ts`, `roomLink.ts`) end a link that was told `reload` or `route` (`clientAnswers.ts`) and
// hand the page decision to this port. The page is ONE thing across all its links -- the lobby's channel, a game's
// room channel and its log link may all be told `reload` in the same second -- so the decision lives here, once:
//
//   reload   the page reloads ONCE. A reload keeps the table: the game this tab was at is a pointer in
//            `sessionStorage` (`activeGame.ts`, #551), which a reload does not touch -- the app comes back into that
//            table and its links say hello again, now from this release's bundle. Nothing here writes gameplay or
//            money state: the only thing written is this port's own marker.
//   no loop  before reloading, the port writes a marker naming the answer (its code, and its game for a per-game
//            answer). If the SAME answer arrives again while that marker is fresh (`RELOAD_GUARD_MS`), the reload did
//            not help -- the bundle this page gets is still not one the server can serve -- and the page does NOT
//            reload again: it shows `ClientUpdateNotice`, which says why and offers Reload (and, for a table, the way
//            back to the lobby). Markers EXPIRE; nothing else clears them. A normal answer on some other link proves
//            nothing about this one (two pools, or a proxy and a stale bundle, can disagree at every load), so it is
//            never read as "the reload worked" -- that is how a guard re-arms itself into a loop. Every answer keeps its
//            own marker, so two answers that alternate cannot defeat each other's; and the tab as a whole navigates by
//            itself at most `MAX_AUTO_NAVIGATIONS` times in a window, whatever the answers. With no storage to keep the
//            markers (private browsing, a blocked store) the page never navigates by itself: it asks.
//   route    a route to another bundle navigates the page to that bundle's path on this origin (`routeTargetOf` has
//            checked it), keeping the table the same way; at most `MAX_ROUTE_HOPS` per game in a guard window -- counted
//            across loads and never reset by a normal answer -- so a routing disagreement ends in "cannot continue here
//            right now", never a ping-pong.
//
// DETERMINISTIC. The decision reads only the markers, the answer and the injected clock; the navigation, the storage and
// the clock are all injected, so every branch is tested without a browser.

import type { ClientVerdictCode } from "../gameEngine/compat/clientCompatibility";
import { forgetActiveTable } from "./activeGame";
import { CLIENT_ANSWER_SENTENCES } from "./clientAnswers";

/** How long a reload marker says "that reload did not help". Long enough to cover a reload and its reconnect. */
export const RELOAD_GUARD_MS = 5 * 60_000;
/** How long route hops are counted for one game. */
export const ROUTE_GUARD_MS = 5 * 60_000;
/** The most bundle routes one game may take in a guard window (preflight §10.2 item 5: "hops is capped"). */
export const MAX_ROUTE_HOPS = 2;
/** The most times one tab navigates BY ITSELF (reloads and bundle routes together) in a `RELOAD_GUARD_MS` window,
 *  whatever the answers -- the last loop breaker. The player's own button is never counted. */
export const MAX_AUTO_NAVIGATIONS = 3;
/** Where the port keeps its markers: per TAB (`sessionStorage`), like the table pointer it protects. */
export const CLIENT_UPDATE_STORAGE_KEY = "juno.clientUpdate.v1";
/** The most answers (and routed games) the markers remember; the oldest go first. */
const MAX_REMEMBERED = 16;
/** The longest answer key or game key a marker keeps (a game id is far shorter). */
const MAX_MARKER_KEY_LENGTH = 96;

/** The two connection-level codes: they are about the page, not about one game. */
const CONNECTION_LEVEL: ReadonlySet<ClientVerdictCode> = new Set<ClientVerdictCode>(["client-protocol", "client-announcement"]);

export type ClientUpdateState =
  | { readonly kind: "idle" }
  /** The page is leaving (a reload or a route): nothing else is decided. */
  | { readonly kind: "navigating"; readonly to: "reload" | "bundle"; readonly gameId: string | null }
  /** A reload is needed and the page will not do it by itself (it just did, it has used its budget, or it cannot
   *  remember that it did). */
  | { readonly kind: "needs-reload"; readonly code: ClientVerdictCode; readonly gameId: string | null; readonly repeated: boolean }
  /** A route could not be followed (fail closed). */
  | { readonly kind: "cannot-follow"; readonly gameId: string | null; readonly why: "hops" | "no-storage" };

export interface ClientUpdatePort {
  readonly state: ClientUpdateState;
  /** A link was told `reload` (or closed 4426). `gameId`: the table the answer is about, or null (connection-level). */
  reload(answer: { readonly code: ClientVerdictCode; readonly gameId: string | null }): void;
  /** A link was told `route` to another bundle (`routeTargetOf` checked `url`). */
  routeToBundle(target: { readonly url: string; readonly gameId: string | null }): void;
  /** The notice's Reload button: the player's own choice, always honoured (and never counted as automatic). */
  reloadNow(): void;
  /** The notice's "Back to the lobby" (a table's answer only): the player's own choice -- this tab forgets which table
   *  it was at (nothing is sent to the server; the seat stays the player's) and the page reloads into the lobby. */
  backToLobby(): void;
  subscribe(listener: () => void): () => void;
}

/** The slice of `Storage` the port uses. */
export interface MarkerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ClientUpdateDeps {
  /** `window.sessionStorage`, or null when there is none (the port then never navigates by itself). */
  storage: MarkerStorage | null;
  navigate: { reload(): void; assign(url: string): void };
  now: () => number;
  /** Forget which table this tab was at (`forgetActiveTable()` in a page: the table pointer and the router's active
   *  game, so the reload opens on the lobby): "Back to the lobby". */
  forgetTable?: () => void;
}

/** Answer key -> when this tab last reloaded for that answer. A null-prototype map: keys come from storage. */
type Stamps = Record<string, number>;
interface Markers {
  reloads: Stamps;
  /** Routed game -> its hops in the window and when it last took one. */
  routes: Record<string, { hops: number; at: number }>;
  /** When this tab navigated by itself, oldest first. */
  auto: number[];
}

const IDLE: ClientUpdateState = Object.freeze({ kind: "idle" });

const emptyMap = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const emptyMarkers = (): Markers => ({ reloads: emptyMap<number>(), routes: emptyMap<{ hops: number; at: number }>(), auto: [] });
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isMarkerKey = (key: string): boolean => key.length > 0 && key.length <= MAX_MARKER_KEY_LENGTH;
const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Fresh = younger than `span`; a marker from the future (a clock set back) counts as fresh: the safe side is to ask. */
const fresh = (at: number, now: number, span: number): boolean => now - at < span;

/** The markers in one fixed order, for the read-back comparison. */
function markerText(markers: Markers): string {
  const reloads = Object.keys(markers.reloads).sort().map((key) => [key, markers.reloads[key]]);
  const routes = Object.keys(markers.routes).sort().map((game) => [game, markers.routes[game].hops, markers.routes[game].at]);
  return JSON.stringify([reloads, routes, markers.auto]);
}

/** The markers worth keeping at `now`: nothing expired, at most `MAX_REMEMBERED` of each (the newest). */
function pruned(markers: Markers, now: number): Markers {
  const out = emptyMarkers();
  Object.keys(markers.reloads)
    .filter((key) => fresh(markers.reloads[key], now, RELOAD_GUARD_MS))
    .sort((a, b) => markers.reloads[b] - markers.reloads[a])
    .slice(0, MAX_REMEMBERED)
    .forEach((key) => {
      out.reloads[key] = markers.reloads[key];
    });
  Object.keys(markers.routes)
    .filter((game) => fresh(markers.routes[game].at, now, ROUTE_GUARD_MS))
    .sort((a, b) => markers.routes[b].at - markers.routes[a].at)
    .slice(0, MAX_REMEMBERED)
    .forEach((game) => {
      out.routes[game] = { hops: markers.routes[game].hops, at: markers.routes[game].at };
    });
  out.auto = markers.auto.filter((at) => fresh(at, now, RELOAD_GUARD_MS)).slice(-MAX_REMEMBERED);
  return out;
}

export function createClientUpdatePort(deps: ClientUpdateDeps): ClientUpdatePort {
  let state: ClientUpdateState = IDLE;
  const listeners = new Set<() => void>();
  const set = (next: ClientUpdateState) => {
    state = next;
    listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        /* a listener's failure is its own */
      }
    });
  };

  /** The markers, or `null` when the storage cannot be read (the port then refuses to navigate by itself). Anything
   *  not in the shape this port writes is dropped (read as none); the next write replaces it. */
  const read = (): Markers | null => {
    if (deps.storage === null) return null;
    let raw: string | null;
    try {
      raw = deps.storage.getItem(CLIENT_UPDATE_STORAGE_KEY);
    } catch {
      return null;
    }
    const out = emptyMarkers();
    if (raw === null) return out;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return out;
    }
    if (!isPlainRecord(parsed)) return out;
    const { reloads, routes, auto } = parsed as { reloads?: unknown; routes?: unknown; auto?: unknown };
    if (isPlainRecord(reloads)) {
      Object.keys(reloads).forEach((key) => {
        const at = reloads[key];
        if (isMarkerKey(key) && isTime(at)) out.reloads[key] = at;
      });
    }
    if (isPlainRecord(routes)) {
      Object.keys(routes).forEach((game) => {
        const entry = routes[game];
        if (!isMarkerKey(game) || !isPlainRecord(entry)) return;
        const { hops, at } = entry as { hops?: unknown; at?: unknown };
        if (typeof hops === "number" && Number.isSafeInteger(hops) && hops >= 0 && isTime(at)) out.routes[game] = { hops, at };
      });
    }
    if (Array.isArray(auto)) out.auto = auto.filter(isTime);
    return out;
  };
  /** Whether the markers were written AND read back as written -- only then may the page navigate by itself, since the
   *  markers are the one thing that stops a second navigation. */
  const write = (markers: Markers, now: number): boolean => {
    if (deps.storage === null) return false;
    const kept = pruned(markers, now);
    try {
      if (Object.keys(kept.reloads).length === 0 && Object.keys(kept.routes).length === 0 && kept.auto.length === 0) {
        deps.storage.removeItem(CLIENT_UPDATE_STORAGE_KEY);
      } else {
        deps.storage.setItem(CLIENT_UPDATE_STORAGE_KEY, JSON.stringify(kept));
      }
    } catch {
      return false;
    }
    const back = read();
    return back !== null && markerText(back) === markerText(kept);
  };
  /** How many times this tab navigated by itself in the window ending `now`. */
  const autoCount = (markers: Markers, now: number): number => markers.auto.filter((at) => fresh(at, now, RELOAD_GUARD_MS)).length;
  const withStamp = (stamps: Stamps, key: string, at: number): Stamps => {
    const out = emptyMap<number>();
    Object.keys(stamps).forEach((existing) => {
      out[existing] = stamps[existing];
    });
    out[key] = at;
    return out;
  };

  const reloadKey = (code: ClientVerdictCode, gameId: string | null): string =>
    CONNECTION_LEVEL.has(code) ? `${code}|*` : `${code}|${gameId ?? "*"}`;

  const leave = (to: "reload" | "bundle", gameId: string | null, go: () => void) => {
    set({ kind: "navigating", to, gameId });
    go();
  };

  return {
    get state() {
      return state;
    },
    reload({ code, gameId }) {
      if (state.kind === "navigating") return;
      const key = reloadKey(code, gameId);
      const markers = read();
      const now = deps.now();
      if (markers === null) {
        /* The page could not remember that it tried: ASK, never loop. */
        set({ kind: "needs-reload", code, gameId, repeated: false });
        return;
      }
      const last = markers.reloads[key];
      if (last !== undefined && fresh(last, now, RELOAD_GUARD_MS)) {
        /* The reload did not help: ASK, never loop. */
        set({ kind: "needs-reload", code, gameId, repeated: true });
        return;
      }
      if (autoCount(markers, now) >= MAX_AUTO_NAVIGATIONS) {
        /* This tab has navigated by itself enough for now: ASK (the answer itself is new, so its own sentence). */
        set({ kind: "needs-reload", code, gameId, repeated: false });
        return;
      }
      if (!write({ ...markers, reloads: withStamp(markers.reloads, key, now), auto: markers.auto.concat(now) }, now)) {
        set({ kind: "needs-reload", code, gameId, repeated: false });
        return;
      }
      leave("reload", gameId, () => deps.navigate.reload());
    },
    routeToBundle({ url, gameId }) {
      if (state.kind === "navigating") return;
      const markers = read();
      if (markers === null) {
        set({ kind: "cannot-follow", gameId, why: "no-storage" });
        return;
      }
      const now = deps.now();
      const game = gameId ?? "*";
      const last = markers.routes[game];
      const hops = last !== undefined && fresh(last.at, now, ROUTE_GUARD_MS) ? last.hops : 0;
      if (hops >= MAX_ROUTE_HOPS || autoCount(markers, now) >= MAX_AUTO_NAVIGATIONS) {
        set({ kind: "cannot-follow", gameId, why: "hops" });
        return;
      }
      const routes = emptyMap<{ hops: number; at: number }>();
      Object.keys(markers.routes).forEach((other) => {
        routes[other] = markers.routes[other];
      });
      routes[game] = { hops: hops + 1, at: now };
      if (!write({ ...markers, routes, auto: markers.auto.concat(now) }, now)) {
        set({ kind: "cannot-follow", gameId, why: "no-storage" });
        return;
      }
      leave("bundle", gameId, () => deps.navigate.assign(url));
    },
    reloadNow() {
      if (state.kind === "navigating") return;
      const now = deps.now();
      const markers = read();
      /* The player's reload re-arms the guard for this answer: if it comes back, the page asks again (no loop). */
      if (markers !== null && state.kind === "needs-reload") {
        write({ ...markers, reloads: withStamp(markers.reloads, reloadKey(state.code, state.gameId), now) }, now);
      }
      leave("reload", state.kind === "needs-reload" || state.kind === "cannot-follow" ? state.gameId : null, () => deps.navigate.reload());
    },
    backToLobby() {
      if (state.kind === "navigating") return;
      try {
        deps.forgetTable?.();
      } catch {
        /* storage disabled: nothing was kept, and the page opens on the lobby anyway */
      }
      leave("reload", null, () => deps.navigate.reload());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/* ---------------------------------------------------------------------------
    THE PAGE'S PORT
   --------------------------------------------------------------------------- */

/** A port that decides nothing and goes nowhere: what a link gets where there is no page (a node test, a script). */
const INERT: ClientUpdatePort = Object.freeze({
  get state() {
    return IDLE;
  },
  reload: () => undefined,
  routeToBundle: () => undefined,
  reloadNow: () => undefined,
  backToLobby: () => undefined,
  subscribe: () => () => undefined,
});

let installed: ClientUpdatePort | null = null;

/** The browser's port: this tab's `sessionStorage`, `location`, the wall clock. */
export function createBrowserClientUpdatePort(): ClientUpdatePort {
  let storage: MarkerStorage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  return createClientUpdatePort({
    storage,
    navigate: { reload: () => window.location.reload(), assign: (url) => window.location.assign(url) },
    now: () => Date.now(),
    /* The same forgetting as the shell's own way back to the lobby (`handleLeaveSandboxRoom` + `onLeaveGame`: the
       table pointer AND the router's active game), without its `leave` op: nothing is sent to the server. */
    forgetTable: () => forgetActiveTable(),
  });
}

/** Install the page's port (`index.tsx`). */
export function installClientUpdatePort(port: ClientUpdatePort): void {
  installed = port;
}

/** The page's port: the installed one; a browser one made on first use in a page; an inert one anywhere else. */
export function clientUpdatePort(): ClientUpdatePort {
  if (installed !== null) return installed;
  if (typeof window === "undefined" || typeof window.location === "undefined") return INERT;
  installed = createBrowserClientUpdatePort();
  return installed;
}

/** What the notice says for a state that asks the player (`null`: nothing to say). Plain words: what happened, what
 *  to do, and that nothing in the game changed -- never an internal code, never a rules version, and the rules named
 *  only when they are the reason. `lobby`: the notice also offers the way back to the lobby (an answer about one table
 *  -- the lobby itself may still be fine; a connection-level answer is about the whole page, so it offers Reload only). */
export function clientUpdateNotice(state: ClientUpdateState): { title: string; body: string; lobby: boolean } | null {
  const unchanged = " Nothing in the game has changed.";
  switch (state.kind) {
    case "needs-reload": {
      const lobby = state.gameId !== null && !CONNECTION_LEVEL.has(state.code);
      if (state.repeated) {
        return {
          title: "This page is still out of step with the game server",
          body: `The page was reloaded, but the game server still cannot serve it. Try reloading again in a few minutes.${lobby ? unchanged : ""}`,
          lobby,
        };
      }
      /* The server's own sentence for the answer (`clientAnswers.ts`): the rules only for `client-rules`. */
      return { title: "This page needs to be reloaded", body: `${CLIENT_ANSWER_SENTENCES[state.code]}${lobby ? unchanged : ""}`, lobby };
    }
    case "cannot-follow":
      return state.why === "hops"
        ? {
            title: "This table cannot continue here right now",
            body: `The table is being moved to another version of the game server. Try again in a few minutes.${unchanged}`,
            lobby: state.gameId !== null,
          }
        : {
            title: "This table cannot continue here right now",
            body: `This table is played on another version of the game server, and this page could not move there by itself. Try again in a few minutes, or go back to the lobby.${unchanged}`,
            lobby: state.gameId !== null,
          };
    default:
      return null;
  }
}
