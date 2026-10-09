// LUDUM v1 -- player history (Lane C owns this directory). STEP 0 STUB: answers 503 `unavailable` until Lane C replaces
// it. The exported names and types are fixed by ../registry.ts.

import type { LudumHandler } from "../ports";
const unavailable = (detail: string) => ({ status: 503, json: { error: "unavailable", detail } });

export const games: LudumHandler = async () => unavailable("history is not implemented yet");
export const game: LudumHandler = async () => unavailable("history is not implemented yet");
