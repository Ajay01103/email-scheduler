FROM docker.io/library/node:24-bookworm-slim AS base

RUN npm install --global pnpm@11.12.0

WORKDIR /app

FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM base AS runtime

ENV NODE_ENV=production

# Migrations run from TypeScript, so retain source and development dependencies.
COPY --from=build --chown=node:node /app /app

USER node
EXPOSE 3000

CMD ["node", "dist/api.js"]
