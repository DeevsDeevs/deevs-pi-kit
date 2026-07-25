// Adapted from pi-subagents src/runs/shared/child-protocol.ts at
// e658b40fe72d599df231b5d59ffec40d66f576fa (MIT).

import { Buffer } from "node:buffer";

export interface ProtocolLimit {
	stream: "stdout" | "stderr";
	limitBytes: number;
	observedBytes: number;
}

export function createBoundedLineReader(options: {
	stream: "stdout" | "stderr";
	maxPendingLineBytes: number;
	onLine: (line: string) => void;
	onLimit: (limit: ProtocolLimit) => void;
}): { push(chunk: Buffer | string): void; end(): void; exceeded(): boolean } {
	if (!Number.isInteger(options.maxPendingLineBytes) || options.maxPendingLineBytes < 1) throw new Error("maxPendingLineBytes must be positive");
	let pending = Buffer.alloc(0);
	let exceeded = false;

	const append = (chunk: Buffer): boolean => {
		if (chunk.length === 0) return true;
		const observedBytes = pending.length + chunk.length;
		if (observedBytes > options.maxPendingLineBytes) {
			exceeded = true;
			pending = Buffer.alloc(0);
			options.onLimit({ stream: options.stream, limitBytes: options.maxPendingLineBytes, observedBytes });
			return false;
		}
		pending = Buffer.concat([pending, chunk], observedBytes);
		return true;
	};

	const emit = (): void => {
		if (pending.length === 0) return;
		options.onLine(pending.toString("utf8"));
		pending = Buffer.alloc(0);
	};

	return {
		push(chunk) {
			if (exceeded) return;
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			let start = 0;
			for (let index = 0; index < bytes.length; index++) {
				if (bytes[index] !== 0x0a) continue;
				if (!append(bytes.subarray(start, index))) return;
				emit();
				start = index + 1;
			}
			append(bytes.subarray(start));
		},
		end() {
			if (!exceeded) emit();
		},
		exceeded: () => exceeded,
	};
}

export function createBoundedByteTail(maxBytes: number): { push(chunk: Buffer | string): void; text(): string } {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be positive");
	let tail = Buffer.alloc(0);
	return {
		push(chunk) {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			tail = Buffer.concat([tail, bytes]);
			if (tail.length <= maxBytes) return;
			let start = tail.length - maxBytes;
			while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++;
			tail = tail.subarray(start);
		},
		text: () => tail.toString("utf8"),
	};
}
