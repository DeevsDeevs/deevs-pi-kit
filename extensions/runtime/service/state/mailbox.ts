import {
	HOSTED_MAILBOX_MAX_BODY_BYTES,
	type HostedMailboxMessageEvent,
	type HostedParticipant,
	type HostedRuntimeState,
	type HostedStateOperation,
} from "../../hosted-types.ts";
import { HostedStateConflictError } from "./errors.ts";
import { assertStateId, assertStateTime } from "./guards.ts";
import { mailboxDedupeKey } from "./keys.ts";
import { MAX_ID_BYTES } from "./parse.ts";

type MailboxSendOperation = Extract<HostedStateOperation, { type: "mailbox.send" }>;

export function sendMailboxMessage(state: HostedRuntimeState, operation: MailboxSendOperation): HostedRuntimeState {
	assertStateId(operation.eventId, "Mailbox event ID");
	assertStateTime(operation.at, "Mailbox send time");
	const sender = state.participants[operation.senderParticipantKey];
	const recipient = state.participants[operation.recipientParticipantKey];
	if (!sender || !senderHoldsIdentity(sender, operation)) {
		throw new HostedStateConflictError("conflict", "Mailbox sender identity or generation changed before send.");
	}
	if (!recipient || recipient.state === "ended") throw new HostedStateConflictError("conflict", "Mailbox recipient is unavailable.");
	if (!participantsSharePeerScope(sender, recipient)) {
		throw new HostedStateConflictError("conflict", "Mailbox participants must be distinct and share one project and protocol.");
	}
	if (operation.at < sender.updatedAt) throw new HostedStateConflictError("conflict", "Mailbox send time precedes sender state.");
	assertMailboxPayload(operation);
	const dedupeKey = mailboxDedupeKey(sender.participantKey, operation.sendId);
	const existingId = state.dedupe[dedupeKey];
	if (existingId !== undefined) {
		if (repeatsExistingSend(state, existingId, sender, operation)) return state;
		throw new HostedStateConflictError("conflict", "Mailbox send ID was already used with different input.");
	}
	if (state.events[operation.eventId]) throw new HostedStateConflictError("conflict", "Mailbox event ID already exists.");
	const sequence = (sender.outSeq[recipient.participantKey] ?? 0) + 1;
	const event = mailboxEvent(sender, recipient, operation, dedupeKey, sequence);
	const nextSender: HostedParticipant = {
		...sender,
		outSeq: { ...sender.outSeq, [recipient.participantKey]: sequence },
		updatedAt: operation.at,
	};
	return {
		...state,
		participants: { ...state.participants, [sender.participantKey]: nextSender },
		events: { ...state.events, [event.eventId]: event },
		dedupe: { ...state.dedupe, [dedupeKey]: event.eventId },
	};
}

function senderHoldsIdentity(sender: HostedParticipant, operation: MailboxSendOperation): boolean {
	return sender.state === "held"
		&& sender.generation === operation.expectedSenderGeneration
		&& sender.holderTargetKey === operation.senderTargetKey;
}

function participantsSharePeerScope(sender: HostedParticipant, recipient: HostedParticipant): boolean {
	return sender.participantKey !== recipient.participantKey
		&& sender.projectRoot === recipient.projectRoot
		&& sender.protocol === recipient.protocol;
}

function assertMailboxPayload(operation: MailboxSendOperation): void {
	if (!operation.body.trim() || Buffer.byteLength(operation.body) > HOSTED_MAILBOX_MAX_BODY_BYTES) {
		throw new HostedStateConflictError("conflict", "Mailbox body is empty or exceeds its byte limit.");
	}
	if (!operation.sendId.trim() || Buffer.byteLength(operation.sendId) > MAX_ID_BYTES) {
		throw new HostedStateConflictError("conflict", "Mailbox send ID is invalid.");
	}
}

function repeatsExistingSend(
	state: HostedRuntimeState,
	existingId: string,
	sender: HostedParticipant,
	operation: MailboxSendOperation,
): boolean {
	const existing = state.events[existingId];
	return existing?.type === "mailbox.message"
		&& existing.source.id === sender.participantKey
		&& existing.recipientParticipantKey === operation.recipientParticipantKey
		&& existing.sendId === operation.sendId
		&& existing.body === operation.body;
}

function mailboxEvent(
	sender: HostedParticipant,
	recipient: HostedParticipant,
	operation: MailboxSendOperation,
	dedupeKey: string,
	sequence: number,
): HostedMailboxMessageEvent {
	return {
		version: 1,
		eventId: operation.eventId,
		dedupeKey,
		type: "mailbox.message",
		source: { kind: "participant", id: sender.participantKey, generation: sender.generation, sequence },
		recipientParticipantKey: recipient.participantKey,
		sendId: operation.sendId,
		body: operation.body,
		createdAt: operation.at,
		summary: `message from ${sender.participantId} to ${recipient.participantId}`,
		delivery: { status: "pending" },
	};
}
