# Hosted Runtime protocol

Runtime is a local daemon providing durable Monitor delivery to one exact Pi session, durable participant identity, durable mail, and
lifecycle authority over persistent collaborators living in Herdr tabs, which owns processes, panes, and interactive input. Runtime
accepts only state schema v17; unsupported stores fail closed. Collaborators keep identity and conversation across turns; use a Subagent
for bounded structured work.

## Execution primitives

| Primitive | Lifetime | Interaction | Settlement | Authority |
|---|---|---|---|---|
| Job | One bounded command | No tab | Exit/timeout | Parent Pi |
| Subagent | One bounded delegated run | Result artifact | Terminal result | Subagent service |
| Collaborator | Persistent named peer | Real Herdr agent tab | Stand-down/stop | Runtime participant lease |
| Mission | Long-running objective | Parent Pi | Completion latch | Mission state machine |

## Guarantees and non-guarantees

Guaranteed:
- Monitor events, mail, and participant state persist before delivery or host mutation, and a live target binds exact project, Herdr
  workspace/tab/pane/terminal, agent kind, and agent session. Restart preserves them all, invalidating registration leases.
- Authorization consumes validated IDs, generations, keys, and confirmation booleans; prose is display-only, and busy, blocked, offline,
  or unverifiable targets retain pending events. No operation focuses or scrapes a pane; stop preserves collaborator worktrees.

Not guaranteed:
- No automatic prompt injection into a Claude/Codex tab, no reply capture from terminal output, and no claim of provider exactly-once
  execution, durable model admission, or semantic completion.
- Worktree cwd is launch authority, not an OS boundary, and Runtime is no isolation boundary against a hostile same-UID process.

## Topology

One Unix socket per Pi agent directory. A missing daemon starts in the initial tab of a dedicated no-focus `pi-kit-services` Herdr
workspace rooted at the Runtime state directory. Each collaborator instead occupies a real Herdr agent tab in the requesting project
workspace, started with `herdr agent start --kind pi|claude|codex`; that tab holds the real provider UI, never a Runtime bridge command,
and Runtime drives it only through Herdr's structured agent API — never `pane run`, `pane send-*`, PTY bytes, or focus mutation. State is
`instance.json`, `state.v1.json`, `runtime.sock`, and `workspaces/<participantId>/` under `$PI_CODING_AGENT_DIR/runtime/`, a mode `0700`
directory holding mode `0600` files.

## Wire transport

Newline-delimited JSON over the Unix socket, capped at 64 KiB per request line and 128 KiB per messaging response. Invalid framing or
JSON closes the connection after an error response.

```json
{"v":1,"id":"req_...","method":"hello","params":{"minVersion":1,"maxVersion":1}}
{"v":1,"id":"req_...","ok":false,"error":{"code":"not_found","message":"diagnostic"}}
```

`runtimeId` persists; `epoch` changes on every service start. `hello` returns `{version, runtimeId, epoch, capabilities}`, carrying
`agentWake`, `maxDeliveryBatch`, `targets`, `monitor`, and — when the matching authority is loaded — `mailbox`, `interactiveAgent`, and
`worktree`. Error codes: `invalid_request`, `unsupported_version`, `capability_unavailable`, `not_found`, `conflict`, `busy`,
`registration_stale`, `identity_mismatch`, `claim_conflict`, `host_unavailable`, `storage_error`, `internal`.

## Methods

| Responsibility | Methods |
|---|---|
| Service | `hello` |
| Pi registration | `pi.register`, `pi.heartbeat`, `pi.unregister` |
| Interactive agent | `bridge.bind`, `bridge.heartbeat`, `bridge.unregister` |
| Monitor | `monitor.create`, `monitor.get`, `monitor.delete` |
| Inbox and wake | `inbox.claim`, `inbox.ack`, `inbox.release`, `inbox.status`, `wake.accept` |
| Participants | `participant.acquire`, `participant.get`, `participant.list`, `participant.stand_down`, `participant.stand_down_confirmed`, `participant.stop_confirmed`, `participant.release`, `participant.takeover` |
| Mail | `mailbox.send`, `mailbox.status` |
| Messaging | `messaging.issue`, `messaging.peers`, `messaging.send`, `messaging.status`, `messaging.receive`, `messaging.received`, `messaging.reply` |
| Worktrees | `worktree.ensure`, `worktree.list`, `worktree.remove` |

Every method except `hello` and initial registration requires exact current authority. Mutations are idempotent on typed durable keys.

## Target identity

A **Pi target** is canonical project root plus Pi session ID; registration verifies the session file header, Herdr pane/terminal/session
identity, canonical cwd, and exclusive live ownership, then issues an epoch-scoped registration key renewed by heartbeat. A
**Claude/Codex target** is keyed `agent_<sha256(projectRoot\0agentName)>` on the Runtime-generated Herdr agent name, and stores the driver
key, Herdr managed-agent session, exact workspace/tab/pane/terminal IDs, participant key and held generation, requested profile, optional
worktree path, and the client generation its MCP descriptor is bound to. Labels and terminal titles are never authoritative: the target is
live only while `herdr agent get <name>` resolves the same name, kind, managed session, pane/tab/workspace/terminal, and canonical cwd,
and its participant generation is still held. Mismatch fails closed — registration goes stale, the participant vacates through stop.

## Collaborator launch

1. Resolve participant, driver, model, persona, and profile independently (`workspace-write` requires fresh interactive confirmation),
   and read the child participant's generation as the expected reservation: absent, or `vacant` at that generation.
2. Provision the `workspace-write` worktree, reusing an existing checkout, then create one empty no-focus Herdr tab at the intended cwd.
3. Run `herdr agent start <collab-hash> --kind pi|claude|codex --pane <id>` with driver-owned startup arguments after `--`.
4. Call `bridge.bind` with held participant authority, agent name, driver, profile, and client and expected participant generations; it is
   idempotent for that exact tuple, so an uncertain response is retried.
5. Runtime re-verifies `herdr agent get`, binds the target and acquires the participant in one state operation, then hands the
   registration back to the launching Pi.

A failure before `herdr agent start` closes the created tab; a failure after it preserves the tab and reports `needs_attention`. There are
no launch, reconnect, or reservation tokens — the participant generation is the only lease. Claude receives appended system context and an
inline MCP server entry, Codex a server-configuration override and startup user context; both reference the shared messaging skill by
absolute path, and the launch command is capped at 4000 bytes and fails closed rather than truncating.

## Worktrees

`read-only` is the default. `workspace-write` gets one Runtime-owned worktree at `<runtimeRoot>/workspaces/<participantId>` on branch
`runtime/collab/<participantId>`; no writer gets the main checkout as cwd, and Runtime verifies the cwd is a separate worktree of the same
repository. Runtime owns only creation, listing, and confirmed removal, never commits or merges; stop retains the worktree, and
`worktree.remove` force-removes it and deletes its branch after a trusted confirmation.

## Mailbox and MCP messaging

A participant is `(canonicalProjectRoot, protocol, participantId)` in `held`, `vacant`, or `ended` state. Mail is addressed to the
participant: a later namespace of the same held participant reads it, and mail to a vacant participant queues for its next holder. Two
durable records exist — a **namespace** (one credential per target and client generation: participant, holder generation, secret digest,
expiry, operation-ID to event-ID map) and a **message** `{eventId, from, to, body, inReplyToEventId?, createdAt, readAt?}`. Ordinary mail
is retrieved only through the package-owned stdio MCP endpoint and its six tools
([shared skill](../../skills/collaborator-messaging/SKILL.md)): `collaborator_peers`, `collaborator_send`, `collaborator_receive`,
`collaborator_received`, `collaborator_reply`, `collaborator_status`. It never enters native pending queues, claims, ACKs, or
reconciliation, so a retained event's `delivery.status` stays `pending`. Pi's notification instead rides the `pi.heartbeat` response: with
exactly one live namespace, the reply carries the `namespaceId` and `eventId` of the oldest unread message, offered once per session, only
in `ctx.mode === "tui"` with an idle session and known-empty editor. That hint is notification, not delivery.

Bodies are capped at 16 KiB UTF-8, namespaces and operation records share a 10,000-record cap, and state is capped at 8 MiB. After
uncertainty, repeat the original operation with identical namespace, operation ID, and arguments: a repeat returns the original event,
changed input conflicts, a new operation ID creates new mail. MCP cannot acquire identity, control processes, profiles, or worktrees.

## Monitor and Pi admission

A Monitor observes newly created direct-child regular files under one canonical non-symlink directory; existing files form a non-emitting
baseline. `fs.watch` is a latency hint only — startup, hints, and reconciliation use the same authoritative scan. Cursor and event state
commit atomically before notification, and events move `pending -> claimed -> acked`, returning to `pending` on release or lease expiry.
Pi claims a bounded batch through its in-process heartbeat, writes one hidden model-visible custom message, and acknowledges at
`message_start`; registration reconciles historical session receipts after a crash. Runtime never prompts or focuses a Pi pane.

## Stop, stand-down, recovery

- Stand-down vacates participant availability, preserving the agent, its worktree, and queued mail.
- Stop targets only the exact Runtime-managed agent/tab generation, waits for agent/tab absence and process-tree settlement before
  vacating the participant, and never deletes a worktree. Missing or mismatched identity, ambiguous closure, or surviving owned
  processes become `needs_attention`.
- Release, revival, takeover, and worktree removal are separate trusted operations; no model prose can request or confirm one.

## Persistence and security boundary

Pi persists its Runtime collaboration state in one hidden session entry, `deevs.hosted-runtime.v2`: participant identity, launch metadata,
worktree, and managed native agent controls. Each append writes the current record and restore reads the last one on the branch; older
entry kinds are ignored rather than migrated, and a malformed record fails closed. Runtime state uses strict schema validation with atomic
write/fsync/rename/directory-fsync replacement, and corruption fails closed. Socket and state rely on owner-only permissions, and Node
Unix sockets expose no peer credentials, so random credentials protect against accidental and cross-wired children only. Herdr is an
external trusted host capability, not an npm dependency; Runtime validates its responses and never trusts labels.

## Known limitations

- Automatic native wakes are not implemented: Claude/Codex mail waits for explicit human input in the tab.
- An MCP client receipt is not provider admission; `readAt` proves neither a durable commit nor task completion, and Pi mail hints are not
  replayed after loss. Guarded native read-only launches do not receive automatic MCP provisioning, and monitoring stays direct-child
  creation only — no collaborator groups, broadcasts, attachments, or durable schedules either.
