# Terraform-produced migration plans (COST-2B)

Real `terraform show -json` output, not hand-built: the repository's own roots (`stacks/single-host`, `stacks/ledger`),
modules and lock files, Terraform **1.16.5** with **hashicorp/aws 6.66.0**, planned against a local **moto 5.2.3** AWS mock
(no AWS account; account ids `123456789012` for the host stack, `111111111111` as the app account the ledger grants).
Only the provider block was pointed at the mock. Two edits were made afterwards, both inside `configuration`: the provider's
`expressions` (the mock's endpoints and dummy credentials) were removed, and the module call's `source` (an absolute path
in the scratch copy of the root) was restored to the repository's relative `../../modules/<module>`. Nothing else was
edited: `configuration` is kept because the guards judge it (provisioners, data sources, providers, the module call).

| File | How it was made | Gate it must pass |
|---|---|---|
| `host-create.json` | `stacks/single-host` from `example.tfvars.example` (the budget enabled with a subscriber), empty state | `host-create` |
| `ledger-host-authorize.json` | `stacks/ledger` applied (table, resource policy, signing keys) with the defaults, then planned with `app_runtime_role_arns = [gs-staging-host-app]` (`-target` the table, its resource policy and the keys: the mock lacks some AWS Backup APIs) | `ledger-host-authorize` |
| `ledger-task-deauthorize.json` | the plan above applied, then `-var=ecs_task_role_authorized=false` (a CLI `-var`: recorded in the plan as the raw string `"false"`) | `ledger-task-deauthorize` |

**RECON-1A** added four more, made the same way (Terraform 1.16.5, hashicorp/aws 6.66.0, moto 5.2.3; only the provider's
`expressions` removed; the module sources were already the repository's relative paths):

| File | How it was made | Gate it must pass |
|---|---|---|
| `app-read-authorize.json` | `stacks/app` (staging-shaped tfvars, app account `123456789012`, p1 + p2, an operator trust principal): the two roles and policies applied `-target`ed from COST-1's module (`7d140b4`: no HostVerifier* / JX-4C statements), then planned from this branch's module with exactly `-target=module.app.aws_iam_role_policy.bootstrap -target=module.app.aws_iam_role_policy.operator[0]` -- Terraform's targeted closure is those two policies and their two roles (4 entries) | `app-read-authorize` |
| `ledger-operator-journal.json` | `stacks/ledger` with `relayer_key_count = 2` and `financial_key_sets = ["v2"]` (RECON-0 X-09: six keys) applied `-target`ed (table, resource policy, keys) from P5-INT-1's module (`9e45ded`: no OperatorJournalQuery), then planned from this branch's module | `ledger-operator-journal` |
| `x09-ledger-host-authorize.json` | that plan applied, then `app_runtime_role_arns = [gs-staging-host-app]` (a CLI `-var`) | `ledger-host-authorize` |
| `x09-ledger-task-deauthorize.json` | that plan applied, then `-var=ecs_task_role_authorized=false` | `ledger-task-deauthorize` |

The same runs proved the ordering: the step-8 plan captured BEFORE 7b was applied was refused by `ledger-host-authorize`
("statements added or removed ... OperatorJournalQuery still pending: run step 7b ... first"); each judged `stack.tfplan`
was then applied to the mock exactly, and a targeted re-plan of 7a answered no changes (exit 0).

They pin the guards against the shapes Terraform actually writes (aws_iam_policy_document's bare-string singletons,
`revision_id` unknown on update, the inline key policies), so a guard change that would refuse a genuine plan fails
`server/src/aws/deploy/migration/cost2bMigrationGuards.test.ts`. The app-stack gates could not be produced this way (the
mock has no CloudFront origin-request policies and its CloudWatch alarm API does not match this provider), so they are
covered by the synthetic fixtures one directory up; the moto runs of the ECS rollback and the compute-none teardown are
described in the COST-2B report.
