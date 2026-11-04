import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** One registration per Pi process across hot reloads: false while an earlier load of the same extension is active. */
export function claimSurface(pi: ExtensionAPI, name: string): boolean {
	const key = Symbol.for(`pi-kit.${name}-surface`);
	const slot: { [key: symbol]: { active: boolean } | undefined } = globalThis;
	if (slot[key]?.active) return false;
	const surface = { active: true };
	slot[key] = surface;
	pi.on("session_shutdown", () => {
		surface.active = false;
	});
	return true;
}

export const HEADLESS_GUIDELINE = "Non-interactive run: nobody will reply before Pi exits. Where you would ask the user or leave them a decision, apply the default you would propose and name it in your final answer. Do not take an irreversible or destructive step you would have asked about; name it in your final answer instead.";

/** Print and json mode: nobody will reply and no UI shows. */
export const isHeadless = (ctx: Pick<ExtensionContext, "mode">): boolean => ctx.mode === "print" || ctx.mode === "json";

/** Keeps tools that need a person off the model's tool list in print and json mode, as Claude Code's -p drops AskUserQuestion. */
export function interactiveOnly(pi: ExtensionAPI, tools: string[]): void {
	pi.on("session_start", (_event, ctx) => {
		if (isHeadless(ctx)) pi.setActiveTools(pi.getActiveTools().filter((tool) => !tools.includes(tool)));
	});
}

