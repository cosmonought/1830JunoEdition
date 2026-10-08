# infra/aws/fixtures

The EXACT documents the Terraform app module renders for its test inputs (`modules/app/tests/app.tftest.hcl`). The same
files are fed to the server's own parsers by `server/src/aws/deploy/l5_8Deploy.test.ts`
(`parseAwsRuntimeConfigText`, `parseJunoBackendConfig` in production mode, `checkEscrowConfigForAws`), so a rendering the
runtime would refuse fails one of the two suites. The keys, addresses and ARNs are test values (no real account).

PHASE 3 ESCROW 2.1 (2026-10-08): `juno-backend-staging.json` names the certified escrow 2.1.0 checksum (`c3bd0618…`, the
server's pin) and NO remedy key (the fail-closed default); `juno-backend-staging-remedy.json` is the same document with the
dedicated REMEDY key (`remedy_signing_key` + `escrow.remedy_key`), and `host-role-policy-staging-remedy.json` the host role's
policy with it (its own two statements). Each is asserted by its module test and fed to the server's parser / verifiers.

COST-2A adds the single-host module's two IAM documents, as `modules/single-host/tests/single-host.tftest.hcl` renders
them for its test inputs (that test asserts equality with these files): `host-role-policy-staging.json` (the host role's
inline policy) and `host-assume-role-policy-staging.json` (its trust policy). `server/src/aws/deploy/cost2aHostVerifier.test.ts`
feeds them to the host verifier as the GOOD evidence, so a module change the verifier would refuse fails one of the two suites.

## migration-plans/ (COST-2B)

Saved-plan fixtures (`terraform show -json` shape) for `server/src/aws/deploy/migration/` -- the migration plan guards:
- `<gate>.json`: one SYNTHETIC valid plan per guarded step of `infra/aws/SINGLE_HOST_MIGRATION.md`, built from the accepted
  post-abandonment staging state by `server/src/aws/deploy/migration/planFixtures.ts` (the test proves the files equal its
  output; regenerate with `node dist/server/src/aws/deploy/migration/planFixtures.js --write` after `npm run build`);
- `terraform-real/`: plans Terraform itself produced from the repository's own roots against a local AWS mock (its README
  says exactly how).
- RECON-1A: `app-read-authorize.json` (step 7a, a targeted plan) and `ledger-operator-journal.json` (7b) beside the
  others; every later step's fixture starts from the state AFTER them (the read grants present). `x09/`: RECON-0 X-09's
  cross-product -- the ledger steps over the relayer rotation key, a JX-1K financial key set, JX-4C's statement and the
  host's coexistence together (same builder, same `--write`); `terraform-real/` gained the Terraform-made 7a / 7b / X-09
  plans.

