#!/usr/bin/env bash
# Stages what the pi-kit agent uploads into each task container: Pi's checked release binary
# and this checkout's HEAD as a package with its production dependencies installed.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
pi_version=${PI_VERSION:-$(node -p "require('$root/package.json').devDependencies['@earendil-works/pi-coding-agent']")}
stage=${PI_KIT_STAGE:-$root/bench/results/terminal-bench/stage}
mkdir -p "$stage" && cd "$stage"

if [ ! -f "pi-$pi_version.tar.gz" ]; then
	base="https://github.com/earendil-works/pi/releases/download/v$pi_version"
	curl -fsSL --retry 3 -o SHA256SUMS "$base/SHA256SUMS"
	curl -fsSL --retry 3 -o pi-linux-x64.tar.gz "$base/pi-linux-x64.tar.gz"
	grep " pi-linux-x64.tar.gz$" SHA256SUMS | sha256sum -c -
	mv pi-linux-x64.tar.gz "pi-$pi_version.tar.gz"
fi
ln -sf "pi-$pi_version.tar.gz" pi-linux-x64.tar.gz

rm -rf kit && mkdir kit
(cd "$root" && git archive --format=tar HEAD) | tar x -C kit
(cd kit && npm install --omit=dev --legacy-peer-deps --no-audit --no-fund --loglevel=error)
tar czf pi-kit.tar.gz -C kit .
echo "staged Pi $pi_version and kit $(cd "$root" && git rev-parse --short HEAD) in $stage"

# Harbor's podman environment drives `podman compose`; Ubuntu's podman-compose 1.0.6 lacks `ls`, so use Compose v2 on the Podman socket.
if ! command -v docker-compose >/dev/null && [ ! -x bin/docker-compose ]; then
	mkdir -p bin
	v=$(curl -fsSL https://api.github.com/repos/docker/compose/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')
	curl -fsSL -o bin/docker-compose "https://github.com/docker/compose/releases/download/$v/docker-compose-linux-x86_64"
	curl -fsSL "https://github.com/docker/compose/releases/download/$v/docker-compose-linux-x86_64.sha256" | awk '{print $1"  bin/docker-compose"}' | sha256sum -c -
	chmod +x bin/docker-compose
fi
