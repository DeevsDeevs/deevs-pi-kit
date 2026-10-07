import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { WikiService } from "./service.ts";
import type { WikiContextResult, WikiGraphResult, WikiInitResult, WikiLintResult, WikiSearchResult, WikiStatusResult } from "./types.ts";

const WikiSchema = Type.Object({
	action: StringEnum(["init", "status", "lint", "graph", "search", "context"] as const),
	path: Type.String({ description: "Wiki root, relative to the project" }),
	domain: Type.Optional(Type.String({ description: "init: what the wiki covers" })),
	title: Type.Optional(Type.String({ description: "init: index title" })),
	dryRun: Type.Optional(Type.Boolean({ description: "init: list files without writing" })),
	maxIssues: Type.Optional(Type.Number({ description: "status/lint" })),
	includeWarnings: Type.Optional(Type.Boolean({ description: "lint: default true" })),
	includeOrphans: Type.Optional(Type.Boolean({ description: "graph" })),
	includeBacklinks: Type.Optional(Type.Boolean({ description: "graph/context" })),
	includeForwardLinks: Type.Optional(Type.Boolean({ description: "context" })),
	maxNodes: Type.Optional(Type.Number({ description: "graph" })),
	maxEdges: Type.Optional(Type.Number({ description: "graph" })),
	query: Type.Optional(Type.String({ description: "search; context: pages to pack" })),
	searchMode: Type.Optional(StringEnum(["lookup", "text", "regex"] as const, { description: "search/context, default lookup" })),
	maxResults: Type.Optional(Type.Number({ description: "search" })),
	contextLines: Type.Optional(Type.Number({ description: "search text/regex" })),
	caseSensitive: Type.Optional(Type.Boolean({ description: "search text/regex" })),
	pages: Type.Optional(Type.Array(Type.String(), { description: "context: page ids or paths" })),
	maxPages: Type.Optional(Type.Number({ description: "context" })),
	maxBytes: Type.Optional(Type.Number({ description: "context" })),
	compact: Type.Optional(Type.Boolean({ description: "context: excerpts, default true" })),
});

type WikiArgs = Static<typeof WikiSchema>;
export type WikiDetails = WikiInitResult | WikiStatusResult | WikiLintResult | WikiGraphResult | WikiSearchResult | WikiContextResult;

export function registerWikiTools(pi: ExtensionAPI, service: WikiService): void {
	pi.registerTool({
		name: "wiki",
		label: "Wiki",
		description: "Curated markdown wiki: init a layout, status, lint, link graph, search pages, or pack context. Load the wiki skill first.",
		parameters: WikiSchema,
		defaultActive: false,
		execute: async (_toolCallId, params) => runWiki(service, params),
		renderCall: (args, theme) => wikiCall(args.action ?? "", args.query ?? args.path ?? "", theme),
		renderResult: (result, options, theme) => wikiResult(result.details, options.expanded, theme),
	});
}

async function runWiki(service: WikiService, args: WikiArgs): Promise<AgentToolResult<WikiDetails>> {
	const reply = <T extends WikiDetails>(details: T, text: string) => ({ content: [{ type: "text" as const, text }], details });
	switch (args.action) {
		case "init": {
			if (!args.domain) throw new Error("wiki init needs domain.");
			const result = await service.init({ ...args, domain: args.domain });
			return reply(result, formatInit(result));
		}
		case "status": {
			const result = await service.status(args);
			return reply(result, formatStatus(result));
		}
		case "lint": {
			const result = await service.lint(args);
			return reply(result, formatLint(result));
		}
		case "graph": {
			const result = await service.graph(args);
			return reply(result, formatGraph(result));
		}
		case "search": {
			if (!args.query) throw new Error("wiki search needs query.");
			const result = await service.search({ ...args, query: args.query, mode: args.searchMode });
			return reply(result, formatSearch(result));
		}
		case "context": {
			const result = await service.context(args);
			return reply(result, result.context);
		}
	}
}

function wikiCall(action: string, target: string, theme: Theme): Text {
	return new Text(theme.fg("toolTitle", theme.bold(`wiki ${action} `)) + theme.fg("muted", target.replace(/\s+/g, " ").slice(0, 90)), 0, 0);
}

export function wikiResult(details: WikiDetails | undefined, expanded: boolean, theme: Theme): Text {
	if (!details) return new Text(theme.fg("dim", "Wiki operation complete"), 0, 0);
	const done = (text: string) => new Text(`${theme.fg("success", "✓")} ${text}`, 0, 0);
	const path = theme.fg("accent", details.path);
	if ("summary" in details) {
		const { error, warning } = details.summary;
		return new Text(`${theme.fg(error ? "error" : warning ? "warning" : "success", error ? "issues" : "✓ clean")} ${path} · ${error} errors · ${warning} warnings`, 0, 0);
	}
	if ("matches" in details) return done(`${path} · ${details.matches.length} match(es)`);
	if ("edges" in details) return done(`${path} · ${details.nodes.length} nodes · ${details.edges.length} edges`);
	if ("created" in details) return new Text(`${theme.fg("success", details.dryRun ? "preview" : "✓ created")} ${path} · ${details.created.length} file(s)`, 0, 0);
	if ("pageCount" in details) return done(`${path} · ${details.pageCount} pages`);
	return done(`context from ${details.pages.length} page(s)${expanded ? `\n${details.context}` : ""}`);
}

function formatInit(result: WikiInitResult): string {
	const action = result.dryRun ? "Would create" : "Created";
	return [`${action} wiki at ${result.path}`, ...result.created.map((path) => `- ${path}`)].join("\n");
}

function formatStatus(result: WikiStatusResult): string {
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

function formatLint(result: WikiLintResult): string {
	const lines = [`Wiki lint: ${result.path}`, `Summary: ${result.summary.error} error(s), ${result.summary.warning} warning(s), ${result.summary.notice} notice(s)`];
	if (!result.issues.length) lines.push("No issues found.");
	for (const issue of result.issues) lines.push(`- [${issue.severity}] ${issue.code}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`);
	if (result.truncated) lines.push("[lint truncated by maxIssues]");
	return lines.join("\n");
}

function formatGraph(result: WikiGraphResult): string {
	const lines = [`Wiki graph: ${result.path}`, `${result.nodes.length} node(s), ${result.edges.length} edge(s), ${result.orphans.length} orphan(s), ${result.brokenLinks.length} broken, ${result.ambiguousLinks.length} ambiguous`];
	if (result.orphans.length) lines.push("", "Orphans:", ...result.orphans.slice(0, 20).map((node) => `- ${node.id}`));
	if (result.brokenLinks.length) lines.push("", "Broken links:", ...result.brokenLinks.slice(0, 20).map((link) => `- ${link.from}:${link.line} ${link.raw} -> ${link.target}`));
	if (result.ambiguousLinks.length) lines.push("", "Ambiguous links:", ...result.ambiguousLinks.slice(0, 20).map((link) => `- ${link.from}:${link.line} ${link.raw} -> ${link.candidates.join(", ")}`));
	if (result.truncated) lines.push("[graph truncated by maxNodes/maxEdges]");
	return lines.join("\n");
}

function formatSearch(result: WikiSearchResult): string {
	if (!result.matches.length) return `No wiki matches for: ${result.query}`;
	const lines = [`Wiki search (${result.mode}): ${result.query}`];
	for (const match of result.matches) {
		const score = match.score === undefined ? "" : ` score=${match.score.toFixed(3)}`;
		lines.push("", `${match.page.relativePath}:${match.line}${score}`, match.snippet);
	}
	if (result.truncated) lines.push("[search truncated by maxResults]");
	return lines.join("\n");
}
