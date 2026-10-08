import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { trustedKitValues } from "../shared/config.ts";

const EXTENSION_ID = "codex-fast";
/** The providers a ChatGPT subscription signs in to, by the API each speaks: Pi 1.0.4's `openai` and the legacy `openai-codex`. */
const CHATGPT_APIS = new Map([["openai", "openai-responses"], ["openai-codex", "openai-codex-responses"]]);
const FAST_SERVICE_TIER = "priority";

/** `"codexFast": true` in pi-kit.json, re-read on every request; a project's own value counts only once it is trusted. */
function isFastEnabled(ctx: ExtensionContext): boolean {
	const [global, project] = trustedKitValues("codexFast", ctx);
	return project ?? global ?? false;
}

/** A ChatGPT login, never an API key: `openai` with OPENAI_API_KEY bills the API, where the priority tier costs more. */
function isEligible(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	return model !== undefined && CHATGPT_APIS.get(model.provider) === model.api && ctx.modelRegistry.isUsingOAuth(model);
}

function updateStatus(ctx: ExtensionContext, active: boolean): void {
	if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, active ? "fast" : undefined);
}

const Payload = Type.Object({ model: Type.String() });

export default function codexFastExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => updateStatus(ctx, isFastEnabled(ctx) && isEligible(ctx)));

	pi.on("model_select", (_event, ctx) => updateStatus(ctx, isFastEnabled(ctx) && isEligible(ctx)));

	pi.on("before_provider_request", (event, ctx) => {
		const active = isFastEnabled(ctx) && isEligible(ctx);
		updateStatus(ctx, active);
		const payload = event.payload;
		if (!active || !Value.Check(Payload, payload) || payload.model !== ctx.model?.id || "service_tier" in payload) return undefined;
		return { ...payload, service_tier: FAST_SERVICE_TIER };
	});
}
