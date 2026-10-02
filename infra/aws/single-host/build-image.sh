#!/usr/bin/env bash
# infra/aws/single-host/build-image.sh <ecr repository uri> <build-id> [platform] -- COST-1: build the game-server image
# from the repository root for the single host (default linux/arm64; linux/amd64 for a t3 host) and push it to the
# EXISTING ECR repository (immutable tags). Prints the DIGEST that gs-host deploy takes. Run from a clean checkout of the
# commit being released. Docker login to ECR first: aws ecr get-login-password | docker login --username AWS --password-stdin <registry>.
# Behind a TLS-inspecting proxy: BUILD_CA=<ca bundle> passes it to npm as a build secret. Needs git, docker buildx and
# node (the repository's own toolchain) to read the pushed digest from buildx's metadata file.
set -euo pipefail
die() { printf 'build-image: REFUSED: %s\n' "$*" >&2; exit 1; }
command -v node >/dev/null || die "node is required (it reads the pushed digest from the buildx metadata file)"
repo="${1:-}"; build="${2:-}"; platform="${3:-linux/arm64}"
[[ "$repo" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9._/-]+$ ]] || die "the ECR repository URI is required"
[[ "$build" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "a build id is required"
[[ "$platform" =~ ^linux/(arm64|amd64)$ ]] || die "platform must be linux/arm64 or linux/amd64"
root="$(git rev-parse --show-toplevel)"; cd "$root"
[ -z "$(git status --porcelain)" ] || die "the checkout has uncommitted changes (an image is built from a commit)"
secret=(); [ -n "${BUILD_CA:-}" ] && secret=(--secret "id=build_ca,src=$BUILD_CA")
meta="$(mktemp)"; trap 'rm -f "$meta"' EXIT
docker buildx build --platform "$platform" -f infra/docker/game-server.Dockerfile "${secret[@]}" \
  --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" -t "$repo:$build" --provenance=false --push \
  --metadata-file "$meta" .
# The digest of what was PUSHED under the tag (buildx's own record), never a child or layer digest.
digest="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))["containerimage.digest"] || ""))' "$meta")"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "could not read the pushed digest"
printf 'build-image: %s %s -> %s\n' "$platform" "$build" "$digest"
