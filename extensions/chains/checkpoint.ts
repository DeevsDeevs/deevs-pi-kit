import { Text } from "@earendil-works/pi-tui";
import type { CustomEntry, ExtensionAPI, ExtensionContext, ToolExecutionEndEvent, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";

export const CHAIN_CHECKPOINT_ENTRY = "deevs.chain-checkpoint.v1";

type CheckpointPayload = CustomEntry["data"] | ToolExecutionStartEvent["args"] | ToolExecutionEndEvent["result"];
type CheckpointValue = null | boolean | number | string | CheckpointValue[] | CheckpointObject;

interface CheckpointObject {
	[key: string]: CheckpointValue | undefined;
}

export type ChainDueCode = "context_pressure" | "material_change" | "branch_created" | "other";

export interface ChainCheckpointState {
	chain?: string;
	branch?: string;
	status: "idle" | "saved" | "due";
	dueReasons: string[];
	dueCodes: ChainDueCode[];
	updatedAt: number;
	contextPressureHandled: boolean;
}

export type ChainCheckpointOperation =
	| { type: "activate"; chain: string; branch: string; at: number }
	| { type: "due"; reason: string; code?: ChainDueCode; at: number }
	| { type: "saved"; chain: string; branch: string; link?: string; at: number }
	| { type: "waived"; reason: string; at: number }
	| { type: "context_reset"; at: number };

export function emptyChainCheckpoint(): ChainCheckpointState {
	return { status: "idle", dueReasons: [], dueCodes: [], updatedAt: 0, contextPressureHandled: false };
}

export function reduceChainCheckpoint(state: ChainCheckpointState, operation: ChainCheckpointOperation): ChainCheckpointState {
	if (operation.at < state.updatedAt) return state;
	if (operation.type === "activate") {
		return { ...state, chain: operation.chain, branch: operation.branch, updatedAt: operation.at };
	}
	if (operation.type === "due") {
		const code = operation.code ?? "other";
		const dueReasons = [...new Set([...state.dueReasons, operation.reason])].slice(-6);
		const dueCodes = [...new Set([...state.dueCodes, code])].slice(-6);
		return { ...state, status: "due", dueReasons, dueCodes, updatedAt: operation.at, contextPressureHandled: state.contextPressureHandled || code === "context_pressure" };
	}
	if (operation.type === "saved") return { ...state, chain: operation.chain, branch: operation.branch, status: "saved", dueReasons: [], dueCodes: [], updatedAt: operation.at };
	// Nothing records a waiver any more; sessions written before /chain-waive was removed still replay one.
	if (operation.type === "waived") return { ...state, status: "saved", dueReasons: [], dueCodes: [], updatedAt: operation.at };
	return { ...state, contextPressureHandled: false, updatedAt: operation.at };
}

export function replayChainCheckpoint(entries: readonly unknown[]): ChainCheckpointState {
	let state = emptyChainCheckpoint();
	for (const entry of entries) {
		const record = asRecord(entry);
		if (record?.type !== "custom" || record.customType !== CHAIN_CHECKPOINT_ENTRY) continue;
		const operation = parseOperation(record.data);
		if (operation) state = reduceChainCheckpoint(state, operation);
	}
	return state;
}

export class ChainCheckpointService {
	private state = emptyChainCheckpoint();
	private ctx?: ExtensionContext;
	private remindNextTurn = false;
	private gitBeforeTurn?: string;

	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) { this.pi = pi; }

	read(): ChainCheckpointState {
		return this.state;
	}

	restore(ctx: ExtensionContext, remind = false): void {
		this.ctx = ctx;
		this.state = replayChainCheckpoint(ctx.sessionManager.getBranch());
		this.remindNextTurn ||= remind && this.state.status !== "idle";
		this.updateStatus();
	}

	private record(operation: ChainCheckpointOperation): void {
		const next = reduceChainCheckpoint(this.state, operation);
		if (JSON.stringify(next) === JSON.stringify(this.state)) return;
		this.pi.appendEntry(CHAIN_CHECKPOINT_ENTRY, operation);
		this.state = next;
		this.updateStatus();
	}

	activate(chain: string, branch = "main"): void {
		this.record({ type: "activate", chain, branch, at: Date.now() });
	}

	due(reason: string, code: ChainDueCode = "other"): void {
		this.record({ type: "due", reason, code, at: Date.now() });
	}

	saved(chain: string, branch = "main", link?: string): void {
		this.record({ type: "saved", chain, branch, link, at: Date.now() });
	}

	async captureGitBeforeTurn(cwd: string): Promise<void> {
		this.gitBeforeTurn = await gitFingerprint(this.pi, cwd);
	}

	async detectGitMutation(cwd: string): Promise<void> {
		const before = this.gitBeforeTurn;
		const after = await gitFingerprint(this.pi, cwd);
		if (before !== undefined && after !== undefined && after !== before && await headAdvanced(this.pi, cwd, before, after)) this.due("repository HEAD advanced", "material_change");
		this.gitBeforeTurn = undefined;
	}

	checkContextPressure(ctx: ExtensionContext): void {
		const percent = ctx.getContextUsage()?.percent;
		if (percent === null || percent === undefined) return;
		if (percent < 80) {
			if (this.state.contextPressureHandled) this.record({ type: "context_reset", at: Date.now() });
			return;
		}
		if (this.state.contextPressureHandled) return;
		this.due("context usage reached 80%", "context_pressure");
	}

	contextCompacted(): void {
		if (this.state.contextPressureHandled) this.record({ type: "context_reset", at: Date.now() });
	}

	reminder(): string | undefined {
		if (this.state.status !== "due" && !this.remindNextTurn) return undefined;
		this.remindNextTurn = false;
		const target = this.state.chain ? `${this.state.chain}@${this.state.branch ?? "main"}` : "the relevant Chain";
		const reasons = this.state.dueReasons.length ? ` Reasons: ${this.state.dueReasons.join("; ")}.` : "";
		const instruction = this.state.status === "due"
			? this.state.dueCodes.includes("context_pressure")
				? " Context reached 80%: save a concise Chain checkpoint with chain_save before compaction drops detail. It is session metadata, not a code edit, so read-only/no-edit tasks need it too. If no Chain is active, choose a concise task-specific name."
				: " The milestone already created this obligation: call chain_save before starting further substantive work."
			: " Load this Chain before rediscovery and continue from its recorded next step.";
		return `Chain checkpoint: ${this.state.status === "due" ? "a durable checkpoint is due" : "resume with the active Chain"} for ${target}.${reasons}${instruction} Do not claim completion while a checkpoint is due.`;
	}

	clearStatus(): void {
		this.ctx?.ui.setStatus("chains", undefined);
		this.ctx = undefined;
	}

	private updateStatus(): void {
		this.ctx?.ui.setStatus("chains", this.state.status === "due" ? this.ctx.ui.theme?.fg("warning", "chain!") ?? "chain!" : undefined);
	}
}

export function registerChainCheckpoint(pi: ExtensionAPI, service: ChainCheckpointService): void {
	const toolArgs = new Map<string, ToolExecutionStartEvent["args"]>();
	pi.registerEntryRenderer<ChainCheckpointOperation>(CHAIN_CHECKPOINT_ENTRY, (entry, _options, theme) => {
		const operation = entry.data;
		if (operation?.type === "saved") {
			const text = `${theme.fg("success", "✓ chain saved")} ${theme.fg("accent", `${operation.chain}@${operation.branch}`)}${operation.link ? theme.fg("dim", ` ${operation.link}`) : ""}`;
			return new Text(text, 0, 0);
		}
		if (operation?.type === "waived") return new Text(`${theme.fg("warning", "! chain checkpoint waived")} ${operation.reason}`, 0, 0);
		if (operation?.type === "activate") return new Text(`${theme.fg("accent", "↪ chain active")} ${operation.chain}@${operation.branch}`, 0, 0);
		if (operation?.type === "due") return new Text(`${theme.fg("warning", "! chain checkpoint due")} ${operation.reason}`, 0, 0);
		return undefined;
	});

	pi.on("session_start", (_event, ctx) => service.restore(ctx, true));
	pi.on("session_tree", (_event, ctx) => service.restore(ctx, true));
	pi.on("session_compact", (_event, ctx) => {
		service.restore(ctx, true);
		service.contextCompacted();
	});
	pi.on("turn_start", async (_event, ctx) => {
		service.restore(ctx);
		await service.captureGitBeforeTurn(ctx.cwd);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		service.restore(ctx);
		await service.detectGitMutation(ctx.cwd);
		service.checkContextPressure(ctx);
	});
	pi.on("before_agent_start", (event, ctx) => {
		service.restore(ctx);
		service.checkContextPressure(ctx);
		const reminder = service.reminder();
		if (reminder) event.systemPromptOptions.sections.chain_checkpoint = reminder;
	});
	pi.on("tool_execution_start", (event) => {
		toolArgs.set(event.toolCallId, event.args);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		service.restore(ctx);
		const args = asRecord(toolArgs.get(event.toolCallId));
		toolArgs.delete(event.toolCallId);
		if (event.isError) return;
		const details = asRecord(asRecord(event.result)?.details);
		const chain = stringValue(args?.chain);
		const parsedBranch = stringValue(args?.branch);
		const branch = parsedBranch ?? "main";
		if (event.toolName === "chain_save" && chain !== undefined) {
			const filename = stringValue(asRecord(details?.link)?.filename);
			service.saved(chain, branch, filename);
			return;
		}
		if ((event.toolName === "chain_load" || event.toolName === "chain_context") && chain !== undefined) {
			service.activate(chain, branch);
			return;
		}
		if (event.toolName === "chain_fork" && chain !== undefined && parsedBranch !== undefined) {
			service.activate(chain, parsedBranch);
			service.due("new Chain branch has no checkpoint", "branch_created");
		}
	});
	pi.on("session_shutdown", () => {
		toolArgs.clear();
		service.clearStatus();
	});
}

async function headAdvanced(pi: ExtensionAPI, cwd: string, before: string, after: string): Promise<boolean> {
	try {
		return (await pi.exec("git", ["merge-base", "--is-ancestor", before, after], { cwd })).code === 0;
	} catch {
		return false;
	}
}

async function gitFingerprint(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd });
		return head.code === 0 ? head.stdout.trim() : undefined;
	} catch {
		return undefined;
	}
}

function parseOperation(value: CustomEntry["data"]): ChainCheckpointOperation | undefined {
	const operation = asRecord(value);
	if (!operation) return undefined;
	const type = stringValue(operation.type);
	const at = numberValue(operation.at);
	if (type === undefined || at === undefined) return undefined;
	const chain = stringValue(operation.chain);
	const branch = stringValue(operation.branch);
	if (type === "activate" && chain !== undefined && branch !== undefined) return { type, chain, branch, at };
	const reason = stringValue(operation.reason);
	if (type === "due" && reason !== undefined) return { type, reason, code: chainDueCode(operation.code) ?? "other", at };
	const link = stringValue(operation.link);
	if (type === "saved" && chain !== undefined && branch !== undefined && (operation.link === undefined || link !== undefined)) return { type, chain, branch, link, at };
	if (type === "waived" && reason !== undefined) return { type, reason, at };
	if (type === "context_reset") return { type, at };
	return undefined;
}

function chainDueCode(value: CheckpointValue | undefined): ChainDueCode | undefined {
	if (value === "context_pressure" || value === "material_change" || value === "branch_created" || value === "other") return value;
	return undefined;
}

function asRecord(value: CheckpointPayload): CheckpointObject | undefined {
	if (value === null || Array.isArray(value)) return undefined;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null ? Object.fromEntries(Object.entries(value)) : undefined;
	} catch {
		return undefined;
	}
}

function stringValue(value: CheckpointValue | undefined): string | undefined {
	try { return String.prototype.valueOf.call(value) === value ? value : undefined; } catch { return undefined; }
}

function numberValue(value: CheckpointValue | undefined): number | undefined {
	try { return Number.prototype.valueOf.call(value) === value ? value : undefined; } catch { return undefined; }
}
