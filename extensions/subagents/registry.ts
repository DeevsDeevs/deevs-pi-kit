import type { SubagentService } from "./service.ts";

const registry = globalThis as typeof globalThis & { __deevsPiKitSubagentService?: SubagentService };

export function setSubagentService(value: SubagentService): void {
	registry.__deevsPiKitSubagentService = value;
}

export function clearSubagentService(value: SubagentService): void {
	if (registry.__deevsPiKitSubagentService === value) delete registry.__deevsPiKitSubagentService;
}

export function getSubagentService(): SubagentService {
	const service = registry.__deevsPiKitSubagentService;
	if (!service) throw new Error("Subagent runtime is not initialized in this Pi session.");
	return service;
}
