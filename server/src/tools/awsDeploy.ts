// server/src/tools/awsDeploy.ts
//
// LIVE-5 L5-8: the deploy bootstrap and verifier (`npm run awsDeploy -- <command>`; the commands are documented in
// `aws/deploy/commands.ts` and infra/aws/README.md). This file only wires the process: the SDK clients from
// `awsClients.ts`'s factories (explicit regions, the default credential chain), stdout, the exit code.

import { createDynamoDbClient, createKmsClient } from "../aws/awsClients";
import { runDeployCommand } from "../aws/deploy/commands";
import { kmsDigestClientFor, ssmParameterSourceFor } from "../aws/deploy/wiring";

runDeployCommand(process.argv.slice(2), {
  parameters: ssmParameterSourceFor(),
  dynamo: (region) => createDynamoDbClient({ kind: "aws", region }),
  kms: (region) => {
    const sdk = createKmsClient({ kind: "aws", region });
    return { sdk, digest: kmsDigestClientFor(sdk, region) };
  },
  now: () => Date.now(),
  // eslint-disable-next-line no-console
  out: (line) => console.log(line),
}).then(
  (code) => process.exit(code),
  (error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
