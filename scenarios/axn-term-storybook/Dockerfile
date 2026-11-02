FROM docker.io/library/node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.5.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm fetch applies patchedDependencies — the patch files must be present.
COPY patches ./patches
RUN pnpm fetch --frozen-lockfile

COPY . .
RUN pnpm install --frozen-lockfile --offline

EXPOSE 6006
