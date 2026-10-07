// server/src/persistence/conformance/fenceGap.test.ts
//
// ==================================================================
//  LIVE-5 L5-1: F-L5-4 PINNED, PER PORT -- AND EVERY "FENCE INSIDE THE WRITE" CASE SHOWN TO HAVE TEETH
// ==================================================================
//
// Today's file stores check their fence (`writerCheck`) BEFORE they write, so a takeover that lands between that check
// and the write does not stop it (F-L5-4, a time-of-check/time-of-use gap). That is acceptable for one process holding
// the data directory's lock; it is exactly what a multi-task DynamoDB deployment must not do. Each port's conformance
// module therefore has a "fence inside the write" case (LOG-20, REC-18, HOLD-12, FIN-11, INT-12, TKT-11, ID-14,
// JNL-12; L5-4 adds ID-20-takeover-during-step, and L5-5 JNL-16 for the journal's attempts) that every DynamoDB adapter
// must pass (`REQUIRED_CAPABILITIES.dynamodb`).
//
// This file runs each of those cases against the file store with the capability FORCED ON and asserts it FAILS, and
// fails for the right reason (the stale write got through). Two things are proved at once: the gap is real, per port,
// so L5-2/4/5 cannot forget it; and each case really detects a check-then-write store -- it is not vacuous. The
// reference log model, which fences at the apply, passes LOG-20 (`logStore.conformance.test.ts`).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { FINANCIAL_CASES, INTENT_CASES, TICKET_CASES } from "./escrowStores.conformance";
import { runCase, type Capability, type ConformanceCase, type SubjectBase } from "./harness";
import { IDENTITY_CASES, JOURNAL_CASES } from "./identityJournal.conformance";
import { LOG_CASES } from "./logStore.conformance";
import { HOLD_CASES, RECORD_CASES } from "./roomStores.conformance";
import { CONDUCT_CASES } from "./conductStore.conformance";
import {
  fileConductSubject,
  fileFinancialSubject,
  fileHoldSubject,
  fileIntentSubject,
  fileJournalSubject,
  fileLogSubject,
  fileRecordSubject,
  fileTicketSubject,
  journalIdentitySubject,
} from "./subjects";

function pin<S extends SubjectBase>(port: string, subject: S, cases: readonly ConformanceCase<S>[], id: string, gap: "fence-in-write" | "cas-in-write" = "fence-in-write"): void {
  const what = gap === "fence-in-write" ? "a takeover between its writerCheck and its write does not stop the stale write" : "a second writer between its read and its write is overwritten";
  test(`${port}: ${subject.name} fails ${id} -- ${what}`, async () => {
    const entry = cases.find((candidate) => candidate.id === id);
    assert.ok(entry, `${id} exists`);
    assert.ok(entry.needs?.includes(gap), `${id} is a ${gap} case`);
    assert.equal(subject.capabilities.includes(gap), false, `${subject.name} does not claim the capability`);
    const forced = { ...subject, capabilities: [...subject.capabilities, gap as Capability] };
    await assert.rejects(runCase(forced, entry), (error: Error) => {
      assert.equal(error.name, "AssertionError", `the case failed on an assertion, not a crash: ${error.message}`);
      /* ...and on the case's own outcome assertion (the write went through): not on setup, the stall or an unfired fault. */
      if (gap === "fence-in-write") assert.match(error.message, /^FENCE-IN-WRITE: the stale writer's in-flight .* was applied/, error.message);
      else assert.match(error.message, /^CAS-IN-WRITE: the first .* in-flight .* overwrote/, error.message);
      return true;
    });
  });
}

describe("L5-1: F-L5-4 pinned for every port (the file stores fence BEFORE the write; L5-2/4/5 must fence INSIDE it)", () => {
  pin("log", fileLogSubject, LOG_CASES, "LOG-20");
  pin("GameRecord", fileRecordSubject, RECORD_CASES, "REC-18");
  pin("hold", fileHoldSubject, HOLD_CASES, "HOLD-12");
  pin("financial record", fileFinancialSubject, FINANCIAL_CASES, "FIN-11");
  pin("chain intent", fileIntentSubject, INTENT_CASES, "INT-12");
  pin("wallet ticket", fileTicketSubject, TICKET_CASES, "TKT-11");
  pin("identity", journalIdentitySubject, IDENTITY_CASES, "ID-14");
  pin("identity (a takeover during the caller's step, L5-4)", journalIdentitySubject, IDENTITY_CASES, "ID-20-takeover-during-step");
  pin("signing journal", fileJournalSubject, JOURNAL_CASES, "JNL-12");
  /* L5-5: the attempt write too -- the relayer fence belongs inside the attempt's write, not before it. */
  pin("signing journal (attempts)", fileJournalSubject, JOURNAL_CASES, "JNL-16");
});

/* LIVE-5 L5-2 (L5-1 handoff R2-L4): a SECOND fence-inside-the-write operation per game-table port, so no port's claim
   rests on one operation. Each is pinned the same way: the file store fails it for the right reason. */
describe("L5-2: the second fence-inside-the-write operation of every game-table port, pinned against the file stores", () => {
  pin("log (chat)", fileLogSubject, LOG_CASES, "LOG-25");
  pin("GameRecord (join code)", fileRecordSubject, RECORD_CASES, "REC-19");
  pin("hold (release)", fileHoldSubject, HOLD_CASES, "HOLD-13");
  pin("financial record (create)", fileFinancialSubject, FINANCIAL_CASES, "FIN-16");
  pin("chain intent (create)", fileIntentSubject, INTENT_CASES, "INT-13");
  pin("wallet ticket (first ledger)", fileTicketSubject, TICKET_CASES, "TKT-12");
});

/* LIVE-5 L5-2 (review M-5): the file stores decide create-if-absent and CAS from a READ before they write, so a second
   writer between that read and the write is overwritten. Harmless for one store instance per data directory under its
   lock (each key's operations are chained); exactly what a DynamoDB adapter must not do, and every DynamoDB subject must
   declare `cas-in-write`. Pinned per port, which also proves each race case detects a read-then-write store. */
describe("L5-2: the condition inside the write (create-if-absent / CAS / next index), pinned against the file stores", () => {
  pin("log (next index)", fileLogSubject, LOG_CASES, "LOG-28", "cas-in-write");
  pin("GameRecord (create)", fileRecordSubject, RECORD_CASES, "REC-21", "cas-in-write");
  pin("hold (create)", fileHoldSubject, HOLD_CASES, "HOLD-16", "cas-in-write");
  pin("financial record (create)", fileFinancialSubject, FINANCIAL_CASES, "FIN-19", "cas-in-write");
  pin("chain intent (create)", fileIntentSubject, INTENT_CASES, "INT-16", "cas-in-write");
  pin("wallet ticket (first ledger)", fileTicketSubject, TICKET_CASES, "TKT-14", "cas-in-write");
});

/* Phase 3 (P3-N035): the conduct-case port -- both of its fence-inside-the-write operations, and its CAS races. */
describe("Phase 3 (P3-N035): the conduct-case port, pinned against its file store", () => {
  pin("conduct case (decision)", fileConductSubject, CONDUCT_CASES, "CND-13");
  pin("conduct case (create)", fileConductSubject, CONDUCT_CASES, "CND-13-create");
  pin("conduct case (two reviewers)", fileConductSubject, CONDUCT_CASES, "CND-15", "cas-in-write");
  pin("conduct case (two tabs)", fileConductSubject, CONDUCT_CASES, "CND-16", "cas-in-write");
});
