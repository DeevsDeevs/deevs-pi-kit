#!/usr/bin/env bash
# Terminal-Bench on rootless Podman through Harbor, models via OpenRouter.
#   bench/terminal-bench/run.sh pi-kit openrouter/anthropic/claude-sonnet-5.5 -i html-js-filter ...
#   bench/terminal-bench/run.sh claude-code anthropic/claude-sonnet-5.5 -i html-js-filter ...
#   bench/terminal-bench/run.sh codex openai/gpt-6.1-sol -i html-js-filter ...   (any OpenRouter id)
# Extra arguments go to `harbor run`. Run prepare.sh first for pi-kit.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
agent=$1 model=$2
shift 2

stage=${PI_KIT_STAGE:-$root/bench/results/terminal-bench/stage}
export PATH=$stage/bin:$PATH
export DOCKER_HOST=${DOCKER_HOST:-unix://$XDG_RUNTIME_DIR/podman/podman.sock}
export PODMAN_COMPOSE_PROVIDER=${PODMAN_COMPOSE_PROVIDER:-$(command -v docker-compose)}
export CONTAINERS_CONF_OVERRIDE=$here/containers.conf
export PYTHONPATH=$here
systemctl --user start podman.socket

key=$(cat "${OPENROUTER_KEY_FILE:-$HOME/.config/pi-kit-bench/openrouter.key}")
case $agent in
	pi-kit) agent=pi_kit_agent:PiKit; export OPENROUTER_API_KEY=$key ;;
	claude-code) export ANTHROPIC_API_KEY=$key ANTHROPIC_BASE_URL=https://openrouter.ai/api ;;
	codex) agent=codex_agent:CodexOpenRouter; export OPENAI_API_KEY=$key ;;
	*) export OPENROUTER_API_KEY=$key ;;
esac

exec uvx --python 3.12 --from "harbor==${HARBOR_VERSION:-0.24.0}" harbor run \
	-d "${TB_DATASET:-terminal-bench/terminal-bench@4.0.0}" -e podman -a "$agent" -m "$model" \
	--extra-docker-compose "$here/network.compose.yaml" -o "$root/bench/results/terminal-bench/jobs" -y "$@"
