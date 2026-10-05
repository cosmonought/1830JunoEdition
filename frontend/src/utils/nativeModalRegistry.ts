// frontend/src/utils/nativeModalRegistry.ts
//
/* ==================================================================
    W3-A (AUD-13.07, OD-5(c)): WHICH NATIVE DIALOGS ARE OPEN, AND NOTHING ELSE
   ==================================================================
   Every `NativeModal` calls `showModal()` on its own, so two of them could reach the top layer at once and the
   later one simply covered the earlier one. The forced-notice chain (`useNoticeChain`) needs one fact to stop
   that: whether a native dialog that is NOT one of its own notices is open right now. This file holds exactly
   that fact.

   A REGISTRY, NOT A STACK MANAGER. It never opens, closes, orders or re-focuses anything. `NativeModal` registers
   when React mounts it and unregisters when React takes it down; the chain reads the count and decides whether a
   notice may present. Every other surface keeps its own `showModal()` and its own policy (`NativeModal` #1651:
   "what this does not own").

   `chainedNotice` MARKS THE CHAIN'S OWN NOTICES, so a presented notice is not mistaken for a foreign dialog and
   withdrawn by its own presence. */

export type NativeModalEntry = { readonly id: number; readonly chainedNotice: boolean };

let entries: readonly NativeModalEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

/** Records one open native dialog. Returns its release; calling the release twice is harmless. */
export function registerNativeModal(chainedNotice: boolean): () => void {
  const entry: NativeModalEntry = { id: nextId, chainedNotice };
  nextId += 1;
  entries = [...entries, entry];
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entries = entries.filter((candidate) => candidate.id !== entry.id);
    emit();
  };
}

/** How many open native dialogs are not forced notices of the chain. */
export function foreignNativeModalCount(): number {
  return entries.filter((entry) => !entry.chainedNotice).length;
}

/** Every open native dialog, chained or not -- for tests and diagnostics. */
export function openNativeModalCount(): number {
  return entries.length;
}

export function subscribeNativeModals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
