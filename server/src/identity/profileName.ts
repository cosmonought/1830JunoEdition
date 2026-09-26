// server/src/identity/profileName.ts
//
// LIVE-2E: a profile's human-facing name -- the same sanitizer a room nickname uses, applied to a fixpoint, 1 to 24
// characters. Presentation only: no authority decision reads it, and two profiles may share one.

import { sanitizeName } from "../../../frontend/src/gameEngine/messageSchema";
import { isDisplayName, PROFILE_NAME_MAX } from "./store";

/** The cleaned name, or `null` when nothing usable is left (empty, or an input the sanitizer never settles on). */
export function cleanProfileName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 256) return null;
  let out = sanitizeName(raw, PROFILE_NAME_MAX);
  for (let pass = 0; pass < 8; pass += 1) {
    const next = sanitizeName(out, PROFILE_NAME_MAX);
    if (next === out) return isDisplayName(out) ? out : null;
    out = next;
  }
  return null;
}
