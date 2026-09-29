// frontend/src/utils/clientAnnouncement.ts
//
// ==================================================================
//  LIVE-4 (L4-3): THIS BUNDLE ANNOUNCES ITSELF ON EVERY SOCKET IT OPENS
// ==================================================================
//
// Every socket this bundle opens -- the game's log link and every room channel, the lobby's included -- carries the
// announcement on its URL (preflight §10.2 item 2): the client protocol this bundle speaks, the rules engines its own
// reducer carries, and its build (diagnostic only; nothing compares it). The query is the canonical one
// (`clientAnnouncementQuery`, `gameEngine/compat/clientCompatibility.ts`), so the server reads it back with the one
// parser there. No frame schema changes: the announcement lives on the upgrade, where it is read once and frozen for
// the socket's life.

import { CLIENT_BUILD_ID } from "../config";
import { ANNOUNCED_CLIENT_PROTOCOL } from "../gameEngine/protocolVersions";
import { SUPPORTED_RULES_ENGINE_VERSIONS } from "../gameEngine/rulesVersion";
import { clientAnnouncementQuery } from "../gameEngine/compat/clientCompatibility";

/** This bundle's announcement: `cp=1&cr=11&cb=<build>` (the build only when it is a build id). */
export const THIS_BUNDLE_ANNOUNCEMENT: string = clientAnnouncementQuery(ANNOUNCED_CLIENT_PROTOCOL, SUPPORTED_RULES_ENGINE_VERSIONS, CLIENT_BUILD_ID);

/** `url` with the announcement in its query (before any fragment). An empty announcement (the legacy wire) leaves the
 *  URL exactly as it was. */
export function withClientAnnouncement(url: string, announcement: string = THIS_BUNDLE_ANNOUNCEMENT): string {
  if (announcement === "") return url;
  const hash = url.indexOf("#");
  const head = hash === -1 ? url : url.slice(0, hash);
  const tail = hash === -1 ? "" : url.slice(hash);
  const separator = !head.includes("?") ? "?" : head.endsWith("?") || head.endsWith("&") ? "" : "&";
  return `${head}${separator}${announcement}${tail}`;
}
