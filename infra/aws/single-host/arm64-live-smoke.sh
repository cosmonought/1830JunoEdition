#!/usr/bin/env bash
# infra/aws/single-host/arm64-live-smoke.sh <sha256:digest> <image-smoke.sh path> -- OWNER-GATE FIX 1: the REQUIRED live
# ARM64 runtime smoke, run ON the real Graviton single host (sent by `gs-host arm64-smoke`, never installed). The owner's
# workstation cannot execute linux/arm64 (no emulation), so the owner SOURCE gate proves only the arm64 BUILD and its
# architecture; the EXECUTION proof happens here, on the target architecture, BEFORE any CloudFront / edge cutover
# (SINGLE_HOST_MIGRATION.md step 12b; `migration-guard edge-cutover` refuses without this run's PASSING output).
#
# It runs the repository's UNCHANGED infra/aws/modules/single-host/tests/image-smoke.sh against the release image pulled
# BY DIGEST: image metadata linux/arm64, Node arm64 as `node`, PROCESS mode healthz 200 on a loopback port, SIGTERM exit 0,
# and AWS mode OFFLINE (--network none: no AWS call, no authority touched). It refuses while the game server runs (the
# slot is after the push, before deploy: no second process beside a serving one) and takes the deploy lock (no racing
# gs-deploy). Every outcome is framed (GS-ARM64-LIVE-SMOKE BEGIN / END exit=<n>) so the judge can tell a complete run
# from a truncated one; anything not proven is NOT EVALUATED, never PASS.
set -uo pipefail
digest="${1:-}"; smoke="${2:-}"
printf 'GS-ARM64-LIVE-SMOKE BEGIN\n'
framed=0
end() { framed=1; printf 'GS-ARM64-LIVE-SMOKE END exit=%s\n' "$1"; exit "$1"; }
# Every exit is framed: a gs-lib refusal (`die` -> exit 1, message on stderr) still prints `refused=` and END, so the judge
# reads it as a FAIL (a STOP), never as a truncated NOT EVALUATED run.
trap 'rc=$?; if [ "$framed" = 0 ]; then printf "refused=a host-side refusal (see the command'"'"'s stderr)\nGS-ARM64-LIVE-SMOKE END exit=%s\n" "$rc"; fi' EXIT
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { printf 'refused=usage: arm64-live-smoke.sh <sha256:64-hex digest> <image-smoke.sh>\n'; end 2; }
[ -r "$smoke" ] || { printf 'refused=the smoke script is missing\n'; end 2; }
printf 'digest=%s\n' "$digest"
printf 'host_arch=%s\n' "$(uname -m)"
token="$(curl -fsS -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
itype="unknown"; iid="unknown"
if [ -n "$token" ]; then
  itype="$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/instance-type 2>/dev/null || printf unknown)"
  iid="$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || printf unknown)"
fi
unset token
printf 'instance_type=%s\ninstance_id=%s\n' "$itype" "$iid"
printf 'smoke_script_sha256=%s\n' "$(sha256sum "$smoke" | cut -c1-64)"
[ -r /opt/gs/bin/gs-lib.sh ] || { printf 'refused=gs-lib.sh is missing (not a COST-1 host)\n'; end 91; }
# shellcheck source=/dev/null
source /opt/gs/bin/gs-lib.sh
set +e # gs-lib turns errexit on; every status below is checked explicitly and ends framed
require_root
load_env_file "$GS_ETC/host.env"
take_lock
# under the deploy lock: no gs-deploy can start the server between this check and the smoke
if systemctl is-active --quiet gs-server.service; then
  printf 'refused=the game server is running: the live ARM64 smoke runs after the push and BEFORE deploy (step 12b)\n'
  end 90
fi
( pull_release "$digest" ) >&2 || { printf 'refused=the pull by digest failed (or the image is not this host'"'"'s architecture)\n'; end 91; }
ref="$(image_ref "$digest")"
printf 'image=%s\n' "$ref"
printf 'image_platform=%s\n' "$(image_platform "$ref")"
rc=0
bash "$smoke" "$ref" linux/arm64 || rc=$?
end "$rc"
