#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
bash "$repo_root/plans/heatmap-verification/run-benchmark.sh" --prepare-only
node "$repo_root/plans/heatmap-verification/lifecycle.mjs"
