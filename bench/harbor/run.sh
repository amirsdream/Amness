#!/usr/bin/env bash
# Run Amness on a named slice of Terminal-Bench 2.0 with Harbor.
#   bench/harbor/run.sh <subset> <provider/model> [job-name] [extra harbor options...]
#   bench/harbor/run.sh mini custom/qwen-vllm qwen-full --ak endpoint=http://192.168.1.20:8000/v1
#   bench/harbor/run.sh mini custom/qwen-vllm qwen-nonudge --ak endpoint=http://192.168.1.20:8000/v1 --ak off=nudge
# Subsets are files in bench/harbor/subsets (one task name per line). Results go to .amness/harbor/jobs/<job-name>.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../.." && pwd)"
subset="${1:?subset name, for example mini}"; model="${2:?provider/model}"; job="${3:-$subset-$(date +%Y%m%d-%H%M%S)}"; shift $(( $# >= 3 ? 3 : $# ))
file="$here/subsets/$subset.txt"; [ -f "$file" ] || { echo "no subset $file" >&2; exit 2; }
includes=(); while read -r t; do [[ -z "$t" || "$t" == \#* ]] || includes+=(-i "$t"); done < "$file"
export PATH="$HOME/.docker/bin:$PATH"
cd "$root"
PYTHONPATH="$here" exec harbor run -d terminal-bench@2.0 "${includes[@]}" -n "${AMNESS_BENCH_CONCURRENCY:-1}" \
  -a amness_agent:Amness -m "$model" -o .amness/harbor/jobs --job-name "$job" "$@"
