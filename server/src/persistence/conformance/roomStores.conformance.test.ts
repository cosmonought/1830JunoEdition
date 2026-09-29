// server/src/persistence/conformance/roomStores.conformance.test.ts
//
// LIVE-5 L5-1: the GameRecord / join-code port and the hold port, against their memory and file implementations.

import { runConformance } from "./harness";
import { HOLD_CASES, RECORD_CASES } from "./roomStores.conformance";
import { fileHoldSubject, fileRecordSubject, memoryHoldSubject, memoryRecordSubject } from "./subjects";

runConformance("GameRecord", [memoryRecordSubject, fileRecordSubject], RECORD_CASES);
runConformance("hold", [memoryHoldSubject, fileHoldSubject], HOLD_CASES);
