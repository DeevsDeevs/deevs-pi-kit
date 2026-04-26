import { createHash } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProcessesConfig } from "./config.ts";
import type { OutputStream } from "./types.ts";

export interface ProcessLogPaths {
	logFile: string;
	stdoutLogFile: string;
	stderrLogFile: string;
}

export interface ProcessLogInfo extends ProcessLogPaths {
	bytesWritten: number;
	maxBytes: number;
	truncated: boolean;
}

export interface ProcessLogRead extends ProcessLogInfo {
	stream: "stdout" | "stderr" | "combined";
	content: string;
	contentBytes: number;
	truncatedFromStart: boolean;
}

export class ProcessLogWriter {
	private readonly combined: WriteStream;
	private readonly stdout: WriteStream;
	private readonly stderr: WriteStream;
	private bytesWritten = 0;
	private truncated = false;

	private constructor(
		private readonly paths: ProcessLogPaths,
		private readonly maxBytes: number,
	) {
		this.combined = createWriteStream(paths.logFile, { flags: "a" });
		this.stdout = createWriteStream(paths.stdoutLogFile, { flags: "a" });
		this.stderr = createWriteStream(paths.stderrLogFile, { flags: "a" });
	}

	static async create(options: { id: string; name: string; cwd: string; config: ProcessesConfig }): Promise<ProcessLogWriter | null> {
		if (!options.config.logs.enabled) return null;

		const directory = getLogDirectory(options.cwd, options.config);
		await mkdir(directory, { recursive: true });

		const prefix = `${options.id}-${sanitizeFilePart(options.name)}`;
		return new ProcessLogWriter(
			{
				logFile: join(directory, `${prefix}.log`),
				stdoutLogFile: join(directory, `${prefix}.stdout.log`),
				stderrLogFile: join(directory, `${prefix}.stderr.log`),
			},
			options.config.limits.maxLogBytesPerProcess,
		);
	}

	append(stream: OutputStream, text: string): number {
		if (this.truncated) return 0;

		const entry = formatLogEntry(stream, text);
		let bytes = Buffer.byteLength(entry);
		let toWrite = entry;

		if (this.bytesWritten + bytes > this.maxBytes) {
			const remaining = Math.max(0, this.maxBytes - this.bytesWritten);
			toWrite = remaining > 0 ? Buffer.from(entry).subarray(0, remaining).toString("utf8") : "";
			const notice = "\n[proc log truncated: maxLogBytesPerProcess reached]\n";
			toWrite += notice;
			bytes = Buffer.byteLength(toWrite);
			this.truncated = true;
		}

		if (toWrite.length === 0) return 0;
		this.combined.write(toWrite);
		(stream === "stdout" ? this.stdout : this.stderr).write(text);
		this.bytesWritten += bytes;
		return bytes;
	}

	info(): ProcessLogInfo {
		return {
			...this.paths,
			bytesWritten: this.bytesWritten,
			maxBytes: this.maxBytes,
			truncated: this.truncated,
		};
	}

	async close(): Promise<void> {
		await Promise.all([closeStream(this.combined), closeStream(this.stdout), closeStream(this.stderr)]);
	}

	async deleteFiles(): Promise<void> {
		await Promise.all(Object.values(this.paths).map((path) => rm(path, { force: true })));
	}
}

export async function readLogTail(info: ProcessLogInfo, options: { stream?: "stdout" | "stderr" | "combined"; maxBytes: number }): Promise<ProcessLogRead> {
	const stream = options.stream ?? "combined";
	const path = stream === "stdout" ? info.stdoutLogFile : stream === "stderr" ? info.stderrLogFile : info.logFile;
	const file = await open(path, "r");
	try {
		const stat = await file.stat();
		const contentBytes = Math.max(0, Math.min(options.maxBytes, stat.size));
		const buffer = Buffer.alloc(contentBytes);
		await file.read(buffer, 0, contentBytes, stat.size - contentBytes);
		return {
			...info,
			stream,
			content: buffer.toString("utf8"),
			contentBytes,
			truncatedFromStart: stat.size > contentBytes,
		};
	} finally {
		await file.close();
	}
}

export function getLogDirectory(cwd: string, config: ProcessesConfig): string {
	if (config.logs.directory) return config.logs.directory;
	const root = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const project = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return join(root, "process-logs", project);
}

function formatLogEntry(stream: OutputStream, text: string): string {
	return `[${new Date().toISOString()} ${stream}] ${text}`;
}

function sanitizeFilePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "process";
}

function closeStream(stream: WriteStream): Promise<void> {
	return new Promise((resolve, reject) => {
		if (stream.closed || stream.destroyed) return resolve();
		stream.once("error", reject);
		stream.end(() => {
			stream.off("error", reject);
			resolve();
		});
	});
}
