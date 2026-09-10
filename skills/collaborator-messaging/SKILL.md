---
name: collaborator-messaging
description: Use an explicitly configured Runtime MCP connection for collaborator discovery, durable send, and publication status. Requires collaborator_peers; not the legacy Pi messaging tool.
---

# Collaborator messaging

Use this skill only when `collaborator_peers` is available through the configured MCP connection. Harness prefixes may differ. If absent, report that MCP messaging is not configured; do not reinterpret the legacy `collaborator_send` arguments.

1. Call `collaborator_peers` to learn your Runtime-derived identity, protocol, publication `namespaceId`, expiry, and existing peers. Follow `nextCursor` when needed.
2. Send only explicit user-authorized mail using `collaborator_send` with that exact `namespaceId`, an independently chosen durable `operationId`, the existing `participantId`, and `body` (at most 16 KiB UTF-8).
3. Save the publication receipt. On timeout, disconnect, or another ambiguous outcome, use `collaborator_status` or retry with the **same namespaceId, operationId, recipient, and body**. Changed input conflicts; a new operation ID intentionally creates new mail.
4. Never move an uncertain operation to a new namespace, even after expiry, reconnection, or configuration replacement. Report the unresolved original identity to the user/controller. A namespace or authorization error does not authorize a fresh send.

A publication receipt proves durable Runtime publication only. The returned event's `delivery` is separate evidence: pending/claimed is not admission; submitting/submitted/needs_attention is not provider commit. `acked` records the native admission path, not task completion. A null event with `history: pruned` means body/history retention ended, not that publication failed.

This foundation exposes only peers/send/status. Receive, client receipt, reply correlation, and typed tasks are not available here yet. Ordinary terminal answers are not automatically sent. Do not fabricate unsupported tool calls or forward a human conversation without authorization.

Runtime derives sender identity and routing scope. Never request or print credentials, change agent ownership/configuration, claim/ack native inbox events, or perform lifecycle/workspace actions through MCP. Respect human turns and permission denials; never enable shell/hooks or bypass restrictions to repair messaging.
