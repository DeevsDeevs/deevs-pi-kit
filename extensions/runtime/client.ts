import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

const MAX_RESPONSE_BYTES = 64 * 1024;

interface RuntimeErrorEnvelope {
	code?: string;
	message?: string;
}

interface RuntimeResponseEnvelope {
	v?: number;
	id?: string;
	ok?: boolean;
	result?: unknown;
	error?: RuntimeErrorEnvelope | null;
}

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
	call<Params extends object>(method: string, params: Params): Promise<unknown> {
		const id = `req_${randomUUID()}`;
		const request = `${JSON.stringify({ v: 1, id, method, params })}\n`;
		return new Promise((resolve, reject) => {
			const socket = createConnection(this.socketPath);
			let buffered = Buffer.alloc(0);
			let settled = false;
			const finish = (error?: Error, response?: RuntimeResponseEnvelope) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				if (error) reject(error); else resolve(response?.result);
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
					// SAFETY: The parsed transport envelope remains untrusted until every consumed field is validated below.
					const response = JSON.parse(buffered.subarray(0, newline).toString("utf8")) as RuntimeResponseEnvelope | null;
					if (!response || response.v !== 1 || response.id !== id || response.ok !== true && response.ok !== false) throw new Error("Runtime response envelope does not match the request.");
					if (response.ok) finish(undefined, response);
					else {
						const error = response.error;
						if (!error || !nonEmptyString(error.code) || !nonEmptyString(error.message)) throw new Error("Runtime error fields must be non-empty strings.");
						finish(new HostedRuntimeClientError(error.code, error.message));
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

function nonEmptyString(value: string | undefined): value is string {
	try {
		return value !== undefined && String.prototype.valueOf.call(value) === value && value.length > 0;
	} catch {
		return false;
	}
}
