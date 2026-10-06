import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { JobReadInput, JobReadResult, JobRecord, JobStartInput } from "./types.ts";
import { guardBashCall } from "../shared/guard.ts";
import { claimJobManager, releaseJobManager } from "./registry.ts";
import { tasks } from "../shared/tasks.ts";

const StartSchema = Type.Object({
	name: Type.String({ description: "Short human-readable job name" }),
	command: Type.Optional(Type.String({ description: "Shell command; mutually exclusive with argv" })),
	argv: Type.Optional(Type.Array(Type.String(), { description: "Direct argv; mutually exclusive with command" })),
	cwd: Type.Optional(Type.String()),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	timeoutMs: Type.Optional(Type.Number({ description: "Hard wall timeout, capped at 15 minutes" })),
	readyPattern: Type.Optional(Type.String({ description: "Optional readiness substring or regex" })),
	readyMode: Type.Optional(StringEnum(["substring", "regex"] as const)),
	readyTimeoutMs: Type.Optional(Type.Number()),
	stdin: Type.Optional(Type.String({ description: "Optional initial stdin; stdin closes after start" })),
	maxBytes: Type.Optional(Type.Number({ description: "In-memory output cap" })),
});
const ReadSchema = Type.Object({ id: Type.String(), afterSeq: Type.Optional(Type.Number()), maxBytes: Type.Optional(Type.Number()), stream: Type.Optional(StringEnum(["stdout", "stderr", "combined"] as const)) });

export default function jobsExtension(pi: ExtensionAPI): void {
	const { manager, owner } = claimJobManager();
	let ctx: ExtensionContext | undefined;
	const updateStatus = (): void => {
		if (!ctx) return;
		const active = manager.list().filter((job) => ["starting", "running", "stopping"].includes(job.runtime.status)).length;
		ctx.ui.setStatus("jobs", active ? ctx.ui.theme?.fg("accent", `j${active}`) ?? `j${active}` : undefined);
	};
	const unsubscribe = manager.onChange(updateStatus);

	pi.registerTool({
		name: "job_start",
		label: "Start Job",
		description: "Start a bounded non-agent pipe job with capped output, readiness, hard timeout, and process-tree cancellation.",
		promptSnippet: "Run a bounded non-interactive command; persistent or interactive processes belong in Herdr.",
		promptGuidelines: ["Do not use Jobs for servers, REPLs, terminal panes, or unattended schedules.", "Use argv instead of shell command when shell features are unnecessary.", "After starting a Job, continue runnable independent work; a finished Job wakes idle Pi by itself. TaskStop stops a Job."],
		parameters: StartSchema,
		async execute(_toolCallId, params: JobStartInput, signal, _onUpdate, context) {
			ctx = context;
			const job = await manager.start(params, context, signal);
			updateStatus();
			return { content: [{ type: "text" as const, text: formatJob(job) }], details: job };
		},
		renderCall(args: JobStartInput, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("job_start ")) + theme.fg("muted", args.name), 0, 0); },
		renderResult(result, { expanded }, theme) { return new Text(renderJob(result.details as JobRecord | undefined, expanded, theme), 0, 0); },
	});

	pi.registerTool({
		name: "job_read",
		label: "Read Job",
		description: "Read bounded buffered Job output by sequence cursor.",
		promptSnippet: "Read new bounded output from a Job.",
		parameters: ReadSchema,
		async execute(_toolCallId, params: JobReadInput, _signal, _onUpdate, context) {
			ctx = context;
			const result = manager.read(params);
			return { content: [{ type: "text" as const, text: formatRead(result) }], details: result };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("job_read ")) + theme.fg("muted", `${args.id} @${args.afterSeq ?? 0}`), 0, 0); },
		renderResult(result, { expanded }, theme) {
			const details = result.details as JobReadResult | undefined;
			return new Text(details ? (expanded ? formatRead(details) : theme.fg("muted", `${details.job.spec.id} · ${details.chunks.length} chunk(s) · next ${details.nextSeq}`)) : theme.fg("dim", "No output"), 0, 0);
		},
	});

	pi.on("tool_call", (event, context) => isToolCallEventType("bash", event) ? guardBashCall(event.input.command, context.cwd) : undefined);
	pi.on("session_start", async (_event, context) => {
		ctx = context;
		await manager.restore(context);
		updateStatus();
	});
	pi.on("session_tree", async (_event, context) => {
		ctx = context;
		await manager.restore(context);
		updateStatus();
	});
	pi.on("session_shutdown", () => {
		unsubscribe();
		releaseJobManager(owner);
		ctx?.ui.setStatus("jobs", undefined);
		ctx = undefined;
	});
	tasks.install(pi);
	tasks.addSource({ name: "jobs", pending: async (ownerSession) => manager.notifications(ownerSession) });
}

function formatJob(job: JobRecord): string {
	return `${job.spec.id} [${job.runtime.status}${job.runtime.ready ? " · ready" : ""}] ${job.spec.name} · ${formatDuration((job.runtime.endedAt ?? Date.now()) - job.runtime.startedAt)}${job.runtime.heartbeatAt && !job.runtime.endedAt ? ` · heartbeat ${formatDuration(Date.now() - job.runtime.heartbeatAt)} ago` : ""}${job.runtime.error ? `\n${job.runtime.error}` : ""}`;
}

function formatRead(result: JobReadResult): string {
	const body = result.chunks.map((chunk) => chunk.text).join("");
	const header = `${result.job.spec.id} [${result.job.runtime.status}] nextSeq=${result.nextSeq} earliestSeq=${result.earliestSeq}`;
	return `${header}${result.droppedBeforeSeq ? `\n[older output dropped before seq ${result.droppedBeforeSeq}]` : ""}\n${body || "(no buffered output)"}${result.truncated ? "\n[read truncated]" : ""}`;
}

function renderJob(job: JobRecord | undefined, expanded: boolean, theme: Theme): string {
	if (!job) return theme.fg("dim", "No Job details");
	const color = job.runtime.status === "completed" ? "success" : ["starting", "running", "stopping"].includes(job.runtime.status) ? "warning" : "error";
	let text = `${theme.fg(color, job.runtime.status)} ${theme.fg("accent", job.spec.name)} ${theme.fg("muted", job.spec.id)}`;
	if (expanded) text += `\n${theme.fg("dim", job.spec.command ?? job.spec.argv?.join(" ") ?? "")}`;
	if (expanded && job.runtime.error) text += `\n${theme.fg("error", job.runtime.error)}`;
	return text;
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	const seconds = Math.round(ms / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
}
