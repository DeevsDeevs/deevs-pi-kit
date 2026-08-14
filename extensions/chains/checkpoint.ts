import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CHAIN_CHECKPOINT_ENTRY = "deevs.chain-checkpoint.v1";

export type ChainDueCode = "context_pressure" | "material_change" | "mission_milestone" | "mission_control" | "branch_created" | "other";

export interface ChainCheckpointState {
	chain?: string;
	branch?: string;
	status: "idle" | "saved" | "due";
	dueReasons: string[];
	dueCodes: ChainDueCode[];
	updatedAt: number;
	lastSavedAt?: number;
	waiverReason?: string;
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
		return { ...state, status: "due", dueReasons, dueCodes, waiverReason: undefined, updatedAt: operation.at, contextPressureHandled: state.contextPressureHandled || code === "context_pressure" };
	}
	if (operation.type === "saved") {
		return {
			...state,
			chain: operation.chain,
			branch: operation.branch,
			status: "saved",
			dueReasons: [],
			dueCodes: [],
			waiverReason: undefined,
			updatedAt: operation.at,
			lastSavedAt: operation.at,
		};
	}
	if (operation.type === "waived") return { ...state, status: "saved", dueReasons: [], dueCodes: [], waiverReason: operation.reason, updatedAt: operation.at };
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
	private forcedWakeAt?: number;

	constructor(private readonly pi: ExtensionAPI) {}

	read(): ChainCheckpointState {
		return this.state;
	}

	restore(ctx: ExtensionContext, remind = false): void {
		this.ctx = ctx;
		this.state = replayChainCheckpoint(ctx.sessionManager.getBranch());
		this.remindNextTurn ||= remind && this.state.status !== "idle";
		this.updateStatus();
	}

	record(operation: ChainCheckpointOperation): void {
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

	waive(reason: string): void {
		if (!reason.trim()) throw new Error("A Chain checkpoint waiver requires a reason.");
		this.record({ type: "waived", reason: reason.trim(), at: Date.now() });
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

	immediateCheckpointDue(): boolean {
		return this.state.status === "due" && this.state.dueCodes.includes("context_pressure");
	}

	blockTool(toolName: string): string | undefined {
		return this.immediateCheckpointDue() && toolName !== "chain_save"
			? "Context is at least 80% full. Save the required Chain checkpoint with chain_save before using any other tool, or ask the user to waive it with /chain-waive <reason>."
			: undefined;
	}

	forceCheckpointTurn(ctx: ExtensionContext): void {
		if (!this.immediateCheckpointDue() || this.forcedWakeAt === this.state.updatedAt || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		this.pi.sendMessage({
			customType: "chain-checkpoint",
			content: "Context is at least 80% full and the required Chain checkpoint is still due. Call chain_save now before any other work. If the user explicitly waives it, they can run /chain-waive <reason>.",
			display: false,
			details: { version: 1, updatedAt: this.state.updatedAt },
		}, { triggerTurn: true, deliverAs: "followUp" });
		this.forcedWakeAt = this.state.updatedAt;
	}

	beforeAgentStart(systemPrompt: string): string | undefined {
		if (this.state.status !== "due" && !this.remindNextTurn) return undefined;
		this.remindNextTurn = false;
		const target = this.state.chain ? `${this.state.chain}@${this.state.branch ?? "main"}` : "the relevant Chain";
		const reasons = this.state.dueReasons.length ? ` Reasons: ${this.state.dueReasons.join("; ")}.` : "";
		const instruction = this.state.status === "due"
			? this.state.dueCodes.includes("context_pressure")
				? " Context is at least 80% full: call chain_save before any other work."
				: " The milestone already created this obligation: call chain_save before starting further substantive work."
			: " Load this Chain before rediscovery and continue from its recorded next step.";
		return `${systemPrompt}\n\nChain checkpoint: ${this.state.status === "due" ? "a durable checkpoint is due" : "resume with the active Chain"} for ${target}.${reasons}${instruction} Do not claim completion while a checkpoint is due unless it is explicitly waived with a reason.`;
	}

	clearStatus(): void {
		this.ctx?.ui.setStatus("chains", undefined);
		this.ctx = undefined;
	}

	private updateStatus(): void {
		if (!this.ctx) return;
		if (this.state.status === "idle") {
			this.ctx.ui.setStatus("chains", undefined);
			return;
		}
		this.ctx.ui.setStatus("chains", this.state.status === "due" ? this.ctx.ui.theme?.fg("warning", "chain due") ?? "chain due" : undefined);
	}
}

export function registerChainCheckpoint(pi: ExtensionAPI, service: ChainCheckpointService): void {
	const toolArgs = new Map<string, unknown>();
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
		service.forceCheckpointTurn(ctx);
	});
	pi.on("before_agent_start", (event, ctx) => {
		service.restore(ctx);
		service.checkContextPressure(ctx);
		const systemPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
		const next = service.beforeAgentStart(systemPrompt);
		return next ? { systemPrompt: next } : undefined;
	});
	pi.on("tool_call", (event, ctx) => {
		service.restore(ctx);
		service.checkContextPressure(ctx);
		const reason = service.blockTool(event.toolName);
		if (reason) return { block: true, reason };
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
		if (event.toolName === "chain_save" && typeof args?.chain === "string") {
			const link = asRecord(details?.link);
			service.saved(args.chain, typeof args.branch === "string" ? args.branch : "main", typeof link?.filename === "string" ? link.filename : undefined);
			return;
		}
		if ((event.toolName === "chain_load" || event.toolName === "chain_context") && typeof args?.chain === "string") {
			service.activate(args.chain, typeof args.branch === "string" ? args.branch : "main");
			return;
		}
		if (event.toolName === "chain_fork" && typeof args?.chain === "string" && typeof args.branch === "string") {
			service.activate(args.chain, args.branch);
			service.due("new Chain branch has no checkpoint", "branch_created");
			return;
		}
		if (event.toolName === "mission_progress" && args?.checkpoint === true) service.due("Mission milestone recorded", "mission_milestone");
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

function parseOperation(value: unknown): ChainCheckpointOperation | undefined {
	const operation = asRecord(value);
	if (!operation || typeof operation.type !== "string" || typeof operation.at !== "number") return undefined;
	if (operation.type === "activate" && typeof operation.chain === "string" && typeof operation.branch === "string") return operation as unknown as ChainCheckpointOperation;
	if (operation.type === "due" && typeof operation.reason === "string") {
		const codes: ChainDueCode[] = ["context_pressure", "material_change", "mission_milestone", "mission_control", "branch_created", "other"];
		return { type: "due", reason: operation.reason, code: typeof operation.code === "string" && codes.includes(operation.code as ChainDueCode) ? operation.code as ChainDueCode : "other", at: operation.at };
	}
	if (operation.type === "saved" && typeof operation.chain === "string" && typeof operation.branch === "string") return operation as unknown as ChainCheckpointOperation;
	if (operation.type === "waived" && typeof operation.reason === "string") return operation as unknown as ChainCheckpointOperation;
	if (operation.type === "context_reset") return operation as unknown as ChainCheckpointOperation;
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const globalRegistry = globalThis as typeof globalThis & { __deevsPiKitChainCheckpoints?: { current?: ChainCheckpointService } };
export const chainCheckpoints = globalRegistry.__deevsPiKitChainCheckpoints ??= {};
