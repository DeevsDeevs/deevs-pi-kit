import type { JobChunk, JobReadResult, JobRecord, JobStream } from "./types.ts";

export class JobBuffer {
	private chunks: JobChunk[] = [];
	private bytes = 0;
	private dropped = 0;
	private next = 1;

	constructor(private readonly maxBytes = 1_000_000, private readonly maxChunkBytes = 64_000) {}

	append(stream: JobStream, value: Buffer | string): JobChunk {
		const raw = Buffer.isBuffer(value) ? value : Buffer.from(value);
		const clipped = raw.subarray(0, this.maxChunkBytes);
		const suffix = raw.length > clipped.length ? `\n[job chunk truncated: ${raw.length - clipped.length} bytes omitted]\n` : "";
		const text = `${clipped.toString("utf8")}${suffix}`;
		const chunk = { seq: this.next++, at: Date.now(), stream, text, bytes: Buffer.byteLength(text) };
		this.chunks.push(chunk);
		this.bytes += chunk.bytes;
		while (this.bytes > this.maxBytes && this.chunks.length) {
			const removed = this.chunks.shift()!;
			this.bytes -= removed.bytes;
			this.dropped += removed.bytes;
		}
		return chunk;
	}

	restore(chunks: JobChunk[], metadata?: { nextSeq?: number; droppedBytes?: number }): void {
		this.chunks = chunks.filter((chunk) => Number.isInteger(chunk.seq) && chunk.seq > 0).sort((a, b) => a.seq - b.seq);
		this.bytes = this.chunks.reduce((total, chunk) => total + chunk.bytes, 0);
		this.dropped = Math.max(0, metadata?.droppedBytes ?? 0);
		this.next = Math.max(metadata?.nextSeq ?? 1, (this.chunks.at(-1)?.seq ?? 0) + 1);
		while (this.bytes > this.maxBytes && this.chunks.length) {
			const removed = this.chunks.shift()!;
			this.bytes -= removed.bytes;
			this.dropped += removed.bytes;
		}
	}

	read(job: JobRecord, afterSeq = 0, maxBytes = 65_536, stream: "stdout" | "stderr" | "combined" = "combined"): JobReadResult {
		const earliestSeq = this.chunks[0]?.seq ?? this.next;
		const chunks: JobChunk[] = [];
		let bytes = 0;
		let truncated = false;
		for (const chunk of this.chunks) {
			if (chunk.seq <= afterSeq || (stream !== "combined" && chunk.stream !== stream)) continue;
			if (bytes + chunk.bytes > maxBytes) { truncated = true; break; }
			chunks.push(chunk);
			bytes += chunk.bytes;
		}
		return {
			job,
			chunks,
			nextSeq: chunks.at(-1)?.seq ?? afterSeq,
			earliestSeq,
			truncated,
			droppedBeforeSeq: afterSeq < earliestSeq - 1 ? earliestSeq - 1 : undefined,
		};
	}

	snapshot(): JobChunk[] { return this.chunks.map((chunk) => ({ ...chunk })); }
	get nextSeq(): number { return this.next; }
	get bufferedBytes(): number { return this.bytes; }
	get droppedBytes(): number { return this.dropped; }
}
