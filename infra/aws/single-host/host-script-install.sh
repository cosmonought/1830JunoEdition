#!/usr/bin/env bash
# infra/aws/single-host/host-script-install.sh <check|install> <name> <certified sha256> <replaced sha256> <received file>
#
# PHASE 1 FRESH-HOST HARDENING (SINGLE_HOST_MIGRATION.md 13r): the reviewed install of ONE certified host script on the
# EXISTING single host, so the host never has to be replaced to take a fixed script. Sent by `gs-host install-script`
# (never installed itself) with the script's exact bytes from the CERTIFIED commit (base64; the operator's side refuses a
# checkout whose bytes are not the SHA-256 the operator typed) and run as root over SSM. It changes exactly ONE file,
# /opt/gs/bin/<name>, and nothing else:
#   1. inspects the live file FIRST: a regular file (not a link), root:root, mode 755 -- what cloud-init wrote -- whose
#      SHA-256 is the one this install REPLACES (the host-create commit's bytes) or already the certified one;
#   2. refuses unless the game server is down (gs-server.service inactive or failed, and docker ANSWERS that no gs-server
#      container exists) and no gs-deploy / gs-rollback / gs-stop runs: their lock is held for the whole install;
#   3. writes the received bytes to a temporary file BESIDE the target (same filesystem), root:root 755;
#   4. verifies it BEFORE installing: its SHA-256 = the certified one, and `bash -n`;
#   5. renames it over the target (rename(2): atomic -- a reader sees the whole old file or the whole new one, and a
#      running script keeps the file it opened), flushes, and verifies the installed SHA-256, owner and mode.
# `check` stops after the verification of the received bytes and writes NOTHING (not even a temporary file). A live file
# that already has the certified bytes is left untouched (result=unchanged). It never starts, stops, enables or disables a
# unit, never touches the HOLD, a release file, a container or any other path. The names it accepts are exactly the
# scripts the fresh-host hardening changed. Every exit is framed: GS-HOST-INSTALL BEGIN / key=value / END exit=<n>.
set -uo pipefail
mode="${1:-}"; name="${2:-}"; want="${3:-}"; replaces="${4:-}"; received="${5:-}"
printf 'GS-HOST-INSTALL BEGIN\n'
framed=0; tmp=""
end() { framed=1; [ -z "$tmp" ] || rm -f "$tmp"; printf 'GS-HOST-INSTALL END exit=%s\n' "$1"; exit "$1"; }
refuse() { printf 'refused=%s\n' "$2"; end "$1"; }
# shellcheck disable=SC2154 # rc is assigned inside the trap's own text
trap 'rc=$?; if [ "$framed" = 0 ]; then [ -z "$tmp" ] || rm -f "$tmp"; printf "refused=an unexpected host-side failure (see stderr)\nGS-HOST-INSTALL END exit=%s\n" "$rc"; fi' EXIT
case "$mode" in check | install) ;; *) refuse 2 "usage: host-script-install.sh <check|install> <name> <certified sha256> <replaced sha256> <received file>" ;; esac
case "$name" in gs-preflight | gs-lib.sh | gs-health) ;; *) refuse 2 "only gs-preflight, gs-lib.sh or gs-health is installed this way" ;; esac
[[ "$want" =~ ^[0-9a-f]{64}$ ]] && [[ "$replaces" =~ ^[0-9a-f]{64}$ ]] || refuse 2 "each SHA-256 must be 64 lower-case hex digits"
[ -f "$received" ] && [ -r "$received" ] || refuse 2 "the received file is missing"
printf 'mode=%s\nname=%s\ncertified_sha256=%s\nreplaces_sha256=%s\n' "$mode" "$name" "$want" "$replaces"

bin=/opt/gs/bin; lock=/run/gs-deploy.lock; owner=root:root
if [ -n "${GS_TEST:-}" ]; then bin="${GS_TEST_BIN:?}"; lock="${GS_TEST_LOCK:?}"; owner="$(id -un):$(id -gn)"; fi
[ "$(id -u)" = 0 ] || [ -n "${GS_TEST:-}" ] || refuse 91 "run as root"
target="$bin/$name"
printf 'target=%s\n' "$target"
sha() { sha256sum "$1" | cut -c1-64; }

# 1. The live file, inspected first.
[ -f "$target" ] && [ ! -L "$target" ] || refuse 91 "$target is not a regular file (not a COST-1 host?)"
live="$(stat -c '%U:%G %a' "$target")" || refuse 91 "$target cannot be inspected"
printf 'live_owner=%s\nlive_mode=%s\nlive_sha256=%s\n' "${live% *}" "${live#* }" "$(sha "$target")"
[ "$live" = "$owner 755" ] || refuse 91 "$target is ${live}, not $owner 755 (what cloud-init wrote): investigate first"
case "$(sha "$target")" in "$replaces" | "$want") ;; *) refuse 91 "$target is neither the bytes this install replaces nor the certified ones: investigate first" ;; esac

# 2. The game server is down, and no deploy / rollback / stop runs (their lock, held from here to the end).
exec 9>"$lock" && flock -n 9 || refuse 90 "a gs-deploy / gs-rollback / gs-stop is running"
state="$(systemctl is-active gs-server.service 2>/dev/null || true)"
printf 'server_state=%s\n' "${state:-unknown}"
case "$state" in inactive | failed) ;; *) refuse 90 "gs-server.service is '${state:-unknown}': install only while the game server is down" ;; esac
containers="$(docker container ls --all --filter 'name=^/?gs-server$' --format '{{.State}}')" || refuse 92 "docker could not list containers: the server is not proven down"
printf 'gs_server_container=%s\n' "${containers:-none}"
[ -z "$containers" ] || refuse 90 "a gs-server container exists ($containers): install only while the game server is down"

# 3-4. The received bytes, verified before anything is installed.
got="$(sha "$received")"
printf 'received_sha256=%s\n' "$got"
[ "$got" = "$want" ] || refuse 93 "the received bytes are not the certified ones"
bash -n "$received" || refuse 94 "the received script does not parse (bash -n)"
printf 'syntax=ok\n'
if [ "$(sha "$target")" = "$want" ]; then printf 'result=unchanged (the live file already has the certified bytes)\n'; end 0; fi
if [ "$mode" = check ]; then printf 'result=checked (nothing was written)\n'; end 0; fi

tmp="$(mktemp "$bin/.$name.install.XXXXXX")" || refuse 95 "no temporary file beside $target"
cat "$received" >"$tmp" && chown "$owner" "$tmp" && chmod 0755 "$tmp" || refuse 95 "the temporary file could not be written"
[ "$(sha "$tmp")" = "$want" ] && [ "$(stat -c '%U:%G %a' "$tmp")" = "$owner 755" ] || refuse 95 "the temporary file is not the certified bytes, $owner 755"
bash -n "$tmp" || refuse 94 "the staged script does not parse (bash -n)"

# 5. One atomic rename, flushed, then verified.
mv -f -T "$tmp" "$target" || refuse 95 "the rename over $target failed (the live file is unchanged)"
tmp=""
sync -f "$target" 2>/dev/null || sync
now="$(stat -c '%U:%G %a' "$target")"
printf 'installed_sha256=%s\ninstalled_owner=%s\ninstalled_mode=%s\n' "$(sha "$target")" "${now% *}" "${now#* }"
[ "$(sha "$target")" = "$want" ] && [ "$now" = "$owner 755" ] || refuse 96 "the installed file does not verify: investigate before any start"
printf 'result=installed\n'
end 0
