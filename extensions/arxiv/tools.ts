import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { ArxivService } from "./service.ts";
import { formatPaperLine } from "./service.ts";
import type { ArxivBibtexInput, ArxivGetInput, ArxivSearchInput } from "./types.ts";

const SearchSchema = Type.Object({
	query: Type.Optional(Type.String({ description: "General arXiv query searched across all fields" })),
	title: Type.Optional(Type.String({ description: "Title field query" })),
	author: Type.Optional(Type.String({ description: "Author field query" })),
	abstract: Type.Optional(Type.String({ description: "Abstract field query" })),
	category: Type.Optional(Type.String({ description: "arXiv category such as cs.LG, cs.AI, cs.CL, stat.ML" })),
	start: Type.Optional(Type.Number({ description: "Result offset, default 0" })),
	maxResults: Type.Optional(Type.Number({ description: "Maximum papers to return, capped at 25" })),
	sortBy: Type.Optional(StringEnum(["relevance", "submittedDate", "lastUpdatedDate"] as const, { description: "Sort field" })),
	sortOrder: Type.Optional(StringEnum(["ascending", "descending"] as const, { description: "Sort order; default descending" })),
});

const IdsSchema = Type.Object({
	ids: Type.String({ description: "One arXiv id, or comma/space-separated arXiv ids" }),
	includeBibtex: Type.Optional(Type.Boolean({ description: "Include BibTeX entries with paper metadata" })),
});

const BibtexSchema = Type.Object({
	ids: Type.String({ description: "One arXiv id, or comma/space-separated arXiv ids" }),
});

export function registerArxivTools(pi: ExtensionAPI, service: ArxivService): void {
	pi.registerTool({
		name: "arxiv_search",
		label: "Search arXiv",
		description: "Search arXiv papers via the official export API. No API key; bounded results; returns metadata, abstracts, and links.",
		promptSnippet: "Search arXiv for papers by query, author, title, abstract, or category.",
		promptGuidelines: ["Use for paper discovery and abstract-level triage.", "Keep maxResults small unless the user asks for a broad survey.", "Do not treat arXiv preprints as peer-reviewed truth."],
		parameters: SearchSchema,
		async execute(_toolCallId: string, params: ArxivSearchInput) {
			const result = await service.search(params);
			return { content: [{ type: "text", text: formatSearch(result) }], details: result };
		},
		renderCall(args: ArxivSearchInput, theme: Theme) { return paperCall("search", args.query ?? args.title ?? args.author ?? args.category ?? "fields", theme); },
		renderResult(result: { details?: unknown }, { expanded }: { expanded: boolean }, theme: Theme) { return paperResult(result.details, expanded, theme); },
	});

	pi.registerTool({
		name: "arxiv_get",
		label: "Get arXiv Papers",
		description: "Fetch metadata and abstracts for one or more specific arXiv IDs.",
		promptSnippet: "Retrieve exact arXiv papers by id for citation, abstract review, or BibTeX.",
		promptGuidelines: ["Use when the user provides exact arXiv IDs or needs metadata for known papers."],
		parameters: IdsSchema,
		async execute(_toolCallId: string, params: ArxivGetInput) {
			const result = await service.get(params);
			return { content: [{ type: "text", text: formatGet(result) }], details: result };
		},
		renderCall(args: ArxivGetInput, theme: Theme) { return paperCall("get", Array.isArray(args.ids) ? args.ids.join(", ") : args.ids, theme); },
		renderResult(result: { details?: unknown }, { expanded }: { expanded: boolean }, theme: Theme) { return paperResult(result.details, expanded, theme); },
	});

	pi.registerTool({
		name: "arxiv_bibtex",
		label: "arXiv BibTeX",
		description: "Generate simple BibTeX entries for one or more arXiv IDs from official metadata.",
		promptSnippet: "Generate BibTeX for arXiv papers by id.",
		promptGuidelines: ["Use only for exact arXiv IDs; prefer arxiv_search first when the paper is unknown."],
		parameters: BibtexSchema,
		async execute(_toolCallId: string, params: ArxivBibtexInput) {
			const result = await service.bibtex(params);
			return { content: [{ type: "text", text: formatBibtex(result) }], details: result };
		},
		renderCall(args: ArxivBibtexInput, theme: Theme) { return paperCall("bibtex", Array.isArray(args.ids) ? args.ids.join(", ") : args.ids, theme); },
		renderResult(result: { details?: unknown }, { expanded }: { expanded: boolean }, theme: Theme) { return paperResult(result.details, expanded, theme); },
	});
}

function paperCall(action: string, target: string, theme: Theme): Text {
	return new Text(theme.fg("toolTitle", theme.bold(`arXiv ${action} `)) + theme.fg("muted", target.replace(/\s+/g, " ").slice(0, 80)), 0, 0);
}

function paperResult(details: unknown, expanded: boolean, theme: Theme): Text {
	const value = details as { papers?: Array<{ title?: string; authors?: string[]; id?: string }>; entries?: string[]; missing?: string[] } | undefined;
	if (value?.papers) {
		const visible = expanded ? value.papers : value.papers.slice(0, 3);
		let text = `${theme.fg("success", "✓")} ${value.papers.length} paper(s)`;
		for (const paper of visible) text += `\n${theme.fg("accent", paper.title ?? paper.id ?? "paper")}${expanded && paper.authors?.length ? theme.fg("dim", ` — ${paper.authors.join(", ")}`) : ""}`;
		if (!expanded && value.papers.length > visible.length) text += `\n${theme.fg("dim", `… ${value.papers.length - visible.length} more`)}`;
		return new Text(text, 0, 0);
	}
	if (value?.entries) return new Text(`${theme.fg("success", "✓")} ${value.entries.length} BibTeX entr${value.entries.length === 1 ? "y" : "ies"}${value.missing?.length ? theme.fg("warning", ` · ${value.missing.length} missing`) : ""}`, 0, 0);
	return new Text(theme.fg("dim", "arXiv operation complete"), 0, 0);
}

export function formatSearch(result: Awaited<ReturnType<ArxivService["search"]>>): string {
	const total = result.totalResults === null ? "unknown" : String(result.totalResults);
	const lines = [`arXiv search: ${result.query}`, `Total: ${total}; showing ${result.papers.length} from offset ${result.start}`];
	if (!result.papers.length) lines.push("No papers found.");
	result.papers.forEach((paper, index) => lines.push("", formatPaperLine(paper, result.start + index + 1)));
	if (result.truncated) lines.push("", "[results truncated by maxResults]");
	return lines.join("\n");
}

export function formatGet(result: Awaited<ReturnType<ArxivService["get"]>>): string {
	const lines = [`arXiv get: ${result.ids.join(", ")}`];
	if (!result.papers.length) lines.push("No papers found.");
	result.papers.forEach((paper) => {
		lines.push("", formatPaperLine(paper));
		if (paper.bibtex) lines.push("", "```bibtex", paper.bibtex, "```");
	});
	if (result.missing.length) lines.push("", `Missing: ${result.missing.join(", ")}`);
	return lines.join("\n");
}

export function formatBibtex(result: Awaited<ReturnType<ArxivService["bibtex"]>>): string {
	const lines = [`arXiv BibTeX: ${result.ids.join(", ")}`];
	if (result.entries.length) lines.push("", "```bibtex", result.entries.join("\n\n"), "```");
	else lines.push("No BibTeX entries generated.");
	if (result.missing.length) lines.push("", `Missing: ${result.missing.join(", ")}`);
	return lines.join("\n");
}
