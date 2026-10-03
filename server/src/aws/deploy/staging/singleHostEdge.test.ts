// server/src/aws/deploy/staging/singleHostEdge.test.ts
//
// PHASE 1 REMAINDER (SINGLE_HOST_MIGRATION.md step 16): `stage-probe edge --topology single-host`. Offline: a fake edge
// (the real edge diagnostic answering behind "CloudFront + Caddy") and a synthetic step-15b host evidence directory.
//
//   - the legacy ECS probe's semantics are unchanged (it still requires the prerequisite and the ALB's idle timeout, it
//     refuses the host flags, and its judge refuses a single-host record);
//   - the single-host probe PASSES with the correct host evidence, records a normal probe-edge.json and its verdict;
//   - it refuses missing host evidence, foreign / wrong origin evidence (an ALB origin, another host, another instance, an
//     ECS verification, a PASS label over a failed check), an inadequately short hold, and a tampered record;
//   - it never substitutes the ECS prerequisite or the ALB's attributes for the host's evidence.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { edgeDiagnosticAnswer } from "../../../ingress/edgeDiagnostic";
import type { DeployDeps } from "../commands";
import { stageProbeCommand, type StagingDeps } from "./commands";
import { judgeWsIdle, LOBBY_SUBSCRIPTION, requiredIdleMs, type EdgeTransport, type SocketEvent, type SocketObservation } from "./edgeProbe";
import { EVIDENCE, PREREQUISITE_FORMAT, stableStringify, VERIFY_RECORD_FORMAT } from "./evidence";
import { CADDY_IDLE_SECONDS, HOST_EDGE_FILES, judgeSingleHostEdge, readHostEdgeEvidence, SINGLE_HOST_EDGE_FORMAT, SINGLE_HOST_EDGE_VERDICT_FILE } from "./singleHostEdge";
import { HOST_EVIDENCE_FORMAT, HOST_REPORT_FORMAT } from "../hostVerify";

const RUN = "phase1-edge-0001";
const INSTANCE = "i-01fe56536bf591382";
const ORIGIN_HOST = "gs-origin-host.example.org";
const ALB_NAME = "gs-staging-alb-123456789.us-east-1.elb.amazonaws.com";
const PLAY = "play.example.org";
const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const VERIFIED_AT = "2026-10-03T11:50:00.000Z";
const VIEWER_IP = "203.0.113.77";
const COOKIE = "v1.sessionid00.secretsecretsecretsecret";
const REQUIRED_MS = requiredIdleMs(CADDY_IDLE_SECONDS, 60);

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "p1-edge-"));
const write = (dir: string, file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};

/* ------------------------------------------------------------------ */
/* The step-15b host evidence                                           */
/* ------------------------------------------------------------------ */

interface HostEvidenceOptions {
  readonly gsOriginDomain?: string;
  readonly reportGsOrigin?: string;
  readonly reportInstance?: string;
  readonly topology?: string | null;
  readonly verdict?: string;
  readonly failedCheck?: boolean;
  readonly originRead?: number;
  readonly aliases?: readonly string[];
  readonly verifiedAt?: string;
  readonly skip?: readonly string[];
}

function distributionConfig(gsOriginDomain: string, originRead: number, aliases: readonly string[]) {
  return {
    ETag: "E1",
    DistributionConfig: {
      Aliases: { Quantity: aliases.length, Items: [...aliases] },
      Origins: {
        Quantity: 2,
        Items: [
          { Id: "site", DomainName: "site-bucket.s3.us-east-1.amazonaws.com" },
          { Id: "gs-alb", DomainName: gsOriginDomain, CustomOriginConfig: { HTTPSPort: 443, OriginProtocolPolicy: "https-only", OriginReadTimeout: originRead, OriginKeepaliveTimeout: 5 } },
        ],
      },
      DefaultCacheBehavior: { TargetOriginId: "site" },
      CacheBehaviors: { Quantity: 1, Items: [{ PathPattern: "/gs*", TargetOriginId: "gs-alb", OriginRequestPolicyId: "orp-1" }] },
    },
  };
}

function hostEvidence(options: HostEvidenceOptions = {}): string {
  const dir = tmp();
  const topology = options.topology === undefined ? "coexist" : options.topology;
  const at = options.verifiedAt ?? VERIFIED_AT;
  const checks = [
    { name: "edge: /gs* origin", status: "pass", detail: `${options.gsOriginDomain ?? ORIGIN_HOST} (origin gs-alb)` },
    { name: "host: EC2", status: options.failedCheck === true ? "fail" : "pass", detail: "t4g.small" },
    { name: "Terraform outputs = what runs", status: "skipped", detail: "not asked" },
  ];
  const files: Record<string, unknown> = {
    "manifest.json": { format: HOST_EVIDENCE_FORMAT, captured_at: "2026-10-03T11:48:00Z", environment: "staging", region: "us-east-1", instance_id: INSTANCE, distribution: "E123ABC", calls: [{ file: "distribution-config.json", ok: true }, { file: "origin-request-policy.json", ok: true }] },
    "distribution-config.json": distributionConfig(options.gsOriginDomain ?? ORIGIN_HOST, options.originRead ?? 60, options.aliases ?? [PLAY]),
    [HOST_EDGE_FILES.verify]: { format: VERIFY_RECORD_FORMAT, run_id: null, part: "app", environment: "staging", generation: 1, at, verdict: options.verdict ?? "PASS", ...(topology === null ? {} : { topology }), checks },
    [HOST_EDGE_FILES.report]: {
      format: HOST_REPORT_FORMAT,
      topology: topology ?? "coexist",
      environment: "staging",
      generation: 1,
      at,
      verdict: options.verdict ?? "PASS",
      facts: { ec2: { instance_id: options.reportInstance ?? INSTANCE }, cloudfront: { gs_origin: options.reportGsOrigin ?? options.gsOriginDomain ?? ORIGIN_HOST } },
      checks,
    },
  };
  for (const [file, value] of Object.entries(files)) if (!(options.skip ?? []).includes(file)) write(dir, file, value);
  return dir;
}

/* ------------------------------------------------------------------ */
/* The edge stand-in: the real diagnostic behind CloudFront + Caddy     */
/* ------------------------------------------------------------------ */

const pingsUntil = (end: number, every = 25_000): SocketEvent[] => {
  const out: SocketEvent[] = [];
  for (let t = every; t < end; t += every) out.push({ at_ms: t, kind: "ping" });
  return out;
};

function fakeEdge(options: { readonly appended?: number; readonly idle?: (hold: number) => SocketObservation } = {}): EdgeTransport & { readonly calls: string[] } {
  const calls: string[] = [];
  const withSent = (o: SocketObservation, frame: string | undefined): SocketObservation => (frame === undefined || !o.opened ? o : { ...o, events: [{ at_ms: 0, kind: "sent", frame_kind: String((JSON.parse(frame) as { kind?: unknown }).kind) }, ...o.events] });
  return {
    calls,
    async get(url, h) {
      calls.push(url);
      const u = new URL(url);
      /* CloudFront appends the viewer, Caddy appends CloudFront: two hops. */
      const appended = [VIEWER_IP, "130.176.0.10", "10.0.0.9"].slice(0, options.appended ?? 2);
      const xff = [...(h["X-Forwarded-For"] ?? "").split(",").map((x) => x.trim()).filter((x) => x !== ""), ...appended].join(", ");
      return { status: 200, body: JSON.stringify(edgeDiagnosticAnswer({ url: `${u.pathname}${u.search}`, headers: { "x-forwarded-for": xff }, socket: { remoteAddress: "127.0.0.1" } } as never, 2)) };
    },
    async observeSocket(url, _h, hold, sendOnOpen) {
      calls.push(url);
      if (new URL(url).searchParams.get("cp") === "9") return withSent({ upgrade_status: null, opened: true, events: [{ at_ms: 40, kind: "message", frame_kind: "reload", frame_code: "client-protocol" }, { at_ms: 41, kind: "close", code: 4426, clean: true }], ended_by: "remote", duration_ms: 41 }, sendOnOpen);
      return withSent(options.idle?.(hold) ?? { upgrade_status: null, opened: true, events: [...pingsUntil(hold), { at_ms: hold, kind: "close", code: 1000, clean: true }], ended_by: "probe", duration_ms: hold }, sendOnOpen);
    },
  };
}

function harness(edge: EdgeTransport = fakeEdge()) {
  const out: string[] = [];
  const deps = { now: () => NOW, out: (line: string) => out.push(line) } as unknown as DeployDeps;
  const staging: StagingDeps = { env: { GS_CERT_SESSION_COOKIE: COOKIE }, monotonic: () => 0, edge, repository: "/nonexistent" };
  return { out, deps, staging };
}

const hostArgs = (evidence: string, host: string, extra: readonly string[] = []) => [
  "edge", "--topology", "single-host", "--run-id", RUN, "--evidence", evidence, "--host-evidence", host, "--instance-id", INSTANCE, "--origin-hostname", ORIGIN_HOST,
  "--base-url", `https://${PLAY}`, "--origin", `https://${PLAY}`, "--environment", "staging", "--generation", "1", "--pool", "p1", "--expected-client-ip", VIEWER_IP, ...extra,
];

const message = (p: Promise<number>) => p.then((code) => `exit ${code}`, (error: Error) => error.message);
const readJson = (dir: string, file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, any>;

/** An ECS-era evidence directory that WOULD satisfy the legacy probe: a PASS prerequisite and the ALB's attributes. */
function ecsEvidence(dir: string = tmp()): string {
  write(dir, EVIDENCE.prerequisite, { format: PREREQUISITE_FORMAT, run_id: RUN, verdict: "PASS", at: "2026-10-03T11:00:00Z" });
  write(dir, "load-balancer-attributes.json", { Attributes: [{ Key: "idle_timeout.timeout_seconds", Value: "300" }] });
  write(dir, "distribution-config.json", distributionConfig(ALB_NAME, 60, [PLAY]));
  return dir;
}

/* ------------------------------------------------------------------ */

describe("PHASE 1 REMAINDER step 16: the legacy ECS edge probe is unchanged", () => {
  test("the default (ECS) path still requires stage-cert prerequisite PASS and the ALB's idle timeout", async () => {
    const h = harness();
    const empty = tmp();
    const ecsArgs = ["edge", "--run-id", RUN, "--evidence", empty, "--base-url", `https://${PLAY}`, "--origin", `https://${PLAY}`, "--environment", "staging", "--generation", "1", "--pool", "p1"];
    assert.match(await message(stageProbeCommand(ecsArgs, h.deps, h.staging)), /prerequisite\.json in .* is not PASS for phase1-edge-0001: run `stage-cert prerequisite` first/);
    /* A PASS prerequisite but no ALB attribute: still refused, exactly as before. */
    write(empty, EVIDENCE.prerequisite, { format: PREREQUISITE_FORMAT, run_id: RUN, verdict: "PASS" });
    assert.match(await message(stageProbeCommand(ecsArgs, h.deps, h.staging)), /no ALB idle timeout or CloudFront origin read timeout/);
    /* `--topology ecs` is the same path. */
    assert.match(await message(stageProbeCommand([...ecsArgs, "--topology", "ecs"], h.deps, h.staging)), /no ALB idle timeout/);
    assert.equal((h.staging.edge as ReturnType<typeof fakeEdge>).calls.length, 0, "nothing was probed");
  });

  test("the ECS path never takes the single host's evidence (its flags are refused, never silently used)", async () => {
    const h = harness();
    const host = hostEvidence();
    for (const flag of [["--host-evidence", host], ["--instance-id", INSTANCE], ["--origin-hostname", ORIGIN_HOST]]) {
      const msg = await message(stageProbeCommand(["edge", "--run-id", RUN, "--evidence", tmp(), "--base-url", `https://${PLAY}`, "--origin", `https://${PLAY}`, "--environment", "staging", "--generation", "1", "--pool", "p1", ...flag], h.deps, h.staging));
      assert.match(msg, /belongs to --topology single-host/);
    }
    assert.match(await message(stageProbeCommand(["edge", "--topology", "alb-less", "--run-id", RUN], h.deps, h.staging)), /--topology is ecs .* or single-host/);
  });

  test("the ECS path still probes and records exactly its legacy record (ALB bound, no proxy field)", async () => {
    const dir = ecsEvidence();
    const h = harness();
    const code = await stageProbeCommand(["edge", "--run-id", RUN, "--evidence", dir, "--base-url", `https://${PLAY}`, "--origin", `https://${PLAY}`, "--environment", "staging", "--generation", "1", "--pool", "p1"], h.deps, h.staging);
    assert.equal(code, 0);
    const record = readJson(dir, EVIDENCE.edge);
    assert.equal(record.topology, undefined);
    assert.equal(record.host, undefined);
    assert.equal(record.sections.ws_idle.alb_idle_seconds, 300);
    assert.equal(record.sections.ws_idle.proxy, undefined);
    assert.equal(record.sections.ws_idle.required_ms, requiredIdleMs(300, 60));
    assert.deepEqual(judgeWsIdle(record.sections, { albIdleSeconds: 300, originReadTimeoutSeconds: 60 }).filter((c) => c.status !== "pass"), []);
    assert.ok(!fs.existsSync(path.join(dir, SINGLE_HOST_EDGE_VERDICT_FILE)), "the ECS path writes no single-host verdict (stage-cert certify judges it)");
    assert.ok(h.out.some((l) => /RECORDED: .*\(judged by stage-cert certify\)/.test(l)));
  });

  test("the ECS judge refuses a single-host record (the host's path never stands in for the ALB's)", async () => {
    const dir = tmp();
    const h = harness();
    assert.equal(await stageProbeCommand(hostArgs(dir, hostEvidence()), h.deps, h.staging), 0);
    const record = readJson(dir, EVIDENCE.edge);
    const ecs = judgeWsIdle(record.sections, { albIdleSeconds: 300, originReadTimeoutSeconds: 60 });
    assert.match(ecs.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`).join("\n"), /the interval is the evidence's: the record is the single host's path \(proxy caddy\), not the ALB's/);
  });
});

describe("PHASE 1 REMAINDER step 16: the single host's edge probe", () => {
  test("PASSES with the correct host evidence: CloudFront -> Caddy, ALL query strings, two hops, the WebSocket idle over max(CloudFront, Caddy, pong) + 2 pings", async () => {
    const dir = tmp();
    const host = hostEvidence();
    const h = harness();
    const code = await stageProbeCommand(hostArgs(dir, host), h.deps, h.staging);
    assert.equal(code, 0, h.out.join("\n"));
    assert.ok(h.out.some((l) => l.startsWith("SINGLE-HOST EDGE PROBE: PASS")));
    const record = readJson(dir, EVIDENCE.edge);
    assert.equal(record.format, "18COSMOS/L6-6-PROBE/v1");
    assert.equal(record.probe, "edge");
    assert.equal(record.topology, "single-host");
    assert.deepEqual([record.host.instance_id, record.host.origin_hostname], [INSTANCE, ORIGIN_HOST]);
    assert.equal(record.host.evidence.topology, "coexist");
    assert.equal(record.sections.ws_idle.proxy, "caddy");
    assert.equal(record.sections.ws_idle.proxy_idle_seconds, CADDY_IDLE_SECONDS);
    assert.equal(record.sections.ws_idle.alb_idle_seconds, undefined, "no ALB bound is recorded on the host's path");
    assert.equal(record.sections.ws_idle.required_ms, REQUIRED_MS);
    assert.ok(record.sections.ws_idle.hold_ms >= REQUIRED_MS);
    assert.equal(record.sections.ws_idle.subscription, LOBBY_SUBSCRIPTION);
    assert.ok(!JSON.stringify(record).includes(COOKIE), "the session cookie never lands in the record");
    const verdict = readJson(dir, SINGLE_HOST_EDGE_VERDICT_FILE);
    assert.equal(verdict.format, SINGLE_HOST_EDGE_FORMAT);
    assert.equal(verdict.verdict, "PASS");
    assert.ok(verdict.checks.length >= 20);
    assert.ok(verdict.checks.every((c: { status: string }) => c.status === "pass"));
    const names = verdict.checks.map((c: { name: string }) => c.name).join("\n");
    for (const name of [/ALL query strings forwarded unchanged/, /exactly 2 proxies appended/, /GS_TRUSTED_PROXY_HOPS of the serving single host/, /survived client -> CloudFront -> Caddy -> server/, /cp reaches the server through \/gs/, /probed through the distribution/, /after the host verification \(15b\)/]) assert.match(names, name);
    assert.equal(verdict.measurements.required_ms, REQUIRED_MS);
    /* The 15b record's own bound: a longer CloudFront read timeout lengthens the hold. */
    const longer = tmp();
    const h2 = harness();
    assert.equal(await stageProbeCommand(hostArgs(longer, hostEvidence({ originRead: 120 })), h2.deps, h2.staging), 0, h2.out.join("\n"));
    assert.equal(readJson(longer, EVIDENCE.edge).sections.ws_idle.required_ms, requiredIdleMs(CADDY_IDLE_SECONDS, 120));
  });

  test("the record is consumable: re-judged later from the saved bytes and the unchanged host evidence, it still PASSES", async () => {
    const dir = tmp();
    const host = hostEvidence();
    const h = harness();
    assert.equal(await stageProbeCommand(hostArgs(dir, host), h.deps, h.staging), 0);
    const evidence = readHostEdgeEvidence(host, { environment: "staging", generation: 1, instanceId: INSTANCE, originHostname: ORIGIN_HOST, baseHost: PLAY, now: NOW });
    const again = judgeSingleHostEdge(readJson(dir, EVIDENCE.edge), evidence, { run: RUN, environment: "staging", generation: 1, pool: "p1", instanceId: INSTANCE, originHostname: ORIGIN_HOST });
    assert.equal(again.passed, true, again.checks.filter((c) => c.status !== "pass").map((c) => c.detail).join("; "));
    /* ...and a host evidence file changed after the probe FAILS it. */
    const v = readJson(host, HOST_EDGE_FILES.verify);
    write(host, HOST_EDGE_FILES.verify, { ...v, at: "2026-10-03T11:51:00.000Z" });
    const changed = readHostEdgeEvidence(host, { environment: "staging", generation: 1, instanceId: INSTANCE, originHostname: ORIGIN_HOST, baseHost: PLAY, now: NOW });
    const after = judgeSingleHostEdge(readJson(dir, EVIDENCE.edge), changed, { run: RUN, environment: "staging", generation: 1, pool: "p1", instanceId: INSTANCE, originHostname: ORIGIN_HOST });
    assert.equal(after.passed, false);
    assert.match(after.checks.filter((c) => c.status === "fail").map((c) => c.name).join("\n"), /the host evidence it stood on is unchanged/);
  });

  test("REFUSES missing host evidence -- and probes nothing", async () => {
    const h = harness();
    const edge = h.staging.edge as ReturnType<typeof fakeEdge>;
    const without = hostArgs(tmp(), "x").filter((a, i, all) => a !== "--host-evidence" && all[i - 1] !== "--host-evidence");
    assert.match(await message(stageProbeCommand(without, h.deps, h.staging)), /--host-evidence is required/);
    assert.match(await message(stageProbeCommand(hostArgs(tmp(), tmp()), h.deps, h.staging)), /edge evidence in .* is not PASS .* no probe runs against an unverified path/);
    for (const missing of [HOST_EDGE_FILES.verify, HOST_EDGE_FILES.report, "manifest.json", "distribution-config.json"]) {
      const msg = await message(stageProbeCommand(hostArgs(tmp(), hostEvidence({ skip: [missing] })), h.deps, h.staging));
      assert.match(msg, /is not PASS/, missing);
    }
    assert.ok(h.out.some((l) => /FAIL {2}single-host edge evidence: the host verification \(verify\.json\) -- verify\.json is missing/.test(l)));
    /* A distribution capture this capture's manifest never wrote (an older capture's file) is unread, never used. */
    const stale = hostEvidence();
    const manifest = readJson(stale, "manifest.json");
    write(stale, "manifest.json", { ...manifest, calls: [] });
    assert.match(await message(stageProbeCommand(hostArgs(tmp(), stale), h.deps, h.staging)), /is not PASS/);
    assert.ok(h.out.some((l) => /not part of this capture/.test(l)));
    assert.equal(edge.calls.length, 0, "no request was sent on unverified evidence");
  });

  test("REFUSES foreign or wrong-origin evidence", async () => {
    const cases: Array<[string, HostEvidenceOptions, RegExp]> = [
      ["the /gs* origin is the ALB (the pre-cutover / ECS path)", { gsOriginDomain: ALB_NAME, reportGsOrigin: ORIGIN_HOST }, /is a load balancer: the ECS path, not the single host's/],
      ["the /gs* origin is another host", { gsOriginDomain: "gs-origin-other.example.org", reportGsOrigin: ORIGIN_HOST }, /reaches gs-origin-other\.example\.org, not the single host's/],
      ["the verified /gs* origin is not this host's", { reportGsOrigin: ALB_NAME }, /the verified \/gs\* origin is .*elb\.amazonaws\.com, not gs-origin-host/],
      ["another instance was verified", { reportInstance: "i-0aaaaaaaaaaaaaaaa" }, /the verified host is i-0aaaaaaaaaaaaaaaa, not i-01fe56536bf591382/],
      ["an ECS-topology verification", { topology: null }, /a host topology is required: an ECS verification is never this evidence/],
      ["a FAIL verification", { verdict: "FAIL" }, /verdict FAIL/],
      ["a PASS label over a failed check", { failedCheck: true }, /verdict PASS, recomputed FAIL/],
      ["a stale verification", { verifiedAt: "2026-10-03T08:00:00.000Z" }, /min old: run step 15b's verification again/],
      ["a verification from the future", { verifiedAt: "2026-10-03T13:00:00.000Z" }, /in the FUTURE/],
      ["a base URL that is not an alias of this distribution", { aliases: ["play.other.example"] }, /play\.example\.org is not an alias of this distribution/],
      ["an origin read timeout outside CloudFront's range", { originRead: 0 }, /OriginReadTimeout is 0: unreadable or outside/],
    ];
    for (const [label, options, expected] of cases) {
      const h = harness();
      const msg = await message(stageProbeCommand(hostArgs(tmp(), hostEvidence(options)), h.deps, h.staging));
      assert.match(msg, /is not PASS .* no probe runs/, label);
      assert.match(h.out.join("\n"), expected, label);
      assert.equal((h.staging.edge as ReturnType<typeof fakeEdge>).calls.length, 0, label);
    }
    /* Probing the host's origin directly (bypassing CloudFront) is refused even if it were listed. */
    const h = harness();
    const direct = hostArgs(tmp(), hostEvidence({ aliases: [PLAY, ORIGIN_HOST] })).map((a) => (a === `https://${PLAY}` ? `https://${ORIGIN_HOST}` : a));
    assert.match(await message(stageProbeCommand(direct, h.deps, h.staging)), /is not PASS/);
    assert.match(h.out.join("\n"), /IS the host's origin: probing it bypasses CloudFront/);
    /* The wrong instance or origin on the command line. */
    const wrong = harness();
    assert.match(await message(stageProbeCommand(hostArgs(tmp(), hostEvidence()).map((a) => (a === INSTANCE ? "i-0bbbbbbbbbbbbbbbb" : a)), wrong.deps, wrong.staging)), /is not PASS/);
    assert.match(await message(stageProbeCommand(hostArgs(tmp(), hostEvidence()).map((a) => (a === INSTANCE ? "not-an-instance" : a)), wrong.deps, wrong.staging)), /--instance-id is the single host's i-\.\.\. id/);
  });

  test("REFUSES an inadequately short hold (on the command line, and in a record that was held too briefly or died early)", async () => {
    const h = harness();
    const required = Math.ceil(REQUIRED_MS / 1000);
    assert.equal(await message(stageProbeCommand(hostArgs(tmp(), hostEvidence(), ["--hold-seconds", "60"]), h.deps, h.staging)), `--hold-seconds must be at least ${required} (the path's longest idle bound plus two server ping periods)`);
    assert.equal(await message(stageProbeCommand(hostArgs(tmp(), hostEvidence(), ["--hold-seconds", String(required - 1)]), h.deps, h.staging)), `--hold-seconds must be at least ${required} (the path's longest idle bound plus two server ping periods)`);
    assert.equal((h.staging.edge as ReturnType<typeof fakeEdge>).calls.length, 0);
    /* A socket the path cut after CloudFront's 60 s (no close frame): FAIL, attributed to CloudFront by timing. */
    const cut = harness(fakeEdge({ idle: () => ({ upgrade_status: null, opened: true, events: [...pingsUntil(60_000), { at_ms: 60_000, kind: "close", code: 1006, clean: false }], ended_by: "remote", duration_ms: 60_000 }) }));
    const dir = tmp();
    assert.equal(await stageProbeCommand(hostArgs(dir, hostEvidence()), cut.deps, cut.staging), 1);
    assert.match(cut.out.join("\n"), /FAIL {2}WebSocket idle: survived client -> CloudFront -> Caddy -> server -- ended after 60000 ms: closed by CloudFront/);
    assert.equal(readJson(dir, SINGLE_HOST_EDGE_VERDICT_FILE).verdict, "FAIL");
    /* A record whose hold was shortened after the fact: FAIL (the interval is recomputed from the evidence). */
    const ok = tmp();
    const host = hostEvidence();
    const h2 = harness();
    assert.equal(await stageProbeCommand(hostArgs(ok, host), h2.deps, h2.staging), 0);
    const record = readJson(ok, EVIDENCE.edge);
    record.sections.ws_idle.hold_ms = 60_000;
    record.sections.ws_idle.required_ms = 60_000;
    record.sections.ws_idle.observation.duration_ms = 60_000;
    const evidence = readHostEdgeEvidence(host, { environment: "staging", generation: 1, instanceId: INSTANCE, originHostname: ORIGIN_HOST, baseHost: PLAY, now: NOW });
    const short = judgeSingleHostEdge(record, evidence, { run: RUN, environment: "staging", generation: 1, pool: "p1", instanceId: INSTANCE, originHostname: ORIGIN_HOST });
    assert.equal(short.passed, false);
    assert.match(short.checks.filter((c) => c.status === "fail").map((c) => c.name).join("\n"), /the interval is the evidence's/);
  });

  test("does NOT substitute the ECS prerequisite or the ALB's attributes for the host's evidence", async () => {
    /* --evidence holds everything the legacy probe needs; --host-evidence holds nothing: refused, nothing probed. */
    const h = harness();
    const dir = ecsEvidence();
    assert.match(await message(stageProbeCommand(hostArgs(dir, tmp()), h.deps, h.staging)), /is not PASS .* no probe runs/);
    assert.equal((h.staging.edge as ReturnType<typeof fakeEdge>).calls.length, 0);
    /* Pointing --host-evidence at the ECS capture itself: refused (no verification, an ALB origin). */
    const h2 = harness();
    assert.match(await message(stageProbeCommand(hostArgs(tmp(), ecsEvidence()), h2.deps, h2.staging)), /is not PASS/);
    assert.match(h2.out.join("\n"), /verify\.json is missing/);
    /* The same directory for both is refused outright. */
    const same = hostEvidence();
    assert.match(await message(stageProbeCommand(hostArgs(same, same), harness().deps, harness().staging)), /not the same directory/);
    /* With BOTH present, the host path's bound is CloudFront + Caddy -- never the ALB attribute (set here to 900 s). */
    const both = ecsEvidence();
    write(both, "load-balancer-attributes.json", { Attributes: [{ Key: "idle_timeout.timeout_seconds", Value: "900" }] });
    const h3 = harness();
    assert.equal(await stageProbeCommand(hostArgs(both, hostEvidence()), h3.deps, h3.staging), 0, h3.out.join("\n"));
    const ws = readJson(both, EVIDENCE.edge).sections.ws_idle;
    assert.deepEqual([ws.required_ms, ws.proxy, ws.alb_idle_seconds], [REQUIRED_MS, "caddy", undefined]);
    /* ...and a record forged as an ECS one (no topology, ALB bound) is never a single-host PASS. */
    const forged = readJson(both, EVIDENCE.edge);
    delete forged.topology;
    forged.sections.ws_idle = { ...forged.sections.ws_idle, proxy: undefined, proxy_idle_seconds: undefined, alb_idle_seconds: 300 };
    const evidence = readHostEdgeEvidence(hostEvidence(), { environment: "staging", generation: 1, instanceId: INSTANCE, originHostname: ORIGIN_HOST, baseHost: PLAY, now: NOW });
    const judged = judgeSingleHostEdge(JSON.parse(stableStringify(forged)), evidence, { run: RUN, environment: "staging", generation: 1, pool: "p1", instanceId: INSTANCE, originHostname: ORIGIN_HOST });
    assert.equal(judged.passed, false);
    const failed = judged.checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`).join("\n");
    assert.match(failed, /the single host's path: the record says topology undefined/);
    assert.match(failed, /the interval is the evidence's: the record is not the single host's path/);
  });

  test("a wrong hop count through the host's path FAILS (Caddy probed directly, or a third proxy)", async () => {
    for (const appended of [1, 3]) {
      const h = harness(fakeEdge({ appended }));
      assert.equal(await stageProbeCommand(hostArgs(tmp(), hostEvidence()), h.deps, h.staging), 1);
      assert.match(h.out.join("\n"), new RegExp(`${appended} appended, not 2`));
    }
  });

  test("the reviewed Caddyfile sets no timeout, so Caddy's documented defaults are the bound this probe holds past", () => {
    const caddy = fs.readFileSync(path.resolve(__dirname, "../../../../../../..", "infra/aws/modules/single-host/templates/Caddyfile.tftpl"), "utf8");
    for (const directive of ["timeouts", "idle_timeout", "read_timeout", "write_timeout", "stream_timeout", "stream_close_delay", "dial_timeout", "response_header_timeout"]) {
      assert.ok(!new RegExp(`\\b${directive}\\b`).test(caddy.replace(/#.*$/gm, "")), `the Caddyfile sets ${directive}: CADDY_IDLE_SECONDS (${CADDY_IDLE_SECONDS}) must be re-derived`);
    }
    assert.equal(CADDY_IDLE_SECONDS, 300);
  });
});
