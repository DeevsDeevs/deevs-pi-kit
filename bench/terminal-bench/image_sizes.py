"""Compressed Docker Hub image sizes for a Harbor dataset directory (from task.toml docker_image or Dockerfile FROM).

    python3 image_sizes.py <dataset-dir> [sample]
"""

import json
import random
import re
import sys
import tomllib
import urllib.request
from pathlib import Path


def image_of(task: Path) -> str | None:
    env = tomllib.loads((task / "task.toml").read_text()).get("environment", {})
    if env.get("docker_image"):
        return env["docker_image"].split("@")[0]
    dockerfile = task / "environment/Dockerfile"
    m = dockerfile.exists() and re.search(r"^FROM\s+(\S+)", dockerfile.read_text(), re.M)
    return m.group(1) if m else None


def hub_size(image: str) -> int | None:
    repo, _, tag = image.partition(":")
    repo = repo.removeprefix("docker.io/")
    if "/" not in repo:
        repo = f"library/{repo}"
    try:
        with urllib.request.urlopen(f"https://hub.docker.com/v2/repositories/{repo}/tags/{tag or 'latest'}", timeout=20) as r:
            return json.load(r).get("full_size")
    except Exception:
        return None


tasks = sorted(p.parent for p in Path(sys.argv[1]).glob("*/task.toml"))
if len(sys.argv) > 2:
    tasks = random.Random(0).sample(tasks, int(sys.argv[2]))
sizes = {t.name: hub_size(image_of(t) or "") for t in tasks}
known = [s for s in sizes.values() if s]
gb = lambda b: round(b / 1e9, 2)
print(json.dumps({"tasks": len(tasks), "sized": len(known), "mean_gb": gb(sum(known) / len(known)) if known else None,
                  "max_gb": gb(max(known)) if known else None, "sum_gb": gb(sum(known)),
                  "per_task_gb": {k: gb(v) for k, v in sizes.items() if v}}, indent=1))
