// server/src/aws/deploy/ludumOriginsTerraformWiring.ts
//
// LUDUM ORIGINS: the THIRD reviewed exception to the certified Terraform base 083d066 -- beside CONDUCT_REVIEWERS_WIRING and
// the pinned Escrow 2.1 delta (`escrow21TerraformWiring.ts`), never instead of them, and never a new baseline. The exception
// is the literal unified diff `ludumOriginsTerraformWiring.patch` (beside this file): the modules/app + stacks/app change that
// writes the Ludum site's origin(s) into the serving pool's runtime document (docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md
// §2.1, §13). It is applied AFTER the Escrow 2.1 delta, so the drift guard reverse-applies it FIRST.
//
// Pinned like the Escrow 2.1 delta: the patch's SHA-256, the exact file list, each file's exact line count (below), and every
// hunk's lines and positions (the patch itself). Test support only: nothing at runtime imports it, and it spawns nothing.

/** Repository-relative path of the pinned patch. */
export const LUDUM_TERRAFORM_PATCH = "server/src/aws/deploy/ludumOriginsTerraformWiring.patch";

/** SHA-256 of the patch text (LF line endings). A reviewed edit of the patch changes this constant in the same commit. */
export const LUDUM_TERRAFORM_PATCH_SHA256 = "345cf9d80da70fdf0c9470f97945e94a5b12f4ed88f5ca620e72a4685ceee090";

/** Exactly the files the patch may touch (each must also carry its hunks in the working tree). */
export const LUDUM_TERRAFORM_FILES: ReadonlySet<string> = new Set([
  "infra/aws/modules/app/locals.tf",
  "infra/aws/modules/app/tests/app.tftest.hcl",
  "infra/aws/modules/app/tests/compute_none.tftest.hcl",
  "infra/aws/modules/app/variables.tf",
  "infra/aws/stacks/app/example.tfvars.example",
  "infra/aws/stacks/app/main.tf",
  "infra/aws/stacks/app/variables.tf",
]);

/** Each pinned file's exact line count after the change (the Escrow 2.1 rule M2: a diff does not anchor a file's end). */
export const LUDUM_TERRAFORM_LINE_COUNTS: ReadonlyMap<string, number> = new Map([
  ["infra/aws/modules/app/locals.tf", 161],
  ["infra/aws/modules/app/tests/app.tftest.hcl", 1278],
  ["infra/aws/modules/app/tests/compute_none.tftest.hcl", 416],
  ["infra/aws/modules/app/variables.tf", 542],
  ["infra/aws/stacks/app/example.tfvars.example", 71],
  ["infra/aws/stacks/app/main.tf", 76],
  ["infra/aws/stacks/app/variables.tf", 179],
]);
