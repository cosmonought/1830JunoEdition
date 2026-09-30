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

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
# Dependencies first (cached while only sources change); lifecycle scripts never run.
COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci --ignore-scripts --no-audit --no-fund
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --ignore-scripts --no-audit --no-fund
COPY frontend/tsconfig.json frontend/
COPY frontend/src frontend/src
COPY server/tsconfig.json server/
COPY server/src server/src
RUN cd server && npm run build
# The runtime needs only the server's production dependencies.
RUN cd server && rm -rf node_modules && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

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
