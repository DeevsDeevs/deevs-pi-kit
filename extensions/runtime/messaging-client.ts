import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClient, HostedRuntimeClientError } from "./client.ts";
import { LEAD } from "./collaborators.ts";
import { escapeMarkup } from "../shared/tasks.ts";
import { decodeMail, encodeMail } from "./mail-body.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "./schemas/json.ts";
import { isHeld } from "./schemas/state.ts";
import { confirmed, strictObject, text, type ClientParticipantStatus, type LiveClientRegistration, type MailHint } from "./responses.ts";
import type { RuntimeSession } from "./runtime-session.ts";
import type { ManagedAgentControl, ParticipantIdentity } from "./schemas/session.ts";
import { messagingDescriptorPath } from "./service/messaging.ts";

export const COLLABORATOR_MESSAGE = "collaborator-message";
const COLLABORATOR_NOTICE = "collaborator-notice";
const IMAGE_TYPES = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"]]);

/** A send's fields, an inbox peek, or the mail a read acknowledges. */
interface MailParams {
	participantId?: string;
	operationId?: string;
	bodyBase64?: string;
	peek?: true;
	eventIds?: string[];
}

/** An idle session with nothing queued and, in the TUI, nothing half-typed: the only moment Runtime speaks up. */
function deliveryReady(ctx: ExtensionContext): boolean {
	if (!ctx.hasUI || !ctx.isIdle() || ctx.hasPendingMessages()) return false;
	return ctx.mode !== "tui" || ctx.ui.getEditorText() === "";
}

/** Issues private MCP messaging descriptors and delivers mail into an idle session; it never acquires identity. */
export class MessagingClient {
	private readonly session: RuntimeSession;
	/** Mail handed to Pi whose entry the session may not hold yet; it is not sent twice by this process. */
	private readonly sent = new Set<string>();
	private readonly managedIssued = new Set<string>();
	/** Mail from main handed to Pi, for the run it starts; that run answers main in text unless it mails main itself. */
	private mainMailQueued = false;
	private run?: { deliveredFromMain: boolean; sentToMain: boolean };

	constructor(session: RuntimeSession) {
		this.session = session;
	}

	clearManagedIssuance(): void {
		this.managedIssued.clear();
	}

	isManagedIssued(targetKey: string): boolean {
		return this.managedIssued.has(targetKey);
	}

	async descriptor(ctx: ExtensionContext): Promise<string> {
		return this.provision(await this.session.requireRegistration(ctx), ctx);
	}

	/** Issues this Pi session's own descriptor for an identity it authoritatively holds. */
	async provision(registration: LiveClientRegistration, ctx: ExtensionContext): Promise<string> {
		const current = this.session.scope(ctx, registration);
		this.session.requireCurrentScope(current);
		const identity = this.session.requireParticipantIdentity();
		const { participantKey, generation } = identity;
		if (!this.holdsIdentity(registration, identity) || !participantKey || !generation) {
			throw new HostedRuntimeClientError("conflict", "Current collaborator identity is not authoritatively held.");
		}
		const params = confirmed(registration, { participantKey, generation });
		const issued = strictObject(await this.session.scopedCall(current, "messaging.issue", params), "Messaging issuance");
		if (!this.identityUnchanged(registration, identity)) {
			throw new HostedRuntimeClientError("registration_stale", "Collaborator changed during messaging provisioning.");
		}
		return text(issued.descriptorPath);
	}

	/** Issues the descriptor of one verified managed native collaborator, never of the launching Pi session. */
	async provisionManaged(ctx: ExtensionContext, registration: LiveClientRegistration, control: ManagedAgentControl): Promise<void> {
		const identity = this.session.store.identity;
		const scope = this.session.scope(ctx, registration);
		const current = () => scope() && this.session.store.identity === identity && this.session.store.agent(control.targetKey) === control;
		this.session.requireCurrentScope(current);
		const participant = (await this.session.listParticipants(registration)).find(item => item.holderTargetKey === control.targetKey);
		this.session.requireCurrentScope(current);
		if (!participant || !managedParticipantConfigured(control, participant)) {
			throw new HostedRuntimeClientError("identity_mismatch", "Native messaging requires its exact live configured participant.");
		}
		const issued = strictObject(await this.session.scopedCall(current, "messaging.issue", confirmed(registration, participant)), "Native messaging descriptor");
		if (issued.descriptorPath !== messagingDescriptorPath(this.session.root, control.targetKey)) {
			throw new HostedRuntimeClientError("identity_mismatch", "Native messaging descriptor differs from its configured client.");
		}
		this.managedIssued.add(control.targetKey);
	}

	/** Mails `to` (a participant name; main is the lead) from this session's own namespace; returns the delivery line. */
	async send(ctx: ExtensionContext, to: string, message: string, images: readonly string[]): Promise<string> {
		// Read before the reply is sent: a read after it would leave Runtime counting a reply as still owed.
		await this.acknowledge(ctx);
		const body = Buffer.from(encodeMail(message, images)).toString("base64");
		await this.mail(ctx, "send", { participantId: to, operationId: randomUUID(), bodyBase64: body });
		if (to === LEAD && this.run) this.run.sentToMain = true;
		return `Message sent to ${to}; it arrives at its next idle, merged with anything else sent meanwhile.`;
	}

	/**
	 * Delivery into an idle session: every unread message goes to the model as one `collaborator-message` that starts a
	 * turn, images as ImageContent. Mail is marked read only once the session file holds it, so a crash or /reload in
	 * between delivers it again instead of losing it.
	 */
	async deliverMail(registration: LiveClientRegistration, ctx: ExtensionContext, mail: MailHint | undefined): Promise<void> {
		if (!mail || !this.hintReady(registration, ctx)) return;
		const fresh = (await this.acknowledge(ctx)).filter((message) => !this.sent.has(String(message.eventId)));
		if (fresh.length === 0 || !this.hintReady(registration, ctx)) return;
		const ids = fresh.map((message) => String(message.eventId));
		for (const id of ids) this.sent.add(id);
		const from = [...new Set(fresh.map((message) => String(message.from)))];
		this.mainMailQueued ||= from.includes(LEAD);
		this.session.pi.sendMessage({ customType: COLLABORATOR_MESSAGE, content: mailContent(fresh), display: true, details: { from, eventIds: ids } }, { triggerTurn: true, deliverAs: "followUp" });
	}

	runStarted(): void {
		this.run ??= { deliveredFromMain: this.mainMailQueued, sentToMain: false };
		this.mainMailQueued = false;
	}

	/** A run that took main's mail and ended on a plain-text answer without mailing main sends main that answer. */
	async runSettled(ctx: ExtensionContext): Promise<void> {
		const run = this.run;
		this.run = undefined;
		if (!run?.deliveredFromMain || run.sentToMain) return;
		const last = ctx.sessionManager.getBranch().at(-1);
		if (last?.type !== "message" || last.message.role !== "assistant" || last.message.stopReason !== "stop") return;
		const answer = last.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
		if (answer) await this.send(ctx, LEAD, answer, []);
	}

	/** Marks read the unread mail this session's file holds; returns the unread mail it does not hold. */
	private async acknowledge(ctx: ExtensionContext): Promise<JsonObject[]> {
		const held = deliveredMail(ctx);
		const inbox = await this.mail(ctx, "inbox", { peek: true });
		const messages = isJsonObject(inbox) && Array.isArray(inbox.messages) ? inbox.messages.filter(isJsonObject) : [];
		const delivered = messages.map((message) => String(message.eventId)).filter((id) => held.has(id));
		if (delivered.length > 0) await this.mail(ctx, "read", { eventIds: delivered });
		return messages.filter((message) => !held.has(String(message.eventId)));
	}

	/** One daemon call in this session's own mail namespace, with the credentials of its private descriptor. */
	private async mail(ctx: ExtensionContext, method: "send" | "inbox" | "read", params: MailParams): Promise<JsonValue | undefined> {
		const descriptor: JsonValue = JSON.parse(readFileSync(await this.descriptor(ctx), "utf8"));
		if (!isJsonObject(descriptor)) throw new HostedRuntimeClientError("invalid_response", "Messaging descriptor is malformed.");
		const client = new HostedRuntimeClient(text(descriptor.socketPath), 5_000, 128 * 1024);
		return client.call(`messaging.${method}`, { ...params, namespaceId: text(descriptor.namespaceId), secret: text(descriptor.secret) });
	}

	/** A one-line Runtime notice for the model, delivered only when the session is idle; true once it went out. */
	deliverNotice(ctx: ExtensionContext, content: string): boolean {
		if (!this.session.isActive || !deliveryReady(ctx)) return false;
		this.session.pi.sendMessage({ customType: COLLABORATOR_NOTICE, content, display: false }, { triggerTurn: true, deliverAs: "followUp" });
		return true;
	}

	private hintReady(registration: LiveClientRegistration, ctx: ExtensionContext): boolean {
		if (!this.session.scope(ctx, registration)()) return false;
		if (!isHeld(this.session.store.identity?.disposition)) return false;
		return deliveryReady(ctx);
	}

	private holdsIdentity(registration: LiveClientRegistration, identity: ParticipantIdentity): boolean {
		if (!this.session.isActive || !isHeld(identity.disposition)) return false;
		return this.session.liveRegistration?.targetKey === registration.targetKey;
	}

	private identityUnchanged(registration: LiveClientRegistration, identity: ParticipantIdentity): boolean {
		const live = this.session.liveRegistration;
		if (!this.session.isActive || live?.targetKey !== registration.targetKey) return false;
		const current = this.session.store.identity;
		if (!current || current.participantKey !== identity.participantKey || current.generation !== identity.generation) return false;
		return isHeld(current.disposition);
	}
}

/** The mail this session already holds: its own file is the acknowledgement, as for task notifications. */
function deliveredMail(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom_message" || entry.customType !== COLLABORATOR_MESSAGE) continue;
		// SAFETY: Session entries are untrusted; a non-string id only sits in the set and never equals a real one.
		const eventIds = (entry.details as { eventIds?: unknown } | undefined)?.eventIds;
		if (Array.isArray(eventIds)) for (const id of eventIds) ids.add(String(id));
	}
	return ids;
}

function managedParticipantConfigured(control: ManagedAgentControl, participant: ClientParticipantStatus): boolean {
	return control.messagingConfigured === true
		&& control.state === "active"
		&& isHeld(participant.state)
		&& participant.holderLive
		&& participant.generation === control.holderGeneration
		&& participant.driver === control.driver;
}

/** A peer's body is untrusted text: its envelope markup is neutralized (A.5) before it reaches the model. */
export function mailContent(messages: JsonObject[]): (TextContent | ImageContent)[] {
	return messages.flatMap((message) => {
		const { text: body, images } = decodeMail(String(message.body));
		return [{ type: "text" as const, text: `Message from ${String(message.from)}:\n${escapeMarkup(body)}` }, ...images.flatMap(imageContent)];
	});
}

function imageContent(path: string): ImageContent[] {
	const mimeType = IMAGE_TYPES.get(extname(path).toLowerCase());
	if (!mimeType) return [];
	try {
		return [{ type: "image", data: readFileSync(path).toString("base64"), mimeType }];
	} catch {
		return [];
	}
}
