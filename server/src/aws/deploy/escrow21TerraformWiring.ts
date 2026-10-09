// server/src/aws/deploy/escrow21TerraformWiring.ts
//
// PHASE 3 ESCROW 2.1 RELEASE READINESS (owner ruling 2026-10-08, OPTION 1): the SECOND reviewed exception to the certified
// Terraform base 083d066 -- beside CONDUCT_REVIEWERS_WIRING, never instead of it, and never a new baseline. The exception is
// the literal unified diff `escrow21TerraformWiring.patch` (beside this file): exactly the infra/aws/modules + stacks change
// of 50e2bc6 + 04c7bf1 (the dedicated REMEDY KMS key family, its least-privilege IAM on the task / bootstrap / host roles,
// alarm C1 over ClockFinalityHeldTables, the certified 2.1.0 checksum in the module tests, the stack plumbing), plus the
// one comment correction recording the live 2026-10-08 KMS inventory.
//
// Pinned three ways, each reviewable: the patch's SHA-256 (below), the exact file list (below), and every hunk's lines and
// positions (the patch itself). `reverseApplyPinnedHunks` takes a file's CURRENT text and removes its pinned hunks EXACTLY:
// every context and added line must be where the patch says, byte for byte (no fuzz, no offset search); the removed lines
// come back. The drift guard then compares the result with 083d066 under the older rules (CONDUCT_REVIEWERS_WIRING and the
// PHASE 1 fresh-host scripts). So a line added inside or beside a hunk, a hunk moved, altered or missing, or any change
// elsewhere in these files still fails.
//
// Test support only: nothing at runtime imports it, and it spawns nothing (COST-2C: only hostcert/awsCliTransport.ts spawns
// a process under aws/).

import { createHash } from "crypto";

/** Repository-relative path of the pinned patch. */
export const ESCROW21_TERRAFORM_PATCH = "server/src/aws/deploy/escrow21TerraformWiring.patch";

/** SHA-256 of the patch text (LF line endings). A reviewed edit of the patch changes this constant in the same commit. */
export const ESCROW21_TERRAFORM_PATCH_SHA256 = "e2bd4914b03f1034bdf592fae3896580cf8bd85d3245f99f5b92f02965a64fb7";

/** Exactly the files the patch may touch (each must also carry its hunks in the working tree). */
export const ESCROW21_TERRAFORM_FILES: ReadonlySet<string> = new Set([
  "infra/aws/modules/app/alarm-contract.json",
  "infra/aws/modules/app/iam.tf",
  "infra/aws/modules/app/locals.tf",
  "infra/aws/modules/app/tests/alarms.tftest.hcl",
  "infra/aws/modules/app/tests/app.tftest.hcl",
  "infra/aws/modules/app/tests/compute_none.tftest.hcl",
  "infra/aws/modules/app/variables.tf",
  "infra/aws/modules/ledger/main.tf",
  "infra/aws/modules/ledger/outputs.tf",
  "infra/aws/modules/ledger/tests/ledger.tftest.hcl",
  "infra/aws/modules/ledger/variables.tf",
  "infra/aws/modules/single-host/iam.tf",
  "infra/aws/modules/single-host/observability.tf",
  "infra/aws/modules/single-host/tests/single-host.tftest.hcl",
  "infra/aws/modules/single-host/variables.tf",
  "infra/aws/stacks/app/example.tfvars.example",
  "infra/aws/stacks/app/main.tf",
  "infra/aws/stacks/app/variables.tf",
  "infra/aws/stacks/ledger/example.tfvars.example",
  "infra/aws/stacks/ledger/main.tf",
  "infra/aws/stacks/ledger/outputs.tf",
  "infra/aws/stacks/ledger/variables.tf",
  "infra/aws/stacks/single-host/example.tfvars.example",
  "infra/aws/stacks/single-host/main.tf",
  "infra/aws/stacks/single-host/variables.tf",
]);

export interface PinnedHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  /** Each body line with its marker: " " context, "-" removed, "+" added. */
  readonly lines: readonly string[];
}

export type ParsedPatch = { ok: true; files: ReadonlyMap<string, readonly PinnedHunk[]> } | { ok: false; problem: string };

export const normalizeLf = (text: string): string => text.replace(/\r\n/g, "\n");

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse the pinned patch strictly: only `diff --git`, `---` / `+++` (both naming the same existing file), hunks and
 *  their body lines; leading `#` notes before the first file. Anything else (a new / deleted / renamed / binary file, a
 *  mode change, "\ No newline", a count that disagrees with its header) refuses the whole patch. */
export function parsePinnedPatch(rawText: string): ParsedPatch {
  const lines = normalizeLf(rawText).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const files = new Map<string, PinnedHunk[]>();
  let i = 0;
  while (i < lines.length && lines[i].startsWith("#")) i++;
  while (i < lines.length) {
    const head = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[i]);
    if (head === null || head[1] !== head[2]) return { ok: false, problem: `line ${i + 1}: expected "diff --git a/<file> b/<same file>"` };
    const file = head[1];
    if (files.has(file)) return { ok: false, problem: `${file}: appears twice` };
    if (lines[i + 1] !== `--- a/${file}` || lines[i + 2] !== `+++ b/${file}`) return { ok: false, problem: `${file}: only a modification of an existing file is admitted (no new, deleted, renamed, binary or mode-changed file)` };
    i += 3;
    const hunks: PinnedHunk[] = [];
    while (i < lines.length && !lines[i].startsWith("diff --git ")) {
      const h = HUNK.exec(lines[i]);
      if (h === null) return { ok: false, problem: `${file}: line ${i + 1}: expected a hunk header` };
      const hunk = { oldStart: Number(h[1]), oldCount: h[2] === undefined ? 1 : Number(h[2]), newStart: Number(h[3]), newCount: h[4] === undefined ? 1 : Number(h[4]) };
      i++;
      const body: string[] = [];
      let olds = 0;
      let news = 0;
      while (i < lines.length && (olds < hunk.oldCount || news < hunk.newCount)) {
        const marker = lines[i][0];
        if (marker === " ") { olds++; news++; }
        else if (marker === "-") olds++;
        else if (marker === "+") news++;
        else return { ok: false, problem: `${file}: line ${i + 1}: not a hunk line (${JSON.stringify(lines[i].slice(0, 40))})` };
        body.push(lines[i]);
        i++;
      }
      if (olds !== hunk.oldCount || news !== hunk.newCount) return { ok: false, problem: `${file}: a hunk's lines disagree with its header` };
      hunks.push({ ...hunk, lines: body });
    }
    if (hunks.length === 0) return { ok: false, problem: `${file}: no hunk` };
    files.set(file, hunks);
  }
  return { ok: true, files };
}

/** Remove `hunks` from `current` EXACTLY (see the header). Returns the text before the pinned change, or a problem. */
export function reverseApplyPinnedHunks(current: string | null, hunks: readonly PinnedHunk[]): { ok: true; text: string } | { ok: false; problem: string } {
  if (current === null) return { ok: false, problem: "the file is missing" };
  const text = normalizeLf(current);
  if (text !== "" && !text.endsWith("\n")) return { ok: false, problem: "the file no longer ends with a newline" };
  const lines = text === "" ? [] : text.slice(0, -1).split("\n");
  const out: string[] = [];
  let cursor = 0;
  for (const [n, hunk] of hunks.entries()) {
    const at = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    const oldAt = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (at < cursor) return { ok: false, problem: `hunk ${n + 1} overlaps the one before it` };
    const expected = hunk.lines.filter((l) => l[0] !== "-").map((l) => l.slice(1));
    const actual = lines.slice(at, at + expected.length);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const k = expected.findIndex((l, j) => actual[j] !== l);
      return { ok: false, problem: `hunk ${n + 1} (@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@): line ${at + k + 1} is ${JSON.stringify(actual[k] ?? "<end of file>")}, the pinned change has ${JSON.stringify(expected[k])}` };
    }
    out.push(...lines.slice(cursor, at));
    if (out.length !== oldAt) return { ok: false, problem: `hunk ${n + 1}: its position in the certified text is not the pinned one` };
    out.push(...hunk.lines.filter((l) => l[0] !== "+").map((l) => l.slice(1)));
    cursor = at + expected.length;
  }
  out.push(...lines.slice(cursor));
  return { ok: true, text: out.length === 0 ? "" : `${out.join("\n")}\n` };
}
