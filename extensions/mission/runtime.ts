import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chainCheckpoints } from "../chains/checkpoint.ts";
import { getSubagentService } from "../subagents/registry.ts";
import { getJobManager } from "../jobs/registry.ts";
import type { DelegateRun } from "../subagents/runtime-types.ts";
import { runtimeEvents } from "../shared/runtime-events.ts";
import { MissionState } from "./state.ts";
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
		chainCheckpoints.current?.due("Mission created");
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
			chainCheckpoints.current?.due(`Mission review adjudicated: ${input.reviewVerdict}`);
		}
		this.updateStatus();
	}

	onObjectiveUpdated(_input: MissionUpdateInput, ctx: ExtensionContext): void {
		this.restore(ctx);
		chainCheckpoints.current?.due("Mission objective updated");
		this.updateStatus();
	}

	onCompleted(ctx: ExtensionContext): void {
		this.restore(ctx);
		const mission = this.state.readAny();
		if (!mission) return;
		chainCheckpoints.current?.due("Mission completed");
		runtimeEvents.record(this.pi, {
			type: "emit",
			event: {
				version: 1,
				id: `terminal:${mission.missionId}:${mission.generation}`,
				dedupeKey: `mission:${mission.missionId}:${mission.generation}:terminal`,
				source: { kind: "mission", id: mission.missionId, generation: mission.generation ?? `legacy-${mission.missionId}` },
				type: "terminal",
				status: "completed",
				createdAt: mission.updatedAt,
				summary: mission.lastSummary || mission.title,
			},
		});
		this.updateStatus();
	}

	async validateCompletion(input: MissionCompleteInput, ctx: ExtensionContext): Promise<string[]> {
		this.restore(ctx);
		const mission = this.state.readAny();
		if (!mission) return ["No Mission exists on this branch."];
		if (input.userRequested) return hasExplicitUserEndRequest(ctx) ? [] : ["userRequested=true is not authorized by the latest real user message; use the ordinary completion evidence gate."];
		const blockers: string[] = [];
		const audit = input.audit ?? [];
		for (const requirement of mission.requirements) {
			const item = audit.find((candidate) => normalize(candidate.requirement) === normalize(requirement));
			if (!item?.evidence.trim()) blockers.push(`Missing evidence for requirement: ${requirement}`);
		}
		const validation = this.state.readProgress().flatMap((progress) => progress.validation);
		const auditMentionsValidation = audit.some((item) => /\b(test|validation|check|command|smoke|build)\b/i.test(`${item.requirement} ${item.evidence}`));
		if (!validation.length && !auditMentionsValidation) blockers.push("No validation evidence is recorded.");
		if (!["clear", "skipped", "not_required"].includes(mission.reviewStatus ?? "not_required")) blockers.push(`Independent review is ${mission.reviewStatus ?? "due"}.`);
		if (mission.reviewStatus === "skipped" && !mission.reviewSkippedReason) blockers.push("Review was skipped without a recorded reason.");
		if (chainCheckpoints.current?.read().status === "due") blockers.push("The active Chain checkpoint is due.");
		const activeChildren = this.activeChildren();
		if (activeChildren.length) blockers.push(`Child execution has not settled: ${activeChildren.map((run) => run.spec.id).join(", ")}`);
		const activeJobs = this.activeJobs();
		if (activeJobs.length) blockers.push(`Jobs have not settled: ${activeJobs.map((job) => job.spec.id).join(", ")}`);
		return blockers;
	}

	register(): void {
		this.pi.on("session_start", (_event, ctx) => {
			this.disposed = false;
			this.restore(ctx);
			void this.maybeContinue(ctx);
		});
		this.pi.on("session_tree", (_event, ctx) => this.restore(ctx));
		this.pi.on("session_compact", (_event, ctx) => this.restore(ctx));
		this.pi.on("turn_start", (_event, ctx) => this.restore(ctx));
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
			const mission = this.state.read();
			if (!mission || mission.status !== "active") return undefined;
			const systemPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
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
			this.lastAgentMessages = [];
			this.mutatingCalls.clear();
			this.materialMutationSinceSettle = false;
			this.ctx?.ui.setStatus("mission", undefined);
			this.ctx = undefined;
		});
	}

	async maybeContinue(ctx: ExtensionContext): Promise<void> {
		this.restore(ctx);
		const mission = this.state.read();
		if (this.disposed || !mission || mission.status !== "active" || this.continuationInFlight) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages() || !ctx.sessionManager.getSessionFile()) return;
		if (this.state.budgetExceeded() || this.activeChildren().length || this.activeJobs().length || mission.reviewStatus === "running") return;
		const event = this.state.continuedEvent();
		this.state.append(this.pi, event);
		this.continuationInFlight = true;
		this.pi.sendMessage({
			customType: "mission",
			content: continuationMessage(mission),
			display: false,
			details: { version: 2, missionId: mission.missionId, generation: mission.generation, objectiveVersion: mission.objectiveVersion },
		}, { triggerTurn: true, deliverAs: "followUp" });
	}

	private async onSettled(ctx: ExtensionContext): Promise<void> {
		let mission = this.state.read();
		if (!mission || mission.status !== "active") return;
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

		const latestText = latestAssistantText(this.lastAgentMessages);
		const blocker = blockerFingerprint(latestText);
		const madeProgress = this.materialMutationSinceSettle || this.state.readProgress().some((progress) => progress.at >= (mission!.lastContinuationAt ?? mission!.createdAt));
		this.state.append(this.pi, this.state.settledEvent({ blockerFingerprint: blocker, madeProgress: madeProgress || !blocker }));
		this.materialMutationSinceSettle = false;
		this.lastAgentMessages = [];
		mission = this.state.read()!;
		if ((mission.blockerCount ?? 0) >= 3) {
			this.state.append(this.pi, this.state.statusEvent("blocked", `same blocker recurred ${mission.blockerCount} autonomous turns`, latestText.slice(0, 500)));
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
		if (chain?.status === "due" && chain.dueReasons.some((reason) => /changed|write-enabled|objective/i.test(reason))) this.markReviewDue(chain.dueReasons.at(-1) ?? "material mutation");
		await this.reconcileReview();
		mission = this.state.read()!;
		if (mission.reviewStatus === "due") {
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
		} catch {
			return;
		}
		const run = await service.start({
			agent: "reviewer",
			task: `Fresh independent Mission review. Inspect the current git diff and relevant files only. Mission: ${mission.title}. Objective: ${mission.objective}. Requirements: ${mission.requirements.join(" | ")}. Return the reviewer persona verdict and evidence. Do not edit files.`,
			cwd: ctx.cwd,
			context: "fresh",
			allowWrite: false,
			background: true,
			wallMs: 10 * 60_000,
		}, ctx);
		if ("children" in run) return;
		this.state.append(this.pi, this.state.reviewEvent("running", { runId: run.spec.id, reason: mission.reviewReason }));
		this.updateStatus();
	}

	private async reconcileReview(): Promise<void> {
		const mission = this.state.read();
		if (!mission?.reviewRunId || mission.reviewStatus !== "running") return;
		let run: DelegateRun;
		try {
			run = getSubagentService().executor.get(mission.reviewRunId);
		} catch {
			return;
		}
		if (["starting", "running", "stopping"].includes(run.runtime.status)) return;
		const output = run.runtime.output ?? "";
		if (run.runtime.status !== "completed") {
			this.state.append(this.pi, this.state.reviewEvent("due", { reason: run.runtime.error || "independent review failed" }));
			return;
		}
		const suggested = /##\s*Verdict[\s\S]{0,120}\b(Block|changes requested)\b/i.test(output) || /severity:\s*(blocker|major)/i.test(output) ? "changes_requested" : "clear";
		this.state.append(this.pi, this.state.reviewEvent("awaiting_adjudication", { runId: run.spec.id, reason: `Independent review settled; parent must adjudicate suggested verdict ${suggested}.` }));
		this.updateStatus();
	}

	private activeJobs() {
		return getJobManager()?.list().filter((job) => ["starting", "running", "stopping"].includes(job.runtime.status)) ?? [];
	}

	private activeChildren(excludeId?: string): DelegateRun[] {
		try {
			return getSubagentService().list().runs.filter((run) => run.spec.id !== excludeId && ["starting", "running", "stopping"].includes(run.runtime.status));
		} catch {
			return [];
		}
	}

	private updateStatus(): void {
		if (!this.ctx) return;
		const mission = this.state.read();
		if (!mission) {
			this.ctx.ui.setStatus("mission", undefined);
			return;
		}
		const usage = this.state.readUsage();
		const review = mission.reviewStatus && mission.reviewStatus !== "not_required" ? ` · review ${mission.reviewStatus}` : "";
		this.ctx.ui.setStatus("mission", `mission ${mission.status} · ${compact(usage.totalTokens)}${mission.tokenBudget ? `/${compact(mission.tokenBudget)}` : ""}${review}`);
	}
}

function continuationMessage(mission: MissionCurrent): string {
	return [
		`Mission continuation ${mission.generation}/${mission.objectiveVersion ?? 1}.`,
		`Objective: ${mission.objective}`,
		`Requirements: ${mission.requirements.map((item) => `• ${item}`).join(" ")}`,
		`Review: ${mission.reviewStatus ?? "not_required"}${mission.reviewReason ? ` (${mission.reviewReason})` : ""}.`,
		"Execute one reversible, verifiable slice. Make best judgments without routine questions. Stop for credentials, safety, irreversible operations, explicit approval boundaries, terminal error, or a genuine repeated blocker. Record milestone evidence with mission_progress. Completion requires validation, independent review convergence, child settlement, Chain checkpoint, and a requirement evidence audit.",
	].join("\n");
}

function missionContext(mission: MissionCurrent, usage: ReturnType<MissionState["readUsage"]>): string {
	return [`Active Mission: ${mission.title}`, `Objective v${mission.objectiveVersion ?? 1}: ${mission.objective}`, `State: ${mission.status}; review ${mission.reviewStatus ?? "not_required"}; usage ${usage.totalTokens} tokens / $${usage.totalCostUsd.toFixed(4)}.`, "Active Mission authorization permits reversible best judgment and autonomous continuation, but never bypasses tool approval, credentials, safety, or irreversible boundaries."].join("\n");
}

function latestAssistantText(messages: MissionAgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) return message.content.map(asRecord).filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => String(part!.text)).join("\n");
	}
	return "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasExplicitUserEndRequest(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch() as readonly unknown[];
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = asRecord(branch[index]);
		const message = asRecord(entry?.message);
		if (entry?.type !== "message" || message?.role !== "user") continue;
		const text = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.map(asRecord).filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => String(part!.text)).join(" ")
				: "";
		const normalized = normalize(text);
		if (normalized.includes("?")) return false;
		if (/\b(do not|don't|dont|never|no need to|should not|shouldn't|i do not want (you )?to|i don't want (you )?to)\b.{0,40}\b(end|stop|cancel|complete|terminate)\b/.test(normalized)) return false;
		const action = "(?:end|stop|cancel|complete|terminate)";
		const target = "(?:this\\s+|the\\s+)?mission";
		const suffix = "(?:\\s+(?:now|anyway|regardless))?[.!]*";
		return new RegExp(`^(?:please\\s+)?${action}\\s+${target}${suffix}$`).test(normalized)
			|| new RegExp(`^(?:please\\s+)?(?:go ahead and|you can|i want you to|i am asking you to|i'm asking you to)\\s+${action}\\s+${target}${suffix}$`).test(normalized);
	}
	return false;
}

function latestMissionWakeIsStale(ctx: ExtensionContext, mission: MissionCurrent): boolean {
	const branch = ctx.sessionManager.getBranch() as readonly unknown[];
	const entry = asRecord(branch.at(-1));
	if (entry?.type !== "custom_message" || entry.customType !== "mission") return false;
	const details = asRecord(entry.details);
	if (details?.kind === "limit_wrapup") return false;
	return details?.missionId !== mission.missionId || details?.generation !== mission.generation || details?.objectiveVersion !== mission.objectiveVersion;
}

function blockerFingerprint(text: string): string | undefined {
	if (!/\b(blocked|cannot continue|need (approval|credentials?|access)|missing credentials?|hard boundary)\b/i.test(text)) return undefined;
	return normalize(text).slice(0, 180);
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function compact(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(Math.round(value));
}
