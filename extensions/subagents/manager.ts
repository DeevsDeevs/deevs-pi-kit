import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ChainService } from "../chains/service.ts";
import type { ProcessManager } from "../processes/manager.ts";
import { resolveCwd } from "../processes/safety.ts";
import type { ManagedProcessInfo, ReadResult } from "../processes/types.ts";
import { clampConcurrency, clampReturnBytes, clampStatusTailBytes, clampTimeoutMs, defaultAgentsSettings } from "./config.ts";
import { findAgent, loadBuiltinAgents } from "./agents.ts";
import { buildAgentSystemPrompt, buildTaskPrompt } from "./prompt.ts";
import { createRunArtifactsDir, deleteArtifacts, readTextTail, writeJsonFile, writeTextFile } from "./logs.ts";
import { compactAgentProcessLog } from "./log-compact.ts";
import { extractFinalOutputFromRead, extractLiveOutputFromRead } from "./result.ts";
import type {
	AgentClearInput,
	AgentDefinition,
	AgentGroupRecord,
	AgentLogsInput,
	AgentParallelStartInput,
	AgentParallelTaskInput,
	AgentParallelStartResult,
	AgentReadInput,
	AgentReadResult,
	AgentRunRecord,
	AgentRunStatus,
	AgentsSettings,
	AgentStartInput,
	AgentStartResult,
	AgentStatusInput,
	AgentStopInput,
} from "./types.ts";

const MODULE_DIR = decodeURIComponent(new URL(".", import.meta.url).pathname);
const CHILD_SAFETY_RUNTIME = path.join(MODULE_DIR, "child-safety-runtime.ts");
const TERMINAL_RUN_STATUSES = new Set<AgentRunStatus>(["completed", "failed", "cancelled", "timeout"]);

export class SubagentManager {
	private readonly agents = loadBuiltinAgents();
	private readonly runs = new Map<string, AgentRunRecord>();
	private readonly groups = new Map<string, AgentGroupRecord>();
	private readonly changeListeners = new Set<() => void>();
	private runCounter = 0;
	private groupCounter = 0;
	private lastCtx?: ExtensionContext;
	readonly settings: AgentsSettings = structuredClone(defaultAgentsSettings);

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly processManager: ProcessManager,
	) {
		this.processManager.onChange(() => {
			if (!this.processManager.isShuttingDown()) {
				this.refreshFromProcesses();
				this.emitChange();
			}
		});
	}

	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	setContext(ctx: ExtensionContext): void {
		this.lastCtx = ctx;
	}

	listAgents(input: { includeDisabled?: boolean; query?: string; tag?: string } = {}): AgentDefinition[] {
		const query = input.query?.trim().toLowerCase();
		const tag = input.tag?.trim().toLowerCase();
		return this.agents
			.filter((agent) => input.includeDisabled || !agent.disabled)
			.filter((agent) => !query || [agent.name, agent.description, agent.body, agent.tags.join(" ")].join("\n").toLowerCase().includes(query))
			.filter((agent) => !tag || agent.tags.some((value) => value.toLowerCase() === tag));
	}

	getAgent(name: string): AgentDefinition {
		const agent = findAgent(this.agents, name);
		if (!agent || agent.disabled) {
			const available = this.listAgents().map((item) => item.name).join(", ") || "none";
			throw new Error(`Unknown agent: ${name}. Available agents: ${available}`);
		}
		return agent;
	}

	async start(input: AgentStartInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<AgentStartResult> {
		this.setContext(ctx);
		return this.startRun(input, ctx, signal);
	}

	async startParallel(input: AgentParallelStartInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<AgentParallelStartResult> {
		this.setContext(ctx);
		if (!input.tasks?.length) throw new Error("agent_parallel_start requires at least one task");
		for (const task of input.tasks) this.validateTask(task);
		const concurrency = clampConcurrency(input.concurrency, this.settings);
		const rawConcurrency = input.concurrency ?? this.settings.parallelDefaultConcurrency;
		if (rawConcurrency > this.settings.parallelMaxConcurrency) {
			throw new Error(`Concurrency ${rawConcurrency} exceeds max ${this.settings.parallelMaxConcurrency}`);
		}

		const cwd = await resolveCwd(undefined, ctx, this.processManager.getConfig());
		const id = this.createGroupId();
		const artifactsDir = createRunArtifactsDir(cwd, id);
		const group: AgentGroupRecord = {
			id,
			mode: "parallel",
			status: "running",
			startedAt: Date.now(),
			children: [],
			pending: input.tasks.map((task) => ({ ...task })),
			concurrency,
			failFast: input.failFast ?? false,
			activeCount: 0,
			cwd,
			artifactsDir,
			metadataPath: path.join(artifactsDir, "metadata.json"),
			resultPath: path.join(artifactsDir, "result.md"),
			timeoutMs: clampTimeoutMs(input.timeoutMs, this.settings),
			maxBytesPerAgent: input.maxBytesPerAgent,
		};
		this.groups.set(id, group);
		this.writeGroupMetadata(group);
		await this.startInitialGroupRuns(group, ctx, signal);
		return {
			groupId: id,
			status: group.status,
			mode: "parallel",
			runs: group.children.map((runId) => this.runs.get(runId)!).filter(Boolean).map((run) => ({
				id: run.id,
				procId: run.procId,
				agent: run.agent,
				task: run.task,
				status: run.status,
			})),
		};
	}

	async read(input: AgentReadInput, signal?: AbortSignal): Promise<AgentReadResult> {
		if (this.groups.has(input.id)) {
			this.refreshFromProcesses();
			return this.readGroup(input);
		}
		const run = this.getRun(input.id);
		const maxBytes = clampReturnBytes(input.maxBytes);
		if (input.raw && run.procId) {
			const raw = await this.processManager.readWait({ id: run.procId, afterSeq: input.afterSeq, waitMs: input.waitMs, maxBytes, stream: input.stream }, signal);
			await this.refreshRun(run);
			return {
				id: run.id,
				type: "run",
				status: run.status,
				output: this.formatRaw(raw),
				raw,
				nextSeq: raw.nextSeq,
				truncated: raw.truncated,
			};
		}

		await this.refreshRun(run);
		if (run.finalOutput || !run.procId) {
			const output = run.finalOutput || "(not started)";
			return { id: run.id, type: "run", status: run.status, output: truncateBytes(output, maxBytes), nextSeq: run.lastSeq };
		}

		const read = await this.processManager.readWait({
			id: run.procId,
			afterSeq: input.afterSeq,
			waitMs: input.waitMs,
			maxBytes: this.processManager.getConfig().limits.maxBufferBytesPerProcess,
			stream: input.stream,
		}, signal);
		run.lastSeq = read.nextSeq;
		const output = this.formatLiveResult(run, read, input.stream);
		const visibleOutput = truncateBytes(output, maxBytes);
		return { id: run.id, type: "run", status: run.status, output: visibleOutput, nextSeq: read.nextSeq, truncated: read.truncated || visibleOutput !== output };
	}

	status(input: AgentStatusInput = {}): { runs: AgentRunRecord[]; groups: AgentGroupRecord[] } {
		this.refreshFromProcesses();
		const includeCompleted = input.includeCompleted ?? true;
		if (input.id) {
			if (this.runs.has(input.id)) return { runs: [this.publicRun(this.getRun(input.id))], groups: [] };
			if (this.groups.has(input.id)) {
				const group = this.getGroup(input.id);
				return { runs: group.children.map((id) => this.runs.get(id)).filter(Boolean).map((run) => this.publicRun(run as AgentRunRecord)), groups: [this.publicGroup(group)] };
			}
			throw new Error(`Unknown agent run/group: ${input.id}`);
		}
		return {
			runs: [...this.runs.values()].filter((run) => includeCompleted || !TERMINAL_RUN_STATUSES.has(run.status)).map((run) => this.publicRun(run)),
			groups: [...this.groups.values()].filter((group) => includeCompleted || group.status === "running").map((group) => this.publicGroup(group)),
		};
	}

	async stop(input: AgentStopInput): Promise<{ stopped: string[]; status: string }> {
		const signal = input.signal ?? "SIGTERM";
		const stopped: string[] = [];
		if (this.groups.has(input.id)) {
			const group = this.getGroup(input.id);
			group.cancelRequested = true;
			group.skippedCount = (group.skippedCount ?? 0) + group.pending.length;
			group.pending = [];
			this.writeGroupMetadata(group);
			for (const runId of group.children) {
				const run = this.runs.get(runId);
				if (!run || TERMINAL_RUN_STATUSES.has(run.status)) continue;
				run.cancelRequested = true;
				if (!run.procId) {
					this.writeRunMetadata(run);
					continue;
				}
				await this.stopProcess(run.procId, signal, input.timeoutMs ?? 5000);
				await this.refreshRun(run);
				stopped.push(run.id);
			}
			this.updateGroupStatus(group);
			return { stopped, status: group.status };
		}

		const run = this.getRun(input.id);
		if (!run.procId) {
			run.status = "cancelled";
			run.endedAt = Date.now();
			run.finalOutput = "Subagent was cancelled before starting.";
			writeTextFile(run.resultPath, run.finalOutput);
			this.writeRunMetadata(run);
			return { stopped: [run.id], status: run.status };
		}
		run.cancelRequested = true;
		await this.stopProcess(run.procId, signal, input.timeoutMs ?? 5000);
		await this.refreshRun(run);
		return { stopped: [run.id], status: run.status };
	}

	async logs(input: AgentLogsInput): Promise<{ path?: string | null; content: string; source: string }> {
		const maxBytes = clampReturnBytes(input.maxBytes);
		if (this.groups.has(input.id)) {
			const group = this.getGroup(input.id);
			if (input.source && !["metadata", "result"].includes(input.source)) throw new Error("Group logs expose metadata/result summary only; select a child run for process logs.");
			const source = input.source ?? "result";
			if (source === "metadata") return { path: group.metadataPath, content: readTextTail(group.metadataPath, maxBytes), source };
			const content = this.formatGroup(group, maxBytes);
			writeTextFile(group.resultPath, content);
			return { path: group.resultPath, content, source };
		}

		const run = this.getRun(input.id);
		const source = input.source ?? "result";
		if (source === "combined" || source === "stdout" || source === "stderr") {
			if (!run.procId) return { content: "No backing process for this run.", source };
			const logs = await this.processManager.logs({ id: run.procId, stream: source, maxBytes });
			const logPath = source === "stdout" ? logs?.stdoutLogFile : source === "stderr" ? logs?.stderrLogFile : logs?.logFile;
			if (!logs?.content) return { path: logPath, content: "No process logs for this run.", source };
			const content = input.raw ? logs.content : compactAgentProcessLog(logs.content, maxBytes);
			return { path: logPath, content, source };
		}
		const filePath = source === "result" ? run.resultPath : source === "task" ? run.taskPath : source === "system-prompt" ? run.systemPromptPath : run.metadataPath;
		return { path: filePath, content: readTextTail(filePath, maxBytes), source };
	}

	async clear(input: AgentClearInput): Promise<{ cleared: string[]; remaining: { runs: AgentRunRecord[]; groups: AgentGroupRecord[] } }> {
		const cleared: string[] = [];
		const clearRun = (run: AgentRunRecord) => {
			if (!TERMINAL_RUN_STATUSES.has(run.status)) throw new Error(`Refusing to clear running agent run: ${run.id}`);
			if (run.groupId && this.groups.has(run.groupId)) throw new Error(`Run ${run.id} belongs to group ${run.groupId}; clear the group instead.`);
			if (input.deleteArtifacts) deleteArtifacts(run);
			this.runs.delete(run.id);
			cleared.push(run.id);
		};
		const clearGroup = (group: AgentGroupRecord) => {
			if (group.status === "running") throw new Error(`Refusing to clear running agent group: ${group.id}`);
			for (const runId of group.children) {
				const run = this.runs.get(runId);
				if (run) {
					if (input.deleteArtifacts) deleteArtifacts(run);
					this.runs.delete(run.id);
					cleared.push(run.id);
				}
			}
			if (input.deleteArtifacts) deleteArtifacts(group);
			this.groups.delete(group.id);
			cleared.push(group.id);
		};

		if (input.allCompleted) {
			for (const group of [...this.groups.values()]) if (group.status !== "running") clearGroup(group);
			for (const run of [...this.runs.values()]) if (TERMINAL_RUN_STATUSES.has(run.status) && !run.groupId) clearRun(run);
		} else if (input.id) {
			if (this.groups.has(input.id)) clearGroup(this.getGroup(input.id));
			else clearRun(this.getRun(input.id));
		}
		if (cleared.length > 0) this.emitChange();
		return { cleared, remaining: this.status({ includeCompleted: true }) };
	}

	formatStatus(input: AgentStatusInput | boolean = {}): string {
		const statusInput: AgentStatusInput = typeof input === "boolean" ? { includeCompleted: input } : input;
		const status = this.status(statusInput);
		if (status.runs.length === 0 && status.groups.length === 0) return "No subagent runs.";
		const lines: string[] = [];
		for (const group of status.groups) lines.push(`${group.id} [${group.status}] parallel ${group.children.length} run(s) ${formatDuration(Date.now() - group.startedAt)}`);
		for (const run of status.runs) lines.push(`${run.id} [${run.status}] ${run.agent} ${run.procId ?? "no-proc"} ${truncateOneLine(run.task, 80)}`);
		return lines.join("\n");
	}

	private async startRun(input: AgentStartInput, ctx: ExtensionContext, signal?: AbortSignal, group?: AgentGroupRecord): Promise<AgentStartResult> {
		if (!input.task?.trim()) throw new Error(`Task for ${input.agent || "agent"} is empty.`);
		const agent = this.getAgent(input.agent);
		const cwd = await resolveCwd(input.cwd ?? group?.cwd, ctx, this.processManager.getConfig());
		const context = input.context ?? "fresh";
		const allowWrite = input.allowWrite ?? this.settings.defaultAllowWrite ?? agent.write;
		const tools = resolveTools(input.tools ?? agent.tools, allowWrite);
		const model = this.resolveModel(agent, input.model);
		const timeoutMs = clampTimeoutMs(input.timeoutMs ?? group?.timeoutMs, this.settings);
		const id = this.createRunId();
		const artifactsDir = createRunArtifactsDir(cwd, id);
		const systemPromptPath = path.join(artifactsDir, "system-prompt.md");
		const taskPath = path.join(artifactsDir, "task.md");
		const resultPath = path.join(artifactsDir, "result.md");
		const metadataPath = path.join(artifactsDir, "metadata.json");
		const systemPrompt = buildAgentSystemPrompt({ agent, task: input.task, cwd, allowWrite, tools, context });
		const taskWithChainContext = await this.withChainContext(input.task, input.chainContext, cwd);
		const taskPrompt = buildTaskPrompt(taskWithChainContext);
		writeTextFile(path.join(artifactsDir, "agent.md"), agent.body);
		writeTextFile(systemPromptPath, systemPrompt);
		writeTextFile(taskPath, taskPrompt);

		const run: AgentRunRecord = {
			id,
			procId: null,
			groupId: group?.id,
			agent: agent.name,
			task: input.task,
			status: "starting",
			startedAt: Date.now(),
			cwd,
			context,
			model,
			tools,
			allowWrite,
			artifactsDir,
			resultPath,
			taskPath,
			systemPromptPath,
			metadataPath,
			timeoutMs,
			chainContext: input.chainContext,
		};
		this.runs.set(id, run);
		if (group) {
			group.children.push(id);
			group.activeCount++;
			this.writeGroupMetadata(group);
		}
		this.writeRunMetadata(run);

		try {
			const argv = this.buildPiArgs(run, ctx);
			const procResult = await this.processManager.start({
				name: group ? `agent-group:${group.id}:${agent.name}:${id}` : `agent:${agent.name}:${id}`,
				argv,
				cwd,
				waitMs: 0,
				maxBytes: input.maxBytes,
				backend: "pipe",
				persistent: false,
				alertOnExit: false,
				alertOnFailure: false,
				env: {
					DEEVS_PI_SUBAGENT: "1",
					DEEVS_PI_SUBAGENT_ID: id,
					DEEVS_PI_SUBAGENT_AGENT: agent.name,
					DEEVS_PI_SUBAGENT_DEPTH: "1",
					...(group ? { DEEVS_PI_SUBAGENT_GROUP_ID: group.id } : {}),
				},
			}, ctx, signal);
			run.procId = procResult.process.id;
			run.status = procResult.process.status === "starting" ? "starting" : "running";
			try {
				this.processManager.write({ id: run.procId, input: "", end: true });
			} catch {
				// Child Pi may have already exited; closing stdin is best-effort.
			}
			run.timer = setTimeout(() => void this.timeoutRun(run.id), timeoutMs);
			run.timer.unref?.();
			this.writeRunMetadata(run);
			this.emitChange();
			if (run.cancelRequested || group?.cancelRequested) {
				run.cancelRequested = true;
				await this.processManager.signal({ id: run.procId, signal: "SIGTERM", tree: true, timeoutMs: 1000 });
				await this.refreshRun(run);
			} else if (!["starting", "running", "killing", "kill_timeout"].includes(procResult.process.status)) await this.refreshRun(run);
			if (group) this.updateGroupStatus(group);
			return this.formatStartResult(run, procResult.output);
		} catch (error) {
			run.status = "failed";
			run.endedAt = Date.now();
			run.finalOutput = error instanceof Error ? error.message : String(error);
			writeTextFile(run.resultPath, run.finalOutput);
			this.writeRunMetadata(run);
			if (group) {
				group.activeCount = Math.max(0, group.activeCount - 1);
				this.writeGroupMetadata(group);
			}
			throw error;
		}
	}

	private async withChainContext(task: string, chainContext: AgentStartInput["chainContext"], cwd: string): Promise<string> {
		if (!chainContext) return task;
		const service = new ChainService(cwd);
		const result = await service.context(chainContext);
		return [
			"Chain context loaded by the parent before delegation follows.",
			result.context,
			"Subagent task:",
			task,
		].join("\n\n");
	}

	private buildPiArgs(run: AgentRunRecord, ctx: ExtensionContext): string[] {
		const args = ["--mode", "json", "--print"];
		if (run.context === "fork") {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Cannot use context=fork: current Pi session file is unavailable.");
			args.push("--fork", sessionFile);
		}
		args.push("--session-dir", path.join(run.artifactsDir, "session"));
		if (run.model) args.push("--model", run.model);
		args.push("--no-extensions", "--extension", CHILD_SAFETY_RUNTIME, "--no-skills");
		args.push("--append-system-prompt", run.systemPromptPath);
		if (run.tools.length > 0) args.push("--tools", run.tools.join(","));
		args.push(`@${run.taskPath}`);
		return getPiInvocation(args);
	}

	private validateTask(input: AgentParallelTaskInput): void {
		if (!input.task?.trim()) throw new Error(`Task for ${input.agent || "agent"} is empty.`);
		const agent = this.getAgent(input.agent);
		this.resolveModel(agent, input.model);
	}

	private resolveModel(agent: AgentDefinition, requested?: string): string | undefined {
		const model = requested ?? this.settings.modelsByAgent[agent.name] ?? agent.model ?? this.settings.defaultModel;
		if (!model) return undefined;
		if (!this.settings.allowedModels.includes(model)) {
			throw new Error(`Model override not allowed: ${model}. Add it in /agents:settings first.`);
		}
		return model;
	}

	private async timeoutRun(id: string): Promise<void> {
		const run = this.runs.get(id);
		if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return;
		run.timedOut = true;
		if (run.procId) await this.stopProcess(run.procId, "SIGTERM", 1000);
		await this.refreshRun(run);
	}

	private async stopProcess(procId: string, signal: "SIGINT" | "SIGTERM" | "SIGKILL", timeoutMs: number): Promise<void> {
		const stopped = await this.processManager.signal({ id: procId, signal, tree: true, timeoutMs });
		if (stopped.status === "kill_timeout" && signal !== "SIGKILL") await this.processManager.signal({ id: procId, signal: "SIGKILL", tree: true, timeoutMs: 1000 });
	}

	private refreshFromProcesses(): void {
		if (this.processManager.isShuttingDown()) return;
		for (const run of this.runs.values()) this.refreshRun(run);
		for (const group of this.groups.values()) {
			this.updateGroupStatus(group);
			if (group.status === "running" && this.lastCtx) this.scheduleGroup(group, this.lastCtx);
		}
		this.enforceCompletedLimit();
	}

	private refreshRun(run: AgentRunRecord): void {
		if (this.processManager.isShuttingDown() || !run.procId || TERMINAL_RUN_STATUSES.has(run.status)) return;
		const proc = this.findProcess(run.procId);
		if (!proc) return;
		if (proc.status === "running" || proc.status === "starting" || proc.status === "killing" || proc.status === "kill_timeout") {
			const status = proc.status === "starting" ? "starting" : "running";
			if (run.status !== status) {
				run.status = status;
				this.writeRunMetadata(run);
			}
			return;
		}

		if (run.timer) {
			clearTimeout(run.timer);
			run.timer = undefined;
		}
		run.endedAt = proc.endedAt ?? Date.now();
		if (run.timedOut) run.status = "timeout";
		else if (run.cancelRequested) run.status = "cancelled";
		else if (proc.status === "exited" && proc.exitCode === 0) run.status = "completed";
		else run.status = "failed";

		const read = this.processManager.read({ id: run.procId, maxBytes: this.processManager.getConfig().limits.maxBufferBytesPerProcess, stream: "combined" });
		run.lastSeq = read.nextSeq;
		const extracted = extractFinalOutputFromRead(read);
		run.finalOutput = this.formatTerminalOutput(run, extracted.finalOutput, extracted.warning);
		run.extractionWarning = extracted.warning;
		writeTextFile(run.resultPath, run.finalOutput || "");
		this.writeRunMetadata(run);
		this.notifyRunTerminal(run);
	}

	private formatTerminalOutput(run: AgentRunRecord, output: string, warning?: string): string {
		const lacksFinalAssistant = warning === "No final assistant output found." || warning === "Could not parse final assistant JSON message; using combined output tail.";
		if (run.status === "timeout" && lacksFinalAssistant) return `Subagent timed out after ${run.timeoutMs}ms before producing final assistant output.`;
		if (run.status === "cancelled" && lacksFinalAssistant) return "Subagent was cancelled before producing final assistant output.";
		return output;
	}

	private async startInitialGroupRuns(group: AgentGroupRecord, ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
		const tasks = group.pending.splice(0, group.concurrency);
		this.writeGroupMetadata(group);
		await Promise.all(tasks.map((task) => this.startGroupRun(group, task, ctx, signal, false)));
		this.updateGroupStatus(group);
		if (group.status === "running") this.scheduleGroup(group, ctx, signal);
	}

	private scheduleGroup(group: AgentGroupRecord, ctx: ExtensionContext, signal?: AbortSignal): void {
		if (group.status !== "running" || group.cancelRequested) return;
		while (group.activeCount < group.concurrency && group.pending.length > 0 && !group.cancelRequested) {
			const task = group.pending.shift()!;
			void this.startGroupRun(group, task, ctx, signal, true);
		}
		this.writeGroupMetadata(group);
	}

	private async startGroupRun(group: AgentGroupRecord, task: AgentParallelTaskInput, ctx: ExtensionContext, signal?: AbortSignal, updateOnFailure = true): Promise<void> {
		const childCountBefore = group.children.length;
		try {
			await this.startRun({ ...task, timeoutMs: group.timeoutMs, maxBytes: group.maxBytesPerAgent }, ctx, signal, group);
		} catch (error) {
			if (group.children.length === childCountBefore) this.recordGroupStartFailure(group, task, error);
			if (updateOnFailure) this.updateGroupStatus(group);
			this.pi.sendMessage({ customType: "subagents", content: `Failed to start ${task.agent} in ${group.id}: ${error instanceof Error ? error.message : String(error)}`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		}
	}

	private recordGroupStartFailure(group: AgentGroupRecord, task: AgentParallelTaskInput, error: unknown): void {
		const id = this.createRunId();
		const artifactsDir = createRunArtifactsDir(group.cwd, id);
		const message = `Failed to start ${task.agent}: ${error instanceof Error ? error.message : String(error)}`;
		const run: AgentRunRecord = {
			id,
			procId: null,
			groupId: group.id,
			agent: task.agent,
			task: task.task,
			status: "failed",
			startedAt: Date.now(),
			endedAt: Date.now(),
			cwd: group.cwd,
			context: task.context ?? "fresh",
			model: task.model,
			tools: task.tools ?? [],
			allowWrite: task.allowWrite ?? false,
			artifactsDir,
			resultPath: path.join(artifactsDir, "result.md"),
			taskPath: path.join(artifactsDir, "task.md"),
			systemPromptPath: path.join(artifactsDir, "system-prompt.md"),
			metadataPath: path.join(artifactsDir, "metadata.json"),
			timeoutMs: group.timeoutMs,
			finalOutput: message,
			chainContext: task.chainContext,
		};
		this.runs.set(id, run);
		group.children.push(id);
		writeTextFile(run.resultPath, message);
		writeTextFile(run.taskPath, buildTaskPrompt(task.task));
		writeTextFile(run.systemPromptPath, "Subagent failed before child Pi launch.");
		this.writeRunMetadata(run);
		this.writeGroupMetadata(group);
	}

	private updateGroupStatus(group: AgentGroupRecord): void {
		const children = group.children.map((id) => this.runs.get(id)).filter(Boolean) as AgentRunRecord[];
		const active = children.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status)).length;
		group.activeCount = active;
		if (group.status !== "running") return;
		if (group.cancelRequested) {
			group.pending = [];
			if (active > 0) {
				this.writeGroupMetadata(group);
				return;
			}
			group.endedAt = Date.now();
			const statuses = children.map((run) => run.status);
			if (statuses.some((status) => status === "failed" || status === "timeout")) group.status = statuses.every((status) => status === "failed" || status === "timeout") ? "failed" : "partial";
			else group.status = "cancelled";
			this.writeGroupMetadata(group);
			this.notifyGroupTerminal(group);
			return;
		}
		if (group.failFast && children.some((run) => run.status === "failed" || run.status === "timeout")) {
			group.failFastTriggered = true;
			group.pending = [];
			for (const run of children) {
				if (!TERMINAL_RUN_STATUSES.has(run.status) && run.procId) {
					run.cancelRequested = true;
					void this.processManager.signal({ id: run.procId, signal: "SIGTERM", tree: true, timeoutMs: 1000 });
				}
			}
		}
		if (group.pending.length > 0 || active > 0) return;

		group.endedAt = Date.now();
		const statuses = children.map((run) => run.status);
		if (children.length === 0) group.status = "cancelled";
		else if (group.failFastTriggered) group.status = "failed";
		else if (statuses.every((status) => status === "completed")) group.status = "completed";
		else if (statuses.every((status) => status === "failed" || status === "timeout")) group.status = "failed";
		else if (statuses.every((status) => status === "cancelled")) group.status = "cancelled";
		else group.status = "partial";
		this.writeGroupMetadata(group);
		this.notifyGroupTerminal(group);
	}

	private notifyRunTerminal(run: AgentRunRecord): void {
		if (run.groupId || run.terminalNotified || !this.settings.notifyOnTerminal) return;
		run.terminalNotified = true;
		const wake = (run.status === "completed" && this.settings.wakeOnCompletion) || (run.status === "failed" && this.settings.wakeOnFailure) || (run.status === "timeout" && this.settings.wakeOnTimeout);
		const preview = truncateOneLine(run.finalOutput || "", 500);
		const text = `Subagent finished: ${run.agent} (${run.id}) status=${run.status}.${preview ? `\nPreview: ${preview}` : ""}${wake ? "\nAgent wake-up queued." : ""}`;
		this.pi.sendMessage({ customType: "subagents", content: text, display: true, details: { run: this.publicRun(run) } }, { triggerTurn: wake, deliverAs: "followUp" });
	}

	private notifyGroupTerminal(group: AgentGroupRecord): void {
		if (group.terminalNotified || !this.settings.notifyOnTerminal) return;
		group.terminalNotified = true;
		const children = group.children.map((id) => this.runs.get(id)).filter(Boolean) as AgentRunRecord[];
		const wake = (group.status === "completed" && this.settings.wakeOnCompletion) || children.some((run) => (run.status === "failed" && this.settings.wakeOnFailure) || (run.status === "timeout" && this.settings.wakeOnTimeout));
		const summary = children.map((run) => `${run.agent} ${statusGlyph(run.status)}`).join(", ");
		this.pi.sendMessage({ customType: "subagents", content: `Subagent group finished: ${group.id} status=${group.status}: ${summary}${wake ? "\nAgent wake-up queued." : ""}`, display: true, details: { group: this.publicGroup(group) } }, { triggerTurn: wake, deliverAs: "followUp" });
	}

	private readGroup(input: AgentReadInput): AgentReadResult {
		const group = this.getGroup(input.id);
		const maxBytes = clampReturnBytes(input.maxBytes);
		return { id: group.id, type: "group", status: group.status, output: this.formatGroup(group, maxBytes) };
	}

	private formatGroup(group: AgentGroupRecord, maxBytes: number): string {
		const lines = [`${group.id} [${group.status}] parallel ${group.children.length} run(s)`];
		for (const runId of group.children) {
			const run = this.runs.get(runId);
			if (!run) continue;
			let tail = run.finalOutput || "";
			if (!tail && run.procId) {
				try {
					tail = this.formatLiveRead(run, clampStatusTailBytes(undefined), "combined");
				} catch {
					tail = "(process output unavailable)";
				}
			}
			lines.push(`\n## ${run.agent} ${run.id} [${run.status}]`);
			lines.push(truncateBytes(tail, clampStatusTailBytes(undefined)) || "(no output)");
		}
		if (group.pending.length > 0) lines.push(`\nPending: ${group.pending.map((task) => task.agent).join(", ")}`);
		if (group.skippedCount) lines.push(`\nSkipped: ${group.skippedCount} pending task(s)`);
		return truncateBytes(lines.join("\n"), maxBytes);
	}

	private formatRaw(result: ReadResult): string {
		const header = `${result.id} [${result.status}] nextSeq=${result.nextSeq} earliestSeq=${result.earliestSeq}`;
		const warning = result.droppedBeforeSeq !== null ? `\n[older output dropped before seq ${result.droppedBeforeSeq}]` : "";
		const body = result.chunks.map((chunk) => chunk.text).join("");
		const suffix = result.truncated ? "\n[read truncated by maxBytes]" : "";
		return body ? `${header}${warning}\n${body}${suffix}` : `${header}${warning}\n(no buffered output)`;
	}

	private formatLiveRead(run: AgentRunRecord, maxBytes: number, stream?: "combined" | "stdout" | "stderr"): string {
		if (!run.procId) return "(not started)";
		const read = this.processManager.read({ id: run.procId, maxBytes: this.processManager.getConfig().limits.maxBufferBytesPerProcess, stream });
		run.lastSeq = read.nextSeq;
		return truncateBytes(this.formatLiveResult(run, read, stream), maxBytes);
	}

	private formatLiveResult(run: AgentRunRecord, read: ReadResult, stream?: "combined" | "stdout" | "stderr"): string {
		if (stream === "stderr") return this.formatRaw(read);
		const live = extractLiveOutputFromRead(read);
		const header = `${run.id} [${run.status}] ${run.agent} proc=${run.procId}`;
		const warnings = [
			read.droppedBeforeSeq !== null ? `[older output dropped before seq ${read.droppedBeforeSeq}]` : "",
			live.warning ? `[${live.warning}]` : "",
			read.truncated ? "[read truncated by maxBytes]" : "",
		].filter(Boolean);
		return `${header}\n${live.visibleOutput}${warnings.length > 0 ? `\n${warnings.join("\n")}` : ""}`;
	}

	private formatStartResult(run: AgentRunRecord, output: ReadResult): AgentStartResult {
		const proc = run.procId ? this.findProcess(run.procId) : undefined;
		return {
			id: run.id,
			procId: run.procId,
			agent: run.agent,
			task: run.task,
			status: run.status,
			startedAt: run.startedAt,
			cwd: run.cwd,
			artifactsDir: run.artifactsDir,
			logs: { combined: proc?.logFile, stdout: proc?.stdoutLogFile, stderr: proc?.stderrLogFile },
			output: this.formatRaw(output),
			nextSeq: output.nextSeq,
		};
	}

	private findProcess(procId: string): ManagedProcessInfo | undefined {
		return this.processManager.list({ includeExited: true, includePersistent: true }).find((process) => process.id === procId);
	}

	private getRun(id: string): AgentRunRecord {
		const run = this.runs.get(id);
		if (!run) throw new Error(`Unknown agent run: ${id}`);
		return run;
	}

	private getGroup(id: string): AgentGroupRecord {
		const group = this.groups.get(id);
		if (!group) throw new Error(`Unknown agent group: ${id}`);
		return group;
	}

	private writeRunMetadata(run: AgentRunRecord): void {
		writeJsonFile(run.metadataPath, this.publicRun(run));
	}

	private publicRun(run: AgentRunRecord): AgentRunRecord {
		const { timer: _timer, ...publicRun } = run;
		return publicRun as AgentRunRecord;
	}

	private publicGroup(group: AgentGroupRecord): AgentGroupRecord {
		return { ...group, children: [...group.children], pending: group.pending.map((task) => ({ ...task })) };
	}

	private writeGroupMetadata(group: AgentGroupRecord): void {
		writeJsonFile(group.metadataPath, group);
		writeTextFile(group.resultPath, this.formatGroup(group, clampReturnBytes(undefined)));
	}

	private enforceCompletedLimit(): void {
		const terminals = [...this.runs.values()].filter((run) => TERMINAL_RUN_STATUSES.has(run.status)).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
		while (terminals.length > this.settings.maxCompletedRecords) {
			const run = terminals.shift()!;
			if (run.groupId && this.groups.has(run.groupId)) continue;
			this.runs.delete(run.id);
		}
	}

	private emitChange(): void {
		for (const listener of this.changeListeners) listener();
	}

	private createRunId(): string {
		this.runCounter += 1;
		return `a_${Date.now().toString(36)}_${this.runCounter}`;
	}

	private createGroupId(): string {
		this.groupCounter += 1;
		return `g_${Date.now().toString(36)}_${this.groupCounter}`;
	}
}

function resolveTools(baseTools: string[], allowWrite: boolean): string[] {
	const set = new Set(baseTools.map((tool) => tool.trim()).filter(Boolean));
	if (allowWrite) {
		set.add("edit");
		set.add("write");
	} else {
		set.delete("edit");
		set.delete("write");
	}
	return [...set];
}

function getPiInvocation(args: string[]): string[] {
	const currentCli = process.argv[1];
	if (currentCli && path.basename(currentCli).startsWith("pi")) return [process.execPath, currentCli, ...args];
	return ["pi", ...args];
}

function truncateBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let tail = text.slice(-maxBytes);
	while (Buffer.byteLength(tail) > maxBytes) tail = tail.slice(1);
	return `[truncated from start]\n${tail}`;
}

function truncateOneLine(text: string, maxLength: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= maxLength ? line : `${line.slice(0, maxLength - 3)}...`;
}

function statusGlyph(status: AgentRunStatus): string {
	if (status === "completed") return "✓";
	if (status === "failed") return "failed";
	if (status === "timeout") return "timeout";
	if (status === "cancelled") return "stopped";
	return "…";
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}
