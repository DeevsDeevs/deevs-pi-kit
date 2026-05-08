import { appendFile, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadProjectConfig, saveProjectConfig } from "../shared/project-config.ts";

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

const NOTIFIER_CONFIG_FILE = "notifier.json";

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

function writeTerminalNotification(config: ResolvedConfig, debugFanout = false): void {
	const { title, body } = config;
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

	if (config.bell) process.stdout.write("\x07");
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
	return loadProjectConfig(cwd, NOTIFIER_CONFIG_FILE, DEFAULT_CONFIG, (input) => resolveConfig(input as NotifierConfig));
}

async function saveConfig(cwd: string, config: ResolvedConfig): Promise<string> {
	return saveProjectConfig(cwd, NOTIFIER_CONFIG_FILE, config);
}

async function notify(ctx: ExtensionContext, config: ResolvedConfig, debugFanout = false): Promise<void> {
	if (!config.enabled) return;

	if (config.terminal && (!config.terminalRequiresTty || process.stdout.isTTY)) {
		writeTerminalNotification(config, debugFanout);
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

	pi.registerCommand("notifier:settings", {
		description: "Show or persist project notifier settings",
		handler: async (args, ctx) => {
			try {
				config = await applyNotifierSettingsCommand(args, ctx.cwd, config);
				ctx.ui.notify(`${formatConfig(config)}\nProject config: .pi/notifier.json`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
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

async function applyNotifierSettingsCommand(args: string, cwd: string, current: ResolvedConfig): Promise<ResolvedConfig> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0 || parts[0] === "status" || parts[0] === "show") return loadConfig(cwd);
	let next: ResolvedConfig = { ...current, command: current.command ? [...current.command] : undefined, jsonl: current.jsonl };
	const command = parts[0]!;
	if (command === "reset") next = { ...DEFAULT_CONFIG };
	else if (command === "enable") next.enabled = true;
	else if (command === "disable") next.enabled = false;
	else if (command === "set") next = setNotifierValue(next, parts[1], parts.slice(2).join(" "));
	else throw new Error("Usage: /notifier:settings [status|enable|disable|reset|set <key> <value>]");
	await saveConfig(cwd, next);
	return loadConfig(cwd);
}

function setNotifierValue(config: ResolvedConfig, key: string | undefined, rawValue: string): ResolvedConfig {
	if (!key) throw new Error("Usage: /notifier:settings set <key> <value>");
	const value = rawValue.trim();
	const next = { ...config };
	if (key === "enabled") next.enabled = parseBool(value, key);
	else if (key === "terminal") next.terminal = parseBool(value, key);
	else if (key === "bell") next.bell = parseBool(value, key);
	else if (key === "terminalRequiresTty") next.terminalRequiresTty = parseBool(value, key);
	else if (key === "title") next.title = value || DEFAULT_CONFIG.title;
	else if (key === "body") next.body = value || DEFAULT_CONFIG.body;
	else if (key === "minIntervalMs") {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) throw new Error("minIntervalMs must be a number");
		next.minIntervalMs = Math.max(0, Math.floor(parsed));
	} else if (key === "jsonl") next.jsonl = value && value !== "none" ? value : undefined;
	else if (key === "command") throw new Error("Set notifier command by editing .pi/notifier.json as a JSON string array; shell-like command strings are intentionally not accepted here.");
	else throw new Error(`Unknown notifier setting: ${key}`);
	return next;
}

function parseBool(value: string, key: string): boolean {
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	throw new Error(`${key} must be true or false`);
}

function formatConfig(config: ResolvedConfig): string {
	return [
		`enabled: ${config.enabled}`,
		`title: ${config.title}`,
		`body: ${config.body}`,
		`terminal: ${config.terminal}`,
		`bell: ${config.bell}`,
		`terminalRequiresTty: ${config.terminalRequiresTty}`,
		`minIntervalMs: ${config.minIntervalMs}`,
		`command: ${config.command?.join(" ") ?? "(none)"}`,
		`jsonl: ${config.jsonl ?? "(none)"}`,
	].join("\n");
}
