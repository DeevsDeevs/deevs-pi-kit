import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { budgetLimitPrompt, continuationPrompt, missionContextBlock } from "./prompts.ts";
import { registerMissionCommands } from "./commands.ts";
import { MissionState } from "./state.ts";
import { registerMissionTools } from "./tools.ts";
import { clearMissionStatus, updateMissionStatus } from "./status.ts";
import { updateMissionSummaryArtifact } from "./artifacts.ts";

const SURFACE_KEY = Symbol.for("deevs-pi-kit.mission-surface");
const MISSION_COMPACT_PERCENT = 75;

interface MissionSurfaceState { active: boolean }
interface GlobalWithMissionSurface { [SURFACE_KEY]?: MissionSurfaceState }

export default function missionExtension(pi: ExtensionAPI): void {
	const globalState = globalThis as GlobalWithMissionSurface;
	const existing = globalState[SURFACE_KEY];
	if (existing?.active) return;
	const surfaceState: MissionSurfaceState = { active: true };
	globalState[SURFACE_KEY] = surfaceState;

	const state = new MissionState();
	let currentCtx: ExtensionContext | undefined;
	let continuationInFlight = false;
	let compactionInFlight = false;
	let disposed = false;
	const continuationTimers = new Set<ReturnType<typeof setTimeout>>();

	const setContext = (ctx: ExtensionContext) => {
		currentCtx = ctx;
	};
	const restore = (ctx: ExtensionContext) => {
		setContext(ctx);
		state.loadFromSession(ctx);
		updateMissionStatus(ctx, state);
	};
	const maybeContinue = (ctx: ExtensionContext) => {
		if (disposed || currentCtx !== ctx) return;
		void maybeContinueMission(pi, state, ctx, continuationInFlight, compactionInFlight, (value) => {
			continuationInFlight = value;
		}, (value) => {
			compactionInFlight = value;
		}, maybeContinue).catch((error) => {
			try {
				if (!disposed && currentCtx === ctx && ctx.hasUI) ctx.ui.notify(`Mission continuation skipped: ${error instanceof Error ? error.message : String(error)}`, "warning");
			} catch {
				// The context may already be stale during session replacement/reload cleanup.
			}
		});
	};
	const scheduleMaybeContinue = (ctx: ExtensionContext) => {
		const timer = setTimeout(() => {
			continuationTimers.delete(timer);
			maybeContinue(ctx);
		}, 0);
		continuationTimers.add(timer);
	};

	registerMissionTools(pi, state, setContext);
	registerMissionCommands(pi, state, setContext, maybeContinue);

	pi.on("session_start", async (event: any, ctx) => {
		disposed = false;
		restore(ctx);
		if (["startup", "reload", "resume"].includes(event?.reason)) scheduleMaybeContinue(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("session_compact", async (_event, ctx) => {
		compactionInFlight = false;
		restore(ctx);
		// Pi emits session_compact before the core compaction wrapper has fully unwound.
		// Defer the Mission continuation so an active mission resumes after both manual
		// and automatic compaction without racing session/agent reconnection.
		scheduleMaybeContinue(ctx);
	});
	pi.on("turn_start", async (_event, ctx) => setContext(ctx));
	pi.on("turn_end", async (_event, ctx) => {
		restore(ctx);
		await accountBudget(pi, state, ctx);
	});
	pi.on("agent_end", async (event: any, ctx) => {
		restore(ctx);
		continuationInFlight = false;
		if (await pauseMissionOnUserAbort(pi, state, ctx, event)) return;
		await accountBudget(pi, state, ctx);
		if (markStuckIfNoProgress(pi, state, ctx)) return;
		maybeContinue(ctx);
	});
	pi.on("before_agent_start", async (event: any, ctx) => {
		state.loadFromSession(ctx);
		const mission = state.read();
		if (!mission || mission.status !== "active") return;
		const usage = state.readUsage();
		const systemPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
		return { systemPrompt: `${systemPrompt}\n\n${missionContextBlock(mission, usage)}` };
	});
	pi.on("session_shutdown", async () => {
		disposed = true;
		for (const timer of continuationTimers) clearTimeout(timer);
		continuationTimers.clear();
		clearMissionStatus(currentCtx);
		currentCtx = undefined;
		surfaceState.active = false;
	});
}

async function maybeContinueMission(pi: ExtensionAPI, state: MissionState, ctx: ExtensionContext, inFlight: boolean, compactionInFlight: boolean, setInFlight: (value: boolean) => void, setCompactionInFlight: (value: boolean) => void, retryAfterCompaction: (ctx: ExtensionContext) => void): Promise<void> {
	state.loadFromSession(ctx);
	const mission = state.read();
	if (!mission || mission.status !== "active") return;
	if (inFlight || compactionInFlight || !ctx.isIdle() || ctx.hasPendingMessages()) return;
	if (!ctx.sessionManager.getSessionFile()) return;
	if (state.budgetExceeded()) return;
	if (maybeCompactBeforeContinue(mission, ctx, setCompactionInFlight, retryAfterCompaction)) return;
	if (mission.lastContinuationAt && mission.updatedAt <= mission.lastContinuationAt && !hasUserMessageAfter(ctx, mission.lastContinuationAt) && !hasProgressAfter(ctx, mission.lastContinuationAt) && !hasCompactionAfter(ctx, mission.lastContinuationAt)) return;
	const event = state.continuedEvent();
	state.append(pi, event);
	setInFlight(true);
	pi.sendMessage({
		customType: "mission",
		content: continuationPrompt(mission, state.readUsage()),
		display: false,
		details: { kind: "continuation", missionId: mission.missionId },
	}, { triggerTurn: true, deliverAs: "followUp" });
}

function maybeCompactBeforeContinue(mission: ReturnType<MissionState["read"]>, ctx: ExtensionContext, setCompactionInFlight: (value: boolean) => void, retryAfterCompaction: (ctx: ExtensionContext) => void): boolean {
	const usage = ctx.getContextUsage();
	if (!mission || usage?.percent === null || usage?.percent === undefined || usage.percent < MISSION_COMPACT_PERCENT) return false;
	setCompactionInFlight(true);
	ctx.compact({
		customInstructions: missionCompactionInstructions(mission),
		onComplete: () => {
			setCompactionInFlight(false);
			retryAfterCompaction(ctx);
		},
		onError: (error) => {
			setCompactionInFlight(false);
			if (ctx.hasUI) ctx.ui.notify(`Mission compaction skipped: ${error.message}`, "warning");
		},
	});
	if (ctx.hasUI) ctx.ui.notify(`Mission compacting context before continuing (${usage.percent.toFixed(1)}%).`, "info");
	return true;
}

function missionCompactionInstructions(mission: ReturnType<MissionState["read"]>): string {
	if (!mission) return "Preserve active Mission state, open requirements, evidence, blockers, and next step.";
	const requirements = mission.requirements.length ? mission.requirements.map((item) => `- ${item}`).join("\n") : `- ${mission.objective}`;
	return [
		"Preserve active Pi Mission continuity in the summary.",
		`Mission: ${mission.title}`,
		`Objective: ${mission.objective}`,
		"Requirements:",
		requirements,
		`Artifacts: ${mission.artifactDir}`,
		"Include completed evidence, remaining work, blockers, files changed/read, validation commands/results, and next step.",
	].join("\n");
}

async function accountBudget(pi: ExtensionAPI, state: MissionState, ctx: ExtensionContext): Promise<void> {
	state.loadFromSession(ctx);
	const exceeded = state.budgetExceeded();
	if (!exceeded) {
		const mission = state.read();
		if (mission) await updateMissionSummaryArtifact(mission, state.readUsage()).catch(() => undefined);
		updateMissionStatus(ctx, state);
		return;
	}
	const event = state.statusEvent("budget_limited", `${exceeded} budget exhausted`);
	const mission = state.append(pi, event);
	if (!mission) return;
	await updateMissionSummaryArtifact(mission, state.readUsage()).catch(() => undefined);
	updateMissionStatus(ctx, state);
	if (ctx.hasUI) ctx.ui.notify(`Mission budget limited: ${exceeded} budget exhausted.`, "warning");
	pi.sendMessage({
		customType: "mission",
		content: budgetLimitPrompt(mission, state.readUsage()),
		display: false,
		details: { kind: "budget_limited", missionId: mission.missionId },
	}, { triggerTurn: false });
}

async function pauseMissionOnUserAbort(pi: ExtensionAPI, state: MissionState, ctx: ExtensionContext, event: any): Promise<boolean> {
	const mission = state.read();
	if (!mission || mission.status !== "active") return false;
	// Only an explicit user abort should pause Mission autonomy. Provider/tool/runtime
	// errors must not strand an active mission behind a manual `/mission resume`.
	const aborted = Array.isArray(event?.messages) && event.messages.some((message: any) => message?.role === "assistant" && message.stopReason === "aborted");
	if (!aborted) return false;
	const statusEvent = state.statusEvent("paused", "agent aborted/interrupted; auto-continuation paused");
	const paused = state.append(pi, statusEvent);
	if (paused) await updateMissionSummaryArtifact(paused, state.readUsage()).catch(() => undefined);
	updateMissionStatus(ctx, state);
	if (ctx.hasUI) ctx.ui.notify("Mission paused after abort/interruption. Use /mission resume to continue.", "warning");
	return true;
}

function hasUserMessageAfter(ctx: ExtensionContext, timestampMs: number): boolean {
	return hasBranchEntryAfter(ctx, timestampMs, (entry) => entry.type === "message" && entry.message?.role === "user");
}

function hasProgressAfter(ctx: ExtensionContext, timestampMs: number): boolean {
	return hasBranchEntryAfter(ctx, timestampMs, (entry) => entry.type === "message" && ["assistant", "toolResult"].includes(entry.message?.role));
}

function hasCompactionAfter(ctx: ExtensionContext, timestampMs: number): boolean {
	return hasBranchEntryAfter(ctx, timestampMs, (entry) => entry.type === "compaction");
}

function hasBranchEntryAfter(ctx: ExtensionContext, timestampMs: number, predicate: (entry: any) => boolean): boolean {
	return (ctx.sessionManager.getBranch() as Array<any>).some((entry) => {
		const timestamp = Date.parse(entry.timestamp ?? "");
		return Number.isFinite(timestamp) && timestamp > timestampMs && predicate(entry);
	});
}

function markStuckIfNoProgress(pi: ExtensionAPI, state: MissionState, ctx: ExtensionContext): boolean {
	const mission = state.read();
	if (!mission || mission.status !== "active" || !mission.lastContinuationAt) return false;
	const madeProgress = hasProgressAfter(ctx, mission.lastContinuationAt);
	if (madeProgress) return false;
	const event = state.statusEvent("stuck", "automatic continuation produced no assistant/tool progress");
	state.append(pi, event);
	updateMissionStatus(ctx, state);
	if (ctx.hasUI) ctx.ui.notify("Mission marked stuck: last continuation produced no progress. Use /mission resume to try again.", "warning");
	return true;
}
