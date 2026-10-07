import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One registration per Pi process across hot reloads: false while an earlier load of the same extension is active. */
export function claimSurface(pi: ExtensionAPI, name: string): boolean {
	const key = Symbol.for(`deevs-pi-kit.${name}-surface`);
	const slot: { [key: symbol]: { active: boolean } | undefined } = globalThis;
	if (slot[key]?.active) return false;
	const surface = { active: true };
	slot[key] = surface;
	pi.on("session_shutdown", () => {
		surface.active = false;
	});
	return true;
}

/**
 * Keeps an inactive tool off the model's tool list until the kit skill that documents it is loaded: the model reads
 * `skills/<skill>/SKILL.md`, or the user runs `/skill:<skill>`. Pi appends the new declaration before the next request.
 */
export function activateWithSkill(pi: ExtensionAPI, tool: string, skill: string): void {
	const skillFile = realPath(fileURLToPath(new URL(`../../skills/${skill}/SKILL.md`, import.meta.url)));
	const activate = () => {
		const active = pi.getActiveTools();
		if (!active.includes(tool)) pi.setActiveTools([...active, tool]);
	};
	pi.on("tool_call", (event, ctx) => {
		if (isToolCallEventType("read", event) && realPath(resolve(ctx.cwd, event.input.path)) === skillFile) activate();
	});
	pi.on("input", (event) => {
		if (event.text.trimStart().split(/\s/, 1)[0] === `/skill:${skill}`) activate();
		return { action: "continue" };
	});
}

function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
