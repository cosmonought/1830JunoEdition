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
    expect(socketUrlFor("wss://play.example/gs")).toBe("wss://play.example/gs");
    expect(socketUrlFor("wss://play.example/gs?x=1")).toBe("wss://play.example/gs?x=1");
  });

  it("LIVE-2D: the claim is the tab's development principal, minted only inside the guarded branch", () => {
    /* The claim used to be this tab's client-minted `p-…` player id, which was also its seat. Seats are the
       server's now (`RoomView.you.playerId`): `socketUrlFor` takes no claim argument, and the only place a tab
       principal is read or minted is the dev-guarded branch -- a production build never stores one. */
    expect(socketUrlFor.length).toBe(1);
    const text = fs.readFileSync(path.join(SRC, "utils", "devIdentity.ts"), "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const guard = code.indexOf(GUARD);
    const end = code.indexOf("\n  }\n", guard);
    /* A CALL, not the declaration (`function tabPrincipal(): string`). */
    const calls = Array.from(code.matchAll(/tabPrincipal\(\)(?!\s*:)/g), (match) => match.index ?? -1);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBeGreaterThan(guard);
    expect(calls[0]).toBeLessThan(end);
    /* Per TAB, not per browser: two tabs are two principals, and nothing outlives the tab. */
    expect(code).toContain("window.sessionStorage");
    expect(code).not.toContain("localStorage");
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

  /* LIVE-2E: the LIVE-2D owner gate found the development branch's TEXT in `main.*.js.map` after the minifier had
     deleted the code. Production maps are off for good (`.env.production`), `npm run build` runs the scan, and a map
     in the bundle fails it whatever the map contains. */
  it("production builds carry no source maps: .env.production turns them off, and the build script itself scans every build", () => {
    const envProduction = fs.readFileSync(path.join(__dirname, "..", "..", ".env.production"), "utf8");
    expect(envProduction).toMatch(/^GENERATE_SOURCEMAP=false$/m);
    expect(envProduction).not.toMatch(/REACT_APP_DEV_IDENTITY/);
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
    /* LIVE-2E review L4: part of `build` itself, not a `postbuild` hook that `--ignore-scripts` (or a platform calling
       react-app-rewired directly through npm) would skip. */
    expect(pkg.scripts.build).toBe("react-app-rewired build && node scripts/scanDevIdentity.js");
    expect(pkg.scripts.postbuild).toBeUndefined();
  });

  it("the bundle scanner reports every source map, clean or not", () => {
    const scanner = require("../../scripts/scanDevIdentity.js") as { findSourceMaps(dir: string): string[] };
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "mapscan-"));
    try {
      fs.mkdirSync(path.join(dir, "static", "js"), { recursive: true });
      fs.writeFileSync(path.join(dir, "static", "js", "main.abc.js"), "var a=1;");
      expect(scanner.findSourceMaps(dir)).toEqual([]);
      fs.writeFileSync(path.join(dir, "static", "js", "main.abc.js.map"), "{}");
      expect(scanner.findSourceMaps(dir)).toEqual([path.join("static", "js", "main.abc.js.map")]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
