import type { OutputChunk, OutputStream, ReadResult, ReadStreamFilter } from "./types.ts";

export interface OutputBufferOptions {
	maxBytes: number;
	maxChunkBytes: number;
}

export class OutputBuffer {
	private chunks: OutputChunk[] = [];
	private totalBytes = 0;
	private droppedBytes = 0;
	private nextSequence = 1;

	constructor(private readonly options: OutputBufferOptions) {}

	append(stream: OutputStream, data: Buffer | string): OutputChunk {
		const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
		let bytes = raw;
		let text: string;

		if (raw.byteLength > this.options.maxChunkBytes) {
			bytes = raw.subarray(0, this.options.maxChunkBytes);
			text = `${bytes.toString("utf8")}\n[proc output chunk truncated: ${raw.byteLength - bytes.byteLength} bytes omitted]\n`;
		} else {
			text = raw.toString("utf8");
		}

		const chunk: OutputChunk = {
			seq: this.nextSequence++,
			time: Date.now(),
			stream,
			text,
			byteLength: Buffer.byteLength(text),
		};

		this.chunks.push(chunk);
		this.totalBytes += chunk.byteLength;
		this.evictToLimit();
		return chunk;
	}

	read(options: {
		id: string;
		status: ReadResult["status"];
		afterSeq?: number;
		maxBytes: number;
		stream?: ReadStreamFilter;
		exitCode: number | null;
		signal: string | null;
	}): ReadResult {
		const afterSeq = Math.max(0, Math.floor(options.afterSeq ?? 0));
		const stream = options.stream ?? "combined";
		const earliestSeq = this.earliestSeq;
		const stale = this.chunks.length > 0 && afterSeq < earliestSeq - 1;
		const droppedBeforeSeq = stale ? earliestSeq - 1 : null;
		const selected: OutputChunk[] = [];
		let bytes = 0;
		let truncated = false;

		for (const chunk of this.chunks) {
			if (chunk.seq <= afterSeq) continue;
			if (stream !== "combined" && chunk.stream !== stream) continue;

			if (bytes + chunk.byteLength > options.maxBytes) {
				truncated = true;
				if (selected.length === 0 && options.maxBytes > 0) selected.push(truncateChunk(chunk, options.maxBytes));
				break;
			}

			selected.push(chunk);
			bytes += chunk.byteLength;
		}

		return {
			id: options.id,
			status: options.status,
			chunks: selected,
			nextSeq: selected.at(-1)?.seq ?? afterSeq,
			earliestSeq,
			exited: ["exited", "signaled", "failed", "orphaned", "unknown"].includes(options.status),
			exitCode: options.exitCode,
			signal: options.signal,
			truncated,
			droppedBeforeSeq,
		};
	}

	get nextSeq(): number {
		return this.nextSequence;
	}

	get earliestSeq(): number {
		return this.chunks[0]?.seq ?? this.nextSequence;
	}

	get bufferedBytes(): number {
		return this.totalBytes;
	}

	get droppedByteCount(): number {
		return this.droppedBytes;
	}

	private evictToLimit(): void {
		while (this.totalBytes > this.options.maxBytes && this.chunks.length > 0) {
			const dropped = this.chunks.shift();
			if (!dropped) break;
			this.totalBytes -= dropped.byteLength;
			this.droppedBytes += dropped.byteLength;
		}
	}
}

function truncateChunk(chunk: OutputChunk, maxBytes: number): OutputChunk {
	const suffix = `\n[proc read chunk truncated to ${maxBytes} bytes]\n`;
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	const truncatedText = suffixBytes >= maxBytes
		? fitUtf8(suffix, maxBytes)
		: `${fitUtf8(chunk.text, maxBytes - suffixBytes)}${suffix}`;
	return { ...chunk, text: truncatedText, byteLength: Buffer.byteLength(truncatedText, "utf8") };
}

function fitUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let text = value;
	while (Buffer.byteLength(text, "utf8") > maxBytes && text.length > 0) text = text.slice(0, -1);
	return text;
}
