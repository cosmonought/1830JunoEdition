// server/src/persistence/conformance/identityDynamoLocal.conformance.test.ts
//
// LIVE-5 L5-4: the identity ports' conformance cases against the DynamoDB adapters, on DynamoDB Local
// (`npm run test:dynamodb-local`; see server/src/aws/README.md). The same cases the memory and journal stores run
// (identityJournal.conformance.ts, identitySecurity.conformance.ts) -- including those only a store that fences INSIDE
// its write can pass (ID-14, GRANT-08, SEC-06), and the lost-answer settlement (ID-12, its token and its
// landed / unlanded-then-takeover cases). Fails with instructions, never skips, without GS_DYNAMODB_LOCAL_ENDPOINT.

import { runConformance } from "./harness";
import { IDENTITY_CASES } from "./identityJournal.conformance";
import { GRANT_CASES, SEC_CASES } from "./identitySecurity.conformance";
import { dynamoSuite, identitySubjects, securitySubject } from "./identityDynamoSubjects";

const suite = dynamoSuite();
const { identity, grants } = identitySubjects(suite);

runConformance("identity", [identity], IDENTITY_CASES);
runConformance("sensitive-auth grants", [grants], GRANT_CASES);
runConformance("security-event journal", [securitySubject(suite)], SEC_CASES);
