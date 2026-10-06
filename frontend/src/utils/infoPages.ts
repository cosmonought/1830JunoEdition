// frontend/src/utils/infoPages.ts
//
// PHASE 3 (P3-ACCT, AUD-20.08 / OD-16): the app's two reading pages that are not a table -- the RULES (public: a visitor
// reads them without an account) and the TERMS (the shell for the owner-authored terms of real-money play). There is no
// URL router in this app and none is added: a page opens as a full-window dialog from a small store, the same way the
// account dialog does (`accountPrompt.ts`), and closes back to where the player was. Its host is
// `components/InfoPages.tsx`, mounted once in `index.tsx`.

import { useSyncExternalStore } from "react";

/** Phase 3 (P3-N032): and the conduct reviewers' panel -- opened from the profile menu, for a reviewer account only (the
 *  server answers anyone else's review calls as routes that do not exist). */
export type InfoPage = "terms" | "rules" | "conduct-review";

let open: InfoPage | null = null;
/* Re-review N7: the page this one was opened from (the Terms from the Rules): closing goes back there. */
let previous: InfoPage | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

export function openInfoPage(page: InfoPage): void {
  previous = open !== null && open !== page ? open : null;
  open = page;
  notify();
}

export function closeInfoPage(): void {
  open = previous;
  previous = null;
  notify();
}

export function openInfoPageNow(): InfoPage | null {
  return open;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInfoPage(): InfoPage | null {
  return useSyncExternalStore(subscribe, openInfoPageNow, openInfoPageNow);
}

/** Tests only. */
export function resetInfoPagesForTests(): void {
  open = null;
  previous = null;
  listeners.clear();
}
