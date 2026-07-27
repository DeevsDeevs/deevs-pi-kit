import { randomUUID } from "node:crypto";
import { isAbsolute, normalize as normalizePath } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ChainService } from "../chains/service.ts";
import { slugify } from "../chains/parser.ts";
import { missionDir } from "./artifacts.ts";
import type { MissionCreateInput, MissionCurrent, MissionEvent, MissionProgressInput, MissionProgressRecord, MissionReviewStatus, MissionStatus, MissionUpdateInput, MissionUsage, MissionValidationInput, MissionValidationRecord } from "./types.ts";

export const MISSION_CUSTOM_TYPE = "deevs-mission-state";
const DEFAULT_CHAIN_BRANCH = "main";

export class MissionState {
	private current: MissionCurrent | undefined;
	private usage: MissionUsage = zeroUsage();
	private progress: MissionProgressRecord[] = [];

	read(): MissionCurrent | undefined {
		if (!this.current || this.current.status === "cleared" || this.current.status === "complete" || this.current.status === "ended") return undefined;
		return { ...this.current };
	}

	readAny(): MissionCurrent | undefined {
		if (!this.current || this.current.status === "cleared") return undefined;
		return { ...this.current };
	}

	readUsage(): MissionUsage {
		return { ...this.usage };
	}

	readProgress(): MissionProgressRecord[] {
		return this.progress.map((item) => ({ ...item, evidence: [...item.evidence], remaining: [...item.remaining], validation: item.validation.map((value) => ({ ...value })) }));
	}

	loadFromSession(ctx: ExtensionContext): void {
		const branch = ctx.sessionManager.getBranch() as Array<any>;
		const rolling = zeroUsage();
		let terminalUsage: MissionUsage | undefined;
		const seenSubagents = new Set<string>();
		this.current = undefined;
		this.progress = [];
		for (const entry of branch) {
			if (entry.type === "custom" && entry.customType === MISSION_CUSTOM_TYPE) {
				const rawEvent = entry.data as MissionEvent | undefined;
				if (!rawEvent?.missionId) continue;
				const event = rawEvent.kind === "created" && rawEvent.baselineMainTokens === undefined
					? { ...rawEvent, baselineMainTokens: rolling.mainTokens, baselineSubagentTokens: rolling.subagentTokens, baselineMainCostUsd: rolling.mainCostUsd, baselineSubagentCostUsd: rolling.subagentCostUsd }
					: rawEvent;
				this.applyEvent(event);
				const status = (this.current as MissionCurrent | undefined)?.status;
				if (["complete", "ended", "cleared", "budget_limited"].includes(status ?? "")) terminalUsage = { ...rolling };
				continue;
			}
			addUsageFromEntry(rolling, entry, seenSubagents);
		}
		const current = this.current as MissionCurrent | undefined;
		if (current) current.artifactDir = missionDir(ctx.cwd, current.slug);
		const terminal = current && ["complete", "ended", "cleared", "budget_limited"].includes(current.status);
		this.usage = current ? usageFromAggregate(terminal ? terminalUsage ?? rolling : rolling, current) : zeroUsage();
	}

	async create(input: MissionCreateInput, ctx: ExtensionContext): Promise<MissionEvent> {
		const objective = input.objective.trim();
		if (!objective) throw new Error("Mission objective must not be empty.");
		const requirements = normalizeRequirements(input.requirements?.length ? input.requirements : inferRequirements(objective));
		const title = normalizeTitle(input.title) || deriveMissionTitle(objective, requirements);
		const baseSlug = slugify(title).slice(0, 42) || "mission";
		const chain = input.chain?.trim() || await chooseDefaultChain(ctx.cwd, title, baseSlug);
		const now = Date.now();
		const missionId = `m_${now.toString(36)}_${randomUUID().slice(0, 6)}`;
		const slug = `${baseSlug}-${missionId.slice(-6)}`;
		const baseline = aggregateUsage(ctx.sessionManager.getBranch() as Array<any>);
		return {
			kind: "created",
			missionId,
			at: now,
			objective,
			title,
			requirements,
			status: "active",
			slug,
			chain,
			chainBranch: input.chainBranch?.trim() || DEFAULT_CHAIN_BRANCH,
			artifactDir: missionDir(ctx.cwd, slug),
			paths: normalizePaths(input.paths),
			tokenBudget: positiveNumber(input.tokenBudget, "tokenBudget"),
			costBudgetUsd: positiveNumber(input.costBudgetUsd ?? 1_000, "costBudgetUsd"),
			baselineMainTokens: baseline.mainTokens,
			baselineSubagentTokens: baseline.subagentTokens,
			baselineMainCostUsd: baseline.mainCostUsd,
			baselineSubagentCostUsd: baseline.subagentCostUsd,
			generation: randomUUID(),
			objectiveVersion: 1,
			turnBudget: positiveInteger(input.turnBudget, "turnBudget"),
			wallDeadlineAt: input.wallDeadlineMs === undefined ? undefined : now + positiveNumber(input.wallDeadlineMs, "wallDeadlineMs")!,
			reviewStatus: "not_required",
			blockerCount: 0,
			turnCount: 0,
		};
	}

	append(pi: { appendEntry<T = unknown>(customType: string, data?: T): void }, event: MissionEvent): MissionCurrent | undefined {
		pi.appendEntry(MISSION_CUSTOM_TYPE, event);
		this.applyEvent(event);
		return this.readAny();
	}

	statusEvent(status: MissionStatus, reason?: string, summary?: string): MissionEvent {
		const mission = this.requireCurrent();
		return { kind: status === "complete" ? "completed" : "status_changed", missionId: mission.missionId, generation: mission.generation, at: Date.now(), status, reason, summary };
	}

	continuedEvent(): MissionEvent {
		const mission = this.requireCurrent();
		return { kind: "continued", missionId: mission.missionId, generation: mission.generation, at: Date.now(), status: mission.status, turnCount: (mission.turnCount ?? 0) + 1 };
	}

	objectiveUpdateEvent(input: MissionUpdateInput): MissionEvent {
		const mission = this.requireCurrent();
		const objective = input.objective?.trim() || mission.objective;
		const requirements = input.requirements?.length ? normalizeRequirements(input.requirements) : mission.requirements;
		if (!input.reason.trim()) throw new Error("Mission objective updates require a reason.");
		return {
			kind: "objective_updated",
			missionId: mission.missionId,
			generation: mission.generation,
			at: Date.now(),
			objective,
			requirements,
			objectiveVersion: (mission.objectiveVersion ?? 1) + 1,
			reason: input.reason.trim(),
			...(input.paths !== undefined ? { paths: normalizePaths(input.paths) } : {}),
			...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget === null || input.tokenBudget === 0 ? null : positiveNumber(input.tokenBudget, "tokenBudget") } : {}),
			...(input.costBudgetUsd !== undefined ? { costBudgetUsd: input.costBudgetUsd === null || input.costBudgetUsd === 0 ? null : positiveNumber(input.costBudgetUsd, "costBudgetUsd") } : {}),
			...(input.turnBudget !== undefined ? { turnBudget: input.turnBudget === null || input.turnBudget === 0 ? null : positiveInteger(input.turnBudget, "turnBudget") } : {}),
			...(input.wallDeadlineMs !== undefined ? { wallDeadlineAt: input.wallDeadlineMs === null || input.wallDeadlineMs === 0 ? null : Date.now() + positiveNumber(input.wallDeadlineMs, "wallDeadlineMs")! } : {}),
			reviewStatus: "due",
			reviewReason: "Mission objective changed",
		};
	}

	reviewEvent(status: MissionReviewStatus, input: { runId?: string; reason?: string; skippedReason?: string; suggestedVerdict?: "clear" | "changes_requested" | "unknown"; failure?: boolean; worktreeFingerprint?: string } = {}): MissionEvent {
		const mission = this.requireCurrent();
		return {
			kind: "review_changed",
			missionId: mission.missionId,
			generation: mission.generation,
			at: Date.now(),
			reviewStatus: status,
			reviewRunId: input.runId,
			reviewReason: input.reason,
			reviewSkippedReason: input.skippedReason?.trim(),
			reviewSuggestedVerdict: input.suggestedVerdict,
			reviewFailure: input.failure,
			reviewWorktreeFingerprint: input.worktreeFingerprint,
		};
	}

	settledEvent(input: { blockerFingerprint?: string; madeProgress: boolean }): MissionEvent {
		const mission = this.requireCurrent();
		const sameBlocker = input.blockerFingerprint && input.blockerFingerprint === mission.blockerFingerprint;
		return {
			kind: "settled",
			missionId: mission.missionId,
			generation: mission.generation,
			at: Date.now(),
			blockerFingerprint: input.blockerFingerprint,
			blockerCount: input.madeProgress ? 0 : sameBlocker ? (mission.blockerCount ?? 0) + 1 : input.blockerFingerprint ? 1 : 0,
		};
	}

	progressEvent(input: MissionProgressInput): MissionEvent {
		const mission = this.requireCurrent();
		const summary = input.summary.trim();
		if (!summary) throw new Error("mission_progress summary must not be empty.");
		const blockerId = input.blockerId?.trim();
		if (input.blocked && !blockerId) throw new Error("blocked Mission progress requires blockerId.");
		return {
			kind: "progress",
			missionId: mission.missionId,
			generation: mission.generation,
			at: Date.now(),
			summary: summary.slice(0, 1200),
			evidence: normalizeProgressList(input.evidence, 20),
			remaining: normalizeProgressList(input.remaining, 20),
			validation: normalizeValidation(input.validation, mission.objectiveVersion ?? 1),
			checkpoint: input.checkpoint === true,
			blocked: input.blocked === true,
			blockerId: blockerId?.slice(0, 160),
		};
	}

	limitExceeded(): "token" | "cost" | "turn" | "wall" | null {
		const mission = this.current;
		if (!mission) return null;
		if (mission.tokenBudget !== undefined && this.usage.totalTokens >= mission.tokenBudget) return "token";
		if (mission.costBudgetUsd !== undefined && this.usage.totalCostUsd >= mission.costBudgetUsd) return "cost";
		if (mission.turnBudget !== undefined && (mission.turnCount ?? 0) >= mission.turnBudget) return "turn";
		if (mission.wallDeadlineAt !== undefined && Date.now() >= mission.wallDeadlineAt) return "wall";
		return null;
	}

	budgetExceeded(): "token" | "cost" | "turn" | "wall" | null {
		return this.current?.status === "active" ? this.limitExceeded() : null;
	}

	private requireCurrent(): MissionCurrent {
		if (!this.current || this.current.status === "cleared") throw new Error("No mission is active on this branch.");
		return this.current;
	}

	private applyEvent(event: MissionEvent): void {
		if (event.kind === "created") {
			if (!event.objective || !event.slug || !event.chain || !event.artifactDir) return;
			const requirements = normalizeRequirements(event.requirements?.length ? event.requirements : inferRequirements(event.objective));
			this.progress = [];
			this.current = {
				missionId: event.missionId,
				objective: event.objective,
				title: normalizeTitle(event.title) || deriveMissionTitle(event.objective, requirements),
				requirements,
				status: event.status ?? "active",
				createdAt: event.at,
				updatedAt: event.at,
				slug: event.slug,
				chain: event.chain,
				chainBranch: event.chainBranch ?? DEFAULT_CHAIN_BRANCH,
				artifactDir: event.artifactDir,
				paths: normalizePaths(event.paths),
				tokenBudget: event.tokenBudget ?? undefined,
				costBudgetUsd: event.costBudgetUsd ?? undefined,
				baselineMainTokens: event.baselineMainTokens ?? 0,
				baselineSubagentTokens: event.baselineSubagentTokens ?? 0,
				baselineMainCostUsd: event.baselineMainCostUsd ?? 0,
				baselineSubagentCostUsd: event.baselineSubagentCostUsd ?? 0,
				generation: event.generation ?? `legacy-${event.missionId}`,
				objectiveVersion: event.objectiveVersion ?? 1,
				turnBudget: event.turnBudget ?? undefined,
				wallDeadlineAt: event.wallDeadlineAt ?? undefined,
				reviewStatus: event.reviewStatus ?? "not_required",
				reviewRunId: event.reviewRunId,
				reviewReason: event.reviewReason,
				reviewSkippedReason: event.reviewSkippedReason,
				blockerFingerprint: event.blockerFingerprint,
				blockerCount: event.blockerCount ?? 0,
				turnCount: event.turnCount ?? 0,
			};
			return;
		}
		if (!this.current || this.current.missionId !== event.missionId) return;
		if (event.generation && this.current.generation && event.generation !== this.current.generation) return;
		this.current.updatedAt = event.at;
		if (event.status) this.current.status = event.status;
		if (event.reason) this.current.lastReason = event.reason;
		if (event.summary) this.current.lastSummary = event.summary;
		if (event.kind === "continued") {
			this.current.lastContinuationAt = event.at;
			this.current.turnCount = event.turnCount ?? (this.current.turnCount ?? 0) + 1;
		}
		if (event.kind === "objective_updated") {
			if (event.objective) this.current.objective = event.objective;
			if (event.requirements) this.current.requirements = normalizeRequirements(event.requirements);
			if (event.paths !== undefined) this.current.paths = normalizePaths(event.paths);
			if (event.tokenBudget !== undefined) this.current.tokenBudget = event.tokenBudget ?? undefined;
			if (event.costBudgetUsd !== undefined) this.current.costBudgetUsd = event.costBudgetUsd ?? undefined;
			if (event.turnBudget !== undefined) this.current.turnBudget = event.turnBudget ?? undefined;
			if (event.wallDeadlineAt !== undefined) this.current.wallDeadlineAt = event.wallDeadlineAt ?? undefined;
			this.current.objectiveVersion = event.objectiveVersion ?? (this.current.objectiveVersion ?? 1) + 1;
		}
		if (event.reviewStatus) this.current.reviewStatus = event.reviewStatus;
		if (event.reviewRunId !== undefined) this.current.reviewRunId = event.reviewRunId;
		if (event.reviewReason !== undefined) this.current.reviewReason = event.reviewReason;
		if (event.reviewSkippedReason !== undefined) this.current.reviewSkippedReason = event.reviewSkippedReason;
		if (event.reviewSuggestedVerdict !== undefined) this.current.reviewSuggestedVerdict = event.reviewSuggestedVerdict;
		if (event.reviewFailure !== undefined) this.current.reviewFailure = event.reviewFailure;
		if (event.reviewWorktreeFingerprint !== undefined) this.current.reviewWorktreeFingerprint = event.reviewWorktreeFingerprint;
		if (event.kind === "settled") {
			this.current.blockerFingerprint = event.blockerFingerprint;
			this.current.blockerCount = event.blockerCount ?? 0;
		}
		if (event.kind === "progress" && event.summary) {
			this.progress.push({
				missionId: event.missionId,
				at: event.at,
				summary: event.summary,
				evidence: normalizeProgressList(event.evidence, 20),
				remaining: normalizeProgressList(event.remaining, 20),
				validation: normalizeValidation(event.validation, this.current.objectiveVersion ?? 1),
				checkpoint: event.checkpoint === true,
				blocked: event.blocked === true,
				blockerId: event.blockerId,
			});
		}
	}
}

async function chooseDefaultChain(cwd: string, title: string, slug: string): Promise<string> {
	const chains = await new ChainService(cwd).list().catch(() => []);
	const matches = chains.filter((item) => chainMatches(item.chain, title, slug));
	if (matches.length === 1) return matches[0]!.chain;
	return `mission-${slug}`.slice(0, 60);
}

function chainMatches(chain: string, _title: string, slug: string): boolean {
	return chain.toLowerCase() === slug;
}

function normalizeTitle(value: string | undefined): string | undefined {
	const title = value?.trim().replace(/\s+/g, " ");
	return title ? title.slice(0, 80) : undefined;
}

function inferRequirements(objective: string): string[] {
	return normalizeRequirements([objective]);
}

function normalizeProgressList(values: string[] | undefined, maxItems: number): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values ?? []) {
		const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 500);
		if (!cleaned) continue;
		const key = cleaned.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(cleaned);
		if (result.length >= maxItems) break;
	}
	return result;
}

function normalizePaths(values: string[] | undefined): string[] {
	const result: string[] = [];
	for (const value of values ?? []) {
		const path = normalizePath(value.trim()).replaceAll("\\", "/");
		if (!path || path === "." || isAbsolute(path) || path === ".." || path.startsWith("../")) throw new Error(`Mission path must stay relative to the project: ${value}`);
		if (!result.includes(path)) result.push(path);
		if (result.length >= 100) break;
	}
	return result;
}

function normalizeValidation(values: Array<MissionValidationInput | MissionValidationRecord> | undefined, objectiveVersion: number): MissionValidationRecord[] {
	return (values ?? []).slice(0, 20).flatMap((value) => {
		const command = value.command?.trim().replace(/\s+/g, " ").slice(0, 500);
		if (!command || !Number.isInteger(value.exitCode)) return [];
		const summary = value.summary?.trim().replace(/\s+/g, " ").slice(0, 500);
		const artifact = value.artifact?.trim().slice(0, 500);
		const version = "objectiveVersion" in value && Number.isInteger(value.objectiveVersion) ? value.objectiveVersion : objectiveVersion;
		return [{ command, exitCode: value.exitCode, objectiveVersion: version, ...(summary ? { summary } : {}), ...(artifact ? { artifact } : {}) }];
	});
}

function normalizeRequirements(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const cleaned = value.trim().replace(/^[-*\d.)\s]+/, "").replace(/\s+/g, " ").slice(0, 240);
		if (!cleaned) continue;
		const key = cleaned.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(cleaned);
		if (result.length >= 12) break;
	}
	return result;
}

function deriveMissionTitle(objective: string, requirements: string[]): string {
	const source = requirements[0] ?? objective;
	const words = source.normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
	const title = words.length ? words.slice(0, 6).map(titleCaseWord).join(" ") : "Mission";
	return title.slice(0, 80);
}

function titleCaseWord(word: string): string {
	return word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word;
}

function positiveNumber(value: number | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive when provided.`);
	return value;
}

function positiveInteger(value: number | undefined, name: string): number | undefined {
	const positive = positiveNumber(value, name);
	return positive === undefined ? undefined : Math.floor(positive);
}

function usageFromAggregate(aggregate: MissionUsage, mission: MissionCurrent): MissionUsage {
	const usage: MissionUsage = {
		mainTokens: Math.max(0, aggregate.mainTokens - mission.baselineMainTokens),
		subagentTokens: Math.max(0, aggregate.subagentTokens - mission.baselineSubagentTokens),
		totalTokens: 0,
		mainCostUsd: Math.max(0, aggregate.mainCostUsd - mission.baselineMainCostUsd),
		subagentCostUsd: Math.max(0, aggregate.subagentCostUsd - mission.baselineSubagentCostUsd),
		totalCostUsd: 0,
	};
	usage.totalTokens = usage.mainTokens + usage.subagentTokens;
	usage.totalCostUsd = usage.mainCostUsd + usage.subagentCostUsd;
	return usage;
}

function aggregateUsage(branch: Array<any>, cutoffMs?: number): MissionUsage {
	const seenSubagents = new Set<string>();
	const usage = zeroUsage();
	for (const entry of branch) {
		if (cutoffMs !== undefined && entryTimestampMs(entry) > cutoffMs) continue;
		addUsageFromEntry(usage, entry, seenSubagents);
	}
	usage.totalTokens = usage.mainTokens + usage.subagentTokens;
	usage.totalCostUsd = usage.mainCostUsd + usage.subagentCostUsd;
	return usage;
}

function addUsageFromEntry(usage: MissionUsage, entry: any, seenSubagents: Set<string>): void {
	if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) addMainUsage(usage, entry.message.usage);
	const runtimeEvent = entry.type === "custom" && entry.customType === "deevs.runtime-event-op.v1" && entry.data?.type === "emit" ? entry.data.event : undefined;
	if (runtimeEvent?.source?.kind === "subagent" && runtimeEvent.usage) {
		const key = `${runtimeEvent.source.id}:${runtimeEvent.source.generation ?? "legacy"}`;
		if (!seenSubagents.has(key)) {
			seenSubagents.add(key);
			usage.subagentTokens += numberValue(runtimeEvent.usage.inputTokens) + numberValue(runtimeEvent.usage.outputTokens) + numberValue(runtimeEvent.usage.cacheWriteTokens);
			usage.subagentCostUsd += numberValue(runtimeEvent.usage.costUsd);
		}
	}
	const details = entry.type === "custom_message" && entry.customType === "subagents" ? entry.details : entry.type === "message" && entry.message?.role === "toolResult" ? entry.message.details : undefined;
	addSubagentUsageFromDetails(usage, details, seenSubagents);
	usage.totalTokens = usage.mainTokens + usage.subagentTokens;
	usage.totalCostUsd = usage.mainCostUsd + usage.subagentCostUsd;
}

function entryTimestampMs(entry: any): number {
	const timestamp = Date.parse(entry?.timestamp ?? "");
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function addMainUsage(target: MissionUsage, raw: any): void {
	target.mainTokens += billableTokens(raw);
	target.mainCostUsd += numberValue(raw.cost?.total);
}

function addSubagentUsageFromDetails(target: MissionUsage, details: any, seen: Set<string>): void {
	const runs = [details?.run, ...(Array.isArray(details?.runs) ? details.runs : [])].filter(Boolean);
	if (details?.group?.usage && details.group.id && !seen.has(details.group.id)) {
		seen.add(details.group.id);
		target.subagentTokens += billableTokens(details.group.usage);
		target.subagentCostUsd += numberValue(details.group.usage.cost?.total);
	}
	for (const run of runs) {
		if (!run?.id || !run.usage || seen.has(run.id)) continue;
		seen.add(run.id);
		target.subagentTokens += billableTokens(run.usage);
		target.subagentCostUsd += numberValue(run.usage.cost?.total);
	}
}

function billableTokens(raw: any): number {
	const input = numberValue(raw?.input ?? raw?.inputTokens);
	const cacheWrite = numberValue(raw?.cacheWrite ?? raw?.cacheCreationInputTokens);
	const output = numberValue(raw?.output ?? raw?.outputTokens);
	const computed = Math.max(0, input) + Math.max(0, cacheWrite) + Math.max(0, output);
	return computed || numberValue(raw?.totalTokens ?? raw?.total);
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function zeroUsage(): MissionUsage {
	return { mainTokens: 0, subagentTokens: 0, totalTokens: 0, mainCostUsd: 0, subagentCostUsd: 0, totalCostUsd: 0 };
}
