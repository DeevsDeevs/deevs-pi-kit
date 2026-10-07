import { appendFile, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { kitValues, migrateLegacyConfig, type KitValue } from "../shared/config.ts";

type ResolvedConfig = Required<Omit<KitValue<"notifier">, "command" | "jsonl">> & {
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
	// oxlint-disable-next-line no-control-regex -- strips control characters before they reach a terminal escape.
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

function writeTerminalNotification(config: ResolvedConfig): void {
	const safeTitle = stripControl(config.title).replaceAll(";", " ");
	const safeBody = stripControl(config.body).replaceAll(";", " ");

	if (process.env.KITTY_WINDOW_ID) {
		process.stdout.write(`\x1b]99;i=pi-ready:d=0;${safeTitle}\x1b\\`);
		process.stdout.write(`\x1b]99;i=pi-ready:p=body;${safeBody}\x1b\\`);
	} else {
		// Ghostty documents desktop notifications via OSC 9 and OSC 777; iTerm2, WezTerm and rxvt-style integrations read OSC 777.
		if (isGhostty()) process.stdout.write(`\x1b]9;${safeTitle}: ${safeBody}\x07`);
		process.stdout.write(`\x1b]777;notify;${safeTitle};${safeBody}\x07`);
	}

	if (config.bell) process.stdout.write("\x07");
}

function runCommand(command: string[], ctx: ExtensionContext, config: ResolvedConfig): void {
	const [program, ...args] = command.map((part) => renderTemplate(part, ctx, config));
	if (!program) return;

	// Bounded, never detached (AGENTS.md process ownership): a notifier that has not exited in 10 s is killed.
	const child = spawn(program, args, { cwd: ctx.cwd, stdio: "ignore" });
	child.on("error", () => undefined);
	child.unref();
	const timer = setTimeout(() => child.kill(), 10_000).unref();
	child.once("exit", () => clearTimeout(timer));
}

async function appendJsonl(path: string, ctx: ExtensionContext, config: ResolvedConfig): Promise<void> {
	const event = {
		event: "pi.agent_settled",
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

/** `notifier` in pi-kit.json, re-read on every use: the project's fields over the global ones over the defaults. */
function loadConfig(ctx: ExtensionContext): ResolvedConfig {
	const [global, project] = kitValues("notifier", ctx.cwd);
	const config = { ...DEFAULT_CONFIG, ...global, ...project };
	return trustedNotifierConfig(ctx, { ...config, minIntervalMs: Math.max(0, config.minIntervalMs) });
}

export function trustedNotifierConfig(ctx: ExtensionContext, config: ResolvedConfig): ResolvedConfig {
	if (ctx.isProjectTrusted()) return config;
	const { command: _command, jsonl: _jsonl, ...safe } = config;
	return safe;
}

async function notify(ctx: ExtensionContext, config: ResolvedConfig): Promise<void> {
	if (!config.enabled) return;

	if (config.terminal && (!config.terminalRequiresTty || process.stdout.isTTY)) {
		writeTerminalNotification(config);
	}
	if (config.command) runCommand(config.command, ctx, config);
	if (config.jsonl) await appendJsonl(config.jsonl, ctx, config);
}

export default function (pi: ExtensionAPI): void {
	let lastNotificationAt = 0;

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.isProjectTrusted()) await migrateLegacyConfig(ctx.cwd);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const config = loadConfig(ctx);
		const now = Date.now();
		if (now - lastNotificationAt < config.minIntervalMs) return;
		lastNotificationAt = now;
		await notify(ctx, config);
	});
}
