import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type NotifierConfig = {
	enabled?: boolean;
	title?: string;
	body?: string;
	terminal?: boolean;
	bell?: boolean;
	terminalRequiresTty?: boolean;
	command?: string[];
	jsonl?: string;
	minIntervalMs?: number;
};

type ResolvedConfig = Required<Omit<NotifierConfig, "command" | "jsonl">> & {
	command?: string[];
	jsonl?: string;
};

const DEFAULT_CONFIG: ResolvedConfig = {
	enabled: true,
	title: "Pi",
	body: "Ready for input",
	terminal: true,
	bell: true,
	terminalRequiresTty: true,
	minIntervalMs: 750,
};

function stripControl(text: string): string {
	return text.replace(/[\x00-\x1f\x7f\x9b]/g, " ").replace(/\s+/g, " ").trim();
}

function isGhostty(): boolean {
	return process.env.TERM_PROGRAM?.toLowerCase() === "ghostty" || process.env.TERM === "xterm-ghostty";
}

function renderTemplate(value: string, ctx: ExtensionContext, config: ResolvedConfig): string {
	return value
		.replaceAll("{title}", config.title)
		.replaceAll("{body}", config.body)
		.replaceAll("{cwd}", ctx.cwd)
		.replaceAll("{project}", basename(ctx.cwd));
}

function writeTerminalNotification(title: string, body: string, bell: boolean, debugFanout = false): void {
	const safeTitle = stripControl(title).replaceAll(";", " ");
	const safeBody = stripControl(body).replaceAll(";", " ");

	if (process.env.KITTY_WINDOW_ID) {
		process.stdout.write(`\x1b]99;i=pi-ready:d=0;${safeTitle}\x1b\\`);
		process.stdout.write(`\x1b]99;i=pi-ready:p=body;${safeBody}\x1b\\`);
	} else if (isGhostty()) {
		// Ghostty documents desktop notifications via OSC 9 and OSC 777.
		process.stdout.write(`\x1b]9;${safeTitle}: ${safeBody}\x07`);
		process.stdout.write(`\x1b]777;notify;${safeTitle};${safeBody}\x07`);
		if (debugFanout) {
			// Debug-only: try ST terminators too in case BEL is swallowed by a layer.
			process.stdout.write(`\x1b]9;${safeTitle}: ${safeBody}\x1b\\`);
			process.stdout.write(`\x1b]777;notify;${safeTitle};${safeBody}\x1b\\`);
		}
	} else {
		// OSC 777 is used by iTerm2/WezTerm/rxvt-style integrations.
		process.stdout.write(`\x1b]777;notify;${safeTitle};${safeBody}\x07`);
		if (debugFanout) process.stdout.write(`\x1b]9;${safeTitle}: ${safeBody}\x07`);
	}

	if (bell) process.stdout.write("\x07");
}

function runCommand(command: string[], ctx: ExtensionContext, config: ResolvedConfig): void {
	const [program, ...args] = command.map((part) => renderTemplate(part, ctx, config));
	if (!program) return;

	const child = spawn(program, args, {
		cwd: ctx.cwd,
		detached: true,
		stdio: "ignore",
	});
	child.on("error", () => undefined);
	child.unref();
}

async function appendJsonl(path: string, ctx: ExtensionContext, config: ResolvedConfig): Promise<void> {
	const event = {
		event: "pi.agent_end",
		title: config.title,
		body: config.body,
		cwd: ctx.cwd,
		project: basename(ctx.cwd),
		timestamp: new Date().toISOString(),
	};
	const absolutePath = join(ctx.cwd, path);
	await mkdir(dirname(absolutePath), { recursive: true });
	await appendFile(absolutePath, `${JSON.stringify(event)}\n`, "utf8");
}

function resolveConfig(parsed: NotifierConfig): ResolvedConfig {
	const next: ResolvedConfig = { ...DEFAULT_CONFIG };
	if (typeof parsed.enabled === "boolean") next.enabled = parsed.enabled;
	if (typeof parsed.title === "string") next.title = parsed.title;
	if (typeof parsed.body === "string") next.body = parsed.body;
	if (typeof parsed.terminal === "boolean") next.terminal = parsed.terminal;
	if (typeof parsed.bell === "boolean") next.bell = parsed.bell;
	if (typeof parsed.terminalRequiresTty === "boolean") next.terminalRequiresTty = parsed.terminalRequiresTty;
	if (typeof parsed.minIntervalMs === "number" && Number.isFinite(parsed.minIntervalMs)) {
		next.minIntervalMs = Math.max(0, parsed.minIntervalMs);
	}
	if (Array.isArray(parsed.command) && parsed.command.every((part) => typeof part === "string")) {
		next.command = parsed.command;
	}
	if (typeof parsed.jsonl === "string" && parsed.jsonl.trim()) next.jsonl = parsed.jsonl;
	return next;
}

async function loadConfig(cwd: string): Promise<ResolvedConfig> {
	try {
		const raw = await readFile(join(cwd, ".pi", "notifier.json"), "utf8");
		return resolveConfig(JSON.parse(raw) as NotifierConfig);
	} catch {
		return DEFAULT_CONFIG;
	}
}

async function notify(ctx: ExtensionContext, config: ResolvedConfig, debugFanout = false): Promise<void> {
	if (!config.enabled) return;

	if (config.terminal && (!config.terminalRequiresTty || process.stdout.isTTY)) {
		writeTerminalNotification(config.title, config.body, config.bell, debugFanout);
	}
	if (config.command) runCommand(config.command, ctx, config);
	if (config.jsonl) await appendJsonl(config.jsonl, ctx, config);
}

export default function (pi: ExtensionAPI): void {
	let config = DEFAULT_CONFIG;
	let lastNotificationAt = 0;

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig(ctx.cwd);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const now = Date.now();
		if (now - lastNotificationAt < config.minIntervalMs) return;
		lastNotificationAt = now;
		await notify(ctx, config);
	});

	pi.registerCommand("notifier:test", {
		description: "Send a test ready notification using extensions/notifier.",
		handler: async (_args, ctx) => {
			config = await loadConfig(ctx.cwd);
			await notify(ctx, config, true);
			ctx.ui.notify(
				`Notifier test sent (TERM=${process.env.TERM ?? ""}, TERM_PROGRAM=${process.env.TERM_PROGRAM ?? ""}, tty=${process.stdout.isTTY ? "yes" : "no"})`,
				"info",
			);
		},
	});
}
