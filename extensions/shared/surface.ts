import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Adds the missing tools in one loadout change. Never removes one: after a removal, Responses and Completions providers
 * resend the whole tool list for the rest of the session instead of appending to the cached one.
 */
export function activateTools(pi: ExtensionAPI, tools: readonly string[]): void {
	const active = pi.getActiveTools();
	const missing = tools.filter((tool) => !active.includes(tool));
	if (missing.length) pi.setActiveTools([...active, ...missing]);
}

/**
 * Keeps inactive tools off the model's tool list until a kit skill that documents them is loaded: the model reads
 * `skills/<skill>/SKILL.md` with read or bash, or the user runs `/skill:<skill>`. Pi appends the new declarations before
 * the next request. A resumed, reloaded or re-navigated branch that already read the skill or used a tool gets them back.
 */
export function activateWithSkill(pi: ExtensionAPI, tools: readonly string[], skills: readonly string[]): void {
	const skillFiles = new Set(skills.map((skill) => realPath(fileURLToPath(new URL(`../../skills/${skill}/SKILL.md`, import.meta.url)))));
	const readsSkill = (tool: string, args: { path?: unknown; command?: unknown }, cwd: string) => tool === "read"
		? skillFiles.has(realPath(resolve(cwd, String(args.path ?? "").replace(/^~(?=$|\/)/, homedir()))))
		: tool === "bash" && skills.some((skill) => String(args.command ?? "").includes(`skills/${skill}/SKILL.md`));
	const activate = () => activateTools(pi, tools);
	pi.on("tool_call", (event, ctx) => {
		if (readsSkill(event.toolName, event.input, ctx.cwd)) activate();
	});
	const restore = (ctx: ExtensionContext) => {
		const used = ctx.sessionManager.getBranch().some((entry) => entry.type === "message" && (
			entry.message.role === "toolResult" && tools.includes(entry.message.toolName)
			|| entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "toolCall" && readsSkill(block.name, block.arguments, ctx.cwd))));
		if (used) activate();
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("input", (event) => {
		const command = event.text.trimStart().split(/\s/, 1)[0];
		if (skills.some((skill) => command === `/skill:${skill}`)) activate();
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
