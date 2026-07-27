import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { initializeMissionArtifacts, missionRoot, updateMissionSummaryArtifact, writeCompletionAudit, writeMissionProgressArtifacts } from "./artifacts.ts";
import type { MissionState } from "./state.ts";
import type { MissionCompleteInput, MissionCreateInput, MissionProgressInput, MissionSearchInput, MissionUpdateInput } from "./types.ts";

const CreateSchema = Type.Object({
	objective: Type.String({ description: "Mission objective/user request" }),
	title: Type.Optional(Type.String({ description: "Short mission name" })),
	requirements: Type.Optional(Type.Array(Type.String(), { description: "Success criteria" })),
	paths: Type.Optional(Type.Array(Type.String(), { description: "Explicit project-relative paths owned by the Mission" })),
	tokenBudget: Type.Optional(Type.Number({ description: "Token budget" })),
	costBudgetUsd: Type.Optional(Type.Number({ description: "USD budget" })),
	turnBudget: Type.Optional(Type.Number({ description: "Provider-turn budget" })),
	wallDeadlineMs: Type.Optional(Type.Number({ description: "Wall deadline from creation in milliseconds" })),
	chain: Type.Optional(Type.String({ description: "Chain name" })),
	chainBranch: Type.Optional(Type.String({ description: "Chain branch; default main" })),
});

const GetSchema = Type.Object({});

const ResumeSchema = Type.Object({
	reason: Type.String({ description: "Why the paused or blocked Mission can continue now" }),
});

const ProgressSchema = Type.Object({
	summary: Type.String({ description: "Progress/blocker summary" }),
	evidence: Type.Optional(Type.Array(Type.String(), { description: "Evidence/files/decisions" })),
	remaining: Type.Optional(Type.Array(Type.String(), { description: "Remaining work/blockers" })),
	validation: Type.Optional(Type.Array(Type.Object({
		command: Type.String({ description: "Executed validation command or check identifier" }),
		exitCode: Type.Integer({ description: "Process/check exit code; zero means success" }),
		summary: Type.Optional(Type.String({ description: "Short human-readable result" })),
		artifact: Type.Optional(Type.String({ description: "Optional retained evidence path or id" })),
	}), { description: "Structured validation results" })),
	checkpoint: Type.Optional(Type.Boolean({ description: "Meaningful checkpoint" })),
	blocked: Type.Optional(Type.Boolean({ description: "Current progress ended at a genuine blocker" })),
	blockerId: Type.Optional(Type.String({ description: "Stable language-neutral blocker identifier; required when blocked=true" })),
	reviewSkip: Type.Optional(Type.Boolean({ description: "Typed request to waive otherwise-required independent review" })),
	reviewSkipReason: Type.Optional(Type.String({ description: "Display-only explanation for the review waiver" })),
	reviewVerdict: Type.Optional(Type.Union([Type.Literal("clear"), Type.Literal("changes_requested")], { description: "Parent adjudication of the completed independent review" })),
	reviewRunId: Type.Optional(Type.String({ description: "Exact independent reviewer run being adjudicated" })),
	reviewReason: Type.Optional(Type.String({ description: "Evidence-based adjudication reason" })),
});

const UpdateSchema = Type.Object({
	objective: Type.Optional(Type.String({ description: "Revised Mission objective" })),
	requirements: Type.Optional(Type.Array(Type.String(), { description: "Replacement success criteria" })),
	paths: Type.Optional(Type.Array(Type.String(), { description: "Replacement project-relative review scope" })),
	tokenBudget: Type.Optional(Type.Union([Type.Null(), Type.Number()], { description: "Replacement token budget; null removes the cap" })),
	costBudgetUsd: Type.Optional(Type.Union([Type.Null(), Type.Number()], { description: "Replacement USD budget; null removes the cap" })),
	turnBudget: Type.Optional(Type.Union([Type.Null(), Type.Number()], { description: "Replacement provider-turn budget; null removes the cap" })),
	wallDeadlineMs: Type.Optional(Type.Union([Type.Null(), Type.Number()], { description: "Replacement wall deadline from now in milliseconds; null removes the deadline" })),
	reason: Type.String({ description: "Why the Mission specification changed" }),
});

const SearchSchema = Type.Object({
	query: Type.String({ description: "Search terms" }),
	maxResults: Type.Optional(Type.Number({ description: "Max matches; default 8" })),
});

const AuditItemSchema = Type.Object({
	requirementIndex: Type.Integer({ minimum: 0, description: "Zero-based Mission requirement index" }),
	evidence: Type.String({ description: "Evidence for that requirement" }),
});

const CompleteSchema = Type.Object({
	summary: Type.Optional(Type.String({ description: "Completion summary" })),
	audit: Type.Optional(Type.Array(AuditItemSchema, { description: "Requirement/evidence audit" })),
	userRequested: Type.Optional(Type.Boolean({ description: "User explicitly asked to end" })),
});

export interface MissionCompletionHooks {
	validateCompletion?: (input: MissionCompleteInput, ctx: ExtensionContext, directUserRequest?: boolean) => Promise<string[]> | string[];
	onCompleted?: (ctx: ExtensionContext) => void;
}

interface MissionToolHooks extends MissionCompletionHooks {
	onCreated?: (ctx: ExtensionContext) => void;
	onProgress?: (input: MissionProgressInput, ctx: ExtensionContext) => void;
	onObjectiveUpdated?: (input: MissionUpdateInput, ctx: ExtensionContext) => void;
	onResumed?: (ctx: ExtensionContext) => void;
}

const USER_END_SUMMARY = "Mission ended at explicit user request. Use /mission resume to continue if needed.";
const USER_END_AUDIT = [{ requirementIndex: 0, evidence: "The user explicitly asked to end/complete the mission; this records closure without claiming all objective requirements are satisfied. Use /mission resume to continue if needed." }];

export function registerMissionTools(pi: ExtensionAPI, state: MissionState, setContext: (ctx: ExtensionContext) => void, hooks: MissionToolHooks = {}): void {
	pi.registerTool({
		name: "mission_get",
		label: "Get Mission",
		description: "Get active Mission state, usage, chain, and artifacts.",
		promptSnippet: "Read active Mission.",
		parameters: GetSchema,
		renderCall: (_args: unknown, theme: Theme) => missionCall("get", "", theme),
		renderResult: (result: { details?: unknown }, options: { expanded: boolean }, theme: Theme) => missionResult(result.details, options.expanded, theme),
		async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const mission = state.readAny();
			const usage = state.readUsage();
			return { content: [{ type: "text" as const, text: formatMission(mission, usage) }], details: { mission, usage } };
		},
	});

	pi.registerTool({
		name: "mission_resume",
		label: "Resume Mission",
		description: "Resume a paused or blocked Mission when the user authorizes continuation or resolves its recorded blocker.",
		promptSnippet: "Resume an authorized paused Mission before substantive work.",
		promptGuidelines: [
			"Call before substantive Mission work when the current user explicitly asks to continue/resume or directly resolves the recorded pause/blocker.",
			"Do not resume from unrelated chat, and do not bypass budget or usage limits.",
			"Record the concrete authorization or resolved blocker in reason.",
		],
		parameters: ResumeSchema,
		renderCall: (args: { reason: string }, theme: Theme) => missionCall("resume", args.reason, theme),
		renderResult: (result: { details?: unknown }, options: { expanded: boolean }, theme: Theme) => missionResult(result.details, options.expanded, theme),
		async execute(_toolCallId: string, params: { reason: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			if (!ctx.hasUI) throw new Error("Headless Mission resume requires the trusted /mission resume command.");
			if (!await ctx.ui.confirm("Resume Mission?", `Resume autonomous work because: ${params.reason.trim() || "(no reason)"}`)) throw new Error("Mission resume was not authorized by the user.");
			setContext(ctx);
			state.loadFromSession(ctx);
			const current = state.readAny();
			if (!current) throw new Error("No Mission exists on this branch.");
			if (current.status === "active") return { content: [{ type: "text" as const, text: `Mission already active: ${current.title}` }], details: { mission: current, usage: state.readUsage() } };
			if (!params.reason.trim()) throw new Error("Resuming a Mission requires a reason.");
			const remainingLimit = state.limitExceeded();
			if (remainingLimit) throw new Error(`Mission cannot resume while its ${remainingLimit} limit is exhausted; revise that limit with mission_update first.`);
			if (!["paused", "blocked", "terminal_error", "budget_limited", "usage_limited", "ended"].includes(current.status)) throw new Error(`Mission cannot resume from ${current.status}.`);
			const mission = state.append(pi, state.statusEvent("active", params.reason.trim()))!;
			await updateMissionSummaryArtifact(mission, state.readUsage());
			hooks.onResumed?.(ctx);
			return { content: [{ type: "text" as const, text: `Mission resumed: ${mission.title}\n${formatMissionLocation(mission)}` }], details: { mission, usage: state.readUsage() } };
		},
	});

	pi.registerTool({
		name: "mission_create",
		label: "Create Mission",
		description: "Create a persistent branch-scoped Mission when explicitly requested.",
		promptSnippet: "Create a Mission.",
		promptGuidelines: [
			"Only when the user/system/developer asks for a continuing mission/goal.",
			"Use a short title and requirements for long objectives; ask only if scope is ambiguous.",
			"Set budgets only when requested; chain defaults to a short title-derived name.",
		],
		parameters: CreateSchema,
		renderCall: (args: MissionCreateInput, theme: Theme) => missionCall("create", args.title ?? args.objective, theme),
		renderResult: (result: { details?: unknown }, options: { expanded: boolean }, theme: Theme) => missionResult(result.details, options.expanded, theme),
		async execute(_toolCallId: string, params: MissionCreateInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const event = await state.create(params, ctx);
			const mission = state.append(pi, event)!;
			await initializeMissionArtifacts(mission, state.readUsage());
			hooks.onCreated?.(ctx);
			return { content: [{ type: "text" as const, text: `Mission created: ${mission.title}\n${formatMissionLocation(mission)}` }], details: { mission, usage: state.readUsage() } };
		},
	});

	pi.registerTool({
		name: "mission_progress",
		label: "Mission Progress",
		description: "Record compact progress/evidence/remaining work in searchable Mission logs.",
		promptSnippet: "Record compact Mission progress.",
		promptGuidelines: [
			"Use when durable progress, evidence, validation, remaining work, or blockers change.",
			"Not for every tiny result; prefer over manual artifact edits.",
			"checkpoint=true only for milestones, handoffs, cleanup, or final validation.",
			"Use blocked=true with a stable blockerId for a genuine blocker; runtime never infers blockers from prose.",
		],
		parameters: ProgressSchema,
		renderCall: (args: MissionProgressInput, theme: Theme) => missionCall("progress", args.summary, theme),
		renderResult: (result: { details?: unknown }, options: { expanded: boolean }, theme: Theme) => missionResult(result.details, options.expanded, theme),
		async execute(_toolCallId: string, params: MissionProgressInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			if (params.reviewSkip && !ctx.hasUI) throw new Error("Headless review waiver requires a trusted direct command.");
			if (params.reviewSkip && !await ctx.ui.confirm("Skip Mission review?", `Record this review waiver: ${params.reviewSkipReason?.trim() || "(no explanation)"}`)) throw new Error("Mission review waiver was not authorized by the user.");
			setContext(ctx);
			state.loadFromSession(ctx);
			const currentMission = state.read();
			if (params.reviewSkip && currentMission?.reviewStatus === "running") throw new Error("Cannot skip review while the reviewer is still running; cancel and settle it first.");
			if (params.reviewVerdict) {
				const current = currentMission;
				if (!current || current.reviewStatus !== "awaiting_adjudication" || !params.reviewRunId || params.reviewRunId !== current.reviewRunId) throw new Error("Review adjudication requires the exact awaiting reviewer run id.");
				if (params.reviewVerdict === "clear" && current.reviewSuggestedVerdict !== "clear" && current.reviewSuggestedVerdict !== "changes_requested") throw new Error("Cannot clear a review without a valid structured review_report.");
			}
			const event = state.progressEvent(params);
			let mission = state.append(pi, event)!;
			if (params.reviewSkip) mission = state.append(pi, state.reviewEvent("skipped", { skippedReason: params.reviewSkipReason }))!;
			const usage = state.readUsage();
			await writeMissionProgressArtifacts(mission, state.readProgress(), usage);
			hooks.onProgress?.(params, ctx);
			return { content: [{ type: "text" as const, text: `Mission progress recorded: ${mission.title}\nLog: .missions/${mission.slug}/log.md` }], details: { mission, progress: state.readProgress().at(-1), usage } };
		},
	});

	pi.registerTool({
		name: "mission_update",
		label: "Update Mission",
		description: "Revise the active Mission objective or success criteria with a recorded reason.",
		promptSnippet: "Update an active Mission specification when the user changes scope.",
		parameters: UpdateSchema,
		renderCall: (args: MissionUpdateInput, theme: Theme) => missionCall("update", args.reason, theme),
		renderResult: (result: { details?: unknown }, options: { expanded: boolean }, theme: Theme) => missionResult(result.details, options.expanded, theme),
		async execute(_toolCallId: string, params: MissionUpdateInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const mission = state.append(pi, state.objectiveUpdateEvent(params))!;
			await updateMissionSummaryArtifact(mission, state.readUsage());
			hooks.onObjectiveUpdated?.(params, ctx);
			return { content: [{ type: "text" as const, text: `Mission updated: ${mission.title}\nObjective version: ${mission.objectiveVersion}` }], details: { mission, usage: state.readUsage() } };
		},
	});

	pi.registerTool({
		name: "mission_search",
		label: "Search Missions",
		description: "Search .missions markdown and generated progress logs.",
		promptSnippet: "Search Mission history.",
		promptGuidelines: [
			"Use concise topic queries before repeating work; inspect files only when needed.",
		],
		parameters: SearchSchema,
		renderCall: (args: MissionSearchInput, theme: Theme) => missionCall("search", args.query, theme),
		renderResult: (result: { details?: unknown }, options: { expanded: boolean }, theme: Theme) => missionResult(result.details, options.expanded, theme),
		async execute(_toolCallId: string, params: MissionSearchInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			setContext(ctx);
			const results = await searchMissions(ctx.cwd, params);
			return { content: [{ type: "text" as const, text: formatMissionSearchResults(results) }], details: { results } };
		},
	});

	pi.registerTool({
		name: "mission_complete",
		label: "Complete Mission",
		description: "Complete achieved Mission, or end immediately on explicit user request.",
		promptSnippet: "Complete or user-end Mission.",
		promptGuidelines: [
			"Complete only when objective is achieved and no required work remains.",
			"If user asks to end/complete/stop, call with userRequested=true and note remaining work/resume option.",
			"Never complete merely for budget, pause, or partial progress.",
		],
		parameters: CompleteSchema,
		renderCall: (args: MissionCompleteInput, theme: Theme) => missionCall(args.userRequested ? "end" : "complete", args.summary ?? "", theme),
		renderResult: (result: { details?: unknown }, options: { expanded: boolean }, theme: Theme) => missionResult(result.details, options.expanded, theme, Array.isArray((result.details as { blockers?: unknown } | undefined)?.blockers)),
		async execute(_toolCallId: string, params: MissionCompleteInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			if (params.userRequested && !ctx.hasUI) throw new Error("Headless Mission end requires the trusted /mission end command.");
			if (params.userRequested && !await ctx.ui.confirm("End Mission?", "End this Mission without claiming its remaining requirements are complete?")) throw new Error("Mission end was not authorized by the user.");
			setContext(ctx);
			const result = await completeMission(pi, state, ctx, params, params.userRequested ? "mission_complete called by explicit user request" : "mission_complete called", hooks);
			if (result.alreadyComplete) return { content: [{ type: "text" as const, text: `Mission already complete: ${result.mission!.title}` }], details: result };
			if (result.blockers?.length) return { content: [{ type: "text" as const, text: `Mission completion blocked:\n${result.blockers.map((blocker) => `- ${blocker}`).join("\n")}` }], details: result };
			const verb = result.userRequested ? "ended" : "complete";
			const resumeHint = result.userRequested ? "\nResume: /mission resume" : "";
			return { content: [{ type: "text" as const, text: `Mission ${verb}: ${result.mission!.title}\nUsage: ${result.usage.totalTokens} tokens, $${result.usage.totalCostUsd.toFixed(4)}\n${formatMissionLocation(result.mission!)}${resumeHint}` }], details: result };
		},
	});
}

export async function completeMission(
	pi: ExtensionAPI,
	state: MissionState,
	ctx: ExtensionContext,
	input: MissionCompleteInput,
	reason: string,
	hooks: MissionCompletionHooks = {},
	directUserRequest = false,
) {
	state.loadFromSession(ctx);
	const existing = state.readAny();
	const usage = state.readUsage();
	if (existing?.status === "complete" || existing?.status === "ended") return { mission: existing, usage, alreadyComplete: true, userRequested: input.userRequested === true };
	const blockers = hooks.validateCompletion ? await hooks.validateCompletion(input, ctx, directUserRequest) : [];
	if (blockers.length) return { mission: existing, usage, blockers, userRequested: input.userRequested === true };
	const userRequested = input.userRequested === true;
	const summary = input.summary ?? (userRequested ? USER_END_SUMMARY : undefined);
	const audit = input.audit?.length ? input.audit : userRequested ? USER_END_AUDIT : undefined;
	const mission = state.append(pi, state.statusEvent(userRequested ? "ended" : "complete", reason, summary))!;
	const completedUsage = state.readUsage();
	await writeCompletionAudit(mission, summary, audit, completedUsage, state.readProgress());
	hooks.onCompleted?.(ctx);
	return { mission, usage: completedUsage, audit, userRequested };
}

function missionCall(action: string, target: string, theme: Theme): Text {
	return new Text(theme.fg("toolTitle", theme.bold(`mission ${action} `)) + theme.fg("muted", target.replace(/\s+/g, " ").slice(0, 90)), 0, 0);
}

function missionResult(details: unknown, expanded: boolean, theme: Theme, isError = false): Text {
	const value = details as { mission?: ReturnType<MissionState["readAny"]>; usage?: ReturnType<MissionState["readUsage"]>; blockers?: string[]; results?: unknown[]; alreadyComplete?: boolean } | undefined;
	if (value?.blockers?.length) return new Text(`${theme.fg("error", "completion blocked")} · ${value.blockers.length} blocker(s)${expanded ? `\n${value.blockers.map((blocker) => `- ${blocker}`).join("\n")}` : ""}`, 0, 0);
	if (value?.mission) {
		const mission = value.mission;
		const color = isError ? "error" : mission.status === "complete" ? "success" : mission.status === "active" ? "warning" : "muted";
		let text = `${theme.fg(color, value.alreadyComplete ? "already complete" : mission.status)} ${theme.fg("accent", mission.title)} ${theme.fg("muted", mission.missionId)}`;
		if (mission.reviewStatus && mission.reviewStatus !== "not_required") text += ` · review ${mission.reviewStatus}`;
		if (value.usage) text += ` · ${value.usage.totalTokens} tokens`;
		if (expanded) text += `\n${mission.objective}`;
		return new Text(text, 0, 0);
	}
	if (value?.results) return new Text(`${theme.fg("success", "✓")} ${value.results.length} mission match(es)`, 0, 0);
	return new Text(theme.fg(isError ? "error" : "dim", isError ? "Mission operation failed" : "No active Mission"), 0, 0);
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
