import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { tasks } from "../shared/tasks.ts";

export const CHAIN_CHECKPOINT_ENTRY = "deevs.chain-checkpoint.v1";

const Target = { chain: Type.String(), branch: Type.String(), at: Type.Number() };
const Operation = Type.Union([
	Type.Object({ type: Type.Literal("activate"), ...Target }),
	Type.Object({ type: Type.Literal("due"), reason: Type.String(), at: Type.Number() }),
	Type.Object({ type: Type.Literal("reminded"), at: Type.Number() }),
	Type.Object({ type: Type.Literal("saved"), ...Target, link: Type.Optional(Type.String()) }),
	Type.Object({ type: Type.Literal("waived"), reason: Type.String(), at: Type.Number() }),
	Type.Object({ type: Type.Literal("context_reset"), at: Type.Number() }),
]);
const CheckpointEntry = Type.Object({ type: Type.Literal("custom"), customType: Type.Literal(CHAIN_CHECKPOINT_ENTRY), data: Operation });
const ChainCall = Type.Object({ action: Type.String(), chain: Type.String(), branch: Type.Optional(Type.String()) });
const SavedResult = Type.Object({ details: Type.Object({ link: Type.Object({ filename: Type.String() }) }) });

export interface ChainCheckpointState {
	chain?: string;
	branch?: string;
	status: "idle" | "saved" | "due";
	dueReasons: string[];
	reminded: boolean;
	updatedAt: number;
	contextPressureHandled: boolean;
}

export type ChainCheckpointOperation =
	| { type: "activate"; chain: string; branch: string; at: number }
	| { type: "due"; reason: string; at: number }
	| { type: "reminded"; at: number }
	| { type: "saved"; chain: string; branch: string; link?: string; at: number }
	| { type: "waived"; reason: string; at: number }
	| { type: "context_reset"; at: number };

export function emptyChainCheckpoint(): ChainCheckpointState {
	return { status: "idle", dueReasons: [], reminded: false, updatedAt: 0, contextPressureHandled: false };
}

export function reduceChainCheckpoint(state: ChainCheckpointState, operation: ChainCheckpointOperation): ChainCheckpointState {
	if (operation.at < state.updatedAt) return state;
	if (operation.type === "activate") {
		return { ...state, chain: operation.chain, branch: operation.branch, updatedAt: operation.at };
	}
	if (operation.type === "due") {
		const dueReasons = [...new Set([...state.dueReasons, operation.reason])].slice(-6);
		return { ...state, status: "due", dueReasons, reminded: false, updatedAt: operation.at, contextPressureHandled: true };
	}
	if (operation.type === "reminded") return { ...state, reminded: true, updatedAt: operation.at };
	if (operation.type === "saved") return { ...state, chain: operation.chain, branch: operation.branch, status: "saved", dueReasons: [], updatedAt: operation.at };
	// Nothing records a waiver any more; sessions written before /chain-waive was removed still replay one.
	if (operation.type === "waived") return { ...state, status: "saved", dueReasons: [], updatedAt: operation.at };
	return { ...state, contextPressureHandled: false, updatedAt: operation.at };
}

/** `chain@branch · status · latest reason`; activate and saved always set chain and branch together. */
export function checkpointLabel(state: ChainCheckpointState): string | undefined {
	const reason = state.dueReasons.at(-1);
	return state.chain ? `${state.chain}@${state.branch} · ${state.status}${reason ? ` · ${reason}` : ""}` : undefined;
}

export function replayChainCheckpoint(entries: readonly unknown[]): ChainCheckpointState {
	let state = emptyChainCheckpoint();
	for (const entry of entries) {
		if (!Value.Check(CheckpointEntry, entry)) continue;
		state = reduceChainCheckpoint(state, entry.data);
	}
	return state;
}

export class ChainCheckpointService {
	private state = emptyChainCheckpoint();
	private ctx?: ExtensionContext;
	private remindNextTurn = false;

	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) { this.pi = pi; }

	read(): ChainCheckpointState {
		return this.state;
	}

	restore(ctx: ExtensionContext, remind = false): void {
		this.ctx = ctx;
		this.state = replayChainCheckpoint(ctx.sessionManager.getBranch());
		this.remindNextTurn ||= remind && this.state.chain !== undefined;
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

	saved(chain: string, branch = "main", link?: string): void {
		this.record({ type: "saved", chain, branch, link, at: Date.now() });
	}

	checkContextPressure(ctx: ExtensionContext): void {
		const percent = ctx.getContextUsage()?.percent;
		if (percent === null || percent === undefined) return;
		if (percent < 80) {
			if (this.state.contextPressureHandled) this.record({ type: "context_reset", at: Date.now() });
			return;
		}
		if (this.state.contextPressureHandled) return;
		this.record({ type: "due", reason: "context usage reached 80%", at: Date.now() });
	}

	contextCompacted(): void {
		if (this.state.contextPressureHandled) this.record({ type: "context_reset", at: Date.now() });
	}

	/** At most one reminder per 80% crossing, recorded so a reload does not repeat it; otherwise one resume hint after a restore. */
	reminder(): string | undefined {
		const target = this.state.chain ? `${this.state.chain}@${this.state.branch}` : undefined;
		if (this.state.status === "due" && !this.state.reminded) {
			this.remindNextTurn = false;
			this.record({ type: "reminded", at: Date.now() });
			return `Chain checkpoint: context reached 80%. Save a concise Chain link${target ? ` for ${target}` : ""} (chain action save) before compaction drops detail. It is session metadata, not a code edit, so read-only tasks need it too. If no Chain is active, choose a concise task-specific name.`;
		}
		if (!this.remindNextTurn || !target) return undefined;
		this.remindNextTurn = false;
		return `Chain checkpoint: resume with the active Chain ${target}. Load it before rediscovery and continue from its recorded next step.`;
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
	pi.on("agent_settled", (_event, ctx) => {
		service.restore(ctx);
		service.checkContextPressure(ctx);
	});
	const section = (ctx: ExtensionContext): string | undefined => {
		service.restore(ctx);
		service.checkContextPressure(ctx);
		return service.reminder();
	};
	tasks.addSection("chain_checkpoint", section);
	pi.on("before_agent_start", (event, ctx) => {
		const reminder = section(ctx);
		if (reminder) event.systemPromptOptions.sections.chain_checkpoint = reminder;
	});
	pi.on("tool_execution_start", (event) => {
		toolArgs.set(event.toolCallId, event.args);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		service.restore(ctx);
		const args = toolArgs.get(event.toolCallId);
		toolArgs.delete(event.toolCallId);
		if (event.isError || event.toolName !== "chain" || !Value.Check(ChainCall, args)) return;
		const { action, chain, branch } = args;
		if (action === "save") service.saved(chain, branch, Value.Check(SavedResult, event.result) ? event.result.details.link.filename : undefined);
		else if (action === "load" || action === "context" || action === "fork") service.activate(chain, branch);
	});
	pi.on("session_shutdown", () => {
		toolArgs.clear();
		service.clearStatus();
	});
}
