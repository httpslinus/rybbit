FROM rybbit-local-test:workspace
COPY shared/src /app/shared/src
COPY shared/tsconfig.json /app/shared/tsconfig.json
COPY server/src /app/server/src
COPY server/tsconfig.json /app/server/tsconfig.json
RUN pnpm --filter @rybbit/shared build && pnpm --filter rybbit-backend exec tsc
WORKDIR /app/plans/heatmap-verification
