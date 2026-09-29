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
// JNL-12; L5-4 adds ID-20-takeover-during-step) that every DynamoDB adapter must pass (`REQUIRED_CAPABILITIES.dynamodb`).
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
import {
  fileFinancialSubject,
  fileHoldSubject,
  fileIntentSubject,
  fileJournalSubject,
  fileLogSubject,
  fileRecordSubject,
  fileTicketSubject,
  journalIdentitySubject,
} from "./subjects";

function pin<S extends SubjectBase>(port: string, subject: S, cases: readonly ConformanceCase<S>[], id: string): void {
  test(`${port}: ${subject.name} fails ${id} -- a takeover between its writerCheck and its write does not stop the stale write`, async () => {
    const entry = cases.find((candidate) => candidate.id === id);
    assert.ok(entry, `${id} exists`);
    assert.ok(entry.needs?.includes("fence-in-write"), `${id} is a fence-inside-the-write case`);
    assert.equal(subject.capabilities.includes("fence-in-write"), false, `${subject.name} does not claim the capability`);
    const forced = { ...subject, capabilities: [...subject.capabilities, "fence-in-write" as Capability] };
    await assert.rejects(runCase(forced, entry), (error: Error) => {
      assert.equal(error.name, "AssertionError", `the case failed on an assertion, not a crash: ${error.message}`);
      /* ...and on the case's own FENCE-IN-WRITE outcome assertion (the stale write went through): not on setup, the stall
         or an unfired fault. */
      assert.match(error.message, /^FENCE-IN-WRITE: the stale writer's in-flight .* was applied/, error.message);
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
});
