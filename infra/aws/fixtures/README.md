# infra/aws/fixtures

The EXACT documents the Terraform app module renders for its test inputs (`modules/app/tests/app.tftest.hcl`). The same
files are fed to the server's own parsers by `server/src/aws/deploy/l5_8Deploy.test.ts`
(`parseAwsRuntimeConfigText`, `parseJunoBackendConfig` in production mode, `checkEscrowConfigForAws`), so a rendering the
runtime would refuse fails one of the two suites. The keys, addresses and ARNs are test values (no real account).

## migration-plans/ (COST-2B)

Saved-plan fixtures (`terraform show -json` shape) for `server/src/aws/deploy/migration/` -- the migration plan guards:
- `<gate>.json`: one SYNTHETIC valid plan per guarded step of `infra/aws/SINGLE_HOST_MIGRATION.md`, built from the accepted
  post-abandonment staging state by `server/src/aws/deploy/migration/planFixtures.ts` (the test proves the files equal its
  output; regenerate with `node dist/server/src/aws/deploy/migration/planFixtures.js --write` after `npm run build`);
- `terraform-real/`: plans Terraform itself produced from the repository's own roots against a local AWS mock (its README
  says exactly how).

