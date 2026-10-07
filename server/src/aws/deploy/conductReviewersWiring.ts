// server/src/aws/deploy/conductReviewersWiring.ts
//
// CONSOLIDATED FINAL PRE-PLAYTEST INTEGRATION: the ONE reviewed change to the certified Terraform (base `083d066`) --
// player reporting's GS_CONDUCT_REVIEWERS input, wired SOURCE ONLY through the single-host and ECS modules and stacks.
// The IaC drift guards (`migration/phase1RemainderRunbook.test.ts`, `staging/hostRoleProbe.test.ts`) admit exactly
// these files, and in each non-test file exactly these ADDED lines (`git diff -U0 <base>`): no line of the certified
// base removed or changed, nothing else added. With the default (no reviewer) the rendered server.env (so the user
// data, which replaces the host on change) and the ECS task definition are byte-identical to the base's (pinned by the
// modules' own `conduct_reviewers_absent_by_default` tftest runs). A later change to any of these files -- a new
// resource, another `write_files` entry, another environment line -- is a different diff and fails the guards.
// Test support only: nothing at runtime imports it.

import { spawnSync } from "child_process";

/** Each wired file -> its exact added lines in order, or "test" (a tftest file: runs may be added, nothing removed). */
export const CONDUCT_REVIEWERS_WIRING: Readonly<Record<string, readonly string[] | "test">> = Object.freeze({
  "infra/aws/modules/single-host/locals.tf": [
    "    conduct_reviewers     = var.conduct_reviewers",
  ],
  "infra/aws/modules/single-host/variables.tf": [
    "variable \"conduct_reviewers\" {",
    "  description = \"GS_CONDUCT_REVIEWERS: the USERNAMES that may open the conduct-report review panel (player reporting; usernames, no secret). Each must be held by an account when the server starts, or the server refuses to start (fail closed). Empty (the default): reports are received and kept, and nobody can review them; the rendered environment is then byte-identical to a module without this input.\"",
    "  type        = list(string)",
    "  default     = []",
    "  validation {",
    "    condition     = length(var.conduct_reviewers) <= 32 && alltrue([for name in var.conduct_reviewers : can(regex(\"^[^\\\\s,\\\\p{Cc}\\\\p{Cf}]{1,64}$\", name))])",
    "    error_message = \"conduct_reviewers: at most 32 usernames, each 1-64 characters with no whitespace, comma or control character.\"",
    "  }",
    "}",
    "",
  ],
  "infra/aws/modules/single-host/templates/server.env.tftpl": [
    "%{ if length(conduct_reviewers) > 0 ~}",
    "GS_CONDUCT_REVIEWERS=${join(\",\", conduct_reviewers)}",
    "%{ endif ~}",
  ],
  "infra/aws/modules/app/locals.tf": [
    "      length(var.conduct_reviewers) > 0 ? [{ name = \"GS_CONDUCT_REVIEWERS\", value = join(\",\", var.conduct_reviewers) }] : [],",
  ],
  "infra/aws/modules/app/variables.tf": [
    "variable \"conduct_reviewers\" {",
    "  description = \"GS_CONDUCT_REVIEWERS: the USERNAMES that may open the conduct-report review panel (usernames, no secret; each must be held by an account at startup or the task refuses to start). Empty (the default): no reviewer, and the task environment is exactly as without this input.\"",
    "  type        = list(string)",
    "  default     = []",
    "  validation {",
    "    condition     = length(var.conduct_reviewers) <= 32 && alltrue([for name in var.conduct_reviewers : can(regex(\"^[^\\\\s,\\\\p{Cc}\\\\p{Cf}]{1,64}$\", name))])",
    "    error_message = \"conduct_reviewers: at most 32 usernames, each 1-64 characters with no whitespace, comma or control character.\"",
    "  }",
    "}",
    "",
  ],
  "infra/aws/stacks/app/main.tf": [
    "  conduct_reviewers                 = var.conduct_reviewers",
  ],
  "infra/aws/stacks/app/variables.tf": [
    "variable \"conduct_reviewers\" {",
    "  type    = list(string)",
    "  default = []",
    "}",
    "",
  ],
  "infra/aws/stacks/single-host/main.tf": [
    "  conduct_reviewers       = var.conduct_reviewers",
  ],
  "infra/aws/stacks/single-host/variables.tf": [
    "variable \"conduct_reviewers\" {",
    "  description = \"GS_CONDUCT_REVIEWERS (the module validates it). Changing it changes the host's user data: see infra/aws/SINGLE_HOST_MIGRATION.md before planning it on a running host.\"",
    "  type        = list(string)",
    "  default     = []",
    "}",
    "",
  ],
  "infra/aws/modules/single-host/tests/single-host.tftest.hcl": "test",
  "infra/aws/modules/app/tests/app.tftest.hcl": "test",
});

/** The wiring's problems among `changed` (the guard's `git diff --name-only <base>` list, repository-relative): a
 *  wired file whose diff from `base` removes a line, or (outside the tftest files) adds anything but its pinned lines.
 *  Files that are not wired are the caller's to judge. */
export function conductReviewersWiringProblems(repo: string, base: string, changed: readonly string[]): string[] {
  const problems: string[] = [];
  for (const file of changed) {
    const pinned = CONDUCT_REVIEWERS_WIRING[file];
    if (pinned === undefined) continue;
    const d = spawnSync("git", ["-C", repo, "diff", "--unified=0", base, "--", file], { encoding: "utf8" });
    if (d.status !== 0) {
      problems.push(`${file}: git diff failed`);
      continue;
    }
    const lines = d.stdout.split("\n");
    const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
    if (removed.length > 0) problems.push(`${file}: removes or changes ${removed.length} line(s) of the certified base`);
    if (pinned === "test") {
      if (!added.some((l) => l.includes("conduct_reviewers"))) problems.push(`${file}: no reviewer run`);
      continue;
    }
    if (JSON.stringify(added) !== JSON.stringify(pinned)) problems.push(`${file}: adds other than the pinned reviewer wiring: ${JSON.stringify(added)}`);
  }
  return problems;
}

/** The wired files, for the guards' allow-lists. */
export const CONDUCT_REVIEWERS_FILES: ReadonlySet<string> = new Set(Object.keys(CONDUCT_REVIEWERS_WIRING));
