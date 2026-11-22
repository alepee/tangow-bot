FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a
# Corepack keeps the pnpm that package.json pins where every user reads it, fetched at build:
# USER node would otherwise fetch it at start, and the migrate service's network has no egress.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable
WORKDIR /app
# Manifests before sources: the install layer is the expensive one, and copying the
# whole tree first meant any source edit rebuilt it from scratch. Every workspace
# package.json has to be here or --frozen-lockfile rejects the truncated workspace.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack install && chmod -R a+rX "$COREPACK_HOME"
COPY patches patches
COPY apps/api/package.json apps/api/
COPY apps/desktop/package.json apps/desktop/
COPY apps/mobile/package.json apps/mobile/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/adapter-kit/package.json packages/adapter-kit/
COPY packages/adapters/package.json packages/adapters/
COPY packages/auth/package.json packages/auth/
COPY packages/chat-ui/package.json packages/chat-ui/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/logging/package.json packages/logging/
COPY packages/memory/package.json packages/memory/
COPY packages/testkit/package.json packages/testkit/
COPY packages/ui-tokens/package.json packages/ui-tokens/
COPY packages/ui-web/package.json packages/ui-web/
COPY infra/sandboxes/supervisor/package.json infra/sandboxes/supervisor/
COPY infra/updater/package.json infra/updater/
# Only what this image ever runs. Across docker-compose.yml and .prod.yml
# the app image is started as @tangow/api, @tangow/worker, @tangow/web
# and @tangow/sandbox-supervisor, plus scripts/backfill-session-log.ts and @tangow/db's
# prisma CLI it runs to migrate, and scripts/migrate-docker-homes.ts;
# the desktop, mobile and testkit projects only add electron, expo and react-native
# to an image that never builds them. `tangow` is the
# workspace root: `start` is `tsx src/index.ts`, and tsx, turbo and cross-env are root
# devDependencies resolved through /app/node_modules/.bin.
# The skip-download vars cover any postinstall that survives a future filter change.
# The store lives on a BuildKit cache mount rather than in the layer, so a lockfile
# change re-links from local disk instead of refetching the registry. It is written
# and read only by root during this step and is gone before USER node applies, so
# nothing at runtime depends on it. sharing=locked keeps two concurrent builds from
# writing the same store.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    pnpm install --frozen-lockfile --store-dir=/pnpm-store \
      --filter "@tangow/api..." \
      --filter "@tangow/worker..." \
      --filter "@tangow/web..." \
      --filter "@tangow/sandbox-supervisor..." \
      --filter "@tangow/db..." \
      --filter "tangow"
# Normalize modes: a restrictive host umask (e.g. 077 on hardened hosts) would otherwise
# leave the copied tree unreadable to USER node at runtime.
COPY --chmod=755 . .
# After the sources: the prisma schema arrives with them.
RUN pnpm --filter @tangow/db generate
RUN TANGOW_ALLOW_DEV_SECRETS=1 pnpm --filter @tangow/web build
RUN install -d -m 750 -o node -g node /data /app/apps/web/node_modules/.vite-temp
ARG GIT_SHA
ENV NODE_ENV=production
ENV GIT_SHA=$GIT_SHA
EXPOSE 3100 5173 7091
USER node
CMD ["pnpm", "--filter", "@tangow/api", "start"]
