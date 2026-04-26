import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ProcessManager } from "./manager.ts";

export function registerProcessCommands(pi: ExtensionAPI, manager: ProcessManager): void {
	pi.registerCommand("proc", {
		description: "List managed background processes",
		handler: async (_args, ctx) => {
			ctx.ui.notify(manager.formatList(true), "info");
		},
	});

	pi.registerCommand("proc:read", {
		description: "Show buffered output for a managed process",
		getArgumentCompletions: (prefix) => completeProcessIds(manager, prefix),
		handler: async (args, ctx) => {
			const idOrName = args.trim();
			if (!idOrName) {
				ctx.ui.notify("Usage: /proc:read [id|name]", "warning");
				return;
			}
			try {
				ctx.ui.notify(manager.formatRead(manager.resolveId(idOrName)), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("proc:kill", {
		description: "Gracefully stop a managed process",
		getArgumentCompletions: (prefix) => completeProcessIds(manager, prefix),
		handler: async (args, ctx) => {
			const idOrName = args.trim();
			if (!idOrName) {
				ctx.ui.notify("Usage: /proc:kill [id|name]", "warning");
				return;
			}
			try {
				const process = await manager.signal({ id: manager.resolveId(idOrName), signal: "SIGTERM", tree: true, timeoutMs: 5000 });
				ctx.ui.notify(`${process.id} is ${process.status}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("proc:logs", {
		description: "Show log tail for a managed process",
		getArgumentCompletions: (prefix) => completeProcessIds(manager, prefix),
		handler: async (args, ctx) => {
			const idOrName = args.trim();
			if (!idOrName) {
				ctx.ui.notify("Usage: /proc:logs [id|name]", "warning");
				return;
			}
			try {
				const logs = await manager.logs({ id: manager.resolveId(idOrName), maxBytes: 16_384 });
				ctx.ui.notify(logs ? formatLogs(logs) : "No logs for this process.", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("proc:clear", {
		description: "Clear exited managed process records",
		getArgumentCompletions: (prefix) => ["--exited", ...manager.list({ includeExited: true, includePersistent: true }).map((p) => p.id)]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const value = args.trim();
			if (!value) {
				ctx.ui.notify("Usage: /proc:clear [id|name|--exited]", "warning");
				return;
			}
			try {
				const result = value === "--exited" ? await manager.clear({ allExited: true }) : await manager.clear({ id: manager.resolveId(value) });
				ctx.ui.notify(`Cleared ${result.cleared.length} process record(s).`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

function formatLogs(logs: Awaited<NonNullable<ReturnType<ProcessManager["logs"]>>>): string {
	const header = [
		`stream:   ${logs.stream}`,
		`combined: ${logs.logFile}`,
		`stdout:   ${logs.stdoutLogFile}`,
		`stderr:   ${logs.stderrLogFile}`,
		`bytes:    ${logs.bytesWritten}/${logs.maxBytes}${logs.truncated ? " truncated" : ""}`,
		`tail:     ${logs.contentBytes} bytes${logs.truncatedFromStart ? " (truncated from start)" : ""}`,
	].join("\n");
	return logs.content ? `${header}\n\n${logs.content}` : `${header}\n\n(no log output)`;
}

function completeProcessIds(manager: ProcessManager, prefix: string): Array<{ value: string; label: string }> {
	return manager
		.list({ includeExited: true, includePersistent: true })
		.flatMap((process) => [process.id, process.name])
		.filter((value, index, values) => values.indexOf(value) === index)
		.filter((value) => value.startsWith(prefix))
		.map((value) => ({ value, label: value }));
}
