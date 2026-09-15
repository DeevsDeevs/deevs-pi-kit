# Runtime protocol

Runtime is a local daemon with two jobs: durable participant identity and mail, and lifecycle authority over persistent collaborators living in real Herdr agent tabs. It accepts only state schema v23; a store written by another version is discarded and the daemon starts fresh.

## Primitives

| Primitive | Lifetime | Interaction | Settlement | Authority |
|---|---|---|---|---|
| Job | One bounded command | No tab | Exit or timeout | Parent Pi |
| Subagent | One bounded delegated run | Result artifact | Terminal result | Subagent service |
| Collaborator | Persistent named peer | Real Herdr agent tab | Stand-down or stop | Participant generation |
| Mission | Long-running objective | Parent Pi | Completion latch | Mission state machine |

## Guarantees

**Durable before observable.** Mail and participant state commit to disk before any response or host mutation and survive restart, and every mutation is idempotent on a typed durable key, so an uncertain call is resolved by repeating it rather than by inventing a new identifier. A background sweep expires grants and drops mail past the retention window. Exactly-once provider execution, durable model admission and semantic completion are not guaranteed.

**Identity is the registration key plus `herdr agent get`.** A client is trusted exactly while it presents the registration ID and key Runtime minted for its target; each `pi.register` or `bridge.bind` mints a fresh pair and drops the previous one. A Pi target `pi_<piSessionId>` is live while its session file header still carries that session ID and canonical cwd; a native target `agent_<projectHash>_<agentName>` is live while `herdr agent get <name>` reports that name at that cwd and its participant is still held at the generation the bind recorded. Panes, terminals and labels are never identity — the stored tab ID exists only so stop can close the exact tab Runtime opened — and a mismatch fails closed: registration goes stale, the participant vacates.

**One worktree per writer.** `read-only` is the default; each `workspace-write` collaborator gets one Runtime-owned worktree at `<root>/workspaces/<projectHash>__<protocol>__<participantId>` on branch `runtime/collab/<protocol>/<participantId>`, verified to be a separate worktree of the same repository, and no writer gets the main checkout as cwd. Runtime owns creation, listing and confirmed removal only, never commits or merges, and worktree cwd is launch authority, not an OS boundary.

## Topology

One Unix socket per Pi agent directory. A missing daemon starts in the initial tab of a dedicated no-focus `pi-kit-services` Herdr workspace rooted at the Runtime state directory. Each collaborator instead occupies a real Herdr agent tab in the requesting project workspace, holding the real provider UI rather than a Runtime bridge command; Runtime drives it only through Herdr's structured agent API, never `pane run`, `pane send-*`, PTY bytes, or focus mutation. State is `instance.json`, `state.v1.json`, `runtime.sock` and `workspaces/` under `$PI_CODING_AGENT_DIR/runtime/`, mode `0700` over mode `0600` files.

## Wire

Newline-delimited JSON, capped at 64 KiB per request line and 128 KiB per messaging response; invalid framing or JSON closes the connection after an error response. Every method declares one TypeBox params schema, and the dispatcher validates envelope and params — unknown fields and out-of-bound sizes included — before resolving any capability, so a malformed call is always `invalid_request`. Every method except `hello` and initial registration then requires exact current authority, and mutations are idempotent on typed durable keys.

```json
{"v":1,"id":"req_1","method":"hello","params":{"minVersion":1,"maxVersion":1}}
{"v":1,"id":"req_1","ok":false,"error":{"code":"not_found","message":"diagnostic"}}
```

`hello` returns `{version, runtimeId, capabilities}` with `targets`, `mailbox`, `interactiveAgent` and `worktree`; `runtimeId` persists across service starts. Error codes: `invalid_request`, `unsupported_version`, `not_found`, `conflict`, `busy`, `registration_stale`, `identity_mismatch`, `host_unavailable`, `storage_error`, `internal`.

## Methods

| Responsibility | Methods |
|---|---|
| Service | `hello` |
| Pi registration | `pi.register`, `pi.heartbeat`, `pi.unregister` |
| Interactive agent | `bridge.bind`, `bridge.heartbeat`, `bridge.unregister` |
| Participants | `participant.acquire`, `participant.get`, `participant.list`, `participant.stand_down`, `participant.stand_down_confirmed`, `participant.stop_confirmed`, `participant.release`, `participant.takeover` |
| Mail | `mailbox.send` |
| Messaging | `messaging.issue`, `messaging.peers`, `messaging.inbox`, `messaging.send`, `messaging.reply` |
| Worktrees | `worktree.ensure`, `worktree.list`, `worktree.remove` |

## Launch

One confirmation, then one path for every driver: a driver table supplies the agent kind, startup argv, started-agent check and profile tool policy, and nothing else branches on the driver.

1. Resolve participant, driver, model, persona and profile independently and confirm the batch once, `workspace-write` included (a Pi session that ran `/runtime auto on` has already given that confirmation for its own project, and stand-down, stop and cleanup likewise); the child participant's generation — absent, or `vacant` at that generation — is the expected reservation.
2. Provision the writer's worktree, reusing an existing checkout, then create one empty no-focus Herdr tab at the intended cwd and run `herdr agent start <collab-hash> --kind pi|claude|codex --pane <id>` with the driver's startup arguments after `--`, accepting that agent only when its name, pane, terminal and agent kind are the authorized ones.
3. Native drivers call `bridge.bind` with held participant authority, agent name, driver, profile and expected generation — idempotent for that exact tuple, so an uncertain response is retried; Pi registers itself from its prepared session instead. Runtime then re-verifies `herdr agent get`, binds the target and acquires the participant in one state operation, and hands the registration back to the caller.

A failing step stops what that launch started and reports the original error, withdrawing the persisted control if the bind already happened; nothing half-launched is preserved, and the participant generation is the only lease. Claude receives appended system context and an inline MCP server entry, with `--permission-mode auto` as a writer or, read-only, `dontAsk` with every settings file and foreign MCP server ignored, the file tools plus the four mail tools as its whole tool list and only the mail server pre-allowed; Codex a server-configuration override, startup user context and `--ask-for-approval never` inside `--sandbox workspace-write` or, read-only, `--sandbox read-only` with hooks disabled; each carries one sentence of mail instructions, and `participant.list` and `bridge.heartbeat` report Herdr's `agent_status` for a live native holder, so a `blocked` tab is visible and the launching Pi session is told once per blockage, and the whole invocation is capped at 4000 escaped bytes and fails closed rather than truncating.

## Mail

A participant is `(canonicalProjectRoot, protocol, participantId)` in `held`, `vacant` or `ended` state, and mail is addressed to the participant: a later namespace of the same held participant reads it, and mail to a vacant participant queues for its next holder. Two durable records exist: a **namespace** (one credential per target registration — participant, holder generation, secret digest, expiry, operation-ID to event-ID map) and a **message** `{eventId, from, to, body, inReplyToEventId?, createdAt, readAt?}`. Mail is retrieved only through the package-owned stdio MCP endpoint and four tools: `collaborator_peers` (`{me, peers:[{participantId, live}]}`), `collaborator_inbox` (unread mail as `{eventId, from, body, inReplyTo?}`, oldest first, a page of at most 50 messages and 96 KiB with `truncated`; every message it returns is marked read in the same state write), `collaborator_send {participantId, body}` and `collaborator_reply {eventId, body}`, each returning `{eventId}`. The model never sees a namespace, operation ID or timestamp: the MCP endpoint takes the namespace from its private descriptor and mints one operation ID per send, so a retried send is a second message (at-least-once). Nothing is ever pushed into a target by the daemon. A Pi target's `pi.heartbeat` response (every 500 ms) carries the `namespaceId` and `eventId` of the oldest unread message while exactly one live namespace exists; the Pi extension then reads `collaborator_inbox` itself while the session is idle and hands the bodies to the model as one follow-up message, falling back to a one-line hint if that read fails. Bodies are capped at 16 KiB UTF-8, namespaces and operation records share a 10,000-record cap, and state is capped at 8 MiB. MCP cannot acquire identity, control processes or worktrees.

## Stop and recovery

- Stand-down vacates participant availability, preserving the agent, its worktree and queued mail.
- Stop targets only the exact Runtime-managed agent/tab generation, waits for agent and tab absence plus process-tree settlement before vacating the participant, and never deletes a worktree; missing or mismatched identity, ambiguous closure, or surviving owned processes become `needs_attention`. It needs the participant still held at the supplied generation, so repeating it after that participant vacated is a conflict, not another success.
- Only the target holding a participant may stand it down or release it; that call from any other target is a conflict. Release, revival, takeover and worktree removal are separate trusted operations that no model prose can request or confirm.
- State is current-only: a participant carries just its last transition, and a changed shape bumps the state version instead of being migrated. Every persisted record and every section of Pi's hidden `deevs.hosted-runtime.v3` entry is schema-checked on load and before each atomic write; a malformed section is dropped or demoted to `needs_attention`, never repaired.

## Limits

- **Idle-gated native wake.** While a native collaborator's mail is unread, the daemon sends one `herdr agent prompt` to its tab: for the same newest message no more than once per 30 s and three times in all, at once for newer mail, only to a tab that was issued a mail namespace, and only while `herdr agent get` reports `agent_status` `idle` or `done` (a finished turn nobody has looked at), never `working`, `blocked` or `unknown`. That prompt names the sender, never a body; it may land on a partially typed human line, and it never proves the agent acted on the mail. Once `collaborator_inbox` has returned the message nothing more is sent. Keystroke injection and pane scraping stay unused and must not be worked around.
- `readAt` records that `collaborator_inbox` returned the message, not that the agent acted on it; a message lost from context after that is not redelivered, and a Pi delivery is not replayed after loss.
- **Retention.** Unread mail and messaging grants live 7 days; read mail is dropped a day after `collaborator_inbox` returned it, its id staying in the sender's operation map so a retried send still deduplicates. A write that would cross the 8 MiB state cap first sheds read mail older than an hour; only when that is not enough is the write refused with `storage_error`.
- Mail stays point-to-point — no collaborator groups, broadcasts, attachments or durable schedules. Node Unix sockets expose no peer credentials, so owner-only permissions and random credentials protect against accidental and cross-wired children only.
