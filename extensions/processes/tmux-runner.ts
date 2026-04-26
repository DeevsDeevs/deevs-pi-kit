import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessesConfig } from "./config.ts";
import { getShellPath } from "./config.ts";

const execFileAsync = promisify(execFile);

export interface TmuxStartSpec {
	session: string;
	command?: string;
	argv?: string[];
	cwd: string;
	config: ProcessesConfig;
}

export async function ensureTmuxAvailable(): Promise<void> {
	await execFileAsync("tmux", ["-V"]);
}

export async function startTmuxProcess(spec: TmuxStartSpec): Promise<void> {
	await ensureTmuxAvailable();
	const command = spec.command ?? quoteArgs(spec.argv ?? []);
	if (!command) throw new Error("tmux backend requires command or argv");

	const marker = `__PI_EXIT_${spec.session}:`;
	const wrapped = `${command}; code=$?; printf '\n${marker}%s__\n' "$code"; sleep 1`;
	const shellCommand = `${getShellPath(spec.config)} -lc ${shellQuote(wrapped)}`;
	await execFileAsync("tmux", ["new-session", "-d", "-s", spec.session, "-c", spec.cwd, shellCommand]);
}

export async function captureTmuxPane(session: string): Promise<string> {
	const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-J", "-t", session, "-S", "-5000"]);
	return normalizeCapture(stdout);
}

export async function hasTmuxSession(session: string): Promise<boolean> {
	try {
		await execFileAsync("tmux", ["has-session", "-t", session]);
		return true;
	} catch {
		return false;
	}
}

export async function sendTmuxInput(session: string, input: string): Promise<void> {
	const parts = input.split("\n");
	for (let i = 0; i < parts.length; i += 1) {
		if (parts[i]) await execFileAsync("tmux", ["send-keys", "-t", session, "-l", parts[i]!]);
		if (i < parts.length - 1) await execFileAsync("tmux", ["send-keys", "-t", session, "Enter"]);
	}
}

export async function signalTmuxSession(session: string, signal: string): Promise<void> {
	if (signal === "SIGINT") {
		await execFileAsync("tmux", ["send-keys", "-t", session, "C-c"]);
		return;
	}
	await killTmuxSession(session);
}

export async function killTmuxSession(session: string): Promise<void> {
	try {
		await execFileAsync("tmux", ["kill-session", "-t", session]);
	} catch {
		// Already gone.
	}
}

export function getTmuxExitMarker(session: string): string {
	return `__PI_EXIT_${session}:`;
}

function quoteArgs(argv: string[]): string {
	return argv.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizeCapture(value: string): string {
	const trimmed = value.replace(/[ \t]+\n/g, "\n").trimEnd();
	return trimmed ? `${trimmed}\n` : "";
}
