#!/usr/bin/env bash
# infra/aws/modules/single-host/tests/host-scripts.test.sh -- COST-1: the single host's scripts (files/bin) against
# STUBBED docker / systemctl / curl / aws (no Docker daemon, no systemd, no AWS, no network). Run from anywhere:
#   bash infra/aws/modules/single-host/tests/host-scripts.test.sh
# What is pinned: gs-preflight refuses (fail closed) on every unsafe state; gs-deploy pulls BEFORE it stops anything, is
# idempotent, rotates the release files, starts and waits for readiness; gs-rollback swaps; gs-stop --until-deploy
# disables; gs-run publishes on 127.0.0.1 only with the hardened flags; gs-host-sample / gs-measure-report work.
# PHASE 1 FRESH-HOST HARDENING: the stubs answer as the REAL CLIs do (measured on docker 25.0.14 -- Amazon Linux 2023's
# docker-25.0.16 -- and 29.8.2, and on curl): the old docker stub answered a missing container with exit 1 and NO output,
# the real CLI prints an EMPTY LINE, and that difference let step 13's fresh-host failure pass every offline gate. The
# systemctl stub's `start` runs the unit's real ExecStartPre (gs-preflight) and ExecStart (gs-run), with systemd's start
# limit. The same checks against a REAL Docker daemon: tests/preflight-real-docker.test.sh.
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
  export GS_MEASURE_DIR="$T/measure" GS_STATE_DIR="$T/lib" STUB_STATE="$S" GS_ROOT_AWS_DIR="$T/root-aws" GS_BIN_UNDER_TEST="$BIN"
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
  # docker, as the real CLI answers: `inspect -f` of a MISSING object prints an EMPTY LINE on stdout (no -f: "[]") and its
  # error on stderr, exit 1 -- and an unreachable daemon ($S/daemon_down) answers inspect with the SAME stdout and status;
  # `container ls` answers "no match" with exit 0 and no byte, an unreachable daemon with exit 1; `rm` without -f refuses
  # a running / paused / restarting container. Knobs: $S/container (gs-server's state), $S/others ("name state" lines),
  # $S/inspect_missing_stdout, $S/ls_empty_stdout, $S/ls_down_stdout, $S/ls_prefix (stdout-shape probes).
  cat >"$T/stubs/docker" <<'EOF'
#!/usr/bin/env bash
S="$STUB_STATE"; echo "docker $*" >>"$S/calls"
down() { echo "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory" >&2; exit 1; }
blank() { if [ -f "$S/inspect_missing_stdout" ]; then cat "$S/inspect_missing_stdout"; else printf '\n'; fi; }
cmd="$1"; shift
case "$cmd" in
  pull) [ -f "$S/daemon_down" ] && down; [ -f "$S/pull_fail" ] && { echo "Error response from daemon: manifest unknown" >&2; exit 1; }; exit 0 ;;
  run) [ -f "$S/daemon_down" ] && down; printf '%s\n' run "$@" >"$S/run_args"; echo running >"$S/container"; exit 0 ;;
  container | image) cmd="$cmd-$1"; shift ;;
  rm) cmd=container-rm ;;
  ps) cmd=container-ls ;;
esac
fmt=""; all=0; quiet=0; force=0; filter=""; name=""
while [ $# -gt 0 ]; do
  case "$1" in
    --format) fmt="$2"; shift 2 ;;
    -f) if [ "$cmd" = container-rm ]; then force=1; shift; else fmt="$2"; shift 2; fi ;;
    --filter) filter="${2#name=}"; shift 2 ;;
    -a | --all) all=1; shift ;;
    -q | --quiet) quiet=1; shift ;;
    --force) force=1; shift ;;
    -*) shift ;;
    *) name="$1"; shift ;;
  esac
done
case "$cmd" in
  container-inspect)
    [ -f "$S/daemon_down" ] && { if [ -n "$fmt" ]; then blank; else echo '[]'; fi; down; }
    if [ "$name" = gs-server ] && [ -f "$S/container" ]; then
      if [ -z "$fmt" ]; then echo '[{"Name":"/gs-server"}]'; exit 0; fi
      case "$fmt" in *.Image*) echo "sha256:1mage" ;; *.Id*) echo "c0ffee00" ;; *) cat "$S/container" ;; esac; exit 0
    fi
    if [ -n "$fmt" ]; then blank; else echo '[]'; fi
    echo "Error response from daemon: No such container: $name" >&2; exit 1 ;;
  container-ls)
    [ -f "$S/daemon_down" ] && { [ -f "$S/ls_down_stdout" ] && cat "$S/ls_down_stdout"; down; }
    out=""
    while read -r n st; do
      [ -n "$n" ] || continue
      if [ -n "$filter" ]; then [[ "/$n" =~ $filter ]] || [[ "$n" =~ $filter ]] || continue; fi
      [ "$all" = 1 ] || case "$st" in running | paused | restarting) ;; *) continue ;; esac
      if [ "$quiet" = 1 ]; then out="$out$(printf 'id-%s' "$n")"$'\n'
      else case "$fmt" in *.State*) out="$out$st"$'\n' ;; *.Names*) out="$out$n"$'\n' ;; *) out="$out$n $st"$'\n' ;; esac; fi
    done < <({ [ -f "$S/container" ] && printf 'gs-server %s\n' "$(cat "$S/container")"; cat "$S/others" 2>/dev/null; } || true)
    if [ -n "$out" ]; then cat "$S/ls_prefix" 2>/dev/null; printf '%s' "$out"; elif [ -f "$S/ls_empty_stdout" ]; then cat "$S/ls_empty_stdout"; fi
    exit 0 ;;
  container-rm)
    [ -f "$S/daemon_down" ] && down
    if [ "$name" = gs-server ] && [ -f "$S/container" ]; then
      st="$(cat "$S/container")"
      if [ "$force" = 0 ]; then case "$st" in running | paused | restarting) echo "Error response from daemon: cannot remove container \"gs-server\": container is $st: stop the container before removing or force remove" >&2; exit 1 ;; esac; fi
      rm -f "$S/container"; echo gs-server; exit 0
    fi
    echo "Error response from daemon: No such container: $name" >&2; exit 1 ;;
  image-inspect)
    [ -f "$S/daemon_down" ] && { blank; down; }
    case "$fmt" in *RepoDigests*) [ -f "$S/repo_digests" ] && cat "$S/repo_digests"; exit 0 ;; esac
    [ -f "$S/platform" ] && { cat "$S/platform"; exit 0; }
    blank; echo "Error response from daemon: No such image: $name" >&2; exit 1 ;;
esac
[ -f "$S/daemon_down" ] && down
exit 0
EOF
  # systemctl: `start` is the unit's start job -- ExecStartPre (the REAL gs-preflight), then ExecStart (the real gs-run on the
  # stub docker). A refused preflight fails the job (exit 1) and runs ExecStopPost (gs-exit-hold, with no EXIT_CODE: no main
  # process ran); Restart=on-failure then retries until StartLimitBurst=5 starts (StartLimitIntervalSec=900) -- the live
  # step-13 record: five refusals, start-limit-hit -- after which a start is refused outright until `reset-failed`.
  cat >"$T/stubs/systemctl" <<'EOF'
#!/usr/bin/env bash
S="$STUB_STATE"; echo "systemctl $*" >>"$S/calls"
st() { cat "$S/active" 2>/dev/null || echo 0; }
fails() { cat "$S/start_failures" 2>/dev/null || echo 0; }
case "$1" in
  is-active)
    [ "${*: -1}" = gs-caddy.service ] && { [ "$2" = "--quiet" ] || echo active; exit 0; }
    case "$(st)" in 1) [ "$2" = "--quiet" ] || echo active; exit 0 ;; failed) [ "$2" = "--quiet" ] || echo failed; exit 3 ;; esac
    [ "$2" = "--quiet" ] || echo inactive; exit 3 ;;
  stop) [ "$(st)" = failed ] || echo 0 >"$S/active"; echo 503 >"$S/ready"; rm -f "$S/container"; exit 0 ;;
  reset-failed) echo 0 >"$S/start_failures"; [ "$(st)" = failed ] && echo 0 >"$S/active"; exit 0 ;;
  start)
    [ "$(fails)" -ge 5 ] && { echo "Job for gs-server.service failed: start request repeated too quickly (start-limit-hit)" >&2; exit 1; }
    first=1
    while [ "$(fails)" -lt 5 ]; do
      if "$GS_BIN_UNDER_TEST/gs-preflight" >>"$S/preflight.log" 2>&1; then
        "$GS_BIN_UNDER_TEST/gs-run" >>"$S/run.log" 2>&1
        echo 1 >"$S/active"; cat "$S/start_ready" 2>/dev/null >"$S/ready" || echo 200 >"$S/ready"
        [ "$first" = 1 ] && exit 0; exit 1   # a later automatic restart succeeded; the start job itself had failed
      fi
      env -u EXIT_CODE -u EXIT_STATUS "$GS_BIN_UNDER_TEST/gs-exit-hold" >/dev/null 2>&1
      echo failed >"$S/active"; echo $(($(fails) + 1)) >"$S/start_failures"; first=0
    done
    echo "Job for gs-server.service failed because the control process exited with error code." >&2; exit 1 ;;
  show) echo 0; exit 0 ;;
esac
exit 0
EOF
  # curl, as the real one answers: an HTTP answer -> -w prints its code, exit 0 (22 only with -f and a code >= 400); NO
  # answer (nothing listening: code 000) -> -w prints "000" ITSELF and curl exits 7. Caddy's TLS origin answers 200 while
  # the server is ready, otherwise 503; $S/origin overrides it (000: Caddy not answering).
  cat >"$T/stubs/curl" <<'EOF'
#!/usr/bin/env bash
S="$STUB_STATE"; url=""; wout=""; fail=0
while [ $# -gt 0 ]; do case "$1" in -w) wout="$2"; shift 2 ;; -m|-H|-X|-o|--resolve) shift 2 ;; --*) shift ;; -*f*) fail=1; shift ;; -*) shift ;; *) url="$1"; shift ;; esac; done
case "$url" in
  */latest/api/token) echo token; exit 0 ;;
  */meta-data/public-ipv4) cat "$S/ip"; exit 0 ;;
  https://*) code="$(cat "$S/origin" 2>/dev/null || { [ "$(cat "$S/ready")" = 200 ] && echo 200 || echo 503; })" ;;
  */gs/readyz) code="$(cat "$S/ready")" ;;
  */gs/healthz) code="$(cat "$S/ready")"; [ "$code" = 000 ] || code=200 ;;
  *) code=000 ;;
esac
[ -n "$wout" ] && printf '%s' "$code"
[ "$code" = 000 ] && exit 7
[ "$fail" = 1 ] && [ "$code" -ge 400 ] && exit 22
exit 0
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
run gs-preflight && grep -q "docker container rm gs-server" "$S/calls" && [ ! -e "$S/container" ] && ok "preflight removes a STOPPED leftover container" || bad "stopped leftover" "$(cat "$T/out")"
teardown

# ------------------------------------------------------------------------------------------------- fresh host (step 13)
# PHASE 1 FRESH-HOST HARDENING. Step 13's state before the FIRST start: Docker and Caddy running, NO gs-server container
# (there never was one), the release pulled (linux/arm64), release.env valid with GS_MEASURE=1, no HOLD, the serving EIP.
fresh() { setup; printf 'GS_IMAGE_DIGEST=%s\nBUILD_ID=sh1-test-arm64-r1\nGS_MEASURE=1\n' "$DIGEST_A" >"$T/etc/release.env"; }
fresh
v="$(docker container inspect -f '{{.State.Status}}' gs-server 2>/dev/null || printf 'absent')"
[ "$v" = $'\nabsent' ] && ok "stub = real CLI: the OLD 'inspect || printf absent' reads \"\\nabsent\" on a missing container (step 13's failure)" || bad "stub fidelity (missing container)" "$(printf '%q' "$v")"
touch "$S/daemon_down"; v="$(docker container inspect -f '{{.State.Status}}' gs-server 2>/dev/null)"; rc=$?; rm -f "$S/daemon_down"
[ "$v" = "" ] && [ "$rc" = 1 ] && ok "stub = real CLI: an unreachable daemon answers inspect exactly like a missing container (exit 1, empty line)" || bad "stub fidelity (daemon down)" "$rc $(printf '%q' "$v")"
if run gs-preflight && grep -q "preflight passed" "$T/out"; then
  ! grep -qE "docker (container )?rm" "$S/calls" && ok "fresh host: gs-preflight PASSES with no gs-server container (nothing removed)" || bad "fresh host removed something" "$(calls)"
else bad "fresh host: gs-preflight refused" "$(cat "$T/out")"; fi
teardown

fresh; rm -f "$T/etc/release.env"
if run gs-deploy "$DIGEST_A" sh1-test-arm64-r1 --measure && grep -q "is READY" "$T/out"; then
  if grep -q "preflight passed" "$S/preflight.log" && grep -q "GS_MEASURE=1" "$T/etc/release.env" && [ ! -e "$T/etc/release.previous.env" ] && [ ! -e "$T/lib/hold" ] && grep -q "NODE_OPTIONS=--require" "$S/run_args"; then
    ok "fresh host: the FIRST gs-deploy --measure (step 13) passes the unit's real preflight and is READY (no previous release, no HOLD)"
  else bad "fresh host first deploy: files" "$(cat "$S/preflight.log") $(ls "$T/etc")"; fi
else bad "fresh host: the first gs-deploy failed" "$(cat "$T/out") $(cat "$S/preflight.log" 2>/dev/null)"; fi
teardown

# The live state after step 13 refused: release.env written (GS_MEASURE=1), the unit failed after five refused starts
# (systemd's start limit), no container, no HOLD. The remediation is the SAME gs-deploy -Measure: reset-failed, then a start.
fresh; echo failed >"$S/active"; echo 5 >"$S/start_failures"
if systemctl start gs-server.service 2>/dev/null; then bad "start limit: a 6th start ran"; else
  [ ! -e "$S/preflight.log" ] && ok "after five refused starts systemd refuses a start outright (start-limit-hit): no preflight runs" || bad "start limit: preflight ran"; fi
cp "$T/etc/release.env" "$T/release.before"
if run gs-deploy "$DIGEST_A" sh1-test-arm64-r1 --measure && grep -q "is READY" "$T/out"; then
  reset_line="$(grep -n 'systemctl reset-failed' "$S/calls" | head -1 | cut -d: -f1)"; start_line="$(grep -n 'systemctl start' "$S/calls" | tail -1 | cut -d: -f1)"
  if [ -n "$reset_line" ] && [ "$reset_line" -lt "$start_line" ] && cmp -s "$T/release.before" "$T/etc/release.env" && [ ! -e "$T/etc/release.previous.env" ] && [ ! -e "$T/lib/hold" ]; then
    ok "remediation: re-running the SAME gs-deploy --measure clears the start limit (reset-failed), passes the preflight, is READY; release unchanged, no HOLD"
  else bad "remediation rerun: order / files" "$(calls)"; fi
else bad "remediation rerun failed" "$(cat "$T/out")"; fi
teardown

# The incident REPLAYED: the same scripts with the pre-fix one-server check (`inspect || printf absent`) on the fresh host.
# Then 13r's remediation on that very state: the certified gs-preflight installed ALONE by the reviewed installer, and the
# SAME gs-deploy --measure re-run.
fresh; rm -f "$T/etc/release.env"; mkdir -p "$T/oldbin"; cp "$BIN"/* "$T/oldbin/"
python3 - "$T/oldbin/gs-preflight" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
a = s.index("# One server per host"); b = s.index("esac\n", a) + len("esac\n")
old = """# One server per host.
state="$(docker container inspect -f '{{.State.Status}}' gs-server 2>/dev/null || printf 'absent')"
case "$state" in
  absent) ;;
  running | restarting | paused) die "a gs-server container is already $state (one server per host)" ;;
  *) docker rm gs-server >/dev/null ;;
esac
"""
open(p, "w").write(s[:a] + old + s[b:])
PY
chmod 0755 "$T/oldbin"/*
if GS_BIN_UNDER_TEST="$T/oldbin" "$T/oldbin/gs-deploy" "$DIGEST_A" sh1-test-arm64-r1 --measure >"$T/out" 2>&1; then bad "the incident replay: the pre-fix preflight STARTED the fresh host"; else
  if [ "$(grep -c 'No such container: gs-server' "$S/preflight.log")" = 5 ] && [ "$(cat "$S/start_failures")" = 5 ] && [ "$(cat "$S/active")" = failed ] && grep -q "GS_MEASURE=1" "$T/etc/release.env" && [ ! -e "$T/lib/hold" ] && [ ! -e "$S/container" ] && [ ! -e "$S/run_args" ]; then
    ok "the step-13 incident REPLAYED: the pre-fix check refuses the fresh host 5 times (docker rm: No such container) -> start-limit-hit; release.env written; no container, no server run, no HOLD"
  else bad "incident replay" "$(cat "$T/out") | $(cat "$S/preflight.log")"; fi
fi
if [ -f "$HERE/../../../single-host/host-script-install.sh" ]; then
  old13="$(sha256sum "$T/oldbin/gs-preflight" | cut -c1-64)"; new13="$(sha256sum "$BIN/gs-preflight" | cut -c1-64)"
  GS_TEST=1 GS_TEST_BIN="$T/oldbin" GS_TEST_LOCK="$T/oldlock" bash "$HERE/../../../single-host/host-script-install.sh" install gs-preflight "$new13" "$old13" "$BIN/gs-preflight" >"$T/inst.out" 2>&1
  : >"$S/preflight.log"
  if grep -qx "result=installed" "$T/inst.out" && GS_BIN_UNDER_TEST="$T/oldbin" "$T/oldbin/gs-deploy" "$DIGEST_A" sh1-test-arm64-r1 --measure >"$T/out" 2>&1 && grep -q "is READY" "$T/out" && [ "$(grep -c 'preflight passed' "$S/preflight.log")" = 1 ] && [ ! -e "$T/lib/hold" ]; then
    ok "13r on the replayed incident: the certified gs-preflight installed ALONE, the SAME gs-deploy --measure re-run -> reset-failed, preflight passed, READY"
  else bad "13r rehearsal" "$(cat "$T/inst.out") | $(cat "$T/out")"; fi
else bad "13r rehearsal: infra/aws/single-host/host-script-install.sh is not beside the module"; fi
teardown

for st in exited created dead; do
  fresh; echo "$st" >"$S/container"
  run gs-preflight && grep -q "docker container rm gs-server" "$S/calls" && [ ! -e "$S/container" ] && ok "preflight removes a $st leftover gs-server container and continues" || bad "leftover $st" "$(cat "$T/out")"
  teardown
done
for st in running restarting paused removing; do
  fresh; echo "$st" >"$S/container"
  if run gs-preflight; then bad "preflight accepted a $st gs-server container"; else
    if grep -q REFUSED "$T/out" && ! grep -qE "docker (container )?rm" "$S/calls" && [ "$(cat "$S/container")" = "$st" ]; then ok "preflight REFUSES a $st gs-server container and never removes it"; else bad "refusal $st" "$(cat "$T/out") $(calls)"; fi
  fi
  teardown
done
fresh; touch "$S/daemon_down"
if run gs-preflight; then bad "preflight passed with the Docker daemon unreachable"; else
  grep -q "docker could not list containers" "$T/out" && ! grep -qE "docker (container )?rm" "$S/calls" && ok "Docker daemon unreachable: preflight REFUSES (never read as 'no container')" || bad "daemon down refusal" "$(cat "$T/out")"; fi
teardown
# Whatever the CLI prints on stdout, an unreachable daemon refuses and a missing container passes (newline conventions).
for out in '' $'\n' $'\n\n' 'absent' $'absent\n' $'\nabsent'; do
  fresh; printf '%s' "$out" >"$S/inspect_missing_stdout"; printf '%s' "$out" >"$S/ls_empty_stdout"
  run gs-preflight; a=$?
  touch "$S/daemon_down"; printf '%s' "$out" >"$S/ls_down_stdout"; run gs-preflight; d=$?
  case "$out" in *[!$'\n']*) want_a=1 ;; *) want_a=0 ;; esac   # only an all-newline empty listing is "absent"
  if [ "$a" = "$want_a" ] && [ "$d" != 0 ]; then ok "stdout $(printf '%q' "$out") around a missing container / a down daemon: absent=$([ "$a" = 0 ] && echo pass || echo refuse), daemon down=refuse"
  else bad "stdout shape $(printf '%q' "$out")" "absent exit $a (want $want_a), daemon-down exit $d"; fi
  teardown
done
for st in exited running; do
  fresh; echo "$st" >"$S/container"; printf '\n' >"$S/ls_prefix"
  if run gs-preflight; then bad "a blank line before '$st' was read as absent"; else
    [ "$(cat "$S/container")" = "$st" ] && ok "a blank line before '$st' never reads as absent and removes nothing (refused)" || bad "odd answer removed the container"; fi
  teardown
done
fresh; printf 'gs-server-old exited\nold-gs-server running\nxgs-serverx exited\n' >"$S/others"
run gs-preflight && ! grep -qE "docker (container )?rm" "$S/calls" && ok "near-miss names (gs-server-old, old-gs-server, xgs-serverx) are not gs-server: passed, none removed" || bad "near-miss names" "$(cat "$T/out")"
teardown
if grep -n 'container inspect' "$BIN/gs-preflight" || grep -n "|| printf 'absent'" "$BIN"/*; then bad "the one-server check uses inspect / an 'absent' fallback again"; else ok "static: gs-preflight decides 'one server' by a listing, never by inspect or an 'absent' fallback"; fi

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

# COST-2A: the host verifier's evidence -- the release digest, the RUNNING container's digest, the static-credential names
setup; release "$DIGEST_A" b1 release.env; echo 1 >"$S/active"; echo 200 >"$S/ready"; echo running >"$S/container"
printf '%s\n' "public.ecr.aws/other@$DIGEST_B" "111111111111.dkr.ecr.us-east-1.amazonaws.com/gs-staging-server@$DIGEST_A" >"$S/repo_digests"
run gs-health && python3 -c "import json,sys; d=json.loads(open(sys.argv[1]).read().strip().splitlines()[-1]); assert d['digest']==sys.argv[2] and d['running_digest']==sys.argv[2] and d['static_credentials']=='none' and d['hold']=='none' and d['origin_hostname']=='gs-origin.example.org', d" "$T/out" "$DIGEST_A" && ok "gs-health: release digest = running digest (this repository's), no static credential" || bad "gs-health digests" "$(cat "$T/out")"
rm -f "$S/container"
run gs-health; grep -q '"running_digest":"none"' "$T/out" && ok "gs-health: no running container -> running_digest none" || bad "gs-health no container" "$(cat "$T/out")"
echo running >"$S/container"; printf '%s\n' "public.ecr.aws/other@$DIGEST_B" >"$S/repo_digests"
run gs-health; grep -q '"running_digest":"unknown"' "$T/out" && ok "gs-health: a container from another repository -> unknown (never the release's)" || bad "gs-health foreign image" "$(cat "$T/out")"
echo 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIexampleSECRETvalue000000000' >>"$T/etc/server.env"; mkdir -p "$T/root-aws"; : >"$T/root-aws/credentials"
run gs-health
if grep -q '"static_credentials":"AWS_SECRET_ACCESS_KEY,aws-credentials-file"' "$T/out" && ! grep -q 'wJalrXUtnFEMI' "$T/out"; then ok "gs-health: names a static credential source, never its value"; else bad "gs-health credentials" "$(cat "$T/out")"; fi
teardown
setup; release "$DIGEST_A" b1 release.env; echo 1 >"$S/active"; echo 200 >"$S/ready"
printf '  AWS_ACCESS_KEY_ID=AKIAEXAMPLEEXAMPLE00\n' >>"$T/etc/server.env"   # docker --env-file trims the leading blanks
run gs-health; grep -q '"static_credentials":"AWS_ACCESS_KEY_ID"' "$T/out" && ! grep -q 'AKIAEXAMPLE' "$T/out" && ok "gs-health: a whitespace-prefixed credential is still named (never valued)" || bad "gs-health leading whitespace" "$(cat "$T/out")"
if run gs-preflight; then bad "preflight accepted a whitespace-prefixed credential"; else grep -q "REFUSED" "$T/out" && ok "preflight refuses a whitespace-prefixed credential (docker would pass it on)" || bad "preflight leading whitespace message" "$(cat "$T/out")"; fi
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

# ------------------------------------------------------------------------------------------------- same class (audit)
# PHASE 1 FRESH-HOST HARDENING's audit: the other places where a missing object and a failing CLI looked alike.
setup; echo 1 >"$S/active"; touch "$S/daemon_down"
if run gs-stop; then bad "gs-stop reported stopped while docker could not answer"; else
  grep -q "the stop is NOT proven" "$T/out" && ! grep -q "gs: stopped" "$T/out" && ok "stop_server: an unreachable Docker daemon never proves 'stopped' (gs-stop refuses)" || bad "gs-stop daemon down" "$(cat "$T/out")"; fi
teardown
setup; echo 1 >"$S/active"
cat >"$T/stubs/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >>"$STUB_STATE/calls"; case "$1" in is-active) echo inactive; exit 3 ;; show) echo 0 ;; esac; exit 0
EOF
chmod +x "$T/stubs/systemctl"; echo exited >"$S/container"
if run gs-stop; then bad "gs-stop reported stopped beside an exited gs-server container"; else grep -q "still exists after the stop (exited" "$T/out" && ok "stop_server: any gs-server container left after the stop refuses (as before), named by its state" || bad "gs-stop leftover" "$(cat "$T/out")"; fi
rm -f "$S/container"; run gs-stop && grep -q "gs: stopped" "$T/out" && ok "stop_server: docker answering and no container -> stopped" || bad "gs-stop clean" "$(cat "$T/out")"
teardown
setup; release "$DIGEST_A" b1 release.env; echo 1 >"$S/active"; echo 200 >"$S/ready"; touch "$S/daemon_down"
run gs-health; grep -q '"running_digest":"unknown"' "$T/out" && ok "gs-health: docker unreachable -> running_digest unknown (never 'none')" || bad "gs-health daemon down" "$(cat "$T/out")"
teardown
setup; release "$DIGEST_A" b1 release.env; echo 0 >"$S/active"; echo 000 >"$S/ready"; echo 000 >"$S/origin"
run gs-health
if grep -q '"healthz":"000","readyz":"000","origin_tls_readyz":"000"' "$T/out" && ! grep -q '000000' "$T/out"; then ok "gs-health: nothing answering -> 000 exactly (curl prints 000 itself; never the old '000000')"; else bad "gs-health 000" "$(cat "$T/out")"; fi
echo 503 >"$S/ready"; echo 503 >"$S/origin"; run gs-health
grep -q '"readyz":"503","origin_tls_readyz":"503"' "$T/out" && ok "gs-health: an HTTP answer is its code (503), as real curl reports it" || bad "gs-health 503" "$(cat "$T/out")"
teardown
if grep -nE "http_code\}'[^|]*\|\| *printf" "$BIN"/*; then bad "a curl -w '%{http_code}' still falls back with || printf (contaminates)"; else ok "static: no curl -w '%{http_code}' ... || printf fallback in files/bin"; fi

# ------------------------------------------------------------------------------------------------- one-script install (13r)
# PHASE 1 FRESH-HOST HARDENING's live remediation: infra/aws/single-host/host-script-install.sh (sent by `gs-host
# install-script`) replaces exactly ONE script on the EXISTING host. Here on a copy of the module's bin, as root would.
OPS="$HERE/../../../single-host"
if [ ! -f "$OPS/host-script-install.sh" ] || [ ! -f "$OPS/gs-host.sh" ]; then
  bad "the operator tooling (infra/aws/single-host) is not beside the module (run it from the repository; the owner gate copies infra/aws)"
else
  sha() { sha256sum "$1" | cut -c1-64; }
  inst() { GS_TEST=1 GS_TEST_BIN="$T/hostbin" GS_TEST_LOCK="$T/hostlock" bash "$OPS/host-script-install.sh" "$@" >"$T/out" 2>&1; }
  framed() { [ "$(head -n 1 "$T/out")" = "GS-HOST-INSTALL BEGIN" ] && grep -qx "GS-HOST-INSTALL END exit=$1" "$T/out"; }
  # The live host: the module's scripts with gs-preflight as the host-create commit's (an older, different, valid script).
  host13() {
    setup; mkdir -p "$T/hostbin"; cp "$BIN"/* "$T/hostbin/"; chmod 0755 "$T/hostbin"/*
    printf '# the host-create bytes\n' >>"$T/hostbin/gs-preflight"; cp "$T/hostbin/gs-preflight" "$T/old-preflight"
    NEW="$(sha "$BIN/gs-preflight")"; OLD="$(sha "$T/old-preflight")"; echo failed >"$S/active"
    ( cd "$T/hostbin" && sha256sum gs-lib.sh gs-run gs-exit-hold gs-deploy gs-rollback gs-stop gs-health gs-host-sample gs-measure-report ) >"$T/others.before"
  }
  others_same() { ( cd "$T/hostbin" && sha256sum gs-lib.sh gs-run gs-exit-hold gs-deploy gs-rollback gs-stop gs-health gs-host-sample gs-measure-report ) | cmp -s - "$T/others.before" && [ -z "$(find "$T/hostbin" -name '.*' -type f)" ]; }
  host13
  inst check gs-preflight "$NEW" "$OLD" "$BIN/gs-preflight"
  if framed 0 && grep -qx "result=checked (nothing was written)" "$T/out" && grep -qx "live_owner=$(id -un):$(id -gn)" "$T/out" && grep -qx "live_mode=755" "$T/out" && grep -qx "live_sha256=$OLD" "$T/out" && [ "$(sha "$T/hostbin/gs-preflight")" = "$OLD" ] && others_same; then
    ok "13r check: inspects the live file (owner, mode, SHA-256), verifies the certified bytes, writes NOTHING"; else bad "13r check" "$(cat "$T/out")"; fi
  inst install gs-preflight "$NEW" "$OLD" "$BIN/gs-preflight"
  if framed 0 && grep -qx "result=installed" "$T/out" && grep -qx "installed_sha256=$NEW" "$T/out" && cmp -s "$BIN/gs-preflight" "$T/hostbin/gs-preflight" && [ "$(stat -c %a "$T/hostbin/gs-preflight")" = 755 ] && others_same; then
    ok "13r install: exactly the certified bytes, 755, one rename -- every other host script byte-identical, no temporary file left"; else bad "13r install" "$(cat "$T/out")"; fi
  inst install gs-preflight "$NEW" "$OLD" "$BIN/gs-preflight"
  framed 0 && grep -q "^result=unchanged" "$T/out" && ok "13r install again: the certified bytes are already live -> unchanged, nothing written" || bad "13r rerun" "$(cat "$T/out")"
  teardown
  host13; printf 'exit 0\n' >"$T/other"
  inst install gs-preflight "$NEW" "$OLD" "$T/other"; c1=$?
  printf 'if then fi (\n' >"$T/broken"; inst install gs-preflight "$(sha "$T/broken")" "$OLD" "$T/broken"; c2=$?
  inst install gs-preflight "$NEW" "$(printf '0%.0s' {1..64})" "$BIN/gs-preflight"; c3=$?
  inst install gs-run "$NEW" "$OLD" "$BIN/gs-preflight"; c4=$?
  inst install gs-preflight "$NEW" "$OLD"; c5=$?
  if [ "$c1" = 93 ] && [ "$c2" = 94 ] && [ "$c3" = 91 ] && [ "$c4" = 2 ] && [ "$c5" = 2 ] && [ "$(sha "$T/hostbin/gs-preflight")" = "$OLD" ] && others_same; then
    ok "13r refuses received bytes that are not the certified ones (93), a script that does not parse (94), a live file it does not expect (91), any other name or a missing file (2) -- nothing changed"
  else bad "13r refusals" "exits $c1 $c2 $c3 $c4 $c5"; fi
  echo 1 >"$S/active"; inst install gs-preflight "$NEW" "$OLD" "$BIN/gs-preflight"; c1=$?; echo failed >"$S/active"
  echo exited >"$S/container"; inst install gs-preflight "$NEW" "$OLD" "$BIN/gs-preflight"; c2=$?; rm -f "$S/container"
  touch "$S/daemon_down"; inst install gs-preflight "$NEW" "$OLD" "$BIN/gs-preflight"; c3=$?; rm -f "$S/daemon_down"
  ( flock -n 9 && touch "$T/locked" && sleep 30 ) 9>"$T/hostlock" & holder=$!
  for _ in $(seq 1 100); do [ -e "$T/locked" ] && break; sleep 0.1; done
  inst install gs-preflight "$NEW" "$OLD" "$BIN/gs-preflight"; c4=$?; kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
  chmod 0644 "$T/hostbin/gs-preflight"; inst install gs-preflight "$NEW" "$OLD" "$BIN/gs-preflight"; c5=$?; chmod 0755 "$T/hostbin/gs-preflight"
  if [ "$c1" = 90 ] && [ "$c2" = 90 ] && [ "$c3" = 92 ] && [ "$c4" = 90 ] && [ "$c5" = 91 ] && [ "$(sha "$T/hostbin/gs-preflight")" = "$OLD" ] && others_same && framed 91; then
    ok "13r refuses while the server is active or a gs-server container exists (90), docker cannot answer (92), a deploy holds the lock (90), the live file is not 755 (91) -- nothing changed, every exit framed"
  else bad "13r server / lock / mode refusals" "exits $c1 $c2 $c3 $c4 $c5"; fi
  teardown
  # End to end through the operator's bash twin: gs-host.sh install-script builds the SSM command; a fake `aws` runs it as
  # the host would (Run Command) -- the exact payload installs the exact bytes, and a checkout that is not the certified
  # bytes sends nothing.
  host13
  cat >"$T/stubs/aws" <<'EOF'
#!/usr/bin/env bash
S="$STUB_STATE"; echo "aws $*" >>"$S/calls"
case "$*" in
  *send-command*) p=""; while [ $# -gt 0 ]; do [ "$1" = --parameters ] && p="${2#file://}"; shift; done
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["commands"][0])' "$p" >"$S/remote"
    ( cd "$S" && GS_TEST=1 GS_TEST_BIN="$GS_HOSTBIN" GS_TEST_LOCK="$GS_HOSTLOCK" bash "$S/remote" >"$S/remote.out" 2>"$S/remote.err"; echo $? >"$S/remote.rc" )
    echo cmd-0001 ;;
  *"--query Status"*) [ "$(cat "$S/remote.rc")" = 0 ] && echo Success || echo Failed ;;
  *StandardOutputContent*) cat "$S/remote.out" ;;
  *StandardErrorContent*) [ -s "$S/remote.err" ] && cat "$S/remote.err" || echo None ;;
esac
EOF
  printf '#!/usr/bin/env bash\nexit 0\n' >"$T/stubs/sleep"; chmod +x "$T/stubs/aws" "$T/stubs/sleep"
  export GS_HOSTBIN="$T/hostbin" GS_HOSTLOCK="$T/hostlock"
  if bash "$OPS/gs-host.sh" install-script i-0123456789abcdef0 gs-preflight "$NEW" "$OLD" >"$T/out" 2>&1 && grep -qx "result=installed" "$T/out" && cmp -s "$BIN/gs-preflight" "$T/hostbin/gs-preflight" && others_same \
    && grep -q '^d=\$(mktemp -d) && printf %s [A-Za-z0-9+/=]* | base64 -d > \$d/i && printf %s [A-Za-z0-9+/=]* | base64 -d > \$d/f && bash \$d/i install gs-preflight [0-9a-f]\{64\} [0-9a-f]\{64\} \$d/f; rc=\$?; rm -rf \$d; exit \$rc$' "$S/remote" && ! grep -q "[\"']" "$S/remote"; then
    ok "13r end to end (gs-host.sh install-script -> SSM -> host): the exact certified bytes installed; the remote line is the fixed template, no quote"
  else bad "13r end to end" "$(cat "$T/out") $(cat "$S/remote.err" 2>/dev/null)"; fi
  : >"$S/calls"; rm -f "$S/remote"
  if bash "$OPS/gs-host.sh" install-script i-0123456789abcdef0 gs-preflight "$OLD" "$OLD" >"$T/out" 2>&1; then bad "gs-host.sh sent bytes that are not the typed certified SHA-256"; else
    grep -q "not the certified" "$T/out" && ! grep -q "send-command" "$S/calls" && ok "13r gs-host.sh refuses a checkout whose bytes are not the typed certified SHA-256 (nothing sent)" || bad "gs-host.sh sha refusal" "$(cat "$T/out")"; fi
  unset GS_HOSTBIN GS_HOSTLOCK
  teardown
fi

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
