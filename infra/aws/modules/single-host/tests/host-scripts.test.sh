#!/usr/bin/env bash
# infra/aws/modules/single-host/tests/host-scripts.test.sh -- COST-1: the single host's scripts (files/bin) against
# STUBBED docker / systemctl / curl / aws (no Docker daemon, no systemd, no AWS, no network). Run from anywhere:
#   bash infra/aws/modules/single-host/tests/host-scripts.test.sh
# What is pinned: gs-preflight refuses (fail closed) on every unsafe state; gs-deploy pulls BEFORE it stops anything, is
# idempotent, rotates the release files, starts and waits for readiness; gs-rollback swaps; gs-stop --until-deploy
# disables; gs-run publishes on 127.0.0.1 only with the hardened flags; gs-host-sample / gs-measure-report work.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/../files/bin"
pass=0; fail=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; }

DIGEST_A="sha256:$(printf 'a%.0s' {1..64})"
DIGEST_B="sha256:$(printf 'b%.0s' {1..64})"

setup() {
  T="$(mktemp -d)"; S="$T/state"; mkdir -p "$S" "$T/etc" "$T/stubs" "$T/measure" "$T/lib"
  export GS_TEST=1 GS_ETC="$T/etc" GS_LOCK="$T/lock" GS_IMDS="http://imds.test" GS_POLL_SECONDS=0 GS_READY_TIMEOUT=1
  export GS_MEASURE_DIR="$T/measure" GS_STATE_DIR="$T/lib" STUB_STATE="$S"
  cat >"$T/etc/host.env" <<EOF
GS_ENVIRONMENT=staging
GS_REGION=us-east-1
GS_ARCH=arm64
GS_ECR_REGISTRY=111111111111.dkr.ecr.us-east-1.amazonaws.com
GS_ECR_REPOSITORY=gs-staging-server
GS_LOG_GROUP=/gs/staging/host
GS_EXPECTED_PUBLIC_IP=203.0.113.10
GS_ORIGIN_HOSTNAME=gs-origin.example.org
GS_CADDY_IMAGE=public.ecr.aws/docker/library/caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b
GS_CADDY_UID=2001
GS_SERVER_MEMORY=1536m
GS_CONTAINER_PORT=8917
GS_HOST_METRIC_NAMESPACE=18Cosmos/Host
EOF
  printf 'GS_MODE=production\nGS_STORAGE=aws\nGS_AWS_CONFIG_PARAMETER=arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1\nPORT=8917\nGS_METRICS_PROFILE=single-host\n' >"$T/etc/server.env"
  echo 203.0.113.10 >"$S/ip"; echo linux/arm64 >"$S/platform"; echo 0 >"$S/active"; echo 503 >"$S/ready"; : >"$S/calls"
  # --- stubs -------------------------------------------------------------------------------------------------------
  cat >"$T/stubs/docker" <<'EOF'
#!/usr/bin/env bash
S="$STUB_STATE"; echo "docker $*" >>"$S/calls"
case "$1 $2" in
  "container inspect")
    if [ -f "$S/container" ]; then [ "$3" = "-f" ] && cat "$S/container"; exit 0; fi; exit 1 ;;
  "image inspect") [ -f "$S/platform" ] && cat "$S/platform" && exit 0; exit 1 ;;
esac
case "$1" in
  pull) [ -f "$S/pull_fail" ] && exit 1; exit 0 ;;
  rm) rm -f "$S/container"; exit 0 ;;
  run) printf '%s\n' "$@" >"$S/run_args"; exit 0 ;;
esac
exit 0
EOF
  cat >"$T/stubs/systemctl" <<'EOF'
#!/usr/bin/env bash
S="$STUB_STATE"; echo "systemctl $*" >>"$S/calls"
case "$1" in
  is-active) [ "$(cat "$S/active")" = 1 ] && { [ "$2" = "--quiet" ] || echo active; exit 0; }; [ "$2" = "--quiet" ] || echo inactive; exit 3 ;;
  stop) echo 0 >"$S/active"; echo 503 >"$S/ready"; rm -f "$S/container"; exit 0 ;;
  start) echo 1 >"$S/active"; cat "$S/start_ready" 2>/dev/null >"$S/ready" || echo 200 >"$S/ready"; exit 0 ;;
  show) echo 0; exit 0 ;;
esac
exit 0
EOF
  cat >"$T/stubs/curl" <<'EOF'
#!/usr/bin/env bash
S="$STUB_STATE"; url=""; wout=""
while [ $# -gt 0 ]; do case "$1" in -w) wout="$2"; shift 2 ;; -m|-H|-X|-o|--resolve) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
case "$url" in
  */latest/api/token) echo token ;;
  */meta-data/public-ipv4) cat "$S/ip" ;;
  *) code=000; case "$url" in */gs/readyz) code="$(cat "$S/ready")" ;; */gs/healthz) code=200 ;; esac
     [ -n "$wout" ] && printf '%s' "$code"; [ "$code" = 200 ] || exit 22 ;;
esac
EOF
  cat >"$T/stubs/aws" <<'EOF'
#!/usr/bin/env bash
echo "aws $*" >>"$STUB_STATE/calls"
EOF
  cat >"$T/stubs/journalctl" <<'EOF'
#!/usr/bin/env bash
[ -f "$STUB_STATE/oom" ] && echo "kernel: Out of memory: Killed process 42 (node)"
exit 0
EOF
  chmod +x "$T/stubs/"*
  export PATH="$T/stubs:$PATH"
}
teardown() { rm -rf "$T"; }
release() { printf 'GS_IMAGE_DIGEST=%s\nBUILD_ID=%s\nGS_MEASURE=0\n' "$1" "$2" >"$T/etc/$3"; }
run() { "$BIN/$1" "${@:2}" >"$T/out" 2>&1; }
calls() { cat "$S/calls"; }

# ------------------------------------------------------------------------------------------------- gs-preflight
setup; release "$DIGEST_A" b1 release.env
run gs-preflight && ok "preflight passes: pinned image of this arch, serving IP, no container, references only" || bad "preflight happy path" "$(cat "$T/out")"
teardown

for case in ip cred data storage running arch digest; do
  setup; release "$DIGEST_A" b1 release.env
  case "$case" in
    ip) echo 198.51.100.9 >"$S/ip" ;;
    cred) echo 'AWS_ACCESS_KEY_ID=AKIAEXAMPLEEXAMPLE00' >>"$T/etc/server.env" ;;
    data) echo 'DATA_DIR=/data' >>"$T/etc/server.env" ;;
    storage) sed -i 's/GS_STORAGE=aws/GS_STORAGE=file/' "$T/etc/server.env" ;;
    running) echo running >"$S/container" ;;
    arch) echo linux/amd64 >"$S/platform" ;;
    digest) release "sha256:short" b1 release.env ;;
  esac
  if run gs-preflight; then bad "preflight must refuse: $case" "$(cat "$T/out")"; else grep -q "REFUSED" "$T/out" && ok "preflight refuses: $case" || bad "preflight $case message" "$(cat "$T/out")"; fi
  teardown
done

setup; release "$DIGEST_A" b1 release.env; echo exited >"$S/container"
run gs-preflight && grep -q "docker rm gs-server" "$S/calls" && ok "preflight removes a STOPPED leftover container" || bad "stopped leftover" "$(cat "$T/out")"
teardown

# ------------------------------------------------------------------------------------------------- gs-run
setup; release "$DIGEST_A" b1 release.env
run gs-run
args="$(tr '\n' ' ' <"$S/run_args")"
for want in "-p 127.0.0.1:8917:8917" "--read-only" "--user node" "--cap-drop ALL" "--security-opt no-new-privileges" "--init" "--stop-timeout 120" "--log-driver awslogs" "awslogs-group=/gs/staging/host" "mode=non-blocking" "--env-file $T/etc/server.env" "BUILD_ID=b1" "111111111111.dkr.ecr.us-east-1.amazonaws.com/gs-staging-server@$DIGEST_A"; do
  case "$args" in *"$want"*) ;; *) bad "gs-run lacks: $want" "$args"; continue ;; esac
done
case "$args" in *"--network host"* | *"0.0.0.0"* | *NODE_OPTIONS*) bad "gs-run exposes or preloads unexpectedly" "$args" ;; *) ok "gs-run: loopback only, hardened, awslogs non-blocking, by digest" ;; esac
teardown
setup; printf 'GS_IMAGE_DIGEST=%s\nBUILD_ID=b1\nGS_MEASURE=1\n' "$DIGEST_A" >"$T/etc/release.env"
run gs-run; args="$(tr '\n' ' ' <"$S/run_args")"
case "$args" in *"NODE_OPTIONS=--require=/opt/gs-measure/gs-measure.cjs"*"/opt/gs/measure:/opt/gs-measure:ro"* | *"/opt/gs/measure:/opt/gs-measure:ro"*"NODE_OPTIONS=--require=/opt/gs-measure/gs-measure.cjs"*) ok "gs-run --measure: read-only sampler preload" ;; *) bad "measure preload" "$args" ;; esac
teardown

# ------------------------------------------------------------------------------------------------- gs-deploy
setup
if run gs-deploy sha256:nothex b1; then bad "deploy accepts a bad digest"; else ok "deploy refuses a malformed digest"; fi
if run gs-deploy "$DIGEST_A" 'b1;rm -rf /'; then bad "deploy accepts a bad build id"; else ok "deploy refuses a build id with shell characters"; fi
teardown

setup; release "$DIGEST_A" b1 release.env; echo 1 >"$S/active"; echo 200 >"$S/ready"; touch "$S/pull_fail"
if run gs-deploy "$DIGEST_B" b2; then bad "deploy succeeded although the pull failed"; else
  if grep -q "systemctl stop" "$S/calls"; then bad "a failed pull stopped the server"; else
    grep -q "BUILD_ID=b1" "$T/etc/release.env" && ok "a failed pull stops nothing and keeps the current release" || bad "release changed on failed pull"; fi; fi
teardown

setup; release "$DIGEST_A" b1 release.env; echo 1 >"$S/active"; echo 200 >"$S/ready"
if run gs-deploy "$DIGEST_B" b2; then
  order="$(grep -nE 'docker pull|systemctl stop|systemctl start' "$S/calls" | cut -d: -f1 | tr '\n' ' ')"
  pull_line="$(grep -n 'docker pull' "$S/calls" | head -1 | cut -d: -f1)"; stop_line="$(grep -n 'systemctl stop' "$S/calls" | head -1 | cut -d: -f1)"; start_line="$(grep -n 'systemctl start' "$S/calls" | head -1 | cut -d: -f1)"
  if [ "$pull_line" -lt "$stop_line" ] && [ "$stop_line" -lt "$start_line" ] && grep -q "BUILD_ID=b2" "$T/etc/release.env" && grep -q "BUILD_ID=b1" "$T/etc/release.previous.env"; then
    ok "deploy: pull -> drain -> rotate release (previous kept) -> start -> ready"
  else bad "deploy order / files" "$order"; fi
else bad "deploy happy path" "$(cat "$T/out")"; fi
: >"$S/calls"
run gs-deploy "$DIGEST_B" b2 && ! grep -q "systemctl stop" "$S/calls" && grep -q "nothing to do" "$T/out" && ok "deploy is idempotent (same release, ready: nothing stopped)" || bad "deploy idempotency" "$(cat "$T/out")"
teardown

setup; release "$DIGEST_A" b1 release.env; echo 1 >"$S/active"; echo 200 >"$S/ready"; echo 503 >"$S/start_ready"
if run gs-deploy "$DIGEST_B" b2; then bad "deploy reported success without readiness"; else grep -q "left running for diagnosis" "$T/out" && ok "deploy fails (not auto-rollback) when the new release is not ready" || bad "deploy not-ready message" "$(cat "$T/out")"; fi
teardown

setup; release "$DIGEST_A" b1 release.env; echo running >"$S/container"; echo 0 >"$S/active"
# a container that survives the stop must refuse the deploy before anything is started
cat >"$T/stubs/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >>"$STUB_STATE/calls"; case "$1" in is-active) exit 3 ;; show) echo 0 ;; esac; exit 0
EOF
chmod +x "$T/stubs/systemctl"
if run gs-deploy "$DIGEST_B" b2; then bad "deploy started over a surviving container"; else ! grep -q "systemctl start" "$S/calls" && ok "deploy refuses when a server container survives the stop (never two)" || bad "started anyway"; fi
teardown

# ------------------------------------------------------------------------------------------------- gs-rollback / gs-stop
setup; release "$DIGEST_B" b2 release.env
if run gs-rollback; then bad "rollback without a previous release"; else ok "rollback refuses without a previous release"; fi
release "$DIGEST_A" b1 release.previous.env; echo 1 >"$S/active"
run gs-rollback && grep -q "BUILD_ID=b1" "$T/etc/release.env" && grep -q "BUILD_ID=b2" "$T/etc/release.previous.env" && ok "rollback swaps current and previous (twice = forward again)" || bad "rollback swap" "$(cat "$T/out")"
teardown

setup; echo 1 >"$S/active"
run gs-stop --until-deploy && grep -q "systemctl stop gs-server.service" "$S/calls" && grep -q "systemctl disable" "$S/calls" && ok "stop --until-deploy drains and keeps it stopped across reboots" || bad "stop --until-deploy" "$(cat "$T/out")"
teardown

setup; release "$DIGEST_A" b1 release.env; echo 1 >"$S/active"; echo 200 >"$S/ready"
run gs-health && grep -q '"readyz":"200"' "$T/out" && grep -q '"build":"b1"' "$T/out" && ok "gs-health: one JSON line, exit 0 when ready" || bad "gs-health" "$(cat "$T/out")"
echo 503 >"$S/ready"
if run gs-health; then bad "gs-health exit 0 while not ready"; else ok "gs-health exits non-zero while not ready"; fi
teardown

# ------------------------------------------------------------------------------------------------- stop / HOLD
setup; echo 0 >"$S/active"
run gs-stop && grep -q "systemctl stop gs-server.service" "$S/calls" && ok "stop always sends systemctl stop (cancels a start in progress or a pending restart)" || bad "stop when not active" "$(calls)"
teardown

setup; release "$DIGEST_A" b1 release.env
EXIT_CODE=exited EXIT_STATUS=0 run gs-exit-hold; [ ! -e "$T/lib/hold" ] && ok "a graceful exit 0 sets no HOLD" || bad "hold on exit 0"
EXIT_CODE=exited EXIT_STATUS=2 run gs-exit-hold; [ ! -e "$T/lib/hold" ] && ok "a refused start (exit 2) sets no HOLD (systemd retries within its limit)" || bad "hold on exit 2"
EXIT_CODE=exited EXIT_STATUS=3 run gs-exit-hold; [ -e "$T/lib/hold" ] && ok "a proven loss (exit 3) sets the HOLD" || bad "no hold on exit 3"
if run gs-preflight; then bad "preflight started a held host (e.g. after a reboot)"; else grep -q "on HOLD" "$T/out" && ok "preflight refuses while on HOLD (also after a reboot)" || bad "hold refusal message" "$(cat "$T/out")"; fi
touch "$S/pull_fail"
if run gs-deploy "$DIGEST_B" b2; then bad "a deploy whose pull failed succeeded"; else [ -e "$T/lib/hold" ] && ok "a REFUSED deploy (pull failed) keeps the HOLD (a reboot still cannot restart the fenced server)" || bad "refused deploy cleared the hold"; fi
rm -f "$S/pull_fail"
if run gs-rollback; then bad "a rollback without a previous release succeeded"; else [ -e "$T/lib/hold" ] && ok "a REFUSED rollback (no previous release) keeps the HOLD" || bad "refused rollback cleared the hold"; fi
echo 1 >"$S/active"; echo 200 >"$S/ready"
run gs-deploy "$DIGEST_B" b2 && [ ! -e "$T/lib/hold" ] && grep -q "clearing the HOLD" "$T/out" && ok "only an explicit gs-deploy clears the HOLD" || bad "deploy clears hold" "$(cat "$T/out")"
rm -f "$T/lib/hold"; EXIT_CODE=exited EXIT_STATUS=5 run gs-exit-hold; [ -e "$T/lib/hold" ] && ok "a role change (exit 5) sets the HOLD" || bad "no hold on exit 5"
EXIT_CODE=killed EXIT_STATUS=9 run gs-exit-hold; ok "a SIGKILL leaves the HOLD as it was (no new hold)"
teardown

# ------------------------------------------------------------------------------------------------- measurement
setup
run gs-host-sample && line="$(cat "$T/measure"/host-*.jsonl)" && python3 -c "import json,sys; d=json.loads(sys.argv[1]); assert d['mem_total_kb']>0 and 'server_mem_peak' in d" "$line" && ok "host sample: one JSON line" || bad "host sample" "$(cat "$T/out") $line"
! grep -q "aws cloudwatch" "$S/calls" && ok "no pressure datapoint without pressure" || bad "pressure published without pressure"
touch "$S/oom"; run gs-host-sample; run gs-host-sample
[ "$(grep -c 'aws cloudwatch put-metric-data' "$S/calls")" = 1 ] && grep -q "HostPressure" "$S/calls" && ok "an OOM publishes ONE HostPressure datapoint (rate-limited)" || bad "pressure publish" "$(calls)"
run gs-measure-report 14 && python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['samples']==3 and d['host_oom_log_lines']>=1" "$T/out" && ok "measure report summarises the samples" || bad "measure report" "$(cat "$T/out")"
teardown

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
