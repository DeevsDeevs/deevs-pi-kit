"""Harbor agent: Harbor's built-in Codex CLI driven through OpenRouter's Responses API.

Codex 0.160 speaks only the Responses wire API, which OpenRouter serves at /api/v1/responses,
so a custom model provider is enough. Harbor's Codex agent assumes OpenAI: it passes
`--model <last path segment>`, which OpenRouter does not resolve, so the full id is restored.
Pass the OpenRouter id as the model (`-m openai/gpt-6.1-sol`) and the OpenRouter key as
OPENAI_API_KEY, which Harbor forwards and the provider reads.
"""

from harbor.agents.installed.codex import Codex

CODEX_VERSION = "0.160.1"
PROVIDER = {
    "name": "OpenRouter",
    "base_url": "https://openrouter.ai/api/v1",
    "env_key": "OPENAI_API_KEY",
    "wire_api": "responses",
}


class CodexOpenRouter(Codex):
    def __init__(self, *args, version: str | None = None, **kwargs):
        super().__init__(*args, version=version or CODEX_VERSION, **kwargs)

    @staticmethod
    def name() -> str:
        return "codex-openrouter"

    def _build_effective_config(self, openai_base_url=None):
        config = super()._build_effective_config(None)
        config["model_provider"] = "openrouter"
        config.setdefault("model_providers", {})["openrouter"] = PROVIDER
        return config

    async def exec_as_agent(self, environment, command, *args, **kwargs):
        short = f"--model {self.model_name.split('/')[-1]} "
        command = command.replace(short, f"--model {self.model_name} ", 1)
        return await super().exec_as_agent(environment, command, *args, **kwargs)
