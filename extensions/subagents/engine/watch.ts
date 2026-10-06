// What a Monitor probe sees, and how it compares two looks. Bytes, sizes, mtimes and hashes only; never prose.
import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** A folder's files by relative path (`size:mtime`), or how far a file has been read. */
export type PathSeen = { files: Record<string, string | undefined> } | { offset: number };
export interface UrlSeen { status: number; hash: string; etag?: string }

export const EVENT_CHARS = 3_000;
export const LINE_CHARS = 500;

export async function lookAtPath(path: string, before: PathSeen | undefined): Promise<{ seen: PathSeen; event?: string; baseline: string }> {
	const info = await stat(path).catch(() => undefined);
	if (info?.isDirectory() || (info === undefined && before !== undefined && "files" in before)) {
		const files: Record<string, string | undefined> = {};
		if (info) await listInto(path, "", files);
		const lines = before && "files" in before ? changes(before.files, files) : [];
		return { seen: { files }, event: lines.length ? cut(lines.join("\n")) : undefined, baseline: `${Object.keys(files).length} files` };
	}
	const size = info?.size ?? 0;
	const from = before && "offset" in before && before.offset <= size ? before.offset : 0;
	if (!before) return { seen: { offset: size }, baseline: `${size} bytes` };
	if (size === from) return { seen: { offset: size }, baseline: `${size} bytes` };
	const handle = await open(path, "r");
	try {
		const length = Math.min(size - from, EVENT_CHARS * 4);
		const { buffer } = await handle.read(Buffer.alloc(length), 0, length, from);
		return { seen: { offset: from + length }, event: cut(buffer.toString("utf8").replace(/\n$/, "")), baseline: `${size} bytes` };
	} finally {
		await handle.close();
	}
}

async function listInto(root: string, prefix: string, into: Record<string, string | undefined>): Promise<void> {
	for (const entry of await readdir(join(root, prefix), { withFileTypes: true }).catch(() => [])) {
		if (entry.name === ".git") continue;
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) await listInto(root, rel, into);
		else {
			const info = await stat(join(root, rel)).catch(() => undefined);
			if (info) into[rel] = `${info.size}:${info.mtimeMs}`;
		}
	}
}

function changes(before: Record<string, string | undefined>, after: Record<string, string | undefined>): string[] {
	const lines: string[] = [];
	for (const [rel, mark] of Object.entries(after)) {
		if (before[rel] === undefined) lines.push(`added ${rel}`);
		else if (before[rel] !== mark) lines.push(`changed ${rel}`);
	}
	for (const rel of Object.keys(before)) if (after[rel] === undefined) lines.push(`removed ${rel}`);
	return lines;
}

/** One GET; a status change or a changed body is an event. Status 0 means the request itself failed. */
export async function lookAtUrl(url: string, before: UrlSeen | undefined, signal: AbortSignal): Promise<{ seen: UrlSeen; event?: string; baseline: string }> {
	const response = await fetch(url, { headers: before?.etag ? { "if-none-match": before.etag } : undefined, signal }).catch(() => undefined);
	if (response?.status === 304 && before) return { seen: before, baseline: `${before.status}` };
	const body = response ? await response.text().catch(() => "") : "";
	const seen: UrlSeen = { status: response?.status ?? 0, hash: createHash("sha256").update(body).digest("hex"), etag: response?.headers.get("etag") ?? undefined };
	const baseline = `${seen.status}, ${formatBytes(Buffer.byteLength(body))}`;
	if (!before) return { seen, baseline };
	if (before.status !== seen.status) return { seen, baseline, event: `status ${before.status} → ${seen.status}` };
	return { seen, baseline, event: before.hash === seen.hash ? undefined : cut(body) };
}

function formatBytes(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function cut(text: string, chars = EVENT_CHARS): string {
	return text.length > chars ? `${text.slice(0, chars)}…` : text;
}

/** CC's token bucket: 10 events, refilled 1 per 2 s. `take` returns how many events were dropped before this one, "drop", or "stop" after 30 s of overflow. */
export class RateLimit {
	private tokens = 10;
	private dropped = 0;
	private overflowSince: number | undefined;
	private at: number;

	constructor(now: number) {
		this.at = now;
	}

	take(now: number): number | "drop" | "stop" {
		this.tokens = Math.min(10, this.tokens + (now - this.at) / 2_000);
		this.at = now;
		if (this.tokens >= 1) {
			this.tokens--;
			const dropped = this.dropped;
			this.dropped = 0;
			if (!dropped) this.overflowSince = undefined;
			return dropped;
		}
		this.overflowSince ??= now;
		this.dropped++;
		return now - this.overflowSince > 30_000 ? "stop" : "drop";
	}
}
