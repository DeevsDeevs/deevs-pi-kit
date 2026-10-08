import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClientError, type HostedRuntimeClient } from "./client.ts";
import { shellQuote } from "../shared/guard.ts";
import { delay } from "./herdr.ts";
import { isJsonObject } from "./schemas/json.ts";
import { runtimeBuild } from "./service/build.ts";
import { decodeHerdr, herdrResult, HerdrWorkspaceCreatedSchema } from "./schemas/herdr.ts";

interface RuntimeServicesWorkspace {
	workspaceId: string;
	paneId: string;
}

/**
 * Brings the Runtime service up in its own Herdr workspace and returns once its socket answers. A service running other
 * kit code is asked to exit and replaced, but only where a new one can start; `replaceOnly` starts none where none runs.
 */
export async function startRuntimeService(
	pi: ExtensionAPI,
	client: HostedRuntimeClient,
	root: string,
	ctx: Pick<ExtensionContext, "isProjectTrusted">,
	replaceOnly = false,
): Promise<void> {
	const running = await client.hello().catch(() => undefined);
	if (running !== undefined && isJsonObject(running) && running.build === runtimeBuild()) return;
	if (running === undefined && replaceOnly) return;
	const launchable = process.env.HERDR_ENV === "1" && ctx.isProjectTrusted();
	if (running !== undefined && !launchable) return;
	if (process.env.HERDR_ENV !== "1") {
		throw new HostedRuntimeClientError("host_unavailable", "Runtime start requires this Pi session to run inside Herdr.");
	}
	if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Runtime start requires a trusted project.");
	if (running !== undefined) await retire(client);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const workspace = await createServicesWorkspace(pi, root);
	const serviceMain = fileURLToPath(new URL("./service/main.ts", import.meta.url));
	const command = `exec node ${shellQuote(serviceMain)} --root ${shellQuote(root)}`;
	const launched = await pi.exec("herdr", ["pane", "run", workspace.paneId, command], { timeout: 5_000 });
	if (launched.code !== 0) {
		await closeServicesWorkspace(pi, workspace.workspaceId);
		throw new HostedRuntimeClientError("host_unavailable", "Herdr could not launch the Runtime service.");
	}
	for (let attempt = 0; attempt < 30; attempt++) {
		try { await client.hello(); return; } catch { await delay(100); }
	}
	await closeServicesWorkspace(pi, workspace.workspaceId);
	throw new HostedRuntimeClientError("unavailable", "Runtime service did not become ready.");
}

/** Asks a service running other kit code to exit and waits until its socket stops answering. */
async function retire(client: HostedRuntimeClient): Promise<void> {
	await client.call("service.exit", {}).catch(() => {});
	for (let attempt = 0; attempt < 30; attempt++) {
		if (await client.hello().then(() => false, () => true)) return;
		await delay(100);
	}
	throw new HostedRuntimeClientError("conflict", `A Runtime service from older kit code still answers at ${client.socketPath}; close its pi-kit-services Herdr workspace.`);
}

async function createServicesWorkspace(pi: ExtensionAPI, root: string): Promise<RuntimeServicesWorkspace> {
	const args = ["workspace", "create", "--cwd", root, "--label", "pi-kit-services", "--no-focus"];
	const created = await pi.exec("herdr", args, { timeout: 5_000 });
	if (created.code !== 0) throw new HostedRuntimeClientError("host_unavailable", "Herdr could not create the Runtime services workspace.");
	const result = decodeHerdr(HerdrWorkspaceCreatedSchema, herdrResult(created.stdout), "Herdr workspace");
	await pi.exec("herdr", ["tab", "rename", result.tab.tab_id, "pi-kit-runtime"], { timeout: 5_000 });
	return { workspaceId: result.workspace.workspace_id, paneId: result.root_pane.pane_id };
}

async function closeServicesWorkspace(pi: ExtensionAPI, workspaceId: string): Promise<void> {
	await pi.exec("herdr", ["workspace", "close", workspaceId], { timeout: 5_000 });
}
