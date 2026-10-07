import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

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
 * A resumed, reloaded or re-navigated branch that already read the skill or used the tool gets it back.
 */
export function activateWithSkill(pi: ExtensionAPI, tool: string, skill: string): void {
	const skillFile = realPath(fileURLToPath(new URL(`../../skills/${skill}/SKILL.md`, import.meta.url)));
	const isSkillFile = (cwd: string, path: string) => realPath(resolve(cwd, path.replace(/^~(?=$|\/)/, homedir()))) === skillFile;
	const activate = () => {
		const active = pi.getActiveTools();
		if (!active.includes(tool)) pi.setActiveTools([...active, tool]);
	};
	pi.on("tool_call", (event, ctx) => {
		if (isToolCallEventType("read", event) && isSkillFile(ctx.cwd, event.input.path)) activate();
	});
	const restore = (ctx: ExtensionContext) => {
		const used = ctx.sessionManager.getBranch().some((entry) => entry.type === "message" && (
			entry.message.role === "toolResult" && entry.message.toolName === tool
			|| entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "toolCall" && block.name === "read" && isSkillFile(ctx.cwd, String(block.arguments.path ?? "")))));
		if (used) activate();
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
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
