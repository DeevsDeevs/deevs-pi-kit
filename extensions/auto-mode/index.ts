import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AUTO_MODE_CUSTOM_TYPE, isAutoModeEnabled, loadAutoModeFromSession, setAutoMode } from "../shared/auto-mode.ts";

const ACTIONS = ["on", "off", "status"] as const;

export default function autoModeExtension(pi: ExtensionAPI): void {
	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("auto-mode", isAutoModeEnabled(ctx) ? "auto" : undefined);
	}

	function apply(ctx: ExtensionContext, enabled: boolean): void {
		setAutoMode(ctx, enabled);
		pi.appendEntry(AUTO_MODE_CUSTOM_TYPE, { enabled });
		updateStatus(ctx);
	}

	function statusMessage(ctx: ExtensionContext): string {
		return isAutoModeEnabled(ctx)
			? "Auto mode is on: Subagent allowWrite runs are pre-authorized for this session."
			: "Auto mode is off: each write-capable Subagent run asks for confirmation.";
	}

	async function enable(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("Auto mode requires an interactive confirmation; run /auto where a UI is available.", "warning");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			"Enable auto mode?",
			"All Subagent allowWrite runs in this session will receive edit/write tools and shell access without further confirmation.",
		);
		if (!confirmed) {
			ctx.ui.notify("Auto mode stays off.", "info");
			return;
		}
		apply(ctx, true);
		ctx.ui.notify(statusMessage(ctx), "info");
	}

	pi.on("session_start", (_event, ctx) => {
		loadAutoModeFromSession(ctx);
		updateStatus(ctx);
	});

	pi.registerCommand("auto", {
		description: "Toggle auto mode: one upfront confirmation pre-authorizes all Subagent allowWrite runs this session",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = ACTIONS.filter((action) => action.startsWith(normalized));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			let action = args.trim().toLowerCase();
			if (!action) action = !ctx.hasUI ? "status" : isAutoModeEnabled(ctx) ? "off" : "on";

			if (action === "on") {
				if (isAutoModeEnabled(ctx)) ctx.ui.notify(statusMessage(ctx), "info");
				else await enable(ctx);
			} else if (action === "off") {
				if (isAutoModeEnabled(ctx)) apply(ctx, false);
				ctx.ui.notify(statusMessage(ctx), "info");
			} else if (action === "status") {
				ctx.ui.notify(statusMessage(ctx), "info");
			} else {
				ctx.ui.notify("Usage: /auto [on | off | status]", "warning");
			}
		},
	});
}
