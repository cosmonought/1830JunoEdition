// server/src/aws/deploy/terraformDriftGuard.ts
//
// The ONE comparison behind the certified-Terraform drift guards (`staging/hostRoleProbe.test.ts` for modules/single-host,
// `migration/phase1RemainderRunbook.test.ts` for every module and stack). The certified base stays 083d066 (owner ruling
// 2026-10-08, OPTION 1); what may differ from it is exactly:
//   1. the PHASE 1 FRESH-HOST HARDENING host scripts (and their bash tests / README) -- unchanged rule;
//   2. CONDUCT_REVIEWERS_WIRING -- unchanged rule (`conductReviewersWiring.ts`);
//   3. the Escrow 2.1 release-readiness delta -- the pinned patch (`escrow21TerraformWiring.ts`), REQUIRED and exact.
// For each changed file (and every file the Escrow 2.1 patch names, so a removed change is caught too) the guard removes
// the pinned Escrow 2.1 hunks exactly, then judges what is left against 083d066 by rules 1 and 2. Anything else fails.
//
// HARDENED after independent review (2026-10-08): paths listed NUL-separated and never C-quoted, unsafe names refused (H1);
// the conduct rule reads hunk bodies by position (H2); git-ignored files Terraform loads are refused (M1); each pinned
// file's exact line count anchors its end (M2); skip-worktree / assume-unchanged entries are refused (M3).
//
// FAIL CLOSED (owner ruling 2026-10-08): the guards once returned early -- PASSED -- when the base was not in the checkout
// (a shallow clone), which hid exactly this delta from the release-readiness review. Now a missing base, a checkout git
// cannot read, an unreadable file or a tampered patch is a PROBLEM, never a skip. The fix for a shallow clone is to fetch
// the base (`git fetch --depth=1 origin <base>`); the guard itself never touches the network.
//
// Test support only: nothing at runtime imports it, and it spawns nothing -- the caller hands it `DriftIo` (git, the
// working tree, a text diff), so COST-2C's rule (only hostcert/awsCliTransport.ts spawns under aws/) holds.

import { CONDUCT_REVIEWERS_FILES, conductReviewersWiringProblems } from "./conductReviewersWiring";
import { ESCROW21_TERRAFORM_FILES, ESCROW21_TERRAFORM_LINE_COUNTS, ESCROW21_TERRAFORM_PATCH_SHA256, normalizeLf, parsePinnedPatch, reverseApplyPinnedHunks, sha256Hex } from "./escrow21TerraformWiring";

/** The certified Terraform base. Never moved by an exception: exceptions are pinned deltas FROM it. */
export const CERTIFIED_TERRAFORM_BASE = "083d0668556c05a84eb8b3e5befc4e973544aa9a";

/** PHASE 1 FRESH-HOST HARDENING's module files (host scripts embedded in the user data, their bash tests, the README). */
export const FRESH_HOST_FILES: ReadonlySet<string> = new Set(
  ["files/bin/gs-preflight", "files/bin/gs-lib.sh", "files/bin/gs-health", "tests/host-scripts.test.sh", "tests/preflight-real-docker.test.sh", "README.md"].map((f) => `infra/aws/modules/single-host/${f}`),
);

export interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
}

export interface DriftIo {
  /** `git <args>` in the repository. */
  git(args: readonly string[]): GitResult;
  /** A working-tree file's text, or null when it does not exist. */
  readWorking(rel: string): string | null;
  /** A `--unified=0` diff from `before` to `after` (null: absent), or null when the diff could not be computed. */
  diffTexts(before: string | null, after: string | null): string | null;
}

export interface DriftOptions {
  /** Repository-relative paths the guard owns, e.g. ["infra/aws/modules", "infra/aws/stacks"]. */
  readonly scope: readonly string[];
  /** The pinned patch's text (read by the caller from ESCROW21_TERRAFORM_PATCH). */
  readonly patchText: string;
  /** Regression tests only: a different base, to prove a missing one fails. The guards never pass it. */
  readonly base?: string;
  /** Regression tests only: file texts (null: deleted) laid over the working tree. */
  readonly overlay?: ReadonlyMap<string, string | null>;
}

const inScope = (file: string, scope: readonly string[]) => scope.some((s) => file === s || file.startsWith(`${s.replace(/\/$/, "")}/`));

/** Paths the guard can name unambiguously (review H1: git C-quotes others, and a quoted name was read as a missing file). */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const safePath = (file: string) => SAFE_PATH.test(file) && !file.split("/").some((part) => part === "" || part === "." || part === "..");

/** Git-ignored files Terraform nevertheless LOADS (review M1): override files, auto-loaded variable files, any other
 *  configuration, test or mock file. Named operator inputs (`staging.tfvars`, passed by -var-file) are not loaded
 *  automatically and stay allowed; `.terraform/` (provider cache) is skipped. */
const TERRAFORM_LOADED = /(\.tf|\.tf\.json|\.tftest\.hcl|\.tftest\.json|\.tfmock\.hcl|\.tfmock\.json|\.auto\.tfvars|\.auto\.tfvars\.json|(^|\/)terraform\.tfvars|(^|\/)terraform\.tfvars\.json)$/;

/** Every reason the tree under `scope` is not the certified base plus the reviewed exceptions ([] = it is). */
export function terraformDriftProblems(io: DriftIo, options: DriftOptions): string[] {
  const base = options.base ?? CERTIFIED_TERRAFORM_BASE;
  const missingBase = `the certified Terraform base ${base} is not available in this checkout (a shallow clone, an exported tree, or not a git checkout): the drift guard FAILS rather than skip. Fetch it (git fetch --depth=1 origin ${base}) and run again.`;
  if (io.git(["rev-parse", "--is-inside-work-tree"]).status !== 0) return [missingBase];
  if (io.git(["cat-file", "-e", `${base}^{commit}`]).status !== 0) return [missingBase];

  if (sha256Hex(normalizeLf(options.patchText)) !== ESCROW21_TERRAFORM_PATCH_SHA256) return ["the Escrow 2.1 Terraform patch does not match its pinned SHA-256 (escrow21TerraformWiring.ts): a reviewed edit changes both"];
  const patch = parsePinnedPatch(options.patchText);
  if (!patch.ok) return [`the Escrow 2.1 Terraform patch is refused: ${patch.problem}`];
  const patched = [...patch.files.keys()];
  if (JSON.stringify([...patched].sort()) !== JSON.stringify([...ESCROW21_TERRAFORM_FILES].sort())) return [`the Escrow 2.1 Terraform patch names other files than ESCROW21_TERRAFORM_FILES: ${JSON.stringify(patched)}`];

  /* NUL-separated, never C-quoted (review H1). */
  const q = ["-c", "core.quotePath=false"];
  const listed = io.git([...q, "diff", "-z", "--name-only", "--no-renames", base, "--", ...options.scope]);
  const untracked = io.git([...q, "ls-files", "-z", "--others", "--exclude-standard", "--", ...options.scope]);
  const ignored = io.git([...q, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...options.scope]);
  const tracked = io.git([...q, "ls-files", "-z", "-v", "--", ...options.scope]);
  if (listed.status !== 0 || untracked.status !== 0 || ignored.status !== 0 || tracked.status !== 0) return [`git could not list the changes under ${options.scope.join(", ")} since ${base}`];
  const entries = (s: string) => s.split("\0").filter((l) => l !== "");

  const problems: string[] = [];
  /* Review M3: an index flag (skip-worktree "S", assume-unchanged: a lowercase tag) makes git stop looking at a file. */
  for (const entry of entries(tracked.stdout)) if (!entry.startsWith("H ")) problems.push(`${entry.slice(2)}: its index entry is flagged "${entry[0]}" (skip-worktree / assume-unchanged): git would not see its changes -- clear the flag (git update-index --no-skip-worktree --no-assume-unchanged)`);
  for (const file of entries(ignored.stdout))
    if (!file.split("/").includes(".terraform") && TERRAFORM_LOADED.test(file)) problems.push(`${file}: git-ignored, but Terraform loads it (an override, auto-loaded variables or configuration): remove it`);
  const candidates = new Set([...entries(listed.stdout), ...entries(untracked.stdout)]);
  for (const file of options.overlay?.keys() ?? []) if (inScope(file, options.scope)) candidates.add(file);
  for (const file of patched) if (inScope(file, options.scope)) candidates.add(file);
  for (const file of [...candidates]) if (!safePath(file)) {
    problems.push(`${JSON.stringify(file)}: a path the guard refuses to judge (only [A-Za-z0-9._/-], no empty / . / .. part): rename it`);
    candidates.delete(file);
  }

  const remaining: string[] = [];
  const diffs = new Map<string, string | null>();
  for (const file of [...candidates].sort()) {
    let before: string | null = null;
    if (io.git(["cat-file", "-e", `${base}:${file}`]).status === 0) {
      const blob = io.git(["cat-file", "blob", `${base}:${file}`]);
      if (blob.status !== 0) {
        problems.push(`${file}: its certified text could not be read from ${base}`);
        continue;
      }
      before = normalizeLf(blob.stdout);
    }
    const raw = options.overlay?.has(file) ? (options.overlay.get(file) ?? null) : io.readWorking(file);
    let now = raw === null ? null : normalizeLf(raw);
    if (before === null && now === null) {
      problems.push(`${file}: git lists it as changed, yet it exists neither in ${base} nor in the working tree`);
      continue;
    }
    const hunks = patch.files.get(file);
    if (hunks !== undefined) {
      const reversed = reverseApplyPinnedHunks(now, hunks, ESCROW21_TERRAFORM_LINE_COUNTS.get(file));
      if (!reversed.ok) {
        problems.push(`${file}: the pinned Escrow 2.1 change is missing, altered, moved or has a line beside it -- ${reversed.problem}`);
        continue;
      }
      now = reversed.text;
    }
    if (now === before) continue;
    remaining.push(file);
    diffs.set(file, io.diffTexts(before, now));
  }
  problems.push(...conductReviewersWiringProblems(remaining, (file) => diffs.get(file) ?? null));
  for (const file of remaining)
    if (!FRESH_HOST_FILES.has(file) && !CONDUCT_REVIEWERS_FILES.has(file)) problems.push(`${file}: differs from the certified base ${base} and no reviewed exception admits it`);
  return problems;
}
