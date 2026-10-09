// LUDUM v1 -- dispute case records (Lane B2 owns this directory). STEP 0 STUB: answers 503 `unavailable` until Lane B2
// replaces it. The exported name and type are fixed by ../registry.ts (`case` is a reserved word, hence `caseRecord`).

import type { LudumHandler } from "../ports";
const unavailable = (detail: string) => ({ status: 503, json: { error: "unavailable", detail } });

export const caseRecord: LudumHandler = async () => unavailable("case records are not implemented yet");
