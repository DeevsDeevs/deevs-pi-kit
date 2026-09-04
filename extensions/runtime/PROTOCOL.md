# Hosted Runtime protocol

> **Normative target contract.** This document defines the interactive Herdr-agent redesign that the Runtime implementation must converge on. Until that migration is complete, released state may still contain legacy headless bridge targets. Legacy behavior is described only in [Migration](#migration-from-headless-native-bridges); it is not the intended collaborator UX.

Runtime provides durable local routing and lifecycle authority for work that must survive Pi and Runtime restarts. Herdr owns live agent panes, terminals, process supervision, and interactive prompt submission. Runtime adds durable participant identity, mailbox state, explicit capabilities, isolated writable workspaces, and recovery.

A **collaborator is a real interactive Herdr-managed coding agent**. Pi, Claude Code, and Codex collaborators remain visible and usable in their Herdr tabs. A service process or per-message print-mode CLI is not itself a collaborator.

Runtime does not replace bounded Jobs, Subagents, Workflows, Missions, or session Cron.

## Execution primitives

| Primitive | Lifetime | User-visible interaction | Settlement | Authority |
|---|---|---|---|---|
| Job | One bounded command | No persistent tab | Exit/timeout | Parent Pi |
| Subagent | One bounded delegated run | Artifact/result | Terminal result | Parent Pi/Subagent service |
| Collaborator | Persistent named peer | Real Herdr agent tab | Explicit stand-down/stop | Runtime participant lease |
| Mission | Long-running objective | Parent Pi | Completion latch | Mission state machine |

Subagents remain the structured bounded-review/task data plane. Collaborators retain identity and conversation across turns and may receive work from either the user in their tab or another Runtime participant.

## Capability tiers

Runtime never pretends that every agent kind has identical delivery guarantees. Each target advertises structural capabilities:

1. **managed**
   - Runtime can launch, verify, prompt, inspect, stand down, and stop the exact Herdr agent.
   - The user can interact directly in the agent's tab.
   - Runtime can durably queue a message until Herdr accepts prompt submission.
   - Herdr prompt acceptance is not a semantic reply and not proof that the provider durably committed the turn.
2. **connected**
   - Includes `managed`.
   - The agent has a structured Runtime reply path that does not scrape terminal output.
   - Replies carry exact participant identity and deterministic message IDs.
3. **durable**
   - Includes `connected`.
   - The agent provides exact admission receipts, replay/no-redelivery evidence, and recoverable structured turn settlement.

Current intended tiers:

| Driver | Target | Tier | Direct tab interaction | Automatic structured reply |
|---|---|---:|---:|---:|
| Pi | Herdr Pi agent with in-process Runtime extension | durable | yes | yes |
| Claude Code | Herdr Claude agent | managed | yes | no |
| Codex | Herdr Codex agent | managed | yes | no |

Claude/Codex do **not** require MCP, hooks, or a provider plugin for managed capability. A future connected/durable adapter is additive and must not replace their interactive Herdr process. Until such an adapter exists, replies remain in the Claude/Codex tab and typed bounded tasks are unavailable for those targets.

Capability checks are typed. Runtime must return `capability_unavailable` rather than silently falling back to pane scraping, regex extraction, direct terminal input, or a hidden print-mode process.

## Core guarantees

- Monitor events, mailbox messages, participant state, and workspace ownership are persisted before delivery or host mutation.
- A live target is bound to exact project, Herdr workspace/tab/pane/terminal, agent kind, and stable agent-session identity.
- Routing and authorization consume validated IDs, generations, keys, capabilities, statuses, receipts, and confirmation booleans. Prose is display-only.
- Busy, blocked, offline, or unverifiable agents retain pending Runtime events.
- Runtime and collaborator lifecycle operations never focus a pane, tab, or workspace.
- Runtime never scrapes a pane or parses model prose to derive acknowledgement, task status, verdict, permission, or lifecycle authority.
- Direct human interaction in a collaborator tab is first-class but is not a Runtime control-plane operation.
- Runtime restart preserves durable monitors, messages, participants, launch intents, and workspaces while invalidating live registration leases.
- Stop preserves unintegrated work. Integration and destructive cleanup remain separate trusted operations.

## Explicit non-guarantees

For a `managed` Claude/Codex target:

- successful `herdr agent prompt` proves only that Herdr atomically submitted the prompt and observed the required agent lifecycle transition;
- Runtime does not claim provider exactly-once execution, durable model admission, semantic completion, or automatic reply capture;
- a provider/terminal crash after Herdr submission may lose the turn;
- an ambiguous Herdr submission may have duplicated the prompt before Runtime can classify it;
- typed task settlement and automatic Claude/Codex-to-Pi mailbox replies are rejected until a connected adapter supplies structural evidence.

These limits are surfaced in target capabilities and delivery results. They are never hidden behind a successful-looking free-form message.

## Runtime topology

Runtime reuses one healthy Unix socket per Pi agent directory. On `/runtime start` or the first Runtime-dependent operation, a missing daemon starts in the initial tab of a dedicated, no-focus `pi-kit-services` Herdr workspace rooted at the Runtime state directory.

Collaborators are different:

- each collaborator occupies a real Herdr agent tab in the requesting project workspace;
- Claude launches with `herdr agent start --kind claude`;
- Codex launches with `herdr agent start --kind codex`;
- Pi launches with `herdr agent start --kind pi`;
- the tab contains the actual interactive provider UI, never a Runtime bridge command;
- Runtime communicates through Herdr's structured agent API, not `pane run`, `pane send-*`, direct PTY bytes, or focus mutation.

The Runtime daemon may contain small driver adapters for startup arguments, identity verification, and capability declaration. Those adapters are control code inside the service/controller; they do not own a visible collaborator tab and do not spawn one provider CLI per mailbox event.

Default files:

```text
$PI_CODING_AGENT_DIR/runtime/
  instance.json
  state.v1.json
  runtime.sock
```

The directory is mode `0700`; state and socket are mode `0600`.

## Wire transport

Runtime requests and responses are newline-delimited JSON over the Unix socket. Request lines are limited to 64 KiB. Invalid framing or JSON closes the connection after an error response.

```json
{"v":1,"id":"req_...","method":"hello","params":{}}
{"v":1,"id":"req_...","ok":true,"result":{}}
{"v":1,"id":"req_...","ok":false,"error":{"code":"not_found","message":"diagnostic"}}
```

The wire version may remain v1 while methods are added compatibly. `runtimeId` persists; `epoch` changes on every service start. `hello` advertises target and delivery capabilities rather than a single misleading parity flag.

```json
{
  "version": 1,
  "runtimeId": "rt_...",
  "epoch": "epoch_...",
  "capabilities": {
    "maxDeliveryBatch": 12,
    "targets": {
      "pi": {"tier":"durable"},
      "claude-code": {"tier":"managed"},
      "codex": {"tier":"managed"}
    },
    "workspace": {"isolatedWrite":true,"stagedIntegration":true}
  }
}
```

Error codes include:

```text
invalid_request          unsupported_version     capability_unavailable
not_found                conflict                registration_stale
identity_mismatch        claim_conflict          host_unavailable
busy                     storage_error           needs_attention
internal
```

## Runtime methods

Public method names remain additive. Exact implementation naming may be introduced during migration, but responsibilities are fixed:

| Responsibility | Methods |
|---|---|
| Service | `hello` |
| Pi registration | `pi.register`, `pi.heartbeat`, `pi.unregister` |
| Monitor | `monitor.create`, `monitor.get`, `monitor.delete` |
| Inbox | `inbox.claim`, `inbox.ack`, `inbox.release`, `inbox.submit_begin`, `inbox.submit_settle`, `inbox.status` |
| Participants | `participant.acquire`, `participant.get`, `participant.list`, `participant.stand_down`, `participant.stop_confirmed`, `participant.release`, `participant.takeover` |
| Auto capacity | `participant.auto_capacity.list`, `.reserve`, `.release`, `.recover` |
| Mail | `mailbox.send`, `mailbox.status` |
| Tasks | `task.send`, `task.result`, `task.status` for connected/durable targets only |
| Interactive agent launch | reserve, bind, recover, and inspect an exact Herdr-managed agent target |
| Workspaces | create, reconcile, checkpoint, prepare/finalize integration, cleanup |

All methods except `hello` and initial registration require exact current authority. Mutations are idempotent on typed durable keys. Changed retries conflict.

## Target identity

### Pi target

A stable Pi target is derived from canonical project root and Pi session ID. Registration verifies the session file header, Herdr pane/terminal/session identity, canonical cwd, and exclusive live ownership. Pi receives an epoch-scoped registration key and renews it through heartbeat.

Pi remains `durable`: the in-process extension claims pending work, writes a hidden custom message into Pi session history, and acknowledges exact admission at `message_start`. Registration reconciles historical receipts after crashes.

### Interactive Herdr-agent target

A Claude/Codex target stores:

- closed driver key: `claude-code | codex`;
- canonical logical project root;
- requested profile and optional model/persona configuration hash;
- exact Herdr workspace, tab, pane, and terminal IDs;
- exact Herdr agent kind: `claude | codex`;
- stable managed-agent identity: Herdr session source/kind/value when exposed, otherwise Herdr agent kind plus the Runtime-generated opaque Herdr agent name;
- participant key and holder generation;
- optional Runtime workspace ID;
- capability tier;
- target generation and lifecycle state.

Display labels and terminal titles are never authoritative.

A target is live only while `herdr agent get` resolves the exact pane to the same terminal, agent kind, stable managed-agent identity, canonical cwd, and target generation. Herdr 0.8 does not expose a separate `agent_session` field for every managed driver, so Runtime generates an unguessable bounded agent name and persists `{source: herdr:<kind>, agent: <kind>, kind: id, value: <name>}` as the managed identity in that case. Unknown or mismatched identity fails closed. Pane movement is accepted only when the terminal and managed identity remain exact and Runtime atomically updates the locator.

## Interactive collaborator launch

A trusted launch is ordered:

1. Resolve participant, driver, model, persona, and profile independently.
2. Reserve Auto capacity when applicable.
3. Persist an exact launch intent before creating Git or Herdr resources.
4. Provision a Runtime-owned worktree first for `workspace-write`.
5. Create one empty no-focus Herdr tab at the exact intended cwd.
6. Call `herdr agent start <name> --kind claude|codex|pi --pane <id>` with driver-owned startup arguments after `--`.
7. Require Herdr to report readiness and either an agent-session identity or the exact generated agent name within the bounded startup deadline.
8. Reverify tab/pane/terminal/cwd/agent/managed identity.
9. Atomically bind the target, workspace, and participant holder generation.
10. Release launch capacity only after durable bind or exact absence/quiescence is proven.

The participant ID provides the stable Runtime identity. The Herdr agent name is a bounded opaque launch locator, not the participant lease key; when Herdr omits `agent_session`, that exact name is also the authenticated managed-session value.

Response-loss recovery inspects only the exact persisted Herdr resource and launch intent. It either binds the matching live agent, closes the exact unbound resource, or retains `needs_attention`; it never selects an agent by label or starts a second agent speculatively.

Persona instructions are supplied through the driver's immutable startup configuration where supported. After the trusted Runtime confirmation, Claude's owner-private trust store is atomically updated for the exact authorized launch cwd because Claude exposes no interactive trust-bypass flag; unrelated project state is preserved and concurrent changes fail closed. Codex receives an exact trusted-project override for that cwd and starts with hooks disabled. Thus neither an interactive trust prompt nor an unreviewed project hook blocks or weakens launch. If startup configuration cannot enforce the requested persona or model, launch fails rather than sending an ordinary chat message and pretending it is system authority.

## Profiles and workspaces

`read-only` is the default. `workspace-write` requires typed launch authority and uses one Runtime-owned isolated Git worktree. No collaborator writer receives the main checkout as cwd.

Driver startup policy:

- Claude read-only: non-bypass permission mode with only native read/search tools enabled.
- Claude workspace-write: exact isolated worktree cwd and explicit edit/write tools; unrestricted host shell remains disabled unless an independently enforceable sandbox exists.
- Codex read-only: approval disabled for invisible prompts and read-only sandbox.
- Codex workspace-write: approval disabled and workspace-write sandbox rooted at the isolated worktree.

The profile is Runtime launch authority, not an OS security boundary against the trusted human operating the interactive agent. A user may deliberately alter an agent's interactive settings; Runtime must not silently continue claiming the original profile after a detectable restart or identity/configuration change. Model prose cannot change profile.

Workspace ownership, checkpointing, staged integration, and cleanup follow [`WORKSPACES.md`](WORKSPACES.md). Stop retains work; finalization requires clean unchanged main and separate trusted confirmation.

## Managed mailbox delivery

Mailbox events remain durable and identity-addressed. A participant is `(canonicalProjectRoot, protocol, participantId)` in `held`, `vacant`, or `ended` state. Sender authority always binds the exact participant key and generation.

For a Pi recipient, existing durable claim/admission/ack semantics remain unchanged.

For a managed Claude/Codex recipient:

```text
pending -> submitting -> submitted
                     \-> pending          (proved not submitted)
                     \-> needs_attention  (ambiguous submission)
```

Rules:

- Runtime stores the event before attempting Herdr delivery.
- Delivery occurs only to the exact verified target.
- Automatic delivery does not run while the target is `working`, `blocked`, unknown, or focused; user interaction has priority.
- Runtime calls only `herdr agent prompt` with the complete bounded message and waits for Herdr's typed prompt result.
- Runtime never calls `pane.send_text`, `pane.send_keys`, or screen-parses a response.
- Herdr rejection or `agent_prompt_stalled` returns the event to pending when non-submission is proven.
- Connection loss or an unclassifiable result after submission begins becomes `needs_attention`; Runtime does not guess whether replay is safe.
- Successful Herdr submission records `submitted`, not Pi-style `acked` and not semantic completion.
- A submitted event is retained for audit and explicit operator retry; Runtime does not automatically replay it.
- The agent's response remains visible in its tab. Runtime does not synthesize a sender-authenticated reply from terminal text.

The `collaborator_send` result therefore exposes recipient tier and delivery state. A caller that requires automatic structural completion must use a connected/durable collaborator or a bounded Subagent instead.

Direct user prompts typed in the Claude/Codex tab bypass Runtime mail by design. They do not impersonate another participant and cannot authorize Runtime lifecycle, integration, discard, review verdicts, or Mission completion.

## Connected and durable adapters

A future adapter may upgrade an interactive target without replacing it. It must attach to the same Herdr agent/session and provide a structured agent-owned channel for:

- exact mailbox admission receipts;
- deterministic outbound participant messages;
- typed task settlement;
- session advancement and replay evidence.

MCP, provider hooks, plugins, app-server protocols, or future Herdr structured turn events are candidate mechanisms, not protocol requirements. One is adopted only after proving identity, durability, restart, and no-redelivery behavior for a real driver.

The adapter must never:

- launch a second hidden provider session;
- replace the visible interactive agent with `claude -p`, `codex exec`, or another print-mode worker;
- scrape the pane or infer result status from prose;
- receive lifecycle, integration, or permission authority from an agent message.

### Planned Codex connected adapter

The first Codex upgrade targets `connected`, not `durable`. It attaches to the same visible interactive Codex process through Codex's structured `agent-turn-complete` notification. General user and project hooks remain disabled; launch configures only a package-owned top-level `notify` command. The notification command receives a Runtime-owned descriptor path, while Codex appends its structured JSON payload as the final argument.

The descriptor is created before launch with owner-only permissions and contains a launch-scoped, reply-only credential. Runtime stores only its digest with the exact target and participant generation. The credential authorizes submission of a completion notification only; it cannot register a target, send arbitrary participant mail, settle tasks, or perform lifecycle, workspace, review, or Mission operations. Exact stop invalidates the credential and removes its descriptor after process quiescence.

Connected automatic replies apply to one `mailbox.message` per submission. Other event types retain their existing managed semantics until they have an explicit structured reply route. Before calling `herdr agent prompt`, Runtime must durably record one pending turn containing:

- target key, target client generation, participant key, and holder generation;
- claim, inbound event, submission-attempt, and original sender IDs;
- a digest of the complete prompt submitted to Herdr;
- creation and expiry times plus a typed `submitting | submitted | completed | needs_attention` state.

The notification adapter accepts only the exact bounded Codex payload shape for `type: "agent-turn-complete"`, including `thread-id`, `turn-id`, `cwd`, `input-messages`, and `last-assistant-message`. Runtime accepts it only when the reply credential, live target generation, held participant generation, canonical cwd, pending attempt, and digest of `input-messages` all match. Missing, malformed, stale, ambiguous, or cross-wired evidence fails closed.

An accepted completion atomically:

1. marks the matching turn `completed`;
2. records the Codex thread and turn IDs;
3. creates one participant-authenticated mailbox reply addressed to the original sender; and
4. wakes that sender's current exact target.

The reply ID is deterministic over the target generation and Codex thread/turn IDs. An exact duplicate callback is idempotent; reuse with changed input or output conflicts. `last-assistant-message` is untrusted message body only and never controls status or authority. A callback with no matching Runtime attempt—including a prompt typed directly by the user—is ignored or retained as non-authoritative diagnostics and cannot impersonate a participant.

The adapter writes an owner-private bounded spool record before socket delivery. Runtime consumes or replays accepted records after restart and deduplicates them by reply ID. A completion may arrive before or after Herdr submission settlement; matching structured completion is stronger evidence that the prompt ran, while an unrelated or mismatched completion never resolves `submitting` or `needs_attention`.

This transport remains `connected` because Codex launches the notification command asynchronously: a process or host failure can occur before the adapter durably spools the payload. Runtime must not advertise provider admission, exactly-once execution, no-loss delivery, or the `durable` tier from this mechanism. Typed tasks also remain unavailable because the notification exposes assistant text, not a schema-authoritative `completed | failed | cancelled` result. A later durable upgrade requires authenticated Codex app-server or Herdr turn receipts with replay and no-redelivery evidence.

Introducing connected-target credentials and pending-turn records requires a new explicit Runtime state version with atomic v8 migration. Existing targets migrate as `managed`; migration never invents a credential, session binding, pending turn, or stronger capability.

Connected capability is advertised only after launch configuration, callback authentication, spool recovery, exact deduplication, and a real structured round trip all succeed. Any failed gate leaves that target `managed` and preserves the existing submission-only behavior.

## Typed tasks

`collaborator_task` is additive to free-form mail. It is available only when the recipient advertises `connected` or `durable` task capability.

A task result contains schema-validated `completed | failed | cancelled`, exact request/reply IDs, bounded body, session advancement evidence, and optional Runtime-derived workspace evidence. The responder cannot forge workspace identity. Task status never authorizes lifecycle, profile escalation, checkpoint, integration, discard, review verdict, or Mission completion.

Sending a typed task to a managed-only Claude/Codex target returns `capability_unavailable`. The caller may instead prompt it as free-form interactive work or use a bounded Subagent.

## Stop, stand-down, and recovery

- Stand-down vacates participant availability while preserving the exact interactive agent and workspace for later controlled replacement or recovery.
- Stop targets only the exact Runtime-managed Herdr agent/tab generation.
- Runtime requests Herdr closure and waits for exact agent/tab absence and process-tree settlement before vacating the participant.
- Missing or mismatched identities, ambiguous closure, or surviving owned processes become `needs_attention`.
- Stop never deletes a workspace or unintegrated changes.
- Release, revival, takeover, integration, and destructive cleanup remain separate trusted operations.

No model prose can request or confirm these transitions.

## Monitor and Pi admission

A Monitor observes newly created direct-child regular files beneath one canonical non-symlink directory. Existing files form a non-emitting baseline. `fs.watch` is only a latency hint; startup, hints, and fallback reconciliation use the same authoritative scan. Cursor and event state commit atomically before notification.

Monitor events follow:

```text
pending -> claimed -> acked
                  \-> pending  (release or lease expiry)
```

Pi receives pending work through its in-process heartbeat. Runtime does not prompt or focus a Pi pane. The Pi extension claims a bounded batch, writes one hidden model-visible custom message, and acknowledges at `message_start`. Historical session receipts close the post-admission/pre-ack crash window.

Monitor scope remains direct-child creation only; recursive/content/modification/deletion monitoring is deferred.

## Auto mode

Global collaborator mode is typed, persistent state and defaults/fails closed to MANUAL. `Shift+Tab` and `/runtime auto on|off|toggle` are trusted UI operations after explicit shortcut setup.

AUTO may start, stand down, stop, or later restart collaborators within:

- four concurrent starts;
- twelve held-or-reserved collaborators;
- `workspace-write` maximum profile.

AUTO never authorizes release, revival, takeover, main-tree integration, destructive discard, or permission escalation from collaborator prose. Capacity is durably reserved before Git or Herdr resources are created. Ambiguous launches retain reservations and recovery evidence.

## Persistence and security boundary

Runtime state uses strict schema validation and atomic temporary-write/fsync/rename/directory-fsync replacement. Corruption fails closed.

The Unix socket and state rely on owner-only filesystem permissions. Current Node Unix sockets do not expose peer credentials, so Runtime is not an isolation boundary against a hostile same-UID process. Random registration/launch credentials protect against accidental and cross-wired children, not memory inspection by the same user.

Herdr is an external trusted host capability, not an npm production dependency. Runtime validates Herdr protocol responses and exact identities; it never trusts labels or focused UI state as authority.

## Migration from headless native bridges

The released v7 implementation may contain `kind: "bridge"` targets whose visible tab runs `bridge-runner/main.ts` and whose controller spawns `claude -p` or `codex exec` once per message. Those targets are legacy.

Migration requirements:

1. Do not mutate a live legacy target in place.
2. Stand down or stop the exact legacy generation with existing worker-group quiescence rules.
3. Retain any workspace and pending/attention journal evidence.
4. Create a new interactive Herdr-agent target generation through the launch sequence above.
5. Preserve participant mail ordering and workspace handoff references without reusing bridge credentials.
6. Remove legacy controller tabs only after exact stop settles.
7. Delete production `claude -p`/`codex exec` collaborator launch paths after migration gates pass.

The old durable runner may remain only if a separately named bounded execution primitive still needs it. It must not be called a collaborator, hold a collaborator participant lease, or occupy a collaborator tab.

## Deferred

- Connected/durable Claude reply adapters.
- Durable Codex turn transport beyond the planned connected notification adapter.
- Recursive/content/modification/deletion monitoring.
- Collaborator groups, broadcasts, and attachments.
- Durable schedules and automatic takeover.
- Native service installers and Windows transport.
- Public driver/plugin SDK.
- Full host-access collaborator profile.

## Release gates

The redesign is releasable only when isolated and live gates prove:

1. Claude and Codex launch through `herdr agent start` into real interactive tabs.
2. The user can type directly and receive responses in both tabs.
3. Runtime can submit a prompt through `herdr agent prompt` without focus mutation.
4. Busy/blocked/focused/unknown targets retain pending events.
5. Successful managed delivery records `submitted`, never durable admission or semantic completion.
6. Ambiguous prompt results fail closed without automatic duplicate replay.
7. Managed targets reject typed tasks and automatic-reply claims with `capability_unavailable`.
8. Exact model/persona/profile/cwd/session identity is verified after start and restart.
9. Read-only and isolated workspace-write launches apply the intended driver startup policy.
10. Stop proves exact Herdr target/process settlement and retains workspace state.
11. Pi durable collaborator behavior and Monitor admission remain unchanged.
12. No collaborator tab contains a bridge-runner command or hidden per-message provider process.
13. Legacy state migration retains mail, participant generations, attention evidence, and workspaces.
14. Manual and Auto capacity, authority, and zero-focus gates still pass.
