import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_GIT_BUFFER = 64 * 1024;
const MAX_PATHS = 100;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^:+-]{0,199}$/;

export function registerSafeDiffTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "safe_diff",
		label: "Inspect Git diff",
		description: "Read a bounded exact Git diff inside the current project without shell, hooks, pagers, external diff drivers, or text conversion.",
		parameters: Type.Object({
			base: Type.String({ description: "Exact base commit or revision" }),
			head: Type.String({ description: "Exact head commit or revision" }),
			paths: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_PATHS, description: "Optional project-relative literal paths" })),
			contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
		}),
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			const root = await exactRepositoryRoot(ctx.cwd, signal);
			const base = await commit(root, input.base, signal);
			const head = await commit(root, input.head, signal);
			const pathspec = await literalPaths(root, input.paths ?? []);
			const args = ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--color=never", `--unified=${input.contextLines ?? 3}`, base, head, ...(pathspec.length ? ["--", ...pathspec] : [])];
			const output = await git(root, args, signal);
			const truncated = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			const suffix = truncated.truncated ? `\n\n[Diff truncated to ${truncated.outputLines} lines / ${truncated.outputBytes} bytes; narrow paths or contextLines.]` : "";
			return {
				content: [{ type: "text" as const, text: `${truncated.content || "No differences."}${suffix}` }],
				details: { root, baseCommit: base, headCommit: head, paths: input.paths ?? [], truncated: truncated.truncated },
			};
		},
	});
}

async function exactRepositoryRoot(cwd: string, signal: AbortSignal | undefined): Promise<string> {
	const canonical = await realpath(resolve(cwd));
	const root = await realpath((await git(canonical, ["rev-parse", "--show-toplevel"], signal)).trim());
	if (root !== canonical) throw new Error("safe_diff requires the current project directory to be the Git worktree root.");
	return root;
}

async function commit(root: string, revision: string, signal: AbortSignal | undefined): Promise<string> {
	if (!REVISION.test(revision)) throw new Error("Revision contains unsupported syntax.");
	const value = (await git(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], signal)).trim();
	if (!/^[0-9a-f]{40,64}$/.test(value)) throw new Error(`Revision did not resolve to one commit: ${revision}`);
	return value;
}

async function literalPaths(root: string, paths: string[]): Promise<string[]> {
	const result: string[] = [];
	for (const path of paths) {
		if (!path || path.includes("\0")) throw new Error("Diff paths must be non-empty project-relative strings.");
		const target = resolve(root, path);
		const rel = relative(root, target).replaceAll("\\", "/");
		if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`Diff path escapes or names the whole project: ${path}`);
		result.push(`:(top,literal)${rel}`);
	}
	return result;
}

function git(cwd: string, args: string[], signal: AbortSignal | undefined): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile("git", ["-c", "core.pager=cat", "-c", "color.ui=false", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
			cwd,
			env: safeGitEnvironment(),
			encoding: "utf8",
			maxBuffer: MAX_GIT_BUFFER,
			timeout: 10_000,
			signal,
		}, (error, stdout, stderr) => {
			if (error) {
				const detail = String(stderr).trim().slice(0, 2_000);
				reject(new Error(`safe_diff Git operation failed${detail ? `: ${detail}` : "."}`));
				return;
			}
			resolvePromise(String(stdout));
		});
	});
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) if (key.startsWith("GIT_")) delete environment[key];
	return { ...environment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_EXTERNAL_DIFF: "", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat", LC_ALL: "C" };
}
