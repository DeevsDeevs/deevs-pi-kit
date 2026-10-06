import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { kitValues, migrateLegacyConfig } from "../shared/config.ts";

const EXTENSION_ID = "codex-fast";
const PROVIDER_ID = "openai-codex";
const API_ID = "openai-codex-responses";
const FAST_SERVICE_TIER = "priority";

/** `"codexFast": true` in pi-kit.json, re-read on every request; a project's own value counts only once it is trusted. */
function isFastEnabled(ctx: ExtensionContext): boolean {
	const [global, project] = kitValues("codexFast", ctx.cwd, getAgentDir());
	return (ctx.isProjectTrusted() ? project : undefined) ?? global ?? false;
}

function isEligible(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	return model?.provider === PROVIDER_ID && model.api === API_ID && ctx.modelRegistry.isUsingOAuth(model);
}

function updateStatus(ctx: ExtensionContext, active: boolean): void {
	if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, active ? "fast" : undefined);
}

function isPayloadRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function codexFastExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.isProjectTrusted()) await migrateLegacyConfig(ctx.cwd);
		updateStatus(ctx, isFastEnabled(ctx) && isEligible(ctx));
	});

	pi.on("model_select", (_event, ctx) => updateStatus(ctx, isFastEnabled(ctx) && isEligible(ctx)));

	pi.on("before_provider_request", (event, ctx) => {
		const active = isFastEnabled(ctx) && isEligible(ctx);
		updateStatus(ctx, active);
		const payload = event.payload;
		if (!active || !isPayloadRecord(payload) || payload.model !== ctx.model?.id || "service_tier" in payload) return undefined;
		return { ...payload, service_tier: FAST_SERVICE_TIER };
	});
}
