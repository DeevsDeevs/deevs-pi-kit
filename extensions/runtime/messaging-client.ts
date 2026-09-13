import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClientError } from "./client.ts";
import { auth, strictObject, text, type ClientParticipantStatus, type LiveClientRegistration, type MailHint } from "./responses.ts";
import type { RuntimeSession } from "./runtime-session.ts";
import type { ManagedAgentControl, ParticipantIdentity } from "./session-record.ts";
import { messagingDescriptorPath } from "./service/messaging.ts";

const HOSTED_MESSAGING_MAIL = "deevs.hosted-runtime.messaging-mail.v1";

/** Issues private MCP messaging descriptors and offers idle mail hints; it never acquires identity. */
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
		const current = this.session.scope(ctx);
		const registration = await this.session.requireRegistration(ctx);
		return this.provision(registration, current);
	}

	/** Issues this Pi session's own descriptor for an identity it authoritatively holds. */
	async provision(registration: LiveClientRegistration, current: () => boolean): Promise<string> {
		this.session.requireCurrentScope(current);
		const identity = this.session.requireParticipantIdentity();
		const participantKey = identity.participantKey;
		const expectedGeneration = identity.generation;
		if (!this.holdsIdentity(registration, identity) || !participantKey || !expectedGeneration) {
			throw new HostedRuntimeClientError("conflict", "Current collaborator identity is not authoritatively held.");
		}
		const params = { ...auth(registration), participantKey, expectedGeneration, confirmed: true };
		const issued = strictObject(await this.session.client.call("messaging.issue", params), "Messaging issuance");
		this.session.requireCurrentScope(current);
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
		const params = { ...auth(registration), participantKey: participant.participantKey, expectedGeneration: participant.generation, confirmed: true };
		const issued = strictObject(await this.session.client.call("messaging.issue", params), "Native messaging descriptor");
		this.session.requireCurrentScope(current);
		if (issued.descriptorPath !== messagingDescriptorPath(this.session.root, control.targetKey, control.clientGeneration)) {
			throw new HostedRuntimeClientError("identity_mismatch", "Native messaging descriptor differs from its configured client.");
		}
		this.managedIssued.add(control.targetKey);
	}

	/** Best-effort idle hint. Not submission, body retrieval, read receipt or native admission; never replayed. */
	offerMailHint(registration: LiveClientRegistration, ctx: ExtensionContext, mail: MailHint | undefined): void {
		if (!mail || this.hintedMail.has(mail.eventId)) return;
		if (!this.hintReady(registration, ctx)) return;
		// One hint per message per session; the set stays as small as this session's mail.
		this.hintedMail.add(mail.eventId);
		const content = `Runtime mail waiting: ${JSON.stringify(mail)}\nUse collaborator_receive with this namespaceId and eventId to read its body through the shared MCP interface.`;
		this.session.pi.sendMessage(
			{ customType: HOSTED_MESSAGING_MAIL, content, display: false, details: mail },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	private hintReady(registration: LiveClientRegistration, ctx: ExtensionContext): boolean {
		if (!this.session.scope(ctx, registration)()) return false;
		if (this.session.store.identity?.disposition !== "held") return false;
		if (!this.session.pi.getActiveTools().includes("collaborator_receive")) return false;
		if (ctx.mode !== "tui" || !ctx.hasUI) return false;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return false;
		return ctx.ui.getEditorText() === "";
	}

	private holdsIdentity(registration: LiveClientRegistration, identity: ParticipantIdentity): boolean {
		if (!this.session.isActive || identity.disposition !== "held") return false;
		return this.session.liveRegistration?.registrationId === registration.registrationId;
	}

	private identityUnchanged(registration: LiveClientRegistration, identity: ParticipantIdentity): boolean {
		const live = this.session.liveRegistration;
		if (!this.session.isActive || live?.registrationId !== registration.registrationId) return false;
		if (live.registrationKey !== registration.registrationKey) return false;
		const current = this.session.store.identity;
		if (!current || current.participantKey !== identity.participantKey || current.generation !== identity.generation) return false;
		return current.disposition === "held";
	}
}

function managedParticipantConfigured(control: ManagedAgentControl, participant: ClientParticipantStatus): boolean {
	return control.messagingConfigured === true
		&& control.state === "active"
		&& participant.state === "held"
		&& participant.holderLive
		&& participant.generation === control.holderGeneration
		&& participant.profile === "workspace-write"
		&& participant.driver === control.driver;
}
