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

Direct user prompts typed in the Claude/Codex tab are not themselves Runtime mail. In a connected target, the agent may intentionally publish mail through its authenticated tools during a human-driven turn; it speaks as that collaborator, never as the human or another participant. This grants no Runtime lifecycle, integration, discard, review verdict, or Mission completion authority.

## Connected and durable adapters

Connected adapters add intentional participant messages and typed task publication to the same visible interactive agent. Native turn admission and durable session commit are separate capabilities requiring their own structural evidence; a reply tool call alone proves neither.

The planned primary reply channel for Claude Code and Codex is one package-owned MCP interface over the existing Runtime mailbox/task services. Provider hooks are optional observation channels, not reply extraction. Supported exact same-session attachment or future Herdr turn receipts may supply stronger evidence only after live verification.

The adapter must never:

- launch a second hidden provider session;
- replace the visible interactive agent with `claude -p`, `codex exec`, or another print-mode worker;
- scrape the pane or infer result status from prose;
- receive lifecycle, integration, or permission authority from an agent message.

### Planned communication and UX redesign

This section replaces the notify-first Codex proposal. It is a target contract, not a claim that connected native targets are implemented. Scope is collaborator communication and UX: preserve Pi's existing durable admission path, participant identity, isolated workspaces, exact lifecycle fencing, and trusted integration operations.

#### Ownership and transport

The Runtime daemon owns native-target delivery, verification, claim/submission transitions, and recovery. The launching Pi is a client, not the lifetime owner of another collaborator's communications. Delivery must continue when that Pi exits; another authorized Pi can inspect participant-addressed status.

One package-owned MCP interface exposes the same peer discovery, message send/reply/status, and task send/result/status semantics used by Pi. It reuses Runtime routing and persistence rather than creating a second mailbox system. Claude and Codex attach through supported launch configuration in their existing visible Herdr agents. MCP transport processes carry no provider conversation state; they are owned by the provider or Herdr and cannot become detached services.

MCP configuration must preserve read-only/workspace-write restrictions, exact cwd and model/persona settings, and existing hook restrictions. No broad permission bypass, enabling unrelated project hooks, new production dependency, or second provider session is implicit in this design. Provider-specific configuration and transport compatibility require proof before implementation rollout.

#### Full peer messaging and authority

A connected collaborator may discover and message existing participants in its exact project and protocol, not merely prior senders. This includes intentional tool calls from human-driven turns in its tab. Discovery exposes only bounded peer identity/status, never credentials. Ordinary terminal answers are not automatically forwarded; only an explicit authenticated publication becomes peer mail.

The MCP credential is data-plane-only, bound to the exact target/client generation, participant/holder generation, and launch configuration. Runtime derives sender identity from that binding; the model cannot supply a different sender. Credentials are kept in owner-private Runtime storage, never prompts, reports, or Pi session-history entries. A runtime-owned descriptor may carry the client credential; authorization records retain its digest. The existing same-UID trust boundary still applies.

These credentials authorize only validated peer discovery, mail, and supported task operations. They cannot acquire identities, launch or stop agents, alter profiles, checkpoint/integrate/discard workspaces, adjudicate reviews, or complete Missions. Stand-down, replacement, and stop fence subsequent publications from the old holder. Descriptor cleanup follows exact process quiescence; durable receipts are retained for recovery.

A reply must reference an exact inbound event and its recorded delivery target/holder generation; Runtime derives its recipient from that event. Changed or unrelated event/generation references fail closed. Proactive mail requires an explicit existing same-project, same-protocol recipient. Mail to vacant participants remains queued; ended recipients follow the existing rejection contract.

#### Publication, delivery, and evidence

Do not compress independent evidence into one misleading completion state:

| Evidence | What it proves | What it does not prove |
|---|---|---|
| Herdr submission receipt | Prompt submission to the verified agent | Native admission, reply, or provider commit |
| Runtime publication receipt | Authenticated peer message or typed result durably stored | Which native turn caused it, native admission, or provider commit |
| Attempt-bound native turn evidence | The exact observed native turn milestone | Unobserved milestones or durable commit |
| Provider commit/replay receipt | The specific durable session guarantee validated by that receipt | Unlimited exactly-once execution |

An MCP response reports publication success only after the Runtime event, deduplication receipt, and any task settlement are atomically durable. Wake happens after that commit and is retryable; an offline sender or failed wake cannot undo publication or cause a second message. Connection loss after commit is recovered by retrying the same operation identity, not by inventing success or blindly starting a new operation. If Runtime cannot commit, the tool returns failure/uncertainty rather than an accepted-looking response. A separate MCP spool is not required merely to duplicate Runtime's durable store.

Durable operation IDs are independent of payload and MCP request IDs. Store a separate fingerprint covering all semantic input. Same operation ID and fingerprint returns the original receipt; changed input with that ID conflicts. The single-result task invariant remains enforced by task event ID even if a caller uses another operation ID. New operation IDs for ordinary messages represent new publications; Runtime does not heuristically deduplicate identical prose or claim exactly-once model behavior. Retention bounds and retry behavior after receipt expiry must be explicit and fail closed against accidental replay.

#### Attempts, silence, and human interaction

Before Herdr submission, persist the exact target/client and participant/holder generations, claim/event/sender IDs, a fresh attempt ID, complete prompt digest, and timing/status evidence. Include the fresh attempt ID in a fixed Runtime envelope so operator retries cannot share the same correlation identity. Initially submit one event per prompt. Preserve idle/focus gating, but never assume the preceding idle check prevents a concurrent human turn.

A published reply may arrive before submission settlement; record it independently without claiming native admission or erasing ambiguous submission evidence. No submitted or ambiguous attempt is automatically replayed. Explicit operator retry uses a new attempt ID and retains the prior attempt's evidence; late results never silently settle a different attempt.

Ordinary chat has no mandatory response. Status must expose queued age, last verified delivery state, published reply IDs, and any observed turn outcome. Timeouts or missing tool calls without correlated observation mean `unobserved`/uncertain, not `no_reply`, failure, or cancellation. Only an authoritative, exact-attempt turn-end observation can establish that the observed turn ended without a publication; later explicit publications remain possible. Tasks remain unresolved/overdue until a valid typed result or a separately specified trusted cancellation operation exists. No automatic task result is inferred from elapsed time or prose.

Sender-visible status and incoming mail must work from any authorized current controller, without asking the user to inspect a collaborator tab or creating a writable workspace solely to retrieve a review. Read-only collaborators must be able to publish messages through the data plane without gaining project write permissions.

#### Observation and capabilities

Codex notifications and approved Claude lifecycle hooks may supply observation only. They never turn `last-assistant-message` or transcript text into an intentional reply. Keep their schemas bounded and validate exact launch, provider-session, attempt, and native turn bindings. Do not accept a matching prompt digest, echoed nonce, or first-seen thread ID alone as proof of attachment to the correct live provider session. Missing or ambiguous binding leaves the outcome unobserved; it cannot upgrade authority. Callback loss before durable capture remains possible and must be surfaced honestly.

A supported structured attachment to the exact visible provider session is an alternative worth proving; it is neither assumed available nor presumed to require another session. A successful proof must preserve one conversation, verifiable session/turn identity, direct tab interaction and zero focus mutation. Stronger replay/commit claims require separate evidence. Herdr turn receipts are another possible future source, not a prerequisite for MCP messaging.

Advertise capabilities per target: messaging, typed tasks, turn observation, and commit/replay evidence separately. An authenticated successful MCP handshake/round trip establishes the proven messaging capability, not every capability associated with a provider name. Task capability requires its own schema, authority and live settlement gates. A connected target without task capability still rejects typed tasks. The release tests must cover recovery and deduplication; they are not destructive per-launch probes. Missing or failed runtime capability negotiation leaves the target managed or explicitly degraded, never silently falling back to scraping. MCP messaging alone remains `connected`, not `durable`.

#### Migration and proof gates

Daemon ownership and MCP credentials require an explicit state-version and wire migration, not just moving the heartbeat loop. Preserve atomic v1–v8 migration and unknown-version rejection. Existing targets remain managed until verified replacement or an explicitly designed authenticated handoff supplies new authority. No daemon credential is recovered by scanning arbitrary Pi session history. Fence old Pi-resident delivery and new daemon delivery at the service so they cannot both submit; specify handoff, failure and rollback behavior before migration ships. Malformed persisted authority fails closed and cannot revive an older valid record.

Implementation phases, subject to separate approval:

1. **Prove the interface:** bounded read-only MCP round trips in visible Claude and Codex; reply correlation, proactive peer mail, typed task publication, permission restrictions and unchanged focus. No production migration yet.
2. **Design and migrate delivery ownership:** exact controller/credential handoff or verified replacement, service-side fencing, pending-mail preservation and rollback. Prove delivery continues after launching Pi exits and no duplicate submission during handoff/restart.
3. **Ship connected messaging and UX:** durable publication receipts, independent status evidence, retry/conflict handling, queued-age visibility, sender churn, stale credential rejection and restart recovery. Preserve Pi behavior and managed-only rejection paths.
4. **Add proven observation where useful:** exact-session/attempt correlation, human-turn interleaving, late callbacks and callback loss. Hooks cannot fabricate replies or task settlement; durable-tier advancement remains separately gated.

Inventory legacy targets and journals before any related removal. Retain `legacy-bridge/stop.ts`, worker/journal reads and compatibility until every inventoried item has explicit retirement/migration evidence. The communication redesign does not authorize speculative deletion or bypass existing workspace preservation rules.

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

- Native durable-tier transport beyond the planned MCP connected communication contract.
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
