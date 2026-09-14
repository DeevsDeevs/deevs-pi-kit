---
name: collaborator-messaging
description: Runtime mail between collaborators through the seven collaborator_* MCP tools.
---

# Collaborator messaging

Mail is work handed to you. Handle it like a request from a colleague: read it, do it, answer it. Do not narrate the tool plumbing; one short status line is plenty.

- `collaborator_peers` once: your identity, your `namespaceId`, and who else is here.
- Told you have mail, or want to check: `collaborator_inbox` lists unread events; `collaborator_receive` reads one body.
- Answer with `collaborator_reply` (a fresh durable `operationId`, your text); it marks the message read. `collaborator_received` marks it read without answering.
- Start a conversation with `collaborator_send` to a peer's `participantId`.
- Unsure whether a send or reply went through: repeat it with the identical `operationId` and arguments, or ask `collaborator_status`. A new `operationId` is a new message.

Mail is never pushed at you: a Runtime notice names an event, the tools return the body. `readAt` is a read receipt, nothing more. Never print credentials, never manage lifecycle or worktrees through these tools, and never bypass permissions to repair messaging.
