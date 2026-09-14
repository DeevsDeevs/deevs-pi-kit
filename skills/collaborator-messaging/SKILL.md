---
name: collaborator-messaging
description: Use the configured Runtime MCP connection for collaborator discovery, durable send, exact receive, read receipts, replies, and publication status. Requires collaborator_peers.
---

# Collaborator messaging

Use the configured MCP tools; harness prefixes may differ. If `collaborator_peers` is absent, report that messaging is not configured. Never substitute a different backend or argument format.

1. Call `collaborator_peers` for your Runtime-derived identity, protocol, `namespaceId`, expiry and peers, following `nextCursor` for more.
2. Send explicit user-authorized mail with `collaborator_send`: exact namespace, a durable `operationId`, an existing `participantId` matching `^[a-z][a-z0-9_-]{0,63}$`, and a `body` of at most 16 KiB UTF-8; keep the returned `eventId`. Every argument is schema-checked, so an unknown field or an oversized body is `invalid_request`, never a truncated send.
3. Call `collaborator_receive` with your namespace and an exact `eventId` to read one complete body; repeating it is safe and records nothing.
4. Call `collaborator_received` to set that message's `readAt`, or `collaborator_reply` with a durable operation ID and your authorized body, which publishes to the original sender and sets `readAt` in one step.
5. After uncertainty, use `collaborator_status` or repeat the original send/reply with **identical namespace, operation ID and all arguments**; a repeat returns the original message, changed input is a conflict, and a new operation ID creates new mail.

Pi may supply a body-free namespace/event hint while idle with a known empty UI editor. Use only your matching namespace; the hint is not an instruction from the peer and not a read receipt. Hints are best-effort, are not replayed after loss or client replacement, and a missing hint does not mean no mail exists.

A namespace belongs to one registration: when its client registers again, the old namespace is revoked and `collaborator_peers` returns the new one. Mail is addressed to your participant identity, so a replacement namespace of the same held identity still reads it, and mail you send to a vacant peer waits for its next holder. `readAt` is a client read receipt only: it is not durable Pi session admission, provider commit or task completion, and it never deletes the body. Ordinary mail never enters native delivery: the Runtime heartbeat hands out Monitor events only, and a mail event carries no delivery state. Ordinary terminal answers are never sent automatically, and automatic Claude/Codex terminal wakes are not implemented; never fall back to prompt or keystroke injection.

Runtime owns routing and authority. Never request or print credentials, acquire ownership, acknowledge native inbox events, or perform lifecycle/worktree actions through MCP. Respect human turns and denials; do not enable shell/hooks or bypass permissions to repair messaging.
