// Jobs: background commands that live in the engine beside agents. A job's process group is reaped when Pi exits and
// reported once as interrupted on reopen.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { constants } from "node:os";
import type * as Durable from "@earendil-works/pi-durable";
import { trySignalGroup } from "../../shared/process-group.ts";
import { jobSummary, tasks, type JobEnd, type TaskNotification, type TaskStatus } from "../../shared/tasks.ts";

type D = typeof Durable;
type Ctx = Parameters<Durable.Harness["close"]>[0];
type OutboxDoc = { items: Durable.JsonObject[] };
export type BackgroundDoc = { tasks: Record<string, Durable.JsonObject> };
type Docs = { Outbox: Durable.ConversationDocToken<OutboxDoc>; Background: Durable.ConversationDocToken<BackgroundDoc> };

const LOG_BYTES = 10_000_000;

export interface BackgroundHost {
	/** Set on quit: a child the reaper killed is Pi closing, not the command ending. */
	closing: boolean;
}

export interface BackgroundRecord {
	kind: "job";
	description: string;
	startedAt: number;
	status: TaskStatus;
	taskId: number;
}

interface Common {
	id: string;
	session: string;
	description: string;
	cwd: string;
	/** PI_KIT_OWNER of every process the task starts: the engine's storage directory, which the reaper matches. */
	owner: string;
	outputFile: string;
	startedAt: number;
}
export interface JobInput extends Common { command: string; toolUseId: string; timeout?: number }
type Runtime<I, S> = Durable.TaskRuntime<I, S, null, object>;

export function backgroundTasks(D: D, docs: Docs, host: BackgroundHost) {
	const Job = D.defineTask<JobInput, { phase: "run" }, null>({
		name: "pi-kit.job",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: { run: (task, runtime, context) => runJob(task.input, runtime, context) },
		abort: (task, runtime, context) => finishJob(task.input, runtime, context, "stopped"),
	});

	async function runJob(input: JobInput, runtime: Runtime<JobInput, { phase: "run" }>, context: Ctx): Promise<void> {
		// Memoed before the spawn: a command is never known to be idempotent, so a reopen reports it rather than running it twice.
		if (await runtime.memo<boolean>("spawned", context)) return finishJob(input, runtime, context, "interrupted");
		await runtime.memo("spawned", true, context);
		const log = createWriteStream(input.outputFile, { flags: "a" });
		let bytes = 0;
		let logCut = false;
		const write = (chunk: Buffer) => {
			const part = chunk.subarray(0, Math.max(0, LOG_BYTES - bytes));
			logCut ||= part.length < chunk.length;
			bytes += part.length;
			if (part.length) log.write(part);
		};
		const child = start(input.command, input);
		child.stdout?.on("data", write);
		child.stderr?.on("data", write);
		let limited: string | undefined;
		const timer = input.timeout ? setTimeout(() => {
			limited = `timeout ${input.timeout} ms`;
			kill(child.pid);
		}, input.timeout) : undefined;
		const exitCode = await exited(child, runtime.signal);
		clearTimeout(timer);
		await new Promise((resolve) => log.end(resolve));
		await unlessClosing(runtime.signal);
		await finishJob(input, runtime, context, { exitCode }, limited, logCut);
	}

	async function finishJob(input: JobInput, runtime: Runtime<JobInput, { phase: "run" }>, context: Ctx, end: JobEnd, limited?: string, logCut?: boolean): Promise<void> {
		const status = end === "stopped" ? "killed" : end !== "interrupted" && "exitCode" in end && end.exitCode === 0 ? "completed" : "failed";
		const n: TaskNotification = {
			notificationId: `${input.id}:${String(runtime.taskId)}`,
			taskId: input.id,
			kind: "job",
			ownerSession: input.session,
			toolUseId: input.toolUseId,
			outputFile: input.outputFile,
			status,
			summary: jobSummary(input.description, end),
			limited,
			note: logCut ? "The log was cut at 10 MB; the output file holds the first 10 MB." : undefined,
		};
		await settle(runtime, context, input.id, status, n, end === "stopped" ? "aborted" : "completed");
	}

	/** The task's last commit: its record, its report if it has one, and its outcome together. */
	async function settle<I, S>(runtime: Runtime<I, S>, context: Ctx, id: string, status: TaskStatus, n: TaskNotification | undefined, outcome: "completed" | "aborted"): Promise<void> {
		await runtime.commit(async (tx) => {
			const record = (await tx.doc(docs.Background, runtime.conversationId)).tasks[id];
			if (record) record.status = status;
			if (n) (await tx.doc(docs.Outbox, runtime.conversationId)).items.push(json(n));
			return { status: "terminal", outcome: outcome === "completed" ? { status: outcome, result: null } : { status: outcome } };
		}, context);
		tasks.update(id, { status });
		if (n) await tasks.notify(n);
	}

	/** A child that ended because Pi is closing is not reported: wait for the harness to end this invocation instead. */
	async function unlessClosing(signal: AbortSignal): Promise<void> {
		if (!host.closing && !signal.aborted) return;
		if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
		throw signal.reason;
	}

	return { Job };
}

/** Its own process group, tagged for the reaper; `bash -c`, as Pi's bash tool runs a command. */
function start(command: string, input: Common) {
	return spawn("bash", ["-c", command], { cwd: input.cwd, detached: true, env: { ...process.env, PI_KIT_OWNER: input.owner }, stdio: ["ignore", "pipe", "pipe"] });
}

function kill(pid: number | undefined): void {
	if (pid) trySignalGroup(pid, "SIGKILL");
}

/** The exit code (128 + signal for a signal); an abort kills the whole group first. */
function exited(child: ReturnType<typeof start>, signal: AbortSignal): Promise<number> {
	const onAbort = () => kill(child.pid);
	signal.addEventListener("abort", onAbort, { once: true });
	return new Promise<number>((resolve) => {
		child.once("error", () => resolve(127));
		child.once("close", (code, by) => resolve(code ?? 128 + (by ? constants.signals[by] : 0)));
	}).finally(() => signal.removeEventListener("abort", onAbort));
}

/** Documents hold strict JSON: optional fields that are `undefined` are dropped. */
function json(value: TaskNotification): Durable.JsonObject {
	return JSON.parse(JSON.stringify(value));
}
