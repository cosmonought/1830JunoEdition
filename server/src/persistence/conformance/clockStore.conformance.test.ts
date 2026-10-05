// server/src/persistence/conformance/clockStore.conformance.test.ts
//
// PHASE 3 LANE A (AUD-11.04): the gameplay clock's port against its memory and file implementations (the DynamoDB
// adapter runs the same cases in `dynamoGame.conformance.test.ts`, against DynamoDB Local).

import { runConformance } from "./harness";
import { CLOCK_CASES } from "./clockStore.conformance";
import { fileClockSubject, memoryClockSubject } from "./subjects";

runConformance("clock", [memoryClockSubject, fileClockSubject], CLOCK_CASES);
