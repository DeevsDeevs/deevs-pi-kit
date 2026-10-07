import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { migrateLegacyConfig, trustedKitValue } from "./config.ts";

/** `"autonomy"` in pi-kit.json, re-read on every use: a trusted project's value overrides the global one; absent means true. */
export async function isAutonomous(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): Promise<boolean> {
	if (ctx.isProjectTrusted()) await migrateLegacyConfig(ctx.cwd);
	return trustedKitValue("autonomy", ctx) ?? true;
}
