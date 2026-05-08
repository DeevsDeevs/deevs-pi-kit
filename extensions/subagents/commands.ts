import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyAgentsSettings, defaultAgentsSettings, saveAgentsSettings } from "./config.ts";
import type { SubagentManager } from "./manager.ts";
import type { createSubagentsUi } from "./ui.ts";

type SubagentsUi = ReturnType<typeof createSubagentsUi>;

export function registerSubagentCommands(pi: ExtensionAPI, manager: SubagentManager, ui: SubagentsUi): void {
	pi.registerCommand("agents", {
		description: "Open subagent dashboard, or staff browser when no runs exist",
		handler: async (_args, ctx) => {
			manager.setContext(ctx);
			const status = manager.status({ includeCompleted: true });
			const hasRuns = status.runs.length > 0 || status.groups.length > 0;
			if (ctx.hasUI) await (hasRuns ? ui.showStatus(ctx) : ui.showAgents(ctx));
			else ctx.ui.notify(hasRuns ? manager.formatStatus(true) : formatAgents(manager), "info");
		},
	});

	pi.registerCommand("agents:catalog", {
		description: "Open curated subagent staff browser",
		handler: async (_args, ctx) => {
			manager.setContext(ctx);
			if (ctx.hasUI) await ui.showAgents(ctx);
			else ctx.ui.notify(formatAgents(manager), "info");
		},
	});

	pi.registerCommand("agents:browse", {
		description: "Alias for /agents:catalog",
		handler: async (_args, ctx) => {
			manager.setContext(ctx);
			if (ctx.hasUI) await ui.showAgents(ctx);
			else ctx.ui.notify(formatAgents(manager), "info");
		},
	});

	pi.registerCommand("agents:list", {
		description: "List curated subagent staff as text",
		handler: async (_args, ctx) => {
			manager.setContext(ctx);
			ctx.ui.notify(formatAgents(manager), "info");
		},
	});

	pi.registerCommand("agents:run", {
		description: "Start one background subagent: /agents:run <agent> [--write] [--context fork|fresh] [--model id] -- <task>",
		getArgumentCompletions: (prefix) => manager.listAgents().map((agent) => agent.name).filter((name) => name.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			manager.setContext(ctx);
			try {
				const parsed = parseRunArgs(args);
				const result = await manager.start(parsed, ctx);
				ctx.ui.notify(`Started ${result.agent} ${result.id} proc=${result.procId ?? "none"}\nArtifacts: ${result.artifactsDir}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agents:parallel", {
		description: "Start parallel agents: /agents:parallel reviewer,tester -- Review current diff",
		handler: async (args, ctx) => {
			manager.setContext(ctx);
			try {
				const parsed = parseParallelArgs(args);
				const result = await manager.startParallel(parsed, ctx);
				ctx.ui.notify(`Started parallel group ${result.groupId}\n${result.runs.map((run) => `${run.agent} ${run.id} proc=${run.procId}`).join("\n")}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agents:status", {
		description: "Show active/recent subagent runs and groups",
		handler: async (_args, ctx) => {
			manager.setContext(ctx);
			if (ctx.hasUI) await ui.showStatus(ctx);
			else ctx.ui.notify(manager.formatStatus(true), "info");
		},
	});

	pi.registerCommand("agents:read", {
		description: "Read a subagent run/group: /agents:read <id> [--raw]",
		handler: async (args, ctx) => {
			manager.setContext(ctx);
			const [id, ...flags] = args.trim().split(/\s+/).filter(Boolean);
			if (!id) {
				ctx.ui.notify("Usage: /agents:read <run-id|group-id> [--raw]", "warning");
				return;
			}
			try {
				const result = await manager.read({ id, raw: flags.includes("--raw") });
				ctx.ui.notify(result.output || "(no output)", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agents:stop", {
		description: "Stop a subagent run/group",
		handler: async (args, ctx) => {
			manager.setContext(ctx);
			const id = args.trim();
			if (!id) {
				ctx.ui.notify("Usage: /agents:stop <run-id|group-id>", "warning");
				return;
			}
			try {
				const result = await manager.stop({ id });
				ctx.ui.notify(`Stopped ${result.stopped.length} run(s). status=${result.status}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agents:logs", {
		description: "Open/read subagent artifacts and compact process logs",
		handler: async (args, ctx) => {
			manager.setContext(ctx);
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const raw = parts.includes("--raw");
			const filtered = parts.filter((part) => part !== "--raw");
			const [id, source] = filtered;
			if (!id) {
				ctx.ui.notify("Usage: /agents:logs <run-id|group-id> [result|task|system-prompt|metadata|combined|stdout|stderr] [--raw]", "warning");
				return;
			}
			try {
				if (ctx.hasUI) await ui.showLogs(ctx, id, source as any, raw);
				else {
					const result = await manager.logs({ id, source: source as any, raw });
					ctx.ui.notify(`${result.path ?? result.source}\n\n${result.content}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agents:clear", {
		description: "Clear completed subagent records: /agents:clear <id> | --completed [--delete-artifacts]",
		handler: async (args, ctx) => {
			manager.setContext(ctx);
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				ctx.ui.notify("Usage: /agents:clear <id> | --completed [--delete-artifacts]", "warning");
				return;
			}
			try {
				const result = await manager.clear({
					id: parts[0] && !parts[0].startsWith("--") ? parts[0] : undefined,
					allCompleted: parts.includes("--completed"),
					deleteArtifacts: parts.includes("--delete-artifacts"),
				});
				ctx.ui.notify(`Cleared ${result.cleared.length} subagent record(s).`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agents:dock", {
		description: "Show, hide, or toggle the subagents dock",
		handler: async (args, ctx) => {
			const action = args.trim() || "toggle";
			if (action === "show") ui.showDock(ctx);
			else if (action === "hide") ui.hideDock(ctx);
			else if (action === "toggle") ui.toggleDock(ctx);
			else {
				ctx.ui.notify("Usage: /agents:dock [show|hide|toggle]", "warning");
				return;
			}
			ctx.ui.notify(`subagents dock ${ui.isDockVisible() ? "shown" : "hidden"}`, "info");
		},
	});

	pi.registerCommand("agents:settings", {
		description: "Configure and persist project subagent defaults",
		handler: async (args, ctx) => {
			manager.setContext(ctx);
			const text = args.trim();
			if (text) {
				try {
					if (text === "status" || text === "show") {
						ctx.ui.notify(`${formatSettings(manager)}\nProject config: .pi/subagents.json`, "info");
						return;
					}
					applySettingsCommand(manager, text);
					await saveAgentsSettings(ctx.cwd, manager.settings);
					ctx.ui.notify(`${formatSettings(manager)}\nPersisted: .pi/subagents.json`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (ctx.hasUI) await ui.showSettings(ctx);
			else ctx.ui.notify(formatSettings(manager), "info");
		},
	});
}

function parseRunArgs(args: string) {
	const split = splitTask(args);
	const parts = split.head.split(/\s+/).filter(Boolean);
	const agent = parts.shift();
	if (!agent) throw new Error("Usage: /agents:run <agent> [--write] [--context fork|fresh] [--model id] -- <task>");
	let allowWrite = false;
	let context: "fresh" | "fork" | undefined;
	let model: string | undefined;
	let sawFlag = false;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part === "--write") {
			allowWrite = true;
			sawFlag = true;
		} else if (part === "--context") {
			context = parts[++i] as "fresh" | "fork";
			if (!context) throw new Error("Missing value for --context");
			sawFlag = true;
		} else if (part === "--model") {
			model = parts[++i];
			if (!model) throw new Error("Missing value for --model");
			sawFlag = true;
		} else if (part.startsWith("--")) throw new Error(`Unknown option: ${part}`);
		else if (sawFlag) throw new Error("Task must follow -- when using options.");
	}
	const task = split.task || (sawFlag ? "" : parts.join(" "));
	if (!task.trim()) throw new Error("Missing task. Use: /agents:run <agent> -- <task>");
	return { agent, task, allowWrite, context, model };
}

function parseParallelArgs(args: string) {
	const split = splitTask(args);
	const agents = split.head.split(/\s+/)[0]?.split(",").map((agent) => agent.trim()).filter(Boolean) ?? [];
	if (agents.length === 0 || !split.task.trim()) throw new Error("Usage: /agents:parallel reviewer,tester,anti-slop -- Review current diff");
	return { tasks: agents.map((agent) => ({ agent, task: sharedParallelTask(agent, split.task) })) };
}

function splitTask(args: string): { head: string; task: string } {
	const match = /(^|\s)--(\s|$)/.exec(args);
	if (!match || match.index === undefined) return { head: args.trim(), task: "" };
	const index = match.index + match[1]!.length;
	return { head: args.slice(0, index).trim(), task: args.slice(index + 2).trim() };
}

function sharedParallelTask(agent: string, task: string): string {
	return `You are the ${agent} perspective in a parallel review. Shared task:\n${task}\n\nFocus only on your specialty. Do not duplicate other agents unless necessary.`;
}

function formatAgents(manager: SubagentManager): string {
	return manager.listAgents().map((agent) => `${agent.name} - ${agent.description}`).join("\n") || "No agents found.";
}

function applySettingsCommand(manager: SubagentManager, text: string): void {
	const [command, ...rest] = text.split(/\s+/).filter(Boolean);
	const settings = manager.settings;
	if (command === "allow-model") {
		const model = rest.join(" ").trim();
		if (!model) throw new Error("Usage: /agents:settings allow-model <model>");
		if (!settings.allowedModels.includes(model)) settings.allowedModels.push(model);
		return;
	}
	if (command === "disallow-model") {
		const model = rest.join(" ").trim();
		if (!model) throw new Error("Usage: /agents:settings disallow-model <model>");
		settings.allowedModels = settings.allowedModels.filter((value) => value !== model);
		if (settings.defaultModel === model) settings.defaultModel = undefined;
		for (const [agent, value] of Object.entries(settings.modelsByAgent)) if (value === model) delete settings.modelsByAgent[agent];
		return;
	}
	if (command === "reset") {
		applyAgentsSettings(settings, defaultAgentsSettings);
		return;
	}
	if (command === "clear-models") {
		settings.allowedModels = [];
		settings.defaultModel = undefined;
		settings.modelsByAgent = {};
		return;
	}
	if (command === "default-model") {
		const model = rest.join(" ").trim();
		if (!model || model === "inherit") {
			settings.defaultModel = undefined;
			return;
		}
		if (!settings.allowedModels.includes(model)) throw new Error(`Model is not allowed: ${model}. Run /agents:settings allow-model ${model}`);
		settings.defaultModel = model;
		return;
	}
	if (command === "agent-model") {
		const [agent, ...modelParts] = rest;
		const model = modelParts.join(" ").trim();
		if (!agent || !model) throw new Error("Usage: /agents:settings agent-model <agent> <model|inherit>");
		if (model === "inherit") delete settings.modelsByAgent[agent];
		else {
			if (!settings.allowedModels.includes(model)) throw new Error(`Model is not allowed: ${model}. Run /agents:settings allow-model ${model}`);
			settings.modelsByAgent[agent] = model;
		}
		return;
	}
	throw new Error("Usage: /agents:settings [allow-model|disallow-model|clear-models|default-model|agent-model|reset] ...");
}

function formatSettings(manager: SubagentManager): string {
	const settings = manager.settings;
	return [
		`allowedModels: ${settings.allowedModels.join(",") || "inherit only"}`,
		`defaultModel: ${settings.defaultModel ?? "inherit"}`,
		`modelsByAgent: ${Object.entries(settings.modelsByAgent).map(([agent, model]) => `${agent}=${model}`).join(",") || "none"}`,
		`defaultTimeoutMs: ${settings.defaultTimeoutMs}`,
		`maxTimeoutMs: ${settings.maxTimeoutMs}`,
		`parallelDefaultConcurrency: ${settings.parallelDefaultConcurrency}`,
		`parallelMaxConcurrency: ${settings.parallelMaxConcurrency}`,
		`dockEnabled: ${settings.dockEnabled}`,
		`dockHeight: ${settings.dockHeight}`,
		`defaultAllowWrite: ${settings.defaultAllowWrite}`,
		`notifyOnTerminal: ${settings.notifyOnTerminal}`,
		`wakeOnCompletion: ${settings.wakeOnCompletion}`,
		`wakeOnFailure: ${settings.wakeOnFailure}`,
		`wakeOnTimeout: ${settings.wakeOnTimeout}`,
	].join("\n");
}
