# Hosted Runtime protocol

> **Current Runtime contract and release gates.** Universal messaging remains unreleased. Runtime accepts only state schema v13; unsupported stores fail without migration, rewriting or deletion. Interactive collaborators have no legacy headless delivery fallback.

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
   - Runtime can launch, verify, inspect, stand down, and stop the exact Herdr agent.
   - The user can interact directly in the agent's tab; automatic native prompt injection remains blocked.
   - Runtime persists ordinary mail for explicit MCP retrieval when that connection is configured.
   - Neither host readiness nor an MCP client receipt proves a semantic reply or durable provider commit.
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

Claude/Codex do **not** require MCP, hooks, or a provider plugin for managed lifecycle capability. Configured native writers can explicitly publish ordinary mail through shared MCP without upgrading their task/admission tier. Terminal answers are not automatically forwarded, and typed bounded tasks remain unavailable for managed targets. Stronger connected/durable adapters must not replace the interactive Herdr process.

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

- automatic prompt injection is blocked: Herdr does not attest editor emptiness or queued process-incarnation ownership;
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
| Mail | `mailbox.send`, `mailbox.status` |
| Tasks | `task.send`, `task.result`, `task.status` for connected/durable targets only |
| Interactive agent launch | reserve, bind, recover, and inspect an exact Herdr-managed agent target |
| Workspaces | create, reconcile, checkpoint, prepare/finalize integration, cleanup |

All methods except `hello` and initial registration require exact current authority. Mutations are idempotent on typed durable keys. Changed retries conflict.

## Target identity

### Pi target

A stable Pi target is derived from canonical project root and Pi session ID. Registration verifies the session file header, Herdr pane/terminal/session identity, canonical cwd, and exclusive live ownership. Pi receives an epoch-scoped registration key and renews it through heartbeat.

Pi advertises `durable` for its Monitor/supported-task path: the in-process extension claims pending work, writes a hidden custom message into Pi session history, and acknowledges at `message_start`. Registration reconciles historical receipts after crashes. This path excludes ordinary MCP mail; the tier label and SDK hooks do not certify fsync-based body admission.

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

1. Resolve participant, driver, model, persona, and profile independently. Normal native `workspace-write` requires fresh interactive confirmation; no UI means no launch.
2. Persist an exact launch intent before creating Git or Herdr resources.
3. Provision a Runtime-owned worktree first for `workspace-write`.
4. Create one empty no-focus Herdr tab at the exact intended cwd.
5. Call `herdr agent start <name> --kind claude|codex|pi --pane <id>` with driver-owned startup arguments after `--`.
6. Require Herdr to report readiness and either an agent-session identity or the exact generated agent name within the bounded startup deadline.
7. Reverify tab/pane/terminal/cwd/agent/managed identity.
8. Atomically bind the target, workspace, and participant holder generation.
9. Release launch evidence only after durable bind or exact absence/quiescence is proven.

The participant ID provides the stable Runtime identity. The Herdr agent name is a bounded opaque launch locator, not the participant lease key; when Herdr omits `agent_session`, that exact name is also the authenticated managed-session value.

Response-loss recovery inspects only the exact persisted Herdr resource and launch intent. It either binds the matching live agent, closes the exact unbound resource, or retains `needs_attention`; it never selects an agent by label or starts a second agent speculatively.

Normal native `workspace-write` preserves user configuration, hooks and native permission/trust prompts. Claude receives appended system context and an inline MCP server entry; Codex receives a server configuration override and startup user context, not replacement developer/system instructions. Native context references the package's shared messaging skill by absolute path instead of embedding its body; after explicit operator input, the native client must read that file before messaging. Controlled configuration hashes bind the requested arguments, shared catalog and skill content read at compilation, not ambient user settings/hooks or proof that the native client read an unchanged file. The compiler conservatively caps the single-quoted, UTF-8 launch command at 4000 bytes, before bridge launch authority or native dispatch (workspace/tab allocation can already have occurred). Oversized paths, models or persona context fail closed; no truncated prompt or alternate launcher is used. Guarded read-only retains its prior startup restrictions, including the exact Claude trust-store update and Codex trusted-project override/hook disable; it does not receive the new MCP provisioning. Never describe normal configuration as an edit-only tool boundary or automatically accept its prompts.

Native control metadata is current-only version 2: session history stores an allowlisted binding and typed lifecycle state, never launch/reconnect credentials. Immutable owner-only `native-control-*.json` artifacts bind credentials to the controller session/file/cwd and exact native target/client/holder/configuration/session/terminal/project/worktree cwd. Missing, mismatched, unsafe or corrupt artifacts fail closed; unsupported token-bearing metadata is neither migrated nor rewritten. Existing logged authority requires explicit revocation/recovery; sanitizing a later entry does not erase old secrets. These control files are separate from model-facing MCP descriptors and are retained after stop.

A consumed-register conflict may recover through one exact reconnect using the original private capability; it does not create a replacement client or namespace. Human prompts remain subject to the existing 30-second launch lease/start deadline. Timeout and hook-created worktree changes are preserved for explicit recovery, not bypassed or reset. Safe indefinite prompt continuation and broader crash/repair recovery remain unproven.

## Profiles and workspaces

`read-only` is the default. `workspace-write` requires typed launch authority and uses one Runtime-owned isolated Git worktree. No collaborator writer receives the main checkout as cwd.

Driver startup policy:

- Claude read-only: non-bypass permission mode with only native read/search tools enabled.
- Claude workspace-write: isolated worktree cwd, normal user configuration/hooks/tool permissions; no Runtime edit-only tool filter or permission bypass.
- Codex read-only: approval disabled for invisible prompts and read-only sandbox.
- Codex workspace-write: workspace-write sandbox at the isolated worktree, normal user configuration/hooks/approval policy.

The profile is Runtime launch authority, not an OS security boundary against the trusted human operating the interactive agent. Worktree cwd alone does not confine normal native hooks/tools or attest that they cannot affect other paths. A user may deliberately alter an agent's interactive settings; Runtime must not silently continue claiming the original profile after a detectable restart or identity/configuration change. Model prose cannot change profile.

Workspace ownership, checkpointing, staged integration, and cleanup follow [`WORKSPACES.md`](WORKSPACES.md). Stop retains work; finalization requires clean unchanged main and separate trusted confirmation.

## Managed mailbox delivery

Mailbox events remain durable and identity-addressed. A participant is `(canonicalProjectRoot, protocol, participantId)` in `held`, `vacant`, or `ended` state. Sender authority always binds the exact participant key and generation.

Ordinary mail is retrieved only through the shared MCP interface. It is excluded from native pending queues, claims, ACKs, reconciliation, submission and wake replay. Current-state validation rejects any ordinary-mail native delivery evidence without rewriting the store. Native Monitor and supported task delivery remain separate.

Claude/Codex automatic terminal prompt injection is blocked even when idle and unfocused. Herdr's paste/delayed-Enter queue cannot attest editor emptiness, honor cancellation throughout submission, or bind its eventual reader to an exact process incarnation. No `agent.prompt`, keystroke or full-body fallback is used for automatic mail. Direct human interaction and exact lifecycle management remain available.

Pi reference-only notification uses trusted `messaging.reference`, not an additional MCP tool. Its registration, participant/generation and attempt ID are fenced against the same sole active Pi namespace before/after host verification. A separate event-keyed record commits before the response; committed attempt retries return `acquired:false` without selecting another event. Empty polls have no durable attempt receipt. Reference records share the authority-record cap and expire with namespace evidence; no native ACK is fabricated. The single-flight Pi heartbeat checks lifecycle epoch, exact session/registration, held identity, enabled receive tool, idle/no-pending state and a known empty TUI editor before/after the call. Only `ctx.mode === "tui"` qualifies: RPC has UI dialogs but a synthetic empty editor, so RPC, other headless and unknown-editor contexts skip notification. The distinct custom message exposes only namespace/event IDs. A service-offered reference is not submitted, admitted or persisted by Pi merely because a hook or `sendMessage()` ran. Lost or ambiguous references never automatically replay; this is best-effort notification, not reliable delivery.

The managed full-body path is removed, not retained as an MCP fallback. Current `collaborator_send` returns a namespace-scoped publication receipt; `collaborator_status` reports retained delivery evidence separately. The old Pi batch-send/status registrar is removed. A caller that requires automatic structural completion must use a task-capable collaborator or a bounded Subagent instead.

Direct user prompts typed in the Claude/Codex tab are not themselves Runtime mail. With a configured MCP connection, the agent may intentionally publish mail through its authenticated tools during a human-driven turn; it speaks as that collaborator, never as the human or another participant. This grants no Runtime lifecycle, integration, discard, review verdict, or Mission completion authority.

## Connected and durable adapters

Connected adapters add intentional participant messages and typed task publication to the same visible interactive agent. Native turn admission and durable session commit are separate capabilities requiring their own structural evidence; a reply tool call alone proves neither.

Ordinary replies from Pi, Claude Code and Codex use one package-owned MCP interface over Runtime mail. Typed tasks are separate and are not exposed by MCP. Provider hooks are observation channels, not reply extraction. Supported exact same-session attachment or future Herdr turn receipts may supply stronger evidence only after live verification.

The adapter must never:

- launch a second hidden provider session;
- replace the visible interactive agent with `claude -p`, `codex exec`, or another print-mode worker;
- scrape the pane or infer result status from prose;
- receive lifecycle, integration, or permission authority from an agent message.

## Shared MCP messaging

One package-owned stdio endpoint, six schemas and the [shared skill](../../skills/collaborator-messaging/SKILL.md) serve Pi, Claude Code and Codex. Runtime owns routing, authority and persistent mail; Herdr owns interactive processes. There is no second mailbox backend, direct Pi messaging registrar, old batch-argument translation, or MCP lifecycle/task passthrough.

| Tool | Contract |
|---|---|
| `collaborator_peers` | Caller namespace/identity/expiry and up to 12 same-project/protocol peers per page. |
| `collaborator_send` | Explicit recipient, namespace, operation ID and body; atomically publishes mail and its retry receipt. |
| `collaborator_receive` | One exact event ID in the caller's namespace; persists/reuses an offer before returning the full body. |
| `collaborator_received` | Exact namespace/event/offer token; idempotently records the first client receipt without deleting the body. |
| `collaborator_reply` | Exact offer/token, operation ID and body; atomically records receipt and a correlated publication to the original sender. |
| `collaborator_status` | Original sender operation lookup, retained event and separate retrieval/client-receipt evidence. |

### Setup and authority

Pi uses a real MCP child after trusted registration restores an already-held identity, or after explicit `/runtime collaborate <protocol> <id>` acquisition. Tools recheck exact session/file/cwd and holder/client authority. Normal native writers receive the endpoint through supported launch configuration and private post-registration descriptor issuance. Their native client reads the supplied skill and calls peers after explicit human input; trust/tool prompts are not automatically accepted. Guarded read-only automatic provisioning remains unavailable.

A namespace permanently binds participant, holder generation, target, client, terminal and configuration. Credentials are owner-private, data-plane-only; authorization stores retain their digest. MCP cannot acquire identity, control processes/profiles/workspaces, settle typed tasks, adjudicate reviews or complete Missions. Exact authority is checked before and after asynchronous host verification. Stop, replacement and stand-down fence old-holder publications.

Fresh send requires exactly one eligible recipient namespace; absent or ambiguous authority rejects publication. The recipient binding is immutable. New holders/clients/namespaces do not inherit old or pre-issuance mail. Fresh reply derives the recipient from the exact inbound publication and rejects an expired/replaced original sender instead of redirecting it.

After uncertainty, look up or repeat the original operation with **identical namespace, operation ID and all arguments**. Already-committed retries recover their original receipt before checking current recipient availability; changed input conflicts. A new operation ID creates new mail. Never migrate an uncertain operation to a successor namespace.

### Evidence, bounds and recovery

Publication, reference notification, retrieval offer, explicit client receipt, native admission, provider commit and task completion are distinct. An offer does not prove the client saw the response. `receivedAt` is client receipt only; ordinary events stay native-delivery `pending` and never enter claims or ACKs. Missing replies or hints are not proof of failure or completion. Pruned status history does not undo an earlier publication.

- Bodies are limited to 16 KiB UTF-8; receive returns one complete event, not a truncated body. Runtime requests are bounded at 64 KiB, messaging responses at 128 KiB and MCP frames at 256 KiB. Authority records share a 10,000-record cap; state is capped at 8 MiB.
- Offers and publication/reference receipts protect retained bodies independently of native ACK. Namespace expiry clears its offers/receipts and retains a terminal tombstone; retention does not transfer history to a new namespace.
- Post-rename storage uncertainty fences reads/mutations until disk recovery and directory sync. Never restore an older snapshot over an uncertain commit. Cancellation is not proof of non-publication.
- Exact old-process quiescence and unresolved original operation identities must be accounted for before descriptor cleanup or replacement. Malformed authority fails closed; do not recover credentials by scanning arbitrary session history.

### Unresolved guarantees

Pi reference hints remain best-effort and are not replayed after loss or uncertainty. Automatic Claude/Codex wakes remain blocked without authoritative editor/process-incarnation/human-priority evidence. Explicit human-driven MCP mail does not upgrade native task or durable-admission capability.

Readable Pi JSONL, SDK hooks, MCP replies and client receipts do not certify fsync-based body admission or exactly-once native input consumption. A controlled daemon restart with fresh authority is not proof of atomic delivery handoff or delivery survival after the initiating Pi exits. Orphaned/expired descriptor repair and general crash/uncertain-operation interleavings remain unproven. Normal native settings/hooks are not confined by worktree cwd, and configuration hashes do not attest ambient settings or a later skill read. Broader rollout requires separate approval; historical validation records remain in Git history.

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

## Persistence and security boundary

Runtime state uses strict schema validation and atomic temporary-write/fsync/rename/directory-fsync replacement. Corruption fails closed.

The Unix socket and state rely on owner-only filesystem permissions. Current Node Unix sockets do not expose peer credentials, so Runtime is not an isolation boundary against a hostile same-UID process. Random registration/launch credentials protect against accidental and cross-wired children, not memory inspection by the same user.

Herdr is an external trusted host capability, not an npm production dependency. Runtime validates Herdr protocol responses and exact identities; it never trusts labels or focused UI state as authority.

## No headless compatibility path

Current collaborators use interactive Herdr sessions and the shared MCP interface. Headless bridge runners, hidden per-message provider processes and old argument formats are not supported release paths. Obsolete implementations still present are removal work, not fallback behavior to maintain. Existing user data remains untouched unless its exact cleanup is separately authorized.

## Deferred

- Native durable-tier admission and automatic delivery beyond explicit MCP messaging.
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
3. Native automatic admission proves exact-session ownership, editor safety and human priority without focus mutation; until then it stays blocked.
4. Busy/blocked/focused/unknown targets retain pending events.
5. Publication, reference offering, any proven submission, body retrieval, client receipt and durable admission remain separate evidence.
6. Ambiguous prompt results fail closed without automatic duplicate replay.
7. Managed targets reject typed tasks and automatic-reply claims with `capability_unavailable`.
8. Exact model/persona/profile/cwd/session identity is verified after start and restart.
9. Read-only and isolated workspace-write launches apply the intended driver startup policy.
10. Stop proves exact Herdr target/process settlement and retains workspace state.
11. Monitor and supported task admission remain intact; ordinary Pi mail is reference-notified and retrieved through actual MCP only.
12. No collaborator tab contains a bridge-runner command or hidden per-message provider process.
13. Unsupported state is rejected without rewriting or deleting existing mail, authority evidence or workspaces.
14. Confirmed-start authority and zero-focus gates still pass.
