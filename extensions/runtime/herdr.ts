import { realpathSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClientError } from "./client.ts";
import { decodeHerdr, herdrResult, HerdrPaneResultSchema, HerdrTabCreatedSchema } from "./schemas/herdr.ts";

export interface CollaboratorTab {
	tabId: string;
	paneId: string;
	terminalId: string;
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Herdr refuses an agent launch argv carrying control characters, so a multi-line prompt becomes one line. */
export function collapsePrompt(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new HostedRuntimeClientError("cancelled", "Collaborator start was cancelled.");
}

export async function createCollaboratorTab(
	pi: ExtensionAPI,
	launchCwd: string,
	participantId: string,
	env: string[] = [],
): Promise<CollaboratorTab> {
	const workspaceId = process.env.HERDR_WORKSPACE_ID;
	if (!workspaceId) throw new HostedRuntimeClientError("host_unavailable", "Collaborator start requires a Herdr workspace.");
	const environment = env.flatMap((entry) => ["--env", entry]);
	const label = `collaborator:${participantId}`;
	const args = ["tab", "create", "--workspace", workspaceId, "--cwd", launchCwd, "--label", label, ...environment, "--no-focus"];
	const created = await pi.exec("herdr", args, { timeout: 5_000 });
	if (created.code !== 0) throw new HostedRuntimeClientError("host_unavailable", "Herdr could not create the native collaborator tab.");
	const result = decodeHerdr(HerdrTabCreatedSchema, herdrResult(created.stdout), "Herdr tab");
	const paneId = result.root_pane.pane_id;
	const tabId = result.tab.tab_id;
	const terminalId = result.root_pane.terminal_id ?? await herdrPaneTerminal(pi, paneId);
	if (!terminalId) throw new HostedRuntimeClientError("invalid_response", "Herdr did not return the native collaborator terminal identity.");
	return { tabId, paneId, terminalId };
}

async function herdrPaneTerminal(pi: ExtensionAPI, paneId: string): Promise<string | undefined> {
	const pane = await pi.exec("herdr", ["pane", "get", paneId], { timeout: 2_000 });
	if (pane.code !== 0) return undefined;
	return decodeHerdr(HerdrPaneResultSchema, herdrResult(pane.stdout), "Herdr pane").pane.terminal_id;
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
		const pane = decodeHerdr(HerdrPaneResultSchema, herdrResult(response.stdout), "Herdr pane").pane;
		if (pane.pane_id !== expected.paneId || pane.terminal_id !== expected.terminalId) return false;
		return pane.cwd !== undefined && realpathSync(pane.cwd) === expectedCwd;
	} catch {
		return false;
	}
}
