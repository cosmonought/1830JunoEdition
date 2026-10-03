#!/usr/bin/env bash
# infra/aws/single-host/host-role-probe.sh <sha256:digest> <run id> <kms|transactions> <generation> <pool>
#
# PHASE 1 REMAINDER (SINGLE_HOST_MIGRATION.md F5 / F6): the L6-6 task-role probe -- UNCHANGED, the release image's own
# `awsDeploy stage-probe task-role` -- run ON the real single host, under the HOST INSTANCE ROLE, from the SERVING release
# image by digest. Sent by `gs-host role-probe` (never installed; nothing in modules/single-host changes), judged OFFLINE
# by `awsDeploy stage-probe host-role` from the saved output.
#
#   kms           F5: the IAM probe (impossible-condition writes: nothing can be written) and the KMS probe -- GetPublicKey
#                 of the three configured keys, checkSignerIdentities, then Signs of DISPOSABLE domain-separated digests
#                 through the production digest-only ECDSA_SHA_256 binding, each timed (< 3 s each) and verified again
#   transactions  F6: the same, plus --disposable-writes L6CERT#<run>: the transaction probe writes and deletes ONLY that
#                 game-table partition (no production path reads it), then reads it back empty
#
# What it refuses (each framed, never a partial run): an argument that is not exactly its shape; not root; a prod*
# environment; the game server not active; a HOLD; any static AWS credential source on the host; a digest that is not
# BOTH the release file's and the RUNNING container's; the image absent locally or not this host's architecture; another
# deploy / rollback / stop in progress (the deploy lock is held for the whole probe); a leftover probe container. The
# probe container is NOT the server: GS_STORAGE is overridden to a value the server refuses (exit 2), its command is the
# probe, it publishes no port, it is not under systemd, its root filesystem is read-only, it runs as `node` with no
# capabilities, and it receives ONLY GS_STORAGE, the runtime document's ARN and BUILD_ID -- no env file, no credential:
# the AWS SDK's default chain reaches the instance role through IMDSv2 (hop limit 2), exactly as the server's does.
#
# OUTPUT (stdout, for the SSM invocation and the operator's Tee): GS-HOST-ROLE-PROBE BEGIN / key=value facts / the probe's
# OWN record lines (L6CERT/v1, SHA-256 chained: a truncated capture cannot be reassembled) / END exit=<n>. Identifiers
# and states only -- the IMDS credential document is never read (only the role's NAME, from the listing), no env file is
# printed, and the probe refuses to print a record that carries anything secret-shaped.
set -uo pipefail
digest="${1:-}"; run="${2:-}"; probe="${3:-}"; generation="${4:-}"; pool="${5:-}"
printf 'GS-HOST-ROLE-PROBE BEGIN\n'
framed=0
end() { framed=1; printf 'GS-HOST-ROLE-PROBE END exit=%s\n' "$1"; exit "$1"; }
refuse() { printf 'refused=%s\n' "$2"; end "$1"; }
# Every exit is framed: a gs-lib refusal (`die` -> exit 1, message on stderr) still prints `refused=` and END.
trap 'rc=$?; if [ "$framed" = 0 ]; then printf "refused=a host-side refusal (see the command'"'"'s stderr)\nGS-HOST-ROLE-PROBE END exit=%s\n" "$rc"; fi' EXIT
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || refuse 2 "usage: host-role-probe.sh <sha256:64-hex digest> <run id> <kms|transactions> <generation> <pool>"
[[ "$run" =~ ^[a-z0-9][a-z0-9-]{5,39}$ ]] || refuse 2 "the run id must match ^[a-z0-9][a-z0-9-]{5,39}\$"
case "$probe" in kms | transactions) ;; *) refuse 2 "the probe is kms (F5) or transactions (F6)" ;; esac
[[ "$generation" =~ ^[1-9][0-9]{0,3}$ ]] || refuse 2 "the generation is a positive whole number"
[[ "$pool" =~ ^[a-z][a-z0-9-]{0,15}$ ]] || refuse 2 "the pool must match ^[a-z][a-z0-9-]{0,15}\$"
printf 'probe=%s\nrun_id=%s\ndigest=%s\ngeneration=%s\npool=%s\n' "$probe" "$run" "$digest" "$generation" "$pool"
printf 'wrapper_sha256=%s\n' "$(sha256sum "$0" | cut -c1-64)"

lib=/opt/gs/bin/gs-lib.sh
if [ -n "${GS_TEST:-}" ]; then lib="${GS_TEST_LIB:-}"; fi # the offline test's copy of the SAME reviewed library
[ -r "$lib" ] || refuse 91 "gs-lib.sh is missing (not a COST-1 host)"
# shellcheck source=/dev/null
source "$lib"
set +e # gs-lib turns errexit on; every status below is checked explicitly and ends framed
require_root
load_env_file "$GS_ETC/host.env"
[[ "${GS_ENVIRONMENT:-}" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || refuse 91 "host.env: GS_ENVIRONMENT invalid"
case "$GS_ENVIRONMENT" in prod*) refuse 92 "the host-role probe never runs in a prod* environment" ;; esac
printf 'environment=%s\n' "$GS_ENVIRONMENT"
# server.env and release.env are PARSED for two fields each (never sourced, never passed to the container as a file).
runtime="$(release_field "$GS_ETC/server.env" GS_AWS_CONFIG_PARAMETER)"
[[ "$runtime" =~ ^arn:aws[a-z-]*:ssm:[a-z0-9-]+:[0-9]{12}:parameter/[A-Za-z0-9/_.-]{1,512}$ ]] || refuse 91 "server.env: GS_AWS_CONFIG_PARAMETER is not an SSM parameter ARN"
release="$(release_field "$GS_ETC/release.env" GS_IMAGE_DIGEST)"
build="$(release_field "$GS_ETC/release.env" BUILD_ID)"
valid_build "$build" || refuse 91 "release.env: BUILD_ID invalid"
printf 'runtime_parameter=%s\nbuild_id=%s\n' "$runtime" "$build"

take_lock # no gs-deploy / gs-rollback / gs-stop can change the release while the probe runs
state="$(systemctl is-active gs-server.service 2>/dev/null || true)"
printf 'server_state=%s\n' "${state:-unknown}"
[ "$state" = active ] || refuse 93 "the game server is not active: F5 / F6 probe the SERVING release (after step 13)"
if [ -e "$(hold_file)" ]; then printf 'hold=present\n'; refuse 93 "a HOLD is present: the host is not serving normally"; fi
printf 'hold=none\n'
credentials="$(static_credentials)"
printf 'static_credentials=%s\n' "$credentials"
[ "$credentials" = none ] || refuse 93 "a static AWS credential source is on the host: the probe would not be the instance role's"
running="$(running_digest)"
printf 'release_digest=%s\nrunning_digest=%s\n' "${release:-none}" "$running"
[ "$release" = "$digest" ] && [ "$running" = "$digest" ] || refuse 94 "the digest is not the serving release (release.env and the running container must both be it)"
ref="$(image_ref "$digest")"
platform="$(image_platform "$ref")" || refuse 94 "the serving image is not present locally (nothing is pulled here)"
printf 'image=%s\nimage_platform=%s\n' "$ref" "$platform"
[ "$platform" = "linux/$GS_ARCH" ] || refuse 94 "the image is $platform; this host is linux/$GS_ARCH"

# The instance and its role, from IMDSv2: the role's NAME only (the listing); the credential document is never fetched.
token="$(imds_token 2>/dev/null || true)"
iid="unknown"; profile="unknown"; role="unknown"
if [ -n "$token" ]; then
  iid="$(imds_get "$token" instance-id 2>/dev/null || printf unknown)"
  profile="$(imds_get "$token" iam/info 2>/dev/null | grep -Eo '"InstanceProfileArn"[[:space:]]*:[[:space:]]*"arn:[^"]+"' | grep -Eo 'arn:[^"]+' || printf unknown)"
  role="$(imds_get "$token" iam/security-credentials/ 2>/dev/null | head -n 1 | tr -cd 'A-Za-z0-9+=,.@_-' || printf unknown)"
fi
unset token
printf 'instance_id=%s\ninstance_profile=%s\ninstance_role=%s\n' "$iid" "${profile:-unknown}" "${role:-unknown}"
[ "$role" = "gs-$GS_ENVIRONMENT-host-app" ] || refuse 95 "the instance role is ${role:-unknown}, not gs-$GS_ENVIRONMENT-host-app"

name="gs-role-probe-$run"
# Any earlier probe container still present (this run's or another's: an interrupted probe) is refused, never reused.
others="$(docker ps -a --filter name=gs-role-probe- --format '{{.Names}}' 2>/dev/null | head -n 5 | tr '\n' ' ' | sed 's/ *$//')"
if [ -n "${others// /}" ] || docker container inspect "$name" >/dev/null 2>&1; then refuse 96 "a probe container already exists (${others:-$name}; an interrupted probe): inspect and remove it; nothing was started"; fi
# Memory: the probe is capped at 384 MiB beside a server capped at GS_SERVER_MEMORY on a small host. Refused unless the host
# has room for the whole cap and a margin, so the probe can never push the kernel to OOM-kill the serving process.
meminfo=/proc/meminfo
if [ -n "${GS_TEST:-}" ]; then meminfo="${GS_TEST_MEMINFO:-/proc/meminfo}"; fi
avail_kb="$(awk '/^MemAvailable:/ { print $2 }' "$meminfo" 2>/dev/null)"
printf 'mem_available_kb=%s\n' "${avail_kb:-unknown}"
[[ "${avail_kb:-}" =~ ^[0-9]+$ ]] && [ "$avail_kb" -ge 655360 ] || refuse 99 "MemAvailable is ${avail_kb:-unknown} kB: below 640 MiB, the probe (capped at 384 MiB) could pressure the serving process"
# A probe the SSM timeout (or an operator) interrupts must not outlive this run: its container is removed on the way out.
cleanup_probe() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap 'cleanup_probe; printf "refused=interrupted (the probe container was removed)\nGS-HOST-ROLE-PROBE END exit=143\n"; framed=1; exit 143' TERM INT HUP
writes=()
[ "$probe" = transactions ] && writes=(--disposable-writes "L6CERT#$run")
work="$(mktemp -d)" || refuse 97 "no temporary directory"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
timeout --kill-after=30 600 docker run --rm --name "$name" --init --read-only --user node --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 \
  --memory 384m --log-driver none \
  -e GS_STORAGE=l6-6-probe-not-a-server -e "GS_AWS_CONFIG_PARAMETER=$runtime" -e "BUILD_ID=$build" \
  "$ref" node dist/server/src/tools/awsDeploy.js stage-probe task-role --run-id "$run" --runtime-parameter "$runtime" \
  --environment "$GS_ENVIRONMENT" --generation "$generation" --pool "$pool" --kms-samples 5 "${writes[@]}" \
  >"$work/out" 2>"$work/err"
rc=$?
printf 'probe_started_at=%s\nprobe_finished_at=%s\nprobe_exit=%s\n' "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc"
if docker container inspect "$name" >/dev/null 2>&1; then printf 'probe_container_left=present\n'; cleanup_probe; else printf 'probe_container_left=none\n'; fi
trap - TERM INT HUP
# The probe's own status lines (short), then its record. The image prints the record as base64 chunks of up to 6 000
# characters (one SHA-256 over the whole); it is RE-FOLDED here into short lines of the SAME format (the chunks are
# slices of one base64 string, so any slicing reassembles to the same bytes and the same SHA-256) -- a console or Tee that
# wraps long lines cannot corrupt it unnoticed. SSM keeps 24 000 characters of output: the facts (~1.5 KB), at most 10
# status lines of 200 characters and a record of at most 15 000 bytes fit with room to spare; a larger record is refused
# (never truncated).
grep -v '^L6CERT/v1 ' "$work/out" | head -n 10 | cut -c1-200 | sed 's/^/probe_out=/'
tail -n 20 "$work/err" | cut -c1-300 >&2
grep '^L6CERT/v1 ' "$work/out" >"$work/rec"
lines="$(wc -l <"$work/rec" | tr -d ' ')"
if [ "$lines" -gt 0 ]; then
  digests="$(awk '{print $3}' "$work/rec" | sort -u)"
  ordered="$(awk -v n="$lines" '{ if ($2 != NR "/" n) bad = 1 } END { print bad ? "no" : "yes" }' "$work/rec")"
  if [ "$(printf '%s\n' "$digests" | wc -l | tr -d ' ')" != 1 ] || ! [[ "$digests" =~ ^[0-9a-f]{64}$ ]] || [ "$ordered" != yes ]; then
    rm -rf "$work"; refuse 98 "the probe's record lines are not one complete record (in order, one SHA-256)"
  fi
  awk '{printf "%s", $4}' "$work/rec" | fold -w 512 >"$work/folded"
  printf '\n' >>"$work/folded"
  sed -i '/^$/d' "$work/folded"
  pieces="$(wc -l <"$work/folded" | tr -d ' ')"
  awk -v d="$digests" -v m="$pieces" '{ printf "L6CERT/v1 %d/%d %s %s\n", NR, m, d, $0 }' "$work/folded" >"$work/print"
else
  : >"$work/print"
fi
bytes="$(wc -c <"$work/print" | tr -d ' ')"
printf 'record_lines=%s\nrecord_bytes=%s\n' "$(wc -l <"$work/print" | tr -d ' ')" "$bytes"
if [ "$bytes" -gt 15000 ]; then rm -rf "$work"; refuse 98 "the probe's record ($bytes bytes) exceeds the SSM output budget: nothing is truncated (lower --kms-samples in a reviewed change)"; fi
cat "$work/print"
rm -rf "$work"
[ "$rc" = 0 ] || end "$rc"
end 0
