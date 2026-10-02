// server/src/aws/deploy/staging/rotationTestSupport.ts
//
// TEST SUPPORT ONLY (never imported by production code): LIVE-6 relayer rotation's offline doubles --
//   - `escrowRestFor`      a `JunoRest` answering exactly what `verifyJunoDeployment` and the deploy tools read (node
//                          info, block, contract, code checksum, the escrow's `config` and `signer_keys` queries, an
//                          account), built from a parsed configuration and scripted deviations (operator, paused, ...);
//   - `fakeJunoChain`      a `JunoChainReader` over it (and scripted balances);
//   - `rotationReadersFor` the post-rotation proof's table readers over a scripted deployment (routing, pool item,
//                          mirror, fence, the holder's heartbeat, the old relay queue), each answer or failure scripted.

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { addressOfPublicKey } from "../../../escrow/juno/cosmosTx";
import { JUNO_ESCROW_CONTRACT_NAME, type JunoBackendConfig } from "../../../escrow/juno/junoConfig";
import { publicKeyOf } from "../../../escrow/juno/secp256k1";
import { JunoRpcError, type JunoRest } from "../../../escrow/juno/junoRest";
import type { JunoChainReader } from "../junoChain";
import type { RelayQueueState } from "../relayerRotation";
import type { HolderStatus, RotationReaders } from "./rotationProof";

export interface EscrowChainScript {
  /** The contract's operator (default: the configured relayer). */
  readonly operator?: string;
  readonly admin?: string;
  readonly paused?: boolean;
  /** The contract's admission key (default: the configured one). */
  readonly admissionPubkey?: string;
  /** The code checksum the chain reports (default: the configuration's first). */
  readonly checksum?: string;
  /** Every read fails as an unreachable node. */
  readonly unreachable?: boolean;
  /** Accounts that exist on chain. */
  readonly accounts?: readonly string[];
}

/** The contract admin the doubles answer (an account no relayer key controls). */
export const STAGING_ADMIN = addressOfPublicKey(publicKeyOf(Buffer.alloc(32, 0x51)), "juno");

export function escrowRestFor(config: JunoBackendConfig, script: EscrowChainScript = {}): JunoRest {
  const down = () => {
    if (script.unreachable === true) throw new JunoRpcError("unavailable", "the node is unreachable (test)");
  };
  const smart = async (contract: string, query: string): Promise<unknown> => {
    down();
    if (contract !== config.contract) throw new JunoRpcError("refused", `no contract ${contract}`);
    const q = JSON.parse(query) as Record<string, unknown>;
    if ("config" in q) {
      return {
        config: {
          admin: script.admin ?? STAGING_ADMIN,
          operator: script.operator ?? config.relayer.address,
          admission_pubkey: script.admissionPubkey ?? config.admissionKey.publicKeyHex,
          resolver: config.trust.resolvers[0],
          treasury: STAGING_ADMIN,
          denom: config.denom,
          paused: script.paused ?? false,
          params: { subsidy_bps: 250, challenge_window_live_secs: 3600, challenge_window_async_secs: 86400, liveness_window_secs: 3600, resolver_timeout_secs: 3600, min_ante: "1000000", funding_period_live_secs: 3600, funding_period_async_secs: 86400 },
        },
        contract_name: JUNO_ESCROW_CONTRACT_NAME,
        contract_version: "2.0.0",
        next_signer_key_id: config.settlementKey.signerKeyId + 1,
        next_chain_game_id: 1,
      };
    }
    if ("signer_keys" in q) return { keys: [{ key_id: config.settlementKey.signerKeyId, pubkey: config.settlementKey.publicKeyHex, added_at: "1", retired_at: null, compromised: false }] };
    throw new JunoRpcError("refused", `unexpected query ${query}`);
  };
  const refuse = (what: string) => async (): Promise<never> => {
    throw new Error(`the rotation tooling never ${what}`);
  };
  return {
    chainId: config.chainId,
    nodeChainId: async () => (down(), config.chainId),
    latestBlock: async () => (down(), { chain_id: config.chainId, height: "1234", time: "2026-09-30T10:00:00Z" }),
    syncing: async () => (down(), false),
    account: async (address: string) => (down(), (script.accounts ?? []).includes(address) ? { height: "1234", address, account_number: "7", sequence: "0", pub_key: null } : null),
    contract: async (address: string) => (down(), { address, code_id: "42", admin: config.wasmAdmin, creator: STAGING_ADMIN, label: "18cosmos-escrow" }),
    codeChecksum: async () => (down(), script.checksum ?? config.codeChecksums[0]),
    smart,
    smartAt: async (contract: string, query: string) => ({ data: await smart(contract, query), height: "1234" }),
    endpointChains: async () => config.endpoints.map((endpoint) => (script.unreachable === true ? { endpoint, chain_id: null, error: "unreachable" } : { endpoint, chain_id: config.chainId, error: null })),
    simulate: refuse("simulates"),
    broadcast: refuse("broadcasts"),
    tx: refuse("reads a transaction"),
    txsBySequence: refuse("reads a sequence"),
  };
}

export function fakeJunoChain(script: EscrowChainScript = {}, balances: Readonly<Record<string, bigint>> = {}): JunoChainReader & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rest: (config) => {
      calls.push("rest");
      return escrowRestFor(config, script);
    },
    balance: async (_config, address) => {
      calls.push(`balance ${address}`);
      if (script.unreachable === true) throw new JunoRpcError("unavailable", "the node is unreachable (test)");
      return balances[address] ?? BigInt(0);
    },
  };
}

/** A scripted deployment for the proof's table readers (each value, `null` = absent, or an Error = that failure). */
export interface RotationTableScript {
  readonly routing?: { readonly primary_pool: string; readonly routing_version: number } | null | Error;
  readonly pools?: Readonly<Record<string, { readonly writer_epoch: number; readonly writer_task: string | null } | null | Error>>;
  readonly mirrors?: Readonly<Record<string, { readonly account: string; readonly epoch: number; readonly task: string; readonly pool: string; readonly pool_epoch: number; readonly taken_at: number } | null | Error>>;
  readonly fences?: Readonly<Record<string, { readonly epoch: number } | null | Error>>;
  readonly tasks?: Readonly<Record<string, HolderStatus | null | Error>>;
  readonly queues?: Readonly<Record<string, RelayQueueState>>;
}

const answer = <T>(value: T | Error | undefined): Promise<T | null> => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value === undefined ? null : value));

export function rotationReadersFor(script: RotationTableScript): RotationReaders & { readonly calls: string[] } {
  const calls: string[] = [];
  const note = (what: string, client: DynamoDBClient) => calls.push(`${what}${(client as unknown as { label?: string }).label === undefined ? "" : ` @${(client as unknown as { label: string }).label}`}`);
  return {
    calls,
    routing: (client) => (note("routing", client), answer(script.routing)),
    pool: (client, _table, pool) => (note(`pool ${pool}`, client), answer(script.pools?.[pool])),
    relayerRole: (client, _table, account) => (note(`mirror ${account}`, client), answer(script.mirrors?.[account])),
    relayerFence: (client, _table, account) => (note(`fence ${account}`, client), answer(script.fences?.[account])),
    taskStatus: (client, _table, task) => (note(`task ${task}`, client), answer(script.tasks?.[task])),
    relayQueue: async (client, _table, address) => (note(`queue ${address}`, client), script.queues?.[address] ?? { state: "empty", pages_read: "all" }),
  };
}

/** A healthy post-rotation deployment: pool `pool`'s current task holds `to`'s role at the ledger's epoch, says its relayer
 *  is usable and its escrow active, freshly at `now`; `RELAYQ#<from>` empty. */
export function healthyRotation(input: { readonly from: string; readonly to: string; readonly pool: string; readonly now: number; readonly environment?: string; readonly generation?: number }): RotationTableScript {
  const task = "t-holder-0001";
  return {
    routing: { primary_pool: input.pool, routing_version: 3 },
    pools: { [input.pool]: { writer_epoch: 9, writer_task: task } },
    mirrors: { [input.to]: { account: input.to, epoch: 1, task, pool: input.pool, pool_epoch: 9, taken_at: input.now - 600_000 } },
    fences: { [input.to]: { epoch: 1 } },
    tasks: {
      [task]: { task, pool: input.pool, poolEpoch: 9, generation: input.generation ?? 1, environment: input.environment ?? "staging", role: "primary", phase: "serving", ready: true, reasons: "", relayer: "usable", escrow: "active", updatedAt: input.now - 20_000, startedAt: input.now - 700_000 },
    },
    queues: { [input.from]: { state: "empty", pages_read: "all" } },
  };
}
