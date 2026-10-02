#!/usr/bin/env bash
# infra/aws/modules/single-host/tests/image-smoke.sh <image> <linux/amd64|linux/arm64> -- COST-1: the game-server image
# for one platform (an arm64 image on an x86 machine runs under QEMU -- build and smoke validation only, not performance).
# Proves: the image metadata is that platform; Node reports that architecture and runs as `node`; the server starts and
# GET /gs/healthz answers 200 (read-only root, a tmpfs data directory, PROCESS mode); AWS mode, OFFLINE (no network),
# refuses a misspelt metric profile and static credentials before reading anything, and otherwise gets as far as the
# runtime document read and fails only on the intentionally absent live configuration (exit 2).
set -uo pipefail
IMAGE="${1:?image}"; PLATFORM="${2:?platform}"; ARCH="${PLATFORM#linux/}"
pass=0; fail=0
ok() { pass=$((pass + 1)); printf 'ok   [%s] %s\n' "$PLATFORM" "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL [%s] %s\n' "$PLATFORM" "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; }
name="gs-smoke-$ARCH"; trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

meta="$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$IMAGE")"
[ "$meta" = "$PLATFORM" ] && ok "image metadata is $meta" || bad "image metadata" "$meta"
want_arch="$([ "$ARCH" = amd64 ] && echo x64 || echo arm64)"
got="$(docker run --rm --platform "$PLATFORM" --entrypoint node "$IMAGE" -p 'process.arch + " " + process.version + " uid=" + process.getuid()')"
case "$got" in "$want_arch v22."*" uid=1000") ok "node: $got" ;; *) bad "node arch/user" "$got" ;; esac

# PROCESS mode (the image's default CMD, development identity: loopback only): the server starts and answers its liveness endpoint.
port=$((18000 + RANDOM % 1000))
docker run -d --name "$name" --platform "$PLATFORM" --network host --read-only --tmpfs /app/server/data:uid=1000,gid=1000 \
  -e GS_MODE=development -e PORT="$port" "$IMAGE" >/dev/null
code=000
for _ in $(seq 1 60); do code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/gs/healthz" || true)"; [ "$code" = 200 ] && break; sleep 2; done
[ "$code" = 200 ] && ok "the server starts; GET /gs/healthz -> 200 (read-only root)" || bad "healthz" "$code $(docker logs "$name" 2>&1 | tail -n 5)"
docker stop -t 30 "$name" >/dev/null; st="$(docker inspect -f '{{.State.ExitCode}}' "$name")"
[ "$st" = 0 ] && ok "SIGTERM -> graceful exit 0" || bad "graceful stop" "exit $st"
docker rm -f "$name" >/dev/null 2>&1

AWS_ENV=(-e GS_STORAGE=aws -e GS_MODE=production -e GS_AWS_CONFIG_PARAMETER=arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1
  -e GS_ALLOWED_ORIGINS=https://play.example.org -e GS_TRUSTED_PROXY_HOPS=2 -e BUILD_ID=smoke)
aws_run() { timeout 240 docker run --rm --platform "$PLATFORM" --network none --read-only "${AWS_ENV[@]}" "$@" "$IMAGE" 2>&1; }

out="$(aws_run -e GS_METRICS_PROFILE=bogus)"; st=$?
[ "$st" = 2 ] && grep -q "GS_METRICS_PROFILE must be" <<<"$out" && ok "AWS mode refuses a misspelt metric profile (exit 2, nothing read)" || bad "metrics profile refusal" "exit $st: $(tail -n 3 <<<"$out")"
out="$(aws_run -e GS_METRICS_PROFILE=single-host -e AWS_ACCESS_KEY_ID=AKIAEXAMPLEEXAMPLE00 -e AWS_SECRET_ACCESS_KEY=x)"; st=$?
[ "$st" = 2 ] && grep -q "AWS_ACCESS_KEY_ID" <<<"$out" && grep -qi "task role" <<<"$out" && ok "AWS mode refuses static credentials in the environment (exit 2)" || bad "static credential refusal" "exit $st: $(tail -n 3 <<<"$out")"
out="$(aws_run -e GS_METRICS_PROFILE=single-host)"; st=$?
[ "$st" = 2 ] && grep -q "the runtime configuration arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1 is not usable" <<<"$out" \
  && ok "AWS mode (single-host profile) starts and fails ONLY on the absent live runtime document (exit 2, offline)" || bad "offline AWS start" "exit $st: $(tail -n 3 <<<"$out")"

printf '[%s] %d passed, %d failed\n' "$PLATFORM" "$pass" "$fail"
[ "$fail" = 0 ]
