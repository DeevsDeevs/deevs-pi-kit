import { TextDecoder } from "node:util";
import { BRIDGE_RUNNER_MAX_LINE_BYTES, BRIDGE_RUNNER_MAX_STDOUT_BYTES } from "./types.ts";

export class BridgeJsonlError extends Error {
	readonly code = "protocol_output" as const;
}

export class BoundedJsonlDecoder {
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });
	private readonly onLine: (line: string) => void;
	private readonly maxLineBytes: number;
	private readonly maxTotalBytes: number;
	private pending = "";
	private totalBytes = 0;
	private ended = false;

	constructor(onLine: (line: string) => void, maxLineBytes = BRIDGE_RUNNER_MAX_LINE_BYTES, maxTotalBytes = BRIDGE_RUNNER_MAX_STDOUT_BYTES) { this.onLine = onLine; this.maxLineBytes = maxLineBytes; this.maxTotalBytes = maxTotalBytes; }

	push(chunk: Buffer): void {
		if (this.ended) throw new BridgeJsonlError("JSONL decoder already ended.");
		this.totalBytes += chunk.length;
		if (this.totalBytes > this.maxTotalBytes) throw new BridgeJsonlError(`JSONL stdout exceeds ${this.maxTotalBytes} bytes.`);
		let text: string;
		try { text = this.decoder.decode(chunk, { stream: true }); }
		catch { throw new BridgeJsonlError("JSONL stdout is not valid UTF-8."); }
		this.pending += text;
		this.drain();
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		try { this.pending += this.decoder.decode(); }
		catch { throw new BridgeJsonlError("JSONL stdout ended with invalid UTF-8."); }
		this.drain();
		if (this.pending.length) throw new BridgeJsonlError("JSONL stdout ended with an unterminated frame.");
	}

	private drain(): void {
		while (true) {
			const newline = this.pending.indexOf("\n");
			if (newline < 0) {
				if (Buffer.byteLength(this.pending) > this.maxLineBytes) throw new BridgeJsonlError(`JSONL frame exceeds ${this.maxLineBytes} bytes.`);
				return;
			}
			let line = this.pending.slice(0, newline);
			this.pending = this.pending.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (Buffer.byteLength(line) > this.maxLineBytes) throw new BridgeJsonlError(`JSONL frame exceeds ${this.maxLineBytes} bytes.`);
			if (line) this.onLine(line);
		}
	}
}

export function parseClosedJson(line: string, allowed: readonly string[], maxDepth = 12): Record<string, unknown> {
	let value: unknown;
	try { value = JSON.parse(line); } catch { throw new BridgeJsonlError("JSONL frame is not valid JSON."); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeJsonlError("JSONL frame must be an object.");
	if (depth(value) > maxDepth) throw new BridgeJsonlError(`JSONL frame exceeds depth ${maxDepth}.`);
	const item = value as Record<string, unknown>;
	for (const key of Object.keys(item)) if (!allowed.includes(key)) throw new BridgeJsonlError(`JSONL frame has unknown field ${key}.`);
	return item;
}

function depth(value: unknown, level = 0): number {
	if (!value || typeof value !== "object") return level;
	if (level > 64) return level;
	return Math.max(level, ...Object.values(value as Record<string, unknown>).map((item) => depth(item, level + 1)));
}
