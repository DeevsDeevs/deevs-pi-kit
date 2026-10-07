import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { ChainService } from "./service.ts";
import { CHAIN_TOOL, runChain, type ChainArgs } from "./tool.ts";

export function registerChainTools(pi: ExtensionAPI, service: ChainService): void {
	pi.registerTool({
		name: CHAIN_TOOL.name,
		label: "Chain",
		description: CHAIN_TOOL.description,
		promptSnippet: "Save, load, search and fork durable .chains handoffs.",
		parameters: CHAIN_TOOL.inputSchema,
		defaultActive: false,
		async execute(_toolCallId, params: ChainArgs) {
			const { text, details } = await runChain(service, params);
			return { content: [{ type: "text", text }], details };
		},
		renderCall: (args: ChainArgs, theme: Theme) => chainCall(args.action ?? "", args.action === "search" ? args.query ?? "" : args.action === "list" ? "" : `${args.chain}@${args.branch ?? "main"}`, theme),
		renderResult: (result, options, theme) => chainResult(result.details, options.expanded, theme),
	});
}

function chainCall(action: string, target: string, theme: Theme): Text {
	return new Text(theme.fg("toolTitle", theme.bold(`chain ${action} `)) + theme.fg("muted", target), 0, 0);
}

interface ChainResultDetails {
	link?: { chain?: string; branch?: string; filename?: string; title?: string };
	chains?: Array<{ chain: string; count: number }>;
	matches?: unknown[];
	includedLinks?: unknown[];
	chain?: string;
	branch?: string;
}

function chainResult(value: ChainResultDetails | undefined, expanded: boolean, theme: Theme): Text {
	const link = value?.link;
	if (link) {
		let text = `${theme.fg("success", "✓")} ${theme.fg("accent", `${link.chain ?? "chain"}@${link.branch ?? "main"}`)} ${theme.fg("muted", link.filename ?? "")}`;
		if (expanded && link.title) text += `\n${link.title}`;
		return new Text(text, 0, 0);
	}
	const chains = value?.chains;
	if (chains) {
		const visible = expanded ? chains : chains.slice(0, 5);
		return new Text(visible.length ? visible.map((chain) => `${theme.fg("accent", chain.chain)} ${theme.fg("muted", `${chain.count} link(s)`)}`).join("\n") : theme.fg("dim", "No chains"), 0, 0);
	}
	const matches = value?.matches;
	if (matches) return new Text(`${theme.fg("success", "✓")} ${matches.length} match(es)`, 0, 0);
	const included = value?.includedLinks;
	if (included) return new Text(`${theme.fg("success", "✓")} context packed from ${included.length} link(s)`, 0, 0);
	if (value?.chain && value.branch) return new Text(`${theme.fg("success", "✓")} ${theme.fg("accent", `${value.chain}@${value.branch}`)}`, 0, 0);
	return new Text(theme.fg("dim", "Chain operation complete"), 0, 0);
}
