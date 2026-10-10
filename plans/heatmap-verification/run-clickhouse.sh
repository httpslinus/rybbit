#!/usr/bin/env bash
set -euo pipefail

# Uses the isolated compose network; database ports and secrets stay private.
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
test_files=("$@")
if [ "${#test_files[@]}" -eq 0 ]; then
  test_files=(src/services/heatmaps/heatmapQueryService.clickhouse.test.ts)
fi

docker build -f "$repo_root/server/Dockerfile" --target deps -t rybbit-local-test:workspace "$repo_root"
docker run --rm --network rybbit-local_default --env-file "$repo_root/plans/local/.env.local" \
  --env HEATMAP_SINGLE_SITE_BENCHMARK \
  --mount "type=bind,src=$repo_root/server/src,dst=/app/server/src,readonly" \
  --mount "type=bind,src=$repo_root/server/vitest.config.ts,dst=/app/server/vitest.config.ts,readonly" \
  --mount "type=bind,src=$repo_root/shared/src,dst=/app/shared/src,readonly" \
  --mount "type=bind,src=$repo_root/shared/tsconfig.json,dst=/app/shared/tsconfig.json,readonly" \
  rybbit-local-test:workspace sh -c \
  'export CLICKHOUSE_TEST_URL=http://clickhouse:8123 CLICKHOUSE_TEST_PASSWORD="$CLICKHOUSE_PASSWORD"; pnpm --filter @rybbit/shared build && pnpm --filter rybbit-backend test:run "$@"' \
  sh "${test_files[@]}"
