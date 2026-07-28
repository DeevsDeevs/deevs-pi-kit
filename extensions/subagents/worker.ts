import { readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendTranscript, findLatestSessionFile, writePrivateText, writeRunRuntime } from "./artifacts.ts";
import { createBoundedByteTail, createBoundedLineReader } from "./protocol.ts";
import { quiesceProcessGroup, readProcessIdentity, trySignalGroup } from "../shared/process-group.ts";
import type { DelegateLimitReason, DelegateRunRuntime, DelegateRunSpec, DelegateRunStatus } from "./runtime-types.ts";

const specPath = process.argv[2];
if (!specPath) throw new Error("Delegate worker requires a spec path");
const spec = JSON.parse(readFileSync(specPath, "utf8")) as DelegateRunSpec;
let runtime = JSON.parse(readFileSync(spec.runtimePath, "utf8")) as DelegateRunRuntime;
let child: ChildProcessWithoutNullStreams | undefined;
let requested: { status: DelegateRunStatus; reason?: DelegateLimitReason; error: string } | undefined;
let killTimer: NodeJS.Timeout | undefined;
const stderr = createBoundedByteTail(spec.limits.maxStderrBytes);

function persist(patch: Partial<DelegateRunRuntime> = {}): void {
	runtime = { ...runtime, ...patch, lastActivityAt: Date.now() };
	writeRunRuntime(spec, runtime);
}

function requestStop(status: DelegateRunStatus, error: string, reason?: DelegateLimitReason): void {
	if (requested || isTerminal(runtime.status)) return;
	requested = { status, error, reason };
	persist({ status: "stopping", error, limitReason: reason });
	if (!child?.pid) return;
	trySignalGroup(child.pid, "SIGTERM");
	killTimer = setTimeout(() => {
		if (child?.pid) trySignalGroup(child.pid, "SIGKILL");
	}, 1_500);
	killTimer.unref?.();
}

function handleEvent(line: string): void {
	appendTranscript(spec, line);
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return;
	}

	const type = typeof event.type === "string" ? event.type : "";
	if (type === "agent_settled") persist({ settled: true, currentTool: undefined });
	if (type === "tool_execution_start") persist({ currentTool: typeof event.toolName === "string" ? event.toolName : undefined });
	if (type === "tool_execution_end") persist({ currentTool: undefined });
	if (type === "message_end") {
		const message = record(event.message);
		if (message?.role === "assistant") {
			const output = messageText(message);
			if (output) persist({ output });
		}
	}
	if (type !== "turn_end") return;

	const message = record(event.message);
	const usage = record(message?.usage);
	const cost = record(usage?.cost);
	persist({
		turns: runtime.turns + 1,
		usage: {
			inputTokens: runtime.usage.inputTokens + number(usage?.input ?? usage?.inputTokens),
			outputTokens: runtime.usage.outputTokens + number(usage?.output ?? usage?.outputTokens),
			cacheReadTokens: runtime.usage.cacheReadTokens + number(usage?.cacheRead ?? usage?.cacheReadTokens),
			cacheWriteTokens: runtime.usage.cacheWriteTokens + number(usage?.cacheWrite ?? usage?.cacheCreationInputTokens),
			costUsd: runtime.usage.costUsd + number(cost?.total),
		},
	});
	setImmediate(enforceUsageLimits);
}

function enforceUsageLimits(): void {
	if (runtime.settled || requested) return;
	if (spec.limits.turns !== undefined && runtime.turns >= spec.limits.turns) {
		requestStop("limited", `Turn limit reached (${spec.limits.turns}).`, "turns");
		return;
	}
	const tokens = runtime.usage.inputTokens + runtime.usage.outputTokens + runtime.usage.cacheWriteTokens;
	if (spec.limits.tokens !== undefined && tokens >= spec.limits.tokens) {
		requestStop("limited", `Token limit reached (${spec.limits.tokens}); final provider call may overshoot.`, "tokens");
		return;
	}
	if (spec.limits.costUsd !== undefined && runtime.usage.costUsd >= spec.limits.costUsd) {
		requestStop("limited", `Cost limit reached ($${spec.limits.costUsd}); final provider call may overshoot.`, "cost");
	}
}

async function main(): Promise<void> {
	persist({ workerPid: process.pid, workerIdentity: await readProcessIdentity(process.pid) });
	await publishReady();
	const stdout = createBoundedLineReader({
		stream: "stdout",
		maxPendingLineBytes: spec.limits.maxProtocolLineBytes,
		onLine: handleEvent,
		onLimit: (limit) => requestStop("failed", `Protocol stdout line exceeded ${limit.limitBytes} bytes.`, "protocol_output"),
	});

	child = spawn(spec.execution.command, spec.execution.args, {
		cwd: spec.cwd,
		env: {
			...process.env,
			DEEVS_PI_SUBAGENT: "1",
			DEEVS_PI_SUBAGENT_ID: spec.id,
			DEEVS_PI_SUBAGENT_AGENT: spec.persona,
			DEEVS_PI_SUBAGENT_ARTIFACTS: spec.artifactsDir,
			DEEVS_PI_SUBAGENT_DEPTH: "1",
		},
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (!child.pid || !child.stdin || !child.stdout || !child.stderr) throw new Error("Delegate child spawned without piped stdio");
	const pgid = child.pid;
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child!.once("close", (code, signal) => resolve({ code, signal })));
	child.stdin.end();
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	const childIdentity = await readProcessIdentity(pgid);
	let earlyClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	if (!childIdentity) {
		earlyClose = await Promise.race([closed, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10))]);
		if (!earlyClose) {
			trySignalGroup(pgid, "SIGKILL");
			await closed;
			throw new Error("Delegate child identity could not be established; child was terminated before publishing running state.");
		}
	} else persist({ status: "running", childPid: pgid, childIdentity });

	const wallTimer = setTimeout(() => requestStop("timeout", `Wall limit reached (${spec.limits.wallMs}ms).`, "wall"), spec.limits.wallMs);
	wallTimer.unref?.();
	const { code, signal } = earlyClose ?? await closed;
	clearTimeout(wallTimer);
	stdout.end();
	let quiesced = await quiesceProcessGroup(pgid, { graceful: !requested, graceMs: requested ? 0 : 250 });
	while (!quiesced) {
		persist({ status: "stopping", error: "Waiting for the delegate process group to quiesce after SIGKILL." });
		await new Promise((wait) => setTimeout(wait, 1_000));
		quiesced = await quiesceProcessGroup(pgid, { graceful: false });
	}
	if (killTimer) clearTimeout(killTimer);
	const stderrText = stderr.text().trim();
	const status = runtime.settled && requested?.status === "limited" ? "completed" : requested?.status ?? (code === 0 && runtime.settled ? "completed" : "failed");
	const error = requested?.error ?? (["failed", "partial", "needs_attention"].includes(status) ? stderrText || `Child exited with code ${code ?? "?"}.` : undefined);
	const sessionFile = findLatestSessionFile(spec.sessionDir);
	persist({ status, endedAt: Date.now(), exitCode: code, exitSignal: signal, currentTool: undefined, error, limitReason: requested?.reason, sessionFile });
	writePrivateText(spec.resultPath, runtime.output || error || `${status}\n`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => requestStop("cancelled", `Delegate cancelled by ${signal}.`));
}

main().catch((error) => {
	persist({ status: "failed", endedAt: Date.now(), error: error instanceof Error ? error.message : String(error) });
	writePrivateText(spec.resultPath, runtime.error || "Delegate worker failed.");
	process.exitCode = 1;
});

async function publishReady(): Promise<void> {
	if (!process.send) return;
	await new Promise<void>((resolve, reject) => process.send!({ type: "delegate_worker_ready" }, (error) => {
		process.disconnect?.();
		if (error) reject(error);
		else resolve();
	}));
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function messageText(message: Record<string, unknown>): string {
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content.map(record).filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => String(part!.text)).join("\n").trim();
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isTerminal(status: DelegateRunStatus): boolean {
	return !["starting", "running", "stopping"].includes(status);
}
