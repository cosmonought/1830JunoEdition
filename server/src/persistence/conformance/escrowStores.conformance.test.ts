// server/src/persistence/conformance/escrowStores.conformance.test.ts
//
// LIVE-5 L5-1: the financial-record, chain-intent and wallet-ticket ports against their memory and file implementations.
// The DynamoDB-Local proof adapter for the financial port runs the same FINANCIAL_CASES in `dynamoLocal.conformance.test.ts`.

import { FINANCIAL_CASES, INTENT_CASES, TICKET_CASES } from "./escrowStores.conformance";
import { runConformance } from "./harness";
import { fileFinancialSubject, fileIntentSubject, fileTicketSubject, memoryFinancialSubject, memoryIntentSubject, memoryTicketSubject } from "./subjects";

runConformance("financial record", [memoryFinancialSubject, fileFinancialSubject], FINANCIAL_CASES);
runConformance("chain intent", [memoryIntentSubject, fileIntentSubject], INTENT_CASES);
runConformance("wallet ticket", [memoryTicketSubject, fileTicketSubject], TICKET_CASES);
