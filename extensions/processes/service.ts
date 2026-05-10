import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAlertSink } from "./alerts.ts";
import { applyProcessesConfig, defaultConfig, loadProcessesConfig, saveProcessesConfig } from "./config.ts";
import { ProcessManager } from "./manager.ts";
import { ensureSupportedPlatform } from "./runner.ts";
import { detectBackgroundBash } from "./safety.ts";
import { createProcessUi } from "./ui.ts";

const SERVICE_KEY = Symbol.for("deevs-pi-kit.process-service");

type ProcessUi = ReturnType<typeof createProcessUi>;

export interface ProcessService {
	manager: ProcessManager;
	processUi: ProcessUi;
	active: boolean;
	lifecycleRegistered: boolean;
	surfaceRegistered: boolean;
}

interface GlobalWithProcessService {
	[SERVICE_KEY]?: ProcessService;
}

export function getProcessService(pi: ExtensionAPI): ProcessService {
	const globalState = globalThis as GlobalWithProcessService;
	const existing = globalState[SERVICE_KEY];
	if (existing?.active) {
		registerProcessLifecycleOnce(pi, existing);
		return existing;
	}

	const config = structuredClone(defaultConfig);
	const manager = new ProcessManager(config, createAlertSink(pi, config));
	const service: ProcessService = {
		manager,
		processUi: createProcessUi(manager, async (ctx) => {
			await saveProcessesConfig(ctx.cwd, manager.getConfig());
		}),
		active: true,
		lifecycleRegistered: false,
		surfaceRegistered: false,
	};
	globalState[SERVICE_KEY] = service;
	registerProcessLifecycleOnce(pi, service);
	return service;
}

export function claimProcessSurface(service: ProcessService): boolean {
	if (service.surfaceRegistered) return false;
	service.surfaceRegistered = true;
	return true;
}

function registerProcessLifecycleOnce(pi: ExtensionAPI, service: ProcessService): void {
	if (service.lifecycleRegistered) return;
	service.lifecycleRegistered = true;

	pi.on("session_start", async (_event, ctx) => {
		try {
			ensureSupportedPlatform();
			applyProcessesConfig(service.manager.getConfig(), await loadProcessesConfig(ctx.cwd));
			await service.manager.restore(ctx);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		service.processUi.dispose(ctx);
		await service.manager.shutdown(event.reason);
		service.active = false;
		service.lifecycleRegistered = false;
		service.surfaceRegistered = false;
	});

	pi.on("tool_call", async (event) => {
		const config = service.manager.getConfig();
		if (!config.safety.blockBackgroundBash) return undefined;
		if (!isToolCallEventType("bash", event)) return undefined;

		const command = event.input.command;
		if (typeof command !== "string") return undefined;

		const reason = detectBackgroundBash(command);
		if (!reason) return undefined;

		return { block: true, reason };
	});
}
