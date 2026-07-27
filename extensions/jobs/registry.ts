import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { JobManager } from "./manager.ts";

interface JobManagerRegistry {
	manager?: JobManager;
	owner?: symbol;
	shutdownTimer?: NodeJS.Timeout;
	shuttingDown?: JobManager;
	shutdownHooksInstalled?: boolean;
}

// ponytail: legacy manager key preserves one cross-version hot reload; remove after the next breaking release.
const globalRegistry = globalThis as typeof globalThis & { __deevsPiKitJobs?: JobManagerRegistry; __deevsPiKitJobManager?: JobManager };
const registry = globalRegistry.__deevsPiKitJobs ??= {};

export function claimJobManager(pi: ExtensionAPI): { manager: JobManager; owner: symbol } {
	installShutdownBackstop();
	if (registry.shutdownTimer) clearTimeout(registry.shutdownTimer);
	registry.shutdownTimer = undefined;
	const manager = registry.manager ?? globalRegistry.__deevsPiKitJobManager ?? new JobManager(pi);
	manager.setExtensionApi(pi);
	const owner = Symbol("jobs-extension-owner");
	registry.manager = manager;
	registry.owner = owner;
	globalRegistry.__deevsPiKitJobManager = manager;
	return { manager, owner };
}

export function releaseJobManager(owner: symbol): void {
	if (registry.owner !== owner) return;
	registry.shutdownTimer = setTimeout(() => {
		if (registry.owner !== owner || !registry.manager) return;
		const manager = registry.manager;
		registry.manager = undefined;
		registry.owner = undefined;
		registry.shutdownTimer = undefined;
		registry.shuttingDown = manager;
		delete globalRegistry.__deevsPiKitJobManager;
		void manager.shutdown().finally(() => { if (registry.shuttingDown === manager) registry.shuttingDown = undefined; });
	}, 1_000);
	registry.shutdownTimer.unref?.();
}

export function setJobManager(value: JobManager): void {
	if (registry.shutdownTimer) clearTimeout(registry.shutdownTimer);
	registry.shutdownTimer = undefined;
	registry.manager = value;
	registry.owner = undefined;
	globalRegistry.__deevsPiKitJobManager = value;
}

export function clearJobManager(value: JobManager): void {
	if (registry.manager !== value && globalRegistry.__deevsPiKitJobManager !== value) return;
	if (registry.shutdownTimer) clearTimeout(registry.shutdownTimer);
	registry.shutdownTimer = undefined;
	registry.manager = undefined;
	registry.owner = undefined;
	if (globalRegistry.__deevsPiKitJobManager === value) delete globalRegistry.__deevsPiKitJobManager;
}

export function getJobManager(): JobManager | undefined {
	return registry.manager ?? globalRegistry.__deevsPiKitJobManager;
}

function installShutdownBackstop(): void {
	if (registry.shutdownHooksInstalled) return;
	registry.shutdownHooksInstalled = true;
	process.once("beforeExit", () => {
		if (registry.shutdownTimer) clearTimeout(registry.shutdownTimer);
		registry.shutdownTimer = undefined;
		void Promise.all([registry.manager, registry.shuttingDown].filter((manager): manager is JobManager => Boolean(manager)).map((manager) => manager.shutdown()));
	});
	process.once("exit", () => {
		registry.manager?.terminateActiveSync();
		registry.shuttingDown?.terminateActiveSync();
	});
}
