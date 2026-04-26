import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ProcessManager } from "./manager.ts";
import type { createProcessUi } from "./ui.ts";

type ProcessUi = ReturnType<typeof createProcessUi>;

export function registerProcessCommands(pi: ExtensionAPI, manager: ProcessManager, processUi: ProcessUi): void {
	pi.registerCommand("proc", {
		description: "Open managed background process panel",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) await processUi.showPanel(ctx);
			else ctx.ui.notify(manager.formatList(true), "info");
		},
	});

	pi.registerCommand("proc:list", {
		description: "List managed background processes as text",
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
		description: "Gracefully stop a managed process, or all with --all",
		getArgumentCompletions: (prefix) => ["--all", ...completeProcessIds(manager, prefix).map((item) => item.value)]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const idOrName = args.trim();
			if (!idOrName) {
				ctx.ui.notify("Usage: /proc:kill [id|name|--all]", "warning");
				return;
			}
			try {
				if (idOrName === "--all") {
					const result = await signalAll(manager, "SIGTERM");
					ctx.ui.notify(formatSignalAllResult(result), "info");
					return;
				}
				const process = await manager.signal({ id: manager.resolveId(idOrName), signal: "SIGTERM", tree: true, timeoutMs: 5000 });
				ctx.ui.notify(`${process.id} is ${process.status}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("proc:kill-all", {
		description: "Gracefully stop all running managed background processes",
		handler: async (_args, ctx) => {
			const result = await signalAll(manager, "SIGTERM");
			ctx.ui.notify(formatSignalAllResult(result), "info");
		},
	});

	pi.registerCommand("proc:signal", {
		description: "Send a signal to a managed process",
		getArgumentCompletions: (prefix) => completeProcessIds(manager, prefix),
		handler: async (args, ctx) => {
			const [idOrName, signal = "SIGTERM"] = args.trim().split(/\s+/);
			if (!idOrName) {
				ctx.ui.notify("Usage: /proc:signal [id|name] [SIGINT|SIGTERM|SIGKILL]", "warning");
				return;
			}
			if (!["SIGINT", "SIGTERM", "SIGKILL"].includes(signal)) {
				ctx.ui.notify(`Invalid signal: ${signal}`, "warning");
				return;
			}
			try {
				const process = await manager.signal({ id: manager.resolveId(idOrName), signal: signal as "SIGINT" | "SIGTERM" | "SIGKILL", tree: true, timeoutMs: 5000 });
				ctx.ui.notify(`${process.id} is ${process.status}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("proc:logs", {
		description: "Open searchable log viewer for a managed process",
		getArgumentCompletions: (prefix) => completeProcessIds(manager, prefix),
		handler: async (args, ctx) => {
			const [idOrName, stream = "combined"] = args.trim().split(/\s+/);
			if (!idOrName) {
				ctx.ui.notify("Usage: /proc:logs [id|name] [combined|stdout|stderr]", "warning");
				return;
			}
			if (!["combined", "stdout", "stderr"].includes(stream)) {
				ctx.ui.notify(`Invalid stream: ${stream}`, "warning");
				return;
			}
			try {
				const id = manager.resolveId(idOrName);
				if (ctx.hasUI) await processUi.showLogViewer(ctx, id, stream as "combined" | "stdout" | "stderr");
				else {
					const logs = await manager.logs({ id, stream: stream as "combined" | "stdout" | "stderr", maxBytes: 16_384 });
					ctx.ui.notify(logs ? formatLogs(logs) : "No logs for this process.", "info");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("proc:settings", {
		description: "Configure background task defaults for this session",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) await processUi.showSettings(ctx);
			else ctx.ui.notify(formatSettings(manager), "info");
		},
	});

	pi.registerCommand("proc:dock", {
		description: "Show, hide, or toggle the background process dock",
		getArgumentCompletions: (prefix) => ["show", "hide", "toggle"]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim() || "toggle";
			if (action === "show") processUi.showDock(ctx);
			else if (action === "hide") processUi.hideDock(ctx);
			else if (action === "toggle") processUi.toggleDock(ctx);
			else {
				ctx.ui.notify("Usage: /proc:dock [show|hide|toggle]", "warning");
				return;
			}
			ctx.ui.notify(`background-tasks dock ${processUi.isDockVisible() ? "shown" : "hidden"}`, "info");
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

async function signalAll(manager: ProcessManager, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<{ signaled: string[]; failed: string[] }> {
	const targets = manager.list({ includeExited: false, includePersistent: true });
	const results = await Promise.allSettled(
		targets.map((process) => manager.signal({ id: process.id, signal, tree: true, timeoutMs: 5000 })),
	);
	return {
		signaled: targets.filter((_process, index) => results[index]?.status === "fulfilled").map((process) => process.id),
		failed: targets.filter((_process, index) => results[index]?.status === "rejected").map((process) => process.id),
	};
}

function formatSignalAllResult(result: { signaled: string[]; failed: string[] }): string {
	if (result.signaled.length === 0 && result.failed.length === 0) return "No running managed processes.";
	const lines = [`Signaled ${result.signaled.length} process(es).`];
	if (result.signaled.length > 0) lines.push(`signaled: ${result.signaled.join(", ")}`);
	if (result.failed.length > 0) lines.push(`failed: ${result.failed.join(", ")}`);
	return lines.join("\n");
}

function formatSettings(manager: ProcessManager): string {
	const config = manager.getConfig();
	return [
		`defaultBackend: ${config.execution.defaultBackend}`,
		`killOnReload: ${config.execution.killOnReload}`,
		`killOnShutdown: ${config.execution.killOnShutdown}`,
		`defaultAlertOnFailure: ${config.alerts.defaultAlertOnFailure}`,
		`defaultAlertOnExit: ${config.alerts.defaultAlertOnExit}`,
		`dockEnabled: ${config.ui.dockEnabled}`,
		`dockHeight: ${config.ui.dockHeight}`,
	].join("\n");
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
