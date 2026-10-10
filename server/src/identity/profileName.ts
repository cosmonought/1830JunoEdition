// server/src/identity/profileName.ts
//
// LIVE-2E: a profile's human-facing name -- the same sanitizer a room nickname uses, applied to a fixpoint, 1 to 24
// characters. Presentation only: no authority decision reads it.
// LUDUM (display names): a name chosen at account creation or by the profile's one change is UNIQUE by its key
// (`displayNameKey`): NFKC, case-folded, whitespace collapsed -- so "Marlowe", "marlowe" and "MARLOWE " are one name.
// Two legacy profiles that already shared a name keep it; nobody new can take it.

import { sanitizeName } from "../../../frontend/src/gameEngine/messageSchema";
import { isDisplayName, PROFILE_NAME_MAX } from "./store";

/** LUDUM: the uniqueness key of a display name (never shown; never an authority key). */
export function displayNameKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

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
