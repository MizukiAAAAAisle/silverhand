#!/usr/bin/env bash
set -euo pipefail

duration="${1:-30}"
out="${2:-/tmp/silverhand-renderer-$(date +%Y%m%d-%H%M%S).sample.txt}"

pid="$(
  ps -axo pid=,ppid=,command= |
    awk '$3 ~ /^\/Applications\/Silverhand\.app/ && index($0, "Silverhand Helper (Renderer)") && index($0, "--type=renderer") {print $1}' |
    tail -1
)"

if [[ -z "${pid}" ]]; then
  echo "Silverhand renderer process not found" >&2
  exit 1
fi

echo "Sampling Silverhand renderer pid ${pid} for ${duration}s"
echo "Output: ${out}"
sample "${pid}" "${duration}" -file "${out}"
echo "Wrote ${out}"
