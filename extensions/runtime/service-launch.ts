import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClientError, type HostedRuntimeClient } from "./client.ts";
import { delay, shellQuote } from "./herdr.ts";
import { strictObject, text } from "./responses.ts";

interface RuntimeServicesWorkspace {
	workspaceId: string;
	paneId: string;
}

/** Brings the Runtime service up in its own Herdr workspace and returns once its socket answers. */
export async function startRuntimeService(
	pi: ExtensionAPI,
	client: HostedRuntimeClient,
	root: string,
	ctx: Pick<ExtensionContext, "isProjectTrusted">,
): Promise<void> {
	try {
		await client.hello();
		return;
	} catch {}
	if (process.env.HERDR_ENV !== "1") {
		throw new HostedRuntimeClientError("host_unavailable", "Runtime start requires this Pi session to run inside Herdr.");
	}
	if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Runtime start requires a trusted project.");
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

async function createServicesWorkspace(pi: ExtensionAPI, root: string): Promise<RuntimeServicesWorkspace> {
	const args = ["workspace", "create", "--cwd", root, "--label", "pi-kit-services", "--no-focus"];
	const created = await pi.exec("herdr", args, { timeout: 5_000 });
	if (created.code !== 0) throw new HostedRuntimeClientError("host_unavailable", "Herdr could not create the Runtime services workspace.");
	const result = strictObject(strictObject(JSON.parse(created.stdout), "Herdr response").result, "Herdr result");
	const workspaceId = text(strictObject(result.workspace, "Herdr workspace").workspace_id);
	const paneId = text(strictObject(result.root_pane, "Herdr root pane").pane_id);
	const tabId = text(strictObject(result.tab, "Herdr tab").tab_id);
	await pi.exec("herdr", ["tab", "rename", tabId, "pi-kit-runtime"], { timeout: 5_000 });
	return { workspaceId, paneId };
}

async function closeServicesWorkspace(pi: ExtensionAPI, workspaceId: string): Promise<void> {
	await pi.exec("herdr", ["workspace", "close", workspaceId], { timeout: 5_000 });
}
