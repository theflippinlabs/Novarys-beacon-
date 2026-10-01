# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Runtime dependencies only (tsx is a runtime dependency: the worker and the
# release scripts run TypeScript directly).
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
RUN addgroup -S beacon && adduser -S beacon -G beacon
COPY --from=prod-deps --chown=beacon:beacon /app/node_modules /app/node_modules
COPY --from=build --chown=beacon:beacon /app/package.json /app/next.config.ts /app/tsconfig.json /app/
COPY --from=build --chown=beacon:beacon /app/.next /app/.next
COPY --from=build --chown=beacon:beacon /app/public /app/public
COPY --from=build --chown=beacon:beacon /app/src /app/src
USER beacon
EXPOSE 3000
# Anonymous /api/health answers {status} with 200 while the database is reachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Web: `pnpm start` · Worker: `pnpm worker` · Release (provision + migrate): `pnpm release`
CMD ["pnpm", "start"]
