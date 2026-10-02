// server/src/aws/deploy/hostcert/hostState.ts
//
// ==================================================================
//  COST-2C: WHAT THE HOST SAID -- THE OBSERVATION, PARSED STRICTLY -- AND THE SYSTEMD EXIT-STATUS CONTRACT, JUDGED
// ==================================================================
//
// THE CONTRACT UNDER TEST (COST-1, open until a real AL2023 host shows it): gs-server.service's ExecStopPost
// (/opt/gs/bin/gs-exit-hold) receives the main process's result as EXIT_CODE=exited and EXIT_STATUS=<n>, and writes
// /var/lib/gs/hold exactly when n is 3 (a proven loss) or 5 (a role change); RestartPreventExitStatus=3 5 keeps systemd
// from restarting the process after either. The drill observes it from THREE independent places and requires them to
// agree:
//   1. the drill recorder (an extra ExecStopPost, after gs-exit-hold): what systemd PASSED to ExecStopPost;
//   2. systemd's own journal line for the unit ("Main process exited, code=exited, status=3/...");
//   3. `systemctl show`'s ExecMainCode / ExecMainStatus (when no restart replaced them) and NRestarts;
// and the HOLD file itself. Anything missing, ambiguous (two candidate exits) or unreadable is NOT EVALUATED, never PASS.
// `expectedHold` restates gs-exit-hold's condition (pinned to the script by the offline suite, which runs the script).

import { secretFindings } from "../staging/evidence";
import { exitOf, keyed, textsOf, type HostLine } from "./hostOps";
import { decide, failed, passed, unknown, type CertCheck } from "./verdict";

export interface ExitObservation {
  readonly codeSet: boolean;
  readonly code: string;
  readonly statusSet: boolean;
  readonly status: string;
  readonly serviceResult: string;
  readonly atMs: number;
  readonly boot: string;
}

export interface ContainerLine {
  readonly name: string;
  readonly state: string;
  readonly image: string;
  readonly id: string;
}

export interface BannerTask {
  readonly atSeconds: number;
  readonly pool: string;
  readonly generation: number;
  readonly task: string;
}

export interface HostState {
  readonly bootId: string;
  readonly osId: string;
  readonly osVersionId: string;
  readonly systemdVersion: string;
  readonly systemdMajor: number | null;
  readonly instanceId: string;
  readonly publicIp: string;
  readonly expectedIp: string;
  readonly environment: string;
  readonly releaseDigest: string;
  readonly releaseBuild: string;
  readonly hold: { readonly present: boolean; readonly text: string | null };
  readonly readyz: string;
  readonly nowMs: number | null;
  readonly props: Readonly<Record<string, string>>;
  readonly docker: "ok" | "failed";
  readonly containers: readonly ContainerLine[];
  readonly exits: readonly ExitObservation[];
  readonly dropIns: readonly string[];
  readonly journal: readonly string[];
  readonly banners: readonly BannerTask[];
  /** Lines withheld because they looked secret (never expected: the host prints none; counted, never kept). */
  readonly withheld: number;
}

const REQUIRED_PROPS = ["ActiveState", "SubState", "Result", "ExecMainCode", "ExecMainStatus", "NRestarts", "InvocationID", "UnitFileState"];

const withhold = (texts: readonly string[]): { readonly kept: string[]; readonly withheld: number } => {
  const kept: string[] = [];
  let withheld = 0;
  for (const t of texts) {
    if (secretFindings(t).length > 0) withheld += 1;
    else kept.push(t);
  }
  return { kept, withheld };
};

export function parseExit(text: string): ExitObservation | null {
  const m = /^EXIT_CODE_SET=(yes|) EXIT_CODE=([A-Za-z0-9_?-]*) EXIT_STATUS_SET=(yes|) EXIT_STATUS=([A-Za-z0-9_?-]*) SERVICE_RESULT=([A-Za-z0-9_?-]*) AT_MS=([0-9]{10,16}) BOOT=([0-9a-f-]{0,36})$/.exec(text);
  if (m === null) return null;
  return { codeSet: m[1] === "yes", code: m[2], statusSet: m[3] === "yes", status: m[4], serviceResult: m[5], atMs: Number(m[6]), boot: m[7] };
}

/** The `observe` operation's answer as a state, or why it is not a complete one. */
export function parseObservation(lines: readonly HostLine[]): { readonly ok: true; readonly state: HostState } | { readonly ok: false; readonly problem: string } {
  try {
    const k = (name: string): string => {
      const v = keyed(lines, name);
      if (v === null) throw new Error(`the observation has no ${name}`);
      return v;
    };
    const props: Record<string, string> = {};
    for (const p of textsOf(lines, "P")) {
      const m = /^([A-Za-z]+)=(.*)$/.exec(p);
      if (m === null) throw new Error(`a malformed property line ${JSON.stringify(p.slice(0, 60))}`);
      if (props[m[1]] !== undefined) throw new Error(`the property ${m[1]} is repeated`);
      props[m[1]] = m[2];
    }
    for (const name of REQUIRED_PROPS) if (props[name] === undefined) throw new Error(`systemd's ${name} is missing (systemctl show failed or answered partly)`);
    const docker = k("docker");
    if (docker !== "ok" && docker !== "failed") throw new Error("docker is neither ok nor failed");
    const containers: ContainerLine[] = [];
    for (const c of textsOf(lines, "C")) {
      const parts = c.split("|");
      if (parts.length !== 4 || parts.some((x) => x.length === 0)) throw new Error(`a malformed container line ${JSON.stringify(c.slice(0, 60))}`);
      containers.push({ name: parts[0], state: parts[1], image: parts[2], id: parts[3] });
    }
    const exits: ExitObservation[] = [];
    for (const x of textsOf(lines, "X")) {
      const e = parseExit(x);
      if (e === null) throw new Error(`a malformed recorder line ${JSON.stringify(x.slice(0, 80))}`);
      exits.push(e);
    }
    const banners: BannerTask[] = [];
    for (const t of textsOf(lines, "T")) {
      const m = /^([0-9]{9,12}) pool ([a-z0-9:-]{1,32}), generation ([0-9]{1,6}), task (t-[0-9a-f]{16})$/.exec(t);
      if (m === null) throw new Error(`a malformed banner line ${JSON.stringify(t.slice(0, 80))}`);
      banners.push({ atSeconds: Number(m[1]), pool: m[2], generation: Number(m[3]), task: m[4] });
    }
    const journal = withhold(textsOf(lines, "J"));
    const holdState = k("hold");
    if (holdState !== "present" && holdState !== "absent") throw new Error("hold is neither present nor absent");
    const systemdVersion = k("systemd_version");
    const major = /^systemd ([0-9]{2,4})\b/.exec(systemdVersion);
    const nowRaw = keyed(lines, "now_ms");
    return {
      ok: true,
      state: {
        bootId: k("boot_id"),
        osId: k("os_id"),
        osVersionId: k("os_version_id"),
        systemdVersion,
        systemdMajor: major === null ? null : Number(major[1]),
        instanceId: k("instance_id"),
        publicIp: k("public_ip"),
        expectedIp: k("expected_ip"),
        environment: k("environment"),
        releaseDigest: k("release_digest"),
        releaseBuild: k("release_build"),
        hold: { present: holdState === "present", text: holdState === "present" ? keyed(lines, "hold_text") : null },
        readyz: k("readyz"),
        nowMs: nowRaw !== null && /^[0-9]{10,16}$/.test(nowRaw) ? Number(nowRaw) : null,
        props,
        docker,
        containers,
        exits,
        dropIns: textsOf(lines, "D"),
        journal: journal.kept,
        banners,
        withheld: journal.withheld,
      },
    };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ */
/* Facts derived from one state                                         */
/* ------------------------------------------------------------------ */

export const serverContainers = (s: HostState): ContainerLine[] => s.containers.filter((c) => c.name === "gs-server");
export const runningServer = (s: HostState): ContainerLine | null => s.containers.find((c) => c.name === "gs-server" && c.state === "running") ?? null;
export const rivals = (s: HostState): ContainerLine[] => s.containers.filter((c) => c.name.startsWith("gs-cert-rival-"));
export const ourDropIn = (s: HostState, run: string): boolean => s.dropIns.includes(`90-gs-cert-${run}.conf`);
export const foreignDropIns = (s: HostState, run: string): string[] => s.dropIns.filter((d) => d !== `90-gs-cert-${run}.conf`);
export const nRestarts = (s: HostState): number | null => (/^[0-9]{1,6}$/.test(s.props.NRestarts ?? "") ? Number(s.props.NRestarts) : null);
/** The serving state: systemd active/running, a running gs-server container, /gs/readyz 200. */
export const serving = (s: HostState): boolean => s.props.ActiveState === "active" && s.props.SubState === "running" && runningServer(s) !== null && s.readyz === "200";
/** Down: not active, no running gs-server container, readiness not 200. ("activating" counts as NOT down: a start is in flight.) */
export const down = (s: HostState): boolean => (s.props.ActiveState === "failed" || s.props.ActiveState === "inactive") && runningServer(s) === null && s.readyz !== "200";
/** The newest startup banner's task at or after `sinceSeconds` (the process systemd started last). */
export const latestBanner = (s: HostState, sinceSeconds: number): BannerTask | null => [...s.banners].filter((b) => b.atSeconds >= sinceSeconds).sort((a, b) => a.atSeconds - b.atSeconds).pop() ?? null;

/** gs-exit-hold's own condition (offline suite: pinned by running the script itself). */
export const expectedHold = (code: string, status: string): boolean => code === "exited" && (status === "3" || status === "5");

/** systemd's own words for a main-process exit in the journal: "Main process exited, code=<c>, status=<s>/<name>". */
export function journalExits(s: HostState): Array<{ readonly code: string; readonly status: string }> {
  const out: Array<{ code: string; status: string }> = [];
  for (const line of s.journal) {
    const m = /gs-server\.service: Main process exited, code=([a-z]+), status=([0-9A-Za-z]+)\//.exec(line);
    if (m !== null) out.push({ code: m[1], status: m[2] });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The exit contract                                                    */
/* ------------------------------------------------------------------ */

export type ExitExpectation =
  /** F7: gs-stop -> exit 0 -> no HOLD. */
  | { readonly kind: "graceful" }
  /** F8: an ungraceful kill -> a non-fence exit (137 = SIGKILL through docker, or killed) -> no HOLD -> restarted. */
  | { readonly kind: "crash" }
  /** F9b: a fence -> exit 3 (or the certified role-change 5) -> HOLD -> NOT restarted. */
  | { readonly kind: "fence" };

/**
 * ONE stop's exit, judged: the recorder's NEW observation(s) since `exitsBefore`, systemd's journal line(s), and (for a
 * fence, where nothing replaced them) ExecMainCode / ExecMainStatus. Exactly one new recorder observation is required.
 */
export function judgeExit(label: string, state: HostState, exitsBefore: number, expect: ExitExpectation): { readonly checks: CertCheck[]; readonly observed: ExitObservation | null } {
  const checks: CertCheck[] = [];
  const fresh = state.exits.slice(exitsBefore);
  if (fresh.length === 0) return { checks: [unknown(`${label}: ExecStopPost observed the exit`, "the drill recorder saw no new stop: what systemd passed to ExecStopPost is not observed (NOT EVALUATED)")], observed: null };
  if (fresh.length > 1) return { checks: [unknown(`${label}: ExecStopPost observed ONE exit`, `the recorder saw ${fresh.length} stops where one was caused: ambiguous (NOT EVALUATED)`)], observed: null };
  const e = fresh[0];
  if (!e.codeSet || !e.statusSet) {
    checks.push(failed(`${label}: systemd passes EXIT_CODE / EXIT_STATUS to ExecStopPost`, `ExecStopPost ran without ${!e.codeSet ? "EXIT_CODE" : ""}${!e.codeSet && !e.statusSet ? " and " : ""}${!e.statusSet ? "EXIT_STATUS" : ""}: gs-exit-hold cannot see the main process's result on this host (COST-1's assumption does NOT hold)`));
    return { checks, observed: e };
  }
  checks.push(passed(`${label}: systemd passes EXIT_CODE / EXIT_STATUS to ExecStopPost`, `EXIT_CODE=${e.code} EXIT_STATUS=${e.status} SERVICE_RESULT=${e.serviceResult}`));
  const journal = journalExits(state);
  const last = journal.length === 0 ? null : journal[journal.length - 1];
  if (last === null) checks.push(unknown(`${label}: systemd's journal agrees with ExecStopPost`, "no \"Main process exited\" line for gs-server.service in the journal window"));
  else {
    /* The journal names killed/dumped exits by signal (status=9/KILL) where ExecStopPost gets the name (KILL). */
    const agree = last.code === e.code && (last.status === e.status || (e.code !== "exited" && /^[0-9]+$/.test(last.status)));
    checks.push(decide(`${label}: systemd's journal agrees with ExecStopPost`, agree, `journal code=${last.code} status=${last.status}`, `the journal says code=${last.code} status=${last.status}; ExecStopPost got EXIT_CODE=${e.code} EXIT_STATUS=${e.status}`));
  }
  const holdNow = state.hold.present;
  const holdDue = expectedHold(e.code, e.status);
  if (expect.kind === "graceful") {
    checks.push(decide(`${label}: the process exited 0`, e.code === "exited" && e.status === "0", "EXIT_CODE=exited EXIT_STATUS=0", `EXIT_CODE=${e.code} EXIT_STATUS=${e.status} (not a graceful exit 0)`));
  } else if (expect.kind === "crash") {
    checks.push(decide(`${label}: an ordinary crash (not a fence exit)`, !holdDue && !(e.code === "exited" && e.status === "0"), `EXIT_CODE=${e.code} EXIT_STATUS=${e.status}`, holdDue ? `EXIT_STATUS=${e.status} is a FENCE exit, not the crash this drill caused` : "a clean exit 0 is not the ungraceful kill this drill caused"));
  } else {
    checks.push(decide(`${label}: the fenced process exited 3 (or the certified role-change 5)`, holdDue, `EXIT_CODE=exited EXIT_STATUS=${e.status}`, `EXIT_CODE=${e.code} EXIT_STATUS=${e.status}: not a fencing exit (3) or role change (5)`));
    const code = state.props.ExecMainCode;
    const status = state.props.ExecMainStatus;
    checks.push(decide(`${label}: ExecMainCode / ExecMainStatus are the fenced exit`, code === "1" && status === e.status, `ExecMainCode=1 (exited) ExecMainStatus=${status}`, `ExecMainCode=${String(code)} ExecMainStatus=${String(status)} (systemd's record of the main process does not match ExecStopPost's)`));
  }
  /* The HOLD law (gs-exit-hold): present exactly when the observed exit is 3 or 5. */
  if (holdDue) checks.push(decide(`${label}: gs-exit-hold wrote the HOLD`, holdNow && new RegExp(`^exit ${e.status} at `).test(state.hold.text ?? ""), `HOLD: ${String(state.hold.text)}`, holdNow ? `a HOLD exists but says ${JSON.stringify(state.hold.text)}, not this exit ${e.status}` : `EXIT_STATUS=${e.status} was proven, but /var/lib/gs/hold is ABSENT`));
  else checks.push(decide(`${label}: no HOLD for a non-fence exit`, !holdNow, "no HOLD", `a HOLD exists (${String(state.hold.text)}) after EXIT_CODE=${e.code} EXIT_STATUS=${e.status}`));
  return { checks, observed: e };
}

/** The unit as the host runs it: systemd >= 232 (ExecStopPost gets EXIT_CODE / EXIT_STATUS), Restart=on-failure,
 *  RestartPreventExitStatus 3 and 5, gs-exit-hold as an ExecStopPost, and the reviewed bytes of the unit and scripts. */
export function judgeUnit(label: string, lines: readonly HostLine[], expected: Readonly<Record<string, string>>): CertCheck[] {
  const checks: CertCheck[] = [];
  const version = keyed(lines, "systemd_version");
  const major = version === null ? null : /^systemd ([0-9]{2,4})\b/.exec(version);
  checks.push(major === null ? unknown(`${label}: systemd version`, `unreadable (${String(version)})`) : decide(`${label}: systemd passes EXIT_CODE / EXIT_STATUS to ExecStopPost (>= 232)`, Number(major[1]) >= 232, `systemd ${major[1]}`, `systemd ${major[1]} predates EXIT_CODE / EXIT_STATUS for ExecStopPost (232)`));
  const props: Record<string, string> = {};
  for (const p of textsOf(lines, "P")) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(p);
    if (m !== null) props[m[1]] = m[2];
  }
  if (props.Restart === undefined || props.RestartPreventExitStatus === undefined || props.ExecStopPost === undefined) checks.push(unknown(`${label}: the effective restart policy`, "systemctl show answered partly"));
  else {
    const prevent = props.RestartPreventExitStatus.split(/\s+/).filter((x) => x.length > 0).sort();
    checks.push(decide(`${label}: Restart=on-failure`, props.Restart === "on-failure", "on-failure", `Restart=${props.Restart}`));
    checks.push(decide(`${label}: RestartPreventExitStatus=3 5`, prevent.join(" ") === "3 5", "3 5", `RestartPreventExitStatus=${props.RestartPreventExitStatus}`));
    checks.push(decide(`${label}: gs-exit-hold is an ExecStopPost`, /path=\/opt\/gs\/bin\/gs-exit-hold\b/.test(props.ExecStopPost), "path=/opt/gs/bin/gs-exit-hold", "gs-exit-hold is not among the effective ExecStopPost commands"));
  }
  const hashes = new Map<string, string>();
  for (const s of textsOf(lines, "S")) {
    const m = /^([0-9a-f]{64}|missing) (.+)$/.exec(s);
    if (m !== null) hashes.set(m[2], m[1]);
  }
  for (const [name, sha] of Object.entries(expected)) {
    const got = hashes.get(name);
    checks.push(got === undefined ? unknown(`${label}: ${name} is the reviewed file`, "not reported") : decide(`${label}: ${name} is the reviewed file`, got === sha, `sha256 ${sha.slice(0, 16)}...`, got === "missing" ? `${name} is missing on the host` : `the host's ${name} is ${got.slice(0, 16)}..., the repository's ${sha.slice(0, 16)}...: not the reviewed bytes`));
  }
  return checks;
}

export const opExit = exitOf;
