# Hosted Runtime protocol v1

Runtime provides a durable local inbox for events that must survive Pi and Runtime restarts. Release 1 watches newly created files in one directory and wakes one exact Pi session through Herdr. The Pi Collaborator extension adds durable participant identity and directed mailboxes on the same wake/admission foundation.

It does not replace Herdr, bounded Jobs, Subagents, Workflows, Missions, or session Cron. Herdr owns live panes and prompt delivery; Runtime adds durable routing, claims, acknowledgement, and recovery.

## Guarantees

- Events and Monitor cursors are persisted before wake attempts.
- A wake targets a verified Pi session, terminal, pane, and project—not focus, PID, or cwd alone.
- Delivery is at least once until Pi admits the message, then never redelivered.
- Busy or offline Pi sessions retain pending events without interruption or fallback.
- Routing and authorization use validated IDs, generations, keys, statuses, and receipts. Prose is display-only.
- Runtime restart preserves monitors, events, claims, receipts, and wake state but invalidates live registrations.

## Release 1 scope

Included:

- one Runtime service per Pi agent directory;
- one direct-child, created-regular-file Monitor per target;
- exact Pi/Herdr registration and heartbeat;
- durable queue, claim, acknowledgement, release, and lease recovery;
- exact Herdr wake for `idle` or `done` Pi agents;
- authoritative directory scans with `fs.watch` as a latency hint;
- exclusive Pi collaborator identities and durable directed mailboxes.

Deferred:

- recursive/content/modification/deletion monitoring;
- non-Pi collaborators, groups, broadcasts, and attachments;
- durable schedules and automatic takeover;
- Runtime-owned workers;
- native service installers and Windows transport.

## Operation

Runtime starts only through `/runtime start` or the service command. Pi may automatically register on session start only when the Runtime socket already exists.

Pi commands:

```text
/runtime status
/runtime start
/runtime register
/runtime monitor <directory>
/runtime monitor-delete
```

Default files:

```text
$PI_CODING_AGENT_DIR/runtime/
  instance.json
  state.v1.json
  runtime.sock
```

The directory is mode `0700` and the Unix socket is mode `0600`. Current Node Unix sockets do not expose peer credentials, so v1 security is limited to owner-only filesystem permissions plus registration keys. Runtime never logs registration keys.

## Transport

Requests and responses are newline-delimited JSON over the Unix socket. Request lines are limited to 64 KiB. Invalid framing or JSON closes the connection after an error response.

```json
{"v":1,"id":"req_...","method":"hello","params":{}}
{"v":1,"id":"req_...","ok":true,"result":{}}
{"v":1,"id":"req_...","ok":false,"error":{"code":"not_found","message":"diagnostic"}}
```

`hello` accepts a version range spanning v1 and returns:

```json
{
  "version": 1,
  "runtimeId": "rt_...",
  "epoch": "epoch_...",
  "capabilities": {
    "agentWake": "herdr_exact_agent",
    "maxDeliveryBatch": 12,
    "monitor": {"maxEntries": 10000}
  }
}
```

`runtimeId` persists; `epoch` changes on every service start. `agentWake` is `none` when no Herdr adapter is configured.

Error codes:

```text
invalid_request          unsupported_version     capability_unavailable
not_found                conflict                registration_stale
identity_mismatch        claim_conflict          host_unavailable
busy                     storage_error           internal
```

### Methods

| Method | Purpose |
|---|---|
| `hello` | Negotiate v1 and capabilities |
| `pi.register` | Verify and bind a live Pi generation |
| `pi.heartbeat` | Renew and reverify registration |
| `pi.unregister` | Drop registration best-effort |
| `monitor.create` | Create the target's Monitor and baseline |
| `monitor.get` | Read Monitor status |
| `monitor.delete` | Remove Monitor without discarding events |
| `wake.accept` | Accept a wake and atomically claim its first batch |
| `inbox.claim` | Claim manually when wake transport is unavailable |
| `inbox.ack` | Acknowledge exact admission receipts |
| `inbox.release` | Return an exact claim to pending |
| `inbox.status` | Read target queue counts |
| `participant.acquire` | Acquire or revive one project/protocol participant |
| `participant.get` | Read one participant and queue status |
| `participant.list` | List participants in the registered project |
| `participant.stand_down` | Holder vacates its identity while retaining queued mail |
| `participant.stand_down_confirmed` | Trusted-confirmed same-project caller vacates one exact generation while retaining queued mail |
| `participant.stop_confirmed` | Trusted-confirmed same-project caller closes the exact managed Herdr tab and vacates its generation |
| `participant.release` | End an identity and reject new mail |
| `participant.takeover` | Explicitly rebind an offline holder generation |
| `mailbox.send` | Append one idempotent directed message |

All methods except `hello` and `pi.register` require the exact current registration ID and key. Mutations are idempotent on their typed durable keys. `participant.acquire` reports whether that call transitioned ownership; automatic rollback supplies the acquired generation to `participant.stand_down`, which fails if ownership changed. `participant.stand_down_confirmed` additionally requires a schema-validated confirmation boolean and exact expected generation; it can only move a same-project participant from held to vacant. `participant.stop_confirmed` uses the existing target/session identity to close only a plugin-managed single-pane Herdr tab, preserves mail, refuses self-stop, and is retry-safe when the tab is already absent.

Hosted event types are separate from process-local `RuntimeEvent` types in `extensions/shared/runtime-events.ts`.

## Identity and registration

A stable target survives process restarts:

```text
targetKey = sha256(canonicalProjectRoot + NUL + piSessionId)
```

Registration supplies the canonical project root, Pi session ID/file, a client generation, historical admission receipts, and Herdr pane/terminal locators. Runtime then verifies:

1. the Pi session file header contains the supplied session ID;
2. Herdr resolves the pane to the supplied terminal;
3. Herdr reports the same Pi session ID or canonical session path;
4. Herdr's canonical cwd equals the project root;
5. no other live terminal owns the target.

A successful registration receives a random 256-bit key and a 30-second lease. Registrations live only in memory and are scoped to the Runtime epoch. Heartbeats renew the lease and rerun the complete host predicate. A moved pane is accepted only when the same terminal and Pi identity still verify. Another live terminal receives `conflict`; v1 has no takeover.

Before registration becomes wakeable, Runtime reconciles exact claim/event receipts already present in Pi's hosted custom-message history. This closes the crash window where Pi persisted admission before Runtime persisted acknowledgement.

## Monitor and events

`monitor.create` accepts a canonical directory inside the registered project and a settle interval.

- The root and entries must not be symlinks.
- Only direct-child regular files are observed.
- Existing files form a non-emitting baseline.
- A new path emits after size and mtime remain stable for the settle interval.
- A path emits once per Monitor generation.
- Events contain bounded path metadata, not file contents.
- Missing directories degrade and retry without losing the cursor.
- Crossing the entry cap fails without advancing the cursor.

`fs.watch` only requests an early scan. Startup, watch hints, and the five-second fallback all use the same authoritative reconciliation. Cursor and event updates commit in one atomic state mutation before wake.

Each event has a stable ID, typed Monitor source/generation/sequence, stable target, bounded filesystem metadata, and one delivery state:

```text
pending -> claimed -> acked
                  \-> pending  (release or lease expiry)
```

Claims contain at most 12 events in source sequence order. Normal acknowledgement or release requires the same registration generation and exact claim/event receipt. Historical registration reconciliation is the only generation-exempt path.

Acknowledgement means the hosted message entered Pi session history; it does not mean the model completed resulting work.

## Wake and admission

Runtime keeps at most one outstanding wake per target. Repeated submissions carry the same idempotent wake ID, and Pi accepts concatenated exact duplicates as one wake. Pending events remain queued while the target is offline, unverified, `working`, `blocked`, unknown, or focused for human input.

For an exact unfocused `idle` or `done` target, Runtime:

1. reverifies Herdr terminal, Pi session, cwd, status, and freshness;
2. persists a wake ID;
3. prompts that exact pane with:

```text
/pi-kit-runtime-wake 1 <registrationId> <wakeId>
```

The Pi command handler checks that Pi is idle with no pending user messages, atomically accepts the wake, and claims the first batch. It then enqueues one hidden `deevs.hosted-runtime.v1` custom message containing the exact claim/event receipt. Runtime never injects a slash command into a focused human editor; that Pi claims pending events in-process before the next submitted agent turn and injects the same hidden message into that turn.

- Busy or focused Pi declines external prompting without claiming.
- Synchronous enqueue failure releases the claim.
- `message_start` acknowledges admission.
- A pre-admission crash returns the claim to pending after lease expiry.
- A post-admission/pre-ack crash is reconciled from Pi history during registration.
- Repeated wake IDs and receipt operations are idempotent.

## Collaborator mailbox

A participant is addressed by `(canonicalProjectRoot, protocol, participantId)` and has one durable state: `held`, `vacant`, or `ended`. One Pi target may hold one identity. Stand-down explicitly consents to succession; release ends the identity; takeover requires an offline holder, the exact observed generation, restart grace, and Pi-side user confirmation. Ownership never changes on a timer.

Mailbox messages are addressed to participants rather than historical Pi sessions. Runtime resolves the current holder only when claiming/waking, so pending mail follows an explicit succession. Each sender-recipient stream has a durable sequence. `(senderParticipantKey, sendId)` plus a recipient/body fingerprint makes retries idempotent and changed retries conflict.

Bodies are capped at 16 KiB and become model-visible input in the recipient Pi session. They are authored by an identity-verified participant in the same trusted project, but remain untrusted prose: bodies never authorize routing, ownership, takeover, acknowledgement, or verdicts.

Herdr remains the live process and prompt layer. `/runtime collaborator-start` materializes a child Pi session, creates a no-focus tab, starts Pi, and waits for the child to acquire its environment-bootstrapped identity. Runtime never changes pane or tab focus. The identity disposition is mirrored in Pi session history for safe reload/resume. Models may inspect current durable participants with read-only `collaborator_list`, call `mail_send`, and request confirmed `collaborator_start`, `collaborator_stand_down`, or `collaborator_stop`. Start may acquire or reacquire the caller and launch only new or vacant identities. Stop closes only an exact managed Herdr tab. Release, revival, and takeover remain user commands.

## Persistence and retention

Runtime stores one bounded, schema-validated state document. Mutations write a temporary file, fsync it, atomically rename it, then fsync the parent directory. Corruption fails closed; Runtime never resets to an empty inbox.

Pending and claimed events, claim receipts, wakes, and Monitor cursors are never age-pruned. Acknowledged events and complete settled claims are retained for seven days and pruned atomically with later acknowledgements.

Whole-state replacement is intentional for Release 1. A journal or database is deferred until measured state size or write throughput requires it.

## Release gate

Run from a source checkout with Herdr and its Pi integration installed:

```bash
npm run smoke:runtime-release
npm run smoke:collaborator-release
```

Both isolated gates use unique Herdr servers/sessions/sockets, Pi agent directories, Runtime state, projects, and Pi sessions. The Runtime gate proves offline Monitor queuing, restarts, exact wake/admission, historical reconciliation, foreign-session rejection, and no redelivery. The two-Pi Collaborator gate launches its child through production `/runtime collaborator-start`, verifies v3 session materialization and identity binding, and proves bidirectional mail, identity conflict, stand-down queuing and reacquisition, release/revival, claimed-mail takeover after lease expiry, historical mailbox reconciliation, and no redelivery across a full heartbeat interval. It also creates a production Mission in the real parent Pi, delivers and acknowledges the collaborator reply while that Mission is active, restores its canonical state after the parent closes, records/adjudicates through registered Mission tools, admits and recovers exactly one typed reviewer across parent reloads, and commits exactly one completion/effect across replay. Both clean all isolated resources and never connect to the user's active Herdr server.
