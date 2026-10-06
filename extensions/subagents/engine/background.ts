// Jobs and Monitors: background commands and watches that live in the engine beside agents. A job's process group is
// reaped when Pi exits and reported once as interrupted on reopen; a monitor resumes from its last committed look.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { constants } from "node:os";
import type * as Durable from "@earendil-works/pi-durable";
import { trySignalGroup } from "../../shared/process-group.ts";
import { jobSummary, tasks, type JobEnd, type TaskNotification, type TaskStatus } from "../../shared/tasks.ts";
import { formatLocalTime, nextCronRun, parseCron } from "./cron.ts";
import { cut, LINE_CHARS, lookAtPath, lookAtUrl, RateLimit, type PathSeen, type UrlSeen } from "./watch.ts";

type D = typeof Durable;
type Ctx = Parameters<Durable.Harness["close"]>[0];
type OutboxDoc = { items: Durable.JsonObject[] };
export type BackgroundDoc = { tasks: Record<string, Durable.JsonObject> };
type Docs = { Outbox: Durable.ConversationDocToken<OutboxDoc>; Background: Durable.ConversationDocToken<BackgroundDoc> };

const LOG_BYTES = 10_000_000;
const BATCH_MS = 200;

export interface BackgroundHost {
	/** Set on quit: a child the reaper killed is Pi closing, not the command ending. */
	closing: boolean;
	/** When this process opened each session's engine; a checkpoint older than that was taken before Pi closed. */
	opened: Map<string, number>;
}

export interface BackgroundRecord {
	kind: "job" | "monitor";
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
export interface MonitorInput extends Common {
	source: "command" | "path" | "url" | "cron";
	/** The command, path, URL or cron expression. */
	target: string;
	prompt?: string;
	every: number;
	once: boolean;
	timeoutMs?: number;
	seen?: PathSeen | UrlSeen;
}
type Watch = { phase: "watch"; nextAt: number; lastAt: number; seen: PathSeen | UrlSeen | null; events: number };
type Run = { phase: "run"; lastAt: number; events: number };
type MonitorState = Watch | Run;
type Runtime<I, S> = Durable.TaskRuntime<I, S, null, object>;
type Final = { status: "completed" | "failed"; event: string; caughtUp?: string };

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

	const Monitor = D.defineTask<MonitorInput, MonitorState, null>({
		name: "pi-kit.monitor",
		version: 1,
		initial: (input) => input.source === "command"
			? { phase: "run", lastAt: input.startedAt, events: 0 }
			: { phase: "watch", nextAt: input.source === "cron" ? nextFire(input.target, input.startedAt) : input.startedAt + input.every, lastAt: input.startedAt, seen: input.seen ?? null, events: 0 },
		phases: {
			watch: (task, runtime, context) => watch(task.input, task.state.checkpoint, runtime, context),
			run: (task, runtime, context) => runCommand(task.input, task.state.checkpoint, runtime, context),
		},
		abort: (task, runtime, context) => settle(runtime, context, task.input.id, "killed", undefined, "aborted"),
	});

	/** Timer sources: sleep to the next probe, look, and commit only an event, so a quiet watch writes nothing. */
	async function watch(input: MonitorInput, at: Watch, runtime: Runtime<MonitorInput, MonitorState>, context: Ctx): Promise<void> {
		const deadline = input.timeoutMs ? input.startedAt + input.timeoutMs : Infinity;
		const limit = new RateLimit(runtime.now());
		let caughtUp = closedSince(input.session, at.lastAt);
		let { nextAt, seen } = at;
		for (;;) {
			await runtime.sleep(Math.min(nextAt, deadline), context);
			const now = runtime.now();
			if (now >= deadline) return endMonitor(input, runtime, context, { status: "completed", event: expired(input, at.events) });
			let event: string | undefined;
			if (input.source === "cron") {
				while (!tasks.idle(input.session)) await runtime.sleep(runtime.now() + 1_000, context);
				event = input.prompt;
				caughtUp = undefined;
				nextAt = nextFire(input.target, runtime.now());
			} else {
				// SAFETY: a monitor's `seen` is only ever written by the look of its own source.
				const look = input.source === "path" ? await lookAtPath(input.target, (seen ?? undefined) as PathSeen | undefined) : await lookAtUrl(input.target, (seen ?? undefined) as UrlSeen | undefined, runtime.signal);
				({ seen } = look);
				event = look.event;
				nextAt = now + input.every;
			}
			if (!event) {
				caughtUp = undefined;
				continue;
			}
			const verdict = limit.take(now);
			if (verdict === "drop") continue;
			if (verdict === "stop") return endMonitor(input, runtime, context, { status: "failed", event: STOPPED });
			const text = suppressed(verdict, event);
			if (input.once || nextAt === Infinity) return endMonitor(input, runtime, context, { status: "completed", event: text, caughtUp });
			return emit(input, runtime, context, { phase: "watch", nextAt, lastAt: now, seen, events: at.events + 1 }, text, caughtUp);
		}
	}

	/** The command source: each stdout line is an event, batched over 200 ms; exit ends the watch with its code. */
	async function runCommand(input: MonitorInput, at: Run, runtime: Runtime<MonitorInput, MonitorState>, context: Ctx): Promise<void> {
		// A reopen runs the script again from the top: a state check catches up by itself, a stream resumes from now.
		const resumed = await runtime.memo<boolean>("spawned", context);
		if (!resumed) await runtime.memo("spawned", true, context);
		let caughtUp = resumed ? closedSince(input.session, at.lastAt) : undefined;
		const log = createWriteStream(input.outputFile, { flags: "a" });
		const child = start(input.target, input);
		child.stderr?.on("data", (chunk: Buffer) => log.write(chunk));
		const limit = new RateLimit(Date.now());
		let events = at.events;
		let lines: string[] = [];
		let chars = 0;
		let rest = "";
		let batch: NodeJS.Timeout | undefined;
		let final: Final | undefined;
		let committing: Promise<void> = Promise.resolve();
		const flush = () => {
			batch = undefined;
			child.stdout?.resume();
			if (!lines.length) return;
			const event = cut(lines.join("\n"));
			lines = [];
			chars = 0;
			const verdict = limit.take(Date.now());
			if (verdict === "drop") return;
			if (verdict === "stop") {
				final ??= { status: "failed", event: STOPPED };
				return kill(child.pid);
			}
			const text = suppressed(verdict, event);
			const mark = caughtUp;
			caughtUp = undefined;
			if (input.once) {
				final ??= { status: "completed", event: text, caughtUp: mark };
				return kill(child.pid);
			}
			events++;
			const checkpoint: Run = { phase: "run", lastAt: Date.now(), events };
			committing = committing.then(() => emit(input, runtime, context, checkpoint, text, mark));
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			// Bun keeps filling a paused pipe's buffer, so one chunk can hold megabytes: parse only what a batch can take.
			const head = chunk.subarray(0, 3_000 + LINE_CHARS);
			const parts = (rest + head.toString("utf8")).split("\n");
			const tail = parts.pop()!;
			rest = head.length < chunk.length ? "" : tail.slice(0, LINE_CHARS);
			for (const line of parts) {
				if (chars >= 3_000) break;
				lines.push(line.slice(0, LINE_CHARS));
				chars += Math.min(line.length, LINE_CHARS) + 1;
			}
			// A full batch stops reading until it is flushed, so a firehose costs one chunk per batch.
			if (chars >= 3_000) child.stdout?.pause();
			batch ??= setTimeout(flush, BATCH_MS);
		});
		const timer = input.timeoutMs ? setTimeout(() => {
			final ??= { status: "completed", event: expired(input, events) };
			kill(child.pid);
		}, Math.max(0, input.startedAt + input.timeoutMs - Date.now())) : undefined;
		const code = await exited(child, runtime.signal);
		clearTimeout(timer);
		clearTimeout(batch);
		log.end();
		await committing;
		await unlessClosing(runtime.signal);
		if (rest) lines.push(rest);
		final ??= { status: code === 0 ? "completed" : "failed", event: [...lines, `[The script exited with code ${code}; the monitor ended.]`].join("\n"), caughtUp };
		await endMonitor(input, runtime, context, final);
	}

	async function emit<S extends MonitorState>(input: MonitorInput, runtime: Runtime<MonitorInput, MonitorState>, context: Ctx, next: S, event: string, caughtUp: string | undefined): Promise<void> {
		const n = monitorEvent(input, String(next.events), event, caughtUp);
		await runtime.commit(async (tx) => {
			(await tx.doc(docs.Outbox, runtime.conversationId)).items.push(json(n));
			return { status: "running", checkpoint: next };
		}, context);
		await tasks.notify(n);
	}

	async function endMonitor(input: MonitorInput, runtime: Runtime<MonitorInput, MonitorState>, context: Ctx, final: Final): Promise<void> {
		await settle(runtime, context, input.id, final.status, { ...monitorEvent(input, "end", final.event, final.caughtUp), status: final.status }, "completed");
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

	function closedSince(session: string, lastAt: number): string | undefined {
		const opened = host.opened.get(session) ?? 0;
		return lastAt < opened ? `closed from ${formatLocalTime(lastAt)} to ${formatLocalTime(opened)}` : undefined;
	}

	return { Job, Monitor };
}

const STOPPED = "[Monitor stopped — too much output. Arm it again with a tighter filter.]";

function expired(input: MonitorInput, events: number): string {
	return `[Monitor expired after ${Math.round((input.timeoutMs ?? 0) / 1000)}s with ${events} events delivered. Re-arm it if you still need the watch.]`;
}

function suppressed(dropped: number, event: string): string {
	return dropped ? `[${dropped} events suppressed — output rate too high]\n${event}` : event;
}

function monitorEvent(input: MonitorInput, seq: string, event: string, caughtUp: string | undefined): TaskNotification {
	return { notificationId: `${input.id}:${seq}`, taskId: input.id, kind: "monitor", ownerSession: input.session, outputFile: input.outputFile, summary: `Monitor event: "${input.description}"`, event, caughtUp };
}

export function nextFire(cron: string, from: number): number {
	return nextCronRun(parseCron(cron), from) ?? Infinity;
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
