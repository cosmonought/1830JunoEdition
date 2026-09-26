/** @jest-environment node */
// frontend/src/utils/devIdentity.test.ts
//
// LIVE-2B (LIVE-2 §4.8 item 5): a production bundle contains no development claim. The claim parameter is named in
// exactly one source file, inside the one branch a production build folds away; this test pins that shape, and
// `scripts/scanDevIdentity.js` scans a built bundle for the string itself.

import * as fs from "fs";
import * as path from "path";

import { DEV_IDENTITY_BUILD, socketUrlFor } from "./devIdentity";

const SRC = path.resolve(__dirname, "..");
const NEEDLE = ["dev", "claim"].join("_");
const GUARD = 'if (process.env.REACT_APP_DEV_IDENTITY === "1") {';

function sources(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === "__fixtures__" || name === "node_modules") continue;
      sources(full, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(name) && !/\.test\.(ts|tsx|js|jsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("development identity is build-time only (LIVE-2B)", () => {
  it("outside a REACT_APP_DEV_IDENTITY=1 build the socket URL is untouched", () => {
    expect(process.env.REACT_APP_DEV_IDENTITY).toBeUndefined();
    expect(DEV_IDENTITY_BUILD).toBe(false);
    expect(socketUrlFor("wss://play.example/gs", "p-alice")).toBe("wss://play.example/gs");
  });

  it("the claim parameter is named in one source file only, and only inside the guarded branch", () => {
    const naming = sources(SRC).filter((file) => fs.readFileSync(file, "utf8").includes(NEEDLE));
    expect(naming.map((file) => path.relative(SRC, file).replace(/\\/g, "/"))).toEqual(["utils/devIdentity.ts"]);
    const text = fs.readFileSync(path.join(SRC, "utils", "devIdentity.ts"), "utf8");
    const guard = text.indexOf(GUARD);
    expect(guard).toBeGreaterThan(-1);
    const end = text.indexOf("\n  }\n", guard);
    const occurrences: number[] = [];
    for (let at = text.indexOf(NEEDLE); at !== -1; at = text.indexOf(NEEDLE, at + 1)) occurrences.push(at);
    expect(occurrences.length).toBeGreaterThan(0);
    for (const at of occurrences) {
      expect(at).toBeGreaterThan(guard);
      expect(at).toBeLessThan(end);
    }
  });

  it("the bundle scanner finds the string in a bundle that has it and passes one that does not", () => {
    const scanner = require("../../scripts/scanDevIdentity.js") as { findDevIdentity(dir: string): string[] };
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "devscan-"));
    try {
      fs.mkdirSync(path.join(dir, "static", "js"), { recursive: true });
      fs.writeFileSync(path.join(dir, "static", "js", "main.abc.js"), "var a=1;");
      expect(scanner.findDevIdentity(dir)).toEqual([]);
      fs.writeFileSync(path.join(dir, "static", "js", "main.def.js"), `var u="?${NEEDLE}="+x;`);
      expect(scanner.findDevIdentity(dir)).toEqual([path.join("static", "js", "main.def.js")]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
