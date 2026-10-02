# infra/aws/fixtures

The EXACT documents the Terraform app module renders for its test inputs (`modules/app/tests/app.tftest.hcl`). The same
files are fed to the server's own parsers by `server/src/aws/deploy/l5_8Deploy.test.ts`
(`parseAwsRuntimeConfigText`, `parseJunoBackendConfig` in production mode, `checkEscrowConfigForAws`), so a rendering the
runtime would refuse fails one of the two suites. The keys, addresses and ARNs are test values (no real account).

COST-2A adds the single-host module's two IAM documents, as `modules/single-host/tests/single-host.tftest.hcl` renders
them for its test inputs (that test asserts equality with these files): `host-role-policy-staging.json` (the host role's
inline policy) and `host-assume-role-policy-staging.json` (its trust policy). `server/src/aws/deploy/cost2aHostVerifier.test.ts`
feeds them to the host verifier as the GOOD evidence, so a module change the verifier would refuse fails one of the two suites.
