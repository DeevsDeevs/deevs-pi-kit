import type { SubagentService } from "./service.ts";

let service: SubagentService | undefined;

export function setSubagentService(value: SubagentService): void {
	service = value;
}

export function clearSubagentService(value: SubagentService): void {
	if (service === value) service = undefined;
}

export function getSubagentService(): SubagentService {
	if (!service) throw new Error("Subagent runtime is not initialized in this Pi session.");
	return service;
}
