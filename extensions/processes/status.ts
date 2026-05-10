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
		const processes = manager.list({ includeExited: false, includePersistent: true })
			.filter((process) => !isSuppressedProcessName(process.name, config));
		const running = processes.filter((process) => process.status === "starting" || process.status === "running");
		const stopping = processes.filter((process) => process.status === "killing");
		const stuck = processes.filter((process) => process.status === "kill_timeout");
		if (running.length === 0 && stopping.length === 0 && stuck.length === 0) {
			ctx.ui.setStatus("background-tasks", undefined);
			return;
		}

		const persistent = running.filter((process) => process.persistent).length;
		const parts = [`background: ${running.length} running`];
		if (persistent > 0) parts.push(`${persistent} persistent`);
		if (stopping.length > 0) parts.push(`${stopping.length} stopping`);
		if (stuck.length > 0) parts.push(`${stuck.length} stuck`);
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
