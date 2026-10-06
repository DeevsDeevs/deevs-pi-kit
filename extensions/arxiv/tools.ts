import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { ArxivService } from "./service.ts";
import type { ArxivGetResult, ArxivPaper, ArxivSearchResult } from "./types.ts";

const ArxivSchema = Type.Object({
	action: StringEnum(["search", "get"] as const, { description: "search papers, or get exact ids" }),
	query: Type.Optional(Type.String({ description: "search: all fields" })),
	title: Type.Optional(Type.String({ description: "search: title" })),
	author: Type.Optional(Type.String({ description: "search: author" })),
	abstract: Type.Optional(Type.String({ description: "search: abstract" })),
	category: Type.Optional(Type.String({ description: "search: category such as cs.LG" })),
	start: Type.Optional(Type.Number({ description: "search: offset" })),
	maxResults: Type.Optional(Type.Number({ description: "search: papers, default 5, max 25" })),
	sortBy: Type.Optional(StringEnum(["relevance", "submittedDate", "lastUpdatedDate"] as const)),
	sortOrder: Type.Optional(StringEnum(["ascending", "descending"] as const)),
	ids: Type.Optional(Type.String({ description: "get: arXiv ids, comma or space separated" })),
	includeBibtex: Type.Optional(Type.Boolean({ description: "get: add BibTeX" })),
});

export type ArxivArgs = Static<typeof ArxivSchema>;

export function registerArxivTools(pi: ExtensionAPI, service: ArxivService): void {
	pi.registerTool({
		name: "arxiv",
		label: "arXiv",
		description: "Search arXiv or get papers by id: metadata, abstracts, links, optional BibTeX. Load the arxiv skill first.",
		parameters: ArxivSchema,
		defaultActive: false,
		async execute(_toolCallId, params): Promise<AgentToolResult<ArxivSearchResult | ArxivGetResult>> {
			if (params.action === "search") {
				const result = await service.search(params);
				return { content: [{ type: "text", text: formatSearch(result) }], details: result };
			}
			if (!params.ids) throw new Error("arxiv get needs ids.");
			const result = await service.get({ ids: params.ids, includeBibtex: params.includeBibtex });
			return { content: [{ type: "text", text: formatGet(result) }], details: result };
		},
		renderCall(args, theme) { return paperCall(args.action ?? "", String(args.ids ?? args.query ?? args.title ?? args.author ?? args.category ?? ""), theme); },
		renderResult(result, { expanded }, theme) { return paperResult(result.details, expanded, theme); },
	});
}

function paperCall(action: string, target: string, theme: Theme): Text {
	return new Text(theme.fg("toolTitle", theme.bold(`arXiv ${action} `)) + theme.fg("muted", target.replace(/\s+/g, " ").slice(0, 80)), 0, 0);
}

function paperResult(details: unknown, expanded: boolean, theme: Theme): Text {
	const value = details as { papers?: Array<{ title?: string; authors?: string[]; id?: string }> } | undefined;
	if (value?.papers) {
		const visible = expanded ? value.papers : value.papers.slice(0, 3);
		let text = `${theme.fg("success", "✓")} ${value.papers.length} paper(s)`;
		for (const paper of visible) text += `\n${theme.fg("accent", paper.title ?? paper.id ?? "paper")}${expanded && paper.authors?.length ? theme.fg("dim", ` — ${paper.authors.join(", ")}`) : ""}`;
		if (!expanded && value.papers.length > visible.length) text += `\n${theme.fg("dim", `… ${value.papers.length - visible.length} more`)}`;
		return new Text(text, 0, 0);
	}
	return new Text(theme.fg("dim", "arXiv operation complete"), 0, 0);
}

function formatSearch(result: ArxivSearchResult): string {
	const total = result.totalResults === null ? "unknown" : String(result.totalResults);
	const lines = [`arXiv search: ${result.query}`, `Total: ${total}; showing ${result.papers.length} from offset ${result.start}`];
	if (!result.papers.length) lines.push("No papers found.");
	result.papers.forEach((paper, index) => lines.push("", formatPaperLine(paper, result.start + index + 1)));
	if (result.truncated) lines.push("", "[results truncated by maxResults]");
	return lines.join("\n");
}

function formatGet(result: ArxivGetResult): string {
	const lines = [`arXiv get: ${result.ids.join(", ")}`];
	if (!result.papers.length) lines.push("No papers found.");
	result.papers.forEach((paper) => {
		lines.push("", formatPaperLine(paper));
		if (paper.bibtex) lines.push("", "```bibtex", paper.bibtex, "```");
	});
	if (result.missing.length) lines.push("", `Missing: ${result.missing.join(", ")}`);
	return lines.join("\n");
}

function formatPaperLine(paper: ArxivPaper, index?: number): string {
	const prefix = index === undefined ? "" : `${index}. `;
	const summary = paper.summary.length <= 500 ? paper.summary : `${paper.summary.slice(0, 499)}…`;
	return `${prefix}[${paper.id}] ${paper.title}\n   Authors: ${paper.authors.join(", ") || "(unknown)"}\n   Published: ${paper.published.slice(0, 10)} | Updated: ${paper.updated.slice(0, 10)} | Categories: ${paper.categories.join(", ") || "(none)"}\n   ${paper.absUrl}\n   PDF: ${paper.pdfUrl}\n   Abstract: ${summary}`;
}
