// server/src/persistence/conformance/conductStore.conformance.test.ts
//
// Phase 3 (P3-N032): the conduct-case port against its memory and file implementations (DynamoDB:
// `dynamoGame.conformance.test.ts`, on DynamoDB Local).

import { runConformance } from "./harness";
import { CONDUCT_CASES } from "./conductStore.conformance";
import { fileConductSubject, memoryConductSubject } from "./subjects";

runConformance("conduct case", [memoryConductSubject, fileConductSubject], CONDUCT_CASES);
