// server/src/testSupport/terraformDriftIo.ts
//
// Test support (never imported by production code): the `DriftIo` the certified-Terraform drift guards hand to
// `terraformDriftProblems` (aws/deploy/terraformDriftGuard.ts) -- local git only (never the network), the working tree,
// and `git diff --no-index` for the text diff (no external diff driver, no textconv). It lives outside aws/ so that
// COST-2C's rule (only hostcert/awsCliTransport.ts spawns a process under aws/) keeps holding.

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/* Structurally the `DriftIo` / `GitResult` of aws/deploy/terraformDriftGuard.ts. Declared here, not imported: only the
   operator CLI (tools/awsDeploy.ts) may import deployment tooling (L5-1 / L6-5A source guards); the guards pass this
   object to `terraformDriftProblems`, and the compiler checks the shapes agree there. */
interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
}
interface DriftIo {
  git(args: readonly string[]): GitResult;
  readWorking(rel: string): string | null;
  diffTexts(before: string | null, after: string | null): string | null;
}

const MAX_BUFFER = 256 * 1024 * 1024;

export function terraformDriftIo(repo: string): DriftIo {
  const run = (args: readonly string[], cwd?: string): GitResult => {
    const r = spawnSync("git", [...args], { cwd: cwd ?? repo, encoding: "utf8", maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
    return { status: r.error === undefined ? r.status : null, stdout: r.stdout ?? "" };
  };
  return {
    git: (args) => (fs.existsSync(repo) ? run(["-C", repo, ...args]) : { status: null, stdout: "" }),
    readWorking: (rel) => {
      const file = path.join(repo, rel);
      return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : null;
    },
    diffTexts: (before, after) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-drift-"));
      try {
        fs.writeFileSync(path.join(dir, "before"), before ?? "");
        fs.writeFileSync(path.join(dir, "after"), after ?? "");
        const r = run(["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=0", "before", "after"], dir);
        return r.status === 0 || r.status === 1 ? r.stdout : null;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
