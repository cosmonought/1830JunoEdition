# syntax=docker/dockerfile:1
#
# LIVE-5 L5-8: the game server's image for the ECS task (infra/aws). Build from the REPOSITORY ROOT:
#
#   docker build -f infra/docker/game-server.Dockerfile -t <ecr repository url>:<BUILD_ID> .
#
# The image carries no configuration and no secret: the task definition sets the environment (references only, L5-7 §14)
# and the task role is the only credential source. It runs as the unprivileged `node` user, needs no writable
# filesystem in AWS mode (the task definition sets readonlyRootFilesystem), and its container health check is a
# `node -e` GET of /gs/healthz (no curl in the image). The server is built exactly as `npm run build` builds it: tsc from
# the frontend's pinned TypeScript over server/src and the shared frontend engine sources.
#
# COST-1: MULTI-ARCH (linux/amd64 for the ECS task and developer machines, linux/arm64 for the single Graviton host).
#   docker build -f infra/docker/game-server.Dockerfile -t <tag> .                                  (the builder's own arch)
#   docker buildx build --platform linux/arm64 -f infra/docker/game-server.Dockerfile -t <tag> .     (Graviton, from x86)
# NODE_IMAGE is the multi-arch INDEX digest of node:22-bookworm-slim, so each platform resolves its own manifest. The build
# stage always runs on the BUILDER's platform (no emulation): tsc emits architecture-neutral JavaScript, and the server's
# production dependencies are pure JavaScript -- the stage FAILS if that ever stops being true (a native addon, a
# binding.gyp, or a lockfile entry pinned to an os/cpu), because node_modules installed on one architecture would then be
# wrong on the other. The runtime stage only copies files: it needs no RUN, so an arm64 image is built without QEMU. When
# the builder and the target are the same platform this is exactly the single-arch build it always was.
# Behind a TLS-inspecting proxy, give npm the proxy's CA as a BUILD SECRET (never baked into a layer, never a disabled
# verification): `--secret id=build_ca,src=<ca bundle>`. Without it the build is exactly as before.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /repo
# Dependencies first (cached while only sources change); lifecycle scripts never run.
COPY frontend/package.json frontend/package-lock.json frontend/
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    cd frontend && npm ci --ignore-scripts --no-audit --no-fund
COPY server/package.json server/package-lock.json server/
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    cd server && npm ci --ignore-scripts --no-audit --no-fund
COPY frontend/tsconfig.json frontend/
COPY frontend/src frontend/src
COPY server/tsconfig.json server/
COPY server/src server/src
RUN cd server && npm run build
# The runtime needs only the server's production dependencies.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    cd server && rm -rf node_modules && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# COST-1: the runtime's node_modules are copied to EVERY target architecture, so they must be architecture-neutral.
COPY infra/docker/check-arch-neutral.cjs /repo/infra/docker/
RUN node /repo/infra/docker/check-arch-neutral.cjs /repo/server

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app/server
COPY --from=build /repo/server/package.json ./package.json
COPY --from=build /repo/server/node_modules ./node_modules
COPY --from=build /repo/server/dist ./dist
USER node
EXPOSE 8917
STOPSIGNAL SIGTERM
CMD ["node", "dist/server/src/start.js"]
