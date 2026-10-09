// LUDUM v1 -- player history (Lane C): source guards over the whole `server/src/ludum/**` tree.
//
// §1.5 conflation hazard: the board's legacy pool field is not the escrow and must never feed a money figure. The name
// is assembled here so this file does not match itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const FORBIDDEN = ["total", "juno", "pool"].join("_");

/** `server/src/ludum`, found from the compiled test (`server/dist/server/src/ludum/history`) or the source tree. */
function ludumSourceDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "src", "ludum");
    if (existsSync(join(candidate, "registry.ts"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error("server/src/ludum not found");
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test(`no ${"total_…_pool"} anywhere in server/src/ludum/**`, () => {
  const files = filesUnder(ludumSourceDir()).filter((path) => /\.(ts|js|json)$/.test(path));
  assert.ok(files.some((path) => path.endsWith("ledger.ts")), "the scan reaches the history sources");
  const hits = files.filter((path) => readFileSync(path, "utf8").includes(FORBIDDEN));
  assert.deepEqual(hits, []);
});
