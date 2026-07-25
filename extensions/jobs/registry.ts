import type { JobManager } from "./manager.ts";

const registry = globalThis as typeof globalThis & { __deevsPiKitJobManager?: JobManager };

export function setJobManager(value: JobManager): void { registry.__deevsPiKitJobManager = value; }
export function clearJobManager(value: JobManager): void { if (registry.__deevsPiKitJobManager === value) delete registry.__deevsPiKitJobManager; }
export function getJobManager(): JobManager | undefined { return registry.__deevsPiKitJobManager; }
