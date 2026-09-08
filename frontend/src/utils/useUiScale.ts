// frontend/src/utils/useUiScale.ts
//
// Design note #1294: the chrome scale as a React value. `useSyncExternalStore` over the store in
// `uiScale.ts`, so a change from the picker re-renders every surface that draws with it, in one frame.

import { useSyncExternalStore } from "react";
import { getUiScale, subscribeUiScale } from "./uiScale";

export function useUiScale(): number {
  return useSyncExternalStore(subscribeUiScale, getUiScale, getUiScale);
}
