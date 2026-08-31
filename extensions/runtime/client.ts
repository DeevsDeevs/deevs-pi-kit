import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

const MAX_RESPONSE_BYTES = 64 * 1024;

export class HostedRuntimeClientError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export class HostedRuntimeClient {
	readonly socketPath: string;
	private readonly timeoutMs: number;

	constructor(socketPath: string, timeoutMs = 2_000) {
		this.socketPath = socketPath;
		this.timeoutMs = timeoutMs;
	}

	// oxlint-disable-next-line anti-slop/no-unknown-returns -- RPC callers either decode the result immediately or serialize it unchanged at the tool boundary.
	call(method: string, params: unknown): Promise<unknown> {
		const id = `req_${randomUUID()}`;
		const request = `${JSON.stringify({ v: 1, id, method, params })}\n`;
		return new Promise((resolve, reject) => {
			const socket = createConnection(this.socketPath);
			let buffered = Buffer.alloc(0);
			let settled = false;
			const finish = (error?: Error, result?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				if (error) reject(error); else resolve(result);
			};
			const timer = setTimeout(() => finish(new HostedRuntimeClientError("unavailable", "Runtime request timed out.")), this.timeoutMs);
			timer.unref?.();
			socket.once("error", () => finish(new HostedRuntimeClientError("unavailable", "Runtime socket is unavailable.")));
			socket.once("close", () => finish(new HostedRuntimeClientError("unavailable", "Runtime closed without a response.")));
			socket.on("data", (chunk: Buffer) => {
				buffered = Buffer.concat([buffered, chunk]);
				if (buffered.length > MAX_RESPONSE_BYTES) {
					finish(new HostedRuntimeClientError("invalid_response", "Runtime response exceeds the client limit."));
					return;
				}
				const newline = buffered.indexOf(0x0a);
				if (newline < 0) return;
				try {
					const response = strictObject(JSON.parse(buffered.subarray(0, newline).toString("utf8")), "runtime response");
					if (response.v !== 1 || response.id !== id || typeof response.ok !== "boolean") throw new Error("Runtime response envelope does not match the request.");
					if (response.ok) finish(undefined, response.result);
					else {
						const error = strictObject(response.error, "runtime error");
						finish(new HostedRuntimeClientError(text(error.code), text(error.message)));
					}
				} catch (error) {
					finish(error instanceof HostedRuntimeClientError ? error : new HostedRuntimeClientError("invalid_response", error instanceof Error ? error.message : "Invalid runtime response."));
				}
			});
			socket.once("connect", () => socket.write(request));
		});
	}

	// oxlint-disable-next-line anti-slop/no-unknown-returns -- Registration callers validate the hello envelope before using its fields.
	hello(): Promise<unknown> {
		return this.call("hello", { minVersion: 1, maxVersion: 1 });
	}
}

function strictObject(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
	return value as Record<string, unknown>;
}

function text(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new Error("Runtime error fields must be non-empty strings.");
	return value;
}
