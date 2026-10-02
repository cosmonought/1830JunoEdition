// server/src/aws/deploy/hostcert/hostOps.ts
//
// ==================================================================
//  COST-2C: THE HOST CERTIFICATION'S HOST OPERATIONS -- FIXED BASH TEMPLATES, VALIDATED ARGUMENTS, ONE STRICT FRAMING
// ==================================================================
//
// Every action `awsDeploy host-cert` takes ON the single host is one of the closed set of operations below. Each is a
// FIXED bash template; the only values substituted into it are validated here first (a run id, an image digest, a build
// id, a whole number of seconds) -- nothing an operator types is ever interpreted by a remote shell (the same rule as
// infra/aws/single-host/gs-host.sh). The transport (SSM Run Command, `awsCliTransport.ts`) ships the script base64-encoded
// and runs it with bash as root.
//
// WHAT EACH OPERATION DOES (and what it never does):
//   observe            READ-ONLY. boot id, OS release, systemd version, IMDS instance id / public address, host.env's
//                      expected address and port, release.env's digest / build, the HOLD file, /gs/readyz, the unit's
//                      `systemctl show` properties, every container (name, state, image, id), the drill recorder's exit
//                      observations, the unit's drop-ins, the unit's journal since a time (ONLY systemd's own lines and
//                      the host scripts' `gs: ` lines), and the startup banner's `pool .., generation .., task t-..`
//                      fragment (nothing else of the server's output). Never server.env, never a credential.
//   observe-unit       READ-ONLY. The unit file and gs-exit-hold verbatim (the systemd contract under test) and the
//                      SHA-256 of every host script and the unit (compared with the repository's).
//   recorder-install   DRILL-ONLY, ADDITIVE. A drop-in `90-gs-cert-<run>.conf` appending ONE more ExecStopPost
//                      (`-/bin/bash /var/lib/gs-cert/record-exit <run>`, after gs-exit-hold, its failure ignored) that
//                      records what systemd passed to ExecStopPost (EXIT_CODE / EXIT_STATUS / SERVICE_RESULT, whether
//                      each was set) in /var/lib/gs-cert/<run>/exits. It never writes the HOLD, never changes Restart=,
//                      RestartPreventExitStatus= or gs-exit-hold: the production mechanism is preserved byte for byte.
//                      Refused if any other gs-cert drop-in exists.
//   recorder-remove    removes exactly that drop-in, the recorder and its observations; daemon-reload.
//   stop               /opt/gs/bin/gs-stop, with a /gs/readyz sampler (every 0.2 s; code transitions only).
//   deploy             /opt/gs/bin/gs-deploy <digest> <build> -- the ONLY operation that clears a HOLD (gs-deploy's own
//                      rule: after its pull and drain succeeded).
//   deploy-refused-probe  /opt/gs/bin/gs-deploy sha256:000..0 <build>: a deploy whose pull CANNOT succeed (nothing is
//                      stopped; gs-deploy dies before it clears anything). Refused unless a HOLD exists. Proves a refused
//                      deploy keeps the HOLD.
//   kill-container     `docker kill --signal KILL gs-server` (an ungraceful crash; refused unless it is running).
//   reboot             `systemctl reboot` five seconds after the command answers.
//   preflight-probe    runs /opt/gs/bin/gs-preflight while the server runs (or while on HOLD) and reports its refusal;
//                      its only side effect is gs-preflight's own `docker rm` of an EXITED gs-server container.
//   start-attempt      `systemctl start gs-server.service` -- REFUSED (exit 90, nothing started) unless the HOLD exists:
//                      it exists to prove an ordinary start is refused while on HOLD, and never starts a server otherwise.
//   rival-start        F9b's competing process, exactly as the runbook permits: a second container of the SAME release
//                      image and env (`--env-file /etc/gs/server.env`), the same hardening, named gs-cert-rival-<run>,
//                      publishing NO port, not under systemd. Refused unless gs-server is running and no rival exists.
//   rival-stop         `docker stop --time 120 gs-cert-rival-<run>` (graceful), then proves it is gone.
//
// THE FRAMING. Every operation prints exactly:
//   GSCERT/1 BEGIN <kind> <run>
//   <TAG> <text>            (any number of body lines; text is printable ASCII, at most 300 characters)
//   GSCERT/1 END <kind> <run> <body line count> <SHA-256 of the body>
// SSM truncates a command's output (24,000 characters): a truncated answer has no END line or a different count/digest,
// and the parser REFUSES it -- a partial observation is never read as a complete one.

import { createHash } from "crypto";

import { RUN_ID } from "../staging/evidence";

export const HOST_FRAME = "GSCERT/1";
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const BUILD = /^[A-Za-z0-9._-]{1,128}$/;
/** The digest no image has: `deploy-refused-probe`'s pull fails, so gs-deploy dies before it stops or clears anything. */
export const UNPULLABLE_DIGEST = `sha256:${"0".repeat(64)}`;
export const RIVAL_PREFIX = "gs-cert-rival-";
export const rivalName = (run: string): string => `${RIVAL_PREFIX}${run}`;
export const dropInName = (run: string): string => `90-gs-cert-${run}.conf`;

export type HostOp =
  | { readonly kind: "observe"; readonly run: string; readonly sinceEpochSeconds: number }
  | { readonly kind: "observe-unit"; readonly run: string }
  | { readonly kind: "recorder-install"; readonly run: string }
  | { readonly kind: "recorder-remove"; readonly run: string }
  | { readonly kind: "stop"; readonly run: string }
  | { readonly kind: "deploy"; readonly run: string; readonly digest: string; readonly build: string }
  | { readonly kind: "deploy-refused-probe"; readonly run: string; readonly build: string }
  | { readonly kind: "kill-container"; readonly run: string }
  | { readonly kind: "reboot"; readonly run: string }
  | { readonly kind: "preflight-probe"; readonly run: string }
  | { readonly kind: "start-attempt"; readonly run: string }
  | { readonly kind: "rival-start"; readonly run: string }
  | { readonly kind: "rival-stop"; readonly run: string };

export type HostOpKind = HostOp["kind"];
export const HOST_OP_KINDS: readonly HostOpKind[] = Object.freeze([
  "observe",
  "observe-unit",
  "recorder-install",
  "recorder-remove",
  "stop",
  "deploy",
  "deploy-refused-probe",
  "kill-container",
  "reboot",
  "preflight-probe",
  "start-attempt",
  "rival-start",
  "rival-stop",
]);
/** The operations that change the host (everything but the two observations). */
export const MUTATING_OPS: ReadonlySet<HostOpKind> = new Set(HOST_OP_KINDS.filter((k) => k !== "observe" && k !== "observe-unit"));

/** How long the transport may wait for each operation to be delivered and to finish (seconds). */
export const OP_TIMEOUTS: Readonly<Record<HostOpKind, { readonly delivery: number; readonly execution: number }>> = Object.freeze({
  observe: { delivery: 60, execution: 60 },
  "observe-unit": { delivery: 60, execution: 60 },
  "recorder-install": { delivery: 60, execution: 60 },
  "recorder-remove": { delivery: 120, execution: 60 },
  stop: { delivery: 60, execution: 300 },
  deploy: { delivery: 120, execution: 900 },
  "deploy-refused-probe": { delivery: 60, execution: 300 },
  "kill-container": { delivery: 60, execution: 60 },
  reboot: { delivery: 60, execution: 60 },
  "preflight-probe": { delivery: 120, execution: 120 },
  "start-attempt": { delivery: 60, execution: 240 },
  "rival-start": { delivery: 60, execution: 180 },
  "rival-stop": { delivery: 60, execution: 240 },
});

/** Why an operation's arguments are refused (null: valid). Every substituted value is checked HERE, never on the host. */
export function hostOpProblem(op: HostOp): string | null {
  if (!HOST_OP_KINDS.includes(op.kind)) return `unknown host operation ${JSON.stringify((op as { kind?: unknown }).kind)}`;
  if (typeof op.run !== "string" || !RUN_ID.test(op.run)) return "the run id must match ^[a-z0-9][a-z0-9-]{5,39}$";
  if (op.kind === "observe" && (!Number.isSafeInteger(op.sinceEpochSeconds) || op.sinceEpochSeconds < 1_500_000_000 || op.sinceEpochSeconds > 4_000_000_000)) return "observe needs a whole epoch second";
  if (op.kind === "deploy" && (!DIGEST.test(op.digest) || op.digest === UNPULLABLE_DIGEST)) return "deploy needs the release's image digest sha256:<64 hex>";
  if ((op.kind === "deploy" || op.kind === "deploy-refused-probe") && !BUILD.test(op.build)) return "the build id must match ^[A-Za-z0-9._-]{1,128}$";
  return null;
}

/* ------------------------------------------------------------------ */
/* The templates                                                        */
/* ------------------------------------------------------------------ */

const PRELUDE = String.raw`set -u
umask 077
export LC_ALL=C
GS_ETC="$\{GS_ETC:-/etc/gs}"
GS_STATE_DIR="$\{GS_STATE_DIR:-/var/lib/gs}"
GS_BIN="$\{GS_BIN:-/opt/gs/bin}"
GS_CERT_DIR="$\{GS_CERT_DIR:-/var/lib/gs-cert}"
GS_DROPIN_DIR="$\{GS_DROPIN_DIR:-/etc/systemd/system/gs-server.service.d}"
GS_UNIT_FILE="$\{GS_UNIT_FILE:-/etc/systemd/system/gs-server.service}"
GS_IMDS="$\{GS_IMDS:-http://169.254.169.254}"
GS_BODY="$(mktemp)" || exit 97
trap 'rm -f "$GS_BODY"' EXIT
emit() { local tag="$1"; shift; local text; text="$(printf '%s' "$*" | tr -d '\r\n' | tr -c '\040-\176' '?' | cut -c1-300)"; printf '%s %s\n' "$tag" "$text" >>"$GS_BODY"; }
emit_lines() { local tag="$1" line; while IFS= read -r line || [ -n "$line" ]; do emit "$tag" "$line"; done; }
envval() { grep -E "^$2=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2-; }
finish() {
  printf '%s BEGIN %s %s\n' "GSCERT/1" "$KIND" "$RUN"
  cat "$GS_BODY"
  printf '%s END %s %s %s %s\n' "GSCERT/1" "$KIND" "$RUN" "$(wc -l <"$GS_BODY" | tr -d ' ')" "$(sha256sum "$GS_BODY" | cut -d' ' -f1)"
  exit "$\{1:-0}"
}
port() { local p; p="$(envval "$GS_ETC/host.env" GS_CONTAINER_PORT)"; case "$p" in ''|*[!0-9]*) p=8917 ;; esac; printf '%s' "$p"; }
readyz() { local code; code="$(curl -s -o /dev/null -m "$\{1:-5}" -w '%{http_code}' "http://127.0.0.1:$(port)/gs/readyz" 2>/dev/null)"; [ -n "$code" ] || code=000; printf '%s' "$code"; }
server_state() { docker container inspect -f '{{.State.Status}}' gs-server 2>/dev/null || printf 'absent'; }
`.replace(/\$\\\{/g, "${");

/** The read-only snapshot (see the header). `since` bounds the journal; RUN names the recorder's observation file. */
const OBSERVE = String.raw`emit K boot_id "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf unknown)"
emit K os_id "$( (. /etc/os-release 2>/dev/null; printf '%s' "$\{ID:-unknown}") )"
emit K os_version_id "$( (. /etc/os-release 2>/dev/null; printf '%s' "$\{VERSION_ID:-unknown}") )"
emit K systemd_version "$(systemctl --version 2>/dev/null | head -n 1)"
token="$(curl -fsS -m 3 -X PUT "$GS_IMDS/latest/api/token" -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
if [ -n "$token" ]; then
  emit K instance_id "$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $token" "$GS_IMDS/latest/meta-data/instance-id" 2>/dev/null || printf unknown)"
  emit K public_ip "$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $token" "$GS_IMDS/latest/meta-data/public-ipv4" 2>/dev/null || printf unknown)"
else
  emit K instance_id unknown
  emit K public_ip unknown
fi
unset token
emit K expected_ip "$(envval "$GS_ETC/host.env" GS_EXPECTED_PUBLIC_IP)"
emit K environment "$(envval "$GS_ETC/host.env" GS_ENVIRONMENT)"
emit K release_digest "$(envval "$GS_ETC/release.env" GS_IMAGE_DIGEST)"
emit K release_build "$(envval "$GS_ETC/release.env" BUILD_ID)"
if [ -e "$GS_STATE_DIR/hold" ]; then emit K hold present; emit K hold_text "$(head -c 200 "$GS_STATE_DIR/hold" 2>/dev/null)"; else emit K hold absent; fi
emit K readyz "$(readyz 5)"
emit K now_ms "$(date +%s%3N)"
systemctl show --timestamp=unix gs-server.service -p ActiveState -p SubState -p Result -p ExecMainCode -p ExecMainStatus -p ExecMainPID -p NRestarts -p UnitFileState -p InvocationID -p ExecMainStartTimestamp -p ExecMainExitTimestamp 2>/dev/null | emit_lines P
if containers="$(docker ps -a --no-trunc --format '{{.Names}}|{{.State}}|{{.Image}}|{{.ID}}' 2>/dev/null)"; then
  emit K docker ok
  printf '%s\n' "$containers" | grep -v '^$' | emit_lines C
else
  emit K docker failed
fi
if [ -r "$GS_CERT_DIR/$RUN/exits" ]; then tail -n 20 "$GS_CERT_DIR/$RUN/exits" | emit_lines X; fi
if [ -d "$GS_DROPIN_DIR" ]; then ls -1 "$GS_DROPIN_DIR" 2>/dev/null | emit_lines D; fi
journalctl -u gs-server.service --since "@$SINCE" -o short-unix --no-pager 2>/dev/null >"$GS_BODY.j" || true
grep -E '^[0-9]+\.[0-9]+ [^ ]+ (systemd\[1\]: |[A-Za-z0-9_.-]+\[[0-9]+\]: gs: )' "$GS_BODY.j" | tail -n 40 | emit_lines J
started="$(systemctl show --timestamp=unix -p ExecMainStartTimestamp --value gs-server.service 2>/dev/null | tr -cd '0-9')"
bsince="$SINCE"; case "$started" in ''|0) ;; *) [ "$((started - 5))" -lt "$bsince" ] && bsince="$((started - 5))" ;; esac
journalctl -u gs-server.service --since "@$bsince" -o short-unix --no-pager 2>/dev/null | sed -nE 's/^([0-9]+)\.[0-9]+ .*(pool [a-z0-9:-]{1,32}, generation [0-9]{1,6}, task t-[0-9a-f]{16}).*$/\1 \2/p' | tail -n 10 | emit_lines T
rm -f "$GS_BODY.j"
finish 0
`.replace(/\$\\\{/g, "${");

const HOST_SCRIPTS = ["gs-lib.sh", "gs-preflight", "gs-run", "gs-exit-hold", "gs-deploy", "gs-rollback", "gs-stop", "gs-health"] as const;

const OBSERVE_UNIT = String.raw`emit K systemd_version "$(systemctl --version 2>/dev/null | head -n 1)"
emit K os_id "$( (. /etc/os-release 2>/dev/null; printf '%s' "$\{ID:-unknown}") )"
emit K os_version_id "$( (. /etc/os-release 2>/dev/null; printf '%s' "$\{VERSION_ID:-unknown}") )"
if [ -r "$GS_UNIT_FILE" ]; then emit S "$(sha256sum "$GS_UNIT_FILE" | cut -d' ' -f1) gs-server.service"; emit_lines U <"$GS_UNIT_FILE"; else emit S "missing gs-server.service"; fi
for s in ${HOST_SCRIPTS.join(" ")}; do
  if [ -r "$GS_BIN/$s" ]; then emit S "$(sha256sum "$GS_BIN/$s" | cut -d' ' -f1) $s"; else emit S "missing $s"; fi
done
if [ -r "$GS_BIN/gs-exit-hold" ]; then emit_lines H <"$GS_BIN/gs-exit-hold"; fi
if [ -d "$GS_DROPIN_DIR" ]; then ls -1 "$GS_DROPIN_DIR" 2>/dev/null | emit_lines D; fi
systemctl show gs-server.service -p Restart -p RestartPreventExitStatus -p ExecStopPost -p DropInPaths 2>/dev/null | emit_lines P
finish 0
`.replace(/\$\\\{/g, "${");

/** The drill-only recorder: ONE extra ExecStopPost after gs-exit-hold. It records, never decides. */
const RECORDER_SCRIPT = String.raw`#!/bin/bash
# COST-2C drill recorder (gs-server.service.d/90-gs-cert-<run>.conf). Records what systemd passed to ExecStopPost; it
# never writes the HOLD and never changes the service. Removed by the drill's cleanup.
umask 077
run="$\{1:-}"
case "$run" in ''|*[!a-z0-9-]*) exit 0 ;; esac
dir="$\{GS_CERT_DIR:-/var/lib/gs-cert}/$run"
mkdir -p "$dir" || exit 0
clean() { printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '?' | cut -c1-32; }
printf 'EXIT_CODE_SET=%s EXIT_CODE=%s EXIT_STATUS_SET=%s EXIT_STATUS=%s SERVICE_RESULT=%s AT_MS=%s BOOT=%s\n' \
  "$\{EXIT_CODE+yes}" "$(clean "$\{EXIT_CODE-}")" "$\{EXIT_STATUS+yes}" "$(clean "$\{EXIT_STATUS-}")" "$(clean "$\{SERVICE_RESULT-}")" \
  "$(date +%s%3N)" "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null | tr -cd '0-9a-f-' | cut -c1-36)" >>"$dir/exits"
exit 0
`.replace(/\$\\\{/g, "${");

const RECORDER_INSTALL = String.raw`for f in "$GS_DROPIN_DIR"/90-gs-cert-*.conf; do
  [ -e "$f" ] || continue
  [ "$(basename "$f")" = "90-gs-cert-$RUN.conf" ] && continue
  emit E 91; emit R "another drill's recorder is installed: $(basename "$f") (run its cleanup first)"; finish 91
done
mkdir -p "$GS_DROPIN_DIR" "$GS_CERT_DIR/$RUN" || { emit E 92; finish 92; }
chmod 0700 "$GS_CERT_DIR"
printf '%s' "$RECORDER_B64" | base64 -d >"$GS_CERT_DIR/record-exit.tmp" && mv -f "$GS_CERT_DIR/record-exit.tmp" "$GS_CERT_DIR/record-exit" || { emit E 93; finish 93; }
printf '[Service]\nExecStopPost=-/bin/bash %s/record-exit %s\n' "$GS_CERT_DIR" "$RUN" >"$GS_DROPIN_DIR/90-gs-cert-$RUN.conf.tmp" && chmod 0644 "$GS_DROPIN_DIR/90-gs-cert-$RUN.conf.tmp" && mv -f "$GS_DROPIN_DIR/90-gs-cert-$RUN.conf.tmp" "$GS_DROPIN_DIR/90-gs-cert-$RUN.conf" || { emit E 94; finish 94; }
systemctl daemon-reload || { emit E 95; finish 95; }
emit E 0
emit I "$(systemctl show gs-server.service -p DropInPaths 2>/dev/null)"
finish 0
`;

const RECORDER_REMOVE = String.raw`rc=0
rm -f "$GS_DROPIN_DIR/90-gs-cert-$RUN.conf" || rc=1
rmdir "$GS_DROPIN_DIR" 2>/dev/null || true
systemctl daemon-reload || rc=1
rm -rf "$GS_CERT_DIR/$RUN" || rc=1
ls "$GS_DROPIN_DIR"/90-gs-cert-*.conf >/dev/null 2>&1 || rm -f "$GS_CERT_DIR/record-exit"
[ -e "$GS_DROPIN_DIR/90-gs-cert-$RUN.conf" ] && rc=1
emit E "$rc"
finish "$rc"
`;

/** gs-stop with a readiness sampler: (ms, code) on every CHANGE of /gs/readyz's answer, every 0.2 s. */
const STOP = String.raw`samples="$(mktemp)"
( prev=""; while :; do c="$(readyz 1)"; if [ "$c" != "$prev" ]; then printf '%s %s\n' "$(date +%s%3N)" "$c"; prev="$c"; fi; sleep 0.2; done ) >"$samples" 2>/dev/null &
sampler=$!
sleep 0.5
out="$(mktemp)"
"$GS_BIN/gs-stop" >"$out" 2>&1
rc=$?
sleep 1
kill "$sampler" 2>/dev/null; wait "$sampler" 2>/dev/null
emit E "$rc"
emit_lines O <"$out"
tail -n 100 "$samples" | emit_lines S
emit K stopped_at_ms "$(date +%s%3N)"
rm -f "$samples" "$out"
finish 0
`;

const RUN_SCRIPT = (command: string): string => String.raw`out="$(mktemp)"
${command} >"$out" 2>&1
rc=$?
emit E "$rc"
tail -n 60 "$out" | emit_lines O
rm -f "$out"
finish 0
`;

const DEPLOY_REFUSED_PROBE = (build: string): string => String.raw`if [ ! -e "$GS_STATE_DIR/hold" ]; then emit E 90; emit R "refused: there is no HOLD (this probe exists only to prove a refused deploy keeps one)"; finish 90; fi
${RUN_SCRIPT(`"$GS_BIN/gs-deploy" ${UNPULLABLE_DIGEST} ${build}`)}`;

const KILL_CONTAINER = String.raw`state="$(server_state)"
if [ "$state" != running ]; then emit E 90; emit R "refused: gs-server is $state, not running"; finish 90; fi
docker kill --signal KILL gs-server >/dev/null 2>&1
rc=$?
emit E "$rc"
emit K killed_at_ms "$(date +%s%3N)"
finish 0
`;

const REBOOT = String.raw`emit K boot_id "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf unknown)"
nohup bash -c 'sleep 5; systemctl reboot' >/dev/null 2>&1 &
emit E 0
emit K reboot_requested_at_ms "$(date +%s%3N)"
finish 0
`;

const START_ATTEMPT = String.raw`if [ ! -e "$GS_STATE_DIR/hold" ]; then emit E 90; emit R "refused: there is no HOLD (an ordinary start is only attempted to prove the HOLD refuses it)"; finish 90; fi
out="$(mktemp)"
timeout 200 systemctl start gs-server.service >"$out" 2>&1
rc=$?
sleep 3
emit E "$rc"
tail -n 20 "$out" | emit_lines O
emit K active_state "$(systemctl is-active gs-server.service 2>/dev/null)"
emit K server_container "$(server_state)"
rm -f "$out"
finish 0
`;

const RIVAL_START = String.raw`if [ "$(server_state)" != running ]; then emit E 90; emit R "refused: gs-server is not running (the rival must compete with a serving process)"; finish 90; fi
if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^gs-cert-rival-'; then emit E 91; emit R "refused: a rival container already exists"; finish 91; fi
digest="$(envval "$GS_ETC/release.env" GS_IMAGE_DIGEST)"
build="$(envval "$GS_ETC/release.env" BUILD_ID)"
registry="$(envval "$GS_ETC/host.env" GS_ECR_REGISTRY)"
repository="$(envval "$GS_ETC/host.env" GS_ECR_REPOSITORY)"
memory="$(envval "$GS_ETC/host.env" GS_SERVER_MEMORY)"
region="$(envval "$GS_ETC/host.env" GS_REGION)"
group="$(envval "$GS_ETC/host.env" GS_LOG_GROUP)"
case "$digest" in sha256:*) ;; *) emit E 92; emit R "release.env has no digest"; finish 92 ;; esac
out="$(mktemp)"
docker run -d --name "gs-cert-rival-$RUN" --rm --init \
  --read-only --user node --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory "$memory" \
  --env-file "$GS_ETC/server.env" -e "BUILD_ID=$build" --stop-timeout 120 \
  --log-driver awslogs --log-opt "awslogs-region=$region" --log-opt "awslogs-group=$group" --log-opt "awslogs-stream=gs-cert-rival/$RUN" \
  --log-opt mode=non-blocking --log-opt max-buffer-size=4m \
  "$registry/$repository@$digest" >"$out" 2>&1
rc=$?
emit E "$rc"
emit K rival_started_at_ms "$(date +%s%3N)"
tail -n 5 "$out" | emit_lines O
rm -f "$out"
finish 0
`;

const RIVAL_STOP = String.raw`if docker container inspect "gs-cert-rival-$RUN" >/dev/null 2>&1; then docker stop --time 120 "gs-cert-rival-$RUN" >/dev/null 2>&1; fi
for i in 1 2 3 4 5 6 7 8 9 10; do docker container inspect "gs-cert-rival-$RUN" >/dev/null 2>&1 || break; sleep 2; done
if docker container inspect "gs-cert-rival-$RUN" >/dev/null 2>&1; then docker rm -f "gs-cert-rival-$RUN" >/dev/null 2>&1; sleep 2; fi
if docker container inspect "gs-cert-rival-$RUN" >/dev/null 2>&1; then emit E 1; emit R "the rival container is still present"; finish 1; fi
emit E 0
finish 0
`;

/** The bash body of `op` (the prelude, the operation's own variables -- validated -- and its template). */
export function hostScript(op: HostOp): string {
  const problem = hostOpProblem(op);
  if (problem !== null) throw new Error(`host-cert: refusing to build ${String((op as { kind?: unknown }).kind)}: ${problem}`);
  const head = `#!/bin/bash\n# COST-2C host-cert ${op.kind} (fixed template; arguments validated by the operator tool)\nKIND='${op.kind}'\nRUN='${op.run}'\n${PRELUDE}`;
  switch (op.kind) {
    case "observe":
      return `${head}SINCE='${op.sinceEpochSeconds}'\n${OBSERVE}`;
    case "observe-unit":
      return `${head}${OBSERVE_UNIT}`;
    case "recorder-install":
      return `${head}RECORDER_B64='${Buffer.from(RECORDER_SCRIPT, "utf8").toString("base64")}'\n${RECORDER_INSTALL}`;
    case "recorder-remove":
      return `${head}${RECORDER_REMOVE}`;
    case "stop":
      return `${head}${STOP}`;
    case "deploy":
      return `${head}${RUN_SCRIPT(`"$GS_BIN/gs-deploy" ${op.digest} ${op.build}`)}`;
    case "deploy-refused-probe":
      return `${head}${DEPLOY_REFUSED_PROBE(op.build)}`;
    case "kill-container":
      return `${head}${KILL_CONTAINER}`;
    case "reboot":
      return `${head}${REBOOT}`;
    case "preflight-probe":
      return `${head}${RUN_SCRIPT(`"$GS_BIN/gs-preflight"`)}`;
    case "start-attempt":
      return `${head}${START_ATTEMPT}`;
    case "rival-start":
      return `${head}${RIVAL_START}`;
    case "rival-stop":
      return `${head}${RIVAL_STOP}`;
  }
}

/** The recorder's own text (tests run it against stub environments). */
export const recorderScript = (): string => RECORDER_SCRIPT;
export const HOST_SCRIPT_NAMES: readonly string[] = HOST_SCRIPTS;

/* ------------------------------------------------------------------ */
/* The framing's parser                                                 */
/* ------------------------------------------------------------------ */

export interface HostLine {
  readonly tag: string;
  readonly text: string;
}

export type HostOutput = { readonly ok: true; readonly lines: readonly HostLine[] } | { readonly ok: false; readonly problem: string };

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** One operation's framed answer, or why it is not a complete one (a truncated, foreign or altered answer is REFUSED). */
export function parseHostOutput(stdout: string, op: { readonly kind: HostOpKind; readonly run: string }): HostOutput {
  const all = stdout.replace(/\r\n/g, "\n").split("\n");
  const begin = `${HOST_FRAME} BEGIN ${op.kind} ${op.run}`;
  const starts = all.reduce<number[]>((acc, line, i) => (line === begin ? [...acc, i] : acc), []);
  if (starts.length !== 1) return { ok: false, problem: starts.length === 0 ? `no "${begin}" line (the answer is not this operation's)` : "two answers in one output" };
  const ends = all.map((line, i) => ({ line, i })).filter(({ line }) => line.startsWith(`${HOST_FRAME} END `));
  if (ends.length !== 1) return { ok: false, problem: ends.length === 0 ? "no END line: the answer was truncated (SSM keeps 24,000 characters) or the script died" : "two END lines" };
  const end = ends[0];
  if (end.i <= starts[0]) return { ok: false, problem: "END before BEGIN" };
  const m = new RegExp(`^${HOST_FRAME} END ${op.kind} ${op.run} ([0-9]{1,6}) ([0-9a-f]{64})$`).exec(end.line);
  if (m === null) return { ok: false, problem: "a malformed END line (another operation's, or altered)" };
  const body = all.slice(starts[0] + 1, end.i);
  if (body.length !== Number(m[1])) return { ok: false, problem: `the END line counts ${m[1]} lines, ${body.length} arrived (truncated or altered)` };
  const bodyText = body.length === 0 ? "" : `${body.join("\n")}\n`;
  if (sha256(bodyText) !== m[2]) return { ok: false, problem: "the body's SHA-256 is not the END line's (altered in transit)" };
  const lines: HostLine[] = [];
  for (const line of body) {
    const parsed = /^([A-Z]) (.*)$/.exec(line);
    if (parsed === null || parsed[2].length > 300 || /[^\x20-\x7e]/.test(parsed[2])) return { ok: false, problem: `a malformed body line ${JSON.stringify(line.slice(0, 80))}` };
    lines.push({ tag: parsed[1], text: parsed[2] });
  }
  return { ok: true, lines };
}

/** The one value of tag `tag` and key `key` (`K key value`), or null when absent; a repeated key is ambiguous (throws). */
export function keyed(lines: readonly HostLine[], key: string): string | null {
  const found = lines.filter((l) => l.tag === "K" && (l.text === key || l.text.startsWith(`${key} `))).map((l) => (l.text === key ? "" : l.text.slice(key.length + 1)));
  if (found.length > 1) throw new Error(`the observation repeats ${key}`);
  return found.length === 0 ? null : found[0];
}

/** `E <code>`: the operation's own result code (one, a whole number), or null. */
export function exitOf(lines: readonly HostLine[]): number | null {
  const codes = lines.filter((l) => l.tag === "E");
  if (codes.length !== 1 || !/^[0-9]{1,3}$/.test(codes[0].text)) return null;
  return Number(codes[0].text);
}

export const textsOf = (lines: readonly HostLine[], tag: string): string[] => lines.filter((l) => l.tag === tag).map((l) => l.text);
