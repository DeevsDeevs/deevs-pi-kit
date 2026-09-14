import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	initializeMissionArtifacts,
	missionRoot,
	updateMissionSummaryArtifact,
	writeCompletionAudit,
	writeMissionProgressArtifacts,
} from "./artifacts.ts";
import type { MissionState } from "./state.ts";
import { discoverMissionTakeoverCandidates, listSnapshotTakeoverCandidates, selectMissionTakeoverCandidate } from "./takeover.ts";
import type {
	MissionCompleteInput,
	MissionCreateInput,
	MissionCurrent,
	MissionProgressInput,
	MissionSearchInput,
	MissionTakeoverCandidate,
	MissionTakeoverInput,
	MissionUpdateInput,
	MissionUsage,
} from "./types.ts";

const CreateSchema = Type.Object({
	objective: Type.String({ description: "Mission objective/user request" }),
	title: Type.Optional(Type.String({ description: "Short mission name" })),
	requirements: Type.Optional(Type.Array(Type.String(), { maxItems: 12, description: "Success criteria" })),
	paths: Type.Optional(Type.Array(Type.String(), {
		maxItems: 100,
		description: "Explicit cwd-relative paths owned by the Mission; required to select repositories when cwd is not"
			+ " itself a Git repository",
	})),
	tokenBudget: Type.Optional(Type.Integer({ minimum: 1, description: "Token budget" })),
	costBudgetUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "USD budget" })),
	turnBudget: Type.Optional(Type.Integer({ minimum: 1, description: "Provider-turn budget" })),
	wallDeadlineMs: Type.Optional(Type.Integer({ minimum: 1, description: "Wall deadline from creation in milliseconds" })),
	chain: Type.Optional(Type.String({ description: "Chain name" })),
	chainBranch: Type.Optional(Type.String({ description: "Chain branch; default main" })),
});

const GetSchema = Type.Object({});

const ResumeSchema = Type.Object({
	reason: Type.String({ description: "Why the paused or blocked Mission can continue now" }),
});

const TakeoverSchema = Type.Object({
	missionId: Type.String({ description: "Exact Mission id or artifact slug to take over" }),
	reason: Type.String({ description: "Why the previous session can no longer control this Mission" }),
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
	reviewVerdict: Type.Optional(Type.Union([Type.Literal("clear"), Type.Literal("changes_requested")], {
		description: "Parent adjudication of the completed independent review",
	})),
	reviewRunId: Type.Optional(Type.String({ description: "Exact independent reviewer run being adjudicated" })),
	reviewReason: Type.Optional(Type.String({ description: "Evidence-based adjudication reason" })),
	reviewContinue: Type.Optional(Type.Boolean({ description: "Trusted request to extend the bounded review correction limit" })),
	reviewContinueReason: Type.Optional(Type.String({ description: "Why additional correction cycles are authorized" })),
});

const UpdateSchema = Type.Object({
	objective: Type.Optional(Type.String({ description: "Revised Mission objective" })),
	requirements: Type.Optional(Type.Array(Type.String(), { maxItems: 12, description: "Replacement success criteria" })),
	paths: Type.Optional(Type.Array(Type.String(), {
		maxItems: 100,
		description: "Replacement cwd-relative review scope and Git repository selection",
	})),
	tokenBudget: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 1 })], {
		description: "Replacement token budget; null removes the cap",
	})),
	costBudgetUsd: Type.Optional(Type.Union([Type.Null(), Type.Number({ exclusiveMinimum: 0 })], {
		description: "Replacement USD budget; null removes the cap",
	})),
	turnBudget: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 1 })], {
		description: "Replacement provider-turn budget; null removes the cap",
	})),
	wallDeadlineMs: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 1 })], {
		description: "Replacement wall deadline from now in milliseconds; null removes the deadline",
	})),
	reason: Type.String({ description: "Why the Mission specification changed" }),
});

const SearchSchema = Type.Object({
	query: Type.String({ description: "Search terms" }),
	maxResults: Type.Optional(Type.Number({ description: "Max matches; default 8" })),
});

const AuditItemSchema = Type.Object({
	requirementIndex: Type.Integer({ minimum: 0, description: "Zero-based Mission requirement index" }),
	evidence: Type.String({ minLength: 1, description: "Evidence for that requirement" }),
});

const CompleteSchema = Type.Object({
	summary: Type.Optional(Type.String({ description: "Completion summary" })),
	audit: Type.Optional(Type.Array(AuditItemSchema, { description: "Requirement/evidence audit" })),
	userRequested: Type.Optional(Type.Boolean({ description: "User explicitly asked to end" })),
	authorizeCompletion: Type.Optional(Type.Boolean({
		description: "Request trusted user authorization to complete the exact current candidate",
	})),
});

export interface MissionRequirementAudit {
	requirementIndex: number;
	evidence: string;
}

interface MissionCompletionResult {
	mission?: MissionCurrent;
	usage: MissionUsage;
	userRequested: boolean;
	blockers?: string[];
	alreadyComplete?: boolean;
	audit?: MissionRequirementAudit[];
}

export interface MissionCompletionHooks {
	validateCompletion?: (input: MissionCompleteInput, ctx: ExtensionContext, directUserRequest?: boolean) => Promise<string[]> | string[];
	authorizeCompletion?: (ctx: ExtensionContext) => Promise<string>;
	completionCandidateId?: (ctx: ExtensionContext) => Promise<string | undefined>;
	onCompleted?: (ctx: ExtensionContext, mission: MissionCurrent, completionId?: string) => Promise<void> | void;
}

interface MissionToolHooks extends MissionCompletionHooks {
	onCreated?: (ctx: ExtensionContext) => void | Promise<void>;
	onTakenOver?: (ctx: ExtensionContext, mission: MissionCurrent) => void;
	discoverTakeoverCandidates?: (ctx: ExtensionContext) => Promise<MissionTakeoverCandidate[]>;
	onProgress?: (input: MissionProgressInput, ctx: ExtensionContext) => void;
	workspaceFingerprint?: (ctx: ExtensionContext) => Promise<string | undefined>;
	authorizeReviewContinuation?: (ctx: ExtensionContext) => void;
	onObjectiveUpdated?: (input: MissionUpdateInput, ctx: ExtensionContext) => void;
	onResumed?: (ctx: ExtensionContext) => void;
	continuationBlockers?: (ctx: ExtensionContext) => string[];
}

const USER_END_SUMMARY = "Mission ended at explicit user request. Use /mission resume to continue if needed.";
const completionEffectsInFlight = new Map<string, Promise<void>>();

/** Display-only projection shared by missionResult; execute results may carry additional typed fields. */
interface MissionResultDetails {
	mission?: ReturnType<MissionState["readAny"]>;
	usage?: ReturnType<MissionState["readUsage"]>;
	blockers?: string[];
	results?: MissionSearchResult[];
	alreadyComplete?: boolean;
}

type SetMissionContext = (ctx: ExtensionContext) => void;

interface MissionToolResult {
	details?: MissionResultDetails;
}

interface MissionRenderOptions {
	expanded: boolean;
}

function renderMissionResult(result: MissionToolResult, options: MissionRenderOptions, theme: Theme): Text {
	return missionResult(result.details, options.expanded, theme);
}

/** The `mission_update` flag that raises the exhausted limit, for the headless resume hint. */
function limitUpdateFlag(limit: "token" | "cost" | "turn" | "wall"): string {
	if (limit === "token") return "budget";
	if (limit === "cost") return "cost";
	return limit === "turn" ? "turns" : "deadline";
}

export async function resumeMission(pi: ExtensionAPI, state: MissionState, reason: string): Promise<MissionCurrent> {
	const explanation = reason.trim();
	if (!explanation) throw new Error("Resuming a Mission requires a reason.");
	const current = state.readAny();
	if (!current) throw new Error("No Mission exists on this branch.");
	if (correctionLimitBlocked(current)) {
		throw new Error("Mission cannot resume past the review correction limit; use trusted mission_progress reviewContinue "
			+ "authorization first.");
	}
	const remainingLimit = state.limitExceeded();
	if (remainingLimit) {
		throw new Error(`Mission cannot resume while its ${remainingLimit} limit is exhausted; raise it with mission_update`
			+ ` (or "/mission update --${limitUpdateFlag(remainingLimit)} ..." when headless) first.`);
	}
	if (current.status === "active") return current;
	if (!["paused", "blocked", "terminal_error", "budget_limited", "usage_limited", "ended"].includes(current.status)) {
		throw new Error(`Mission cannot resume from ${current.status}.`);
	}
	const mission = state.append(pi, state.statusEvent("active", explanation));
	if (!mission) throw new Error("Mission resume lost canonical state.");
	await updateMissionSummaryArtifact(mission, state.readUsage());
	return mission;
}

export async function updateMission(
	pi: ExtensionAPI,
	state: MissionState,
	ctx: ExtensionContext,
	params: MissionUpdateInput,
	hooks: Pick<MissionToolHooks, "onObjectiveUpdated"> = {},
): Promise<MissionCurrent> {
	state.loadFromSession(ctx);
	state.append(pi, state.objectiveUpdateEvent(params));
	hooks.onObjectiveUpdated?.(params, ctx);
	const mission = state.readAny();
	if (!mission) throw new Error("Mission update lost canonical state.");
	await updateMissionSummaryArtifact(mission, state.readUsage());
	return mission;
}

export async function takeoverMission(
	pi: ExtensionAPI,
	state: MissionState,
	ctx: ExtensionContext,
	input: MissionTakeoverInput,
	hooks: Pick<MissionToolHooks, "onTakenOver" | "discoverTakeoverCandidates"> = {},
	directUserRequest = false,
): Promise<MissionCurrent> {
	state.loadFromSession(ctx);
	const existingMission = state.readAny();
	if (existingMission) throw new Error(`This session already controls Mission ${existingMission.missionId}.`);
	const reason = input.reason.trim();
	if (!reason) throw new Error("Mission takeover requires a reason.");
	const discover = hooks.discoverTakeoverCandidates ?? discoverMissionTakeoverCandidates;
	const candidates = await discover(ctx);
	const candidate = selectMissionTakeoverCandidate(candidates, input.missionId);
	const source = candidate.snapshot;
	if (!directUserRequest && !ctx.hasUI) throw new Error("Headless Mission takeover requires the trusted /mission takeover command.");
	const warning = [
		`${source.mission.title} (${source.mission.missionId})`,
		`Previous controller: ${source.owner.sessionId}`,
		"Takeover resumes autonomy immediately when limits permit, invalidates prior review admission, and does not stop the "
			+ "old Pi process or its children. Confirm only after the old session is stopped.",
	].join("\n");
	if (!directUserRequest && !await ctx.ui.confirm("Take over Mission?", warning)) {
		throw new Error("Mission takeover was not authorized by the user.");
	}
	const refreshed = selectMissionTakeoverCandidate(await discover(ctx), source.mission.missionId);
	const ownershipChanged = refreshed.snapshot.owner.sessionId !== source.owner.sessionId
		|| refreshed.snapshot.owner.sessionFile !== source.owner.sessionFile
		|| refreshed.snapshot.revision !== source.revision
		|| refreshed.snapshot.mission.generation !== source.mission.generation;
	if (ownershipChanged) {
		throw new Error("Mission ownership changed after confirmation;"
			+ " inspect the new controller and confirm takeover again.");
	}
	const bounded = refreshed.snapshot.mission.tokenBudget !== undefined
		|| refreshed.snapshot.mission.costBudgetUsd !== undefined
		|| refreshed.snapshot.mission.turnBudget !== undefined;
	if (!refreshed.snapshot.usageComplete && bounded) {
		throw new Error("Cannot safely take over a bounded Mission without its exact source session usage;"
			+ " resume the source session or recover its session file first.");
	}
	const mission = state.takeover(pi, refreshed, ctx, reason);
	try { hooks.onTakenOver?.(ctx, mission); }
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (ctx.hasUI) ctx.ui.notify(`Mission control transferred, but runtime activation reported: ${message}`, "warning");
	}
	try { await writeMissionProgressArtifacts(mission, state.readProgress(), state.readUsage()); }
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (ctx.hasUI) ctx.ui.notify(`Mission control transferred, but generated artifacts could not be refreshed: ${message}`, "warning");
	}
	return mission;
}

const USER_END_AUDIT: MissionRequirementAudit[] = [{
	requirementIndex: 0,
	evidence: "The user explicitly asked to end/complete the mission; this records closure without claiming all objective "
		+ "requirements are satisfied. Use /mission resume to continue if needed.",
}];

export function registerMissionTools(
	pi: ExtensionAPI,
	state: MissionState,
	setContext: SetMissionContext,
	hooks: MissionToolHooks = {},
): void {
	const tools = [
		createGetTool(state, setContext),
		createTakeoverTool(pi, state, setContext, hooks),
		createResumeTool(pi, state, setContext, hooks),
		createCreateTool(pi, state, setContext, hooks),
		createProgressTool(pi, state, setContext, hooks),
		createUpdateTool(pi, state, setContext, hooks),
		createSearchTool(setContext),
		createCompleteTool(pi, state, setContext, hooks),
	];
	for (const tool of tools) pi.registerTool(tool);
}

function createGetTool(state: MissionState, setContext: SetMissionContext): ToolDefinition {
	return defineTool({
		name: "mission_get",
		label: "Get Mission",
		description: "Get active Mission state, usage, chain, and artifacts.",
		promptSnippet: "Read active Mission.",
		parameters: GetSchema,
		renderCall: (_args, theme: Theme) => missionCall("get", "", theme),
		renderResult: renderMissionResult,
		async execute(_toolCallId: string, _params, _signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const mission = state.readAny();
			const usage = state.readUsage();
			const candidates = mission ? [] : listSnapshotTakeoverCandidates(ctx);
			const names = candidates.map((candidate) => {
				const snapshot = candidate.snapshot.mission;
				return `${snapshot.missionId} (${snapshot.title})`;
			});
			const takeover = names.length ? `\nTakeover available: ${names.join(", ")}` : "";
			const error = state.readPersistenceError();
			const text = `${formatMission(mission, usage)}${takeover}${error ? `\nState error: ${error}` : ""}`;
			const takeoverCandidates = candidates.map((candidate) => ({
				mission: candidate.snapshot.mission,
				owner: candidate.snapshot.owner,
				source: candidate.source,
			}));
			return {
				content: [{ type: "text" as const, text }],
				details: { mission, usage, takeoverCandidates, persistenceError: error },
			};
		},
	});
}

function createTakeoverTool(
	pi: ExtensionAPI,
	state: MissionState,
	setContext: SetMissionContext,
	hooks: MissionToolHooks,
): ToolDefinition {
	return defineTool({
		name: "mission_takeover",
		label: "Take Over Mission",
		description: "Take control of a Mission whose previous Pi session is stopped or broken, then resume it immediately when limits permit.",
		promptSnippet: "Take over a stopped session's Mission after explicit user confirmation.",
		promptGuidelines: [
			"Call mission_takeover only when the user explicitly asks to continue a Mission from another stopped or broken Pi session.",
			"Mission takeover resumes autonomy immediately when limits permit, preserves an unchanged exact adjudicated candidate "
				+ "and completion latch, recovers unresolved or changed review state, and never stops the old process; confirm that "
				+ "the old session is no longer working first.",
			"Use the exact Mission id reported by mission_get or mission_search and record the concrete takeover reason.",
		],
		parameters: TakeoverSchema,
		renderCall: (args: MissionTakeoverInput, theme: Theme) => missionCall("takeover", args.missionId, theme),
		renderResult: renderMissionResult,
		async execute(_toolCallId: string, params: MissionTakeoverInput, _signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
			setContext(ctx);
			const mission = await takeoverMission(pi, state, ctx, params, hooks);
			const outcome = mission.status === "active" ? "taken over and resumed" : `taken over in ${mission.status} state`;
			const text = `Mission ${outcome}: ${mission.title}\n${formatMissionLocation(mission)}`;
			return { content: [{ type: "text" as const, text }], details: { mission, usage: state.readUsage() } };
		},
	});
}

/** Throws unless this session may resume the current Mission with the recorded reason. */
function assertResumable(state: MissionState, current: MissionCurrent, explanation: string, hasUI: boolean): void {
	if (!explanation) throw new Error("Resuming a Mission requires a reason.");
	if (correctionLimitBlocked(current)) {
		throw new Error("Mission cannot resume past the review correction limit; use trusted mission_progress reviewContinue "
			+ "authorization first.");
	}
	const remainingLimit = state.limitExceeded();
	if (remainingLimit) {
		throw new Error(`Mission cannot resume while its ${remainingLimit} limit is exhausted;`
			+ " revise that limit with mission_update first.");
	}
	if (!["paused", "blocked", "terminal_error", "budget_limited", "usage_limited", "ended"].includes(current.status)) {
		throw new Error(`Mission cannot resume from ${current.status}.`);
	}
	if (!hasUI) throw new Error("Headless Mission resume requires the trusted /mission resume command.");
}

function createResumeTool(
	pi: ExtensionAPI,
	state: MissionState,
	setContext: SetMissionContext,
	hooks: MissionToolHooks,
): ToolDefinition {
	return defineTool({
		name: "mission_resume",
		label: "Resume Mission",
		description: "Resume a paused or blocked Mission when the user authorizes continuation or resolves its recorded blocker.",
		promptSnippet: "Resume an authorized paused Mission before substantive work.",
		promptGuidelines: [
			"Call before substantive Mission work when the current user explicitly asks to continue/resume or directly resolves "
				+ "the recorded pause/blocker.",
			"Do not resume from unrelated chat, and do not bypass budget or usage limits.",
			"Record the concrete authorization or resolved blocker in reason.",
		],
		parameters: ResumeSchema,
		renderCall: (args: { reason: string }, theme: Theme) => missionCall("resume", args.reason, theme),
		renderResult: renderMissionResult,
		async execute(_toolCallId: string, params: { reason: string }, _signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const current = state.readAny();
			if (!current) throw new Error("No Mission exists on this branch.");
			if (current.status === "active") {
				const blockers = hooks.continuationBlockers?.(ctx) ?? [];
				const text = `Mission already active: ${current.title}${formatContinuation(blockers)}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { mission: current, usage: state.readUsage(), continuationBlockers: blockers },
				};
			}
			const explanation = params.reason.trim();
			assertResumable(state, current, explanation, ctx.hasUI);
			const question = `Resume autonomous work because: ${explanation}`;
			if (!await ctx.ui.confirm("Resume Mission?", question)) {
				throw new Error("Mission resume was not authorized by the user.");
			}
			const mission = await resumeMission(pi, state, explanation);
			hooks.onResumed?.(ctx);
			const blockers = hooks.continuationBlockers?.(ctx) ?? [];
			const location = `${formatMissionLocation(mission)}${formatContinuation(blockers)}`;
			return {
				content: [{ type: "text" as const, text: `Mission resumed: ${mission.title}\n${location}` }],
				details: { mission, usage: state.readUsage(), continuationBlockers: blockers },
			};
		},
	});
}

function createCreateTool(
	pi: ExtensionAPI,
	state: MissionState,
	setContext: SetMissionContext,
	hooks: MissionToolHooks,
): ToolDefinition {
	return defineTool({
		name: "mission_create",
		label: "Create Mission",
		description: "Create a persistent single-controller workspace Mission when explicitly requested.",
		promptSnippet: "Create a Mission.",
		promptGuidelines: [
			"Only when the user/system/developer asks for a continuing mission/goal.",
			"Use a short title and requirements for long objectives; ask only if scope is ambiguous.",
			"Set budgets only when requested; chain defaults to a short title-derived name.",
		],
		parameters: CreateSchema,
		renderCall: (args: MissionCreateInput, theme: Theme) => missionCall("create", args.title ?? args.objective, theme),
		renderResult: renderMissionResult,
		async execute(_toolCallId: string, params: MissionCreateInput, _signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			if (!state.readAny()) {
				const takeoverCandidates = listSnapshotTakeoverCandidates(ctx);
				if (takeoverCandidates.length) {
					const ids = takeoverCandidates.map((candidate) => candidate.snapshot.mission.missionId).join(", ");
					throw new Error(`A Mission already exists in another session: ${ids}.`
						+ " Take it over instead of creating a replacement.");
				}
			}
			if (!ctx.sessionManager.getSessionFile() || !ctx.sessionManager.getSessionId()) {
				throw new Error("Mission creation requires a persisted Pi session owner.");
			}
			const event = await state.create(params, ctx);
			state.append(pi, event);
			await hooks.onCreated?.(ctx);
			const mission = state.readAny();
			if (!mission) throw new Error("Mission creation lost canonical state.");
			try { await initializeMissionArtifacts(mission, state.readUsage()); }
			catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) {
					ctx.ui.notify(`Mission created, but generated artifacts could not be initialized: ${message}`, "warning");
				}
			}
			const text = `Mission created: ${mission.title}\n${formatMissionLocation(mission)}`;
			return { content: [{ type: "text" as const, text }], details: { mission, usage: state.readUsage() } };
		},
	});
}

function assertProgressReviewControlsValid(params: MissionProgressInput, currentMission: MissionCurrent | undefined): void {
	if (params.reviewSkip && params.reviewVerdict) throw new Error("Review waiver and adjudication are mutually exclusive.");
	if (!params.reviewVerdict && (params.reviewRunId || params.reviewReason)) {
		throw new Error("reviewRunId and reviewReason require reviewVerdict.");
	}
	if (params.reviewSkip && !params.reviewSkipReason?.trim()) throw new Error("Review waiver requires a non-empty reviewSkipReason.");
	if (params.reviewContinue !== true && params.reviewContinueReason) throw new Error("reviewContinueReason requires reviewContinue=true.");
	if (params.reviewContinue && (params.reviewSkip || params.reviewVerdict)) {
		throw new Error("Review continuation authorization cannot be combined with waiver or adjudication.");
	}
	if (params.reviewContinue && !params.reviewContinueReason?.trim()) throw new Error("Review continuation authorization requires a reason.");
	const correctionBlocked = currentMission !== undefined && correctionLimitBlocked(currentMission);
	if (params.reviewContinue && !correctionBlocked) {
		throw new Error("Mission is not blocked on the review correction limit.");
	}
	const reviewerActive = currentMission?.review.admission.status === "starting"
		|| currentMission?.review.admission.status === "running";
	if (params.reviewSkip && reviewerActive) {
		throw new Error("Cannot skip review while reviewer admission/execution is active; settle it first.");
	}
	if (params.reviewVerdict) assertReviewAdjudicationValid(params, currentMission);
}

function assertReviewAdjudicationValid(params: MissionProgressInput, current: MissionCurrent | undefined): void {
	const awaiting = current?.review.admission.status === "awaiting_adjudication"
		&& Boolean(params.reviewRunId)
		&& params.reviewRunId === current.review.admission.runId;
	if (!awaiting) throw new Error("Review adjudication requires the exact awaiting reviewer run id.");
	if (!params.reviewReason?.trim()) throw new Error("Review adjudication requires an evidence-based reason.");
	if (params.reviewVerdict !== current.review.adjudication.suggestedVerdict) {
		const suggested = current.review.adjudication.suggestedVerdict ?? "unknown";
		throw new Error(`Adjudication must match the severity-derived reviewer verdict: ${suggested}.`);
	}
}

async function authorizeProgressReviewControls(params: MissionProgressInput, ctx: ExtensionContext): Promise<void> {
	if (params.reviewContinue && !ctx.hasUI) {
		throw new Error("Headless sessions cannot authorize additional review correction cycles; use the trusted Mission command "
			+ "in an interactive session.");
	}
	if (params.reviewContinue) {
		const question = `Authorize one additional correction cycle? ${params.reviewContinueReason?.trim()}`;
		if (!await ctx.ui.confirm("Continue Mission review corrections?", question)) {
			throw new Error("An additional review correction cycle was not authorized by the user.");
		}
	}
	if (params.reviewSkip && !ctx.hasUI) {
		throw new Error("Headless sessions cannot waive independent review. Let the reviewer subagent run and adjudicate its "
			+ "result with reviewVerdict, or end the Mission with /mission end.");
	}
	if (params.reviewSkip) {
		const question = `Record this review waiver: ${params.reviewSkipReason?.trim()}`;
		if (!await ctx.ui.confirm("Skip Mission review?", question)) {
			throw new Error("Mission review waiver was not authorized by the user.");
		}
	}
}

function createProgressTool(
	pi: ExtensionAPI,
	state: MissionState,
	setContext: SetMissionContext,
	hooks: MissionToolHooks,
): ToolDefinition {
	return defineTool({
		name: "mission_progress",
		label: "Mission Progress",
		description: "Record compact progress/evidence/remaining work in searchable Mission logs.",
		promptSnippet: "Record compact Mission progress.",
		promptGuidelines: [
			"Use when durable progress, evidence, validation, remaining work, or blockers change.",
			"Not for every tiny result; prefer over manual artifact edits.",
			"checkpoint=true only for milestones, handoffs, cleanup, or final validation.",
			"Use blocked=true with a stable blockerId for a genuine blocker; runtime never infers blockers from prose.",
			"Use reviewContinue=true only after the user explicitly authorizes one additional correction cycle at the typed limit.",
		],
		parameters: ProgressSchema,
		renderCall: (args: MissionProgressInput, theme: Theme) => missionCall("progress", args.summary, theme),
		renderResult: renderMissionResult,
		async execute(_toolCallId: string, params: MissionProgressInput, _signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			assertProgressReviewControlsValid(params, state.read());
			await authorizeProgressReviewControls(params, ctx);
			const waiverFingerprint = params.reviewSkip ? await hooks.workspaceFingerprint?.(ctx) : undefined;
			if (params.reviewSkip && !waiverFingerprint) throw new Error("Mission review waiver could not fingerprint the typed workspace.");
			const event = state.progressEvent(params);
			let mission = state.append(pi, event);
			if (!mission) throw new Error("Mission progress lost canonical state.");
			if (params.reviewContinue) {
				hooks.authorizeReviewContinuation?.(ctx);
				mission = state.readAny() ?? mission;
			}
			if (params.reviewSkip) {
				const waiver = state.reviewEvent("skipped", {
					skippedReason: params.reviewSkipReason,
					worktreeFingerprint: waiverFingerprint,
				});
				mission = state.append(pi, waiver) ?? mission;
			}
			hooks.onProgress?.(params, ctx);
			mission = state.readAny() ?? mission;
			const usage = state.readUsage();
			await writeMissionProgressArtifacts(mission, state.readProgress(), usage);
			const text = `Mission progress recorded: ${mission.title}\nLog: .missions/${mission.slug}/log.md`;
			const progress = state.readProgress().at(-1);
			return { content: [{ type: "text" as const, text }], details: { mission, progress, usage } };
		},
	});
}

function createUpdateTool(
	pi: ExtensionAPI,
	state: MissionState,
	setContext: SetMissionContext,
	hooks: MissionToolHooks,
): ToolDefinition {
	return defineTool({
		name: "mission_update",
		label: "Update Mission",
		description: "Revise the active Mission objective or success criteria with a recorded reason.",
		promptSnippet: "Update an active Mission specification when the user changes scope.",
		parameters: UpdateSchema,
		renderCall: (args: MissionUpdateInput, theme: Theme) => missionCall("update", args.reason, theme),
		renderResult: renderMissionResult,
		async execute(_toolCallId: string, params: MissionUpdateInput, _signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
			setContext(ctx);
			state.loadFromSession(ctx);
			state.objectiveUpdateEvent(params); // validate before prompting
			if (!ctx.hasUI) throw new Error("Headless Mission updates require the trusted /mission update command.");
			const changed = [
				params.objective !== undefined && "objective",
				params.requirements !== undefined && "requirements",
				params.paths !== undefined && "paths",
				params.tokenBudget !== undefined && "token budget",
				params.costBudgetUsd !== undefined && "cost budget",
				params.turnBudget !== undefined && "turn budget",
				params.wallDeadlineMs !== undefined && "wall deadline",
			];
			const fields = changed.filter(Boolean).join(", ") || "objective version";
			const summary = `Change ${fields}. Reason: ${params.reason.trim()}`;
			if (!await ctx.ui.confirm("Update Mission control?", summary)) {
				throw new Error("Mission update was not authorized by the user.");
			}
			const mission = await updateMission(pi, state, ctx, params, hooks);
			const text = `Mission updated: ${mission.title}\nObjective version: ${mission.objectiveVersion}`;
			return { content: [{ type: "text" as const, text }], details: { mission, usage: state.readUsage() } };
		},
	});
}

function createSearchTool(setContext: SetMissionContext): ToolDefinition {
	return defineTool({
		name: "mission_search",
		label: "Search Missions",
		description: "Search .missions markdown and generated progress logs.",
		promptSnippet: "Search Mission history.",
		promptGuidelines: [
			"Use concise topic queries before repeating work; inspect files only when needed.",
		],
		parameters: SearchSchema,
		renderCall: (args: MissionSearchInput, theme: Theme) => missionCall("search", args.query, theme),
		renderResult: renderMissionResult,
		async execute(_toolCallId: string, params: MissionSearchInput, _signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
			setContext(ctx);
			const results = await searchMissions(ctx.cwd, params);
			return { content: [{ type: "text" as const, text: formatMissionSearchResults(results) }], details: { results } };
		},
	});
}

async function authorizeCompleteToolRequest(params: MissionCompleteInput, ctx: ExtensionContext): Promise<void> {
	if (params.userRequested && params.authorizeCompletion) {
		throw new Error("Mission end and completion authorization are mutually exclusive.");
	}
	if (params.userRequested && !ctx.hasUI) throw new Error("Headless Mission end requires the trusted /mission end command.");
	if (params.userRequested) {
		const question = "End this Mission without claiming its remaining requirements are complete?";
		if (!await ctx.ui.confirm("End Mission?", question)) throw new Error("Mission end was not authorized by the user.");
	}
	if (params.authorizeCompletion && !ctx.hasUI) {
		throw new Error("Headless Mission completion authorization requires the trusted /mission complete command.");
	}
	if (params.authorizeCompletion) {
		const question = "Latch completion to the exact current objective, scope, and workspace fingerprint?";
		if (!await ctx.ui.confirm("Authorize Mission completion?", question)) {
			throw new Error("Mission completion was not authorized by the user.");
		}
	}
}

function createCompleteTool(
	pi: ExtensionAPI,
	state: MissionState,
	setContext: SetMissionContext,
	hooks: MissionToolHooks,
): ToolDefinition {
	return defineTool({
		name: "mission_complete",
		label: "Complete Mission",
		description: "Authorize and complete the exact converged Mission candidate, or end immediately on explicit user request.",
		promptSnippet: "Complete or user-end Mission.",
		promptGuidelines: [
			"Complete only when objective is achieved and no required work remains; use authorizeCompletion=true to request the "
				+ "final trusted candidate latch.",
			"If the user asks to complete or finish an achieved Mission, use authorizeCompletion=true; if the user explicitly asks "
				+ "to end, stop, or abandon it regardless of achievement, use userRequested=true and note remaining work/resume options.",
			"Never complete merely for budget, pause, or partial progress.",
		],
		parameters: CompleteSchema,
		renderCall: (args: MissionCompleteInput, theme: Theme) => missionCall(args.userRequested ? "end" : "complete", args.summary ?? "", theme),
		renderResult: (result: MissionToolResult, options: MissionRenderOptions, theme: Theme) =>
			missionResult(result.details, options.expanded, theme, Boolean(result.details?.blockers?.length)),
		async execute(_toolCallId: string, params: MissionCompleteInput, _signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
			await authorizeCompleteToolRequest(params, ctx);
			setContext(ctx);
			const reason = params.userRequested ? "mission_complete called by explicit user request" : "mission_complete called";
			const result = await completeMission(pi, state, ctx, params, reason, hooks);
			if (result.blockers?.length) {
				const text = `Mission completion blocked:\n${result.blockers.map((blocker) => `- ${blocker}`).join("\n")}`;
				return { content: [{ type: "text" as const, text }], details: result };
			}
			if (!result.mission) throw new Error("Mission completion lost canonical state.");
			if (result.alreadyComplete) {
				const text = `Mission already complete: ${result.mission.title}`;
				return { content: [{ type: "text" as const, text }], details: result };
			}
			const verb = result.userRequested ? "ended" : "complete";
			const resumeHint = result.userRequested ? "\nResume: /mission resume" : "";
			const usageLine = `Usage: ${result.usage.totalTokens} tokens, $${result.usage.totalCostUsd.toFixed(4)}`;
			const location = `${formatMissionLocation(result.mission)}${resumeHint}`;
			return {
				content: [{ type: "text" as const, text: `Mission ${verb}: ${result.mission.title}\n${usageLine}\n${location}` }],
				details: result,
			};
		},
	});
}

/** One completion attempt's already-validated inputs, threaded to the terminal commit. */
interface MissionCompletionAttempt {
	input: MissionCompleteInput;
	reason: string;
	summary?: string;
	audit?: MissionRequirementAudit[];
	existing?: MissionCurrent;
	usage: MissionUsage;
	directUserRequest: boolean;
}

interface MissionCommitOutcome {
	mission?: MissionCurrent;
	result?: MissionCompletionResult;
}

/** Revalidates the exact candidate, then commits the terminal completion event or reports why it cannot. */
async function commitCompletion(
	pi: ExtensionAPI,
	state: MissionState,
	ctx: ExtensionContext,
	attempt: MissionCompletionAttempt,
	hooks: MissionCompletionHooks,
): Promise<MissionCommitOutcome> {
	const { input, directUserRequest } = attempt;
	const candidateId = await hooks.completionCandidateId?.(ctx);
	if (!candidateId) {
		const blockers = ["Mission completion candidate could not be revalidated before terminal commit."];
		return { result: { mission: attempt.existing, usage: attempt.usage, blockers, userRequested: false } };
	}
	const finalBlockers = hooks.validateCompletion ? await hooks.validateCompletion(input, ctx, directUserRequest) : [];
	const finalCandidateId = await hooks.completionCandidateId?.(ctx);
	if (finalBlockers.length || finalCandidateId !== candidateId) {
		const changed = finalCandidateId === candidateId
			? []
			: ["Mission completion candidate changed during final gate validation."];
		const blockers = [...finalBlockers, ...changed];
		return { result: { mission: state.readAny(), usage: state.readUsage(), blockers, userRequested: false } };
	}
	state.loadFromSession(ctx);
	try {
		const completionId = `completion_${randomUUID()}`;
		const event = state.completionEvent(candidateId, completionId, attempt.audit, attempt.reason, attempt.summary);
		return { mission: state.append(pi, event) };
	} catch (error) {
		state.loadFromSession(ctx);
		const raced = state.readAny();
		if (raced?.status !== "complete") throw error;
		if (hasPendingCompletionEffects(raced)) {
			await settleCompletionEffects(pi, state, ctx, raced, hooks);
		}
		return { result: { mission: state.readAny(), usage: state.readUsage(), alreadyComplete: true, userRequested: false } };
	}
}

export async function completeMission(
	pi: ExtensionAPI,
	state: MissionState,
	ctx: ExtensionContext,
	input: MissionCompleteInput,
	reason: string,
	hooks: MissionCompletionHooks = {},
	directUserRequest = false,
): Promise<MissionCompletionResult> {
	state.loadFromSession(ctx);
	let existing = state.readAny();
	let usage = state.readUsage();
	if (existing?.status === "complete" || existing?.status === "ended") {
		if (hasPendingCompletionEffects(existing)) {
			await settleCompletionEffects(pi, state, ctx, existing, hooks);
		}
		existing = state.readAny();
		usage = state.readUsage();
		return { mission: existing, usage, alreadyComplete: true, userRequested: input.userRequested === true };
	}
	if (input.authorizeCompletion) {
		if (!hooks.authorizeCompletion) throw new Error("Mission completion authorization is unavailable.");
		await hooks.authorizeCompletion(ctx);
		state.loadFromSession(ctx);
		existing = state.readAny();
		usage = state.readUsage();
	}
	const blockers = hooks.validateCompletion ? await hooks.validateCompletion(input, ctx, directUserRequest) : [];
	if (blockers.length) return { mission: existing, usage, blockers, userRequested: input.userRequested === true };
	const userRequested = input.userRequested === true;
	const summary = input.summary ?? (userRequested ? USER_END_SUMMARY : undefined);
	const audit = userRequested ? USER_END_AUDIT : input.audit?.length ? input.audit : undefined;
	let mission: MissionCurrent;
	if (userRequested) {
		const ended = state.append(pi, state.statusEvent("ended", reason, summary));
		if (!ended) throw new Error("Mission end lost canonical state.");
		mission = ended;
	} else {
		const attempt: MissionCompletionAttempt = { input, reason, summary, audit, existing, usage, directUserRequest };
		const outcome = await commitCompletion(pi, state, ctx, attempt, hooks);
		if (outcome.result) return outcome.result;
		if (!outcome.mission) throw new Error("Mission completion lost canonical state.");
		mission = outcome.mission;
	}
	await settleTerminalEffects(pi, state, ctx, mission, summary, audit, hooks);
	return { mission: state.readAny() ?? mission, usage: state.readUsage(), audit, userRequested };
}

/** Writes the completion audit and runs terminal hooks once the Mission reached `complete` or `ended`. */
async function settleTerminalEffects(
	pi: ExtensionAPI,
	state: MissionState,
	ctx: ExtensionContext,
	mission: MissionCurrent,
	summary: string | undefined,
	audit: MissionRequirementAudit[] | undefined,
	hooks: MissionCompletionHooks,
): Promise<void> {
	if (mission.status === "complete") {
		await settleCompletionEffects(pi, state, ctx, mission, hooks);
		return;
	}
	try {
		await writeCompletionAudit(mission, summary, audit, state.readUsage(), state.readProgress());
		await hooks.onCompleted?.(ctx, mission);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui?.notify?.(`Mission ended; artifact/notification step failed: ${message}`, "warning");
	}
}

/** A Mission blocked because its review correction cycles ran past the authorized limit. */
function correctionLimitBlocked(mission: MissionCurrent): boolean {
	if (mission.status !== "blocked") return false;
	return mission.review.correction.count > mission.review.correction.limit;
}

/** A completed Mission whose durable completion effects still need settling. */
function hasPendingCompletionEffects(mission: MissionCurrent): boolean {
	if (mission.status !== "complete") return false;
	if (mission.completionEffectsStatus !== "pending") return false;
	return Boolean(mission.completionId);
}

async function settleCompletionEffects(
	pi: ExtensionAPI,
	state: MissionState,
	ctx: ExtensionContext,
	mission: MissionCurrent,
	hooks: MissionCompletionHooks,
): Promise<void> {
	const completionId = mission.completionId;
	if (!completionId || mission.completionEffectsStatus === "done") return;
	const existing = completionEffectsInFlight.get(completionId);
	if (existing) return existing;
	const operation = (async () => {
		try {
			await writeCompletionAudit(mission, mission.lastSummary, mission.completionAudit, state.readUsage(), state.readProgress());
			await hooks.onCompleted?.(ctx, mission, completionId);
			state.append(pi, state.completionEffectsDoneEvent(completionId));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui?.notify?.(`Mission completed; artifact/notification step remains pending: ${message}`, "warning");
		}
	})();
	completionEffectsInFlight.set(completionId, operation);
	try { await operation; } finally { completionEffectsInFlight.delete(completionId); }
}

function missionCall(action: string, target: string, theme: Theme): Text {
	const label = theme.fg("muted", target.replace(/\s+/g, " ").slice(0, 90));
	return new Text(theme.fg("toolTitle", theme.bold(`mission ${action} `)) + label, 0, 0);
}

function missionResult(details: MissionResultDetails | undefined, expanded: boolean, theme: Theme, isError = false): Text {
	const value = details;
	if (value?.blockers?.length) {
		const detail = expanded ? `\n${value.blockers.map((blocker) => `- ${blocker}`).join("\n")}` : "";
		return new Text(`${theme.fg("error", "completion blocked")} · ${value.blockers.length} blocker(s)${detail}`, 0, 0);
	}
	if (value?.mission) {
		const mission = value.mission;
		const color = isError ? "error" : mission.status === "complete" ? "success" : mission.status === "active" ? "warning" : "muted";
		const status = theme.fg(color, value.alreadyComplete ? "already complete" : mission.status);
		let text = `${status} ${theme.fg("accent", mission.title)} ${theme.fg("muted", mission.missionId)}`;
		const admission = mission.review.admission;
		if (admission.status && admission.status !== "not_required") {
			text += ` · review ${admission.status}${admission.outcome ? ` (${admission.outcome})` : ""}`;
		}
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
		for (const [index, line] of lines.entries()) {
			const lower = line.toLowerCase();
			const hits = terms.filter((term) => lower.includes(term)).length;
			if (hits === 0) continue;
			results.push({
				path: relative(cwd, file),
				line: index + 1,
				score: hits / terms.length,
				snippet: line.trim().slice(0, 240),
			});
		}
	}
	const limit = Math.max(1, Math.min(25, input.maxResults ?? 8));
	return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line).slice(0, limit);
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
	return results
		.map((item, index) => `${index + 1}. ${item.path}:${item.line} score=${item.score.toFixed(2)}\n   ${item.snippet}`)
		.join("\n");
}

/** The severity-derived reviewer result the parent still has to adjudicate. */
function formatReviewAdjudication(mission: MissionCurrent): string {
	const findings = mission.review.findings;
	return [
		`Review: run ${mission.review.admission.runId ?? "missing"};`,
		`derived ${mission.review.adjudication.suggestedVerdict ?? "unknown"};`,
		`severity ${findings.highestSeverity ?? "none"};`,
		`blocking ${findings.blockingCount};`,
		`backlog ${findings.backlogCount};`,
		"evidence via subagent_wait.",
	].join(" ");
}

export function formatMission(mission: MissionCurrent | undefined, usage: MissionUsage): string {
	if (!mission) return "No Mission is controlled by this session.";
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
		mission.review.admission.status === "awaiting_adjudication" ? formatReviewAdjudication(mission) : undefined,
		formatMissionLocation(mission),
		mission.lastReason ? `Reason: ${compactMissionText(mission.lastReason, 160)}` : undefined,
	].filter(Boolean).join("\n");
}

export function formatContinuation(blockers: string[]): string {
	if (!blockers.length) return "\nAutonomous continuation wake requested.";
	return `\nContinuation waiting on:\n${blockers.map((blocker) => `- ${blocker}`).join("\n")}`;
}

function formatMissionLocation(mission: MissionCurrent): string {
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
