import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClientError, type HostedRuntimeClient } from "./client.ts";
import { isEnded, isHeld } from "./schemas/state.ts";
import { auth, parseAcquireResult, parseParticipant, type ClientParticipantStatus, type LiveClientRegistration } from "./responses.ts";
import type { HostedSessionStore, ParticipantIdentity } from "./session-record.ts";

/** What re-proving a held identity needs from the Runtime session that owns it. */
interface HeldIdentitySession {
	readonly client: HostedRuntimeClient;
	readonly store: HostedSessionStore;
	scope(ctx: ExtensionContext, registration?: LiveClientRegistration): () => boolean;
	requireCurrentScope(current: () => boolean): void;
}

/** Re-proves a persisted held identity against Runtime, demoting it in session history when it no longer holds. */
export async function restoreHeldParticipant(
	session: HeldIdentitySession,
	registration: LiveClientRegistration,
	ctx: ExtensionContext,
): Promise<void> {
	const identity = session.store.identity;
	const scope = session.scope(ctx, registration);
	const currentScope = (): boolean => scope() && session.store.identity === identity;
	if (!identity || !isHeld(identity.disposition)) return;
	session.requireCurrentScope(currentScope);
	if (identity.participantKey && await verifyHeldParticipant(session, identity, registration, ctx, currentScope)) return;
	const acquired = parseAcquireResult(await session.client.call("participant.acquire", {
		...auth(registration),
		protocol: identity.protocol,
		participantId: identity.participantId,
		revive: identity.reviveAuthorized === true,
	}));
	session.requireCurrentScope(currentScope);
	const restored = acquired.participant;
	const changed = identity.participantKey !== restored.participantKey || identity.generation !== restored.generation;
	if (changed) session.store.persistHeld(identity.protocol, identity.participantId, restored);
}

/** True when the persisted key resolved and no further acquisition should follow. */
async function verifyHeldParticipant(
	session: HeldIdentitySession,
	identity: ParticipantIdentity,
	registration: LiveClientRegistration,
	ctx: ExtensionContext,
	currentScope: () => boolean,
): Promise<boolean> {
	const participantKey = identity.participantKey;
	if (!participantKey) return false;
	const name = `${identity.protocol}/${identity.participantId}`;
	let current: ClientParticipantStatus;
	try {
		current = parseParticipant(await session.client.call("participant.get", { ...auth(registration), participantKey }));
	} catch (error) {
		session.requireCurrentScope(currentScope);
		if (!(error instanceof HostedRuntimeClientError) || error.code !== "not_found") throw error;
		return vacate(session, identity, ctx, `Collaborator ${name} is absent from Runtime; explicit acquire is required.`);
	}
	session.requireCurrentScope(currentScope);
	if (current.protocol !== identity.protocol || current.participantId !== identity.participantId) {
		return vacate(session, identity, ctx, `Collaborator identity key does not match ${name}; explicit acquire is required.`);
	}
	if (isHeld(current.state) && current.holderTargetKey === registration.targetKey) return false;
	session.store.persistIdentity({
		...identity,
		participantKey: current.participantKey,
		generation: current.generation,
		disposition: isEnded(current.state) ? "ended" : "vacant",
	});
	ctx.ui.notify(`Collaborator ${name} is ${current.state}; explicit acquire or takeover is required.`, "warning");
	return true;
}

/** Drops the persisted key so only an explicit acquire can hold this identity again. */
function vacate(session: HeldIdentitySession, identity: ParticipantIdentity, ctx: ExtensionContext, reason: string): boolean {
	session.store.persistIdentity({ protocol: identity.protocol, participantId: identity.participantId, disposition: "vacant" });
	ctx.ui.notify(reason, "warning");
	return true;
}
