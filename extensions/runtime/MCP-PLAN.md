# Universal collaborator messaging plan

## Status and scope

**Stage 0 passed; the unreleased Stage 1 foundation passed automated and isolated live publication checks.** After the plan-only review and Fable's independent assessment, the user explicitly requested implementation. See [Stage 0 evidence](MCP-STAGE0.md#recorded-result--2026-09-10). This document describes staged work, not released messaging capabilities. Actual MCP transport for Pi remains the selected design.

The user authorized focused automated tests plus `npm run check`, and a live proof using fresh read-only Pi, Claude Code, and Codex agents. Proofs must use dedicated identities, preserve existing agents/workspaces, and stop only their own agents through trusted lifecycle operations. Stage 0 uses credential-free echo probes, not Runtime participants or live mail. The user subsequently authorized commits and pushes; the validated foundation was pushed as `ea2562b` and `f4eea04`. Installation and rollout still require separate authorization.

Target: one messaging tool contract and one skill for all three harnesses, inside `deevs-pi-kit`. Runtime remains the durable mailbox and authority service. Herdr remains the interactive process host and native-agent wake mechanism. Pi receives a package-owned MCP client adapter because Pi has no built-in MCP client.

This plan supersedes the native-only MCP interface and full-body native delivery assumptions in [PROTOCOL.md](PROTOCOL.md) **for future opted-in targets**. Existing targets, Pi admission, managed delivery, lifecycle controls, and workspace safeguards remain unchanged until their migration gates pass.

## Recorded Stage 1 result — 2026-09-10

- Real Herdr-owned Runtime, Pi controller, Claude Code 2.1.251/Fable, and Codex 0.151.0/gpt-5.6-sol; Pi remains 0.82.1 and Herdr 0.9.0. No fixture host or production Runtime root was used in this live proof.
- Both native providers started with the actual MCP endpoint configured to reference their future descriptor paths, then called peers/send/status after ordinary bridge registration and trusted issuance. Repeating issuance returned the same namespace/path. Normal registration leases were maintained by the bounded proof controller driver.
- Claude → Pi controller: `evt_161fb342-2f8a-438a-963d-e0ba194317b2`; Codex → Claude: `evt_75cec17b-4d4b-429a-8aa5-0ceed8bd7efd`. Correlated native tool results matched two durable Runtime events, both `pending`. Neither native inbox admission nor provider commit was attempted.
- The Pi session supplied genuine controller identity through its installed Herdr integration, with no model tools. **Pi did not yet call MCP.** This is not the three-harness receive/reply or admission gate.
- Both providers received the same shared skill source, SHA-256 `baf05e836dadb01d5deb0c6e3dbb482972f8e423086e71151ed1efcf68549353`; Codex's transcript contains its exact bytes. Native instruction hierarchy and additional skill catalogs are not identical.
- Restriction flags followed Stage 0, with the explicit MCP endpoint/tool allowlist, shared source, and isolated proof paths configured for Stage 1. Codex's actual `CODEX_HOME` matched its private proof home. This publication run is not an additional sandbox audit.
- A first Codex launch reservation was rejected by the exact cwd fence during shell startup. No Codex launch was persisted. After inspecting the same empty pane and renewing controller/native registrations, the proof continued successfully without relaxing identity checks or repeating Claude's publication. An earlier proof-driver JSON parse error concerned the successful, empty-output Herdr `pane run` command, not Runtime publication.
- Private evidence: `/tmp/pi-kit-stage1-T99gY9/evidence.json`, `claude-tool-evidence.json`, provider transcripts, and `cleanup.json`. Seven provider configuration/session/log files were scanned against twelve distinct credential values: no matches. The private driver manifest and Runtime descriptors contain credentials and must not be published.
- All four exact proof tabs were closed; seven recorded service/provider/MCP/router process identities were gone before the copied Codex authentication file was removed. Existing collaborators/workspaces were preserved; no focus-changing operations, installation, commit, or rollout occurred.
- `env -u PI_PACKAGE_DIR npm run check`: 502 tests across 49 files, lint/typecheck, RPC/print/JSONL smokes, zero audit findings, package dry-run. Eight messaging wire tests cover real MCP children and actual sockets/storage; their Herdr identities are fixtures. The post-rename failure uses explicit syscall fault injection, not a naturally occurring hardware fault. The original persistence review blocker was corrected and independently cleared.

Remaining gates: receive/reply and persisted Pi receive-result admission/recovery, live three-harness routing, descriptor recovery/renewal after quiescence, then daemon delivery cutover. Existing production launch/delivery remain untouched.

## Pi MCP adapter

`mcp/pi.ts` is an explicit `-e` entry, excluded from the normal extension manifest. Configure `--runtime-mcp-descriptor` with an absolute private descriptor path, on a separately registered isolated target; do not load the legacy Runtime extension in that Pi session. Registration, heartbeats and trusted issuance still belong to the existing controller/host path, not this messaging adapter. Node >=22.19 must be on the trusted process PATH, including when Pi itself is a compiled executable.

- `mcp/tools.ts` is the single package-owned schema catalog used by the endpoint and synchronous Pi registration. Pi still performs real MCP initialization, tools/list verification and tools/call over its own stdio child; it never calls an in-process Runtime handler or reads the descriptor secret.
- The adapter appends the exact shared skill source. It respects Pi tool allowlists and blocks conflicting messaging tool ownership or the legacy Runtime command, rather than silently choosing a backend.
- Authoritative peers output now includes the caller's public binding. Before exposing peers or forwarding send/status, the adapter verifies the current Pi session ID, canonical session file and cwd. Fork/new-session reuse of an old descriptor fails closed. Session shutdown settles the exact child; abort, transport loss and timeout never automatically replay an operation.
- The transport bounds outstanding requests (12), queued input (12 × 256 KiB), individual frames (256 KiB), stderr bytes (256 KiB, discarded), and request duration (10 seconds). Shutdown closes stdin, escalates to SIGTERM after 100 ms and SIGKILL after one second if needed, and awaits child close before replacement. Cancellation can still leave a committed publication; resolve it using its original namespace and operation ID.
- MCP tool errors become actual Pi `isError: true` results by throwing, while successful structured content remains in Pi result details. No body truncation, native inbox acknowledgment, or receive-result admission is introduced.

Reproducible `test/runtime-messaging-e2e.test.ts` checks use actual Pi CLI/RPC processes, the native Agent tool/persistence pipeline, actual MCP children, Unix sockets and the Runtime store. Only the model and Herdr identities are fixtures. Both development Pi 0.84.4 and installed Pi 0.82.1 passed the pipeline checks: peers/send/status, maximally escaped 16 KiB body, native error persistence, exact receipt recovery after Pi restart, new-session fencing, explicit tool allowlists and rejection of a test-only legacy-command collision. This is **not** a live hosted-model three-harness receive/reply or provider-admission proof. The direct-client test also covers metadata before issuance, cancellation settlement and recovery of a publication that commits after cancellation. Final validation: 505 tests across 49 files, lint/typecheck, RPC/print/JSONL smokes, zero audit findings, package dry-run, and a fresh read-only reviewer returned CLEAR for the production slice. The final installed-Pi pass repeated all three new process cases. An initial proof invocation used unsupported `--no-context`; it was corrected to `--no-context-files`, not counted as a successful run. Both failed-run fixture roots were removed only after their processes and sockets were gone. Use `PI_KIT_MCP_TEST_PI=/absolute/path/to/pi` to repeat the Pi subprocess cases against a specific installed binary; otherwise they use the development SDK CLI.

## Architecture

```text
Pi extension MCP client ─┐
Claude native MCP client ├─ same tools-only MCP implementation ─ Runtime service/store
Codex native MCP client ─┘                                         │
                                                     exact identity + delivery mode
                                                                  │
                                             Pi native wake / Herdr native-agent prompt
```

- One MCP implementation and schemas, not one credential or one subprocess shared by every agent.
- Start with local stdio. Each harness owns its transport child inside its Herdr-hosted process tree; shutdown closes stdin and settles the child. No detached service, HTTP listener, provider session, or MCP-side mailbox/spool.
- The long-lived Runtime daemon remains Herdr-owned. Transport child failure must not lose committed mail or change participant ownership.
- Use the same MCP tool names and arguments in every harness; host-added prefixes may differ. Pi's adapter forwards real MCP calls rather than implementing a second messaging backend.
- Keep Pi's trusted lifecycle/workspace UI and internal admission hooks outside the messaging interface. MCP credentials cannot call them. Do not expose a generic Runtime RPC passthrough tool.
- No production dependencies in the initial scope. Implement only the bounded MCP stdio/tools subset needed here, not a general-purpose MCP framework. Revisit this decision with explicit dependency approval if conformant interoperability requires substantially more machinery.

## Current implementation and constraints

| Source | Existing behavior and implication |
|---|---|
| `service/participant.ts::sendEnvelope()` and `service/state.ts::reduceHostedState()` | Atomic mail publication, sender-generation checks, same-project/protocol routing, fingerprints, and per-peer ordering already exist. Reuse them. |
| `service/protocol.ts` and `service/registration.ts::authorize()` | Registration credentials authorize more than messaging, including lifecycle operations. A tool allowlist alone cannot narrow a leaked registration/reconnect key. |
| `hosted-integration.ts::admitHeartbeatInbox()`, `acknowledgeMessage()`, `restoreAdmissions()` | Pi claims events, persists hidden custom messages, acknowledges at `message_start`, and reconciles historical receipts. Preserve these guarantees. |
| `service/wake.ts::claim()` | One active claim per target, shared across mailbox and Monitor events. A second MCP consumer must not compete for this queue. |
| `hosted-integration.ts::heartbeatManagedAgents()` / `submitManagedAgentInbox()` | Launching Pi currently drives native delivery. The service wake coordinator does not itself submit Herdr prompts; `agentWake` is `none`. Daemon ownership is real new work. |
| `hosted-types.ts` / `service/state.ts` | Stage 1 advances persistent state from v8 to v9 in `state.v1.json`, with explicit v1–v8 migration. Native capability remains literally `managed`. Claims do not bind participant generation/delivery mode; ordinary mail has no reply reference. |
| `service/state.ts::pruneAcknowledged()` | Pruning removes dedupe records too. An old operation can currently publish again after pruning; the MCP retry contract must not inherit that behavior. |
| `client.ts` | Responses are capped at 64 KiB. Twelve maximum-size 16 KiB messages will not fit; receive needs byte bounds as well as item bounds. |
| `hosted-integration.ts::interactiveAgentArgs()` | Claude uses `--safe-mode`, which disables MCP and skills. Codex explicitly disables hooks. Neither restriction can simply be dropped for convenience. |

Verified environment during planning: Pi 0.82.1, Claude Code 2.1.251, Codex 0.151.0, Herdr CLI/server 0.9.0 (protocol 22). Recheck versions before live validation.

## Common tool contract

The opt-in `mcp/main.mjs` endpoint currently exposes only peers/send/status, with the [shared skill](../../skills/collaborator-messaging/SKILL.md). Existing Pi tools and production launch/delivery remain unchanged. Send/status require an explicit `namespaceId` and `operationId`; current status looks up the sender's publication operation and retained native event, not an arbitrary received event. The table below describes the eventual contract; receive/received/reply remain unimplemented; the Pi MCP adapter above currently forwards only the implemented three tools. Never publish placeholders that report success.

| Tool | Input and responsibility |
|---|---|
| `collaborator_peers` | Bounded discovery of existing peers in the caller's exact project/protocol, plus caller identity, capabilities, and publication retry-window information. No credentials or unrestricted project enumeration. |
| `collaborator_send` | Explicit existing recipient, durable operation ID, bounded body. Server derives sender identity and returns a publication receipt only after commit. |
| `collaborator_receive` | Bounded inbox page or exact event lookup for the caller. Non-destructive, repeatable retrieval; returns exact event references and a holder-bound retrieval token. Does not acknowledge native admission. |
| `collaborator_received` | Explicitly records receipt of an exact retrieval token/event set. Means credentialed client receipt only, never provider commit or task completion. |
| `collaborator_reply` | Operation ID, exact inbound event/retrieval reference, body. Runtime derives the recipient and checks the recorded delivery holder. No arbitrary sender or reply-recipient override. |
| `collaborator_status` | Exact event/operation lookup authorized for the sender or recipient; independently reports publication, wake, client receipt, observed native admission, and replies. Includes queued age and uncertainty. |

Typed task send/result/status is a separately approved follow-up, not a prerequisite for the messaging release. These would be Runtime tasks exposed as tools, not MCP's optional task-augmented execution protocol. Do not advertise MCP tasks, sampling, resources, elicitation, or subscriptions merely for possible future use.

Messages remain explicit publications, including messages intentionally sent during human-driven turns. Ordinary terminal answers are never automatically forwarded. Same-agent-kind communication uses distinct participants; preserve the existing rejection of self-addressed mail.

### Bounds and wire behavior

- Keep the existing 16 KiB UTF-8 body limit and maximum 12-item bounds. JSON escaping can make even one body exceed 64 KiB, and MCP duplicates structured output into a text block. Budget actual encoded bytes: use a dedicated 128 KiB messaging RPC response ceiling and 256 KiB MCP frame ceiling, leaving the existing Runtime client's default unchanged. Return fewer items when necessary; never truncate a body or advance a cursor past an unreturned item. Prove the worst-case escaped single-event envelope fits before freezing these bounds.
- Pagination cursors must be opaque and validated against caller scope and stable ordering; exact lookup of a retained event must remain possible after reconnect. Expired cursors return an explicit error, not a skipped page.
- Negotiate a supported MCP version and tools capability; implement `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call` with strict JSON-RPC envelopes, UTF-8/LF framing, bounded buffers, backpressure, request timeouts, and clean EOF/shutdown handling.
- Distinguish JSON-RPC protocol errors from tool errors (`isError`). Return structured results and a matching serialized text block. Pi must preserve errors rather than converting them into successful tool output.
- Cancellation or socket loss after a mutation begins is not proof of non-publication. Resolve uncertainty through the original operation ID. Rate/concurrency limits must bound work before dispatch, not only output afterward.

## Authority and credential lifecycle

1. A trusted controller reserves/verifies an exact target and participant generation using existing launch/acquisition authority. MCP never creates or acquires its own identity.
2. Runtime issues a separate messaging descriptor and secret. Persist the authorization digest and binding to canonical project/protocol, participant/holder generation, target/client generation, and launch configuration. Keep descriptors owner-private and out of prompts, tool output, session history, Git, and review artifacts.
3. Stage 1 avoids pending credentials: provider configuration references a deterministic descriptor path derived from target/client generation. MCP metadata negotiation works before the file exists. Only after normal target registration and exact host verification may the trusted Pi controller issue a credential; the child lazily reads and caches it on its first tool call. The initialization handshake grants no authority.
4. The Runtime service authenticates every messaging request and permits only the messaging methods. Sender identity and routing scope come from that binding. No registration/reconnect secrets are passed to the MCP child.
5. Stand-down, stop, replacement, configuration change, or client-generation change invalidates old authority. Recheck after asynchronous host verification and immediately before persistence; a request cannot use a stale pre-await snapshot.
6. Restart recovery uses validated Runtime authority records and exact current target verification, not scanning Pi histories or selecting a pane by label. Missing/malformed authority fails closed. Descriptor removal waits for exact transport/provider quiescence.

The owner-only socket remains a same-UID trust boundary, not protection from a hostile process running as the same OS user. The restricted credential prevents accidental privilege forwarding and cross-wired clients; it does not create an OS sandbox.

### Credential bootstrap

Deliver the messaging secret in a Runtime-owned regular descriptor file (0600 inside a 0700 directory), never inline in arguments, environment values, provider settings, prompts, or tool output. The child receives only its exact descriptor path. Per-launch provider MCP configuration files also live in owner-private Runtime storage; they reference that path, not the secret. Validate ownership, modes, and exact launch binding before reading; reject symlinks or unexpected files. Never overwrite a descriptor to recover an uncertain operation. Current issuance reuses an active matching grant but does not repair a missing/malformed descriptor. Orphaned or expired deterministic files fail closed with a file conflict; automatic recovery/renewal is deferred. Reconfiguration requires trusted exact-client handling, and removal of descriptors/configuration requires associated transport/provider quiescence. Persist authorization digests and receipts independently of these bootstrap files.

The Stage 2 proof must negatively check provider session/config/log artifacts for the secret value without printing it. This does not protect against hostile same-UID processes.

Stage 1's internal send RPC uses canonical base64 for the validated UTF-8 body, preserving the existing 64 KiB request ceiling even for maximally escaped text. Wire tests cover a full 16 KiB NUL body and matching structured/text MCP results. Publication and its retry receipt commit together. A failure after state-file rename fences all store reads/writes until restart; recovery must successfully sync the state directory before exposing the validated snapshot. A warm process restart alone is not durability confirmation. A syscall-injected directory-sync failure exercises preservation, rejected recovery while sync remains broken, and exact receipt recovery over the real MCP/socket path. Known pre-rename failures do not fence the store. Do not run older Runtime binaries against migrated v9 storage.

### Operation identity and retention

- An operation ID is independent of body text, model tool-call ID, and MCP request ID. Store its semantic fingerprint and receipt atomically with the mail event. Same ID/input returns the original receipt; changed input conflicts. Different IDs intentionally create different messages.
- Reply fingerprints include the inbound event and recorded holder/retrieval binding. Never infer duplicates from identical prose.
- Use a server-issued, expiring publication namespace as part of the full operation identity. Retain all dedupe receipts for an accepting namespace; once expired, reject every mutation in that namespace before consulting pruned receipts. Do not silently rewrite an expired operation into the current namespace.
- Connection/re-registration within a valid retry window must preserve operation identities. Credential renewal must not automatically resend uncertain old operations as new publications.
- Initial namespace lifetime: seven days, reusing the existing acknowledgement-retention duration. Keep compact operation/fingerprint/receipt records until namespace expiry even if an acknowledged message body is pruned. Retain body/status history under the existing seven-day-after-ack policy; unacknowledged work is not dropped merely to free capacity. New maps remain subject to the existing 10,000-record and 8 MiB state bounds; admission fails explicitly at capacity rather than evicting active retry protection.
- Missing, revoked, or expired namespaces are never recreated from a caller-supplied ID. Persist expiry as terminal when observed so clock rollback cannot reopen a closed namespace. A fresh namespace requires trusted controller issuance and never migrates uncertain old operations automatically. Verify current authority first, then recover an existing receipt before applying fresh-send recipient availability checks. Test expiry/pruning and ended-recipient retries explicitly.

## Receive, wake, and admission are separate

The public API is uniform; the evidence available from each harness is not.

### Non-destructive receive

`collaborator_receive` reads the caller's authorized mail without deleting it or advancing Pi's admission claim. Before returning a newly offered event, Runtime persists its exact event/target/client/participant-generation retrieval binding. A lost response allows repeat retrieval; an offer record is not proof the client saw it.

`collaborator_received` records a subsequent explicit client receipt. It may suppress redundant notification of that offered event, but does not hide it from exact lookup/history or settle a task. A valid reply may atomically record the corresponding client receipt. Silence does neither. Holder succession cannot reuse an old retrieval token; historical mail access or re-offer requires an explicit succession policy, not current ownership alone.

Stage 1 does not add another consumer to the existing inbox. Initial Pi receive integration may expose already-admitted items only. Native consuming delivery/replies require new delivery-mode and holder binding before they are enabled.

Before implementing receive, account for offer bindings under the same record/byte capacity limits as operation receipts. Repeated offers to the same exact holder/client reuse the existing binding. At capacity, preserve retrieval of already-offered events and report blocked new offers explicitly without advancing past them. Do not silently evict active bindings. A derived binding may replace persisted offers only if it proves equivalent old-holder/history/reply protection; current ownership alone is insufficient. Similarly, consider sharing namespace identity with the messaging descriptor before Stage 1, but retain terminal expiry and uncertain-retry protection across credential renewal.

### Pi admission

Keep Pi's native hook as the session admission authority. For opted-in targets, it wakes the model with a durable mailbox reference, while the model-facing tool retrieves the body through MCP. Do not acknowledge the body merely because the wake reference entered the session.

Before switching Pi to reference-only wake, prove a concrete receipt path through the Pi extension for the exact persisted receive tool result (including reload/tree/compaction recovery). Record reference admission and body admission separately. If the public extension API cannot prove equivalent body admission, retain existing full-body native delivery during the proof and block the Pi cutover; do not relabel a client receipt as `admitted`.

Monitor events remain on their existing native admission path. No MCP mailbox method claims, acknowledges, or exposes unrelated filesystem Monitor events.

### Native wake and delivery

For opted-in Claude/Codex targets, the service-fenced wake owner submits a bounded event/attempt reference through `herdr agent prompt`; message content comes from MCP receive. During Stage 2 the launching Pi remains the wake submitter, including for `mcp_pull` targets; Stage 3 transfers that role to the Runtime daemon. Preserve exact target verification and idle/focus/user-priority gating. Herdr submission, offered content, client receipt, reply publication, and native turn evidence are independently recorded.

A fresh attempt is persisted before submission. An ambiguous or submitted wake is never automatically replayed; a failed, proven-not-submitted attempt may be retried under the documented delivery policy. Pending or uncertain mail stays inspectable/retrievable even if no wake arrives. A direct human turn may intentionally receive it. Recovery must not fabricate `no_reply`, cancellation, or completion from elapsed time.

## Provider integration and shared skill

### Pi

Add a narrow client for the package-owned MCP server, register the common schemas through `pi.registerTool()`, and forward calls with correct cancellation/error semantics. Do not build an arbitrary MCP server manager. Start transport resources lazily after session initialization; shut them down on session shutdown/reload/switch. Native admission and trusted lifecycle UI remain internal.

The old `collaborator_send` registration cannot coexist under the same name with the new interface. During the proof, use separate explicit proof sessions/configuration. At cutover, have one active messaging registrar per target; compatibility for old session arguments must be explicit, bounded, and must not invent a new operation ID for an uncertain retry. Preserve existing Pi `collaborator_task` behavior until its separately approved MCP migration; do not duplicate task implementations or remove existing task support as a side effect of messaging cutover.

### Claude Code

The current safe-mode launch is incompatible with MCP/skills. Prove a replacement using supported restricted settings, exact MCP configuration/allowlisting, and the existing read/search-only tool policy. Installed CLI advertises `--restricted`, `--strict-mcp-config`, `--settings`, and `--allowedTools`, but their combined behavior is not yet validated.

The proof must show that project/user hooks, unrelated MCP servers, shell execution, extra filesystem access, and permission bypass remain unavailable. Do not solve the conflict by blindly removing `--safe-mode` or switching to bypass permissions. Preserve authentication, model, persona, cwd, and visible conversation.

### Codex

Use per-launch `mcp_servers` configuration and the read-only sandbox while keeping hooks disabled. Confirm how to exclude unrelated inherited MCP configuration without altering the user's global files. Prove the MCP child can reach only the required Runtime interface without expanding project write permissions. MCP support does not authorize project hooks.

### Skill

Create one provider-neutral `skills/collaborator-messaging/SKILL.md` when its tools exist. Explain tool discovery/prefixes, explicit send/reply intent, operation-ID reuse, receive/receipt distinctions, user-priority behavior, and how to report uncertainty. No credentials, lifecycle authority, or prose-driven task inference.

Load the same source through each harness's supported per-launch skill/context mechanism; do not copy divergent instructions into three skills or write global settings. If a restricted harness cannot discover the skill, prove a supported exact-source context attachment and document that behavior. Keep `skills/collaborators/SKILL.md` for trusted lifecycle/workspace orchestration and link it to the common messaging skill at migration.

## Delivery ownership and migration

- Add an explicit state-version migration for authority, reply/retrieval evidence, operation namespaces, and delivery ownership. Preserve v1–v8 migration and unknown-version rejection. Do not alter live v8 targets merely because the daemon binary changed.
- Persist per-target delivery mode (`legacy_push` or `mcp_pull`) and controller generation. Delivery mode is independent of controller ownership: Stage 2 has Pi-owned `mcp_pull` targets too. Stage 3 fences that predecessor as well as legacy push. Every claim/submission/settlement path checks the selected owner at the service. Fencing must reject old Pi-controller calls even if it still holds otherwise-live registration credentials.
- For initial live proof, use fresh opt-in targets and an isolated Runtime root. Do not migrate existing agents or borrow their credentials. Define the proof provisioning command before live launch; it must use the same verified identity/Herdr launch rules, not a test-only authorization bypass.
- Production handoff pauses old delivery, settles or retains exact in-flight attempts, verifies the successor controller/target, then atomically switches ownership. A full-body submitted or ambiguous event must not silently become a fresh pull delivery.
- New daemon-owned delivery must continue after the launching Pi exits. Another authorized controller can inspect status without accessing the old Pi's session history.
- Rollback disables new delivery and preserves evidence. Never run an old binary against an upgraded writable state store or restore a pre-migration snapshot over newly committed mail. Keep legacy targets on their original path; uncertain handoffs remain `needs_attention` until explicit recovery.
- Inventory legacy bridge targets/journals before removing compatibility code. This work does not authorize workspace discard, checkpoint/integration, or broad removal of existing control-plane safeguards.

## Implementation stages and exit gates

### Stage 0 — restricted provider compatibility

Before Runtime authority/state changes, use the development-only [echo probe](MCP-STAGE0.md) in fresh, isolated Claude/Codex sessions. It has no Runtime credentials or mailbox. Prove the exact restricted launch flags permit only the intended MCP server/tools, exclude inherited hooks/unrelated MCP/shell/writes, and attach one exact source of shared instructions without changing global settings. Keep provider authentication and visible sessions intact. An exec/print proof alone cannot pass the interactive gate.

Record installed versions, the requested and negotiated protocol revision, exact launch configuration, explicit tool calls, permissions/configuration evidence, and exact child cleanup. Probe protocol revision is pinned to `2025-11-25`; clients requesting another revision receive that supported version and must accept it or disconnect. Check maximum escaping with a synthetic envelope now and the actual frozen event schema in Stage 1. A nonce echo proves a tool/context round trip, not Runtime identity, admission, or permission denial; negative gates need separate evidence.

**Exit:** both restricted interactive providers accept the pinned MCP revision and exact shared context, no unauthorized capabilities/configuration execute, no unapproved global configuration edits or effects on existing agents, no focus mutation, and exact proof process/child quiescence. Record any blocked gate rather than weakening restrictions. Stage 1 waits for this gate.

### Stage 1 — messaging foundation

Implement service-enforced restricted messaging authority and byte-bounded discovery/send/status over the existing store, then the minimal MCP stdio endpoint. Define operation namespace expiry and persist receipts before exposing mutations. Add the common skill only for the tools actually available. Validate through isolated Runtime fixtures; leave existing public Pi tools, registrations, delivery, and installed package untouched.

Likely code seams: `service/protocol.ts`, `service/participant.ts`, `service/state.ts`, `hosted-types.ts`, `service/server.ts`; a focused `service/messaging.ts` if separating restricted authorization avoids mixing control-plane methods; `mcp/main.ts` and tool definitions below `extensions/runtime/` (not a new auto-loaded extension entry point).

**Exit:** valid MCP handshake/list/call using the revision(s) proven in Stage 0, authenticated durable send/status, no broad credential exposure, retry/conflict/expiry behavior, worst-case encoded single-event and duplicated text/structured envelope bounds using the actual event schema, bounded responses, and all existing admission tests unchanged. Receive/reply remain unadvertised until their binding is implemented; no placeholder success.

### Stage 2 — isolated three-harness proof

Add non-destructive receive/client receipts/reply correlation, exact target delivery mode and holder binding, Pi's client adapter, and provider-specific restricted startup configuration. Prove tool/schema parity and skill availability. Exercise Pi → Claude → Codex → Pi, proactive mail from a human-driven turn, and dedicated Pi-to-Pi delivery. Start with existing Pi admission; reference-only Pi cutover remains blocked on body-admission evidence.

The launching Pi submits reference wakes under the same service-fenced attempt-evidence rules until Stage 3 transfers ownership.

**Exit:** real same-visible-session MCP round trips, no broad permissions or focus changes, correct operation/event/holder correlation, negative authorization and secret-leak checks, MCP receive interleaved with native Pi heartbeat/claim/ack and Monitor admission on the same store, transport child cleanup including Pi reload/tree-switch/compaction, and no effects on existing collaborators. The ring is a first proof, not the full pairwise release matrix.

### Stage 3 — daemon delivery and Pi receive cutover

Implement service-fenced daemon delivery, exact controller handoff and restart recovery. Complete the Pi persisted receive-result admission path and test Monitor coexistence. Enable reference-only wakes only for targets that passed their proof gates.

**Exit:** delivery after launching Pi exit, no duplicate submission during handoff/restart, no false admission, preserved pending/ambiguous mail and exact history receipts, and a demonstrated non-destructive rollback procedure.

### Stage 4 — messaging release

Prove every directed Pi/Claude/Codex messaging pairing, including two distinct same-kind participants. Update README and skill/setup documentation, switch the public messaging registrar, and retire duplicate messaging APIs/legacy code only where compatibility evidence permits. Keep unsupported MCP task tools absent; retain existing Pi task behavior.

**Exit:** applicable messaging and regression validation below, clean package contents, documented current capabilities/limits, and explicit rollout approval. Commit/push/install actions remain separate user operations.

### Separate follow-up — typed tasks

Requires separate scope approval. Expose task tools only after exact responder/delivery binding, single-result enforcement, and Runtime-derived evidence are verified. Do not accept model-supplied provider-commit claims. Run the task-specific acceptance cases before upgrading capability. Messaging can ship without this follow-up.

## Validation plan

Automated tests and `npm run check` are authorized for implementation. Use existing Vitest suites instead of another framework. Stage 0's probe tests do not substitute for Runtime authority or live provider permission proofs.

| Area | Required cases |
|---|---|
| MCP transport | Initialization order/version negotiation; malformed JSON/UTF-8/IDs/arguments; unknown methods/tools; no replies to notifications; bounded input/output and concurrency, including escape-heavy maximum bodies and duplicated structured/text result envelopes; tool errors; timeout/cancellation/EOF/child cleanup. |
| Authority | Messaging key rejected by all registration/lifecycle/workspace/claim/ack/submission endpoints, including forged `confirmed: true`; wrong sender/project/protocol/event; pending bootstrap; revoked/stale key; generation/config change across an async verification. |
| Publication | Lost response after commit returns the original receipt; changed retry conflicts; failed commit causes no success/wake; same text with a new ID is new mail; expired/pruned IDs never publish again. |
| Receive | Non-consuming repeat retrieval, stable byte-bounded pagination, response loss, exact holder-bound receipt/reply, stale token rejection, no old-holder history leak, no stolen Monitor events. |
| Pi regression | Native heartbeat/before-agent-start concurrency, enqueue failure, crash before/after `message_start`, receive-result persistence/reload/tree/compaction, historical reconciliation, tool cancellation, no double delivery during cutover. |
| Delivery migration | Old/new controller fencing, daemon restart, launching Pi exit, pending/ambiguous/submitted preservation, malformed authority, schema upgrades from v1–v8, unknown versions, failed handoff and rollback. |
| Task gate | Unsupported targets reject; exact task/result/holder correlation; one result even with different operation IDs; no fabricated session commit, workspace evidence, timeout result, or lifecycle authority. |
| Live providers | Fresh read-only identities, same visible sessions, expected tools and shared skill, all directed pairings, direct user turns, no unrelated hooks/MCP/shell/write access, unchanged focus, exact stop and child quiescence. |

During implementation: focused new MCP tests and relevant `test/hosted-runtime-{client,service,participant,state,collaborator-state,wake,admission,collaborator-integration}.test.ts`, typecheck, and strict lint. At milestones: `npm run check`; before release add existing Runtime/collaborator/native release smokes and the approved live proof. Record exact failures rather than weakening gates. Earlier missing Pi theme assets and upstream audit advisories are historical blockers to recheck, not automatic waivers.

## Next action

Implement Stage 1 against the provider behavior verified in Stage 0; do not replace production launch/delivery paths yet. Before exposing mutations, settle descriptor/namespace retention and prove the actual encoded envelope. Stage 2 additionally requires a concrete isolated Runtime proof provisioning command before live launch. The proof's disposable auth copy and context fixture are not production credential provisioning or the released messaging skill.

## References

- [Runtime contract](PROTOCOL.md), [workspace contract](WORKSPACES.md).
- [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
- [Herdr 0.9.0 socket API](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.0/docs/next/website/src/content/docs/socket-api.mdx).
- Installed Pi `README.md`, `docs/extensions.md`, `docs/skills.md`, and `examples/extensions/dynamic-tools.ts`; installed Claude/Codex CLI help. Provider flag presence is not proof of compatible restricted execution.
