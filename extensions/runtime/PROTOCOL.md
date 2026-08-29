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

## Original Release 1 baseline

The first release included:

- one Runtime service per Pi agent directory;
- one direct-child, created-regular-file Monitor per target;
- exact Pi/Herdr registration and heartbeat;
- durable queue, claim, acknowledgement, release, and lease recovery;
- exact Herdr wake for `idle` or `done` Pi agents;
- authoritative directory scans with `fs.watch` as a latency hint;
- exclusive Pi collaborator identities and durable directed mailboxes.

The current release additionally ships native Claude Code/Codex collaborators, Runtime-owned bridge runners, isolated writable workspaces, and optional typed task outcomes. Still deferred:

- recursive/content/modification/deletion monitoring;
- collaborator groups, broadcasts, and attachments;
- durable schedules and automatic takeover;
- native service installers and Windows transport.

## Operation

Runtime reuses a healthy socket. On `/runtime start` or the first Runtime-dependent operation, a missing Runtime starts in the initial tab of a dedicated, no-focus `pi-kit-services` Herdr workspace rooted at the Runtime state directory. Pi may automatically register on session start when the Runtime socket already exists.

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
    "agentWake": "none",
    "maxDeliveryBatch": 12,
    "monitor": {"maxEntries": 10000}
  }
}
```

`runtimeId` persists; `epoch` changes on every service start. `agentWake` is `none`: Pi claims pending inbox work through its in-process heartbeat and Runtime never prompts a Herdr pane.

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
| `task.send` | Append one explicit bounded task with deterministic request identity |
| `task.result` | Publish or recover the exact schema-validated task result and Runtime-derived workspace evidence |
| `task.status` | Read pending or settled structural status as the exact task sender |

All methods except `hello` and `pi.register` require the exact current registration ID and key. Mutations are idempotent on their typed durable keys. `participant.acquire` reports whether that call transitioned ownership; automatic rollback supplies the acquired generation to `participant.stand_down`, which fails if ownership changed. `participant.stand_down_confirmed` additionally requires a schema-validated confirmation boolean and exact expected generation; it can only move a same-project participant from held to vacant. `participant.stop_confirmed` uses the existing target/session identity to close only a plugin-managed single-pane Herdr tab, preserves mail, refuses self-stop, and is retry-safe when the tab is already absent. Bridge stop fences the controller first, then proves the exact durable worker group quiescent before vacating the participant.

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

Claims contain at most 12 events in Runtime creation order, with source identity/generation/sequence used only for deterministic ties. Normal acknowledgement or release requires the same registration generation and exact claim/event receipt. Historical registration reconciliation is the only generation-exempt path.

Acknowledgement means the hosted message entered Pi session history; it does not mean the model completed resulting work.

## Wake and admission

Pending events remain queued while the target is offline, unverified, or unable to accept a new model-visible turn. Runtime never prompts or focuses a Herdr pane for inbox delivery.

Every two-second registration heartbeat reverifies the exact Herdr terminal, Pi session, cwd, and freshness, and returns a typed `inboxReady` flag whenever the target has pending events. The Pi client checks that it is idle with no pending messages, atomically claims the first batch, and enqueues one hidden `deevs.hosted-runtime.v1` custom message in-process with `pi.sendMessage`. If Pi is busy, the event remains pending for a later heartbeat. The next submitted user turn remains the durable fallback.

- Synchronous enqueue failure releases the claim.
- `message_start` acknowledges admission.
- A pre-admission crash returns the claim to pending after lease expiry.
- A post-admission/pre-ack crash is reconciled from Pi history during registration.
- Legacy persisted wake IDs remain acceptable during upgrade, but Runtime creates no new prompt wakes.

## Collaborator mailbox

A participant is addressed by `(canonicalProjectRoot, protocol, participantId)` and has one durable state: `held`, `vacant`, or `ended`. One Pi target may hold one identity. Stand-down explicitly consents to succession; release ends the identity; takeover requires an offline holder, the exact observed generation, restart grace, and Pi-side user confirmation. Ownership never changes on a timer.

Mailbox messages are addressed to participants rather than historical Pi sessions. The user-facing `collaborator_send` tool accepts 1–12 ordered messages whose recipients are either participant IDs (`main`) or equivalent same-protocol references (`demo/main`); cross-protocol references fail closed. Every send asserts the exact sender participant key and generation, so concurrent identity rotation fails rather than sending as a successor. Runtime resolves the current recipient holder only when claiming, so pending messages follow an explicit succession. Each sender-recipient stream has a durable sequence. `(senderParticipantKey, sendId)` plus a recipient/body fingerprint makes retries idempotent and changed retries conflict.

Bodies are capped at 16 KiB and become model-visible input in the recipient Pi session. They are authored by an identity-verified participant in the same trusted project, but remain untrusted prose: bodies never authorize routing, ownership, takeover, acknowledgement, or verdicts.

### Optional bounded task results

Free-form `mailbox.message` remains the default. `collaborator_task` is additive and uses explicit `send | result | status` actions only when an automated consumer needs structural settlement. A task is a durable `mailbox.task` event; its exact event ID is the reply identity input. Exactly one `mailbox.task_result` may settle it with schema-validated `completed | failed | cancelled`, a bounded body, deterministic `replyId`, and `sessionAdvance: none | committed`. Status collection is authorized only for the exact held task sender and returns `pending` or the stored typed result; it never parses the body.

Runtime deduplicates task requests by sender/send ID and results by responder/reply ID plus the original task event. Response loss retries the exact IDs; changed retries conflict. A second reply identity cannot settle an already-settled task. Native bridges derive result status/session advancement from their validated terminal frame and durably publish it through the existing reply state. Pi peers explicitly call `collaborator_task action=result`; because that occurs in an admitted model turn, Pi results record committed session advancement.

A workspace-bound responder receives Runtime-derived evidence captured at result publication: workspace ID, base/head commits, private branch artifact reference, durable workspace state, capture timestamp, and a bounded Git dirty check. The responder cannot forge this evidence. It is inspection/handoff context only: task status/body/workspace evidence never authorizes lifecycle, permission escalation, checkpoint, integration, discard, Mission completion, or review verdict. Uncertain native session advancement remains `needs_attention` and publishes no normal task result.

Herdr remains the live process layer. The Runtime daemon occupies the initial `pi-kit-runtime` tab of its dedicated services workspace; collaborator tabs stay in the requesting project workspace. `/runtime collaborator-start <protocol> <participant-id> [model]` materializes a child Pi session, creates a no-focus tab, starts Pi with the optional validated model pattern, and waits for the child to acquire its environment-bootstrapped identity. Runtime never changes pane or tab focus. The identity disposition is mirrored in Pi session history for safe reload/resume. Models use read-only `collaborator_list`, confirmed `collaborator_manage`, and data-plane `collaborator_send`. Manage actions are schema-validated `start`, `stand_down`, or `stop` over 1–12 exact participants under one trusted confirmation. Start candidates independently select a closed driver key, validated driver-owned model selector, trusted built-in persona, and execution profile. Driver omission defaults to Pi; `claude-code` and `codex` run bounded native CLI turns through Runtime's private bridge runner. Persona starts default to `read-only`; required incompatible tooling is rejected before confirmation, while runner-only terminal tools such as the bounded subagent `review_report` sink are optional in free-form collaborator mode. Reviewer personas may use `safe_diff`, whose argv-only Git execution resolves exact commits at the canonical project root, treats paths literally, disables hooks/pagers/external diff/text conversion, lazy object fetching, replacement refs, and inherited Git control variables, and bounds output. The resolved driver, model selector, persona prompt/hash, and profile are stored as versioned child launch metadata; the persona is injected into every model turn. Both `read-only` and `workspace-write` use explicit tool allowlists plus project-confined file paths, re-enforced after resume; `workspace-write` adds file edit/write tools but not shell or lifecycle control. Chain checkpoint metadata remains allowed under `read-only` because it is session recovery state, not production code. Starts launch only new or vacant identities with concurrency at most four; single start may acquire or reacquire the caller, while multi-start requires an already-held caller. Stand-down leaves the exact process dormant; a later confirmed start first closes that exact stood-down target, then launches the replacement under the still-vacant generation, preventing orphan targets. Stop closes only exact managed Herdr tabs. Release, revival, and takeover remain user commands.

### Generic bridge launch authority

Runtime state v6 retains strict discriminated Pi/bridge targets, bridge-owned isolated workspaces, and typed task/result events. Existing v1/v2 targets migrate to `kind: "pi"`, v3 bridge state migrates with legacy display metadata normalized, and v4 Pi workspaces migrate to explicit Pi ownership and released v5 state migrates directly without changing keys, sessions, participants, mailbox events, claims, or wakes; `pi.register` retains its canonical session-file and authoritative Herdr Pi checks.

The additive bridge RPC is an internal control-plane seam, not a public driver SDK. An authenticated held Pi caller may reserve one new/vacant participant generation against an exact empty Herdr pane, project, profile, canonical configuration hash, and bounded opaque metadata. Runtime returns a 30-second random launch token once and stores only its SHA-256 digest. A separate random reconnect credential is also returned once and stored only as a digest. Pending reservations block competing participant acquisition.

A bridge must first report the generic Herdr session identity `(source=pi-kit-bridge, agent=bridge, kind=id, value=launchId)`. The native reporter frames this in Herdr's syntax-only agent label `bridge:<launchId>` because custom labels do not retain arbitrary session IDs; Runtime accepts only the closed bridge-ID grammar and reconstructs that exact internal tuple. Registration re-verifies the exact pane, terminal, single tab/workspace binding, cwd, caller generation, participant prior generation, and capability digest before one atomic state mutation creates the bridge target, acquires its preallocated holder generation, and consumes the launch token. The launch token cannot register again. The separate reconnect credential deterministically rebuilds the same in-memory registration after Runtime restart only while the exact bridge target still holds that participant generation. Generic bridge metadata is capped and allowlisted to the non-authoritative adapter label; driver/model/persona/profile and credentials remain in their authoritative owner-private runner configuration instead of leaking into generic target state. Heartbeat and stop dispatch by target kind; bridge stop re-verifies the exact reported bridge and single-pane tab, closes that controller, then reads the authority-matched runner journal and quiesces any witnessed worker group before it may settle. An absent tab is not sufficient on retry. Missing/mismatched identity or an unquiesced group fails closed without vacating the participant. Plaintext launch/reconnect secrets are absent from durable state, bridge metadata, and registration results.

This authority protects against accidental/cross-wired same-UID project children that do not possess the random credential; it is not an OS sandbox against a hostile same-UID process that can inspect another process's memory. Native Claude Code/Codex launchers use this seam without exposing a public driver SDK.

### Durable common bridge runner

The internal bridge runner is a persistent Herdr-hosted controller with a private, frozen registry for the test-only `fake` adapter plus production `claude-code` and `codex` adapters. The registry remains private until another driver proves a stable public contract.

Runtime claim acknowledgement means **durable runner admission**, not native completion. The controller atomically writes and fsyncs the exact claim/event payload, sender, order, deterministic reply ID, and `ack: uncertain` before `inbox.ack`. Reconnect supplies those exact receipts through bridge registration; successful reconciliation marks them confirmed. Event IDs and turn sequences deduplicate redelivery. At most one turn executes, and the next turn does not start until the previous deterministic reply is durably confirmed sent.

Each turn uses a fresh detached Node worker process group. The worker persists and reports its own PID/start identity, then waits for the controller to durably record and explicitly authorize that exact worker before spawning one non-detached native child into the recorded group. Readiness failure quiesces the exact group or enters `needs_attention`; controller/worker terminal hangup also requests cancellation as defense in depth. Worker/native environments are explicit allowlists and contain no Runtime socket credentials, launch/reconnect token, registration key, Herdr authorization, or controller environment. Adapters only produce argv/stdin/env and validate typed provider frames; common code owns fatal UTF-8/JSONL framing, closed frame schemas, line/total/stderr/frame/body/wall caps, terminal uniqueness, process identity, cancellation, and persistence. Claude Code uses `dontAsk` with only native read/glob/grep tools in read-only mode and `acceptEdits` with explicit edit/write additions in an isolated writer workspace; Codex receives `--ask-for-approval never` with `--sandbox read-only` or `workspace-write`. Neither uses dangerous bypass flags.

A zero exit without exactly one validated terminal frame is failure. Terminal result and session cursor are committed in one durable journal write before outbox send. Reply send ID/body are durable before `mailbox.send`; uncertain publication retries the exact ID/body and relies on Runtime's sender/send-ID fingerprint dedupe.

Native computation is honestly **at least once**. A crash after execution may have begun but before terminal persistence records `sessionAdvance: uncertain`. The runner resumes an exact live worker or its durable terminal result; if the worker leader is lost while its exact recorded native child remains, Runtime quiesces that owned group before entering attention. Cancel intent is durable before signaling. Without an exact worker/child identity witness, or when the witnessed group cannot be proven quiescent, the turn and controller atomically enter typed `needs_attention`; Runtime never guesses a PID/PGID, replays, replies, ACKs a later claim, or claims exactly-once effects.

Runner journal/config/worker records are owner-private, size-capped, strict-schema atomic snapshots (temporary write, file fsync, rename, directory fsync). After Runtime durably confirms replies, the runner retains the newest 64 settled turns and atomically compacts older confirmed admissions, then removes only their exact UUID-named turn directories beneath the canonical runner root; restart scavenges artifacts left by a crash between those steps without following symlinks. Active turns, uncertain admissions/publications, and attention turns are never compacted, sequence/session cursors remain monotonic, and Runtime remains the authoritative delivery/result dedupe record. Corruption, unknown fields, symlinks, overflow, unterminated/invalid/deep JSON, duplicate terminal frames, and output-limit violations fail closed. The reconnect credential is confined to the controller config; journal, worker spec/state, and native environment never contain it.

### Isolated writable workspaces

Every Pi or native `workspace-write` start provisions a Runtime-owned linked Git worktree and private branch before child launch. Logical participant/project identity remains the canonical main repository while the child Pi session and Herdr cwd are the exact isolated worktree. A single-use digest-only workspace launch token binds the trusted caller generation, intended participant prior/preallocated generation, Pi session, exact empty single-pane Herdr target, and worktree identity; the child deletes the plaintext token from process environment after capture. Registration atomically activates the workspace target and participant generation before acknowledgement. Legacy managed workspace-write sessions without authoritative workspace metadata fail closed to read-only tools.

Participant stop retains the workspace; it never deletes changes. Checkpoint creates bounded hook/signing/filter-safe Runtime commits and typed handoff evidence. Integration preparation cherry-picks the whole linear range in a separate Runtime worktree and preserves conflicts without touching main. Finalization remains separately confirmed and requires exact clean main/prepared identities plus an unchanged main head. Cleanup/discard is a distinct exact-ID operation; unintegrated or conflicted discard is always confirmed. Message/task prose has no workspace authority. See [`WORKSPACES.md`](WORKSPACES.md) for the normative state, Git, handoff, integration, concurrency, and cleanup contract.

### Collaborator Auto mode

Global collaborator mode is typed, persistent Runtime-root state and defaults/fails closed to MANUAL. `/runtime auto setup` is an explicit trusted operation that preserves unrelated Pi keybindings, moves thinking-level cycling from `Shift+Tab` to `Ctrl+Shift+T`, binds the extension Auto toggle after reload, and refuses malformed, symlinked, or conflicting configuration. `Shift+Tab` and `/runtime auto on|off|toggle` are trusted mode operations; no model tool or mailbox message can enable Auto. The main Pi footer always displays the effective `MANUAL` or `AUTO` mode; managed child collaborators do not inherit or display global authority.

In MANUAL, lifecycle tools retain user-intent and confirmation behavior. In AUTO, an authenticated main Pi tool call may start, stand down, stop, or later restart through another start without repeated confirmation. All starts are serialized across Pi sessions by an atomically published Runtime-root lock; stale or malformed locks fail closed for explicit operator recovery. Auto re-reads authoritative participant state under that lock and rejects more than twelve live non-caller collaborators; each batch still runs at concurrency four. An ambiguous Auto launch is closed by exact Herdr tab identity before capacity is released; if exact closure fails, the lock and recovery artifacts remain preserved and later starts fail closed. Auto lifecycle authorization and settlement are appended to the controlling Pi session with exact mode generation, target, participant identities, action, and typed outcomes. Malformed Auto state disables authority and warns; toggle operations reject it, while an explicit trusted `auto on` or `auto off` replaces the corrupt state.

Auto resolves and persists an effective profile for every start: omission defaults to `read-only`, and the ceiling is `workspace-write`. It does not authorize release, revival, takeover, main-tree integration, or destructive workspace discard. Message prose remains untrusted: the main model may consider it as context while Auto is enabled, but Runtime authorization derives only from valid persisted Auto state plus the authenticated main Pi tool call.

## Persistence and retention

Runtime stores one bounded, schema-validated state document. Mutations write a temporary file, fsync it, atomically rename it, then fsync the parent directory. Corruption fails closed; Runtime never resets to an empty inbox.

Pending and claimed events, claim receipts, wakes, and Monitor cursors are never age-pruned. Acknowledged events and complete settled claims are retained for seven days and pruned atomically with later acknowledgements.

Whole-state replacement is intentional for Release 1. A journal or database is deferred until measured state size or write throughput requires it.

## Release gate

Run from a source checkout with Herdr and its Pi integration installed:

```bash
npm run smoke:runtime-release
npm run smoke:collaborator-release
npm run smoke:collaborator-auto-release
npm run smoke:native-release
```

These isolated gates use unique Herdr servers/sessions/sockets, Pi agent directories, Runtime state, projects, and Pi sessions. The Runtime gate proves offline Monitor queuing, restarts, exact wake/admission, historical reconciliation, foreign-session rejection, and no redelivery. The two-Pi Collaborator gates launch their child through production `collaborator_manage` in Manual and Auto modes, verify v3 session materialization and identity binding, prove Auto's omitted profile persists and enforces read-only, and prove bidirectional mail, identity conflict, stand-down queuing and reacquisition, release/revival, claimed-mail takeover after lease expiry, historical mailbox reconciliation, and no redelivery across a full heartbeat interval. They also create a production Mission in the real parent Pi, deliver and acknowledge the collaborator reply while that Mission is active, restore its canonical state after the parent closes, record/adjudicate through registered Mission tools, admit and recover exactly one typed reviewer across parent reloads, and commit exactly one completion/effect across replay. The deterministic native gate executes Claude/Codex shims through the production bridge controller/worker and Runtime socket, proves driver-owned read-only/workspace-write argv, then checkpoints, stages, finalizes, and cleans a real isolated Git worktree while keeping main untouched before finalization. All gates clean isolated resources and never connect to the user's active Herdr server.
