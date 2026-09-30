# infra/aws/fixtures

The EXACT documents the Terraform app module renders for its test inputs (`modules/app/tests/app.tftest.hcl`). The same
files are fed to the server's own parsers by `server/src/aws/deploy/l5_8Deploy.test.ts`
(`parseAwsRuntimeConfigText`, `parseJunoBackendConfig` in production mode, `checkEscrowConfigForAws`), so a rendering the
runtime would refuse fails one of the two suites. The keys, addresses and ARNs are test values (no real account).
