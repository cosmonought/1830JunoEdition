// frontend/src/routeOracle/harness/realLogs.ts
//
// ==================================================================
//  ROUTE v12 R12-1: REAL DECISION POINTS FROM THE OWNER-LOCAL LOGS (B-1), FIXTURE-STYLE
// ==================================================================
//
// TEST-ONLY, and OPTIONAL: the owner-local corpus (`server/data/JUNO-*.log.jsonl`, `frontend/sandbox-log-*.json`)
// is gitignored, so this loader reads a directory named by `ROUTE_ORACLE_CORPUS_DIR` and yields nothing when it
// is absent. Every `RunMultipleRoutes` in a log's EFFECTIVE history becomes one decision point:
//
//   - the board: the effective lays, stations and token remaps before it (`boardFromActions`), never a replay;
//   - the licences: the log's own purchases and JK grant before it;
//   - the fleet: the models the run itself names (`trains`); a run that names none is skipped;
//   - the era: the highest train model any run in the log has named so far (a Diesel exchange counts as a D),
//     mapped through the phase table (2 Yellow; 3-4 Green; 5, 6, 7, D Brown; D Gray under the 18XX+ tiles).
//     This is an INFERENCE, stated as one: both sides are handed the same era, so the comparison is exact for
//     that era, but the era is not proven to be the historical one.
//
// The historical run itself is carried too, so the oracle and the authority can both judge what was played.
// Positions are de-duplicated by a hash of everything the comparison reads. Legacy `RunManualRoute` logs (Y8V)
// name no train and are skipped.

import * as fs from "fs";
import * as path from "path";
import { effectiveActions } from "../../gameEngine/logRevert";
import type { TileColorTier } from "../../components/hexTileCatalog";
import { boardForVariants, boardFromActions, licencesFromLog, type CorpusBoard } from "./corpus";

export interface RealDecisionPoint {
  log: string;
  index: number;
  board: CorpusBoard;
  companyId: number;
  fleet: string[];
  submitted: { routes: Array<Array<{ hex: string; bypass?: boolean; city_node?: number }>>; trainIndices: number[] };
  hash: string;
}

const TIER_RANK = ["2", "3", "4", "5", "6", "7", "D"];

function eraFor(highest: string, plusTiles: boolean): TileColorTier {
  if (highest === "D" && plusTiles) return "Gray";
  if (highest === "2") return "Yellow";
  if (highest === "3" || highest === "4") return "Green";
  return "Brown";
}

function loadLog(file: string): Array<{ index: number; id: string; actor: string; payload: string; msg: Record<string, unknown> }> {
  const text = fs.readFileSync(file, "utf8");
  const raw: Array<Record<string, unknown>> = file.endsWith(".jsonl")
    ? text.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
    : ((JSON.parse(text) as { actions?: unknown[] }).actions as Array<Record<string, unknown>>);
  return raw.map((entry, at) => {
    const msg = (entry.msg as Record<string, unknown> | undefined) ?? (JSON.parse(entry.payload as string) as Record<string, unknown>);
    return {
      index: entry.index as number,
      id: (entry.id as string | undefined) ?? `dump-${String(entry.index ?? at)}`,
      actor: (entry.actor as string | null | undefined) ?? "",
      payload: (entry.payload as string | undefined) ?? JSON.stringify(msg),
      msg,
    };
  });
}

export function realDecisionPoints(dir: string | undefined): RealDecisionPoint[] {
  if (!dir || !fs.existsSync(dir)) return [];
  const files = [
    ...(fs.existsSync(path.join(dir, "server", "data")) ? fs.readdirSync(path.join(dir, "server", "data")).filter((n) => n.endsWith(".log.jsonl")).map((n) => path.join(dir, "server", "data", n)) : []),
    ...(fs.existsSync(path.join(dir, "frontend")) ? fs.readdirSync(path.join(dir, "frontend")).filter((n) => /^sandbox-log-.*\.json$/.test(n)).map((n) => path.join(dir, "frontend", n)) : []),
  ].sort();
  const out: RealDecisionPoint[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const live = effectiveActions(loadLog(file)).map((entry) => ({ index: entry.index, msg: entry.msg }));
    const setup = live.find((entry) => entry.msg.SetupGame)?.msg.SetupGame as { variants?: Record<string, unknown> } | undefined;
    const variants = setup?.variants ?? {};
    const board = boardForVariants(variants);
    let highest = "2";
    for (let at = 0; at < live.length; at += 1) {
      const msg = live[at].msg;
      const named: string[] = [];
      if (msg.RunMultipleRoutes) named.push(...(((msg.RunMultipleRoutes as { trains?: string[] }).trains ?? []) as string[]));
      if (msg.ExchangeTrainForDiesel) named.push("D");
      for (const model of named) if (TIER_RANK.indexOf(model) > TIER_RANK.indexOf(highest)) highest = model;
      if (!msg.RunMultipleRoutes) continue;
      const runMsg = msg.RunMultipleRoutes as { protocol_id: number; routes: RealDecisionPoint["submitted"]["routes"]; trains?: string[]; train_indices?: number[] };
      if (!runMsg.trains || runMsg.trains.length === 0) continue;
      const before = live.slice(0, at);
      const licences = licencesFromLog(before, Number.MAX_SAFE_INTEGER);
      const built = boardFromActions(before, board, licences);
      const era = eraFor(highest, variants.plusTiles === true);
      const fleet = [...runMsg.trains];
      const corpusBoard: CorpusBoard = {
        id: `${path.basename(file)}#${live[at].index}`,
        source: path.basename(file),
        board,
        variants,
        era,
        ...built,
        licenceNote: `licences from the log before ${live[at].index}`,
        notes: [
          ...built.notes,
          `era ${era} INFERRED from the highest model run so far (${highest}); the fleet is the run's own trains, not proven to be the whole fleet owned`,
        ],
      };
      const hash = JSON.stringify([board.id, era, runMsg.protocol_id, fleet, built.lays.map((l) => [l.q, l.r, l.tile_id, l.orientation]).sort(), built.companies]);
      if (seen.has(hash)) continue;
      seen.add(hash);
      out.push({
        log: path.basename(file),
        index: live[at].index,
        board: corpusBoard,
        companyId: runMsg.protocol_id,
        fleet,
        // The fleet IS the run's named models in route order, so route i runs on fleet slot i.
        submitted: { routes: runMsg.routes, trainIndices: runMsg.routes.map((_, i) => i) },
        hash,
      });
    }
  }
  return out;
}
