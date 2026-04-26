import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ProcessesConfig } from "./config.ts";
import type { ProcessManagerEvent } from "./types.ts";

export function createAlertSink(pi: ExtensionAPI, config: ProcessesConfig): (event: ProcessManagerEvent) => void {
	const sentAt: number[] = [];

	return (event) => {
		const now = Date.now();
		while (sentAt.length > 0 && now - sentAt[0]! > 60_000) sentAt.shift();

		const triggerTurn = event.triggerTurn && sentAt.length < config.alerts.maxAgentTurnsPerMinute;
		if (triggerTurn) sentAt.push(now);

		pi.sendMessage(
			{
				customType: "background-tasks",
				content: formatProcessEvent(event),
				display: true,
				details: event,
			},
			{ triggerTurn, deliverAs: "followUp" },
		);
	};
}

function formatProcessEvent(event: ProcessManagerEvent): string {
	switch (event.type) {
		case "watch_match":
			return `Process ${event.process.id} (${event.process.name}) matched watch "${event.pattern}".`;
		case "process_exit":
			return `Process ${event.process.id} (${event.process.name}) exited with status ${event.process.status}.`;
	}
}
