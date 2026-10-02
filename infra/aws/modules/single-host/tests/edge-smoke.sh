#!/usr/bin/env bash
# infra/aws/modules/single-host/tests/edge-smoke.sh -- COST-1: the REAL Caddy image and the REAL Caddyfile template, run
# with the gs-caddy.service flags (unprivileged uid 2001, only NET_BIND_SERVICE, read-only root, host network), in front
# of a stand-in upstream on 127.0.0.1:8917. Proves: TLS origin, /gs and /gs/* proxied with path, query, Origin and Cookie
# unchanged, X-Forwarded-For APPENDED (2 hops), WebSocket upgrade, readiness-driven 503, non-/gs 404, port 80 never
# proxies. Test-only difference: the site uses Caddy's internal CA (`tls internal`) because Let's Encrypt is unreachable
# offline. Needs Docker (host networking, ports 80/443 free). Usage: bash tests/edge-smoke.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; MOD="$HERE/.."
CADDY="${CADDY_IMAGE:-$(sed -n 's/.*default *= *"\(public.ecr.aws\/docker\/library\/caddy[^"]*\)".*/\1/p' "$MOD/variables.tf" | head -n 1)}"
NODE="${NODE_IMAGE:-public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c}"
W="$(mktemp -d)"; trap 'docker rm -f gs-edge-caddy gs-edge-upstream >/dev/null 2>&1 || true; rm -rf "$W"' EXIT
# Render the template exactly as Terraform would (origin_hostname, no acme_email, container_port 8917) ...
sed -e 's/${origin_hostname}/gs-origin.test/g' -e 's/${container_port}/8917/g' -e '/^%{ if acme_email/,/^%{ endif/d' "$MOD/templates/Caddyfile.tftpl" >"$W/Caddyfile"
grep -q '\${' "$W/Caddyfile" && { echo "unrendered template variable"; exit 1; }
# The production Caddyfile, as rendered, must validate (adapt + provision every module) with the pinned image.
docker run --rm -v "$W/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$W/validate.log" 2>&1 \
  || { cat "$W/validate.log"; echo "FAIL the rendered production Caddyfile does not validate"; exit 1; }
echo "ok   the rendered production Caddyfile validates ($(docker run --rm "$CADDY" caddy version | cut -d' ' -f1))"
cp "$W/Caddyfile" "$W/Caddyfile.prod"
# ... then, TEST ONLY, use Caddy's internal CA for the site (no ACME offline).
sed -i 's/^gs-origin.test {$/gs-origin.test {\n\ttls internal/' "$W/Caddyfile"
mkdir -p "$W/data" "$W/config"; chown -R 2001:2001 "$W/data" "$W/config"
docker run -d --name gs-edge-upstream --network host -v "$HERE/edge:/edge:ro" "$NODE" node /edge/upstream.cjs >/dev/null
docker run -d --name gs-edge-caddy --network host --user 2001:2001 --cap-drop ALL --cap-add NET_BIND_SERVICE --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m -v "$W/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$W/data:/data" -v "$W/config:/config" \
  "$CADDY" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
for _ in $(seq 1 30); do docker logs gs-edge-caddy 2>&1 | grep -q '"serving initial configuration"' && break; sleep 1; done
docker run --rm --network host -v "$HERE/edge:/edge:ro" "$NODE" node /edge/client.cjs
