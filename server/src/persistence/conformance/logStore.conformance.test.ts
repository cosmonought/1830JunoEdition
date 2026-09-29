// server/src/persistence/conformance/logStore.conformance.test.ts
//
// LIVE-5 L5-1: the log port's conformance cases against the reference model and the file store (`fileLogStore.ts`).
// The DynamoDB log adapter joins this list in L5-2.

import { runConformance } from "./harness";
import { LOG_CASES } from "./logStore.conformance";
import { fileLogSubject, referenceLogSubject } from "./subjects";

runConformance("log", [referenceLogSubject, fileLogSubject], LOG_CASES);
