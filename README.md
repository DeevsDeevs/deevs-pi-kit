# deevs-pi-kit

Portable Pi kit for Deevs: managed background tasks, curated subagents, and the skills that teach the main agent when to use them.

## Install

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit
# or project-local
pi install git:github.com/DeevsDeevs/deevs-pi-kit -l
# local development
pi install /Users/deevs/programming/agents/deevs-pi-kit
```

Reload after local edits:

```text
/reload
```

## Contents

```text
extensions/processes/   Managed long-running commands
extensions/subagents/   Curated background staff agents
extensions/chains/      Durable multi-session work chains
skills/background-tasks Guidance for proc_* usage
skills/subagents/       Guidance for agent_* usage
skills/chain-system/    Guidance for chain handoffs/search
prompts/                Prompt templates
docs/                   Design notes and plans
```

## Extensions

### Background tasks

`extensions/processes/` runs long-lived commands without shell detaching hacks (`&`, `nohup`, `disown`, `setsid`).

Use it for dev servers, watchers, workers, REPLs, and any command that should keep running while the conversation continues.

Tools:

```text
proc_start   proc_read   proc_list   proc_write
proc_signal  proc_logs   proc_clear
```

Commands:

```text
/proc                         interactive task panel
/proc:list                    text task list
/proc:read <id|name>          buffered output
/proc:logs <id|name> [stream] searchable log overlay
/proc:kill <id|name|--all>    SIGTERM
/proc:signal <id|name> <sig>  SIGINT/SIGTERM/SIGKILL
/proc:clear <id|name|--exited>
/proc:dock [show|hide|toggle]
/proc:settings
```

Active non-subagent tasks show a compact blue footer status. Full docs: [`extensions/processes/README.md`](extensions/processes/README.md).

### Subagents

`extensions/subagents/` runs curated staff agents as managed background jobs.

Built-in staff:

```text
explorer   architect  reviewer  tester  devops
python-dev cpp-dev    rust-dev   anti-slop
```

Tools:

```text
agent_list    agent_start  agent_parallel_start  agent_read
agent_status  agent_stop   agent_logs            agent_clear
```

Commands:

```text
/agents                       dashboard if runs exist, catalog otherwise
/agents:catalog               staff browser
/agents:browse                alias for /agents:catalog
/agents:list                  text staff list
/agents:run <agent> -- <task>
/agents:parallel a,b -- <task>
/agents:status                run/group dashboard
/agents:read <id> [--raw]
/agents:logs <id> [source]
/agents:stop <id>
/agents:clear <id|--completed>
/agents:dock [show|hide|toggle]
/agents:settings
```

Subagents are read-only by default. Pass write permission only when explicitly requested. Use `chainContext` for parent-loaded chain handoffs. Active runs show a footer status and completion wakes the parent agent. Full docs: [`extensions/subagents/README.md`](extensions/subagents/README.md).

### Chains

`extensions/chains/` stores resumable work handoffs in project-local `.chains/` markdown files.

```text
/chain-link <name>             summarize current work and save a link
/chain-load <name>             load latest link as working context
/chain-fork <name> <branch>    fork a branch from an existing link
/chain-list [--branches]       list chains
/chain-search [name] <query>   full-link text/regex search across links
```

Tools: `chain_save`, `chain_load`, `chain_fork`, `chain_context`, `chain_list`, `chain_search`. `chain_context` packs current/parent/recent/search context within a byte budget; subagents can receive it through `agent_start.chainContext` or per-task `chainContext` in `agent_parallel_start`.

## Development checks

```bash
bun build extensions/processes/index.ts --outdir /tmp/deevs-proc-build \
  --external @mariozechner/pi-coding-agent --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui --external node-pty

bun build extensions/subagents/index.ts --outdir /tmp/deevs-subagents-build \
  --external @mariozechner/pi-coding-agent --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui --external node-pty

bun build extensions/chains/index.ts --outdir /tmp/deevs-chains-build \
  --external @mariozechner/pi-coding-agent --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui --external node-pty

npm pack --dry-run
```

Pi currently runs extensions on Node, so extension code should avoid Bun runtime APIs unless it explicitly spawns a Bun helper.
