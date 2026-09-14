# Hosted Runtime protocol

Runtime is a local daemon providing durable Monitor delivery to one exact Pi session, durable participant identity, durable mail, and
lifecycle authority over persistent collaborators living in Herdr tabs, which owns processes, panes, and interactive input. Runtime
accepts only state schema v19; unsupported stores fail closed. Collaborators keep identity and conversation across turns; use a Subagent
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
- Monitor events, mail, and participant state persist before delivery or host mutation, and a live target binds its exact project plus
  either its Pi session file or its Herdr agent name. Restart preserves them all, invalidating registration leases.
- Authorization consumes validated IDs, generations, keys, and confirmation booleans; prose is display-only, and busy, blocked, offline,
  or unverifiable targets retain pending events. No operation focuses or scrapes a pane; stop preserves collaborator worktrees.

Not guaranteed:
- Delivery is at-least-once, never exactly-once: a Pi that dies between hand-out and ack is handed the same batch again once its claim
  expires, and only Pi's durable seen-set keeps that duplicate out of the session.
- No automatic prompt injection into a Claude/Codex tab, no reply capture from terminal output, and no claim of provider exactly-once
  execution, durable model admission, or semantic completion.
- Worktree cwd is launch authority, not an OS boundary, and Runtime is no isolation boundary against a hostile same-UID process.

## Topology

One Unix socket per Pi agent directory. A missing daemon starts in the initial tab of a dedicated no-focus `pi-kit-services` Herdr
workspace rooted at the Runtime state directory. Each collaborator instead occupies a real Herdr agent tab in the requesting project
workspace, started with `herdr agent start --kind pi|claude|codex`; that tab holds the real provider UI, never a Runtime bridge command,
and Runtime drives it only through Herdr's structured agent API — never `pane run`, `pane send-*`, PTY bytes, or focus mutation. State is
`instance.json`, `state.v1.json`, `runtime.sock`, and `workspaces/<protocol>__<participantId>/` under `$PI_CODING_AGENT_DIR/runtime/`, a mode `0700`
directory holding mode `0600` files.

## Wire transport

Newline-delimited JSON over the Unix socket, capped at 64 KiB per request line and 128 KiB per messaging response. Invalid framing or
JSON closes the connection after an error response. Every method declares one TypeBox params schema; the dispatcher validates the
envelope and those params — unknown fields, bad syntax, and out-of-bound sizes included — before it resolves any capability, so a
malformed call is always `invalid_request`.

```json
{"v":1,"id":"req_...","method":"hello","params":{"minVersion":1,"maxVersion":1}}
{"v":1,"id":"req_...","ok":false,"error":{"code":"not_found","message":"diagnostic"}}
```

`runtimeId` persists across service starts. `hello` returns `{version, runtimeId, capabilities}`, carrying
`agentWake`, `maxDeliveryBatch`, `targets`, `monitor`, and — when the matching authority is loaded — `mailbox`, `interactiveAgent`, and
`worktree`. Error codes: `invalid_request`, `unsupported_version`, `capability_unavailable`, `not_found`, `conflict`, `busy`,
`registration_stale`, `identity_mismatch`, `host_unavailable`, `storage_error`, `internal`.

## Methods

| Responsibility | Methods |
|---|---|
| Service | `hello` |
| Pi registration | `pi.register`, `pi.heartbeat`, `pi.unregister` |
| Interactive agent | `bridge.bind`, `bridge.heartbeat`, `bridge.unregister` |
| Monitor | `monitor.create`, `monitor.get`, `monitor.delete` |
| Inbox | `inbox.ack`, `inbox.status` |
| Participants | `participant.acquire`, `participant.get`, `participant.list`, `participant.stand_down`, `participant.stand_down_confirmed`, `participant.stop_confirmed`, `participant.release`, `participant.takeover` |
| Mail | `mailbox.send` |
| Messaging | `messaging.issue`, `messaging.peers`, `messaging.send`, `messaging.status`, `messaging.receive`, `messaging.received`, `messaging.reply` |
| Worktrees | `worktree.ensure`, `worktree.list`, `worktree.remove` |

Every method except `hello` and initial registration requires exact current authority. Mutations are idempotent on typed durable keys.

## Target identity

Identity is five lines, and nothing else:

1. A client is trusted exactly while it presents the registration ID and key Runtime minted for its target; each `pi.register` or
   `bridge.bind` mints a fresh pair and drops the target's previous one.
2. A **Pi target** is keyed `pi_<piSessionId>` and is live while its session file header still carries that session ID and its canonical
   project or worktree cwd.
3. A **Claude/Codex target** is keyed `agent_<projectHash>_<agentName>` — a plain Herdr agent name, prefixed only because two projects
   may use the same name — and is live while `herdr agent get <name>` reports that name with that canonical cwd.
4. The participant generation on the lease is the collaborator's identity; an agent target is live only while its participant is still
   held at the generation the bind recorded.
5. The stored tab and workspace IDs exist so stop can close the exact tab Runtime opened; they are never re-verified as identity.

Labels and terminal titles are never authoritative. Mismatch fails closed — registration goes stale, the participant vacates through stop.

## Collaborator launch

One confirmation, then one path for every driver — a driver table supplies each driver's agent kind, startup argv, started-agent check and
profile tool policy, and nothing else branches on the driver.

1. Resolve participant, driver, model, persona, and profile independently, and confirm the whole batch once (driver, model, persona,
   profile, project); `workspace-write` is part of that same confirmation. The child participant's generation — absent, or `vacant` at that
   generation — is the expected reservation.
2. Provision the `workspace-write` worktree, reusing an existing checkout, then create one empty no-focus Herdr tab at the intended cwd.
3. Run `herdr agent start <collab-hash> --kind pi|claude|codex --pane <id>` with the driver's startup arguments after `--`, and accept the
   started agent only when its name, pane, terminal and agent kind are the authorized ones.
4. Native drivers call `bridge.bind` with held participant authority, agent name, driver, profile, and the expected participant generation;
   it is idempotent for that exact tuple, so an uncertain response is retried. Pi registers itself from its prepared session and its tab
   identity bootstrap instead.
5. Runtime re-verifies `herdr agent get`, binds the target and acquires the participant in one state operation, then hands the
   registration back to the launching Pi, which records the reconnection authority.

Any failing step stops what that launch started — the tab and any prepared session — and reports the original error. A half-launched
collaborator is never preserved, and a failed start records no authority. There are
no launch, reconnect, or reservation tokens — the participant generation is the only lease. Claude receives appended system context and an
inline MCP server entry, Codex a server-configuration override and startup user context; both reference the shared messaging skill by
absolute path, and the launch command is capped at 4000 bytes and fails closed rather than truncating.

## Worktrees

`read-only` is the default. `workspace-write` gets one Runtime-owned worktree at `<runtimeRoot>/workspaces/<protocol>__<participantId>` on branch
`runtime/collab/<protocol>/<participantId>`; no writer gets the main checkout as cwd, and Runtime verifies the cwd is a separate worktree of the same
repository. Runtime owns only creation, listing, and confirmed removal, never commits or merges; stop retains the worktree, and
`worktree.remove` force-removes it and deletes its branch after a trusted confirmation.

## Mailbox and MCP messaging

A participant is `(canonicalProjectRoot, protocol, participantId)` in `held`, `vacant`, or `ended` state. Mail is addressed to the
participant: a later namespace of the same held participant reads it, and mail to a vacant participant queues for its next holder. Two
durable records exist — a **namespace** (one credential per target registration: participant, holder generation, secret digest,
expiry, operation-ID to event-ID map) and a **message** `{eventId, from, to, body, inReplyToEventId?, createdAt, readAt?}`. Ordinary mail
is retrieved only through the package-owned stdio MCP endpoint and its six tools
([shared skill](../../skills/collaborator-messaging/SKILL.md)): `collaborator_peers`, `collaborator_send`, `collaborator_receive`,
`collaborator_received`, `collaborator_reply`, `collaborator_status`. It never enters native delivery: only Monitor events are handed to a
target, and a mail event carries no delivery state at all. Pi's notification instead rides the `pi.heartbeat` response: with
exactly one live namespace, the reply carries the `namespaceId` and `eventId` of the oldest unread message, offered once per session, only
in `ctx.mode === "tui"` with an idle session and known-empty editor. That hint is notification, not delivery.

Bodies are capped at 16 KiB UTF-8, namespaces and operation records share a 10,000-record cap, and state is capped at 8 MiB. After
uncertainty, repeat the original operation with identical namespace, operation ID, and arguments: a repeat returns the original event,
changed input conflicts, a new operation ID creates new mail. MCP cannot acquire identity, control processes, profiles, or worktrees.

## Monitor and Pi admission

A Monitor observes newly created direct-child regular files under one canonical non-symlink directory; existing files form a non-emitting
baseline. `fs.watch` is a latency hint only — startup, hints, and reconciliation use the same authoritative scan. Cursor and event state
commit atomically before notification, and an event is undelivered until an ack stamps its `deliveredAt`.

Delivery is at-least-once through one path. Pi's two-second `pi.heartbeat` carries `admit` while the session is idle with no pending
messages; the reply then carries up to `maxDeliveryBatch` undelivered events for that target and records one claim, keyed by target key
and holding nothing but its expiry, so a second heartbeat hands out nothing until that claim is acked or expires. Pi writes one hidden
model-visible custom message, appends those event IDs to a bounded durable seen-set (1,000 IDs, oldest pruned) in its hidden session
entry, and calls `inbox.ack`. A crash before the ack re-hands the batch; the seen-set is what keeps it from being admitted twice.
Runtime never prompts or focuses a Pi pane.

## Stop, stand-down, recovery

- Stand-down vacates participant availability, preserving the agent, its worktree, and queued mail.
- Stop targets only the exact Runtime-managed agent/tab generation, waits for agent/tab absence and process-tree settlement before
  vacating the participant, and never deletes a worktree. Missing or mismatched identity, ambiguous closure, or surviving owned
  processes become `needs_attention`.
- Release, revival, takeover, and worktree removal are separate trusted operations; no model prose can request or confirm one.

## Persistence and security boundary

Pi persists its Runtime collaboration state in one hidden session entry, `deevs.hosted-runtime.v3`: participant identity, launch metadata,
worktree, managed native agent controls, and the bounded seen-set of admitted event IDs. Each append writes the current record and restore reads the last one on the branch; older
entry kinds are ignored rather than migrated, and each section of the record is schema-checked on restore: a malformed section is dropped
or demoted to `needs_attention`, never repaired. Runtime state is validated by one TypeBox schema per persisted record against the root
state schema, then by a single cross-reference check (held participants resolve to a same-project target, mail resolves to existing
participants, delivery claims resolve to existing targets) and the messaging record capacity bound. Validation runs on load and before every atomic
write/fsync/rename/directory-fsync replacement, and corruption fails closed. Socket and state rely on owner-only permissions, and Node
Unix sockets expose no peer credentials, so random credentials protect against accidental and cross-wired children only. Herdr is an
external trusted host capability, not an npm dependency; Runtime validates its responses and never trusts labels.

## Known limitations

- Automatic native wakes are not implemented: Claude/Codex mail waits for explicit human input in the tab.
- An MCP client receipt is not provider admission; `readAt` proves neither a durable commit nor task completion, and Pi mail hints are not
  replayed after loss. Guarded native read-only launches do not receive automatic MCP provisioning, and monitoring stays direct-child
  creation only — no collaborator groups, broadcasts, attachments, or durable schedules either.
