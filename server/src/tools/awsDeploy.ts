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
import type { RecoveryReaders, ReviewSummary as StagingReviewSummary } from "../aws/deploy/staging/recovery";
import { kmsDigestClientFor, ssmParameterSourceFor } from "../aws/deploy/wiring";
/* LIVE-6 final convergence: L6-4's canonical READERS and startup rule, bound for the staging certification (never a
   second parser; the import guard admits exactly these names for this file), and L6-5A's one TASK# reader. */
import { adoptionBindingProblem, generationMarkerProblem, readGenerationMarker } from "../aws/game/generationMarker";
import { identityServingProblem, readIdentityRestore, readIdentityRole, readIdentityTableSelf } from "../aws/identity/dynamoIdentityStore";
import { inspectIdentityRestore } from "../aws/identity/identityRestore";
import { readAdoptionRecord, readAppGeneration } from "../aws/ledger/appGeneration";
import { oldGenerationHeartbeatsAfter, readTaskStatus } from "../aws/runtime/taskHeartbeats";
/* LIVE-6 relayer rotation: the post-rotation proof's readers -- the deployment's own, read-only (the import guard admits
   exactly these names): the routing, the pool item, the relayer mirror and the ledger's relayer fence, the holder's one
   TASK# item, the rotation gate's own queue reader; and the chain, through the server's own REST client. */
import { readRouting } from "../aws/game/routing";
import { readPool } from "../aws/game/ownership";
import { readRelayerRole } from "../aws/game/relayerRole";
import { readRelayerFence } from "../aws/ledger/dynamoSigningLedger";
import { relayQueueState } from "../aws/deploy/relayerRotation";
import { productionJunoChain } from "../aws/deploy/junoChain";
import type { RotationReaders } from "../aws/deploy/staging/rotationProof";
/* COST-2C: the mutating single-host certification drills (`aws/deploy/hostcert/`): the SAME readers as above, plus L5-4's
   identity-writer role reader (read only); the host is reached through the AWS CLI (SSM Run Command), never a shell. */
import { hostCertCommand, type HostCertDeps } from "../aws/deploy/hostcert/commands";
import type { HostCertReaders } from "../aws/deploy/hostcert/controlPlane";
import { productionHostCertWorld } from "../aws/deploy/hostcert/awsCliTransport";

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
  /* LIVE-6 relayer rotation: the escrow contract on chain, read only (the rotation gate's operator read, set-operator-plan,
     the post-rotation proof): the server's own REST client over the configuration's own endpoints. */
  juno: productionJunoChain(),
};

/**
 * LIVE-6 final convergence: `StagingDeps.recovery` bound to L6-4's own functions (L6-6R §7's reviewed contract):
 *   generationMarker          readGenerationMarker
 *   appGeneration             readAppGeneration
 *   generationServingProblem  the runtime's step 1 (`awsRuntime.ts`), in its order: APPGEN = the document's generation,
 *                             then generationMarkerProblem, then adoptionBindingProblem over APPGEN's adoption
 *   identityState             readIdentityRestore + TABLE#identity's own name (readIdentityTableSelf) + identityServingProblem
 *   reviews                   inspectIdentityRestore(...).reviews -> { restore_id, reason, open: resolved_at === null } ONLY
 *   adoptionRecord            readAdoptionRecord (the generation-gate record's claim against APPGEN#HISTORY)
 */
export const STAGING_RECOVERY_READERS: RecoveryReaders = {
  generationMarker: (client, table) => readGenerationMarker(client, table),
  appGeneration: (client, table) => readAppGeneration(client, table),
  generationServingProblem: (marker, appgen, expected) => {
    if (appgen === null) return "the ledger has no adopted app generation (APPGEN): an operator initialises it before the first start (L5-8 / runbook)";
    if (appgen.current_generation !== expected.generation) return `the ledger's adopted app generation is ${String(appgen.current_generation)}, not this task's ${expected.generation}: a task pointed at a superseded or unadopted game table does not start`;
    const markerProblem = generationMarkerProblem(marker, expected);
    if (markerProblem !== null) return markerProblem;
    return adoptionBindingProblem(marker as NonNullable<typeof marker>, appgen.adoption === null ? null : { game_table: appgen.adoption.game_table, restore_id: appgen.adoption.restore_id });
  },
  identityState: async (client, table) => ({ restore: await readIdentityRestore(client, table), self: await readIdentityTableSelf(client, table), servingProblem: await identityServingProblem(client, table) }),
  reviews: async (client, table): Promise<readonly StagingReviewSummary[]> => (await inspectIdentityRestore(client, table)).reviews.map((r) => ({ restore_id: r.restore_id, reason: r.reason, open: r.resolved_at === null })),
  adoptionRecord: (client, table, generation) => readAdoptionRecord(client, table, generation),
};

/* LIVE-6 L6-6: the staging certification (`aws/deploy/staging/`). The repository is this build's own checkout
   (dist/server/src/tools -> the repository root), for the committed Terraform lock files. */
/** L6-5A/L6-5B's TASK# items as L6-6R's restore-quiet heartbeat evidence (operator proof only, never a lease). */
export const STAGING_HEARTBEATS: NonNullable<StagingDeps["heartbeats"]> = (client, table, expect) => oldGenerationHeartbeatsAfter(client, table, expect);

/**
 * LIVE-6 relayer rotation: `StagingDeps.rotation` bound to the deployment's own READ functions (rotationProof.ts):
 *   routing        readRouting (L5-3: SYSTEM/ROUTING, strict)
 *   pool           readPool (L5-2: POOL#<pool>'s writer epoch and task)
 *   relayerRole    readRelayerRole (L5-6: ROLE#relayer#<account>, strict)
 *   relayerFence   readRelayerFence (L6-3: the ledger's FENCE#relayer#<account>, strict)
 *   taskStatus     readTaskStatus (L6-5A's one TASK# reader: the holder's own heartbeat -- evidence, never a lease)
 *   relayQueue     relayQueueState (the rotation gate's own: RELAYQ#<address>, strongly consistent, every page)
 */
export const STAGING_ROTATION_READERS: RotationReaders = {
  routing: (client, table) => readRouting(client, table),
  pool: (client, table, pool) => readPool(client, table, pool),
  relayerRole: (client, table, account) => readRelayerRole(client, table, account),
  relayerFence: (client, table, account) => readRelayerFence(client, table, account),
  taskStatus: (client, table, task) => readTaskStatus(client, table, task),
  relayQueue: (client, table, address) => relayQueueState(client, table, address),
};

/**
 * COST-2C: `HostCertReaders` -- LIVE-6's rotation and recovery readers (above, unchanged) and L5-4's `readIdentityRole`
 * (the identity table's ROLE#identity-writer item, strongly; read only).
 */
export const HOST_CERT_READERS: HostCertReaders = {
  rotation: STAGING_ROTATION_READERS,
  recovery: STAGING_RECOVERY_READERS,
  identityRole: (client, table) => readIdentityRole(client, table).then((r) => (r === null ? null : { epoch: r.epoch, task: r.task, pool: r.pool, taken_at: r.taken_at })),
};

const staging: StagingDeps = {
  recovery: STAGING_RECOVERY_READERS,
  heartbeats: STAGING_HEARTBEATS,
  rotation: STAGING_ROTATION_READERS,
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

/* COST-2C: the host drills -- the production world (the AWS CLI over SSM) is the ONLY live one. */
const hostCert: HostCertDeps = {
  world: (region) => productionHostCertWorld(region),
  readers: HOST_CERT_READERS,
  repository: staging.repository,
};

/* The CLI runs only as the entry (LIVE-6 final convergence: the DynamoDB Local suite imports the binding above). */
if (require.main === module) {
  runDeployCommand(process.argv.slice(2), deps, {
    "stage-cert": (argv) => stageCertCommand(argv, deps, staging),
    "stage-probe": (argv) => stageProbeCommand(argv, deps, staging),
    "host-cert": (argv) => hostCertCommand(argv, deps, hostCert),
  }).then(
    (code) => process.exit(code),
    (error) => {
      // eslint-disable-next-line no-console
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
