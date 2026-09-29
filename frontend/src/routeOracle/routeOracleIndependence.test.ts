/** @jest-environment node */
//
// ==================================================================
//  ROUTE v12 R12-1: THE ORACLE STAYS INDEPENDENT (STRUCTURAL GUARD)
// ==================================================================
//
// A SOURCE GUARD, not behavioural evidence (the preflight's evidence class P). It keeps the two directions of
// the independence rule mechanical:
//
//   1. The ORACLE CORE (`index.ts`, `oracle*.ts`) imports nothing from production at run time. It may import
//      TYPES from production (`import type`, erased), and its own files. Board data and the tile catalog reach
//      it as ARGUMENTS, so it never reads the module-global "board in effect" either.
//   2. No production file imports this directory. Only the R12-1 tests and the harness do.
//
// The harness (`harness/`) is exempt from (1) by design: it is where production is asked the same question.

import * as fs from "fs";
import * as path from "path";

const ORACLE_DIR = __dirname;
const SRC_DIR = path.join(__dirname, "..");

const coreFiles = fs
  .readdirSync(ORACLE_DIR)
  .filter((name) => /^(index|oracle[A-Za-z]*)\.ts$/.test(name))
  .map((name) => path.join(ORACLE_DIR, name));

function importsOf(file: string): Array<{ typeOnly: boolean; from: string }> {
  const text = fs.readFileSync(file, "utf8");
  const out: Array<{ typeOnly: boolean; from: string }> = [];
  const pattern = /^\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gms;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) out.push({ typeOnly: match[2] !== undefined, from: match[3] });
  if (/\brequire\s*\(/.test(text)) out.push({ typeOnly: false, from: "require(...)" });
  if (/\bimport\s*\(/.test(text)) out.push({ typeOnly: false, from: "import(...)" });
  return out;
}

describe("the route oracle's independence", () => {
  it("has the core files it claims", () => {
    expect(coreFiles.map((file) => path.basename(file)).sort()).toEqual([
      "index.ts",
      "oracleGraph.ts",
      "oracleJudge.ts",
      "oracleManifest.ts",
      "oracleOptimum.ts",
      "oracleRoutes.ts",
    ]);
  });

  it("the core imports production only as erased types; everything else is its own", () => {
    const offending = coreFiles.flatMap((file) =>
      importsOf(file)
        .filter((entry) => !entry.from.startsWith("./") && !entry.typeOnly)
        .map((entry) => `${path.basename(file)} imports ${entry.from}`),
    );
    expect(offending).toEqual([]);
  });

  it("the core never names a production route helper or the board in effect", () => {
    const forbidden = [
      "traversalsFrom", "neighbourAcross", "liveEdgesForHex", "cityForArrival", "stopForArrival", "archetypeForHex",
      "citySlotCount", "hexValueForEra", "isOffboardTerminal", "sandboxRouteBreakdown", "evaluateRouteSet",
      "assignRouteSet", "candidateRoutes", "maxRouteRevenueFor", "cityBlockerFor", "STATIC_BOARD_HEXES",
      "boardInEffect", "GRAY_HEXES", "OFFBOARD_LABELS", "HEX_NEIGHBOR_OFFSETS", "MOCK_TRAIN_CATALOG",
      "tileCitySlotCounts",
    ];
    const hits = coreFiles.flatMap((file) => {
      const text = fs.readFileSync(file, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      return forbidden.filter((name) => new RegExp(`\\b${name}\\b`).test(text)).map((name) => `${path.basename(file)}: ${name}`);
    });
    expect(hits).toEqual([]);
  });

  it("no production file imports the oracle", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full === ORACLE_DIR || entry.name === "node_modules" || entry.name.startsWith("__fixtures__")) continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          if (/from\s+["'][^"']*routeOracle[^"']*["']/.test(text)) offenders.push(path.relative(SRC_DIR, full));
        }
      }
    };
    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });
});
