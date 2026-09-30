// server/src/ingress/readiness.ts
//
// ==================================================================
//  LIVE-5 L5-7: `/gs/readyz` -- WHETHER THIS TASK MAY BE SENT PLAYERS, NOT WHETHER ITS HTTP IS ALIVE
// ==================================================================
//
// Preflight §13: two health endpoints.
//   /gs/healthz  LIVENESS, unchanged (`identity/httpApi.ts`): 200 "ok" while the process answers at all -- the container
//                health check. It never looks at ownership: a task that cannot read DynamoDB for a while is not dead.
//   /gs/readyz   READINESS (AWS storage mode only; PROCESS mode has no such route, exactly as before): 200 only while the
//                runtime says this task may serve -- its pool writer current and freshly checked, its roles held, its
//                startup (identity, discovery, the first money claim sweep) done, and not shutting down. Otherwise 503
//                with the REASONS, as fixed codes. The load balancer's target health check.
//
// THE BODY IS PUBLIC. `/gs*` is routed through the edge to this server, so anyone can read `/gs/readyz`: it carries only
// fixed reason codes, the pool id, its epoch and the role and escrow states -- never an error text, an ARN, a table name,
// an account or a principal (those go to the task's own log lines, which only operators read).

import type { IncomingMessage, ServerResponse } from "http";

export const READY_PATH = "/gs/readyz";

/** What `/gs/readyz` answers. `reasons` is empty exactly when `ready`. Every value is a fixed code or an id. */
export interface ReadinessAnswer {
  readonly ready: boolean;
  readonly reasons: readonly string[];
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

const HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

/** Answer `/gs/readyz` when that is the path (true: handled). GET and HEAD only. */
export function handleReadiness(request: IncomingMessage, response: ServerResponse, readiness: () => ReadinessAnswer): boolean {
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return false;
  }
  if (pathname !== READY_PATH) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { ...HEADERS, Allow: "GET, HEAD" });
    response.end(request.method === "HEAD" ? undefined : `${JSON.stringify({ error: "method-not-allowed" })}\n`);
    return true;
  }
  let answer: ReadinessAnswer;
  try {
    answer = readiness();
  } catch {
    /* A readiness function that throws cannot vouch for anything. */
    answer = { ready: false, reasons: ["readiness-unknown"], detail: {} };
  }
  const body = { ready: answer.ready, reasons: [...answer.reasons], ...answer.detail };
  response.writeHead(answer.ready ? 200 : 503, HEADERS);
  response.end(request.method === "HEAD" ? undefined : `${JSON.stringify(body)}\n`);
  return true;
}

/* LIVE-6 L6-1: L5-7's standby server (every upgrade refused) is gone -- a non-primary task now runs `routerServer.ts`,
   which answers `/gs/readyz` through `handleReadiness` above. */
