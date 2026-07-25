import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showTextViewer } from "../shared/text-viewer.ts";
import type { ArxivService } from "./service.ts";
import { formatBibtex, formatGet, formatSearch } from "./tools.ts";
import type { ArxivSearchInput, ArxivSortBy } from "./types.ts";

export function registerArxivCommands(pi: ExtensionAPI, service: ArxivService): void {
	pi.registerCommand("arxiv:search", {
		description: "Search arXiv papers",
		handler: async (args, ctx) => {
			const parsed = parseSearchArgs(args);
			if (!parsed) return ctx.ui.notify("Usage: /arxiv:search [--max N] [--sort relevance|submittedDate|lastUpdatedDate] [--category cs.LG] [--author name] <query>", "warning");
			try { await showTextViewer(ctx, "arXiv search", formatSearch(await service.search(parsed))); } catch (error) { ctx.ui.notify(message(error), "error"); }
		},
	});

	pi.registerCommand("arxiv:get", {
		description: "Fetch arXiv paper metadata by id",
		handler: async (args, ctx) => {
			const parts = splitArgs(args);
			const includeBibtex = removeFlag(parts, "--bibtex");
			if (!parts.length) return ctx.ui.notify("Usage: /arxiv:get [--bibtex] <id[,id]>", "warning");
			try { await showTextViewer(ctx, "arXiv papers", formatGet(await service.get({ ids: parts.join(","), includeBibtex }))); } catch (error) { ctx.ui.notify(message(error), "error"); }
		},
	});

	pi.registerCommand("arxiv:bibtex", {
		description: "Generate BibTeX for arXiv ids",
		handler: async (args, ctx) => {
			const ids = args.trim();
			if (!ids) return ctx.ui.notify("Usage: /arxiv:bibtex <id[,id]>", "warning");
			try { await showTextViewer(ctx, "arXiv BibTeX", formatBibtex(await service.bibtex({ ids }))); } catch (error) { ctx.ui.notify(message(error), "error"); }
		},
	});
}

function parseSearchArgs(args: string): ArxivSearchInput | null {
	const parts = splitArgs(args);
	if (!parts.length) return null;
	const maxRaw = takeFlagValue(parts, "--max") ?? takeFlagValue(parts, "--max-results");
	const sortBy = takeFlagValue(parts, "--sort") as ArxivSortBy | undefined;
	const category = takeFlagValue(parts, "--category");
	const author = takeFlagValue(parts, "--author");
	const title = takeFlagValue(parts, "--title");
	const abstract = takeFlagValue(parts, "--abstract");
	const startRaw = takeFlagValue(parts, "--start");
	const query = parts.join(" ").trim();
	if (!query && !category && !author && !title && !abstract) return null;
	return {
		query: query || undefined,
		category,
		author,
		title,
		abstract,
		maxResults: maxRaw === undefined ? undefined : Number(maxRaw),
		start: startRaw === undefined ? undefined : Number(startRaw),
		sortBy,
	};
}

function splitArgs(args: string): string[] {
	return args.match(/"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|\S+/g)?.map((part) => part.replace(/^[']|[']$/g, "").replace(/^[\"]|[\"]$/g, "")) ?? [];
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
