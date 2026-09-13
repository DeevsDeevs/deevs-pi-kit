import { realpathSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClientError } from "./client.ts";
import { optionalText, strictObject, text } from "./responses.ts";

export const HERDR_AGENT_START_CODES = [
	"invalid_agent_name", "unsupported_agent_kind", "invalid_agent_argument", "invalid_agent_timeout", "agent_pane_not_found",
	"agent_pane_busy", "agent_pane_unavailable", "agent_start_input_failed", "agent_name_taken", "agent_start_failed",
	"agent_name_lost", "timeout",
];

export interface HerdrPane {
	paneId: string;
	terminalId: string;
}

export interface CollaboratorTab {
	tabId: string;
	paneId: string;
	terminalId: string;
}

export interface HerdrExecResult {
	stdout: string;
	stderr: string;
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new HostedRuntimeClientError("cancelled", "Collaborator start was cancelled.");
}

export function isHerdrError(result: HerdrExecResult, expectedCode: string): boolean {
	return [result.stdout, result.stderr].some(output => {
		if (output.length > 8192) return false;
		try { return strictObject(strictObject(JSON.parse(output), "Herdr response").error, "Herdr error").code === expectedCode; } catch { return false; }
	});
}

export async function currentHerdrPane(pi: ExtensionAPI): Promise<HerdrPane> {
	const current = await pi.exec("herdr", ["pane", "current", "--current"], { timeout: 2_000 });
	if (current.code !== 0) throw new HostedRuntimeClientError("host_unavailable", "Herdr could not resolve this Pi pane.");
	const pane = strictObject(strictObject(JSON.parse(current.stdout), "Herdr response").result, "Herdr result").pane;
	const value = strictObject(pane, "Herdr pane");
	return { paneId: text(value.pane_id), terminalId: text(value.terminal_id) };
}

export async function createCollaboratorTab(pi: ExtensionAPI, launchCwd: string, participantId: string): Promise<CollaboratorTab> {
	const workspaceId = process.env.HERDR_WORKSPACE_ID;
	if (!workspaceId) throw new HostedRuntimeClientError("host_unavailable", "Collaborator start requires a Herdr workspace.");
	const args = ["tab", "create", "--workspace", workspaceId, "--cwd", launchCwd, "--label", `collaborator:${participantId}`, "--no-focus"];
	const created = await pi.exec("herdr", args, { timeout: 5_000 });
	if (created.code !== 0) throw new HostedRuntimeClientError("host_unavailable", "Herdr could not create the native collaborator tab.");
	const result = strictObject(strictObject(JSON.parse(created.stdout), "Herdr response").result, "Herdr result");
	const rootPane = strictObject(result.root_pane, "Herdr root pane");
	const paneId = text(rootPane.pane_id);
	const tabId = text(strictObject(result.tab, "Herdr tab").tab_id);
	const reported = optionalText(rootPane.terminal_id);
	const terminalId = reported ? reported : await herdrPaneTerminal(pi, paneId);
	if (!terminalId) throw new HostedRuntimeClientError("invalid_response", "Herdr did not return the native collaborator terminal identity.");
	return { tabId, paneId, terminalId };
}

async function herdrPaneTerminal(pi: ExtensionAPI, paneId: string): Promise<string | undefined> {
	const pane = await pi.exec("herdr", ["pane", "get", paneId], { timeout: 2_000 });
	if (pane.code !== 0) return undefined;
	const response = strictObject(JSON.parse(pane.stdout), "Herdr response");
	return text(strictObject(strictObject(response.result, "Herdr result").pane, "Herdr pane").terminal_id);
}

/** Proves a pane reached its authorized cwd before anything is dispatched into it. */
export async function waitForHerdrPaneCwd(pi: ExtensionAPI, pane: CollaboratorTab, cwd: string, signal?: AbortSignal): Promise<void> {
	const expectedCwd = realpathSync(cwd);
	let consecutiveMatches = 0;
	for (let attempt = 0; attempt < 50; attempt++) {
		throwIfAborted(signal);
		if (await herdrPaneSettledAt(pi, pane, expectedCwd)) {
			if (++consecutiveMatches >= 3) return;
		} else consecutiveMatches = 0;
		await delay(100);
	}
	throw new HostedRuntimeClientError("host_unavailable", `Herdr pane ${pane.paneId} did not settle at its authorized cwd.`);
}

async function herdrPaneSettledAt(pi: ExtensionAPI, expected: CollaboratorTab, expectedCwd: string): Promise<boolean> {
	const response = await pi.exec("herdr", ["pane", "get", expected.paneId], { timeout: 2_000 });
	if (response.code !== 0) return false;
	try {
		const result = strictObject(strictObject(JSON.parse(response.stdout), "Herdr response").result, "Herdr result");
		const pane = strictObject(result.pane, "Herdr pane");
		if (pane.pane_id !== expected.paneId || pane.terminal_id !== expected.terminalId) return false;
		return realpathSync(text(pane.cwd)) === expectedCwd;
	} catch {
		return false;
	}
}
