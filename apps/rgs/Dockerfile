# The RGS, containerized (R7, ADR-0009). One image, two commands:
#   node dist/main.js            — the RGS itself (the default)
#   node dist/wallet/sim-main.js — the wallet sim, for compose demos and staging
#
# Build from the repository root:  docker build -f apps/rgs/Dockerfile .
#
# The image defaults to RGS_ENV=production, so a bare `docker run` refuses to start until the
# environment names a database, a wallet and a real operator key — the fail-fast boot is the
# feature, not an inconvenience. docker-compose.yml at the repo root is the worked example.

FROM node:22-alpine AS build
# Non-interactive corepack: without this, downloading the pinned pnpm asks a [Y/n] question that
# a docker build has no stdin to answer, and the install step hangs forever.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Fetch the pinned pnpm as its own layer, before the source arrives: corepack downloads it on
# first use, and burying that download inside the install step means a flaky network fails the
# whole step and a retry starts from nothing. Here it caches once and retries never redo it.
COPY package.json ./
RUN pnpm --version

# The classic layer-cache split, earned the honest way: one COPY was simpler until the first
# source fix invalidated the install layer and re-downloaded the registry over a weak uplink.
# The lockfile and the manifests change rarely; source changes daily — so the install caches
# against exactly the files that decide it. Every workspace manifest is here, not just the RGS
# chain, because --frozen-lockfile verifies the lockfile against the *whole* workspace; one line
# per file because the legacy builder's COPY cannot glob and keep directory structure.
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
# Filtered on purpose: the image needs the RGS and its workspace dependency chain, not the
# client's toolchain — an unfiltered install drags in Vite, Pixi and their platform binaries,
# tens of megabytes that would ship nowhere and download slowly everywhere. The dialled-down
# concurrency and stretched retries are for weak uplinks: fewer parallel sockets each finish
# sooner, and a dropped one is retried instead of failing the build.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000
RUN pnpm install --frozen-lockfile --filter @slot/rgs... --network-concurrency 4

COPY . .
# Build the RGS and, through the ... filter, every workspace package it depends on — in
# topological order, exactly as `pnpm check` builds them.
RUN pnpm --filter @slot/rgs... run build
# A standalone production tree: the package's dist, its production dependencies, and its
# workspace dependencies packed from their own dist — nothing dev, nothing else.
RUN pnpm --legacy deploy --filter @slot/rgs --prod /out

FROM node:22-alpine
ENV NODE_ENV=production \
    RGS_ENV=production \
    RGS_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 8788
# The health gate a rollout waits on: /ready probes the store and the wallet and answers 503
# naming the failing check (R6) — so "healthy" here means "can actually play a round".
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${RGS_PORT:-8788}/ready" || exit 1
CMD ["node", "dist/main.js"]
