import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { WikiService } from "./service.ts";
import type { WikiContextInput, WikiGraphInput, WikiInitInput, WikiLintInput, WikiSearchInput, WikiStatusInput } from "./types.ts";

const PathSchema = {
	path: Type.String({ description: "Explicit path to wiki root, relative to the project cwd" }),
};

const InitSchema = Type.Object({
	...PathSchema,
	domain: Type.String({ description: "Domain/scope this wiki covers" }),
	title: Type.Optional(Type.String({ description: "Index title; defaults to '<domain> Wiki'" })),
	dryRun: Type.Optional(Type.Boolean({ description: "Preview files that would be created without writing" })),
});

const StatusSchema = Type.Object({
	...PathSchema,
	maxIssues: Type.Optional(Type.Number({ description: "Maximum warning/issues to include" })),
});

const LintSchema = Type.Object({
	...PathSchema,
	maxIssues: Type.Optional(Type.Number({ description: "Maximum issues to return" })),
	includeWarnings: Type.Optional(Type.Boolean({ description: "Include warnings/notices; default true" })),
});

const GraphSchema = Type.Object({
	...PathSchema,
	includeOrphans: Type.Optional(Type.Boolean({ description: "Include pages with no inbound links" })),
	includeBacklinks: Type.Optional(Type.Boolean({ description: "Include backlinks map" })),
	maxNodes: Type.Optional(Type.Number({ description: "Maximum graph nodes to return" })),
	maxEdges: Type.Optional(Type.Number({ description: "Maximum graph edges to return" })),
});

const SearchSchema = Type.Object({
	...PathSchema,
	query: Type.String({ description: "Search query" }),
	mode: Type.Optional(Type.String({ description: "lookup for ranked results, text for exact text, regex for regex; default lookup" })),
	maxResults: Type.Optional(Type.Number({ description: "Maximum matches to return" })),
	contextLines: Type.Optional(Type.Number({ description: "Snippet context lines for text/regex modes" })),
	caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive text/regex search" })),
});

const ContextSchema = Type.Object({
	...PathSchema,
	query: Type.Optional(Type.String({ description: "Optional search query for relevant pages" })),
	pages: Type.Optional(Type.Array(Type.String({ description: "Explicit page id/path to include" }), { description: "Explicit wiki pages to include" })),
	searchMode: Type.Optional(Type.String({ description: "lookup for ranked results, text for exact text, regex for regex; default lookup" })),
	maxPages: Type.Optional(Type.Number({ description: "Maximum pages to include" })),
	includeBacklinks: Type.Optional(Type.Boolean({ description: "Include backlink ids for included pages" })),
	includeForwardLinks: Type.Optional(Type.Boolean({ description: "Include forward link ids for included pages" })),
	maxBytes: Type.Optional(Type.Number({ description: "Maximum context bytes to return" })),
	compact: Type.Optional(Type.Boolean({ description: "Use compact page excerpts; default true" })),
});

export function registerWikiTools(pi: ExtensionAPI, service: WikiService): void {
	pi.registerTool({
		name: "wiki_init",
		label: "Initialize Wiki",
		description: "Create a project-local markdown wiki structure with SCHEMA.md, index.md, log.md, and standard directories.",
		promptSnippet: "Initialize a curated markdown wiki after the user confirms path and domain.",
		promptGuidelines: ["Use only with an explicit path/domain.", "Do not initialize into non-empty directories.", "Prefer dryRun first if the path is uncertain."],
		parameters: InitSchema,
		async execute(_toolCallId, params: WikiInitInput) {
			const result = await service.init(params);
			return { content: [{ type: "text", text: formatInit(result) }], details: result };
		},
		renderCall: (args: WikiInitInput, theme: Theme) => wikiCall("init", args.path, theme),
		renderResult: (result, options, theme) => wikiResult(result.details, options.expanded, theme),
	});

	pi.registerTool({
		name: "wiki_status",
		label: "Wiki Status",
		description: "Inspect wiki structure, page counts, graph summary, and top health warnings.",
		promptSnippet: "Check a markdown wiki before editing or after changes.",
		parameters: StatusSchema,
		async execute(_toolCallId, params: WikiStatusInput) {
			const result = await service.status(params);
			return { content: [{ type: "text", text: formatStatus(result) }], details: result };
		},
		renderCall: (args: WikiStatusInput, theme: Theme) => wikiCall("status", args.path, theme),
		renderResult: (result, options, theme) => wikiResult(result.details, options.expanded, theme),
	});

	pi.registerTool({
		name: "wiki_lint",
		label: "Lint Wiki",
		description: "Deterministically report broken links, ambiguous links, orphans, index/frontmatter/tag issues, and source hash drift.",
		promptSnippet: "Lint a markdown wiki before broad edits or after ingest.",
		parameters: LintSchema,
		async execute(_toolCallId, params: WikiLintInput) {
			const result = await service.lint(params);
			return { content: [{ type: "text", text: formatLint(result) }], details: result };
		},
		renderCall: (args: WikiLintInput, theme: Theme) => wikiCall("lint", args.path, theme),
		renderResult: (result, options, theme) => wikiResult(result.details, options.expanded, theme),
	});

	pi.registerTool({
		name: "wiki_graph",
		label: "Wiki Graph",
		description: "Build an explicit graph from Obsidian-style [[wikilinks]] in a markdown wiki.",
		promptSnippet: "Inspect wiki link graph, backlinks, orphans, and broken/ambiguous links.",
		parameters: GraphSchema,
		async execute(_toolCallId, params: WikiGraphInput) {
			const result = await service.graph(params);
			return { content: [{ type: "text", text: formatGraph(result) }], details: result };
		},
		renderCall: (args: WikiGraphInput, theme: Theme) => wikiCall("graph", args.path, theme),
		renderResult: (result, options, theme) => wikiResult(result.details, options.expanded, theme),
	});

	pi.registerTool({
		name: "wiki_search",
		label: "Search Wiki",
		description: "Universal wiki search: ranked lookup by default, exact text with mode=text, regex with mode=regex.",
		promptSnippet: "Search curated wiki pages by relevance, exact text, or regex.",
		promptGuidelines: ["Use lookup mode for topics/ideas; use text/regex only for exact matching."],
		parameters: SearchSchema,
		async execute(_toolCallId, params: WikiSearchInput) {
			const result = await service.search(params);
			return { content: [{ type: "text", text: formatSearch(result) }], details: result };
		},
		renderCall: (args, theme) => wikiCall("search", args.query, theme),
		renderResult: (result, options, theme) => wikiResult(result.details, options.expanded, theme),
	});

	pi.registerTool({
		name: "wiki_context",
		label: "Pack Wiki Context",
		description: "Pack relevant wiki pages, snippets, schema/index orientation, and optional links into bounded context.",
		promptSnippet: "Prepare curated wiki context for the current task or a subagent.",
		promptGuidelines: ["Use query/pages to keep context targeted; set maxBytes for large wikis."],
		parameters: ContextSchema,
		async execute(_toolCallId, params: WikiContextInput) {
			const result = await service.context(params);
			return { content: [{ type: "text", text: result.context }], details: result };
		},
		renderCall: (args, theme) => wikiCall("context", args.query ?? args.path, theme),
		renderResult: (result, options, theme) => wikiResult(result.details, options.expanded, theme),
	});
}

function wikiCall(action: string, target: string, theme: Theme): Text {
	return new Text(theme.fg("toolTitle", theme.bold(`wiki ${action} `)) + theme.fg("muted", target.replace(/\s+/g, " ").slice(0, 90)), 0, 0);
}

export function wikiResult(details: unknown, expanded: boolean, theme: Theme): Text {
	const value = details as Record<string, unknown> | undefined;
	if (!value) return new Text(theme.fg("dim", "Wiki operation complete"), 0, 0);
	const path = typeof value.path === "string" ? value.path : "wiki";
	const summary = value.summary as { error?: number; warning?: number; notice?: number } | undefined;
	if (summary) return new Text(`${theme.fg(summary.error ? "error" : summary.warning ? "warning" : "success", summary.error ? "issues" : "✓ clean")} ${theme.fg("accent", path)} · ${summary.error ?? 0} errors · ${summary.warning ?? 0} warnings`, 0, 0);
	const matches = value.matches as unknown[] | undefined;
	if (matches) return new Text(`${theme.fg("success", "✓")} ${theme.fg("accent", path)} · ${matches.length} match(es)`, 0, 0);
	const nodes = value.nodes as unknown[] | undefined;
	const edges = value.edges as unknown[] | undefined;
	if (nodes && edges) return new Text(`${theme.fg("success", "✓")} ${theme.fg("accent", path)} · ${nodes.length} nodes · ${edges.length} edges`, 0, 0);
	const created = value.created as string[] | undefined;
	if (created) return new Text(`${theme.fg("success", value.dryRun ? "preview" : "✓ created")} ${theme.fg("accent", path)} · ${created.length} file(s)`, 0, 0);
	if (typeof value.pageCount === "number") return new Text(`${theme.fg("success", "✓")} ${theme.fg("accent", path)} · ${value.pageCount} pages`, 0, 0);
	const included = value.pages as unknown[] | undefined;
	if (included) return new Text(`${theme.fg("success", "✓")} context from ${included.length} page(s)${expanded && typeof value.context === "string" ? `\n${value.context}` : ""}`, 0, 0);
	return new Text(`${theme.fg("success", "✓")} ${theme.fg("accent", path)}`, 0, 0);
}

export function formatInit(result: Awaited<ReturnType<WikiService["init"]>>): string {
	const action = result.dryRun ? "Would create" : "Created";
	return [`${action} wiki at ${result.path}`, ...result.created.map((path) => `- ${path}`)].join("\n");
}

export function formatStatus(result: Awaited<ReturnType<WikiService["status"]>>): string {
	const missingFiles = Object.entries(result.coreFiles).filter(([, ok]) => !ok).map(([name]) => name);
	const missingDirs = Object.entries(result.coreDirs).filter(([, ok]) => !ok).map(([name]) => `${name}/`);
	const typeCounts = Object.entries(result.pageCountsByType).map(([type, count]) => `${type}:${count}`).join(", ") || "none";
	const issues = result.issues.length ? result.issues.map((issue) => `- [${issue.severity}] ${issue.code}: ${issue.message}`).join("\n") : "- none";
	return [
		`Wiki status: ${result.path}`,
		`Pages: ${result.pageCount} (${typeCounts}); saved sources: ${result.sourceCount}`,
		`Core missing: ${[...missingFiles, ...missingDirs].join(", ") || "none"}`,
		`Graph: ${result.graph.nodes} nodes, ${result.graph.edges} edges, ${result.graph.orphans} orphans, ${result.graph.brokenLinks} broken, ${result.graph.ambiguousLinks} ambiguous`,
		`Latest log: ${result.latestLogEntry ?? "(none)"}`,
		`Top issues:\n${issues}`,
	].join("\n");
}

export function formatLint(result: Awaited<ReturnType<WikiService["lint"]>>): string {
	const lines = [`Wiki lint: ${result.path}`, `Summary: ${result.summary.error} error(s), ${result.summary.warning} warning(s), ${result.summary.notice} notice(s)`];
	if (!result.issues.length) lines.push("No issues found.");
	for (const issue of result.issues) lines.push(`- [${issue.severity}] ${issue.code}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`);
	if (result.truncated) lines.push("[lint truncated by maxIssues]");
	return lines.join("\n");
}

export function formatGraph(result: Awaited<ReturnType<WikiService["graph"]>>): string {
	const lines = [`Wiki graph: ${result.path}`, `${result.nodes.length} node(s), ${result.edges.length} edge(s), ${result.orphans.length} orphan(s), ${result.brokenLinks.length} broken, ${result.ambiguousLinks.length} ambiguous`];
	if (result.orphans.length) lines.push("", "Orphans:", ...result.orphans.slice(0, 20).map((node) => `- ${node.id}`));
	if (result.brokenLinks.length) lines.push("", "Broken links:", ...result.brokenLinks.slice(0, 20).map((link) => `- ${link.from}:${link.line} ${link.raw} -> ${link.target}`));
	if (result.ambiguousLinks.length) lines.push("", "Ambiguous links:", ...result.ambiguousLinks.slice(0, 20).map((link) => `- ${link.from}:${link.line} ${link.raw} -> ${link.candidates.join(", ")}`));
	if (result.truncated) lines.push("[graph truncated by maxNodes/maxEdges]");
	return lines.join("\n");
}

export function formatSearch(result: Awaited<ReturnType<WikiService["search"]>>): string {
	if (!result.matches.length) return `No wiki matches for: ${result.query}`;
	const lines = [`Wiki search (${result.mode}): ${result.query}`];
	for (const match of result.matches) {
		const score = match.score === undefined ? "" : ` score=${match.score.toFixed(3)}`;
		lines.push("", `${match.page.relativePath}:${match.line}${score}`, match.snippet);
	}
	if (result.truncated) lines.push("[search truncated by maxResults]");
	return lines.join("\n");
}
