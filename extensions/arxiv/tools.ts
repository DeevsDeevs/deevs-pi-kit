import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
	sortBy: Type.Optional(Type.String({ description: "relevance, submittedDate, or lastUpdatedDate" })),
	sortOrder: Type.Optional(Type.String({ description: "ascending or descending; default descending" })),
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
		async execute(_toolCallId, params: ArxivSearchInput) {
			const result = await service.search(params);
			return { content: [{ type: "text", text: formatSearch(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "arxiv_get",
		label: "Get arXiv Papers",
		description: "Fetch metadata and abstracts for one or more specific arXiv IDs.",
		promptSnippet: "Retrieve exact arXiv papers by id for citation, abstract review, or BibTeX.",
		parameters: IdsSchema,
		async execute(_toolCallId, params: ArxivGetInput) {
			const result = await service.get(params);
			return { content: [{ type: "text", text: formatGet(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "arxiv_bibtex",
		label: "arXiv BibTeX",
		description: "Generate simple BibTeX entries for one or more arXiv IDs from official metadata.",
		promptSnippet: "Generate BibTeX for arXiv papers by id.",
		parameters: BibtexSchema,
		async execute(_toolCallId, params: ArxivBibtexInput) {
			const result = await service.bibtex(params);
			return { content: [{ type: "text", text: formatBibtex(result) }], details: result };
		},
	});
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
