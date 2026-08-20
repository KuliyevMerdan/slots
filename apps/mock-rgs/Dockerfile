# The demo, containerized (C8, ADR-0010). One image, one origin: the mock RGS serves the game
# API *and* the built client from the same socket, so the deployed demo needs no CORS, no second
# host and no reverse proxy.
#
# Build from the repository root:  docker build -f apps/mock-rgs/Dockerfile .
#
# The image is the whole demo: `docker run -p 8787:8787 <image>` answers with a playable slot at
# http://localhost:8787/ — play money only, forceOutcome honoured because being driveable is this
# server's purpose (the production gate lives in apps/rgs, which refuses it always).

FROM node:22-alpine AS build
# Non-interactive corepack: without this, downloading the pinned pnpm asks a [Y/n] question that
# a docker build has no stdin to answer, and the install step hangs forever.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Fetch the pinned pnpm as its own layer, before the source arrives — a flaky download retries
# from this line, not from the whole install (the apps/rgs Dockerfile's lesson).
COPY package.json ./
RUN pnpm --version

# The layer-cache split: the lockfile and manifests change rarely, source changes daily, so the
# install caches against exactly the files that decide it. Every workspace manifest is listed
# because --frozen-lockfile verifies the lockfile against the whole workspace.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/game-client/package.json apps/game-client/
COPY apps/mock-rgs/package.json apps/mock-rgs/
COPY apps/rgs/package.json apps/rgs/
COPY packages/compliance/package.json packages/compliance/
COPY packages/dev-tools/package.json packages/dev-tools/
COPY packages/engine/package.json packages/engine/
COPY packages/game-math/package.json packages/game-math/
COPY packages/money/package.json packages/money/
COPY packages/platform/package.json packages/platform/
COPY packages/protocol/package.json packages/protocol/
COPY packages/renderer/package.json packages/renderer/
COPY packages/rgs-sim/package.json packages/rgs-sim/
COPY packages/transport/package.json packages/transport/
COPY packages/ui/package.json packages/ui/
COPY tools/load-test/package.json tools/load-test/
COPY tools/math-sim/package.json tools/math-sim/
COPY tools/perf-harness/package.json tools/perf-harness/
# Unlike the RGS image this one *does* need the client's toolchain — Vite, Pixi and all — because
# it ships the client. Two filters: the server chain and the client chain, nothing else.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000
RUN pnpm install --frozen-lockfile --filter @slot/mock-rgs... --filter @slot/game-client... \
    --network-concurrency 4

COPY . .
# Build the server chain and the client's workspace dependencies, then the client as the *demo*
# build: mode ≠ production, so `__DEV_TOOLS__` and `__ASSERT_MATH__` are true — the debug panel
# is the exhibit ("force a max win, read why the client can't cheat"), and this server honours
# forceOutcome by design. The production bundle that `verify:strip` proves clean is a different
# artifact from a different command; this image never claims to be it. `VITE_RGS_TRANSPORT=http`
# with the empty base URL makes the page talk to the origin that served it — ADR-0010's shape.
RUN pnpm --filter @slot/mock-rgs... --filter "@slot/game-client^..." run build
RUN VITE_RGS_TRANSPORT=http pnpm --filter @slot/game-client run build:demo
# A standalone production tree for the server, plus the client's static bundle beside it.
# `dist-demo`, not `dist`: the demo build lives in its own directory so the artifact
# `verify:strip` proves clean is never overwritten by the one that deliberately carries the
# dev surface.
RUN pnpm --legacy deploy --filter @slot/mock-rgs --prod /out
RUN cp -r apps/game-client/dist-demo /out/client

FROM node:22-alpine
ENV NODE_ENV=production \
    MOCK_RGS_HOST=0.0.0.0 \
    MOCK_RGS_STATIC_DIR=/app/client \
    MOCK_RGS_TRUST_PROXY=true
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 8787
# /ready reports which game and math this server is serving; a container that answers it can
# authenticate a session and play a round.
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${MOCK_RGS_PORT:-8787}/ready" || exit 1
CMD ["node", "dist/main.js"]
