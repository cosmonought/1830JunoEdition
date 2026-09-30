// server/src/aws/deploy/relayerRotation.ts
//
// ==================================================================
//  LIVE-6 L6-2 (for L6-7): THE RELAYER-ADDRESS ROTATION GATE -- THE OLD RELAY QUEUE PROVEN EMPTY (READ-ONLY)
// ==================================================================
//
// `RELAYQ#<relayer-address>` is the relayer's authoritative work discovery (L6-7): every intent the relayer must still see
// has an entry in its own address's partition, made with the intent and removed only when the intent is done. A relayer
// running under a NEW address never reads the old partition -- so a configuration change of the relayer address while the
// old queue holds work would strand that work (owner decision: NO automatic queue migration in this LIVE cycle).
//
// THE DEPLOYMENT INVARIANT: a change of the relayer address (the Juno backend configuration's `relayer.address`) is REFUSED
// while `RELAYQ#<old>` holds any entry. The supported procedure (infra/aws/README.md "Relayer-address rotation"):
//   1. keep the old relayer configuration active and let its queue drain to zero (`relayer.status()`, the AUDIT lines);
//   2. drain every pool (drain-pool: desired = running = pending = 0) -- nothing can add to the queue any more;
//   3. `awsDeploy relayer-rotation-gate` (this file): the configuration still names the old address, every pool drained
//      (evidence), and `RELAYQ#<old>` read COMPLETELY (strongly consistent, every page) and EMPTY -> GATE OPEN;
//   4. only then change the relayer address/configuration (Terraform `escrow`), and start the pools (drain-first);
//   5. the new address's relayer role is taken by the primary's task at its start.
// An entry of ANY shape is open work (this gate never parses entries -- a damaged one is not "nothing"; L6-7's strict
// reader is the relayer's). A read that fails, a table that cannot be read, or anything not proven is REFUSED. The new
// address's queue is never consulted: emptiness is never inferred from it.

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { queryAll } from "../game/gameTable";

export type RelayQueueState =
  | { readonly state: "empty"; readonly pages_read: "all" }
  | { readonly state: "open"; readonly entries: number; readonly oldest: readonly string[] }
  | { readonly state: "unknown"; readonly detail: string };

/** A relayer account address as the Juno configuration writes it (bech32: `<hrp>1<data>`, lower case). */
export const RELAYER_ADDRESS = /^[a-z][a-z0-9]{0,15}1[02-9ac-hj-np-z]{38,58}$/;

/** `RELAYQ#<address>` read completely: strongly consistent, every page, no filter, nothing parsed. */
export async function relayQueueState(client: DynamoDBClient, table: string, address: string): Promise<RelayQueueState> {
  if (!RELAYER_ADDRESS.test(address)) return { state: "unknown", detail: `${JSON.stringify(address.slice(0, 100))} is not a relayer address` };
  try {
    const items = await queryAll(client, table, `RELAYQ#${address}`);
    if (items.length === 0) return { state: "empty", pages_read: "all" };
    const keys = items.map((item) => item.sk?.S ?? "<no sort key>").sort();
    return { state: "open", entries: items.length, oldest: keys.slice(0, 5) };
  } catch (error) {
    return { state: "unknown", detail: `RELAYQ#${address} could not be read completely (${error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "error"})` };
  }
}
