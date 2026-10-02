// server/src/aws/deploy/staging/rotationProof.ts
//
// ==================================================================
//  LIVE-6 RELAYER ROTATION: THE POST-ROTATION PROOF -- A ROTATION CERTIFIES ONLY IF IT LEFT THE CONFIGURED RELAYER USABLE
// ==================================================================
//
// The rotation gate (`relayer-rotation-gate`, L6-2 / L6-7; judged by `drills.ts` `judgeRotationDrill`) proves the change
// was SAFE to make: every pool drained, `RELAYQ#<old>` read completely and empty, the new queue never consulted, the old
// configuration active at the gate, every running task started after it. It does not prove the change WORKED: with the
// documents switched but the contract's operator still the old account, `verifyJunoDeployment` refuses the backend for
// the process's life (financial mode off) -- and the drill used to PASS with escrow inactive. This gate closes that.
//
// `stage-cert certify --scenario relayer-rotation-drill` collects, LIVE and READ-ONLY, with the deployment's own readers
// (`collectRotationProof`; bound in `tools/awsDeploy.ts`, never a second parser):
//   configured     the runtime configuration the task reads (`loadAwsStartup`: the same SSM documents, the same parser);
//   chain          the escrow contract's `config` (operator, admin, paused) and `verifyJunoDeployment` -- the server's own
//                  verification of every pin -- over the configuration's own endpoints;
//   routing        `SYSTEM/ROUTING` (L5-3's `readRouting`), the primary's `POOL#<pool>` (L5-2's `readPool`);
//   mirror, fence  the NEW address's game-table mirror `ROLE#relayer#<new>` (L5-6's `readRelayerRole`) and the ledger's
//                  `FENCE#relayer#<new>` (L6-3's `readRelayerFence`);
//   holder         the mirror holder's own `TASK#` heartbeat (L6-5A's item, its one reader `readTaskStatus`): the task's
//                  word that its relayer is `usable` -- the published, current role over an ACTIVE backend -- and its
//                  escrow `active`. Operator evidence after the fact, judged against the authoritative items above;
//                  never a lease, and nothing in the runtime reads it;
//   old_queue      `RELAYQ#<old>` again (the rotation gate's own queue reader, `relayerRotation.ts`): nothing may have appeared under the old address.
// It writes the readings into the evidence directory as `rotation-proof.json` (the package carries them) and judges the
// SAME in-memory readings (`judgeRotationProof`) -- never a file someone could place. The deployment the rotation must
// leave untouched comes from the gate's own machine record (v2: `rotationDeploymentOf`), never from typed values.
//
// THE PROOF (every check must pass; anything unread, unbound or unreadable FAILS):
//   1. the configuration names the new relayer (and its trusted operators include it; its relayer key is not the old one);
//   2. the contract's operator on chain is the new relayer (still the old one, or a third account: FAIL);
//   3. the configured chain, contract and code checksums are the gate's, and the checksums are this build's certified ones;
//   4. the deployment verifies on chain (`verifyJunoDeployment`: the operator, the admission key, the signer registry, ...);
//   5. the routing's primary pool's CURRENT task holds the new relayer's role: the mirror names that pool, its current task
//      and epoch, and the ledger's fence names the mirror's epoch (no newer mint, no damage);
//   6. that task says, freshly, that its relayer is `usable` (primary, serving, ready, this generation and environment);
//   7. escrow is active: the holder's escrow `active`, the chain verified, the contract not paused;
//   8. the settlement key (registry id, public key, KMS key) and 9. the admission key (public key, KMS key) are the gate's;
//   10. `RELAYQ#<old>` is still empty (no old work appeared after the gate -- none migrated, none silently ignored).
// "Every running task started after the gate" stays the rotation gate's own check (`judgeRotationDrill`).

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { CANONICAL_JUNO_ESCROW_CHECKSUMS, verifyJunoDeployment, type JunoBackendConfig } from "../../../escrow/juno/junoConfig";
import type { Check } from "../deployVerify";
import { rotationDeploymentOf } from "../gateRecords";
import { contractControl, signerRefText, type JunoChainReader } from "../junoChain";
import type { RelayQueueState } from "../relayerRotation";
import { fail, judge, obj, type EvidenceRead } from "./evidence";

export const ROTATION_PROOF_FORMAT = "18COSMOS/L6-RELAYER-ROTATION-PROOF/v1";
export const ROTATION_PROOF_FILE = "rotation-proof.json";
/** The holder writes its TASK# item every 30 s: older than this (8 missed writes, with clock skew) is not "now". */
export const HOLDER_STATUS_MAX_AGE_MS = 4 * 60_000;
/** A heartbeat dated this far after the reading is another clock, not a fresh write. */
const FUTURE_SKEW_MS = 2 * 60_000;

/** What a read answered: the value, nothing there, or why it could not be read (never collapsed). */
export type ProofRead<T> = { readonly state: "ok"; readonly value: T } | { readonly state: "absent" } | { readonly state: "unreadable" | "unavailable"; readonly detail: string };

/** The holder's own heartbeat, as `readTaskStatus` decodes it (L6-5A's `TaskStatusRecord`). */
export interface HolderStatus {
  readonly task: string;
  readonly pool: string;
  readonly poolEpoch: number;
  readonly generation: number;
  readonly environment: string;
  readonly role: string;
  readonly phase: string;
  readonly ready: boolean;
  readonly reasons: string;
  readonly relayer: string;
  readonly escrow: string;
  readonly updatedAt: number;
  readonly startedAt: number;
}

/** The deployment's own readers, bound by `tools/awsDeploy.ts` (absent: the proof FAILS "not integrated"). */
export interface RotationReaders {
  readonly routing: (client: DynamoDBClient, table: string) => Promise<{ readonly primary_pool: string; readonly routing_version: number } | null>;
  readonly pool: (client: DynamoDBClient, table: string, pool: string) => Promise<{ readonly writer_epoch: number; readonly writer_task: string | null } | null>;
  readonly relayerRole: (client: DynamoDBClient, table: string, account: string) => Promise<{ readonly account: string; readonly epoch: number; readonly task: string; readonly pool: string; readonly pool_epoch: number; readonly taken_at: number } | null>;
  readonly relayerFence: (client: DynamoDBClient, ledgerTable: string, account: string) => Promise<{ readonly epoch: number } | null>;
  readonly taskStatus: (client: DynamoDBClient, table: string, task: string) => Promise<HolderStatus | null>;
  readonly relayQueue: (client: DynamoDBClient, table: string, address: string) => Promise<RelayQueueState>;
}

export interface ConfiguredRelayer {
  readonly relayer: string;
  readonly relayer_key_ref: string;
  readonly trust_operators: readonly string[];
  readonly chain_id: string;
  readonly contract_address: string;
  readonly code_checksums: readonly string[];
  readonly settlement_key: { readonly signer_key_id: number; readonly public_key_hex: string; readonly key_ref: string };
  readonly admission_key: { readonly public_key_hex: string; readonly key_ref: string };
}

export type ChainReading =
  | {
      readonly state: "ok";
      readonly operator: string;
      readonly admin: string;
      readonly paused: boolean;
      readonly verification: { readonly kind: "verified"; readonly height: string } | { readonly kind: "mismatch"; readonly problems: readonly string[] } | { readonly kind: "unavailable"; readonly detail: string };
    }
  | { readonly state: "unavailable"; readonly detail: string };

export interface RotationProofRecord {
  readonly format: typeof ROTATION_PROOF_FORMAT;
  readonly run_id: string;
  readonly environment: string;
  readonly from_relayer: string;
  readonly to_relayer: string;
  /** Whether this build binds the deployment's readers (false: nothing below was read). */
  readonly readers_bound: boolean;
  readonly read_at: string;
  readonly configured: ConfiguredRelayer | null;
  readonly chain: ChainReading;
  readonly routing: ProofRead<{ readonly primary_pool: string; readonly routing_version: number }>;
  readonly primary_pool: ProofRead<{ readonly pool: string; readonly writer_epoch: number; readonly writer_task: string | null }>;
  readonly mirror: ProofRead<{ readonly account: string; readonly epoch: number; readonly task: string; readonly pool: string; readonly pool_epoch: number; readonly taken_at: number }>;
  readonly fence: ProofRead<{ readonly epoch: number }>;
  readonly holder: ProofRead<HolderStatus>;
  readonly old_queue: { readonly state: "empty" } | { readonly state: "open"; readonly entries: number } | { readonly state: "unknown"; readonly detail: string };
}

const describe = (error: unknown): string => `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`.slice(0, 300);
const UNREADABLE = /Unreadable|Corrupt|LedgerUnreadable/;

async function readAs<T>(run: () => Promise<T | null>): Promise<ProofRead<T>> {
  try {
    const value = await run();
    return value === null ? { state: "absent" } : { state: "ok", value };
  } catch (error) {
    return { state: UNREADABLE.test((error as { name?: string } | null)?.name ?? "") ? "unreadable" : "unavailable", detail: describe(error) };
  }
}

const notRead = (why: string): { readonly state: "unavailable"; readonly detail: string } => ({ state: "unavailable", detail: why });

export function configuredRelayerOf(config: JunoBackendConfig): ConfiguredRelayer {
  return {
    relayer: config.relayer.address,
    relayer_key_ref: signerRefText(config.relayer.signer),
    trust_operators: [...config.trust.operators],
    chain_id: config.chainId,
    contract_address: config.contract,
    code_checksums: [...config.codeChecksums].sort(),
    settlement_key: { signer_key_id: config.settlementKey.signerKeyId, public_key_hex: config.settlementKey.publicKeyHex, key_ref: signerRefText(config.settlementKey.signer) },
    admission_key: { public_key_hex: config.admissionKey.publicKeyHex, key_ref: signerRefText(config.admissionKey.signer) },
  };
}

/** The live, read-only readings (never throws: every failure is recorded as what it was). */
export async function collectRotationProof(input: {
  readonly readers: RotationReaders | undefined;
  readonly juno: JunoChainReader | undefined;
  readonly clients: { readonly app: DynamoDBClient; readonly ledger: DynamoDBClient };
  readonly tables: { readonly game: string; readonly ledger: string };
  readonly config: JunoBackendConfig | null;
  readonly run: string;
  readonly environment: string;
  readonly from: string;
  readonly to: string;
  readonly now: () => number;
}): Promise<RotationProofRecord> {
  const { readers, clients, tables, config, from, to } = input;
  const base = { format: ROTATION_PROOF_FORMAT, run_id: input.run, environment: input.environment, from_relayer: from, to_relayer: to } as const;
  const unbound = "the deployment's readers are not bound in this build (tools/awsDeploy.ts)";
  if (readers === undefined) {
    return { ...base, readers_bound: false, read_at: new Date(input.now()).toISOString(), configured: config === null ? null : configuredRelayerOf(config), chain: notRead(unbound), routing: notRead(unbound), primary_pool: notRead(unbound), mirror: notRead(unbound), fence: notRead(unbound), holder: notRead(unbound), old_queue: { state: "unknown", detail: unbound } };
  }
  /* The chain: the contract's control fields and the server's own verification of every pin. */
  let chain: ChainReading;
  if (config === null) chain = notRead("the runtime document has no escrow");
  else if (input.juno === undefined) chain = notRead("no chain reader is bound in this build");
  else {
    try {
      const rest = input.juno.rest(config);
      const control = await contractControl(rest, config);
      const verdict = await verifyJunoDeployment(config, rest);
      chain = { state: "ok", operator: control.operator, admin: control.admin, paused: control.paused, verification: verdict.kind === "verified" ? { kind: "verified", height: verdict.height } : verdict.kind === "mismatch" ? { kind: "mismatch", problems: verdict.problems.slice(0, 8).map((p) => p.slice(0, 300)) } : { kind: "unavailable", detail: verdict.detail.slice(0, 300) } };
    } catch (error) {
      chain = notRead(describe(error));
    }
  }
  /* The tables: the routing, the primary's pool item, the NEW address's mirror and fence, the holder's heartbeat. */
  const routing = await readAs(() => readers.routing(clients.app, tables.game).then((r) => (r === null ? null : { primary_pool: r.primary_pool, routing_version: r.routing_version })));
  const primaryPool = routing.state === "ok" ? await readAs(() => readers.pool(clients.app, tables.game, routing.value.primary_pool).then((p) => (p === null ? null : { pool: routing.value.primary_pool, writer_epoch: p.writer_epoch, writer_task: p.writer_task }))) : notRead("the routing was not read");
  const mirror = await readAs(() => readers.relayerRole(clients.app, tables.game, to).then((m) => (m === null ? null : { account: m.account, epoch: m.epoch, task: m.task, pool: m.pool, pool_epoch: m.pool_epoch, taken_at: m.taken_at })));
  const fence = await readAs(() => readers.relayerFence(clients.ledger, tables.ledger, to).then((f) => (f === null ? null : { epoch: f.epoch })));
  const holder = mirror.state === "ok" ? await readAs(() => readers.taskStatus(clients.app, tables.game, mirror.value.task)) : notRead("no mirror names a holder");
  let oldQueue: RotationProofRecord["old_queue"];
  try {
    const q = await readers.relayQueue(clients.app, tables.game, from);
    oldQueue = q.state === "empty" ? { state: "empty" } : q.state === "open" ? { state: "open", entries: q.entries } : { state: "unknown", detail: q.detail };
  } catch (error) {
    oldQueue = { state: "unknown", detail: describe(error) };
  }
  return { ...base, readers_bound: true, read_at: new Date(input.now()).toISOString(), configured: config === null ? null : configuredRelayerOf(config), chain, routing, primary_pool: primaryPool, mirror, fence, holder: holder as ProofRead<HolderStatus>, old_queue: oldQueue };
}

const readText = (r: ProofRead<unknown>): string => (r.state === "ok" ? "read" : r.state === "absent" ? "absent" : `${r.state} (${r.detail})`);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The post-rotation proof's verdict (pure): `proof` is the live reading `certify` made (null: none was made), `gate` the
 * rotation gate's own record as read from the evidence directory (its v2 deployment identity is the baseline).
 */
export function judgeRotationProof(
  proof: RotationProofRecord | null,
  gate: EvidenceRead,
  expect: { readonly environment: string; readonly from: string | null; readonly to: string | null; readonly primaryPool: string; readonly generation: number },
): Check[] {
  if (expect.from === null || expect.to === null) return [fail("rotation proof: the addresses", "--from-relayer and --to-relayer name the rotation this proof certifies")];
  const { from, to } = expect;
  if (proof === null) return [fail("rotation proof: the live reading", "no post-rotation reading was made (stage-cert certify makes it for --scenario relayer-rotation-drill)")];
  if (!proof.readers_bound) return [fail("rotation proof: the live reading", "not integrated: the deployment's readers are not bound in this build, so nothing after the rotation was proven")];
  const checks: Check[] = [];
  const baseline = gate.ok ? rotationDeploymentOf(gate.value) : null;
  const gatedAt = gate.ok ? Date.parse(String(obj(gate.value).gated_at)) : Number.NaN;
  const readAt = Date.parse(proof.read_at);
  checks.push(
    judge(
      "rotation proof: read live after the gate, for exactly this rotation",
      proof.format === ROTATION_PROOF_FORMAT && proof.environment === expect.environment && proof.from_relayer === from && proof.to_relayer === to && Number.isFinite(readAt) && Number.isFinite(gatedAt) && readAt > gatedAt,
      `${from} -> ${to}, read ${proof.read_at} (gate ${String(obj(gate.ok ? gate.value : {}).gated_at)})`,
      !gate.ok ? `the gate's own record: ${gate.problem}` : `the reading is ${proof.from_relayer} -> ${proof.to_relayer} in ${proof.environment} at ${proof.read_at}; the gate was at ${String(obj(gate.value).gated_at)} (the proof must follow the gate)`,
    ),
  );
  checks.push(judge("rotation proof: the gate recorded the deployment to keep", baseline !== null, "the gate's v2 record names the chain, contract, checksums, settlement and admission keys and the old relayer key", gate.ok ? "the gate's record carries no deployment identity (a v1 record, or a malformed one): run the gate again" : gate.problem));
  /* 1. The configuration. */
  const c = proof.configured;
  checks.push(
    judge(
      "rotation proof: the runtime configuration names the new relayer",
      c !== null && c.relayer === to && c.trust_operators.includes(to) && (baseline === null || c.relayer_key_ref !== baseline.from_relayer_key_ref),
      `relayer ${to} (key ${c?.relayer_key_ref ?? "?"}), a trusted operator`,
      c === null
        ? "the runtime document has no escrow"
        : c.relayer !== to
          ? `the configuration names ${c.relayer}${c.relayer === from ? " -- still the OLD relayer" : ""}, not ${to}`
          : !c.trust_operators.includes(to)
            ? `trust.operators [${c.trust_operators.join(", ")}] does not include ${to}`
            : `the configured relayer key is still the old one (${c.relayer_key_ref})`,
    ),
  );
  /* 2. The contract's operator. */
  const chain = proof.chain;
  checks.push(
    judge(
      "rotation proof: the escrow contract's operator on chain is the new relayer",
      chain.state === "ok" && chain.operator === to,
      `operator ${to} (set by the contract admin ${chain.state === "ok" ? chain.admin : "?"})`,
      chain.state !== "ok"
        ? `the contract could not be read: ${chain.detail}`
        : chain.operator === from
          ? `the contract's operator is STILL the old relayer ${from}: the admin's set_operator to ${to} did not land (the new relayer can Start nothing; the backend refuses the deployment)`
          : `the contract's operator is ${chain.operator}, neither the old relayer ${from} nor the new ${to}`,
    ),
  );
  /* 3. The deployment is the certified one. */
  const certified = c !== null && c.code_checksums.length > 0 && c.code_checksums.every((sum) => CANONICAL_JUNO_ESCROW_CHECKSUMS.includes(sum));
  checks.push(
    judge(
      "rotation proof: the configured chain, contract and code checksums are the certified deployment's",
      c !== null && baseline !== null && c.chain_id === baseline.chain_id && c.contract_address === baseline.contract_address && same(c.code_checksums, baseline.code_checksums) && certified,
      `${c?.chain_id ?? "?"} ${c?.contract_address ?? "?"} [${c?.code_checksums.join(", ") ?? ""}]: as at the gate, certified by this build`,
      c === null || baseline === null ? "no configuration, or no baseline from the gate" : !certified ? `the configured checksums [${c.code_checksums.join(", ")}] are not this build's certified escrow` : `now ${c.chain_id} ${c.contract_address} [${c.code_checksums.join(", ")}]; at the gate ${baseline.chain_id} ${baseline.contract_address} [${baseline.code_checksums.join(", ")}]`,
    ),
  );
  checks.push(
    judge(
      "rotation proof: the deployment verifies on chain (the server's own verifyJunoDeployment)",
      chain.state === "ok" && chain.verification.kind === "verified",
      chain.state === "ok" && chain.verification.kind === "verified" ? `verified at height ${chain.verification.height}` : "",
      chain.state !== "ok" ? `not read: ${chain.detail}` : chain.verification.kind === "mismatch" ? `MISMATCH -- ${chain.verification.problems.join("; ")} (the backend refuses this deployment for the life of the process)` : chain.verification.kind === "unavailable" ? `unavailable: ${chain.verification.detail}` : "",
    ),
  );
  /* 4. The role: the routing's primary pool's CURRENT task holds the new address's mirror, at the ledger's epoch. */
  const r = proof.routing;
  const p = proof.primary_pool;
  const m = proof.mirror;
  const f = proof.fence;
  const roleProblems: string[] = [];
  if (r.state !== "ok") roleProblems.push(`SYSTEM/ROUTING ${readText(r)}`);
  else if (r.value.primary_pool !== expect.primaryPool) roleProblems.push(`the routing's primary is ${r.value.primary_pool}, not --primary-pool ${expect.primaryPool}`);
  if (p.state !== "ok") roleProblems.push(`the primary's pool item ${readText(p)}`);
  if (m.state !== "ok") roleProblems.push(`ROLE#relayer#${to} ${m.state === "absent" ? "is ABSENT: no task has taken the new relayer's role" : readText(m)}`);
  if (m.state === "ok" && r.state === "ok" && m.value.pool !== r.value.primary_pool) roleProblems.push(`the new relayer's role is held by pool ${m.value.pool}, not the primary ${r.value.primary_pool}`);
  if (m.state === "ok" && p.state === "ok" && (m.value.task !== p.value.writer_task || m.value.pool_epoch !== p.value.writer_epoch)) roleProblems.push(`the role is held by task ${m.value.task} at pool epoch ${m.value.pool_epoch}, but the primary's current task is ${String(p.value.writer_task)} at epoch ${p.value.writer_epoch} (a superseded holder)`);
  if (f.state !== "ok") roleProblems.push(`FENCE#relayer#${to} ${readText(f)}`);
  if (m.state === "ok" && f.state === "ok" && m.value.epoch !== f.value.epoch) roleProblems.push(f.value.epoch > m.value.epoch ? `the ledger minted epoch ${f.value.epoch} but the mirror carries ${m.value.epoch}: nobody holds the role` : `the mirror names epoch ${m.value.epoch}, which the ledger never minted (${f.value.epoch})`);
  checks.push(judge("rotation proof: the current primary holds the new relayer's role (mirror and ledger fence)", roleProblems.length === 0, m.state === "ok" ? `ROLE#relayer#${to}: pool ${m.value.pool}'s current task ${m.value.task} (pool epoch ${m.value.pool_epoch}), relayer epoch ${m.value.epoch} = the ledger's` : "", roleProblems.join("; ")));
  /* 5. The relayer is usable: the holder's own, fresh word. */
  const h = proof.holder;
  const holderProblems: string[] = [];
  if (h.state !== "ok") holderProblems.push(`the holder's TASK# heartbeat ${readText(h)}`);
  else {
    const v = h.value;
    if (m.state === "ok" && (v.task !== m.value.task || v.pool !== m.value.pool || v.poolEpoch !== m.value.pool_epoch)) holderProblems.push(`the heartbeat is task ${v.task} of pool ${v.pool} at epoch ${v.poolEpoch}, not the role holder`);
    if (v.environment !== expect.environment || v.generation !== expect.generation) holderProblems.push(`the heartbeat is ${v.environment} generation ${v.generation}, not ${expect.environment} generation ${expect.generation}`);
    if (v.role !== "primary" || v.phase !== "serving" || !v.ready) holderProblems.push(`the holder is ${v.role}, ${v.phase}, ${v.ready ? "ready" : `NOT ready (${v.reasons || "no reason given"})`}`);
    if (v.relayer !== "usable") holderProblems.push(`the holder's relayer is ${v.relayer}, not usable`);
    const age = readAt - v.updatedAt;
    if (!Number.isFinite(age) || age > HOLDER_STATUS_MAX_AGE_MS || age < -FUTURE_SKEW_MS) holderProblems.push(`the heartbeat was written ${new Date(v.updatedAt).toISOString()}, not within ${HOLDER_STATUS_MAX_AGE_MS / 60_000} minutes of the reading (${proof.read_at})`);
  }
  checks.push(judge("rotation proof: the relayer is usable (the role holder's own fresh heartbeat)", holderProblems.length === 0, h.state === "ok" ? `task ${h.value.task}: relayer usable, primary, serving, ready (written ${new Date(h.value.updatedAt).toISOString()})` : "", holderProblems.join("; ")));
  /* 6. Escrow is active. */
  const escrowProblems: string[] = [];
  if (h.state !== "ok" || h.value.escrow !== "active") escrowProblems.push(`the holder's escrow is ${h.state === "ok" ? h.value.escrow : "unread"}, not active`);
  if (chain.state !== "ok") escrowProblems.push("the contract was not read");
  else {
    if (chain.paused) escrowProblems.push("the contract is PAUSED");
    if (chain.verification.kind !== "verified") escrowProblems.push(`the deployment does not verify (${chain.verification.kind})`);
  }
  checks.push(judge("rotation proof: escrow is active", escrowProblems.length === 0, "the holder's backend is active; the deployment verifies; the contract is not paused", escrowProblems.join("; ")));
  /* 7, 8. The other keys are the gate's: settlement and admission. */
  checks.push(
    judge(
      "rotation proof: the settlement key is unchanged",
      c !== null && baseline !== null && same(c.settlement_key, baseline.settlement_key),
      `signer key ${c?.settlement_key.signer_key_id ?? "?"}, ${c?.settlement_key.public_key_hex ?? "?"}, ${c?.settlement_key.key_ref ?? "?"}`,
      c === null || baseline === null ? "no configuration, or no baseline from the gate" : `now ${JSON.stringify(c.settlement_key)}; at the gate ${JSON.stringify(baseline.settlement_key)} -- a relayer rotation never moves the settlement key`,
    ),
  );
  checks.push(
    judge(
      "rotation proof: the admission key is unchanged",
      c !== null && baseline !== null && same(c.admission_key, baseline.admission_key),
      `${c?.admission_key.public_key_hex ?? "?"}, ${c?.admission_key.key_ref ?? "?"}`,
      c === null || baseline === null ? "no configuration, or no baseline from the gate" : `now ${JSON.stringify(c.admission_key)}; at the gate ${JSON.stringify(baseline.admission_key)} -- a relayer rotation never moves the admission key`,
    ),
  );
  /* 9. Nothing under the old address after the gate (no migration, nothing silently ignored). */
  const q = proof.old_queue;
  checks.push(judge(`rotation proof: RELAYQ#<old> is still empty (nothing appeared under ${from} after the gate)`, q.state === "empty", `RELAYQ#${from}: empty, every page read`, q.state === "open" ? `RELAYQ#${from} holds ${q.entries} entr${q.entries === 1 ? "y" : "ies"}: old-address work the new relayer never reads (no automatic migration)` : `RELAYQ#${from} UNKNOWN -- ${q.state === "unknown" ? q.detail : "?"} (an unread queue is never empty)`));
  return checks;
}
