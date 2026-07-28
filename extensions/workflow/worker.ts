import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("Workflow worker requires a parent port.");

interface AgentRequest {
	agent: string;
	task: string;
	model?: string;
	tools?: string[];
	cwd?: string;
	wallMs?: number;
	turns?: number;
	tokens?: number;
	costUsd?: number;
}

interface WorkerInput {
	source: string;
	input: unknown;
}

const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let counter = 0;

parentPort.on("message", (message: unknown) => {
	const value = record(message);
	if (value?.type !== "agent_result" || typeof value.requestId !== "string") return;
	const waiter = pending.get(value.requestId);
	if (!waiter) return;
	pending.delete(value.requestId);
	if (value.ok === true) waiter.resolve(value.result);
	else waiter.reject(new Error(typeof value.error === "string" ? value.error : "Workflow agent call failed."));
});

async function agent(request: AgentRequest): Promise<unknown> {
	if (!request || typeof request.agent !== "string" || typeof request.task !== "string") throw new Error("agent() requires { agent, task }.");
	const requestId = `agent-${++counter}`;
	const result = new Promise<unknown>((resolve, reject) => pending.set(requestId, { resolve, reject }));
	parentPort!.postMessage({ type: "agent_request", requestId, request });
	return result;
}

async function main(): Promise<void> {
	const data = workerData as WorkerInput;
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (agent: typeof globalThis, input: unknown) => Promise<unknown>;
	const workflow = new AsyncFunction("agent", "input", `"use strict";\n${data.source}`);
	const result = await workflow(agent as unknown as typeof globalThis, data.input);
	parentPort!.postMessage({ type: "done", result });
}

main().catch((error) => {
	parentPort!.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
});

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
