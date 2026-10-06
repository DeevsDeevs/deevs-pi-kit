"""Per-trial reward, tokens, cost and time from Harbor job directories, as JSON.

    python3 summarize.py <job-dir>...

`openrouter_usd` is what OpenRouter billed: the sum over every generation id (`gen-...`)
found in the trial's agent logs, looked up with the key in OPENROUTER_KEY_FILE.
"""

import json
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

KEY = Path(os.environ.get("OPENROUTER_KEY_FILE", Path.home() / ".config/pi-kit-bench/openrouter.key"))


def seconds(timing: dict | None) -> float | None:
    if not timing or not timing.get("started_at") or not timing.get("finished_at"):
        return None
    start, end = (datetime.fromisoformat(timing[k]) for k in ("started_at", "finished_at"))
    return round((end - start).total_seconds(), 1)


def generation_cost(gen_id: str) -> float | None:
    request = urllib.request.Request(f"https://openrouter.ai/api/v1/generation?id={gen_id}",
                                     headers={"Authorization": f"Bearer {KEY.read_text().strip()}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as r:
            return json.load(r)["data"]["total_cost"]
    except Exception:
        return None


def openrouter_usd(agent_dir: Path) -> tuple[int, float | None]:
    ids = {m for f in agent_dir.rglob("*") if f.is_file() for m in re.findall(r"gen-\d+-[A-Za-z0-9]+", f.read_text(errors="ignore"))}
    if not ids or not KEY.exists():
        return len(ids), None
    with ThreadPoolExecutor(16) as pool:
        costs = list(pool.map(generation_cost, sorted(ids)))
    return len(ids), round(sum(c for c in costs if c), 4)


def trial(path: Path) -> dict:
    r = json.loads(path.read_text())
    agent = r.get("agent_result") or {}
    rewards = (r.get("verifier_result") or {}).get("rewards") or {}
    generations, billed = openrouter_usd(path.parent / "agent")
    return {
        "task": r["task_name"].split("/")[-1],
        "agent": r["agent_info"]["name"],
        "model": (r["agent_info"].get("model_info") or {}).get("name"),
        "reward": rewards.get("reward"),
        "exception": (r.get("exception_info") or {}).get("exception_type"),
        "input_tokens": agent.get("n_input_tokens"),
        "cache_read_tokens": agent.get("n_cache_tokens"),
        "output_tokens": agent.get("n_output_tokens"),
        "agent_reported_usd": agent.get("cost_usd"),
        "openrouter_generations": generations,
        "openrouter_usd": billed,
        "agent_s": seconds(r.get("agent_execution")),
        "agent_setup_s": seconds(r.get("agent_setup")),
        "env_setup_s": seconds(r.get("environment_setup")),
        "verifier_s": seconds(r.get("verifier")),
        "total_s": seconds(r),
    }


trials = [trial(p) for job in sys.argv[1:] for p in sorted(Path(job).glob("*/result.json"))]
print(json.dumps(trials, indent=1))
