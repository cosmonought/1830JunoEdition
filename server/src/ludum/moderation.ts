// server/src/ludum/moderation.ts
//
// ==================================================================
//  LUDUM v1.1: `moderation-queue` / `moderation-case` / `moderation-decide` -- CONDUCT REVIEW FROM LUDUM, REVIEWERS ONLY
// ==================================================================
//
// The SAME service and rules as Play's `/gs/api/conduct/review/*` (`conduct/conductHttpApi.ts`), reached through Ludum's
// own prefix -- Play's conduct routes stay closed to Ludum's origin (no CORS is relaxed anywhere else):
//   * a REVIEWER is one of the accounts bound at startup to the configured reviewer usernames; the ingress answers anyone else
//     404 `not-found` before a handler runs (registry access "reviewer"), and every handler checks again;
//   * a reviewer never sees a case they are party to (the service answers it as one that does not exist);
//   * a DECISION needs the session's live sensitive grant ("Confirm it's you" on Play, or a fresh sign-in's own grant):
//     403 `reauth-required` with Play's confirmation link otherwise.
// Conduct cases are CONFIDENTIAL: no route here is public, nothing names a principal, a username or a wallet (parties are
// seat ids, nicknames and account fingerprints, exactly as Play's panel shows them), and the parties never see them.

import { ConductCaseUnreadableError } from "../conduct/conductCase";
import { ConductRosterUnavailableError } from "../conduct/conductService";
import type { LudumHandler, LudumMemberPorts } from "./ports";

type Answer = { status: number; json: unknown };
const notFound = (): Answer => ({ status: 404, json: { error: "not-found" } });
const unavailable = (detail?: string): Answer => ({ status: 503, json: { error: "unavailable", ...(detail !== undefined ? { detail } : {}) } });
const badRequest = (detail: string): Answer => ({ status: 400, json: { error: "bad-request", detail } });

/** Where a decision returns after "Confirm it's you" (a fixed Ludum path: the case id is restored by the page). */
export const MODERATION_RETURN_PATH = "/moderation/";
const CASE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The reviewer's members port, or the answer for a caller who is not one (404, as for a route that does not exist). */
function reviewerPorts(caller: { principalId: string | null }, members: LudumMemberPorts | undefined): LudumMemberPorts | Answer {
  if (caller.principalId === null || members === undefined || !members.isReviewer(caller.principalId)) return notFound();
  return members;
}

const isAnswer = (value: LudumMemberPorts | Answer): value is Answer => typeof (value as Answer).status === "number";

function caseIdOf(body: unknown, allowed: readonly string[]): string | Answer {
  if (typeof body !== "object" || body === null || Object.keys(body).some((key) => !allowed.includes(key))) return badRequest(`the body is { ${allowed.join(", ")} }`);
  const caseId = (body as { caseId?: unknown }).caseId;
  if (typeof caseId !== "string" || !CASE_ID.test(caseId)) return badRequest("caseId is not a case id");
  return caseId;
}

export const moderationQueue: LudumHandler = async (body, caller, ports) => {
  const members = reviewerPorts(caller, ports.members);
  if (isAnswer(members)) return members;
  if (typeof body !== "object" || body === null || Object.keys(body).length !== 0) return badRequest("the body is {}");
  const queue = await members.queue(caller.principalId as string);
  return { status: 200, json: { cases: queue.cases, unreadable: queue.unreadable } };
};

export const moderationCase: LudumHandler = async (body, caller, ports) => {
  const members = reviewerPorts(caller, ports.members);
  if (isAnswer(members)) return members;
  const caseId = caseIdOf(body, ["caseId"]);
  if (typeof caseId !== "string") return caseId;
  try {
    const view = await members.caseView(caseId, caller.principalId as string);
    return view === null ? notFound() : { status: 200, json: { case: view } };
  } catch (error) {
    if (error instanceof ConductCaseUnreadableError) return { status: 409, json: { error: "conflict", detail: "case-unreadable" } };
    if (error instanceof ConductRosterUnavailableError) return unavailable("the table's roster could not be read; the case is withheld");
    throw error;
  }
};

export const moderationDecide: LudumHandler = async (body, caller, ports) => {
  const members = reviewerPorts(caller, ports.members);
  if (isAnswer(members)) return members;
  const caseId = caseIdOf(body, ["caseId", "revision", "status", "note"]);
  if (typeof caseId !== "string") return caseId;
  const { revision, status, note } = body as { revision?: unknown; status?: unknown; note?: unknown };
  if (typeof revision !== "number" || !Number.isSafeInteger(revision)) return badRequest("revision is a whole number");
  if (typeof status !== "string") return badRequest("status is a string");
  if (note !== undefined && typeof note !== "string") return badRequest("note is a string");
  if (caller.sensitiveAuth !== true) return { status: 403, json: { error: "reauth-required", confirmUrl: members.confirmUrl(MODERATION_RETURN_PATH) } };
  const decided = await members.decide({ caseId, revision, status, note: note ?? null, reviewerPrincipalId: caller.principalId as string });
  if (decided.ok) return { status: 200, json: { case: decided.view } };
  switch (decided.code) {
    case "not-found":
    case "party":
      return notFound();
    case "unavailable":
    case "uncertain":
      return unavailable(decided.reason);
    case "bad-note":
    case "bad-status":
      return badRequest(decided.code);
    default:
      return { status: 409, json: { error: "conflict", detail: decided.code, reason: decided.reason } };
  }
};
