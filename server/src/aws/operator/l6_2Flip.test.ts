// server/src/aws/operator/l6_2Flip.test.ts
//
// ==================================================================
//  LIVE-6 L6-2: THE ROUTING FLIP, RECOVERY, RETIREMENT AND THE L6-4 INTEGRATION -- PURE AND OFFLINE CASES (`npm test`)
// ==================================================================
//
// The DynamoDB half (a real flip of real runtimes, the recovery pass, retirement, the verifier on restore states, the
// generation gate) is `persistence/conformance/l6_2Flip.dynamoLocal.test.ts`. Here, without any table:
//   §1 the control plane from evidence: per-pool target groups and health (a non-primary router healthy), the listener
//      rules and the SHADOWING proof, services behind their own group, the rollback targets' identity layout, the
//      post-flip role changes (exit 5, no 3/4, a replacement), drain-first, the manifest's freshness;
//   §2 the runtime document v2 as Terraform renders it (`/gs/p/<pool>`): parsed by the task's parser; unsafe / duplicate
//      / host routes refused; v1 still read;
//   §3 client compatibility: a protocol-1 client follows an ownership route to `/gs/p/<pool>` on the same host (never
//      another), and a bundle route to its release -- with LIVE-4's frozen frame, unchanged;
//   §4 the flip's role judgement (pure): promotion, demotion, the singleton roles, a routing that moved again;
//   §5 post-restore money safe mode on the escrow service: read-only until F1 and the chain verified it, requests refused,
//      a shorter restored history held -- and a restart re-runs the check (never bypassed);
//   §6 the flip record: written and read back; `awsDeploy verify --flip-record` reads only a flip that moved the routing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { routeFrameFor, routeTargetOf } from "../../../../frontend/src/utils/clientAnswers";
import {
  albPatternMatches,
  checkDrained,
  checkIdentityLayout,
  checkManifest,
  checkPoolListenerRules,
  checkPoolServices,
  checkPoolTargetGroups,
  checkRoleChange,
  checkTargetHealth,
  type Check,
} from "../controlPlane/evidence";
import { FLIP_EVIDENCE_FORMAT, parseFlipRecord, readFlipRecordFile, writeFlipRecord, type FlipRecord } from "../controlPlane/flipRecord";
import { AWS_RUNTIME_CONFIG_FORMAT_V2, parseAwsRuntimeConfig, parseAwsRuntimeConfigText, AwsRuntimeConfigError } from "../runtime/runtimeConfig";
import { ownershipRouteFrame, poolRoutes } from "../../rooms/gameRoutes";
import { GAME_A, makeWorld, play, startedGame, toStockRound, type World } from "../../escrow/escrow3bSupport";
import { RESTORE_READ_ONLY_SENTENCE } from "../../escrow/escrowService";
import type { FinancialGameRecord } from "../../escrow/moneyLifecycle";
import { quietConsole } from "../../rooms/testSupport";
import { judgeRoles } from "./flip";

quietConsole();

const failed = (checks: readonly Check[]) => checks.filter((c) => c.status === "fail");
const allPass = (checks: readonly Check[], label = "") => assert.deepEqual(failed(checks), [], `${label} ${JSON.stringify(failed(checks))}`);
const fails = (checks: readonly Check[], name: RegExp, label: string) => assert.ok(failed(checks).some((c) => name.test(c.name)), `${label}: expected a failure matching ${name}, got ${JSON.stringify(failed(checks))}`);

/* ------------------------------------------------------------------ */
/* Fixtures: a two-pool deployment as capture-evidence prints it          */
/* ------------------------------------------------------------------ */

const TG = { p1: "arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/gs-st-p1/1", p2: "arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/gs-st-p2/2" };
const TGS = new Map(Object.entries(TG));
const ROUTES = { p1: "/gs/p/p1", p2: "/gs/p/p2" };
const rule = (priority: string, paths: string[], target: string | null) => ({
  Priority: priority,
  IsDefault: priority === "default",
  Conditions: paths.length === 0 ? [] : [{ Field: "path-pattern", Values: paths, PathPatternConfig: { Values: paths } }],
  Actions: [target === null ? { Type: "fixed-response" } : { Type: "forward", TargetGroupArn: target }],
});
const RULES = { Rules: [rule("100", ["/gs/p/p1"], TG.p1), rule("101", ["/gs/p/p2"], TG.p2), rule("1000", ["/gs*"], TG.p1), rule("default", [], null)] };
const service = (pool: string, overrides: Record<string, unknown> = {}) => ({
  serviceName: `gs-st-${pool}`,
  desiredCount: 1,
  runningCount: 1,
  pendingCount: 0,
  taskDefinition: `arn:aws:ecs:us-east-1:1:task-definition/gs-st-${pool}:3`,
  deployments: [{ status: "PRIMARY", rolloutState: "COMPLETED", taskDefinition: `arn:aws:ecs:us-east-1:1:task-definition/gs-st-${pool}:3` }],
  loadBalancers: [{ targetGroupArn: (TG as Record<string, string>)[pool] }],
  ...overrides,
});
const healthy = { TargetHealthDescriptions: [{ Target: { Id: "10.0.0.9" }, TargetHealth: { State: "healthy" } }] };
const revision = (n: number, layout: string | null) => ({ taskDefinition: { taskDefinitionArn: `arn:aws:ecs:us-east-1:1:task-definition/gs-st-p1:${n}`, status: "ACTIVE" }, tags: layout === null ? [] : [{ key: "gs:identity-layout", value: layout }] });
const T = Date.parse("2026-09-30T10:00:00Z");
const task = (arn: string, exitCode: number | null, times: { startedAt?: string; stoppedAt?: string }, pool = "p1") => ({ taskArn: arn, group: `service:gs-st-${pool}`, containers: [{ name: "game-server", exitCode }], ...times });

/* ================================================================== */
describe("§1 the multi-pool control plane, judged from evidence", () => {
  test("per-pool target groups, a HEALTHY non-primary router, each service behind its own group", () => {
    const groups = checkPoolTargetGroups({ TargetGroups: [{ TargetGroupArn: TG.p1, TargetGroupName: "gs-st-p1", HealthCheckPath: "/gs/readyz", Matcher: { HttpCode: "200" }, TargetType: "ip" }, { TargetGroupArn: TG.p2, TargetGroupName: "gs-st-p2", HealthCheckPath: "/gs/readyz", Matcher: { HttpCode: "200" }, TargetType: "ip" }] }, { environment: "st", pools: ["p1", "p2"] });
    allPass(groups.checks);
    assert.deepEqual([...groups.arns], [...TGS]);
    allPass([checkTargetHealth("p2", healthy, 1)], "a non-primary router (readiness 200 non-primary) is a healthy target");
    fails([checkTargetHealth("p2", { TargetHealthDescriptions: [{ TargetHealth: { State: "unhealthy" } }] }, 1)], /target health p2/, "unhealthy");
    fails([checkTargetHealth("p2", healthy, 0)], /target health p2/, "a drained pool with a target");
    allPass(checkPoolServices({ services: [service("p1"), service("p2")] }, { environment: "st", pools: ["p1", "p2"], targetGroups: TGS }));
    fails(checkPoolServices({ services: [service("p1"), service("p2", { loadBalancers: [{ targetGroupArn: TG.p1 }] })] }, { environment: "st", pools: ["p1", "p2"], targetGroups: TGS }), /p2: its own target group/, "another pool's group");
    fails(checkPoolServices({ services: [service("p1", { deployments: [{ status: "PRIMARY", rolloutState: "IN_PROGRESS", taskDefinition: "arn:aws:ecs:us-east-1:1:task-definition/gs-st-p1:3" }] }), service("p2")] }, { environment: "st", pools: ["p1", "p2"], targetGroups: TGS }), /no deployment in progress/, "a rollout in progress");
  });

  test("listener rules: /gs* -> the primary, each exact ws_path -> its own pool, and NOTHING shadows a pool", () => {
    allPass(checkPoolListenerRules(RULES, { primary: "p1", routes: ROUTES, targetGroups: TGS }));
    /* After the flip (and the Terraform primary flag), /gs* forwards to p2. */
    fails(checkPoolListenerRules(RULES, { primary: "p2", routes: ROUTES, targetGroups: TGS }), /ALB \/gs\* rule/, "the default still on the old primary");
    /* A wildcard earlier than a pool's exact rule answers its path. */
    const wildcard = { Rules: [rule("50", ["/gs/p/*"], TG.p1), ...RULES.Rules] };
    fails(checkPoolListenerRules(wildcard, { primary: "p1", routes: ROUTES, targetGroups: TGS }), /no rule shadows/, "a /gs/p/* rule before p2's");
    /* A pool rule AFTER /gs* is never reached. */
    const late = { Rules: [rule("100", ["/gs/p/p1"], TG.p1), rule("1000", ["/gs*"], TG.p1), rule("1001", ["/gs/p/p2"], TG.p2), rule("default", [], null)] };
    fails(checkPoolListenerRules(late, { primary: "p1", routes: ROUTES, targetGroups: TGS }), /ALB rule \/gs\/p\/p2|no rule shadows/, "p2's rule after the default");
    /* A prefix pattern for p1 would shadow p10: exact paths only. */
    const tg10 = new Map([...TGS, ["p10", "arn:tg-p10"]]);
    const prefix = { Rules: [rule("100", ["/gs/p/p1*"], TG.p1), rule("101", ["/gs/p/p10"], "arn:tg-p10"), rule("1000", ["/gs*"], TG.p1), rule("default", [], null)] };
    fails(checkPoolListenerRules(prefix, { primary: "p1", routes: { p1: "/gs/p/p1", p10: "/gs/p/p10" }, targetGroups: tg10 }), /ALB rule \/gs\/p\/p1|no rule shadows/, "/gs/p/p1* answering /gs/p/p10");
    const wrong = { Rules: [rule("100", ["/gs/p/p1"], TG.p2), ...RULES.Rules.slice(1)] };
    fails(checkPoolListenerRules(wrong, { primary: "p1", routes: ROUTES, targetGroups: TGS }), /ALB rule \/gs\/p\/p1/, "a pool path to another pool's group");
    assert.ok(albPatternMatches("/gs*", "/gs/p/p2") && albPatternMatches("/gs/p/p1", "/gs/p/p1") && !albPatternMatches("/gs/p/p1", "/gs/p/p10") && !albPatternMatches("/gs/p/p1", "/GS/p/p1"));
  });

  test("L6-4 §12.3: every ACTIVE revision -- every rollback target -- must declare the identity layout", () => {
    allPass([checkIdentityLayout("p1", [revision(6, "2"), revision(7, "2")])]);
    fails([checkIdentityLayout("p1", [revision(6, null), revision(7, "2")])], /identity layout p1/, "a pre-L6-4 revision still ACTIVE");
    fails([checkIdentityLayout("p1", [revision(7, "1")])], /identity layout p1/, "layout 1");
    fails([checkIdentityLayout("p1", [])], /identity layout p1/, "no revision at all");
  });

  test("after a flip: exit 5 then a replacement; an exit 3 / 4 stays ABNORMAL inside the window", () => {
    const stopped = { tasks: [task("t-old", 5, { startedAt: "2026-09-30T09:00:00Z", stoppedAt: "2026-09-30T10:00:20Z" }), task("t-older", 0, { stoppedAt: "2026-09-30T08:00:00Z" })] };
    const running = { tasks: [task("t-new", null, { startedAt: "2026-09-30T10:01:00Z" })] };
    allPass(checkRoleChange("p1", "st", stopped, running, T));
    fails(checkRoleChange("p1", "st", { tasks: [...stopped.tasks, task("t-lost", 3, { stoppedAt: "2026-09-30T10:00:10Z" })] }, running, T), /no loss/, "an exit 3 in the window");
    fails(checkRoleChange("p1", "st", { tasks: [task("t-old", 5, { stoppedAt: "2026-09-30T09:59:00Z" })] }, running, T), /exit 5/, "a role change BEFORE the flip is not this flip's");
    fails(checkRoleChange("p1", "st", stopped, { tasks: [] }, T), /replacement running/, "no replacement");
    fails(checkRoleChange("p1", "st", stopped, { tasks: [task("t-other", null, { startedAt: "2026-09-30T10:01:00Z" }, "p2")] }, T), /replacement running/, "another pool's task is not the replacement");
  });

  test("drain-first (L5-8): desired 0 is not enough -- running = pending = 0 and settled", () => {
    allPass([checkDrained({ services: [service("p1", { desiredCount: 0, runningCount: 0 })] }, "st", "p1")]);
    fails([checkDrained({ services: [service("p1", { desiredCount: 0, runningCount: 1 })] }, "st", "p1")], /drained p1/, "0/100 with a task still running");
    fails([checkDrained({ services: [service("p1", { desiredCount: 0, runningCount: 0, pendingCount: 1 })] }, "st", "p1")], /drained p1/, "a pending replacement");
  });

  test("the manifest: this environment, these pools -- and a flip refuses stale evidence", () => {
    const m = { format: "18COSMOS/EVIDENCE/v1", captured_at: "2026-09-30T10:00:00Z", environment: "st", pools: ["p1", "p2"] };
    allPass(checkManifest(m, { environment: "st", pools: ["p1", "p2"], now: T + 60_000, maxAgeMs: 15 * 60_000 }));
    fails(checkManifest(m, { environment: "st", pools: ["p1", "p2"], now: T + 20 * 60_000, maxAgeMs: 15 * 60_000 }), /fresh/, "20 minutes old");
    fails(checkManifest(m, { environment: "prod", pools: ["p1"], now: T, maxAgeMs: null }), /evidence manifest$/, "another environment");
    fails(checkManifest(m, { environment: "st", pools: ["p3"], now: T, maxAgeMs: null }), /pools/, "a pool not captured");
  });
});

/* ================================================================== */
describe("§2 the runtime document v2 as the IaC renders it", () => {
  const base = { environment: "staging", region: "us-east-1", pool: "p2", generation: 1, game_table: "gs-staging-game-g1", identity_table: "gs-staging-identity", ledger_table_arn: "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger", escrow: null };

  test("the Terraform fixture (two pools) parses with the task's own parser: /gs/p/<pool>, one table for all", () => {
    const text = fs.readFileSync(path.join(__dirname, "../../../../../../infra/aws/fixtures/runtime-staging-p2.json"), "utf8");
    const config = parseAwsRuntimeConfigText(text);
    assert.equal(config.format, AWS_RUNTIME_CONFIG_FORMAT_V2);
    assert.deepEqual(Object.fromEntries(Object.entries(config.routes).map(([p, e]) => [p, e.wsPath])), { p1: "/gs/p/p1", p2: "/gs/p/p2" });
    const table = poolRoutes("p2", config.routes);
    assert.deepEqual(table.ownWsPaths, ["/gs/p/p2"], "each pool answers its own path");
    assert.deepEqual(table.destinationOf("p1"), { wsPath: "/gs/p/p1" });
    assert.equal(table.destinationOf("p2"), null, "never a route to itself");
  });

  test("duplicate, unsafe or off-/gs paths, and hosts, are refused; v1 is still read (no routes)", () => {
    const refuse = (routes: unknown, why: RegExp) => assert.throws(() => parseAwsRuntimeConfig({ ...base, format: AWS_RUNTIME_CONFIG_FORMAT_V2, routes }), (error: unknown) => error instanceof AwsRuntimeConfigError && why.test(error.message));
    refuse({ p1: { ws_path: "/gs/p/x" }, p2: { ws_path: "/gs/p/x" } }, /another pool's too/);
    refuse({ p1: { ws_path: "/gs/p/../p2" } }, /not a plain absolute path/);
    refuse({ p1: { ws_path: "https://evil.example/gs/p/p1" } }, /not a plain absolute path/);
    refuse({ p1: { ws_path: "/api/p1" } }, /under \/gs\//);
    refuse({ p1: { ws_path: "/gs/p/p1", bundle_path: "/gs/r/1/" } }, /bundle_path must be a page path/);
    refuse({ "op:r-0000000000000000": { ws_path: "/gs/p/op" } }, /not a pool/);
    const v1 = parseAwsRuntimeConfig({ ...base, format: "18COSMOS/AWS-RUNTIME/v1" });
    assert.deepEqual(v1.routes, {}, "v1: no route table (replay / backward deployment safety)");
  });
});

/* ================================================================== */
describe("§3 client compatibility: the existing client follows the flip's routes -- no client config needed", () => {
  const env = { pageOrigin: "https://play.example.com", bundleBase: "", gameServerUrl: "wss://play.example.com/gs", gameId: GAME_A };

  test("an ownership route to /gs/p/<pool> reconnects the link on the SAME game-server host (LIVE-4's frozen frame)", () => {
    const frame = ownershipRouteFrame(GAME_A, { wsPath: "/gs/p/p2" });
    assert.ok(frame !== null);
    assert.deepEqual(frame, routeFrameFor({ kind: "route", code: "client-rules", detail: "the game is served by another pool" }, { wsPath: "/gs/p/p2" }, { gameId: GAME_A }), "byte for byte LIVE-4's builder");
    assert.deepEqual(routeTargetOf(frame as { gameId?: unknown; wsPath?: unknown }, env), { kind: "socket", url: "wss://play.example.com/gs/p/p2", path: "/gs/p/p2" });
    /* A client entering /gs after a flip reaches the new primary (the /gs* rule) and needs no route at all; one routed to
       a pool that has since been demoted is routed on (a second hop) or answered unavailable -- never off-host. */
    assert.deepEqual(routeTargetOf({ gameId: GAME_A, wsPath: "//evil.example/gs" }, env), { kind: "none", why: "unsafe-destination" });
    assert.deepEqual(routeTargetOf({ gameId: "g_other", wsPath: "/gs/p/p2" }, env), { kind: "none", why: "other-game" });
  });

  test("an old bundle is sent to ITS release by a bundle route on the page's own origin", () => {
    assert.deepEqual(routeTargetOf({ gameId: GAME_A, bundlePath: "/r/11/" }, env), { kind: "bundle", url: "https://play.example.com/r/11/", path: "/r/11/" });
  });
});

/* ================================================================== */
describe("§4 the flip's role judgement", () => {
  const before = { at: 1, pools: { p1: { epoch: 4, task: "t-a" }, p2: { epoch: 2, task: "t-b" } }, identity_writer: { epoch: 7, pool: "p1", task: "t-a" }, relayer: { epoch: 3, pool: "p1", task: "t-a" } };
  const record = { from: "p1", to: "p2", expected_version: 5, before };
  const routing = (pool: string, version: number) => ({ primary_pool: pool, routing_version: version, updated_at: 2, updated_by: "x", claim: "c" });
  const after = (overrides: Record<string, unknown> = {}) => ({ at: 9, pools: { p1: { epoch: 5, task: "t-c" }, p2: { epoch: 3, task: "t-d" } }, identity_writer: { epoch: 8, pool: "p2", task: "t-d" }, relayer: { epoch: 4, pool: "p2", task: "t-d" }, ...overrides });

  test("settled only when both pools restarted and B's CURRENT task holds the singleton roles", () => {
    allPass(judgeRoles(record, { snap: after(), routing: routing("p2", 6) }, true));
    fails(judgeRoles(record, { snap: after({ pools: { p1: { epoch: 4, task: "t-a" }, p2: { epoch: 3, task: "t-d" } } }), routing: routing("p2", 6) }, true), /p1 restarted/, "A not restarted (no exit 5 yet)");
    fails(judgeRoles(record, { snap: after({ identity_writer: { epoch: 7, pool: "p1", task: "t-a" } }), routing: routing("p2", 6) }, true), /identity writer|holds no identity/, "the role still A's");
    fails(judgeRoles(record, { snap: after({ identity_writer: { epoch: 8, pool: "p2", task: "t-b" } }), routing: routing("p2", 6) }, true), /identity writer: B's current task/, "held by B's OLD task (not a restart into the role)");
    fails(judgeRoles(record, { snap: after({ relayer: null }), routing: routing("p2", 6) }, true), /relayer: B's current task/, "no relayer yet (escrow)");
    allPass(judgeRoles(record, { snap: after({ relayer: null }), routing: routing("p2", 6) }, false), "no escrow: no relayer role");
    fails(judgeRoles(record, { snap: after(), routing: routing("p1", 7) }, true), /routing still names B/, "the routing moved again");
  });
});

/* ================================================================== */
describe("§5 post-restore safe mode: a restored money game is read-only until its history is verified", () => {
  const fin = (world: World) => world.financial.load(GAME_A) as Promise<FinancialGameRecord>;

  async function played(): Promise<World> {
    const world = makeWorld();
    await startedGame(world, GAME_A);
    const session = play(world, GAME_A, 0);
    await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed !== null);
    toStockRound(world, GAME_A, session);
    await world.drive(async () => BigInt((await fin(world)).chain.checkpoint_confirmed?.seq ?? "0") > BigInt(2));
    return world;
  }

  test("restored (safe mode): the gate refuses until F1 + the chain check pass in THIS process; then it serves", async () => {
    const world = await played();
    assert.equal(world.service.restoreGate(GAME_A), null, "not a restored table: served as ever");
    world.restoreSafeMode = true;
    await world.restart();
    assert.equal(world.service.restoreGate(GAME_A), RESTORE_READ_ONLY_SENTENCE, "restored: read-only at first");
    const start = await world.service.requestStart(GAME_A, []);
    assert.deepEqual(start.ok === false && start.code, "restore-unverified", "no money request before the verification");
    /* Review M1: no SERVER-driven money change either -- the start reconciliation, the relayer's admission. */
    const financialBefore = JSON.stringify(await fin(world));
    assert.equal(await world.service.reconcileStart(GAME_A), "pending", "the start reconciliation waits");
    const intents = await world.service.intentsOf(GAME_A);
    assert.ok(intents.length > 0, "the played game has intents");
    for (const intent of intents) assert.equal((await world.service.admit(intent)).kind, "undecided", "the relayer admits nothing");
    await world.service.closeUnboundTable(GAME_A);
    assert.equal(JSON.stringify(await fin(world)), financialBefore, "nothing written");
    const verdict = await world.service.restoreCheck(GAME_A);
    assert.equal(verdict.kind, "verified", JSON.stringify(verdict));
    assert.equal(world.service.restoreGate(GAME_A), null, "verified: served");
    assert.ok(world.ops.lines.some((a) => a.event === "money.restore-verified"), "audited");
    /* A restart re-runs it: the exit is reproduced, never stored -- so it can never be bypassed. */
    await world.restart();
    assert.equal(world.service.restoreGate(GAME_A), RESTORE_READ_ONLY_SENTENCE, "a new process verifies again");
    assert.equal((await world.service.restoreCheck(GAME_A)).kind, "verified");
  });

  test("a restored history SHORTER than the ledger's reservations is HELD (journal-ahead) and stays read-only", async () => {
    const world = await played();
    world.logs.set(GAME_A, world.logs.get(GAME_A)!.slice(0, 1)); // the game table restored to just after the deal
    world.restoreSafeMode = true;
    await world.restart();
    const verdict = await world.service.restoreCheck(GAME_A);
    assert.equal(verdict.kind, "held", JSON.stringify(verdict));
    assert.equal((await fin(world)).hold?.code, "journal-ahead", "the existing durable F1 hold");
    assert.equal(world.service.restoreGate(GAME_A), RESTORE_READ_ONLY_SENTENCE, "never served");
  });

  test("a money game with nothing to verify (no financial record, never bound) is served at once", async () => {
    const world = makeWorld();
    world.restoreSafeMode = true;
    await world.restart();
    assert.equal((await world.service.restoreCheck("g_00000000000000000000000000")).kind, "verified", "no financial record");
    assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
    assert.equal((await world.service.restoreCheck(GAME_A)).kind, "verified", "never bound to a chain game");
  });
});

/* ================================================================== */
describe("§6 the flip record (18COSMOS/FLIP-EVIDENCE/v1)", () => {
  test("written atomically, read back; the verifier reads only a flip that moved the routing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l62-flip-"));
    try {
      const file = path.join(dir, "flip.json");
      const record: FlipRecord = { format: FLIP_EVIDENCE_FORMAT, environment: "st", from: "p1", to: "p2", expected_version: 5, note: "n", verdict: "planned", preflight: { at: 1, checks: [] }, before: null, cas: null, window: null, observations: [], after: null };
      writeFlipRecord(file, record);
      assert.deepEqual(parseFlipRecord(fs.readFileSync(file, "utf8")), record);
      assert.match((readFlipRecordFile(file) as { problem: string }).problem, /verdict is planned/);
      writeFlipRecord(file, { ...record, verdict: "roles-settled", cas: { at: T, run: "op:r-0123456789abcdef", outcome: "applied", version: 6, detail: "d" } });
      assert.deepEqual(readFlipRecordFile(file), { from: "p1", to: "p2", version: 6, since: T, rollback: false });
      assert.match((parseFlipRecord("{}") as { problem: string }).problem, /not 18COSMOS\/FLIP-EVIDENCE\/v1/);
      assert.deepEqual(fs.readdirSync(dir), ["flip.json"], "no temporary file left behind");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
