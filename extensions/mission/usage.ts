import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { RUNTIME_EVENT_ENTRY } from "../shared/runtime-events.ts";
import type { MissionCurrent, MissionUsage } from "./types.ts";

const SUBAGENT_ENTRY = "subagents";

/** Token counters as any Pi producer may spell them; every field is optional because the branch is untrusted. */
export interface RawTokenUsage {
	input?: number | null;
	inputTokens?: number | null;
	cacheWrite?: number | null;
	cacheCreationInputTokens?: number | null;
	output?: number | null;
	outputTokens?: number | null;
	totalTokens?: number | null;
	total?: number | null;
	cost?: { total?: number | null } | null;
}

interface SubagentUsageHolder {
	id?: string | null;
	usage?: RawTokenUsage | null;
}

/** Subagent accounting attached to a `subagents` custom message or a toolResult message. */
export interface SubagentUsageDetails {
	group?: SubagentUsageHolder | null;
	run?: SubagentUsageHolder | null;
	runs?: Array<SubagentUsageHolder | null> | null;
}

interface RuntimeUsageSource {
	kind?: string | null;
	id?: string | null;
	generation?: string | number | null;
}

interface RuntimeEventUsage {
	inputTokens?: number | null;
	outputTokens?: number | null;
	cacheWriteTokens?: number | null;
	costUsd?: number | null;
}

interface RuntimeUsageEvent {
	source?: RuntimeUsageSource | null;
	usage?: RuntimeEventUsage | null;
}

interface RuntimeEventOp {
	type?: string | null;
	event?: RuntimeUsageEvent | null;
}

interface UsageMessage {
	role?: string | null;
	usage?: RawTokenUsage | null;
	details?: SubagentUsageDetails | null;
}

export function zeroUsage(): MissionUsage {
	return { mainTokens: 0, subagentTokens: 0, totalTokens: 0, mainCostUsd: 0, subagentCostUsd: 0, totalCostUsd: 0 };
}

export function addUsage(left: MissionUsage, right: MissionUsage): MissionUsage {
	return {
		mainTokens: left.mainTokens + right.mainTokens,
		subagentTokens: left.subagentTokens + right.subagentTokens,
		totalTokens: left.totalTokens + right.totalTokens,
		mainCostUsd: left.mainCostUsd + right.mainCostUsd,
		subagentCostUsd: left.subagentCostUsd + right.subagentCostUsd,
		totalCostUsd: left.totalCostUsd + right.totalCostUsd,
	};
}

/** Subtracts the baseline captured when the Mission started, so usage reflects Mission work alone. */
export function usageFromAggregate(aggregate: MissionUsage, mission: MissionCurrent): MissionUsage {
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

export function aggregateUsage(branch: SessionEntry[]): MissionUsage {
	const seenSubagents = new Set<string>();
	const usage = zeroUsage();
	for (const entry of branch) addUsageFromEntry(usage, entry, seenSubagents);
	usage.totalTokens = usage.mainTokens + usage.subagentTokens;
	usage.totalCostUsd = usage.mainCostUsd + usage.subagentCostUsd;
	return usage;
}

export function addUsageFromEntry(usage: MissionUsage, entry: SessionEntry, seenSubagents: Set<string>): void {
	const message = entryMessage(entry);
	if (message?.role === "assistant" && message.usage) addMainUsage(usage, message.usage);
	addRuntimeEventUsage(usage, runtimeUsageEvent(entry), seenSubagents);
	addSubagentUsageFromDetails(usage, subagentDetails(entry, message), seenSubagents);
	usage.totalTokens = usage.mainTokens + usage.subagentTokens;
	usage.totalCostUsd = usage.mainCostUsd + usage.subagentCostUsd;
}

function entryMessage(entry: SessionEntry): UsageMessage | undefined {
	if (entry.type !== "message") return undefined;
	// SAFETY: session entries are untrusted; only optional numeric usage fields are read from the message.
	return entry.message as UsageMessage | undefined;
}

function runtimeUsageEvent(entry: SessionEntry): RuntimeUsageEvent | undefined {
	if (entry.type !== "custom") return undefined;
	if (entry.customType !== RUNTIME_EVENT_ENTRY) return undefined;
	// SAFETY: runtime event ops are written by this package; only identity and numeric usage fields are read.
	const op = entry.data as RuntimeEventOp | undefined;
	return op?.type === "emit" ? op.event ?? undefined : undefined;
}

function subagentDetails(entry: SessionEntry, message: UsageMessage | undefined): SubagentUsageDetails | undefined {
	if (entry.type === "custom_message" && entry.customType === SUBAGENT_ENTRY) {
		// SAFETY: session entries are untrusted; only optional id and numeric usage fields are read from the details.
		return entry.details as SubagentUsageDetails | undefined;
	}
	if (message?.role !== "toolResult") return undefined;
	return message.details ?? undefined;
}

function addRuntimeEventUsage(target: MissionUsage, event: RuntimeUsageEvent | undefined, seen: Set<string>): void {
	if (event?.source?.kind !== "subagent") return;
	if (!event.usage) return;
	const key = `${event.source.id}:${event.source.generation ?? "legacy"}`;
	if (seen.has(key)) return;
	seen.add(key);
	target.subagentTokens += numberValue(event.usage.inputTokens)
		+ numberValue(event.usage.outputTokens)
		+ numberValue(event.usage.cacheWriteTokens);
	target.subagentCostUsd += numberValue(event.usage.costUsd);
}

function addMainUsage(target: MissionUsage, raw: RawTokenUsage): void {
	target.mainTokens += billableTokens(raw);
	target.mainCostUsd += numberValue(raw.cost?.total);
}

function addSubagentUsageFromDetails(target: MissionUsage, details: SubagentUsageDetails | undefined, seen: Set<string>): void {
	const holders = [details?.group, details?.run, ...(Array.isArray(details?.runs) ? details.runs : [])];
	for (const holder of holders) {
		if (!holder?.id || !holder.usage) continue;
		if (seen.has(holder.id)) continue;
		seen.add(holder.id);
		target.subagentTokens += billableTokens(holder.usage);
		target.subagentCostUsd += numberValue(holder.usage.cost?.total);
	}
}

function billableTokens(raw: RawTokenUsage | null | undefined): number {
	const input = numberValue(raw?.input ?? raw?.inputTokens);
	const cacheWrite = numberValue(raw?.cacheWrite ?? raw?.cacheCreationInputTokens);
	const output = numberValue(raw?.output ?? raw?.outputTokens);
	const computed = Math.max(0, input) + Math.max(0, cacheWrite) + Math.max(0, output);
	return computed || numberValue(raw?.totalTokens ?? raw?.total);
}

function numberValue(value: number | null | undefined): number {
	return value !== null && value !== undefined && Number.isFinite(value) ? value : 0;
}
