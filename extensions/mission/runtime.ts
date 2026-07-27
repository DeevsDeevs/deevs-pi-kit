import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chainCheckpoints } from "../chains/checkpoint.ts";
import { getSubagentService } from "../subagents/registry.ts";
import { getJobManager } from "../jobs/registry.ts";
import type { DelegateRun } from "../subagents/runtime-types.ts";
import { runtimeEvents } from "../shared/runtime-events.ts";
import { MISSION_CUSTOM_TYPE, MissionState } from "./state.ts";
import type { MissionCompleteInput, MissionCurrent, MissionProgressInput, MissionUpdateInput } from "./types.ts";

interface MissionAgentMessage {
	role?: string;
	stopReason?: string;
	content?: unknown;
}

export class MissionRuntime {
	private ctx?: ExtensionContext;
	private continuationInFlight = false;
	private disposed = false;
	private lastAgentMessages: MissionAgentMessage[] = [];
	private mutatingCalls = new Set<string>();
	private materialMutationSinceSettle = false;
	private worktreeBeforeTurn?: string;
	private recoveryTimer?: NodeJS.Timeout;
	private unsubscribeReview?: () => void;

	constructor(private readonly pi: ExtensionAPI, readonly state: MissionState) {}

	restore(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.state.loadFromSession(ctx);
		this.updateStatus();
	}

	onCreated(ctx: ExtensionContext): void {
		this.restore(ctx);
		const mission = this.state.readAny();
		if (!mission) return;
		chainCheckpoints.current?.activate(mission.chain, mission.chainBranch);
		chainCheckpoints.current?.due("Mission created", "mission_control");
		void this.maybeContinue(ctx);
	}

	onProgress(input: MissionProgressInput, ctx: ExtensionContext): void {
		this.restore(ctx);
		if (input.reviewVerdict) {
			const mission = this.state.read();
			if (!mission || mission.reviewStatus !== "awaiting_adjudication" || !input.reviewRunId || input.reviewRunId !== mission.reviewRunId) {
				throw new Error("Review adjudication requires the exact awaiting reviewer run id.");
			}
			if (!input.reviewReason?.trim()) throw new Error("Review adjudication requires an evidence-based reason.");
			this.state.append(this.pi, this.state.reviewEvent(input.reviewVerdict, { runId: input.reviewRunId, reason: input.reviewReason }));
			chainCheckpoints.current?.due(`Mission review adjudicated: ${input.reviewVerdict}`, "mission_milestone");
		}
		this.updateStatus();
	}

	onObjectiveUpdated(_input: MissionUpdateInput, ctx: ExtensionContext): void {
		this.restore(ctx);
		chainCheckpoints.current?.due("Mission objective updated", "mission_control");
		this.updateStatus();
	}

	onCompleted(ctx: ExtensionContext): void {
		this.restore(ctx);
		const mission = this.state.readAny();
		if (!mission) return;
		chainCheckpoints.current?.due(mission.status === "ended" ? "Mission ended" : "Mission completed", "mission_control");
		runtimeEvents.record(this.pi, {
			type: "emit",
			event: {
				version: 1,
				id: `terminal:${mission.missionId}:${mission.generation}`,
				dedupeKey: `mission:${mission.missionId}:${mission.generation}:terminal`,
				source: { kind: "mission", id: mission.missionId, generation: mission.generation ?? `legacy-${mission.missionId}` },
				type: "terminal",
				status: mission.status === "ended" ? "cancelled" : "completed",
				createdAt: mission.updatedAt,
				summary: mission.lastSummary || mission.title,
			},
		});
		this.updateStatus();
	}

	async validateCompletion(input: MissionCompleteInput, ctx: ExtensionContext, _directUserRequest = false): Promise<string[]> {
		this.restore(ctx);
		const mission = this.state.readAny();
		if (!mission) return ["No Mission exists on this branch."];
		if (input.userRequested) return [];
		const blockers: string[] = [];
		const audit = input.audit ?? [];
		for (const [requirementIndex, requirement] of mission.requirements.entries()) {
			const item = audit.find((candidate) => candidate.requirementIndex === requirementIndex);
			if (!item) blockers.push(`Missing evidence record for requirement [${requirementIndex}]: ${requirement}`);
		}
		if (audit.some((item) => item.requirementIndex < 0 || item.requirementIndex >= mission.requirements.length)) blockers.push("Requirement audit contains an unknown requirementIndex.");
		const validation = this.state.readProgress().flatMap((progress) => progress.validation);
		if (!validation.some((item) => item.exitCode === 0 && item.objectiveVersion === (mission.objectiveVersion ?? 1))) blockers.push("No successful structured validation is recorded for the current objectiveVersion.");
		if (!["clear", "skipped", "not_required"].includes(mission.reviewStatus ?? "not_required")) blockers.push(`Independent review is ${mission.reviewStatus ?? "due"}.`);
		if (mission.reviewStatus === "clear" || mission.reviewStatus === "not_required" || mission.reviewStatus === "skipped") {
			const fingerprint = await worktreeFingerprint(this.pi, ctx.cwd);
			if (mission.reviewStatus === "clear" && (!fingerprint || fingerprint !== mission.reviewWorktreeFingerprint)) blockers.push("Worktree differs from the schema-validated reviewed snapshot.");
			if ((mission.reviewStatus === "not_required" || mission.reviewStatus === "skipped") && this.worktreeBeforeTurn !== undefined && fingerprint !== this.worktreeBeforeTurn) blockers.push("Worktree changed during this turn before independent review admission.");
		}
		if (chainCheckpoints.current?.read().status === "due") blockers.push("The active Chain checkpoint is due.");
		try {
			const activeChildren = this.activeChildren();
			if (activeChildren.length) blockers.push(`Child execution has not settled: ${activeChildren.map((run) => run.spec.id).join(", ")}`);
		} catch (error) {
			blockers.push(`Cannot verify child settlement: ${error instanceof Error ? error.message : String(error)}`);
		}
		const activeJobs = this.activeJobs();
		if (activeJobs.length) blockers.push(`Jobs have not settled: ${activeJobs.map((job) => job.spec.id).join(", ")}`);
		return blockers;
	}

	register(): void {
		this.pi.on("session_start", (_event, ctx) => {
			this.disposed = false;
			this.restore(ctx);
			this.scheduleRecovery(ctx);
		});
		this.pi.on("session_tree", (_event, ctx) => {
			this.restore(ctx);
			this.scheduleRecovery(ctx);
		});
		this.pi.on("session_compact", (_event, ctx) => this.restore(ctx));
		this.pi.on("turn_start", async (_event, ctx) => {
			this.restore(ctx);
			this.worktreeBeforeTurn = await worktreeFingerprint(this.pi, ctx.cwd);
		});
		this.pi.on("agent_end", (event, ctx) => {
			this.lastAgentMessages = [...event.messages];
			this.restore(ctx);
		});
		this.pi.on("tool_execution_start", (event) => {
			if (event.toolName === "edit" || event.toolName === "write") this.mutatingCalls.add(event.toolCallId);
		});
		this.pi.on("tool_execution_end", (event, ctx) => {
			if (!this.mutatingCalls.delete(event.toolCallId) || event.isError) return;
			this.materialMutationSinceSettle = true;
			this.restore(ctx);
			this.markReviewDue(`${event.toolName} changed files`);
		});
		this.pi.on("before_agent_start", (event, ctx) => {
			this.restore(ctx);
			const mission = this.state.readAny();
			if (!mission || mission.status === "complete" || mission.status === "ended") return undefined;
			const systemPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
			if (mission.status !== "active") return { systemPrompt: `${systemPrompt}\n\n${suspendedMissionContext(mission, this.state.readProgress().at(-1))}` };
			const staleWake = latestMissionWakeIsStale(ctx, mission);
			const wakeGuard = staleWake ? "\n\nThis Mission continuation wake is stale after a pause/objective/generation change. Do not perform substantive work; report the stale wake and settle immediately." : "";
			return { systemPrompt: `${systemPrompt}\n\n${missionContext(mission, this.state.readUsage())}${wakeGuard}` };
		});
		this.pi.on("agent_settled", async (_event, ctx) => {
			this.continuationInFlight = false;
			this.restore(ctx);
			await this.onSettled(ctx);
		});
		this.pi.on("session_shutdown", () => {
			this.disposed = true;
			this.continuationInFlight = false;
			if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
			this.recoveryTimer = undefined;
			this.unsubscribeReview?.();
			this.unsubscribeReview = undefined;
			this.lastAgentMessages = [];
			this.mutatingCalls.clear();
			this.materialMutationSinceSettle = false;
			this.worktreeBeforeTurn = undefined;
			this.ctx?.ui.setStatus("mission", undefined);
			this.ctx = undefined;
		});
	}

	async maybeContinue(ctx: ExtensionContext): Promise<void> {
		this.restore(ctx);
		const mission = this.state.read();
		if (this.disposed || !mission || mission.status !== "active" || this.continuationInFlight) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages() || !ctx.sessionManager.getSessionFile()) return;
		let activeChildren: DelegateRun[];
		try {
			activeChildren = this.activeChildren();
		} catch {
			return;
		}
		if (this.state.budgetExceeded() || activeChildren.length || this.activeJobs().length || mission.reviewStatus === "running") return;
		const event = this.state.continuedEvent();
		this.state.append(this.pi, event);
		this.continuationInFlight = true;
		try {
			this.pi.sendMessage({
				customType: "mission",
				content: continuationMessage(mission),
				display: false,
				details: { version: 2, missionId: mission.missionId, generation: mission.generation, objectiveVersion: mission.objectiveVersion },
			}, { triggerTurn: true, deliverAs: "followUp" });
		} catch {
			this.continuationInFlight = false;
			this.scheduleRecovery(ctx, 1_000);
		}
	}

	private scheduleRecovery(ctx: ExtensionContext, delayMs = 0): void {
		if (this.disposed) return;
		if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = undefined;
			void this.recover(ctx);
		}, delayMs);
		this.recoveryTimer.unref?.();
	}

	private async recover(ctx: ExtensionContext): Promise<void> {
		if (this.disposed) return;
		this.restore(ctx);
		this.bindReviewRecovery(ctx);
		await this.reconcileReview();
		await this.maybeContinue(ctx);
	}

	private bindReviewRecovery(ctx: ExtensionContext): void {
		this.unsubscribeReview?.();
		this.unsubscribeReview = undefined;
		try {
			this.unsubscribeReview = getSubagentService().executor.onChange((run) => {
				const mission = this.state.read();
				if (mission?.reviewStatus === "running" && mission.reviewRunId === run.spec.id && !["starting", "running", "stopping"].includes(run.runtime.status)) this.scheduleRecovery(ctx);
			});
		} catch {
			// Subagents may not be registered yet; the next lifecycle recovery retries binding.
		}
	}

	private async onSettled(ctx: ExtensionContext): Promise<void> {
		let mission = this.state.read();
		if (!mission || mission.status !== "active") return;
		const after = await worktreeFingerprint(this.pi, ctx.cwd);
		if (this.worktreeBeforeTurn !== undefined && after !== undefined && this.worktreeBeforeTurn !== after) {
			this.materialMutationSinceSettle = true;
			this.markReviewDue("worktree changed during turn");
		}
		this.worktreeBeforeTurn = undefined;
		const interrupted = this.lastAgentMessages.some((message) => message.role === "assistant" && message.stopReason === "aborted");
		if (interrupted) {
			this.state.append(this.pi, this.state.statusEvent("paused", "explicit interruption paused Mission autonomy"));
			this.updateStatus();
			return;
		}
		const terminalError = this.lastAgentMessages.some((message) => message.role === "assistant" && message.stopReason === "error");
		if (terminalError) {
			this.state.append(this.pi, this.state.statusEvent("terminal_error", "provider/runtime error remained after Pi retry settlement"));
			this.updateStatus();
			return;
		}

		const recentProgress = this.state.readProgress().filter((progress) => progress.at >= (mission!.lastContinuationAt ?? mission!.createdAt));
		const latestProgress = recentProgress.at(-1);
		const blocker = latestProgress?.blocked ? latestProgress.blockerId : undefined;
		const madeProgress = this.materialMutationSinceSettle || recentProgress.some((progress) => !progress.blocked && (progress.evidence.length > 0 || progress.validation.length > 0));
		this.state.append(this.pi, this.state.settledEvent({ blockerFingerprint: blocker, madeProgress: madeProgress || !blocker }));
		this.materialMutationSinceSettle = false;
		this.lastAgentMessages = [];
		mission = this.state.read()!;
		if ((mission.blockerCount ?? 0) >= 3) {
			this.state.append(this.pi, this.state.statusEvent("blocked", `same blocker recurred ${mission.blockerCount} autonomous turns`, latestProgress?.summary.slice(0, 500)));
			this.updateStatus();
			return;
		}

		const limit = this.state.budgetExceeded();
		if (limit) {
			const limited = this.state.append(this.pi, this.state.statusEvent(limit === "token" || limit === "cost" ? "budget_limited" : "usage_limited", `${limit} limit exhausted`));
			this.updateStatus();
			if (limited && ctx.isIdle() && !ctx.hasPendingMessages()) {
				this.pi.sendMessage({
					customType: "mission",
					content: `Mission ${limit} limit reached. Do not start substantive work. Record a concise progress/blocker/next-step handoff, settle active children, and save the due Chain checkpoint. Complete only if the evidence gate was already satisfied.`,
					display: false,
					details: { version: 2, kind: "limit_wrapup", missionId: limited.missionId, limit },
				}, { triggerTurn: true, deliverAs: "followUp" });
			}
			return;
		}

		const chain = chainCheckpoints.current?.read();
		if (chain?.status === "due" && chain.dueCodes.includes("material_change")) this.markReviewDue(chain.dueReasons.at(-1) ?? "material mutation");
		await this.reconcileReview();
		mission = this.state.read()!;
		if (mission.reviewStatus === "due") {
			try {
				if (this.activeChildren().length || this.activeJobs().length) return;
			} catch { return; }
			await this.startReview(ctx, mission);
			return;
		}
		await this.maybeContinue(ctx);
	}

	private markReviewDue(reason: string): void {
		const mission = this.state.read();
		if (!mission || mission.status !== "active") return;
		this.state.append(this.pi, this.state.reviewEvent("due", { reason }));
		this.updateStatus();
	}

	private async startReview(ctx: ExtensionContext, mission: MissionCurrent): Promise<void> {
		let service;
		try {
			service = getSubagentService();
		} catch (error) {
			this.failReview(mission, `review admission failed: ${error instanceof Error ? error.message : String(error)}`);
			this.scheduleRecovery(ctx, 1_000);
			return;
		}
		try {
			if (service.list().runs.some((run) => ["starting", "running", "stopping"].includes(run.runtime.status)) || this.activeJobs().length) return;
		} catch (error) {
			this.failReview(mission, `review admission failed: ${error instanceof Error ? error.message : String(error)}`);
			this.scheduleRecovery(ctx, 1_000);
			return;
		}
		const reviewWorktreeFingerprint = await worktreeFingerprint(this.pi, ctx.cwd);
		if (!reviewWorktreeFingerprint) {
			this.failReview(mission, "could not fingerprint worktree before independent review");
			return;
		}
		const paths = missionReviewPaths(mission);
		const scope = paths.length ? `Review only these Mission-owned files: ${paths.join(", ")}.` : "Review only files directly required by this Mission.";
		let run;
		try {
			run = await service.start({
				agent: "reviewer",
				task: `Fresh independent Mission review. ${scope} Ignore unrelated pre-existing working-tree changes. Mission: ${mission.title}. Objective: ${mission.objective}. Requirements: ${mission.requirements.join(" | ")}. Review normally, call the schema-validated review_report tool exactly once, then summarize for the parent. Do not edit files.`,
				cwd: ctx.cwd,
				context: "fresh",
				allowWrite: false,
				background: true,
				wallMs: 10 * 60_000,
			}, ctx);
		} catch (error) {
			this.failReview(mission, `review admission failed: ${error instanceof Error ? error.message : String(error)}`);
			this.scheduleRecovery(ctx, 1_000);
			return;
		}
		if ("children" in run) return;
		this.state.append(this.pi, this.state.reviewEvent("running", { runId: run.spec.id, reason: mission.reviewReason, worktreeFingerprint: reviewWorktreeFingerprint }));
		this.updateStatus();
	}

	private async reconcileReview(): Promise<void> {
		const mission = this.state.read();
		if (!mission?.reviewRunId || mission.reviewStatus !== "running") return;
		let run: DelegateRun;
		try {
			run = getSubagentService().executor.get(mission.reviewRunId);
		} catch (error) {
			this.failReview(mission, `independent review run lost: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (["starting", "running", "stopping"].includes(run.runtime.status)) return;
		if (run.runtime.status !== "completed") {
			this.failReview(mission, run.runtime.error || "independent review failed");
			return;
		}
		const suggested = await readReviewVerdict(run);
		if (suggested === "unknown") {
			this.failReview(mission, "independent reviewer did not submit a valid review_report artifact");
			return;
		}
		const fingerprint = this.ctx ? await worktreeFingerprint(this.pi, this.ctx.cwd) : undefined;
		if (!fingerprint) {
			this.failReview(mission, "could not fingerprint reviewed worktree");
			return;
		}
		if (!mission.reviewWorktreeFingerprint || fingerprint !== mission.reviewWorktreeFingerprint) {
			this.state.append(this.pi, this.state.reviewEvent("due", { reason: "worktree changed while independent review was running" }));
			this.updateStatus();
			return;
		}
		this.state.append(this.pi, this.state.reviewEvent("awaiting_adjudication", { runId: run.spec.id, reason: "Independent review settled; parent must adjudicate the structured reviewer result.", suggestedVerdict: suggested, worktreeFingerprint: fingerprint }));
		this.updateStatus();
	}

	private failReview(mission: MissionCurrent, reason: string): void {
		if (reviewFailureCount(this.ctx, mission.missionId) >= 2) this.state.append(this.pi, this.state.statusEvent("blocked", "independent review failed three times", reason));
		else this.state.append(this.pi, this.state.reviewEvent("due", { reason, failure: true }));
		this.updateStatus();
	}

	private activeJobs() {
		return getJobManager()?.list().filter((job) => ["starting", "running", "stopping"].includes(job.runtime.status)) ?? [];
	}

	private activeChildren(excludeId?: string): DelegateRun[] {
		return getSubagentService().list().runs.filter((run) => run.spec.id !== excludeId && ["starting", "running", "stopping"].includes(run.runtime.status));
	}

	private updateStatus(): void {
		if (!this.ctx) return;
		const mission = this.state.read();
		if (!mission) {
			this.ctx.ui.setStatus("mission", undefined);
			return;
		}
		const theme = this.ctx.ui.theme;
		if (mission.status !== "active") {
			const color = ["blocked", "terminal_error", "budget_limited", "usage_limited"].includes(mission.status) ? "error" : "warning";
			const text = `mission ${mission.status.replace("_", " ")}`;
			this.ctx.ui.setStatus("mission", theme?.fg(color, text) ?? text);
			return;
		}
		const review = mission.reviewStatus;
		if (review === "due") return this.ctx.ui.setStatus("mission", theme?.fg("warning", "review due") ?? "review due");
		if (review === "running") return this.ctx.ui.setStatus("mission", theme?.fg("accent", "review running") ?? "review running");
		if (review === "awaiting_adjudication") return this.ctx.ui.setStatus("mission", theme?.fg("warning", "review ready") ?? "review ready");
		if (review === "changes_requested") return this.ctx.ui.setStatus("mission", theme?.fg("error", "review changes") ?? "review changes");
		const usage = this.state.readUsage();
		if (mission.tokenBudget && usage.totalTokens / mission.tokenBudget >= 0.8) {
			const text = `mission ${compact(usage.totalTokens)}/${compact(mission.tokenBudget)}`;
			return this.ctx.ui.setStatus("mission", theme?.fg("warning", text) ?? text);
		}
		this.ctx.ui.setStatus("mission", undefined);
	}
}

function continuationMessage(mission: MissionCurrent): string {
	return [
		`Mission continuation ${mission.generation}/${mission.objectiveVersion ?? 1}.`,
		`Objective: ${mission.objective}`,
		`Requirements: ${mission.requirements.map((item) => `• ${item}`).join(" ")}`,
		`Review: ${mission.reviewStatus ?? "not_required"}${mission.reviewReason ? ` (${mission.reviewReason})` : ""}.`,
		"Choose the highest-leverage next action toward the full objective; do not shrink scope to fit one turn, and work until a natural turn boundary. Make best judgments without routine questions. Stop for credentials, safety, irreversible operations, explicit approval boundaries, terminal error, or a genuine repeated blocker. Record milestone evidence with mission_progress. Completion requires validation, independent review convergence, child settlement, Chain checkpoint, and a requirement evidence audit.",
	].join("\n");
}

function missionContext(mission: MissionCurrent, usage: ReturnType<MissionState["readUsage"]>): string {
	return [`Active Mission: ${mission.title}`, `Objective v${mission.objectiveVersion ?? 1}: ${mission.objective}`, `State: ${mission.status}; review ${mission.reviewStatus ?? "not_required"}; usage ${usage.totalTokens} tokens / $${usage.totalCostUsd.toFixed(4)}.`, "Active Mission authorization permits reversible best judgment and autonomous continuation, but never bypasses tool approval, credentials, safety, or irreversible boundaries."].join("\n");
}

function suspendedMissionContext(mission: MissionCurrent, progress: ReturnType<MissionState["readProgress"]>[number] | undefined): string {
	const resumable = ["paused", "blocked", "terminal_error", "ended"].includes(mission.status);
	return [
		`Mission control state: ${mission.status.toUpperCase()} — ${mission.title}`,
		`Reason: ${mission.lastReason ?? "not recorded"}${mission.lastSummary ? ` · ${mission.lastSummary}` : ""}`,
		`Resume target: ${mission.chain}@${mission.chainBranch}; artifacts .missions/${mission.slug}.`,
		...(progress?.remaining.length ? [`Recorded next work: ${progress.remaining.join(" | ")}`] : []),
		resumable
			? "Do not silently continue Mission work. If the current user explicitly asks to continue/resume or directly resolves this pause/blocker, call mission_resume with that concrete reason before substantive work. Otherwise honor the suspension and report the exact resume target."
			: "Do not resume or perform substantive Mission work. This limit requires an explicit Mission/budget decision from the user.",
	].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function latestMissionWakeIsStale(ctx: ExtensionContext, mission: MissionCurrent): boolean {
	const branch = ctx.sessionManager.getBranch() as readonly unknown[];
	const entry = asRecord(branch.at(-1));
	if (entry?.type !== "custom_message" || entry.customType !== "mission") return false;
	const details = asRecord(entry.details);
	if (details?.kind === "limit_wrapup") return false;
	return details?.missionId !== mission.missionId || details?.generation !== mission.generation || details?.objectiveVersion !== mission.objectiveVersion;
}

async function readReviewVerdict(run: DelegateRun): Promise<"clear" | "changes_requested" | "unknown"> {
	try {
		const report = JSON.parse(await readFile(join(run.spec.artifactsDir, "review-report.json"), "utf8")) as { version?: unknown; verdict?: unknown };
		return report.version === 1 && (report.verdict === "clear" || report.verdict === "changes_requested") ? report.verdict : "unknown";
	} catch { return "unknown"; }
}

function missionReviewPaths(mission: MissionCurrent): string[] {
	return mission.paths;
}

function reviewFailureCount(ctx: ExtensionContext | undefined, missionId: string): number {
	if (!ctx) return 0;
	return (ctx.sessionManager.getBranch() as readonly unknown[]).filter((entry) => {
		const record = asRecord(entry);
		const event = asRecord(record?.data);
		return record?.type === "custom" && record.customType === MISSION_CUSTOM_TYPE
			&& event?.kind === "review_changed" && event.missionId === missionId && event.reviewStatus === "due"
			&& event.reviewFailure === true;
	}).length;
}

async function worktreeFingerprint(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		const [head, diff, untracked] = await Promise.all([
			pi.exec("git", ["rev-parse", "HEAD"], { cwd }),
			pi.exec("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], { cwd }),
			pi.exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd }),
		]);
		if (head.code !== 0 || diff.code !== 0 || untracked.code !== 0) return undefined;
		const hash = createHash("sha256").update(head.stdout.trim()).update("\0").update(diff.stdout).update("\0");
		for (const relative of untracked.stdout.split("\0").filter(Boolean).sort()) {
			hash.update(relative).update("\0");
			try { hash.update(await readFile(join(cwd, relative))); } catch { hash.update("[unreadable]"); }
		}
		return hash.digest("hex");
	} catch { return undefined; }
}

function compact(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(Math.round(value));
}
