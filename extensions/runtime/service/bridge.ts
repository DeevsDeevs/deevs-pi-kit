import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { HostedAgentTarget, HostedCollaboratorProfile, HostedNativeCollaboratorDriver } from "../hosted-types.ts";
import { AgentBindError, boundAgentNames, draftAgentBind, type BindAgentInput } from "./bind-request.ts";
import type { HostedHostVerifier } from "./identity.ts";
import { RuntimeRegistrationManager, type HostedLiveRegistration } from "./registration.ts";
import { HostedStateStore } from "./state.ts";

export interface BoundAgentResult {
	registration: HostedLiveRegistration;
	targetKey: string;
	participantKey: string;
	holderGeneration: string;
	driver: HostedNativeCollaboratorDriver;
	profile: HostedCollaboratorProfile;
	projectRoot: string;
	cwd: string;
}

export interface AgentBinderOptions {
	now?: () => number;
	createGeneration?: () => string;
}

/** Verifies one exact live Herdr agent by name and binds it to a target and participant lease. */
export class RuntimeAgentBinder {
	private readonly store: HostedStateStore;
	private readonly registrations: RuntimeRegistrationManager;
	private readonly host: HostedHostVerifier;
	private readonly options: AgentBinderOptions;

	constructor(
		store: HostedStateStore,
		registrations: RuntimeRegistrationManager,
		host: HostedHostVerifier,
		options: AgentBinderOptions = {},
	) {
		this.store = store;
		this.registrations = registrations;
		this.host = host;
		this.options = options;
	}

	async bind(caller: HostedLiveRegistration, input: BindAgentInput): Promise<BoundAgentResult> {
		const callerTarget = this.store.read().targets[caller.targetKey];
		if (callerTarget?.kind !== "pi") {
			throw new AgentBindError("conflict", "Only an authenticated Pi target may bind a Herdr agent collaborator.");
		}
		const projectRoot = realpathSync(callerTarget.projectRoot);
		const names = boundAgentNames(input);
		const verified = await this.host.getAgent(names.agentName);
		const bind = await draftAgentBind({
			store: this.store,
			caller,
			input,
			names,
			verified,
			projectRoot,
			at: this.now(),
			createGeneration: () => this.options.createGeneration?.() ?? `lease_${randomUUID()}`,
		});
		this.store.apply({ type: "agent.bind", bind });
		return boundResult(this.registrations.registerAgent(bind.target), bind.target);
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}

function boundResult(registration: HostedLiveRegistration, target: HostedAgentTarget): BoundAgentResult {
	return {
		registration,
		targetKey: target.targetKey,
		participantKey: target.participantKey,
		holderGeneration: target.holderGeneration,
		driver: target.driver,
		profile: target.profile,
		projectRoot: target.projectRoot,
		cwd: target.worktreePath ?? target.projectRoot,
	};
}
