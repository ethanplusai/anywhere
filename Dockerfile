# Anywhere server. Build from the repository root:  docker build -t anywhere .
# Run with docker-compose.yml (server + Postgres), or alone with DATABASE_URL set.

# Pinned by digest (audit D10). Update with: docker buildx imagetools inspect node:22-slim
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
# The server's build copies the layout file into the package.
COPY docs/layout.md ./docs/layout.md
RUN pnpm install --frozen-lockfile --filter @anywhere/server...
RUN pnpm --filter @anywhere/server build

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --prod --filter @anywhere/server... \
  && rm -rf /root/.cache /root/.local/share/pnpm
COPY --from=build /app/packages/server/dist ./packages/server/dist
# The guide text and page templates are read from this file at startup (single source).
COPY docs/layout.md ./docs/layout.md
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "packages/server/dist/main.js"]
