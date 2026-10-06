// Chains MCP server for Claude Code and Codex: the same six tools and storage as the Pi extension, over stdio JSON-RPC.
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ChainService } from "../lib/chains/service.ts";
import { formatList, formatLoad, formatRankedSearch, formatSearch } from "../lib/chains/format.ts";

const PROTOCOL_VERSION = "2025-06-18";
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const bool = (description) => ({ type: "boolean", description });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const TOOLS = [
	{
		name: "chain_save",
		description: "Save a markdown chain link under .chains/<chain>. Include the current request, decisions, files changed/read, blockers, pending tasks and next step. Supports branches via branch and parent metadata.",
		inputSchema: object({
			chain: str("Chain name; stored under .chains/<chain>"),
			content: str("Markdown chain link content to save"),
			title: str("Readable title; defaults to first markdown heading"),
			nextStep: str("Structured next action; prose headings are never parsed for control"),
			slug: str("Filename slug; defaults to title slug"),
			branch: str("Branch name; defaults to main"),
			parent: str("Parent link filename; defaults to latest link on branch"),
		}, ["chain", "content"]),
		run: async (service, args) => `Saved chain link: ${(await service.save(args)).link.path}`,
	},
	{
		name: "chain_load",
		description: "Load the latest or selected chain link from .chains for multi-session continuation.",
		inputSchema: object({
			chain: str("Chain name"),
			branch: str("Branch name; defaults to main unless link is set"),
			link: str("Specific link filename; defaults to latest"),
			maxBytes: num("Maximum content bytes to return"),
		}, ["chain"]),
		run: async (service, args) => formatLoad(await service.load(args)),
	},
	{
		name: "chain_list",
		description: "List available .chains with link counts and latest link metadata.",
		inputSchema: object({
			includeLinks: bool("Include all link metadata, not only latest"),
			includeBranches: bool("Include branch summaries"),
		}),
		run: async (service, args) => formatList(await service.list(args)),
	},
	{
		name: "chain_fork",
		description: "Resolve a parent link for a new chain branch. Follow by saving the first branch link with chain_save using branch and parent.",
		inputSchema: object({
			chain: str("Chain name"),
			branch: str("New branch name"),
			from: str("Parent link filename; defaults to latest link"),
			fromBranch: str("Parent branch when from is omitted"),
		}, ["chain", "branch"]),
		run: async (service, args) => {
			const result = await service.fork(args);
			return `Fork ${result.chain}/${result.branch} from ${result.parent.filename}\n${result.prompt}`;
		},
	},
	{
		name: "chain_context",
		description: "Load and pack chain links into bounded context for subagent tasks or handoffs.",
		inputSchema: object({
			chain: str("Chain name"),
			branch: str("Branch name"),
			link: str("Specific link filename; defaults to latest"),
			maxBytes: num("Maximum context bytes to include"),
			mode: str("latest for one link, pack for compact parent/recent/search context"),
			includeParents: num("Parent links to include in pack mode"),
			recentLinks: num("Recent sibling links to summarize in pack mode"),
			searchQuery: str("Optional query to include matching/relevant snippets in pack mode"),
			searchMode: str("lookup for ranked results, text for exact text, regex for regex; default lookup"),
			maxSearchMatches: num("Maximum search matches to include in pack mode"),
			compact: bool("Use compact section extraction for included links"),
		}, ["chain"]),
		run: async (service, args) => (await service.context(args)).context,
	},
	{
		name: "chain_search",
		description: "Universal chain search: ranked lookup by default, exact text with mode=text, regex with mode=regex.",
		inputSchema: object({
			query: str("Search query"),
			chain: str("Restrict search to one chain"),
			branch: str("Restrict search to one branch"),
			maxResults: num("Maximum matches to return"),
			contextLines: num("Snippet context lines for text/regex mode"),
			mode: str("lookup for ranked BM25-style results, text for exact text, regex for regex; default lookup"),
			caseSensitive: bool("Case-sensitive text/regex search"),
			recencyHalfLifeDays: num("Lookup recency decay half-life in days; default 30"),
			recencyWeight: num("Lookup recency blend from 0 to 1; default 0.15"),
		}, ["query"]),
		run: async (service, args) => (args.mode ?? "lookup") === "lookup"
			? formatRankedSearch(await service.rankedSearch(args))
			: formatSearch(await service.search(args)),
	},
];

/** Claude Code starts plugin servers in the session's project and exports CLAUDE_PROJECT_DIR; Codex starts them in the session cwd. */
function projectDir() {
	return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

async function handle(request, service) {
	const reply = (result) => ({ jsonrpc: "2.0", id: request.id, result });
	const fail = (code, message) => ({ jsonrpc: "2.0", id: request.id, error: { code, message } });
	if (request.id === undefined) return undefined;
	switch (request.method) {
		case "initialize":
			return reply({ protocolVersion: request.params?.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "chains", version: "1.0.0" } });
		case "ping":
			return reply({});
		case "tools/list":
			return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
		case "tools/call": {
			const tool = TOOLS.find((candidate) => candidate.name === request.params?.name);
			if (!tool) return fail(-32602, `Unknown tool ${request.params?.name}`);
			try {
				return reply({ content: [{ type: "text", text: await tool.run(service, request.params.arguments ?? {}) }] });
			} catch (error) {
				return reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
			}
		}
		default:
			return fail(-32601, `Method not found: ${request.method}`);
	}
}

if (realpathSync(process.argv[1] ?? ".") === fileURLToPath(import.meta.url)) {
	const service = new ChainService(projectDir());
	for await (const line of createInterface({ input: process.stdin })) {
		if (!line.trim()) continue;
		let request;
		try { request = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`); continue; }
		const response = await handle(request, service);
		if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
	}
}
