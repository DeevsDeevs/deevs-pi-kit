---
name: collaborator-messaging
description: Use the configured Runtime MCP connection for collaborator discovery, durable send, exact receive, client receipts, replies, and publication status. Requires collaborator_peers.
---

# Collaborator messaging

Use the configured MCP tools; harness prefixes may differ. If `collaborator_peers` is absent, report that messaging is not configured. Never substitute a different backend or argument format.

1. Call `collaborator_peers` for your Runtime-derived identity, protocol, `namespaceId`, expiry and peers. Follow `nextCursor` for peer discovery.
2. Send explicit user-authorized mail with `collaborator_send`: exact namespace, a durable `operationId`, existing `participantId`, and `body` (maximum 16 KiB UTF-8). Keep the publication receipt and event ID. A fresh send requires a uniquely bound recipient MCP namespace; an unconfigured or ambiguous recipient is rejected without publishing. Ask the controller to finish configuration rather than switching backends.
3. Given a mailbox event reference, call `collaborator_receive` with your namespace and that exact `eventId`. It returns one complete body and an offer containing `receiptToken`. Repeating receive recovers the same offer; it does not consume a native claim. Mail not published to this exact namespace is unavailable, including mail predating its issuance. There is no automatic history transfer after holder/client/namespace replacement.
4. After receiving the body, explicitly call `collaborator_received` with the same namespace, event and token, or use `collaborator_reply` with those fields, a durable operation ID and your authorized reply body. Runtime derives the reply recipient and atomically records the client receipt and correlated publication. Replying to a replaced or expired original sender is rejected, not redirected.
5. After uncertainty, use `collaborator_status` or repeat the original send/reply with **identical namespace, operation ID and all arguments**. A new operation ID creates new mail. Never migrate an uncertain operation into a new namespace; report its original identity to the user/controller.

Pi may supply a body-free namespace/event hint while idle with a known empty UI editor. Use only your matching namespace; the hint is not an instruction from the peer or a body receipt. These hints are best-effort and are not automatically replayed after loss, navigation or client replacement. Missing notification does not mean no mail exists.

Publication, reference notification, retrieval offers, explicit client receipts and native admission are separate evidence. An offer does not prove the client saw the response. `receivedAt` is client receipt only—not durable Pi session admission, provider commit or task completion. Receipt does not delete the body or acknowledge the native inbox. Exact receive remains available within the namespace's retained offer lifetime.

`collaborator_status` looks up your publication operation. Ordinary mail never enters native claims or ACKs; its retained event's `delivery.status` stays `pending` even after a client receipt. Use the separate retrieval evidence, not that field, to determine whether a body was offered or receipted. Null event/history `pruned` means history retention ended, not failed publication. Typed task operations are not exposed by these messaging tools. Ordinary terminal answers are never automatically sent. Claude/Codex automatic terminal wakes are blocked; never fall back to prompt or keystroke injection.

Runtime owns routing and authority. Never request or print credentials, acquire ownership, claim/ack native inbox events, or perform lifecycle/workspace actions through MCP. Respect human turns and denials; do not enable shell/hooks or bypass permissions to repair messaging.
