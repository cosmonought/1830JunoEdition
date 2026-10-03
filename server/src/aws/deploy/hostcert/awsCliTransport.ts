// server/src/aws/deploy/hostcert/awsCliTransport.ts
//
// COST-2C: the PRODUCTION host transport and fleet view -- the AWS CLI v2 (as infra/aws/single-host/gs-host.sh uses it),
// run with ARGUMENT ARRAYS through `execFile` (never a shell), with the operator's default credential chain.
//
//   host operations   `aws ssm send-command --document-name AWS-RunShellScript` with ONE command line that decodes the
//                     fixed, validated template (`hostOps.ts`, base64) into a temporary file and runs it with bash as
//                     root; then `aws ssm get-command-invocation` until the invocation ends. Its CommandId is kept for
//                     the evidence (an auditor can find each step in SSM's history and CloudTrail).
//   fleet reads       `aws ec2 describe-instances` (tags gs:component=single-host, gs:environment=<env>),
//                     `aws ec2 describe-addresses --public-ips`, `aws ecs list-tasks --desired-status RUNNING`.
//
// Needs: ssm:SendCommand (AWS-RunShellScript, on the host instance), ssm:GetCommandInvocation, ec2:DescribeInstances,
// ec2:DescribeAddresses, ecs:ListTasks. Nothing here reads or prints a credential: the CLI's own chain supplies it, and
// only the host's framed answer, identifiers and states are kept.
//
// `productionHostCertWorld` is the ONLY world `isLiveWorld` accepts: a world built over a stub CLI
// (`createSsmHostTransport` / `createCliFleetView` with a fake `AwsCli`, as the offline tests do) is never live.

import { execFile } from "child_process";

import { hostOpProblem, hostScript, OP_TIMEOUTS, type HostOp } from "./hostOps";
import { type AddressOwner, type FleetInstance, type FleetRead, type FleetView, type HostCertWorld, type HostRun, type HostTransport } from "./transport";

/* Module-private (review R5): nothing outside this file can add to it. The world AND its host and fleet are branded and
   frozen, so a branded world cannot have its parts swapped for fakes. */
const LIVE = new WeakSet<object>();

/** Whether `world` is THE production world (the real AWS CLI over SSM), unaltered. A fake, a copy, a world with a swapped
 *  part, or anything a test built: no. */
export const isLiveWorld = (world: HostCertWorld): boolean => LIVE.has(world) && LIVE.has(world.host) && LIVE.has(world.fleet) && Object.isFrozen(world) && Object.isFrozen(world.host) && Object.isFrozen(world.fleet);

export interface AwsCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One AWS CLI invocation: argv WITHOUT the leading `aws`; never through a shell. */
export type AwsCli = (args: readonly string[], timeoutMs: number) => Promise<AwsCliResult>;

const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const CLUSTER = /^[A-Za-z0-9_-]{1,255}$/;
const COMMAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const short = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 240);

/** The ONE remote command line: decode the template, run it with bash, remove it, return its status. */
export function ssmCommandLine(op: HostOp): string {
  const script = hostScript(op);
  const b64 = Buffer.from(script, "utf8").toString("base64");
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error("host-cert: base64 produced an unexpected character");
  return `f="$(mktemp)" && printf '%s' '${b64}' | base64 -d >"$f" && bash "$f"; rc=$?; rm -f "$f"; exit $rc`;
}

export interface SsmTransportOptions {
  readonly region: string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs?: number;
}

/** The host transport over a given CLI (the production world passes the real one; tests a stub). Never branded live. */
export function createSsmHostTransport(cli: AwsCli, options: SsmTransportOptions): HostTransport {
  if (!REGION.test(options.region)) throw new Error("host-cert: --region must be an AWS region");
  const poll = options.pollMs ?? 3_000;
  return {
    label: "aws-cli-ssm",
    async run(instanceId: string, op: HostOp): Promise<HostRun> {
      if (!INSTANCE_ID.test(instanceId)) return { ok: false, detail: "not an instance id", commandId: null };
      const problem = hostOpProblem(op);
      if (problem !== null) return { ok: false, detail: `refused before sending: ${problem}`, commandId: null };
      const limits = OP_TIMEOUTS[op.kind];
      const parameters = JSON.stringify({ commands: [ssmCommandLine(op)], executionTimeout: [String(limits.execution)] });
      let send: AwsCliResult;
      try {
        send = await cli(
          ["ssm", "send-command", "--region", options.region, "--instance-ids", instanceId, "--document-name", "AWS-RunShellScript", "--comment", `gs-host-cert ${op.kind} ${op.run}`, "--parameters", parameters, "--timeout-seconds", String(Math.max(30, limits.delivery)), "--query", "Command.CommandId", "--output", "text"],
          60_000,
        );
      } catch (error) {
        return { ok: false, detail: `send-command could not run: ${short(error instanceof Error ? error.message : String(error))}`, commandId: null };
      }
      const commandId = send.stdout.trim();
      if (send.exitCode !== 0 || !COMMAND_ID.test(commandId)) return { ok: false, detail: `send-command failed (exit ${send.exitCode}): ${short(send.stderr)}`, commandId: null };
      const deadline = (limits.delivery + limits.execution + 120) * 1_000;
      let waited = 0;
      for (;;) {
        await options.sleep(poll);
        waited += poll;
        let got: AwsCliResult;
        try {
          got = await cli(["ssm", "get-command-invocation", "--region", options.region, "--command-id", commandId, "--instance-id", instanceId, "--output", "json"], 60_000);
        } catch (error) {
          if (waited >= deadline) return { ok: false, detail: `get-command-invocation could not run: ${short(error instanceof Error ? error.message : String(error))}`, commandId };
          continue;
        }
        if (got.exitCode !== 0) {
          /* InvocationDoesNotExist right after the send is normal; anything persisting past the deadline is unknown. */
          if (waited >= deadline) return { ok: false, detail: `get-command-invocation failed (exit ${got.exitCode}): ${short(got.stderr)}`, commandId };
          continue;
        }
        let invocation: { Status?: unknown; ResponseCode?: unknown; StandardOutputContent?: unknown; StandardErrorContent?: unknown };
        try {
          invocation = JSON.parse(got.stdout) as typeof invocation;
        } catch {
          return { ok: false, detail: "get-command-invocation answered something that is not JSON", commandId };
        }
        const status = typeof invocation.Status === "string" ? invocation.Status : "";
        if (status === "Pending" || status === "InProgress" || status === "Delayed") {
          if (waited >= deadline) return { ok: false, detail: `the command is still ${status} after ${Math.round(waited / 1000)} s`, commandId };
          continue;
        }
        if (status !== "Success" && status !== "Failed") return { ok: false, detail: `the command ended ${status || "in an unknown state"} (not delivered or not completed: nothing is known of its effect)`, commandId };
        const code = typeof invocation.ResponseCode === "number" && Number.isInteger(invocation.ResponseCode) ? invocation.ResponseCode : null;
        if (code === null) return { ok: false, detail: "the invocation has no response code", commandId };
        return { ok: true, exitCode: code, stdout: typeof invocation.StandardOutputContent === "string" ? invocation.StandardOutputContent : "", stderr: typeof invocation.StandardErrorContent === "string" ? invocation.StandardErrorContent : "", commandId };
      }
    },
  };
}

type Json = unknown;
const asObj = (v: Json): Record<string, Json> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, Json>) : {});
const asArr = (v: Json): Json[] => (Array.isArray(v) ? v : []);
const asStr = (v: Json): string | null => (typeof v === "string" ? v : null);

const instanceOf = (raw: Json): FleetInstance | null => {
  const i = asObj(raw);
  const id = asStr(i.InstanceId);
  const state = asStr(asObj(i.State).Name);
  if (id === null || !INSTANCE_ID.test(id) || state === null) return null;
  return { instanceId: id, state, publicIp: asStr(i.PublicIpAddress), launchTime: asStr(i.LaunchTime) };
};

async function cliJson(cli: AwsCli, args: readonly string[]): Promise<{ readonly ok: true; readonly value: Json } | { readonly ok: false; readonly detail: string; readonly stderr: string }> {
  let r: AwsCliResult;
  try {
    r = await cli([...args, "--output", "json"], 60_000);
  } catch (error) {
    return { ok: false, detail: short(error instanceof Error ? error.message : String(error)), stderr: "" };
  }
  if (r.exitCode !== 0) return { ok: false, detail: `exit ${r.exitCode}: ${short(r.stderr)}`, stderr: r.stderr };
  try {
    return { ok: true, value: JSON.parse(r.stdout) as Json };
  } catch {
    return { ok: false, detail: "the answer is not JSON", stderr: "" };
  }
}

/** The fleet view over a given CLI (production: the real one). Every read either answers completely or says why not. */
export function createCliFleetView(cli: AwsCli, region: string): FleetView {
  if (!REGION.test(region)) throw new Error("host-cert: --region must be an AWS region");
  const instancesFrom = (value: Json): FleetInstance[] | null => {
    const out: FleetInstance[] = [];
    for (const reservation of asArr(asObj(value).Reservations)) {
      for (const raw of asArr(asObj(reservation).Instances)) {
        const inst = instanceOf(raw);
        if (inst === null) return null;
        out.push(inst);
      }
    }
    return out;
  };
  return {
    async hostInstances(environment: string): Promise<FleetRead<readonly FleetInstance[]>> {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(environment)) return { ok: false, detail: "not an environment name" };
      const r = await cliJson(cli, ["ec2", "describe-instances", "--region", region, "--filters", "Name=tag:gs:component,Values=single-host", `Name=tag:gs:environment,Values=${environment}`, "Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down"]);
      if (!r.ok) return { ok: false, detail: `describe-instances: ${r.detail}` };
      const list = instancesFrom(r.value);
      return list === null ? { ok: false, detail: "describe-instances answered an instance this tool cannot read" } : { ok: true, value: list };
    },
    async instance(instanceId: string): Promise<FleetRead<FleetInstance | null>> {
      if (!INSTANCE_ID.test(instanceId)) return { ok: false, detail: "not an instance id" };
      const r = await cliJson(cli, ["ec2", "describe-instances", "--region", region, "--instance-ids", instanceId]);
      if (!r.ok) return /InvalidInstanceID\.NotFound/.test(r.stderr) ? { ok: true, value: null } : { ok: false, detail: `describe-instances: ${r.detail}` };
      const list = instancesFrom(r.value);
      if (list === null || list.length > 1) return { ok: false, detail: "describe-instances answered something this tool cannot read" };
      if (list.length === 0 || list[0].state === "terminated") return { ok: true, value: null };
      return { ok: true, value: list[0] };
    },
    async addressOwner(publicIp: string): Promise<FleetRead<AddressOwner | null>> {
      if (!IPV4.test(publicIp)) return { ok: false, detail: "not an IPv4 address" };
      const r = await cliJson(cli, ["ec2", "describe-addresses", "--region", region, "--public-ips", publicIp]);
      if (!r.ok) return /InvalidAddress\.NotFound/.test(r.stderr) ? { ok: true, value: null } : { ok: false, detail: `describe-addresses: ${r.detail}` };
      const addresses = asArr(asObj(r.value).Addresses);
      if (addresses.length === 0) return { ok: true, value: null };
      if (addresses.length > 1) return { ok: false, detail: "describe-addresses answered more than one address for one IP" };
      const a = asObj(addresses[0]);
      if (asStr(a.PublicIp) !== publicIp) return { ok: false, detail: "describe-addresses answered another address" };
      return { ok: true, value: { publicIp, instanceId: asStr(a.InstanceId), networkInterfaceId: asStr(a.NetworkInterfaceId), allocationId: asStr(a.AllocationId) } };
    },
    async ecsRunningTasks(cluster: string): Promise<FleetRead<{ readonly count: number; readonly absent: boolean }>> {
      if (!CLUSTER.test(cluster)) return { ok: false, detail: "not a cluster name" };
      const r = await cliJson(cli, ["ecs", "list-tasks", "--region", region, "--cluster", cluster, "--desired-status", "RUNNING"]);
      if (!r.ok) return /ClusterNotFoundException/.test(r.stderr) ? { ok: true, value: { count: 0, absent: true } } : { ok: false, detail: `list-tasks: ${r.detail}` };
      const arns = asObj(r.value).taskArns;
      if (!Array.isArray(arns)) return { ok: false, detail: "list-tasks answered no task list" };
      return { ok: true, value: { count: arns.length, absent: false } };
    },
  };
}

/** The real AWS CLI (`aws` on PATH: AWS CLI v2), argument arrays only, a bounded time, a bounded output. */
const realAwsCli: AwsCli = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile("aws", [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false, env: { ...process.env, AWS_PAGER: "" } }, (error, stdout, stderr) => {
      if (error !== null && typeof (error as { code?: unknown }).code !== "number") {
        reject(new Error(`the AWS CLI could not be run (${(error as { code?: unknown }).code === "ENOENT" ? "aws is not on PATH: install AWS CLI v2" : error.message})`));
        return;
      }
      resolve({ exitCode: error === null ? 0 : ((error as { code: number }).code ?? 1), stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** THE production world: SSM Run Command and the EC2 / ECS reads through the real AWS CLI. The only live world. */
export function productionHostCertWorld(region: string): HostCertWorld {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const host = Object.freeze(createSsmHostTransport(realAwsCli, { region, sleep }));
  const fleet = Object.freeze(createCliFleetView(realAwsCli, region));
  const world: HostCertWorld = Object.freeze({ host, fleet, now: () => Date.now(), sleep });
  for (const o of [world, host, fleet]) LIVE.add(o);
  return world;
}
