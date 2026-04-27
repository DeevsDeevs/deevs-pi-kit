import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { validateBranchName, validateChainName, validateLinkName, type ChainService } from "./service.ts";
import { formatList, formatLoad, formatSearch } from "./tools.ts";

interface ChainLinkArgs {
	chain: string;
	branch?: string;
	parent?: string;
}

export function registerChainCommands(pi: ExtensionAPI, service: ChainService): void {
	pi.registerCommand("chain-link", {
		description: "Create a durable work handoff in .chains/<name>",
		getArgumentCompletions: async (prefix) => completeChains(service, prefix),
		handler: async (args, ctx) => {
			const parsed = parseLinkArgs(args);
			if (!parsed?.chain) {
				ctx.ui.notify("Usage: /chain-link <chain-name> [--branch name] [--parent link.md]", "warning");
				return;
			}
			try {
				const safe = { ...parsed, chain: validateChainName(parsed.chain), branch: parsed.branch ? validateBranchName(parsed.branch) : undefined, parent: parsed.parent ? validateLinkName(parsed.parent) : undefined };
				pi.sendUserMessage(chainLinkPrompt(safe), { deliverAs: "followUp" });
				ctx.ui.notify(`Queued chain link request for ${safe.chain}${safe.branch ? ` @ ${safe.branch}` : ""}.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("chain-load", {
		description: "Load the latest link from .chains/<name> as working context",
		getArgumentCompletions: async (prefix) => completeChains(service, prefix),
		handler: async (args, ctx) => {
			const parsed = parseLoadArgs(args);
			if (!parsed.chain) {
				ctx.ui.notify("Usage: /chain-load <chain-name> [--branch name] [link.md]", "warning");
				return;
			}
			try {
				const result = await service.load({ ...parsed, maxBytes: 196_608 });
				pi.sendUserMessage(chainLoadPrompt(result), { deliverAs: "followUp" });
				ctx.ui.notify(`Loaded ${result.link.chain}/${result.link.filename} @ ${result.link.branch} into the next turn.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("chain-list", {
		description: "List chains in .chains",
		handler: async (args, ctx) => {
			try {
				ctx.ui.notify(formatList(await service.list({ includeBranches: args.includes("--branches") || args.includes("--all") })), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("chain-fork", {
		description: "Create a forked branch from an existing chain link",
		getArgumentCompletions: async (prefix) => completeChains(service, prefix),
		handler: async (args, ctx) => {
			const parsed = parseForkArgs(args);
			if (!parsed) {
				ctx.ui.notify("Usage: /chain-fork <chain-name> <new-branch> [--from link.md] [--from-branch name]", "warning");
				return;
			}
			try {
				const fork = await service.fork(parsed);
				pi.sendUserMessage(chainForkPrompt(fork), { deliverAs: "followUp" });
				ctx.ui.notify(`Queued fork ${fork.chain}/${fork.branch} from ${fork.parent.filename}.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("chain-search", {
		description: "Search across .chains markdown links",
		getArgumentCompletions: async (prefix) => completeChains(service, prefix),
		handler: async (args, ctx) => {
			const parsed = await parseSearchArgs(service, args);
			if (!parsed.query) {
				ctx.ui.notify("Usage: /chain-search [chain-name|--chain name] [--branch name] [--regex] <query>", "warning");
				return;
			}
			try {
				ctx.ui.notify(formatSearch(await service.search(parsed)), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

async function completeChains(service: ChainService, prefix: string) {
	const chains = await service.list();
	return chains.map((chain) => chain.chain).filter((chain) => chain.startsWith(prefix)).map((value) => ({ value, label: value }));
}

function chainLinkPrompt(input: ChainLinkArgs): string {
	const chain = JSON.stringify(input.chain);
	const branch = JSON.stringify(input.branch ?? "main");
	const parent = input.parent ? `, parent=${JSON.stringify(input.parent)}` : "";
	return `Create a chain link for chain ${chain} on branch ${branch}.

Use the chain-system skill/rubric. If needed, use the detailed link rubric from skills/chain-system/link-rubric.md. Summarize the current work as markdown with these sections:
1. Primary Request and Intent
2. Key Technical Concepts
3. Work Completed
4. Decisions and Rationale
5. Files and Code Changes
6. Unresolved Issues and Blockers
7. Pending Tasks
8. Current Work
9. Next Step

Be concise but preserve enough technical context to resume later. Include relevant subagent IDs/results and background process state if important. Then call chain_save with chain=${chain}, branch=${branch}${parent}, and the markdown content. Do not write to .chains directly; use chain_save.`;
}

function chainLoadPrompt(result: Awaited<ReturnType<ChainService["load"]>>): string {
	const warning = result.link.stale ? `\nWarning: this link is ${result.link.ageDays} days old; verify stale assumptions before acting.` : "";
	return `Load this chain context and continue from it.

Chain: ${result.link.chain}
Branch: ${result.link.branch}
Link: ${result.link.filename}${warning}
Parent: ${result.link.parent ?? "(none)"}
Title: ${result.link.title}
Next step: ${result.link.nextStep ?? "(not found)"}

Use the saved chain content below as working context. If the next step is ambiguous or the link references missing/stale context, ask clarifying questions before proceeding.

${formatLoad(result)}`;
}

function chainForkPrompt(fork: Awaited<ReturnType<ChainService["fork"]>>): string {
	return `Create the first link on forked chain branch.

Chain: ${fork.chain}
New branch: ${fork.branch}
Parent link: ${fork.parent.filename}
Parent title: ${fork.parent.title}
Parent next step: ${fork.parent.nextStep ?? "(not found)"}

Summarize the fork intent and current context needed for this branch. Then call chain_save with chain=${JSON.stringify(fork.chain)}, branch=${JSON.stringify(fork.branch)}, parent=${JSON.stringify(fork.parent.filename)}. If this fork is for subagents, keep the link focused enough to paste or load into subagent tasks.`;
}

function parseLinkArgs(args: string): ChainLinkArgs | null {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const chain = parts.shift();
	if (!chain) return null;
	const parsed: ChainLinkArgs = { chain };
	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === "--branch") parsed.branch = parts[++i];
		else if (parts[i] === "--parent") parsed.parent = parts[++i];
	}
	return parsed;
}

function parseLoadArgs(args: string): { chain: string; branch?: string; link?: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const chain = parts.shift() ?? "";
	const parsed: { chain: string; branch?: string; link?: string } = { chain };
	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === "--branch") parsed.branch = parts[++i];
		else if (!parsed.link) parsed.link = parts[i];
	}
	return parsed;
}

function parseForkArgs(args: string): { chain: string; branch: string; from?: string; fromBranch?: string } | null {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const chain = parts.shift();
	const branch = parts.shift();
	if (!chain || !branch) return null;
	const parsed: { chain: string; branch: string; from?: string; fromBranch?: string } = { chain, branch };
	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === "--from") parsed.from = parts[++i];
		else if (parts[i] === "--from-branch") parsed.fromBranch = parts[++i];
	}
	return parsed;
}

async function parseSearchArgs(service: ChainService, args: string): Promise<{ chain?: string; branch?: string; query: string; regex?: boolean }> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { query: "" };
	let chain: string | undefined;
	let branch: string | undefined;
	const regex = parts.includes("--regex");
	for (let index = parts.length - 1; index >= 0; index--) if (parts[index] === "--regex") parts.splice(index, 1);
	const chainFlag = parts.indexOf("--chain");
	if (chainFlag >= 0) {
		chain = parts[chainFlag + 1];
		parts.splice(chainFlag, 2);
	}
	const branchFlag = parts.indexOf("--branch");
	if (branchFlag >= 0) {
		branch = parts[branchFlag + 1];
		parts.splice(branchFlag, 2);
	}
	if (parts.length === 0) return { chain, branch, query: "", regex };
	if (chain) return { chain, branch, query: parts.join(" "), regex };
	if (parts.length === 1) return { branch, query: parts[0]!, regex };
	const chains = new Set((await service.list()).map((item) => item.chain));
	return chains.has(parts[0]!) ? { chain: parts[0], branch, query: parts.slice(1).join(" "), regex } : { branch, query: parts.join(" "), regex };
}
