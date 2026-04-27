# Subagents Extension Plan: Curated Background Staff

Package: `deevs-pi-kit`  
Extension name: `subagents`  
Human command namespace: `/agents`  
Primary tool prefix: `agent_*`  
Status: implementation-ready plan

## Product Goal

Build a Pi-native subagents extension for `deevs-pi-kit` that launches a small curated staff of expert agents as managed background jobs.

The extension is inspired by the previous `agent-system` project, especially `dev-experts`, but it does **not** sync or vendor the full `agent-system` repository. The built-in staff is rewritten/adapted for Pi and kept intentionally small.

Core promise:

> Ask focused expert staff to investigate, review, plan, test, explore, or critique while the parent agent stays in control.

## Locked Decisions

- Extension/plugin name: `subagents`.
- Human command namespace: `/agents`.
- Tool names use `agent_*`.
- Canonical launch tool is `agent_start`; no `agent_run` alias.
- Subagents are background jobs by default.
- MVP supports single runs and parallel groups.
- Chains are deferred.
- Existing `processes` extension is the lifecycle backbone.
- Every subagent run maps to a backing managed process:

```text
agent run id  a_...
proc id       p_...
```

- Parallel groups have group ids:

```text
group id      g_...
```

- Built-in staff is curated, not imported wholesale from `agent-system`.
- Built-in staff should preserve opinionated Deevs persona style.
- `explorer` is a first-class agent and may be used automatically by the main model for non-trivial work.
- The main model may start any staff agent when useful, but should not over-delegate trivial tasks.
- Agents are read-only/advisory by default.
- Write access is allowed only when explicitly passed by the tool caller / command / UI toggle.
- Child Pi runs use `--no-skills`.
- Child Pi runs use `--no-extensions` plus one tiny explicit child safety extension.
- Child Pi prompt is added with `--append-system-prompt`, not full system prompt replacement.
- Child Pi runs always use a run-specific session directory.
- MVP settings are session-scoped only, same style as `/proc:settings`.
- MVP subagent run/group metadata is in-memory only, same spirit as non-persistent proc records.
- Artifacts/log files are on disk, but status memory resets on reload.
- No persistent subagents in MVP.
- No custom project agents in MVP.
- No recursive delegation in MVP.
- UI is first-class for browse/status/logs/dock/settings, but not for rich interactive launch builders in MVP.

## Built-in Staff

Initial built-ins:

| Agent | Purpose | Default tools | Default write access |
|---|---|---|---:|
| `explorer` | Analyze exact requested code/context connections and summarize concrete findings | `read,bash` | no |
| `architect` | Design plans, architecture options, boundaries, tradeoffs | `read,bash` | no |
| `reviewer` | Strict code review for correctness, security, performance, edge cases | `read,bash` | no |
| `tester` | Test strategy, coverage gaps, validation plans, test command recommendations | `read,bash` | no |
| `devops` | Runtime/debugging/deploy/config/log-investigation mindset | `read,bash` | no |
| `python-dev` | Python-specific review and implementation advice | `read,bash` | no |
| `cpp-dev` | C++ correctness, UB, memory, concurrency, performance review | `read,bash` | no |
| `rust-dev` | Rust idioms, ownership, async, error handling, unsafe review | `read,bash` | no |
| `anti-slop` | Remove AI-generated complexity, dead code, needless abstractions | `read,bash` | no |

### `explorer` Agent

`explorer` is the precise recon agent.

Use it when the parent needs targeted context before making changes:

- map how a function/module/feature connects to the rest of the system
- identify relevant files and call paths
- summarize data/control flow
- find exact extension points
- answer “where is this handled?” questions
- summarize only the requested thing, not the whole codebase

Behavior:

- read/search by default
- no edits unless write access is explicitly granted
- no broad architecture pontification unless asked
- report concrete files, symbols, and relationships
- distinguish verified facts from guesses
- end with “what to inspect next” only when useful

Suggested output format:

```text
Summary
- ...

Relevant files/symbols
- path:line — why it matters

Connections
- A calls B because ...
- Config X feeds Y via ...

Exact answer to the requested question
- ...

Uncertainties / not inspected
- ...
```

## Agent Definition Format

Builtin agents live inside the extension:

```text
extensions/subagents/agents/*.md
```

Example:

```markdown
---
name: explorer
description: Targeted code/context explorer that maps exact requested connections and summarizes concrete findings.
tools: read,bash
mode: advisory
write: false
tags: recon,context,code-map
---

# Explorer

You are a precise code/context explorer...
```

Supported frontmatter:

| Field | Meaning |
|---|---|
| `name` | short agent name |
| `description` | when to use it |
| `tools` | default Pi tools for the child process |
| `mode` | `advisory` initially; future `executor` possible |
| `write` | whether writes are allowed by default; false for MVP built-ins |
| `model` | optional model override, subject to settings allowlist |
| `tags` | comma-separated search/filter terms |
| `disabled` | hide/disable agent |

## Tool API

### `agent_list`

Lists available built-in agents.

Input:

```ts
{
  includeDisabled?: boolean;
  query?: string;
  tag?: string;
}
```

Output:

```ts
{
  agents: Array<{
    name: string;
    description: string;
    tools: string[];
    mode: "advisory" | "executor";
    write: boolean;
    model?: string;
    tags: string[];
  }>;
}
```

### `agent_start`

Starts one background subagent. This is the canonical single-agent launch tool.

Input:

```ts
{
  agent: string;
  task: string;
  cwd?: string;
  context?: "fresh" | "fork";
  model?: string;
  tools?: string[];
  allowWrite?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}
```

Output:

```ts
{
  id: string;          // a_...
  procId: string;      // p_...
  agent: string;
  task: string;
  status: "starting" | "running" | "completed" | "failed" | "cancelled" | "timeout";
  startedAt: number;
  cwd: string;
  artifactsDir: string;
  logs?: {
    combined?: string;
    stdout?: string;
    stderr?: string;
  };
  output?: string;
  nextSeq?: number;
}
```

Notes:

- `agent_start` returns immediately after starting.
- No deliberate `waitMs` for `/agents:run`; startup validation/spawn errors are still surfaced immediately.
- Default backend is the process extension pipe backend.
- No persistent/tmux support in MVP.
- `context: "fresh"` is default.
- `context: "fork"` uses Pi CLI `--fork <current-session-file>` when possible; if unavailable, fail clearly. Do not silently fall back to fresh.
- `model` must be allowed by `/agents:settings`; arbitrary model strings are rejected.
- `allowWrite: true` adds `edit,write` to the agent's configured tools.

### `agent_parallel_start`

Starts a background group of independent agents.

Input:

```ts
{
  tasks: Array<{
    agent: string;
    task: string;
    model?: string;
    tools?: string[];
    allowWrite?: boolean;
    context?: "fresh" | "fork";
  }>;
  concurrency?: number;
  failFast?: boolean;
  timeoutMs?: number;
  maxBytesPerAgent?: number;
}
```

Output:

```ts
{
  groupId: string; // g_...
  status: "running";
  mode: "parallel";
  runs: Array<{ id: string; procId: string; agent: string; task: string }>;
}
```

Behavior:

- Default concurrency: `3`.
- Hard max concurrency: `6` by default.
- Concurrency settings can be changed in `/agents:settings` for the session.
- Values above max are rejected with a clear error.
- `failFast?: boolean`, default `false`.
- If `failFast: false`, all started tasks run to terminal state.
- If `failFast: true`, a failure stops remaining running/pending tasks.
- Group terminal statuses:

```ts
"running" | "completed" | "partial" | "failed" | "cancelled"
```

Semantics:

- `completed`: all children completed successfully
- `partial`: mixed terminal statuses, e.g. completed + failed/cancelled/stopped
- `failed`: all children failed, or failFast caused group failure
- `cancelled`: group explicitly stopped before meaningful completion

### `agent_read`

Reads a run or group.

Input:

```ts
{
  id: string; // a_... or g_...
  afterSeq?: number;
  waitMs?: number;
  maxBytes?: number;
  stream?: "combined" | "stdout" | "stderr";
  raw?: boolean;
}
```

Behavior:

- For run IDs:
  - default/friendly mode returns parsed final output if complete, otherwise bounded friendly current output/tail
  - `raw: true` returns raw ProcessManager chunks and cursor fields
- For group IDs:
  - returns bounded group summary
  - includes child statuses
  - includes child final outputs if complete, or recent output tails if running

Output cap:

```text
default returned output: 64 KB
hard max returned output: 256 KB
status tail: 4 KB
```

### `agent_status`

Lists one run, one group, or all active/recent runs/groups.

Input:

```ts
{
  id?: string; // a_... or g_...
  includeCompleted?: boolean;
}
```

Output:

```ts
{
  runs: Array<{
    id: string;
    procId: string;
    groupId?: string;
    agent: string;
    task: string;
    status: string;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    cwd: string;
    outputTail?: string;
    resultPath?: string;
  }>;
  groups: Array<{
    id: string;
    mode: "parallel";
    status: "running" | "completed" | "partial" | "failed" | "cancelled";
    startedAt: number;
    endedAt?: number;
    children: string[];
  }>;
}
```

### `agent_stop`

Stops a run or group through the process manager.

Input:

```ts
{
  id: string; // a_... or g_...
  signal?: "SIGINT" | "SIGTERM" | "SIGKILL";
  timeoutMs?: number;
}
```

Behavior:

- Run ID: stop that backing child process.
- Group ID: stop all currently running child processes in the group.
- Individual child run inside a parallel group may be stopped independently.
- If a child in a parallel group is manually stopped, group final status is `partial` if at least one other child completes.

### `agent_logs`

Returns or displays subagent artifacts and backing process logs.

Input:

```ts
{
  id: string; // a_... or g_...
  source?: "result" | "task" | "system-prompt" | "metadata" | "combined" | "stdout" | "stderr";
  maxBytes?: number;
}
```

Behavior:

- For run IDs, expose:

```text
result.md
task.md
system-prompt.md
metadata.json
process combined log
process stdout log
process stderr log
```

- `system-prompt.md` is visible by default.
- For group IDs, UI shows group metadata and child run list; user can select child artifacts/logs.
- Do not concatenate all child logs by default.

### `agent_clear`

Clears completed/recent records and optionally artifacts.

Input:

```ts
{
  id?: string;                // run id or group id
  allCompleted?: boolean;
  deleteArtifacts?: boolean;
}
```

Behavior:

- Mirrors `proc_clear` style.
- Clearing a group clears child run records too.
- `deleteArtifacts: true` deletes group artifacts and child artifacts.
- Clearing an individual child run that belongs to an active/recent group is rejected; clear the group instead.

## Slash Commands

MVP commands:

```text
/agents                 Dashboard/status when runs exist; staff catalog otherwise
/agents:catalog         Browse/view built-in staff
/agents:browse          Alias for /agents:catalog
/agents:list            Text list of agents
/agents:run             Simple launch command for one background agent
/agents:parallel        Simple launch command for a parallel background group
/agents:status          Inspect running/recent runs/groups
/agents:read            Friendly parsed read by default; --raw for raw process chunks
/agents:stop            Stop a run/group
/agents:logs            Artifact/log browser
/agents:clear           Clear completed records/artifacts
/agents:dock            Toggle/show/hide agent dock
/agents:settings        Session-scoped settings UI
```

No rich interactive launch builder in MVP. The main launch path is the parent Pi agent calling tools. Simple slash launch commands exist for humans.

### `/agents:run`

Example:

```text
/agents:run explorer Map how the processes extension restores persistent tmux tasks
/agents:run reviewer --write -- Fix the issue described in the current diff
/agents:run reviewer --model anthropic/claude-sonnet-4 -- Review current diff
```

Behavior:

- Starts background job immediately.
- Returns run id + proc id.
- Shows immediate validation/spawn errors.

### `/agents:parallel`

MVP syntax uses shared-task agent-list style:

```text
/agents:parallel reviewer,tester,anti-slop -- Review current diff
```

Behavior:

- Creates one parallel group.
- Each agent receives a persona-specific shared-task wrapper.
- Tool API supports explicit per-agent tasks; explicit tasks are passed directly without extra wrapper.

## Deferred Chain Support

Chains are not in MVP.

Deferred items:

```text
agent_chain_start
/agents:chain
chain groups
{previous} orchestration
per-agent chain templates
chain UI/status details
```

Reason: chains need sequential orchestration, final-output dependency, templating, failure semantics, and reload/orphan handling. Parallel groups provide most MVP value with much less complexity.

The data model should still avoid blocking future chain support.

## Process Extension Backbone

Subagents reuse the existing `processes` extension instead of inventing a second lifecycle manager.

The process manager already provides:

- managed process ids
- pipe/pty/tmux backends
- cursor/chunk reads
- stdin writes if needed
- signal control
- bounded buffers
- bounded disk logs
- cleanup
- alerts/watches
- `/proc` UI and logs

Subagents add:

- agent/persona discovery
- child Pi command construction
- run/group metadata
- result extraction from Pi JSON mode
- `/agents` UI and agent-focused status
- mapping from agent run ids to proc ids

### Required Process Service Refactor

Current `processes/index.ts` creates its own `ProcessManager`. Subagents need the same instance.

Add:

```text
extensions/processes/service.ts
```

Responsibilities:

```ts
export function getProcessService(pi: ExtensionAPI): {
  manager: ProcessManager;
  processUi: ProcessUi;
  registerOnce(): void;
}
```

Implementation notes:

- Store singleton in `globalThis` using a package symbol, e.g. `Symbol.for("deevs-pi-kit.process-service")`.
- `processes/index.ts` obtains singleton and registers process tools/commands once.
- `subagents/index.ts` obtains same manager and starts/reads/signals child Pi runs.
- Avoid duplicate registration after `/reload`.
- `/proc:list` should show subagent children as normal managed processes.

Process names:

```text
agent:explorer:a_abc123
agent:reviewer:a_def456
agent-group:g_123:reviewer:a_def456
```

## Child Pi Execution

Each subagent is a child Pi process in JSON mode.

Fresh context approximate command:

```bash
pi --mode json --print \
  --no-extensions \
  --extension <child-safety-runtime.ts> \
  --no-skills \
  --append-system-prompt <system-prompt.md> \
  --tools read,bash \
  --session-dir <run-dir>/session \
  @<task.md>
```

Fork context approximate command:

```bash
pi --mode json --print \
  --fork <ctx.sessionManager.getSessionFile()> \
  --session-dir <run-dir>/session \
  --no-extensions \
  --extension <child-safety-runtime.ts> \
  --no-skills \
  --append-system-prompt <system-prompt.md> \
  --tools read,bash \
  @<task.md>
```

Exact args must be validated in implementation. `pi --help` confirms support for:

```text
--fork <path|id>
--session-dir <dir>
--append-system-prompt <text-or-file>
--no-extensions
--extension <path>
--no-skills
--tools <tools>
--mode json
--print/-p
```

Environment:

```text
DEEVS_PI_SUBAGENT=1
DEEVS_PI_SUBAGENT_ID=a_...
DEEVS_PI_SUBAGENT_AGENT=explorer
DEEVS_PI_SUBAGENT_DEPTH=1
DEEVS_PI_SUBAGENT_GROUP_ID=g_...    # for grouped runs
```

### Child Safety Runtime

Create a tiny explicit child runtime extension loaded even with `--no-extensions`:

```text
extensions/subagents/child-safety-runtime.ts
```

Responsibilities:

- block background bash:
  - `cmd &`
  - `nohup`
  - `disown`
  - `setsid`
- avoid loading full parent extension stack
- optionally enforce recursion guard if subagent tools ever become visible accidentally

## Prompt Construction

For every subagent run, generate a run-specific system prompt:

```text
You are a delegated Deevs staff subagent.

Agent: explorer
Mode: advisory
Working directory: /path/to/project
Write access: off

Delegation rules:
- Stay within your assigned persona and task.
- Be concrete and evidence-based.
- Use file paths and line references when possible.
- Do not ask the user questions unless blocked.
- Do not spawn other subagents.
- Do not edit files unless write access was explicitly granted for this run.
- If you cannot verify something, say exactly what is missing.

Tool rules:
- Use read/search/shell inspection as needed.
- Bash is allowed for targeted inspection/validation.
- Do not run destructive commands.
- Avoid servers/watchers/long-lived commands.
- If a command is expected to run indefinitely, tell the parent to use background tasks.

Persona:
<agent markdown body>
```

Task file:

```text
Task:
<task>

Return concise structured output.
```

For `agent_start`, the task is passed directly. No automatic wrapper.

For `/agents:parallel` shared-task launches, apply per-agent task wrappers/templates. For explicit per-agent tool tasks, pass directly.

## Model Selection

Default behavior:

```text
allowedModels = []
```

This means explicit model override is disabled and subagents inherit main/default Pi model by passing no `--model`.

Settings model resolution:

```text
command/tool model override, if allowed
  > modelsByAgent[agent], if set
  > defaultModel, if set
  > inherit/main Pi default
```

Rules:

- Reject explicit `model` values not present in `/agents:settings` allowed models.
- No arbitrary model strings in MVP.
- `/agents:settings` should prefer a known-model picker/list if Pi exposes available models through API.
- Fallback to text editor/list field for model IDs.

## Settings

`/agents:settings` is session-scoped only, same as `/proc:settings`.

Settings include:

```ts
{
  allowedModels: string[];          // default [] = inherit only
  defaultModel?: string;            // must be in allowedModels
  modelsByAgent: Record<string, string>;
  defaultTimeoutMs: number;         // 300_000
  maxTimeoutMs: number;             // 900_000
  parallelDefaultConcurrency: number; // 3
  parallelMaxConcurrency: number;     // 6
  dockEnabled: boolean;             // false by default
  dockHeight: number;
  defaultAllowWrite: boolean;       // false
  notifyOnTerminal: boolean;        // true
  wakeOnCompletion: boolean;        // true in this package after product decision
  wakeOnFailure: boolean;           // true
  wakeOnTimeout: boolean;           // true
}
```

Defaults:

```text
default timeout: 5 minutes
max timeout: 15 minutes
parallel default concurrency: 3
parallel hard max concurrency: 6
max completed records: 64
dock enabled: false
```

## Artifact and State Layout

Use process-style Pi agent root, matching current process extension patterns.

Process extension currently uses:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/process-logs/<project-hash>/
${PI_CODING_AGENT_DIR:-~/.pi/agent}/process-state/<project-hash>.json
```

Subagent artifacts use:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/subagent-runs/<project-hash>/<run-id>/
```

Each run directory:

```text
agent.md
task.md
system-prompt.md
result.md
metadata.json
session/
```

Parallel groups may have:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/subagent-runs/<project-hash>/<group-id>/
  metadata.json
```

MVP run/group state index is in memory only. Do not write persistent `subagent-state` in MVP.

## Result Extraction

MVP implements basic Pi JSON-mode final-output parsing.

Behavior:

1. Capture raw stdout/stderr through ProcessManager logs and buffers.
2. Parse JSONL enough to extract final assistant text.
3. Write final assistant text to `result.md`.
4. If parsing fails, fallback to bounded output tail and record extraction warning in metadata.

No rich tool/usage/progress parsing in MVP.

## Notifications and Wake Behavior

Single runs:

- visible notification on all terminal states:
  - completed
  - failed
  - cancelled
  - timeout
- completed/failed/timeout wakes/triggers parent agent turn by default
- cancelled is visible only by default
- completion notification includes short final-output preview/tail, capped around 500 chars

Parallel groups:

- group-level notification only
- no per-child terminal notifications for grouped runs
- group notification includes compact per-agent statuses only, e.g.

```text
parallel g_123 completed: reviewer ✓, tester ✓, anti-slop failed
```

## UI Plan

MVP UI includes browse/status/logs/dock/settings. It does not include rich interactive launch/task/parallel builders.

### `/agents`

Adaptive home for subagents:

- if active/recent runs or groups exist, open the status dashboard
- otherwise, open the built-in staff catalog

Use `/agents:catalog` or `/agents:browse` to force the staff catalog.

Catalog behavior:

```text
up/down       move
esc/q         close
```

Catalog fields:

```text
Name
Description
Tools
Write default
Tags
Prompt/persona preview
```

No edit/clone/delete/user override features in MVP.

### `/agents:status`

Agent-oriented status panel:

```text
RUNNING   a_123 explorer  24s  p_abc  Map process persistence
DONE      a_456 reviewer  2m   p_def  Review current diff
PARTIAL   g_789 parallel  3m          reviewer ✓ tester ✓ anti-slop stopped
```

Keys:

```text
up/down       select
enter/r       read
l             logs/artifacts
s/k           stop
c             clear completed/group if allowed
r             refresh
q/esc         close
```

### `/agents:logs`

Subagent artifact/log browser.

For run ID:

```text
result.md
task.md
system-prompt.md
metadata.json
combined process log
stdout process log
stderr process log
```

For group ID:

```text
group metadata
child run list
select child -> choose artifact/log source
```

Viewer behavior:

```text
/ or f        search/filter
up/down       scroll
PgUp/PgDn     page
g/G           top/bottom
c             clear search
q/esc         close/back
```

### Footer status and `/agents:dock`

A compact footer status is shown while subagents are active, e.g. `subagents: 3 running / 1 group`, and cleared when idle.

`/agents:dock` is disabled by default.

Commands:

```text
/agents:dock          toggle
/agents:dock show
/agents:dock hide
/agents:dock toggle
```

Widget example:

```text
agents: 2 running · explorer 24s · reviewer 1m
```

### `/agents:settings`

Session-scoped SettingsList UI, same spirit as `/proc:settings`.

Must include model allowlist/default model controls, concurrency, timeout, dock enabled, dock height, default allow write.

## Safety Defaults

- Built-in agents only for MVP.
- No project-local/custom agents in MVP.
- `allowWrite` default false.
- Write access must be explicit.
- `allowWrite: true` adds `edit,write` to the agent frontmatter tools.
- Human explicit `--write` or UI toggle is enough; no extra confirmation.
- Child Pi has `--no-skills`.
- Child Pi has `--no-extensions` plus tiny safety extension.
- Child safety extension blocks background bash.
- Subagent may run validation commands through bash.
- Bash prompt guardrails forbid destructive/long-lived commands.
- Default timeout 5 minutes, max 15 minutes.
- Parent remains responsible for final decisions.

## E2E Validation Plan

### Phase 1: Discovery

- Load extension.
- `agent_list({})` includes:
  - `explorer`
  - `architect`
  - `reviewer`
  - `tester`
  - `devops`
  - `python-dev`
  - `cpp-dev`
  - `rust-dev`
  - `anti-slop`
- `/agents:list` shows same names.
- `/agents` browser opens.
- Bad/missing agent returns a clear error.

### Phase 2: Process Backbone Refactor

- Add shared process service.
- Existing `proc_*` tools still work:
  - start
  - read
  - list
  - signal
  - logs
  - clear
- `/proc` commands still work.
- No duplicate process tool/command registration after reload.

### Phase 3: Single Background Agent

Start:

```ts
agent_start({
  agent: "explorer",
  task: "Say hello and summarize your exact output format."
})
```

Validate:

- returns immediately with `id` and `procId`
- `/proc:list` shows `agent:explorer:<id>`
- `agent_status({ id })` shows running/completed
- `agent_read({ id })` returns friendly output
- `agent_read({ id, raw: true })` returns raw chunks
- after completion, `result.md` exists
- `agent_logs({ id })` exposes artifact/log sources
- `/agents:logs <id>` opens artifact/log browser
- notification appears on completion with preview

### Phase 4: Real Explorer Task

Run against this repo:

```ts
agent_start({
  agent: "explorer",
  task: "Map how the processes extension starts, tracks, and reads managed processes. Focus only on exact files and call flow."
})
```

Validate output includes:

- concrete file paths
- call relationships
- no broad unrelated summary
- no edits by default

### Phase 5: Fork Context

Start with fork:

```ts
agent_start({
  agent: "reviewer",
  context: "fork",
  task: "Review the current direction from this conversation."
})
```

Validate:

- child command uses `--fork <current-session-file>`
- run-specific session directory is used
- if current session file unavailable, error is clear

### Phase 6: Write Opt-In

Start:

```ts
agent_start({
  agent: "tester",
  allowWrite: true,
  task: "Add or adjust a minimal test for the issue if clearly safe."
})
```

Validate:

- child tools include agent tools + `edit,write`
- without `allowWrite`, edit/write are absent
- prompt clearly says write access is on/off

### Phase 7: Stop/Cancel

Start long-running run, then:

```ts
agent_stop({ id, signal: "SIGINT" })
```

Validate:

- backing process is signaled
- status becomes cancelled/signaled
- visible terminal notification appears
- no parent wake for cancellation
- logs remain readable

### Phase 8: Timeout

Start with tiny timeout:

```ts
agent_start({
  agent: "explorer",
  task: "Sleep for 30 seconds, then respond.",
  timeoutMs: 1000
})
```

Validate:

- process is terminated
- status becomes timeout
- visible notification appears
- parent wake is triggered
- logs explain timeout

### Phase 9: Parallel Group

Start:

```ts
agent_parallel_start({
  tasks: [
    { agent: "reviewer", task: "Review correctness in the current diff." },
    { agent: "tester", task: "Review test gaps in the current diff." },
    { agent: "anti-slop", task: "Find unnecessary AI-generated complexity." }
  ],
  concurrency: 3
})
```

Validate:

- returns group id
- starts three process-backed runs
- `/proc:list` shows all children
- `agent_status({ id: groupId })` groups them
- `agent_read({ id: groupId })` returns bounded group summary
- one failure does not hide other results with `failFast: false`
- group-level notification only

### Phase 10: Parallel Stop/Clear

- Stop one child inside a parallel group.
- Group eventually becomes `partial` if others complete.
- Stop a group; all running children stop.
- Clear group; children clear too.
- Attempt to clear child that belongs to group; rejected with clear message.

### Phase 11: Settings

- `/agents:settings` opens.
- Allowed model list can be edited/selected.
- Explicit model not in allowed list is rejected.
- Default model/settings apply for new runs.
- Concurrency defaults/max can be changed for the session.
- Dock can be toggled from settings.

### Phase 12: Dock

- `/agents:dock show` enables widget.
- Start run/group.
- Widget shows running count and names/durations.
- `/agents:dock hide` removes widget.

### Phase 13: Reload Behavior

Since MVP is non-persistent and in-memory:

- Start a subagent run.
- `/reload` Pi.
- Process extension grouped reload cleanup stops backing non-persistent process.
- `/agents:status` state resets after reload, same spirit as proc non-persistent records.
- No stale running agent status remains.

## Implementation Phases

### Phase 0: Plan

- Write/update this plan.
- Lock decisions.

### Phase 1: Built-in Agent Definitions

Create:

```text
extensions/subagents/agents/explorer.md
extensions/subagents/agents/architect.md
extensions/subagents/agents/reviewer.md
extensions/subagents/agents/tester.md
extensions/subagents/agents/devops.md
extensions/subagents/agents/python-dev.md
extensions/subagents/agents/cpp-dev.md
extensions/subagents/agents/rust-dev.md
extensions/subagents/agents/anti-slop.md
```

### Phase 2: Shared Process Service

Create:

```text
extensions/processes/service.ts
```

Update:

```text
extensions/processes/index.ts
```

Validate existing process extension before continuing.

### Phase 3: Subagents Scaffold + Discovery

Create:

```text
extensions/subagents/index.ts
extensions/subagents/types.ts
extensions/subagents/config.ts
extensions/subagents/agents.ts
extensions/subagents/tools.ts
extensions/subagents/commands.ts
extensions/subagents/ui.ts
extensions/subagents/README.md
skills/subagents/SKILL.md
```

Implement:

- frontmatter parser
- builtin discovery
- `agent_list`
- `/agents:list`
- `/agents` browser/detail UI

### Phase 4: Single Background Agent Runtime

Create:

```text
extensions/subagents/prompt.ts
extensions/subagents/runner.ts
extensions/subagents/manager.ts
extensions/subagents/logs.ts
extensions/subagents/safety.ts
extensions/subagents/child-safety-runtime.ts
```

Implement:

- artifact directory creation
- Pi child command construction
- timeout handling
- result extraction
- notifications
- `agent_start`
- `agent_read`
- `agent_status`
- `agent_stop`
- `agent_logs`
- `agent_clear`

### Phase 5: Parallel Groups

Implement:

- `agent_parallel_start`
- group metadata
- concurrency scheduling
- failFast behavior
- group status/read/stop/logs/clear
- `/agents:parallel`

### Phase 6: UI Completion

Implement:

```text
/agents:status
/agents:read
/agents:stop
/agents:logs
/agents:clear
/agents:dock
/agents:settings
```

### Phase 7: Docs and Package Skill

Update:

```text
extensions/subagents/README.md
skills/subagents/SKILL.md
README.md
```

Skill should teach:

- use `explorer` automatically for non-trivial recon
- use `reviewer/tester/anti-slop` for pre-merge validation
- use `agent_parallel_start` for independent perspectives
- do not over-delegate trivial tasks
- subagents are background jobs; use `agent_status/read/logs/stop`
- write requires explicit `allowWrite: true`

## Future Work

- Chains:
  - `agent_chain_start`
  - `/agents:chain`
  - `{previous}` orchestration
  - chain templates
- Persistent subagents via tmux/process persistence.
- Custom user agents.
- Project-local agents with explicit opt-in.
- Rich JSON progress/tool/usage parsing.
- Worktrees.
- Intercom/parent-child chat.
- Persistent `/agents:settings`.
