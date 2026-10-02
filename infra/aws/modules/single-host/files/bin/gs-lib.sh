#!/usr/bin/env bash
# /opt/gs/bin/gs-lib.sh -- COST-1: shared by the single host's scripts (sourced, never run).
# Every check FAILS CLOSED: `die` exits non-zero and the caller stops. Nothing here prints a secret (there is none on the
# host: the instance role is the only credential source) -- only digests, build ids, states and HTTP status codes.
set -euo pipefail
umask 027

GS_ETC="${GS_ETC:-/etc/gs}"
GS_IMDS="${GS_IMDS:-http://169.254.169.254}"
GS_LOCK="${GS_LOCK:-/run/gs-deploy.lock}"
GS_STATE_DIR="${GS_STATE_DIR:-/var/lib/gs}"
DIGEST_RE='^sha256:[0-9a-f]{64}$'
BUILD_RE='^[A-Za-z0-9._-]{1,128}$'

say() { printf 'gs: %s\n' "$*"; }
die() { printf 'gs: REFUSED: %s\n' "$*" >&2; exit 1; }

# KEY=VALUE files, parsed (never sourced or eval'd): a malformed line refuses.
load_env_file() {
  local file="$1" line
  [ -r "$file" ] || die "$file is missing or unreadable"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || die "$file: a malformed line"
    export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
  done <"$file"
}

require_root() { [ "$(id -u)" = 0 ] || [ -n "${GS_TEST:-}" ] || die "run as root (sudo)"; }

valid_digest() { [[ "${1:-}" =~ $DIGEST_RE ]]; }
valid_build() { [[ "${1:-}" =~ $BUILD_RE ]]; }

image_ref() { printf '%s/%s@%s' "$GS_ECR_REGISTRY" "$GS_ECR_REPOSITORY" "$1"; }

# One deploy / rollback / stop at a time (a second one refuses instead of racing).
take_lock() {
  exec 9>"$GS_LOCK"
  flock -n 9 || die "another gs-deploy / gs-rollback / gs-stop is running"
}

imds_token() { curl -fsS -m 3 -X PUT "$GS_IMDS/latest/api/token" -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'; }
imds_get() { curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $1" "$GS_IMDS/latest/meta-data/$2"; }

http_code() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || printf '000'; }

server_url() { printf 'http://127.0.0.1:%s' "${GS_CONTAINER_PORT:-8917}"; }

image_platform() { docker image inspect -f '{{.Os}}/{{.Architecture}}' "$1" 2>/dev/null; }

# Pull a release image by digest and prove it is this host's architecture. Nothing is stopped by this.
pull_release() {
  local digest="$1" ref platform
  ref="$(image_ref "$digest")"
  say "pulling $GS_ECR_REPOSITORY@$digest (the ECR credential helper uses the instance role)"
  docker pull --quiet "$ref" >/dev/null || die "the pull of $digest failed (nothing was stopped)"
  platform="$(image_platform "$ref")" || die "the pulled image cannot be inspected"
  [ "$platform" = "linux/$GS_ARCH" ] || die "the image is $platform; this host is linux/$GS_ARCH (nothing was stopped)"
}

# Drain: SIGTERM through systemd (the runtime's graceful shutdown, <= 120 s), then prove no server is left. `systemctl stop`
# is ALWAYS sent: it also cancels a start in progress (the preflight) or a pending auto-restart, which `is-active` would
# not report as active -- a "stopped" answer must mean stopped.
stop_server() {
  local state
  say "draining: SIGTERM -> graceful shutdown (readiness 503 first; at most 120 s); any pending restart is cancelled"
  systemctl stop gs-server.service
  state="$(systemctl is-active gs-server.service 2>/dev/null || true)"
  case "$state" in inactive | failed) ;; *) die "gs-server.service is still '$state' after the stop" ;; esac
  if docker container inspect gs-server >/dev/null 2>&1; then
    die "a gs-server container still exists after the stop (inspect it; nothing else was changed)"
  fi
  say "stopped (the last run exited with status $(systemctl show -p ExecMainStatus --value gs-server.service 2>/dev/null || printf '?'))"
}

# The HOLD (gs-exit-hold): after a proven loss (exit 3) or a role change (exit 5) the server waits for the operator --
# across reboots too. Only an explicit gs-deploy / gs-rollback clears it.
hold_file() { printf '%s/hold' "$GS_STATE_DIR"; }
clear_hold() {
  if [ -e "$(hold_file)" ]; then
    say "clearing the HOLD ($(cat "$(hold_file)" 2>/dev/null || true)) -- an explicit operator action"
    rm -f "$(hold_file)"
  fi
}

# Readiness: /gs/readyz 200. `wait_ready SECONDS` polls; non-zero when it never became ready.
wait_ready() {
  local deadline=$(($(date +%s) + ${1:-0})) code
  while :; do
    code="$(http_code "$(server_url)/gs/readyz")"
    [ "$code" = 200 ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep "${GS_POLL_SECONDS:-3}"
  done
}

write_release() { # file digest build measure
  local tmp="$1.tmp"
  printf 'GS_IMAGE_DIGEST=%s\nBUILD_ID=%s\nGS_MEASURE=%s\n' "$2" "$3" "$4" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$1"
}

# COST-2A: which static AWS credential SOURCES are present on the host -- their NAMES only, never a value: "none", or a
# comma list (an env file's variable names; `aws-credentials-file` for a shared credentials file). The instance role is
# the only credential source; gs-preflight refuses a start with one in the env files, gs-health reports it as evidence.
GS_CREDENTIAL_NAMES_RE='^[[:space:]]*(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_PROFILE|AWS_SHARED_CREDENTIALS_FILE|AWS_CONFIG_FILE|AWS_WEB_IDENTITY_TOKEN_FILE|AWS_CONTAINER_CREDENTIALS_FULL_URI)='
static_credentials() {
  local found="" file name
  for file in "$GS_ETC/server.env" "$GS_ETC/host.env" "$GS_ETC/release.env"; do
    [ -r "$file" ] || continue
    for name in $(grep -Eo "$GS_CREDENTIAL_NAMES_RE" "$file" 2>/dev/null | tr -d '=[:space:]'); do
      case ",$found," in *",$name,"*) ;; *) found="${found:+$found,}$name" ;; esac
    done
  done
  [ -e "${GS_ROOT_AWS_DIR:-/root/.aws}/credentials" ] && found="${found:+$found,}aws-credentials-file"
  printf '%s' "${found:-none}"
}

# COST-2A: the digest the RUNNING gs-server container was started from (its image's repository digest in this host's ECR
# repository), "none" when no container runs, "unknown" when the image names no such digest.
running_digest() {
  local image digest
  image="$(docker container inspect -f '{{.Image}}' gs-server 2>/dev/null)" || { printf 'none'; return 0; }
  [ -n "$image" ] || { printf 'none'; return 0; }
  digest="$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$image" 2>/dev/null | grep -E "^${GS_ECR_REGISTRY}/${GS_ECR_REPOSITORY}@sha256:[0-9a-f]{64}$" | head -n 1)" || true
  if [ -n "$digest" ]; then printf '%s' "${digest##*@}"; else printf 'unknown'; fi
}

release_field() { # file key
  local value
  value="$(grep -E "^$2=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2-)" || true
  printf '%s' "$value"
}
