import { RuntimeAgentBinder } from "../../extensions/runtime/service/bridge.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "../../extensions/runtime/service/identity.ts";
import { RuntimeMessaging } from "../../extensions/runtime/service/messaging.ts";
import { HostedParticipantCoordinator } from "../../extensions/runtime/service/participant.ts";
import type { HostedProtocolContext } from "../../extensions/runtime/service/protocol.ts";
import { RuntimeRegistrationManager } from "../../extensions/runtime/service/registration.ts";
import { HostedStateStore } from "../../extensions/runtime/service/state.ts";
import { RuntimeWorktrees } from "../../extensions/runtime/service/worktree.ts";

export class AbsentHost implements HostedHostVerifier {
	async getAgent(agentName: string): Promise<HostedLiveAgent> {
		throw new Error(`no such agent ${agentName}`);
	}
}

/** A dispatcher serves the whole service set, so a test context builds whatever it did not supply itself. */
export function protocolContext(
	root: string,
	store: HostedStateStore,
	host: HostedHostVerifier = new AbsentHost(),
	registrations: RuntimeRegistrationManager = new RuntimeRegistrationManager(store, host),
	participants: HostedParticipantCoordinator = new HostedParticipantCoordinator(store, registrations),
	bridges: RuntimeAgentBinder = new RuntimeAgentBinder(store, registrations, host),
): HostedProtocolContext {
	return {
		runtimeId: "rt_test",
		registrations,
		participants,
		messaging: new RuntimeMessaging(store, registrations, participants, `${root}/runtime.sock`),
		bridges,
		worktrees: new RuntimeWorktrees(root, store),
	};
}
