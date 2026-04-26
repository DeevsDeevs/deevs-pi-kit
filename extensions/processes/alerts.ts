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
				content: formatProcessEvent(event, triggerTurn, event.triggerTurn && !triggerTurn),
				display: true,
				details: event,
			},
			{ triggerTurn, deliverAs: "followUp" },
		);
	};
}

function formatProcessEvent(event: ProcessManagerEvent, triggerTurn: boolean, rateLimited: boolean): string {
	const suffix = rateLimited ? "\nAgent wake-up skipped: alert rate limit reached." : triggerTurn ? "\nAgent wake-up queued." : "";

	switch (event.type) {
		case "watch_match": {
			const header = `${event.process.name} (${event.process.id})`;
			const text = event.text ? `\nMatched output: ${truncateOneLine(event.text, 240)}` : "";
			return `Watch matched for ${header}: "${event.pattern}".${text}${suffix}`;
		}
		case "process_exit": {
			const process = event.process;
			const header = `${process.name} (${process.id})`;
			const exit = process.signal || process.exitCode === null ? "" : ` exit=${process.exitCode}`;
			const signal = process.signal ? ` signal=${process.signal}` : "";
			const logs = process.logFile ? `\nLogs: ${process.logFile}` : "";
			return `Process finished: ${header} status=${process.status}${exit}${signal}.${logs}${suffix}`;
		}
		case "shutdown_cleanup": {
			const names = event.processes.map((process) => `${process.name} (${process.id})`).join(", ");
			return `Stopped ${event.processes.length} non-persistent background task(s) for ${event.reason}: ${names}.`;
		}
	}
}

function truncateOneLine(value: string, maxLength: number): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length <= maxLength ? line : `${line.slice(0, maxLength - 3)}...`;
}
