import { RuntimeAgentBinder } from "../../extensions/runtime/service/bridge.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "../../extensions/runtime/service/herdr-cli.ts";
import { RuntimeMessaging } from "../../extensions/runtime/service/messaging.ts";
import { HostedParticipantCoordinator } from "../../extensions/runtime/service/participant.ts";
import type { HostedProtocolContext } from "../../extensions/runtime/service/protocol.ts";
import { LiveTargets } from "../../extensions/runtime/service/live.ts";
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
	live: LiveTargets = new LiveTargets(store, host),
	participants: HostedParticipantCoordinator = new HostedParticipantCoordinator(store, live),
	bridges: RuntimeAgentBinder = new RuntimeAgentBinder(store, live, host),
): HostedProtocolContext {
	return {
		runtimeId: "rt_test",
		live,
		participants,
		messaging: new RuntimeMessaging(store, live, participants, `${root}/runtime.sock`),
		bridges,
		worktrees: new RuntimeWorktrees(root, store),
		exit: () => {},
	};
}
