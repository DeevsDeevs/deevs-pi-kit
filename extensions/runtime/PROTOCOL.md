# Runtime protocol

Runtime is a local daemon with two jobs: durable participant identity and mail, and lifecycle authority over persistent collaborators living in real Herdr agent tabs. It accepts only its current state schema version; a store written by another version is discarded and the daemon starts fresh.

## Guarantees

**Durable before observable.** Mail and participant state commit to disk before any response or host mutation and survive restart, and every mutation is idempotent on a typed durable key, so an uncertain call is resolved by repeating it rather than by inventing a new identifier. A background sweep drops mail past the retention window, the operation records of dropped mail, and grants created before that window that are no longer live; a held grant never expires by time. Exactly-once provider execution, durable model admission and semantic completion are not guaranteed.

**Identity is a name plus `herdr agent get`.** A target is a Pi session `pi_<piSessionId>` or a Herdr agent `agent_<projectHash>_<agentName>`, and a call names its target by that key over the owner-only socket; Runtime mints no credential for it. A Pi target is live while it heartbeats (every 500 ms; 30 s of silence ends it), and each registration re-acquires the participant name its session holds, so a reopened lead or a resumed collaborator holds its name again. A native target is live while `herdr agent get <name>` reports that name at its cwd and its participant is still held at the generation the bind recorded; Runtime asks Herdr again whenever such a tab sends mail, so it needs no lead to stay live. Panes, terminals and labels are never identity — the stored tab ID exists only so stop can close the exact tab Runtime opened.

**One worktree per writer.** `read-only` is the default; each `workspace-write` collaborator gets one Runtime-owned worktree at `<root>/workspaces/<projectHash>__<protocol>__<participantId>` on branch `runtime/collab/<protocol>/<participantId>`, verified to be a separate worktree of the same repository, and no writer gets the main checkout as cwd. That repository is the project root, or the cwd-relative `repo` a start names when the root is a folder of repositories; the daemon records it on the participant, so a restart needs no `repo`, and lists worktrees across the root, every recorded repo and the direct child repositories. Runtime owns creation, listing and confirmed removal only, never commits or merges, and worktree cwd is launch authority, not an OS boundary.

## Topology

One Unix socket per Pi agent directory. A missing daemon starts in the initial tab of a dedicated no-focus `pi-kit-services` Herdr workspace rooted at the Runtime state directory. Each collaborator instead occupies a real Herdr agent tab in the requesting project workspace, holding the real provider UI rather than a Runtime bridge command; Runtime drives it only through Herdr's structured agent API, never `pane run`, `pane send-*`, PTY bytes, or focus mutation. State is `instance.json`, `state.v1.json`, `runtime.sock` and `workspaces/` under `$PI_CODING_AGENT_DIR/runtime/`, mode `0700` over mode `0600` files.

## Wire

Newline-delimited JSON, capped at 64 KiB per request line and 128 KiB per messaging response; invalid framing or JSON closes the connection after an error response. Every method declares one TypeBox params schema, and the dispatcher validates envelope and params — unknown fields and out-of-bound sizes included — before resolving any capability, so a malformed call is always `invalid_request`. Every method except `hello`, `service.exit` and `pi.register` then names a known target, and mutations are idempotent on typed durable keys.

```json
{"v":1,"id":"req_1","method":"hello","params":{"minVersion":1,"maxVersion":1}}
{"v":1,"id":"req_1","ok":false,"error":{"code":"not_found","message":"diagnostic"}}
```

`hello` returns `{version, runtimeId, build, capabilities}` with `targets`, `mailbox`, `interactiveAgent` and `worktree`; `runtimeId` persists across service starts, and `build` hashes the daemon's source. A Pi session that finds a daemon whose build differs from the source on disk, at session start or at the collaborator start of a session not yet registered, inside Herdr in a trusted project, calls `service.exit` and starts its own, so an updated kit never keeps talking to the daemon of an older one. Error codes: `invalid_request`, `unsupported_version`, `not_found`, `conflict`, `busy`, `registration_stale`, `identity_mismatch`, `host_unavailable`, `storage_error`, `internal`.

## Methods

| Responsibility | Methods |
|---|---|
| Service | `hello`, `service.exit` |
| Pi registration | `pi.register`, `pi.heartbeat`, `pi.unregister` |
| Interactive agent | `bridge.bind`, `bridge.heartbeat` |
| Participants | `participant.acquire`, `participant.get`, `participant.list`, `participant.stand_down_confirmed`, `participant.stop_confirmed`, `participant.takeover` |
| Messaging | `messaging.issue`, `messaging.inbox`, `messaging.read`, `messaging.send` |
| Worktrees | `worktree.ensure`, `worktree.list`, `worktree.remove` |

## Launch

One confirmation, then one path for every driver: a driver table supplies the agent kind, startup argv, started-agent check and profile tool policy, and nothing else branches on the driver.

1. Resolve participant, model (whose spec prefix picks the driver), persona and profile independently and confirm the batch once, `workspace-write` included, only when `pi-kit.json` sets `"autonomy": false` (the default `true` skips that dialog, and stand-down, stop and cleanup likewise); the child participant's generation — absent, or `vacant` at that generation — is the expected reservation.
2. Provision the writer's worktree, reusing an existing checkout (a Claude worktree inherits the folder trust Claude Code already recorded for its repository, since the dialog would otherwise block every launch), then create one empty no-focus Herdr tab at the intended cwd and run `herdr agent start <collab-hash> --kind pi|claude|codex --pane <id>` with the driver's startup arguments after `--`, accepting that agent only when its name, pane, terminal and agent kind are the authorized ones.
3. Native drivers call `bridge.bind` with held participant authority, agent name, driver, profile and expected generation — idempotent for that exact tuple, so an uncertain response is retried; Pi registers itself from its prepared session instead. Runtime then re-verifies `herdr agent get`, binds the target and acquires the participant in one state operation, and hands the target back to the caller.

A failing step stops what that launch started and reports the original error, withdrawing the persisted control if the bind already happened; nothing half-launched is preserved, and the participant generation is the only lease.

- **Claude** gets appended system context, an inline MCP server entry, and `--permission-mode bypassPermissions` with the kit guard as its Bash PreToolUse hook (`--settings`). Its one-time bypass acceptance and a worktree's folder trust, inherited from the repository, are pre-seeded in its config. A read-only Claude gets `Bash,Read,Glob,Grep` plus the mail tool as its whole tool list.
- **Codex** gets a server-configuration override, startup user context, `--ask-for-approval never` inside `--sandbox workspace-write` (read-only: `--sandbox read-only`), the kit guard as its Bash PreToolUse hook (`--dangerously-bypass-hook-trust`, since the kit vets its own hook), and its cwd pre-trusted, since an untrusted folder never takes a typed prompt.
- Each carries one sentence of mail instructions, and the whole invocation is capped at 4000 escaped bytes and fails closed rather than truncating.
- `participant.list` and `bridge.heartbeat` report Herdr's `agent_status` for a live native holder, so a `blocked` tab is visible and the launching Pi session is told once per blockage.
- A stood-down Claude or Codex collaborator resumes its own session (`--resume <id>`, `codex resume <id>`): the lead reads the id from Herdr's `agent_session` at stand-down and keeps it, with the start spec and tab id, in its session record. The lead closes that tab only while Herdr still shows it as the collaborator's lone tab in its workspace.

## Mail

A participant is `(canonicalProjectRoot, protocol, participantId)` `held` or `vacant`, and mail is addressed to the participant: a later namespace of the same held participant reads it, and mail to a vacant participant queues for its next holder. Two durable records exist: a **namespace** (one credential per target — participant, holder generation, secret digest, status, operation-ID to event-ID map) and a **message** `{eventId, from, to, body, inReplyToEventId?, createdAt, readAt?}`. Collaborators send with `SendMessage {to, message, images?}`: a Pi session through the kit's `SendMessage` tool, Claude Code and Codex through the package-owned stdio MCP endpoint, whose only tool it is; `to` is a participant name, and the lead is `main`. Images travel in the body as `<image>/abs/path</image>` lines. The model never sees a namespace, operation ID or timestamp: the sender takes the namespace from its private descriptor and mints one operation ID per send, so a retried send is a second message (at-least-once). Nothing polls. A Pi target's `pi.heartbeat` response (every 500 ms) carries the `namespaceId` and `eventId` of the oldest unread message while exactly one live namespace exists; the Pi extension then peeks `messaging.inbox` itself while the session is idle and hands every unread message to the model as one `collaborator-message` that starts a turn, images as `ImageContent`, with their event IDs in its details. It marks them read with `messaging.read` only at a later idle, once its session file holds that message, so a crash or `/reload` in between delivers them again; an inbox read without `peek` marks its page read in the same state write. A lead that was closed gets what waited for it in that one message when its session reopens. Bodies are capped at 16 KiB UTF-8, namespaces and operation records share a 10,000-record cap, and state is capped at 8 MiB. MCP cannot acquire identity, control processes or worktrees.

## Stop and recovery

- Stand-down vacates participant availability, preserving the agent, its worktree and queued mail.
- Stop targets only the exact Runtime-managed agent/tab generation, waits for agent and tab absence plus process-tree settlement before vacating the participant, and never deletes a worktree; missing or mismatched identity, ambiguous closure, or surviving owned processes become `needs_attention`. It needs the participant held at the supplied generation, or stood down at it, in which case it closes the dormant tab and records `stop` so a later start no longer tries to replace it; repeating it after either is a conflict, not another success.
- Stand-down, stop, takeover and worktree removal are trusted operations that no model prose can request or confirm; the one automatic takeover is a `collaborator_start` whose caller name is held by a Pi target whose registration has lapsed, confirmed like the start itself.
- State is current-only: a participant carries just its last transition, and a changed shape bumps the state version instead of being migrated. Every persisted record and every section of Pi's hidden `deevs.hosted-runtime.v3` entry is schema-checked on load and before each atomic write; a malformed section is dropped or demoted to `needs_attention`, never repaired.

## Limits

- **Native wake.** A native tab has no heartbeat, so the daemon types its unread messages into it: all of them in one `herdr agent prompt`, sent only while `herdr agent get` reports the tab idle, done or undetected, so messages sent during a turn arrive together at its next idle, and never into a tab `blocked` on a human prompt. Its messages are marked read once Herdr's status-change count shows the tab took a turn after the prompt; a dropped prompt is repeated every 30 s, three times at most (a Herdr without that count marks them read on the prompt). It may land on a partially typed human line, and it never proves the agent acted.
- `readAt` records the delivery, not that the agent acted on it; a message lost from context after that is not redelivered.
- **Retention.** Unread mail lives 7 days, or until it is read while its sender's grant still lists it for a retry; read mail is dropped a day after it was marked read, together with its record in the sender's operation map. A grant that is no longer live (superseded, or its holder left) is dropped once it is 7 days old, and a re-issue supersedes before it counts the record cap, so neither the cap nor a full holder can wedge mail. A write that would cross the 8 MiB state cap first sheds read mail older than an hour; only when that is not enough is the write refused with `storage_error`.
- Mail stays point-to-point — no collaborator groups, broadcasts, attachments or durable schedules. Node Unix sockets expose no peer credentials, so owner-only permissions and random credentials protect against accidental and cross-wired children only.
