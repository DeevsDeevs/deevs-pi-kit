#!/usr/bin/env bash
# Prints the OpenRouter key's usage and limit (never the key itself).
set -euo pipefail
key=$(cat "${OPENROUTER_KEY_FILE:-$HOME/.config/pi-kit-bench/openrouter.key}")
curl -fsS -H "Authorization: Bearer $key" https://openrouter.ai/api/v1/key \
	| python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print(json.dumps({k: d.get(k) for k in ("usage","limit","limit_remaining","usage_daily")}))'
