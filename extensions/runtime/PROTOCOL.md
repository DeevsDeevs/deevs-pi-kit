# pi-kit-runtime protocol v1 (design draft)

Status: **design only; not implemented**.

This protocol adds one local durable inbox for events that must survive a Pi process restart. The first vertical slice watches newly created files in one directory and wakes one exact Pi session through Herdr.

It does not replace bounded Jobs, Pi JSON/print Subagents, foreground Workflows, Mission policy, or process-local Session Cron.

## Invariants

1. **One event, one durable owner, one delivery claim.** Runtime state—not a watcher process's memory—owns dedupe and claim/ack.
2. **Exact target.** A wake is bound to a canonical Pi session and verified Herdr agent session. It never uses the focused pane, PID guessing, cwd alone, or prose identity.
3. **Record before wake.** An event and its monitor cursor are durable before any wake attempt.
4. **At-least-once until admission.** Crashes may repeat a wake, but an event keeps the same ID and is never redelivered after acknowledged admission.
5. **Do not interrupt user work.** Runtime never steers a `working`/`blocked` agent and does not enqueue ahead of user work already visible to Pi. A truly concurrent user submission and hosted wake follow Pi's actual queue order; v1 does not claim an unavailable cross-process atomic priority guarantee.
6. **No silent fallback.** Persistence and wake capabilities are reported explicitly. A missing Herdr wake queues events; it does not become process-local polling or another pane.
7. **Typed control plane.** Version, IDs, generations, statuses, capabilities, and error codes drive behavior. Human summaries never authorize ownership, takeover, or acknowledgement.

## Scope of v1

Included:

- one runtime instance per Pi agent data directory;
- local request/response transport;
- exact Pi registration and heartbeat;
- direct-child regular-file creation monitoring for one registered directory per target;
- durable event queue, claim, acknowledgement, release, and stale-claim recovery;
- exact Herdr wake when the registered Pi agent is idle or done;
- restart reconciliation using `fs.watch` only as a hint plus authoritative scans.

Deferred:

- recursive watches, arbitrary shell monitors, file contents, modification/deletion events;
- collaborator participant leases and protocol mailboxes;
- durable schedules;
- runtime-owned Jobs or Subagent workers;
- Mission continuation/completion policy;
- automatic takeover by another Pi session;
- native `systemd --user`/`launchd` installers and Windows named-pipe transport.

## Components

- **Runtime:** `pi-kit-runtime`, a single local service supervised initially by Herdr.
- **Pi client:** the Pi Kit extension loaded in the target Pi session.
- **Host adapter:** Herdr protocol 19+ for agent identity, status, and exact prompt delivery.
- **Monitor:** a durable directory registration owned by the runtime.
- **Inbox:** durable events targeted to a stable Pi session key.

Herdr supplies live topology and delivery, not durable inbox semantics. Protocol 19 exposes pane/terminal/session identity, unique live agent names, agent status and `state_change_seq`, prompts, and live subscriptions. It does not expose a durable acknowledged event cursor or participant lease.

## Transport envelope

The first implementation uses newline-delimited JSON over a Unix-domain socket owned by the current user. The runtime directory is mode `0700`; the socket is mode `0600`. The server rejects peers with a different uid when peer credentials are available.

Request:

```json
{"v":1,"id":"req_01...","method":"hello","params":{}}
```

Success:

```json
{"v":1,"id":"req_01...","ok":true,"result":{}}
```

Failure:

```json
{"v":1,"id":"req_01...","ok":false,"error":{"code":"identity_mismatch","message":"display-only diagnostic"}}
```

Unknown fields are rejected in v1. Request IDs correlate one connection exchange only. Methods marked as durable mutations carry a separate `operationId`; the runtime persists a bounded operation-result cache so a retry returns the original result instead of repeating the mutation. Registration-time admission reconciliation is the narrow exception: it is idempotent directly on exact durable receipt keys and never repeats model-visible delivery.

Error codes:

```text
invalid_request          unsupported_version     capability_unavailable
not_found                conflict                registration_stale
identity_mismatch        claim_conflict          host_unavailable
busy                     storage_error            internal
```

## Handshake and capabilities

`hello` request:

```json
{"minVersion":1,"maxVersion":1}
```

Result:

```json
{
  "version": 1,
  "runtimeId": "rt_...",
  "epoch": "epoch_...",
  "observedAt": 1780000000000,
  "capabilities": {
    "durableInbox": true,
    "eventPersistence": "runtime_restart",
    "offlineQueue": true,
    "agentWake": "herdr_exact_agent",
    "rebootSurvival": false,
    "monitor": {"directoryCreatedFiles": true, "recursive": false, "maxEntries": 10000},
    "maxDeliveryBatch": 12,
    "host": {"kind": "herdr", "protocol": 19, "detachedServerDaemon": true}
  },
  "idempotencyTtlMs": 86400000
}
```

`runtimeId` is generated once and persisted. `epoch` changes on every runtime process start. Capability values reflect observed runtime/Herdr state; unavailable capabilities use typed values such as `agentWake: "none"` plus a typed degraded reason. Example booleans such as `detachedServerDaemon` are observations, not promises. Clients must not infer stronger behavior.

## Method surface

| Method | Durable mutation | Purpose |
|---|---:|---|
| `hello` | no | Negotiate version and capabilities |
| `pi.register` | no | Bind one live Pi generation to a stable target after host verification |
| `pi.heartbeat` | no | Renew and re-verify the live registration |
| `pi.unregister` | no | Drop a live registration best-effort |
| `monitor.create` | yes | Persist one directory monitor and initial baseline |
| `monitor.get` | no | Read the target's single monitor status |
| `monitor.delete` | yes | Stop one monitor without discarding queued events |
| `wake.accept` | yes | Validate one outstanding wake and atomically claim its first batch |
| `inbox.claim` | yes | Explicit/manual claim when no wake transport is available |
| `inbox.ack` | yes | Acknowledge admission for an exact claim |
| `inbox.release` | yes | Return an exact claim to pending |
| `inbox.status` | no | Return counts/status without claiming |

`monitor.*`, `wake.accept`, and `inbox.*` require the exact current registration ID/key. Durable mutations also require `operationId`.

Hosted protocol types are separate from the existing Pi-session `RuntimeEvent` v1 types in `extensions/shared/runtime-events.ts`. V1 does not add `monitor`, filesystem payloads, leases, or target routing to that local terminal-event schema. A future Pi adapter uses a separately named hosted custom message/type and may reuse only presentation code.

## Stable Pi target and live registration

A target survives process restarts:

```text
targetKey = sha256(canonicalProjectRoot + NUL + piSessionId)
```

The cleartext project root and Pi session ID remain in the protected runtime state for diagnostics; callers do not choose `targetKey` directly.

`pi.register` request:

```json
{
  "projectRoot": "/canonical/project",
  "piSessionId": "019f...",
  "piSessionFile": "/canonical/...jsonl",
  "clientGeneration": "gen_...",
  "admittedClaims": [
    {"claimId":"claim_previous_epoch","eventIds":["evt_..."]}
  ],
  "herdr": {
    "paneId": "w6:p2",
    "terminalId": "opaque-terminal-id",
    "agentName": "pi-main"
  }
}
```

The runtime queries Herdr instead of trusting the supplied host fields. Before making the registration wakeable, it reconciles bounded `admittedClaims` copied from hosted custom messages already present in the Pi session branch. A matching historical claim may acknowledge its exact events even after lease expiry/runtime restart; a mismatched target or event set is rejected.

The Pi integration reports both session ID and canonical session path through Herdr `pane.report_agent_session` under source `pi-kit-runtime`. Herdr protocol 19 returns one discriminated `AgentSessionInfo` (`kind: id | path`). Registration uses this strict predicate:

1. `paneId` resolves and its `terminalId` equals the supplied terminal ID.
2. Reported agent-session source/agent identify the Pi Kit report.
3. For `kind: id`, `value === piSessionId`; for `kind: path`, canonical `value === piSessionFile`. Any available authoritative field that disagrees rejects registration.
4. Canonical Herdr cwd equals the registered project root in v1.
5. No different live terminal already owns `targetKey`.

`paneId` is a locator, not durable authority. After a pane move the runtime may resolve the same `terminalId`, but must rerun the entire session/cwd predicate before updating the locator. Agent name is an optional unique lookup hint, never sole authority. Herdr `revision`/`state_change_seq` are freshness signals queried again before every wake, not persisted ownership.

Result:

```json
{
  "targetKey": "pi_...",
  "registrationId": "reg_...",
  "registrationKey": "base64url-random-256-bit",
  "leaseUntil": 1780000000000,
  "hostStateChangeSeq": 42
}
```

`registrationKey` is required for target-scoped operations and is never written to logs. Live registrations are scoped to `epoch` and kept in memory; retrying the same verified `clientGeneration` within an epoch returns the same registration/key. Clients reconnect and re-register after runtime restart. Durable monitors/events target `targetKey`, not the ephemeral registration. `pi.heartbeat` renews the short registration lease and refreshes verified host identity. A Pi reload in the same terminal/session may rotate generation and key. A different live terminal receives `conflict`; v1 has no automatic takeover.

`pi.unregister` is best effort. Lease expiry or epoch change marks the client offline but does not delete monitors or queued events.

## Directory monitor

`monitor.create` request:

```json
{
  "operationId": "op_...",
  "registrationId": "reg_...",
  "registrationKey": "...",
  "directory": "/canonical/project/.collaboration/fable/fable",
  "settleMs": 250
}
```

Rules:

- The project must be trusted by Pi before creation.
- The canonical directory must stay within the registered project root.
- Symlink roots and symlink entries are rejected/ignored.
- V1 behavior is fixed: direct children only, created regular files only, and an initial non-emitting baseline. These are not request options.
- A target may own only one monitor; another create returns `conflict` until the monitor is deleted.
- Existing entries become the baseline and do not emit events.
- A new regular file emits only after size and mtime remain unchanged for `settleMs`.
- A relative path emits once per monitor generation. Producers that need another event use a new immutable filename; modification support is deferred.
- No file content is stored or injected. The event carries bounded metadata and a canonical/relative path for later explicit reading.

Result:

```json
{"monitorId":"mon_...","generation":"gen_...","status":"watching"}
```

`monitor.get` and `monitor.delete` require the exact target registration. Deletion atomically removes the monitor but does not acknowledge already queued events.

### Watch algorithm

`fs.watch` is only a low-latency hint. The authoritative algorithm is:

1. Persist the initial directory snapshot.
2. Reconcile after each watch hint with debounce.
3. Reconcile periodically (initially every five seconds) to cover missed/overflowed watch events.
4. Reconcile immediately after runtime restart and watcher recreation.
5. If the directory disappears, mark the monitor `degraded` and retry scans; do not discard its cursor.

For each newly stable path, atomically persist one next-state snapshot containing both the observed cursor update and `event.enqueued` before attempting wake. Therefore:

- crash before atomic rename: the previous state remains valid and the next scan rediscovers the path;
- crash after atomic rename: the same pending event survives;
- duplicate watch hints: the durable cursor suppresses duplicates.

The first slice caps a monitor baseline at the advertised `maxEntries`. Crossing the cap fails the scan without advancing its cursor; it never silently drops entries.

## Event model

```json
{
  "version": 1,
  "eventId": "evt_...",
  "source": {"kind":"monitor","id":"mon_...","generation":"gen_...","sequence":17},
  "targetKey": "pi_...",
  "type": "filesystem.created",
  "createdAt": 1780000000000,
  "summary": "new file: fable/0049-review.md",
  "payload": {
    "relativePath": "0049-review.md",
    "path": "/canonical/project/.collaboration/fable/fable/0049-review.md",
    "fileType": "regular",
    "size": 842,
    "mtimeMs": 1780000000000
  },
  "delivery": {"status":"pending"}
}
```

`summary` is display-only. Routing and dedupe use typed source/target/sequence/ID fields.

Delivery states:

```text
pending -> claimed -> acked
                  \-> pending (release or lease expiry)
```

Only the exact current registration may claim its target. Claims have a short lease. `wake.accept` and `inbox.claim` return at most the advertised batch size in source sequence order:

```json
{"claimId":"claim_...","leaseUntil":1780000030000,"events":[{"eventId":"evt_..."}]}
```

Each event retains its latest durable admission receipt key `{targetKey, eventId, claimId}` until acknowledgement. `inbox.ack` and `inbox.release` carry `operationId`, `registrationId`, `registrationKey`, `claimId`, and the exact event IDs. Normal ack/release requires the registration generation that created the claim. The sole exception is registration-time history reconciliation for the same stable target and exact receipt key. Repeating the same operation is idempotent; a different target/owner receives `claim_conflict`.

Acknowledgement means **the hosted event message was admitted to Pi session history**, not that the model completed resulting work.

## Exact wake and Pi admission

The runtime keeps at most one outstanding wake per target. Pending events remain queued while the target is offline, `working`, `blocked`, unknown, or has no verified Herdr binding.

When Herdr reports the exact agent as `idle` or `done`, the runtime:

1. Re-resolves the current pane from the verified terminal + agent-session identity.
2. Persists `wakeId` before sending.
3. Calls Herdr `agent.prompt` without lifecycle waiting, targeting that exact agent/pane with:

```text
/pi-kit-runtime-wake 1 <registrationId> <wakeId>
```

The command is protocol framing, not model prose. Pi checks extension commands before model input, so the handler runs without starting an LLM turn. The command is valid only for the matching registration and outstanding wake.

The Pi handler rechecks `ctx.isIdle()` and `ctx.hasPendingMessages()` to narrow the status race without overstating atomicity:

- busy/already pending: reject/release; runtime keeps events pending and rearms after the next verified idle state;
- idle: atomically `wake.accept` and claim up to 12 events, then enqueue one hidden Pi custom follow-up containing every claimed event summary and ID;
- synchronous enqueue failure: release the claim;
- `message_start`: acknowledge the exact hosted claim; the custom message details retain `claimId` and event IDs so resume reconciliation can repeat the same idempotent ack;
- Pi/runtime crash before admission: claim lease expires and the same event IDs are retried;
- Pi crash after admission but before ack persistence: custom-message details preserve the historical claim/event set; `pi.register` reconciles it before enabling wakes, even if the old claim lease expired.

A repeated `wakeId` is harmless. A wake never targets the focused pane or falls back to raw terminal text.

## Runtime persistence

Default root:

```text
$PI_CODING_AGENT_DIR/runtime/
  instance.json
  state.v1.json
  runtime.sock
```

- Directory/files use owner-only permissions.
- The first slice keeps one bounded schema-validated state document. Each mutation writes a temporary file, fsyncs it, renames atomically, then fsyncs the parent directory before success.
- Corruption fails closed with `storage_error`; it does not start from an empty inbox.
- The state document has an advertised size/monitor-entry cap. Hitting it stops new cursor advancement rather than losing events.
- Bounded retention may remove only acknowledged events and cached operation results older than their advertised retention interval. Pending/claimed events, their latest claim identity, and monitor cursors are never age-pruned.
- Runtime restart clears live registrations but preserves claims/wakes/events. Stale wake locators are discarded; pending events are rearmed only after the exact Pi session re-registers and history reconciliation finishes.
- An append journal/database is deferred until measured state size or write throughput makes whole-state atomic replacement inadequate.

The protocol guarantees durable state across runtime process restart. Machine reboot wake depends on the advertised supervisor/Herdr capability and is `false` unless proven. Capability results are timestamped and scoped to runtime `epoch`; every host-dependent operation rechecks Herdr and may return typed `host_unavailable` even if `hello` previously advertised wake support.

## Degraded modes

| Condition | Typed state | Behavior |
|---|---|---|
| Runtime unavailable | client `unavailable` | No Monitor API; existing local Jobs/Subagents continue unchanged |
| Herdr unavailable | `agentWake: none`, `host_unavailable` | Keep events pending; allow explicit inbox inspection after reconnect |
| Pi offline/lease expired | target `offline` | Keep events pending; no wake |
| Pi working/blocked | target `busy` | Keep events pending; subscribe/reconcile for idle |
| Watch root missing | monitor `degraded` | Retain cursor and retry scans |
| State file corrupt | runtime `storage_error` | Fail closed; never reset or silently dedupe from memory |
| Identity conflict | `conflict` | Do not replace owner; require a future explicit takeover operation |

## Dumbgram pressure test

| Observed failure | v1 result |
|---|---|
| Polling watcher lost its in-memory `seen` set | Durable monitor cursor and event state survive restart |
| Pi learned files only after user nudges | Events queue offline and wake the exact registered Pi when idle |
| Watcher exited or was killed as a guessed orphan | Monitor is a structural runtime resource; delegated agents never own it by PID |
| Repeated scans could redeliver a filename | Stable monitor generation/path cursor and event ID dedupe |
| Pi was busy when external work arrived | Event stays pending; runtime and Pi both enforce user-priority admission |
| Original pane moved | Runtime follows only the same terminal + agent session, never focus |
| Runtime/Herdr unavailable | Capability degrades explicitly; no process-local semantic fallback |
| Two logical actors wrote as `fable` | **Not solved by Monitor v1.** Exclusive participant leases are the next layer |
| Mission review/completion churn | **Not solved here.** Mission policy remains in Pi |

## First implementation acceptance

One real E2E must prove:

1. Register an exact Pi session in Herdr.
2. Create a non-recursive directory monitor with an empty baseline.
3. Create one file while Pi is busy or unavailable.
4. Restart `pi-kit-runtime`.
5. Resume/idle the exact Pi session and receive one hosted event wake.
6. Admit and acknowledge the event.
7. Restart runtime and Pi again; the acknowledged event is not redelivered.
8. A different pane/session cannot claim or acknowledge it.

Anything beyond this path is deferred until the vertical slice passes.