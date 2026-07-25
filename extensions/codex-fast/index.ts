import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "codex-fast";
const PROVIDER_ID = "openai-codex";
const API_ID = "openai-codex-responses";
const FAST_SERVICE_TIER = "priority";
const COMMANDS = ["status", "on", "off", "auto", "toggle"] as const;

const DEFAULT_CONFIG: CodexFastConfig = {
	enabled: false,
	showStatus: true,
};

type FastOverride = "auto" | "on" | "off";

type CodexFastConfig = {
	/** Default Fast-mode state when there is no session override. */
	enabled: boolean;
	/** Show a compact `fast` status when Fast mode is active for the current model. */
	showStatus: boolean;
};

type SessionState = {
	config: CodexFastConfig;
	override: FastOverride;
	lastInjectedAt?: number;
	lastInjectedModel?: string;
};

type PartialConfig = Partial<CodexFastConfig>;
type PayloadRecord = Record<string, unknown>;

type Eligibility = {
	eligible: boolean;
	modelKey: string;
	reason?: string;
};

function isPayloadRecord(value: unknown): value is PayloadRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigFile(path: string): PartialConfig {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return isPayloadRecord(parsed) ? (parsed as PartialConfig) : {};
	} catch (error) {
		console.error(`Warning: Could not parse ${path}: ${error}`);
		return {};
	}
}

function mergeConfig(base: CodexFastConfig, overrides: PartialConfig): CodexFastConfig {
	return {
		enabled: typeof overrides.enabled === "boolean" ? overrides.enabled : base.enabled,
		showStatus: typeof overrides.showStatus === "boolean" ? overrides.showStatus : base.showStatus,
	};
}

function findProjectConfigPath(cwd: string): string {
	let current = cwd;
	while (true) {
		const candidate = join(current, ".pi", "codex-fast.json");
		if (existsSync(candidate)) return candidate;

		const parent = dirname(current);
		if (parent === current) return join(cwd, ".pi", "codex-fast.json");
		current = parent;
	}
}

function loadConfig(cwd: string): CodexFastConfig {
	const globalConfig = readConfigFile(join(getAgentDir(), "extensions", "codex-fast.json"));
	const projectConfig = readConfigFile(findProjectConfigPath(cwd));
	return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function isFastEnabled(state: SessionState): boolean {
	if (state.override === "on") return true;
	if (state.override === "off") return false;
	return state.config.enabled;
}

function describeMode(state: SessionState): string {
	if (state.override === "on") return "on (session override)";
	if (state.override === "off") return "off (session override)";
	return state.config.enabled ? "on (config default)" : "off (config default)";
}

function modelKey(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
}

function getEligibility(ctx: ExtensionContext): Eligibility {
	const model = ctx.model;
	if (!model) return { eligible: false, modelKey: "no-model", reason: "no model is selected" };

	const key = modelKey(ctx);
	if (model.provider !== PROVIDER_ID) {
		return { eligible: false, modelKey: key, reason: `current provider is ${model.provider}, not ${PROVIDER_ID}` };
	}

	if (model.api !== API_ID) {
		return { eligible: false, modelKey: key, reason: `current API is ${model.api}, not ${API_ID}` };
	}

	if (!ctx.modelRegistry.isUsingOAuth(model)) {
		return { eligible: false, modelKey: key, reason: "ChatGPT OAuth auth is required; API-key auth is not used" };
	}

	return { eligible: true, modelKey: key };
}

function updateStatus(ctx: ExtensionContext, state: SessionState): void {
	if (!ctx.hasUI) return;
	if (!state.config.showStatus) {
		ctx.ui.setStatus(EXTENSION_ID, undefined);
		return;
	}

	const eligibility = getEligibility(ctx);
	ctx.ui.setStatus(EXTENSION_ID, isFastEnabled(state) && eligibility.eligible ? "fast" : undefined);
}

function getStatusMessage(ctx: ExtensionContext, state: SessionState): string {
	const enabled = isFastEnabled(state);
	const eligibility = getEligibility(ctx);
	const active = enabled && eligibility.eligible;
	const injected = state.lastInjectedAt
		? ` Last injected for ${state.lastInjectedModel ?? "unknown model"} ${Math.max(0, Math.round((Date.now() - state.lastInjectedAt) / 1000))}s ago.`
		: "";

	if (active) {
		return `Codex Fast is ${describeMode(state)} and active for ${eligibility.modelKey}; requests will use service_tier=${FAST_SERVICE_TIER}.${injected}`;
	}

	if (enabled) {
		return `Codex Fast is ${describeMode(state)}, but inactive for ${eligibility.modelKey}: ${eligibility.reason}.${injected}`;
	}

	return `Codex Fast is ${describeMode(state)}. Current model: ${eligibility.modelKey}.${injected}`;
}

function injectFastServiceTier(payload: unknown, ctx: ExtensionContext, state: SessionState): PayloadRecord | undefined {
	if (!isFastEnabled(state)) return undefined;
	if (!getEligibility(ctx).eligible) return undefined;
	if (!isPayloadRecord(payload)) return undefined;
	if (payload.model !== ctx.model?.id) return undefined;
	if ("service_tier" in payload) return undefined;

	state.lastInjectedAt = Date.now();
	state.lastInjectedModel = modelKey(ctx);
	return { ...payload, service_tier: FAST_SERVICE_TIER };
}

export default function codexFastExtension(pi: ExtensionAPI): void {
	const states = new WeakMap<object, SessionState>();

	function getState(ctx: ExtensionContext): SessionState {
		let state = states.get(ctx.sessionManager);
		if (!state) {
			state = { config: loadConfig(ctx.cwd), override: "auto" };
			states.set(ctx.sessionManager, state);
		}
		return state;
	}

	pi.on("session_start", (_event, ctx) => {
		const state: SessionState = { config: loadConfig(ctx.cwd), override: "auto" };
		states.set(ctx.sessionManager, state);
		updateStatus(ctx, state);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx, getState(ctx));
	});

	pi.on("before_provider_request", (event, ctx) => {
		const state = getState(ctx);
		const nextPayload = injectFastServiceTier(event.payload, ctx, state);
		updateStatus(ctx, state);
		return nextPayload;
	});

	pi.registerCommand("codex-fast", {
		description: "Manage Codex Fast mode for ChatGPT-auth OpenAI Codex models",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = COMMANDS.filter((command) => command.startsWith(normalized));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const state = getState(ctx);
			let action = args.trim().toLowerCase();

			if (!action) {
				if (!ctx.hasUI) action = "status";
				else {
					const selection = await ctx.ui.select("Codex Fast mode", [...COMMANDS]);
					if (!selection) return;
					action = selection;
				}
			}

			if (action === "on") state.override = "on";
			else if (action === "off") state.override = "off";
			else if (action === "auto") {
				state.override = "auto";
				state.config = loadConfig(ctx.cwd);
			} else if (action === "toggle") state.override = isFastEnabled(state) ? "off" : "on";
			else if (action !== "status") {
				ctx.ui.notify("Usage: /codex-fast on | off | auto | toggle | status", "warning");
				return;
			}

			updateStatus(ctx, state);
			ctx.ui.notify(getStatusMessage(ctx, state), "info");
		},
	});
}
