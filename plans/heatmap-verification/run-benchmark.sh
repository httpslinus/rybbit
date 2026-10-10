#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
benchmark_dir="$repo_root/plans/heatmap-verification"

docker build -f "$repo_root/server/Dockerfile" --target deps -t rybbit-local-test:workspace "$repo_root"
docker build -f "$benchmark_dir/benchmark-runner.Dockerfile" -t rybbit-local-benchmark:workspace "$repo_root"
if [ "${1:-}" = "--prepare-only" ]; then
  exit 0
fi

docker info --format '{"architecture":{{json .Architecture}},"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}},"kernel":{{json .KernelVersion}},"os":{{json .OperatingSystem}},"dockerVersion":{{json .ServerVersion}}}' > "$benchmark_dir/benchmark-docker-host.json"
docker inspect rybbit-local-clickhouse --format '{"image":{{json .Config.Image}},"nanoCpus":{{.HostConfig.NanoCpus}},"memoryBytes":{{.HostConfig.Memory}},"memorySwapBytes":{{.HostConfig.MemorySwap}},"cpuQuota":{{.HostConfig.CpuQuota}},"cpuPeriod":{{.HostConfig.CpuPeriod}},"cpuSet":{{json .HostConfig.CpusetCpus}}}' > "$benchmark_dir/benchmark-clickhouse-container.json"
if [ "$(uname -s)" = "Darwin" ]; then
  sysctl machdep.cpu.brand_string hw.memsize hw.ncpu > "$benchmark_dir/benchmark-native-host.txt"
fi

docker run --rm --network rybbit-local_default --env-file "$repo_root/plans/local/.env.local" \
  --mount "type=bind,src=$benchmark_dir,dst=/app/plans/heatmap-verification" \
  rybbit-local-benchmark:workspace sh -c \
  'export CLICKHOUSE_HOST=http://clickhouse:8123; node benchmark.mts lz4 && node benchmark.mts zstd && node benchmark.mts compare'
