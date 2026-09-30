// server/src/aws/runtime/awsMain.ts
//
// ==================================================================
//  LIVE-5 L5-7: `start.ts`'s AWS STORAGE MODE -- READ THE REFERENCES, THE CONFIGURATION, START THE RUNTIME, EXIT CODES
// ==================================================================
//
// Reached only when `GS_STORAGE=aws` (`start.ts`); PROCESS mode never loads this file. In order:
//   1. the references (`awsStartupReferences`: production only; no data directory, no escrow file, no credentials in the
//      environment; the SSM parameter ARN of the runtime document) -- any problem: exit 2;
//   2. the runtime document from SSM (`18COSMOS/AWS-RUNTIME/v1`, a plain String parameter), then -- with escrow -- the
//      Juno configuration from its own SSM parameter, checked by `parseJunoBackendConfig` in production mode and by
//      `checkEscrowConfigForAws` (the same ledger, KMS keys only) -- any problem: exit 2. Nothing falls back: not to a
//      file, not to a development key, not to a default;
//   3. the clients (`createAwsClients`: explicit regions, the task role's credentials), the real substrate, and the
//      runtime (`startAwsRuntime`, the startup order) -- a refusal: exit 2; a loss: exit 3; a store that must restart: 4;
//      (LIVE-6 L6-1) a routing that proved this task's serving role changed: the graceful shutdown, then 5;
//   4. SIGTERM / SIGINT / SIGHUP / SIGBREAK and the IPC `shutdown` message (taken from the very start): during the startup,
//      it ends (exit 0: nothing was served); afterwards, the graceful shutdown, then the runtime's exit code -- 0, unless
//      a loss (3) or a store's restart request (4) forced the exit first, which a stop never turns into 0.
//
// WHAT IS PRINTED: component and status lines, reasons, ARNs, table names, the task id -- never a credential, a secret or
// a configuration's content (the documents hold no secret, and are still not echoed; a parse error names the field).

import { randomBytes } from "crypto";

import { compatibilityDescriptor, bannerLines } from "../../compatibilityDescriptor";
import { JunoConfigError, parseJunoBackendConfig, type JunoBackendConfig } from "../../escrow/juno/junoConfig";
import type { ServerConfig } from "../../identity/mode";
import { READY_PATH } from "../../ingress/readiness";
import { HEALTH_PATH } from "../../identity/httpApi";
import { RULES_ENGINE_VERSION, SUPPORTED_RULES_ENGINE_VERSIONS } from "../../../../frontend/src/gameEngine/rulesVersion";
import { AwsStartupError, EXIT_REFUSED, EXIT_ROLE_CHANGED, startAwsRuntime, type AwsRuntime } from "./awsRuntime";
import { createAwsClients, realAwsSubstrate } from "./awsSubstrate";
import { ssmParameterSource, type ParameterSource } from "./configSource";
import { createConsoleOpsRecorder } from "./consoleOps";
import { awsStartupReferences, checkEscrowConfigForAws, parseAwsRuntimeConfigText, type AwsRuntimeConfig } from "./runtimeConfig";

/** Where an AWS task listens: its own interface (awsvpc -- the task's ENI, which only the load balancer's security group
 *  reaches; L5-8). PROCESS mode keeps loopback (`GAME_SERVER_BIND_HOST`). */
export const AWS_BIND_HOST = "0.0.0.0";

/** The Juno configuration's file-journal check needs a data directory; an AWS task has none, and refuses a file journal
 *  anyway (`checkEscrowConfigForAws`). This path is never created or read. */
const NO_DATA_DIRECTORY = "/nonexistent/gs-aws-has-no-data-directory";

export interface AwsStartup {
  readonly config: AwsRuntimeConfig;
  readonly configVersion: number;
  readonly escrowConfig: JunoBackendConfig | null;
  readonly escrowConfigVersion: number | null;
}

/** Steps 1-2 (see the header): the references and the two documents. Throws `AwsStartupError` naming the problem. */
export async function loadAwsStartup(input: {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly serverMode: "development" | "production";
  readonly parameters: ParameterSource;
}): Promise<AwsStartup> {
  const refs = awsStartupReferences(input.argv, input.env, input.serverMode);
  if (!refs.ok) throw new AwsStartupError(refs.reason);
  let config: AwsRuntimeConfig;
  let configVersion: number;
  try {
    const read = await input.parameters.read(refs.refs.configParameter.arn);
    config = parseAwsRuntimeConfigText(read.value);
    configVersion = read.version;
  } catch (error) {
    throw new AwsStartupError(`the runtime configuration ${refs.refs.configParameter.arn} is not usable -- ${error instanceof Error ? error.message : String(error)}`);
  }
  if (config.escrow === null) return { config, configVersion, escrowConfig: null, escrowConfigVersion: null };
  const where = config.escrow.configParameter.arn;
  let escrowConfig: JunoBackendConfig;
  let escrowConfigVersion: number;
  try {
    const read = await input.parameters.read(where);
    let raw: unknown;
    try {
      raw = JSON.parse(read.value);
    } catch {
      throw new Error("it is not JSON");
    }
    escrowConfig = parseJunoBackendConfig(raw, { serverMode: "production", dataDir: NO_DATA_DIRECTORY });
    escrowConfigVersion = read.version;
  } catch (error) {
    throw new AwsStartupError(`the escrow configuration ${where} is not usable -- ${error instanceof JunoConfigError || error instanceof Error ? error.message : String(error)}`);
  }
  const problems = checkEscrowConfigForAws(escrowConfig, config);
  if (problems.length > 0) throw new AwsStartupError(`the escrow configuration ${where} cannot run on AWS storage -- ${problems.join("; ")}`);
  return { config, configVersion, escrowConfig, escrowConfigVersion };
}

/** A task id: new for every process (a restart is a new task), never an ARN (1-128 printable characters). */
export const newTaskId = (): string => `t-${randomBytes(8).toString("hex")}`;

/** `start.ts`, with `GS_STORAGE=aws`. Never returns normally before the process exits on a signal. */
export async function runAwsStorageMode(input: { readonly argv: readonly string[]; readonly env: NodeJS.ProcessEnv; readonly server: ServerConfig; readonly build: string; readonly port: number }): Promise<void> {
  /* eslint-disable no-console */
  let exited = false;
  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  const refuse = (reason: string, code: number = EXIT_REFUSED) => {
    console.error(code === 0 ? `Stopped during startup: ${reason}` : `Refusing to start: ${reason}`);
    exit(code);
  };

  /* The stop signals are taken from the very start: a stop asked for while the task is still starting ends the startup
     (nothing was served: exit 0), and one asked for later runs the graceful shutdown -- then exits with the runtime's
     code, which is 0 unless a loss (3) or a store's restart request (4) forced the exit first. */
  let runtime: AwsRuntime | null = null;
  let stopRequested = false;
  const stop = () => {
    stopRequested = true;
    const started = runtime;
    if (started === null) return; // the startup sees the request and ends
    void started
      .shutdown()
      .catch((error) => console.error(`  aws: the graceful shutdown failed -- ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        /* A forced exit (3 at once, 4 after its short delay) is already under way and keeps its own code and timing: the
           shutdown did nothing for it, and this never turns it into 0. */
        const code = started.exitCode();
        if (code === null) exit(0);
        /* LIVE-6 L6-1: a role change under way exits with its own code (the runtime exits it too; the first exit wins). */
        else if (code === EXIT_ROLE_CHANGED) exit(code);
      });
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    try {
      process.on(signal, stop);
    } catch {
      // a signal this platform does not have
    }
  }
  if (typeof process.send === "function") {
    process.on("message", (message) => {
      if (message === "shutdown") stop();
    });
  }

  let startup: AwsStartup;
  try {
    startup = await loadAwsStartup({ argv: input.argv, env: input.env, serverMode: input.server.mode, parameters: ssmParameterSource() });
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
  if (stopRequested) return refuse("a stop was asked for before the runtime started; nothing was touched", 0);
  const { config } = startup;
  const task = newTaskId();
  console.log(
    `  aws: runtime configuration v${startup.configVersion} (${config.format})` +
      (startup.escrowConfigVersion === null ? "" : `; escrow configuration v${startup.escrowConfigVersion} (${startup.escrowConfig?.format ?? "?"})`) +
      "; credentials: the task role (SDK default chain), never the environment",
  );
  const ops = createConsoleOpsRecorder({ build: input.build, task, pool: config.pool, now: () => Date.now(), write: (line) => console.log(line) });

  try {
    runtime = await startAwsRuntime({
      config,
      escrowConfig: startup.escrowConfig,
      server: input.server,
      build: input.build,
      port: input.port,
      bindHost: AWS_BIND_HOST,
      moneySwitch: input.env.ESCROW_MONEY_TABLES ?? flagValue(input.argv, "--money-tables"),
      task,
      substrate: realAwsSubstrate({ config, clients: createAwsClients(config) }),
      ops,
      now: () => Date.now(),
      log: (line) => console.log(line),
      warn: (line) => console.warn(line),
      error: (line) => console.error(line),
      exit,
      stopRequested: () => stopRequested,
    });
  } catch (error) {
    if (error instanceof AwsStartupError) return refuse(error.message, error.exitCode);
    return refuse(`the AWS runtime could not start -- ${error instanceof Error ? error.message : String(error)}`);
  }
  printAwsBanner(runtime, config, input);
  /* A stop that arrived in the last moments of the startup (after its last check) is honoured now. */
  if (stopRequested) stop();
  /* eslint-enable no-console */
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function printAwsBanner(runtime: AwsRuntime, config: AwsRuntimeConfig, input: { readonly server: ServerConfig; readonly build: string; readonly port: number }): void {
  const lines = [
    `1830 game server listening on ws://${AWS_BIND_HOST}:${input.port} (build "${input.build}", GS_MODE=${input.server.mode}, GS_STORAGE=aws, ${runtime.role.toUpperCase()})`,
    `  PRODUCTION IDENTITY: the session cookie, bootstrapped at POST /gs/api/session; trusted proxy hops ${input.server.trustedProxyHops}; allowed origins ${input.server.allowedOrigins.join(", ")}`,
    `  storage: DynamoDB (game ${config.gameTable}, identity ${config.identityTable}, ledger ${config.ledger.arn}); pool ${config.pool}, generation ${config.generation}, task ${runtime.task}`,
    `  liveness ${HEALTH_PATH} (always 200 while the process answers); readiness ${READY_PATH} (200 only while this task may serve: ${runtime.readiness().ready ? "READY" : `not ready -- ${runtime.readiness().reasons.join(", ")}`})`,
    "  EDGE REQUIREMENT: the CDN / load balancer must forward /gs* query strings unchanged (the socket's cp, cr, cb announcement), or current clients read as legacy ones",
    /* LIVE-6 L6-1: where a game another pool serves is routed (paths only, from this trusted document). */
    Object.keys(config.routes).length === 0
      ? `  routes: none (${config.format}): a game this task does not serve is answered unavailable, as before`
      : `  routes (${config.format}): ${Object.entries(config.routes).map(([pool, entry]) => `${pool} -> ${entry.wsPath}${entry.bundlePath !== undefined ? ` (bundle ${entry.bundlePath})` : ""}`).join(", ")}; the load balancer must send each ws_path to its pool; a routing flip restarts a task into its new role (exit 5)`,
    `  rules engine version ${RULES_ENGINE_VERSION} (supports [${SUPPORTED_RULES_ENGINE_VERSIONS.join(", ")}]); an unpinned (legacy) log is held, not replayed (#1520)`,
  ];
  if (runtime.server !== null) lines.push(...bannerLines(compatibilityDescriptor(runtime.server.lifecycle.capability, { build_id: input.build })));
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}
