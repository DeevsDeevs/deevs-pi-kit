# Processes Plugin Full Plan

## Feature goal

Build the first `deevs-pi-kit` plugin: a pi extension for managed background processes.

The plugin should let the agent start long-running commands without blocking the conversation, inspect incremental output, write to stdin, stop processes safely, surface important lifecycle/log events, and give the user a clean UI for visibility and control.

Primary use cases:

- dev servers (`pnpm dev`, `cargo watch`, local APIs)
- test/build/watch commands
- long-running diagnostics
- interactive-ish processes where stdin matters
- log watching with agent notifications on readiness/failure
- optional persistent local services that survive pi restarts

Non-goal: replacing a real terminal multiplexer for heavy interactive work. The plugin should be a safe managed process layer, not a full terminal emulator. PTY support is for better process behavior, not for running arbitrary TUIs perfectly inside pi.

## Platform scope

### v1

- macOS and Linux.
- Windows fails closed with a clear `not supported yet` notification.

Reason: process groups, signals, PTY behavior, and shell conventions differ enough that pretending support would create cleanup bugs.

### Later

- Windows runner with Job Objects / process tree cleanup.
- PowerShell command mode.
- Windows ConPTY investigation for PTY mode.

## Requirement interrogation

### What problem are we solving?

Pi intentionally has no background bash. We want a controlled process manager that avoids shell-detached hacks like `cmd &`, while preserving visibility, cleanup, safety, and agent access to output.

### Expected scale

Personal/dev workflow scale:

- 1-5 live processes normally
- hard cap around 16 live processes by default
- possibly noisy output, so logs and memory buffers must be bounded
- sessions are usually short-lived, but persistence should be available for explicit long-lived services

### Failure cost

Medium-high:

- orphan processes can keep ports busy or consume CPU
- unbounded logs can fill disk
- background commands can leak secrets into logs
- noisy alerts can derail agent conversations
- incorrect process killing can terminate unrelated user work

Therefore the core must be boring, explicit, bounded, and observable.

## Design principles

1. **Managed beats detached** — never encourage `cmd &`, `nohup`, `disown`, or `setsid` from model bash.
2. **Bound everything** — live process count, output memory, log bytes, read wait time, alert rate.
3. **Precise model tools** — use separate tools with required fields instead of one mega action tool.
4. **Human-visible by default** — processes are visible in `/proc` and optional dock/status UI.
5. **Safe cleanup first** — no orphan process groups in session-scoped mode.
6. **Pipe backend first, PTY later** — correctness before terminal realism.
7. **Persistence is explicit** — default processes are pi-session scoped; persistent processes require opt-in.
8. **Do not hide uncertainty** — status should distinguish running, exited, failed, killing, orphaned, detached, unknown.

## Alternatives considered

### Option A — Copy `pi-processes` shape

Single `process` tool with action field, pipe-based child processes, temp log files, UI/dock early.

Pros:

- Fastest path to useful plugin
- Proven pi extension patterns
- Nice UX inspiration

Cons:

- No PTY support
- Unbounded logs unless redesigned
- Mega-tool schema invites invalid calls
- Sync file I/O in output path if copied naively
- Harder to add cursor-based reads later

Verdict: good inspiration, not the architecture to copy directly.

### Option B — Codex-style managed exec core

Separate tools with process IDs, sequence/cursor reads, bounded output ring, optional logs, strict lifecycle manager. UI builds on top.

Pros:

- Correct core abstraction
- Easier for model to use precisely
- Bounded by design
- Can add UI/dock without changing core
- Closer to Codex unified exec semantics

Cons:

- More design work up front
- Less flashy initial implementation
- PTY support needs dependency/evaluation

Verdict: chosen approach.

### Option C — Thin tmux wrapper

Plugin creates tmux sessions/windows and exposes list/read/kill helpers.

Pros:

- True terminal behavior
- Great observability for human
- Mature process persistence

Cons:

- Requires tmux
- Harder cross-platform story
- Parsing/capturing panes is awkward
- Less self-contained as a pi package

Verdict: useful later as optional backend, not default.

## Chosen approach

Build **Codex-style managed exec**, pi-native:

- precise `proc_*` tools for model use
- `/proc*` commands for user control
- bounded in-memory output ring
- optional bounded disk logs
- watch/alert system
- pipe backend first
- PTY backend later
- session-scoped by default
- persistence as explicit advanced mode

## Architecture

### Package layout

```text
extensions/
  processes/
    index.ts             # pi extension entrypoint
    config.ts            # defaults and resolved config
    types.ts             # shared public/internal types
    ids.ts               # process IDs and name lookup helpers
    manager.ts           # source of truth for process lifecycle
    runner.ts            # pipe runner abstraction
    pty-runner.ts        # later optional PTY runner
    output-buffer.ts     # bounded seq-based output buffer
    logs.ts              # bounded async log writer/rotation
    watches.ts           # substring/regex watch engine
    alerts.ts            # pi.sendMessage lifecycle/watch alerts
    tools.ts             # proc_* tool registration
    commands.ts          # /proc commands
    safety.ts            # validation, env redaction, bash blocker
    ui/
      process-list.ts    # later TUI panel
      log-viewer.ts      # later log overlay
      dock.ts            # later dock/status widget
```

### Package manifest

Package manifest includes both single-file and directory extensions:

```json
"extensions": ["./extensions/*.ts", "./extensions/*/index.ts"]
```

### Runtime ownership

`ProcessManager` is the only source of truth.

Responsibilities:

- create process records
- enforce process limits
- start/stop child processes through runner
- ingest stdout/stderr
- write output to buffer/logs
- update status on exit/error/signal
- emit manager events
- cleanup on shutdown

Other modules react to manager events but do not own process state.

### Concurrency model

Pi can execute sibling tool calls in parallel. The manager must be safe under concurrent `proc_start`, `proc_read`, `proc_signal`, and `proc_clear` calls.

Rules:

- Register a process record synchronously before any awaited spawn/wait path can lose track of it.
- Make process count enforcement atomic: reserve a slot before spawning, release it on spawn failure.
- Serialize state mutations per process ID with a small async mutex/queue.
- Keep reads lock-light: snapshot process state and buffer cursor consistently, then render outside critical sections.
- `proc_clear` must reject or no-op for running processes unless a `force` option is added later.
- Shutdown cleanup should be idempotent because `session_shutdown`, signal handlers, and manual kills may race.

### Core process model

```ts
type ProcessStatus =
  | "starting"
  | "running"
  | "exited"
  | "signaled"
  | "failed"
  | "killing"
  | "kill_timeout"
  | "orphaned"
  | "unknown";

interface ManagedProcessInfo {
  id: string;
  name: string;
  command: string | null;
  argv: string[] | null;
  cwd: string;
  backend: "pipe" | "pty" | "tmux";
  pid: number | null;
  pgid: number | null;
  status: ProcessStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  stdinOpen: boolean;
  persistent: boolean;
  logFile: string | null;
  stdoutLogFile: string | null;
  stderrLogFile: string | null;
  alertPolicy: AlertPolicy;
  stats: ProcessStats;
}

interface ProcessStats {
  stdoutBytes: number;
  stderrBytes: number;
  droppedBytes: number;
  bufferedBytes: number;
  logBytes: number;
  lastOutputAt: number | null;
}
```

Internal `ManagedProcess` extends this with child handles, output buffer, log writer, watches, timers, and cleanup callbacks.

### Output model

Use sequence-numbered chunks. Store real streams only; `combined` is a read mode derived by sequence order.

```ts
interface OutputChunk {
  seq: number;
  time: number;
  stream: "stdout" | "stderr";
  text: string;
  byteLength: number;
}

interface ReadResult {
  id: string;
  status: ProcessStatus;
  chunks: OutputChunk[];
  nextSeq: number;
  earliestSeq: number;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
  droppedBeforeSeq: number | null;
}
```

Rules:

- Every output append increments `seq`.
- Buffer evicts oldest chunks when byte cap is reached.
- `earliestSeq` tells the reader whether its cursor is stale.
- `droppedBeforeSeq` is set if requested `afterSeq` is older than retained output.
- Reads respect `maxBytes` and stream filter.
- Output chunk text may be truncated if a single child output chunk exceeds `maxChunkBytes`.

### Spawn semantics

Support two start modes:

1. Shell command:

```ts
{ command: "pnpm dev" }
```

Runs through configured shell:

```text
bash -lc <command>
```

2. Direct argv:

```ts
{ argv: ["node", "-e", "console.log('hi')"] }
```

Runs via:

```ts
spawn(argv[0], argv.slice(1))
```

Rules:

- exactly one of `command` or `argv`
- reject empty command/argv
- default `cwd = ctx.cwd`
- relative `cwd` resolves against `ctx.cwd`
- default-deny cwd outside project unless config allows it
- inherit environment by default but allow safe overlay later
- never render full env
- Unix pipe backend uses detached process groups so cleanup can signal `-pid`

### Cancellation semantics

Tool execution receives an `AbortSignal` from the custom tool `execute(toolCallId, params, signal, onUpdate, ctx)` signature.

- `proc_start` aborted before registration: terminate child to avoid untracked orphan.
- `proc_start` aborted after registration: leave process managed and return/stop waiting.
- `proc_read` aborted: stop waiting, do not kill process.
- `proc_signal` aborted: if signal already sent, continue state update best-effort.
- `proc_logs`/`proc_list`: no special behavior needed.

### Pi extension API contracts

Implementation should follow pi's extension APIs directly:

- Register tools with `pi.registerTool()`.
- Use TypeBox schemas for parameters.
- Use `StringEnum` from `@mariozechner/pi-ai` for enum fields, because plain TypeBox literal unions are not Google-compatible in pi.
- Give every tool a short `promptSnippet` and explicit `promptGuidelines` that name the tool, e.g. "Use proc_start...".
- Throw from `execute()` for invalid inputs so pi marks the tool result as an error.
- Use `onUpdate` for long waits/progress only when it improves observability.
- Register the bash blocker via `pi.on("tool_call")` and `isToolCallEventType("bash", event)`.
- Register shutdown cleanup via `pi.on("session_shutdown")`; the event reason can be `quit`, `reload`, `new`, `resume`, or `fork`.
- Use `pi.sendMessage(..., { triggerTurn, deliverAs })` for process/watch alerts; avoid `sendUserMessage()` unless we explicitly want a real user-authored turn.

### Lifecycle state machine

```text
starting
  ├─ spawn error ─────────────▶ failed
  └─ child spawned ───────────▶ running

running
  ├─ natural exit code 0 ─────▶ exited
  ├─ natural exit nonzero ────▶ exited
  ├─ signal observed ─────────▶ signaled
  ├─ proc_signal(SIGTERM) ────▶ killing
  ├─ process group missing ───▶ orphaned/unknown
  └─ runner error ────────────▶ failed

killing
  ├─ exits after signal ──────▶ signaled
  └─ timeout ─────────────────▶ kill_timeout

kill_timeout
  ├─ proc_signal(SIGKILL) ────▶ killing
  └─ process disappears ──────▶ signaled/unknown
```

## Tool surface

Use separate tools. This is more verbose but far easier for the model to call correctly.

### `proc_start`

Starts a managed process.

Parameters:

```ts
{
  name: string;
  command?: string;
  argv?: string[];
  cwd?: string;
  waitMs?: number;
  maxBytes?: number;
  backend?: "pipe" | "pty";
  env?: Record<string, string>;
  persistent?: boolean;
  alertOnExit?: boolean;
  alertOnFailure?: boolean;
  alertOnReady?: boolean;
  watches?: Array<{
    pattern: string;
    mode?: "substring" | "regex";
    stream?: "stdout" | "stderr" | "both";
    repeat?: boolean;
    triggerTurn?: boolean;
  }>;
}
```

Return:

```ts
{
  process: ManagedProcessInfo;
  output: ReadResult;
}
```

Rules:

- default `waitMs` around 1000ms
- `waitMs` capped by config
- return process ID and initial output
- if process exits during initial wait, return terminal status immediately
- process is still registered unless configured to auto-clear short-lived commands later

### `proc_read`

Reads buffered output, optionally long-polling.

```ts
{
  id: string;
  afterSeq?: number;
  waitMs?: number;
  maxBytes?: number;
  stream?: "stdout" | "stderr" | "combined";
}
```

Rules:

- `waitMs` supports long-polling but is capped
- empty output while running is valid
- return `nextSeq` every time
- stale cursors are reported, not silently ignored

### `proc_write`

Writes to stdin.

```ts
{
  id: string;
  input: string;
  end?: boolean;
}
```

Rules:

- reject if process ended or stdin closed
- preserve bytes as given; caller includes `\n` if needed
- `end: true` closes stdin after write

### `proc_signal`

Sends a signal.

```ts
{
  id: string;
  signal: "SIGINT" | "SIGTERM" | "SIGKILL";
  tree?: boolean;
  timeoutMs?: number;
}
```

Rules:

- default `tree: true` on Unix, targeting process group
- `SIGTERM` may transition to `kill_timeout`
- `SIGKILL` is final best effort
- idempotent for already terminal processes

### `proc_list`

Lists managed processes.

```ts
{
  includeExited?: boolean;
  includePersistent?: boolean;
}
```

### `proc_logs`

Returns log file paths and sizes if disk logging is enabled.

```ts
{
  id: string;
}
```

### `proc_clear`

Clears terminal process records and optionally deletes logs.

```ts
{
  id?: string;
  allExited?: boolean;
  deleteLogs?: boolean;
}
```

## Commands

### Core commands

- `/proc` — process panel or simple list summary
- `/proc:read [id|name]` — show recent output
- `/proc:kill [id|name]` — graceful stop
- `/proc:signal [id|name] [signal]` — explicit signal
- `/proc:logs [id|name]` — show log paths or open log viewer
- `/proc:clear [id|name|--exited]` — clear records/logs
- `/proc:settings` — configure plugin

### Later UI commands

- `/proc:dock show|hide|toggle`
- `/proc:pin [id|name]`
- `/proc:persist [id|name]` — mark running process as persistent, if supported
- `/proc:attach` — discover/reattach persisted process metadata

## Config

Initial resolved config:

```ts
interface ProcessesConfig {
  limits: {
    maxProcesses: number;              // default 16 live processes
    maxExitedRecords: number;          // default 64 retained terminal records
    autoClearExitedAfterMs: number;    // default 0/off initially
    defaultWaitMs: number;             // default 1000
    maxWaitMs: number;                 // default 30000
    maxReadBytes: number;              // default 65536
    maxChunkBytes: number;             // default 262144
    maxBufferBytesPerProcess: number;  // default 1_000_000
    maxLogBytesPerProcess: number;     // default 50_000_000
    maxWatchesPerProcess: number;      // default 16
  };
  execution: {
    shellPath?: string;
    allowCwdOutsideProject: boolean;   // default false
    defaultBackend: "pipe" | "pty";   // default pipe
    allowPty: boolean;                 // default false until PTY backend lands
    killOnShutdown: boolean;           // default true
    killOnReload: boolean;             // default true until persistence exists
    persistentEnabled: boolean;        // default false initially
  };
  safety: {
    blockBackgroundBash: boolean;      // default true once stable
    redactEnvKeys: string[];           // TOKEN, KEY, SECRET, PASSWORD, etc.
    confirmLongRunningServers: boolean;// later
    allowNetworkListeners: boolean;    // later
  };
  logs: {
    enabled: boolean;                  // default true once logs land
    directory?: string;                // default under pi/project temp/state
    rotate: boolean;                   // default true
  };
  alerts: {
    defaultAlertOnFailure: boolean;    // default true
    defaultAlertOnExit: boolean;       // default false
    repeatWatchCooldownMs: number;     // default 5000
    maxAgentTurnsPerMinute: number;    // default low, e.g. 3
  };
  ui: {
    dockEnabled: boolean;              // default false initially
    dockHeight: number;                // default 10
    followLogs: boolean;               // default true
  };
}
```

Config storage can start as constants in `config.ts`; later use a settings loader if we want `/proc:settings` persistence.

### Environment policy

`proc_start.env` is an overlay, not a full environment replacement, unless a later `envMode` option is added.

Rules:

- inherit `process.env` by default for compatibility with dev workflows
- apply `env` overlay after inheritance
- allow setting a key to an empty string
- do not support deleting inherited keys in the first implementation
- redact configured keys in all rendered metadata and logs of command metadata
- never include raw env maps in tool results

## Safety policy

### MVP safety

- reject empty commands
- enforce command/argv mutual exclusion
- validate `cwd`
- default-deny cwd outside current project
- cap process count
- cap output buffers
- cap read wait time
- cap single output chunk size
- never render full environment maps
- redact common secret-looking keys in metadata
- kill all live child process groups on pi shutdown by default
- fail closed on unsupported platforms

### Bash background interception

Add a `tool_call` hook for built-in `bash`.

Block or warn on:

- trailing `&`
- `nohup`
- `disown`
- `setsid`
- shell patterns whose obvious purpose is detaching a long-running command

Use parser if dependency is acceptable; otherwise conservative regex fallback. The block reason should tell the model exactly which `proc_start` tool to use.

### Later safety

- command allowlist/denylist
- confirm background command before first use per session
- project-local policy file
- detect likely network listeners (`vite`, `next dev`, `uvicorn`, `python -m http.server`) and notify user
- persistent mode confirmation
- environment filtering instead of raw inheritance

## Logs

### In-memory buffer

Always enabled.

- sequence chunks
- byte bounded
- evicts oldest chunks
- tracks dropped bytes and earliest sequence

### Disk logs

Phase 3+.

- async write stream, not sync writes in data handlers
- combined log plus optional stdout/stderr logs
- max bytes per process
- rotation or truncating ring-log strategy
- logs deleted on clear unless configured otherwise
- persistent processes use stable state directory, not tmp-only directory

## Watches and alerts

### Watch types

Start with substring watches:

```ts
{ pattern: "ready", mode: "substring" }
```

Add regex with constraints:

- max pattern length
- max line length to evaluate
- optional safe-regex check
- invalid regex fails at `proc_start`

### Alert behavior

Events can be:

- user-visible only
- user-visible + trigger agent turn

Defaults:

- watch match: trigger turn unless configured otherwise
- process failure: trigger turn by default
- process success/normal exit: visible only by default
- repeat watches: cooldown
- global alert budget to prevent spam

## UI plan

### Phase UI-1: Text commands

- `/proc` prints list summary
- `/proc:read` prints recent output
- `/proc:kill` sends SIGTERM

### Phase UI-2: Process picker

- selectable process list
- status, runtime, command, cwd
- actions: read, kill, clear

### Phase UI-3: Log overlay

- tabs per process
- stdout/stderr/combined filter
- follow mode
- search
- jump top/bottom

### Phase UI-4: Dock/status widget

- compact visible status under editor
- pinned process output tail
- alert badges
- hide/show/toggle command

UI should never be required for the agent tools to work.

## Persistence and reattach

Default mode is session-scoped:

- processes killed on pi `session_shutdown` by default, including `quit`, `reload`, `new`, `resume`, and `fork`
- metadata discarded when extension unloads
- this is intentionally conservative: losing manager state while leaving children alive creates orphans

Persistent mode later:

- explicit `persistent: true`
- metadata stored under pi/project state directory, possibly via pi custom session entries where appropriate
- logs stored in stable location
- on startup, plugin checks PIDs/process groups and marks records as running/orphaned/exited
- reattach is best-effort and backend-dependent

Persistent backend rule:

- The normal pipe backend is session-scoped only.
- Persistent processes need a persistence-capable backend: tmux, a small supervisor/daemon, or a log-file runner that does not depend on pi-owned stdout/stderr pipes.
- Do not promise persistent stdin/stdout reattach for pipe-backed children after pi exits; pipes close when the parent runtime dies.

Persistence should not be implemented until session-scoped process management is solid.

## Implementation status

Started:

- Phase 0 scaffold.
- Phase 1 core pipe manager.
- Selected Phase 2 controls: `proc_write`, `proc_signal`, `proc_clear`, and bash background blocker.

Not started:

- disk logs
- watches/alerts
- rich UI
- PTY backend
- persistence/reattach
- tmux backend

## Implementation phases

### Phase 0 — Scaffold

Files:

```text
extensions/processes/index.ts
extensions/processes/types.ts
extensions/processes/config.ts
extensions/processes/commands.ts
```

Tasks:

- keep `package.json` extension manifest compatible with directory extensions
- decide/add dev tooling (`typescript`, `vitest`, `@types/node`) if we want tests immediately
- register extension without process side effects
- register `/proc` placeholder
- fail closed on Windows with a clear notification
- verify local package install/load

Success criteria:

- `/proc` shows "no processes"
- no process execution yet
- package dry-run includes extension files

### Phase 1 — Core pipe process manager

Files:

```text
extensions/processes/output-buffer.ts
extensions/processes/runner.ts
extensions/processes/manager.ts
extensions/processes/tools.ts
```

Tasks:

- implement bounded output buffer
- implement per-process state mutation queue or equivalent race protection
- spawn shell `command`
- spawn direct `argv`
- detached process groups on Unix
- capture stdout/stderr asynchronously
- implement `proc_start`, `proc_read`, `proc_list`
- define TypeBox schemas and `StringEnum` enums
- honor abort signals for start/read waits
- update status on exit/error
- kill live processes on shutdown

Success criteria:

- start `sleep 1; echo done`
- start direct argv `node -e "console.log('hi')"`
- read by cursor
- stale cursor reports dropped output
- noisy output does not grow memory unbounded
- pi shutdown kills live process groups

### Phase 2 — Control and bash safety

Files:

```text
extensions/processes/safety.ts
```

Tasks:

- implement `proc_write`
- implement `proc_signal`
- implement `proc_clear`
- graceful kill: SIGTERM then optional SIGKILL
- process count cap
- cwd validation
- background bash blocker
- secret redaction helpers

Success criteria:

- write to `cat`, read echoed output
- stop `sleep 999`
- kill process tree, not just parent shell
- `cmd &` in bash is blocked with guidance to use `proc_start`
- process cap errors clearly

### Phase 3 — Bounded disk logs

Files:

```text
extensions/processes/logs.ts
```

Tasks:

- async log writer
- combined log and maybe split stdout/stderr logs
- log cap/rotation
- implement `proc_logs`
- include log paths in process info
- delete logs via `proc_clear`

Success criteria:

- full logs available without reading whole file into memory
- long noisy process does not exceed configured log cap
- logs clean up correctly

### Phase 4 — Watches and alerts

Files:

```text
extensions/processes/watches.ts
extensions/processes/alerts.ts
```

Tasks:

- substring watches
- regex watches with validation/caps
- one-shot/repeat watch behavior
- alert cooldowns and global budget
- pi custom messages for process failure and watch match

Success criteria:

- watch for "ready" triggers once
- repeat watch triggers with cooldown
- failure triggers agent turn by default
- noisy process cannot spam unlimited agent turns

### Phase 5 — Minimal user UI commands

Tasks:

- `/proc` list summary or selector
- `/proc:read [id|name]`
- `/proc:kill [id|name]`
- `/proc:signal [id|name] [signal]`
- `/proc:clear`
- ID/name lookup helper

Success criteria:

- user can inspect/kill/clear without model tool calls
- commands degrade gracefully without UI
- names work when unambiguous; ambiguous names ask/select

### Phase 6 — PTY backend

Files:

```text
extensions/processes/pty-runner.ts
```

Tasks:

- evaluate `node-pty` packaging with pi packages
- make PTY dependency optional if possible
- add backend selection
- support terminal size config
- improve SIGINT/stdin behavior
- preserve pipe backend as default fallback

Success criteria:

- common dev servers detect TTY correctly
- color output works naturally
- interactive prompts can receive stdin
- package install remains reliable

### Phase 7 — Rich UI

Files:

```text
extensions/processes/ui/*
```

Tasks:

- process panel
- process picker
- log overlay
- dock/status widget
- settings command

Success criteria:

- user has good live visibility
- process list and logs are searchable/navigable
- UI does not block core tool usage

### Phase 8 — Persistence / reattach

Tasks:

- stable state directory
- persistent process metadata
- reattach/liveness detection
- orphan status handling
- explicit persistent process confirmation

Success criteria:

- persistent process can survive pi restart when backend supports it
- stale metadata is reported honestly
- no surprise persistent processes by default

### Phase 9 — Optional tmux backend

Tasks:

- detect tmux
- start named sessions/windows
- capture pane output
- send keys/signals
- map tmux lifecycle into manager model

Success criteria:

- users who prefer tmux can choose it
- plugin remains self-contained without tmux

## Testing plan

### Unit tests

- output buffer truncation and sequence numbers
- stale cursor behavior
- command/argv mutual exclusion validation
- cwd validation
- process status transitions
- read after cursor
- process cap enforcement under concurrent starts
- clear/read/signal race behavior
- abort handling for read waits
- watch matching and repeat behavior
- alert cooldown budgeting
- log rotation/capping

### Integration tests

- `echo hello`
- direct argv execution
- `sleep 1; echo done`
- noisy output capped
- stdin roundtrip via `cat`
- SIGTERM/SIGKILL behavior
- child process tree cleanup
- background bash blocker
- disk log cap
- watch trigger

### Manual pi tests

- install local package
- start a dev-like long process
- continue conversation while process runs
- read output by process ID
- write to stdin
- stop process
- verify no orphan process after pi exit
- verify UI commands work
- verify package can be disabled via `pi config`

## Release plan

### Internal tags

- `v0.1.0` — scaffold + core start/read/list
- `v0.2.0` — write/signal/clear + bash blocker
- `v0.3.0` — bounded disk logs
- `v0.4.0` — watches/alerts
- `v0.5.0` — user commands/UI basics
- `v0.6.0` — PTY backend experimental
- `v0.7.0` — rich UI/dock
- `v0.8.0` — persistence experimental

### Compatibility

Keep tool names stable once introduced. Add new tools rather than changing existing schemas incompatibly.

## Risks and mitigations

### Orphan processes

Mitigation: default `killOnShutdown: true`; process groups; liveness checks; fail closed on platforms without safe tree cleanup.

### Killing the wrong process group

Mitigation: only signal process groups created by our runner; store pid/pgid from child; never accept arbitrary PID kill requests.

### Disk/memory blowup

Mitigation: bounded memory ring; max log bytes; chunk caps; truncation notices.

### Native PTY dependency pain

Mitigation: pipe backend first; PTY optional and experimental; keep package usable without native dependency.

### Platform-specific process semantics

Mitigation: v1 supports macOS/Linux only; Windows runner is separate later work.

### Agent tool misuse

Mitigation: separate tools with strict required params; clear descriptions; bash background blocker.

### Alert spam

Mitigation: one-shot watches by default; repeat cooldowns; global turn budget; visible-only notifications by default where possible.

### Secret leakage

Mitigation: do not print full env; redact common secret keys; warn that process output itself may contain secrets; optional env filtering later.

### Regex DoS

Mitigation: substring mode first; regex opt-in; cap pattern length and line length; validate regex at start.

### Persistence surprises

Mitigation: no persistence by default; explicit confirmation/config; clear visible marker for persistent processes.

## Rollback plan

If plugin misbehaves:

1. Disable package resources with `pi config`.
2. Remove package or remove extension path from `package.json`.
3. Kill live process groups via `/proc:kill`, `proc_signal`, or manual shell cleanup.
4. Delete plugin log/state directory if needed.
5. Keep prompts/skills unaffected; plugin is isolated under `extensions/processes`.

## Definition of done

The full plugin is done when:

- agent can start/read/write/signal/list/clear processes reliably
- output is cursor-based and bounded
- logs are bounded and inspectable
- process trees are cleaned up safely
- bash background hacks are blocked/guided
- user can inspect and kill from commands/UI
- watches can notify user/agent without spam
- PTY mode works for common dev tools or is clearly experimental
- disabling/removing the plugin leaves no surprise processes behind
