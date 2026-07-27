import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { JobReadInput, JobReadResult, JobRecord, JobStartInput } from "./types.ts";
import { formatDuration } from "../shared/runtime-ui.ts";
import { showTextViewer } from "../shared/text-viewer.ts";
import { claimJobManager, releaseJobManager } from "./registry.ts";
import { legacyProcessStateFiles } from "./legacy.ts";
import { FULL_SCREEN_OVERLAY } from "../shared/dashboard.ts";
import { JobsDashboard } from "./ui.ts";

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
const WaitSchema = Type.Object({ ids: Type.Array(Type.String(), { minItems: 1 }), waitMs: Type.Optional(Type.Number({ description: "Maximum wait; omit for terminal, 0 for status" })) });
const ReadSchema = Type.Object({ id: Type.String(), afterSeq: Type.Optional(Type.Number()), maxBytes: Type.Optional(Type.Number()), stream: Type.Optional(StringEnum(["stdout", "stderr", "combined"] as const)) });
const StopSchema = Type.Object({ id: Type.String() });

export default function jobsExtension(pi: ExtensionAPI): void {
	const { manager, owner } = claimJobManager(pi);
	let ctx: ExtensionContext | undefined;
	let legacyWarningShown = false;
	const updateStatus = (): void => {
		if (!ctx) return;
		const active = manager.list().filter((job) => ["starting", "running", "stopping"].includes(job.runtime.status)).length;
		ctx.ui.setStatus("jobs", active ? ctx.ui.theme?.fg("accent", `jobs ${active}`) ?? `jobs ${active}` : undefined);
	};
	const unsubscribe = manager.onChange(updateStatus);

	pi.registerTool({
		name: "job_start",
		label: "Start Job",
		description: "Start a bounded non-agent pipe job with capped output, readiness, hard timeout, and process-tree cancellation.",
		promptSnippet: "Run a bounded non-interactive command; persistent or interactive processes belong in Herdr.",
		promptGuidelines: ["Do not use Jobs for servers, REPLs, terminal panes, or unattended schedules.", "Use argv instead of shell command when shell features are unnecessary."],
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
		name: "job_wait",
		label: "Wait for Job",
		description: "Wait for one or more Jobs to settle without polling.",
		promptSnippet: "Wait on bounded Job terminal states.",
		parameters: WaitSchema,
		async execute(_toolCallId, params: { ids: string[]; waitMs?: number }, signal, _onUpdate, context) {
			ctx = context;
			const jobs = await manager.wait(params.ids, params.waitMs, signal);
			updateStatus();
			return { content: [{ type: "text" as const, text: jobs.map(formatJob).join("\n") }], details: { jobs } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("job_wait ")) + theme.fg("muted", `${args.ids.length} id(s)`), 0, 0); },
		renderResult(result, { expanded }, theme) { return new Text(((result.details as { jobs?: JobRecord[] } | undefined)?.jobs ?? []).map((job) => renderJob(job, expanded, theme)).join("\n") || theme.fg("dim", "No Jobs"), 0, 0); },
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

	pi.registerTool({
		name: "job_stop",
		label: "Stop Job",
		description: "Stop a Job process tree, escalating to SIGKILL after a grace period.",
		promptSnippet: "Stop a bounded Job.",
		parameters: StopSchema,
		async execute(_toolCallId, params: { id: string }, _signal, _onUpdate, context) {
			ctx = context;
			const job = await manager.stop(params.id);
			updateStatus();
			return { content: [{ type: "text" as const, text: formatJob(job) }], details: job };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("job_stop ")) + theme.fg("muted", args.id), 0, 0); },
		renderResult(result, { expanded }, theme) { return new Text(renderJob(result.details as JobRecord | undefined, expanded, theme), 0, 0); },
	});

	pi.registerCommand("jobs", {
		description: "Browse, inspect, stop, or clear bounded Jobs",
		getArgumentCompletions: (prefix) => manager.list().map((job) => job.spec.id).filter((id) => id.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, context) => {
			ctx = context;
			const [action, id] = args.trim().split(/\s+/, 2);
			if (action === "clear") {
				context.ui.notify(`Cleared ${manager.clearTerminal(id)} terminal Job record(s).`, "info");
				return;
			}
			if (action === "stop" && id) await manager.stop(id);
			const jobs = manager.list();
			let exact = jobs.find((job) => job.spec.id === action);
			if (!action && context.mode === "tui" && context.hasUI) {
				let unsubscribeDashboard: () => void = () => {};
				try {
					await context.ui.custom<void>((tui, theme, _keybindings, done) => {
						const render = () => tui.requestRender();
						unsubscribeDashboard = manager.onChange(render);
						return new JobsDashboard(
							manager,
							theme,
							() => done(undefined),
							render,
							() => Math.max(4, tui.terminal.rows - 2),
							(id) => void manager.stop(id).then(() => { context.ui.notify(`Stopped ${id}.`, "info"); render(); }).catch((error) => context.ui.notify(error instanceof Error ? error.message : String(error), "error")),
							(id) => { context.ui.notify(`Cleared ${manager.clearTerminal(id)} record.`, "info"); render(); },
						);
					}, { overlay: true, overlayOptions: FULL_SCREEN_OVERLAY });
				} finally {
					unsubscribeDashboard();
				}
				return;
			}
			const selected = exact ? [exact] : action && action !== "stop" ? jobs.filter((job) => `${job.spec.id} ${job.spec.name}`.toLowerCase().includes(action.toLowerCase())) : jobs;
			const content = selected.map((job) => `${formatJob(job)}\n  ${job.spec.command ?? job.spec.argv?.join(" ") ?? ""}\n${exact ? formatRead(manager.read({ id: job.spec.id, maxBytes: 32_768 })) : `  log: ${job.spec.logPath}`}`).join("\n\n");
			await showTextViewer(context, exact ? `Job ${exact.spec.id}` : "Jobs", content || "No Jobs.");
		},
	});

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		await manager.restore(context);
		if (!legacyWarningShown) {
			const legacy = legacyProcessStateFiles();
			if (legacy.length) context.ui.notify(`Found ${legacy.length} legacy Process state file(s). Pi Kit will not kill or adopt them. Inspect old tmux sessions and hand persistent work to Herdr, then remove ~/.pi/agent/process-state when resolved.`, "warning");
			legacyWarningShown = true;
		}
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
