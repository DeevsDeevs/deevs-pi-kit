import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { kitValues, migrateLegacyConfig } from "./config.ts";

/** `"autonomy": "auto" | "ask"` in pi-kit.json, re-read on every use: a trusted project's value overrides the global one; absent means auto. */
export async function isAutonomous(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): Promise<boolean> {
	const trusted = ctx.isProjectTrusted();
	if (trusted) await migrateLegacyConfig(ctx.cwd);
	const [global, project] = kitValues("autonomy", ctx.cwd, getAgentDir());
	return ((trusted ? project : undefined) ?? global ?? "auto") === "auto";
}
