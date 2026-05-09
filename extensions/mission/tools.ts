import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initializeMissionArtifacts, missionRoot, updateMissionSummaryArtifact, writeCompletionAudit, writeMissionProgressArtifacts } from "./artifacts.ts";
import type { MissionState } from "./state.ts";
import type { MissionCompleteInput, MissionCreateInput, MissionProgressInput, MissionSearchInput } from "./types.ts";

const CreateSchema = Type.Object({
	objective: Type.String({ description: "Full mission objective and requirements to pursue until complete, paused, cleared, or budget-limited" }),
	title: Type.Optional(Type.String({ description: "Short human-readable mission name; recommended for long objectives" })),
	requirements: Type.Optional(Type.Array(Type.String(), { description: "Optional decomposed requirements/success criteria from the objective" })),
	tokenBudget: Type.Optional(Type.Number({ description: "Optional positive token budget for the mission" })),
	costBudgetUsd: Type.Optional(Type.Number({ description: "Optional positive USD cost budget for the mission" })),
	chain: Type.Optional(Type.String({ description: "Optional chain name; if omitted Mission auto-binds to a matching or derived chain" })),
	chainBranch: Type.Optional(Type.String({ description: "Chain branch; defaults to main" })),
});

const GetSchema = Type.Object({});

const ProgressSchema = Type.Object({
	summary: Type.String({ description: "Short durable progress/blocker/checkpoint summary" }),
	evidence: Type.Optional(Type.Array(Type.String(), { description: "Concrete evidence, files, commands, outputs, or decisions worth preserving" })),
	remaining: Type.Optional(Type.Array(Type.String(), { description: "Known remaining work or blockers" })),
	validation: Type.Optional(Type.Array(Type.String(), { description: "Validation commands/results or checks performed" })),
	checkpoint: Type.Optional(Type.Boolean({ description: "True only for meaningful checkpoint/handoff/final progress" })),
});

const SearchSchema = Type.Object({
	query: Type.String({ description: "Search terms for mission artifacts and progress logs" }),
	maxResults: Type.Optional(Type.Number({ description: "Maximum matches to return; default 8" })),
});

const AuditItemSchema = Type.Object({ 
	requirement: Type.String({ description: "Requirement or success criterion" }),
	evidence: Type.String({ description: "Concrete evidence that satisfies the requirement" }),
});

const CompleteSchema = Type.Object({
	summary: Type.Optional(Type.String({ description: "Concise completion summary" })),
	audit: Type.Optional(Type.Array(AuditItemSchema, { description: "Requirement-to-evidence completion audit" })),
	userRequested: Type.Optional(Type.Boolean({ description: "True when explicitly ending the mission because the user asked, even if the objective audit is incomplete" })),
});

export function registerMissionTools(pi: ExtensionAPI, state: MissionState, setContext: (ctx: ExtensionContext) => void): void {
	(pi as any).registerTool({
		name: "mission_get",
		label: "Get Mission",
		description: "Get the current branch-scoped Pi mission, including status, chain binding, budgets, usage, and artifact path.",
		promptSnippet: "Read the active branch-scoped mission.",
		parameters: GetSchema as any,
		async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const mission = state.readAny();
			const usage = state.readUsage();
			return { content: [{ type: "text" as const, text: formatMission(mission, usage) }], details: { mission, usage } };
		},
	});

	(pi as any).registerTool({
		name: "mission_create",
		label: "Create Mission",
		description: "Create a persistent branch-scoped mission only when explicitly requested by the user or system/developer instructions.",
		promptSnippet: "Create a persistent mission objective for this branch.",
		promptGuidelines: [
			"Use mission_create only when the user explicitly asks for a mission/goal/objective that should continue across turns.",
			"For long or multi-part objectives, provide a concise title and decomposed requirements; ask the user only if the name/scope is ambiguous.",
			"Set tokenBudget or costBudgetUsd only when the user explicitly requests a budget.",
			"Mission auto-binds to a short title-derived chain if chain is omitted and creates .missions artifacts.",
		],
		parameters: CreateSchema as any,
		async execute(_toolCallId: string, params: MissionCreateInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const event = await state.create(params, ctx);
			const mission = state.append(pi, event)!;
			await initializeMissionArtifacts(ctx.cwd, mission, state.readUsage());
			return { content: [{ type: "text" as const, text: `Mission created: ${mission.title}\nChain: ${mission.chain}@${mission.chainBranch}\nArtifacts: ${mission.artifactDir}` }], details: { mission, usage: state.readUsage() } };
		},
	});

	(pi as any).registerTool({
		name: "mission_progress",
		label: "Mission Progress",
		description: "Record compact durable mission progress without manually editing mission artifacts. Generated artifacts become searchable with mission_search.",
		promptSnippet: "Append a compact mission progress record instead of editing .missions files manually.",
		promptGuidelines: [
			"Use mission_progress when durable progress, evidence, validation, remaining work, or a blocker changes.",
			"Do not call it for every tiny tool result; keep summaries compact.",
			"Prefer this over manually editing .missions/plan.md, audit.md, or decisions.md during normal work.",
			"Set checkpoint=true only for meaningful milestones, handoffs, cleanup, or final validation.",
		],
		parameters: ProgressSchema as any,
		async execute(_toolCallId: string, params: MissionProgressInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const event = state.progressEvent(params);
			const mission = state.append(pi, event)!;
			const usage = state.readUsage();
			await writeMissionProgressArtifacts(mission, state.readProgress(), usage);
			return { content: [{ type: "text" as const, text: `Mission progress recorded: ${mission.title}\nArtifacts: ${mission.artifactDir}/log.md` }], details: { mission, progress: state.readProgress().at(-1), usage } };
		},
	});

	(pi as any).registerTool({
		name: "mission_search",
		label: "Search Missions",
		description: "Search durable Mission artifacts and generated progress logs, similar to chain search but scoped to .missions/.",
		promptSnippet: "Search prior mission progress and artifacts before repeating work.",
		promptGuidelines: [
			"Use mission_search to find prior Mission decisions, evidence, remaining work, or validation results.",
			"Use concise topic queries; inspect concrete files only when search results are insufficient.",
		],
		parameters: SearchSchema as any,
		async execute(_toolCallId: string, params: MissionSearchInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			setContext(ctx);
			const results = await searchMissions(ctx.cwd, params);
			return { content: [{ type: "text" as const, text: formatMissionSearchResults(results) }], details: { results } };
		},
	});

	(pi as any).registerTool({
		name: "mission_complete",
		label: "Complete Mission",
		description: "Mark the active mission complete only after auditing objective requirements against concrete evidence.",
		promptSnippet: "Complete the active mission after a concrete completion audit.",
		promptGuidelines: [
			"Use mission_complete when the mission objective is actually achieved and no required work remains.",
			"If the user explicitly asks to end/complete/stop the mission, call mission_complete immediately with userRequested=true; summarize known remaining work and mention the mission can be resumed if needed.",
			"Do not use mission_complete merely because budget is exhausted, work is paused, or progress is partial without an explicit user request.",
			"Include a concise summary and, when possible, requirement-to-evidence audit items.",
		],
		parameters: CompleteSchema as any,
		async execute(_toolCallId: string, params: MissionCompleteInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const userRequested = params.userRequested === true;
			const summary = params.summary ?? (userRequested ? "Mission ended at explicit user request. Use /mission resume to continue if needed." : undefined);
			const audit = params.audit?.length ? params.audit : userRequested ? [{ requirement: "User-requested mission end", evidence: "The user explicitly asked to end/complete the mission; this records closure without claiming all objective requirements are satisfied. Use /mission resume to continue if needed." }] : undefined;
			const event = state.statusEvent("complete", userRequested ? "mission_complete called by explicit user request" : "mission_complete called", summary);
			const mission = state.append(pi, event)!;
			const usage = state.readUsage();
			await writeCompletionAudit(mission, summary, audit, usage);
			await updateMissionSummaryArtifact(mission, usage);
			const verb = userRequested ? "ended" : "complete";
			const resumeHint = userRequested ? "\nResume: /mission resume" : "";
			return { content: [{ type: "text" as const, text: `Mission ${verb}: ${mission.title}\nUsage: ${usage.totalTokens} tokens, $${usage.totalCostUsd.toFixed(4)}\nArtifacts: ${mission.artifactDir}${resumeHint}` }], details: { mission, usage, audit, userRequested } };
		},
	});
}

interface MissionSearchResult {
	path: string;
	line: number;
	score: number;
	snippet: string;
}

async function searchMissions(cwd: string, input: MissionSearchInput): Promise<MissionSearchResult[]> {
	const query = input.query.trim().toLowerCase();
	if (!query) return [];
	const terms = query.split(/\s+/).filter(Boolean);
	const root = missionRoot(cwd);
	const files = await listMarkdownFiles(root).catch(() => []);
	const results: MissionSearchResult[] = [];
	for (const file of files) {
		const text = await readFile(file, "utf8").catch(() => "");
		const lines = text.split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index]!;
			const lower = line.toLowerCase();
			const hits = terms.filter((term) => lower.includes(term)).length;
			if (hits === 0) continue;
			results.push({ path: relative(cwd, file), line: index + 1, score: hits / terms.length, snippet: line.trim().slice(0, 240) });
		}
	}
	return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line).slice(0, Math.max(1, Math.min(25, input.maxResults ?? 8)));
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...await listMarkdownFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
	}
	return files;
}

function formatMissionSearchResults(results: MissionSearchResult[]): string {
	if (results.length === 0) return "No mission matches.";
	return results.map((item, index) => `${index + 1}. ${item.path}:${item.line} score=${item.score.toFixed(2)}\n   ${item.snippet}`).join("\n");
}

export function formatMission(mission: ReturnType<MissionState["readAny"]>, usage: ReturnType<MissionState["readUsage"]>): string {
	if (!mission) return "No active mission on this branch.";
	const budget = [
		mission.tokenBudget ? `${usage.totalTokens}/${mission.tokenBudget} tokens` : `${usage.totalTokens} tokens`,
		mission.costBudgetUsd ? `$${usage.totalCostUsd.toFixed(4)}/$${mission.costBudgetUsd}` : `$${usage.totalCostUsd.toFixed(4)}`,
	].join(", ");
	const requirements = mission.requirements.length
		? [`Requirements:`, ...mission.requirements.map((item) => `- ${item}`)]
		: [];
	return [
		`${mission.missionId} [${mission.status}] ${mission.title}`,
		mission.objective !== mission.title ? `Objective: ${mission.objective}` : undefined,
		...requirements,
		`Budget/usage: ${budget}`,
		`Chain: ${mission.chain}@${mission.chainBranch}`,
		`Artifacts: ${mission.artifactDir}`,
		mission.lastReason ? `Reason: ${mission.lastReason}` : undefined,
	].filter(Boolean).join("\n");
}
