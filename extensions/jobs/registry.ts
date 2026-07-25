import type { JobManager } from "./manager.ts";

let manager: JobManager | undefined;

export function setJobManager(value: JobManager): void { manager = value; }
export function clearJobManager(value: JobManager): void { if (manager === value) manager = undefined; }
export function getJobManager(): JobManager | undefined { return manager; }
