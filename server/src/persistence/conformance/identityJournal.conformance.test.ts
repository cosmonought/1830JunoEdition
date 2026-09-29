// server/src/persistence/conformance/identityJournal.conformance.test.ts
//
// LIVE-5 L5-1: the identity port against its memory, journal (production) and legacy whole-file stores; the signing
// journal against its memory and file stores.

import { runConformance } from "./harness";
import { IDENTITY_CASES, JOURNAL_CASES } from "./identityJournal.conformance";
import { fileJournalSubject, journalIdentitySubject, memoryIdentitySubject, memoryJournalSubject, wholeFileIdentitySubject } from "./subjects";

runConformance("identity", [memoryIdentitySubject, wholeFileIdentitySubject, journalIdentitySubject], IDENTITY_CASES);
runConformance("signing journal", [memoryJournalSubject, fileJournalSubject], JOURNAL_CASES);
