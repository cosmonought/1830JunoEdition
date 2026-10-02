// server/src/aws/deploy/hostcert/transport.ts
//
// COST-2C: what the host certification reaches the world through -- PORTS ONLY (no AWS, no process spawning here).
//
//   HostTransport   one fixed host operation (`hostOps.ts`) on one instance, and its raw answer. `ok: false` means the
//                   transport could not say what happened (undelivered, timed out, cancelled, unreadable): the step is
//                   NOT EVALUATED, never taken as done or as not done.
//   FleetView       the EC2 / ECS control plane, read-only: the environment's single-host instances, the owner of an
//                   Elastic IP, the running ECS tasks of the retired cluster.
//
// The production implementations (`awsCliTransport.ts`) run the AWS CLI v2 with argument arrays, never a shell. Tests use
// fakes. ONLY the production world is LIVE (`isLiveWorld`): evidence produced through anything else can never satisfy the
// real-AL2023 checks, whatever it says.

import type { HostOp } from "./hostOps";

export type HostRun =
  | { readonly ok: true; readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly commandId: string | null }
  | { readonly ok: false; readonly detail: string; readonly commandId: string | null };

export interface HostTransport {
  /** A short label for the evidence ("aws-cli-ssm", "fake", ...). Never decides liveness (see `isLiveWorld`). */
  readonly label: string;
  run(instanceId: string, op: HostOp): Promise<HostRun>;
}

export type FleetRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

export interface FleetInstance {
  readonly instanceId: string;
  readonly state: string;
  readonly publicIp: string | null;
  readonly launchTime: string | null;
}

export interface AddressOwner {
  readonly publicIp: string;
  readonly instanceId: string | null;
  readonly networkInterfaceId: string | null;
  readonly allocationId: string | null;
}

export interface FleetView {
  /** Every instance tagged gs:component=single-host and gs:environment=<env>, in any state but terminated. */
  hostInstances(environment: string): Promise<FleetRead<readonly FleetInstance[]>>;
  /** One instance by id (null: it does not exist any more, or is terminated). */
  instance(instanceId: string): Promise<FleetRead<FleetInstance | null>>;
  /** The Elastic IP's association (null: no such address in this account / region). */
  addressOwner(publicIp: string): Promise<FleetRead<AddressOwner | null>>;
  /** Tasks desired RUNNING in the ECS cluster (0 with `absent: true` when the cluster no longer exists). */
  ecsRunningTasks(cluster: string): Promise<FleetRead<{ readonly count: number; readonly absent: boolean }>>;
}

export interface HostCertWorld {
  readonly host: HostTransport;
  readonly fleet: FleetView;
  /** Wall clock (ms) and a sleep -- injected so the offline tests run the polling loops instantly. */
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/* Only `awsCliTransport.ts`'s production constructor adds to this set (module-private brand; never exported mutable). */
const LIVE_WORLDS = new WeakSet<object>();
let sealed = false;

/** Called ONCE, by `awsCliTransport.ts` at module load, to obtain the branding function; a second call throws. */
export function takeLiveBrand(): (world: HostCertWorld) => HostCertWorld {
  if (sealed) throw new Error("host-cert: the live brand was already taken");
  sealed = true;
  return (world) => {
    LIVE_WORLDS.add(world);
    return world;
  };
}

/** Whether `world` is the production world (the real AWS CLI over SSM). A fake, a test double or a hand-made world: no. */
export const isLiveWorld = (world: HostCertWorld): boolean => LIVE_WORLDS.has(world);
