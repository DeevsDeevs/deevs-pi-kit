import { formatList, formatLoad, formatRankedSearch, formatSearch } from "./format.ts";
import type { ChainService } from "./service.ts";
import type { Static } from "typebox";

const str = (description: string) => ({ type: "string", description }) as const;
const num = (description: string) => ({ type: "number", description }) as const;
const bool = (description: string) => ({ type: "boolean", description }) as const;
const oneOf = <const T extends readonly string[]>(values: T, description: string) => ({ type: "string", enum: values, description }) as const;

/** The one chain tool, as plain JSON Schema: Pi validates it, and the Claude Code / Codex MCP server serves it unchanged. */
export const CHAIN_TOOL = {
	name: "chain",
	description: "Markdown handoffs under .chains/<chain>: save a link, load the latest, list, fork a branch, pack context for a delegate, or search.",
	inputSchema: {
		type: "object",
		properties: {
			action: oneOf(["save", "load", "list", "fork", "context", "search"], "save | load | list | fork | context | search"),
			chain: str("Chain name; required except for list and search"),
			branch: str("Branch, default main; for fork the new branch"),
			content: str("save: markdown link with request, decisions, files, blockers, pending tasks and next step"),
			title: str("save: title, default first heading"),
			nextStep: str("save: the next action"),
			slug: str("save: filename slug, default from title"),
			parent: str("save: parent link filename, default latest on branch"),
			link: str("load/context: link filename, default latest"),
			maxBytes: num("load/context: byte budget"),
			from: str("fork: parent link filename, default latest"),
			fromBranch: str("fork: parent branch when from is omitted"),
			includeLinks: bool("list: every link, not only the latest"),
			includeBranches: bool("list: branch summaries"),
			mode: oneOf(["pack", "latest"], "context: pack (default) adds parents, recent links and query hits; latest is one full link"),
			compact: bool("context: keep only edge sections of packed links, default true in pack mode"),
			includeParents: num("context: parent links to pack, default 2"),
			recentLinks: num("context: recent links to list, default 3"),
			query: str("search: the query; context: hits to pack"),
			searchMode: oneOf(["lookup", "text", "regex"], "lookup (ranked, default), text or regex"),
			maxResults: num("search/context: maximum hits"),
			contextLines: num("search text/regex: snippet lines"),
			caseSensitive: bool("search text/regex: case-sensitive"),
		},
		required: ["action"],
		additionalProperties: false,
	},
} as const;

export type ChainArgs = Static<typeof CHAIN_TOOL.inputSchema>;
type ChainAction = ChainArgs["action"];

const REQUIRED = { save: ["chain", "content"], load: ["chain"], list: [], fork: ["chain", "branch"], context: ["chain"], search: ["query"] } satisfies Record<ChainAction, Array<keyof ChainArgs>>;

/** Runs one call; checks the enums itself because MCP clients need not validate against the schema. */
export async function runChain(service: ChainService, args: ChainArgs): Promise<{ text: string; details: object }> {
	for (const key of ["action", "mode", "searchMode"] as const) {
		const allowed: readonly string[] = CHAIN_TOOL.inputSchema.properties[key].enum;
		const value = args[key];
		if ((value !== undefined || key === "action") && !allowed.some((known) => known === value)) throw new Error(`${key} must be one of ${allowed.join(", ")}.`);
	}
	const required: Array<keyof ChainArgs> = REQUIRED[args.action];
	const missing = required.filter((key) => args[key] === undefined);
	if (missing.length) throw new Error(`chain ${args.action} needs ${missing.join(" and ")}.`);
	const chain = args.chain ?? "";
	switch (args.action) {
		case "save": {
			const result = await service.save({ ...args, chain, content: args.content ?? "" });
			return { text: `Saved chain link: ${result.link.path}`, details: result };
		}
		case "load": {
			const result = await service.load({ ...args, chain });
			return { text: formatLoad(result), details: result };
		}
		case "list": {
			const chains = await service.list(args);
			return { text: formatList(chains), details: { chains } };
		}
		case "fork": {
			const result = await service.fork({ ...args, chain, branch: args.branch ?? "" });
			return { text: `Fork ${result.chain}/${result.branch} from ${result.parent.filename}\n${result.prompt}`, details: result };
		}
		case "context": {
			const result = await service.context({ ...args, chain });
			return { text: result.context, details: result };
		}
		case "search": {
			const input = { ...args, query: args.query ?? "" };
			if ((args.searchMode ?? "lookup") === "lookup") {
				const result = await service.rankedSearch(input);
				return { text: formatRankedSearch(result), details: result };
			}
			const result = await service.search(input);
			return { text: formatSearch(result), details: result };
		}
	}
}
