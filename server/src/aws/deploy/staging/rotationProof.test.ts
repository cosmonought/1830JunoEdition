// server/src/aws/deploy/staging/rotationProof.test.ts
//
// LIVE-6 relayer rotation: the post-rotation proof (`rotationProof.ts`), the v2 rotation gate's chain read and record
// (`commands.ts` relayer-rotation-gate), and the admin's read-only `set-operator-plan` -- offline: the live readers and
// the chain are scripted doubles (`rotationTestSupport.ts`); every judgment is the production code's.
//
// The owner's decision under test: a rotation certifies ONLY when it left the configured relayer usable. It FAILS when
// the contract's operator is still old, or neither old nor new; when the new role is absent, or held by the wrong pool or
// task; when the relayer is unusable; when escrow is inactive; when the settlement or admission key changed; and when
// anything could not be read or the readers are not bound.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { addressOfPublicKey } from "../../../escrow/juno/cosmosTx";
import { parseJunoBackendConfig, type JunoBackendConfig } from "../../../escrow/juno/junoConfig";
import { publicKeyOf } from "../../../escrow/juno/secp256k1";
import { runDeployCommand, EXIT_FAILED, EXIT_OK, type DeployDeps } from "../commands";
import type { Check } from "../deployVerify";
import { ROTATION_GATE_FORMAT, rotationGateRecordProblem } from "../gateRecords";
import { deploymentIdentityOf, relayerFunding, RELAYER_TRANSACTIONS_PER_GAME, setOperatorMessage } from "../junoChain";
import { collectRotationProof, judgeRotationProof, HOLDER_STATUS_MAX_AGE_MS, ROTATION_PROOF_FORMAT, type RotationProofRecord } from "./rotationProof";
import { fakeJunoChain, healthyRotation, rotationReadersFor, STAGING_ADMIN, type EscrowChainScript, type RotationTableScript } from "./rotationTestSupport";
import type { EvidenceRead } from "./evidence";

const FIXTURES = path.resolve(__dirname, "../../../../../../../infra/aws/fixtures");
const fixtureText = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

/* The old relayer (the fixture's) and a new one: the address a NEW KMS key controls. */
const OLD = "juno1xc5etfhxjg4qfc9cx25qh3tvxdcf5skjj5epte";
const NEW = addressOfPublicKey(publicKeyOf(Buffer.alloc(32, 0x21)), "juno");
const THIRD = addressOfPublicKey(publicKeyOf(Buffer.alloc(32, 0x31)), "juno");
const OLD_KEY = "arn:aws:kms:us-east-1:222222222222:key/11111111-1111-4111-8111-111111111111";
const NEW_KEY = "arn:aws:kms:us-east-1:222222222222:key/66666666-6666-4666-8666-666666666666";
const GATED = "2026-10-01T10:00:00.000Z";
const NOW = Date.parse("2026-10-01T10:30:00.000Z");

/** The live configuration: the staging fixture switched to `relayer` (key, address, trusted operator), then `edit`. */
function configFor(relayer: { readonly address: string; readonly key: string }, edit: (doc: Record<string, any>) => void = () => undefined): JunoBackendConfig {
  const doc = JSON.parse(fixtureText("juno-backend-staging.json")) as Record<string, any>;
  doc.relayer = { address: relayer.address, signer: { kind: "kms", key_ref: relayer.key } };
  doc.trust.operators = [relayer.address];
  edit(doc);
  return parseJunoBackendConfig(doc, { serverMode: "production", dataDir: "/nonexistent" });
}
const OLD_CONFIG = configFor({ address: OLD, key: OLD_KEY });
const NEW_CONFIG = configFor({ address: NEW, key: NEW_KEY });

/** The gate's own v2 record, as `relayer-rotation-gate --record` writes it for OLD -> NEW (judged OPEN). */
function gateRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: ROTATION_GATE_FORMAT,
    environment: "staging",
    from_relayer: OLD,
    to_relayer: NEW,
    configured_relayer: OLD,
    pools: ["p1"],
    evidence_captured_at: "2026-10-01T09:55:00Z",
    queue: "empty",
    verdict: "OPEN",
    checks: [
      { name: "the active configuration names the OLD relayer", status: "pass", detail: "" },
      { name: "drained p1", status: "pass", detail: "" },
      { name: `RELAYQ#${OLD} empty (strongly consistent, every page)`, status: "pass", detail: "" },
      { name: `RELAYQ#${NEW}`, status: "skipped", detail: "" },
      { name: "the escrow contract's operator is the old or the new relayer (read from the chain)", status: "pass", detail: "" },
    ],
    gated_at: GATED,
    deployment: deploymentIdentityOf(OLD_CONFIG),
    contract_operator: OLD,
    ...over,
  };
}
const asRead = (value: unknown): EvidenceRead => ({ ok: true, value, sha256: "x" });
const EXPECT = { environment: "staging", from: OLD, to: NEW, primaryPool: "p1", generation: 1 } as const;
const failing = (checks: readonly Check[]) => checks.filter((c) => c.status !== "pass");
const text = (checks: readonly Check[]) => failing(checks).map((c) => `${c.name}: ${c.detail}`).join("\n");
const FAKE_CLIENTS = { app: { label: "app" } as never, ledger: { label: "ledger" } as never };

async function proofOf(options: { readonly table?: RotationTableScript; readonly chain?: EscrowChainScript; readonly config?: JunoBackendConfig | null; readonly bound?: boolean; readonly juno?: boolean } = {}): Promise<RotationProofRecord> {
  return collectRotationProof({
    readers: options.bound === false ? undefined : rotationReadersFor(options.table ?? healthyRotation({ from: OLD, to: NEW, pool: "p1", now: NOW })),
    juno: options.juno === false ? undefined : fakeJunoChain(options.chain ?? { operator: NEW }),
    clients: FAKE_CLIENTS,
    tables: { game: "gs-staging-game-g1", ledger: "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger" },
    config: options.config === undefined ? NEW_CONFIG : options.config,
    run: "rot-2026-10-01",
    environment: "staging",
    from: OLD,
    to: NEW,
    now: () => NOW,
  });
}
const judged = async (options: Parameters<typeof proofOf>[0] = {}, gate: Record<string, unknown> = gateRecord()) => judgeRotationProof(await proofOf(options), asRead(gate), EXPECT);
/** The one check named `name` (by prefix) must FAIL with `detail`, and the proof as a whole must not pass. */
async function failsWith(label: string, options: Parameters<typeof proofOf>[0], name: string, detail: RegExp, gate?: Record<string, unknown>) {
  const checks = await judged(options, gate);
  const hit = checks.find((c) => c.name.startsWith(name));
  assert.ok(hit !== undefined, `${label}: no check named ${name}`);
  assert.equal(hit.status, "fail", `${label}: ${name} passed -- ${hit.detail}`);
  assert.match(hit.detail, detail, label);
  assert.ok(failing(checks).length > 0, label);
}

const healthy = (edit: (t: ReturnType<typeof healthyRotation>) => RotationTableScript) => edit(healthyRotation({ from: OLD, to: NEW, pool: "p1", now: NOW }));
const HOLDER = "t-holder-0001";

describe("LIVE-6 relayer rotation: the post-rotation proof (rotation-proof gate)", () => {
  test("a rotation that worked: every check of the proof passes, read from the deployment's own readers and the chain", async () => {
    const readers = rotationReadersFor(healthyRotation({ from: OLD, to: NEW, pool: "p1", now: NOW }));
    const chain = fakeJunoChain({ operator: NEW });
    const proof = await collectRotationProof({ readers, juno: chain, clients: FAKE_CLIENTS, tables: { game: "g", ledger: "l" }, config: NEW_CONFIG, run: "rot-2026-10-01", environment: "staging", from: OLD, to: NEW, now: () => NOW });
    assert.equal(proof.format, ROTATION_PROOF_FORMAT);
    assert.equal(proof.readers_bound, true);
    const checks = judgeRotationProof(proof, asRead(gateRecord()), EXPECT);
    assert.deepEqual(failing(checks), [], text(checks));
    assert.equal(checks.length, 12);
    /* What was read, and where: the routing, the primary's pool item, the NEW address's mirror and fence (the ledger's
       client), the holder's heartbeat, the OLD address's queue -- never the new address's queue. */
    assert.deepEqual(readers.calls, ["routing @app", "pool p1 @app", `mirror ${NEW} @app`, `fence ${NEW} @ledger`, `task ${HOLDER} @app`, `queue ${OLD} @app`]);
    assert.deepEqual(chain.calls, ["rest"], "the chain: one REST client, reads only (no balance needed here)");
    assert.equal(JSON.stringify(proof).includes("claim"), false, "no mirror or fence token is carried into the evidence");
  });

  test("FAILS when the contract's operator is still the OLD relayer (the admin's set_operator never landed)", async () => {
    await failsWith("operator still old", { chain: { operator: OLD } }, "rotation proof: the escrow contract's operator", /STILL the old relayer .*set_operator/);
    const checks = await judged({ chain: { operator: OLD } });
    assert.match(text(checks), /deployment verifies on chain.*MISMATCH -- the contract's operator is .*not the relayer/, "the server's own verification refuses it too");
    assert.match(text(checks), /escrow is active: .*does not verify/);
  });

  test("FAILS when the contract's operator is neither the old nor the new relayer", async () => {
    await failsWith("operator neither", { chain: { operator: THIRD } }, "rotation proof: the escrow contract's operator", new RegExp(`is ${THIRD}, neither the old relayer`));
  });

  test("FAILS when the new relayer's role is absent (no task took ROLE#relayer#<new>)", async () => {
    await failsWith("role absent", { table: healthy((t) => ({ ...t, mirrors: { [NEW]: null } })) }, "rotation proof: the current primary holds", /ROLE#relayer#.* is ABSENT: no task has taken the new relayer's role/);
    await failsWith("role absent -> no holder", { table: healthy((t) => ({ ...t, mirrors: { [NEW]: null } })) }, "rotation proof: the relayer is usable", /no mirror names a holder/);
  });

  test("FAILS when the role is held by the wrong pool, or by a superseded task of the primary", async () => {
    const wrongPool = healthy((t) => ({ ...t, mirrors: { [NEW]: { ...(t.mirrors?.[NEW] as object), pool: "p2" } as never } }));
    await failsWith("wrong pool", { table: wrongPool }, "rotation proof: the current primary holds", /held by pool p2, not the primary p1/);
    const superseded = healthy((t) => ({ ...t, pools: { p1: { writer_epoch: 10, writer_task: "t-newer-0002" } } }));
    await failsWith("superseded task", { table: superseded }, "rotation proof: the current primary holds", /held by task t-holder-0001 at pool epoch 9, but the primary's current task is t-newer-0002 at epoch 10/);
    const routedElsewhere = healthy((t) => ({ ...t, routing: { primary_pool: "p2", routing_version: 4 } }));
    await failsWith("routing names another primary", { table: routedElsewhere }, "rotation proof: the current primary holds", /the routing's primary is p2, not --primary-pool p1/);
    const minted = healthy((t) => ({ ...t, fences: { [NEW]: { epoch: 2 } } }));
    await failsWith("a newer mint than the mirror", { table: minted }, "rotation proof: the current primary holds", /the ledger minted epoch 2 but the mirror carries 1: nobody holds the role/);
    const fenceless = healthy((t) => ({ ...t, fences: { [NEW]: null } }));
    await failsWith("no ledger fence", { table: fenceless }, "rotation proof: the current primary holds", /FENCE#relayer#.* absent/);
  });

  test("FAILS when the relayer is unusable: the holder says so, is not ready, or its word is stale or another task's", async () => {
    const holder = (edit: Record<string, unknown>) => healthy((t) => ({ ...t, tasks: { [HOLDER]: { ...(t.tasks?.[HOLDER] as object), ...edit } as never } }));
    await failsWith("relayer held, backend not active", { table: holder({ relayer: "held" }) }, "rotation proof: the relayer is usable", /the holder's relayer is held, not usable/);
    await failsWith("relayer not current", { table: holder({ relayer: "not-current" }) }, "rotation proof: the relayer is usable", /not-current, not usable/);
    await failsWith("not ready", { table: holder({ ready: false, reasons: "escrow-unverified" }) }, "rotation proof: the relayer is usable", /NOT ready \(escrow-unverified\)/);
    await failsWith("stale heartbeat", { table: holder({ updatedAt: NOW - HOLDER_STATUS_MAX_AGE_MS - 1 }) }, "rotation proof: the relayer is usable", /not within 4 minutes of the reading/);
    await failsWith("another task's heartbeat", { table: holder({ task: "t-other-0003" }) }, "rotation proof: the relayer is usable", /not the role holder/);
    await failsWith("another generation", { table: holder({ generation: 2 }) }, "rotation proof: the relayer is usable", /generation 2, not staging generation 1/);
    await failsWith("no heartbeat", { table: healthy((t) => ({ ...t, tasks: {} })) }, "rotation proof: the relayer is usable", /TASK# heartbeat absent/);
    await failsWith("an unreadable heartbeat", { table: healthy((t) => ({ ...t, tasks: { [HOLDER]: Object.assign(new Error("damaged"), { name: "TaskHeartbeatsUnreadableError" }) } })) }, "rotation proof: the relayer is usable", /unreadable \(TaskHeartbeatsUnreadableError: damaged\)/);
  });

  test("FAILS when escrow is inactive: the holder's backend refused or unverified, the contract paused, the chain unread", async () => {
    const holder = (escrow: string) => healthy((t) => ({ ...t, tasks: { [HOLDER]: { ...(t.tasks?.[HOLDER] as object), escrow } as never } }));
    await failsWith("backend refused", { table: holder("refused") }, "rotation proof: escrow is active", /the holder's escrow is refused, not active/);
    await failsWith("backend unverified", { table: holder("unverified") }, "rotation proof: escrow is active", /the holder's escrow is unverified, not active/);
    await failsWith("paused", { chain: { operator: NEW, paused: true } }, "rotation proof: escrow is active", /the contract is PAUSED/);
    await failsWith("chain unreachable", { chain: { operator: NEW, unreachable: true } }, "rotation proof: escrow is active", /the contract was not read/);
    await failsWith("no chain reader", { juno: false }, "rotation proof: the escrow contract's operator", /no chain reader is bound/);
    await failsWith("the admission key on chain moved", { chain: { operator: NEW, admissionPubkey: "02" + "ab".repeat(32) } }, "rotation proof: the deployment verifies on chain", /join-admission key/);
  });

  test("FAILS when the settlement key or the admission key changed (the live configuration against the gate's record)", async () => {
    const otherPub = (b: number) => publicKeyOf(Buffer.alloc(32, b)).toString("hex");
    const settlementMoved = configFor({ address: NEW, key: NEW_KEY }, (d) => (d.settlement_key.public_key_hex = otherPub(0x41)));
    await failsWith("settlement public key", { config: settlementMoved }, "rotation proof: the settlement key is unchanged", /never moves the settlement key/);
    const settlementKms = configFor({ address: NEW, key: NEW_KEY }, (d) => (d.settlement_key.signer.key_ref = "arn:aws:kms:us-east-1:222222222222:key/77777777-7777-4777-8777-777777777777"));
    await failsWith("settlement KMS key", { config: settlementKms }, "rotation proof: the settlement key is unchanged", /77777777/);
    const settlementId = configFor({ address: NEW, key: NEW_KEY }, (d) => (d.settlement_key.signer_key_id = 2));
    await failsWith("settlement registry id", { config: settlementId }, "rotation proof: the settlement key is unchanged", /signer_key_id":2/);
    const admissionMoved = configFor({ address: NEW, key: NEW_KEY }, (d) => (d.admission_key.public_key_hex = otherPub(0x42)));
    await failsWith("admission public key", { config: admissionMoved, chain: { operator: NEW, admissionPubkey: otherPub(0x42) } }, "rotation proof: the admission key is unchanged", /never moves the admission key/);
    const admissionKms = configFor({ address: NEW, key: NEW_KEY }, (d) => (d.admission_key.signer.key_ref = "arn:aws:kms:us-east-1:222222222222:key/88888888-8888-4888-8888-888888888888"));
    await failsWith("admission KMS key", { config: admissionKms }, "rotation proof: the admission key is unchanged", /88888888/);
    /* Each of those changes fails ONLY its own key's check (the other keys and the relayer are judged on their own). */
    const only = await judged({ config: admissionKms });
    assert.deepEqual(failing(only).map((c) => c.name), ["rotation proof: the admission key is unchanged"]);
  });

  test("FAILS when the configuration was not switched, the contract or its code moved, or old-address work appeared", async () => {
    await failsWith("config still old", { config: configFor({ address: OLD, key: OLD_KEY }), chain: { operator: NEW } }, "rotation proof: the runtime configuration names the new relayer", /still the OLD relayer/);
    const thirdConfigured = configFor({ address: THIRD, key: NEW_KEY }, (d) => (d.trust.operators = [THIRD, NEW]));
    await failsWith("another relayer configured", { config: thirdConfigured }, "rotation proof: the runtime configuration names the new relayer", new RegExp(`the configuration names ${THIRD}, not ${NEW}`));
    await failsWith("new address on the old key", { config: configFor({ address: NEW, key: OLD_KEY }) }, "rotation proof: the runtime configuration names the new relayer", /relayer key is still the old one/);
    const otherContract = configFor({ address: NEW, key: NEW_KEY }, (d) => (d.contract_address = THIRD));
    await failsWith("another contract", { config: otherContract }, "rotation proof: the configured chain, contract and code checksums", new RegExp(`now uni-7 ${THIRD} .*at the gate uni-7 juno1qursw`));
    await failsWith("old queue open", { table: healthy((t) => ({ ...t, queues: { [OLD]: { state: "open", entries: 2, oldest: ["a", "b"] } } })) }, "rotation proof: RELAYQ#<old> is still empty", /holds 2 entries: old-address work the new relayer never reads/);
    await failsWith("old queue unread", { table: healthy((t) => ({ ...t, queues: { [OLD]: { state: "unknown", detail: "AccessDenied" } } })) }, "rotation proof: RELAYQ#<old> is still empty", /UNKNOWN -- AccessDenied/);
  });

  test("FAILS when nothing was proven: no reading, readers not bound, a v1 or missing gate record, a reading before the gate", async () => {
    assert.match(text(judgeRotationProof(null, asRead(gateRecord()), EXPECT)), /no post-rotation reading was made/);
    assert.match(text(judgeRotationProof(await proofOf({ bound: false }), asRead(gateRecord()), EXPECT)), /not integrated/);
    await failsWith("v1 gate record", {}, "rotation proof: the gate recorded the deployment to keep", /carries no deployment identity/, gateRecord({ format: "18COSMOS/RELAYER-ROTATION-GATE/v1", deployment: undefined }));
    assert.match(text(judgeRotationProof(await proofOf(), { ok: false, problem: "gate-relayer-rotation.json is missing" }, EXPECT)), /gate-relayer-rotation.json is missing/);
    await failsWith("read before the gate", {}, "rotation proof: read live after the gate", /the proof must follow the gate/, gateRecord({ gated_at: "2026-10-01T11:00:00.000Z" }));
    assert.match(text(judgeRotationProof(await proofOf(), asRead(gateRecord()), { ...EXPECT, to: THIRD })), /read live after the gate, for exactly this rotation/);
    assert.match(text(judgeRotationProof(await proofOf(), asRead(gateRecord()), { ...EXPECT, from: null })), /--from-relayer and --to-relayer/);
  });
});

/* ------------------------------------------------------------------ */
/* The gate (v2) and set-operator-plan, as commands                     */
/* ------------------------------------------------------------------ */

describe("LIVE-6 relayer rotation: the v2 gate's chain read and set-operator-plan (read-only)", () => {
  const RUNTIME_ARN = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1";
  const JUNO_ARN = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/juno-backend";
  const docsFor = (config: { address: string; key: string }) => {
    const juno = JSON.parse(fixtureText("juno-backend-staging.json")) as Record<string, any>;
    juno.relayer = { address: config.address, signer: { kind: "kms", key_ref: config.key } };
    juno.trust.operators = [config.address];
    return { [RUNTIME_ARN]: fixtureText("runtime-staging-p1.json"), [JUNO_ARN]: JSON.stringify(juno) } as Record<string, string>;
  };
  const depsFor = (docs: Record<string, string>, chain: ReturnType<typeof fakeJunoChain>, extra: Partial<DeployDeps> = {}) => {
    const lines: string[] = [];
    const deps: DeployDeps = {
      parameters: {
        async read(arn) {
          const value = docs[arn];
          if (value === undefined) throw new Error(`no such parameter ${arn}`);
          return { value, version: 1, arn };
        },
      },
      dynamo: () => {
        throw new Error("set-operator-plan reads no table");
      },
      kms: () => {
        throw new Error("no KMS here");
      },
      now: () => NOW,
      out: (line) => lines.push(line),
      juno: chain,
      ...extra,
    };
    return { deps, lines };
  };
  const plan = (deps: DeployDeps, to = NEW, extra: string[] = []) => runDeployCommand(["set-operator-plan", "--runtime-parameter", RUNTIME_ARN, "--environment", "staging", "--to-relayer", to, ...extra], deps);
  const FLOOR = RELAYER_TRANSACTIONS_PER_GAME * BigInt(500_000);

  test("the funding floor is 67 relayer transactions at the configuration's own fee cap (integers): 33.5 JUNOX by default", () => {
    const f = relayerFunding(OLD_CONFIG);
    assert.equal(f.floor, BigInt(33_500_000));
    assert.equal(f.maxFeePerTransaction, BigInt(500_000));
    assert.equal(f.denom, "ujunox");
    assert.equal(setOperatorMessage(NEW), `{"set_operator":{"operator":"${NEW}"}}`);
  });

  test("set-operator-plan: names the admin from the chain and the exact message; READY only for an existing, funded account; signs nothing", async () => {
    const chain = fakeJunoChain({ operator: OLD, accounts: [NEW] }, { [NEW]: FLOOR });
    const { deps, lines } = depsFor(docsFor({ address: OLD, key: OLD_KEY }), chain);
    assert.equal(await plan(deps), EXIT_OK, lines.join("\n"));
    const out = lines.join("\n");
    assert.match(out, new RegExp(`admin ${STAGING_ADMIN}; operator ${OLD}`));
    assert.match(out, new RegExp(`sender +${STAGING_ADMIN} +\\(Config.admin; admin_guard refuses any other sender, and any funds\\)`));
    assert.match(out, new RegExp(`msg +\\{"set_operator":\\{"operator":"${NEW}"\\}\\}`));
    assert.match(out, /funds +none/);
    assert.match(out, /signed and sent OUTSIDE this tool/);
    assert.match(out, /only inside the drained window/);
    assert.match(out, /67 relayer transactions .* = 33500000 ujunox \(33.5 JUNOX\)/);
    assert.ok(!/mnemonic|private/i.test(out), "nothing secret is asked for or printed");
    assert.deepEqual(chain.calls.filter((c) => c !== "rest"), [`balance ${NEW}`]);
  });

  test("set-operator-plan: NOT READY for a never-funded account, an underfunded one, or an unreachable chain", async () => {
    const absent = depsFor(docsFor({ address: OLD, key: OLD_KEY }), fakeJunoChain({ operator: OLD }));
    assert.equal(await plan(absent.deps), EXIT_FAILED);
    assert.match(absent.lines.join("\n"), /does not exist on chain yet: fund it \(a plain bank send of at least 33.5 JUNOX\)/);
    const short = depsFor(docsFor({ address: OLD, key: OLD_KEY }), fakeJunoChain({ operator: OLD, accounts: [NEW] }, { [NEW]: BigInt(10_000_000) }));
    assert.equal(await plan(short.deps), EXIT_FAILED);
    assert.match(short.lines.join("\n"), /holds 10 JUNOX \(10000000 ujunox\): send at least 23.5 JUNOX more before the pools restart/);
    const down = depsFor(docsFor({ address: OLD, key: OLD_KEY }), fakeJunoChain({ unreachable: true }));
    assert.equal(await plan(down.deps), EXIT_FAILED);
    assert.match(down.lines.join("\n"), /FAIL {2}the contract's admin and operator \(read from the chain\) -- JunoRpcError/);
    const unbound = depsFor(docsFor({ address: OLD, key: OLD_KEY }), fakeJunoChain(), { juno: undefined });
    assert.equal(await plan(unbound.deps), EXIT_FAILED);
    assert.match(unbound.lines.join("\n"), /no chain reader is bound/);
  });

  test("set-operator-plan --to-relayer-key: the address must be the one that KMS key controls; already set says so", async () => {
    const kms = (secret: Buffer) => ({ sdk: {} as never, digest: { getPublicKey: async () => spkiOf(publicKeyOf(secret)), sign: async () => { throw new Error("never signs"); } } as never });
    const funded = fakeJunoChain({ operator: OLD, accounts: [NEW] }, { [NEW]: FLOOR });
    const good = depsFor(docsFor({ address: OLD, key: OLD_KEY }), funded, { kms: () => kms(Buffer.alloc(32, 0x21)) });
    assert.equal(await plan(good.deps, NEW, ["--to-relayer-key", NEW_KEY]), EXIT_OK, good.lines.join("\n"));
    assert.match(good.lines.join("\n"), new RegExp(`${NEW_KEY} controls ${NEW}`));
    const typo = depsFor(docsFor({ address: OLD, key: OLD_KEY }), funded, { kms: () => kms(Buffer.alloc(32, 0x31)) });
    assert.equal(await plan(typo.deps, NEW, ["--to-relayer-key", NEW_KEY]), EXIT_FAILED);
    assert.match(typo.lines.join("\n"), new RegExp(`controls ${THIRD}, not ${NEW}`));
    const done = depsFor(docsFor({ address: OLD, key: OLD_KEY }), fakeJunoChain({ operator: NEW, accounts: [NEW] }, { [NEW]: FLOOR }));
    assert.equal(await plan(done.deps), EXIT_OK);
    assert.match(done.lines.join("\n"), /ALREADY .*no set_operator is needed/);
  });

  test("relayer-rotation-gate (v2): the contract's operator is read from the chain and recorded with the deployment to keep", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-rot-gate-"));
    try {
      /* Every pool drained, captured now; RELAYQ#<old> empty (a stand-in DynamoDB answering the one Query). */
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ format: "18COSMOS/EVIDENCE/v1", captured_at: new Date(NOW - 60_000).toISOString(), environment: "staging", pools: ["p1"] }));
      const td = "arn:aws:ecs:us-east-1:1:task-definition/gs-staging-p1:3";
      fs.writeFileSync(path.join(dir, "services.json"), JSON.stringify({ services: [{ serviceName: "gs-staging-p1", desiredCount: 0, runningCount: 0, pendingCount: 0, taskDefinition: td, deployments: [{ status: "PRIMARY", rolloutState: "COMPLETED", taskDefinition: td }] }] }));
      const queries: string[] = [];
      const dynamo = { send: async (command: { input: { ExpressionAttributeValues?: Record<string, { S?: string }> } }) => (queries.push(JSON.stringify(command.input.ExpressionAttributeValues)), { Items: [] }) } as never;
      const run = async (chain: ReturnType<typeof fakeJunoChain> | undefined, record: string) => {
        const { deps, lines } = depsFor(docsFor({ address: OLD, key: OLD_KEY }), chain ?? fakeJunoChain(), { dynamo: () => dynamo, juno: chain });
        const code = await runDeployCommand(["relayer-rotation-gate", "--runtime-parameter", RUNTIME_ARN, "--environment", "staging", "--from-relayer", OLD, "--to-relayer", NEW, "--evidence", dir, "--record", path.join(dir, record)], deps);
        return { code, out: lines.join("\n"), record: JSON.parse(fs.readFileSync(path.join(dir, record), "utf8")) as Record<string, any> };
      };
      const open = await run(fakeJunoChain({ operator: OLD }), "open.json");
      assert.equal(open.code, EXIT_OK, open.out);
      assert.equal(open.record.format, "18COSMOS/RELAYER-ROTATION-GATE/v2");
      assert.equal(open.record.contract_operator, OLD);
      assert.deepEqual(open.record.deployment, deploymentIdentityOf(OLD_CONFIG));
      assert.equal(open.record.deployment.from_relayer_key_ref, OLD_KEY);
      assert.equal(rotationGateRecordProblem(open.record, { environment: "staging", from: OLD, to: NEW }), null);
      assert.ok(queries.every((q) => q.includes(`RELAYQ#${OLD}`) && !q.includes(`RELAYQ#${NEW}`)), "only the old queue is read");
      /* Already set to the new address (the admin moved early, inside the drain): still OPEN, recorded as such. */
      assert.equal((await run(fakeJunoChain({ operator: NEW }), "early.json")).record.contract_operator, NEW);
      /* A third operator, an unreachable chain, no chain reader: CLOSED (never assumed). */
      const third = await run(fakeJunoChain({ operator: THIRD }), "third.json");
      assert.equal(third.code, EXIT_FAILED);
      assert.match(third.out, /neither --from-relayer nor --to-relayer: not a rotation this gate can prove/);
      assert.match(rotationGateRecordProblem(third.record, { environment: "staging", from: OLD, to: NEW }) ?? "", /not OPEN/);
      const down = await run(fakeJunoChain({ unreachable: true }), "down.json");
      assert.equal(down.code, EXIT_FAILED);
      assert.equal(down.record.contract_operator, null);
      const unbound = await run(undefined, "unbound.json");
      assert.equal(unbound.code, EXIT_FAILED);
      assert.match(unbound.out, /no chain reader is bound in this build/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A compressed secp256k1 key as KMS's DER SubjectPublicKeyInfo (the uncompressed point, as KMS answers). */
function spkiOf(compressed: Buffer): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { decompressPublicKey, bigIntTo32 } = require("../../../escrow/juno/secp256k1") as typeof import("../../../escrow/juno/secp256k1");
  const { x, y } = decompressPublicKey(compressed);
  return Buffer.concat([Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex"), Buffer.from([4]), bigIntTo32(x), bigIntTo32(y)]);
}
