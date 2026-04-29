import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type ChainDisciplineMode = "off" | "nudge" | "guarded" | "strict";

export interface ChainDisciplineConfig {
	enabled: boolean;
	mode: ChainDisciplineMode;
	defaultChain?: string;
	guardResumePrompts: boolean;
	guardDurablePrompts: boolean;
	nudgeAfterMutatingTools: boolean;
	notifyOnStart: boolean;
}

interface PromptClassification {
	resumeLike: boolean;
	durable: boolean;
	trivial: boolean;
	bypass: boolean;
	reason: string;
}

interface RunState {
	classification: PromptClassification;
	reminded: boolean;
	sawChainRead: boolean;
	sawChainSave: boolean;
	mutatingTools: string[];
	inspectingTools: string[];
	blockedOnce: boolean;
}

const DEFAULT_CONFIG: ChainDisciplineConfig = {
	enabled: true,
	mode: "nudge",
	guardResumePrompts: true,
	guardDurablePrompts: false,
	nudgeAfterMutatingTools: true,
	notifyOnStart: false,
};

const CHAIN_READ_TOOLS = new Set(["chain_load", "chain_search", "chain_context", "chain_list"]);
const CHAIN_SAVE_TOOLS = new Set(["chain_save"]);
const MUTATING_TOOLS = new Set(["edit", "write", "proc_start", "agent_start", "agent_parallel_start"]);
const INSPECTION_TOOLS = new Set(["read", "todo_list", "wiki_status", "wiki_lint", "wiki_graph", "wiki_search", "wiki_context", "arxiv_search", "arxiv_get", "arxiv_bibtex"]);

export function registerChainDiscipline(pi: ExtensionAPI): void {
	let config = { ...DEFAULT_CONFIG };
	let current: RunState | undefined;

	pi.on("session_start", async (_event, ctx) => {
		config = await loadChainDisciplineConfig(ctx.cwd);
	});

	pi.on("before_agent_start", async (event: any, ctx: ExtensionContext) => {
		if (!config.enabled || config.mode === "off") {
			current = undefined;
			return;
		}

		const prompt = String(event.prompt ?? "");
		const classification = classifyChainPrompt(prompt);
		const shouldRemind = shouldApplyDiscipline(classification);
		current = {
			classification,
			reminded: shouldRemind,
			sawChainRead: false,
			sawChainSave: false,
			mutatingTools: [],
			inspectingTools: [],
			blockedOnce: false,
		};

		if (!shouldRemind) return;
		if (config.notifyOnStart && ctx.hasUI) ctx.ui.notify(`Chain discipline: ${classification.reason}; check chains if relevant.`, "info");
		const systemPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
		return { systemPrompt: `${systemPrompt}\n\n${chainDisciplineReminder(config, classification)}` };
	});

	pi.on("tool_call", async (event: any) => {
		if (!current || !config.enabled || config.mode === "off") return;
		const toolName = String(event.toolName ?? "");
		if (CHAIN_READ_TOOLS.has(toolName)) {
			current.sawChainRead = true;
			return;
		}
		if (CHAIN_SAVE_TOOLS.has(toolName)) {
			current.sawChainSave = true;
			return;
		}
		if (INSPECTION_TOOLS.has(toolName)) {
			current.inspectingTools.push(toolName);
			return;
		}

		const mutating = isMutatingToolCall(toolName, event.input);
		if (!mutating) {
			current.inspectingTools.push(toolName);
			return;
		}

		if (shouldBlockForChainRead(config, current)) {
			current.blockedOnce = true;
			return {
				block: true,
				reason: "This looks like resumed/durable project work. Call chain_search, chain_load, chain_context, or chain_list before mutating files/process state. If no chain applies, chain_list is enough to make that explicit.",
			};
		}
		current.mutatingTools.push(toolName);
	});

	pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
		if (!current || !config.enabled || config.mode === "off") return;
		const finished = current;
		current = undefined;
		if (!config.nudgeAfterMutatingTools || !finished.reminded || finished.sawChainSave || finished.classification.bypass) return;
		if (finished.mutatingTools.length === 0) return;
		if (!ctx.hasUI) return;
		const tools = [...new Set(finished.mutatingTools)].slice(0, 4).join(", ");
		ctx.ui.notify(`Meaningful durable work used ${tools}. Consider chain_save before handoff/context loss.`, "info");
	});
}

export async function loadChainDisciplineConfig(cwd: string): Promise<ChainDisciplineConfig> {
	const fromFile = await readConfigFile(join(cwd, ".pi", "chain-discipline.json"));
	const modeFromEnv = parseMode(process.env.DEEVS_CHAIN_DISCIPLINE_MODE);
	const enabledFromEnv = parseBool(process.env.DEEVS_CHAIN_DISCIPLINE_ENABLED);
	return normalizeConfig({ ...DEFAULT_CONFIG, ...fromFile, mode: modeFromEnv ?? fromFile.mode ?? DEFAULT_CONFIG.mode, enabled: enabledFromEnv ?? fromFile.enabled ?? DEFAULT_CONFIG.enabled });
}

async function readConfigFile(path: string): Promise<Partial<ChainDisciplineConfig>> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ChainDisciplineConfig>;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function normalizeConfig(input: Partial<ChainDisciplineConfig>): ChainDisciplineConfig {
	const mode = parseMode(input.mode) ?? DEFAULT_CONFIG.mode;
	return {
		enabled: input.enabled !== false,
		mode,
		defaultChain: typeof input.defaultChain === "string" && input.defaultChain.trim() ? input.defaultChain.trim() : undefined,
		guardResumePrompts: input.guardResumePrompts !== false,
		guardDurablePrompts: input.guardDurablePrompts === true,
		nudgeAfterMutatingTools: input.nudgeAfterMutatingTools !== false,
		notifyOnStart: input.notifyOnStart === true,
	};
}

function parseMode(value: unknown): ChainDisciplineMode | undefined {
	return value === "off" || value === "nudge" || value === "guarded" || value === "strict" ? value : undefined;
}

function parseBool(value: unknown): boolean | undefined {
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	return undefined;
}

export function classifyChainPrompt(prompt: string): PromptClassification {
	const text = prompt.toLowerCase();
	const bypass = /\b(no chains?|do not use chains?|don't use chains?|skip chains?|do not persist|don't persist)\b/.test(text);
	const resumeLike = /\b(continue|resume|pick up|where were we|handoff|previous session|from last time|chain link|load chain|saved context)\b/.test(text);
	const durable = /\b(implement|fix|debug|diagnose|refactor|review|validate|ship|plan|design|migrate|add|remove|build|test|smoke)\b/.test(text) && /\b(repo|project|extension|skill|code|file|diff|branch|package|feature|bug|work)\b/.test(text);
	const trivial = prompt.trim().length < 80 && /\b(what is|explain|define|quick question|yes|no|thanks)\b/.test(text) && !resumeLike && !durable;
	const reason = resumeLike ? "resume-like prompt" : durable ? "durable project prompt" : trivial ? "trivial prompt" : "ordinary prompt";
	return { resumeLike, durable, trivial, bypass, reason };
}

function shouldApplyDiscipline(classification: PromptClassification): boolean {
	return !classification.bypass && !classification.trivial && (classification.resumeLike || classification.durable);
}

function chainDisciplineReminder(config: ChainDisciplineConfig, classification: PromptClassification): string {
	const chainHint = config.defaultChain ? ` Prefer chain ${JSON.stringify(config.defaultChain)} when it matches the repo/topic.` : "";
	const guardHint = config.mode === "guarded" || config.mode === "strict" ? " In guarded mode, check chains before mutating files/process state." : "";
	return [
		"Chain discipline reminder:",
		`- This looks like ${classification.reason}; before rediscovering prior durable work, use chain_search/chain_load/chain_context when relevant.${chainHint}`,
		"- If no chain applies, briefly say so and continue.",
		"- After meaningful milestones, save a concise chain link with chain_save before handoff/context loss.",
		`- Do not auto-save noisy links; use chains only for handoff-quality memory.${guardHint}`,
	].join("\n");
}

function shouldBlockForChainRead(config: ChainDisciplineConfig, state: RunState): boolean {
	if (state.sawChainRead || state.classification.bypass) return false;
	if (config.mode === "strict") return state.reminded;
	if (config.mode !== "guarded") return false;
	if (state.classification.resumeLike && config.guardResumePrompts) return true;
	if (state.classification.durable && config.guardDurablePrompts) return true;
	return false;
}

function isMutatingToolCall(toolName: string, input: unknown): boolean {
	if (MUTATING_TOOLS.has(toolName)) return true;
	if (toolName !== "bash") return false;
	const command = typeof (input as any)?.command === "string" ? (input as any).command : "";
	return /(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|npm\s+install|pnpm\s+install|yarn\s+add|bun\s+add|git\s+(commit|push|reset|checkout|switch|merge|rebase|stash)|python\S*\s+.*\b(open\(|write\())\b/.test(command)
		|| /(^|[^0-9>])>>?\s*[^&\s]/.test(command);
}
