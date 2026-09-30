// server/src/tools/awsDeploy.ts
//
// LIVE-5 L5-8: the deploy bootstrap and verifier (`npm run awsDeploy -- <command>`; the commands are documented in
// `aws/deploy/commands.ts` and infra/aws/README.md). This file only wires the process: the SDK clients from
// `awsClients.ts`'s factories (explicit regions, the default credential chain), stdout, the exit code.

import * as http from "http";
import * as path from "path";
import { performance } from "perf_hooks";

import { createDynamoDbClient, createKmsClient } from "../aws/awsClients";
import { runDeployCommand, type DeployDeps } from "../aws/deploy/commands";
import { nodeEdgeTransport } from "../aws/deploy/staging/edgeProbe";
import { stageCertCommand, stageProbeCommand, type StagingDeps } from "../aws/deploy/staging/commands";
import { kmsDigestClientFor, ssmParameterSourceFor } from "../aws/deploy/wiring";

const deps: DeployDeps = {
  parameters: ssmParameterSourceFor(),
  dynamo: (region) => createDynamoDbClient({ kind: "aws", region }),
  kms: (region) => {
    const sdk = createKmsClient({ kind: "aws", region });
    return { sdk, digest: kmsDigestClientFor(sdk, region) };
  },
  now: () => Date.now(),
  // eslint-disable-next-line no-console
  out: (line) => console.log(line),
};

/* LIVE-6 L6-6: the staging certification (`aws/deploy/staging/`). The repository is this build's own checkout
   (dist/server/src/tools -> the repository root), for the committed Terraform lock files. */
const staging: StagingDeps = {
  env: process.env,
  monotonic: () => performance.now(),
  edge: nodeEdgeTransport(),
  repository: path.resolve(__dirname, "../../../../.."),
  /* Inside an ECS task: the task metadata endpoint (v4, link-local, no credentials) names this task. */
  taskArn: () => {
    const base = process.env.ECS_CONTAINER_METADATA_URI_V4;
    if (base === undefined || !/^http:\/\/169\.254\.170\.2\//.test(base)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const req = http.get(`${base}/task`, { timeout: 2_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const arn = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { TaskARN?: unknown }).TaskARN;
            resolve(typeof arn === "string" ? arn : null);
          } catch {
            resolve(null);
          }
        });
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
    });
  },
};

runDeployCommand(process.argv.slice(2), deps, {
  "stage-cert": (argv) => stageCertCommand(argv, deps, staging),
  "stage-probe": (argv) => stageProbeCommand(argv, deps, staging),
}).then(
  (code) => process.exit(code),
  (error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
