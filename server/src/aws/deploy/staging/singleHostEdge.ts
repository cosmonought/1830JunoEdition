// server/src/aws/deploy/staging/singleHostEdge.ts
//
// ==================================================================
//  PHASE 1 REMAINDER (SINGLE_HOST_MIGRATION.md step 16): THE EDGE PROBE ON THE SINGLE HOST'S PATH
// ==================================================================
//
// `stage-probe edge --topology single-host` -- the SAME probe as L6-6's (`edgeProbe.ts`: ALL query strings, two proxy
// hops, the WebSocket announcement and idle survival, through the distribution's PUBLIC name), run on the path the
// cutover built: client -> CloudFront -> Caddy (the host) -> the server. The ECS path's command (`--topology ecs`, the
// default) is unchanged: it still requires `stage-cert prerequisite` PASS and the ALB's idle timeout, and is judged by
// `stage-cert certify`.
//
// The ECS prerequisite and the ALB attributes describe a topology that no longer serves /gs*, so they are never read
// here -- and never faked. Their place is taken by the single host's OWN evidence, the step-15b capture (COST-2A):
//
//   <host evidence>/verify.json          `awsDeploy verify --topology coexist|single-host ... --record` -- PASS, this
//                                        environment / generation, its "edge: /gs* origin" check PASS (the verifier's
//                                        verdict is recomputed here from its checks, never taken from the field)
//   <host evidence>/host-evidence.json   the same run's `--report`: PASS, the same topology, THIS instance, the /gs*
//                                        origin = `--origin-hostname`, and that name = the one the HOST's own Caddy
//                                        serves (gs-health on the host; the verifier's "host: its origin is
//                                        --origin-hostname" check PASS) -- so a pre-cutover verification offered with
//                                        the ALB's custom origin name as `--origin-hostname` is refused
//   <host evidence>/manifest.json        capture-host-evidence's statement: this environment, this instance
//   <host evidence>/distribution-config.json
//                                        (bound to that manifest) the /gs* behaviour's origin is the host's name -- an ALB
//                                        name or any other origin REFUSES -- and its OriginReadTimeout: CloudFront's idle
//                                        bound on this path; its Aliases: the names the probe may use
//
// THE IDLE BOUND, derived from the actual path: max(CloudFront's origin read timeout (the live distribution's, above),
// Caddy's idle bound, the server's pong timeout) + two ping periods. The reviewed Caddyfile
// (modules/single-host/templates/Caddyfile.tftpl) sets no timeout of any kind, so Caddy runs on its documented defaults:
// no read / write / stream timeout on a proxied upgrade, and a 5-minute server `idle_timeout` (CADDY_IDLE_SECONDS). The
// probe holds the socket past the LONGER of them, so a Caddy default that did reach an upgraded stream would be observed,
// not assumed away (a static test pins the Caddyfile's absence of timeouts; a new timeout there must change this bound).
//
// FAIL CLOSED: every host-evidence check must PASS before any request is sent (no probe against an unverified path); the
// saved record names the host and the SHA-256 of each host-evidence file it relied on; the judgement (written beside it,
// `edge-single-host-verdict.json`) re-reads the files and refuses if any changed. NOTHING HERE MUTATES: GETs and two
// sockets, as before; it writes only the evidence directory.

import * as fs from "fs";
import * as path from "path";

import { VERIFY_RECORD_FORMAT, allPass, arr, checkEnvelope, fail, judge, num, obj, readEvidence, sha256Hex, str, type EvidenceRead } from "./evidence";
import { judgeEdgeTarget, judgeQueryProbe, judgeWsAnnouncement, judgeWsIdleOnPath, requiredIdleMs } from "./edgeProbe";
import { HOST_EVIDENCE_FILES, HOST_EVIDENCE_FORMAT, HOST_REPORT_FORMAT, HOST_TOPOLOGIES, readHostEvidence, verdictOf } from "../hostVerify";
import type { Check } from "../deployVerify";

/** Caddy's documented default server `idle_timeout` (5 minutes). The reviewed Caddyfile overrides no timeout. */
export const CADDY_IDLE_SECONDS = 300;
/** The step-15b verification the probe stands on must be this recent (16 follows 15b in the same session). */
export const HOST_EDGE_EVIDENCE_MAX_AGE_MS = 2 * 60 * 60_000;
const CLOCK_SKEW_MS = 60_000;
/** The verify record and its report are written by ONE `verify` run, moments apart. */
const SAME_RUN_MS = 5 * 60_000;

export const SINGLE_HOST_EDGE_FORMAT = "18COSMOS/PHASE1-SINGLE-HOST-EDGE/v1";
export const SINGLE_HOST_EDGE_VERDICT_FILE = "edge-single-host-verdict.json";
/** The step-15b files this probe stands on (`verify ... --record <dir>/verify.json --report <dir>`). */
export const HOST_EDGE_FILES = Object.freeze({ verify: "verify.json", report: "host-evidence.json" });

/** The /gs* check the host verifier writes (hostVerify.ts `checkHostEdge`). */
const GS_ORIGIN_CHECK = "edge: /gs* origin";
/** The host verifier's check that THIS host's Caddy serves `--origin-hostname` (hostVerify.ts `checkHostRuntime`, from
 *  gs-health on the host itself): the origin name is the host's own, never only what the operator typed. */
const HOST_ORIGIN_CHECK = "host: its origin is --origin-hostname";
/** An Application / Network / Classic load balancer's AWS DNS name: never the single host's origin. */
const LOAD_BALANCER_NAME = /\.elb\.amazonaws\.com\.?$|\.elb\.[a-z0-9-]+\.amazonaws\.com\.?$/i;

export interface HostEdgeExpect {
  readonly environment: string;
  readonly generation: number;
  readonly instanceId: string;
  readonly originHostname: string;
  /** The host the probe will use (`--base-url`'s): an alias of THIS distribution, never the origin itself. */
  readonly baseHost: string;
  readonly now: number;
}

export interface HostEdgeBinding {
  readonly topology: string;
  readonly verify_at: string;
  readonly verify_sha256: string;
  readonly report_sha256: string;
  readonly manifest_sha256: string;
  readonly distribution_config_sha256: string;
}

export interface HostEdgeEvidence {
  readonly checks: readonly Check[];
  readonly ok: boolean;
  /** CloudFront's origin read timeout on the /gs* origin and Caddy's idle bound; null when unread. */
  readonly bounds: { readonly originReadTimeoutSeconds: number; readonly proxyIdleSeconds: number } | null;
  readonly aliases: readonly string[];
  readonly binding: HostEdgeBinding | null;
}

const fileSha = (dir: string, file: string): string | null => {
  try {
    return sha256Hex(fs.readFileSync(path.join(dir, file)));
  } catch {
    return null;
  }
};

const fresh = (label: string, at: string | null, now: number): Check => {
  const ms = at === null ? Number.NaN : Date.parse(at);
  if (!Number.isFinite(ms)) return fail(label, `no time (${String(at)})`);
  const age = now - ms;
  return judge(label, age >= -CLOCK_SKEW_MS && age <= HOST_EDGE_EVIDENCE_MAX_AGE_MS, `${at} (${Math.round(age / 60_000)} min ago)`, age < -CLOCK_SKEW_MS ? `${at} is in the FUTURE (clock or forged evidence)` : `${at} is ${Math.round(age / 60_000)} min old: run step 15b's verification again (at most ${HOST_EDGE_EVIDENCE_MAX_AGE_MS / 60_000} min)`);
};

const problemOf = (r: EvidenceRead): string => (r.ok ? "" : r.problem);

/**
 * The single host's edge evidence, judged BEFORE any probe is sent. Every check must PASS (`ok`); nothing here reads the
 * ECS prerequisite or the ALB's attributes, and nothing here may be satisfied by them.
 */
export function readHostEdgeEvidence(dir: string, expect: HostEdgeExpect): HostEdgeEvidence {
  const checks: Check[] = [];
  const L = "single-host edge evidence";

  /* 1. The step-15b verification record. */
  const verify = readEvidence(dir, HOST_EDGE_FILES.verify, { ownRecord: true });
  let topology: string | null = null;
  let verifyAt: string | null = null;
  if (!verify.ok) checks.push(fail(`${L}: the host verification (${HOST_EDGE_FILES.verify})`, `${problemOf(verify)} (step 15b: \`verify --topology coexist ... --gs-origin <origin_hostname> --record <dir>/${HOST_EDGE_FILES.verify} --report <dir>\`)`));
  else {
    const v = obj(verify.value);
    const vChecks = arr(v.checks).map(obj);
    const recomputed = vChecks.length === 0 ? "FAIL" : verdictOf(vChecks.map((c) => ({ status: String(c.status) })));
    topology = str(v.topology);
    verifyAt = str(v.at);
    checks.push(
      judge(
        `${L}: the host verification (${HOST_EDGE_FILES.verify})`,
        v.format === VERIFY_RECORD_FORMAT && topology !== null && (HOST_TOPOLOGIES as readonly string[]).includes(topology) && v.environment === expect.environment && v.generation === expect.generation && v.verdict === "PASS" && recomputed === "PASS",
        `${VERIFY_RECORD_FORMAT} --topology ${String(topology)}, ${expect.environment} g${expect.generation}: PASS (${vChecks.length} checks)`,
        `${String(v.format)} topology ${String(v.topology)} (a host topology is required: an ECS verification is never this evidence), ${String(v.environment)} g${String(v.generation)}, verdict ${String(v.verdict)}, recomputed ${recomputed}`,
      ),
    );
    for (const name of [GS_ORIGIN_CHECK, HOST_ORIGIN_CHECK]) {
      const c = vChecks.filter((x) => x.name === name);
      checks.push(judge(`${L}: the verifier's "${name}" check`, c.length === 1 && c[0].status === "pass", `PASS: ${String(c[0]?.detail)}`, c.length === 0 ? `the record has no "${name}" check` : `${String(c[0].status)}: ${String(c[0].detail)}`));
    }
    checks.push(fresh(`${L}: the verification is recent`, verifyAt, expect.now));
  }

  /* 2. The same run's report: this host, this origin. */
  const report = readEvidence(dir, HOST_EDGE_FILES.report, { ownRecord: true });
  if (!report.ok) checks.push(fail(`${L}: the host report (${HOST_EDGE_FILES.report})`, `${problemOf(report)} (the same \`verify\` run's \`--report <dir>\`)`));
  else {
    const r = obj(report.value);
    const facts = obj(r.facts);
    const instance = str(obj(facts.ec2).instance_id);
    const gsOrigin = str(obj(facts.cloudfront).gs_origin);
    /* gs-health's own line, from the host: the name Caddy serves and certifies. */
    const served = str(obj(facts.host).origin_hostname);
    const recomputed = verdictOf(arr(r.checks).map((c) => ({ status: String(obj(c).status) })));
    checks.push(
      judge(
        `${L}: the host report (${HOST_EDGE_FILES.report})`,
        r.format === HOST_REPORT_FORMAT && r.topology === topology && r.environment === expect.environment && r.generation === expect.generation && r.verdict === "PASS" && recomputed === "PASS" && arr(r.checks).length > 0,
        `${HOST_REPORT_FORMAT} ${String(r.topology)}: PASS`,
        `${String(r.format)} topology ${String(r.topology)} (the record's is ${String(topology)}), ${String(r.environment)} g${String(r.generation)}, verdict ${String(r.verdict)}, recomputed ${recomputed}`,
      ),
    );
    checks.push(judge(`${L}: the host is this instance`, instance === expect.instanceId, String(instance), `the verified host is ${String(instance)}, not ${expect.instanceId}`));
    checks.push(judge(`${L}: the host serves --origin-hostname`, served === expect.originHostname, `${String(served)} (gs-health on the host: Caddy's name)`, `the host's Caddy serves ${String(served)}, not ${expect.originHostname} (the origin name must be the host's own, never another origin's)`));
    checks.push(judge(`${L}: the verified /gs* origin is this host's`, gsOrigin === expect.originHostname && served === gsOrigin, String(gsOrigin), `the verified /gs* origin is ${String(gsOrigin)}; the host serves ${String(served)}; expected ${expect.originHostname} (before the cutover it is the ALB's: run step 16 only after 15b)`));
    const reportAt = Date.parse(String(r.at));
    const recordAt = verifyAt === null ? Number.NaN : Date.parse(verifyAt);
    checks.push(judge(`${L}: one verification run`, Number.isFinite(reportAt) && Number.isFinite(recordAt) && Math.abs(reportAt - recordAt) <= SAME_RUN_MS, `report ${String(r.at)}, record ${String(verifyAt)}`, `report ${String(r.at)}, record ${String(verifyAt)}: not one \`verify\` run`));
  }

  /* 3. The capture's own statement. */
  const manifest = readHostEvidence(dir, HOST_EVIDENCE_FILES.manifest);
  if (manifest.kind !== "ok") checks.push(fail(`${L}: the capture manifest`, manifest.why));
  else {
    const m = obj(manifest.value);
    checks.push(judge(`${L}: the capture manifest`, m.format === HOST_EVIDENCE_FORMAT && m.environment === expect.environment && m.instance_id === expect.instanceId, `${HOST_EVIDENCE_FORMAT}, ${expect.environment}, ${expect.instanceId}`, `${String(m.format)}, ${String(m.environment)}, instance ${String(m.instance_id)}`));
  }

  /* 4. The live distribution's /gs* origin, its read timeout and its aliases (bound to that capture). */
  const dist = readHostEvidence(dir, HOST_EVIDENCE_FILES.distributionConfig);
  let originRead: number | null = null;
  let aliases: string[] = [];
  if (dist.kind !== "ok") checks.push(fail(`${L}: the distribution's /gs* origin`, dist.why));
  else {
    const config = obj(obj(dist.value).DistributionConfig);
    const gs = arr(obj(config.CacheBehaviors).Items).map(obj).filter((b) => b.PathPattern === "/gs*");
    const origin = gs.length === 1 ? arr(obj(config.Origins).Items).map(obj).find((o) => o.Id === gs[0].TargetOriginId) : undefined;
    const domain = str(origin?.DomainName);
    aliases = arr(obj(config.Aliases).Items).map(String);
    const isLoadBalancer = domain !== null && LOAD_BALANCER_NAME.test(domain);
    checks.push(
      judge(
        `${L}: the distribution's /gs* origin`,
        gs.length === 1 && domain === expect.originHostname && !isLoadBalancer,
        `${String(domain)} (the single host's origin)`,
        gs.length !== 1 ? `${gs.length} /gs* behaviours` : isLoadBalancer ? `${String(domain)} is a load balancer: the ECS path, not the single host's (the ALB is never this probe's origin)` : `/gs* reaches ${String(domain)}, not the single host's ${expect.originHostname}`,
      ),
    );
    const read = num(obj(origin?.CustomOriginConfig).OriginReadTimeout);
    originRead = read !== null && Number.isSafeInteger(read) && read >= 1 && read <= 180 ? read : null;
    checks.push(judge(`${L}: CloudFront's origin read timeout`, originRead !== null, `${String(originRead)} s (the /gs* origin's)`, `the /gs* origin's OriginReadTimeout is ${String(read)}: unreadable or outside 1..180 s`));
    checks.push(
      judge(
        `${L}: the probe uses the distribution's public name`,
        aliases.includes(expect.baseHost) && expect.baseHost !== expect.originHostname,
        `${expect.baseHost} (an alias of the distribution whose /gs* origin is the host)`,
        expect.baseHost === expect.originHostname ? `${expect.baseHost} IS the host's origin: probing it bypasses CloudFront (never this probe)` : `${expect.baseHost} is not an alias of this distribution (${aliases.join(", ") || "none"})`,
      ),
    );
  }

  const ok = allPass(checks);
  const shas = { verify: fileSha(dir, HOST_EDGE_FILES.verify), report: fileSha(dir, HOST_EDGE_FILES.report), manifest: fileSha(dir, HOST_EVIDENCE_FILES.manifest), dist: fileSha(dir, HOST_EVIDENCE_FILES.distributionConfig) };
  const binding: HostEdgeBinding | null =
    ok && topology !== null && verifyAt !== null && shas.verify !== null && shas.report !== null && shas.manifest !== null && shas.dist !== null
      ? { topology, verify_at: verifyAt, verify_sha256: shas.verify, report_sha256: shas.report, manifest_sha256: shas.manifest, distribution_config_sha256: shas.dist }
      : null;
  return { checks, ok: ok && binding !== null, bounds: originRead === null ? null : { originReadTimeoutSeconds: originRead, proxyIdleSeconds: CADDY_IDLE_SECONDS }, aliases, binding };
}

/** The idle interval the single host's path requires (`requiredIdleMs` with Caddy's bound in the ALB's place). */
export const singleHostRequiredIdleMs = (originReadTimeoutSeconds: number): number => requiredIdleMs(CADDY_IDLE_SECONDS, originReadTimeoutSeconds);

export interface SingleHostEdgeVerdict {
  readonly passed: boolean;
  readonly checks: readonly Check[];
  readonly measurements: Record<string, unknown>;
}

/**
 * The judgement of a saved single-host edge record (`probe-edge.json`) against the host evidence AS IT IS NOW (re-read):
 * the evidence still PASSES and is the very files the probe stood on; the record is this run's, this deployment's, made
 * after the verification, on the single host's path; and every L6-6 edge check -- the distribution's own name, ALL query
 * strings, two hops (CloudFront + Caddy), the WebSocket announcement, the idle socket over the recomputed interval --
 * PASSES. PASS only if every check passed.
 */
export function judgeSingleHostEdge(record: unknown, evidence: HostEdgeEvidence, expect: { readonly run: string; readonly environment: string; readonly generation: number; readonly pool: string; readonly instanceId: string; readonly originHostname: string }): SingleHostEdgeVerdict {
  const checks: Check[] = [...evidence.checks];
  const r = obj(record);
  const sections = obj(r.sections);
  /* checkEnvelope's "after the prerequisite" is, on this path, after the host verification (15b) the probe stood on. */
  checks.push(...checkEnvelope("single-host edge probe", r, { probe: "edge", run: expect.run, environment: expect.environment, generation: expect.generation, pool: expect.pool, notBefore: evidence.binding?.verify_at ?? null }).map((c) => ({ ...c, name: c.name.replace(/: after the prerequisite$/, ": after the host verification (15b)") })));
  if (evidence.binding === null) checks.push(fail("single-host edge probe: after the host verification", "the host evidence does not PASS: no verification to stand on"));
  const host = obj(r.host);
  const bound = obj(host.evidence);
  checks.push(judge("single-host edge probe: the single host's path", r.topology === "single-host" && host.instance_id === expect.instanceId && host.origin_hostname === expect.originHostname, `${expect.instanceId} via ${expect.originHostname}`, `the record says topology ${String(r.topology)}, host ${String(host.instance_id)} via ${String(host.origin_hostname)} (an ECS-path record is never this proof)`));
  const b = evidence.binding;
  checks.push(
    judge(
      "single-host edge probe: the host evidence it stood on is unchanged",
      b !== null && bound.verify_sha256 === b.verify_sha256 && bound.report_sha256 === b.report_sha256 && bound.manifest_sha256 === b.manifest_sha256 && bound.distribution_config_sha256 === b.distribution_config_sha256 && bound.topology === b.topology && bound.verify_at === b.verify_at,
      `verify ${b?.verify_sha256.slice(0, 12) ?? "?"}, report ${b?.report_sha256.slice(0, 12) ?? "?"}, distribution ${b?.distribution_config_sha256.slice(0, 12) ?? "?"}`,
      "the record names host evidence other than the files judged now (re-verified or replaced after the probe: probe again)",
    ),
  );
  checks.push(...judgeEdgeTarget(sections, { domainName: null, aliases: evidence.aliases }));
  checks.push(...judgeQueryProbe(sections, { run: expect.run, hopsFromTaskDefinition: null, hopsSource: "single-host" }));
  checks.push(...judgeWsAnnouncement(sections));
  if (evidence.bounds === null) checks.push(fail("WebSocket idle: the bounds", "CloudFront's origin read timeout is not in the host evidence"));
  else checks.push(...judgeWsIdleOnPath(sections, { proxy: "Caddy", proxyIdleSeconds: evidence.bounds.proxyIdleSeconds, originReadTimeoutSeconds: evidence.bounds.originReadTimeoutSeconds }));
  const idle = obj(obj(sections.ws_idle).observation);
  return {
    passed: allPass(checks),
    checks,
    measurements: {
      idle_ms: idle.duration_ms ?? null,
      required_ms: evidence.bounds === null ? null : singleHostRequiredIdleMs(evidence.bounds.originReadTimeoutSeconds),
      pings: arr(idle.events).map(obj).filter((x) => x.kind === "ping").length,
      origin_read_timeout_seconds: evidence.bounds?.originReadTimeoutSeconds ?? null,
      proxy_idle_seconds: evidence.bounds?.proxyIdleSeconds ?? null,
    },
  };
}

/** The verdict record (written beside `probe-edge.json`), stated for the migration procedure. */
export function singleHostEdgeVerdictRecord(expect: { readonly run: string; readonly environment: string; readonly generation: number; readonly pool: string; readonly instanceId: string; readonly originHostname: string }, verdict: SingleHostEdgeVerdict, at: number): Record<string, unknown> {
  return {
    format: SINGLE_HOST_EDGE_FORMAT,
    run_id: expect.run,
    environment: expect.environment,
    generation: expect.generation,
    pool: expect.pool,
    instance_id: expect.instanceId,
    origin_hostname: expect.originHostname,
    at: new Date(at).toISOString(),
    verdict: verdict.passed ? "PASS" : "FAIL",
    measurements: verdict.measurements,
    checks: verdict.checks,
  };
}

