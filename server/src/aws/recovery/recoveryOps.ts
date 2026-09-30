// server/src/aws/recovery/recoveryOps.ts
//
// ==================================================================
//  LIVE-6 L6-4: THE NARROW OPERATOR SURFACE OF A RESTORE -- PLAN FIRST, APPLY ONLY WHEN ASKED
// ==================================================================
//
// Exactly the operations the restore sequence needs (L6-4 report §3), each with a dry-run/plan form that writes NOTHING:
//
//   appgen-status        read only: APPGEN and every adoption ever made.
//   table-prepare        (plan | apply) the restored game table's SYSTEM/GENERATION, from the copied source marker.
//   appgen-adopt         (plan | apply) the ledger's APPGEN moved to the prepared generation -- the fence of every old task.
//   identity-status      read only: a restored identity table's restore marker and review records.
//   identity-replay      (plan | apply) the security journal replayed into a restored identity table.
//
// It is NOT a general operator tool: L6-3 owns `gamesDoctor` over DynamoDB, and may transplant these into its shell.
// Every answer is JSON with no secret: `assertPrintable` refuses any output that carries a recovery selector, a session or
// family id, or a field named like a key digest -- a last line of defence behind the modules, which never put one there.

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { planPreparation, prepareRestoredTable, readGenerationMarker, type PrepareRestoredTable } from "../game/generationMarker";
import { applyIdentityRestore, inspectIdentityRestore, planIdentityRestore, type IdentityRestoreDeps, type IdentityRestoreRequest } from "../identity/identityRestore";
import { adoptGeneration, listAdoptions, planAdoption, readAppGeneration, type AdoptionRequest, type MarkerCheck } from "../ledger/appGeneration";

export interface RecoveryClients {
  /** The app account: the game and identity tables. */
  readonly app: DynamoDBClient;
  /** The ledger (its table by name or full ARN). */
  readonly ledger: { readonly client: DynamoDBClient; readonly table: string };
}

/** The adoption's ordering rule: the target game table was PREPARED for exactly this adoption. */
export function preparedMarkerCheck(app: DynamoDBClient): MarkerCheck {
  return async (request: AdoptionRequest) => {
    const marker = await readGenerationMarker(app, request.gameTable);
    if (marker === null) return `${request.gameTable} carries no SYSTEM/GENERATION`;
    if (marker.origin !== "restore") return `${request.gameTable}'s marker is a ${marker.origin}, not a prepared restore`;
    if (marker.generation !== request.generation) return `${request.gameTable} is prepared for generation ${marker.generation}, not ${request.generation}`;
    if (marker.game_table !== request.gameTable) return `${request.gameTable}'s marker names ${marker.game_table}`;
    if (marker.restored_from_generation !== request.expected) return `${request.gameTable} was restored from generation ${marker.restored_from_generation}, not the expected ${request.expected}`;
    if (marker.restore_id !== request.restoreId) return `${request.gameTable} was prepared by restore ${marker.restore_id}, not ${request.restoreId}`;
    return null;
  };
}

export async function appgenStatus(clients: RecoveryClients) {
  return { appgen: await readAppGeneration(clients.ledger.client, clients.ledger.table), adoptions: await listAdoptions(clients.ledger.client, clients.ledger.table) };
}

export async function tablePrepare(clients: RecoveryClients, request: PrepareRestoredTable, apply: boolean) {
  return apply ? prepareRestoredTable(clients.app, request.gameTable, request) : planPreparation(clients.app, request.gameTable, request);
}

/** `stopped`: the operator's statement that every task of every pool was stopped and verified stopped (preflight §17.2
 *  step 1). The adoption fences any straggler anyway (every ledger write, every self-check); the statement is recorded
 *  in the answer and required for `apply`. */
export async function appgenAdopt(clients: RecoveryClients, request: AdoptionRequest, options: { readonly apply: boolean; readonly stopped: boolean; readonly now: () => number; readonly sleep?: (ms: number) => Promise<void> }) {
  const check = preparedMarkerCheck(clients.app);
  if (!options.apply) return { ...(await planAdoption(clients.ledger.client, clients.ledger.table, request, check)), stopped_attested: options.stopped };
  if (!options.stopped) return { kind: "refused" as const, detail: "an adoption is applied only after every task was stopped and verified stopped (--stopped); nothing was read or written", stopped_attested: false };
  return { ...(await adoptGeneration(clients.ledger.client, clients.ledger.table, request, check, { now: options.now, ...(options.sleep !== undefined ? { sleep: options.sleep } : {}) })), stopped_attested: true };
}

export async function identityStatus(clients: RecoveryClients, table: string) {
  const status = await inspectIdentityRestore(clients.app, table);
  return {
    table,
    serving: status.serving,
    role_epoch: status.role_epoch,
    marker: status.marker,
    reviews: status.reviews.map((review) => ({ ...review, unconfirmed_events: JSON.parse(review.unconfirmed_events) as string[], confirmed_events: JSON.parse(review.confirmed_events) as string[] })),
  };
}

export async function identityReplay(clients: RecoveryClients, request: IdentityRestoreRequest, options: { readonly apply: boolean; readonly now: () => number; readonly sleep?: (ms: number) => Promise<void> }) {
  const deps: IdentityRestoreDeps = { client: clients.app, ledger: clients.ledger, now: options.now, ...(options.sleep !== undefined ? { sleep: options.sleep } : {}) };
  return options.apply ? applyIdentityRestore(deps, request) : planIdentityRestore(deps, request);
}

/** Refuse to print anything that looks like a credential or a key's lookup handle (never expected: a last defence). */
export function assertPrintable(text: string): string {
  const problems: string[] = [];
  if (/\brk_[0-9a-z]{26}\b/.test(text)) problems.push("a recovery selector");
  if (/\bse_[0-9a-z]{26}\b/.test(text)) problems.push("a session id");
  if (/\bsf_[0-9a-z]{26}\b/.test(text)) problems.push("a session family id");
  if (/"(recovery_hash|secret_hash|secret|link_hash|from_selector|to_selector|recovery_selector)"/.test(text)) problems.push("a key or secret field");
  if (problems.length > 0) throw new Error(`recovery output refused: it would print ${problems.join(", ")}`);
  return text;
}
