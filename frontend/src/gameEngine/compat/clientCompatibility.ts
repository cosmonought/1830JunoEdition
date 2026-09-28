// frontend/src/gameEngine/compat/clientCompatibility.ts
//
// ==================================================================
//  LIVE-4 (L4-1): MAY THIS BROWSER TALK TO THIS SERVER ABOUT THIS GAME?
// ==================================================================
//
// Client compatibility is per CONNECTION and per GAME, never a property of a game: a stale tab never makes a game
// "incompatible". It is three axes, kept apart:
//
//   the client wire protocol      the bundle's `CLIENT_PROTOCOL_VERSION`, announced once at the upgrade (`cp`); the
//                                 server accepts a set (`capability.client_protocols`).
//   the client-supported rules    the rules engines the bundle's reducer can apply (`cr`, its
//                                 `SUPPORTED_RULES_ENGINE_VERSIONS`): the bundle applies history with its OWN reducer,
//                                 so it must carry the game's.
//   the game's rules pin          the deal's `rules_engine_version`, fixed when the table is dealt.
//
// The bundle's build (`cb`) rides along for diagnostics and is compared by nothing.
//
// THE LEGACY WIRE (OD-L4-1). A socket that announces nothing -- every pre-LIVE-4 bundle -- is protocol 0. It keeps
// exactly today's treatment (the exact build comparison on `submit`, `build-skew`), which is the transport's to keep
// (L4-3); it is never sent `reload`, `route` or close 4426, because a legacy bundle does not treat them as terminal
// and would reconnect-loop. When protocol 0 is retired (once the first production bundle ships) a legacy socket is
// refused with only what a legacy bundle already understands. From protocol 1 on, `cr` is required.
//
// WHAT THE ANSWERS MEAN (the transport and the App are L4-3's; the route target is LIVE-6's):
//   ok              talk normally;
//   legacy          protocol 0: today's exact-build path, no per-game rules check (the known gap that retires with it);
//   legacy-refused  protocol 0 is no longer accepted;
//   reload          THIS release's bundle fixes it: the client's protocol is not accepted, its announcement is broken,
//                   or it lacks the game's rules while this release carries them;
//   route           this release's bundle would not fix it either: the game's rules are not this release's at all,
//                   so the game belongs to another pool and its bundle (LIVE-6 supplies the target; before LIVE-6 the
//                   transport answers what it answers for a game this pool does not continue).
//
// A release's bundle and its server are built from one tree, so the bundle's rules are the capability's
// `rules.supported`: that is what "this release's bundle" can play.

import { LEGACY_CLIENT_PROTOCOL } from "../protocolVersions";
import { deploymentCapability, type DeploymentCapability } from "./deploymentCapability";
import { isVersionNumber } from "./continuationIdentity";

/** The raw announcement values as the upgrade received them (`null` = absent). Parsing them is canonical here;
 *  reading them off the URL or a header is the transport's (L4-3). */
export interface RawClientAnnouncement {
  readonly cp?: string | null;
  readonly cr?: string | null;
  readonly cb?: string | null;
}

export type ClientAnnouncement =
  /** No `cp` (or an explicit `0`): the legacy wire. */
  | { readonly kind: "legacy"; readonly protocol: typeof LEGACY_CLIENT_PROTOCOL; readonly build: string | null }
  | { readonly kind: "announced"; readonly protocol: number; readonly rules: readonly number[]; readonly build: string | null }
  /** A `cp` was sent, so the bundle is LIVE-4 or later, but the announcement cannot be read. `protocol` is null when `cp`
   *  itself is not a protocol number. */
  | { readonly kind: "malformed"; readonly protocol: number | null; readonly problem: string; readonly build: string | null };

/** A protocol number as a bundle spells it: canonical decimal, no sign, no leading zero. */
const PROTOCOL = /^(0|[1-9][0-9]{0,8})$/;
/** A rules version as a bundle spells it. */
const RULES_VERSION = /^[1-9][0-9]{0,8}$/;
/** More than this many supported engines in one bundle is not a bundle this project builds. */
export const MAX_ANNOUNCED_RULES = 16;

/**
 * The canonical reading of an announcement. `cr` is a comma-separated list of rules versions (`11`, `10,11`), in any
 * order, with no duplicate and nothing else; it is required from protocol 1 on and ignored for protocol 0.
 */
export function parseClientAnnouncement(raw: RawClientAnnouncement): ClientAnnouncement {
  const build = typeof raw.cb === "string" ? raw.cb : null;
  if (raw.cp == null) return Object.freeze({ kind: "legacy", protocol: LEGACY_CLIENT_PROTOCOL, build });
  if (typeof raw.cp !== "string" || !PROTOCOL.test(raw.cp)) {
    return Object.freeze({ kind: "malformed", protocol: null, problem: "cp is not a protocol number", build });
  }
  const protocol = Number(raw.cp);
  if (protocol === LEGACY_CLIENT_PROTOCOL) return Object.freeze({ kind: "legacy", protocol: LEGACY_CLIENT_PROTOCOL, build });
  if (raw.cr == null) return Object.freeze({ kind: "malformed", protocol, problem: "cr is required from protocol 1 on", build });
  const parts = typeof raw.cr === "string" ? raw.cr.split(",") : [];
  if (parts.length === 0 || parts.length > MAX_ANNOUNCED_RULES || !parts.every((part) => RULES_VERSION.test(part))) {
    return Object.freeze({ kind: "malformed", protocol, problem: "cr is not a list of rules versions", build });
  }
  const rules: number[] = [];
  for (const part of parts) {
    const version = Number(part);
    if (rules.includes(version)) return Object.freeze({ kind: "malformed", protocol, problem: `cr names ${version} twice`, build });
    rules.push(version);
  }
  return Object.freeze({ kind: "announced", protocol, rules: Object.freeze(rules.sort((a, b) => a - b)), build });
}

export type ClientVerdictCode = "client-protocol" | "client-rules" | "client-announcement";

export type ClientVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "legacy" }
  | { readonly kind: "legacy-refused"; readonly detail: string }
  | { readonly kind: "reload"; readonly code: ClientVerdictCode; readonly detail: string; readonly accepted: readonly number[] }
  | { readonly kind: "route"; readonly code: "client-rules"; readonly detail: string };

/**
 * The client verdict for one announcement, against this pool's capability, about one game -- `gamePin` is the game's
 * rules pin, or null when there is none to check (no deal yet, the lobby, an unpinned development log). Pure. The
 * answer never depends on `cb`, and a legacy socket never gets `reload` or `route`.
 */
export function clientVerdict(announcement: ClientAnnouncement, capability: DeploymentCapability, gamePin: number | null): ClientVerdict {
  if (gamePin !== null && !isVersionNumber(gamePin)) throw new TypeError(`a game's rules pin is a positive integer, not ${String(gamePin)}`);
  const pool = deploymentCapability(capability);
  const accepted = pool.client_protocols;

  if (announcement.kind === "legacy") {
    return accepted.includes(LEGACY_CLIENT_PROTOCOL)
      ? Object.freeze({ kind: "legacy" })
      : Object.freeze({ kind: "legacy-refused", detail: "this server no longer accepts a client that announces no protocol" });
  }
  if (announcement.protocol !== null && !accepted.includes(announcement.protocol)) {
    return Object.freeze({ kind: "reload", code: "client-protocol", detail: `client protocol ${announcement.protocol} is not accepted here (accepted: ${accepted.join(", ")})`, accepted });
  }
  if (announcement.kind === "malformed") {
    return Object.freeze({ kind: "reload", code: "client-announcement", detail: announcement.problem, accepted });
  }
  if (gamePin === null || announcement.rules.includes(gamePin)) return Object.freeze({ kind: "ok" });
  if (pool.rules.supported.includes(gamePin)) {
    return Object.freeze({ kind: "reload", code: "client-rules", detail: `this game plays rules engine ${gamePin}, which this tab does not carry`, accepted });
  }
  return Object.freeze({ kind: "route", code: "client-rules", detail: `this game plays rules engine ${gamePin}, which neither this tab nor this server's bundle carries` });
}
