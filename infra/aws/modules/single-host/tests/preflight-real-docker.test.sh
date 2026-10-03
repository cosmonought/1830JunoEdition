#!/usr/bin/env bash
# infra/aws/modules/single-host/tests/preflight-real-docker.test.sh [IMAGE] -- PHASE 1 FRESH-HOST HARDENING: the single
# host's one-server check against a REAL Docker CLI and daemon (no docker stub). Step 13's first start on the fresh host
# failed because every offline gate ran gs-preflight against a docker stub that answered a missing container with exit 1
# and NO output; the real CLI prints an EMPTY LINE. This suite asks the real CLI. Only IMDS (curl) and systemctl are
# stubbed -- neither exists off an EC2 host; every other curl call is the real curl.
#   A  docker answering, no gs-server container (the fresh host)  -> gs-preflight PASSES
#   B  gs-server running / paused / restarting                    -> REFUSES; the container is untouched
#   C  gs-server exited / created (a leftover)                    -> removed; gs-preflight passes
#   D  the daemon unreachable                                     -> REFUSES (never "no container")
#   E  newlines added around the real CLI's stdout                 -> never "absent" for a present container or a down
#                                                                    daemon; still "absent" for a missing one
# plus: the root cause measured on THIS CLI; stop_server's proof (gs-stop) and running_digest / http_code (gs-health) on
# real answers; and gs-run's exact argument vector accepted by this daemon (`docker create`, never started: the awslogs
# driver needs the host's instance role).
# IMAGE (a local image; default: the owner gate's pinned AL2023 image) stands in for the release image -- by its repository
# digest -- and runs the throw-away containers (it needs sh, sleep and true). Safety: it REFUSES to run while a container
# named gs-server exists, names every container it creates (gs-server, gs-rt-*), and removes exactly those.
# Run it where the docker CLI under test is on PATH -- the owner gate runs it in Amazon Linux 2023 with AL2023's own docker
# package against the machine's daemon (the socket mounted):
#   bash infra/aws/modules/single-host/tests/preflight-real-docker.test.sh [IMAGE]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/../files/bin"
IMAGE="${1:-public.ecr.aws/amazonlinux/amazonlinux:2023@sha256:12052e9b5d3fd85769abbdd863dd038e1890c9ace31d5fdbe1afa78eda97d061}"
pass=0; fail=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; }
notrun() { printf 'NOT RUN: %s\n' "$1"; exit 2; }

DOCKER="$(command -v docker)" || notrun "no docker CLI on PATH"
REAL_CURL="$(command -v curl)" || notrun "no curl on PATH"
command -v flock >/dev/null || notrun "no flock (util-linux) on PATH"
cli="$("$DOCKER" version --format '{{.Client.Version}}' 2>/dev/null)"
server="$("$DOCKER" version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null)" || notrun "the Docker daemon is not answering (docker version)"
"$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1 || notrun "the image $IMAGE is not present locally (pull it first)"
[ -z "$("$DOCKER" container ls --all --quiet --filter 'name=^/?gs-server$')" ] || notrun "a container named gs-server already exists on this daemon: refusing to touch it"
printf 'docker CLI %s, daemon %s, image %s\n' "$cli" "$server" "$IMAGE"

# The release image = IMAGE by its repository digest: GS_ECR_REGISTRY/GS_ECR_REPOSITORY@GS_IMAGE_DIGEST resolves locally.
repo_digest="$("$DOCKER" image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE" | grep -E '@sha256:[0-9a-f]{64}$' | head -n 1)"
[ -n "$repo_digest" ] || notrun "$IMAGE has no repository digest"
name="${repo_digest%@*}"; digest="${repo_digest#*@}"
case "$name" in */*) registry="${name%/*}"; repository="${name##*/}" ;; *) registry="docker.io/library"; repository="$name" ;; esac
arch="$("$DOCKER" image inspect -f '{{.Architecture}}' "$IMAGE")"
[ "$("$DOCKER" image inspect -f '{{.Os}}/{{.Architecture}}' "$registry/$repository@$digest" 2>/dev/null)" = "linux/$arch" ] || notrun "$registry/$repository@$digest does not resolve to a local linux image"

T="$(mktemp -d)"
cleanup() { "$DOCKER" rm -f gs-server gs-rt-old gs-rt-alt >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
mkdir -p "$T/etc" "$T/stubs" "$T/noisy" "$T/lib" "$T/state"
cat >"$T/etc/host.env" <<EOF
GS_ENVIRONMENT=staging
GS_REGION=us-east-1
GS_ARCH=$arch
GS_ECR_REGISTRY=$registry
GS_ECR_REPOSITORY=$repository
GS_LOG_GROUP=/gs/staging/host
GS_EXPECTED_PUBLIC_IP=203.0.113.10
GS_ORIGIN_HOSTNAME=gs-origin.example.org
GS_CADDY_UID=2001
GS_SERVER_MEMORY=1536m
GS_CONTAINER_PORT=8917
GS_HOST_METRIC_NAMESPACE=18Cosmos/Host
EOF
printf 'GS_MODE=production\nGS_STORAGE=aws\nGS_AWS_CONFIG_PARAMETER=arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1\nPORT=8917\nGS_METRICS_PROFILE=single-host\n' >"$T/etc/server.env"
printf 'GS_IMAGE_DIGEST=%s\nBUILD_ID=sh1-realdocker-r1\nGS_MEASURE=1\n' "$digest" >"$T/etc/release.env"
# IMDS (the only curl answer stubbed): the serving address. Every other URL goes to the REAL curl.
cat >"$T/stubs/curl" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in http://imds.test/latest/api/token) echo token; exit 0 ;; http://imds.test/latest/meta-data/public-ipv4) printf 203.0.113.10; exit 0 ;; esac; done
exec "$REAL_CURL" "\$@"
EOF
# systemctl: the unit is already stopped (gs-stop / gs-health only ask it).
cat >"$T/stubs/systemctl" <<'EOF'
#!/usr/bin/env bash
case "$1" in is-active) echo inactive; exit 3 ;; show) echo 0 ;; esac; exit 0
EOF
# E: the REAL docker with an empty line added before and after the stdout of every CONTAINER query (stderr and exit
# status unchanged; image queries untouched -- the image check compares exactly and refuses any odd answer anyway).
cat >"$T/noisy/docker" <<EOF
#!/usr/bin/env bash
[ "\$1" = container ] || exec "$DOCKER" "\$@"
out="\$("$DOCKER" "\$@"; printf 'rc=%s' "\$?")"; rc="\${out##*rc=}"; printf '\n%s\n' "\${out%rc=*}"; exit "\$rc"
EOF
chmod 0755 "$T/stubs/"* "$T/noisy/docker"
export GS_TEST=1 GS_ETC="$T/etc" GS_IMDS="http://imds.test" GS_LOCK="$T/lock" GS_STATE_DIR="$T/lib" GS_ROOT_AWS_DIR="$T/root-aws" GS_POLL_SECONDS=0
PATH="$T/stubs:$PATH"; export PATH
preflight() { "$BIN/gs-preflight" >"$T/out" 2>&1; }
state_of() { "$DOCKER" container inspect -f '{{.State.Status}}' gs-server 2>/dev/null || true; }
gone() { [ -z "$("$DOCKER" container ls --all --quiet --filter 'name=^/?gs-server$')" ]; }

# --- the root cause, measured on THIS CLI -----------------------------------------------------------------------------
v="$("$DOCKER" container inspect -f '{{.State.Status}}' gs-server 2>/dev/null; printf 'rc=%s' "$?")"
[ "$v" = $'\nrc=1' ] && ok "this CLI: inspect -f of a missing container prints an EMPTY LINE and exits 1" || bad "missing-container inspect shape" "$(printf '%q' "$v")"
v="$("$DOCKER" container inspect -f '{{.State.Status}}' gs-server 2>/dev/null || printf 'absent')"
[ "$v" = $'\nabsent' ] && ok "this CLI: the OLD 'inspect || printf absent' yields \"\\nabsent\" -- not 'absent' (step 13's first-start failure)" || bad "old pattern" "$(printf '%q' "$v")"
v="$(DOCKER_HOST=unix:///nonexistent/gs-rt.sock "$DOCKER" container inspect -f '{{.State.Status}}' gs-server 2>/dev/null; printf 'rc=%s' "$?")"
[ "$v" = $'\nrc=1' ] && ok "this CLI: an unreachable daemon answers that inspect IDENTICALLY (empty line, exit 1): inspect cannot tell 'absent' from 'docker failed'" || bad "daemon-down inspect shape" "$(printf '%q' "$v")"
v="$("$DOCKER" container ls --all --filter 'name=^/?gs-server$' --format '{{.State}}'; printf 'rc=%s' "$?")"
[ "$v" = 'rc=0' ] && ok "this CLI: the listing answers 'no gs-server' with exit 0 and no byte" || bad "listing shape (missing)" "$(printf '%q' "$v")"
v="$(DOCKER_HOST=unix:///nonexistent/gs-rt.sock "$DOCKER" container ls --all --filter 'name=^/?gs-server$' --format '{{.State}}' 2>/dev/null; printf 'rc=%s' "$?")"
[ "${v##*rc=}" != 0 ] && ok "this CLI: the listing FAILS (exit ${v##*rc=}) when the daemon is unreachable" || bad "listing shape (daemon down)" "$(printf '%q' "$v")"

# --- A: the fresh host ------------------------------------------------------------------------------------------------
if preflight && grep -q "preflight passed" "$T/out" && gone; then ok "A: fresh host (docker answering, no gs-server): gs-preflight PASSES"; else bad "A: fresh host" "$(cat "$T/out")"; fi

# --- B: a server exists -----------------------------------------------------------------------------------------------
"$DOCKER" run -d --name gs-server "$IMAGE" sleep 600 >/dev/null
if preflight; then bad "B: preflight passed beside a RUNNING gs-server"; else grep -q "already running" "$T/out" && [ "$(state_of)" = running ] && ok "B: running gs-server -> REFUSED, the container untouched" || bad "B: running" "$(cat "$T/out")"; fi
"$DOCKER" pause gs-server >/dev/null
if preflight; then bad "B: preflight passed beside a PAUSED gs-server"; else grep -q "already paused" "$T/out" && [ "$(state_of)" = paused ] && ok "B: paused gs-server -> REFUSED, the container untouched" || bad "B: paused" "$(cat "$T/out")"; fi
"$DOCKER" unpause gs-server >/dev/null; "$DOCKER" rm -f gs-server >/dev/null
"$DOCKER" run -d --name gs-server --restart always "$IMAGE" sh -c 'exit 1' >/dev/null
for _ in $(seq 1 40); do [ "$(state_of)" = restarting ] && break; sleep 0.25; done
st="$(state_of)"
if preflight; then bad "B: preflight passed beside a restart-looping gs-server ($st)"; else grep -qE "already (restarting|running)" "$T/out" && [ -n "$(state_of)" ] && ok "B: restart-looping gs-server ($st) -> REFUSED, the container untouched" || bad "B: restarting" "$(cat "$T/out")"; fi
"$DOCKER" rm -f gs-server >/dev/null
v="$("$DOCKER" run -d --name gs-server "$IMAGE" sleep 600 >/dev/null; "$DOCKER" container rm gs-server 2>&1; printf 'rc=%s' "$?")"
[ "${v##*rc=}" != 0 ] && [ "$(state_of)" = running ] && ok "this daemon: docker container rm WITHOUT -f refuses a running container (the preflight's rm cannot remove a server)" || bad "rm of a running container" "$v"
"$DOCKER" rm -f gs-server >/dev/null

# --- C: a stopped leftover --------------------------------------------------------------------------------------------
"$DOCKER" run --name gs-server "$IMAGE" true >/dev/null
[ "$(state_of)" = exited ] && preflight && gone && grep -q "preflight passed" "$T/out" && ok "C: exited gs-server leftover -> removed, preflight passes" || bad "C: exited" "$(cat "$T/out")"
"$DOCKER" create --name gs-server "$IMAGE" true >/dev/null
[ "$(state_of)" = created ] && preflight && gone && ok "C: created (never started) gs-server -> removed, preflight passes" || bad "C: created" "$(cat "$T/out")"
"$DOCKER" create --name gs-rt-old "$IMAGE" true >/dev/null; "$DOCKER" run -d --name gs-rt-alt "$IMAGE" sleep 600 >/dev/null
preflight && [ -n "$("$DOCKER" container ls --all --quiet --filter 'name=^/?gs-rt-old$')" ] && ok "C: other containers (gs-rt-old, gs-rt-alt) are neither gs-server nor removed" || bad "C: other names" "$(cat "$T/out")"
"$DOCKER" rm -f gs-rt-old gs-rt-alt >/dev/null

# --- D: the daemon unreachable ----------------------------------------------------------------------------------------
if DOCKER_HOST=unix:///nonexistent/gs-rt.sock preflight; then bad "D: preflight PASSED with the daemon unreachable"; else
  grep -q "docker could not list containers" "$T/out" && ok "D: daemon unreachable -> REFUSED (never read as 'no container')" || bad "D: message" "$(cat "$T/out")"; fi

# --- E: newlines around the real CLI's stdout -------------------------------------------------------------------------
if PATH="$T/noisy:$PATH" preflight; then ok "E: missing container + blank lines around docker's stdout -> still absent (passes)"; else bad "E: missing + noise" "$(cat "$T/out")"; fi
if DOCKER_HOST=unix:///nonexistent/gs-rt.sock PATH="$T/noisy:$PATH" preflight; then bad "E: daemon down + noise passed"; else ok "E: daemon unreachable + blank lines around docker's stdout -> REFUSED"; fi
"$DOCKER" run -d --name gs-server "$IMAGE" sleep 600 >/dev/null
if PATH="$T/noisy:$PATH" preflight; then bad "E: a running gs-server + noise passed"; else [ "$(state_of)" = running ] && ok "E: running gs-server + blank lines -> REFUSED, untouched"; fi
"$DOCKER" rm -f gs-server >/dev/null; "$DOCKER" run --name gs-server "$IMAGE" true >/dev/null
if PATH="$T/noisy:$PATH" preflight; then bad "E: an exited gs-server read through noise passed"; else [ "$(state_of)" = exited ] && ok "E: exited gs-server + blank lines -> refused, NOT removed (an odd answer never removes)"; fi
"$DOCKER" rm -f gs-server >/dev/null

# --- the same question elsewhere: stop_server (gs-stop), running_digest / http_code (gs-health) -------------------------
"$BIN/gs-stop" >"$T/out" 2>&1 && grep -q "gs: stopped" "$T/out" && ok "gs-stop: docker answering, no gs-server -> stopped" || bad "gs-stop clean" "$(cat "$T/out")"
if DOCKER_HOST=unix:///nonexistent/gs-rt.sock "$BIN/gs-stop" >"$T/out" 2>&1; then bad "gs-stop reported stopped with the daemon unreachable"; else grep -q "NOT proven" "$T/out" && ok "gs-stop: daemon unreachable -> REFUSED (a docker failure never proves 'stopped')" || bad "gs-stop daemon down" "$(cat "$T/out")"; fi
"$DOCKER" run --name gs-server "$IMAGE" true >/dev/null
if "$BIN/gs-stop" >"$T/out" 2>&1; then bad "gs-stop reported stopped beside an exited gs-server"; else grep -q "still exists after the stop (exited" "$T/out" && ok "gs-stop: an exited gs-server left after the stop -> REFUSED (as before)" || bad "gs-stop leftover" "$(cat "$T/out")"; fi
"$DOCKER" rm -f gs-server >/dev/null
"$BIN/gs-health" >"$T/out" 2>&1
grep -q '"running_digest":"none"' "$T/out" && ok "gs-health: no gs-server -> running_digest none" || bad "gs-health none" "$(cat "$T/out")"
grep -q '"healthz":"000","readyz":"000","origin_tls_readyz":"000"' "$T/out" && ! grep -q 000000 "$T/out" && ok "gs-health: real curl, nothing listening -> 000 exactly (the old fallback read 000000)" || bad "gs-health 000" "$(cat "$T/out")"
DOCKER_HOST=unix:///nonexistent/gs-rt.sock "$BIN/gs-health" >"$T/out" 2>&1
grep -q '"running_digest":"unknown"' "$T/out" && ok "gs-health: daemon unreachable -> running_digest unknown (never 'none')" || bad "gs-health daemon down" "$(cat "$T/out")"

# --- gs-run: its exact argument vector, accepted by this daemon (created, never started) ------------------------------
cat >"$T/stubs/docker" <<EOF
#!/usr/bin/env bash
[ "\$1" = run ] && { shift; exec "$DOCKER" create "\$@"; }
exec "$DOCKER" "\$@"
EOF
chmod 0755 "$T/stubs/docker"
if "$BIN/gs-run" >"$T/out" 2>&1; then
  h="$("$DOCKER" container inspect -f '{{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config "mode"}} ro={{.HostConfig.ReadonlyRootfs}} init={{.HostConfig.Init}} rm={{.HostConfig.AutoRemove}} pids={{.HostConfig.PidsLimit}} mem={{.HostConfig.Memory}} cap={{.HostConfig.CapDrop}} sec={{.HostConfig.SecurityOpt}} user={{.Config.User}} stop={{.Config.StopTimeout}} ports={{json .HostConfig.PortBindings}} binds={{json .HostConfig.Binds}}' gs-server 2>&1)"
  want='awslogs non-blocking ro=true init=true rm=true pids=512 mem=1610612736 cap=[ALL] sec=[no-new-privileges] user=node stop=120 ports={"8917/tcp":[{"HostIp":"127.0.0.1","HostPort":"8917"}]} binds=["/opt/gs/measure:/opt/gs-measure:ro"]'
  [ "$h" = "$want" ] && ok "gs-run: this daemon accepts its exact docker arguments (awslogs non-blocking, 127.0.0.1 only, read-only, node, no caps, pids 512, 1536m, --measure mount)" || bad "gs-run HostConfig" "$h"
else bad "gs-run: the daemon refused its arguments" "$(cat "$T/out")"; fi
"$DOCKER" rm -f gs-server >/dev/null 2>&1

printf '\n%d passed, %d failed (docker CLI %s, daemon %s)\n' "$pass" "$fail" "$cli" "$server"
[ "$fail" = 0 ]
