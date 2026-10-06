import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { kitPaths, migrateLegacyConfig, readKitKey } from "./config.ts";

/**
 * `"autonomy": "auto" | "ask"` in pi-kit.json, re-read on every use: a trusted project's `.pi/pi-kit.json` overrides `~/.pi/agent/pi-kit.json`.
 * Absent everywhere means auto; any other value, or a file that does not parse, means ask.
 */
export async function isAutonomous(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): Promise<boolean> {
	const [global, project] = kitPaths(ctx.cwd, getAgentDir());
	if (ctx.isProjectTrusted()) {
		await migrateLegacyConfig(ctx.cwd);
		const own = readAutonomy(project);
		if (own !== undefined) return own;
	}
	return readAutonomy(global) ?? true;
}

function readAutonomy(path: string): boolean | undefined {
	try {
		const autonomy = readKitKey(path, "autonomy");
		return autonomy === undefined ? undefined : autonomy === "auto";
	} catch {
		return false;
	}
}
