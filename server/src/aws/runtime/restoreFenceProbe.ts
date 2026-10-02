// server/src/aws/runtime/restoreFenceProbe.ts
//
// ==================================================================
//  LIVE-6 L6-6 (RESTORE DRILL): THE OLD GENERATION, FENCED -- A STANDALONE PROBE OVER THE PRODUCTION FENCES, AFTER ADOPTION
// ==================================================================
//
// After a restore's APPGEN adoption (generation N -> M), the staging certification must show, from the real deployment,
// that the OLD generation can do nothing (`recovery.ts` judgeRestoreFencing, unchanged). Owner decision: no temporary
// serving pool and no old-generation SSM runtime -- this probe runs as a STANDALONE, command-overridden ECS task of a
// pool's running task definition (the task role; GS_STORAGE overridden to a value start.ts refuses, so a lost override
// starts no server), and exercises the PRODUCTION code with explicit old-generation facts:
//
//   ledger-kms
//     old-generation-ledger-write-refused   ONE TransactWriteItems carrying THE ledger's generation fence for generation N
//         (`generationConditionCheck`, the builder every ledger write uses) plus a disposable Put of `L6CERT#<run>` /
//         `RESTORE-FENCE` whose own condition (`attribute_exists(pk)` on a key that never exists) can never hold -- so the
//         transaction can never commit, whatever the fence says: no financial operation, nothing written, ever. A CONTROL
//         sends the same transaction with the fence for generation M. FENCED BY GENERATION only when: the old send's
//         fence term failed (ConditionalCheckFailed at its index), the control's fence term passed (None) while its
//         guard failed, and APPGEN read strongly before and after is M. Any other answer is recorded as what it was.
//     kms-side-effect-withheld   THE KMS gate (`gatedKmsClient`, every KMS Sign of an AWS task passes it) with the pool
//         writer's generation check (`generationProbe`, the probe the pool writer's self-check consults for the
//         generation) as its gate, configured for generation N, over a KMS port that only COUNTS a Sign (it never reaches
//         KMS: no key is ever used). WITHHELD only when the Sign is refused `unavailable` / `PoolWriterNotCurrent` with
//         no possible signature, the gate counted one withheld Sign, and the port saw zero calls. The pool part of the
//         self-check is not exercised: this probe takes no pool (by design).
//   old-task
//     old-generation-task-never-ready   THE production startup (`startAwsRuntime`) with the runtime document's
//         configuration but generation N and N's game table -- a task configured for the old generation -- over the real
//         substrate's three step-1 READS only (APPGEN, SYSTEM/GENERATION, the adoption binding); every other substrate
//         method (the pool takeover first of all) is a boundary that refuses and is recorded. Its metrics go to a
//         capture, never to stdout (no real alarm is tripped). NEVER READY only when the startup was refused
//         (`AwsStartupError`, exit 2) for the refusal class `generation` (the runtime's own class, from its own metric
//         record), no boundary was reached and no runtime came up. The task then exits with that very exit code.
//
// BEFORE ANYTHING: APPGEN is read strictly and must show THIS adoption (M adopted from N, this restore id, the document's
// table); the runtime document must name M. Otherwise the probe refuses to run (exit FENCE_PROBE_REFUSED_EXIT) -- it never
// exercises a fence that has not moved. One log line carries the answer (`controlPlane/restoreFence.ts`).

import { createHash } from "crypto";
import { TransactWriteItemsCommand, type DynamoDBClient, type TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { FENCE_PROBE_REFUSED_EXIT, fenceProbeLedgerKey, fenceProbeLine, parseFenceProbeArgs, RESTORE_FENCE_PROBE_FORMAT, type FenceProbeArgs } from "../controlPlane/restoreFence";
import { readAppGeneration } from "../ledger/appGeneration";
import { generationConditionCheck, readAdoptedGeneration } from "../ledger/dynamoSigningLedger";
import { generationProbe } from "../ownership/roles";
import { SignerError, type KmsClient } from "../../escrow/juno/signer";
import { AwsStartupError, startAwsRuntime, type AwsSubstrate } from "./awsRuntime";
import type { AwsStartup } from "./awsMain";
import { gatedKmsClient } from "./kmsGate";
import type { MetricRecord, MetricSink } from "./runtimeMetrics";
import type { AwsRuntimeConfig } from "./runtimeConfig";

export interface FenceProbeDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  readonly out: (line: string) => void;
  /** The task's own runtime document and escrow configuration (`loadAwsStartup` with the task's references). */
  readonly loadStartup: () => Promise<AwsStartup>;
  /** The DynamoDB clients for a configuration (`createAwsClients`). */
  readonly clients: (config: AwsRuntimeConfig) => { readonly app: DynamoDBClient; readonly ledger: DynamoDBClient };
  /** The real substrate for a configuration (`realAwsSubstrate`): only its three step-1 reads are ever used. */
  readonly substrate: (config: AwsRuntimeConfig, clients: { readonly app: DynamoDBClient; readonly ledger: DynamoDBClient }, tables: { readonly game: string; readonly identity: string; readonly ledger: string }) => Pick<AwsSubstrate, "adoptedGeneration" | "tableGeneration" | "adoptionBinding">;
  /** Tests only: the tables the clients address (production: the document's names and the ledger's ARN). */
  readonly tables?: (config: AwsRuntimeConfig) => { readonly game: string; readonly identity: string; readonly ledger: string };
  /** This task's ARN (the task metadata endpoint), or null. */
  readonly taskArn: () => Promise<string | null>;
}

const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/arn:[^\s"',]*/g, "<arn>").slice(0, 300);
const isoOf = (ms: number): string => new Date(ms).toISOString();

type Sent = { readonly kind: "committed" } | { readonly kind: "cancelled"; readonly codes: readonly string[] } | { readonly kind: "error"; readonly name: string };

async function send(client: DynamoDBClient, items: TransactWriteItem[], token: string): Promise<Sent> {
  try {
    await client.send(new TransactWriteItemsCommand({ TransactItems: items, ClientRequestToken: token }), { abortSignal: deadline() });
    return { kind: "committed" };
  } catch (error) {
    const name = (error as { name?: string }).name ?? "Error";
    if (name === "TransactionCanceledException") return { kind: "cancelled", codes: ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).map((r) => r.Code ?? "None") };
    return { kind: "error", name: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "Error" };
  }
}

const codesOf = (s: Sent): readonly string[] | null => (s.kind === "cancelled" ? s.codes : null);
const sentText = (s: Sent): string => (s.kind === "cancelled" ? `cancelled [${s.codes.join(", ")}]` : s.kind === "error" ? `refused before evaluation (${s.name})` : "COMMITTED");

/** old-generation-ledger-write-refused (see the header). */
async function ledgerCase(deps: FenceProbeDeps, a: FenceProbeArgs, ledger: DynamoDBClient, table: string): Promise<Record<string, unknown>> {
  const key = fenceProbeLedgerKey(a.run);
  /* The guard can never hold (attribute_exists on a key nothing ever writes): this transaction can never commit. */
  const guard: TransactWriteItem = { Put: { TableName: table, Item: { pk: { S: key.pk }, sk: { S: key.sk }, kind: { S: "l6-6-restore-fence-never-written" } }, ConditionExpression: "attribute_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" } } };
  const token = (salt: string) => createHash("sha256").update(`l6-6-restore-fence ${a.run} ${salt} ${deps.now()}`).digest("hex").slice(0, 32);
  let before: number | null = null;
  let after: number | null = null;
  try {
    before = await readAdoptedGeneration(ledger, table);
  } catch {
    before = null;
  }
  const old = await send(ledger, [generationConditionCheck(table, a.previousGeneration), guard], token("old"));
  const control = await send(ledger, [generationConditionCheck(table, a.generation), guard], token("control"));
  try {
    after = await readAdoptedGeneration(ledger, table);
  } catch {
    after = null;
  }
  const oldCodes = codesOf(old);
  const controlCodes = codesOf(control);
  const fenced = oldCodes !== null && oldCodes[0] === "ConditionalCheckFailed" && controlCodes !== null && controlCodes[0] === "None" && controlCodes[1] === "ConditionalCheckFailed" && before === a.generation && after === a.generation;
  return {
    observed_at: isoOf(deps.now()),
    generation: a.previousGeneration,
    outcome: old.kind === "committed" || control.kind === "committed" ? "committed" : fenced ? "fenced" : "not-fenced",
    fence: fenced ? "generation" : null,
    detail: fenced
      ? `a ledger write of generation ${a.previousGeneration} was refused by APPGEN's ConditionCheck (APPGEN is ${a.generation}); the same write with generation ${a.generation}'s fence passed it -- nothing was written (the disposable guard never holds)`
      : `old ${sentText(old)}, control ${sentText(control)}, APPGEN ${String(before)} -> ${String(after)}: not shown fenced by the generation`,
    evidence: {
      fence_term: `ConditionCheck APPGEN: schema = 1 AND current_generation = ${a.previousGeneration}`,
      old: { codes: oldCodes, outcome: old.kind, ...(old.kind === "error" ? { error: old.name } : {}) },
      control: { generation: a.generation, codes: controlCodes, outcome: control.kind, ...(control.kind === "error" ? { error: control.name } : {}) },
      appgen_before: before,
      appgen_after: after,
      disposable_key: `${key.pk}/${key.sk}`,
      written: old.kind === "committed" || control.kind === "committed",
    },
  };
}

/** kms-side-effect-withheld (see the header). */
async function kmsCase(deps: FenceProbeDeps, a: FenceProbeArgs, ledger: DynamoDBClient, table: string): Promise<Record<string, unknown>> {
  let calls = 0;
  const port: KmsClient = {
    async getPublicKey() {
      throw new Error("the restore fence probe never reads a KMS key");
    },
    async signDigest() {
      calls += 1;
      throw new Error("the restore fence probe's KMS port never signs");
    },
  };
  const probe = generationProbe(ledger, table, a.previousGeneration);
  let gateDetail: string | null = null;
  const gated = gatedKmsClient(port, {
    gate: async () => {
      const answer = await probe.check();
      if (!answer.held) {
        gateDetail = answer.detail;
        throw new Error(`the adopted app generation moved: ${answer.detail}`);
      }
    },
    now: deps.now,
    warn: () => undefined,
  });
  const digest = createHash("sha256").update(`l6-6 restore fence probe ${a.run}`).digest();
  let error: unknown = null;
  try {
    await gated.client.signDigest("l6-6-restore-fence-probe-never-signs", Uint8Array.from(digest));
  } catch (e) {
    error = e;
  }
  const signer = error instanceof SignerError ? error : null;
  const withheld = signer !== null && signer.code === "unavailable" && signer.detail.native === "PoolWriterNotCurrent" && signer.detail.signatureMayExist === false && gated.counters.withheld === 1 && gated.counters.signs === 0 && calls === 0 && gateDetail !== null;
  return {
    observed_at: isoOf(deps.now()),
    generation: a.previousGeneration,
    kms_sign_calls: calls,
    outcome: withheld ? "withheld" : "not-withheld",
    detail: withheld ? `the KMS gate withheld a Sign of generation ${a.previousGeneration} before KMS: ${String(gateDetail)}` : `KMS port calls ${calls}, withheld ${gated.counters.withheld}, error ${error === null ? "none (signed?)" : describe(error)}`,
    evidence: {
      gate: "generation",
      gate_detail: gateDetail,
      withheld_counter: gated.counters.withheld,
      signs_counter: gated.counters.signs,
      error_code: signer?.code ?? null,
      native: signer?.detail.native ?? null,
      signature_may_exist: signer?.detail.signatureMayExist ?? null,
    },
  };
}

/** old-generation-task-never-ready (see the header). Returns the case and the runtime's exit code (null: none decided). */
async function oldTaskCase(deps: FenceProbeDeps, a: FenceProbeArgs, startup: AwsStartup, clients: { readonly app: DynamoDBClient; readonly ledger: DynamoDBClient }, tables: { readonly game: string; readonly identity: string; readonly ledger: string }): Promise<{ readonly value: Record<string, unknown>; readonly exit: number | null }> {
  const oldConfig: AwsRuntimeConfig = { ...startup.config, generation: a.previousGeneration, gameTable: a.oldGameTable };
  const reads = deps.substrate(oldConfig, clients, { ...tables, game: a.oldGameTable });
  const boundary: string[] = [];
  const never = (name: string) => () => {
    boundary.push(name);
    throw new Error(`the restore fence probe never reaches ${name}: a task of the old generation must stop before it`);
  };
  const substrate: AwsSubstrate = {
    adoptedGeneration: () => reads.adoptedGeneration(),
    tableGeneration: () => reads.tableGeneration(),
    adoptionBinding: () => reads.adoptionBinding(),
    takePool: never("takePool") as AwsSubstrate["takePool"],
    generationProbe: never("generationProbe") as AwsSubstrate["generationProbe"],
    takeIdentityWriterRole: never("takeIdentityWriterRole") as AwsSubstrate["takeIdentityWriterRole"],
    openIdentityStore: never("openIdentityStore") as AwsSubstrate["openIdentityStore"],
    securityJournal: never("securityJournal") as AwsSubstrate["securityJournal"],
    openLedger: never("openLedger") as AwsSubstrate["openLedger"],
    takeRelayerRole: never("takeRelayerRole") as AwsSubstrate["takeRelayerRole"],
    gameStores: never("gameStores") as AwsSubstrate["gameStores"],
    ownership: never("ownership") as AwsSubstrate["ownership"],
    kms: never("kms") as AwsSubstrate["kms"],
    readRouting: never("readRouting") as AwsSubstrate["readRouting"],
    identityVerifier: never("identityVerifier") as AwsSubstrate["identityVerifier"],
    gameDirectory: never("gameDirectory") as AwsSubstrate["gameDirectory"],
    taskStatus: never("taskStatus") as NonNullable<AwsSubstrate["taskStatus"]>,
  };
  /* The runtime's metrics are CAPTURED (the evidence of its refusal class), never written to stdout: no alarm is tripped. */
  const captured: MetricRecord[] = [];
  const metrics: MetricSink = { emit: (record) => (captured.push(record), true), failures: () => 0 };
  const steps: string[] = [];
  let exitAsked: number | null = null;
  let error: unknown = null;
  let ready = false;
  let runtimeUp = false;
  try {
    const runtime = await startAwsRuntime({
      config: oldConfig,
      escrowConfig: startup.escrowConfig,
      server: { mode: "production", allowedOrigins: [], trustedProxyHops: 2 },
      build: deps.env.BUILD_ID ?? "restore-fence-probe",
      port: 0,
      bindHost: "127.0.0.1",
      moneySwitch: undefined,
      task: `l6-6-fence-${a.run}`,
      substrate,
      ops: { audit: () => undefined, status: () => undefined, flush: () => Promise.resolve() },
      metrics,
      now: deps.now,
      log: (line) => steps.push(line.trim().slice(0, 160)),
      warn: () => undefined,
      error: () => undefined,
      exit: (code) => {
        exitAsked ??= code;
      },
      stopRequested: () => false,
    });
    runtimeUp = true;
    ready = runtime.readiness().ready;
    await runtime.shutdown().catch(() => undefined);
  } catch (e) {
    error = e;
  }
  const refusedRecord = captured.find((r) => r.event === "startup-refused");
  const refusal = typeof refusedRecord?.properties?.refusal === "string" ? refusedRecord.properties.refusal : null;
  const exit = error instanceof AwsStartupError ? error.exitCode : exitAsked;
  const neverReady = !runtimeUp && !ready && error instanceof AwsStartupError && (exit === 2 || exit === 3) && refusal === "generation" && boundary.length === 0;
  return {
    exit,
    value: {
      observed_at: isoOf(deps.now()),
      generation: a.previousGeneration,
      game_table: a.oldGameTable,
      ready,
      exit_code: exit,
      reason: neverReady ? "generation" : refusal,
      detail: neverReady
        ? `the production startup, configured for generation ${a.previousGeneration} (${a.oldGameTable}), refused before the pool (exit ${String(exit)}, refusal class generation): ${error instanceof Error ? error.message.slice(0, 200) : ""}`
        : `runtime up ${String(runtimeUp)}, ready ${String(ready)}, exit ${String(exit)}, refusal ${String(refusal)}, boundary reached [${boundary.join(", ")}], error ${error === null ? "none" : describe(error)}`,
      evidence: {
        startup_error: error instanceof Error ? error.name : null,
        refusal,
        metrics: refusedRecord === undefined ? null : refusedRecord.metrics,
        boundary_calls: boundary,
        runtime_started: runtimeUp,
        startup_lines: steps.length,
      },
    },
  };
}

/** Run the probe; prints its one line; resolves the process's exit code. */
export async function runRestoreFenceProbe(argv: readonly string[], deps: FenceProbeDeps): Promise<number> {
  const startedAt = deps.now();
  const parsed = parseFenceProbeArgs(argv);
  const base = (a: Partial<FenceProbeArgs>) => ({ format: RESTORE_FENCE_PROBE_FORMAT, mode: a.mode ?? null, run_id: a.run ?? null, environment: a.environment ?? null, pool: a.pool ?? null, build_id: deps.env.BUILD_ID ?? null, started_at: isoOf(startedAt) });
  const refuse = async (a: Partial<FenceProbeArgs>, why: string, adoption: unknown = null): Promise<number> => {
    deps.out(fenceProbeLine({ ...base(a), task_arn: await deps.taskArn().catch(() => null), adoption, refused: why.slice(0, 400), cases: {}, finished_at: isoOf(deps.now()) }));
    return FENCE_PROBE_REFUSED_EXIT;
  };
  if ("problem" in parsed) return refuse({}, parsed.problem);
  const a = parsed;
  let startup: AwsStartup;
  try {
    startup = await deps.loadStartup();
  } catch (error) {
    return refuse(a, `the runtime document could not be loaded (${describe(error)})`);
  }
  const config = startup.config;
  if (config.environment !== a.environment || config.pool !== a.pool) return refuse(a, `the task's runtime document is ${config.environment}/${config.pool}, not ${a.environment}/${a.pool}`);
  if (config.generation !== a.generation) return refuse(a, `the task's runtime document serves generation ${config.generation}, not the adopted ${a.generation}: switch the document after the adoption first`);
  if (config.gameTable === a.oldGameTable) return refuse(a, "the old game table is the document's own table");
  const clients = deps.clients(config);
  const tables = deps.tables?.(config) ?? { game: config.gameTable, identity: config.identityTable, ledger: config.ledger.arn };
  /* This adoption, read strictly, before any fence is exercised. */
  let appgen;
  try {
    appgen = await readAppGeneration(clients.ledger, tables.ledger);
  } catch (error) {
    return refuse(a, `APPGEN could not be read (${describe(error)})`);
  }
  const ad = appgen?.adoption ?? null;
  const adoption = appgen === null || ad === null ? null : { restore_id: ad.restore_id, previous_generation: ad.previous_generation, generation: appgen.current_generation, game_table: ad.game_table, adopted_at: ad.adopted_at };
  if (adoption === null) return refuse(a, "APPGEN shows no adoption: the old generation is not fenced yet (run the probe only after appgen-adopt)");
  if (adoption.generation !== a.generation || adoption.previous_generation !== a.previousGeneration || adoption.restore_id !== a.restoreId || adoption.game_table !== config.gameTable) {
    return refuse(a, `APPGEN adopted ${adoption.previous_generation} -> ${adoption.generation} (${adoption.game_table}, restore ${adoption.restore_id}), not ${a.previousGeneration} -> ${a.generation} (${config.gameTable}, restore ${a.restoreId})`, adoption);
  }
  if (deps.now() < adoption.adopted_at) return refuse(a, "this task's clock is before the adoption", adoption);
  const cases: Record<string, unknown> = {};
  let exit = 0;
  if (a.mode === "ledger-kms") {
    cases["old-generation-ledger-write-refused"] = await ledgerCase(deps, a, clients.ledger, tables.ledger);
    cases["kms-side-effect-withheld"] = await kmsCase(deps, a, clients.ledger, tables.ledger);
  } else {
    const old = await oldTaskCase(deps, a, startup, clients, tables);
    cases["old-generation-task-never-ready"] = old.value;
    exit = old.exit === 2 || old.exit === 3 ? old.exit : 1;
  }
  deps.out(fenceProbeLine({ ...base(a), task_arn: await deps.taskArn().catch(() => null), runtime_parameter: deps.env.GS_AWS_CONFIG_PARAMETER ?? null, adoption, refused: null, cases, finished_at: isoOf(deps.now()) }));
  return exit;
}

/* ------------------------------------------------------------------ */
/* The task's entry                                                     */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  /* Loaded only as the probe task's own command (never by the game server or start.ts). */
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { loadAwsStartup } = require("./awsMain") as typeof import("./awsMain");
  const { ssmParameterSource } = require("./configSource") as typeof import("./configSource");
  const { createAwsClients, realAwsSubstrate } = require("./awsSubstrate") as typeof import("./awsSubstrate");
  const http = require("http") as typeof import("http");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const taskArn = (): Promise<string | null> => {
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
  };
  runRestoreFenceProbe(process.argv.slice(2), {
    env: process.env,
    now: () => Date.now(),
    // eslint-disable-next-line no-console
    out: (line) => console.log(line),
    loadStartup: () => loadAwsStartup({ argv: [], env: process.env, serverMode: "production", parameters: ssmParameterSource() }),
    clients: (config) => createAwsClients(config),
    substrate: (config, clients, tables) => realAwsSubstrate({ config, clients, tables }),
    taskArn,
  }).then(
    (code) => setTimeout(() => process.exit(code), 1_000),
    (error) => {
      // eslint-disable-next-line no-console
      console.error(`restore fence probe: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
