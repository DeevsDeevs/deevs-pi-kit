#!/usr/bin/env bash
# The 5-task smoke: the shortest single-container CPU tasks by expert estimate, both agents at once.
#   bench/terminal-bench/smoke.sh [agent-timeout-multiplier, default 0.0417 = 20 min of 8 h] [job suffix]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
results=$here/../results/terminal-bench
mult=${1:-0.0417} suffix=${2:-}
model=${MODEL:-anthropic/claude-sonnet-5.5}
tasks=()
for t in html-js-filter photonic-waveguide-routing music-harmony bun-sourcemap-leak foodstuff-beta-activity; do tasks+=(-i "terminal-bench/$t"); done
mkdir -p "$results"
"$here/run.sh" pi-kit "openrouter/$model" "${tasks[@]}" --agent-timeout-multiplier "$mult" -n 5 --job-name "smoke-pi-kit$suffix" -q > "$results/smoke-pi-kit$suffix.log" 2>&1 &
"$here/run.sh" claude-code "$model" "${tasks[@]}" --agent-timeout-multiplier "$mult" -n 5 --job-name "smoke-cc$suffix" -q > "$results/smoke-cc$suffix.log" 2>&1
wait
python3 "$here/summarize.py" "$results/jobs/smoke-pi-kit$suffix" "$results/jobs/smoke-cc$suffix" > "$results/smoke$suffix.json"
