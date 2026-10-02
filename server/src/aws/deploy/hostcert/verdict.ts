// server/src/aws/deploy/hostcert/verdict.ts
//
// COST-2C: the host certification's ONE verdict law.
//
//   A check is `pass`, `fail` or `not-evaluated`. A check whose read failed, whose answer was truncated, or whose
//   observation is incomplete or ambiguous is NOT EVALUATED -- never `pass`. A check that READ something wrong is `fail`.
//
//   The scenario's verdict:   FAIL           if any check of any phase failed (a failed CLEANUP is always a FAIL);
//                             NOT EVALUATED  else, if any check was not evaluated, or there is no check at all;
//                             PASS           only if every check of every phase passed.
//   A run whose PRECHECK did not pass is REFUSED: nothing was mutated; its verdict is NOT EVALUATED (`refused: true`).

export type CertStatus = "pass" | "fail" | "not-evaluated";
export type Verdict = "PASS" | "FAIL" | "NOT EVALUATED";

export interface CertCheck {
  readonly name: string;
  readonly status: CertStatus;
  readonly detail: string;
}

export const passed = (name: string, detail: string): CertCheck => ({ name, status: "pass", detail });
export const failed = (name: string, detail: string): CertCheck => ({ name, status: "fail", detail });
export const unknown = (name: string, detail: string): CertCheck => ({ name, status: "not-evaluated", detail });
/** `ok` true: pass; false: fail. (An unread value is never judged here: say `unknown` instead.) */
export const decide = (name: string, ok: boolean, good: string, bad: string): CertCheck => (ok ? passed(name, good) : failed(name, bad));

export function verdictOf(checks: readonly CertCheck[]): Verdict {
  if (checks.some((c) => c.status === "fail")) return "FAIL";
  if (checks.length === 0 || checks.some((c) => c.status !== "pass")) return "NOT EVALUATED";
  return "PASS";
}

/** The real-AL2023 contract's words when the evidence did not come from the real host. */
export const REQUIRES_REAL_AL2023 = "NOT EVALUATED / REQUIRES REAL AL2023";

export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_EVALUATED = 3;
export const EXIT_REFUSED = 4;
