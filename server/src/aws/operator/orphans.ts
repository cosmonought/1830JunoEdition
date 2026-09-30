// server/src/aws/operator/orphans.ts
//
// ==================================================================
//  LIVE-6 L6-2: THE RESTORE'S ORPHANS REPORT -- LEDGER EVIDENCE THE ADOPTED GAME TABLE CANNOT ACCOUNT FOR (READ-ONLY)
// ==================================================================
//
// `gamesDoctor aws orphans [--json]`. Preflight §17.2 step 7 (L6-4 §12.2 hands it here): after a game table was restored to
// T and adopted, money games created after T do not exist in it at all -- but the ledger (never restored) still holds what
// they signed and relayed. This report lists, exactly as the preflight words it:
//
//   SETTLE#<instance>   every ledger settlement-reservation instance that NO game of the table binds (a game's financial
//                       record, loaded by its own store: `binding.escrow` -> `escrowInstanceKey`);
//   ATTI#<intent>       every ledger relayer-attempt intent that NO game of the table holds (`GAME#<g>/INTENT#<id>`);
//   chain games         every chain game on the configured contracts the table does not bind -- NOT COVERED here: it
//                       needs an enumeration of the contract's games from the chain, which the operator tool does not
//                       read; it is reported as such, never as "none".
//
// Read-only by construction: a consistent ledger Scan (projection `pk` only, the two prefixes) and the game table's own
// readers. Nothing is deleted, repaired or held; every orphan is for the operator to review (those escrows end by the
// contract's own rules: refunds before Start, liveness or consent after it). The report also states the table's
// SYSTEM/GENERATION, so a report on a table that was never restored says so.

import { ScanCommand } from "@aws-sdk/client-dynamodb";

import { escrowInstanceKey } from "../../../../frontend/src/gameEngine/escrow/escrowModel";
import { deadline } from "../awsClients";
import { createDynamoFinancialStore } from "../game/dynamoFinancialStore";
import { gamePk, INTENT_PREFIX, queryAll, type Item } from "../game/gameTable";
import { readGenerationMarker } from "../game/generationMarker";
import { listGames, readAs } from "./inspect";
import type { OperatorTarget } from "./operatorTarget";

export interface OrphansReport {
  readonly generation: { readonly state: string; readonly origin: string | null; readonly restore_id: string | null; readonly restore_point: number | null };
  readonly games_read: number;
  readonly bound_instances: number;
  readonly intents_held: number;
  readonly settle_orphans: readonly string[];
  readonly attempt_orphans: readonly string[];
  readonly chain_games: { readonly status: "not-covered"; readonly detail: string };
  readonly problems: readonly string[];
}

/** Every distinct partition key of the ledger under the two prefixes (a paged, consistent Scan; `pk` only). */
async function ledgerPartitions(target: OperatorTarget): Promise<{ readonly settle: Set<string>; readonly atti: Set<string> }> {
  const settle = new Set<string>();
  const atti = new Set<string>();
  let start: Item | undefined;
  for (let page = 0; page < 100_000; page += 1) {
    const answer = await target.ledger.send(
      new ScanCommand({
        TableName: target.tables.ledger,
        ConsistentRead: true,
        ProjectionExpression: "#pk",
        FilterExpression: "begins_with(#pk, :s) OR begins_with(#pk, :a)",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":s": { S: "SETTLE#" }, ":a": { S: "ATTI#" } },
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      }),
      { abortSignal: deadline() },
    );
    for (const item of answer.Items ?? []) {
      const pk = item.pk?.S ?? "";
      if (pk.startsWith("SETTLE#")) settle.add(pk.slice("SETTLE#".length));
      else if (pk.startsWith("ATTI#")) atti.add(pk.slice("ATTI#".length));
    }
    start = answer.LastEvaluatedKey as Item | undefined;
    if (start === undefined) break;
  }
  return { settle, atti };
}

export async function orphansReport(target: OperatorTarget): Promise<OrphansReport> {
  const problems: string[] = [];
  const marker = await readAs(() => readGenerationMarker(target.app, target.tables.game));
  const generation = marker.state === "ok" ? { state: "ok", origin: marker.value.origin, restore_id: marker.value.restore_id, restore_point: marker.value.restore_point } : { state: marker.state, origin: null, restore_id: null, restore_point: null };
  if (marker.state === "ok" && marker.value.origin !== "restore") problems.push("this game table was never restored (SYSTEM/GENERATION origin bootstrap): every ledger entry should be accounted for; any orphan is a finding");
  const directory = await listGames(target);
  const money = await listGames(target, { money: true });
  problems.push(...directory.problems, ...money.problems);
  const ids = [...new Set([...directory.games, ...money.games].map((g) => g.game_id))].sort();
  const readOnly = { client: target.app, table: target.tables.game, fence: { pool: "op:read-only-inspection", epoch: 1 } };
  const instances = new Set<string>();
  const intents = new Set<string>();
  for (const gameId of ids) {
    const record = await readAs(() => createDynamoFinancialStore(readOnly).load(gameId));
    if (record.state === "ok") {
      const escrow = record.value.binding?.escrow ?? null;
      if (escrow !== null) instances.add(escrowInstanceKey(escrow));
    } else if (record.state !== "absent") problems.push(`${gameId}: its financial record ${record.state} (its instance is unknown: orphans below may be its own)`);
    try {
      for (const item of await queryAll(target.app, target.tables.game, gamePk(gameId))) {
        const sk = item.sk?.S ?? "";
        if (sk.startsWith(INTENT_PREFIX)) intents.add(sk.slice(INTENT_PREFIX.length));
      }
    } catch (error) {
      problems.push(`${gameId}: its items could not be read (${error instanceof Error ? error.name : "error"})`);
    }
  }
  let settle: string[] = [];
  let attempts: string[] = [];
  try {
    const ledger = await ledgerPartitions(target);
    settle = [...ledger.settle].filter((instance) => !instances.has(instance)).sort();
    attempts = [...ledger.atti].filter((intent) => !intents.has(intent)).sort();
  } catch (error) {
    problems.push(`the ledger could not be scanned (${error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "error"}): no orphan is reported, and none is excluded`);
  }
  return {
    generation,
    games_read: ids.length,
    bound_instances: instances.size,
    intents_held: intents.size,
    settle_orphans: settle,
    attempt_orphans: attempts,
    chain_games: { status: "not-covered", detail: "chain games on the configured contracts that the table does not bind need the contract's game enumeration from the chain; this read-only table/ledger report does not read the chain (preflight §17.2 step 7, its third list)" },
    problems,
  };
}
