#!/usr/bin/env bash
# Escrow wasm compatibility gate (ESCROW-2.3).
#
# CosmWasm VM 2.2.9 / 3.0.9 (wasmvm v2.2.8 / v3.0.7) refuse to store a contract
# with a function that declares more than 100 locals. This gate keeps a margin:
#
#   1. build with the official optimizer (Docker, from the repository root),
#      unless an artifact path is given;
#   2. fail if any function declares more than MAX_LOCALS (default 90) locals;
#   3. run every checker in COSMWASM_CHECK (space-separated binaries, default
#      `cosmwasm-check` on PATH); each must pass, and at least one must be
#      >= 2.2.9 on the 2.x line or >= 3.0.9 on the 3.x line (the versions that
#      enforce the limit) unless WASM_GATE_ALLOW_OLD_CHECKER=1.
#
# Usage:
#   contracts/escrow/scripts/wasm-gate.sh                      # optimizer build
#   contracts/escrow/scripts/wasm-gate.sh path/to/escrow.wasm   # existing artifact
#   COSMWASM_CHECK="cosmwasm-check-1.5.11 cosmwasm-check-2.2.9 cosmwasm-check-3.0.5 cosmwasm-check-3.0.9" \
#     contracts/escrow/scripts/wasm-gate.sh artifacts/eighteen_cosmos_escrow.wasm
#
# Outputs stay out of git: `artifacts/*.wasm` matches the `**/*.wasm` ignore rule.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
max="${MAX_LOCALS:-90}"
optimizer="${OPTIMIZER_IMAGE:-cosmwasm/optimizer:0.16.1}"
artifact="${1:-}"

if [ -z "$artifact" ]; then
  command -v docker >/dev/null || { echo "docker not found; pass an artifact path" >&2; exit 2; }
  docker run --rm -v "$root":/code \
    --mount type=volume,source="$(basename "$root")_cache",target=/target \
    --mount type=volume,source=registry_cache,target=/usr/local/cargo/registry \
    "$optimizer"
  echo "optimizer image: $(docker image inspect --format '{{index .RepoDigests 0}}' "$optimizer")"
  artifact="$root/artifacts/eighteen_cosmos_escrow.wasm"
fi
[ -f "$artifact" ] || { echo "no artifact at $artifact" >&2; exit 2; }

echo "artifact: $artifact ($(wc -c < "$artifact") bytes)"
sha256sum "$artifact"
python3 "$here/wasm_locals.py" "$artifact" --max "$max" --top 10

# $1 >= $2 as versions
ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]; }

strict=0
for checker in ${COSMWASM_CHECK:-cosmwasm-check}; do
  version="$("$checker" --version | awk '{print $NF}')"
  echo "== $checker ($version)"
  "$checker" "$artifact"
  case "$version" in
    2.*) if ge "$version" 2.2.9; then strict=1; fi ;;
    3.*) if ge "$version" 3.0.9; then strict=1; fi ;;
    1.*) ;;
    *) strict=1 ;;
  esac
done
if [ "$strict" != 1 ] && [ "${WASM_GATE_ALLOW_OLD_CHECKER:-0}" != 1 ]; then
  echo "FAIL: no cosmwasm-check >= 2.2.9 / 3.0.9 ran; those enforce the 100-locals limit" >&2
  exit 1
fi
echo "wasm gate: PASS"
