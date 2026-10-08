"""Harbor agent: Pi's Bun release binary with this kit installed as a Pi package.

Everything else (the `pi --print --mode json` run, OpenRouter passthrough, token and
cost accounting, the ATIF trajectory) is Harbor's built-in Pi agent.
"""

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.pi import Pi

STAGE = Path(os.environ.get("PI_KIT_STAGE", Path(__file__).resolve().parents[1] / "results/terminal-bench/stage"))
KIT_DIR = "/opt/pi-kit"


class PiKit(Pi):
    @staticmethod
    def name() -> str:
        return "pi-kit"

    def get_version_command(self) -> str | None:
        return "pi --version"

    async def install(self, environment) -> None:
        for name in ("pi-linux-x64.tar.gz", "pi-kit.tar.gz"):
            await environment.upload_file((STAGE / name).resolve(), f"/tmp/{name}")
        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p {KIT_DIR} && tar xzf /tmp/pi-linux-x64.tar.gz -C /opt && tar xzf /tmp/pi-kit.tar.gz -C {KIT_DIR} "
                "&& rm /tmp/pi-linux-x64.tar.gz /tmp/pi-kit.tar.gz && chmod -R a+rX /opt/pi "
                f"&& chown -R {shlex.quote(str(environment.default_user or 'root'))} {KIT_DIR} && ln -sf /opt/pi/pi /usr/local/bin/pi"
            ),
        )
        settings = json.dumps({"defaultProjectTrust": "always", "packages": [KIT_DIR]})
        await self.exec_as_agent(
            environment,
            command=f"mkdir -p ~/.pi/agent && printf '%s\\n' {shlex.quote(settings)} > ~/.pi/agent/settings.json && pi --version",
        )

    async def run(self, instruction, environment, context) -> None:
        # Subagents run on pi-durable outside the lead's session file; keep their stores with the
        # logs so summarize.py bills their OpenRouter generations too.
        # ponytail: skipped when the agent timeout cancels the run; copy on timeout if that matters.
        try:
            await super().run(instruction, environment, context)
        finally:
            logs = shlex.quote(str(self.environment_logs_dir / "pi-kit-agents"))
            await self.exec_as_agent(environment, command=f"[ ! -d ~/.pi/agent/pi-kit ] || cp -r ~/.pi/agent/pi-kit {logs}")
