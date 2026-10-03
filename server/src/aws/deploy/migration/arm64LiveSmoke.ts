// server/src/aws/deploy/migration/arm64LiveSmoke.ts
//
// OWNER-GATE FIX 1: the judge of the REQUIRED live ARM64 runtime smoke -- OFFLINE (it reads the text the operator saved
// from `gs-host arm64-smoke`; it never calls AWS). The owner's SOURCE gate proves the linux/arm64 BUILD and its
// architecture only (a workstation without emulation cannot execute arm64); the EXECUTION proof is this run, on the real
// Graviton single host, after host creation and BEFORE any CloudFront / edge cutover (SINGLE_HOST_MIGRATION.md step 12b).
// `migration-guard edge-cutover` refuses the cutover unless this judge says PASS for the release being served.
//
// PASS needs ALL of: exactly one complete framed run (GS-ARM64-LIVE-SMOKE BEGIN ... END exit=0; a truncated or doubled
// capture is NOT EVALUATED); the expected release digest; host_arch aarch64 on a Graviton (t4g/m7g/c7g/... "g") instance
// type; the pulled image's platform linux/arm64; the unchanged image-smoke.sh's totals for linux/arm64 with at least
// ARM64_SMOKE_MIN_PASSED passed and 0 failed, every `ok` line being linux/arm64, and its two architecture lines (image
// metadata linux/arm64; Node arm64 as uid 1000). A refusal, a failed check, a non-zero exit or a wrong architecture is a
// FAIL; anything missing is NOT EVALUATED -- never PASS, and never inferred from the amd64 smoke.

import { createHash } from "crypto";

import type { Check } from "../deployVerify";

export const ARM64_LIVE_SMOKE_BEGIN = "GS-ARM64-LIVE-SMOKE BEGIN";
export const ARM64_LIVE_SMOKE_END = /^GS-ARM64-LIVE-SMOKE END exit=(\d+)$/;
/** image-smoke.sh's checks: metadata, node, healthz, graceful stop, metric-profile refusal, static-credential refusal, offline AWS start. */
export const ARM64_SMOKE_MIN_PASSED = 7;

export type Arm64SmokeVerdict = "PASS" | "FAIL" | "NOT EVALUATED";

export interface Arm64SmokeJudgement {
  readonly verdict: Arm64SmokeVerdict;
  readonly checks: readonly Check[];
  readonly digest: string | null;
  readonly instanceId: string | null;
  readonly instanceType: string | null;
}

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): Check => ({ name, status: "fail", detail });
const unknown = (name: string, detail: string): Check => ({ name, status: "not-evaluated", detail });

/** sha256 of the repository's image-smoke.sh as the host receives it (LF): the smoke that ran must be the reviewed one. */
export function smokeScriptSha256(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** A saved capture's text: Windows PowerShell 5.1's Tee-Object / Out-File write UTF-16LE with a BOM; decode by BOM. */
export function decodeCapture(raw: Buffer): string {
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString("utf16le");
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    const swapped = Buffer.from(raw.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return raw.subarray(3).toString("utf8");
  return raw.toString("utf8");
}

export function judgeArm64LiveSmoke(text: string, expect: { readonly digest: string; readonly smokeSha256: string | null; readonly instanceId: string }): Arm64SmokeJudgement {
  const L = "ARM64 live smoke";
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const begins = lines.reduce<number[]>((acc, l, i) => (l === ARM64_LIVE_SMOKE_BEGIN ? [...acc, i] : acc), []);
  const ends = lines.reduce<number[]>((acc, l, i) => (ARM64_LIVE_SMOKE_END.test(l) ? [...acc, i] : acc), []);
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
    const why = begins.length === 0 ? "no run found (not a `gs-host arm64-smoke` capture)" : ends.length === 0 ? "the run has no END line (truncated, or the command never finished)" : "more than one run, or an END before its BEGIN";
    return { verdict: "NOT EVALUATED", checks: [unknown(`${L}: one complete framed run`, why)], digest: null, instanceId: null, instanceType: null };
  }
  const body = lines.slice(begins[0] + 1, ends[0]);
  const exit = Number(ARM64_LIVE_SMOKE_END.exec(lines[ends[0]])?.[1]);
  const kv = new Map<string, string>();
  for (const l of body) {
    const m = /^([a-z][a-z0-9_]*)=(.*)$/.exec(l);
    if (m !== null && !kv.has(m[1])) kv.set(m[1], m[2]);
  }
  const checks: Check[] = [pass(`${L}: one complete framed run`, `END exit=${exit}`)];
  const refused = kv.get("refused");
  if (refused !== undefined) checks.push(fail(`${L}: the host ran the smoke`, `refused: ${refused}`));

  const digest = kv.get("digest") ?? null;
  checks.push(digest === null ? unknown(`${L}: the release digest`, "no digest line") : digest === expect.digest ? pass(`${L}: the release digest`, digest) : fail(`${L}: the release digest`, `the smoke ran ${digest}, not the release ${expect.digest}`));

  const ran = kv.get("smoke_script_sha256");
  checks.push(
    expect.smokeSha256 === null
      ? unknown(`${L}: the reviewed image-smoke.sh ran`, "the repository's image-smoke.sh could not be read to compare")
      : ran === undefined
        ? unknown(`${L}: the reviewed image-smoke.sh ran`, "no smoke_script_sha256 line")
        : ran === expect.smokeSha256
          ? pass(`${L}: the reviewed image-smoke.sh ran`, `sha256 ${ran}`)
          : fail(`${L}: the reviewed image-smoke.sh ran`, `the host ran a smoke script with sha256 ${ran}, not the repository's ${expect.smokeSha256}`),
  );

  const arch = kv.get("host_arch");
  checks.push(arch === undefined ? unknown(`${L}: the host is arm64`, "no host_arch line") : arch === "aarch64" ? pass(`${L}: the host is arm64`, "uname -m aarch64") : fail(`${L}: the host is arm64`, `uname -m ${arch}: not a Graviton host (an emulated or x86 run is never this proof)`));

  const iid = kv.get("instance_id");
  checks.push(iid === undefined || iid === "unknown" ? unknown(`${L}: the single host`, "the instance id could not be read (IMDS)") : iid === expect.instanceId ? pass(`${L}: the single host`, iid) : fail(`${L}: the single host`, `the smoke ran on ${iid}, not the single host ${expect.instanceId}`));

  const itype = kv.get("instance_type") ?? null;
  checks.push(itype === null || itype === "unknown" ? unknown(`${L}: a Graviton instance`, "the instance type could not be read (IMDS)") : /^[a-z]+[0-9]+[a-z]*g[a-z]*\.[a-z0-9]+$/.test(itype) ? pass(`${L}: a Graviton instance`, itype) : fail(`${L}: a Graviton instance`, `${itype} is not a Graviton (…g…) type`));

  const platform = kv.get("image_platform");
  if (refused === undefined) checks.push(platform === undefined ? unknown(`${L}: the pulled image is linux/arm64`, "no image_platform line") : platform === "linux/arm64" ? pass(`${L}: the pulled image is linux/arm64`, platform) : fail(`${L}: the pulled image is linux/arm64`, platform));

  if (refused === undefined) {
    const totals = body.map((l) => /^\[(linux\/[a-z0-9]+)\] (\d+) passed, (\d+) failed$/.exec(l)).filter((m): m is RegExpExecArray => m !== null);
    const oks = body.filter((l) => /^ok {3}\[/.test(l));
    const fails = body.filter((l) => /^FAIL \[/.test(l));
    if (totals.length !== 1) checks.push(unknown(`${L}: image-smoke.sh totals`, totals.length === 0 ? "no totals line (the smoke did not finish)" : "more than one totals line"));
    else {
      const [, plat, p, f] = totals[0];
      const passedN = Number(p);
      const failedN = Number(f);
      checks.push(plat === "linux/arm64" ? pass(`${L}: image-smoke.sh ran for linux/arm64`, plat) : fail(`${L}: image-smoke.sh ran for linux/arm64`, `it ran for ${plat}`));
      checks.push(failedN === 0 && fails.length === 0 ? pass(`${L}: no smoke check failed`, "0 failed") : fail(`${L}: no smoke check failed`, `${failedN} failed: ${fails.slice(0, 3).join(" | ")}`));
      checks.push(passedN >= ARM64_SMOKE_MIN_PASSED && passedN === oks.length ? pass(`${L}: every smoke check ran`, `${passedN} passed`) : fail(`${L}: every smoke check ran`, `${passedN} passed (${oks.length} ok lines); at least ${ARM64_SMOKE_MIN_PASSED} required`));
    }
    if (oks.some((l) => !l.startsWith("ok   [linux/arm64]"))) checks.push(fail(`${L}: every check is the arm64 run's`, "an ok line names another platform"));
    checks.push(oks.some((l) => /^ok {3}\[linux\/arm64\] image metadata is linux\/arm64$/.test(l)) ? pass(`${L}: image metadata`, "linux/arm64") : unknown(`${L}: image metadata`, "the smoke's metadata check is absent"));
    checks.push(oks.some((l) => /^ok {3}\[linux\/arm64\] node: arm64 v22\.\S+ uid=1000$/.test(l)) ? pass(`${L}: Node executes as arm64`, "process.arch arm64, uid 1000") : unknown(`${L}: Node executes as arm64`, "the smoke's node check is absent"));
  }
  checks.push(exit === 0 ? pass(`${L}: exit status`, "0") : fail(`${L}: exit status`, `${exit}`));

  const verdict: Arm64SmokeVerdict = checks.some((c) => c.status === "fail") ? "FAIL" : checks.every((c) => c.status === "pass") ? "PASS" : "NOT EVALUATED";
  return { verdict, checks, digest, instanceId: kv.get("instance_id") ?? null, instanceType: itype };
}
