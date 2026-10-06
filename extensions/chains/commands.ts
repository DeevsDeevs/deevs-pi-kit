import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showTextViewer } from "../shared/text-viewer.ts";
import type { ChainService } from "./service.ts";
import type { ChainLoadResult } from "./types.ts";
import { formatList, formatLoad, formatRankedSearch } from "./format.ts";
import { checkpointLabel, type ChainCheckpointService } from "./checkpoint.ts";
import { FULL_SCREEN_OVERLAY } from "../shared/dashboard.ts";
import { ChainsDashboard } from "./ui.ts";

export function registerChainCommands(pi: ExtensionAPI, service: ChainService, checkpoints: ChainCheckpointService): void {
	pi.registerCommand("chains", {
		description: "Browse Chains or search them with /chains <query>",
		getArgumentCompletions: async (prefix) => completeChains(service, prefix),
		handler: async (args, ctx) => {
			try {
				const query = args.trim();
				const checkpoint = checkpoints.read();
				const load = (chain: string, branch?: string) => service.load({ chain, branch, maxBytes: 196_608 });
				if (!query && ctx.mode === "tui" && ctx.hasUI) {
					const chains = await service.list({ includeBranches: true, includeLinks: true });
					await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ChainsDashboard(
						chains,
						checkpoint,
						theme,
						() => done(undefined),
						() => tui.requestRender(),
						() => Math.max(4, tui.terminal.rows - 2),
						async (chain, branch) => formatLoad(await load(chain, branch)),
						(chain, branch) => void load(chain, branch).then((loaded) => {
							pi.sendUserMessage(chainLoadPrompt(loaded), { deliverAs: "followUp" });
							ctx.ui.notify(`Loaded ${loaded.link.chain}/${loaded.link.filename} into the next turn.`, "info");
						}).catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")),
					), { overlay: true, overlayOptions: FULL_SCREEN_OVERLAY });
					return;
				}
				const label = checkpointLabel(checkpoint);
				const state = label ? `Checkpoint: ${label}\n\n` : "";
				const content = query ? formatRankedSearch(await service.rankedSearch({ query, maxResults: 30 })) : formatList(await service.list({ includeBranches: true }));
				await showTextViewer(ctx, query ? `Chains: ${query}` : "Chains", `${state}${content}`);
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

function chainLoadPrompt(result: ChainLoadResult): string {
	const warning = result.link.stale ? `\nWarning: this link is ${result.link.ageDays} days old; verify stale assumptions before acting.` : "";
	return `Load this chain context and continue from it.${warning}

Use the saved chain content below as working context. If the next step is ambiguous or the link references missing/stale context, ask clarifying questions before proceeding.

${formatLoad(result)}`;
}
