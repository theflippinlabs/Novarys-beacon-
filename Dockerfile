# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S beacon && adduser -S beacon -G beacon
COPY --from=build --chown=beacon:beacon /app /app
USER beacon
EXPOSE 3000
# Web: `pnpm start` · Worker: `pnpm worker` · Migrations: `pnpm db:migrate`
CMD ["pnpm", "start"]
