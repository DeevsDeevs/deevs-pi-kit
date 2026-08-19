import { open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectDetachedShell } from "../shared/process-safety.ts";

const SKIP_DIRS = new Set([".git", "node_modules", ".pi", ".chains", ".missions"]);

export default function childSafetyRuntime(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "safe_read",
		label: "Read project file",
		description: "Read a bounded UTF-8 file inside the delegated project.",
		parameters: Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Number({ minimum: 0 })),
			maxBytes: Type.Optional(Type.Number({ minimum: 1, maximum: 200_000 })),
		}),
		async execute(_id, input) {
			const target = await projectPath(input.path);
			const info = await stat(target);
			if (!info.isFile()) throw new Error(`Not a file: ${input.path}`);
			const offset = Math.floor(input.offset ?? 0);
			const maxBytes = Math.floor(input.maxBytes ?? 65_536);
			const length = Math.max(0, Math.min(maxBytes, info.size - offset));
			const bytes = Buffer.alloc(length);
			const handle = await open(target, "r");
			let bytesRead = 0;
			try {
				({ bytesRead } = await handle.read(bytes, 0, length, offset));
			} finally {
				await handle.close();
			}
			const clipped = bytes.subarray(0, bytesRead);
			if (clipped.includes(0)) throw new Error("safe_read supports text files only.");
			const suffix = offset + clipped.length < info.size ? `\n[truncated; next offset ${offset + clipped.length}]` : "";
			return result(`${clipped.toString("utf8")}${suffix}`, { path: path.relative(process.cwd(), target), offset, bytes: clipped.length, totalBytes: info.size });
		},
	});

	pi.registerTool({
		name: "safe_list",
		label: "List project files",
		description: "List files inside the delegated project without executing commands.",
		parameters: Type.Object({
			path: Type.Optional(Type.String()),
			maxDepth: Type.Optional(Type.Number({ minimum: 0, maximum: 12 })),
			maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 2_000 })),
		}),
		async execute(_id, input) {
			const root = await projectPath(input.path);
			const files = await walk(root, Math.floor(input.maxDepth ?? 4), Math.floor(input.maxResults ?? 500));
			return result(files.length ? files.join("\n") : "No files found.", { files });
		},
	});

	pi.registerTool({
		name: "review_report",
		label: "Submit structured review",
		description: "Persist schema-validated findings. Runtime derives release disposition from severity: blocker/major require changes; minor/nit are non-blocking backlog. Prose is explanatory only.",
		parameters: Type.Object({
			verdict: Type.Union([Type.Literal("clear"), Type.Literal("changes_requested")]),
			overallExplanation: Type.String(),
			findings: Type.Array(Type.Object({
				severity: Type.Union([Type.Literal("blocker"), Type.Literal("major"), Type.Literal("minor"), Type.Literal("nit")]),
				summary: Type.String(),
				path: Type.Optional(Type.String()),
				line: Type.Optional(Type.Integer({ minimum: 1 })),
			}), { maxItems: 1_000 }),
		}),
		async execute(_id, input) {
			const artifacts = process.env.DEEVS_PI_SUBAGENT_ARTIFACTS;
			if (!artifacts) throw new Error("Review artifact directory is unavailable.");
			const report = { version: 1, ...input, submittedAt: Date.now() };
			await writeFile(path.join(artifacts, "review-report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			return result(`Structured review recorded: ${input.verdict}`, report);
		},
	});

	pi.registerTool({
		name: "safe_search",
		label: "Search project text",
		description: "Search bounded text files inside the delegated project without executing commands.",
		parameters: Type.Object({
			query: Type.String(),
			path: Type.Optional(Type.String()),
			regex: Type.Optional(Type.Boolean()),
			caseSensitive: Type.Optional(Type.Boolean()),
			maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
		}),
		async execute(_id, input) {
			if (!input.query) throw new Error("safe_search requires a non-empty query.");
			const root = await projectPath(input.path);
			const flags = input.caseSensitive ? "g" : "gi";
			const expression = input.regex ? new RegExp(input.query, flags) : new RegExp(escapeRegex(input.query), flags);
			const maxResults = Math.floor(input.maxResults ?? 100);
			const files = await walk(root, 12, 5_000);
			const matches: string[] = [];
			for (const file of files) {
				const absolute = path.join(root, file);
				const info = await stat(absolute).catch(() => undefined);
				if (!info?.isFile() || info.size > 1_000_000) continue;
				const text = await readFile(absolute, "utf8").catch(() => undefined);
				if (text === undefined || text.includes("\0")) continue;
				for (const [index, line] of text.split(/\r?\n/).entries()) {
					expression.lastIndex = 0;
					if (!expression.test(line)) continue;
					matches.push(`${file}:${index + 1}: ${line.slice(0, 300)}`);
					if (matches.length >= maxResults) break;
				}
				if (matches.length >= maxResults) break;
			}
			return result(matches.length ? matches.join("\n") : "No matches.", { matches });
		},
	});

	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		const command = event.input.command;
		if (typeof command !== "string") return undefined;
		const reason = detectDetachedShell(command);
		if (!reason) return undefined;
		return { block: true, reason };
	});
}

async function projectPath(requested = "."): Promise<string> {
	const root = await realpath(process.cwd());
	const target = await realpath(path.resolve(root, requested)).catch(() => undefined);
	if (!target) throw new Error(`Path does not exist: ${requested}`);
	const relative = path.relative(root, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path is outside the delegated project.");
	return target;
}

async function walk(root: string, maxDepth: number, maxResults: number): Promise<string[]> {
	const files: string[] = [];
	async function visit(directory: string, depth: number): Promise<void> {
		if (files.length >= maxResults) return;
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (files.length >= maxResults) break;
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) await visit(absolute, depth + 1);
			} else if (entry.isFile()) {
				files.push(path.relative(root, absolute) || entry.name);
			}
		}
	}
	await visit(root, 0);
	return files;
}

function result(text: string, details: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
