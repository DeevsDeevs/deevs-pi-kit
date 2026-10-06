import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClient, HostedRuntimeClientError } from "./client.ts";
import { decodeMail, encodeMail } from "./mail-body.ts";
import { isJsonObject, type JsonValue } from "./schemas/json.ts";
import { isHeld } from "./schemas/state.ts";
import { auth, strictObject, text, type ClientParticipantStatus, type LiveClientRegistration, type MailHint } from "./responses.ts";
import type { RuntimeSession } from "./runtime-session.ts";
import type { ManagedAgentControl, ParticipantIdentity } from "./session-record.ts";
import { messagingDescriptorPath } from "./service/messaging.ts";

export const COLLABORATOR_MESSAGE = "collaborator-message";
const HOSTED_RUNTIME_NOTICE = "deevs.hosted-runtime.notice.v1";
const IMAGE_TYPES = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"]]);

/** A send's fields; an inbox read takes none. */
interface MailParams {
	participantId?: string;
	operationId?: string;
	bodyBase64?: string;
}

/** An idle session with nothing queued and, in the TUI, nothing half-typed: the only moment Runtime speaks up. */
function deliveryReady(ctx: ExtensionContext): boolean {
	if (!ctx.hasUI || !ctx.isIdle() || ctx.hasPendingMessages()) return false;
	return ctx.mode !== "tui" || ctx.ui.getEditorText() === "";
}

/** Issues private MCP messaging descriptors and delivers mail into an idle session; it never acquires identity. */
export class MessagingClient {
	private readonly session: RuntimeSession;
	private readonly hintedMail = new Set<string>();
	private readonly managedIssued = new Set<string>();

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
		const participantKey = identity.participantKey;
		const expectedGeneration = identity.generation;
		if (!this.holdsIdentity(registration, identity) || !participantKey || !expectedGeneration) {
			throw new HostedRuntimeClientError("conflict", "Current collaborator identity is not authoritatively held.");
		}
		const params = { ...auth(registration), participantKey, expectedGeneration, confirmed: true };
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
		const params = {
			...auth(registration),
			participantKey: participant.participantKey,
			expectedGeneration: participant.generation,
			confirmed: true,
		};
		const issued = strictObject(await this.session.scopedCall(current, "messaging.issue", params), "Native messaging descriptor");
		if (issued.descriptorPath !== messagingDescriptorPath(this.session.root, control.targetKey)) {
			throw new HostedRuntimeClientError("identity_mismatch", "Native messaging descriptor differs from its configured client.");
		}
		this.managedIssued.add(control.targetKey);
	}

	/** Mails `to` (a participant name; main is the lead) from this session's own namespace; returns the delivery line. */
	async send(ctx: ExtensionContext, to: string, message: string, images: readonly string[]): Promise<string> {
		const body = Buffer.from(encodeMail(message, images)).toString("base64");
		await this.mail(ctx, "send", { participantId: to, operationId: randomUUID(), bodyBase64: body });
		return `Message sent to ${to}; it arrives at its next idle, merged with anything else sent meanwhile.`;
	}

	/**
	 * Delivery into an idle session: every unread message (marked read by this read) goes to the model as one
	 * `collaborator-message` that starts a turn, images as ImageContent. Never replayed after loss.
	 */
	async deliverMail(registration: LiveClientRegistration, ctx: ExtensionContext, mail: MailHint | undefined): Promise<void> {
		if (!mail || this.hintedMail.has(mail.eventId)) return;
		if (!this.hintReady(registration, ctx)) return;
		// One delivery per hinted message per session; the set stays as small as this session's mail.
		this.hintedMail.add(mail.eventId);
		const inbox = await this.mail(ctx, "inbox", {});
		const messages = isJsonObject(inbox) && Array.isArray(inbox.messages) ? inbox.messages.filter(isJsonObject) : [];
		if (messages.length === 0) return;
		const content: (TextContent | ImageContent)[] = [];
		for (const message of messages) {
			const { text: body, images } = decodeMail(String(message.body));
			content.push({ type: "text", text: `Message from ${String(message.from)}:\n${body}` }, ...images.flatMap(imageContent));
		}
		const from = [...new Set(messages.map((message) => String(message.from)))];
		this.session.pi.sendMessage({ customType: COLLABORATOR_MESSAGE, content, display: true, details: { from } }, { triggerTurn: true, deliverAs: "followUp" });
	}

	/** One daemon call in this session's own mail namespace, with the credentials of its private descriptor. */
	private async mail(ctx: ExtensionContext, method: "send" | "inbox", params: MailParams): Promise<JsonValue | undefined> {
		const descriptor: JsonValue = JSON.parse(readFileSync(await this.descriptor(ctx), "utf8"));
		if (!isJsonObject(descriptor)) throw new HostedRuntimeClientError("invalid_response", "Messaging descriptor is malformed.");
		const client = new HostedRuntimeClient(text(descriptor.socketPath), 5_000, 128 * 1024);
		return client.call(`messaging.${method}`, { ...params, namespaceId: text(descriptor.namespaceId), secret: text(descriptor.secret) });
	}

	/** A one-line Runtime notice for the model, delivered only when the session is idle; true once it went out. */
	deliverNotice(ctx: ExtensionContext, content: string): boolean {
		if (!this.session.isActive || !deliveryReady(ctx)) return false;
		this.session.pi.sendMessage({ customType: HOSTED_RUNTIME_NOTICE, content, display: false }, { triggerTurn: true, deliverAs: "followUp" });
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

function managedParticipantConfigured(control: ManagedAgentControl, participant: ClientParticipantStatus): boolean {
	return control.messagingConfigured === true
		&& control.state === "active"
		&& isHeld(participant.state)
		&& participant.holderLive
		&& participant.generation === control.holderGeneration
		&& participant.driver === control.driver;
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
