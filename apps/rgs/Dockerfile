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

# The lockfile and manifests first would be the classic layer-cache split; a workspace this size
# rebuilds in one minute and the simplicity of one COPY wins until it does not.
COPY . .
RUN pnpm install --frozen-lockfile
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
