# Universal collaborator messaging

## Scope

**Unreleased, current-schema-only implementation.** The user explicitly rejected old-state migrations, dual messaging registrars and legacy delivery fallback. Unsupported Runtime state must fail without being rewritten or deleted. Existing workspaces and other user data are not disposable.

One actual MCP interface and one [shared skill](../../skills/collaborator-messaging/SKILL.md) serve Pi, Claude Code and Codex. Runtime owns authority, mail and evidence; Herdr owns interactive processes. Pi uses a real stdio MCP child, not direct in-process messaging handlers. Development and installed Pi are 0.85.1. Implementation, tests, commits and pushes are authorized; installation/rollout and unrelated collaborator actions remain separate.

## Current implementation

- `service/messaging.ts`: restricted descriptor authority, exact holder/client/terminal/configuration checks, before/after-await fencing.
- `service/state.ts`: current state version **10 only**, atomic publication/operation receipts, immutable recipient binding, retrieval offers and client receipts. No v1–v9 migration.
- `mcp/main.mjs` and `mcp/tools.ts`: one stdio endpoint and schema catalog. No lifecycle passthrough, sampling, resources or task tools.
- `mcp/client.ts` and `mcp/pi.ts`: actual initialize/list/call transport, Pi error semantics, exact session/file/cwd preflight, bounded shutdown. The nested Pi entry remains explicitly loaded while default integration is completed.

Direct messaging registrations/full-body delivery still present in the codebase are **unfinished replacement work**, not compatibility commitments or approved release fallbacks. This service slice does not complete provider provisioning, reference wakes or Pi persisted-body admission.

## Shared tools

| Tool | Responsibility |
|---|---|
| `collaborator_peers` | Up to 12 peers per page, caller identity, namespace and expiry; Pi also gets exact session/file/cwd binding. |
| `collaborator_send` | Explicit recipient, namespace, durable operation ID and bounded body; atomic publication receipt. |
| `collaborator_receive` | **One exact event ID** from a mailbox reference. Persist/reuse an offer before returning the complete ordinary-mail body. No native claim or ACK. |
| `collaborator_received` | Exact namespace/event/token client receipt. Idempotent; does not delete mail or acknowledge native admission. |
| `collaborator_reply` | Exact offered event/token, operation ID and body. Runtime derives the original sender and atomically records receipt and correlated publication. |
| `collaborator_status` | Sender operation lookup, retained event/native delivery evidence, and separate offer/client-receipt timestamps. |

Receive deliberately has no inbox-scan/pagination framework: callers use exact event references. Peer pagination is independent. Ordinary replies must not reuse typed `task.result`. Lifecycle/workspace/task features require deliberate integration, not accidental deletion or duplicate MCP implementations.

## Authority and history

A trusted controller verifies/registers the actual target and held participant, then issues a private descriptor. MCP cannot acquire identity or obtain broad registration keys. Deterministic descriptor paths may be configured before issuance; metadata negotiation grants no authority. Never put credentials in prompts, tool arguments, Git or review packets.

A namespace permanently binds participant, holder generation, target, client, terminal and configuration. Fresh ordinary-mail publication snapshots the unique eligible recipient namespace. If absent or ambiguous, record **unbound**; never infer a recipient later. Retries preserve that snapshot. New holders/clients/namespaces do not inherit old or pre-issuance mail.

An offer is namespace-owned and binds exact event/token/first-offered time. Repeat receive reuses it. Explicit receipt adds first-received time without touching native claims. Fresh reply requires the exact offer/token and still-valid original MCP publication authority; it never redirects to a successor. Already-committed identical reply retries recover the original receipt before checking current recipient availability. Reply fingerprints include event, token and body; changed send/reply input conflicts.

## Bounds and persistence

- Body: 16 KiB UTF-8; receive returns one complete event without truncation.
- Canonical internal base64 preserves the 64 KiB Runtime request ceiling. Messaging responses allow 128 KiB; MCP frames allow 256 KiB including text/structured duplication. The ordinary native client's default remains 64 KiB.
- Grants, publication receipts and offers share the 10,000-record cap; state is capped at 8 MiB. Repeated offers reuse records; capacity failures cannot report successful new offers/publications.
- Retained offers protect their events from native ACK pruning. Namespace expiry clears offers/receipts and retains a terminal tombstone. Retention may expire namespaces already older than its cutoff; clock rollback cannot resurrect them.
- Post-rename write uncertainty fences reads and mutations until disk recovery and directory sync. Never restore an earlier snapshot over an uncertain commit.
- Pi transport bounds pending requests (12), queued bytes, stderr and request duration (10 seconds). Shutdown closes stdin, escalates the exact child at 100 ms/1 second and awaits close before replacement. Cancellation is not proof of non-publication; no automatic mutation replay.
- Descriptor renewal/repair remains fail-closed until exact old-process quiescence and unresolved operation identities are accounted for.

## Remaining implementation gates

1. **One default MCP path:** replace direct ordinary messaging registration and full-body delivery. No old argument translation or `legacy_push` mode. Provision native MCP configuration through verified launch/registration using restricted settings, without global configuration changes.
2. **Reference wakes:** partition ordinary MCP mail from native Monitor admission and separately supported tasks. No second `inbox.claim` consumer. Persist exact event/target/holder/client/controller attempts before Herdr submission. Ambiguous/submitted attempts are not automatically replayed; idle/focus/human-priority gates remain. The launching Pi is the first submitter; daemon handoff follows with service-enforced owner fencing.
3. **Pi persisted-body evidence:** reconcile exact successful native receive tool results after turns and across start/reload/tree/compaction. Check complete content/details, tool-call identity and branch membership. Pi 0.85.1 dispatches message hooks before append and updates memory before disk writes; neither hooks nor `getEntries()` certify a disk commit. Reload is not a disk reread. Read-only inspection of complete session JSONL records must not become an external writer, and readable bytes alone do not prove fsync-based crash durability. Do not label client receipt `admitted`; block release if the required proof is unavailable.
4. **Isolated live ring:** Pi → Claude → Codex → Pi, Pi-to-Pi and proactive human-driven mail. Fresh identities/private Runtime, one visible provider session each, actual MCP calls, exact correlation, negative permission/secret checks, no unrelated hooks or focus changes. Exact process quiescence precedes private auth cleanup.
5. **Daemon/release:** delivery survives initiating Pi exit; handoff/restart does not duplicate or falsely settle attempts. Validate every directed pairing, publish current setup documentation, and obtain explicit rollout approval.

## Validation

Use existing Vitest and `env -u PI_PACKAGE_DIR npm run check`; no extra test framework or detached commands. Focused cases cover exact binding, worst-case escaped bodies, repeat offers, response loss after offer/reply commit, atomic receipt/reply, changed retries, expired/replaced authority, capacity/retention, unsupported-state rejection and native claim separation. Actual Pi CLI/RPC tests inspect native persisted tool results; their deterministic model and Herdr identity fixtures are **not** a hosted-model live proof or durable-admission certificate. Review meaningful frozen slices independently.

Current service-slice validation: **515 tests across 49 files**, lint/typecheck, RPC/print/JSONL smokes, zero audit findings and package dry-run. Four selected process cases also passed against the installed Pi 0.85.1 binary, including native receive-result persistence. Actual filesystem Monitor events remain claimable natively and are rejected by MCP receive. Capacity, retention, pre-rename write failure and dropped committed response cases are covered. The escaped native-claim fixture explicitly uses a larger inspection client; production native response limits were not widened.

## Historical evidence

[Stage 0](MCP-STAGE0.md) records actual restricted Claude/Codex compatibility and negative permission probes. Stage 1 recorded actual MCP publications Claude → Pi (`evt_161fb342-2f8a-438a-963d-e0ba194317b2`) and Codex → Claude (`evt_75cec17b-4d4b-429a-8aa5-0ceed8bd7efd`), both pending—not receive/admission evidence. Owned proof processes were stopped before copied auth removal.

`c9eb96b` added the real Pi adapter; `806220d` updated SDKs to 0.85.1. The version-refresh baseline passed 505 tests/49 files plus three installed-Pi cases. Prior compatibility plans are superseded by the user's no-legacy decision, not retroactively relabeled as completed work.

References: [Runtime contract](PROTOCOL.md), [workspace safeguards](WORKSPACES.md), MCP [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
