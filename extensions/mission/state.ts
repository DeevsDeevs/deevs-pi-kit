import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ChainService } from "../chains/service.ts";
import { slugify } from "../chains/parser.ts";
import { missionDir } from "./artifacts.ts";
import type { MissionCreateInput, MissionCurrent, MissionEvent, MissionProgressInput, MissionProgressRecord, MissionStatus, MissionUsage } from "./types.ts";

export const MISSION_CUSTOM_TYPE = "deevs-mission-state";
const DEFAULT_CHAIN_BRANCH = "main";

export class MissionState {
	private current: MissionCurrent | undefined;
	private usage: MissionUsage = zeroUsage();
	private progress: MissionProgressRecord[] = [];

	read(): MissionCurrent | undefined {
		if (!this.current || this.current.status === "cleared" || this.current.status === "complete") return undefined;
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
		return this.progress.map((item) => ({ ...item, evidence: [...item.evidence], remaining: [...item.remaining], validation: [...item.validation] }));
	}

	loadFromSession(ctx: ExtensionContext): void {
		const branch = ctx.sessionManager.getBranch() as Array<any>;
		const rolling = zeroUsage();
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
				continue;
			}
			addUsageFromEntry(rolling, entry, seenSubagents);
		}
		this.usage = this.current ? computeUsage(branch, this.current) : zeroUsage();
	}

	async create(input: MissionCreateInput, ctx: ExtensionContext): Promise<MissionEvent> {
		const objective = input.objective.trim();
		if (!objective) throw new Error("Mission objective must not be empty.");
		const requirements = normalizeRequirements(input.requirements?.length ? input.requirements : inferRequirements(objective));
		const title = normalizeTitle(input.title) || deriveMissionTitle(objective, requirements);
		const slug = slugify(title).slice(0, 50) || "mission";
		const chain = input.chain?.trim() || await chooseDefaultChain(ctx.cwd, title, slug);
		const now = Date.now();
		const baseline = aggregateUsage(ctx.sessionManager.getBranch() as Array<any>);
		return {
			kind: "created",
			missionId: `m_${now.toString(36)}`,
			at: now,
			objective,
			title,
			requirements,
			status: "active",
			slug,
			chain,
			chainBranch: input.chainBranch?.trim() || DEFAULT_CHAIN_BRANCH,
			artifactDir: missionDir(ctx.cwd, slug),
			tokenBudget: positiveNumber(input.tokenBudget, "tokenBudget"),
			costBudgetUsd: positiveNumber(input.costBudgetUsd, "costBudgetUsd"),
			baselineMainTokens: baseline.mainTokens,
			baselineSubagentTokens: baseline.subagentTokens,
			baselineMainCostUsd: baseline.mainCostUsd,
			baselineSubagentCostUsd: baseline.subagentCostUsd,
		};
	}

	append(pi: { appendEntry<T = unknown>(customType: string, data?: T): void }, event: MissionEvent): MissionCurrent | undefined {
		pi.appendEntry(MISSION_CUSTOM_TYPE, event);
		this.applyEvent(event);
		return this.readAny();
	}

	statusEvent(status: MissionStatus, reason?: string, summary?: string): MissionEvent {
		const mission = this.requireCurrent();
		return { kind: status === "complete" ? "completed" : "status_changed", missionId: mission.missionId, at: Date.now(), status, reason, summary };
	}

	continuedEvent(): MissionEvent {
		const mission = this.requireCurrent();
		return { kind: "continued", missionId: mission.missionId, at: Date.now(), status: mission.status };
	}

	progressEvent(input: MissionProgressInput): MissionEvent {
		const mission = this.requireCurrent();
		const summary = input.summary.trim();
		if (!summary) throw new Error("mission_progress summary must not be empty.");
		return {
			kind: "progress",
			missionId: mission.missionId,
			at: Date.now(),
			summary: summary.slice(0, 1200),
			evidence: normalizeProgressList(input.evidence, 20),
			remaining: normalizeProgressList(input.remaining, 20),
			validation: normalizeProgressList(input.validation, 20),
			checkpoint: input.checkpoint === true,
		};
	}

	budgetExceeded(): "token" | "cost" | null {
		const mission = this.current;
		if (!mission || mission.status !== "active") return null;
		if (mission.tokenBudget !== undefined && this.usage.totalTokens >= mission.tokenBudget) return "token";
		if (mission.costBudgetUsd !== undefined && this.usage.totalCostUsd >= mission.costBudgetUsd) return "cost";
		return null;
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
				tokenBudget: event.tokenBudget,
				costBudgetUsd: event.costBudgetUsd,
				baselineMainTokens: event.baselineMainTokens ?? 0,
				baselineSubagentTokens: event.baselineSubagentTokens ?? 0,
				baselineMainCostUsd: event.baselineMainCostUsd ?? 0,
				baselineSubagentCostUsd: event.baselineSubagentCostUsd ?? 0,
			};
			return;
		}
		if (!this.current || this.current.missionId !== event.missionId) return;
		this.current.updatedAt = event.at;
		if (event.status) this.current.status = event.status;
		if (event.reason) this.current.lastReason = event.reason;
		if (event.summary) this.current.lastSummary = event.summary;
		if (event.kind === "continued") this.current.lastContinuationAt = event.at;
		if (event.kind === "progress" && event.summary) {
			this.progress.push({
				missionId: event.missionId,
				at: event.at,
				summary: event.summary,
				evidence: normalizeProgressList(event.evidence, 20),
				remaining: normalizeProgressList(event.remaining, 20),
				validation: normalizeProgressList(event.validation, 20),
				checkpoint: event.checkpoint === true,
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

function chainMatches(chain: string, title: string, slug: string): boolean {
	const normalizedChain = chain.toLowerCase();
	const normalizedTitle = title.toLowerCase();
	return normalizedChain === slug || slug.includes(normalizedChain) || normalizedTitle.includes(normalizedChain.replace(/-/g, " "));
}

function normalizeTitle(value: string | undefined): string | undefined {
	const title = value?.trim().replace(/\s+/g, " ");
	return title ? title.slice(0, 80) : undefined;
}

function inferRequirements(objective: string): string[] {
	const text = objective.replace(/\r/g, "\n");
	const rawParts = text
		.split(/\n+|(?:^|\s)[-*]\s+|;|,(?=\s*\w)|\s+and\s+(?=\w)/i)
		.map((part) => part.trim())
		.filter(Boolean);
	const parts = rawParts.length > 1 ? rawParts : [objective.trim()];
	return normalizeRequirements(parts);
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
	const phrases = (requirements.length ? requirements : [objective]).map(keywordPhrase).filter(Boolean);
	const words: string[] = [];
	for (const phrase of phrases) {
		for (const word of phrase.split(/\s+/)) {
			if (!words.includes(word)) words.push(word);
			if (words.length >= 6) break;
		}
		if (words.length >= 6) break;
	}
	const title = words.length ? words.map(titleCaseWord).join(" ") : "Mission";
	return title.slice(0, 80);
}

function keywordPhrase(value: string): string {
	const stop = new Set(["a", "an", "the", "our", "my", "this", "that", "these", "those", "to", "for", "of", "in", "on", "with", "proper", "properly"]);
	const action = new Set(["check", "analyze", "analyse", "optimize", "improve", "fix", "update", "review", "test", "benchmark", "make", "create", "build", "do"]);
	const words = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	while (words.length && (action.has(words[0]!) || stop.has(words[0]!))) words.shift();
	return words.filter((word) => !stop.has(word)).slice(0, 4).join(" ");
}

function titleCaseWord(word: string): string {
	return word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word;
}

function positiveNumber(value: number | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive when provided.`);
	return value;
}

function computeUsage(branch: Array<any>, mission: MissionCurrent): MissionUsage {
	const cutoff = mission.status === "complete" || mission.status === "cleared" || mission.status === "budget_limited" ? mission.updatedAt : undefined;
	const aggregate = aggregateUsage(branch, cutoff);
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
	const runs = [details?.run, ...(Array.isArray(details?.runs) ? details.runs : []), ...(Array.isArray(details?.group?.children) ? [] : [])].filter(Boolean);
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
