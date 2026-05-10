import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initializeMissionArtifacts, missionRoot, updateMissionSummaryArtifact, writeCompletionAudit, writeMissionProgressArtifacts } from "./artifacts.ts";
import type { MissionState } from "./state.ts";
import type { MissionCompleteInput, MissionCreateInput, MissionProgressInput, MissionSearchInput } from "./types.ts";

const CreateSchema = Type.Object({
	objective: Type.String({ description: "Mission objective/user request" }),
	title: Type.Optional(Type.String({ description: "Short mission name" })),
	requirements: Type.Optional(Type.Array(Type.String(), { description: "Success criteria" })),
	tokenBudget: Type.Optional(Type.Number({ description: "Token budget" })),
	costBudgetUsd: Type.Optional(Type.Number({ description: "USD budget" })),
	chain: Type.Optional(Type.String({ description: "Chain name" })),
	chainBranch: Type.Optional(Type.String({ description: "Chain branch; default main" })),
});

const GetSchema = Type.Object({});

const ProgressSchema = Type.Object({
	summary: Type.String({ description: "Progress/blocker summary" }),
	evidence: Type.Optional(Type.Array(Type.String(), { description: "Evidence/files/decisions" })),
	remaining: Type.Optional(Type.Array(Type.String(), { description: "Remaining work/blockers" })),
	validation: Type.Optional(Type.Array(Type.String(), { description: "Checks run/results" })),
	checkpoint: Type.Optional(Type.Boolean({ description: "Meaningful checkpoint" })),
});

const SearchSchema = Type.Object({
	query: Type.String({ description: "Search terms" }),
	maxResults: Type.Optional(Type.Number({ description: "Max matches; default 8" })),
});

const AuditItemSchema = Type.Object({ 
	requirement: Type.String({ description: "Requirement" }),
	evidence: Type.String({ description: "Evidence" }),
});

const CompleteSchema = Type.Object({
	summary: Type.Optional(Type.String({ description: "Completion summary" })),
	audit: Type.Optional(Type.Array(AuditItemSchema, { description: "Requirement/evidence audit" })),
	userRequested: Type.Optional(Type.Boolean({ description: "User explicitly asked to end" })),
});

export function registerMissionTools(pi: ExtensionAPI, state: MissionState, setContext: (ctx: ExtensionContext) => void): void {
	(pi as any).registerTool({
		name: "mission_get",
		label: "Get Mission",
		description: "Get active Mission state, usage, chain, and artifacts.",
		promptSnippet: "Read active Mission.",
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
		description: "Create a persistent branch-scoped Mission when explicitly requested.",
		promptSnippet: "Create a Mission.",
		promptGuidelines: [
			"Only when the user/system/developer asks for a continuing mission/goal.",
			"Use a short title and requirements for long objectives; ask only if scope is ambiguous.",
			"Set budgets only when requested; chain defaults to a short title-derived name.",
		],
		parameters: CreateSchema as any,
		async execute(_toolCallId: string, params: MissionCreateInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const event = await state.create(params, ctx);
			const mission = state.append(pi, event)!;
			await initializeMissionArtifacts(ctx.cwd, mission, state.readUsage());
			return { content: [{ type: "text" as const, text: `Mission created: ${mission.title}\n${formatMissionLocation(mission)}` }], details: { mission, usage: state.readUsage() } };
		},
	});

	(pi as any).registerTool({
		name: "mission_progress",
		label: "Mission Progress",
		description: "Record compact progress/evidence/remaining work in searchable Mission logs.",
		promptSnippet: "Record compact Mission progress.",
		promptGuidelines: [
			"Use when durable progress, evidence, validation, remaining work, or blockers change.",
			"Not for every tiny result; prefer over manual artifact edits.",
			"checkpoint=true only for milestones, handoffs, cleanup, or final validation.",
		],
		parameters: ProgressSchema as any,
		async execute(_toolCallId: string, params: MissionProgressInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const event = state.progressEvent(params);
			const mission = state.append(pi, event)!;
			const usage = state.readUsage();
			await writeMissionProgressArtifacts(mission, state.readProgress(), usage);
			return { content: [{ type: "text" as const, text: `Mission progress recorded: ${mission.title}\nLog: .missions/${mission.slug}/log.md` }], details: { mission, progress: state.readProgress().at(-1), usage } };
		},
	});

	(pi as any).registerTool({
		name: "mission_search",
		label: "Search Missions",
		description: "Search .missions markdown and generated progress logs.",
		promptSnippet: "Search Mission history.",
		promptGuidelines: [
			"Use concise topic queries before repeating work; inspect files only when needed.",
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
		description: "Complete achieved Mission, or end immediately on explicit user request.",
		promptSnippet: "Complete or user-end Mission.",
		promptGuidelines: [
			"Complete only when objective is achieved and no required work remains.",
			"If user asks to end/complete/stop, call with userRequested=true and note remaining work/resume option.",
			"Never complete merely for budget, pause, or partial progress.",
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
			return { content: [{ type: "text" as const, text: `Mission ${verb}: ${mission.title}\nUsage: ${usage.totalTokens} tokens, $${usage.totalCostUsd.toFixed(4)}\n${formatMissionLocation(mission)}${resumeHint}` }], details: { mission, usage, audit, userRequested } };
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
	const objective = mission.objective !== mission.title ? `Objective: ${compactMissionText(mission.objective, 180)}` : undefined;
	const requirements = formatMissionRequirements(mission.requirements);
	return [
		`${mission.missionId} [${mission.status}] ${mission.title}`,
		objective,
		requirements ? `Req: ${requirements}` : undefined,
		`Usage: ${budget}`,
		formatMissionLocation(mission),
		mission.lastReason ? `Reason: ${compactMissionText(mission.lastReason, 160)}` : undefined,
	].filter(Boolean).join("\n");
}

function formatMissionLocation(mission: NonNullable<ReturnType<MissionState["readAny"]>>): string {
	return `Chain: ${mission.chain}@${mission.chainBranch}\nArtifacts: .missions/${mission.slug}`;
}

function formatMissionRequirements(requirements: string[]): string {
	if (!requirements.length) return "";
	const visible = requirements.slice(0, 6).map((item) => compactMissionText(item, 80));
	const suffix = requirements.length > visible.length ? ` (+${requirements.length - visible.length} more in mission.md)` : "";
	return `${visible.map((item) => `• ${item}`).join(" ")}${suffix}`;
}

function compactMissionText(text: string, max: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
}
