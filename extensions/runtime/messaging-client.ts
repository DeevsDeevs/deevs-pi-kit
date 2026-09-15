import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClientError } from "./client.ts";
import type { InboxReader } from "./mcp/pi.ts";
import { isJsonObject, type JsonValue } from "./schemas/json.ts";
import { isHeld } from "./schemas/state.ts";
import { auth, strictObject, text, type ClientParticipantStatus, type LiveClientRegistration, type MailHint } from "./responses.ts";
import type { RuntimeSession } from "./runtime-session.ts";
import type { ManagedAgentControl, ParticipantIdentity } from "./session-record.ts";
import { messagingDescriptorPath } from "./service/messaging.ts";

const HOSTED_MESSAGING_MAIL = "deevs.hosted-runtime.messaging-mail.v1";
const HOSTED_RUNTIME_NOTICE = "deevs.hosted-runtime.notice.v1";

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
	private readInbox: InboxReader | undefined;

	constructor(session: RuntimeSession) {
		this.session = session;
	}

	deliverWith(reader: InboxReader): void {
		this.readInbox = reader;
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

	/**
	 * Best-effort delivery into an idle session: the extension reads the inbox itself (which marks it read) and hands
	 * the bodies to the model as one follow-up, so its first action can be the reply. Never replayed after loss.
	 */
	async deliverMail(registration: LiveClientRegistration, ctx: ExtensionContext, mail: MailHint | undefined): Promise<void> {
		if (!mail || this.hintedMail.has(mail.eventId)) return;
		if (!this.hintReady(registration, ctx)) return;
		// One delivery per hinted message per session; the set stays as small as this session's mail.
		this.hintedMail.add(mail.eventId);
		const content = await this.mailContent(ctx);
		this.session.pi.sendMessage(
			{ customType: HOSTED_MESSAGING_MAIL, content, display: false, details: mail },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	/** A one-line Runtime notice for the model, delivered only when the session is idle; true once it went out. */
	deliverNotice(ctx: ExtensionContext, content: string): boolean {
		if (!this.session.isActive || !deliveryReady(ctx)) return false;
		this.session.pi.sendMessage({ customType: HOSTED_RUNTIME_NOTICE, content, display: false }, { triggerTurn: true, deliverAs: "followUp" });
		return true;
	}

	/** Falls back to a one-line hint when the inbox cannot be read, so the model still knows to look. */
	private async mailContent(ctx: ExtensionContext): Promise<string> {
		const hint = "You have collaborator mail: call collaborator_inbox, act on it, and answer with collaborator_reply if it asks for one."
			+ " Report only the outcome, never the tool steps.";
		let inbox: JsonValue | undefined;
		try { inbox = await this.readInbox?.(ctx); } catch { return hint; }
		const messages = isJsonObject(inbox) && Array.isArray(inbox.messages) ? inbox.messages.filter(isJsonObject) : [];
		if (messages.length === 0) return hint;
		const delivered = messages.map((message) => `Mail from ${String(message.from)} (eventId ${String(message.eventId)}):\n${String(message.body)}`);
		return `${delivered.join("\n\n")}\n\nAct on it and answer with collaborator_reply if it asks for one. Report only the outcome, never the tool steps.`;
	}

	private hintReady(registration: LiveClientRegistration, ctx: ExtensionContext): boolean {
		if (!this.session.scope(ctx, registration)()) return false;
		if (!isHeld(this.session.store.identity?.disposition)) return false;
		if (!this.session.pi.getActiveTools().includes("collaborator_inbox")) return false;
		return deliveryReady(ctx);
	}

	private holdsIdentity(registration: LiveClientRegistration, identity: ParticipantIdentity): boolean {
		if (!this.session.isActive || !isHeld(identity.disposition)) return false;
		return this.session.liveRegistration?.registrationId === registration.registrationId;
	}

	private identityUnchanged(registration: LiveClientRegistration, identity: ParticipantIdentity): boolean {
		const live = this.session.liveRegistration;
		if (!this.session.isActive || live?.registrationId !== registration.registrationId) return false;
		if (live.registrationKey !== registration.registrationKey) return false;
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
