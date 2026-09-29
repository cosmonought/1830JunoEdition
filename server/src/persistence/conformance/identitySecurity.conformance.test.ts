// server/src/persistence/conformance/identitySecurity.conformance.test.ts
//
// LIVE-5 L5-4: the identity side's durable security ports -- sensitive-auth grants and the security-event journal --
// against their in-memory reference models (the DynamoDB subjects run in identityDynamoLocal.conformance.test.ts).

import { runConformance } from "./harness";
import { GRANT_CASES, SEC_CASES } from "./identitySecurity.conformance";
import { memoryGrantSubject, memorySecuritySubject } from "./subjects";

runConformance("sensitive-auth grants", [memoryGrantSubject], GRANT_CASES);
runConformance("security-event journal", [memorySecuritySubject], SEC_CASES);
