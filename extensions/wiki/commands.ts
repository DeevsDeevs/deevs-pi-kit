import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { WikiService } from "./service.ts";
import { formatGraph, formatInit, formatLint, formatSearch, formatStatus } from "./tools.ts";
import type { WikiSearchMode } from "./types.ts";

export function registerWikiCommands(pi: ExtensionAPI, service: WikiService): void {
	pi.registerCommand("wiki:init", {
		description: "Initialize a markdown wiki at an explicit path",
		handler: async (args, ctx) => {
			const parsed = parseInitArgs(args);
			if (!parsed) return ctx.ui.notify("Usage: /wiki:init <path> --domain \"domain description\" [--dry-run]", "warning");
			try { ctx.ui.notify(formatInit(await service.init(parsed)), "info"); } catch (error) { ctx.ui.notify(message(error), "error"); }
		},
	});

	pi.registerCommand("wiki:status", {
		description: "Show wiki status and top health warnings",
		handler: async (args, ctx) => {
			const path = args.trim();
			if (!path) return ctx.ui.notify("Usage: /wiki:status <path>", "warning");
			try { ctx.ui.notify(formatStatus(await service.status({ path })), "info"); } catch (error) { ctx.ui.notify(message(error), "error"); }
		},
	});

	pi.registerCommand("wiki:lint", {
		description: "Lint wiki links, index, frontmatter, tags, and raw hashes",
		handler: async (args, ctx) => {
			const path = args.trim();
			if (!path) return ctx.ui.notify("Usage: /wiki:lint <path>", "warning");
			try { ctx.ui.notify(formatLint(await service.lint({ path })), "info"); } catch (error) { ctx.ui.notify(message(error), "error"); }
		},
	});

	pi.registerCommand("wiki:graph", {
		description: "Build wiki graph from [[wikilinks]]",
		handler: async (args, ctx) => {
			const path = args.trim();
			if (!path) return ctx.ui.notify("Usage: /wiki:graph <path>", "warning");
			try { ctx.ui.notify(formatGraph(await service.graph({ path, includeOrphans: true })), "info"); } catch (error) { ctx.ui.notify(message(error), "error"); }
		},
	});

	pi.registerCommand("wiki:search", {
		description: "Search wiki pages by ranked lookup, exact text, or regex",
		handler: async (args, ctx) => {
			const parsed = parseSearchArgs(args);
			if (!parsed) return ctx.ui.notify("Usage: /wiki:search <path> [--lookup|--text|--regex] <query>", "warning");
			try { ctx.ui.notify(formatSearch(await service.search(parsed)), "info"); } catch (error) { ctx.ui.notify(message(error), "error"); }
		},
	});

	pi.registerCommand("wiki:context", {
		description: "Pack bounded wiki context for a task",
		handler: async (args, ctx) => {
			const parsed = parseContextArgs(args);
			if (!parsed) return ctx.ui.notify("Usage: /wiki:context <path> <query>", "warning");
			try { ctx.ui.notify((await service.context(parsed)).context, "info"); } catch (error) { ctx.ui.notify(message(error), "error"); }
		},
	});
}

function parseInitArgs(args: string): { path: string; domain: string; dryRun?: boolean } | null {
	const parts = splitArgs(args);
	if (!parts.length) return null;
	const dryRun = removeFlag(parts, "--dry-run");
	const domain = takeFlagValue(parts, "--domain");
	const path = parts.shift();
	if (!path || !domain) return null;
	return { path, domain, dryRun };
}

function parseSearchArgs(args: string): { path: string; query: string; mode?: WikiSearchMode } | null {
	const parts = splitArgs(args);
	if (parts.length < 2) return null;
	let mode: WikiSearchMode | undefined;
	if (removeFlag(parts, "--regex")) mode = "regex";
	if (removeFlag(parts, "--text")) mode = "text";
	if (removeFlag(parts, "--lookup")) mode = "lookup";
	const path = parts.shift();
	if (!path || !parts.length) return null;
	return { path, query: parts.join(" "), mode };
}

function parseContextArgs(args: string): { path: string; query: string } | null {
	const parts = splitArgs(args);
	if (parts.length < 2) return null;
	const path = parts.shift()!;
	return { path, query: parts.join(" ") };
}

function splitArgs(args: string): string[] {
	return args.match(/"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|\S+/g)?.map((part) => part.replace(/^['\"]|['\"]$/g, "")) ?? [];
}

function takeFlagValue(parts: string[], flag: string): string | undefined {
	const index = parts.indexOf(flag);
	if (index < 0) return undefined;
	const value = parts[index + 1];
	parts.splice(index, 2);
	return value;
}

function removeFlag(parts: string[], flag: string): boolean {
	const index = parts.indexOf(flag);
	if (index < 0) return false;
	parts.splice(index, 1);
	return true;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
