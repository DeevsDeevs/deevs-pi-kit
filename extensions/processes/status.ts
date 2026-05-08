import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSuppressedProcessName } from "./alerts.ts";
import type { ProcessManager } from "./manager.ts";

const BLUE = "\x1b[34m";
const RESET = "\x1b[39m";

export function createProcessFooterStatus(manager: ProcessManager) {
	let unsubscribe: (() => void) | undefined;
	let ctx: ExtensionContext | undefined;

	const update = () => {
		if (!ctx) return;
		const config = manager.getConfig();
		const processes = manager.list({ includeExited: false, includePersistent: true });
		const active = processes.filter(
			(process) =>
				!isSuppressedProcessName(process.name, config) &&
				(process.status === "starting" || process.status === "running" || process.status === "killing" || process.status === "kill_timeout"),
		);
		if (active.length === 0) {
			ctx.ui.setStatus("background-tasks", undefined);
			return;
		}

		const persistent = active.filter((process) => process.persistent).length;
		const stuck = active.filter((process) => process.status === "kill_timeout").length;
		const parts = [`background: ${active.length} running`];
		if (persistent > 0) parts.push(`${persistent} persistent`);
		if (stuck > 0) parts.push(`${stuck} stuck`);
		ctx.ui.setStatus("background-tasks", colorBlue(parts.join(" / ")));
	};

	return {
		start(nextCtx: ExtensionContext): void {
			ctx = nextCtx;
			unsubscribe?.();
			unsubscribe = manager.onChange(update);
			update();
		},
		stop(nextCtx?: ExtensionContext): void {
			unsubscribe?.();
			unsubscribe = undefined;
			(nextCtx ?? ctx)?.ui.setStatus("background-tasks", undefined);
			ctx = undefined;
		},
		update,
	};
}

function colorBlue(text: string): string {
	return `${BLUE}${text}${RESET}`;
}
