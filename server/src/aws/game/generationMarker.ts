// server/src/aws/game/generationMarker.ts
//
// ==================================================================
//  LIVE-6 L6-4: `SYSTEM/GENERATION` -- WHICH APP GENERATION A GAME TABLE HOLDS (preflight §3.2, §13 step 1, §17.2)
// ==================================================================
//
// The game table's restore domain is the APP GENERATION: a point-in-time restore always lands in a NEW table, and that
// table becomes the next generation only when the ledger ADOPTS it (`APPGEN`, `aws/ledger/appGeneration.ts`). This item is
// the game table's own statement of the generation its data belongs to, so that a task can never combine restored game
// data of one generation with signing authority (APPGEN) of another, or run for a third:
//
//   SYSTEM / GENERATION   { fmt 1, generation N, game_table <its own name>, origin "bootstrap" | "restore",
//                           restored_from_generation, restored_from_table, restore_point, restore_id   (NULL for a bootstrap)
//                           prepared_at, prepared_by, claim }
//
// THE RULE (the startup, `awsRuntime.ts` step 1, before the pool is taken): the ledger's APPGEN, the runtime document's
// `generation` and this item's `generation` are ONE number, and this item names the document's `game_table`. Any
// difference, an absent item or one this build cannot read refuses the start (exit 2): nothing falls back, and no task
// "follows" a generation it merely read.
//
// WHO WRITES IT (never a serving task: a task only reads it):
//   - the first deployment's bootstrap (L5-8) writes `origin: "bootstrap"` for generation N into the first game table
//     (`bootstrapGenerationMarker` is the exact item; create-if-absent);
//   - the restore procedure's PREPARATION (L6-4, `prepareRestoredTable`) rewrites the marker that the point-in-time copy
//     carried over from its source (it says the SOURCE's generation and table) into `origin: "restore"` for the new
//     generation -- a compare-and-swap on exactly the copied item, so it runs only on a true copy of the named source.
//     It is written BEFORE the ledger adopts the generation: until then no task can start on the new table (APPGEN still
//     names the old generation), and once APPGEN moves, no task can start on the old one.
//
// `origin: "restore"` is also the marker a later post-restore mode reads (money games read-only until their F1 check has
// passed, preflight §13 step 8) -- not implemented in L6-4.

import { randomUUID } from "crypto";
import { PutItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { getItem, key, N, S, type Item } from "./gameTable";

export const GENERATION_KEY: Item = key("SYSTEM", "GENERATION");
export const GENERATION_MARKER_FORMAT = 1;

const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
/** An operator run's name (a restore id): lower-case letters, digits and dashes, 3-64 characters. */
export const RESTORE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const TEXT = /^[\x21-\x7e]{1,128}$/;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface GenerationMarker {
  readonly generation: number;
  readonly game_table: string;
  readonly origin: "bootstrap" | "restore";
  /** A restore's source: the generation and table it was restored from, the restore point (ms) and the operator run. */
  readonly restored_from_generation: number | null;
  readonly restored_from_table: string | null;
  readonly restore_point: number | null;
  readonly restore_id: string | null;
  readonly prepared_at: number;
  readonly prepared_by: string;
  /** The token of the write that set this item (how a lost answer is settled, and what the next CAS names). */
  readonly claim: string;
}

export class GenerationMarkerUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationMarkerUnreadableError";
  }
}

const ATTRIBUTES = "claim,fmt,game_table,generation,origin,pk,prepared_at,prepared_by,restore_id,restore_point,restored_from_generation,restored_from_table,sk";

const intOf = (value: Item[string] | undefined, min: number): number | null => {
  const text = value?.N;
  if (text === undefined || !/^(0|[1-9][0-9]{0,15})$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= min ? number : null;
};
const isNull = (value: Item[string] | undefined): boolean => value !== undefined && (value as { NULL?: boolean }).NULL === true;

/** The marker, strictly: every attribute present with its type, nothing else, this build's format. */
export function parseGenerationMarker(item: Item): GenerationMarker {
  const names = Object.keys(item)
    .filter((name) => item[name] !== undefined)
    .sort()
    .join(",");
  const fmt = intOf(item.fmt, 1);
  if (fmt !== null && fmt > GENERATION_MARKER_FORMAT) throw new GenerationMarkerUnreadableError(`the game table's SYSTEM/GENERATION is format ${fmt}, written by a newer build: never read or overwritten here`);
  if (names !== ATTRIBUTES) throw new GenerationMarkerUnreadableError(`the game table's SYSTEM/GENERATION has the attributes [${names}], not this build's`);
  if (item.pk?.S !== "SYSTEM" || item.sk?.S !== "GENERATION" || fmt !== GENERATION_MARKER_FORMAT) throw new GenerationMarkerUnreadableError("the game table's SYSTEM/GENERATION is not this build's item");
  const generation = intOf(item.generation, 1);
  const table = item.game_table?.S;
  const origin = item.origin?.S;
  const at = intOf(item.prepared_at, 0);
  const by = item.prepared_by?.S;
  const claim = item.claim?.S;
  if (generation === null || table === undefined || !TABLE_NAME.test(table) || at === null || by === undefined || !TEXT.test(by) || claim === undefined || !TOKEN.test(claim)) {
    throw new GenerationMarkerUnreadableError("the game table's SYSTEM/GENERATION is damaged (a required field is not well-formed)");
  }
  if (origin === "bootstrap") {
    if (!["restored_from_generation", "restored_from_table", "restore_point", "restore_id"].every((name) => isNull(item[name]))) {
      throw new GenerationMarkerUnreadableError("the game table's SYSTEM/GENERATION says bootstrap but names a restore");
    }
    return { generation, game_table: table, origin, restored_from_generation: null, restored_from_table: null, restore_point: null, restore_id: null, prepared_at: at, prepared_by: by, claim };
  }
  if (origin !== "restore") throw new GenerationMarkerUnreadableError("the game table's SYSTEM/GENERATION has no known origin");
  const from = intOf(item.restored_from_generation, 1);
  const fromTable = item.restored_from_table?.S;
  const point = intOf(item.restore_point, 0);
  const restoreId = item.restore_id?.S;
  if (from === null || from >= generation || fromTable === undefined || !TABLE_NAME.test(fromTable) || fromTable === table || point === null || restoreId === undefined || !RESTORE_ID_PATTERN.test(restoreId)) {
    throw new GenerationMarkerUnreadableError("the game table's SYSTEM/GENERATION names a restore that is not well-formed");
  }
  return { generation, game_table: table, origin, restored_from_generation: from, restored_from_table: fromTable, restore_point: point, restore_id: restoreId, prepared_at: at, prepared_by: by, claim };
}

export function generationMarkerItem(marker: GenerationMarker): Item {
  const nullable = (value: string | number | null, type: "S" | "N") => (value === null ? ({ NULL: true } as Item[string]) : type === "S" ? S(String(value)) : N(value as number));
  return {
    ...GENERATION_KEY,
    fmt: N(GENERATION_MARKER_FORMAT),
    generation: N(marker.generation),
    game_table: S(marker.game_table),
    origin: S(marker.origin),
    restored_from_generation: nullable(marker.restored_from_generation, "N"),
    restored_from_table: nullable(marker.restored_from_table, "S"),
    restore_point: nullable(marker.restore_point, "N"),
    restore_id: nullable(marker.restore_id, "S"),
    prepared_at: N(marker.prepared_at),
    prepared_by: S(marker.prepared_by),
    claim: S(marker.claim),
  };
}

/** The marker the game table holds (strongly consistent), `null` when there is none. Throws
 *  `GenerationMarkerUnreadableError` for an item this build cannot read (never read as some generation). */
export async function readGenerationMarker(client: DynamoDBClient, table: string): Promise<GenerationMarker | null> {
  const item = await getItem(client, table, GENERATION_KEY);
  return item === null ? null : parseGenerationMarker(item);
}

/** L5-8's first-deployment item (a create-if-absent Put of it, `attribute_not_exists(pk)`): generation N, bootstrap. */
export function bootstrapGenerationMarker(input: { readonly generation: number; readonly gameTable: string; readonly by: string; readonly now: number }): GenerationMarker {
  const marker: GenerationMarker = {
    generation: input.generation,
    game_table: input.gameTable,
    origin: "bootstrap",
    restored_from_generation: null,
    restored_from_table: null,
    restore_point: null,
    restore_id: null,
    prepared_at: input.now,
    prepared_by: input.by,
    claim: randomUUID(),
  };
  parseGenerationMarker(generationMarkerItem(marker)); // the exact item this build reads back, or throw now
  return marker;
}

/** Why the marker does not allow a task configured for (`generation`, `gameTable`) to start (`null`: it does). */
export function generationMarkerProblem(marker: GenerationMarker | null, expected: { readonly generation: number; readonly gameTable: string }): string | null {
  if (marker === null) return "the game table carries no generation marker (SYSTEM/GENERATION): the first deployment's bootstrap (L5-8) or a restore's preparation (L6-4) writes it";
  if (marker.generation !== expected.generation) return `the game table holds app generation ${marker.generation}, not this task's ${expected.generation}`;
  if (marker.game_table !== expected.gameTable) return `the game table's generation marker names the table ${marker.game_table}, not this task's ${expected.gameTable}`;
  return null;
}

/** What APPGEN says about the adoption of its current generation (`null`: the bootstrap item, never adopted). */
export interface AdoptionBinding {
  readonly game_table: string;
  readonly restore_id: string;
}

/**
 * Why APPGEN's adoption does not bind THIS marker's table (`null`: it does). The numbers alone are not enough: several
 * copies of one source can each be prepared as generation M, and only the one the ledger ADOPTED may serve it -- so a
 * restored table serves only when APPGEN's adoption names it (and the same restore); a bootstrap table only while APPGEN
 * was never adopted (review F1).
 */
export function adoptionBindingProblem(marker: GenerationMarker, binding: AdoptionBinding | null): string | null {
  if (marker.origin === "bootstrap") {
    return binding === null ? null : `the ledger's APPGEN adopted ${binding.game_table} (restore ${binding.restore_id}), but this table is a bootstrap table: it is not the adopted one`;
  }
  if (binding === null) return "this table is a prepared restore, but the ledger's APPGEN was never adopted (it is still the bootstrap's)";
  if (binding.game_table !== marker.game_table || binding.restore_id !== marker.restore_id) {
    return `the ledger's APPGEN adopted ${binding.game_table} (restore ${binding.restore_id}), not this table (${marker.game_table}, restore ${marker.restore_id}): only the adopted copy of a generation serves it`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The restore's preparation                                           */
/* ------------------------------------------------------------------ */

export interface PrepareRestoredTable {
  /** The restored (new) table, as the runtime document will name it. */
  readonly gameTable: string;
  /** The generation it is being prepared to become (it must be adopted by the ledger AFTER this). */
  readonly generation: number;
  /** The source the point-in-time copy was made from: its generation and table (the marker the copy carried). */
  readonly restoredFrom: { readonly generation: number; readonly table: string };
  readonly restorePoint: number;
  readonly restoreId: string;
  readonly by: string;
  readonly now: number;
}

export type PrepareOutcome =
  | { readonly kind: "prepared"; readonly marker: GenerationMarker }
  /** This exact preparation was completed before (a re-run): nothing written. */
  | { readonly kind: "already-prepared"; readonly marker: GenerationMarker }
  /** The table is not a copy of the named source, or it was prepared for something else: nothing written. */
  | { readonly kind: "refused"; readonly detail: string; readonly current: GenerationMarker | null }
  /** The write's outcome could not be established: ask again with the same request (it can never apply twice). */
  | { readonly kind: "unknown"; readonly detail: string };

export function preparationProblem(request: PrepareRestoredTable): string | null {
  if (!TABLE_NAME.test(request.gameTable) || !TABLE_NAME.test(request.restoredFrom.table)) return "the tables must be DynamoDB table names";
  if (request.gameTable === request.restoredFrom.table) return "the restored table must be a NEW table (a point-in-time restore never writes over its source)";
  for (const [name, value, min] of [["generation", request.generation, 1], ["the source generation", request.restoredFrom.generation, 1], ["the restore point", request.restorePoint, 0], ["the time", request.now, 0]] as const) {
    if (!Number.isSafeInteger(value) || value < min) return `${name} must be a whole number (>= ${min})`;
  }
  if (request.generation <= request.restoredFrom.generation) return `generation ${request.generation} does not move forward from the source's ${request.restoredFrom.generation}: a restored table is always a NEW, higher generation`;
  if (!RESTORE_ID_PATTERN.test(request.restoreId)) return "the restore id must be 3-64 lower-case letters, digits or dashes";
  if (!TEXT.test(request.by)) return "`by` must be 1-128 printable characters without spaces";
  return null;
}

const samePreparation = (marker: GenerationMarker, request: PrepareRestoredTable): boolean =>
  marker.origin === "restore" &&
  marker.generation === request.generation &&
  marker.game_table === request.gameTable &&
  marker.restored_from_generation === request.restoredFrom.generation &&
  marker.restored_from_table === request.restoredFrom.table &&
  marker.restore_point === request.restorePoint &&
  marker.restore_id === request.restoreId;

/** What `prepareRestoredTable` would do, read only (the dry run): `ready` (the copied source marker is there), or the
 *  answer it would give without writing. */
export async function planPreparation(client: DynamoDBClient, table: string, request: PrepareRestoredTable): Promise<{ readonly kind: "ready"; readonly current: GenerationMarker } | Exclude<PrepareOutcome, { kind: "prepared" } | { kind: "unknown" }>> {
  /* The table written IS the one the marker names (never the source's or any other table's marker; review F5). */
  const problem = table !== request.gameTable ? `the table to prepare (${table}) is not the request's game table (${request.gameTable})` : preparationProblem(request);
  if (problem !== null) return { kind: "refused", detail: problem, current: null };
  const current = await readGenerationMarker(client, table);
  if (current === null) return { kind: "refused", detail: "the restored table carries no generation marker: it is not a point-in-time copy of a marked game table", current };
  if (samePreparation(current, request)) return { kind: "already-prepared", marker: current };
  if (current.generation !== request.restoredFrom.generation || current.game_table !== request.restoredFrom.table) {
    return {
      kind: "refused",
      detail: `the table's marker says generation ${current.generation} of ${current.game_table} (${current.origin}${current.restore_id !== null ? ` ${current.restore_id}` : ""}), not the named source (generation ${request.restoredFrom.generation} of ${request.restoredFrom.table}): it is not a copy of that source, or it was prepared already for another restore`,
      current,
    };
  }
  return { kind: "ready", current };
}

/**
 * Prepare a restored game table to become generation `request.generation`: a compare-and-swap of its marker from exactly
 * the source's (as the point-in-time copy carried it over) to this restore's. Idempotent for the same request; refuses
 * anything else. Never touches the source table, the ledger, or any other item.
 */
export async function prepareRestoredTable(client: DynamoDBClient, table: string, request: PrepareRestoredTable): Promise<PrepareOutcome> {
  const planned = await planPreparation(client, table, request);
  if (planned.kind !== "ready") return planned;
  const read = planned.current;
  const marker: GenerationMarker = {
    generation: request.generation,
    game_table: request.gameTable,
    origin: "restore",
    restored_from_generation: request.restoredFrom.generation,
    restored_from_table: request.restoredFrom.table,
    restore_point: request.restorePoint,
    restore_id: request.restoreId,
    prepared_at: request.now,
    prepared_by: request.by,
    claim: randomUUID(),
  };
  parseGenerationMarker(generationMarkerItem(marker));
  let failure: unknown = null;
  try {
    await client.send(
      new PutItemCommand({
        TableName: table,
        Item: generationMarkerItem(marker),
        ConditionExpression: "#fmt = :fmt AND #g = :g AND #t = :t AND #claim = :claim",
        ExpressionAttributeNames: { "#fmt": "fmt", "#g": "generation", "#t": "game_table", "#claim": "claim" },
        ExpressionAttributeValues: { ":fmt": N(GENERATION_MARKER_FORMAT), ":g": N(read.generation), ":t": S(read.game_table), ":claim": S(read.claim) },
      }),
      { abortSignal: deadline() },
    );
    return { kind: "prepared", marker };
  } catch (error) {
    failure = error;
  }
  /* Refused by its condition, or unknown: the item as it stands decides -- never the error alone. */
  let after: GenerationMarker | null;
  try {
    after = await readGenerationMarker(client, table);
  } catch (error) {
    return { kind: "unknown", detail: `the preparation's outcome is unknown and the marker could not be read back (${error instanceof Error ? error.message : String(error)})` };
  }
  if (after !== null && after.claim === marker.claim) return { kind: "prepared", marker: after };
  if (after !== null && samePreparation(after, request)) return { kind: "already-prepared", marker: after };
  if (after === null || after.claim !== read.claim) return { kind: "refused", detail: "the marker changed while this preparation ran; nothing of it was written", current: after };
  return { kind: "unknown", detail: `the marker did not move and the outcome is not known (${failure instanceof Error ? failure.name : String(failure)}); ask again with the same request` };
}
