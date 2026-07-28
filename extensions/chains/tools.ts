import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { ChainService } from "./service.ts";
import type { ChainContextInput, ChainForkInput, ChainListInput, ChainLoadInput, ChainSaveInput, ChainSearchInput, ChainSearchResult } from "./types.ts";

const SaveSchema = Type.Object({
	chain: Type.String({ description: "Chain name; stored under .chains/<chain>" }),
	content: Type.String({ description: "Markdown chain link content to save" }),
	title: Type.Optional(Type.String({ description: "Readable title; defaults to first markdown heading" })),
	nextStep: Type.Optional(Type.String({ description: "Structured next action; prose headings are never parsed for control" })),
	slug: Type.Optional(Type.String({ description: "Filename slug; defaults to title slug" })),
	branch: Type.Optional(Type.String({ description: "Branch name; defaults to main" })),
	parent: Type.Optional(Type.String({ description: "Parent link filename; defaults to latest link on branch" })),
});

const LoadSchema = Type.Object({
	chain: Type.String({ description: "Chain name" }),
	branch: Type.Optional(Type.String({ description: "Branch name; defaults to main unless link is set" })),
	link: Type.Optional(Type.String({ description: "Specific link filename; defaults to latest" })),
	maxBytes: Type.Optional(Type.Number({ description: "Maximum content bytes to return" })),
});

const ListSchema = Type.Object({
	includeLinks: Type.Optional(Type.Boolean({ description: "Include all link metadata, not only latest" })),
	includeBranches: Type.Optional(Type.Boolean({ description: "Include branch summaries" })),
});

const ForkSchema = Type.Object({
	chain: Type.String({ description: "Chain name" }),
	branch: Type.String({ description: "New branch name" }),
	from: Type.Optional(Type.String({ description: "Parent link filename; defaults to latest link" })),
	fromBranch: Type.Optional(Type.String({ description: "Parent branch when from is omitted" })),
});

const ContextSchema = Type.Object({
	chain: Type.String({ description: "Chain name" }),
	branch: Type.Optional(Type.String({ description: "Branch name" })),
	link: Type.Optional(Type.String({ description: "Specific link filename; defaults to latest" })),
	maxBytes: Type.Optional(Type.Number({ description: "Maximum context bytes to include" })),
	mode: Type.Optional(Type.String({ description: "latest for one link, pack for compact parent/recent/search context" })),
	includeParents: Type.Optional(Type.Number({ description: "Parent links to include in pack mode" })),
	recentLinks: Type.Optional(Type.Number({ description: "Recent sibling links to summarize in pack mode" })),
	searchQuery: Type.Optional(Type.String({ description: "Optional query to include matching/relevant snippets in pack mode" })),
	searchMode: Type.Optional(Type.String({ description: "lookup for ranked results, text for exact text, regex for regex; default lookup" })),
	maxSearchMatches: Type.Optional(Type.Number({ description: "Maximum search matches to include in pack mode" })),
	compact: Type.Optional(Type.Boolean({ description: "Use compact section extraction for included links" })),
});

const SearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	chain: Type.Optional(Type.String({ description: "Restrict search to one chain" })),
	branch: Type.Optional(Type.String({ description: "Restrict search to one branch" })),
	maxResults: Type.Optional(Type.Number({ description: "Maximum matches to return" })),
	contextLines: Type.Optional(Type.Number({ description: "Snippet context lines for text/regex mode" })),
	mode: Type.Optional(Type.String({ description: "lookup for ranked BM25-style results, text for exact text, regex for regex; default lookup" })),
	caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive text/regex search" })),
	recencyHalfLifeDays: Type.Optional(Type.Number({ description: "Lookup recency decay half-life in days; default 30" })),
	recencyWeight: Type.Optional(Type.Number({ description: "Lookup recency blend from 0 to 1; default 0.15" })),
});

export function registerChainTools(pi: ExtensionAPI, service: ChainService): void {
	pi.registerTool({
		name: "chain_save",
		label: "Save Chain Link",
		description: "Save a markdown chain link under .chains/<chain>. Supports branches via branch and parent metadata.",
		promptSnippet: "Save durable multi-session work context to .chains.",
		promptGuidelines: [
			"Use chain_save only after drafting a concise but complete chain link summary.",
			"Include current request, decisions, files changed/read, blockers, pending tasks, and next step.",
			"Use branch/parent when preserving a forked line of work or passing focused context to subagents.",
		],
		parameters: SaveSchema,
		async execute(_toolCallId, params: ChainSaveInput) {
			const result = await service.save(params);
			return { content: [{ type: "text", text: `Saved chain link: ${result.link.path}` }], details: result };
		},
		renderCall: (args: ChainSaveInput, theme: Theme) => chainCall("save", `${args.chain}@${args.branch ?? "main"}`, theme),
		renderResult: (result, options, theme) => chainResult(result.details, options.expanded, theme),
	});

	pi.registerTool({
		name: "chain_load",
		label: "Load Chain Link",
		description: "Load the latest or selected chain link from .chains for multi-session continuation.",
		promptSnippet: "Load durable chain context from .chains.",
		promptGuidelines: ["Use chain_load when resuming prior work from a named chain or branch."],
		parameters: LoadSchema,
		async execute(_toolCallId, params: ChainLoadInput) {
			const result = await service.load(params);
			return { content: [{ type: "text", text: formatLoad(result) }], details: result };
		},
		renderCall: (args: ChainLoadInput, theme: Theme) => chainCall("load", `${args.chain}@${args.branch ?? "main"}`, theme),
		renderResult: (result, options, theme) => chainResult(result.details, options.expanded, theme),
	});

	pi.registerTool({
		name: "chain_list",
		label: "List Chains",
		description: "List available .chains with link counts and latest link metadata.",
		promptSnippet: "List durable work chains.",
		parameters: ListSchema,
		async execute(_toolCallId, params: ChainListInput) {
			const chains = await service.list(params);
			return { content: [{ type: "text", text: formatList(chains) }], details: { chains } };
		},
		renderCall: (_args: ChainListInput, theme: Theme) => chainCall("list", "", theme),
		renderResult: (result, options, theme) => chainResult(result.details, options.expanded, theme),
	});

	pi.registerTool({
		name: "chain_fork",
		label: "Fork Chain Branch",
		description: "Resolve a parent link for a new chain branch. Follow by saving the first branch link with chain_save using branch and parent.",
		promptSnippet: "Prepare a forked chain branch from an existing link.",
		promptGuidelines: ["Use chain_fork before creating a divergent branch or a focused subagent context branch."],
		parameters: ForkSchema,
		async execute(_toolCallId, params: ChainForkInput) {
			const result = await service.fork(params);
			return { content: [{ type: "text", text: `Fork ${result.chain}/${result.branch} from ${result.parent.filename}\n${result.prompt}` }], details: result };
		},
		renderCall: (args: ChainForkInput, theme: Theme) => chainCall("fork", `${args.chain}@${args.branch}`, theme),
		renderResult: (result, options, theme) => chainResult(result.details, options.expanded, theme),
	});

	pi.registerTool({
		name: "chain_context",
		label: "Format Chain Context",
		description: "Load and pack chain links into bounded context for subagent tasks or handoffs.",
		promptSnippet: "Format chain context for passing to subagents.",
		promptGuidelines: ["Use chain_context before subagent when a delegate needs focused Chain context."],
		parameters: ContextSchema,
		async execute(_toolCallId, params: ChainContextInput) {
			const result = await service.context(params);
			return { content: [{ type: "text", text: result.context }], details: result };
		},
		renderCall: (args, theme) => chainCall("context", `${args.chain}@${args.branch ?? "main"}`, theme),
		renderResult: (result, options, theme) => chainResult(result.details, options.expanded, theme),
	});

	pi.registerTool({
		name: "chain_search",
		label: "Search Chains",
		description: "Universal chain search: ranked lookup by default, exact text with mode=text, regex with mode=regex.",
		promptSnippet: "Search durable work chains by relevance, exact text, or regex.",
		promptGuidelines: ["Use default lookup mode for ideas/topics; use mode=text or mode=regex for exact matching."],
		parameters: SearchSchema,
		renderCall: (args, theme) => chainCall("search", args.query, theme),
		renderResult: (result, options, theme) => chainResult(result.details, options.expanded, theme),
		async execute(_toolCallId, params: ChainSearchInput): Promise<AgentToolResult<ChainSearchResult | Awaited<ReturnType<ChainService["rankedSearch"]>>>> {
			const mode = params.mode ?? "lookup";
			if (mode === "lookup") {
				const result = await service.rankedSearch(params);
				return { content: [{ type: "text", text: formatRankedSearch(result) }], details: result };
			}
			const result = await service.search(params);
			return { content: [{ type: "text", text: formatSearch(result) }], details: result };
		},
	});
}

function chainCall(action: string, target: string, theme: Theme): Text {
	return new Text(theme.fg("toolTitle", theme.bold(`chain ${action} `)) + theme.fg("muted", target), 0, 0);
}

function chainResult(details: unknown, expanded: boolean, theme: Theme): Text {
	const value = details as Record<string, unknown> | undefined;
	const link = value?.link as { chain?: string; branch?: string; filename?: string; title?: string } | undefined;
	if (link) {
		let text = `${theme.fg("success", "✓")} ${theme.fg("accent", `${link.chain ?? "chain"}@${link.branch ?? "main"}`)} ${theme.fg("muted", link.filename ?? "")}`;
		if (expanded && link.title) text += `\n${link.title}`;
		return new Text(text, 0, 0);
	}
	const chains = value?.chains as Array<{ chain: string; count: number }> | undefined;
	if (chains) {
		const visible = expanded ? chains : chains.slice(0, 5);
		return new Text(visible.length ? visible.map((chain) => `${theme.fg("accent", chain.chain)} ${theme.fg("muted", `${chain.count} link(s)`)}`).join("\n") : theme.fg("dim", "No chains"), 0, 0);
	}
	const matches = value?.matches as unknown[] | undefined;
	if (matches) return new Text(`${theme.fg("success", "✓")} ${matches.length} match(es)`, 0, 0);
	const included = value?.includedLinks as unknown[] | undefined;
	if (included) return new Text(`${theme.fg("success", "✓")} context packed from ${included.length} link(s)`, 0, 0);
	if (typeof value?.chain === "string" && typeof value.branch === "string") return new Text(`${theme.fg("success", "✓")} ${theme.fg("accent", `${value.chain}@${value.branch}`)}`, 0, 0);
	return new Text(theme.fg("dim", "Chain operation complete"), 0, 0);
}

export function formatList(chains: Awaited<ReturnType<ChainService["list"]>>): string {
	if (chains.length === 0) return "No chains found in .chains. Use /chain-link <name> to create one.";
	return chains.map((chain) => {
		const latest = chain.latest ? `${chain.latest.filename} @ ${chain.latest.branch}${chain.latest.stale ? " (stale)" : ""}` : "none";
		const branches = chain.branches?.length ? `\n  branches: ${chain.branches.map((branch) => `${branch.branch}(${branch.count})`).join(", ")}` : "";
		return `${chain.chain} — ${chain.count} link(s), latest: ${latest}${branches}`;
	}).join("\n");
}

export function formatLoad(result: Awaited<ReturnType<ChainService["load"]>>): string {
	const warning = result.link.stale ? `\n[stale: ${result.link.ageDays} days old]` : "";
	const recent = result.recent.map((link) => `- ${link.filename} @ ${link.branch}`).join("\n");
	return [
		`Loaded ${result.link.chain}/${result.link.filename} @ ${result.link.branch}${warning}`,
		`Title: ${result.link.title}`,
		`Parent: ${result.link.parent ?? "(none)"}`,
		`Next step: ${result.link.nextStep ?? "(not found)"}`,
		`Recent:\n${recent}`,
		"Content:",
		result.content,
	].join("\n\n");
}

export function formatSearch(result: Awaited<ReturnType<ChainService["search"]>>): string {
	if (result.matches.length === 0) return `No chain matches for: ${result.query}`;
	const mode = result.regex ? "regex" : "text";
	const lines = result.matches.map((match) => [`${match.link.chain}/${match.link.filename}@${match.link.branch}:${match.line}`, match.snippet].join("\n"));
	if (result.truncated) lines.push("[search truncated by maxResults]");
	return [`Search (${mode}): ${result.query}`, ...lines].join("\n\n");
}

export function formatRankedSearch(result: Awaited<ReturnType<ChainService["rankedSearch"]>>): string {
	if (result.matches.length === 0) return `No relevant chain links for: ${result.query}`;
	const lines = result.matches.map((match, index) => [
		`${index + 1}. ${match.link.chain}/${match.link.filename}@${match.link.branch} score=${match.score.toFixed(3)} lexical=${match.lexicalScore.toFixed(3)} recency=${match.recencyScore.toFixed(3)}`,
		`Title: ${match.link.title}`,
		match.link.nextStep ? `Next: ${match.link.nextStep}` : "",
		`Terms: ${match.matchedTerms.join(", ")}`,
		match.snippet,
	].filter(Boolean).join("\n"));
	if (result.truncated) lines.push("[lookup truncated by maxResults]");
	return [`Lookup: ${result.query}`, ...lines].join("\n\n");
}

export function formatContext(result: Awaited<ReturnType<ChainService["load"]>>): string {
	return `# Chain Context: ${result.link.chain}@${result.link.branch}/${result.link.filename}

Parent: ${result.link.parent ?? "(none)"}
Title: ${result.link.title}
Next step: ${result.link.nextStep ?? "(not found)"}

${result.content}`;
}
