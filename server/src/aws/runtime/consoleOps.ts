// server/src/aws/runtime/consoleOps.ts
//
// ==================================================================
//  LIVE-5 L5-7: THE OPERATOR'S AUDIT LINES OF AN AWS TASK -- ON STDOUT, FOR CLOUDWATCH LOGS
// ==================================================================
//
// PROCESS mode writes `ops/audit.jsonl` and `ops/status.json` beside the games (`persistence/opsRecorder.ts`). An AWS task
// has no data directory: its audit lines go to stdout, one JSON object per line prefixed `AUDIT `, which the awslogs
// driver ships to CloudWatch Logs, where L6-5's metric filters match the SAME event names the file recorder writes (no
// event is renamed). The same redaction applies (`redactIdentity`: no principal, profile, session or selector id ever
// leaves the process on this path either).
//
// The status snapshot is kept in memory (the latest one) and is not printed: it is large, coalesced and rewritten
// constantly; the readiness endpoint and the startup lines carry what an operator needs now. LIVE-6 L6-5A publishes the
// diagnosis-sized part of it instead: the metric lines (`runtimeMetrics.ts`, CloudWatch EMF, separate lines -- an `AUDIT `
// line is never a metric line) and the task's `TASK#` status item (`taskStatus.ts`, preflight §3.2).

import { redactIdentity, type OpsRecorder } from "../../persistence/opsRecorder";

export interface ConsoleOpsRecorder extends OpsRecorder {
  /** The latest status snapshot (redacted), or null. */
  latestStatus(): Record<string, unknown> | null;
}

export function createConsoleOpsRecorder(options: { readonly build: string; readonly task: string; readonly pool: string; readonly now: () => number; readonly write: (line: string) => void }): ConsoleOpsRecorder {
  let latest: Record<string, unknown> | null = null;
  return {
    audit(event, fields = {}) {
      try {
        const line = redactIdentity({ at: options.now(), event, ...fields, build: options.build, task: options.task, pool: options.pool });
        options.write(`AUDIT ${JSON.stringify(line)}`);
      } catch {
        /* an audit line never stops the work it describes */
      }
    },
    status(snapshot) {
      try {
        latest = redactIdentity(snapshot);
      } catch {
        /* best effort */
      }
    },
    flush: async () => undefined,
    latestStatus: () => latest,
  };
}
